const test = require('node:test');
const assert = require('node:assert/strict');
const Search = require('../src/search.js');

/** 构造可控的中间格式书籍对象（与 Parser.parseTxt 输出结构一致）。 */
function makeBook(specs) {
  let cursor = 0;
  const chapters = specs.map((spec, i) => {
    const start = cursor;
    const text = spec.text;
    cursor += text.length;
    return { index: i, title: spec.title, start, end: cursor, text };
  });
  return {
    title: '测试书',
    text: chapters.map((c) => c.text).join(''),
    totalChars: cursor,
    chapters
  };
}

test('空关键词、空书都返回空结果而不是报错', () => {
  const book = makeBook([{ title: '一', text: '内容' }]);
  assert.equal(Search.searchBook(book, '').total, 0);
  assert.equal(Search.searchBook(book, '   ').total, 0);
  assert.equal(Search.searchBook(book, null).total, 0);
  assert.equal(Search.searchBook(null, '内容').total, 0);
  assert.equal(Search.searchBook({ chapters: [] }, '内容').total, 0);
});

test('命中位置可用于直接跳转：章节号 + 章节内偏移 + 全书偏移', () => {
  const book = makeBook([
    { title: '第一章', text: '第一章 开端\n这里出现了关键词ABC。' },
    { title: '第二章', text: '第二章 发展\n这个章节里没有那个词。' }
  ]);

  const res = Search.searchBook(book, '关键词');
  assert.equal(res.total, 1);
  assert.equal(res.results[0].chapterIndex, 0);
  assert.equal(res.results[0].chapterTitle, '第一章');
  assert.equal(res.results[0].offset, book.chapters[0].text.indexOf('关键词'));
  assert.equal(res.results[0].globalOffset, res.results[0].offset);

  // 两章各命中一次，用于验证跨章节定位
  const second = Search.searchBook(book, '第');
  assert.equal(second.total, 2);
  assert.deepEqual(second.results.map((r) => r.chapterIndex), [0, 1]);
  // 第二章的全文偏移应当接续在第一章之后
  assert.equal(second.results[1].globalOffset, book.chapters[1].start + second.results[1].offset);
});

test('默认忽略大小写，可显式要求区分', () => {
  const book = makeBook([{ title: '一', text: 'Hello world, hello again.' }]);
  assert.equal(Search.searchBook(book, 'hello').total, 2);
  assert.equal(Search.searchBook(book, 'HELLO').total, 2);
  assert.equal(Search.searchBook(book, 'hello', { caseSensitive: true }).total, 1);
});

test('关键词按字面量匹配，正则元字符不会被解释', () => {
  const book = makeBook([{ title: '一', text: 'a.b 与 axb 与 C++ 与 (test)' }]);

  // 若当成正则，'a.b' 也会命中 axb；按字面量则只命中一次
  const dot = Search.searchBook(book, 'a.b');
  assert.equal(dot.total, 1);
  assert.equal(book.text.slice(dot.results[0].globalOffset, dot.results[0].globalOffset + 3), 'a.b');

  // 'C++' 作为正则会抛异常，必须能正常返回
  const plus = Search.searchBook(book, 'C++');
  assert.equal(plus.total, 1);

  // 括号同样安全
  assert.equal(Search.searchBook(book, '(test)').total, 1);
});

test('没有命中时 total 为 0', () => {
  const book = makeBook([{ title: '一', text: '一些内容' }]);
  const res = Search.searchBook(book, '绝不存在的词');
  assert.equal(res.total, 0);
  assert.deepEqual(res.results, []);
});

test('结果总数受 maxResults 限制并标记截断', () => {
  const book = makeBook([{ title: '一', text: 'x'.repeat(100) }]);
  const res = Search.searchBook(book, 'x', { maxResults: 5 });
  assert.equal(res.total, 5);
  assert.equal(res.truncated, true);
  assert.equal(res.results.length, 5);
});

test('单章结果受 maxPerChapter 限制，避免一章刷屏', () => {
  const book = makeBook([
    { title: '一', text: 'x'.repeat(10) },
    { title: '二', text: 'x'.repeat(10) }
  ]);
  const res = Search.searchBook(book, 'x', { maxPerChapter: 3 });
  assert.equal(res.total, 6);
  assert.equal(res.truncated, true);
  assert.equal(res.results.filter((r) => r.chapterIndex === 0).length, 3);
});

