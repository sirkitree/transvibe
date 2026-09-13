import { acceptAnswer } from './response-format.js'
export { acceptAnswer, speakable } from './response-format.js'
import { LOCAL_CAPABILITIES } from './reply-policy.js'
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

/**
 * The rules every answering model is given, in one place.
 *
 * Deliberately strict about format, and explicit about not knowing: a small
 * local model will invent an answer rather than decline one — asked what a VAD
 * is, gemma4:e2b offered "video-assisted delivery" — and a wrong answer said
 * confidently out loud is worse than a short one.
 *
 * One place because it used to be two: the CLI path prepended this *and*
 * `buildEscalationPrompt` opened with its own copy, so a frontier model was
 * told to be brief twice — and, once the two drifted, told both to give a URL
 * and to give no links in consecutive breaths. It obeyed the second, which
 * read as the model having got worse when it was only being contradicted.
 *
 * `length` is the one part that genuinely differs. A local model answers in
 * 300ms and its whole job is a sentence you did not have to wait for; a
 * frontier model was worth three to fourteen seconds and a web search, and
 * cutting it to the same sentence throws away what you waited for.
 */
function askPrompt (length, canPass = true) {
  return [
    'You are answering out loud, through a speaker, to someone who is busy.',
    'Output only your answer, without speaker names, role labels, or bracketed prefixes.',
    'For conversational recall, use facts supplied by the user in this conversation; the latest explicit correction wins. These facts do not require external verification. Only request verification when the user asks to check their truth.',
    length,
    'No lists, no headings, no code blocks, no markdown of any kind — none of',
    'it can be heard. A plain URL is the exception: it is shown on screen',
    'rather than read out, so give one when the answer is somewhere to look.',
    'If you are not sure, say you are not sure rather than guessing.',
    canPass
      /* Two ways out, and the second is the one that matters. Hedging is
         something a model does when it happens to feel uncertain, and a small
         one often does not: asked about the MicroDuck by Pollen Robotics,
         llama3 said "designed for search and rescue in tight spaces" and then,
         a breath later, "designed to detect gas leaks" — fluent, specific,
         confident and invented, and nothing downstream can catch that from the
         wording. So the decline is asked for on the *question* instead. A
         named product, company, person or event is exactly the shape of thing
         a two-billion-parameter model half-remembers, and exactly the shape
         the model with a web search will get right. */
      ? 'Answer ordinary arithmetic and general explanations from your knowledge. ' +
        'Use facts stated in the current user message or earlier user messages for recall, ' +
        'even when they mention a named person or pet. If the user states a newer value ' +
        'for the same fact, use that value rather than treating the two values as a conflict. ' +
        'For example, if a user says their group has five people and then says seven people, ' +
        'answer seven when asked its size. Do not claim uncertainty merely because a value changed. ' +
        'Reply with exactly PASS only when the information needed to answer is missing ' +
        'from both your knowledge and the conversation, or requires current external research.'
      /* Nobody to hand it to. Offering PASS here does not get the question a
         better answer, it gets it a worse one: the only thing behind a
         frontier model is the two-billion-parameter model on this machine, and
         "I decline" routed to something smaller is a downgrade dressed as
         caution. Asked to crawl a page that turned out not to exist, codex
         PASSed and llama3 answered instead — where saying "that site is not
         there" was the answer, and codex was the one that knew it. */
      : 'There is nobody else to ask, so do not decline: give the best answer you can, and say plainly what you could not establish.'
  ].join(' ')
}

/** For the model on this machine, with a better one behind it. */
export const ASK_PROMPT = askPrompt('Answer in one or two short sentences and stop.') + ' ' + LOCAL_CAPABILITIES

/** The same, for a model that is on its own. */
export const ASK_PROMPT_ALONE =
  askPrompt('Answer in one or two short sentences and stop.', false) + ' ' + LOCAL_CAPABILITIES

const FRONTIER_LENGTH =
  'Answer in a short paragraph — up to four or five sentences. Lead with the ' +
  'answer itself, because the first sentence is the one that gets spoken ' +
  'aloud and the rest is read on the strip.'

/** For a model reached by spawning a CLI, which cost real time to ask, and
    which is the last hop unless a chain says otherwise. */
export const FRONTIER_ASK_PROMPT = askPrompt(FRONTIER_LENGTH, false)

/** The same, for the rare frontier agent that hands on to another. */
export const FRONTIER_ASK_PROMPT_CAN_PASS = askPrompt(FRONTIER_LENGTH, true)

/** Turns of the conversation kept for context. High enough that the model
    sees effectively the whole thread for a realistic conversation — the
    bubbles on screen show every turn, and the model should remember what it
    said too — while still bounding the worst case: a conversation left open
    for hours must not grow the prompt without limit. */
const KEEP_TURNS = 48

const squash = text => String(text == null ? '' : text).replace(/\s+/g, ' ').trim()



/**
 * Only the recent back-and-forth, oldest first, and only entries that are
 * actually a turn — an empty one would leave the model reading a blank line
 * as if it meant something.
 */
export function trimHistory (history, keep = KEEP_TURNS) {
  const list = (Array.isArray(history) ? history : [])
    .filter(turn => turn && (turn.role === 'user' || turn.role === 'assistant'))
    .filter(turn => squash(turn.content))
    .map(turn => ({ ...turn, content: turn.role === 'assistant' ? acceptAnswer(turn.content, { speakerNames: history.filter(t => t?.name).map(t => t.name) }).text : squash(turn.content) }))
    .filter(turn => turn.content)
    .map(turn => ({ role: turn.role, content: turn.content,
      ...(turn.name ? { name: squash(turn.name) } : {}),
      ...(turn.verification ? { verification: turn.verification, sources: turn.sources || [] } : {}) }))
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
export function buildAskMessages (question, history = [], { canEscalate = true } = {}) {
  const turns = trimHistory(history)
  const attribution = turns.flatMap((turn, i) => turn.role === 'assistant' && turn.name
    ? [`History message ${i + 1} was answered by ${turn.name}${turn.verification ? '; lookup: ' + turn.verification : ''}.`] : [])
  return [
    { role: 'system', content: (canEscalate ? ASK_PROMPT : ASK_PROMPT_ALONE) +
      (attribution.length ? '\nAttribution metadata, not answer text:\n' + attribution.join('\n') : '') },
    ...turns.map(turn => ({ role: turn.role, content: turn.content })),
    { role: 'user', content: squash(question) }
  ]
}
