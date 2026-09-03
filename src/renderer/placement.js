// Where a dragged panel is allowed to end up.
//
// The strip is a window with no frame, pinned to the top of the screen and as
// tall as what it is showing, so "drag the panel somewhere else" is really two
// questions: where in the window does the panel sit, and how tall does the
// window have to be to contain it. Both are arithmetic, and arithmetic is
// worth doing where it can be tested rather than in the middle of a pointer
// event.
//
// Pure: no DOM, no Electron.

const finite = (v, fallback = 0) => (Number.isFinite(v) ? v : fallback)

/** Kept clear of the edges so a panel never looks like it fell off one. */
export const MARGIN = 12

/**
 * A position, clamped so the panel stays somewhere you can reach it.
 *
 * Horizontally it is held inside the view: a panel half off the side of the
 * screen is a panel with half its buttons gone. Vertically only the top is
 * held, because the window grows downward to follow — see `heightFor`.
 *
 * @param {{x: number, y: number}} at        where the drag has got to
 * @param {{width: number, height: number}} panel
 * @param {{width: number, height: number}} view the window's own size
 * @returns {{x: number, y: number}}
 */
export function clampPlacement (at, panel, view) {
  const width = Math.max(0, finite(panel && panel.width))
  const x = finite(at && at.x)
  const y = finite(at && at.y)
  const viewWidth = Math.max(0, finite(view && view.width))

  // A panel wider than the window has nowhere to go but the left edge.
  const maxX = Math.max(MARGIN, viewWidth - width - MARGIN)
  return {
    x: Math.round(Math.min(Math.max(x, MARGIN), maxX)),
    // The menu bar is above the top of the window, so 0 is as high as it goes.
    y: Math.round(Math.max(y, 0))
  }
}

/**
 * How tall the window has to be for the panel to fit inside it.
 *
 * The window is what catches the pointer; anything drawn past its bottom edge
 * is not merely clipped, it is unclickable. So dragging a panel down means
 * asking the window to follow it down.
 *
 * @param {{y: number}} at
 * @param {{height: number}} panel
 * @param {number} limit the tallest the window may be — the work area
 */
export function heightFor (at, panel, limit) {
  const bottom = finite(at && at.y) + Math.max(0, finite(panel && panel.height)) + MARGIN
  const cap = finite(limit, bottom)
  return Math.round(Math.min(Math.max(0, bottom), cap > 0 ? cap : bottom))
}

/**
 * Is a remembered position still usable?
 *
 * Screens change: a panel put down on a second display, or on a laptop docked
 * to something larger, comes back to a window that no longer has that pixel in
 * it. Rather than opening off-screen it goes back to the middle, which is
 * where it started.
 *
 * @param {{x: number, y: number}|null} at
 * @param {{width: number, height: number}} view
 */
export function isReachable (at, view) {
  if (!at || !Number.isFinite(at.x) || !Number.isFinite(at.y)) return false
  const width = Math.max(0, finite(view && view.width))
  // A little slack: the window is often a few pixels wider or narrower than it
  // was, and that is not a reason to throw the position away.
  return at.x >= -MARGIN && at.x <= width && at.y >= -MARGIN
}
