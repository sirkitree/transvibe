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

  /* The overlay strip. It hangs from the top of the screen, click-through
     until the pointer has rested on it for `wakeDelayMs`, and the transcript
     fades once nothing has been said for `idleFadeMs`. `panelHeight` is how
     tall the strip grows while the help or glossary panel is open.

     `idleClearMs` is the second stage: a faded transcript nobody has come back
     to is thrown away rather than kept, because the mic hears music and
     passers-by too and none of that should still be sitting there waiting for
     ⌃⌥↩. `0` keeps it until something else clears it. */
  stripHeight: 180,
  panelHeight: 560,
  wakeDelayMs: 320,
  idleFadeMs: 6000,
  idleClearMs: 20000,

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
  modelPath: null,
  language: 'en',

  /* Glossary. `vocabulary` is fed to whisper.cpp as the initial prompt, which
     biases the decoder toward these spellings while it is still listening.
     `corrections` is the backstop: exact wrong → right rewrites applied to the
     finished text, matched whole-word and case-insensitively. */
  vocabulary: [],
  corrections: {},
  /* The local assist model (Ollama, still on this machine). Both off by
     default: they are only useful if you have pulled the model, and each adds
     a few hundred ms after an utterance settles.
       cleanup         tidy fillers and false starts out of settled text
       commandFallback ask it what an unrecognised command meant */
  cleanup: false,
  commandFallback: false,
  assistModel: 'gemma4:e2b',
  assistUrl: 'http://127.0.0.1:11434',

  /* Drop an utterance that is nothing but glossary words — almost always the
     initial prompt echoing back over noise. Turn it off if you genuinely need
     to dictate a single glossary term on its own. */
  dropGlossaryEcho: true
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
