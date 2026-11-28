/* ============================================================
   main.js — 启动、帧调度、模块编排
   ============================================================ */

import { initStore, app, persistModel, resetAllData, learnBaseline, saveSettings } from './store.js';
import {
  ui, setStatus, setOnboard, renderLive, renderMetrics, renderCharts, renderAlerts,
  notifyAlert, renderAssessment, appendChat, setDemoActive, setPrimaryButton,
  setCameraOptions, openBreak, closeBreak, updateBreakRing, showReport, calibrationEls,
  showSettingsPane,
} from './ui.js';
import { VisionEngine } from './vision.js';
import { GazeTracker, Calibrator } from './gaze.js';
import { PhoneLink } from './net/phone-link.js';
import { fuseTwo } from './core/fusion.js';
import { createGazeInput } from './input.js';
import { installFromFiles, listInstalled, removeMany, loadInstalled } from './plugin-store.js';
import { HealthMonitor } from './health-monitor.js';
import { AICoach, buildReport, assessLocal } from './ai.js';
import { pluginHost, renderPluginGrid, closePanel, openPlugin } from './plugins.js';
import { download } from './utils.js';
import {
  initOnboarding, bootGate, askCamera, maybeTour, openTour, setCameraLocked, resetCameraConsent,
} from './onboarding.js';
import { fitAffine1D } from './core/math.js';
import { DemoEngine, seedDemoData } from './demo.js';

import './plugins/reader.js';
import './plugins/game.js';
import { initFocusSession } from './focus-session.js';

initStore();
const focusSession = initFocusSession();

const video = document.getElementById('cam');
const overlay = document.getElementById('camOverlay');

let vision = null;
let phoneLink = null;
let tracker = null;
let input = null;

// 启动早期（input 还没创建）也可能走到这里，统一兜一层
const pauseInput = () => { if (input) input.pause(); };
const resumeInput = () => { if (input) input.resume(); };
let health = null;
let coach = null;
let calibrator = null;
let demo = null;
let lastBaselineAt = 0;

/* ---------------- 帧处理 ---------------- */

/* ---------------- 手机双摄 ---------------- */

let phoneAutoSwitched = false;
function handlePhoneFrame(frame) {
  app.phoneFrame = frame;
  if (!phoneAutoSwitched && app.model && (app.settings.controlMode || 'eye') === 'mouse') {
    phoneAutoSwitched = true;
    actions.setControlMode('hybrid');
    ui.toast('手机已接入', '输入方式已临时切到「眼 + 鼠」，鼠标仍然随时可用', 'good', 5200);
  }
  if (app.settings.phoneMode === 'off' || !app.model) {
    app.phoneGaze = null;
  } else {
    app.phoneGaze = tracker.predictRemote(frame, app.settings.phoneCal, 1 / 24);
  }
  refreshPhoneUi();
}

async function loadLinkInfo() {
  try {
    const r = await fetch('/api/link/state', { cache: 'no-store' });
    app.phoneInfo = await r.json();
  } catch {
    app.phoneInfo = null;
  }
  ui.updatePhoneUI(phoneLink ? phoneLink.stats() : null);
}

let phoneUiAt = 0;
function refreshPhoneUi() {
  const now = performance.now();
  if (now - phoneUiAt < 500) return;
  phoneUiAt = now;
  ui.updatePhoneUI && ui.updatePhoneUI(phoneLink ? phoneLink.stats() : null);
}

/**
 * 两路融合。
 * 关：完全用本机；仅手机：直接取手机那一路（本机仍跑，用于头姿与健康指标）；
 * 融合：按「权重 × 手机置信度」插值，某一路失效时自动退化为另一路。
 */
function fuseWithPhone(pcGaze) {
  const mode = app.settings.phoneMode || 'off';
  if (mode === 'off') return pcGaze;
  const ph = app.phoneGaze;
  if (!ph) return pcGaze;
  if (mode === 'only') return { ...ph, valid: ph.valid, source: 'phone', fused: true };
  const w = (app.settings.phoneWeight == null ? 55 : app.settings.phoneWeight) / 100;
  return fuseTwo(pcGaze, ph, w, window.innerWidth, window.innerHeight);
}

