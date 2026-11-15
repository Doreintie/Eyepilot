/* ============================================================
   main.js — 启动、帧调度、模块编排
   ============================================================ */

import { initStore, app, persistModel, resetAllData, learnBaseline, saveSettings } from './store.js';
import {
  ui, setStatus, setOnboard, renderLive, renderMetrics, renderCharts, renderAlerts,
  notifyAlert, renderAssessment, appendChat, setDemoActive, setPrimaryButton,
  setCameraOptions, openBreak, closeBreak, updateBreakRing, showReport, calibrationEls,
} from './ui.js';
import { VisionEngine } from './vision.js';
import { GazeTracker, Calibrator } from './gaze.js';
import { createGazeInput } from './input.js';
import { HealthMonitor } from './health-monitor.js';
import { AICoach, buildReport, assessLocal } from './ai.js';
import { pluginHost, renderPluginGrid, closePanel, openPlugin } from './plugins.js';
import { download } from './utils.js';
import { fitAffine1D } from './core/math.js';
import { DemoEngine, seedDemoData } from './demo.js';

import './plugins/reader.js';
import './plugins/game.js';
import './plugins/focus.js';

initStore();

const video = document.getElementById('cam');
const overlay = document.getElementById('camOverlay');

let vision = null;
let tracker = null;
let input = null;
let health = null;
let coach = null;
let calibrator = null;
let demo = null;
let lastBaselineAt = 0;

/* ---------------- 帧处理 ---------------- */

function afterFrame(frame, gaze) {
  app.frame = frame;
  app.gaze = gaze;
  // 校准器需要每一帧原始几何特征；之前漏了这一行，导致“样本太少”
  if (calibrator && calibrator.active) calibrator.pushFrame(frame);
  input.update(gaze, frame);
  health.ingest(frame, gaze);
  pluginHost.frame(frame, gaze);
  renderLive(frame, gaze, frame.fps);
}

function handleVisionFrame(frame) {
  if (app.mode === 'demo') return;
  const gaze = tracker.update(frame);
  afterFrame(frame, gaze);
}

function handleDemoFrame(frame, gaze) {
  afterFrame(frame, gaze);
}

/* ---------------- 状态 ---------------- */

function onVisionStatus(s) {
  if (s.stage === 'model') {
    if (s.state === 'loading') {
      setStatus('model', 'warn', '模型加载中');
      setOnboard('loading');
      setPrimaryButton('加载中…', true);
    } else if (s.state === 'ready') {
      setStatus('model', 'on', '模型就绪');
    }
  }
  if (s.stage === 'camera') {
    if (s.state === 'loading') {
      setStatus('cam', 'warn', '相机启动中');
    } else if (s.state === 'ready') {
      setStatus('cam', 'on', '相机就绪');
    } else if (s.state === 'stopped') {
      setStatus('cam', '', '相机已关闭');
    }
  }
}

function friendlyError(err) {
  if (window.self !== window.top) {
    return '页面正在预览窗口 / iframe 中打开，浏览器会拦截摄像头。请复制下方地址，用 Edge 或 Chrome 新标签页直接打开。';
  }
  if (location.protocol === 'file:' || !window.isSecureContext) {
    return '当前不是通过 localhost 打开的，浏览器禁止网页使用摄像头。请双击「启动.bat」或运行 python serve.py，再用 http://127.0.0.1:8848/ 访问。';
  }
  const name = err && err.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return '浏览器拒绝了摄像头权限，应用没有拿到任何画面。按下面三步在地址栏恢复权限，然后点「重新检测权限」。';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return '没有找到可用的摄像头。请连接摄像头后重试，或先用演示模式体验。';
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return '摄像头被其他程序占用了。关闭腾讯会议 / Zoom / 相机应用后重试。';
  }
  if (name === 'OverconstrainedError') {
    return '当前摄像头不支持请求的分辨率。请在设置里换一个摄像头，或直接重试。';
  }
  return (err && err.message) || '未知错误';
}

/* ---------------- 摄像头 ---------------- */

