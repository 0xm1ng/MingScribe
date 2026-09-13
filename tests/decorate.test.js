const test = require('node:test');
const assert = require('node:assert/strict');
const Decorate = require('../src/decorate.js');

/** 把渲染结果里的标签去掉，还原为纯文本（用于验证「文本没被改动」）。 */
function stripped(html) {
  return html
    .replace(/<\/?mark[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

test('没有任何装饰时原样返回（仅转义）', () => {
  assert.equal(Decorate.renderDecoratedHtml('普通文本', 0, [], []), '普通文本');
  assert.equal(Decorate.renderDecoratedHtml('a<b>&c', 0, [], []), 'a&lt;b&gt;&amp;c');
  assert.equal(Decorate.renderDecoratedHtml('', 0, [], []), '');
  assert.equal(Decorate.renderDecoratedHtml(null, 0, [], []), '');
  assert.equal(Decorate.renderDecoratedHtml('文本', 0, null, null), '文本');
});

test('单个划线：包上带颜色与 id 的 mark', () => {
  const decos = [{ id: 'x1', chapterIndex: 0, start: 2, end: 5, color: 'green' }];
  const html = Decorate.renderDecoratedHtml('abcdefg', 0, decos, []);
  assert.equal(html, 'ab<mark class="hl hl-green" data-id="x1">cde</mark>fg');
});

test('划线区间按段落起始偏移裁剪，只有交叠的段落才加标签', () => {
  // 段落 A 覆盖章节 0~10，段落 B 覆盖 10~20
  const decos = [{ id: 'x1', start: 8, end: 14, color: 'yellow' }];

  const a = Decorate.renderDecoratedHtml('0123456789', 0, decos, []);
  assert.equal(a, '01234567<mark class="hl hl-yellow" data-id="x1">89</mark>');

  const b = Decorate.renderDecoratedHtml('0123456789', 10, decos, []);
  assert.equal(b, '<mark class="hl hl-yellow" data-id="x1">0123</mark>456789');

  const c = Decorate.renderDecoratedHtml('不相关的一段', 100, decos, []);
  assert.equal(c, '不相关的一段', '完全不相交的段落不应被改动');
});

test('带批注的划线多一个 with-note 标记，供 CSS 画小标', () => {
  const decos = [{ id: 'x1', start: 0, end: 3, color: 'blue', note: '我的想法' }];
  const html = Decorate.renderDecoratedHtml('abcdef', 0, decos, []);
  assert.equal(html, '<mark class="hl hl-blue with-note" data-id="x1">abc</mark>def');
});

test('未知颜色回退为黄色', () => {
  const decos = [{ id: 'x1', start: 0, end: 1, color: 'rainbow' }];
  assert.equal(Decorate.renderDecoratedHtml('ab', 0, decos, []), '<mark class="hl hl-yellow" data-id="x1">a</mark>b');
});

test('搜索命中嵌在划线的内层', () => {
  const decos = [{ id: 'x1', start: 0, end: 10, color: 'yellow' }];
  const hits = [[3, 6]];
  const html = Decorate.renderDecoratedHtml('abcdefghij', 0, decos, hits);
  assert.equal(
    html,
    '<mark class="hl hl-yellow" data-id="x1">abc<mark class="hit">def</mark>ghij</mark>'
  );
});

test('划线区间与搜索命中交叉时按边界切分，结构不错乱', () => {
  // 划线 10~20，命中 15~25：交叉部分两层都要有
  const decos = [{ id: 'x1', start: 10, end: 20, color: 'pink' }];
  const hits = [[15, 25]];
  const html = Decorate.renderDecoratedHtml('0123456789012345678901234567890', 0, decos, hits);
  assert.equal(
    html,
    '0123456789' +
      '<mark class="hl hl-pink" data-id="x1">01234<mark class="hit">56789</mark></mark>' +
      '<mark class="hit">01234</mark>' +
      '567890'
  );
});

test('多个命中与多个划线可以共存', () => {
  const decos = [
    { id: 'a', start: 0, end: 4, color: 'yellow' },
    { id: 'b', start: 8, end: 12, color: 'green' }
  ];
  const hits = [[2, 3], [9, 10]];
  const html = Decorate.renderDecoratedHtml('abcdefghijkl', 0, decos, hits);

  assert.equal(
    html,
    '<mark class="hl hl-yellow" data-id="a">ab<mark class="hit">c</mark>d</mark>' +
      'efgh' +
      '<mark class="hl hl-green" data-id="b">i<mark class="hit">j</mark>kl</mark>'
  );
  assert.equal(stripped(html), 'abcdefghijkl', '装饰不应改变原文');
});

test('重叠的划线区间也能渲染（存储层虽会拒绝，渲染层需容错）', () => {
  const decos = [
    { id: 'a', start: 0, end: 6, color: 'yellow' },
    { id: 'b', start: 3, end: 9, color: 'blue' }
  ];
  const html = Decorate.renderDecoratedHtml('abcdefghij', 0, decos, []);
  assert.equal(stripped(html), 'abcdefghij');
  assert.ok(html.includes('data-id="a"'));
  assert.ok(html.includes('data-id="b"'));
});

test('正文里的 HTML 与引号不会破坏结构', () => {
  const decos = [{ id: 'x1', start: 0, end: 8, color: 'yellow' }];
  const html = Decorate.renderDecoratedHtml('<img src="x">tail', 0, decos, []);
  assert.equal(html.includes('<img'), false, '正文不应被当成标签解析');
  assert.equal(
    html,
    '<mark class="hl hl-yellow" data-id="x1">&lt;img src</mark>=&quot;x&quot;&gt;tail'
  );
  assert.equal(stripped(html), '<img src="x">tail');
});

test('相邻片段属于同一条划线时合并成一个 mark，不重复输出标签', () => {
  const decos = [{ id: 'x1', start: 0, end: 10, color: 'yellow', note: '有批注' }];
  const hits = [[3, 6]];
  const html = Decorate.renderDecoratedHtml('abcdefghij', 0, decos, hits);

  assert.equal((html.match(/data-id="x1"/g) || []).length, 1, '同一条划线只应出现一次标签');
  assert.equal((html.match(/with-note/g) || []).length, 1, '批注小标不应重复');
});

test('越界与非法区间被安全忽略', () => {
  const decos = [
    { id: 'far', start: 500, end: 600, color: 'yellow' },
    { id: 'backwards', start: 8, end: 2, color: 'yellow' }
  ];
  assert.equal(Decorate.renderDecoratedHtml('abcdef', 0, decos, []), 'abcdef');

  const huge = [{ id: 'x', start: 0, end: 9999, color: 'yellow' }];
  assert.equal(
    Decorate.renderDecoratedHtml('abc', 0, huge, []),
    '<mark class="hl hl-yellow" data-id="x">abc</mark>'
  );
});

test('id 中的特殊字符被清理，避免注入属性', () => {
  const decos = [{ id: 'a"><script>', start: 0, end: 1, color: 'yellow' }];
  const html = Decorate.renderDecoratedHtml('ab', 0, decos, []);
  assert.equal(html.includes('<script>'), false);
  assert.equal(html, '<mark class="hl hl-yellow" data-id="ascript">a</mark>b');
});

test('idsInParagraph 列出与该段落相交的标注 id', () => {
  const decos = [
    { id: 'a', start: 0, end: 5 },
    { id: 'b', start: 20, end: 25 }
  ];
  assert.deepEqual(Decorate.idsInParagraph(0, '0123456789', decos), ['a']);
  assert.deepEqual(Decorate.idsInParagraph(20, '0123456789', decos), ['b']);
  assert.deepEqual(Decorate.idsInParagraph(100, '0123456789', decos), []);
  assert.deepEqual(Decorate.idsInParagraph(0, '0123456789', null), []);
});

test('clip 边界语义为左闭右开', () => {
  assert.deepEqual(Decorate.clip(0, 10, 0, 10), { start: 0, end: 10 });
  assert.equal(Decorate.clip(10, 20, 0, 10), null, '起点等于段落末尾时无交集');
  assert.deepEqual(Decorate.clip(5, 20, 0, 10), { start: 5, end: 10 });
  assert.equal(Decorate.clip(0, 0, 0, 10), null);
});
