/**
 * 书籍缓存层：解决「关掉浏览器再打开，又要重新选一次文件」的问题。
 *
 * 先说清楚浏览器的硬限制（不是实现偷懒）：
 *   1. 网页从 <input type="file"> 拿到的路径是假的（C:\fakepath\xxx.txt）；
 *   2. File / Blob 对象不能序列化，存档到本地存储必然丢失。
 * 所以要「记住一本书」，只有两条可行路径：
 *
 *   路径 A（推荐，Chrome / Edge）：File System Access API 的文件句柄。
 *      - 句柄可存入 IndexedDB，下次直接重新读取原文件；
 *      - 不占用存储空间，且文件被修改后读到的始终是最新内容。
 *   路径 B（全浏览器兜底）：把正文文本存进 IndexedDB。
 *      - 通用，但占用存储；文件在外部被修改后不会同步。
 *
 * 存储后端通过参数注入（浏览器用 IndexedDB，测试用内存实现），
 * 便于在无 IndexedDB 的 Node 环境下完整测试业务逻辑。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.MingScribe = root.MingScribe || {};
    root.MingScribe.BookStore = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DB_NAME = 'mingscribe';
  var DB_VERSION = 1;
  var STORE_META = 'book-meta';
  var STORE_BLOB = 'book-blob';

  /** 与 Progress.bookKey 必须保持一致的算法（测试中有断言防止漂移）。 */
  function makeKey(name, size) {
    return String(name || '未命名') + '::' + String(size == null ? 0 : size);
  }

  /** 当前浏览器是否支持文件句柄持久化。 */
  function supportsFileSystemAccess() {
    return typeof window !== 'undefined' && typeof window.showOpenFilePicker === 'function';
  }

  /**
   * 确认文件句柄仍有读取权限；必要时向用户申请一次。
   * @returns {Promise<boolean>}
   */
  function ensurePermission(handle) {
    if (!handle || typeof handle.queryPermission !== 'function') {
      return Promise.resolve(false);
    }
    var opts = { mode: 'read' };
    return Promise.resolve()
      .then(function () { return handle.queryPermission(opts); })
      .then(function (state) {
        if (state === 'granted') return true;
        if (typeof handle.requestPermission !== 'function') return false;
        return Promise.resolve(handle.requestPermission(opts)).then(function (next) {
          return next === 'granted';
        });
      })
      .catch(function () { return false; });
  }

  /* ---------------- 内存后端（测试 / 降级用） ---------------- */

  function createMemoryBackend(seed) {
    var meta = {};
    var blob = {};

    if (seed) {
      Object.keys(seed).forEach(function (k) {
        meta[k] = seed[k].meta || null;
        blob[k] = seed[k].blob || null;
      });
    }

    function clone(value) {
      if (value == null) return value;
      // 文件句柄无法克隆，原样保留引用；普通对象做浅拷贝，避免调用方改动污染存储
      if (typeof value !== 'object') return value;
      if (typeof FileSystemFileHandle === 'function' && value instanceof FileSystemFileHandle) {
        return value;
      }
      var out = {};
      Object.keys(value).forEach(function (k) { out[k] = value[k]; });
      return out;
    }

    return {
      readMeta: function (key) { return Promise.resolve(clone(meta[key])); },
      writeMeta: function (key, value) { meta[key] = clone(value); return Promise.resolve(); },
      listMeta: function () {
        var out = [];
        Object.keys(meta).forEach(function (k) { if (meta[k]) out.push(clone(meta[k])); });
        return Promise.resolve(out);
      },
      readBlob: function (key) { return Promise.resolve(clone(blob[key])); },
      writeBlob: function (key, value) { blob[key] = clone(value); return Promise.resolve(); },
      remove: function (key) { delete meta[key]; delete blob[key]; return Promise.resolve(); },
      clear: function () { meta = {}; blob = {}; return Promise.resolve(); }
    };
  }

  /* ---------------- localStorage 后端（IndexedDB 不可用时的降级） ---------------- */

  /**
   * 用 localStorage 缓存正文。
   * 限制：容量通常只有 5MB 左右，且无法保存文件句柄（句柄不可序列化）。
   * 因此它只能作为 IndexedDB 不可用（例如某些 file:// 场景）时的次优解。
   */
  function createLocalStorageBackend(storage, options) {
    if (!storage || typeof storage.getItem !== 'function') {
      throw new TypeError('createLocalStorageBackend 需要一个 storage 实现');
    }
    var ns = (options && options.namespace) || 'mingscribe.book.v1';
    var indexKey = ns + ':index';

    function readIndex() {
      try {
        var parsed = JSON.parse(storage.getItem(indexKey));
        return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
      } catch (err) {
        return [];
      }
    }

    function writeIndex(list) {
      storage.setItem(indexKey, JSON.stringify(list));
    }

    function blobKey(key) { return ns + ':' + key; }

    return {
      readMeta: function (key) {
        return Promise.resolve().then(function () {
          var list = readIndex();
          for (var i = 0; i < list.length; i++) {
            if (list[i].key === key) return list[i];
          }
          return null;
        });
      },
      writeMeta: function (key, meta) {
        return Promise.resolve().then(function () {
          var list = readIndex().filter(function (m) { return !m || m.key !== key; });
          list.push(meta);
          writeIndex(list);
        });
      },
      listMeta: function () {
        return Promise.resolve().then(readIndex);
      },
      readBlob: function (key) {
        return Promise.resolve().then(function () {
          var raw = storage.getItem(blobKey(key));
          return raw == null ? null : { text: raw };
        });
      },
      writeBlob: function (key, value) {
        return Promise.resolve().then(function () {
          if (!value || typeof value.text !== 'string') {
            throw new Error('localStorage 后端无法保存文件句柄');
          }
          storage.setItem(blobKey(key), value.text);
        });
      },
      remove: function (key) {
        return Promise.resolve().then(function () {
          writeIndex(readIndex().filter(function (m) { return !m || m.key !== key; }));
          storage.removeItem(blobKey(key));
        });
      },
      clear: function () {
        return Promise.resolve().then(function () {
          var list = readIndex();
          list.forEach(function (m) { storage.removeItem(blobKey(m.key)); });
          storage.removeItem(indexKey);
        });
      }
    };
  }

  /* ---------------- IndexedDB 后端（浏览器） ---------------- */

  function reqToPromise(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
  }

  function createIdbBackend(options) {
    var opts = options || {};
    var dbName = opts.dbName || DB_NAME;
    var version = opts.version || DB_VERSION;
    var dbPromise = null;

    function open() {
      if (dbPromise) return dbPromise;
      dbPromise = new Promise(function (resolve, reject) {
        if (typeof indexedDB === 'undefined') {
          reject(new Error('当前环境不支持 IndexedDB'));
          return;
        }
        var request = indexedDB.open(dbName, version);
        request.onupgradeneeded = function () {
          var db = request.result;
          if (!db.objectStoreNames.contains(STORE_META)) {
            db.createObjectStore(STORE_META);
          }
          if (!db.objectStoreNames.contains(STORE_BLOB)) {
            db.createObjectStore(STORE_BLOB);
          }
        };
        request.onsuccess = function () { resolve(request.result); };
        request.onerror = function () { reject(request.error); };
        request.onblocked = function () { reject(new Error('IndexedDB 被其他标签页阻塞')); };
      });
      return dbPromise;
    }

    function withStore(name, mode) {
      return open().then(function (db) {
        return db.transaction(name, mode).objectStore(name);
      });
    }

    return {
      readMeta: function (key) {
        return withStore(STORE_META, 'readonly').then(function (os) {
          return reqToPromise(os.get(key));
        });
      },
      writeMeta: function (key, value) {
        return withStore(STORE_META, 'readwrite').then(function (os) {
          return reqToPromise(os.put(value, key));
        });
      },
      listMeta: function () {
        return withStore(STORE_META, 'readonly').then(function (os) {
          return reqToPromise(os.getAll());
        }).then(function (rows) {
          return (rows || []).filter(Boolean);
        });
      },
      readBlob: function (key) {
        return withStore(STORE_BLOB, 'readonly').then(function (os) {
          return reqToPromise(os.get(key));
        });
      },
      writeBlob: function (key, value) {
        return withStore(STORE_BLOB, 'readwrite').then(function (os) {
          return reqToPromise(os.put(value, key));
        });
      },
      remove: function (key) {
        return open().then(function (db) {
          return new Promise(function (resolve, reject) {
            var tx = db.transaction([STORE_META, STORE_BLOB], 'readwrite');
            tx.objectStore(STORE_META).delete(key);
            tx.objectStore(STORE_BLOB).delete(key);
            tx.oncomplete = function () { resolve(); };
            tx.onerror = function () { reject(tx.error); };
            tx.onabort = function () { reject(tx.error || new Error('事务被中止')); };
          });
        });
      },
      clear: function () {
        return open().then(function (db) {
          return new Promise(function (resolve, reject) {
            var tx = db.transaction([STORE_META, STORE_BLOB], 'readwrite');
            tx.objectStore(STORE_META).clear();
            tx.objectStore(STORE_BLOB).clear();
            tx.oncomplete = function () { resolve(); };
            tx.onerror = function () { reject(tx.error); };
            tx.onabort = function () { reject(tx.error || new Error('事务被中止')); };
          });
        });
      }
    };
  }

  /* ---------------- 业务逻辑 ---------------- */

  function buildMeta(input, source, now) {
    return {
      key: input.key,
      title: input.title || '',
      name: input.name || '未命名',
      size: Number(input.size) || 0,
      source: source,
      chapters: Number(input.chapters) || 0,
      chars: Number(input.chars) || 0,
      addedAt: now,
      updatedAt: now
    };
  }

  /**
   * 创建书籍缓存实例。
   * @param {object} backend 存储后端（createMemoryBackend / createIdbBackend）
   */
  function createStore(backend) {
    if (!backend || typeof backend.readMeta !== 'function') {
      throw new TypeError('createStore 需要一个存储后端实现');
    }

    return {
      /**
       * 缓存一本书。至少提供 text 或 handle 之一。
       * @returns {Promise<{ok: boolean, source: string, reason?: string}>}
       */
      put: function (input) {
        var data = input || {};
        if (!data.key) return Promise.reject(new TypeError('缓存书籍需要 key'));

        var hasHandle = !!data.handle;
        var hasText = typeof data.text === 'string' && data.text.length > 0;
        if (!hasHandle && !hasText) {
          return Promise.reject(new TypeError('缓存书籍需要 text 或 handle'));
        }

        // 句柄优先：不占存储，且始终读到最新内容
        var source = hasHandle ? 'handle' : 'text';
        var now = Date.now();
        var meta = buildMeta(data, source, now);

        return backend.readMeta(data.key)
          .catch(function () { return null; })
          .then(function (prev) {
            if (prev && prev.addedAt) meta.addedAt = prev.addedAt;
            return backend.writeMeta(data.key, meta);
          })
          .then(function () {
            return backend.writeBlob(data.key, hasHandle ? { handle: data.handle } : { text: data.text });
          })
          .then(function () {
            return { ok: true, source: source };
          })
          .catch(function (err) {
            // 正文写入失败（配额超限等）不应让阅读中断：清掉残缺记录，由上层降级
            return backend.remove(data.key)
              .catch(function () { /* 清理失败也无所谓 */ })
              .then(function () {
                return { ok: false, source: source, reason: (err && err.message) || String(err) };
              });
          });
      },

      /** 读取一本书（含正文或句柄）。 */
      get: function (key) {
        return Promise.all([backend.readMeta(key), backend.readBlob(key)])
          .then(function (pair) {
            var meta = pair[0];
            var blob = pair[1];
            if (!meta) return null;
            return {
              meta: meta,
              text: blob && typeof blob.text === 'string' ? blob.text : null,
              handle: blob && blob.handle ? blob.handle : null
            };
          });
      },

      /** 书架列表：只返回摘要，不读取正文，避免大文件拖慢渲染。 */
      list: function () {
        return backend.listMeta()
          .catch(function () { return []; })
          .then(function (rows) {
            return (rows || [])
              .filter(function (r) { return r && r.key; })
              .sort(function (a, b) {
                return (b.updatedAt || 0) - (a.updatedAt || 0);
              });
          });
      },

      remove: function (key) {
        return backend.remove(key);
      },

      clear: function () {
        return backend.clear();
      }
    };
  }

  return {
    DB_NAME: DB_NAME,
    DB_VERSION: DB_VERSION,
    STORE_META: STORE_META,
    STORE_BLOB: STORE_BLOB,
    makeKey: makeKey,
    supportsFileSystemAccess: supportsFileSystemAccess,
    ensurePermission: ensurePermission,
    createMemoryBackend: createMemoryBackend,
    createLocalStorageBackend: createLocalStorageBackend,
    createIdbBackend: createIdbBackend,
    createStore: createStore
  };
});
