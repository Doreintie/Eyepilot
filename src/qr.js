/* ============================================================
   qr.js — 极简二维码生成器（byte 模式 / 纠错 M / 版本 3–6）
   ------------------------------------------------------------
   用途：把手机连接地址画成二维码，全程离线，不请求任何第三方服务。
   只覆盖 URL 这种短 ASCII 文本（≤105 字节），因此不需要 40 个版本表。
   参考 ISO/IEC 18004：模式指示 + 字符计数 + 数据 + 终止符 + 填充，
   Reed-Solomon 纠错、交错、8 种掩码与惩罚分都按规范实现。
   ============================================================ */

const SPECS = {
  3: { data: 44, ecc: 26, blocks: [44], align: [6, 22] },
  4: { data: 64, ecc: 18, blocks: [32, 32], align: [6, 26] },
  5: { data: 86, ecc: 24, blocks: [43, 43], align: [6, 30] },
  6: { data: 108, ecc: 16, blocks: [27, 27, 27, 27], align: [6, 34] },
};

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function initGF() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const gfMul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

function rsGen(n) {
  let g = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j];
      next[j + 1] ^= gfMul(g[j], EXP[i]);
    }
    g = next;
  }
  return g;
}

function rsEncode(data, eccLen) {
  const g = rsGen(eccLen);
  const buf = new Uint8Array(data.length + eccLen);
  buf.set(data);
  for (let i = 0; i < data.length; i++) {
    const factor = buf[i];
    if (!factor) continue;
    for (let j = 0; j < g.length; j++) buf[i + j] ^= gfMul(g[j], factor);
  }
  return buf.slice(data.length);
}

function formatBits(mask) {
  const data = (0 << 3) | mask; // 纠错等级 M = 00
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

function buildCodewords(text, spec) {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > spec.data - 3) throw new Error('二维码内容过长');
  const bits = [];
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };
  push(0b0100, 4);
  push(bytes.length, 8);
  for (const b of bytes) push(b, 8);
  const cap = spec.data * 8;
  for (let i = 0; i < 4 && bits.length < cap; i++) bits.push(0);
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
    data.push(v);
  }
  const pad = [0xec, 0x11];
  let p = 0;
  while (data.length < spec.data) data.push(pad[p++ % 2]);

  const dblocks = [];
  const eblocks = [];
  let off = 0;
  for (const len of spec.blocks) {
    const d = data.slice(off, off + len);
    off += len;
    dblocks.push(d);
    eblocks.push(rsEncode(d, spec.ecc));
  }
  const out = [];
  const maxD = Math.max(...spec.blocks);
  for (let i = 0; i < maxD; i++) for (const b of dblocks) if (i < b.length) out.push(b[i]);
  for (let i = 0; i < spec.ecc; i++) for (const e of eblocks) out.push(e[i]);
  return out;
}

function placeFunctionPatterns(size, align) {
  const mod = new Uint8Array(size * size);
  const fn = new Uint8Array(size * size);
  const set = (x, y, v) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    mod[y * size + x] = v ? 1 : 0;
    fn[y * size + x] = 1;
  };
  const finder = (ox, oy) => {
    for (let y = -1; y <= 7; y++) {
      for (let x = -1; x <= 7; x++) {
        const xx = ox + x;
        const yy = oy + y;
        if (xx < 0 || yy < 0 || xx >= size || yy >= size) continue;
        const on = x >= 0 && x <= 6 && y >= 0 && y <= 6
          && (x === 0 || x === 6 || y === 0 || y === 6 || (x >= 2 && x <= 4 && y >= 2 && y <= 4));
        set(xx, yy, on);
      }
    }
  };
  finder(0, 0);
  finder(size - 7, 0);
  finder(0, size - 7);

  for (let i = 8; i < size - 8; i++) {
    set(i, 6, i % 2 === 0);
    set(6, i, i % 2 === 0);
  }

  const last = align.length - 1;
  for (let i = 0; i <= last; i++) {
    for (let j = 0; j <= last; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      const cx = align[i];
      const cy = align[j];
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const on = Math.max(Math.abs(dx), Math.abs(dy)) !== 1;
          set(cx + dx, cy + dy, on);
        }
      }
    }
  }

  // 暗模块
  mod[(size - 8) * size + 8] = 1;
  fn[(size - 8) * size + 8] = 1;

  // 预留给格式信息（数据区跳过）
  for (let i = 0; i < 9; i++) {
    fn[8 * size + i] = 1;
    fn[i * size + 8] = 1;
  }
  for (let i = 0; i < 8; i++) {
    fn[8 * size + (size - 1 - i)] = 1;
    fn[(size - 1 - i) * size + 8] = 1;
  }
  return { mod, fn };
}

function applyMask(mod, fn, size, mask) {
  const out = Uint8Array.from(mod);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (fn[y * size + x]) continue;
      let on = false;
      switch (mask) {
        case 0: on = (x + y) % 2 === 0; break;
        case 1: on = y % 2 === 0; break;
        case 2: on = x % 3 === 0; break;
        case 3: on = (x + y) % 3 === 0; break;
        case 4: on = (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0; break;
        case 5: on = ((x * y) % 2) + ((x * y) % 3) === 0; break;
        case 6: on = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        default: on = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
      }
      if (on) out[y * size + x] ^= 1;
    }
  }
  return out;
}

