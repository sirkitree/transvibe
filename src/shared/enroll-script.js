// The lines you read aloud to teach the app your voice, and the rules for
// deciding when a reading of one counts.
//
// Pure, because what makes a usable enrolment is worth testing without a
// microphone: how long a reading has to be, what happens when somebody reads
// half a line or coughs, and when there is enough to build a profile from.

import { ENROLL_TARGET } from './voiceprint-gate.js'

/* Five lines, because five is where the benchmark stops improving, and this
   long because a four-second reading carries far more of a voice than a
   one-second one — the profile is built from the best audio it will ever get,
   and everything measured against it afterwards is shorter and worse.

   They are written to be read, not composed: plain words, no tongue-twisters,
   nothing anybody would feel silly saying out loud. Between them they cover
   the vowels and most of the consonants English uses often.

   The last one is the wake phrase itself, in a full sentence, and it is the
   reason `lines()` is a function rather than a constant: the names are the
   user's, so a fixed line here would enrol everybody against whatever this
   file happened to be written with. It is the one utterance the gate judges
   most often and the shortest it ever sees, so it belongs in the profile
   rather than being left to generalise. */
const COMMON = [
  'The quick brown fox jumps over the lazy dog while the sun goes down.',
  'I usually start the morning with coffee, then read whatever came in overnight.',
  'Seven bright yellow houses sat along the river, each one older than the last.',
  'Could you check the weather for tomorrow and tell me if I need a coat?'
]

/**
 * The lines to read, ending with one that uses a name you actually gave an
 * agent.
 *
 * @param {string} wakePhrase the first agent's name, e.g. "hey Mira"
 */
export function lines (wakePhrase = '') {
  const name = String(wakePhrase || '').trim()
  /* Title-cased because this is read aloud off the screen, and a line that
     opens "hey claude," looks like a typo to whoever has to read it. */
  const said = name.replace(/\b\p{Ll}/gu, c => c.toUpperCase())
  const last = said
    ? `${said}, remember that my voice is the one you should be listening for.`
    : 'Remember that my voice is the one you should be listening for.'
  return [...COMMON, last]
}

/* The shape of it, for anything that only needs to know how many there are. */
export const LINE_COUNT = COMMON.length + 1

/* Long enough that the reading was the line rather than the first few words of
   it, and not so long that a brisk reader is told off. These lines take five
   to seven seconds read normally; three is a floor, not a target. */
export const MIN_READING_SECONDS = 3
export const MAX_READING_SECONDS = 20

/**
 * A reading has arrived. Was it any good, and what happens next?
 *
 * @param {object} state  from `startEnrolment()`
 * @param {number} seconds  how long the utterance was
 * @param {string} text  what it transcribed to, when there is a transcript
 * @returns {{state: object, accepted: boolean, message: string, done: boolean}}
 */
export function readingHeard (state, seconds, text = '') {
  if (!Number.isFinite(seconds) || seconds < MIN_READING_SECONDS) {
    /* Short is the common failure and it is almost always the same thing:
       somebody paused mid-line and the silence ended the utterance. Saying
       which line rather than just "too short" is what makes that obvious. */
    return {
      state,
      accepted: false,
      done: false,
      message: `a bit short — read the whole line without stopping`
    }
  }
  if (seconds > MAX_READING_SECONDS) {
    return { state, accepted: false, done: false, message: 'that ran long — just the line is enough' }
  }
  /* A reading that transcribed to almost nothing was not a reading: a cough, a
     door, the dog. Checked loosely, because whisper mishears plenty and a
     wrong word is still your voice — only near-silence is disqualifying. */
  if (text && text.replace(/[^\p{L}\p{N}]+/gu, '').length < 8) {
    return { state, accepted: false, done: false, message: 'did not catch that — try the line again' }
  }

  const next = { ...state, index: state.index + 1, captured: state.captured + 1 }
  const done = next.captured >= ENROLL_TARGET || next.index >= LINE_COUNT
  return {
    state: next,
    accepted: true,
    done,
    message: done
      ? 'that is all of them — measuring your voice…'
      : `line ${next.index + 1} of ${LINE_COUNT}`
  }
}

export function startEnrolment () {
  return { index: 0, captured: 0 }
}

/** The line to put in front of the reader right now, or null when finished. */
export function currentLine (state, wakePhrase = '') {
  const all = lines(wakePhrase)
  return state && state.index < all.length ? all[state.index] : null
}

export function progress (state) {
  return { done: state.captured, total: Math.min(ENROLL_TARGET, LINE_COUNT) }
}

/**
 * What to tell somebody once the profile is built.
 *
 * The scores are the enrolment readings measured against the profile they
 * just made, so they are the most flattering numbers this will ever produce —
 * said plainly, because quoting them as if they predicted everyday use would
 * set the wrong expectation for the first time a short "hey Mira" scores 0.6.
 */
export function enrolmentSummary ({ ok, count, error, scores = [], threshold = 0.35 }) {
  if (!ok) return `could not build a voiceprint — ${error || 'nothing was measured'}`
  const usable = scores.filter(Number.isFinite)
  if (!usable.length) return `enrolled from ${count} readings.`
  const low = Math.min(...usable)
  /* A reading that scores near the threshold against its own profile means the
     readings disagreed with each other — most often two different people, or
     one person and a television. Worth saying so rather than reporting success
     and letting the gate behave oddly later. */
  if (low < threshold + 0.2) {
    return `enrolled from ${count} readings, but they did not sound much alike ` +
      `(lowest ${low.toFixed(2)}). Somewhere quieter, and only one voice, would do better.`
  }
  return `enrolled from ${count} readings. Say a name to try it.`
}
