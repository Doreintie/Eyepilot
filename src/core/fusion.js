/* ============================================================
   core/fusion.js — 两路视线的融合（纯函数，可单测）
   ------------------------------------------------------------
   两路信号来自不同视角，直接平均会在「一路很差」时把好的那路拖下水，
   所以这里的规则是：
     1) 某一路无效 → 完全用另一路；
     2) 两路都有效 → 按「用户权重 × 该路置信度」做线性插值；
     3) 插值结果再夹回屏幕内，避免权重异常把光标推出边界。
   只在屏幕坐标域融合，不碰特征域——两边特征语义相同但视角不同，
   在特征域平均会引入无法解释的偏差。
   ============================================================ */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/**
 * @param {object|null} pc    电脑摄像头那一路（含 x/y/nx/ny/valid/confidence）
 * @param {object|null} phone 手机那一路
 * @param {number} weight     0..1，用户设定的手机权重
 * @param {number} vw,vh      视口尺寸（夹边用）
 */
export function fuseTwo(pc, phone, weight, vw, vh) {
  const w = clamp(Number(weight) || 0, 0, 1);
  const pcOk = !!(pc && pc.valid);
  const phOk = !!(phone && phone.valid);

  if (!phOk) return pc ? { ...pc, source: pcOk ? 'pc' : (pc.source || 'pc') } : { valid: false };
  if (!pcOk) return { ...phone, source: 'phone' };

  const p = w * clamp(phone.confidence == null ? 1 : phone.confidence, 0, 1);
  const x = pc.x + (phone.x - pc.x) * p;
  const y = pc.y + (phone.y - pc.y) * p;
  return {
    ...pc,
    x: clamp(x, 0, vw),
    y: clamp(y, 0, vh),
    nx: clamp(x, 0, vw) / vw,
    ny: clamp(y, 0, vh) / vh,
    source: p > 0.001 ? 'fuse' : 'pc',
    fuseWeight: p,
  };
}

/** 两路各自的偏差有多大——用于界面提示「手机装反了 / 差太远」 */
export function disagreement(a, b) {
  if (!a || !b || !a.valid || !b.valid) return null;
  return Math.hypot(a.x - b.x, a.y - b.y);
}
