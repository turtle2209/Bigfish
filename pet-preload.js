'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petAPI', {
  initBounds: (w, h, petX, petY) => ipcRenderer.send('pet-init-bounds', { w, h, petX, petY }),
  syncPosition: (x, y) => ipcRenderer.send('pet-sync-position', { x, y }),
  wanderDone: () => ipcRenderer.send('pet-wander-done'),
  clicked: () => ipcRenderer.send('pet-clicked'),
  saveScale: (s) => ipcRenderer.send('pet-save-scale', s),
  onSay: (cb) => ipcRenderer.on('pet-say', (_e, msg) => cb(msg)),
  onState: (cb) => ipcRenderer.on('pet-state', (_e, s) => cb(s)),
  onWander: (cb) => ipcRenderer.on('pet-wander', (_e, data) => cb(data)),
  onScale: (cb) => ipcRenderer.on('pet-scale', (_e, s) => cb(s)),
  setIgnoreMouse: (ignore) => ipcRenderer.send('pet-set-ignore-mouse', ignore),
});
