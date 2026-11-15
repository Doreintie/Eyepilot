/* ============================================================
   vision.js — MediaPipe Face Landmarker 封装 + 眼部几何特征
   ============================================================ */

import { FilesetResolver, FaceLandmarker } from '../vendor/mediapipe/vision_bundle.mjs';
import { clamp } from './core/math.js';
import { estimateDistanceCm, lumaToLux } from './core/health.js';

const MODEL_PATH = './vendor/mediapipe/face_landmarker.task';
const WASM_PATH = './vendor/mediapipe/wasm';

/* MediaPipe 478 点面部网格关键索引 */
export const MESH = {
  faceOval: [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109],
  // 顺序必须是「外眼角 → 下睑 → 内眼角 → 上睑 → 外眼角」的闭环，
  // 否则描出来的多边形会自交，看上去是几个小菱形而不是眼睛。
  eyeLeft: [33, 7, 163, 144, 145, 153, 154, 155, 133, 246, 161, 160, 159, 158, 157, 173],
  eyeRight: [263, 249, 390, 373, 374, 380, 381, 382, 362, 466, 388, 387, 386, 385, 384, 398],
  irisA: [468, 469, 470, 471, 472],
  irisB: [473, 474, 475, 476, 477],
  // 内外眼角：用来建立不随眼睑开合变化的坐标系
  canthusL: { outer: 33, inner: 133 },
  canthusR: { outer: 263, inner: 362 },
  noseTip: 1,
  chin: 152,
};

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const avgPoint = (pts) => pts.reduce((acc, p) => ({ x: acc.x + p.x / pts.length, y: acc.y + p.y / pts.length }), { x: 0, y: 0 });

function eyeBox(pts) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, maxX, minY, maxY, w: maxX - minX, h: maxY - minY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
}

/**
 * 从一帧检测结果计算眼动几何特征。
 * 特征采用「鼻侧→颞侧」「上→下」的虹膜相对位置，天然消除左右眼镜像差异。
 */
