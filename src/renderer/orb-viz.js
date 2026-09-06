import { createOrbModel, createNoise, computeFilament, mirrorPoints, placePoints } from './orb.js'

/**
 * Draws the orb model as a glowing mandala on a transparent window.
 *
 * Two layers on one canvas. The outer one is the room, turning one way. The
 * inner one is the app's own voice, turning the other, drawn only while there
 * is something being said — the orb's answer to the strip's little
 * counter-facing ribbon, in the shape the orb is already in rather than as a
 * second widget beside it.
 *
 * Two things separate this from the p5 sketch it comes from, and both are
 * forced:
 *
 * The reference paints an opaque dark background every frame and leans on
 * SCREEN blending against it. This window is transparent and click-through, so
 * there is no ground to blend with; the bloom comes instead from `lighter`
 * compositing and one blur of the finished layer.
 *
 * And the reference draws ~30,000 dots a frame. Here each filament is a single
 * stroked path — the same midpoint smoothing the ribbon uses — which turns
 * that into a couple of hundred strokes. What is lost is the per-dot hue and
 * size; a gradient along each path buys most of it back, and `gradient: false`
 * is the dial if it ever stops being worth its cost.
 *
 * The one blur is not a preference. `visualizer.js` records `shadowBlur`
 * costing 75% of the whole app's GPU because it rasterises a blur per stroke,
 * and there are more strokes here than there.
 */
