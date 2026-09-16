import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { DIR } from '../src/main/config.js'
import { createVoiceprint, modelReady } from '../src/main/voiceprint.js'
import { allowAgent, thresholdFor } from '../src/shared/voiceprint-gate.js'

/* The model is 27 MB and the corpus is whatever this Mac has recorded, so this
   one cannot run in CI and does not pretend to. It is the test that would have
   caught the two things unit tests could not: a model export that scores near
   chance, and an Electron buffer rule that makes every call throw. */
const RECORDINGS = path.join(DIR, 'recordings')
const ready = modelReady() && fs.existsSync(RECORDINGS)

function readWav (file) {
  const buf = fs.readFileSync(file)
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return null
  let at = 12, dataAt = 0, dataLen = 0, bits = 16, channels = 1
  while (at + 8 <= buf.length) {
    const id = buf.toString('ascii', at, at + 4)
    const size = buf.readUInt32LE(at + 4)
    if (id === 'fmt ') { channels = buf.readUInt16LE(at + 10); bits = buf.readUInt16LE(at + 22) }
    if (id === 'data') { dataAt = at + 8; dataLen = Math.min(size, buf.length - dataAt); break }
    at += 8 + size + (size & 1)
  }
  if (!dataAt || bits !== 16 || channels !== 1) return null
  const out = new Float32Array(dataLen >> 1)
  for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(dataAt + i * 2) / 32768
  return out
}

function clips () {
  const rows = []
  for (const session of fs.readdirSync(RECORDINGS).sort()) {
    const dir = path.join(RECORDINGS, session)
    if (!fs.statSync(dir).isDirectory()) continue
    const text = new Map()
    const events = path.join(dir, 'events.jsonl')
    if (fs.existsSync(events)) {
      for (const line of fs.readFileSync(events, 'utf8').split('\n')) {
        if (!line) continue
        try {
          const e = JSON.parse(line)
          if (e.type === 'transcription-result' && e.debugId) text.set(e.debugId, (e.text || '').trim())
        } catch { /* half-written last line */ }
      }
    }
    for (const file of fs.readdirSync(dir)) {
      if (!file.startsWith('utterance-') || !file.endsWith('.wav')) continue
      const samples = readWav(path.join(dir, file))
      if (samples) rows.push({ session, samples, seconds: samples.length / 16000, text: text.get(file.slice(10, -4)) || '' })
    }
  }
  return rows
}

describe.skipIf(!ready)('voiceprint (integration)', () => {
  let vp, all
  /* Every clip is embedded once here and the scores reused: the model load is
     a third of a second and each clip another sixtieth, which is nothing per
     utterance and minutes if each test pays for it again. */
  beforeAll(() => {
    vp = createVoiceprint()
    all = clips().map(c => ({ ...c, score: vp.score(c.samples) }))
  }, 120000)

  it('loads the model at the dimension the profile expects', () => {
    expect(vp.status.available).toBe(true)
    expect(vp.status.error).toBe(null)
  })

  it('embeds at 192 dimensions — the 512-d exports of this model score near chance', () => {
    const v = vp.embed(all[0].samples)
    expect(v).toBeTruthy()
    expect(v.length).toBe(192)
  })

  it('computes without tripping Electron\'s external-buffer rule', () => {
    // enableExternalBuffer:false is what makes this work in the main process
    expect(() => vp.embed(all[0].samples)).not.toThrow()
  })

  it('scores the same voice high and a different voice near zero', () => {
    if (!vp.status.enrolled) return
    const scored = all.filter(c => Number.isFinite(c.score))
    const spoken = scored.filter(c => c.text && c.seconds >= 2)
    expect(spoken.length).toBeGreaterThan(5)
    // the enrolled speaker dominates this corpus, so the top of it is one voice
    const top = spoken.sort((a, b) => b.score - a.score).slice(0, 10)
    expect(Math.min(...top.map(c => c.score))).toBeGreaterThan(0.5)
    // and the bottom is not
    expect(Math.min(...scored.map(c => c.score))).toBeLessThan(0.2)
  })

  it('admits a bare wake phrase — the shortest thing anybody says', () => {
    if (!vp.status.enrolled) return
    const wake = all.filter(c => /^hey,? mira\.?$/i.test(c.text))
    if (!wake.length) return
    for (const c of wake) {
      const verdict = allowAgent({
        score: c.score,
        threshold: thresholdFor(c.seconds, 0.35),
        enabled: true,
        enrolled: true
      })
      expect(verdict, `"${c.text}" at ${c.seconds.toFixed(1)}s scored ${c.score?.toFixed(3)}`)
        .toMatchObject({ pass: true })
    }
  })

  it('never blocks the key path, whatever the microphone heard', () => {
    const worst = all.map(c => c.score).filter(Number.isFinite).sort((a, b) => a - b)[0]
    expect(allowAgent({ score: worst, threshold: 0.35, enabled: true, enrolled: true, commandMode: true }))
      .toMatchObject({ pass: true })
  })

  it('scores an utterance far faster than transcribing it', () => {
    const c = all.find(x => x.seconds >= 2) || all[0]
    vp.embed(c.samples)   // warm
    const t = performance.now()
    vp.embed(c.samples)
    const ms = performance.now() - t
    // whisper is ~0.35 RTF; this must stay an order of magnitude under it
    expect(ms).toBeLessThan(c.seconds * 1000 * 0.1)
  })
})
