import { createOrbViz } from './orb-viz.js'

/**
 * The orb window's whole renderer.
 *
 * A dumb one on purpose. It owns no state anyone else needs, has no
 * microphone, no VAD, and no idea whether the app is listening — the strip's
 * renderer knows all of that and is the single source of truth for it, and
 * what arrives here is about seven numbers a frame. So this window can be
 * created and destroyed at will, and if it never opens, nothing else notices.
 */
const canvas = document.getElementById('orb')

let viz = null

function build (settings) {
  if (viz) viz.destroy()
  viz = createOrbViz(canvas, {
    seeds: settings.orbSeeds,
    steps: settings.orbSteps,
    fps: settings.vizFps,
    quietFps: settings.vizQuietFps,
    zoomGain: settings.orbZoomGain,
    zoomDecay: settings.orbZoomDecay,
    sayScale: settings.orbSayScale
  })
  viz.start()
}

window.transvibe.getSettings().then(build).catch(err => {
  console.warn('[transvibe] orb settings failed:', err.message)
  build({})
})

/* The same hand-hold the strip's renderer leaves on `window.__transvibe`:
   somewhere to reach in from the debugger and drive the orb with a signal no
   microphone is going to produce on demand — a loud room, command mode, the
   app mid-sentence — so the look can be checked without performing it. */
window.__orb = { setSignal: s => viz && viz.setSignal(s), get viz () { return viz } }

/* Lossy by design: whatever the last message said is what gets drawn, and a
   dropped one costs a frame of animation and nothing else. */
window.transvibe.onOrbSignal(signal => {
  if (viz) viz.setSignal(signal)
})

/* A settings change rebuilds rather than retunes. The seed count and the step
   count are baked into the model when it is made, and this happens when
   somebody is dragging a slider — a handful of times, while watching. */
window.transvibe.onOrbSettings(settings => build(settings || {}))
