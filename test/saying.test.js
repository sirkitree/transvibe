import { describe, it, expect } from 'vitest'
import { sayingSpectrum, sayingLevel } from '../src/renderer/saying.js'

const arr = spectrum => Array.from(spectrum)

describe('sayingSpectrum', () => {
  it('fills the array an AnalyserNode would have filled', () => {
    // The whole point: the same band renderer draws this and the microphone.
    const s = sayingSpectrum(400, { bins: 64 })
    expect(s).toBeInstanceOf(Uint8Array)
    expect(s).toHaveLength(64)
    for (const v of s) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(255)
    }
  })

  it('fills an array it was given rather than making a new one', () => {
    const out = new Uint8Array(32)
    expect(sayingSpectrum(120, { bins: 32, out })).toBe(out)
    expect(out.some(v => v > 0)).toBe(true)
  })

  it('draws the same frame for the same moment', () => {
    expect(arr(sayingSpectrum(400, { seed: 3 })))
      .toEqual(arr(sayingSpectrum(400, { seed: 3 })))
  })

  it('draws a different picture for a different sentence', () => {
    expect(arr(sayingSpectrum(400, { seed: 1 })))
      .not.toEqual(arr(sayingSpectrum(400, { seed: 5 })))
  })

  it('moves at a syllable rate rather than sitting still', () => {
    expect(arr(sayingSpectrum(0))).not.toEqual(arr(sayingSpectrum(140)))
  })

  it('puts the energy low, the way speech does', () => {
    // A flat spectrum would draw a flat ribbon.
    const s = sayingSpectrum(300, { bins: 64 })
    const low = s.slice(0, 16).reduce((a, b) => a + b, 0)
    const high = s.slice(48).reduce((a, b) => a + b, 0)
    expect(low).toBeGreaterThan(high * 2)
  })

  it('keeps neighbouring bins in agreement', () => {
    /* A real FFT's neighbours are correlated. One that jumps per bin draws a
       ribbon made of noise rather than of a voice. */
    const s = sayingSpectrum(300, { bins: 64 })
    let jumps = 0
    for (let i = 1; i < 24; i++) if (Math.abs(s[i] - s[i - 1]) > 60) jumps++
    expect(jumps).toBe(0)
  })

  it('is silent when the envelope is closed', () => {
    expect(arr(sayingSpectrum(400, { bins: 16, level: 0 }))).toEqual(new Array(16).fill(0))
  })

  it('survives nonsense rather than filling with NaN', () => {
    for (const v of sayingSpectrum(NaN, { bins: 0, level: undefined })) {
      expect(Number.isFinite(v)).toBe(true)
    }
    expect(sayingSpectrum(0, { bins: 0 })).toHaveLength(1)
  })
})

describe('sayingLevel', () => {
  it('fades in rather than snapping on', () => {
    expect(sayingLevel(1000, { startedAt: 1000 })).toBe(0)
    expect(sayingLevel(1060, { startedAt: 1000, attackMs: 120 })).toBeCloseTo(0.5)
    expect(sayingLevel(1500, { startedAt: 1000 })).toBe(1)
  })

  it('settles rather than vanishing mid-syllable', () => {
    const phase = { startedAt: 0, stoppedAt: 2000, releaseMs: 260 }
    expect(sayingLevel(2000, phase)).toBe(1)
    expect(sayingLevel(2130, phase)).toBeCloseTo(0.5)
    expect(sayingLevel(2260, phase)).toBe(0)
  })

  it('reaches exactly zero, which is what stops the animation', () => {
    expect(sayingLevel(9999, { startedAt: 0, stoppedAt: 100 })).toBe(0)
    expect(sayingLevel(0, {})).toBe(0)
  })
})
