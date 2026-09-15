const test = require('node:test');
const assert = require('node:assert/strict');
const Exporter = require('../src/exporter.js');

function makeBook() {
  const specs = [
    { title: '前言', text: '前言内容' },
    { title: '第146章 ICS - 工控安全', text: '章节正文' },
    { title: '第147章 逻辑漏洞', text: '章节正文' }
  ];
  let cursor = 0;
  const chapters = specs.map((s, i) => {
    const start = cursor;
    cursor += s.text.length;
    return { index: i, title: s.title, start, end: cursor, text: s.text };
  });
  return { title: 'Hello-CTF', text: 'x', totalChars: cursor, chapters };
}

// 只当「某个固定时刻」用：formatDateTime 按**本地时区**渲染，
// 所以任何断言都不能直接拿这个 UTC 毫秒数去比对写死的日期字符串。
const T = Date.UTC(2026, 8, 14, 2, 10); // 2026-09-14 02:10 UTC

test('formatDateTime 输出可读时间，非法输入回退到 0 时刻', () => {
  assert.equal(Exporter.formatDateTime(new Date(2026, 8, 14, 2, 10)), '2026-09-14 02:10');
  assert.equal(Exporter.formatDateTime(new Date(2026, 0, 5, 9, 3)), '2026-01-05 09:03');
  assert.equal(Exporter.formatDateTime('不是时间').length, 16);
});

