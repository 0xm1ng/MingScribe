/**
 * 书籍缓存层测试。
 *
 * 覆盖点：
 *   1. key 算法与 Progress.bookKey 保持一致（防止两处漂移导致缓存对不上进度）
 *   2. 句柄优先 / 正文降级的决策逻辑
 *   3. 增删改查与列表排序
 *   4. 写入失败（配额超限等）时的降级：返回 ok:false 且不留下残缺记录
 *   5. localStorage 后端的限制：不能存句柄、超配额要报错
 */
const test = require('node:test');
const assert = require('node:assert');

const BookStore = require('../src/bookstore.js');
const Progress = require('../src/progress.js');

/** 最小可用的 localStorage 模拟。 */
function memStorage(opts) {
  const opts2 = opts || {};
  const map = {};
  return {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null),
    setItem: (k, v) => {
      if (opts2.limit != null && String(v).length > opts2.limit) {
        const err = new Error('QuotaExceededError');
        err.name = 'QuotaExceededError';
        throw err;
      }
      map[k] = String(v);
    },
    removeItem: (k) => { delete map[k]; },
    _size: () => Object.keys(map).length
  };
}

const KEY = 'demo.txt::1024';

test('makeKey 与 Progress.bookKey 算法一致', () => {
  const cases = [
    ['a.txt', 10],
    ['中文 书名.txt', 2048],
    [null, undefined],
    ['', 0]
  ];
  for (const [name, size] of cases) {
    assert.strictEqual(BookStore.makeKey(name, size), Progress.bookKey(name, size));
  }
});

test('createStore 缺少后端时抛 TypeError', () => {
  assert.throws(() => BookStore.createStore(), TypeError);
  assert.throws(() => BookStore.createStore({}), TypeError);
});

test('put 缺少 key 或缺少内容时拒绝', async () => {
  const store = BookStore.createStore(BookStore.createMemoryBackend());
  await assert.rejects(() => store.put({ text: 'x' }), TypeError);
  await assert.rejects(() => store.put({ key: KEY }), TypeError);
  await assert.rejects(() => store.put({ key: KEY, text: '' }), TypeError);
});

test('正文路径：写入后可按 key 取回', async () => {
  const store = BookStore.createStore(BookStore.createMemoryBackend());
  const res = await store.put({
    key: KEY,
    title: '示例书',
    name: 'demo.txt',
    size: 1024,
    chapters: 12,
    chars: 3456,
    text: '第一章 开头\n正文内容'
  });

  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.source, 'text');

  const entry = await store.get(KEY);
  assert.ok(entry, '应能取回书籍');
  assert.strictEqual(entry.text, '第一章 开头\n正文内容');
  assert.strictEqual(entry.handle, null);
  assert.strictEqual(entry.meta.title, '示例书');
  assert.strictEqual(entry.meta.chapters, 12);
  assert.strictEqual(entry.meta.source, 'text');
});

test('同时提供句柄与正文时优先使用句柄', async () => {
  const store = BookStore.createStore(BookStore.createMemoryBackend());
  const handle = { name: 'file-handle' };

  const res = await store.put({ key: KEY, name: 'demo.txt', size: 1024, text: '正文', handle });
  assert.strictEqual(res.source, 'handle');

  const entry = await store.get(KEY);
  assert.strictEqual(entry.handle, handle, '句柄应原样保留（内存后端不克隆句柄）');
  assert.strictEqual(entry.text, null, '句柄优先时不保存正文');
});

test('list 只返回摘要，且按更新时间倒序', async () => {
  const store = BookStore.createStore(BookStore.createMemoryBackend());
  await store.put({ key: 'a::1', name: 'a.txt', title: 'A', size: 1, text: '一'.repeat(100) });
  // 两次写入若落在同一毫秒，排序结果会不确定，这里显式错开时间
  await new Promise((resolve) => setTimeout(resolve, 2));
  await store.put({ key: 'b::2', name: 'b.txt', title: 'B', size: 2, text: '二'.repeat(100) });

  const list = await store.list();
  assert.strictEqual(list.length, 2);
  assert.ok(list[0].updatedAt >= list[1].updatedAt);
  assert.ok(!('text' in list[0]), '摘要不应包含正文');
  assert.strictEqual(list[0].title, 'B', '后写入的排在前面');
});

test('list 在后端异常时返回空数组而非抛错', async () => {
  const broken = {
    readMeta: () => Promise.resolve(null),
    writeMeta: () => Promise.resolve(),
    listMeta: () => Promise.reject(new Error('boom')),
    readBlob: () => Promise.resolve(null),
    writeBlob: () => Promise.resolve(),
    remove: () => Promise.resolve(),
    clear: () => Promise.resolve()
  };
  const store = BookStore.createStore(broken);
  const list = await store.list();
  assert.deepStrictEqual(list, []);
});

test('remove 与 clear 会同时清理摘要与正文', async () => {
  const backend = BookStore.createMemoryBackend();
  const store = BookStore.createStore(backend);
  await store.put({ key: KEY, name: 'demo.txt', title: 'D', size: 1, text: '内容' });

  await store.remove(KEY);
  assert.strictEqual(await store.get(KEY), null, '删除后应取不到');
  assert.strictEqual((await store.list()).length, 0);

  await store.put({ key: 'x::1', name: 'x.txt', title: 'X', size: 1, text: '内容' });
  await store.clear();
  assert.strictEqual((await store.list()).length, 0);
});

