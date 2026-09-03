import { describe, it, expect } from 'vitest'
import {
  normalizeAgent, normalizeRoster, migrateRoster, speechFor, commandAgent,
  addAgent, updateAgent, removeAgent, nextHue, defaultModel, migrateModels,
  DEFAULT_MODEL, HUES, KINDS
} from '../src/shared/agents.js'
import { DEFAULTS } from '../src/main/config.js'

describe('normalizeAgent', () => {
  it('fills in everything an agent needs from just a name', () => {
    expect(normalizeAgent({ name: 'ada' })).toMatchObject({
      name: 'ada', kind: 'commands', voice: null, rate: null
    })
    expect(normalizeAgent({ name: 'ada' }).hue).toBeGreaterThanOrEqual(0)
  })

  it('refuses one with no name, which could never be addressed', () => {
    expect(normalizeAgent({ kind: 'chat' })).toBe(null)
    expect(normalizeAgent({ name: '   ' })).toBe(null)
    expect(normalizeAgent(null)).toBe(null)
  })

  it('falls back to running commands rather than to an invented kind', () => {
    expect(normalizeAgent({ name: 'x', kind: 'sudo' }).kind).toBe('commands')
    for (const kind of KINDS) {
      expect(normalizeAgent({ name: 'x', kind }).kind).toBe(kind)
    }
  })

  it('lets any agent name its own local model', () => {
    /* A chat agent answers with it; one that runs commands hands it the
       guesswork — what an unrecognised command meant, and how to shorten a
       confirmation. Both are that agent's thinking. */
    expect(normalizeAgent({ name: 'x', kind: 'chat', model: 'llama3' }).model).toBe('llama3')
    expect(normalizeAgent({ name: 'x', kind: 'commands', model: 'gemma4:e2b' }).model)
      .toBe('gemma4:e2b')
    // Null is not "no model", it is "the default in Advanced".
    expect(normalizeAgent({ name: 'x' }).model).toBe(null)
  })

  it('reads a missing rate as "inherit", not as zero', () => {
    // Number(null) is a very finite 0, which would read as a chosen rate.
    expect(normalizeAgent({ name: 'x', rate: null }).rate).toBe(null)
    expect(normalizeAgent({ name: 'x', rate: '' }).rate).toBe(null)
    expect(normalizeAgent({ name: 'x', rate: 190 }).rate).toBe(190)
  })

  it('gives each agent a colour of its own when none was chosen', () => {
    const roster = normalizeRoster([{ name: 'a' }, { name: 'b' }, { name: 'c' }])
    expect(new Set(roster.map(a => a.hue)).size).toBe(3)
  })
})

describe('normalizeRoster', () => {
  it('drops a second agent answering to the same name', () => {
    // Two agents on one name is a question with no right answer.
    const roster = normalizeRoster([{ name: 'ada' }, { name: 'ADA', kind: 'chat' }])
    expect(roster).toHaveLength(1)
    expect(roster[0].kind).toBe('commands')
  })

  it('is an empty roster rather than a throw on junk', () => {
    expect(normalizeRoster(null)).toEqual([])
    expect(normalizeRoster([null, 5, 'ada'])).toEqual([])
  })
})

describe('migrateRoster', () => {
  it('turns a file that predates rosters into a roster of one', () => {
    // Anyone already running this app has a name they are used to saying.
    const roster = migrateRoster({ wakeWord: 'hey mira', wakeWordFuzzy: true })
    expect(roster).toHaveLength(1)
    expect(roster[0]).toMatchObject({ name: 'hey mira', kind: 'commands' })
  })

  it('leaves a file that already has a roster alone', () => {
    const roster = migrateRoster({
      wakeWord: 'hey claude',
      agents: [{ name: 'ada', kind: 'chat' }]
    })
    expect(roster.map(a => a.name)).toEqual(['ada'])
  })

  it('is empty when there is nothing to go on', () => {
    expect(migrateRoster({})).toEqual([])
    expect(migrateRoster(null)).toEqual([])
  })

  it('leaves the shipped defaults with an agent to talk to', () => {
    expect(migrateRoster(DEFAULTS).length).toBeGreaterThan(0)
    expect(commandAgent(migrateRoster(DEFAULTS))).not.toBe(null)
  })
})

describe('speechFor', () => {
  const settings = { speakVoice: 'Alex', speakRate: 200 }

  it('lets an agent sound like itself', () => {
    expect(speechFor({ voice: 'Karen', rate: 190 }, settings))
      .toEqual({ voice: 'Karen', rate: 190 })
  })

  it('falls back to the app for anything the agent did not choose', () => {
    expect(speechFor({ voice: null, rate: null }, settings))
      .toEqual({ voice: 'Alex', rate: 200 })
  })

  it('still sounds like something with no agent at all', () => {
    // A command armed with the key rather than with a name.
    expect(speechFor(null, settings)).toEqual({ voice: 'Alex', rate: 200 })
    expect(speechFor(null, {})).toEqual({ voice: null, rate: 0 })
  })
})

