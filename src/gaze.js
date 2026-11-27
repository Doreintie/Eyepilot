/* ============================================================
   gaze.js — 视线映射（岭回归）、平滑、九点校准
   ============================================================ */

import {
  OneEuroFilter, buildFeatureVector, fitRidge, predictRidge,
  medianVector, clamp, mean, lerp, FEATURE_VERSION, fitAffine1D, robustAggregate,
} from './core/math.js';
import { pxToDegrees } from './core/health.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class GazeTracker {
  constructor({ onGaze } = {}) {
    this.onGaze = onGaze || (() => {});
    this.model = null;
    this.fx = new OneEuroFilter({ minCutoff: 1.2, beta: 0.008 });
    this.fy = new OneEuroFilter({ minCutoff: 1.2, beta: 0.008 });
    this.gaze = { x: 0, y: 0, valid: false, confidence: 0, outside: false, ts: 0 };
    this.prevT = 0;
    this.miss = 0;
    this.holdMs = 0;
    this.smooth = 65;
    this.rawBuf = [];
    this.lastGood = null;
    this.goodAt = 0;
    this.offset = { x: 0, y: 0 };
    this.beyondSince = 0;
    this.shown = null;
    this.cutoff = null;   // 自适应一欧元截止频率，按每帧置信度缓慢调整
    // 使用中自校准：每次“注视点击”都提供了一个我们知道大致落点的样本，
    // 用它缓慢修正整体偏移，抵消头位变化带来的漂移。
    this.auto = { x: 0, y: 0, n: 0 };

    /* ---- 头部控制模式（借鉴 visual_mouse 的思路）----
       不用虹膜，直接用头部转角：整张脸的几何平均，噪声比虹膜小一个数量级。
       角度 → 目标位置，再以「限速 + 死区」的方式把光标挪过去，
       所以即使角度有噪声，光标也只是轻微改变速度，不会跳。 */
    this.controlMode = 'eye';
    this.head = { hRange: 8, vRange: 5, dead: 44, maxSpeed: 1100, tau: 0.09, hybridRange: 110, hybridDead: 12, hybridTau: 0.18, only: false };
    this.headZero = { yaw: 0, pitch: 0 };
    this.headPos = null;
    this.headMoving = false;
    this.headYaw = null;
    this.headPitch = null;
    this.hybridDelta = null;
    // 头部角度是低频信号（人的转头 < 3Hz），截止频率压低，噪声基本走不动光标
    this.hfx = new OneEuroFilter({ minCutoff: 1.0, beta: 0.006 });
    this.hfy = new OneEuroFilter({ minCutoff: 1.0, beta: 0.006 });
    // 混合模式里虹膜只提供残差，必须走和眼控一样的「中值 + 一欧元」，
    // 否则残差本身的噪声会直接叠到头部定位上
    this.irisBuf = [];
    this.ifx = new OneEuroFilter({ minCutoff: 0.9, beta: 0.006 });
    this.ify = new OneEuroFilter({ minCutoff: 0.9, beta: 0.006 });
    // 远端（手机）专用：同样的滤波参数，但独立的缓冲与校正
    this.remoteBuf = [];
    this.rfx = new OneEuroFilter({ minCutoff: 1.0, beta: 0.006 });
    this.rfy = new OneEuroFilter({ minCutoff: 1.0, beta: 0.006 });
  }

  setControlMode(mode) {
    this.controlMode = ['eye', 'hybrid', 'head', 'mouse'].includes(mode) ? mode : 'eye';
    this.reset();
  }

  setHeadConfig(cfg = {}) {
    this.head = { ...this.head, ...cfg };
  }

  setHeadZero(yaw, pitch) {
    this.headZero = { yaw: Number(yaw) || 0, pitch: Number(pitch) || 0 };
    this.headPos = null;
    this.headMoving = false;
  }

  setAuto(x, y, n = 0) {
    this.auto = { x: Number(x) || 0, y: Number(y) || 0, n: Number(n) || 0 };
  }

  resetAuto() {
    this.auto = { x: 0, y: 0, n: 0 };
    this.reset();
  }

  /**
   * 用一次已知落点修正整体偏移：target 是用户注视目标的屏幕坐标。
   * 残差过大（说明看的是别处或识别跳点）直接丢弃；修正量做 EMA，避免单次抖动带偏。
   */
  /** 头部角度 → 屏幕目标点（含滤波、归中、灵敏度） */
  headAim(frame, dt) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const rawYaw = Number.isFinite(frame.yawDeg) ? frame.yawDeg : 0;
    const rawPitch = Number.isFinite(frame.pitchDeg) ? frame.pitchDeg : 0;
    this.headYaw = this.hfx.filter(rawYaw, dt);
    this.headPitch = this.hfy.filter(rawPitch, dt);

    const yaw = this.headYaw - this.headZero.yaw;
    const pitch = this.headPitch - this.headZero.pitch;
    const hRange = Math.max(2, this.head.hRange);
    const vRange = Math.max(1.5, this.head.vRange);
    // 左转（yaw>0）→ 光标左移；低头（pitch>0）→ 光标下移
    const nx = clamp(0.5 - yaw / (2 * hRange), 0, 1);
    const ny = clamp(0.5 + pitch / (2 * vRange), 0, 1);
    const margin = 8;
    return {
      nx,
      ny,
      x: clamp(nx * vw, margin, vw - margin),
      y: clamp(ny * vh, margin, vh - margin),
      yaw,
      pitch,
    };
  }

  /** 虹膜模型的一手预测（含仿射校正与手动偏移），供眼控与混合模式共用 */
  predictIris(frame) {
    if (!this.model) return null;
    const vec = buildFeatureVector(frame, this.model.degree || 1);
    const pred = predictRidge(this.model, vec);
    const calX = this.model.calX || { a: 1, b: 0 };
    const calY = this.model.calY || { a: 1, b: 0 };
    const legacy = this.model.bias || [0, 0];
    const nx = this.model.calX ? calX.a * pred[0] + calX.b : pred[0] + legacy[0];
    const ny = this.model.calY ? calY.a * pred[1] + calY.b : pred[1] + legacy[1];
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    return {
      nx,
      ny,
      x: clamp(nx, 0, 1) * vw + this.offset.x + this.auto.x,
      y: clamp(ny, 0, 1) * vh + this.offset.y + this.auto.y,
      vec,
    };
  }

  /**
   * 手机那一路的预测。
   * 手机架在侧上方 30–45°，和电脑摄像头不是同一个视角，同一个模型直接套
   * 会带一个系统性偏移，所以这里**只**叠手机自己的仿射校正（phoneCal），
   * 不碰 PC 的 offset / auto —— 那两个量是「本机视角下」的修正。
   */
  predictRemote(frame, cal, dt = 1 / 24) {
    if (!this.model || !frame || !frame.present) return null;
    const vec = buildFeatureVector(frame, this.model.degree || 1);
    if (!vec.length) return null;
    const pred = predictRidge(this.model, vec);

    // 手机端帧率比本机低，单帧噪声占比更高，中值窗口同样取 5
    this.remoteBuf.push([pred[0], pred[1]]);
    if (this.remoteBuf.length > 5) this.remoteBuf.shift();
    const xs = this.remoteBuf.map((v) => v[0]).sort((a, b) => a - b);
    const ys = this.remoteBuf.map((v) => v[1]).sort((a, b) => a - b);
    const mx = xs[xs.length >> 1];
    const my = ys[ys.length >> 1];

    const cx = (cal && cal.x) || { a: 1, b: 0 };
    const cy = (cal && cal.y) || { a: 1, b: 0 };
    const nx = clamp(cx.a * mx + cx.b, -0.25, 1.25);
    const ny = clamp(cy.a * my + cy.b, -0.25, 1.25);
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let conf = 1;
    if (frame.open < 0.55) conf *= clamp((frame.open - 0.32) / 0.23, 0.15, 1);
    conf *= 1 - clamp(Math.abs(frame.yaw || 0) * 0.5, 0, 0.35);

    return {
      nx,
      ny,
      x: clamp(this.rfx.filter(clamp(nx, 0, 1) * vw, Math.min(0.2, dt)), 0, vw),
      y: clamp(this.rfy.filter(clamp(ny, 0, 1) * vh, Math.min(0.2, dt)), 0, vh),
      rawX: mx,
      rawY: my,
      confidence: conf,
      valid: conf > 0.28 && nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1,
      source: 'phone',
    };
  }

  /** 虹膜预测的轻量平滑（5 帧中值 + 一欧元） */
  smoothIris(p, dt) {
    this.irisBuf.push([p.x, p.y]);
    if (this.irisBuf.length > 5) this.irisBuf.shift();
    const xs = this.irisBuf.map((v) => v[0]).sort((a, b) => a - b);
    const ys = this.irisBuf.map((v) => v[1]).sort((a, b) => a - b);
    const mx = xs[Math.floor(xs.length / 2)];
    const my = ys[Math.floor(ys.length / 2)];
    return { x: this.ifx.filter(mx, dt), y: this.ify.filter(my, dt) };
  }

  /** 死区 + 限速的逼近，head / hybrid 共用 */
  approach(target, dt, dead) {
    if (!this.headPos) this.headPos = { x: target.x, y: target.y };
    const dx = target.x - this.headPos.x;
    const dy = target.y - this.headPos.y;
    const dist = Math.hypot(dx, dy);

    if (!this.headMoving && dist > dead) this.headMoving = true;
    if (this.headMoving && dist < dead * 0.35) this.headMoving = false;

    if (this.headMoving) {
      const k = 1 - Math.exp(-dt / Math.max(0.02, this.head.tau));
      let stepX = dx * k;
      let stepY = dy * k;
      const maxStep = this.head.maxSpeed * dt;
      const stepLen = Math.hypot(stepX, stepY);
      if (stepLen > maxStep) {
        const s = maxStep / stepLen;
        stepX *= s;
        stepY *= s;
      }
      this.headPos.x = clamp(this.headPos.x + stepX, 0, window.innerWidth);
      this.headPos.y = clamp(this.headPos.y + stepY, 0, window.innerHeight);
    }
    return this.headPos;
  }

  packageGaze(pos, now, frame, extra = {}) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    return {
      x: pos.x,
      y: pos.y,
      nx: pos.x / vw,
      ny: pos.y / vh,
      rawX: pos.x,
      rawY: pos.y,
      predX: pos.x / vw,
      predY: pos.y / vh,
      valid: true,
      confidence: 0.92,
      outside: false,
      open: frame.open == null ? 1 : frame.open,
      ts: now,
      ...extra,
    };
  }

  /**
   * 头部模式：角度 → 目标位置，再限速逼近。角度噪声只改变速度，不改变位置。
   */
  updateHead(frame, now) {
    const dt = this.prevT ? Math.min(0.2, (now - this.prevT) / 1000) : 1 / 30;
    this.prevT = now;
    const open = frame.open == null ? 1 : frame.open;
    if (open < 0.32) {
      this.gaze = { ...this.gaze, valid: false, confidence: 0, ts: now, reason: 'blink' };
      this.onGaze(this.gaze);
      return this.gaze;
    }
    const aim = this.headAim(frame, dt);
    const pos = this.approach(aim, dt, this.head.dead);
    this.gaze = this.packageGaze(pos, now, frame, { reason: 'head', headYaw: aim.yaw, headPitch: aim.pitch });
    this.onGaze(this.gaze);
    return this.gaze;
  }

  /**
   * 混合模式：头部负责粗定位，虹膜只贡献 ±R 以内的残差。
   * 即使虹膜模型很糟，最坏也只是偏 R 像素，而且会被限速抹平；
   * 头部动得多、虹膜抖得凶，在这里正好互补。
   */
  updateHybrid(frame, now) {
    const dt = this.prevT ? Math.min(0.2, (now - this.prevT) / 1000) : 1 / 30;
    this.prevT = now;
    const open = frame.open == null ? 1 : frame.open;
    if (open < 0.32) {
      this.gaze = { ...this.gaze, valid: false, confidence: 0, ts: now, reason: 'blink' };
      this.onGaze(this.gaze);
      return this.gaze;
    }

    const aim = this.headAim(frame, dt);
    const iris = this.predictIris(frame);
    const R = Math.max(20, this.head.hybridRange || 110);
    let dx = 0;
    let dy = 0;
    if (iris) {
      const s = this.smoothIris(iris, dt);
      dx = clamp(s.x - aim.x, -R, R);
      dy = clamp(s.y - aim.y, -R, R);
    }
    if (!this.hybridDelta) this.hybridDelta = { x: 0, y: 0 };
    const k = 1 - Math.exp(-dt / Math.max(0.05, this.head.hybridTau || 0.18));
    this.hybridDelta.x += (dx - this.hybridDelta.x) * k;
    this.hybridDelta.y += (dy - this.hybridDelta.y) * k;

    const target = {
      x: clamp(aim.x + this.hybridDelta.x, 0, window.innerWidth),
      y: clamp(aim.y + this.hybridDelta.y, 0, window.innerHeight),
    };
    const dead = this.head.hybridDead == null ? 12 : this.head.hybridDead;
    const pos = this.approach(target, dt, dead);
    this.gaze = this.packageGaze(pos, now, frame, {
      reason: 'hybrid',
      headYaw: aim.yaw,
      headPitch: aim.pitch,
      irisOk: !!iris,
    });
    this.onGaze(this.gaze);
    return this.gaze;
  }

  observeAnchor(tx, ty) {
    const g = this.gaze;
    // 低置信度时视线位置本身不可信，拿它当锚点等于「用噪声校准模型」
    if (!g || !g.valid || g.confidence < 0.55 || !Number.isFinite(tx) || !Number.isFinite(ty)) return false;
    const dx = tx - g.x;
    const dy = ty - g.y;
    if (Math.hypot(dx, dy) > 220) return false;
    const k = 0.28;
    this.auto.x = clamp(this.auto.x + dx * k, -170, 170);
    this.auto.y = clamp(this.auto.y + dy * k, -170, 170);
    this.auto.n++;
    return true;
  }

  setSmooth(v) {
    this.smooth = clamp(v, 0, 100);
    // 眼控场景下宁可慢一点，也不要抖：截止频率整体下移
    const minCutoff = lerp(2.2, 0.28, this.smooth / 100);
    const beta = lerp(0.012, 0.0015, this.smooth / 100);
    this.fx = new OneEuroFilter({ minCutoff, beta });
    this.fy = new OneEuroFilter({ minCutoff, beta });
    this.cutoff = null;   // 让自适应截止频率从新参数重新起步
  }

  setOffset(x, y) {
    this.offset = { x: Number(x) || 0, y: Number(y) || 0 };
  }

  setModel(model) {
    this.model = model || null;
    if (model && model.smooth) this.setSmooth(model.smooth);
    this.reset();
  }

  reset() {
    this.fx.reset();
    this.fy.reset();
    this.prevT = 0;
    this.holdMs = 0;
    this.rawBuf = [];
    this.lastGood = null;
    this.goodAt = 0;
    this.beyondSince = 0;
    this.shown = null;
    this.cutoff = null;
    this.headPos = null;
    this.headMoving = false;
    this.headYaw = null;
    this.headPitch = null;
    this.hybridDelta = null;
    this.irisBuf = [];
    this.ifx.reset();
    this.ify.reset();
    // 手机那一路有自己的一套平滑与仿射校正，不能和本机共用缓冲
    this.remoteBuf = [];
    this.rfx.reset();
    this.rfy.reset();
    this.hfx.reset();
    this.hfy.reset();
  }

  update(frame) {
    const now = frame.t || performance.now();
    const last = this.gaze;

    if (!frame.present) {
      this.miss++;
      if (this.miss > 2) {
        this.gaze = { ...last, valid: false, confidence: 0, ts: now, reason: 'noface' };
        this.onGaze(this.gaze);
      }
      return this.gaze;
    }
    this.miss = 0;

    if (this.controlMode === 'mouse') {
      this.gaze = { ...this.gaze, valid: false, confidence: 0, ts: now, reason: 'mouse' };
      this.onGaze(this.gaze);
      return this.gaze;
    }
    // 头部 = 眼控 + 头控：头姿给基准位置，虹膜只做 ±R 残差精修。
    // 老的「只看头」保留成开关（head.only），默认关。
    if (this.controlMode === 'head') {
      return this.head.only ? this.updateHead(frame, now) : this.updateHybrid(frame, now);
    }
    // 混合 = 眼控 + 鼠标：光标仍由虹膜算，鼠标由主流程的 override 叠上来，
    // 所以这里不拦截，直接走下面的虹膜路径。

    if (!this.model) {
      this.gaze = { ...last, valid: false, confidence: 0, ts: now, reason: 'uncalibrated' };
      this.onGaze(this.gaze);
      return this.gaze;
    }

    if (frame.open < 0.32) {
      this.gaze = { ...last, valid: false, confidence: 0, ts: now, reason: 'blink' };
      this.onGaze(this.gaze);
      return this.gaze;
    }

    const vec = buildFeatureVector(frame, this.model.degree || 1);
    const pred = predictRidge(this.model, vec);

    // 校准阶段拟合出的「一维仿射校正」：把预测值拉回真实屏幕坐标。
    // 只有平移项（bias）时，靠近屏幕边缘的误差依然很大；带上增益 a 之后，
    // “整体偏下”“越往下越偏”这两种情况能同时被纠正。
    const calX = this.model.calX || { a: 1, b: 0 };
    const calY = this.model.calY || { a: 1, b: 0 };
    const legacy = this.model.bias || [0, 0];
    let nx = this.model.calX ? calX.a * pred[0] + calX.b : pred[0] + legacy[0];
    let ny = this.model.calY ? calY.a * pred[1] + calY.b : pred[1] + legacy[1];

    // 五帧中值：先把单帧跳点（关键点抖动）挡掉；五帧的滞后约 2 帧，肉眼无感
    this.rawBuf.push([nx, ny]);
    if (this.rawBuf.length > 5) this.rawBuf.shift();
    const colX = this.rawBuf.map((p) => p[0]).sort((a, b) => a - b);
    const colY = this.rawBuf.map((p) => p[1]).sort((a, b) => a - b);
    const mx = colX[Math.floor(colX.length / 2)];
    const my = colY[Math.floor(colY.length / 2)];

    // 「视线离开屏幕」必须带迟滞：
    // 原来只要越过 4.5% 就立刻判定，瞳孔抖一下、或用户在看屏幕最下沿，
    // 就会不断弹出“视线已离开屏幕”。现在要求持续越界，且越界很多时才快速判定。
    const marginIn = 0.06;
    const marginHard = 0.22;
    const beyond = mx < -marginIn || mx > 1 + marginIn || my < -marginIn || my > 1 + marginIn;
    const farBeyond = mx < -marginHard || mx > 1 + marginHard || my < -marginHard || my > 1 + marginHard;
    if (beyond) {
      if (!this.beyondSince) this.beyondSince = now;
    } else {
      this.beyondSince = 0;
    }
    const held = this.beyondSince ? now - this.beyondSince : 0;
    const outside = beyond && held > (farBeyond ? 220 : 800);

    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // 置信度：眼睛张得越小 / 特征越偏离校准分布，越低。
    // 提前到滤波之前计算，好让平滑强度随信号质量动态调整。
    let conf = 1;
    if (frame.open < 0.55) conf *= clamp((frame.open - 0.32) / 0.23, 0.15, 1);
    if (this.model.mu) {
      let z = 0;
      for (let i = 0; i < vec.length; i++) {
        const s = this.model.sd[i] || 1;
        z += ((vec[i] - this.model.mu[i]) / s) ** 2;
      }
      z = Math.sqrt(z / vec.length);
      if (z > 2.2) conf *= clamp(1 - (z - 2.2) / 3.4, 0.15, 1);
    }
    conf *= 1 - clamp(Math.abs(frame.yaw) * 0.5, 0, 0.35);

    const dt = this.prevT ? (now - this.prevT) / 1000 : 1 / 30;
    this.prevT = now;

    // 超过 400ms 没有有效点，重置滤波器，避免恢复时拖尾
    if (this.lastGood && now - this.goodAt > 400) {
      this.fx.reset();
      this.fy.reset();
      this.shown = null;
    }

    // 信号干净时放开截止频率（跟手），噪声大时压低（稳）。
    // 用 EMA 过渡，避免参数逐帧跳变反而让滤波自身震荡。
    const baseCutoff = lerp(2.2, 0.28, this.smooth / 100);
    const wantCutoff = baseCutoff * lerp(0.55, 1.12, clamp(conf, 0, 1));
    this.cutoff = this.cutoff == null ? wantCutoff : lerp(this.cutoff, wantCutoff, 0.08);
    this.fx.minCutoff = this.cutoff;
    this.fy.minCutoff = this.cutoff;

    const px = clamp(mx, 0, 1) * vw + this.offset.x + this.auto.x;
    const py = clamp(my, 0, 1) * vh + this.offset.y + this.auto.y;
    let fx = clamp(this.fx.filter(clamp(px, 0, vw), dt), 0, vw);
    let fy = clamp(this.fy.filter(clamp(py, 0, vh), dt), 0, vh);

    const valid = conf > 0.28 && !outside;

    // 死区：静止注视时人眼本身就有微颤，小幅位移不直接输出。
    // 原来 shown 完全锁死，缓慢移动会「粘住再跳一下」；现在死区内让 shown
    // 以 18%/帧缓慢跟进，微颤仍被吸收，但连续移动不再产生台阶。
    if (valid) {
      const dz = conf > 0.6 ? 2.2 : 4.2;
      if (!this.shown) this.shown = { x: fx, y: fy };
      const ddx = fx - this.shown.x;
      const ddy = fy - this.shown.y;
      if (ddx * ddx + ddy * ddy < dz * dz) {
        this.shown.x += ddx * 0.18;
        this.shown.y += ddy * 0.18;
        fx = this.shown.x;
        fy = this.shown.y;
      } else {
        this.shown = { x: fx, y: fy };
      }
      this.lastGood = { x: fx, y: fy };
      this.goodAt = now;
    }

    // 无效帧不跳到预测点，而是停在最后可信位置（变暗、不可点击）
    const outX = valid ? fx : this.lastGood ? this.lastGood.x : fx;
    const outY = valid ? fy : this.lastGood ? this.lastGood.y : fy;

    this.gaze = {
      x: outX,
      y: outY,
      nx: outX / vw,
      ny: outY / vh,
      rawX: mx * vw,
      rawY: my * vh,
      // 校正前的一手预测值：纵向三点微调用它重新拟合，避免在已校正的坐标上再校正
      predX: pred[0],
      predY: pred[1],
      valid,
      confidence: conf,
      outside,
      open: frame.open,
      ts: now,
      reason: outside ? 'outside' : !valid ? 'lowconf' : 'ok',
    };
    this.onGaze(this.gaze);
    return this.gaze;
  }
}

