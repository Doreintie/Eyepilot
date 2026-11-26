/* ============================================================
   EyePilot 桌面壳（Electron）
   - 内置一个只监听 127.0.0.1 的静态服务器，页面在安全上下文里运行
   - 自动授予摄像头权限，不出现浏览器地址栏 / 权限弹窗
   - 复用 ../index.html / src / styles / vendor，逻辑与网页版完全一致
   - 额外提供：灵动岛悬浮窗、托盘菜单、后台不休眠
   ============================================================ */

const { app, BrowserWindow, Menu, Tray, session, screen, shell, ipcMain, nativeImage } = require('electron');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

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

/* ---------------- 手机中继（协议与 serve.py 完全一致） ---------------- */

const LINK = { phone: '', width: 0, height: 0, packets: 0, lastAt: 0, bytes: 0 };
const SUBS = new Set();
let lanServer = null;
let lanPort = 0;
let lanToken = '';
let lanHttps = false;
let lanUrl = '';

function lanAddress() {
  // 只取「第一个非内网 IPv4」会被 VPN / 虚拟网卡骗到（本机就踩过 26.x）
  // 所以按「像不像家里/学校的局域网」打分，取最高分
  const score = (ip) => {
    if (/^192\.168\./.test(ip)) return 100;
    if (/^10\./.test(ip)) return 90;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 80;
    if (/^(169\.254|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])|26\.|25\.)\./.test(ip)) return 0;
    return 40;
  };
  let best = '';
  let bestScore = -1;
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const n of list || []) {
      if (n.family !== 'IPv4' || n.internal) continue;
      const sc = score(n.address);
      if (sc > bestScore) { bestScore = sc; best = n.address; }
    }
  }
  return best || '127.0.0.1';
}

function readBinary(req, limit = 128 * 1024) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { req.destroy(); resolve(null); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(null));
  });
}

function broadcast(item) {
  const text = `data: ${JSON.stringify(item)}\n\n`;
  for (const res of SUBS) {
    try { res.write(text); } catch { SUBS.delete(res); }
  }
}

function streamEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 1500\n: ready\n\n');
  SUBS.add(res);
  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* 断开就等 close */ }
  }, 15000);
  req.on('close', () => {
    clearInterval(ping);
    SUBS.delete(res);
  });
}

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

  if (pathname.startsWith('/api/link/')) {
    const fromLan = !/^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(req.socket.remoteAddress || '');
    if (fromLan && lanToken && req.headers['x-eyepilot-token'] !== lanToken) {
      json(401, { error: 'token' });
      return true;
    }

    if (pathname === '/api/link/state') {
      json(200, { ...LINK, lan: !!lanServer, https: lanHttps, lanUrl: fromLan ? '' : lanUrl, token: fromLan ? '' : lanToken });
      return true;
    }

    if (pathname === '/api/link/stream') {
      streamEvents(req, res);
      return true;
    }

    if (pathname === '/api/link/frame' && req.method === 'POST') {
      const buf = await readBinary(req);
      if (!buf || buf.length < 32 || buf.length > 128 * 1024 || buf.subarray(0, 4).toString('latin1') !== 'EPL1') {
        json(400, { error: 'bad packet' });
        return true;
      }
      const now = Date.now();
      LINK.packets += 1;
      LINK.lastAt = now;
      LINK.bytes = buf.length;
      broadcast({ t: now, p: buf.toString('base64') });
      res.writeHead(204);
      res.end();
      return true;
    }

    if (pathname === '/api/link/hello' && req.method === 'POST') {
      const raw = await readBody(req);
      let info = {};
      try { info = JSON.parse(raw || '{}'); } catch { /* 忽略坏包 */ }
      LINK.phone = String(info.name || '手机摄像头').slice(0, 48);
      LINK.width = Number(info.width) || 0;
      LINK.height = Number(info.height) || 0;
      LINK.lastAt = Date.now();
      console.log(`[手机] 已连接：${LINK.phone} (${LINK.width}×${LINK.height})`);
      json(200, { ok: true });
      return true;
    }

    if (pathname === '/api/link/bye' && req.method === 'POST') {
      if (LINK.phone) console.log(`[手机] 已断开：${LINK.phone}`);
      LINK.phone = '';
      json(200, { ok: true });
      return true;
    }

    json(404, { error: 'not found' });
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

/* ---------------- 手机互联：按需在 0.0.0.0 上开一个监听 ---------------- */

function ensureCert() {
  // 打包后 __dirname 在 app.asar 里，是只读的，证书必须写到用户数据目录
  const dir = path.join(app.getPath('userData'), 'certs');
  const crt = path.join(dir, 'lan-dev.crt');
  const key = path.join(dir, 'lan-dev.key');
  if (fs.existsSync(crt) && fs.existsSync(key)) return { crt, key };
  // 手机浏览器只在安全上下文里给摄像头，所以这里也要 HTTPS。
  // Electron 进程不一定继承了 Git 的 PATH，逐个试常见位置。
  const candidates = [
    'openssl',
    'C:////Program Files\\Git\\usr\\bin\\openssl.exe',
    'C:////Program Files\\Git\\mingw64\\bin\\openssl.exe',
    'C:////Program Files (x86)\\Git\\usr\\bin\\openssl.exe',
  ];
  const args = [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', crt, '-days', '825',
    '-subj', '/CN=EyePilot LAN',
    '-addext', `subjectAltName=IP:${lanAddress()},IP:127.0.0.1,DNS:localhost`,
  ];
  for (const bin of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      execFileSync(bin, args, { stdio: 'ignore' });
      return { crt, key };
    } catch { /* 试下一个 */ }
  }
  return null;
}