export function analyzeFace(result, width, height) {
  const lm = result.faceLandmarks[0];
  const P = (i) => ({ x: lm[i].x * width, y: lm[i].y * height });

  const contourL = MESH.eyeLeft.map(P);
  const contourR = MESH.eyeRight.map(P);
  const boxL = eyeBox(contourL);
  const boxR = eyeBox(contourR);

  const irisRawA = MESH.irisA.map((i) => ({ x: lm[i].x * width, y: lm[i].y * height }));
  const irisRawB = MESH.irisB.map((i) => ({ x: lm[i].x * width, y: lm[i].y * height }));
  const irisA = avgPoint(irisRawA);
  const irisB = avgPoint(irisRawB);

  // 用最近距离把虹膜与眼框配对，避免左右眼索引语义歧义
  const dAA = dist(irisA, { x: boxL.cx, y: boxL.cy });
  const dAB = dist(irisA, { x: boxR.cx, y: boxR.cy });
  const irisNearL = dAA <= dAB;
  const irisOfL = irisNearL ? irisA : irisB;
  const irisOfR = irisNearL ? irisB : irisA;

  // 用「内外眼角连线中点」建坐标系：眼角位置不随眼睑开合变化，
  // 虹膜相对它的位移不会像「眼框内比例」那样被眨眼和眼睑带动着跳。
  const canL = { o: P(MESH.canthusL.outer), i: P(MESH.canthusL.inner) };
  const canR = { o: P(MESH.canthusR.outer), i: P(MESH.canthusR.inner) };
  const midL = { x: (canL.o.x + canL.i.x) / 2, y: (canL.o.y + canL.i.y) / 2 };
  const midR = { x: (canR.o.x + canR.i.x) / 2, y: (canR.o.y + canR.i.y) / 2 };
  const wL = Math.max(1, dist(canL.o, canL.i));
  const wR = Math.max(1, dist(canR.o, canR.i));
  // 两眼共用同一尺度：头转动时“近眼变大”不会被误当成视线位移
  const eyeScale = Math.max(1, (wL + wR) / 2);

  const hxL = clamp((irisOfL.x - midL.x) / eyeScale, -0.55, 0.55);
  const hyL = clamp((irisOfL.y - midL.y) / eyeScale, -0.55, 0.55);
  const hxR = clamp((irisOfR.x - midR.x) / eyeScale, -0.55, 0.55);
  const hyR = clamp((irisOfR.y - midR.y) / eyeScale, -0.55, 0.55);

  const blendshapes = {};
  const cats = result.faceBlendshapes && result.faceBlendshapes[0] ? result.faceBlendshapes[0].categories : [];
  for (const c of cats) blendshapes[c.categoryName] = c.score;

  let blinkL = blendshapes.eyeBlinkLeft;
  let blinkR = blendshapes.eyeBlinkRight;
  if (blinkL === undefined || blinkR === undefined) {
    const openL = clamp((boxL.h / boxL.w - 0.12) / 0.26, 0, 1);
    const openR = clamp((boxR.h / boxR.w - 0.12) / 0.26, 0, 1);
    blinkL = 1 - openL;
    blinkR = 1 - openR;
  }

  const eyeMid = {
    x: (boxL.cx + boxR.cx) / 2,
    y: (boxL.cy + boxR.cy) / 2,
  };
  const nose = P(MESH.noseTip);
  const chin = P(MESH.chin);
  const ipdPx = dist(irisA, irisB);
  const eyeSpan = ipdPx || dist(contourL[0], contourR[0]) || 1;

  const yawN = (nose.x - eyeMid.x) / eyeSpan;
  const pitchN = (nose.y - eyeMid.y) / eyeSpan - 0.72;
  const chinN = (chin.y - eyeMid.y) / eyeSpan;
  const roll = (Math.atan2(boxR.cy - boxL.cy, boxR.cx - boxL.cx) * 180) / Math.PI;

  const all = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  for (const p of lm) {
    if (p.x * width < all.minX) all.minX = p.x * width;
    if (p.x * width > all.maxX) all.maxX = p.x * width;
    if (p.y * height < all.minY) all.minY = p.y * height;
    if (p.y * height > all.maxY) all.maxY = p.y * height;
  }

  const distanceCm = estimateDistanceCm(ipdPx, width);

  return {
    present: true,
    frameWidth: width,
    frameHeight: height,
    hxL,
    hyL,
    hxR,
    hyR,
    eyeScale,
    yaw: yawN,
    pitch: pitchN + (chinN - 2.5) * 0.06,
    yawDeg: Math.round(yawN * 46),
    pitchDeg: Math.round(pitchN * 55),
    rollDeg: Math.round(roll),
    blinkL,
    blinkR,
    open: clamp(1 - Math.max(blinkL, blinkR), 0, 1),
    ipdPx,
    distanceCm,
    eyeMid,
    irisL: irisOfL,
    irisR: irisOfR,
    boxL,
    boxR,
    faceBox: all,
    contourL,
    contourR,
    landmarks: lm,
    raw: result,
  };
}

export class VisionEngine {
  constructor({ video, overlay, onFrame, onStatus }) {
    this.video = video;
    this.overlay = overlay;
    this.onFrame = onFrame;
    this.onStatus = onStatus || (() => {});
    this.landmarker = null;
    this.stream = null;
    this.running = false;
    this.lastVideoTime = -1;
    this.lastTs = 0;
    this.fps = 0;
    this.lightLuma = 0;
    this.lightLux = 0;
    this.lastLightTs = 0;
    this.raf = 0;
    this.frames = 0;
    this.showMesh = true;
    this.lightCanvas = document.getElementById('lightCanvas');
    this.lightCtx = this.lightCanvas ? this.lightCanvas.getContext('2d', { willReadFrequently: true }) : null;
  }

