/* ============================================================
   charts.js — 轻量 Canvas 图表（无第三方依赖）
   ============================================================ */

import { clamp } from './core/math.js';

export function fitCanvas(canvas, aspect = null) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cssW = canvas.clientWidth || canvas.parentElement.clientWidth || 600;
  const cssH = aspect ? cssW / aspect : canvas.clientHeight || Number(canvas.dataset.h || 180);
  const w = Math.max(120, Math.round(cssW));
  const h = Math.max(80, Math.round(cssH));
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

function niceMax(v) {
  const steps = [4, 8, 12, 16, 20, 24, 32, 40, 60, 80, 100, 120, 160, 200, 240, 300, 400, 600, 800];
  for (const s of steps) if (v <= s) return s;
  return Math.ceil(v / 200) * 200;
}

const cssVar = (name, fallback) => {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
};

function hexToRgba(hex, a) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  if (Number.isNaN(n)) return `rgba(46,230,214,${a})`;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{series: Array<{points: [number, number][], color?: string, fill?: boolean}>, yMin?: number, yMax?: number, minSpan?: number, unit?: string, threshold?: number, windowMs?: number}} opts
 */
export function lineChart(canvas, opts) {
  const { ctx, w, h } = fitCanvas(canvas);
  const accent = cssVar('--accent', '#2ee6d6');
  const accent2 = cssVar('--accent-2', '#7c9cff');
  const lineColor = cssVar('--line', 'rgba(255,255,255,.07)');
  const dim = cssVar('--dim', '#5c6b85');
  const text = cssVar('--muted', '#8b9bb6');

  ctx.clearRect(0, 0, w, h);
  const pad = { l: 34, r: 10, t: 12, b: 18 };
  const iw = w - pad.l - pad.r;
  const ih = h - pad.t - pad.b;

  const now = Date.now();
  const win = opts.windowMs || 10 * 60 * 1000;
  const tMax = now;
  const tMin = now - win;

  const all = opts.series.flatMap((s) => s.points);
  let yMax = opts.yMax;
  let yMin = opts.yMin;
  if (yMax === undefined) {
    const raw = all.length ? Math.max(...all.map((p) => p[1])) * 1.15 : (opts.minSpan || 5);
    yMax = niceMax(Math.max(raw, opts.minSpan || 5));
  }
  if (yMin === undefined) yMin = 0;

  // 网格 + Y 轴刻度
  ctx.font = '10px ui-monospace, monospace';
  ctx.fillStyle = text;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 1;
  const TICKS = 4;
  for (let i = 0; i <= TICKS; i++) {
    const y = pad.t + (ih * i) / TICKS;
    ctx.beginPath();
    ctx.moveTo(pad.l, y + 0.5);
    ctx.lineTo(w - pad.r, y + 0.5);
    ctx.stroke();
    const val = yMax - ((yMax - yMin) * i) / TICKS;
    ctx.fillText(String(Math.round(val)), pad.l - 7, y);
  }

  // X 轴时间
  ctx.textAlign = 'center';
  ctx.fillStyle = dim;
  for (let i = 0; i <= 2; i++) {
    const t = tMin + (win * i) / 2;
    const x = pad.l + (iw * i) / 2;
    const d = new Date(t);
    const label = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    ctx.fillText(i === 2 ? '现在' : label, x, h - 7);
  }

  if (!all.length) {
    ctx.fillStyle = dim;
    ctx.textAlign = 'center';
    ctx.font = '11px system-ui';
    ctx.fillText('等待数据…', pad.l + iw / 2, pad.t + ih / 2);
    return;
  }

  const toXY = (t, v) => [
    pad.l + clamp((t - tMin) / (tMax - tMin), 0, 1) * iw,
    pad.t + ih - clamp((v - yMin) / Math.max(1e-6, yMax - yMin), 0, 1) * ih,
  ];

  // 阈值线
  if (opts.threshold !== undefined) {
    const y = pad.t + ih - clamp((opts.threshold - yMin) / Math.max(1e-6, yMax - yMin), 0, 1) * ih;
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = hexToRgba(cssVar('--warn', '#ffc14d'), 0.55);
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(w - pad.r, y);
    ctx.stroke();
    ctx.restore();
  }

  opts.series.forEach((s, si) => {
    if (!s.points.length) return;
    const color = s.color || (si === 0 ? accent : accent2);
    const pts = s.points
      .filter((p) => p[0] >= tMin - 1000)
      .map((p) => toXY(p[0], p[1]));
    if (pts.length < 2) {
      if (pts.length === 1) {
        ctx.beginPath();
        ctx.arc(pts[0][0], pts[0][1], 2.5, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
      }
      return;
    }

    if (s.fill !== false) {
      const grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + ih);
      grad.addColorStop(0, hexToRgba(color, 0.30));
      grad.addColorStop(1, hexToRgba(color, 0.01));
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pad.t + ih);
      for (const [x, y] of pts) ctx.lineTo(x, y);
      ctx.lineTo(pts[pts.length - 1][0], pad.t + ih);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
    }

    ctx.beginPath();
    pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.8;
    ctx.lineJoin = 'round';
    ctx.stroke();

    const [lx, ly] = pts[pts.length - 1];
    ctx.beginPath();
    ctx.arc(lx, ly, 3, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(lx, ly, 6, 0, Math.PI * 2);
    ctx.fillStyle = hexToRgba(color, 0.18);
    ctx.fill();
  });
}

