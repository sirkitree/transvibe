import { describe, it, expect } from 'vitest'
import { isAcknowledgment, needsVerification, claimsLocalSearch, verificationReply, UNVERIFIED } from '../src/shared/reply-policy.js'
import { buildAskMessages } from '../src/shared/conversation.js'

describe('recorded conversation failures', () => {
  it('keeps acknowledgments local without swallowing a continuing question', () => {
    for (const text of ['Okay. That’s great.', 'Thanks!', 'Got it', 'Yeah, thanks']) expect(isAcknowledgment(text), text).toBe(true)
    for (const text of ['Okay, that’s great, but what’s Codex’s actual response?', 'Thank you for explaining, what next?', 'Yes or no?']) expect(isAcknowledgment(text), text).toBe(false)
  })
  it('routes explicit verification and requests for the actual result to verification', () => {
    const history = [{ role: 'user', content: 'Are you certain about that? Can you actually find the article and verify?' }]
    expect(needsVerification(history[0].content)).toBe(true)
    expect(needsVerification('What is Codex’s actual response?', history)).toBe(true)
    expect(needsVerification('Codex’s actual response.', history)).toBe(true)
    expect(needsVerification('What is Ohio?')).toBe(false)
  })
  it('blocks the recorded local search claim and supplies accurate local capabilities', () => {
    expect(claimsLocalSearch('After searching, I found that Paul Buettner died in Mineral Ridge, Ohio.')).toBe(true)
    expect(claimsLocalSearch('I have verified the article.')).toBe(true)
    expect(claimsLocalSearch('I cannot search the web.')).toBe(false)
    expect(buildAskMessages('Find the article')[0].content).toContain('You have no browser')
  })
  it('keeps timeouts, promises, and unsupported claims unconfirmed', () => {
    for (const answer of [null, { ok: true, text: 'Ohio.' }, { ok: true, text: 'I’ll look for it at https://example.org' }]) {
      expect(verificationReply(answer)).toMatchObject({ text: UNVERIFIED, verification: 'unconfirmed' })
    }
    expect(verificationReply({ ok: false, reason: 'took too long' }).text).toContain('timed out')
    expect(verificationReply({ ok: true, text: 'The article says Ohio. https://example.org/article' })).toMatchObject({ verification: 'source supplied' })
  })
})
