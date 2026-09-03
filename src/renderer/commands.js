// Voice "command mode": turn one transcribed utterance into a structured
// command and apply it to the running transcript.
//
// This module is deliberately pure — no DOM, no Electron, no I/O, no imports —
// so it can be reasoned about and unit tested in isolation.

const NUMBER_WORDS = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20
}

// Words that end in a period without ending a sentence. Single letters
// (initials, "e.g.", "i.e.") are handled separately.
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'approx',
  'inc', 'ltd', 'co', 'corp', 'dept', 'est', 'fig', 'no', 'vol', 'al', 'min',
  'max', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct',
  'nov', 'dec'
])

const FILLERS = /^(?:uh|uhh|um|umm|erm|er|okay|ok|please|now|hey|alright|so|just|well),? (.+)$/

// Politeness that whisper tacks onto the end of a spoken command.
const TRAILING_FILLERS = /^(.+?),? (?:please|thanks|thank you|now|okay|ok)$/

// A "replace X with Y" whose X starts with one of these is almost certainly
// dictation ("replace the washer with a new one"), not an edit command.
const VAGUE_OPERANDS = new Set([
  'the', 'a', 'an', 'my', 'your', 'his', 'her', 'its', 'our', 'their',
  'this', 'that', 'these', 'those', 'it', 'them', 'some', 'any', 'every',
  'all', 'everything', 'anything', 'something'
])

// Closing quotes/brackets belong to the sentence they end.
const CLOSERS = '"\'”’»)]}'

const EDGE_PUNCTUATION = /["'“”‘’.,!?;:()\[\]{}\-–—…]/

/* ------------------------------------------------------------------ *
 * text utilities
 * ------------------------------------------------------------------ */

export function splitWords(text) {
  if (typeof text !== 'string') return []
  const words = text.match(/\S+/g)
  return words || []
}

function wordRanges(text) {
  const out = []
  const re = /\S+/g
  let m
  while ((m = re.exec(text)) !== null) {
    out.push({ start: m.index, end: m.index + m[0].length })
  }
  return out
}

function isAbbreviation(text, dotIndex) {
  let i = dotIndex - 1
  while (i >= 0 && /[a-z0-9]/i.test(text[i])) i--
  const word = text.slice(i + 1, dotIndex).toLowerCase()
  if (!word) return false
  // A lone letter is an initial ("J. R. R.") or part of "e.g." / "i.e.".
  if (word.length === 1) return true
  return ABBREVIATIONS.has(word)
}

// Sentence spans with their offsets in the source, used both by
// splitSentences and by the "last sentence" target.
function sentenceRanges(text) {
  const ranges = []
  if (typeof text !== 'string' || !text) return ranges
  let start = -1

  const push = (end) => {
    if (start < 0) return
    let s = start
    let e = end
    while (s < e && /\s/.test(text[s])) s++
    while (e > s && /\s/.test(text[e - 1])) e--
    if (e > s) ranges.push({ start: s, end: e, text: text.slice(s, e) })
    start = -1
  }

  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (/\s/.test(ch)) {
      if (ch === '\n') push(i)
      i++
      continue
    }
    if (start < 0) start = i
    if (ch === '…') {
      i++
      continue
    }
    if (ch === '.' || ch === '!' || ch === '?') {
      let j = i
      while (j < text.length && '.!?'.includes(text[j])) j++
      const run = text.slice(i, j)
      // "..." is an ellipsis, not a sentence end.
      if (/^\.{2,}$/.test(run)) {
        i = j
        continue
      }
      if (run === '.' && isAbbreviation(text, i)) {
        i = j
        continue
      }
      while (j < text.length && CLOSERS.includes(text[j])) j++
      i = j
      push(i)
      continue
    }
    i++
  }
  push(text.length)
  return ranges
}

export function splitSentences(text) {
  return sentenceRanges(text).map((r) => r.text)
}

/* ------------------------------------------------------------------ *
 * parsing
 * ------------------------------------------------------------------ */

function stripEdgePunctuation(s) {
  let start = 0
  let end = s.length
  while (start < end && EDGE_PUNCTUATION.test(s[start])) start++
  while (end > start && EDGE_PUNCTUATION.test(s[end - 1])) end--
  return s.slice(start, end)
}

