import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { migrateRoster } from '../shared/agents.js'

const DIR = path.join(os.homedir(), 'Library', 'Application Support', 'transvibe')
const FILE = path.join(DIR, 'settings.json')

export const DEFAULTS = {
  threshold: 0.02,
  hangoverMs: 550,
  interimMs: 500,      // how often the open utterance is re-transcribed
  commandTimeoutMs: 6000,   // command mode disarms itself if you say nothing

  /* Who you can talk to. An utterance that opens with an agent's name is
     addressed to it, and the rest of the sentence is what you are asking for.
     Editing what is on the strip needs no key at all, and a second name can
     mean something entirely different from the first.

     Edited in its own panel rather than here — see src/shared/agents.js for
     what a record holds. An empty roster turns the spoken route off and leaves
     the key path (right ⌥, ⌃⌥C) as the only way into command mode.

     `wakeWordFuzzy` forgives the near-misses a small model makes on an unusual
     name ("hey cloud", "hey claud"). */
  agents: [
    { name: 'hey claude', kind: 'commands', voice: null, rate: null, hue: 0.38 }
  ],
  wakeWordFuzzy: true,

  /* Saying what it just did. A command you gave with your voice deserves an
     answer in kind — you are looking at the app you are dictating into, not at
     the strip. `speakVoice` is a macOS voice name (`say -v '?'` lists them);
     null uses whatever the system speaks with. The microphone goes deaf for
     the length of the reply, so the app never transcribes itself. */
  speakReplies: true,
  speakVoice: null,
  speakRate: 0,             // words per minute; 0 = the voice's own pace

  /* How long a chat agent stays in the conversation after answering. Inside
     this window the next thing you say is a follow-up and needs no name, which
     is the difference between a conversation and a query box. */
  conversationMs: 25000,

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

  /* How sure the recogniser has to have been that it was hearing speech.
     Whisper reports an average log probability per utterance, and the gap is
     wide: measured on this app's own server, real speech comes back at -0.01
     to -0.08 while music, a fan and a pure tone land at -0.65, -0.76 and
     -0.64. Anything below the floor is thrown away, which is what stops music
     in the room becoming words on the strip. `0` turns the check off. */
  confidenceFloor: -0.5,

  /* Drop an utterance that is nothing but glossary words — almost always the
     initial prompt echoing back over noise. Turn it off if you genuinely need
     to dictate a single glossary term on its own. */
  dropGlossaryEcho: true
}

/* Anyone already running this app has a wake phrase they are used to saying,
   and it has to survive the update to a roster without being retyped. A file
   with no `agents` becomes a roster of one wearing the name it already had;
   `wakeWord` itself is then dropped, so there is one place that answers "what
   is it called" rather than two that can disagree. */
function migrate (saved) {
  const settings = { ...DEFAULTS, ...saved }
  settings.agents = migrateRoster(saved && Object.keys(saved).length ? saved : DEFAULTS)
  if (!settings.agents.length) settings.agents = migrateRoster(DEFAULTS)
  delete settings.wakeWord
  return settings
}

export function load () {
  try {
    return migrate(JSON.parse(fs.readFileSync(FILE, 'utf8')))
  } catch {
    return migrate(null)
  }
}

export function save (patch) {
  const next = migrate({ ...load(), ...patch })
  fs.mkdirSync(DIR, { recursive: true })
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2))
  return next
}
