import { createOrbViz } from './orb-viz.js'
import { createVisualizer } from './visualizer.js'

/**
 * A small, living picture of whichever visualizer is configured, for the
 * settings panel to put above the dials that shape it.
 *
 * Seven of those dials — filament count, filament length, the inner ring, how
 * far sound opens the figure, how fast it closes again — are shapes, and the
 * only way to tune a shape was to drag, close the panel, say something loud
 * enough to move it, and open the panel again. That is not a loop anybody runs
 * twice, which is why those settings were effectively write-once.
 *
 * The room it is fed is invented. It has to be: the panel is open, which means
 * you are looking at a screen rather than talking, and a preview that only
 * moves when you speak is a preview of silence. A slow swell with a little
 * noise on it covers the range the real signal travels, so a figure that looks
 * right here looks right in the room.
 */

/** A minute of made-up speech, in the shape the real analysis arrives in. */
function roomSignal (t) {
  /* Two swells at different rates, so it never settles into a rhythm you
     start reading as the setting rather than as the room. */
  const swell = (Math.sin(t * 0.7) * 0.5 + 0.5) * (Math.sin(t * 0.23) * 0.3 + 0.7)
  const grain = (Math.sin(t * 11.3) + Math.sin(t * 17.7)) * 0.04
  const level = Math.max(0, Math.min(1, swell * 0.75 + grain))
  return {
    level,
    // Speech is bottom-heavy, and the figure reads differently if it is not.
    bass: level * 0.9,
    mid: level * 0.7,
    treble: level * 0.35,
    active: level > 0.08
  }
}

/**
 * The ribbon reads a real FFT off a real analyser node. There is no microphone
 * behind a settings panel, so it gets an object shaped like one — the same two
 * members it actually touches — filled with a plausible spectrum.
 */
function fakeAnalyser (clock) {
  const bins = 256
  return {
    frequencyBinCount: bins,
    getByteFrequencyData (out) {
      const t = clock()
      const { level } = roomSignal(t)
      for (let i = 0; i < out.length; i++) {
        // Loudest at the bottom, falling away, with the swell on top of it.
        const fall = Math.exp(-i / (bins * 0.18))
        const wobble = 0.8 + 0.2 * Math.sin(t * 3 + i * 0.35)
        out[i] = Math.max(0, Math.min(255, Math.round(255 * level * fall * wobble)))
      }
    }
  }
}

/** Which settings, changed, mean the picture has to be built again. */
const SHAPES = [
  'layout', 'vizFps', 'vizQuietFps',
  'bandLines', 'bandPoints',
  'orbSeeds', 'orbSteps', 'orbSayScale', 'orbZoomGain', 'orbZoomDecay'
]

/**
 * @param {HTMLElement} host where the canvas goes
 * @param {() => object} getSettings the settings as they stand right now
 * @returns {{update: (s: object) => void, start: () => void, stop: () => void}}
 */
export function createVizPreview (host, getSettings) {
  const canvas = document.createElement('canvas')
  canvas.className = 'viz-preview-canvas'
  host.append(canvas)

  const caption = document.createElement('p')
  caption.className = 'set-help'
  caption.textContent = 'A made-up room, so the shape can be tuned without talking to it.'
  host.append(caption)

  const started = performance.now()
  const clock = () => (performance.now() - started) / 1000

  let viz = null
  let feed = null
  let running = false
  let shape = null

  const shapeOf = settings => SHAPES.map(k => settings[k]).join('|')

  function destroy () {
    if (feed) { clearInterval(feed); feed = null }
    if (viz) { viz.destroy(); viz = null }
  }

  function build (settings) {
    destroy()
    shape = shapeOf(settings)

    if (settings.layout === 'orb') {
      viz = createOrbViz(canvas, {
        seeds: settings.orbSeeds,
        steps: settings.orbSteps,
        fps: settings.vizFps,
        quietFps: settings.vizQuietFps,
        zoomGain: settings.orbZoomGain,
        zoomDecay: settings.orbZoomDecay,
        sayScale: settings.orbSayScale,
        /* The real orb is its own window, hundreds of pixels across. At this
           size the blur is most of what you would see, and the figure has to
           sit further inside its box or it draws over the edge. */
        blur: 3,
        initialSize: 0.34
      })
      /* The orb is pushed rather than polled: it wants a signal object, the
         way the strip sends it one. Twenty a second is well under any frame
         rate the dial offers and is not what the preview costs. */
      feed = setInterval(() => viz && viz.setSignal(roomSignal(clock())), 50)
    } else {
      viz = createVisualizer(canvas, {
        analyser: fakeAnalyser(clock),
        linesPerFamily: settings.bandLines,
        points: settings.bandPoints,
        fps: settings.vizFps,
        quietFps: settings.vizQuietFps,
        // The ribbon's own numbers are for a strip a hundred pixels tall and
        // the full width of the screen. Scaled down, or every line clips.
        gain: 34,
        idleAmp: 0.6,
        hueSpread: [0, 0.05, 0.11]
      })
      feed = setInterval(() => viz && viz.setActive(roomSignal(clock()).active), 100)
    }

    if (running) viz.start()
  }

  return {
    update (settings) {
      if (!settings) return
      // Most saves are nothing to do with the picture. Rebuilding on all of
      // them would restart the animation every time a checkbox moved.
      if (!viz || shapeOf(settings) !== shape) build(settings)
    },
    start () {
      running = true
      if (!viz) build(getSettings())
      viz.start()
    },
    stop () {
      running = false
      if (viz) viz.stop()
    }
  }
}
