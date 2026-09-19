/**
 * 在**真实的桌面壳**（WebView2）里验一遍 PDF 批注。
 *
 * 为什么非要在真应用里再验一次：源码 / 本地 HTTP 服务跑通 ≠ 打包版跑通。
 * 批注这层压在几个 WebView2 特有的点上 —— 模块能否加载、SVG 上的指针事件、
 * pointer-events 的成对切换。浏览器（独立 Edge 进程）过了不代表壳里也过。
 *
 * 前置（两步都不能少，否则脚本会以各种莫名的方式卡住）：
 *   1. 临时给 tauri.conf.json 的 app.windows[0] 加
 *      additionalBrowserArgs: "--disable-features=... --remote-debugging-port=9333
 *        --disable-backgrounding-occluded-windows --disable-renderer-backgrounding"
 *      最后两个是必须的：壳的窗口在自动化环境里是「被遮挡」的，
 *      Chromium 会把它冻住 —— 表现是 CDP 的 evaluate 第一次能通、之后全部超时。
 *   2. `tauri build --no-bundle`；跑完**立刻还原配置**（git diff 应为空）。
 *
 * 三个已经踩过的坑，都在下面的代码里绕开了：
 *   - page 句柄必须在「页面完成启动导航之前」拿到。等导航完了再 ctx.pages() 拿到的
 *     那个对象是半初始化的，之后每次 evaluate 都永远不返回。
 *   - `taskkill /F /IM mingscribe.exe` 杀不掉它的 WebView2 宿主进程：宿主会继续占着
 *     9333 应答 CDP，新实例绑不上端口，脚本却连到了僵尸上。所以先探端口。
 *   - ctx.newCDPSession 在壳里也会卡住：优先用 Playwright 的 setInputFiles。
 *
 * ⚠️ 跑之前先确认这台机器能跑：如果**已安装的正式版**打开后也是一片空白窗口，
 * 说明当前会话的 WebView2 渲染进程已经卡死（沙箱里长时间反复强杀会出现这种情况），
 * 这时候本脚本一定会失败在「evaluate 超时」上，而且**与代码无关**——
 * 用正式版做一次对照就能分辨出来。真遇到就别在这儿耗，重启会话或换机器再跑。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');
const { chromium } = require('C:\\Users\\Admin\\.workbuddy\\binaries\\node\\workspace\\node_modules\\playwright-core');
const { buildRichPdf } = require('../tests/fixtures/make_pdf.js');

const ROOT = path.resolve(__dirname, '..');
const EXE = path.join(ROOT, 'src-tauri', 'target', 'release', 'mingscribe.exe');
const PDF = path.join(os.tmpdir(), 'MingScribe-realapp-annot.pdf');
const REPORT = path.join(__dirname, '_e2e_realapp_report.txt');

const PAGE = [
  ['# Reading Notes', '', 'Mark the sentence you would quote in an argument.', 'If you cannot say why it is marked, unmark it.', 'A page you never marked is a page you never read.'],
  ['# Closing the Loop', '', 'Every annotation should end in a sentence of your own.']
];

const lines = [];
let failures = 0;
const log = (t) => lines.push(t);
function check(name, ok, extra) {
  lines.push((ok ? '  OK   ' : '  FAIL ') + name + (extra ? '  → ' + extra : ''));
  if (!ok) failures++;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NEVER = Symbol('timeout');

/** 给任意 Playwright 调用套超时：壳里某些调用会永远不返回，不能死等。 */
function T(promise, ms, label) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).then((v) => ({ v })).catch((e) => ({ e })),
    new Promise((r) => { timer = setTimeout(() => r({ t: true }), ms); })
  ]).then((r) => {
    clearTimeout(timer);
    if (r.t) log('  · ' + label + ' 超时(' + ms + 'ms)');
    return r;
  });
}

// 看门狗：超过 4 分钟没跑完就退出，别把整轮拖死
const WD = setTimeout(() => {
  lines.push('!! 看门狗：超过 240 秒没跑完，强制退出');
  try { execSync('taskkill /F /IM mingscribe.exe', { stdio: 'ignore' }); } catch (e) {}
  try { fs.writeFileSync(REPORT, lines.join('\n'), 'utf8'); } catch (e) {}
  process.exit(3);
}, 240000);
if (WD.unref) WD.unref();

