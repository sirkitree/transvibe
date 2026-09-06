// Pure math for the orb visualizer. No DOM, no canvas, no Electron.
// A renderer module turns the filaments computed here into strokes.
//
// Ported from a p5.js sketch rather than embedded: p5 is not on this machine
// and the CSP is `script-src 'self'`, so everything the sketch leaned on —
// including `noise()` — had to become ours. Being ours is what makes the walk
// testable: seeded, pure, and the same picture on every launch.
//
// The figure is a ring of seeds with a short flow-field walk trailing off
// each one, drawn twice under a point reflection through the centre. That
// mirror is the whole reason it reads as a mandala instead of as a spiral,
// and it is also why the seed ring only sweeps half a turn: the reflection
// draws the other half.

const TAU = Math.PI * 2

const num = (v, fallback = 0) => (Number.isFinite(v) ? v : fallback)

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)

/* Symmetric about 0.5, which is what keeps the mirror exact: clamping a point
   and clamping its reflection give reflections of each other. */
const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v)

// Keeps a value inside [0, 1) for any finite input, negatives included.
const wrap01 = v => {
  if (!Number.isFinite(v)) return 0
  const w = v % 1
  return w < 0 ? w + 1 : w
}

/**
 * Seeded value noise, standing in for p5's `noise()`.
 *
 * Three dimensions because the walk uses the third as time: the same point in
 * space turns a little differently each frame, which is what makes the
 * filaments drift rather than sit still. Value noise rather than Perlin —
 * smooth enough at the scale the walk samples it, and a third the code.
 *
 * @param {number} [seed]
 * @returns {(x:number, y:number, z?:number) => number} in [0, 1)
 */
export function createNoise (seed = 1) {
  const s = Math.floor(Math.abs(num(seed, 1))) % 2147483647 || 1

  // One deterministic value per lattice corner. The mixing is arbitrary; what
  // matters is that it is stable and looks unrelated between neighbours.
  const at = (x, y, z) => {
    let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x85ebca6b) ^
            Math.imul(z | 0, 0xc2b2ae35) ^ s
    h = Math.imul(h ^ (h >>> 15), h | 1)
    h ^= h + Math.imul(h ^ (h >>> 7), h | 61)
    return ((h ^ (h >>> 14)) >>> 0) / 4294967296
  }

  const fade = t => t * t * (3 - 2 * t)
  const mix = (a, b, t) => a + (b - a) * t

  return (x, y, z = 0) => {
    const px = num(x, 0)
    const py = num(y, 0)
    const pz = num(z, 0)
    const xi = Math.floor(px)
    const yi = Math.floor(py)
    const zi = Math.floor(pz)
    const tx = fade(px - xi)
    const ty = fade(py - yi)
    const tz = fade(pz - zi)

    const c00 = mix(at(xi, yi, zi), at(xi + 1, yi, zi), tx)
    const c10 = mix(at(xi, yi + 1, zi), at(xi + 1, yi + 1, zi), tx)
    const c01 = mix(at(xi, yi, zi + 1), at(xi + 1, yi, zi + 1), tx)
    const c11 = mix(at(xi, yi + 1, zi + 1), at(xi + 1, yi + 1, zi + 1), tx)

    return mix(mix(c00, c10, ty), mix(c01, c11, ty), tz)
  }
}

/**
 * The orb's state: where the seed ring is pointing, what colour it is, and how
 * far the room has pushed it open.
 *
 * `rotationSpeed` is signed on purpose. The inner orb — the app's own voice —
 * is this same model with a negative one and a smaller radius, so the two turn
 * against each other and there is no second generator to keep in step.
 */
