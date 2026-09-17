/**
 * PDF 阅读视图的端到端自检（一次性验证脚本，不进入常规测试套件）。
 *
 * 为什么必须起一个本地 HTTP 服务（而不是像 e2e_smoke.js 那样用 file://）：
 * 内置的 pdf.js 是 ES Module，浏览器在 file:// 协议下禁止加载模块（CORS）。
 * 桌面版跑在 http://tauri.localhost，所以这里用临时静态服务模拟同一环境。
 *
 * 覆盖：导入 → 首页渲染 → 翻页（按钮 / 键盘）→ 缩放 → 跳页 → 返回书架
 *      → 进度写入书架 → 二次打开要求重选文件 → 重开后恢复到上次页码。
 *
 * 跑法（PowerShell）：node tools/e2e_pdf.js
 */
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { chromium } = require('C:\\Users\\Admin\\.workbuddy\\binaries\\node\\workspace\\node_modules\\playwright-core');
const { buildPdf } = require('../tests/fixtures/make_pdf.js');

const ROOT = path.resolve(__dirname, '..');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const REPORT = path.join(__dirname, '_e2e_pdf_report.txt');
const TMP_PDF = path.join(os.tmpdir(), 'MingScribe-e2e-sample.pdf');
const PAGE_COUNT = 3;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream'
};

/** worker 里发出的请求不会上报到 page 事件，只能在服务端记 404。 */
const missing = [];

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0]);
      const file = path.join(ROOT, rel === '/' ? 'index.html' : rel);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        missing.push(rel);
        res.writeHead(404); res.end('');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const lines = [];
const log = (t) => lines.push(t);
let failures = 0;
function check(name, ok, extra) {
  log((ok ? '  OK   ' : '  FAIL ') + name + (extra ? '  → ' + extra : ''));
  if (!ok) failures++;
}

