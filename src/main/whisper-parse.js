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
  'Uh.',
  // large-v3-turbo's own favourite: a YouTube name over a piano.
  'Pewds'
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

/* Sound tags, unbracketed.
   ------------------------------------------------------------------------
   A small model guesses at the room and gets it wrong cheaply: a piano comes
   back as 'Thank you.' at an avg_logprob of -0.7, so the confidence floor
   catches it without ever reading the words. A big one does something else
   entirely — it *annotates* the room, deliberately and correctly, and is as
   sure of 'Sad music.' as it is of a real sentence. The floor never sees it,
   and it arrives with no brackets on it, so the bracket rule never sees it
   either. What the model wrote is the only thing left to recognise it by.

   So: a curated vocabulary, and an utterance is a tag only if *every* word in
   it is in that vocabulary and at least one of them names a sound. That is
   what keeps 'The music was good.' — 'was' and 'good' are not in here, and one
   ordinary word is enough to make it a sentence. The cost is at the other end:
   dictating nothing but 'Sad music.' does nothing, the same bargain the
   glossary-echo rule already makes. */

// At least one of these has to be present: the thing making the sound.
const SOUND_EVENTS = [
  'music', 'song', 'singing', 'humming', 'applause', 'clapping', 'cheering',
  'laughter', 'laughing', 'chuckles', 'chuckling', 'giggling', 'sighs',
  'sighing', 'coughing', 'sneezing', 'breathing', 'silence', 'static',
  'beep', 'beeping', 'buzzing', 'ringing', 'click', 'clicking', 'tap',
  'tapping', 'knock', 'knocking', 'thud', 'whoosh', 'footsteps', 'typing',
  'chatter', 'rustling', 'creaking', 'squeaking', 'barking', 'snoring',
  'gasps', 'groans', 'grunts', 'screaming', 'shouting', 'whispering',
  'murmuring', 'mumbling', 'whistling', 'thunder', 'siren', 'horn', 'engine',
  'wind', 'rain', 'vibrating', 'inaudible', 'indistinct'
]

// Allowed around them, but never enough on their own.
const SOUND_MODIFIERS = [
  'sad', 'soft', 'softly', 'light', 'gentle', 'gently', 'upbeat', 'slow',
  'slowly', 'fast', 'dramatic', 'tense', 'somber', 'sombre', 'melancholy',
  'melancholic', 'cheerful', 'calm', 'quiet', 'quietly', 'loud', 'loudly',
  'faint', 'faintly', 'distant', 'eerie', 'ominous', 'suspenseful', 'dreamy',
  'romantic', 'epic', 'intense', 'mellow', 'moody',
  'piano', 'guitar', 'violin', 'drum', 'drums', 'orchestral', 'orchestra',
  'electronic', 'classical', 'ambient', 'instrumental', 'jazz', 'jazzy',
  'rock', 'pop', 'techno', 'rap', 'choir', 'synth', 'bass',
  'background', 'continues', 'continuing', 'playing', 'plays', 'stops',
  'fades', 'fading', 'sound', 'sounds', 'noise', 'noises', 'in', 'the', 'a',
  // Stock junk this particular model likes to staple to the front of one.
  'pewds', 'pewdiepie'
]

const SOUND_EVENT_WORDS = new Set(SOUND_EVENTS)
const SOUND_WORDS = new Set([...SOUND_EVENTS, ...SOUND_MODIFIERS])

// Longer than this and it is prose, whatever the words are.
const MAX_TAG_WORDS = 5

function isSoundTag (fragment) {
  const words = squash(fragment)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter(Boolean)
  if (!words.length || words.length > MAX_TAG_WORDS) return false
  if (!words.some(word => SOUND_EVENT_WORDS.has(word))) return false
  return words.every(word => SOUND_WORDS.has(word))
}

/* One utterance, cut where a run of tags would be cut: at sentence ends, at
   line breaks, and between two adjacent brackets. 'Sad music. Tap. Sad music.'
   is three of them, not one long one. */
function fragmentsOf (text) {
  return squash(text)
    .split(/(?<=[.!?…])\s+|(?<=[)\]])\s*(?=[([])/u)
    .map(squash)
    .filter(Boolean)
}

const WRAPPED = /^[*♪♫~]+[^*♪♫~]*[*♪♫~]+$/u
const EDGES = /^[[(*♪♫~\s]+|[\])*♪♫~\s.!?…]+$/gu

/** One fragment: a bracketed tag, a bare sound tag, or a stock phrase. */
function isTagLike (fragment) {
  const trimmed = squash(fragment)
  if (!trimmed) return true
  // Only punctuation / symbols, e.g. '...' or '?!' or a bare '♪'
  if (!/[\p{L}\p{N}]/u.test(trimmed)) return true
  // A single fully bracketed token, e.g. '[music]' or '(applause)'
  if (/^\[[^[\]]*\]$/.test(trimmed) || /^\([^()]*\)$/.test(trimmed)) return true
  // The same thing wrapped in asterisks or musical notes: '*sighs*', '♪ ♪'
  if (WRAPPED.test(trimmed)) return true
  if (isSoundTag(trimmed.replace(EDGES, ''))) return true
  return ARTIFACT_KEYS.has(normalize(trimmed))
}

/* The stuck decoder.
   ------------------------------------------------------------------------
   The other thing a big model does over music is loop. It latches onto a
   short phrase and emits it over and over — "I'm sorry. I'm sorry. I'm sorry.
   Amen." — and because each repeat is a perfectly ordinary sentence it clears
   the confidence floor, is not a sound tag, and contains no word this app
   could sensibly put on a list. Only the shape gives it away.

   So: the shape. Three or more short fragments where one of them repeats at
   least three times, or four or more where half of them are repeats, is a
   decoder stuck in a loop rather than somebody talking. Real dictation does
   not say the same short sentence three times running; the cost of being
   wrong about that is one lost "No. No. No." */

const MAX_LOOP_FRAGMENT_WORDS = 6

function wordCount (fragment) {
  return squash(fragment).split(/\s+/).filter(Boolean).length
}

function isRepetitionLoop (pieces) {
  if (pieces.length < 3) return false
  if (pieces.some(piece => wordCount(piece) > MAX_LOOP_FRAGMENT_WORDS)) return false
  const counts = new Map()
  for (const piece of pieces) {
    const key = normalize(piece)
    if (!key) continue
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  if (!counts.size) return false
  const most = Math.max(...counts.values())
  if (most >= 3) return true
  // Two phrases traded back and forth is the same failure, one step wider.
  return pieces.length >= 4 && counts.size * 2 <= pieces.length
}

export function isArtifact (text) {
  const trimmed = squash(text)
  if (!trimmed) return true
  if (isTagLike(trimmed)) return true
  /* A run of them is as much a non-utterance as one is, and the bigger models
     produce runs: a minute of a track comes back as tag, tag, tag. Every
     piece has to be one — a single real sentence anywhere in there and the
     whole utterance is kept, punctuation and all. */
  const pieces = fragmentsOf(trimmed)
  if (pieces.length > 1 && pieces.every(isTagLike)) return true
  return isRepetitionLoop(pieces)
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
