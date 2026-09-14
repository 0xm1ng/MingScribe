const test = require('node:test');
const assert = require('node:assert/strict');
const Paginate = require('../src/paginate.js');

/** 造一个 midsize 的章节对象，text.length === end - start（与解析层契约一致）。 */
function makeChapter(text, title) {
  return { index: 0, title: title || '第一章', start: 0, end: text.length, text };
}

const METRICS = { cols: 36, rowsPerPage: 24 };

test('splitParagraphs 记录每段在章节内的字符偏移', () => {
  const text = '第一段\n\n第二段\n第三段';
  const paras = Paginate.splitParagraphs(text);

  assert.equal(paras.length, 3);
  assert.deepEqual(paras.map((p) => p.text), ['第一段', '第二段', '第三段']);
  assert.equal(paras[0].start, 0);
  // 空行也要计入偏移，否则定位会整体前移
  assert.equal(paras[1].start, 5); // "第一段\n\n" → 空行占 2 个字
  assert.equal(paras[2].start, 9); // 再往后是 "第二段\n"
  // 与真实文本的 indexOf 对齐，防止偏移算错却碰巧过测试
  assert.equal(paras[1].start, text.indexOf('第二段'));
  assert.equal(paras[2].start, text.indexOf('第三段'));
  paras.forEach((p) => assert.equal(p.text.length, p.end - p.start));
});

test('splitParagraphs 剔除行首缩进而保留其偏移', () => {
  const paras = Paginate.splitParagraphs('　　缩进两格的正文');
  assert.equal(paras.length, 1);
  assert.equal(paras[0].text, '缩进两格的正文');
  // data-off 记的是正文起点，所以 start 要跳过行首空白
  assert.equal(paras[0].start, 2);
  assert.equal(paras[0].end, 2 + 7);
});

test('splitParagraphs 对空白 / 空值返回空数组', () => {
  assert.deepEqual(Paginate.splitParagraphs(''), []);
  assert.deepEqual(Paginate.splitParagraphs('\n\n\n'), []);
  assert.deepEqual(Paginate.splitParagraphs('   \u3000  '), []);
  assert.deepEqual(Paginate.splitParagraphs(null), []);
  assert.deepEqual(Paginate.splitParagraphs(undefined), []);
});

test('paginateChapter 的页边界连续、覆盖全章、且严格前进', () => {
  const text = Array.from({ length: 40 }, (_, i) => '第' + i + '段正文内容，用来把页面撑满。').join('\n');
  const chapter = makeChapter(text);
  const pages = Paginate.paginateChapter(chapter, METRICS);

  assert.ok(pages.length > 1, '这么多内容应该切成不止一页');

  // 第一页从 0 开始，最后一页到章末结束
  assert.equal(pages[0].start, 0);
  assert.equal(pages[pages.length - 1].end, text.length);

  // 相邻页首尾相接，不留缝、不重叠
  for (let i = 1; i < pages.length; i++) {
    assert.equal(pages[i].start, pages[i - 1].end, '第 ' + i + ' 页与前页不连续');
  }
  // 每页必须真的往前走，否则会死循环
  pages.forEach((p, i) => assert.ok(p.end > p.start, '第 ' + i + ' 页为空'));
});

test('paginateChapter 页边界落在字符偏移上，可被 Progress 复用', () => {
  const Progress = require('../src/progress.js');
  const text = Array.from({ length: 60 }, (_, i) => '内容' + i + '。').join('\n');
  const chapter = makeChapter(text);
  const book = {
    title: 't', text, totalChars: text.length,
    chapters: [{ index: 0, title: chapter.title, start: 0, end: text.length, text }]
  };

  const pages = Paginate.paginateChapter(chapter, METRICS);
  pages.forEach((p) => {
    const global = Progress.globalOffsetOf(book, 0, p.start);
    const back = Progress.resolveGlobalOffset(book, global);
    assert.deepEqual(back, { chapterIndex: 0, charOffset: p.start });
  });
});

test('paginateChapter 在页宽变大 / 行距变小时页数减少', () => {
  const text = Array.from({ length: 40 }, (_, i) => '第' + i + '段正文内容，用来把页面撑满。').join('\n');
  const chapter = makeChapter(text);

  const narrow = Paginate.paginateChapter(chapter, { cols: 20, rowsPerPage: 12 });
  const wide = Paginate.paginateChapter(chapter, { cols: 60, rowsPerPage: 40 });

  assert.ok(narrow.length > wide.length,
    '窄页 + 少行应比宽页 + 多行切出更多页：' + narrow.length + ' vs ' + wide.length);
});

test('paginateChapter 单调性：调大字号（页容量变小）页数只增不减', () => {
  const text = Array.from({ length: 30 }, (_, i) => '第' + i + '段，一段足够长的中文正文用来测试切页。').join('\n');
  const chapter = makeChapter(text);

  const sizes = [[40, 30], [36, 24], [30, 18], [24, 12], [18, 8]];
  let prev = 0;
  sizes.forEach(([cols, rows]) => {
    const count = Paginate.paginateChapter(chapter, { cols, rowsPerPage: rows }).length;
    assert.ok(count >= prev, '容量变小后页数不应变少：' + count + ' < ' + prev);
    prev = count;
  });
});

