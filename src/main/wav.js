// Minimal canonical RIFF/WAVE encoder: mono, 16-bit signed PCM, little-endian.

const HEADER_BYTES = 44
const BITS_PER_SAMPLE = 16
const NUM_CHANNELS = 1

function isArrayLike (v) {
  if (v == null) return false
  if (typeof v === 'string' || typeof v === 'function') return false
  const n = v.length
  return typeof n === 'number' && Number.isInteger(n) && n >= 0
}

function writeAscii (view, offset, text) {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
}

export function encodeWav (float32Samples, sampleRate = 16000) {
  if (!isArrayLike(float32Samples)) {
    throw new TypeError('encodeWav: expected a Float32Array or array-like of samples')
  }
  if (typeof sampleRate !== 'number' || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError('encodeWav: sampleRate must be a positive finite number')
  }

  const count = float32Samples.length
  const rate = Math.round(sampleRate)
  const blockAlign = NUM_CHANNELS * (BITS_PER_SAMPLE / 8)
  const byteRate = rate * blockAlign
  const dataBytes = count * 2
  // every header size field is uint32; anything larger would wrap silently
  if (byteRate > 0xffffffff) {
    throw new RangeError('encodeWav: sampleRate too large for a 32-bit byteRate field')
  }
  if (dataBytes + 36 > 0xffffffff) {
    throw new RangeError('encodeWav: too many samples for a 32-bit RIFF size field')
  }
  const buffer = new ArrayBuffer(HEADER_BYTES + dataBytes)
  const view = new DataView(buffer)

  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true) // PCM fmt chunk size
  view.setUint16(20, 1, true) // audioFormat: 1 = PCM
  view.setUint16(22, NUM_CHANNELS, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, BITS_PER_SAMPLE, true)
  writeAscii(view, 36, 'data')
  view.setUint32(40, dataBytes, true)

  let offset = HEADER_BYTES
  for (let i = 0; i < count; i++) {
    const raw = float32Samples[i]
    const s = Number.isFinite(raw) ? Math.max(-1, Math.min(1, raw)) : 0
    // asymmetric scale: -1 maps to -32768, +1 maps to +32767
    view.setInt16(offset, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true)
    offset += 2
  }

  return new Uint8Array(buffer)
}

export function durationSeconds (float32Samples, sampleRate = 16000) {
  if (!isArrayLike(float32Samples)) {
    throw new TypeError('durationSeconds: expected a Float32Array or array-like of samples')
  }
  if (typeof sampleRate !== 'number' || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError('durationSeconds: sampleRate must be a positive finite number')
  }
  return float32Samples.length / sampleRate
}
