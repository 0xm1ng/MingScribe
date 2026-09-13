/**
 * 正文装饰渲染：把「标注（划线）」与「搜索命中」一起画到一个段落上。
 *
 * 为什么单独一个模块：这两类高亮是**两套独立区间**，可能互相交叉
 * （例如先划了一段，再在里面搜一个词）。直接用两次正则替换会互相破坏结构，
 * 必须先按边界切成互不重叠的小段，再逐段决定套哪几层标签。
 *
 * 坐标系：所有区间都用「章节内字符偏移」，与进度、标注保持同一套。
 * 传入的 decorations / hits 是**整章**的区间，本函数自行裁剪到当前段落。
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.MingScribe = root.MingScribe || {};
    root.MingScribe.Decorate = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  // 复用搜索模块的转义函数，避免两处实现漂移
  var Search = (typeof module === 'object' && module.exports)
    ? require('./search.js')
    : (root.MingScribe && root.MingScribe.Search);

  var HL_COLORS = ['yellow', 'green', 'blue', 'pink'];

  function escapeHtml(text) {
    return Search.escapeHtml(text);
  }

  function escapeAttr(text) {
    return String(text == null ? '' : text).replace(/[^A-Za-z0-9_-]/g, '');
  }

  function isColor(color) {
    return HL_COLORS.indexOf(color) >= 0;
  }

  function toInt(value, fallback) {
    var n = Number(value);
    if (!isFinite(n)) return fallback;
    return Math.floor(n);
  }

  /** 把整章坐标的区间裁剪到本段落，返回段落内坐标 {start, end}；无交集返回 null。 */
  function clip(start, end, base, length) {
    var s = Math.max(0, toInt(start, 0) - base);
    var e = Math.min(length, toInt(end, 0) - base);
    if (e <= s) return null;
    return { start: s, end: e };
  }

  function findCovering(list, position) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].start <= position && position < list[i].end) return list[i];
    }
    return null;
  }

  /**
   * 渲染一个段落的 HTML。
   *
   * @param {string} text          段落纯文本（已去除首尾空白）
   * @param {number} baseOffset    该段落在章节内的起始偏移（对应 DOM 的 data-off）
   * @param {Array}  decorations   整章标注区间 [{id, start, end, color, note}]
   * @param {Array}  hits          整章搜索命中区间 [[start, end], ...]
   * @returns {string} HTML 片段，文本部分全部已转义
   */
  function renderDecoratedHtml(text, baseOffset, decorations, hits) {
    var source = String(text == null ? '' : text);
    var length = source.length;
    var base = toInt(baseOffset, 0);

    if (!length) return '';

    var decoList = [];
    var hitList = [];
    var boundaries = [0, length];

    (decorations || []).forEach(function (item) {
      if (!item) return;
      var seg = clip(item.start, item.end, base, length);
      if (!seg) return;
      decoList.push({
        start: seg.start,
        end: seg.end,
        color: isColor(item.color) ? item.color : HL_COLORS[0],
        id: item.id,
        hasNote: !!item.note
      });
      boundaries.push(seg.start, seg.end);
    });

    (hits || []).forEach(function (range) {
      if (!range) return;
      var seg = clip(range[0], range[1], base, length);
      if (!seg) return;
      hitList.push(seg);
      boundaries.push(seg.start, seg.end);
    });

    if (!decoList.length && !hitList.length) return escapeHtml(source);

    // 去重 + 升序，得到互不重叠的切片边界
    var sorted = boundaries
      .filter(function (n) { return isFinite(n) && n >= 0 && n <= length; })
      .sort(function (a, b) { return a - b; })
      .filter(function (n, i, arr) { return i === 0 || n !== arr[i - 1]; });

    // 逐段判定：这一段被哪条划线覆盖、是否落在搜索命中里
    var segments = [];
    for (var i = 0; i < sorted.length - 1; i++) {
      var from = sorted[i];
      var to = sorted[i + 1];
      if (to <= from) continue;
      segments.push({
        from: from,
        to: to,
        deco: findCovering(decoList, from),
        hit: !!findCovering(hitList, from)
      });
    }

    if (!segments.length) return escapeHtml(source);

    /**
     * 相邻片段若属于同一条划线，必须合并成**一个** mark：
     * 否则同一条划线会被切成多个标签，圆角、底纹与批注小标都会重复出现。
     * 命中标记同理——连续命中合并成一个内层 mark。
     */
    var html = '';
    var cursor = 0;

    while (cursor < segments.length) {
      var deco = segments[cursor].deco;
      var grouped = [];

      while (cursor < segments.length && segments[cursor].deco === deco) {
        grouped.push(segments[cursor]);
        cursor++;
      }

      var inner = '';
      var gi = 0;
      while (gi < grouped.length) {
        if (grouped[gi].hit) {
          var hitText = '';
          while (gi < grouped.length && grouped[gi].hit) {
            hitText += source.slice(grouped[gi].from, grouped[gi].to);
            gi++;
          }
          inner += '<mark class="hit">' + escapeHtml(hitText) + '</mark>';
        } else {
          inner += escapeHtml(source.slice(grouped[gi].from, grouped[gi].to));
          gi++;
        }
      }

      if (deco) {
        inner = '<mark class="hl hl-' + deco.color + (deco.hasNote ? ' with-note' : '') +
          '" data-id="' + escapeAttr(deco.id) + '">' + inner + '</mark>';
      }

      html += inner;
    }

    return html;
  }

  /** 取某段落内所有标注的可点击 id（用于「按 id 定位到 DOM」）。 */
  function idsInParagraph(baseOffset, text, decorations) {
    var base = toInt(baseOffset, 0);
    var length = String(text == null ? '' : text).length;
    var out = [];

    (decorations || []).forEach(function (item) {
      if (!item) return;
      if (!clip(item.start, item.end, base, length)) return;
      out.push(item.id);
    });

    return out;
  }

  return {
    HL_COLORS: HL_COLORS,
    isColor: isColor,
    clip: clip,
    renderDecoratedHtml: renderDecoratedHtml,
    idsInParagraph: idsInParagraph
  };
});
