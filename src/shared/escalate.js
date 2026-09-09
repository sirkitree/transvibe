/**
 * When the small local model is out of its depth, and who to ask instead.
 *
 * A chat agent answers from a model running on this machine, which is what
 * makes it private and what makes it fast. It is also what makes it wrong: a
 * two-billion-parameter model has no clock, no network, and a hazy memory of
 * things it half read. Asked what a VAD is it will offer "video-assisted
 * delivery"; asked what happened this week it will answer confidently about a
 * week two years ago.
 *
 * So there is a second, slower route — a frontier model reached by spawning a
 * CLI the user is already signed in to — and this module is the part that
 * decides when to take it. Deciding badly is expensive in both directions: a
 * missed escalation says something false out loud, and a needless one spends
 * three to fourteen seconds of silence on a question the local model had
 * already answered correctly. The rules below are therefore ordered by how
 * much they can be trusted, and every one of them is written to prefer the
 * false negative:
 *
 *   pass       the model was asked to say PASS when it cannot answer, and did.
 *              An admission is worth more than any guess about one.
 *   failed     nothing came back at all — Ollama down, a timeout, an empty
 *              reply. There is no answer to prefer, so the cost is only time.
 *   unsure     hedging, caught by phrase. The weakest signal and the one most
 *              likely to fire on a perfectly good answer, so it is only
 *              counted where a hedge means the whole answer is a hedge.
 *   fresh      asked before the local model is ever bothered, for questions
 *              that turn on today's facts. Nothing local can answer those, so
 *              the round trip is pure latency.
 *
 * Pure. This module decides; spawning is somebody else's problem.
 */

import { trimHistory } from './conversation.js'

/* The exact token the answering model is asked to reply with when it cannot
   answer. Short, unmistakable, and unlikely to be a whole answer by accident —
   the matching side lives in conversation.js acceptAnswer, which is what turns
   it into `reason: 'pass'` before this module ever sees it. */
export const PASS_SENTINEL = 'PASS'

const squash = text => String(text == null ? '' : text).replace(/\s+/g, ' ').trim()

const WORDS = text => squash(text).split(' ').filter(Boolean).length

/* ------------------------------------------------------------------ *
 * hedging
 * ------------------------------------------------------------------ */

/* Phrases a model reaches for when it is declining rather than answering.
   Deliberately literal: an approximation of "sounds uncertain" would catch
   "probably", "roughly" and "about ten" — all of which appear in answers that
   are correct and worth hearing. */
