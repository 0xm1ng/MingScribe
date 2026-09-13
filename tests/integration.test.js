/**
 * 端到端集成测试：验证「解码 → 解析 → 记录进度 → 恢复位置」整条链路。
 * 这是分层设计是否成立的守门测试 —— 显示层只依赖中间格式，位置锚点不依赖页码。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const Encoding = require('../src/encoding.js');
const Parser = require('../src/parser.js');
const Progress = require('../src/progress.js');

const utf8 = new TextEncoder();

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); }
  };
}

const NOVEL_LINES = [
  '第一章 少年',
  '他站在山巅，风从耳边掠过。',
  '那时候他还不知道，这一走就是十年。',
  '第二章 相遇',
  '她在雨里撑着一把破伞。',
  '第三章 离别',
  '多年以后，他仍然记得那个黄昏。'
];

/** 模拟一次「文件字节 → 可阅读书籍 + 元信息」的完整流程。 */
function openBook(bytes, fileName, byteLength) {
  const decoded = Encoding.decodeBuffer(bytes);
  const book = Parser.parseTxt(decoded.text, { bookTitle: fileName.replace(/\.[^.]+$/, '') });
  const meta = {
    key: Progress.bookKey(fileName, byteLength),
    name: fileName,
    size: byteLength,
    title: fileName.replace(/\.[^.]+$/, ''),
    encoding: decoded.encoding
  };
  return { decoded, book, meta };
}

test('端到端：UTF-8 字节流可走通解码 → 解析 → 落盘 → 恢复', () => {
  const bytes = utf8.encode(NOVEL_LINES.join('\r\n'));
  const { decoded, book, meta } = openBook(bytes, '测试小说.txt', bytes.length);

  assert.equal(decoded.encoding, 'utf-8');
  assert.deepEqual(book.chapters.map((c) => c.title), ['第一章 少年', '第二章 相遇', '第三章 离别']);

  const store = Progress.createStore(memoryStorage());

  // 在第二章正文第 4 个字处停下
  const record = store.save(Progress.makeRecord(book, meta, 1, 4, 1700000000000));
  assert.equal(record.chapterTitle, '第二章 相遇');
  assert.ok(record.percent > 0 && record.percent < 100);

  // 重新打开同一个文件，应恢复到同一绝对字符位置
  const reopened = openBook(bytes, '测试小说.txt', bytes.length);
  const saved = store.get(reopened.meta.key);
  assert.ok(saved, '应能按文件名 + 字节长度找回进度');

  const pos = Progress.resolvePosition(reopened.book, saved.chapterIndex, saved.charOffset);
  const absolute = reopened.book.chapters[pos.chapterIndex].start + pos.charOffset;
  const expected = book.chapters[1].start + 4;

  assert.equal(pos.chapterIndex, 1);
  assert.equal(pos.charOffset, 4);
  assert.equal(absolute, expected);
});

test('端到端：字节长度不同会被视为另一本书，不会错误串进度', () => {
  const bytesA = utf8.encode(NOVEL_LINES.join('\n'));
  const bytesB = utf8.encode(NOVEL_LINES.join('\n') + '\n第四章 归来\n他终于回来了。');
  const store = Progress.createStore(memoryStorage());

  const bookA = openBook(bytesA, '同名.txt', bytesA.length);
  store.save(Progress.makeRecord(bookA.book, bookA.meta, 2, 3, 1));

  const bookB = openBook(bytesB, '同名.txt', bytesB.length);
  assert.equal(store.get(bookB.meta.key), null);
});

test('端到端：进度百分比随阅读推进单调不减', () => {
  const bytes = utf8.encode(NOVEL_LINES.join('\n'));
  const { book, meta } = openBook(bytes, 'n.txt', bytes.length);

  const samples = [
    Progress.computePercent(book, 0, 0),
    Progress.computePercent(book, 1, 0),
    Progress.computePercent(book, 1, 10),
    Progress.computePercent(book, 2, 0),
    Progress.computePercent(book, 2, book.chapters[2].end - book.chapters[2].start)
  ];

  for (let i = 1; i < samples.length; i++) {
    assert.ok(samples[i] >= samples[i - 1], `第 ${i} 个采样点不应小于前一个`);
  }
  assert.equal(samples[0], 0);
  assert.equal(samples[samples.length - 1], 100);
});

test('端到端：恢复位置与字号、页数无关（锚点是字符偏移而非页码）', () => {
  const bytes = utf8.encode(NOVEL_LINES.join('\n'));
  const { book, meta } = openBook(bytes, 'n.txt', bytes.length);
  const record = Progress.makeRecord(book, meta, 1, 6, 1);

  // 同一个记录反复恢复，绝对位置必须完全一致
  const first = Progress.resolvePosition(book, record.chapterIndex, record.charOffset);
  const second = Progress.resolvePosition(book, record.chapterIndex, record.charOffset);

  assert.deepEqual(first, second);
  assert.equal(book.chapters[first.chapterIndex].start + first.charOffset, book.chapters[1].start + 6);
});

test('端到端：无 BOM 的 GB18030 小文件也能读出中文', () => {
  // 手工构造 GBK 字节：中、文、小、说
  const bytes = Uint8Array.from([0xd6, 0xd0, 0xce, 0xc4, 0xd0, 0xa1, 0xcb, 0xb5]);
  const decoded = Encoding.decodeBuffer(bytes);
  assert.equal(decoded.encoding, 'gb18030');
  assert.equal(decoded.text, '中文小说');
  assert.equal(Encoding.garbledRatio(decoded.text), 0);
});

test('端到端：空文件在解析层形成 0 字符书籍，由调用方拦截', () => {
  const { book } = openBook(new Uint8Array([]), 'empty.txt', 0);
  assert.equal(book.totalChars, 0);
  assert.equal(book.chapters.length, 1);
});
