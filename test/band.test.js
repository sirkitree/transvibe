import { describe, it, expect } from 'vitest'
import { createBandModel, computeBandPoints } from '../src/renderer/band.js'

const BOX = { width: 800, centerY: 60, height: 80 }

// small deterministic PRNG so two models can be fed identical randomness
const seeded = seed => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const fftOf = (n, fill) => {
  const a = new Uint8Array(n)
  for (let i = 0; i < n; i++) a[i] = typeof fill === 'function' ? fill(i) : fill
  return a
}

const eachY = (out, fn) => {
  for (let i = 1; i < out.length; i += 2) fn(out[i], (i - 1) / 2)
}

describe('createBandModel', () => {
  it('builds families * linesPerFamily lines', () => {
    const m = createBandModel({ families: 3, linesPerFamily: 18 })
    expect(m.lines).toHaveLength(54)
    expect(m.lines.filter(l => l.familyIndex === 0)).toHaveLength(18)
    expect(m.lines.filter(l => l.familyIndex === 2)).toHaveLength(18)
  })

  it('groups hues around the three offsets', () => {
    const m = createBandModel({ hueOffsets: [0, 0.33, 0.66], hueDrift: 0.001 })
    for (let i = 0; i < 10; i++) m.update(fftOf(64, 0), 1 / 60)
    const groups = [0, 1, 2].map(f => m.lines.filter(l => l.familyIndex === f).map(l => l.hue))
    groups.forEach((hues, f) => {
      const expected = (m.baseHue + [0, 0.33, 0.66][f]) % 1
      hues.forEach(h => {
        expect(h).toBeCloseTo(expected, 10)
        expect(h).toBeGreaterThanOrEqual(0)
        expect(h).toBeLessThan(1)
      })
    })
    // the three families are distinct bands of colour
    expect(groups[0][0]).not.toBeCloseTo(groups[1][0], 3)
    expect(groups[1][0]).not.toBeCloseTo(groups[2][0], 3)
  })

  it('advances baseHue by hueDrift per update and wraps past 1', () => {
    const m = createBandModel({ hueDrift: 0.001 })
    m.update(fftOf(32, 0), 1 / 60)
    expect(m.baseHue).toBeCloseTo(0.001, 12)
    m.update(fftOf(32, 0), 1 / 60)
    expect(m.baseHue).toBeCloseTo(0.002, 12)

    const fast = createBandModel({ hueDrift: 0.4 })
    for (let i = 0; i < 4; i++) fast.update(fftOf(32, 0), 1 / 60)
    expect(fast.baseHue).toBeGreaterThanOrEqual(0)
    expect(fast.baseHue).toBeLessThan(1)
    expect(fast.baseHue).toBeCloseTo(0.6, 10)
  })

  it('smooths a step input instead of jumping in one frame', () => {
    const m = createBandModel({ smoothing: 0.08 })
    const loud = fftOf(128, 255)
    m.update(loud, 1 / 60)
    expect(m.level).toBeCloseTo(0.08, 6)
    const first = m.level
    m.update(loud, 1 / 60)
    expect(m.level).toBeGreaterThan(first)
    expect(m.level).toBeLessThan(0.5)
    for (let i = 0; i < 400; i++) m.update(loud, 1 / 60)
    expect(m.level).toBeGreaterThan(0.99)
    expect(m.level).toBeLessThanOrEqual(1)
  })

  it('reset returns level, hue and twist to their starting state', () => {
    const m = createBandModel({ rng: seeded(7), hueDrift: 0.01 })
    for (let i = 0; i < 20; i++) m.update(fftOf(64, 200), 1 / 60)
    expect(m.level).toBeGreaterThan(0)
    m.reset()
    expect(m.baseHue).toBe(0)
    expect(m.level).toBe(0)
    m.lines.forEach(l => expect(l.twist).toBe(0))
  })
})

