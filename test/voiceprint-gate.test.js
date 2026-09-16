import { describe, it, expect } from 'vitest'
import {
  allowAgent, thresholdFor, centroid, cosine, BYPASS_KEY, BYPASS_UNSET
} from '../src/shared/voiceprint-gate.js'

const on = { enabled: true, enrolled: true, threshold: 0.35 }

describe('allowAgent — when the gate applies', () => {
  it('lets your own voice address an agent', () => {
    expect(allowAgent({ ...on, score: 0.81 })).toMatchObject({ pass: true, reason: 'voice-matched' })
  })

  it('turns somebody else away', () => {
    expect(allowAgent({ ...on, score: 0.04 })).toMatchObject({ pass: false, reason: 'voice-rejected' })
  })

  it('treats the threshold as inclusive, so a tuned number means what it says', () => {
    expect(allowAgent({ ...on, score: 0.35 }).pass).toBe(true)
    expect(allowAgent({ ...on, score: 0.3499 }).pass).toBe(false)
  })

  it('never gates the key path — a held key is proof of presence', () => {
    expect(allowAgent({ ...on, score: -0.5, commandMode: true }))
      .toMatchObject({ pass: true, reason: BYPASS_KEY })
  })
})

describe('allowAgent — failing open', () => {
  it('passes everything when the setting is off', () => {
    expect(allowAgent({ ...on, enabled: false, score: 0.01 }))
      .toMatchObject({ pass: true, reason: BYPASS_UNSET })
  })

  it('passes everything before a voice has been enrolled', () => {
    expect(allowAgent({ ...on, enrolled: false, score: 0.01 }))
      .toMatchObject({ pass: true, reason: BYPASS_UNSET })
  })

  it('passes when nothing scored the audio — a missing model must not mute the app', () => {
    for (const score of [null, undefined, NaN, Infinity]) {
      expect(allowAgent({ ...on, score })).toMatchObject({ pass: true, reason: 'not-scored' })
    }
  })

  it('defaults to open with no arguments at all', () => {
    expect(allowAgent().pass).toBe(true)
    expect(allowAgent({}).pass).toBe(true)
  })
})

describe('thresholdFor — short utterances score lower', () => {
  it('leaves a sentence at the configured threshold', () => {
    expect(thresholdFor(4, 0.35)).toBeCloseTo(0.35, 5)
    expect(thresholdFor(12, 0.35)).toBeCloseTo(0.35, 5)
  })

  it('relaxes for a bare wake phrase, but never below 80%', () => {
    expect(thresholdFor(1, 0.35)).toBeCloseTo(0.28, 5)
    expect(thresholdFor(0.4, 0.35)).toBeCloseTo(0.28, 5)
  })

  it('rises monotonically with duration', () => {
    let prev = -Infinity
    for (const s of [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 8]) {
      const t = thresholdFor(s, 0.35)
      expect(t).toBeGreaterThanOrEqual(prev)
      prev = t
    }
  })

  it('still admits a measured 1.16s "hey Mira" at 0.66, and still rejects an impostor at 0.15', () => {
    const t = thresholdFor(1.16, 0.35)
    expect(0.66).toBeGreaterThan(t)
    expect(0.15).toBeLessThan(t)
  })

  it('holds the configured number when duration is unknown', () => {
    expect(thresholdFor(null, 0.35)).toBeCloseTo(0.35, 5)
    expect(thresholdFor(NaN, 0.35)).toBeCloseTo(0.35, 5)
  })
})

describe('centroid', () => {
  it('normalises before averaging, so a loud utterance does not outvote quiet ones', () => {
    const quiet = [Float32Array.from([1, 0]), Float32Array.from([0, 1])]
    const shouted = [Float32Array.from([50, 0]), Float32Array.from([0, 1])]
    expect(cosine(centroid(quiet), centroid(shouted))).toBeCloseTo(1, 5)
  })

  it('returns a unit vector', () => {
    const c = centroid([Float32Array.from([3, 4]), Float32Array.from([1, 1])])
    expect(Math.hypot(...c)).toBeCloseTo(1, 5)
  })

  it('refuses mismatched or empty input rather than averaging nonsense', () => {
    expect(centroid([])).toBe(null)
    expect(centroid(null)).toBe(null)
    expect(centroid([Float32Array.from([1, 0]), Float32Array.from([1, 0, 0])])).toBe(null)
  })
})

describe('cosine', () => {
  it('is 1 for the same direction and 0 for perpendicular', () => {
    expect(cosine(Float32Array.from([1, 2]), Float32Array.from([2, 4]))).toBeCloseTo(1, 5)
    expect(cosine(Float32Array.from([1, 0]), Float32Array.from([0, 1]))).toBeCloseTo(0, 5)
  })

  it('returns null rather than NaN for a zero vector or a size mismatch', () => {
    expect(cosine(Float32Array.from([0, 0]), Float32Array.from([1, 1]))).toBe(null)
    expect(cosine(Float32Array.from([1]), Float32Array.from([1, 1]))).toBe(null)
    expect(cosine(null, Float32Array.from([1]))).toBe(null)
  })
})