function listenOn(srv, port) {
  return new Promise((resolve, reject) => {
    const onErr = (e) => { srv.off('listening', onOk); reject(e); };
    const onOk = () => { srv.off('error', onErr); resolve(); };
    srv.once('error', onErr);
    srv.once('listening', onOk);
    srv.listen(port, '0.0.0.0');
  });
}

async function startLan() {
  if (lanServer) return { ok: true, url: lanUrl, token: lanToken, https: lanHttps };
  lanToken = String(Math.floor(100000 + Math.random() * 900000));
  const cert = ensureCert();
  const srv = cert
    ? https.createServer({ key: fs.readFileSync(cert.key), cert: fs.readFileSync(cert.crt) }, serveFile)
    : http.createServer(serveFile);
  lanHttps = !!cert;

  let bound = 0;
  for (let p = 8848; p < 8878; p++) {
    try {
      await listenOn(srv, p);
      bound = p;
      break;
    } catch { /* 占用就试下一个 */ }
  }
  if (!bound) return { ok: false, error: '8848–8877 都被占用了，先关掉占用的程序再试' };

  lanPort = bound;
  lanServer = srv;
  lanUrl = `${lanHttps ? 'https' : 'http'}://${lanAddress()}:${lanPort}/phone.html?t=${lanToken}`;
  console.log(`[手机] 局域网已开启：${lanUrl}`);
  return { ok: true, url: lanUrl, token: lanToken, https: lanHttps };
}

function stopLan() {
  if (lanServer) {
    try { lanServer.close(); } catch { /* 已关闭 */ }
  }
  lanServer = null;
  lanPort = 0;
  lanUrl = '';
  return { ok: true };
}

ipcMain.handle('link:enable', () => startLan());
ipcMain.handle('link:disable', () => stopLan());
ipcMain.handle('link:status', () => ({ lan: !!lanServer, url: lanUrl, token: lanToken, https: lanHttps }));

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

const ISLAND_WIDTH = 300;
const ISLAND_COLLAPSED = 42;

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

/* ---------------- 系统光标（程序外接管） ---------------- */

let nut = null;
let cursorBusy = false;
let cursorPending = null;

function ensureNut() {
  if (nut !== undefined && nut !== null) return nut;
  try {
    // eslint-disable-next-line global-require
    nut = require('@nut-tree-fork/nut-js');
  } catch (err) {
    console.warn('[EyePilot] 系统光标模块不可用：', err.message);
    nut = null;
  }
  return nut;
}

function pumpCursor() {
  const n = ensureNut();
  if (!n) return;
  if (cursorBusy) return;
  cursorBusy = true;
  (async () => {
    while (cursorPending) {
      const p = cursorPending;
      cursorPending = null;
      try {
        await n.mouse.setPosition(new n.Point(p.x, p.y));
      } catch { /* 忽略单次失败 */ }
    }
    cursorBusy = false;
  })();
}

ipcMain.on('cursor:move', (_e, nx, ny) => {
  const d = screen.getPrimaryDisplay();
  // Electron 给的是 DIP，原生模块用的是物理像素，缩放不是 100% 时必须乘 scaleFactor
  const s = d.scaleFactor || 1;
  const x = Math.round((d.workArea.x + Math.max(0, Math.min(1, Number(nx))) * d.workArea.width) * s);
  const y = Math.round((d.workArea.y + Math.max(0, Math.min(1, Number(ny))) * d.workArea.height) * s);
  cursorPending = { x, y };
  pumpCursor();
});

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
    {
      label: '控制方式',
      submenu: [
        { label: '眼控（虹膜）', click: () => sendAction('mode:eye') },
        { label: '混合（头 + 眼）', click: () => sendAction('mode:hybrid') },
        { label: '头部（免校准）', click: () => sendAction('mode:head') },
        { label: '仅鼠标', click: () => sendAction('mode:mouse') },
      ],
    },
    { label: '护眼训练', click: () => sendAction('eyecare') },
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
