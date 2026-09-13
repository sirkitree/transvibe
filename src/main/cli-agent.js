import { spawn as nodeSpawn } from 'node:child_process'
import { mkdirSync, accessSync, constants as fsConstants } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import {
  claudeArgs, codexArgs, parseClaudeJson, parseCodexJsonl, CLAUDE_MODEL
} from '../shared/cli.js'
import { acceptAnswer } from '../shared/conversation.js'
import { buildEscalationPrompt } from '../shared/escalate.js'

/**
 * The frontier model, reached by running the user's own command line tool.
 *
 * This is the remote twin of assist.js. Same job — a question in, one sayable
 * sentence out — and deliberately the same return shape, because the caller
 * should not have to know which model answered in order to speak the answer.
 * Everything that is different is underneath: instead of a fetch to a port on
 * this machine there is a subprocess, and instead of a model that will not
 * answer there is a model that will answer very well and bill somebody for it.
 *
 * Spawning is why this module exists rather than being three lines in
 * assist.js. A subprocess is a thing that can hang, print a gigabyte, ignore
 * SIGTERM, or sit blocked forever reading a stdin nobody is going to write
 * to — codex does exactly that if you leave its stdin open — and every one of
 * those has to end with the app still answering questions. So the process is
 * on a leash from the moment it starts: an argv array with no shell anywhere
 * near it, an empty temp directory for a cwd so it cannot read the user's
 * repo, a cap on how much of its stdout is kept, a deadline, and SIGKILL for a
 * process that will not take the hint.
 *
 * Nothing here throws at its caller. A missing binary, a signed-out CLI, a
 * timeout and a schema change are all the same kind of event — the answer did
 * not arrive — and they all come back as `{ ok: false, reason }`, which the
 * caller already handles because it is what the local model does when Ollama
 * is not running.
 *
 * The building of the argv and the reading of the output are not here: they
 * are pure and they live in shared/cli.js, which is what lets the dangerous
 * part — a sentence from a room microphone becoming a command line — be tested
 * without a process anywhere near the test.
 */

/* The binary each provider is spawned as. */
const BINARIES = { claude: 'claude', codex: 'codex' }

/* Where these tools land when someone installs them, for the case where PATH
   does not say.

   An app opened from the Dock or Spotlight does not get the PATH from your
   shell profile — macOS hands it `/usr/bin:/bin:/usr/sbin:/sbin` and nothing
   else. Measured here: `claude` is in ~/.local/bin and `codex` in
   /opt/homebrew/bin, so a launched-from-Finder transvibe found neither and
   every escalation quietly fell back to the local answer. It looked exactly
   like a model that would not answer, which is the worst way for this to
   fail — the feature was off and said nothing.

   So PATH is tried first, because a PATH that has them is the user's own
   answer to where they are, and these are the fallback rather than a
   replacement. */
