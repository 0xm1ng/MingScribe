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

/* ==================== 封面美术（图案 + 排版） ====================
   守的是「封面不是一块纯色 + 一个字」这件事：
   图案必须真的能画出来（合法 data URI）、必须跟书的类型挂钩、
   书名字号必须跟着字数走（长书名不能溢出封面）。 */

/** 把 `url("data:image/svg+xml,...")` 还原成 SVG 源码字符串。 */
function decodePattern(css) {
  const m = /^url\("data:image\/svg\+xml,(.+)"\)$/.exec(css);
  assert.ok(m, '封面图案不是合法的 data URI：' + css);
  return decodeURIComponent(m[1]);
}

test('同一书名永远得到同一套封面美术参数（确定性）', () => {
  ['山海经', 'Web安全学习笔记', 'Hello-CTF - 开源CTF入门教程', ''].forEach((t) => {
    assert.deepEqual(Cover.artFor(t), Cover.artFor(t), t + ' 两次取图案不一致');
  });
});

test('artFor 返回的结构完整，且图案确实存在于图案表里', () => {
  const art = Cover.artFor('山海经');
  ['genre', 'pattern', 'patternCss', 'patternSize', 'initial', 'nameSize'].forEach((k) => {
    assert.ok(art[k] !== undefined && art[k] !== null && art[k] !== '', 'artFor 缺字段 ' + k);
  });
  assert.ok(Object.keys(Cover.PATTERNS).includes(art.pattern), '图案不在 PATTERNS 里：' + art.pattern);
  assert.ok(art.nameSize >= 12 && art.nameSize <= 34, '封面书名字号跑偏了：' + art.nameSize);
});

test('图案的 data URI 能被还原成合法的平铺 SVG，尺寸与 patternSize 一致', () => {
  Object.keys(Cover.PATTERNS).forEach((name) => {
    const p = Cover.patternFor(name);
    const svg = decodePattern(p.css);
    assert.ok(svg.startsWith('<svg'), name + ' 的 data URI 还原后不是 SVG');
    assert.ok(svg.includes("xmlns='http://www.w3.org/2000/svg'"), name + ' 的 SVG 缺 xmlns');
    // size 必须与 SVG 自身的 width/height 对得上，否则 tiling 会错位
    assert.ok(svg.includes("width='" + Cover.PATTERNS[name].w + "'"), name + ' 的图案宽度与 size 不符');
    assert.ok(p.size.startsWith(Cover.PATTERNS[name].w + 'px '), name + ' 的 background-size 与图案不符');
  });
});

test('未知图案名回落到波纹，不会产出 undefined 的 CSS', () => {
  const p = Cover.patternFor('不存在的图案');
  assert.equal(p.name, 'wave');
  assert.ok(decodePattern(p.css).startsWith('<svg'));
});

test('封面图案按书的内容类型匹配，不是纯随机', () => {
  const cases = [
    ['Web安全学习笔记', 'tech'],
    ['Hello-CTF - 开源CTF入门教程', 'tech'],
    ['深入理解计算机系统', 'tech'],
    ['山海經', 'classic'],
    ['论语译注', 'classic'],
    ['时间简史', 'science'],
    ['百年孤独小说集', 'literature']
  ];
  cases.forEach(([title, expect]) => {
    assert.equal(Cover.genreOf(title), expect, '《' + title + '》被判成了 ' + Cover.genreOf(title));
  });
  // 认不出来的书名必须落到 general，而不是硬塞进某一类
  assert.equal(Cover.genreOf('zzz'), 'general');
  assert.equal(Cover.genreOf(''), 'general');
});

test('非通用类的封面图案只能取自本类的图案池', () => {
  const samples = ['Web安全学习笔记', '论语译注', '时间简史', '百年孤独小说集'];
  samples.forEach((title) => {
    const art = Cover.artFor(title);
    const pool = Cover.GENRE_PATTERNS[art.genre];
    assert.notEqual(art.genre, 'general', '《' + title + '》不该落到 general');
    assert.ok(pool.includes(art.pattern), art.genre + ' 类用了池外的图案 ' + art.pattern);
  });
});

test('视觉字长：中文算一个字、拉丁算半个', () => {
  assert.equal(Cover.visualLength(''), 0);
  assert.equal(Cover.visualLength('山海经'), 3);
  assert.equal(Cover.visualLength('abcd'), 2);
  assert.equal(Cover.visualLength('Web安全'), 1.5 + 2, 'Web安全 应为 1.5 + 2');
});

test('书名字号随字数单调不增，且始终落在可读区间', () => {
  const samples = ['书', '山海经', 'Web安全学习笔记', 'Hello-CTF - 开源CTF入门教程',
    'The Project Gutenberg eBook of 山海經', '一'.repeat(80)];
  let prev = Infinity;
  samples.forEach((t) => {
    const size = Cover.titleScale(t);
    assert.ok(size <= prev, '《' + t + '》的字号没随字数下降：' + size + ' > ' + prev);
    assert.ok(size >= 14 && size <= 30, '《' + t + '》的字号越界：' + size);
    prev = size;
  });
});

test('水印首字：中文取首字，拉丁转大写，会跳过书名号', () => {
  assert.equal(Cover.initialOf('山海经'), '山');
  assert.equal(Cover.initialOf('web安全'), 'W');
  assert.equal(Cover.initialOf('《三体》'), '三');
  assert.equal(Cover.initialOf('   '), '?');
  assert.equal(Cover.initialOf(null), '?');
});
