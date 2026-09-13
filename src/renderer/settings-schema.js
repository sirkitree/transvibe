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
 * `spoken` is the other half of the same idea, for the voice: the names you
 * would actually call a setting out loud, so "turn off spoken replies" can be
 * parsed against the schema instead of against a second hand-written list. A
 * field without one is not reachable by voice, which is the right answer for
 * the free-text and path settings — a misheard wake phrase would cost you the
 * way back in, and nobody says "gemma4:e2b" out loud.
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

/** Keys with an editor of their own, for the same reason: `agents` is a list
    of records — a name, what it does, the voice it says it in — and no row in
    a settings panel can express that. The agents panel edits it instead. */
export const PANEL_KEYS = ['agents']

/** Keys nobody sets, only ends up with. A panel's position is remembered from
    having been dragged there; a row offering to type it in would be a worse
    way to do the same thing. How long each model took to answer is the same
    kind of thing — observed, not chosen, and shown where it is useful, which
    is next to the model rather than in a row of its own. So is the tally of
    how many questions went out to a frontier model today: it is counted, not
    set, and the number you would want to change is the switch above it. */
export const REMEMBERED_KEYS = [
  'panelPosition', 'orbPosition', 'modelStats', 'remoteCallsToday', 'routingStats'
]

export const SECTIONS = [
  {
    title: 'Listening',
    note: 'What counts as speech, when an utterance is over, and what is thrown away rather than written down. These are the settings you tune by talking and watching.',
    fields: [
      {
        key: 'voiceIsolation', label: 'Voice isolation', type: 'toggle', restart: true,
        spoken: ['voice isolation'],
        help: 'Ask the microphone to emphasize your voice and suppress background sound. Availability depends on the microphone and platform. Debug recordings report whether it actually activated.'
      },
      {
        key: 'threshold',
        label: 'Speech threshold',
        help: 'Raise it in a noisy room, lower it if quiet speech is missed.',
        spoken: ['the threshold', 'the speech threshold', 'the sensitivity'],
        type: 'range', min: 0.002, max: 0.08, step: 0.002, decimals: 3
      },
      {
        key: 'conversationHangoverMs',
        label: 'Silence before a conversation turn ends',
        help: 'Keeps pauses inside a question together while talking to an agent. At least as long as the normal silence window.',
        spoken: ['the conversation silence'],
        type: 'range', min: 550, max: 2000, step: 50, unit: 'ms'
      },
      {
        key: 'wakeConfidenceFloor',
        label: 'Confidence for a short wake phrase',
        help: 'A separate floor for exact configured multiword names, after speech detection. Does not relax commands or ordinary dictation.',
        spoken: ['the wake confidence'],
        type: 'range', min: -1, max: -0.1, step: 0.05, decimals: 2
      },
      {
        key: 'minSegmentMs',
        label: 'Minimum speech duration',
        help: 'Shorter keeps quick wake phrases. Longer rejects more brief noises.',
        spoken: ['the minimum speech duration'],
        type: 'range', min: 100, max: 1000, step: 50, unit: 'ms'
      },
      {
        key: 'hangoverMs',
        label: 'Silence before an utterance ends',
        help: 'Longer keeps a sentence together across a pause for breath.',
        // Not 'the pause': 'pause' is already a command, and an alias that
        // shadows one would be a command that stopped working.
        spoken: ['the hangover', 'the silence', 'the silence window', 'when an utterance ends'],
        type: 'range', min: 150, max: 2000, step: 50, unit: 'ms'
      },
      {
        key: 'vad',
        label: 'Ignore anything that is not speech',
        help: 'A small speech detector listens before the recogniser does, and music, a fan or a passing car never reach it at all. Off falls back to judging the words after they arrive, which catches less. Restarts the recogniser.',
        spoken: ['speech detection', 'the speech detector', 'the noise gate'],
        type: 'toggle'
      },
      {
        key: 'vadThreshold',
        label: 'How sure the detector has to be',
        help: 'Higher ignores more of the room and starts costing you quiet or distant speech. 0.5 is the default and where this was measured.',
        spoken: ['the detector threshold', 'how sure the detector has to be'],
        type: 'range', min: 0.1, max: 0.9, step: 0.05, decimals: 2
      },
      {
        key: 'confidenceFloor',
        label: 'Ignore anything less certain than',
        help: 'Whisper says how sure it was. Real speech scores about -0.05; music, a fan or a passing car score about -0.7, which is how music playing in the room turns into words. Lower is more permissive; all the way right turns the check off.',
        spoken: ['the confidence floor', 'the confidence', 'how certain it has to be'],
        type: 'range', min: -1, max: 0, step: 0.05, decimals: 2, zero: 'off'
      },
      {
        key: 'dropGlossaryEcho',
        label: 'Drop utterances that are only glossary words',
        spoken: ['the glossary echo', 'glossary echo'],
        help: 'Glossary terms are fed to the recogniser as it listens, and over noise it sometimes hands them straight back. Turn this off if you need to dictate a single glossary term on its own.',
        type: 'toggle'
      },
    ]
  },
  {
    title: 'Agents',
    custom: 'agents',
    note: 'Who you can talk to. Say a name at the start of a sentence and the rest of it is addressed to that one, in its own voice and its own colour — or hold right ⌥ / press ⌃⌥C, which addresses whoever runs commands.',
    links: [['Keys & commands', 'help']],
    fields: [
      {
        group: 'Hearing a name',
        key: 'wakeWordFuzzy',
        label: 'Forgive near-misses in a name',
        help: 'A small model hears an unusual name loosely — "hey cloud" still counts as "hey claude". A name heard exactly always wins over one heard nearly, and two names equally close match nothing at all.',
        spoken: ['fuzzy matching', 'near misses', 'forgiving the wake phrase'],
        type: 'toggle'
      },
      {
        group: 'Hearing a name',
        key: 'commandTimeoutMs',
        label: 'Command mode disarms after',
        help: 'After ⌃⌥C, or after the name of an agent that runs commands said on its own.',
        spoken: ['the command timeout', 'the timeout'],
        type: 'range', min: 1000, max: 20000, step: 500, unit: 'ms'
      },
      {
        group: 'Hearing a name',
        key: 'conversationMs',
        label: 'A conversation stays open for',
        help: 'Starts when the agent finishes speaking and the microphone reopens. The next thing you say is a follow-up and needs no name. With spoken replies off, starts when the answer appears. All the way left means every turn is addressed by name.',
        spoken: ['the conversation window', 'the conversation timeout'],
        type: 'range', min: 0, max: 120000, step: 5000, unit: 'ms', zero: 'off'
      },
      {
        group: 'How they answer',
        key: 'speakReplies',
        label: 'Say what it just did',
        spoken: ['spoken replies', 'replies', 'talking back', 'speaking'],
        type: 'toggle'
      },
      {
        group: 'How they answer',
        key: 'speakVoice',
        label: 'Default voice',
        spoken: ['the voice', 'the default voice', 'your voice'],
        help: 'Only for agents that have not been given a voice of their own — each one is set in the Agents tab, and saying “change your voice to Karen” changes whoever you are addressing rather than this. The English voices installed on this Mac — the replies are written in English, so the rest are not offered. More can be added in System Settings › Accessibility › Spoken Content, and they show up here without a restart.',
        type: 'select', options: 'voices', nullable: true, missingSuffix: '— not installed'
      },
      {
        group: 'How they answer',
        key: 'speakRate',
        label: 'Default speaking rate',
        help: 'Words per minute, for agents that have not been given a pace of their own. All the way left leaves the voice at its own.',
        spoken: ['the speaking rate', 'the rate', 'how fast you talk'],
        // `base` is where "speak faster" starts from when the rate is still
        // the voice's own: roughly what macOS speaks at, so the first nudge
        // is a nudge rather than a lurch down to 40 words a minute.
        type: 'range', min: 0, max: 400, step: 10, unit: ' wpm', zero: 'the voice’s own', base: 180
      },
    ]
  },
  {
    title: 'Reaching out',
    note: 'What happens when the local model does not know. Off, every answer is thought up on this Mac by a small model that sometimes says so. On, a question a chat agent could not answer can be handed to `claude` or `codex` — the CLIs you are already signed in to, so it bills against that subscription rather than an API key.',
    fields: [
      {
        key: 'remote',
        label: 'Ask a frontier model when the local one cannot answer',
        // The one row in this panel where the honest help text is a privacy
        // note, so it says the whole shape of it: what goes, what never does,
        // and where it ends up. Nobody should have to read config.js to find
        // out that this is the switch.
        help: 'This is the only setting that sends anything off this machine. What goes is the sentence you addressed to a chat agent and that conversation’s own history — nothing else, and only when the local model gave up or said it was unsure. Dictation never goes: tidying text and guessing at a command stay local whatever this says, because a room microphone hears things nobody meant to send anywhere.',
        spoken: ['reaching out', 'the frontier model', 'escalation', 'asking a frontier model'],
        type: 'toggle'
      },
      {
        key: 'remoteAnnounce',
        label: 'Say which model answered',
        help: 'An escalated answer arrives as “Claude said, …” rather than in the agent’s own voice as if it had known all along. Two words for knowing which answers left the machine.',
        spoken: ['announcing', 'saying who answered', 'the attribution'],
        type: 'toggle'
      },
      {
        key: 'remoteWebSearch',
        label: 'Let codex search the web',
        help: 'Only codex can; claude reaches nothing live. It roughly doubles the wait — 8.7s becomes 14.1s, measured — and it is what makes a question about today answerable at all, which is why a question about the latest anything skips the local model entirely when this is on.',
        spoken: ['web search', 'searching the web', 'looking things up'],
        type: 'toggle'
      },
      {
        key: 'remoteTimeoutMs',
        label: 'Give up on a frontier model after',
        help: 'Measured, a trimmed claude answers in 2.7s and codex with web search in 14.1s, so the default is the point at which something has gone wrong rather than the point at which it is slow. The local answer, if there was one, is what you get instead.',
        spoken: ['the remote timeout', 'how long to wait for a frontier model'],
        type: 'range', min: 5000, max: 120000, step: 5000, unit: 'ms'
      },
    ]
  },
  {
    title: 'Transcription',
    note: 'What turns the sound into text. All of it runs on this Mac, and the glossary is where you teach it the words it has never seen.',
    links: [['Glossary', 'glossary']],
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
        key: 'interimMs',
        label: 'Interim update every',
        help: 'How often the open utterance is re-transcribed so text appears while you talk. Shorter costs more CPU.',
        spoken: ['the interim', 'the interim update'],
        type: 'range', min: 200, max: 2000, step: 100, unit: 'ms'
      },
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
      {
        key: 'spacesDir',
        label: 'Space markers folder',
        help: 'A folder of "<Name> Space.app" marker apps. Naming it makes "switch to <name>" a command. Empty means no Spaces are named.',
        type: 'text', placeholder: '~/repos/space-markers', nullable: true
      },
      {
        key: 'sendPressesEnter',
        label: 'Press Return after pasting',
        spoken: ['return after pasting', 'pressing return', 'the return key'],
        type: 'toggle'
      },
      {
        key: 'clearAfterSend',
        label: 'Clear the transcript after sending',
        spoken: ['clearing after sending', 'clear after send'],
        type: 'toggle'
      },
      {
        key: 'autoCopy',
        label: 'Copy every utterance to the clipboard',
        help: 'Without sending anything. Settled text only, never an interim pass.',
        spoken: ['auto copy', 'automatic copying', 'copying everything'],
        type: 'toggle'
      },
    ]
  },
  {
    title: 'Visuals',
    note: 'The strip has no window: it hangs off the top of the screen and every click lands in whatever is behind it, until the pointer rests on it. Below that, the visualizer — which one is running, and then the dials belonging to whichever it is.',
    fields: [
      {
        key: 'alwaysOnTop',
        label: 'Float above full-screen apps',
        spoken: ['always on top', 'floating on top'],
        type: 'toggle'
      },
      {
        key: 'wakeDelayMs',
        label: 'Pointer must rest for',
        help: 'Before the strip stops being click-through. Long enough that sweeping to a menu never catches it.',
        spoken: ['the pointer delay', 'the hover delay'],
        type: 'range', min: 0, max: 1000, step: 20, unit: 'ms'
      },
      {
        key: 'idleFadeMs',
        label: 'Transcript fades after',
        help: 'It stays in memory — ⌃⌥↩ still sends a faded transcript.',
        spoken: ['the fade', 'the fade delay', 'when text fades', 'when text disappears', 'when the text goes away'],
        type: 'range', min: 1000, max: 60000, step: 1000, unit: 'ms'
      },
      {
        key: 'idleClearMs',
        label: 'Transcript is forgotten after',
        spoken: ['the forget delay', 'forgetting', 'when text is forgotten', 'when text is thrown away'],
        help: 'The mic hears music and people walking in too. A faded transcript nobody came back to is thrown away, undo included. All the way left keeps it until you clear it.',
        type: 'range', min: 0, max: 300000, step: 5000, unit: 'ms', zero: 'never'
      },
      {
        group: 'Size',
        key: 'stripHeight',
        label: 'Minimum strip height',
        help: 'The strip measures its own contents and grows past this to fit them.',
        spoken: ['the strip height'],
        type: 'range', min: 90, max: 400, step: 10, unit: 'px'
      },
      {
        group: 'Size',
        key: 'panelHeight',
        label: 'Height with a panel open',
        spoken: ['the panel height'],
        type: 'range', min: 320, max: 900, step: 20, unit: 'px'
      },
      {
        group: 'The visualizer',
        key: 'layout',
        label: 'Which one',
        help: 'The ribbon runs along the top of the strip. The orb is a round one in its own small window in the lower-left corner of the screen, and it carries everything the ribbon does — command mode, whose voice is answering — including the app’s own speech, which becomes a smaller ring turning the other way inside it.',
        spoken: ['the layout', 'the visualizer'],
        type: 'select',
        // The one select whose choices are the schema's own. A voice, or a
        // whisper model, is whatever this Mac happens to have; there are two
        // visualizers and there will be two of them tomorrow.
        options: 'choices',
        choices: [
          { value: 'strip', label: 'Ribbon on the strip' },
          { value: 'orb', label: 'Orb in the corner' }
        ]
      },
      /* With the chooser, not under either of the headings below it: these
         two pace whichever one is running, the orb's signal from the strip
         included. The panel has one level of heading, so the hierarchy is
         carried by what each says and by which of them are on screen —
         "the visualizer" owns the choice and what is true of both, and the
         heading under it names the one you actually picked. */
      {
        group: 'The visualizer',
        key: 'vizFps',
        label: 'Frames per second',
        help: 'Whichever visualizer is running. The single biggest thing either of them costs.',
        spoken: ['the frame rate', 'frames per second'],
        type: 'range', min: 10, max: 60, step: 5
      },
      {
        group: 'The visualizer',
        key: 'vizQuietFps',
        label: 'Frames per second when quiet',
        help: 'A silent room does not need a smooth animation.',
        spoken: ['the quiet frame rate'],
        type: 'range', min: 1, max: 30, step: 1
      },
      {
        group: 'The ribbon',
        showWhen: { layout: 'strip' },
        key: 'vizLinesPerFamily',
        label: 'Lines per hue family',
        spoken: ['the line count', 'lines per family'],
        type: 'range', min: 4, max: 40, step: 2
      },
      {
        group: 'The ribbon',
        showWhen: { layout: 'strip' },
        key: 'vizPoints',
        label: 'Points per line',
        spoken: ['the point count', 'points per line'],
        type: 'range', min: 60, max: 400, step: 20
      },
      {
        group: 'The orb',
        showWhen: { layout: 'orb' },
        key: 'orbSize',
        // Under "The orb", "Orb size" is the word twice.
        label: 'Size',
        help: 'Its window is a square this many points on a side, and shrinks to fit a display too small for it.',
        spoken: ['the orb size', 'how big the orb is'],
        type: 'range', min: 120, max: 600, step: 20, unit: 'px'
      },
      {
        group: 'The orb',
        showWhen: { layout: 'orb' },
        key: 'orbMargin',
        label: 'Distance from the corner',
        spoken: ['the orb margin', 'the orb inset'],
        type: 'range', min: 0, max: 120, step: 4, unit: 'px'
      },
      {
        group: 'The orb',
        showWhen: { layout: 'orb' },
        key: 'orbSeeds',
        label: 'Filaments',
        help: 'Each one is drawn twice — once mirrored through the centre — so this is half the stroke count. The dial to turn down first if the orb costs more than the ribbon did.',
        spoken: ['the filament count', 'the filaments'],
        type: 'range', min: 24, max: 240, step: 8
      },
      {
        group: 'The orb',
        showWhen: { layout: 'orb' },
        key: 'orbSteps',
        label: 'Filament length',
        help: 'How far a filament walks away from the ring. Length varies around the ring anyway; this is the longest one.',
        spoken: ['the filament length'],
        type: 'range', min: 4, max: 40, step: 2
      },
      {
        group: 'The orb',
        showWhen: { layout: 'orb' },
        key: 'orbSayScale',
        label: 'Inner ring size',
        help: 'The app’s own voice, as a fraction of the orb it sits inside.',
        spoken: ['the inner ring', 'the inner ring size'],
        type: 'range', min: 0.15, max: 0.7, step: 0.05, decimals: 2
      },
      {
        group: 'The orb',
        showWhen: { layout: 'orb' },
        key: 'orbZoomGain',
        label: 'How far sound opens it',
        spoken: ['the zoom', 'the orb zoom'],
        help: 'The whole figure breathes outward when the room does. All the way left holds it still; far right will push the longest filaments past the edge of its window.',
        type: 'range', min: 0, max: 3, step: 0.1, decimals: 1, zero: 'still'
      },
      {
        group: 'The orb',
        showWhen: { layout: 'orb' },
        key: 'orbZoomDecay',
        label: 'How fast it closes again',
        spoken: ['the zoom decay', 'how fast the orb closes'],
        type: 'range', min: 0.01, max: 0.4, step: 0.01, decimals: 2
      }
    ]
  },
  {
    title: 'Advanced',
    note: 'The plumbing. Sensible left alone, and worth a look when something is not behaving. Which local model does the thinking is each agent’s own, in the Agents tab — dictation, which is addressed to nobody, uses the one belonging to whoever runs commands.',
    fields: [
      {
        key: 'cleanup',
        label: 'Tidy fillers out of settled text',
        spoken: ['cleanup', 'tidying'],
        type: 'toggle'
      },
      {
        key: 'commandFallback',
        label: 'Guess what an unrecognised command meant',
        spoken: ['the command fallback', 'guessing at commands'],
        type: 'toggle'
      },
      { key: 'assistUrl', label: 'Ollama at', type: 'text', placeholder: 'http://127.0.0.1:11434' },
      {
        key: 'debugRecording',
        label: 'Record audio and conversations for debugging',
        help: 'Saves microphone audio, transcripts and replies locally in Application Support/transvibe/recordings. Includes room audio while listening, even during replies. Pause listening to pause audio; switch this off to finish the session. About 115 MB per hour. Recording continues across app restarts until switched off.',
        spoken: ['debug recording', 'conversation recording'],
        type: 'toggle'
      },
      {
        key: 'debugRouting',
        label: 'Write a log of how each question was answered',
        help: 'For working out why an answer came from where it did. A line per question in routing.log, next to settings.json — the question, what the local model said, which rule sent it on, and how long each leg took. It holds what you asked and what you were told, so leave it off unless you are chasing something.',
        spoken: ['the routing log', 'the debug log'],
        type: 'toggle'
      },
      {
        key: 'launchAtLogin',
        label: 'Launch transvibe at login',
        help: 'Kept by macOS in Login Items, not in settings.json.',
        spoken: ['launch at login', 'launching at login', 'starting at login'],
        type: 'toggle', external: true
      },
    ]
  }
]

