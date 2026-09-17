/**
 * PDF 支持层测试。
 *
 * 分两类：
 *  ① 纯函数（页码 / 缩放 / 中间格式）——不依赖浏览器；
 *  ② 引擎胶水（createEngine）——用 mock 的 pdf.js 喂进去，验证「我们怎么调用它」。
 *     真去渲染 PDF 是端到端脚本的事，不进单元测试（跑一次要拉几 MB 的 worker）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const Pdf = require('../src/pdf.js');
const Progress = require('../src/progress.js');

/* ---------------- ① 纯逻辑 ---------------- */

test('isPdfName：只认 .pdf 结尾，且不分大小写', () => {
  assert.equal(Pdf.isPdfName('note.pdf'), true);
  assert.equal(Pdf.isPdfName('NOTE.PDF'), true);
  assert.equal(Pdf.isPdfName('note.pdf.txt'), false);
  assert.equal(Pdf.isPdfName('note.txt'), false);
  assert.equal(Pdf.isPdfName(''), false);
  assert.equal(Pdf.isPdfName(null), false);
});

test('syntheticBook：一页 = 一章，start=i / end=i+1', () => {
  const book = Pdf.syntheticBook(3, '测试');

  assert.equal(book.chapters.length, 3);
  assert.equal(book.totalChars, 3);
  assert.equal(book.title, '测试');
  book.chapters.forEach((c, i) => {
    assert.equal(c.start, i);
    assert.equal(c.end, i + 1);
    assert.equal(c.title, '第 ' + (i + 1) + ' 页');
  });
});

test('syntheticBook：页数非法时退化成 0 页而不是抛错', () => {
  assert.equal(Pdf.syntheticBook(0).chapters.length, 0);
  assert.equal(Pdf.syntheticBook(-5).chapters.length, 0);
  assert.equal(Pdf.syntheticBook('abc').chapters.length, 0);
  assert.equal(Pdf.syntheticBook(null).chapters.length, 0);
});

test('syntheticBook + Progress：进度百分比 = 已读页数 / 总页数', () => {
  const book = Pdf.syntheticBook(4, '四页');

  // 停在第 1 页就该是 25%，不能是 0%（那会让人以为没读过）
  const r1 = Progress.makeRecord(book, { key: 'k', name: 'a.pdf', size: 1 }, 0, Pdf.pageOffset(), 0);
  assert.equal(r1.percent, 25);

  const r4 = Progress.makeRecord(book, { key: 'k', name: 'a.pdf', size: 1 }, 3, Pdf.pageOffset(), 0);
  assert.equal(r4.percent, 100);

  // 越界页号会被夹回合法范围，不会算出 150%
  const rOver = Progress.makeRecord(book, { key: 'k', name: 'a.pdf', size: 1 }, 99, Pdf.pageOffset(), 0);
  assert.equal(rOver.percent, 100);
  assert.equal(rOver.chapterIndex, 3);
});

test('clampPage：夹在 1 ~ 总页数之间', () => {
  assert.equal(Pdf.clampPage(0, 10), 1);
  assert.equal(Pdf.clampPage(-3, 10), 1);
  assert.equal(Pdf.clampPage(5, 10), 5);
  assert.equal(Pdf.clampPage(99, 10), 10);
  // 总页数未知（0）时不做上限裁剪，避免把页码全压成 1
  assert.equal(Pdf.clampPage(7, 0), 7);
});

test('pageLabel：显示「当前 / 总数」，总页数未知时显示占位符', () => {
  assert.equal(Pdf.pageLabel(1, 10), '1 / 10');
  assert.equal(Pdf.pageLabel(99, 10), '10 / 10');
  assert.equal(Pdf.pageLabel(1, 0), '—');
});

test('clampScale：限制在可用区间内，非法值退回 1', () => {
  assert.equal(Pdf.clampScale(1), 1);
  assert.equal(Pdf.clampScale(0), 1);
  assert.equal(Pdf.clampScale(-2), 1);
  assert.equal(Pdf.clampScale(NaN), 1);
  assert.equal(Pdf.clampScale(0.01), Pdf.SCALE_MIN);
  assert.equal(Pdf.clampScale(999), Pdf.SCALE_MAX);
});

test('fitScale：适应宽度按宽度算，整页按两边里更小的算', () => {
  const avail = { width: 800, height: 600 };
  const page = { width: 400, height: 800 }; // 竖版

  assert.equal(Pdf.fitScale(avail, page, 'width'), 2);     // 800/400
  assert.equal(Pdf.fitScale(avail, page, 'page'), 0.75);   // min(2, 600/800)
  assert.equal(Pdf.fitScale(avail, page, 1.25), 1.25);     // 固定倍率原样返回
  // 未知模式按适应宽度处理，不会返回 NaN
  assert.equal(Pdf.fitScale(avail, page, 'whatever'), 2);
});

test('fitScale：尺寸为 0 或缺失时不产生 NaN / Infinity', () => {
  const s = Pdf.fitScale({ width: 0, height: 0 }, { width: 0, height: 0 }, 'width');
  assert.ok(isFinite(s) && s > 0, '得到 ' + s);
});

