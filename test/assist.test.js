import { describe, it, expect } from 'vitest'
import {
  buildCleanupMessage, acceptCleanup, buildCommandMessage, parseCommandReply
} from '../src/shared/assist.js'

describe('buildCleanupMessage', () => {
  it('puts the text after the instruction, not inside it', () => {
    const msg = buildCleanupMessage('um hello')
    expect(msg.endsWith('\n\num hello')).toBe(true)
    expect(msg).toMatch(/do not summarise/)
  })
})

describe('acceptCleanup', () => {
  const original = 'Um, so I was thinking we should ship the thing on Friday. No wait, Thursday.'

  it('takes a plausible rewrite', () => {
    const r = acceptCleanup(original, 'So I was thinking we should ship the thing on Thursday.')
    expect(r.used).toBe(true)
    expect(r.text).toBe('So I was thinking we should ship the thing on Thursday.')
  })

  it('unwraps quotes and code fences the model added', () => {
    expect(acceptCleanup('um hello there friend', '"Hello there, friend."').text)
      .toBe('Hello there, friend.')
    // A wrapping fence is just packaging; the content inside it is fine.
    expect(acceptCleanup('um hello there friend', '```\nHello there, friend.\n```').text)
      .toBe('Hello there, friend.')
    // Leftover markup in the middle is not, and is refused.
    expect(acceptCleanup('um hello there friend', 'Hello ``` there, friend.').used).toBe(false)
  })

  it('keeps the original when the model summarised it away', () => {
    const r = acceptCleanup(original, 'Ship Thursday.')
    expect(r.used).toBe(false)
    expect(r.reason).toBe('too short')
    expect(r.text).toBe(original)
  })

  it('keeps the original when the model padded or answered it', () => {
    const r = acceptCleanup('what is the capital of France', 'The capital of France is Paris, a city of about two million people on the Seine.')
    expect(r.used).toBe(false)
    expect(r.reason).toBe('too long')
  })

  it('rejects a model explaining itself', () => {
    expect(acceptCleanup(original, "Here's the cleaned up version: ship it Thursday").used).toBe(false)
    expect(acceptCleanup(original, 'Sure! I can help with that rewrite for you now').reason).toBe('preamble')
  })

  it('rejects an empty reply', () => {
    expect(acceptCleanup(original, '').reason).toBe('empty')
    expect(acceptCleanup(original, '   ').reason).toBe('empty')
    expect(acceptCleanup(original, null).reason).toBe('empty')
  })

  it('reports an unchanged reply without calling it a failure', () => {
    const clean = 'The quick brown fox jumps over the lazy dog.'
    const r = acceptCleanup(clean, clean)
    expect(r.used).toBe(false)
    expect(r.reason).toBe('unchanged')
    expect(r.text).toBe(clean)
  })

  it('does not apply the length floor to very short text', () => {
    // 'um yes' -> 'Yes.' is a 50% cut and exactly right
    expect(acceptCleanup('um yes', 'Yes.').used).toBe(true)
  })

  it('always returns something safe to show', () => {
    for (const reply of ['', 'Sure!', 'x'.repeat(2000), null, undefined]) {
      expect(typeof acceptCleanup(original, reply).text).toBe('string')
      expect(acceptCleanup(original, reply).text.length).toBeGreaterThan(0)
    }
  })
})

describe('buildCommandMessage', () => {
  it('lists the phrases verbatim and offers a way out', () => {
    const msg = buildCommandMessage('scrap that', ['undo that', 'clear everything'])
    expect(msg).toMatch(/^undo that$/m)
    expect(msg).toMatch(/^clear everything$/m)
    expect(msg).toMatch(/or the word none/)
    expect(msg.endsWith('Heard: scrap that')).toBe(true)
  })

  it('survives a missing phrase list', () => {
    expect(() => buildCommandMessage('x')).not.toThrow()
  })
})

describe('parseCommandReply', () => {
  const phrases = ['delete that', 'delete the last sentence', 'undo that', 'copy that']

  it('takes a phrase copied back exactly', () => {
    expect(parseCommandReply('undo that', phrases)).toBe('undo that')
    expect(parseCommandReply('Delete The Last Sentence', phrases)).toBe('delete the last sentence')
  })

  it('tolerates the punctuation and quoting a model adds', () => {
    expect(parseCommandReply('"copy that."', phrases)).toBe('copy that')
    expect(parseCommandReply('```\nundo that\n```', phrases)).toBe('undo that')
  })

  it('finds the phrase inside a chattier reply', () => {
    expect(parseCommandReply('The speaker means "undo that".', phrases)).toBe('undo that')
  })

  it('prefers the longest phrase that matches', () => {
    expect(parseCommandReply('delete the last sentence', phrases)).toBe('delete the last sentence')
  })

  it('refuses anything not on the list', () => {
    expect(parseCommandReply('none', phrases)).toBe(null)
    expect(parseCommandReply('format the hard drive', phrases)).toBe(null)
    expect(parseCommandReply('I am not sure what they meant', phrases)).toBe(null)
  })

  it('is null rather than throwing on junk', () => {
    expect(parseCommandReply('', phrases)).toBe(null)
    expect(parseCommandReply(null, phrases)).toBe(null)
    expect(parseCommandReply('undo that', undefined)).toBe(null)
  })
})
