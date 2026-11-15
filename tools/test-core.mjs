/* 纯算法层单测：node tools/test-core.mjs */
import {
  fitRidge, predictRidge, buildFeatureVector, OneEuroFilter, medianVector, linearTrend, clamp,
  fitAffine1D, FEATURE_VERSION, featureDim,
} from '../src/core/math.js';
import {
  computePerclos, computeBlinkRate, computeBlinkStats, computeFocus, computeFatigue,
  computeHealthScore, estimateDistanceCm, lumaToLux, eyeOpenness,
} from '../src/core/health.js';

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name} ${extra}`); }
}
function close(a, b, tol) { return Math.abs(a - b) <= tol; }

console.log('\n[1] 岭回归：恢复已知线性映射');
{
  const X = [], Y = [];
  const truth = [[0.9, -0.4], [0.2, 1.1]];
  for (let i = 0; i < 40; i++) {
    const x = [Math.random(), Math.random(), Math.random(), Math.random(), Math.random()];
    X.push(x);
    Y.push([
      0.4 + x.reduce((s, v, j) => s + v * truth[0][j % 2], 0),
      0.3 + x.reduce((s, v, j) => s + v * truth[1][j % 2], 0),
    ]);
  }
  const m = fitRidge(X, Y, 0.001);
  let err = 0;
  for (let i = 0; i < X.length; i++) {
    const p = predictRidge(m, X[i]);
    err += Math.abs(p[0] - Y[i][0]) + Math.abs(p[1] - Y[i][1]);
  }
  ok('拟合误差 < 0.02', err / X.length < 0.02, `avg=${(err / X.length).toFixed(4)}`);
  ok('权重矩阵维度正确', m.w.length === 6 && m.w[0].length === 2);
}

console.log('\n[2] 特征向量');
{
  const f = { hxL: 0.1, hyL: 0.06, hxR: 0.08, hyR: 0.04, yaw: 0.02, pitch: 0.01 };
  const v1 = buildFeatureVector(f, 1);
  const v2 = buildFeatureVector(f, 2);
  ok('特征版本为 2', FEATURE_VERSION === 2);
  ok('一阶特征 6 维', v1.length === 6 && featureDim(1) === 6, `got ${v1.length}`);
  ok('二阶特征 10 维', v2.length === 10 && featureDim(2) === 10, `got ${v2.length}`);
  ok('平均横向特征', close(v1[0], 0.09, 1e-9));
  ok('平均纵向特征', close(v1[1], 0.05, 1e-9));
  ok('左右收敛差', close(v1[2], 0.02, 1e-9));
  ok('缺失字段回落到 0', buildFeatureVector({}, 1).every((v) => v === 0));
}

console.log('\n[2b] 仿射校正（校准残余误差）');
{
  const xs = [0.1, 0.3, 0.5, 0.7, 0.9];
  const ys = xs.map((x) => 1.12 * x - 0.04);
  const r = fitAffine1D(xs, ys);
  ok('恢复已知增益', close(r.a, 1.12, 1e-6), `a=${r.a}`);
  ok('恢复已知偏移', close(r.b, -0.04, 1e-6), `b=${r.b}`);
  const bad = fitAffine1D([0, 0.5, 1], [0.4, 4, 0.6]);
  ok('增益被夹紧在安全范围', bad.a >= 0.55 && bad.a <= 1.8, `a=${bad.a}`);
  ok('偏移被夹紧在安全范围', Math.abs(bad.b) <= 0.35, `b=${bad.b}`);
  ok('点数不足时不做校正', fitAffine1D([0, 1], [0, 1]).a === 1);
}

console.log('\n[3] 一欧元滤波');
{
  const f = new OneEuroFilter({ minCutoff: 1.0, beta: 0.007 });
  let y = 0;
  for (let i = 0; i < 60; i++) y = f.filter(i < 30 ? 0 : 100, 1 / 30);
  ok('阶跃后收敛到目标附近', y > 90, `y=${y.toFixed(2)}`);
  ok('输出有限', Number.isFinite(y));
}

console.log('\n[4] 中位数向量');
{
  const mv = medianVector([[1, 5], [3, 7], [2, 6], [9, 9]]);
  ok('中位数正确', mv[0] === 2.5 && mv[1] === 6.5, JSON.stringify(mv));
}

console.log('\n[5] 眨眼与 PERCLOS');
{
  const now = 100000;
  const samples = [];
  for (let i = 0; i < 600; i++) {
    samples.push({ t: now - 60000 + i * 100, open: i % 10 === 0 ? 0.1 : 1, valid: true });
  }
  const p = computePerclos(samples, now, 60000);
  ok('PERCLOS ≈ 10%', close(p, 0.1, 0.02), `got ${p.toFixed(3)}`);

  const blinks = [];
  for (let i = 0; i < 15; i++) blinks.push({ t: now - i * 3500, dur: 120 });
  ok('眨眼频率约 15 次/分', Math.abs(computeBlinkRate(blinks, now, 60000) - 15) <= 1);
  const st = computeBlinkStats(blinks, now, 120000);
  ok('眨眼时长统计正确', st.avgDur === 120 && st.count === 15, JSON.stringify(st));
}

console.log('\n[6] 专注度');
{
  const now = 50000;
  const steady = [];
  const jumpy = [];
  for (let i = 0; i < 100; i++) {
    steady.push({ t: now - 10000 + i * 100, x: 0.5 + Math.sin(i / 20) * 0.01, y: 0.5, valid: true, outside: false });
    jumpy.push({ t: now - 10000 + i * 100, x: 0.1 + (i % 2) * 0.8, y: 0.15 + (i % 3) * 0.3, valid: true, outside: false });
  }
  const a = computeFocus(steady, now);
  const b = computeFocus(jumpy, now);
  ok('稳定注视专注度更高', a.score > b.score, `${a.score} vs ${b.score}`);
  ok('稳定注视 > 70', a.score > 70, String(a.score));
}

console.log('\n[7] 疲劳指数');
{
  const calm = computeFatigue({ perclos: 0.03, blinkRate: 17, blinkDur: 130, minutes: 5, distance: 60, awayRatio: 0.02 });
  const tired = computeFatigue({ perclos: 0.28, blinkRate: 5, blinkDur: 320, minutes: 80, distance: 38, awayRatio: 0.35 });
  ok('正常状态疲劳低', calm.score < 20, String(calm.score));
  ok('疲劳状态疲劳高', tired.score > 70, String(tired.score));
  ok('健康分随疲劳下降', computeHealthScore(tired.score, 5) < computeHealthScore(calm.score, 17));
  ok('健康分在 0..100', computeHealthScore(100, 3) >= 0 && computeHealthScore(0, 30) <= 100);
}

console.log('\n[8] 视距与光照估算');
{
  const d = estimateDistanceCm(104.76, 960);
  ok('50cm 处视距估算 ≈ 50', Math.abs(d - 50) <= 2, String(d));
  ok('无虹膜数据返回 0', estimateDistanceCm(0, 960) === 0);
  ok('亮度映射单调', lumaToLux(120) > lumaToLux(80) && lumaToLux(80) > lumaToLux(40));
  ok('睁眼度', close(eyeOpenness(0.1, 0.9), 0.1, 1e-9));
}

console.log('\n[9] 趋势');
{
  const xs = Array.from({ length: 20 }, (_, i) => i);
  const ys = xs.map((x) => 10 + x * 2);
  const tr = linearTrend(xs, ys);
  ok('斜率正确', close(tr.slope, 2, 1e-9));
  ok('R² = 1', close(tr.r2, 1, 1e-9));
}

console.log('\n[10] 边界');
{
  ok('clamp', clamp(-1, 0, 1) === 0 && clamp(2, 0, 1) === 1);
  ok('空样本不崩溃', computePerclos([], 0) === 0 && computeFocus([], 0).score === 0);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
