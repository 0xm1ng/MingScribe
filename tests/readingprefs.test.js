/**
 * readingprefs 模块测试（按书记忆排版）。
 *
 * 全部是纯函数，不依赖 DOM 与 localStorage。
 * 重点覆盖「三级回退」和「不修改入参」这两条容易写错的约束。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const ReadingPrefs = require('../src/readingprefs.js');

const DEFAULTS = { fontSize: 19, lineHeight: 1.85, pageWidth: 38 };
const BOOK_A = 'book-a';
const BOOK_B = 'book-b';

test('什么都没有时，回退到内置默认值', () => {
  const r = ReadingPrefs.resolve({}, BOOK_A, DEFAULTS);
  assert.deepEqual(
    { fontSize: r.fontSize, lineHeight: r.lineHeight, pageWidth: r.pageWidth },
    DEFAULTS
  );
  assert.equal(r.perBook, false);
});

test('prefs 是 null / 非对象时不抛异常，按默认值走', () => {
  for (const bad of [null, undefined, 42, 'x', []]) {
    const r = ReadingPrefs.resolve(bad, BOOK_A, DEFAULTS);
    assert.equal(r.fontSize, DEFAULTS.fontSize, '入参 ' + JSON.stringify(bad) + ' 应安全回退');
    assert.equal(r.perBook, false);
  }
});

test('没有本书记录时，跟随全局偏好', () => {
  const prefs = { fontSize: 22, lineHeight: 2.0, pageWidth: 46 };
  const r = ReadingPrefs.resolve(prefs, BOOK_A, DEFAULTS);
  assert.equal(r.fontSize, 22);
  assert.equal(r.lineHeight, 2.0);
  assert.equal(r.pageWidth, 46);
  assert.equal(r.perBook, false);
});

test('本书记录优先于全局，且逐字段回退', () => {
  const prefs = { fontSize: 22, lineHeight: 2.0, pageWidth: 46, bookPrefs: { [BOOK_A]: { fontSize: 26 } } };
  const r = ReadingPrefs.resolve(prefs, BOOK_A, DEFAULTS);
  assert.equal(r.fontSize, 26, '本书单独调过的用本书的');
  assert.equal(r.lineHeight, 2.0, '本书没调过的仍跟全局');
  assert.equal(r.pageWidth, 46);
  assert.equal(r.perBook, true);
});

test('A 书的排版不会影响 B 书（这是本次修复的核心）', () => {
  let prefs = ReadingPrefs.merge({}, BOOK_A, { fontSize: 26 });
  prefs = ReadingPrefs.merge(prefs, BOOK_B, { fontSize: 15 });

  assert.equal(ReadingPrefs.resolve(prefs, BOOK_A, DEFAULTS).fontSize, 26);
  assert.equal(ReadingPrefs.resolve(prefs, BOOK_B, DEFAULTS).fontSize, 15);
});

test('新书沿用最后一次全局调整（调一次，之后的书都跟着）', () => {
  let prefs = ReadingPrefs.merge({}, BOOK_A, { fontSize: 26 });
  // 打开一本全新的书，它没有记录，应当拿到刚同步过去的全局值
  assert.equal(ReadingPrefs.resolve(prefs, 'brand-new', DEFAULTS).fontSize, 26);
});

test('merge 同时写本书与全局', () => {
  const next = ReadingPrefs.merge({}, BOOK_A, { fontSize: 26 });
  assert.equal(next.fontSize, 26, '全局同步更新');
  assert.equal(next.bookPrefs[BOOK_A].fontSize, 26, '本书独立记录');
});

test('merge 不传 bookKey 时只写全局，不产生 bookPrefs 容器', () => {
  const next = ReadingPrefs.merge({}, '', { fontSize: 26 });
  assert.equal(next.fontSize, 26);
  assert.equal(next.bookPrefs, undefined);
});

test('merge 丢弃不在白名单里的字段', () => {
  const next = ReadingPrefs.merge({}, BOOK_A, { fontSize: 20, theme: 'dark', evil: 1 });
  assert.equal(next.fontSize, 20);
  assert.equal(next.theme, undefined);
  assert.deepEqual(next.bookPrefs[BOOK_A], { fontSize: 20 });
});

test('merge 不修改传入的 prefs（返回新对象）', () => {
  const prefs = { fontSize: 19, bookPrefs: { [BOOK_A]: { fontSize: 19 } } };
  const snapshot = JSON.stringify(prefs);
  const next = ReadingPrefs.merge(prefs, BOOK_A, { fontSize: 30 });
  assert.equal(JSON.stringify(prefs), snapshot, '原对象必须保持不变');
  assert.notEqual(next, prefs);
  assert.equal(next.bookPrefs[BOOK_A].fontSize, 30);
  assert.equal(prefs.bookPrefs[BOOK_A].fontSize, 19);
});

test('merge 保留其它书的记录', () => {
  let prefs = ReadingPrefs.merge({}, BOOK_A, { fontSize: 26 });
  prefs = ReadingPrefs.merge(prefs, BOOK_B, { fontSize: 15 });
  assert.equal(prefs.bookPrefs[BOOK_A].fontSize, 26);
  assert.equal(prefs.bookPrefs[BOOK_B].fontSize, 15);
});

test('isCustomized 能区分「有自己的排版」与「跟随全局」', () => {
  let prefs = {};
  assert.equal(ReadingPrefs.isCustomized(prefs, BOOK_A), false);
  prefs = ReadingPrefs.merge(prefs, BOOK_A, { fontSize: 26 });
  assert.equal(ReadingPrefs.isCustomized(prefs, BOOK_A), true);
  assert.equal(ReadingPrefs.isCustomized(prefs, BOOK_B), false);
});

test('resetBook 之后该书回到全局值，且不影响其它书', () => {
  let prefs = ReadingPrefs.merge({}, BOOK_A, { fontSize: 26 });
  prefs = ReadingPrefs.merge(prefs, BOOK_B, { fontSize: 15 });
  prefs = ReadingPrefs.resetBook(prefs, BOOK_A);

  assert.equal(ReadingPrefs.resolve(prefs, BOOK_A, DEFAULTS).fontSize, 15, '回退到全局（15 是最后一次全局值）');
  assert.equal(ReadingPrefs.resolve(prefs, BOOK_B, DEFAULTS).fontSize, 15, 'B 书不受影响');
  assert.equal(ReadingPrefs.isCustomized(prefs, BOOK_A), false);
});

test('resetBook 对没有记录的书是空操作，也不修改入参', () => {
  const prefs = { fontSize: 19 };
  const snapshot = JSON.stringify(prefs);
  const next = ReadingPrefs.resetBook(prefs, 'nobody');
  assert.equal(JSON.stringify(next), snapshot);
  assert.equal(next.bookPrefs, undefined);
});

test('bookPrefs 里是脏数据（null / 数组 / 非对象）时安全忽略', () => {
  const dirty = [
    { bookPrefs: null },
    { bookPrefs: 'oops' },
    { bookPrefs: { [BOOK_A]: null } },
    { bookPrefs: { [BOOK_A]: 'oops' } },
    { bookPrefs: { [BOOK_A]: [] } }
  ];
  for (const prefs of dirty) {
    const r = ReadingPrefs.resolve(prefs, BOOK_A, DEFAULTS);
    assert.equal(r.fontSize, DEFAULTS.fontSize, JSON.stringify(prefs) + ' 应安全回退');
    assert.equal(r.perBook, false);
  }
});

test('完整流程：调 A → 切 B → 切回 A，A 的字号还在', () => {
  let prefs = {};
  // 1) 在 A 书里把字号调到 26
  prefs = ReadingPrefs.merge(prefs, BOOK_A, { fontSize: 26 });
  // 2) 打开 B 书（未调过），拿到全局值 26；在 B 里调到 15
  assert.equal(ReadingPrefs.resolve(prefs, BOOK_B, DEFAULTS).fontSize, 26);
  prefs = ReadingPrefs.merge(prefs, BOOK_B, { fontSize: 15 });
  // 3) 切回 A，仍然是 26，不会被 B 的 15 覆盖（这就是以前会串味的地方）
  assert.equal(ReadingPrefs.resolve(prefs, BOOK_A, DEFAULTS).fontSize, 26);
  // 4) 再打开一本新书，跟随全局 15
  assert.equal(ReadingPrefs.resolve(prefs, 'book-c', DEFAULTS).fontSize, 15);
});

test('FIELDS 白名单就是这三个排版字段', () => {
  assert.deepEqual(ReadingPrefs.FIELDS, ['fontSize', 'lineHeight', 'pageWidth']);
});
