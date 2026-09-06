import { describe, it, expect } from 'vitest'
import { stripBounds, orbBounds, contains, withinCircle, nextWake, STRIP_HEIGHT, ORB_SIZE } from '../src/main/overlay.js'

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

describe('orbBounds', () => {
  it('sits in the lower-left of the work area, inset by the margin', () => {
    // 25 + 920 - 300 - 24
    expect(orbBounds(display)).toEqual({ x: 24, y: 621, width: 300, height: 300 })
  })

  it('follows a display that is not at the origin', () => {
    const right = { workArea: { x: 1512, y: 0, width: 1920, height: 1080 } }
    expect(orbBounds(right, { size: 200, margin: 40 }))
      .toEqual({ x: 1552, y: 840, width: 200, height: 200 })
  })

  it('rises with the Dock, because the work area already excludes it', () => {
    const docked = { workArea: { x: 0, y: 25, width: 1512, height: 830 } }
    const free = { workArea: { x: 0, y: 25, width: 1512, height: 920 } }
    expect(free.workArea.height - docked.workArea.height)
      .toBe(orbBounds(free).y - orbBounds(docked).y)
  })

  it('shrinks to fit a display too small for the size asked for', () => {
    const small = { workArea: { x: 0, y: 0, width: 800, height: 200 } }
    const rect = orbBounds(small, { size: 300, margin: 24 })
    expect(rect.width).toBe(152)
    expect(rect.height).toBe(152)
    expect(rect.y).toBe(24)
  })

  it('stays square, and never smaller than something worth drawing', () => {
    const tiny = { workArea: { x: 0, y: 0, width: 100, height: 100 } }
    const rect = orbBounds(tiny, { size: 300 })
    expect(rect.width).toBe(rect.height)
    expect(rect.width).toBe(120)
  })

  it('has a floor, so a silly size still leaves something to see', () => {
    expect(orbBounds(display, { size: 4 }).width).toBe(120)
  })

  it('takes a zero margin literally', () => {
    expect(orbBounds(display, { size: 200, margin: 0 })).toEqual({
      x: 0, y: 745, width: 200, height: 200
    })
  })

  it('falls back to display bounds when there is no work area', () => {
    expect(orbBounds({ bounds: { x: 0, y: 0, width: 1000, height: 700 } }).y).toBe(376)
  })

  it('returns something usable for a garbage display', () => {
    expect(orbBounds(null).width).toBe(ORB_SIZE)
    expect(orbBounds({ workArea: { x: 0, y: 0 } }).height).toBe(ORB_SIZE)
    expect(orbBounds(display, { size: NaN, margin: NaN }).width).toBe(ORB_SIZE)
  })
})

describe('withinCircle', () => {
  const rect = { x: 100, y: 200, width: 300, height: 300 }

  it('takes the middle and the four cardinal edges', () => {
    expect(withinCircle(rect, { x: 250, y: 350 })).toBe(true)
    expect(withinCircle(rect, { x: 100, y: 350 })).toBe(true)
    expect(withinCircle(rect, { x: 400, y: 350 })).toBe(true)
    expect(withinCircle(rect, { x: 250, y: 200 })).toBe(true)
    expect(withinCircle(rect, { x: 250, y: 500 })).toBe(true)
  })

  it('rejects the corners, which is the whole reason it exists', () => {
    // Just inside the window and well outside the orb. Testing the square
    // would have the orb swallowing the pointer where nothing is drawn.
    for (const p of [{ x: 105, y: 205 }, { x: 395, y: 205 }, { x: 105, y: 495 }, { x: 395, y: 495 }]) {
      expect(contains(rect, p)).toBe(true)
      expect(withinCircle(rect, p)).toBe(false)
    }
  })

  it('shrinks by the inset', () => {
    const edge = { x: 250, y: 202 }
    expect(withinCircle(rect, edge)).toBe(true)
    expect(withinCircle(rect, edge, { inset: 8 })).toBe(false)
  })

  it('uses the shorter side, so an off-square window still gets a circle', () => {
    const wide = { x: 0, y: 0, width: 400, height: 200 }
    expect(withinCircle(wide, { x: 200, y: 5 })).toBe(true)
    expect(withinCircle(wide, { x: 20, y: 100 })).toBe(false)
  })

  it('is false rather than throwing on nonsense', () => {
    expect(withinCircle(null, { x: 1, y: 1 })).toBe(false)
    expect(withinCircle(rect, null)).toBe(false)
    expect(withinCircle(rect, { x: NaN, y: 1 })).toBe(false)
    expect(withinCircle({ x: 0, y: 0 }, { x: 0, y: 0 })).toBe(false)
  })

  it('is empty when the inset eats the whole circle', () => {
    expect(withinCircle(rect, { x: 250, y: 350 }, { inset: 150 })).toBe(false)
    expect(withinCircle(rect, { x: 250, y: 350 }, { inset: 999 })).toBe(false)
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
  const sleeping = { awake: false, insideSince: null, outsideSince: null }

  it('does not wake the instant the pointer arrives', () => {
    const s = nextWake(sleeping, { inside: true, now: 1000, wakeDelayMs: 200 })
    expect(s).toEqual({ awake: false, insideSince: 1000, outsideSince: null })
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
    expect(s).toEqual({ awake: false, insideSince: null, outsideSince: null })
    s = nextWake(s, { inside: true, now: 1150, wakeDelayMs: 200 })
    s = nextWake(s, { inside: true, now: 1300, wakeDelayMs: 200 })
    expect(s.awake).toBe(false)   // dwell measured from 1150, not from 1000
  })

  it('holds the wake briefly when the pointer crosses a gap', () => {
    // the trip from the transcript down to the button row
    const awake = { awake: true, insideSince: 1000, outsideSince: null }
    let s = nextWake(awake, { inside: false, now: 2000, sleepDelayMs: 250 })
    expect(s).toEqual({ awake: true, insideSince: 1000, outsideSince: 2000 })
    s = nextWake(s, { inside: false, now: 2100, sleepDelayMs: 250 })
    expect(s.awake).toBe(true)
    // back on a control before the grace runs out: still awake, still dwelled
    s = nextWake(s, { inside: true, now: 2150, sleepDelayMs: 250 })
    expect(s).toEqual({ awake: true, insideSince: 1000, outsideSince: null })
  })

  it('sleeps once the pointer has been gone longer than the grace', () => {
    const awake = { awake: true, insideSince: 1000, outsideSince: null }
    let s = nextWake(awake, { inside: false, now: 2000, sleepDelayMs: 250 })
    s = nextWake(s, { inside: false, now: 2250, sleepDelayMs: 250 })
    expect(s).toEqual({ awake: false, insideSince: null, outsideSince: null })
  })

  it('stays awake off-strip while the renderer holds it', () => {
    const awake = { awake: true, insideSince: 1000, outsideSince: null }
    expect(nextWake(awake, { inside: false, hold: true, now: 2000 }))
      .toEqual({ awake: true, insideSince: null, outsideSince: null })
  })

  it('does not let a hold wake a sleeping strip on its own', () => {
    expect(nextWake(sleeping, { inside: false, hold: true, now: 2000 }).awake).toBe(false)
  })

  it('tolerates a missing previous state', () => {
    expect(nextWake(undefined, { inside: false, now: 5 }))
      .toEqual({ awake: false, insideSince: null, outsideSince: null })
  })
})
