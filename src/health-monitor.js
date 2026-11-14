/* ============================================================
   health-monitor.js — 用眼行为监测、告警与 20-20-20 节律
   ============================================================ */

import { app } from './store.js';
import {
  computePerclos, computeBlinkRate, computeBlinkStats, computeDistance, computeLight,
  computeFocus, computeFatigue, computeHealthScore, levelOfHealth,
} from './core/health.js';
import { clamp } from './core/math.js';
import { beep, fmtHM } from './utils.js';

const HEAT_COLS = 24;
const HEAT_ROWS = 12;
const MAX_SAMPLES = 2200;
const MAX_GAZES = 240;
const MAX_BLINKS = 400;
const MAX_SERIES = 200;

export class HealthMonitor {
  constructor({ onMetrics, onAlert, onBreak } = {}) {
    this.onMetrics = onMetrics || (() => {});
    this.onAlert = onAlert || (() => {});
    this.onBreak = onBreak || (() => {});
    this.reset();
  }

  reset() {
    this.sessionStart = Date.now();
    this.samples = [];
    this.gazes = [];
    this.presence = [];
    this.blinks = [];
    this.series = [];
    this.alerts = [];
    this.heat = new Float32Array(HEAT_COLS * HEAT_ROWS);
    this.heatTotal = 0;
    this.continuousMs = 0;
    this.awaySince = 0;
    this.blinkStart = 0;
    this.lastSampleAt = 0;
    this.lastIngest = 0;
    this.lastTick = 0;
    this.lastSeriesAt = 0;
    this.alertCooldown = new Map();
    this.distanceLowSince = 0;
    this.lightLowSince = 0;
    this.blinkLowSince = 0;
    this.breakActive = false;
    this.breakStart = 0;
    this.breakAwayMs = 0;
    this.breakLastCheck = 0;
    this.lastPresent = false;
    this.metrics = {
      blinkRate: 0, blinkDur: 0, perclos: 0, distance: 0, light: 0,
      focus: 0, fatigue: 0, health: 0, minutes: 0, reliable: false, level: 'good',
    };
  }

  ingest(frame, gaze) {
    const t = Date.now();
    const dt = this.lastIngest ? clamp(t - this.lastIngest, 0, 250) : 0;
    this.lastIngest = t;
    this.lastPresent = !!frame.present;
    this.frame = frame;
    this.gaze = gaze;

    if (frame.present) {
      this.awaySince = 0;
      this.continuousMs += dt;
    } else if (!this.awaySince) {
      this.awaySince = t;
    }

    if (t - this.lastSampleAt >= 100) {
      this.lastSampleAt = t;
      const open = frame.present ? frame.open : 0;
      this.samples.push({
        t,
        open,
        valid: !!frame.present,
        dist: frame.distanceCm || 0,
        light: frame.lightLux || 0,
      });
      if (this.samples.length > MAX_SAMPLES) this.samples.splice(0, this.samples.length - MAX_SAMPLES);

      this.presence.push({ t, present: !!frame.present });
      if (this.presence.length > MAX_SAMPLES) this.presence.splice(0, this.presence.length - MAX_SAMPLES);

      this.gazes.push({
        t,
        x: gaze.nx || 0,
        y: gaze.ny || 0,
        valid: !!gaze.valid,
        outside: !!gaze.outside,
      });
      if (this.gazes.length > MAX_GAZES) this.gazes.splice(0, this.gazes.length - MAX_GAZES);

      if (gaze.valid && gaze.confidence > 0.35 && !gaze.outside) {
        const c = Math.min(HEAT_COLS - 1, Math.max(0, Math.floor((gaze.nx || 0) * HEAT_COLS)));
        const r = Math.min(HEAT_ROWS - 1, Math.max(0, Math.floor((gaze.ny || 0) * HEAT_ROWS)));
        this.heat[r * HEAT_COLS + c] += 1;
        this.heatTotal++;
      }
    }

    // 眨眼状态机
    if (frame.present) {
      const open = frame.open;
      if (open < 0.35) {
        if (!this.blinkStart) this.blinkStart = t;
      } else if (this.blinkStart) {
        const dur = t - this.blinkStart;
        this.blinkStart = 0;
        if (dur >= 45 && dur <= 900) {
          this.blinks.push({ t: t - dur / 2, dur });
          if (this.blinks.length > MAX_BLINKS) this.blinks.splice(0, this.blinks.length - MAX_BLINKS);
        }
      }
    } else {
      this.blinkStart = 0;
    }

    this.tick(t);
  }

