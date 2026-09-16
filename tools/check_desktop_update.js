/**
 * 在**打包好的桌面版**里实测「检查更新」与 open_url（不进入 npm test）。
 *
 * 跑法：先 `npm run tauri:build`，然后
 *   node tools/check_desktop_update.js
 *
 * 为什么要单独一个脚本：网页版的源是 http://127.0.0.1，桌面版的源是
 * http://tauri.localhost —— 跨域、CSP、window.open 的行为都不一样，
 * 网页版测过不代表桌面版能用。这里给 WebView2 传 --remote-debugging-port
 * 把打包好的 exe 拉起来，再用 CDP 连进去点按钮，等于真机验收。
 *
 * 注意：最后一步会真的调用 open_url 打开 https://example.com，
 * 所以跑完请手动关掉弹出的那个标签页。
 *
 * 排错：若只列得出 about:blank、找不到 tauri.localhost 页面，多半是本机 WebView2 用户数据
 * 目录坏了（反复 `taskkill /F` 容易触发，表现为「进程活着但不出窗口」）。此时**重命名**
 * `%LOCALAPPDATA%\com.mingscribe.reader\EBWebView` 让它重建即可——别删，里面存着本地书架数据。
 */
const { spawn } = require('child_process');
const path = require('path');
const { chromium } = require('C:/Users/Admin/.workbuddy/binaries/node/workspace/node_modules/playwright-core');

const EXE = path.resolve(__dirname, '../src-tauri/target/release/mingscribe.exe');
const PORT = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!require('fs').existsSync(EXE)) {
    console.error('找不到打包产物，先跑一次：node node_modules/@tauri-apps/cli/tauri.js build');
    process.exit(1);
  }

  const child = spawn(EXE, [], {
    env: Object.assign({}, process.env, {
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + PORT
    }),
    stdio: 'ignore'
  });
  console.log('已启动 pid =', child.pid);

  let up = false;
  for (let i = 0; i < 20 && !up; i++) {
    await sleep(1000);
    try { await fetch(`http://127.0.0.1:${PORT}/json/version`); up = true; } catch (e) { /* 还没起来 */ }
  }
  if (!up) { console.error('调试端口没开起来（可能已有一个实例在跑）'); child.kill(); process.exit(1); }

  const ctx = browser.contexts()[0];
  // 注意：ctx.pages()[0] 不保证就是应用页面，很可能是个 about:blank，
  // 必须按 url 挑并在一定时间内轮询等待（webview 起得比进程慢）。
  let page = null;
  for (let i = 0; i < 20 && !page; i++) {
    page = ctx.pages().find((p) => p.url().includes('tauri.localhost')) || null;
    if (!page) await sleep(1000);
  }
  if (!page) {
    console.error('没找到应用页面（桌面版窗口没起来？可能是 WebView2 数据目录残留，见下方说明）');
    child.kill();
    await browser.close();
    process.exit(1);
  }
  await sleep(2000); // 等前端 DOM 渲染完
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));

  console.log('页面源            :', page.url());
  console.log('Updater 模块      :', await page.evaluate(() => !!(window.MingScribe && window.MingScribe.Updater)));
  console.log('isTauri           :', await page.evaluate(() => window.MingScribe.TauriBridge.isTauri()));
  console.log('invoke 可用       :', await page.evaluate(() => typeof (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke)));
  console.log('书架版本号        :', (await page.textContent('#about-version').catch(() => '(取不到)')).trim());

  // 「检查更新」现在在应用栏菜单里
  await page.click('#btn-menu');
  await sleep(200);
  await page.click('#app-menu [data-action="check"]');
  await page.waitForSelector('#toast:not([hidden])', { timeout: 20000 });
  console.log('点击后提示        :', (await page.textContent('#toast')).trim());

  // 安全护栏：非 http/https 必须被拒绝（无副作用）
  const bad = await page.evaluate(() =>
    window.__TAURI__.core.invoke('open_url', { url: 'file:///C:/Windows/System32/calc.exe' })
      .then(() => '居然成功了（危险！）')
      .catch((e) => '已拒绝：' + e)
  );
  console.log('open_url 安全护栏 :', bad);

  // 正常 https：会真的打开一个 example.com 标签页
  const good = await page.evaluate(() =>
    window.MingScribe.TauriBridge.openExternal('https://example.com/')
      .then((r) => 'openExternal 返回 ' + r)
      .catch((e) => '失败：' + e)
  );
  console.log('open_url 正常打开 :', good);

  console.log('页面报错          :', errs.length ? errs : '无');
  await browser.close();
  child.kill();
  console.log('已关闭桌面版（记得手动关掉 example.com 标签页）');
})().catch((e) => {
  console.error('脚本出错:', e.message);
  try { require('child_process').execSync('taskkill /F /IM mingscribe.exe /T'); } catch (_) {}
  process.exit(1);
});
