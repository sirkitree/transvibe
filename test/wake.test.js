import { describe, it, expect } from 'vitest'
import { splitWakeWord, phraseTokens } from '../src/renderer/wake.js'
import { parseCommand } from '../src/renderer/commands.js'

const split = (text, phrase = 'hey claude', fuzzy = true) =>
  splitWakeWord(text, { phrase, fuzzy })

describe('splitWakeWord — hits', () => {
  it('takes the command from after the phrase', () => {
    expect(split('hey claude uppercase that')).toEqual({
      matched: true, rest: 'uppercase that'
    })
  })

  it('ignores the punctuation whisper hangs off the phrase', () => {
    expect(split('Hey, Claude! Delete the last word.')).toEqual({
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
    expect(split('hey claude')).toEqual({ matched: true, rest: '' })
    expect(split('Hey Claude?')).toEqual({ matched: true, rest: '' })
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
        .toEqual({ matched: true, rest: 'delete that' })
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
      .toEqual({ matched: true, rest: 'clear everything' })
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
