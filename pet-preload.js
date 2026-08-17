'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petAPI', {
  dragStart: (x, y) => ipcRenderer.send('pet-drag-start', { x, y }),
  dragMove: (x, y) => ipcRenderer.send('pet-drag-move', { x, y }),
  dragEnd: () => ipcRenderer.send('pet-drag-end'),
  clicked: () => ipcRenderer.send('pet-clicked'),
  rightClicked: () => ipcRenderer.send('pet-right-clicked'),
  onSay: (cb) => ipcRenderer.on('pet-say', (_e, msg) => cb(msg)),
  onState: (cb) => ipcRenderer.on('pet-state', (_e, s) => cb(s)),
  onAffinity: (cb) => ipcRenderer.on('pet-affinity', (_e, a) => cb(a)),
  setIgnoreMouse: (ignore) => ipcRenderer.send('pet-set-ignore-mouse', ignore),
});
