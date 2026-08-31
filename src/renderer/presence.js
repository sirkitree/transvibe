/**
 * When the transcript is worth showing.
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
 */
export function createPresence ({ idleFadeMs = 6000 } = {}) {
  let lastActivity = 0
  let awake = false
  let held = false
  let faded = false

  return {
    /** Something happened that is worth showing. Un-fades immediately. */
    activity (now) {
      lastActivity = now
      faded = false
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
     * @param {number} now
     * @returns {{faded: boolean, changed: boolean}}
     */
    tick (now) {
      const before = faded
      faded = !awake && !held && now - lastActivity >= idleFadeMs
      return { faded, changed: faded !== before }
    },

    get faded () { return faded },
    /** Text is on screen but no longer current — the next utterance replaces it. */
    get stale () { return faded },
    get awake () { return awake },
    get held () { return held }
  }
}
