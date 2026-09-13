const test = require('node:test');
const assert = require('node:assert/strict');
const Parser = require('../src/parser.js');

test('识别中文章节标题并正确切分', () => {
  const text = ['第一章 少年', '正文甲。', '', '第二章 相遇', '正文乙。', ''].join('\n');
  const book = Parser.parseTxt(text);

  assert.equal(book.chapters.length, 2);
  assert.equal(book.chapters[0].title, '第一章 少年');
  assert.equal(book.chapters[1].title, '第二章 相遇');
  assert.equal(book.stats.recognizedChapters, 2);
});

test('识别阿拉伯数字、Chapter 与番外等别名', () => {
  const text = [
    '序章',
    '这是序章的正文。',
    '第1章 起点',
    '第一章的正文。',
    'Chapter 2',
    '第二章的正文。',
    '番外一',
    '番外的正文。'
  ].join('\n');

  const book = Parser.parseTxt(text);
  assert.deepEqual(book.chapters.map((c) => c.title), ['序章', '第1章 起点', 'Chapter 2', '番外一']);
});

test('章节的 start/end 连续且能和全文切片对齐', () => {
  const text = ['第一章 起', '甲。', '第二章 承', '乙。', '第三章 转', '丙。'].join('\n');
  const book = Parser.parseTxt(text);

  assert.equal(book.chapters[0].start, 0);
  assert.equal(book.chapters[book.chapters.length - 1].end, book.totalChars);

  book.chapters.forEach((chapter, i) => {
    // 切片必须与章节文本完全一致，这是字符偏移锚点可信的前提
    assert.equal(book.text.slice(chapter.start, chapter.end), chapter.text);
    assert.equal(chapter.index, i);
    if (i > 0) assert.equal(book.chapters[i - 1].end, chapter.start);
  });
});

test('第一个标题之前的内容单独成「前言」章', () => {
  const text = ['这是一段没有标题的开场白。', '第一章 正式开始', '正文。'].join('\n');
  const book = Parser.parseTxt(text);

  assert.equal(book.chapters.length, 2);
  assert.equal(book.chapters[0].title, '前言');
  assert.equal(book.chapters[0].start, 0);
  assert.equal(book.chapters[0].text, '这是一段没有标题的开场白。\n');
  assert.equal(book.chapters[1].title, '第一章 正式开始');
});

test('纯空白前缀不生成前言章', () => {
  const text = ['', '', '第一章 开始', '正文。'].join('\n');
  const book = Parser.parseTxt(text);
  assert.equal(book.chapters.length, 1);
  assert.equal(book.chapters[0].title, '第一章 开始');
});

test('没有章节标记时全文作为单章', () => {
  const text = '一段没有任何章节标题的散文。\n第二段。';
  const book = Parser.parseTxt(text, { bookTitle: '散文集' });

  assert.equal(book.chapters.length, 1);
  assert.equal(book.chapters[0].title, '散文集');
  assert.equal(book.chapters[0].text, text);
  assert.equal(book.stats.recognizedChapters, 0);
});

test('正文中的伪章节句子不会被误判', () => {
  const text = [
    '第一章 真正的标题',
    '他翻到第三章的内容很精彩，忍不住又读了一遍。',
    '第三章的内容很精彩',
    '第一章和第二章的写作手法完全不同，这一点值得注意',
    '第二章 另一个真标题'
  ].join('\n');

  const book = Parser.parseTxt(text);
  assert.deepEqual(book.chapters.map((c) => c.title), ['第一章 真正的标题', '第二章 另一个真标题']);
});

test('超长行不会被当作标题', () => {
  const long = '第一章' + '很'.repeat(40);
  const book = Parser.parseTxt(['第一章 正常', '正文。', long].join('\n'));
  assert.deepEqual(book.chapters.map((c) => c.title), ['第一章 正常']);
});

test('CRLF 与 CR 换行会被归一化为 LF', () => {
  const book = Parser.parseTxt('第一章 甲\r\n正文甲。\r\n第二章 乙\r正文乙。');
  assert.equal(book.text.indexOf('\r'), -1);
  assert.equal(book.chapters.length, 2);
  assert.equal(book.chapters[1].title, '第二章 乙');
});

test('BOM 会被剥离且不影响偏移', () => {
  const book = Parser.parseTxt('\ufeff第一章 甲\n正文。');
  assert.equal(book.text.charCodeAt(0), '第'.charCodeAt(0));
  assert.equal(book.chapters[0].start, 0);
  assert.equal(book.text.slice(book.chapters[0].start, book.chapters[0].end), book.chapters[0].text);
});

test('空文本返回 0 字符与 1 个空章', () => {
  const book = Parser.parseTxt('');
  assert.equal(book.totalChars, 0);
  assert.equal(book.chapters.length, 1);
  assert.equal(book.chapters[0].text, '');
});

test('isChapterTitle 单行判断符合预期', () => {
  assert.equal(Parser.isChapterTitle('第十二回 大闹天宫'), true);
  assert.equal(Parser.isChapterTitle('  第十章  '), true);
  assert.equal(Parser.isChapterTitle('楔子'), true);
  assert.equal(Parser.isChapterTitle('第二章的内容很精彩'), false);
  assert.equal(Parser.isChapterTitle('这是一句普通的正文。'), false);
  assert.equal(Parser.isChapterTitle(''), false);
});

test('自定义 titlePattern 可覆盖默认规则', () => {
  const text = ['== 第一节 ==', '正文。', '== 第二节 ==', '正文。'].join('\n');
  const book = Parser.parseTxt(text, { titlePattern: /^==\s*第[一二三四五六七八九十]+节\s*==$/ });
  assert.equal(book.chapters.length, 2);
  assert.equal(book.chapters[0].title, '== 第一节 ==');
});
