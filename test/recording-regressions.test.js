import { describe, it, expect, vi, afterEach } from 'vitest'
import { conversationFact, verificationReply } from '../src/shared/reply-policy.js'
import { buildAskMessages, speakable } from '../src/shared/conversation.js'
import { buildEscalationPrompt } from '../src/shared/escalate.js'
import { matchAgent } from '../src/renderer/wake.js'
import { createTurnBuffer, turnDelay } from '../src/renderer/turn-buffer.js'
import { createConversationWindow } from '../src/renderer/conversation-window.js'
import { shouldRetryTranscript, preferRetry } from '../src/shared/transcript-retry.js'

const result = { role: 'assistant', name: 'Hey Codex', content: 'Three hearts. https://www.nhm.ac.uk/discover/octopuses.html',
  ...verificationReply({ ok: true, text: 'Three hearts. https://www.nhm.ac.uk/discover/octopuses.html' }) }

describe('September 12 recorded conversation regressions', () => {
  it('reports a received sourced result instead of denying it', () => {
    expect(conversationFact('Did you actually receive a verified result or are you still waiting?', [result]).text).toContain('Codex returned a sourced answer')
    expect(conversationFact('Are you still waiting?', []).text).toContain('no completed lookup')
    expect(conversationFact('Are you still waiting?', [{ role: 'assistant', verification: 'unconfirmed' }]).text).toContain('did not return')
  })
  it('names the source aloud while retaining its URL on screen', () => {
    const answer = conversationFact('Which source supports your answer?', [result])
    expect(answer.spoken).toContain('Natural History Museum')
    expect(answer.text).toContain('https://www.nhm.ac.uk')
    expect(speakable('https://www.nhm.ac.uk/article')).toBe('the Natural History Museum')
  })
  it('does not credit Mira replies to Codex', () => {
    const history = [{ role: 'assistant', name: 'Hey Mira', content: 'That depends on how many people.' }]
    expect(conversationFact("But what's Codex actual response?", history).text).toContain('has not answered')
    expect(buildEscalationPrompt('How many?', '', history)).toContain('Hey Mira: That depends')
    expect(buildEscalationPrompt('How many?', '', history)).not.toContain('You:')
    expect(buildAskMessages('How many?', history)[0].content).toContain('answered by Hey Mira')
    expect(buildAskMessages('How many?', history)[1].content).toBe('That depends on how many people.')
    expect(conversationFact("What's Codex's actual response?", [result]).text).toContain('Three hearts')
  })
  it('answers calendar access locally and preserves the capability question', () => {
    const roster = [{ name: 'Hey Mira', kind: 'chat', aliases: ['Hey Myra'] }]
    for (const name of ['Hey Mira', 'Hey Myra']) {
      const wake = matchAgent(`${name}, can you see my calendar or change my appointments?`, roster)
      expect(wake.rest).toBe('can you see my calendar or change my appointments?')
      expect(conversationFact(wake.rest).text).toContain('do not have calendar access')
    }
    expect(matchAgent('Hey Mira, can you uppercase that', [{ name: 'Hey Mira', kind: 'commands' }]).rest).toBe('uppercase that')
    expect(conversationFact('How should I prepare for my meeting?')).toBeNull()
  })
  it('retries suspicious final recognition without rewriting genuine words', () => {
    const original = { text: "David Price : What's my dog's name and wait.", confidence: -0.50 }
    expect(shouldRetryTranscript(original)).toBe(true)
    expect(shouldRetryTranscript(original, true)).toBe(false)
    expect(preferRetry(original, { text: "What's my dog's name and weight?", confidence: -0.15 })).toBe(true)
    expect(preferRetry(original, { text: '', confidence: -0.1 })).toBe(false)
    expect(preferRetry(original, { text: 'David Price: Wait.', confidence: -0.1 })).toBe(false)
    expect(shouldRetryTranscript({ text: 'noise', confidence: -1.2 })).toBe(false)
    expect(preferRetry({ text: 'Wait here', confidence: -0.48 }, { text: 'Weight here', confidence: -0.5 })).toBe(false)
  })
  it('keeps a full follow-up window after speech longer than the timeout', () => {
    let now = 0
    const clock = createConversationWindow(() => now)
    clock.open(25000); clock.pause(); now = 70000
    expect(clock.remainingMs()).toBe(25000)
    clock.resume(); now += 24000
    expect(clock.remainingMs()).toBe(1000)
    now += 1001
    expect(clock.remainingMs()).toBe(0)
  })
})

describe('turn continuation and cancellation', () => {
  afterEach(() => vi.useRealTimers())
  const agent = { name: 'Hey Mira' }
  function setup () {
    vi.useFakeTimers()
    const dispatch = vi.fn(), cancel = vi.fn()
    return { dispatch, cancel, buffer: createTurnBuffer({ dispatch, cancel }) }
  }
  it('waits longer for a setup statement than an explicit question', () => {
    expect(turnDelay("I'm planning a meeting.")).toBeGreaterThan(turnDelay('How many chairs?'))
  })
  it('joins the meeting setup and its continuation before answering', () => {
    const { buffer, dispatch } = setup()
    buffer.submit(agent, "I'm planning a meeting.")
    vi.advanceTimersByTime(700)
    buffer.speechStart(); vi.advanceTimersByTime(3000)
    expect(dispatch).not.toHaveBeenCalled()
    buffer.speechEnd(); vi.advanceTimersByTime(2000)
    expect(dispatch).not.toHaveBeenCalled()
    buffer.submit(agent, 'With six people, but only four chairs. How many more do I need?')
    vi.advanceTimersByTime(250)
    expect(dispatch).toHaveBeenCalledWith(agent, "I'm planning a meeting. With six people, but only four chairs. How many more do I need?")
  })
  it('invalidates an in-flight reply as soon as speech resumes', () => {
    const { buffer, dispatch, cancel } = setup()
    buffer.submit(agent, 'How many?'); vi.advanceTimersByTime(250)
    buffer.speechStart()
    expect(cancel).toHaveBeenCalledTimes(1)
    buffer.speechEnd(); buffer.submit(agent, 'Actually, there are six people.')
    vi.advanceTimersByTime(1400)
    expect(dispatch).toHaveBeenLastCalledWith(agent, 'How many? Actually, there are six people.')
  })
  it('recovers after a noise-only onset and does not merge after an answer', () => {
    const { buffer, dispatch } = setup()
    buffer.submit(agent, 'How many?'); buffer.speechStart(); buffer.speechEnd(true)
    vi.advanceTimersByTime(250)
    expect(dispatch).toHaveBeenCalledTimes(1)
    buffer.complete(); buffer.submit(agent, 'Next question?'); vi.advanceTimersByTime(250)
    expect(dispatch).toHaveBeenLastCalledWith(agent, 'Next question?')
  })
  it('Escape/clear cancels a queued thought without a late dispatch', () => {
    const { buffer, dispatch } = setup()
    buffer.submit(agent, "I'm planning a meeting."); buffer.reset()
    vi.advanceTimersByTime(10000)
    expect(dispatch).not.toHaveBeenCalled()
    expect(buffer.pending).toBe(false)
  })
})
