const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sitenoteDesktop', Object.freeze({
  version: () => ipcRenderer.invoke('sitenote:version'),
  check: () => ipcRenderer.invoke('sitenote:update-check'),
  download: () => ipcRenderer.invoke('sitenote:update-download'),
  open: () => ipcRenderer.invoke('sitenote:update-open'),
}));

const notes = (method, ...args) => ipcRenderer.invoke('sitenote:notes-' + method, ...args);
contextBridge.exposeInMainWorld('sitenoteNoteFiles', Object.freeze({
  status: () => notes('status'),
  chooseFolder: entries => notes('choose', entries),
  sync: (entries, deletedIds) => notes('sync', entries, deletedIds),
  pickDocument: () => notes('pick'),
  saveImport: entry => notes('save-import', entry),
  revealOriginal: id => notes('reveal', id),
}));
