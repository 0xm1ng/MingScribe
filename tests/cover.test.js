/**
 * 书架封面配色测试。
 *
 * 这里守的是「不变量」，不是具体颜色值 —— 具体色相以后想调就调，
 * 但下面这几条一旦破了，书架看上去就会「没设计过」：
 *   ① 同一书名必须得到同一对颜色（否则每次刷新封面跳色）；
 *   ② 整条渐变路径都必须避开土黄 / 橄榄黄绿脏色区（55°~95°）；
 *   ③ 起始色明度不能太高（白字压在封面上要看得清）；
 *   ④ 常见书名之间撞色率要低（两本书同色会被当成 bug）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const Cover = require('../src/cover.js');

/** 从 `hsl(H, S%, L%)` 里抠出三个数。 */
function parseHsl(str) {
  const m = /^hsl\((\d+),\s*(\d+)%,\s*(\d+)%\)$/.exec(str);
  assert.ok(m, '不是合法的 hsl 字符串：' + str);
  return { h: Number(m[1]), s: Number(m[2]), l: Number(m[3]) };
}

/** 色相环上从 a 走到 b 的最短路径所经过的角度（含两端）。 */
function huePath(a, b) {
  const step = ((b - a + 540) % 360) - 180; // -180..180，符号即方向
  const dir = step >= 0 ? 1 : -1;
  const out = [];
  for (let i = 0; i <= Math.abs(step); i++) out.push((((a + i * dir) % 360) + 360) % 360);
  return out;
}

test('同一书名永远得到同一对颜色（确定性）', () => {
  const titles = ['山海经', 'Web安全学习笔记', 'Hello-CTF', 'A', '测试之书：EPUB 样例'];
  titles.forEach((t) => {
    const a = Cover.colorFor(t);
    const b = Cover.colorFor(t);
    assert.deepEqual(a, b, t + ' 两次取色不一致');
  });
});

test('返回合法的 hsl 颜色，且 h1/h2 与字符串一致', () => {
  const c = Cover.colorFor('山海经');
  const c1 = parseHsl(c.c1);
  const c2 = parseHsl(c.c2);
  assert.equal(c1.h, c.h1);
  assert.equal(c2.h, c.h2);
  // 收尾色更暗，渐变才有层次
  assert.ok(c2.l < c1.l, '收尾色没有比起始色更暗：' + c.c1 + ' / ' + c.c2);
});

test('每条渐变路径都避开土黄 / 橄榄黄绿脏色区（' + Cover.MUDDY_HUE_MIN + '°~' + Cover.MUDDY_HUE_MAX + '°）', () => {
  const bad = [];
  Cover.ANCHORS.forEach((pair) => {
    huePath(pair[0], pair[1]).forEach((h) => {
      if (h >= Cover.MUDDY_HUE_MIN && h <= Cover.MUDDY_HUE_MAX) {
        bad.push('[' + pair[0] + ',' + pair[1] + '] 经过 ' + h + '°');
      }
    });
  });
  assert.deepEqual(Array.from(new Set(bad)), [], '锚点渐变的路径扫过了脏色区');
});

test('封面起始色明度够低，压白字仍看得清', () => {
  const titles = ['山海经', '三体', '活着', '红楼梦', '不知名的书'];
  titles.forEach((t) => {
    const { l } = parseHsl(Cover.colorFor(t).c1);
    assert.ok(l <= 49, t + ' 的封面起始色明度偏高（' + l + '%），白字会糊');
  });
});

test('空 / null / undefined 书名不抛异常，且各自稳定', () => {
  [undefined, null, ''].forEach((t) => {
    const c = Cover.colorFor(t);
    parseHsl(c.c1);
    parseHsl(c.c2);
    assert.deepEqual(c, Cover.colorFor(t), String(t) + ' 取色不稳定');
  });
});

test('常见规模的书架里，撞色率要低', () => {
  // 现实里的书架大致是几十本。这里取 30 本，要求至少 8 成拿到独一无二的配色。
  // 不用 100%：配色空间是有限的（18 个锚点 × 5 档明度 = 90 种），
  // 书名一多按鸽笼原理必然撞色，断言写死 100% 就是在测伪命题。
  const titles = [];
  for (let i = 0; i < 30; i++) titles.push('第' + i + '本书');
  ['山海经', '三体', '活着', '红楼梦', '围城', '呐喊', '边城', '平凡的世界',
    'Web安全学习笔记', 'Hello-CTF', 'OWASP测试指南', '算法导论', '深入理解计算机系统']
    .forEach((t) => titles.push(t));

  const seen = new Map();
  titles.forEach((t) => {
    const c = Cover.colorFor(t);
    const key = c.c1 + '|' + c.c2;
    seen.set(key, (seen.get(key) || 0) + 1);
  });

  const uniq = seen.size;
  const maxRepeat = Math.max.apply(null, Array.from(seen.values()));
  assert.ok(
    uniq >= Math.floor(titles.length * 0.8),
    '撞色过多：' + titles.length + ' 个书名只得到 ' + uniq + ' 种配色'
  );
  assert.ok(maxRepeat <= 2, '有一种配色被用了 ' + maxRepeat + ' 次，太集中了');
});

test('明度抖动真的生效，没有退化成「只有锚点数种颜色」', () => {
  const keys = new Set();
  // 造一批书名，收集它们用到的明度档
  for (let i = 0; i < 200; i++) keys.add(Cover.colorFor('书' + i).tone);
  assert.ok(keys.size >= 3, '明度档位只用到了 ' + keys.size + ' 档，抖动没起作用');
});

test('当前书架上的真实书名彼此不同色', () => {
  const real = ['山海经', 'OWASP Web安全测试指南（英文版）', 'Hello-CTF - 开源CTF入门教程', 'Web安全学习笔记'];
  const got = real.map((t) => { const c = Cover.colorFor(t); return c.c1 + '|' + c.c2; });
  assert.equal(new Set(got).size, real.length, '真实书架里出现了同色封面：' + JSON.stringify(got));
});

test('hashOf 为非负整数，且对相同输入稳定', () => {
  ['abc', '山海经', ''].forEach((t) => {
    const h = Cover.hashOf(t);
    assert.ok(Number.isInteger(h) && h >= 0, 'hashOf 返回了非非负整数：' + h);
    assert.equal(h, Cover.hashOf(t));
  });
});
