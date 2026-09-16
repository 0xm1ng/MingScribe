/**
 * 生成 README 用界面截图（一次性工具，不进入测试套件）。
 *
 * 用本机真实 Edge（无需下载浏览器）打开本地页面，走完整的文件选择、翻章、
 * 切滚动 / 分页 / 双页、划线批注、全文搜索等交互，逐张截图，输出到
 * docs/screenshots/。
 *
 * 三个踩过的坑，改脚本前先读：
 *   1. 导入完成时会有「解析完成：N 章」toast 浮层盖住正文，截图前必须等它消失；
 *   2. 宽屏下切到分页模式会**自动开启双页对开**，所以要单页图必须显式切回单页；
 *   3. 分页模式只渲染当前页的段落（实测只有 8 段），划线很难凑够几条——
 *      划线相关截图要放在**滚动模式**下做。
 *
 * 运行（Bash 精简环境无法传中文路径，素材路径写死在本文件里）：
 *   node tools/make_screenshots.js
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('C:\\Users\\Admin\\.workbuddy\\binaries\\node\\workspace\\node_modules\\playwright-core');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PAGE_URL = 'file:///D:/MingScribe/index.html';
const OUT = 'D:\\MingScribe\\docs\\screenshots';

// 主演示书：中文技术书，章节结构完整、排版干净
const MAIN = 'D:\\电子书资源\\txt\\Web安全学习笔记.txt';
// 第二本：让书架不那么空
const EXTRA = 'D:\\电子书资源\\txt\\Hello-CTF - 开源CTF入门教程.txt';
// 跳到这一章截图（实测该章无 markdown 残留）
const TARGET_CH = 'Web技术演化';

const LOG = [];
function step(s) { LOG.push(s); console.log(s); }

async function shot(page, name, clip) {
  const p = path.join(OUT, name + '.png');
  await page.screenshot(clip ? { path: p, clip } : { path: p });
  step('    -> ' + name + '.png  ' + (fs.statSync(p).size / 1024).toFixed(0) + ' KB');
}

const BODY_READY = () => document.querySelectorAll('#reader-content [data-off]').length > 0;

// toast 是自动消失的浮层，会盖住正文；不主动关它，只等它走
async function settle(page, ms) {
  try { await page.waitForSelector('#toast[hidden]', { timeout: 8000 }); } catch (e) { /* 一直在显示就放弃等 */ }
  await page.mouse.move(720, 862); // 鼠标停在页脚空白，避免任何 hover 态
  await page.waitForTimeout(ms || 350);
}

const txt = async (page, sel) => String(await page.textContent(sel)).trim();

// 按钮文案显示的是「当前状态」，所以切到目标状态就是点到文案变化为止
async function ensureMode(page, want) {
  for (let i = 0; i < 3; i++) {
    if ((await txt(page, '#btn-mode')) === want) return true;
    await page.click('#btn-mode');
    await page.waitForTimeout(800);
  }
  return (await txt(page, '#btn-mode')) === want;
}

async function ensureSpread(page, want) {
  for (let i = 0; i < 3; i++) {
    if ((await txt(page, '#btn-spread')) === want) return true;
    await page.click('#btn-spread');
    await page.waitForTimeout(800);
  }
  return (await txt(page, '#btn-spread')) === want;
}

/**
 * 划一条线。每次划线都会把段落拆出 <mark>，段落与文本节点都会变，
 * 所以每次都重新扫描「不含划线、且文本够长」的段落，不能用固定下标。
 * 内容不够长时自动降级到更短的选区。
 */
