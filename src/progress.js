/**
 * 阅读进度存储。
 *
 * 锚点约定（不要改）：用「章节序号 + 章节内字符偏移」记录位置。
 * 绝不能用页码 —— 字号或窗口尺寸一变，页码就整体错位。
 *
 * storage 通过参数注入（浏览器传 localStorage，测试传内存实现）。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.MingScribe = root.MingScribe || {};
    root.MingScribe.Progress = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var STORAGE_KEY = 'mingscribe.progress.v1';
  var MAX_RECORDS = 20;

  /** 书籍唯一标识：文件名 + 字节长度。用户重新选择同一个文件时即可匹配上。 */
  function bookKey(name, size) {
    return String(name || '未命名') + '::' + String(size == null ? 0 : size);
  }

  function toInt(value, fallback) {
    var n = Number(value);
    if (!isFinite(n)) return fallback;
    return Math.floor(n);
  }

  function clampIndex(value, max) {
    var n = toInt(value, 0);
    if (n < 0) return 0;
    return n > max ? max : n;
  }

  function clampOffset(value, max) {
    var n = toInt(value, 0);
    if (n < 0) return 0;
    return n > max ? max : n;
  }

  /** 把可能越界的 (章节序号, 字符偏移) 修正到合法范围内。 */
  function resolvePosition(book, chapterIndex, charOffset) {
    if (!book || !book.chapters || !book.chapters.length) {
      return { chapterIndex: 0, charOffset: 0 };
    }
    var idx = clampIndex(chapterIndex, book.chapters.length - 1);
    var chapter = book.chapters[idx];
    var span = chapter.end - chapter.start;
    return { chapterIndex: idx, charOffset: clampOffset(charOffset, span) };
  }

  /** 已读百分比（0 ~ 100，保留两位小数）。 */
  function computePercent(book, chapterIndex, charOffset) {
    if (!book || !book.chapters || !book.chapters.length) return 0;
    var total = book.totalChars || 0;
    if (total <= 0) return 0;
    var pos = resolvePosition(book, chapterIndex, charOffset);
    var chapter = book.chapters[pos.chapterIndex];
    var absolute = chapter.start + pos.charOffset;
    var pct = (absolute / total) * 100;
    if (pct < 0) pct = 0;
    if (pct > 100) pct = 100;
    return Math.round(pct * 100) / 100;
  }

  /** 组装一条进度记录。 */
  function makeRecord(book, meta, chapterIndex, charOffset, now) {
    var pos = resolvePosition(book, chapterIndex, charOffset);
    var chapter = (book && book.chapters && book.chapters[pos.chapterIndex]) || null;
    return {
      key: meta && meta.key ? meta.key : bookKey(meta && meta.name, meta && meta.size),
      name: (meta && meta.name) || '未命名',
      size: (meta && meta.size) || 0,
      title: (meta && meta.title) || '',
      chapterIndex: pos.chapterIndex,
      charOffset: pos.charOffset,
      chapterTitle: chapter ? chapter.title : '',
      chapterCount: book && book.chapters ? book.chapters.length : 0,
      totalChars: book ? book.totalChars : 0,
      percent: computePercent(book, pos.chapterIndex, pos.charOffset),
      updatedAt: now == null ? Date.now() : now
    };
  }

  /** 创建存储实例。storage 需实现 getItem / setItem / removeItem。 */
  function createStore(storage) {
    if (!storage || typeof storage.getItem !== 'function') {
      throw new TypeError('createStore 需要一个 storage 实现（例如 localStorage）');
    }

    function readAll() {
      var raw = storage.getItem(STORAGE_KEY);
      if (!raw) return [];
      try {
        var parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch (err) {
        // 存储内容损坏时不应让应用崩溃，直接当作空记录
        return [];
      }
    }

    function writeAll(list) {
      var trimmed = list.slice(0, MAX_RECORDS);
      storage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
      return trimmed;
    }

    return {
      /** 按最近阅读时间倒序返回。 */
      list: function () {
        return readAll().sort(function (a, b) {
          return (b && b.updatedAt ? b.updatedAt : 0) - (a && a.updatedAt ? a.updatedAt : 0);
        });
      },
      get: function (key) {
        var list = readAll();
        for (var i = 0; i < list.length; i++) {
          if (list[i] && list[i].key === key) return list[i];
        }
        return null;
      },
      save: function (record) {
        if (!record || !record.key) throw new TypeError('保存进度需要 record.key');
        var list = readAll().filter(function (r) {
          return !r || r.key !== record.key;
        });
        list.unshift(record);
        writeAll(list);
        return record;
      },
      remove: function (key) {
        return writeAll(
          readAll().filter(function (r) {
            return !r || r.key !== key;
          })
        );
      },
      clear: function () {
        storage.removeItem(STORAGE_KEY);
      }
    };
  }

  return {
    STORAGE_KEY: STORAGE_KEY,
    MAX_RECORDS: MAX_RECORDS,
    bookKey: bookKey,
    computePercent: computePercent,
    resolvePosition: resolvePosition,
    makeRecord: makeRecord,
    createStore: createStore
  };
});