/* =================================================================
   校准器
   ================================================================= */

export class Calibrator {
  constructor({ tracker, els, onDone, onCancel, onProgress }) {
    this.tracker = tracker;
    this.els = els;
    this.onDone = onDone || (() => {});
    this.onCancel = onCancel || (() => {});
    this.onProgress = onProgress || (() => {});
    this.active = false;
    this.buf = [];
    this.collector = null;
    this.cancelled = false;
    this.points = 9;
    this.degree = 1;
    this.faceHintAt = 0;
    this.lastFrame = null;
  }

  pushFrame(frame) {
    if (!this.active) return;
    this.lastFrame = frame;
    this.updateFaceStatus(frame);
    if (!this.collector) return;
    if (!frame || !frame.present || frame.open < 0.18) return;
    // 连头部姿态一起存：聚合时把正在转头的帧剔掉，避免把头动误当成眼动写进模型
    this.collector.vecs.push({
      vec: buildFeatureVector(frame, this.degree),
      yaw: Number.isFinite(frame.yawDeg) ? frame.yawDeg : 0,
      pitch: Number.isFinite(frame.pitchDeg) ? frame.pitchDeg : 0,
    });
  }

  /** 校准前根据点数改写标题、说明与距离提示，避免 16 点仍显示“九点校准” */
  applyLabels(total) {
    const cn = total >= 16 ? '十六点校准' : '九点校准';
    const en = total >= 16 ? 'SIXTEEN-POINT CALIBRATION' : 'NINE-POINT CALIBRATION';
    if (this.els.brand) this.els.brand.textContent = cn;
    if (this.els.eyebrow) this.els.eyebrow.textContent = en;
    if (this.els.introText) {
      this.els.introText.innerHTML = `建议离屏幕 <b>50–65 cm</b>（约一臂），让脸占画面三分之一；依次注视出现的 ${total} 个圆点。`;
    }
  }

