import { sourceName } from './sources.js'
const squash = text => String(text ?? '').replace(/\s+/g, ' ').trim()
const WORDS = text => squash(text).split(' ').filter(Boolean).length
const IS_PASS = /^[\s"'“”'*_.,!?-]*pass[\s"'“”'*_.,!?-]*$/i
const DEFAULT_SPEAKERS = ['Hey Mira', 'Mira', 'Hey Codex', 'Codex', 'Hey Claude', 'Claude', 'Hey Atlas', 'Atlas', 'Assistant']

// Only remove a leading label belonging to a known speaker, not arbitrary
// bracketed text, quotations, or a name inside the answer.
export function stripSpeakerLabel (text, names = []) {
  const known = new Set([...DEFAULT_SPEAKERS, ...names].filter(Boolean).map(n => String(n).toLowerCase()))
  let out = String(text ?? '').trim()
  for (let i = 0; i < 3; i++) {
    const match = out.match(/^\[([^\];]+)(?:;[^\]]*)?\]\s*:?\s*/)
    if (!match || !known.has(match[1].trim().toLowerCase())) break
    out = out.slice(match[0].length).trim()
  }
  return out
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
      .replace(/\bhttps?:\/\/(?:www\.)?([^\s/)]+)\S*/gi, url => sourceName(url))
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

/** The two forms of one piece of text: what the strip shows, and what the
    speaker gets. Shared so there is one implementation of the lengths. */
function twoForms (full) {
  const text = firstWords(full, SHOWN_MAX_WORDS)
  return { text, spoken: firstWords(speakable(text), SPOKEN_MAX_WORDS) }
}

/**
 * The same two forms, for text that is not an answer to anything.
 *
 * A message from a coding agent has the same problem as a model's reply — it
 * is markdown, it has paths and addresses in it, and it is longer than a
 * microphone can afford to sit through — and none of `acceptAnswer`'s
 * judgements. It cannot decline, so PASS is not a sentinel in it but a word;
 * there is no speaker label to strip because nobody prefixed it; and it is
 * never rejected, because it is not a candidate for anything. It is what was
 * said, and the only question is how to show and say it.
 *
 * @param {string} text
 * @returns {{text: string, spoken: string}}
 */
export function forSpeech (text) {
  const full = unformat(text)
  return full ? twoForms(full) : { text: '', spoken: '' }
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
export function acceptAnswer (reply, { speakerNames = [] } = {}) {
  const full = stripSpeakerLabel(unformat(reply), speakerNames)
  if (!full) return { text: '', ok: false, reason: 'nothing came back' }
  /* Not a failure so much as an answer of a different kind: the model was
     asked to say this when it cannot answer, and saying so is the most useful
     thing it can do. The caller escalates rather than speaking it. */
  if (IS_PASS.test(full)) return { text: '', ok: false, reason: 'pass' }

  const { text, spoken } = twoForms(full)
  return {
    text,
    spoken,
    ok: true,
    // Only worth reporting when the strip lost something too. A spoken line
    // shorter than the bubble is the ordinary case now, not an event.
    ...(text === full ? {} : { reason: 'shortened' })
  }
}