  tick(now) {
    if (now - this.lastTick < 950) return;
    this.lastTick = now;

    // 离开超过 1 分钟视为自然休息
    if (this.awaySince && now - this.awaySince > 60000) {
      this.continuousMs = 0;
      this.awaySince = 0;
    }

    const perclos = computePerclos(this.samples, now, 60000);
    const blinkRate = computeBlinkRate(this.blinks, now, 60000);
    const { avgDur } = computeBlinkStats(this.blinks, now, 120000);
    const distance = computeDistance(this.samples, now, 5000);
    const light = computeLight(this.samples, now, 5000);
    const focus = computeFocus(this.gazes, now, 12000);
    const awayRatio = this.presenceRatio(now, 60000);
    const minutes = this.continuousMs / 60000;

    const fatigue = computeFatigue({
      perclos, blinkRate, blinkDur: avgDur, minutes, distance, awayRatio: 1 - awayRatio,
    });
    const health = computeHealthScore(fatigue.score, blinkRate);

    const metrics = {
      blinkRate,
      blinkDur: avgDur,
      perclos: Math.round(perclos * 1000) / 10,
      distance,
      light,
      focus: focus.score,
      fatigue: fatigue.score,
      health,
      minutes: Math.round(minutes * 10) / 10,
      awayRatio: 1 - awayRatio,
      reliable: awayRatio > 0.5 && this.samples.length > 80,
      level: levelOfHealth(health),
      ts: now,
    };
    this.metrics = metrics;

    if (now - this.lastSeriesAt >= 5000) {
      this.lastSeriesAt = now;
      this.series.push({
        t: now,
        blink: blinkRate,
        perclos: metrics.perclos,
        distance,
        light,
        fatigue: fatigue.score,
        focus: focus.score,
      });
      if (this.series.length > MAX_SERIES) this.series.splice(0, this.series.length - MAX_SERIES);
    }

    this.checkAlerts(now, metrics, focus);
    this.onMetrics(metrics, this);

    if (this.breakActive) {
      const elapsed = now - this.breakStart;
      if (now - this.breakLastCheck > 900) {
        const g = this.gaze;
        const lookingAway = !this.lastPresent || !g || !g.valid || g.outside;
        if (lookingAway) this.breakAwayMs += now - this.breakLastCheck;
        this.breakLastCheck = now;
      }
      if (elapsed >= 20000) this.endBreak(false);
    }
  }

  presenceRatio(now, winMs) {
    let total = 0, present = 0;
    for (let i = this.presence.length - 1; i >= 0; i--) {
      const p = this.presence[i];
      if (p.t < now - winMs) break;
      total++;
      if (p.present) present++;
    }
    return total ? present / total : 0;
  }

  maybeAlert(id, level, title, detail, actions = [], cooldownMs = 150000) {
    const now = Date.now();
    const until = this.alertCooldown.get(id) || 0;
    if (now < until) return null;
    this.alertCooldown.set(id, now + cooldownMs);
    const alert = { id, level, title, detail, actions, ts: now, time: fmtHM(now) };
    this.alerts.unshift(alert);
    if (this.alerts.length > 60) this.alerts.pop();
    this.onAlert(alert);
    return alert;
  }

