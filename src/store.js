/* ============================================================
   store.js — 全局状态与持久化
   ============================================================ */

import { storage } from './utils.js';

export const DEFAULT_SETTINGS = {
  cameraId: '',
  dwellMs: 800,
  clickMode: 'dwell',
  smooth: 65,
  offsetX: 0,
  offsetY: 0,
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
};

export function mergeSettings(raw) {
  const s = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  s.llm = { ...DEFAULT_SETTINGS.llm, ...((raw && raw.llm) || {}) };
  return s;
}

export function initStore() {
  app.settings = mergeSettings(storage.get('settings', {}));
  app.model = storage.get('calibration', null);
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
