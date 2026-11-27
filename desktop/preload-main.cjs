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
    // 主进程比对「我设的位置」和「实际位置」，偏差大说明人手动了鼠标
    onUserMouse: (cb) => {
      if (typeof cb === 'function') ipcRenderer.on('cursor:usermoved', () => cb());
    },
  },
  link: {
    // 手机互联：按需在局域网开监听，返回可直接给手机扫/输的地址
    enable: () => ipcRenderer.invoke('link:enable'),
    disable: () => ipcRenderer.invoke('link:disable'),
    status: () => ipcRenderer.invoke('link:status'),
  },
  quit: () => ipcRenderer.send('app:quit'),
});
