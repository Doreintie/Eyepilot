/* ============================================================
   EyePilot 桌面壳（Electron）
   - 内置一个只监听 127.0.0.1 的静态服务器，页面在安全上下文里运行
   - 自动授予摄像头权限，不出现浏览器地址栏 / 权限弹窗
   - 复用 ../index.html / src / styles / vendor，逻辑与网页版完全一致
   - 额外提供：灵动岛悬浮窗、托盘菜单、后台不休眠
   ============================================================ */

const { app, BrowserWindow, Menu, Tray, session, screen, shell, ipcMain, nativeImage } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const WEB_ROOT = path.join(__dirname, 'web');
let mainWindow = null;
let islandWindow = null;
let tray = null;
let server = null;
let port = 0;
let quitFlag = false;
let lastMetrics = null;
let trayHinted = false;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { req.destroy(); resolve(null); return; }
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(null));
  });
}

async function handleApi(req, res, pathname) {
  const json = (code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
  };

  if (pathname === '/api/island/metrics') {
    if (req.method === 'POST') {
      const body = await readBody(req);
      try { lastMetrics = JSON.parse(body || '{}'); } catch { /* 忽略坏包 */ }
      res.writeHead(204);
      res.end();
      return true;
    }
    json(200, lastMetrics || {});
    return true;
  }

  if (pathname === '/api/island/action' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const { action } = JSON.parse(body || '{}');
      sendAction(action);
    } catch { /* 忽略 */ }
    json(200, { ok: true });
    return true;
  }

  if (pathname.startsWith('/api/')) {
    json(404, { error: 'not found' });
    return true;
  }
  return false;
}

function serveFile(req, res) {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = decodeURIComponent(url.pathname);

    if (pathname.startsWith('/api/')) {
      handleApi(req, res, pathname).catch(() => {
        res.writeHead(500);
        res.end('error');
      });
      return;
    }

    let file = pathname;
    if (file === '/' || file === '') file = '/index.html';
    const filePath = path.resolve(WEB_ROOT, '.' + file);
    if (!filePath.startsWith(WEB_ROOT + path.sep)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    fs.stat(filePath, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      const headers = {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': stat.size,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      };
      if (req.method === 'HEAD') {
        res.writeHead(200, headers);
        res.end();
        return;
      }
      res.writeHead(200, headers);
      fs.createReadStream(filePath).pipe(res);
    });
  } catch {
    res.writeHead(500);
    res.end('Internal error');
  }
}

function startServer() {
  return new Promise((resolve, reject) => {
    server = http.createServer(serveFile);
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(addr.port);
    });
  });
}

