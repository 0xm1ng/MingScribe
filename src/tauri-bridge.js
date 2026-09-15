/**
 * Tauri 桌面版「格式转换」后端桥接。
 *
 * 行为：
 *  - 纯网页版（非 Tauri 运行时）：只挂一个无害的 `window.MingScribe.TauriBridge` 空桩，
 *    不执行任何 Tauri API、不报错、不影响网页版运行。所以本文件可被 index.html 直接引入。
 *  - 桌面版（Tauri 运行时）：再额外挂 `window.MingScribeConvert = { convert }`，
 *    app.js 的 `ingestViaConversion` 会用到它，把 MOBI/AZW3/DOCX/FB2 等转成 EPUB 后喂给现有解析层。
 *
 * 转换链路：浏览器拿到 File → 读成字节 → base64 → invoke('convert_to_epub') →
 * Rust 侧调 ebook-convert → 返回 EPUB 的 base64 → 还原成 ArrayBuffer 交给 Epub.parseEpub。
 */
(function () {
  'use strict';

  var root = typeof window !== 'undefined' ? window : this;
  var MingScribe = (root.MingScribe = root.MingScribe || {});

  function isTauri() {
    return !!(root.__TAURI__ || root.__TAURI_INTERNALS__);
  }

  // 任何环境都暴露这个桩，满足模块挂载守卫。
  // 网页版的 openExternal 统一返回 false，由调用方（app.js）降级到 window.open。
  MingScribe.TauriBridge = {
    isTauri: isTauri,
    openExternal: function () { return Promise.resolve(false); }
  };

  if (!isTauri()) return; // 纯网页版到此为止

  function bytesToBase64(bytes) {
    var binary = '';
    var chunk = 0x8000;
    for (var i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function base64ToArrayBuffer(b64) {
    var binary = atob(b64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  // 取 Tauri 全局 invoke：
  //   - v2 withGlobalTauri=true 暴露 window.__TAURI__.core.invoke
  //   - v2 内部实现也可能用 window.__TAURI_INTERNALS__
  // 这里不用 ES Module import，因为纯静态页面没有打包器，浏览器无法解析 bare specifier。
  function getTauriInvoke() {
    var tauri = root.__TAURI__ || root.__TAURI_INTERNALS__;
    if (!tauri) return null;
    if (tauri.core && typeof tauri.core.invoke === 'function') return tauri.core.invoke;
    if (typeof tauri.invoke === 'function') return tauri.invoke;
    return null;
  }

  var invoke = getTauriInvoke();
  if (!invoke) {
    console.warn('[MingScribe] 检测到 Tauri 全局对象，但未找到 invoke 方法');
    return;
  }

  // 用系统默认浏览器打开外部链接（Tauri 里 window.open 打不开系统浏览器）
  MingScribe.TauriBridge.openExternal = function (url) {
    return invoke('open_url', { url: url })
      .then(function () { return true; })
      .catch(function (err) {
        console.warn('[MingScribe] 打开外部链接失败', err);
        return false;
      });
  };

  // app.js 的 getConvertBackend 读取 window.MingScribeConvert；同时保留旧位置兼容
  root.MingScribeConvert = MingScribe.MingScribeConvert = {
    convert: function (file) {
      if (!file || typeof file.arrayBuffer !== 'function') {
        return Promise.reject(new Error('无效的文件对象'));
      }
      var ext = (String(file.name).split('.').pop() || 'bin').toLowerCase();
      return file.arrayBuffer().then(function (buf) {
        var inputB64 = bytesToBase64(new Uint8Array(buf));
        return invoke('convert_to_epub', { inputB64: inputB64, inputExt: ext });
      }).then(function (epubB64) {
        return base64ToArrayBuffer(epubB64);
      });
    }
  };
})();
