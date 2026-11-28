/* ============================================================
   help.js — 帮助中心
   ------------------------------------------------------------
   一份 FAQ，覆盖「第一次用 → 眼控 → 专注/护眼 → 隐私 → 插件」全流程。
   用侧栏的问号按钮打开；专注会话页的提示图标会直接定位到评分说明。
   ============================================================ */

const SECTIONS = [
  {
    id: 'start',
    title: '开始使用',
    items: [
      ['打开程序后先看到什么？', '先是 1 秒使用须知，然后是 5 步使用教程（可跳过）。之后点「启动相机」才会询问摄像头授权，允许才开启眼控。'],
      ['电脑没有摄像头，还能用吗？', '能。计时、专注会话、护眼操、用眼提醒都不依赖摄像头；眼控与疲劳分析需要摄像头，也可以直接用手机当摄像头。'],
      ['摄像头打不开 / 打开了是黑的？', '先用 Windows 自带「相机」应用试一下：也是黑的说明是系统或硬件问题。如果自带相机正常，多半是选到了虚拟摄像头（OBS、会议软件），到 设置 → 眼控 → 摄像头 换一个设备。'],
      ['手机怎么当摄像头？', '手机和电脑连同一个 Wi-Fi（电脑别开 VPN）→ 侧栏「更多 → 手机摄像头」→ 设置里会显示二维码 → 手机相机扫码 → 浏览器提示「连接不是私密连接」时点「高级 → 继续前往」→ 点「开始推流」，并保持页面在前台。'],
      ['二维码扫不出来 / 复制地址失败？', '二维码是本地生成的，不联网。扫不出来就点「复制地址」；浏览器拒绝剪贴板时地址会被自动选中，按 Ctrl+C 即可。也可以直接在手机浏览器手输上面的地址。'],
      ['左下角「更多」里有什么？', '三个次要入口：插件中心、手机摄像头、设置。手机摄像头不是普通跳转，它会直接打开「手机双摄」这张卡并闪一下，省得你在设置里翻类目。'],
      ['窗口缩小后界面挤在一起？', 'v1.7.0 起设置页按类目分栏，窄窗口会自动变成横向类目 + 单列内容；如果仍不好看，把窗口拉宽或在系统里调低显示缩放。'],
    ],
  },
  {
    id: 'eye',
    title: '眼控',
    items: [
      ['校准总是「样本太少」怎么办？', '脸离屏幕 50–65 cm，占画面宽度约 1/3；背后不要有强光；校准过程中别低头或转头。'],
      ['光标一直在抖？', '设置 → 眼控 → 平滑强度调到 70–85（越大越稳、跟随稍慢）。也可以改用「眼 + 头」模式。'],
      ['光标整体偏上/偏下？', '设置 → 眼控 → 视线微调 → 五点精细对齐（约 10 秒）。「眼 + 头」模式点「重新归中」即可。'],
      ['为什么鼠标一动，眼控就停了？', '这是刻意的：鼠标永远优先，一动就让位，停手 1.2 秒（眼 + 鼠模式 0.3 秒）后交还眼睛，避免两个指针互抢。'],
      ['四种输入方式怎么选？', '纯眼控最精细但要校准；眼 + 鼠适合日常（鼠标随时接管）；眼 + 头不用校准、头定方向虹膜精修；纯鼠标只保留护眼监测。'],
      ['注视点击总是点不中？', '打开顶栏「大按钮」；或把设置里的「注视点击时长」从 800ms 调到 1100ms，给瞄准留时间。'],
    ],
  },
  {
    id: 'focus',
    title: '专注与护眼',
    items: [
      ['专注分是怎么算的？', '基准是实时专注度（无数据时按 90）。扣分项：盯住不动 −12、眨眼低于 8 次/分 −10、视距小于 42cm −8、人脸离开画面 −28、离屏超过 2 秒 −18。分数限制在 20–99，并按 0.7 秒时间常数平滑，每 5 秒记一格。等级：≥85 深度专注、≥65 正常、≥40 轻度分心、低于 40 分心。'],
      ['什么算一次「分心」？', '视线离开屏幕超过 6 秒记一次，两次之间至少间隔 20 秒；人脸完全离开画面也按离屏累计。'],
      ['分数一开始就是 92，正常吗？', '正常。那是初始值，开始专注后才会被真实信号逐步拉向实际状态；没开摄像头时不会有波动。'],
      ['PERCLOS 是什么意思？', 'PERCLOS = 眼睛闭合时间占比（Percentage of Eyelid Closure over the Pupil over Time）。统计窗口内眼睛闭合超过 80% 的时间越长，这个值越高，是疲劳研究里的经典指标。本程序用 1 分钟滑动窗口估算，长时间偏高时灵动岛也会提示。'],
      ['提醒太频繁 / 太吵？', '设置 → 健康提醒，可分别关掉眨眼、距离、环境光、20-20-20，也可以关「提示音」，或把疲劳阈值调高、休息间隔调长。'],
      ['护眼操有声音吗？', '有提示音（可在健康提醒里关）。每节 20 秒，做完自动进入下一节。'],
    ],
  },
  {
    id: 'privacy',
    title: '数据与隐私',
    items: [
      ['摄像头画面会被上传吗？', '不会。所有推理都在本机内存里完成，不上传、不录制、不写磁盘；手机作为摄像头时也只回传 478 个关键点，不回传画面。'],
      ['怎么撤销摄像头授权？', '设置 → 数据隐私 → 撤销摄像头授权。之后再点「启动相机」会重新询问。'],
      ['「用户须知」还能再看吗？', '每次重新打开程序都会再显示一次（首次需要点一下确认，之后停留 1 秒自动进入）。使用教程可以在 设置 → 数据隐私 → 重看使用教程 里重播。'],
      ['本地存了哪些数据？', '校准参数、偏好设置、匿名指标、插件文件。都在本机，设置 → 数据隐私 → 清除全部数据 可一次清空。'],
    ],
  },
  {
    id: 'plugins',
    title: '插件',
    items: [
      ['怎么安装插件？', '插件中心底部有安装区：把 .zip 或单个 .js 拖进去（或点击选择文件），校验通过后会立即出现在插件列表里。'],
      ['插件怎么写？', '一个 JS 文件，调用 EyePilot.register({ id, name, mount(root, ctx) })。ctx 提供 gaze、health、onFrame，十行就能跑起来。'],
      ['怎么删除插件？', '插件中心 → 插件管理 → 勾选要删的 → 批量卸载。内置的三个插件不能删除。'],
      ['插件安全吗？', '插件是本地 JS，能读到你的视线与健康指标，但读不到摄像头画面。只装你信任的来源。'],
    ],
  },
  {
    id: 'other',
    title: '其他',
    items: [
      ['灵动岛不见了？', '桌面版：右键托盘图标 → 显示/隐藏灵动岛；或到 设置 → 灵动岛 里检查开关。网页版没有悬浮窗，只有设置里的可点预览。'],
      ['灵动岛怎么用？', '桌面版启动后它自动贴在屏幕顶部：按住空白处拖动位置，点右侧 ∨ 展开看用眼时长 / 疲劳 / 健康分 / 下次远眺，收起条上的「眼 混 头 鼠」直接切输入方式。有提醒时只在条上亮一行黄字，不会弹开挡屏。设置 → 灵动岛 可以勾选显示哪些指标、写一行自定义内容。'],
      ['关闭窗口后程序还在跑？', '这是桌面版的默认行为：关窗只是收进托盘，用眼记录继续。想改成关窗即退出，去「设置 → 通用」关掉「关闭窗口后继续在后台运行」；右键托盘 → 退出 也可以随时真正退出。'],
      ['卡片顺序能改吗？', '能。卡片标题右侧有个 ⠿ 手柄，按住拖到别的位置即可，顺序会自动保存；想恢复默认，去「设置 → 通用 → 重置组件布局」。'],
      ['怎么卸载？', '安装版：Windows 设置 → 应用 → EyePilot → 卸载。免安装版：删掉整个文件夹即可，再删 %APPDATA%\\EyePilot 清数据。'],
    ],
  },
];

