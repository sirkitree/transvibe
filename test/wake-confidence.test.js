import { describe, it, expect } from 'vitest'
import { acceptShortAddress } from '../src/shared/wake-confidence.js'

const sample = { text: 'Hey Mira.', confidence: -0.7303, durationMs: 1000, names: ['Hey Mira', 'Hi Mira'], gated: true, interim: false }
describe('short-address confidence fallback', () => {
  it('retains both rejected addresses from the recording', () => {
    expect(acceptShortAddress(sample)).toBe(true)
    expect(acceptShortAddress({ ...sample, text: 'Hi Mira.', confidence: -.7962 })).toBe(true)
  })
  it('does not relax commands, dictation, fuzzy names, ungated audio, or very weak guesses', () => {
    for (const patch of [{ text: 'Hey Mira delete everything' }, { text: 'I said hey Mira' }, { text: 'Hey Miro' }, { text: 'Mira' }, { gated: false }, { interim: true }, { confidence: -.9 }, { confidence: null }, { durationMs: 240 }, { durationMs: 3000 }]) {
      expect(acceptShortAddress({ ...sample, ...patch }), JSON.stringify(patch)).toBe(false)
    }
  })
})
