// Changing a setting by saying so: "turn off spoken replies", "set the fade to
// ten seconds", "what's the threshold".
//
// The rules are generated from the settings schema rather than written out a
// second time. Every field already declares its type, its bounds, its step and
// its unit, and now the names you would call it out loud; that is enough to
// parse a sentence about it, clamp the result and say what happened. A setting
// added to the schema with a `spoken` name is reachable by voice the same day,
// with no rule to write and no list to keep in sync.
//
// Pure, like commands.js and wake.js: text and schema in, a decision out. The
// values that cannot be resolved without asking the machine something — which
// voices are installed — come back named rather than resolved, and the caller
// finishes the job.

const NUMBER_WORDS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90
}

// Spoken units, mapped to the unit the schema stores the value in.
const UNITS = {
  second: 's', seconds: 's', sec: 's', secs: 's',
  millisecond: 'ms', milliseconds: 'ms', ms: 'ms', millis: 'ms',
  minute: 'min', minutes: 'min',
  pixel: 'px', pixels: 'px', px: 'px',
  wpm: 'wpm', 'words-per-minute': 'wpm',
  percent: '%'
}

// Below this, an unqualified number on a millisecond setting is being said in
// seconds. Nobody asks for a six-millisecond fade, and "set the fade to six"
// is how a person says it.
const SECONDS_IF_UNDER = 60

const ON = new Set(['on', 'enabled', 'true', 'yes'])
const OFF = new Set(['off', 'disabled', 'false', 'no'])

