import { startCapture } from './audio.js'
import { createVisualizer } from './visualizer.js'
import { parseCommand, applyCommand, COMMANDS } from './commands.js'

const $ = id => document.getElementById(id)
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
  viz: null
}

function hint (text) { hintEl.textContent = text }

function render () {
  transcriptEl.replaceChildren(
    ...state.finals.map(t => {
      const span = document.createElement('span')
      span.className = 'final'
      span.textContent = t + ' '
      return span
    })
  )
  if (state.live || state.pending > 0) {
    const live = document.createElement('span')
    live.className = 'live'
    live.textContent = state.live || '…'
    transcriptEl.append(live)
  }
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
  document.body.classList.toggle('command-mode', active)
  if (!active) state.live = ''
  render()
}

/* One spoken utterance, interpreted as an editing command rather than as text
   to insert. A parse failure must never silently swallow what was said. */
function runCommand (utterance) {
  const cmd = parseCommand(utterance)

  if (!cmd) {
    // The seam a model fallback drops into later: everything the rules could
    // not place lands here, so the misses are visible rather than guessed at.
    console.info('[transvibe] unrecognised command:', JSON.stringify(utterance))
    hint(`not a command: "${utterance}"`)
    return
  }

  const before = fullText()
  const result = applyCommand(cmd, before)

  if (result.effect === 'undo') {
    const previous = state.undoStack.pop()
    if (previous === undefined) return hint('nothing to undo')
    setText(previous)
    hint('undone')
    render()
    return
  }

  if (result.changed) {
    state.undoStack.push(before)
    if (state.undoStack.length > 20) state.undoStack.shift()
    setText(result.text)
  }

  switch (result.effect) {
    case 'copy': window.transvibe.copy(fullText()); break
    case 'send': doSend(); return
    case 'clear': state.undoStack.push(before); setText(''); break
    case 'pause': setListeningState(false); break
    case 'resume': setListeningState(true); break
    case 'hide': window.transvibe.hide(); break
  }

  hint(result.message)
  render()
}

let setListeningState = () => {}

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

  section('Keys', [
    ['hold right ⌥', 'Speak one command instead of dictating'],
    ['⌃⌥C', 'Same, without holding a key'],
    ['⌃⌥↩', 'Send the transcript to the app in front'],
    ['⌃⌥Space', 'Show or hide the window'],
    ['esc', 'Close this help']
  ])

  section('Buttons', [
    ['×', 'Hide to the menu bar (the app keeps running)'],
    ['➤', 'Send the transcript to the app in front'],
    ['copy', 'Copy the whole transcript'],
    ['trash', 'Clear the transcript'],
    ['pin', 'Keep the window above everything else'],
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

  body.append(el('p', 'note',
    'Commands only fire while command mode is armed, so ordinary dictation is ' +
    'never mistaken for one. Anything not recognised is shown rather than ' +
    'guessed at, so nothing you said is silently swallowed.'))
  body.append(el('p', 'note',
    'Everything runs on this Mac. Audio never leaves the device.'))
}

async function doSend () {
  const text = fullText()
  if (!text) return hint('nothing to send')
  hint('sending…')
  const res = await window.transvibe.send(text)
  hint(res.ok ? `sent to ${res.target}` : res.error)
}

function toggleHelp (show) {
  const panel = $('help')
  const next = show ?? panel.hidden
  if (next) buildHelp()
  panel.hidden = !next
  $('help-btn').classList.toggle('on', next)
}

async function main () {
  state.settings = await window.transvibe.getSettings()

  document.documentElement.style.setProperty(
    '--idle-opacity', String(state.settings.idleOpacity ?? 0.22))

  window.transvibe.onFocus(focused => {
    document.body.classList.toggle('unfocused', !focused)
  })
  document.body.classList.toggle('unfocused', !document.hasFocus())

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
        state.viz.setActive(state.capture.vad.state !== 'idle')
      }
    },
    onSegment: async samples => {
      if (!state.listening) return
      // the utterance is over: whatever interim is in flight is now stale
      state.liveSeq++
      state.pending++
      const asCommand = state.commandMode
      render()
      try {
        const res = await window.transvibe.transcribe(samples)
        if (res.error) hint(res.error)
        else if (!res.text) { /* silence or a filtered artifact */ }
        else if (asCommand) runCommand(res.text)
        else state.finals.push(res.text)
      } finally {
        state.pending--
        state.live = ''
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
          state.live = res.text
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
  // handy for diagnosing VAD tuning from the devtools console
  window.__transvibe = state

  state.viz = createVisualizer($('viz'), {
    analyser: capture.analyser,
    linesPerFamily: state.settings.vizLinesPerFamily,
    points: state.settings.vizPoints,
    fps: state.settings.vizFps,
    quietFps: state.settings.vizQuietFps
  })
  state.viz.start()

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

  $('pin').onclick = async e => {
    const next = !state.settings.alwaysOnTop
    state.settings = await window.transvibe.setSettings({ alwaysOnTop: next })
    e.currentTarget.classList.toggle('on', next)
  }

  $('close').onclick = () => window.transvibe.hide()
  $('send').onclick = doSend
  $('help-btn').onclick = () => toggleHelp()
  $('help-close').onclick = () => toggleHelp(false)

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !$('help').hidden) toggleHelp(false)
    else if (e.key === '?' && $('help').hidden) toggleHelp(true)
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
  })

  $('pin').classList.toggle('on', state.settings.alwaysOnTop)
  render()
}

main().catch(err => hint(`startup failed: ${err.message}`))
