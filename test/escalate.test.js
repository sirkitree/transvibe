import { describe, it, expect } from 'vitest'
import {
  PASS_SENTINEL, saysUnsure, needsFreshFacts, shouldEscalate,
  buildEscalationPrompt, attribute, escalationChain
} from '../src/shared/escalate.js'
import { acceptAnswer } from '../src/shared/conversation.js'

describe('the PASS sentinel', () => {
  it('is the token conversation.js recognises, so the two cannot drift apart', () => {
    expect(acceptAnswer(PASS_SENTINEL)).toEqual({ text: '', ok: false, reason: 'pass' })
    expect(shouldEscalate(acceptAnswer(PASS_SENTINEL)))
      .toEqual({ escalate: true, why: 'pass' })
  })
})

describe('saysUnsure', () => {
  it('catches a model declining before it has said anything', () => {
    expect(saysUnsure("I'm not sure — that happened after my training data.")).toBe(true)
    expect(saysUnsure('I do not know.')).toBe(true)
    expect(saysUnsure("I don't have access to current information.")).toBe(true)
    expect(saysUnsure('I cannot browse the web, so I cannot check.')).toBe(true)
    expect(saysUnsure('As an AI, I have no information about that.')).toBe(true)
    expect(saysUnsure("I can't help with that one.")).toBe(true)
  })

  it('leaves an answer alone when the hedge is a caveat on the end of it', () => {
    // The interesting false positive: this answered the question, and
    // re-asking a frontier model would cost eight seconds to hear "Paris".
    expect(saysUnsure(
      'The capital of France is Paris, a city of a couple of million people ' +
      'depending on where you draw the boundary, though I am not sure about ' +
      'the exact population inside the city limits itself these days.'
    )).toBe(false)
  })

  it('counts a hedge that opens a long answer, however much follows it', () => {
    expect(saysUnsure(
      'I do not know which version that is, but the release before it changed ' +
      'the module resolution rules, added a permission model, and moved the ' +
      'test runner out of the experimental section entirely.'
    )).toBe(true)
  })

  it('still counts a hedge late in a short answer, where it is the whole reply', () => {
    expect(saysUnsure('Paris, I think, but I am not sure.')).toBe(true)
  })

  it('is not fooled by ordinary uncertainty words in a real answer', () => {
    expect(saysUnsure('It is probably around ten milliseconds.')).toBe(false)
    expect(saysUnsure('Roughly forty, give or take.')).toBe(false)
    expect(saysUnsure('You can access it from the settings panel.')).toBe(false)
    expect(saysUnsure('Certainly — hold the key and speak.')).toBe(false)
  })

  it('says nothing about nothing', () => {
    expect(saysUnsure('')).toBe(false)
    expect(saysUnsure(null)).toBe(false)
  })
})

describe('needsFreshFacts', () => {
  it('routes a question about now straight past the local model', () => {
    expect(needsFreshFacts('what is the latest version of node')).toBe(true)
    expect(needsFreshFacts("what's in the news today")).toBe(true)
    expect(needsFreshFacts('who won the game last night, as of today')).toBe(true)
    expect(needsFreshFacts('what is the price of a bitcoin')).toBe(true)
    expect(needsFreshFacts('what is the release date for the next one')).toBe(true)
    expect(needsFreshFacts('what is the weather like')).toBe(true)
    expect(needsFreshFacts('what happened this week')).toBe(true)
  })

  it('does not hear a deadline as a news question', () => {
    // 'latest' is a time of day here, and sending this to a web-searching CLI
    // would spend fourteen seconds on a question about lunch.
    expect(needsFreshFacts('what is the latest you can arrive')).toBe(false)
    expect(needsFreshFacts("what's the latest on that bug I mentioned")).toBe(false)
  })

  it('leaves questions that have always had the same answer alone', () => {
    expect(needsFreshFacts('what is the capital of france')).toBe(false)
    expect(needsFreshFacts('how do I reverse a string in javascript')).toBe(false)
    expect(needsFreshFacts('why is the sky blue')).toBe(false)
    expect(needsFreshFacts('good news or bad news first')).toBe(false)
    expect(needsFreshFacts('what price did I pay for being clever there')).toBe(false)
    expect(needsFreshFacts('')).toBe(false)
  })
})

