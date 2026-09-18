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
 * 两条通道，谁通用谁（2026-09-18 重构）
 * ------------------------------------
 * 原先一切都走 GitHub REST API，结果踩了一个很坑的误报：匿名 API 是
 * **60 次/小时、按出口 IP 计**，额度一满就返回 403，而脚本把所有异常都
 * 当成「网络不可用」，提示用户「网络恢复后重跑」—— 但限流根本不是网络问题，
 * 等也好不了，而且用户完全无从判断。
 *
 * 现在改成：
 *   - 「提交 / 标签」→ `git ls-remote`（**不消耗 API 额度**，且与 push 同一通道，
 *     连不上就说明真的没网，语义更准）；
 *   - 「Release 有没有建、附件传没传」→ 只能问 API（git 协议没有这个概念），
 *     并且明确区分「额度用尽 / 无权限 / 网络故障」，读 `x-ratelimit-reset`
 *     告知还要等多久，支持 GITHUB_TOKEN 提额度（匿名 60/h → 认证 5000/h）。
 *
 * 用法
 * ----
 *   node tools/check_release_sync.js          人类可读报告
 *   node tools/check_release_sync.js --json   机器可读
 *
 * 想提额度就先给个 token（可选，不给也能跑）：
 *   set GITHUB_TOKEN=ghp_xxx        （当前窗口有效）
 *   setx GITHUB_TOKEN ghp_xxx       （永久，需重开终端）
 *   token 只需 public_repo 只读权限即可。
 *
 * 退出码
 * ------
 *   0 = 完全同步
 *   1 = 存在偏差（按报告里的「待办」处理）
 *   2 = 两条通道都不通，完全无法判断（这才是真的网络问题）
 *   3 = 提交与标签已核对无误，但 Release 未能核对（多为 API 限流）
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
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_API_TOKEN || '';

/* ============================ 纯函数（可单测） ============================ */

/**
 * 解析 `git ls-remote --heads --tags` 的输出。
 * 注解标签会多出一行 `<sha>\trefs/tags/vX.Y.Z^{}`（peeled 真实提交），
 * 这里把它并入同一个标签对象，别当成一个新标签。
 *
 * @param {string} text
 * @returns {{head: string, tags: string[], peeled: Object<string,string>}}
 */
function parseLsRemote(text) {
  const out = { head: '', tags: [], peeled: {} };
  String(text || '').split('\n').forEach(function (line) {
    const m = line.match(/^([0-9a-f]{7,40})\s+(\S+)$/);
    if (!m) return;
    const sha = m[1];
    const ref = m[2];
    if (ref === 'refs/heads/main') { out.head = sha; return; }
    const tag = ref.match(/^refs\/tags\/(.+?)(\^\{\})?$/);
    if (!tag) return;
    const name = tag[1];
    if (tag[2]) {
      out.peeled[name] = sha;
    } else if (out.tags.indexOf(name) === -1) {
      out.tags.push(name);
    }
  });
  out.tags.sort();
  return out;
}

/**
 * 把一次 API 响应归类。**关键是把「限流」从「网络故障」里摘出来** ——
 * 两者的处置方式完全不同（一个是等/换 token，一个是重试）。
 *
 * @param {{status:number, headers:Object, body:string, url:string, error?:string}} res
 * @returns {{ok:boolean, kind:'ok'|'ratelimit'|'http'|'network', status:number,
 *            url:string, message:string, resetAt:number|null, ip:string|null, json:any}}
 */
function classifyApiResult(res) {
  const url = res.url;
  if (res.error) {
    return { ok: false, kind: 'network', status: 0, url: url, message: res.error, resetAt: null, ip: null, json: null };
  }
  const headers = res.headers || {};
  const remaining = Number(headers['x-ratelimit-remaining']);
  const resetAt = Number(headers['x-ratelimit-reset']) * 1000 || null;
  const ipMatch = String(res.body || '').match(/for (\d{1,3}(?:\.\d{1,3}){3})/);
  const ip = ipMatch ? ipMatch[1] : null;

  if (res.status === 200) {
    let json = null;
    try { json = JSON.parse(res.body); } catch (e) { /* 保持 null */ }
    return { ok: true, kind: 'ok', status: 200, url: url, message: '', resetAt: resetAt, ip: ip, json: json };
  }
  // 403 / 429 且额度确实是 0 → 限流；否则是权限或其他拒绝
  if ((res.status === 403 || res.status === 429) && remaining === 0) {
    return {
      ok: false, kind: 'ratelimit', status: res.status, url: url,
      message: '匿名 API 额度用尽', resetAt: resetAt, ip: ip, json: null
    };
  }
  return {
    ok: false, kind: 'http', status: res.status, url: url,
    message: 'HTTP ' + res.status, resetAt: resetAt, ip: ip, json: null
  };
}