function normalize(utterance) {
  if (typeof utterance !== 'string') return ''
  let s = utterance.toLowerCase().replace(/\s+/g, ' ').trim()
  s = stripEdgePunctuation(s).trim()
  // Whisper loves a leading "um" / "okay" / "please".
  for (let i = 0; i < 3; i++) {
    const m = s.match(FILLERS)
    if (!m) break
    s = m[1].trim()
  }
  for (let i = 0; i < 2; i++) {
    const m = s.match(TRAILING_FILLERS)
    if (!m) break
    s = m[1].trim()
  }
  return s
}

function toCount(token) {
  if (/^\d+$/.test(token)) {
    const n = parseInt(token, 10)
    return n > 0 ? n : null
  }
  return NUMBER_WORDS[token] || null
}

// "that" / "the last word" / "the last 3 words" / "everything" -> target shape.
// Returns null when the phrase is not a recognised target, which is how plain
// dictation ("capitalize the report before sending it") stays out of the way.
function parseTarget(phrase) {
  const p = (phrase || '').trim().replace(/^the /, '').trim()
  if (p === '' || p === 'that' || p === 'this' || p === 'it') {
    return { target: 'last-sentence', count: null }
  }
  if (
    p === 'everything' || p === 'all' || p === 'all of it' ||
    p === 'all of that' || p === 'whole thing' || p === 'transcript' ||
    p === 'entire transcript' || p === 'whole transcript'
  ) {
    return { target: 'all', count: null }
  }
  if (p === 'last word' || p === 'last one') {
    return { target: 'last-word', count: null }
  }
  if (p === 'last sentence') {
    return { target: 'last-sentence', count: null }
  }
  // "words" is optional and may lose its plural: whisper drops short words.
  const m = p.match(/^last ([a-z0-9]+)(?: words?)?$/)
  if (m) {
    const count = toCount(m[1])
    if (count) return { target: 'last-n-words', count }
  }
  return null
}

function command(action, { target = null, count = null, args = {}, raw = '' } = {}) {
  return { action, target, count, args, raw }
}

const EXACT = {
  period: { action: 'punctuate', args: { mark: '.' } },
  'full stop': { action: 'punctuate', args: { mark: '.' } },
  comma: { action: 'punctuate', args: { mark: ',' } },
  'question mark': { action: 'punctuate', args: { mark: '?' } },
  'exclamation point': { action: 'punctuate', args: { mark: '!' } },
  'exclamation mark': { action: 'punctuate', args: { mark: '!' } },
  colon: { action: 'punctuate', args: { mark: ':' } },
  semicolon: { action: 'punctuate', args: { mark: ';' } },
  'semi colon': { action: 'punctuate', args: { mark: ';' } },
  'make that a question': { action: 'punctuate', args: { mark: '?' } },
  'make that a question mark': { action: 'punctuate', args: { mark: '?' } },

  'new paragraph': { action: 'newParagraph' },
  'new line': { action: 'newParagraph' },
  newline: { action: 'newParagraph' },
  'line break': { action: 'newParagraph' },

  undo: { action: 'undo' },
  'undo that': { action: 'undo' },
  'never mind': { action: 'undo' },
  nevermind: { action: 'undo' },

  'no caps': { action: 'lowercase', target: 'last-sentence' },

  copy: { action: 'copy', target: 'all' },
  send: { action: 'send', target: 'all' },
  'send it': { action: 'send', target: 'all' },
  'ship it': { action: 'send', target: 'all' },
  clear: { action: 'clear', target: 'all' },
  'start over': { action: 'clear', target: 'all' },

  'stop talking': { action: 'stopTalking' },
  'be quiet': { action: 'stopTalking' },
  'quiet': { action: 'stopTalking' },
  'shush': { action: 'stopTalking' },
  'stop speaking': { action: 'stopTalking' },

  'stop listening': { action: 'pause' },
  'pause listening': { action: 'pause' },
  'pause transcription': { action: 'pause' },
  pause: { action: 'pause' },

  'start listening': { action: 'resume' },
  'resume listening': { action: 'resume' },
  'resume transcription': { action: 'resume' },
  resume: { action: 'resume' },

  settings: { action: 'settings' },
  'open settings': { action: 'settings' },
  'show settings': { action: 'settings' },
  'open the settings': { action: 'settings' },
  'open settings panel': { action: 'settings' },
  'settings panel': { action: 'settings' },
  'open preferences': { action: 'settings' },
  'show preferences': { action: 'settings' },

  agents: { action: 'agents' },
  'open agents': { action: 'agents' },
  'show agents': { action: 'agents' },
  'open the agents': { action: 'agents' },
  'agents panel': { action: 'agents' },

  'close settings': { action: 'closePanel' },
  'close the settings': { action: 'closePanel' },
  'close the panel': { action: 'closePanel' },
  'close panel': { action: 'closePanel' },

  hide: { action: 'hide' },
  'hide the window': { action: 'hide' },
  'hide window': { action: 'hide' },
  'go away': { action: 'hide' },
  dismiss: { action: 'hide' }
}

