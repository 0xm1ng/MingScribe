#!/usr/bin/env node
/**
 * MingScribe 发布同步自检：本地仓库 ↔ GitHub 远端是否一致。
 *
 * 为什么需要它
 * ------------
 * 本机环境里 `git push` 会被宿主注入的本地代理拦掉（CONNECT 隧道正常，
 * 但 `git-receive-pack` 的请求被直接断开），于是本地很容易悄悄攒下一堆
 * 「只在本地存在」的提交与标签。历史上就因此出现过：
 *   - 线上只有 v0.1.1，本地却已经走到 v0.3.0，看板对不上；
 *   - v0.1.1 那个标签只在远端有、本地没有。
 * 这个脚本把这类偏差一次性列清楚，避免「同名不同内容」或「线上缺版本」重演。
 *
 * 用法
 * ----
 *   node tools/check_release_sync.js          人类可读报告
 *   node tools/check_release_sync.js --json   机器可读
 *
 * 退出码
 * ------
 *   0 = 完全同步
 *   1 = 存在偏差（按报告里的「待办」处理）
 *   2 = 网络不可用，无法判断（不是代码问题，稍后重试）
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OWNER = '0xm1ng';
const REPO = 'MingScribe';
const API = 'https://api.github.com/repos/' + OWNER + '/' + REPO;

/** 跑一条 git 命令；失败返回空串，绝不抛。 */
function git(args) {
  try {
    return execFileSync('git', ['-C', ROOT].concat(args), {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
  } catch (e) {
    return '';
  }
}

/** 取 GitHub API 的 JSON；失败 reject。 */
function getJson(url) {
  return new Promise(function (resolve, reject) {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'mingscribe-sync-check',
        'Accept': 'application/vnd.github+json'
      },
      timeout: 20000
    }, function (res) {
      let body = '';
      res.on('data', function (c) { body += c; });
      res.on('end', function () {
        if (res.statusCode !== 200) {
          reject(new Error('HTTP ' + res.statusCode + ' · ' + url));
          return;
        }
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', function () { req.destroy(new Error('timeout')); });
  });
}

/** 版本号必须四处同步（见 tests/updater.test.js 的守护）。 */
function readVersionFields() {
  function grab(file, re) {
    try {
      const m = fs.readFileSync(path.join(ROOT, file), 'utf8').match(re);
      return m ? m[1] : null;
    } catch (e) {
      return null;
    }
  }
  return [
    { file: 'package.json', value: grab('package.json', /"version"\s*:\s*"([^"]+)"/) },
    { file: 'src-tauri/Cargo.toml', value: grab('src-tauri/Cargo.toml', /^version\s*=\s*"([^"]+)"/m) },
    { file: 'src-tauri/tauri.conf.json', value: grab('src-tauri/tauri.conf.json', /"version"\s*:\s*"([^"]+)"/) },
    { file: 'src/app.js (APP_VERSION)', value: grab('src/app.js', /var APP_VERSION\s*=\s*'([^']+)'/) }
  ];
}

async function collect() {
  const report = {
    versions: [],
    versionConsistent: false,
    currentVersion: null,
    local: { head: '', headSubject: '', dirty: false, tags: [], tagTargets: {} },
    remote: null,
    problems: [],
    fix: []
  };

  /* ---------- 版本号 ---------- */
  report.versions = readVersionFields();
  const uniq = new Set(report.versions.map(function (v) { return v.value; }));
  report.versionConsistent = uniq.size === 1 && !uniq.has(null);
  report.currentVersion = report.versions[0].value;
  if (!report.versionConsistent) {
    report.problems.push('四处版本号不一致：' + report.versions.map(function (v) {
      return v.file + '=' + v.value;
    }).join('、'));
  }

  /* ---------- 本地 ---------- */
  report.local.head = git(['rev-parse', 'HEAD']);
  report.local.headSubject = git(['log', '-1', '--pretty=%s']);
  report.local.dirty = git(['status', '--porcelain']).length > 0;
  report.local.tags = git(['tag', '--list']).split('\n').filter(Boolean);
  report.local.tags.forEach(function (t) {
    report.local.tagTargets[t] = git(['rev-parse', t + '^{}']);
  });

  /* ---------- 远端 ---------- */
  const commitsMain = await getJson(API + '/commits/main');
  const tagsRaw = await getJson(API + '/tags?per_page=100');
  const releasesRaw = await getJson(API + '/releases?per_page=100');
  report.remote = {
    head: commitsMain.sha || '',
    headSubject: String((commitsMain.commit && commitsMain.commit.message) || '').split('\n')[0],
    tags: tagsRaw.map(function (t) { return t.name; }),
    releases: releasesRaw.map(function (r) {
      return {
        tag: r.tag_name,
        draft: !!r.draft,
        prerelease: !!r.prerelease,
        assets: (r.assets || []).map(function (a) { return a.name; })
      };
    })
  };

  /* ---------- 比对：提交 ---------- */
  const remoteHead = report.remote.head;
  const haveRemoteHead = remoteHead && git(['cat-file', '-t', remoteHead]) === 'commit';
  report.aheadCount = 0;
  report.unpushed = [];
  if (haveRemoteHead) {
    const n = git(['rev-list', '--count', remoteHead + '..HEAD']);
    report.aheadCount = Number(n) || 0;
    if (report.aheadCount > 0) {
      const list = git(['log', '--pretty=%h %s', remoteHead + '..HEAD']);
      report.unpushed = list.split('\n').filter(Boolean);
      report.problems.push('有 ' + report.aheadCount + ' 个提交未推送到 GitHub');
      report.fix.push('git push origin main');
    }
  } else {
    report.problems.push('远端 main 的提交在本机不存在（本地可能落后，先 git fetch）');
    report.fix.push('git fetch origin');
  }

  /* ---------- 比对：标签 ---------- */
  const remoteTags = new Set(report.remote.tags);
  const localTags = new Set(report.local.tags);
  report.tagsLocalOnly = report.local.tags.filter(function (t) { return !remoteTags.has(t); });
  report.tagsRemoteOnly = report.remote.tags.filter(function (t) { return !localTags.has(t); });
  if (report.tagsLocalOnly.length) {
    report.problems.push('标签只在本地：' + report.tagsLocalOnly.join('、'));
    report.fix.push('git push origin ' + report.tagsLocalOnly.join(' '));
  }
  if (report.tagsRemoteOnly.length) {
    report.problems.push('标签只在远端：' + report.tagsRemoteOnly.join('、'));
    report.fix.push('git fetch --tags origin   # 把远端标签取回本地');
  }

  /* ---------- 比对：当前版本是否已发布 ---------- */
  const wantTag = 'v' + report.currentVersion;
  const wantRelease = report.remote.releases.filter(function (r) {
    return r.tag === wantTag && !r.draft;
  })[0];
  report.currentTag = wantTag;
  if (!remoteTags.has(wantTag)) {
    report.problems.push('当前版本 ' + wantTag + ' 的标签还没到远端');
  }
  if (!wantRelease) {
    report.problems.push('远端还没有 ' + wantTag + ' 的 Release（安装包无处可下）');
  } else if (!wantRelease.assets.length) {
    report.problems.push('远端 ' + wantTag + ' 的 Release 存在但没有附件（安装包没上传）');
  }

  /* ---------- 安装包 ---------- */
  report.installers = [];
  try {
    report.installers = fs.readdirSync(path.join(ROOT, 'releases'))
      .filter(function (f) { return /\.(exe|msi)$/i.test(f); })
      .sort();
  } catch (e) { /* releases/ 可能不存在 */ }
  report.currentInstallers = report.installers.filter(function (f) {
    return f.indexOf('_' + report.currentVersion + '_') !== -1;
  });
  if (!report.currentInstallers.length) {
    report.problems.push('releases/ 里没有 ' + report.currentVersion + ' 的安装包（还没打包？）');
  }

  return report;
}

function printHuman(r) {
  const out = [];
  const push = function (s) { out.push(s); };

  push('MingScribe 发布同步自检');
  push('='.repeat(46));
  push('');
  push('版本号（四处必须一致）');
  r.versions.forEach(function (v) {
    push('  ' + v.file.padEnd(26) + ' ' + (v.value || '(读不到)'));
  });
  push('  → ' + (r.versionConsistent ? '一致' : '不一致 ✗'));
  push('');
  push('本地仓库');
  push('  HEAD      ' + r.local.head.slice(0, 7) + '  ' + r.local.headSubject);
  push('  工作区    ' + (r.local.dirty ? '有未提交改动' : '干净'));
  push('  标签      ' + (r.local.tags.join(' ') || '(无)'));
  push('');
  push('GitHub 远端');
  push('  main      ' + r.remote.head.slice(0, 7) + '  ' + r.remote.headSubject);
  push('  标签      ' + (r.remote.tags.join(' ') || '(无)'));
  push('  Release   ' + (r.remote.releases.filter(function (x) { return !x.draft; })
    .map(function (x) { return x.tag + (x.assets.length ? '(' + x.assets.length + ' 附件)' : '(无附件)'); })
    .join(', ') || '(无)'));
  push('');
  push('安装包（releases/）');
  if (!r.installers.length) {
    push('  (无)');
  } else {
    r.installers.forEach(function (f) {
      const cur = r.currentInstallers.indexOf(f) !== -1;
      push('  ' + (cur ? '●' : '○') + ' ' + f + (cur ? '   ← 当前版本 ' + r.currentVersion : ''));
    });
  }
  push('');
  if (!r.problems.length) {
    push('结论：完全同步 ✓');
  } else {
    push('偏差（' + r.problems.length + ' 项）');
    r.problems.forEach(function (p) { push('  ✗ ' + p); });
    if (r.unpushed.length) {
      push('');
      push('  未推送的提交：');
      r.unpushed.forEach(function (c) { push('    ' + c); });
    }
    push('');
    push('待办');
    if (r.fix.length) {
      r.fix.forEach(function (f, i) { push('  ' + (i + 1) + '. ' + f); });
    }
    push('  然后把 ' + r.currentTag + ' 的 Release 附件补上（见 releases/ 下的安装包）');
    push('');
    push('结论：未同步 ✗');
  }
  return out.join('\n');
}

(async function main() {
  const asJson = process.argv.indexOf('--json') !== -1;
  let report;
  try {
    report = await collect();
  } catch (e) {
    if (asJson) {
      process.stdout.write(JSON.stringify({ ok: false, reason: 'offline', error: String(e.message || e) }, null, 2) + '\n');
    } else {
      process.stdout.write('无法访问 GitHub API（' + (e.message || e) + '）\n');
      process.stdout.write('这不是代码问题 —— 网络恢复后重跑即可。\n');
    }
    process.exit(2);
  }

  if (asJson) {
    report.ok = report.problems.length === 0;
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write(printHuman(report) + '\n');
  }
  process.exit(report.problems.length === 0 ? 0 : 1);
})();
