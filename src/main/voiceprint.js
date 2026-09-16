import fs from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import { createRequire } from 'node:module'
import { DIR } from './config.js'
import { centroid, cosine } from '../shared/voiceprint-gate.js'

const require = createRequire(import.meta.url)

/* The model, chosen by measurement rather than by reputation.
   ------------------------------------------------------------------------
   Six were scored against 46 utterances of the enrolled voice and 21 of other
   people, taken from this app's own debug recordings. Three reached a clean
   separation; this one separates widest and runs fastest of those:

     CAM++ zh_en advanced   own voice 0.53–0.93   others −0.07–0.15   57ms
     TitaNet small          own voice 0.48–…      others …–0.21       40ms
     ResNet34 LM            own voice 0.69–…      others …–0.68      196ms

   ResNet34 scores a perfect split too, but with a thousandth of a point
   between the best impostor and the worst genuine utterance — perfect on the
   clips it was shown and one bad recording from failing. The gap is the
   number that matters, not the error rate, and 0.15→0.53 is a gap you can put
   a threshold in the middle of.

   Two models in the same release are exported at 512 dimensions where CAM++
   is natively 192, and both score near chance. Whatever is wrong with them,
   `dim === 192` is the cheap tell — so the loader refuses a model whose
   dimension does not match what the profile was enrolled with. */
const MODEL = {
  file: '3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx',
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx',
  bytes: 28281164,
  dim: 192
}

export const MODEL_PATH = path.join(DIR, 'models', MODEL.file)
const PROFILE_PATH = path.join(DIR, 'voiceprint.json')

/* Electron 21 put V8's heap behind a memory cage, and an external buffer —
   a Float32Array pointing at memory the addon owns — is not allowed through
   it. sherpa-onnx takes a flag for exactly this and copies instead. Passing
   `false` is what makes any of this work in the main process rather than in a
   sidecar; without it every call throws "External buffers are not allowed". */
const COPY = false

export function modelReady () {
  try { return fs.statSync(MODEL_PATH).size === MODEL.bytes } catch { return false }
}

export function downloadModel (onProgress = () => {}) {
  fs.mkdirSync(path.dirname(MODEL_PATH), { recursive: true })
  const tmp = `${MODEL_PATH}.part`
  return new Promise((resolve, reject) => {
    const get = url => https.get(url, { headers: { 'User-Agent': 'transvibe' } }, res => {
      if ([301, 302, 307, 308].includes(res.statusCode)) { res.resume(); return get(res.headers.location) }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`voiceprint model: HTTP ${res.statusCode}`)) }
      const out = fs.createWriteStream(tmp)
      let got = 0
      res.on('data', c => { got += c.length; onProgress(got / MODEL.bytes) })
      res.pipe(out)
      out.on('finish', () => {
        out.close(() => {
          try {
            if (fs.statSync(tmp).size !== MODEL.bytes) throw new Error('voiceprint model: wrong size')
            fs.renameSync(tmp, MODEL_PATH)
            resolve(MODEL_PATH)
          } catch (err) { try { fs.unlinkSync(tmp) } catch {} ; reject(err) }
        })
      })
      out.on('error', reject)
    })
    get(MODEL.url).on('error', reject)
  })
}

/**
 * The voiceprint engine: turns audio into an embedding, and an embedding into
 * a score against the enrolled profile.
 *
 * Nothing here throws at the caller. A missing model, a missing addon, a
 * corrupt profile — each one leaves the engine simply unable to score, which
 * the gate reads as "not configured" and lets through. Losing the filter is a
 * nuisance; losing the ability to talk to the app is not.
 */
export function createVoiceprint ({ onError = () => {} } = {}) {
  let extractor = null
  let loadError = null
  let profile = null      // { v: Float32Array, dim, count, model, at }

  function load () {
    if (extractor || loadError) return extractor
    if (!modelReady()) { loadError = 'model not downloaded'; return null }
    try {
      const sherpa = require('sherpa-onnx-node')
      const ex = new sherpa.SpeakerEmbeddingExtractor({ model: MODEL_PATH, numThreads: 1, debug: false })
      if (ex.dim !== MODEL.dim) throw new Error(`expected ${MODEL.dim} dimensions, model reports ${ex.dim}`)
      extractor = ex
    } catch (err) {
      loadError = err.message
      onError(`voiceprint unavailable — ${err.message}`)
    }
    return extractor
  }

  function readProfile () {
    if (profile !== null) return profile
    try {
      const raw = JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf8'))
      if (!Array.isArray(raw.v) || raw.v.length !== MODEL.dim) return (profile = false)
      /* Enrolled against a different model is the same as not enrolled: the
         embeddings are not comparable and a score between them is noise. */
      if (raw.model && raw.model !== MODEL.file) return (profile = false)
      profile = { v: Float32Array.from(raw.v), dim: raw.v.length, count: raw.count || 0, model: raw.model, at: raw.at }
    } catch { profile = false }
    return profile
  }

  /** @returns {Float32Array|null} */
  function embed (samples) {
    const ex = load()
    if (!ex || !samples?.length) return null
    try {
      const stream = ex.createStream()
      stream.acceptWaveform({ sampleRate: 16000, samples })
      return ex.compute(stream, COPY)
    } catch (err) {
      onError(`voiceprint failed — ${err.message}`)
      return null
    }
  }

  return {
    get status () {
      const p = readProfile()
      return {
        available: !!load(),
        error: loadError,
        modelReady: modelReady(),
        enrolled: !!p,
        count: p ? p.count : 0,
        enrolledAt: p ? p.at : null
      }
    },

    /** Cosine of this utterance against the enrolled profile, or null when
        there is nothing to compare it to. */
    score (samples) {
      const p = readProfile()
      if (!p) return null
      const v = embed(samples)
      return v ? cosine(p.v, v) : null
    },

    embed,

    /** Replace the profile with the average of these utterances. */
    enroll (samplesList) {
      const vectors = (samplesList || []).map(embed).filter(Boolean)
      if (!vectors.length) return { ok: false, error: loadError || 'nothing could be measured' }
      const v = centroid(vectors)
      if (!v) return { ok: false, error: 'embeddings did not agree in size' }
      const record = { v: Array.from(v), dim: v.length, count: vectors.length, model: MODEL.file, at: new Date().toISOString() }
      try {
        fs.mkdirSync(DIR, { recursive: true })
        fs.writeFileSync(PROFILE_PATH, JSON.stringify(record), { mode: 0o600 })
      } catch (err) { return { ok: false, error: err.message } }
      profile = { v, dim: v.length, count: vectors.length, model: MODEL.file, at: record.at }
      return { ok: true, count: vectors.length }
    },

    /** Score each utterance against the enrolled profile without changing it
        — what a threshold is tuned with. */
    probe (samplesList) {
      const p = readProfile()
      if (!p) return []
      return (samplesList || []).map(s => {
        const v = embed(s)
        return { score: v ? cosine(p.v, v) : null, seconds: s.length / 16000 }
      })
    },

    forget () {
      try { fs.unlinkSync(PROFILE_PATH) } catch {}
      profile = false
      return { ok: true }
    }
  }
}