(async () => {
  fs.writeFileSync(TMP_PDF, buildPdf(PAGE_COUNT), 'latin1');

  const { server, port } = await serve();
  const url = 'http://127.0.0.1:' + port + '/index.html';
  log('PDF 端到端自检 @ ' + url);

  const browser = await chromium.launch({ executablePath: EDGE, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });

  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    // 「Failed to load resource」不带 URL（无法在这里判断是不是 favicon），
    // 资源缺失统一由服务端 404 记录来判定 —— 那一侧才拿得到路径。
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) {
      errors.push('console: ' + m.text());
    }
  });

  await page.goto(url);
  await page.waitForTimeout(400);

  log('');
  log('1. 导入 PDF');
  await page.setInputFiles('#file-input', TMP_PDF);
  await page.waitForSelector('#pdf-screen:not([hidden])', { timeout: 20000 }).catch(() => {});
  const opened = await page.$eval('#pdf-screen', (el) => !el.hidden);
  check('PDF 视图打开', opened);
  if (!opened) {
    const hint = await page.$eval('#pdf-hint', (el) => el.textContent).catch(() => '');
    const toastTxt = await page.$eval('#toast', (el) => el.textContent).catch(() => '');
    log('  hint=' + hint + ' | toast=' + toastTxt);
  }

  // hint 隐藏 = 首屏渲染回调跑完了
  await page.waitForFunction(() => document.getElementById('pdf-hint').hidden, null, { timeout: 20000 })
    .catch(() => {});

  const s1 = await page.evaluate(() => {
    const c = document.getElementById('pdf-canvas');
    return {
      w: c.width, h: c.height, cssW: c.style.width, cssH: c.style.height,
      label: document.getElementById('pdf-page-label').textContent,
      zoom: document.getElementById('pdf-zoom-val').textContent,
      fit: document.getElementById('pdf-fit').textContent,
      status: document.getElementById('pdf-status').textContent,
      pct: document.getElementById('pdf-pct').textContent,
      prevDisabled: document.getElementById('pdf-prev').disabled,
      nextDisabled: document.getElementById('pdf-next').disabled
    };
  });
  log('  首屏状态: ' + JSON.stringify(s1));
  check('画布已画出位图', s1.w > 0 && s1.h > 0, s1.cssW + ' × ' + s1.cssH);
  check('页码指示正确（' + PAGE_COUNT + ' 页）', s1.label === '1 / ' + PAGE_COUNT, s1.label);
  check('默认整页显示', s1.fit === '整页', s1.fit);
  check('首页时「上一页」禁用', s1.prevDisabled === true);
  check('首页时「下一页」可用', s1.nextDisabled === false);
  check('进度显示已读页数占比', s1.pct === Math.round(100 / PAGE_COUNT) + '%', s1.pct);

  // 整页取样：文字位置随缩放比变化，只扫顶部会漏掉
  const painted = await page.evaluate(() => {
    const c = document.getElementById('pdf-canvas');
    const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] < 200 || data[i + 1] < 200 || data[i + 2] < 200) dark++;
    }
    return dark;
  });
  check('页面有实际内容（非空白画布）', painted > 50, '深色像素 ' + painted);

  log('');
  log('2. 翻页');
  await page.click('#pdf-next');
  await page.waitForTimeout(600);
  const s2 = await page.evaluate(() => ({
    label: document.getElementById('pdf-page-label').textContent,
    input: document.getElementById('pdf-page-input').value,
    range: document.getElementById('pdf-range').value
  }));
  check('点「下一页」到第 2 页', s2.label === '2 / 3', s2.label);
  check('页码输入框同步', s2.input === '2', s2.input);
  check('底部滑块同步', s2.range === '2', s2.range);

  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(600);
  const s3 = await page.evaluate(() => ({
    label: document.getElementById('pdf-page-label').textContent,
    nextDisabled: document.getElementById('pdf-next').disabled
  }));
  check('方向键 → 翻到第 3 页', s3.label === '3 / 3', s3.label);
  check('末页时「下一页」禁用', s3.nextDisabled === true);

  log('');
  log('3. 缩放');
  const z0 = await page.$eval('#pdf-zoom-val', (el) => el.textContent);
  await page.click('#pdf-zoom-in');
  await page.waitForTimeout(500);
  const z1 = await page.evaluate(() => ({
    zoom: document.getElementById('pdf-zoom-val').textContent,
    fit: document.getElementById('pdf-fit').textContent
  }));
  check('放大后档位变化', z1.zoom !== z0, z0 + ' → ' + z1.zoom);
  check('手动缩放后模式变「自定义」', z1.fit === '自定义', z1.fit);

  await page.click('#pdf-fit');
  await page.waitForTimeout(500);
  const z2 = await page.$eval('#pdf-fit', (el) => el.textContent);
  check('「适应宽度 / 整页」可来回切', z2 === '整页' || z2 === '适应宽度', z2);

  log('');
  log('4. 跳页');
  await page.fill('#pdf-page-input', '2');
  await page.press('#pdf-page-input', 'Enter');
  await page.waitForTimeout(600);
  const s4 = await page.$eval('#pdf-page-label', (el) => el.textContent);
  check('输入页码回车跳转', s4 === '2 / 3', s4);

  log('');
  log('5. 返回书架 + 进度恢复');
  await page.click('#pdf-back');
  await page.waitForTimeout(400);
  const shelf = await page.evaluate(() => ({
    pdfHidden: document.getElementById('pdf-screen').hidden,
    shelfShown: !document.getElementById('shelf-screen').hidden,
    cards: document.querySelectorAll('#shelf-grid .book-card').length,
    ext: (document.querySelector('#shelf-grid .cover-ext') || {}).textContent || '',
    meta: (document.querySelector('#shelf-grid .bm-chapter') || {}).textContent || ''
  }));
  log('  书架状态: ' + JSON.stringify(shelf));
  check('回到书架，PDF 视图收起', shelf.pdfHidden && shelf.shelfShown);
  check('书架上出现这本 PDF', shelf.cards >= 1);
  check('封面标出 PDF 格式', shelf.ext === 'PDF', shelf.ext);
  check('卡片显示「第 2 页」', /第 2 页/.test(shelf.meta), shelf.meta);

  await page.evaluate(() => {
    const btn = document.querySelector('#shelf-grid button[data-action="open"]');
    if (btn) btn.click();
  });
  await page.waitForTimeout(400);
  const askToast = await page.$eval('#toast', (el) => el.textContent).catch(() => '');
  check('PDF 不缓存正文，二次打开会请用户重新选文件', /请选择/.test(askToast), askToast);

  await page.setInputFiles('#file-input', TMP_PDF);
  await page.waitForFunction(
    () => !document.getElementById('pdf-screen').hidden && document.getElementById('pdf-hint').hidden,
    null, { timeout: 20000 }
  ).catch(() => {});
  const s5 = await page.$eval('#pdf-page-label', (el) => el.textContent);
  check('重新打开后恢复到上次读的第 2 页', s5 === '2 / 3', s5);

  log('');
  log('页面错误：' + (errors.length ? '\n  ' + errors.join('\n  ') : '无'));
  check('无页面错误', errors.length === 0);

  const realMissing = missing.filter((p) => !/favicon/.test(p));
  log('服务端 404（已排除 favicon）：' + (realMissing.length ? '\n  ' + realMissing.join('\n  ') : '无'));
  check('没有缺失的资源', realMissing.length === 0, realMissing.join(', '));

  await browser.close();
  server.close();
  try { fs.unlinkSync(TMP_PDF); } catch (err) { /* 临时文件删不掉不影响结论 */ }

  log('');
  log(failures === 0 ? '全部通过' : failures + ' 项失败');
  fs.writeFileSync(REPORT, lines.join('\n'), 'utf8');
  console.log(lines.join('\n'));
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  fs.writeFileSync(REPORT, lines.join('\n') + '\n脚本异常: ' + err.stack, 'utf8');
  console.error(err);
  process.exit(1);
});
