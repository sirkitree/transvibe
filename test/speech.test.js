import { describe, it, expect } from 'vitest'
import { parseVoices, speechTimeout } from '../src/main/speech.js'

/* Real `say -v '?'` output. The column layout is what makes this worth a
   parser at all: a voice name can contain spaces and parentheses, so the only
   reliable landmark is the locale that follows it. */
const SAMPLE = `Albert              en_US    # Hello! My name is Albert.
Alice               it_IT    # Ciao! Mi chiamo Alice.
Amélie              fr_CA    # Bonjour! Je m’appelle Amélie.
Eddy (English (UK)) en_GB    # Hello! My name is Eddy.
Zosia               pl_PL    # Cześć! Nazywam się Zosia.
`

describe('parseVoices', () => {
  it('reads a name and a locale off every line', () => {
    const voices = parseVoices(SAMPLE)
    expect(voices).toHaveLength(5)
    expect(voices[0]).toEqual({ name: 'Albert', locale: 'en_US' })
  })

  it('keeps a name that has spaces and brackets in it', () => {
    const eddy = parseVoices(SAMPLE).find(v => v.locale === 'en_GB')
    expect(eddy.name).toBe('Eddy (English (UK))')
  })

  it('keeps a name that is not ASCII', () => {
    expect(parseVoices(SAMPLE).map(v => v.name)).toContain('Amélie')
  })

  it('is an empty list rather than a throw on junk', () => {
    expect(parseVoices('')).toEqual([])
    expect(parseVoices(null)).toEqual([])
    expect(parseVoices('command not found')).toEqual([])
  })
})

describe('speechTimeout', () => {
  it('leaves a short confirmation the eight seconds it always had', () => {
    expect(speechTimeout('copied')).toBe(8000)
    expect(speechTimeout('switched to Home and Communications')).toBe(8000)
  })

  it('gives a chat answer room to finish the sentence', () => {
    // Sixty words is the most acceptAnswer will pass through, and at a normal
    // speaking rate that is twenty seconds — the old fixed cap killed `say`
    // a third of the way in.
    const answer = Array(60).fill('word').join(' ')
    expect(speechTimeout(answer)).toBeGreaterThan(20000)
  })

  it('follows the rate the voice was given, when it has one', () => {
    const answer = Array(60).fill('word').join(' ')
    expect(speechTimeout(answer, 300)).toBeLessThan(speechTimeout(answer))
  })

  it('never waits forever, whatever it is handed', () => {
    expect(speechTimeout(Array(5000).fill('word').join(' '))).toBe(60000)
    expect(speechTimeout('')).toBe(8000)
    expect(speechTimeout(null)).toBe(8000)
  })
})