/**
 * 把「还有多久重置」说成人话；拿不到重置时间时返回空串（调用方据此省略这一行）。
 *
 * 注意：必须先挡掉 null/undefined —— `Number(null)` 是 0，会一路算成
 * delta <= 0 而答出「随时可以重试」。响应里没有 `x-ratelimit-reset` 头时
 * 我们其实**不知道**额度何时恢复，这种时候宁可不说，也不能给出错误建议。
 */
function humanizeWait(ms, now) {
  if (ms === null || ms === undefined || ms === '') return '';
  const reset = Number(ms);
  if (!isFinite(reset) || reset <= 0) return '';
  const delta = reset - (now === undefined ? Date.now() : now);
  if (!isFinite(delta)) return '';
  if (delta <= 0) return '随时可以重试';
  // 注意：这里必须先单独判「不足 1 分钟」。若写成 min < 1，因为 Math.ceil
  // 对任何正数都 ≥ 1，那个分支永远命中不到（剩 30 秒会说成「约 1 分钟」）。
  if (delta < 60000) return '不到 1 分钟';
  const min = Math.ceil(delta / 60000);
  if (min < 60) return '约 ' + min + ' 分钟';
  return '约 ' + Math.round(min / 60) + ' 小时';
}

/* ============================ IO 封装 ============================ */

/** 跑一条 git 命令；失败返回空串，绝不抛。 */
function gitOut(args) {
  try {
    return execFileSync('git', ['-C', ROOT].concat(args), {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
  } catch (e) {
    return '';
  }
}

/**
 * 首选通道：`git ls-remote`。不消耗 API 额度，且复用 push 那条网络路径。
 *
 * 这个通道在本机会**偶发失败**（`socket hang up` / 连接被重置），所以重试一次
 * ——否则一次抖动就会把整份报告拖进「无法判断」，白白浪费一次调用。
 *
 * @returns {{ok:boolean, head:string, tags:string[], peeled:Object, error?:string}}
 */
function readRemoteViaGit() {
  let lastError = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const out = execFileSync('git', ['-C', ROOT, 'ls-remote', '--heads', '--tags', 'origin'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30000
      });
      const parsed = parseLsRemote(out);
      if (parsed.head) {
        return { ok: true, head: parsed.head, tags: parsed.tags, peeled: parsed.peeled };
      }
      lastError = 'ls-remote 有输出但解析不到 refs/heads/main';
    } catch (e) {
      lastError = String((e && e.message) || e);
    }
  }
  return { ok: false, head: '', tags: [], peeled: {}, error: lastError };
}

/**
 * refs 两条路都没拿到时的说明文案。
 *
 * 这里要小心的正是 2026-09-18 踩过的那个坑：**API 有回应（403 等）不等于网络不通**。
 * 只有 API 也在网络层失败，才是真的离线；否则应当如实告诉用户「网络是通的」。
 *
 * @param {Error & {api?:Object}} err
 * @returns {string[]}
 */
function describeReadFailure(err) {
  const api = err && err.api ? err.api : null;
  const lines = ['无法读取远端状态'];
  lines.push('  git ls-remote 没能连上（该通道偶发失败，重跑一次通常就好）');

  if (!api) {
    lines.push('  且没有拿到 GitHub API 的回应 → 先确认网络。');
    return lines;
  }
  if (api.kind === 'network') {
    lines.push('  GitHub API 也连不上（' + api.message + '）→ 先确认网络。');
    lines.push('  这不是代码问题 —— 网络恢复后重跑即可。');
    return lines;
  }
  lines.push('  GitHub API 有回应，但拒绝了这次请求：');
  describeReleaseFailure(api, Date.now()).forEach(function (l) { lines.push('  ' + l); });
  lines.push('  → 网络本身是通的：直接重跑即可；若持续失败再查网络。');
  return lines;
}