export function createOrbModel (options) {
  const {
    seeds = 120,
    steps = 14,
    radius = 0.25,
    rotationSpeed = 1,
    /* How fast the walk's turn field varies across unit space, and the number
       the look turns on. Neighbouring seeds are about a hundredth of unit
       space apart, so a small scale gives them near-identical fields and the
       ring combs into solid sheets instead of filaments; past about 30 they
       stop agreeing at all and the ring tangles into a knot. Measured on
       screen at 120 seeds, 22 is where they read as strands. */
    noiseScale = 22,
    plotMult = 2,
    plotDiv = 0.02,
    hueBase = 0.5,
    hueDrift = 0.0006,
    // How far round the ring the hue travels, and the offset the mirrored half
    // is drawn at. 0.25 is the reference's 90 degrees.
    hueSpread = 0.16,
    divHue = 0.12,
    // How much the bass warms the whole figure. Small: this and the two above
    // add up, and together they are how much of the colour wheel the orb
    // covers at once — 0.38 of it as they stand. Past about two fifths the
    // mandala stops reading as one object in one colour and starts reading as
    // a rainbow.
    hueBass = 0.1,
    zoomGain = 3,
    zoomDecay = 0.05,
    zoomAttack = 0.2,
    zoomThreshold = 0.02,
    smoothing = 0.12,
    noise = createNoise(1)
  } = options && typeof options === 'object' ? options : {}

  const seedCount = Math.max(1, Math.floor(num(seeds, 120)))
  const stepCount = Math.max(2, Math.floor(num(steps, 14)))
  const ringRadius = clamp(num(radius, 0.25), 0.01, 0.5)
  const spin = num(rotationSpeed, 1)
  const nScale = Math.max(0, num(noiseScale, 22))
  const mult = num(plotMult, 2)
  const div = num(plotDiv, 0.02)
  const drift = num(hueDrift, 0.0006)
  const spread = num(hueSpread, 0.16)
  const mirrorHue = num(divHue, 0.12)
  const bassHue = num(hueBass, 0.1)
  const gain = Math.max(0, num(zoomGain, 3))
  const decay = clamp(num(zoomDecay, 0.05), 0, 1)
  const attack = clamp(num(zoomAttack, 0.2), 0, 1)
  const threshold = clamp(num(zoomThreshold, 0.02), 0, 1)
  const follow = clamp(num(smoothing, 0.12), 0, 1)
  const field = typeof noise === 'function' ? noise : createNoise(1)

  /* The reference re-rolls these on every load, so it is a different sketch
     each time. Here they are fixed: this is one app's face, and it should be
     the same face tomorrow. Only the hue drifts. */
  const xBase = 0.31
  const yBase = 0.67

  const model = {
    seeds: seedCount,
    steps: stepCount,
    radius: ringRadius,
    rotationSpeed: spin,
    noiseScale: nScale,
    plotMult: mult,
    plotDiv: div,
    hueSpread: spread,
    divHue: mirrorHue,
    xBase,
    yBase,
    noise: field,

    frame: 0,
    baseHue: wrap01(num(hueBase, 0.5)),
    zoom: 1,
    level: 0,
    bass: 0,
    mid: 0,
    treble: 0,

    /**
     * @param {{bass?:number, mid?:number, treble?:number, level?:number}} signal
     * @param {number} [dt] seconds since the last frame
     */
    update (signal, dt = 1 / 30) {
      // dt paces the drift and the spin; the envelopes advance once per frame,
      // the way the reference's did against its own frameCount.
      const step = clamp(num(dt, 1 / 30) * 30, 0, 4) || 1
      const s = signal && typeof signal === 'object' ? signal : {}

      model.frame += step
      model.baseHue = wrap01(model.baseHue + drift * spin * step)

      model.bass = clamp(num(s.bass, 0), 0, 1)
      model.mid = clamp(num(s.mid, 0), 0, 1)
      model.treble = clamp(num(s.treble, 0), 0, 1)

      const level = clamp(num(s.level, 0), 0, 1)
      model.level = model.level + (level - model.level) * follow

      /* The headline of the reference and the reason it is worth porting: the
         whole figure breathes outward when the room does. Quiet is a decay
         back to exactly 1 rather than a lerp toward it, so an orb nobody is
         talking to settles instead of hovering a fraction open forever. */
      if (level > threshold) {
        const target = clamp(1 + (level - threshold) * gain, 1, 1 + gain)
        model.zoom += (target - model.zoom) * attack
      } else {
        model.zoom -= (model.zoom - 1) * decay * step
        if (model.zoom < 1 + 1e-4) model.zoom = 1
      }
      model.zoom = clamp(num(model.zoom, 1), 1, 1 + gain)

      return model
    },

    reset () {
      model.frame = 0
      model.baseHue = wrap01(num(hueBase, 0.5))
      model.zoom = 1
      model.level = 0
      model.bass = 0
      model.mid = 0
      model.treble = 0
      return model
    },

    /* Where the ring is pointing this frame. The reference wrapped its frame
       counter at 144 before dividing; the wrap is what keeps this a fraction
       of a turn rather than a number that grows without bound. */
    get spinRatio () { return wrap01((model.frame * spin % 144) / 144) },

    /** Unit-space centre of the seed at `index`, before the walk. */
    seedAt (index) {
      const ratio = seedRatio(index)
      // Half a turn only: the mirror draws the other half.
      const angle = ratio * Math.PI + model.spinRatio * TAU
      return {
        x: 0.5 + Math.cos(angle) * ringRadius,
        y: 0.5 + Math.sin(angle) * ringRadius
      }
    },

    /**
     * How many points this filament gets.
     *
     * Length varies around the ring and travels with the spin, so the figure
     * has long strands somewhere and short ones elsewhere and the long place
     * moves. A ring of equal-length filaments reads as a gear.
     */
    stepsAt (index) {
      const ratio = seedRatio(index)
      const wave = Math.sin((Math.PI * (ratio + model.spinRatio)) % Math.PI)
      return 2 + Math.floor((stepCount - 2) * Math.abs(wave))
    },

    /** Where this filament sits in the hue range, in [0, 1). */
    hueAt (index) {
      return wrap01(model.baseHue + seedRatio(index) * spread + model.bass * bassHue)
    }
  }

  const seedRatio = index => {
    const i = Math.floor(num(index, 0))
    return seedCount > 1 ? clamp(i, 0, seedCount - 1) / (seedCount - 1) : 0
  }

  return model
}

