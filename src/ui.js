/* ============================================================
   ui.js — 视图渲染、设置绑定、覆盖层控制
   ============================================================ */

import { $, $$, el, toast, beep, fmtClock, fmtHM, download, storage, escapeHtml } from './utils.js';
import { app, saveSettings } from './store.js';
import { pluginHost } from './plugins.js';
import { lineChart, drawHeatmap } from './charts.js';
import { clamp } from './core/math.js';

const E = {};
let actions = {};
let lastLiveAt = 0;
let breakTimer = 0;
let onboardState = 'idle';

const ids = [
  'camStatus', 'modelStatus', 'calStatus', 'sessionTime', 'btnDemo', 'btnTheme', 'btnStart', 'btnBig',
  'dwellHint', 'gazeStatePill', 'stage', 'onboard', 'onboardTitle', 'onboardDesc', 'onboardSteps',
  'btnOnboardPrimary', 'btnOnboardDemo', 'onboardHelp', 'onboardUrl', 'btnCopyUrl',
  'onboardEyebrow', 'onboardFine', 'stageHint', 'gazeCoord',
  'cam', 'camOverlay', 'camWrap', 'fpsBadge', 'camEmpty',
  'mBlink', 'mPerclos', 'mDistance', 'mLight', 'mFocus', 'mFatigue',
  'aiEnginePill', 'aiTipTitle', 'aiTipBody', 'breakArc', 'breakTimer', 'breakDesc', 'btnBreakNow',
  'btnExportJson', 'btnExportCsv',
  'kSession', 'kSessionBar', 'kBlink', 'kBlinkBar', 'kBlinkDur', 'kBlinkDurBar',
  'kPerclos', 'kPerclosBar', 'kDistance', 'kDistanceBar', 'kLight', 'kLightBar',
  'kFocus', 'kFocusBar', 'kFatigue', 'kFatigueBar',
  'chartBlink', 'chartFatigue', 'chartDistance', 'chartLight', 'heatmap', 'heatMeta',
  'alertList', 'btnClearAlerts',
  'coachEnginePill', 'coachRing', 'coachArc', 'coachScore', 'coachLevel', 'coachTitle',
  'coachSummary', 'coachChips', 'coachActions', 'coachPrediction', 'coachUpdated', 'btnCoachReport',
  'chatLog', 'chatForm', 'chatInput', 'chatEnginePill',
  'llmBase', 'llmModel', 'llmKey', 'btnLlmTest', 'btnLlmSave',
  'pluginGrid', 'pluginCount',
  'setCamera', 'setDwell', 'valDwell', 'setClickMode', 'setSmooth', 'valSmooth',
  'setMirror', 'setMesh', 'setBig', 'offsetPill', 'btnCenterOffset', 'btnResetOffset',
  'autoPill', 'btnResetAuto',
  'modePill', 'headConfig', 'setHeadH', 'setHeadV', 'setHeadDead',
  'headHHint', 'headVHint', 'headDeadHint', 'btnRecenter',
  'setIsland', 'isBlink', 'isSession', 'isFatigue', 'isHealth', 'isBreak',
  'islandLabel', 'islandText', 'islandPill', 'islandPreview', 'btnIslandShow',
  'setAlertBlink', 'setAlertDist', 'setAlertLight', 'setAlertBreak',
  'setSound', 'setFatigue', 'valFatigue', 'setBreak', 'valBreak', 'storageInfo', 'btnWipe',
  'calibration', 'calStage', 'calTarget', 'calHint', 'calProgressBar', 'calResult',
  'calResultTitle', 'calResultText', 'calResultMetrics', 'calIntro', 'calCountdown',
  'calBrand', 'calEyebrow', 'calIntroText',
  'calPreview', 'calFace', 'calClose', 'btnCalFinish', 'btnCalRetry',
  'breakOverlay', 'breakCount', 'breakTrackBar', 'btnBreakDone', 'btnBreakSkip', 'breakFine',
  'alignOverlay', 'alignCount', 'alignCancel', 'alignTitle', 'alignHint', 'alignTarget',
];

export const ui = {
  init(deps) {
    actions = deps || {};
    ids.forEach((id) => { E[id] = document.getElementById(id); });
    bindNav();
    bindTopbar();
    bindOnboard();
    bindSettings();
    bindAlign();
    bindCalibration();
    bindBreak();
    bindChat();
    bindExports();
    decorateTiles();
    applySettingsToForm();
    updateStorageInfo();
    switchView('console');
    setOnboard('idle');
    return ui;
  },

  els: E,
};

function decorateTiles() {
  $$('.tile').forEach((tile) => {
    const svg = tile.querySelector('.tile-ico svg');
    if (!svg) return;
    const ghost = document.createElement('span');
    ghost.className = 'tile-ghost';
    ghost.setAttribute('aria-hidden', 'true');
    ghost.innerHTML = svg.outerHTML;
    tile.appendChild(ghost);
  });
}

/* ---------------- 导航 ---------------- */

