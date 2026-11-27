/* ============================================================
   ai.js — AI 用眼教练：本地推理 + 可选在线大模型
   ============================================================ */

import { app } from './store.js';
import { linearTrend } from './core/math.js';
import { storage } from './utils.js';

const SYSTEM_PROMPT = `你是一位专业的用眼健康与注意力教练，服务于一款眼动追踪桌面应用。
你会收到通过摄像头测量到的匿名指标：眨眼频率（次/分）、注视点、PERCLOS（闭眼时间占比）、
估算视距（cm）、相对照度、专注度、疲劳指数和连续用眼时长。
你的回答必须：中文、具体、可执行，不说教，不诊断疾病，不超过 3 条建议；
如果指标正常，就明确说“现在没问题”，不要制造焦虑。`;

/**
 * 本地评估：规则 + 趋势 + 个人基线
 */
export function assessLocal(metrics, ctx = {}) {
  const m = metrics || {};
  const baseline = app.baseline || { blink: 16, distance: 58 };
  const series = ctx.series || [];
  const reliable = !!m.reliable;
  // 有画面不等于有有效数据：眨眼和视距都为 0 时不能下“很稳”的结论
  const hasData = reliable && m.blinkRate > 0 && m.distance > 20;
  const score = typeof m.health === 'number' ? m.health : 0;

  let level = score >= 75 ? 'good' : score >= 50 ? 'warn' : 'bad';
  if (!hasData) level = 'idle';

  const blinkLow = m.blinkRate > 0 && m.blinkRate < Math.max(9, baseline.blink * 0.72);
  const blinkDrop = m.blinkRate > 0 && baseline.blink > 0
    ? Math.round((1 - m.blinkRate / baseline.blink) * 100) : 0;
  const near = m.distance > 20 && m.distance < 45;
  const dark = m.light > 0 && m.light < 65;
  const perclosHigh = m.perclos > 18;
  const tired = m.fatigue >= (app.settings.fatigueThreshold || 65);
  const longUse = m.minutes >= 45;
  const focusLow = m.focus > 0 && m.focus < 50;

  const findings = [];
  if (perclosHigh) {
    findings.push({
      key: 'perclos', severity: m.perclos > 26 ? 'bad' : 'warn',
      title: '出现了疲劳性闭眼',
      detail: `过去一分钟有 ${m.perclos}% 的时间眼睛是闭着的。正常阅读时这个数字通常在 5% 以下，超过 20% 说明大脑在强行“关机”。`,
      actions: ['立刻闭眼 10 秒，再远眺 20 秒', '把接下来的任务切成 15 分钟一段'],
    });
  }
  if (blinkLow) {
    findings.push({
      key: 'blink', severity: m.blinkRate < 6 ? 'bad' : 'warn',
      title: `眨眼比你的基线少了 ${Math.max(0, blinkDrop)}%`,
      detail: `现在 ${m.blinkRate} 次/分，你的个人基线约 ${baseline.blink} 次/分。盯屏幕时人会自动降低眨眼频率，泪膜破裂后就会出现干、涩、异物感。`,
      actions: ['做 10 次完整的“用力闭眼—睁开”', '把屏幕亮度调到与环境光接近，减少反光'],
    });
  }
  if (near) {
    findings.push({
      key: 'distance', severity: 'warn',
      title: '视距正在变近',
      detail: `估算视距 ${m.distance}cm，低于 45cm 的舒适区。近距离用眼会让睫状肌持续收缩，是近视加深和视疲劳的主要诱因。`,
      actions: ['把椅子向后推，保持一臂距离（50–70cm）', '屏幕上沿略低于视线水平，俯角 10–15°'],
    });
  }
  if (dark) {
    findings.push({
      key: 'light', severity: 'warn',
      title: '环境光不足',
      detail: `相对照度只有 ${m.light}。屏幕与环境亮度差过大时，瞳孔需要频繁调节，眩光和眼干会明显增加。`,
      actions: ['打开台灯或顶灯，避免只留屏幕一个光源', '调整屏幕角度，避开窗户或灯管的直射反光'],
    });
  }
  if (longUse) {
    findings.push({
      key: 'duration', severity: m.minutes > 75 ? 'bad' : 'warn',
      title: `已经连续用眼 ${Math.round(m.minutes)} 分钟`,
      detail: '连续近距离用眼超过 45 分钟后，调节滞后会快速累积，此时继续硬撑的效率其实在下降。',
      actions: ['起身接杯水，让视线离开屏幕 1 分钟', '回来后用番茄钟工作 25 分钟'],
    });
  }
  if (focusLow) {
    findings.push({
      key: 'focus', severity: 'info',
      title: '注意力开始漂移',
      detail: `专注度 ${m.focus}/100，视线频繁离开任务区域。这通常是疲劳或任务难度不匹配的信号。`,
      actions: ['把当前任务拆成一个 10 分钟能完成的小目标', '关掉通知，把手机翻面'],
    });
  }

  findings.sort((a, b) => ({ bad: 0, warn: 1, info: 2 }[a.severity] - { bad: 0, warn: 1, info: 2 }[b.severity]));

  // 趋势预测
  const pts = series.slice(-40).map((s) => [s.t / 1000, s.fatigue]).filter((p) => Number.isFinite(p[1]));
  let prediction;
  let slopePerMin = 0;
  if (pts.length >= 6) {
    const tr = linearTrend(pts.map((p) => p[0]), pts.map((p) => p[1]));
    slopePerMin = tr.slope * 60;
  }
  const threshold = app.settings.fatigueThreshold || 65;
  if (!hasData) {
    prediction = '数据还不够。保持相机可见、完成校准，等能稳定测到眨眼与视距后再看预测。';
  } else if (slopePerMin > 0.45 && m.fatigue < threshold) {
    const mins = Math.max(1, Math.round((threshold - m.fatigue) / slopePerMin));
    prediction = `疲劳指数正以每分钟约 ${slopePerMin.toFixed(1)} 点的速度上升。按这个趋势，大约 ${Math.min(mins, 60)} 分钟后会越过 ${threshold} 的预警线，建议在那之前安排一次 20 秒远眺。`;
  } else if (m.fatigue >= threshold) {
    prediction = '当前已经在预警区间，继续用眼只会让恢复时间更长。现在休息 2 分钟，比 10 分钟后再休息更划算。';
  } else if (m.fatigue < 30) {
    prediction = `当前负荷很低，按这个节奏可以再专注 30–40 分钟。${m.blinkRate >= baseline.blink * 0.9 ? '眨眼保持得不错。' : '记得把眨眼补回来。'}`;
  } else {
    prediction = '负荷平稳，暂时没有明显恶化趋势。保持现在的视距和眨眼频率就好。';
  }

  // 文案
  let title = '用眼节奏很稳';
  let summary;
  if (!hasData) {
    title = '正在建立你的用眼画像';
    summary = '需要至少 1 分钟的稳定画面，并且能测到眨眼与视距，才能给出评估。请让脸保持在摄像头画面中。';
  } else if (!findings.length) {
    summary = `过去一分钟眨眼 ${m.blinkRate} 次（基线 ${baseline.blink}），视距 ${m.distance}cm，疲劳指数 ${m.fatigue}/100。三项都在舒适区，保持住。`;
  } else if (findings.length === 1) {
    title = findings[0].title;
    summary = `${findings[0].detail} 其余指标（视距 ${m.distance}cm、疲劳 ${m.fatigue}/100）暂时正常。`;
  } else {
    title = findings[0].title;
    summary = `${findings[0].detail} 另外还注意到${findings.slice(1, 3).map((f) => `「${f.title}」`).join('、')}。综合健康分 ${score}/100。`;
  }

  const actions = [];
  for (const f of findings) {
    for (const a of f.actions) {
      if (!actions.includes(a)) actions.push(a);
      if (actions.length >= 3) break;
    }
    if (actions.length >= 3) break;
  }
  if (!actions.length) {
    actions.push(
      '保持 50–70cm 视距，屏幕上沿略低于视线。',
      '每 20 分钟把视线移到 6 米外，持续 20 秒。',
      '有意识地完整眨眼，而不是只眨一半。',
    );
  }

  const chips = [
    { label: '眨眼', value: m.blinkRate ? `${m.blinkRate} 次/分` : '--', state: blinkLow ? 'warn' : '' },
    { label: '视距', value: m.distance ? `${m.distance} cm` : '--', state: near ? 'warn' : '' },
    { label: '闭眼占比', value: m.perclos ? `${m.perclos}%` : '--', state: perclosHigh ? 'warn' : '' },
    { label: '专注', value: m.focus ? `${m.focus}/100` : '--', state: focusLow ? 'warn' : '' },
    { label: '连续用眼', value: `${Math.round(m.minutes || 0)} 分钟`, state: longUse ? 'warn' : '' },
  ];

  return {
    score,
    level,
    title,
    summary,
    actions,
    chips,
    prediction,
    findings,
    engine: 'local',
    confidence: hasData ? 0.86 : 0.4,
    slopePerMin,
    ts: Date.now(),
  };
}

