// Editing rules for the glossary panel. Pure: no DOM, no IPC — the panel calls
// these to work out what the next glossary should be, then hands the result to
// the main process to persist.
//
// Every operation returns `{ ok, terms|corrections, error }` rather than
// throwing, because every one of these failures is something the user typed
// and needs to be told about, not an exception.

function squash (text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
}

const key = text => squash(text).toLowerCase()

/**
 * Split a typed or pasted field into terms. Commas and newlines both separate,
 * so pasting a list works as well as typing one word.
 *
 * @param {string} raw
 * @returns {string[]}
 */
export function parseTermInput (raw) {
  return String(raw == null ? '' : raw)
    .split(/[,\n]/)
    .map(squash)
    .filter(Boolean)
}

/**
 * @param {string[]} terms
 * @param {string} raw one term, or several separated by commas / newlines
 */
export function addTerms (terms, raw) {
  const existing = Array.isArray(terms) ? terms.slice() : []
  const seen = new Set(existing.map(key))
  const incoming = parseTermInput(raw)
  if (!incoming.length) return { ok: false, terms: existing, error: 'nothing to add' }

  const added = []
  const duplicates = []
  for (const term of incoming) {
    if (seen.has(key(term))) { duplicates.push(term); continue }
    seen.add(key(term))
    existing.push(term)
    added.push(term)
  }
  if (!added.length) {
    return { ok: false, terms: existing, error: `already listed: ${duplicates.join(', ')}` }
  }
  return { ok: true, terms: existing, added }
}

export function removeTerm (terms, term) {
  const list = Array.isArray(terms) ? terms : []
  const target = key(term)
  return { ok: true, terms: list.filter(t => key(t) !== target) }
}

/**
 * @param {Record<string,string>} corrections
 * @param {string} from what Whisper hears
 * @param {string} to what it should have written
 */
export function addCorrection (corrections, from, to) {
  const base = { ...(corrections || {}) }
  const heard = squash(from)
  const write = squash(to)
  if (!heard || !write) {
    return { ok: false, corrections: base, error: 'both sides are required' }
  }
  if (key(heard) === key(write)) {
    return { ok: false, corrections: base, error: 'those are the same word' }
  }
  // Case-insensitive at match time, so two keys differing only in case would be
  // one rule with an arbitrary winner. Replace the old spelling instead.
  const clash = Object.keys(base).find(k => key(k) === key(heard))
  if (clash !== undefined) delete base[clash]
  base[heard] = write
  return { ok: true, corrections: base, replaced: clash !== undefined }
}

export function removeCorrection (corrections, from) {
  const base = { ...(corrections || {}) }
  const target = key(from)
  for (const k of Object.keys(base)) {
    if (key(k) === target) delete base[k]
  }
  return { ok: true, corrections: base }
}

/* Words, plus the gaps between them. Internal apostrophes and hyphens stay
   inside the word ("don't", "voice-to-text") so clicking one offers the whole
   thing, but a trailing one belongs to the punctuation, not the word. */
const WORD = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu

/**
 * Split text into clickable words and the untouched text between them.
 *
 * @param {string} text
 * @returns {Array<{text: string, word: boolean}>}
 */
export function splitWords (text) {
  const src = String(text == null ? '' : text)
  const out = []
  let last = 0
  for (const m of src.matchAll(WORD)) {
    if (m.index > last) out.push({ text: src.slice(last, m.index), word: false })
    out.push({ text: m[0], word: true })
    last = m.index + m[0].length
  }
  if (last < src.length) out.push({ text: src.slice(last), word: false })
  return out
}

/** Entries in display order: alphabetical by what was heard. */
export function sortedEntries (corrections) {
  return Object.entries(corrections || {})
    .sort((a, b) => key(a[0]).localeCompare(key(b[0])))
}