function bindNav() {
  $$('.rail-btn[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });
  document.body.addEventListener('click', (ev) => {
    const nav = ev.target.closest('[data-nav]');
    if (nav) { switchView(nav.dataset.nav); return; }
    const op = ev.target.closest('[data-open-plugin]');
    if (op) { actions.openPlugin && actions.openPlugin(op.dataset.openPlugin); return; }
    const calf = ev.target.closest('[data-action="calibrate-fine"]');
    if (calf) { actions.calibrateFine && actions.calibrateFine(); return; }
    const cal = ev.target.closest('[data-action="calibrate"]');
    if (cal) actions.calibrate && actions.calibrate();
  });
}

export function switchView(name) {
  $$('.rail-btn[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  $$('.view').forEach((v) => v.classList.toggle('active', v.dataset.view === name));
  const host = $('#views');
  if (host) host.scrollTop = 0;
  if (name === 'health') setTimeout(() => actions.renderCharts && actions.renderCharts(), 60);
  if (name === 'settings') refreshSettingsForm();
  if (name === 'coach') setTimeout(() => ui.renderAssessment(app.assessment), 30);
}

/* ---------------- 顶栏 / 主题 ---------------- */

function bindTopbar() {
  E.btnTheme.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    saveSettings({ theme: next });
    actions.onThemeChange && actions.onThemeChange();
  });
  E.btnStart.addEventListener('click', () => {
    if (app.mode === 'demo') { actions.toggleDemo && actions.toggleDemo(); return; }
    if (app.mode === 'running') actions.calibrate && actions.calibrate();
    else actions.startCamera && actions.startCamera();
  });
  E.btnDemo.addEventListener('click', () => actions.toggleDemo && actions.toggleDemo());
  E.btnBig.addEventListener('click', () => {
    const next = !app.settings.bigTargets;
    saveSettings({ bigTargets: next });
    applyBigTargets();
    actions.applySettings && actions.applySettings();
    toast(next ? '已开启大按钮模式' : '已关闭大按钮模式', next ? '所有可点目标都放大了' : '恢复标准尺寸', 'info', 2200);
  });
}

export function setStatus(which, state, text) {
  const map = { cam: 'camStatus', model: 'modelStatus', cal: 'calStatus' };
  const node = E[map[which]];
  if (!node) return;
  node.className = `status ${state || ''}`;
  node.innerHTML = `<i class="dot"></i>${escapeHtml(text)}`;
}

export function setPrimaryButton(text, disabled = false) {
  const btn = E.btnStart;
  if (!btn) return;
  const span = btn.lastChild;
  btn.disabled = disabled;
  btn.style.opacity = disabled ? '.6' : '1';
  if (span && span.nodeType === 3) span.textContent = ` ${text} `;
  else btn.innerHTML = `<svg viewBox="0 0 24 24"><rect x="2.5" y="6" width="13" height="12" rx="2.5"/><circle cx="9" cy="12" r="3"/><path d="M18.5 9.5 22 12l-3.5 2.5"/></svg>${text}`;
}

export function setDemoActive(on) {
  E.btnDemo.classList.toggle('on', !!on);
  E.btnDemo.querySelector('span').textContent = on ? '演示中' : '演示';
}

/* ---------------- 引导层 ---------------- */

export function setOnboard(state, message) {
  onboardState = state;
  const ob = E.onboard;
  if (!ob) return;
  if (state === 'ready' || state === 'demo') {
    ob.classList.add('hidden');
    return;
  }
  ob.classList.remove('hidden');
  ob.classList.toggle('is-error', state === 'error');
  if (E.onboardHelp) E.onboardHelp.hidden = state !== 'error';
  if (E.onboardFine) E.onboardFine.hidden = state === 'error';
  if (E.onboardEyebrow) E.onboardEyebrow.textContent = state === 'error' ? 'CAMERA BLOCKED' : 'GET STARTED';
  if (E.onboardUrl) E.onboardUrl.textContent = location.href.replace(/index\.html$/, '');

  const steps = E.onboardSteps.querySelectorAll('li');
  steps.forEach((s) => s.classList.remove('done', 'active'));

  const cam = E.btnOnboardPrimary;
  cam.disabled = false;
  cam.style.opacity = '1';

  if (state === 'idle') {
    E.onboardTitle.textContent = '三步，把眼睛变成鼠标';
    E.onboardDesc.textContent = '使用本机摄像头做眼动追踪，全部计算在浏览器内完成，画面不上传。';
    steps[0].classList.add('active');
    cam.textContent = '启动相机并加载模型';
    E.onboardFine.textContent = message || '小提示：把脸放在画面中央、光线均匀，校准会更准。';
  } else if (state === 'loading') {
    E.onboardTitle.textContent = '正在加载视觉模型…';
    E.onboardDesc.textContent = '首次加载约 3–8 秒，模型会缓存在本地，之后启动会快很多。';
    steps[0].classList.add('active');
    cam.textContent = '加载中…';
    cam.disabled = true;
    cam.style.opacity = '.6';
    E.onboardFine.textContent = message || '模型在你自己的电脑上运行。';
  } else if (state === 'camera') {
    E.onboardTitle.textContent = '摄像头就绪，下一步是校准';
    E.onboardDesc.textContent = '校准会让系统学会你的虹膜位移与屏幕坐标之间的映射，大约需要 20 秒。';
    steps[0].classList.add('done');
    steps[1].classList.add('active');
    cam.textContent = '开始九点校准';
    E.onboardFine.textContent = message || '校准过程中请保持头部不动，可以正常眨眼。';
  } else if (state === 'error') {
    E.onboardTitle.textContent = '摄像头没能启动';
    E.onboardDesc.textContent = message || '请检查浏览器权限，或确认没有其他程序占用摄像头。';
    cam.textContent = '重新检测权限';
  }
}

