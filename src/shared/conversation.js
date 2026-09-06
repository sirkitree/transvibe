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
      ? 'If you cannot answer this from what you know, reply with exactly PASS ' +
        'and nothing else. Reply PASS also when the question turns on a ' +
        'specific named product, company, person, place or event whose details ' +
        'you cannot vouch for — somebody who can look it up is standing by, and ' +
        'a confident guess costs more than the wait.'
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
export const ASK_PROMPT = askPrompt('Answer in one or two short sentences and stop.')

/** The same, for a model that is on its own. */
export const ASK_PROMPT_ALONE =
  askPrompt('Answer in one or two short sentences and stop.', false)

const FRONTIER_LENGTH =
  'Answer in a short paragraph — up to four or five sentences. Lead with the ' +
  'answer itself, because the first sentence is the one that gets spoken ' +
  'aloud and the rest is read on the strip.'

/** For a model reached by spawning a CLI, which cost real time to ask, and
    which is the last hop unless a chain says otherwise. */
export const FRONTIER_ASK_PROMPT = askPrompt(FRONTIER_LENGTH, false)

/** The same, for the rare frontier agent that hands on to another. */
export const FRONTIER_ASK_PROMPT_CAN_PASS = askPrompt(FRONTIER_LENGTH, true)

/* The sentinel above, matched back. Punctuation and quoting are allowed around
   it because a model asked for one bare word will still sometimes send "PASS."
   — but nothing else is, since an answer that merely contains the word has
   answered something. Paired with PASS_SENTINEL in escalate.js, which is where
   the decision it feeds lives; the constant is not imported because the two
   modules would then import each other. */
const IS_PASS = /^[\s"'“”'*_.,!?-]*pass[\s"'“”'*_.,!?-]*$/i

/** Turns of the conversation kept for context. High enough that the model
    sees effectively the whole thread for a realistic conversation — the
    bubbles on screen show every turn, and the model should remember what it
    said too — while still bounding the worst case: a conversation left open
    for hours must not grow the prompt without limit. */
const KEEP_TURNS = 48

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
export function buildAskMessages (question, history = [], { canEscalate = true } = {}) {
  return [
    { role: 'system', content: canEscalate ? ASK_PROMPT : ASK_PROMPT_ALONE },
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
      /* A link is its text and its address, and the bubble can show both —
         `[Pollen Robotics](https://…)` renders as nothing at all in a text
         node, so the markdown goes and the address is kept in parentheses
         where it can be read and copied. What cannot hear it is the speaker,
         and that is `speakable` below rather than here: one function deciding
         what you may see *and* what you may hear was the bug — an answer that
         cited a page arrived with the page removed. */
      .replace(/!?\[([^\]]*)\]\(([^)\s]*)[^)]*\)/g, (all, label, href) => {
        const name = squash(label)
        const url = squash(href)
        if (!url) return name
        return name && name !== url ? `${name} (${url})` : url
      })
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s*[-*+]\s+/gm, '')
      .replace(/^\s*\d+[.)]\s+/gm, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/_{1,2}([^_]+)_{1,2}/g, '$1')
  )
}

/**
 * The same answer, with the parts nobody can hear taken out.
 *
 * An address read aloud is forty seconds of slashes and a word you cannot
 * write down anyway, so a link keeps its label and loses its address — except
 * where the label *is* the address, which is where a bare URL was, and there
 * the host is worth saying: "on github dot com" locates it and the path does
 * not.
 *
 * Shape only. This never changes which words the model chose, so what you read
 * and what you hear are the same answer.
 *
 * @param {string} text an answer that has already been through `unformat`
 */
export function speakable (text) {
  return squash(
    String(text == null ? '' : text)
      // "Label (https://host/path)" — the form unformat leaves a link in.
      .replace(/\s*\(\s*(?:https?:\/\/|www\.)[^\s)]*\s*\)/gi, '')
      /* Only something that announced itself as an address. A pattern loose
         enough to catch "pollen-robotics.com" on its own is loose enough to
         catch "e.g" and "1.5", and rewriting either of those in the middle of
         a sentence is a worse bug than saying one hostname. */
      .replace(/\bhttps?:\/\/(?:www\.)?([^\s/)]+)\S*/gi, '$1')
      .replace(/\bwww\.([^\s/)]+)\S*/gi, '$1')
  )
}

/** Roughly two spoken sentences. Past this the answer stops being a reply and
    starts being a lecture the microphone has to sit through — the mic is deaf
    for as long as the speakers are busy, so this is a real cost and not a
    matter of taste. */
const SPOKEN_MAX_WORDS = 60

/** What the strip will hold. Far more generous, because reading is not
    listening: nothing is blocked while you read, you can stop whenever you
    like, and an answer that cost fourteen seconds and a web search should not
    be cut to the length that suits a model answering in three hundred
    milliseconds. */
const SHOWN_MAX_WORDS = 180

/** Whole sentences up to a word count, or the text itself if one sentence is
    already over it — half a sentence is worse than a long one. */
function firstWords (text, max) {
  if (WORDS(text) <= max) return text
  const sentences = text.match(/[^.!?]+[.!?]+|\S[^.!?]*$/g) || [text]
  let out = ''
  for (const sentence of sentences) {
    const next = squash(`${out} ${sentence}`)
    if (out && WORDS(next) > max) break
    out = next
  }
  return out || text
}

/**
 * Decide whether an answer is safe to say out loud.
 *
 * The guards are about shape, not about truth — nothing here can tell whether
 * the model was right, which is why the prompt asks it to admit uncertainty
 * and why the panel lets you point a chat agent at a better model.
 *
 * Two forms come back, and they are the same answer seen two ways. `text` is
 * what the bubble shows: addresses intact, up to a paragraph. `spoken` is what
 * goes to the speaker: no addresses, and cut to the couple of sentences the
 * microphone can afford to sit through. Neither ever holds a word the model
 * did not write. A failed answer has neither.
 *
 * @param {string} reply
 * @returns {{text: string, spoken?: string, ok: boolean, reason?: string}}
 */
export function acceptAnswer (reply) {
  const full = unformat(reply)
  if (!full) return { text: '', ok: false, reason: 'nothing came back' }
  /* Not a failure so much as an answer of a different kind: the model was
     asked to say this when it cannot answer, and saying so is the most useful
     thing it can do. The caller escalates rather than speaking it. */
  if (IS_PASS.test(full)) return { text: '', ok: false, reason: 'pass' }

  const text = firstWords(full, SHOWN_MAX_WORDS)
  const spoken = firstWords(speakable(text), SPOKEN_MAX_WORDS)
  return {
    text,
    spoken,
    ok: true,
    // Only worth reporting when the strip lost something too. A spoken line
    // shorter than the bubble is the ordinary case now, not an event.
    ...(text === full ? {} : { reason: 'shortened' })
  }
}
