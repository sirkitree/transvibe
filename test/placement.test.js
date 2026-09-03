import { describe, it, expect } from 'vitest'
import { clampPlacement, heightFor, isReachable, MARGIN } from '../src/renderer/placement.js'

const panel = { width: 600, height: 480 }
const view = { width: 1440, height: 700 }

describe('clampPlacement', () => {
  it('leaves a position that is already on screen alone', () => {
    expect(clampPlacement({ x: 200, y: 120 }, panel, view)).toEqual({ x: 200, y: 120 })
  })

  it('holds the panel inside the sides', () => {
    // Half off the edge is half its buttons gone.
    expect(clampPlacement({ x: -400, y: 40 }, panel, view).x).toBe(MARGIN)
    expect(clampPlacement({ x: 5000, y: 40 }, panel, view).x)
      .toBe(view.width - panel.width - MARGIN)
  })

  it('will not let it ride up past the top of the window', () => {
    expect(clampPlacement({ x: 100, y: -300 }, panel, view).y).toBe(0)
  })

  it('lets it go down as far as it likes — the window follows', () => {
    expect(clampPlacement({ x: 100, y: 2000 }, panel, view).y).toBe(2000)
  })

  it('puts a panel wider than the window at the edge rather than off it', () => {
    expect(clampPlacement({ x: 400, y: 0 }, { width: 2000, height: 400 }, view).x).toBe(MARGIN)
  })

  it('survives junk rather than placing something at NaN', () => {
    expect(clampPlacement(null, panel, view)).toEqual({ x: MARGIN, y: 0 })
    expect(clampPlacement({ x: NaN, y: NaN }, panel, view)).toEqual({ x: MARGIN, y: 0 })
  })
})

describe('heightFor', () => {
  it('asks for a window tall enough to hold the panel', () => {
    // Anything past the window's bottom edge is not clipped, it is unclickable.
    expect(heightFor({ y: 100 }, { height: 480 }, 900)).toBe(100 + 480 + MARGIN)
  })

  it('never asks for more than the screen has', () => {
    expect(heightFor({ y: 800 }, { height: 480 }, 900)).toBe(900)
  })

  it('copes with a missing limit', () => {
    expect(heightFor({ y: 10 }, { height: 100 }, undefined)).toBe(10 + 100 + MARGIN)
  })
})

describe('isReachable', () => {
  it('takes a position that still lands on this window', () => {
    expect(isReachable({ x: 200, y: 100 }, view)).toBe(true)
  })

  it('refuses one from a screen that is not here any more', () => {
    // Put down on a second display, reopened on the laptop alone.
    expect(isReachable({ x: 2600, y: 100 }, view)).toBe(false)
    expect(isReachable({ x: -900, y: 100 }, view)).toBe(false)
  })

  it('treats no position as no position', () => {
    expect(isReachable(null, view)).toBe(false)
    expect(isReachable({ x: 'left', y: 0 }, view)).toBe(false)
  })
})
