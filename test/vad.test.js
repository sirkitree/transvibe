import { describe, it, expect } from 'vitest'
import { createVad } from '../src/renderer/vad.js'

const rep = (n, level) => new Array(n).fill(level)

// Push a sequence of RMS levels and collect every event the machine emits.
const drive = (vad, levels) => {
  const events = []
  for (const level of levels) {
    const ev = vad.push(level)
    if (ev) events.push(ev)
  }
  return events
}

const SILENCE = 0.001
const SPEECH = 0.2
const HANG_FRAMES = 35 // 700ms hangover / 20ms frames

describe('createVad', () => {
  it('emits exactly one start and one silence-terminated end for a clean utterance', () => {
    const vad = createVad()
    const events = drive(vad, [
      ...rep(10, SILENCE),
      ...rep(40, SPEECH),
      ...rep(40, SILENCE)
    ])

    expect(events.map(e => e.type)).toEqual(['start', 'end'])
    expect(events[1].reason).toBe('silence')
    expect(events[1].durationMs).toBe(800)
    expect(vad.state).toBe('idle')
  })

  it('reports the true onset frame, not the frame the onset test passed on', () => {
    const vad = createVad({ onsetFrames: 3 })
    const [start, end] = drive(vad, [
      ...rep(10, SILENCE),
      ...rep(40, SPEECH),
      ...rep(40, SILENCE)
    ])

    // speech begins on frame 10; the third consecutive speech frame is 12
    expect(start.atFrame).toBe(10)
    expect(start.startFrame).toBe(10)
    expect(end.startFrame).toBe(10)
  })

  it('does not split an utterance on a dip shorter than the hangover', () => {
    const vad = createVad()
    const events = drive(vad, [
      ...rep(30, SPEECH),
      ...rep(HANG_FRAMES - 5, SILENCE),
      ...rep(30, SPEECH),
      ...rep(HANG_FRAMES + 5, SILENCE)
    ])

    expect(events.map(e => e.type)).toEqual(['start', 'end'])
    expect(events[1].reason).toBe('silence')
    expect(events[1].startFrame).toBe(0)
    // measured to the last speech frame, hangover tail excluded
    expect(events[1].durationMs).toBe((30 + HANG_FRAMES - 5 + 30) * 20)
  })

  it('returns to speech (not idle) during a short dip', () => {
    const vad = createVad()
    drive(vad, rep(30, SPEECH))
    expect(vad.state).toBe('speech')
    drive(vad, rep(5, SILENCE))
    expect(vad.state).toBe('hangover')
    drive(vad, rep(1, SPEECH))
    expect(vad.state).toBe('speech')
  })

  it('splits into two segments across a gap longer than the hangover', () => {
    const vad = createVad()
    const events = drive(vad, [
      ...rep(30, SPEECH),
      ...rep(HANG_FRAMES + 10, SILENCE),
      ...rep(30, SPEECH),
      ...rep(HANG_FRAMES + 10, SILENCE)
    ])

    expect(events.map(e => e.type)).toEqual(['start', 'end', 'start', 'end'])
    expect(events.every(e => e.type === 'start' || e.reason === 'silence')).toBe(true)
    expect(events[0].atFrame).toBe(0)
    expect(events[1].startFrame).toBe(0)
    expect(events[2].atFrame).toBe(30 + HANG_FRAMES + 10)
    expect(events[3].startFrame).toBe(events[2].atFrame)
    expect(events[3].durationMs).toBe(600)
  })

  it('marks a too-short blip as discarded', () => {
    const vad = createVad({ minSegmentMs: 400 })
    const events = drive(vad, [
      ...rep(5, SPEECH),
      ...rep(HANG_FRAMES + 5, SILENCE)
    ])

    expect(events.map(e => e.type)).toEqual(['start', 'end'])
    expect(events[1].reason).toBe('discarded')
    expect(events[1].durationMs).toBe(100)
    expect(vad.state).toBe('idle')
  })

  it('force-flushes a segment at maxSegmentMs and keeps listening', () => {
    const vad = createVad() // 15000ms max => 750 frames
    const events = drive(vad, [
      ...rep(1000, SPEECH),
      ...rep(HANG_FRAMES + 5, SILENCE)
    ])

    expect(events.map(e => e.type)).toEqual(['start', 'end', 'end'])
    expect(events[1].reason).toBe('max')
    expect(events[1].startFrame).toBe(0)
    expect(events[1].durationMs).toBe(15000)
    expect(events[1].atFrame).toBe(749)

    // the next segment picks up where the flush happened, losing nothing
    expect(events[2].reason).toBe('silence')
    expect(events[2].startFrame).toBe(749)
    expect(events[2].durationMs).toBe((999 - 749 + 1) * 20)
  })

  it('emits nothing for steady low-level noise below the threshold', () => {
    const vad = createVad({ threshold: 0.02 })
    const events = drive(vad, rep(500, 0.01))

    expect(events).toEqual([])
    expect(vad.state).toBe('idle')
    expect(vad.noiseFloor).toBeGreaterThan(0)
    expect(vad.noiseFloor).toBeLessThanOrEqual(0.01)
  })

  it('does not adapt the noise floor while speaking', () => {
    const vad = createVad()
    drive(vad, rep(50, SILENCE))
    const idleFloor = vad.noiseFloor
    drive(vad, rep(200, SPEECH))
    expect(vad.state).toBe('speech')
    expect(vad.noiseFloor).toBe(idleFloor)
  })

  it('changes sensitivity via setThreshold', () => {
    const quiet = rep(30, 0.03)

    const sensitive = createVad({ threshold: 0.02 })
    expect(drive(sensitive, [...quiet, ...rep(HANG_FRAMES + 5, SILENCE)]).map(e => e.type))
      .toEqual(['start', 'end'])

    const deaf = createVad({ threshold: 0.02 })
    deaf.setThreshold(0.1)
    expect(drive(deaf, [...quiet, ...rep(HANG_FRAMES + 5, SILENCE)])).toEqual([])
    expect(deaf.state).toBe('idle')

    // and back down again
    deaf.setThreshold(0.02)
    expect(drive(deaf, quiet).map(e => e.type)).toEqual(['start'])
  })

  it('reset() mid-speech drops the segment and emits nothing further', () => {
    const vad = createVad()
    const before = drive(vad, rep(20, SPEECH))
    expect(before.map(e => e.type)).toEqual(['start'])
    expect(vad.state).toBe('speech')

    const floor = vad.noiseFloor
    vad.reset()
    expect(vad.state).toBe('idle')
    expect(vad.noiseFloor).toBe(floor) // the learned floor survives

    expect(drive(vad, rep(HANG_FRAMES + 20, SILENCE))).toEqual([])
    expect(vad.state).toBe('idle')
  })

  it('never lets an open segment outlive maxSegmentMs, hangover tail included', () => {
    // ends the segment near the cap, dips into hangover, then speaks again:
    // the cap must still bound the frames the caller has buffered
    const vad = createVad() // 15000ms max => 750 frames
    const events = drive(vad, [
      ...rep(740, SPEECH),
      ...rep(20, SILENCE),
      ...rep(40, SPEECH),
      ...rep(HANG_FRAMES + 5, SILENCE)
    ])

    const ends = events.filter(e => e.type === 'end')
    expect(ends[0].reason).toBe('max')
    expect(ends[0].atFrame - ends[0].startFrame + 1).toBeLessThanOrEqual(750)
    for (const e of events) {
      expect(e.atFrame - e.startFrame + 1).toBeLessThanOrEqual(750)
    }
  })

  it('falls back to sane defaults for non-finite or nonsensical options', () => {
    for (const bad of [
      { frameMs: NaN },
      { frameMs: 0 },
      { frameMs: -20 },
      { hangoverMs: NaN },
      { maxSegmentMs: 0 },
      { minSegmentMs: NaN },
      { threshold: NaN },
      { onsetFrames: NaN },
      { noiseFloorAdapt: NaN },
      { noiseFloorAdapt: 1.5 },
      { noiseFloorAdapt: -1 }
    ]) {
      const vad = createVad(bad)
      const events = drive(vad, [
        ...rep(10, SILENCE),
        ...rep(40, SPEECH),
        ...rep(HANG_FRAMES + 5, SILENCE)
      ])

      const label = JSON.stringify(bad)
      expect([label, events.map(e => e.type)]).toEqual([label, ['start', 'end']])
      expect([label, Number.isFinite(events[1].durationMs)]).toEqual([label, true])
      expect([label, events[1].durationMs]).toEqual([label, 800])
      expect([label, Number.isFinite(vad.noiseFloor)]).toEqual([label, true])
      expect([label, vad.state]).toEqual([label, 'idle'])
    }
  })

  it('still requires the default onset run when onsetFrames is not a number', () => {
    const vad = createVad({ onsetFrames: NaN })
    expect(drive(vad, [...rep(2, SPEECH), ...rep(HANG_FRAMES + 5, SILENCE)])).toEqual([])
    expect(drive(vad, rep(3, SPEECH)).map(e => e.type)).toEqual(['start'])
  })

  it('keeps detecting after long stretches of noise-floor adaptation', () => {
    const vad = createVad()
    drive(vad, rep(20000, SILENCE))
    expect(vad.noiseFloor).toBeGreaterThanOrEqual(0)
    expect(vad.noiseFloor).toBeLessThanOrEqual(SILENCE)
    expect(drive(vad, rep(40, SPEECH)).map(e => e.type)).toEqual(['start'])
  })

  it('honours custom frameMs and onsetFrames', () => {
    const vad = createVad({ frameMs: 10, onsetFrames: 5, hangoverMs: 100, minSegmentMs: 50 })
    const events = drive(vad, [
      ...rep(4, SPEECH), // one short of the onset requirement
      ...rep(20, SILENCE),
      ...rep(20, SPEECH),
      ...rep(20, SILENCE)
    ])

    expect(events.map(e => e.type)).toEqual(['start', 'end'])
    expect(events[0].atFrame).toBe(24)
    expect(events[1].durationMs).toBe(200)
  })
})

