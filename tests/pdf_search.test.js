/**
 * PDF 全文搜索与文字层的纯逻辑测试。
 *
 * 这一层最容易被「看起来对」蒙过去：PDF 的文字片段切得碎、还夹着排版换行，
 * 按原文逐字比对时，用户明明看得见那两个词挨着，程序却说搜不到。
 * 所以这里专门盯住「去空白坐标系」与「跨片段命中」两件事。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const Pdf = require('../src/pdf.js');

/* ---------------- pageTextOf ---------------- */

test('pageTextOf：把文字片段拼成整段，并按 hasEOL 补换行', () => {
  const text = Pdf.pageTextOf([
    { str: '第一行', hasEOL: true },
    { str: '第二行' },
    { str: '', hasEOL: true }
  ]);
  // 不补换行的话两行会粘成「第一行第二行」，搜索与摘要都会歪
  assert.equal(text, '第一行\n第二行\n');
});

test('pageTextOf：跳过没有 str 的条目（markedContent 之类），空输入返回空串', () => {
  assert.equal(Pdf.pageTextOf([{ type: 'beginMarkedContent' }, { str: 'X' }]), 'X');
  assert.equal(Pdf.pageTextOf([]), '');
  assert.equal(Pdf.pageTextOf(null), '');
});

/* ---------------- 去空白索引 ---------------- */

test('normalizeQuery：去空白 + 小写，全角空格与换行也算空白', () => {
  assert.equal(Pdf.normalizeQuery('  Hello World '), 'helloworld');
  assert.equal(Pdf.normalizeQuery('第 1 页'), '第1页');
  assert.equal(Pdf.normalizeQuery('第\u30001\u3000页'), '第1页');
  assert.equal(Pdf.normalizeQuery('A\nB'), 'ab');
  assert.equal(Pdf.normalizeQuery('   '), '');
  assert.equal(Pdf.normalizeQuery(null), '');
});

test('buildSearchIndex：norm 里每个字符都能通过 map 找回原文位置', () => {
  const src = 'ab cd';
  const idx = Pdf.buildSearchIndex(src);

  assert.equal(idx.text, src);
  assert.equal(idx.norm, 'abcd');
  assert.deepEqual(idx.map, [0, 1, 3, 4, 5]); // 末尾的 5 是哨兵

  // 索引里第 i 个字符必须等于原文 map[i] 处的字符（忽略大小写）
  for (let i = 0; i < idx.norm.length; i++) {
    assert.equal(idx.norm[i], src[idx.map[i]].toLowerCase());
  }
});

test('buildSearchIndex：大小写转换后长度变化的字符不做替换，保证 1:1 对应', () => {
  // 'İ' 整体 toLowerCase 会变成两个码元，长度一变 map 就全错位
  const idx = Pdf.buildSearchIndex('İx');
  assert.equal(idx.norm.length, idx.map.length - 1);
  assert.equal(idx.map.length, 3);
});

/* ---------------- searchPages ---------------- */

test('searchPages：普通英文命中，页号与区间都对得上', () => {
  const out = Pdf.searchPages(['Hello World', 'Second page'], 'world');

  assert.equal(out.total, 1);
  assert.equal(out.truncated, false);
  assert.equal(out.textPages, 2);

  const r = out.results[0];
  assert.equal(r.page, 1);
  assert.equal(r.offset, 6);
  assert.equal(r.length, 5);
  assert.equal(r.snippet, 'Hello World');
  assert.equal(r.snippet.slice(r.hitStart, r.hitEnd), 'World');
});

test('searchPages：关键词被排版换行/空格隔开时也能搜到（这是 PDF 的常态）', () => {
  const out = Pdf.searchPages(['你好 世界\n第二行'], '你好世界');

  assert.equal(out.total, 1);
  assert.equal(out.results[0].page, 1);
  // 区间要覆盖原文里那个空格（0..4 共 5 个码元），否则高亮会漏掉中间的空白
  assert.equal(out.results[0].offset, 0);
  assert.equal(out.results[0].length, 5);
});

test('searchPages：跨行命中，摘要里把换行折成空格', () => {
  const out = Pdf.searchPages(['你好 世界\n第二行'], '世界第二行');

  assert.equal(out.total, 1);
  assert.equal(out.results[0].offset, 3);
  assert.equal(out.results[0].length, 6);
  assert.ok(out.results[0].snippet.indexOf('世界 第二行') >= 0, out.results[0].snippet);
});

test('searchPages：大小写不敏感，多次命中不重叠', () => {
  const out = Pdf.searchPages(['aa AA aa'], 'aa');
  assert.deepEqual(out.results.map((r) => r.offset), [0, 3, 6]);
});

