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
  checkPoseDrift(frame);
}

/* ---------------- 头位漂移提示 ---------------- */

let lastPoseWarnAt = 0;

/**
 * 单目摄像头的物理限制：头一转，虹膜与眼角的几何关系就变了，线性模型会失准。
 * 这里只做「发现并引导」，不假装能自动补偿：
 * 偏差超过阈值就提示去做五点精细对齐（10 秒），比重做完整校准快得多。
 */
function checkPoseDrift(frame) {
  const p = app.model && app.model.pose;
  if (!p || !frame || !frame.present) return;
  const now = performance.now();
  if (now - lastPoseWarnAt < 45000) return;
  const dyaw = Math.abs((frame.yawDeg || 0) - (p.yaw || 0));
  const dpitch = Math.abs((frame.pitchDeg || 0) - (p.pitch || 0));
  const dscale = p.scale ? Math.abs((frame.eyeScale || 0) / p.scale - 1) : 0;
  if (dyaw < 13 && dpitch < 13 && dscale < 0.2) return;
  lastPoseWarnAt = now;
  notifyAlert({
    level: 'warn',
    title: '头部位置和校准时不一样了',
    detail: '眼控会有偏移。点「设置 → 五点精细对齐」看 5 个点（约 10 秒）即可拉回，不必重做完整校准。',
  });
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
  // 记住校准时的头位，用来判断之后有没有“头动了”
  const f = app.frame;
  model.pose = {
    yaw: f ? f.yawDeg || 0 : 0,
    pitch: f ? f.pitchDeg || 0 : 0,
    scale: f ? f.eyeScale || 0 : 0,
  };
  persistModel(model);
  // 新校准自带了偏差校正，手动偏移与自校准都归零
  saveSettings({ offsetX: 0, offsetY: 0, autoX: 0, autoY: 0, autoN: 0 });
  tracker.setOffset(0, 0);
  tracker.resetAuto();
  ui.updateOffsetUI();
  ui.updateAutoUI();
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
   * 五点精细对齐：samples 是 [{predX,predY,targetX,targetY}]。
   * 横向用左/中/右三点、纵向用上/中/下三点，各自拟合 target ≈ a·pred + b，
   * 同时修偏移与增益；结果直接写回模型并落盘，不动用户手动的 offset。
   */
  applyRefine: (samples) => {
    const m = app.model;
    if (!m || !samples || samples.length < 3) return;
    const fx = fitAffine1D(samples.map((s) => s.predX), samples.map((s) => s.targetX));
    const fy = fitAffine1D(samples.map((s) => s.predY), samples.map((s) => s.targetY));
    m.calX = { a: fx.a, b: fx.b };
    m.calY = { a: fy.a, b: fy.b };
    persistModel(m);
    tracker.model = m;
    tracker.reset();
    // 手动微调与自校准都归零：新的仿射已经吸收了它们
    saveSettings({ offsetX: 0, offsetY: 0, autoX: 0, autoY: 0, autoN: 0 });
    tracker.setOffset(0, 0);
    tracker.resetAuto();
    ui.updateOffsetUI();
    ui.updateAutoUI();
    const px = Math.round(fy.b * window.innerHeight);
    notifyAlert({
      level: 'good',
      title: '五点对齐完成',
      detail: `横向增益 ${fx.a.toFixed(2)}、纵向增益 ${fy.a.toFixed(2)}，纵向偏移 ${px > 0 ? '+' : ''}${px} px。`,
    });
  },
  resetAutoOffset: () => {
    saveSettings({ autoX: 0, autoY: 0, autoN: 0 });
    tracker.resetAuto();
    ui.updateAutoUI();
    notifyAlert({ level: 'info', title: '已重置自校准', detail: '接下来每次注视点击会重新累计修正量。' });
  },
  setIslandEnabled: (on) => {
    const isl = { ...app.settings.island, enabled: !!on };
    saveSettings({ island: isl });
    const d = window.eyePilotDesktop;
    if (d && d.island) d.island.setVisible(!!on);
    pushIsland();
  },
  setIslandItem: (key, on) => {
    const isl = { ...app.settings.island, items: { ...app.settings.island.items, [key]: !!on } };
    saveSettings({ island: isl });
    pushIsland();
  },
  setIslandCustom: (label, text) => {
    const isl = { ...app.settings.island, customLabel: label, customText: text };
    saveSettings({ island: isl });
    pushIsland();
  },
  toggleIslandWindow: () => {
    const d = window.eyePilotDesktop;
    if (d && d.island) d.island.toggle();
    else notifyAlert({ level: 'info', title: '灵动岛是桌面版功能', detail: '网页版只能在设置里预览；用 EyePilot.exe 打开时会显示在屏幕顶部。' });
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

/* ---------------- 灵动岛 ---------------- */

function islandPayload() {
  const m = app.metrics || {};
  const isl = app.settings.island || {};
  const limit = (app.settings.breakMinutes || 20) * 60000;
  const left = Math.max(0, limit - (health.continuousMs || 0));
  const a = health.alerts && health.alerts[0];
  const sec = app.sessionStart ? Math.floor((Date.now() - app.sessionStart) / 1000) : 0;
  return {
    enabled: !!isl.enabled,
    items: isl.items || {},
    customLabel: isl.customLabel || '',
    customText: isl.customText || '',
    live: app.mode === 'running' || app.mode === 'demo',
    mode: app.mode,
    blink: Math.round(m.blinkRate || 0),
    fatigue: Math.round(m.fatigue || 0),
    health: Math.round(m.health || 0),
    focus: Math.round(m.focus || 0),
    session: sec,
    nextBreak: Math.round(left / 1000),
    alert: a ? { level: a.level, title: a.title, detail: a.detail, ts: a.ts || Date.now() } : null,
    ts: Date.now(),
  };
}

async function pushIsland() {
  // 只有桌面版才需要推给灵动岛；网页版不发请求，避免控制台里一片 404/501
  if (!window.eyePilotDesktop) return;
  try {
    const res = await fetch('/api/island/metrics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(islandPayload()),
    });
    if (!res.ok) throw new Error('bad status');
  } catch { /* 网页版没有这个接口，忽略 */ }
}

function showView(name) {
  const btn = document.querySelector(`.rail-btn[data-view="${name}"]`);
  if (btn) btn.click();
}

let pausedByTray = false;

/** 桌面版外壳（托盘 / 灵动岛）发来的指令 */
function bindDesktop() {
  const d = window.eyePilotDesktop;
  if (!d || !d.onAction) return;
  d.onAction((name) => {
    if (name === 'calibrate') { showView('console'); calibrate(false); }
    else if (name === 'refine') { showView('settings'); ui.startAlign(); }
    else if (name === 'settings') showView('settings');
    else if (name === 'report') { showView('coach'); actions.report(); }
    else if (name === 'toggle-pause') {
      pausedByTray = !pausedByTray;
      if (pausedByTray) input.pause();
      else input.resume();
      notifyAlert({
        level: 'info',
        title: pausedByTray ? '眼控已暂停' : '眼控已恢复',
        detail: pausedByTray ? '仍在记录用眼健康，只是不再响应注视点击。' : '注视 0.8 秒即可点击。',
      });
    }
  });
}

/* ---------------- 启动 ---------------- */

function boot() {
  tracker = new GazeTracker({});
  tracker.setSmooth(app.settings.smooth);
  tracker.setOffset(app.settings.offsetX || 0, app.settings.offsetY || 0);
  tracker.setAuto(app.settings.autoX || 0, app.settings.autoY || 0, app.settings.autoN || 0);
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

  // 每次“注视点击”都提供一个已知落点，用它缓慢修正整体偏移（头挪动后的漂移主要靠这个）
  window.addEventListener('eyepilot:click', (ev) => {
    const el = ev.detail && ev.detail.target;
    if (!el || !el.getBoundingClientRect) return;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    if (tracker.observeAnchor(r.left + r.width / 2, r.top + r.height / 2)) {
      const a = tracker.auto;
      saveSettings({ autoX: a.x, autoY: a.y, autoN: a.n });
      ui.updateAutoUI();
    }
  });

  // 灵动岛数据推送（桌面版由主进程转发到悬浮窗；网页版没有该接口，静默失败）
  setInterval(pushIsland, 1000);
  bindDesktop();
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
