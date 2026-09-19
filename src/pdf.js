/**
 * PDF 支持层。
 *
 * 分成两块，边界要守：
 *  ① 纯逻辑（isPdfName / syntheticBook / fitScale / clampPage …）：不碰浏览器 API，
 *     可以在 Node 里直接单测。
 *  ② 运行时（动态 import 内置的 pdf.js）：只有 createEngine 及其产物会用到，
 *     加载不到时返回明确的失败原因，绝不抛裸异常。
 *
 * 为什么是「动态 import」而不是 <script> 直接引：
 * pdf.js v4+ 只发布 ESM（.mjs）。经典脚本不能静态 import ESM，而浏览器在
 * file:// 下禁止加载 ES 模块（CORS）。所以现状是：
 *   - 桌面版（Tauri，页面跑在 http://tauri.localhost）：可用；
 *   - 网页版（直接双击 index.html，file://）：不可用，给友好提示，不崩。
 * 与「多格式转换依赖 Calibre」是同一个先例。
 *
 * 为什么「一页 = 一章」：
 * PDF 是固定版式，没有可重排的正文。硬塞进 TXT 那套字符偏移锚点必然错位。
 * 所以这里只借「统一中间格式」的壳（一页一章、start=i / end=i+1），
 * 让进度与书架百分比复用 Progress，阅读视图另起一套（按页渲染），两边互不污染。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.MingScribe = root.MingScribe || {};
    root.MingScribe.Pdf = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VENDOR_DIR = 'src/vendor/pdf/';
  var MODULE_FILE = 'pdf.min.mjs';
  var WORKER_FILE = 'pdf.worker.min.mjs';

  // 缩放档位：从「适应页宽」出发，用 ± 按钮在其中前后跳，避免无限放大/缩小
  var SCALE_STEPS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
  var SCALE_MIN = 0.25;
  var SCALE_MAX = 6;

  // 搜索上限：与可重排正文（src/search.js）用同一组数字。
  // 两处行为不一致会让人困惑 —— 同样的关键词在 TXT 里搜出 300 条、在 PDF 里搜出别的数量。
  var SEARCH_DEFAULTS = {
    maxResults: 300,   // 整本最多返回多少条
    maxPerPage: 30,    // 单页最多返回多少条，避免某页刷屏
    context: 26        // 摘要前后各取多少字
  };

  /**
   * 「这本 PDF 有没有文字层」的判据：整本平均每页抽到的字数。
   *
   * 为什么不用「一个字都抽不到」：扫描件几乎都带页眉 / 页脚 / 页码 / 水印，
   * 只要有一行真文字，「整本零字」这条就永远不成立（实测一本 40 页的图片版书，
   * 每页都抽得到一行页眉 → 被判成「正常 PDF，只是没搜到」）。
   * 用密度判据才既盖得住「纯图片」也盖得住「图片 + 一点页码」。
   *
   * 取 20 而不是更小：正常文档平均每页几百到上千字，离这条线很远；
   * 而「每页只有一行页眉」的扫描件通常在 10~15 字/页，20 能把两边都分开。
   */
  var SCANNED_CHARS_PER_PAGE = 20;

  /** pageCount 页共抽到 totalChars 个字，是不是等于没有文字层。 */
  function isProbablyScanned(pageCount, totalChars) {
    var n = Math.floor(Number(pageCount) || 0);
    if (n <= 0) return false;
    return (Number(totalChars) || 0) < n * SCANNED_CHARS_PER_PAGE;
  }

  /** 文件名是不是 PDF。 */
  function isPdfName(name) {
    return /\.pdf$/i.test(String(name || ''));
  }

  /**
   * pdf.js 的分片资源（cmaps / standard_fonts）都放在 src/vendor/pdf/ 下。
   * 用 document.baseURI 解析成绝对地址，file:// 与 http:// 都能正确落位。
   */
  function vendorUrl(file) {
    var rel = VENDOR_DIR + file;
    try {
      if (typeof document !== 'undefined' && document.baseURI) {
        return new URL(rel, document.baseURI).href;
      }
    } catch (err) { /* 落到下面的兜底 */ }
    return rel;
  }

  /**
   * 把 PDF 伪装成「统一中间格式」：一页 = 一章，start=i / end=i+1。
   *
   * charOffset 恒取 1（表示「这一页已读完」），这样 Progress.computePercent
   * 算出来的绝对偏移 = i + 1，百分比 = (i+1)/总页数，符合直觉：
   * 停在第 1 页时进度是 1/N 而不是 0%。
   */
  function syntheticBook(pageCount, title) {
    var n = Math.floor(Number(pageCount) || 0);
    if (!isFinite(n) || n < 0) n = 0;

    var chapters = [];
    for (var i = 0; i < n; i++) {
      chapters.push({ index: i, title: '第 ' + (i + 1) + ' 页', start: i, end: i + 1, text: '' });
    }
    return {
      title: String(title || ''),
      text: '',
      totalChars: n,
      chapters: chapters,
      stats: { pages: n }
    };
  }

  /** 读到的页号统一记成 1（已读）；越界会被 Progress.resolvePosition 夹回合法范围。 */
  function pageOffset() { return 1; }

  function clampPage(page, total) {
    var n = Math.floor(Number(page) || 0);
    if (n < 1) n = 1;
    if (total && n > total) n = total;
    return n;
  }

  /** 「12 / 130」这种页码指示。 */
  function pageLabel(page, total) {
    var t = Math.floor(Number(total) || 0);
    if (!t) return '—';
    return clampPage(page, t) + ' / ' + t;
  }

  function clampScale(scale) {
    var s = Number(scale);
    if (!isFinite(s) || s <= 0) return 1;
    if (s < SCALE_MIN) return SCALE_MIN;
    if (s > SCALE_MAX) return SCALE_MAX;
    return Math.round(s * 1000) / 1000;
  }

  /**
   * 按模式算缩放比。
   * @param {{width:number,height:number}} available 可视区域（CSS 像素）
   * @param {{width:number,height:number}} pageSize  页面原始尺寸（PDF 单位，72dpi）
   * @param {string|number} mode 'width'（适应宽度）| 'page'（整页）| 数字（固定倍率）
   */
  function fitScale(available, pageSize, mode) {
    var aw = Math.max(1, Number(available && available.width) || 1);
    var ah = Math.max(1, Number(available && available.height) || 1);
    var pw = Math.max(1, Number(pageSize && pageSize.width) || 1);
    var ph = Math.max(1, Number(pageSize && pageSize.height) || 1);

    var raw;
    if (mode === 'page') raw = Math.min(aw / pw, ah / ph);
    else if (typeof mode === 'number' && isFinite(mode)) raw = mode;
    else raw = aw / pw; // 'width' 及未知模式都按适应宽度

    return clampScale(raw);
  }

  /** 从当前缩放跳到上一档 / 下一档（dir = -1 缩小，+1 放大）。 */
  function stepScale(scale, dir) {
    var s = clampScale(scale);
    var i;
    if (dir > 0) {
      for (i = 0; i < SCALE_STEPS.length; i++) {
        if (SCALE_STEPS[i] > s + 0.001) return SCALE_STEPS[i];
      }
      return SCALE_MAX;
    }
    for (i = SCALE_STEPS.length - 1; i >= 0; i--) {
      if (SCALE_STEPS[i] < s - 0.001) return SCALE_STEPS[i];
    }
    return SCALE_MIN;
  }

  /** 百分比文案，如「125%」。 */
  function scaleLabel(scale) {
    return Math.round(clampScale(scale) * 100) + '%';
  }

  /* ---------------- 搜索与文字层（纯逻辑，可离线单测） ---------------- */

  /** 这些字符在搜索时一律忽略：半角/全角空格、各种换行、零宽与 BOM。 */
  function isSpaceChar(code) {
    return code === 32 || code === 9 || code === 10 || code === 13 || code === 12 ||
      code === 160 || code === 0x3000 || (code >= 0x2000 && code <= 0x200a) ||
      code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f || code === 0xfeff;
  }

  /**
   * 把 pdf.js 一页的 textContent.items 拼成一段文本。
   *
   * hasEOL 是 pdf.js 给的「这一小段后面该换行」标记：不处理它，
   * 两行文字会被粘成一个词（"终章" + "完" 变成 "终章完"）。
   */
  function pageTextOf(items) {
    if (!items || !items.length) return '';
    var out = '';
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (!item || typeof item.str !== 'string') continue;
      out += item.str;
      if (item.hasEOL) out += '\n';
    }
    return out;
  }

  function collapse(text) {
    return String(text).replace(/\s+/g, ' ');
  }

  /**
   * 建立「去掉空白」的搜索索引。
   *
   * 为什么要去掉空白：PDF 里一句话常被切成好几个文字片段，片段之间还夹着排版换行，
   * 原文是「MingScribe PDF\n第 1 页」这种。用户搜「PDF 第1页」时，
   * 若按原文逐字比对，中间的换行和空格会让它永远搜不到。
   *
   *   text —— 原文
   *   norm —— 去掉全部空白、逐字符转小写后的文本（搜索就比这个）
   *   map  —— map[i] = norm[i] 在原文里的下标；末尾多一个哨兵 map[norm.length]
   *           （没这个哨兵，匹配正好结尾时取不到结束位置）
   *
   * 大小写转换刻意逐字符做：'İ' 这类字符整体 toLowerCase 会变成两个码元，
   * 长度一变 map 就全错位了，所以长度不为 1 时保留原字符。
   */
  function buildSearchIndex(text) {
    var src = String(text == null ? '' : text);
    var norm = '';
    var map = [];

    for (var i = 0; i < src.length; i++) {
      if (isSpaceChar(src.charCodeAt(i))) continue;
      var ch = src.charAt(i);
      var low = ch.toLowerCase();
      norm += low.length === 1 ? low : ch;
      map.push(i);
    }
    map.push(src.length);

    return { text: src, norm: norm, map: map };
  }

  /** 关键词同样处理（去空白 + 小写）。返回空串表示「没必要搜」。 */
  function normalizeQuery(query) {
    return buildSearchIndex(String(query == null ? '' : query).trim()).norm;
  }

  function toPositiveInt(value, fallback) {
    var n = Number(value);
    if (!isFinite(n)) return fallback;
    n = Math.floor(n);
    return n > 0 ? n : fallback;
  }

  function mergeSearchOptions(options) {
    var out = {};
    Object.keys(SEARCH_DEFAULTS).forEach(function (k) { out[k] = SEARCH_DEFAULTS[k]; });
    if (options) {
      Object.keys(options).forEach(function (k) {
        if (options[k] !== undefined && options[k] !== null) out[k] = options[k];
      });
    }
    return out;
  }

  /**
   * 匹配处前后的摘要。start / length 都是「原文坐标」。
   * 返回的 hitStart / hitEnd 是落在摘要串里的位置，供高亮使用。
   */
  function makeSnippet(text, start, length, context) {
    var from = Math.max(0, start - context);
    var to = Math.min(text.length, start + length + context);

    var head = collapse(text.slice(from, start));
    var hit = collapse(text.slice(start, start + length));
    var tail = collapse(text.slice(start + length, to));
    var headMark = from > 0 ? '…' : '';
    var tailMark = to < text.length ? '…' : '';

    return {
      snippet: headMark + head + hit + tail + tailMark,
      hitStart: headMark.length + head.length,
      hitEnd: headMark.length + head.length + hit.length
    };
  }

  /**
   * 在若干页的文本里搜关键词。
   *
   * @param {string[]} pageTexts 每页一段文本，下标 0 对应第 1 页
   * @param {string} query
   * @returns {{query,total,results,truncated,textPages,totalChars,looksScanned,maxResults}}
   *   每条结果 { page, offset, length, matchLength, snippet, hitStart, hitEnd }
   *   page 为 1 起页码；offset/length 是该页原文坐标下的区间。
   *   total 是「实际返回的条数」——达到上限后即等于上限，不是全书真实命中数。
   *   textPages 是**抽得到文字的页数**（原字段名 scannedPages 有误导性，已改名）。
   *   looksScanned 说明整本几乎没有文字层，多半是图片版。
   */
  function searchPages(pageTexts, query, options) {
    var opt = mergeSearchOptions(options);
    var out = {
      query: String(query == null ? '' : query),
      total: 0,
      results: [],
      truncated: false,
      textPages: 0,
      totalChars: 0,
      looksScanned: false,
      maxResults: toPositiveInt(opt.maxResults, SEARCH_DEFAULTS.maxResults)
    };

    var nq = normalizeQuery(query);
    if (!nq || !pageTexts || !pageTexts.length) return out;

    var maxPerPage = toPositiveInt(opt.maxPerPage, SEARCH_DEFAULTS.maxPerPage);
    var context = toPositiveInt(opt.context, SEARCH_DEFAULTS.context);

    for (var pi = 0; pi < pageTexts.length; pi++) {
      var text = String(pageTexts[pi] == null ? '' : pageTexts[pi]);
      if (!text) continue;

      out.textPages++;
      out.totalChars += text.length;

      var index = buildSearchIndex(text);
      var at = index.norm.indexOf(nq);
      var counted = 0;

      while (at >= 0) {
        if (counted >= maxPerPage || out.results.length >= out.maxResults) {
          out.truncated = true;
          break;
        }

        var start = index.map[at];
        var end = index.map[at + nq.length - 1] + 1;
        var snip = makeSnippet(text, start, end - start, context);

        out.results.push({
          id: out.results.length,
          page: pi + 1,
          offset: start,
          length: end - start,
          matchLength: nq.length,
          snippet: snip.snippet,
          hitStart: snip.hitStart,
          hitEnd: snip.hitEnd
        });
        counted++;

        // 与正文搜索保持一致：按关键词长度往后推，命中不重叠
        at = index.norm.indexOf(nq, at + nq.length);
      }

      if (out.results.length >= out.maxResults) {
        if (pi < pageTexts.length - 1) out.truncated = true;
        break;
      }
    }

    out.total = out.results.length;
    out.looksScanned = isProbablyScanned(pageTexts.length, out.totalChars);
    return out;
  }

  /**
   * 把命中拆到各个文字片段（span）上 —— 用于在 PDF 页面上标黄。
   *
   * 为什么需要它：pdf.js 的文字层是一句话切成很多个 span，
   * 命中经常横跨两三个 span，直接对单个 span 做 indexOf 会漏掉。
   * 这里先把所有 span 拼成整串、在整串上定位，再切回每个 span 的局部区间。
   *
   * @param {string[]} spanTexts 按 DOM 顺序排列的片段文本
   * @returns {Array<{spanIndex:number,start:number,end:number}>} 升序、互不重叠
   */
  function spanRanges(spanTexts, query) {
    var out = [];
    if (!spanTexts || !spanTexts.length) return out;

    var nq = normalizeQuery(query);
    if (!nq) return out;

    var starts = [];
    var combined = '';
    var i;
    for (i = 0; i < spanTexts.length; i++) {
      starts.push(combined.length);
      combined += String(spanTexts[i] == null ? '' : spanTexts[i]);
    }

    var index = buildSearchIndex(combined);
    var cap = SEARCH_DEFAULTS.maxResults;
    var at = index.norm.indexOf(nq);

    while (at >= 0) {
      if (out.length >= cap) break;

      var start = index.map[at];
      var end = index.map[at + nq.length - 1] + 1;
      var seq = out.length;   // 供上层标记「当前这一处」，按出现顺序编号

      for (i = 0; i < starts.length; i++) {
        var spanStart = starts[i];
        var spanEnd = spanStart + String(spanTexts[i] == null ? '' : spanTexts[i]).length;
        var from = Math.max(start, spanStart);
        var to = Math.min(end, spanEnd);
        if (to > from) {
          out.push({ spanIndex: i, start: from - spanStart, end: to - spanStart, seq: seq });
        }
      }

      at = index.norm.indexOf(nq, at + nq.length);
    }

    return out;
  }

  /**
   * 创建 pdf.js 引擎。loader 注入，测试时可换成 mock —— 这样不装浏览器也能测渲染之外的逻辑。
   * @param {function} loader 返回 Promise<pdfjsLib>
   * @param {string} workerUrl worker 的绝对地址
   */
  function createEngine(loader, workerUrl) {
    var libPromise = null;

    function getLib() {
      if (!libPromise) {
        libPromise = Promise.resolve()
          .then(function () { return loader(); })
          .then(function (mod) {
            var lib = mod && mod.default ? mod.default : mod;
            if (!lib || typeof lib.getDocument !== 'function') {
              throw new Error('pdf.js 加载失败：未找到 getDocument');
            }
            if (lib.GlobalWorkerOptions && workerUrl) {
              lib.GlobalWorkerOptions.workerSrc = workerUrl;
            }
            return lib;
          });
      }
      return libPromise;
    }

    function open(data) {
      return getLib().then(function (lib) {
        var opts = {
          data: data,
          cMapUrl: vendorUrl('cmaps/'),
          cMapPacked: true,
          standardFontDataUrl: vendorUrl('standard_fonts/'),
          disableAutoFetch: true,   // 一次只取用到的对象，别把整本拉进内存
          isEvalSupported: false    // 桌面版 CSP 下更稳
        };
        return lib.getDocument(opts).promise;
      });
    }

    /** 取第 pageNumber 页（1 起）的原始尺寸，用于算「适应宽度」。 */
    function pageSize(doc, pageNumber) {
      return doc.getPage(pageNumber).then(function (page) {
        var vp = page.getViewport({ scale: 1 });
        return { width: vp.width, height: vp.height };
      });
    }

    /** 把第 pageNumber 页画到 canvas 上，返回 CSS 像素尺寸。 */
    function render(doc, pageNumber, canvas, scale) {
      return doc.getPage(pageNumber).then(function (page) {
        var viewport = page.getViewport({ scale: clampScale(scale) });
        // 按设备像素比放大位图，文字才不发虚；上限 2 避免超大页把内存吃光
        var dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
        var ratio = Math.min(Math.max(dpr, 1), 2);

        canvas.width = Math.max(1, Math.floor(viewport.width * ratio));
        canvas.height = Math.max(1, Math.floor(viewport.height * ratio));
        canvas.style.width = Math.floor(viewport.width) + 'px';
        canvas.style.height = Math.floor(viewport.height) + 'px';

        var ctx = canvas.getContext('2d');
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        ctx.clearRect(0, 0, viewport.width, viewport.height);

        var task = page.render({ canvasContext: ctx, viewport: viewport });
        return task.promise.then(function () {
          // viewport 一并返回：文字层必须用「同一个 viewport」渲染，
          // 否则透明文字和 canvas 上的字会差半个像素，选中区域就会飘。
          return { width: viewport.width, height: viewport.height, viewport: viewport, task: task };
        });
      });
    }

    /** 取一页的 textContent 原始对象（文字层与搜索都要用）。 */
    function textContent(doc, pageNumber) {
      return doc.getPage(pageNumber).then(function (page) {
        return page.getTextContent();
      });
    }

    /** 抽一页的文字（给搜索用）。扫描件没有文字层，返回空串。 */
    function text(doc, pageNumber) {
      return textContent(doc, pageNumber).then(function (content) {
        return pageTextOf(content && content.items);
      });
    }

    /**
     * 在 canvas 上盖一层透明文字层，让 PDF 能像网页那样「选中、复制」。
     *
     * 用的是 pdf.js 自带的 TextLayer，而不是自己摆 span：字距、竖排、旋转、
     * 字体替换这些排版细节它都处理好了，自己重写只会更差。
     * 拿不到 TextLayer（老版本）时给明确错误，由上层静默降级 —— 看得见 PDF 比能选中更重要。
     */
    function textLayer(doc, pageNumber, container, viewport) {
      return getLib().then(function (lib) {
        if (typeof lib.TextLayer !== 'function') {
          throw new Error('内置的 pdf.js 不含 TextLayer');
        }
        return textContent(doc, pageNumber).then(function (content) {
          container.textContent = '';
          var layer = new lib.TextLayer({
            textContentSource: content,
            container: container,
            viewport: viewport
          });
          return layer.render().then(function () { return layer; });
        });
      });
    }

    return {
      open: open,
      render: render,
      pageSize: pageSize,
      text: text,
      textContent: textContent,
      textLayer: textLayer,
      /** 供 app 层判断「引擎能不能用」，避免每次都真的去 import 一遍。 */
      available: function () {
        return getLib().then(function () { return true; }, function () { return false; });
      }
    };
  }

  /**
   * 默认引擎：动态 import 内置的 pdf.js。
   * 只在第一次真正打开 PDF 时触发，平时不占启动时间。
   */
  var defaultEngine = null;
  function engine() {
    if (!defaultEngine) {
      defaultEngine = createEngine(function () {
        /* webpack/rollup 会试图解析 import()，这里必须绕过：用变量拼出的 URL */
        var url = vendorUrl(MODULE_FILE);
        return import(/* webpackIgnore: true */ url);
      }, vendorUrl(WORKER_FILE));
    }
    return defaultEngine;
  }

  /** 读一个 File 成 Uint8Array（PDF 必须按二进制读，不能当文本）。 */
  function readFileBytes(file) {
    if (!file || typeof file.arrayBuffer !== 'function') {
      return Promise.reject(new Error('无效的文件对象'));
    }
    return file.arrayBuffer().then(function (buf) { return new Uint8Array(buf); });
  }

  return {
    VENDOR_DIR: VENDOR_DIR,
    MODULE_FILE: MODULE_FILE,
    WORKER_FILE: WORKER_FILE,
    SCALE_STEPS: SCALE_STEPS.slice(),
    SCALE_MIN: SCALE_MIN,
    SCALE_MAX: SCALE_MAX,
    SEARCH_DEFAULTS: SEARCH_DEFAULTS,
    SCANNED_CHARS_PER_PAGE: SCANNED_CHARS_PER_PAGE,

    isPdfName: isPdfName,
    isProbablyScanned: isProbablyScanned,
    vendorUrl: vendorUrl,
    syntheticBook: syntheticBook,
    pageOffset: pageOffset,
    clampPage: clampPage,
    pageLabel: pageLabel,
    clampScale: clampScale,
    fitScale: fitScale,
    stepScale: stepScale,
    scaleLabel: scaleLabel,

    pageTextOf: pageTextOf,
    normalizeQuery: normalizeQuery,
    buildSearchIndex: buildSearchIndex,
    searchPages: searchPages,
    spanRanges: spanRanges,

    createEngine: createEngine,
    engine: engine,
    readFileBytes: readFileBytes
  };
});