/* ---------------- 本地问答 ---------------- */

export function answerLocal(question, metrics, assessment) {
  const q = String(question || '');
  const m = metrics || {};
  const b = app.baseline || { blink: 16 };
  const head = `当前：眨眼 ${m.blinkRate || '--'} 次/分、视距 ${m.distance || '--'}cm、疲劳 ${m.fatigue ?? '--'}/100。`;

  if (/眨眼|干|涩|异物|泪/.test(q)) {
    return `${head}
屏幕工作时，人的眨眼频率会从每分钟 15–20 次掉到 5–7 次，而且很多是“半眨眼”——上眼睑没有完全闭合，泪膜得不到完整刷新。这是眼干最直接的原因。
可以立刻做三件事：
1. 20 秒内完成 10 次“用力闭眼 2 秒—睁开”，把睑板腺里的油脂挤出来。
2. 把屏幕中心降到视线下方 10–15°，减少睑裂暴露面积。
3. 如果开了空调或风扇，别让风直吹脸。`;
  }
  if (/累|疲|困|睡|撑不住/.test(q)) {
    return `${head}
疲劳不是“意志力问题”，而是调节滞后和微睡眠的生理信号。你的闭眼占比越高，说明大脑在强行降低视觉输入。
建议现在做一次真正的休息：站起来、看向 6 米外、故意眨眼 20 秒。如果困意明显，20 分钟的小睡比咖啡更有效。`;
  }
  if (/距离|近|远|坐姿|椅/.test(q)) {
    return `${head}
合适的视距是一臂距离，大约 50–70cm；屏幕上沿略低于视线水平，俯角 10–15°。
如果你的视距在变小，通常不是“习惯不好”，而是身体在代偿疲劳——离得近一点，字看起来更清楚。这时候应该休息，而不是继续凑近。`;
  }
  if (/方案|计划|怎么|建议|护眼|5\s*分钟|五分钟/.test(q)) {
    return `给你一个 5 分钟的复位方案（不用离开座位）：
· 0:00–0:20 远眺 6 米外，放松睫状肌。
· 0:20–1:00 10 次用力闭眼睁眼，配合缓慢转眼各 5 圈。
· 1:00–2:00 起身接水，顺便把视线切到远处。
· 2:00–4:00 调屏幕：亮度接近环境光、字放大一档、窗口居中。
· 4:00–5:00 用番茄钟设 25 分钟，只做一件小事。
${head}`;
  }
  if (/校准|不准|偏|漂/.test(q)) {
    return `光标漂移通常有三个原因：
1. 校准时的坐姿和现在差别太大——头位变化会直接改变虹膜相对位置。
2. 屏幕分辨率或缩放变了，需要重新校准。
3. 环境光变化太大，摄像头自动曝光后虹膜对比度下降。
建议在设置里点「重新校准」，校准过程中保持头部不动、正常眨眼。`;
  }
  if (/隐私|数据|上传|相机|摄像/.test(q)) {
    return '所有视频帧都在浏览器本地由 MediaPipe 模型处理，不会上传到任何服务器。只有匿名化的数值指标会写进本地存储，用来计算你的个人基线和趋势，可以随时在设置里一键清除。';
  }
  if (/游戏|训练|插件/.test(q)) {
    return '「眼控训练」是一个 60 秒的注视训练小游戏：目标出现后盯住它，进度环走满即命中，能同时练习眼球的快速定位和稳定注视。插件中心里还有眼控阅读；左侧菜单第一项是专注会话。';
  }
  return `${head}
${assessment && assessment.summary ? assessment.summary : ''}
${assessment && assessment.actions ? '可以试试：\n' + assessment.actions.map((a, i) => `${i + 1}. ${a}`).join('\n') : ''}`;
}

