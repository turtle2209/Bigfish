'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('marketAPI', {
  list: () => ipcRenderer.invoke('market:list'),
  state: () => ipcRenderer.invoke('market:state'),
  install: (spec) => ipcRenderer.invoke('market:install', spec),
  uninstall: (pkg) => ipcRenderer.invoke('market:uninstall', pkg),
  disable: (pkg) => ipcRenderer.invoke('market:disable', pkg),
  enable: (pkg) => ipcRenderer.invoke('market:enable', pkg),
  restart: () => ipcRenderer.invoke('market:restart'),
  openExternal: (url) => ipcRenderer.send('market-open-external', url),
});