// Each matcher owns a phrasing family. A matcher that recognises the verb but
// not the target returns null on purpose: better no command than a wrong one.
const MATCHERS = [
  { re: /^replace (.+?) with (.+)$/, build: replacement },
  { re: /^change (.+?) to (.+)$/, build: replacement },
  { re: /^swap (.+?) for (.+)$/, build: replacement },
  {
    re: /^make (.+?) (all caps|caps|upper ?case|lower ?case|small)$/,
    build: (m, raw) => {
      const t = parseTarget(m[1])
      if (!t) return null
      const action = /lower|small/.test(m[2]) ? 'lowercase' : 'uppercase'
      return command(action, { target: t.target, count: t.count, raw })
    }
  },
  { re: /^capitali[sz]e ?(.*)$/, build: targeted('capitalize') },
  { re: /^upper ?case ?(.*)$/, build: targeted('uppercase') },
  { re: /^all caps ?(.*)$/, build: targeted('uppercase') },
  { re: /^shout (.+)$/, build: targeted('uppercase') },
  { re: /^lower ?case ?(.*)$/, build: targeted('lowercase') },
  {
    re: /^(?:delete|scratch|strike|erase|remove|forget) (.+)$/,
    build: targeted('delete')
  },
  { re: /^copy (.+)$/, build: wholeTranscript('copy') },
  { re: /^send (.+)$/, build: wholeTranscript('send') },
  { re: /^clear (.+)$/, build: wholeTranscript('clear') }
]

// "replace X with Y" only counts as a command when both operands look like
// literal snippets of transcript: short, and not a vague noun phrase. Anything
// looser is ordinary speech ("replace the washer with a new one").
function replacement(m, raw) {
  const from = m[1].trim()
  const to = m[2].trim()
  if (!from || !to) return null
  const fromWords = splitWords(from)
  const toWords = splitWords(to)
  if (fromWords.length > 6 || toWords.length > 6) return null
  if (VAGUE_OPERANDS.has(fromWords[0])) return null
  return command('replace', { args: { from, to }, raw })
}

function targeted(action) {
  return (m, raw) => {
    const t = parseTarget(m[1])
    if (!t) return null
    return command(action, { target: t.target, count: t.count, raw })
  }
}

// copy/clear always act on the whole transcript, but the phrase still has to
// look like a target so dictation does not trigger them.
function wholeTranscript(action) {
  return (m, raw) => {
    const t = parseTarget(m[1])
    if (!t) return null
    return command(action, { target: 'all', raw })
  }
}

export function parseCommand(utterance) {
  if (typeof utterance !== 'string') return null
  const text = normalize(utterance)
  if (!text) return null

  const exact = EXACT[text]
  if (exact) {
    return command(exact.action, {
      target: exact.target || null,
      args: exact.args || {},
      raw: utterance
    })
  }

  for (const matcher of MATCHERS) {
    const m = text.match(matcher.re)
    if (m) return matcher.build(m, utterance)
  }
  return null
}

/* ------------------------------------------------------------------ *
 * applying
 * ------------------------------------------------------------------ */

function quote(s) {
  const flat = String(s).replace(/\s+/g, ' ').trim()
  return flat.length > 40 ? `${flat.slice(0, 37)}…` : flat
}

const isWordChar = (ch) => ch !== undefined && /[a-z0-9]/i.test(ch)

// Last case-insensitive occurrence of `needle`, respecting word boundaries so
// "change a to b" does not turn "banana" into "bananb". Plain substring
// search (no regex) keeps operands like "c++" or "$1" safe.
function lastOccurrence(haystack, needle) {
  const h = haystack.toLowerCase()
  const n = needle.toLowerCase()
  if (!n) return -1
  const guardLeft = isWordChar(n[0])
  const guardRight = isWordChar(n[n.length - 1])
  let idx = h.lastIndexOf(n)
  while (idx >= 0) {
    const leftOk = !guardLeft || !isWordChar(h[idx - 1])
    const rightOk = !guardRight || !isWordChar(h[idx + n.length])
    if (leftOk && rightOk) return idx
    if (idx === 0) break
    idx = h.lastIndexOf(n, idx - 1)
  }
  return -1
}

