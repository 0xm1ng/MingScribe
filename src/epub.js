/**
 * 解析层：EPUB → 统一中间格式（与 parser.js 的 TXT 输出同一结构）。
 *
 * EPUB 本质是一个 ZIP 包，里面装着 XHTML 章节和一份「阅读顺序清单」（OPF spine）。
 * 本模块零外部依赖：
 *   - 自带 ZIP 读取（支持 stored 与 deflate 两种压缩）；
 *   - inflate 通过参数注入：浏览器默认用 DecompressionStream('deflate-raw')，
 *     Node 测试用 zlib.inflateRawSync，保证业务逻辑可在无浏览器环境完整测试；
 *   - XHTML → 纯文本用标签扫描完成，不依赖 DOMParser（DOMParser 无法在 Worker/Node 用）。
 *
 * 章节标题优先级：EPUB3 nav 目录 > EPUB2 NCX 目录 > 章内第一个标题 > 「第 N 节」。
 *
 * 输出的 chapters 偏移与 TXT 完全一致：text 为各章正文以 \n 连接的全文，
 * chapter.start / end 是全文字符偏移，进度、划线、搜索共用这一套坐标系。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.MingScribe = root.MingScribe || {};
    root.MingScribe.Epub = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ---------------- 解压 ---------------- */

  /** 浏览器默认 inflate：raw deflate（ZIP 的 method 8）。 */
  function defaultInflate(data) {
    if (typeof DecompressionStream === 'undefined' || typeof Blob === 'undefined' ||
        typeof Response === 'undefined') {
      return Promise.reject(new Error('当前环境不支持 deflate 解压，无法读取这个 EPUB'));
    }
    var stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).arrayBuffer().then(function (buf) { return new Uint8Array(buf); });
  }

  /* ---------------- ZIP 读取 ---------------- */

  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return ((b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + (b[o + 3] * 0x1000000)) >>> 0; }

  /** 从尾部向前找 End of Central Directory 记录（考虑最长 64KB 的注释区）。 */
  function findEocd(b) {
    if (b.length < 22) return -1;
    var min = Math.max(0, b.length - 22 - 65535);
    for (var i = b.length - 22; i >= min; i--) {
      if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 0x05 && b[i + 3] === 0x06) return i;
    }
    return -1;
  }

  function ZipReader(buffer, inflate) {
    this.bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    this.inflate = inflate || defaultInflate;
    this.entries = null;
  }

  /** 解析中央目录，建立 文件名 → {method, compSize, localOffset} 索引。 */
  ZipReader.prototype.ensureIndex = function () {
    if (this.entries) return this.entries;

    var b = this.bytes;
    var eocd = findEocd(b);
    if (eocd < 0) throw new Error('不是有效的 EPUB 文件（缺少 ZIP 目录）');

    var count = u16(b, eocd + 10);
    var cdOffset = u32(b, eocd + 16);
    var entries = {};
    var p = cdOffset;

    for (var i = 0; i < count; i++) {
      if (p + 46 > b.length || u32(b, p) !== 0x02014b50) break;
      var method = u16(b, p + 10);
      var compSize = u32(b, p + 20);
      var nameLen = u16(b, p + 28);
      var extraLen = u16(b, p + 30);
      var commentLen = u16(b, p + 32);
      var localOffset = u32(b, p + 42);
      var name = utf8Decode(b.subarray(p + 46, p + 46 + nameLen));
      entries[name] = { method: method, compSize: compSize, localOffset: localOffset };
      p += 46 + nameLen + extraLen + commentLen;
    }

    this.entries = entries;
    return entries;
  };

  function lookupInsensitive(entries, name) {
    var lower = String(name).toLowerCase();
    var keys = Object.keys(entries);
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].toLowerCase() === lower) return entries[keys[i]];
    }
    return null;
  }

  /** 读取一个文件，返回解压后的字节。结构错误也以 Promise 拒绝，调用方统一走 catch。 */
  ZipReader.prototype.read = function (name) {
    var entries;
    try {
      entries = this.ensureIndex();
    } catch (err) {
      return Promise.reject(err);
    }
    var entry = entries[name] || lookupInsensitive(entries, name);
    if (!entry) return Promise.resolve(null);

    if (entry.method === 99) {
      return Promise.reject(new Error('这本 EPUB 带有加密（DRM），无法读取'));
    }

    var b = this.bytes;
    var lo = entry.localOffset;
    if (u32(b, lo) !== 0x04034b50) {
      return Promise.reject(new Error('EPUB 内部结构损坏'));
    }
    var nameLen = u16(b, lo + 26);
    var extraLen = u16(b, lo + 28);
    var dataStart = lo + 30 + nameLen + extraLen;
    var data = b.subarray(dataStart, dataStart + entry.compSize);

    if (entry.method === 0) return Promise.resolve(data);
    if (entry.method === 8) {
      try {
        return Promise.resolve(this.inflate(data)).then(function (out) {
          if (!(out instanceof Uint8Array)) {
            if (out && out.buffer != null) return new Uint8Array(out.buffer, out.byteOffset || 0, out.byteLength);
            throw new Error('解压结果无效');
          }
          return out;
        });
      } catch (err) {
        return Promise.reject(err);
      }
    }
    return Promise.reject(new Error('不支持的压缩方式：' + entry.method));
  };

  /** 读取一个文本文件。 */
  ZipReader.prototype.readText = function (name) {
    return this.read(name).then(function (bytes) {
      return bytes == null ? null : utf8Decode(bytes);
    });
  };

  function utf8Decode(bytes) {
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(bytes);
    // 极端环境兜底：按 Latin-1 读出（中文会乱码，但结构解析不受影响）
    var out = '';
    for (var i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
    return out;
  }

  /* ---------------- XML / XHTML 处理 ---------------- */

  var NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };

  function decodeEntities(s) {
    if (!s) return s;
    return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, function (all, body) {
      if (body.charAt(0) === '#') {
        var code;
        if (body.charAt(1) === 'x' || body.charAt(1) === 'X') code = parseInt(body.slice(2), 16);
        else code = parseInt(body.slice(1), 10);
        if (!isFinite(code) || code < 0 || code > 0x10ffff) return all;
        try { return String.fromCodePoint(code); } catch (err) { return all; }
      }
      var mapped = NAMED_ENTITIES[body.toLowerCase()];
      return mapped != null ? mapped : all;
    });
  }

  /** 从一个标签文本里取属性值（容忍单双引号与实体编码）。 */
  function getAttr(tag, name) {
    var re = new RegExp('(?:^|\\s)' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')', 'i');
    var m = re.exec(tag);
    if (!m) return null;
    return decodeEntities(m[1] != null ? m[1] : m[2]);
  }

  /** 块级元素结束标签 → 换行。 */
  var BLOCK_CLOSE = /<\/(?:p|div|section|article|header|footer|nav|aside|main|figure|figcaption|h[1-6]|li|ul|ol|dl|dt|dd|blockquote|pre|table|thead|tbody|tr|td|th|caption)\s*>/gi;

  /**
   * XHTML → 纯文本。
   * 约定：块级元素边界产生换行；行内空白压成单空格；图片保留 alt 提示
   * （与 TXT 阅读的「[图片：xxx]」占位约定一致，界面层已有弱化样式）。
   */
  function xhtmlToText(html) {
    var s = String(html || '');

    s = s.replace(/<!--[\s\S]*?-->/g, '');
    s = s.replace(/<head[\s\S]*?<\/head\s*>/gi, '');
    s = s.replace(/<(script|style|svg|template|iframe|object|embed|audio|video|canvas|map|form)[\s\S]*?<\/\1\s*>/gi, '');

    s = s.replace(/<img\b[^>]*>/gi, function (tag) {
      var alt = getAttr(tag, 'alt');
      alt = alt ? alt.replace(/\s+/g, ' ').trim() : '';
      return '\n[图片：' + (alt || '无描述') + ']\n';
    });

    s = s.replace(/<(?:br|hr)\b[^>]*\/?>/gi, '\n');
    s = s.replace(BLOCK_CLOSE, '\n');
    s = s.replace(/<[^>]*>/g, '');
    s = decodeEntities(s);

    var lines = s.split('\n');
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var t = lines[i].replace(/\s+/g, ' ').trim();
      if (t) out.push(t);
    }
    return out.join('\n');
  }

  /** 章内第一个标题，用作目录标题的兜底。 */
  function firstHeading(html) {
    var m = /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]\s*>/i.exec(html);
    if (!m) return '';
    var text = decodeEntities(m[1].replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
    return text.length > 60 ? text.slice(0, 60) : text;
  }

  /* ---------------- OPF / 目录 ---------------- */

  function isHtmlItem(item) {
    var type = item.mediaType || '';
    if (/xhtml|html|xml|dtbook/.test(type)) return true;
    return /\.(xhtml|html|htm)$/i.test(item.href || '');
  }

  function parseOpf(opfXml) {
    var title = '';
    var tm = /<dc:title[^>]*>([\s\S]*?)<\/dc:title\s*>/i.exec(opfXml);
    if (tm) title = decodeEntities(tm[1].replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();

    var manifest = {};
    var itemRe = /<item\s[^>]*>/gi;
    var m;
    while ((m = itemRe.exec(opfXml))) {
      var tag = m[0];
      var id = getAttr(tag, 'id');
      var href = getAttr(tag, 'href');
      if (!id || !href) continue;
      manifest[id] = {
        href: href,
        mediaType: (getAttr(tag, 'media-type') || '').toLowerCase(),
        properties: (getAttr(tag, 'properties') || '').toLowerCase()
      };
    }

    var spine = [];
    var refRe = /<itemref\s[^>]*>/gi;
    while ((m = refRe.exec(opfXml))) {
      var idref = getAttr(m[0], 'idref');
      if (idref && manifest[idref]) spine.push(manifest[idref]);
    }

    return { title: title, manifest: manifest, spine: spine };
  }

  /** EPUB3 nav 目录：文件路径 → 标题。 */
  function parseNavToc(navHtml) {
    var map = {};
    var navBlocks = navHtml.match(/<nav\b[\s\S]*?<\/nav\s*>/gi) || [];
    var toc = null;
    for (var i = 0; i < navBlocks.length; i++) {
      if (/epub:type\s*=\s*["']toc["']/i.test(navBlocks[i])) { toc = navBlocks[i]; break; }
    }
    if (!toc && navBlocks.length) toc = navBlocks[0];
    if (!toc) return map;

    var aRe = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
    var m;
    while ((m = aRe.exec(toc))) {
      var href = getAttr('<a ' + m[1] + '>', 'href');
      if (!href) continue;
      var file = href.split('#')[0];
      var text = decodeEntities(m[2].replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
      if (file && text && !map[file]) map[file] = text;
    }
    return map;
  }

  /** EPUB2 NCX 目录：文件路径 → 标题。 */
  function parseNcxToc(ncxXml) {
    var map = {};
    var re = /<navLabel>\s*<text>([\s\S]*?)<\/text\s*>\s*<\/navLabel>([\s\S]*?)<content\b([^>]*?)\/?>/gi;
    var m;
    while ((m = re.exec(ncxXml))) {
      var text = decodeEntities(m[1].replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
      var src = getAttr('<content ' + m[3] + '>', 'src');
      if (!src) continue;
      var file = src.split('#')[0];
      if (file && text && !map[file]) map[file] = text;
    }
    return map;
  }

  function safeDecodePath(p) {
    try { return decodeURIComponent(p); } catch (err) { return p; }
  }

  /** 相对路径解析（rel 相对于 base 所在目录，base 传 OPF 的完整路径或目录）。 */
  function resolvePath(base, rel) {
    var stack;
    if (!base) {
      stack = [];
    } else {
      stack = base.replace(/^\//, '').split('/')
        // base 以 / 结尾时 split 会产生空段，拼起来会变成双斜杠
        .filter(function (s) { return s !== ''; });
      if (base.charAt(base.length - 1) !== '/' && stack.length) stack.pop();
    }
    var parts = String(rel).replace(/^\//, '').split('/');
    for (var i = 0; i < parts.length; i++) {
      if (parts[i] === '.' || parts[i] === '') continue;
      if (parts[i] === '..') { if (stack.length) stack.pop(); continue; }
      stack.push(safeDecodePath(parts[i]));
    }
    return stack.join('/');
  }

  /* ---------------- 组装 ---------------- */

  function buildBook(title, docs, titleMap) {
    var chapters = [];
    var offset = 0;

    docs.forEach(function (doc) {
      var text = xhtmlToText(doc.html);
      if (!text) return; // 空白章节跳过，保持目录干净

      chapters.push({
        index: chapters.length,
        title: titleMap[doc.path] || firstHeading(doc.html) || ('第 ' + (chapters.length + 1) + ' 节'),
        start: offset,
        end: offset + text.length,
        text: text
      });
      offset += text.length + 1;
    });

    if (!chapters.length) throw new Error('EPUB 里没有可读的文字内容');

    var full = chapters.map(function (c) { return c.text; }).join('\n');
    return {
      title: title || '',
      text: full,
      totalChars: full.length,
      chapters: chapters,
      stats: { chapterCount: chapters.length, recognizedChapters: chapters.length }
    };
  }

  /**
   * 解析 EPUB。
   * @param {ArrayBuffer|Uint8Array} buffer EPUB 原始字节
   * @param {object} [options] { inflate } 注入解压实现（测试用）
   * @returns {Promise<book>} 与 parseTxt 相同结构的统一中间格式
   */
  function parseEpub(buffer, options) {
    var opts = options || {};
    var zip = new ZipReader(buffer, opts.inflate);

    return zip.readText('META-INF/container.xml').then(function (containerXml) {
      if (!containerXml) throw new Error('EPUB 结构不完整：缺少 container.xml');
      var rm = /<rootfile[^>]*\bfull-path\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(containerXml);
      if (!rm) throw new Error('EPUB 结构不完整：找不到 OPF 描述文件');
      var opfPath = decodeEntities(rm[1] != null ? rm[1] : rm[2]);

      return zip.readText(opfPath).then(function (opfXml) {
        if (!opfXml) throw new Error('EPUB 结构不完整：OPF 读取失败');
        return buildFromOpf(zip, opfPath, opfXml);
      });
    });
  }

  function buildFromOpf(zip, opfPath, opfXml) {
    var opf = parseOpf(opfXml);
    var opfDir = opfPath.indexOf('/') === -1 ? '' : opfPath.slice(0, opfPath.lastIndexOf('/') + 1);

    // 目录标题来源：EPUB3 nav 优先，EPUB2 NCX 兜底；都读不到时用章内标题。
    // 注意：目录里的 href 是相对于目录文件自身的路径，必须重定位到 ZIP 全路径才能对上章节。
    var navItem = null;
    var ncxItem = null;
    Object.keys(opf.manifest).forEach(function (id) {
      var it = opf.manifest[id];
      if (/(^|\s)nav(\s|$)/.test(it.properties)) navItem = it;
      if (it.mediaType === 'application/x-dtbncx+xml') ncxItem = it;
    });

    function rekeyMap(map, baseDir) {
      var out = {};
      Object.keys(map).forEach(function (k) {
        out[resolvePath(baseDir, k)] = map[k];
      });
      return out;
    }

    var titleJobs = [];
    if (navItem) {
      var navPath = resolvePath(opfDir, navItem.href);
      var navDir = navPath.indexOf('/') === -1 ? '' : navPath.slice(0, navPath.lastIndexOf('/') + 1);
      titleJobs.push(zip.readText(navPath).then(function (html) {
        return rekeyMap(parseNavToc(html), navDir);
      }, function () { return {}; }));
    }
    if (ncxItem && !navItem) {
      titleJobs.push(zip.readText(resolvePath(opfDir, ncxItem.href)).then(function (xml) {
        return rekeyMap(parseNcxToc(xml), opfDir);
      }, function () { return {}; }));
    }

    return Promise.all(titleJobs).then(function (maps) {
      var titleMap = {};
      maps.forEach(function (mp) {
        Object.keys(mp).forEach(function (k) { if (!(k in titleMap)) titleMap[k] = mp[k]; });
      });

      var spine = opf.spine.filter(isHtmlItem);
      if (!spine.length) {
        // spine 缺失或全被过滤：退化为 manifest 文档顺序，保证还能读
        spine = [];
        Object.keys(opf.manifest).forEach(function (id) {
          var it = opf.manifest[id];
          if (isHtmlItem(it) && !/(^|\s)nav(\s|$)/.test(it.properties)) spine.push(it);
        });
      }
      if (!spine.length) throw new Error('EPUB 里没有可读的章节（spine 为空）');

      var docJobs = spine.map(function (item) {
        var zipPath = resolvePath(opfDir, item.href);
        return zip.readText(zipPath).then(function (html) {
          return { path: zipPath, html: html || '' };
        }, function () {
          return { path: zipPath, html: '' };
        });
      });

      return Promise.all(docJobs).then(function (docs) {
        return buildBook(opf.title, docs, titleMap);
      });
    });
  }

  /**
   * 从缓存重建书籍（缓存了正文与章节边界后，无需原文件即可恢复）。
   * 偏移按当前 text 重算，即使 text 与 toc 来源略有出入也不会越界。
   */
  function rebuildFromCache(text, toc, title) {
    if (typeof text !== 'string' || !Array.isArray(toc) || !toc.length) return null;

    var chapters = [];
    var offset = 0;

    for (var i = 0; i < toc.length; i++) {
      var t = toc[i];
      var start = Number(t.start);
      var end = Number(t.end);
      if (!isFinite(start) || !isFinite(end) || end < start) continue;
      var chunk = text.slice(Math.max(0, Math.min(start, text.length)), Math.max(0, Math.min(end, text.length)));
      // 越界/失效的条目钳制后为空串，直接跳过（buildBook 也从不产生空章节）
      if (!chunk) continue;
      chapters.push({
        index: chapters.length,
        title: t.title || ('第 ' + (chapters.length + 1) + ' 节'),
        start: offset,
        end: offset + chunk.length,
        text: chunk
      });
      offset += chunk.length + 1;
    }

    if (!chapters.length) return null;

    var full = chapters.map(function (c) { return c.text; }).join('\n');
    return {
      title: title || '',
      text: full,
      totalChars: full.length,
      chapters: chapters,
      stats: { chapterCount: chapters.length, recognizedChapters: chapters.length }
    };
  }

  /** 按扩展名判断是否按 EPUB 处理。 */
  function isEpubName(name) {
    return /\.(epub)$/i.test(String(name || ''));
  }

  return {
    parseEpub: parseEpub,
    rebuildFromCache: rebuildFromCache,
    isEpubName: isEpubName,
    xhtmlToText: xhtmlToText,
    decodeEntities: decodeEntities,
    ZipReader: ZipReader
  };
});