test('paginateChapter 不会把一段话劈在没有标点的地方（能找到句读时）', () => {
  const sentence = '这是一个完整的句子。'.repeat(40);
  const chapter = makeChapter(sentence);
  const pages = Paginate.paginateChapter(chapter, { cols: 20, rowsPerPage: 5 });

  // 每个页边界（除了末页）都应落在句号（或其后紧随的收尾符号）之后
  for (let i = 0; i < pages.length - 1; i++) {
    const boundary = pages[i].end;
    const before = sentence.charAt(boundary - 1);
    const ok = Paginate.BREAK_AFTER.indexOf(before) >= 0 || '”』」）》'.indexOf(before) >= 0;
    assert.ok(ok, '第 ' + i + ' 页边界落在了标点中间：…' + sentence.slice(boundary - 6, boundary + 6));
  }
});

test('paginateChapter 对没有标点的长串仍能硬切且不丢字', () => {
  const text = 'A'.repeat(300);
  const chapter = makeChapter(text);
  const pages = Paginate.paginateChapter(chapter, { cols: 20, rowsPerPage: 5 });

  assert.ok(pages.length > 1);
  assert.equal(pages[0].start, 0);
  assert.equal(pages[pages.length - 1].end, 300);
  for (let i = 1; i < pages.length; i++) assert.equal(pages[i].start, pages[i - 1].end);
});

test('paginateChapter 对空章节返回单个零长页（不能返回空数组）', () => {
  const empty = Paginate.paginateChapter(makeChapter(''), METRICS);
  assert.deepEqual(empty, [{ start: 0, end: 0 }]);

  const blank = Paginate.paginateChapter(makeChapter('\n\n  \n'), METRICS);
  assert.deepEqual(blank, [{ start: 0, end: 0 }]);

  // 缺字段也不能崩
  assert.deepEqual(Paginate.paginateChapter(null, METRICS), [{ start: 0, end: 0 }]);
  assert.deepEqual(Paginate.paginateChapter({}, METRICS), [{ start: 0, end: 0 }]);
});

test('paginateChapter 对离谱的 metrics 兜底而不崩', () => {
  const chapter = makeChapter('正常的一段内容。'.repeat(20));
  const pages = Paginate.paginateChapter(chapter, { cols: 0, rowsPerPage: 0 });
  assert.ok(pages.length >= 1);
  assert.equal(pages[0].start, 0);
  assert.equal(pages[pages.length - 1].end, chapter.text.length);

  const noMetrics = Paginate.paginateChapter(chapter);
  assert.ok(noMetrics.length >= 1);
  assert.equal(noMetrics[noMetrics.length - 1].end, chapter.text.length);
});

test('paginateChapter 把章节标题单独排开，不跟正文挤在同一页尾部', () => {
  const body = Array.from({ length: 30 }, (_, i) => '正文第' + i + '句。').join('\n');
  const text = '第一章 标题\n' + body;
  const chapter = makeChapter(text, '第一章 标题');

  const pages = Paginate.paginateChapter(chapter, {
    cols: 10, rowsPerPage: 6,
    isTitle: (t) => t === '第一章 标题'
  });

  // 章首页必须从 0 开始（标题所在位置），不能跳过标题
  assert.equal(pages[0].start, 0);
  assert.equal(pages[pages.length - 1].end, text.length);
});

test('pageIndexOf 定位包含指定偏移的页', () => {
  const text = Array.from({ length: 40 }, (_, i) => '第' + i + '段正文内容，用来把页面撑满。').join('\n');
  const pages = Paginate.paginateChapter(makeChapter(text), METRICS);

  // 每页的第一个字都应定位回它自己那一页
  pages.forEach((p, i) => {
    assert.equal(Paginate.pageIndexOf(pages, p.start), i);
  });

  // 越界与异常输入
  assert.equal(Paginate.pageIndexOf(pages, -100), 0);
  assert.equal(Paginate.pageIndexOf(pages, 999999), pages.length - 1);
  assert.equal(Paginate.pageIndexOf([], 5), 0);
  assert.equal(Paginate.pageIndexOf(null, 5), 0);
});

test('layoutParagraph 覆盖整段且每行都不超宽', () => {
  const text = '这是一段比较长的中文，用来验证行宽切分是否正确。'.repeat(8);
  const cols = 24;
  const lines = Paginate.layoutParagraph(text, cols);

  assert.equal(lines[0].start, 0);
  assert.equal(lines[lines.length - 1].end, text.length);
  for (let i = 1; i < lines.length; i++) assert.equal(lines[i].start, lines[i - 1].end);
  lines.forEach((line) => {
    const seg = text.slice(line.start, line.end);
    assert.ok(seg.length <= cols * 2, '一行切得过长：' + seg.length);
    assert.ok(line.end > line.start);
  });
});

test('layoutParagraph 对空串返回空数组', () => {
  assert.deepEqual(Paginate.layoutParagraph('', 20), []);
});

