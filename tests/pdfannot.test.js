/**
 * PDF 批注（框选 / 手绘 / 便签）的纯逻辑与存储测试。
 *
 * 这一层的错法都很静：坐标算错一档，缩放一变批注就整体漂移；
 * 命中判定写松了，点哪儿都删得掉。所以这里盯住三件事：
 *   ① 归一化换算与反算必须自洽（0~1 ↔ 像素）
 *   ② 太小的拖拽不能被存下来（否则页面上会多出一堆肉眼看不见的脏数据）
 *   ③ storage 失败必须回滚，且不能抛异常打断阅读
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const PdfAnnot = require('../src/pdfannot.js');

/** 内存版 storage；fail() 之后写入一律失败，用来验证回滚。 */
function memStorage() {
  const map = new Map();
  let fail = false;
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      if (fail) throw new Error('QuotaExceededError');
      map.set(k, String(v));
    },
    removeItem: (k) => map.delete(k),
    fail() { fail = true; }
  };
}

/* ---------------- normalizeRect ---------------- */

test('normalizeRect：反向拖拽（右下 → 左上）得到同一个框', () => {
  const a = PdfAnnot.normalizeRect(0.2, 0.3, 0.6, 0.5);
  const b = PdfAnnot.normalizeRect(0.6, 0.5, 0.2, 0.3);
  assert.deepEqual(a, b);
  assert.deepEqual(a, { x: 0.2, y: 0.3, w: 0.4, h: 0.2 });
});

test('normalizeRect：超出页面边界的拖拽会被夹回 0~1', () => {
  const r = PdfAnnot.normalizeRect(-0.5, -0.2, 1.8, 2.5);
  assert.deepEqual(r, { x: 0, y: 0, w: 1, h: 1 });
});

test('normalizeRect：太小的拖拽返回 null（点一下不该留下脏批注）', () => {
  assert.equal(PdfAnnot.normalizeRect(0.5, 0.5, 0.501, 0.5), null, '纯水平抖动');
  assert.equal(PdfAnnot.normalizeRect(0.5, 0.5, 0.5, 0.503), null, '纯垂直抖动');
  assert.equal(PdfAnnot.normalizeRect(0.5, 0.5, 0.5, 0.5), null, '原地点击');
  // 刚好到阈值就该收下（阈值本身不算「太小」）
  assert.ok(PdfAnnot.normalizeRect(0.2, 0.2, 0.2 + PdfAnnot.MIN_SIDE, 0.2 + PdfAnnot.MIN_SIDE));
});

test('normalizeRect：画一整行下划线那种「扁而长」的框是合法的', () => {
  const r = PdfAnnot.normalizeRect(0.1, 0.4, 0.9, 0.42);
  assert.ok(r, '正文一行的高度约 0.02，必须能画出来');
  assert.equal(r.h, 0.02);
});

/* ---------------- 坐标换算自洽 ---------------- */

test('rectBox：归一化矩形 → 像素盒子，与 rectBox(pointAt) 互相自洽', () => {
  const rect = { x: 0.25, y: 0.5, w: 0.5, h: 0.25 };
  const box = PdfAnnot.rectBox(rect, 800, 1000);
  assert.deepEqual(box, { x: 200, y: 500, width: 400, height: 250 });

  const tl = PdfAnnot.pointAt({ x: rect.x, y: rect.y }, 800, 1000);
  assert.equal(tl.x, box.x);
  assert.equal(tl.y, box.y);
});

test('rectBox / pointAt：缩放变了，归一化数据不变、像素位置按比例走', () => {
  const rect = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };
  const small = PdfAnnot.rectBox(rect, 600, 800);
  const big = PdfAnnot.rectBox(rect, 1200, 1600);
  assert.equal(big.x, small.x * 2);
  assert.equal(big.width, small.width * 2);
  assert.equal(big.height, small.height * 2);
});

/* ---------------- 手绘 ---------------- */

