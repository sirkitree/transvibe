import { describe, it, expect } from 'vitest'
import {
  buildAskMessages, trimHistory, acceptAnswer, ASK_PROMPT
} from '../src/shared/conversation.js'

describe('buildAskMessages', () => {
  it('asks for an answer that can be heard rather than read', () => {
    const messages = buildAskMessages('what is the capital of france')
    expect(messages[0]).toEqual({ role: 'system', content: ASK_PROMPT })
    expect(messages.at(-1)).toEqual({ role: 'user', content: 'what is the capital of france' })
    expect(ASK_PROMPT.toLowerCase()).toContain('short')
    expect(ASK_PROMPT.toLowerCase()).toContain('not sure')
  })

  it('carries the thread, so a follow-up makes sense', () => {
    // "and how far is that from London" is only a question with what came
    // before it attached.
    const messages = buildAskMessages('how far is that from london', [
      { role: 'user', content: 'what is the capital of france' },
      { role: 'assistant', content: 'Paris.' }
    ])
    expect(messages).toHaveLength(4)
    expect(messages[2]).toEqual({ role: 'assistant', content: 'Paris.' })
  })
})

describe('trimHistory', () => {
  const turns = n => Array.from({ length: n }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user', content: `turn ${i}`
  }))

  it('keeps the recent end of a long conversation', () => {
    const kept = trimHistory(turns(20), 6)
    expect(kept).toHaveLength(6)
    expect(kept.at(-1).content).toBe('turn 19')
  })

  it('drops anything that is not a turn', () => {
    expect(trimHistory([
      { role: 'user', content: '  ' },
      { role: 'system', content: 'sneaky' },
      null,
      { role: 'user', content: ' hello  there ' }
    ])).toEqual([{ role: 'user', content: 'hello there' }])
  })

  it('is empty rather than throwing on junk', () => {
    expect(trimHistory(null)).toEqual([])
    expect(trimHistory('nope')).toEqual([])
  })
})

describe('acceptAnswer', () => {
  it('takes a short spoken answer as it is', () => {
    expect(acceptAnswer('The capital of France is Paris.'))
      .toEqual({ text: 'The capital of France is Paris.', ok: true })
  })

  it('strips the markdown nobody can hear', () => {
    expect(acceptAnswer('**Paris** is the capital.').text).toBe('Paris is the capital.')
    expect(acceptAnswer('- apples\n- bananas').text).toBe('apples bananas')
    expect(acceptAnswer('## Answer\nParis.').text).toBe('Answer Paris.')
    expect(acceptAnswer('Use `git status` first.').text).toBe('Use git status first.')
  })

  it('shortens a lecture to its first sentences rather than dropping it', () => {
    const long = Array.from({ length: 12 },
      (_, i) => `Sentence number ${i} goes on for a while about something.`).join(' ')
    const r = acceptAnswer(long)
    expect(r.ok).toBe(true)
    expect(r.reason).toBe('shortened')
    expect(r.text.split(/\s+/).length).toBeLessThanOrEqual(60)
    expect(r.text.startsWith('Sentence number 0')).toBe(true)
  })

  it('refuses an empty answer rather than saying nothing out loud', () => {
    expect(acceptAnswer('').ok).toBe(false)
    expect(acceptAnswer(null).ok).toBe(false)
    expect(acceptAnswer('```\n```').ok).toBe(false)
  })
})
