// The spoken way into command mode: an utterance that opens with a keyword is
// a command, and the rest of the sentence is the command itself.
//
// The key path (hold right ⌥) arms command mode before you speak. This one
// decides after the fact, from the words themselves, which is what makes it
// work with no hands and with a transcript already on the strip.
//
// Pure like commands.js — no DOM, no Electron, no imports — because deciding
// what counts as the keyword is exactly the part worth testing on its own.

const PUNCTUATION = /^[\s"'“”‘’.,!?;:()\[\]{}\-–—…]+|[\s"'“”‘’.,!?;:()\[\]{}\-–—…]+$/g

// Whisper puts these in front of anything. Only skipped when the keyword does
// not match at the very start, so a keyword that IS a filler word still works.
const LEADING_FILLERS = new Set([
  'uh', 'uhh', 'um', 'umm', 'erm', 'er', 'okay', 'ok', 'so', 'well', 'now',
  'alright', 'right', 'yeah', 'and'
])

// Politeness between the keyword and the command. "hey claude, could you
// uppercase that" has to reach the parser as "uppercase that".
const BRIDGES = [
  ['i', 'want', 'you', 'to'],
  ['i', 'need', 'you', 'to'],
  ['i', 'would', 'like', 'you', 'to'],
  ['can', 'you', 'please'],
  ['could', 'you', 'please'],
  ['would', 'you', 'please'],
  ['will', 'you', 'please'],
  ['can', 'you'],
  ['could', 'you'],
  ['would', 'you'],
  ['will', 'you'],
  ['please']
]

// Only worth trying on a token long enough that a wrong letter or two still
// leaves it obviously the same word: "claud" and "cloud" are the keyword,
// "they" is not "hey". Short tokens are matched exactly.
const FUZZY_MIN_LENGTH = 5

function strip (token) {
  return token.replace(PUNCTUATION, '').toLowerCase()
}

/** Word tokens with their offsets in the source, so `rest` can be cut from the
    original text rather than rebuilt from the lowercased one. */
function tokenize (text) {
  const out = []
  const re = /\S+/g
  let m
  while ((m = re.exec(text)) !== null) {
    const word = strip(m[0])
    if (word) out.push({ word, start: m.index, end: m.index + m[0].length })
  }
  return out
}

export function phraseTokens (phrase) {
  if (typeof phrase !== 'string') return []
  return phrase.split(/\s+/).map(strip).filter(Boolean)
}

/** Levenshtein, capped: anything past `max` edits is Infinity, because how
    far past does not matter — only how close a match was, so that two names
    can be compared by it. */
function within (a, b, max) {
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > max) return Infinity
  let prev = new Array(b.length + 1)
  let cur = new Array(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i
    let best = cur[0]
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
      if (cur[j] < best) best = cur[j]
    }
    if (best > max) return Infinity
    const swap = prev; prev = cur; cur = swap
  }
  return prev[b.length] <= max ? prev[b.length] : Infinity
}

/* Two edits on a longer word, because the misses that matter are two edits
   away: whisper hears "claude" as "cloud" (a substitution and a deletion) far
   more often than it invents a near-miss. The budget only opens up when the
   phrase has another token to agree with — a one-word keyword has nothing to
   corroborate it, so it stays at one edit. */
function editBudget (wanted, phraseLength) {
  if (wanted.length < FUZZY_MIN_LENGTH) return 0
  return wanted.length >= 6 && phraseLength > 1 ? 2 : 1
}

/** @returns {number} edits away, or Infinity for "not this word" */
function tokenCost (heard, wanted, fuzzy, phraseLength) {
  if (heard === wanted) return 0
  if (!fuzzy) return Infinity
  const budget = editBudget(wanted, phraseLength)
  return budget > 0 ? within(heard, wanted, budget) : Infinity
}

/** @returns {number} edits across the whole phrase, or Infinity for no match */
function matchCost (tokens, at, wanted, fuzzy) {
  if (at + wanted.length > tokens.length) return Infinity
  let cost = 0
  for (let i = 0; i < wanted.length; i++) {
    const step = tokenCost(tokens[at + i].word, wanted[i], fuzzy, wanted.length)
    if (step === Infinity) return Infinity
    cost += step
  }
  return cost
}

