/**
 * 书架新界面截图自检（开发用，不进 npm test）。
 * 用真实 Edge 打开页面，导入两本示例书，分别截取：空态 / 卡片网格 / 菜单 / 关于 / 帮助 / 深色，
 * 并报告页面报错数量。产物落到 tools/_shots/。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { chromium } = require('C:/Users/Admin/.workbuddy/binaries/node/workspace/node_modules/playwright-core');

const ROOT = path.resolve(__dirname, '..');
const PORT = 5211;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
  if (rel === 'favicon.ico') { res.writeHead(204); return res.end(); }
  const file = path.resolve(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); return res.end('x'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});

function makeSample(name, text) {
  const p = path.join(os.tmpdir(), name);
  fs.writeFileSync(p, text, 'utf8');
  return p;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await new Promise((r) => server.listen(PORT, r));
  const dir = path.join(__dirname, '_shots');
  fs.mkdirSync(dir, { recursive: true });

  const f1 = makeSample('甲书_三体.txt', '第一章 科学边界\n汪淼觉得今天的会议很古怪。\n\n第二章 台球\n加速器项目的失败让整个物理学界陷入沉默。\n\n第三章 幽灵\n倒计时数字在视网膜上跳动。');
  const f2 = makeSample('乙书_活着.txt', '第一章 我比现在年轻十岁的时候\n我爷爷是地主。\n\n第二章 家珍\n她穿着月白色的旗袍走来。\n\n第三章 凤霞\n女儿的笑像春天的风。');

  const browser = await chromium.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('[console] ' + m.text()); });

  await page.goto(`http://127.0.0.1:${PORT}/index.html`);
  await sleep(800);
  await page.screenshot({ path: path.join(dir, '1-empty.png') });

  // 导入两本书（单文件输入，逐个导入；导入会自动打开，需退回书架再导下一本）
  await page.setInputFiles('#file-input', f1);
  await sleep(900);
  await page.click('#btn-back');
  await sleep(600);
  await page.setInputFiles('#file-input', f2);
  await sleep(900);
  await page.click('#btn-back');
  await sleep(600);
  await page.screenshot({ path: path.join(dir, '2-grid.png') });

  // 菜单
  await page.click('#btn-menu');
  await sleep(350);
  await page.screenshot({ path: path.join(dir, '3-menu.png') });
  await page.click('.menu-wrap'); // 关菜单（点 wrap 内，不会关；改点别处）
  await page.mouse.click(640, 700);
  await sleep(200);

  // 关于
  await page.click('#btn-menu');
  await sleep(250);
  await page.click('.menu-item[data-action="about"]');
  await sleep(350);
  await page.screenshot({ path: path.join(dir, '4-about.png') });
  await page.click('#about-modal .modal-close');
  await sleep(200);

  // 帮助
  await page.click('#btn-menu');
  await sleep(250);
  await page.click('.menu-item[data-action="help"]');
  await sleep(350);
  await page.screenshot({ path: path.join(dir, '5-help.png') });
  await page.click('#help-modal .modal-close');
  await sleep(200);

  // 深色模式
  await page.click('#btn-theme-2');
  await sleep(400);
  await page.screenshot({ path: path.join(dir, '6-dark.png') });

  // 切回日间，进阅读器拍顶栏 + 「Aa」排版面板
  await page.click('#btn-theme-2');
  await sleep(300);
  await page.evaluate(() => {
    var btn = document.querySelector('#shelf-grid .book-card button[data-action="open"]');
    if (btn) btn.click();
  });
  await page.waitForSelector('#reader-screen:not([hidden])');
  await sleep(700);
  await page.click('#btn-typo');
  await sleep(350);
  await page.screenshot({ path: path.join(dir, '7-typo.png') });

  console.log('页面报错:', errs.length ? errs : '无');
  console.log('截图已存:', dir);
  await browser.close();
  server.close();
})().catch((e) => { console.error('出错:', e.message); server.close(); process.exit(1); });