test('thinPoints：丢掉挤在一起的点，但首尾都要保留', () => {
  const pts = [];
  for (let i = 0; i < 40; i++) pts.push({ x: 0.1 + i * 0.0005, y: 0.2 }); // 每步 0.0005，全在阈值内
  const thinned = PdfAnnot.thinPoints(pts);
  assert.ok(thinned.length < pts.length, '应该被抽稀');
  assert.deepEqual(thinned[0], PdfAnnot.normalizeAt(pts[0].x, pts[0].y));
  assert.deepEqual(thinned[thinned.length - 1], PdfAnnot.normalizeAt(pts[pts.length - 1].x, pts[pts.length - 1].y));
});

test('thinPoints：空输入与非法点不会抛异常', () => {
  assert.deepEqual(PdfAnnot.thinPoints([]), []);
  assert.deepEqual(PdfAnnot.thinPoints(null), []);
  assert.deepEqual(PdfAnnot.thinPoints([null, undefined]), []);
});

test('pathOf：少于两个点返回空串（单点由调用方改成画圆点）', () => {
  assert.equal(PdfAnnot.pathOf([{ x: 0.1, y: 0.1 }], 100, 100), '');
  assert.equal(PdfAnnot.pathOf([], 100, 100), '');
  assert.equal(PdfAnnot.pathOf(null, 100, 100), '');
});

