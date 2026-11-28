/* ============================================================
   onboarding.js — 启动须知 / 摄像头授权 / 首次教程
   ------------------------------------------------------------
   三件事都由这里管，避免把隐私相关的逻辑散在 main.js 里：
   1) bootGate()   打开程序先看 1 秒须知（首次需点一下确认）
   2) askCamera()  真正调 getUserMedia 之前先问一次
   3) startTour()  首次使用的分步教程，可跳过、可重看
   ============================================================ */

import { app, saveSettings } from './store.js';

let els = {};
let unlockView = () => {};
let unlockPane = () => {};

export function initOnboarding({ setView, setPane } = {}) {
  const $ = (id) => document.getElementById(id);
  els = {
    boot: $('bootGate'),
    bootEnter: $('bootGateEnter'),
    bootTip: $('bootGateTip'),
    cam: $('cameraGate'),
    camAllow: $('cameraAllow'),
    camDeny: $('cameraDeny'),
    camRemember: $('cameraRemember'),
    tour: $('tourGate'),
    tourKicker: $('tourKicker'),
    tourTitle: $('tourTitle'),
    tourText: $('tourText'),
    tourDots: $('tourDots'),
    tourPrev: $('tourPrev'),
    tourNext: $('tourNext'),
    tourSkip: $('tourSkip'),
    tourSpot: $('tourSpot'),
    tourBubble: $('tourBubble'),
    tourArrow: $('tourArrow'),
  };
  unlockView = typeof setView === 'function' ? setView : () => {};
  unlockPane = typeof setPane === 'function' ? setPane : () => {};
  bind();
}

/* ---------------- 1. 启动须知 ---------------- */

export function bootGate() {
  return new Promise((resolve) => {
    if (!els.boot) { resolve(); return; }
    els.boot.classList.add('open');

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      els.boot.classList.add('out');
      setTimeout(() => els.boot.classList.remove('open', 'out'), 260);
      resolve();
    };

    const seen = !!app.settings.noticeSeen;
    els.bootEnter.disabled = true;
    els.bootEnter.textContent = '请稍候…';
    els.bootTip.textContent = '1 秒后可以进入';

    // 至少停留 1 秒，避免「一闪而过」等于没提示
    setTimeout(() => {
      if (closed) return;
      els.bootEnter.disabled = false;
      els.bootEnter.textContent = seen ? '进入 EyePilot' : '我已了解，进入 EyePilot';
      els.bootTip.textContent = '随时可以在「设置 → 数据与隐私」里重看';
      if (!seen) {
        // 首次停留，等人点一下；之后每次只停 1 秒
        els.bootEnter.addEventListener('click', () => {
          saveSettings({ noticeSeen: true });
          close();
        }, { once: true });
      }
    }, 1000);

    if (seen) setTimeout(close, 1100);
  });
}

/* ---------------- 2. 摄像头授权 ---------------- */

/**
 * 返回 true 表示可以调 getUserMedia。
 * 已经授权过的直接放行；拒绝过的保持拒绝，等用户主动点「重新授权」。
 */
export function askCamera() {
  const state = app.settings.cameraConsent || '';
  if (state === 'granted') return Promise.resolve(true);
  if (!els.cam) return Promise.resolve(true);

  return new Promise((resolve) => {
    els.cam.classList.add('open');
    if (els.camRemember) els.camRemember.checked = true;

    const finish = (ok) => {
      const remember = !els.camRemember || els.camRemember.checked;
      if (remember) saveSettings({ cameraConsent: ok ? 'granted' : 'denied' });
      els.cam.classList.remove('open');
      els.camAllow.removeEventListener('click', onAllow);
      els.camDeny.removeEventListener('click', onDeny);
      resolve(ok);
    };
    const onAllow = () => finish(true);
    const onDeny = () => finish(false);

    els.camAllow.addEventListener('click', onAllow);
    els.camDeny.addEventListener('click', onDeny);
  });
}

/** 撤销授权：下次调摄像头会重新询问 */
export function resetCameraConsent() {
  saveSettings({ cameraConsent: '' });
  setCameraLocked(false);
}

export function setCameraLocked(locked) {
  document.documentElement.classList.toggle('cam-locked', !!locked);
}

/* ---------------- 3. 首次教程：气泡指向具体位置 ---------------- */

const STEPS = [
  {
    view: 'focus',
    target: '#focusSessionRoot .fv-ring',
    title: '专注计时',
    text: '25 分钟一轮。点「开始专注」后，环形随剩余时间收缩；走完一轮会自动结算，并给出一份真实专注率。',
    place: 'bottom',
  },
  {
    view: 'focus',
    target: '#focusSessionRoot .fv-actions',
    title: '纸质 / 电脑两种场景',
    text: '纸质学习只按在座、眨眼与视距判定，不要求盯着屏幕；电脑学习会看视线是否离屏、是否长时间凝视。可随时暂停。',
    place: 'top',
  },
  {
    view: 'focus',
    target: '#focusSessionRoot .fv-tl',
    title: '时间轴',
    text: '最近 5 分钟，每格 5 秒。绿色是深度专注，琥珀与红色是分心；不用记曲线，扫一眼就知道刚才走神了多久。',
    place: 'top',
  },
  {
    view: 'eyecare',
    target: '[data-view="eyecare"]',
    title: '护眼训练',
    text: '六节眼保健操，每节 20 秒；下面还有 20-20-20、距离、光线、眨眼四张卡片。不需要摄像头。',
    place: 'right',
  },
  {
    view: 'console',
    target: '[data-view="console"]',
    title: '控制台与四种输入方式',
    text: '控制台里可以在「纯眼控 / 眼 + 鼠 / 眼 + 头 / 纯鼠标」之间切换。鼠标永远有效：一动就接管，停手后自动交还。',
    place: 'right',
  },
  {
    view: 'settings',
    target: '#btnRailMore',
    title: '设置都在「更多」里',
    text: '设置分七类：通用、健康提醒、眼控、灵动岛、外观、数据隐私、关于。想撤销摄像头授权，去「数据隐私」。',
    place: 'right',
  },
  {
    view: 'settings',
    pane: 'island',
    target: '#islandPreview',
    title: '灵动岛',
    text: '桌面版贴屏幕顶部的一条小面板：眨眼、视距、专注剩余时间，点箭头才展开。下面这条可以直接点着试。',
    place: 'top',
  },
];

