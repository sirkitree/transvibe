import { describe, it, expect } from 'vitest'
import { createWaiting } from '../src/renderer/waiting.js'

const make = () => createWaiting({ nudgeMs: 10000, timeoutMs: 30000 })

const started = (now = 0, agent = { name: 'Claude', hue: 0.55 }) => {
  const w = make()
  w.start(now, agent)
  return w
}

/* How many times the dot passes through the middle of its swing — a rate, read
   off the pulse without the module having to expose one. */
const crossings = (w, from, to) => {
  let count = 0
  for (let t = from + 5; t < to; t += 5) {
    if ((w.pulse(t - 5) - 0.5) * (w.pulse(t) - 0.5) < 0) count++
  }
  return count
}

describe('waiting', () => {
  it('is idle until a call goes out', () => {
    const w = make()
    expect(w.phase(0)).toBe('idle')
    expect(w.label(0)).toBe('')
    expect(w.elapsed(5000)).toBe(0)
    expect(w.holdsStrip).toBe(false)
  })

  it('counts from the moment the call went out', () => {
    const w = started(1000)
    expect(w.elapsed(3700)).toBe(2700)
    expect(w.phase(3700)).toBe('waiting')
  })

  it('names who is being waited on, and how long it has been', () => {
    const w = started(0)
    expect(w.label(0)).toBe('Claude · 0s')
    expect(w.label(2700)).toBe('Claude · 2s')
    expect(w.label(14100)).toBe('Claude · 14s')
  })

  it('floors the seconds, so the number never claims time that has not passed', () => {
    const w = started(0)
    expect(w.label(999)).toBe('Claude · 0s')
    expect(w.label(1999)).toBe('Claude · 1s')
  })

  it('shows just the count when there is nobody to name', () => {
    const w = make()
    w.start(0, {})
    expect(w.label(4000)).toBe('4s')
  })

  it('turns slow at the nudge, because that is what slow means here', () => {
    const w = started(0)
    expect(w.phase(9999)).toBe('waiting')
    expect(w.phase(10000)).toBe('slow')
  })

  it('gives up at the timeout', () => {
    const w = started(0)
    expect(w.phase(29999)).toBe('slow')
    expect(w.phase(30000)).toBe('timedOut')
  })

  it('never speaks for a call that comes back inside the nudge window', () => {
    // The measured claude path: 2.7s, and the user should hear nothing about it.
    const w = started(0)
    expect(w.shouldNudge(2700)).toBe(false)
    w.stop()
    expect(w.shouldNudge(2700)).toBe(false)
  })

  it('speaks exactly once for a call that outlasts the nudge window', () => {
    // The measured codex-with-web-search path: 14.1s.
    const w = started(0, { name: 'Codex', hue: 0.14 })
    expect(w.shouldNudge(9999)).toBe(false)
    expect(w.shouldNudge(10000)).toBe(true)
    expect(w.shouldNudge(10016)).toBe(false)
    expect(w.shouldNudge(14100)).toBe(false)
  })

  it('says who it is still waiting on', () => {
    const w = started(0, { name: 'Codex', hue: 0.14 })
    expect(w.nudgeText).toBe('Still waiting on Codex')
  })

  it('arms the nudge again for the next call', () => {
    const w = started(0)
    expect(w.shouldNudge(11000)).toBe(true)
    w.stop()
    w.start(20000, { name: 'Claude', hue: 0.55 })
    expect(w.shouldNudge(31000)).toBe(true)
  })

  it('holds the strip awake for exactly as long as the call is out', () => {
    // Without this the transcript fades at idleFadeMs = 6000, mid-call.
    const w = make()
    expect(w.holdsStrip).toBe(false)
    w.start(0, { name: 'Claude' })
    expect(w.holdsStrip).toBe(true)
    w.stop()
    expect(w.holdsStrip).toBe(false)
  })

  it('forgets the call when it is stopped', () => {
    const w = started(0)
    w.stop()
    expect(w.phase(40000)).toBe('idle')
    expect(w.label(40000)).toBe('')
    expect(w.pulse(40000)).toBe(0)
  })

  it('keeps the agent colour so the bubble matches the answer', () => {
    const w = started(0, { name: 'Claude', hue: 0.55 })
    expect(w.hue).toBe(0.55)
    expect(w.name).toBe('Claude')
  })

  it('draws the same pulse for the same moment', () => {
    const w = started(0)
    expect(w.pulse(3300)).toBe(w.pulse(3300))
  })

  it('keeps the pulse inside the range an animation can use', () => {
    const w = started(0)
    for (let t = 0; t < 30000; t += 97) {
      const p = w.pulse(t)
      expect(p).toBeGreaterThanOrEqual(0)
      expect(p).toBeLessThanOrEqual(1)
    }
  })

  it('breathes rather than sitting still', () => {
    const w = started(0)
    expect(w.pulse(0)).not.toBeCloseTo(w.pulse(500), 3)
  })

  it('does not jump when the wait turns slow, only speeds up', () => {
    const w = started(0)
    // Continuous across the knee: a step here would read as a dropped frame.
    expect(w.pulse(10001)).toBeCloseTo(w.pulse(9999), 2)
    expect(crossings(w, 11000, 15000)).toBeGreaterThan(crossings(w, 1000, 5000))
  })

  it('stops the dot dead once the call has timed out', () => {
    const w = started(0)
    expect(w.pulse(29999)).toBeGreaterThan(0)
    expect(w.pulse(30000)).toBe(0)
  })

  it('hands a frame everything it needs in one call', () => {
    const w = started(0, { name: 'Codex', hue: 0.14 })
    const frame = w.tick(11000)
    expect(frame.phase).toBe('slow')
    expect(frame.label).toBe('Codex · 11s')
    expect(frame.nudge).toBe(true)
    expect(frame.holdsStrip).toBe(true)
    expect(w.tick(11016).nudge).toBe(false)
  })

  it('survives a clock that hands it nonsense', () => {
    const w = make()
    w.start(Number.NaN, { name: 'Claude' })
    expect(w.elapsed(Number.NaN)).toBe(0)
    expect(w.label(1000)).toBe('Claude · 1s')
  })

  it('never counts backwards if the clock does', () => {
    const w = started(5000)
    expect(w.elapsed(4000)).toBe(0)
    expect(w.phase(4000)).toBe('waiting')
  })
})
