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

export function initOnboarding({ setView } = {}) {
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
  };
  unlockView = typeof setView === 'function' ? setView : () => {};
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

/* ---------------- 3. 首次教程 ---------------- */

const STEPS = [
  {
    view: 'focus',
    title: '专注会话',
    text: '25 分钟一轮。眼睛离开屏幕、坐姿垮掉、眨眼变少，都会计入这一轮的分数——分数来自真实信号，不是预设动画。',
  },
  {
    view: 'eyecare',
    title: '护眼训练',
    text: '六节眼保健操，每节 20 秒，跟着做就行。下面还有 20-20-20、距离、光线、眨眼四张卡片。',
  },
  {
    view: 'console',
    title: '四种输入方式',
    text: '纯眼控 / 眼 + 鼠 / 眼 + 头 / 纯鼠标。鼠标永远可用：一动就让位，停手自动交还你的眼睛。',
  },
  {
    view: 'health',
    title: '数据都在本地',
    text: '摄像头画面只在这台电脑的内存里推理，不上传、不录制、不写磁盘。设置里可以随时关闭或清空。',
  },
  {
    view: null,
    title: '灵动岛',
    text: '桌面版屏幕顶部的小条：眨眼和专注剩余时间。点右侧箭头才展开，护眼提醒不会替你弹开、也不会挡屏幕。',
  },
];

let step = 0;
let tourOpen = false;

export function startTour(force = false) {
  if (!els.tour) return;
  if (!force && app.settings.tourDone) return;
  step = 0;
  tourOpen = true;
  els.tour.classList.add('open');
  paint();
}

export function maybeTour() {
  startTour(false);
}

export function openTour() {
  startTour(true);
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
  if (s.view) unlockView(s.view);
}

function closeTour() {
  if (!tourOpen) return;
  tourOpen = false;
  els.tour.classList.remove('open');
  saveSettings({ tourDone: true });
}

function bind() {
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
