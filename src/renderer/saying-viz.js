import { createVisualizer } from './visualizer.js'
import { sayingSpectrum, sayingLevel } from './saying.js'

/**
 * The app's own voice, drawn as a small ribbon in the middle of the strip.
 *
 * The same renderer as the big one, deliberately: a second visualizer that
 * merely resembled the first would be a second thing to keep in step, and the
 * point is that this reads as the same instrument turned around. So it is
 * `createVisualizer` again, handed an analyser that is arithmetic rather than
 * an ear — the samples it would want are being played to the speakers by
 * `say`, and the microphone is deaf for exactly that window.
 *
 * What separates the two on screen is warmth and size: amber against the
 * ribbon's drifting greens and blues, a fraction of the width, sitting in the
 * clear band below it. One is the room; this one is the app.
 */
export function createSayingViz (canvas, { bins = 96, hueBase = 0.02 } = {}) {
  const fft = new Uint8Array(bins)
  let startedAt = null
  let stoppedAt = null
  let seed = 1
  let base = hueBase
  let viz = null

  /* Everything `createVisualizer` asks of an AnalyserNode, which is not much:
     how many bins there are, and a fill of the current ones. */
  const analyser = {
    frequencyBinCount: bins,
    getByteFrequencyData (target) {
      const now = performance.now()
      const level = sayingLevel(now, { startedAt, stoppedAt })
      if (level <= 0) {
        target.fill(0)
        settle()
        return
      }
      sayingSpectrum(now - startedAt, { bins, level, seed, out: fft })
      target.set(fft)
    }
  }

  const build = () => createVisualizer(canvas, {
    analyser,
    hueBase: base,
    // Fewer lines and far less travel than the big ribbon: at full gain in a
    // box this size every line clips against the edges and the strands fill
    // in as one solid block.
    linesPerFamily: 3,
    points: 72,
    gain: 11,
    idleAmp: 0.5,
    // Held inside a narrow warm band — red through amber — where the big
    // ribbon's families are spread wide enough to cross from green to blue.
    hueSpread: [0, 0.05, 0.1],
    fps: 30,
    quietFps: 30,        // only ever running while there is something to see
    centerRatio: 0.5     // centred in its own box, not hanging off an edge
  })

  viz = build()

  /* Faded out and finished: stop drawing, and wipe the last frame so nothing
     is left painted under a canvas that is about to be shown again. */
  function settle () {
    if (startedAt === null) return
    startedAt = null
    stoppedAt = null
    viz.stop()
    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    canvas.classList.remove('on')
  }

  return {
    /**
     * Whose voice this is about to be.
     *
     * Rebuilt rather than retuned: the hue is baked into every line when the
     * band model is made, and this happens only when the agent being addressed
     * changes — a handful of times an hour, on a canvas the size of a word.
     */
    setHue (value) {
      if (!Number.isFinite(value) || value === base) return
      base = value
      viz.destroy()
      viz = build()
    },

    /** The app has started talking. */
    start () {
      // A new sentence re-seeds the phases, so two replies in a row do not
      // draw the same picture.
      seed = 1 + Math.random() * 8
      stoppedAt = null
      startedAt = performance.now()
      canvas.classList.add('on')
      viz.setActive(true)
      viz.start()
    },
    /** It has finished; the ribbon settles rather than vanishing. */
    stop () {
      if (startedAt === null || stoppedAt !== null) return
      stoppedAt = performance.now()
    },
    get speaking () { return startedAt !== null && stoppedAt === null },
    destroy () {
      viz.destroy()
      startedAt = null
      stoppedAt = null
    }
  }
}
