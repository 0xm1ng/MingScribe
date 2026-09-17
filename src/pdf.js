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
          return { width: viewport.width, height: viewport.height, task: task };
        });
      });
    }

    /** 抽一页的文字（给搜索用）。扫描件没有文字层，返回空串。 */
    function text(doc, pageNumber) {
      return doc.getPage(pageNumber).then(function (page) {
        return page.getTextContent().then(function (content) {
          var items = (content && content.items) || [];
          var out = '';
          for (var i = 0; i < items.length; i++) {
            if (items[i] && typeof items[i].str === 'string') out += items[i].str;
          }
          return out;
        });
      });
    }

    return {
      open: open,
      render: render,
      pageSize: pageSize,
      text: text,
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

    isPdfName: isPdfName,
    vendorUrl: vendorUrl,
    syntheticBook: syntheticBook,
    pageOffset: pageOffset,
    clampPage: clampPage,
    pageLabel: pageLabel,
    clampScale: clampScale,
    fitScale: fitScale,
    stepScale: stepScale,
    scaleLabel: scaleLabel,

    createEngine: createEngine,
    engine: engine,
    readFileBytes: readFileBytes
  };
});
