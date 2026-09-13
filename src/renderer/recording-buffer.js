// Retain every microphone frame while recording, including frames the speech
// gate rejects and frames captured while the app talks. Pausing flushes the
// tail and leaves an explicit gap rather than retaining paused audio.
export function createRecordingBuffer (emit, sampleRate = 16000) {
  let active = false
  let parts = []
  let size = 0
  let startedAt = 0
  function flush () {
    if (!size) return
    const samples = new Float32Array(size)
    let offset = 0
    for (const part of parts) { samples.set(part, offset); offset += part.length }
    emit(samples, { startedAt, endedAt: startedAt + size / sampleRate * 1000 })
    parts = []
    size = 0
  }
  return {
    flush,
    setActive (value) {
      if (!value) flush()
      active = !!value
    },
    push (pcm, at = Date.now()) {
      if (!active) return
      if (!size) startedAt = at - pcm.length / sampleRate * 1000
      parts.push(pcm.slice())
      size += pcm.length
      if (size >= sampleRate) flush()
    }
  }
}
