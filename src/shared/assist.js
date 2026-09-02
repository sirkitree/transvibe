/**
 * Prompts and reply-handling for the local assist model.
 *
 * A second model, run locally through Ollama, does the three things a small
 * whisper model and a rule parser each do badly:
 *
 *   cleanup   filler words, false starts and spoken self-corrections, rewritten
 *             into what the speaker meant. Whisper transcribes exactly what it
 *             heard, which is the right job for it; tidying is a text task.
 *   command   the fallback for an utterance the rule parser did not recognise,
 *             which until now was only logged. Rules run first and command mode
 *             is explicitly armed, so this is only ever asked about speech the
 *             user already declared to be a command — the model never gets the
 *             chance to mistake dictation for one.
 *   speak     the confirmation the applier wrote, shortened into something
 *             worth hearing out loud. Four words spoken beats twelve read.
 *
 * Pure: prompt text in, parsed answer out. Nothing here talks to a process or
 * a socket, so the guard rails below are unit-testable, which matters — an
 * unguarded model reply would be rewriting the user's words.
 */

export const CLEANUP_PROMPT = [
  'Rewrite this dictated text: remove filler words and false starts, apply any',
  'spoken self-corrections, and punctuate it. Change nothing else — do not',
  'summarise, do not add words, do not answer it. Output only the rewritten text.'
].join(' ')

export function buildCleanupMessage (text) {
  return `${CLEANUP_PROMPT}\n\n${String(text == null ? '' : text)}`
}

function squash (text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
}

/* Models like to introduce themselves. Strip the wrapper before judging the
   content, but only the wrapper — quotes inside the sentence are the user's. */
function unwrap (text) {
  let out = squash(text)
  out = out.replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/, '')
  const quoted = /^(["'“”'])([\s\S]*)\1$/.exec(out)
  if (quoted) out = squash(quoted[2])
  return out
}

const WORDS = text => squash(text).split(' ').filter(Boolean).length

/**
 * Decide whether a cleanup reply is safe to use.
 *
 * The failure that matters is not a bad rewrite, it is a *plausible* one: a
 * summary, an answer to the question the user dictated, or a refusal, any of
 * which would silently replace what they said. So the reply has to stay close
 * to the original's length — cleanup removes a few words, it does not halve or
 * double the text — and anything that reads like commentary is discarded.
 *
 * @param {string} original the transcript as spoken
 * @param {string} reply    whatever the model returned
 * @returns {{text: string, used: boolean, reason?: string}}
 *   `text` is always safe to show: the reply if it passed, the original if not.
 */
export function acceptCleanup (original, reply) {
  const before = squash(original)
  const after = unwrap(reply)
  const keep = reason => ({ text: before, used: false, reason })

  if (!after) return keep('empty')
  if (after === before) return { text: before, used: false, reason: 'unchanged' }
  // A model explaining itself instead of answering.
  if (/^(here('s| is)|sure|okay|of course|i (can|cannot|can't))\b/i.test(after)) return keep('preamble')
  if (after.includes('```')) return keep('markup')

  const words = WORDS(after)
  const originalWords = WORDS(before)
  // Below ~4 words the ratio is meaningless — dropping one 'um' from 'um yes'
  // is a 50% cut and perfectly correct — so short text is only length-capped.
  if (originalWords >= 4 && words < originalWords * 0.5) return keep('too short')
  if (words > originalWords * 1.5 + 2) return keep('too long')

  return { text: after, used: true }
}

/* The model does not describe the command, it picks one of the phrases the
   rule parser already understands, and that phrase is then fed back through
   `parseCommand` like anything else. Two things fall out of that: the model
   can only ever produce a command the app actually implements, and everything
   the rules know about targets and counts — 'the last three words' — keeps
   working without a second, weaker implementation of it living here. */

/**
 * @param {string} text      the unrecognised utterance
 * @param {string[]} phrases the example phrases the parser understands
 */
export function buildCommandMessage (text, phrases) {
  const list = (Array.isArray(phrases) ? phrases : []).filter(Boolean)
  return [
    'A dictation app heard the line at the bottom as a command but did not',
    'recognise it. Which of these does the speaker mean? Reply with only the',
    'matching line, copied exactly, or the word none.',
    '',
    ...list,
    '',
    `Heard: ${String(text == null ? '' : text)}`
  ].join('\n')
}

/**
 * Pull a known phrase out of a model reply, or null.
 *
 * Whitelisted against the phrases actually passed in, so an invented command
 * can never reach the applier — the worst a bad reply can do is nothing.
 */
export function parseCommandReply (reply, phrases) {
  const list = (Array.isArray(phrases) ? phrases : []).filter(Boolean)
  const byKey = new Map(list.map(p => [squash(p).toLowerCase(), p]))
  const raw = unwrap(reply)
  if (!raw) return null

  const direct = byKey.get(raw.toLowerCase().replace(/[.!]$/, ''))
  if (direct) return direct

  // Chattier replies quote the phrase inside a sentence. Longest first, so
  // 'delete the last sentence' wins over 'delete that'.
  const key = raw.toLowerCase()
  let best = null
  for (const [candidate, phrase] of byKey) {
    if (key.includes(candidate) && (!best || candidate.length > best[0].length)) {
      best = [candidate, phrase]
    }
  }
  return best ? best[1] : null
}

/* Saying what just happened is the third job, and the smallest: the applier
   already produces an English message, but it is written to be read on the
   strip — quoted operands, exact counts — and read aloud that is a mouthful.
   The model's only task here is to shorten it. It cannot invent an outcome,
   because the outcome is what it is being handed. */

export const SPEAK_PROMPT = [
  'Say this confirmation out loud in as few words as possible. Four words at',
  'most. Keep the same meaning, drop the quoted text, no punctuation beyond a',
  'final period. Output only the spoken words.'
].join(' ')

export function buildSpeakMessage (message) {
  return `${SPEAK_PROMPT}\n\n${String(message == null ? '' : message)}`
}

/** Words a model reaches for when it is talking about the task rather than
    doing it. Any of them means the reply is commentary, not a confirmation. */
const SPEAK_PREAMBLE = /^(here('s| is)|sure|okay|of course|the (spoken|shortened)|i (can|cannot|can't|would))\b/i

/**
 * Decide whether a spoken rephrasing is safe to say.
 *
 * Weaker consequences than `acceptCleanup` — a bad line here is a wrong four
 * words out of the speakers, not the user's own text overwritten — so the bar
 * is only that it is short, plain, and one line. Anything else falls back to
 * the message the applier wrote, which is always sayable.
 *
 * @param {string} fallback the applier's own message
 * @param {string} reply    whatever the model returned
 * @returns {{text: string, used: boolean, reason?: string}}
 */
export function acceptSpoken (fallback, reply) {
  const before = squash(fallback)
  const after = unwrap(reply)
  const keep = reason => ({ text: before, used: false, reason })

  if (!after) return keep('empty')
  if (after === before) return keep('unchanged')
  if (SPEAK_PREAMBLE.test(after)) return keep('preamble')
  if (after.includes('```')) return keep('markup')
  // Terse was the whole instruction. A model that ignored it once is not to be
  // trusted with the next four words either.
  if (WORDS(after) > 6) return keep('too long')
  if (after.length > 48) return keep('too long')

  return { text: after, used: true }
}
