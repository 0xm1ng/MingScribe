/**
 * 全文搜索（纯逻辑，不依赖 DOM，可在 Node 下直接测试）。
 *
 * 设计要点：
 *   1. 关键词按「字面量」处理 —— 用户输入 `a.b` 不会变成正则通配符，
 *      否则搜一个 `C++` 就能让程序抛异常，这是搜索功能最常见的翻车点。
 *   2. 结果返回「章节序号 + 章节内偏移」，与进度锚点模型完全一致，
 *      因此搜索结果可以直接复用 renderChapter 跳转，不需要第二套定位逻辑。
 *   3. 结果数量有上限：一本 137 万字的书里搜「的」能命中几万次，
 *      不设上限会直接把页面卡死。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.MingScribe = root.MingScribe || {};
    root.MingScribe.Search = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DEFAULTS = {
    maxResults: 300,      // 全书最多返回多少条
    maxPerChapter: 30,    // 单章最多返回多少条，避免某一章刷屏
    context: 24,          // 摘要前后各取多少字
    caseSensitive: false
  };

  function mergeOptions(options) {
    var out = {};
    Object.keys(DEFAULTS).forEach(function (k) { out[k] = DEFAULTS[k]; });
    if (options) {
      Object.keys(options).forEach(function (k) {
        if (options[k] !== undefined && options[k] !== null) out[k] = options[k];
      });
    }
    return out;
  }

  function toPositiveInt(value, fallback) {
    var n = Number(value);
    if (!isFinite(n)) return fallback;
    n = Math.floor(n);
    return n > 0 ? n : fallback;
  }

  /** 转义正则元字符，让关键词始终按字面量匹配。 */
  function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function buildMatcher(query, caseSensitive) {
    try {
      return new RegExp(escapeRegExp(query), caseSensitive ? 'g' : 'gi');
    } catch (err) {
      return null;
    }
  }

  function collapse(text) {
    return String(text).replace(/\s+/g, ' ');
  }

  function makeSnippet(text, start, length, context) {
    var from = start - context;
    if (from < 0) from = 0;
    var to = start + length + context;
    if (to > text.length) to = text.length;

    var headEllipsis = from > 0 ? '…' : '';
    var tailEllipsis = to < text.length ? '…' : '';
    var head = collapse(text.slice(from, start));
    var hit = collapse(text.slice(start, start + length));
    var tail = collapse(text.slice(start + length, to));

    return {
      snippet: headEllipsis + head + hit + tail + tailEllipsis,
      hitStart: headEllipsis.length + head.length,
      hitEnd: headEllipsis.length + head.length + hit.length
    };
  }

  /**
   * 在整本书里搜索关键词。
   * 返回 { query, total, results, truncated, scannedChapters }。
   * 注意：total 是「实际返回的条数」，达到上限后为上限值，不是全书真实命中数。
   */
  function searchBook(book, query, options) {
    var opt = mergeOptions(options);
    var q = String(query == null ? '' : query).trim();
    var out = {
      query: q,
      total: 0,
      results: [],
      truncated: false,
      scannedChapters: 0,
      maxResults: opt.maxResults
    };

    if (!q || !book || !book.chapters || !book.chapters.length) return out;

    var matcher = buildMatcher(q, opt.caseSensitive);
    if (!matcher) return out;

    var maxResults = toPositiveInt(opt.maxResults, DEFAULTS.maxResults);
    var maxPerChapter = toPositiveInt(opt.maxPerChapter, DEFAULTS.maxPerChapter);
    var context = toPositiveInt(opt.context, DEFAULTS.context);

    for (var ci = 0; ci < book.chapters.length; ci++) {
      var chapter = book.chapters[ci];
      var text = chapter && chapter.text ? chapter.text : '';
      if (!text) continue;

      out.scannedChapters++;

      matcher.lastIndex = 0;
      var counted = 0;
      var match;

      while ((match = matcher.exec(text)) !== null) {
        // 空匹配会让 lastIndex 停住，必须手动推进，否则死循环
        if (match[0].length === 0) {
          matcher.lastIndex++;
          continue;
        }

        // 达到任一上限时停下。注意这里是「命中了但还没收录」，
        // 所以只要走到这里，就说明确实还有更多结果被截断掉了。
        if (counted >= maxPerChapter || out.results.length >= maxResults) {
          out.truncated = true;
          break;
        }

        var snip = makeSnippet(text, match.index, match[0].length, context);
        out.results.push({
          id: out.results.length,
          chapterIndex: ci,
          chapterTitle: chapter.title || ('第 ' + (ci + 1) + ' 节'),
          offset: match.index,                                  // 章节内偏移，可直接喂给 renderChapter
          globalOffset: (chapter.start || 0) + match.index,
          matchLength: match[0].length,
          snippet: snip.snippet,
          hitStart: snip.hitStart,
          hitEnd: snip.hitEnd
        });
        counted++;
      }

      // 全书额度用满时停止扫描后续章节；若后面还有章节，几乎必然存在未收录的命中
      if (out.results.length >= maxResults) {
        if (ci < book.chapters.length - 1) out.truncated = true;
        break;
      }
    }

    out.total = out.results.length;
    return out;
  }

  /**
   * 结果里第一条「不早于 globalOffset」的下标；若都在当前位置之前，则回绕到第一条。
   * 用于让搜索从读者当前所在处往后开始，而不是每次都拽回开头。
   */
  function firstIndexFrom(results, globalOffset) {
    if (!results || !results.length) return -1;
    var g = Number(globalOffset);
    if (!isFinite(g) || g < 0) g = 0;

    for (var i = 0; i < results.length; i++) {
      var at = Number(results[i] && results[i].globalOffset);
      if (isFinite(at) && at >= g) return i;
    }
    return 0;
  }

  /** 返回一段文本中所有匹配区间 [[start, end], ...]，已排序且互不重叠。 */
  function highlightRanges(text, query, options) {
    var opt = mergeOptions(options);
    var q = String(query == null ? '' : query).trim();
    if (!q || !text) return [];

    var matcher = buildMatcher(q, opt.caseSensitive);
    if (!matcher) return [];

    var ranges = [];
    var match;
    var guard = 0;

    while ((match = matcher.exec(text)) !== null) {
      if (match[0].length === 0) {
        matcher.lastIndex++;
        continue;
      }
      ranges.push([match.index, match.index + match[0].length]);
      // 兜底：极端输入下的死循环保护
      if (++guard > 10000) break;
    }

    return ranges;
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * 把文本按匹配区间包上 <mark>，用于高亮。
   * 输入的文本不会被当作 HTML 解析，因此正文里带 < > 也不会破坏页面。
   */
  function renderHighlightedHtml(text, ranges) {
    var source = String(text == null ? '' : text);
    var list = Array.isArray(ranges) ? ranges : [];
    var html = '';
    var cursor = 0;

    for (var i = 0; i < list.length; i++) {
      var start = Number(list[i] && list[i][0]);
      var end = Number(list[i] && list[i][1]);
      if (!isFinite(start) || !isFinite(end)) continue;

      // 容错：跳过越界与重叠区间，保证输出结构不嵌套错乱
      if (start < cursor) start = cursor;
      if (start > source.length) break;
      // 必须先夹取到文本长度内，再判断是否为空区间，
      // 否则越界区间会输出一个空的 <mark></mark>
      if (end > source.length) end = source.length;
      if (end <= start) continue;

      html += escapeHtml(source.slice(cursor, start));
      html += '<mark>' + escapeHtml(source.slice(start, end)) + '</mark>';
      cursor = end;
    }

    html += escapeHtml(source.slice(cursor));
    return html;
  }

  return {
    DEFAULTS: DEFAULTS,
    escapeRegExp: escapeRegExp,
    escapeHtml: escapeHtml,
    searchBook: searchBook,
    firstIndexFrom: firstIndexFrom,
    highlightRanges: highlightRanges,
    renderHighlightedHtml: renderHighlightedHtml
  };
});