  async ensureModel() {
    if (this.landmarker) return this.landmarker;
    this.onStatus({ stage: 'model', state: 'loading' });
    const fileset = await FilesetResolver.forVisionTasks(WASM_PATH);
    const options = {
      baseOptions: { modelAssetPath: MODEL_PATH, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: true,
      minFaceDetectionConfidence: 0.4,
      minFacePresenceConfidence: 0.4,
      minTrackingConfidence: 0.5,
    };
    try {
      this.landmarker = await FaceLandmarker.createFromOptions(fileset, options);
    } catch (err) {
      console.warn('[EyePilot] GPU 初始化失败，回退 CPU：', err);
      this.landmarker = await FaceLandmarker.createFromOptions(fileset, {
        ...options,
        baseOptions: { ...options.baseOptions, delegate: 'CPU' },
      });
    }
    this.onStatus({ stage: 'model', state: 'ready' });
    return this.landmarker;
  }

  async listCameras() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
    const list = await navigator.mediaDevices.enumerateDevices();
    return list.filter((d) => d.kind === 'videoinput');
  }

  async start(deviceId = '') {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('当前浏览器不支持摄像头访问，请使用最新版 Chrome / Edge。');
    }
    this.onStatus({ stage: 'model', state: 'loading' });
    await this.ensureModel();

