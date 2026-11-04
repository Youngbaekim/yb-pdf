// 화면(웹 앱)과 데스크톱 기능 사이의 다리 — 파일 읽기·쓰기·대화상자만 노출
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('ybpdfNative', {
  read: (p) => ipcRenderer.invoke('read', p),
  write: (p, bytes) => ipcRenderer.invoke('write', p, bytes),
  exists: (p) => ipcRenderer.invoke('exists', p),
  openDialog: () => ipcRenderer.invoke('open-dialog'),
  saveDialog: (name, dir) => ipcRenderer.invoke('save-dialog', name, dir),
  pending: () => ipcRenderer.invoke('pending'),
  version: () => ipcRenderer.invoke('version'),
  pathOf: (file) => { try { return webUtils.getPathForFile(file) || ''; } catch { return ''; } },
  onOpen: (cb) => ipcRenderer.on('open-paths', (_e, paths) => cb(paths)),
});