  /** 校准过程中的人脸位置/光线/距离提示，帮助用户自己修正 */
  updateFaceStatus(frame) {
    const pill = this.els.facePill;
    if (!pill) return;
    const now = performance.now();
    if (now - this.faceHintAt < 350) return;
    this.faceHintAt = now;

    let text = '人脸正常';
    let cls = 'on';
    if (!frame || !frame.present) {
      text = '未检测到人脸';
      cls = 'bad';
    } else {
      const fw = frame.frameWidth || 1280;
      const box = frame.faceBox || { minX: 0, maxX: 0 };
      const ratio = (box.maxX - box.minX) / fw;
      const cx = (box.minX + box.maxX) / 2 / fw;
      const d = Math.round(frame.distanceCm || 0);

      if (d > 0 && d < 38) { text = `太近了（约 ${d} cm），后退一些`; cls = 'warn'; }
      else if (d > 88) { text = `有点远（约 ${d} cm），靠近一些`; cls = 'warn'; }
      else if (ratio < 0.15) { text = '离得有点远，靠近一些'; cls = 'warn'; }
      else if (cx < 0.33) { text = '脸偏左，向右一点'; cls = 'warn'; }
      else if (cx > 0.67) { text = '脸偏右，向左一点'; cls = 'warn'; }
      else if (frame.lightLuma > 205) { text = '背景过亮，可能逆光'; cls = 'warn'; }
      else if (frame.lightLuma > 0 && frame.lightLuma < 42) { text = '光线偏暗'; cls = 'warn'; }
      else if (d > 0) { text = `人脸正常 · 约 ${d} cm`; }
    }
    pill.className = `pill tiny cal-face ${cls}`;
    pill.innerHTML = `<i class="dot"></i>${text}`;
  }

