/**
 * Named macOS Spaces.
 *
 * A Space has no name macOS will tell you and no API that will switch to one.
 * The workaround is a marker: a tiny app assigned to one desktop, which drags
 * you there when it is activated. So "switch to SDSU" is really "activate the
 * app called SDSU Space" — the naming lives in a folder of `.app` bundles, and
 * all this module does is decide which of them a spoken name meant.
 *
 * With two displays there are two current desktops, so "switch to" takes more
 * than one name: each marker moves the display it lives on, and the pair is one
 * command rather than two.
 *
 * A running app is a jump target too, and the same click reaches it: apps are
 * on desktops just as markers are, and "switch to Slack" is the same sentence.
 *
 * Pure — no fs, no Electron. `src/main/spaces.js` does the reading.
 */

/**
 * A spoken name and a marker's own name, reduced to the same thing.
 *
 * Separators go entirely rather than collapsing to a space: whisper hears an
 * initialism as anything from "SDSU" to "SD SU" to "S.D.S.U.", and all three
 * have to land on the same marker. The trailing "space" goes too, so both
 * "switch to home" and "switch to the home space" reach `Home Space.app`.
 */
export function spaceKey (name) {
  const flat = String(name == null ? '' : name)
    .toLowerCase()
    .replace(/^\s*(?:the|my)\s+/, '')
    .replace(/[^a-z0-9]+/g, '')
  return flat.length > 5 && flat.endsWith('space') ? flat.slice(0, -5) : flat
}

/**
 * Every key a target answers to: its whole name, and each trailing run of its
 * words.
 *
 * "Google Chrome" is called Chrome by everybody, and a prefix rule cannot get
 * there from "chrome" — the shortening people do is at the front, not the end.
 * "Elk Grove Space" answers to "elk grove" and to "grove" for the same reason.
 *
 * @returns {string[]} longest first, so the fullest name is the primary key
 */
export function spaceAliases (name) {
  const words = String(name == null ? '' : name).trim().split(/\s+/).filter(Boolean)
  const out = []
  for (let i = 0; i < words.length; i++) {
    const key = spaceKey(words.slice(i).join(' '))
    if (key && !out.includes(key)) out.push(key)
  }
  return out
}

const keysOf = space => {
  if (!space) return []
  if (Array.isArray(space.keys) && space.keys.length) return space.keys
  return space.key ? [space.key] : []
}

/**
 * The one space a spoken name can only mean.
 *
 * A prefix counts — "elk" is enough when nothing else starts that way — but an
 * ambiguous prefix is refused rather than guessed. Landing on the wrong desktop
 * is worse than being told to say more: the command took your screen away, so
 * the mistake costs you the trip back as well.
 *
 * @param {string} name  what was said after "switch to"
 * @param {Array<{key: string}>} spaces
 * @returns {object|null}
 */
export function matchSpace (name, spaces) {
  const key = spaceKey(name)
  if (!key || !Array.isArray(spaces)) return null

  const exact = spaces.filter(s => keysOf(s).includes(key))
  if (exact.length === 1) return exact[0]
  if (exact.length > 1) return null

  const starts = spaces.filter(s => keysOf(s).some(k => k.startsWith(key)))
  return starts.length === 1 ? starts[0] : null
}

/* "home and communications", "home, communications". Only a joiner between
   names — a marker whose own name contains "and" would be split by this, and
   there is no such marker. */
const JOINER = /\s*,\s*(?:and\s+)?|\s+and\s+/

/**
 * Every Space named in one breath, or none of them.
 *
 * All or nothing, like a command chain: half of "switch to home and
 * communications" leaves one display moved and the other where it was, which
 * is a worse place to be than not having said anything. A name that does not
 * resolve makes the whole utterance dictation again.
 *
 * @param {string} phrase  what was said after "switch to"
 * @param {Array<{key: string}>} spaces
 * @returns {Array<object>|null}
 */
export function matchSpaces (phrase, spaces) {
  const parts = String(phrase == null ? '' : phrase)
    .split(JOINER).map(p => p.trim()).filter(Boolean)
  if (!parts.length) return null

  const out = []
  for (const part of parts) {
    const hit = matchSpace(part, spaces)
    if (!hit) return null
    // "switch to home and home" is one jump, not two.
    if (!out.some(s => s.key === hit.key)) out.push(hit)
  }
  return out
}

/** "Home", "Home and Communications", "Home, SDSU and Bravo". */
export function spokenList (spaces) {
  const names = (spaces || []).map(s => s && s.name).filter(Boolean)
  if (names.length < 2) return names[0] || ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}
