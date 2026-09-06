/**
 * Building the command line for a frontier model, and reading what it says.
 *
 * When the local model does not know something, the question can be escalated
 * to Claude or to Codex. Not over HTTP: the app spawns the CLI the user has
 * already logged into, so the answer bills against the subscription they are
 * paying for rather than against an API key nobody has. That choice is what
 * makes this module necessary — an HTTP call is a JSON body, but a CLI call is
 * an argument vector, and an argument vector built out of a sentence that was
 * transcribed from a room microphone is the single most dangerous thing in the
 * app. Anyone who can be heard by the microphone can put words in it.
 *
 * So the dangerous half is here, alone, and it is pure. Turning a sentence into
 * argv is data in and data out; the spawning lives elsewhere. That means the
 * guard rails — the question is exactly one array element, no shell is
 * involved, no flag we did not write ourselves can appear — are unit-testable
 * without a process anywhere near the test.
 *
 * The other half is reading the output, and both parsers here are total. A CLI
 * is somebody else's program: it can print an update notice above its JSON,
 * warn about a deprecated flag, ask us to log in, or change its schema in a
 * release we did not ask for. Every one of those is a wrong answer, not a
 * crash, so garbage in gives `{ ok: false, reason }` out and the caller falls
 * back to what the local model already said.
 *
 * Pure — no spawning, no filesystem, no network.
 */

import { FRONTIER_ASK_PROMPT, FRONTIER_ASK_PROMPT_CAN_PASS } from './conversation.js'

/* The flags that make this fast enough to say out loud. MEASURED: 2.7s wall
   with them, 8.4s without — the difference is the CLI loading CLAUDE.md,
   plugins, MCP servers and hooks for a question that needs none of them.
   --restricted and --strict-mcp-config are also the safety story: this is a
   sentence from a room, and it gets a model with no tools and no project.

   Not here, deliberately:
     --bare                            forces API-key auth and so bills the
                                       wrong account, defeating the point.
     --dangerously-skip-permissions    never. There is nothing to permit. */
const CLAUDE_FLAGS = [
  '--output-format', 'json',
  '--restricted',
  '--strict-mcp-config',
  '--disable-slash-commands'
]

/** Fast enough to be worth waiting for mid-conversation, and good enough to be
    worth escalating to. Overridable per agent. */
export const CLAUDE_MODEL = 'claude-sonnet-5'

const text = v => String(v == null ? '' : v)

const squash = v => text(v).replace(/\s+/g, ' ').trim()

const num = v => (Number.isFinite(v) ? v : null)

const options = v => (v && typeof v === 'object' ? v : {})

/**
 * The argv after the `claude` binary.
 *
 * The question goes last, as the value of `-p`, and that is the whole of the
 * defence: it is one element of an array that is handed to execFile, so it is
 * never parsed by a shell, and being bound to a flag it cannot be read as one
 * either. "--dangerously-skip-permissions rm -rf /" said out loud reaches the
 * model as a question about the string "--dangerously-skip-permissions rm -rf
 * /", which is a fine thing for a model to be asked.
 *
 * `timeoutMs` is accepted so callers can pass one options object around, but
 * it produces no argument: the CLI has no timeout flag and the deadline is
 * enforced by killing the process, which is the spawner's job.
 *
 * @param {string} question
 * @param {{model?: string, system?: string, timeoutMs?: number}} [opts]
 * @returns {string[]}
 */
export function claudeArgs (question, opts) {
  const { model, system, canEscalate } = options(opts)
  return [
    ...CLAUDE_FLAGS,
    '--system-prompt', squash(system || (canEscalate ? FRONTIER_ASK_PROMPT_CAN_PASS : FRONTIER_ASK_PROMPT)),
    '--model', squash(model) || CLAUDE_MODEL,
    '-p', text(question)
  ]
}

/**
 * The argv after the `codex` binary.
 *
 * Codex earns its place by having live web access that works — MEASURED: the
 * trimmed claude invocation above makes zero web searches, where codex with
 * `tools.web_search=true` comes back with this morning's headlines and links.
 * It pays for that in latency: 8.7s, or 14.1s once it is searching.
 *
 * `--skip-git-repo-check` because the process runs in an empty temp directory
 * on purpose, not in the user's repo, and codex otherwise objects to that.
 *
 * Two shapes differ from claude. There is no --system-prompt, so the framing
 * has to ride inside the prompt itself — instruction first, question last, so
 * the last thing the model reads is what was actually asked. And the prompt is
 * a bare positional rather than a flag's value, which would be the one place a
 * sentence beginning with a dash could be mistaken for a flag; folding the
 * framing in front of it settles that too, since the argument now always
 * begins with the letter Y of "You are answering out loud" and never with a
 * dash. It is still one array element and still never sees a shell.
 *
 * Which is why an empty `system` is replaced rather than honoured. It reads
 * like a rude default, and it is the opposite: the framing is load-bearing,
 * and a caller that passes '' to save a few tokens would be handing a spoken
 * sentence straight to an argument parser. There is no way to switch it off
 * because there is no good reason to want to.
 *
 * @param {string} question
 * @param {{webSearch?: boolean, system?: string}} [opts]
 * @returns {string[]}
 */