test('未达上限时不标记截断', () => {
  const book = makeBook([
    { title: '一', text: '这里有关键词' },
    { title: '二', text: '这里也有关键词' }
  ]);
  const res = Search.searchBook(book, '关键词');
  assert.equal(res.total, 2);
  assert.equal(res.truncated, false);
});

test('摘要包含关键词且命中区间可直接用于高亮', () => {
  const prefix = '前'.repeat(60);
  const suffix = '后'.repeat(60);
  const book = makeBook([{ title: '一', text: prefix + '目标词' + suffix }]);

  const res = Search.searchBook(book, '目标词');
  const hit = res.results[0];

  assert.ok(hit.snippet.includes('目标词'));
  assert.equal(hit.snippet.slice(hit.hitStart, hit.hitEnd), '目标词');
  // 摘要被截断，不应把整章都塞进来
  assert.ok(hit.snippet.length < 80);
  // 摘要里不应残留换行，否则列表排版会乱
  assert.equal(/\n/.test(hit.snippet), false);
});

test('摘要首尾的省略号标记正确', () => {
  const book = makeBook([{ title: '一', text: '开头' + '中'.repeat(100) + '结尾' }]);
  const head = Search.searchBook(book, '开头').results[0];
  const tail = Search.searchBook(book, '结尾').results[0];

  assert.equal(head.snippet.startsWith('…'), false);
  assert.equal(head.snippet.endsWith('…'), true);
  assert.equal(tail.snippet.startsWith('…'), true);
  assert.equal(tail.snippet.endsWith('…'), false);
});

test('highlightRanges 返回互不重叠的升序区间', () => {
  const ranges = Search.highlightRanges('abc abc abc', 'abc');
  assert.deepEqual(ranges, [[0, 3], [4, 7], [8, 11]]);

  assert.deepEqual(Search.highlightRanges('', 'abc'), []);
  assert.deepEqual(Search.highlightRanges('abc', ''), []);
  assert.deepEqual(Search.highlightRanges('abc', 'zzz'), []);
});

test('renderHighlightedHtml 转义 HTML，正文里的尖括号不会破坏页面', () => {
  const html = Search.renderHighlightedHtml('a<b>c', [[1, 2]]);
  assert.equal(html, 'a<mark>&lt;</mark>b&gt;c');

  // 把 mark 标签去掉后应能还原原始文本
  const source = '<script>alert("x")</script>';
  const rendered = Search.renderHighlightedHtml(source, [[0, 5]]);
  assert.equal(rendered.replace(/<\/?mark>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&'),
    source);
  assert.equal(/<script>/.test(rendered), false);
});

test('renderHighlightedHtml 容错重叠与越界区间', () => {
  assert.equal(Search.renderHighlightedHtml('abcdef', [[0, 4], [2, 3]]), '<mark>abcd</mark>ef');
  assert.equal(Search.renderHighlightedHtml('abc', [[5, 9]]), 'abc');
  assert.equal(Search.renderHighlightedHtml('abc', [[1, 1]]), 'abc');
  assert.equal(Search.renderHighlightedHtml('abc', null), 'abc');
  assert.equal(Search.renderHighlightedHtml('', []), '');
  assert.equal(Search.renderHighlightedHtml(null, [[0, 1]]), '');
});

test('firstIndexFrom 从当前位置往后找，找不到则回绕到第一条', () => {
  const results = [{ globalOffset: 10 }, { globalOffset: 30 }, { globalOffset: 50 }];
  assert.equal(Search.firstIndexFrom(results, 0), 0);
  assert.equal(Search.firstIndexFrom(results, 10), 0);
  assert.equal(Search.firstIndexFrom(results, 25), 1);
  assert.equal(Search.firstIndexFrom(results, 50), 2);
  assert.equal(Search.firstIndexFrom(results, 60), 0); // 回绕
  assert.equal(Search.firstIndexFrom([], 5), -1);
  assert.equal(Search.firstIndexFrom(results, null), 0);
});

test('大书搜索不会超时（30 万字量级）', () => {
  const specs = [];
  for (let i = 0; i < 30; i++) {
    specs.push({ title: '第 ' + (i + 1) + ' 章', text: ('安全测试内容 '.repeat(1200)) + '唯一关键词' });
  }
  const book = makeBook(specs);
  assert.ok(book.totalChars > 200000, '构造的测试书应足够大，实际 ' + book.totalChars);

  const started = Date.now();
  const res = Search.searchBook(book, '唯一关键词');
  const cost = Date.now() - started;

  assert.equal(res.total, 30);
  assert.ok(cost < 2000, '搜索耗时过长：' + cost + 'ms');
});