test('pathOf：像素坐标连成折线，首点是 M、其余是 L', () => {
  const d = PdfAnnot.pathOf([{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, { x: 1, y: 0 }], 200, 100);
  assert.equal(d, 'M0 0 L100 50 L200 0');
});

/* ---------------- 命中判定 ---------------- */

test('hitTest：矩形看框内，框外一点就返回 false', () => {
  const rec = { kind: 'rect', rect: { x: 0.2, y: 0.2, w: 0.2, h: 0.1 } };
  assert.equal(PdfAnnot.hitTest(rec, 0.3, 0.25), true);
  assert.equal(PdfAnnot.hitTest(rec, 0.41, 0.25), false);
  assert.equal(PdfAnnot.hitTest(rec, 0.1, 0.25), false);
});

test('hitTest：便签看半径', () => {
  const rec = { kind: 'note', at: { x: 0.5, y: 0.5 } };
  assert.equal(PdfAnnot.hitTest(rec, 0.5, 0.5), true);
  assert.equal(PdfAnnot.hitTest(rec, 0.5 + PdfAnnot.NOTE_HIT_RADIUS - 0.001, 0.5), true);
  assert.equal(PdfAnnot.hitTest(rec, 0.5 + PdfAnnot.NOTE_HIT_RADIUS + 0.01, 0.5), false);
});

test('hitTest：笔迹看离折线的距离，而不是离端点的距离', () => {
  const rec = { kind: 'ink', points: [{ x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }] };
  // 折线正中间（离两个端点都很远）也必须命中
  assert.equal(PdfAnnot.hitTest(rec, 0.5, 0.5), true);
  assert.equal(PdfAnnot.hitTest(rec, 0.5, 0.5 + PdfAnnot.INK_HIT_WIDTH + 0.01), false);
});

test('hitTest：单点笔迹按半径判，缺字段不抛异常', () => {
  const dot = { kind: 'ink', points: [{ x: 0.3, y: 0.3 }] };
  assert.equal(PdfAnnot.hitTest(dot, 0.3, 0.3), true);
  assert.equal(PdfAnnot.hitTest(dot, 0.5, 0.5), false);
  assert.equal(PdfAnnot.hitTest(null, 0.5, 0.5), false);
  assert.equal(PdfAnnot.hitTest({ kind: 'rect' }, 0.5, 0.5), false);
});

test('distToSegment：端点之外按端点算距离，退化线段不除零', () => {
  assert.equal(PdfAnnot.distToSegment(0.5, 0.5, 0, 0.5, 1, 0.5), 0);
  assert.equal(PdfAnnot.distToSegment(-1, 0.5, 0, 0.5, 1, 0.5), 1);
  assert.equal(PdfAnnot.distToSegment(3, 4, 0, 0, 0, 0), 5);
});

/* ---------------- normalize ---------------- */

test('normalize：rect 缺 range / 形状非法时抛 TypeError', () => {
  assert.throws(() => PdfAnnot.normalize({ kind: 'rect', page: 1, rect: { x: 0.5, y: 0.5, w: 0, h: 0 } }), TypeError);
  assert.throws(() => PdfAnnot.normalize({ kind: 'rect', page: 0, rect: { x: 0, y: 0, w: 0.2, h: 0.2 } }), TypeError);
  assert.throws(() => PdfAnnot.normalize({ kind: 'nope', page: 1 }), TypeError);
  assert.throws(() => PdfAnnot.normalize(null), TypeError);
});

test('normalize：合法记录补全 id / 时间戳 / 颜色，颜色非法时回退第一个', () => {
  const rec = PdfAnnot.normalize({
    kind: 'rect', bookKey: 'bk', page: 3,
    rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, color: '不存在'
  });
  assert.ok(rec.id);
  assert.equal(rec.page, 3);
  assert.equal(rec.color, PdfAnnot.COLORS[0]);
  assert.ok(rec.createdAt > 0);
  assert.deepEqual(rec.rect, { x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
});

test('normalize：便签缺锚点抛错，note 文本被截到上限', () => {
  assert.throws(() => PdfAnnot.normalize({ kind: 'note', page: 1 }), TypeError);
  const rec = PdfAnnot.normalize({
    kind: 'note', page: 1, x: 0.2, y: 0.3, note: 'x'.repeat(PdfAnnot.MAX_NOTE + 50)
  });
  assert.equal(rec.note.length, PdfAnnot.MAX_NOTE);
  assert.deepEqual(rec.at, { x: 0.2, y: 0.3 });
});

test('normalize：笔迹会被抽稀后再存，点数不会膨胀', () => {
  const pts = [];
  for (let i = 0; i < 500; i++) pts.push({ x: 0.001 * i, y: 0.5 });
  const rec = PdfAnnot.normalize({ kind: 'ink', page: 1, points: pts });
  assert.ok(rec.points.length < pts.length);
  assert.ok(rec.points.length <= PdfAnnot.MAX_POINTS);
});

/* ---------------- 存储 ---------------- */

test('createStore：add / byPage / counts / size 都按书隔离', () => {
  const s = PdfAnnot.createStore(memStorage());
  s.add({ kind: 'rect', bookKey: 'A', page: 1, rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } });
  s.add({ kind: 'rect', bookKey: 'A', page: 2, rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } });
  s.add({ kind: 'note', bookKey: 'B', page: 1, x: 0.5, y: 0.5 });

  assert.equal(s.list('A').length, 2);
  assert.equal(s.byPage('A', 1).length, 1);
  assert.equal(s.byPage('A', 3).length, 0);
  assert.deepEqual(s.counts('A'), { 1: 1, 2: 1 });
  assert.equal(s.size('B'), 1);
  assert.equal(s.size('C'), 0);
});

test('createStore：byPage 按画上去的先后排序', () => {
  const s = PdfAnnot.createStore(memStorage());
  s.add({ kind: 'note', bookKey: 'A', page: 1, x: 0.1, y: 0.1, now: 300 });
  s.add({ kind: 'note', bookKey: 'A', page: 1, x: 0.2, y: 0.2, now: 100 });
  s.add({ kind: 'note', bookKey: 'A', page: 1, x: 0.3, y: 0.3, now: 200 });
  assert.deepEqual(s.byPage('A', 1).map((r) => r.createdAt), [100, 200, 300]);
});

test('createStore：非法记录不落盘，返回 invalid 而不是抛异常', () => {
  const s = PdfAnnot.createStore(memStorage());
  const res = s.add({ kind: 'rect', bookKey: 'A', page: 1, rect: { x: 0.5, y: 0.5, w: 0, h: 0 } });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'invalid');
  assert.equal(s.size('A'), 0);
});

