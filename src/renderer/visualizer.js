import { createBandModel, computeBandPoints } from './band.js'

/**
 * Draws the band model as a glowing horizontal ribbon.
 *
 * Ported from a radial visualizer: three hue families at 0/0.33/0.66 offsets
 * over a slowly drifting base hue, each line's phase random-walking so the
 * ribbon reads as "electric" rather than as a clean sine. Additive blending
 * produces the bloom where lines overlap, and a thin white line rides on top as
 * the hot core. The band is drawn to an offscreen canvas and blitted twice —
 * once blurred, once crisp — so the glow costs one blur per frame rather than
 * one per stroke.
 */
export function createVisualizer (canvas, {
  analyser,
  hueBase = 0.38,
  linesPerFamily = 18,
  points = 220,
  fps = 30,
  quietFps = 8,
  centerRatio = 0.58,
  /* Tuned for the full-width ribbon, which is a hundred pixels tall. A small
     one needs both of these scaled down or every line clips against the top
     and bottom of its box and the whole thing fills in solid. */
  gain = 96,
  idleAmp = 1.4,
  /* How far the three hue families sit from the base. Wide enough on the big
     ribbon to travel green → cyan → blue; a small one wants them close
     together so it reads as one colour rather than as a tiny rainbow. */
  hueSpread = [0, 0.09, 0.2]
} = {}) {
  const ctx = canvas.getContext('2d', { alpha: true })
  const model = createBandModel({
    families: 3,
    linesPerFamily,
    points,
    // biased green -> cyan -> blue rather than the full spectrum
    hueOffsets: hueSpread.map(d => hueBase + d),
    gain,
    idleAmp,
    levelGain: 4.5,      // the raw FFT mean is far too small to travel
    bandFraction: 0.28,  // speech energy lives in the low bins
    minFreq: 0.7,        // longer, calmer waves than the radial original
    freqSpread: 2.2,
    twistJitter: 0.007,  // less frantic than the original's 0.02
    smoothing: 0.11,
    rng: Math.random
  })

  const fft = new Uint8Array(analyser.frequencyBinCount)
  // The band is drawn once here, then blitted twice — blurred, then crisp.
  const off = document.createElement('canvas')
  const octx = off.getContext('2d', { alpha: true })

  let dpr = 1
  let box = { width: 0, centerY: 0, height: 0 }
  let raf = null
  let last = 0
  let lastDraw = 0
  let hidden = false
  let active = false

  function resize () {
    // A soft glow does not need retina precision; 1.5 is indistinguishable
    // here and costs ~30% fewer pixels than 2.
    dpr = Math.min(window.devicePixelRatio || 1, 1.5)
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    off.width = canvas.width
    off.height = canvas.height
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    octx.setTransform(dpr, 0, 0, dpr, 0, 0)
    // Where the ribbon rides in its canvas. Low in a boxed window; high in the
    // overlay strip, so it hangs off the top edge of the screen.
    box = { width: w, centerY: h * centerRatio, height: h * 0.92 }
  }

  /* Midpoint quadratic smoothing: each sample becomes a control point and the
     curve passes through the midpoints between them, so the ribbon reads as a
     flowing line rather than as a 220-segment polyline. */
  /* No shadowBlur. Measured on an M-series Mac it was 75% of the GPU cost of
     the whole app — 49% -> 12% with it off — because it rasterises a blur per
     stroke, and there are 55 strokes a frame. The glow now comes from one blur
     of the finished layer instead. */
  function stroke (pts, color, width, alpha) {
    const c = octx
    c.beginPath()
    c.moveTo(pts[0], pts[1])
    for (let i = 2; i < pts.length - 2; i += 2) {
      const mx = (pts[i] + pts[i + 2]) / 2
      const my = (pts[i + 1] + pts[i + 3]) / 2
      c.quadraticCurveTo(pts[i], pts[i + 1], mx, my)
    }
    c.lineTo(pts[pts.length - 2], pts[pts.length - 1])
    c.globalAlpha = alpha
    c.strokeStyle = color
    c.lineWidth = width
    c.stroke()
  }

  /* Frame budget. 30fps is indistinguishable for a flowing ribbon and halves
     every downstream cost; a quiet room drops to 8fps, and a hidden window
     stops entirely. */
  const ACTIVE_MS = 1000 / Math.max(1, fps)
  const QUIET_MS = 1000 / Math.max(1, quietFps)

  function frame (now) {
    raf = requestAnimationFrame(frame)
    if (hidden) return

    /* Whether the room is quiet comes from the VAD, not from model.level:
       levelGain multiplies ambient noise well past any threshold here, so a
       level-based test never idled and a silent room still painted at 30fps. */
    if (now - lastDraw < (active ? ACTIVE_MS : QUIET_MS)) return

    const dt = last ? Math.min((now - last) / 1000, 0.1) : 0.016
    last = now
    lastDraw = now

    analyser.getByteFrequencyData(fft)
    model.update(fft, dt)

    const w = canvas.clientWidth
    const h = canvas.clientHeight

    octx.clearRect(0, 0, w, h)
    octx.globalCompositeOperation = 'lighter'
    octx.lineCap = 'round'
    octx.lineJoin = 'round'

    for (let i = 0; i < model.lines.length; i++) {
      const line = model.lines[i]
      const pts = computeBandPoints(model, i, fft, box)
      const light = 52 + line.familyIndex * 6
      const color = `hsl(${line.hue * 360} 100% ${light}%)`
      // lineIndex is global across families; fold it back into 0..1 per family
      const within = (i % model.linesPerFamily) / model.linesPerFamily
      const near = 1 - Math.abs(within - 0.5) * 2
      stroke(pts, color, 1.1, 0.16 + near * 0.3)
    }

    // hot core
    const core = computeBandPoints(
      { ...model, idleAmp: idleAmp * 0.5, gain: gain * 0.44 }, 0, fft, box)
    stroke(core, 'hsl(160 60% 96%)', 1.3, 0.75 + model.level * 0.25)

    octx.globalAlpha = 1
    octx.globalCompositeOperation = 'source-over'

    // One blur of the finished layer, then the crisp band over it.
    ctx.clearRect(0, 0, w, h)
    ctx.globalCompositeOperation = 'lighter'
    ctx.filter = 'blur(6px)'
    ctx.globalAlpha = 0.85
    ctx.drawImage(off, 0, 0, w, h)
    ctx.filter = 'none'
    ctx.globalAlpha = 1
    ctx.drawImage(off, 0, 0, w, h)
    ctx.globalCompositeOperation = 'source-over'
  }

  const ro = new ResizeObserver(resize)
  ro.observe(canvas)
  resize()

  const onVisibility = () => { hidden = document.visibilityState === 'hidden' }
  document.addEventListener('visibilitychange', onVisibility)
  onVisibility()

  return {
    model,
    setHidden (v) { hidden = !!v },
    /** @param {boolean} v is the VAD currently hearing speech */
    setActive (v) { active = !!v },
    start () { if (!raf) raf = requestAnimationFrame(frame) },
    stop () { if (raf) { cancelAnimationFrame(raf); raf = null } },
    destroy () {
      this.stop()
      ro.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }
}
