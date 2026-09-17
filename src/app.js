/**
 * 显示层：界面与交互。
 *
 * 职责边界：
 *   - 只消费解析层产出的「统一中间格式」，不关心原始文件是 TXT 还是（未来的）EPUB。
 *   - 阅读位置一律通过「章节序号 + 章节内字符偏移」读写，不使用页码。
 *   - 书籍缓存交给 BookStore：能记住的书直接打开，记不住的才回退到文件选择器。
 */
(function () {
  'use strict';

  var Encoding = window.MingScribe.Encoding;
  var Parser = window.MingScribe.Parser;
  var Epub = window.MingScribe.Epub;
  var Progress = window.MingScribe.Progress;
  var Paginate = window.MingScribe.Paginate;
  var Search = window.MingScribe.Search;
  var Decorate = window.MingScribe.Decorate;
  var Annotations = window.MingScribe.Annotations;
  var Exporter = window.MingScribe.Exporter;
  var BookStore = window.MingScribe.BookStore;
  var Convert = window.MingScribe.Convert;
  var Updater = window.MingScribe.Updater;
  var ReadingPrefs = window.MingScribe.ReadingPrefs;
  var TauriBridge = window.MingScribe.TauriBridge;
  var Cover = window.MingScribe.Cover;
  var Pdf = window.MingScribe.Pdf;

  /**
   * 当前版本号。**必须与 package.json / src-tauri/tauri.conf.json 三处一致**——
   * tests/updater.test.js 里有一条测试专门守这件事，改了不同步会直接测试失败。
   */
  var APP_VERSION = '0.3.0';

  var FONT_STEPS = [16, 18, 20, 22, 24, 26];
  var DEFAULT_FONT_SIZE = 19;
  /** 行距档位（line-height 倍数）。中文正文多在 1.6 ~ 2.2 之间。 */
  var LINE_STEPS = [1.55, 1.7, 1.85, 2.0, 2.15, 2.3];
  var DEFAULT_LINE_HEIGHT = 1.85;
  /** 页宽档位，单位 em（相对正文字号）。所以调大字号时页宽会跟着变宽。 */
  var WIDTH_STEPS = [30, 34, 38, 42, 46, 52];
  var DEFAULT_PAGE_WIDTH = 38;
  var MODE_SCROLL = 'scroll';
  var MODE_PAGED = 'paged';
  var PREFS_KEY = 'mingscribe.prefs.v1';
  var SAVE_DEBOUNCE_MS = 400;
  var SEARCH_DEBOUNCE_MS = 180;
  var READING_CPM = 350; // 阅读速度估算（字/分钟），仅用于给出「大约还要读多久」
  var IMAGE_NOTE_PATTERN = /^\[(图片|图)[:：]/;

  /** localStorage 不可用（隐私模式等）时退回内存实现，保证功能不中断。 */
  function safeStorage() {
    try {
      var probe = '__mingscribe_probe__';
      window.localStorage.setItem(probe, '1');
      window.localStorage.removeItem(probe);
      return window.localStorage;
    } catch (err) {
      var mem = {};
      return {
        getItem: function (k) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; },
        setItem: function (k, v) { mem[k] = String(v); },
        removeItem: function (k) { delete mem[k]; }
      };
    }
  }

  var storage = safeStorage();
  var store = Progress.createStore(storage);
  var annotationStore = Annotations.createStore(storage);
  var bookCache = null;
  var cacheBackend = '';

  var state = {
    book: null,
    meta: null,
    chapterIndex: 0,
    saveTimer: null,
    toastTimer: null,
    pendingKey: '',
    search: { query: '', results: [], index: -1 },
    searchTimer: null,
    dragging: false,
    annotations: [],
    selection: null,
    editingId: '',
    /** 分页模式下的当前页边界数组与页序号；滚动模式下不用。 */
    pages: [],
    pageIndex: 0,
    /** 对开（双页）偏好：null = 跟随屏幕宽度自动，true/false = 用户手动锁定。 */
    spreadUserPref: null,
    resizeTimer: null,
    /** 查到的新版本号（用于「忽略此版本」）；没有新版本时为 null。 */
    updateVersion: null
  };

  var el = {};

  function $(id) { return document.getElementById(id); }

  /* ---------------- 偏好设置 ---------------- */

  function loadPrefs() {
    try {
      var parsed = JSON.parse(storage.getItem(PREFS_KEY));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (err) {
      return {};
    }
  }

  function savePrefs(patch) {
    var prefs = loadPrefs();
    Object.keys(patch).forEach(function (k) { prefs[k] = patch[k]; });
    try { storage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (err) { /* 忽略写入失败 */ }
    return prefs;
  }

  function nearestFontIndex(size) {
    var best = 0;
    for (var i = 0; i < FONT_STEPS.length; i++) {
      if (FONT_STEPS[i] <= size) best = i;
    }
    return best;
  }

  /**
   * 排版类偏好要「按书记忆」，所以持久化统一走这里：
   * 正在读书时写入本书（同时同步全局，作为之后新书的默认值）；不在书里时只写全局。
   */
  function persistTypo(patch) {
    var key = state.meta && state.meta.key ? state.meta.key : '';
    var prefs = ReadingPrefs.merge(loadPrefs(), key, patch);
    try { storage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (err) { /* 忽略写入失败 */ }
    return prefs;
  }

  /** 当前这本书的 key；没在读书时返回空串（表示只看全局）。 */
  function currentBookKey() {
    return state.meta && state.meta.key ? state.meta.key : '';
  }

  /**
   * 把当前这本书的排版应用到页面上（只改 CSS 变量，**不写回偏好**）。
   * 必须只读——否则每打开一本没调过的书都会凭空生成一条本书记录，
   * 之后它就再也不会跟随全局了。
   */
  /** 当前这本书「理应使用」的排版值（本书 → 全局 → 默认）。 */
  function currentTypo() {
    return ReadingPrefs.resolve(loadPrefs(), currentBookKey(), {
      fontSize: DEFAULT_FONT_SIZE,
      lineHeight: DEFAULT_LINE_HEIGHT,
      pageWidth: DEFAULT_PAGE_WIDTH
    });
  }

  function applyBookTypo() {
    var resolved = currentTypo();
    paintFontSize(resolved.fontSize);
    paintLineHeight(resolved.lineHeight);
    paintPageWidth(resolved.pageWidth);
    syncTypoTips();
    return resolved;
  }

  /**
   * 把当前生效的字号 / 行距 / 页宽写进「Aa」面板的数值位。
   * 纯展示，不写存储 —— 所以打开书用它来回显本书排版是安全的。
   */
  function syncTypoTips() {
    if (!el.typoPanel) return;
    var t = currentTypo();
    var fs = Math.round(Number(t.fontSize) || DEFAULT_FONT_SIZE);
    var lh = Number(t.lineHeight) || DEFAULT_LINE_HEIGHT;
    var pw = Number(t.pageWidth) || DEFAULT_PAGE_WIDTH;
    if (el.typoFontVal) el.typoFontVal.textContent = String(fs);
    if (el.typoLineVal) el.typoLineVal.textContent = String(lh);
    if (el.typoWidthVal) el.typoWidthVal.textContent = String(pw);
  }

  function paintFontSize(size) {
    var clamped = Math.max(FONT_STEPS[0], Math.min(Number(size) || DEFAULT_FONT_SIZE, FONT_STEPS[FONT_STEPS.length - 1]));
    document.documentElement.style.setProperty('--reader-font-size', clamped + 'px');
    return clamped;
  }

  function applyFontSize(size) {
    var clamped = paintFontSize(size);
    persistTypo({ fontSize: clamped });
    syncTypoTips();
    return clamped;
  }

  /** 在档位表里找最接近的一档，用于把任意历史值吸附到最近档。 */
  function nearestStepIndex(steps, value, fallback) {
    var v = Number(value);
    if (!v || isNaN(v)) v = fallback;
    var best = 0;
    var bestDiff = Infinity;
    for (var i = 0; i < steps.length; i++) {
      var diff = Math.abs(steps[i] - v);
      if (diff < bestDiff) { bestDiff = diff; best = i; }
    }
    return best;
  }

  function paintLineHeight(value) {
    var clamped = LINE_STEPS[nearestStepIndex(LINE_STEPS, value, DEFAULT_LINE_HEIGHT)];
    document.documentElement.style.setProperty('--reader-line-height', String(clamped));
    return clamped;
  }

  function applyLineHeight(value) {
    var clamped = paintLineHeight(value);
    persistTypo({ lineHeight: clamped });
    syncTypoTips();
    return clamped;
  }

  function paintPageWidth(value) {
    var clamped = WIDTH_STEPS[nearestStepIndex(WIDTH_STEPS, value, DEFAULT_PAGE_WIDTH)];
    document.documentElement.style.setProperty('--page-width', clamped + 'em');
    return clamped;
  }

  function applyPageWidth(value) {
    var clamped = paintPageWidth(value);
    persistTypo({ pageWidth: clamped });
    syncTypoTips();
    return clamped;
  }

  /**
   * 阅读模式：'scroll'（连续滚动）或 'paged'（一屏一页）。
   * 统一挂在 body 的 data-mode 上，样式与逻辑都以它为唯一开关。
   */
  function applyReadingMode(mode) {
    var value = mode === MODE_PAGED ? MODE_PAGED : MODE_SCROLL;
    document.body.setAttribute('data-mode', value);
    savePrefs({ readingMode: value });
    if (el.modeBtn) {
      el.modeBtn.textContent = value === MODE_PAGED ? '分页' : '滚动';
      el.modeBtn.title = value === MODE_PAGED ? '当前分页模式，点击切回滚动' : '当前滚动模式，点击切到分页';
      el.modeBtn.classList.toggle('active', value === MODE_PAGED);
    }
    if (el.pageIndicator) el.pageIndicator.hidden = value !== MODE_PAGED;
    if (el.pagePrevBtn) el.pagePrevBtn.hidden = value !== MODE_PAGED;
    if (el.pageNextBtn) el.pageNextBtn.hidden = value !== MODE_PAGED;
    return value;
  }

  function readingMode() {
    return document.body.getAttribute('data-mode') === MODE_PAGED ? MODE_PAGED : MODE_SCROLL;
  }

  function isPaged() {
    return readingMode() === MODE_PAGED;
  }

  /* ---------------- 对开（双页） ---------------- */

  /** 容器宽度达到此值才把对开当作默认；低于则默认单页。 */
  var SPREAD_MIN_CONTENT_PX = 720;
  /** 双页中间的装订线占位（px），参与半屏容量估算。 */
  var SPREAD_GUTTER = 32;
  /** 半页可用宽度低于此值（px）则双页降级为单页渲染，避免字被压得过小。 */
  var SPREAD_MIN_PAGE_PX = 300;
  /** 双页下单页最大宽度（em），与 style.css 里 .page-frame 的 max-width 保持一致。 */
  var SPREAD_MAX_PAGE_EM = 46;

  /**
   * 用户是否想要双页：
   *   - spreadUserPref 为 null → 跟随屏幕宽度自动判断；
   *   - 为 true / false → 用户手动锁定。
   */
  function baseSpread() {
    if (state.spreadUserPref === null) {
      return !!el.content && el.content.clientWidth >= SPREAD_MIN_CONTENT_PX;
    }
    return !!state.spreadUserPref;
  }

  /**
   * 实际渲染时是否真的双页：即便用户选了双页，若半页被压得过小也降级单页，
   * 否则字会小到没法看。渲染、翻页步长都看它，保证逻辑一致。
   */
  function effectiveSpread() {
    if (!baseSpread()) return false;
    var frameX = currentFrameX();
    var avail = (el.content.clientWidth - SPREAD_GUTTER) / 2 - frameX;
    return avail >= SPREAD_MIN_PAGE_PX;
  }

  /** 单个 .page-frame 左右内边距之和（px），没有现成 frame 时用默认 56。 */
  function currentFrameX() {
    var probe = el.content.querySelector('.page-frame');
    if (probe) {
      var pcs = window.getComputedStyle(probe);
      return (parseFloat(pcs.paddingLeft) || 0) + (parseFloat(pcs.paddingRight) || 0);
    }
    return 56;
  }

  /** 单个 .page-frame 上下内边距之和（px），没有现成 frame 时用默认 90（34+56）。 */
  function currentFrameY() {
    var probe = el.content.querySelector('.page-frame');
    if (probe) {
      var pcs = window.getComputedStyle(probe);
      return (parseFloat(pcs.paddingTop) || 0) + (parseFloat(pcs.paddingBottom) || 0);
    }
    return 90;
  }

  function applyTheme(theme) {
    var value = theme === 'dark' ? 'dark' : 'light';
    document.body.setAttribute('data-theme', value);
    savePrefs({ theme: value });
    // 夜间时给两个主题按钮加激活态，明确「现在正处在哪个主题」
    var on = value === 'dark';
    if (el.themeBtn) el.themeBtn.classList.toggle('active', on);
    if (el.themeBtn2) el.themeBtn2.classList.toggle('active', on);
    return value;
  }

  /* ---------------- 工具 ---------------- */

  /** sticky 为 true 时不自动消失，用于「正在打开…」这类持续状态。 */
  function toast(message, sticky) {
    el.toast.textContent = message;
    el.toast.hidden = false;
    if (state.toastTimer) {
      clearTimeout(state.toastTimer);
      state.toastTimer = null;
    }
    if (!sticky) {
      state.toastTimer = setTimeout(function () { el.toast.hidden = true; }, 2600);
    }
  }

  function formatNumber(n) {
    return String(n == null ? 0 : n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  function formatTime(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    var now = new Date();
    var hm = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    if (d.toDateString() === now.toDateString()) return '今天 ' + hm;
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm;
  }

  function bookTitleOf(meta) {
    return (meta && (meta.title || meta.name)) || '未命名';
  }

  /** 读取文件并解码为文本。 */
  function readFileToText(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        try {
          resolve(Encoding.decodeBuffer(reader.result).text);
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = function () { reject(reader.error || new Error('读取文件失败')); };
      reader.readAsArrayBuffer(file);
    });
  }

  /** 读取文件的原始字节（EPUB 是 ZIP 包，必须按二进制读）。 */
  function readFileToBuffer(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(reader.error || new Error('读取文件失败')); };
      reader.readAsArrayBuffer(file);
    });
  }

  /* ---------------- 书籍缓存 ---------------- */

  /**
   * 按可用性依次降级选择后端：IndexedDB → localStorage → 内存。
   * file:// 场景下 IndexedDB 可能不可用，此时 localStorage 仍能保证「下次直接打开」。
   */
  function initCache(done) {
    var candidates = [];
    if (typeof indexedDB !== 'undefined') {
      candidates.push({ name: 'indexeddb', make: function () { return BookStore.createIdbBackend(); } });
    }
    candidates.push({ name: 'localstorage', make: function () { return BookStore.createLocalStorageBackend(storage); } });
    candidates.push({ name: 'memory', make: function () { return BookStore.createMemoryBackend(); } });

    function tryNext(i) {
      if (i >= candidates.length) {
        bookCache = null;
        cacheBackend = 'none';
        done();
        return;
      }
      var backend;
      try {
        backend = candidates[i].make();
      } catch (err) {
        tryNext(i + 1);
        return;
      }
      Promise.resolve()
        .then(function () { return backend.listMeta(); })
        .then(function () {
          bookCache = BookStore.createStore(backend);
          cacheBackend = candidates[i].name;
          done();
        }, function () {
          tryNext(i + 1);
        });
    }

    tryNext(0);
  }

  function cacheBook(payload) {
    if (!bookCache) return;
    bookCache.put(payload).catch(function () { /* 缓存失败不打断阅读 */ });
  }

  /* ---------------- 书架 ---------------- */

  /**
   * 从文件名里取扩展名，用于封面角标和背面「格式」一行。
   * 统一返回大写（封面角标、提示文案都按大写排版）。全项目只有这一处定义。
   */
  function fileExt(name) {
    var m = String(name || '').match(/\.([a-z0-9]{1,8})$/i);
    return m ? m[1].toUpperCase() : '';
  }

  /**
   * 当前设备有没有「悬停」这件事。
   * 有 → 卡片靠 hover 翻到背面，操作按钮放背面，正面保持干净。
   * 没有（平板 / 手机）→ 翻不过去，操作按钮必须留在正面。
   */
  function hasHover() {
    try {
      return !!(window.matchMedia && window.matchMedia('(hover: hover)').matches);
    } catch (err) {
      return true;
    }
  }

  /** 一本书的「打开 / 删除」按钮组；样式类由调用方给，正面与背面各用各的。 */
  function bookFoot(item, openCls, delCls) {
    var foot = document.createElement('div');
    foot.className = 'book-foot';

    var openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = openCls;
    openBtn.textContent = item.rec ? '继续阅读' : '开始阅读';
    openBtn.setAttribute('data-action', 'open');
    openBtn.setAttribute('data-key', item.key);
    openBtn.setAttribute('data-name', item.title);

    var delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = delCls;
    delBtn.textContent = '删除';
    delBtn.setAttribute('data-action', 'remove');
    delBtn.setAttribute('data-key', item.key);

    foot.appendChild(openBtn);
    foot.appendChild(delBtn);
    return foot;
  }

  /** 背面详情表的一行（<dl> 里用 <div> 包 <dt>/<dd> 是合法的）。 */
  function backFact(label, value) {
    var row = document.createElement('div');
    var dt = document.createElement('dt');
    dt.textContent = label;
    var dd = document.createElement('dd');
    dd.textContent = value;
    dt.title = value;
    row.appendChild(dt);
    row.appendChild(dd);
    return row;
  }

  function renderShelf() {
    var progressList = store.list();
    var byKey = {};
    progressList.forEach(function (r) {
      if (r && r.key) byKey[r.key] = r;
    });

    function paint(books) {
      var seen = {};
      var items = [];

      (books || []).forEach(function (b) {
        if (!b || !b.key || seen[b.key]) return;
        seen[b.key] = true;
        items.push({
          key: b.key,
          title: b.title || b.name,
          name: b.name || '',
          cached: true,
          rec: byKey[b.key] || null
        });
      });

      // 进度里有、但缓存中没有的（缓存被清或写入失败）：仍列出，打开时需重新选文件
      progressList.forEach(function (r) {
        if (!r || !r.key || seen[r.key]) return;
        seen[r.key] = true;
        items.push({
          key: r.key,
          title: r.title || r.name,
          name: r.name || '',
          cached: false,
          rec: r
        });
      });

      el.shelfGrid.innerHTML = '';
      el.shelfEmpty.hidden = items.length > 0;
      // 空书架时让网格里的「＋添加图书」虚卡退场，避免与空态里的按钮重复
      el.shelfGrid.classList.toggle('is-empty', items.length === 0);
      el.shelfCount.textContent = items.length ? '共 ' + items.length + ' 本' : '';

      var frag = document.createDocumentFragment();

      // 「添加图书」卡片始终在首位
      var add = document.createElement('button');
      add.type = 'button';
      add.className = 'book-add';
      add.innerHTML = '<span class="book-add-inner"><span class="plus">＋</span><span>添加图书</span></span>';
      add.addEventListener('click', function () { if (el.fileInput) el.fileInput.click(); });
      frag.appendChild(add);

      items.forEach(function (item, idx) {
        var rec = item.rec;
        var pct = Math.max(0, Math.min(100, Number(rec && rec.percent) || 0));
        var colors = Cover.colorFor(item.title);
        var art = Cover.artFor(item.title);
        var ext = fileExt(item.name || item.title);
        var chapter = (rec && rec.chapterTitle) || (rec ? '尚未开始阅读' : '需要重新选择文件');
        var when = (rec && rec.updatedAt) ? formatTime(rec.updatedAt) : '—';

        var card = document.createElement('div');
        card.className = 'book-card';
        card.style.animationDelay = Math.min(idx * 40, 320) + 'ms';
        card.setAttribute('data-key', item.key);
        card.setAttribute('data-name', item.title);

        var inner = document.createElement('div');
        inner.className = 'book-inner';

        /* ---------- 正面：封面 + 图书信息 ---------- */
        var front = document.createElement('div');
        front.className = 'book-face book-front';
        front.setAttribute('data-action', 'open');
        front.setAttribute('data-key', item.key);
        front.setAttribute('data-name', item.title);

        var cover = document.createElement('div');
        cover.className = 'book-cover';
        cover.style.setProperty('--c1', colors.c1);
        cover.style.setProperty('--c2', colors.c2);
        cover.style.setProperty('--c3', 'hsl(' + colors.h2 + ', 42%, 21%)');
        cover.style.setProperty('--c4', 'hsl(' + colors.h1 + ', 46%, 13%)');
        cover.style.setProperty('--pat', art.patternCss);
        cover.style.setProperty('--pat-size', art.patternSize);
        cover.setAttribute('data-genre', art.genre);
        cover.setAttribute('data-pattern', art.pattern);

        var watermark = document.createElement('span');
        watermark.className = 'cover-watermark';
        watermark.setAttribute('aria-hidden', 'true');
        watermark.textContent = art.initial;

        var artBox = document.createElement('span');
        artBox.className = 'cover-art';
        var rule = document.createElement('span');
        rule.className = 'cover-rule';
        var coverName = document.createElement('span');
        coverName.className = 'cover-name';
        coverName.style.fontSize = art.nameSize + 'px';
        coverName.textContent = item.title;
        var extTag = document.createElement('span');
        extTag.className = 'cover-ext';
        extTag.textContent = ext || (item.cached ? 'BOOK' : '离线');
        artBox.appendChild(rule);
        artBox.appendChild(coverName);
        artBox.appendChild(extTag);
        cover.appendChild(watermark);
        cover.appendChild(artBox);

        var body = document.createElement('div');
        body.className = 'book-body';

        var nameEl = document.createElement('div');
        nameEl.className = 'book-title';
        nameEl.textContent = item.title;
        nameEl.title = item.title;

        // 信息分三行摆：章节 → 进度与时间 → 进度条。挤在一行会互相抢宽度。
        var metaEl = document.createElement('div');
        metaEl.className = 'book-meta';
        var chapterEl = document.createElement('span');
        chapterEl.className = 'bm-chapter';
        chapterEl.textContent = chapter;
        chapterEl.title = chapter;
        var lineEl = document.createElement('span');
        lineEl.className = 'bm-line';
        var pctEl = document.createElement('span');
        pctEl.className = 'bm-pct';
        pctEl.textContent = pct.toFixed(1) + '%';
        var timeEl = document.createElement('span');
        timeEl.className = 'bm-time';
        timeEl.textContent = when;
        lineEl.appendChild(pctEl);
        lineEl.appendChild(timeEl);
        metaEl.appendChild(chapterEl);
        metaEl.appendChild(lineEl);

        var prog = document.createElement('div');
        prog.className = 'book-progress';
        var fill = document.createElement('div');
        fill.className = 'book-progress-fill';
        fill.style.width = pct + '%';
        prog.appendChild(fill);

        body.appendChild(nameEl);
        body.appendChild(metaEl);
        body.appendChild(prog);
        // 触屏没有 hover，卡片翻不到背面，操作按钮得留在正面
        if (!hasHover()) body.appendChild(bookFoot(item, 'btn', 'link-btn'));

        front.appendChild(cover);
        front.appendChild(body);

        /* ---------- 背面：详情 + 操作 ---------- */
        var back = document.createElement('div');
        back.className = 'book-face book-back';
        back.style.setProperty('--c3', 'hsl(' + colors.h2 + ', 42%, 22%)');
        back.style.setProperty('--c4', 'hsl(' + colors.h1 + ', 46%, 14%)');
        // 背面沿用同一套图案纹理，翻过去才像同一本书的封底
        back.style.setProperty('--pat', art.patternCss);
        back.style.setProperty('--pat-size', art.patternSize);

        var backTitle = document.createElement('p');
        backTitle.className = 'back-title';
        backTitle.textContent = item.title;

        var backPct = document.createElement('p');
        backPct.className = 'back-pct';
        var backNum = document.createElement('strong');
        backNum.textContent = pct.toFixed(0);
        var backUnit = document.createElement('span');
        backUnit.textContent = '% 已读';
        backPct.appendChild(backNum);
        backPct.appendChild(backUnit);

        var facts = document.createElement('dl');
        facts.className = 'back-facts';
        facts.appendChild(backFact('章节', chapter));
        facts.appendChild(backFact('上次', when));
        facts.appendChild(backFact('格式', (ext || '未知') + ' · ' + (item.cached ? '已缓存' : '待重新选择')));

        var foot = bookFoot(item, 'back-btn', 'back-del');
        foot.className = 'book-foot back-foot';

        back.appendChild(backTitle);
        back.appendChild(backPct);
        back.appendChild(facts);
        back.appendChild(foot);

        inner.appendChild(front);
        inner.appendChild(back);
        card.appendChild(inner);
        frag.appendChild(card);
      });

      el.shelfGrid.appendChild(frag);
    }

    if (bookCache) {
      bookCache.list().then(paint, function () { paint([]); });
    } else {
      paint([]);
    }
  }

  function onShelfClick(event) {
    var btn = event.target.closest ? event.target.closest('[data-action]') : null;
    if (!btn) return;

    var action = btn.getAttribute('data-action');
    var key = btn.getAttribute('data-key');

    if (action === 'remove') {
      if (bookCache) bookCache.remove(key).catch(function () {});
      store.remove(key);
      annotationStore.removeByBook(key);
      renderShelf();
      toast('已删除该书及其阅读记录与划线');
      return;
    }

    if (action === 'open') {
      openFromKey(key, btn.getAttribute('data-name'));
    }
  }

  /** 缓存里没有这本书：回到文件选择器，重新建立缓存。 */
  function askForFile(key, name) {
    state.pendingKey = key || '';
    toast('这本书还没有缓存，请选择《' + (name || '对应的文件') + '》');
    el.fileInput.value = '';
    el.fileInput.click();
  }

  function openFromKey(key, fallbackName) {
    if (!bookCache) {
      askForFile(key, fallbackName);
      return;
    }

    toast('正在打开…', true);

    bookCache.get(key).then(function (entry) {
      if (!entry || (!entry.handle && !entry.text)) {
        askForFile(key, (entry && entry.meta && entry.meta.name) || fallbackName);
        return;
      }

      var meta = {
        key: key,
        name: entry.meta.name,
        size: entry.meta.size,
        title: entry.meta.title || entry.meta.name
      };

      // 有句柄时优先重读原文件：不占存储，且内容始终最新
      if (entry.handle) {
        BookStore.ensurePermission(entry.handle).then(function (granted) {
          if (!granted) {
            askForFile(key, meta.name);
            return;
          }
          entry.handle.getFile().then(function (file) {
            if (Epub.isEpubName(file.name)) {
              readFileToBuffer(file).then(
                function (buffer) { ingestEpub(buffer, meta, entry.handle); },
                function () { askForFile(key, meta.name); }
              );
            } else if (Pdf.isPdfName(file.name)) {
              openPdfFile(file, meta, entry.handle);
            } else {
              readFileToText(file).then(
                function (text) { ingest(text, meta, entry.handle); },
                function () { askForFile(key, meta.name); }
              );
            }
          }, function () { askForFile(key, meta.name); });
        });
        return;
      }

      // EPUB：缓存里存了正文与章节边界，直接重建，不再需要原文件
      if (entry.meta.format === 'epub') {
        // 解析逻辑升级过（如编码探测策略变化）时，旧缓存里的正文可能不正确，
        // 必须重新解析原文件，不能继续用缓存
        if (entry.meta.parserVersion !== PARSER_VERSION) {
          askForFile(key, meta.name);
          return;
        }
        var rebuilt = Epub.rebuildFromCache(entry.text, entry.meta.toc, entry.meta.title);
        if (rebuilt) {
          openBook(rebuilt, meta);
          return;
        }
        askForFile(key, meta.name);
        return;
      }

      // PDF 只缓存了元信息（正文太大不入库），必须回到原文件；
      // 直接 ingest 会把空正文当成「空文件」，所以这里提前拦掉。
      if (entry.meta.format === 'pdf') {
        askForFile(key, meta.name);
        return;
      }

      ingest(entry.text, meta, null);
    }, function () {
      askForFile(key, fallbackName);
    });
  }

  /* ---------------- 打开文件 ---------------- */

  /** 优先用文件句柄 API（可持久化）；不支持时退回传统 input。 */
  function pickFile() {
    if (BookStore.supportsFileSystemAccess()) {
      window.showOpenFilePicker({
        types: [
          {
            description: '电子书（TXT / EPUB / PDF）',
            accept: {
              'text/plain': ['.txt', '.text'],
              'application/epub+zip': ['.epub'],
              'application/pdf': ['.pdf']
            }
          }
        ],
        multiple: false
      }).then(function (handles) {
        var handle = handles && handles[0];
        if (!handle) return;
        return handle.getFile().then(function (file) { openFile(file, handle); });
      }).catch(function (err) {
        // 用户主动取消不算错误
        if (err && err.name === 'AbortError') return;
        pickFileFallback();
      });
      return;
    }
    pickFileFallback();
  }

  function pickFileFallback() {
    el.fileInput.value = '';
    el.fileInput.click();
  }

  function openFile(file, handle) {
    if (!file) return;
    toast('正在打开《' + file.name.replace(/\.[^.]+$/, '') + '》…', true);

    var meta = {
      key: BookStore.makeKey(file.name, file.size),
      name: file.name,
      size: file.size,
      title: file.name.replace(/\.[^.]+$/, '')
    };

    // EPUB 是 ZIP 包，必须按二进制读取后交给 EPUB 解析层
    if (Epub.isEpubName(file.name)) {
      readFileToBuffer(file).then(function (buffer) {
        ingestEpub(buffer, meta, handle || null);
      }, function () {
        toast('读取文件失败');
      });
      return;
    }

    // PDF 是固定版式，走独立的 PDF 阅读视图（按页栅格化），不进可重排的正文解析
    if (Pdf.isPdfName(file.name)) {
      openPdfFile(file, meta, handle || null);
      return;
    }

    // 其他格式（MOBI / AZW3 / DOCX / FB2 …）走 Calibre→EPUB 转换管道，仅桌面版可用
    if (Convert.isConvertible(file.name)) {
      ingestViaConversion(file, meta, handle || null);
      return;
    }

    readFileToText(file).then(function (text) {
      ingest(text, meta, handle || null);
    }, function () {
      toast('读取文件失败');
    });
  }

  /** 解析 → 缓存 → 进入阅读。 */
  function ingest(rawText, meta, handle) {
    try {
      var book = Parser.parseTxt(rawText, { bookTitle: meta.title });

      if (!book.totalChars) {
        toast('这个文件是空的，没有可读内容');
        return;
      }

      cacheBook({
        key: meta.key,
        title: meta.title,
        name: meta.name,
        size: meta.size,
        chapters: book.chapters.length,
        chars: book.totalChars,
        text: rawText,
        handle: handle || null
      });

      openBook(book, meta);
    } catch (err) {
      toast('打开失败：' + (err && err.message ? err.message : '未知错误'));
    }
  }

  /** EPUB：解析 → 缓存（正文 + 章节边界）→ 进入阅读。 */
  function ingestEpub(buffer, meta, handle) {
    Epub.parseEpub(buffer).then(function (book) {
      if (!book.totalChars) {
        toast('这本 EPUB 里没有可读的文字');
        return;
      }

      // 书名优先用 EPUB 元数据（<dc:title>），文件名只作兜底
      if (book.title) meta.title = book.title;

      cacheBook({
        key: meta.key,
        title: meta.title,
        name: meta.name,
        size: meta.size,
        chapters: book.chapters.length,
        chars: book.totalChars,
        format: 'epub',
        parserVersion: PARSER_VERSION,
        toc: book.chapters.map(function (c) {
          return { title: c.title, start: c.start, end: c.end };
        }),
        text: book.text,
        handle: handle || null
      });

      openBook(book, meta);
    }, function (err) {
      toast('EPUB 打开失败：' + (err && err.message ? err.message : '未知错误'));
    });
  }

  /** 解析逻辑版本号。改动解析结果（如编码探测策略）时必须 +1，让旧缓存失效。 */
  var PARSER_VERSION = 2;

  /** 取桌面版注入的转换后端；网页版未注入则返回 null（此时不应触发转换）。 */
  function getConvertBackend() {
    if (typeof window === 'undefined') return null;
    var win = window;
    return win.MingScribeConvert || null;
  }

  /**
   * 非原生格式：经桌面版转换后端转成 EPUB，再走标准 EPUB 入口（ingestEpub）。
   * 这样 progress / search / decorate / annotations 全部复用，零返工。
   *
   * 网页版没有转换后端时，给友好提示并中止，不会崩溃。
   */
  function ingestViaConversion(file, meta, handle) {
    var backend = getConvertBackend();
    if (!backend || typeof backend.convert !== 'function') {
      toast('当前是网页版，暂不支持 .' + (fileExt(file.name) || '该').toUpperCase() +
        ' 格式。请使用桌面版（内置 Calibre 转换），或先转成 EPUB / TXT 再导入。');
      return;
    }

    toast('正在把《' + meta.title + '》转换为 EPUB…', true);
    Promise.resolve(backend.convert(file)).then(function (epubBuffer) {
      if (!epubBuffer) throw new Error('转换未产出 EPUB 文件');
      ingestEpub(epubBuffer, meta, handle);
    }, function (err) {
      toast('转换失败：' + (err && err.message ? err.message : '未检测到 Calibre，或文件已加密 / 损坏'));
    });
  }

  function openBook(book, meta) {
    state.book = book;
    state.meta = meta;
    state.annotations = annotationStore.list(meta.key);
    // 必须在 renderChapter 之前：这本书自己的字号/行距/页宽会决定一屏能放多少字。
    // 晚一步就会用上一本书的排版切页，再被重切一次，白费一次渲染。
    applyBookTypo();

    var saved = store.get(meta.key);
    var target = saved
      ? Progress.resolvePosition(book, saved.chapterIndex, saved.charOffset)
      : { chapterIndex: 0, charOffset: 0 };

    enterReader();
    renderChapter(target.chapterIndex, target.charOffset);

    if (Encoding.garbledRatio(book.text) > 0.02) {
      toast('文字可能仍有乱码，建议换一个来源的文件试试');
    } else if (saved) {
      toast('已恢复到上次位置：' + (saved.chapterTitle || '第 ' + (saved.chapterIndex + 1) + ' 章'));
    } else {
      toast('解析完成：' + book.chapters.length + ' 章 · ' + formatNumber(book.totalChars) + ' 字');
    }
  }

  function enterReader() {
    resetSearch();
    closeNotesPanel();
    el.shelfScreen.hidden = true;
    el.readerScreen.hidden = false;
    el.readerBookName.textContent = bookTitleOf(state.meta);
    el.toc.hidden = true;
    buildToc();
    renderNotesPanel();
  }

  function backToShelf() {
    flushSave();
    resetSearch();
    closeNotesPanel();
    el.readerScreen.hidden = true;
    el.shelfScreen.hidden = false;
    el.toc.hidden = true;
    state.book = null;
    state.meta = null;
    renderShelf();
  }

  /* ---------------- PDF 阅读 ---------------- */

  /**
   * PDF 是固定版式，和可重排正文完全是两回事，所以单独一套状态与视图：
   *  - 锚点用「页码」——PDF 页面尺寸固定，页码不会像可重排文本那样随字号漂移；
   *  - 进度仍写进 Progress（一页 = 一章，见 Pdf.syntheticBook），
   *    于是书架的百分比、最近阅读排序、清空记录这些能力全部自动可用，零重复实现。
   */
  var pdfState = {
    doc: null,
    book: null,
    meta: null,
    page: 1,
    total: 0,
    scale: 1,
    // 默认「整页」：A4 竖版在宽屏上按页宽铺满会高出一大截、每页都要上下滚，
    // 先看到完整版面更符合 PDF 阅读器的习惯（Edge / Acrobat 默认也是整页）。
    fit: 'page',    // 'width' | 'page' | 'manual'
    token: 0,
    resumed: false, // 这次打开是不是从上次位置续读的
    announced: false // 首次渲染完成后只提示一次，翻页不要每次都弹
  };

  function pdfScreenOpen() {
    return !!(el.pdfScreen && !el.pdfScreen.hidden);
  }

  /**
   * 能不能加载 ES Module。pdf.js v4+ 只发 ESM，而浏览器在 file:// 下
   * 一律禁止加载模块（CORS），所以网页版直接放弃 PDF —— 给明确提示，
   * 而不是摆一个点了没反应的按钮。桌面版（http://tauri.localhost）正常。
   */
  function isModuleCapable() {
    try {
      return String(window.location.protocol).indexOf('http') === 0;
    } catch (err) {
      return false;
    }
  }

  /** 打开一个 PDF：读字节 → pdf.js 解析 → 进独立视图。 */
  function openPdfFile(file, meta, handle) {
    if (!file) return;

    if (!isModuleCapable()) {
      toast('网页版暂时看不了 PDF：浏览器不允许以 file:// 方式加载内置渲染引擎。' +
        '请用桌面版，或先把 PDF 转成 TXT / EPUB 再导入。');
      return;
    }

    toast('正在打开 PDF《' + meta.title + '》…', true);

    Pdf.readFileBytes(file)
      .then(function (bytes) { return Pdf.engine().open(bytes); })
      .then(function (doc) {
        pdfState.doc = doc;
        pdfState.meta = meta;
        pdfState.total = doc.numPages || 0;
        pdfState.book = Pdf.syntheticBook(pdfState.total, meta.title);
        pdfState.fit = 'page';

        if (!pdfState.total) {
          toast('这个 PDF 里没有可显示的页面');
          return;
        }

        // 只存元信息：PDF 正文动辄几十 MB，不进缓存；下次打开要重新选文件
        cacheBook({
          key: meta.key,
          title: meta.title,
          name: meta.name,
          size: meta.size,
          chapters: pdfState.total,
          chars: pdfState.total,
          format: 'pdf',
          text: '',
          handle: handle || null
        });

        enterPdf(meta);

        var saved = store.get(meta.key);
        pdfState.resumed = !!saved;
        pdfState.announced = false;
        gotoPdfPage(saved ? (Number(saved.chapterIndex) || 0) + 1 : 1, true);
      }, function (err) {
        toast('PDF 打开失败：' + (err && err.message ? err.message : '文件可能已损坏或带密码'));
      });
  }

  function enterPdf(meta) {
    el.shelfScreen.hidden = true;
    el.readerScreen.hidden = true;
    el.pdfScreen.hidden = false;
    el.pdfBookName.textContent = bookTitleOf(meta);
    el.pdfRange.max = String(Math.max(1, pdfState.total));
    el.pdfPageInput.max = String(Math.max(1, pdfState.total));
    el.pdfFit.textContent = pdfState.fit === 'width' ? '适应宽度' : (pdfState.fit === 'page' ? '整页' : '自定义');
  }

  function closePdf() {
    savePdfProgress();
    if (pdfState.doc && typeof pdfState.doc.destroy === 'function') {
      try { pdfState.doc.destroy(); } catch (err) { /* 销毁失败不影响使用 */ }
    }
    pdfState.doc = null;
    pdfState.book = null;
    pdfState.meta = null;
    pdfState.token++;
    pdfState.announced = false;
    pdfState.resumed = false;
    el.pdfScreen.hidden = true;
    el.pdfHint.hidden = false;
    el.pdfHint.textContent = '正在渲染…';
    el.shelfScreen.hidden = false;
    renderShelf();
  }

  /** 翻到第 page 页（1 起）。force 用于首次进入——页码没变也要渲染一次。 */
  function gotoPdfPage(page, force) {
    var n = Pdf.clampPage(page, pdfState.total);
    var changed = n !== pdfState.page;
    pdfState.page = n;

    el.pdfPageLabel.textContent = Pdf.pageLabel(n, pdfState.total);
    el.pdfPageInput.value = String(n);
    el.pdfRange.value = String(n);
    el.pdfPct.textContent = (pdfState.total ? Math.round((n / pdfState.total) * 100) : 0) + '%';
    el.pdfPrevBtn.disabled = n <= 1;
    el.pdfNextBtn.disabled = n >= pdfState.total;

    if (force || changed) renderPdfPage();
    savePdfProgress();
  }

  /** 把当前页画到 canvas 上。token 用来丢弃「翻页太快」时过期的渲染结果。 */
  function renderPdfPage() {
    if (!pdfState.doc) return;
    var token = ++pdfState.token;
    var page = pdfState.page;
    var engine = Pdf.engine();

    el.pdfHint.hidden = false;
    el.pdfHint.textContent = '正在渲染第 ' + page + ' 页…';

    engine.pageSize(pdfState.doc, page).then(function (size) {
      if (token !== pdfState.token) return;

      // 留 48px 内边距，页面不会贴着窗口边缘
      var available = {
        width: Math.max(200, (el.pdfView.clientWidth || 900) - 48),
        height: Math.max(200, (el.pdfView.clientHeight || 600) - 48)
      };
      var scale = pdfState.fit === 'manual'
        ? Pdf.clampScale(pdfState.scale)
        : Pdf.fitScale(available, size, pdfState.fit);

      pdfState.scale = scale;
      el.pdfZoomVal.textContent = Pdf.scaleLabel(scale);
      el.pdfStatus.textContent = '第 ' + page + ' 页 · 共 ' + pdfState.total + ' 页';

      return engine.render(pdfState.doc, page, el.pdfCanvas, scale).then(function () {
        if (token !== pdfState.token) return;
        el.pdfHint.hidden = true;
        // 打开时的「正在打开…」是常驻提示，必须由首屏渲染结果把它顶掉
        if (!pdfState.announced) {
          pdfState.announced = true;
          toast(pdfState.resumed
            ? '已恢复到上次读到第 ' + pdfState.page + ' 页'
            : '已打开：共 ' + pdfState.total + ' 页');
        }
      });
    }, function (err) {
      if (token !== pdfState.token) return;
      el.pdfHint.hidden = false;
      el.pdfHint.textContent = '第 ' + page + ' 页渲染失败：' +
        (err && err.message ? err.message : '未知错误');
    });
  }

  function savePdfProgress() {
    if (!pdfState.book || !pdfState.meta) return;
    store.save(Progress.makeRecord(
      pdfState.book, pdfState.meta, pdfState.page - 1, Pdf.pageOffset(), Date.now()
    ));
  }

  /** dir = +1 放大，-1 缩小。手动调过缩放后，适应模式转为「自定义」。 */
  function stepPdfZoom(dir) {
    pdfState.fit = 'manual';
    pdfState.scale = Pdf.stepScale(pdfState.scale, dir);
    el.pdfFit.textContent = '自定义';
    el.pdfZoomVal.textContent = Pdf.scaleLabel(pdfState.scale);
    renderPdfPage();
  }

  function togglePdfFit() {
    if (pdfState.fit === 'width') {
      pdfState.fit = 'page';
      el.pdfFit.textContent = '整页';
    } else {
      pdfState.fit = 'width';
      el.pdfFit.textContent = '适应宽度';
    }
    renderPdfPage();
  }

  /** PDF 视图下的快捷键。返回 true 表示已消费，调用方负责 preventDefault。 */
  function onPdfKeyDown(event) {
    if (!pdfScreenOpen()) return false;

    var tag = event.target && event.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return false;

    if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
      gotoPdfPage(pdfState.page - 1);
      return true;
    }
    if (event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' ') {
      gotoPdfPage(pdfState.page + 1);
      return true;
    }
    if (event.key === 'Home') { gotoPdfPage(1); return true; }
    if (event.key === 'End') { gotoPdfPage(pdfState.total); return true; }
    if (event.key === '+' || event.key === '=') { stepPdfZoom(1); return true; }
    if (event.key === '-' || event.key === '_') { stepPdfZoom(-1); return true; }
    if (event.key === 'Escape') { closePdf(); return true; }
    return false;
  }

  /* ---------------- 阅读器 ---------------- */

  function buildToc() {
    el.tocList.innerHTML = '';
    if (!state.book) return;

    var frag = document.createDocumentFragment();
    state.book.chapters.forEach(function (chapter, i) {
      var li = document.createElement('li');
      li.textContent = chapter.title || ('第 ' + (i + 1) + ' 节');
      li.title = li.textContent;
      li.setAttribute('data-index', String(i));
      frag.appendChild(li);
    });
    el.tocList.appendChild(frag);
  }

  function updateTocActive(index) {
    var items = el.tocList.querySelectorAll('li');
    for (var i = 0; i < items.length; i++) {
      if (i === index) items[i].classList.add('active');
      else items[i].classList.remove('active');
    }
  }

  /**
   * 把一章渲染成 DOM。每个段落都记录它在「本章内的字符偏移」，
   * 这样字号/窗口变化后依然能精确定位回同一处内容。
   */
  function buildChapterBody(chapter) {
    var frag = document.createDocumentFragment();
    var lines = chapter.text.split('\n');
    var cursor = 0;

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var lineStart = cursor;
      cursor += line.length + 1;

      var trimmed = line.trim();
      if (!trimmed) continue;

      // data-off 记的是「去掉行首空白后的正文起点」，
      // 这样搜索命中的偏移能精确落到段落里的同一个字
      var lead = line.length - line.replace(/^\s+/, '').length;

      var node;
      if (trimmed === chapter.title) {
        node = document.createElement('h2');
      } else if (IMAGE_NOTE_PATTERN.test(trimmed)) {
        // TXT 无法承载图片，占位文字弱化处理，避免打断阅读节奏
        node = document.createElement('p');
        node.className = 'img-note';
      } else {
        node = document.createElement('p');
      }

      node.setAttribute('data-off', String(lineStart + lead));
      node.textContent = trimmed;
      frag.appendChild(node);
    }

    return frag;
  }

  function renderChapter(index, charOffset) {
    if (!state.book) return;

    var total = state.book.chapters.length;
    var idx = Math.max(0, Math.min(Number(index) || 0, total - 1));
    var chapter = state.book.chapters[idx];
    state.chapterIndex = idx;

    el.content.innerHTML = '';
    if (!isPaged()) el.content.appendChild(buildChapterBody(chapter));
    el.readerChapterName.textContent = chapter.title || ('第 ' + (idx + 1) + ' 节');

    el.prevBtn.disabled = idx <= 0;
    el.nextBtn.disabled = idx >= total - 1;

    var anchor = Math.max(0, Math.min(Number(charOffset) || 0, chapter.end - chapter.start));

    if (isPaged()) {
      // 分页模式：不滚动，改成「按锚点找到该在第几页，只渲染那一页」
      state.pages = [];
      state.pageIndex = 0;
      repaginate(anchor);
    } else {
      el.content.scrollTop = 0;
      positionAt(anchor);
      // 统一重画：搜索命中与划线都要保留，否则翻章后关键词和划线就丢了
      decorateChapter();
      updateProgressDisplay();
    }

    scheduleSave();
  }

  /* ---------------- 分页 ---------------- */

  /**
   * 理想页容量：先用固定的平均字宽估算一屏大概能放多少个字、多少行。
   * 只是为了拿到一个「页边界」的起点，不需要精确——真正的排版仍由 CSS 决定，
   * 切出来的页就算比一屏多一两个字，也只会自然地流到下一页而不是被裁掉。
   */
  function idealMetrics() {
    var rect = el.content.getBoundingClientRect();
    var frameX = currentFrameX();
    var frameY = currentFrameY();

    // 分页模式下 padding 在 .page-frame 上，这里直接读它的真实盒模型，
    // 样式改了也不用跟着改这个函数。
    var perPageWidth;
    if (effectiveSpread()) {
      // 双页：一屏两个并排，每页宽度 = 半屏（扣掉装订线）再扣左右内边距，
      // 上限锁定在 SPREAD_MAX_PAGE_EM，避免超宽屏把单页拉得过长。
      var half = (rect.width - SPREAD_GUTTER) / 2;
      if (half > SPREAD_MAX_PAGE_EM * DEFAULT_FONT_SIZE) half = SPREAD_MAX_PAGE_EM * DEFAULT_FONT_SIZE;
      perPageWidth = Math.max(160, half - frameX);
    } else {
      perPageWidth = Math.max(160, rect.width - frameX);
    }
    var height = Math.max(120, rect.height - frameY);

    var fontSize = parseFloat(window.getComputedStyle(document.documentElement).getPropertyValue('--reader-font-size')) || DEFAULT_FONT_SIZE;
    var lineHeight = parseFloat(window.getComputedStyle(document.documentElement).getPropertyValue('--reader-line-height')) || DEFAULT_LINE_HEIGHT;

    return {
      cols: Math.max(6, perPageWidth / fontSize),
      rowsPerPage: Math.max(3, height / (fontSize * lineHeight))
    };
  }

  /**
   * 把「可用高度」换成一行能放多少行的安全容量。
   *
   * 这里的 0.9 不是随手拍的：估算出的行数总会比真实能放的多一点点
   * （标点避让、段末边距取整、字宽 0.55 的近似都会累积偏差），
   * 留 10% 余量比事后反复重切更稳，也保证了**同样的排版参数必然切出同样的页**
   * —— 这一点很重要，否则前后翻页会因为重切差异而回不到原页。
   */
  var ROWS_SAFETY = 0.9;

  /** 组装切页参数。纯函数：只依赖当前 CSS 变量与容器尺寸。 */
  function paginateOptions() {
    var metrics = idealMetrics();
    return {
      cols: Math.max(4, metrics.cols),
      rowsPerPage: Math.max(2, metrics.rowsPerPage * ROWS_SAFETY),
      isTitle: function (t) {
        var chapter = state.book && state.book.chapters[state.chapterIndex];
        return !!chapter && t === chapter.title;
      }
    };
  }

  /**
   * 按当前字号 / 行距 / 页宽重新切页，并把阅读位置保持在 anchor 这一处。
   *
   * 切页是**确定性**的：同样的排版参数 + 同样的容器尺寸 → 同样的页边界。
   * 所以前后翻页不会因为重切而错位。
   *
   * @param {number} anchor  要保住的本章字符偏移（默认取当前阅读位置）
   */
  function repaginate(anchor) {
    if (!state.book || !isPaged()) return;

    var chapter = state.book.chapters[state.chapterIndex];
    if (!chapter) return;

    var offset = typeof anchor === 'number' && !isNaN(anchor) ? anchor : currentOffset();

    state.pages = Paginate.paginateChapter(chapter, paginateOptions());
    state.pageIndex = Paginate.pageIndexOf(state.pages, offset);
    if (effectiveSpread()) {
      // 对开下让当前页成为「左页」（偶数），保证两页成对出现
      state.pageIndex = Paginate.pairStart(state.pageIndex);
    }

    renderPage();
  }

  /** 构造一个 .page-frame，把 [page.start, page.end) 这一段正文填进去。 */
  function buildPageFrame(page) {
    var chapter = state.book.chapters[state.chapterIndex];
    var source = String(chapter.text || '');
    var slice = source.slice(page.start, page.end);

    var frame = document.createElement('div');
    frame.className = 'page-frame';

    var lines = slice.split('\n');
    var cursor = page.start;
    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i];
      var lineStart = cursor;
      cursor += raw.length + 1;

      var trimmed = raw.trim();
      if (!trimmed) continue;

      var lead = raw.length - raw.replace(/^\s+/, '').length;
      var node;
      if (trimmed === chapter.title) node = document.createElement('h2');
      else if (IMAGE_NOTE_PATTERN.test(trimmed)) { node = document.createElement('p'); node.className = 'img-note'; }
      else node = document.createElement('p');

      node.setAttribute('data-off', String(lineStart + lead));
      node.textContent = trimmed;
      frame.appendChild(node);
    }
    return frame;
  }

  /** 只把当前可见页（双页时左右两页）需要的正文渲染出来。 */
  function renderPage() {
    if (!state.book) return;
    var chapter = state.book.chapters[state.chapterIndex];
    if (!chapter) return;

    var pages = state.pages;
    if (!pages.length) pages = state.pages = [{ start: 0, end: chapter.text.length }];
    state.pageIndex = Paginate.clampPageIndex(pages, state.pageIndex);

    // 对开下始终从偶数「左页」开始，奇数页会被拉回前一个偶数页
    if (effectiveSpread()) state.pageIndex = Paginate.pairStart(state.pageIndex);

    // 每次渲染都同步一次对开相关的 UI（按钮显隐、装订线标记）
    applySpreadChrome();

    el.content.innerHTML = '';
    el.content.appendChild(buildPageFrame(pages[state.pageIndex]));

    if (effectiveSpread()) {
      var rightPage = pages[state.pageIndex + 1];
      if (rightPage) {
        el.content.appendChild(buildPageFrame(rightPage));
      } else {
        // 尾章页数为奇数：右页留空占位，保持版心对称
        var blank = document.createElement('div');
        blank.className = 'page-frame page-frame--blank';
        el.content.appendChild(blank);
      }
    }

    decorateChapter();
    updatePageIndicator();
    updateProgressDisplay();
  }

  function updatePageIndicator() {
    if (!el.pageIndicator) return;
    if (!isPaged()) { el.pageIndicator.hidden = true; return; }
    el.pageIndicator.hidden = false;

    var n = Math.max(1, state.pages.length);
    if (effectiveSpread()) {
      // 双页：显示「左页–右页 / 总页」，右页越界则截断到末页
      var left = state.pageIndex + 1;
      var right = Math.min(state.pageIndex + 2, n);
      // 尾页单独成页（页数为奇数）时右页越界，退化成只显示单页号，避免「5–5 / 5」
      var label = right > left ? (left + '–' + right) : String(left);
      el.pageIndicator.textContent = label + ' / ' + n;
      if (el.pagePrevBtn) el.pagePrevBtn.disabled = state.pageIndex <= 0;
      // 再往前翻一对会越过末尾就禁用「下一页」
      if (el.pageNextBtn) el.pageNextBtn.disabled = (state.pageIndex + 2) >= n;
    } else {
      el.pageIndicator.textContent = (state.pageIndex + 1) + ' / ' + n;
      if (el.pagePrevBtn) el.pagePrevBtn.disabled = state.pageIndex <= 0;
      if (el.pageNextBtn) el.pageNextBtn.disabled = state.pageIndex >= n - 1;
    }
  }

  /** 翻 n 页；双页时对开翻一对（步长 2）；越界时跨到相邻章节的首页 / 末页。 */
  function stepPage(delta) {
    if (!state.book) return;
    if (!isPaged()) {
      // 滚动模式下退化成「滚一屏」，保持手感一致
      var viewport = el.content.clientHeight;
      el.content.scrollTop += (delta > 0 ? 1 : -1) * viewport * 0.9;
      return;
    }

    var stride = effectiveSpread() ? 2 : 1;
    var target = state.pageIndex + delta * stride;

    if (target < 0) {
      // 已经是本章第一页 → 跳上一章的最后一页（对开则对齐到偶数）
      if (state.chapterIndex <= 0) return;
      renderChapter(state.chapterIndex - 1, 0);
      state.pageIndex = state.pages.length - 1;
      if (effectiveSpread()) state.pageIndex = Paginate.pairStart(state.pageIndex);
      renderPage();
      hideToolbar();
      scheduleSave();
      return;
    }

    if (target >= state.pages.length) {
      // 已经是本章最后一页 → 跳下一章的第一页
      if (state.chapterIndex >= state.book.chapters.length - 1) return;
      renderChapter(state.chapterIndex + 1, 0);
      return;
    }

    state.pageIndex = target;
    hideToolbar();
    renderPage();
    scheduleSave();
  }

  /** 跳到本章第一页 / 最后一页；双页下对齐到偶数左页。 */
  function gotoPageEdge(which) {
    if (!state.book || !isPaged()) return;
    state.pageIndex = which === 'end' ? state.pages.length - 1 : 0;
    if (effectiveSpread()) state.pageIndex = Paginate.pairStart(state.pageIndex);
    hideToolbar();
    renderPage();
    scheduleSave();
  }

  /** 滚动到本章内指定字符偏移所在的段落。 */
  function positionAt(offset) {
    if (isPaged()) {
      repaginate(offset, true);
      return;
    }

    var nodes = el.content.querySelectorAll('[data-off]');
    var target = null;

    for (var i = 0; i < nodes.length; i++) {
      if (Number(nodes[i].getAttribute('data-off')) <= offset) target = nodes[i];
      else break;
    }

    el.content.scrollTop = target && target !== nodes[0] ? target.offsetTop : 0;
  }

  /** 当前阅读位置对应的本章字符偏移（分页模式下即当前页的第一个字）。 */
  function currentOffset() {
    if (isPaged()) {
      var page = state.pages[state.pageIndex];
      return page ? page.start : 0;
    }

    var nodes = el.content.querySelectorAll('[data-off]');
    if (!nodes.length) return 0;

    var top = el.content.scrollTop;
    var best = 0;
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].offsetTop <= top + 4) best = Number(nodes[i].getAttribute('data-off'));
      else break;
    }
    return best;
  }

  function setProgressVisual(pct) {
    var shown = Math.max(0, Math.min(100, Number(pct) || 0));
    el.progressFill.style.width = shown + '%';
    el.progressKnob.style.left = shown + '%';
    el.progressText.textContent = shown.toFixed(1) + '%';
    el.progressBar.setAttribute('aria-valuenow', shown.toFixed(1));
  }

  /** 把字数换算成「大约还要读多久」。只是估算，不追求精确。 */
  function formatDuration(chars) {
    var minutes = Math.round((Number(chars) || 0) / READING_CPM);
    if (minutes < 1) return '不到 1 分钟';
    if (minutes < 60) return minutes + ' 分钟';
    var hours = Math.floor(minutes / 60);
    var rest = minutes % 60;
    return rest ? hours + ' 小时 ' + rest + ' 分' : hours + ' 小时';
  }

  function updateStatus() {
    if (!state.book) return;
    var chapter = state.book.chapters[state.chapterIndex];
    if (!chapter) return;

    var span = Math.max(0, chapter.end - chapter.start);
    var read = Math.min(currentOffset(), span);
    var remainChapter = Math.max(0, span - read);
    var remainTotal = Math.max(0, state.book.totalChars - (chapter.start + read));

    el.readerStatus.textContent =
      '本章剩余 ' + formatNumber(remainChapter) + ' 字 · 约 ' + formatDuration(remainChapter) +
      '　｜　全书剩余 ' + formatNumber(remainTotal) + ' 字 · 约 ' + formatDuration(remainTotal);
  }

  function updateProgressDisplay() {
    if (!state.book) return;
    var pct = Progress.computePercent(state.book, state.chapterIndex, currentOffset());
    setProgressVisual(pct);
    updateStatus();
  }

  /* ---------------- 进度条拖动跳转 ---------------- */

  function ratioFromPointer(event) {
    var rect = el.progressBar.getBoundingClientRect();
    if (!rect.width) return 0;
    return Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  }

  function globalOffsetAtRatio(ratio) {
    var total = state.book ? state.book.totalChars || 0 : 0;
    return Math.round(ratio * Math.max(0, total - 1));
  }

  /** 拖动过程中只更新视觉与「松手会跳到哪一章」，不真正切章。 */
  function previewSeek(ratio) {
    if (!state.book) return;
    setProgressVisual(ratio * 100);
    var pos = Progress.resolveGlobalOffset(state.book, globalOffsetAtRatio(ratio));
    var chapter = state.book.chapters[pos.chapterIndex];
    el.readerStatus.textContent = '松手跳到：' + ((chapter && chapter.title) || ('第 ' + (pos.chapterIndex + 1) + ' 节'));
  }

  function commitSeek(ratio) {
    if (!state.book) return;
    var pos = Progress.resolveGlobalOffset(state.book, globalOffsetAtRatio(ratio));
    renderChapter(pos.chapterIndex, pos.charOffset);
  }

  function seekByChars(deltaChars) {
    if (!state.book) return;
    var total = state.book.totalChars || 1;
    var current = Progress.globalOffsetOf(state.book, state.chapterIndex, currentOffset());
    var next = Math.max(0, Math.min(total - 1, current + deltaChars));
    var pos = Progress.resolveGlobalOffset(state.book, next);
    renderChapter(pos.chapterIndex, pos.charOffset);
  }

  /* ---------------- 全文搜索 ---------------- */

  function openSearchPanel() {
    if (!state.book) return;
    el.searchPanel.hidden = false;
    el.toc.hidden = true;
    closeNotesPanel();
    hideToolbar();
    el.searchInput.focus();
    el.searchInput.select();
  }

  function closeSearchPanel() {
    el.searchPanel.hidden = true;
    if (state.searchTimer) {
      clearTimeout(state.searchTimer);
      state.searchTimer = null;
    }
  }

  function searchPanelOpen() {
    return !el.searchPanel.hidden;
  }

  function runSearch(raw) {
    var query = String(raw == null ? '' : raw).trim();
    state.search.query = query;
    state.search.index = -1;

    if (!query) {
      state.search.results = [];
      el.searchCount.textContent = '输入关键词，在整本书里搜索。';
      el.searchResults.innerHTML = '';
      decorateChapter();
      return;
    }

    if (!state.book) return;

    var result = Search.searchBook(state.book, query);
    state.search.results = result.results;

    el.searchCount.textContent = result.total
      ? (result.truncated
          ? '找到 ' + result.total + ' 处以上，已截断——换个更具体的词会更准'
          : '找到 ' + result.total + ' 处')
      : '没有找到「' + query + '」';

    renderSearchResults();

    if (!result.results.length) {
      decorateChapter();
      return;
    }

    // 从当前阅读位置往后找第一条，避免每次搜索都被拽回开头
    var start = Search.firstIndexFrom(
      result.results,
      Progress.globalOffsetOf(state.book, state.chapterIndex, currentOffset())
    );
    gotoResult(start < 0 ? 0 : start);
  }

  function renderSearchResults() {
    el.searchResults.innerHTML = '';
    var frag = document.createDocumentFragment();

    state.search.results.forEach(function (r, i) {
      var li = document.createElement('li');
      li.className = 'search-item';
      li.setAttribute('data-i', String(i));

      var caption = document.createElement('div');
      caption.className = 'search-item-chapter';
      caption.textContent = r.chapterTitle;

      var snippet = document.createElement('div');
      snippet.className = 'search-item-snippet';
      snippet.innerHTML = Search.renderHighlightedHtml(r.snippet, [[r.hitStart, r.hitEnd]]);

      li.appendChild(caption);
      li.appendChild(snippet);
      frag.appendChild(li);
    });

    el.searchResults.appendChild(frag);
  }

  function markResultActive(index) {
    var items = el.searchResults.querySelectorAll('.search-item');
    for (var i = 0; i < items.length; i++) {
      if (i === index) {
        items[i].classList.add('active');
        if (items[i].scrollIntoView) items[i].scrollIntoView({ block: 'nearest' });
      } else {
        items[i].classList.remove('active');
      }
    }
  }

  function gotoResult(index) {
    var results = state.search.results;
    if (!results || !results.length) return;

    var i = ((index % results.length) + results.length) % results.length;
    var hit = results[i];
    state.search.index = i;

    renderChapter(hit.chapterIndex, hit.offset);
    decorateChapter();
    markCurrentHit(hit.offset);
    markResultActive(i);
  }

  function stepResult(delta) {
    if (!state.search.results.length) return;
    gotoResult(state.search.index + delta);
  }

  /** 当前章节的全部搜索命中区间（章节内坐标）。 */
  function chapterHits() {
    var query = state.search.query;
    if (!query || !state.book) return [];
    var chapter = state.book.chapters[state.chapterIndex];
    return chapter ? Search.highlightRanges(chapter.text, query) : [];
  }

  /** 当前章节的全部标注。 */
  function chapterDecorations() {
    return state.annotations.filter(function (a) {
      return a.chapterIndex === state.chapterIndex;
    });
  }

  /**
   * 重画当前章节正文：划线（外层）与搜索命中（内层）一起处理。
   * 幂等 —— 每次都先读 textContent 再重写，反复调用不会层层叠加标签。
   */
  function decorateChapter() {
    if (!state.book || !el.content) return;

    var hits = chapterHits();
    var decorations = chapterDecorations();
    var nodes = el.content.querySelectorAll('[data-off]');

    for (var i = 0; i < nodes.length; i++) {
      var base = Number(nodes[i].getAttribute('data-off'));
      var text = nodes[i].textContent;
      nodes[i].innerHTML = Decorate.renderDecoratedHtml(text, base, decorations, hits);
    }
  }

  /** 把「当前这一处」的高亮标成更显眼的颜色，方便在长章节里一眼找到。 */
  function markCurrentHit(offset) {
    var marks = el.content.querySelectorAll('mark.hit');
    for (var i = 0; i < marks.length; i++) marks[i].classList.remove('current');

    var nodes = el.content.querySelectorAll('[data-off]');
    var target = null;
    var local = 0;

    for (var j = 0; j < nodes.length; j++) {
      var start = Number(nodes[j].getAttribute('data-off'));
      var length = nodes[j].textContent.length;
      if (start <= offset && offset < start + length) {
        target = nodes[j];
        local = offset - start;
        break;
      }
    }
    if (!target) return;

    var walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT, null);
    var acc = 0;
    var node;
    while ((node = walker.nextNode())) {
      var len = node.nodeValue.length;
      if (local >= acc && local < acc + len) {
        var parent = node.parentElement;
        if (parent && parent.tagName === 'MARK' && parent.classList.contains('hit')) {
          parent.classList.add('current');
        }
        return;
      }
      acc += len;
    }
  }

  function resetSearch() {
    state.search = { query: '', results: [], index: -1 };
    if (state.searchTimer) {
      clearTimeout(state.searchTimer);
      state.searchTimer = null;
    }
    el.searchInput.value = '';
    el.searchResults.innerHTML = '';
    el.searchCount.textContent = '输入关键词，在整本书里搜索。';
    hideToolbar();
    closeNoteEditor();
    closeSearchPanel();
  }

  /* ---------------- 划线 · 批注 ---------------- */

  function colorLabel(color) {
    return Exporter.colorLabel(color);
  }

  function chapterTitleOf(index) {
    var chapter = state.book && state.book.chapters[index];
    return chapter ? chapter.title : '';
  }

  /** 从选区里的任意节点向上找到它所在的段落（带 data-off 的元素）。 */
  function paragraphOf(node) {
    var element = node && node.nodeType === 1 ? node : (node && node.parentElement);
    if (!element || !element.closest) return null;
    return element.closest('[data-off]');
  }

  /** 段落内某个文本节点位置对应的偏移（段落局部坐标）。 */
  function offsetInParagraph(paragraph, node, offsetInNode) {
    var walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT, null);
    var acc = 0;
    var current;
    while ((current = walker.nextNode())) {
      if (current === node) return acc + offsetInNode;
      acc += current.nodeValue.length;
    }
    return acc;
  }

  /**
   * 把浏览器选区翻译成「章节内起止偏移」——与进度、标注共用的坐标系。
   * 支持跨段落选择：起点取起始段落、终点取结束段落。
   */
  function currentSelection() {
    var selection = window.getSelection ? window.getSelection() : null;
    if (!selection || selection.isCollapsed || !selection.rangeCount) return null;

    var range = selection.getRangeAt(0);
    if (!el.content.contains(range.startContainer) || !el.content.contains(range.endContainer)) return null;

    var startParagraph = paragraphOf(range.startContainer);
    var endParagraph = paragraphOf(range.endContainer);
    if (!startParagraph || !endParagraph) return null;

    var start = Number(startParagraph.getAttribute('data-off')) +
      offsetInParagraph(startParagraph, range.startContainer, range.startOffset);
    var end = Number(endParagraph.getAttribute('data-off')) +
      offsetInParagraph(endParagraph, range.endContainer, range.endOffset);

    if (!isFinite(start) || !isFinite(end) || end <= start) return null;

    return {
      chapterIndex: state.chapterIndex,
      start: start,
      end: end,
      // 跨段落时会有换行，统一压成空格，导出到 Markdown 才不会断行
      text: selection.toString().replace(/\s+/g, ' ').trim(),
      rect: range.getBoundingClientRect()
    };
  }

  function clearSelection() {
    var selection = window.getSelection ? window.getSelection() : null;
    if (selection && selection.removeAllRanges) selection.removeAllRanges();
  }

  function showToolbar(rect) {
    el.hlToolbar.hidden = false;
    var width = el.hlToolbar.offsetWidth || 240;
    var height = el.hlToolbar.offsetHeight || 34;

    var left = rect.left + rect.width / 2 - width / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));

    var top = rect.top - height - 8;
    if (top < 8) top = rect.bottom + 8;

    el.hlToolbar.style.left = Math.round(left) + 'px';
    el.hlToolbar.style.top = Math.round(top) + 'px';
  }

  function hideToolbar() {
    el.hlToolbar.hidden = true;
    state.selection = null;
  }

  /** 选区变化后刷新工具条：有有效选区就显示，否则收起。 */
  function refreshSelection() {
    if (el.readerScreen.hidden || !state.book) return;

    var selection = currentSelection();
    state.selection = selection;

    if (!selection || selection.text.length < 1) {
      hideToolbar();
      return;
    }
    showToolbar(selection.rect);
  }

  function createAnnotation(color, openEditor) {
    var selection = state.selection || currentSelection();
    if (!selection || !state.meta) return;

    var result = annotationStore.add({
      bookKey: state.meta.key,
      chapterIndex: selection.chapterIndex,
      start: selection.start,
      end: selection.end,
      text: selection.text,
      color: color
    });

    if (!result.ok) {
      if (result.reason === 'overlap') toast('这段和已有划线重叠了，先把那条删掉');
      else if (result.reason === 'storage') toast('保存失败：浏览器存储空间不足');
      else toast('划线失败：选区无效');
      return;
    }

    state.annotations = annotationStore.list(state.meta.key);
    decorateChapter();
    renderNotesPanel();
    hideToolbar();
    clearSelection();

    if (openEditor) openNoteEditor(result.record, selection.rect);
    else toast('已划线 · ' + colorLabel(color) + '（右侧「笔记」可查看）');
  }

  /** 只隐藏弹层，不碰输入框内容（供「保存」「删除」之后收尾使用）。 */
  function hideNoteEditor() {
    el.notePopover.hidden = true;
    state.editingId = '';
  }

  /**
   * 关闭批注弹层。若输入框内容有改动则先自动保存。
   *
   * 为什么要自动保存：点「关闭」和点面板外部都会走到这里，而用户刚打的字
   * 如果被静默丢掉，是比多点一次按钮严重得多的问题。
   */
  function closeNoteEditor() {
    if (el.notePopover.hidden) return;

    var id = state.editingId;
    var typed = el.noteInput.value;

    if (id) {
      var record = annotationStore.get(id);
      // 只有真的改过才写，避免每次关闭都产生一次无意义的存储写入
      if (record && String(record.note || '') !== typed) {
        var result = annotationStore.updateNote(id, typed);
        if (result.ok) {
          state.annotations = annotationStore.list(state.meta.key);
          refreshNoteMark(id, !!typed);
          renderNotesPanel();
        } else if (result.reason === 'storage') {
          toast('批注未能保存：浏览器存储空间不足');
        }
      }
    }

    hideNoteEditor();
  }

  /**
   * 只更新某条划线的「有批注」小标，不整章重渲染。
   * 关闭弹层是由 mousedown 触发的，此刻重渲染会把用户正在拖选的内容清掉。
   */
  function refreshNoteMark(id, hasNote) {
    var marks = el.content.querySelectorAll('mark.hl');
    for (var i = 0; i < marks.length; i++) {
      if (marks[i].getAttribute('data-id') !== id) continue;
      marks[i].classList.toggle('with-note', hasNote);
    }
  }

  function openNoteEditor(record, rect) {
    if (!record) return;
    state.editingId = record.id;
    el.noteQuote.textContent = record.text || '（未记录原文）';
    el.noteInput.value = record.note || '';
    el.notePopover.hidden = false;
    positionNoteEditor(rect);
    el.noteInput.focus();
  }

  function positionNoteEditor(rect) {
    var width = el.notePopover.offsetWidth || 320;
    var height = el.notePopover.offsetHeight || 190;

    var anchor = rect || {
      left: window.innerWidth / 2 - 40,
      right: window.innerWidth / 2 + 40,
      top: window.innerHeight / 3,
      bottom: window.innerHeight / 3 + 20,
      width: 80
    };

    var left = anchor.left + anchor.width / 2 - width / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));

    var top = anchor.bottom + 10;
    if (top + height > window.innerHeight - 8) top = Math.max(8, anchor.top - height - 10);

    el.notePopover.style.left = Math.round(left) + 'px';
    el.notePopover.style.top = Math.round(top) + 'px';
  }

  function saveNote() {
    if (!state.editingId) return;

    var result = annotationStore.updateNote(state.editingId, el.noteInput.value);
    if (!result.ok) {
      toast(result.reason === 'storage' ? '保存失败：浏览器存储空间不足' : '这条划线已不存在');
      return;
    }

    state.annotations = annotationStore.list(state.meta.key);
    decorateChapter();
    renderNotesPanel();
    hideNoteEditor();
    toast(result.record.note ? '批注已保存' : '已清空批注');
  }

  function deleteEditingAnnotation() {
    if (!state.editingId) return;

    if (!annotationStore.remove(state.editingId)) {
      toast('删除失败：这条划线已不存在');
      return;
    }

    state.annotations = annotationStore.list(state.meta.key);
    decorateChapter();
    renderNotesPanel();
    hideNoteEditor();
    toast('已删除这条划线');
  }

  function cycleEditingColor() {
    var record = annotationStore.get(state.editingId);
    if (!record) return;

    var next = Annotations.COLORS[(Annotations.COLORS.indexOf(record.color) + 1) % Annotations.COLORS.length];
    var result = annotationStore.updateColor(state.editingId, next);
    if (!result.ok) { toast('换颜色失败'); return; }

    state.annotations = annotationStore.list(state.meta.key);
    decorateChapter();
    renderNotesPanel();
    toast('已换成' + colorLabel(next));
  }

  function openNotesPanel() {
    if (!state.book) return;
    el.notesPanel.hidden = false;
    el.toc.hidden = true;
    closeSearchPanel();
    hideToolbar();
    renderNotesPanel();
  }

  function closeNotesPanel() {
    el.notesPanel.hidden = true;
  }

  function notesPanelOpen() {
    return !el.notesPanel.hidden;
  }

  function renderNotesPanel() {
    var list = state.annotations;

    el.notesCount.textContent = String(list.length);
    el.notesHint.textContent = list.length
      ? '按顺序列出，点一条即可跳到正文位置。'
      : '在正文里选中一段文字，就会出现划线按钮。';

    el.notesList.innerHTML = '';
    if (!list.length) return;

    var frag = document.createDocumentFragment();

    list.forEach(function (item, i) {
      var li = document.createElement('li');
      li.className = 'note-item';
      li.setAttribute('data-id', item.id);

      var head = document.createElement('div');
      head.className = 'note-item-head';

      var dot = document.createElement('span');
      dot.className = 'note-dot hl-' + item.color;

      var chapter = document.createElement('span');
      chapter.className = 'note-item-chapter';
      chapter.textContent = chapterTitleOf(item.chapterIndex) || ('第 ' + (item.chapterIndex + 1) + ' 节');

      var order = document.createElement('span');
      order.className = 'note-index';
      order.textContent = '#' + (i + 1);

      head.appendChild(dot);
      head.appendChild(chapter);
      head.appendChild(order);

      var quote = document.createElement('div');
      quote.className = 'note-item-quote';
      quote.textContent = item.text || '（未记录原文）';

      li.appendChild(head);
      li.appendChild(quote);

      if (item.note) {
        var note = document.createElement('div');
        note.className = 'note-item-note';
        note.textContent = item.note;
        li.appendChild(note);
      }

      frag.appendChild(li);
    });

    el.notesList.appendChild(frag);
  }

  function jumpToAnnotation(id) {
    var record = annotationStore.get(id);
    if (!record || !state.book) return;

    renderChapter(record.chapterIndex, record.start);

    var node = el.content.querySelector('mark.hl[data-id="' + record.id + '"]');
    if (node) {
      node.classList.add('flash');
      setTimeout(function () { node.classList.remove('flash'); }, 1200);
    }
  }

  function exportMarkdown() {
    if (!state.book || !state.meta) return;

    if (!state.annotations.length) {
      toast('还没有划线，先在正文里选一段文字');
      return;
    }

    var markdown = Exporter.toMarkdown(state.book, state.annotations, {
      now: Date.now(),
      sourceName: state.meta.name
    });

    var fileName = Exporter.sanitizeFileName(state.meta.title || state.meta.name) + '-笔记.md';
    var blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');

    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);

    toast('已导出 ' + state.annotations.length + ' 条到「' + fileName + '」');
  }

  function scheduleSave() {
    if (state.saveTimer) clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(flushSave, SAVE_DEBOUNCE_MS);
  }

  function flushSave() {
    if (state.saveTimer) {
      clearTimeout(state.saveTimer);
      state.saveTimer = null;
    }
    if (!state.book || !state.meta) return;
    try {
      store.save(Progress.makeRecord(state.book, state.meta, state.chapterIndex, currentOffset()));
    } catch (err) { /* 存储失败不应打断阅读 */ }
  }

  function goChapter(delta) {
    if (!state.book) return;
    var target = state.chapterIndex + delta;
    if (target < 0 || target >= state.book.chapters.length) return;
    renderChapter(target, 0);
  }

  /**
   * 改字号 / 行距 / 页宽后重新排版，并把阅读位置钉回原来的那一处。
   *
   * 关键点：先取 anchor（当前阅读位置的字符偏移），再改样式，
   * 等下一帧浏览器完成重排后按 anchor 重新切页 / 定位。
   * 这样无论排版参数怎么变，读者看到的都还是同一段话。
   */
  function relayout(anchor) {
    if (!state.book) return;
    if (isPaged()) {
      requestAnimationFrame(function () {
        repaginate(anchor);
        updatePageIndicator();
      });
    } else {
      requestAnimationFrame(function () {
        positionAt(anchor);
        updateProgressDisplay();
      });
    }
  }

  /** 在某个档位表里上/下走一格，并返回新值。 */
  function stepIn(steps, current, fallback, delta) {
    var idx = nearestStepIndex(steps, current, fallback);
    return steps[Math.max(0, Math.min(idx + delta, steps.length - 1))];
  }

  /** 本书是否正在使用独立排版（用于提示语里加「仅本书」）。 */
  function perBookSuffix() {
    return state.meta ? '（仅本书）' : '';
  }

  function stepFont(delta) {
    var current = Number(currentTypo().fontSize) || DEFAULT_FONT_SIZE;
    var next = FONT_STEPS[Math.max(0, Math.min(nearestFontIndex(current) + delta, FONT_STEPS.length - 1))];
    if (next === current) {
      toast('已到字号极限');
      return;
    }
    var anchor = currentOffset();
    applyFontSize(next);
    // 字号变了，一屏能放的字也变了，必须重新切页
    relayout(anchor);
    toast('字号 ' + next + 'px' + perBookSuffix());
  }

  function stepLineHeight(delta) {
    var current = Number(currentTypo().lineHeight) || DEFAULT_LINE_HEIGHT;
    var next = stepIn(LINE_STEPS, current, DEFAULT_LINE_HEIGHT, delta);
    if (next === current) {
      toast('已到行距极限');
      return;
    }
    var anchor = currentOffset();
    applyLineHeight(next);
    relayout(anchor);
    toast('行距 ' + next + perBookSuffix());
  }

  function stepPageWidth(delta) {
    var current = Number(currentTypo().pageWidth) || DEFAULT_PAGE_WIDTH;
    var next = stepIn(WIDTH_STEPS, current, DEFAULT_PAGE_WIDTH, delta);
    if (next === current) {
      toast('已到页宽极限');
      return;
    }
    var anchor = currentOffset();
    applyPageWidth(next);
    relayout(anchor);
    toast((isPaged() ? '页宽 ' + next + ' 字' : '页宽 ' + next + 'em（切到分页模式更明显）') + perBookSuffix());
  }

  /** 丢弃本书的独立排版，让它重新跟随全局设置。 */
  function resetBookTypo() {
    if (!state.meta) {
      toast('打开书后才能调整该书的排版');
      return;
    }
    if (!ReadingPrefs.isCustomized(loadPrefs(), state.meta.key)) {
      toast('本书已经是默认排版');
      return;
    }
    var next = ReadingPrefs.resetBook(loadPrefs(), state.meta.key);
    try { storage.setItem(PREFS_KEY, JSON.stringify(next)); } catch (err) { /* 忽略写入失败 */ }
    var anchor = currentOffset();
    applyBookTypo();
    relayout(anchor);
    toast('已恢复默认排版');
  }

  /** 单页 ⇄ 双页对开；首次手动切换会锁定选择，不再随屏幕宽度自动变。 */
  function toggleSpread() {
    if (!state.book) {
      // 还没打开书也允许切，偏好会记住
      state.spreadUserPref = !baseSpread();
      savePrefs({ spread: state.spreadUserPref });
      applySpreadChrome();
      return;
    }
    var anchor = currentOffset();
    state.spreadUserPref = !baseSpread();
    savePrefs({ spread: state.spreadUserPref });
    applySpreadChrome();
    repaginate(anchor);
    toast(state.spreadUserPref ? '已切换为双页对开' : '已切回单页');
  }

  /**
   * 根据当前对开状态刷新 UI：body 标记、切换按钮文案、隐藏/恢复「页宽」按钮。
   * 双页下「页宽」按钮无意义（每页宽度由容器自动决定），故隐藏。
   */
  function applySpreadChrome() {
    var on = baseSpread();
    document.body.setAttribute('data-spread', on ? 'on' : 'off');
    if (el.spreadBtn) {
      el.spreadBtn.hidden = !isPaged();
      el.spreadBtn.textContent = on ? '双页' : '单页';
      el.spreadBtn.title = on ? '当前双页对开，点击切回单页' : '当前单页，点击切换为双页对开';
      el.spreadBtn.classList.toggle('active', on);
    }
    var hideWidth = isPaged() && on;
    if (el.widthUpBtn) el.widthUpBtn.hidden = hideWidth;
    if (el.widthDownBtn) el.widthDownBtn.hidden = hideWidth;
  }

  /** 滚动 ⇄ 分页。切换时必须保住阅读位置。 */
  function toggleReadingMode() {
    if (!state.book) {
      // 还没打开书也允许切，偏好会记住
      var value = isPaged() ? MODE_SCROLL : MODE_PAGED;
      applyReadingMode(value);
      toast(value === MODE_PAGED ? '已切到分页模式' : '已切回滚动模式');
      return;
    }

    var anchor = currentOffset();
    var next = isPaged() ? MODE_SCROLL : MODE_PAGED;

    applyReadingMode(next);

    if (next === MODE_PAGED) {
      // 从滚动切到分页：清掉滚动带来的残留，再按锚点切页
      state.pages = [];
      state.pageIndex = 0;
      el.content.scrollTop = 0;
      requestAnimationFrame(function () {
        repaginate(anchor);
        updatePageIndicator();
      });
      toast('已切到分页模式：← → 翻页，PageUp / PageDown 也可以');
    } else {
      // 从分页切回滚动：整章重新渲染，再滚到锚点
      requestAnimationFrame(function () {
        renderChapter(state.chapterIndex, anchor);
      });
      toast('已切回滚动模式');
    }
    applySpreadChrome();
  }

  /* ---------------- 事件绑定 ---------------- */

  function onKeyDown(event) {
    // PDF 视图自己一套快捷键，优先处理，别被正文阅读器的逻辑截走
    if (onPdfKeyDown(event)) {
      event.preventDefault();
      return;
    }

    if (el.readerScreen.hidden || !state.book) return;

    // 焦点在输入框 / 文本域里时，一律不接管按键。
    // 否则在搜索框里按左右键会顺手翻章，在批注框里打空格会翻页。
    var target = event.target;
    var tag = target && target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' ||
        (target && target.isContentEditable)) {
      return;
    }

    // Ctrl/Cmd + F 打开搜索（覆盖浏览器自带查找，否则会跟本页搜索抢焦点）
    if ((event.ctrlKey || event.metaKey) && (event.key === 'f' || event.key === 'F')) {
      event.preventDefault();
      openSearchPanel();
      return;
    }

    // Ctrl/Cmd + M 打开笔记面板
    if ((event.ctrlKey || event.metaKey) && (event.key === 'm' || event.key === 'M')) {
      event.preventDefault();
      if (notesPanelOpen()) closeNotesPanel();
      else openNotesPanel();
      return;
    }

    // 进度条获得焦点时，左右键做精细跳转而不是翻章
    if (event.target === el.progressBar) {
      var span = Math.max(1, Math.round((state.book.totalChars || 1) * 0.01));
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        seekByChars(event.key === 'ArrowLeft' ? -span : span);
        return;
      }
      if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        var pos = Progress.resolveGlobalOffset(state.book, event.key === 'Home' ? 0 : (state.book.totalChars || 1) - 1);
        renderChapter(pos.chapterIndex, pos.charOffset);
        return;
      }
    }

    switch (event.key) {
      case 'ArrowLeft':
        // 分页模式左键 = 上一页；滚动模式保留原来的「上一章」
        if (isPaged()) stepPage(-1);
        else goChapter(-1);
        break;
      case 'ArrowRight':
        if (isPaged()) stepPage(1);
        else goChapter(1);
        break;
      case 'PageDown':
      case ' ':
        // stepPage 在滚动模式下会自己退化成「滚一屏」
        stepPage(1);
        break;
      case 'PageUp':
        stepPage(-1);
        break;
      case 'Home':
        if (isPaged()) gotoPageEdge('start');
        else el.content.scrollTop = 0;
        break;
      case 'End':
        if (isPaged()) gotoPageEdge('end');
        else el.content.scrollTop = el.content.scrollHeight;
        break;
        // 一次 Esc 只关一层：批注弹层 → 划线工具条 → 搜索面板 → 笔记面板 → 目录
        if (!el.notePopover.hidden) closeNoteEditor();
        else if (!el.hlToolbar.hidden) { hideToolbar(); clearSelection(); }
        else if (searchPanelOpen()) closeSearchPanel();
        else if (notesPanelOpen()) closeNotesPanel();
        else el.toc.hidden = true;
        return;
      default:
        return;
    }

    event.preventDefault();
    updateProgressDisplay();
    scheduleSave();
  }

  function bindEvents() {
    if (el.openFileBtn) {
      el.openFileBtn.addEventListener('click', pickFile);
    }
    if (el.emptyAddBtn) {
      el.emptyAddBtn.addEventListener('click', pickFile);
    }

    el.fileInput.addEventListener('change', function () {
      var file = el.fileInput.files && el.fileInput.files[0];
      if (file) openFile(file, null);
    });

    el.shelfGrid.addEventListener('click', onShelfClick);

    el.clearAll.addEventListener('click', function () {
      if (bookCache) bookCache.clear().catch(function () {});
      store.clear();
      annotationStore.clear();
      renderShelf();
      toast('已清空全部书籍、阅读记录与划线');
    });

    el.updateClose.addEventListener('click', hideUpdateBar);
    el.updateSkip.addEventListener('click', function () {
      if (state.updateVersion) savePrefs({ skipUpdateVersion: state.updateVersion });
      hideUpdateBar();
      toast('已忽略 ' + state.updateVersion + '，以后不再提示');
    });
    // 界面里所有外部链接统一处理：桌面壳里 <a target="_blank"> 打不开系统浏览器，
    // 得交给 Tauri 的 open_url；网页版走浏览器默认行为（新标签页）。
    // 用一处委托而不是逐个绑，免得以后新加链接又漏掉。
    document.addEventListener('click', function (event) {
      var link = event.target && event.target.closest ? event.target.closest('a[href^="http"]') : null;
      if (!link) return;
      if (!(TauriBridge.isTauri && TauriBridge.isTauri())) return;
      event.preventDefault();
      TauriBridge.openExternal(link.href).then(function (ok) {
        if (!ok) toast('打不开浏览器，请手动访问：' + link.href);
      });
    });

    // 顶部菜单：检查更新 / 关于 / 帮助
    function closeMenu() {
      el.appMenu.hidden = true;
      el.menuBtn.setAttribute('aria-expanded', 'false');
    }
    el.menuBtn.addEventListener('click', function (event) {
      event.stopPropagation();
      var open = el.appMenu.hidden;
      el.appMenu.hidden = !open;
      el.menuBtn.setAttribute('aria-expanded', String(open));
    });
    el.appMenu.addEventListener('click', function (event) {
      var item = event.target.closest('[data-action]');
      if (!item) return;
      var action = item.getAttribute('data-action');
      closeMenu();
      if (action === 'check') checkForUpdate(true);
      else if (action === 'about') openModal(el.aboutModal);
      else if (action === 'help') openModal(el.helpModal);
    });
    document.addEventListener('click', function (event) {
      if (!el.appMenu.hidden && !event.target.closest('.menu-wrap')) closeMenu();
    });

    // 阅读器「Aa」排版面板：与书架菜单同款交互（点击切换、点外面关、Esc 关）
    function closeTypoPanel() {
      if (!el.typoPanel) return;
      el.typoPanel.hidden = true;
      if (el.typoBtn) el.typoBtn.setAttribute('aria-expanded', 'false');
    }
    if (el.typoBtn && el.typoPanel) {
      el.typoBtn.addEventListener('click', function (event) {
        event.stopPropagation();
        var open = el.typoPanel.hidden;
        el.typoPanel.hidden = !open;
        el.typoBtn.setAttribute('aria-expanded', String(open));
        if (open) syncTypoTips(); // 打开时才回显当前值
      });
    }
    document.addEventListener('click', function (event) {
      if (el.typoPanel && !el.typoPanel.hidden && !event.target.closest('#typo-wrap')) closeTypoPanel();
    });

    // 关于 / 帮助 弹窗
    function openModal(modal) { modal.hidden = false; }
    function closeModal(modal) { modal.hidden = true; }
    [el.aboutModal, el.helpModal].forEach(function (modal) {
      modal.addEventListener('click', function (event) {
        if (event.target.hasAttribute('data-close') ||
            event.target.classList.contains('modal-backdrop')) {
          closeModal(modal);
        }
      });
    });
    el.aboutCheck.addEventListener('click', function () { closeModal(el.aboutModal); checkForUpdate(true); });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        if (!el.appMenu.hidden) closeMenu();
        else if (el.typoPanel && !el.typoPanel.hidden) closeTypoPanel();
        else if (!el.aboutModal.hidden) closeModal(el.aboutModal);
        else if (!el.helpModal.hidden) closeModal(el.helpModal);
      }
    });

    if (el.themeBtn2) {
      el.themeBtn2.addEventListener('click', function () {
        var next = document.body.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        applyTheme(next);
        toast(next === 'dark' ? '已切换到夜间模式' : '已切换到日间模式');
      });
    }

    el.backBtn.addEventListener('click', backToShelf);
    el.prevBtn.addEventListener('click', function () { goChapter(-1); });
    el.nextBtn.addEventListener('click', function () { goChapter(1); });

    el.tocBtn.addEventListener('click', function () {
      el.toc.hidden = !el.toc.hidden;
      if (!el.toc.hidden) {
        closeSearchPanel();
        closeNotesPanel();
        hideToolbar();
      }
    });
    el.tocCloseBtn.addEventListener('click', function () { el.toc.hidden = true; });

    el.tocList.addEventListener('click', function (event) {
      var li = event.target.closest ? event.target.closest('li[data-index]') : null;
      if (!li) return;
      renderChapter(Number(li.getAttribute('data-index')), 0);
      el.toc.hidden = true;
      el.content.focus();
    });

    el.fontUpBtn.addEventListener('click', function () { stepFont(1); });
    el.fontDownBtn.addEventListener('click', function () { stepFont(-1); });
    el.lineUpBtn.addEventListener('click', function () { stepLineHeight(1); });
    el.lineDownBtn.addEventListener('click', function () { stepLineHeight(-1); });
    el.widthUpBtn.addEventListener('click', function () { stepPageWidth(1); });
    el.widthDownBtn.addEventListener('click', function () { stepPageWidth(-1); });
    if (el.typoResetBtn) el.typoResetBtn.addEventListener('click', resetBookTypo);
    el.modeBtn.addEventListener('click', toggleReadingMode);
    if (el.spreadBtn) el.spreadBtn.addEventListener('click', toggleSpread);
    el.themeBtn.addEventListener('click', function () {
      var next = document.body.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      toast(next === 'dark' ? '已切换到夜间模式' : '已切换到日间模式');
    });

    el.content.addEventListener('scroll', function () {
      // 分页模式下内容不滚动，这个监听只在滚动模式下有意义
      if (isPaged()) return;
      hideToolbar();
      updateProgressDisplay();
      scheduleSave();
    });

    // 分页模式的翻页热区（左右两侧边缘）
    if (el.pagePrevBtn) el.pagePrevBtn.addEventListener('click', function () { stepPage(-1); el.content.focus(); });
    if (el.pageNextBtn) el.pageNextBtn.addEventListener('click', function () { stepPage(1); el.content.focus(); });

    /* 进度条：按下拖动预览，松手跳转 */
    el.progressBar.addEventListener('pointerdown', function (event) {
      if (!state.book) return;
      state.dragging = true;
      el.progressBar.classList.add('dragging');
      if (el.progressBar.setPointerCapture) {
        try { el.progressBar.setPointerCapture(event.pointerId); } catch (err) { /* 忽略 */ }
      }
      previewSeek(ratioFromPointer(event));
      event.preventDefault();
    });

    el.progressBar.addEventListener('pointermove', function (event) {
      if (!state.dragging) return;
      previewSeek(ratioFromPointer(event));
    });

    function endDrag(event) {
      if (!state.dragging) return;
      state.dragging = false;
      el.progressBar.classList.remove('dragging');
      if (el.progressBar.releasePointerCapture && event && event.pointerId != null) {
        try { el.progressBar.releasePointerCapture(event.pointerId); } catch (err) { /* 忽略 */ }
      }
      commitSeek(ratioFromPointer(event));
    }

    el.progressBar.addEventListener('pointerup', endDrag);
    el.progressBar.addEventListener('pointercancel', endDrag);

    /* 搜索 */
    el.searchBtn.addEventListener('click', function () {
      if (searchPanelOpen()) closeSearchPanel();
      else openSearchPanel();
    });
    el.searchCloseBtn.addEventListener('click', function () {
      closeSearchPanel();
      el.content.focus();
    });

    el.searchInput.addEventListener('input', function () {
      if (state.searchTimer) clearTimeout(state.searchTimer);
      var value = el.searchInput.value;
      state.searchTimer = setTimeout(function () { runSearch(value); }, SEARCH_DEBOUNCE_MS);
    });

    el.searchInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        stepResult(event.shiftKey ? -1 : 1);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        closeSearchPanel();
        el.content.focus();
      }
    });

    el.searchPrevBtn.addEventListener('click', function () { stepResult(-1); });
    el.searchNextBtn.addEventListener('click', function () { stepResult(1); });

    el.searchResults.addEventListener('click', function (event) {
      var li = event.target.closest ? event.target.closest('.search-item') : null;
      if (!li) return;
      gotoResult(Number(li.getAttribute('data-i')));
    });

    /* 划线工具条 */
    // 按下时阻止默认行为，否则点按钮的瞬间选区就没了
    el.hlToolbar.addEventListener('mousedown', function (event) { event.preventDefault(); });

    el.hlToolbar.addEventListener('click', function (event) {
      var swatch = event.target.closest ? event.target.closest('.hl-swatch') : null;
      if (swatch) {
        createAnnotation(swatch.getAttribute('data-color'), false);
      }
    });

    el.hlAddNoteBtn.addEventListener('click', function () { createAnnotation('yellow', true); });
    el.hlCancelBtn.addEventListener('click', function () { hideToolbar(); clearSelection(); });

    document.addEventListener('mouseup', function (event) {
      if (el.readerScreen.hidden) return;
      if (el.hlToolbar.contains(event.target)) return;
      // 等浏览器把选区更新完再读，否则拿到的是上一轮的选区
      setTimeout(refreshSelection, 0);
    });

    document.addEventListener('keyup', function (event) {
      if (el.readerScreen.hidden) return;
      if (event.key === 'Shift' || event.key.indexOf('Arrow') === 0) setTimeout(refreshSelection, 0);
    });

    /* 点击已有划线 → 打开批注编辑 */
    el.content.addEventListener('click', function (event) {
      var mark = event.target.closest ? event.target.closest('mark.hl') : null;
      if (!mark) return;

      var record = annotationStore.get(mark.getAttribute('data-id'));
      if (!record) return;

      hideToolbar();
      openNoteEditor(record, mark.getBoundingClientRect());
    });

    /* 批注编辑弹层 */
    el.noteSaveBtn.addEventListener('click', saveNote);
    el.noteDeleteBtn.addEventListener('click', deleteEditingAnnotation);
    el.noteColorBtn.addEventListener('click', cycleEditingColor);
    el.noteCloseBtn.addEventListener('click', closeNoteEditor);

    el.noteInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        saveNote();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        closeNoteEditor();
      }
    });

    /* 笔记面板 */
    el.notesBtn.addEventListener('click', function () {
      if (notesPanelOpen()) closeNotesPanel();
      else openNotesPanel();
    });
    el.notesCloseBtn.addEventListener('click', closeNotesPanel);
    el.exportBtn.addEventListener('click', exportMarkdown);

    el.notesList.addEventListener('click', function (event) {
      var li = event.target.closest ? event.target.closest('.note-item') : null;
      if (!li) return;
      jumpToAnnotation(li.getAttribute('data-id'));
    });

    /* 点击面板外部自动关闭：目录 / 搜索 / 笔记 / 批注弹层。
       触发按钮本身不算「外部」——否则按钮的 mousedown 先关面板、click 再把它打开，等于永远关不掉。 */
    document.addEventListener('mousedown', function (event) {
      if (el.readerScreen.hidden) return;
      var target = event.target;

      if (!el.notePopover.hidden && !el.notePopover.contains(target)) {
        closeNoteEditor();
      }
      if (!el.toc.hidden && !el.toc.contains(target) && !el.tocBtn.contains(target)) {
        el.toc.hidden = true;
      }
      if (searchPanelOpen() && !el.searchPanel.contains(target) && !el.searchBtn.contains(target)) {
        closeSearchPanel();
      }
      if (notesPanelOpen() && !el.notesPanel.contains(target) && !el.notesBtn.contains(target)) {
        closeNotesPanel();
      }
    });

    /* PDF 视图 */
    el.pdfBack.addEventListener('click', closePdf);
    el.pdfPrevBtn.addEventListener('click', function () { gotoPdfPage(pdfState.page - 1); });
    el.pdfNextBtn.addEventListener('click', function () { gotoPdfPage(pdfState.page + 1); });
    el.pdfPageInput.addEventListener('change', function () {
      gotoPdfPage(parseInt(el.pdfPageInput.value, 10) || 1);
    });
    el.pdfRange.addEventListener('input', function () {
      gotoPdfPage(parseInt(el.pdfRange.value, 10) || 1);
    });
    el.pdfZoomIn.addEventListener('click', function () { stepPdfZoom(1); });
    el.pdfZoomOut.addEventListener('click', function () { stepPdfZoom(-1); });
    el.pdfFit.addEventListener('click', togglePdfFit);
    el.pdfTheme.addEventListener('click', function () { el.themeBtn.click(); });

    document.addEventListener('keydown', onKeyDown);

    // 窗口大小变了，一屏能放的字也变了 —— 分页模式下必须重新切页，
    // 否则会把内容裁掉或留一大片空白。滚动模式不用管，浏览器自己会重排。
    window.addEventListener('resize', function () {
      if (state.resizeTimer) clearTimeout(state.resizeTimer);
      state.resizeTimer = setTimeout(function () {
        if (state.book && isPaged()) {
          // 跟随屏幕宽度：用户没手动锁定时，宽度跨过阈值会自动切单/双页
          applySpreadChrome();
          repaginate(currentOffset());
        }
        // PDF：适应模式下缩放比随窗口变，要按新尺寸重画当前页
        if (pdfScreenOpen() && pdfState.fit !== 'manual') renderPdfPage();
      }, 160);
    });
    window.addEventListener('beforeunload', function () {
      flushSave();
      savePdfProgress();
    });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') flushSave();
    });
  }

  function cacheElements() {
    el.shelfScreen = $('shelf-screen');
    el.readerScreen = $('reader-screen');
    el.openFileBtn = $('btn-open-file');
    el.fileInput = $('file-input');
    el.shelfGrid = $('shelf-grid');
    el.shelfCount = $('shelf-count');
    el.shelfEmpty = $('shelf-empty');
    el.emptyAddBtn = $('btn-empty-add');
    el.clearAll = $('clear-all');

    el.appMenu = $('app-menu');
    el.menuBtn = $('btn-menu');
    el.aboutModal = $('about-modal');
    el.aboutVersion = $('about-version');
    el.aboutCheck = $('about-check');
    el.helpModal = $('help-modal');
    el.themeBtn2 = $('btn-theme-2');

    el.updateBar = $('update-bar');
    el.updateText = $('update-text');
    el.updateGo = $('btn-update-go');
    el.updateSkip = $('btn-update-skip');
    el.updateClose = $('btn-update-close');

    el.readerBookName = $('reader-book-name');
    el.readerChapterName = $('reader-chapter-name');
    el.content = $('reader-content');
    el.readerView = $('reader-view');
    el.pagePrevBtn = $('btn-page-prev');
    el.pageNextBtn = $('btn-page-next');
    el.pageIndicator = $('page-indicator');
    el.toc = $('toc');
    el.tocList = $('toc-list');
    el.tocBtn = $('btn-toc');
    el.tocCloseBtn = $('btn-toc-close');
    el.backBtn = $('btn-back');
    el.prevBtn = $('btn-prev');
    el.nextBtn = $('btn-next');
    el.fontUpBtn = $('btn-font-up');
    el.fontDownBtn = $('btn-font-down');
    el.lineUpBtn = $('btn-line-up');
    el.lineDownBtn = $('btn-line-down');
    el.widthUpBtn = $('btn-width-up');
    el.widthDownBtn = $('btn-width-down');
    el.modeBtn = $('btn-mode');
    el.spreadBtn = $('btn-spread');
    el.themeBtn = $('btn-theme');
    el.typoResetBtn = $('btn-typo-reset');
    el.typoBtn = $('btn-typo');
    el.typoPanel = $('typo-panel');
    el.typoWrap = $('typo-wrap');
    el.typoFontVal = $('typo-font-val');
    el.typoLineVal = $('typo-line-val');
    el.typoWidthVal = $('typo-width-val');
    el.progressBar = $('progress-bar');
    el.progressFill = $('progress-fill');
    el.progressKnob = $('progress-knob');
    el.progressText = $('progress-text');
    el.readerStatus = $('reader-status');

    el.searchBtn = $('btn-search');
    el.searchPanel = $('search-panel');
    el.searchInput = $('search-input');
    el.searchCount = $('search-count');
    el.searchResults = $('search-results');
    el.searchPrevBtn = $('btn-search-prev');
    el.searchNextBtn = $('btn-search-next');
    el.searchCloseBtn = $('btn-search-close');

    el.notesBtn = $('btn-notes');
    el.notesPanel = $('notes-panel');
    el.notesCount = $('notes-count');
    el.notesHint = $('notes-hint');
    el.notesList = $('notes-list');
    el.exportBtn = $('btn-export');
    el.notesCloseBtn = $('btn-notes-close');

    el.hlToolbar = $('hl-toolbar');
    el.hlAddNoteBtn = $('hl-add-note');
    el.hlCancelBtn = $('hl-cancel');

    el.notePopover = $('note-popover');
    el.noteQuote = $('note-quote');
    el.noteInput = $('note-input');
    el.noteSaveBtn = $('note-save');
    el.noteColorBtn = $('note-color');
    el.noteDeleteBtn = $('note-delete');
    el.noteCloseBtn = $('note-close');

    el.pdfScreen = $('pdf-screen');
    el.pdfBookName = $('pdf-book-name');
    el.pdfPageLabel = $('pdf-page-label');
    el.pdfPageInput = $('pdf-page-input');
    el.pdfPrevBtn = $('pdf-prev');
    el.pdfNextBtn = $('pdf-next');
    el.pdfZoomOut = $('pdf-zoom-out');
    el.pdfZoomIn = $('pdf-zoom-in');
    el.pdfZoomVal = $('pdf-zoom-val');
    el.pdfFit = $('pdf-fit');
    el.pdfTheme = $('pdf-theme');
    el.pdfBack = $('pdf-back');
    el.pdfView = $('pdf-view');
    el.pdfCanvas = $('pdf-canvas');
    el.pdfHint = $('pdf-hint');
    el.pdfRange = $('pdf-range');
    el.pdfPct = $('pdf-pct');
    el.pdfStatus = $('pdf-status');

    el.toast = $('toast');
  }

  /* ---------------- 版本更新 ---------------- */

  function hideUpdateBar() { el.updateBar.hidden = true; }

  /**
   * 检查新版本。
   *
   * 刻意**不做**静默下载安装：那需要代码签名证书（每年几百到几千元），
   * 而且未签名的自动更新会被 SmartScreen 和杀软直接拦下，体验反而更差。
   * 这里只做「查到 → 提示 → 用户自己点链接下载」——开源个人项目的通行做法。
   *
   * @param {boolean} manual 手动点击时为 true：此时无论结果如何都要给用户反馈。
   */
  function checkForUpdate(manual) {
    var prefs = loadPrefs();

    if (!Updater.shouldCheck({ lastCheckAt: prefs.lastUpdateCheckAt, now: Date.now(), force: manual })) {
      if (manual) toast('刚刚查过了，稍后再试');
      return;
    }
    savePrefs({ lastUpdateCheckAt: Date.now() });

    Updater.checkUpdate({
      currentVersion: APP_VERSION,
      // GitHub Releases API 匿名可读，不需要 token
      fetchJson: function (url) {
        return fetch(url, { headers: { Accept: 'application/vnd.github+json' } }).then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        });
      }
    }).then(function (result) {
      if (!result.hasUpdate) {
        if (manual) {
          toast(result.reason === 'offline'
            ? '检查更新失败：连不上 GitHub，稍后再试'
            : '已经是最新版本（v' + APP_VERSION + '）');
        }
        return;
      }
      if (prefs.skipUpdateVersion === result.latest.version) return; // 用户之前忽略过这一版

      state.updateVersion = result.latest.version;
      el.updateText.textContent = '有新版本 v' + result.latest.version + '（当前 v' + APP_VERSION + '）';
      if (result.latest.url) el.updateGo.href = result.latest.url;
      el.updateBar.hidden = false;
    });
  }

  function init() {
    cacheElements();
    bindEvents();

    var prefs = loadPrefs();
    // 先定排版参数（字号 → 行距 → 页宽），再定模式与对开：
    // 模式切换会立刻按这些参数切一次页，顺序反了就会用旧尺寸切。
    // 应用全局排版（此时还没打开书，currentBookKey() 为空串，等价于取全局值）。
    // 用 applyBookTypo 而不是逐个 apply*：前者只读不写，不会在启动时凭空固化默认值。
    applyBookTypo();
    applyTheme(prefs.theme || 'light');
    applyReadingMode(prefs.readingMode || MODE_SCROLL);
    // 对开偏好：null = 跟随屏幕宽度自动；true/false = 用户手动锁定
    state.spreadUserPref = (prefs.spread === true || prefs.spread === false) ? prefs.spread : null;
    applySpreadChrome();

    renderShelf();
    if (el.aboutVersion) el.aboutVersion.textContent = '版本 v' + APP_VERSION;
    // 静默检查：一天最多一次，失败也不打扰
    checkForUpdate(false);
    initCache(function () {
      renderShelf();
      if (cacheBackend === 'memory') {
        // 内存后端只在当前会话有效，明确告知，避免用户误以为已记住
        toast('当前环境无法持久保存书籍，关闭页面后需重新选择文件');
      }
    });
  }

  init();
})();
