import { it, expect, vi, afterEach } from 'vitest'
import { acceptAnswer, buildAskMessages, trimHistory } from '../src/shared/conversation.js'
import { shouldEscalate } from '../src/shared/escalate.js'
import { needsVerification, conversationFact } from '../src/shared/reply-policy.js'
import { createTurnBuffer, replacementQuestion } from '../src/renderer/turn-buffer.js'

afterEach(() => vi.useRealTimers())

it('routes a labelled refusal to escalation and keeps it out of subsequent history', () => {
  for (const raw of ['[Hey Mira] PASS', '**[Hey Mira] PASS.**', '[Hey Mira; lookup: unconfirmed] PASS', '[Hey Ada] PASS']) {
    const answer = acceptAnswer(raw, { speakerNames: ['Hey Ada'] })
    expect(answer).toMatchObject({ text: '', ok: false, reason: 'pass' })
    expect(shouldEscalate(answer)).toEqual({ escalate: true, why: 'pass' })
  }
  expect(trimHistory([{ role: 'assistant', name: 'Hey Mira', content: '[Hey Mira] PASS' }])).toEqual([])
  expect(acceptAnswer('[Hey Mira] 12.')).toMatchObject({ text: '12.', spoken: '12.' })
  expect(acceptAnswer('[Important] PASS').text).toBe('[Important] PASS')
  expect(acceptAnswer('The word PASS means decline.').ok).toBe(true)
})

it('cancels a lookup and routes only its spoken replacement', () => {
  vi.useFakeTimers()
  const cancel = vi.fn(), questions = []
  const buffer = createTurnBuffer({ cancel, dispatch: (_agent, question) => questions.push(question) })
  const agent = { name: 'Hey Mira' }
  buffer.submit(agent, 'Find an article about a space telescope and verify its launch date.')
  vi.advanceTimersByTime(250)
  buffer.speechStart()
  expect(cancel).toHaveBeenCalledTimes(1)
  buffer.speechEnd()
  buffer.submit(agent, 'Actually forget that lookup. What is nine times seven?')
  vi.advanceTimersByTime(250)
  expect(questions[1]).toBe('What is nine times seven?')
  expect(needsVerification(questions[1])).toBe(false)
  expect(needsVerification(questions[0])).toBe(true)
})

it('keeps ordinary corrections and does not interpret quoted cancellation as intent', () => {
  expect(replacementQuestion('Correction, Pepper weighs thirty pounds.')).toBeNull()
  expect(replacementQuestion('What does “forget that lookup” mean?')).toBeNull()
  expect(replacementQuestion('Actually, forget that lookup.')).toBe('')
  vi.useFakeTimers()
  const dispatch = vi.fn()
  const buffer = createTurnBuffer({ dispatch, cancel: vi.fn() })
  buffer.submit({ name: 'Hey Mira' }, 'Find an article and verify it.')
  buffer.submit({ name: 'Hey Mira' }, 'Forget that lookup.')
  vi.advanceTimersByTime(10000)
  expect(dispatch).not.toHaveBeenCalled()
  expect(buffer.pending).toBe(false)
})

it('formats retrieved answers for speech while preserving the source on screen', () => {
  const content = '[Hey Codex] Yes, octopuses have three hearts. The source is the museum. (https://www.nhm.ac.uk/discover/octopuses.html)'
  const answer = conversationFact("What was Codex's actual response?", [{ role: 'assistant', name: 'Hey Codex', content }])
  expect(answer.text).toContain('https://www.nhm.ac.uk')
  expect(answer.spoken).not.toMatch(/https|octopuses\.html|\[Hey/)
  expect(answer.spoken).toContain('Codex said: Yes')
  const long = conversationFact("What's Codex's actual response?", [{ role: 'assistant', name: 'Hey Codex', content: 'This is an explanatory sentence about rain. '.repeat(20) }])
  expect(long.spoken.split(/\s+/).length).toBeLessThanOrEqual(60)
})

it('keeps attribution separate from answer text and prioritizes user corrections', () => {
  const history = [
    { role: 'user', content: 'Pepper weighs twenty pounds.' },
    { role: 'assistant', name: 'Hey Mira', content: '[Hey Mira] Understood.' },
    { role: 'user', content: 'Correction: Pepper weighs thirty pounds.' }
  ]
  const messages = buildAskMessages("What is my dog's weight?", history)
  expect(messages[0].content).toContain('latest explicit correction wins')
  expect(messages[0].content).toContain('answered by Hey Mira')
  expect(messages[2]).toEqual({ role: 'assistant', content: 'Understood.' })
  expect(messages[3].content).toContain('thirty')
})
