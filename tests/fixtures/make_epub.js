'use strict';

/**
 * 测试夹具：在内存中构造合法的 EPUB 文件（ZIP 结构）。
 *
 * 为什么不用现成的 EPUB 样本文件：
 *   1. 二进制文件进 Git 后无法 review，坏没坏全靠猜；
 *   2. 自己构造可以精确控制每一种分支（EPUB3 nav / EPUB2 NCX / 无目录 /
 *      空章节 / 损坏文件），断言才有明确的目标值。
 *
 * ZIP 写法：本地文件头 + 中央目录 + EOCD，全部字段手工填充。
 * 压缩用 node:zlib 的 deflateRawSync（与 ZIP method 8 的 raw deflate 一致）。
 */

const zlib = require('node:zlib');

let CRC_TABLE = null;

function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

/**
 * 构造 ZIP。
 * @param {Array<{name: string, data: string|Buffer, store?: boolean}>} entries
 */
function buildZip(entries) {
  const chunks = [];
  const centrals = [];
  let offset = 0;

  for (const e of entries) {
    const nameBytes = Buffer.from(e.name, 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8');
    const comp = e.store ? data : zlib.deflateRawSync(data);
    const crc = crc32(data);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); // 本地文件头签名
    lh.writeUInt16LE(20, 4);         // 版本
    lh.writeUInt16LE(0, 6);          // flags
    lh.writeUInt16LE(e.store ? 0 : 8, 8); // 压缩方式：0=stored 8=deflate
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0x5821, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBytes.length, 26);
    lh.writeUInt16LE(0, 28);
    chunks.push(lh, nameBytes, comp);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); // 中央目录签名
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(e.store ? 0 : 8, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0x5821, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBytes.length, 28);
    ch.writeUInt16LE(0, 30); // extra
    ch.writeUInt16LE(0, 32); // comment
    ch.writeUInt16LE(0, 34); // disk
    ch.writeUInt16LE(0, 36); // internal attrs
    ch.writeUInt32LE(0, 38); // external attrs
    ch.writeUInt32LE(offset, 42);   // 本地头偏移
    centrals.push(ch, nameBytes);

    offset += 30 + nameBytes.length + comp.length;
  }

  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, cd, eocd]);
}

/* ---------------- EPUB 内容 ---------------- */

const XHTML_HEAD =
  '<?xml version="1.0" encoding="utf-8"?>\n' +
  '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">' +
  '<head><title>页</title><style>p{color:red}</style></head><body>';

function chapterDoc(title, paras) {
  const body = paras.map((p) => `<p>${p}</p>`).join('');
  return XHTML_HEAD + `<h1>${title}</h1>` + body + '</body></html>';
}

const CHAPTERS = [
  {
    file: 'chapter1.xhtml',
    title: '第一章 起点',
    html: chapterDoc('第一章 起点', [
      '这是第一章的正文，包含实体：A &amp; B &lt;C&gt; 与中文数字 &#x4e2d;&#x6587;。',
      '第二段文字用来验证分块换行。'
    ])
  },
  {
    file: 'chapter2.xhtml',
    title: '第二章 转折',
    html: chapterDoc('第二章 转折', [
      '<div>嵌套 div 里的<b>加粗</b>文字。</div>',
      '带图片：<img src="x.png" alt="示意图说明"/> 之后的内容。'
    ])
  },
  {
    file: 'chapter3.xhtml',
    title: '第三章 结局',
    html: chapterDoc('第三章 结局', [
      '最后一章内容，<br/>换行之后的部分。'
    ])
  }
];

const BOOK_TITLE = '测试之书：EPUB 样例';

function navDoc(titles) {
  const items = titles
    .map((t, i) => `<li><a href="chapter${i + 1}.xhtml">${t}</a></li>`)
    .join('');
  return XHTML_HEAD + `<nav epub:type="toc"><ol>${items}</ol></nav></body></html>`;
}

function ncxDoc(titles) {
  const points = titles
    .map((t, i) => `<navPoint id="np${i + 1}"><navLabel><text>${t}</text></navLabel>` +
      `<content src="chapter${i + 1}.xhtml"/></navPoint>`)
    .join('');
  return `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head><meta name="dtb:uid" content="test"/></head>
<docTitle><text>${BOOK_TITLE}</text></docTitle>
<navMap>${points}</navMap>
</ncx>`;
}

