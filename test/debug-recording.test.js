import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDebugRecording } from '../src/main/debug-recording.js'
import { createRecordingBuffer } from '../src/renderer/recording-buffer.js'
import { parseEvents, reviewHtml } from '../src/main/debug-review.js'

function fixture (test) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transvibe-recording-'))
  try { test(root) } finally { fs.rmSync(root, { recursive: true, force: true }) }
}
describe('local debug recordings', () => {
  it('is opt-in and writes a playable, correctly sized WAV plus correlated events', () => fixture(root => {
    const r = createDebugRecording(root)
    r.audio(new Float32Array(10))
    r.event('ignored')
    expect(fs.readdirSync(root)).toEqual([])
    r.start({ threshold: 0.03 })
    const { directory, id } = r.status
    r.audio(new Float32Array([0, 1]), { startedAt: 1000 })
    r.audio(new Float32Array([-1]), { startedAt: 1001 })
    const wav = fs.readFileSync(path.join(directory, 'microphone.wav'))
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.length).toBe(50)
    expect(wav.readUInt32LE(4)).toBe(42)
    expect(wav.readUInt32LE(40)).toBe(6)
    expect(r.segment(new Float32Array(20), 'test-id')).toBe('utterance-test-id.wav')
    expect(r.segment(new Float32Array(20), '../escape')).toBe(null)
    r.stop()
    r.event('late', {}, id)
    const events = parseEvents(fs.readFileSync(path.join(directory, 'events.jsonl'), 'utf8'))
    expect(events.map(e => e.type)).toEqual(['session-start', 'audio-span', 'audio-span', 'session-end'])
    expect(events[2].offsetSeconds).toBe(2 / 16000)
  }))
  it('does not mix late recognition results into a new session', () => fixture(root => {
    const r = createDebugRecording(root)
    r.start({})
    const old = r.status.id
    r.stop()
    r.start({})
    const dir = r.status.directory
    r.event('late-result', {}, old)
    r.stop()
    expect(fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8')).not.toContain('late-result')
  }))
  it('reports disk errors and stops without throwing into the app', () => fixture(root => {
    const errors = []
    fs.writeFileSync(path.join(root, 'file'), '')
    const r = createDebugRecording(path.join(root, 'file'), error => errors.push(error))
    expect(() => r.start({})).not.toThrow()
    expect(r.status.active).toBe(false)
    expect(errors).toHaveLength(1)
  }))
  it('flushes partial audio on pause and never retains paused frames', () => {
    const chunks = []
    const b = createRecordingBuffer((samples, detail) => chunks.push({ samples, detail }))
    b.push(new Float32Array([9]))
    b.setActive(true)
    b.push(new Float32Array([1, 2]), 1000)
    b.setActive(false)
    b.push(new Float32Array([9]))
    b.setActive(true)
    b.push(new Float32Array([3]), 2000)
    b.flush()
    expect(chunks.map(c => [...c.samples])).toEqual([[1, 2], [3]])
    expect(chunks[0].detail.endedAt).toBe(1000)
  })
  it('escapes recorded text in review pages and tolerates an unfinished live log line', () => {
    expect(parseEvents('{"type":"ok"}\n{"type":')).toEqual([{ type: 'ok' }])
    const page = reviewHtml([{ type: 'conversation-question', question: '<script>alert(1)</script>' }])
    expect(page).not.toContain('<script>')
    expect(page).toContain('&lt;script&gt;')
    expect(() => parseEvents('bad\n')).toThrow('line 1')
  })
})
