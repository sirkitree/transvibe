// Pure math for the electric visualizer band. No DOM, no canvas, no Electron.
// A renderer module turns the points computed here into strokes.

const TAU = Math.PI * 2

const num = (v, fallback = 0) => (Number.isFinite(v) ? v : fallback)

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)

// Keeps a value inside [0, 1) for any finite input, negatives included.
const wrap01 = v => {
  if (!Number.isFinite(v)) return 0
  const w = v % 1
  return w < 0 ? w + 1 : w
}

const binAt = (fft, index, points, fraction = 1) => {
  const len = fft && fft.length ? fft.length : 0
  if (len === 0) return 0
  const span = points > 1 ? points - 1 : 1
  // Most of a 2048-bin FFT is near-silent high frequencies; mapping only the
  // lower `fraction` of it across x keeps the whole band alive during speech.
  const top = Math.max(1, Math.floor((len - 1) * clamp(num(fraction, 1), 0.01, 1)))
  const i = clamp(Math.floor((index / span) * top), 0, len - 1)
  const raw = fft[i]
  if (!Number.isFinite(raw)) return 0
  return clamp(raw, 0, 255) / 255
}

export function createBandModel (options) {
  const {
    families = 3,
    linesPerFamily = 18,
    points = 256,
    hueOffsets = [0, 0.33, 0.66],
    hueDrift = 0.001,
    twistJitter = 0.02,
    idleAmp = 1.5,
    gain = 46,
    smoothing = 0.08,
    levelGain = 1,
    bandFraction = 1,
    minFreq = 1.5,
    freqSpread = 4,
    rng = () => 0.5
  } = options && typeof options === 'object' ? options : {}
  const familyCount = Math.max(1, Math.floor(num(families, 3)))
  const perFamily = Math.max(1, Math.floor(num(linesPerFamily, 18)))
  const pointCount = Math.max(2, Math.floor(num(points, 256)))
  const offsets = Array.isArray(hueOffsets) && hueOffsets.length ? hueOffsets : [0]
  const drift = num(hueDrift, 0.001)
  const jitter = num(twistJitter, 0.02)
  const idle = Math.abs(num(idleAmp, 1.5))
  const amplitude = num(gain, 46)
  // a non-finite smoothing would otherwise freeze level at 0 forever
  const follow = clamp(num(smoothing, 0.08), 0, 1)
  // The mean of a full FFT is a small number even for loud speech, so the
  // level needs a drive factor to reach a useful amplitude.
  const drive = Math.max(0, num(levelGain, 1))
  const fraction = clamp(num(bandFraction, 1), 0.01, 1)
  const fLo = Math.max(0.05, num(minFreq, 1.5))
  const fSpread = Math.max(0, num(freqSpread, 4))
  const random = typeof rng === 'function' ? rng : () => 0.5

  const draw = () => {
    const v = random()
    return Number.isFinite(v) ? clamp(v, 0, 1) : 0.5
  }

  const lines = []
  for (let f = 0; f < familyCount; f++) {
    const offset = wrap01(num(offsets[f % offsets.length], 0))
    for (let l = 0; l < perFamily; l++) {
      const phase = draw() * TAU
      // wave crests across the window; the spread keeps lines off each other
      const freq = fLo + draw() * fSpread
      lines.push({
        familyIndex: f,
        lineIndex: lines.length,
        hue: offset,
        hueOffset: offset,
        phase,
        basePhase: phase,
        twist: 0,
        freq
      })
    }
  }

  const model = {
    families: familyCount,
    linesPerFamily: perFamily,
    points: pointCount,
    hueOffsets: offsets.slice(),
    hueDrift: drift,
    twistJitter: jitter,
    idleAmp: idle,
    gain: amplitude,
    smoothing: follow,
    levelGain: drive,
    bandFraction: fraction,
    lines,
    baseHue: 0,
    level: 0,

    update (fft, dt = 1 / 60) {
      // dt only paces the random walk; hue and level advance once per frame
      const step = clamp(num(dt, 1 / 60) * 60, 0, 4) || 1

      model.baseHue = wrap01(model.baseHue + drift)

      const len = fft && fft.length ? fft.length : 0
      let sum = 0
      for (let i = 0; i < len; i++) {
        const raw = fft[i]
        sum += Number.isFinite(raw) ? clamp(raw, 0, 255) : 0
      }
      const target = len ? clamp((sum / (len * 255)) * drive, 0, 1) : 0
      model.level = model.level + (target - model.level) * follow
      if (!Number.isFinite(model.level)) model.level = 0
      model.level = clamp(model.level, 0, 1)

      for (const line of lines) {
        line.twist += (draw() - 0.5) * jitter * step
        line.hue = wrap01(model.baseHue + line.hueOffset)
      }

      return model
    },

    reset () {
      model.baseHue = 0
      model.level = 0
      for (const line of lines) {
        line.twist = 0
        line.phase = line.basePhase
        line.hue = line.hueOffset
      }
      return model
    }
  }

  return model
}

export function computeBandPoints (model, lineIndex, fft, rect) {
  const box = rect && typeof rect === 'object' ? rect : {}
  const points = model && Number.isFinite(model.points) ? Math.max(2, Math.floor(model.points)) : 2
  const out = new Float32Array(points * 2)
  const line = model && model.lines ? model.lines[lineIndex] : null
  if (!line) return out

  const width = Math.max(0, num(box.width, 0))
  const centerY = num(box.centerY, 0)
  const height = Math.max(0, num(box.height, 0))
  const half = height / 2
  const idle = num(model.idleAmp, 0)
  const gain = num(model.gain, 0)
  const level = clamp(num(model.level, 0), 0, 1)
  const phase = num(line.phase, 0) + num(line.twist, 0)
  const k = width > 0 ? (TAU * num(line.freq, 1)) / width : 0

  for (let i = 0; i < points; i++) {
    const x = (i / (points - 1)) * width
    const amp = idle + binAt(fft, i, points, num(model.bandFraction, 1)) * gain * level
    const y = clamp(centerY + Math.sin(x * k + phase) * amp, centerY - half, centerY + half)
    out[i * 2] = Number.isFinite(x) ? x : 0
    out[i * 2 + 1] = Number.isFinite(y) ? y : centerY
  }

  return out
}
