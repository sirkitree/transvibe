import { it, expect } from 'vitest'
import { createInterimPolicy } from '../src/renderer/interim-policy.js'

it('backs off non-speech previews and bounds the rechecked audio', () => {
  const policy = createInterimPolicy(), token = policy.newSegment()
  expect(policy.intervalMs(500)).toBe(500)
  expect(policy.fromFrame(0, 700)).toBe(0)
  policy.observe({ text: '', dropped: 'no speech' }, token)
  expect(policy.intervalMs(500)).toBe(1000)
  policy.observe({ text: '', dropped: 'not speech' }, token)
  expect(policy.intervalMs(500)).toBe(2000)
  expect(policy.fromFrame(0, 700)).toBe(601)
  expect(policy.fromFrame(680, 700)).toBe(680)
})

it('returns to normal previews immediately when speech is recognized', () => {
  const policy = createInterimPolicy(), token = policy.newSegment()
  policy.observe({ text: '', dropped: 'no speech' }, token)
  policy.observe({ text: 'Hey Mira' }, token)
  expect(policy.intervalMs(500)).toBe(500)
  expect(policy.fromFrame(0, 700)).toBe(0)
})

it('ignores old results and busy skips, retaining backoff across music segments', () => {
  const policy = createInterimPolicy(), old = policy.newSegment()
  policy.observe({ text: '', dropped: 'no speech' }, old)
  const current = policy.newSegment()
  policy.observe({ text: 'stale speech' }, old)
  policy.observe(undefined, current)
  policy.observe({ error: 'unavailable' }, current)
  expect(policy.intervalMs(500)).toBe(1000)
  expect(policy.intervalMs(3000)).toBe(3000)
})