/** 取 GitHub API 的 JSON；**不抛异常**，失败也返回结构化结果。 */
function apiGet(url) {
  return new Promise(function (resolve) {
    const headers = {
      'User-Agent': 'mingscribe-sync-check',
      'Accept': 'application/vnd.github+json'
    };
    if (TOKEN) headers['Authorization'] = 'Bearer ' + TOKEN;

    const req = https.get(url, { headers: headers, timeout: 20000 }, function (res) {
      let body = '';
      res.on('data', function (c) { body += c; });
      res.on('end', function () {
        resolve(classifyApiResult({ url: url, status: res.statusCode, headers: res.headers, body: body }));
      });
    });
    req.on('error', function (e) {
      resolve(classifyApiResult({ url: url, status: 0, headers: {}, body: '', error: String(e.message || e) }));
    });
    req.on('timeout', function () {
      req.destroy();
      resolve(classifyApiResult({ url: url, status: 0, headers: {}, body: '', error: 'timeout' }));
    });
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

/* ============================ 主流程 ============================ */

async function collect() {
  const report = {
    versions: [],
    versionConsistent: false,
    currentVersion: null,
    local: { head: '', headSubject: '', dirty: false, tags: [], tagTargets: {} },
    remote: null,
    releases: { ok: false, list: [], reason: null },
    problems: [],
    fix: [],
    notes: []
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
  report.local.head = gitOut(['rev-parse', 'HEAD']);
  report.local.headSubject = gitOut(['log', '-1', '--pretty=%s']);
  report.local.dirty = gitOut(['status', '--porcelain']).length > 0;
  report.local.tags = gitOut(['tag', '--list']).split('\n').filter(Boolean);
  report.local.tags.forEach(function (t) {
    report.local.tagTargets[t] = gitOut(['rev-parse', t + '^{}']);
  });

  /* ---------- 远端 refs：git 通道优先，不通才退回 API ---------- */
  let refs = readRemoteViaGit();
  let refSource = 'git ls-remote';
  if (!refs.ok) {
    const viaApi = await apiGet(API + '/commits/main');
    const tagsApi = await apiGet(API + '/tags?per_page=100');
    if (!viaApi.ok) {
      // 两条通道都没给出 refs。注意：只有 api.kind === 'network' 才是真的离线，
      // 403/404 说明 API 明明活着 —— 具体措辞交给 describeReadFailure 判断。
      throw Object.assign(new Error('refs 无法读取：git 通道与 GitHub API 都没给出结果'), {
        gitError: refs.error, api: viaApi, releaseProbe: tagsApi
      });
    }
    refSource = 'GitHub API（git 通道不可用，已降级）';
    refs = {
      ok: true,
      head: (viaApi.json && viaApi.json.sha) || '',
      tags: tagsApi.ok && Array.isArray(tagsApi.json) ? tagsApi.json.map(function (t) { return t.name; }).sort() : [],
      peeled: {}
    };
  }
  const remoteSubject = refs.head && gitOut(['cat-file', '-t', refs.head]) === 'commit'
    ? gitOut(['log', '-1', '--pretty=%s', refs.head])
    : '(本机没有该提交，先 git fetch)';
  report.remote = {
    source: refSource,
    head: refs.head,
    headSubject: remoteSubject,
    tags: refs.tags
  };

  /* ---------- 远端 Release：只有 API 能答 ---------- */
  const rel = await apiGet(API + '/releases?per_page=100');
  if (rel.ok && Array.isArray(rel.json)) {
    report.releases.ok = true;
    report.releases.list = rel.json.map(function (r) {
      return {
        tag: r.tag_name,
        draft: !!r.draft,
        prerelease: !!r.prerelease,
        assets: (r.assets || []).map(function (a) { return a.name; })
      };
    });
  } else {
    report.releases.ok = false;
    report.releases.reason = rel;
  }

  /* ---------- 比对：提交 ---------- */
  const remoteHead = report.remote.head;
  const haveRemoteHead = remoteHead && gitOut(['cat-file', '-t', remoteHead]) === 'commit';
  report.aheadCount = 0;
  report.unpushed = [];
  if (haveRemoteHead) {
    report.aheadCount = Number(gitOut(['rev-list', '--count', remoteHead + '..HEAD'])) || 0;
    if (report.aheadCount > 0) {
      report.unpushed = gitOut(['log', '--pretty=%h %s', remoteHead + '..HEAD']).split('\n').filter(Boolean);
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
  // 标签指向的提交是否一致（能查到的才查）
  const want = report.currentVersion ? 'v' + report.currentVersion : '';
  report.tagMismatch = [];
  report.remote.tags.forEach(function (t) {
    const localSha = report.local.tagTargets[t];
    const remoteSha = refs.peeled[t];
    if (localSha && remoteSha && localSha !== remoteSha) {
      report.tagMismatch.push(t + ' 本地=' + localSha.slice(0, 7) + ' 远端=' + remoteSha.slice(0, 7));
    }
  });
  if (report.tagMismatch.length) {
    report.problems.push('同名标签指向不同提交：' + report.tagMismatch.join('；'));
  }

  /* ---------- 比对：当前版本是否已发布 ---------- */
  report.currentTag = want;
  if (!remoteTags.has(want)) {
    report.problems.push('当前版本 ' + want + ' 的标签还没到远端');
  }
  if (report.releases.ok) {
    const wantRelease = report.releases.list.filter(function (r) {
      return r.tag === want && !r.draft;
    })[0];
    if (!wantRelease) {
      report.problems.push('远端还没有 ' + want + ' 的 Release（安装包无处可下）');
    } else if (!wantRelease.assets.length) {
      report.problems.push('远端 ' + want + ' 的 Release 存在但没有附件（安装包没上传）');
    }
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

/* ============================ 输出 ============================ */

function describeReleaseFailure(reason, now) {
  const lines = [];
  if (reason.kind === 'ratelimit') {
    lines.push('  GitHub 匿名 API 额度已用完 —— 这不是网络问题，重跑没用');
    lines.push('    额度    匿名 60 次/小时，**按出口 IP 计**（同一网络下别的程序也会消耗）');
    if (reason.ip) lines.push('    出口 IP ' + reason.ip);
    const wait = humanizeWait(reason.resetAt, now);
    if (wait) {
      lines.push('    重置    ' + wait + '后（' +
        (reason.resetAt ? new Date(reason.resetAt).toLocaleTimeString() : '未知') + '）');
    }
    lines.push('    → 等一会儿重跑；或给个 token 把额度提到 5000/小时：');
    lines.push('        set GITHUB_TOKEN=ghp_xxx      （当前窗口有效）');
    lines.push('        setx GITHUB_TOKEN ghp_xxx     （永久，需重开终端）');
    lines.push('      token 只要 public_repo 只读权限即可。');
  } else if (reason.kind === 'network') {
    lines.push('  访问 GitHub API 失败：' + reason.message);
    lines.push('    → 网络恢复后重跑即可。');
  } else {
    lines.push('  GitHub API 返回 ' + (reason.message || reason.status));
    lines.push('    → 若是权限问题，检查 token 是否失效或缺少 public_repo 权限。');
  }
  return lines;
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
  push('GitHub 远端（来源：' + r.remote.source + '）');
  push('  main      ' + (r.remote.head.slice(0, 7) || '(读不到)') + '  ' + r.remote.headSubject);
  push('  标签      ' + (r.remote.tags.join(' ') || '(无)'));
  if (r.releases.ok) {
    const live = r.releases.list.filter(function (x) { return !x.draft; });
    push('  Release   ' + (live.map(function (x) {
      return x.tag + (x.assets.length ? '(' + x.assets.length + ' 附件)' : '(无附件)');
    }).join(', ') || '(无)'));
  } else {
    push('  Release   ⚠ 未能核对（见下）');
  }
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

  if (!r.releases.ok) {
    push('⚠ 部分项目无法核对');
    describeReleaseFailure(r.releases.reason, Date.now()).forEach(push);
    push('');
  }

  if (!r.problems.length) {
    if (r.releases.ok) {
      push('结论：完全同步 ✓');
    } else {
      push('结论：提交与标签已全部同步 ✓（Release 状态未核对，见上）');
    }
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
    if (!r.releases.ok) {
      push('  ' + (r.fix.length + 1) + '. （Release 状态待额度恢复后再核对）');
    } else {
      push('  然后把 ' + r.currentTag + ' 的 Release 附件补上（见 releases/ 下的安装包）');
    }
    push('');
    push('结论：未同步 ✗');
  }
  return out.join('\n');
}

/* ============================ 入口 ============================ */

function exitCodeFor(r) {
  if (r.problems.length) return 1;
  return r.releases.ok ? 0 : 3;
}

async function main() {
  const asJson = process.argv.indexOf('--json') !== -1;
  let report;
  try {
    report = await collect();
  } catch (e) {
    const api = (e && e.api) || null;
    if (asJson) {
      process.stdout.write(JSON.stringify({
        ok: false,
        reason: api && api.kind !== 'network' ? 'refs-unreadable' : 'offline',
        error: String((e && e.message) || e),
        gitError: (e && e.gitError) || null,
        apiKind: api ? api.kind : null,
        apiStatus: api ? api.status : 0,
        apiResetAt: api ? api.resetAt : null,
        apiIp: api ? api.ip : null
      }, null, 2) + '\n');
    } else {
      describeReadFailure(e).forEach(function (l) { process.stdout.write(l + '\n'); });
    }
    process.exit(2);
  }

  if (asJson) {
    report.ok = exitCodeFor(report) === 0;
    report.exitCode = exitCodeFor(report);
    report.hasToken = !!TOKEN;
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write(printHuman(report) + '\n');
  }
  process.exit(exitCodeFor(report));
}

module.exports = {
  parseLsRemote: parseLsRemote,
  classifyApiResult: classifyApiResult,
  humanizeWait: humanizeWait,
  describeReadFailure: describeReadFailure
};

if (require.main === module) {
  main();
}
