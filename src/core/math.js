/* ============================================================
   core/math.js — 纯数学：滤波、岭回归、趋势、特征构造
   该文件不依赖 DOM，可在 Node 中单测。
   ============================================================ */

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export function mean(arr) {
  if (!arr.length) return 0;
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return s / arr.length;
}

export function median(arr) {
  if (!arr.length) return 0;
  const a = Array.from(arr).sort((x, y) => x - y);
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

export function std(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  let s = 0;
  for (const v of arr) s += (v - m) * (v - m);
  return Math.sqrt(s / arr.length);
}

export function lerp(a, b, t) { return a + (b - a) * t; }

export function medianVector(vectors) {
  if (!vectors.length) return [];
  const d = vectors[0].length;
  const out = new Array(d).fill(0);
  const col = new Array(vectors.length);
  for (let j = 0; j < d; j++) {
    for (let i = 0; i < vectors.length; i++) col[i] = vectors[i][j];
    out[j] = median(col);
  }
  return out;
}

export const medianAbsDev = (arr) => {
  if (!arr.length) return 0;
  const m = median(arr);
  return median(arr.map((v) => Math.abs(v - m)));
};

/* ---------------- 高斯消元（部分主元） ---------------- */

function solveLinear(A, B) {
  const n = A.length;
  const k = B[0].length;
  const M = A.map((row, i) => row.concat(B[i]));

  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    }
    if (Math.abs(M[piv][col]) < 1e-12) continue;
    if (piv !== col) { const t = M[col]; M[col] = M[piv]; M[piv] = t; }

    const d = M[col][col];
    for (let c = col; c < n + k; c++) M[col][c] /= d;

    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      if (!f) continue;
      for (let c = col; c < n + k; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row) => row.slice(n));
}

/**
 * 岭回归：Y ≈ f(X)，特征标准化 + 截距不惩罚。
 * @param {number[][]} X n×d
 * @param {number[][]} Y n×k
 * @param {number} lambda 正则强度
 */
export function fitRidge(X, Y, lambda = 1) {
  const n = X.length;
  const d = X[0].length;
  const k = Y[0].length;

  const mu = new Array(d).fill(0);
  const sd = new Array(d).fill(0);
  for (let j = 0; j < d; j++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += X[i][j];
    mu[j] = s / n;
  }
  for (let j = 0; j < d; j++) {
    let s = 0;
    for (let i = 0; i < n; i++) { const dx = X[i][j] - mu[j]; s += dx * dx; }
    sd[j] = Math.sqrt(s / n) || 1;
  }

  const A = Array.from({ length: d + 1 }, () => new Array(d + 1).fill(0));
  const B = Array.from({ length: d + 1 }, () => new Array(k).fill(0));

  for (let i = 0; i < n; i++) {
    const row = [1];
    for (let j = 0; j < d; j++) row.push((X[i][j] - mu[j]) / sd[j]);
    for (let a = 0; a <= d; a++) {
      for (let b = 0; b <= d; b++) A[a][b] += row[a] * row[b];
      for (let c = 0; c < k; c++) B[a][c] += row[a] * Y[i][c];
    }
  }
  for (let a = 1; a <= d; a++) A[a][a] += lambda;

  const w = solveLinear(A, B);
  return { w, mu, sd, lambda, d, n };
}

export function predictRidge(model, x) {
  const row = [1];
  for (let j = 0; j < model.d; j++) row.push((x[j] - model.mu[j]) / (model.sd[j] || 1));
  const k = model.w[0].length;
  const out = new Array(k).fill(0);
  for (let a = 0; a < row.length; a++) {
    const wa = model.w[a];
    for (let c = 0; c < k; c++) out[c] += row[a] * wa[c];
  }
  return out;
}

export const serializeModel = (m) => ({
  w: m.w, mu: m.mu, sd: m.sd, lambda: m.lambda, d: m.d,
  degree: m.degree, rmse: m.rmse, createdAt: m.createdAt,
});

export const deserializeModel = (o) => (o && Array.isArray(o.w) ? { ...o } : null);

/* ---------------- 眼动特征 ---------------- */

/**
 * 把一帧的人脸几何描述转成回归特征向量。
 * 约定：lx/ly 为「鼻侧→颞侧」「上眼睑→下眼睑」的虹膜相对位置（0..1）。
 */
export function buildFeatureVector(feat, degree = 1) {
  const { lx = 0.5, ly = 0.5, rx = 0.5, ry = 0.5 } = feat || {};
  const ax = (lx + rx) / 2;
  const ay = (ly + ry) / 2;
  const yaw = (feat && feat.yaw) || 0;
  const pitch = (feat && feat.pitch) || 0;
  const v = [lx, ly, rx, ry, ax, ay, yaw, pitch];
  if (degree >= 2) v.push(ax * ax, ay * ay, ax * ay, Math.abs(lx - rx));
  return v;
}

/* ---------------- 一欧元滤波 ---------------- */

class LowPass {
  constructor() { this.y = null; }
  filter(x, alpha) {
    this.y = this.y === null ? x : alpha * x + (1 - alpha) * this.y;
    return this.y;
  }
}

export class OneEuroFilter {
  constructor({ minCutoff = 1.1, beta = 0.006, dCutoff = 1.0 } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.xf = new LowPass();
    this.df = new LowPass();
    this.prev = null;
    this.prevRaw = null;
  }
  _alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / Math.max(dt, 1e-4));
  }
  reset() { this.xf.y = null; this.df.y = null; this.prev = null; this.prevRaw = null; }
  filter(x, dt) {
    dt = Math.min(Math.max(dt, 1 / 240), 0.2);
    const dx = this.prevRaw === null ? 0 : (x - this.prevRaw) / dt;
    const edx = this.df.filter(dx, this._alpha(this.dCutoff, dt));
    const cutoff = this.minCutoff + this.beta * Math.abs(edx);
    const y = this.xf.filter(x, this._alpha(cutoff, dt));
    this.prevRaw = x;
    this.prev = y;
    return y;
  }
}

/* ---------------- 趋势 ---------------- */

/** 最小二乘趋势：xs 单位秒，ys 为值 */
export function linearTrend(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return { slope: 0, intercept: ys[n - 1] ?? 0, r2: 0 };
  let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i]; syy += ys[i] * ys[i];
  }
  const denom = n * sxx - sx * sx;
  const slope = Math.abs(denom) < 1e-9 ? 0 : (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  const num = n * sxy - sx * sy;
  const r = Math.abs(num) < 1e-9 ? 0 : num / Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy));
  return { slope, intercept, r2: r * r };
}

export function rmse(actual, predicted) {
  if (!actual.length) return 0;
  let s = 0;
  for (let i = 0; i < actual.length; i++) {
    const dx = actual[i][0] - predicted[i][0];
    const dy = actual[i][1] - predicted[i][1];
    s += dx * dx + dy * dy;
  }
  return Math.sqrt(s / actual.length);
}