  async start(points = 9) {
    this.active = true;
    this.cancelled = false;
    this.points = points;
    this.degree = points >= 16 ? 2 : 1;
    this.applyLabels(points);
    const { overlay, target, hint, progressBar, result, intro, countdown, resultMetrics, preview } = this.els;
    overlay.classList.add('open');
    result.classList.remove('show');
    target.classList.remove('show');
    if (resultMetrics) resultMetrics.innerHTML = '';
    if (preview) {
      preview.classList.remove('hidden');
      preview.classList.remove('dim');
    }
    if (this.els.facePill) {
      this.els.facePill.className = 'pill tiny cal-face';
      this.els.facePill.innerHTML = '<i class="dot"></i>人脸检测中';
    }
    progressBar.style.width = '0%';
    hint.textContent = '校准开始后，请盯住出现的圆点，保持头部与坐姿不动';

    if (intro) intro.classList.add('show');
    await sleep(500);
    for (let n = 3; n > 0; n--) {
      if (this.cancelled) return;
      if (countdown) countdown.textContent = String(n);
      hint.textContent = '把脸放在摄像头画面中央，保持不动';
      await sleep(1000);
    }
    if (intro) intro.classList.remove('show');

    const cols = points >= 16 ? 4 : 3;
    const rows = points >= 16 ? 4 : 3;
    const insetX = 0.075;
    const insetY = 0.1;
    const coords = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        coords.push({
          x: insetX + ((1 - 2 * insetX) * c) / (cols - 1),
          y: insetY + ((1 - 2 * insetY) * r) / (rows - 1),
        });
      }
    }
    // 固定「左上 → 右下」的顺序会让眼球形成扫描惯性：每个点都从上一个点的
    // 方向进入，回归模型会把这个习惯当成眼位偏差。打乱顺序但保留空间覆盖。
    for (let i = coords.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = coords[i]; coords[i] = coords[j]; coords[j] = t;
    }

    const samples = [];
    for (let i = 0; i < coords.length; i++) {
      if (this.cancelled) return;
      const pt = coords[i];
      this.showTarget(pt);
      hint.textContent = `第 ${i + 1} / ${coords.length} 点 · 盯住圆点，正常眨眼即可`;
      progressBar.style.width = `${(i / coords.length) * 100}%`;

      await sleep(520);
      const bucket = [];
      let vec = await this.collect(1400, bucket);
      for (let attempt = 0; !vec && attempt < 2; attempt++) {
        if (this.cancelled) return;
        hint.textContent = attempt === 0
          ? '这一下没抓到，保持不动，再来一次…'
          : '还差一点：脸对准摄像头、靠近一些，再试最后一次…';
        await sleep(400);
        // 复用同一个 bucket：几次尝试里的零散有效帧可以累积起来
        vec = await this.collect(1500, bucket);
      }
      if (vec) samples.push({ vec, target: [pt.x, pt.y] });
      this.onProgress(i + 1, coords.length);
    }

    target.classList.remove('show');
    progressBar.style.width = '100%';

    if (samples.length < Math.min(6, coords.length)) {
      this.showResult(
        '校准没完成',
        `一共 ${coords.length} 个点，只采集到 <b>${samples.length}</b> 个有效样本，不足以建立稳定的视线模型。<br><br>
         常见原因：脸离摄像头太远、背后有亮窗（逆光）、校准时频繁低头或转头。<br>
         建议把屏幕稍微转向光源，离屏幕 50–65 cm，让脸占画面 1/3 左右，再试一次。`,
        null,
      );
      return;
    }

    const X = samples.map((s) => s.vec);
    const Y = samples.map((s) => s.target);
    const model = fitRidge(X, Y, this.degree >= 2 ? 1.2 : 0.9);
    model.degree = this.degree;
    model.featureVersion = FEATURE_VERSION;
    model.createdAt = Date.now();
    model.points = samples.length;
    model.plannedPoints = points;
    model.screen = { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 };
    model.smooth = this.tracker.smooth;

    // 用留出的验证点估计真实误差，并拟合仿射校正（偏移 + 增益）
    const val = await this.validate(model);
    model.calX = val.calX;
    model.calY = val.calY;
    const avgErr = val.errsAfter.length ? mean(val.errsAfter) : 0;
    const before = val.errsBefore.length ? mean(val.errsBefore) : 0;
    model.rmse = Math.round(avgErr);
    model.rmseBefore = Math.round(before);
    model.biasPx = Math.round(Math.hypot((val.calX.b || 0) * window.innerWidth, (val.calY.b || 0) * window.innerHeight));
    model.gainX = +val.calX.a.toFixed(2);
    model.gainY = +val.calY.a.toFixed(2);
    model.validation = val.errsAfter.map((e) => Math.round(e));
    model.accuracyDeg = +pxToDegrees(avgErr, window.innerWidth, 34).toFixed(2);

    const fixText = model.biasPx >= 8
      ? `已自动校正 <b>${model.biasPx} px</b> 的整体偏差。`
      : '';
    this.showResult(
      '校准完成',
      `视线模型已保存。${fixText}如果光标仍然偏上或偏下，可以到「设置 → 视线微调」盯着屏幕中心十字 2 秒自动对齐。`,
      model,
    );
  }

  /**
   * 用 5 个留出点拟合每屏轴的仿射校正：target ≈ a · pred + b。
   * 只有 b 时能纠“整体偏”；加上 a 之后还能纠“上准下偏”这类增益误差。
   */
  async validate(model) {
    // 7 个留出点比原来的 5 个多 40% 的斜率对，Theil–Sen 能多容忍一个坏点
    const candidates = [
      { x: 0.26, y: 0.28 }, { x: 0.74, y: 0.32 },
      { x: 0.32, y: 0.7 }, { x: 0.7, y: 0.74 }, { x: 0.5, y: 0.5 },
      { x: 0.5, y: 0.26 }, { x: 0.5, y: 0.74 },
    ];
    const w = window.innerWidth;
    const h = window.innerHeight;
    const pairs = [];
    for (const pt of candidates) {
      if (this.cancelled) break;
      this.showTarget(pt);
      this.els.hint.textContent = '最后验证：继续盯住圆点';
      await sleep(420);
      // 验证窗口短，门槛放宽到 4 帧；头动帧仍会被鲁棒聚合剔掉
      const vec = await this.collect(700, [], 4);
      if (!vec) continue;
      const p = predictRidge(model, vec);
      pairs.push({ px: p[0], py: p[1], tx: pt.x, ty: pt.y });
    }
    this.els.target.classList.remove('show');

    const calX = fitAffine1D(pairs.map((p) => p.px), pairs.map((p) => p.tx));
    const calY = fitAffine1D(pairs.map((p) => p.py), pairs.map((p) => p.ty));
    const errsBefore = pairs.map((p) => Math.hypot((p.tx - p.px) * w, (p.ty - p.py) * h));
    const errsAfter = pairs.map((p) => Math.hypot(
      (p.tx - (calX.a * p.px + calX.b)) * w,
      (p.ty - (calY.a * p.py + calY.b)) * h,
    ));
    return { calX, calY, errsBefore, errsAfter };
  }

  showTarget(pt) {
    const t = this.els.target;
    t.style.left = `${pt.x * 100}%`;
    t.style.top = `${pt.y * 100}%`;
    t.classList.add('show');

    // 摄像头预览恰好盖住某个校准点时，自动淡出，避免挡住目标
    const preview = this.els.preview;
    if (preview) {
      const r = preview.getBoundingClientRect();
      const x = pt.x * window.innerWidth;
      const y = pt.y * window.innerHeight;
      const near = x > r.left - 30 && x < r.right + 30 && y > r.top - 30 && y < r.bottom + 30;
      preview.classList.toggle('dim', near);
    }
  }

  /**
   * 采集窗口结束后做鲁棒聚合：头动帧 + 特征离群帧都不参与建模。
   * 16 点二阶模型自由度更高，要求更多稳定帧；验证点窗口短，门槛可放宽。
   */
  collect(ms, bucket = [], minFrames = null) {
    return new Promise((resolve) => {
      this.collector = { vecs: bucket };
      setTimeout(() => {
        this.collector = null;
        const need = minFrames == null ? (this.points >= 16 ? 8 : 6) : minFrames;
        resolve(robustAggregate(bucket, { min: need }));
      }, ms);
    });
  }

  showResult(title, text, model) {
    const { result, resultTitle, resultText, hint, resultMetrics } = this.els;
    hint.textContent = '';
    resultTitle.textContent = title;
    resultText.innerHTML = text;
    // 成功时收起预览；失败时保留，方便用户对照调整坐姿
    if (this.els.preview) this.els.preview.classList.toggle('hidden', !!model);
    if (resultMetrics) {
      resultMetrics.innerHTML = model ? `
        <div><b>${model.rmse ?? '--'}</b><span>平均误差 PX</span></div>
        <div><b>${model.accuracyDeg ?? '--'}°</b><span>视角误差</span></div>
        <div><b>${model.points || 9}</b><span>校准点</span></div>
        <div><b>${model.gainX && model.gainY ? `${model.gainX} / ${model.gainY}` : '--'}</b><span>横 / 纵增益</span></div>` : '';
    }
    result.classList.add('show');
    this.active = false;
    if (model) {
      this.pendingModel = model;
      this.tracker.setModel(model);
      this.els.btnFinish && (this.els.btnFinish.style.display = '');
      this.els.btnRetry && (this.els.btnRetry.style.display = model && model.rmse && model.rmse > 260 ? '' : 'none');
    } else {
      this.pendingModel = null;
      this.els.btnFinish && (this.els.btnFinish.style.display = 'none');
      this.els.btnRetry && (this.els.btnRetry.style.display = '');
    }
  }

  confirm() {
    const model = this.pendingModel;
    this.close();
    if (model) this.onDone(model);
  }

  retry() {
    this.cancel(true);
    setTimeout(() => this.start(this.points), 120);
  }

  cancel(silent = false) {
    this.cancelled = true;
    this.active = false;
    this.collector = null;
    this.els.overlay.classList.remove('open');
    this.els.result.classList.remove('show');
    this.els.target.classList.remove('show');
    if (this.els.intro) this.els.intro.classList.remove('show');
    if (this.els.preview) this.els.preview.classList.remove('dim');
    if (!silent) this.onCancel();
  }

  close() {
    this.active = false;
    this.els.overlay.classList.remove('open');
    this.els.result.classList.remove('show');
    if (this.els.intro) this.els.intro.classList.remove('show');
    if (this.els.preview) this.els.preview.classList.remove('dim');
  }
}
