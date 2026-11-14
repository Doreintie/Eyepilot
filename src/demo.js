/* ============================================================
   demo.js — 演示模式：鼠标模拟视线 + 合成生理信号
   ============================================================ */

import { app } from './store.js';
import { clamp } from './core/math.js';
import { fmtHM } from './utils.js';

export class DemoEngine {
  constructor({ overlay, onFrame } = {}) {
    this.overlay = overlay;
    this.onFrame = onFrame || (() => {});
    this.raf = 0;
    this.running = false;
    this.mouse = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    this.gazePos = { x: this.mouse.x, y: this.mouse.y };
    this.phase = 0;
    this.last = 0;
    this.onMove = (e) => { this.mouse.x = e.clientX; this.mouse.y = e.clientY; };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.phase = 0;
    window.addEventListener('mousemove', this.onMove, { passive: true });
    const loop = (now) => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      const dt = Math.min(60, now - this.last);
      this.last = now;
      this.phase += dt;

      const t = this.phase;
      // 眨眼节律：约每 4.2 秒一次，偶发双眨
      const cycle = t % 4200;
      let open = 1;
      if (cycle > 3700 && cycle < 3830) open = 0.08;
      else if (cycle > 3950 && cycle < 4040) open = 0.12;
      // 偶尔一次“疲劳性长闭眼”
      if (t % 46000 > 45000) open = 0.15;

      const targetDist = 54 + Math.sin(t / 21000) * 4;
      const light = 126 + Math.sin(t / 17000) * 14;

      // 视线：向鼠标位置缓动 + 微颤
      this.gazePos.x += (this.mouse.x - this.gazePos.x) * 0.22;
      this.gazePos.y += (this.mouse.y - this.gazePos.y) * 0.22;
      const tremorX = Math.sin(t / 90) * 0.8;
      const tremorY = Math.cos(t / 110) * 0.7;

      const gaze = {
        x: this.gazePos.x + tremorX,
        y: this.gazePos.y + tremorY,
        nx: (this.gazePos.x + tremorX) / window.innerWidth,
        ny: (this.gazePos.y + tremorY) / window.innerHeight,
        valid: open > 0.4,
        confidence: 0.92,
        outside: false,
        reason: open > 0.4 ? 'ok' : 'blink',
        ts: now,
      };

      const frame = {
        t: now,
        present: true,
        open,
        blinkL: 1 - open,
        blinkR: 1 - open,
        distanceCm: Math.round(targetDist + Math.sin(t / 3000) * 1.2),
        lightLux: Math.round(light),
        lightLuma: light * 0.42,
        yaw: Math.sin(t / 4000) * 0.04,
        pitch: Math.cos(t / 5200) * 0.03,
        fps: 30,
        demo: true,
      };

      this.draw(frame, gaze);
      this.onFrame(frame, gaze);
    };
    this.raf = requestAnimationFrame(loop);
  }

  draw(frame, gaze) {
    const c = this.overlay;
    if (!c) return;
    if (c.width !== 640 || c.height !== 480) { c.width = 640; c.height = 480; }
    const g = c.getContext('2d');
    const W = 640, H = 480;
    g.clearRect(0, 0, W, H);

    const bg = g.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#0a1420');
    bg.addColorStop(1, '#060a10');
    g.fillStyle = bg;
    g.fillRect(0, 0, W, H);

    // 背景网格
    g.strokeStyle = 'rgba(46,230,214,.05)';
    for (let x = 0; x <= W; x += 32) {
      g.beginPath(); g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, H); g.stroke();
    }
    for (let y = 0; y <= H; y += 32) {
      g.beginPath(); g.moveTo(0, y + 0.5); g.lineTo(W, y + 0.5); g.stroke();
    }

    const cx = 320, cy = 210;
    // 头部
    g.beginPath();
    g.ellipse(cx, cy, 120, 155, 0, 0, Math.PI * 2);
    g.fillStyle = 'rgba(46,230,214,.045)';
    g.fill();
    g.strokeStyle = 'rgba(46,230,214,.45)';
    g.lineWidth = 1.6;
    g.stroke();

    // 眼睛
    const eyeY = cy - 26;
    const eyeDx = 58;
    const open = clamp(frame.open, 0.06, 1);
    for (const sign of [-1, 1]) {
      const ex = cx + sign * eyeDx;
      const rx = 34, ry = 21 * (0.35 + open * 0.65);
      g.beginPath();
      g.ellipse(ex, eyeY, rx, ry, 0, 0, Math.PI * 2);
      g.fillStyle = 'rgba(6,10,16,.85)';
      g.fill();
      g.strokeStyle = 'rgba(46,230,214,.65)';
      g.lineWidth = 1.4;
      g.stroke();

      if (open > 0.25) {
        const px = clamp((gaze.nx - 0.5) * 26, -12, 12);
        const py = clamp((gaze.ny - 0.5) * 18, -8, 8);
        g.beginPath();
        g.arc(ex + px, eyeY + py, 11, 0, Math.PI * 2);
        g.fillStyle = 'rgba(124,156,255,.35)';
        g.fill();
        g.strokeStyle = 'rgba(190,212,255,.9)';
        g.lineWidth = 1.2;
        g.stroke();
        g.beginPath();
        g.arc(ex + px, eyeY + py, 4, 0, Math.PI * 2);
        g.fillStyle = 'rgba(232,239,251,.95)';
        g.fill();
      }
    }

    // 鼻与嘴
    g.strokeStyle = 'rgba(139,155,182,.35)';
    g.beginPath();
    g.moveTo(cx, cy + 8);
    g.lineTo(cx - 6, cy + 52);
    g.lineTo(cx + 8, cy + 54);
    g.stroke();
    g.beginPath();
    g.moveTo(cx - 26, cy + 86);
    g.quadraticCurveTo(cx, cy + 98, cx + 26, cy + 86);
    g.stroke();

    // 标注
    g.fillStyle = 'rgba(46,230,214,.85)';
    g.font = '600 12px ui-monospace, monospace';
    g.textAlign = 'center';
    g.fillText('DEMO MODE · MOUSE AS GAZE', cx, 40);
    g.fillStyle = 'rgba(139,155,182,.75)';
    g.font = '11px system-ui, sans-serif';
    g.fillText('用鼠标移动模拟视线，其余流程与真实模式一致', cx, 444);
    g.fillStyle = 'rgba(139,155,182,.5)';
    g.fillText(`${Math.round(frame.distanceCm)}cm · ${Math.round(frame.lightLux)} lux*`, cx, 462);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('mousemove', this.onMove);
    const c = this.overlay;
    if (c) {
      const g = c.getContext('2d');
      g.clearRect(0, 0, c.width, c.height);
    }
  }
}

