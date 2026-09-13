/**
 * 文本编码识别与解码。
 *
 * 为什么需要这个模块：
 * 中文网络小说大量以 GBK / GB18030 编码保存，若直接用 UTF-8 解码会得到乱码。
 * 本模块先按 BOM 判断，若无 BOM 则用「严格 UTF-8」试探，失败后回退到 GB18030。
 *
 * 同时兼容浏览器与 Node（UMD 风格），便于单元测试。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.MingScribe = root.MingScribe || {};
    root.MingScribe.Encoding = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var BOM_UTF8 = new Uint8Array([0xef, 0xbb, 0xbf]);

  /** 把 ArrayBuffer / 各类 TypedArray 统一成 Uint8Array。 */
  function toBytes(buffer) {
    if (buffer instanceof Uint8Array) return buffer;
    if (buffer instanceof ArrayBuffer) return new Uint8Array(buffer);
    if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(buffer)) {
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    }
    throw new TypeError('decodeBuffer 需要 ArrayBuffer 或 Uint8Array');
  }

  function hasPrefix(bytes, prefix) {
    if (bytes.length < prefix.length) return false;
    for (var i = 0; i < prefix.length; i++) {
      if (bytes[i] !== prefix[i]) return false;
    }
    return true;
  }

  function stripBom(text) {
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  }

  function decodeWith(bytes, label, fatal) {
    return new TextDecoder(label, { fatal: !!fatal }).decode(bytes);
  }

  /**
   * 解码字节流为文本。
   * @returns {{ text: string, encoding: string, viaBom: boolean }}
   */
  function decodeBuffer(buffer) {
    var bytes = toBytes(buffer);

    if (hasPrefix(bytes, BOM_UTF8)) {
      return { text: stripBom(decodeWith(bytes.subarray(3), 'utf-8', false)), encoding: 'utf-8', viaBom: true };
    }
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
      return { text: stripBom(decodeWith(bytes.subarray(2), 'utf-16le', false)), encoding: 'utf-16le', viaBom: true };
    }
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      return { text: stripBom(decodeWith(bytes.subarray(2), 'utf-16be', false)), encoding: 'utf-16be', viaBom: true };
    }

    try {
      return { text: stripBom(decodeWith(bytes, 'utf-8', true)), encoding: 'utf-8', viaBom: false };
    } catch (err) {
      return { text: stripBom(decodeWith(bytes, 'gb18030', false)), encoding: 'gb18030', viaBom: false };
    }
  }

  /** 替换字符 U+FFFD 的占比，用于判断解码结果是否可疑（0 ~ 1）。 */
  function garbledRatio(text) {
    if (!text) return 0;
    var bad = 0;
    for (var i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 0xfffd) bad++;
    }
    return bad / text.length;
  }

  return {
    decodeBuffer: decodeBuffer,
    stripBom: stripBom,
    garbledRatio: garbledRatio,
    toBytes: toBytes
  };
});
