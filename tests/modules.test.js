/**
 * 模块挂载守卫。
 *
 * 为什么需要这个测试（真实踩过的坑）：
 *   Node 测试用 require() 加载模块，走的是 UMD 的 `module.exports` 分支；
 *   而浏览器里没有 module，走的是 `root.MingScribe.X = api` 分支。
 *   两条分支互相独立 —— 只要模块漏写全局挂载，或 app.js 忘了写
 *   `var X = window.MingScribe.X;`，**所有单元测试依然全绿**，
 *   但页面一点就报 `X is not defined`，整个阅读器不可用。
 *
 * 本测试在「无 module / 无 require」的沙箱里加载每个 src 脚本，
 * 模拟真实的浏览器加载环境，并校验 app.js 的引用与声明一一对应。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');

/** index.html 里按顺序引入的脚本（顺序本身就是加载契约）。 */
const SCRIPT_SRCS = Array.from(HTML.matchAll(/<script\s+src="([^"]+)"\s*><\/script>/g)).map((m) => m[1]);

/** 在模拟浏览器的沙箱里执行一个脚本；沙箱内没有 module / exports / require。 */
function loadLikeBrowser(relPath) {
  const code = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: relPath });
  return sandbox;
}

/** 加载全部非 app 脚本，得到「模块名 → 提供它的脚本」映射。 */
const PRODUCED = (function () {
  const map = {};
  SCRIPT_SRCS.filter((src) => !/app\.js$/.test(src)).forEach((src) => {
    const sandbox = loadLikeBrowser(src);
    assert.ok(sandbox.MingScribe, src + ' 没有在浏览器环境下创建 window.MingScribe');
    Object.keys(sandbox.MingScribe).forEach((name) => {
      if (map[name]) throw new Error('模块名 ' + name + ' 被 ' + src + ' 与 ' + map[name] + ' 重复定义');
      map[name] = src;
    });
  });
  return map;
})();

test('index.html 引入了全部解析层与界面脚本，且 app.js 最后加载', () => {
  ['src/encoding.js', 'src/parser.js', 'src/epub.js', 'src/app.js'].forEach((f) => {
    assert.ok(SCRIPT_SRCS.includes(f), 'index.html 未引入 ' + f);
  });
  assert.equal(SCRIPT_SRCS[SCRIPT_SRCS.length - 1], 'src/app.js', 'app.js 必须最后加载');
});

test('每个非 app 脚本都在浏览器环境下暴露了模块', () => {
  const scripts = SCRIPT_SRCS.filter((src) => !/app\.js$/.test(src));
  assert.ok(scripts.length >= 9, '引入的脚本数量异常：' + scripts.length);

  const providers = new Set(Object.values(PRODUCED));
  scripts.forEach((src) => {
    assert.ok(providers.has(src), src + ' 加载后没有暴露任何模块');
  });
});

test('app.js 用到的每个模块都必须在 window.MingScribe 上真实存在', () => {
  const referenced = new Set(
    Array.from(APP.matchAll(/window\.MingScribe\.([A-Za-z][A-Za-z0-9]*)/g)).map((m) => m[1])
  );

  assert.ok(referenced.size > 0, 'app.js 没有引用任何模块？');
  referenced.forEach((name) => {
    assert.ok(PRODUCED[name], 'app.js 引用了 window.MingScribe.' + name + '，但没有任何脚本提供它');
  });
});

test('app.js 里出现的模块标识符都必须先声明（防止漏写 var X = window.MingScribe.X）', () => {
  const missing = [];

  Object.keys(PRODUCED).forEach((name) => {
    // 只认「模块名后跟成员访问」，例如 Epub.parseEpub(...)
    const used = new RegExp('(^|[^\\w$.])' + name + '\\.[A-Za-z_]', 'm').test(APP);
    if (!used) return;

    const declared = new RegExp('var\\s+' + name + '\\s*=\\s*window\\.MingScribe\\.' + name + '\\b').test(APP);
    if (!declared) missing.push(name);
  });

  assert.deepEqual(
    missing,
    [],
    'app.js 使用了这些模块却没声明：' + missing.join(', ') + '（浏览器里会报 X is not defined）'
  );
});
