'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('exchangeAPI', {
  view: () => ipcRenderer.invoke('affinity:view'),
  exchange: () => ipcRenderer.invoke('affinity:exchange'),
  buy: (foodId) => ipcRenderer.invoke('affinity:buy', foodId),
});
