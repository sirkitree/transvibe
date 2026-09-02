import { startCapture } from './audio.js'
import { createVisualizer } from './visualizer.js'
import { parseCommand, applyCommand, spokenFor, splitChain, COMMANDS } from './commands.js'
import { splitWakeWord } from './wake.js'
import { parseSettingCommand, applySettingCommand, settingPhrases } from './settings-voice.js'
import { FIELDS } from './settings-schema.js'
import {
  addTerms, removeTerm, addCorrection, removeCorrection, sortedEntries, splitWords
} from './glossary-edit.js'
import { applyCorrections } from '../shared/glossary.js'
import { createPresence } from './presence.js'
import { createSettingsPanel } from './settings-panel.js'

const $ = id => document.getElementById(id)
// Breathing room under the last thing on the strip, so nothing sits flush
// against the window edge.
const BOTTOM_MARGIN = 18
const transcriptEl = $('transcript')
const hintEl = $('hint')

const state = {
  finals: [],
  live: '',          // interim text for the utterance still being spoken
  liveSeq: 0,        // guards against a slow interim landing after a newer one
  interimBusy: false,
  commandMode: false,
  undoStack: [],
  pending: 0,
  listening: true,
  settings: null,
  capture: null,
  viz: null,
  // The word fixer's checkboxes, remembered across opens: whoever turns
  // 'remember' off is usually making a run of one-off fixes, not one.
  fixRemember: true,
  fixListen: true,
  awake: false,
  presence: null,
  // How many spoken replies are in flight. A count rather than a flag: two
  // commands in quick succession must not have the first one's reply un-deafen
  // the microphone while the second is still talking.
  deaf: 0,
  // The open utterance starts with the wake phrase: the strip goes amber
  // while you are still speaking, so you can see it landed before you commit
  // to the rest of the sentence.
  liveWake: false
}

let hintTimer = null
let status = ''          // the last real message, restored after a hover

/* The status line is normally invisible. Showing it for a moment when it
   changes is the compromise: you see 'sent to Safari' or an error, and then
   the strip goes back to being nothing but a ribbon. */
function hint (text) {
  status = text
  hintEl.textContent = text
  hintEl.classList.add('flash')
  clearTimeout(hintTimer)
  hintTimer = setTimeout(() => hintEl.classList.remove('flash'), 2600)
}

/* Hovering a button borrows the status line to describe it. There is already a
   line of text under the buttons saying what the app is doing; a second
   floating tooltip on a transparent overlay would be one thing too many, so
   the description takes that line over and hands it straight back. */
function describe (text) {
  hintEl.textContent = text ?? status
  hintEl.classList.toggle('describe', text != null)
}

function wireButtonHints () {
  for (const btn of document.querySelectorAll('.btn')) {
    btn.addEventListener('mouseenter', () => describe(hintFor(btn)))
    btn.addEventListener('mouseleave', () => describe(null))
    // A click can change what the button now means — pause becomes resume.
    // Deferred by a tick so it reads the state the click produced, not the
    // one it started from.
    btn.addEventListener('click', () => setTimeout(() => describe(hintFor(btn)), 0))
  }
}

function hintFor (btn) {
  if (btn.id === 'mute') return state.listening ? 'Pause listening' : 'Resume listening'
  return btn.dataset.hint || ''
}

/* Each final is rendered word by word so a single word can be clicked and
   corrected. The gaps between words are kept verbatim, so the transcript still
   copies out exactly as it read. */
function finalNode (text) {
  const span = document.createElement('span')
  span.className = 'final'
  for (const part of splitWords(text + ' ')) {
    if (!part.word) { span.append(part.text); continue }
    const word = document.createElement('span')
    word.className = 'w'
    word.textContent = part.text
    span.append(word)
  }
  return span
}

function render () {
  transcriptEl.replaceChildren(...state.finals.map(finalNode))
  if (state.live || state.pending > 0) {
    const live = document.createElement('span')
    live.className = 'live'
    live.textContent = state.live || '…'
    transcriptEl.append(live)
  }
  // The scrim behind the text only exists while there is text, so the strip is
  // genuinely empty — not a faint rectangle — when nothing has been said.
  document.body.classList.toggle('has-text', transcriptEl.childElementCount > 0)
  document.body.classList.toggle('command-mode', state.commandMode || state.liveWake)
  syncHeight()
  // The newest line is the one worth seeing; the older ones scroll off the top.
  transcriptEl.scrollTop = transcriptEl.scrollHeight
}

function fullText () {
  return state.finals.join(' ').replace(/[^\S\n]+/g, ' ').trim()
}

function setText (text) {
  state.finals = text ? [text] : []
}

function setCommandMode (active) {
  state.commandMode = active
  if (!active) state.live = ''
  render()
}

/* What the assist model is allowed to answer with. The settings half is
   generated from the schema, so "make it stop talking to me" can land on
   "turn off spoken replies" without a rule for that phrasing, and a wrong
   answer still cannot name a setting the app does not have. */
const COMMAND_PHRASES = [
  ...COMMANDS.flatMap(c => c.examples),
  ...settingPhrases(FIELDS)
]

/* One spoken utterance, interpreted as an editing command rather than as text
   to insert. A parse failure must never silently swallow what was said. */