function bindOnboard() {
  E.btnOnboardPrimary.addEventListener('click', () => {
    if (onboardState === 'idle' || onboardState === 'error') actions.startCamera && actions.startCamera();
    else if (onboardState === 'camera') actions.calibrate && actions.calibrate();
  });
  E.btnOnboardDemo.addEventListener('click', () => actions.toggleDemo && actions.toggleDemo());
  if (E.btnCopyUrl) {
    E.btnCopyUrl.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(E.onboardUrl.textContent);
        toast('已复制地址', '粘贴到 Edge / Chrome 地址栏打开即可', 'good', 2600);
      } catch {
        toast('复制失败', '请手动选中地址复制', 'warn', 3000);
      }
    });
  }
}

export function applyBigTargets() {
  const on = !!app.settings.bigTargets;
  document.documentElement.classList.toggle('eye-ui', on);
  if (E.btnBig) {
    E.btnBig.classList.toggle('on', on);
    const label = E.btnBig.querySelector('span');
    if (label) label.textContent = on ? '大按钮' : '标准';
  }
}

export function updateModeUI() {
  const mode = app.settings.controlMode === 'head' ? 'head' : 'eye';
  $$('.mode-btn').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  if (E.modePill) E.modePill.textContent = mode === 'head' ? '头部' : '眼控';
  if (E.headConfig) E.headConfig.classList.toggle('on', mode === 'head');
  if (E.headHHint) E.headHHint.textContent = `${app.settings.headH || 8}°`;
  if (E.headVHint) E.headVHint.textContent = `${app.settings.headV || 5}°`;
  if (E.headDeadHint) E.headDeadHint.textContent = `${app.settings.headDead || 44}px`;
}

export function updateAutoUI() {
  if (!E.autoPill) return;
  const n = app.settings.autoN || 0;
  const x = Math.round(app.settings.autoX || 0);
  const y = Math.round(app.settings.autoY || 0);
  E.autoPill.textContent = `${n} 次 · ${x > 0 ? '+' : ''}${x} , ${y > 0 ? '+' : ''}${y} px`;
}

export function updateOffsetUI() {
  if (!E.offsetPill) return;
  const x = Math.round(app.settings.offsetX || 0);
  const y = Math.round(app.settings.offsetY || 0);
  E.offsetPill.textContent = `偏移 ${x > 0 ? '+' : ''}${x} , ${y > 0 ? '+' : ''}${y} px`;
}

/* ---------------- 实时数据 ---------------- */

const gazeReasonText = {
  noface: '未检测到人脸',
  blink: '眨眼…',
  outside: '视线离开屏幕',
  lowconf: '视线不稳',
  uncalibrated: '待校准',
  ok: '视线已锁定',
};

export function renderLive(frame, gaze, fps) {
  const now = performance.now();
  if (now - lastLiveAt < 110) return;
  lastLiveAt = now;

  if (E.fpsBadge) E.fpsBadge.textContent = `${Math.round(fps || frame.fps || 0)} FPS`;
  if (E.gazeCoord) {
    E.gazeCoord.textContent = gaze && gaze.valid
      ? `${Math.round(gaze.x)} , ${Math.round(gaze.y)}`
      : '-- , --';
  }
  if (E.gazeStatePill) {
    let text = '等待视线';
    let cls = '';
    const headMode = app.settings.controlMode === 'head';
    if (!frame || !frame.present) { text = app.mode === 'demo' ? '演示中' : '未检测到人脸'; cls = 'warn'; }
    else if (headMode) { text = gaze.valid ? '头部控制中' : '头部待稳定'; cls = gaze.valid ? 'on' : 'warn'; }
    else if (!app.model) { text = '待校准'; cls = 'warn'; }
    else if (gaze.valid) { text = '视线已锁定'; cls = 'on'; }
    else { text = gazeReasonText[gaze.reason] || '视线不稳'; cls = gaze.reason === 'blink' ? '' : 'warn'; }
    E.gazeStatePill.className = `pill ${cls}`;
    E.gazeStatePill.innerHTML = `<i class="dot"></i>${text}`;
  }
  if (E.camEmpty) E.camEmpty.classList.toggle('hidden', app.mode === 'running' || app.mode === 'demo');

  // 会话计时
  if (app.sessionStart) {
    E.sessionTime.textContent = fmtClock(Date.now() - app.sessionStart);
  }
}

export function renderMetrics(m) {
  if (!m) return;
  const set = (node, val) => { if (node) node.textContent = val; };
  set(E.mBlink, m.blinkRate || '--');
  set(E.mPerclos, m.perclos || '--');
  set(E.mDistance, m.distance || '--');
  set(E.mLight, m.light || '--');
  set(E.mFocus, m.focus || '--');
  set(E.mFatigue, m.fatigue ?? '--');

  const warn = (node, on) => node && node.parentElement.classList.toggle('alert', !!on);
  warn(E.mBlink, m.blinkRate > 0 && m.blinkRate < 9);
  warn(E.mPerclos, m.perclos > 18);
  warn(E.mDistance, m.distance > 20 && m.distance < 42);
  warn(E.mLight, m.light > 0 && m.light < 60);
  warn(E.mFatigue, m.fatigue >= (app.settings.fatigueThreshold || 65));

  // 健康看板 KPI
  set(E.kSession, m.minutes ? Math.round(m.minutes) : '--');
  set(E.kBlink, m.blinkRate || '--');
  set(E.kBlinkDur, m.blinkDur || '--');
  set(E.kPerclos, m.perclos || '--');
  set(E.kDistance, m.distance || '--');
  set(E.kLight, m.light || '--');
  set(E.kFocus, m.focus || '--');
  set(E.kFatigue, m.fatigue ?? '--');

  bar(E.kSessionBar, (m.minutes || 0) / 60);
  bar(E.kBlinkBar, (m.blinkRate || 0) / 25);
  bar(E.kBlinkDurBar, (m.blinkDur || 0) / 300);
  bar(E.kPerclosBar, (m.perclos || 0) / 30);
  bar(E.kDistanceBar, (m.distance || 0) / 90);
  bar(E.kLightBar, (m.light || 0) / 260);
  bar(E.kFocusBar, (m.focus || 0) / 100);
  bar(E.kFatigueBar, (m.fatigue || 0) / 100);

  const bad = (id, on) => { const n = document.getElementById(id); if (n) n.closest('.kpi').className = `kpi${on ? ' warn' : ''}`; };
  bad('kBlink', m.blinkRate > 0 && m.blinkRate < 9);
  bad('kPerclos', m.perclos > 18);
  bad('kDistance', m.distance > 20 && m.distance < 42);
  bad('kLight', m.light > 0 && m.light < 60);
  bad('kFatigue', m.fatigue >= (app.settings.fatigueThreshold || 65));
}