describe('editing the roster', () => {
  const roster = normalizeRoster([{ name: 'hey mira' }])

  it('adds one', () => {
    const r = addAgent(roster, { name: 'ada', kind: 'chat', voice: 'Karen' })
    expect(r.ok).toBe(true)
    expect(r.agents.map(a => a.name)).toEqual(['hey mira', 'ada'])
  })

  it('refuses a name that is already taken, however it was typed', () => {
    expect(addAgent(roster, { name: 'HEY MIRA' }).ok).toBe(false)
    expect(addAgent(roster, { name: '  ' }).error).toMatch(/name/)
  })

  it('changes one field without disturbing the rest', () => {
    const r = updateAgent(roster, 'hey mira', { voice: 'Samantha' })
    expect(r.agents[0]).toMatchObject({ name: 'hey mira', voice: 'Samantha', kind: 'commands' })
  })

  it('renames, but not into a collision', () => {
    const two = addAgent(roster, { name: 'ada', kind: 'chat' }).agents
    expect(updateAgent(two, 'ada', { name: 'mira jane' }).ok).toBe(true)
    expect(updateAgent(two, 'ada', { name: 'hey mira' }).ok).toBe(false)
  })

  it('removes one', () => {
    const two = addAgent(roster, { name: 'ada', kind: 'chat' }).agents
    expect(removeAgent(two, 'ada').agents.map(a => a.name)).toEqual(['hey mira'])
  })

  it('keeps the last agent that runs commands', () => {
    // Removing it would leave the spoken route with nothing to answer to and
    // no way back except the keyboard.
    const r = removeAgent(roster, 'hey mira')
    expect(r.ok).toBe(false)
    expect(r.agents).toHaveLength(1)

    const two = addAgent(roster, { name: 'ada', kind: 'chat' }).agents
    expect(removeAgent(two, 'hey mira').ok).toBe(false)
  })

  it('says what went wrong rather than throwing', () => {
    for (const r of [
      addAgent(roster, {}), updateAgent(roster, 'nobody', {}), removeAgent(roster, 'nobody')
    ]) {
      expect(r.ok).toBe(false)
      expect(typeof r.error).toBe('string')
      expect(Array.isArray(r.agents)).toBe(true)
    }
  })
})

describe('colours', () => {
  it('walks along the palette and back to the start', () => {
    expect(nextHue(HUES[0])).toBe(HUES[1])
    expect(nextHue(HUES.at(-1))).toBe(HUES[0])
  })

  it('lands somewhere from a colour that is not on it', () => {
    expect(HUES).toContain(nextHue(0.512))
  })

  it('starts warm, so the first agent does not wear the ribbon’s own green', () => {
    // An agent's colour is what the speaking ribbon wears; looking like the
    // listening ribbon above it is the one thing it must not do.
    expect(normalizeAgent({ name: 'first' }, 0).hue).toBe(HUES[0])
    expect(HUES[0]).not.toBe(0.38)
  })
})

describe('a model each', () => {
  const roster = normalizeRoster([
    { name: 'mira', kind: 'commands', model: 'gemma4:e2b' },
    { name: 'ada', kind: 'chat', model: 'llama3' }
  ])

  it('thinks with the commands agent’s model when nobody was addressed', () => {
    // Tidying dictation is not a reply to anyone; the agent that runs commands
    // is the app as far as anyone is concerned.
    expect(defaultModel(roster)).toBe('gemma4:e2b')
  })

  it('falls back to something rather than to nothing', () => {
    expect(defaultModel([])).toBe(DEFAULT_MODEL)
    expect(defaultModel(normalizeRoster([{ name: 'ada', kind: 'chat' }]))).toBe(DEFAULT_MODEL)
  })

  it('carries the old single setting onto every agent that had none', () => {
    const before = normalizeRoster([{ name: 'mira' }, { name: 'ada', kind: 'chat', model: 'llama3' }])
    const after = migrateModels(before, 'gemma4:e2b')
    expect(after.map(a => a.model)).toEqual(['gemma4:e2b', 'llama3'])
  })

  it('gives a new agent the same model the rest are using', () => {
    // Rather than nothing, and a dropdown you have to notice.
    expect(addAgent(roster, { name: 'bob' }).agents.at(-1).model).toBe('gemma4:e2b')
  })
})