async function startCamera() {
  if (app.mode === 'demo') stopDemo();
  if (vision.running) { calibrate(); return; }
  setOnboard('loading');
  setPrimaryButton('加载中…', true);
  setStatus('model', 'warn', '模型加载中');
  setStatus('cam', 'warn', '相机启动中');
  try {
    await vision.start(app.settings.cameraId);
    app.mode = 'running';
    app.sessionStart = Date.now();
    setStatus('cam', 'on', '相机就绪');
    setStatus('model', 'on', '模型就绪');
    setPrimaryButton(app.model ? '重新校准' : '校准视线');
    setStatus('cal', app.model ? 'on' : 'warn', app.model ? `已校准 · ${app.model.rmse || '?'}px` : '待校准');
    setOnboard(app.model ? 'ready' : 'camera');
    const devices = await vision.listCameras();
    setCameraOptions(devices);
    input.resume();
    if (app.model) {
      tracker.setModel(app.model);
      if (app.model.smooth != null) {
        app.settings.smooth = app.model.smooth;
        tracker.setSmooth(app.model.smooth);
      }
    }
  } catch (err) {
    console.error(err);
    app.mode = 'idle';
    setStatus('cam', 'bad', '相机不可用');
    setStatus('model', app.model ? 'on' : '', app.model ? '模型就绪' : '模型待加载');
    setPrimaryButton('启动相机');
    setOnboard('error', friendlyError(err));
    notifyAlert({ level: 'bad', title: '摄像头启动失败', detail: friendlyError(err) });
  }
}

function stopCamera() {
  vision.stop();
  app.mode = 'idle';
  app.sessionStart = 0;
  setStatus('cam', '', '相机未启动');
  setPrimaryButton('启动相机');
  setOnboard(app.model ? 'ready' : 'idle');
  input.pause();
}

/* ---------------- 校准 ---------------- */

function calibrate(fine = false) {
  if (app.mode === 'demo') {
    notifyAlert({ level: 'info', title: '演示模式无需校准', detail: '演示模式用鼠标模拟视线。退出演示、启动真实摄像头后即可校准。' });
    return;
  }
  if (!vision.running) {
    notifyAlert({ level: 'warn', title: '先启动摄像头', detail: '校准需要摄像头看到你的眼睛。' });
    startCamera();
    return;
  }
  if (calibrator.active) return;
  setOnboard('ready');
  input.pause();
  const preview = document.getElementById('calPreview');
  if (preview) {
    preview.srcObject = video.srcObject;
    preview.play().catch(() => {});
  }
  calibrator.start(fine ? 16 : 9);
}

function releaseCalPreview() {
  const preview = document.getElementById('calPreview');
  if (preview) preview.srcObject = null;
}

function onCalibrationDone(model) {
  releaseCalPreview();
  persistModel(model);
  // 新校准自带了偏差校正，手动偏移归零
  saveSettings({ offsetX: 0, offsetY: 0 });
  tracker.setOffset(0, 0);
  ui.updateOffsetUI();
  app.settings.smooth = model.smooth != null ? model.smooth : app.settings.smooth;
  tracker.setSmooth(app.settings.smooth);
  input.resume();
  setOnboard('ready');
  setPrimaryButton('重新校准');
  setStatus('cal', 'on', `已校准 · ${model.rmse || '?'}px`);
  notifyAlert({
    level: 'good',
    title: '校准完成',
    detail: `平均误差 ${model.rmse || '?'} px（约 ${model.accuracyDeg || '?'}°）。注视目标 0.8 秒即可点击。`,
  });
  ui.renderAssessment(assessLocal(health.metrics, { series: health.series, alerts: health.alerts }));
}

function onCalibrationCancel() {
  releaseCalPreview();
  input.resume();
  setOnboard(app.model ? 'ready' : vision.running ? 'camera' : 'idle');
}

/* ---------------- 演示 ---------------- */

function startDemo() {
  if (vision.running) vision.stop();
  if (calibrator.active) calibrator.cancel(true);
  app.mode = 'demo';
  setDemoActive(true);
  setStatus('cam', 'warn', '演示模式');
  setStatus('model', '', '跳过');
  setStatus('cal', 'warn', '模拟视线');
  setOnboard('demo');
  setPrimaryButton('退出演示');
  ui.applyMirror();
  const seeded = seedDemoData(health);
  demo.start();
  input.resume();
  app.sessionStart = Date.now() - 14 * 60000;
  renderAlerts(health.alerts);
  renderMetrics(health.metrics);
  if (seeded) renderCharts(health);
  notifyAlert({
    level: 'info',
    title: '演示模式已开启',
    detail: seeded ? '用鼠标移动模拟视线；已生成一段模拟历史，健康看板可直接查看。' : '用鼠标移动即可模拟视线。',
  });
}