function bar(node, ratio) {
  if (!node) return;
  node.style.width = `${Math.round(clamp(ratio, 0, 1) * 100)}%`;
}

/* ---------------- 图表 ---------------- */

export function renderCharts(monitor) {
  if (!monitor || !E.chartBlink) return;
  const s = monitor.series || [];
  const pts = (key) => s.map((x) => [x.t, x[key]]);

  lineChart(E.chartBlink, {
    series: [{ points: pts('blink'), fill: true }],
    yMax: 40,
    minSpan: 20,
    threshold: app.baseline.blink || 16,
    windowMs: 10 * 60 * 1000,
  });
  lineChart(E.chartFatigue, {
    series: [
      { points: pts('fatigue'), fill: true },
      { points: pts('perclos'), fill: false, color: 'var(--warn)' },
    ],
    yMax: 100,
    windowMs: 10 * 60 * 1000,
  });
  lineChart(E.chartDistance, {
    series: [{ points: pts('distance'), fill: true }],
    minSpan: 40,
    threshold: 50,
    windowMs: 10 * 60 * 1000,
  });
  lineChart(E.chartLight, {
    series: [{ points: pts('light'), fill: true }],
    minSpan: 80,
    threshold: 60,
    windowMs: 10 * 60 * 1000,
  });

  if (monitor.heat) {
    drawHeatmap(E.heatmap, monitor.heat, 24, 12);
    E.heatMeta.textContent = monitor.heatTotal ? `${Math.round(monitor.heatTotal / 10)} 秒注视样本` : '等待数据';
  }
}

/* ---------------- 提醒 ---------------- */

export function renderAlerts(list) {
  if (!E.alertList) return;
  if (!list || !list.length) {
    E.alertList.innerHTML = '<p class="empty">暂时没有提醒，继续保持。</p>';
    return;
  }
  E.alertList.innerHTML = list.slice(0, 30).map((a) => `
    <div class="alert-item ${a.level}">
      <i></i>
      <div>
        <div class="a-t">${escapeHtml(a.title)}</div>
        <div class="a-d">${escapeHtml(a.detail)}</div>
      </div>
      <time>${escapeHtml(a.time)}</time>
    </div>`).join('');
}

export function notifyAlert(alert) {
  if (!alert) return;
  const kind = alert.level === 'bad' ? 'bad' : alert.level === 'good' ? 'good' : alert.level === 'info' ? 'info' : 'warn';
  toast(alert.title, alert.detail, kind, 6000);
  if (app.settings.sound) {
    if (kind === 'bad') beep('bad');
    else if (kind === 'warn') beep('warn');
    else if (kind === 'good') beep('good');
  }
}

/* ---------------- AI 评估 ---------------- */

const levelText = { good: '状态良好', warn: '轻度负荷', bad: '需要休息', idle: '等待数据' };
const levelColor = { good: 'var(--good)', warn: 'var(--warn)', bad: 'var(--bad)', idle: 'var(--dim)' };

export function renderAssessment(a) {
  if (!a) return;
  const arc = E.coachArc;
  if (arc) {
    const C = 2 * Math.PI * 50;
    arc.style.strokeDasharray = String(C);
    arc.style.strokeDashoffset = String(C * (1 - clamp(a.score / 100, 0, 1)));
    arc.style.stroke = levelColor[a.level] || 'var(--accent)';
  }
  if (E.coachScore) E.coachScore.textContent = a.level === 'idle' ? '--' : String(a.score);
  if (E.coachLevel) {
    E.coachLevel.textContent = levelText[a.level] || '等待数据';
    E.coachLevel.className = `pill ${a.level === 'good' ? 'good' : a.level === 'warn' ? 'warn' : a.level === 'bad' ? 'bad' : ''}`;
  }
  if (E.coachTitle) E.coachTitle.textContent = a.title;
  if (E.coachSummary) E.coachSummary.textContent = a.summary;
  if (E.coachPrediction) E.coachPrediction.textContent = a.prediction;
  if (E.coachActions) {
    E.coachActions.innerHTML = a.actions.map((x) => `<li>${escapeHtml(x)}</li>`).join('');
  }
  if (E.coachChips) {
    E.coachChips.innerHTML = a.chips.map((c) => `<span class="chip ${c.state || ''}">${escapeHtml(c.label)} <b>${escapeHtml(c.value)}</b></span>`).join('');
  }
  if (E.coachUpdated) {
    const engine = a.engine === 'llm' ? '在线大模型' : '本地推理';
    E.coachUpdated.textContent = `更新于 ${fmtHM(a.ts)} · ${engine} · 置信度 ${Math.round(a.confidence * 100)}%`;
  }
  if (E.coachEnginePill) E.coachEnginePill.textContent = a.engine === 'llm' ? '在线大模型' : '本地引擎 · 回归 + 规则推理';
  if (E.aiEnginePill) E.aiEnginePill.textContent = a.engine === 'llm' ? '在线大模型' : '本地引擎';
  if (E.chatEnginePill) E.chatEnginePill.textContent = a.engine === 'llm' ? '在线' : '本地';
  if (E.aiTipTitle) E.aiTipTitle.textContent = a.title;
  if (E.aiTipBody) E.aiTipBody.textContent = a.summary;
}

