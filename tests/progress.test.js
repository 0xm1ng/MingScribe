const test = require('node:test');
const assert = require('node:assert/strict');
const Progress = require('../src/progress.js');

/** 内存版 storage，接口与 localStorage 一致。 */
function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    size: () => map.size
  };
}

/** 构造一个可控的中间格式书籍对象。 */
function fakeBook() {
  const text = 'A'.repeat(100);
  return {
    title: '测试书',
    text,
    totalChars: 100,
    chapters: [
      { index: 0, title: '第一章', start: 0, end: 50, text: text.slice(0, 50) },
      { index: 1, title: '第二章', start: 50, end: 100, text: text.slice(50, 100) }
    ]
  };
}

test('bookKey 由文件名与字节长度组成', () => {
  assert.equal(Progress.bookKey('a.txt', 1024), 'a.txt::1024');
  assert.equal(Progress.bookKey('a.txt', 1024), Progress.bookKey('a.txt', 1024));
  assert.notEqual(Progress.bookKey('a.txt', 1024), Progress.bookKey('a.txt', 2048));
  assert.equal(Progress.bookKey(null, null), '未命名::0');
});

test('resolvePosition 把越界位置修正到合法范围', () => {
  const book = fakeBook();
  assert.deepEqual(Progress.resolvePosition(book, 1, 1000), { chapterIndex: 1, charOffset: 50 });
  assert.deepEqual(Progress.resolvePosition(book, -5, -5), { chapterIndex: 0, charOffset: 0 });
  assert.deepEqual(Progress.resolvePosition(book, 99, 0), { chapterIndex: 1, charOffset: 0 });
  assert.deepEqual(Progress.resolvePosition(book, 0.9, 10.7), { chapterIndex: 0, charOffset: 10 });
  assert.deepEqual(Progress.resolvePosition(null, 3, 5), { chapterIndex: 0, charOffset: 0 });
  assert.deepEqual(Progress.resolvePosition({ chapters: [] }, 3, 5), { chapterIndex: 0, charOffset: 0 });
});

test('computePercent 以字符位置而非页码计算', () => {
  const book = fakeBook();
  assert.equal(Progress.computePercent(book, 0, 0), 0);
  assert.equal(Progress.computePercent(book, 1, 0), 50);
  assert.equal(Progress.computePercent(book, 1, 25), 75);
  assert.equal(Progress.computePercent(book, 1, 50), 100);
  assert.equal(Progress.computePercent(book, 9, 999), 100);
});

test('computePercent 对异常书籍返回 0', () => {
  assert.equal(Progress.computePercent(null, 0, 0), 0);
  assert.equal(Progress.computePercent({ chapters: [], totalChars: 0 }, 0, 0), 0);
  assert.equal(Progress.computePercent({ chapters: [{ start: 0, end: 10 }], totalChars: 0 }, 0, 5), 0);
});

test('makeRecord 生成可用于恢复的完整记录', () => {
  const book = fakeBook();
  const meta = { key: 'a.txt::1024', name: 'a.txt', size: 1024, title: '测试书' };
  const record = Progress.makeRecord(book, meta, 1, 30, 1700000000000);

  assert.equal(record.key, 'a.txt::1024');
  assert.equal(record.name, 'a.txt');
  assert.equal(record.title, '测试书');
  assert.equal(record.chapterIndex, 1);
  assert.equal(record.charOffset, 30);
  assert.equal(record.chapterTitle, '第二章');
  assert.equal(record.chapterCount, 2);
  assert.equal(record.totalChars, 100);
  assert.equal(record.percent, 80);
  assert.equal(record.updatedAt, 1700000000000);
});

test('makeRecord 缺省 meta 时也能工作', () => {
  const record = Progress.makeRecord(fakeBook(), { name: 'b.txt', size: 10 }, 0, 0, 1);
  assert.equal(record.key, 'b.txt::10');
  assert.equal(record.chapterIndex, 0);
});

test('createStore 需要合法的 storage', () => {
  assert.throws(() => Progress.createStore(null), TypeError);
  assert.throws(() => Progress.createStore({}), TypeError);
});

test('store 可保存、读取并按时间倒序列出', () => {
  const store = Progress.createStore(memoryStorage());
  store.save({ key: 'k1', name: '一', updatedAt: 100 });
  store.save({ key: 'k2', name: '二', updatedAt: 300 });
  store.save({ key: 'k3', name: '三', updatedAt: 200 });

  assert.deepEqual(store.list().map((r) => r.key), ['k2', 'k3', 'k1']);
  assert.equal(store.get('k1').name, '一');
  assert.equal(store.get('不存在'), null);
});

test('同一本书重复保存只保留最新一条', () => {
  const store = Progress.createStore(memoryStorage());
  store.save({ key: 'k1', name: '旧', updatedAt: 100 });
  store.save({ key: 'k1', name: '新', updatedAt: 200 });

  assert.equal(store.list().length, 1);
  assert.equal(store.get('k1').name, '新');
});

test('save 缺少 key 时抛出 TypeError', () => {
  const store = Progress.createStore(memoryStorage());
  assert.throws(() => store.save({ name: '无 key' }), TypeError);
  assert.throws(() => store.save(null), TypeError);
});

test('记录数量上限为 MAX_RECORDS', () => {
  const store = Progress.createStore(memoryStorage());
  for (let i = 0; i < Progress.MAX_RECORDS + 8; i++) {
    store.save({ key: 'k' + i, updatedAt: i });
  }
  assert.equal(store.list().length, Progress.MAX_RECORDS);
  // 最新的保留，最旧的被淘汰
  assert.equal(store.get('k' + (Progress.MAX_RECORDS + 7)).updatedAt, Progress.MAX_RECORDS + 7);
  assert.equal(store.get('k0'), null);
});

test('remove 与 clear 生效', () => {
  const storage = memoryStorage();
  const store = Progress.createStore(storage);
  store.save({ key: 'k1', updatedAt: 1 });
  store.save({ key: 'k2', updatedAt: 2 });

  store.remove('k1');
  assert.deepEqual(store.list().map((r) => r.key), ['k2']);

  store.clear();
  assert.deepEqual(store.list(), []);
  assert.equal(storage.getItem(Progress.STORAGE_KEY), null);
});

test('存储内容损坏时按空记录处理而不抛错', () => {
  const storage = memoryStorage();
  storage.setItem(Progress.STORAGE_KEY, '{ 这不是合法 JSON');
  const store = Progress.createStore(storage);

  assert.deepEqual(store.list(), []);
  assert.equal(store.get('任意'), null);

  store.save({ key: 'k1', updatedAt: 1 });
  assert.equal(store.list().length, 1);
});

test('存储内容不是数组时同样容错', () => {
  const storage = memoryStorage();
  storage.setItem(Progress.STORAGE_KEY, '{"a":1}');
  const store = Progress.createStore(storage);
  assert.deepEqual(store.list(), []);
});
