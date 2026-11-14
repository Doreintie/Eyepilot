/* ============================================================
   plugins/focus.js — 眼控番茄钟：走神即提醒
   ============================================================ */

import { registerPlugin, pluginSvg } from '../plugins.js';
import { beep, toast } from '../utils.js';

const FOCUS_MS = 25 * 60 * 1000;
const C = 2 * Math.PI * 90;

registerPlugin({
  id: 'focus',
  name: '专注番茄钟',
  tagline: 'Gaze-aware pomodoro',
  icon: pluginSvg.focus,
  tags: ['专注', '番茄钟', '行为反馈'],
  description: '25 分钟专注计时，用视线判断你是否还在任务上：视线离开窗口超过 6 秒就记一次走神，并在结束时给出真实专注率。',
  mount(root, ctx) {
    root.innerHTML = `
      <div class="pomo">
        <div class="pomo-ring">
          <svg viewBox="0 0 200 200">
            <circle class="bg" cx="100" cy="100" r="90" />
            <circle class="fg" data-arc cx="100" cy="100" r="90" stroke-dasharray="${C}" stroke-dashoffset="0" />
          </svg>
          <div class="pomo-txt"><b data-time>25:00</b><span data-phase>专注 · 未开始</span></div>
        </div>
        <div class="pomo-actions">
          <button class="btn primary" data-start data-gaze>开始专注</button>
          <button class="btn ghost" data-reset data-gaze>重置</button>
        </div>
        <p class="pomo-note" data-note>开始后，视线离开这个窗口超过 6 秒会被记为一次走神。</p>
        <div class="pomo-bars">
          <div class="stat-box"><span>实时专注度</span><b data-focus>--</b></div>
          <div class="stat-box"><span>走神次数</span><b data-distract>0</b><small data-rate>专注率 --</small></div>
        </div>
      </div>
      <p class="fine">番茄钟的价值不在计时，而在“只做一件事”的承诺。这里的特别之处是：它用视线而不是自述来判断你有没有走神。</p>`;

    const arc = root.querySelector('[data-arc]');
    const timeEl = root.querySelector('[data-time]');
    const phaseEl = root.querySelector('[data-phase]');
    const noteEl = root.querySelector('[data-note]');
    const startBtn = root.querySelector('[data-start]');
    const resetBtn = root.querySelector('[data-reset]');
    const focusEl = root.querySelector('[data-focus]');
    const distractEl = root.querySelector('[data-distract]');
    const rateEl = root.querySelector('[data-rate]');

    let remain = FOCUS_MS;
    let running = false;
    let finished = false;
    let lastTick = performance.now();
    let offMs = 0;
    let distractions = 0;
    let lastDistractAt = 0;
    let trackedMs = 0;
    let awayMs = 0;
    let lastFrameAt = performance.now();

    const fmt = (ms) => {
      const s = Math.max(0, Math.ceil(ms / 1000));
      return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    };

    const paint = () => {
      timeEl.textContent = fmt(remain);
      const progress = 1 - remain / FOCUS_MS;
      arc.style.strokeDashoffset = String(C * progress);
      arc.style.stroke = finished ? 'var(--good)' : remain < 60000 ? 'var(--warn)' : 'var(--accent)';
      phaseEl.textContent = finished ? '本轮完成' : running ? '专注中' : remain < FOCUS_MS ? '已暂停' : '专注 · 未开始';
      startBtn.textContent = finished ? '再来一轮' : running ? '暂停' : remain < FOCUS_MS ? '继续' : '开始专注';
    };

    const setNote = (text) => { noteEl.textContent = text; };

    const tick = () => {
      const now = performance.now();
      const dt = Math.min(1200, now - lastTick);
      lastTick = now;
      if (!running) return;
      remain -= dt;
      if (remain <= 0) {
        remain = 0;
        running = false;
        finished = true;
        ctx.setStatus('本轮完成', 'on');
        beep('break');
        toast('番茄钟完成', '25 分钟专注结束，站起来走两步', 'good');
        arc.style.strokeDashoffset = String(C);
        const rate = trackedMs ? Math.round(((trackedMs - awayMs) / trackedMs) * 100) : 0;
        setNote(`完成一轮。真实专注率 ${rate}%，走神 ${distractions} 次。现在应该休息 5 分钟。`);
        paint();
        return;
      }
      paint();
    };

    const interval = setInterval(tick, 250);

    startBtn.addEventListener('click', () => {
      if (finished) {
        remain = FOCUS_MS;
        finished = false;
        distractions = 0;
        awayMs = 0;
        trackedMs = 0;
        distractEl.textContent = '0';
        rateEl.textContent = '专注率 --';
      }
      running = !running;
      lastTick = performance.now();
      if (running) {
        ctx.setStatus('专注计时中', 'on');
        setNote('保持视线在这个窗口内，计时会正常累积；离开超过 6 秒会记一次走神。');
      } else {
        ctx.setStatus('已暂停', 'warn');
        setNote('已暂停。你可以随时继续。');
      }
      paint();
    });

    resetBtn.addEventListener('click', () => {
      running = false;
      finished = false;
      remain = FOCUS_MS;
      distractions = 0;
      awayMs = 0;
      trackedMs = 0;
      distractEl.textContent = '0';
      rateEl.textContent = '专注率 --';
      ctx.setStatus('未开始', 'on');
      setNote('已重置。开始后，视线离开这个窗口超过 6 秒会被记为一次走神。');
      paint();
    });

    ctx.onFrame((frame, gaze) => {
      const m = ctx.getMetrics();
      if (m && m.focus) focusEl.textContent = `${m.focus}`;

      const now = performance.now();
      const dt = Math.min(120, now - lastFrameAt);
      lastFrameAt = now;
      if (!running) return;

      trackedMs += dt;
      const rect = root.getBoundingClientRect();
      const inside = gaze && gaze.valid && !gaze.outside
        && gaze.x > rect.left && gaze.x < rect.right
        && gaze.y > rect.top && gaze.y < rect.bottom;

      if (inside) {
        offMs = Math.max(0, offMs - dt);
      } else {
        offMs += dt;
        awayMs += dt;
      }

      if (offMs > 6000 && now - lastDistractAt > 20000) {
        lastDistractAt = now;
        distractions++;
        offMs = 0;
        distractEl.textContent = String(distractions);
        beep('warn');
        setNote(`视线离开 6 秒以上，已记录第 ${distractions} 次走神。把注意力拉回当前任务。`);
      }

      const rate = trackedMs ? Math.round(((trackedMs - awayMs) / trackedMs) * 100) : 0;
      rateEl.textContent = trackedMs > 3000 ? `专注率 ${rate}%` : '专注率 --';
    });

    ctx.onCleanup(() => clearInterval(interval));
    paint();
  },
});
