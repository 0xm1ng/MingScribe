/**
 * 真实浏览器端到端冒烟测试（一次性验证脚本，不进入常规测试套件）。
 *
 * 目的：验证纯逻辑测试覆盖不到的部分——文件选择、DOM 渲染、鼠标拖动、
 *      键盘交互，以及最关键的「137 万字的书打开到底要多久」。
 *
 * 运行：PowerShell 下执行（Bash 精简环境无法处理中文路径）
 *   node tools/e2e_smoke.js
 */
const fs = require('fs');
const { chromium } = require('C:\\Users\\Admin\\.workbuddy\\binaries\\node\\workspace\\node_modules\\playwright-core');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PAGE_URL = 'file:///D:/MingScribe/index.html';
const BIG = 'D:\\电子书资源\\txt\\Hello-CTF - 开源CTF入门教程.txt';
const SMALL = 'D:\\电子书资源\\txt\\Web安全学习笔记.txt';
const REPORT = 'D:\\MingScribe\\tools\\_e2e_report.txt';
const SHOT = 'D:\\MingScribe\\tools\\_e2e_shot.png';

const lines = [];
function log(text) { lines.push(text); }

function sizeOf(p) {
  try { return (fs.statSync(p).size / 1024 / 1024).toFixed(2) + ' MB'; } catch (e) { return '?'; }
}

