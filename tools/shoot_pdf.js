#!/usr/bin/env node
/**
 * 生成 PDF 阅读视图的配图（docs/screenshots/09-pdf.png）。
 *
 * 为什么必须起一个本地 HTTP 服务（而不是像 make_screenshots.js 那样用 file://）：
 * 内置的 pdf.js 是 ES Module，浏览器在 file:// 协议下禁止加载模块（CORS）。
 * 桌面版跑在 http://tauri.localhost，所以这里用临时静态服务模拟同一环境。
 *
 * 跑法（PowerShell）：node tools/shoot_pdf.js
 */
const fs = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');
const { chromium } = require('C:\\Users\\Admin\\.workbuddy\\binaries\\node\\workspace\\node_modules\\playwright-core');
const { buildPdf } = require('../tests/fixtures/make_pdf.js');

const ROOT = path.resolve(__dirname, '..');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT = path.join(ROOT, 'docs', 'screenshots', '09-pdf.png');
const TMP_PDF = path.join(os.tmpdir(), 'MingScribe-示例文档.pdf');

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

(async () => {
  fs.writeFileSync(TMP_PDF, buildPdf(3), 'latin1');

  const { server, port } = await serve();
  const browser = await chromium.launch({ executablePath: EDGE, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('http://127.0.0.1:' + port + '/index.html');
  await page.setInputFiles('#file-input', TMP_PDF);
  await page.waitForFunction(
    () => !document.getElementById('pdf-screen').hidden &&
      document.getElementById('pdf-hint').hidden,
    null, { timeout: 20000 }
  );
  // 等提示条自己退场，否则会盖在版面上
  await page.waitForFunction(() => document.getElementById('toast').hidden, null, { timeout: 8000 })
    .catch(() => {});
  await page.screenshot({ path: OUT });

  await browser.close();
  server.close();
  fs.unlinkSync(TMP_PDF);

  console.log('[shoot_pdf] 已生成 ' + path.relative(ROOT, OUT));
  console.log('[shoot_pdf] 页面错误：' + (errors.length ? errors.join(' | ') : '无'));
})();
