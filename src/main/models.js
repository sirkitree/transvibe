import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import https from 'node:https'

const HOME = os.homedir()
const APP_SUPPORT = path.join(HOME, 'Library', 'Application Support')

export const MODELS_DIR = path.join(APP_SUPPORT, 'transvibe', 'models')

/* Models other local-whisper apps may already have downloaded. We only ever
   read these — never write into another app's directory. */
const FOREIGN = [
  path.join(APP_SUPPORT, 'superwhisper', 'ggml-small.en.bin'),
  path.join(APP_SUPPORT, 'MacWhisper', 'models', 'ggml-model-whisper-small.bin'),
  path.join(HOME, '.cache', 'whisper.cpp', 'ggml-small.en.bin'),
  path.join(HOME, '.cache', 'whisper.cpp', 'ggml-base.en.bin')
]

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

/** Preferred model path, or null if we have to download one. */
export function findModel (preferred) {
  if (preferred && fs.existsSync(preferred)) return preferred

  const own = fs.existsSync(MODELS_DIR)
    ? fs.readdirSync(MODELS_DIR)
      .filter(f => f.endsWith('.bin'))
      .map(f => path.join(MODELS_DIR, f))
    : []

  for (const p of [...own, ...FOREIGN]) {
    if (fs.existsSync(p) && fs.statSync(p).size > 1e7) return p
  }
  return null
}

export function listModels () {
  return [...(fs.existsSync(MODELS_DIR)
    ? fs.readdirSync(MODELS_DIR).filter(f => f.endsWith('.bin')).map(f => path.join(MODELS_DIR, f))
    : []), ...FOREIGN.filter(p => fs.existsSync(p))]
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
