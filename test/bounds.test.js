import { describe, it, expect } from 'vitest'
import { usableBounds, DEFAULT_BOUNDS, MIN_WIDTH, MIN_HEIGHT } from '../src/main/bounds.js'

const laptop = { workArea: { x: 0, y: 25, width: 1512, height: 957 } }
const external = { workArea: { x: 1512, y: 0, width: 2560, height: 1440 } }
const displays = [laptop, external]

describe('usableBounds', () => {
  it('falls back to the default size with no saved bounds', () => {
    expect(usableBounds(null, displays)).toEqual(DEFAULT_BOUNDS)
    expect(usableBounds(undefined, displays)).toEqual(DEFAULT_BOUNDS)
    expect(usableBounds('nonsense', displays)).toEqual(DEFAULT_BOUNDS)
  })

  it('restores a position fully inside a display', () => {
    const saved = { x: 200, y: 120, width: 640, height: 720 }
    expect(usableBounds(saved, displays)).toEqual(saved)
  })

  it('restores a position on a secondary display', () => {
    const saved = { x: 1800, y: 300, width: 520, height: 640 }
    expect(usableBounds(saved, displays)).toEqual(saved)
  })

  it('drops the position when the display it was on is gone', () => {
    // saved on the external monitor, which has since been unplugged
    const saved = { x: 2400, y: 700, width: 520, height: 640 }
    const result = usableBounds(saved, [laptop])
    expect(result).toEqual({ width: 520, height: 640 })
    expect(result.x).toBeUndefined()
    expect(result.y).toBeUndefined()
  })

  it('keeps the size but not the position when nothing is plugged in', () => {
    const saved = { x: 200, y: 120, width: 700, height: 800 }
    expect(usableBounds(saved, [])).toEqual({ width: 700, height: 800 })
  })

  it('rejects a position that barely clips a display corner', () => {
    // only 20px of overlap in x — not enough to grab
    const saved = { x: 1492, y: 940, width: 520, height: 640 }
    expect(usableBounds(saved, [laptop]).x).toBeUndefined()
  })

  it('accepts a partly off-screen window with a usable grab area', () => {
    const saved = { x: -100, y: 100, width: 520, height: 640 }
    expect(usableBounds(saved, [laptop])).toEqual(saved)
  })

  it('raises an undersized window to the minimum', () => {
    const r = usableBounds({ x: 10, y: 40, width: 100, height: 50 }, displays)
    expect(r.width).toBe(MIN_WIDTH)
    expect(r.height).toBe(MIN_HEIGHT)
  })

  it('survives non-finite and missing values', () => {
    for (const saved of [
      { x: NaN, y: 10, width: 520, height: 640 },
      { x: 10, y: Infinity, width: 520, height: 640 },
      { x: 10, y: 10, width: NaN, height: 640 },
      { width: 520, height: 640 },
      {}
    ]) {
      const r = usableBounds(saved, displays)
      expect(Number.isFinite(r.width)).toBe(true)
      expect(Number.isFinite(r.height)).toBe(true)
      expect(r.width).toBeGreaterThanOrEqual(MIN_WIDTH)
      expect(r.height).toBeGreaterThanOrEqual(MIN_HEIGHT)
    }
  })

  it('ignores a malformed display entry rather than throwing', () => {
    const saved = { x: 200, y: 120, width: 640, height: 720 }
    expect(() => usableBounds(saved, [null, {}, { workArea: {} }])).not.toThrow()
    expect(usableBounds(saved, [null, {}, { workArea: {} }]).x).toBeUndefined()
    expect(usableBounds(saved, [null, laptop]).x).toBe(200)
  })

  it('does not mutate the saved object', () => {
    const saved = { x: 200, y: 120, width: 640, height: 720 }
    const copy = { ...saved }
    usableBounds(saved, displays)
    expect(saved).toEqual(copy)
  })
})
