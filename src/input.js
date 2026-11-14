/* ============================================================
   input.js — 眼控光标、注视停留点击、长眨眼点击
   ============================================================ */

import { $, beep, clamp01 } from './utils.js';

const RING_LEN = 2 * Math.PI * 17;

export class GazeInput {
  constructor({ cursor, ring, label, settings, onActivate }) {
    this.cursor = cursor;
    this.ring = ring;
    this.label = label;
    this.settings = settings;
    this.onActivate = onActivate || (() => {});
    this.paused = false;
    this.target = null;
    this.pending = null;
    this.pendingSince = 0;
    this.progress = 0;
    this.lastTs = 0;
    this.cooldown = new WeakMap();
    this.blinkStart = 0;
    this.lastOnTargetAt = 0;
    this.targetSwitchAt = 0;
    this.lastHitEl = null;
    this.visible = false;
    this.suppressUntil = 0;
    this.ring.style.strokeDasharray = String(RING_LEN);
    this.ring.style.strokeDashoffset = String(RING_LEN);
    // 用鼠标点过东西之后短暂抑制注视点击，避免“鼠标 + 眼睛”双重触发
    window.addEventListener('pointerdown', () => {
      this.suppressUntil = performance.now() + 700;
      this.progress = 0;
    }, true);
  }

  setSettings(settings) { this.settings = settings; }

  setVisible(v) {
    if (v === this.visible) return;
    this.visible = v;
    this.cursor.classList.toggle('active', v);
  }

  pause() {
    this.paused = true;
    this.setVisible(false);
    this.clearTarget();
    this.progress = 0;
    this.updateRing();
  }

  resume() {
    this.paused = false;
  }

  clearTarget() {
    if (this.target) this.target.classList.remove('is-target');
    this.target = null;
    this.pending = null;
    this.label.textContent = '';
    this.cursor.classList.remove('on-target');
  }

  updateRing() {
    this.ring.style.strokeDashoffset = String(RING_LEN * (1 - clamp01(this.progress)));
    this.ring.style.stroke = this.progress > 0.72 ? 'var(--accent-2)' : 'var(--accent)';
  }

  flash() {
    this.cursor.classList.remove('clicked');
    void this.cursor.offsetWidth;
    this.cursor.classList.add('clicked');
    setTimeout(() => this.cursor.classList.remove('clicked'), 340);
  }

  findTarget(x, y) {
    const node = document.elementFromPoint(x, y);
    if (!node) return null;
    const t = node.closest('[data-gaze]');
    if (!t) return null;
    return t;
  }

  activate(el) {
    if (!el) return;
    const now = performance.now();
    const until = this.cooldown.get(el) || 0;
    if (now < until) return;
    this.cooldown.set(el, now + 1100);
    this.flash();
    if (this.settings.sound) beep('click');
    this.progress = 0;
    this.updateRing();
    this.onActivate(el);
    el.dispatchEvent(new CustomEvent('eyepilot:click', { bubbles: true, detail: { gaze: this.lastGaze } }));
    window.dispatchEvent(new CustomEvent('eyepilot:click', { detail: { target: el, gaze: this.lastGaze } }));
    // 触发真实点击，让任何原生按钮/链接都能被“看”到
    setTimeout(() => {
      try { el.click(); } catch { /* noop */ }
    }, 0);
  }

  update(gaze, frame) {
    if (this.paused) return;
    this.lastGaze = gaze;
    const now = performance.now();
    const dt = this.lastTs ? now - this.lastTs : 16;
    this.lastTs = now;

    const hasFace = frame && frame.present !== false;
    if (!hasFace || (!gaze.valid && !gaze.ts)) {
      this.setVisible(false);
      this.clearTarget();
      this.progress = 0;
      this.updateRing();
      return;
    }

    this.setVisible(true);
    this.cursor.style.transform = `translate3d(${gaze.x.toFixed(1)}px, ${gaze.y.toFixed(1)}px, 0)`;
    this.cursor.style.opacity = gaze.valid ? '1' : '.42';

    const blinking = !gaze.valid && gaze.reason === 'blink';
    const hit = gaze.valid || blinking ? this.findTarget(gaze.x, gaze.y) : null;

    // 目标切换加一点防抖，避免光标在边界抖动时反复归零
    if (hit !== this.target) {
      if (hit !== this.pending) { this.pending = hit; this.pendingSince = now; }
      // 目标丢失时多等一会儿，短暂抖出边界不重新计时
      const switchDelay = hit ? 90 : 220;
      if (now - this.pendingSince > switchDelay) {
        if (this.target) this.target.classList.remove('is-target');
        this.target = hit;
        if (hit) {
          hit.classList.add('is-target');
          this.cursor.classList.add('on-target');
          const text = (hit.dataset.gazeLabel || hit.getAttribute('aria-label') || hit.textContent || '').trim().replace(/\s+/g, ' ');
          this.label.textContent = text.slice(0, 10);
        } else {
          this.cursor.classList.remove('on-target');
          this.label.textContent = '';
        }
        this.progress = 0;
      }
    } else if (!this.target) {
      this.cursor.classList.remove('on-target');
    }

    // 注视停留：眨眼时保持进度，不要因为正常眨眼而重新计时
    const suppressed = now < this.suppressUntil;
    if (this.target && gaze.valid && !suppressed && (this.settings.clickMode === 'dwell' || this.settings.clickMode === 'both')) {
      const until = this.cooldown.get(this.target) || 0;
      if (now < until) {
        this.progress = 0;
      } else {
        this.progress = clamp01(this.progress + dt / Math.max(300, this.settings.dwellMs));
        this.lastOnTargetAt = now;
        if (this.progress >= 1) this.activate(this.target);
      }
    } else if (blinking || (this.target && now - this.lastOnTargetAt < 180)) {
      // 眨眼或短暂抖动出界：保持进度
    } else {
      this.progress = Math.max(0, this.progress - dt / 260);
    }
    this.updateRing();

    // 命中目标后，光标逐渐吸到目标中心，视觉上更稳，也不容易被抖动带出边界
    let drawX = gaze.x;
    let drawY = gaze.y;
    if (this.target && gaze.valid) {
      const r = this.target.getBoundingClientRect();
      const k = this.progress > 0.55 ? 0.55 : this.progress > 0.2 ? 0.3 : 0;
      if (k > 0) {
        drawX += (r.left + r.width / 2 - drawX) * k;
        drawY += (r.top + r.height / 2 - drawY) * k;
      }
    }
    this.cursor.style.transform = `translate3d(${drawX.toFixed(1)}px, ${drawY.toFixed(1)}px, 0)`;

    // 长眨眼点击
    if (this.settings.clickMode === 'blink' || this.settings.clickMode === 'both') {
      const open = frame ? frame.open : 1;
      if (open < 0.25) {
        if (!this.blinkStart) this.blinkStart = now;
      } else if (this.blinkStart) {
        const dur = now - this.blinkStart;
        this.blinkStart = 0;
        if (dur > 320 && dur < 1400 && this.target && gaze.valid) this.activate(this.target);
      }
    }
  }
}

export function createGazeInput(settings, onActivate) {
  return new GazeInput({
    cursor: $('#eyeCursor'),
    ring: $('#dwellRing'),
    label: $('#cursorLabel'),
    settings,
    onActivate,
  });
}

export const cursorRingLength = RING_LEN;
