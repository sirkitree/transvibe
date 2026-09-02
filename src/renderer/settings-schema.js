/**
 * What settings.json holds, described well enough to build a panel from.
 *
 * The file was the only way to change any of this, which meant knowing the key
 * names and what a plausible value looked like. Every key in DEFAULTS appears
 * here exactly once — a test enforces that in both directions, so a setting
 * added to config.js without a row here is caught rather than quietly
 * unreachable.
 *
 * Two keys are deliberately absent: `vocabulary` and `corrections` already
 * have the glossary panel, which is a far better editor for them than a text
 * field could be. The panel links there instead.
 *
 * `restart: true` marks the settings that only take hold when the app starts —
 * the ones baked into the transcription engine. Everything else is applied to
 * the running app the moment it changes, which is why the panel is worth
 * having at all: threshold and fade delay are settings you tune by watching
 * the effect, not by editing a file and relaunching.
 */

/**
 * Keys that are not in settings.json at all. `launchAtLogin` is macOS's, held
 * in its Login Items list; the panel shows it beside the rest because that is
 * where someone would look for it, and reads and writes it through its own
 * channel rather than pretending the file holds it.
 */
export const EXTERNAL_KEYS = ['launchAtLogin']

/** Keys the glossary panel owns; not shown here. */
export const GLOSSARY_KEYS = ['vocabulary', 'corrections']