async function runCommand (utterance, { retry = true, keep = null, collect = null } = {}) {
  const cmd = parseCommand(utterance)

  /* Inside a chain the confirmations are gathered and said once at the end.
     Saying each one as it happens would not work anyway: a second `say`
     interrupts the first, so all you would hear is the last command. */
  const announce = line => { if (collect) collect.push(line); else say(line) }

  /* "change voice to Karen" is a replace as far as the editing rules are
     concerned — swap the word "voice" for the word "Karen" — and a settings
     command to everyone else. A sentence that names a setting is about that
     setting, so the settings reading wins over a replace, and only over a
     replace: every other command shape is unambiguous. */
  if (cmd && cmd.action === 'replace') {
    const named = parseSettingCommand(utterance, FIELDS)
    if (named && await runSettingCommand(named, { collect })) return
  }

  if (!cmd) {
    /* The other kind of command: one about the app rather than about the
       text. Tried after the editing rules, so nothing that already worked
       changes, and strict about naming a setting out loud — "turn off the
       lights" finds no setting and carries on down to being dictation. */
    const setting = parseSettingCommand(utterance, FIELDS)
    if (setting && await runSettingCommand(setting, { collect })) return

    // Two commands in one breath. Tried before the model is asked, and only
    // when the sentence made no sense as a single command.
    if (!collect && await runChain(utterance)) return

    console.info('[transvibe] unrecognised command:', JSON.stringify(utterance))

    /* The seam the rules leave open. The assist model does not invent a
       command — it picks one of the phrases the parser already understands,
       and that phrase goes back through the same parser, so a wrong answer
       can only ever produce a command the app implements. The key path is
       safe to ask from because command mode was armed deliberately; the wake
       phrase is a weaker signal, which is why that caller hands over a `keep`
       to put the words back if nothing lands. */
    if (retry && state.settings.commandFallback) {
      hint('working out what you meant…')
      const phrase = await window.transvibe.assistCommand(utterance, COMMAND_PHRASES)
      if (phrase) return runCommand(phrase, { retry: false, keep, collect })
    }

    /* Armed with a key, a miss is just a miss: you meant a command and it is
       better to be told than to have a stray sentence appear. Triggered by a
       wake phrase, the app is the one that decided this was a command, so it
       owes you the words back rather than eating them. */
    if (keep) {
      keep()
      hint(`not a command — kept "${utterance}"`)
      announce('kept as dictation')
      render()
      return
    }

    hint(`not a command: "${utterance}"`)
    announce(spokenFor(null))
    return
  }

  const before = fullText()
  const result = applyCommand(cmd, before)

  if (result.effect === 'undo') {
    const previous = state.undoStack.pop()
    if (previous === undefined) {
      announce('nothing to undo')
      return hint('nothing to undo')
    }
    setText(previous)
    hint('undone')
    announce(spokenFor(cmd, result))
    render()
    return
  }

  if (result.changed) {
    state.undoStack.push(before)
    if (state.undoStack.length > 20) state.undoStack.shift()
    setText(result.text)
  }

  // Said before the effect runs, not after: 'send' hands focus to another app
  // and never comes back here, and 'hide' takes the strip away, so a
  // confirmation queued behind either would be a confirmation of nothing.
  announce(spokenFor(cmd, result))

  switch (result.effect) {
    case 'copy': window.transvibe.copy(fullText()); break
    case 'send': doSend(); return
    case 'clear': state.undoStack.push(before); setText(''); break
    case 'pause': setListeningState(false); break
    case 'resume': setListeningState(true); break
    case 'hide': window.transvibe.hide(); break
    case 'settings': window.transvibe.openPanel('settings'); break
    case 'closePanel': closeOpenPanel(); break
  }

  hint(result.message)
  render()
}

/**
 * Two or three commands said in one breath: "open settings and change the
 * voice to Karen".
 *
 * All or nothing. The parts are checked before any of them runs, because "and"
 * is a word that turns up inside commands as well as between them — "replace
 * cat and dog with pets" splits into nonsense — and half a chain executed on a
 * misreading is worse than no chain at all. The whole sentence has already
 * failed to parse on its own by the time this is reached, so nothing that
 * worked before can end up here.
 *
 * @returns {Promise<boolean>} whether it was a chain and was run
 */
async function runChain (utterance) {
  const parts = splitChain(utterance)
  if (parts.length < 2) return false

  const parsed = parts.map(part => {
    const cmd = parseCommand(part)
    const setting = parseSettingCommand(part, FIELDS)
    // Same preference as a single command: naming a setting beats a replace.
    if (setting && (!cmd || cmd.action === 'replace')) return { part, setting }
    return cmd ? { part, cmd } : null
  })
  if (parsed.some(p => p === null)) return false

  const lines = []
  for (const step of parsed) {
    if (step.setting) await runSettingCommand(step.setting, { collect: lines })
    else await runCommand(step.part, { retry: false, collect: lines })
  }

  const said = lines.filter(Boolean)
  if (said.length) {
    hint(said.join(' · '))
    // Plain, and once: a joined line is not worth handing to the model, and
    // one `say` per part would cut each other off.
    say(said.join(', '), { plain: true })
  }
  return true
}

/* Change one setting, or say where it sits.
 *
 * Everything the panel does on a click, minus the click: write it, apply it
 * live, and re-read the panel if it happens to be open, so the slider is never
 * showing a value the app has already moved past.
 *
 * @returns {Promise<boolean>} false if the setting could not be acted on at
 *   all, which puts the utterance back on the unrecognised path rather than
 *   swallowing it.
 */