async function makeHighlight(page, opts) {
  const lengths = opts.len ? [opts.len, 12, 8, 5] : [12, 8, 5];
  for (const len of lengths) {
    const info = await page.evaluate(({ n, skip }) => {
      const ps = Array.from(document.querySelectorAll('#reader-content [data-off]'));
      const useable = [];
      for (const p of ps) {
        if (p.querySelector('mark.hl')) continue;
        const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT, null);
        const node = walker.nextNode();
        if (!node || node.length < n) continue;
        useable.push({ node, el: p });
      }
      const pick = useable[skip];
      if (!pick) return { ok: false, useable: useable.length, total: ps.length };

      // 必须先让选区落进视口：正文是长滚动容器，视口外的段落会让浮出的
      // 工具条被定位到视口外，既点不到也截不到。
      pick.el.scrollIntoView({ block: 'center', behavior: 'instant' });

      const range = document.createRange();
      range.setStart(pick.node, 0);
      range.setEnd(pick.node, Math.min(n, pick.node.length));
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      return { ok: true, useable: useable.length, len: pick.node.length, used: n };
    }, { n: len, skip: opts.skip || 0 });

    if (!info.ok) continue; // 这个长度下不够选，试更短的

    try {
      await page.waitForSelector('#hl-toolbar:not([hidden])', { timeout: 6000 });
    } catch (e) {
      continue;
    }

    if (opts.note) {
      // 用 JS 直接触发 click：工具条是浮层，用真实鼠标点击会被视口判定挡住
      await page.$eval('#hl-add-note', el => el.click());
      await page.waitForSelector('#note-popover:not([hidden])', { timeout: 6000 });
      await page.fill('#note-input', opts.note);
      await page.$eval('#note-save', el => el.click());
    } else {
      await page.$eval('#hl-toolbar .hl-swatch[data-color="' + opts.color + '"]', el => el.click());
    }
    await page.waitForTimeout(500);
    return { ok: true, used: info.used, len: info.len };
  }
  return { ok: false };
}

