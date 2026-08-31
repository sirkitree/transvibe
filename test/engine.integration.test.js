import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createEngine } from '../src/main/whisper.js'
import { findModel } from '../src/main/models.js'

/* Real end-to-end coverage with no cloud and no microphone: macOS `say`
   synthesises a known phrase, ffmpeg conforms it to 16 kHz mono, and the
   engine has to read it back. Skipped wherever the toolchain is absent. */

const has = bin => {
  try { execFileSync('which', [bin], { stdio: 'ignore' }); return true } catch { return false }
}

const model = findModel(null)
const runnable =
  process.platform === 'darwin' &&
  has('say') && has('ffmpeg') &&
  (existsSync('/opt/homebrew/bin/whisper-server') || existsSync('/opt/homebrew/bin/whisper-cli')) &&
  !!model

describe.skipIf(!runnable)('whisper engine (integration)', () => {
  let dir
  let engine
  let samples

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'transvibe-'))
    const aiff = path.join(dir, 'f.aiff')
    const wav = path.join(dir, 'f.wav')
    execFileSync('say', ['testing one two three, transcribe this locally', '-o', aiff])
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', aiff,
      '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav])

    const buf = readFileSync(wav)
    const pcm = buf.subarray(44)
    samples = new Float32Array(pcm.length / 2)
    for (let i = 0; i < samples.length; i++) {
      samples[i] = pcm.readInt16LE(i * 2) / 32768
    }

    engine = createEngine({ modelPath: model })
    await engine.start()
  }, 120000)

  afterAll(() => {
    if (engine) engine.stop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('transcribes synthesised speech', async () => {
    const { text } = await engine.transcribe(samples)
    const norm = text.toLowerCase().replace(/[^a-z0-9 ]/g, '')
    expect(norm).toContain('transcribe this locally')
    expect(norm).toMatch(/testing (one two three|123)/)
  }, 60000)

  it('returns empty text for silence rather than a hallucinated phrase', async () => {
    const silence = new Float32Array(16000)
    const { text } = await engine.transcribe(silence)
    expect(text).toBe('')
  }, 60000)

  it('transcribes an interim pass of a partial utterance', async () => {
    // the first ~1.4s of the fixture, as an in-flight utterance would arrive
    const partial = samples.slice(0, 16000 * 1.4)
    const { text } = await engine.transcribe(partial, { interim: true })
    expect(text.toLowerCase()).toMatch(/test/)
  }, 60000)

  it('serialises concurrent requests without dropping any', async () => {
    const results = await Promise.all([
      engine.transcribe(samples),
      engine.transcribe(samples),
      engine.transcribe(samples)
    ])
    for (const r of results) {
      expect(r.text.toLowerCase()).toContain('locally')
    }
  }, 120000)
})
