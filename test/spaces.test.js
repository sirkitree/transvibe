import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spaceKey, matchSpace, matchSpaces, spokenList } from '../src/shared/spaces.js'
import { listSpaces, expandHome } from '../src/main/spaces.js'

describe('spaceKey', () => {
  it('reduces a marker name and the way it is said to the same thing', () => {
    expect(spaceKey('SDSU Space')).toBe('sdsu')
    expect(spaceKey('sdsu')).toBe('sdsu')
    // Whisper's three guesses at an initialism.
    expect(spaceKey('SD SU')).toBe('sdsu')
    expect(spaceKey('S.D.S.U.')).toBe('sdsu')
  })

  it('ignores the article and the word "space"', () => {
    expect(spaceKey('the home space')).toBe('home')
    expect(spaceKey('Home Space')).toBe('home')
    expect(spaceKey('my elk grove')).toBe('elkgrove')
  })

  it('leaves a short name that merely ends in those letters alone', () => {
    expect(spaceKey('Space')).toBe('space')
  })

  it('survives nothing at all', () => {
    expect(spaceKey('')).toBe('')
    expect(spaceKey(null)).toBe('')
    expect(spaceKey(undefined)).toBe('')
  })
})

describe('matchSpace', () => {
  const spaces = [
    { name: 'SDSU', key: 'sdsu' },
    { name: 'Home', key: 'home' },
    { name: 'Hivemind', key: 'hivemind' },
    { name: 'Elk Grove', key: 'elkgrove' }
  ]

  it('finds a name however it was said', () => {
    expect(matchSpace('SDSU', spaces).name).toBe('SDSU')
    expect(matchSpace('the home space', spaces).name).toBe('Home')
    expect(matchSpace('elk grove', spaces).name).toBe('Elk Grove')
  })

  it('takes a prefix when only one space starts that way', () => {
    expect(matchSpace('elk', spaces).name).toBe('Elk Grove')
    expect(matchSpace('hive', spaces).name).toBe('Hivemind')
  })

  it('refuses an ambiguous prefix rather than guessing a desktop', () => {
    expect(matchSpace('h', spaces)).toBeNull()
  })

  it('refuses a name that is not there', () => {
    expect(matchSpace('the store', spaces)).toBeNull()
    expect(matchSpace('', spaces)).toBeNull()
    expect(matchSpace('home', null)).toBeNull()
  })
})

describe('matchSpaces', () => {
  const spaces = [
    { name: 'Home', key: 'home' },
    { name: 'Communications', key: 'communications' },
    { name: 'SDSU', key: 'sdsu' }
  ]

  it('takes one name, or several', () => {
    expect(matchSpaces('home', spaces).map(s => s.name)).toEqual(['Home'])
    expect(matchSpaces('home and communications', spaces).map(s => s.name))
      .toEqual(['Home', 'Communications'])
    expect(matchSpaces('home, sdsu and communications', spaces)).toHaveLength(3)
  })

  it('keeps the order they were said in — the last one ends up in front', () => {
    expect(matchSpaces('sdsu and home', spaces).map(s => s.key)).toEqual(['sdsu', 'home'])
  })

  it('is all or nothing', () => {
    // Half a jump leaves one display moved and the other where it was.
    expect(matchSpaces('home and the store', spaces)).toBeNull()
    expect(matchSpaces('home and send it', spaces)).toBeNull()
  })

  it('does not jump to the same desktop twice', () => {
    expect(matchSpaces('home and the home space', spaces)).toHaveLength(1)
  })

  it('survives an empty phrase', () => {
    expect(matchSpaces('', spaces)).toBeNull()
    expect(matchSpaces(null, spaces)).toBeNull()
  })
})

describe('spokenList', () => {
  it('reads a list the way it would be said', () => {
    expect(spokenList([{ name: 'Home' }])).toBe('Home')
    expect(spokenList([{ name: 'Home' }, { name: 'SDSU' }])).toBe('Home and SDSU')
    expect(spokenList([{ name: 'A' }, { name: 'B' }, { name: 'C' }])).toBe('A, B and C')
    expect(spokenList([])).toBe('')
  })
})

describe('listSpaces', () => {
  let dir

  const bundle = name => fs.mkdirSync(path.join(dir, `${name}.app`), { recursive: true })

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spaces-'))
    for (const n of ['SDSU Space', 'Home Space', 'Space Markers Launcher']) bundle(n)
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'not an app')
  })
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('reads the folder when there is no manifest', () => {
    const found = listSpaces(dir)
    expect(found.map(s => s.name).sort()).toEqual(['Home', 'SDSU'])
    expect(found.find(s => s.key === 'sdsu').app).toBe(path.join(dir, 'SDSU Space.app'))
  })

  it('leaves the launcher out — opening it re-runs the whole login sequence', () => {
    expect(listSpaces(dir).some(s => /launcher/i.test(s.name))).toBe(false)
  })

  it('prefers the manifest, and skips what it names but does not have', () => {
    const manifest = path.join(dir, 'markers.json')
    fs.writeFileSync(manifest, JSON.stringify({
      display1: ['Home Space'],
      display2: ['SDSU Space', 'Nonexistent Space']
    }))
    try {
      expect(listSpaces(dir).map(s => s.name).sort()).toEqual(['Home', 'SDSU'])
      // Which display a marker moves is the one fact beyond its name.
      expect(listSpaces(dir).find(s => s.key === 'home').display).toBe(1)
      expect(listSpaces(dir).find(s => s.key === 'sdsu').display).toBe(2)
    } finally {
      fs.rmSync(manifest)
    }
  })

  it('has no display for a folder that never said', () => {
    expect(listSpaces(dir).every(s => s.display === null)).toBe(true)
  })

  it('falls back to the folder when the manifest will not parse', () => {
    const manifest = path.join(dir, 'markers.json')
    fs.writeFileSync(manifest, '{ not json')
    try {
      expect(listSpaces(dir).length).toBe(2)
    } finally {
      fs.rmSync(manifest)
    }
  })

  it('has no spaces when no folder is set, or the folder is gone', () => {
    expect(listSpaces(null)).toEqual([])
    expect(listSpaces('')).toEqual([])
    expect(listSpaces(path.join(dir, 'nowhere'))).toEqual([])
  })

  it('expands a leading tilde, because that is how a path is typed', () => {
    expect(expandHome('~/repos/space-markers'))
      .toBe(path.join(os.homedir(), 'repos/space-markers'))
    expect(expandHome('/already/absolute')).toBe('/already/absolute')
    expect(expandHome(null)).toBeNull()
  })
})
