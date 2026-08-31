import { describe, it, expect } from 'vitest'
import {
  ARTIFACTS,
  parseCliOutput,
  parseServerJson,
  isArtifact,
  cleanTranscript,
  createQueue
} from '../src/main/whisper-parse.js'

const CLI_SAMPLE = [
  'whisper_init_from_file_with_params_no_state: loading model from ggml-base.en.bin',
  'whisper_model_load: n_vocab = 51864',
  'ggml_metal_init: allocating',
  'system_info: n_threads = 4 / 8 | AVX = 0 |',
  '',
  'main: processing 48000 samples, 3.0 sec',
  '',
  '[00:00:00.000 --> 00:00:02.400]   Testing one two three.',
  '[00:00:02.400 --> 00:00:05.120]   The quick brown fox.',
  'whisper_print_timings:     load time =   120.00 ms',
  '[00:00:05.120 --> 00:00:07.000]   Jumps over the lazy dog.',
  ''
].join('\n')

describe('parseCliOutput', () => {
  it('parses timestamped segments and ignores log noise', () => {
    const out = parseCliOutput(CLI_SAMPLE)
    expect(out.text).toBe('Testing one two three. The quick brown fox. Jumps over the lazy dog.')
    expect(out.segments).toEqual([
      { startMs: 0, endMs: 2400, text: 'Testing one two three.' },
      { startMs: 2400, endMs: 5120, text: 'The quick brown fox.' },
      { startMs: 5120, endMs: 7000, text: 'Jumps over the lazy dog.' }
    ])
  })

  it('collapses internal whitespace inside a segment', () => {
    const out = parseCliOutput('[00:01:02.500 --> 00:01:03.000]    hello    there  ')
    expect(out.segments).toEqual([{ startMs: 62500, endMs: 63000, text: 'hello there' }])
    expect(out.text).toBe('hello there')
  })

  it('handles empty and whitespace-only input', () => {
    expect(parseCliOutput('')).toEqual({ text: '', segments: [] })
    expect(parseCliOutput('   \n\n  ')).toEqual({ text: '', segments: [] })
    expect(parseCliOutput(undefined)).toEqual({ text: '', segments: [] })
  })

  it('drops malformed bracket lines that are not timestamps', () => {
    const out = parseCliOutput('[not a timestamp]\n[00:00:00.000 --> 00:00:01.000]  ok')
    expect(out.text).toBe('ok')
    expect(out.segments).toHaveLength(1)
  })
})

describe('parseServerJson', () => {
  it('accepts the plain { text } shape', () => {
    expect(parseServerJson({ text: '  Testing one   two three. ' })).toEqual({
      text: 'Testing one two three.',
      segments: []
    })
  })

  it('accepts the { transcription: [...] } shape', () => {
    const out = parseServerJson({
      transcription: [
        { timestamps: { from: '00:00:00,000', to: '00:00:02,400' }, text: '  Testing one two three.' },
        { timestamps: { from: '00:00:02.400', to: '00:01:05.120' }, text: ' The quick brown fox.' }
      ]
    })
    expect(out.text).toBe('Testing one two three. The quick brown fox.')
    expect(out.segments).toEqual([
      { startMs: 0, endMs: 2400, text: 'Testing one two three.' },
      { startMs: 2400, endMs: 65120, text: 'The quick brown fox.' }
    ])
  })

  it('is defensive about junk input', () => {
    expect(parseServerJson(null)).toEqual({ text: '', segments: [] })
    expect(parseServerJson({})).toEqual({ text: '', segments: [] })
    expect(parseServerJson({ transcription: [] })).toEqual({ text: '', segments: [] })
  })
})

describe('artifact filtering', () => {
  it('filters every known stock phrase to an empty string', () => {
    for (const phrase of ARTIFACTS) {
      expect(isArtifact(phrase), phrase).toBe(true)
      expect(cleanTranscript(phrase), phrase).toBe('')
    }
  })

  it('ignores case and trailing punctuation', () => {
    expect(cleanTranscript('THANK YOU!')).toBe('')
    expect(cleanTranscript('  thanks for watching  ')).toBe('')
    expect(cleanTranscript('You')).toBe('')
    expect(cleanTranscript('please subscribe.')).toBe('')
    expect(cleanTranscript('mm hmm')).toBe('')
  })

  it('filters punctuation-only and bracketed-only output', () => {
    expect(cleanTranscript('....')).toBe('')
    expect(cleanTranscript(' ?! ')).toBe('')
    expect(cleanTranscript('[music]')).toBe('')
    expect(cleanTranscript('(applause)')).toBe('')
    expect(cleanTranscript('')).toBe('')
    expect(cleanTranscript('   ')).toBe('')
  })

  it('leaves real sentences containing artifact words untouched', () => {
    const keepers = [
      'I told you about the meeting yesterday.',
      'Thank you for sending over the notes.',
      'Please subscribe to the mailing list before Friday.',
      'You should see the new build.',
      'Bye. See you at noon.'
    ]
    for (const sentence of keepers) {
      expect(isArtifact(sentence), sentence).toBe(false)
      expect(cleanTranscript(sentence), sentence).toBe(sentence)
    }
  })

  it('collapses whitespace on surviving text', () => {
    expect(cleanTranscript('  hello    world  ')).toBe('hello world')
  })
})

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

