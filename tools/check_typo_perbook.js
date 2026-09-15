/**
 * 「按书记忆排版」端到端自检（不进入 npm test：依赖本机 Edge + playwright-core）。
 *
 * 跑法：
 *   node tools/check_typo_perbook.js
 *
 * 为什么需要它：单元测试只能证明 ReadingPrefs 的纯逻辑对，证明不了
 * 「打开书时会真的套用本书排版」「工具栏按钮会真的按本书存」
 * 「复位按钮能把它退回全局」。这些都要真点一遍才算数。
 *
 * 验证的是这条链路：A 书调字号 → 切到 B 书（跟随全局）→ B 书调字号
 * → 切回 A 书**必须还是 A 自己的字号**（这是以前会串味的地方）→ 复位 A → A 回到全局。
 *
 * 坑（与 check_update_e2e.js 同源）：
 *   - Windows 下 path.join 产出反斜杠，判断前缀前两边都要过 path.resolve，否则全 404。
 *   - 必须起 http 服务，file:// 下 Chrome 会禁掉一堆 API。
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('C:/Users/Admin/.workbuddy/binaries/node/workspace/node_modules/playwright-core');

const ROOT = path.resolve(__dirname, '..');
const PORT = 5201;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8'
};

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
  if (rel === 'favicon.ico') { res.writeHead(204); return res.end(); }
  const file = path.resolve(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) {
    res.writeHead(404);
    return res.end('not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});

/** 正文够长一点，免得被当成空书。 */
function makeBook(file, title) {
  let body = title + '\n\n';
  for (let i = 1; i <= 20; i++) body += '第' + i + '段：这是一段用于排版自检的示例文字，长度足够撑起一页。\n\n';
  fs.writeFileSync(file, body, 'utf8');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fontOf(page) {
  return (await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--reader-font-size').trim()
  ));
}

async function openByTitle(page, title) {
  const idx = await page.$$eval('#shelf-list .shelf-item', (els, t) =>
    els.findIndex((e) => e.textContent.includes(t)), title);
  if (idx < 0) throw new Error('书架上找不到《' + title + '》');
  await page.click(`#shelf-list .shelf-item:nth-child(${idx + 1}) button[data-action="open"]`);
  await page.waitForSelector('#reader-screen:not([hidden])');
  await sleep(400);
}

async function backToShelf(page) {
  await page.click('#btn-back');
  await page.waitForSelector('#shelf-list .shelf-item');
  await sleep(300);
}

async function toastText(page) {
  return (await page.textContent('#toast').catch(() => '')) || '';
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-typo-'));
  const fileA = path.join(tmp, '排版自检甲书.txt');
  const fileB = path.join(tmp, '排版自检乙书.txt');
  makeBook(fileA, '甲书');
  makeBook(fileB, '乙书');

  await new Promise((r) => server.listen(PORT, r));
  const browser = await chromium.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true
  });
  const errors = [];
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[console.error] ' + m.text()); });
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));

  await page.goto(`http://127.0.0.1:${PORT}/index.html`);
  await sleep(800);

  // 导入两本书（导入后会自动打开，所以每次都要先回书架）
  await page.setInputFiles('#file-input', fileA);
  await page.waitForSelector('#reader-screen:not([hidden])', { timeout: 20000 });
  await backToShelf(page);
  await page.setInputFiles('#file-input', fileB);
  await page.waitForSelector('#reader-screen:not([hidden])', { timeout: 20000 });
  await backToShelf(page);

  const results = [];
  const check = (name, actual, expected) => {
    const ok = String(actual) === String(expected);
    results.push({ ok, name, actual, expected });
    console.log((ok ? '  ✅ ' : '  ❌ ') + name + ' → 实际 ' + actual + '（期望 ' + expected + '）');
  };
  const px = (v) => parseFloat(v) || 0;

  // 断言一律写「不变量」，不写死具体档位：
  // FONT_STEPS 不是 1px 递增（19 → 22 → …），写死数字只会让测试跟着档位表一起改。
  const base = await fontOf(page);
  console.log('初始（默认字号）');
  check('默认字号非空', px(base) > 0, 'true');

  console.log('\n① 在《甲书》里放大两档字号');
  await openByTitle(page, '甲书');
  await page.click('#btn-font-up');
  await sleep(250);
  await page.click('#btn-font-up');
  await sleep(250);
  const fontA = await fontOf(page);
  check('甲书字号变大', px(fontA) > px(base), 'true');
  const toastA = await toastText(page);
  check('提示语带「仅本书」', /仅本书/.test(toastA), 'true');

  console.log('\n② 切到《乙书》：没单独调过，应跟随全局（= 甲书刚同步过去的值）');
  await backToShelf(page);
  await openByTitle(page, '乙书');
  check('乙书字号 = 甲书字号', await fontOf(page), fontA);

  console.log('\n③ 在《乙书》里连缩四档');
  for (let i = 0; i < 4; i++) { await page.click('#btn-font-down'); await sleep(200); }
  const fontB = await fontOf(page);
  check('乙书字号变小', px(fontB) < px(fontA), 'true');

  console.log('\n④ 切回《甲书》：必须是自己的 21px，不能被乙书覆盖（本修复的核心）');
  await backToShelf(page);
  await openByTitle(page, '甲书');
  check('甲书字号仍是', await fontOf(page), fontA);

  console.log('\n⑤ 点「复位」：甲书回到全局值');
  await page.click('#btn-typo-reset');
  await sleep(400);
  check('甲书复位后字号', await fontOf(page), fontB);
  check('复位提示语', /已恢复默认排版/.test(await toastText(page)), 'true');

  console.log('\n⑥ 已复位后再点一次，应提示「已经是默认排版」而不是报错');
  await page.click('#btn-typo-reset');
  await sleep(400);
  check('二次复位提示语', /已经是默认排版/.test(await toastText(page)), 'true');

  console.log('\n⑦ 《乙书》不受影响');
  await backToShelf(page);
  await openByTitle(page, '乙书');
  check('乙书字号', await fontOf(page), fontB);

  const failed = results.filter((r) => !r.ok);
  console.log('\n================ 结果 ================');
  console.log(failed.length === 0
    ? `全部通过（${results.length} 项）`
    : `失败 ${failed.length} / ${results.length} 项：` + failed.map((f) => f.name).join('、'));
  console.log('页面报错:', errors.length ? errors : '无');

  await browser.close();
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failed.length === 0 && errors.length === 0 ? 0 : 1);
})().catch((e) => { console.error('脚本出错:', e.message); server.close(); process.exit(1); });
