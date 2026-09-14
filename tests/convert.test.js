'use strict';

/**
 * 转换层测试。
 * 重点：格式识别 + convertToEpub 的合同（后端可注入、无后端报错）+
 * 端到端管道（mock run 产出 EPUB → Epub.parseEpub 能解析）。
 * 不依赖真实 Calibre——run 由测试用例注入。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const Convert = require('../src/convert.js');
const Epub = require('../src/epub.js');
const { buildSampleEpub } = require('./fixtures/make_epub.js');

const inflate = (u8) => Promise.resolve(new Uint8Array(zlib.inflateRawSync(Buffer.from(u8))));
const parseEpub = (buf) => Epub.parseEpub(buf, { inflate });

test('isConvertible：受支持的待转换格式识别为 true', () => {
  ['book.mobi', 'a.AZW3', 'x.azw', 'doc.docx', 'note.rtf', 't.odt', 'n.html', 'n.htm',
    'f.FB2', 'old.lit', 'p.pdb', 'p.prc', 's.snb', 'comic.cbr', 'comic.cbz', 'kindle.kfx'
  ].forEach((name) => {
    assert.equal(Convert.isConvertible(name), true, name + ' 应可转换');
  });
});

test('isConvertible：原生格式与不支持格式应为 false', () => {
  ['book.txt', 'book.TXT', 'book.epub', 'EPUB', 'scan.pdf', 'img.png', 'data.json',
    'noext', '', 'weird.tar.gz'
  ].forEach((name) => {
    assert.equal(Convert.isConvertible(name), false, name + ' 不应走转换管道');
  });
});

test('supportedFormats 返回一份拷贝，且不含原生 txt/epub', () => {
  const list = Convert.supportedFormats();
  assert.ok(list.indexOf('txt') === -1, '不应包含原生 txt');
  assert.ok(list.indexOf('epub') === -1, '不应包含原生 epub');
  assert.ok(list.indexOf('mobi') !== -1);
  // 返回的是拷贝，外部修改不影响内部
  list.push('hack');
  assert.equal(Convert.supportedFormats().indexOf('hack'), -1);
});

test('convertToEpub：缺少 inputPath / outputPath 报错', async () => {
  await assert.rejects(() => Convert.convertToEpub({ outputPath: 'o.epub', run() {} }), /输入路径/);
  await assert.rejects(() => Convert.convertToEpub({ inputPath: 'i.mobi', run() {} }), /输出路径/);
});

test('convertToEpub：未注入 run 后端时报「未配置转换后端」', async () => {
  await assert.rejects(
    () => Convert.convertToEpub({ inputPath: 'i.mobi', outputPath: 'o.epub' }),
    /未配置转换后端/
  );
  assert.equal(Convert.hasBackend(undefined), false);
  assert.equal(Convert.hasBackend(function () {}), true);
});

test('convertToEpub：mock run 复制 EPUB 后，产物可被 Epub.parseEpub 解析', async () => {
  // 构造一个真实可用的 EPUB 作为「转换产物」
  const sample = buildSampleEpub({ nav: true, ncx: true, navTitles: ['甲', '乙', '丙'] });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mingscribe-convert-'));
  const inputPath = path.join(tmp, 'src.mobi');
  const outputPath = path.join(tmp, 'out.epub');
  fs.writeFileSync(inputPath, Buffer.from([0x00])); // 源文件内容无所谓，run 会覆盖输出

  // 注入的 run：把样本 EPUB 写到 outputPath，模拟 ebook-convert 的行为
  const run = (inp, outp) => Promise.resolve().then(() => {
    fs.writeFileSync(outp, Buffer.from(sample));
  });

  const res = await Convert.convertToEpub({ inputPath, outputPath, run });
  assert.equal(res.epubPath, outputPath);

  const epubBytes = fs.readFileSync(outputPath);
  const book = await parseEpub(epubBytes.buffer.slice(epubBytes.byteOffset, epubBytes.byteOffset + epubBytes.byteLength));
  assert.equal(book.chapters.length, 3, '转换产物应能被现有 EPUB 解析层读取');
  assert.deepEqual(book.chapters.map((c) => c.title), ['甲', '乙', '丙']);

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('convertToEpub：run 失败时把错误向外透传', async () => {
  const run = () => Promise.reject(new Error('ebook-convert 退出码非零'));
  await assert.rejects(
    () => Convert.convertToEpub({ inputPath: 'i.mobi', outputPath: 'o.epub', run }),
    /ebook-convert 退出码非零/
  );
});
