import { describe, it, expect } from 'vitest'
import {
  PASS_SENTINEL, saysUnsure, needsFreshFacts, shouldEscalate,
  buildEscalationPrompt, attribute, escalationChain, answersAgree
} from '../src/shared/escalate.js'
import { acceptAnswer } from '../src/shared/conversation.js'
import { QUESTIONS, ANSWERS, PAIRS } from './routing-cases.js'

describe('the PASS sentinel', () => {
  it('is the token conversation.js recognises, so the two cannot drift apart', () => {
    expect(acceptAnswer(PASS_SENTINEL)).toEqual({ text: '', ok: false, reason: 'pass' })
    expect(shouldEscalate(acceptAnswer(PASS_SENTINEL)))
      .toEqual({ escalate: true, why: 'pass' })
  })
})

/* The two phrase rules are checked against test/routing-cases.js rather than
   against assertions written out here, because the corpus is the part that has
   to grow: a misroute you notice is one line there, and the lists in
   escalate.js can then be rewritten freely without losing the cases that made
   them necessary. script/routing.mjs replays the same corpus and prints what
   it gets wrong, including the cases marked `known`, which are skipped here —
   a red suite is not a to-do list. */
const asserted = cases => cases.filter(c => !c.known)

const label = (text, note) => note || String(text).slice(0, 64) || '(nothing)'

describe('saysUnsure', () => {
  for (const { said, unsure, note } of asserted(ANSWERS)) {
    it(`${unsure ? 'hears a decline' : 'hears an answer'}: ${label(said, note)}`, () => {
      expect(saysUnsure(said)).toBe(unsure)
    })
  }

  it('says nothing about nothing', () => {
    expect(saysUnsure(null)).toBe(false)
  })
})

describe('needsFreshFacts', () => {
  for (const { ask, route, note } of asserted(QUESTIONS)) {
    it(`${route}: ${label(ask, note)}`, () => {
      expect(needsFreshFacts(ask)).toBe(route === 'fresh')
    })
  }
})

describe('answersAgree', () => {
  for (const { a, b, agree, note } of PAIRS) {
    it(`${agree === null ? 'cannot tell' : agree ? 'agree' : 'differ'}: ${label(`${a} / ${b}`, note)}`, () => {
      expect(answersAgree(a, b)).toBe(agree)
    })
  }

  it('is symmetrical, because neither answer is the authority', () => {
    for (const { a, b } of PAIRS) expect(answersAgree(a, b)).toBe(answersAgree(b, a))
  })

  it('does not throw on junk', () => {
    expect(answersAgree(null, undefined)).toBe(null)
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
