const test = require('node:test');
const assert = require('node:assert/strict');
const Annotations = require('../src/annotations.js');

/** 内存版 storage，接口与 localStorage 一致。 */
function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    raw: () => map.get(Annotations.STORAGE_KEY)
  };
}

/** 写入时抛错的 storage，用于模拟配额超限。 */
function failingStorage() {
  const inner = memoryStorage();
  return {
    getItem: inner.getItem,
    setItem: () => { throw new Error('QuotaExceededError'); },
    removeItem: inner.removeItem,
    raw: inner.raw
  };
}

const BASE = { bookKey: 'a.txt::100', chapterIndex: 0, start: 10, end: 20, text: '被划线的原文' };

test('normalize 拒绝非法区间', () => {
  assert.throws(() => Annotations.normalize(null), TypeError);
  assert.throws(() => Annotations.normalize({ start: 10, end: 10 }), TypeError, '首尾相同应被拒绝');
  assert.throws(() => Annotations.normalize({ start: 20, end: 10 }), TypeError, '起点在终点之后应被拒绝');
  assert.throws(() => Annotations.normalize({ start: -1, end: 5 }), TypeError, '负起点应被拒绝');
  assert.throws(() => Annotations.normalize({ start: 'x', end: 5 }), TypeError);
});

test('normalize 规整颜色与批注长度', () => {
  const ok = Annotations.normalize({ ...BASE, color: 'green' });
  assert.equal(ok.color, 'green');
  assert.equal(ok.start, 10);
  assert.equal(ok.end, 20);

  assert.equal(Annotations.normalize({ ...BASE, color: 'rainbow' }).color, 'yellow', '未知颜色回退到黄色');
  assert.equal(Annotations.normalize({ ...BASE, color: null }).color, 'yellow');
  assert.equal(Annotations.normalize(BASE).note, '');
  assert.equal(Annotations.normalize({ ...BASE, note: 'x'.repeat(9999) }).note.length, Annotations.MAX_NOTE);
  assert.ok(Annotations.normalize(BASE).id, '未提供 id 时应自动生成');
  assert.equal(Annotations.normalize({ ...BASE, chapterIndex: -3 }).chapterIndex, 0);
});

test('conflicts 判定重叠：相接不算，跨章跨书不算', () => {
  const existing = [{ ...BASE }];

  assert.ok(Annotations.conflicts(existing, { ...BASE, start: 15, end: 25 }), '相交应冲突');
  assert.ok(Annotations.conflicts(existing, { ...BASE, start: 5, end: 15 }), '左侧相交应冲突');
  assert.ok(Annotations.conflicts(existing, { ...BASE, start: 0, end: 100 }), '完全包含应冲突');
  assert.ok(Annotations.conflicts(existing, { ...BASE, start: 11, end: 12 }), '完全被包含应冲突');

  assert.equal(Annotations.conflicts(existing, { ...BASE, start: 20, end: 30 }), null, '首尾相接不算重叠');
  assert.equal(Annotations.conflicts(existing, { ...BASE, start: 0, end: 10 }), null, '首尾相接不算重叠');
  assert.equal(Annotations.conflicts(existing, { ...BASE, chapterIndex: 1 }), null, '不同章节互不影响');
  assert.equal(Annotations.conflicts(existing, { ...BASE, bookKey: 'b.txt::1' }), null, '不同书互不影响');
  assert.equal(Annotations.conflicts([], BASE), null);
});

test('add 成功写入并可按书查询', () => {
  const store = Annotations.createStore(memoryStorage());
  const res = store.add(BASE);
  assert.equal(res.ok, true);
  assert.ok(res.record.id);

  const list = store.list(BASE.bookKey);
  assert.equal(list.length, 1);
  assert.equal(list[0].text, '被划线的原文');
  assert.equal(list[0].color, 'yellow');
  assert.deepEqual(store.list('别的书'), []);
});

test('add 拒绝重叠并返回冲突项，不写入任何数据', () => {
  const store = Annotations.createStore(memoryStorage());
  store.add(BASE);

  const res = store.add({ ...BASE, start: 18, end: 30, text: '重叠的一段' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'overlap');
  assert.equal(res.conflict.start, 10);
  assert.equal(store.list(BASE.bookKey).length, 1, '冲突时不应写入第二条');
});

test('add 拒绝非法区间并归因 invalid', () => {
  const store = Annotations.createStore(memoryStorage());
  const res = store.add({ ...BASE, start: 30, end: 30 });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'invalid');
  assert.equal(store.list(BASE.bookKey).length, 0);
});

test('写入失败时返回 storage 且不留残缺记录', () => {
  const store = Annotations.createStore(failingStorage());
  const res = store.add(BASE);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'storage');
  assert.deepEqual(store.list(BASE.bookKey), []);
});

test('list 按章节与位置排序', () => {
  const store = Annotations.createStore(memoryStorage());
  store.add({ ...BASE, start: 30, end: 40 });
  store.add({ ...BASE, chapterIndex: 2, start: 5, end: 9 });
  store.add({ ...BASE, start: 0, end: 8 });
  store.add({ ...BASE, chapterIndex: 1, start: 3, end: 6 });

  assert.deepEqual(
    store.list(BASE.bookKey).map((a) => [a.chapterIndex, a.start]),
    [[0, 0], [0, 30], [1, 3], [2, 5]]
  );
});

