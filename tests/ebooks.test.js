/**
 * 校验 D:\电子书资源\txt 下的电子书可被 MingScribe 解析器正确切分。
 *
 * 该目录由 tools/build_ebooks.py 生成，并非所有环境都存在，
 * 因此文件缺失时优雅跳过，不使测试失败。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const Parser = require('../src/parser.js');

const EBOOK_DIR = 'D:\\电子书资源\\txt';

const EXPECTED = [
  { file: 'Hello-CTF - 开源CTF入门教程.txt', minChapters: 50 },
  { file: 'Web安全学习笔记.txt', minChapters: 30 },
  { file: 'OWASP Web安全测试指南(英文版).txt', minChapters: 30 },
  { file: 'CTF-All-In-One - CTF竞赛权威指南.txt', minChapters: 50 },
];

/** 安全软件（Windows Defender）会阻断含 exploit 代码的文本，表现为 errno -4094。 */
const BLOCKED_CODES = new Set(['UNKNOWN', 'EPERM', 'EACCES']);

/** 统计疑似 Markdown 残留（图片语法、围栏代码块、裸链接）。 */
function markdownResidue(text) {
  const hits =
    (text.match(/!\[[^\]]*\]\([^)]*\)/g) || []).length +
    (text.match(/^```/gm) || []).length +
    (text.match(/\]\(https?:\/\//g) || []).length;
  return hits;
}

for (const item of EXPECTED) {
  test(`电子书可解析：${item.file}`, (t) => {
    const full = path.join(EBOOK_DIR, item.file);
    if (!fs.existsSync(full)) {
      t.skip('电子书目录不存在，跳过（由 tools/build_ebooks.py 生成）');
      return;
    }

    let raw;
    try {
      raw = fs.readFileSync(full, 'utf8');
    } catch (e) {
      if (BLOCKED_CODES.has(e.code) || e.errno === -4094) {
        t.skip('该文件被安全软件阻断，需用户在 Defender 中恢复并添加排除项');
        return;
      }
      throw e;
    }
    assert.ok(raw.length > 100 * 1024, `文件过小，疑似生成失败：${raw.length} 字符`);

    const book = Parser.parseTxt(raw, { bookTitle: item.file });

    // 1. 章节必须能被识别（否则阅读器目录为空）
    assert.ok(
      book.chapters.length >= item.minChapters,
      `识别章节数不足：${book.chapters.length} < ${item.minChapters}`
    );
    assert.ok(
      book.stats.recognizedChapters >= item.minChapters,
      `正则命中标题行不足：${book.stats.recognizedChapters}`
    );

    // 2. 章节标题不应含 Markdown 残留
    for (const ch of book.chapters) {
      assert.ok(!/[*`#]/.test(ch.title), `章节标题含 Markdown 符号：${ch.title}`);
      assert.ok(ch.title.length > 0 && ch.title.length <= 30, `章节标题长度异常：${ch.title}`);
    }

    // 3. 编码无损：替换字符（U+FFFD）比例应极低
    const garbled = (raw.match(/\uFFFD/g) || []).length;
    assert.ok(garbled / raw.length < 0.001, `乱码字符过多：${garbled}`);

    // 4. Markdown 残留应极低
    const residue = markdownResidue(raw);
    assert.ok(residue / raw.length < 0.0005, `Markdown 残留过多：${residue}`);

    // 5. 章节偏移连续且可覆盖全文
    let prevEnd = 0;
    for (const ch of book.chapters) {
      assert.ok(ch.start >= prevEnd, `章节区间重叠：${ch.title}`);
      assert.ok(ch.end >= ch.start, `章节区间非法：${ch.title}`);
      prevEnd = ch.end;
    }
    assert.ok(
      book.chapters[book.chapters.length - 1].end <= raw.length,
      '末章终点越界'
    );

    console.log(
      `  ${item.file}\n` +
        `    字符 ${raw.length.toLocaleString()} | 章节 ${book.chapters.length} | ` +
        `乱码 ${garbled} | Markdown 残留 ${residue}`
    );
  });
}
