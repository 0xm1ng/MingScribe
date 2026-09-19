/**
 * PDF 阅读视图的端到端自检（一次性验证脚本，不进入常规测试套件）。
 *
 * 为什么必须起一个本地 HTTP 服务（而不是像 e2e_smoke.js 那样用 file://）：
 * 内置的 pdf.js 是 ES Module，浏览器在 file:// 协议下禁止加载模块（CORS）。
 * 桌面版跑在 http://tauri.localhost，所以这里用临时静态服务模拟同一环境。
 *
 * 覆盖：导入 → 首页渲染 → 翻页（按钮 / 键盘）→ 缩放 → 跳页 → 文字层划选
 *      → 全文搜索（Ctrl+F / 命中高亮 / 上一处下一处 / 点结果跳页）
 *      → PDF 批注（框选 / 手绘 / 便签 / 撤销 / 分页隔离 / 重开仍在）→ 返回书架
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

/**
 * 默认跑源码目录（开发时改完立刻验）。
 * 设 MS_ROOT=dist 可以把同一套验收原封不动跑在**打包产物**上 ——
 * 构建会把 src/ 拷进 dist/，只测源码是抓不到「产物少文件 / 路径没跟上」这类问题的。
 */
const ROOT = process.env.MS_ROOT
  ? path.resolve(__dirname, '..', process.env.MS_ROOT)
  : path.resolve(__dirname, '..');
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
  log('5. 文字层（划选 / 复制）');
  const layer = await page.evaluate(() => {
    const l = document.getElementById('pdf-text-layer');
    const spans = Array.from(l.querySelectorAll('span'))
      .filter((s) => !String(s.className || '').includes('markedContent'));
    return {
      scale: l.style.getPropertyValue('--scale-factor'),
      spanCount: spans.length,
      text: spans.map((s) => s.textContent).join(''),
      layerW: l.getBoundingClientRect().width,
      canvasW: document.getElementById('pdf-canvas').getBoundingClientRect().width
    };
  });
  log('  文字层: ' + JSON.stringify(layer));
  check('文字层生成了 span', layer.spanCount > 0, layer.spanCount + ' 个');
  check('文字层能读到页面文字', /MingScribe PDF Page/.test(layer.text), layer.text.slice(0, 60));
  // 少了这个变量，pdf.js 的 calc(var(--scale-factor) * Npx) 全部失效，整层会堆到左上角
  check('--scale-factor 已写入', !!layer.scale, layer.scale || '(空)');
  check('文字层与画布等宽（选中框才不会偏）',
    Math.abs(layer.layerW - layer.canvasW) < 2, layer.layerW + ' vs ' + layer.canvasW);

  const selected = await page.evaluate(() => {
    const l = document.getElementById('pdf-text-layer');
    const spans = Array.from(l.querySelectorAll('span'));
    const span = spans.find((s) => /MingScribe/.test(s.textContent)) ||
      spans.find((s) => s.textContent);
    if (!span) return '';
    const range = document.createRange();
    range.selectNodeContents(span);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    const text = sel.toString();
    sel.removeAllRanges();
    return text;
  });
  check('透明文字可被划选（拿到的是真文本）', selected.length > 0, JSON.stringify(selected.slice(0, 40)));

  log('');
  log('6. 全文搜索');
  await page.keyboard.press('Control+f');
  await page.waitForTimeout(250);
  check('Ctrl+F 打开 PDF 搜索面板',
    await page.$eval('#pdf-search-panel', (el) => !el.hidden));
  check('打开就带上 is-open（展开状态与「算不算开着」同步，不留错位窗口）',
    await page.$eval('#pdf-search-panel', (el) => el.classList.contains('is-open')));

  // 浮现动画只动 transform / opacity，播完必须稳稳落在展开态
  const settled = await page.$eval('#pdf-search-panel', (el) => {
    const cs = getComputedStyle(el);
    return { opacity: Number(cs.opacity), transform: cs.transform, pe: cs.pointerEvents };
  });
  check('入场动画播完：完全不透明、位移归零',
    settled.opacity > 0.99 && /(matrix\(1, 0, 0, 1, 0, 0\)|none)/.test(settled.transform),
    JSON.stringify(settled));
  check('展开时面板可点（pointer-events 没被落下）', settled.pe !== 'none', settled.pe);

  // 面板是浮层，不会把 .pdf-view 挤窄 —— 必须主动按「扣掉面板」的宽度重画，
  // 否则「适应宽度」下页面会铺满整个窗口、右侧被面板盖住，命中高亮可能正好藏在后面。
  const refit = await page.evaluate(() => {
    const view = document.getElementById('pdf-view');
    const panel = document.getElementById('pdf-search-panel');
    const page = document.getElementById('pdf-page-wrap');
    return {
      pageRight: page.getBoundingClientRect().right,
      panelLeft: panel.getBoundingClientRect().left,
      panelTop: panel.getBoundingClientRect().top,
      barBottom: document.querySelector('.pdf-bar').getBoundingClientRect().bottom,
      footTop: document.querySelector('.pdf-foot').getBoundingClientRect().top,
      panelBottom: panel.getBoundingClientRect().bottom
    };
  });
  log('  面板与页面: ' + JSON.stringify(refit));
  check('页面让开了面板（右边不藏在高亮后面）',
    refit.pageRight <= refit.panelLeft + 1,
    '页面右缘 ' + Math.round(refit.pageRight) + ' ≤ 面板左缘 ' + Math.round(refit.panelLeft));
  check('面板正好占住阅读区（上贴顶栏、下贴底栏）',
    Math.abs(refit.panelTop - refit.barBottom) < 2 && Math.abs(refit.panelBottom - refit.footTop) < 2,
    '上 ' + Math.round(refit.panelTop) + '/' + Math.round(refit.barBottom) +
    '，下 ' + Math.round(refit.panelBottom) + '/' + Math.round(refit.footTop));

  await page.fill('#pdf-search-input', 'MingScribe');
  await page.waitForFunction(
    () => document.querySelectorAll('#pdf-search-results .search-item').length > 0,
    null, { timeout: 20000 }
  ).catch(() => {});
  const found = await page.evaluate(() => ({
    count: document.getElementById('pdf-search-count').textContent,
    items: document.querySelectorAll('#pdf-search-results .search-item').length,
    pages: Array.from(document.querySelectorAll('#pdf-search-results .search-item-chapter'))
      .map((e) => e.textContent).join(','),
    label: document.getElementById('pdf-page-label').textContent
  }));
  log('  搜索结果: ' + JSON.stringify(found));
  check('3 页各命中 1 处', found.items === PAGE_COUNT, found.items + ' 条');
  check('每条结果标出页码', found.pages === '第 1 页,第 2 页,第 3 页', found.pages);
  check('搜完自动跳到第一处', found.label === '1 / ' + PAGE_COUNT, found.label);

  await page.waitForTimeout(500);
  const marked = await page.evaluate(() => {
    const l = document.getElementById('pdf-text-layer');
    const marks = l.querySelectorAll('mark');
    return {
      total: marks.length,
      current: l.querySelectorAll('mark.current').length,
      first: marks.length ? marks[0].textContent : ''
    };
  });
  check('当前页画出命中底色', marked.total >= 1, JSON.stringify(marked));
  check('命中文字与关键词一致', /MingScribe/i.test(marked.first), marked.first);
  check('当前那一处用重色单独标出', marked.current === 1, String(marked.current));

  await page.click('#pdf-search-next');
  await page.waitForTimeout(900);
  const onNext = await page.evaluate(() => ({
    label: document.getElementById('pdf-page-label').textContent,
    current: document.querySelectorAll('#pdf-text-layer mark.current').length
  }));
  check('「下一处」跳到第 2 页', onNext.label === '2 / ' + PAGE_COUNT, onNext.label);
  check('跳页后重色高亮跟着走', onNext.current === 1, String(onNext.current));

  await page.click('#pdf-search-prev');
  await page.waitForTimeout(900);
  check('「上一处」退回第 1 页',
    (await page.$eval('#pdf-page-label', (el) => el.textContent)) === '1 / ' + PAGE_COUNT);

  await page.evaluate(() => {
    const items = document.querySelectorAll('#pdf-search-results .search-item');
    if (items[2]) items[2].click();
  });
  await page.waitForTimeout(900);
  const jumped = await page.evaluate(() => ({
    label: document.getElementById('pdf-page-label').textContent,
    current: document.querySelectorAll('#pdf-text-layer mark.current').length
  }));
  check('点结果直接跳到对应页', jumped.label === '3 / ' + PAGE_COUNT, jumped.label);
  check('跳过去以后高亮也在', jumped.current === 1, String(jumped.current));

  await page.fill('#pdf-search-input', 'zzz-not-in-this-pdf');
  await page.waitForTimeout(1000);
  const none = await page.$eval('#pdf-search-count', (el) => el.textContent);
  check('搜不到时给出明确提示', /没有找到/.test(none), none);
  // 反方向也要钉住：夹具有真正文，只是没这个关键词 —— 绝不能被误报成扫描件。
  // （判据是「字密度」而不是「一个字都没有」，阈值调错就容易把正常文档冤枉了）
  check('文字版 PDF 不会被误报成扫描件', !/扫描件|没有文字层/.test(none), none);

  await page.keyboard.press('Escape');

  // 退场动画期间面板还在 DOM 里，但「算不算开着」必须立刻变成否：
  // 宽度得马上还给页面，否则会看到「面板在飘走、页面还缩着」的错位。
  const closing = await page.evaluate(() => {
    const panel = document.getElementById('pdf-search-panel');
    return {
      hidden: panel.hidden,
      open: panel.classList.contains('is-open'),
      paddingRight: getComputedStyle(document.getElementById('pdf-view')).paddingRight
    };
  });
  check('Esc 立刻摘掉 is-open（不等动画播完就算关闭）',
    closing.open === false, JSON.stringify(closing));
  check('还在飘走时页面宽度已经让回来了',
    parseFloat(closing.paddingRight) <= 24.5,
    'paddingRight=' + closing.paddingRight + '（关上应为 24px）');

  await page.waitForSelector('#pdf-search-panel[hidden]', { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(300);
  const afterEsc = await page.evaluate(() => ({
    panel: document.getElementById('pdf-search-panel').hidden,
    screen: document.getElementById('pdf-screen').hidden,
    marks: document.querySelectorAll('#pdf-text-layer mark').length
  }));
  check('动画走完后面板真正 hidden、书没被关掉',
    afterEsc.panel === true && afterEsc.screen === false, JSON.stringify(afterEsc));
  check('收起面板时擦掉高亮', afterEsc.marks === 0, String(afterEsc.marks));

  // 后面两节假定停在第 2 页（第 4 节留下的位置），搜索这一节把页码带跑了，先还回去
  await page.fill('#pdf-page-input', '2');
  await page.press('#pdf-page-input', 'Enter');
  await page.waitForTimeout(600);

  log('');
  log('7. PDF 批注（框选 / 手绘 / 便签）');

  const MARK_KEY = 'mingscribe.pdfmarks.v1';
  const readMarks = () => page.evaluate((k) => {
    const raw = localStorage.getItem(k);
    return raw ? JSON.parse(raw) : [];
  }, MARK_KEY);

  // 批注是按「页面上的相对位置」拖出来的，所以先把整页装进视口再测。
  // 「适应宽度」下页面比窗口高一倍，页面下半截的坐标落在视口之外，
  // 鼠标事件根本送不到 —— 测试会以「画不出东西」的样子失败，其实产品是好的。
  for (let i = 0; i < 3; i++) {
    if ((await page.$eval('#pdf-fit', (el) => el.textContent)) === '整页') break;
    await page.click('#pdf-fit');
    await page.waitForTimeout(450);
  }
  check('切回「整页」显示（批注测试需要整页可见）',
    (await page.$eval('#pdf-fit', (el) => el.textContent)) === '整页',
    await page.$eval('#pdf-fit', (el) => el.textContent));

  // 批注层与文字层是「此消彼长」的一对：平时批注层让开鼠标，文字层才能划选；
  // 选了工具就反过来，否则一拖就变成拖选文字，画不出东西。
  const geom = await page.$eval('#pdf-mark-layer', (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, w: r.width, h: r.height, pe: getComputedStyle(el).pointerEvents };
  });
  log('  批注层: ' + JSON.stringify(geom));
  check('批注层默认不吃鼠标（不影响文字划选）', geom.pe === 'none', geom.pe);
  check('整页都在视口里（否则下面的坐标是点不到的）',
    geom.left >= 0 && geom.top >= 0 && geom.left + geom.w <= 1280 && geom.top + geom.h <= 860,
    JSON.stringify(geom));

  await page.click('#pdf-mark-rect');
  await page.waitForTimeout(120);
  const toolOn = await page.evaluate(() => ({
    attr: document.getElementById('pdf-page-wrap').getAttribute('data-mark-tool'),
    pressed: document.getElementById('pdf-mark-rect').getAttribute('aria-pressed'),
    tipHidden: document.getElementById('pdf-mark-tip').hidden,
    layerPe: getComputedStyle(document.getElementById('pdf-mark-layer')).pointerEvents,
    textPe: getComputedStyle(document.getElementById('pdf-text-layer')).pointerEvents
  }));
  check('点「框选」进入批注模式', toolOn.attr === 'rect', JSON.stringify(toolOn));
  check('工具按钮同步 aria-pressed（无障碍 + 视觉态）', toolOn.pressed === 'true');
  check('给出「怎么退出、怎么删」的提示', toolOn.tipHidden === false);
  check('工具激活后批注层接管鼠标', toolOn.layerPe === 'auto', toolOn.layerPe);
  check('同时让开文字层（否则拖拽会变成划选文字）', toolOn.textPe === 'none', toolOn.textPe);

  const dragOn = async (x0, y0, x1, y1) => {
    await page.mouse.move(geom.left + geom.w * x0, geom.top + geom.h * y0);
    await page.mouse.down();
    await page.mouse.move(geom.left + geom.w * x1, geom.top + geom.h * y1, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(180);
  };

  await dragOn(0.18, 0.22, 0.48, 0.28);
  let marks = await readMarks();
  const rectRec = marks.filter((m) => m.kind === 'rect').pop();
  log('  框选记录: ' + JSON.stringify(rectRec));
  check('拖出的框已存进本地', marks.length === 1 && !!rectRec, '共 ' + marks.length + ' 条');
  check('记录的页码是当前页（第 2 页）', rectRec && rectRec.page === 2, String(rectRec && rectRec.page));
  check('记录归属这本书（按书隔离）', !!(rectRec && rectRec.bookKey), rectRec && rectRec.bookKey);
  check('存的是归一化坐标而不是像素（改缩放才不会漂）',
    !!rectRec && rectRec.rect.x >= 0 && rectRec.rect.x <= 1 && rectRec.rect.w > 0 && rectRec.rect.w <= 1,
    rectRec && JSON.stringify(rectRec.rect));
  check('批注层画出对应矩形', await page.$eval('#pdf-mark-layer', (el) =>
    el.querySelectorAll('.mk-rect:not(.mk-draft)').length) === 1);

  // 点一下（没拖动）压在下面的批注，就把它删掉 —— 这是唯一的删除手势，
  // 所以必须钉死：否则用户只能眼睁睁看着画错的框删不掉。
  await page.mouse.click(geom.left + geom.w * 0.3, geom.top + geom.h * 0.25);
  await page.waitForTimeout(200);
  marks = await readMarks();
  check('点中已有批注即可删掉它', marks.length === 0, '剩 ' + marks.length + ' 条');
  check('删掉后画面上也不留影子', await page.$eval('#pdf-mark-layer', (el) =>
    el.querySelectorAll('.mk-rect').length) === 0);

  await dragOn(0.2, 0.4, 0.5, 0.45);
  check('再画一处，撤销有东西可撤', (await readMarks()).length === 1);
  await page.click('#pdf-mark-undo');
  await page.waitForTimeout(200);
  check('「撤销」撤掉刚画的那一处', (await readMarks()).length === 0);

  // 松手落在纸面之外也必须收尾：真实用户拖过头是常事，鼠标已经在灰底上才松手。
  // 以前监听全挂在批注层上，这种情况下收不到 pointerup，草稿会僵在纸面上，
  // 下一次点击又会把它当新框存进去 —— 现在监听挂在 window 上，必须钉住这个行为。
  const outsideX = geom.left > 60 ? geom.left - 50 : geom.left + geom.w + 50;
  await page.mouse.move(geom.left + geom.w * 0.2, geom.top + geom.h * 0.62);
  await page.mouse.down();
  await page.mouse.move(geom.left + geom.w * 0.45, geom.top + geom.h * 0.65, { steps: 6 });
  await page.mouse.move(outsideX, geom.top + geom.h * 0.65, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(220);
  marks = await readMarks();
  check('拖出纸面再松手也能落盘', marks.length === 1 && marks[0].kind === 'rect',
    '共 ' + marks.length + ' 条');
  check('松手后不留僵住的草稿', await page.$eval('#pdf-mark-layer', (el) =>
    el.querySelectorAll('.mk-draft').length) === 0);

  // 清干净，让后面的断言从「零批注」这个已知状态开始。
  // 这里用「撤销」而不是点掉它：松手落在纸面外时，框的左边界会被夹到 x=0，
  // 框实际躺在 0~0.2 那一段，按中心坐标去点会点空（上一轮就是这么误判的）。
  await page.click('#pdf-mark-undo');
  await page.waitForTimeout(220);
  marks = await readMarks();
  check('刚才那处也能去掉', marks.length === 0, '剩 ' + marks.length + ' 条');

  await page.click('#pdf-mark-rect');
  await page.click('#pdf-mark-ink');
  await page.waitForTimeout(120);
  await dragOn(0.2, 0.55, 0.75, 0.58);
  marks = await readMarks();
  const inkRec = marks.filter((m) => m.kind === 'ink').pop();
  check('手绘笔迹已存下来', !!inkRec, '共 ' + marks.length + ' 条');
  check('笔迹点数经过抽稀，不会存成几万个点',
    !!inkRec && inkRec.points.length >= 2 && inkRec.points.length < 400,
    inkRec && inkRec.points.length + ' 个点');
  check('批注层画出折线', await page.$eval('#pdf-mark-layer', (el) =>
    el.querySelectorAll('path.mk-ink:not(.mk-draft)').length) === 1);

  await page.click('#pdf-mark-ink');
  await page.click('#pdf-mark-note');
  await page.waitForTimeout(120);
  await page.mouse.click(geom.left + geom.w * 0.25, geom.top + geom.h * 0.7);
  await page.waitForTimeout(250);
  check('点一下就贴出一张便签，并直接进入编辑',
    await page.$eval('#pdf-note-layer', (el) => !!el.querySelector('.pdf-note-pin textarea')));
  await page.keyboard.type('这一句是重点');
  await page.mouse.click(geom.left + geom.w * 0.9, geom.top + geom.h * 0.92);
  await page.waitForTimeout(250);
  marks = await readMarks();
  const noteRec = marks.filter((m) => m.kind === 'note').pop();
  check('便签正文写进去了', noteRec && noteRec.note === '这一句是重点',
    JSON.stringify(noteRec && noteRec.note));
  check('点别处收尾不会凭空多贴一张空便签',
    marks.filter((m) => m.kind === 'note').length === 1,
    marks.filter((m) => m.kind === 'note').length + ' 张');
  check('便签气泡显示正文',
    await page.$eval('#pdf-note-layer', (el) =>
      /这一句是重点/.test(el.textContent)));

  await page.click('#pdf-mark-colors .mark-color[data-color="blue"]');
  await page.click('#pdf-mark-note');
  await page.click('#pdf-mark-ink');
  await page.waitForTimeout(120);
  await dragOn(0.3, 0.82, 0.6, 0.85);
  marks = await readMarks();
  const lastMark = marks[marks.length - 1] || {};
  check('换色后新画的批注带上了新颜色', lastMark.color === 'blue',
    JSON.stringify({ color: lastMark.color, total: marks.length }));

  // Esc 一次只收一层：先退批注工具，不该把书一起关掉
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  const afterToolEsc = await page.evaluate(() => ({
    attr: document.getElementById('pdf-page-wrap').getAttribute('data-mark-tool'),
    screen: document.getElementById('pdf-screen').hidden,
    tipHidden: document.getElementById('pdf-mark-tip').hidden,
    layerPe: getComputedStyle(document.getElementById('pdf-mark-layer')).pointerEvents
  }));
  check('Esc 退出批注工具但没关掉书',
    afterToolEsc.attr === null && afterToolEsc.screen === false, JSON.stringify(afterToolEsc));
  check('退出后提示条收起、批注层交还鼠标',
    afterToolEsc.tipHidden === true && afterToolEsc.layerPe === 'none', JSON.stringify(afterToolEsc));

  // 锚点是「页码 + 坐标」，换页绝不能串到别的页上。
  // 比的是「画在批注层上的图形数」而不是存储里的记录数 —— 便签挂在另一层，
  // 拿记录数当基准会永远对不上（曾经就差这一处，断言写法要跟着实现走）。
  const drawnOnPage2 = () => page.$eval('#pdf-mark-layer', (el) =>
    el.querySelectorAll('rect, path').length);
  const beforeSwitch = await drawnOnPage2();
  check('当前页画出了两处笔迹', beforeSwitch === 2, String(beforeSwitch));
  await page.click('#pdf-next');
  await page.waitForTimeout(700);
  const onPage3 = await drawnOnPage2();
  check('翻到没批注的页，一条都不显示', onPage3 === 0, String(onPage3));
  await page.click('#pdf-prev');
  await page.waitForTimeout(700);
  const backToPage2 = await drawnOnPage2();
  check('翻回来批注原样重现', backToPage2 === beforeSwitch,
    backToPage2 + ' vs ' + beforeSwitch);

  // 后面两节假定停在第 2 页（第 4 节留下的位置），搜索那一节把页码带跑了，先还回去
  await page.fill('#pdf-page-input', '2');
  await page.press('#pdf-page-input', 'Enter');
  await page.waitForTimeout(600);

  log('');
  log('8. 返回书架 + 进度恢复');
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
  // 批注存在本地、锚在「页码 + 坐标」上，换一次打开流程也必须原样贴回来
  const afterReopen = await page.evaluate(() => ({
    drawn: document.querySelectorAll('#pdf-mark-layer rect, #pdf-mark-layer path').length,
    pins: document.querySelectorAll('#pdf-note-layer .pdf-note-pin').length
  }));
  log('  重开后的批注: ' + JSON.stringify(afterReopen));
  check('重开这本书后，批注（含便签）原样贴回页面上',
    afterReopen.drawn === 2 && afterReopen.pins === 1, JSON.stringify(afterReopen));

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
