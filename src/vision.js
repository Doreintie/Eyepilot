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
  eyeLeft: [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246],
  eyeRight: [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466],
  irisA: [468, 469, 470, 471, 472],
  irisB: [473, 474, 475, 476, 477],
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

  const hRatioL = boxL.w > 1 ? clamp((boxL.maxX - irisOfL.x) / boxL.w, -0.4, 1.4) : 0.5;
  const vRatioL = boxL.h > 1 ? clamp((irisOfL.y - boxL.minY) / boxL.h, -0.4, 1.4) : 0.5;
  const hRatioR = boxR.w > 1 ? clamp((irisOfR.x - boxR.minX) / boxR.w, -0.4, 1.4) : 0.5;
  const vRatioR = boxR.h > 1 ? clamp((irisOfR.y - boxR.minY) / boxR.h, -0.4, 1.4) : 0.5;

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
    lx: hRatioL,
    ly: vRatioL,
    rx: hRatioR,
    ry: vRatioR,
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
    this.raf = requestAnimationFrame(() => this.loop());
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
    const ctx = this.overlay ? this.overlay.getContext('2d') : null;
    if (!ctx) return;
    const w = this.overlay.width, h = this.overlay.height;
    if (w < 64 || h < 64) return;
    ctx.clearRect(0, 0, w, h);
    if (!frame || !frame.present || !this.showMesh) return;

    const s = Math.max(w, h) / 720;

    // 面部轮廓
    ctx.beginPath();
    MESH.faceOval.forEach((i, idx) => {
      const p = frame.landmarks[i];
      const x = p.x * w, y = p.y * h;
      if (idx === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.strokeStyle = 'rgba(46, 230, 214, .28)';
    ctx.lineWidth = 1.2 * s;
    ctx.stroke();

    // 眼框
    for (const contour of [frame.contourL, frame.contourR]) {
      ctx.beginPath();
      contour.forEach((p, idx) => (idx === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.closePath();
      ctx.strokeStyle = 'rgba(46, 230, 214, .85)';
      ctx.lineWidth = 1.4 * s;
      ctx.stroke();
    }

    // 虹膜
    for (const iris of [frame.irisL, frame.irisR]) {
      if (!iris) continue;
      const r = Math.max(3.4, (frame.boxL.w || 40) * 0.16) * s;
      ctx.beginPath();
      ctx.arc(iris.x, iris.y, r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(124, 156, 255, .35)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(180, 205, 255, .95)';
      ctx.lineWidth = 1.2 * s;
      ctx.stroke();
    }

    // 面部中线
    const nose = frame.landmarks[MESH.noseTip];
    ctx.beginPath();
    ctx.moveTo(frame.eyeMid.x, frame.eyeMid.y);
    ctx.lineTo(nose.x * w, nose.y * h);
    ctx.strokeStyle = 'rgba(124, 156, 255, .35)';
    ctx.lineWidth = 1 * s;
    ctx.setLineDash([4 * s, 4 * s]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
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
