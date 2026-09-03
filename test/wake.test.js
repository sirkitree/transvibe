import { describe, it, expect } from 'vitest'
import { splitWakeWord, matchAgent, phraseTokens } from '../src/renderer/wake.js'
import { normalizeRoster } from '../src/shared/agents.js'
import { parseCommand } from '../src/renderer/commands.js'

const split = (text, phrase = 'hey claude', fuzzy = true) =>
  splitWakeWord(text, { phrase, fuzzy })

describe('splitWakeWord — hits', () => {
  it('takes the command from after the phrase', () => {
    expect(split('hey claude uppercase that')).toMatchObject({
      matched: true, rest: 'uppercase that'
    })
  })

  it('ignores the punctuation whisper hangs off the phrase', () => {
    expect(split('Hey, Claude! Delete the last word.')).toMatchObject({
      matched: true, rest: 'Delete the last word.'
    })
  })

  it('is not case sensitive', () => {
    expect(split('HEY CLAUDE clear everything').matched).toBe(true)
  })

  it('steps over the fillers whisper puts in front', () => {
    expect(split('um, hey claude scratch that').rest).toBe('scratch that')
    expect(split('okay so hey claude scratch that').rest).toBe('scratch that')
  })

  it('stops stepping over words that are not fillers', () => {
    expect(split('I said hey claude scratch that').matched).toBe(false)
  })

  it('steps over politeness between the phrase and the command', () => {
    expect(split('hey claude could you uppercase that').rest).toBe('uppercase that')
    expect(split('hey claude, please delete that').rest).toBe('delete that')
    expect(split('hey claude I want you to clear everything').rest)
      .toBe('clear everything')
  })

  it('keeps the original casing, for operands that need it', () => {
    expect(split('hey claude replace whisper with Whisper').rest)
      .toBe('replace whisper with Whisper')
  })

  it('reports an empty rest when the phrase was said on its own', () => {
    expect(split('hey claude')).toMatchObject({ matched: true, rest: '' })
    expect(split('Hey Claude?')).toMatchObject({ matched: true, rest: '' })
  })
})

describe('splitWakeWord — misses', () => {
  const misses = [
    'I told him hey claude was down',
    'uppercase that',
    'claude hey uppercase that',
    'hey there, capitalize that',
    'they claude uppercase that',
    'hey we should ship it'
  ]
  for (const text of misses) {
    it(`leaves "${text}" alone`, () => {
      expect(split(text)).toEqual({ matched: false, rest: text })
    })
  }

  it('is off when no phrase is configured', () => {
    expect(split('hey claude delete that', '')).toEqual({
      matched: false, rest: 'hey claude delete that'
    })
    expect(splitWakeWord('hey claude delete that')).toMatchObject({ matched: false })
  })

  it('survives the things that are not utterances', () => {
    expect(split('')).toEqual({ matched: false, rest: '' })
    expect(split('   ')).toMatchObject({ matched: false })
    expect(splitWakeWord(null, { phrase: 'hey claude' })).toEqual({
      matched: false, rest: ''
    })
  })
})

describe('splitWakeWord — near misses', () => {
  it('forgives what a small model does to an unusual name', () => {
    for (const heard of ['hey cloud', 'hey claud', 'hey claudee', 'hey clyde']) {
      expect(split(`${heard} delete that`), heard)
        .toMatchObject({ matched: true, rest: 'delete that' })
    }
  })

  it('does not forgive a short word, where one letter is a different word', () => {
    expect(split('they claude delete that').matched).toBe(false)
    expect(split('hay claude delete that').matched).toBe(false)
  })

  it('holds a one-word phrase to a tighter budget', () => {
    // Nothing corroborates a lone keyword, so two edits is too generous.
    expect(splitWakeWord('cloud delete that', { phrase: 'claude' }).matched).toBe(false)
    expect(splitWakeWord('claud delete that', { phrase: 'claude' }).matched).toBe(true)
  })

  it('matches exactly when fuzzy is off', () => {
    expect(split('hey cloud delete that', 'hey claude', false).matched).toBe(false)
    expect(split('hey claude delete that', 'hey claude', false).matched).toBe(true)
  })

  it('takes any phrase, not just the default', () => {
    expect(splitWakeWord('computer, clear everything', { phrase: 'computer' }))
      .toMatchObject({ matched: true, rest: 'clear everything' })
    expect(splitWakeWord('yo transvibe send it', { phrase: 'yo transvibe' }).rest)
      .toBe('send it')
  })
})

