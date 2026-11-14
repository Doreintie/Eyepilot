/* ============================================================
   plugins/game.js — 眼控训练：60 秒注视反应小游戏
   ============================================================ */

import { registerPlugin, pluginSvg } from '../plugins.js';
import { beep } from '../utils.js';

const W = 640;
const H = 360;
const ROUND_MS = 60000;
const TARGET_TIMEOUT = 3600;
const DWELL = 480;

registerPlugin({
  id: 'game',
  name: '眼控训练',
  tagline: 'Gaze reaction training',
  icon: pluginSvg.game,
  tags: ['训练', '游戏', '评估'],
  description: '60 秒注视训练：目标随机出现，盯住它直到进度环闭合。同时记录命中率与平均反应时，可作为眼控精度的日常自测。',
  mount(root, ctx) {
    root.innerHTML = `
      <div class="game-wrap">
        <div class="game-canvas-wrap"><canvas id="gameCanvas"></canvas></div>
        <div class="game-side">
          <div class="stat-box"><span>得分</span><b data-score>0</b></div>
          <div class="stat-box"><span>命中 / 出现</span><b data-hits>0 / 0</b><small data-acc>准确率 --</small></div>
          <div class="stat-box"><span>平均反应</span><b data-rt>--</b><small>毫秒</small></div>
          <div class="stat-box"><span>剩余时间</span><b data-time>60</b><small>秒</small></div>
          <button class="btn primary sm" data-restart data-gaze>重新开始</button>
        </div>
      </div>
      <p class="fine">目标出现后，把视线移到目标上并保持约 0.5 秒。这个练习同时训练眼球快速定位（扫视）和稳定注视能力，也是校准精度的直观检验。</p>`;

    const canvas = root.querySelector('#gameCanvas');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.aspectRatio = `${W} / ${H}`;
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);

    const ui = {
      score: root.querySelector('[data-score]'),
      hits: root.querySelector('[data-hits]'),
      acc: root.querySelector('[data-acc]'),
      rt: root.querySelector('[data-rt]'),
      time: root.querySelector('[data-time]'),
    };

    let state;
    const reset = () => {
      state = {
        running: true,
        ended: false,
        startedAt: performance.now(),
        last: performance.now(),
        score: 0,
        hits: 0,
        spawns: 0,
        rtSum: 0,
        target: null,
        nextSpawnAt: 0,
        gaze: { x: W / 2, y: H / 2, valid: false },
        pulse: 0,
      };
      spawn(performance.now() + 300);
      ctx.setStatus('训练中', 'on');
      updateUI();
    };

    const spawn = (at) => {
      state.target = null;
      state.nextSpawnAt = at;
    };

    const createTarget = () => {
      const margin = 56;
      state.target = {
        x: margin + Math.random() * (W - margin * 2),
        y: margin * 0.8 + Math.random() * (H - margin * 1.6),
        r: 25,
        bornAt: performance.now(),
        progress: 0,
      };
      state.spawns++;
    };

    const updateUI = () => {
      ui.score.textContent = String(state.score);
      ui.hits.textContent = `${state.hits} / ${state.spawns}`;
      ui.acc.textContent = `准确率 ${state.spawns ? Math.round((state.hits / state.spawns) * 100) : 0}%`;
      ui.rt.textContent = state.hits ? String(Math.round(state.rtSum / state.hits)) : '--';
      ui.time.textContent = String(Math.max(0, Math.ceil((ROUND_MS - (performance.now() - state.startedAt)) / 1000)));
    };

    const resetBtn = root.querySelector('[data-restart]');
    resetBtn.addEventListener('click', () => reset());

    const draw = () => {
      const now = performance.now();
      g.clearRect(0, 0, W, H);

      g.fillStyle = '#060b12';
      g.fillRect(0, 0, W, H);

      // 背景网格
      g.strokeStyle = 'rgba(46,230,214,.055)';
      g.lineWidth = 1;
      for (let x = 0; x <= W; x += 40) {
        g.beginPath(); g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, H); g.stroke();
      }
      for (let y = 0; y <= H; y += 40) {
        g.beginPath(); g.moveTo(0, y + 0.5); g.lineTo(W, y + 0.5); g.stroke();
      }

      // 视线准星
      const gz = state.gaze;
      if (gz.valid) {
        g.strokeStyle = 'rgba(124,156,255,.85)';
        g.lineWidth = 1.3;
        g.beginPath();
        g.arc(gz.x, gz.y, 12, 0, Math.PI * 2);
        g.stroke();
        g.beginPath();
        g.moveTo(gz.x - 18, gz.y); g.lineTo(gz.x - 6, gz.y);
        g.moveTo(gz.x + 6, gz.y); g.lineTo(gz.x + 18, gz.y);
        g.moveTo(gz.x, gz.y - 18); g.lineTo(gz.x, gz.y - 6);
        g.moveTo(gz.x, gz.y + 6); g.lineTo(gz.x, gz.y + 18);
        g.stroke();
        g.beginPath();
        g.arc(gz.x, gz.y, 2.4, 0, Math.PI * 2);
        g.fillStyle = '#7c9cff';
        g.fill();
      }

      const t = state.target;
      if (t) {
        const p = t.progress;
        const grad = g.createRadialGradient(t.x, t.y, 2, t.x, t.y, t.r);
        grad.addColorStop(0, 'rgba(46,230,214,.45)');
        grad.addColorStop(1, 'rgba(46,230,214,.06)');
        g.beginPath();
        g.arc(t.x, t.y, t.r, 0, Math.PI * 2);
        g.fillStyle = grad;
        g.fill();
        g.strokeStyle = 'rgba(46,230,214,.75)';
        g.lineWidth = 1.6;
        g.stroke();

        g.beginPath();
        g.arc(t.x, t.y, t.r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * p);
        g.strokeStyle = p > 0.7 ? '#7c9cff' : '#2ee6d6';
        g.lineWidth = 4;
        g.lineCap = 'round';
        g.stroke();

        g.beginPath();
        g.arc(t.x, t.y, t.r + 12, 0, Math.PI * 2);
        g.setLineDash([3, 6]);
        g.strokeStyle = 'rgba(124,156,255,.35)';
        g.lineWidth = 1;
        g.stroke();
        g.setLineDash([]);

        g.beginPath();
        g.arc(t.x, t.y, 3.5, 0, Math.PI * 2);
        g.fillStyle = '#ffffff';
        g.fill();
      }

      // HUD
      g.font = '600 15px ui-monospace, monospace';
      g.fillStyle = 'rgba(232,239,251,.85)';
      g.textAlign = 'left';
      g.fillText(`SCORE ${state.score}`, 18, 30);
      g.textAlign = 'right';
      g.fillStyle = 'rgba(139,155,182,.9)';
      g.fillText(`${Math.max(0, Math.ceil((ROUND_MS - (now - state.startedAt)) / 1000))}s`, W - 18, 30);

      if (state.ended) {
        g.fillStyle = 'rgba(4,7,12,.78)';
        g.fillRect(0, 0, W, H);
        g.textAlign = 'center';
        g.fillStyle = '#e8effb';
        g.font = '600 26px system-ui, sans-serif';
        g.fillText('训练结束', W / 2, H / 2 - 26);
        g.font = '13px system-ui, sans-serif';
        g.fillStyle = '#8b9bb6';
        const acc = state.spawns ? Math.round((state.hits / state.spawns) * 100) : 0;
        g.fillText(`得分 ${state.score} · 准确率 ${acc}% · 平均反应 ${state.hits ? Math.round(state.rtSum / state.hits) : '--'}ms`, W / 2, H / 2 + 8);
        g.fillStyle = 'rgba(46,230,214,.9)';
        g.fillText('点击右侧「重新开始」再来一轮', W / 2, H / 2 + 40);
      }
    };

    ctx.onFrame((frame, gaze) => {
      const now = performance.now();
      const dt = Math.min(60, now - state.last);
      state.last = now;

      if (state.running && !state.ended) {
        const elapsed = now - state.startedAt;
        if (elapsed >= ROUND_MS) {
          state.ended = true;
          state.target = null;
          ctx.setStatus('训练结束', 'warn');
          beep('good');
          updateUI();
        }
      }

      // 视线映射到画布
      const rect = canvas.getBoundingClientRect();
      if (gaze && gaze.valid) {
        state.gaze.valid = true;
        state.gaze.x = ((gaze.x - rect.left) / rect.width) * W;
        state.gaze.y = ((gaze.y - rect.top) / rect.height) * H;
      } else {
        state.gaze.valid = false;
      }

      if (!state.ended) {
        if (!state.target && now >= state.nextSpawnAt) createTarget();
        const t = state.target;
        if (t) {
          const over = state.gaze.valid && Math.hypot(state.gaze.x - t.x, state.gaze.y - t.y) < t.r + 6;
          t.progress = Math.max(0, Math.min(1, t.progress + (over ? dt / DWELL : -dt / 900)));
          if (t.progress >= 1) {
            state.score += 10;
            state.hits++;
            state.rtSum += now - t.bornAt;
            beep('good');
            spawn(now + 220);
            updateUI();
          } else if (now - t.bornAt > TARGET_TIMEOUT) {
            spawn(now + 160);
            updateUI();
          }
        }
        if (Math.floor(now / 250) !== Math.floor((now - dt) / 250)) updateUI();
      }

      draw();
    });

    reset();
    draw();
    ctx.onCleanup(() => { state.running = false; });
  },
});
