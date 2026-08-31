import {
  app, BrowserWindow, ipcMain, clipboard, systemPreferences,
  globalShortcut, Tray, Menu, nativeImage, screen
} from 'electron'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createEngine } from './whisper.js'
import { findModel, downloadModel } from './models.js'
import * as config from './config.js'
import { usableBounds, MIN_WIDTH, MIN_HEIGHT, DEFAULT_BOUNDS } from './bounds.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let win = null
let tray = null
let engine = null
let settings = config.load()
let listening = true
let commandTimer = null
let tapProc = null
let holding = false
let boundsTimer = null

function rememberBounds () {
  if (!win || win.isDestroyed() || win.isMinimized() || !win.isVisible()) return
  clearTimeout(boundsTimer)
  // resize and move fire continuously while dragging; only the last one matters
  boundsTimer = setTimeout(() => {
    if (!win || win.isDestroyed()) return
    settings = config.save({ bounds: win.getBounds() })
  }, 400)
}

function createWindow () {
  const restored = usableBounds(settings.bounds, screen.getAllDisplays())

  win = new BrowserWindow({
    ...DEFAULT_BOUNDS,
    ...restored,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    vibrancy: 'under-window',
    visualEffectState: 'active',
    hasShadow: true,
    roundedCorners: true,
    alwaysOnTop: settings.alwaysOnTop,
    skipTaskbar: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  if (settings.alwaysOnTop) win.setAlwaysOnTop(true, 'floating')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))

  // Closing the window parks the app in the menu bar rather than quitting it;
  // only an explicit Quit tears things down.
  win.on('close', e => {
    if (!app.isQuitting) {
      e.preventDefault()
      win.hide()
      refreshTray()
    }
  })
  win.on('show', refreshTray)
  win.on('hide', refreshTray)
  win.on('resize', rememberBounds)
  win.on('move', rememberBounds)

  /* Unfocused, the window gets out of the way. The vibrancy material has to go
     with it — it frosts whatever is behind the window, which is exactly what
     you are trying to read through. The window shadow goes too, since a CSS
     opacity fade cannot touch it. */
  win.on('blur', () => {
    win.setVibrancy(null)
    win.setHasShadow(false)
    send('focus', false)
  })

  win.on('focus', () => {
    win.setVibrancy('under-window')
    win.setHasShadow(true)
    send('focus', true)
  })
}

/* ------------------------------------------------------------------- menu bar */

function showWindow () {
  if (!win || win.isDestroyed()) createWindow()
  win.show()
  win.focus()
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
    { label: 'Show/hide shortcut: ⌃⌥Space', enabled: false },
    { type: 'separator' },
    { label: 'Quit transvibe', accelerator: 'Command+Q', click: () => app.quit() }
  ]))
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
    engine = createEngine({ modelPath, language: settings.language })
    await engine.start()
    send('status', { state: 'ready', message: path.basename(modelPath), mode: engine.mode })
  } catch (err) {
    send('status', { state: 'error', message: err.message })
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

ipcMain.on('command-mode', (_e, active) => {
  if (!active) disarmCommandMode()
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
  if ('alwaysOnTop' in patch && win) {
    win.setAlwaysOnTop(settings.alwaysOnTop, 'floating')
  }
  return settings
})

ipcMain.handle('clipboard:write', (_e, text) => {
  clipboard.writeText(text)
  return true
})

ipcMain.on('window:hide', () => win && win.hide())
ipcMain.on('window:minimize', () => win && win.minimize())
ipcMain.on('listening', (_e, value) => {
  listening = !!value
  refreshTray()
})

app.on('before-quit', () => { app.isQuitting = true })

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  if (tapProc) { tapProc.kill('SIGTERM'); tapProc = null }
  if (engine) engine.stop()
})

// The window only ever hides, so this fires on real teardown alone.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
