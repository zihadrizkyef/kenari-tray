const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kenari', {
  onData: (cb) => ipcRenderer.on('data', (_e, payload) => cb(payload)),
  setApiKey: (key) => ipcRenderer.send('set-api-key', key),
  refresh: () => ipcRenderer.send('refresh'),
  hide: () => ipcRenderer.send('hide'),
  openDashboard: () => ipcRenderer.send('open-dashboard'),
  quit: () => ipcRenderer.send('quit'),
});
