/* ============================================================
   store.js — 全局状态与持久化
   ============================================================ */

import { storage } from './utils.js';
import { FEATURE_VERSION, featureDim } from './core/math.js';

export const DEFAULT_SETTINGS = {
  cameraId: '',
  dwellMs: 800,
  clickMode: 'dwell',
  smooth: 65,
  offsetX: 0,
  offsetY: 0,
  // 使用中自校准累计的修正量（每次注视点击学一点）
  autoX: 0,
  autoY: 0,
  autoN: 0,
  // 控制方式：eye = 虹膜眼控（精细，需校准）；head = 头部转角（稳、免校准）
  // v1.5.0 起定位是「自律 / 护眼」，新装默认纯鼠标，眼控按需开启
  controlMode: 'mouse',
  headH: 8,
  headV: 5,
  headDead: 44,
  headOnly: false,
  hybridRange: 110,
  hybridDead: 12,
  systemCursor: false,
  // 手机互联：off 关闭 / fuse 融合 / only 仅手机
  phoneMode: 'off',
  phoneWeight: 55,
  phoneCal: { x: { a: 1, b: 0 }, y: { a: 1, b: 0 } },
  headZeroYaw: 0,
  headZeroPitch: 0,
  // 灵动岛（桌面版为独立悬浮窗，网页版只做预览）
  island: {
    enabled: true,
    items: { blink: true, session: true, fatigue: true, health: true, nextBreak: true, clock: false },
    customLabel: '正在播放',
    customText: '',
  },
  bigTargets: true,
  mirror: true,
  mesh: true,
  sound: true,
  alertBlink: true,
  alertDistance: true,
  alertLight: true,
  alertBreak: true,
  fatigueThreshold: 65,
  breakMinutes: 20,
  theme: 'dark',
  llm: { base: '', key: '', model: '' },
};

export const app = {
  mode: 'idle',            // idle | running | demo
  settings: { ...DEFAULT_SETTINGS },
  model: null,             // 校准得到的回归模型
  gaze: { x: 0, y: 0, valid: false, confidence: 0, outside: false, ts: 0 },
  frame: null,
  metrics: null,
  assessment: null,
  alerts: [],
  baseline: { blink: 16, distance: 58, updatedAt: 0 },
  sessionStart: 0,
  demo: false,
  activePanel: null,
  calibratedThisSession: false,
  phoneGaze: null,         // 手机那一路的当前预测
  phoneFrame: null,        // 手机那一路的最近一帧特征
  phoneStats: null,
  alignSource: 'pc',       // 五点对齐针对哪一路：pc | phone
};

export function mergeSettings(raw) {
  const s = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  s.llm = { ...DEFAULT_SETTINGS.llm, ...((raw && raw.llm) || {}) };
  const pc = (raw && raw.phoneCal) || {};
  s.phoneCal = {
    x: { a: 1, b: 0, ...(pc.x || {}) },
    y: { a: 1, b: 0, ...(pc.y || {}) },
  };
  const isl = { ...DEFAULT_SETTINGS.island, ...((raw && raw.island) || {}) };
  isl.items = { ...DEFAULT_SETTINGS.island.items, ...((raw && raw.island && raw.island.items) || {}) };
  s.island = isl;
  return s;
}

export function initStore() {
  app.settings = mergeSettings(storage.get('settings', {}));
  const raw = storage.get('calibration', null);
  // 特征算法升级后旧模型不再适用（维度/语义都变了），必须丢弃并要求重新校准，
  // 否则会用 8 维权重去读 6 维特征，直接算出 NaN。
  const usable = raw
    && raw.featureVersion === FEATURE_VERSION
    && Array.isArray(raw.w)
    && raw.d === featureDim(raw.degree || 1);
  app.model = usable ? raw : null;
  app.modelDropped = !!raw && !usable;
  if (raw && !usable) storage.remove('calibration');
  const b = storage.get('baseline', null);
  if (b && b.blink) app.baseline = b;
  document.documentElement.dataset.theme = app.settings.theme === 'light' ? 'light' : 'dark';
}

export function saveSettings(patch = {}) {
  app.settings = mergeSettings({ ...app.settings, ...patch });
  storage.set('settings', app.settings);
  return app.settings;
}

export function persistModel(model) {
  app.model = model;
  if (model) storage.set('calibration', model);
  else storage.remove('calibration');
}

export function learnBaseline(metrics) {
  if (!metrics || !metrics.reliable) return;
  const b = app.baseline;
  const rate = metrics.blinkRate;
  if (rate >= 8 && rate <= 28) {
    b.blink = b.blink ? Math.round(b.blink * 0.93 + rate * 0.07) : rate;
  }
  if (metrics.distance >= 35 && metrics.distance <= 90) {
    b.distance = b.distance ? Math.round(b.distance * 0.93 + metrics.distance * 0.07) : metrics.distance;
  }
  b.updatedAt = Date.now();
  storage.set('baseline', b);
}

export function resetAllData() {
  storage.clearAll();
  app.model = null;
  app.alerts = [];
  app.baseline = { blink: 16, distance: 58, updatedAt: 0 };
  app.settings = { ...DEFAULT_SETTINGS };
}
