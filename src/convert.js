/**
 * 格式转换层（MingScribe）。
 *
 * 设计目标：让阅读器支持「除了 TXT / EPUB 之外」的格式（MOBI / AZW3 / DOCX / FB2 …），
 * 且**不引入第二套解析器、不破坏统一中间格式铁律**。
 *
 * 思路：任何可转格式 → 经 Calibre 的 `ebook-convert` 转成 EPUB →
 * 直接交给现成的 `Epub.parseEpub`（src/epub.js）产出统一中间格式。
 * 这样 progress / search / decorate / annotations 全部零返工——它们只认中间格式。
 *
 * 关键约束：浏览器（含 file:// 静态页）**无法**直接执行 `ebook-convert`（沙箱 + 无文件系统 exec）。
 * 因此真正的转换执行器（run）由「桌面版」注入：
 *   - 纯网页版：window.MingScribeConvert 不存在 → 导入非原生格式时给友好提示，不崩。
 *   - 桌面版（Tauri）：tauri-bridge.js 注入 run，内部调 Rust 命令 → ebook-convert。
 *
 * 本模块本身是纯逻辑 + 注入后端，可在 Node / 浏览器无 Calibre 环境下单测。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MingScribe = root.MingScribe || {};
    root.MingScribe.Convert = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * 能经 Calibre 转成 EPUB 的输入格式（TXT / EPUB 已是原生支持，不在此列）。
   * 注意：带 DRM 的 AZW3 / MOBI（如亚马逊商店购买）Calibre 也解不开——
   * 这里只做格式识别，能否成功取决于文件本身是否未加密。
   */
  var INPUT_EXT = [
    'mobi', 'azw', 'azw3', 'kfx',
    'doc', 'docx', 'rtf', 'odt',
    'html', 'htm', 'fb2', 'lit',
    'pdb', 'prc', 'snb',
    'cbr', 'cbz'
  ];

  function extOf(name) {
    var m = /\.([a-z0-9]+)$/i.exec(name || '');
    return m ? m[1].toLowerCase() : '';
  }

  /** 该文件名是否走转换管道（非原生 TXT/EPUB 且 Calibre 能处理）。 */
  function isConvertible(name) {
    return INPUT_EXT.indexOf(extOf(name)) !== -1;
  }

  /** 返回全部受支持的「待转换」扩展名（不含原生 txt/epub）。 */
  function supportedFormats() {
    return INPUT_EXT.slice();
  }

  /**
   * 把任意可转格式转成 EPUB。
   * 核心只做「调用注入的后端执行器」这一件事——真正的 `ebook-convert` 调用由桌面版注入，
   * 这样本模块在纯浏览器 / Node 测试里都能跑（无需 Calibre）。
   *
   * @param {object} opts
   * @param {string}   opts.inputPath   源文件路径（桌面版提供，浏览器拿不到）
   * @param {string}   opts.outputPath  目标 EPUB 路径
   * @param {function} opts.run         注入的执行器：(inputPath, outputPath) => Promise<void>
   * @returns {Promise<{ epubPath: string }>}
   */
  function convertToEpub(opts) {
    opts = opts || {};
    if (!opts.inputPath) return Promise.reject(new Error('缺少输入路径'));
    if (!opts.outputPath) return Promise.reject(new Error('缺少输出路径'));
    if (typeof opts.run !== 'function') {
      return Promise.reject(new Error('未配置转换后端（仅桌面版会注入 ebook-convert）'));
    }
    return Promise.resolve(opts.run(opts.inputPath, opts.outputPath)).then(function () {
      return { epubPath: opts.outputPath };
    });
  }

  /** 是否具备真实转换能力（桌面版注入了 run 才为 true）。 */
  function hasBackend(run) {
    return typeof run === 'function';
  }

  return {
    INPUT_EXT: INPUT_EXT,
    isConvertible: isConvertible,
    supportedFormats: supportedFormats,
    convertToEpub: convertToEpub,
    hasBackend: hasBackend
  };
}));
