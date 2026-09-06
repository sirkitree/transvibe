// Voice "command mode": turn one transcribed utterance into a structured
// command and apply it to the running transcript.
//
// This module is deliberately pure — no DOM, no Electron, no I/O — so it can be
// reasoned about and unit tested in isolation. Its one import is another pure
// module, shared with the main process because both ends have to agree on what
// a spoken Space name means.

import { matchSpaces, spokenList } from '../shared/spaces.js'

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

  glossary: { action: 'glossary' },
  'open glossary': { action: 'glossary' },
  'show glossary': { action: 'glossary' },
  'open the glossary': { action: 'glossary' },
  'glossary panel': { action: 'glossary' },
  'open the word list': { action: 'glossary' },

  help: { action: 'help' },
  'open help': { action: 'help' },
  'show help': { action: 'help' },
  'what can you do': { action: 'help' },
  'what can i say': { action: 'help' },
  'show the commands': { action: 'help' },
  'show me the commands': { action: 'help' },
  'keys and commands': { action: 'help' },

  /* The other half of "hide". Said to a strip that is not on screen — the
     microphone is still listening, the window is only invisible — so it is
     worth having a way back that is not the keyboard. */
  show: { action: 'show' },
  'show yourself': { action: 'show' },
  'come back': { action: 'show' },
  'show the strip': { action: 'show' },

  'reveal the model folder': { action: 'revealModels' },
  'reveal model folder': { action: 'revealModels' },
  'show the model folder': { action: 'revealModels' },
  'where are the models': { action: 'revealModels' },

  /* Deliberately not the bare word. Everything else here is undoable or
     reopenable and this is neither: a "quit" heard inside a sentence takes the
     app away mid-dictation, and the transcript with it. The full phrase is
     what nobody says by accident. */
  'quit transvibe': { action: 'quit' },
  'quit the app': { action: 'quit' },

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

const SWITCH_RE = /^(?:switch|jump|go|take me|move) (?:over )?to (.+)$/

// The ways of saying "someone else should answer this". Every one of them puts
// the name straight after the verb, so what follows the capture is a name
// first and the question, if there is one, second.
/* Two shapes, because there are two ways to say it and only one of them was
   here. "ask codex about X" names the agent as the thing you are addressing;
   "use codex to look that up" names it as the thing that should do the work,
   and that second shape is what people actually reach for when the small model
   has just got something wrong — "use Claude or Codex to look that up,
   please", said to a model that then invented having done so. Both put the
   name straight after the verb, which is what the anchor depends on. */
