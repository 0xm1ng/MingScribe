/**
 * PDF 批注（框选高亮 / 手绘 / 便签）的纯逻辑与存储。
 *
 * 为什么不复用 src/annotations.js：
 *   那边（TXT / EPUB）的锚点是「章节序号 + 章节内字符偏移」，靠的是**文字**。
 *   PDF 是固定版式，扫描件更是一个字都没有（整页就是一张图），字符偏移无从谈起。
 *   硬凑成一套只会两边都不对，所以 PDF 另立一套锚点：**页码 + 归一化坐标**。
 *
 * 为什么坐标要归一化（0~1）：
 *   PDF 页面尺寸在文件里是固定的，但屏幕上渲染出来的像素尺寸会随
 *   「适应宽度 / 整页 / 手动缩放 / 换窗口大小」不断变。存像素的话，
 *   一改缩放所有批注就要集体漂移；存 0~1 的比例则与缩放完全无关 ——
 *   这相当于固定版式下的「不随排版漂移」，和字符偏移是同一个目的。
 *
 * 三种批注：
 *   rect —— 拖一个矩形（最常用：圈重点、盖住整行）
 *   ink  —— 自由笔迹，一串点连成折线
 *   note —— 便签，锚在一个点上，另有文字内容
 *
 * storage 通过参数注入（浏览器传 localStorage，测试传内存实现）。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.MingScribe = root.MingScribe || {};
    root.MingScribe.PdfAnnot = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var STORAGE_KEY = 'mingscribe.pdfmarks.v1';
  var KINDS = ['rect', 'ink', 'note'];
  var COLORS = ['yellow', 'green', 'blue', 'pink'];
  var MAX_NOTE = 4000;
  var MAX_RECORDS = 4000;
  var MAX_POINTS = 2000;

  /**
   * 一次拖拽要多小才算「点了一下、没想画东西」。
   * 取 0.006：A4 页面在屏幕上大约 600~900 px 宽，换算过来是 4~6 px，
   * 手抖出来的几像素不会被误存成一块脏高亮，而想画的下划线（整行高度约 0.025）不受影响。
   */
  var MIN_SIDE = 0.006;

  /** 手绘采样的最小点距（归一化）。太密没意义，只会让存储膨胀。 */
  var MIN_POINT_DIST = 0.0035;

  /** 便签命中半径 / 笔迹命中带宽（归一化）。 */
  var NOTE_HIT_RADIUS = 0.035;
  var INK_HIT_WIDTH = 0.014;

  function clamp01(v) {
    var n = Number(v);
    if (!isFinite(n)) return 0;
    if (n < 0) return 0;
    if (n > 1) return 1;
    return n;
  }

  function round4(v) {
    return Math.round(Number(v) * 10000) / 10000;
  }

  function normalizeColor(color) {
    return COLORS.indexOf(color) >= 0 ? color : COLORS[0];
  }

  function isKind(kind) {
    return KINDS.indexOf(kind) >= 0;
  }

  function makeId(seed) {
    var base = seed == null ? Date.now() : seed;
    return 'p' + base.toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function toInt(value, fallback) {
    var n = Number(value);
    if (!isFinite(n)) return fallback;
    return Math.floor(n);
  }

  /**
   * 两个角点 → 归一化矩形。反向拖（从右下往左上）也要得到同一个框，
   * 所以这里先取 min/max，而不是假定 a 是左上角。
   * 太小则返回 null，交给调用方当作「没画」。
   */
  function normalizeRect(ax, ay, bx, by) {
    var x1 = clamp01(ax);
    var y1 = clamp01(ay);
    var x2 = clamp01(bx);
    var y2 = clamp01(by);

    var x = Math.min(x1, x2);
    var y = Math.min(y1, y2);
    var w = Math.abs(x2 - x1);
    var h = Math.abs(y2 - y1);

    if (w < MIN_SIDE || h < MIN_SIDE) return null;
    return { x: round4(x), y: round4(y), w: round4(w), h: round4(h) };
  }

  function normalizeAt(x, y) {
    return { x: round4(clamp01(x)), y: round4(clamp01(y)) };
  }

  /** 相邻两点太近就丢掉，末尾那点永远保留（否则笔迹会短一截）。 */
  function thinPoints(points, minDist) {
    if (!points || !points.length) return [];
    var limit = Number(minDist);
    if (!isFinite(limit) || limit <= 0) limit = MIN_POINT_DIST;

    var out = [];
    var last = null;
    for (var i = 0; i < points.length; i++) {
      var p = points[i];
      if (!p) continue;
      var cur = normalizeAt(p.x, p.y);
      if (!last) {
        out.push(cur);
        last = cur;
        continue;
      }
      var dx = cur.x - last.x;
      var dy = cur.y - last.y;
      if (Math.sqrt(dx * dx + dy * dy) >= limit) {
        out.push(cur);
        last = cur;
      }
    }

    var tail = points[points.length - 1];
    if (tail) {
      var endPoint = normalizeAt(tail.x, tail.y);
      var lastKept = out[out.length - 1];
      if (!lastKept || lastKept.x !== endPoint.x || lastKept.y !== endPoint.y) out.push(endPoint);
    }

    return out.slice(0, MAX_POINTS);
  }

  /** 归一化矩形 → 像素盒子，供 SVG <rect> / 便签定位用。 */
  function rectBox(rect, width, height) {
    var w = Number(width) || 0;
    var h = Number(height) || 0;
    var r = rect || { x: 0, y: 0, w: 0, h: 0 };
    return {
      x: round4(r.x * w),
      y: round4(r.y * h),
      width: round4(r.w * w),
      height: round4(r.h * h)
    };
  }

  /** 归一化点 → 像素点。 */
  function pointAt(point, width, height) {
    var p = point || { x: 0, y: 0 };
    return { x: round4(p.x * (Number(width) || 0)), y: round4(p.y * (Number(height) || 0)) };
  }

  /**
   * 笔迹 → SVG path 的 d。
   * 单点笔迹（点了一下没拖）返回 ''，由调用方改画成一个小圆点 ——
   * 折线需要两个点才成立，画不出东西等于用户白点了。
   */
  function pathOf(points, width, height) {
    if (!points || points.length < 2) return '';
    var d = '';
    for (var i = 0; i < points.length; i++) {
      var p = pointAt(points[i], width, height);
      d += (i === 0 ? 'M' : ' L') + p.x + ' ' + p.y;
    }
    return d;
  }

  /** 点到线段的距离（像素）。命中判定用。 */
  function distToSegment(px, py, ax, ay, bx, by) {
    var vx = bx - ax;
    var vy = by - ay;
    var len2 = vx * vx + vy * vy;
    if (len2 === 0) return Math.sqrt((px - ax) * (px - ax) + (py - ay) * (py - ay));
    var t = ((px - ax) * vx + (py - ay) * vy) / len2;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    var cx = ax + t * vx;
    var cy = ay + t * vy;
    return Math.sqrt((px - cx) * (px - cx) + (py - cy) * (py - cy));
  }

  /**
   * 点（归一化）是否落在某条批注上 —— 用于「点中就能删」。
   * 三种批注的判定方式各自贴合自己的形状：矩形看框内、笔迹看离折线的距离、便签看半径。
   */
  function hitTest(record, nx, ny) {
    if (!record) return false;
    var x = clamp01(nx);
    var y = clamp01(ny);

    if (record.kind === 'rect') {
      var r = record.rect;
      if (!r) return false;
      return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
    }

    if (record.kind === 'note') {
      var a = record.at;
      if (!a) return false;
      return Math.sqrt((x - a.x) * (x - a.x) + (y - a.y) * (y - a.y)) <= NOTE_HIT_RADIUS;
    }

    if (record.kind === 'ink') {
      var pts = record.points || [];
      if (pts.length === 1) {
        return Math.sqrt((x - pts[0].x) * (x - pts[0].x) + (y - pts[0].y) * (y - pts[0].y)) <= INK_HIT_WIDTH;
      }
      for (var i = 1; i < pts.length; i++) {
        if (distToSegment(x, y, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y) <= INK_HIT_WIDTH) return true;
      }
    }

    return false;
  }

  /**
   * 校验并规整一条批注。形状不对直接抛 TypeError —— 与 Annotations.normalize 一致，
   * 让调用方拿到明确原因，而不是存进去一条画不出来的坏数据。
   */
  function normalize(input) {
    if (!input) throw new TypeError('缺少批注数据');
    if (!isKind(input.kind)) throw new TypeError('未知的批注类型：' + input.kind);

    var page = toInt(input.page, NaN);
    if (!isFinite(page) || page < 1) throw new TypeError('批注页码必须是从 1 开始的整数');

    var now = toInt(input.now, Date.now());
    var base = {
      id: input.id || makeId(),
      bookKey: String(input.bookKey || ''),
      page: page,
      kind: input.kind,
      color: normalizeColor(input.color),
      note: String(input.note == null ? '' : input.note).slice(0, MAX_NOTE),
      createdAt: toInt(input.createdAt, now),
      updatedAt: toInt(input.updatedAt, now)
    };

    if (input.kind === 'rect') {
      var r = input.rect || {};
      var rect = normalizeRect(Number(r.x), Number(r.y), Number(r.x) + Number(r.w), Number(r.y) + Number(r.h));
      if (!rect) throw new TypeError('框选范围太小，画不出东西');
      base.rect = rect;
      return base;
    }

    if (input.kind === 'note') {
      if (Number.isNaN(Number(input.x)) || Number.isNaN(Number(input.y))) {
        throw new TypeError('便签缺少锚点坐标');
      }
      base.at = normalizeAt(input.x, input.y);
      return base;
    }

    var points = thinPoints(input.points, input.minDist);
    if (!points.length) throw new TypeError('笔迹里没有有效的点');
    base.points = points;
    return base;
  }

  /** 排序：先页码，再创建时间（同页内按画的先后，撤销才符合直觉）。 */
  function byPage(a, b) {
    if (a.page !== b.page) return a.page - b.page;
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return String(a.id) < String(b.id) ? -1 : 1;
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
        return Array.isArray(parsed)
          ? parsed.filter(function (r) { return r && r.id && r.bookKey && isKind(r.kind); })
          : [];
      } catch (err) {
        // 存储损坏按空处理，别让批注数据把整本书打不开
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

    function listOf(bookKey) {
      return readAll()
        .filter(function (r) { return r.bookKey === bookKey; })
        .sort(byPage);
    }

    return {
      /** 某本书的全部批注，已按页码排序。 */
      list: listOf,

      /** 某本书某一页的批注，按画上去的先后排序。 */
      byPage: function (bookKey, page) {
        var p = toInt(page, 0);
        return listOf(bookKey).filter(function (r) { return r.page === p; });
      },

      /** 页码 → 条数，给「这一页有几处」这类提示用。 */
      counts: function (bookKey) {
        var out = {};
        listOf(bookKey).forEach(function (r) {
          out[r.page] = (out[r.page] || 0) + 1;
        });
        return out;
      },

      /** 整本一共多少条。 */
      size: function (bookKey) {
        return listOf(bookKey).length;
      },

      get: function (id) {
        var all = readAll();
        for (var i = 0; i < all.length; i++) {
          if (all[i].id === id) return all[i];
        }
        return null;
      },

      /**
       * 新增批注。返回 { ok, record } 或 { ok:false, reason, message }：
       *   reason='invalid' 形状非法；reason='storage' 写入失败且已回滚。
       */
      add: function (input) {
        var record;
        try {
          record = normalize(input);
        } catch (err) {
          return { ok: false, reason: 'invalid', message: err.message };
        }

        var list = readAll();
        if (list.some(function (r) { return r.id === record.id; })) {
          record = normalize(Object.assign({}, record, { id: makeId(record.createdAt) }));
        }

        if (!writeAll(list.concat([record]))) return { ok: false, reason: 'storage' };
        return { ok: true, record: record };
      },

      /** 改便签正文；空串表示清空内容但保留便签本身。 */
      updateNote: function (id, note) {
        return patch(id, { note: String(note == null ? '' : note).slice(0, MAX_NOTE) });
      },

      updateColor: function (id, color) {
        return patch(id, { color: normalizeColor(color) });
      },

      remove: function (id) {
        var list = readAll();
        var next = list.filter(function (r) { return r.id !== id; });
        if (next.length === list.length) return false;
        return writeAll(next);
      },

      /**
       * 撤销：删掉这本书里最后画上去的一条，返回它（没有则返回 null）。
       * 用「创建时间最晚」而不是「数组末位」：数组顺序会被改写记录（改颜色）打乱。
       */
      popLatest: function (bookKey) {
        var list = listOf(bookKey);
        if (!list.length) return null;
        var target = list[list.length - 1];
        if (!writeAll(readAll().filter(function (r) { return r.id !== target.id; }))) return null;
        return target;
      },

      /** 删除某本书的全部批注，返回删除条数。 */
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

    function patch(id, fields) {
      var all = readAll();
      var target = null;
      for (var i = 0; i < all.length; i++) {
        if (all[i].id === id) { target = all[i]; break; }
      }
      if (!target) return { ok: false, reason: 'missing' };

      var updated = Object.assign({}, target, fields, { updatedAt: Date.now() });
      var next = all.map(function (r) { return r.id === id ? updated : r; });
      if (!writeAll(next)) return { ok: false, reason: 'storage' };
      return { ok: true, record: updated };
    }
  }

  return {
    STORAGE_KEY: STORAGE_KEY,
    KINDS: KINDS,
    COLORS: COLORS,
    MAX_NOTE: MAX_NOTE,
    MAX_RECORDS: MAX_RECORDS,
    MAX_POINTS: MAX_POINTS,
    MIN_SIDE: MIN_SIDE,
    MIN_POINT_DIST: MIN_POINT_DIST,
    NOTE_HIT_RADIUS: NOTE_HIT_RADIUS,
    INK_HIT_WIDTH: INK_HIT_WIDTH,

    clamp01: clamp01,
    normalizeColor: normalizeColor,
    isKind: isKind,
    normalizeRect: normalizeRect,
    normalizeAt: normalizeAt,
    thinPoints: thinPoints,
    rectBox: rectBox,
    pointAt: pointAt,
    pathOf: pathOf,
    distToSegment: distToSegment,
    hitTest: hitTest,
    normalize: normalize,
    byPage: byPage,
    createStore: createStore
  };
});