let root = null;

export function initHelp() {
  if (root) return;
  root = document.createElement('div');
  root.className = 'gate';
  root.id = 'helpGate';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.innerHTML = `
    <div class="gate-card help-card">
      <div class="tour-top">
        <span class="eyebrow">HELP</span>
        <button class="btn link sm" id="helpClose">关闭</button>
      </div>
      <h2 id="helpTitle">常见问题</h2>
      <p class="gate-lead" id="helpLead">按使用顺序排好了：遇到问题先看对应那一节。</p>
      <button class="btn link sm" id="helpAll" hidden>查看全部问题 →</button>
      <div class="help-body" id="helpBody"></div>
    </div>`;
  document.body.appendChild(root);

  const body = root.querySelector('#helpBody');
  body.innerHTML = SECTIONS.map((sec) => `
    <section class="help-sec" data-help-sec="${sec.id}">
      <h3>${sec.title}</h3>
      ${sec.items.map(([q, a]) => `
        <div class="help-q">
          <button type="button"><span>${q}</span><i>＋</i></button>
          <p>${a}</p>
        </div>`).join('')}
    </section>`).join('');

  body.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.help-q > button');
    if (!btn) return;
    btn.parentElement.classList.toggle('open');
  });
  root.querySelector('#helpClose').addEventListener('click', closeHelp);
  root.querySelector('#helpAll').addEventListener('click', () => openHelp());
  root.addEventListener('click', (ev) => { if (ev.target === root) closeHelp(); });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && root.classList.contains('open')) closeHelp();
  });
}

export function openHelp(section) {
  if (!root) initHelp();
  root.classList.add('open');
  const body = root.querySelector('#helpBody');
  const title = root.querySelector('#helpTitle');
  const lead = root.querySelector('#helpLead');
  const allBtn = root.querySelector('#helpAll');
  const target = section ? root.querySelector(`[data-help-sec="${section}"]`) : null;

  // 从某个页面点进来（例如专注页的问号）只显示那一节，避免在一屏 FAQ 里翻找
  body.querySelectorAll('[data-help-sec]').forEach((sec) => {
    sec.hidden = !!target && sec !== target;
  });
  body.querySelectorAll('[data-help-sec] > h3').forEach((h) => { h.style.display = ''; });
  if (target) {
    const h3 = target.querySelector('h3');
    if (h3) h3.style.display = 'none';
    const secTitle = h3?.textContent || '';
    if (title) title.textContent = `${secTitle} · 帮助`;
    if (lead) lead.textContent = '这里只列出与当前页面有关的说明；需要更多可以去左下角「帮助」。';
    if (allBtn) allBtn.hidden = false;
    body.scrollTop = 0;
    target.querySelectorAll('.help-q').forEach((q) => q.classList.add('open'));
  } else {
    if (title) title.textContent = '常见问题';
    if (lead) lead.textContent = '按使用顺序排好了：遇到问题先看对应那一节。';
    if (allBtn) allBtn.hidden = true;
    body.scrollTop = 0;
  }
}

export function closeHelp() {
  if (root) root.classList.remove('open');
}
