'use strict';

/**
 * 格式转换链路端到端自检（需在已安装 Calibre 的机器上运行）。
 *
 * 验证整条「源格式 → ebook-convert → EPUB → Epub.parseEpub 能解析」链路是否打通，
 * 模拟桌面版（Tauri + Calibre）里「选一个非原生格式 → 自动转 EPUB → 进入阅读器」的过程。
 *
 * 设计要点：
 *  - 浏览器 / CI 通常没有 Calibre；检测不到 `ebook-convert` 时**自动跳过**（退出码 0），
 *    不污染交付门禁。
 *  - 真正调用 `ebook-convert` 的执行器（run）在这里实现，与 src/convert.js 的「可注入后端」
 *    接口一致——也就是说这个脚本就是桌面版转换后端的「真实版」参考实现。
 *  - 只依赖 Node 内置模块 + 本仓库 src/ 下的纯逻辑模块，无需额外 npm 包。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync, execFileSync: _exec } = require('node:child_process');

function log(msg) { console.log('[convert-check] ' + msg); }
function fail(msg) { console.error('[convert-check] ' + msg); process.exit(1); }

/** 解析 --input / --output 参数。 */
function parseArgs(argv) {
  const out = { input: null, output: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--input') out.input = argv[++i];
    else if (argv[i] === '--output') out.output = argv[++i];
    else if (argv[i] === '-h' || argv[i] === '--help') {
      console.log('用法: node tools/convert_check.js [--input 源文件] [--output 输出.epub]');
      console.log('  无 --input 时用一个自带的最小 HTML 样例验证；源文件应为 mobi/azw3/docx/fb2/html 等可转格式。');
      process.exit(0);
    }
  }
  return out;
}

/** 检测 ebook-convert 是否在 PATH。 */
function hasCalibre() {
  try {
    execFileSync('ebook-convert', ['--version'], { stdio: 'ignore' });
    return true;
  } catch (e) {
    return false;
  }
}

/** 自带的最小 HTML 样例（Calibre 能直接转成 EPUB）。 */
function writeSampleHtml(dir) {
  const p = path.join(dir, 'sample.html');
  const html = [
    '<!DOCTYPE html>',
    '<html lang="zh"><head><meta charset="utf-8"><title>转换自检样例</title></head>',
    '<body>',
    '<h1>第一章 起点</h1><p>这是一段用于验证转换链路的正文内容。</p>',
    '<h1>第二章 旅途</h1><p>另一段文字，用来确认章节能被解析层正确切分。</p>',
    '</body></html>'
  ].join('\n');
  fs.writeFileSync(p, html, 'utf8');
  return p;
}

/** 真正的转换执行器：调 ebook-convert（与 src/convert.js 的 run 接口一致）。 */
function makeRun() {
  return function (inputPath, outputPath) {
    execFileSync('ebook-convert', [inputPath, outputPath], { stdio: 'ignore' });
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!hasCalibre()) {
    log('未检测到 Calibre（ebook-convert 不在 PATH）。');
    log('格式转换依赖桌面版 Calibre；本环境下跳过转换链路自检（退出码 0）。');
    log('在已安装 Calibre 的机器上运行 `node tools/convert_check.js` 即可验证。');
    process.exit(0);
  }

  // 仅当具备 Calibre 时才加载本仓库模块，保证无 Calibre 环境下零依赖
  const Convert = require('../src/convert.js');
  const Epub = require('../src/epub.js');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mingscribe-convert-'));
  let inputPath = args.input;
  let cleanupSample = false;
  if (!inputPath) {
    inputPath = writeSampleHtml(tmp);
    cleanupSample = true;
    log('未指定 --input，使用自带最小 HTML 样例：' + inputPath);
  } else if (!fs.existsSync(inputPath)) {
    fail('源文件不存在：' + inputPath);
  }

  if (!Convert.isConvertible(inputPath)) {
    fail('该格式不在可转换列表内：' + path.basename(inputPath) +
      '（仅 mobi/azw3/docx/fb2/html 等可经 Calibre 转换）');
  }

  const outputPath = args.output || path.join(tmp, 'out.epub');
  log('调用 ebook-convert：' + path.basename(inputPath) + ' → ' + path.basename(outputPath));

  try {
    await Convert.convertToEpub({ inputPath, outputPath, run: makeRun() });
  } catch (err) {
    fail('转换失败：' + (err && err.message ? err.message : err));
  }

  if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
    fail('转换后未生成有效的 EPUB 文件');
  }

  const inflate = (u8) => Promise.resolve(new Uint8Array(zlib.inflateRawSync(Buffer.from(u8))));
  let book;
  try {
    const buf = fs.readFileSync(outputPath);
    book = await Epub.parseEpub(buf, { inflate });
  } catch (err) {
    fail('转换产物无法被现有 EPUB 解析层读取：' + (err && err.message ? err.message : err));
  }

  if (!book || !Array.isArray(book.chapters) || book.chapters.length === 0) {
    fail('转换产物被解析但章节数为 0，链路异常');
  }

  log('转换链路验证通过 ✅');
  log('  书名：' + (book.title || '(空)'));
  log('  章节数：' + book.chapters.length);
  log('  首章标题：' + (book.chapters[0] && book.chapters[0].title));
  log('  全文长度：' + (book.totalChars || 0) + ' 字');

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 忽略清理失败 */ }
  process.exit(0);
}

main().catch((err) => fail('未预期错误：' + (err && err.stack ? err.stack : err)));
