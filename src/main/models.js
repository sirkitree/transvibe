import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import https from 'node:https'

const HOME = os.homedir()
const APP_SUPPORT = path.join(HOME, 'Library', 'Application Support')

export const MODELS_DIR = path.join(APP_SUPPORT, 'transvibe', 'models')

/* Where to look for whisper models, and how deep.
   
   Named directories were wrong twice over: they went stale the moment an app
   changed its layout, and they could only ever know about apps that existed
   when this was written. A bounded walk of the few places a Mac app is allowed
   to keep data finds what is actually there — MacWhisper nests its ggml model
   one level down, Highlight nests its three — and costs about twenty
   milliseconds, which is affordable for something asked only when the settings
   panel opens or the engine starts. */
const ROOTS = [
  { dir: MODELS_DIR, depth: 1, from: 'downloaded here' },
  { dir: APP_SUPPORT, depth: 4 },
  { dir: path.join(HOME, 'Library', 'Caches'), depth: 3 },
  { dir: path.join(HOME, '.cache'), depth: 3 }
]

/* Folders with nothing in them but weight and are expensive to descend. The
   .mlmodelc test is the one that matters: a CoreML bundle is full of
   multi-hundred-megabyte weight.bin files that would otherwise read as
   models. */
const SKIP_DIR = /^(RecordedMeetings|Database|Logs|Backups|node_modules|\.git|weights)$|\.mlmodelc$|\.mlpackage$/

/* Sidecars that sit beside a model under a name close enough to be mistaken
   for one: an OpenVINO or CoreML encoder is half a model and loading it fails
   in a way that reads like a corrupt file. */
const SKIP_FILE = /-encoder-|openvino/i

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
 * it would pick them: what we downloaded first, then whatever other apps have.
 *
 * Only whisper.cpp's ggml format is listed, because that is all the engine can
 * load. MacWhisper and its kin also keep WhisperKit CoreML models — whole
 * directories of .mlmodelc bundles, often the larger and better ones — and
 * those are deliberately not offered: they need a different runtime, and a
 * list that showed them would be a list of things that fail to load.
 *
 * @param {{roots?: {dir: string, depth: number, from?: string}[]}} [options] where
 *   to look; the default is the real ones, and tests pass a directory of their own.
 * @returns {{path: string, file: string, name: string, bytes: number, from: string}[]}
 */
export function listModels ({ roots = ROOTS } = {}) {
  const seen = new Set()
  const out = []

  const walk = (dir, depth, from) => {
    if (depth < 0) return
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return          // not installed, or not ours to read
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIR.test(entry.name)) continue
        // The app the model belongs to is the first folder under the root, so
        // the list can say whose it is.
        walk(full, depth - 1, from ?? entry.name)
        continue
      }
      if (!entry.isFile()) continue
      if (!entry.name.endsWith('.bin')) continue
      if (SKIP_FILE.test(entry.name)) continue
      let bytes
      try {
        const stat = fs.statSync(full)
        if (stat.size < MIN_BYTES) continue
        bytes = stat.size
      } catch {
        continue      // vanished between readdir and stat
      }
      // The same model in two apps' folders is one model; the copy we would
      // load is the first one found.
      const key = `${modelName(entry.name)}:${bytes}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ path: full, file: entry.name, name: modelName(entry.name), bytes, from: from ?? 'elsewhere' })
    }
  }

  for (const root of roots) walk(root.dir, root.depth - 1, root.from)
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
