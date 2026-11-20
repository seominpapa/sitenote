const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sitenoteDesktop', Object.freeze({
  version: () => ipcRenderer.invoke('sitenote:version'),
  check: () => ipcRenderer.invoke('sitenote:update-check'),
  download: () => ipcRenderer.invoke('sitenote:update-download'),
  open: () => ipcRenderer.invoke('sitenote:update-open'),
}));
