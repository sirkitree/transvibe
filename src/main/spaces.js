/**
 * Finding the marker apps.
 *
 * Points at a folder of `<Name> Space.app` bundles — the space-markers layout.
 * If that folder has a `markers.json` its lists are used, because they are the
 * record of which markers are real; otherwise every `.app` in the folder is
 * taken at face value, so the feature works on a folder nobody has documented.
 *
 * Nothing is cached. The list is read when it is asked for, which is once at
 * launch and again whenever the folder setting changes — cheap next to being
 * wrong about a marker that was added an hour ago.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spaceKey } from '../shared/spaces.js'

/* The launcher is a marker-shaped thing that is not a marker: opening it
   re-runs the whole login sequence. */
const NOT_A_MARKER = /launcher/i

export function expandHome (dir) {
  if (typeof dir !== 'string' || !dir.trim()) return null
  const trimmed = dir.trim()
  if (trimmed === '~') return os.homedir()
  if (trimmed.startsWith('~/')) return path.join(os.homedir(), trimmed.slice(2))
  return trimmed
}

/* space-markers groups its lists by display — "display1", "display2" — and
   which display a marker is on is the one thing about it that matters beyond
   its name: two markers on the same display cannot both be in front of you. */
function fromManifest (dir) {
  const file = path.join(dir, 'markers.json')
  if (!fs.existsSync(file)) return null
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    const found = []
    for (const [group, names] of Object.entries(raw)) {
      if (!Array.isArray(names)) continue
      const match = /(\d+)/.exec(group)
      const display = match ? Number(match[1]) : null
      for (const name of names) {
        if (typeof name === 'string' && name.trim()) found.push({ name, display })
      }
    }
    return found.length ? found : null
  } catch {
    // A manifest that will not parse is not a reason to have no spaces at all.
    return null
  }
}

/* No manifest, so no way to know which display anything is on. Null rather
   than a guess: it only ever suppresses the "those two share a display"
   warning, and a warning invented from nothing is worse than none. */
function fromFolder (dir) {
  return fs.readdirSync(dir)
    .filter(name => name.endsWith('.app') && !NOT_A_MARKER.test(name))
    .map(name => ({ name: name.slice(0, -'.app'.length), display: null }))
}

/**
 * Every marker in the folder.
 *
 * `name` is what the marker is called with the "Space" left off, because that
 * word is in every one of them and saying it back — "switching to SDSU Space"
 * — is a stutter. `app` is the bundle to activate, `display` the screen it
 * moves, or null when nothing said.
 *
 * @param {string|null} dir  the setting, `~` and all
 * @returns {Array<{name: string, key: string, app: string, display: number|null}>}
 */
export function listSpaces (dir) {
  const root = expandHome(dir)
  if (!root || !fs.existsSync(root)) return []

  let markers
  try {
    markers = fromManifest(root) || fromFolder(root)
  } catch {
    return []
  }

  const seen = new Set()
  const out = []
  for (const { name, display } of markers) {
    const key = spaceKey(name)
    if (!key || seen.has(key)) continue
    const app = path.join(root, `${name}.app`)
    if (!fs.existsSync(app)) continue
    seen.add(key)
    out.push({ name: name.replace(/\s+Space$/i, ''), key, app, display })
  }
  return out
}