function findRange(text, target, count) {
  if (!text.trim()) return null
  if (target === 'all') return { start: 0, end: text.length }
  if (target === 'last-word' || target === 'last-n-words') {
    const words = wordRanges(text)
    if (!words.length) return null
    const wanted = target === 'last-word' ? 1 : Math.max(1, count || 1)
    const n = Math.min(wanted, words.length)
    return { start: words[words.length - n].start, end: words[words.length - 1].end }
  }
  const sentences = sentenceRanges(text)
  if (!sentences.length) return null
  const last = sentences[sentences.length - 1]
  return { start: last.start, end: last.end }
}

function capitalizeWords(s) {
  return s.replace(/(^|\s)(\S)/g, (_, lead, ch) => lead + ch.toUpperCase())
}

function capitalizeFirst(s) {
  return s.replace(/^([^a-z0-9]*)([a-z0-9])/i, (_, lead, ch) => lead + ch.toUpperCase())
}

function capitalizeSentences(s) {
  const ranges = sentenceRanges(s)
  if (!ranges.length) return capitalizeFirst(s)
  let out = ''
  let cursor = 0
  for (const r of ranges) {
    out += s.slice(cursor, r.start) + capitalizeFirst(r.text)
    cursor = r.end
  }
  return out + s.slice(cursor)
}

export function applyCommand(cmd, text) {
  const source = typeof text === 'string' ? text : ''
  const unchanged = (message, effect = null) => ({
    text: source,
    effect,
    changed: false,
    message
  })

  if (!cmd || typeof cmd.action !== 'string') return unchanged('no command')

  const action = cmd.action
  const empty = !source.trim()

  // Actions the caller performs; they never rewrite the transcript here.
  if (action === 'undo') return unchanged('undo', 'undo')
  if (action === 'pause') return unchanged('paused listening', 'pause')
  if (action === 'resume') return unchanged('resumed listening', 'resume')
  if (action === 'hide') return unchanged('hidden', 'hide')
  // Panels are the app's own furniture: they open onto an empty transcript
  // just as happily as a full one, so they sit above the emptiness check.
  if (action === 'settings') return unchanged('settings', 'settings')
  if (action === 'agents') return unchanged('agents', 'agents')
  if (action === 'stopTalking') return unchanged('hushed', 'stopTalking')
  if (action === 'closePanel') return unchanged('closed', 'closePanel')

  if (empty) return unchanged('nothing to act on')

  if (action === 'copy') return unchanged('copied transcript', 'copy')
  if (action === 'send') return unchanged('sent transcript', 'send')
  if (action === 'clear') {
    return { text: '', effect: 'clear', changed: true, message: 'cleared transcript' }
  }

  if (action === 'punctuate') {
    const mark = (cmd.args && cmd.args.mark) || '.'
    const stripped = source.replace(/[\s.,;:!?…]+$/, '')
    if (!stripped) return unchanged('nothing to act on')
    const next = stripped + mark
    return {
      text: next,
      effect: null,
      changed: next !== source,
      message: `added "${mark}"`
    }
  }

  if (action === 'newParagraph') {
    const next = `${source.replace(/\s+$/, '')}\n\n`
    return { text: next, effect: null, changed: next !== source, message: 'new paragraph' }
  }

  if (action === 'replace') {
    const from = (cmd.args && cmd.args.from) || ''
    const to = (cmd.args && cmd.args.to) || ''
    if (!from) return unchanged('nothing to replace')
    const idx = lastOccurrence(source, from)
    if (idx < 0) return unchanged(`"${quote(from)}" not found`)
    const next = source.slice(0, idx) + to + source.slice(idx + from.length)
    return {
      text: next,
      effect: null,
      changed: next !== source,
      message: `replaced "${quote(from)}" with "${quote(to)}"`
    }
  }

  const range = findRange(source, cmd.target, cmd.count)
  if (!range) return unchanged('nothing to act on')
  const before = source.slice(0, range.start)
  const chunk = source.slice(range.start, range.end)
  const after = source.slice(range.end)

  if (action === 'delete') {
    if (cmd.target === 'all') {
      return { text: '', effect: null, changed: true, message: 'deleted everything' }
    }
    let next = before + after
    // Deleting at the end must not strand a separator: "cats, dogs" -> "cats".
    if (!after.trim()) next = before.replace(/[\s,;:]+$/, '')
    return {
      text: next,
      effect: null,
      changed: next !== source,
      message: `deleted "${quote(chunk)}"`
    }
  }

  let replaced = chunk
  let verb = ''
  if (action === 'capitalize') {
    const perWord = cmd.target === 'last-word' || cmd.target === 'last-n-words'
    replaced = perWord ? capitalizeWords(chunk) : capitalizeSentences(chunk)
    verb = 'capitalized'
  } else if (action === 'uppercase') {
    replaced = chunk.toUpperCase()
    verb = 'uppercased'
  } else if (action === 'lowercase') {
    replaced = chunk.toLowerCase()
    verb = 'lowercased'
  } else {
    return unchanged(`unknown command "${quote(action)}"`)
  }

  const next = before + replaced + after
  return {
    text: next,
    effect: null,
    changed: next !== source,
    message: `${verb} "${quote(replaced)}"`
  }
}

