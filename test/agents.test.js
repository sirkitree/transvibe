import { describe, it, expect } from 'vitest'
import {
  normalizeAgent, normalizeRoster, migrateRoster, speechFor, commandAgent,
  addAgent, updateAgent, removeAgent, KINDS
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

  it('keeps a model only where a model means something', () => {
    expect(normalizeAgent({ name: 'x', kind: 'chat', model: 'llama3' }).model).toBe('llama3')
    // A commands agent with a model would imply the parser could be pointed
    // somewhere, which it cannot.
    expect(normalizeAgent({ name: 'x', kind: 'commands', model: 'llama3' }).model).toBe(null)
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
