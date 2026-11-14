/* ============================================================
   plugins.js — 插件注册、面板容器、事件总线
   ============================================================ */

import { $, el, storage, toast, escapeHtml } from './utils.js';
import { app } from './store.js';

const registry = new Map();

function enabledMap() {
  return storage.get('plugins', {}) || {};
}

export function isEnabled(id) {
  const map = enabledMap();
  return map[id] !== false;
}

export function setEnabled(id, on) {
  const map = enabledMap();
  map[id] = !!on;
  storage.set('plugins', map);
}

export function registerPlugin(def) {
  if (!def || !def.id || typeof def.mount !== 'function') {
    console.warn('[EyePilot] 插件定义不合法', def);
    return;
  }
  registry.set(def.id, {
    tags: [],
    description: '',
    tagline: '',
    ...def,
  });
}

export function listPlugins() {
  return Array.from(registry.values());
}

/* ---------------- 面板宿主 ---------------- */

export const pluginHost = {
  active: null,
  frame(frame, gaze) {
    if (!this.active) return;
    for (const cb of this.active.frameCbs) {
      try { cb(frame, gaze); } catch (err) { console.warn('[EyePilot] 插件帧回调异常', err); }
    }
  },
  close() {
    if (!this.active) return;
    const a = this.active;
    this.active = null;
    try { a.def.unmount && a.def.unmount(a.body, a.ctx); } catch (err) { console.warn(err); }
    for (const fn of a.cleanups) { try { fn(); } catch (err) { console.warn(err); } }
    a.root.classList.remove('open');
    a.root.innerHTML = '';
    app.activePanel = null;
  },
};

export function closePanel() {
  pluginHost.close();
}

/**
 * @param {string} id
 * @param {{api: object}} deps
 */
export function openPlugin(id, deps = {}) {
  const def = registry.get(id);
  if (!def) return null;
  if (!isEnabled(id)) {
    toast('插件未启用', '先在插件中心打开它', 'warn');
    return null;
  }
  pluginHost.close();

  const root = $('#modalRoot');
  root.innerHTML = '';
  root.classList.add('open');

  const backdrop = el('div', { class: 'modal-backdrop' });
  const modal = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': def.name });
  modal.innerHTML = `
    <div class="modal-head">
      <span class="p-ico">${def.icon || ''}</span>
      <div class="p-title"><b>${escapeHtml(def.name)}</b><span>${escapeHtml(def.tagline || '')}</span></div>
      <span class="pill tiny" data-status><i class="dot on"></i>眼控已接管</span>
      <button class="modal-close" data-gaze aria-label="关闭">
        <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>
      </button>
    </div>
    <div class="modal-body" data-body></div>`;
  root.appendChild(backdrop);
  root.appendChild(modal);

  const body = modal.querySelector('[data-body]');
  const statusEl = modal.querySelector('[data-status]');
  const frameCbs = [];
  const cleanups = [];

  const api = {
    close: () => pluginHost.close(),
    onFrame(cb) { frameCbs.push(cb); return () => { const i = frameCbs.indexOf(cb); if (i >= 0) frameCbs.splice(i, 1); }; },
    onCleanup(fn) { cleanups.push(fn); return fn; },
    setStatus(text, kind = 'on') {
      statusEl.innerHTML = `<i class="dot ${kind}"></i>${escapeHtml(text)}`;
    },
    toast,
    getGaze: () => app.gaze,
    getMetrics: () => app.metrics || {},
    getFrame: () => app.frame,
    settings: app.settings,
    app,
  };

  const ctx = {
    ...api,
    root: body,
  };

  pluginHost.active = { id, def, root, body, ctx, frameCbs, cleanups };

  modal.querySelector('.modal-close').addEventListener('click', () => pluginHost.close());
  backdrop.addEventListener('click', () => pluginHost.close());

  try {
    const r = def.mount(body, ctx);
    if (r && typeof r.then === 'function') {
      r.catch((err) => {
        console.error('[EyePilot] 插件挂载失败', err);
        body.innerHTML = `<p class="empty">插件挂载失败：${escapeHtml(String(err.message || err))}</p>`;
      });
    }
  } catch (err) {
    console.error(err);
    body.innerHTML = `<p class="empty">插件挂载失败：${escapeHtml(String(err.message || err))}</p>`;
  }

  app.activePanel = id;
  return pluginHost.active;
}

/* ---------------- 插件中心 ---------------- */

export function renderPluginGrid(container) {
  if (!container) return;
  const plugins = listPlugins();
  container.innerHTML = '';
  for (const p of plugins) {
    const on = isEnabled(p.id);
    const card = el('div', { class: 'card plugin-card' });
    card.innerHTML = `
      <div class="p-head">
        <span class="p-ico">${p.icon || ''}</span>
        <div class="p-title"><b>${escapeHtml(p.name)}</b><span>${escapeHtml(p.tagline || '')}</span></div>
        <span class="pill tiny">${on ? '已启用' : '已停用'}</span>
      </div>
      <p class="p-desc">${escapeHtml(p.description || '')}</p>
      <div class="p-tags">${(p.tags || []).map((t) => `<span class="pill tiny">${escapeHtml(t)}</span>`).join('')}</div>
      <div class="p-actions">
        <label class="switch-row" data-gaze style="gap:8px">
          <span class="fine">启用</span>
          <input type="checkbox" ${on ? 'checked' : ''} data-toggle />
          <i class="switch"></i>
        </label>
        <button class="btn primary sm" data-open data-gaze ${on ? '' : 'disabled'}>打开面板</button>
      </div>`;

    card.querySelector('[data-toggle]').addEventListener('change', (ev) => {
      setEnabled(p.id, ev.target.checked);
      renderPluginGrid(container);
      updatePluginCount();
      toast(ev.target.checked ? '已启用插件' : '已停用插件', p.name, 'info', 2000);
    });
    card.querySelector('[data-open]').addEventListener('click', () => openPlugin(p.id));
    container.appendChild(card);
  }
  updatePluginCount();
}

export function updatePluginCount() {
  const node = $('#pluginCount');
  if (node) node.textContent = String(listPlugins().length);
}

export const pluginSvg = {
  reader: '<svg viewBox="0 0 24 24"><path d="M4 5.5c2.8-1.2 5.5-1.2 8 0 2.5-1.2 5.2-1.2 8 0v13c-2.8-1.2-5.5-1.2-8 0-2.5-1.2-5.2-1.2-8 0v-13Z"/><path d="M12 5.8v12.5"/></svg>',
  game: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.4"/><path d="M12 3.5v4M12 16.5v4M3.5 12h4M16.5 12h4"/></svg>',
  focus: '<svg viewBox="0 0 24 24"><circle cx="12" cy="13" r="8"/><path d="M12 9v4.5l3 1.8M9 2.5h6"/></svg>',
  speak: '<svg viewBox="0 0 24 24"><path d="M4 9.5h3l4-3.5v12l-4-3.5H4v-5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18 6a8.5 8.5 0 0 1 0 12"/></svg>',
};

/* 暴露给外部脚本的轻量 SDK */
if (typeof window !== 'undefined') {
  window.EyePilot = {
    register: registerPlugin,
    open: (id) => openPlugin(id),
    close: closePanel,
    list: listPlugins,
    state: app,
    version: '1.0.0',
  };
}
