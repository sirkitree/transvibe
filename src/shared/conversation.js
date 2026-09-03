/**
 * Talking to a model instead of at the app.
 *
 * A `chat` agent is the other thing a name can mean. Address it and the
 * sentence is not parsed at all — it is a question, and the answer comes back
 * out loud in that agent's own voice.
 *
 * Two constraints shape everything here, and both come from the answer being
 * *spoken* rather than read:
 *
 *   it has to be short.  The microphone is deaf for as long as the speakers
 *                        are busy, so a paragraph is not a verbose answer, it
 *                        is half a minute of not being able to say anything.
 *   it has to be plain.  Nobody can hear a bullet list, a code fence or a
 *                        heading. Those are for a page.
 *
 * Pure: messages in, a checked answer out. Nothing here talks to a socket.
 */

/* Deliberately strict about length and format, and explicit about not knowing.
   A small local model will invent an answer rather than decline one — asked
   what a VAD is, gemma4:e2b offered "video-assisted delivery" — and a wrong
   answer said confidently out loud is worse than a short one. */
export const ASK_PROMPT = [
  'You are answering out loud, through a speaker, to someone who is busy.',
  'Answer in one or two short sentences and stop. No lists, no headings, no',
  'code blocks, no markdown of any kind — none of it can be heard. If you are',
  'not sure, say you are not sure rather than guessing.'
].join(' ')

/** Turns of the conversation kept for context. Enough to follow a thread —
    "and how far is that from London" — without the prompt growing all day. */
const KEEP_TURNS = 6

const squash = text => String(text == null ? '' : text).replace(/\s+/g, ' ').trim()

const WORDS = text => squash(text).split(' ').filter(Boolean).length

/**
 * Only the recent back-and-forth, oldest first, and only entries that are
 * actually a turn — an empty one would leave the model reading a blank line
 * as if it meant something.
 */
export function trimHistory (history, keep = KEEP_TURNS) {
  const list = (Array.isArray(history) ? history : [])
    .filter(turn => turn && (turn.role === 'user' || turn.role === 'assistant'))
    .filter(turn => squash(turn.content))
    .map(turn => ({ role: turn.role, content: squash(turn.content) }))
  const max = Number.isFinite(keep) && keep > 0 ? Math.floor(keep) : KEEP_TURNS
  return list.slice(-max)
}

/**
 * The messages array for one question, in the shape the OpenAI-compatible
 * endpoint wants.
 *
 * @param {string} question what was said after the name
 * @param {Array<{role: string, content: string}>} history earlier turns
 */
export function buildAskMessages (question, history = []) {
  return [
    { role: 'system', content: ASK_PROMPT },
    ...trimHistory(history),
    { role: 'user', content: squash(question) }
  ]
}

/* Markdown a model reaches for even when told not to. Stripped rather than
   rejected — the sentence underneath is usually fine, and refusing an answer
   over a stray asterisk would mean answering nothing most of the time. */
function unformat (text) {
  return squash(
    String(text == null ? '' : text)
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s*[-*+]\s+/gm, '')
      .replace(/^\s*\d+[.)]\s+/gm, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/_{1,2}([^_]+)_{1,2}/g, '$1')
  )
}

/** Roughly two spoken sentences. Past this the answer stops being a reply and
    starts being a lecture the microphone has to sit through. */
const MAX_WORDS = 60

/**
 * Decide whether an answer is safe to say out loud.
 *
 * The guards are about shape, not about truth — nothing here can tell whether
 * the model was right, which is why the prompt asks it to admit uncertainty
 * and why the panel lets you point a chat agent at a better model.
 *
 * @param {string} reply
 * @returns {{text: string, ok: boolean, reason?: string}}
 */
export function acceptAnswer (reply) {
  const text = unformat(reply)
  if (!text) return { text: '', ok: false, reason: 'nothing came back' }

  const words = WORDS(text)
  if (words <= MAX_WORDS) return { text, ok: true }

  /* Too long to say, but it did answer. The first couple of sentences are
     almost always the answer and the rest is the model elaborating, so it is
     cut there rather than thrown away. */
  const sentences = text.match(/[^.!?]+[.!?]+|\S[^.!?]*$/g) || [text]
  let out = ''
  for (const sentence of sentences) {
    const next = squash(`${out} ${sentence}`)
    if (out && WORDS(next) > MAX_WORDS) break
    out = next
  }
  return { text: out || text, ok: true, reason: 'shortened' }
}
