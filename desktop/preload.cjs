'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('comicSub', {
  getState: () => ipcRenderer.invoke('app:get-state'),
  navigate: (url) => ipcRenderer.invoke('app:navigate', url),
  setReaderBounds: (bounds) => ipcRenderer.invoke('app:set-reader-bounds', bounds),
  setReaderVisible: (visible) => ipcRenderer.invoke('app:set-reader-visible', visible),
  readerCommand: (command) => ipcRenderer.invoke('app:reader-command', command),
  openSample: () => ipcRenderer.invoke('app:open-sample'),
  saveSettings: (patch) => ipcRenderer.invoke('app:save-settings', patch),
  setToken: (token) => ipcRenderer.invoke('app:set-token', token),
  setProviderKey: (provider, key) => ipcRenderer.invoke('app:set-provider-key', provider, key),
  listProviderModels: (config) => ipcRenderer.invoke('app:list-provider-models', config),
  setPrivate: (enabled) => ipcRenderer.invoke('app:set-private', enabled),
  clearHistory: (id) => ipcRenderer.invoke('app:history-clear', id),
  resume: (item) => ipcRenderer.invoke('app:resume', item),
  setGlossaryConsent: (value) => ipcRenderer.invoke('app:glossary-consent', value),
  addTerm: (term) => ipcRenderer.invoke('app:add-term', term),
  copyDiagnostic: (receipt) => ipcRenderer.invoke('app:copy-diagnostic', receipt),
  chooseModelMigration: (choice) => ipcRenderer.invoke('app:model-choice', choice),
  on: (channel, callback) => {
    const allowed = new Set(['reader:status', 'app:navigation', 'app:history', 'app:settings', 'app:private', 'app:reader-crashed', 'app:broker-receipt'])
    if (!allowed.has(channel)) return () => {}
    const handler = (_event, payload) => callback(payload)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  },
})