export function codexArgs (question, opts) {
  const { webSearch, system, canEscalate } = options(opts)
  return [
    'exec', '--json', '--skip-git-repo-check',
    ...(webSearch ? ['-c', 'tools.web_search=true'] : []),
    `${squash(system || (canEscalate ? FRONTIER_ASK_PROMPT_CAN_PASS : FRONTIER_ASK_PROMPT))}\n\n${text(question)}`
  ]
}

/* ------------------------------------------------------------------ *
 * reading the output
 * ------------------------------------------------------------------ */

/** Every line of stdout that is a JSON object, in order, and nothing else.
    Update notices, login prompts and deprecation warnings are lines too, and
    they are skipped rather than fatal — the answer is usually still down
    there underneath them. */
function jsonObjects (stdout) {
  const out = []
  for (const line of text(stdout).split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed[0] !== '{') continue
    try {
      const value = JSON.parse(trimmed)
      if (value && typeof value === 'object' && !Array.isArray(value)) out.push(value)
    } catch {
      /* not JSON, so not ours */
    }
  }
  if (out.length) return out

  /* Nothing line-shaped. A JSON object printed across several lines is the
     other thing "one JSON object on stdout" can mean, and it costs one parse
     to survive a CLI that starts pretty-printing. */
  try {
    const whole = JSON.parse(text(stdout))
    if (whole && typeof whole === 'object' && !Array.isArray(whole)) return [whole]
  } catch {
    /* then there is genuinely nothing here */
  }
  return out
}

const fail = (reason, extra = {}) => ({ text: '', ok: false, reason, ...extra })

/**
 * The answer in `claude --output-format json` output.
 *
 * One JSON object on stdout, and the answer is `.result`. The rest is free
 * telemetry worth keeping: `.duration_ms` is what the escalation actually cost
 * in wall time, which is the number that decides whether escalating was worth
 * it, and `.total_cost_usd` is what it cost in money, which is the number the
 * user is entitled to see before they turn this on.
 *
 * @param {string} stdout
 * @returns {{text: string, ok: boolean, reason?: string,
 *            ms: number|null, tokens: object|null, costUsd: number|null}}
 */
export function parseClaudeJson (stdout) {
  const empty = { ms: null, tokens: null, costUsd: null }
  const objects = jsonObjects(stdout)
  if (!objects.length) return fail(squash(stdout) ? 'not json' : 'no output', empty)

  /* The result object is the last one, because anything printed before it is
     the CLI talking about itself rather than answering. */
  const result = objects[objects.length - 1]
  const meta = {
    ms: num(result.duration_ms),
    tokens: claudeTokens(result.usage),
    costUsd: num(result.total_cost_usd)
  }

  const answer = squash(result.result)
  // is_error is a boolean when it is there at all; a missing one is not an
  // error, but a truthy one is, whatever shape it arrived in.
  if (result.is_error) return fail(answer || squash(result.subtype) || 'cli error', meta)
  if (!answer) return fail('no answer', meta)

  return { text: answer, ok: true, ...meta }
}

/* Cache reads and cache creations are input tokens that were priced
   differently, not tokens that were not sent. Summing them is the only figure
   that matches the size of the prompt; the price is in costUsd already. */
function claudeTokens (usage) {
  const from = options(usage)
  const input = (num(from.input_tokens) || 0) +
    (num(from.cache_creation_input_tokens) || 0) +
    (num(from.cache_read_input_tokens) || 0)
  const output = num(from.output_tokens) || 0
  return input || output ? { input, output } : null
}

/**
 * The answer in `codex exec --json` output.
 *
 * JSONL: one object per line, narrating the turn as it happens. The answer is
 * the LAST `agent_message` item and not the first, which matters — codex
 * routinely says "I'll check this week's news." as an agent_message, goes and
 * searches, and only then answers. Reading the first one would speak the
 * preamble out loud and throw the answer away.
 *
 * @param {string} stdout
 * @returns {{text: string, ok: boolean, reason?: string, tokens: object|null}}
 */
export function parseCodexJsonl (stdout) {
  const objects = jsonObjects(stdout)
  if (!objects.length) return fail(squash(stdout) ? 'not json' : 'no output', { tokens: null })

  let answer = ''
  let tokens = null
  let error = ''
  for (const line of objects) {
    const item = options(line.item)
    if (line.type === 'item.completed' && item.type === 'agent_message') {
      const said = squash(item.text)
      if (said) answer = said
    }
    if (line.type === 'turn.completed') tokens = codexTokens(line.usage)
    // A failed turn reports itself in the stream rather than on stderr, and
    // the message is the only clue about why — usually "not logged in".
    if (line.type === 'error' || line.type === 'turn.failed' || item.type === 'error') {
      error = error || squash(line.message || item.message || options(line.error).message)
    }
  }

  if (answer) return { text: answer, ok: true, tokens }
  return fail(error || 'no answer', { tokens })
}

function codexTokens (usage) {
  const from = options(usage)
  const input = (num(from.input_tokens) || 0) + (num(from.cached_input_tokens) || 0)
  const output = num(from.output_tokens) || 0
  return input || output ? { input, output } : null
}
