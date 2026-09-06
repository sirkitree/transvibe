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

  it('offers the model a way to decline, rather than only a way to hedge', () => {
    expect(ASK_PROMPT).toContain('PASS')
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

  it('defaults to effectively the whole conversation, not just the last few turns', () => {
    expect(trimHistory(turns(20))).toHaveLength(20)
    // Still bounded, for a thread left open long enough to blow past that.
    expect(trimHistory(turns(200))).toHaveLength(48)
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
      .toEqual({
        text: 'The capital of France is Paris.',
        // Nothing in it that only works in writing, so the two are the same.
        spoken: 'The capital of France is Paris.',
        ok: true
      })
  })

  it('strips the markdown nobody can hear', () => {
    expect(acceptAnswer('**Paris** is the capital.').text).toBe('Paris is the capital.')
    expect(acceptAnswer('- apples\n- bananas').text).toBe('apples bananas')
    expect(acceptAnswer('## Answer\nParis.').text).toBe('Answer Paris.')
    expect(acceptAnswer('Use `git status` first.').text).toBe('Use git status first.')
  })

  /* Reading is not listening, so the two are cut in different places: the
     speaker gets the couple of sentences the deaf microphone can afford, and
     the strip gets as much as anyone would want to read. */
  it('says the first sentences of a lecture and shows a good deal more', () => {
    const long = Array.from({ length: 12 },
      (_, i) => `Sentence number ${i} goes on for a while about something.`).join(' ')
    const r = acceptAnswer(long)
    expect(r.ok).toBe(true)
    // Well under the display cap, so nothing is lost from the strip at all.
    expect(r.text).toBe(long)
    expect(r.reason).toBeUndefined()
    expect(r.spoken.split(/\s+/).length).toBeLessThanOrEqual(60)
    expect(r.spoken.startsWith('Sentence number 0')).toBe(true)
  })

  it('cuts the strip too, once even reading it would be a chore', () => {
    const lecture = Array.from({ length: 60 },
      (_, i) => `Sentence number ${i} goes on for a while about something.`).join(' ')
    const r = acceptAnswer(lecture)
    expect(r.reason).toBe('shortened')
    expect(r.text.split(/\s+/).length).toBeLessThanOrEqual(180)
    // Whole sentences at both cuts — half a sentence is worse than a long one.
    expect(r.text.endsWith('.')).toBe(true)
    expect(r.spoken.endsWith('.')).toBe(true)
  })

  /* Codex answers arrive full of links, because it searched the web to write
     them. Both halves of a link are wanted, just not in the same place: the
     address is the useful part of "where can I read about this" and it is
     unlistenable, so the strip keeps it and the speaker does not. */
  it('keeps a link on screen and takes it out of what is said', () => {
    const r = acceptAnswer('See [the release notes](https://example.com/v22) for more.')
    expect(r.text).toBe('See the release notes (https://example.com/v22) for more.')
    expect(r.spoken).toBe('See the release notes for more.')
  })

  it('says the host of a bare URL rather than the whole of it', () => {
    // Locating it is worth four syllables. Reading the path aloud is not.
    const r = acceptAnswer('It is documented at https://example.com/a/b/c.html today.')
    expect(r.text).toBe('It is documented at https://example.com/a/b/c.html today.')
    expect(r.spoken).toBe('It is documented at example.com today.')
  })

  it('leaves the dots inside ordinary words alone', () => {
    // The reason the URL patterns insist on a scheme: a looser one eats these.
    const r = acceptAnswer('It needs about 1.5 GB, e.g. on a laptop.')
    expect(r.spoken).toBe('It needs about 1.5 GB, e.g. on a laptop.')
  })

  it('unwraps an image the same way, since neither half can be heard', () => {
    expect(acceptAnswer('![a chart](https://example.com/c.png) shows the trend.').spoken)
      .toBe('a chart shows the trend.')
  })

  it('reads the PASS sentinel as a decline, not as an answer', () => {
    expect(acceptAnswer('PASS')).toEqual({ text: '', ok: false, reason: 'pass' })
    expect(acceptAnswer('  pass.  ')).toEqual({ text: '', ok: false, reason: 'pass' })
    expect(acceptAnswer('**PASS**')).toEqual({ text: '', ok: false, reason: 'pass' })
  })

  it('does not mistake an answer that mentions passing for a decline', () => {
    expect(acceptAnswer('You pass it as the second argument.').ok).toBe(true)
    expect(acceptAnswer('A pass.').ok).toBe(true)
  })

  it('refuses an empty answer rather than saying nothing out loud', () => {
    expect(acceptAnswer('').ok).toBe(false)
    expect(acceptAnswer(null).ok).toBe(false)
    expect(acceptAnswer('```\n```').ok).toBe(false)
  })
})
