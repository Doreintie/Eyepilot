/* ============================================================
   focus-session.js — 专注会话（一级视图）
   ------------------------------------------------------------
   由 demo-session.html 原型融合而来。原型里的分数 / 时间轴 / 洞察
   都是随机数演示；这里全部改由主程序推送的真实眼控帧与 app.metrics 计算。
   不重复加载 MediaPipe，也不重复开一路推理；摄像头预览只是画面回看。
   ============================================================ */

import { app } from './store.js';
import { beep, toast, download } from './utils.js';

const TOTAL = 25 * 60 * 1000;
const SLOT_MS = 5000;
const SLOTS = 60;
const C = 2 * Math.PI * 90;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const fmt = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const fmtCn = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
};

function level(score) {
  if (score >= 85) return { key: 'deep', color: 'var(--good)', label: '深度专注', tip: '状态很好，继续保持' };
  if (score >= 65) return { key: 'ok', color: 'var(--accent)', label: '正常专注', tip: '在轨道上' };
  if (score >= 40) return { key: 'warn', color: 'var(--warn)', label: '轻度分心', tip: '感觉你有点飘' };
  return { key: 'bad', color: 'var(--bad)', label: '明显分心', tip: '要不要先休息一下' };
}

/** 挂载到 index.html 的 <div id="focusSessionRoot">，返回帧入口给 main.js */
export function initFocusSession() {
  const root = document.getElementById('focusSessionRoot');
  if (!root) return { frame() {} };

  root.innerHTML = `
    <div class="fv-wrap">
      <div class="fv-bar">
        <div class="fv-seg" data-seg>
          <button class="on" data-scene="paper" data-gaze>纸质学习</button>
          <button data-scene="screen" data-gaze>电脑学习</button>
        </div>
        <span class="fv-chip" data-live><i class="fv-dot"></i><span data-live-tx>摄像头未启动</span></span>
      </div>

      <div class="fv-main">
        <section class="fv-glass fv-stage">
          <div class="fv-stage-head">
            <div>
              <div class="fv-eyebrow">Focus session</div>
              <h3>第 1 轮 · 25 分钟</h3>
              <p data-sub>纸质学习 · 看书 / 写字</p>
            </div>
          </div>

          <div class="fv-ringwrap"><div class="fv-ring">
            <svg viewBox="0 0 200 200" aria-hidden="true">
              <defs>
                <linearGradient id="fsGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stop-color="#5FE3B8" />
                  <stop offset="100%" stop-color="#69CBEF" />
                </linearGradient>
              </defs>
              <circle class="fv-ticks" cx="100" cy="100" r="90" />
              <circle class="fv-glow" data-glow cx="100" cy="100" r="90"
                      stroke-dasharray="${C}" stroke-dashoffset="0" />
              <circle class="bg" cx="100" cy="100" r="90" />
              <circle class="fg" data-arc cx="100" cy="100" r="90"
                      stroke-dasharray="${C}" stroke-dashoffset="0" />
            </svg>
            <div class="fv-ring-txt"><b data-time>25:00</b><span data-phase>专注 · 未开始</span></div>
          </div></div>

          <div class="fv-actions">
            <button class="fv-btn primary" data-start data-gaze>开始专注</button>
            <button class="fv-btn line" data-reset data-gaze>重置</button>
            <button class="fv-btn line" data-preview data-gaze>预览画面</button>
          </div>
          <p class="fv-note" data-note>纸质场景不要求视线留在屏幕上；判定来自在座状态、眨眼与视距。手写动作当前无法从人脸关键点识别，请勿据此判断书写。</p>
          <div class="fv-preview" data-preview-box><video data-video playsinline muted></video></div>
        </section>

        <aside class="fv-rail">
          <section class="fv-glass fv-pad fv-score-card">
            <div class="fv-card-h"><h3>当前状态</h3><span class="fv-tag">近 60 秒</span></div>
            <div class="fv-score">
              <b data-score>92</b><span>分</span>
              <div class="fv-level"><em data-level-tx>深度专注</em><p data-level-tip>状态很好，继续保持</p></div>
            </div>
            <div class="fv-metrics">
              <div><span>本次分心</span><b><span data-distract>0</span><u>次</u></b></div>
              <div><span>最长连续</span><b data-streak>00:00</b></div>
              <div><span data-away-label>离座</span><b data-away>00:00</b></div>
              <div><span data-pause-label>离座</span><b><span data-pause>0</span><u>次</u></b></div>
            </div>
          </section>
        </aside>
      </div>

      <section class="fv-glass fv-tl">
        <div class="fv-tl-h">
          <h3>专注时间轴</h3>
          <span class="fv-tl-note">最近 5 分钟 · 每格 5 秒</span>
          <div class="fv-legend">
            <span><i class="deep"></i>深度</span><span><i class="ok"></i>正常</span>
            <span><i class="warn"></i>轻度</span><span><i class="bad"></i>分心</span>
          </div>
        </div>
        <div class="fv-blocks" data-blocks>${'<i></i>'.repeat(SLOTS)}</div>
        <div class="fv-tl-foot"><span>− 5:00</span><span>现在</span></div>
      </section>

      <details class="fv-glass fv-more" data-more>
        <summary>
          <b>更多数据</b>
          <span>传感信号 · 一句结论 · 导出报告</span>
          <i class="fv-more-chev" aria-hidden="true"></i>
        </summary>
        <div class="fv-more-grid">
          <section class="fv-pad fv-signals-card">
            <div class="fv-card-h"><h3>传感信号</h3><span class="fv-tag" data-scene-tag>场景 A · 眼神不参与判定</span></div>
            <div class="fv-signals" data-signals></div>
          </section>
          <section class="fv-pad fv-insight">
            <div class="fv-card-h"><h3>一句结论</h3><span class="fv-tag" data-insight-src>等待数据</span></div>
            <p data-insight>开始会话后，这里会按真实信号给出归因，不会预置演示结论。</p>
          </section>
        </div>
        <div class="fv-foot">
          <span>信号在本地浏览器计算，不上传。纸质场景无法识别手部书写，仅按在座 / 生理信号估算。</span>
          <button class="fv-btn line" data-export data-gaze>导出会话报告</button>
        </div>
      </details>
    </div>`;

  const $ = (sel) => root.querySelector(sel);
  const arc = $('[data-arc]');
  const glow = $('[data-glow]');
  const timeEl = $('[data-time]');
  const phaseEl = $('[data-phase]');
  const noteEl = $('[data-note]');
  const startBtn = $('[data-start]');
  const resetBtn = $('[data-reset]');
  const previewBtn = $('[data-preview]');
  const exportBtn = $('[data-export]');
  const subEl = $('[data-sub]');
  const liveEl = $('[data-live]');
  const liveTx = $('[data-live-tx]');
  const livePill = document.getElementById('focusLivePill');
  const scoreEl = $('[data-score]');
  const levelTx = $('[data-level-tx]');
  const levelTip = $('[data-level-tip]');
  const distractEl = $('[data-distract]');
  const streakEl = $('[data-streak]');
  const awayEl = $('[data-away]');
  const pauseEl = $('[data-pause]');
  const awayLabel = $('[data-away-label]');
  const pauseLabel = $('[data-pause-label]');
  const sceneTag = $('[data-scene-tag]');
  const signalsEl = $('[data-signals]');
  const insightEl = $('[data-insight]');
  const insightSrc = $('[data-insight-src]');
  const blocksEl = $('[data-blocks]');
  const previewBox = $('[data-preview-box]');
  const video = $('[data-video]');

  const S = {
    remain: TOTAL,
    running: false,
    finished: false,
    scene: 'paper',
    score: 92,
    trackedMs: 0,
    offMs: 0,
    awayMs: 0,
    distractions: 0,
    pauseCount: 0,
    streak: 0,
    streakMax: 0,
    gazeState: 'stable',
    gazeRef: null,
    gazeStillMs: 0,
    lastDistractAt: 0,
    lastTickAt: performance.now(),
    lastFrameAt: performance.now(),
    slots: Array(SLOTS).fill(''),
    slotIdx: 0,
    scores: [],
    blink: 0,
    distance: 0,
    reliable: false,
    frame: null,
    gaze: null,
  };

  let previewStream = null;

  const note = (text) => { noteEl.textContent = text; };
  const setLive = (text) => {
    if (liveTx) liveTx.textContent = text;
    else liveEl.textContent = text;
  };
  const setPill = (text, state) => {
    if (!livePill) return;
    livePill.className = `pill tiny${state ? ` ${state}` : ''}`;
    livePill.innerHTML = `<i class="dot"></i>${text}`;
  };

  const paint = () => {
    const lv = level(S.score);
    timeEl.textContent = fmt(S.remain);
    const offset = String(C * (1 - S.remain / TOTAL));
    arc.style.strokeDashoffset = offset;
    glow.style.strokeDashoffset = offset;
    arc.style.stroke = S.finished ? 'var(--good)' : S.remain < 60000 ? 'var(--warn)' : 'url(#fsGrad)';
    phaseEl.textContent = S.finished ? '本轮完成' : S.running ? '专注中' : S.remain < TOTAL ? '已暂停' : '专注 · 未开始';
    startBtn.textContent = S.finished ? '再来一轮' : S.running ? '暂停' : S.remain < TOTAL ? '继续' : '开始专注';

    scoreEl.textContent = String(Math.round(S.score));
    levelTx.textContent = lv.label;
    levelTx.style.color = lv.color;
    levelTip.textContent = lv.tip;
    distractEl.textContent = String(S.distractions);
    streakEl.textContent = fmt(S.streakMax * 1000);
    awayEl.textContent = fmt(S.awayMs);
    pauseEl.textContent = String(S.pauseCount);
  };

  const renderTimeline = () => {
    const kids = blocksEl.children;
    const last = Math.min(SLOTS - 1, Math.max(0, S.slotIdx - 1));
    for (let i = 0; i < SLOTS; i++) {
      kids[i].className = S.slots[i] || '';
      if (i === last && S.slotIdx > 0) kids[i].classList.add('now');
    }
  };

  const renderSignals = () => {
    const { frame, gaze } = S;
    const dash = '—';
    const rows = [];

    if (S.scene === 'paper') {
      const present = !!(frame && frame.present);
      rows.push({
        icon: '◉', name: '在座状态',
        desc: present ? '检测到人脸，判定为在座' : '未检测到人脸，按离座处理',
        val: present ? '在座' : '离座',
        cls: present ? '' : 'hot',
      });
      const pitch = frame && Number.isFinite(frame.pitchDeg) ? Math.round(frame.pitchDeg) : null;
      rows.push({
        icon: '⌄', name: '头姿（参考）',
        desc: '相对正脸的角度，仅展示不参与判定',
        val: pitch === null ? dash : `${pitch}°`,
        cls: '',
      });
    } else {
      const valid = !!(gaze && gaze.valid && !gaze.outside);
      const gLabel = !valid ? '未识别' : S.gazeState === 'stare' ? '凝固' : S.gazeState === 'drift' ? '偏移' : '稳定';
      rows.push({
        icon: '◎', name: '视线',
        desc: valid
          ? (S.gazeState === 'stare' ? '超过 8 秒无明显扫视，疑似盯着不读' : '视线在屏幕内')
          : '视线离屏或置信度不足',
        val: gLabel,
        cls: !valid || S.gazeState === 'drift' ? 'hot' : S.gazeState === 'stare' ? 'cool' : '',
      });
      const yaw = frame && Number.isFinite(frame.yawDeg) ? Math.round(frame.yawDeg) : null;
      rows.push({
        icon: '⌄', name: '头姿',
        desc: '相对正脸的偏航 / 俯仰',
        val: yaw === null ? dash : `${yaw}° / ${Math.round(frame.pitchDeg || 0)}°`,
        cls: '',
      });
    }

    const m = app.metrics || {};
    const blink = S.reliable && S.blink > 0 ? Math.round(S.blink) : dash;
    const dist = S.distance > 0 ? Math.round(S.distance) : dash;
    rows.push({
      icon: '◡', name: '眨眼',
      desc: S.blink > 0 && S.blink < 10 ? '低于 10 次/分，注意干眼' : '节奏参考值',
      val: blink === dash ? dash : `${blink} / 分`,
      cls: S.blink > 0 && S.blink < 10 ? 'hot' : '',
    });
    rows.push({
      icon: '⇔', name: '视距',
      desc: S.distance > 0 && S.distance < 42 ? '过近，建议后仰一点' : '几何估算，按相对变化理解',
      val: dist === dash ? dash : `${dist} cm`,
      cls: S.distance > 0 && S.distance < 42 ? 'hot' : '',
    });

    signalsEl.innerHTML = rows.map((r) => `
      <div class="fv-sig ${r.cls}">
        <div class="fv-sig-ico">${r.icon}</div>
        <div class="fv-sig-tx"><b>${r.name}</b><p>${r.desc}</p></div>
        <div class="fv-sig-v">${r.val}</div>
      </div>`).join('');

    if (S.running) {
      setLive('专注计时中');
      setPill('正在记录', 'on');
    } else if (S.finished) {
      setLive('本轮完成');
      setPill('本轮完成', 'on');
    } else if (S.remain < TOTAL) {
      setLive('已暂停');
      setPill('已暂停', 'warn');
    } else {
      const present = !!(frame && frame.present);
      if (present) {
        setLive('摄像头已就绪');
        setPill('摄像头已就绪', 'on');
      } else if (frame) {
        setLive('等待人脸入镜');
        setPill('等待人脸入镜', 'warn');
      } else {
        setLive('摄像头未启动');
        setPill('摄像头未启动', '');
      }
    }
  };

  const buildInsight = () => {
    if (S.trackedMs < 30000) {
      insightSrc.textContent = '等待数据';
      insightEl.textContent = '会话刚开始，继续积累真实信号后这里会给出归因，不会预置演示结论。';
      return;
    }
    const avg = S.scores.length
      ? Math.round(S.scores.reduce((a, b) => a + b, 0) / S.scores.length)
      : Math.round(S.score);
    const worst = Array(5).fill(0);
    S.slots.forEach((k, i) => {
      if (k === 'warn' || k === 'bad') worst[Math.floor(i / 12)]++;
    });
    const minute = worst.indexOf(Math.max(...worst)) + 1;
    const cause = S.scene === 'paper'
      ? '离座或眨眼明显下降'
      : '视线离屏或长时间凝视不读';
    insightSrc.textContent = '归因 · 真实信号';
    insightEl.textContent = `本次分心主要集中在第 ${minute} 分钟附近，常伴随${cause}；` +
      `已记录 ${S.distractions} 次分心，最近平均专注分 ${avg}。` +
      (S.scene === 'paper' ? '纸质场景不识别手写动作，以上仅基于在座与生理信号。' : '');
  };

  const recordSlot = () => {
    const idx = S.slotIdx % SLOTS;
    S.slots[idx] = level(S.score).key;
    S.slotIdx++;
    renderTimeline();
    if (S.slotIdx % 12 === 0) buildInsight();
  };

  const rate = () => (S.trackedMs ? Math.round(((S.trackedMs - S.awayMs) / S.trackedMs) * 100) : 0);

  const finish = () => {
    S.remain = 0;
    S.running = false;
    S.finished = true;
    const ratePct = rate();
    setLive('本轮完成');
    beep('break');
    toast('专注会话完成', `真实专注率 ${ratePct}%，分心 ${S.distractions} 次`, 'good');
    note(`完成一轮。真实专注率 ${ratePct}%，分心 ${S.distractions} 次，最长连续 ${fmtCn(S.streakMax * 1000)}。`);
    buildInsight();
    paint();
  };

  const tick = () => {
    const now = performance.now();
    const dt = Math.min(1200, now - S.lastTickAt);
    S.lastTickAt = now;
    if (!S.running) return;
    S.remain -= dt;
    if (S.remain <= 0) { finish(); return; }
    paint();
  };

  const reset = () => {
    S.running = false;
    S.finished = false;
    S.remain = TOTAL;
    S.trackedMs = 0;
    S.offMs = 0;
    S.awayMs = 0;
    S.distractions = 0;
    S.pauseCount = 0;
    S.streak = 0;
    S.streakMax = 0;
    S.gazeRef = null;
    S.gazeStillMs = 0;
    S.slots = Array(SLOTS).fill('');
    S.slotIdx = 0;
    S.scores = [];
    S.score = 92;
    setLive('未开始');
    note('已重置。' + (S.scene === 'paper'
      ? '纸质场景按在座 / 眨眼 / 视距判定，手写动作无法识别。'
      : '电脑场景按视线离屏与凝视不读判定。'));
    renderTimeline();
    buildInsight();
    paint();
  };

  let slotAccMs = 0;

  const onFrame = (frame, gaze) => {
    const now = performance.now();
    const dt = Math.min(200, now - S.lastFrameAt);
    S.lastFrameAt = now;
    S.frame = frame || null;
    S.gaze = gaze || null;

    const m = app.metrics || {};
    S.blink = Number(m.blinkRate) || 0;
    S.distance = Number(m.distance) || 0;
    S.reliable = !!m.reliable;

    if (!S.running) return;

    S.trackedMs += dt;
    const present = !!(frame && frame.present);
    const blinking = !!(frame && Number.isFinite(frame.open) && frame.open < 0.25);
    let onTask = false;

    if (S.scene === 'screen') {
      const valid = !!(gaze && gaze.valid && !gaze.outside);
      onTask = valid;
      if (valid) {
        const nx = Number.isFinite(gaze.nx) ? gaze.nx : gaze.x / window.innerWidth;
        const ny = Number.isFinite(gaze.ny) ? gaze.ny : gaze.y / window.innerHeight;
        if (!S.gazeRef || Math.hypot(nx - S.gazeRef.x, ny - S.gazeRef.y) > 0.012) {
          S.gazeRef = { x: nx, y: ny };
          S.gazeStillMs = 0;
          S.gazeState = 'stable';
        } else {
          S.gazeStillMs += dt;
          if (S.gazeStillMs > 8000) S.gazeState = 'stare';
        }
      } else {
        S.gazeState = 'drift';
        S.gazeStillMs = 0;
      }
    } else {
      onTask = present;
    }

    if (blinking && S.scene === 'screen') {
      // 眨眼期间 gaze.valid 会短暂为 false，不按离屏累计
      S.streak += dt / 1000;
    } else if (onTask) {
      S.offMs = Math.max(0, S.offMs - dt * 1.5);
      S.streak += dt / 1000;
    } else {
      S.offMs += dt;
      S.awayMs += dt;
      S.streak = 0;
    }
    S.streakMax = Math.max(S.streakMax, S.streak);

    if (S.offMs > 6000 && now - S.lastDistractAt > 20000) {
      S.lastDistractAt = now;
      S.distractions++;
      S.pauseCount++;
      S.offMs = 0;
      beep('warn');
      note(`第 ${S.distractions} 次${S.scene === 'paper' ? '离座' : '离屏'}已记录，把注意力拉回当前任务。`);
    }

    let target = S.scene === 'paper' ? 92 : (Number(m.focus) > 0 ? Number(m.focus) : 90);
    if (S.scene === 'screen' && S.gazeState === 'stare') target -= 12;
    if (S.blink > 0 && S.blink < 8) target -= 10;
    if (S.distance > 0 && S.distance < 42) target -= 8;
    if (!present) target -= 28;
    if (S.offMs > 2000) target -= 18;
    target = clamp(target, 20, 99);
    S.score += (target - S.score) * Math.min(1, dt / 700);
    S.score = clamp(S.score, 20, 99);

    slotAccMs += dt;
    if (slotAccMs >= SLOT_MS) {
      slotAccMs -= SLOT_MS;
      S.scores.push(Math.round(S.score));
      if (S.scores.length > 300) S.scores.shift();
      recordSlot();
    }
  };

  startBtn.addEventListener('click', () => {
    if (S.finished) reset();
    S.running = !S.running;
    S.lastTickAt = performance.now();
    S.lastFrameAt = performance.now();
    if (S.running) {
      setLive('专注计时中');
      note(S.scene === 'paper'
        ? '纸质场景已开始。视线可以离开屏幕，判定来自在座状态、眨眼与视距。'
        : '电脑场景已开始。视线离开屏幕超过 6 秒会记一次分心。');
    } else {
      setLive('已暂停');
      note('已暂停，暂停期间不记分心。');
    }
    paint();
  });

  resetBtn.addEventListener('click', reset);

  $('[data-seg]').addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-scene]');
    if (!btn || btn.dataset.scene === S.scene) return;
    [...$('[data-seg]').children].forEach((b) => b.classList.remove('on'));
    btn.classList.add('on');
    S.scene = btn.dataset.scene;
    S.gazeRef = null;
    S.gazeStillMs = 0;
    S.offMs = 0;
    const paper = S.scene === 'paper';
    subEl.textContent = paper ? '纸质学习 · 看书 / 写字' : '电脑学习 · 看网课 / 刷题';
    sceneTag.textContent = paper ? '场景 A · 眼神不参与判定' : '场景 B · 眼神参与判定';
    awayLabel.textContent = paper ? '离座' : '离屏';
    pauseLabel.textContent = paper ? '离座' : '离屏';
    note(paper
      ? '已切换纸质学习。手写动作无法从人脸关键点识别，只按在座与生理信号估算。'
      : '已切换电脑学习。视线离屏或长时间凝视会被记录。');
    toast(paper ? '已切换到纸质学习' : '已切换到电脑学习', paper ? '眼神判定关闭' : '眼神判定启用', 'info', 2200);
    renderSignals();
    paint();
  });

  const stopPreview = () => {
    if (!previewStream) return;
    previewStream.getTracks().forEach((t) => t.stop());
    previewStream = null;
    video.srcObject = null;
    previewBox.classList.remove('on');
    previewBtn.textContent = '预览画面';
  };

  previewBtn.addEventListener('click', async () => {
    if (previewStream) { stopPreview(); return; }
    try {
      previewStream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
      video.srcObject = previewStream;
      await video.play();
      previewBox.classList.add('on');
      previewBtn.textContent = '关闭预览';
      toast('画面预览已开启', '分析仍复用主程序的眼控结果，不会重复推理', 'info', 2600);
    } catch (err) {
      previewStream = null;
      console.warn(err);
      toast('预览未能开启', '检查摄像头权限，或先在主界面启动相机', 'warn', 3000);
    }
  });

  exportBtn.addEventListener('click', () => {
    const ratePct = rate();
    const avg = S.scores.length
      ? Math.round(S.scores.reduce((a, b) => a + b, 0) / S.scores.length) : Math.round(S.score);
    const sceneName = S.scene === 'paper' ? '纸质学习' : '电脑学习';
    const md = [
      '# EyePilot 专注会话报告',
      '',
      `- 生成时间：${new Date().toLocaleString('zh-CN')}`,
      `- 场景：${sceneName}`,
      `- 时长：${fmtCn(TOTAL - S.remain)} / 25 分钟`,
      `- 真实专注率：${ratePct}%`,
      `- 分心次数：${S.distractions}`,
      `- 离座/离屏累计：${fmtCn(S.awayMs)}`,
      `- 最长连续专注：${fmtCn(S.streakMax * 1000)}`,
      `- 平均专注分：${avg}`,
      '',
      '## 最近 5 分钟时间轴',
      '',
      S.slots.map((k, i) => (k ? `${i * 5}s ${k}` : '')).filter(Boolean).join(' · ') || '（尚无数据）',
      '',
      '## 说明',
      '',
      S.scene === 'paper'
        ? '纸质学习场景不识别手写动作；判定基于在座状态、眨眼频率与几何估算视距。'
        : '电脑学习场景基于视线是否在屏幕内、是否存在长时间凝视，以及眨眼与视距信号。',
      '视距为单目几何估算，只适合看相对变化；本报告为行为学估算，不构成医疗诊断。',
      '',
    ].join('\n');
    download(`EyePilot-专注会话-${new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '')}.md`, md, 'text/markdown;charset=utf-8');
    toast('报告已导出', 'Markdown 文件已开始下载', 'good', 2600);
  });

  setInterval(tick, 250);
  setInterval(paint, 400);
  setInterval(renderSignals, 900);
  window.addEventListener('pagehide', stopPreview);

  renderTimeline();
  renderSignals();
  buildInsight();
  paint();

  // 给灵动岛用的一份只读快照（不暴露内部状态，避免被乱改）
  const snapshot = () => ({
    running: S.running,
    finished: S.finished,
    score: Math.round(S.score),
    remain: Math.max(0, Math.round(S.remain / 1000)),
    total: Math.round(TOTAL / 1000),
    scene: S.scene,
    label: level(S.score).label,
    streakMin: Math.round(S.streak / 60000),
  });

  return { frame: onFrame, snapshot };
}
