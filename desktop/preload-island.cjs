/* 灵动岛 preload：只允许调整自身窗口尺寸和转发动作 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('islandHost', {
  resize: (w, h) => ipcRenderer.send('island:resize', w, h),
  action: (name) => ipcRenderer.send('island:action', name),
});