function afterFrame(frame, gaze) {
  app.frame = frame;
  const shown = fuseWithPhone(gaze);
  app.gaze = shown;
  // 校准器需要每一帧原始几何特征；之前漏了这一行，导致“样本太少”
  if (calibrator && calibrator.active) calibrator.pushFrame(frame);
  tickMouseHold();
  if (!mouseHoldActive) {
    input.update(shown, frame);
    pushSystemCursor(shown);
  }
  health.ingest(frame, shown);
  pluginHost.frame(frame, shown);
  focusSession.frame(frame, shown);
  renderLive(frame, shown, frame.fps);
  checkPoseDrift(frame);
}

/* ---------------- 鼠标优先（override） ---------------- */

/**
 * 眼控光标是每帧写入的，物理鼠标会和它抢同一个指针——v1.4.0 里就会出现
 * 「眼控落点和鼠标指针重叠、鼠标推不动」的死锁。
 * 这里把鼠标定为**永远可用**：一旦检测到人真的动了鼠标，眼控立刻让位一段时间。
 * 各模式让位时长不同：混合模式里鼠标是平级输入，所以很快交还。
 */
const MOUSE_HOLD_MS = { eye: 1200, head: 900, hybrid: 300, mouse: 0 };
let mouseHoldUntil = 0;
let mouseHoldActive = false;

function noteUserMouseMove() {
  if (app.mode === 'demo') return;
  const mode = app.settings.controlMode || 'eye';
  const hold = MOUSE_HOLD_MS[mode] || 0;
  if (!hold) return;
  mouseHoldUntil = performance.now() + hold;
  if (!mouseHoldActive) {
    mouseHoldActive = true;
    pauseInput();
    ui.setMouseHold(true);
  }
}

function tickMouseHold() {
  if (!mouseHoldActive) return;
  if (performance.now() < mouseHoldUntil) return;
  mouseHoldActive = false;
  if ((app.settings.controlMode || 'eye') !== 'mouse') resumeInput();
  ui.setMouseHold(false);
}

/* ---------------- 系统光标 ---------------- */

let lastCursorAt = 0;

/** 打开“接管系统鼠标”后，把归一化视线送给主进程，用系统 API 移动真实光标 */
function pushSystemCursor(gaze) {
  const d = window.eyePilotDesktop;
  if (!d || !d.cursor || !app.settings.systemCursor) return;
  if (app.settings.controlMode === 'mouse') return;
  if (mouseHoldActive) return;
  if (!gaze || !gaze.valid) return;
  const now = performance.now();
  if (now - lastCursorAt < 30) return;
  lastCursorAt = now;
  d.cursor.set(gaze.nx, gaze.ny);
}

/* ---------------- 头位漂移提示 ---------------- */

let lastPoseWarnAt = 0;

/**
 * 单目摄像头的物理限制：头一转，虹膜与眼角的几何关系就变了，线性模型会失准。
 * 这里只做「发现并引导」，不假装能自动补偿：
 * 偏差超过阈值就提示去做五点精细对齐（10 秒），比重做完整校准快得多。
 */