function stopDemo() {
  demo.stop();
  app.mode = 'idle';
  app.sessionStart = 0;
  setDemoActive(false);
  setStatus('cam', '', '相机未启动');
  setStatus('model', '', '模型待加载');
  setStatus('cal', app.model ? 'on' : '', app.model ? `已校准 · ${app.model.rmse || '?'}px` : '未校准');
  setOnboard(app.model ? 'ready' : 'idle');
  setPrimaryButton('启动相机');
  ui.applyMirror();
  input.pause();
  const ctx = overlay.getContext('2d');
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  notifyAlert({ level: 'info', title: '已退出演示模式', detail: '可以启动摄像头开始真实的眼动追踪。' });
}

function toggleDemo() {
  if (app.mode === 'demo') stopDemo();
  else startDemo();
}

/* ---------------- 数据回调 ---------------- */

function onMetrics(m) {
  app.metrics = m;
  renderMetrics(m);
  const now = Date.now();
  if (now - lastBaselineAt > 30000) {
    lastBaselineAt = now;
    learnBaseline(m);
  }
  if (!app.assessment) {
    app.assessment = assessLocal(m, { series: health.series, alerts: health.alerts });
    ui.renderAssessment(app.assessment);
  }
}

function onAlert(a) {
  app.alerts = health.alerts;
  renderAlerts(health.alerts);
  notifyAlert(a);
}

function onBreakEvent(ev) {
  if (ev.type === 'start') {
    input.pause();
    openBreak(ev.source === 'auto');
  } else {
    input.resume();
    closeBreak(ev);
    renderAlerts(health.alerts);
  }
}

/* ---------------- 动作 ---------------- */

const actions = {
  startCamera,
  calibrate,
  calibrateFine: () => calibrate(true),
  cancelCalibration: () => calibrator.cancel(),
  finishCalibration: () => calibrator.confirm(),
  retryCalibration: () => calibrator.retry(),
  toggleDemo,
  startBreak: (source) => { if (!health.startBreak(source)) return; },
  endBreak: (skipped) => health.endBreak(skipped),
  openPlugin: (id) => openPlugin(id, {}),
  applySettings: () => {
    tracker.setSmooth(app.settings.smooth);
    tracker.setOffset(app.settings.offsetX || 0, app.settings.offsetY || 0);
    input.setSettings(app.settings);
    if (vision) vision.showMesh = app.settings.mesh;
    ui.els.dwellHint.textContent = (app.settings.dwellMs / 1000).toFixed(1);
    ui.applyBigTargets();
  },
  nudgeOffset: (dx, dy) => {
    const s = app.settings;
    const nx = Math.max(-240, Math.min(240, (s.offsetX || 0) + dx));
    const ny = Math.max(-240, Math.min(240, (s.offsetY || 0) + dy));
    saveSettings({ offsetX: nx, offsetY: ny });
    tracker.setOffset(nx, ny);
    ui.updateOffsetUI();
  },
  centerOffset: () => ui.startAlign(),
  /**
   * 纵向三点微调：pairs 是 [{predY, targetY}]，用仿射拟合同时修偏移与增益。
   * 直接改 model.calY 并落盘，不动用户手动的 offset，两者互不干扰。
   */
  applyVerticalRefine: (pairs) => {
    const m = app.model;
    if (!m || !pairs || pairs.length < 2) return;
    const fit = fitAffine1D(pairs.map((p) => p.predY), pairs.map((p) => p.targetY));
    m.calY = { a: fit.a, b: fit.b };
    persistModel(m);
    tracker.model = m;
    tracker.reset();
    const px = Math.round(fit.b * window.innerHeight);
    notifyAlert({
      level: 'good',
      title: '纵向已对齐',
      detail: `增益 ${fit.a.toFixed(2)}、偏移 ${px > 0 ? '+' : ''}${px} px。现在看屏幕上下沿，光标应该都在视线附近。`,
    });
  },
  resetOffset: () => {
    saveSettings({ offsetX: 0, offsetY: 0 });
    tracker.setOffset(0, 0);
    ui.updateOffsetUI();
    notifyAlert({ level: 'info', title: '偏移已重置', detail: '回到这次校准的默认位置。' });
  },
  onThemeChange: () => { renderCharts(health); },
  renderCharts: () => renderCharts(health),
  testLLM: () => coach.test(),
  onLLMChange: () => { coach.llmFailed = false; coach.lastLlmAt = 0; },
  chat: async (text) => {
    appendChat('me', text);
    const thinking = appendChat('thinking', '正在结合你的实时指标思考…');
    try {
      const res = await coach.chat(text);
      if (thinking) thinking.remove();
      appendChat('ai', res.text);
    } catch (err) {
      if (thinking) thinking.remove();
      appendChat('ai', `出了点问题：${err.message || err}`);
    }
  },
  exportData: (kind) => {
    const snap = health.snapshot();
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    if (kind === 'json') {
      download(`EyePilot-${stamp}.json`, JSON.stringify(snap, null, 2), 'application/json');
    } else {
      download(`EyePilot-${stamp}.csv`, health.csv(), 'text/csv;charset=utf-8');
    }
  },
  report: () => {
    const assessment = app.assessment || assessLocal(app.metrics || {}, { series: health.series, alerts: health.alerts });
    showReport(buildReport(health.snapshot(), assessment));
  },
  clearAlerts: () => {
    health.alerts = [];
    app.alerts = [];
    renderAlerts([]);
  },
  wipeData: () => {
    resetAllData();
    try { localStorage.clear(); } catch { /* noop */ }
    window.location.reload();
  },
};