test('重复 id 会被重新生成，避免互相覆盖', () => {
  const store = Annotations.createStore(memoryStorage());
  const first = store.add({ ...BASE, id: 'fixed' });
  const second = store.add({ ...BASE, id: 'fixed', chapterIndex: 1 });

  assert.equal(first.record.id, 'fixed');
  assert.equal(second.ok, true);
  assert.notEqual(second.record.id, 'fixed');
  assert.equal(store.list(BASE.bookKey).length, 2);
});

test('updateNote 修改批注、保留划线', () => {
  const store = Annotations.createStore(memoryStorage());
  const id = store.add(BASE).record.id;

  const ok = store.updateNote(id, '这里要背下来');
  assert.equal(ok.ok, true);
  assert.equal(store.get(id).note, '这里要背下来');
  assert.equal(store.get(id).start, 10, '批注不应影响划线区间');

  const cleared = store.updateNote(id, '');
  assert.equal(cleared.ok, true);
  assert.equal(store.get(id).note, '');

  assert.equal(store.updateNote('不存在', 'x').ok, false);
  assert.equal(store.updateNote('不存在', 'x').reason, 'missing');
});

test('updateNote 写入失败时返回 storage', () => {
  const seeding = memoryStorage();
  seeding.setItem(Annotations.STORAGE_KEY, JSON.stringify([
    { id: 'x', bookKey: 'a.txt::100', chapterIndex: 0, start: 1, end: 2, note: '' }
  ]));
  const store = Annotations.createStore({
    getItem: seeding.getItem,
    setItem: () => { throw new Error('QuotaExceededError'); },
    removeItem: seeding.removeItem
  });

  assert.equal(store.updateNote('x', 'hi').reason, 'storage');
  assert.equal(store.get('x').note, '', '写入失败时原记录应保持不变');
});

test('updateColor 只改颜色，不动区间与批注', () => {
  const store = Annotations.createStore(memoryStorage());
  const id = store.add({ ...BASE, note: '原有批注' }).record.id;

  const res = store.updateColor(id, 'blue');
  assert.equal(res.ok, true);
  assert.equal(store.get(id).color, 'blue');
  assert.equal(store.get(id).note, '原有批注', '换颜色不应影响批注');
  assert.equal(store.get(id).start, 10);

  assert.equal(store.updateColor(id, 'rainbow').record.color, 'yellow', '未知颜色回退黄色');
  assert.equal(store.updateColor('不存在', 'blue').reason, 'missing');
});

test('updateColor 写入失败时返回 storage 且不改动原记录', () => {
  const seeding = memoryStorage();
  seeding.setItem(Annotations.STORAGE_KEY, JSON.stringify([
    { id: 'x', bookKey: 'a.txt::100', chapterIndex: 0, start: 1, end: 2, color: 'yellow' }
  ]));
  const store = Annotations.createStore({
    getItem: seeding.getItem,
    setItem: () => { throw new Error('QuotaExceededError'); },
    removeItem: seeding.removeItem
  });

  assert.equal(store.updateColor('x', 'green').reason, 'storage');
  assert.equal(store.get('x').color, 'yellow');
});

test('remove 与 removeByBook', () => {
  const store = Annotations.createStore(memoryStorage());
  const a = store.add(BASE).record.id;
  store.add({ ...BASE, chapterIndex: 1 });
  store.add({ ...BASE, bookKey: 'b.txt::9' });

  assert.equal(store.remove(a), true);
  assert.equal(store.remove('不存在'), false);
  assert.equal(store.list(BASE.bookKey).length, 1);

  assert.equal(store.removeByBook(BASE.bookKey), 1);
  assert.equal(store.list(BASE.bookKey).length, 0);
  assert.equal(store.list('b.txt::9').length, 1, '不应误删其他书的标注');
});

test('clear 清空全部标注', () => {
  const storage = memoryStorage();
  const store = Annotations.createStore(storage);
  store.add(BASE);
  store.add({ ...BASE, bookKey: 'b.txt::9' });

  store.clear();
  assert.deepEqual(store.all(), []);
  assert.equal(storage.raw(), undefined);
});

test('存储损坏时按空处理而不抛错', () => {
  const storage = memoryStorage();
  storage.setItem(Annotations.STORAGE_KEY, '{ 不是合法 JSON');
  const store = Annotations.createStore(storage);

  assert.deepEqual(store.all(), []);
  assert.equal(store.add(BASE).ok, true);
  assert.equal(store.list(BASE.bookKey).length, 1);
});

test('存储里混入残缺记录时会被过滤掉', () => {
  const storage = memoryStorage();
  storage.setItem(Annotations.STORAGE_KEY, JSON.stringify([
    { id: 'ok', bookKey: 'a.txt::100', chapterIndex: 0, start: 1, end: 2 },
    { id: 'no-key' },
    null
  ]));
  const store = Annotations.createStore(storage);
  assert.equal(store.all().length, 1);
});

test('createStore 需要合法的 storage', () => {
  assert.throws(() => Annotations.createStore(null), TypeError);
  assert.throws(() => Annotations.createStore({}), TypeError);
});
