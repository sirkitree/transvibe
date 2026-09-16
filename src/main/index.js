import {
  app, BrowserWindow, ipcMain, clipboard, systemPreferences,
  globalShortcut, Tray, Menu, nativeImage, screen, shell
} from 'electron'
import path from 'node:path'
import { createLatestRequest } from './latest-request.js'
import { conversationFact, isAcknowledgment, needsVerification, claimsLocalSearch, verificationReply, UNVERIFIED } from '../shared/reply-policy.js'
import { randomUUID } from 'node:crypto'
import { createDebugRecording } from './debug-recording.js'
import { createVoiceprint, modelReady as voiceprintModelReady, downloadModel as downloadVoiceprintModel } from './voiceprint.js'
import { spawn } from 'node:child_process'
import fs, { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createEngine } from './whisper.js'
import { createAssist, listOllamaModels } from './assist.js'
import { createCliAgent, listCliAgents } from './cli-agent.js'
import { defaultModel, isRemote } from '../shared/agents.js'
import {
  needsFreshFacts, shouldEscalate, escalationChain, answersAgree
} from '../shared/escalate.js'
import { speak, stopSpeaking, listVoices } from './speech.js'
import {
  findModel, downloadModel, findVadModel, downloadVadModel, listModels, humanSize, MODELS_DIR
} from './models.js'
import * as config from './config.js'
import { stripBounds, orbBounds, contains, withinCircle, nextWake } from './overlay.js'
import { listSpaces, listSwitchTargets, dockClickScript } from './spaces.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let win = null
let orbWin = null
let orbHover = false        // the pointer is on the orb, so its controls show
let orbOverTarget = false   // renderer: the pointer is on one of those controls
let orbClickable = false
let orbDrag = null          // an in-flight drag: where it started, and from where
let orbDragTimer = null
let tray = null
let engine = null
let assist = null
/* One CLI handle per provider, made on first use and thrown away whenever the
   settings that shape them change. Per provider rather than per agent because
   the model is a per-question argument anyway, and because "stop" has to reach
   every process a provider has running, not just the one agent's. */
let remotes = new Map()
let settings = config.load()
const debugRecording = createDebugRecording(path.join(config.DIR, 'recordings'), message => {
  console.warn('[transvibe] recording stopped:', message)
  if (tray) tray.setTitle(debugRecording.status.active ? '● REC' : '')
  send('debug:status', debugRecording.status)
})

/* The voiceprint engine loads its model lazily, on the first utterance it is
   asked to score, so an app with the setting off never pays for it. */
const voiceprint = createVoiceprint({ onError: message => console.warn('[transvibe]', message) })

let listening = true
let commandTimer = null
let tapProc = null
let holding = false

/* ------------------------------------------------------------------- overlay
   The window is a full-width strip hanging from the top of the screen with no
   chrome of its own, and it is click-through: every click lands in whatever is
   behind it. Park the pointer on it and it wakes — solid, clickable — then
   goes back to being a ghost the moment the pointer leaves.

   Waking is driven by polling the cursor rather than by forwarded mouse
   events. A click-through window is only told about movement *over* it, so it
   can see the pointer arrive but never see it leave; the cursor position is
   the one signal that answers both. */

const POLL_MS = 90
let wake = { awake: false, insideSince: null, outsideSince: null }
let wakeTimer = null
let holdOpen = false        // renderer is mid-interaction: panel or field open
let overTarget = false      // renderer: the pointer is over something clickable
let panelOpen = false
let contentHeight = 0       // renderer: how tall its content actually is

/* The strip stays on the display it was created on rather than chasing the
   pointer between screens — a HUD that moves house while you glance at another
   monitor is worse than one that stays where you left it. */
function stripRect (height) {
  const display = win && !win.isDestroyed()
    ? screen.getDisplayMatching(win.getBounds())
    : screen.getPrimaryDisplay()
  // The strip is as tall as what it is showing. A three-line transcript that
  // ran past a fixed height used to lose its last line and clip the buttons
  // under it; the renderer measures its own content instead and the window
  // follows. stripBounds still clamps to the display.
  const want = height ?? (panelOpen
    ? Math.max(settings.panelHeight, contentHeight)
    : Math.max(settings.stripHeight, contentHeight))
  return stripBounds(display, { height: want })
}

function applyStripBounds () {
  if (!win || win.isDestroyed()) return
  win.setBounds(stripRect())
}

/* The renderer draws the orb; it is told everything it needs on one channel. */
ipcMain.on('orb:signal', (_e, signal) => sendOrb('orb:signal', signal))
/* And says when the pointer is on one of its two buttons, which is the only
   time the orb is allowed to stop being click-through. */
ipcMain.on('orb:target', (_e, value) => { orbOverTarget = !!value })
/* Grabbing and letting go of the drag handle. Where the orb goes in between is
   worked out here, from the cursor. */
ipcMain.on('orb:drag', (_e, phase) => {
  if (phase === 'start') startOrbDrag()
  else endOrbDrag()
})
ipcMain.on('orb:home', () => homeOrb())

function setAwake (value) {
  if (!win || win.isDestroyed()) return
  wake = { ...wake, awake: value }
  // `forward` keeps mouse-move events coming while the strip is a ghost, which
  // is what lets CSS hover states light up before the first click.
  win.setIgnoreMouseEvents(!value, { forward: true })
  send('awake', value)
}

function pollPointer () {
  if (!win || win.isDestroyed() || !win.isVisible()) return
  const point = screen.getCursorScreenPoint()
  // Being over the strip is not enough — the strip is mostly empty air. The
  // renderer says whether the pointer is actually over the text or a control,
  // so a click in the gaps still reaches the app underneath even while the
  // pointer is technically on the overlay.
  const inside = contains(win.getBounds(), point) && overTarget
  const next = nextWake(wake, {
    inside,
    hold: holdOpen,
    now: Date.now(),
    wakeDelayMs: settings.wakeDelayMs
  })
  const changed = next.awake !== wake.awake
  wake = next
  if (changed) setAwake(next.awake)
}

function startPointerWatch () {
  clearInterval(wakeTimer)
  wakeTimer = setInterval(() => { pollPointer(); pollOrb() }, POLL_MS)
}

/* The orb's version of the strip's wake, and simpler for two reasons: there is
   no dwell — a small round thing in a corner is not something you sweep across
   on the way somewhere, so making you hold still on it would only feel slow —
   and the pointer being on it is not the same question as the pointer being on
   something clickable.

   Hovering only *shows* the controls. The window stays click-through for that,
   so the orb does not start eating clicks merely because you moved past it.
   It stops being click-through only while the pointer is actually on one of
   the two buttons, which the renderer says. Same division as the strip's, for
   the same reason. */
function pollOrb () {
  if (!orbWin || orbWin.isDestroyed()) return
  /* A drag owns the orb until it is let go. Hover would otherwise be tested
     against a window that is moving with the pointer, and one fast enough to
     leave the circle behind for a poll would take the mouse away mid-drag. */
  if (orbDrag) return
  const point = screen.getCursorScreenPoint()
  // The circle, not the square: the four corners of the window have nothing
  // drawn in them and belong to whatever is behind.
  const inside = withinCircle(orbWin.getBounds(), point, { inset: 8 })

  if (inside !== orbHover) {
    orbHover = inside
    sendOrb('orb:hover', inside)
    if (!inside) orbOverTarget = false
  }

  const clickable = inside && orbOverTarget
  if (clickable !== orbClickable) {
    orbClickable = clickable
    orbWin.setIgnoreMouseEvents(!clickable, { forward: true })
  }
}

/* ------------------------------------------------------------------ the orb

   A second window, because the orb lives in the lower-left corner of the
   screen and the strip is a full-width band at the top: one window cannot be
   both without covering everything in between.

   It is a dumb renderer. It has no microphone, no VAD and no idea whether the
   app is listening — all of that stays in the strip's renderer, which is the
   single source of truth for it, and what crosses to here is about seven
   numbers a frame. So the orb can be created and destroyed at will, and if it
   never opens, nothing else notices.

   It is click-through everywhere except two buttons. Resting the pointer on it
   shows them and nothing more — the window is still a ghost for that, so
   hovering the orb never costs you a click on whatever is behind it — and it
   takes the mouse only while the pointer is actually on one of them. That is
   the strip's `overTarget` split, applied to a much smaller target.

   And the region is a circle, not the window. A round thing in a square window
   has four corners with nothing drawn in them, and they sit in the part of the
   screen other things live in. `withinCircle` is the test. */

function orbRect () {
  return orbBounds(orbDisplay(), {
    size: settings.orbSize,
    margin: settings.orbMargin,
    at: settings.orbPosition
  })
}