export function appendChat(role, text) {
  if (!E.chatLog) return null;
  const node = el('div', { class: `msg ${role === 'me' ? 'me' : role === 'thinking' ? 'ai thinking' : 'ai'}` });
  node.innerHTML = String(text).split('\n').map((line) => `<p>${escapeHtml(line)}</p>`).join('');
  E.chatLog.appendChild(node);
  E.chatLog.scrollTop = E.chatLog.scrollHeight;
  return node;
}

/* ---------------- 校准 ---------------- */

function bindCalibration() {
  E.calClose.addEventListener('click', () => actions.cancelCalibration && actions.cancelCalibration());
  E.btnCalFinish.addEventListener('click', () => actions.finishCalibration && actions.finishCalibration());
  E.btnCalRetry.addEventListener('click', () => actions.retryCalibration && actions.retryCalibration());
}

export function calibrationEls() {
  return {
    overlay: E.calibration,
    target: E.calTarget,
    hint: E.calHint,
    progressBar: E.calProgressBar,
    result: E.calResult,
    resultTitle: E.calResultTitle,
    resultText: E.calResultText,
    resultMetrics: E.calResultMetrics,
    preview: document.querySelector('.cal-preview'),
    facePill: E.calFace,
    intro: E.calIntro,
    countdown: E.calCountdown,
    brand: E.calBrand,
    eyebrow: E.calEyebrow,
    introText: E.calIntroText,
    btnFinish: E.btnCalFinish,
    btnRetry: E.btnCalRetry,
  };
}

/* ---------------- 视线对齐 ---------------- */

const ALIGN_STEPS = [
  { x: 0.5, y: 0.5, name: '屏幕中心' },
  { x: 0.5, y: 0.16, name: '屏幕上方' },
  { x: 0.5, y: 0.84, name: '屏幕下方' },
  { x: 0.16, y: 0.5, name: '屏幕左侧' },
  { x: 0.84, y: 0.5, name: '屏幕右侧' },
];
const ALIGN_SETTLE_MS = 750;
const ALIGN_SAMPLE_MS = 900;

let alignRun = 0;
let alignTimer = 0;

/**
 * 五点精细对齐：中心 → 上 → 下 → 左 → 右。
 * 横向用「左/中/右」、纵向用「上/中/下」各三点，能同时解出两轴的偏移与增益，
 * 所以“整体偏下”“越往右越偏”这类问题都能修（v1.0.1 只有纵向三点）。
 */
export async function startAlign() {
  if (!E.alignOverlay) return;
  if (!app.model) {
    toast('还没有校准', '先点「启动相机」完成一次校准，再做五点微调', 'warn', 4000);
    return;
  }
  clearTimeout(alignTimer);
  const run = ++alignRun;
  E.alignOverlay.classList.add('open');
  if (E.alignTitle) E.alignTitle.textContent = '盯住十字，保持 2 秒';

  const samples = [];
  for (let i = 0; i < ALIGN_STEPS.length; i++) {
    const step = ALIGN_STEPS[i];
    if (run !== alignRun) return;
    E.alignOverlay.style.setProperty('--align-x', `${step.x * 100}%`);
    E.alignOverlay.style.setProperty('--align-y', `${step.y * 100}%`);
    if (E.alignHint) E.alignHint.textContent = `第 ${i + 1} / ${ALIGN_STEPS.length} 点 · ${step.name}`;

    // 倒计时：3 → 1，正好覆盖「移动视线 + 稳定」
    for (let n = 3; n > 0; n--) {
      if (run !== alignRun) return;
      E.alignCount.textContent = String(n);
      await new Promise((r) => { alignTimer = setTimeout(r, (ALIGN_SETTLE_MS + ALIGN_SAMPLE_MS) / 3); });
    }

    // 采样这段时间里的预测值中位数，避免用单帧
    const sx = [];
    const sy = [];
    const until = performance.now() + 320;
    while (performance.now() < until) {
      if (run !== alignRun) return;
      const g = app.gaze;
      if (g && g.valid && Number.isFinite(g.predY)) { sx.push(g.predX); sy.push(g.predY); }
      await new Promise((r) => setTimeout(r, 40));
    }
    if (sy.length >= 3) {
      const mid = (arr) => arr.slice().sort((a, b) => a - b)[Math.floor(arr.length / 2)];
      samples.push({
        predX: mid(sx), predY: mid(sy),
        targetX: step.x, targetY: step.y,
      });
    }
  }

  if (run !== alignRun) return;
  E.alignOverlay.classList.remove('open');
  if (samples.length < 3) {
    toast('没采到有效视线', '确保脸在画面中、能正常眨眼，再试一次', 'warn', 4000);
    return;
  }
  actions.applyRefine && actions.applyRefine(samples);
}

