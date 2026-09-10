import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createEngine } from '../src/main/whisper.js'
import { findModel, findVadModel } from '../src/main/models.js'

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
    // Which spelling of the digits you get is the model's choice, not the app's:
    // large-v3-turbo writes '1 2 3' where the smaller models wrote '123'.
    expect(norm).toMatch(/testing (one two three|1 ?2 ?3)/)
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

  /* The gate, against the thing it exists for. Everything above runs with it
     off, which is deliberate — those are the behaviours that must survive the
     detector being unavailable — so this block brings up a second engine with
     it on and asks the two questions that matter: does music stop becoming
     words, and do words still become words. */
  describe.skipIf(!findVadModel())('with the speech gate on', () => {
    let gated
    let music

    beforeAll(async () => {
      const wav = path.join(dir, 'music.wav')
      // A major triad held for twelve seconds: no speech in it anywhere, and
      // ungated it comes back as a word.
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12',
        '-f', 'lavfi', '-i', 'sine=frequency=554:duration=12',
        '-f', 'lavfi', '-i', 'sine=frequency=659:duration=12',
        '-filter_complex', 'amix=inputs=3',
        '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav])
      const pcm = readFileSync(wav).subarray(44)
      music = new Float32Array(pcm.length / 2)
      for (let i = 0; i < music.length; i++) music[i] = pcm.readInt16LE(i * 2) / 32768

      gated = createEngine({
        modelPath: model,
        vad: { enabled: true, modelPath: findVadModel() }
      })
      await gated.start()
    }, 120000)

    afterAll(() => { if (gated) gated.stop() })

    /* Deliberately the first thing this engine is ever asked, because that is
       the case that used to kill it: whisper-server 1.9.2 segfaults when the
       first request it serves comes back from VAD with nothing in it, and the
       app's own first request is whatever the room was doing at launch. The
       second half of this test is the regression — an engine that crashed here
       would answer the music correctly and then be gone. */
    it('hands back nothing at all for music, and survives it', async () => {
      const res = await gated.transcribe(music)
      expect(res.text).toBe('')
      // Not merely empty: empty because nothing in it was speech. The reason
      // is what the strip shows while you are tuning the threshold.
      expect(res.dropped).toBe('no speech')

      const after = await gated.transcribe(samples)
      expect(after.text.toLowerCase()).toContain('locally')
    }, 120000)

    it('still hears actual speech', async () => {
      // The failure this guards against is a gate that solves music by
      // rejecting everything.
      const { text, dropped } = await gated.transcribe(samples)
      expect(dropped).toBeUndefined()
      expect(text.toLowerCase()).toContain('locally')
    }, 60000)

    it('does not clip a half-second interim slice down to nothing', async () => {
      // An open utterance arrives as a fraction of a second, well under
      // silero's own 250ms minimum-speech default — which is exactly where a
      // gate would be expected to eat the first word.
      const partial = samples.slice(0, 8000)
      const { text } = await gated.transcribe(partial, { interim: true })
      expect(text.toLowerCase()).toMatch(/test/)
    }, 60000)
  })

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
