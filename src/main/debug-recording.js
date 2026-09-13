import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { encodeWav } from './wav.js'

// Local, explicit recording. A valid WAV header is updated on every append,
// so even an interrupted session remains playable. Never block app behavior
// on a recorder failure: stop recording and report the error instead.
export function createDebugRecording (root, onError = () => {}) {
  let session = null
  let error = null
  function fail (err) {
    if (session?.fd != null) { try { fs.closeSync(session.fd) } catch {} }
    session = null
    error = err.message
    onError(error)
  }
  function event (type, detail = {}, id = session?.id) {
    if (!session || id !== session.id) return
    try {
      fs.appendFileSync(path.join(session.dir, 'events.jsonl'),
        JSON.stringify({ ...detail, type, at: new Date().toISOString(), session: session.id }) + '\n', { mode: 0o600 })
    } catch (err) { fail(err) }
  }
  function stop () {
    event('session-end')
    if (session?.fd != null) fs.closeSync(session.fd)
    session = null
  }
  return {
    get status () { return { active: !!session, id: session?.id, directory: session?.dir, error } },
    start (settings) {
      if (session) return
      error = null
      try {
        const id = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8)
        const dir = path.join(root, id)
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
        fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings, null, 2), { mode: 0o600 })
        const fd = fs.openSync(path.join(dir, 'microphone.wav'), 'w', 0o600)
        fs.writeSync(fd, encodeWav(new Float32Array()))
        session = { id, dir, fd, bytes: 0 }
        event('session-start', { sampleRate: 16000, audio: 'microphone.wav', audioProcessing: 'Browser echo cancellation, noise suppression and automatic gain control; not raw hardware audio.' })
      } catch (err) { fail(err) }
    },
    stop,
    event,
    audio (samples, detail = {}) {
      if (!session) return
      try {
        const wav = encodeWav(samples)
        const pcm = wav.subarray(44)
        if (session.bytes + pcm.length > 0xffffffff - 36) throw new Error('Recording reached the WAV size limit; start a new session.')
        const offsetSeconds = session.bytes / 32000
        fs.writeSync(session.fd, pcm, 0, pcm.length, 44 + session.bytes)
        session.bytes += pcm.length
        const size = Buffer.alloc(4)
        size.writeUInt32LE(session.bytes + 36)
        fs.writeSync(session.fd, size, 0, 4, 4)
        size.writeUInt32LE(session.bytes)
        fs.writeSync(session.fd, size, 0, 4, 40)
        event('audio-span', { ...detail, offsetSeconds, durationSeconds: samples.length / 16000 })
      } catch (err) { fail(err) }
    },
    segment (samples, id) {
      if (!session) return null
      const file = `utterance-${id}.wav`
      if (!/^[a-zA-Z0-9-]+$/.test(id)) return null
      try {
        fs.writeFileSync(path.join(session.dir, file), encodeWav(samples), { mode: 0o600 })
        return file
      } catch (err) { fail(err); return null }
    }
  }
}
