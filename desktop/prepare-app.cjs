/* 把网页资源与 Electron 壳组装成可打包目录 build/app */
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const out = path.join(__dirname, 'build', 'app');
const webOut = path.join(out, 'web');
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));

function copy(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      copy(path.join(src, name), path.join(dest, name));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

for (const item of ['index.html', 'island.html', 'phone.html', 'src', 'styles', 'vendor', 'assets']) {
  copy(path.join(root, item), path.join(webOut, item));
}

for (const file of ['main.cjs', 'preload-main.cjs', 'preload-island.cjs']) {
  fs.copyFileSync(path.join(__dirname, file), path.join(out, file));
}

const icon = path.join(__dirname, 'icon.ico');
if (fs.existsSync(icon)) fs.copyFileSync(icon, path.join(out, 'icon.ico'));

const runtimeDeps = pkg.dependencies || {};
fs.writeFileSync(path.join(out, 'package.json'), JSON.stringify({
  name: 'EyePilot',
  productName: 'EyePilot',
  version: pkg.version || '1.3.0',
  description: 'EyePilot · 瞳行 — AI 专注与护眼助手',
  author: 'EyePilot · 瞳行',
  main: 'main.cjs',
  dependencies: runtimeDeps,
}, null, 2));

// 原生模块（系统光标）不能打进 asar，所以这里把生产依赖装到 app 目录里
if (Object.keys(runtimeDeps).length) {
  const { execFileSync } = require('node:child_process');
  try {
    execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], {
      cwd: out, stdio: 'inherit', shell: true,
    });
    console.log('[prepare] runtime deps installed');
  } catch (err) {
    console.warn('[prepare] 依赖安装失败，系统光标功能将不可用：', err.message);
  }
}

let files = 0;
let bytes = 0;
(function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p);
    else { files++; bytes += st.size; }
  }
})(out);

console.log(`[prepare] ${files} files, ${(bytes / 1024 / 1024).toFixed(1)} MB -> ${out}`);
