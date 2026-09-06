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
export const ORB_SIZE = 300
export const ORB_MARGIN = 24
const MIN_HEIGHT = 90
// Below this the mandala is a smudge; a display too small for the requested
// orb gets a smaller one rather than one hanging off the edge.
const MIN_ORB = 120

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

/**
 * The orb's square, in the lower-left corner of a display.
 *
 * Anchored to the work area, which already excludes the Dock — so an orb in
 * the bottom-left sits above it with no special case, and follows it when the
 * Dock is hidden or moved to another edge.
 *
 * @param {{workArea?: {x,y,width,height}, bounds?: object}} display
 * @param {{size?: number, margin?: number}} [opts]
 * @returns {{x:number, y:number, width:number, height:number}}
 */
export function orbBounds (display, { size = ORB_SIZE, margin = ORB_MARGIN } = {}) {
  const area = (display && display.workArea) || (display && display.bounds) || null
  const inset = Math.max(0, finite(margin) ? margin : ORB_MARGIN)
  const want = Math.max(MIN_ORB, finite(size) ? size : ORB_SIZE)
  if (!area || !finite(area.x) || !finite(area.y) || !finite(area.width) || !finite(area.height)) {
    return { x: inset, y: inset, width: want, height: want }
  }
  // Never wider or taller than the room it has, margins included.
  const side = Math.round(Math.max(
    MIN_ORB,
    Math.min(want, area.width - inset * 2, area.height - inset * 2)
  ))
  return {
    x: Math.round(area.x + inset),
    // Bottom-left: the far edge of the work area, less the orb and its margin.
    y: Math.round(area.y + area.height - side - inset),
    width: side,
    height: side
  }
}

/**
 * Whether a screen point falls inside the circle inscribed in a rectangle.
 *
 * The orb is round in a square window, and the difference is four corners.
 * Testing the square would mean the orb quietly swallowing the pointer in
 * places where there is visibly nothing — which for a window sitting in the
 * corner of the screen is exactly where other things live.
 *
 * `inset` shrinks the circle: the drawn figure does not reach the edge of its
 * window, and a hover region larger than the thing you are hovering feels
 * like a mis-click waiting to happen.
 *
 * @param {{x,y,width,height}} rect
 * @param {{x,y}} point
 * @param {{inset?: number}} [opts]
 */
export function withinCircle (rect, point, { inset = 0 } = {}) {
  if (!rect || !point || !finite(point.x) || !finite(point.y)) return false
  if (!finite(rect.width) || !finite(rect.height)) return false
  const r = Math.min(rect.width, rect.height) / 2 - Math.max(0, finite(inset) ? inset : 0)
  if (r <= 0) return false
  const dx = point.x - (rect.x + rect.width / 2)
  const dy = point.y - (rect.y + rect.height / 2)
  return dx * dx + dy * dy <= r * r
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
 * the screen on the way to a menu never steals a click. Sleeping is nearly as
 * quick, because a strip that stays solid after the pointer has gone is
 * exactly the "in the way" this whole layout exists to avoid — but not
 * instant: the trip from the transcript down to the buttons crosses a few
 * pixels that belong to neither, and sleeping on that crossing pulled the
 * buttons out from under the pointer before it arrived. `hold` is the renderer
 * saying it is mid-interaction (a panel open, a field focused); that outranks
 * the pointer having wandered off.
 *
 * @param {{awake: boolean, insideSince: number|null, outsideSince?: number|null}} prev
 * @param {{inside: boolean, hold?: boolean, now: number, wakeDelayMs?: number, sleepDelayMs?: number}} input
 * @returns {{awake: boolean, insideSince: number|null, outsideSince: number|null}}
 */
export function nextWake (prev, { inside, hold = false, now, wakeDelayMs = 200, sleepDelayMs = 250 }) {
  const was = prev || { awake: false, insideSince: null, outsideSince: null }

  if (!inside) {
    if (hold) return { awake: was.awake, insideSince: null, outsideSince: null }
    if (!was.awake) return { awake: false, insideSince: null, outsideSince: null }
    // Awake and off target: start (or continue) the grace window. The dwell is
    // kept, so coming straight back does not re-earn the wake.
    const left = was.outsideSince == null ? now : was.outsideSince
    if (now - left >= sleepDelayMs) return { awake: false, insideSince: null, outsideSince: null }
    return { awake: true, insideSince: was.insideSince, outsideSince: left }
  }

  const since = was.insideSince == null ? now : was.insideSince
  return {
    awake: was.awake || now - since >= wakeDelayMs,
    insideSince: since,
    outsideSince: null
  }
}
