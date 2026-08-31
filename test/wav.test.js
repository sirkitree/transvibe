import { describe, it, expect } from 'vitest'
import { encodeWav, durationSeconds } from '../src/main/wav.js'

function view (bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function ascii (bytes, offset, length) {
  let out = ''
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i])
  return out
}

function readSamples (bytes) {
  const dv = view(bytes)
  const count = (bytes.length - 44) / 2
  const out = new Int16Array(count)
  for (let i = 0; i < count; i++) out[i] = dv.getInt16(44 + i * 2, true)
  return out
}

describe('encodeWav header', () => {
  const wav = encodeWav(new Float32Array(8), 16000)
  const dv = view(wav)

  it('writes the canonical chunk ids', () => {
    expect(ascii(wav, 0, 4)).toBe('RIFF')
    expect(ascii(wav, 8, 4)).toBe('WAVE')
    expect(ascii(wav, 12, 4)).toBe('fmt ')
    expect(ascii(wav, 36, 4)).toBe('data')
  })

  it('declares 16-bit mono PCM', () => {
    expect(dv.getUint32(16, true)).toBe(16) // Subchunk1Size
    expect(dv.getUint16(20, true)).toBe(1) // audioFormat = PCM
    expect(dv.getUint16(22, true)).toBe(1) // numChannels
    expect(dv.getUint16(34, true)).toBe(16) // bitsPerSample
  })

  it('computes sampleRate, byteRate and blockAlign', () => {
    expect(dv.getUint32(24, true)).toBe(16000)
    expect(dv.getUint32(28, true)).toBe(16000 * 2)
    expect(dv.getUint16(32, true)).toBe(2)
  })

  it('honors a different sample rate', () => {
    const dv48 = view(encodeWav(new Float32Array(4), 48000))
    expect(dv48.getUint32(24, true)).toBe(48000)
    expect(dv48.getUint32(28, true)).toBe(96000)
    expect(dv48.getUint16(32, true)).toBe(2)
  })
})

describe('encodeWav sizes', () => {
  it('is 44 bytes plus two bytes per sample', () => {
    const samples = new Float32Array(100)
    const wav = encodeWav(samples, 16000)
    expect(wav).toBeInstanceOf(Uint8Array)
    expect(wav.length).toBe(44 + samples.length * 2)
  })

  it('stores matching ChunkSize and Subchunk2Size fields', () => {
    const samples = new Float32Array(37)
    const wav = encodeWav(samples, 16000)
    const dv = view(wav)
    expect(dv.getUint32(4, true)).toBe(36 + samples.length * 2)
    expect(dv.getUint32(40, true)).toBe(samples.length * 2)
    expect(dv.getUint32(4, true)).toBe(wav.length - 8)
  })

  it('produces a header-only file for empty input', () => {
    const wav = encodeWav(new Float32Array(0), 16000)
    expect(wav.length).toBe(44)
    const dv = view(wav)
    expect(dv.getUint32(4, true)).toBe(36)
    expect(dv.getUint32(40, true)).toBe(0)
    expect(ascii(wav, 0, 4)).toBe('RIFF')
    expect(ascii(wav, 36, 4)).toBe('data')
  })
})

describe('encodeWav samples', () => {
  it('round-trips a ramp within 1 LSB', () => {
    const n = 256
    const samples = new Float32Array(n)
    for (let i = 0; i < n; i++) samples[i] = -1 + (2 * i) / (n - 1)

    const back = readSamples(encodeWav(samples, 16000))
    expect(back.length).toBe(n)
    for (let i = 0; i < n; i++) {
      const s = samples[i]
      const expected = s < 0 ? s * 0x8000 : s * 0x7fff
      expect(Math.abs(back[i] - expected)).toBeLessThanOrEqual(1)
    }
  })

  it('maps full scale in both directions', () => {
    const back = readSamples(encodeWav(new Float32Array([1, -1, 0]), 16000))
    expect(back[0]).toBe(32767)
    expect(back[1]).toBe(-32768)
    expect(back[2]).toBe(0)
  })

  it('clamps out-of-range values instead of wrapping', () => {
    const back = readSamples(encodeWav(new Float32Array([2, -2, 100, -100]), 16000))
    expect(back[0]).toBe(32767)
    expect(back[1]).toBe(-32768)
    expect(back[2]).toBe(32767)
    expect(back[3]).toBe(-32768)
  })

  it('accepts a plain array of numbers', () => {
    const back = readSamples(encodeWav([0.5, -0.5], 16000))
    expect(back[0]).toBe(Math.round(0.5 * 0x7fff))
    expect(back[1]).toBe(Math.round(-0.5 * 0x8000))
  })
})

