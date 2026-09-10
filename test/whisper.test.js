import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { vadArgs } from '../src/main/whisper.js'

/* The flags that turn the speech gate on, built from the file rather than from
   the setting. The asymmetry is the whole point: `--vad` with a `-vm` pointing
   at nothing does not degrade, it kills whisper-server at startup and takes
   transcription down with it. So every test here is really one test — does an
   absent model produce an empty list. */

describe('vadArgs', () => {
  let dir
  let model

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transvibe-vad-'))
    model = path.join(dir, 'ggml-silero-v5.1.2.bin')
    fs.writeFileSync(model, 'not really a model, but it exists')
  })

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('turns the gate on and names the model it found', () => {
    expect(vadArgs({ enabled: true, modelPath: model })).toEqual(
      ['--vad', '-vm', model, '-vt', '0.5'])
  })

  it('emits nothing when the model file is not there', () => {
    // The one that matters: flags built from a path that does not resolve
    // would start a server that exits before it ever listens.
    expect(vadArgs({ enabled: true, modelPath: path.join(dir, 'missing.bin') })).toEqual([])
  })

  it('emits nothing when there is no model path at all', () => {
    expect(vadArgs({ enabled: true, modelPath: null })).toEqual([])
    expect(vadArgs({ enabled: true })).toEqual([])
  })

  it('emits nothing when the setting is off, model or no model', () => {
    expect(vadArgs({ enabled: false, modelPath: model })).toEqual([])
  })

  it('emits nothing when asked about nothing', () => {
    expect(vadArgs(null)).toEqual([])
    expect(vadArgs(undefined)).toEqual([])
  })

  it('passes a threshold through', () => {
    expect(vadArgs({ enabled: true, modelPath: model, threshold: 0.7 }))
      .toContain('0.7')
  })

  it('clamps a threshold outside the probability it is', () => {
    // -vt is read literally by a process that will not argue with it.
    const at = v => vadArgs({ enabled: true, modelPath: model, threshold: v }).at(-1)
    expect(at(0)).toBe('0.05')
    expect(at(-3)).toBe('0.05')
    expect(at(1)).toBe('0.95')
    expect(at(99)).toBe('0.95')
  })

  it('falls back to silero’s own default when the threshold is not a number', () => {
    const at = v => vadArgs({ enabled: true, modelPath: model, threshold: v }).at(-1)
    expect(at(undefined)).toBe('0.5')
    expect(at(null)).toBe('0.5')
    expect(at('loud')).toBe('0.5')
    expect(at(NaN)).toBe('0.5')
  })
})