/**
 * A value as the panel and the voice both say it: `350ms`, `0.020`, `24`.
 *
 * Shared rather than duplicated because the two must agree — a slider reading
 * "6000ms" while the app says "six seconds" is two answers to one question.
 * A range whose bottom end means "off" says so in words: `0ms` reads like a
 * timer set to fire instantly, which is the opposite of what it does.
 */
export function formatValue (field, value) {
  if (field.type === 'toggle') return value ? 'on' : 'off'
  if (field.type !== 'range') return value == null || value === '' ? 'unset' : String(value)
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  if (n === 0 && field.zero) return field.zero
  /* A minute in milliseconds is 60000, and reading that as a duration means
     counting zeroes. Past a second it is written as seconds, which is how the
     value was thought of before it was typed. */
  if (field.unit === 'ms' && n >= 1000) {
    return `${Number((n / 1000).toFixed(1))}s`
  }
  const text = field.decimals != null ? n.toFixed(field.decimals) : String(n)
  return field.unit ? `${text}${field.unit}` : text
}

/** Flat view of every field, in panel order. */
export const FIELDS = SECTIONS.flatMap(s => s.fields)

/** @returns {string[]} the settings keys the panel edits. */
export const editableKeys = () => FIELDS.map(f => f.key)

/**
 * Coerce what an input element gives back into what the setting wants.
 * Numbers arrive as strings; a cleared text field means "unset" for the two
 * settings that are meaningfully null (no forced target app, no pinned model).
 */
