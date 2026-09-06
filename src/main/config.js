import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { migrateRoster, migrateModels } from '../shared/agents.js'

/** Where everything this app remembers lives. Exported because it is not
    only settings.json in there — the routing log sits beside it, and one
    module should answer "where" rather than two agreeing by accident. */
export const DIR = path.join(os.homedir(), 'Library', 'Application Support', 'transvibe')
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

  /* A folder of Space marker apps — the space-markers layout, `<Name>
     Space.app` bundles beside an optional markers.json. macOS will not name a
     desktop Space or switch to one on request; activating an app assigned to
     that Space is the only way there. Naming the folder is what turns "switch
     to SDSU" into a command; null leaves those words as dictation. */
  spacesDir: null,

  /* How each model actually performed, the last time it answered: how long it
     took and how much it said. Observed rather than chosen — it sits among the
     preferences because the model picker needs it to survive a restart, and a
     number you only see after using a model in this session is a number you
     never see. Written by the app, not by you. */
  modelStats: {},
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
  /* Where a panel was last dragged to, in window pixels. Remembered rather
     than chosen — there is no row for it in the settings panel, because the
     way you set it is by moving the thing. `null` is centred, which is where
     it starts. */
  panelPosition: null,

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

  /* Which visualizer is running, and the second window's shape.

     'strip' is the ribbon along the top and the small counter-facing one that
     draws while the app talks. 'orb' replaces both with a round mandala in a
     square window in the lower-left corner — a different place on the screen
     from the strip, so it has to be a second window — and the app's own voice
     becomes a counter-turning miniature inside it rather than a second widget
     somewhere else.

     `orbSeeds` and `orbSteps` are the cost dials, the way vizLinesPerFamily
     and vizPoints are for the ribbon. Each seed is drawn twice, once under the
     point reflection, so the stroke count is twice the seed count. */
  layout: 'strip',
  orbSize: 300,
  orbMargin: 24,
  orbSeeds: 120,
  orbSteps: 14,
  orbSayScale: 0.4,
  /* How far the room opens the figure, and how fast it closes again once the
     room goes quiet. The zoom is the headline of the sketch this came from:
     the whole mandala breathes outward when you speak.

     Well below the reference's 3, because the reference had a whole screen to
     grow into and this has a 300pt square. The figure is sized so that the
     top of this range still fits inside the window. */
  orbZoomGain: 0.5,
  orbZoomDecay: 0.05,

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
       commandFallback ask it what an unrecognised command meant

     Which model does the thinking is each agent's own — see `agents` above.
     Dictation is addressed to nobody, so tidying it uses the model belonging
     to whoever runs commands. */
  cleanup: false,
  commandFallback: false,
  assistUrl: 'http://127.0.0.1:11434',

  /* Escalating a question to a frontier model.

     This is the one thing in the app that sends text off this machine, which
     is why it is a single switch and why it is off. With it on, a question you
     addressed to a chat agent — that sentence and that thread's own history,
     nothing else — can be handed to a CLI already signed in here (`claude`,
     `codex`), spawned with the question, billed against a subscription rather
     than an API key. Dictation never goes: tidying text and guessing at a
     command stay on the local model whatever this says, because a room
     microphone hears things nobody addressed to anyone.

     `remoteAnnounce` makes the escalation audible — the answer arrives as
     "Claude said, ..." rather than in the agent's own voice as if it had known
     all along. Knowing which answers left the machine is worth the two words.

     `remoteTimeoutMs` is generous on purpose: measured, a trimmed `claude -p`
     returns in 2.7s and `codex exec` with web search in 14.1s, so 30s is the
     point at which something has actually gone wrong rather than the point at
     which it is slow.

     `remoteWebSearch` is off for the same reason the rest is: it is codex's
     flag, it roughly doubles the wait, and it widens what a question can reach
     out and touch. */
  remote: false,
  remoteAnnounce: true,
  remoteTimeoutMs: 30000,
  remoteWebSearch: false,

  /* How many questions went out today, per day. Observed rather than chosen,
     like modelStats above: it is what the daily cap counts against, and a cap
     that reset every time the app restarted would not be a cap. Written by the
     app, not by you. */
  remoteCallsToday: {},

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
  dropGlossaryEcho: true,

  /* A record of how each question was answered, written to routing.log beside
     this file.

     Off, and worth having at all because the interesting failures are not
     reproducible from the outside. "It went to Claude and it should not have"
     and "it should have gone to Claude and did not" look identical on the
     strip: an answer, in a voice. Which rule fired, what the local model
     actually said, and how long each leg took are the only things that settle
     it — and an app launched from the Dock has nowhere to print them, since
     its stdout goes to a terminal nobody opened.

     A line per question, JSON, appended, and capped so a flag left on does not
     quietly fill the disk. Questions and answers are in it, which is the point
     and also the reason it is off unless you turn it on. */
  debugRouting: false
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
  // A model belongs to whoever thinks with it. What used to be one setting for
  // all of them becomes each of theirs, and then stops being a setting.
  settings.agents = migrateModels(settings.agents, saved && saved.assistModel)
  /* A file written before agents knew about providers describes agents that
     think on this machine, which is exactly what normalizeAgent fills in for
     one that does not say: provider 'local', escalating to nobody. So the
     migration is that nothing is asked of anyone — the fields appear, already
     saying what was already true. */
  delete settings.wakeWord
  delete settings.assistModel
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