export const SECTIONS = [
  {
    title: 'Listening',
    note: 'What counts as speech, and when an utterance is over. These three decide whether a pause for breath is the end of a sentence.',
    fields: [
      {
        key: 'threshold',
        label: 'Speech threshold',
        help: 'Raise it in a noisy room, lower it if quiet speech is missed.',
        type: 'range', min: 0.002, max: 0.08, step: 0.002, decimals: 3
      },
      {
        key: 'hangoverMs',
        label: 'Silence before an utterance ends',
        help: 'Longer keeps a sentence together across a pause for breath.',
        type: 'range', min: 150, max: 2000, step: 50, unit: 'ms'
      },
      {
        key: 'interimMs',
        label: 'Interim update every',
        help: 'How often the open utterance is re-transcribed so text appears while you talk. Shorter costs more CPU.',
        type: 'range', min: 200, max: 2000, step: 100, unit: 'ms'
      }
    ]
  },
  {
    title: 'Transcription',
    note: 'What turns the audio into words. All of it runs on this Mac.',
    fields: [
      {
        key: 'modelPath',
        label: 'Speech model',
        help: 'Every whisper model found on this Mac, including ones other apps downloaded. Bigger is more accurate and slower.',
        type: 'select', options: 'models', nullable: true, restart: true
      },
      {
        key: 'language',
        label: 'Language',
        help: 'Two-letter code the model decodes with.',
        type: 'text', placeholder: 'en', restart: true
      },
      {
        key: 'dropGlossaryEcho',
        label: 'Drop utterances that are only glossary words',
        help: 'Glossary terms are fed to the recogniser as it listens, and over noise it sometimes hands them straight back. Turn this off if you need to dictate a single glossary term on its own.',
        type: 'toggle'
      }
    ]
  },
  {
    title: 'Sending',
    note: 'Where the transcript goes when you send it, and what happens to it afterwards.',
    fields: [
      {
        key: 'sendTarget',
        label: 'Always send to',
        help: 'An app name to focus before pasting. Empty means whatever is in front.',
        type: 'text', placeholder: 'frontmost app', nullable: true
      },
      { key: 'sendPressesEnter', label: 'Press Return after pasting', type: 'toggle' },
      { key: 'clearAfterSend', label: 'Clear the transcript after sending', type: 'toggle' },
      {
        key: 'autoCopy',
        label: 'Copy every utterance to the clipboard',
        help: 'Without sending anything. Settled text only, never an interim pass.',
        type: 'toggle'
      }
    ]
  },
  {
    title: 'Command mode',
    note: 'Hold right ⌥ or press ⌃⌥C and the next thing you say is a command rather than dictation. Or open the sentence with the wake phrase and skip the keyboard entirely.',
    fields: [
      {
        key: 'wakeWord',
        label: 'Wake phrase',
        help: 'Say this at the start of a sentence and the rest of it is a command. Empty turns it off.',
        type: 'text', placeholder: 'hey claude', nullable: true
      },
      {
        key: 'wakeWordFuzzy',
        label: 'Forgive near-misses in the wake phrase',
        help: 'A small model hears an unusual name loosely — "hey cloud" still counts.',
        type: 'toggle'
      },
      {
        key: 'commandTimeoutMs',
        label: 'Disarms after',
        help: 'After ⌃⌥C, or after the wake phrase said on its own.',
        type: 'range', min: 1000, max: 20000, step: 500, unit: 'ms'
      }
    ]
  },
  {
    title: 'Spoken replies',
    note: 'After a command runs, the app says what it did. You are looking at the app you are dictating into, not at the strip, which is the whole reason the wake phrase exists — so the answer comes back the same way you asked. The microphone stops listening for as long as the reply takes, so it never transcribes itself.',
    fields: [
      { key: 'speakReplies', label: 'Say what it just did', type: 'toggle' },
      {
        key: 'speakVoice',
        label: 'Voice',
        help: 'The English voices installed on this Mac — the replies are written in English, so the rest are not offered. More can be added in System Settings › Accessibility › Spoken Content, and they show up here without a restart.',
        type: 'select', options: 'voices', nullable: true, missingSuffix: '— not installed'
      },
      {
        key: 'speakRate',
        label: 'Speaking rate',
        help: 'Words per minute. All the way left leaves the voice at its own pace.',
        type: 'range', min: 0, max: 400, step: 10, unit: ' wpm', zero: 'the voice’s own'
      }
    ]
  },
  {
    title: 'The strip',
    note: 'The strip has no window. It hangs off the top of the screen and every click lands in whatever is behind it, until the pointer rests on it.',
    fields: [
      {
        key: 'wakeDelayMs',
        label: 'Pointer must rest for',
        help: 'Before the strip stops being click-through. Long enough that sweeping to a menu never catches it.',
        type: 'range', min: 0, max: 1000, step: 20, unit: 'ms'
      },
      {
        key: 'idleFadeMs',
        label: 'Transcript fades after',
        help: 'It stays in memory — ⌃⌥↩ still sends a faded transcript.',
        type: 'range', min: 1000, max: 60000, step: 1000, unit: 'ms'
      },
      {
        key: 'idleClearMs',
        label: 'Transcript is forgotten after',
        help: 'The mic hears music and people walking in too. A faded transcript nobody came back to is thrown away, undo included. All the way left keeps it until you clear it.',
        type: 'range', min: 0, max: 300000, step: 5000, unit: 'ms', zero: 'never'
      },
      { key: 'alwaysOnTop', label: 'Float above full-screen apps', type: 'toggle' },
      {
        key: 'stripHeight',
        label: 'Minimum strip height',
        help: 'The strip measures its own contents and grows past this to fit them.',
        type: 'range', min: 90, max: 400, step: 10, unit: 'px'
      },
      {
        key: 'panelHeight',
        label: 'Height with a panel open',
        type: 'range', min: 320, max: 900, step: 20, unit: 'px'
      }
    ]
  },
  {
    title: 'Visualizer',
    note: 'The ribbon costs more in compositing than in strokes, so the frame rate is the dial that matters.',
    fields: [
      { key: 'vizFps', label: 'Frames per second', type: 'range', min: 10, max: 60, step: 5 },
      {
        key: 'vizQuietFps',
        label: 'Frames per second when quiet',
        help: 'A silent room does not need a smooth animation.',
        type: 'range', min: 1, max: 30, step: 1
      },
      { key: 'vizLinesPerFamily', label: 'Lines per hue family', type: 'range', min: 4, max: 40, step: 2 },
      { key: 'vizPoints', label: 'Points per line', type: 'range', min: 60, max: 400, step: 20 }
    ]
  },
  {
    title: 'Assist model',
    note: 'Optional, and still on this machine — an Ollama model asked to tidy text or to guess at a command it did not recognise. Each adds a few hundred milliseconds after an utterance settles. Both are off until you turn them on.',
    fields: [
      { key: 'cleanup', label: 'Tidy fillers out of settled text', type: 'toggle' },
      { key: 'commandFallback', label: 'Guess what an unrecognised command meant', type: 'toggle' },
      {
        key: 'assistModel',
        label: 'Assist model',
        help: 'What Ollama has pulled on this machine. Nothing to do with the speech model above — this one only ever sees text.',
        type: 'select', options: 'ollama', missingSuffix: '— not pulled'
      },
      { key: 'assistUrl', label: 'Ollama at', type: 'text', placeholder: 'http://127.0.0.1:11434' }
    ]
  },
  {
    title: 'System',
    fields: [
      {
        key: 'launchAtLogin',
        label: 'Launch transvibe at login',
        help: 'Kept by macOS in Login Items, not in settings.json.',
        type: 'toggle', external: true
      }
    ]
  }
]

/** Flat view of every field, in panel order. */
export const FIELDS = SECTIONS.flatMap(s => s.fields)

/** @returns {string[]} the settings keys the panel edits. */
export const editableKeys = () => FIELDS.map(f => f.key)

/**
 * Coerce what an input element gives back into what the setting wants.
 * Numbers arrive as strings; a cleared text field means "unset" for the two
 * settings that are meaningfully null (no forced target app, no pinned model).
 */
export function coerce (field, raw) {
  if (field.type === 'toggle') return !!raw
  if (field.type === 'range') {
    const n = Number(raw)
    return Number.isFinite(n) ? n : undefined
  }
  // A select's values are exact paths — trimming one would be a way to break
  // a filename that legitimately ends in a space.
  if (field.type === 'select') return raw === '' ? (field.nullable ? null : undefined) : raw
  const text = String(raw).trim()
  if (!text) return field.nullable ? null : undefined
  return text
}