/* Music playing in the room reads as speech and never stops, which used to
   freeze the noise floor at whatever the room was when the track started —
   every max-length flush then handed whisper another chunk of the song. */
describe('a room that never goes quiet', () => {
  const MUSIC = 0.06

  it('learns a steady background as the new floor', () => {
    const vad = createVad({ frameMs: 20, threshold: 0.02 })
    // A minute of unbroken music, well past any real sentence.
    drive(vad, rep(3000, MUSIC))
    expect(vad.noiseFloor).toBeGreaterThan(MUSIC * 0.4)
    expect(vad.threshold).toBe(0.02)   // the setting itself is untouched
  })

  it('stops calling the music speech once it has learnt it', () => {
    const vad = createVad({ frameMs: 20, threshold: 0.02 })
    drive(vad, rep(3000, MUSIC))
    const after = drive(vad, rep(600, MUSIC))
    expect(after).toEqual([])
    expect(vad.state).toBe('idle')
  })

  it('still hears someone talking over it', () => {
    const vad = createVad({ frameMs: 20, threshold: 0.02 })
    drive(vad, rep(3000, MUSIC))
    const events = drive(vad, [...rep(40, 0.35), ...rep(HANG_FRAMES + 2, MUSIC)])
    expect(events.map(e => e.type)).toEqual(['start', 'end'])
    expect(events[1].reason).toBe('silence')
  })

  it('leaves ordinary speech alone — it is never loud for that long', () => {
    const vad = createVad({ frameMs: 20, threshold: 0.02 })
    // Ten sentences with breaths between them: the floor stays where it was.
    for (let i = 0; i < 10; i++) {
      drive(vad, [...rep(100, SPEECH), ...rep(HANG_FRAMES + 5, SILENCE)])
    }
    expect(vad.noiseFloor).toBeLessThan(0.01)
  })

  it('reports how long it has been loud, for anyone tuning this', () => {
    const vad = createVad({ frameMs: 20, threshold: 0.02 })
    drive(vad, rep(50, SPEECH))
    expect(vad.loudMs).toBe(1000)
    drive(vad, rep(1, SILENCE))
    expect(vad.loudMs).toBe(0)
  })
})
