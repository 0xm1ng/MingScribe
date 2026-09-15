/**
 * 「检查更新」端到端自检（不进入 npm test：依赖本机 Edge + playwright-core）。
 *
 * 跑法：
 *   npm install playwright-core --prefix <node 环境目录>
 *   node tools/check_update_e2e.js
 *
 * 为什么需要它：单元测试只能证明 Updater 的纯逻辑对，证明不了
 * 「按钮真的绑上了、脚本真的加载了、真实网络真的通了、提示条真的会弹」。
 * 所以这里起一个本地 http 服务（file:// 下 Chrome 会禁掉 fetch），
 * 用真实 Edge 打开页面点按钮，覆盖两条分支：
 *   A) 真实网络  → 应提示「已经是最新版本（vX.Y.Z）」
 *   B) 把 GitHub API 拦成 v9.9.9 → 应弹出更新条，文案 / 链接 / 忽略功能都正确
 *
 * 坑：Windows 下 path.join 会产出反斜杠，直接用 startsWith(ROOT) 判断会全部 404，
 *     必须用 path.resolve 两边都规范化后再比。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('C:/Users/Admin/.workbuddy/binaries/node/workspace/node_modules/playwright-core');

const ROOT = path.resolve(__dirname, '..');
const PORT = 5199;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8'
};

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
  if (rel === 'favicon.ico') { res.writeHead(204); return res.end(); } // 免得刷一堆 404 干扰判断
  const file = path.resolve(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) {
    res.writeHead(404);
    return res.end('not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});

async function newPage(browser, log) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') log.push('[console.error] ' + m.text()); });
  page.on('pageerror', (e) => log.push('[pageerror] ' + e.message));
  return page;
}

(async () => {
  await new Promise((r) => server.listen(PORT, r));
  const browser = await chromium.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true
  });
  const log = [];

  const p1 = await newPage(browser, log);
  await p1.goto(`http://127.0.0.1:${PORT}/index.html`);
  await p1.waitForTimeout(1500);
  console.log('Updater 模块已挂载 :', await p1.evaluate(() => !!(window.MingScribe && window.MingScribe.Updater)));
  console.log('请求地址          :', await p1.evaluate(() => window.MingScribe.Updater.DEFAULT_API));
  await p1.click('#btn-check-update');
  await p1.waitForSelector('#toast:not([hidden])', { timeout: 15000 });
  console.log('A) 真实网络提示    :', (await p1.textContent('#toast')).trim());
  console.log('A) 更新条保持隐藏  :', await p1.$eval('#update-bar', (el) => el.hidden));

  const p2 = await newPage(browser, log);
  await p2.route('**/api.github.com/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{
        tag_name: 'v9.9.9', name: 'v9.9.9 测试版', draft: false, prerelease: false,
        html_url: 'https://example.com/releases/tag/v9.9.9',
        assets: [{ name: 'MingScribe_9.9.9_x64-setup.exe', size: 1, browser_download_url: 'https://example.com/x.exe' }]
      }])
    })
  );
  await p2.goto(`http://127.0.0.1:${PORT}/index.html`);
  await p2.waitForSelector('#update-bar:not([hidden])', { timeout: 15000 });
  console.log('\nB) 更新条文案      :', (await p2.textContent('#update-text')).trim());
  console.log('B) 去下载链接      :', await p2.$eval('#btn-update-go', (el) => el.getAttribute('href')));
  console.log('B) 书架版本号      :', (await p2.textContent('#shelf-version')).trim());
  await p2.click('#btn-update-skip');
  await p2.waitForTimeout(300);
  console.log('B) 点忽略后隐藏    :', await p2.$eval('#update-bar', (el) => el.hidden));
  await p2.reload();
  await p2.waitForTimeout(2500);
  console.log('B) 重载后仍隐藏    :', await p2.$eval('#update-bar', (el) => el.hidden), '(true = 忽略已记住)');

  const real = log.filter((x) => !/favicon/.test(x));
  console.log('\n页面报错:', real.length ? real : '无');
  await browser.close();
  server.close();
})().catch((e) => { console.error('脚本出错:', e.message); server.close(); process.exit(1); });