async function runSettingCommand (cmd, { collect = null } = {}) {
  const field = FIELDS.find(f => f.key === cmd.key)
  if (!field) return false
  const announce = line => { if (collect) collect.push(line); else say(line, { plain: true }) }

  /* A select's values belong to the machine, not the schema: "make the voice
     Karen" is only a command if this Mac has a Karen. */
  if (cmd.resolve === 'voices') {
    const name = await resolveVoiceName(cmd.value)
    if (!name) {
      hint(`no voice called "${cmd.value}"`)
      announce(`no voice called ${cmd.value}`)
      return true
    }
    cmd = { ...cmd, value: name }
  }

  const current = field.external
    ? await window.transvibe.getLaunchAtLogin()
    : state.settings[field.key]
  const result = applySettingCommand(cmd, field, current)

  if (result.changed) {
    if (field.external) await window.transvibe.setLaunchAtLogin(result.value)
    else state.settings = await window.transvibe.setSettings({ [field.key]: result.value })
    // The spoken confirmation is itself the preview when it is a voice or a
    // rate that just changed — it comes out in the new one — so the panel's
    // sample line would be the same sentence twice.
    const heard = state.settings.speakReplies &&
      (field.key === 'speakVoice' || field.key === 'speakRate')
    applyLiveSetting(field.key, { preview: !heard })
    if (openPanel() === 'settings') state.settingsPanel.render()
  }

  hint(result.message)
  // Said as written: a settings line carries a value, and the assist model
  // rephrasing it is how "the speaking rate is the voice's own" becomes
  // "voice is speaking".
  announce(result.message)
  return true
}

/* Voices are named, and names are misheard. An exact match first, then the
   first voice whose name starts with what was heard, so "Karen" finds Karen
   and "sam" finds Samantha rather than nothing. */
async function resolveVoiceName (heard) {
  const wanted = String(heard || '').trim().toLowerCase()
  if (!wanted) return null
  const voices = (await window.transvibe.listVoices())
    .filter(v => SPOKEN_LOCALE.test(v.locale))
  const exact = voices.find(v => v.name.toLowerCase() === wanted)
  if (exact) return exact.name
  const starts = voices.find(v => v.name.toLowerCase().startsWith(wanted))
  return starts ? starts.name : null
}

let setListeningState = () => {}

/* One settled utterance, appended as text. Text that has already faded is
   history: the strip shows what you would send, so a new utterance starts a
   new transcript rather than silently appending to something invisible. */
function dictate (text, wasStale) {
  if (wasStale) state.finals = []
  state.finals.push(text)
  tidy(text, state.finals.length - 1)
}

/* Something happened worth reading. Restarts the idle countdown and brings the
   transcript back if it had already faded out. */
function noteActivity () {
  if (!state.presence) return
  state.presence.activity(Date.now())
  applyFade()
}

/* Hand a settled utterance to the assist model and swap in the tidier version
   if one comes back. Deliberately fire-and-forget: the text is on screen the
   moment whisper produces it, and the rewrite lands a few hundred ms later or
   not at all. The index is re-checked before writing, because a clear, a
   command or a word fix may have moved on in the meantime. */
async function tidy (original, index) {
  if (!state.settings.cleanup) return
  const result = await window.transvibe.cleanup(original)
  if (!result.used || state.finals[index] !== original) return
  state.finals[index] = result.text
  render()
}

/* The room keeps ringing for a moment after `say` exits, and the VAD's onset
   run is only three frames. */
const SPEECH_TAIL_MS = 250

/* Say what just happened, and go deaf while saying it.
 *
 * The strip already shows this line, but the strip is not what you are looking
 * at: the wake phrase exists so you can edit a transcript without leaving the
 * app you are dictating into, and a confirmation you have to look up to read
 * gives that back. So it is spoken as well.
 *
 * The microphone is stopped for exactly the length of the reply. Echo
 * cancellation is on and still not enough — the speakers are a foot from the
 * mic — and an app that transcribes its own confirmations, then hears the wake
 * phrase in one of them, is an app that talks to itself. */
async function voice (line, options) {
  if (!line || !state.settings.speakReplies) return
  await whileDeaf(() => window.transvibe.speak(line, options))
}

/* Everything that makes noise goes through here, so there is one place that
   owns the microphone being off and one place that guarantees it comes back
   on. `speak` resolves when the speaker is quiet; the tail covers the room. */
async function whileDeaf (speaking) {
  state.deaf++
  if (state.capture) state.capture.setDeaf(true)
  try {
    await speaking()
    await new Promise(resolve => setTimeout(resolve, SPEECH_TAIL_MS))
  } finally {
    state.deaf = Math.max(0, state.deaf - 1)
    // Whatever went wrong, the microphone comes back on: deaf is a state no
    // failure is allowed to leave the app stuck in.
    if (state.capture && state.deaf === 0) state.capture.setDeaf(false)
  }
}

/** Fire-and-forget: nothing waits on the app finishing its sentence. */
function say (line, options) {
  voice(line, options).catch(err => console.warn('[transvibe] speech failed:', err.message))
}

/* A voice is chosen by ear. Changing it — or the rate — says one line back in
   it there and then, rather than making you go and run a command to find out
   what you picked. It plays even with replies switched off: picking a voice is
   a question about the voice, not a change of mind about the feature. */
function previewVoice () {
  whileDeaf(() => window.transvibe.previewVoice())
    .catch(err => console.warn('[transvibe] voice preview failed:', err.message))
}

function applyFade () {
  document.body.classList.toggle('faded', state.presence.faded)
}

/* The window is only as tall as what is in it. Measured from the laid-out
   content rather than guessed at, because the transcript's height depends on
   how the text wrapped — a fixed strip clipped the last line of a three-line
   utterance and cut the buttons sitting under it in half.

   Deliberately not shrunk while the text is faded: the stage still has to be
   hoverable at zero opacity, and it cannot be hovered if it is outside the
   window. */