test('stepScale：在档位间前后跳，触底/触顶后停住', () => {
  assert.equal(Pdf.stepScale(1, 1), 1.25);
  assert.equal(Pdf.stepScale(1.3, 1), 1.5);
  assert.equal(Pdf.stepScale(1, -1), 0.8);
  // 已在最大档继续放大 → 上限；已在最小档继续缩小 → 下限
  assert.equal(Pdf.stepScale(Pdf.SCALE_MAX, 1), Pdf.SCALE_MAX);
  assert.equal(Pdf.stepScale(Pdf.SCALE_MIN, -1), Pdf.SCALE_MIN);
  // 任意缩放都能跳回档位，不会卡在 1.37 这种值上
  assert.equal(Pdf.stepScale(1.37, 1), 1.5);
  assert.equal(Pdf.stepScale(1.37, -1), 1.25);
});

test('scaleLabel：四舍五入成百分比', () => {
  assert.equal(Pdf.scaleLabel(1), '100%');
  assert.equal(Pdf.scaleLabel(1.25), '125%');
  assert.equal(Pdf.scaleLabel(0.666), '67%');
});

test('vendorUrl：没有 document 时也不会抛，返回相对路径', () => {
  const url = Pdf.vendorUrl(Pdf.WORKER_FILE);
  assert.equal(typeof url, 'string');
  assert.ok(url.indexOf(Pdf.WORKER_FILE) >= 0, url);
});

/* ---------------- ② 引擎胶水（mock pdf.js） ---------------- */

/** 造一个假的 pdf.js：只记录调用参数，不做真实渲染。 */
function makeMockLib(pageCount, size) {
  const calls = { getDocument: null, render: [], workerSrc: null };

  function makePage() {
    return {
      getViewport: function (params) {
        return { width: size.width * params.scale, height: size.height * params.scale };
      },
      render: function (params) {
        calls.render.push({ viewport: params.viewport, canvas: params.canvasContext });
        return { promise: Promise.resolve() };
      },
      getTextContent: function () {
        return Promise.resolve({ items: [{ str: '你好' }, { str: '世界' }] });
      }
    };
  }

  const lib = {
    GlobalWorkerOptions: {},
    getDocument: function (opts) {
      calls.getDocument = opts;
      return { promise: Promise.resolve({ numPages: pageCount, getPage: function () { return Promise.resolve(makePage()); } }) };
    }
  };

  return { lib: lib, calls: calls };
}

/** 造一个假的 canvas：只需要宽高、style 和 2d 上下文。 */
function makeCanvas() {
  return {
    width: 0,
    height: 0,
    style: {},
    getContext: function () {
      return { setTransform: function () {}, clearRect: function () {} };
    }
  };
}

test('createEngine：把 cMaps / 标准字体路径与 worker 一起交给 pdf.js', async () => {
  const mock = makeMockLib(7, { width: 595, height: 842 });
  const engine = Pdf.createEngine(function () { return Promise.resolve(mock.lib); }, 'worker.js');

  const doc = await engine.open(new Uint8Array([1, 2, 3]));
  assert.equal(doc.numPages, 7);

  const opts = mock.calls.getDocument;
  assert.equal(mock.lib.GlobalWorkerOptions.workerSrc, 'worker.js');
  assert.ok(opts.cMapUrl.indexOf('cmaps/') >= 0, '中文 PDF 缺了 cMaps 会整页缺字');
  assert.equal(opts.cMapPacked, true);
  assert.ok(opts.standardFontDataUrl.indexOf('standard_fonts/') >= 0);
  // 一次只取用到的对象，否则大文件会把内存吃光
  assert.equal(opts.disableAutoFetch, true);
});

test('createEngine：渲染按设备像素比放大位图，CSS 尺寸另算', async () => {
  const mock = makeMockLib(2, { width: 500, height: 1000 });
  const engine = Pdf.createEngine(function () { return Promise.resolve(mock.lib); }, 'worker.js');

  const doc = await engine.open(new Uint8Array([1]));
  const canvas = makeCanvas();
  const out = await engine.render(doc, 1, canvas, 2);

  assert.equal(canvas.style.width, '1000px');
  assert.equal(canvas.style.height, '2000px');
  // Node 里没有 window，devicePixelRatio 取 1
  assert.equal(canvas.width, 1000);
  assert.equal(canvas.height, 2000);
  assert.equal(out.width, 1000);
});

test('createEngine：pageSize 取的是 scale=1 的原始尺寸', async () => {
  const mock = makeMockLib(2, { width: 595, height: 842 });
  const engine = Pdf.createEngine(function () { return Promise.resolve(mock.lib); }, 'worker.js');

  const doc = await engine.open(new Uint8Array([1]));
  const size = await engine.pageSize(doc, 1);
  assert.deepEqual(size, { width: 595, height: 842 });
});

test('createEngine：text 把一页的文字片段拼成整串（扫描件为空串）', async () => {
  const mock = makeMockLib(1, { width: 10, height: 10 });
  const engine = Pdf.createEngine(function () { return Promise.resolve(mock.lib); }, 'worker.js');

  const doc = await engine.open(new Uint8Array([1]));
  assert.equal(await engine.text(doc, 1), '你好世界');
});

test('createEngine：pdf.js 加载失败时 available() 返回 false 而不是抛异常', async () => {
  const engine = Pdf.createEngine(function () { return Promise.reject(new Error('file:// 下禁止加载模块')); }, 'w.js');
  assert.equal(await engine.available(), false);
});

test('createEngine：模块里没有 getDocument 时给出可读的错误', async () => {
  const engine = Pdf.createEngine(function () { return Promise.resolve({ nope: true }); }, 'w.js');
  await assert.rejects(engine.open(new Uint8Array([1])), /getDocument/);
});
