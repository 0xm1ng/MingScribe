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
const EXPORT_MD = 'D:\\MingScribe\\tools\\_e2e_export.md';
const SHOT_NOTES = 'D:\\MingScribe\\tools\\_e2e_notes.png';

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
  await page.click('#shelf-list .shelf-item button[data-action="open"]');
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
    Array.prototype.map.call(document.querySelectorAll('#shelf-list .shelf-item'), function (li) {
      return {
        name: li.querySelector('.shelf-item-name').textContent,
        meta: li.querySelector('.shelf-item-meta').textContent
      };
    })
  );
  log('12. 书架条目（验证缓存与进度写入）：');
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
