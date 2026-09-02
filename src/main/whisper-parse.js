// Pure, headless core for the whisper.cpp sidecar: output parsing, hallucination
// filtering, and a strictly serialized job queue. No child_process, no Electron.

const TIMESTAMP_LINE = /^\[(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\]\s*(.*)$/
// Fraction is optional: some servers emit whole-second stamps like '00:00:03'.
const CLOCK = /^(\d{1,2}):(\d{2}):(\d{2})(?:[.,](\d{1,3}))?$/
const NOISE_PREFIXES = ['whisper_', 'main:', 'system_info', 'ggml_']

// Stock phrases small Whisper models emit over silence. Matched whole-string only.
export const ARTIFACTS = [
  '[BLANK_AUDIO]',
  '(blank audio)',
  '[silence]',
  '[ Silence ]',
  'you',
  'Thank you.',
  'Thanks for watching!',
  'Please subscribe',
  'Bye.',
  '.',
  '...',
  'Mm-hmm.',
  'Uh.'
]

function squash (text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
}

// Fold to letters and digits only, so 'Mm-hmm.', 'mm hmm' and 'MM HMM!' all
// collapse to the same key. Whole-string comparison only, never substring.
function normalize (text) {
  return squash(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

const ARTIFACT_KEYS = new Set(ARTIFACTS.map(normalize).filter(Boolean))

function clockToMs (value) {
  const m = CLOCK.exec(String(value).trim())
  if (!m) return null
  const [, hh, mm, ss, frac] = m
  const ms = frac ? Number(frac.padEnd(3, '0')) : 0
  return ((Number(hh) * 60 + Number(mm)) * 60 + Number(ss)) * 1000 + ms
}

function isNoise (line) {
  return NOISE_PREFIXES.some(prefix => line.startsWith(prefix))
}

function assemble (segments) {
  const text = squash(segments.map(seg => seg.text).join(' '))
  return { text, segments }
}

export function parseCliOutput (stdout) {
  const segments = []
  for (const raw of String(stdout == null ? '' : stdout).split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const m = TIMESTAMP_LINE.exec(line)
    if (m) {
      const text = squash(m[9])
      if (!text) continue
      const startMs = ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4])
      const endMs = ((Number(m[5]) * 60 + Number(m[6])) * 60 + Number(m[7])) * 1000 + Number(m[8])
      segments.push({ startMs, endMs, text })
      continue
    }
    if (isNoise(line) || line.startsWith('[')) continue
    segments.push({ startMs: null, endMs: null, text: squash(line) })
  }
  return assemble(segments)
}

/* verbose_json carries the decoder's own opinion of what it just produced, and
   it is the only reliable signal that a transcript is music rather than words:
   measured against this app's own server, real speech comes back at an
   avg_logprob of -0.01 to -0.08, while a chord, a fan and a pure tone land at
   -0.65, -0.76 and -0.64. (`no_speech_prob`, which sounds like the field for
   exactly this, is 0.0000 for all three and useless.) */
function confidenceOf (segments) {
  const scored = segments.filter(s => Number.isFinite(s.avgLogprob))
  if (!scored.length) return null
  // The worst segment, not the mean: one confident word does not redeem an
  // utterance that was otherwise invented.
  return Math.min(...scored.map(s => s.avgLogprob))
}

export function parseServerJson (obj) {
  if (!obj || typeof obj !== 'object') return { text: '', segments: [] }
  if (Array.isArray(obj.segments)) {
    const segments = obj.segments
      .map(entry => ({
        startMs: typeof entry.start === 'number' ? Math.round(entry.start * 1000) : clockToMs(entry.start),
        endMs: typeof entry.end === 'number' ? Math.round(entry.end * 1000) : clockToMs(entry.end),
        text: squash(entry && entry.text),
        avgLogprob: typeof entry.avg_logprob === 'number' ? entry.avg_logprob : null
      }))
      .filter(seg => seg.text)
    const out = assemble(segments)
    const confidence = confidenceOf(segments)
    return confidence === null ? out : { ...out, confidence }
  }
  if (Array.isArray(obj.transcription)) {
    const segments = obj.transcription
      .map(entry => {
        const stamps = (entry && entry.timestamps) || {}
        return {
          startMs: clockToMs(stamps.from),
          endMs: clockToMs(stamps.to),
          text: squash(entry && entry.text)
        }
      })
      .filter(seg => seg.text)
    return assemble(segments)
  }
  return { text: squash(obj.text), segments: [] }
}

export function isArtifact (text) {
  const trimmed = squash(text)
  if (!trimmed) return true
  // Only punctuation / symbols, e.g. '...' or '?!'
  if (!/[\p{L}\p{N}]/u.test(trimmed)) return true
  // A single fully bracketed token, e.g. '[music]' or '(applause)'
  if (/^\[[^[\]]*\]$/.test(trimmed) || /^\([^()]*\)$/.test(trimmed)) return true
  return ARTIFACT_KEYS.has(normalize(trimmed))
}

/**
 * Was this confident enough to have been speech?
 *
 * A floor rather than a judgement of quality: everything above it is kept
 * exactly as it was heard. The gap it works in is wide — real speech is an
 * order of magnitude more confident than a transcription of music — so a
 * threshold anywhere in the middle separates them, and the setting exists
 * because "the middle" depends on the room.
 *
 * `null` means the decoder said nothing about it (the CLI path, an older
 * server), and unknown always passes: a missing signal must never cost you
 * your words.
 *
 * @param {number|null|undefined} confidence
 * @param {number} floor  0 turns the check off
 */
export function isConfident (confidence, floor) {
  if (!Number.isFinite(floor) || floor === 0) return true
  if (!Number.isFinite(confidence)) return true
  return confidence >= floor
}

export function cleanTranscript (text) {
  const trimmed = squash(text)
  return isArtifact(trimmed) ? '' : trimmed
}

export function createQueue (worker) {
  const pending = []
  let running = false
  let drainWaiters = []

  function settleDrain () {
    if (running || pending.length) return
    const waiters = drainWaiters
    drainWaiters = []
    for (const resolve of waiters) resolve()
  }

  function next () {
    if (running) return
    const entry = pending.shift()
    if (!entry) {
      settleDrain()
      return
    }
    running = true
    // Clear `running` and pump the queue *before* settling the caller, so a
    // continuation on push() never observes a stale in-flight state.
    const finish = settle => value => {
      running = false
      settle(value)
      next()
    }
    Promise.resolve()
      .then(() => worker(entry.job))
      .then(finish(entry.resolve), finish(entry.reject))
  }

  return {
    push (job) {
      return new Promise((resolve, reject) => {
        pending.push({ job, resolve, reject })
        next()
      })
    },
    get size () {
      return pending.length
    },
    get running () {
      return running
    },
    drain () {
      if (!running && pending.length === 0) return Promise.resolve()
      return new Promise(resolve => drainWaiters.push(resolve))
    }
  }
}