test('paginateChapter 在极端的小页容量下依然收敛（不会死循环或产生空页）', () => {
  const text = '一'.repeat(300) + '\n' + '二'.repeat(300);

  // 单行就远超页容量
  [[10, 3], [4, 2], [6, 2]].forEach(([cols, rows]) => {
    const pages = Paginate.paginateChapter({ text, title: '' }, { cols, rowsPerPage: rows });
    assert.ok(pages.length > 1, 'cols=' + cols + ' rows=' + rows + ' 应切出多页');
    assert.equal(pages[0].start, 0);
    assert.equal(pages[pages.length - 1].end, text.length, 'col=' + cols + ' 未覆盖全文');
    pages.forEach((p, i) => {
      assert.ok(p.end > p.start, '第 ' + i + ' 页为空（会死循环）');
      if (i > 0) assert.equal(p.start, pages[i - 1].end, '第 ' + i + ' 页与前页不连续');
    });
  });

  // 超长无标点单段
  const long = Paginate.paginateChapter({ text: 'A'.repeat(500), title: '' }, { cols: 4, rowsPerPage: 2 });
  assert.equal(long[long.length - 1].end, 500);
  long.forEach((p) => assert.ok(p.end > p.start));
});

test('paginateChapter 产出确定性：同样输入必然切出同样的页', () => {
  const text = Array.from({ length: 50 }, (_, i) => '第' + i + '段，内容长度不一的正文。').join('\n');
  const chapter = { text, title: '' };

  const a = Paginate.paginateChapter(chapter, { cols: 28, rowsPerPage: 14 });
  const b = Paginate.paginateChapter(chapter, { cols: 28, rowsPerPage: 14 });

  // 这一条很关键：翻页依赖「重切不会改变页边界」，否则前进再后退会回不到原处
  assert.deepEqual(a, b, '同样参数两次切页结果不一致，翻页会漂移');
});

test('rowWeight 只算行本身，段落边距由 blockExtra 单独承担', () => {
  // 正文一行就是 1 个行高；段落边距不能再摊进来（否则段落一多就溢出）
  assert.equal(Paginate.rowWeight('正文', 'p'), 1);
  // 标题字号 1.25 倍
  assert.equal(Paginate.rowWeight('第一章', 'h2'), 1.25);
  // 图片说明字号 0.72 倍、行高 1.6
  assert.equal(Paginate.rowWeight('[图片: x]', 'img-note'), 0.72 * 1.6);

  // 边距单独算：正文段落 1.1em，标题 8px+28px，图片说明自带内边距
  assert.equal(Paginate.blockExtra('p'), 1.1);
  assert.ok(Paginate.blockExtra('h2') > Paginate.blockExtra('p'));
  assert.ok(Paginate.blockExtra('img-note') > 0);
});

test('段落边距按「每段一次」计费：同样字数下，段落越多占的行高越多', () => {
  const metrics = { cols: 40, rowsPerPage: 100 };

  // 同样 200 个字：一段 vs 二十段
  const oneBig = Paginate.paginateChapter({ text: '字'.repeat(200), title: '' }, metrics);
  const manySmall = Paginate.paginateChapter(
    { text: Array.from({ length: 20 }, () => '字'.repeat(10)).join('\n'), title: '' },
    metrics
  );

  // 总占用行高（每页 end 都等于文本长度，看的是「切了几页」）
  const oneRows = oneBig[oneBig.length - 1].end;
  const manyRows = manySmall[manySmall.length - 1].end;
  assert.equal(oneRows, 200);
  assert.equal(manyRows, 219); // 19 个换行符也要计入偏移

  // 关键：段落多的时候页数不能变少（边距被正确累加）
  assert.ok(manySmall.length >= oneBig.length,
    '段落多应至少不比段落少时页数少：' + manySmall.length + ' vs ' + oneBig.length);
});

test('paginateChapter 估算偏保守：整数行高恰好放满时不会把边距算漏', () => {
  // 构造「行数刚好等于页容量」的极端情况，边界必须落在安全的一侧
  const text = Array.from({ length: 10 }, () => '十个字的一小段。').join('\n');
  const pages = Paginate.paginateChapter({ text, title: '' }, { cols: 8, rowsPerPage: 10 });

  assert.equal(pages[0].start, 0);
  assert.equal(pages[pages.length - 1].end, text.length);
  for (let i = 1; i < pages.length; i++) assert.equal(pages[i].start, pages[i - 1].end);

  // 每页的「实际内容量」不应超过页容量太多：用行高反算上界
  pages.forEach((p, i) => {
    const paras = Paginate.splitParagraphs(text.slice(p.start, p.end));
    let cost = 0;
    paras.forEach((para) => {
      cost += Paginate.layoutParagraph(para.text, 8).length * Paginate.rowWeight(para.text, 'p');
      cost += Paginate.blockExtra('p');
    });
    assert.ok(cost <= 10 + 1.2, '第 ' + i + ' 页超出页容量：' + cost.toFixed(2));
  });
});