let heightFrame = null
function syncHeight () {
  if (heightFrame) return
  heightFrame = requestAnimationFrame(() => {
    heightFrame = null
    // The stage and the word fixer, never an open panel: a panel is sized in
    // percentages of the window, so measuring it would feed its own height
    // back in and the strip would grow without limit. The main process takes
    // the larger of this and its fixed panel height.
    //
    // The fixer has to be in here because it hangs below the row it belongs
    // to: measuring the stage alone left its last two checkboxes outside the
    // window, where they were not merely hidden but unclickable.
    const fixer = $('fixer')
    const bottom = Math.max(
      document.querySelector('.stage').getBoundingClientRect().bottom,
      fixer.hidden ? 0 : fixer.getBoundingClientRect().bottom
    )
    window.transvibe.setHeight(Math.ceil(bottom + BOTTOM_MARGIN))
  })
}

/* The idle window ran out with the text already faded and nobody reaching for
   it. Whatever the strip heard — a song, a conversation that was not aimed at
   it — was not dictation, so it goes rather than sitting there waiting to be
   pasted somewhere by mistake. The undo stack goes with it: "forgotten" that
   ⌘Z brings back is not forgotten. */
function forgetTranscript () {
  if (!state.finals.length && !state.live) return
  state.finals = []
  state.live = ''
  state.liveSeq++
  state.undoStack = []
  render()
}

/* Esc with nothing else open means "get out of the way": the transcript goes,
   and the strip is a bare ribbon again. */
function dismiss () {
  state.finals = []
  state.live = ''
  state.liveSeq++
  state.undoStack = []
  render()
  closeFixer()
}

/* The command reference is generated from COMMANDS, the same array the parser
   is driven by, so the help can never drift from what actually works. */
function buildHelp () {
  const body = $('help-body')
  if (body.childElementCount) return

  const el = (tag, cls, text) => {
    const n = document.createElement(tag)
    if (cls) n.className = cls
    if (text != null) n.textContent = text
    return n
  }

  const section = (title, rows) => {
    body.append(el('h3', null, title))
    const dl = el('dl')
    for (const [term, def] of rows) {
      dl.append(el('dt', null, term))
      const dd = el('dd')
      if (typeof def === 'string') dd.textContent = def
      else dd.append(...def)
      dl.append(dd)
    }
    body.append(dl)
  }

  section('The strip', [
    ['clicks pass through', 'Until you rest the pointer on the strip; then it wakes'],
    ['text fades', 'A few seconds after you stop talking — ⌃⌥↩ still sends it'],
    ['esc', 'Closes this, then the fixer, then clears the transcript']
  ])

  section('Keys', [
    ['hold right ⌥', 'Speak one command instead of dictating'],
    ['⌃⌥C', 'Same, without holding a key'],
    ['say the wake phrase', 'Same again, no key at all — “hey Claude, delete that” until you change it'],
    ['it answers back', 'Spoken aloud after each command; the mic is deaf while it talks. Settings › Spoken replies'],
    ['chain them', 'and / then / a comma: “open settings and change the voice to Karen”'],
    ['⌃⌥↩', 'Send the transcript to the app in front'],
    ['⌃⌥Space', 'Show or hide the strip'],
    ['⌘,', 'Settings, from the menu bar icon']
  ])

  section('Transcript', [
    ['click a word', 'Say what it should have been; untick “remember” for a one-off'],
    ['esc', 'Dismiss the fixer without changing anything'],
    ['drag', 'Select text as usual; a selection never opens the fixer']
  ])

  section('Buttons', [
    ['×', 'Clear the transcript and get out of the way'],
    ['➤', 'Send the transcript to the app in front'],
    ['copy', 'Copy the whole transcript'],
    ['trash', 'Clear the transcript'],
    ['book', 'Glossary — words to recognise, and fixes for the ones it misses'],
    ['gear', 'Settings — everything else, applied as you change it'],
    ['?', 'This panel'],
    ['mic', 'Pause and resume listening']
  ])

  body.append(el('h3', null, 'Commands'))
  const dl = el('dl')
  for (const cmd of COMMANDS) {
    const dt = el('dt')
    for (const example of cmd.examples.slice(0, 3)) {
      dt.append(el('span', 'say', example))
    }
    dl.append(dt, el('dd', null, cmd.help))
  }
  body.append(dl)

  /* Generated from the same schema the panel is built from, so it cannot
     describe a setting that is not reachable — or miss one that is. */
  body.append(el('h3', null, 'Settings, by voice'))
  const grammar = el('dl')
  for (const [form, help] of [
    ['turn off spoken replies', 'Any on/off setting: turn on, turn off, enable, disable'],
    ['set the fade to ten seconds', 'Any slider. Seconds, milliseconds or a bare number'],
    ['raise the threshold', 'A nudge either way: raise, lower, speed up, slow down'],
    ['make the voice Karen', 'Any English voice installed on this Mac'],
    ["what's the threshold", 'Ask instead of change; it says where the setting sits']
  ]) {
    grammar.append(el('dt', null, form), el('dd', null, help))
  }
  body.append(grammar)

  const names = FIELDS.filter(f => f.spoken).map(f => f.spoken[0])
  body.append(el('p', 'note',
    `Settings you can name out loud: ${names.join(', ')}. The wake phrase, ` +
    'the language, the send target and the model paths are panel-only — a ' +
    'misheard wake phrase would take the voice commands with it.'))

  body.append(el('p', 'note',
    'The strip has no window: it hangs off the top of the screen and every ' +
    'click lands in whatever is behind it, until the pointer rests on it.'))
  body.append(el('p', 'note',
    'Commands only fire while command mode is armed, so ordinary dictation is ' +
    'never mistaken for one. Anything not recognised is shown rather than ' +
    'guessed at, so nothing you said is silently swallowed.'))
  body.append(el('p', 'note',
    'Everything runs on this Mac. Audio never leaves the device.'))
}