test('写入正文失败时返回 ok:false 且不留下残缺记录', async () => {
  const backend = BookStore.createMemoryBackend();
  const original = backend.writeBlob;
  backend.writeBlob = () => Promise.reject(new Error('QuotaExceededError'));

  const store = BookStore.createStore(backend);
  const res = await store.put({ key: KEY, name: 'demo.txt', title: 'D', size: 1, text: '内容' });

  assert.strictEqual(res.ok, false);
  assert.match(res.reason, /QuotaExceededError/);
  assert.strictEqual(await store.get(KEY), null, '失败后不应残留摘要');

  backend.writeBlob = original;
});

test('重新缓存同一本书时保留首次加入时间', async () => {
  const store = BookStore.createStore(BookStore.createMemoryBackend());
  await store.put({ key: KEY, name: 'demo.txt', title: 'D', size: 1, text: '内容' });
  const first = await store.get(KEY);

  await store.put({ key: KEY, name: 'demo.txt', title: 'D（修订版）', size: 1, text: '新内容' });
  const second = await store.get(KEY);

  assert.strictEqual(second.meta.addedAt, first.meta.addedAt, 'addedAt 应保持首次值');
  assert.strictEqual(second.text, '新内容', '正文应被覆盖');
  assert.strictEqual(second.meta.title, 'D（修订版）');
});

test('内存后端返回值与存储隔离', async () => {
  const backend = BookStore.createMemoryBackend();
  await backend.writeMeta(KEY, { key: KEY, title: '原' });
  const copy = await backend.readMeta(KEY);
  copy.title = '被改了';
  const again = await backend.readMeta(KEY);
  assert.strictEqual(again.title, '原', '改动副本不应影响存储');
});

/* ---------------- localStorage 后端 ---------------- */

test('localStorage 后端可存取正文', async () => {
  const backend = BookStore.createLocalStorageBackend(memStorage());
  const store = BookStore.createStore(backend);
  await store.put({ key: KEY, name: 'demo.txt', title: 'D', size: 1, text: '内容' });

  const entry = await store.get(KEY);
  assert.strictEqual(entry.text, '内容');
  assert.strictEqual((await store.list()).length, 1);
});

test('localStorage 后端拒绝保存文件句柄', async () => {
  const backend = BookStore.createLocalStorageBackend(memStorage());
  const store = BookStore.createStore(backend);
  const res = await store.put({
    key: KEY,
    name: 'demo.txt',
    title: 'D',
    size: 1,
    handle: { name: 'h' }
  });
  assert.strictEqual(res.ok, false);
  assert.match(res.reason, /句柄/);
});

test('localStorage 后端超配额时降级为 ok:false', async () => {
  const backend = BookStore.createLocalStorageBackend(memStorage({ limit: 50 }));
  const store = BookStore.createStore(backend);
  const res = await store.put({ key: KEY, name: 'demo.txt', title: 'D', size: 1, text: '内'.repeat(200) });
  assert.strictEqual(res.ok, false);
});

test('localStorage 后端 remove 会清理正文占用的键', async () => {
  const storage = memStorage();
  const backend = BookStore.createLocalStorageBackend(storage);
  const store = BookStore.createStore(backend);
  await store.put({ key: KEY, name: 'demo.txt', title: 'D', size: 1, text: '内容' });
  assert.ok(storage._size() >= 2, '应写入索引与正文两个键');

  await store.remove(KEY);
  assert.strictEqual(storage._size(), 1, '删除后只剩索引键');
});

/* ---------------- 句柄权限 ---------------- */

test('ensurePermission 各种权限状态的处理', async () => {
  assert.strictEqual(await BookStore.ensurePermission(null), false);
  assert.strictEqual(await BookStore.ensurePermission({}), false);

  assert.strictEqual(
    await BookStore.ensurePermission({ queryPermission: () => 'granted' }),
    true
  );

  assert.strictEqual(
    await BookStore.ensurePermission({ queryPermission: () => 'denied' }),
    false,
    '被拒绝且不支持申请时应返回 false'
  );

  assert.strictEqual(
    await BookStore.ensurePermission({
      queryPermission: () => 'prompt',
      requestPermission: () => 'granted'
    }),
    true,
    'prompt 状态下应主动申请'
  );

  assert.strictEqual(
    await BookStore.ensurePermission({
      queryPermission: () => { throw new Error('接口异常'); }
    }),
    false,
    '权限接口异常时不应抛出'
  );
});

test('supportsFileSystemAccess 在无 window 环境下返回 false', () => {
  assert.strictEqual(BookStore.supportsFileSystemAccess(), false);
});

test('parserVersion 会被持久化，未提供时归零', async () => {
  const store = BookStore.createStore(BookStore.createMemoryBackend());

  await store.put({
    key: 'epub-a::100', name: 'a.epub', size: 100,
    format: 'epub', parserVersion: 2, text: '正文'
  });
  const withVersion = await store.get('epub-a::100');
  assert.strictEqual(withVersion.meta.parserVersion, 2, '版本号需原样存入 meta');

  await store.put({ key: 'txt-b::200', name: 'b.txt', size: 200, text: '正文' });
  const withoutVersion = await store.get('txt-b::200');
  assert.strictEqual(withoutVersion.meta.parserVersion, 0, '未提供时应为 0（早于版本号机制写入的旧缓存）');
});