/* ---------------- 启动 ---------------- */

function boot() {
  tracker = new GazeTracker({});
  tracker.setSmooth(app.settings.smooth);
  tracker.setOffset(app.settings.offsetX || 0, app.settings.offsetY || 0);
  input = createGazeInput(app.settings, () => {});
  health = new HealthMonitor({ onMetrics, onAlert, onBreak: onBreakEvent });
  coach = new AICoach({ onAssessment: (a) => renderAssessment(a) });
  vision = new VisionEngine({ video, overlay, onFrame: handleVisionFrame, onStatus: onVisionStatus });
  vision.showMesh = app.settings.mesh;
  demo = new DemoEngine({ overlay, onFrame: handleDemoFrame });

  ui.init(actions);

  // 必须在 ui.init 之后创建：校准器需要读取已缓存的 DOM 元素
  calibrator = new Calibrator({
    tracker,
    els: calibrationEls(),
    onDone: onCalibrationDone,
    onCancel: onCalibrationCancel,
  });
  renderPluginGrid(document.getElementById('pluginGrid'));
  ui.renderAssessment(assessLocal(health.metrics, { series: health.series }));
  updateBreakRing(health);

  if (app.modelDropped) {
    setStatus('cal', 'warn', '需重新校准');
    setTimeout(() => notifyAlert({
      level: 'warn',
      title: '视线算法已升级',
      detail: 'v1.0.1 换了更稳的眼动特征，旧校准数据不再适用。请点「启动相机」后重新做一次校准。',
    }), 1500);
  }

  if (app.model) {
    tracker.setModel(app.model);
    setStatus('cal', 'on', `已校准 · ${app.model.rmse || '?'}px`);
    setPrimaryButton('校准视线');
    if (app.model.screen) {
      const ratio = window.innerWidth / window.innerHeight;
      const oldRatio = app.model.screen.w / app.model.screen.h;
      if (Math.abs(ratio - oldRatio) / oldRatio > 0.1) {
        setTimeout(() => notifyAlert({
          level: 'warn',
          title: '屏幕比例与校准时不符',
          detail: '当前窗口比例变化较大，视线可能偏移。建议重新校准。',
        }), 1200);
      }
    }
  }

  setInterval(() => {
    if (app.metrics) renderMetrics(app.metrics);
    updateBreakRing(health);
    const el = document.getElementById('sessionTime');
    if (el && app.sessionStart) {
      const s = Math.floor((Date.now() - app.sessionStart) / 1000);
      const h = String(Math.floor(s / 3600)).padStart(2, '0');
      const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
      const sec = String(s % 60).padStart(2, '0');
      el.textContent = `${h}:${m}:${sec}`;
    }
  }, 1000);

  setInterval(() => {
    const view = document.querySelector('.view[data-view="health"]');
    if (view && view.classList.contains('active')) renderCharts(health);
  }, 3200);

  setInterval(() => {
    coach.refresh(health.metrics, { series: health.series, alerts: health.alerts });
  }, 16000);

  setTimeout(() => {
    coach.refresh(health.metrics, { series: health.series, alerts: health.alerts });
  }, 3500);

  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    const cal = document.getElementById('calibration');
    const brk = document.getElementById('breakOverlay');
    const modal = document.getElementById('modalRoot');
    if (cal.classList.contains('open')) calibrator.cancel();
    else if (brk.classList.contains('open')) health.endBreak(true);
    else if (modal.classList.contains('open')) {
      const btn = modal.querySelector('.modal-close');
      if (btn) btn.click(); else closePanel();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && app.mode === 'running') {
      // 后台时不强制关闭相机，浏览器会自动降帧
    }
  });
}

boot();

if (typeof window !== 'undefined') {
  window.__eyepilot = { app, actions, get health() { return health; }, get tracker() { return tracker; }, get vision() { return vision; }, get input() { return input; }, get calibrator() { return calibrator; } };
}
