import { describe, it, expect } from 'vitest'
import {
  parseTermInput, addTerms, removeTerm,
  addCorrection, removeCorrection, sortedEntries, splitWords
} from '../src/renderer/glossary-edit.js'

describe('parseTermInput', () => {
  it('splits on commas and newlines', () => {
    expect(parseTermInput('Drupal, Lullabot\nTugboat')).toEqual(['Drupal', 'Lullabot', 'Tugboat'])
  })

  it('drops empties and squashes whitespace', () => {
    expect(parseTermInput(' , Claude   Code ,, ')).toEqual(['Claude Code'])
  })

  it('survives nothing at all', () => {
    expect(parseTermInput('')).toEqual([])
    expect(parseTermInput(null)).toEqual([])
  })
})

describe('addTerms', () => {
  it('appends in the order typed', () => {
    const r = addTerms(['Drupal'], 'Lullabot, Tugboat')
    expect(r.ok).toBe(true)
    expect(r.terms).toEqual(['Drupal', 'Lullabot', 'Tugboat'])
    expect(r.added).toEqual(['Lullabot', 'Tugboat'])
  })

  it('refuses a term already listed, whatever the case', () => {
    const r = addTerms(['Drupal'], 'drupal')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/already listed/)
    expect(r.terms).toEqual(['Drupal'])
  })

  it('keeps the new ones when only some are duplicates', () => {
    const r = addTerms(['Drupal'], 'Drupal, Tugboat')
    expect(r.ok).toBe(true)
    expect(r.terms).toEqual(['Drupal', 'Tugboat'])
    expect(r.added).toEqual(['Tugboat'])
  })

  it('rejects an empty field', () => {
    const r = addTerms(['Drupal'], '   ')
    expect(r.ok).toBe(false)
    expect(r.error).toBe('nothing to add')
  })

  it('does not mutate the list it was given', () => {
    const terms = ['Drupal']
    addTerms(terms, 'Tugboat')
    expect(terms).toEqual(['Drupal'])
  })
})

describe('removeTerm', () => {
  it('removes case-insensitively', () => {
    expect(removeTerm(['Drupal', 'Tugboat'], 'DRUPAL').terms).toEqual(['Tugboat'])
  })

  it('is a no-op for something not listed', () => {
    expect(removeTerm(['Drupal'], 'nope').terms).toEqual(['Drupal'])
  })
})

describe('addCorrection', () => {
  it('adds a rule', () => {
    const r = addCorrection({}, ' drupple ', ' Drupal ')
    expect(r.ok).toBe(true)
    expect(r.corrections).toEqual({ drupple: 'Drupal' })
  })

  it('needs both sides', () => {
    expect(addCorrection({}, 'drupple', '').error).toBe('both sides are required')
    expect(addCorrection({}, '', 'Drupal').error).toBe('both sides are required')
  })

  it('rejects a rule that would do nothing', () => {
    expect(addCorrection({}, 'Drupal', 'drupal').error).toBe('those are the same word')
  })

  it('replaces a key differing only in case, rather than adding a rival', () => {
    const r = addCorrection({ Drupple: 'Drupal' }, 'drupple', 'Drupal!')
    expect(r.ok).toBe(true)
    expect(r.replaced).toEqual(['Drupple'])
    expect(r.corrections).toEqual({ drupple: 'Drupal!' })
  })

  it('makes one rule per spelling when several are given at once', () => {
    /* Typed as one field because that is how the mistake is described — "it
       writes Myra or Meera" — and stored as separate rules because that is
       how each of them is then removed or edited. */
    const r = addCorrection({}, 'Mirror, Myra, Meera', 'Mira')
    expect(r.ok).toBe(true)
    expect(r.added).toEqual(['Mirror', 'Myra', 'Meera'])
    expect(r.corrections).toEqual({ Mirror: 'Mira', Myra: 'Mira', Meera: 'Mira' })
  })

  it('rejects the batch if any spelling is the word it writes', () => {
    expect(addCorrection({}, 'Myra, Mira', 'Mira').error).toBe('those are the same word')
  })

  it('edits a fix in place, taking the old row with it when it is renamed', () => {
    const base = { Mirror: 'Mira', Drupple: 'Drupal' }
    const r = addCorrection(base, 'Myra', 'Mira', { replacing: 'Mirror' })
    expect(r.ok).toBe(true)
    expect(r.edited).toBe(true)
    expect(r.corrections).toEqual({ Drupple: 'Drupal', Myra: 'Mira' })
  })

  it('edits only the right-hand side without disturbing the rest', () => {
    const r = addCorrection({ Mirror: 'Mira' }, 'Mirror', 'Mira Jane', { replacing: 'Mirror' })
    expect(r.corrections).toEqual({ Mirror: 'Mira Jane' })
  })

  it('does not mutate the map it was given', () => {
    const base = { a: 'b' }
    addCorrection(base, 'c', 'd')
    expect(base).toEqual({ a: 'b' })
  })
})

describe('removeCorrection', () => {
  it('removes case-insensitively and leaves the rest', () => {
    const r = removeCorrection({ Drupple: 'Drupal', lolabot: 'Lullabot' }, 'drupple')
    expect(r.corrections).toEqual({ lolabot: 'Lullabot' })
  })
})

describe('sortedEntries', () => {
  it('orders by what was heard, ignoring case', () => {
    expect(sortedEntries({ zebra: 'Z', Apple: 'A' })).toEqual([['Apple', 'A'], ['zebra', 'Z']])
  })

  it('handles an absent map', () => {
    expect(sortedEntries(undefined)).toEqual([])
  })
})

describe('splitWords', () => {
  it('separates words from the punctuation around them', () => {
    expect(splitWords('Hello, world!')).toEqual([
      { text: 'Hello', word: true },
      { text: ', ', word: false },
      { text: 'world', word: true },
      { text: '!', word: false }
    ])
  })

  it('keeps an internal apostrophe or hyphen inside the word', () => {
    expect(splitWords("don't voice-to-text").filter(p => p.word).map(p => p.text))
      .toEqual(["don't", 'voice-to-text'])
  })

  it('leaves a trailing hyphen outside the word', () => {
    expect(splitWords('well- ').map(p => p.text)).toEqual(['well', '- '])
  })

  it('round-trips the original text exactly', () => {
    const text = "  Drupal's 11.2 — trans-vibe, ok?  "
    expect(splitWords(text).map(p => p.text).join('')).toBe(text)
  })

  it('handles empty input', () => {
    expect(splitWords('')).toEqual([])
    expect(splitWords(null)).toEqual([])
  })
})