function bindAlign() {
  if (E.alignCancel) {
    E.alignCancel.addEventListener('click', () => {
      alignRun++;
      clearTimeout(alignTimer);
      E.alignOverlay.classList.remove('open');
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && E.alignOverlay && E.alignOverlay.classList.contains('open')) {
      alignRun++;
      clearTimeout(alignTimer);
      E.alignOverlay.classList.remove('open');
    }
  });
}

/* ---------------- 远眺 ---------------- */

function bindBreak() {
  E.btnBreakNow.addEventListener('click', () => actions.startBreak && actions.startBreak('manual'));
  E.btnBreakDone.addEventListener('click', () => actions.endBreak && actions.endBreak(false));
  E.btnBreakSkip.addEventListener('click', () => actions.endBreak && actions.endBreak(true));
}

export function openBreak(auto = false) {
  if (!E.breakOverlay) return;
  E.breakOverlay.classList.add('open');
  E.breakFine.textContent = auto
    ? '已经连续用眼 20 分钟，AI 自动带你做一次远眺。'
    : 'AI 会根据你的视线是否离开屏幕，判断这次远眺是否有效。';
  clearInterval(breakTimer);
  const start = Date.now();
  const total = 20000;
  const paint = () => {
    const left = Math.max(0, total - (Date.now() - start));
    E.breakCount.textContent = String(Math.ceil(left / 1000));
    E.breakTrackBar.style.width = `${((total - left) / total) * 100}%`;
    if (left <= 0) clearInterval(breakTimer);
  };
  paint();
  breakTimer = setInterval(paint, 200);
}

export function closeBreak(result) {
  clearInterval(breakTimer);
  if (E.breakOverlay) E.breakOverlay.classList.remove('open');
  if (result && result.skipped) {
    toast('已跳过这次远眺', '下次记得把眼睛从屏幕上移开一会儿', 'info', 3000);
  } else if (result) {
    const effective = (result.awayRatio || 0) > 0.45;
    toast(
      effective ? '远眺完成，睫状肌放松了' : '远眺完成',
      effective ? '检测到你确实把视线移开了屏幕，很好。' : '下次试着真的看向 6 米外，效果会更好。',
      effective ? 'good' : 'info',
      4200,
    );
    if (effective && app.settings.sound) beep('good');
  }
}

export function updateBreakRing(monitor) {
  if (!E.breakArc || !E.breakTimer) return;
  const limit = (app.settings.breakMinutes || 20) * 60000;
  const used = Math.min(monitor.continuousMs, limit);
  const ratio = used / limit;
  const C = 2 * Math.PI * 43;
  E.breakArc.style.strokeDasharray = String(C);
  E.breakArc.style.strokeDashoffset = String(C * ratio);
  E.breakArc.style.stroke = ratio > 0.85 ? 'var(--warn)' : 'var(--accent)';
  const left = Math.max(0, limit - used);
  E.breakTimer.textContent = `${String(Math.floor(left / 60000)).padStart(2, '0')}:${String(Math.floor((left % 60000) / 1000)).padStart(2, '0')}`;
}

/* ---------------- 设置 ---------------- */

function applySettingsToForm() {
  const s = app.settings;
  if (!E.setDwell) return;
  E.setDwell.value = String(s.dwellMs);
  E.valDwell.textContent = `${s.dwellMs}ms`;
  E.setClickMode.value = s.clickMode;
  E.setSmooth.value = String(s.smooth);
  E.valSmooth.textContent = s.smooth > 70 ? '强' : s.smooth > 40 ? '中' : '弱';
  E.setMirror.checked = !!s.mirror;
  E.setMesh.checked = !!s.mesh;
  E.setBig.checked = !!s.bigTargets;
  if (E.setHeadH) E.setHeadH.value = String(s.headH || 8);
  if (E.setHeadV) E.setHeadV.value = String(s.headV || 5);
  if (E.setHeadDead) E.setHeadDead.value = String(s.headDead || 44);
  const isl = s.island || {};
  const items = isl.items || {};
  if (E.setIsland) E.setIsland.checked = isl.enabled !== false;
  if (E.isBlink) E.isBlink.checked = items.blink !== false;
  if (E.isSession) E.isSession.checked = items.session !== false;
  if (E.isFatigue) E.isFatigue.checked = items.fatigue !== false;
  if (E.isHealth) E.isHealth.checked = items.health !== false;
  if (E.isBreak) E.isBreak.checked = items.nextBreak !== false;
  if (E.islandLabel) E.islandLabel.value = isl.customLabel || '';
  if (E.islandText) E.islandText.value = isl.customText || '';
  if (E.islandPill) E.islandPill.textContent = window.eyePilotDesktop ? '桌面版 · 已连接' : '网页版 · 仅预览';
  E.setAlertBlink.checked = !!s.alertBlink;
  E.setAlertDist.checked = !!s.alertDistance;
  E.setAlertLight.checked = !!s.alertLight;
  E.setAlertBreak.checked = !!s.alertBreak;
  E.setSound.checked = !!s.sound;
  E.setFatigue.value = String(s.fatigueThreshold);
  E.valFatigue.textContent = String(s.fatigueThreshold);
  E.setBreak.value = String(s.breakMinutes);
  E.valBreak.textContent = `${s.breakMinutes} 分钟`;
  E.llmBase.value = s.llm.base || '';
  E.llmModel.value = s.llm.model || '';
  E.llmKey.value = s.llm.key || '';
  E.dwellHint.textContent = (s.dwellMs / 1000).toFixed(1);
  applyMirror();
  applyBigTargets();
  updateOffsetUI();
  updateAutoUI();
  updateModeUI();
}