let step = 0;
let tourOpen = false;

export function startTour(force = false) {
  if (!els.tour) return;
  if (!force && app.settings.tourDone) return;
  step = 0;
  tourOpen = true;
  els.tour.hidden = false;
  paint();
}

export function maybeTour() {
  startTour(false);
}

export function openTour() {
  startTour(true);
}

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function placeBubble(target) {
  const bubble = els.tourBubble;
  const spot = els.tourSpot;
  if (!bubble || !spot) return;
  if (!target) {
    spot.style.opacity = '0';
    bubble.style.left = '50%';
    bubble.style.top = '50%';
    bubble.style.transform = 'translate(-50%, -50%)';
    if (els.tourArrow) els.tourArrow.style.display = 'none';
    return;
  }
  const pad = 8;
  const r = target.getBoundingClientRect();
  spot.style.opacity = '1';
  spot.style.left = `${r.left - pad}px`;
  spot.style.top = `${r.top - pad}px`;
  spot.style.width = `${r.width + pad * 2}px`;
  spot.style.height = `${r.height + pad * 2}px`;

  const bw = bubble.offsetWidth || 300;
  const bh = bubble.offsetHeight || 170;
  const gap = 14;
  let x = clamp(r.left + r.width / 2 - bw / 2, 12, window.innerWidth - bw - 12);
  let y = r.bottom + gap;
  let arrow = 'top';
  if (y + bh > window.innerHeight - 12) {
    y = r.top - bh - gap;
    arrow = 'bottom';
  }
  if (y < 12) {
    y = clamp(r.top + r.height / 2 - bh / 2, 12, window.innerHeight - bh - 12);
    x = r.right + gap;
    if (x + bw > window.innerWidth - 12) x = r.left - bw - gap;
    arrow = x < r.left ? 'right' : 'left';
  }
  bubble.style.left = `${x}px`;
  bubble.style.top = `${y}px`;
  bubble.style.transform = 'none';

  const a = els.tourArrow;
  if (a) {
    a.style.display = 'block';
    a.className = `tour-arrow ${arrow}`;
    if (arrow === 'top' || arrow === 'bottom') {
      a.style.left = `${clamp(r.left + r.width / 2 - x - 7, 14, bw - 28)}px`;
      a.style.top = arrow === 'top' ? '-7px' : '';
      a.style.bottom = arrow === 'bottom' ? '-7px' : '';
    } else {
      a.style.top = `${clamp(r.top + r.height / 2 - y - 7, 14, bh - 28)}px`;
      a.style.left = arrow === 'left' ? '-7px' : '';
      a.style.right = arrow === 'right' ? '-7px' : '';
    }
  }
}

function measureAndPlace() {
  const s = STEPS[step];
  if (s.view) unlockView(s.view);
  if (s.pane) unlockPane(s.pane);
  requestAnimationFrame(() => {
    setTimeout(() => {
      const target = s.target ? document.querySelector(s.target) : null;
      if (target) {
        try { target.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch { /* noop */ }
      }
      placeBubble(target);
    }, s.pane ? 180 : 60);
  });
}

function paint() {
  const s = STEPS[step];
  if (els.tourKicker) els.tourKicker.textContent = `TOUR ${step + 1} / ${STEPS.length}`;
  if (els.tourTitle) els.tourTitle.textContent = s.title;
  if (els.tourText) els.tourText.textContent = s.text;
  if (els.tourPrev) els.tourPrev.disabled = step === 0;
  if (els.tourNext) els.tourNext.textContent = step === STEPS.length - 1 ? '开始使用' : '下一步';
  if (els.tourDots) {
    els.tourDots.innerHTML = STEPS.map((_, i) => `<i class="${i === step ? 'on' : ''}"></i>`).join('');
  }
  measureAndPlace();
}

function closeTour() {
  if (!tourOpen) return;
  tourOpen = false;
  els.tour.hidden = true;
  saveSettings({ tourDone: true });
  window.removeEventListener('resize', onResize);
}

const onResize = () => { if (tourOpen) measureAndPlace(); };

function bind() {
  window.addEventListener('resize', onResize);
  if (els.tourNext) {
    els.tourNext.addEventListener('click', () => {
      if (step < STEPS.length - 1) { step++; paint(); return; }
      closeTour();
    });
  }
  if (els.tourPrev) {
    els.tourPrev.addEventListener('click', () => {
      if (step > 0) { step--; paint(); }
    });
  }
  if (els.tourSkip) els.tourSkip.addEventListener('click', closeTour);
}
