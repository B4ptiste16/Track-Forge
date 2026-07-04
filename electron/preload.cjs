const { contextBridge, ipcRenderer } = require('electron');

// Bridge exposed to the renderer as window.desktop. Its presence is how the app
// knows it's running as the desktop build (vs a plain browser).
contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (s) => ipcRenderer.invoke('settings:set', s),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  pickFile: (filters) => ipcRenderer.invoke('dialog:pickFile', filters),
  pickSavePath: (defaultPath) => ipcRenderer.invoke('dialog:saveTrack', { defaultPath }),
  writeTrack: (baseDir, slug, files) => ipcRenderer.invoke('track:write', { baseDir, slug, files }),
  openInKsEditor: (ksPath, fbxPath) => ipcRenderer.invoke('kseditor:open', { ksPath, fbxPath }),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  showMessage: (type, message) => ipcRenderer.invoke('dialog:message', { type, message }),
  confirm: (message, detail, buttons) => ipcRenderer.invoke('dialog:confirm', { message, detail, buttons }),
  getVersion: () => ipcRenderer.invoke('app:getVersion'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  onUpdateStatus: (cb) => ipcRenderer.on('update:status', (_e, s) => cb(s)),
});
