const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('transvibe', {
  /** @param {Float32Array} samples 16 kHz mono — transferred, not copied */
  transcribe: (samples, interim = false) =>
    ipcRenderer.invoke('transcribe', samples.buffer, interim),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: patch => ipcRenderer.invoke('settings:set', patch),
  copy: text => ipcRenderer.invoke('clipboard:write', text),
  send: text => ipcRenderer.invoke('send', text),
  hide: () => ipcRenderer.send('window:hide'),
  minimize: () => ipcRenderer.send('window:minimize'),
  setListening: value => ipcRenderer.send('listening', value),
  onStatus: fn => ipcRenderer.on('status', (_e, payload) => fn(payload)),
  onListening: fn => ipcRenderer.on('listening', (_e, value) => fn(value)),
  onCommand: fn => ipcRenderer.on('command', (_e, name) => fn(name)),
  onFocus: fn => ipcRenderer.on('focus', (_e, focused) => fn(focused)),
  onCommandMode: fn => ipcRenderer.on('command-mode', (_e, active) => fn(active)),
  setCommandMode: active => ipcRenderer.send('command-mode', active)
})
