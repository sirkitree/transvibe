import { spawn } from 'node:child_process'
import net from 'node:net'
import { existsSync } from 'node:fs'
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
  vocabulary = [], corrections = {}, dropGlossaryEcho = true, confidenceFloor = 0
}) {
  const serverBin = which('whisper-server')
  const cliBin = which('whisper-cli')
  if (!serverBin && !cliBin) {
    throw new Error('whisper.cpp not found — run: brew install whisper-cpp')
  }

  let prompt = buildPrompt(vocabulary)
  let fixups = corrections
  let terms = vocabulary
  let dropEcho = dropGlossaryEcho
  let floor = confidenceFloor
  let proc = null
  let port = null
  let ready = null
  const mode = serverBin ? 'server' : 'cli'

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
        '-nt'
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
      proc.on('exit', code => done(new Error(`whisper-server exited (${code})`)))

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

    return ready
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
      const args = ['-m', modelPath, '-f', '-', '-t', String(threads), '-l', language, '-np']
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
    /* Music the room was playing, confidently turned into words. The decoder
       is the one that knows: this is the same text it produced, thrown away
       on its own numbers. */
    if (!isConfident(parsed.confidence, floor)) {
      return { ...parsed, text: '', dropped: 'not speech' }
    }
    const text = applyCorrections(cleanTranscript(parsed.text), fixups)
    // An utterance that is nothing but glossary words is the prompt coming
    // back, not something that was said.
    const echo = dropEcho && isGlossaryEcho(text, { vocabulary: terms, corrections: fixups })
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
    setGlossary ({ vocabulary, corrections, dropGlossaryEcho, confidenceFloor } = {}) {
      if (dropGlossaryEcho !== undefined) dropEcho = !!dropGlossaryEcho
      if (confidenceFloor !== undefined) floor = Number(confidenceFloor) || 0
      if (vocabulary !== undefined) { prompt = buildPrompt(vocabulary); terms = vocabulary }
      if (corrections !== undefined) fixups = corrections || {}
    },
    stop () {
      if (proc) { proc.kill('SIGTERM'); proc = null }
      ready = null
    }
  }
}
