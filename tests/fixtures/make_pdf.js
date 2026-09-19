/**
 * 生成最小可用的多页 PDF，供测试与截图使用（纯手写，无第三方依赖）。
 *
 * 为什么不用现成的样例文件：仓库里不该塞二进制，而 PDF 端到端又必须有
 * 「能被 pdf.js 正常解析、且有多页」的输入。这里直接按 PDF 1.4 规范拼出来，
 * 内容是每页一行 Helvetica 文字，足以验证渲染 / 翻页 / 进度。
 *
 * @param {number} pageCount 页数
 * @returns {string} PDF 文件内容（latin1 字符串，写文件时请用 latin1 编码）
 */
function buildPdf(pageCount) {
  const n = Math.max(1, Math.floor(Number(pageCount) || 1));

  const kids = [];
  for (let i = 0; i < n; i++) kids.push((3 + i) + ' 0 R');

  const fontId = 3 + n;          // 字体对象
  const contentBase = fontId + 1; // 每页一个内容流对象
  const total = contentBase + n;  // 对象编号 1 .. total-1

  const bodies = [];
  bodies[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  bodies[2] = '<< /Type /Pages /Kids [' + kids.join(' ') + '] /Count ' + n + ' >>';

  for (let i = 0; i < n; i++) {
    bodies[3 + i] =
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ' +
      '/Resources << /Font << /F1 ' + fontId + ' 0 R >> >> ' +
      '/Contents ' + (contentBase + i) + ' 0 R >>';
  }

  bodies[fontId] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

  for (let i = 0; i < n; i++) {
    const text = 'BT /F1 48 Tf 72 700 Td (MingScribe PDF Page ' + (i + 1) + ') Tj ET';
    bodies[contentBase + i] = '<< /Length ' + text.length + ' >>\nstream\n' + text + '\nendstream';
  }

  let out = '%PDF-1.4\n';
  const offsets = [];
  for (let i = 1; i < total; i++) {
    offsets[i] = out.length;
    out += i + ' 0 obj\n' + bodies[i] + '\nendobj\n';
  }

  const xrefStart = out.length;
  out += 'xref\n0 ' + total + '\n0000000000 65535 f \n';
  for (let i = 1; i < total; i++) {
    out += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  }
  out += 'trailer\n<< /Size ' + total + ' /Root 1 0 R >>\nstartxref\n' + xrefStart + '\n%%EOF\n';

  return out;
}

/** PDF 字符串字面量里只有三个字符需要转义。 */
function escapePdfString(text) {
  return String(text).replace(/([\\()])/g, '\\$1');
}

/**
 * 生成「排版更像样」的多页 PDF，专门给文档配图用。
 *
 * 与 buildPdf 的唯一区别是每页可以有多行文字：单行页面截出来近乎空白，
 * 既看不出排版，也演示不了「同一页多处命中」。约定 `# ` 开头的一行当标题。
 *
 * 只支持 ASCII —— 内置的 Helvetica 不含中文字形，写中文只会得到一堆方块。
 *
 * @param {string[][]} pages 每页若干行文字
 * @returns {string} PDF 文件内容（latin1 字符串，写文件时请用 latin1 编码）
 */
function buildRichPdf(pages) {
  const list = Array.isArray(pages) && pages.length ? pages : [['# Empty']];
  const n = list.length;

  const kids = [];
  for (let i = 0; i < n; i++) kids.push((3 + i) + ' 0 R');

  const fontId = 3 + n;
  const contentBase = fontId + 1;
  const total = contentBase + n;

  const bodies = [];
  bodies[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  bodies[2] = '<< /Type /Pages /Kids [' + kids.join(' ') + '] /Count ' + n + ' >>';

  for (let i = 0; i < n; i++) {
    bodies[3 + i] =
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ' +
      '/Resources << /Font << /F1 ' + fontId + ' 0 R >> >> ' +
      '/Contents ' + (contentBase + i) + ' 0 R >>';
  }

  bodies[fontId] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

  for (let i = 0; i < n; i++) {
    const lines = Array.isArray(list[i]) ? list[i] : [];
    let y = 790;
    let text = '';

    for (const raw of lines) {
      const isHeading = /^#\s*/.test(raw);
      const content = escapePdfString(isHeading ? raw.replace(/^#\s*/, '') : raw);
      const size = isHeading ? 22 : 12.5;
      y -= isHeading ? 34 : 19;
      // 每行单独一个 BT/ET 并给绝对坐标：省掉 state 机，也就不会因为
      // 忘了设 TL 让 T* 把整段文字叠在一起
      if (y < 50) break;
      text += 'BT /F1 ' + size + ' Tf 64 ' + y + ' Td (' + content + ') Tj ET\n';
    }

    bodies[contentBase + i] = '<< /Length ' + text.length + ' >>\nstream\n' + text + '\nendstream';
  }

  let out = '%PDF-1.4\n';
  const offsets = [];
  for (let i = 1; i < total; i++) {
    offsets[i] = out.length;
    out += i + ' 0 obj\n' + bodies[i] + '\nendobj\n';
  }

  const xrefStart = out.length;
  out += 'xref\n0 ' + total + '\n0000000000 65535 f \n';
  for (let i = 1; i < total; i++) {
    out += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  }
  out += 'trailer\n<< /Size ' + total + ' /Root 1 0 R >>\nstartxref\n' + xrefStart + '\n%%EOF\n';

  return out;
}

module.exports = { buildPdf, buildRichPdf };
