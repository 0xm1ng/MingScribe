/**
 * 解析层：把任意纯文本转换为「统一中间格式」。
 *
 * 统一中间格式（这是整个项目的关键约定）：
 *   {
 *     title:      string,
 *     text:       string,        // 归一化后的全文（\r\n -> \n，已去 BOM）
 *     totalChars: number,        // 全文字符数
 *     chapters:   [{ index, title, start, end, text }],
 *     stats:      { lineCount, chapterCount, recognizedChapters }
 *   }
 *
 * 显示层只依赖这个结构，不关心原始格式是 TXT 还是 EPUB。
 * 未来支持 EPUB 时，只需新增一个「EPUB -> 统一中间格式」的解析器，显示层无需改动。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.MingScribe = root.MingScribe || {};
    root.MingScribe.Parser = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** 章节标题行识别（锚定行首）。 */
  var DEFAULT_TITLE_PATTERN = new RegExp(
    '^(?:' +
      '第\\s*[0-9０-９一二三四五六七八九十百千万零两〇]+\\s*[章回节卷篇部集]' +
      '|序章|序言|自序|代序|楔子|引子|前言|尾声|尾章|后记|番外|终章' +
      '|Chapter\\s*\\d+|CHAPTER\\s*\\d+' +
    ')',
    'i'
  );

  /** 标题行内出现这些标点，基本可以判定是正文而非标题。 */
  var FORBIDDEN_IN_TITLE = /[。！？…，、；]/;

  /** 标题标记与标题正文之间的分隔符。 */
  var SEPARATOR = /^[\s\u3000:：、.．\-—]+/;

  var DEFAULTS = {
    bookTitle: '',
    // 标题整行最大长度
    maxTitleLineLength: 30,
    // 标题正文部分最大长度（有分隔符时）
    maxTitleBodyLength: 20,
    // 无分隔符时，标题正文部分的最大长度（用于排除「第三章的内容很精彩」这类正文）
    maxInlineBodyLength: 4,
    titlePattern: DEFAULT_TITLE_PATTERN
  };

  /** 去 BOM 并把换行统一为 \n。 */
  function normalizeText(input) {
    var text = String(input == null ? '' : input);
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return text.replace(/\r\n?/g, '\n');
  }

  /** 逐行扫描并记录每行在全文中的偏移，供字符偏移锚点使用。 */
  function scanLines(text) {
    var lines = [];
    var start = 0;
    while (start <= text.length) {
      var nl = text.indexOf('\n', start);
      var end = nl === -1 ? text.length : nl;
      lines.push({ text: text.slice(start, end), start: start, end: end });
      if (nl === -1) break;
      start = nl + 1;
    }
    return lines;
  }

  /** 判断某一行是否为章节标题。 */
  function isChapterTitle(lineText, options) {
    var opts = options || DEFAULTS;
    var t = lineText.trim();
    if (!t) return false;
    if (t.length > opts.maxTitleLineLength) return false;
    if (FORBIDDEN_IN_TITLE.test(t)) return false;

    var matched = opts.titlePattern.exec(t);
    if (!matched) return false;

    var rest = t.slice(matched[0].length);
    var hasSeparator = SEPARATOR.test(rest);
    var body = rest.replace(SEPARATOR, '');

    if (body.length > opts.maxTitleBodyLength) return false;
    // 没有空格/冒号分隔，且后面跟了 5 个以上字符 —— 极可能是正文句子
    if (!hasSeparator && body.length > opts.maxInlineBodyLength) return false;

    return true;
  }

  /**
   * 解析纯文本。
   * @param {string} rawText 已解码的文本
   * @param {object} [options] 可选配置
   */
  function parseTxt(rawText, options) {
    var opts = Object.assign({}, DEFAULTS, options || {});
    var text = normalizeText(rawText);
    var lines = scanLines(text);
    var marks = [];

    for (var i = 0; i < lines.length; i++) {
      if (isChapterTitle(lines[i].text, opts)) marks.push(lines[i]);
    }

    var chapters = [];

    if (marks.length === 0) {
      // 没有任何章节标记：全文作为单章，保证显示层逻辑统一
      chapters.push({ index: 0, title: opts.bookTitle || '全文', start: 0, end: text.length, text: text });
    } else {
      // 第一个章节标记之前的正文单独成章
      if (marks[0].start > 0) {
        var head = text.slice(0, marks[0].start);
        if (head.trim()) {
          chapters.push({ index: 0, title: '前言', start: 0, end: marks[0].start, text: head });
        }
      }
      for (var j = 0; j < marks.length; j++) {
        var start = marks[j].start;
        var end = j + 1 < marks.length ? marks[j + 1].start : text.length;
        chapters.push({
          index: chapters.length,
          title: marks[j].text.trim(),
          start: start,
          end: end,
          text: text.slice(start, end)
        });
      }
    }

    return {
      title: opts.bookTitle || '',
      text: text,
      totalChars: text.length,
      chapters: chapters,
      stats: {
        lineCount: lines.length,
        chapterCount: chapters.length,
        recognizedChapters: marks.length
      }
    };
  }

  return {
    parseTxt: parseTxt,
    isChapterTitle: isChapterTitle,
    normalizeText: normalizeText,
    scanLines: scanLines,
    DEFAULT_TITLE_PATTERN: DEFAULT_TITLE_PATTERN,
    DEFAULTS: DEFAULTS
  };
});