(async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch({
    executablePath: EDGE,
    headless: true,
    args: ['--allow-file-access-from-files']
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1
  });
  const page = await context.newPage();

  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

  await page.goto(PAGE_URL);
  await page.waitForSelector('#shelf-screen');
  step('1. 页面已加载');

  /* ---------- 打开主演示书 ---------- */
  await page.setInputFiles('#file-input', MAIN);
  await page.waitForFunction(BODY_READY, null, { timeout: 120000 });
  step('2. 已打开 ' + path.basename(MAIN));

  /* ---------- 跳到排版干净的章节 ---------- */
  await page.click('#btn-toc');
  await page.waitForSelector('#toc:not([hidden])');
  await page.locator('#toc-list').getByText(TARGET_CH, { exact: false }).first().click();
  await page.waitForTimeout(500);
  step('3. 已跳到章节：' + (await txt(page, '#reader-chapter-name')));

  /* ---------- 页宽推到最大档，1440 宽下默认版心偏窄 ---------- */
  for (let i = 0; i < 5; i++) { await page.click('#btn-width-up'); await page.waitForTimeout(150); }
  step('4. 页宽推到最大档');

  /* ---------- 02 滚动模式 ---------- */
  await settle(page, 700);
  await shot(page, '02-reading');

  /* ---------- 03 分页模式：宽屏会自动开双页，显式切回单页 ---------- */
  await ensureMode(page, '分页');
  await ensureSpread(page, '单页');
  await settle(page, 700);
  await shot(page, '03-paged');
  step('5. 分页单页，页码 ' + (await txt(page, '#page-indicator')));

  /* ---------- 04 双页对开 ---------- */
  await ensureSpread(page, '双页');
  await settle(page, 700);
  await shot(page, '04-spread');
  step('6. 双页对开，页码 ' + (await txt(page, '#page-indicator')));

  /* ---------- 05 目录面板 ---------- */
  // 切回单页：单页的版心居中、两侧留白够宽，面板浮出时才不会压住正文
  await ensureSpread(page, '单页');
  await page.waitForTimeout(500);
  await page.click('#btn-toc');
  await page.waitForSelector('#toc:not([hidden])');
  await settle(page, 300); // 等「已切回单页」的 toast 走掉再拍
  await shot(page, '05-toc');
  await page.click('#btn-toc-close');
  await page.waitForTimeout(350);

  /* ---------- 06 搜索面板 ---------- */
  // 搜索会定位到「当前阅读位置附近」的命中；不先回到目标章的话，
  // 就会搜出上一章那种列表型内容，版面不好看
  await page.click('#btn-toc');
  await page.waitForSelector('#toc:not([hidden])');
  await page.locator('#toc-list').getByText(TARGET_CH, { exact: false }).first().click();
  await page.waitForTimeout(500);

  await page.click('#btn-search');
  await page.waitForSelector('#search-panel:not([hidden])');
  await page.fill('#search-input', 'Web');
  await page.waitForTimeout(1000);
  await shot(page, '06-search');
  step('7. 搜索命中：' + (await txt(page, '#search-count')));
  await page.click('#btn-search-close');
  await page.waitForTimeout(350);

  /* ---------- 划线要在滚动模式下做（分页只渲染当前页，段落不够选） ---------- */
  await ensureSpread(page, '单页');
  await ensureMode(page, '滚动');
  // 搜索会把正文带到命中位置（实测跳去了另一章的列表节），
  // 这里重新跳回目标章，保证截图里是散文段落而不是一串短列表项
  await page.click('#btn-toc');
  await page.waitForSelector('#toc:not([hidden])');
  await page.locator('#toc-list').getByText(TARGET_CH, { exact: false }).first().click();
  await settle(page, 600);
  const paras = await page.locator('#reader-content [data-off]').count();
  step('8. 回到滚动模式并跳回「' + TARGET_CH + '」，本章段落数 ' + paras);

  const n1 = await makeHighlight(page, { len: 18, skip: 0, note: '这一段是全文的纲领，回头看第二遍。' });
  const n2 = await makeHighlight(page, { len: 24, skip: 1, color: 'blue' });
  const n3 = await makeHighlight(page, { len: 16, skip: 2, color: 'green' });
  step('9. 划线：黄(带批注)=' + (n1.ok ? '成功' : '失败') +
    '　蓝=' + (n2.ok ? '成功' : '失败') +
    '　绿=' + (n3.ok ? '成功' : '失败'));
  step('   正文划线元素数：' + await page.locator('#reader-content mark.hl').count());

  /* ---------- 07 笔记面板 ---------- */
  await settle(page, 400); // 等「已划线」的 toast 走掉，它是个浮层
  await page.click('#btn-notes');
  await page.waitForSelector('#notes-panel:not([hidden])');
  await page.waitForTimeout(500);
  await shot(page, '07-notes');
  await page.click('#btn-notes-close');
  await page.waitForTimeout(350);

  /* ---------- 08 夜间主题（与 02 同一视图，便于对照） ---------- */
  await page.click('#btn-theme');
  await page.waitForTimeout(600);
  step('10. 主题 = ' + await page.evaluate(() => document.body.getAttribute('data-theme')));
  // 回到章节顶部，和 02 完全同构图
  await page.click('#btn-toc');
  await page.waitForSelector('#toc:not([hidden])');
  await page.locator('#toc-list').getByText(TARGET_CH, { exact: false }).first().click();
  await settle(page, 800);
  await shot(page, '08-night');

  // 切回日间，书架要用亮色
  await page.click('#btn-theme');
  await page.waitForTimeout(500);

  /* ---------- 01 书架（放最后，要退出阅读器） ---------- */
  await page.click('#btn-back');
  await page.waitForSelector('#shelf-screen:not([hidden])');
  await page.waitForTimeout(400);

  // 再摆几本上去，免得书架看起来太空；顺便证明 EPUB 也能进书架
  const SHELF_FILL = [
    EXTRA,
    'D:\\电子书资源\\txt\\OWASP Web安全测试指南(英文版).txt',
    'D:\\电子书资源\\Epub\\pg25288-images-3.epub'
  ];
  for (const f of SHELF_FILL) {
    if (!fs.existsSync(f)) { step('   (素材不存在，跳过 ' + path.basename(f) + ')'); continue; }
    await page.setInputFiles('#file-input', f);
    await page.waitForFunction(BODY_READY, null, { timeout: 120000 });
    await page.click('#btn-back');
    await page.waitForSelector('#shelf-screen:not([hidden])');
    await page.waitForTimeout(300);
  }

  await settle(page, 800);
  // 书架内容只占屏幕上部，裁掉下方空白，README 里更紧凑
  await shot(page, '01-shelf', { x: 0, y: 0, width: 1440, height: 700 });
  step('11. 书架卡片数：' + await page.locator('#shelf-grid .book-card').count());

  /* ---------- 收尾 ---------- */
  step('');
  step(errors.length ? '页面错误 ' + errors.length + ' 条：' : '页面错误：无');
  for (const e of errors.slice(0, 10)) step('  ' + e);

  await browser.close();
  fs.writeFileSync('D:\\MingScribe\\tools\\_shots_log.txt', LOG.join('\n'), 'utf8');
})().catch(async (e) => {
  LOG.push('FAILED: ' + (e && e.stack ? e.stack : String(e)));
  try { fs.writeFileSync('D:\\MingScribe\\tools\\_shots_log.txt', LOG.join('\n'), 'utf8'); } catch (x) { }
  console.error(LOG.join('\n'));
  process.exit(1);
});