/* ------------------------------------------------------------------- glossary
   The panel edits `settings.vocabulary` and `settings.corrections` directly.
   Every change round-trips through the main process, which persists it and
   swaps it into the running engine, and the reply is the new settings — so
   what is on screen is always what was actually saved, never an optimistic
   guess that a failed write would leave lying. */

function el (tag, cls, text) {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text != null) n.textContent = text
  return n
}

function glossaryNote (text, warn = false) {
  const note = $('glossary-note')
  note.textContent = text
  note.classList.toggle('warn', warn)
}

async function saveGlossary (patch) {
  state.settings = await window.transvibe.setSettings(patch)
  renderGlossary()
}

function renderGlossary () {
  const terms = state.settings.vocabulary || []
  const chips = $('term-chips')
  chips.replaceChildren()
  if (!terms.length) {
    chips.append(el('p', 'empty', 'No terms yet.'))
  } else {
    for (const term of terms) {
      const chip = el('span', 'chip', term)
      const remove = el('button', null, '×')
      remove.type = 'button'
      remove.title = `Remove ${term}`
      remove.onclick = () => saveGlossary({ vocabulary: removeTerm(terms, term).terms })
      chip.append(remove)
      chips.append(chip)
    }
  }

  const corrections = state.settings.corrections || {}
  const rows = $('rule-rows')
  rows.replaceChildren()
  const entries = sortedEntries(corrections)
  if (!entries.length) {
    rows.append(el('p', 'empty', 'No fixes yet.'))
  } else {
    for (const [from, to] of entries) {
      const row = el('div', 'rule')
      const remove = el('button', null, '×')
      remove.type = 'button'
      remove.title = `Remove ${from}`
      remove.onclick = () =>
        saveGlossary({ corrections: removeCorrection(corrections, from).corrections })
      row.append(el('span', 'heard', from), el('span', 'arrow', '→'),
        el('span', 'wrote', to), remove)
      rows.append(row)
    }
  }
}

function wireGlossary () {
  $('term-form').onsubmit = async e => {
    e.preventDefault()
    const input = $('term-input')
    const result = addTerms(state.settings.vocabulary || [], input.value)
    if (!result.ok) return glossaryNote(result.error, true)
    input.value = ''
    await saveGlossary({ vocabulary: result.terms })
    glossaryNote(`added ${result.added.join(', ')}`)
    input.focus()
  }

  $('rule-form').onsubmit = async e => {
    e.preventDefault()
    const from = $('rule-from')
    const to = $('rule-to')
    const result = addCorrection(state.settings.corrections || {}, from.value, to.value)
    if (!result.ok) return glossaryNote(result.error, true)
    from.value = ''
    to.value = ''
    await saveGlossary({ corrections: result.corrections })
    glossaryNote(result.replaced ? 'replaced an existing fix' : 'fix added')
    from.focus()
  }
}

/* ---------------------------------------------------------------- word fixer
   Click a word in the transcript to say what it should have been. The fix is
   applied to the transcript straight away *and* saved to the glossary, so the
   same mishearing is corrected without being retyped next time. */

function closeFixer () {
  $('fixer').hidden = true
  syncHold()
  syncHeight()
}

function syncFixerOptions () {
  const remember = $('fixer-remember').checked
  // Disabled rather than merely faded, so the box greys out natively and the
  // row cannot be clicked into a state that would then be ignored.
  $('fixer-listen').disabled = !remember
  $('fixer-listen-row').classList.toggle('off', !remember)
}

function openFixer (wordEl) {
  const fixer = $('fixer')
  const shell = document.querySelector('.strip')
  const box = wordEl.getBoundingClientRect()
  const frame = shell.getBoundingClientRect()

  $('fixer-from').value = wordEl.textContent
  $('fixer-to').value = ''
  $('fixer-remember').checked = state.fixRemember
  $('fixer-listen').checked = state.fixListen
  syncFixerOptions()
  fixer.hidden = false

  // Sit under the word, nudged back inside the shell when it would overhang.
  const width = fixer.offsetWidth
  const left = Math.min(
    Math.max(box.left - frame.left, 12),
    Math.max(frame.width - width - 12, 12))
  const below = box.bottom - frame.top + 6
  const top = below + fixer.offsetHeight > frame.height - 12
    ? Math.max(box.top - frame.top - fixer.offsetHeight - 6, 12)
    : below
  fixer.style.left = `${left}px`
  fixer.style.top = `${top}px`
  syncHold()
  // The window is grown after the fixer is placed, not before: where it goes
  // is decided against the strip as it stands, and then the strip is made tall
  // enough to hold it.
  syncHeight()
  $('fixer-to').focus()
}

