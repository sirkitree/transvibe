import {
  app, BrowserWindow, ipcMain, clipboard, systemPreferences,
  globalShortcut, Tray, Menu, nativeImage, screen, shell
} from 'electron'
import path from 'node:path'
import { spawn } from 'node:child_process'
import fs, { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createEngine } from './whisper.js'
import { createAssist, listOllamaModels } from './assist.js'
import { speak, stopSpeaking, listVoices } from './speech.js'
import { findModel, downloadModel, listModels, humanSize, MODELS_DIR } from './models.js'
import * as config from './config.js'
import { stripBounds, contains, nextWake } from './overlay.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let win = null
let tray = null
let engine = null
let assist = null
let settings = config.load()
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
  wakeTimer = setInterval(pollPointer, POLL_MS)
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
  win.on('show', () => { applyStripBounds(); refreshTray() })
  win.on('hide', () => {
    wake = { awake: false, insideSince: null, outsideSince: null }
    setAwake(false)
    refreshTray()
  })
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
      click: () => {
        listening = !listening
        send('listening', listening)
        refreshTray()
      }
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
  tray.on('click', toggleWindow)       // left click toggles, right click menus
  refreshTray()
}

function send (channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
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
      confidenceFloor: settings.confidenceFloor
    })
    await engine.start()
    send('status', { state: 'ready', message: path.basename(modelPath), mode: engine.mode })
    initAssist()
  } catch (err) {
    send('status', { state: 'error', message: err.message })
  }
}

/* The assist model is optional in the strongest sense: if Ollama is not
   running or the model was never pulled, `check()` comes back false and every
   later call short-circuits, leaving the app exactly as it was. */
async function initAssist () {
  const asked = settings.cleanup || settings.commandFallback
  // Spoken replies will use the model to shorten a line if it happens to be
  // there, but they work without it, so wanting them is not a reason to go
  // looking for Ollama on someone who never asked for it — only a reason to
  // keep the handle if one of the other two already did.
  if (!asked && !settings.speakReplies) { assist = null; return }
  assist = createAssist({ url: settings.assistUrl, model: settings.assistModel })
  const ok = await assist.check()
  // Only the features that cannot work without it are worth an error.
  if (!ok && asked) {
    send('status', { state: 'error', message: `assist model ${settings.assistModel} not available — is Ollama running?` })
  }
}

app.whenReady().then(async () => {
  const granted = await systemPreferences.askForMediaAccess('microphone').catch(() => false)
  createWindow()

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

/* ---------------------------------------------------------------------- IPC */

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

ipcMain.handle('transcribe', async (_e, buffer, interim = false) => {
  if (!engine) return { text: '', error: 'engine not ready' }
  try {
    const samples = new Float32Array(buffer)
    const result = await engine.transcribe(samples, { interim })
    // only a settled utterance is worth putting on the clipboard
    if (result.text && !interim && settings.autoCopy) clipboard.writeText(result.text)
    return result
  } catch (err) {
    return { text: '', error: err.message }
  }
})

ipcMain.handle('settings:get', () => settings)
ipcMain.handle('settings:set', (_e, patch) => {
  settings = config.save(patch)
  // Glossary edits apply to the next utterance — no need to restart the server.
  if (engine && ('vocabulary' in patch || 'corrections' in patch ||
      'dropGlossaryEcho' in patch || 'confidenceFloor' in patch)) {
    engine.setGlossary({
      vocabulary: settings.vocabulary,
      corrections: settings.corrections,
      dropGlossaryEcho: settings.dropGlossaryEcho,
      confidenceFloor: settings.confidenceFloor
    })
  }
  if ('cleanup' in patch || 'commandFallback' in patch ||
      'assistModel' in patch || 'assistUrl' in patch || 'speakReplies' in patch) {
    initAssist()
  }
  // Turning replies off mid-sentence should stop the sentence.
  if ('speakReplies' in patch && !settings.speakReplies) stopSpeaking()
  if ('alwaysOnTop' in patch && win) {
    win.setAlwaysOnTop(settings.alwaysOnTop, 'screen-saver')
  }
  if ('stripHeight' in patch || 'panelHeight' in patch) applyStripBounds()
  return settings
})

ipcMain.handle('assist:cleanup', async (_e, text) => {
  if (!assist || !settings.cleanup) return { text, used: false, reason: 'off' }
  return assist.cleanup(text)
})

ipcMain.handle('assist:command', async (_e, text, phrases) => {
  if (!assist || !settings.commandFallback) return null
  return assist.command(text, phrases)
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
ipcMain.handle('speak', async (_e, message, { plain = false, voice, rate } = {}) => {
  if (!settings.speakReplies) return { spoken: false, reason: 'off' }
  const line = String(message == null ? '' : message).trim()
  if (!line) return { spoken: false, reason: 'nothing to say' }

  /* `plain` is for the lines that state a fact — "the fade is 10 seconds".
     Shortening those gains nothing and can lose the value in them: asked to
     tighten "the speaking rate is the voice's own", the model offered "voice
     is speaking". A confirmation may be rephrased; an answer may not. */
  const phrased = assist && !plain ? await assist.speak(line) : { text: line, used: false }
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
ipcMain.handle('assist:models', () => listOllamaModels(settings.assistUrl))

ipcMain.handle('login-item:get', () => app.getLoginItemSettings().openAtLogin)
ipcMain.handle('login-item:set', (_e, value) => {
  setLoginItem(!!value)
  return app.getLoginItemSettings().openAtLogin
})

ipcMain.on('window:hide', () => win && win.hide())

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
ipcMain.on('listening', (_e, value) => {
  listening = !!value
  refreshTray()
})

app.on('before-quit', () => { app.isQuitting = true })

app.on('will-quit', () => {
  clearInterval(wakeTimer)
  globalShortcut.unregisterAll()
  if (tapProc) { tapProc.kill('SIGTERM'); tapProc = null }
  if (engine) engine.stop()
})

// The window only ever hides, so this fires on real teardown alone.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
