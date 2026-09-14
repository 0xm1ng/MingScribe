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

  // 任何环境都暴露这个桩，满足模块挂载守卫
  MingScribe.TauriBridge = { isTauri: isTauri };

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

  // 动态 import，避免网页版因缺少 @tauri-apps/api 而报错（此处已被 isTauri 守卫）
  Promise.all([import('@tauri-apps/api/core')])
    .then(function (mods) {
      var invoke = mods[0].invoke;

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
    })
    .catch(function (err) {
      console.warn('[MingScribe] Tauri 转换后端加载失败：', err);
    });
})();