function writeFormat(mod, size, mask) {
  const bits = formatBits(mask);
  for (let i = 0; i < 15; i++) {
    const b = (bits >> i) & 1;
    if (i < 6) mod[i * size + 8] = b;
    else if (i < 8) mod[(i + 1) * size + 8] = b;
    else mod[(size - 15 + i) * size + 8] = b;

    if (i < 8) mod[8 * size + (size - 1 - i)] = b;
    else if (i < 9) mod[8 * size + 7] = b;
    else mod[8 * size + (15 - i - 1)] = b;
  }
  mod[(size - 8) * size + 8] = 1;
}

function penalty(mod, size) {
  let score = 0;
  for (let y = 0; y < size; y++) {
    let run = 1;
    for (let x = 1; x < size; x++) {
      if (mod[y * size + x] === mod[y * size + x - 1]) run++;
      else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) score += 3 + (run - 5);
  }
  for (let x = 0; x < size; x++) {
    let run = 1;
    for (let y = 1; y < size; y++) {
      if (mod[y * size + x] === mod[(y - 1) * size + x]) run++;
      else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) score += 3 + (run - 5);
  }
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const a = mod[y * size + x];
      if (a === mod[y * size + x + 1] && a === mod[(y + 1) * size + x] && a === mod[(y + 1) * size + x + 1]) {
        score += 3;
      }
    }
  }
  const has = (y, x, v) => (y >= 0 && y < size && x >= 0 && x < size ? mod[y * size + x] === v : false);
  const pat = [1, 0, 1, 1, 1, 0, 1];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x <= size - 7; x++) {
      let ok = true;
      for (let k = 0; k < 7; k++) if (!has(y, x + k, pat[k])) { ok = false; break; }
      if (!ok) continue;
      let before = true;
      let after = true;
      for (let k = 1; k <= 4; k++) if (!has(y, x - k, 0)) { before = false; break; }
      for (let k = 7; k < 11; k++) if (!has(y, x + k, 0)) { after = false; break; }
      if (before || after) score += 40;
    }
  }
  for (let x = 0; x < size; x++) {
    for (let y = 0; y <= size - 7; y++) {
      let ok = true;
      for (let k = 0; k < 7; k++) if (!has(y + k, x, pat[k])) { ok = false; break; }
      if (!ok) continue;
      let before = true;
      let after = true;
      for (let k = 1; k <= 4; k++) if (!has(y - k, x, 0)) { before = false; break; }
      for (let k = 7; k < 11; k++) if (!has(y + k, x, 0)) { after = false; break; }
      if (before || after) score += 40;
    }
  }
  let dark = 0;
  for (let i = 0; i < mod.length; i++) dark += mod[i];
  const pct = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return score;
}

/**
 * 生成二维码矩阵。
 * @returns {{ size:number, modules:Uint8Array, version:number, mask:number }}
 */
export function makeQR(text, { version = 0, mask = -1 } = {}) {
  const bytes = new TextEncoder().encode(text).length;
  const candidates = version ? [version] : Object.keys(SPECS).map(Number);
  const ver = candidates.find((v) => SPECS[v] && bytes <= SPECS[v].data - 3);
  if (!ver) throw new Error('二维码内容过长');
  const spec = SPECS[ver];
  const size = 17 + ver * 4;
  const data = buildCodewords(text, spec);
  const base = placeFunctionPatterns(size, spec.align);

  // 把数据按之字形填进非功能区
  let bit = 0;
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let k = 0; k < size; k++) {
      const y = upward ? size - 1 - k : k;
      for (let dx = 0; dx < 2; dx++) {
        const x = col - dx;
        const idx = y * size + x;
        if (base.fn[idx]) continue;
        const byte = data[bit >> 3];
        base.mod[idx] = byte == null ? 0 : (byte >> (7 - (bit & 7))) & 1;
        bit++;
      }
    }
    upward = !upward;
  }

  const masks = mask >= 0 ? [mask] : [0, 1, 2, 3, 4, 5, 6, 7];
  let best = null;
  for (const m of masks) {
    const mod = applyMask(base.mod, base.fn, size, m);
    writeFormat(mod, size, m);
    const p = penalty(mod, size);
    if (!best || p < best.p) best = { mod, p, m };
  }
  return { size, modules: best.mod, version: ver, mask: best.m };
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** 把二维码画到 canvas 上（自适应 DPR，静区 4 模块） */
export function drawQR(canvas, text, opts = {}) {
  if (!canvas) return false;
  let qr;
  try {
    qr = makeQR(text, opts);
  } catch {
    return false;
  }
  const quiet = opts.quiet == null ? 4 : opts.quiet;
  const modules = qr.size + quiet * 2;
  const cssSize = opts.size || canvas.clientWidth || 160;
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  canvas.width = Math.round(cssSize * dpr);
  canvas.height = Math.round(cssSize * dpr);
  const ctx = canvas.getContext('2d');
  const scale = canvas.width / modules;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = opts.light || '#ffffff';
  roundRect(ctx, 0, 0, canvas.width, canvas.height, opts.radius == null ? 10 * dpr : opts.radius * dpr);
  ctx.fill();

  ctx.fillStyle = opts.dark || '#0b1119';
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (!qr.modules[y * qr.size + x]) continue;
      ctx.fillRect(
        Math.round((x + quiet) * scale),
        Math.round((y + quiet) * scale),
        Math.ceil(scale),
        Math.ceil(scale),
      );
    }
  }
  return true;
}