/** 注视热力图：grid 为 rows×cols 权重数组 */
export function drawHeatmap(canvas, grid, cols = 24, rows = 12, { max } = {}) {
  const { ctx, w, h } = fitCanvas(canvas, 2);
  const cw = w / cols;
  const ch = h / rows;
  const surface = cssVar('--panel-2', '#111a28');

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = surface;
  ctx.fillRect(0, 0, w, h);

  let peak = max || 0;
  if (!peak) for (const v of grid) if (v > peak) peak = v;

  if (peak > 0) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.filter = `blur(${Math.max(3.5, cw * 0.18)}px)`;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const v = grid[r * cols + c] || 0;
        if (v <= 0) continue;
        const t = Math.pow(v / peak, 0.6);
        const cx = c * cw + cw / 2;
        const cy = r * ch + ch / 2;
        const rad = Math.max(cw, ch) * (0.7 + t * 1.05);
        let color;
        if (t > 0.72) color = `rgba(255,193,77,${0.14 + t * 0.40})`;
        else if (t > 0.4) color = `rgba(124,156,255,${0.14 + t * 0.42})`;
        else color = `rgba(46,230,214,${0.10 + t * 0.36})`;
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
        g.addColorStop(0, color);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(cx, cy, rad, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  } else {
    ctx.fillStyle = cssVar('--dim', '#5c6b85');
    ctx.font = '12px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('校准后开始记录注视点', w / 2, h / 2);
  }

  // 周边框与中线
  ctx.strokeStyle = cssVar('--line-2', 'rgba(255,255,255,.14)');
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
  ctx.setLineDash([3, 5]);
  ctx.strokeStyle = cssVar('--line', 'rgba(255,255,255,.07)');
  ctx.beginPath();
  ctx.moveTo(w / 2, 0);
  ctx.lineTo(w / 2, h);
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();
  ctx.setLineDash([]);
}

export function sparkline(canvas, values, color) {
  const { ctx, w, h } = fitCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  if (values.length < 2) return;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  ctx.beginPath();
  values.forEach((v, i) => {
    const x = (i / (values.length - 1)) * w;
    const y = h - ((v - min) / Math.max(1e-6, max - min)) * (h - 2) - 1;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.strokeStyle = color || cssVar('--accent', '#2ee6d6');
  ctx.lineWidth = 1.6;
  ctx.stroke();
}