describe('phraseTokens', () => {
  it('reduces a phrase to bare words', () => {
    expect(phraseTokens('  Hey, Claude!  ')).toEqual(['hey', 'claude'])
    expect(phraseTokens('')).toEqual([])
    expect(phraseTokens(null)).toEqual([])
  })
})

/* The point of the whole feature: what comes out of the splitter is something
   the existing parser recognises, with no second dialect of commands. */
describe('what the splitter hands the parser', () => {
  const cases = [
    ['hey claude delete the last three words', 'delete'],
    ['hey claude, could you uppercase that', 'uppercase'],
    ['Hey Claude. Replace cat with dog.', 'replace'],
    ['um hey cloud clear everything', 'clear']
  ]
  for (const [utterance, action] of cases) {
    it(`"${utterance}" parses as ${action}`, () => {
      const { matched, rest } = split(utterance)
      expect(matched).toBe(true)
      expect(parseCommand(rest)).toMatchObject({ action })
    })
  }
})

describe('matchAgent — who was addressed', () => {
  const roster = normalizeRoster([
    { name: 'hey claude', kind: 'commands' },
    { name: 'ada', kind: 'chat' }
  ])
  const who = (text, list = roster, options) => {
    const m = matchAgent(text, list, options)
    return m.ambiguous ? 'ambiguous' : (m.agent ? m.agent.name : null)
  }

  it('routes to the name that was said', () => {
    expect(who('hey claude delete that')).toBe('hey claude')
    expect(who('ada what is a leap year')).toBe('ada')
    expect(matchAgent('ada what is a leap year', roster).rest).toBe('what is a leap year')
  })

  it('leaves an unaddressed sentence alone', () => {
    expect(who('the meeting is at three')).toBe(null)
    expect(matchAgent('the meeting is at three', roster).rest).toBe('the meeting is at three')
  })

  it('still forgives what a small model does to a name', () => {
    expect(who('hey cloud delete that')).toBe('hey claude')
    expect(who('hey cloud delete that', roster, { fuzzy: false })).toBe(null)
  })

  it('prefers the name heard exactly over the one heard nearly', () => {
    /* The point of the whole rule: with one phrase a near miss was a kindness,
       but on a roster the near miss is somebody else's name. */
    const pair = normalizeRoster([{ name: 'claude' }, { name: 'clyde' }])
    expect(who('claude hello', pair)).toBe('claude')
    expect(who('clyde hello', pair)).toBe('clyde')
  })

  it('prefers the longer name over the shorter one inside it', () => {
    const pair = normalizeRoster([{ name: 'mira' }, { name: 'mira jane' }])
    expect(who('mira jane hello', pair)).toBe('mira jane')
    expect(who('mira hello', pair)).toBe('mira')
  })

  it('refuses to guess between two names equally close', () => {
    // Guessing is how you address the wrong one. Better to hear nothing.
    const pair = normalizeRoster([{ name: 'claude' }, { name: 'clyde' }])
    expect(who('clude hello', pair)).toBe('ambiguous')
    expect(matchAgent('clude hello', pair).rest).toBe('clude hello')
  })

  it('is off when the roster is empty', () => {
    expect(who('hey claude delete that', [])).toBe(null)
    expect(who('hey claude delete that', null)).toBe(null)
  })

  it('takes a name said on its own', () => {
    expect(matchAgent('hey claude', roster)).toMatchObject({ matched: true, rest: '' })
  })

  it('survives junk rather than throwing', () => {
    expect(matchAgent(null, roster).matched).toBe(false)
    expect(matchAgent('', roster).matched).toBe(false)
  })
})
