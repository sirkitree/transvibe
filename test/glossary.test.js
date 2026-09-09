import { describe, it, expect } from 'vitest'
import {
  buildPrompt, normalizeTerms, applyCorrections, fromSettings, isGlossaryEcho
} from '../src/shared/glossary.js'

describe('normalizeTerms', () => {
  it('drops blanks and case-insensitive duplicates, keeps order', () => {
    expect(normalizeTerms(['Drupal', '', '  ', 'drupal', 'Lullabot'])).toEqual(['Drupal', 'Lullabot'])
  })

  it('squashes internal whitespace', () => {
    expect(normalizeTerms(['  Claude   Code '])).toEqual(['Claude Code'])
  })

  it('tolerates non-arrays', () => {
    expect(normalizeTerms(undefined)).toEqual([])
    expect(normalizeTerms(null)).toEqual([])
  })
})

describe('buildPrompt', () => {
  it('is empty when there is nothing to bias', () => {
    expect(buildPrompt([])).toBe('')
    expect(buildPrompt(undefined)).toBe('')
  })

  it('reads as a sentence, not a bare list', () => {
    expect(buildPrompt(['Drupal', 'Tugboat'])).toBe('Glossary: Drupal, Tugboat.')
  })

  it('stays under whisper’s prompt budget', () => {
    const many = Array.from({ length: 400 }, (_, i) => `term${i}`)
    const prompt = buildPrompt(many)
    expect(prompt.length).toBeLessThanOrEqual(800)
    expect(prompt.startsWith('Glossary: term0, term1,')).toBe(true)
    expect(prompt.endsWith('.')).toBe(true)
  })
})

describe('applyCorrections', () => {
  const map = { 'trans vibe': 'transvibe', 'drupple': 'Drupal', 'clod code': 'Claude Code' }

  it('rewrites whole words, ignoring case', () => {
    expect(applyCorrections('I opened Drupple today', map)).toBe('I opened Drupal today')
    expect(applyCorrections('DRUPPLE rules', map)).toBe('Drupal rules')
  })

  it('spans the punctuation whisper invents mid-phrase', () => {
    expect(applyCorrections('trans-vibe is running', map)).toBe('transvibe is running')
    expect(applyCorrections('Trans Vibe is running', map)).toBe('transvibe is running')
  })

  it('never fires inside a longer word', () => {
    expect(applyCorrections('undruppled', map)).toBe('undruppled')
  })

  it('prefers the longest matching source', () => {
    const longest = { clod: 'cloud', 'clod code': 'Claude Code' }
    expect(applyCorrections('open clod code now', longest)).toBe('open Claude Code now')
  })

  it('passes text through when there is no glossary', () => {
    expect(applyCorrections('hello world', {})).toBe('hello world')
    expect(applyCorrections('hello world', undefined)).toBe('hello world')
    expect(applyCorrections('', map)).toBe('')
  })

  it('accepts entry pairs as well as an object', () => {
    expect(applyCorrections('drupple', [['drupple', 'Drupal']])).toBe('Drupal')
  })
})

describe('applyCorrections with comma alternatives', () => {
  const corrections = { 'Mirror, Myra, Meera': 'Mira' }

  it('treats a comma as "or", not as part of the phrase', () => {
    expect(applyCorrections('ask Myra about it', corrections)).toBe('ask Mira about it')
    expect(applyCorrections('hey Meera', corrections)).toBe('hey Mira')
    expect(applyCorrections('Mirror', corrections)).toBe('Mira')
  })

  it('leaves the same words alone where they are not the mistake', () => {
    expect(applyCorrections('the mirrors were dusty', corrections)).toBe('the mirrors were dusty')
  })

  it('still prefers the longest spelling across every rule', () => {
    const pair = { 'cloud, clod': 'Claude', 'cloud code': 'Claude Code' }
    expect(applyCorrections('open cloud code', pair)).toBe('open Claude Code')
  })
})

describe('fromSettings', () => {
  it('splits a settings blob into prompt and fixups', () => {
    const { prompt, corrections } = fromSettings({ vocabulary: ['Drupal'], corrections: { a: 'b' } })
    expect(prompt).toBe('Glossary: Drupal.')
    expect(corrections).toEqual({ a: 'b' })
  })

  it('is safe on an empty settings object', () => {
    expect(fromSettings()).toEqual({ prompt: '', corrections: {} })
  })
})

describe('isGlossaryEcho', () => {
  const glossary = { vocabulary: ['VINCI', 'Claude Code'], corrections: { lolabot: 'Lullabot' } }

  it('catches a bare glossary term with punctuation', () => {
    expect(isGlossaryEcho('VINCI.', glossary)).toBe(true)
    expect(isGlossaryEcho(' vinci ', glossary)).toBe(true)
    expect(isGlossaryEcho('VINCI, VINCI!', glossary)).toBe(true)
  })

  it('catches a correction target, not just a listed term', () => {
    expect(isGlossaryEcho('Lullabot.', glossary)).toBe(true)
  })

  it('catches a multi-word term, and its terms in sequence', () => {
    expect(isGlossaryEcho('Claude Code', glossary)).toBe(true)
    expect(isGlossaryEcho('Claude Code VINCI', glossary)).toBe(true)
  })

  it('leaves the term alone inside a real sentence', () => {
    expect(isGlossaryEcho('I opened VINCI this morning', glossary)).toBe(false)
    expect(isGlossaryEcho('VINCI is down', glossary)).toBe(false)
    expect(isGlossaryEcho('and VINCI', glossary)).toBe(false)
  })

  it('does not fire on half of a multi-word term', () => {
    expect(isGlossaryEcho('Claude', glossary)).toBe(false)
  })

  it('lets an agent be addressed by a name that is also in the glossary', () => {
    /* The regression this exists for: "Hey Mira" alone is how you arm her, and
       putting the name in the glossary so it is spelled right made the whole
       utterance a glossary term. It broke only once the model got good enough
       to transcribe the name exactly. */
    const named = { vocabulary: ['Hey Mira'], corrections: {}, names: ['Hey Mira', 'Hey Atlas'] }
    expect(isGlossaryEcho('Hey Mira.', named)).toBe(false)
    expect(isGlossaryEcho(' hey mira ', named)).toBe(false)
  })

  it('still catches an echo of a term that is nobody\'s name', () => {
    const named = { vocabulary: ['VINCI', 'Hey Mira'], corrections: {}, names: ['Hey Mira'] }
    expect(isGlossaryEcho('VINCI.', named)).toBe(true)
    // The exemption is the whole utterance being the name, not containing it.
    expect(isGlossaryEcho('Hey Mira VINCI', named)).toBe(true)
  })

  it('never fires without a glossary', () => {
    expect(isGlossaryEcho('VINCI.', {})).toBe(false)
    expect(isGlossaryEcho('VINCI.')).toBe(false)
  })

  it('is false for empty or punctuation-only text', () => {
    expect(isGlossaryEcho('', glossary)).toBe(false)
    expect(isGlossaryEcho('...', glossary)).toBe(false)
    expect(isGlossaryEcho(null, glossary)).toBe(false)
  })
})