function skipBridge (tokens, at) {
  for (const bridge of BRIDGES) {
    if (at + bridge.length > tokens.length) continue
    let ok = true
    for (let i = 0; i < bridge.length; i++) {
      if (tokens[at + i].word !== bridge[i]) { ok = false; break }
    }
    if (ok) return at + bridge.length
  }
  return at
}

/**
 * Does this utterance open with the wake phrase?
 *
 * The phrase has to come first — after fillers, but first — because a keyword
 * recognised anywhere would turn "I told him hey Claude was down" into a
 * command. `rest` is sliced out of the original text so casing and punctuation
 * survive for operands like "replace whisper with Whisper".
 *
 * @param {string} text a settled utterance
 * @param {{phrase?: string, fuzzy?: boolean}} options
 * @returns {{matched: boolean, rest: string}} `rest` is '' when the phrase was
 *   said on its own, which means "arm, I will say the command next"
 */
export function splitWakeWord (text, { phrase = '', fuzzy = true } = {}) {
  const source = typeof text === 'string' ? text : ''
  const miss = { matched: false, rest: source }

  const wanted = phraseTokens(phrase)
  if (!wanted.length || !source.trim()) return miss

  const tokens = tokenize(source)
  if (!tokens.length) return miss

  // Try the start first, then allow up to three fillers in front of it.
  let at = -1
  let cost = Infinity
  for (let skip = 0; skip <= 3 && skip < tokens.length; skip++) {
    const c = matchCost(tokens, skip, wanted, fuzzy)
    if (c !== Infinity) { at = skip; cost = c; break }
    if (!LEADING_FILLERS.has(tokens[skip].word)) break
  }
  if (at < 0) return miss

  const after = skipBridge(tokens, at + wanted.length)
  const rest = after < tokens.length ? source.slice(tokens[after].start).trim() : ''
  // `cost` is 0 for an exact hearing and rises with each letter that was
  // wrong. On a roster it is how one name is preferred over another.
  return { matched: true, rest, cost, words: wanted.length }
}

/* ------------------------------------------------------------------ *
 * a roster of names
 * ------------------------------------------------------------------ */

/**
 * Which agent, if any, this utterance is addressed to.
 *
 * One phrase was a yes-or-no question; several make it a choice, and a wrong
 * choice is worse than no choice — it runs the wrong thing, or answers a
 * question you asked of something else. Three rules keep that from happening:
 *
 *   exact wins over near.   Otherwise "hey claude" quietly answers to "hey
 *                           cloud", and with two names on the roster the near
 *                           miss is somebody else's name.
 *   longer wins over short. "hey miranda" is a name, not "hey mira" with a
 *                           stray word after it.
 *   a tie wins nothing.     Two names equally close to what was heard means
 *                           the app does not know who you meant, and guessing
 *                           is how you address the wrong one. It falls through
 *                           to dictation, and you say it again.
 *
 * @param {string} text a settled utterance
 * @param {object[]} roster agents, in the order they were listed
 * @param {{fuzzy?: boolean}} options
 * @returns {{matched: boolean, agent: object|null, rest: string, ambiguous?: boolean}}
 */
export function matchAgent (text, roster, { fuzzy = true } = {}) {
  const source = typeof text === 'string' ? text : ''
  const list = Array.isArray(roster) ? roster : []
  const miss = { matched: false, agent: null, rest: source }
  if (!list.length || !source.trim()) return miss

  const hits = []
  for (const agent of list) {
    const split = splitWakeWord(source, { phrase: agent.name, fuzzy })
    if (split.matched) hits.push({ agent, ...split })
  }
  if (!hits.length) return miss

  /* Closest hearing first, then the longer name. Cost before length is what
     makes exact beat near: a name heard perfectly is zero edits away and no
     amount of extra words can outrank it. */
  hits.sort((a, b) => a.cost - b.cost || b.words - a.words)
  const best = hits[0]

  // Equally close, and the same number of words: nothing here can tell them
  // apart, and neither could you from the outside. Better to hear nothing.
  const tied = hits.some(h =>
    h.agent !== best.agent && h.cost === best.cost && h.words === best.words)
  if (tied) return { ...miss, ambiguous: true }

  return { matched: true, agent: best.agent, rest: best.rest }
}