export function applyMirror() {
  const on = !!app.settings.mirror && app.mode !== 'demo';
  E.cam.classList.toggle('mirrored', on);
  E.camOverlay.classList.toggle('mirrored', on);
}

function patch(p) {
  saveSettings(p);
  actions.applySettings && actions.applySettings(p);
  updateStorageInfo();
}

function bindSettings() {
  E.setDwell.addEventListener('input', () => {
    E.valDwell.textContent = `${E.setDwell.value}ms`;
    E.dwellHint.textContent = (Number(E.setDwell.value) / 1000).toFixed(1);
    patch({ dwellMs: Number(E.setDwell.value) });
  });
  E.setSmooth.addEventListener('input', () => {
    const v = Number(E.setSmooth.value);
    E.valSmooth.textContent = v > 70 ? '强' : v > 40 ? '中' : '弱';
    patch({ smooth: v });
  });
  E.setClickMode.addEventListener('change', () => patch({ clickMode: E.setClickMode.value }));
  E.setMirror.addEventListener('change', () => { patch({ mirror: E.setMirror.checked }); applyMirror(); });
  E.setMesh.addEventListener('change', () => patch({ mesh: E.setMesh.checked }));
  E.setBig.addEventListener('change', () => {
    patch({ bigTargets: E.setBig.checked });
    applyBigTargets();
  });
  E.setAlertBlink.addEventListener('change', () => patch({ alertBlink: E.setAlertBlink.checked }));
  E.setAlertDist.addEventListener('change', () => patch({ alertDistance: E.setAlertDist.checked }));
  E.setAlertLight.addEventListener('change', () => patch({ alertLight: E.setAlertLight.checked }));
  E.setAlertBreak.addEventListener('change', () => patch({ alertBreak: E.setAlertBreak.checked }));
  E.setSound.addEventListener('change', () => patch({ sound: E.setSound.checked }));
  E.setFatigue.addEventListener('input', () => {
    E.valFatigue.textContent = E.setFatigue.value;
    patch({ fatigueThreshold: Number(E.setFatigue.value) });
  });
  E.setBreak.addEventListener('input', () => {
    E.valBreak.textContent = `${E.setBreak.value} 分钟`;
    patch({ breakMinutes: Number(E.setBreak.value) });
  });
  E.setCamera.addEventListener('change', () => {
    patch({ cameraId: E.setCamera.value });
  });

  E.btnLlmSave.addEventListener('click', () => {
    patch({
      llm: {
        base: E.llmBase.value.trim(),
        model: E.llmModel.value.trim(),
        key: E.llmKey.value.trim(),
      },
    });
    toast('已保存大模型配置', '下次评估会优先使用在线模型，失败自动回退本地。', 'good', 3200);
    actions.onLLMChange && actions.onLLMChange();
  });
  E.btnLlmTest.addEventListener('click', async () => {
    patch({
      llm: {
        base: E.llmBase.value.trim(),
        model: E.llmModel.value.trim(),
        key: E.llmKey.value.trim(),
      },
    });
    E.btnLlmTest.disabled = true;
    E.btnLlmTest.textContent = '测试中…';
    try {
      const text = await actions.testLLM();
      toast('连接成功', String(text).slice(0, 80), 'good', 4000);
    } catch (err) {
      toast('连接失败', String(err.message || err).slice(0, 120), 'bad', 6000);
    } finally {
      E.btnLlmTest.disabled = false;
      E.btnLlmTest.textContent = '测试连接';
    }
  });

  $$('[data-offset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const map = { up: [0, -12], down: [0, 12], left: [-12, 0], right: [12, 0] };
      const d = map[btn.dataset.offset];
      if (d && actions.nudgeOffset) actions.nudgeOffset(d[0], d[1]);
    });
  });
  if (E.btnCenterOffset) {
    E.btnCenterOffset.addEventListener('click', () => actions.centerOffset && actions.centerOffset());
  }
  if (E.btnResetOffset) {
    E.btnResetOffset.addEventListener('click', () => actions.resetOffset && actions.resetOffset());
  }
  $$('.mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      actions.setControlMode && actions.setControlMode(btn.dataset.mode);
    });
  });
  const headSlider = (el, hint, key, unit) => {
    if (!el) return;
    el.addEventListener('input', () => {
      if (hint) hint.textContent = `${el.value}${unit}`;
    });
    el.addEventListener('change', () => {
      patch({ [key]: Number(el.value) });
    });
  };
  headSlider(E.setHeadH, E.headHHint, 'headH', '°');
  headSlider(E.setHeadV, E.headVHint, 'headV', '°');
  headSlider(E.setHeadDead, E.headDeadHint, 'headDead', 'px');
  if (E.btnRecenter) {
    E.btnRecenter.addEventListener('click', () => actions.recenterHead && actions.recenterHead(false));
  }
  if (E.btnResetAuto) {
    E.btnResetAuto.addEventListener('click', () => actions.resetAutoOffset && actions.resetAutoOffset());
  }
  if (E.setIsland) {
    E.setIsland.addEventListener('change', () => actions.setIslandEnabled && actions.setIslandEnabled(E.setIsland.checked));
  }
  const islandItemMap = { isBlink: 'blink', isSession: 'session', isFatigue: 'fatigue', isHealth: 'health', isBreak: 'nextBreak' };
  for (const [id, key] of Object.entries(islandItemMap)) {
    const el = E[id];
    if (!el) continue;
    el.addEventListener('change', () => actions.setIslandItem && actions.setIslandItem(key, el.checked));
  }
  if (E.islandLabel && E.islandText) {
    const push = () => actions.setIslandCustom
      && actions.setIslandCustom(E.islandLabel.value.trim(), E.islandText.value.trim());
    E.islandLabel.addEventListener('change', push);
    E.islandText.addEventListener('change', push);
  }
  if (E.btnIslandShow) {
    E.btnIslandShow.addEventListener('click', () => actions.toggleIslandWindow && actions.toggleIslandWindow());
  }

  E.btnWipe.addEventListener('click', () => {
    if (!window.confirm('确定要清除本机保存的校准数据、设置与历史指标吗？此操作不可撤销。')) return;
    actions.wipeData && actions.wipeData();
  });

  E.btnClearAlerts.addEventListener('click', () => {
    actions.clearAlerts && actions.clearAlerts();
  });
}

