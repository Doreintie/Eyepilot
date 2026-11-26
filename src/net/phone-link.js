/* ============================================================
   net/phone-link.js — PC 侧：接收手机推来的关键点
   ------------------------------------------------------------
   - 走 SSE（/api/link/stream），服务端每来一包就广播一次
   - 解包后还原成 MediaPipe result 形状，复用 analyzeFace()
   - 不在这里做融合：融合需要 PC 侧的模型与用户设置，
     放在 main.js 里统一处理
   ============================================================ */

import { decodeFrame, toResult, base64ToBytes } from './protocol.js';
import { analyzeFace } from '../vision.js';

const RETRY_MS = [1000, 2000, 4000, 8000];

export class PhoneLink {
  constructor({ onFrame, onStatus } = {}) {
    this.onFrame = onFrame || (() => {});
    this.onStatus = onStatus || (() => {});
    this.es = null;
    this.retry = 0;
    this.timer = 0;
    this.active = false;
    this.frameCount = 0;
    this.fpsWindow = 0;
    this.fps = 0;
    this.lastSeq = -1;
    this.dropped = 0;
    this.packets = 0;
    this.latency = 0;
    this.lastFrameAt = 0;
    this.info = { phone: '', width: 0, height: 0, connected: false };
  }

  async connect() {
    if (this.active) return this.info;
    this.active = true;
    this.retry = 0;
    await this.refreshInfo();
    this.open();
    return this.info;
  }

  async refreshInfo() {
    try {
      const r = await fetch('/api/link/state', { cache: 'no-store' });
      const j = await r.json();
      this.server = j;
      const before = this.info.connected;
      this.info = {
        phone: j.phone || '',
        width: j.width || 0,
        height: j.height || 0,
        connected: !!j.phone && Date.now() - (j.lastAt || 0) < 4000,
        lanUrl: j.lanUrl || '',
        token: j.token || '',
        lan: !!j.lan,
        https: !!j.https,
      };
      if (this.info.connected !== before) this.onStatus(this.info);
    } catch {
      this.info = { ...this.info, connected: false };
    }
    return this.info;
  }

  open() {
    if (!this.active) return;
    clearTimeout(this.timer);
    try {
      this.es = new EventSource('/api/link/stream');
    } catch {
      this.scheduleRetry();
      return;
    }
    this.es.onopen = () => {
      this.retry = 0;
      this.onStatus({ ...this.info });
    };
    this.es.onmessage = (ev) => this.handle(ev.data);
    this.es.onerror = () => {
      // EventSource 自己会重连一次；连续失败就退避重开，避免把浏览器拖住
      if (this.es && this.es.readyState === EventSource.CLOSED) {
        this.es.close();
        this.es = null;
        this.scheduleRetry();
      }
    };
  }

  scheduleRetry() {
    if (!this.active) return;
    const wait = RETRY_MS[Math.min(this.retry, RETRY_MS.length - 1)];
    this.retry++;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.refreshInfo().finally(() => this.open());
    }, wait);
  }

  handle(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || !msg.p) return;
    let packet;
    try {
      packet = decodeFrame(base64ToBytes(msg.p));
    } catch {
      this.dropped++;
      return;
    }
    if (!packet) { this.dropped++; return; }

    this.packets++;
    this.lastFrameAt = Date.now();
    if (!this.info.connected) {
      this.info.connected = true;
      this.onStatus({ ...this.info });
      // 顺手拉一次设备名与分辨率，避免界面上一直显示「未连接」
      this.refreshInfo();
    }
    if (this.lastSeq >= 0 && packet.seq > this.lastSeq + 1) {
      this.dropped += packet.seq - this.lastSeq - 1;
    }
    this.lastSeq = packet.seq;
    if (typeof msg.t === 'number') this.latency = Math.max(0, Date.now() - msg.t);

    this.frameCount++;
    const now = performance.now();
    if (!this.fpsWindow) this.fpsWindow = now;
    else if (now - this.fpsWindow > 1000) {
      this.fps = Math.round((this.frameCount * 1000) / (now - this.fpsWindow));
      this.frameCount = 0;
      this.fpsWindow = now;
    }

    let frame;
    try {
      frame = analyzeFace(toResult(packet), packet.width || 640, packet.height || 480);
    } catch (err) {
      this.dropped++;
      console.warn('[EyePilot] 手机帧解析失败', err);
      return;
    }
    frame.t = now;
    frame.seq = packet.seq;
    frame.remote = true;
    frame.link = { latency: this.latency, fps: this.fps, bytes: packet.bytes };
    this.onFrame(frame);
  }

  stats() {
    const fresh = this.lastFrameAt > 0 && Date.now() - this.lastFrameAt < 4000;
    return {
      connected: fresh || this.info.connected,
      phone: this.info.phone,
      fps: this.fps,
      latency: Math.round(this.latency),
      packets: this.packets,
      dropped: this.dropped,
    };
  }

  disconnect() {
    this.active = false;
    clearTimeout(this.timer);
    if (this.es) {
      this.es.close();
      this.es = null;
    }
    this.info.connected = false;
    this.onStatus({ ...this.info, connected: false });
  }
}
