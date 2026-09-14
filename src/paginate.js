/**
 * 分页层（纯函数）。
 *
 * 职责边界：
 *   - 只做「把一章文本切成一页一页」这件事，不碰 DOM、不碰渲染。
 *   - 页边界一律用「章节内字符偏移」表达，**不用页码**——
 *     这样进度、划线、搜索命中全都继续共用同一套锚点，
 *     字号/窗口/行距一变，只要重新切页再把同一个偏移定位回去即可。
 *
 * 为什么能这样做：
 *   解析层保证 `chapter.text.length === chapter.end - chapter.start`，
 *   所以「章节内字符偏移」和「chapter.text 的下标」是同一个坐标系，
 *   切页可以直接吃 chapter.text，不需要回看整本书。
 *
 * 切分策略（保留原排版风格）：
 *   段落是切页的最小单位，**不做断行**（断行会把一段话割成两半，读起来很割裂）。
 *   一行放不下时优先在该行内退到最近的句读边界，实在没有就往回找一个空格。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MingScribe = root.MingScribe || {};
    root.MingScribe.Paginate = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** 中文句读边界：在这些标点之后断行，读者不会觉得被截断。 */
  var BREAK_AFTER = '。！？；…!?;';
  /** 可以跟在句读标点后面一起留在上一行的收尾符号（右引号、右括号等）。 */
  var CLOSING = '”’」』》〉）)】]';
  /** 往回找断点的最大距离（字符）。太远就不找了，直接硬切。 */
  var MAX_BREAK_LOOKBACK = 40;

  /** 把一章文本拆成「段落」列表，每段记录它在章节内的起止偏移。 */
  function splitParagraphs(text) {
    var source = String(text == null ? '' : text);
    var out = [];
    var re = /[^\n]+/g;
    var match;

    while ((match = re.exec(source)) !== null) {
      var raw = match[0];
      var start = match.index;
      var lead = raw.length - raw.replace(/^[ \t\u3000]+/, '').length;
      var body = raw.slice(lead);
      var trail = body.length - body.replace(/[ \t\u3000]+$/, '').length;
      var clean = trail ? body.slice(0, body.length - trail) : body;

      if (!clean) continue;

      out.push({
        text: clean,
        start: start + lead,
        end: start + lead + clean.length
      });
    }

    return out;
  }

  /**
   * 估算一段文字占多少个「正文字宽」。
   * CJK 字符按 1 个字宽，其余（拉丁字母、数字等）按 0.55 个。
   * 这个比例不求精确，只要在不同字号/页宽下**单调**即可，
   * 因为切页只需要行数之间的大小关系正确。
   */
  function measure(text, from, to) {
    var width = 0;
    for (var i = from; i < to; i++) {
      width += text.charCodeAt(i) < 0x2e80 ? 0.55 : 1;
    }
    return width;
  }

  /** 找到 [from, to) 之间最靠后的一个「适合断行」的位置；找不到返回 -1。 */
  function findBreak(text, from, to) {
    var floor = Math.max(from, to - MAX_BREAK_LOOKBACK);

    for (var i = to - 1; i >= floor; i--) {
      if (BREAK_AFTER.indexOf(text.charAt(i)) >= 0) {
        // 把紧跟其后的右引号、右括号一起收进来，避免下一行行首孤零零一个符号
        var j = i + 1;
        while (j < to && CLOSING.indexOf(text.charAt(j)) >= 0) j++;
        return j;
      }
    }

    for (var k = to - 1; k >= floor; k--) {
      if (text.charAt(k) === ' ') return k + 1;
    }

    return -1;
  }

  /**
   * 把一段文本按「每行多少个字宽」切成若干行（每行记录**段内**偏移）。
   * 返回 [{ start, end, hard }]，hard 表示这行是被迫劈开的（没找到句读边界）。
   */
  function layoutParagraph(text, charsPerLine) {
    var lines = [];
    var len = text.length;
    if (!len) return lines;

    var cols = Math.max(2, Math.round(Number(charsPerLine) || 32));
    var pos = 0;

    while (pos < len) {
      var width = measure(text, pos, len);

      // 剩下的刚好放得下一整行，收工
      if (width <= cols) {
        lines.push({ start: pos, end: len, hard: false });
        break;
      }

      // 本来需要几行 → 每行大致多少字
      var needed = Math.ceil(width / cols);
      var step = Math.max(1, Math.min(Math.round((len - pos) / needed), cols));

      if (pos + step >= len) {
        lines.push({ start: pos, end: len, hard: false });
        break;
      }

      var cut = findBreak(text, pos + 1, pos + step);
      if (cut <= pos) {
        lines.push({ start: pos, end: pos + step, hard: true });
        pos += step;
      } else {
        lines.push({ start: pos, end: cut, hard: false });
        pos = cut;
      }
    }

    return lines;
  }

  /**
   * 一行在页面里占几个「正文字行高」。
   *
   * 注意：这里**只算行本身**，段落末尾的 1.1em 外边距由 paginateChapter
   * 按「每个段落一次」单独累加。之前把边距摊到每行（1.17）是错的——
   * 段落越多、摊得越不准，最后整页会溢出被裁掉。
   */
  function rowWeight(text, type) {
    if (type === 'h2') return 1.25;       // 标题字号为正文 1.25 倍
    if (type === 'img-note') return 0.72 * 1.6;
    return 1;
  }

  /** 段落自己的垂直方向额外开销（非行高部分），单位同上。 */
  function blockExtra(type) {
    if (type === 'h2') return 1.5;        // 8px 上边距 + 28px 下边距
    if (type === 'img-note') return 0.72 * 0.9 + 0.3;
    return 1.1;                            // 正文段落下边距 1.1em
  }

  function classify(text, isTitle) {
    if (isTitle && isTitle(text)) return 'h2';
    if (/^\[(图片|图)[:：]/.test(text)) return 'img-note';
    return 'p';
  }

  /**
   * 一章文本 → 页边界数组。
   *
   * 实现分两步走：
   *   1. 先把每个段落摊成「行」，每行带绝对的章节内字符偏移；
   *   2. 再把行按行高装箱进页，页边界取该页第一行的起点。
   * 这样页边界天生就是字符偏移，不需要在行列坐标与字符坐标之间来回换算。
   *
   * @param {object} chapter  统一中间格式里的章节对象（需要 text / title）
   * @param {object} metrics  {
   *   cols,          // 一页有效宽度（单位：个正文字宽）
   *   rowsPerPage,   // 一页能放几个正文行高
   *   isTitle(text)  // 可选，判断某个段落是不是章节标题
   * }
   * @returns {Array<{start:number,end:number}>} 页边界（章节内字符偏移）。
   *          必然非空；内容为空时返回 [{start:0,end:0}]。
   */
  function paginateChapter(chapter, metrics) {
    var text = String((chapter && chapter.text) || '');
    var opts = metrics || {};
    var cols = Math.max(4, Math.round(Number(opts.cols) || 34));
    var rowsPerPage = Math.max(2, Math.round(Number(opts.rowsPerPage) || 22));
    var isTitle = typeof opts.isTitle === 'function' ? opts.isTitle : null;

    var paragraphs = splitParagraphs(text);
    var pages = [];

    var pageStart = 0;
    var usedRows = 0;
    var hasRow = false;

    function flush(endOffset) {
      pages.push({ start: pageStart, end: endOffset });
      pageStart = endOffset;
      usedRows = 0;
      hasRow = false;
    }

    for (var p = 0; p < paragraphs.length; p++) {
      var para = paragraphs[p];
      var type = classify(para.text, isTitle);
      var lineWeight = rowWeight(para.text, type);
      var extra = blockExtra(type);
      var lines = layoutParagraph(para.text, cols);

      for (var i = 0; i < lines.length; i++) {
        var absStart = para.start + lines[i].start;
        var isLastLine = i === lines.length - 1;
        // 段落最后一行额外扛上这一段的边距（标题还有上下留白）
        var cost = lineWeight + (isLastLine ? extra : 0);

        // 本页已经有内容，且这行塞不下 → 在本行起点处翻页
        if (hasRow && usedRows + cost > rowsPerPage) flush(absStart);

        if (!hasRow) pageStart = absStart; // 本行是这一页的第一行
        usedRows += cost;
        hasRow = true;
      }
    }

    if (hasRow) {
      pages.push({ start: pageStart, end: text.length });
    }

    if (!pages.length) {
      return [{ start: 0, end: 0 }];
    }

    return pages;
  }

  /** 在页边界数组里找到包含指定字符偏移的页序号。 */
  function pageIndexOf(pages, charOffset) {
    if (!pages || !pages.length) return 0;
    var offset = Number(charOffset) || 0;
    if (offset <= pages[0].start) return 0;

    var lo = 0;
    var hi = pages.length - 1;
    while (lo < hi) {
      var mid = Math.ceil((lo + hi) / 2);
      if (pages[mid].start <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  function clampPageIndex(pages, index) {
    if (!pages || !pages.length) return 0;
    var i = Number(index) || 0;
    return Math.max(0, Math.min(Math.round(i), pages.length - 1));
  }

  return {
    splitParagraphs: splitParagraphs,
    layoutParagraph: layoutParagraph,
    rowWeight: rowWeight,
    blockExtra: blockExtra,
    paginateChapter: paginateChapter,
    pageIndexOf: pageIndexOf,
    clampPageIndex: clampPageIndex,
    BREAK_AFTER: BREAK_AFTER
  };
});
