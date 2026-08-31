import { describe, it, expect } from 'vitest'
import { stripBounds, contains, nextWake, STRIP_HEIGHT } from '../src/main/overlay.js'

const display = { workArea: { x: 0, y: 25, width: 1512, height: 920 } }

describe('stripBounds', () => {
  it('spans the work area and hangs from its top edge', () => {
    expect(stripBounds(display)).toEqual({ x: 0, y: 25, width: 1512, height: STRIP_HEIGHT })
  })

  it('follows a display that is not at the origin', () => {
    const right = { workArea: { x: 1512, y: 0, width: 1920, height: 1080 } }
    expect(stripBounds(right, { height: 300 })).toEqual({ x: 1512, y: 0, width: 1920, height: 300 })
  })

  it('never grows taller than the display', () => {
    const short = { workArea: { x: 0, y: 0, width: 800, height: 150 } }
    expect(stripBounds(short, { height: 560 }).height).toBe(150)
  })

  it('has a floor, so a silly height still leaves something to see', () => {
    expect(stripBounds(display, { height: 4 }).height).toBe(90)
  })

  it('falls back to display bounds when there is no work area', () => {
    expect(stripBounds({ bounds: { x: 0, y: 0, width: 1000, height: 700 } }).width).toBe(1000)
  })

  it('returns something usable for a garbage display', () => {
    expect(stripBounds(null).height).toBe(STRIP_HEIGHT)
    expect(stripBounds({ workArea: { x: 0, y: 0 } }).width).toBe(1280)
  })
})

describe('contains', () => {
  const rect = { x: 0, y: 25, width: 100, height: 50 }

  it('includes the top-left corner and excludes the far edges', () => {
    expect(contains(rect, { x: 0, y: 25 })).toBe(true)
    expect(contains(rect, { x: 100, y: 40 })).toBe(false)
    expect(contains(rect, { x: 50, y: 75 })).toBe(false)
  })

  it('rejects points above the strip', () => {
    expect(contains(rect, { x: 50, y: 24 })).toBe(false)
  })

  it('is false rather than throwing on nonsense', () => {
    expect(contains(null, { x: 1, y: 1 })).toBe(false)
    expect(contains(rect, null)).toBe(false)
    expect(contains(rect, { x: NaN, y: 1 })).toBe(false)
  })
})

describe('nextWake', () => {
  const sleeping = { awake: false, insideSince: null }

  it('does not wake the instant the pointer arrives', () => {
    const s = nextWake(sleeping, { inside: true, now: 1000, wakeDelayMs: 200 })
    expect(s).toEqual({ awake: false, insideSince: 1000 })
  })

  it('wakes once the pointer has dwelled long enough', () => {
    let s = nextWake(sleeping, { inside: true, now: 1000, wakeDelayMs: 200 })
    s = nextWake(s, { inside: true, now: 1100, wakeDelayMs: 200 })
    expect(s.awake).toBe(false)
    s = nextWake(s, { inside: true, now: 1200, wakeDelayMs: 200 })
    expect(s.awake).toBe(true)
  })

  it('restarts the dwell after a pass-through', () => {
    let s = nextWake(sleeping, { inside: true, now: 1000, wakeDelayMs: 200 })
    s = nextWake(s, { inside: false, now: 1100, wakeDelayMs: 200 })
    expect(s).toEqual({ awake: false, insideSince: null })
    s = nextWake(s, { inside: true, now: 1150, wakeDelayMs: 200 })
    s = nextWake(s, { inside: true, now: 1300, wakeDelayMs: 200 })
    expect(s.awake).toBe(false)   // dwell measured from 1150, not from 1000
  })

  it('sleeps as soon as the pointer leaves', () => {
    const awake = { awake: true, insideSince: 1000 }
    expect(nextWake(awake, { inside: false, now: 2000 })).toEqual({ awake: false, insideSince: null })
  })

  it('stays awake off-strip while the renderer holds it', () => {
    const awake = { awake: true, insideSince: 1000 }
    expect(nextWake(awake, { inside: false, hold: true, now: 2000 }))
      .toEqual({ awake: true, insideSince: null })
  })

  it('does not let a hold wake a sleeping strip on its own', () => {
    expect(nextWake(sleeping, { inside: false, hold: true, now: 2000 }).awake).toBe(false)
  })

  it('tolerates a missing previous state', () => {
    expect(nextWake(undefined, { inside: false, now: 5 })).toEqual({ awake: false, insideSince: null })
  })
})