/** 带超时的端口探测：不加超时，遇到僵尸监听会永远挂着。 */
async function probe(port, ms) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try { const r = await fetch('http://127.0.0.1:' + port + '/json/version', { signal: ac.signal }); return r.ok; }
  catch (e) { return false; } finally { clearTimeout(timer); }
}

/**
 * 等某个状态出现，而不是睡固定毫秒 —— 壳里的输入事件是被下一次派发
 * 顺带冲刷出来的，固定等待会读到「事件还没送到」的中间态。
 */
async function waitState(page, fn, timeout) {
  await T(page.waitForFunction(fn, null, { timeout: timeout || 6000 }), (timeout || 6000) + 2000, 'waitState');
  const r = await T(page.evaluate(() => JSON.parse(localStorage.getItem('mingscribe.pdfmarks.v1') || '[]')), 6000, 'readMarks');
  return r.e ? [] : r.v;
}
const countOf = (marks, kind) => marks.filter((m) => m.kind === kind).length;

(async () => {
  fs.writeFileSync(PDF, buildRichPdf(PAGE), 'latin1');

  try { execSync('taskkill /F /IM mingscribe.exe', { stdio: 'ignore' }); } catch (e) { /* 没在跑 */ }
  await sleep(1500);

  if (await probe(9333, 2000)) {
    log('!! 9333 被僵尸 WebView2 宿主占着，先清干净再跑（否则会连到上一个实例上）');
    fs.writeFileSync(REPORT, lines.join('\n'), 'utf8');
    process.exit(2);
  }

  const child = spawn(EXE, [], { detached: true, stdio: 'ignore' });
  child.unref();

  let up = false;
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline && !(up = await probe(9333, 3000))) await sleep(500);
  check('打包版启动并开出调试端口', up);
  if (!up) throw new Error('CDP 没起来，无法继续');

  const cbr = await T(chromium.connectOverCDP('http://127.0.0.1:9333'), 30000, 'connectOverCDP');
  if (!cbr.v) throw new Error('连不上桌面版');
  const ctx = cbr.v.contexts()[0];

  // 关键：在启动导航之前拿 page 句柄（见文件头说明）
  const page = ctx.pages()[0];
  check('连到桌面版页面', !!page, page && page.url());

  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  let ready = false;
  for (let i = 0; i < 24 && !ready; i++) {
    const r = await T(page.evaluate(() => !!(window.MingScribe && window.MingScribe.PdfAnnot)), 4000, 'evaluate#ready' + i);
    if (r.v === true) ready = true;
    if (!ready) await sleep(600);
  }
  check('打包产物里带着批注模块（PdfAnnot）', ready);
  if (!ready) throw new Error('前端没起来（多半是被壳冻住了，检查附加的浏览器参数）');

  await T(page.evaluate(() => { try { localStorage.removeItem('mingscribe.pdfmarks.v1'); } catch (e) {} }), 8000, '清旧批注');

  // 塞文件：优先 Playwright 的 setInputFiles，失败再退回 CDP
  const sf = await T(page.setInputFiles('#file-input', PDF, { timeout: 8000 }), 12000, 'setInputFiles');
  if (sf.e || sf.t) {
    log('  setInputFiles 不可用，改走 CDP');
    const cdp = await T(ctx.newCDPSession(page), 15000, 'newCDPSession');
    if (cdp.v && typeof cdp.v.send === 'function') {
      const doc = await T(cdp.v.send('DOM.getDocument'), 15000, 'getDocument');
      const node = await T(cdp.v.send('DOM.querySelector', { nodeId: doc.v.root.nodeId, selector: '#file-input' }), 15000, 'querySelector');
      await T(cdp.v.send('DOM.setFileInputFiles', { files: [PDF], nodeId: node.v.nodeId }), 20000, 'setFileInputFiles');
    }
  }

  let opened = false;
  for (let i = 0; i < 24 && !opened; i++) {
    const r = await T(page.evaluate(() =>
      !document.getElementById('pdf-screen').hidden && document.getElementById('pdf-hint').hidden), 4000, 'evaluate#open' + i);
    if (r.v === true) opened = true;
    if (!opened) await sleep(700);
  }
  check('桌面版打开 PDF', opened);
  if (!opened) throw new Error('PDF 没打开');

  const geom = await page.$eval('#pdf-mark-layer', (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, w: r.width, h: r.height, pe: getComputedStyle(el).pointerEvents };
  });
  log('  批注层（真壳）: ' + JSON.stringify(geom));
  check('批注层有实际尺寸（没被壳里的布局压成 0）', geom.w > 40 && geom.h > 40, geom.w + '×' + geom.h);
  check('未选工具时批注层不吃鼠标', geom.pe === 'none', geom.pe);

  // 壳里窗口比浏览器窄（1100×800），先切「整页」，否则下半页的坐标落在视口外
  for (let i = 0; i < 3; i++) {
    if ((await page.$eval('#pdf-fit', (el) => el.textContent)) === '整页') break;
    await page.click('#pdf-fit');
    await sleep(450);
  }
  const box = await page.$eval('#pdf-mark-layer', (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, w: r.width, h: r.height };
  });
  const at = (x, y) => [box.left + box.w * x, box.top + box.h * y];

  await page.click('#pdf-mark-rect');
  await sleep(250);
  const on = await page.evaluate(() => ({
    attr: document.getElementById('pdf-page-wrap').getAttribute('data-mark-tool'),
    layerPe: getComputedStyle(document.getElementById('pdf-mark-layer')).pointerEvents,
    textPe: getComputedStyle(document.getElementById('pdf-text-layer')).pointerEvents,
    tipHidden: document.getElementById('pdf-mark-tip').hidden
  }));
  check('真壳里工具切换生效（批注层/文字层成对切换）',
    on.attr === 'rect' && on.layerPe === 'auto' && on.textPe === 'none', JSON.stringify(on));
  check('提示条在真壳里也显示', on.tipHidden === false);

  // 拖动分小步走：一步跨过去会被壳合并成「按下即松开」
  const drag = async (x0, y0, x1, y1) => {
    await page.mouse.move(...at(x0, y0));
    await sleep(90);
    await page.mouse.down();
    await sleep(90);
    for (let i = 1; i <= 10; i++) {
      const t = i / 10;
      await page.mouse.move(...at(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t));
      await sleep(25);
    }
    await page.mouse.up();
  };

  await drag(0.12, 0.3, 0.7, 0.34);
  let marks = await waitState(page, () =>
    JSON.parse(localStorage.getItem('mingscribe.pdfmarks.v1') || '[]').filter((m) => m.kind === 'rect').length >= 1);
  check('真壳里框选能画出来并落盘', countOf(marks, 'rect') >= 1, JSON.stringify(marks.map((m) => m.kind)));
  check('真壳里 SVG 上真的画出了矩形',
    (await page.$eval('#pdf-mark-layer', (el) => el.querySelectorAll('.mk-rect:not(.mk-draft)').length)) >= 1);

  await page.mouse.click(...at(0.4, 0.32));
  marks = await waitState(page, () =>
    JSON.parse(localStorage.getItem('mingscribe.pdfmarks.v1') || '[]').filter((m) => m.kind === 'rect').length === 0);
  check('真壳里点中即可删除', countOf(marks, 'rect') === 0, '剩 ' + countOf(marks, 'rect'));

  await page.click('#pdf-mark-rect');
  await page.click('#pdf-mark-ink');
  await sleep(200);
  await page.mouse.move(...at(0.12, 0.5));
  await page.mouse.down();
  for (let i = 0; i <= 18; i++) {
    await page.mouse.move(...at(0.12 + 0.6 * (i / 18), 0.5 + Math.sin(i / 2) * 0.006));
    await sleep(20);
  }
  await page.mouse.up();
  marks = await waitState(page, () =>
    JSON.parse(localStorage.getItem('mingscribe.pdfmarks.v1') || '[]').some((m) => m.kind === 'ink'));
  check('真壳里手绘能画出来', marks.some((m) => m.kind === 'ink' && m.points.length > 2),
    JSON.stringify(marks.map((m) => m.kind)));

  await page.click('#pdf-mark-ink');
  await page.click('#pdf-mark-note');
  await sleep(200);
  await page.mouse.click(...at(0.2, 0.68));
  await T(page.waitForSelector('#pdf-note-layer .pdf-note-pin textarea', { timeout: 5000 }), 7000, '等便签');
  check('真壳里落下便签并进入编辑',
    await page.$eval('#pdf-note-layer', (el) => !!el.querySelector('.pdf-note-pin textarea')));
  await page.keyboard.type('这一句要背下来');
  await page.mouse.click(...at(0.85, 0.92));
  marks = await waitState(page, () =>
    JSON.parse(localStorage.getItem('mingscribe.pdfmarks.v1') || '[]').some((m) => m.kind === 'note' && m.note));
  const note = marks.find((m) => m.kind === 'note');
  check('真壳里便签正文写入成功', note && note.note === '这一句要背下来', JSON.stringify(note && note.note));
  check('真壳里点别处收尾没有多贴空便签', countOf(marks, 'note') === 1, countOf(marks, 'note') + ' 张');

  const pinStyle = await page.$eval('#pdf-note-layer .pdf-note-pin', (el) => {
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, radius: cs.borderRadius, pos: cs.position };
  });
  log('  便签样式: ' + JSON.stringify(pinStyle));
  check('真壳里便签样式生效（不是无样式的裸 div）',
    pinStyle.pos === 'absolute' && /rgb\(255,\s*246,\s*207\)/.test(pinStyle.bg), pinStyle.bg);

  // 松手落在纸面之外也要收尾（监听挂在 window 上的那个修复）
  await page.click('#pdf-mark-note');
  await page.click('#pdf-mark-rect');
  await sleep(200);
  const outsideX = box.left > 60 ? box.left - 50 : box.left + box.w + 50;
  await page.mouse.move(...at(0.2, 0.4));
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(...at(0.2 + 0.25 * (i / 8), 0.4 + 0.04 * (i / 8)));
  await page.mouse.move(outsideX, box.top + box.h * 0.44);
  await page.mouse.up();
  marks = await waitState(page, () =>
    JSON.parse(localStorage.getItem('mingscribe.pdfmarks.v1') || '[]').filter((m) => m.kind === 'rect').length >= 1);
  check('真壳里拖出纸面松手也能落盘', countOf(marks, 'rect') >= 1, 'rect=' + countOf(marks, 'rect'));
  check('真壳里松手后不留僵住的草稿',
    (await page.$eval('#pdf-mark-layer', (el) => el.querySelectorAll('.mk-draft').length)) === 0);

  await page.keyboard.press('Escape');
  await sleep(250);
  const afterEsc = await page.evaluate(() => ({
    attr: document.getElementById('pdf-page-wrap').getAttribute('data-mark-tool'),
    screen: document.getElementById('pdf-screen').hidden,
    drawn: document.querySelectorAll('#pdf-mark-layer rect:not(.mk-draft), #pdf-mark-layer path:not(.mk-draft)').length
  }));
  check('真壳里按 Esc 退工具但不关书', afterEsc.attr === null && afterEsc.screen === false, JSON.stringify(afterEsc));
  check('退出工具后批注还在页面上', afterEsc.drawn >= 2, String(afterEsc.drawn));

  check('真壳里无页面错误', errors.length === 0, errors.slice(0, 3).join(' | '));

  await cbr.v.close().catch(() => {});
  try { execSync('taskkill /F /IM mingscribe.exe', { stdio: 'ignore' }); } catch (e) { /* 已退出 */ }
  try { fs.unlinkSync(PDF); } catch (e) { /* 忽略 */ }

  log('');
  log(failures === 0 ? '真机验收：全部通过' : '真机验收：' + failures + ' 项失败');
  fs.writeFileSync(REPORT, lines.join('\n'), 'utf8');
  console.log(lines.join('\n'));
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  try { execSync('taskkill /F /IM mingscribe.exe', { stdio: 'ignore' }); } catch (e) { /* 忽略 */ }
  lines.push('脚本异常: ' + err.stack);
  try { fs.writeFileSync(REPORT, lines.join('\n'), 'utf8'); } catch (e) {}
  console.error(lines.join('\n'));
  process.exit(1);
});
