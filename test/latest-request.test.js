import { describe, it, expect, vi } from 'vitest'
import { createLatestRequest } from '../src/main/latest-request.js'

describe('stale local-to-remote continuations', () => {
  for (const action of ['cancel', 'begin']) {
    it(`never launches remote fallback after ${action}`, async () => {
      const requests = createLatestRequest()
      const first = requests.begin()
      let resolve
      const remote = vi.fn()
      const run = (async () => {
        await first.wait(new Promise(r => { resolve = r }))
        remote()
      })()
      const rejected = expect(run).rejects.toMatchObject({ code: 'TURN_CANCELLED' })
      requests[action]()
      resolve({ ok: false, reason: 'pass' })
      await rejected
      expect(remote).not.toHaveBeenCalled()
    })
  }
  it('keeps the current request valid', async () => {
    const r = createLatestRequest().begin()
    expect(await r.wait(Promise.resolve('answer'))).toBe('answer')
  })
})
