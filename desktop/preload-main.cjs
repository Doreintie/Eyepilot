/* 主窗口 preload：只暴露必要的桌面能力，保持 contextIsolation + sandbox */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('eyePilotDesktop', {
  isDesktop: true,
  onAction: (cb) => {
    if (typeof cb !== 'function') return;
    ipcRenderer.on('action', (_e, name) => cb(name));
  },
  island: {
    setVisible: (v) => ipcRenderer.send('island:visibility', !!v),
    toggle: () => ipcRenderer.send('island:toggle'),
  },
  cursor: {
    // 归一化屏幕坐标 → 主进程用系统 API 移动真实光标
    set: (nx, ny) => ipcRenderer.send('cursor:move', nx, ny),
  },
  quit: () => ipcRenderer.send('app:quit'),
});