const LIKELY_DIRS = [
  join(homedir(), '.local', 'bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
  join(homedir(), '.bun', 'bin'),
  join(homedir(), '.volta', 'bin'),
  join(homedir(), '.npm-global', 'bin'),
  join(homedir(), '.nvm', 'versions', 'node')
]

/* Resolved once. Somebody who installs a CLI while the app is running can
   relaunch it; probing the filesystem on every question to catch that would
   be paying all day for a thing that happens once. */
const resolved = new Map()

/**
 * The command to spawn for a provider: a bare name if PATH can find it, an
 * absolute path if one of the usual places has it, and the bare name again if
 * neither — so the failure is still "not installed" rather than a crash.
 *
 * @param {string} name  'claude' or 'codex'
 */
function binaryFor (name) {
  if (resolved.has(name)) return resolved.get(name)

  const dirs = String(process.env.PATH || '').split(':').filter(Boolean)
  const runnable = dir => {
    const full = join(dir, name)
    try {
      accessSync(full, fsConstants.X_OK)
      return full
    } catch {
      return null
    }
  }

  // On PATH it stays a bare name: that is what the user's own shell would run,
  // and an absolute path chosen here could differ from the one they expect.
  const onPath = dirs.some(dir => runnable(dir)) ? name : null
  const found = onPath || LIKELY_DIRS.map(runnable).find(Boolean) || name
  resolved.set(name, found)
  return found
}

/* How much of stdout is kept. A claude JSON result is a couple of kilobytes
   and a chatty codex turn is tens; half a megabyte is far past either, and is
   here for the CLI that goes wrong and prints forever rather than for the one
   that answers. Past the cap the bytes are dropped on the floor — the process
   is left to finish or be killed by the deadline, since a program producing
   this much output is not about to produce an answer. */
const MAX_STDOUT = 512 * 1024

/* Between SIGTERM and SIGKILL. Long enough for a CLI to flush what it has and
   exit like a well behaved program, short enough that a user who said "stop"
   does not notice the difference. */
const KILL_GRACE_MS = 1500

/* Just long enough to ask a program what version it is. If `claude --version`
   has not answered in three seconds, something is wrong enough that the
   feature should be off. */
const CHECK_TIMEOUT_MS = 3000

const text = v => String(v == null ? '' : v)

/**
 * The empty directory the CLIs are run in.
 *
 * Never the user's project. Both of these tools are built to notice where they
 * are — they read a CLAUDE.md, they look for a git repo, they load project
 * settings — and all of that is context nobody asked for on a question spoken
 * out loud, as well as several seconds of the 2.7s budget. An empty directory
 * has nothing to find.
 *
 * Falls back to the temp directory itself if the subdirectory cannot be made,
 * which is still not the user's repo and is the only property that matters.
 */
function neutralCwd () {
  const dir = join(tmpdir(), 'transvibe-cli')
  try {
    mkdirSync(dir, { recursive: true })
    return dir
  } catch {
    return tmpdir()
  }
}

/**
 * Run one command to completion, or to the end of its rope.
 *
 * Resolves — always. `outcome` says how it ended: 'done' for a process that
 * exited on its own whatever its exit code, 'timeout' for one that ran past
 * the deadline, 'cancelled' for one somebody stopped, 'missing' for a binary
 * that is not installed, and 'error' for anything else the OS objected to.
 *
 * @param {Function} spawn  node's spawn, or a fake in tests
 * @param {{register?: Function}} hooks  told about the child so it can be killed
 */
function run (spawn, bin, args, { timeoutMs, register = () => {} }) {
  return new Promise(resolve => {
    let child
    try {
      child = spawn(bin, args, {
        cwd: neutralCwd(),
        /* stdin is closed rather than inherited or piped. codex reads it if it
           is open — "Reading additional input from stdin..." — and then waits
           for input that is never coming, which turns every question into a
           timeout. There is nothing to send it: the question is in the argv. */
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (err) {
      resolve({ outcome: 'error', stdout: '', stderr: '', code: null, reason: text(err?.message) })
      return
    }

    let stdout = ''
    let stderr = ''
    let outcome = 'done'
    let settled = false
    let termTimer = null
    let killTimer = null

    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(termTimer)
      clearTimeout(killTimer)
      register(null)
      resolve(result)
    }

    const stop = (why) => {
      if (settled) return
      outcome = why
      try { child.kill('SIGTERM') } catch { /* already gone */ }
      /* A CLI that ignores SIGTERM is not going to start listening, and one
         that is wedged in a syscall cannot hear it at all. Give it the grace
         period and then take the choice away. */
      killTimer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* already gone */ }
        /* And resolve on the spot rather than waiting for 'close'. SIGKILL is
           not something a process can decline, so it is already gone; what can
           still be open is the pipe, held by something it spawned, and waiting
           on that would hang the caller behind a process that is not even
           running any more. */
        finish({ outcome, stdout, stderr, code: null, reason: '' })
      }, KILL_GRACE_MS)
      killTimer.unref?.()
    }

    register(stop)

    child.stdout?.on('data', d => {
      if (stdout.length < MAX_STDOUT) stdout += text(d)
    })
    child.stderr?.on('data', d => {
      if (stderr.length < 4096) stderr += text(d)
    })

    /* ENOENT here is the ordinary case, not a fault: most machines have
       neither of these CLIs, and the feature is off by default. */
    child.on('error', err => finish({
      outcome: err?.code === 'ENOENT' ? 'missing' : 'error',
      stdout,
      stderr,
      code: null,
      reason: text(err?.message)
    }))

    child.on('close', code => finish({ outcome, stdout, stderr, code, reason: '' }))

    if (timeoutMs > 0) {
      termTimer = setTimeout(() => stop('timeout'), timeoutMs)
      termTimer.unref?.()
    }
  })
}

/** Why a run that produced no answer produced no answer, in words that can be
    said out loud. The provider is named because "not installed" is useless
    when there are two of them and one of them is fine. */
