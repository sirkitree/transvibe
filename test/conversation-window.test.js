import { describe, it, expect } from 'vitest'
import { createConversationWindow } from '../src/renderer/conversation-window.js'

describe('conversation follow-up timing', () => {
  function setup () {
    let time = 0
    return { window: createConversationWindow(() => time), advance: ms => { time += ms } }
  }

  it('gives the full window after a reply longer than the window, including its echo tail', () => {
    const { window, advance } = setup()
    window.open(25000)
    window.pause()
    advance(90000)
    expect(window.isOpen()).toBe(true)
    advance(300) // microphone is still muted during the echo tail
    window.resume()
    advance(24999)
    expect(window.isOpen()).toBe(true)
    advance(1)
    expect(window.isOpen()).toBe(false)
  })

  it('starts immediately for text-only answers and bare wake phrases', () => {
    const { window, advance } = setup()
    window.open(25000)
    advance(25000)
    expect(window.isOpen()).toBe(false)
  })

  it('waits for every overlapping speech operation to finish', () => {
    const { window, advance } = setup()
    window.open(25000)
    window.pause()
    window.pause()
    window.resume()
    advance(90000)
    expect(window.isOpen()).toBe(true)
    window.resume()
    advance(25000)
    expect(window.isOpen()).toBe(false)
  })

  it('cannot reopen a cleared conversation when speech completes', () => {
    const { window } = setup()
    window.open(25000)
    window.pause()
    window.clear()
    window.resume()
    expect(window.isOpen()).toBe(false)
  })

  it('does not revive expired threads for unrelated speech', () => {
    const { window, advance } = setup()
    window.open(25000)
    advance(25000)
    window.pause()
    window.resume()
    expect(window.isOpen()).toBe(false)
  })

  it('keeps zero disabled, even through speech', () => {
    const { window } = setup()
    window.open(0)
    window.pause()
    expect(window.isOpen()).toBe(false)
    window.resume()
    expect(window.isOpen()).toBe(false)
  })

  it('defers a new answer received while another speech operation is active', () => {
    const { window, advance } = setup()
    window.pause()
    window.open(25000)
    advance(90000)
    window.resume()
    expect(window.isOpen()).toBe(true)
    advance(25000)
    expect(window.isOpen()).toBe(false)
  })
})
