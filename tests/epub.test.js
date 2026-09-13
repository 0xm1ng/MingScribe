'use strict';

/**
 * EPUB 解析层测试。
 * 夹具在内存中构造（tests/fixtures/make_epub.js），断言值全部可预期。
 */

const test = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');

const Epub = require('../src/epub.js');
const Progress = require('../src/progress.js');
const Search = require('../src/search.js');
const { buildSampleEpub, buildBrokenEpub, CHAPTERS, BOOK_TITLE } = require('./fixtures/make_epub.js');

/** Node 环境：把 inflateRawSync 包装成模块期望的注入形式。 */
const inflate = (u8) => Promise.resolve(new Uint8Array(zlib.inflateRawSync(Buffer.from(u8))));
const parse = (buf, opts) => Epub.parseEpub(buf, Object.assign({ inflate }, opts));

test('EPUB3：书名、章节数与 nav 目录标题', async () => {
  // nav 标题故意与章内 h1 不同，证明标题确实来自 nav 而不是 h1 兜底
  const navTitles = ['导航一', '导航二', '导航三'];
  const book = await parse(buildSampleEpub({ nav: true, ncx: true, navTitles }));
  assert.equal(book.title, BOOK_TITLE);
  assert.equal(book.chapters.length, 3);
  assert.deepEqual(book.chapters.map((c) => c.title), navTitles);
});

test('stored 与 deflate 混合压缩的条目都能读出', async () => {
  const book = await parse(buildSampleEpub());
  // 夹具里第一章是 stored，其余是 deflate；两章都有正文即证明两条路径都通
  assert.ok(book.chapters[0].text.includes('这是第一章的正文'));
  assert.ok(book.chapters[1].text.includes('嵌套 div'));
  assert.ok(book.chapters[2].text.includes('最后一章内容'));
});

test('章节偏移连续，text 与 chapters 一致', async () => {
  const book = await parse(buildSampleEpub());
  for (let i = 0; i < book.chapters.length; i++) {
    const c = book.chapters[i];
    assert.equal(c.index, i);
    assert.equal(c.end - c.start, c.text.length, `第 ${i} 章 start/end 与 text 长度不符`);
    if (i > 0) {
      assert.equal(c.start, book.chapters[i - 1].end + 1, '章与章之间应恰好隔一个换行符');
    }
  }
  assert.equal(book.text, book.chapters.map((c) => c.text).join('\n'));
  assert.equal(book.totalChars, book.text.length);
});

test('实体解码：&amp; &lt; &gt; 与 &#x; 数字实体', async () => {
  const book = await parse(buildSampleEpub());
  const text = book.chapters[0].text;
  assert.ok(text.includes('A & B <C> 与中文数字 中文。'), '实体未正确解码: ' + text.slice(0, 60));
  assert.ok(!text.includes('&amp;') && !text.includes('&#x4e2d;'));
});

test('块级标签产生换行，行内空白压成单空格', async () => {
  const book = await parse(buildSampleEpub());
  const lines = book.chapters[0].text.split('\n');
  assert.ok(lines.length >= 3, '两个段落 + 标题至少应有 3 行');
  assert.ok(lines.some((l) => l === '第二段文字用来验证分块换行。'), '第二段应独立成行');
  assert.ok(book.chapters[1].text.includes('嵌套 div 里的加粗文字。'), '标签应剥离、行内空白压缩');
});

test('图片转成 [图片：alt] 占位，样式与脚本不进正文', async () => {
  const book = await parse(buildSampleEpub());
  assert.ok(book.chapters[1].text.includes('[图片：示意图说明]'));
  assert.ok(!book.text.includes('color:red'), 'style 内容不应进入正文');
});

test('EPUB2：没有 nav 时用 NCX 目录标题', async () => {
  const ncxTitles = ['NCX 第一章', 'NCX 第二章', 'NCX 第三章'];
  const book = await parse(buildSampleEpub({ nav: false, ncx: true, ncxTitles }));
  assert.deepEqual(book.chapters.map((c) => c.title), ncxTitles);
});

