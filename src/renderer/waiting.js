/**
 * When a slow answer is worth saying something about.
 *
 * A local answer lands in well under a second, so the strip never had to admit
 * it was thinking. A frontier CLI does not: 2.7s for `claude` with the trimming
 * flags, 8.7s for `codex`, 14.1s for codex with web search — and a subprocess
 * prints nothing at all until it is finished, so there is no progress to
 * forward, only the fact that it is still running.
 *
 * That fact is worth two different things at two different scales, which is why
 * this module exists rather than a setTimeout at the call site:
 *
 *   drawn   a pending bubble with a number in it that moves. A moving number is
 *           the whole difference between "working" and "hung", and it is the
 *           only honest thing we can show about a process that is silent by
 *           design. Paired with a dot whose pulse comes off the same clock.
 *   spoken  past `nudgeMs`, once and only once, the app says so out loud. The
 *           premise of the app is that you are looking at the window you are
 *           dictating into, not at the strip; if the answer is ten seconds away
 *           the only channel that reaches you is the one you asked in.
 *
 * Once, not repeatedly. The 2.7s claude path must never speak, and the 14s
 * codex-with-search path must say "still waiting on Codex" exactly one time. A
 * progress voice that interrupts you twice is worse than no voice at all.
 *
 * Pure, with the clock passed in, like its sibling presence.js — no DOM, no
 * timers of its own. The caller ticks it from the frame loop it already has.
 *
 * IMPORTANT for the caller: `holdsStrip` is true for exactly as long as a call
 * is outstanding, and it must be mirrored into `presence.setHeld(true/false)`.
 * The transcript fades after idleFadeMs = 6000ms of quiet, which is shorter
 * than every remote call there is, and a remote call is quiet by definition —
 * nothing is said or transcribed while the subprocess runs. Without the hold
 * the strip fades out from under a question you are still waiting on, and you
 * are left watching a blank strip for the slowest part of the interaction.
 */

const TAU = Math.PI * 2

const clamp01 = v => (Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0)

/* Breathing rates for the indicator dot. The second one is faster on purpose:
   past the nudge the wait has stopped being routine, and the dot should read as
   "still going" rather than as the same idle shimmer it started with. */
const CALM_HZ = 0.55
const SLOW_HZ = 0.95

export function createWaiting ({ nudgeMs = 10000, timeoutMs = 30000 } = {}) {
  const nudgeAfter = Number.isFinite(nudgeMs) && nudgeMs >= 0 ? nudgeMs : 10000
  const timeoutAfter = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30000

  let startedAt = null
  let name = ''
  let hue = null
  let nudged = false

  const since = now => {
    if (startedAt === null || !Number.isFinite(now)) return 0
    return now - startedAt > 0 ? now - startedAt : 0
  }

  const phaseAt = now => {
    if (startedAt === null) return 'idle'
    const ms = since(now)
    if (ms >= timeoutAfter) return 'timedOut'
    if (ms >= nudgeAfter) return 'slow'
    return 'waiting'
  }

  return {
    /**
     * A call has gone out. `name` and `hue` come from the agent record so the
     * bubble and the dot can wear the same colour as the answer will.
     */
    start (now, { name: who = '', hue: colour = null } = {}) {
      startedAt = Number.isFinite(now) ? now : 0
      name = typeof who === 'string' ? who.trim() : ''
      hue = Number.isFinite(colour) ? colour : null
      nudged = false
    },

    /** The answer arrived, or the call failed. Either way there is nothing to wait for. */
    stop () {
      startedAt = null
      nudged = false
    },

    elapsed (now) { return since(now) },

    /**
     * 'idle' | 'waiting' | 'slow' | 'timedOut'.
     *
     * 'slow' begins at the same instant as the nudge, because that is the
     * definition of slow here: the moment the wait became worth mentioning.
     * 'timedOut' is this module's own opinion about the clock — the subprocess
     * is killed by whoever spawned it, and the two limits should match.
     */
    phase (now) { return phaseAt(now) },

    /**
     * What goes in the pending bubble: 'Claude · 4s'.
     *
     * Seconds are floored rather than rounded, so the number never claims time
     * that has not passed yet. An unnamed wait is just the count.
     */
    label (now) {
      if (startedAt === null) return ''
      const seconds = `${Math.floor(since(now) / 1000)}s`
      return name ? `${name} · ${seconds}` : seconds
    },

    /**
     * True on the first tick past `nudgeMs`, and never again for this call.
     *
     * The latch lives here rather than at the call site because the call site
     * is a render loop running sixty times a second, and "say this once" is
     * exactly the kind of thing it gets wrong.
     */
    shouldNudge (now) {
      if (nudged || startedAt === null) return false
      if (since(now) < nudgeAfter) return false
      nudged = true
      return true
    },

    /** The sentence to speak when it does. Empty when there is nobody to name. */
    get nudgeText () {
      return name ? `Still waiting on ${name}` : 'Still waiting'
    },

    /**
     * 0..1 for the indicator dot, straight off the clock like saying.js, so the
     * animation is a function of the moment rather than of state accumulated by
     * whoever happened to call it.
     *
     * The rate changes when the wait turns slow, but the *phase* carries over
     * across that boundary — computed as calm rate up to the nudge plus the
     * faster rate after it — because a dot that jumps mid-breath reads as a
     * dropped frame rather than as a change of pace.
     *
     * Flat at 0 once it has timed out: a dot still breathing over a call that
     * is already dead is the one thing this indicator must not say.
     */
    pulse (now) {
      const at = phaseAt(now)
      if (at === 'idle' || at === 'timedOut') return 0
      const t = since(now) / 1000
      const knee = nudgeAfter / 1000
      const turns = t <= knee
        ? CALM_HZ * t
        : CALM_HZ * knee + SLOW_HZ * (t - knee)
      return clamp01(0.5 + 0.5 * Math.sin(turns * TAU))
    },

    /**
     * Everything one frame needs, in presence.js's idiom. `nudge` consumes the
     * same once-only latch as `shouldNudge`, so a caller uses one or the other.
     */
    tick (now) {
      return {
        phase: phaseAt(now),
        label: this.label(now),
        pulse: this.pulse(now),
        nudge: this.shouldNudge(now),
        holdsStrip: startedAt !== null
      }
    },

    /**
     * Mirror this into `presence.setHeld()`. See the module note: without it the
     * transcript fades six seconds into a call that takes fourteen.
     */
    get holdsStrip () { return startedAt !== null },
    get waiting () { return startedAt !== null },
    get startedAt () { return startedAt },
    get name () { return name },
    get hue () { return hue }
  }
}