test('searchPages：空关键词、空页表都不会炸', () => {
  assert.equal(Pdf.searchPages(['abc'], '').total, 0);
  assert.equal(Pdf.searchPages(['abc'], '   ').total, 0);
  assert.equal(Pdf.searchPages([], 'a').total, 0);
  assert.equal(Pdf.searchPages(null, 'a').total, 0);
});

test('searchPages：单页命中数到上限就停，并标出已截断', () => {
  const out = Pdf.searchPages(['aa aa aa aa aa'], 'aa', { maxPerPage: 2 });
  assert.equal(out.total, 2);
  assert.equal(out.truncated, true);
});

test('searchPages：全书上限用满且后面还有页时，也算截断', () => {
  const out = Pdf.searchPages(['aa', 'aa', 'aa', 'aa'], 'aa', { maxResults: 2 });
  assert.equal(out.total, 2);
  assert.equal(out.truncated, true);
});

test('searchPages：命中数量没到上限时不能误报截断', () => {
  const out = Pdf.searchPages(['aa', 'bb'], 'aa', { maxResults: 10 });
  assert.equal(out.total, 1);
  assert.equal(out.truncated, false);
});

/* ---------------- spanRanges（文字层高亮） ---------------- */

test('spanRanges：命中落在一个片段里', () => {
  const ranges = Pdf.spanRanges(['Hello World'], 'world');
  assert.deepEqual(ranges, [{ spanIndex: 0, start: 6, end: 11, seq: 0 }]);
});

test('spanRanges：命中横跨两个片段时，两边各自切出该标的部分', () => {
  // 文字层里「一句话被切成多个 span」是常态，只对单个 span 做 indexOf 会漏
  const ranges = Pdf.spanRanges(['Hello ', 'World'], 'lowo');

  // 'Hello World' 里 'lowo' 落在原文 [3, 8)：第一个 span 的 [3,6)，第二个 span 的 [0,2)
  assert.equal(ranges.length, 2);
  assert.deepEqual(ranges[0], { spanIndex: 0, start: 3, end: 6, seq: 0 });
  assert.deepEqual(ranges[1], { spanIndex: 1, start: 0, end: 2, seq: 0 });
});

test('spanRanges：跨片段时把中间夹着的空白一并圈上，高亮才是连续的一段', () => {
  const ranges = Pdf.spanRanges(['aa ', ' bb'], 'aabb');

  // 两块拼起来覆盖 'aa  bb' 整段：中间那两个空格若切掉，高亮中间会断一截
  assert.deepEqual(ranges, [
    { spanIndex: 0, start: 0, end: 3, seq: 0 },
    { spanIndex: 1, start: 0, end: 3, seq: 0 }
  ]);
});

test('spanRanges：同一片段里多处命中，按出现顺序编号', () => {
  const ranges = Pdf.spanRanges(['aa bb aa'], 'aa');
  assert.deepEqual(ranges, [
    { spanIndex: 0, start: 0, end: 2, seq: 0 },
    { spanIndex: 0, start: 6, end: 8, seq: 1 }
  ]);
});

test('spanRanges：没命中 / 空输入都返回空数组', () => {
  assert.deepEqual(Pdf.spanRanges(['abc'], 'zzz'), []);
  assert.deepEqual(Pdf.spanRanges(['abc'], ''), []);
  assert.deepEqual(Pdf.spanRanges([], 'a'), []);
  assert.deepEqual(Pdf.spanRanges(null, 'a'), []);
});

/* ---------------- 引擎：文字层 ---------------- */

/** 造一个带 TextLayer 的假 pdf.js。 */
function makeMockLib() {
  const calls = { layers: [], cleared: 0 };

  function FakeTextLayer(params) {
    calls.layers.push(params);
    this.render = () => Promise.resolve();
    this.cancel = () => {};
  }

  const lib = {
    GlobalWorkerOptions: {},
    TextLayer: FakeTextLayer,
    getDocument: function () {
      return {
        promise: Promise.resolve({
          numPages: 1,
          getPage: function () {
            return Promise.resolve({
              getTextContent: function () {
                return Promise.resolve({ items: [{ str: 'A', hasEOL: true }, { str: 'B' }] });
              }
            });
          }
        })
      };
    }
  };

  return { lib: lib, calls: calls };
}