/**
 * Commands that work whoever you are addressing.
 *
 * A chat agent is for talking to, not for driving the app — but you have to be
 * able to interrupt it, and you should not have to switch names to close a
 * panel or stop the microphone. Everything else said to a chat agent is a
 * question, including sentences that happen to look like commands.
 */
export const UNIVERSAL = new Set([
  'stopTalking', 'pause', 'resume', 'hide', 'closePanel', 'settings', 'agents'
])

/* ------------------------------------------------------------------ *
 * chains
 * ------------------------------------------------------------------ */

// "and then" before "then" before "and", so the longest joiner wins and does
// not leave a stray "then" at the front of the next part.
const JOINERS = /\s*,\s*(?:and then|then|and)\s+|\s+(?:and then|then|and)\s+|\s*,\s+/i

// More than this in one breath is not a chain, it is a sentence that happens
// to contain the word "and".
const MAX_PARTS = 4

/**
 * One utterance, split into the commands it might be a chain of.
 *
 * Deliberately naive: "and" is a word people use inside commands too — "two
 * hundred and fifty", "replace cat and dog with pets" — so this does not try
 * to be clever about which "and" is a joiner. It offers the split, and the
 * caller only acts on it if *every* part turns out to be a real command. A
 * sentence that parses whole is never offered here at all.
 *
 * @param {string} utterance
 * @returns {string[]} the parts, or a single-element array if there is no split
 */
export function splitChain (utterance) {
  if (typeof utterance !== 'string') return []
  const parts = utterance.split(JOINERS).map(p => p.trim()).filter(Boolean)
  if (parts.length < 2 || parts.length > MAX_PARTS) return [utterance.trim()].filter(Boolean)
  return parts
}

/* ------------------------------------------------------------------ *
 * saying it out loud
 * ------------------------------------------------------------------ */

/* `message` is written to be read: it quotes the exact text that moved, which
   is what you want on the strip and exactly what you do not want in your ear —
   "deleted the cat sat on the mat" is the machine reading your own sentence
   back at you. Spoken, the useful part is the verb and the target. */

const SPOKEN_TARGETS = {
  all: 'everything',
  'last-word': 'the last word',
  'last-sentence': 'that',
  'last-n-words': null      // filled in with the count
}

const SPOKEN_VERBS = {
  delete: 'deleted',
  capitalize: 'capitalised',
  uppercase: 'uppercased',
  lowercase: 'lowercased'
}

function spokenTarget (cmd) {
  if (cmd.target === 'last-n-words') {
    const n = Math.max(1, cmd.count || 1)
    return n === 1 ? 'the last word' : `the last ${n} words`
  }
  return SPOKEN_TARGETS[cmd.target] || 'that'
}

/**
 * What to say after a command ran.
 *
 * Short on purpose, and never a quotation: this is spoken while the microphone
 * is deaf, and every extra word is time you cannot talk. Returns '' for the
 * cases not worth a sound — a command that changed nothing because it was
 * already that way.
 *
 * @param {object|null} cmd    the parsed command, or null if none was recognised
 * @param {object} result      what applyCommand returned
 * @returns {string} a line to speak, or '' for silence
 */