export function createOrbViz (canvas, {
  seeds = 120,
  steps = 14,
  fps = 30,
  quietFps = 8,
  hueBase = 0.52,
  /* How much of the canvas the ring fills before the room opens it up. Well
     under half, because the walk trails well outward from the ring and the
     zoom pushes the whole figure further still — the drawn figure comes out
     near twice this across. Sized with the default zoom so that even a loud
     room lands inside the window: a mandala clipped against the edge of its
     own square reads as broken rather than as loud. Turn the zoom up past
     that and it will reach the edge, which is why the setting says so. */
  initialSize = 0.5,
  zoomGain = 3,
  zoomDecay = 0.05,
  /* The inner orb, as a fraction of the outer. Its seed and step counts come
     off the outer's for the same reason: at this radius a full-density walk
     fills in as a solid disc rather than reading as filaments. */
  sayScale = 0.4,
  sayHueBase = 0.02,
  lineWidth = 1.1,
  blur = 7,
  gradient = true,
  noiseSeed = 1
} = {}) {
  const ctx = canvas.getContext('2d', { alpha: true })
  const off = document.createElement('canvas')
  const octx = off.getContext('2d', { alpha: true })

  const field = createNoise(noiseSeed)

  const outer = createOrbModel({
    seeds,
    steps,
    radius: 0.25,
    rotationSpeed: 1,
    hueBase,
    hueSpread: 0.16,
    zoomGain,
    zoomDecay,
    noise: field
  })

  /* The same generator, turned the other way and held in a narrow warm band —
     red through amber — where the outer one drifts across a quarter of the
     wheel. Warmth and direction are what say "this one is the app". */
  const inner = createOrbModel({
    seeds: Math.max(8, Math.round(seeds * 0.35)),
    steps: Math.max(3, Math.round(steps * 0.6)),
    radius: 0.25,          // of its own, smaller box
    rotationSpeed: -1,
    hueBase: sayHueBase,
    /* Held far tighter than the outer orb's. This is a small ring inside a
       large one, and the only thing it has to say is "the app is talking" —
       which it says by being warm and turning the other way. Spread it as
       wide as the outer's and the two stop being distinguishable. */
    hueSpread: 0.05,
    divHue: 0.04,
    hueBass: 0.02,
    hueDrift: 0,           // the app's voice is one colour, not a drifting one
    zoomGain: 0,           // the zoom is the room's; this one pulses instead
    noise: field
  })

  // Reused every frame, so 240 filaments allocate nothing.
  const scratch = new Float32Array(Math.max(outer.steps, inner.steps) * 2)
  const mirrored = new Float32Array(scratch.length)
  const placed = new Float32Array(scratch.length)

  let dpr = 1
  let raf = null
  let last = 0
  let lastDraw = 0
  let hidden = false
  let active = false
  let signal = { bass: 0, mid: 0, treble: 0, level: 0 }
  let command = 0        // eased, so the amber arrives rather than snapping
  let saying = 0         // the inner orb's envelope, 0 when nothing is said
  let sayTarget = 0
  let commandTarget = 0

  function resize () {
    // A soft glow does not need retina precision; the ribbon's finding holds.
    dpr = Math.min(window.devicePixelRatio || 1, 1.5)
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    off.width = canvas.width
    off.height = canvas.height
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    octx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  /* Midpoint quadratic smoothing, as on the ribbon: the samples become control
     points and the curve passes through the midpoints between them. A filament
     can be as short as two points, which is a line and nothing to smooth. */
  function stroke (pts, style, width, alpha) {
    if (pts.length < 4) return
    const c = octx
    c.beginPath()
    c.moveTo(pts[0], pts[1])
    if (pts.length === 4) {
      c.lineTo(pts[2], pts[3])
    } else {
      for (let i = 2; i < pts.length - 2; i += 2) {
        const mx = (pts[i] + pts[i + 2]) / 2
        const my = (pts[i + 1] + pts[i + 3]) / 2
        c.quadraticCurveTo(pts[i], pts[i + 1], mx, my)
      }
      c.lineTo(pts[pts.length - 2], pts[pts.length - 1])
    }
    c.globalAlpha = alpha
    c.strokeStyle = style
    c.lineWidth = width
    c.stroke()
  }

  /* One filament's colour. A gradient from the seed end to the tail is what
     stands in for the reference's per-dot hue: the strand starts hot at the
     ring and cools as it trails off, which is most of what the dots were
     doing. */
  function paint (pts, hue, light, sat) {
    const head = `hsl(${hue * 360} ${sat}% ${light}%)`
    if (!gradient) return head
    const g = octx.createLinearGradient(pts[0], pts[1], pts[pts.length - 2], pts[pts.length - 1])
    g.addColorStop(0, head)
    g.addColorStop(1, `hsl(${(hue + 0.06) % 1 * 360} ${sat}% ${Math.max(18, light - 26)}%)`)
    return g
  }

  /**
   * One layer, both halves of it. Every filament is drawn twice under the
   * point reflection, the second at the mirror hue — that pairing is the
   * whole difference between a mandala and a spiral.
   */
  function drawLayer (model, rect, opacity, lightBias = 0) {
    const { bass, mid, treble } = signal
    const sat = Math.round(78 + mid * 22)
    for (let i = 0; i < model.seeds; i++) {
      const unit = computeFilament(model, i, scratch)
      const pts = placePoints(unit, rect, placed)
      const hue = model.hueAt(i)
      // The reference's pBri: brightness rides the treble, size rides the bass.
      const light = 48 + treble * 22 + (i % 3) * 3 + lightBias
      const width = lineWidth * (1 + bass * 0.9)
      const alpha = opacity * (0.34 + mid * 0.4)
      stroke(pts, paint(pts, hue, light, sat), width, alpha)

      const flip = placePoints(mirrorPoints(unit, mirrored), rect, placed)
      stroke(flip, paint(flip, (hue + model.divHue) % 1, light, sat), width, alpha)
    }
  }

  /* Frame budget, and the reason quietness comes from the VAD rather than from
     the model's own level: `levelGain` upstream multiplies ambient noise past
     any threshold, so a level-based idle test never idles. */
  const ACTIVE_MS = 1000 / Math.max(1, fps)
  const QUIET_MS = 1000 / Math.max(1, quietFps)

  function frame (now) {
    raf = requestAnimationFrame(frame)
    if (hidden) return
    if (now - lastDraw < (active || saying > 0.01 ? ACTIVE_MS : QUIET_MS)) return

    // Same guard as the ribbon's: a hidden or not-yet-laid-out canvas is 0x0,
    // and the blit at the end of this throws on a zero-sized source.
    if (!canvas.clientWidth || !canvas.clientHeight) return

    const dt = last ? Math.min((now - last) / 1000, 0.1) : 0.033
    last = now
    lastDraw = now

    saying += (sayTarget - saying) * 0.12
    if (saying < 0.005) saying = 0
    /* The command wash backs off while the app is talking, so the inner orb
       still separates from it. Two amber things at once is one amber blur. */
    command += ((commandTarget * (1 - saying * 0.7)) - command) * 0.1

    outer.update(signal, dt)
    if (saying > 0) inner.update({ level: saying, mid: saying, bass: signal.bass, treble: signal.treble }, dt)

    const w = canvas.clientWidth
    const h = canvas.clientHeight
    const span = Math.min(w, h)
    const rect = { cx: w / 2, cy: h / 2, size: span * initialSize * outer.zoom }

    octx.clearRect(0, 0, w, h)
    octx.globalCompositeOperation = 'lighter'
    octx.lineCap = 'round'
    octx.lineJoin = 'round'

    /* Command mode: the strip swings amber, so the orb does. A wash rather
       than a recolour — the figure keeps its own hues underneath, the way the
       strip keeps its text. */
    if (command > 0.01) {
      /* Sized off the figure rather than off the window, so it is a halo
         around the mandala and not a lit square. A square window with a
         transparent background shows its corners the moment anything fills
         them. */
      const g = octx.createRadialGradient(rect.cx, rect.cy, 0, rect.cx, rect.cy, rect.size * 0.75)
      g.addColorStop(0, `hsla(38 100% 60% / ${0.3 * command})`)
      g.addColorStop(1, 'hsla(38 100% 60% / 0)')
      octx.globalAlpha = 1
      octx.fillStyle = g
      octx.fillRect(0, 0, w, h)
    }

    drawLayer(outer, rect, 1)
    if (saying > 0) {
      /* Brighter than its share, because it is a third of the seeds at a
         third of the radius drawn inside something already glowing: at the
         outer's own weight it disappears into it. */
      drawLayer(inner, { cx: rect.cx, cy: rect.cy, size: rect.size * sayScale }, saying * 1.5, 14)
    }

    octx.globalAlpha = 1
    octx.globalCompositeOperation = 'source-over'

    // One blur of the finished layer, then the crisp figure over it.
    ctx.clearRect(0, 0, w, h)
    ctx.globalCompositeOperation = 'lighter'
    ctx.filter = `blur(${blur}px)`
    ctx.globalAlpha = 0.9
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
    outer,
    inner,
    /**
     * Everything the strip knows and this window does not, in one lossy
     * message. A dropped one is a dropped frame of animation and nothing more.
     *
     * @param {{bass?, mid?, treble?, level?, active?, command?, hue?, saying?}} s
     */
    setSignal (s) {
      if (!s || typeof s !== 'object') return
      signal = {
        bass: +s.bass || 0,
        mid: +s.mid || 0,
        treble: +s.treble || 0,
        level: +s.level || 0
      }
      active = !!s.active
      commandTarget = s.command ? 1 : 0
      sayTarget = +s.saying || 0
      if (Number.isFinite(s.hue)) outer.baseHue = ((s.hue % 1) + 1) % 1
      if (Number.isFinite(s.sayHue)) inner.baseHue = ((s.sayHue % 1) + 1) % 1
    },
    setHidden (v) { hidden = !!v },
    start () { if (!raf) raf = requestAnimationFrame(frame) },
    stop () { if (raf) { cancelAnimationFrame(raf); raf = null } },
    destroy () {
      this.stop()
      ro.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }
}
