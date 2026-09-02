// Pure voice-activity detection. The caller feeds one RMS level per frame and
// gets back segment boundaries; this module never touches audio APIs.

const SPEECH_FLOOR_RATIO = 2.5

// A bad option must never be able to silently kill detection: a non-finite
// frameMs makes every duration NaN, and an adapt factor outside [0, 1) makes
// the noise floor diverge or go NaN, after which nothing ever reads as speech.
const positive = (v, fallback) => (Number.isFinite(v) && v > 0 ? v : fallback)
const nonNegative = (v, fallback) => (Number.isFinite(v) && v >= 0 ? v : fallback)

export function createVad (options = {}) {
  const frameMs = positive(options.frameMs, 20)
  let hangoverMs = nonNegative(options.hangoverMs, 700)
  const minSegmentMs = nonNegative(options.minSegmentMs, 400)
  const maxSegmentMs = positive(options.maxSegmentMs, 15000)
  const noiseFloorAdapt = Number.isFinite(options.noiseFloorAdapt) &&
    options.noiseFloorAdapt >= 0 && options.noiseFloorAdapt < 1
    ? options.noiseFloorAdapt
    : 0.995
  const onset = Number.isFinite(options.onsetFrames)
    ? Math.max(1, Math.floor(options.onsetFrames))
    : 3

  /* How long a run of "speech" has to get before the noise floor starts
     learning from it anyway. Music playing in the room reads as speech
     forever, and a floor that only adapts while idle would sit at whatever the
     room was when the track started — so every max-length flush hands the
     recogniser another chunk of the song. Well past any real sentence, so
     ordinary talking never drags the floor up under itself. */
  const relearnMs = positive(options.relearnMs, 20000)

  let level = nonNegative(options.threshold, 0.02)
  let noiseFloor = 0

  let state = 'idle'
  let frame = 0            // index of the next frame push() will consume
  let runFrames = 0        // consecutive speech frames seen while idle
  let runStart = 0         // frame the current idle speech run began on
  let segStart = 0         // first frame of the open segment
  let lastSpeech = 0       // last frame in the open segment that was speech
  let hangFrames = 0
  let loudSince = null     // frame the current unbroken loud run began on

  const speechThreshold = () => Math.max(level, noiseFloor * SPEECH_FLOOR_RATIO)

  const clearCounters = () => {
    state = 'idle'
    frame = 0
    runFrames = 0
    runStart = 0
    segStart = 0
    lastSpeech = 0
    hangFrames = 0
    loudSince = null
  }

  const endEvent = (at, reason) => {
    // The hangover tail is silence, so the segment is measured to its last
    // speech frame, not to the frame that closed it.
    const durationMs = (lastSpeech - segStart + 1) * frameMs
    return {
      type: 'end',
      atFrame: at,
      startFrame: segStart,
      durationMs,
      reason: reason === 'max' || durationMs >= minSegmentMs ? reason : 'discarded'
    }
  }

  function push (rms) {
    const f = frame++
    const value = Number.isFinite(rms) ? Math.max(0, rms) : 0
    const isSpeech = value > speechThreshold()

    if (!isSpeech) loudSince = null
    else if (loudSince === null) loudSince = f

    /* Nothing has been quiet for a long time. Whatever is above the threshold
       is not a sentence — nobody talks for twenty seconds without a gap the
       hangover would catch — so it is the room, and the floor learns it. Once
       the floor is up past the music the state machine falls back to idle on
       its own and the ordinary rule takes over again. */
    const droning = loudSince !== null && (f - loudSince + 1) * frameMs >= relearnMs
    if (droning) noiseFloor = noiseFloor * noiseFloorAdapt + value * (1 - noiseFloorAdapt)

    if (state === 'idle') {
      if (!isSpeech) {
        // EMA toward the observed level; only ever while genuinely idle, so
        // speech (including the frames of an onset run) cannot pull it up.
        noiseFloor = noiseFloor * noiseFloorAdapt + value * (1 - noiseFloorAdapt)
        runFrames = 0
        return null
      }
      if (runFrames === 0) runStart = f
      runFrames += 1
      if (runFrames < onset) return null
      state = 'speech'
      segStart = runStart
      lastSpeech = f
      runFrames = 0
      hangFrames = 0
      // atFrame is the true onset so the caller can slice the ring buffer
      // without clipping the first syllable.
      return { type: 'start', atFrame: segStart, startFrame: segStart }
    }

    if (state === 'hangover' && isSpeech) state = 'speech'

    if (state === 'speech') {
      if (!isSpeech) {
        state = 'hangover'
        hangFrames = 1
        return hangFrames * frameMs >= hangoverMs ? close(f, 'silence') : null
      }
      lastSpeech = f
      hangFrames = 0
      if ((f - segStart + 1) * frameMs < maxSegmentMs) return null
      const ev = endEvent(f, 'max')
      segStart = f
      lastSpeech = f
      return ev
    }

    // hangover, still silent
    hangFrames += 1
    if (hangFrames * frameMs >= hangoverMs) return close(f, 'silence')
    // The cap bounds the whole open segment, silent tail included, so a caller
    // sizing a buffer at maxSegmentMs can never be overrun by the hangover.
    if ((f - segStart + 1) * frameMs >= maxSegmentMs) return close(f, 'max')
    return null
  }

  function close (f, reason) {
    const ev = endEvent(f, reason)
    state = 'idle'
    runFrames = 0
    hangFrames = 0
    return ev
  }

  return {
    push,
    reset: clearCounters,
    setThreshold (t) {
      if (Number.isFinite(t)) level = Math.max(0, t)
    },
    /* Both of these are live-tunable because the settings panel changes them
       while the microphone is open; a bad value is ignored rather than
       allowed to wedge detection, same as at construction. */
    setHangoverMs (ms) {
      if (Number.isFinite(ms) && ms >= 0) hangoverMs = ms
    },
    /** Frames since the level last dropped below the speech threshold. */
    get loudMs () { return loudSince === null ? 0 : (frame - loudSince) * frameMs },
    get state () { return state },
    get threshold () { return level },
    get hangoverMs () { return hangoverMs },
    get noiseFloor () { return noiseFloor },
    get frame () { return frame }
  }
}

export default createVad