function wireFixer () {
  // A click that ends a drag is a text selection, not a request to fix a word.
  let dragged = false
  transcriptEl.addEventListener('pointerdown', () => { dragged = false })
  transcriptEl.addEventListener('pointermove', e => { if (e.buttons) dragged = true })

  transcriptEl.addEventListener('click', e => {
    const word = e.target.closest('.w')
    const selection = window.getSelection()
    if (!word || dragged || (selection && !selection.isCollapsed)) return closeFixer()
    openFixer(word)
  })

  $('fixer-close').onclick = closeFixer
  $('fixer-remember').onchange = () => {
    state.fixRemember = $('fixer-remember').checked
    syncFixerOptions()
  }
  $('fixer-listen').onchange = () => { state.fixListen = $('fixer-listen').checked }

  $('fixer-form').onsubmit = async e => {
    e.preventDefault()
    const heard = $('fixer-from').value.trim()
    const written = $('fixer-to').value.trim()
    if (!heard || !written) return hint('both sides are required')

    // The rewrite always happens; keeping the rule is the opt-out. A one-off
    // mishearing is not worth a permanent rule, and a glossary full of them
    // would only slow the real entries down.
    const rule = [[heard, written]]
    const before = fullText()
    const fixed = state.finals.map(t => applyCorrections(t, rule))
    const changed = fixed.join(' ') !== state.finals.join(' ')
    if (changed) {
      state.undoStack.push(before)
      state.finals = fixed
    }
    closeFixer()
    render()

    if (!state.fixRemember) {
      return hint(changed ? `"${heard}" → ${written}` : `"${heard}" not found`)
    }

    const result = addCorrection(state.settings.corrections || {}, heard, written)
    if (!result.ok) return hint(result.error)
    const patch = { corrections: result.corrections }
    if (state.fixListen) {
      const terms = addTerms(state.settings.vocabulary || [], written)
      // A term already listed is not a failure here — it is already doing its job.
      if (terms.ok) patch.vocabulary = terms.terms
    }
    state.settings = await window.transvibe.setSettings(patch)
    if (!$('glossary').hidden) renderGlossary()
    hint(`"${heard}" → ${written} · saved to glossary`)
  }
}

async function doSend () {
  const text = fullText()
  if (!text) return hint('nothing to send')
  hint('sending…')
  const res = await window.transvibe.send(text)
  hint(res.ok ? `sent to ${res.target}` : res.error)
}

/* Only one panel at a time — they occupy the same rectangle. Opening one also
   asks the main process for a taller strip and pins it awake, so it cannot go
   click-through while you are typing into it. */
const PANELS = {
  help: { btn: 'help-btn', open: buildHelp },
  glossary: { btn: 'glossary-btn', open: renderGlossary },
  settings: { btn: 'settings-btn', open: () => state.settingsPanel.render() }
}

function togglePanel (name, show) {
  const panel = $(name)
  const next = show ?? panel.hidden
  if (next) {
    for (const other of Object.keys(PANELS)) if (other !== name) togglePanel(other, false)
    PANELS[name].open()
  }
  panel.hidden = !next
  $(PANELS[name].btn).classList.toggle('on', next)
  syncHold()
  syncHeight()
}

function openPanel () {
  return Object.keys(PANELS).find(name => !$(name).hidden) || null
}

/** Whatever is open, closed — what esc does, for hands that are elsewhere. */
function closeOpenPanel () {
  const name = openPanel()
  if (name) togglePanel(name, false)
}

/* The model list is the machine's, not the app's: transvibe downloads one
   only when it cannot find any, so on a Mac that already runs another local
   whisper app every entry here belongs to that app. Sizes are shown because
   size is the trade — a small model is faster and wronger.

   "Automatic" is first and is what the setting holds by default; the readout
   beside it names the file that choice actually landed on, which is otherwise
   invisible. */
async function fieldOptions (field) {
  if (field.options === 'ollama') return assistModelOptions()
  if (field.options === 'voices') return voiceOptions()
  return speechModelOptions()
}

/* macOS's own voice list, cut down to the ones that speak English — 183
   installed here, 43 of them English. The lines being read are the app's own
   and are written in English; a Polish voice reading "deleted the last three
   words" is not a choice worth scrolling past forty others to avoid making.
   Region is kept, because that is the whole difference between the ones that
   are left.

   "System voice" is first and is the default: whatever `say` uses with no `-v`
   at all, which is also the way to reach a voice this filter hides — set
   `speakVoice` in settings.json by hand and the panel shows it rather than
   silently resetting it. */
const SPOKEN_LOCALE = /^en/i

async function voiceOptions () {
  const all = await window.transvibe.listVoices()
  const voices = all.filter(v => SPOKEN_LOCALE.test(v.locale))
  const options = [{ value: '', label: 'System voice' }]
  for (const v of voices) options.push({ value: v.name, label: `${v.name} · ${v.locale}` })
  if (!voices.length) options.push({ value: '', label: 'no English voices found', disabled: true })
  return { options, note: `${voices.length} English voices` }
}

/* The assist model is Ollama's, and Ollama is optional in the strongest sense:
   not running is the ordinary case, so the list says so plainly rather than
   coming up empty and looking broken. */
async function assistModelOptions () {
  const { models, reachable } = await window.transvibe.listAssistModels()
  const options = models.map(name => ({ value: name, label: name }))
  if (!reachable) {
    return { options, note: 'Ollama not running' }
  }
  if (!models.length) {
    return { options, note: 'nothing pulled yet' }
  }
  return { options, note: `${models.length} pulled` }
}

async function speechModelOptions () {
  const { models, inUse } = await window.transvibe.listModels()
  const options = [{ value: '', label: 'Automatic — first one found' }]
  for (const model of models) {
    options.push({
      value: model.path,
      label: `${model.name} · ${model.size} · ${model.from}`
    })
  }
  if (!models.length) {
    options.push({ value: '', label: 'no models on this Mac yet', disabled: true })
  }
  const loaded = models.find(m => m.path === inUse)
  return {
    options,
    note: loaded ? `using ${loaded.name}` : (inUse ? 'using a model not in the list' : 'none loaded')
  }
}