const HEDGES = [
  /\bi (?:do not|don't) know\b/,
  /\bi(?:'m| am) not (?:sure|certain)\b/,
  /\bi(?:'m| am) not entirely (?:sure|certain)\b/,
  /\bnot (?:sure|certain) (?:about|what|which|who|how|if|whether)\b/,
  /\bi (?:can't|cannot|can not) help (?:with|you with)\b/,
  /\bi (?:do not|don't) have access\b/,
  /\bi (?:cannot|can't|can not|am unable to|'m unable to) (?:browse|access the internet|search the web)\b/,
  /\bas an ai\b/,
  /\bmy training data\b/,
  /\btraining (?:data|cut-?off)\b/,
  /\bi have no information\b/,
  /\bi (?:do not|don't) have (?:any )?information\b/
]

/* Reasons that mean the model answered with nothing, as opposed to never
   having been reached. acceptAnswer's own wording, plus the plain word. */
const SILENCE = new Set(['empty', 'nothing came back'])

/* Short enough that a hedge anywhere in it is the whole answer. Sixty words is
   the cap on what gets spoken at all (conversation.js MAX_WORDS), so this is
   comfortably under half of one spoken reply. */
const SHORT_ANSWER_WORDS = 25

/* How far into a long answer a hedge still means the model is declining.
   "First sentence" is not enough on its own: the case this exists for —
   "The capital is Paris, though I'm not sure about the population" — is a
   single sentence, and a comma is where an answer turns into a caveat about
   itself. A dozen words is about as long as a decline gets before it stops
   being one. */
const LEAD_WORDS = 12

/**
 * Does this answer amount to the model saying it does not know?
 *
 * The failure to avoid is the answer that hedges *about something else*:
 * "The capital is Paris, though I'm not sure about the population" answered
 * the question and then added a caveat, and throwing it away to spend eight
 * seconds re-asking a frontier model would be a poor trade. So a hedge only
 * counts at the top of the answer — where it is the model declining before it
 * has said anything — or anywhere in an answer short enough to be nothing but
 * the hedge.
 *
 * @param {string} text the answer as it would be spoken
 */
export function saysUnsure (text) {
  const answer = squash(text).toLowerCase()
  if (!answer) return false

  const scope = WORDS(answer) <= SHORT_ANSWER_WORDS
    ? answer
    : (answer.match(/^[^.!?]*[.!?]?/) || [answer])[0]
        .split(' ').slice(0, LEAD_WORDS).join(' ')

  return HEDGES.some(pattern => pattern.test(scope))
}

/* ------------------------------------------------------------------ *
 * questions with a date on them
 * ------------------------------------------------------------------ */

/* Asking about now. A model with no clock cannot answer any of these, however
   large it is, so the only useful route is one with web search. */
const NOW = /\b(?:today|tonight|yesterday|this (?:week|month|year|morning|evening)|right now|at the moment|currently|so far this year|as of (?:today|now|this))\b/

/* Asking about something that changes. Each of these is a whole phrase rather
   than a keyword, because the keywords on their own are everywhere: "news"
   without "the news" is "good news, it compiled", and "price" without "the
   price of" is "the price you pay for that is a slower build". */
const CHANGING = [
  /\b(?:the )?(?:latest|breaking|recent) news\b/,
  /\bin the news\b/,
  /\bheadlines?\b/,
  /\bwho won\b/,
  /\bwho(?:'s| is) winning\b/,
  /\bthe (?:score|standings|results)\b/,
  /\b(?:stock|share|market) price\b/,
  /\bthe price of\b/,
  /\bhow much (?:does|do|is|are) .{0,40}\b(?:cost|costs|going for)\b/,
  /\bexchange rate\b/,
  /\bthe weather\b/,
  /\b(?:the )?forecast\b/,
  /\brelease date\b/,
  /\bwhen (?:does|do|is|will) .{0,40}\b(?:come out|released|ship|launch)\b/,
  /\bwhat(?:'s| is) new in\b/
]

/* "the latest X" is only a freshness question for some X. "What's the latest
   version of Node" is; "what's the latest you can arrive" and "what's the
   latest on that bug I mentioned" are not — one is a time of day and the other
   is about this conversation. Rather than guess at the grammar, the noun is
   named: a short allowlist misses some real freshness questions, and missing
   one only costs the local model's ordinary attempt at it. */
const NEWEST = /\b(?:latest|newest|most recent|current)\s+(?:stable\s+|available\s+|official\s+)?(versions?|releases?|updates?|prices?|scores?|results?|models?|episodes?|headlines?|standings?|rates?|figures?|numbers?|developments?)\b/

/**
 * Should this question skip the local model entirely?
 *
 * Called before anything is asked, so a wrong `true` spends a slow remote call
 * on a question that would have been answered locally in half a second. That
 * asymmetry is why every pattern above is a phrase and not a word.
 *
 * @param {string} question what was said after the agent's name
 */
export function needsFreshFacts (question) {
  const asked = squash(question).toLowerCase()
  if (!asked) return false
  if (NEWEST.test(asked)) return true
  if (CHANGING.some(pattern => pattern.test(asked))) return true
  return NOW.test(asked)
}

/* ------------------------------------------------------------------ *
 * the decision
 * ------------------------------------------------------------------ */

/**
 * Given what the local model produced, is it worth asking somebody better?
 *
 * Takes the result of `acceptAnswer` as it is, so the caller does not have to
 * remember which failures mean which thing.
 *
 * @param {{ok?: boolean, text?: string, reason?: string}} answer
 * @returns {{escalate: boolean, why: 'pass'|'unsure'|'failed'|'empty'|null}}
 */
export function shouldEscalate (answer = {}) {
  const { ok, text, reason } = answer && typeof answer === 'object' ? answer : {}
  const said = squash(text)

  if (reason === 'pass') return { escalate: true, why: 'pass' }
  /* Nothing to say, and two ways to get there: the model replied with nothing,
     or there was never a model to reply — a timeout, a refused connection. The
     answer is the same but the why is worth keeping apart, because one of them
     is a machine that needs starting and the panel should be able to say so. */
  if (!said) return { escalate: true, why: ok === false && reason && !SILENCE.has(reason) ? 'failed' : 'empty' }
  if (ok === false) return { escalate: true, why: 'failed' }
  if (saysUnsure(said)) return { escalate: true, why: 'unsure' }

  return { escalate: false, why: null }
}

/* ------------------------------------------------------------------ *
 * was it worth it
 * ------------------------------------------------------------------ */

/* Words that survive the length filter below without saying anything about
   what an answer is about. Short on purpose: four letters already removes
   "the", "is" and "a", and every word added here is one that two disagreeing
   answers are allowed to have in common. */
const EMPTY_WORDS = new Set([
  'about', 'after', 'also', 'been', 'before', 'being', 'both', 'from', 'have',
  'here', 'into', 'just', 'like', 'more', 'most', 'much', 'only', 'other',
  'over', 'same', 'some', 'such', 'than', 'that', 'their', 'them', 'then',
  'there', 'these', 'they', 'this', 'those', 'through', 'very', 'were',
  'what', 'when', 'where', 'which', 'while', 'with', 'would', 'your'
])

/* What an answer is about, with everything two answers to the same question
   would share anyway taken out. */
const contentWords = text => new Set(
  squash(text).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter(word => word.length >= 4 && !EMPTY_WORDS.has(word)))

/* How much of the shorter answer has to appear in the longer one. Half is
   coarse, and deliberately so: this is asked about two answers to the same
   question, where the failure it looks for is a different answer and not a
   differently worded one. */
const AGREEMENT = 0.5

/**
 * Did the better model say the same thing as the smaller one?
 *
 * Never user-facing and never part of a decision — by the time this can be
 * asked, the answer has already been chosen and spoken. What it measures is
 * whether an escalation *bought* anything, which is how a rule above earns
 * its place or gets narrowed: a rule that fires often and then hears the same
 * answer back is spending eight seconds to confirm something the local model
 * already had right.
 *
 * Containment rather than Jaccard, because the two answers are not the same
 * length and are not meant to be. "Paris" and "The capital of France is
 * Paris" agree; a measure that divides by the union calls them different and
 * would make every terse local answer look like a miss.
 *
 * Three-valued on purpose. "Yes", "about ten" and "it depends" carry no
 * content words at all, and a guess about those would put noise into the only
 * numbers there are. Undecidable is a real answer here, and the counters skip
 * it rather than rounding it to one side.
 *
 * @returns {boolean|null} null when there is not enough in either to compare
 */
export function answersAgree (a, b) {
  const one = contentWords(a)
  const two = contentWords(b)
  if (!one.size || !two.size) return null

  let shared = 0
  for (const word of one) if (two.has(word)) shared += 1
  return shared / Math.min(one.size, two.size) >= AGREEMENT
}

/* ------------------------------------------------------------------ *
 * asking the bigger model
 * ------------------------------------------------------------------ */

/* One flat string, because a CLI takes a prompt and not a messages array. The
   order of the paragraphs is the whole trick: shown a wrong answer and asked
   to check it, a model agrees with it — so it is told to answer first, and
   only then given the earlier attempt to judge. The earlier answer is included
   at all because the spoken reply is better when it can say "actually, no". */
export function buildEscalationPrompt (question, priorAnswer, history = []) {
  const asked = squash(question)
  const prior = squash(priorAnswer)
  const turns = trimHistory(history, 8)

  /* No framing here. It belongs in the slot each CLI gives for it — claude's
     --system-prompt, codex's prepended line — and saying it in both places is
     how the two copies came to disagree: this one forbade links while the
     other asked for one, and the model did as the nearer of the two said. One
     prompt, one set of rules, in conversation.js. */
  const lines = []

  if (turns.length) {
    lines.push(
      '',
      'The conversation so far, for context only:',
      ...turns.map(turn => `${turn.role === 'user' ? 'Them' : 'You'}: ${turn.content}`)
    )
  }

  // No leading blank when there was no context above it to be separated from.
  if (lines.length) lines.push('')
  lines.push(`The question: ${asked}`)

  if (prior) {
    lines.push(
      '',
      'Work out your own answer first, without reading the next line. Then, and',
      'only then, compare it with what a smaller model already replied. If that',
      'reply was right, just answer the question. If it was wrong, say so',
      'briefly and give the correct answer.',
      '',
      `The smaller model replied: ${prior}`
    )
  }

  return lines.join('\n')
}

/**
 * The spoken line, with whoever said it on the front.
 *
 * Only for speech. On screen the bubble already carries the name and the
 * agent's colour, and hearing "Claude said" while reading "Claude" above it is
 * the sort of duplication that makes an app feel like it is talking to itself.
 */
export function attribute (name, text) {
  const said = squash(text)
  if (!said) return ''
  const who = squash(name)
  if (!who) return said
  if (new RegExp(`^${who.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+said\\b`, 'i').test(said)) return said
  return `${who} said, ${said}`
}

/* ------------------------------------------------------------------ *
 * who escalates to whom
 * ------------------------------------------------------------------ */

/* Two hops. A chain that long is already fifteen seconds of a room being
   quiet, and the second model is not usually wrong in a way a third one fixes
   — it is wrong in a way nobody can fix from the question as asked. */
const MAX_HOPS = 2

/**
 * The agents to try, in order, after this one has failed.
 *
 * Does not include the agent it starts from. A name that is not on the roster
 * ends the chain rather than throwing: an `escalateTo` pointing at an agent
 * somebody has since deleted is a stale setting, not a crash.
 *
 * Cycles end it too, and they are not hypothetical — two chat agents pointed
 * at each other is the obvious thing to type when you want them to compare
 * notes, and it must terminate instead of spinning.
 */
export function escalationChain (roster, agent) {
  const list = (Array.isArray(roster) ? roster : []).filter(a => a && typeof a === 'object')
  const start = agent && typeof agent === 'object' ? agent : null
  if (!start) return []

  const find = name => list.find(a =>
    squash(a.name).toLowerCase() === squash(name).toLowerCase()) || null

  const seen = new Set([squash(start.name).toLowerCase()])
  const chain = []
  let at = start

  while (chain.length < MAX_HOPS) {
    const nextName = squash(at.escalateTo)
    if (!nextName) break

    const key = nextName.toLowerCase()
    if (seen.has(key)) break
    seen.add(key)

    const next = find(nextName)
    if (!next) break
    // Only something that answers questions can be escalated to. An agent that
    // runs commands would parse the question as an edit and do it.
    if (next.kind !== 'chat' && !next.provider) break

    chain.push(next)
    at = next
  }

  return chain
}