(async function main() {
  const browser = await chromium.launch({
    executablePath: EDGE,
    headless: true,
    args: ['--allow-file-access-from-files']
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

  await page.goto(PAGE_URL);
  await page.waitForSelector('#shelf-screen');
  log('1. 页面加载 OK，标题：' + (await page.title()));
  log('   空书架提示：' + ((await page.locator('#shelf-empty').isVisible()) ? '正常显示' : '未显示'));

  /* ---- 大书：最关心的性能指标 ---- */
  log('');
  log('2. 打开大书 Hello-CTF（' + sizeOf(BIG) + '，292 章 / 137 万字）');
  const t0 = Date.now();
  await page.setInputFiles('#file-input', BIG);
  await page.waitForFunction(
    () => document.querySelectorAll('#reader-content [data-off]').length > 0,
    null,
    { timeout: 120000 }
  );
  const openMs = Date.now() - t0;
  log('   从选完文件到正文出现：' + openMs + ' ms');

  const info = await page.evaluate(() => ({
    book: document.getElementById('reader-book-name').textContent,
    chapter: document.getElementById('reader-chapter-name').textContent,
    paras: document.querySelectorAll('#reader-content [data-off]').length,
    status: document.getElementById('reader-status').textContent.trim(),
    progress: document.getElementById('progress-text').textContent
  }));
  log('   书名=' + info.book + '　当前章=' + info.chapter);
  log('   本章段落数=' + info.paras + '　进度=' + info.progress);
  log('   状态行=' + info.status);

  /* ---- 目录 ---- */
  log('');
  await page.click('#btn-toc');
  const tocCount = await page.locator('#toc-list li').count();
  log('3. 目录：可见=' + (await page.locator('#toc').isVisible()) + '　章节条数=' + tocCount);
  await page.click('#toc-list li:nth-child(150)');
  await page.waitForTimeout(300);
  log('   点第 150 章 → 当前章=' + (await page.locator('#reader-chapter-name').textContent()));
  log('   目录自动关闭=' + (!(await page.locator('#toc').isVisible())));

  /* ---- 搜索 ---- */
  log('');
  await page.click('#btn-search');
  const t1 = Date.now();
  await page.fill('#search-input', 'CTF');
  await page.waitForFunction(
    () => document.querySelectorAll('#search-results .search-item').length > 0,
    null,
    { timeout: 30000 }
  );
  const searchMs = Date.now() - t1;
  const s = await page.evaluate(() => ({
    count: document.getElementById('search-count').textContent,
    items: document.querySelectorAll('#search-results .search-item').length,
    marks: document.querySelectorAll('#reader-content mark').length,
    current: document.querySelectorAll('#reader-content mark.current').length,
    chapter: document.getElementById('reader-chapter-name').textContent
  }));
  log('4. 搜索 "CTF"（137 万字全量扫描）：' + searchMs + ' ms（含 180ms 输入防抖）');
  log('   ' + s.count);
  log('   结果条数=' + s.items + '　正文高亮数=' + s.marks + '　当前命中标记=' + s.current);
  log('   首条命中落在：' + s.chapter);

  const beforeChapter = await page.locator('#reader-chapter-name').textContent();
  await page.press('#search-input', 'Enter');
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => ({
    chapter: document.getElementById('reader-chapter-name').textContent,
    active: document.querySelectorAll('#search-results .search-item.active').length,
    current: document.querySelectorAll('#reader-content mark.current').length
  }));
  log('5. Enter 跳下一处：' + beforeChapter + ' → ' + after.chapter);
  log('   列表选中项=' + after.active + '　正文当前命中=' + after.current);

  // 正文字面量验证：搜索带正则符号的词不应报错
  await page.fill('#search-input', 'C++');
  await page.waitForTimeout(600);
  const literal = await page.evaluate(() => document.getElementById('search-count').textContent);
  log('   改搜 "C++"（正则元字符）：' + literal);

  await page.press('#search-input', 'Escape');
  await page.waitForTimeout(200);
  log('   Esc 后面板关闭=' + (!(await page.locator('#search-panel').isVisible())));

  /* ---- 进度条拖动 ---- */
  log('');
  const box = await page.locator('#progress-bar').boundingBox();
  const beforePct = await page.locator('#progress-text').textContent();
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2, { steps: 12 });
  await page.waitForTimeout(120);
  const preview = (await page.locator('#reader-status').textContent()).trim();
  await page.mouse.up();
  await page.waitForTimeout(500);
  log('6. 进度条从 20% 拖到 80%');
  log('   拖动中提示=' + preview);
  log('   松手后进度：' + beforePct + ' → ' + (await page.locator('#progress-text').textContent()));
  log('   落点章节=' + (await page.locator('#reader-chapter-name').textContent()));

  /* ---- 主题 ---- */
  await page.click('#btn-theme');
  log('7. 主题切换后 data-theme=' + (await page.evaluate(() => document.body.getAttribute('data-theme'))));
  await page.screenshot({ path: SHOT });

  /* ---- 小书对比 ---- */
  log('');
  await page.click('#btn-back');
  await page.waitForSelector('#shelf-screen:not([hidden])');
  const t2 = Date.now();
  await page.setInputFiles('#file-input', SMALL);
  await page.waitForFunction(
    () => document.querySelectorAll('#reader-content [data-off]').length > 0,
    null,
    { timeout: 60000 }
  );
  log('8. 打开小书 Web 安全学习笔记（' + sizeOf(SMALL) + '）：' + (Date.now() - t2) + ' ms');

  /* ---- 书架缓存 ---- */
  await page.click('#btn-back');
  await page.waitForTimeout(600);
  const shelf = await page.evaluate(() =>
    Array.prototype.map.call(document.querySelectorAll('#shelf-list .shelf-item'), function (li) {
      return {
        name: li.querySelector('.shelf-item-name').textContent,
        meta: li.querySelector('.shelf-item-meta').textContent
      };
    })
  );
  log('9. 书架条目（验证缓存与进度写入）：');
  if (!shelf.length) log('   （空）');
  shelf.forEach(function (i) { log('   · ' + i.name + '  →  ' + i.meta); });

  log('');
  log('页面错误：' + (errors.length ? errors.join(' | ') : '无'));

  await browser.close();
  fs.writeFileSync(REPORT, lines.join('\n'), 'utf8');
})().catch(function (err) {
  lines.push('');
  lines.push('脚本失败：' + (err && err.message ? err.message : String(err)));
  try { fs.writeFileSync(REPORT, lines.join('\n'), 'utf8'); } catch (e) { /* 忽略 */ }
  process.exit(1);
});