  checkAlerts(now, m, focus) {
    const s = app.settings;
    if (!m.reliable) return;

    if (s.alertBlink && m.blinkRate > 0 && m.blinkRate < 8 && m.minutes > 1.2) {
      if (!this.blinkLowSince) this.blinkLowSince = now;
      if (now - this.blinkLowSince > 30000) {
        this.maybeAlert(
          'blink-low', 'warn', '眨眼频率过低',
          `最近一分钟只有 ${m.blinkRate} 次眨眼（个人基线 ${app.baseline.blink} 次）。长时间盯屏幕会让眨眼次数下降到平时的 1/3。`,
          ['现在做 10 次“用力闭眼—睁开”', '把视线移开屏幕 20 秒'],
          180000,
        );
      }
    } else {
      this.blinkLowSince = 0;
    }

    if (s.alertDistance && m.distance > 20 && m.distance < 42) {
      if (!this.distanceLowSince) this.distanceLowSince = now;
      if (now - this.distanceLowSince > 20000) {
        this.maybeAlert(
          'distance-near', 'warn', '你离屏幕太近了',
          `估算视距约 ${m.distance}cm，建议保持一臂距离（50–70cm）。距离过近会显著增加调节性视疲劳。`,
          ['把椅子向后推 10cm', '把屏幕后仰 10–20°'],
          180000,
        );
      }
    } else {
      this.distanceLowSince = 0;
    }

    if (s.alertLight && m.light > 0 && m.light < 60) {
      if (!this.lightLowSince) this.lightLowSince = now;
      if (now - this.lightLowSince > 25000) {
        this.maybeAlert(
          'light-low', 'warn', '环境光偏暗',
          `摄像头测得的相对照度只有 ${m.light}，屏幕与环境亮度差过大容易引起眩光和眼干。`,
          ['打开台灯或顶灯', '避免屏幕背对窗户形成强逆光'],
          240000,
        );
      }
    } else {
      this.lightLowSince = 0;
    }

    if (m.fatigue >= (s.fatigueThreshold || 65)) {
      this.maybeAlert(
        'fatigue-high', m.fatigue >= 80 ? 'bad' : 'warn', '疲劳指数偏高',
        `当前疲劳指数 ${m.fatigue}/100，闭眼占比 ${m.perclos}%。继续硬撑会让注意力和眨眼反射进一步下降。`,
        ['立刻远眺 20 秒', '起身活动 2 分钟再继续'],
        240000,
      );
    }

    if (m.perclos > 22) {
      this.maybeAlert(
        'perclos-high', 'bad', '检测到频繁的长时间闭眼',
        `过去一分钟有 ${m.perclos}% 的时间眼睛处于闭合状态，这是典型的困倦信号。`,
        ['用冷水洗把脸', '如果确实困了，睡 20 分钟比硬撑更有效'],
        300000,
      );
    }

    if (m.focus > 0 && m.focus < 45) {
      this.maybeAlert(
        'focus-low', 'info', '视线开始飘了',
        `专注度降到 ${m.focus}/100，视线频繁离开任务区域。可以试试 25 分钟番茄钟把注意力拉回来。`,
        ['打开专注番茄钟', '把手机翻面放远'],
        300000,
      );
    }

    if (s.alertBreak) {
      const limit = (s.breakMinutes || 20) * 60000;
      if (this.continuousMs > limit && !this.breakActive) {
        this.continuousMs = limit - 20000;
        this.startBreak('auto');
      }
    }
  }

  startBreak(source = 'manual') {
    if (this.breakActive) return false;
    this.breakActive = true;
    this.breakStart = Date.now();
    this.breakLastCheck = this.breakStart;
    this.breakAwayMs = 0;
    this.breakSource = source;
    this.onBreak({ type: 'start', source });
    return true;
  }

  endBreak(skipped = false) {
    if (!this.breakActive) return null;
    const duration = Date.now() - this.breakStart;
    const awayRatio = this.breakAwayMs / Math.max(1, duration);
    this.breakActive = false;
    this.continuousMs = 0;
    const result = { type: 'end', duration, awayRatio, skipped, source: this.breakSource };
    this.onBreak(result);
    return result;
  }

  breakElapsed() {
    return this.breakActive ? Date.now() - this.breakStart : 0;
  }

  totalBlinks() {
    return this.blinks.length;
  }

  snapshot() {
    return {
      generatedAt: new Date().toISOString(),
      metrics: this.metrics,
      series: this.series,
      alerts: this.alerts,
      heat: { cols: HEAT_COLS, rows: HEAT_ROWS, grid: Array.from(this.heat), total: this.heatTotal },
      session: {
        start: new Date(this.sessionStart).toISOString(),
        minutes: Math.round(this.continuousMs / 6000) / 10,
        blinks: this.blinks.length,
      },
    };
  }

  csv() {
    const head = 'time,blink_per_min,perclos_pct,distance_cm,light_rel,fatigue,focus\n';
    const rows = this.series.map((s) => [
      new Date(s.t).toISOString(), s.blink, s.perclos, s.distance, s.light, s.fatigue, s.focus,
    ].join(',')).join('\n');
    return head + rows;
  }
}
