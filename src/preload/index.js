'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (channel) => (cb) => {
  const handler = (_event, data) => cb(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('squish', {
  info: () => ipcRenderer.invoke('app:info'),
  pickFiles: () => ipcRenderer.invoke('dialog:files'),
  pickFolder: () => ipcRenderer.invoke('dialog:folder'),
  pickOutDir: () => ipcRenderer.invoke('dialog:outdir'),
  scan: (paths, options) => ipcRenderer.invoke('scan:paths', { paths, ...options }),
  start: (payload) => ipcRenderer.invoke('compress:start', payload),
  cancel: () => ipcRenderer.invoke('compress:cancel'),
  thumb: (filePath) => ipcRenderer.invoke('thumb:get', filePath),
  reveal: (target) => ipcRenderer.invoke('shell:reveal', target),
  openPath: (target) => ipcRenderer.invoke('shell:open', target),
  exportReport: (rows) => ipcRenderer.invoke('report:csv', rows),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
  onProgress: on('compress:progress'),
  onCommand: on('app:command'),
});
