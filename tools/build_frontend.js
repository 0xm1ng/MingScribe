#!/usr/bin/env node
/**
 * 把网页版前端产物收拢到 dist/，供 Tauri 桌面版嵌入。
 *
 * 为什么需要它（重要，别删）：
 * tauri.conf.json 的 frontendDist 指向哪个目录，Tauri 就会**递归嵌入该目录下的全部文件**
 * （tauri-codegen 用 WalkDir + follow_links(true) 遍历，没有任何 ignore 规则）。
 * 所以 frontendDist 绝不能指向项目根：那样 node_modules/、.git/、src-tauri/target/
 * 会被一起塞进安装包，构建极慢且产物巨大。
 *
 * 本脚本只复制真正需要的东西：index.html + src/。
 * dist/ 已在 .gitignore 中，不入库。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'dist');
const ENTRIES = ['index.html', 'src'];

function reset(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function copyEntry(name, dest) {
  const from = path.join(ROOT, name);
  const to = path.join(dest, name);
  if (!fs.existsSync(from)) {
    throw new Error(`缺少前端文件：${from}`);
  }
  fs.cpSync(from, to, { recursive: true });
}

function countFiles(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    n += e.isDirectory() ? countFiles(path.join(dir, e.name)) : 1;
  }
  return n;
}

reset(OUT);
for (const name of ENTRIES) copyEntry(name, OUT);

console.log(`[build_frontend] 已生成 ${path.relative(ROOT, OUT)}（${countFiles(OUT)} 个文件）`);
