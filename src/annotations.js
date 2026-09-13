/**
 * 标注（划线 + 批注）存储。
 *
 * 锚点约定：与阅读进度**共用同一套坐标系** —— 「章节序号 + 章节内字符偏移」。
 * 因此改字号、改窗口大小、甚至换字体，划线都不会漂移。
 * 绝不能用页码或屏幕坐标。
 *
 * 区间语义为左闭右开 [start, end)，首尾相接（a.end === b.start）不算重叠。
 *
 * storage 通过参数注入（浏览器传 localStorage，测试传内存实现）。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.MingScribe = root.MingScribe || {};
    root.MingScribe.Annotations = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var STORAGE_KEY = 'mingscribe.annotations.v1';
  var COLORS = ['yellow', 'green', 'blue', 'pink'];
  var MAX_NOTE = 4000;
  var MAX_RECORDS = 5000;

  function normalizeColor(color) {
    return COLORS.indexOf(color) >= 0 ? color : COLORS[0];
  }

  function toInt(value, fallback) {
    var n = Number(value);
    if (!isFinite(n)) return fallback;
    return Math.floor(n);
  }

  function makeId(seed) {
    var base = seed == null ? Date.now() : seed;
    return 'a' + base.toString(36) + Math.random().toString(36).slice(2, 7);
  }

  /**
   * 找出与候选标注冲突（区间相交）的已有标注；没有则返回 null。
   * 不同书、不同章节之间永不冲突。
   */
  function conflicts(list, candidate) {
    if (!candidate || !list) return null;
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      if (!item) continue;
      if (item.bookKey !== candidate.bookKey) continue;
      if (item.chapterIndex !== candidate.chapterIndex) continue;
      if (item.start < candidate.end && candidate.start < item.end) return item;
    }
    return null;
  }

  /** 校验并规整一条标注记录。区间非法时抛 TypeError。 */
  function normalize(input) {
    if (!input) throw new TypeError('缺少标注数据');
    var start = toInt(input.start, NaN);
    var end = toInt(input.end, NaN);
    if (!isFinite(start) || !isFinite(end)) throw new TypeError('标注区间必须是数字');
    if (end <= start) throw new TypeError('标注区间必须满足 end > start');
    if (start < 0) throw new TypeError('标注起点不能为负');

    var now = toInt(input.now, Date.now());
    return {
      id: input.id || makeId(),
      bookKey: String(input.bookKey || ''),
      chapterIndex: Math.max(0, toInt(input.chapterIndex, 0)),
      start: start,
      end: end,
      text: String(input.text == null ? '' : input.text),
      color: normalizeColor(input.color),
      note: String(input.note == null ? '' : input.note).slice(0, MAX_NOTE),
      createdAt: toInt(input.createdAt, now),
      updatedAt: toInt(input.updatedAt, now)
    };
  }

  /** 按阅读顺序排序：先章节，再章节内位置。 */
  function byPosition(a, b) {
    if (a.chapterIndex !== b.chapterIndex) return a.chapterIndex - b.chapterIndex;
    if (a.start !== b.start) return a.start - b.start;
    return a.end - b.end;
  }

  function createStore(storage) {
    if (!storage || typeof storage.getItem !== 'function') {
      throw new TypeError('createStore 需要一个 storage 实现（例如 localStorage）');
    }

    function readAll() {
      var raw = storage.getItem(STORAGE_KEY);
      if (!raw) return [];
      try {
        var parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter(function (r) { return r && r.id && r.bookKey; }) : [];
      } catch (err) {
        // 存储损坏时按空处理，不让阅读中断
        return [];
      }
    }

    /** 写入失败（配额超限等）返回 false，调用方据此回滚。 */
    function writeAll(list) {
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, MAX_RECORDS)));
        return true;
      } catch (err) {
        return false;
      }
    }

    return {
      /** 某本书的全部标注，已按位置排序。 */
      list: function (bookKey) {
        return readAll()
          .filter(function (r) { return r.bookKey === bookKey; })
          .sort(byPosition);
      },

      all: function () {
        return readAll().sort(byPosition);
      },

      get: function (id) {
        var list = readAll();
        for (var i = 0; i < list.length; i++) {
          if (list[i].id === id) return list[i];
        }
        return null;
      },

      /**
       * 新增标注。
       * 返回 { ok, record, reason, conflict }：
       *   reason='invalid'  区间非法
       *   reason='overlap'  与已有划线重叠（conflict 为冲突的那条）
       *   reason='storage'  写入失败，已回滚
       */
      add: function (input) {
        var record;
        try {
          record = normalize(input);
        } catch (err) {
          return { ok: false, reason: 'invalid', message: err.message };
        }

        var list = readAll();
        var conflict = conflicts(list, record);
        if (conflict) return { ok: false, reason: 'overlap', conflict: conflict };

        // id 冲突时重新生成，避免同 id 两条记录互相覆盖
        if (list.some(function (r) { return r.id === record.id; })) {
          record = normalize(Object.assign({}, record, { id: makeId(record.createdAt) }));
        }

        var next = list.concat([record]);
        if (!writeAll(next)) return { ok: false, reason: 'storage' };

        return { ok: true, record: record };
      },

      /** 更新批注文本；空字符串表示清空批注但保留划线。 */
      updateNote: function (id, note) {
        var list = readAll();
        var target = null;
        for (var i = 0; i < list.length; i++) {
          if (list[i].id === id) { target = list[i]; break; }
        }
        if (!target) return { ok: false, reason: 'missing' };

        var updated = Object.assign({}, target, {
          note: String(note == null ? '' : note).slice(0, MAX_NOTE),
          updatedAt: Date.now()
        });
        var next = list.map(function (r) { return r.id === id ? updated : r; });
        if (!writeAll(next)) return { ok: false, reason: 'storage' };

        return { ok: true, record: updated };
      },

      /** 只改颜色，不动批注与区间。 */
      updateColor: function (id, color) {
        var list = readAll();
        var target = null;
        for (var i = 0; i < list.length; i++) {
          if (list[i].id === id) { target = list[i]; break; }
        }
        if (!target) return { ok: false, reason: 'missing' };

        var updated = Object.assign({}, target, {
          color: normalizeColor(color),
          updatedAt: Date.now()
        });
        var next = list.map(function (r) { return r.id === id ? updated : r; });
        if (!writeAll(next)) return { ok: false, reason: 'storage' };

        return { ok: true, record: updated };
      },

      remove: function (id) {
        var list = readAll();
        var next = list.filter(function (r) { return r.id !== id; });
        if (next.length === list.length) return false;
        return writeAll(next);
      },

      /** 删除某本书的全部标注，返回删除条数。 */
      removeByBook: function (bookKey) {
        var list = readAll();
        var next = list.filter(function (r) { return r.bookKey !== bookKey; });
        var removed = list.length - next.length;
        if (removed > 0) writeAll(next);
        return removed;
      },

      clear: function () {
        try { storage.removeItem(STORAGE_KEY); } catch (err) { /* 忽略 */ }
      }
    };
  }

  return {
    STORAGE_KEY: STORAGE_KEY,
    COLORS: COLORS,
    MAX_NOTE: MAX_NOTE,
    MAX_RECORDS: MAX_RECORDS,
    normalizeColor: normalizeColor,
    conflicts: conflicts,
    normalize: normalize,
    byPosition: byPosition,
    createStore: createStore
  };
});
