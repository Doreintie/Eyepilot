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

/**
 * 一维仿射最小二乘：y ≈ a·x + b。
 * 校准的留出点用它修正残余的「整体偏移 (b)」与「增益误差 (a)」，
 * 例如“越往下越偏下”就是 a 偏离 1。
 *
 * v2：n ≥ 5 时改用 Theil–Sen 初始估计 + Huber IRLS 精修。
 * 原来的一阶最小二乘对离群点毫无抵抗力——5 个留出点里只要 1 个点
 * 因眨眼/误视采集失败，增益就会被拉到 clamp 边界，屏幕上产生数百像素
 * 的系统性偏差。Theil–Sen 取所有点对斜率的中位数，可容忍约 30% 坏点；
 * Huber 权重再把坏点压到近乎零，同时保留好点的全部信息。
 */
export function fitAffine1D(xs, ys, { aMin = 0.55, aMax = 1.8, bLimit = 0.35 } = {}) {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return { a: 1, b: 0, n: Math.max(0, n) };

  let a, b;
  if (n >= 5) {
    // ① Theil–Sen：所有点对的斜率取中位数，坏点对只占少数
    const slopes = [];
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = xs[j] - xs[i];
        if (Math.abs(dx) > 1e-9) slopes.push((ys[j] - ys[i]) / dx);
      }
    }
    a = slopes.length ? median(slopes) : 1;
    b = median(xs.map((x, i) => ys[i] - a * x));

    // ② Huber IRLS：以稳健初值起步，残差大的点自动降权
    const resid = xs.map((x, i) => ys[i] - (a * x + b));
    const scale = 1.4826 * medianAbsDev(resid);
    if (scale > 1e-6) {
      for (let iter = 0; iter < 3; iter++) {
        let sw = 0, swx = 0, swy = 0, swxx = 0, swxy = 0;
        for (let i = 0; i < n; i++) {
          const w = Math.min(1, (1.345 * scale) / Math.max(Math.abs(resid[i]), 1e-9));
          sw += w; swx += w * xs[i]; swy += w * ys[i];
          swxx += w * xs[i] * xs[i]; swxy += w * xs[i] * ys[i];
        }
        const den = sw * swxx - swx * swx;
        if (Math.abs(den) < 1e-12) break;
        const na = (sw * swxy - swx * swy) / den;
        const nb = (swy - na * swx) / sw;
        if (!Number.isFinite(na) || !Number.isFinite(nb)) break;
        for (let i = 0; i < n; i++) resid[i] = ys[i] - (na * xs[i] + nb);
        a = na; b = nb;
      }
    }
  } else {
    // 点数太少（3–4 个）时点对不足，退回普通最小二乘
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) {
      sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i];
    }
    const den = n * sxx - sx * sx;
    a = Math.abs(den) < 1e-9 ? 1 : (n * sxy - sx * sy) / den;
    b = (sy - a * sx) / n;
  }
  if (!Number.isFinite(a) || !Number.isFinite(b)) { a = 1; b = 0; }
  a = clamp(a, aMin, aMax);
  b = clamp(b, -bLimit, bLimit);
  return { a, b, n };
}

/**
 * 校准帧的鲁棒聚合：先按头部姿态漂移剔除帧，再逐维用 MAD 剔除特征离群帧，
 * 最后取保留帧的逐维中位数。
 *
 * 校准时用户难免微动头部。原来 collect() 把窗口内所有帧一视同仁地取中位数，
 * 一个正在转头的 400ms 片段会把特征整体带偏。现在头动超过阈值的帧直接不参与，
 * 从源头提高每个校准点的特征质量。
 *
 * @param {{vec:number[], yaw?:number, pitch?:number}[]} samples
 * @returns {number[]|null} 聚合后的特征向量；保留帧不足时返回 null（触发重采）
 */
export function robustAggregate(samples, { min = 6, maxYawDrift = 2.5, maxPitchDrift = 2.5 } = {}) {
  if (!Array.isArray(samples) || samples.length < min) return null;
  const yaws = samples.map((s) => (Number.isFinite(s.yaw) ? s.yaw : 0));
  const pitches = samples.map((s) => (Number.isFinite(s.pitch) ? s.pitch : 0));
  const my = median(yaws), mp = median(pitches);
  const sy = medianAbsDev(yaws), sp = medianAbsDev(pitches);
  const kept = samples.filter((s, i) =>
    Math.abs(yaws[i] - my) <= Math.max(maxYawDrift, 3 * sy) &&
    Math.abs(pitches[i] - mp) <= Math.max(maxPitchDrift, 3 * sp),
  );
  if (kept.length < min) return null;

  const vecs = kept.map((s) => s.vec).filter((v) => Array.isArray(v) && v.length);
  if (vecs.length < min) return null;
  const d = vecs[0].length;
  if (!vecs.every((v) => v.length === d)) return null;

  const mids = medianVector(vecs);
  const devs = [];
  for (let j = 0; j < d; j++) devs.push(medianAbsDev(vecs.map((v) => v[j])));
  const clean = vecs.filter((v) => v.every((val, j) =>
    Math.abs(val - mids[j]) <= Math.max(1e-3, 4 * devs[j]),
  ));
  return medianVector(clean.length >= min ? clean : vecs);
}

export const serializeModel = (m) => ({
  w: m.w, mu: m.mu, sd: m.sd, lambda: m.lambda, d: m.d,
  degree: m.degree, rmse: m.rmse, createdAt: m.createdAt,
});

export const deserializeModel = (o) => (o && Array.isArray(o.w) ? { ...o } : null);

/* ---------------- 眼动特征 ---------------- */

/**
 * 特征版本。改动 buildFeatureVector 的维度或语义时必须 +1，
 * 旧校准模型会因维度不符被自动丢弃并要求重新校准。
 */
export const FEATURE_VERSION = 2;

/** 特征维度（用于校验旧模型） */
export function featureDim(degree = 1) {
  return degree >= 2 ? 10 : 6;
}

const num = (v, fallback = 0) => (Number.isFinite(v) ? v : fallback);

/**
 * 把一帧的人脸几何描述转成回归特征向量（v2）。
 *
 * v1 用的是「虹膜在眼框内的比例」，眼框高度只有 ~20px，1px 关键点抖动
 * 就是 5% 特征变化，且上眼睑会跟着视线一起动，导致垂直方向既抖又偏。
 * v2 改为「虹膜相对内外眼角连线中点，以眼宽为单位」：
 *   hx/ hy  双眼平均的水平/垂直位置（无量纲，跨距离、跨脸型稳定）
 *   vx/ vy  左右眼差值（收敛角），帮助区分远近与轻微头转
 * 特征从 8 维降到 6 维，去掉 lx/rx 这类高度共线的冗余项，回归矩阵条件数显著变好。
 */
export function buildFeatureVector(feat, degree = 1) {
  const f = feat || {};
  const hxL = num(f.hxL);
  const hyL = num(f.hyL);
  const hxR = num(f.hxR);
  const hyR = num(f.hyR);

  const hx = (hxL + hxR) / 2;
  const hy = (hyL + hyR) / 2;
  const vx = hxL - hxR;
  const vy = hyL - hyR;
  const yaw = num(f.yaw);
  const pitch = num(f.pitch);

  const v = [hx, hy, vx, vy, yaw, pitch];
  if (degree >= 2) v.push(hx * hx, hy * hy, hx * hy, vy * vy);
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
