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
  assistCommand: (text, phrases, options) =>
    ipcRenderer.invoke('assist:command', text, phrases, options),
  /* Say a line out loud. Resolves when the speaker is quiet again, which is
     what the renderer needs: it stops listening for exactly that long. */
  speak: (message, options) => ipcRenderer.invoke('speak', message, options),
  /** say one fixed line in the voice just chosen, off-switch and all */
  previewVoice: options => ipcRenderer.invoke('speak:preview', options),
  /** every macOS voice on this machine, for the voice picker */
  listVoices: () => ipcRenderer.invoke('voices:list'),
  /** ask a chat agent a question */
  ask: (question, history, options) => ipcRenderer.invoke('assist:ask', question, history, options),
  /** ask a frontier CLI by name — "Mira, ask Claude about this" */
  escalate: (question, priorAnswer, history, options) =>
    ipcRenderer.invoke('assist:escalate', question, priorAnswer, history, options),
  /** kill an in-flight CLI call: "stop", or escape */
  cancelEscalation: () => ipcRenderer.send('assist:escalate:cancel'),
  /** which frontier CLIs are installed here, for the agents panel */
  listClis: () => ipcRenderer.invoke('assist:clis'),
  /** cut off whatever is being said */
  hush: () => ipcRenderer.send('speak:stop'),
  send: text => ipcRenderer.invoke('send', text),
  /** the named desktop Spaces this machine has markers for */
  listSpaces: () => ipcRenderer.invoke('spaces:list'),
  /** activate the marker assigned to one Space, which jumps macOS to it */
  openSpace: key => ipcRenderer.invoke('space:open', key),
  hide: () => ipcRenderer.send('window:hide'),
  /* Opening a panel goes out to the main process and comes back as a
     'command': the strip may be hidden, and a panel opened onto a hidden
     window is a panel nobody can see. */
  openPanel: name => ipcRenderer.send('panel:open', name),
  /** bring the strip back after "hide" — it was listening the whole time */
  showWindow: () => ipcRenderer.send('window:show'),
  /** open the folder holding the loaded whisper model, in Finder */
  revealModels: () => ipcRenderer.send('models:reveal'),
  /** quit, said in full so it is never an accident */
  quit: () => ipcRenderer.send('app:quit'),
  /** the pointer is over something clickable, not over the strip's empty air */
  setOverTarget: value => ipcRenderer.send('overlay:target', value),
  /** keep the strip awake while a panel or field is in use */
  setHold: value => ipcRenderer.send('overlay:hold', value),
  /** how tall the strip's own content is, so the window can follow it */
  setHeight: px => ipcRenderer.send('overlay:height', px),
  /** a panel needs more room than the strip normally has */
  setPanelOpen: open => ipcRenderer.send('overlay:panel', open),
  /* The orb window's whole diet: about seven numbers a frame, one way, from
     the strip's renderer — which owns the microphone and is the only thing
     that knows what the room is doing. Lossy on purpose. `send`, not `invoke`:
     nothing is waiting for an answer, and a frame of animation is not worth a
     round trip. */
  orbSignal: signal => ipcRenderer.send('orb:signal', signal),
  onOrbSignal: fn => ipcRenderer.on('orb:signal', (_e, signal) => fn(signal)),
  /** the orb rebuilds when its cost dials change */
  onOrbSettings: fn => ipcRenderer.on('orb:settings', (_e, settings) => fn(settings)),
  onSpaces: fn => ipcRenderer.on('spaces', (_e, list) => fn(list)),
  onAwake: fn => ipcRenderer.on('awake', (_e, value) => fn(value)),
  setListening: value => ipcRenderer.send('listening', value),
  onStatus: fn => ipcRenderer.on('status', (_e, payload) => fn(payload)),
  onListening: fn => ipcRenderer.on('listening', (_e, value) => fn(value)),
  onCommand: fn => ipcRenderer.on('command', (_e, name) => fn(name)),
  onCommandMode: fn => ipcRenderer.on('command-mode', (_e, active) => fn(active)),
  setCommandMode: active => ipcRenderer.send('command-mode', active)
})
