import { describe, it, expect } from 'vitest'
import {
  createNoise, createOrbModel, computeFilament, mirrorPoints, placePoints
} from '../src/renderer/orb.js'

// A flat field, so the walk becomes arithmetic a test can predict.
const flat = v => () => v

const fromCentre = (x, y) => Math.hypot(x - 0.5, y - 0.5)

const eachPoint = (pts, fn) => {
  for (let i = 0; i < pts.length; i += 2) fn(pts[i], pts[i + 1], i / 2)
}

const quiet = (model, frames, dt = 1 / 30) => {
  for (let i = 0; i < frames; i++) model.update({ level: 0 }, dt)
  return model
}

describe('createNoise', () => {
  it('is seeded: the same seed gives the same field, a different one does not', () => {
    const a = createNoise(7)
    const b = createNoise(7)
    const c = createNoise(8)
    expect(a(1.3, 2.7, 0.4)).toBe(b(1.3, 2.7, 0.4))
    expect(a(1.3, 2.7, 0.4)).not.toBe(c(1.3, 2.7, 0.4))
  })

  it('stays in [0, 1) everywhere, negatives and nonsense included', () => {
    const n = createNoise(3)
    for (const [x, y, z] of [[0, 0, 0], [-4.2, 9.9, -1.1], [1e6, -1e6, 0.5]]) {
      const v = n(x, y, z)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
    expect(Number.isFinite(n(NaN, undefined))).toBe(true)
  })

  it('is continuous enough to be worth having', () => {
    // The walk samples neighbouring points; a hash read straight off the
    // lattice would jump between them and the filaments would never flow.
    const n = createNoise(11)
    let worst = 0
    for (let i = 0; i < 60; i++) {
      const x = i * 0.11
      worst = Math.max(worst, Math.abs(n(x, 0.5) - n(x + 0.01, 0.5)))
    }
    expect(worst).toBeLessThan(0.1)
  })
})

describe('the seed ring', () => {
  const model = createOrbModel({ seeds: 9, radius: 0.25, rotationSpeed: 1 })

  it('puts every seed on the ring, at the requested radius', () => {
    for (let i = 0; i < model.seeds; i++) {
      const { x, y } = model.seedAt(i)
      expect(fromCentre(x, y)).toBeCloseTo(0.25, 10)
    }
  })

  it('sweeps half a turn, because the mirror draws the other half', () => {
    const first = model.seedAt(0)
    const last = model.seedAt(model.seeds - 1)
    expect(first.x).toBeCloseTo(0.75, 10)
    expect(first.y).toBeCloseTo(0.5, 10)
    // half a turn round from the first
    expect(last.x).toBeCloseTo(0.25, 10)
    expect(last.y).toBeCloseTo(0.5, 10)
  })

  it('rotates with the spin ratio', () => {
    const spun = createOrbModel({ seeds: 9, radius: 0.25, rotationSpeed: 1 })
    quiet(spun, 36)
    expect(spun.spinRatio).toBeCloseTo(36 / 144, 10)
    const { x, y } = spun.seedAt(0)
    const angle = spun.spinRatio * Math.PI * 2
    expect(x).toBeCloseTo(0.5 + Math.cos(angle) * 0.25, 10)
    expect(y).toBeCloseTo(0.5 + Math.sin(angle) * 0.25, 10)
  })

  it('wraps the spin rather than letting the frame count grow without bound', () => {
    const spun = quiet(createOrbModel({ seeds: 4 }), 300)
    expect(spun.spinRatio).toBeGreaterThanOrEqual(0)
    expect(spun.spinRatio).toBeLessThan(1)
  })

  it('clamps a seed index rather than walking off the ring', () => {
    expect(model.seedAt(999)).toEqual(model.seedAt(model.seeds - 1))
    expect(model.seedAt(-4)).toEqual(model.seedAt(0))
  })
})

describe('the walk', () => {
  const build = (over = {}) => createOrbModel({
    seeds: 24, steps: 12, noise: createNoise(5), ...over
  })

  it('is deterministic under an injected noise field', () => {
    const a = computeFilament(build(), 7)
    const b = computeFilament(build(), 7)
    expect(Array.from(a)).toEqual(Array.from(b))
  })

  it('starts at the seed', () => {
    const model = build()
    const pts = computeFilament(model, 7)
    const seed = model.seedAt(7)
    expect(pts[0]).toBeCloseTo(seed.x, 6)
    expect(pts[1]).toBeCloseTo(seed.y, 6)
  })

  it('stays inside unit space', () => {
    // A long walk at a silly step size would otherwise leave the window.
    const model = build({ steps: 40, plotDiv: 0.2, noise: flat(0.9) })
    for (let i = 0; i < model.seeds; i++) {
      eachPoint(computeFilament(model, i), (x, y) => {
        expect(x).toBeGreaterThanOrEqual(0)
        expect(x).toBeLessThanOrEqual(1)
        expect(y).toBeGreaterThanOrEqual(0)
        expect(y).toBeLessThanOrEqual(1)
      })
    }
  })

  it('takes a step of plotDiv at a time', () => {
    // A flat field makes every turn identical, so the walk is a straight line
    // and the step size is readable off it.
    const model = build({ steps: 6, plotDiv: 0.013, noise: flat(0.5) })
    const pts = computeFilament(model, 3)
    const dx = pts[4] - pts[2]
    const dy = pts[5] - pts[3]
    expect(Math.hypot(dx, dy)).toBeCloseTo(0.013, 6)
  })

  it('varies filament length around the ring', () => {
    const model = build({ seeds: 40, steps: 14 })
    const lengths = new Set()
    for (let i = 0; i < model.seeds; i++) lengths.add(model.stepsAt(i))
    expect(lengths.size).toBeGreaterThan(3)
    expect(Math.min(...lengths)).toBeGreaterThanOrEqual(2)
    expect(Math.max(...lengths)).toBeLessThanOrEqual(14)
  })

  it('travels the long strands around the ring as it turns', () => {
    const model = build({ seeds: 40, steps: 14 })
    const longest = () => {
      let best = 0
      for (let i = 1; i < model.seeds; i++) {
        if (model.stepsAt(i) > model.stepsAt(best)) best = i
      }
      return best
    }
    const before = longest()
    quiet(model, 36)
    expect(longest()).not.toBe(before)
  })

  it('gives at least two points, so there is always a path to stroke', () => {
    const model = build({ steps: 2 })
    for (let i = 0; i < model.seeds; i++) {
      expect(computeFilament(model, i).length).toBeGreaterThanOrEqual(4)
    }
  })

  it('fills a scratch buffer rather than allocating per filament', () => {
    const model = build()
    const scratch = new Float32Array(model.steps * 2)
    const view = computeFilament(model, 5, scratch)
    expect(view.buffer).toBe(scratch.buffer)
    expect(Array.from(view)).toEqual(Array.from(computeFilament(model, 5)))
  })

  it('returns something empty rather than throwing on a garbage model', () => {
    expect(computeFilament(null, 0)).toHaveLength(0)
    expect(computeFilament({}, 0)).toHaveLength(0)
  })
})

describe('mirrorPoints', () => {
  it('is an exact point reflection through the centre', () => {
    const model = createOrbModel({ seeds: 16, steps: 10, noise: createNoise(2) })
    for (let i = 0; i < model.seeds; i++) {
      const pts = computeFilament(model, i)
      const mirror = mirrorPoints(pts)
      expect(mirror).toHaveLength(pts.length)
      eachPoint(pts, (x, y, j) => {
        expect(mirror[j * 2]).toBeCloseTo(1 - x, 6)
        expect(mirror[j * 2 + 1]).toBeCloseTo(1 - y, 6)
      })
    }
  })

  it('survives the clamp: a clamped point mirrors to a clamped point', () => {
    // clamp01 is symmetric about 0.5, which is the only reason the mirror
    // stays exact once a long walk runs into the edge of unit space.
    const model = createOrbModel({ seeds: 8, steps: 30, plotDiv: 0.2, noise: flat(0.2) })
    const pts = computeFilament(model, 2)
    const mirror = mirrorPoints(pts)
    eachPoint(mirror, (x, y) => {
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThanOrEqual(1)
      expect(y).toBeGreaterThanOrEqual(0)
      expect(y).toBeLessThanOrEqual(1)
    })
  })

  it('handles an empty path', () => {
    expect(mirrorPoints(new Float32Array(0))).toHaveLength(0)
    expect(mirrorPoints(null)).toHaveLength(0)
  })
})

describe('placePoints', () => {
  const rect = { cx: 150, cy: 150, size: 200 }

  it('puts the centre of unit space at the centre of the box', () => {
    expect(Array.from(placePoints(new Float32Array([0.5, 0.5]), rect))).toEqual([150, 150])
  })

  it('scales by the size', () => {
    expect(Array.from(placePoints(new Float32Array([1, 0]), rect))).toEqual([250, 50])
  })

  it('is finite for a garbage rect', () => {
    const out = placePoints(new Float32Array([0.5, 0.5]), null)
    expect(out.every(Number.isFinite)).toBe(true)
  })
})

describe('the zoom', () => {
  const model = () => createOrbModel({ zoomGain: 3, zoomThreshold: 0.02, zoomAttack: 0.2, zoomDecay: 0.05 })

  it('starts closed', () => {
    expect(model().zoom).toBe(1)
  })

  it('attacks toward the target without overshooting it', () => {
    const m = model()
    const target = 1 + (0.5 - 0.02) * 3
    let last = m.zoom
    for (let i = 0; i < 5; i++) {
      m.update({ level: 0.5 }, 1 / 30)
      expect(m.zoom).toBeGreaterThan(last)
      expect(m.zoom).toBeLessThanOrEqual(target)
      last = m.zoom
    }
  })

  it('clamps at the top however loud the room gets', () => {
    const m = model()
    for (let i = 0; i < 200; i++) m.update({ level: 1 }, 1 / 30)
    // the loudest possible room asks for 1 + (1 - threshold) * gain, and the
    // clamp at 1 + gain is the guard above that rather than the target
    expect(m.zoom).toBeLessThanOrEqual(4)
    expect(m.zoom).toBeCloseTo(3.94, 3)
  })

  it('never goes below 1', () => {
    const m = model()
    quiet(m, 200)
    expect(m.zoom).toBeGreaterThanOrEqual(1)
  })

  it('decays to exactly 1 in silence, rather than hovering open forever', () => {
    const m = model()
    for (let i = 0; i < 20; i++) m.update({ level: 0.6 }, 1 / 30)
    expect(m.zoom).toBeGreaterThan(1.5)
    quiet(m, 500)
    expect(m.zoom).toBe(1)
  })

  it('ignores a room quieter than the threshold', () => {
    const m = model()
    for (let i = 0; i < 30; i++) m.update({ level: 0.01 }, 1 / 30)
    expect(m.zoom).toBe(1)
  })

  it('stays finite when the signal is nonsense', () => {
    const m = model()
    m.update({ level: NaN, bass: undefined, mid: 'loud', treble: Infinity }, NaN)
    expect(Number.isFinite(m.zoom)).toBe(true)
    expect(Number.isFinite(m.level)).toBe(true)
    // an infinity is garbage, not a very loud room
    expect(m.bass).toBe(0)
    expect(m.mid).toBe(0)
    expect(m.treble).toBe(0)
  })

  it('resets everything the room put there', () => {
    const m = model()
    for (let i = 0; i < 20; i++) m.update({ level: 0.6, bass: 0.4 }, 1 / 30)
    m.reset()
    expect(m.zoom).toBe(1)
    expect(m.frame).toBe(0)
    expect(m.bass).toBe(0)
    expect(m.level).toBe(0)
  })
})

describe('the hue', () => {
  it('travels round the ring and stays in [0, 1)', () => {
    const m = createOrbModel({ seeds: 32, hueBase: 0.9, hueSpread: 0.25 })
    for (let i = 0; i < m.seeds; i++) {
      const h = m.hueAt(i)
      expect(h).toBeGreaterThanOrEqual(0)
      expect(h).toBeLessThan(1)
    }
    expect(m.hueAt(0)).not.toBeCloseTo(m.hueAt(m.seeds - 1), 3)
  })

  it('drifts, so the orb is never quite the colour it was a minute ago', () => {
    const m = createOrbModel({ hueBase: 0.5, hueDrift: 0.001 })
    quiet(m, 100)
    expect(m.baseHue).toBeCloseTo(0.6, 6)
  })

  it('warms with the bass, by as much as it is told to', () => {
    const m = createOrbModel({ hueBase: 0.5, hueDrift: 0, hueBass: 0.1 })
    const cold = m.hueAt(0)
    m.update({ bass: 1, level: 0 }, 1 / 30)
    expect(m.hueAt(0)).toBeCloseTo(cold + 0.1, 6)
  })

  it('covers under two fifths of the wheel, mirror and bass included', () => {
    // Wider than that and the mandala reads as a rainbow rather than as one
    // object in one colour. Measured on screen; the three numbers that add up
    // to it are easy to raise one at a time without noticing the total.
    const m = createOrbModel({ seeds: 64, hueBase: 0, hueDrift: 0 })
    m.update({ bass: 1, level: 0 }, 1 / 30)
    let widest = 0
    for (let i = 0; i < m.seeds; i++) {
      widest = Math.max(widest, m.hueAt(i), (m.hueAt(i) + m.divHue) % 1)
    }
    expect(widest).toBeLessThan(0.4)
  })
})

describe('the inner orb', () => {
  // The app's own voice: the same generator, turned the other way, smaller.
  const outer = createOrbModel({ seeds: 24, radius: 0.25, rotationSpeed: 1 })
  const inner = createOrbModel({ seeds: 24, radius: 0.1, rotationSpeed: -1 })

  it('sits inside the outer ring', () => {
    for (let i = 0; i < inner.seeds; i++) {
      const { x, y } = inner.seedAt(i)
      expect(fromCentre(x, y)).toBeLessThan(outer.radius)
    }
  })

  it('turns against the outer one', () => {
    quiet(outer, 36)
    quiet(inner, 36)
    // wrap01 of a negative spin lands the same distance the other side of 1
    expect(outer.spinRatio + inner.spinRatio).toBeCloseTo(1, 10)
  })

  it('keeps the mirror, so the small one is a mandala too', () => {
    const pts = computeFilament(inner, 5)
    const mirror = mirrorPoints(pts)
    eachPoint(pts, (x, y, j) => {
      expect(mirror[j * 2]).toBeCloseTo(1 - x, 6)
      expect(mirror[j * 2 + 1]).toBeCloseTo(1 - y, 6)
    })
  })

  it('drifts its hue the other way too', () => {
    const warm = createOrbModel({ hueBase: 0.02, hueDrift: 0.001, rotationSpeed: -1 })
    quiet(warm, 10)
    expect(warm.baseHue).toBeCloseTo(0.01, 6)
  })
})