test('createStore：写入失败返回 storage，且不留残缺记录', () => {
  const ok = PdfAnnot.createStore(memStorage());
  ok.add({ kind: 'rect', bookKey: 'A', page: 1, rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } });

  const broken = memStorage();
  const failing = PdfAnnot.createStore(broken);
  broken.fail();

  assert.equal(failing.add({ kind: 'note', bookKey: 'A', page: 1, x: 0.5, y: 0.5 }).reason, 'storage');
  assert.equal(failing.size('A'), 0);
  assert.equal(ok.size('A'), 1, '另一个 store 不受影响');
});

test('createStore：updateNote 只改正文，颜色与形状不动', () => {
  const s = PdfAnnot.createStore(memStorage());
  const rec = s.add({
    kind: 'note', bookKey: 'A', page: 1, x: 0.2, y: 0.3, color: 'blue', now: 1000
  }).record;

  const res = s.updateNote(rec.id, '第三章的重点');
  assert.equal(res.ok, true);
  assert.equal(res.record.note, '第三章的重点');
  assert.equal(res.record.color, 'blue');
  assert.deepEqual(res.record.at, { x: 0.2, y: 0.3 });
  assert.equal(res.record.createdAt, 1000);
});

test('createStore：updateNote / updateColor 遇到不存在的 id 返回 missing', () => {
  const s = PdfAnnot.createStore(memStorage());
  assert.equal(s.updateNote('不存在', 'x').reason, 'missing');
  assert.equal(s.updateColor('不存在', 'blue').reason, 'missing');
});

test('createStore：写入失败时 updateNote 返回 storage，原记录保持不变', () => {
  const storage = memStorage();
  const s = PdfAnnot.createStore(storage);
  const rec = s.add({
    kind: 'note', bookKey: 'A', page: 1, x: 0.1, y: 0.1, note: '原本的内容'
  }).record;

  storage.fail();
  const res = s.updateNote(rec.id, '改不动的内容');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'storage');

  // 读回来必须还是旧内容 —— 半截写入比写入失败更糟
  assert.equal(PdfAnnot.createStore(storage).get(rec.id).note, '原本的内容');
});

test('createStore：remove 与 removeByBook', () => {
  const s = PdfAnnot.createStore(memStorage());
  const a = s.add({ kind: 'rect', bookKey: 'A', page: 1, rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } }).record;
  s.add({ kind: 'rect', bookKey: 'A', page: 2, rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } });
  s.add({ kind: 'rect', bookKey: 'B', page: 1, rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } });

  assert.equal(s.remove(a.id), true);
  assert.equal(s.remove(a.id), false, '重复删除返回 false');
  assert.equal(s.size('A'), 1);
  assert.equal(s.removeByBook('A'), 1);
  assert.equal(s.size('A'), 0);
  assert.equal(s.size('B'), 1, '别的书不受牵连');
});

test('createStore：popLatest 撤销的是「最后画的」，与数组里改过顺序的记录无关', () => {
  const s = PdfAnnot.createStore(memStorage());
  const first = s.add({ kind: 'note', bookKey: 'A', page: 1, x: 0.1, y: 0.1, now: 100 }).record;
  const second = s.add({ kind: 'note', bookKey: 'A', page: 2, x: 0.2, y: 0.2, now: 200 }).record;

  // 改一次早先那条（会更新 updatedAt）—— 撤销不该受这个影响
  s.updateColor(first.id, 'pink');

  const popped = s.popLatest('A');
  assert.equal(popped.id, second.id);
  assert.equal(s.size('A'), 1);
  assert.equal(s.popLatest('B'), null, '没有批注的书返回 null');
});

test('createStore：存储内容损坏时按空处理，不抛异常', () => {
  const storage = memStorage();
  storage.setItem(PdfAnnot.STORAGE_KEY, '{ 这不是 JSON');
  const s = PdfAnnot.createStore(storage);
  assert.deepEqual(s.list('A'), []);
});

test('createStore：缺 storage 实现时立刻抛 TypeError', () => {
  assert.throws(() => PdfAnnot.createStore(null), TypeError);
  assert.throws(() => PdfAnnot.createStore({}), TypeError);
});
