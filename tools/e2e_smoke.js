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
const { buildSampleEpub } = require('../tests/fixtures/make_epub.js');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PAGE_URL = 'file:///D:/MingScribe/index.html';
const BIG = 'D:\\电子书资源\\txt\\Hello-CTF - 开源CTF入门教程.txt';
const SMALL = 'D:\\电子书资源\\txt\\Web安全学习笔记.txt';
const REPORT = 'D:\\MingScribe\\tools\\_e2e_report.txt';
const SHOT = 'D:\\MingScribe\\tools\\_e2e_shot.png';
const EXPORT_MD = 'D:\\MingScribe\\tools\\_e2e_export.md';
const SHOT_NOTES = 'D:\\MingScribe\\tools\\_e2e_notes.png';
const SHOT_PAGED = 'D:\\MingScribe\\tools\\_e2e_paged.png';

const lines = [];
function log(text) { lines.push(text); }

function sizeOf(p) {
  try { return (fs.statSync(p).size / 1024 / 1024).toFixed(2) + ' MB'; } catch (e) { return '?'; }
}

/**
 * 字号/行距/页宽按钮现在收在顶栏的「Aa」弹出面板里，
 * Playwright 的 click 要求元素可见 → 点之前先确保面板是打开的。
 */
async function ensureTypoPanel(page) {
  const hidden = await page.$eval('#typo-panel', (el) => el.hidden);
  if (hidden) {
    await page.click('#btn-typo');
    await page.waitForTimeout(150);
  }
}