const ESCALATE_RE = new RegExp('^(?:' + [
  'ask',
  'check with',
  'run (?:that|this|it) (?:past|by)',
  'get (?:a |another )?(?:second )?opinion (?:from|of)',
  // "use codex to research X", "have claude look that up", "get codex to check"
  '(?:use|have|get|try)',
  'look (?:that|this|it) up (?:with|on|using)',
  '(?:search|check) (?:that|this|it)? ?(?:with|on|using)'
].join('|') + ') (.+)$')

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
    // "erase the conversation" is a wipe like "erase all", aimed at the
    // thread; "erase the answer" stays unparsed — there is no single answer
    // to take out of a thread the way a word comes out of a sentence.
    build: (m, raw) => targeted('delete')(m, raw) ||
      (parseChatTarget(m[1]) === 'conversation'
        ? command('delete', { target: 'conversation', raw })
        : null)
  },
  {
    /* Switching desktops. The name has to resolve against the markers that
       actually exist — without that check "go to the store" is a command, and
       a dictated sentence that takes your screen away is the worst false
       positive in here. */
    re: SWITCH_RE,
    build: (m, raw, { spaces } = {}) => {
      /* More than one name is one command, not a chain: with two displays
         there are two current desktops, and "switch to home and
         communications" moves each of them. A chain would be tried anyway if
         this returns null, which is what makes "switch to home and send it"
         still work. */
      const found = matchSpaces(m[1], spaces)
      return found
        ? command('space', { args: { spaces: found, name: spokenList(found) }, raw })
        : null
    }
  },
  {
    /* Handing the question to a frontier model. Same guard as the Space
       matcher above, for the same reason: "ask <name>" is only a command when
       the name is a remote agent that is actually on the roster, so "ask Sarah
       about the invoice" stays a sentence. The name has to come first — "I
       need to ask Claude about this later" never reaches this anchor. */
    re: ESCALATE_RE,
    build: (m, raw, { remotes } = {}) => {
      const hit = matchRemote(m[1], remotes)
      if (!hit) return null
      const { target, question } = askTail(hit.tail, remotes)
      return command('escalate', {
        target,
        args: { to: hit.agent.name, question, target },
        raw
      })
    }
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

// The other thing on the strip: what a chat agent said. Only the whole-
// transcript verbs take these, because "delete the answer" has no sensible
// meaning for an editing rule and would otherwise parse into one.
//   answer        the last thing the agent said
//   conversation  the whole thread, both sides
function parseChatTarget(phrase) {
  // "the current conversation", "this whole chat": the qualifiers are all
  // pointing at the one thread there is, so they are dropped, however many.
  const p = (phrase || '').trim()
    .replace(/^(?:(?:the|that|this|its|her|his|their|our|last|latest|current|whole|entire) )+/, '')
    .trim()
  if (p === 'answer' || p === 'reply' || p === 'response') return 'answer'
  if (p === 'conversation' || p === 'chat' || p === 'thread') return 'conversation'
  return null
}

/* A spoken name, flattened enough that "S.D.S.U." and "sd su" are the same
   string. Punctuation is whisper's guess, never the user's. */
function flatName (s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

/* One name against the remote agents there are. The provider words are
   accepted as names in their own right because that is what people say: the
   agent may be called Mira, but you ask *Claude*, and there is no ambiguity
   while a roster holds at most one agent per provider. */
function findRemote (name, remotes) {
  const want = flatName(name)
  if (!want) return null
  const list = Array.isArray(remotes) ? remotes.filter(Boolean) : []
  return list.find(a => flatName(a.name) === want) ||
    list.find(a => flatName(a.provider) === want) ||
    null
}

/* Split "claude what a VAD is" into the agent and the rest. Longest name
   first, so an agent called "big claude" wins over the provider word inside
   its own name. Three words is the whole search: past that a name is not
   something anyone says to start a sentence. */
function matchRemote (phrase, remotes) {
  const words = splitWords(phrase)
  for (let n = Math.min(3, words.length); n >= 1; n--) {
    const agent = findRemote(words.slice(0, n).join(' '), remotes)
    if (agent) return { agent, tail: words.slice(n).join(' ') }
  }
  return null
}

/* What is left after the name. Three shapes: nothing at all ("ask claude"),
   a referent ("about this", "about the answer"), or the question itself
   ("what a VAD is"). "about" and "to" are dropped because they belong to the
   asking, not to the question — "ask codex to check that" is asking for
   "check that". Anything that is not a referent is the question, and
   everything is asked in the context of the thread, so the target falls back
   to the conversation rather than to nothing. */
/**
 * What is left after the name, as a target or a question.
 *
 * @param {string} tail
 * @param {object[]} remotes so a second name offered as an alternative can be
 *   dropped rather than read as the question. "Use Claude or Codex to look
 *   that up" means either will do; without this the first one is asked the
 *   question "or Codex to look that up".
 */
function askTail (tail, remotes) {
  let rest = String(tail || '').trim()
  const alternative = /^(?:or|and) (.+)$/.exec(rest)
  if (alternative) {
    const other = matchRemote(alternative[1], remotes)
    if (other) rest = other.tail
  }

  const p = rest
    .replace(/^(?:about|regarding|on) /, '')
    .replace(/^to /, '')
    .trim()
  if (!p) return { target: 'conversation', question: '' }
  const chat = parseChatTarget(p)
  if (chat) return { target: chat, question: '' }
  // parseChatTarget eats these as qualifiers and comes back with nothing;
  // said on their own they are the thread.
  if (/^(?:this|that|it)$/.test(p)) return { target: 'conversation', question: '' }
  return { target: 'conversation', question: p }
}

// copy/clear always act on the whole transcript, but the phrase still has to
// look like a target so dictation does not trigger them.
function wholeTranscript(action) {
  return (m, raw) => {
    const t = parseTarget(m[1])
    if (t) return command(action, { target: 'all', raw })
    const chat = parseChatTarget(m[1])
    if (chat) return command(action, { target: chat, raw })
    return null
  }
}

/**
 * @param {string} utterance
 * @param {{spaces?: Array<{name: string, key: string}>,
 *          remotes?: Array<{name: string, provider: string}>}} [options] the
 *   marker apps on this machine, so a Space can be named out loud, and the
 *   agents that can be escalated to, so one can be asked for by name. Either
 *   absent means there are none, and "switch to X" / "ask X" are left as
 *   dictation.
 */
/**
 * Does this sentence want to go somewhere?
 *
 * Only the verb, not the name — the caller uses it to go and find out what is
 * running before parsing, because the list of apps you could switch to is
 * different every time you look at it. A sentence that passes this may still
 * be dictation; that is decided by whether the name resolves.
 */
export function looksLikeSwitch (utterance) {
  return SWITCH_RE.test(normalize(utterance))
}

export function parseCommand(utterance, options = {}) {
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
    if (m) return matcher.build(m, utterance, options)
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
  if (action === 'glossary') return unchanged('glossary', 'glossary')
  if (action === 'help') return unchanged('help', 'help')
  if (action === 'show') return unchanged('here', 'show')
  if (action === 'revealModels') return unchanged('model folder', 'revealModels')
  if (action === 'quit') return unchanged('goodbye', 'quit')
  if (action === 'stopTalking') return unchanged('hushed', 'stopTalking')
  // Switching desktops has nothing to do with the transcript, and least of all
  // with whether there is one.
  if (action === 'space') {
    return unchanged(`switched to ${(cmd.args && cmd.args.name) || 'that space'}`, 'space')
  }
  if (action === 'closePanel') return unchanged('closed', 'closePanel')
  /* Escalation is the one command whose answer is not ready when it returns.
     Spawning a CLI takes seconds — 2.7 measured for claude, 14 for codex with
     web search — and none of that can happen in a pure module, so what comes
     back is the effect and the arguments, and the renderer goes and does it.
     The transcript is untouched; this is a question, not an edit, and it is
     asked whether or not there is anything on the strip, because by the time
     you say it the thing you are asking about is usually the agent's answer
     rather than your own words. */
  if (action === 'escalate') {
    return unchanged(`asking ${(cmd.args && cmd.args.to) || 'the other model'}`, 'escalate')
  }

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
 *
 * Escalation is in here for the opposite reason to the rest: not that it
 * survives being said to a chat agent, but that it has no other home. "Ask
 * Claude about that" is only ever said in the middle of a conversation that
 * has just gone wrong.
 */
export const UNIVERSAL = new Set([
  'stopTalking', 'pause', 'resume', 'hide', 'show', 'closePanel', 'settings',
  'agents', 'glossary', 'help', 'revealModels', 'quit', 'escalate'
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
    /* Past tense said a moment early, the same as "copied" and "sent": the
       desktop is about to change and a line spoken after it is a line about a
       desktop you have already left. */
    case 'space': return `switched to ${(cmd.args && cmd.args.name) || 'that space'}`
    /* Present tense, alone in here, because alone in here it has not happened
       yet: this is said into the silence while the CLI runs, and it is the
       only thing telling you the silence is on purpose. */
    case 'escalate': return `asking ${(cmd.args && cmd.args.to) || 'the other model'}`
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
    examples: ['copy that', 'copy all', 'copy the answer', 'copy the conversation'],
    help: 'Copy the transcript to the clipboard — or what a chat agent said, by asking for the answer or the conversation.'
  },
  {
    action: 'send',
    examples: ['send that', 'send it', 'send the answer', 'ship it'],
    help: 'Paste the transcript into whatever app is in front. "Send the answer" pastes what the agent said instead.'
  },
  {
    action: 'clear',
    examples: ['clear all', 'clear everything', 'clear the conversation', 'start over'],
    help: 'Empty the transcript, and end any conversation, and start again.'
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
    action: 'glossary',
    examples: ['open glossary', 'show glossary', 'glossary'],
    help: 'Open the glossary — the words to listen for, and the fixes for what it still gets wrong. Your agents’ names belong in there: a name misheard is a sentence that never reaches the agent.'
  },
  {
    action: 'help',
    examples: ['show help', 'what can i say', 'what can you do'],
    help: 'Open this list.'
  },
  {
    action: 'show',
    examples: ['show yourself', 'come back'],
    help: 'Bring the strip back after “hide”. It is still listening while it is hidden, which is what makes saying this work at all.'
  },
  {
    action: 'revealModels',
    examples: ['reveal the model folder', 'where are the models'],
    help: 'Open the folder holding the whisper model that is actually loaded, in Finder.'
  },
  {
    action: 'quit',
    examples: ['quit transvibe', 'quit the app'],
    help: 'Quit. The whole phrase is required — “quit” on its own is a word people say, and this is the one command with nothing to undo it.'
  },
  {
    action: 'space',
    examples: ['switch to home', 'go to home', 'jump to home', 'take me to home'],
    help: 'Jump to a desktop Space or an app that is running. The Space names are the marker apps in the folder set under Sending; the app names are whatever is open right now. A name that is neither is left as dictation.'
  },
  {
    action: 'escalate',
    examples: [
      'ask claude',
      'ask claude about this',
      'ask claude about the answer',
      'ask claude what a VAD is',
      'ask codex to check that',
      'check with claude',
      'run that past claude',
      'get a second opinion from claude'
    ],
    help: 'Put the question to a frontier model instead — Claude or Codex, run as the CLI you are already signed in to, so it bills against your subscription. Only the named agent and the thread it is in are sent; dictation never leaves the machine. The name has to be an agent on the roster, so "ask Sarah about the invoice" is left as dictation.'
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