/* A setting is only worth a panel if changing it does something now. The main
   process already re-reads its own on every use and reapplies the ones the
   engine holds; these are the four the renderer captured at startup, plus the
   visualizer, which is cheap enough to simply rebuild.

   `language` and `modelPath` are not here: they are baked into a running
   whisper server, and the panel says so on the row rather than pretending.

   The two voice settings are here for a different reason: nothing needs
   applying — the main process reads them on every reply — but they are worth
   hearing the moment they change. */
function applyLiveSetting (key, { preview = true } = {}) {
  const value = state.settings[key]
  const capture = state.capture

  if (key === 'threshold' && capture) capture.setThreshold(value)
  if (key === 'hangoverMs' && capture) capture.setHangoverMs(value)
  if (key === 'interimMs' && capture) capture.setInterimMs(value)
  if (key === 'idleFadeMs' && state.presence) state.presence.setIdleFadeMs(value)
  if (key === 'idleClearMs' && state.presence) state.presence.setIdleClearMs(value)
  if (preview && (key === 'speakVoice' || key === 'speakRate')) previewVoice()
  if (key.startsWith('viz')) rebuildVisualizer()
}

function rebuildVisualizer () {
  if (!state.capture) return
  if (state.viz) state.viz.destroy()
  state.viz = createVisualizer($('viz'), {
    analyser: state.capture.analyser,
    centerRatio: 0.46,
    linesPerFamily: state.settings.vizLinesPerFamily,
    points: state.settings.vizPoints,
    fps: state.settings.vizFps,
    quietFps: state.settings.vizQuietFps
  })
  state.viz.start()
}

/* One place decides whether the strip is mid-interaction: any panel, or the
   word fixer. Both the hold (stay awake) and the height (make room) follow
   from it, so they can never disagree. */
function syncHold () {
  const panel = openPanel()
  document.body.classList.toggle('panel-open', !!panel)
  const held = !!panel || !$('fixer').hidden
  window.transvibe.setPanelOpen(!!panel)
  window.transvibe.setHold(held)
  if (state.presence) state.presence.setHeld(held, Date.now())
}