describe('input validation', () => {
  it('throws TypeError on a non array-like first argument', () => {
    expect(() => encodeWav(null)).toThrow(TypeError)
    expect(() => encodeWav(undefined)).toThrow(TypeError)
    expect(() => encodeWav(42)).toThrow(TypeError)
    expect(() => encodeWav({})).toThrow(TypeError)
  })

  it('throws RangeError on a bad sample rate', () => {
    const samples = new Float32Array(4)
    expect(() => encodeWav(samples, 0)).toThrow(RangeError)
    expect(() => encodeWav(samples, -16000)).toThrow(RangeError)
    expect(() => encodeWav(samples, Number.NaN)).toThrow(RangeError)
    expect(() => encodeWav(samples, Number.POSITIVE_INFINITY)).toThrow(RangeError)
    expect(() => encodeWav(samples, '16000')).toThrow(RangeError)
  })
})

describe('durationSeconds', () => {
  it('divides sample count by rate', () => {
    expect(durationSeconds(new Float32Array(16000), 16000)).toBe(1)
    expect(durationSeconds(new Float32Array(8000), 16000)).toBe(0.5)
    expect(durationSeconds(new Float32Array(0), 16000)).toBe(0)
  })

  it('defaults to 16 kHz', () => {
    expect(durationSeconds(new Float32Array(32000))).toBe(2)
  })

  it('validates its inputs', () => {
    expect(() => durationSeconds(null, 16000)).toThrow(TypeError)
    expect(() => durationSeconds(new Float32Array(1), 0)).toThrow(RangeError)
  })
})

describe('encodeWav edge cases', () => {
  it('defaults to a 16 kHz header', () => {
    const dv = view(encodeWav(new Float32Array(4)))
    expect(dv.getUint32(24, true)).toBe(16000)
    expect(dv.getUint32(28, true)).toBe(32000)
  })

  it('rounds a fractional sample rate consistently in both fields', () => {
    const dv = view(encodeWav(new Float32Array(2), 22050.4))
    expect(dv.getUint32(24, true)).toBe(22050)
    expect(dv.getUint32(28, true)).toBe(44100)
  })

  it('refuses a sample rate whose byteRate would overflow uint32', () => {
    expect(() => encodeWav(new Float32Array(1), 6e9)).toThrow(RangeError)
  })

  it('writes every size field little-endian', () => {
    const wav = encodeWav(new Float32Array(2), 16000)
    // 40 bytes of data-chunk-less prefix + 4 data bytes => ChunkSize 40 = 0x28
    expect(Array.from(wav.slice(4, 8))).toEqual([0x28, 0, 0, 0])
    expect(Array.from(wav.slice(40, 44))).toEqual([4, 0, 0, 0])
    expect(Array.from(wav.slice(24, 28))).toEqual([0x80, 0x3e, 0, 0]) // 16000
  })

  it('treats non-finite and missing samples as silence', () => {
    const back = readSamples(encodeWav([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, undefined, 0.25], 16000))
    expect(Array.from(back.slice(0, 4))).toEqual([0, 0, 0, 0])
    expect(back[4]).toBe(Math.round(0.25 * 0x7fff))
  })

  it('never emits -0 or a wrapped value for negative zero', () => {
    const back = readSamples(encodeWav(new Float32Array([-0]), 16000))
    expect(Object.is(back[0], 0)).toBe(true)
  })

  it('accepts a bare array-like object', () => {
    const wav = encodeWav({ length: 3, 0: 1, 1: -1, 2: 0 }, 16000)
    expect(wav.length).toBe(44 + 6)
    expect(Array.from(readSamples(wav))).toEqual([32767, -32768, 0])
  })

  it('rejects strings and functions rather than encoding char codes', () => {
    expect(() => encodeWav('abc')).toThrow(TypeError)
    expect(() => encodeWav(() => {})).toThrow(TypeError)
    expect(() => encodeWav({ length: -1 })).toThrow(TypeError)
    expect(() => encodeWav({ length: 1.5 })).toThrow(TypeError)
  })

  it('returns a view covering exactly its own buffer and keeps no state between calls', () => {
    const a = encodeWav(new Float32Array([1, 1]), 16000)
    const b = encodeWav(new Float32Array([0, 0]), 48000)
    expect(a.byteOffset).toBe(0)
    expect(a.byteLength).toBe(a.buffer.byteLength)
    expect(a.buffer).not.toBe(b.buffer)
    expect(Array.from(readSamples(a))).toEqual([32767, 32767])
    expect(view(a).getUint32(24, true)).toBe(16000)
    expect(view(b).getUint32(24, true)).toBe(48000)
  })

  it('does not mutate its input', () => {
    const samples = new Float32Array([2, -2, 0.5])
    encodeWav(samples, 16000)
    expect(Array.from(samples)).toEqual([2, -2, 0.5])
  })
})
