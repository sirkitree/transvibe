/**
 * Speaking back, through macOS's own `say`.
 *
 * The app already knows what it did — it puts a line on the strip after every
 * command. But the strip is not what you are looking at when you dictate: you
 * are looking at the app the words are going into, which is the whole reason
 * the wake phrase exists. So the confirmation is said out loud as well.
 *
 * `say` rather than the renderer's speechSynthesis: it is the same voice
 * catalogue the rest of the system uses, it is one process to kill when a
 * second command interrupts the first, and it keeps audio out of the window
 * that is already busy drawing 30 frames a second.
 */

import { spawn } from 'node:child_process'

let current = null

/**
 * Voice names macOS will accept for `-v`.
 *
 * Pure so the parsing is testable: `say -v '?'` prints a fixed-ish column
 * layout — name, locale, then `# an example sentence` — and the name itself
 * may contain spaces ("Eddy (English (UK))"), so the split is on the locale,
 * not on whitespace.
 *
 * @param {string} stdout
 * @returns {{name: string, locale: string}[]}
 */
export function parseVoices (stdout) {
  const out = []
  for (const line of String(stdout == null ? '' : stdout).split('\n')) {
    // Anchored on the '# example sentence' rather than on column positions:
    // the columns are padded to the longest name, so a long one ("Eddy
    // (English (UK))") leaves only a single space before its locale.
    const m = /^(.+?)\s+([a-z]{2}[-_][A-Z]{2}\S*)\s+#/.exec(line)
    if (!m) continue
    const name = m[1].trim()
    if (name) out.push({ name, locale: m[2] })
  }
  return out
}

/**
 * Every voice installed on this Mac.
 *
 * An empty list is a perfectly ordinary answer — `say` can be missing on a
 * stripped-down system — and never a throw, because the settings panel asks
 * for this every time it opens.
 *
 * @returns {Promise<{name: string, locale: string}[]>}
 */
export function listVoices () {
  return new Promise(resolve => {
    let out = ''
    const p = spawn('say', ['-v', '?'], { stdio: ['ignore', 'pipe', 'ignore'] })
    p.stdout.on('data', d => { out += d })
    p.on('error', () => resolve([]))
    p.on('close', () => resolve(parseVoices(out)))
  })
}

/** Cut off whatever is being said, if anything. */
export function stopSpeaking () {
  if (!current) return
  const p = current
  current = null
  try { p.kill() } catch { /* already gone */ }
}

/**
 * Say one line, and resolve when the speaker is quiet again.
 *
 * The caller deafens the microphone for exactly this window, so resolving late
 * is worse than not speaking at all: a hung `say` would leave the app unable
 * to hear. Hence the cap — a four-word confirmation that has not finished in
 * eight seconds is not going to.
 *
 * A second command interrupts the first rather than queueing behind it: by the
 * time you have said the next thing, hearing about the last one is noise.
 *
 * @param {string} text
 * @param {{voice?: string|null, rate?: number|null, timeoutMs?: number}} options
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export function speak (text, { voice = null, rate = null, timeoutMs = 8000 } = {}) {
  const line = String(text == null ? '' : text).trim()
  if (!line) return Promise.resolve({ ok: false, error: 'nothing to say' })

  stopSpeaking()

  const args = []
  if (voice) args.push('-v', voice)
  if (Number.isFinite(rate) && rate > 0) args.push('-r', String(Math.round(rate)))
  // `--` so a confirmation that happens to start with a dash is not read as a
  // flag. Nothing here is user-authored, but the applier's messages are not
  // written with argv in mind and never should have to be.
  args.push('--', line)

  return new Promise(resolve => {
    let p
    try {
      p = spawn('say', args, { stdio: 'ignore' })
    } catch (err) {
      return resolve({ ok: false, error: err.message })
    }
    current = p

    const done = result => {
      clearTimeout(timer)
      if (current === p) current = null
      resolve(result)
    }
    const timer = setTimeout(() => {
      try { p.kill() } catch { /* already gone */ }
      done({ ok: false, error: 'timed out' })
    }, timeoutMs)

    p.on('error', err => done({ ok: false, error: err.message }))
    p.on('close', () => done({ ok: true }))
  })
}