async function main () {
  state.settings = await window.transvibe.getSettings()
  state.settingsPanel = createSettingsPanel({
    body: $('settings-body'),
    note: text => { $('settings-note').textContent = text },
    getSettings: () => state.settings,
    save: async patch => { state.settings = await window.transvibe.setSettings(patch) },
    applyLive: applyLiveSetting,
    open: name => togglePanel(name, true),
    getExternal: () => window.transvibe.getLaunchAtLogin(),
    setExternal: (_key, value) => window.transvibe.setLaunchAtLogin(value),
    getOptions: fieldOptions
  })
  state.presence = createPresence({
    idleFadeMs: state.settings.idleFadeMs,
    idleClearMs: state.settings.idleClearMs
  })
  state.presence.activity(Date.now())

  /* The strip is click-through until the main process says the pointer has
     settled on it. Everything interactive keys off this class, so nothing
     advertises a hit target that clicks would fall straight through. */
  window.transvibe.onAwake(value => {
    state.awake = value
    document.body.classList.toggle('awake', value)
    state.presence.setAwake(value, Date.now())
    if (!value) closeFixer()
    applyFade()
    // The button row only takes up space once it is there.
    syncHeight()
  })

  /* Mouse-move events arrive even while the strip is click-through, which is
     what makes selective wake possible: the main process only counts the
     pointer as "on the strip" when it is over something worth clicking. Empty
     air between the ribbon and the words stays transparent to the mouse. */
  const TARGETS = '.bar, .panel, .fixer, .transcript'
  let overTarget = null
  const reportTarget = value => {
    if (overTarget === value) return
    overTarget = value
    window.transvibe.setOverTarget(value)
  }
  document.addEventListener('mousemove', e => {
    const over = !!(e.target instanceof Element && e.target.closest(TARGETS))
    // Reaching for the strip is interest: bring a faded transcript back before
    // the pointer arrives at a word it can no longer see.
    if (over && state.presence.faded) noteActivity()
    reportTarget(over)
  })
  document.addEventListener('mouseleave', () => reportTarget(false))

  // Idle is checked on a slow timer rather than on a fresh timeout per word —
  // one interval is cheaper than restarting a timer on every interim result.
  setInterval(() => {
    const { changed, expired } = state.presence.tick(Date.now())
    if (changed) applyFade()
    if (expired) forgetTranscript()
  }, 400)

  window.transvibe.onStatus(s => {
    if (s.state === 'ready') hint(`listening · ${s.message} · ${s.mode}`)
    else if (s.state === 'downloading') {
      hint(s.progress != null
        ? `downloading model ${Math.round(s.progress * 100)}%`
        : 'downloading model…')
    } else if (s.state === 'error') hint(s.message)
  })

  const capture = await startCapture({
    settings: state.settings,
    onError: msg => hint(msg),
    onLevel: () => {
      // pace the visualizer off the VAD rather than off its own boosted level
      if (state.viz && state.capture) {
        const speaking = state.capture.vad.state !== 'idle'
        state.viz.setActive(speaking)
        // A silent room dims the ribbon to almost nothing; the moment there is
        // something to hear it lights up. That is the whole ambient display.
        document.body.classList.toggle('quiet', !speaking)
      }
    },
    onSegment: async samples => {
      if (!state.listening) return
      // the utterance is over: whatever interim is in flight is now stale
      state.liveSeq++
      state.pending++
      const asCommand = state.commandMode
      // Read staleness before the new activity clears it: this utterance is
      // what decides whether the faded transcript was the end of a thought.
      const wasStale = state.presence.stale
      noteActivity()
      render()
      try {
        const res = await window.transvibe.transcribe(samples)
        if (res.error) hint(res.error)
        else if (!res.text) { /* silence or a filtered artifact */ }
        // Not awaited: command mode has to disarm the moment the utterance is
        // consumed, and the assist fallback may still be thinking.
        else if (asCommand) runCommand(res.text).catch(err => hint(err.message))
        else {
          /* Nobody armed anything: the words themselves decide. An utterance
             that opens with the wake phrase is a command, and — unlike
             dictation — a faded transcript is left alone, because editing
             what is already on the strip is the whole point of saying it. */
          const wake = splitWakeWord(res.text, {
            phrase: state.settings.wakeWord,
            fuzzy: state.settings.wakeWordFuzzy
          })
          if (wake.matched && wake.rest) {
            runCommand(wake.rest, { keep: () => dictate(res.text, wasStale) })
              .catch(err => hint(err.message))
          } else if (wake.matched) {
            // The phrase on its own: you are about to say the command.
            window.transvibe.setCommandMode(true)
            setCommandMode(true)
            hint('listening for a command…')
          } else dictate(res.text, wasStale)
        }
      } finally {
        state.pending--
        state.live = ''
        state.liveWake = false
        if (asCommand) {
          window.transvibe.setCommandMode(false)
          setCommandMode(false)
        }
        render()
      }
    },

    /* Interim pass over the open utterance. At most one is in flight at a
       time, so a slow model throttles these instead of queueing them up ahead
       of the final. */
    onPartial: async samples => {
      if (!state.listening || state.interimBusy) return
      state.interimBusy = true
      const seq = ++state.liveSeq
      try {
        const res = await window.transvibe.transcribe(samples, true)
        if (seq === state.liveSeq && res.text) {
          const wake = state.commandMode
            ? { matched: false, rest: res.text }
            : splitWakeWord(res.text, {
              phrase: state.settings.wakeWord,
              fuzzy: state.settings.wakeWordFuzzy
            })
          state.liveWake = wake.matched
          // Showing the command without its keyword: what is on the strip is
          // what the parser is going to be handed.
          state.live = wake.matched ? (wake.rest || res.text) : res.text
          noteActivity()
          render()
        }
      } catch {
        /* an interim that fails is simply skipped */
      } finally {
        state.interimBusy = false
      }
    }
  })

  if (!capture) return
  state.capture = capture
  // handy from the devtools console: `state` for VAD tuning, `render` to redraw
  // after poking at it
  window.__transvibe = { state, render }

  // The ribbon rides high in its canvas so it reads as hanging off the top
  // edge of the screen, with the glow spreading down over the text. Built
  // through the same path a visualizer setting change takes, so there is one
  // description of it rather than two that can drift.
  rebuildVisualizer()

  $('copy').onclick = async () => {
    const text = fullText()
    if (!text) return
    await window.transvibe.copy(text)
    hint('copied')
  }

  $('clear').onclick = () => {
    const before = fullText()
    if (before) state.undoStack.push(before)
    state.finals = []
    state.live = ''
    state.liveSeq++
    render()
  }

  // The × dismisses the text rather than the window: there is no window left
  // to close, and hiding the whole strip is what the menu bar is for.
  $('close').onclick = dismiss
  $('send').onclick = doSend
  $('help-btn').onclick = () => togglePanel('help')
  $('help-close').onclick = () => togglePanel('help', false)
  $('glossary-btn').onclick = () => togglePanel('glossary')
  $('glossary-close').onclick = () => togglePanel('glossary', false)
  $('settings-btn').onclick = () => togglePanel('settings')
  $('settings-close').onclick = () => togglePanel('settings', false)
  wireGlossary()
  wireFixer()
  wireButtonHints()

  // Anywhere outside the popover dismisses it; the transcript's own handler
  // runs first and reopens it when the click landed on another word.
  document.addEventListener('pointerdown', e => {
    if (!$('fixer').hidden && !e.target.closest('#fixer') && !e.target.closest('.w')) closeFixer()
  })

  /* Esc unwinds one layer at a time — fixer, then panel, then the transcript
     itself — so it is always the key that gets something out of the way, and
     never the key that throws away work you could still see a use for. */
  document.addEventListener('keydown', e => {
    // '?' is a character someone can legitimately type into the glossary
    // fields, so the shortcut yields whenever a text field has focus.
    const typing = e.target instanceof HTMLInputElement
    if (e.key === 'Escape') {
      if (!$('fixer').hidden) return closeFixer()
      const open = openPanel()
      if (open) return togglePanel(open, false)
      dismiss()
    } else if (e.key === '?' && !typing && !openPanel()) togglePanel('help', true)
  })

  function setListening (value) {
    state.listening = value
    $('mute').classList.toggle('on', !value)
    hint(value ? 'listening' : 'paused')
  }
  setListeningState = value => {
    setListening(value)
    window.transvibe.setListening(value)
  }

  window.transvibe.onCommandMode(active => {
    setCommandMode(active)
    if (active) hint('command — say what to do')
  })

  $('mute').onclick = () => {
    setListening(!state.listening)
    window.transvibe.setListening(state.listening)
  }

  // the menu bar can drive the same actions as the buttons
  window.transvibe.onListening(setListening)
  window.transvibe.onCommand(name => {
    if (name === 'copy') $('copy').click()
    if (name === 'clear') $('clear').click()
    if (name === 'send') doSend()
    if (name in PANELS) togglePanel(name, true)
  })

  render()
}

main().catch(err => hint(`startup failed: ${err.message}`))
