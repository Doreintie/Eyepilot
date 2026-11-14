/* ============================================================
   core/health.js — 纯函数：用眼健康指标
   ============================================================ */

import { clamp, mean, median, std } from './math.js';

/** 双眼睁开度 0..1（1 = 完全睁开） */
export const eyeOpenness = (blinkL = 0, blinkR = 0) => clamp(1 - Math.max(blinkL, blinkR), 0, 1);

/**
 * PERCLOS：窗口内闭眼时间占比。
 * samples: [{t, open}]
 */
export function computePerclos(samples, now, winMs = 60000, closedAt = 0.38) {
  let total = 0, closed = 0;
  for (let i = samples.length - 1; i >= 0; i--) {
    const s = samples[i];
    if (s.t < now - winMs) break;
    if (!s.valid) continue;
    total++;
    if (s.open < closedAt) closed++;
  }
  return total < 5 ? 0 : closed / total;
}

/** 眨眼频率（次/分） */
export function computeBlinkRate(blinks, now, winMs = 60000) {
  let n = 0;
  const since = now - winMs;
  for (let i = blinks.length - 1; i >= 0; i--) {
    if (blinks[i].t >= since) n++;
  }
  return Math.round((n * 60000) / winMs);
}

/** 眨眼时长统计（毫秒） */
export function computeBlinkStats(blinks, now, winMs = 120000) {
  const durs = [];
  const since = now - winMs;
  for (let i = blinks.length - 1; i >= 0; i--) {
    const b = blinks[i];
    if (b.t >= since && b.dur >= 40 && b.dur <= 900) durs.push(b.dur);
  }
  return {
    avgDur: durs.length ? Math.round(mean(durs)) : 0,
    count: durs.length,
  };
}

/** 视距中位数（cm），配合 5 秒窗口可抵抗抖动 */
export function computeDistance(samples, now, winMs = 5000) {
  const vals = [];
  for (let i = samples.length - 1; i >= 0; i--) {
    if (samples[i].t < now - winMs) break;
    const d = samples[i].dist;
    if (d > 15 && d < 200) vals.push(d);
  }
  return vals.length ? Math.round(median(vals)) : 0;
}

export function computeLight(samples, now, winMs = 5000) {
  const vals = [];
  for (let i = samples.length - 1; i >= 0; i--) {
    if (samples[i].t < now - winMs) break;
    if (samples[i].light > 0) vals.push(samples[i].light);
  }
  return vals.length ? Math.round(mean(vals)) : 0;
}

/**
 * 专注度：注视点是否稳定停留在屏幕内。
 * gazes: [{t, x, y, valid, outside}]，x/y 为 0..1 归一化屏幕坐标
 */
export function computeFocus(gazes, now, winMs = 12000) {
  const xs = [], ys = [];
  let total = 0, valid = 0, onScreen = 0;
  for (let i = gazes.length - 1; i >= 0; i--) {
    const g = gazes[i];
    if (g.t < now - winMs) break;
    total++;
    if (!g.valid) continue;
    valid++;
    if (!g.outside) {
      onScreen++;
      xs.push(g.x);
      ys.push(g.y);
    }
  }
  const validRatio = total ? valid / total : 0;
  const onScreenRatio = valid ? onScreen / valid : 0;
  if (valid < 5) return { score: 0, dispersion: 0, validRatio, onScreenRatio, enough: false };

  const dispersion = Math.sqrt(std(xs) ** 2 + std(ys) ** 2);
  const steadiness = 1 - clamp(dispersion / 0.22, 0, 1);
  const score = Math.round(100 * (0.5 * onScreenRatio + 0.32 * steadiness + 0.18 * validRatio));
  return { score: clamp(score, 0, 100), dispersion, validRatio, onScreenRatio, enough: true };
}

/** 疲劳指数 0..100 */
export function computeFatigue({
  perclos = 0, blinkRate = 16, blinkDur = 140,
  minutes = 0, distance = 60, awayRatio = 0,
} = {}) {
  const parts = {
    perclos: clamp(perclos / 0.30, 0, 1),
    blinkRate: clamp((15 - blinkRate) / 15, 0, 1),
    blinkDur: clamp((blinkDur - 150) / 280, 0, 1),
    duration: clamp(minutes / 90, 0, 1),
    distance: clamp((45 - distance) / 20, 0, 1),
    away: clamp(awayRatio / 0.5, 0, 1),
  };
  const w = { perclos: 0.34, blinkRate: 0.22, blinkDur: 0.10, duration: 0.16, distance: 0.10, away: 0.08 };
  let s = 0;
  for (const k in w) s += parts[k] * w[k];
  return { score: Math.round(clamp(s * 100, 0, 100)), parts };
}

export function computeHealthScore(fatigue, blinkRate) {
  const deficit = blinkRate > 0 && blinkRate < 12 ? (12 - blinkRate) * 1.4 : 0;
  return Math.round(clamp(100 - fatigue * 0.85 - deficit, 0, 100));
}

/**
 * 屏幕坐标误差 → 视角（度），假设观看距离与屏幕宽高比已知。
 * @param {number} errPx 像素误差
 * @param {number} screenW 屏幕宽 px
 * @param {number} hfovDeg 屏幕在视野中覆盖的水平角度
 */
export function pxToDegrees(errPx, screenW, hfovDeg = 34) {
  if (!screenW) return 0;
  return (errPx / screenW) * hfovDeg;
}

/** 用针孔模型估算视距（cm）。ipdPx 为两虹膜中心像素距离 */
export function estimateDistanceCm(ipdPx, videoWidth, hfovDeg = 60, ipdMm = 63) {
  if (!ipdPx || ipdPx < 2 || !videoWidth) return 0;
  const f = (videoWidth / 2) / Math.tan((hfovDeg * Math.PI) / 360);
  return Math.round((f * ipdMm) / ipdPx / 10);
}

/** 摄像头平均亮度（0..255）→ 相对照度估计（非专业照度计） */
export function lumaToLux(luma) {
  if (!luma) return 0;
  return Math.round(Math.pow(clamp(luma, 0, 255) / 100, 1.55) * 320);
}

export function levelOfHealth(score) {
  if (score >= 75) return 'good';
  if (score >= 50) return 'warn';
  return 'bad';
}

export function levelOfFatigue(score) {
  if (score >= 70) return 'bad';
  if (score >= 45) return 'warn';
  return 'good';
}