describe('computeBandPoints', () => {
  it('returns points*2 values with x rising evenly from 0 to width', () => {
    const m = createBandModel({ points: 256 })
    m.update(fftOf(1024, 120), 1 / 60)
    const out = computeBandPoints(m, 0, fftOf(1024, 120), BOX)
    expect(out).toBeInstanceOf(Float32Array)
    expect(out.length).toBe(512)
    expect(out[0]).toBe(0)
    expect(out[out.length - 2]).toBeCloseTo(BOX.width, 3)
    for (let i = 2; i < out.length; i += 2) {
      expect(out[i]).toBeGreaterThan(out[i - 2])
    }
  })

  it('collapses to a near-straight line on silence', () => {
    const m = createBandModel({ idleAmp: 1.5, points: 128 })
    const silent = fftOf(512, 0)
    for (let i = 0; i < 30; i++) m.update(silent, 1 / 60)
    expect(m.level).toBeCloseTo(0, 10)
    for (let li = 0; li < m.lines.length; li++) {
      const out = computeBandPoints(m, li, silent, BOX)
      eachY(out, y => {
        expect(Number.isFinite(y)).toBe(true)
        expect(Math.abs(y - BOX.centerY)).toBeLessThanOrEqual(1.5 + 1e-4)
      })
    }
  })

  it('stays finite and inside the box for zero, max, random and NaN-laced input', () => {
    const rand = seeded(99)
    const inputs = [
      fftOf(1024, 0),
      fftOf(1024, 255),
      fftOf(1024, () => Math.floor(rand() * 256)),
      [0, NaN, 255, Infinity, -Infinity, undefined, 128, NaN],
      []
    ]
    const m = createBandModel({ rng: seeded(5), points: 64 })
    for (const fft of inputs) {
      for (let i = 0; i < 60; i++) m.update(fft, 1 / 60)
      for (let li = 0; li < m.lines.length; li++) {
        const out = computeBandPoints(m, li, fft, BOX)
        expect(out.length).toBe(128)
        for (let i = 0; i < out.length; i++) expect(Number.isFinite(out[i])).toBe(true)
        eachY(out, y => {
          expect(y).toBeGreaterThanOrEqual(BOX.centerY - BOX.height / 2 - 1e-4)
          expect(y).toBeLessThanOrEqual(BOX.centerY + BOX.height / 2 + 1e-4)
        })
      }
    }
  })

  it('survives a zero-width box and a missing line', () => {
    const m = createBandModel({ points: 16 })
    m.update(fftOf(64, 255), 1 / 60)
    const out = computeBandPoints(m, 0, fftOf(64, 255), { width: 0, centerY: 10, height: 0 })
    expect(out.length).toBe(32)
    for (let i = 0; i < out.length; i++) expect(Number.isFinite(out[i])).toBe(true)
    const none = computeBandPoints(m, 9999, fftOf(64, 255), BOX)
    expect(none.length).toBe(32)
    for (let i = 0; i < none.length; i++) expect(none[i]).toBe(0)
  })

  it('never calls Math.random, so the same seed gives identical points', () => {
    const build = () => createBandModel({ rng: seeded(1234), points: 96 })
    const a = build()
    const b = build()
    const frames = [fftOf(256, 30), fftOf(256, 200), fftOf(256, i => i % 256)]
    for (const fft of frames) {
      a.update(fft, 1 / 60)
      b.update(fft, 1 / 60)
    }
    expect(a.baseHue).toBe(b.baseHue)
    expect(a.level).toBe(b.level)
    for (let li = 0; li < a.lines.length; li++) {
      const pa = computeBandPoints(a, li, frames[2], BOX)
      const pb = computeBandPoints(b, li, frames[2], BOX)
      expect(Array.from(pa)).toEqual(Array.from(pb))
    }
    // and the jitter actually moves the lines around
    expect(a.lines.some(l => l.twist !== 0)).toBe(true)
  })
})

describe('robustness gaps', () => {
  it('accepts a null options bag and a null box instead of throwing', () => {
    const m = createBandModel(null)
    expect(m.lines).toHaveLength(54)
    m.update(fftOf(64, 255), 1 / 60)
    const out = computeBandPoints(m, 0, fftOf(64, 255), null)
    expect(out.length).toBe(m.points * 2)
    for (let i = 0; i < out.length; i++) expect(out[i]).toBe(0)
  })

  it('falls back to the documented defaults for non-finite options', () => {
    const m = createBandModel({ smoothing: NaN, gain: NaN, idleAmp: NaN, hueDrift: NaN })
    expect(m.smoothing).toBeCloseTo(0.08, 10)
    expect(m.gain).toBe(46)
    expect(m.idleAmp).toBe(1.5)
    // a NaN smoothing must not freeze level at zero forever
    m.update(fftOf(64, 255), 1 / 60)
    expect(m.level).toBeGreaterThan(0)
  })

  it('exposes lineIndex as the index into model.lines', () => {
    const m = createBandModel({ rng: seeded(3), points: 32 })
    m.lines.forEach((l, i) => expect(l.lineIndex).toBe(i))
    const line = m.lines[17]
    const out = computeBandPoints(m, line.lineIndex, fftOf(64, 90), BOX)
    expect(out.length).toBe(64)
  })

  it('computeBandPoints is pure: repeated calls leak no state', () => {
    const m = createBandModel({ rng: seeded(11), points: 48 })
    for (let i = 0; i < 5; i++) m.update(fftOf(64, 180), 1 / 60)
    const before = m.lines.map(l => ({ ...l }))
    const a = computeBandPoints(m, 4, fftOf(64, 180), BOX)
    const b = computeBandPoints(m, 4, fftOf(64, 180), BOX)
    expect(Array.from(a)).toEqual(Array.from(b))
    expect(m.lines.map(l => ({ ...l }))).toEqual(before)
  })

  it('reset is idempotent and replays identically after it', () => {
    const m = createBandModel({ rng: seeded(21), hueDrift: 0.01, points: 24 })
    const frame = fftOf(64, 140)
    for (let i = 0; i < 10; i++) m.update(frame, 1 / 60)
    m.reset()
    const once = m.lines.map(l => ({ hue: l.hue, phase: l.phase, twist: l.twist }))
    m.reset()
    expect(m.lines.map(l => ({ hue: l.hue, phase: l.phase, twist: l.twist }))).toEqual(once)
    expect(m.baseHue).toBe(0)
    expect(m.level).toBe(0)
  })
})