/* ---------------- 演示用的合成历史 ---------------- */

export function seedDemoData(monitor) {
  if (!monitor || monitor.series.length > 4) return false;
  const now = Date.now();

  for (let i = 60; i >= 0; i--) {
    const t = now - i * 5000;
    const k = 60 - i;
    monitor.series.push({
      t,
      blink: Math.round(15 + Math.sin(k / 5) * 2.6 - k * 0.05 + (k > 44 ? -2 : 0)),
      perclos: +(4.4 + Math.sin(k / 7) * 1.8 + k * 0.07).toFixed(1),
      distance: Math.round(57 - k * 0.09 + Math.sin(k / 4) * 1.6),
      light: Math.round(126 + Math.sin(k / 9) * 15),
      fatigue: Math.round(29 + k * 0.26 + Math.sin(k / 6) * 4),
      focus: Math.round(76 - k * 0.1 + Math.sin(k / 5) * 5),
    });
  }

  const cells = 24 * 12;
  monitor.heat = new Float32Array(cells);
  const centers = [
    { c: 7.5, r: 4.4, w: 0.5 },
    { c: 12, r: 5.6, w: 0.3 },
    { c: 16.5, r: 3.2, w: 0.2 },
  ];
  let total = 0;
  for (let i = 0; i < 1600; i++) {
    const pick = Math.random() < 0.5 ? centers[0] : Math.random() < 0.6 ? centers[1] : centers[2];
    const c = Math.round(pick.c + (Math.random() - 0.5) * 3.4);
    const r = Math.round(pick.r + (Math.random() - 0.5) * 2.6);
    if (c < 0 || c >= 24 || r < 0 || r >= 12) continue;
    monitor.heat[r * 24 + c] += 1;
    total++;
  }
  monitor.heatTotal = total;

  monitor.samples = [];
  monitor.presence = [];
  monitor.gazes = [];
  for (let i = 0; i < 1200; i++) {
    const t = now - (1200 - i) * 100;
    monitor.samples.push({
      t,
      open: Math.random() < 0.055 ? 0.12 : 1,
      valid: true,
      dist: 54 + Math.sin(i / 40) * 2.6,
      light: 126,
    });
    monitor.presence.push({ t, present: true });
  }
  for (let i = 0; i < 120; i++) {
    monitor.gazes.push({
      t: now - (120 - i) * 100,
      x: 0.32 + Math.sin(i / 9) * 0.06,
      y: 0.38 + Math.cos(i / 11) * 0.05,
      valid: true,
      outside: false,
    });
  }

  monitor.blinks = [];
  for (let i = 55; i >= 0; i--) {
    monitor.blinks.push({ t: now - i * 4200 - Math.random() * 300, dur: 105 + Math.random() * 55 });
  }

  monitor.alerts = [
    {
      id: 'seed-1', level: 'warn', title: '眨眼频率过低',
      detail: '最近一分钟只有 7 次眨眼（个人基线 16 次）。长时间盯屏幕会让眨眼次数下降到平时的 1/3。',
      time: fmtHM(now - 6 * 60000), ts: now - 6 * 60000,
    },
    {
      id: 'seed-2', level: 'warn', title: '你离屏幕太近了',
      detail: '估算视距约 41cm，建议保持一臂距离（50–70cm）。',
      time: fmtHM(now - 21 * 60000), ts: now - 21 * 60000,
    },
  ];
  monitor.continuousMs = 14 * 60000;
  monitor.metrics = { ...monitor.metrics, minutes: 14, reliable: true };
  app.sessionStart = now - 14 * 60000;
  return true;
}