describe('createQueue', () => {
  it('runs jobs strictly FIFO with at most one in flight', async () => {
    const order = []
    let inFlight = 0
    let peak = 0
    const queue = createQueue(async job => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await wait(job.delay)
      order.push(job.id)
      inFlight -= 1
      return job.id
    })

    const results = await Promise.all([
      queue.push({ id: 'a', delay: 30 }),
      queue.push({ id: 'b', delay: 1 }),
      queue.push({ id: 'c', delay: 15 }),
      queue.push({ id: 'd', delay: 0 })
    ])

    expect(order).toEqual(['a', 'b', 'c', 'd'])
    expect(results).toEqual(['a', 'b', 'c', 'd'])
    expect(peak).toBe(1)
  })

  it('reports size and running, and drains to idle', async () => {
    const queue = createQueue(async n => {
      await wait(5)
      return n * 2
    })
    expect(queue.size).toBe(0)
    expect(queue.running).toBe(false)
    await queue.drain()

    const first = queue.push(1)
    queue.push(2)
    queue.push(3)
    expect(queue.running).toBe(true)
    expect(queue.size).toBe(2)

    await expect(first).resolves.toBe(2)
    await queue.drain()
    expect(queue.size).toBe(0)
    expect(queue.running).toBe(false)
  })

  it('does not stall when a job rejects', async () => {
    const seen = []
    const queue = createQueue(async job => {
      await wait(1)
      seen.push(job)
      if (job === 'boom') throw new Error('nope')
      return job
    })

    const a = queue.push('a')
    const bad = queue.push('boom')
    const c = queue.push('c')

    await expect(a).resolves.toBe('a')
    await expect(bad).rejects.toThrow('nope')
    await expect(c).resolves.toBe('c')
    expect(seen).toEqual(['a', 'boom', 'c'])

    await queue.drain()
    expect(queue.running).toBe(false)
    await expect(queue.push('d')).resolves.toBe('d')
  })

  it('survives a synchronously throwing worker', async () => {
    const queue = createQueue(job => {
      if (job === 'bad') throw new Error('sync boom')
      return job
    })
    await expect(queue.push('bad')).rejects.toThrow('sync boom')
    await expect(queue.push('ok')).resolves.toBe('ok')
    await queue.drain()
  })

  it('is idle immediately after the last job settles', async () => {
    const queue = createQueue(async n => n * 2)
    const value = await queue.push(5)
    expect(value).toBe(10)
    expect(queue.running).toBe(false)
    expect(queue.size).toBe(0)
  })

  it('keeps queues independent of one another', async () => {
    const doubler = createQueue(async n => n * 2)
    const adder = createQueue(async n => n + 1)
    const [a, b] = await Promise.all([doubler.push(3), adder.push(3)])
    expect([a, b]).toEqual([6, 4])
    expect(doubler.running).toBe(false)
    expect(adder.running).toBe(false)
  })
})

describe('parse edge cases', () => {
  it('handles CRLF line endings from the CLI', () => {
    const out = parseCliOutput(
      '[00:00:00.000 --> 00:00:01.000]  hi\r\n[00:00:01.000 --> 00:00:02.000]  there\r\n'
    )
    expect(out.text).toBe('hi there')
    expect(out.segments).toEqual([
      { startMs: 0, endMs: 1000, text: 'hi' },
      { startMs: 1000, endMs: 2000, text: 'there' }
    ])
  })

  it('parses clocks past the hour and without a fraction', () => {
    const out = parseServerJson({
      transcription: [
        { timestamps: { from: '01:02:03.456', to: '00:00:03' }, text: 'x' }
      ]
    })
    expect(out.segments[0].startMs).toBe(3723456)
    expect(out.segments[0].endMs).toBe(3000)
  })

  it('does not carry segments between parse calls', () => {
    expect(parseCliOutput('a').segments).toHaveLength(1)
    expect(parseCliOutput('b').segments).toEqual([
      { startMs: null, endMs: null, text: 'b' }
    ])
    expect(parseCliOutput('').segments).toEqual([])
  })
})