export function spokenFor (cmd, result) {
  if (!cmd) return 'not a command'
  if (!result) return ''

  switch (result.effect) {
    case 'undo': return 'undone'
    case 'copy': return 'copied'
    case 'send': return 'sent'
    case 'clear': return 'cleared'
    case 'pause': return 'paused'
    case 'resume': return 'listening'
    case 'hide': return 'hidden'
    case 'settings': return 'settings'
    case 'agents': return 'agents'
    // Saying "hushed" out loud would be the joke that never stops being made.
    case 'stopTalking': return ''
    case 'closePanel': return 'closed'
  }

  const verb = SPOKEN_VERBS[cmd.action]
  if (verb) {
    // A miss is worth hearing: nothing on screen changed and you need to know
    // it was not simply ignored. Uppercasing what is already uppercase is the
    // case that produces a message quoting the text back, which is exactly the
    // thing this must never say out loud.
    if (!result.changed) {
      const why = result.message || ''
      return why && !why.includes('"') ? why : 'no change'
    }
    return `${verb} ${spokenTarget(cmd)}`
  }

  if (cmd.action === 'replace') {
    return result.changed ? 'replaced' : 'not found'
  }
  if (cmd.action === 'punctuate') {
    return result.changed ? 'punctuated' : ''
  }
  if (cmd.action === 'newParagraph') return 'new paragraph'

  return result.changed ? (result.message || '') : ''
}

/* ------------------------------------------------------------------ *
 * documentation — kept in sync with the parser (tests assert this)
 * ------------------------------------------------------------------ */

export const COMMANDS = [
  {
    action: 'capitalize',
    examples: [
      'capitalize that',
      'capitalise that',
      'capitalize the last word',
      'capitalize the last sentence',
      'capitalize the last three words'
    ],
    help: 'Capitalise the last sentence, the last word, or the last N words.'
  },
  {
    action: 'uppercase',
    examples: [
      'uppercase that',
      'upper case that',
      'all caps that',
      'make that all caps',
      'shout that',
      'uppercase the last word'
    ],
    help: 'Shout it: convert the target to ALL CAPS.'
  },
  {
    action: 'lowercase',
    examples: [
      'lowercase that',
      'lower case that',
      'make that lowercase',
      'no caps',
      'lowercase the last word'
    ],
    help: 'Convert the target to lower case.'
  },
  {
    action: 'delete',
    examples: [
      'delete that',
      'scratch that',
      'strike that',
      'delete the last word',
      'delete the last three words',
      'delete the last 3 words',
      'delete the last sentence',
      'delete everything',
      'delete all'
    ],
    help: 'Remove the last sentence, the last word, the last N words, or all of it.'
  },
  {
    action: 'undo',
    examples: ['undo', 'undo that', 'never mind', 'nevermind'],
    help: 'Undo the last change.'
  },
  {
    action: 'punctuate',
    examples: [
      'period',
      'full stop',
      'comma',
      'question mark',
      'exclamation point',
      'exclamation mark',
      'colon',
      'semicolon',
      'make that a question'
    ],
    help: 'Add punctuation to the end of the transcript.'
  },
  {
    action: 'newParagraph',
    examples: ['new paragraph', 'new line', 'line break'],
    help: 'Start a new paragraph.'
  },
  {
    action: 'replace',
    examples: [
      'replace cat with dog',
      'change cat to dog',
      'swap cat for dog'
    ],
    help: 'Replace the last occurrence of one phrase with another.'
  },
  {
    action: 'copy',
    examples: ['copy that', 'copy all', 'copy everything', 'copy the transcript'],
    help: 'Copy the transcript to the clipboard.'
  },
  {
    action: 'send',
    examples: ['send that', 'send it', 'send everything', 'ship it'],
    help: 'Paste the transcript into whatever app is in front.'
  },
  {
    action: 'clear',
    examples: ['clear all', 'clear everything', 'clear the transcript', 'start over'],
    help: 'Empty the transcript and start again.'
  },
  {
    action: 'stopTalking',
    examples: ['stop talking', 'be quiet', 'shush'],
    help: 'Cut off a spoken reply. Works whoever you are addressing.'
  },
  {
    action: 'pause',
    examples: ['stop listening', 'pause listening', 'pause'],
    help: 'Stop transcribing until resumed.'
  },
  {
    action: 'resume',
    examples: ['start listening', 'resume listening', 'resume'],
    help: 'Start transcribing again.'
  },
  {
    action: 'settings',
    examples: ['open settings', 'show settings', 'settings', 'open preferences'],
    help: 'Open the settings panel — every setting is also sayable on its own.'
  },
  {
    action: 'agents',
    examples: ['open agents', 'show agents', 'agents'],
    help: 'Open the agents panel — who you can talk to, and how each one sounds.'
  },
  {
    action: 'closePanel',
    examples: ['close settings', 'close the panel'],
    help: 'Close whichever panel is open, the same as esc.'
  },
  {
    action: 'hide',
    examples: ['hide', 'hide the window', 'go away', 'dismiss'],
    help: 'Hide the transvibe window.'
  }
]
