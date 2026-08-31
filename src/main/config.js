import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const DIR = path.join(os.homedir(), 'Library', 'Application Support', 'transvibe')
const FILE = path.join(DIR, 'settings.json')

export const DEFAULTS = {
  threshold: 0.02,
  hangoverMs: 550,
  interimMs: 500,      // how often the open utterance is re-transcribed
  commandTimeoutMs: 6000,   // command mode disarms itself if you say nothing
  sendTarget: null,         // app name to focus before pasting; null = frontmost
  sendPressesEnter: false,  // also hit Return after pasting
  clearAfterSend: true,
  bounds: null,             // last window rectangle, restored on next launch

  /* Visualizer cost. Measured on an M-series Mac, stroke count barely moves
     the needle once shadowBlur is gone — 36 lines and 54 lines both land at
     13.5% — because what is left is compositing a transparent window, not
     drawing. So the line budget stays generous and the frame rate does the
     saving. */
  vizLinesPerFamily: 18,
  vizPoints: 220,
  vizFps: 30,
  vizQuietFps: 8,

  autoCopy: false,
  alwaysOnTop: true,
  opacity: 1,
  idleOpacity: 0.22,   // how far the window fades when it loses focus
  modelPath: null,
  language: 'en'
}

export function load () {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }
  } catch {
    return { ...DEFAULTS }
  }
}

export function save (patch) {
  const next = { ...load(), ...patch }
  fs.mkdirSync(DIR, { recursive: true })
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2))
  return next
}