function checkPoseDrift(frame) {
  if (app.settings.controlMode === 'head' || app.settings.controlMode === 'mouse') return;
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
  const raw = (err && err.message) || '';
  if (raw.startsWith('NO_FRAMES')) {
    const label = raw.split(':')[1] || '';
    return `摄像头已经打开，但 3 秒内一帧画面都没拿到${label ? `（当前设备：${label}）` : ''}。`
      + '常见原因：选到了虚拟摄像头（OBS、会议软件的虚拟相机）、镜头被物理遮挡、'
      + 'Windows 相机隐私开关关掉了桌面应用，或者驱动异常。'
      + '可以在设置里换一个摄像头重试；如果这台电脑没有可用摄像头，直接用「手机当摄像头」。';
  }
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

  // 真正调摄像头之前先问：不同意就只保留计时 / 护眼 / 提醒
  const allowed = await askCamera();
  if (!allowed) {
    setCameraLocked(true);
    setStatus('cam', 'warn', '未授权摄像头');
    setOnboard('camera');
    setPrimaryButton('需要摄像头授权', false);
    ui.toast('未授权摄像头', '眼控、疲劳分析不可用；计时、专注会话、护眼操和提醒照常工作。', 'warn', 6500);
    return;
  }
  setCameraLocked(false);
  setOnboard('loading');
  setPrimaryButton('加载中…', true);
  setStatus('model', 'warn', '模型加载中');
  setStatus('cam', 'warn', '相机启动中');
  ui.armSlowHint('正在加载中……请稍后', '首次启动要加载视觉模型与摄像头，通常 3–8 秒');
  try {
    await vision.start(app.settings.cameraId);
    ui.disarmSlowHint();
    app.mode = 'running';
    app.sessionStart = Date.now();
    setStatus('cam', 'on', '相机就绪');
    setStatus('model', 'on', '模型就绪');
    const headMode = app.settings.controlMode === 'head';
    setPrimaryButton(headMode ? '头部模式' : app.model ? '重新校准' : '校准视线');
    setStatus('cal', headMode ? 'on' : app.model ? 'on' : 'warn',
      headMode ? '头部模式 · 免校准' : app.model ? `已校准 · ${app.model.rmse || '?'}px` : '待校准');
    setOnboard(headMode || app.model ? 'ready' : 'camera');
    const devices = await vision.listCameras();
    setCameraOptions(devices);
    resumeInput();
    if (app.model) {
      tracker.setModel(app.model);
      if (app.model.smooth != null) {
        app.settings.smooth = app.model.smooth;
        tracker.setSmooth(app.model.smooth);
      }
    }
  } catch (err) {
    ui.disarmSlowHint();
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
  pauseInput();
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
  pauseInput();
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
  resumeInput();
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
  resumeInput();
  setOnboard(app.model ? 'ready' : vision.running ? 'camera' : 'idle');
}

/* ---------------- 演示 ---------------- */

function startDemo() {
  if (vision.running) vision.stop();
  // 纯鼠标模式默认停了注视点击；演示是用鼠标模拟视线，得重新打开
  resumeInput();
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
  resumeInput();
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
  if ((app.settings.controlMode || 'eye') === 'mouse') pauseInput();
  app.mode = 'idle';
  app.sessionStart = 0;
  setDemoActive(false);
  setStatus('cam', '', '相机未启动');
  setStatus('model', '', '模型待加载');
  setStatus('cal', app.model ? 'on' : '', app.model ? `已校准 · ${app.model.rmse || '?'}px` : '未校准');
  setOnboard(app.model ? 'ready' : 'idle');
  setPrimaryButton('启动相机');
  ui.applyMirror();
  pauseInput();
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
    pauseInput();
    openBreak(ev.source === 'auto');
  } else {
    resumeInput();
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
    tracker.setControlMode(app.settings.controlMode || 'eye');
    tracker.setHeadConfig({
      hRange: app.settings.headH || 8,
      vRange: app.settings.headV || 5,
      dead: app.settings.headDead || 44,
      hybridRange: app.settings.hybridRange || 110,
      hybridDead: app.settings.hybridDead == null ? 12 : app.settings.hybridDead,
      only: !!app.settings.headOnly,
    });
    if ((app.settings.controlMode || 'eye') === 'mouse') pauseInput();
    else resumeInput();
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
  // 头部模式下“对齐”就是重新归中；眼控模式才走五点拟合
  centerOffset: () => (app.settings.controlMode === 'head' ? actions.recenterHead(false) : ui.startAlign()),
  /**
   * 五点精细对齐：samples 是 [{predX,predY,targetX,targetY}]。
   * 横向用左/中/右三点、纵向用上/中/下三点，各自拟合 target ≈ a·pred + b，
   * 同时修偏移与增益；结果直接写回模型并落盘，不动用户手动的 offset。
   */
  applyRefine: (samples, source) => {
    const m = app.model;
    if (!samples || samples.length < 3) return;
    const fx = fitAffine1D(samples.map((s) => s.predX), samples.map((s) => s.targetX));
    const fy = fitAffine1D(samples.map((s) => s.predY), samples.map((s) => s.targetY));

    // 手机那一路单独一套仿射：视角不同，系统偏差也不同，不能共用
    if (source === 'phone') {
      saveSettings({ phoneCal: { x: { a: fx.a, b: fx.b }, y: { a: fy.a, b: fy.b } } });
      app.alignSource = 'pc';
      ui.updatePhoneUI && ui.updatePhoneUI(phoneLink ? phoneLink.stats() : null);
      notifyAlert({
        level: 'good',
        title: '手机通道已对齐',
        detail: `横向增益 ${fx.a.toFixed(2)}、纵向增益 ${fy.a.toFixed(2)}。现在两路应该指向同一处，可以打开融合了。`,
      });
      return;
    }

    if (!m) return;
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
  startPhoneLink: async () => {
    if (!phoneLink) {
      phoneLink = new PhoneLink({ onFrame: handlePhoneFrame, onStatus: () => refreshPhoneUi() });
    }
    const info = await phoneLink.connect();
    refreshPhoneUi();
    if (!info || !info.lan) {
      ui.toast('手机互联还没开启', '网页版请用 python serve.py --lan 启动；桌面版点「开启局域网」', 'warn', 5200);
    }
    return info;
  },
  stopPhoneLink: () => {
    if (phoneLink) phoneLink.disconnect();
    app.phoneGaze = null;
    app.phoneFrame = null;
    refreshPhoneUi();
  },
  enableLan: async () => {
    const d = window.eyePilotDesktop;
    if (!d || !d.link) {
      ui.toast('网页版请重启服务', '关掉当前服务，改用 python serve.py --lan 启动，就会打印手机地址', 'warn', 6000);
      return null;
    }
    const r = await d.link.enable();
    if (!r || !r.ok) {
      ui.toast('局域网开启失败', (r && r.error) || '检查防火墙是否拦截了 8848 端口', 'warn', 6000);
      return null;
    }
    if (!r.https) {
      ui.toast('没有找到 openssl，只能走 HTTP', '手机浏览器会拒绝摄像头。装 Git for Windows 后重开，或改用 python serve.py --lan。', 'warn', 8000);
    }
    if (!r.https) {
      ui.toast('没有找到 openssl，只能走 HTTP', '手机浏览器会拒绝摄像头。装 Git for Windows 后重开，或改用 python serve.py --lan。', 'warn', 8000);
    }
    refreshPhoneUi();
    return r;
  },
  setThemeMode: (m) => {
    const mode = ['light', 'system', 'dark'].includes(m) ? m : 'dark';
    saveSettings({ themeMode: mode });
    ui.applyAppearance();
  },
  setBgImage: (dataUrl, lum) => {
    try {
      saveSettings({
        bgImage: dataUrl || '',
        bgLum: dataUrl && lum != null ? Number(lum) : null,
      });
    } catch {
      ui.toast('背景图太大', '换一张分辨率低一点的图片，或先压缩', 'warn', 4200);
      return;
    }
    ui.applyAppearance();
  },
  setBgDim: (v) => {
    saveSettings({ bgDim: Math.max(0, Math.min(85, Number(v) || 0)) });
    ui.applyAppearance();
  },
  setMoreAlpha: (v) => {
    saveSettings({ moreOpacity: Math.max(45, Math.min(100, Number(v) || 92)) });
    ui.applyAppearance();
  },
  setCardAlpha: (v) => {
    saveSettings({ cardAlpha: Math.max(0, Math.min(100, Number(v))) });
    ui.applyAppearance();
  },
  resetLayout: () => {
    ui.resetLayout();
  },
  installPlugins: async (files) => {
    const r = await installFromFiles(files);
    if (r.added.length) {
      await loadInstalled();
      ui.renderPluginManager([]);
  // 先加载本地安装的第三方插件，再渲染列表，避免刷新后卡片消失
  loadInstalled()
    .then(async (n) => {
      if (n) renderPluginGrid(document.getElementById('pluginGrid'));
      ui.renderPluginManager(await listInstalled());
    })
    .catch(() => ui.renderPluginManager([]));
      ui.renderPluginManager(await listInstalled());
    }
    return r;
  },
  removePlugins: async (ids) => {
    if (!ids || !ids.length) return;
    await removeMany(ids);
    ui.renderPluginManager(await listInstalled());
    ui.toast('已卸载', `移除了 ${ids.length} 个插件，刷新页面后卡片会消失`, 'good', 4000);
  },
  openTour: () => openTour(),
  /** 直接跳到「手机双摄」卡片：没有可用摄像头的人不该先学会找设置 */
  openPhoneCard: () => {
    showView('settings');
    // v1.8.0：手机双摄在「眼控」类目里，之前没切类目，scrollIntoView 找不到可见目标，
    // 看起来就只是跳到了设置页（还停在「外观」），等于没反应。
    showSettingsPane('eye');
    setTimeout(() => {
      const card = document.querySelector('.phone-card');
      if (!card) return;
      card.scrollIntoView({ block: 'center', behavior: 'smooth' });
      card.classList.add('flash');
      setTimeout(() => card.classList.remove('flash'), 1900);
    }, 220);
    ui.toast('手机当第二只摄像头', '同一个 Wi-Fi：点「开启局域网」→ 手机打开地址 → 开始推流；两路融合能压抖动', 'info', 6200);
  },
  revokeCamera: () => {
    resetCameraConsent();
    setCameraLocked(true);
    ui.updateCamConsent(app.settings.cameraConsent || '');
    notifyAlert({
      level: 'info',
      title: '已撤销摄像头授权',
      detail: '眼控、疲劳分析暂停；计时、专注会话与护眼提醒继续。下次点「启动相机」会重新询问。',
    });
  },
  setHeadOnly: (on) => {
    saveSettings({ headOnly: !!on });
    tracker.setHeadConfig({ only: !!on });
    tracker.reset();
    notifyAlert({
      level: 'info',
      title: on ? '头部模式只看头' : '头部模式恢复眼 + 头',
      detail: on ? '不再读虹膜，免校准也不受镜片反光影响，代价是精度只到「大按钮」级。' : '头姿定方向、虹膜做精修，精度更高。',
    });
  },
  setPhoneMode: (mode) => {
    const m = ['off', 'fuse', 'only'].includes(mode) ? mode : 'off';
    saveSettings({ phoneMode: m });
    ui.updatePhoneUI(phoneLink ? phoneLink.stats() : null);
    if (m !== 'off' && !phoneLink) actions.startPhoneLink();
    if (m !== 'off' && !app.model) {
      ui.toast('还没有校准', '手机那一路也要用同一个模型，先完成一次九点校准', 'warn', 5000);
    }
  },
  setPhoneWeight: (v) => {
    saveSettings({ phoneWeight: Math.max(0, Math.min(100, Number(v) || 0)) });
  },
  alignPhone: () => {
    if (!app.phoneGaze) {
      ui.toast('手机还没数据', '先让手机开始推流，并确认状态是「推流中」', 'warn', 4200);
      return;
    }
    app.alignSource = 'phone';
    ui.startAlign();
  },
  resetPhoneCal: () => {
    saveSettings({ phoneCal: { x: { a: 1, b: 0 }, y: { a: 1, b: 0 } } });
    tracker.reset();
    ui.updatePhoneUI(phoneLink ? phoneLink.stats() : null);
    notifyAlert({ level: 'info', title: '已重置手机校正', detail: '手机通道回到未校正状态，建议重新做一次手机五点对齐。' });
  },
  resetAutoOffset: () => {
    saveSettings({ autoX: 0, autoY: 0, autoN: 0 });
    tracker.resetAuto();
    ui.updateAutoUI();
    notifyAlert({ level: 'info', title: '已重置自校准', detail: '接下来每次注视点击会重新累计修正量。' });
  },
  setControlMode: (mode) => {
    const m = ['eye', 'hybrid', 'head', 'mouse'].includes(mode) ? mode : 'eye';
    saveSettings({ controlMode: m });
    tracker.setControlMode(m);
    // 鼠标永远可用：只有「纯鼠标」才彻底停掉眼控；
    // 其余模式靠 override 让位，不再和鼠标互斥。
    mouseHoldActive = false;
    mouseHoldUntil = 0;
    ui.setMouseHold(false);
    if (m === 'mouse') pauseInput();
    else resumeInput();
    if (m === 'head') actions.recenterHead(true);
    ui.updateModeUI();
    const info = {
      eye: ['已切换到纯眼控', '虹膜决定光标。鼠标随时可以抢回控制权，停手 1.2 秒后自动交还。'],
      hybrid: ['已切换到眼控 + 鼠标', '眼睛和鼠标同时有效：鼠标一动就接管，停 0.3 秒交还眼睛。'],
      head: ['已切换到眼控 + 头控', '头姿决定大方向，虹膜在 ±110px 内精修；不用大幅转头，也不用重新校准。'],
      mouse: ['已切换到纯鼠标', '眼控与注视点击暂停，护眼与专注监测继续。'],
    }[m];
    notifyAlert({ level: 'info', title: info[0], detail: info[1] });
  },
  recenterHead: (silent) => {
    const f = app.frame;
    if (!f || !f.present || !Number.isFinite(f.yawDeg)) {
      if (!silent) ui.toast('还没检测到人脸', '让脸出现在画面里再点「重新归中」', 'warn', 3500);
      return;
    }
    saveSettings({ headZeroYaw: f.yawDeg, headZeroPitch: f.pitchDeg });
    tracker.setHeadZero(f.yawDeg, f.pitchDeg);
    // 只改零点，不改模式：混合/眼控模式下调零点不应该把模式切走
    tracker.setControlMode(app.settings.controlMode || 'eye');
    if (!silent) {
      notifyAlert({
        level: 'good',
        title: '已归中',
        detail: `当前头部姿态（yaw ${f.yawDeg.toFixed(1)}° / pitch ${f.pitchDeg.toFixed(1)}°）视为屏幕中心。`,
      });
    }
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

/** 灵动岛的持续提示：异常指标要持续一段时间才提示，避免闪一下就骚扰 */
const islandHintState = { at: 0, blink: 0, dist: 0, fatigue: 0 };

function computeIslandHint() {
  const m = app.metrics || {};
  const now = Date.now();
  const dt = islandHintState.at ? Math.min(2000, now - islandHintState.at) : 0;
  islandHintState.at = now;
  const blinkBad = m.blinkRate > 0 && m.blinkRate < 10;
  const distBad = m.distance > 0 && m.distance < 42;
  const fatigueBad = Number(m.fatigue) >= (app.settings.fatigueThreshold || 65);
  islandHintState.blink = blinkBad ? islandHintState.blink + dt : 0;
  islandHintState.dist = distBad ? islandHintState.dist + dt : 0;
  islandHintState.fatigue = fatigueBad ? islandHintState.fatigue + dt : 0;

  const limit = (app.settings.breakMinutes || 20) * 60000;
  if (health.breakActive) {
    const left = Math.max(0, Math.ceil((20000 - (Date.now() - health.breakStart)) / 1000));
    return { text: `远眺中 · 还剩 ${left} 秒`, action: 'break' };
  }
  if (health.continuousMs > limit * 0.92) return { text: '该远眺了 · 点我开始', action: 'break' };
  if (islandHintState.dist > 120000) return { text: '距离过近 · 已超 2 分钟', action: 'eyecare' };
  if (islandHintState.blink > 120000) return { text: '眨眼偏少 · 已超 2 分钟', action: 'eyecare' };
  if (islandHintState.fatigue > 180000) return { text: '疲劳偏高 · 建议休息', action: 'eyecare' };
  return null;
}

function islandPayload() {
  const m = app.metrics || {};
  const isl = app.settings.island || {};
  const limit = (app.settings.breakMinutes || 20) * 60000;
  const left = Math.max(0, limit - (health.continuousMs || 0));
  // 只把 90 秒内的告警显示在灵动岛上，避免历史提醒一直挂着
  const latest = health.alerts && health.alerts[0];
  const a = latest && Date.now() - (latest.ts || 0) < 90000 ? latest : null;
  const sec = app.sessionStart ? Math.floor((Date.now() - app.sessionStart) / 1000) : 0;
  return {
    enabled: !!isl.enabled,
    items: isl.items || {},
    customLabel: isl.customLabel || '',
    customText: isl.customText || '',
    live: app.mode === 'running' || app.mode === 'demo',
    mode: app.settings.controlMode || 'eye',
    blink: Math.round(m.blinkRate || 0),
    distance: Math.round(m.distance || 0),
    fatigue: Math.round(m.fatigue || 0),
    health: Math.round(m.health || 0),
    focus: Math.round(m.focus || 0),
    hint: computeIslandHint(),
    break: {
      active: !!health.breakActive,
      due: !health.breakActive && health.continuousMs > ((app.settings.breakMinutes || 20) * 60000) * 0.92,
    },
    session: sec,
    nextBreak: Math.round(left / 1000),
    focusSession: focusSession.snapshot(),
    // 护眼弹层是否打开：岛上据此强制收起，避免一起挡屏幕
    breakOpen: !!(document.getElementById('breakOverlay') || {}).classList?.contains('open'),
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
  // 把「关窗口是否留在托盘」同步给主进程，默认留在托盘
  if (d.app && d.app.setCloseBehavior) d.app.setCloseBehavior(app.settings.closeToTray !== false);
  d.onAction((name) => {
    if (name === 'calibrate') { showView('console'); calibrate(false); }
    else if (name === 'refine') { showView('settings'); ui.startAlign(); }
    else if (name === 'settings') showView('settings');
    else if (name === 'eyecare') showView('eyecare');
    else if (name === 'break') actions.startBreak('island');
    else if (name.startsWith('mode:')) actions.setControlMode(name.slice(5));
    else if (name === 'report') { showView('coach'); actions.report(); }
    else if (name === 'toggle-pause') {
      pausedByTray = !pausedByTray;
      if (pausedByTray) pauseInput();
      else resumeInput();
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
  tracker.setControlMode(app.settings.controlMode || 'eye');
  tracker.setHeadConfig({
    hRange: app.settings.headH || 8,
    vRange: app.settings.headV || 5,
    dead: app.settings.headDead || 44,
    hybridRange: app.settings.hybridRange || 110,
    hybridDead: app.settings.hybridDead == null ? 12 : app.settings.hybridDead,
    only: !!app.settings.headOnly,
  });
  if ((app.settings.controlMode || 'eye') === 'mouse') pauseInput();
  tracker.setHeadZero(app.settings.headZeroYaw || 0, app.settings.headZeroPitch || 0);
  // 鼠标永远可用：本页光标靠 pointermove，接管系统鼠标时靠主进程比对指针位置
  window.addEventListener('pointermove', (e) => {
    if (app.settings.systemCursor) return;
    if (e.isTrusted) noteUserMouseMove();
  }, { passive: true });
  if (window.eyePilotDesktop && window.eyePilotDesktop.onUserMouse) {
    window.eyePilotDesktop.onUserMouse(() => noteUserMouseMove());
  }
  // 没有摄像头时 afterFrame 不会跑，让位必须有自己的时钟，否则会一直卡在「暂停」
  setInterval(tickMouseHold, 120);
  input = createGazeInput(app.settings, () => {});
  health = new HealthMonitor({ onMetrics, onAlert, onBreak: onBreakEvent });
  coach = new AICoach({ onAssessment: (a) => renderAssessment(a) });
  vision = new VisionEngine({ video, overlay, onFrame: handleVisionFrame, onStatus: onVisionStatus });
  vision.showMesh = app.settings.mesh;
  demo = new DemoEngine({ overlay, onFrame: handleDemoFrame });

  ui.init(actions);
  window.__eyePilotReady = true;
  ui.hideLoading();
  initOnboarding({ setView: showView, setPane: showSettingsPane });
  // 须知放在这里显示：DOM 已就绪，同时还在首帧渲染之前
  const gateDone = bootGate();
  setCameraLocked((app.settings.cameraConsent || '') === 'denied');
  gateDone.then(() => maybeTour());

  // 必须在 ui.init 之后创建：校准器需要读取已缓存的 DOM 元素
  calibrator = new Calibrator({
    tracker,
    els: calibrationEls(),
    onDone: onCalibrationDone,
    onCancel: onCalibrationCancel,
  });
  renderPluginGrid(document.getElementById('pluginGrid'));
  ui.updatePhoneUI(null);
  loadLinkInfo().then(() => {
    // 局域网已经开着就直接订阅，手机一连上就有数据，不用再点一次
    if (app.phoneInfo && app.phoneInfo.lan) actions.startPhoneLink();
  });

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
