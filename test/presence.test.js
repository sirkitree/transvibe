import { describe, it, expect } from 'vitest'
import { createPresence } from '../src/renderer/presence.js'

const make = () => createPresence({ idleFadeMs: 6000 })

describe('presence', () => {
  it('keeps the transcript up while speech keeps arriving', () => {
    const p = make()
    p.activity(0)
    expect(p.tick(5900).faded).toBe(false)
    p.activity(5900)
    expect(p.tick(11000).faded).toBe(false)
  })

  it('fades once nothing has happened for the idle window', () => {
    const p = make()
    p.activity(0)
    expect(p.tick(5999).faded).toBe(false)
    expect(p.tick(6000).faded).toBe(true)
  })

  it('reports the transition exactly once', () => {
    const p = make()
    p.activity(0)
    expect(p.tick(6000).changed).toBe(true)
    expect(p.tick(7000).changed).toBe(false)
  })

  it('never fades while the pointer is on the strip', () => {
    const p = make()
    p.activity(0)
    p.setAwake(true, 100)
    expect(p.tick(60000).faded).toBe(false)
  })

  it('restarts the clock when a panel closes, not from the last word', () => {
    const p = make()
    p.activity(0)
    p.setHeld(true, 100)
    p.tick(30000)
    p.setHeld(false, 30000)
    expect(p.tick(35000).faded).toBe(false)
    expect(p.tick(36000).faded).toBe(true)
  })

  it('never fades while a panel is holding it open', () => {
    const p = make()
    p.activity(0)
    p.setHeld(true, 0)
    expect(p.tick(60000).faded).toBe(false)
  })

  it('starts the clock again when the pointer leaves, not from the last word', () => {
    const p = make()
    p.activity(0)
    p.setAwake(true, 1000)
    p.tick(30000)
    p.setAwake(false, 30000)
    expect(p.tick(35000).faded).toBe(false)   // 5s since the pointer left
    expect(p.tick(36000).faded).toBe(true)
  })

  it('un-fades the moment something is said', () => {
    const p = make()
    p.activity(0)
    expect(p.tick(9000).faded).toBe(true)
    p.activity(9500)
    expect(p.faded).toBe(false)
    expect(p.tick(9500).faded).toBe(false)
  })

  it('un-fades when the pointer arrives, without waiting for a tick', () => {
    const p = make()
    p.activity(0)
    p.tick(9000)
    p.setAwake(true, 9100)
    expect(p.faded).toBe(false)
  })

  it('treats faded text as stale, so the next utterance replaces it', () => {
    const p = make()
    p.activity(0)
    expect(p.stale).toBe(false)
    p.tick(6000)
    expect(p.stale).toBe(true)
    p.activity(6100)
    expect(p.stale).toBe(false)
  })

  it('holding does not un-fade on its own — it only stops the next fade', () => {
    const p = make()
    p.activity(0)
    p.tick(6000)
    p.setHeld(true, 6000)
    expect(p.faded).toBe(true)
    expect(p.tick(6001).faded).toBe(false)
  })
})