test('没有 nav 和 NCX 时，用章内第一个标题兜底', async () => {
  const book = await parse(buildSampleEpub({ nav: false, ncx: false }));
  assert.deepEqual(book.chapters.map((c) => c.title), CHAPTERS.map((c) => c.title));
});

test('纯空白章节被跳过，不进目录', async () => {
  const book = await parse(buildSampleEpub({ blank: true }));
  assert.equal(book.chapters.length, 3);
  assert.ok(!book.chapters.some((c) => c.title === '空白章'));
});

test('坏文件给出可读的错误信息', async () => {
  await assert.rejects(() => parse(buildBrokenEpub('notzip')), /不是有效的 EPUB/);
  await assert.rejects(() => parse(buildBrokenEpub('nocontainer')), /container\.xml/);
  await assert.rejects(() => parse(buildBrokenEpub('nospine')), /spine 为空/);
  await assert.rejects(() => parse(buildBrokenEpub('nocontent')), /没有可读的文字内容/);
});

test('解析是确定性的：同一字节两次解析结果完全一致', async () => {
  const buf = buildSampleEpub();
  const a = await parse(buf);
  const b = await parse(buf);
  assert.deepEqual(a, b);
});

test('缓存重建往返：text + toc → 与原解析一致', async () => {
  const book = await parse(buildSampleEpub());
  const toc = book.chapters.map((c) => ({ title: c.title, start: c.start, end: c.end }));
  const rebuilt = Epub.rebuildFromCache(book.text, toc, book.title);

  assert.equal(rebuilt.title, book.title);
  assert.equal(rebuilt.totalChars, book.totalChars);
  assert.equal(rebuilt.text, book.text);
  assert.deepEqual(rebuilt.chapters, book.chapters);
});

test('缓存重建：toc 与 text 不同步时按当前 text 重算，不越界', () => {
  const rebuilt = Epub.rebuildFromCache('一二三四五六七八九十', [
    { title: 'A', start: 0, end: 4 },
    { title: 'B', start: 4, end: 8 },
    { title: '越界', start: 99, end: 120 }
  ]);
  assert.deepEqual(
    rebuilt.chapters.map((c) => c.text),
    ['一二三四', '五六七八']
  );
});

test('缓存重建：参数无效时返回 null', () => {
  assert.equal(Epub.rebuildFromCache(null, [{ title: 'a', start: 0, end: 1 }]), null);
  assert.equal(Epub.rebuildFromCache('正文', null), null);
  assert.equal(Epub.rebuildFromCache('正文', []), null);
});

test('解析结果可直接对接进度与搜索模块（坐标系兼容）', async () => {
  const book = await parse(buildSampleEpub());
  const saved = { chapterIndex: 1, charOffset: 5 };
  const pos = Progress.resolvePosition(book, saved.chapterIndex, saved.charOffset);
  assert.equal(pos.chapterIndex, 1);

  const found = Search.searchBook(book, '第一章');
  assert.ok(found.total >= 1);
  assert.equal(found.results[0].chapterIndex, 0);
});

test('isEpubName 按扩展名判断', () => {
  assert.equal(Epub.isEpubName('a.epub'), true);
  assert.equal(Epub.isEpubName('A.EPUB'), true);
  assert.equal(Epub.isEpubName('a.txt'), false);
  assert.equal(Epub.isEpubName('epub'), false);
  assert.equal(Epub.isEpubName(''), false);
});

test('decodeEntities 覆盖常用分支', () => {
  assert.equal(Epub.decodeEntities('&amp;&lt;&gt;&quot;&apos;'), '&<>"\'');
  assert.equal(Epub.decodeEntities('&#20013;&#x6587;'), '中文');
  assert.equal(Epub.decodeEntities('&nbsp;'), '\u00a0');
  assert.equal(Epub.decodeEntities('&unknown;'), '&unknown;');
  assert.equal(Epub.decodeEntities('&#999999999;'), '&#999999999;');
  assert.equal(Epub.decodeEntities(''), '');
});

test('xhtmlToText：br 产生换行、注释被移除', () => {
  const text = Epub.xhtmlToText('<body><p>甲<!-- 注释 -->乙</p><p>丙<br/>丁</p></body>');
  assert.deepEqual(text.split('\n'), ['甲乙', '丙', '丁']);
});
