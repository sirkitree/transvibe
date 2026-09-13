import { describe, it, expect } from 'vitest'
import { createVad } from '../src/renderer/vad.js'
import { captureStart, captureHangover } from '../src/renderer/capture-timing.js'

describe('conversation pauses and quiet word beginnings', () => {
  it('keeps an 800ms pause inside a conversation turn', () => {
    const vad = createVad({ hangoverMs: captureHangover(true), minSegmentMs: 250 })
    const levels = [...Array(50).fill(.2), ...Array(40).fill(0), ...Array(50).fill(.2), ...Array(50).fill(0)]
    const ends = levels.map(level => vad.push(level)).filter(e => e?.type === 'end')
    expect(ends).toHaveLength(1)
    expect(captureHangover(false)).toBe(550)
  })
  it('retains 200ms before onset without including previous playback or utterances', () => {
    expect(captureStart(100, 0)).toBe(90)
    expect(captureStart(100, 98)).toBe(98)
    expect(captureStart(4, 0)).toBe(0)
  })
})
