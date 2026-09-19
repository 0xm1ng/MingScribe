#!/usr/bin/env node
/**
 * 生成 PDF 阅读视图的配图：
 *   docs/screenshots/09-pdf.png        普通阅读
 *   docs/screenshots/10-pdf-search.png 全文搜索（含命中高亮）
 *   docs/screenshots/11-pdf-annot.png  批注（框选 + 手绘 + 便签）
 *
 * 为什么必须起一个本地 HTTP 服务（而不是像 make_screenshots.js 那样用 file://）：
 * 内置的 pdf.js 是 ES Module，浏览器在 file:// 协议下禁止加载模块（CORS）。
 * 桌面版跑在 http://tauri.localhost，所以这里用临时静态服务模拟同一环境。
 *
 * 示例文档用 buildRichPdf 现拼：只有一行的 PDF 截出来近乎全白，
 * 看不出排版，也演不了「同一页多处命中」。夹具是 ASCII，Helvetica 不含中文字形。
 *
 * 跑法（PowerShell）：node tools/shoot_pdf.js
 */
const fs = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');
const { chromium } = require('C:\\Users\\Admin\\.workbuddy\\binaries\\node\\workspace\\node_modules\\playwright-core');
const { buildRichPdf } = require('../tests/fixtures/make_pdf.js');

const ROOT = path.resolve(__dirname, '..');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const SHOTS = path.join(ROOT, 'docs', 'screenshots');
const TMP_PDF = path.join(os.tmpdir(), 'MingScribe-示例文档.pdf');

const DEMO_PAGES = [
  [
    '# MingScribe',
    'A quiet reader for TXT, EPUB and PDF.',
    'MingScribe keeps every book on this device.',
    'No account, no sync, no telemetry.',
    '# Reading',
    'Scroll mode keeps a whole chapter on one canvas.',
    'Paged mode splits it to fit your window.',
    'Two-page spread turns on when the window is wide.',
    '# Getting around',
    'Press Ctrl+F to search the whole document.',
    'Arrow keys turn the page. Ctrl and +/- zoom.'
  ],
  [
    '# Formats',
    'TXT is read with encoding detection.',
    'EPUB is parsed chapter by chapter.',
    'PDF is rasterised page by page,',
    'with a transparent text layer on top.',
    'MingScribe converts MOBI, AZW3 and DOCX first.',
    '# Highlights',
    'Select any text to keep a highlight.',
    'Every note exports to Markdown in one click.'
  ],
  [
    '# PDF support',
    'Rendering is built in; no external viewer.',
    'Zoom from 50% to 300%, or fit width and page.',
    'Search finds every match and jumps right to it.',
    '# Privacy',
    'Nothing leaves your machine while you read.',
    'MingScribe sends your books nowhere.',
    'The only network call is the update check.'
  ]
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream'
};

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0]);
      const file = path.join(ROOT, rel === '/' ? 'index.html' : rel);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); res.end(''); return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/** 等首屏渲染完、提示条退场 —— 否则截图上会压着一条 toast。 */
async function settle(page) {
  await page.waitForFunction(
    () => !document.getElementById('pdf-screen').hidden &&
      document.getElementById('pdf-hint').hidden,
    null, { timeout: 20000 }
  );
  await page.waitForFunction(() => document.getElementById('toast').hidden, null, { timeout: 8000 })
    .catch(() => {});
  await page.waitForTimeout(250);
}

