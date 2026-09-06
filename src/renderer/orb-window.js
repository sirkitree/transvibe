import { createOrbViz } from './orb-viz.js'

/**
 * The orb window's whole renderer.
 *
 * A dumb one on purpose. It owns no state anyone else needs and no state it
 * is the authority on: no microphone, no VAD, and whether the app is
 * listening arrives from the main process rather than being decided here. So
 * this window can be created and destroyed at will, and if it never opens,
 * nothing else notices. What crosses to it is about seven numbers a frame,
 * plus two flags: is the pointer on it, and is the microphone on.
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

/* ------------------------------------------------------------- the controls

   Two buttons, in the hole in the middle of the mandala, shown while the
   pointer is on the orb. The orb has no transcript and no panels, so this is
   the whole of what you can do to it: stop it listening, or get it off the
   screen. Everything else is on the strip, which is still there.

   The window is a ghost to the mouse *except* while the pointer is actually on
   one of these two — the main process is told, and only then does it let
   clicks land. So hovering past the orb never costs you a click on whatever is
   behind it, which was the point of a click-through HUD. */

const controls = document.getElementById('controls')
const muteButton = document.getElementById('mute')
const muteSlash = document.getElementById('mute-slash')
const hideButton = document.getElementById('hide')

let listening = true

function drawListening () {
  // The button shows what is true, and says what pressing it would do.
  muteButton.classList.toggle('on', !listening)
  muteSlash.style.display = listening ? 'none' : ''
  const label = listening ? 'Stop listening' : 'Start listening'
  muteButton.title = label
  muteButton.setAttribute('aria-label', label)
}

window.transvibe.onListening(value => { listening = !!value; drawListening() })
drawListening()

muteButton.onclick = () => {
  listening = !listening
  drawListening()
  window.transvibe.setListening(listening)
}

// The same thing ⌃⌥Space does, and the same thing it undoes: the app is still
// listening and still there, it is just not on the screen.
hideButton.onclick = () => window.transvibe.hide()

/* Whether the pointer is on a button, which is a different question from
   whether it is on the orb. Reported on move rather than on enter/leave: a
   click-through window is told about movement *over* it but never sees the
   pointer leave, so `mouseleave` would never fire and the orb would stay
   clickable forever. */
let onTarget = false
const reportTarget = value => {
  if (value === onTarget) return
  onTarget = value
  window.transvibe.setOrbTarget(value)
}

document.addEventListener('mousemove', e => {
  reportTarget(!!(e.target.closest && e.target.closest('#controls button')))
})

window.transvibe.onOrbHover(value => {
  document.body.classList.toggle('hover', !!value)
  // Off the orb entirely: the controls go, and so does any claim on the mouse.
  // The main process has already dropped it, but saying so keeps the two sides
  // from disagreeing when the pointer left faster than a mousemove.
  if (!value) reportTarget(false)
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