function reasonFor (result, provider, stderrFallback) {
  if (result.outcome === 'missing') return `the ${provider} command is not installed`
  if (result.outcome === 'timeout') return 'took too long'
  if (result.outcome === 'cancelled') return 'cancelled'
  if (result.outcome === 'error') return result.reason || `${provider} would not start`
  return stderrFallback || result.reason || `${provider} failed`
}

/* The first line of stderr, which is where a CLI puts the one useful sentence
   ("Not logged in", "unknown model") before exiting non-zero. Capped, because
   a stack trace is not an explanation and nobody wants it read aloud. */
function firstLine (stderr) {
  const line = text(stderr).split('\n').map(s => s.trim()).find(Boolean) || ''
  return line.length > 200 ? `${line.slice(0, 200)}…` : line
}

/**
 * One provider, ready to be asked things.
 *
 * @param {{provider?: string, model?: string, timeoutMs?: number,
 *          webSearch?: boolean, spawn?: Function}} options
 *   `spawn` is injectable so the tests can drive a fake process. Nothing in
 *   the suite may run a real `claude` or `codex`: that costs the person
 *   running the tests actual money and needs a network to do it.
 */
export function createCliAgent ({
  provider = 'claude',
  model = null,
  timeoutMs = 30000,
  webSearch = false,
  spawn = nodeSpawn
} = {}) {
  const which = provider === 'codex' ? 'codex' : 'claude'
  const bin = binaryFor(BINARIES[which])
  let available = null      // null = not yet checked, as in assist.js

  /* Every process this agent has running, so "stop" can end all of them. A set
     rather than one slot because a second question arriving before the first
     answered is a bug somewhere else, and losing the handle to the first
     process would leave something billable running with nobody watching. */
  const running = new Set()

  /* One of these per call: it adds that call's stopper when the process
     starts and takes out its own — and only its own — when it ends. */
  const tracker = () => {
    let mine = null
    return (stop) => {
      if (stop) { mine = stop; running.add(stop) }
      else if (mine) { running.delete(mine); mine = null }
    }
  }

  function argvFor (question, history, { model: at, priorAnswer, webSearch: search, canEscalate }) {
    /* One flat prompt carries the framing, the thread so far and the question,
       because a CLI has one prompt and not a messages array. Both providers
       then hear the spoken-shape rule a second time, in the slot their CLI
       gives for it: claude as --system-prompt, codex folded in front of the
       positional. That repetition has never made an answer worse and is
       cheaper than a second prompt builder.

       Codex is deliberately not passed `system: ''` to suppress it. The
       framing being non-empty is what guarantees the positional argument
       begins with a letter and can never be read as a flag, and a guarantee
       that holds only while a caller remembers to keep a string non-empty is
       not one. codexArgs defends it on its own side too. */
    const prompt = buildEscalationPrompt(question, priorAnswer, history)
    return which === 'codex'
      ? codexArgs(prompt, { webSearch: search, canEscalate })
      : claudeArgs(prompt, { model: at || model || CLAUDE_MODEL, canEscalate })
  }

  return {
    get provider () { return which },
    get model () { return model || (which === 'claude' ? CLAUDE_MODEL : null) },
    get available () { return available },
    get busy () { return running.size > 0 },

    /**
     * Is this CLI here to be used?
     *
     * `--version` and nothing else. The temptation is to ask it a real
     * question to find out whether the user is signed in as well, and the
     * answer is no: that is a billed call, made at startup, for every launch
     * of the app, to learn something the first real question learns for free.
     * A signed-out CLI comes back from `ask` with its own words about it
     * ("not logged in"), which is a better message than any this could guess.
     *
     * @returns {Promise<boolean>} whether the binary is there
     */
    async check () {
      const result = await run(spawn, bin, ['--version'], { timeoutMs: CHECK_TIMEOUT_MS })
      available = result.outcome === 'done' && result.code === 0
      return available
    },

    /**
     * Ask the frontier model, and get back what the local one would have
     * returned.
     *
     * Identical shape to assist.ask, down to running the answer through
     * acceptAnswer: a frontier model is perfectly capable of replying with a
     * bulleted list and three paragraphs of caveats, and an answer nobody can
     * hear is no better for having come from a large model. It is held to the
     * same sixty words and the same markdown rules as the small one.
     *
     * `ms` is wall time and not the CLI's own `duration_ms`, because what the
     * user waited for includes starting the process, and that is the number
     * that decides whether escalating was worth doing.
     *
     * @param {string} question
     * @param {Array<{role: string, content: string}>} history the thread so far
     * @param {{model?: string, priorAnswer?: string, webSearch?: boolean}} options
     *   `priorAnswer` is what the local model already said, if anything; it
     *   turns the question into "check this" instead of "answer this".
     * @returns {Promise<{text: string, ok: boolean, reason?: string,
     *   ms: number, tokens: object|null, model: string, costUsd: number|null}>}
     */
    async ask (question, history = [], options = {}) {
      const asked = text(question).trim()
      const at = options.model || model || (which === 'claude' ? CLAUDE_MODEL : null)
      const started = Date.now()
      const failed = reason => ({
        text: '', ok: false, reason, ms: Date.now() - started, tokens: null, model: at, costUsd: null
      })

      if (!asked) return failed('nothing asked')
      if (available === false) return failed(`the ${which} command is not installed`)

      const args = argvFor(asked, history, {
        model: options.model,
        priorAnswer: options.priorAnswer,
        canEscalate: options.canEscalate,
        webSearch: options.webSearch === undefined ? webSearch : options.webSearch
      })

      const result = await run(spawn, bin, args, { timeoutMs, register: tracker() })
      const ms = Date.now() - started

      /* A binary that was there at startup and is gone now is worth
         remembering, so the next question fails immediately instead of
         spawning again to find out the same thing. */
      if (result.outcome === 'missing') available = false

      /* Nothing is spoken after "stop", even if the answer had already
         arrived and is sitting there in stdout. The user asked for silence,
         not for the most recent thing to be read out. */
      if (result.outcome === 'cancelled') return failed('cancelled')
      if (result.outcome === 'timeout') return failed('took too long')

      const parsed = which === 'codex'
        ? parseCodexJsonl(result.stdout)
        : parseClaudeJson(result.stdout)

      /* Exit code last, on purpose. Both CLIs can exit non-zero having already
         printed a perfectly good answer — codex warns about its sandbox, claude
         about an update — and the parsed answer is better evidence than the
         status. But a run with no answer in it gets its reason from how it
         ended, because "no answer" says nothing about a process that was
         killed at thirty seconds. */
      if (!parsed.ok) {
        const why = result.outcome === 'done' && result.code === 0
          ? (parsed.reason || 'no answer')
          : reasonFor(result, which, firstLine(result.stderr) || parsed.reason)
        return { ...failed(why), tokens: parsed.tokens || null }
      }

      return {
        ...acceptAnswer(parsed.text, { speakerNames: history.filter(t => t?.name).map(t => t.name) }),
        ms,
        tokens: parsed.tokens || null,
        model: at,
        costUsd: parsed.costUsd ?? null
      }
    },

    /**
     * Stop whatever is running.
     *
     * "Stop" and escape have to reach this. A subprocess nobody can stop is
     * worse than a slow one: it keeps spending the user's subscription on an
     * answer that will not be spoken, and it holds the strip open behind it.
     * The in-flight `ask` resolves with `reason: 'cancelled'` rather than
     * being left hanging.
     */
    cancel () {
      for (const stop of [...running]) stop('cancelled')
      running.clear()
    }
  }
}