/* -------------------------------------------------------- moving the orb

   The corner is a default, not a decision: whatever is in the lower-left of
   your screen is not the same as what is in mine. So the orb can be dragged,
   by a handle among its controls rather than by the orb itself — grabbing the
   whole circle would mean the window taking the mouse on hover, which is the
   one thing the click-through HUD exists not to do.

   The renderer says only "started" and "stopped". The motion is followed here
   from the cursor rather than from mouse events, because the window is moving
   under the pointer and a renderer counting its own deltas would be chasing a
   coordinate system it is being dragged around inside. Position is saved once,
   on release: a drag is one decision, not four hundred. */

const ORB_DRAG_MS = 16

function orbDisplay () {
  return win && !win.isDestroyed()
    ? screen.getDisplayMatching(win.getBounds())
    : screen.getPrimaryDisplay()
}

function startOrbDrag () {
  if (!orbWin || orbWin.isDestroyed() || orbDrag) return
  const bounds = orbWin.getBounds()
  orbDrag = { from: screen.getCursorScreenPoint(), at: { x: bounds.x, y: bounds.y } }
  // Held clickable for the whole drag, whatever the pointer wanders over.
  orbClickable = true
  orbWin.setIgnoreMouseEvents(false)
  clearInterval(orbDragTimer)
  orbDragTimer = setInterval(moveOrbToCursor, ORB_DRAG_MS)
}

/** Where the orb would sit now, clamped to the display it is being dragged on. */
function orbDragRect () {
  const point = screen.getCursorScreenPoint()
  const size = orbWin.getBounds()
  const area = orbDisplay().workArea
  return orbBounds(orbDisplay(), {
    size: Math.min(size.width, size.height),
    margin: settings.orbMargin,
    at: {
      x: orbDrag.at.x + (point.x - orbDrag.from.x) - area.x,
      y: orbDrag.at.y + (point.y - orbDrag.from.y) - area.y
    }
  })
}

function moveOrbToCursor () {
  if (!orbDrag || !orbWin || orbWin.isDestroyed()) return endOrbDrag()
  orbWin.setBounds(orbDragRect())
}

function endOrbDrag () {
  clearInterval(orbDragTimer)
  orbDragTimer = null
  if (!orbDrag) return
  const moved = orbWin && !orbWin.isDestroyed() ? orbDragRect() : null
  orbDrag = null
  if (!moved) return
  orbWin.setBounds(moved)
  const area = orbDisplay().workArea
  settings = config.save({ orbPosition: { x: moved.x - area.x, y: moved.y - area.y } })
}

/** Back to the corner, for when it has been dragged somewhere regrettable. */
function homeOrb () {
  endOrbDrag()
  settings = config.save({ orbPosition: null })
  syncOrb()
}

function createOrbWindow () {
  if (orbWin && !orbWin.isDestroyed()) return orbWin
  orbWin = new BrowserWindow({
    ...orbRect(),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    roundedCorners: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,     // it can never be typed into, so it never takes focus
    alwaysOnTop: settings.alwaysOnTop,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  if (settings.alwaysOnTop) orbWin.setAlwaysOnTop(true, 'screen-saver')
  orbWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  // `forward` keeps mouse-move events coming while it is a ghost, which is
  // what lets the renderer notice the pointer arriving on a button.
  orbWin.setIgnoreMouseEvents(true, { forward: true })
  orbWin.loadFile(path.join(__dirname, '..', 'renderer', 'orb.html'))
  // Whether the microphone is on is drawn on the orb's mute button, so it has
  // to arrive once at the start as well as on every change.
  orbWin.webContents.once('did-finish-load', () => sendOrb('listening', listening))
  orbWin.on('closed', () => { orbWin = null })
  return orbWin
}

function destroyOrbWindow () {
  clearInterval(orbDragTimer)
  orbDragTimer = null
  orbDrag = null
  if (orbWin && !orbWin.isDestroyed()) orbWin.destroy()
  orbWin = null
  orbHover = false
  orbOverTarget = false
  orbClickable = false
}

/* The orb follows the strip: same display, shown and hidden with it, and gone
   entirely when the layout is back on the ribbon. Called after anything that
   could change any of those. */
function syncOrb () {
  const wanted = settings.layout === 'orb' &&
    win && !win.isDestroyed() && win.isVisible()
  if (!wanted) return destroyOrbWindow()
  const orb = createOrbWindow()
  orb.setBounds(orbRect())
  if (!orb.isVisible()) orb.showInactive()
}

function sendOrb (channel, payload) {
  if (orbWin && !orbWin.isDestroyed()) orbWin.webContents.send(channel, payload)
}

function createWindow () {
  win = new BrowserWindow({
    ...stripBounds(screen.getPrimaryDisplay(), { height: settings.stripHeight }),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    roundedCorners: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: settings.alwaysOnTop,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  // 'screen-saver' floats above full-screen apps as well as ordinary windows,
  // which is what a HUD hanging off the menu bar has to do to stay useful.
  if (settings.alwaysOnTop) win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.setIgnoreMouseEvents(true, { forward: true })
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))
  startPointerWatch()

  // Closing the window parks the app in the menu bar rather than quitting it;
  // only an explicit Quit tears things down.
  win.on('close', e => {
    if (!app.isQuitting) {
      e.preventDefault()
      win.hide()
      refreshTray()
    }
  })
  win.on('show', () => { applyStripBounds(); syncOrb(); refreshTray() })
  win.on('hide', () => {
    wake = { awake: false, insideSince: null, outsideSince: null }
    setAwake(false)
    // ⌃⌥Space hides the app, and the orb is part of the app.
    syncOrb()
    refreshTray()
  })
  // The strip can be dragged onto another display; the orb goes with it.
  win.on('moved', syncOrb)

  // And it exists from the start if that is the layout, rather than waiting
  // for the first hide-and-show to bring it into being.
  syncOrb()
}

/* ------------------------------------------------------------------- menu bar */

/* showInactive, not show+focus: the strip appearing must never pull you out of
   what you were typing in. It takes focus only when you click it. */
function showWindow () {
  if (!win || win.isDestroyed()) return createWindow()
  applyStripBounds()
  win.showInactive()
}

function toggleWindow () {
  if (win && !win.isDestroyed() && win.isVisible()) win.hide()
  else showWindow()
}

/* Left click is about the words, not the app. The ribbon is how you can tell
   from across the room that it is still listening, and taking that away is
   not what somebody dismissing a transcript asked for — so a click on the
   icon clears the text and the conversation and leaves the visualizer where
   it was. Hiding the strip outright is still a thing you can do: this icon's
   menu, or ⌃⌥Space. */
function trayClick () {
  if (!win || win.isDestroyed() || !win.isVisible()) return showWindow()
  send('command', 'dismiss')
}

function refreshTray () {
  if (!tray) return
  const visible = win && !win.isDestroyed() && win.isVisible()
  tray.setToolTip(`transvibe — ${listening ? 'listening' : 'paused'}`)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: visible ? 'Hide transvibe' : 'Show transvibe', click: toggleWindow },
    { label: 'Toggle', accelerator: 'Control+Alt+Space', visible: false, click: toggleWindow },
    { type: 'separator' },
    {
      label: 'Listening',
      type: 'checkbox',
      checked: listening,
      click: () => setListening(!listening)
    },
    { label: 'Speak a command', accelerator: 'Control+Alt+C', click: () => armCommandMode() },
    { label: 'Send to frontmost app', accelerator: 'Control+Alt+Enter', click: () => send('command', 'send') },
    { label: 'Copy transcript', click: () => send('command', 'copy') },
    { label: 'Clear transcript', click: () => send('command', 'clear') },
    { type: 'separator' },
    // The panels live on the strip, which is hidden half the time — so the
    // menu shows the strip on the way, rather than opening a panel onto
    // nothing.
    { label: 'Settings…', accelerator: 'Command+,', click: () => openPanel('settings') },
    { label: 'Glossary…', click: () => openPanel('glossary') },
    { label: 'Keys & commands…', click: () => openPanel('help') },
    { type: 'separator' },
    {
      label: 'Launch at login',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: item => setLoginItem(item.checked)
    },
    { label: 'Reveal model folder', click: revealModelFolder },
    { type: 'separator' },
    { label: 'Show/hide shortcut: ⌃⌥Space', enabled: false },
    { type: 'separator' },
    { label: 'Quit transvibe', accelerator: 'Command+Q', click: () => app.quit() }
  ]))
}

/* A panel is the renderer's to open; all the menu does is make sure there is
   something to open it onto. */
function openPanel (name) {
  showWindow()
  send('command', name)
}

/* The folder worth opening is the one holding the model actually loaded —
   which is usually another app's, because transvibe only downloads one if it
   cannot find any. openPath on a directory that does not exist fails silently,
   so our own is created on the way rather than opening nothing. */
