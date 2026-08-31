/**
 * Geometry and wake rules for the overlay strip, kept pure so both are
 * testable without Electron. The caller supplies displays and cursor
 * positions; this module never touches the screen itself.
 *
 * The strip is a full-width band across the top of a display. It is
 * click-through by default — the pointer reaches whatever is behind it — and
 * only becomes solid once the pointer has been parked on it for a moment.
 */

export const STRIP_HEIGHT = 200
export const PANEL_HEIGHT = 560
const MIN_HEIGHT = 90

const finite = v => typeof v === 'number' && Number.isFinite(v)

/**
 * The rectangle the window should occupy on a display.
 *
 * Anchored to the work area rather than the display bounds, so the strip hangs
 * below the menu bar instead of fighting it for the same pixels.
 *
 * @param {{workArea?: {x,y,width,height}, bounds?: object}} display
 * @param {{height?: number}} [opts]
 * @returns {{x:number, y:number, width:number, height:number}}
 */
export function stripBounds (display, { height = STRIP_HEIGHT } = {}) {
  const area = (display && display.workArea) || (display && display.bounds) || null
  if (!area || !finite(area.x) || !finite(area.y) || !finite(area.width) || !finite(area.height)) {
    return { x: 0, y: 0, width: 1280, height: Math.max(height, MIN_HEIGHT) }
  }
  return {
    x: Math.round(area.x),
    y: Math.round(area.y),
    width: Math.round(area.width),
    // A short display must never get a strip taller than itself.
    height: Math.round(Math.min(Math.max(height, MIN_HEIGHT), area.height))
  }
}

/** @returns {boolean} whether a screen point falls inside a rectangle. */
export function contains (rect, point) {
  if (!rect || !point || !finite(point.x) || !finite(point.y)) return false
  return point.x >= rect.x && point.x < rect.x + rect.width &&
         point.y >= rect.y && point.y < rect.y + rect.height
}

/**
 * One step of the hover-to-wake machine.
 *
 * Waking is deliberate — the pointer has to dwell — so sweeping past the top of
 * the screen on the way to a menu never steals a click. Sleeping is immediate,
 * because a strip that stays solid after the pointer has gone is exactly the
 * "in the way" this whole layout exists to avoid. `hold` is the renderer
 * saying it is mid-interaction (a panel open, a field focused); that outranks
 * the pointer having wandered off.
 *
 * @param {{awake: boolean, insideSince: number|null}} prev
 * @param {{inside: boolean, hold?: boolean, now: number, wakeDelayMs?: number}} input
 * @returns {{awake: boolean, insideSince: number|null}}
 */
export function nextWake (prev, { inside, hold = false, now, wakeDelayMs = 200 }) {
  const was = prev || { awake: false, insideSince: null }

  if (!inside) {
    if (hold) return { awake: was.awake, insideSince: null }
    return { awake: false, insideSince: null }
  }

  const since = was.insideSince == null ? now : was.insideSince
  return { awake: was.awake || now - since >= wakeDelayMs, insideSince: since }
}