/**
 * One filament: the seed, then a short walk through the turn field.
 *
 * Returned in unit space rather than canvas pixels, because unit space is
 * where the mirror is a subtraction and where a test can say what it expects
 * without knowing how big the window is. `out` is an optional scratch buffer;
 * the result is a view into it, so a frame of 240 filaments allocates nothing.
 *
 * @param {object} model
 * @param {number} index
 * @param {Float32Array} [out]
 * @returns {Float32Array} x, y pairs
 */
export function computeFilament (model, index, out) {
  if (!model || typeof model.seedAt !== 'function') return new Float32Array(0)

  const n = Math.max(2, model.stepsAt(index))
  const need = n * 2
  const buf = out && out.length >= need ? out.subarray(0, need) : new Float32Array(need)

  const seed = model.seedAt(index)
  let x = seed.x
  let y = seed.y

  // Constant for the whole filament: the seed's distance from a fixed point,
  // which is what gives one side of the ring a different character to the other.
  const dx = num(model.xBase, 0.31) - seed.x
  const dy = num(model.yBase, 0.67) - seed.y
  const anchor = Math.sin(Math.sqrt(dx * dx + dy * dy))

  const frame = num(model.frame, 0)
  const spin = num(model.rotationSpeed, 1)
  const scale = num(model.noiseScale, 22)
  const mult = num(model.plotMult, 2)
  const div = num(model.plotDiv, 0.02)

  buf[0] = clamp01(x)
  buf[1] = clamp01(y)

  for (let i = 1; i < n; i++) {
    const turn = (
      Math.sin(x + y + frame * 0.01 * spin) +
      anchor +
      model.noise(x * scale, y * scale, frame * 0.005 * spin) * 4
    ) * mult
    x += Math.cos(turn) * div
    y += Math.sin(turn) * div
    if (!Number.isFinite(x)) x = seed.x
    if (!Number.isFinite(y)) y = seed.y
    buf[i * 2] = clamp01(x)
    buf[i * 2 + 1] = clamp01(y)
  }

  return buf
}

/**
 * The other half of the figure: a point reflection through the centre.
 *
 * The single most important line in the port. Without it this is a spiral;
 * with it, it is a mandala.
 */
export function mirrorPoints (pts, out) {
  const src = pts && pts.length ? pts : new Float32Array(0)
  const buf = out && out.length >= src.length ? out.subarray(0, src.length) : new Float32Array(src.length)
  for (let i = 0; i < src.length; i++) buf[i] = 1 - src[i]
  return buf
}

/**
 * Unit space to canvas pixels, scaled by the zoom the room is driving.
 *
 * @param {Float32Array} pts
 * @param {{cx:number, cy:number, size:number}} rect
 */
export function placePoints (pts, rect, out) {
  const src = pts && pts.length ? pts : new Float32Array(0)
  const buf = out && out.length >= src.length ? out.subarray(0, src.length) : new Float32Array(src.length)
  const box = rect && typeof rect === 'object' ? rect : {}
  const cx = num(box.cx, 0)
  const cy = num(box.cy, 0)
  const size = num(box.size, 0)
  for (let i = 0; i < src.length; i += 2) {
    buf[i] = cx + (num(src[i], 0.5) - 0.5) * size
    buf[i + 1] = cy + (num(src[i + 1], 0.5) - 0.5) * size
  }
  return buf
}