/**
 * Which of the CLIs are installed on this machine.
 *
 * For the settings panel, and standalone for the same reason
 * listOllamaModels is: the panel needs the answer before any agent has been
 * pointed at a provider. Neither being present is the ordinary case rather
 * than an error — this is a feature that is off by default and needs a tool
 * the user installed for other reasons — so it comes back as a list saying so,
 * never as a throw.
 *
 * @returns {Promise<Array<{provider: string, binary: string,
 *   present: boolean, version: string|null}>>}
 */
export async function listCliAgents ({ spawn = nodeSpawn } = {}) {
  const providers = Object.keys(BINARIES)
  const results = await Promise.all(providers.map(async provider => {
    const binary = binaryFor(BINARIES[provider])
    const result = await run(spawn, binary, ['--version'], { timeoutMs: CHECK_TIMEOUT_MS })
    const present = result.outcome === 'done' && result.code === 0
    return {
      provider,
      binary,
      present,
      /* Whatever it printed, first line only: `claude --version` says
         "2.0.14 (Claude Code)" and codex says "codex-cli 0.5.0". Shown as-is
         rather than parsed into a number, since a version this app does not
         understand is still worth showing to whoever is debugging it. */
      version: present ? (firstLine(result.stdout) || null) : null
    }
  }))
  return results
}
