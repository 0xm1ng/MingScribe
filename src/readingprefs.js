/**
 * 按书记忆排版（字号 / 行距 / 页宽）。
 *
 * 为什么需要它：
 *   以前字号、行距、页宽只有一份**全局**值。于是出现一个很别扭的现象——
 *   你在 A 书（小说）里把字号调到 22px，切到 B 书（教材，字本来就小）还是 22px，
 *   再切回 A 书时被 B 书的调整覆盖过，A 的 22px 也没了。一句话：**换本书就串味**。
 *
 *   现在改成三级回退：**本书偏好 → 全局偏好 → 内置默认值**。
 *   同时保留一条符合直觉的行为：在书里调排版时，除了写进本书，**也同步更新全局值**。
 *   这样「调一次，之后新书都跟着变」和「调过的书保持自己的」可以兼得——
 *   没单独调过的书没有本书记录，会一直跟随全局。
 *
 * 设计约束（与其他模块一致）：
 *   - 纯函数，不碰 DOM、不碰 localStorage。持久化由调用方（app.js）负责。
 *   - **不修改传入的 prefs**，一律返回新对象，便于测试也避免意外的共享引用。
 *   - 输入脏数据（null / 非对象 / 字段缺失）不会抛异常，一律安全回退。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MingScribe = root.MingScribe || {};
    root.MingScribe.ReadingPrefs = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** 参与「按书记忆」的字段白名单；merge 时不在表里的键一律丢弃。 */
  var FIELDS = ['fontSize', 'lineHeight', 'pageWidth'];
  /** 本书偏好挂在 prefs 上的容器键名。 */
  var CONTAINER = 'bookPrefs';

  function isObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  /** 取本书记录；不存在或数据脏时返回空对象，绝不返回 null。 */
  function bookRecord(prefs, bookKey) {
    if (!isObject(prefs) || !bookKey) return {};
    var c = prefs[CONTAINER];
    if (!isObject(c)) return {};
    var r = c[bookKey];
    return isObject(r) ? r : {};
  }

  /**
   * 解析出某本书最终应当使用的排版。
   *
   * @param {object} prefs    整个偏好对象（来自 localStorage）
   * @param {string} bookKey  书的唯一 key；为空表示「没在读书」，只看全局
   * @param {object} defaults 内置默认值 `{ fontSize, lineHeight, pageWidth }`
   * @returns {{fontSize:*, lineHeight:*, pageWidth:*, perBook:boolean}}
   *          `perBook` 表示这本书是否有自己的独立记录（UI 用来决定要不要显示「恢复默认」）
   */
  function resolve(prefs, bookKey, defaults) {
    var safePrefs = isObject(prefs) ? prefs : {};
    var safeDefaults = isObject(defaults) ? defaults : {};
    var record = bookRecord(safePrefs, bookKey);
    var out = { perBook: Object.keys(record).length > 0 };

    for (var i = 0; i < FIELDS.length; i++) {
      var f = FIELDS[i];
      var v = record[f];
      if (v === undefined || v === null) v = safePrefs[f];
      if (v === undefined || v === null) v = safeDefaults[f];
      out[f] = v;
    }
    return out;
  }

  /**
   * 把一次排版调整写回偏好，返回**新的** prefs 对象。
   *
   * @param {object} prefs
   * @param {string} bookKey 有值则同时写入本书；为空只写全局
   * @param {object} patch   如 `{ fontSize: 20 }`，只接受 FIELDS 里的字段
   * @returns {object} 新的 prefs（原对象不被修改）
   */
  function merge(prefs, bookKey, patch) {
    var safePrefs = isObject(prefs) ? prefs : {};
    var safePatch = isObject(patch) ? patch : {};
    var next = {};

    Object.keys(safePrefs).forEach(function (k) { next[k] = safePrefs[k]; });

    var changed = false;
    for (var i = 0; i < FIELDS.length; i++) {
      var f = FIELDS[i];
      if (!Object.prototype.hasOwnProperty.call(safePatch, f)) continue;
      next[f] = safePatch[f]; // 全局：作为之后新书的默认值
      changed = true;
    }

    if (changed && bookKey) {
      var container = {};
      var old = isObject(safePrefs[CONTAINER]) ? safePrefs[CONTAINER] : {};
      Object.keys(old).forEach(function (k) { container[k] = old[k]; });
      var record = isObject(container[bookKey]) ? container[bookKey] : {};
      var newRecord = {};
      Object.keys(record).forEach(function (k) { newRecord[k] = record[k]; });
      for (var j = 0; j < FIELDS.length; j++) {
        var f2 = FIELDS[j];
        if (Object.prototype.hasOwnProperty.call(safePatch, f2)) newRecord[f2] = safePatch[f2];
      }
      container[bookKey] = newRecord;
      next[CONTAINER] = container;
    }

    return next;
  }

  /** 这本书有没有自己的独立排版记录。 */
  function isCustomized(prefs, bookKey) {
    return Object.keys(bookRecord(prefs, bookKey)).length > 0;
  }

  /**
   * 丢弃某本书的独立排版，让它重新跟随全局。返回**新的** prefs。
   * 对没有记录的书是空操作（不会凭空造出 bookPrefs 容器）。
   */
  function resetBook(prefs, bookKey) {
    var safePrefs = isObject(prefs) ? prefs : {};
    if (!bookKey || !isObject(safePrefs[CONTAINER])) return safePrefs;

    var container = {};
    var old = safePrefs[CONTAINER];
    Object.keys(old).forEach(function (k) { container[k] = old[k]; });
    if (!Object.prototype.hasOwnProperty.call(container, bookKey)) return safePrefs;
    delete container[bookKey];

    var next = {};
    Object.keys(safePrefs).forEach(function (k) { next[k] = safePrefs[k]; });
    next[CONTAINER] = container;
    return next;
  }

  return {
    FIELDS: FIELDS,
    CONTAINER: CONTAINER,
    resolve: resolve,
    merge: merge,
    isCustomized: isCustomized,
    resetBook: resetBook
  };
}));