function createWindow() {
  const area = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.min(1460, Math.max(1080, Math.round(area.width * 0.92)));
  const height = Math.min(920, Math.max(680, Math.round(area.height * 0.92)));

  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#070a10',
    title: 'EyePilot · 瞳行',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'icon.ico'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-main.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // 后台（最小化 / 被别的窗口挡住）时不要节流，眼控和健康记录才能持续
      backgroundThrottling: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadURL(`http://127.0.0.1:${port}/`);
  mainWindow.once('ready-to-show', () => {
    mainWindow.maximize();
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // 关窗口不退出：收到托盘里继续记录，托盘里再点“退出”
  mainWindow.on('close', (e) => {
    if (quitFlag) return;
    e.preventDefault();
    mainWindow.hide();
    if (!trayHinted && tray) {
      trayHinted = true;
      try {
        tray.displayBalloon({
          title: 'EyePilot 仍在运行',
          content: '窗口已收到托盘，用眼记录继续。右键托盘图标可以重新校准或退出。',
        });
      } catch { /* 部分系统不支持气球提示 */ }
    }
  });

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = (input.key || '').toLowerCase();
    if (key === 'f12' || (input.control && input.shift && key === 'i')) {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    } else if (key === 'f5' || (input.control && key === 'r')) {
      mainWindow.webContents.reload();
      event.preventDefault();
    } else if (key === 'f11') {
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
      event.preventDefault();
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

/* ---------------- 灵动岛 ---------------- */

const ISLAND_WIDTH = 400;
const ISLAND_COLLAPSED = 54;
const ISLAND_EXPANDED = 396;

function islandPosition(w, y) {
  const d = screen.getPrimaryDisplay();
  return {
    x: Math.round(d.workArea.x + (d.workArea.width - w) / 2),
    y: y == null ? d.workArea.y + 10 : y,
  };
}

function createIsland() {
  const pos = islandPosition(ISLAND_WIDTH);
  islandWindow = new BrowserWindow({
    width: ISLAND_WIDTH,
    height: ISLAND_COLLAPSED,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-island.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  islandWindow.setAlwaysOnTop(true, 'screen-saver');
  islandWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  islandWindow.loadURL(`http://127.0.0.1:${port}/island.html`);
  islandWindow.once('ready-to-show', () => islandWindow.showInactive());
  islandWindow.on('closed', () => { islandWindow = null; });
}

function setIslandVisible(v) {
  if (!islandWindow) {
    if (v) createIsland();
    return;
  }
  if (v) islandWindow.showInactive();
  else islandWindow.hide();
}

function toggleIsland() {
  if (!islandWindow) { createIsland(); return; }
  if (islandWindow.isVisible()) islandWindow.hide();
  else islandWindow.showInactive();
}

/* ---------------- 托盘 ---------------- */

function sendAction(name) {
  if (name === 'show-window') { showMain(); return; }
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send('action', name);
}

function showMain() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  const iconPath = path.join(__dirname, 'icon.ico');
  let img = nativeImage.createFromPath(iconPath);
  if (img.isEmpty()) img = nativeImage.createEmpty();
  tray = new Tray(img);
  tray.setToolTip('EyePilot · 瞳行');

  const menu = Menu.buildFromTemplate([
    { label: '显示 EyePilot', click: () => showMain() },
    { type: 'separator' },
    { label: '重新校准（9 点）', click: () => sendAction('calibrate') },
    { label: '五点精细对齐', click: () => sendAction('refine') },
    { label: '打开设置', click: () => sendAction('settings') },
    { label: '暂停 / 恢复眼控点击', click: () => sendAction('toggle-pause') },
    { type: 'separator' },
    { label: '显示 / 隐藏灵动岛', click: () => toggleIsland() },
    { type: 'separator' },
    { label: '退出 EyePilot', click: () => { quitFlag = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => showMain());
  tray.on('double-click', () => showMain());
}

/* ---------------- 生命周期 ---------------- */

async function boot() {
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
    callback(permission === 'media');
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission) => permission === 'media');

  port = await startServer();
  createWindow();
  createTray();
  createIsland();
}

ipcMain.on('island:resize', (_e, w, h) => {
  if (!islandWindow) return;
  const b = islandWindow.getBounds();
  const width = Number(w) || ISLAND_WIDTH;
  const height = Math.max(ISLAND_COLLAPSED, Math.min(720, Number(h) || ISLAND_COLLAPSED));
  islandWindow.setBounds({ x: b.x, y: b.y, width, height });
});

ipcMain.on('island:action', (_e, name) => sendAction(name));
ipcMain.on('island:toggle', () => toggleIsland());
ipcMain.on('island:visibility', (_e, v) => setIslandVisible(!!v));
ipcMain.on('app:quit', () => { quitFlag = true; app.quit(); });

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showMain());

  app.on('before-quit', () => { quitFlag = true; });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    app.setName('EyePilot');
    boot().catch((err) => {
      console.error('[EyePilot] 启动失败', err);
      app.quit();
    });
  });

  app.on('window-all-closed', () => {
    if (quitFlag) {
      if (server) {
        server.close();
        server = null;
      }
      app.quit();
    }
  });
}
