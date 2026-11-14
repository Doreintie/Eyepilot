/* ============================================================
   plugins/reader.js — 眼控阅读：注视下沿自动滚动
   ============================================================ */

import { registerPlugin, pluginSvg } from '../plugins.js';

const ARTICLE = `
<h2>当眼睛成为输入设备</h2>
<p class="hint-line">把视线移到文字区域下沿并停留，页面会自己往下走。</p>
<p>鼠标、键盘、触摸屏——过去五十年，人机交互的入口几乎都长在手上。但眼睛其实一直在工作：阅读一行字，视线会做 3 到 4 次跳跃式的“扫视”，每次停留 200 到 300 毫秒；看一张图，最先落点往往不是画面中心，而是人脸或高对比度的边缘。</p>
<p>眼动追踪要做的，就是把这套已经存在的信息通道，变成可用的输入信号。</p>
<h3>摄像头如何读懂视线</h3>
<p>普通笔记本摄像头没有红外发射器，拿不到角膜反光点，但依然能算出视线方向。方法是先找到眼睛，再找到虹膜：MediaPipe 的面部网格模型会在每一帧里给出 478 个三维关键点，其中 8 个点专门描述虹膜轮廓。虹膜中心相对眼角的位移，就是视线方向的近似——向左看时，虹膜会靠近鼻侧；向上看时，虹膜会靠近上眼睑。</p>
<p>这个近似并不完美：头一动，虹膜在眼框里的位置就变了。所以模型还会同时估计头部的偏航、俯仰和滚转，把它们和双眼的虹膜位移一起作为特征，交给下一步。</p>
<h3>从像素到屏幕：一次小小的回归</h3>
<p>真正把“眼睛在动”变成“光标在哪”，靠的是一次校准。屏幕上依次亮起九个点，你依次看过去；每一次注视都会产生一组特征向量和一个已知的屏幕坐标。用岭回归拟合这两者的映射，就得到一个属于你的、只属于这台设备的视线模型。</p>
<p>之所以用岭回归而不是深度网络，原因很实际：九个样本就能训练，CPU 上单帧预测不到 0.1 毫秒，而且可以完整解释——每个特征贡献了多少，一目了然。对一款需要实时运行在浏览器里的工具来说，这比多几个百分点的精度更重要。</p>
<h3>用眼健康：被忽略的那一半</h3>
<p>眼动追踪还有另一面：它不只告诉你“在看哪里”，还告诉你“怎么在看”。正常状态下人每分钟眨眼 15 到 20 次，盯着屏幕时会掉到 5 到 7 次；疲劳时会出现长时间闭眼，专业上叫 PERCLOS；离屏幕越来越近，往往是调节性疲劳的代偿动作。</p>
<p>这些信号不需要额外的硬件，摄像头本来就能看到。把眨眼频率、闭眼占比、估算视距、环境照度和注视稳定性放在一起，就能算出一个可解释的疲劳指数，并在你真的需要休息之前提醒你。</p>
<h3>隐私边界</h3>
<p>需要强调的一点是：所有视频帧都在这台设备的浏览器里由本地模型处理，没有一帧画面离开过这台电脑。写入本地存储的只有匿名化的数值指标，用来计算个人基线和趋势，随时可以一键清除。</p>
<p>眼睛是很私密的器官。任何涉及它的技术，都应该先把这条边界画清楚。</p>
<p class="hint-line">— 继续向下看，或把视线移回上方暂停滚动。</p>
`;

registerPlugin({
  id: 'reader',
  name: '眼控阅读',
  tagline: 'Hands-free reading',
  icon: pluginSvg.reader,
  tags: ['阅读', '无障碍', '长文'],
  description: '用视线控制长文滚动：注视文字区域下沿持续下滚，移回上半部分暂停。适合双手不便、边吃边看或需要保持坐姿的场景。',
  mount(root, ctx) {
    root.innerHTML = `
      <div class="reader-toolbar">
        <button class="btn ghost sm" data-act="smaller">A−</button>
        <button class="btn ghost sm" data-act="bigger">A+</button>
        <label class="switch-row" style="gap:8px;margin-left:6px">
          <span class="fine">自动滚动</span>
          <input type="checkbox" data-auto checked />
          <i class="switch"></i>
        </label>
        <span class="pill tiny" data-state>注视下沿开始</span>
      </div>
      <div class="reader-wrap">
        <div class="reader-pane" data-pane>${ARTICLE}</div>
        <div class="gaze-zone bottom"></div>
      </div>
      <p class="fine">提示：也可以只用眼睛把窗口停在某一段，AI 会持续记录你的注视位置。滚轮与键盘依然可用。</p>`;

    const pane = root.querySelector('[data-pane]');
    const stateEl = root.querySelector('[data-state]');
    const autoEl = root.querySelector('[data-auto]');
    let size = 14.5;
    let vel = 0;
    let last = performance.now();
    let auto = true;
    let lastState = '';

    const setState = (text) => {
      if (text === lastState) return;
      lastState = text;
      stateEl.textContent = text;
    };

    root.querySelector('[data-act="bigger"]').addEventListener('click', () => {
      size = Math.min(22, size + 1);
      pane.style.fontSize = `${size}px`;
    });
    root.querySelector('[data-act="smaller"]').addEventListener('click', () => {
      size = Math.max(12, size - 1);
      pane.style.fontSize = `${size}px`;
    });
    autoEl.addEventListener('change', () => { auto = autoEl.checked; });

    ctx.onFrame((frame, gaze) => {
      const now = performance.now();
      const dt = Math.min(80, now - last);
      last = now;
      const rect = pane.getBoundingClientRect();

      let target = 0;
      if (auto && gaze && gaze.valid && !gaze.outside) {
        const insideX = gaze.x > rect.left + 8 && gaze.x < rect.right - 8;
        const insideY = gaze.y > rect.top && gaze.y < rect.bottom + 24;
        if (insideX && insideY) {
          const rel = (gaze.y - rect.top) / rect.height;
          if (rel > 0.8) target = 5.2 * Math.min(1, (rel - 0.8) / 0.18);
          else if (rel < 0.14) target = -3.8 * Math.min(1, (0.14 - rel) / 0.14);
        }
      }
      vel += (target - vel) * 0.18;
      if (Math.abs(vel) > 0.03) {
        pane.scrollTop += vel * (dt / 16.7);
        setState(vel > 0.3 ? '正在自动滚动' : vel < -0.3 ? '向上回看' : '滚动中');
      } else {
        setState(auto ? (gaze && gaze.valid ? '注视下沿开始' : '等待视线') : '自动滚动已关闭');
      }
    });

    ctx.onCleanup(() => { vel = 0; });
  },
});
