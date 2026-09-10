import { spawn } from 'node:child_process'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { encodeWav } from './wav.js'
import {
  parseServerJson, parseCliOutput, cleanTranscript, isConfident, createQueue
} from './whisper-parse.js'
import { buildPrompt, applyCorrections, isGlossaryEcho } from '../shared/glossary.js'

const BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']

function which (name) {
  for (const d of BIN_DIRS) {
    const p = `${d}/${name}`
    if (existsSync(p)) return p
  }
  return null
}

function freePort () {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

/* The gate that runs before the recogniser.
   ------------------------------------------------------------------------
   Whisper will transcribe anything. Handed twelve seconds of a song it does
   not return nothing — it returns 'so', or a sentence it invented, and
   everything downstream in whisper-parse.js exists to recognise that sentence
   after the fact. Silero is asked a narrower question first: was anybody
   speaking? Measured here, it answers no for a chord, a melody, pink noise,
   silence and two clips of actual music, and yes for every clip of speech it
   was shown, including a half-second interim slice. Whisper is then handed
   only the speech, or nothing at all.

   Cheap enough not to think about: 22.7ms to scan a twelve-second chunk, and
   it pays for itself on the music, where dropping the decode took the request
   from 548ms to 303ms.

   The flags go on the server at startup rather than on each request — that is
   where whisper.cpp reads them — so changing any of this restarts the sidecar.

   A missing model file is the one thing that must not happen quietly: passing
   `--vad` without a readable `-vm` kills the server at startup and takes
   transcription with it. So the flags are built from the file rather than from
   the setting, and no file means no flags, which is the old behaviour intact.
*/
export function vadArgs (vad) {
  if (!vad || vad.enabled === false) return []
  const model = vad.modelPath
  if (!model || !existsSync(model)) return []
  /* -vt is a probability. Out-of-range values are the caller's bug, not
     something to pass down to a process that will read them literally — but
     the coercion has to come after the type test, because `Number(null)` is 0
     and a settings file with no threshold in it would otherwise clamp to the
     most permissive gate there is rather than to the default. */
  const t = vad.threshold
  const threshold = typeof t === 'number' && Number.isFinite(t)
    ? Math.min(0.95, Math.max(0.05, t))
    : 0.5
  /* Only the threshold is exposed. The duration and padding defaults
     (-vspd 250, -vsd 100, -vp 30) were measured against interim slices down to
     half a second and clipped nothing, so there is no knob here to get wrong. */
  return ['--vad', '-vm', model, '-vt', String(threshold)]
}

/**
 * Speech recognition backed by whisper.cpp.
 *
 * Prefers `whisper-server`, which keeps the model resident — that turns a
 * ~160ms per-utterance model load into a one-time cost and lands inference
 * around 110ms. Falls back to spawning `whisper-cli` per utterance if the
 * server binary is missing.
 */
export function createEngine ({
  modelPath, threads = 6, language = 'en',
  vocabulary = [], corrections = {}, dropGlossaryEcho = true, confidenceFloor = 0,
  names = [], vad = null
}) {
  const serverBin = which('whisper-server')
  const cliBin = which('whisper-cli')
  if (!serverBin && !cliBin) {
    throw new Error('whisper.cpp not found — run: brew install whisper-cpp')
  }

  let prompt = buildPrompt(vocabulary)
  let fixups = corrections
  let terms = vocabulary
  // The agents' wake names, which the echo rule has to leave alone.
  let addressed = names
  let dropEcho = dropGlossaryEcho
  let floor = confidenceFloor
  let proc = null
  let port = null
  let ready = null
  const mode = serverBin ? 'server' : 'cli'
  /* Resolved once, at construction, because both sidecars are launched from it
     and because it answers "is the gate actually up?" — which is not the same
     question as "was it asked for". The setting can say yes while the file is
     missing. */
  const gate = vadArgs(vad)
  const gated = gate.length > 0

  function start () {
    if (mode !== 'server') return Promise.resolve()
    if (ready) return ready

    ready = freePort().then(p => new Promise((resolve, reject) => {
      port = p
      proc = spawn(serverBin, [
        '-m', modelPath,
        '--host', '127.0.0.1',
        '--port', String(p),
        '-t', String(threads),
        '-l', language,
        '-nt',
        ...gate
      ], { stdio: ['ignore', 'pipe', 'pipe'] })

      let settled = false
      const done = err => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        err ? reject(err) : resolve()
      }

      // The server prints its listen banner on stderr once the model is loaded.
      const watch = buf => {
        if (/listening|running|HTTP server/i.test(String(buf))) done()
      }
      proc.stdout.on('data', watch)
      proc.stderr.on('data', watch)
      proc.on('error', done)
      /* Before the banner this is a failed start. After it, it is a sidecar
         that died under us — and without clearing the handles, every later
         request would fetch against a port nothing is listening on, forever.
         Dropping them makes the next transcribe pay for a fresh server
         instead, which is a slow utterance rather than a dead app. */
      proc.on('exit', code => {
        proc = null
        ready = null
        done(new Error(`whisper-server exited (${code})`))
      })

      // Banner wording varies across releases; poll as a backstop.
      const timer = setTimeout(async function poll (n = 0) {
        try {
          await fetch(`http://127.0.0.1:${p}/`, { method: 'GET' })
          done()
        } catch {
          if (n > 60) done(new Error('whisper-server did not come up'))
          else setTimeout(() => poll(n + 1), 250)
        }
      }, 400)
    }))

    // Nothing may reach the server before this has, so it is part of becoming
    // ready rather than something kicked off alongside it.
    if (gated) ready = ready.then(warmUp)

    return ready
  }

  /* Half a second of speech, spent to keep the gate from killing the server.
     ------------------------------------------------------------------------
     whisper-server 1.9.2 segfaults — exit 139 — when the *first* request it
     ever serves comes back from VAD with no speech in it. Every request after
     that handles the same empty result correctly and indefinitely, so the bug
     is reachable exactly once, on request one. Which is the request most
     likely to be music: the sidecar comes up when the app launches, and the
     first thing it is handed is whatever the room was doing at the time.

     So we make sure request one is speech. It cannot be synthesised — silero
     is selective enough to reject a formant-shaped buzz, which is the whole
     reason it works on music — so it has to be a real voice, and macOS has
     one. `say` writes 16 kHz mono PCM directly with these flags, which keeps
     ffmpeg out of the runtime; the app already depends on `say` for spoken
     replies.

     Best-effort. If it fails the server is no worse off than before the gate
     existed, and the exit handler above turns the crash into one slow
     utterance rather than a dead engine. Revisit when whisper.cpp fixes it —
     nothing upstream had as of 1.9.2, and there is no newer bottle. */
  async function warmUp () {
    let dir = null
    try {
      dir = mkdtempSync(path.join(os.tmpdir(), 'transvibe-warm-'))
      const file = path.join(dir, 'warm.wav')
      await new Promise((resolve, reject) => {
        const p = spawn('/usr/bin/say',
          ['--data-format=LEI16@16000', '--file-format=WAVE', '-o', file, 'ready'])
        p.on('error', reject)
        p.on('exit', code => code === 0 ? resolve() : reject(new Error(`say exited ${code}`)))
      })
      const form = new FormData()
      form.append('file', new Blob([readFileSync(file)], { type: 'audio/wav' }), 'warm.wav')
      form.append('response_format', 'json')
      // Nobody reads the answer; it exists to be a successful decode.
      form.append('best_of', '1')
      form.append('beam_size', '1')
      await fetch(`http://127.0.0.1:${port}/inference`, { method: 'POST', body: form })
    } catch {
      // Deliberately silent: a warm-up that did not happen is not a failure
      // the person dictating can do anything about.
    } finally {
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  }

  async function viaServer (wav, { interim = false } = {}) {
    await start()
    const form = new FormData()
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'chunk.wav')
    // verbose_json rather than json: same text, plus the per-segment
    // avg_logprob that says whether it was speech at all.
    form.append('response_format', 'verbose_json')
    form.append('temperature', '0')
    // The initial prompt biases the decoder toward glossary spellings. It is
    // safe on interim passes too: `no_context` drops the *previous chunk's*
    // text, not this field.
    if (prompt) form.append('prompt', prompt)
    // Interim passes are thrown away as soon as the next one lands, so trade
    // accuracy for latency: greedy decode, no fallback retries.
    if (interim) {
      form.append('best_of', '1')
      form.append('beam_size', '1')
      form.append('no_context', 'true')
    }
    const res = await fetch(`http://127.0.0.1:${port}/inference`, { method: 'POST', body: form })
    if (!res.ok) throw new Error(`inference failed: HTTP ${res.status}`)
    return parseServerJson(await res.json())
  }

  function viaCli (wav) {
    return new Promise((resolve, reject) => {
      const args = ['-m', modelPath, '-f', '-', '-t', String(threads), '-l', language, '-np', ...gate]
      if (prompt) args.push('--prompt', prompt)
      const p = spawn(cliBin, args)
      let out = ''
      let err = ''
      p.stdout.on('data', d => { out += d })
      p.stderr.on('data', d => { err += d })
      p.on('error', reject)
      p.on('close', code => {
        code === 0 ? resolve(parseCliOutput(out)) : reject(new Error(err.trim() || `whisper-cli exited ${code}`))
      })
      p.stdin.end(wav)
    })
  }

  const queue = createQueue(async ({ samples, opts }) => {
    const wav = encodeWav(samples, 16000)
    const parsed = mode === 'server' ? await viaServer(wav, opts) : await viaCli(wav)
    /* The gate found no speech in it at all, so whisper was handed nothing and
       there is no text to judge. Named rather than silent for the same reason
       the confidence floor is: the threshold is a setting, and watching what it
       rejects is the only way to tell a gate set too tight from a gate working.
       Only when the gate is genuinely up — an empty result with VAD off is
       ordinary silence, and was never worth saying. */
    if (gated && !String(parsed.text || '').trim()) {
      return { ...parsed, text: '', dropped: 'no speech' }
    }
    /* Music the room was playing, confidently turned into words. The decoder
       is the one that knows: this is the same text it produced, thrown away
       on its own numbers. */
    if (!isConfident(parsed.confidence, floor)) {
      /* With the number in it, because the floor is a setting and the only way
         to tune it is to see what it just rejected. A drop at -0.52 against a
         floor of -0.5 is a floor set slightly too high; one at -1.4 is the
         rule doing its job. */
      const score = Number.isFinite(parsed.confidence) ? ` (${parsed.confidence.toFixed(2)})` : ''
      return { ...parsed, text: '', dropped: `not speech${score}` }
    }
    const text = applyCorrections(cleanTranscript(parsed.text), fixups)
    // An utterance that is nothing but glossary words is the prompt coming
    // back, not something that was said.
    const echo = dropEcho &&
      isGlossaryEcho(text, { vocabulary: terms, corrections: fixups, names: addressed })
    return { ...parsed, text: echo ? '' : text }
  })

  return {
    mode,
    start,
    /**
     * @param {Float32Array} samples 16 kHz mono
     * @param {{interim?: boolean}} [opts]
     */
    transcribe: (samples, opts = {}) => queue.push({ samples, opts }),
    get pending () { return queue.size },
    /** Swap the glossary in place; takes effect on the next utterance. */
    setGlossary ({ vocabulary, corrections, dropGlossaryEcho, confidenceFloor, names } = {}) {
      if (dropGlossaryEcho !== undefined) dropEcho = !!dropGlossaryEcho
      if (confidenceFloor !== undefined) floor = Number(confidenceFloor) || 0
      if (names !== undefined) addressed = Array.isArray(names) ? names : []
      if (vocabulary !== undefined) { prompt = buildPrompt(vocabulary); terms = vocabulary }
      if (corrections !== undefined) fixups = corrections || {}
    },
    stop () {
      if (proc) { proc.kill('SIGTERM'); proc = null }
      ready = null
    }
  }
}