function revealModelFolder () {
  const inUse = findModel(settings.modelPath)
  if (inUse) return shell.showItemInFolder(inUse)
  fs.mkdirSync(MODELS_DIR, { recursive: true })
  shell.openPath(MODELS_DIR)
}

/* macOS files the login item against whatever bundle is running. Launched from
   Transvibe.app that is the app; launched with `npm start` it is Electron
   itself, which is worth saying out loud rather than quietly registering the
   wrong thing. */
function setLoginItem (openAtLogin) {
  app.setLoginItemSettings({ openAtLogin })
  refreshTray()
  if (openAtLogin && !app.isPackaged) {
    send('status', {
      state: 'error',
      message: 'Login item registered against Electron — install Transvibe.app (script/install-launcher.sh) for this to open the real app.'
    })
  }
}

function createTray () {
  const icon = nativeImage.createFromPath(
    path.join(__dirname, '..', 'assets', 'trayTemplate.png'))
  icon.setTemplateImage(true)          // adapts to light/dark menu bars
  tray = new Tray(icon)
  tray.on('click', trayClick)          // left click clears, right click menus
  refreshTray()
}

function send (channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

/* The names the agents answer to. The transcriber needs them for one reason
   only: an utterance that is nothing but a name is somebody being addressed,
   which is the one case the glossary-echo rule must not throw away. */
function agentNames () {
  return (Array.isArray(settings.agents) ? settings.agents : [])
    .flatMap(a => a ? [a.name, ...(Array.isArray(a.aliases) ? a.aliases : [])] : [])
    .filter(Boolean)
}

async function initEngine () {
  let modelPath = findModel(settings.modelPath)

  if (!modelPath) {
    send('status', { state: 'downloading', message: 'Downloading base.en model…' })
    try {
      modelPath = await downloadModel('base.en', pct =>
        send('status', { state: 'downloading', progress: pct }))
    } catch (err) {
      return send('status', { state: 'error', message: `Model download failed: ${err.message}` })
    }
  }

  try {
    engine = createEngine({
      modelPath,
      language: settings.language,
      vocabulary: settings.vocabulary,
      corrections: settings.corrections,
      dropGlossaryEcho: settings.dropGlossaryEcho,
      confidenceFloor: settings.confidenceFloor,
      wakeConfidenceFloor: settings.wakeConfidenceFloor,
      names: agentNames(),
      vad: { enabled: settings.vad, modelPath: await vadModel(), threshold: settings.vadThreshold }
    })
    await engine.start()
    send('status', { state: 'ready', message: path.basename(modelPath), mode: engine.mode })
    initAssist()
    initRemote()
  } catch (err) {
    send('status', { state: 'error', message: err.message })
  }
}

/* The speech detector, fetched on the way past if it is wanted and missing.

   Best-effort on purpose. The app already works with no network once a whisper
   model is on disk, and gaining a gate must not cost that: a failed download
   returns null, `vadArgs` sees no file and emits no flags, and what is left is
   exactly the app as it was — confidenceFloor and the artifact rules doing the
   work alone. Under a megabyte, so there is no progress to report. */
async function vadModel () {
  if (!settings.vad) return null
  const found = findVadModel()
  if (found) return found
  try {
    return await downloadVadModel()
  } catch (err) {
    send('status', { state: 'error', message: `Speech detector unavailable: ${err.message}` })
    return null
  }
}

/* Both VAD settings are whisper-server startup flags, so the only way to
   change one is to bring the sidecar back up with it. Costs a model reload —
   about a second — during which `transcribe` answers 'engine not ready', which
   is the truth. */
async function restartEngine () {
  if (engine) engine.stop()
  engine = null
  await initEngine()
}

/* The assist model is optional in the strongest sense: if Ollama is not
   running or the model was never pulled, `check()` comes back false and every
   later call short-circuits, leaving the app exactly as it was. */
async function initAssist () {
  /* Only an agent that thinks on this machine is a reason to want Ollama. A
     roster whose chat agent answers through `claude` needs no local model at
     all, and warning that one is missing would be telling someone to start a
     server nothing is going to ask anything. */
  const talks = (settings.agents || []).some(a => a.kind === 'chat' && !isRemote(a))
  const asked = settings.cleanup || settings.commandFallback || talks
  // Spoken replies will use the model to shorten a line if it happens to be
  // there, but they work without it, so wanting them is not a reason to go
  // looking for Ollama on someone who never asked for it — only a reason to
  // keep the handle if one of the other two already did.
  if (!asked && !settings.speakReplies) { assist = null; return }
  // A chat agent that cannot reach Ollama is worth saying out loud: unlike the
  // other two, it is the whole of what that name does.
  /* The model the app thinks with when it is being nobody in particular —
     tidying dictation, which is addressed to no name. Each agent's own model
     overrides it at the point of use. */
  const model = defaultModel(settings.agents)
  assist = createAssist({ url: settings.assistUrl, model })
  const ok = await assist.check()
  // Only the features that cannot work without it are worth an error.
  if (!ok && asked) {
    send('status', { state: 'error', message: `${model} not available — is Ollama running?` })
  }
}

/* ------------------------------------------------------------ the CLIs

   The frontier side has no server to be running and no model to have been
   pulled: it is two command-line tools the user installed for their own
   reasons and is already signed in to. So the only thing worth checking at
   startup is whether the binary exists, and the only thing worth saying is
   that a name on the roster is pointed at one that does not.

   Checked once, like assist.check(), and deliberately not checked for a login:
   that would be a billed question asked at every launch to learn what the
   first real question learns for free. */
async function initRemote () {
  cancelRemote()
  remotes = new Map()
  if (!settings.remote) return

  const wanted = [...new Set((settings.agents || []).filter(isRemote).map(a => a.provider))]
  const missing = []
  for (const provider of wanted) {
    if (!await remoteFor(provider).check()) missing.push(provider)
  }
  if (missing.length) {
    send('status', {
      state: 'error',
      message: `${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not installed — the agents pointed at ${missing.length > 1 ? 'them' : 'it'} cannot answer`
    })
  }
}

function remoteFor (provider) {
  if (!remotes.has(provider)) {
    remotes.set(provider, createCliAgent({
      provider,
      timeoutMs: settings.remoteTimeoutMs,
      webSearch: settings.remoteWebSearch
    }))
  }
  return remotes.get(provider)
}

/* Kill everything in flight. Called by "stop", and on the way out — an
   unwatched subprocess spending someone's subscription after the app has
   quit is the worst thing this feature could leave behind. */
function cancelRemote () {
  for (const cli of remotes.values()) cli.cancel()
}

app.whenReady().then(async () => {
  const granted = await systemPreferences.askForMediaAccess('microphone').catch(() => false)
  createWindow()
  if (settings.debugRecording) debugRecording.start(settings)

  win.webContents.once('did-finish-load', () => {
    if (!granted) {
      send('status', {
        state: 'error',
        message: 'Microphone access denied — enable it in System Settings › Privacy & Security › Microphone.'
      })
    }
    initEngine()
  })

  createTray()
  tray.setTitle(debugRecording.status.active ? '● REC' : '')

  startKeyTap()

  const shortcuts = [
    ['Control+Alt+Space', toggleWindow, 'show/hide'],
    ['Control+Alt+C', () => armCommandMode(), 'command mode'],
    ['Control+Alt+Enter', () => send('command', 'send'), 'send transcript']
  ]
  for (const [accel, fn, what] of shortcuts) {
    // register() returns false when another app already owns the combination
    if (!globalShortcut.register(accel, fn)) {
      console.warn(`[transvibe] could not register ${accel} for ${what}`)
      send('status', { state: 'error', message: `${accel} is taken by another app` })
    }
  }

  app.on('activate', showWindow)
})

/* ------------------------------------------------------------- command mode */

/* Electron's globalShortcut only fires on key-down — there is no key-up — so a
   literal hold-to-talk would need a native CGEventTap and Accessibility
   permission. Arming for a single utterance gives the same property that
   matters: there is no mode you can get stranded in. */
function armCommandMode ({ hold = false } = {}) {
  if (!win || win.isDestroyed()) return
  send('command-mode', true)
  clearTimeout(commandTimer)
  // No deadline while the key is physically down — the hold IS the deadline.
  commandTimer = hold
    ? null
    : setTimeout(() => send('command-mode', false), settings.commandTimeoutMs)
}

function disarmCommandMode () {
  clearTimeout(commandTimer)
  commandTimer = null
}

/**
 * Hold-to-command on the right Option key.
 *
 * Releasing the key does NOT end command mode: the utterance is usually still
 * open when your thumb comes up, and the VAD needs its silence window to close
 * it. Release just starts the idle timeout; the renderer disarms itself once it
 * has consumed one utterance.
 */
function startKeyTap () {
  const bin = path.join(__dirname, '..', '..', 'bin', 'rightopt')
  if (!existsSync(bin)) {
    console.warn('[transvibe] bin/rightopt not built — run: npm run build:native')
    return
  }

  tapProc = spawn(bin, [], { stdio: ['ignore', 'pipe', 'pipe'] })

  let buf = ''
  tapProc.stdout.on('data', chunk => {
    buf += chunk
    const lines = buf.split('\n')
    buf = lines.pop()
    for (const line of lines) {
      if (line === 'down') {
        holding = true
        armCommandMode({ hold: true })
      } else if (line === 'up' && holding) {
        holding = false
        clearTimeout(commandTimer)
        commandTimer = setTimeout(
          () => send('command-mode', false), settings.commandTimeoutMs)
      }
    }
  })

  tapProc.stderr.on('data', d => {
    if (String(d).includes('tap-denied')) {
      console.warn('[transvibe] Input Monitoring denied; right-Option hold disabled')
      send('status', {
        state: 'error',
        message: 'Right ⌥ hold needs Input Monitoring — System Settings › Privacy & Security'
      })
    }
  })

  tapProc.on('error', err =>
    console.warn('[transvibe] key tap failed:', err.message))
}

/* ---------------------------------------------------------------- send ------ */

const wait = ms => new Promise(r => setTimeout(r, ms))

/**
 * Deliver the transcript into another app.
 *
 * Pasting beats synthesising the text keystroke by keystroke: it is instant,
 * and it cannot mangle characters the target app treats specially.
 *
 * The subtle part is focus. If transvibe has it, ⌘V would land in our own
 * window, so we hide first — which returns macOS focus to whatever app you
 * were in before. When the send is triggered by the global shortcut we never
 * had focus in the first place, and the target is already frontmost.
 */
async function sendTranscript (text) {
  if (!text || !text.trim()) return { ok: false, error: 'nothing to send' }

  const bin = path.join(__dirname, '..', '..', 'bin', 'sendkeys')
  clipboard.writeText(text)
  if (!existsSync(bin)) {
    return { ok: false, error: 'copied — build bin/sendkeys to paste automatically' }
  }

  const hadFocus = win && !win.isDestroyed() && win.isFocused()
  if (hadFocus) {
    app.hide()
    await wait(180)
  }

  if (settings.sendTarget) {
    // an explicit target wins over "whatever is in front"
    spawn('open', ['-a', settings.sendTarget], { stdio: 'ignore' })
    await wait(320)
  }

  return await new Promise(resolve => {
    const args = settings.sendPressesEnter ? ['--enter'] : []
    const p = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    p.stderr.on('data', d => { err += d })
    p.on('error', e => resolve({ ok: false, error: e.message }))
    p.on('close', code => resolve(code === 0
      ? { ok: true, target: settings.sendTarget || 'the frontmost app' }
      : { ok: false, error: err.trim() || 'paste needs Accessibility permission' }))
  })
}

/* Everywhere "switch to" can go: the markers, and whatever is running. The
   list reaches the renderer without its paths — the parser only needs the
   names to recognise one being said, and the jump is this end's job anyway. */
const spaceList = () => listSwitchTargets(settings.spacesDir)

/* How long to leave between two markers. Empirical, and the same order as the
   waits in the space-markers launcher: the desktop switch is an animation, and
   activating the second marker while the first is still moving loses the
   second jump. */
const SPACE_SWITCH_MS = 500

/**
 * Go where a target is, by clicking its Dock tile.
 *
 * Not by opening it, which is the obvious thing and does not work: `open -a`
 * hands the app the menu bar and leaves the desktop where it was. The Dock
 * click is what macOS treats as worth following.
 *
 * Resolves once the target is actually frontmost, not once the click has been
 * made. "Switch to slack and send it" depends on that: the paste goes to
 * whatever is in front, so the next command must not start until the switch
 * has landed.
 *
 * The fallback is that same `open -a`, for when the click cannot be made —
 * Accessibility not granted, or no tile because the app was quit. It activates
 * without going anywhere, which is not the jump, but it does leave the app
 * running so the next attempt has a tile to click.
 */
async function activateSpace (space) {
  const result = await new Promise(resolve => {
    const p = spawn('osascript', ['-e', dockClickScript(space.title)],
      { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    p.stdout.on('data', d => { out += d })
    p.stderr.on('data', d => { err += d })
    p.on('error', e => resolve({ ok: false, error: e.message }))
    /* A timeout is a slow switch, not a failed one — the click was made, and
       falling back to `open -a` on top of it would only muddle the focus. */
    p.on('close', code => resolve(code === 0
      ? { ok: true, front: out.trim() === 'front' }
      : { ok: false, error: err.trim() || 'could not click the Dock tile' }))
  })
  if (!result.ok) spawn('open', ['-a', space.app], { stdio: 'ignore' })
  return result
}
const spaceNames = async () =>
  (await spaceList()).map(({ name, key, keys }) => ({ name, key, keys }))

/* ---------------------------------------------------------------------- IPC */

ipcMain.handle('spaces:list', () => spaceNames())

/* One name or several. With two displays there are two current desktops, and
   "switch to home and communications" moves both — so this takes a list, in
   the order they were said, and the last one named is the one left in front. */
ipcMain.handle('space:open', async (_e, keys) => {
  const wanted = Array.isArray(keys) ? keys : [keys]
  const all = await spaceList()
  const found = wanted.map(key => all.find(s => s.key === key)).filter(Boolean)
  if (!found.length || found.length !== wanted.length) {
    return { ok: false, error: 'no such space' }
  }

  /* Two markers on one display: the second lands on top of the first, so the
     first jump is real for a moment and then gone. Reported rather than
     refused — the jump that survives is still the one that was asked for. */
  const clashed = []
  const perDisplay = new Map()
  for (const space of found) {
    if (space.display == null) continue
    if (perDisplay.has(space.display)) clashed.push(perDisplay.get(space.display), space.name)
    perDisplay.set(space.display, space.name)
  }

  const stuck = []
  for (const [i, space] of found.entries()) {
    if (i) await wait(SPACE_SWITCH_MS)
    const jumped = await activateSpace(space)
    if (!jumped.ok) stuck.push(space.name)
  }

  return {
    ok: true,
    name: found.map(s => s.name).join(', '),
    clashed: [...new Set(clashed)],
    stuck
  }
})

ipcMain.handle('send', async (_e, text) => {
  const result = await sendTranscript(text)
  if (result.ok && settings.clearAfterSend) send('command', 'clear')
  return result
})

/* The renderer arms this too, when it hears the wake phrase on its own. It
   goes back through here rather than running a second timer over there, so
   there is one deadline and one place that owns it. */
ipcMain.on('command-mode', (_e, active) => {
  if (active) armCommandMode()
  else disarmCommandMode()
})

ipcMain.handle('debug:status', () => debugRecording.status)
ipcMain.on('debug:event', (_e, type, detail) => debugRecording.event(type, detail))
ipcMain.on('debug:audio', (_e, buffer, detail) => {
  if (buffer instanceof ArrayBuffer && buffer.byteLength <= 16000 * 4) {
    debugRecording.audio(new Float32Array(buffer), detail)
  }
})

ipcMain.handle('transcribe', async (_e, buffer, interim = false, retryBuffer = null, context = '') => {
  const debugId = randomUUID()
  const session = debugRecording.status.id
  const samples = new Float32Array(buffer)
  const audio = !interim ? debugRecording.segment(samples, debugId) : null
  debugRecording.event('transcription-start', { debugId, interim, audio, durationSeconds: samples.length / 16000 })
  if (!engine) {
    debugRecording.event('transcription-result', { debugId, interim, error: 'engine not ready' }, session)
    return { text: '', error: 'engine not ready', debugId }
  }
  try {
    const retrySamples = retryBuffer instanceof ArrayBuffer && retryBuffer.byteLength <= 16000 * 4 * 30
      ? new Float32Array(retryBuffer) : null
    const retryContext = typeof context === 'string' ? context.slice(-400) : ''
    const result = await engine.transcribe(samples, { interim, context: retryContext, retrySamples })
    if (result.retry) {
      result.retry.context = retryContext
      result.retry.audio = retrySamples ? debugRecording.segment(retrySamples, `${debugId}-retry`) : audio
    }
    // only a settled utterance is worth putting on the clipboard
    if (result.text && !interim && settings.autoCopy) clipboard.writeText(result.text)
    debugRecording.event('transcription-result', { debugId, interim, ...result }, session)
    return { ...result, debugId }
  } catch (err) {
    debugRecording.event('transcription-result', { debugId, interim, error: err.message }, session)
    return { debugId, text: '', error: err.message }
  }
})

/* Scored on the same samples the recogniser is given, and deliberately not
   awaited together with it: the renderer fires this alongside `transcribe`
   and joins before deciding who was addressed, so the measurement costs
   nothing on a pass that whisper is already paying for. */
ipcMain.handle('voiceprint:score', (_e, buffer) => {
  if (!(buffer instanceof ArrayBuffer)) return { score: null }
  const samples = new Float32Array(buffer)
  const score = voiceprint.score(samples)
  return { score, seconds: samples.length / 16000 }
})

ipcMain.handle('voiceprint:status', () => ({ ...voiceprint.status, threshold: settings.voiceprintThreshold }))

ipcMain.handle('voiceprint:enroll', (_e, buffers) => {
  const list = (Array.isArray(buffers) ? buffers : [])
    .filter(b => b instanceof ArrayBuffer)
    .map(b => new Float32Array(b))
  const result = voiceprint.enroll(list)
  /* Enrolling is the only moment the gate can be switched on without it
     being a setting that does nothing: before this there was no voice to
     compare against, and after it there is. */
  if (result.ok && !settings.voiceprint) settings = config.save({ voiceprint: true })
  send('voiceprint:status', { ...voiceprint.status, threshold: settings.voiceprintThreshold })
  return result
})

ipcMain.handle('voiceprint:probe', (_e, buffers) => voiceprint.probe(
  (Array.isArray(buffers) ? buffers : []).filter(b => b instanceof ArrayBuffer).map(b => new Float32Array(b))))

ipcMain.handle('voiceprint:forget', () => {
  const result = voiceprint.forget()
  settings = config.save({ voiceprint: false })
  send('voiceprint:status', { ...voiceprint.status, threshold: settings.voiceprintThreshold })
  return result
})

ipcMain.handle('voiceprint:download', async () => {
  if (voiceprintModelReady()) return { ok: true, already: true }
  try {
    await downloadVoiceprintModel(progress => send('voiceprint:progress', progress))
    send('voiceprint:status', { ...voiceprint.status, threshold: settings.voiceprintThreshold })
    return { ok: true }
  } catch (err) { return { ok: false, error: err.message } }
})

ipcMain.handle('settings:get', () => settings)
/* What the app would hold if it had never been told otherwise. The panel uses
   it to mark the rows you have moved and to move them back, which is the only
   way to undo a setting you tuned by ear and lost track of. */
ipcMain.handle('settings:defaults', () => config.DEFAULTS)
ipcMain.handle('settings:set', (_e, patch) => {
  settings = config.save(patch)
  if ('debugRecording' in patch) {
    if (settings.debugRecording) debugRecording.start(settings)
    else debugRecording.stop()
    if (tray) tray.setTitle(debugRecording.status.active ? '● REC' : '')
    send('debug:status', debugRecording.status)
  }
  debugRecording.event('settings-change', { patch })
  // Glossary edits apply to the next utterance — no need to restart the server.
  if (engine && ('vocabulary' in patch || 'corrections' in patch ||
      'dropGlossaryEcho' in patch || 'wakeConfidenceFloor' in patch || 'confidenceFloor' in patch || 'agents' in patch)) {
    engine.setGlossary({
      vocabulary: settings.vocabulary,
      corrections: settings.corrections,
      dropGlossaryEcho: settings.dropGlossaryEcho,
      confidenceFloor: settings.confidenceFloor,
      wakeConfidenceFloor: settings.wakeConfidenceFloor,
      // Renaming an agent renames what the echo rule has to let through.
      names: agentNames()
    })
  }
  if ('vad' in patch || 'vadThreshold' in patch) restartEngine()
  if ('cleanup' in patch || 'commandFallback' in patch || 'agents' in patch ||
      'assistUrl' in patch || 'speakReplies' in patch) {
    initAssist()
  }
  /* A changed timeout or a changed switch has to reach the handles themselves,
     not just the next question — they were built with the old numbers in
     them. Turning `remote` off goes through here too, and kills anything
     already running rather than letting one last question out the door. */
  if ('remote' in patch || 'remoteTimeoutMs' in patch || 'remoteWebSearch' in patch ||
      'agents' in patch) {
    initRemote()
  }
  // Turning replies off mid-sentence should stop the sentence.
  if ('speakReplies' in patch && !settings.speakReplies) stopSpeaking()
  if ('alwaysOnTop' in patch && win) {
    win.setAlwaysOnTop(settings.alwaysOnTop, 'screen-saver')
  }
  if ('stripHeight' in patch || 'panelHeight' in patch) applyStripBounds()
  /* The orb is created and destroyed live, because creating a small window is
     cheap and a visual setting you have to relaunch to see is one you tune
     badly. Its cost dials go through to the renderer, which rebuilds. */
  if ('layout' in patch || 'orbSize' in patch || 'orbMargin' in patch ||
      'orbPosition' in patch) syncOrb()
  if ('orbSeeds' in patch || 'orbSteps' in patch || 'orbSayScale' in patch ||
      'orbZoomGain' in patch || 'orbZoomDecay' in patch ||
      'vizFps' in patch || 'vizQuietFps' in patch) {
    sendOrb('orb:settings', settings)
  }
  if ('alwaysOnTop' in patch && orbWin && !orbWin.isDestroyed()) {
    orbWin.setAlwaysOnTop(settings.alwaysOnTop, 'screen-saver')
  }
  // A new folder means a new set of names the parser will answer to.
  if ('spacesDir' in patch) spaceNames().then(list => send('spaces', list))
  return settings
})

/* Dictation, and only the local model.
 *
 * This handler and assist:command are the two that see words nobody addressed
 * to anyone — a room microphone hears the whole room, and what it hears is
 * tidied and parsed here. Neither of them may ever leave the machine, whatever
 * `remote` says, and the way that is guaranteed is structural rather than by
 * a check: they call `assist`, which is a createAssist bound to
 * settings.assistUrl (127.0.0.1), and there is no path from either of them to
 * `remotes`, to remoteFor(), or to any argv. There is deliberately no
 * `provider` in what they accept, so there is nothing for a caller to pass.
 */
ipcMain.handle('assist:cleanup', async (_e, text) => {
  if (!assist || !settings.cleanup) return { text, used: false, reason: 'off' }
  return assist.cleanup(text)
})

/* ------------------------------------------------- asking, and asking better

   A question addressed to a chat agent can be answered three ways: by the
   small model on this machine, by a frontier CLI the agent hands off to when
   that model is out of its depth, or by a CLI directly, because the question
   was about today and nothing local was ever going to know.

   The renderer asks once. Which route the answer took comes back on it as
   `via` (the agent that actually spoke) and `escalated` (why it was not the
   one asked), so the bubble can be labelled and the attribution spoken. The
   deciding is all in shared/escalate.js, which is pure and tested; what is
   here is the plumbing between that decision and two processes.

   The rule that outranks the rest: an answer already in hand is never thrown
   away for one that did not arrive. Every remote path below falls back to the
   local answer, so being offline costs the escalation and nothing else. */

/* How many questions may leave the machine in a day.

   Not a budget — the CLIs bill against a subscription, not per call — but a
   fuse. The failure this exists for is a loop: an agent escalating to an
   agent escalating back, or a microphone in a room with a television, quietly
   spending someone's rate limit while they are out. Fifty is far past a day
   of asking questions on purpose and nowhere near a day of asking them by
   accident. */
const DAILY_REMOTE_CALLS = 50

const CAP_NOTE =
  `that's ${DAILY_REMOTE_CALLS} questions sent out today, which is the daily limit`

/* Today's count and what is left of it. Kept in settings rather than in a
   variable so that quitting the app is not a way to reset it. */
/* Beside settings.json rather than in a log folder of its own: it is a thing
   about this app's configuration, you turned it on in the panel, and the panel
   can tell you where to look in one short sentence. */
const ROUTING_LOG = path.join(config.DIR, 'routing.log')

/* Truncated rather than rotated at half a megabyte — a few thousand questions.
   Rotation is a filing system for something nobody files: this log is read
   while chasing one answer that went wrong, and what matters is that the last
   few are in it and that a flag left on for a month is not a disk you have to
   go and find. */
const ROUTING_LOG_MAX = 512 * 1024

/**
 * One line about how a question was answered, when the flag is on.
 *
 * Never throws and never awaits: a debug log that can fail a question, or slow
 * one down, is worse than no debug log. Anything that goes wrong here — a full
 * disk, a read-only home directory — leaves the answer exactly as it was.
 *
 * @param {string} event  what happened: 'ask', 'remote', 'escalate'
 * @param {object} detail whatever is worth knowing about it
 */
function logRouting (event, detail) {
  debugRecording.event(`routing-${event}`, detail)
  if (!settings.debugRouting) return
  try {
    if (fs.existsSync(ROUTING_LOG) && fs.statSync(ROUTING_LOG).size > ROUTING_LOG_MAX) {
      fs.rmSync(ROUTING_LOG, { force: true })
    }
    fs.appendFileSync(ROUTING_LOG,
      `${JSON.stringify({ at: new Date().toISOString(), event, ...detail })}\n`)
  } catch {
    // Nothing to say about it, and nowhere to say it.
  }
}

function remoteBudget () {
  const day = new Date().toISOString().slice(0, 10)
  const used = (settings.remoteCallsToday || {})[day] || 0
  return { day, used, left: DAILY_REMOTE_CALLS - used }
}

function countRemoteCall () {
  const { day, used } = remoteBudget()
  /* Counted before the call, not after: a question that timed out still went
     out, and a cap that only counted the answers would be no cap at all on the
     failure mode that runs away. Only today's row is kept — yesterday's number
     answers nothing anyone will ask, and a file that grows a line a day for
     ever is a leak with a slow fuse. */
  settings = config.save({ remoteCallsToday: { [day]: used + 1 } })
}

/* The jobs allowed to leave this machine.

   Not a permission check in any real sense — the four call sites are all in
   the next hundred lines and every one of them passes a literal. It is a name
   for the invariant, so that a fifth job cannot reach a CLI without somebody
   typing it here and reading what that means. The two jobs that may never get
   here (cleanup, commandFallback) cannot reach this function at all, and
   test/boundary.test.js is what keeps that true; this catches the other way
   in, which is a new handler calling askRemote directly. */
const REMOTE_JOBS = new Set(['chat', 'fresh', 'asked', 'verification'])

/* How the escalation rules are doing. Numbers, and nothing else.

   Two rates come out of this, per rule. How often it fires and the better
   model then says the same thing anyway — that is the rule reaching for a
   frontier model to be told what gemma already said, and eight seconds of a
   quiet room for it. And how often you reached past it yourself: `asked` is
   "Mira, ask Claude about this", which is you saying the rule should have
   fired and did not. Those are the only two errors this can make, and both
   of them are counted here without anyone having to keep notes.

   No question and no answer is written down. The strip forgets a transcript
   twenty seconds after you stop talking, and a permanent ledger of everything
   you ever asked out loud would be the one place in this app that did not.
   The text belongs in routing.log, behind a flag you turned on and can
   delete. This is counters, always on, and it says nothing about you. */
function countRouting (reason, agreed = null) {
  if (!reason) return
  const stats = settings.routingStats || {}
  const row = { fired: 0, agreed: 0, differed: 0, ...(stats[reason] || {}) }
  row.fired += 1
  /* Three-valued, because answersAgree is: an answer with no content words in
     it settles nothing, and rounding it to either side would put noise into
     the only numbers there are. */
  if (agreed === true) row.agreed += 1
  if (agreed === false) row.differed += 1
  settings = config.save({ routingStats: { ...stats, [reason]: row } })
}

/* How the picker's "2.7s last answer" line finds a measurement again.

   A local model is keyed by its Ollama tag, as it always has been. A remote
   one is keyed 'provider:model', because 'claude-sonnet-5' spoken by claude
   and the same name typed into Advanced are not the same thing and must not
   share a row. codex names no model — the CLI picks its own — so it is keyed
   by the provider alone. */
const statKey = (provider, model) => provider === 'local' || !provider
  ? model || null
  : (model ? `${provider}:${model}` : provider)

function noteModelStat (answer, provider = 'local') {
  if (!answer || !answer.ok || !Number.isFinite(answer.ms)) return
  const key = statKey(provider, answer.model)
  if (!key) return
  /* Kept for the picker. One answer is a small sample and the panel says so
     by calling it the last one rather than an average — an average over a
     cold start and five warm ones describes neither.

     The two sides report tokens differently: Ollama gives a count, a CLI gives
     {input, output}. What the picker shows is how much was said, so the output
     half is the one that carries over. */
  const tokens = typeof answer.tokens === 'number'
    ? answer.tokens
    : (answer.tokens && answer.tokens.output) || 0
  settings = config.save({
    modelStats: {
      ...settings.modelStats,
      [key]: { ms: answer.ms, tokens, at: Date.now() }
    }
  })
}

const agentNamed = name => (settings.agents || []).find(a =>
  a.name.toLowerCase() === String(name || '').trim().toLowerCase()) || null

/* Who was asked.
 *
 * The renderer names them. A caller that does not — every caller before this
 * feature existed — leaves only a model to go on, and a roster with exactly
 * one chat agent has only one answer to give anyway. With two of them and no
 * name, there is no chain to follow and the question is answered locally,
 * which is what it did yesterday. */
function askingAgent (options = {}) {
  const named = agentNamed(options.agent)
  if (named) return named
  const chat = (settings.agents || []).filter(a => a.kind === 'chat')
  return chat.length === 1 ? chat[0] : null
}

async function askLocal (question, history, options = {}) {
  if (!assist) return { text: '', ok: false, reason: 'the local model is not running' }
  const answer = await assist.ask(question, history, options)
  noteModelStat(answer, 'local')
  if (answer.ok && claimsLocalSearch(answer.text)) {
    debugRecording.event('unsupported-search-claim', { text: answer.text, question })
    return { ...answer, text: UNVERIFIED, spoken: UNVERIFIED, verification: 'unconfirmed' }
  }
  return answer
}

/* One question, out to a CLI. The only function in this file that spawns
   anything, so it is the only place the cap and the counter have to be. */
async function askRemote (agent, question, history, { job, priorAnswer = '', webSearch, canEscalate = false } = {}) {
  /* Fails closed rather than throwing. Every caller below already falls back
     to the local model when this does not answer, so a job that should not be
     here costs an escalation and not the question. */
  if (!REMOTE_JOBS.has(job)) {
    logRouting('remote', { agent: agent.name, job, ok: false, reason: 'not a job that may leave the machine' })
    return { text: '', ok: false, reason: 'that is not a question this app sends out' }
  }
  countRemoteCall()
  const cli = remoteFor(agent.provider)
  const started = Date.now()
  const answer = await cli.ask(question, history, {
    model: agent.model,
    priorAnswer,
    /* Whether declining would get the question a better answer. Almost never,
       once you are already at the frontier: behind it is only the small model
       on this machine. */
    canEscalate,
    // Web search is codex's flag and codex's alone; claude, measured, has no
    // live access whatever it is asked.
    webSearch: agent.provider === 'codex' && (webSearch ?? settings.remoteWebSearch)
  })
  noteModelStat(answer, agent.provider)
  logRouting('remote', {
    agent: agent.name,
    job,
    provider: agent.provider,
    model: answer.model,
    ok: answer.ok,
    reason: answer.reason,
    ms: answer.ms ?? Date.now() - started,
    costUsd: answer.costUsd,
    text: answer.text
  })
  return answer
}

/* Walk the escalation chain until somebody answers.
 *
 * A hop onto another *local* agent is allowed and is not a remote call: a
 * roster where the fast little model hands off to a big one on the same
 * machine is a sensible thing to want and costs nothing but a second. Only the
 * remote hops are capped and counted.
 *
 * Returns {} when nobody answered, which the caller reads as "keep what you
 * already had". */
/**
 * Down the escalation chain until somebody answers.
 *
 * What is deliberately *not* passed on is what the local model already said.
 * Handing it over asks the frontier model to grade a colleague, and it does:
 * every answer came back as "that reply was wrong — " followed by the actual
 * answer, which is a critique of gemma nobody asked to hear read out loud. You
 * asked a question. The correction is only wanted when you asked for one, so
 * the prior answer goes only down the manual "ask Claude about this" route.
 */
async function walkChain (chain, question, history, request) {
  let capped = false
  for (const target of chain) {
    request.check()
    let answer
    if (isRemote(target)) {
      if (!settings.remote) continue
      if (remoteBudget().left <= 0) {
        capped = true
        continue
      }
      /* Always the same job: walkChain exists for one caller, the chain
         behind a question somebody asked a chat agent. */
      answer = await askRemote(target, question, history, { job: 'chat' })
    } else {
      answer = await askLocal(question, history,
        { model: target.model, thinking: target.thinking })
    }
    request.check()
    if (answer.ok && answer.text) return { answer, via: target, capped }
  }
  return { capped }
}

/* What comes back when the day's questions are used up. Said rather than
   swallowed: an escalation that silently did not happen looks exactly like a
   local model that got it right, which is the one thing it must not look
   like. The local answer, if there is one, is still the answer. */
function cappedResult (local, name) {
  if (local && local.ok) {
    return { ...local, via: name || null, escalated: null, capped: true, note: CAP_NOTE }
  }
  return {
    text: '',
    ok: false,
    reason: CAP_NOTE,
    via: name || null,
    escalated: null,
    capped: true,
    ms: (local && local.ms) || 0,
    tokens: null,
    model: (local && local.model) || null
  }
}

/* A question asked of a chat agent. The agent names its own model, so one
   name can be answered by something better than the small model doing the
   cleanup — measured on this machine, gemma4:e2b calls a VAD "video-assisted
   delivery" and llama3 gets it right. */
const chatRequests = createLatestRequest()
ipcMain.handle('assist:ask', async (_e, question, history, options) => {
  const request = chatRequests.begin()
  cancelRemote()
  try { return await answerChat(question, history, options, request) } catch (err) {
    if (err.code === 'TURN_CANCELLED') return { text: '', ok: false, reason: 'cancelled' }
    throw err
  }
})

async function answerChat (question, history, options, request) {
  const opts = options || {}
  const asked = String(question == null ? '' : question)
  const agent = askingAgent(opts)
  if (isAcknowledgment(asked)) return { text: '', ok: true, silent: true }
  const fact = conversationFact(asked, history)
  if (fact) return fact
  if (needsVerification(asked, history)) {
    const chain = agent ? escalationChain(settings.agents, agent) : []
    const target = [agent, ...chain].find(a => a?.provider === 'codex')
    if (!settings.remote || !settings.remoteWebSearch || !target || remoteBudget().left <= 0) {
      return { ...verificationReply(null), via: agent?.name }
    }
    const query = `${asked}\nVerify using an actual source. Return the finding, the publication name, and the source URL, or plainly say you could not verify it. Do not answer with a promise to search.`
    const result = await request.wait(askRemote(target, query, history, { job: 'verification', webSearch: true }))
    return { ...verificationReply(result), via: target.name, escalated: 'verification' }
  }

  /* Off is off. Not "off unless", not "off but for this one": with the switch
     down, nothing below this line runs, and this handler is the one it was
     before the feature existed. */
  if (!settings.remote) {
    if (agent && isRemote(agent)) {
      return {
        text: '',
        ok: false,
        reason: `${agent.name} answers through ${agent.provider}, and remote answers are off`
      }
    }
    return request.wait(askLocal(asked, history, opts))
  }

  const chain = agent ? escalationChain(settings.agents, agent) : []

  /* The agent itself is a CLI. There is no local attempt to make first — the
     name means "ask claude", and asking a two-billion-parameter model on the
     way would only add half a second and an answer nobody wanted. */
  if (agent && isRemote(agent)) {
    /* Logged here as well as on the local path. Without this the log jumps
       from somebody else's question straight to an orphan `remote` line, and
       the one thing you went to the log to find out — which question this
       was — is the thing missing from it. */
    logRouting('ask', { question: asked, agent: agent.name, direct: true, chain: chain.map(a => a.name) })
    if (remoteBudget().left <= 0) return cappedResult(null, agent.name)
    const answer = await askRemote(agent, asked, history, { job: 'chat' })
    request.check()
    if (answer.ok) {
      /* Counted apart from the rules. Nothing decided this — you asked a CLI
         by name — and folding it in would make every rule look busier than it
         is. It is worth a row of its own for the opposite reason: it says how
         much of a day's remote spend the router is not responsible for. */
      countRouting('direct')
      return { ...answer, via: agent.name, escalated: null }
    }
    /* Signed out, not installed, or a network that is not there. Degrade to
       whatever is on this machine rather than to nothing — and without the
       agent's model, which names a frontier model Ollama has never heard of.

       `via` is nobody: the answer did not come from the agent whose name is on
       the bubble, and saying "Claude said" over a sentence gemma wrote is the
       one thing this feature must never do. */
    const local = await askLocal(asked, history, { thinking: opts.thinking })
    request.check()
    return { ...local, via: null, escalated: null, remoteFailed: answer.reason }
  }

  /* A question with a date on it. Nothing on this machine has a clock or a
     network, so the local round trip is not a cheaper attempt at the answer —
     it is half a second spent on a confident wrong one. Straight to the first
     hop that can search, if there is one and if searching is switched on. */
  const fresh = settings.remoteWebSearch && needsFreshFacts(asked)
    ? chain.find(a => a.provider === 'codex')
    : null
  if (fresh && remoteBudget().left > 0) {
    const answer = await askRemote(fresh, asked, history, { job: 'fresh', webSearch: true })
    request.check()
    if (answer.ok) {
      /* Fired, and that is all this can say: there is no local answer to
         compare it with, because not asking for one is the whole point of the
         route. Whether needsFreshFacts fires when it should is settled by the
         corpus in test/routing-cases.js, which does not need a model at all. */
      countRouting('fresh')
      return { ...answer, via: fresh.name, escalated: 'fresh' }
    }
    // It did not answer, so the local model gets its ordinary turn after all.
  }

  const local = await askLocal(asked, history, { ...opts, canEscalate: chain.length > 0 })
  request.check()
  const name = agent ? agent.name : null
  const verdict = shouldEscalate(local)
  logRouting('ask', {
    question: asked,
    agent: name,
    local: { text: local.text, ok: local.ok, reason: local.reason, ms: local.ms, model: local.model },
    verdict,
    chain: chain.map(a => a.name)
  })
  if (!verdict.escalate) {
    countRouting('kept')
    return { ...local, via: name, escalated: null }
  }
  if (!chain.length) {
    // The rule fired. There was simply nobody on the roster to hand it to,
    // which is a fact about the settings and not about the rule.
    countRouting(verdict.why)
    return { ...local, via: name, escalated: null }
  }

  const { answer, via, capped } = await walkChain(chain, asked, history, request)
  if (answer) {
    /* The measurement this whole tally exists for. `unsure` is the rule that
       can be wrong in the expensive direction — it throws away an answer that
       was already in hand — and it is the only reason that arrives here with a
       local answer to compare against. `pass`, `failed` and `empty` come with
       nothing to compare, and answersAgree says so rather than guessing. */
    countRouting(verdict.why, answersAgree(local.text, answer.text))
    return { ...answer, via: via.name, escalated: verdict.why }
  }
  countRouting(verdict.why)
  if (capped) return cappedResult(local, name)
  /* Nobody better answered. The local reply — hedge, admission of defeat and
     all — is what there is, and it is still better than silence. */
  return { ...local, via: name, escalated: null }
}

/* Asked for by name, mid-conversation: "Mira, ask Claude about this."
 *
 * The same call as an automatic escalation, minus the deciding — you have
 * decided. It carries the prior answer so the frontier model is checking
 * something rather than answering into the void, and the thread so far so
 * "about this" means anything at all.
 *
 * @param {string} question   what to ask, or the thread's own last question
 * @param {string} priorAnswer what was already said, if anything
 * @param {Array} history      the thread, trimmed on the way into the prompt
 * @param {{to?: string}} options the agent named out loud */
ipcMain.handle('assist:escalate', async (_e, question, priorAnswer, history, options) => {
  const request = chatRequests.begin()
  cancelRemote()
  try { return await answerEscalation(question, priorAnswer, history, options, request) } catch (err) {
    if (err.code === 'TURN_CANCELLED') return { text: '', ok: false, reason: 'cancelled' }
    throw err
  }
})
async function answerEscalation (question, priorAnswer, history, options, request) {
  const opts = options || {}
  if (!settings.remote) {
    return { text: '', ok: false, reason: 'asking a frontier model is switched off' }
  }

  /* By roster name first, which is what the command parser sends. The bare
     provider word is accepted as well, for the roster that has a claude agent
     under some other name and a user who called it Claude anyway. */
  const named = agentNamed(opts.to)
  const target = named || (['claude', 'codex'].includes(String(opts.to || '').toLowerCase())
    ? { name: String(opts.to).toLowerCase(), provider: String(opts.to).toLowerCase(), model: null }
    : null)
  if (!target) return { text: '', ok: false, reason: `there is nobody here called ${opts.to || 'that'}` }

  const asked = String(question == null ? '' : question)
  const prior = String(priorAnswer == null ? '' : priorAnswer)

  /* Named agent, local model: still an escalation as far as the user is
     concerned — they asked somebody else — it just does not leave the room. */
  if (!isRemote(target)) {
    const answer = await askLocal(asked, history, { model: target.model, thinking: target.thinking })
    request.check()
    countRouting('asked', answer.ok && prior ? answersAgree(prior, answer.text) : null)
    return { ...answer, via: target.name, escalated: 'asked' }
  }

  if (remoteBudget().left <= 0) return cappedResult(null, target.name)
  const answer = await askRemote(target, asked, history, { job: 'asked', priorAnswer: prior })
  request.check()
  /* You overrode the router. Whether you were right is the one thing it cannot
     work out for itself, and here it is for free: a differing answer means a
     rule above should have escalated and did not. */
  countRouting('asked', answer.ok && prior ? answersAgree(prior, answer.text) : null)
  return { ...answer, via: target.name, escalated: 'asked' }
}

/* Stop. Not "ignore the answer when it comes" — kill the process, because it
   is spending a subscription on something nobody is going to hear and holding
   the strip open behind it. The in-flight ask resolves as 'cancelled'. */
ipcMain.on('assist:escalate:cancel', () => { chatRequests.cancel(); cancelRemote() })

/* Which CLIs are on this machine, for the settings panel. Read on every open
   like the model lists are: `claude` can be installed while transvibe is
   running, and the point of the list is that it says what is here now. */
ipcMain.handle('assist:clis', () => listCliAgents())

/** Cut off a spoken reply mid-sentence. */
ipcMain.on('speak:stop', () => stopSpeaking())

/* The agent's own model, if it named one. Guessing at a misheard command is
   that agent's thinking, and a small fast model is exactly what you want
   deciding whether you said "delete that" — while a chat agent's answers are
   worth something bigger. One roster, one choice per name. */
ipcMain.handle('assist:command', async (_e, text, phrases, options) => {
  if (!assist || !settings.commandFallback) return null
  /* Local, like cleanup above and for the same reason: an utterance reaches
     here precisely because nobody recognised it, which means nobody knows what
     is in it. A model name belonging to a remote agent is dropped rather than
     forwarded — not because it would go anywhere (it would go to Ollama, which
     has never heard of claude-sonnet-5) but so the one path dictation takes
     names only models that live here. */
  const at = (options && options.model) || null
  const model = at && (settings.agents || []).some(a => isRemote(a) && a.model === at)
    ? null
    : at
  return assist.command(text, phrases, { ...(options || {}), model })
})

/* Say what just happened.
 *
 * The renderer hands over the line it would have written on the strip and
 * waits for this to resolve, because it is deaf to the microphone until it
 * does. So every path here has to answer, including the ones that decide not
 * to speak at all.
 *
 * The model shortens the line when it is running; when it is not, the strip's
 * own wording is spoken as-is. Either way the outcome being announced is the
 * one that already happened — nothing here can invent a result. */
ipcMain.handle('speak', async (_e, message, { plain = false, voice, rate, model } = {}) => {
  if (!settings.speakReplies) return { spoken: false, reason: 'off' }
  const line = String(message == null ? '' : message).trim()
  if (!line) return { spoken: false, reason: 'nothing to say' }

  /* `plain` is for the lines that state a fact — "the fade is 10 seconds".
     Shortening those gains nothing and can lose the value in them: asked to
     tighten "the speaking rate is the voice's own", the model offered "voice
     is speaking". A confirmation may be rephrased; an answer may not. */
  const phrased = assist && !plain
    ? await assist.speak(line, { model })
    : { text: line, used: false }
  /* The caller names the voice, because the caller knows who was asked. The
     app's own settings are the fallback for the paths with no agent behind
     them — a command armed with the key rather than with a name. */
  const result = await speak(phrased.text, {
    voice: voice === undefined ? settings.speakVoice : voice,
    rate: rate === undefined ? settings.speakRate : rate
  })
  return { spoken: result.ok, said: phrased.text, error: result.error }
})

/* A voice is a thing you pick by ear, not by name: "Karen" and "Moira" mean
   nothing until you have heard them say something. So changing the voice — or
   the rate — says one line back in it immediately.
 *
 * Deliberately not routed through the handler above: this ignores the
 * off-switch, because someone who just picked a voice while replies are off is
 * asking what it sounds like, not turning the feature on. The model is not
 * asked either — there is nothing here to shorten. */
const PREVIEW_LINE = 'This is how a reply sounds.'

ipcMain.handle('speak:preview', (_e, { voice, rate, line } = {}) => speak(
  String(line || PREVIEW_LINE), {
    voice: voice === undefined ? settings.speakVoice : voice,
    rate: rate === undefined ? settings.speakRate : rate
  }))

/* The voices macOS has, for the settings panel. Read on every open like the
   model lists are: voices are downloadable, and one added in System Settings
   should show up here without a restart. */
ipcMain.handle('voices:list', () => listVoices())

ipcMain.handle('clipboard:write', (_e, text) => {
  clipboard.writeText(text)
  return true
})

/* Read fresh every time rather than cached at startup: another app can
   download a model while transvibe is running, and the point of the list is
   that it says what is on the machine now. */
ipcMain.handle('models:list', () => ({
  // Sized here rather than in the renderer: one implementation of "487 MB".
  models: listModels().map(m => ({ ...m, size: humanSize(m.bytes) })),
  inUse: findModel(settings.modelPath)
}))

/* Asked at the URL the settings currently hold, so pointing Ollama somewhere
   else and then opening the list shows that server's models, not the last
   one's. */
ipcMain.handle('assist:models', async () => {
  const listed = await listOllamaModels(settings.assistUrl)
  // The measurements live here rather than being asked for separately: the
  // picker wants one list, and this end owns both halves of it.
  const stats = settings.modelStats || {}
  return {
    ...listed,
    models: listed.models.map(m => ({ ...m, stat: stats[m.name] || null }))
  }
})

ipcMain.handle('login-item:get', () => app.getLoginItemSettings().openAtLogin)
ipcMain.handle('login-item:set', (_e, value) => {
  setLoginItem(!!value)
  return app.getLoginItemSettings().openAtLogin
})

ipcMain.on('window:hide', () => win && win.hide())
/* The way back, for someone who said "hide" and then said "come back". The
   microphone never stopped, so the strip being invisible is the only thing
   that had to change — and the only thing that changes back. */
ipcMain.on('window:show', () => showWindow())
ipcMain.on('models:reveal', () => revealModelFolder())
ipcMain.on('app:quit', () => app.quit())
/* The settings that are baked into the transcription engine at launch — the
   model, the language, voice isolation — used to say "takes effect when
   transvibe restarts" and leave you to work out how. Restarting is the
   instruction, so the panel may as well carry it. */
ipcMain.on('app:relaunch', () => {
  app.relaunch()
  app.quit()
})

/* Said out loud rather than clicked. Routed through the same function the menu
   bar uses, so the window is shown first — "go away" then "open settings"
   would otherwise open a panel onto a hidden strip. */
const VOICE_PANELS = new Set(['settings', 'glossary', 'help', 'agents'])
ipcMain.on('panel:open', (_e, name) => {
  if (VOICE_PANELS.has(name)) openPanel(name)
})

/* The renderer owns the two things the strip's geometry depends on: whether a
   panel is open (so the strip needs room for it) and whether it is mid-
   interaction (so it must stay awake even if the pointer strays). */
ipcMain.on('overlay:hold', (_e, value) => { holdOpen = !!value })
ipcMain.on('overlay:target', (_e, value) => { overTarget = !!value })
ipcMain.on('overlay:panel', (_e, open) => {
  if (panelOpen === !!open) return
  panelOpen = !!open
  applyStripBounds()
})
ipcMain.on('overlay:height', (_e, px) => {
  const next = Math.max(0, Math.round(Number(px) || 0))
  // A pixel of jitter is not worth a window resize.
  if (Math.abs(next - contentHeight) < 2) return
  contentHeight = next
  applyStripBounds()
})
/* Either window can turn the microphone off — the strip's own button, or the
   orb's — and both of them draw whether it is on, so the answer goes to both.
   `onListening` on each side only mirrors state, so an echo to whichever one
   asked costs nothing and means there is one path rather than two. */
function setListening (value) {
  listening = !!value
  send('listening', listening)
  sendOrb('listening', listening)
  refreshTray()
}

ipcMain.on('listening', (_e, value) => setListening(value))

let recordingQuitPending = false
let recordingQuitReady = false
function finishRecordingQuit () {
  if (!recordingQuitPending || recordingQuitReady) return
  recordingQuitReady = true
  debugRecording.stop()
  app.quit()
}
ipcMain.on('debug:flushed', finishRecordingQuit)
app.on('before-quit', event => {
  if (debugRecording.status.active && !recordingQuitReady) {
    event.preventDefault()
    if (!recordingQuitPending) {
      recordingQuitPending = true
      send('debug:flush')
      setTimeout(finishRecordingQuit, 1000)
    }
    return
  }
  debugRecording.stop()
  app.isQuitting = true
})

app.on('will-quit', () => {
  clearInterval(wakeTimer)
  destroyOrbWindow()
  cancelRemote()
  globalShortcut.unregisterAll()
  if (tapProc) { tapProc.kill('SIGTERM'); tapProc = null }
  if (engine) engine.stop()
})

// The window only ever hides, so this fires on real teardown alone.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