test('sanitizeFileName 去掉非法字符并限长', () => {
  assert.equal(Exporter.sanitizeFileName('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
  assert.equal(Exporter.sanitizeFileName('   '), '未命名');
  assert.equal(Exporter.sanitizeFileName('', '备用名'), '备用名');
  assert.equal(Exporter.sanitizeFileName('...hidden'), 'hidden');
  assert.equal(Exporter.sanitizeFileName('x'.repeat(200)).length, 80);
});

test('没有标注时给出明确提示而不是空文件', () => {
  const md = Exporter.toMarkdown(makeBook(), [], { now: T, sourceName: 'book.txt' });
  assert.ok(md.includes('# Hello-CTF · 读书笔记'));
  assert.ok(md.includes('- 来源文件：book.txt'));
  assert.ok(md.includes('- 划线 0 条'));
  assert.ok(md.includes('这本书还没有任何划线'));
});

test('按章节分组、按位置排序，并给出统计', () => {
  const book = makeBook();
  const annotations = [
    { chapterIndex: 2, start: 5, end: 9, text: '第二条', color: 'green', note: '有批注' },
    { chapterIndex: 1, start: 20, end: 30, text: '后划线但位置靠后', color: 'yellow' },
    { chapterIndex: 1, start: 2, end: 8, text: '先划线', color: 'pink', note: '' }
  ];

  const md = Exporter.toMarkdown(book, annotations, { now: T, sourceName: 'book.txt' });

  assert.ok(md.includes('- 划线 3 条，其中 1 条含批注'));
  // 章节顺序：146 在 147 之前
  assert.ok(md.indexOf('## 第146章 ICS - 工控安全') < md.indexOf('## 第147章 逻辑漏洞'));
  // 同章内位置：先划线排在前面
  assert.ok(md.indexOf('先划线') < md.indexOf('后划线但位置靠后'));
  // 编号全局递增
  assert.ok(md.includes('### 1 · 粉色'));
  assert.ok(md.includes('### 2 · 黄色'));
  assert.ok(md.includes('### 3 · 绿色'));
  assert.ok(!md.includes('## 前言'), '没有标注的章节不应出现');
});

test('带批注的条目输出批注，不带的只输出原文', () => {
  const book = makeBook();
  const md = Exporter.toMarkdown(book, [
    { chapterIndex: 1, start: 0, end: 4, text: '有批注的原文', color: 'yellow', note: '要背下来' },
    { chapterIndex: 1, start: 10, end: 14, text: '没批注的原文', color: 'yellow', note: '' }
  ], { now: T, sourceName: 'b.txt' });

  assert.ok(md.includes('> 有批注的原文'));
  assert.ok(md.includes('**批注**：要背下来'));
  assert.ok(md.includes('> 没批注的原文'));
  assert.equal((md.match(/\*\*批注\*\*/g) || []).length, 1);
});

test('原文里的 Markdown 记号不会破坏文档结构', () => {
  const book = makeBook();
  const md = Exporter.toMarkdown(book, [
    { chapterIndex: 1, start: 0, end: 10, text: '# 这不是标题\n> 也不是引用', color: 'yellow', note: '含 `代码` 与 **加粗**' }
  ], { now: T, sourceName: 'b.txt' });

  assert.ok(md.includes('> # 这不是标题'), '原文中的 # 应被引用块包住');
  assert.ok(md.includes('> > 也不是引用'), '原文中的 > 也应被引用块包住');
  // 批注内容原样保留（是用户自己写的 Markdown，可接受）
  assert.ok(md.includes('**批注**：含 `代码` 与 **加粗**'));
  // 不应产生多级标题层级错乱：只有一级和二级、三级标题
  assert.equal((md.match(/^# /gm) || []).length, 1);
});

test('章节结构变化导致无法定位的标注会被统计并跳过', () => {
  const book = makeBook();
  const md = Exporter.toMarkdown(book, [
    { chapterIndex: 1, start: 0, end: 3, text: '正常', color: 'yellow' },
    { chapterIndex: 99, start: 0, end: 3, text: '失效的', color: 'yellow' }
  ], { now: T, sourceName: 'b.txt' });

  assert.ok(md.includes('- 划线 1 条'));
  assert.ok(md.includes('另有 1 条因章节结构变化无法定位'));
  assert.ok(!md.includes('失效的'));
});

test('批注里的换行被压平，避免破坏列表结构', () => {
  const book = makeBook();
  const md = Exporter.toMarkdown(book, [
    { chapterIndex: 1, start: 0, end: 3, text: '原文', color: 'yellow', note: '第一行\n第二行' }
  ], { now: T, sourceName: 'b.txt' });

  assert.ok(md.includes('**批注**：第一行 第二行'));
});

test('时间戳由调用方注入，输出可复现', () => {
  const book = makeBook();
  const args = [{ chapterIndex: 1, start: 0, end: 3, text: '原文', color: 'yellow' }];

  // 同一个 now 导出两次，必须逐字节一致
  const a = Exporter.toMarkdown(book, args, { now: T, sourceName: 'b.txt' });
  const b = Exporter.toMarkdown(book, args, { now: T, sourceName: 'b.txt' });
  assert.equal(a, b, '同一 now 两次导出应完全一致');

  // 关键：formatDateTime 按本地时区渲染，期望值必须用**本地时间**构造。
  // 之前这里写死 Date.UTC(...) 配 '10:10'，只在东八区成立，CI（UTC）必挂。
  const localTenPastTen = new Date(2026, 8, 14, 10, 10).getTime();
  const c = Exporter.toMarkdown(book, args, { now: localTenPastTen, sourceName: 'b.txt' });
  assert.ok(c.includes('- 导出时间：2026-09-14 10:10'), '导出时间应按本地时区渲染注入的 now');

  // now 改变 → 正文必须随之改变，证明用的是注入值而不是内部 Date.now()
  const d = Exporter.toMarkdown(book, args, { now: localTenPastTen + 60 * 1000, sourceName: 'b.txt' });
  assert.notEqual(c, d, 'now 变化后导出结果应随之变化');
});

test('章节标题缺失时用序号兜底', () => {
  const book = makeBook();
  const md = Exporter.toMarkdown(book, [
    { chapterIndex: 1, start: 0, end: 3, text: '原文', color: 'yellow' }
  ], { now: T });
  assert.ok(md.includes('## 第146章 ICS - 工控安全'));
  assert.ok(!md.includes('- 来源文件：'));
});
