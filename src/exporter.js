/**
 * 把标注导出为 Markdown（纯函数，可在 Node 下测试）。
 *
 * 目标读者是笔记软件（Obsidian / Typora 等）：原文用引用块呈现，
 * 这样即使原文自带 `#`、`-`、`>` 等 Markdown 记号，也不会把文档结构搞乱。
 *
 * 时间戳一律通过 options.now 注入，保证输出可复现、测试稳定。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.MingScribe = root.MingScribe || {};
    root.MingScribe.Exporter = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var COLOR_LABEL = {
    yellow: '黄色',
    green: '绿色',
    blue: '蓝色',
    pink: '粉色'
  };

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  function formatDateTime(ts) {
    var d = ts instanceof Date ? ts : new Date(ts);
    if (isNaN(d.getTime())) d = new Date(0);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  /** 去掉 Windows / macOS 文件名非法字符。 */
  function sanitizeFileName(name, fallback) {
    var cleaned = String(name == null ? '' : name)
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^\.+/, '');
    if (!cleaned) cleaned = fallback || '未命名';
    return cleaned.slice(0, 80);
  }

  /** 原文放进引用块：逐行加 `> `，空行也要占位，否则引用会断。 */
  function quoteBlock(text) {
    return String(text == null ? '' : text)
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map(function (line) { return line ? '> ' + line : '>'; })
      .join('\n');
  }

  function colorLabel(color) {
    return COLOR_LABEL[color] || COLOR_LABEL.yellow;
  }

  /**
   * 生成 Markdown 文本。
   *
   * @param {object} book        中间格式书籍对象（用 chapters[i].title 作分组标题）
   * @param {Array}  annotations 标注列表（内部会自行按位置排序）
   * @param {object} options     { now, sourceName }
   * @returns {string}
   */
  function toMarkdown(book, annotations, options) {
    var opt = options || {};
    var now = opt.now == null ? Date.now() : opt.now;
    var list = (annotations || [])
      .filter(function (a) { return a && isFinite(a.chapterIndex) && isFinite(a.start); })
      .slice()
      .sort(function (a, b) {
        if (a.chapterIndex !== b.chapterIndex) return a.chapterIndex - b.chapterIndex;
        if (a.start !== b.start) return a.start - b.start;
        return a.end - b.end;
      });

    var bookTitle = (book && book.title) || '未命名';
    var sourceName = opt.sourceName || (book && book.name) || '';
    var chapters = (book && book.chapters) || [];

    // 章节已变化（书被替换、重切章节）导致无法定位的标注单独统计，不静默丢弃
    var located = [];
    var orphan = [];
    list.forEach(function (a) {
      if (chapters[a.chapterIndex]) located.push(a);
      else orphan.push(a);
    });

    var noted = located.filter(function (a) { return a.note && a.note.trim(); }).length;

    var lines = [];
    lines.push('# ' + bookTitle + ' · 读书笔记');
    lines.push('');
    if (sourceName) lines.push('- 来源文件：' + sourceName);
    lines.push('- 导出时间：' + formatDateTime(now));
    lines.push('- 划线 ' + located.length + ' 条，其中 ' + noted + ' 条含批注');
    if (orphan.length) {
      lines.push('- 另有 ' + orphan.length + ' 条因章节结构变化无法定位，已跳过');
    }

    if (!located.length) {
      lines.push('');
      lines.push('> 这本书还没有任何划线。');
      return lines.join('\n') + '\n';
    }

    // 按章节分组，保持阅读顺序
    var groups = [];
    var index = {};
    located.forEach(function (a) {
      var key = a.chapterIndex;
      if (!index[key]) {
        index[key] = { title: chapters[key].title || ('第 ' + (key + 1) + ' 节'), items: [] };
        groups.push(index[key]);
      }
      index[key].items.push(a);
    });

    var seq = 0;
    groups.forEach(function (group) {
      lines.push('');
      lines.push('---');
      lines.push('');
      lines.push('## ' + group.title);
      lines.push('');

      group.items.forEach(function (a) {
        seq++;
        lines.push('### ' + seq + ' · ' + colorLabel(a.color));
        lines.push('');
        lines.push(quoteBlock(a.text));
        lines.push('');
        if (a.note && a.note.trim()) {
          lines.push('**批注**：' + a.note.replace(/\r?\n/g, ' ').trim());
          lines.push('');
        }
      });
    });

    return lines.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
  }

  return {
    COLOR_LABEL: COLOR_LABEL,
    formatDateTime: formatDateTime,
    sanitizeFileName: sanitizeFileName,
    colorLabel: colorLabel,
    toMarkdown: toMarkdown
  };
});
