/**
 * When the transcript is worth showing, and when it is worth keeping.
 *
 * The strip has no window to get out of the way, so "out of the way" has to
 * mean the text itself fading once you have stopped talking. Pure, with the
 * clock passed in, because the interesting cases are all about timing.
 *
 * Three inputs decide it:
 *   activity  the last time something happened worth reading — speech, an
 *             interim update, command mode arming
 *   awake     the pointer is on the strip, so someone is reading or clicking
 *   held      a panel or popover is open; the text under it must not vanish
 *
 * Once faded, the transcript is *stale*: it stays in memory so ⌃⌥↩ can still
 * send it, but the next utterance starts a fresh one rather than appending to
 * something the screen no longer shows.
 *
 * Longer still and it *expires*. The strip hears whatever the room says — a
 * song, someone stopping by to talk — and text nobody came back for is text
 * nobody meant to dictate. Holding it costs nothing until the moment ⌃⌥↩
 * pastes a stranger's sentence into a work chat, so after `idleClearMs` the
 * caller is told to forget it entirely. `0` keeps it forever.
 */
export function createPresence ({ idleFadeMs = 6000, idleClearMs = 20000 } = {}) {
  let fadeAfter = idleFadeMs
  let clearAfter = idleClearMs
  let lastActivity = 0
  let awake = false
  let held = false
  let faded = false
  let expired = false

  return {
    /** Changed from the settings panel while the strip is running. */
    setIdleFadeMs (ms) {
      if (Number.isFinite(ms) && ms >= 0) fadeAfter = ms
    },
    /** `0` means never — the transcript stays until something else clears it. */
    setIdleClearMs (ms) {
      if (Number.isFinite(ms) && ms >= 0) clearAfter = ms
    },

    /** Something happened that is worth showing. Un-fades immediately. */
    activity (now) {
      lastActivity = now
      faded = false
      expired = false
    },
    /* Both edges restart the idle clock. Arriving, because reaching for the
       strip is interest and the text must not fade out from under the pointer
       that came to click it; leaving, because the countdown should start when
       you are done with it, not from the last word you happened to say. */
    setAwake (value, now) {
      awake = !!value
      lastActivity = now
      if (awake) faded = false
    },
    setHeld (value, now) {
      held = !!value
      lastActivity = now
    },

    /**
     * `expired` is reported once, on the tick that crosses the line: the caller
     * throws the text away in response, and there is nothing left to expire
     * until something is said again.
     *
     * @param {number} now
     * @returns {{faded: boolean, changed: boolean, expired: boolean}}
     */
    tick (now) {
      const before = faded
      const idle = !awake && !held
      faded = idle && now - lastActivity >= fadeAfter
      // Never before the fade: a transcript cannot be forgotten while it is
      // still the current one on screen, however the two are set.
      const wasExpired = expired
      expired = idle && clearAfter > 0 &&
        now - lastActivity >= Math.max(clearAfter, fadeAfter)
      return { faded, changed: faded !== before, expired: expired && !wasExpired }
    },

    get faded () { return faded },
    /** The idle window for forgetting has passed; the text is already gone. */
    get expired () { return expired },
    /** Text is on screen but no longer current — the next utterance replaces it. */
    get stale () { return faded },
    get awake () { return awake },
    get held () { return held }
  }
}