function opfDoc(opts) {
  const items = ['  <item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>'];
  CHAPTERS.slice(1).forEach((c, i) => {
    items.push(`  <item id="c${i + 2}" href="${c.file}" media-type="application/xhtml+xml"/>`);
  });
  if (opts.nav) items.push('  <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>');
  if (opts.ncx) items.push('  <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>');
  if (opts.blank) items.push('  <item id="blank" href="blank.xhtml" media-type="application/xhtml+xml"/>');

  const refs = CHAPTERS.map((c, i) => `  <itemref idref="c${i + 1}"/>`);
  if (opts.blank) refs.push('  <itemref idref="blank"/>');

  return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="${opts.nav ? '3.0' : '2.0'}" unique-identifier="id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
  <dc:title>${BOOK_TITLE}</dc:title>
  <dc:creator>测试作者</dc:creator>
  <dc:language>zh</dc:language>
</metadata>
<manifest>
${items.join('\n')}
</manifest>
<spine${opts.ncx && !opts.nav ? ' toc="ncx"' : ''}>
${refs.join('\n')}
</spine>
</package>`;
}

/**
 * 构造样例 EPUB。
 * @param {{nav?: boolean, ncx?: boolean, blank?: boolean, navTitles?: string[], ncxTitles?: string[]}} opts
 */
function buildSampleEpub(opts) {
  const o = Object.assign({ nav: true, ncx: true, blank: false }, opts);
  const titles = o.ncxTitles || CHAPTERS.map((c) => c.title);
  const navTitles = o.navTitles || CHAPTERS.map((c) => c.title);

  const entries = [
    // mimetype 按规范必须第一个且不压缩
    { name: 'mimetype', data: 'application/epub+zip', store: true },
    { name: 'META-INF/container.xml', data: '<?xml version="1.0"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>', store: true },
    { name: 'OEBPS/content.opf', data: opfDoc(o) }
  ];

  if (o.nav) entries.push({ name: 'OEBPS/nav.xhtml', data: navDoc(navTitles) });
  if (o.ncx) entries.push({ name: 'OEBPS/toc.ncx', data: ncxDoc(titles) });
  CHAPTERS.forEach((c, i) => {
    // 第一章不压缩，其余压缩：两种压缩方式都必须能读
    entries.push({ name: 'OEBPS/' + c.file, data: c.html, store: i === 0 });
  });
  if (o.blank) {
    entries.push({ name: 'OEBPS/blank.xhtml', data: XHTML_HEAD + '<p>　</p><p> </p></body></html>' });
  }

  return buildZip(entries);
}

/** 损坏的 EPUB，用于错误分支测试。 */
function buildBrokenEpub(kind) {
  if (kind === 'notzip') return Buffer.from('这不是一个zip文件，只是普通文本。');
  if (kind === 'nocontainer') {
    return buildZip([{ name: 'mimetype', data: 'application/epub+zip', store: true }]);
  }
  if (kind === 'nospine') {
    const opf = '<?xml version="1.0"?><package><metadata></metadata><manifest></manifest><spine></spine></package>';
    return buildZip([
      { name: 'mimetype', data: 'application/epub+zip', store: true },
      { name: 'META-INF/container.xml', data: '<container><rootfile full-path="content.opf"/></container>', store: true },
      { name: 'content.opf', data: opf }
    ]);
  }
  if (kind === 'nocontent') {
    const opf = '<?xml version="1.0"?><package><metadata><dc:title xmlns:dc="x">空书</dc:title></metadata>' +
      '<manifest><item id="c1" href="c.xhtml" media-type="application/xhtml+xml"/></manifest>' +
      '<spine><itemref idref="c1"/></spine></package>';
    return buildZip([
      { name: 'mimetype', data: 'application/epub+zip', store: true },
      { name: 'META-INF/container.xml', data: '<container><rootfile full-path="content.opf"/></container>', store: true },
      { name: 'content.opf', data: opf },
      { name: 'c.xhtml', data: XHTML_HEAD + '</body></html>' }
    ]);
  }
  throw new Error('未知损坏类型: ' + kind);
}

module.exports = {
  buildZip,
  buildSampleEpub,
  buildBrokenEpub,
  chapterDoc,
  CHAPTERS,
  BOOK_TITLE
};
