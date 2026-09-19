/**
 * PDF 夹具生成器的测试。
 *
 * 为什么要给「测试用的夹具」再写测试：它手写的是 PDF 二进制结构，
 * 其中 /Length 必须与实际流字节数严格相等 —— 差一个字节，pdf.js 会静默解析失败，
 * 表现出来却是「端到端自检莫名其妙挂了」，排查成本极高。这里把它钉死。
 *
 * 跑法：npm test
 */
const test = require('node:test');
const assert = require('node:assert');
const { buildPdf, buildRichPdf } = require('./fixtures/make_pdf.js');

/** 取出所有 stream 的「声明长度」与「实际内容」，逐一比对。 */
function streamLengths(pdf) {
  const out = [];
  const re = /<< \/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/g;
  let m;
  while ((m = re.exec(pdf)) !== null) {
    out.push({ declared: Number(m[1]), actual: m[2].length });
  }
  return out;
}

/** 页对象里 /Kids 数组声明的页数（每项形如「5 0 R」，不是三个空格分隔的 token）。 */
function pageCount(pdf) {
  const m = pdf.match(/\/Type \/Pages \/Kids \[([^\]]*)\]/);
  if (!m) return 0;
  return (m[1].match(/\d+ 0 R/g) || []).length;
}

test('buildPdf：结构完整，页数正确', () => {
  const pdf = buildPdf(3);
  assert.ok(pdf.startsWith('%PDF-1.4'), '应以 %PDF-1.4 开头');
  assert.ok(pdf.trimEnd().endsWith('%%EOF'), '应以 %%EOF 结尾');
  assert.equal(pageCount(pdf), 3);
  assert.ok(/\/Count 3\b/.test(pdf), '/Pages 的 Count 应为 3');
  assert.ok(/xref\n0 \d+/.test(pdf), '应有 xref 表');
  assert.ok(/startxref\n\d+\n%%EOF/.test(pdf), '应有 startxref');
});

test('buildPdf：每页一行字，页号递增', () => {
  const pdf = buildPdf(3);
  assert.ok(pdf.includes('(MingScribe PDF Page 1)'));
  assert.ok(pdf.includes('(MingScribe PDF Page 2)'));
  assert.ok(pdf.includes('(MingScribe PDF Page 3)'));
});

test('两家生成器的 /Length 都等于实际流长度（差一字节就解析失败）', () => {
  const cases = [
    ['buildPdf', buildPdf(4)],
    ['buildRichPdf', buildRichPdf([['# T', 'alpha'], ['# U', 'beta', 'gamma']])]
  ];
  cases.forEach(([name, pdf]) => {
    const lens = streamLengths(pdf);
    assert.ok(lens.length > 0, name + ' 应至少有一个内容流');
    lens.forEach((s, i) => {
      assert.equal(s.declared, s.actual, name + ' 第 ' + (i + 1) + ' 个流的 /Length 与内容长度不符');
    });
  });
});

test('buildRichPdf：页数跟输入走，缺行也不会造出空页', () => {
  assert.equal(pageCount(buildRichPdf([['a'], ['b'], ['c']])), 3);
  // 传空数组时给一页占位，而不是生成一个零页的非法 PDF
  assert.equal(pageCount(buildRichPdf([])), 1);
  assert.equal(pageCount(buildRichPdf(null)), 1);
});

test('buildRichPdf：# 开头的行当标题，字号明显大于正文', () => {
  const pdf = buildRichPdf([['# Heading', 'body text']]);
  const sizes = [...pdf.matchAll(/\/F1 ([\d.]+) Tf/g)].map((m) => Number(m[1]));
  assert.equal(sizes.length, 2, '两行应各有一个字号设置');
  assert.ok(sizes[0] > sizes[1] * 1.5, '标题字号应远大于正文：' + sizes.join(' / '));
  assert.ok(!pdf.includes('(# '), '井号本身不该出现在正文里');
});

test('buildRichPdf：括号与反斜杠被转义，不会截断字符串', () => {
  const pdf = buildRichPdf([['see (1) and (2)', 'back\\slash']]);
  assert.ok(pdf.includes('(see \\(1\\) and \\(2\\))'), '圆括号应转义');
  assert.ok(pdf.includes('(back\\\\slash)'), '反斜杠应转义');
  streamLengths(pdf).forEach((s) => assert.equal(s.declared, s.actual));
});

test('buildRichPdf：超出页面高度的行被丢弃，不会溢出到纸外', () => {
  const many = Array.from({ length: 200 }, (_, i) => 'line ' + i);
  const pdf = buildRichPdf([many]);
  const drawn = [...pdf.matchAll(/Tj ET/g)].length;
  assert.ok(drawn > 0 && drawn < 200, '应画一部分就停手，实际画了 ' + drawn + ' 行');
  assert.ok(!pdf.includes('(line 199)'), '最后一行的 y 已超出页面，不该出现');
});
