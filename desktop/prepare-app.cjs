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

for (const item of ['index.html', 'island.html', 'src', 'styles', 'vendor']) {
  copy(path.join(root, item), path.join(webOut, item));
}

for (const file of ['main.cjs', 'preload-main.cjs', 'preload-island.cjs']) {
  fs.copyFileSync(path.join(__dirname, file), path.join(out, file));
}

const icon = path.join(__dirname, 'icon.ico');
if (fs.existsSync(icon)) fs.copyFileSync(icon, path.join(out, 'icon.ico'));

fs.writeFileSync(path.join(out, 'package.json'), JSON.stringify({
  name: 'EyePilot',
  productName: 'EyePilot',
  version: pkg.version || '1.0.1',
  description: 'EyePilot · 瞳行 — AI 眼控与用眼健康助手',
  main: 'main.cjs',
}, null, 2));

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