/**
 * Whether a field is worth showing, given what the settings currently say.
 *
 * The two visualizers have four dials each and only one of them is running.
 * Showing both sets means eight sliders, half of which do nothing you can see
 * — and a slider that does nothing when you drag it is worse than one that is
 * not there, because you have to work out which it was.
 *
 * Only the panel hides them. They stay in the file, stay reachable by voice,
 * and are still checked against `config.js` by the schema test: this is about
 * what is on screen, not about what exists.
 */
export function fieldApplies (field, settings) {
  const when = field && field.showWhen
  if (!when) return true
  const current = settings && typeof settings === 'object' ? settings : {}
  return Object.entries(when).every(([key, want]) => (
    Array.isArray(want) ? want.includes(current[key]) : current[key] === want
  ))
}

/**
 * A spoken value against a select's own choices: "change the visualizer to
 * orb", "make the visualizer the ribbon".
 *
 * The other selects resolve against the machine — the voices installed, the
 * models on disk — and the caller does that. This one is answerable from the
 * schema, so it is answered here and tested without a Mac in the room.
 *
 * @returns {string|undefined} the value to save, or undefined if nothing matched
 */
export function resolveChoice (field, heard) {
  if (!field || !Array.isArray(field.choices)) return undefined
  const want = String(heard ?? '').trim().toLowerCase().replace(/^(?:the|a|an) +/, '')
  if (!want) return undefined
  const exact = field.choices.find(c => String(c.value).toLowerCase() === want)
  if (exact) return exact.value
  // "the orb" against "Orb in the corner": the label is a sentence and what
  // was said is the word in it that means something.
  const named = field.choices.find(c => {
    const label = String(c.label).toLowerCase()
    return label === want || label.split(/\s+/).includes(want)
  })
  return named ? named.value : undefined
}

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
