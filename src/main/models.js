import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import https from 'node:https'

const HOME = os.homedir()
const APP_SUPPORT = path.join(HOME, 'Library', 'Application Support')

export const MODELS_DIR = path.join(APP_SUPPORT, 'transvibe', 'models')

/* Where whisper models turn up on a Mac. Directories rather than the exact
   filenames they held when this was written: these are other apps' folders,
   and whatever they downloaded last is what is actually there. We only ever
   read them — nothing is written outside MODELS_DIR. */
const SEARCH = [
  { dir: MODELS_DIR, from: 'downloaded here' },
  { dir: path.join(APP_SUPPORT, 'superwhisper'), from: 'superwhisper' },
  { dir: path.join(APP_SUPPORT, 'MacWhisper', 'models'), from: 'MacWhisper' },
  { dir: path.join(HOME, '.cache', 'whisper.cpp'), from: 'whisper.cpp' },
  { dir: path.join(HOME, 'Library', 'Caches', 'whisper.cpp'), from: 'whisper.cpp' }
]

/* Anything smaller is a VAD or embedding blob sharing the folder, not a model
   that can transcribe. */
const MIN_BYTES = 1e7

const DOWNLOADS = {
  'base.en': {
    file: 'ggml-base.en.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin',
    bytes: 147951465
  },
  'small.en': {
    file: 'ggml-small.en.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin',
    bytes: 487601967
  }
}

/**
 * The model's name, dug out of whatever the file that holds it is called.
 *
 * The same model is `ggml-small.en.bin` in one app's folder and
 * `ggml-model-whisper-small.bin` in another's, and a list showing both
 * verbatim reads as two different models. Both come back as `small.en` and
 * `small`, which is what they are.
 */
export function modelName (file) {
  return file
    .replace(/\.bin$/i, '')
    .replace(/^ggml-/i, '')
    .replace(/^model-whisper-/i, '')
    .replace(/^whisper-/i, '')
}

/** Human size, to a single decimal: the difference between models is GB-scale. */
export function humanSize (bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  const gb = bytes / 1e9
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`
}

/**
 * Every whisper model on this machine that transvibe could load, in the order
 * it would pick them: what we downloaded first, then other apps'.
 *
 * @returns {{path: string, file: string, name: string, bytes: number, from: string}[]}
 */
export function listModels () {
  const seen = new Set()
  const out = []
  for (const { dir, from } of SEARCH) {
    let files
    try {
      files = fs.readdirSync(dir)
    } catch {
      continue          // the folder belongs to an app that is not installed
    }
    for (const file of files.sort()) {
      if (!file.endsWith('.bin')) continue
      const full = path.join(dir, file)
      let bytes
      try {
        const stat = fs.statSync(full)
        if (!stat.isFile() || stat.size < MIN_BYTES) continue
        bytes = stat.size
      } catch {
        continue        // vanished between readdir and stat
      }
      // Two apps can hold the same file; the copy we would load is the first.
      const key = `${modelName(file)}:${bytes}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ path: full, file, name: modelName(file), bytes, from })
    }
  }
  return out
}

/** Preferred model path, or null if we have to download one. */
export function findModel (preferred) {
  if (preferred && fs.existsSync(preferred)) return preferred
  // Same list the settings panel shows, so what it says is in use is in use.
  return listModels()[0]?.path ?? null
}

export function downloadModel (name = 'base.en', onProgress = () => {}) {
  const spec = DOWNLOADS[name]
  if (!spec) throw new Error(`unknown model: ${name}`)
  fs.mkdirSync(MODELS_DIR, { recursive: true })
  const dest = path.join(MODELS_DIR, spec.file)
  if (fs.existsSync(dest) && fs.statSync(dest).size === spec.bytes) return Promise.resolve(dest)

  const tmp = `${dest}.part`
  return new Promise((resolve, reject) => {
    const get = url => https.get(url, { headers: { 'user-agent': 'transvibe' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        return get(res.headers.location)
      }
      if (res.statusCode !== 200) {
        res.resume()
        return reject(new Error(`download failed: HTTP ${res.statusCode}`))
      }
      const total = Number(res.headers['content-length']) || spec.bytes
      let seen = 0
      const out = fs.createWriteStream(tmp)
      res.on('data', c => { seen += c.length; onProgress(seen / total) })
      res.pipe(out)
      out.on('finish', () => {
        out.close(() => { fs.renameSync(tmp, dest); resolve(dest) })
      })
      out.on('error', reject)
    })
    get(spec.url).on('error', reject)
  })
}
