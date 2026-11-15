/* ============================================================
   gaze.js — 视线映射（岭回归）、平滑、九点校准
   ============================================================ */

import {
  OneEuroFilter, buildFeatureVector, fitRidge, predictRidge,
  medianVector, clamp, mean, lerp, FEATURE_VERSION, fitAffine1D,
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
    // 使用中自校准：每次“注视点击”都提供了一个我们知道大致落点的样本，
    // 用它缓慢修正整体偏移，抵消头位变化带来的漂移。
    this.auto = { x: 0, y: 0, n: 0 };
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
  observeAnchor(tx, ty) {
    const g = this.gaze;
    if (!g || !g.valid || !Number.isFinite(tx) || !Number.isFinite(ty)) return false;
    const dx = tx - g.x;
    const dy = ty - g.y;
    if (Math.hypot(dx, dy) > 260) return false;
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
    const dt = this.prevT ? (now - this.prevT) / 1000 : 1 / 30;
    this.prevT = now;

    // 超过 400ms 没有有效点，重置滤波器，避免恢复时拖尾
    if (this.lastGood && now - this.goodAt > 400) {
      this.fx.reset();
      this.fy.reset();
    }

    const px = clamp(mx, 0, 1) * vw + this.offset.x + this.auto.x;
    const py = clamp(my, 0, 1) * vh + this.offset.y + this.auto.y;
    let fx = clamp(this.fx.filter(clamp(px, 0, vw), dt), 0, vw);
    let fy = clamp(this.fy.filter(clamp(py, 0, vh), dt), 0, vh);

    // 置信度：眼睛张得越小 / 特征越偏离校准分布，越低
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

    const valid = conf > 0.28 && !outside;

    // 死区：静止注视时人眼本身就有微颤，2px 以内的位移直接不输出，
    // 这样“抽搐”在视觉上消失，而真实移动超过 2px 依然即时响应。
    if (valid) {
      const dz = conf > 0.6 ? 2.2 : 4.2;
      if (!this.shown) this.shown = { x: fx, y: fy };
      const ddx = fx - this.shown.x;
      const ddy = fy - this.shown.y;
      if (ddx * ddx + ddy * ddy < dz * dz) {
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
    this.collector.vecs.push(buildFeatureVector(frame, this.degree));
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
    const candidates = [
      { x: 0.26, y: 0.28 }, { x: 0.74, y: 0.32 },
      { x: 0.32, y: 0.7 }, { x: 0.7, y: 0.74 }, { x: 0.5, y: 0.5 },
    ];
    const w = window.innerWidth;
    const h = window.innerHeight;
    const pairs = [];
    for (const pt of candidates) {
      if (this.cancelled) break;
      this.showTarget(pt);
      this.els.hint.textContent = '最后验证：继续盯住圆点';
      await sleep(420);
      const vec = await this.collect(700);
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

  collect(ms, bucket = []) {
    return new Promise((resolve) => {
      this.collector = { vecs: bucket };
      setTimeout(() => {
        this.collector = null;
        resolve(bucket.length >= 4 ? medianVector(bucket) : null);
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
