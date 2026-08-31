import { describe, it, expect } from 'vitest'
import { modelName, humanSize } from '../src/main/models.js'

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
