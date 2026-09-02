// Pure math for the small ribbon that runs while the app is talking.
//
// It cannot be a spectrum. What comes out of the speakers is macOS's `say`
// playing to the system output, and the app never sees those samples — the
// microphone is deliberately deaf for exactly that window, which is the whole
// point. So this is synthesised: a syllable-rate envelope that looks like
// speech rather than one measured from it.
//
// Honest about what it is. The ribbon along the top is the room, measured; this
// is the app saying "that was me", and it only has to be true about *when*.
//
// It is shaped as a spectrum rather than as anything more convenient because
// the drawing is not this module's to do: the same band renderer that draws the
// microphone draws this, from an analyser that is arithmetic instead of an ear.

const TAU = Math.PI * 2

const clamp01 = v => (Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0)

/* Speech modulates at roughly four syllables a second. Each bar gets its own
   rate near that, so they drift in and out of step the way a voice does rather
   than pumping together like a level meter. */
const BASE_HZ = 3.6
const SPREAD_HZ = 0.55

/* Speech energy lives at the bottom of the spectrum and falls away above it.
   A flat spectrum would draw a flat ribbon; this is what gives the shape its
   swell in the middle and its taper at the ends. */
function tilt (at) {
  return 0.25 + 0.75 * Math.exp(-3.1 * at)
}

/**
 * A spectrum for one instant, in the shape an AnalyserNode hands out.
 *
 * Which is the point: the strip's own ribbon is drawn from a real FFT of the
 * room, and this fills the same array from arithmetic instead, so the app's
 * voice can be drawn by exactly the same code rather than by a second
 * visualizer that merely resembles it. Low bins carry the energy, the way
 * speech does; each band breathes at its own near-syllable rate.
 *
 * Deterministic in its arguments — no state, no random — so the same moment
 * always draws the same frame, and a test can say what it should look like.
 *
 * @param {number} elapsedMs since the app started speaking
 * @param {{bins?: number, level?: number, seed?: number, out?: Uint8Array}} options
 *   `level` is the overall envelope, which the caller fades in and out; at 0
 *   the spectrum is silent. Pass `out` to fill an array you already have.
 * @returns {Uint8Array} bytes, as `getByteFrequencyData` would leave them
 */
export function sayingSpectrum (elapsedMs, { bins = 128, level = 1, seed = 1, out = null } = {}) {
  const count = Math.max(1, Math.floor(bins))
  const buf = out && out.length === count ? out : new Uint8Array(count)
  const t = Number.isFinite(elapsedMs) ? elapsedMs / 1000 : 0
  const amp = clamp01(level)

  for (let i = 0; i < count; i++) {
    const at = i / count
    const hz = BASE_HZ + (at - 0.5) * SPREAD_HZ * 2
    /* Phase moves slowly across the spectrum rather than jumping per bin: a
       real FFT's neighbours agree with each other, and one that does not draws
       a ribbon made of noise instead of a ribbon made of a voice. */
    const phase = (at * 2.3 + seed * 0.37) * TAU
    // Two waves an octave apart: the slow one is the syllable, the fast one
    // stops it looking like a sine.
    const syllable = Math.sin(t * hz * TAU + phase)
    const grain = Math.sin(t * hz * 2.7 * TAU + phase * 1.7)
    const voiced = clamp01(0.52 + 0.36 * syllable + 0.12 * grain)
    buf[i] = Math.round(255 * voiced * tilt(at) * amp)
  }
  return buf
}

/**
 * The overall envelope: in quickly when it starts talking, out gently when it
 * stops, so the row does not snap off mid-syllable.
 *
 * @param {number} now
 * @param {{startedAt: number, stoppedAt: number|null, attackMs?: number, releaseMs?: number}} phase
 * @returns {number} 0 when it is fully gone, which is the caller's cue to stop
 *   drawing altogether
 */
export function sayingLevel (now, {
  startedAt, stoppedAt = null, attackMs = 120, releaseMs = 260
} = {}) {
  if (!Number.isFinite(startedAt)) return 0
  const attack = clamp01((now - startedAt) / Math.max(1, attackMs))
  if (stoppedAt === null || !Number.isFinite(stoppedAt)) return attack
  const release = 1 - clamp01((now - stoppedAt) / Math.max(1, releaseMs))
  return Math.min(attack, release)
}
