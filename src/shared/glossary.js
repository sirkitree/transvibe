// Vocabulary bias and post-hoc corrections for names Whisper reliably mangles.
//
// Two independent levers, because neither alone is enough:
//
//   1. `buildPrompt` turns the term list into whisper.cpp's initial prompt.
//      The decoder conditions on it, so a term spelled there becomes a far
//      more likely token sequence. Cheap and it fixes the word *inside* the
//      acoustic search, but it is a nudge, not a guarantee.
//   2. `applyCorrections` rewrites known-bad spellings after the fact. Blunt
//      but certain — it catches the passes where the nudge lost.
//
// Both are pure string work; nothing here touches the filesystem or a process.

// Whisper truncates its initial prompt to the last 224 tokens. Stay well under
// that: a bloated prompt also drags the model toward reciting it verbatim.
const MAX_PROMPT_CHARS = 800

function squash (text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
}

/** Distinct, non-empty terms in the order given. */
export function normalizeTerms (vocabulary) {
  const seen = new Set()
  const out = []
  for (const raw of Array.isArray(vocabulary) ? vocabulary : []) {
    const term = squash(raw)
    if (!term) continue
    const key = term.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(term)
  }
  return out
}

/**
 * @param {string[]} vocabulary words and phrases to bias toward
 * @returns {string} initial prompt, or '' when there is nothing to bias
 */
export function buildPrompt (vocabulary) {
  const terms = normalizeTerms(vocabulary)
  if (!terms.length) return ''
  // Phrased as prose rather than a bare list: the prompt is treated as
  // preceding transcript, and a sentence keeps the model in transcript mode.
  const head = 'Glossary: '
  const kept = []
  let len = head.length
  for (const term of terms) {
    const cost = term.length + (kept.length ? 2 : 0)
    if (len + cost + 1 > MAX_PROMPT_CHARS) break
    kept.push(term)
    len += cost
  }
  return `${head}${kept.join(', ')}.`
}

function escapeRegExp (text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Match the phrase whole-word, tolerating any run of whitespace or punctuation
// where the source had a space ('trans vibe', 'trans-vibe', 'Trans Vibe').
function toPattern (phrase) {
  const body = squash(phrase)
    .split(' ')
    .map(escapeRegExp)
    .join('[\\s\\p{P}]+')
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'giu')
}

/**
 * Rewrite known mistranscriptions.
 *
 * @param {string} text
 * @param {Record<string,string>|Array<[string,string]>} corrections wrong → right
 * @returns {string}
 */
export function applyCorrections (text, corrections) {
  let out = String(text == null ? '' : text)
  if (!out) return out
  const pairs = Array.isArray(corrections) ? corrections : Object.entries(corrections || {})
  // Longest source first, so 'claude code' wins over 'claude' when both are listed.
  const ordered = pairs
    .map(([from, to]) => [squash(from), String(to == null ? '' : to)])
    .filter(([from]) => from)
    .sort((a, b) => b[0].length - a[0].length)
  for (const [from, to] of ordered) {
    out = out.replace(toPattern(from), to)
  }
  return squash(out)
}

/* Whisper's initial prompt is prepended as prior context, and over silence or
   room noise the model will happily just repeat it back — the shorter the
   glossary, the more often. A one-term glossary turns every cough into that
   term. So an utterance made of nothing but glossary words is treated the same
   way as the model's other stock hallucinations ('Thank you.', '[BLANK_AUDIO]'):
   dropped. Said inside a real sentence the term still comes through, which is
   what it was added for. */

function stripPunctuation (text) {
  return squash(String(text == null ? '' : text).replace(/[\p{P}\p{S}]+/gu, ' ')).toLowerCase()
}

/**
 * @param {string} text a finished transcript
 * @param {{vocabulary?: string[], corrections?: object}} glossary
 * @returns {boolean} the whole utterance is glossary terms and nothing else
 */
export function isGlossaryEcho (text, { vocabulary = [], corrections = {} } = {}) {
  const body = stripPunctuation(text)
  if (!body) return false

  // What the model was primed with, plus what corrections rewrite things into
  // — an echo can arrive by either road.
  const terms = normalizeTerms([
    ...(Array.isArray(vocabulary) ? vocabulary : []),
    ...Object.values(corrections || {})
  ]).map(stripPunctuation).filter(Boolean)
  if (!terms.length) return false

  // Longest first, so a two-word term is consumed before either of its halves.
  const ordered = [...terms].sort((a, b) => b.length - a.length)
  let rest = body
  while (rest) {
    const hit = ordered.find(term => rest === term || rest.startsWith(term + ' '))
    if (!hit) return false
    rest = rest.slice(hit.length).trim()
  }
  return true
}

/**
 * Bundle a settings object's glossary into the two things the engine needs.
 *
 * @param {{vocabulary?: string[], corrections?: object}} settings
 */
export function fromSettings (settings = {}) {
  return {
    prompt: buildPrompt(settings.vocabulary),
    corrections: settings.corrections || {}
  }
}
