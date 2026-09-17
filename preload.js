const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),
  transcribeFile: (path) => ipcRenderer.invoke('transcribe-file', path),
  onAnalyzeProgress: (cb) => ipcRenderer.on('analyze-progress', (_, v) => cb(v)),
  saveScore: (data) => ipcRenderer.invoke('save-score', data),
  listScores: () => ipcRenderer.invoke('list-scores'),
  loadScore: (name) => ipcRenderer.invoke('load-score', name),
  deleteScore: (name) => ipcRenderer.invoke('delete-score', name),
  openScoresFolder: () => ipcRenderer.invoke('open-scores-folder'),
  getKeymap: () => ipcRenderer.invoke('get-keymap'),
  setKeymap: (cfg) => ipcRenderer.invoke('set-keymap', cfg),
  getConfig: () => ipcRenderer.invoke('get-config'),
  setConfig: (cfg) => ipcRenderer.invoke('set-config', cfg),
  exportScoreText: (content) => ipcRenderer.invoke('export-score-text', content),
  setOpacity: (v) => ipcRenderer.invoke('set-opacity', v),
  setAlwaysOnTop: (f) => ipcRenderer.invoke('set-always-on-top', f),
  minimizeWindow: () => ipcRenderer.invoke('minimize-window'),
  closeWindow: () => ipcRenderer.invoke('close-window')
});