export function refreshSettingsForm() {
  applySettingsToForm();
  updateStorageInfo();
}

export function setCameraOptions(devices) {
  if (!E.setCamera) return;
  const cur = app.settings.cameraId || '';
  E.setCamera.innerHTML = '<option value="">默认摄像头</option>' + devices
    .map((d, i) => `<option value="${d.deviceId}">${escapeHtml(d.label || `摄像头 ${i + 1}`)}</option>`)
    .join('');
  E.setCamera.value = cur;
}

function updateStorageInfo() {
  if (!E.storageInfo) return;
  const kb = storage.size() / 1024;
  E.storageInfo.textContent = `本地存储：${kb < 1 ? '<1' : kb.toFixed(1)} KB · 共 ${storage.keys().length} 项`;
}

/* ---------------- 对话 ---------------- */

function bindChat() {
  E.chatForm.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const text = E.chatInput.value.trim();
    if (!text) return;
    E.chatInput.value = '';
    actions.chat && actions.chat(text);
  });
  $$('.chip-btn[data-ask]').forEach((btn) => {
    btn.addEventListener('click', () => actions.chat && actions.chat(btn.dataset.ask));
  });
}

/* ---------------- 导出 / 报告 ---------------- */

function bindExports() {
  E.btnExportJson.addEventListener('click', () => actions.exportData && actions.exportData('json'));
  E.btnExportCsv.addEventListener('click', () => actions.exportData && actions.exportData('csv'));
  E.btnCoachReport.addEventListener('click', () => actions.report && actions.report());
}

export function showReport(markdown) {
  pluginHost.close();
  const root = $('#modalRoot');
  root.innerHTML = '';
  root.classList.add('open');
  const backdrop = el('div', { class: 'modal-backdrop' });
  const modal = el('div', { class: 'modal', style: 'width:min(760px,94vw)' });
  modal.innerHTML = `
    <div class="modal-head">
      <h3>用眼报告</h3>
      <span class="pill tiny">本地生成</span>
      <button class="modal-close" data-gaze aria-label="关闭"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
    </div>
    <div class="modal-body">
      <pre class="code" style="white-space:pre-wrap;font-size:12px;line-height:1.8">${escapeHtml(markdown)}</pre>
      <div class="row-between" style="margin-top:12px">
        <span class="fine">报告只包含匿名指标，可自由分享。</span>
        <span>
          <button class="btn ghost sm" data-copy>复制</button>
          <button class="btn primary sm" data-dl data-gaze>下载 Markdown</button>
        </span>
      </div>
    </div>`;
  root.appendChild(backdrop);
  root.appendChild(modal);
  const close = () => {
    pluginHost.close();
    root.classList.remove('open');
    root.innerHTML = '';
  };
  modal.querySelector('.modal-close').addEventListener('click', close);
  backdrop.addEventListener('click', close);
  modal.querySelector('[data-copy]').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      toast('已复制到剪贴板', '', 'good', 2000);
    } catch { toast('复制失败', '浏览器拒绝了剪贴板权限', 'warn', 3000); }
  });
  modal.querySelector('[data-dl]').addEventListener('click', () => {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    download(`EyePilot-用眼报告-${stamp}.md`, markdown, 'text/markdown;charset=utf-8');
  });
}

/* ---------------- 其它 ---------------- */

export function fillBreakFine(text) {
  if (E.breakFine) E.breakFine.textContent = text;
}

export function setCamEmpty(text) {
  if (!E.camEmpty) return;
  E.camEmpty.innerHTML = `<svg viewBox="0 0 24 24"><rect x="2.5" y="6" width="13" height="12" rx="2.5"/><circle cx="9" cy="12" r="3.2"/><path d="M18.5 9.5 22 12l-3.5 2.5"/></svg><span>${escapeHtml(text)}</span>`;
}

/* 把渲染函数挂到 ui 对象上，便于 main.js 以 ui.xxx 方式调用 */
Object.assign(ui, {
  renderMetrics,
  renderCharts,
  renderAlerts,
  renderAssessment,
  notifyAlert,
  updateBreakRing,
  openBreak,
  closeBreak,
  setOnboard,
  setStatus,
  setPrimaryButton,
  setDemoActive,
  setCameraOptions,
  refreshSettingsForm,
  applyBigTargets,
  updateOffsetUI,
  updateAutoUI,
  updateModeUI,
  startAlign,
  toast,
  appendChat,
  showReport,
  calibrationEls,
  applyMirror,
});
