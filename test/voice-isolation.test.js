import { it, expect, vi } from 'vitest'
import { configureVoiceIsolation } from '../src/renderer/voice-isolation.js'
it('verifies actual activation, not just acceptance of the constraint', async () => {
 const track = { getCapabilities: () => ({ voiceIsolation: [true, false] }), getSettings: () => ({ voiceIsolation: true }), applyConstraints: vi.fn() }
 expect(await configureVoiceIsolation(track, true)).toEqual({ requested: true, supported: true, active: true })
 expect(track.applyConstraints).toHaveBeenCalledWith({ voiceIsolation: { exact: true } })
 track.getSettings = () => ({ voiceIsolation: false })
 expect((await configureVoiceIsolation(track, true)).active).toBe(false)
})
it('keeps the microphone usable when isolation is unsupported or rejected', async () => {
 const track = { getCapabilities: () => ({}), getSettings: () => ({}), applyConstraints: vi.fn() }
 expect(await configureVoiceIsolation(track, true)).toMatchObject({ supported: false, active: false })
 expect(track.applyConstraints).not.toHaveBeenCalled()
 track.getCapabilities = () => ({ voiceIsolation: [false, true] })
 track.applyConstraints = vi.fn().mockRejectedValue(new Error('not available'))
 expect(await configureVoiceIsolation(track, true)).toMatchObject({ active: false, error: 'not available' })
})
it('can disable isolation again', async () => {
 const track = { getCapabilities: () => ({ voiceIsolation: [true, false] }), getSettings: () => ({ voiceIsolation: false }), applyConstraints: vi.fn() }
 expect((await configureVoiceIsolation(track, false)).active).toBe(false)
 expect(track.applyConstraints).toHaveBeenCalledWith({ voiceIsolation: { exact: false } })
})