(async function main() {
  const browser = await chromium.launch({
    executablePath: EDGE,
    headless: true,
    args: ['--allow-file-access-from-files']
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    acceptDownloads: true
  });
  const page = await context.newPage();

  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

  await page.goto(PAGE_URL);
  await page.waitForSelector('#shelf-screen');
  log('1. 页面加载 OK，标题：' + (await page.title()));
  log('   空书架提示：' + ((await page.locator('#shelf-empty').isVisible()) ? '正常显示' : '未显示'));

  /* ---- 大书：最关心的性能指标 ---- */
  log('');
  log('2. 打开大书 Hello-CTF（' + sizeOf(BIG) + '，137 万字）');
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

  /* ---- 划线：选中 → 工具条 → 上色 ---- */
  log('');
  const picked = await page.evaluate(() => {
    const p = document.querySelector('#reader-content [data-off]');
    if (!p || !p.firstChild || p.firstChild.nodeType !== 3) return null;

    const node = p.firstChild;
    const length = Math.min(10, node.nodeValue.length);
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, length);

    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.getElementById('reader-content')
      .dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

    return { picked: node.nodeValue.slice(0, length) };
  });
  await page.waitForTimeout(200);

  if (!picked) {
    log('10. 划线流程：跳过（首个段落没有可选的文本节点）');
  } else {
    log('10. 划线流程');
    log('    选中文字：「' + picked.picked + '」→ 工具条可见=' +
      (await page.locator('#hl-toolbar').isVisible()));

    await page.click('.hl-swatch.hl-yellow');
    await page.waitForTimeout(250);

    const afterHl = await page.evaluate(() => ({
      marks: document.querySelectorAll('#reader-content mark.hl').length,
      yellow: document.querySelectorAll('#reader-content mark.hl-yellow').length,
      count: document.getElementById('notes-count').textContent,
      toolbarHidden: document.getElementById('hl-toolbar').hidden
    }));
    log('    点黄色后：正文划线元素=' + afterHl.marks + '（黄色 ' + afterHl.yellow +
      '）　侧栏计数=' + afterHl.count + '　工具条已收起=' + afterHl.toolbarHidden);

    // 与已有划线重叠时必须被拒绝
    await page.evaluate(() => {
      const mark = document.querySelector('#reader-content mark.hl');
      if (!mark) return;
      const node = mark.firstChild;
      const range = document.createRange();
      range.setStart(node, 0);
      range.setEnd(node, Math.min(5, node.nodeValue.length));
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.getElementById('reader-content')
        .dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await page.waitForTimeout(200);
    await page.click('.hl-swatch.hl-green');
    await page.waitForTimeout(250);

    const afterOverlap = await page.evaluate(() => ({
      marks: document.querySelectorAll('#reader-content mark.hl').length,
      toast: document.getElementById('toast').textContent
    }));
    log('    重叠划线被拒绝=' + (afterOverlap.marks === afterHl.marks) +
      '　提示文案=' + afterOverlap.toast);

    // 点击已有划线 → 写批注
    await page.click('#reader-content mark.hl');
    await page.waitForTimeout(200);
    log('    点击划线 → 批注弹层可见=' + (await page.locator('#note-popover').isVisible()));
    await page.fill('#note-input', '这里要背下来');
    await page.click('#note-save');
    await page.waitForTimeout(250);

    const noted = await page.evaluate(() => ({
      withNote: document.querySelectorAll('#reader-content mark.hl.with-note').length,
      toast: document.getElementById('toast').textContent
    }));
    log('    保存批注：带批注标记的划线=' + noted.withNote + '　提示=' + noted.toast);

    // 换颜色
    await page.click('#reader-content mark.hl');
    await page.waitForTimeout(150);
    await page.click('#note-color');
    await page.waitForTimeout(200);
    await page.click('#note-close');
    const recolored = await page.evaluate(() => ({
      green: document.querySelectorAll('#reader-content mark.hl-green').length,
      dot: document.querySelectorAll('#notes-list .note-dot.hl-green').length
    }));
    log('    换颜色：正文绿色划线=' + recolored.green + '　列表色点=' + recolored.dot);

    // 笔记面板
    await page.click('#btn-notes');
    await page.waitForTimeout(200);
    const panel = await page.evaluate(() => ({
      visible: !document.getElementById('notes-panel').hidden,
      items: document.querySelectorAll('#notes-list .note-item').length,
      quote: (document.querySelector('#notes-list .note-item-quote') || {}).textContent || '',
      note: (document.querySelector('#notes-list .note-item-note') || {}).textContent || ''
    }));
    log('    笔记面板：可见=' + panel.visible + '　条数=' + panel.items +
      '　首条原文「' + panel.quote + '」　批注「' + panel.note + '」');

    // 点列表项跳回正文
    await page.click('#notes-list .note-item');
    await page.waitForTimeout(300);
    log('    点列表项跳转后所在章=' + (await page.locator('#reader-chapter-name').textContent()));
    await page.screenshot({ path: SHOT_NOTES });

    // 导出 Markdown
    try {
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 15000 }),
        page.click('#btn-export')
      ]);
      await download.saveAs(EXPORT_MD);
      const md = fs.readFileSync(EXPORT_MD, 'utf8');
      log('    导出文件：' + download.suggestedFilename());
      log('    导出内容校验：含原文=' + md.includes(picked.picked) +
        '　含批注=' + md.includes('这里要背下来') +
        '　含章节标题=' + /^## /m.test(md) +
        '　字符数=' + md.length);
    } catch (err) {
      log('    导出：未能捕获下载事件（' + (err && err.message ? err.message.split('\n')[0] : err) + '）');
    }
  }

  /* ---- 刷新页面后划线是否还在 ---- */
  log('');
  await page.reload();
  await page.waitForSelector('#shelf-screen:not([hidden])');
  await page.click('#shelf-grid .book-card button[data-action="open"]');
  await page.waitForFunction(
    () => document.querySelectorAll('#reader-content [data-off]').length > 0,
    null,
    { timeout: 60000 }
  );
  await page.waitForTimeout(400);
  const persisted = await page.evaluate(() => ({
    marks: document.querySelectorAll('#reader-content mark.hl').length,
    count: document.getElementById('notes-count').textContent
  }));
  log('11. 刷新页面后重新打开：正文划线元素=' + persisted.marks + '　侧栏计数=' + persisted.count);

  /* ---- 书架缓存 ---- */
  await page.click('#btn-back');
  await page.waitForTimeout(600);
  const shelf = await page.evaluate(() =>
    Array.prototype.map.call(document.querySelectorAll('#shelf-grid .book-card'), function (li) {
      return {
        name: li.querySelector('.book-title').textContent,
        meta: li.querySelector('.book-meta').textContent
      };
    })
  );
  log('12. 书架条目（验证缓存与进度写入）：');
  if (!shelf.length) log('   （空）');
  shelf.forEach(function (i) { log('   · ' + i.name + '  →  ' + i.meta); });

  /* ---- EPUB 支持 ---- */
  log('');
  const EPUB_FILE = 'D:\\MingScribe\\tools\\_sample.epub';
  fs.writeFileSync(EPUB_FILE, buildSampleEpub());
  const t3 = Date.now();
  await page.setInputFiles('#file-input', EPUB_FILE);
  await page.waitForFunction(
    () => document.querySelectorAll('#reader-content [data-off]').length > 0,
    null,
    { timeout: 60000 }
  );
  const epubInfo = await page.evaluate(() => ({
    book: document.getElementById('reader-book-name').textContent,
    chapter: document.getElementById('reader-chapter-name').textContent,
    imgNote: !!document.querySelector('#reader-content .img-note')
  }));
  await page.click('#btn-toc');
  await page.waitForTimeout(150);
  const epubTocCount = await page.locator('#toc-list li').count();
  await page.click('#toc-list li:nth-child(2)');
  await page.waitForTimeout(250);
  const imgNote = await page.evaluate(() => !!document.querySelector('#reader-content .img-note'));
  log('13. 打开 EPUB（' + (Date.now() - t3) + ' ms）：书名=' + epubInfo.book + '　首章=' + epubInfo.chapter);
  log('    目录条数=' + epubTocCount + '　跳第 2 章后=' +
    (await page.locator('#reader-chapter-name').textContent()) + '　图片占位样式=' + imgNote);

  // EPUB 里搜索
  await page.click('#btn-search');
  await page.fill('#search-input', '正文');
  await page.waitForFunction(
    () => document.querySelectorAll('#search-results .search-item').length > 0,
    null,
    { timeout: 10000 }
  );
  const epubSearch = await page.evaluate(() => document.getElementById('search-count').textContent);
  await page.press('#search-input', 'Escape');
  await page.waitForTimeout(200);
  log('    EPUB 内搜索「正文」：' + epubSearch);

  /* ---- 点面板外部自动关闭 ---- */
  log('');
  await page.click('#btn-toc');
  await page.waitForTimeout(120);
  const tocWasOpen = await page.locator('#toc').isVisible();
  await page.mouse.click(620, 520);
  await page.waitForTimeout(150);
  const tocClosedByOutside = !(await page.locator('#toc').isVisible());

  await page.click('#btn-search');
  await page.waitForTimeout(120);
  await page.mouse.click(620, 520);
  await page.waitForTimeout(150);
  const searchClosedByOutside = !(await page.locator('#search-panel').isVisible());

  await page.click('#btn-notes');
  await page.waitForTimeout(120);
  await page.mouse.click(620, 520);
  await page.waitForTimeout(150);
  const notesClosedByOutside = !(await page.locator('#notes-panel').isVisible());

  log('14. 点面板外部自动关闭：目录 ' + (tocWasOpen && tocClosedByOutside ? 'OK' : 'FAIL') +
    '　搜索 ' + (searchClosedByOutside ? 'OK' : 'FAIL') +
    '　笔记 ' + (notesClosedByOutside ? 'OK' : 'FAIL'));

  // 批注弹层同样点外部关闭
  await page.evaluate(() => {
    const p = document.querySelector('#reader-content [data-off]');
    if (!p || !p.firstChild || p.firstChild.nodeType !== 3) return;
    const node = p.firstChild;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, Math.min(8, node.nodeValue.length));
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.getElementById('reader-content')
      .dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.waitForTimeout(200);
  await page.click('.hl-swatch.hl-blue');
  await page.waitForTimeout(250);
  await page.click('#reader-content mark.hl');
  await page.waitForTimeout(200);
  const popWasOpen = await page.locator('#note-popover').isVisible();
  await page.click('#reader-status');
  await page.waitForTimeout(150);
  const popClosedByOutside = !(await page.locator('#note-popover').isVisible());
  log('    批注弹层打开=' + popWasOpen + '　点外部后关闭=' + popClosedByOutside);

  // 关闭时不能丢掉刚打的字：打一段文字后点外部，再打开应还在
  await page.click('#reader-content mark.hl');
  await page.waitForTimeout(200);
  await page.fill('#note-input', '点外部也应自动保存');
  await page.click('#reader-status');
  await page.waitForTimeout(250);
  await page.click('#reader-content mark.hl');
  await page.waitForTimeout(200);
  const autoSaved = await page.inputValue('#note-input');
  log('    点外部关闭后自动保存批注：内容=「' + autoSaved + '」（期望「点外部也应自动保存」）');
  await page.click('#reader-status');
  await page.waitForTimeout(150);

  /* ---- 刷新后从缓存重建 EPUB（无句柄路径） ---- */
  log('');
  await page.reload();
  await page.waitForSelector('#shelf-screen:not([hidden])');
  await page.click('#shelf-grid .book-card button[data-action="open"]');
  await page.waitForFunction(
    () => document.querySelectorAll('#reader-content [data-off]').length > 0,
    null,
    { timeout: 60000 }
  );
  await page.waitForTimeout(300);
  const epubCached = await page.evaluate(() => ({
    book: document.getElementById('reader-book-name').textContent,
    chapter: document.getElementById('reader-chapter-name').textContent,
    toc: document.getElementById('toc-list').children.length,
    marks: document.querySelectorAll('#reader-content mark.hl').length
  }));
  log('15. 刷新后从缓存直接打开 EPUB（rebuildFromCache 路径）：');
  log('    书名=' + epubCached.book + '　恢复到章=' + epubCached.chapter +
    '　目录条数=' + epubCached.toc + '　划线仍在=' + epubCached.marks);

  /* ---- 分页阅读模式 ---- */
  // 用一个「一章装不下」的大书中章来测：短章只有一页，翻页无从验证。
  // 注意按书名挑书，不能用 nth=1 —— 此时书架里除大书外还有 EPUB 样例。
  const PAGED_CHAPTER = 146;
  const BIG_NAME = 'Hello-CTF - 开源CTF入门教程';
  log('');
  await page.click('#btn-back');
  await page.waitForSelector('#shelf-screen:not([hidden])');

  const openedBig = await page.evaluate((name) => {
    const items = Array.prototype.slice.call(document.querySelectorAll('#shelf-grid .book-card'));
    const hit = items.filter((li) => li.textContent.indexOf(name) >= 0)[0];
    if (!hit) return false;
    const btn = hit.querySelector('button[data-action="open"]');
    if (!btn) return false;
    btn.click();
    return true;
  }, BIG_NAME);
  if (!openedBig) throw new Error('书架上找不到大书「' + BIG_NAME + '」，无法验证分页翻页');

  await page.waitForFunction(
    () => document.querySelectorAll('#reader-content [data-off]').length > 0,
    null,
    { timeout: 60000 }
  );
  await page.waitForTimeout(400);
  await page.click('#btn-toc');
  await page.waitForTimeout(200);
  await page.evaluate((n) => {
    const li = document.querySelectorAll('#toc-list li')[n];
    if (li) li.click();
  }, PAGED_CHAPTER - 1);
  await page.waitForTimeout(400);
  log('16. 分页阅读模式（在第 ' + PAGED_CHAPTER + ' 章上测，该章一屏装不下）：');

  // 切到分页
  await page.click('#btn-mode');
  await page.waitForTimeout(600);

  // 宽屏下分页默认对开（双页）。第 16 段只验证单页语义（行距 / 页宽按钮 /
  // 刷新恢复 / 切回滚动），这里先切回单页，双页专门留给第 17 段。
  var spreadNow = await page.evaluate(() => document.getElementById('btn-spread').textContent.trim());
  if (spreadNow === '双页') {
    await page.click('#btn-spread');
    await page.waitForTimeout(400);
  }

  const paged = await page.evaluate(() => ({
    mode: document.body.getAttribute('data-mode'),
    chapter: document.getElementById('reader-chapter-name').textContent,
    frames: document.querySelectorAll('#reader-content .page-frame').length,
    paras: document.querySelectorAll('#reader-content .page-frame p, #reader-content .page-frame h2').length,
    indicator: document.getElementById('page-indicator').textContent,
    indicatorShown: !document.getElementById('page-indicator').hidden,
    prevChapHidden: getComputedStyle(document.getElementById('btn-prev')).display === 'none',
    pageEdgeShown: getComputedStyle(document.getElementById('btn-page-next')).display !== 'none',
    scrollable: document.getElementById('reader-content').scrollHeight -
      document.getElementById('reader-content').clientHeight
  }));
  log('    所在章=' + paged.chapter);
  log('    切到分页：mode=' + paged.mode + '　页框数=' + paged.frames +
    '　本页段落数=' + paged.paras + '　页码=' + paged.indicator +
    '（可见=' + paged.indicatorShown + '）');
  log('    「上一章」按钮已隐藏=' + paged.prevChapHidden + '　翻页热区可见=' + paged.pageEdgeShown +
    '　内容不再滚动（scrollHeight-clientHeight=' + paged.scrollable + '）');

  if (paged.mode !== 'paged') throw new Error('切换分页模式失败：data-mode=' + paged.mode);
  if (!paged.frames) throw new Error('分页模式下没有渲染 .page-frame');
  if (paged.scrollable > 2) throw new Error('分页模式下内容仍然可滚动，溢出 ' + paged.scrollable + 'px');

  const totalPages = Number((paged.indicator.split('/')[1] || '1').trim());
  log('    该章共 ' + totalPages + ' 页');
  if (totalPages < 2) {
    throw new Error('第 ' + PAGED_CHAPTER + ' 章只有 ' + totalPages + ' 页，无法验证翻页；换一个更长的章');
  }

  // 翻页：记录每页首字，确认内容真的在换；同时记录所在章，好在跨章时也能对账
  const pageTexts = [];
  for (let i = 0; i < 3; i++) {
    pageTexts.push(await page.evaluate(() => {
      const first = document.querySelector('#reader-content .page-frame [data-off]');
      return {
        off: first ? first.getAttribute('data-off') : null,
        ind: document.getElementById('page-indicator').textContent,
        ch: document.getElementById('reader-chapter-name').textContent
      };
    }));
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(240);
  }
  log('    连按 3 次 → ：' + pageTexts.map((p) => '[' + p.ch + ' ' + p.ind + ' @' + p.off + ']').join(' '));

  // 「前进」的判定：换页就算前进，换到下一章也算；只有在同章同页才算没动
  const advanced = pageTexts.some((p, i) => i > 0 &&
    (p.ch !== pageTexts[i - 1].ch || p.off !== pageTexts[i - 1].off));
  log('    每页内容/所属章都在前进：' + advanced);
  if (!advanced) throw new Error('翻页后内容没有变化，可能没真的翻页');

  // 往回翻：逐页回退，最终必须精确回到起点（同章同页同偏移）
  const backTrace = [];
  for (let i = 0; i < pageTexts.length; i++) {
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(240);
    backTrace.push(await page.evaluate(() => {
      const first = document.querySelector('#reader-content .page-frame [data-off]');
      return {
        off: first ? first.getAttribute('data-off') : null,
        ind: document.getElementById('page-indicator').textContent,
        ch: document.getElementById('reader-chapter-name').textContent
      };
    }));
  }
  log('    再按 ' + pageTexts.length + ' 次 ←：' +
    backTrace.map((p) => '[' + p.ch + ' ' + p.ind + ' @' + p.off + ']').join(' '));
  const back = backTrace[backTrace.length - 1];
  log('    回到起点校验：' + back.ch + ' @' + back.off +
    '（期望 ' + pageTexts[0].ch + ' @' + pageTexts[0].off + '）');
  if (back.ch !== pageTexts[0].ch || back.off !== pageTexts[0].off) {
    throw new Error('往回翻没有回到原页：得到 ' + back.ch + ' @' + back.off +
      '，期望 ' + pageTexts[0].ch + ' @' + pageTexts[0].off);
  }

  // 跨章前进再跨章退回：验证章边界处的页衔接（这是最容易错的地方）
  const crossStart = backTrace[backTrace.length - 1];
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(260);
  const crossFwd = await page.evaluate(() => ({
    off: document.querySelector('#reader-content .page-frame [data-off]').getAttribute('data-off'),
    ind: document.getElementById('page-indicator').textContent,
    ch: document.getElementById('reader-chapter-name').textContent
  }));
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(260);
  const crossBack = await page.evaluate(() => ({
    off: document.querySelector('#reader-content .page-frame [data-off]').getAttribute('data-off'),
    ind: document.getElementById('page-indicator').textContent,
    ch: document.getElementById('reader-chapter-name').textContent
  }));
  log('    章边界往返：' + crossStart.ch + ' @' + crossStart.off + ' → →' +
    crossFwd.ch + ' @' + crossFwd.off + ' → ←' + crossBack.ch + ' @' + crossBack.off);
  if (crossBack.ch !== crossStart.ch || crossBack.off !== crossStart.off) {
    throw new Error('章边界往返没有回到原处：' + crossBack.ch + ' @' + crossBack.off);
  }

  // 同一章的不同页必须渲染不同内容（不能是同一段被反复渲染）
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(260);
  const secondPageText = await page.evaluate(() => {
    const ps = document.querySelectorAll('#reader-content .page-frame p');
    return ps.length ? ps[0].textContent.slice(0, 18) : '';
  });
  log('    第二页首段开头：「' + secondPageText + '…」');

  // 改字号后：总页数只增不减、阅读位置不漂太多、当前页不溢出
  const beforeFont = await page.evaluate(() => {
    const first = document.querySelector('#reader-content .page-frame [data-off]');
    const c = document.getElementById('reader-content');
    return {
      off: Number(first.getAttribute('data-off')),
      ind: document.getElementById('page-indicator').textContent,
      total: Number((document.getElementById('page-indicator').textContent.split('/')[1] || '1').trim()),
      overflow: c.scrollHeight - c.clientHeight
    };
  });
  if (beforeFont.overflow > 2) {
    throw new Error('切页前当前页就溢出了 ' + beforeFont.overflow + 'px，文字会被裁掉');
  }

  // 连按两次放大，每次都检查溢出
  await ensureTypoPanel(page);
  const zoomTrace = [beforeFont];
  for (let i = 0; i < 2; i++) {
    await page.click('#btn-font-up');
    await page.waitForTimeout(500);
    zoomTrace.push(await page.evaluate(() => {
      const first = document.querySelector('#reader-content .page-frame [data-off]');
      const c = document.getElementById('reader-content');
      return {
        off: Number(first.getAttribute('data-off')),
        ind: document.getElementById('page-indicator').textContent,
        total: Number((document.getElementById('page-indicator').textContent.split('/')[1] || '1').trim()),
        overflow: c.scrollHeight - c.clientHeight
      };
    }));
  }
  log('    放大字号：' + zoomTrace.map((z) => z.total + '页@' + z.off).join(' → ') +
    '（总页数只增不减）');
  log('    每次放大后溢出量：' + zoomTrace.map((z) => z.overflow + 'px').join(' / ') + '（均应 ≤ 2px）');

  for (let i = 1; i < zoomTrace.length; i++) {
    if (zoomTrace[i].total < zoomTrace[i - 1].total) {
      throw new Error('放大字号后总页数反而减少：' + zoomTrace[i - 1].total + ' → ' + zoomTrace[i].total);
    }
    if (zoomTrace[i].overflow > 2) {
      throw new Error('放大字号后当前页溢出 ' + zoomTrace[i].overflow + 'px，文字被裁掉');
    }
  }
  // 页边界会因字号变化而移动，但内容不能跳到别的章节去
  const fontDrift = Math.abs(zoomTrace[zoomTrace.length - 1].off - beforeFont.off);
  log('    阅读位置漂移：' + fontDrift + ' 字（同一章内即可）');
  if (fontDrift > 1500) {
    throw new Error('改字号后阅读位置漂移过大：' + beforeFont.off + ' → ' + zoomTrace[zoomTrace.length - 1].off);
  }

  // 缩回原字号
  await ensureTypoPanel(page);
  await page.click('#btn-font-down');
  await page.waitForTimeout(400);
  await page.click('#btn-font-down');
  await page.waitForTimeout(400);

  // 行距与页宽
  const beforeLayout = await page.evaluate(() => ({
    lh: getComputedStyle(document.documentElement).getPropertyValue('--reader-line-height').trim(),
    width: getComputedStyle(document.documentElement).getPropertyValue('--page-width').trim(),
    pages: document.getElementById('page-indicator').textContent,
    total: Number((document.getElementById('page-indicator').textContent.split('/')[1] || '1').trim()),
    overflow: document.getElementById('reader-content').scrollHeight -
      document.getElementById('reader-content').clientHeight
  }));
  await ensureTypoPanel(page);
  await page.click('#btn-line-up');
  await page.waitForTimeout(450);
  const afterLine = await page.evaluate(() => ({
    lh: getComputedStyle(document.documentElement).getPropertyValue('--reader-line-height').trim(),
    total: Number((document.getElementById('page-indicator').textContent.split('/')[1] || '1').trim()),
    overflow: document.getElementById('reader-content').scrollHeight -
      document.getElementById('reader-content').clientHeight
  }));
  await page.click('#btn-width-down');
  await page.waitForTimeout(450);
  const afterLayout = await page.evaluate(() => ({
    lh: getComputedStyle(document.documentElement).getPropertyValue('--reader-line-height').trim(),
    width: getComputedStyle(document.documentElement).getPropertyValue('--page-width').trim(),
    pages: document.getElementById('page-indicator').textContent,
    total: Number((document.getElementById('page-indicator').textContent.split('/')[1] || '1').trim()),
    overflow: document.getElementById('reader-content').scrollHeight -
      document.getElementById('reader-content').clientHeight
  }));
  log('    行距 ' + beforeLayout.lh + ' → ' + afterLine.lh +
    '（页数 ' + beforeLayout.total + ' → ' + afterLine.total + '，溢出 ' + afterLine.overflow + 'px）');
  log('    页宽 ' + beforeLayout.width + ' → ' + afterLayout.width +
    '（页数 ' + afterLine.total + ' → ' + afterLayout.total + '，溢出 ' + afterLayout.overflow + 'px）');
  if (beforeLayout.lh === afterLayout.lh) throw new Error('行距没有变化');
  if (beforeLayout.width === afterLayout.width) throw new Error('页宽没有变化');
  if (afterLine.total < beforeLayout.total) {
    throw new Error('放宽行距后总页数反而减少：' + beforeLayout.total + ' → ' + afterLine.total);
  }
  if (afterLayout.total < afterLine.total) {
    throw new Error('收窄页宽后总页数反而减少：' + afterLine.total + ' → ' + afterLayout.total);
  }
  if (afterLayout.overflow > 2) {
    throw new Error('调整排版后当前页溢出 ' + afterLayout.overflow + 'px');
  }

  await page.screenshot({ path: SHOT_PAGED });

  // 分页模式下划线仍然可用（锚点与滚动模式共用同一套字符偏移）
  await page.evaluate(() => {
    const p = document.querySelector('#reader-content .page-frame p');
    const range = document.createRange();
    range.setStart(p.firstChild, 0);
    range.setEnd(p.firstChild, Math.min(6, p.firstChild.length));
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.getElementById('reader-content').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.waitForTimeout(300);
  const hlVisiblePaged = await page.locator('.hl-swatch.hl-yellow').isVisible();
  await page.click('.hl-swatch.hl-yellow');
  await page.waitForTimeout(350);
  const marksPaged = await page.evaluate(() => document.querySelectorAll('#reader-content mark.hl').length);
  log('    分页模式下划线：工具条可见=' + hlVisiblePaged + '　本页划线数=' + marksPaged);
  if (!hlVisiblePaged || marksPaged < 1) throw new Error('分页模式下划线不可用');

  // 用页码找回刚才那页：进度条拖回同一位置后应重建页边界，不能报错
  const beforeReload = await page.evaluate(() => ({
    chapter: document.getElementById('reader-chapter-name').textContent,
    ind: document.getElementById('page-indicator').textContent
  }));

  // 刷新后模式、排版偏好与书签位置都要被记住
  await page.reload();
  await page.waitForSelector('#shelf-screen:not([hidden])');
  const reopened = await page.evaluate((name) => {
    const items = Array.prototype.slice.call(document.querySelectorAll('#shelf-grid .book-card'));
    const hit = items.filter((li) => li.textContent.indexOf(name) >= 0)[0];
    if (!hit) return false;
    hit.querySelector('button[data-action="open"]').click();
    return true;
  }, BIG_NAME);
  if (!reopened) throw new Error('刷新后书架上找不到大书「' + BIG_NAME + '」');
  await page.waitForTimeout(1500);
  const restored = await page.evaluate(() => ({
    mode: document.body.getAttribute('data-mode'),
    lh: getComputedStyle(document.documentElement).getPropertyValue('--reader-line-height').trim(),
    width: getComputedStyle(document.documentElement).getPropertyValue('--page-width').trim(),
    frame: document.querySelectorAll('#reader-content .page-frame').length,
    chapter: document.getElementById('reader-chapter-name').textContent,
    ind: document.getElementById('page-indicator').textContent,
    params: window.MingScribe.Paginate ? 'ok' : 'missing'
  }));
  log('    刷新前：章=' + beforeReload.chapter + '　页码=' + beforeReload.ind);
  log('    刷新后恢复：mode=' + restored.mode + '　行距=' + restored.lh +
    '　页宽=' + restored.width + '　页框=' + restored.frame +
    '　章=' + restored.chapter + '　页码=' + restored.ind + '　Paginate 模块=' + restored.params);
  if (restored.mode !== 'paged') throw new Error('刷新后没有恢复分页模式');
  if (!restored.frame) throw new Error('刷新后分页模式没有渲染页框');
  if (restored.chapter !== beforeReload.chapter) {
    throw new Error('刷新后没有恢复到原来章节：' + restored.chapter + ' ≠ ' + beforeReload.chapter);
  }

  // 切回滚动模式，整章都要渲染出来
  await page.click('#btn-mode');
  await page.waitForTimeout(600);
  const backToScroll = await page.evaluate(() => ({
    mode: document.body.getAttribute('data-mode'),
    frame: document.querySelectorAll('#reader-content .page-frame').length,
    paras: document.querySelectorAll('#reader-content [data-off]').length,
    indicatorHidden: document.getElementById('page-indicator').hidden,
    prevChapShown: getComputedStyle(document.getElementById('btn-prev')).display !== 'none'
  }));
  log('    切回滚动：mode=' + backToScroll.mode + '　页框数=' + backToScroll.frame +
    '　整章段落数=' + backToScroll.paras + '　页码已隐藏=' + backToScroll.indicatorHidden +
    '　「上一章」已恢复=' + backToScroll.prevChapShown);
  if (backToScroll.mode !== 'scroll') throw new Error('切回滚动模式失败');
  if (backToScroll.paras <= paged.paras) {
    throw new Error('滚动模式应渲染整章，段落数 ' + backToScroll.paras + ' 未超过单页 ' + paged.paras);
  }
  if (!backToScroll.prevChapShown) throw new Error('切回滚动后「上一章」没有恢复显示');

  /* ---- 双页对开 ---- */
  log('');
  await page.click('#btn-mode'); // 上一步在滚动模式，先切回分页
  await page.waitForTimeout(600);
  // 确保进入双页：若按钮仍显示「单页」就点一下切换
  let spreadLabel = await page.evaluate(() => document.getElementById('btn-spread').textContent.trim());
  if (spreadLabel !== '双页') {
    await page.click('#btn-spread');
    await page.waitForTimeout(500);
  }
  log('17. 双页对开（在分页模式下测）：');
  const spread = await page.evaluate(() => {
    const c = document.getElementById('reader-content');
    const frames = document.querySelectorAll('#reader-content .page-frame');
    const r0 = frames[0] ? frames[0].getBoundingClientRect() : null;
    const r1 = frames[1] ? frames[1].getBoundingClientRect() : null;
    const cr = c.getBoundingClientRect();
    return {
      mode: document.body.getAttribute('data-mode'),
      dataSpread: document.body.getAttribute('data-spread'),
      frames: frames.length,
      leftMid: r0 ? r0.left + r0.width / 2 : 0,
      rightMid: r1 ? r1.left + r1.width / 2 : 0,
      containerMid: cr.left + cr.width / 2,
      widthBtnHidden: getComputedStyle(document.getElementById('btn-width-up')).display === 'none',
      overflow: c.scrollHeight - c.clientHeight
    };
  });
  log('    data-spread=' + spread.dataSpread + '　页框数=' + spread.frames +
    '　「页宽」按钮已隐藏=' + spread.widthBtnHidden + '　溢出=' + spread.overflow + 'px');
  if (spread.mode !== 'paged') throw new Error('应为分页模式');
  if (spread.dataSpread !== 'on') throw new Error('双页标记 data-spread 未开启');
  if (spread.frames < 2) throw new Error('双页应渲染两个页框，实际 ' + spread.frames);
  if (spread.overflow > 2) throw new Error('双页当前页溢出 ' + spread.overflow + 'px');
  if (!spread.widthBtnHidden) throw new Error('双页下「页宽」按钮应隐藏');
  if (spread.frames >= 2) {
    if (!(spread.leftMid < spread.containerMid && spread.rightMid > spread.containerMid)) {
      throw new Error('双页没有左右并排：左页中点 ' + Math.round(spread.leftMid) +
        ' 右页中点 ' + Math.round(spread.rightMid) + ' 容器中点 ' + Math.round(spread.containerMid));
    }
    log('    两页左右并排：左页中点=' + Math.round(spread.leftMid) +
      '　右页中点=' + Math.round(spread.rightMid) + '　容器中点=' + Math.round(spread.containerMid));
  }

  // 翻一对：页码应前进、右页仍在
  const spreadBefore = await page.evaluate(() => document.getElementById('page-indicator').textContent);
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(260);
  const spreadAfter = await page.evaluate(() => {
    const frames = document.querySelectorAll('#reader-content .page-frame');
    const first = frames[0] ? frames[0].querySelector('[data-off]') : null;
    return {
      ind: document.getElementById('page-indicator').textContent,
      off: first ? first.getAttribute('data-off') : null,
      frames: frames.length
    };
  });
  log('    翻一对：' + spreadBefore + ' → ' + spreadAfter.ind + '（页框数=' + spreadAfter.frames + '）');
  if (spreadAfter.ind === spreadBefore) throw new Error('双页翻页后页码没有前进');
  if (spreadAfter.frames < 2) throw new Error('翻页后右页丢失');

  // 切回单页：只剩一个页框、页宽按钮恢复
  await page.click('#btn-spread');
  await page.waitForTimeout(500);
  const single = await page.evaluate(() => ({
    dataSpread: document.body.getAttribute('data-spread'),
    frames: document.querySelectorAll('#reader-content .page-frame').length,
    widthBtnHidden: getComputedStyle(document.getElementById('btn-width-up')).display === 'none'
  }));
  log('    切回单页：data-spread=' + single.dataSpread + '　页框数=' + single.frames +
    '　「页宽」按钮恢复显示=' + (!single.widthBtnHidden));
  if (single.dataSpread !== 'off') throw new Error('切回单页后 data-spread 仍为 on');
  if (single.frames !== 1) throw new Error('单页应只剩一个页框，实际 ' + single.frames);
  if (single.widthBtnHidden) throw new Error('单页下「页宽」按钮应恢复显示');

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
