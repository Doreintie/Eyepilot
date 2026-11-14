/* ============================================================
   EyePilot 桌面壳（Electron）
   - 内置一个只监听 127.0.0.1 的静态服务器，页面在安全上下文里运行
   - 自动授予摄像头权限，不出现浏览器地址栏 / 权限弹窗
   - 复用 ../index.html / src / styles / vendor，逻辑与网页版完全一致
   ============================================================ */

const { app, BrowserWindow, Menu, session, screen, shell } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const WEB_ROOT = path.join(__dirname, 'web');
let mainWindow = null;
let server = null;

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

function serveFile(req, res) {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/' || pathname === '') pathname = '/index.html';
    const filePath = path.resolve(WEB_ROOT, '.' + pathname);
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
  } catch (err) {
    res.writeHead(500);
    res.end('Internal error');
  }
}

function startServer() {
  return new Promise((resolve, reject) => {
    server = http.createServer(serveFile);
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve(port);
    });
  });
}

function createWindow(port) {
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
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
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

  // 保留几个有用的快捷键，避免没有菜单时无法刷新/调试
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

async function boot() {
  // 摄像头：直接允许，不弹 Chromium 权限框；其他权限一律拒绝
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
    callback(permission === 'media');
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission) => permission === 'media');

  const port = await startServer();
  createWindow(port);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    app.setName('EyePilot');
    boot().catch((err) => {
      console.error('[EyePilot] 启动失败', err);
      app.quit();
    });
  });

  app.on('window-all-closed', () => {
    if (server) {
      server.close();
      server = null;
    }
    app.quit();
  });
}
