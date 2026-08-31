import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { modelName, humanSize, listModels } from '../src/main/models.js'

describe('modelName', () => {
  it('strips the ggml prefix and the extension', () => {
    expect(modelName('ggml-small.en.bin')).toBe('small.en')
    expect(modelName('ggml-base.en.bin')).toBe('base.en')
  })

  it('normalises the name MacWhisper gives the same model', () => {
    // Otherwise the list reads as two unrelated models sitting side by side.
    expect(modelName('ggml-model-whisper-small.bin')).toBe('small')
  })

  it('leaves a name it does not recognise alone', () => {
    expect(modelName('my-finetune-v3.bin')).toBe('my-finetune-v3')
  })
})

describe('humanSize', () => {
  it('reads megabytes below a gigabyte and gigabytes above', () => {
    expect(humanSize(147951465)).toBe('148 MB')
    expect(humanSize(487601967)).toBe('488 MB')
    expect(humanSize(3.1e9)).toBe('3.1 GB')
  })

  it('says nothing rather than something wrong about a size it does not have', () => {
    expect(humanSize(0)).toBe('')
    expect(humanSize(undefined)).toBe('')
  })
})

/* The walk reads real directories, so these run against a real one: a
   temporary Application Support laid out the way the apps on a Mac lay theirs
   out, with the traps that were actually hit — a CoreML bundle full of large
   weight.bin files, and an OpenVINO encoder sitting beside its model. */
describe('listModels', () => {
  const big = 2e7
  let root

  const write = (rel, bytes) => {
    const full = path.join(root, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, Buffer.alloc(bytes))
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'transvibe-models-'))
  })
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

  const found = () => listModels({ roots: [{ dir: root, depth: 4 }] })

  it('finds a model an app keeps a few folders down', () => {
    write('Highlight/Dependencies/Whisper/ggml-small.en.bin', big)
    expect(found().map(m => ({ name: m.name, from: m.from })))
      .toEqual([{ name: 'small.en', from: 'Highlight' }])
  })

  it('does not mistake a CoreML bundle for a model', () => {
    // Every one of these weight files is bigger than a small ggml model.
    write('MacWhisper/models/whisperkit/AudioEncoder.mlmodelc/weights/weight.bin', big)
    write('MacWhisper/models/ggml-model-whisper-small.bin', big)
    expect(found().map(m => m.name)).toEqual(['small'])
  })

  it('skips the encoder sidecar sitting beside a model', () => {
    write('Highlight/ggml-small.en-encoder-openvino.bin', big)
    write('Highlight/ggml-small.en.bin', big)
    expect(found().map(m => m.file)).toEqual(['ggml-small.en.bin'])
  })

  it('lists the same model in two apps once', () => {
    write('MacWhisper/models/ggml-small.en.bin', big)
    write('superwhisper/ggml-small.en.bin', big)
    expect(found()).toHaveLength(1)
  })

  it('ignores the small blobs that share those folders', () => {
    write('superwhisper/vad-v1.onnx', big)
    write('superwhisper/ggml-tiny.en.bin', 1e6)
    expect(found()).toEqual([])
  })

  it('says nothing rather than throwing when there is nowhere to look', () => {
    expect(listModels({ roots: [{ dir: path.join(root, 'gone'), depth: 3 }] })).toEqual([])
  })
})
