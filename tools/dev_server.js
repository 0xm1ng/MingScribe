/**
 * 微型静态开发服务器，供 Tauri `tauri dev` 使用。
 *
 * 本项目是纯 HTML/CSS/JS，没有 Vite/Webpack 等前端构建工具；Tauri 默认期望
 * localhost:5173 上有一个 dev server，所以用这个脚本补上。它只在开发模式启动，
 * 产物构建（tauri build）直接读 frontendDist，不依赖它。
 */

var http = require('http');
var fs = require('fs');
var path = require('path');

var PORT = 5173;
var ROOT = path.resolve(__dirname, '..');

var MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.epub': 'application/epub+zip',
  '.txt': 'text/plain; charset=utf-8'
};

function mimeFor(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

var server = http.createServer(function (req, res) {
  var urlPath = decodeURIComponent(req.url.split('?')[0]);
  var safePath = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  var filePath = path.join(ROOT, safePath);

  // 防止越界访问
  if (!filePath.startsWith(ROOT + path.sep) && filePath !== ROOT) {
    res.statusCode = 403;
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, function (err, stats) {
    if (!err && stats.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }

    fs.readFile(filePath, function (err, data) {
      if (err) {
        res.statusCode = 404;
        res.end('Not found: ' + req.url);
        return;
      }

      res.setHeader('Content-Type', mimeFor(filePath));
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.end(data);
    });
  });
});

server.listen(PORT, function () {
  console.log('[dev-server] serving ' + ROOT + ' at http://localhost:' + PORT);
});

server.on('error', function (err) {
  console.error('[dev-server] failed to start:', err.message);
  process.exit(1);
});
