/**
 * Window-geometry rules, kept pure so the off-screen recovery is testable.
 * The caller supplies the display list; this module never touches Electron.
 */

export const MIN_WIDTH = 380
export const MIN_HEIGHT = 420
export const DEFAULT_BOUNDS = { width: 520, height: 640 }

/* How much of the window has to land on a screen for the position to be worth
   restoring. A window sharing one pixel with a display is not reachable. */
const NEED_X = 120
const NEED_Y = 80

const finite = v => typeof v === 'number' && Number.isFinite(v)

/**
 * @param {object|null} saved     previously stored bounds
 * @param {Array<{workArea: {x,y,width,height}}>} displays
 * @returns {{width:number, height:number, x?:number, y?:number}}
 *   A size always comes back; x/y only when the saved position is still
 *   reachable, so the window falls back to being centred rather than lost.
 */
export function usableBounds (saved, displays = []) {
  if (!saved || typeof saved !== 'object') return { ...DEFAULT_BOUNDS }

  const width = finite(saved.width) ? Math.max(saved.width, MIN_WIDTH) : DEFAULT_BOUNDS.width
  const height = finite(saved.height) ? Math.max(saved.height, MIN_HEIGHT) : DEFAULT_BOUNDS.height
  const size = { width, height }

  if (!finite(saved.x) || !finite(saved.y)) return size

  const onScreen = displays.some(d => {
    const a = d && d.workArea
    if (!a || !finite(a.x) || !finite(a.y) || !finite(a.width) || !finite(a.height)) return false
    const overlapX = Math.min(saved.x + width, a.x + a.width) - Math.max(saved.x, a.x)
    const overlapY = Math.min(saved.y + height, a.y + a.height) - Math.max(saved.y, a.y)
    return overlapX >= Math.min(NEED_X, width) && overlapY >= Math.min(NEED_Y, height)
  })

  return onScreen ? { ...size, x: saved.x, y: saved.y } : size
}
