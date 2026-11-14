/* ============================================================
   utils.js — DOM / 存储 / 提示 / 声音
   ============================================================ */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function el(tag, attrs = {}, html) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  if (html != null) node.innerHTML = html;
  return node;
}

export const clamp01 = (v) => Math.max(0, Math.min(1, v));

export function fmtClock(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

export function fmtHM(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

export function fmtMinutes(min) {
  if (min < 60) return `${Math.round(min)}`;
  return `${Math.floor(min / 60)}h${String(Math.round(min % 60)).padStart(2, '0')}`;
}

export function download(filename, content, mime = 'text/plain;charset=utf-8') {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

/* ---------------- 本地存储 ---------------- */

const PREFIX = 'eyepilot.v1.';

export const storage = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      if (raw == null) return fallback;
      return JSON.parse(raw);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); return true; }
    catch { return false; }
  },
  remove(key) {
    try { localStorage.removeItem(PREFIX + key); } catch { /* noop */ }
  },
  keys() {
    try { return Object.keys(localStorage).filter((k) => k.startsWith(PREFIX)); }
    catch { return []; }
  },
  size() {
    try {
      return this.keys().reduce((s, k) => s + (localStorage.getItem(k) || '').length * 2, 0);
    } catch { return 0; }
  },
  clearAll() {
    this.keys().forEach((k) => { try { localStorage.removeItem(k); } catch { /* noop */ } });
  },
};

/* ---------------- toast ---------------- */

let toastHost = null;
export function toast(title, body = '', kind = 'info', ms = 4200) {
  if (!toastHost) toastHost = document.getElementById('toasts');
  if (!toastHost) return;
  const node = el('div', { class: `toast ${kind}` }, `<i></i><div><b>${title}</b>${body ? `<span>${body}</span>` : ''}</div>`);
  toastHost.appendChild(node);
  const kill = () => {
    node.classList.add('out');
    setTimeout(() => node.remove(), 320);
  };
  setTimeout(kill, ms);
  node.addEventListener('click', kill);
  while (toastHost.children.length > 4) toastHost.firstElementChild.remove();
}

/* ---------------- 声音 ---------------- */

let audioCtx = null;
function ctx() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    audioCtx = new AC();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

export function beep(kind = 'click', volume = 0.045) {
  const ac = ctx();
  if (!ac) return;
  const t = ac.currentTime;
  const notes = {
    click: [[880, 0, 0.06]],
    good: [[660, 0, 0.08], [990, 0.08, 0.12]],
    warn: [[520, 0, 0.09], [420, 0.12, 0.12]],
    bad: [[380, 0, 0.12], [300, 0.14, 0.18]],
    break: [[720, 0, 0.18], [960, 0.2, 0.26]],
  }[kind] || [[880, 0, 0.06]];

  for (const [freq, delay, dur] of notes) {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = kind === 'bad' || kind === 'warn' ? 'triangle' : 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, t + delay);
    gain.gain.linearRampToValueAtTime(volume, t + delay + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + delay + dur);
    osc.connect(gain).connect(ac.destination);
    osc.start(t + delay);
    osc.stop(t + delay + dur + 0.02);
  }
}

/* ---------------- 其他 ---------------- */

export function debounce(fn, ms = 200) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function throttle(fn, ms = 100) {
  let last = 0;
  return (...args) => {
    const now = Date.now();
    if (now - last >= ms) { last = now; fn(...args); }
  };
}

export const isTypingTarget = (node) => {
  if (!node) return false;
  const tag = node.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || node.isContentEditable;
};

export function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
