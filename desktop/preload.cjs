// Minimal, explicit bridge between the SheetScale page and the desktop shell.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('planmarkNative', {
  saveFile: (name, bytes) => ipcRenderer.invoke('save-file', String(name), bytes),
  onOpenFiles: (cb) => ipcRenderer.on('open-files', (_e, files) => cb(files)),
  onCommand: (cb) => ipcRenderer.on('command', (_e, c) => cb(String(c))),
  ready: () => ipcRenderer.send('renderer-ready'),
  platform: process.platform,
});
