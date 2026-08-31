import { describe, it, expect, vi, afterEach } from 'vitest'
import { listOllamaModels } from '../src/main/assist.js'

const reply = body => vi.fn().mockResolvedValue({
  ok: true,
  json: async () => body
})

afterEach(() => { vi.unstubAllGlobals() })

describe('listOllamaModels', () => {
  it('returns the pulled models, sorted', async () => {
    vi.stubGlobal('fetch', reply({
      models: [{ name: 'qwen3:4b' }, { name: 'gemma4:e2b' }]
    }))
    expect(await listOllamaModels()).toEqual({
      models: ['gemma4:e2b', 'qwen3:4b'],
      reachable: true
    })
  })

  it('reads an empty Ollama as reachable with nothing pulled', async () => {
    // Different from Ollama being down, and the panel says something different
    // about each: "nothing pulled yet" is a thing you can fix from here.
    vi.stubGlobal('fetch', reply({ models: [] }))
    expect(await listOllamaModels()).toEqual({ models: [], reachable: true })
  })

  it('reports an absent Ollama rather than throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    expect(await listOllamaModels()).toEqual({ models: [], reachable: false })
  })

  it('treats an error response as unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }))
    expect(await listOllamaModels()).toEqual({ models: [], reachable: false })
  })

  it('drops entries with no name rather than listing a blank', async () => {
    vi.stubGlobal('fetch', reply({ models: [{ name: 'gemma4:e2b' }, {}, { name: '' }] }))
    expect((await listOllamaModels()).models).toEqual(['gemma4:e2b'])
  })

  it('asks the URL it is given', async () => {
    const fetcher = reply({ models: [] })
    vi.stubGlobal('fetch', fetcher)
    await listOllamaModels('http://127.0.0.1:9999')
    expect(fetcher.mock.calls[0][0]).toBe('http://127.0.0.1:9999/api/tags')
  })
})