(async () => {
  fs.writeFileSync(TMP_PDF, buildRichPdf(DEMO_PAGES), 'latin1');

  const { server, port } = await serve();
  const browser = await chromium.launch({ executablePath: EDGE, headless: true });
  const errors = [];
  const shots = [];

  // 第一张：普通阅读
  const wide = await browser.newPage({ viewport: { width: 1360, height: 860 } });
  wide.on('pageerror', (e) => errors.push(e.message));
  await wide.goto('http://127.0.0.1:' + port + '/index.html');
  await wide.setInputFiles('#file-input', TMP_PDF);
  await settle(wide);
  const out1 = path.join(SHOTS, '09-pdf.png');
  await wide.screenshot({ path: out1 });
  shots.push(path.relative(ROOT, out1));

  // 第二张：全文搜索（面板 + 命中底色）。从第 1 页搜，第一处命中就在眼前。
  await wide.keyboard.press('Control+f');
  await wide.fill('#pdf-search-input', 'MingScribe');
  await wide.waitForFunction(
    () => document.querySelectorAll('#pdf-search-results .search-item').length > 0,
    null, { timeout: 20000 }
  );
  await wide.waitForFunction(
    () => document.querySelectorAll('#pdf-text-layer mark').length > 0,
    null, { timeout: 10000 }
  ).catch(() => {});
  await wide.waitForTimeout(400);
  const out2 = path.join(SHOTS, '10-pdf-search.png');
  await wide.screenshot({ path: out2 });
  shots.push(path.relative(ROOT, out2));

  // 第三种：批注。换到第 2 页，和上面两张错开画面。
  await wide.click('#pdf-search-close');
  await wide.waitForSelector('#pdf-search-panel[hidden]', { timeout: 3000 }).catch(() => {});
  await wide.fill('#pdf-page-input', '2');
  await wide.press('#pdf-page-input', 'Enter');
  await wide.waitForTimeout(700);

  // 批注是按「页面上的相对位置」拖出来的，先把整页装进视口 ——
  // 「适应宽度」下页面比窗口高一截，页面的下半部分根本点不到。
  for (let i = 0; i < 3; i++) {
    if ((await wide.$eval('#pdf-fit', (el) => el.textContent)) === '整页') break;
    await wide.click('#pdf-fit');
    await wide.waitForTimeout(450);
  }

  const box = await wide.$eval('#pdf-mark-layer', (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, w: r.width, h: r.height };
  });
  const at = (x, y) => [box.left + box.w * x, box.top + box.h * y];
  const drag = async (x0, y0, x1, y1) => {
    await wide.mouse.move(...at(x0, y0));
    await wide.mouse.down();
    await wide.mouse.move(...at(x1, y1), { steps: 12 });
    await wide.mouse.up();
    await wide.waitForTimeout(180);
  };

  // 框选盖住「Highlights」下面那两句
  await wide.click('#pdf-mark-rect');
  await wide.click('#pdf-mark-colors .mark-color[data-color="yellow"]');
  await drag(0.1, 0.268, 0.72, 0.318);

  // 手绘：给最后一句画条波浪下划线
  await wide.click('#pdf-mark-rect');
  await wide.click('#pdf-mark-ink');
  await wide.click('#pdf-mark-colors .mark-color[data-color="blue"]');
  await wide.mouse.move(...at(0.1, 0.326));
  await wide.mouse.down();
  for (let i = 0; i <= 24; i++) {
    await wide.mouse.move(...at(0.1 + 0.6 * (i / 24), 0.326 + Math.sin(i / 2.4) * 0.005));
  }
  await wide.mouse.up();
  await wide.waitForTimeout(200);

  // 便签
  await wide.click('#pdf-mark-ink');
  await wide.click('#pdf-mark-note');
  await wide.mouse.click(...at(0.16, 0.42));
  await wide.waitForTimeout(300);
  await wide.keyboard.type('这两句是重点，导出的 Markdown 里也带着。');
  await wide.mouse.click(...at(0.86, 0.9));
  await wide.waitForTimeout(300);
  await wide.keyboard.press('Escape');
  await wide.waitForFunction(() => document.getElementById('toast').hidden, null, { timeout: 8000 })
    .catch(() => {});
  await wide.waitForTimeout(250);

  const out3 = path.join(SHOTS, '11-pdf-annot.png');
  await wide.screenshot({ path: out3 });
  shots.push(path.relative(ROOT, out3));

  await browser.close();
  server.close();
  fs.unlinkSync(TMP_PDF);

  shots.forEach((s) => console.log('[shoot_pdf] 已生成 ' + s));
  console.log('[shoot_pdf] 页面错误：' + (errors.length ? errors.join(' | ') : '无'));
})();
