const { contextBridge, ipcRenderer } = require('electron')

const invoke = (channel, ...args) => ipcRenderer.invoke(`pgdev:${channel}`, ...args)
const on = (channel, callback) => {
  const listener = (_event, value) => callback(value)
  ipcRenderer.on(`pgdev:${channel}`, listener)
  return () => ipcRenderer.removeListener(`pgdev:${channel}`, listener)
}

contextBridge.exposeInMainWorld('pgdevDesktop', {
  request: (method, path, body) => invoke('request', method, path, body),
  storage: {
    load: () => invoke('storage-load'),
    write: (kind, value) => invoke('storage-write', kind, value),
  },
  files: {
    open: () => invoke('files-open'),
    read: (file) => invoke('files-read', file),
    begin: (options) => invoke('files-begin', options),
    write: (id, text) => invoke('files-write', id, text),
    finish: (id, commit) => invoke('files-finish', id, commit),
  },
  copyText: (text) => invoke('clipboard', text),
  confirm: (message) => invoke('confirm', message),
  subscribeAi: (callback, status) => {
    const offMessage = on('ai-message', callback)
    const offStatus = on('ai-status', status)
    void invoke('ai-start').catch(() => status(false))
    return () => { offMessage(); offStatus(); void invoke('ai-stop').catch(() => undefined) }
  },
  onBeforeClose: (callback) => on('before-close', async () => {
    try { await callback(); await invoke('close-ready') }
    catch { await invoke('close-failed') }
  }),
  onBackendFailure: (callback) => on('backend-failed', callback),
  onStorageWarning: (callback) => on('storage-warning', callback),
})