describe('shouldEscalate', () => {
  it('takes the model at its word when it passes', () => {
    expect(shouldEscalate({ text: '', ok: false, reason: 'pass' }))
      .toEqual({ escalate: true, why: 'pass' })
  })

  it('separates a model that said nothing from a model that was never reached', () => {
    expect(shouldEscalate({ text: '', ok: false, reason: 'nothing came back' }))
      .toEqual({ escalate: true, why: 'empty' })
    expect(shouldEscalate({ text: '', ok: false, reason: 'timed out' }))
      .toEqual({ escalate: true, why: 'failed' })
  })

  it('escalates a hedge, and leaves a real answer alone', () => {
    expect(shouldEscalate({ text: 'I am not sure about that.', ok: true }))
      .toEqual({ escalate: true, why: 'unsure' })
    expect(shouldEscalate({ text: 'Paris.', ok: true }))
      .toEqual({ escalate: false, why: null })
  })

  it('keeps a shortened answer, which was long because it had plenty to say', () => {
    expect(shouldEscalate({ text: 'Paris, and it has been since 987.', ok: true, reason: 'shortened' }))
      .toEqual({ escalate: false, why: null })
  })

  it('does not throw on junk', () => {
    expect(shouldEscalate().escalate).toBe(true)
    expect(shouldEscalate(null).why).toBe('empty')
  })
})

describe('buildEscalationPrompt', () => {
  const prompt = buildEscalationPrompt(
    'what is a VAD',
    'A VAD is video-assisted delivery.',
    [{ role: 'user', content: 'are you there' }, { role: 'assistant', content: 'Yes.' }]
  )

  it('asks for an independent answer before showing the one to check', () => {
    // Order is the whole point: a model shown a wrong answer first agrees
    // with it.
    expect(prompt.indexOf('Work out your own answer first'))
      .toBeLessThan(prompt.indexOf('video-assisted delivery'))
  })

  it('is one flat string, because a CLI takes a prompt and not a messages array', () => {
    expect(typeof prompt).toBe('string')
    expect(prompt).toContain('what is a VAD')
    expect(prompt).toContain('Them: are you there')
    expect(prompt).toContain('You: Yes.')
  })

  /* The rules live in conversation.js and reach the model through the slot
     each CLI gives for them. Repeating them here is what let the two copies
     drift into contradicting each other. */
  it('leaves the spoken-shape rules to the prompt that carries them', () => {
    expect(prompt.toLowerCase()).not.toContain('no links')
    expect(prompt.toLowerCase()).not.toContain('through a speaker')
  })

  it('says nothing about a previous answer when there was not one', () => {
    const cold = buildEscalationPrompt('what is a VAD', '', [])
    expect(cold).toContain('what is a VAD')
    expect(cold.toLowerCase()).not.toContain('smaller model')
  })
})

describe('attribute', () => {
  it('says who answered, for the spoken line only', () => {
    expect(attribute('Claude', 'A VAD detects speech.'))
      .toBe('Claude said, A VAD detects speech.')
  })

  it('does not say it twice when the model introduced itself', () => {
    expect(attribute('Claude', 'Claude said, no.')).toBe('Claude said, no.')
  })

  it('has nothing to attribute when there is nothing to say', () => {
    expect(attribute('Claude', '')).toBe('')
    expect(attribute('Claude', null)).toBe('')
    expect(attribute('', 'Paris.')).toBe('Paris.')
  })
})

describe('escalationChain', () => {
  const roster = [
    { name: 'Ada', kind: 'chat', escalateTo: 'Claude' },
    { name: 'Claude', kind: 'chat', provider: 'claude', escalateTo: 'Codex' },
    { name: 'Codex', kind: 'chat', provider: 'codex' },
    { name: 'Mira', kind: 'commands' }
  ]

  it('follows escalateTo from one agent to the next, without the one it starts at', () => {
    expect(escalationChain(roster, roster[0]).map(a => a.name)).toEqual(['Claude', 'Codex'])
  })

  it('stops at two hops, because a third is fifteen seconds of a quiet room', () => {
    const long = [
      { name: 'A', kind: 'chat', escalateTo: 'B' },
      { name: 'B', kind: 'chat', escalateTo: 'C' },
      { name: 'C', kind: 'chat', escalateTo: 'D' },
      { name: 'D', kind: 'chat' }
    ]
    expect(escalationChain(long, long[0]).map(a => a.name)).toEqual(['B', 'C'])
  })

  it('terminates on a cycle rather than spinning', () => {
    const pair = [
      { name: 'A', kind: 'chat', escalateTo: 'B' },
      { name: 'B', kind: 'chat', escalateTo: 'A' }
    ]
    expect(escalationChain(pair, pair[0]).map(a => a.name)).toEqual(['B'])
  })

  it('ends the chain at a name nobody on the roster answers to', () => {
    const stale = [{ name: 'Ada', kind: 'chat', escalateTo: 'Deleted' }]
    expect(escalationChain(stale, stale[0])).toEqual([])
  })

  it('will not escalate to something that runs commands', () => {
    const wrong = [
      { name: 'Ada', kind: 'chat', escalateTo: 'Mira' },
      { name: 'Mira', kind: 'commands' }
    ]
    expect(escalationChain(wrong, wrong[0])).toEqual([])
  })

  it('is empty rather than throwing on junk', () => {
    expect(escalationChain(null, null)).toEqual([])
    expect(escalationChain(roster, { name: 'Ada' })).toEqual([])
  })
})
