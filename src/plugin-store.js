/* ============================================================
   plugin-store.js — 插件的安装 / 存储 / 加载
   ------------------------------------------------------------
   支持两种来源：
     · 单个 .js 文件（推荐，十行就能写一个）
     · 打包成 .zip（内含 plugin.json + 入口 js）
   插件代码存在 IndexedDB，启动时用 Blob URL 动态 import，
   注册仍然走 window.EyePilot.register()，与内置插件同一套 API。
   ============================================================ */

const DB_NAME = 'eyepilot-plugins';
const STORE = 'plugins';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode) {
  return db.transaction(STORE, mode).objectStore(STORE);
}

export async function listInstalled() {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const req = tx(db, 'readonly').getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

async function put(record) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = tx(db, 'readwrite').put(record);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function removeMany(ids) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const store = tx(db, 'readwrite');
    ids.forEach((id) => store.delete(id));
    store.transaction.oncomplete = () => resolve();
    store.transaction.onerror = () => reject(store.transaction.error);
  });
}

/* ---------------- zip ---------------- */

async function unzip(buffer) {
  const dv = new DataView(buffer);
  let eocd = -1;
  for (let i = buffer.byteLength - 22; i >= 0 && i > buffer.byteLength - 66000; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip 文件');
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const entries = {};
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break;
    const method = dv.getUint16(off + 10, true);
    const csize = dv.getUint32(off + 20, true);
    const namelen = dv.getUint16(off + 28, true);
    const extralen = dv.getUint16(off + 30, true);
    const commentlen = dv.getUint16(off + 32, true);
    const lho = dv.getUint32(off + 42, true);
    const name = new TextDecoder().decode(new Uint8Array(buffer, off + 46, namelen));
    const lnamelen = dv.getUint16(lho + 26, true);
    const lextralen = dv.getUint16(lho + 28, true);
    const start = lho + 30 + lnamelen + lextralen;
    entries[name] = { method, bytes: new Uint8Array(buffer, start, csize) };
    off += 46 + namelen + extralen + commentlen;
  }
  return entries;
}

async function readEntry(entry) {
  if (entry.method === 0) return new TextDecoder().decode(entry.bytes);
  const stream = new Blob([entry.bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new TextDecoder().decode(await new Response(stream).arrayBuffer());
}

/* ---------------- 安装 ---------------- */

function makeId(code) {
  const m = code.match(/id\s*:\s*['"]([\w.-]+)['"]/);
  return (m && m[1]) || `plug-${Date.now().toString(36)}`;
}

function makeName(code, fallback) {
  const m = code.match(/name\s*:\s*['"]([^'"]+)['"]/);
  return (m && m[1]) || fallback.replace(/\.(js|zip)$/i, '');
}

/**
 * @returns {{ok:boolean, added:Array, errors:Array}}
 */
export async function installFromFiles(fileList) {
  const added = [];
  const errors = [];
  for (const file of Array.from(fileList || [])) {
    try {
      const lower = file.name.toLowerCase();
      let code = '';
      let fallback = file.name;
      if (lower.endsWith('.js')) {
        code = await file.text();
      } else if (lower.endsWith('.zip')) {
        const entries = await unzip(await file.arrayBuffer());
        const manifestKey = Object.keys(entries).find((k) => /(^|\/)plugin\.json$/i.test(k));
        let manifest = {};
        if (manifestKey) {
          try { manifest = JSON.parse(await readEntry(entries[manifestKey])); } catch { /* 忽略坏 manifest */ }
        }
        const jsKey = manifest.entry && entries[manifest.entry]
          ? manifest.entry
          : Object.keys(entries).find((k) => k.toLowerCase().endsWith('.js') && !k.startsWith('__MACOSX'));
        if (!jsKey) throw new Error('压缩包里没有 .js 入口文件');
        code = await readEntry(entries[jsKey]);
        if (manifest.name) fallback = manifest.name;
      } else {
        throw new Error('只支持 .zip 或 .js');
      }

      if (!/EyePilot\s*\.\s*register\s*\(/.test(code)) {
        throw new Error('不是 EyePilot 插件（没有调用 EyePilot.register）');
      }
      const id = makeId(code);
      await put({
        id,
        name: makeName(code, fallback),
        code,
        source: file.name,
        installedAt: Date.now(),
      });
      added.push({ id, name: makeName(code, fallback) });
    } catch (err) {
      errors.push(`${file.name}：${err.message}`);
    }
  }
  return { ok: added.length > 0 && errors.length === 0, added, errors };
}

/* ---------------- 启动时加载 ---------------- */

export async function loadInstalled() {
  const list = await listInstalled();
  let ok = 0;
  for (const p of list) {
    try {
      const url = URL.createObjectURL(new Blob([p.code], { type: 'text/javascript' }));
      await import(/* @vite-ignore */ url);
      URL.revokeObjectURL(url);
      ok++;
    } catch (err) {
      console.warn('[EyePilot] 插件加载失败：', p.id, err);
    }
  }
  return ok;
}
