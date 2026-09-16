import { describe, it, expect } from 'vitest'
import {
  lines, LINE_COUNT, startEnrolment, readingHeard, currentLine, progress,
  enrolmentSummary, MIN_READING_SECONDS, MAX_READING_SECONDS
} from '../src/shared/enroll-script.js'
import { DEFAULTS } from '../src/main/config.js'

const read = (state, seconds = 5, text = 'the quick brown fox jumps over the lazy dog') =>
  readingHeard(state, seconds, text)

describe('the lines', () => {
  it('ends with one that uses a name actually on the roster', () => {
    expect(lines('Hey Mira').at(-1)).toContain('Hey Mira')
    expect(lines('hey claude').at(-1)).toContain('Hey Claude')
  })

  it('uses the app\'s own default agent, so a fresh install reads a real name', () => {
    const first = DEFAULTS.agents[0].name
    expect(lines(first).at(-1).toLowerCase()).toContain(first.toLowerCase())
  })

  it('still reads as a sentence when there is no roster at all', () => {
    const last = lines('').at(-1)
    expect(last).not.toContain('undefined')
    expect(last.startsWith(',')).toBe(false)
    expect(last).toMatch(/^[A-Z].*\.$/)
  })

  it('gives the same count it advertises', () => {
    expect(lines('hey claude')).toHaveLength(LINE_COUNT)
  })

  it('is long enough to be worth measuring — short readings score badly', () => {
    // ~12 characters a second read aloud; every line should clear the floor
    for (const line of lines('hey claude')) expect(line.length / 12).toBeGreaterThan(MIN_READING_SECONDS)
  })
})

describe('readingHeard', () => {
  it('walks through every line and then finishes', () => {
    let s = startEnrolment()
    for (let i = 0; i < LINE_COUNT - 1; i++) {
      const r = read(s)
      expect(r.accepted).toBe(true)
      expect(r.done).toBe(false)
      s = r.state
    }
    const last = read(s)
    expect(last).toMatchObject({ accepted: true, done: true })
  })

  it('rejects a reading that stopped early, without losing the place', () => {
    const s = startEnrolment()
    const r = read(s, MIN_READING_SECONDS - 0.5)
    expect(r.accepted).toBe(false)
    expect(r.state).toBe(s)              // same line, try again
    expect(r.message).toMatch(/short/)
  })

  it('rejects a reading that ran far too long', () => {
    const r = read(startEnrolment(), MAX_READING_SECONDS + 1)
    expect(r.accepted).toBe(false)
    expect(r.message).toMatch(/long/)
  })

  it('rejects a cough — long enough, but no words in it', () => {
    const r = readingHeard(startEnrolment(), 5, '...')
    expect(r.accepted).toBe(false)
    expect(r.message).toMatch(/did not catch/)
  })

  it('accepts a misheard reading, because a wrong word is still your voice', () => {
    expect(readingHeard(startEnrolment(), 5, 'the quick brown box jumped over a lazy dig').accepted).toBe(true)
  })

  it('accepts a reading with no transcript at all rather than blocking on one', () => {
    expect(readingHeard(startEnrolment(), 5, '').accepted).toBe(true)
  })

  it('survives a nonsense duration', () => {
    for (const bad of [NaN, null, undefined, Infinity, -1]) {
      expect(readingHeard(startEnrolment(), bad, 'words here').accepted).toBe(false)
    }
  })
})

describe('currentLine and progress', () => {
  it('advances the line only on an accepted reading', () => {
    const s = startEnrolment()
    const first = currentLine(s, 'hey claude')
    expect(currentLine(read(s, 1).state, 'hey claude')).toBe(first)
    expect(currentLine(read(s).state, 'hey claude')).not.toBe(first)
  })

  it('runs out of lines rather than reading past the end', () => {
    let s = startEnrolment()
    for (let i = 0; i < LINE_COUNT; i++) s = read(s).state
    expect(currentLine(s, 'hey claude')).toBe(null)
  })

  it('counts up to the number of lines', () => {
    expect(progress(startEnrolment())).toEqual({ done: 0, total: LINE_COUNT })
    expect(progress(read(startEnrolment()).state).done).toBe(1)
  })
})

describe('enrolmentSummary', () => {
  const good = [0.92, 0.88, 0.9, 0.85, 0.91]

  it('says it worked', () => {
    expect(enrolmentSummary({ ok: true, count: 5, scores: good })).toMatch(/enrolled from 5/)
  })

  it('reports the failure rather than claiming success', () => {
    expect(enrolmentSummary({ ok: false, error: 'model not downloaded' })).toMatch(/model not downloaded/)
  })

  it('warns when the readings did not sound like each other', () => {
    // one reading far from the rest is two people, or a television
    const summary = enrolmentSummary({ ok: true, count: 5, scores: [0.9, 0.88, 0.41, 0.92, 0.87], threshold: 0.35 })
    expect(summary).toMatch(/did not sound much alike/)
    expect(summary).toMatch(/0\.41/)
  })

  it('does not warn on ordinary agreement', () => {
    expect(enrolmentSummary({ ok: true, count: 5, scores: good, threshold: 0.35 }))
      .not.toMatch(/did not sound/)
  })

  it('copes with no scores at all', () => {
    expect(enrolmentSummary({ ok: true, count: 5, scores: [] })).toMatch(/enrolled from 5/)
    expect(enrolmentSummary({ ok: true, count: 5, scores: [null, NaN] })).toMatch(/enrolled from 5/)
  })
})
