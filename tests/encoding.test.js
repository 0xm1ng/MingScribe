const test = require('node:test');
const assert = require('node:assert/strict');
const Encoding = require('../src/encoding.js');

const utf8 = new TextEncoder();

test('无 BOM 的 UTF-8 文本按 UTF-8 解码', () => {
  const result = Encoding.decodeBuffer(utf8.encode('第一章 少年'));
  assert.equal(result.text, '第一章 少年');
  assert.equal(result.encoding, 'utf-8');
  assert.equal(result.viaBom, false);
});

test('带 BOM 的 UTF-8 文本会剥离 BOM', () => {
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8.encode('你好')]);
  const result = Encoding.decodeBuffer(bytes);
  assert.equal(result.text, '你好');
  assert.equal(result.encoding, 'utf-8');
  assert.equal(result.viaBom, true);
});

test('GB18030 字节序列在 UTF-8 试探失败后回退解码', () => {
  // "中文" 的 GBK / GB18030 编码：中 = D6D0，文 = CEC4
  const bytes = Uint8Array.from([0xd6, 0xd0, 0xce, 0xc4]);
  const result = Encoding.decodeBuffer(bytes);
  assert.equal(result.text, '中文');
  assert.equal(result.encoding, 'gb18030');
});

test('带 BOM 的 UTF-16LE 文本可解码', () => {
  const bytes = new Uint8Array([0xff, 0xfe, 0x2d, 0x4e, 0x87, 0x65]);
  const result = Encoding.decodeBuffer(bytes);
  assert.equal(result.text, '中文');
  assert.equal(result.encoding, 'utf-16le');
});

test('带 BOM 的 UTF-16BE 文本可解码', () => {
  const bytes = new Uint8Array([0xfe, 0xff, 0x4e, 0x2d, 0x65, 0x87]);
  const result = Encoding.decodeBuffer(bytes);
  assert.equal(result.text, '中文');
  assert.equal(result.encoding, 'utf-16be');
});

test('接受 ArrayBuffer 与 Uint8Array 两种输入', () => {
  const source = utf8.encode('测试');
  const fromView = Encoding.decodeBuffer(source);
  const fromBuffer = Encoding.decodeBuffer(source.buffer.slice(0));
  assert.equal(fromView.text, '测试');
  assert.equal(fromBuffer.text, '测试');
});

test('空字节序列返回空字符串而不报错', () => {
  const result = Encoding.decodeBuffer(new Uint8Array([]));
  assert.equal(result.text, '');
});

test('非字节输入抛出 TypeError', () => {
  assert.throws(() => Encoding.decodeBuffer('这不是字节'), TypeError);
  assert.throws(() => Encoding.decodeBuffer(null), TypeError);
});

test('stripBom 只移除开头的 BOM', () => {
  assert.equal(Encoding.stripBom('\ufeffabc'), 'abc');
  assert.equal(Encoding.stripBom('abc'), 'abc');
  assert.equal(Encoding.stripBom('a\ufeffb'), 'a\ufeffb');
});

test('garbledRatio 统计替换字符占比', () => {
  assert.equal(Encoding.garbledRatio(''), 0);
  assert.equal(Encoding.garbledRatio('正常文字'), 0);
  assert.equal(Encoding.garbledRatio('a\ufffdb\ufffd'), 0.5);
});
