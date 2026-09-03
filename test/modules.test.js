import { describe, it, expect } from 'vitest'

/* Main-process modules are only loaded by Electron at launch, so a syntax
   error in one shows up as a blank window rather than a failing test. Import
   every module that does not need Electron or the DOM, so breakage surfaces
   here first. */
const MODULES = [
  '../src/main/config.js',
  '../src/main/overlay.js',
  '../src/main/wav.js',
  '../src/main/whisper-parse.js',
  '../src/main/speech.js',
  '../src/main/models.js',
  '../src/shared/glossary.js',
  '../src/shared/assist.js',
  '../src/shared/agents.js',
  '../src/shared/conversation.js',
  '../src/renderer/glossary-edit.js',
  '../src/renderer/presence.js',
  '../src/renderer/vad.js',
  '../src/renderer/band.js',
  '../src/renderer/commands.js',
  '../src/renderer/wake.js',
  '../src/renderer/settings-voice.js',
  '../src/renderer/saying.js'
]

describe('modules load', () => {
  for (const path of MODULES) {
    it(`imports ${path.split('/').pop()}`, async () => {
      const mod = await import(path)
      expect(Object.keys(mod).length).toBeGreaterThan(0)
    })
  }

  it('every default setting is JSON-serialisable', async () => {
    const { DEFAULTS } = await import('../src/main/config.js')
    expect(() => JSON.stringify(DEFAULTS)).not.toThrow()
    expect(JSON.parse(JSON.stringify(DEFAULTS))).toEqual(DEFAULTS)
  })
})
