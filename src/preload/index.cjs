const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('transvibe', {
  /** @param {Float32Array} samples 16 kHz mono — transferred, not copied */
  transcribe: (samples, interim = false) =>
    ipcRenderer.invoke('transcribe', samples.buffer, interim),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  /* Not a setting in settings.json: macOS owns this one, and the answer is
     whatever the login item list actually says. */
  /** every whisper model on this machine, and which one is loaded */
  listModels: () => ipcRenderer.invoke('models:list'),
  /** the models Ollama has pulled, for the assist model list */
  listAssistModels: () => ipcRenderer.invoke('assist:models'),
  getLaunchAtLogin: () => ipcRenderer.invoke('login-item:get'),
  setLaunchAtLogin: value => ipcRenderer.invoke('login-item:set', value),
  setSettings: patch => ipcRenderer.invoke('settings:set', patch),
  copy: text => ipcRenderer.invoke('clipboard:write', text),
  /** tidy one settled utterance with the local assist model */
  cleanup: text => ipcRenderer.invoke('assist:cleanup', text),
  /** ask the assist model which known command phrase an utterance meant */
  assistCommand: (text, phrases) => ipcRenderer.invoke('assist:command', text, phrases),
  /* Say a line out loud. Resolves when the speaker is quiet again, which is
     what the renderer needs: it stops listening for exactly that long. */
  speak: (message, options) => ipcRenderer.invoke('speak', message, options),
  /** say one fixed line in the voice just chosen, off-switch and all */
  previewVoice: options => ipcRenderer.invoke('speak:preview', options),
  /** every macOS voice on this machine, for the voice picker */
  listVoices: () => ipcRenderer.invoke('voices:list'),
  /** ask a chat agent a question */
  ask: (question, history, options) => ipcRenderer.invoke('assist:ask', question, history, options),
  /** cut off whatever is being said */
  hush: () => ipcRenderer.send('speak:stop'),
  send: text => ipcRenderer.invoke('send', text),
  hide: () => ipcRenderer.send('window:hide'),
  /* Opening a panel goes out to the main process and comes back as a
     'command': the strip may be hidden, and a panel opened onto a hidden
     window is a panel nobody can see. */
  openPanel: name => ipcRenderer.send('panel:open', name),
  /** the pointer is over something clickable, not over the strip's empty air */
  setOverTarget: value => ipcRenderer.send('overlay:target', value),
  /** keep the strip awake while a panel or field is in use */
  setHold: value => ipcRenderer.send('overlay:hold', value),
  /** how tall the strip's own content is, so the window can follow it */
  setHeight: px => ipcRenderer.send('overlay:height', px),
  /** a panel needs more room than the strip normally has */
  setPanelOpen: open => ipcRenderer.send('overlay:panel', open),
  onAwake: fn => ipcRenderer.on('awake', (_e, value) => fn(value)),
  setListening: value => ipcRenderer.send('listening', value),
  onStatus: fn => ipcRenderer.on('status', (_e, payload) => fn(payload)),
  onListening: fn => ipcRenderer.on('listening', (_e, value) => fn(value)),
  onCommand: fn => ipcRenderer.on('command', (_e, name) => fn(name)),
  onCommandMode: fn => ipcRenderer.on('command-mode', (_e, active) => fn(active)),
  setCommandMode: active => ipcRenderer.send('command-mode', active)
})