// The period is the odd one out: it ends a sentence, but it is also the point
// in "0.03", so only the ones not sitting in front of a digit come out.
const PUNCTUATION = /["'“”‘’,!?;:()[\]{}]|\.(?!\d)/g

/** Lowercase, unpunctuated, single-spaced — the form every rule matches. */
export function normalize (text) {
  if (typeof text !== 'string') return ''
  return text
    .toLowerCase()
    .replace(/[–—]/g, ' ')
    .replace(PUNCTUATION, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/* ------------------------------------------------------------------ *
 * numbers
 * ------------------------------------------------------------------ */

/** "two hundred and fifty" -> 250. Returns null on the first word that is not
    part of a number, so the caller can tell where the number ended. */
function wordsToNumber (tokens) {
  let total = 0
  let current = 0
  let seen = false

  for (const token of tokens) {
    if (token === 'and' && seen) continue
    // "a thousand" is one thousand; on its own, "a" is not a number.
    if (token === 'a' || token === 'an') { current = current || 1; seen = true; continue }
    if (token === 'hundred') {
      if (!seen) return null
      if (current === 0) current = 1
      current = (current || 1) * 100
      seen = true
      continue
    }
    if (token === 'thousand') {
      if (!seen) return null
      total += (current || 1) * 1000
      current = 0
      seen = true
      continue
    }
    const n = NUMBER_WORDS[token]
    if (n === undefined) return null
    /* "twenty five" is one number and so is "two hundred and fifty"; "five
       five" is two. A tens word is only allowed on top of a round hundred —
       units on top of tens are fine, which is the n < 20 case. */
    if (seen && n >= 20 && current % 100 !== 0) return null
    current += n
    seen = true
  }
  return seen ? total + current : null
}

/**
 * The number at the front of `text`, however it was said.
 *
 * Whisper writes numbers both ways depending on how they were spoken and how
 * much context it had — "0.03" and "zero point zero three" are the same
 * request — so both have to parse, decimals included.
 *
 * @param {string} text
 * @returns {{value: number, unit: string|null, rest: string}|null}
 */
export function spokenNumber (text) {
  const tokens = normalize(text).split(' ').filter(Boolean)
  if (!tokens.length) return null

  let value = null
  let used = 0

  // Digits, with or without a decimal point: "0.03", "6", "1.5".
  if (/^-?\d+(\.\d+)?$/.test(tokens[0])) {
    value = Number(tokens[0])
    used = 1
  } else {
    // Words, optionally with a spoken decimal: "zero point zero three".
    const point = tokens.indexOf('point')
    const head = point >= 0 ? tokens.slice(0, point) : tokens
    let whole = null
    let take = 0
    for (let n = Math.min(head.length, 4); n > 0; n--) {
      const got = wordsToNumber(head.slice(0, n))
      if (got !== null) { whole = got; take = n; break }
    }
    // "point five" with nothing in front is 0.5.
    if (whole === null && point === 0) { whole = 0; take = 0 }
    if (whole === null) return null

    value = whole
    used = take

    if (point === take) {
      // Digits after the point are read one at a time: 0, 3 -> ".03".
      let decimals = ''
      let i = point + 1
      for (; i < tokens.length; i++) {
        const digit = /^\d$/.test(tokens[i]) ? Number(tokens[i]) : NUMBER_WORDS[tokens[i]]
        if (digit === undefined || digit > 9) break
        decimals += String(digit)
      }
      if (!decimals) return null
      value = Number(`${whole}.${decimals}`)
      used = i
    }
  }

  if (!Number.isFinite(value)) return null

  let unit = null
  if (UNITS[tokens[used]]) { unit = UNITS[tokens[used]]; used += 1 }
  // "words per minute", said in full.
  else if (tokens.slice(used, used + 3).join(' ') === 'words per minute') {
    unit = 'wpm'
    used += 3
  }

  return { value, unit, rest: tokens.slice(used).join(' ') }
}

/* ------------------------------------------------------------------ *
 * matching a setting
 * ------------------------------------------------------------------ */

/** Aliases are written the way you say them ("the threshold"), and heard both
    ways, so the article is optional on both sides. */
const bare = alias => alias.replace(/^(the|a|an) /, '')

/** Every spoken name of every reachable field, longest first so "the quiet
    frame rate" is not swallowed by "the frame rate". */
export function spokenAliases (fields) {
  const out = []
  for (const field of Array.isArray(fields) ? fields : []) {
    for (const alias of field.spoken || []) {
      out.push({ field, alias: normalize(alias), bare: bare(normalize(alias)) })
    }
  }
  return out.sort((a, b) => b.bare.length - a.bare.length)
}

/** The field named at position `at` in `text`, and where its name ends. */
function fieldAt (aliases, text, at = 0) {
  const from = text.slice(at)
  for (const entry of aliases) {
    for (const name of [entry.alias, entry.bare]) {
      if (from === name) return { field: entry.field, end: text.length }
      if (from.startsWith(`${name} `)) {
        return { field: entry.field, end: at + name.length }
      }
    }
  }
  return null
}

/* ------------------------------------------------------------------ *
 * parsing
 * ------------------------------------------------------------------ */

/* "what is the setting for when text disappears" is the same question as
   "what is the fade", asked by someone who does not know what it is called —
   which is exactly who asks. The scaffolding comes off before matching. */
const SETTING_FOR = [
  /\bthe (?:setting|option|preference) (?:for|that controls) /,
  /\bthe (?:setting|option|preference) /
]

const TURN_ON = /^(?:turn|switch) (on|off) (.+)$/
const TURN_AROUND = /^(?:turn|switch) (.+) (on|off)$/
const ENABLE = /^(enable|disable|stop|start) (.+)$/
const SET = /^(?:set|make|change|put) (.+?) (?:to|at) (.+)$/
const RAISE = /^(raise|increase|lower|decrease|reduce|turn up|turn down|speed up|slow down) (.+)$/
const QUERY = /^(?:what(?:'?s| is| are)?|how much is|how many is) (.+)$/
const IS_ON = /^(?:is|are) (.+?) (on|off|enabled|disabled)$/

const UP = new Set(['raise', 'increase', 'turn up', 'speed up'])

/**
 * One utterance, read as a request about a setting.
 *
 * Strict on purpose: the verb and the setting's own name have to be adjacent,
 * so "turn off the lights" and "raise the issue with him" find no field and
 * fall through to being dictation, which is what they are. The alias is the
 * whole guard — this runs on every wake-phrase utterance, and a loose match
 * here would start eating ordinary speech.
 *
 * @param {string} utterance
 * @param {object[]} fields the schema's fields; only ones with `spoken` count
 * @returns {{action: 'setting', key: string, op: string, value?: *, up?: boolean}|null}
 */
export function parseSettingCommand (utterance, fields) {
  const text = SETTING_FOR.reduce((t, re) => t.replace(re, ''), normalize(utterance))
  if (!text) return null
  const aliases = spokenAliases(fields)
  if (!aliases.length) return null

  const found = (field, op, extra = {}) =>
    ({ action: 'setting', key: field.key, op, ...extra })

  // "turn off spoken replies"
  let m = TURN_ON.exec(text)
  if (m) {
    const hit = fieldAt(aliases, m[2])
    if (hit && hit.end === m[2].length && hit.field.type === 'toggle') {
      return found(hit.field, 'set', { value: m[1] === 'on' })
    }
    return null
  }

  // "turn spoken replies off" — the same sentence, the other way round
  m = TURN_AROUND.exec(text)
  if (m) {
    const hit = fieldAt(aliases, m[1])
    if (hit && hit.end === m[1].length && hit.field.type === 'toggle') {
      return found(hit.field, 'set', { value: m[2] === 'on' })
    }
    return null
  }

  // "enable cleanup" / "stop talking back"
  m = ENABLE.exec(text)
  if (m) {
    const hit = fieldAt(aliases, m[2])
    if (hit && hit.end === m[2].length && hit.field.type === 'toggle') {
      return found(hit.field, 'set', { value: m[1] === 'enable' || m[1] === 'start' })
    }
    return null
  }

  // "spoken replies off" — the name, then the state
  m = /^(.+) (on|off|enabled|disabled)$/.exec(text)
  if (m) {
    const hit = fieldAt(aliases, m[1])
    if (hit && hit.end === m[1].length && hit.field.type === 'toggle') {
      return found(hit.field, 'set', { value: ON.has(m[2]) })
    }
  }

  // "set the fade to ten seconds" / "the voice to Karen"
  m = SET.exec(text) || /^(.+?) to (.+)$/.exec(text)
  if (m) {
    const hit = fieldAt(aliases, m[1])
    if (hit && hit.end === m[1].length) {
      const field = hit.field
      if (field.type === 'toggle') {
        if (ON.has(m[2]) || OFF.has(m[2])) return found(field, 'set', { value: ON.has(m[2]) })
        return null
      }
      if (field.type === 'range') {
        const num = spokenNumber(m[2])
        if (!num || num.rest) return null
        return found(field, 'set', { value: num.value, unit: num.unit })
      }
      // A select's values are the machine's, not the schema's: hand the words
      // back for the caller to match against what is actually installed.
      return found(field, 'set', { value: sliceOriginal(utterance, m[2]), resolve: field.options })
    }
    return null
  }

  // "make the voice Karen" — a select whose value is a name, said without a
  // "to". Only ever a select: on a slider or a toggle this shape is ordinary
  // speech ("set the threshold high" is not a number).
  m = /^(?:set|make|change) (.+)$/.exec(text)
  if (m) {
    const hit = fieldAt(aliases, m[1])
    if (hit && hit.end < m[1].length && hit.field.type === 'select' && hit.field.spoken) {
      const rest = m[1].slice(hit.end).trim()
      if (rest) {
        return found(hit.field, 'set', {
          value: sliceOriginal(utterance, rest),
          resolve: hit.field.options
        })
      }
    }
  }

  // "raise the threshold" / "slow down"
  m = RAISE.exec(text)
  if (m) {
    const hit = fieldAt(aliases, m[2])
    if (hit && hit.end === m[2].length && hit.field.type === 'range') {
      const up = UP.has(m[1])
      return found(hit.field, 'adjust', { up })
    }
    return null
  }

  // "the threshold up"
  m = /^(.+) (up|down|higher|lower|faster|slower)$/.exec(text)
  if (m) {
    const hit = fieldAt(aliases, m[1])
    if (hit && hit.end === m[1].length && hit.field.type === 'range') {
      return found(hit.field, 'adjust', { up: m[2] === 'up' || m[2] === 'higher' || m[2] === 'faster' })
    }
  }

  // "is cleanup on"
  m = IS_ON.exec(text)
  if (m) {
    const hit = fieldAt(aliases, m[1])
    if (hit && hit.end === m[1].length) return found(hit.field, 'get')
  }

  // "what's the threshold"
  m = QUERY.exec(text)
  if (m) {
    const hit = fieldAt(aliases, m[1])
    if (hit && hit.end === m[1].length) return found(hit.field, 'get')
  }

  return null
}

/* The normalized text is lowercased, which is wrong for a voice name: macOS
   wants "Karen", not "karen". Find the same words in the original. */
function sliceOriginal (utterance, normalized) {
  const source = String(utterance == null ? '' : utterance)
  const words = normalized.split(' ').filter(Boolean).length
  const all = source.match(/\S+/g) || []
  const slice = all.slice(Math.max(0, all.length - words)).join(' ')
  return slice.replace(PUNCTUATION, '').trim() || normalized
}

/* ------------------------------------------------------------------ *
 * applying
 * ------------------------------------------------------------------ */

/**
 * A value as it should be *heard*, which is not always as it is shown.
 *
 * The panel writes `10000ms` because that is the number in the file. Said out
 * loud it is "ten seconds", and a reply nobody can parse in their head is not
 * a reply. Everything else falls back to the panel's own wording, so the two
 * never disagree about anything but the units.
 */
export function spokenValue (field, value) {
  if (field.type === 'toggle') return value ? 'on' : 'off'
  const n = Number(value)
  if (field.type === 'range' && Number.isFinite(n)) {
    if (n === 0 && field.zero) return field.zero
    if (field.unit === 'ms') {
      if (n < 1000) return `${n} milliseconds`
      const secs = Number((n / 1000).toFixed(1))
      return `${secs} ${secs === 1 ? 'second' : 'seconds'}`
    }
    if (field.decimals != null) return n.toFixed(field.decimals)
    return String(n)
  }
  return value == null || value === '' ? 'unset' : String(value)
}

const toMs = (value, unit) => {
  if (unit === 's') return value * 1000
  if (unit === 'min') return value * 60000
  return value
}

/**
 * How far one "raise it a bit" moves a slider.
 *
 * A quarter of where it currently sits, rounded to a step it can actually land
 * on — relative rather than absolute, because these ranges are wide and a
 * tenth of the *range* is a lurch at the bottom of one: a tenth of the fade's
 * range is six seconds, which from a six-second fade is all of it. A setting
 * sitting at zero has nothing to take a quarter of, so that one falls back to
 * the range.
 */
export function nudgeFor (field, current = 0) {
  const step = field.step > 0 ? field.step : 1
  const relative = Math.abs(Number(current) || 0) / 4
  const raw = relative > 0 ? relative : (field.max - field.min) / 10
  return Math.max(step, Math.round(raw / step) * step)
}

// Floating point: 0.02 + 0.008 is 0.028000000000000004, and that is what would
// be written to the file and read back out loud.
const tidy = (value, step) => {
  const places = String(step).includes('.') ? String(step).split('.')[1].length : 0
  return Number(value.toFixed(places))
}

/**
 * What a parsed setting command actually does, given where the setting sits.
 *
 * Clamped to the field's own bounds rather than trusted: "set the frame rate
 * to a thousand" is a request the schema already has an answer for.
 *
 * @param {object} cmd     from parseSettingCommand
 * @param {object} field   the schema field it named
 * @param {*} current      the value the setting holds now
 * @returns {{key: string, value: *, changed: boolean, message: string}}
 *   `value` is absent for a query. `message` is written to be both read and
 *   said, because it is.
 */
export function applySettingCommand (cmd, field, current) {
  const say = value => spokenValue(field, value)
  const name = (field.spoken && field.spoken[0]) || field.label.toLowerCase()
  const nothing = message => ({ key: field.key, changed: false, message })

  if (!cmd || cmd.key !== field.key) return nothing('no setting')

  if (cmd.op === 'get') {
    return nothing(`${name} is ${say(current)}`)
  }

  if (field.type === 'toggle') {
    const value = cmd.op === 'toggle' ? !current : !!cmd.value
    if (value === !!current) return nothing(`${name} already ${say(value)}`)
    return { key: field.key, value, changed: true, message: `${name} ${say(value)}` }
  }

  if (field.type === 'range') {
    let next
    if (cmd.op === 'adjust') {
      // Nudging a setting that is currently "off" — a rate of zero means the
      // voice's own pace — starts from where it would actually be, not from
      // the zero, or "faster" would land on 40 words a minute.
      const from = Number(current) === 0 && field.zero && field.base != null
        ? field.base
        : Number(current)
      next = from + (cmd.up ? 1 : -1) * nudgeFor(field, from)
    } else {
      next = cmd.value
      // A millisecond setting said as a bare small number was said in seconds.
      if (field.unit === 'ms') {
        next = cmd.unit ? toMs(next, cmd.unit) : (next <= SECONDS_IF_UNDER ? next * 1000 : next)
      }
    }
    next = tidy(Math.min(field.max, Math.max(field.min, next)), field.step)
    if (next === Number(current)) return nothing(`${name} already ${say(next)}`)
    return {
      key: field.key,
      value: next,
      changed: true,
      message: `${name} ${say(next)}${field.restart ? ' — on restart' : ''}`
    }
  }

  // select / text: the value arrives already resolved by the caller.
  const value = cmd.value
  if (value == null || value === '') return nothing(`${name} unchanged`)
  return { key: field.key, value, changed: true, message: `${name} ${say(value)}` }
}

/**
 * One example per reachable setting, for the assist model's phrase list.
 *
 * The model picks a line from this list and it goes back through the parser,
 * exactly like the editing commands do — so "make it stop talking to me" can
 * land on "turn off spoken replies" without a rule for that phrasing, and a
 * wrong answer can still only ever produce a command that exists.
 */
export function settingPhrases (fields) {
  const out = []
  for (const field of Array.isArray(fields) ? fields : []) {
    const alias = field.spoken && field.spoken[0]
    if (!alias) continue
    if (field.type === 'toggle') {
      out.push(`turn on ${alias}`, `turn off ${alias}`)
    } else if (field.type === 'range') {
      out.push(`raise ${alias}`, `lower ${alias}`)
    }
    out.push(`what is ${alias}`)
  }
  return out
}