test('createEngine.textLayer：用同一个 viewport 交给 pdf.js 的 TextLayer', async () => {
  const mock = makeMockLib();
  const engine = Pdf.createEngine(() => Promise.resolve(mock.lib), 'worker.js');
  const doc = await engine.open(new Uint8Array([1]));

  const container = { textContent: '残留' };
  const viewport = { scale: 1.5 };
  const layer = await engine.textLayer(doc, 1, container, viewport);

  assert.equal(mock.calls.layers.length, 1);
  assert.equal(mock.calls.layers[0].container, container);
  assert.equal(mock.calls.layers[0].viewport, viewport);
  assert.equal(container.textContent, '', '渲染前必须清掉上一页的文字层');
  assert.equal(typeof layer.cancel, 'function');
});

test('createEngine.textLayer：内置 pdf.js 不含 TextLayer 时给出可读错误', async () => {
  const lib = { getDocument: () => ({ promise: Promise.resolve({ numPages: 1, getPage: () => Promise.resolve({}) }) }) };
  const engine = Pdf.createEngine(() => Promise.resolve(lib), 'w.js');
  const doc = await engine.open(new Uint8Array([1]));

  await assert.rejects(engine.textLayer(doc, 1, { textContent: '' }, { scale: 1 }), /TextLayer/);
});

test('createEngine.render：把 viewport 一起返回，供文字层复用', async () => {
  const mock = makeMockLib();
  const engine = Pdf.createEngine(() => Promise.resolve(mock.lib), 'w.js');
  const doc = await engine.open(new Uint8Array([1]));

  const canvas = {
    width: 0, height: 0, style: {},
    getContext: () => ({ setTransform() {}, clearRect() {} })
  };

  // 这个 mock 的 page 没有 render，用带 render 的最小替身
  const fakeDoc = {
    getPage: () => Promise.resolve({
      getViewport: (p) => ({ width: 100 * p.scale, height: 200 * p.scale, scale: p.scale }),
      render: () => ({ promise: Promise.resolve() })
    })
  };

  const out = await engine.render(fakeDoc, 1, canvas, 2);
  assert.equal(out.viewport.scale, 2, '文字层必须拿到与 canvas 相同的 viewport');
  assert.equal(out.width, 200);
});

/* ---------------- 扫描件判据 ---------------- */

test('isProbablyScanned：正常文档不会被误判成扫描件', () => {
  // 4 页共 3000 字 ≈ 750 字/页，离阈值很远
  assert.equal(Pdf.isProbablyScanned(4, 3000), false);
  // 单页上千字的参考卡
  assert.equal(Pdf.isProbablyScanned(1, 1200), false);
  // 刚好卡在阈值上（20 字/页）算「有文字层」
  assert.equal(Pdf.isProbablyScanned(10, 200), false);
});

test('isProbablyScanned：整本零字 / 只有页眉页脚的扫描件要判出来', () => {
  assert.equal(Pdf.isProbablyScanned(40, 0), true);
  // 40 页每页一行 11 字页眉 = 440 字 → 是扫描件（这条就是原来的漏判）
  assert.equal(Pdf.isProbablyScanned(40, 440), true);
  assert.equal(Pdf.isProbablyScanned(10, 199), true);
});

test('isProbablyScanned：页数为 0 时不乱判', () => {
  assert.equal(Pdf.isProbablyScanned(0, 0), false);
  assert.equal(Pdf.isProbablyScanned(NaN, 100), false);
});

test('searchPages：只有页眉的扫描件会被标成 looksScanned，且不再是「整本零字」那种判据', () => {
  // 每页一行页眉 —— 旧判据（整本一个字都没有）在这里必然失效
  const pages = new Array(40).fill('学丞·晓艳英语');
  const out = Pdf.searchPages(pages, '的');

  assert.equal(out.total, 0);
  assert.equal(out.textPages, 40, '每页都有那一行页眉，所以「有文字的页数」是 40');
  assert.equal(out.looksScanned, true, '字密度极低 → 应当判成扫描件');
});

test('searchPages：真正的文字版 PDF 不会因为搜不到词就被说成扫描件', () => {
  // 夹具必须按**真实页面**的规模来写：一页中文正文几百字，字密度离阈值极远。
  // 用十几字一页的输入去测这条，夹具本身就会被判成扫描件（那是夹具不真实，不是判据错）。
  const para = '这一页讲的是网络安全基础，包括常见漏洞原理、利用方式与防护手段。' +
    '学习时应该先理解协议本身，再看攻击面在哪里，最后才去记工具用法。';
  const pages = [para, para, para];
  assert.ok(pages[0].length > 40, '夹具一页得有几十字以上才有代表性');

  const out = Pdf.searchPages(pages, '不存在的词');

  assert.equal(out.total, 0);
  assert.equal(out.looksScanned, false, '有真正文 → 只是没搜到该词，不能说人家是扫描件');
});
