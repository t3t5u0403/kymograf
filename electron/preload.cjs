const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('kymografNative', {
  /** absolute path of a File dropped onto the window (Electron-only capability) */
  pathFor: (file) => {
    try { return webUtils.getPathForFile(file) || null } catch { return null }
  },
  readFile: (p) => ipcRenderer.invoke('read-file', p),
  openFiles: () => ipcRenderer.invoke('open-files'),
  saveProject: (json, suggested) => ipcRenderer.invoke('save-project', json, suggested),
  openProject: () => ipcRenderer.invoke('open-project'),
  watchFiles: (paths) => ipcRenderer.invoke('watch-files', paths),
  onFileChanged: (cb) => {
    ipcRenderer.on('file-changed', (_e, p) => cb(p))
  },
  updateAvailable: () => ipcRenderer.invoke('update-available'),
  updateApp: () => ipcRenderer.invoke('update-app'),
  relaunch: () => ipcRenderer.invoke('relaunch'),
  saveVideoBegin: (suggested) => ipcRenderer.invoke('save-video-begin', suggested),
  saveVideoChunk: (buf) => ipcRenderer.invoke('save-video-chunk', buf),
  saveVideoEnd: () => ipcRenderer.invoke('save-video-end'),
  autosaveWrite: (json) => ipcRenderer.invoke('autosave-write', json),
  autosaveRead: () => ipcRenderer.invoke('autosave-read'),
  readDemoFile: (name) => ipcRenderer.invoke('read-demo-file', name),
})