/* ---------------- 在线大模型 ---------------- */

export class AICoach {
  constructor({ onAssessment } = {}) {
    this.onAssessment = onAssessment || (() => {});
    this.history = [];
    this.lastLlmAt = 0;
    this.llmFailed = false;
    this.lastPending = false;
  }

  hasLLM() {
    const { base, key, model } = app.settings.llm || {};
    return !!(base && key && model);
  }

  async request(messages, { timeout = 22000 } = {}) {
    const { base, key, model } = app.settings.llm;
    if (!base || !key || !model) throw new Error('未配置大模型');
    const url = `${base.replace(/\/+$/, '')}/chat/completions`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.5,
          max_tokens: 700,
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${text.slice(0, 160)}`);
      }
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      if (!content) throw new Error('大模型返回为空');
      return content.trim();
    } finally {
      clearTimeout(timer);
    }
  }

  async refresh(metrics, ctx = {}, force = false) {
    const local = assessLocal(metrics, ctx);
    this.onAssessment(local);
    app.assessment = local;

    if (!this.hasLLM() || this.llmFailed) return local;
    if (!metrics || !metrics.reliable) return local;
    if (!force && Date.now() - this.lastLlmAt < 120000) return local;

    this.lastLlmAt = Date.now();
    this.lastPending = true;
    try {
      const payload = {
        眨眼频率: metrics.blinkRate,
        个人眨眼基线: app.baseline.blink,
        闭眼占比PERCLOS: metrics.perclos,
        估算视距cm: metrics.distance,
        相对照度: metrics.light,
        专注度: metrics.focus,
        疲劳指数: metrics.fatigue,
        健康分: metrics.health,
        连续用眼分钟: Math.round(metrics.minutes),
        最近提醒: (ctx.alerts || []).slice(0, 3).map((a) => a.title),
      };
      const text = await this.request([
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: `这是刚刚测到的指标：${JSON.stringify(payload, null, 2)}
请只输出 JSON，不要 Markdown，格式：
{"title":"不超过14字的结论","summary":"2-3句解释，引用具体数字","actions":["建议1","建议2","建议3"],"prediction":"一句话趋势预测"}`,
        },
      ]);
      const json = extractJson(text);
      if (!json || !json.summary) throw new Error('JSON 解析失败');
      const enriched = {
        ...local,
        title: json.title || local.title,
        summary: json.summary,
        actions: Array.isArray(json.actions) && json.actions.length ? json.actions.slice(0, 3) : local.actions,
        prediction: json.prediction || local.prediction,
        engine: 'llm',
        confidence: 0.92,
        ts: Date.now(),
      };
      app.assessment = enriched;
      this.onAssessment(enriched);
      return enriched;
    } catch (err) {
      console.warn('[EyePilot] 大模型调用失败，回退本地推理：', err);
      this.llmFailed = true;
      storage.set('llmLastError', String(err.message || err));
      return local;
    } finally {
      this.lastPending = false;
    }
  }

  async chat(question) {
    const metrics = app.metrics || {};
    const assessment = app.assessment;
    if (!this.hasLLM()) {
      return { text: answerLocal(question, metrics, assessment), engine: 'local' };
    }
    try {
      const ctx = {
        当前指标: metrics,
        个人基线: app.baseline,
        最近评估: assessment ? { 结论: assessment.title, 摘要: assessment.summary } : null,
      };
      const msgs = [
        { role: 'system', content: `${SYSTEM_PROMPT}\n当前上下文：${JSON.stringify(ctx)}` },
        ...this.history.slice(-6),
        { role: 'user', content: question },
      ];
      const text = await this.request(msgs);
      this.history.push({ role: 'user', content: question }, { role: 'assistant', content: text });
      if (this.history.length > 12) this.history = this.history.slice(-12);
      return { text, engine: 'llm' };
    } catch (err) {
      this.llmFailed = true;
      return {
        text: `${answerLocal(question, metrics, assessment)}\n\n（在线模型暂时不可用，以上为本地推理结果）`,
        engine: 'local',
      };
    }
  }

  async test() {
    const text = await this.request([
      { role: 'system', content: '你是连通性测试助手，只回复：连接成功' },
      { role: 'user', content: 'ping' },
    ], { timeout: 15000 });
    return text;
  }
}

export function extractJson(text) {
  if (!text) return null;
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  try { return JSON.parse(cleaned); } catch { /* continue */ }
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { return null; }
  }
  return null;
}

/* ---------------- 文字报告 ---------------- */

/**
 * 指标解释表：报告里每个数字都配一句「它是什么、为什么重要、怎么改善」。
 * 纯数据，便于单测与复用；state 返回 good / warn / bad。
 */
const REPORT_METRICS = [
  {
    key: 'blinkRate', label: '眨眼频率', unit: '次/分', ref: '15–20 次/分',
    explain: '眨眼把泪液均匀铺在眼球表面。盯着屏幕时人会不自觉少眨，泪膜蒸发过快，就会出现干、涩、异物感。',
    tip: '有意识地完整眨眼；做 10 次「用力闭眼—睁开」。',
    state: (v) => (v < 9 ? 'bad' : v < 13 ? 'warn' : 'good'),
  },
  {
    key: 'blinkDur', label: '平均闭眼时长', unit: 'ms', ref: '100–150 ms',
    explain: '一次完整眨眼约 0.1–0.15 秒。明显偏短多半是「半眨眼」，上眼睑没完全合上，泪膜铺不均匀。',
    tip: '刻意把每次眨眼做完整，不要只用眼皮快速一碰。',
    state: (v) => (v < 80 ? 'warn' : 'good'),
  },
  {
    key: 'perclos', label: '闭眼占比 PERCLOS', unit: '%', ref: '< 15%',
    explain: '一段时间里眼睛闭着的时间比例，是判断困倦的经典指标。正常阅读在 5% 以下，超过 20% 说明大脑在强制短暂「关机」。',
    tip: '立刻远眺 20 秒，把接下来的任务切成 15 分钟一段。',
    state: (v) => (v > 26 ? 'bad' : v > 18 ? 'warn' : 'good'),
  },
  {
    key: 'distance', label: '估算视距', unit: 'cm', ref: '50–70 cm',
    explain: '眼睛到屏幕的距离（单目几何估算，看相对变化即可）。太近会让睫状肌持续收缩，是视疲劳和近视加深的主要诱因。',
    tip: '把屏幕推到一臂距离；屏幕上沿略低于视线，俯角 10–15°。',
    state: (v) => (v < 40 ? 'bad' : v < 50 ? 'warn' : v > 80 ? 'warn' : 'good'),
  },
  {
    key: 'light', label: '相对照度', unit: '', ref: '与屏幕亮度接近',
    explain: '环境光强弱的相对值。屏幕和环境亮度差太大时，瞳孔要来回调节，眩光和眼干会明显增加。',
    tip: '开一盏台灯或顶灯，避免只留屏幕一个光源；调整角度避开直射反光。',
    state: (v) => (v < 50 ? 'warn' : 'good'),
  },
  {
    key: 'focus', label: '专注度', unit: '/100', ref: '> 60 较好',
    explain: '视线停留在任务区域的比例。下降通常意味着疲劳或任务难度不匹配，不一定是「不努力」。',
    tip: '把任务拆成 10 分钟能完成的小目标，关掉通知。',
    state: (v) => (v < 40 ? 'warn' : 'good'),
  },
  {
    key: 'fatigue', label: '疲劳指数', unit: '/100', ref: '< 45 舒适', zeroValid: true,
    explain: '综合眨眼、闭眼、视距和连续用眼时间算出的负荷值。越接近 100，越需要休息。',
    tip: '到 65 就该休息 2 分钟；硬撑只会让恢复时间更长。',
    state: (v) => (v >= 65 ? 'bad' : v >= 45 ? 'warn' : 'good'),
  },
  {
    key: 'health', label: '健康分', unit: '/100', ref: '> 75 良好', zeroValid: true,
    explain: '上面几项的综合得分，用来一眼判断整体用眼状态。',
    tip: '连续用眼满 20 分钟就远眺一次，是最省力的维持方式。',
    state: (v) => (v >= 75 ? 'good' : v >= 50 ? 'warn' : 'bad'),
  },
];

const REPORT_STATE_TEXT = { good: '正常', warn: '需留意', bad: '需改善', idle: '采集中', info: '提示' };
const REPORT_LEVEL_TEXT = { good: '状态良好', warn: '需要留意', bad: '建议休息', idle: '数据采集中' };

/** 生成结构化报告模型（纯函数，可单测）。 */
export function buildReport(snapshot, assessment) {
  const m = (snapshot && snapshot.metrics) || {};
  const now = new Date();
  const idle = !!(assessment && assessment.level === 'idle');
  const metrics = REPORT_METRICS.map((def) => {
    const raw = Number(m[def.key]);
    const has = Number.isFinite(raw) && (raw > 0 || def.zeroValid);
    const status = idle || !has ? 'idle' : def.state(raw);
    return {
      key: def.key, label: def.label,
      value: has ? Math.round(raw * 10) / 10 : '--',
      unit: def.unit, ref: def.ref, status,
      statusText: REPORT_STATE_TEXT[status],
      explain: def.explain, tip: def.tip,
    };
  });
  return {
    generatedAt: now.toLocaleString('zh-CN'),
    duration: Math.round(m.minutes || 0),
    blinks: (snapshot && snapshot.session && snapshot.session.blinks) || 0,
    verdict: {
      level: (assessment && assessment.level) || 'idle',
      score: (assessment && typeof assessment.score === 'number') ? assessment.score : 0,
      title: (assessment && assessment.title) || '正在建立你的用眼画像',
      summary: (assessment && assessment.summary) || '让脸保持在摄像头画面中，约 1 分钟后即可生成评估。',
    },
    metrics,
    findings: (assessment && assessment.findings) || [],
    actions: (assessment && assessment.actions) || [],
    prediction: (assessment && assessment.prediction) || '',
    alerts: ((snapshot && snapshot.alerts) || []).slice(0, 10),
  };
}

/** 把报告模型渲染成可下载 / 可复制的 Markdown（带解释）。 */
export function reportToMarkdown(r) {
  const L = [];
  L.push('# EyePilot 用眼报告');
  L.push('');
  L.push(`生成时间：${r.generatedAt}`);
  L.push(`本次连续用眼 ${r.duration} 分钟 · 累计眨眼 ${r.blinks} 次`);
  L.push('');
  L.push('## 一句话结论');
  L.push(`**${r.verdict.title}**（健康分 ${r.verdict.score}/100 · ${REPORT_LEVEL_TEXT[r.verdict.level] || ''}）`);
  L.push('');
  L.push(r.verdict.summary);
  L.push('');
  L.push('## 关键指标 · 每个数字都带解释');
  r.metrics.forEach((x) => {
    L.push(`### ${x.label}：${x.value}${x.unit} — ${x.statusText}`);
    L.push(`参考：${x.ref}`);
    L.push(x.explain);
    L.push(`改善：${x.tip}`);
    L.push('');
  });
  if (r.findings.length) {
    L.push('## 发现的问题');
    r.findings.forEach((f, i) => {
      L.push(`${i + 1}. **${f.title}**（${REPORT_STATE_TEXT[f.severity] || '提示'}）`);
      L.push(`   ${f.detail}`);
      (f.actions || []).forEach((a) => L.push(`   - ${a}`));
    });
    L.push('');
  }
  if (r.actions.length) {
    L.push('## 接下来怎么做');
    r.actions.forEach((a, i) => L.push(`${i + 1}. ${a}`));
    L.push('');
  }
  L.push('## 趋势预测');
  L.push(r.prediction || '—');
  L.push('');
  if (r.alerts.length) {
    L.push('## 本次提醒记录');
    r.alerts.forEach((a) => L.push(`- ${a.time} ${a.title}：${a.detail}`));
    L.push('');
  }
  L.push('---');
  L.push('说明：本报告基于普通摄像头的光学估算，不构成医疗诊断。如持续眼干、眼痛或视力模糊，请及时就医。');
  return L.join('\n');
}