    this.onStatus({ stage: 'camera', state: 'loading' });
    const constraints = {
      audio: false,
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30, max: 30 },
        facingMode: 'user',
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      },
    };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = stream;
    this.video.srcObject = stream;
    this.video.classList.add('ready');
    await new Promise((resolve) => {
      if (this.video.readyState >= 1) resolve();
      else this.video.addEventListener('loadedmetadata', resolve, { once: true });
    });
    await this.video.play();
    this.syncCanvasSize();
    this.running = true;
    this.lastVideoTime = -1;
    this.onStatus({ stage: 'camera', state: 'ready' });
    this.onStatus({ stage: 'run', state: 'running' });
    this.loop();
    return stream;
  }

  syncCanvasSize() {
    if (!this.overlay) return;
    const w = this.video.videoWidth || 960;
    const h = this.video.videoHeight || 720;
    if (w < 64 || h < 64) return;
    if (this.overlay.width !== w || this.overlay.height !== h) {
      this.overlay.width = w;
      this.overlay.height = h;
    }
  }

  loop() {
    if (!this.running) return;
    // 后台（最小化 / 切到别的窗口）时 requestAnimationFrame 会被浏览器暂停，
    // 这里退化成定时器继续跑；Chromium 仍会降频，但远好过完全停止。
    if (typeof document !== 'undefined' && document.hidden) {
      this.raf = setTimeout(() => this.loop(), 120);
    } else {
      this.raf = requestAnimationFrame(() => this.loop());
    }
    const v = this.video;
    if (!v || v.readyState < 2) return;
    if (v.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = v.currentTime;

    const ts = performance.now();
    let result = null;
    try {
      result = this.landmarker.detectForVideo(v, ts);
    } catch (err) {
      console.warn('[EyePilot] detect 失败', err);
      return;
    }

    const dt = ts - (this.lastTs || ts);
    this.lastTs = ts;
    if (dt > 0 && dt < 1000) this.fps = this.fps ? this.fps * 0.9 + (1000 / dt) * 0.1 : 1000 / dt;

    let frame = { t: ts, present: false };
    if (result && result.faceLandmarks && result.faceLandmarks.length) {
      frame = { ...analyzeFace(result, v.videoWidth || 960, v.videoHeight || 720), t: ts };
    }

    if (ts - this.lastLightTs > 260) {
      this.lastLightTs = ts;
      this.readLight();
    }
    frame.lightLuma = this.lightLuma;
    frame.lightLux = this.lightLux;
    frame.fps = this.fps;

    this.renderOverlay(frame);
    this.onFrame(frame);
  }

  readLight() {
    if (!this.lightCtx || !this.video || this.video.readyState < 2) return;
    const w = this.lightCanvas.width, h = this.lightCanvas.height;
    try {
      this.lightCtx.drawImage(this.video, 0, 0, w, h);
      const data = this.lightCtx.getImageData(0, 0, w, h).data;
      let sum = 0;
      for (let i = 0; i < data.length; i += 4) {
        sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      }
      this.lightLuma = sum / (data.length / 4);
      this.lightLux = lumaToLux(this.lightLuma);
    } catch { /* 忽略跨域/画布异常 */ }
  }

  renderOverlay(frame) {
    if (!this.overlay) return;
    const ctx = this.overlay.getContext('2d');
    if (!ctx) return;

    const vw = this.video.videoWidth || 960;
    const vh = this.video.videoHeight || 720;
    const rect = this.overlay.getBoundingClientRect();
    const bw = Math.max(1, Math.round(rect.width || this.overlay.clientWidth || vw));
    const bh = Math.max(1, Math.round(rect.height || this.overlay.clientHeight || vh));
    if (bw < 32 || bh < 32) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const needW = Math.round(bw * dpr);
    const needH = Math.round(bh * dpr);
    if (this.overlay.width !== needW || this.overlay.height !== needH) {
      this.overlay.width = needW;
      this.overlay.height = needH;
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    if (!frame || !frame.present || !this.showMesh) return;

    // 关键：视频用 object-fit: cover 显示，画布必须用同一套「等比铺满 + 居中裁切」变换，
    // 否则关键点会被横向拉伸（之前“标注的眼睛和真实位置不重合”就是这个原因）。
    const scale = Math.max(bw / vw, bh / vh);
    const ox = (bw - vw * scale) / 2;
    const oy = (bh - vh * scale) / 2;
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * ox, dpr * oy);

    // 下面全部直接用「视频像素」作图；线宽换算回约 1.2 CSS px
    const px = 1 / scale;

    // 面部轮廓
    ctx.beginPath();
    MESH.faceOval.forEach((i, idx) => {
      const p = frame.landmarks[i];
      const x = p.x * vw, y = p.y * vh;
      if (idx === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.strokeStyle = 'rgba(46, 230, 214, .28)';
    ctx.lineWidth = 1.2 * px;
    ctx.stroke();

    // 眼框
    for (const contour of [frame.contourL, frame.contourR]) {
      ctx.beginPath();
      contour.forEach((p, idx) => (idx === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.closePath();
      ctx.strokeStyle = 'rgba(46, 230, 214, .85)';
      ctx.lineWidth = 1.4 * px;
      ctx.stroke();
    }

    // 虹膜
    const irisPairs = [
      [frame.irisL, frame.boxL],
      [frame.irisR, frame.boxR],
    ];
    for (const [iris, box] of irisPairs) {
      if (!iris) continue;
      const r = Math.max(4, (box && box.w ? box.w : 40) * 0.17);
      ctx.beginPath();
      ctx.arc(iris.x, iris.y, r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(124, 156, 255, .35)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(180, 205, 255, .95)';
      ctx.lineWidth = 1.2 * px;
      ctx.stroke();
    }

    // 面部中线
    const nose = frame.landmarks[MESH.noseTip];
    ctx.beginPath();
    ctx.moveTo(frame.eyeMid.x, frame.eyeMid.y);
    ctx.lineTo(nose.x * vw, nose.y * vh);
    ctx.strokeStyle = 'rgba(124, 156, 255, .35)';
    ctx.lineWidth = 1 * px;
    ctx.setLineDash([4 * px, 4 * px]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.raf);
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (this.video) {
      this.video.srcObject = null;
      this.video.classList.remove('ready');
    }
    const ctx = this.overlay ? this.overlay.getContext('2d') : null;
    if (ctx) ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    this.onStatus({ stage: 'camera', state: 'stopped' });
  }
}
