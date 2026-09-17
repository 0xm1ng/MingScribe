#!/usr/bin/env node
/**
 * 标签 ↔ 版本号 一致性守卫。
 *
 * 规则：仓库里任何 `vX.Y.Z` 标签，其 X.Y.Z 必须与**该标签所指那次提交**里的
 * 版本号字段完全一致：
 *   package.json · src-tauri/Cargo.toml · src-tauri/tauri.conf.json · src/app.js(APP_VERSION)
 *
 * 其中「该提交里还不存在的字段」会被跳过而不是判失败 ——
 * 例如 v0.1.0 那年 `src/app.js` 里还没有 APP_VERSION（它是 v0.1.1 才加的）。
 * 但只要字段存在，就必须彼此一致、且等于标签号。
 *
 * 为什么需要它
 * ------------
 * 发布过的事故：本地 0.1.0 与线上 v0.1.0 内容不同却同号（重打包时忘了 bump）。
 * 现在把它写成 CI 守卫 —— 标签一推上去，GitHub 立刻告诉你它有没有对上代码。
 *
 * 用法
 * ----
 *   node tools/check_tag_version.js         自动取 CI 的 GITHUB_REF_NAME，或本地 HEAD 上的标签
 *   node tools/check_tag_version.js v0.3.0  检查指定标签
 *   node tools/check_tag_version.js --all   审计本地全部 vX.Y.Z 标签（历史体检）
 *
 * 退出码：0 = 一致；1 = 有不一致；2 = 没有可检查的标签
 */

'use strict';

const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const onCi = !!process.env.GITHUB_ACTIONS;

/** 版本号字段的读取规则（文件 + 正则，第一个捕获组即版本号）。 */
const FIELDS = [
  { file: 'package.json', re: /"version"\s*:\s*"([^"]+)"/ },
  { file: 'src-tauri/Cargo.toml', re: /^version\s*=\s*"([^"]+)"/m },
  { file: 'src-tauri/tauri.conf.json', re: /"version"\s*:\s*"([^"]+)"/ },
  { file: 'src/app.js', re: /var APP_VERSION\s*=\s*'([^']+)'/, label: 'src/app.js (APP_VERSION)' }
];

function git(args) {
  try {
    return execFileSync('git', ['-C', ROOT].concat(args), {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
  } catch (e) {
    return '';
  }
}

/** 读取某个 ref 下的版本号字段（不依赖工作区，历史标签也查得准）。 */
function versionsAt(ref) {
  return FIELDS.map(function (f) {
    const txt = git(['show', ref + ':' + f.file]);
    const m = txt ? txt.match(f.re) : null;
    return { file: f.label || f.file, value: m ? m[1] : null, exists: !!m };
  });
}

function auditTag(tag) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
    return { tag: tag, ok: false, reason: '标签格式不是 vX.Y.Z', versions: [], missing: [] };
  }
  const all = versionsAt(tag);
  const present = all.filter(function (v) { return v.exists; });
  const missing = all.filter(function (v) { return !v.exists; });
  const want = tag.slice(1);

  if (!present.length) {
    return { tag: tag, ok: false, versions: all, missing: [], reason: '该提交里读不到任何版本号字段' };
  }
  if (new Set(present.map(function (v) { return v.value; })).size !== 1) {
    return { tag: tag, ok: false, versions: all, missing: missing, reason: '版本号字段之间不一致' };
  }
  if (present[0].value !== want) {
    return {
      tag: tag, ok: false, versions: all, missing: missing,
      reason: '标签写 ' + want + '，代码里是 ' + present[0].value
    };
  }
  return { tag: tag, ok: true, versions: all, missing: missing, reason: '' };
}

function detail(r) {
  const out = [];
  r.versions.forEach(function (v) {
    out.push('      ' + v.file.padEnd(26) + ' ' + (v.exists ? v.value : '(该版本还没有这个字段)'));
  });
  return out;
}

/* ---------------- --all：历史体检 ---------------- */
if (process.argv[2] === '--all') {
  const tags = git(['tag', '--list', 'v*']).split('\n').filter(Boolean);
  if (!tags.length) {
    process.stdout.write('本地没有任何 v* 标签。\n');
    process.exit(2);
  }
  const results = tags.map(auditTag);
  const bad = results.filter(function (r) { return !r.ok; });
  process.stdout.write('本地标签审计（共 ' + tags.length + ' 个）\n');
  process.stdout.write('='.repeat(46) + '\n');
  results.forEach(function (r) {
    process.stdout.write('  ' + (r.ok ? '✓ ' : '✗ ') + r.tag.padEnd(8) + (r.ok ? '' : r.reason) + '\n');
    if (!r.ok || (r.missing && r.missing.length)) detail(r).forEach(function (l) { process.stdout.write(l + '\n'); });
  });
  process.stdout.write('\n结论：' + (bad.length ? bad.length + ' 个标签与代码对不上 ✗' : '全部一致 ✓') + '\n');
  process.exit(bad.length ? 1 : 0);
}

/* ---------------- 单个标签（CI 主路径） ---------------- */
let tag = process.argv[2] || process.env.GITHUB_REF_NAME || '';
if (!tag) tag = git(['describe', '--tags', '--exact-match', 'HEAD']);

function fail(msg) {
  if (onCi) process.stdout.write('::error::' + msg.replace(/\n/g, '%0A') + '\n');
  else process.stdout.write('✗ ' + msg + '\n');
  process.exit(1);
}

if (!tag) {
  process.stdout.write('当前 HEAD 上没有标签，也不是 CI 的标签构建 —— 跳过。\n');
  process.stdout.write('（要审计全部标签：node tools/check_tag_version.js --all）\n');
  process.exit(2);
}

const r = auditTag(tag);
if (!r.ok) {
  fail('标签 ' + tag + ' 不合格：' + r.reason + '\n' + detail(r).join('\n') +
    '\n要么把版本号改成 ' + tag.replace(/^v/, '') + '，要么把标签打成 v' + (r.versions[0].value || '?') + '。');
}
process.stdout.write('✓ 标签 ' + tag + ' 与版本号一致（' + tag.replace(/^v/, '') + '）\n');
if (r.missing.length) {
  process.stdout.write('  注：' + r.missing.map(function (v) { return v.file; }).join('、') +
    ' 在该版本还不存在，已跳过。\n');
}
process.exit(0);
