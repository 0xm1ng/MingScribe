/**
 * 版本更新检查（MingScribe）。
 *
 * 为什么**不做**「静默下载并替换自身」：
 *   Tauri 的 updater 插件要校验更新包的签名，而代码签名证书一年要几百到几千元；
 *   没签名就自动下载 exe，Windows SmartScreen 和杀软都会直接拦下来，体验更差。
 *   所以这里采用开源个人项目最通行的做法：**告知 → 用户点链接 → 自己下载安装**。
 *   既零成本，也不会让用户被一个未签名的自动更新吓到。
 *
 * 设计约束（与其他模块一致）：
 *   - 纯逻辑 + 注入依赖：网络请求由外部传入的 `fetchJson` 提供，
 *     所以 Node 下不需要联网、不需要 mock 全局就能单测。
 *   - 所有失败路径都收敛成 `{ hasUpdate: false, reason: ... }`，
 *     绝不抛异常 —— 检查更新是锦上添花，不能因为它让阅读器打不开。
 *   - 只认**正式版**：草稿（draft）与预发布（prerelease）一律跳过。
 *
 * 接口：GitHub Releases API（GET /repos/:owner/:repo/releases），
 * 匿名即可访问，无需 token。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MingScribe = root.MingScribe || {};
    root.MingScribe.Updater = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULT_API = 'https://api.github.com/repos/0xm1ng/MingScribe/releases';
  var DEFAULT_INTERVAL = 24 * 60 * 60 * 1000; // 一天最多自动查一次

  /**
   * 从任意文本里抽出版本号。
   * 能处理 'v0.1.0'、'MingScribe v0.1.0'、'release-1.2'、'0.1'。
   * 抽不到时返回 null（调用方按「无版本」处理，不要猜）。
   */
  function normalizeVersion(text) {
    if (text == null) return null;
    var m = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(text));
    if (!m) return null;
    return [m[1], m[2] || '0', m[3] || '0'].join('.');
  }

  /** 语义化版本比较：a > b 返回 1，相等返回 0，a < b 返回 -1。 */
  function compareVersion(a, b) {
    var pa = String(normalizeVersion(a) || '0.0.0').split('.').map(Number);
    var pb = String(normalizeVersion(b) || '0.0.0').split('.').map(Number);
    for (var i = 0; i < 3; i++) {
      var x = pa[i] || 0;
      var y = pb[i] || 0;
      if (x > y) return 1;
      if (x < y) return -1;
    }
    return 0;
  }

  /**
   * 从 releases 列表里挑出「最新的正式版」。
   *
   * 刻意**不信任数组顺序**：GitHub 默认按创建时间倒序返回，但一次发布里
   * 可能同时存在草稿与预发布，草稿的版本号可能反而更大。这里逐个筛掉
   * draft / prerelease / 无版本号的条目，再按版本号取最大，结果才稳。
   */
  function pickLatest(list) {
    if (!list || !list.length) return null;
    var best = null;
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (!r || r.draft || r.prerelease) continue;
      var v = normalizeVersion(r.tag_name || r.name);
      if (!v) continue;
      if (!best || compareVersion(v, best.version) > 0) {
        best = {
          version: v,
          name: r.name || r.tag_name || v,
          url: r.html_url || '',
          notes: r.body || '',
          publishedAt: r.published_at || r.created_at || '',
          assets: (r.assets || []).map(function (a) {
            return { name: a.name || '', size: a.size || 0, url: a.browser_download_url || '' };
          })
        };
      }
    }
    return best;
  }

  /**
   * 是否该发起这次检查（节流）。
   * 一天最多一次 —— 每次启动都打 GitHub API 既不礼貌，也容易撞匿名限流（60 次/小时）。
   */
  function shouldCheck(opts) {
    opts = opts || {};
    var last = Number(opts.lastCheckAt) || 0;
    var now = Number(opts.now) || 0;
    var interval = Number(opts.intervalMs) || DEFAULT_INTERVAL;
    if (opts.force) return true;
    if (!last) return true;
    return (now - last) >= interval;
  }

  /**
   * 检查更新。
   *
   * @param {object} opts
   * @param {string} opts.currentVersion  当前版本
   * @param {function} opts.fetchJson     注入的网络函数，签名 (url) => Promise<Array>
   * @param {string} [opts.url]            releases API 地址
   * @returns {Promise<{hasUpdate:boolean, reason:string, latest?:object}>}
   *   reason: 'newer' | 'up-to-date' | 'no-release' | 'no-fetch' | 'offline'
   */
  function checkUpdate(opts) {
    opts = opts || {};
    var fetchJson = opts.fetchJson;
    if (typeof fetchJson !== 'function') {
      return Promise.resolve({ hasUpdate: false, reason: 'no-fetch' });
    }
    var current = normalizeVersion(opts.currentVersion) || '0.0.0';

    return Promise.resolve()
      .then(function () { return fetchJson(opts.url || DEFAULT_API); })
      .then(function (list) {
        var latest = pickLatest(list);
        if (!latest) return { hasUpdate: false, reason: 'no-release' };
        if (compareVersion(latest.version, current) > 0) {
          return { hasUpdate: true, reason: 'newer', latest: latest };
        }
        return { hasUpdate: false, reason: 'up-to-date', latest: latest };
      })
      .catch(function () {
        // 网络失败 / JSON 解析失败 / API 限流：一律当「查不到」，绝不打扰用户
        return { hasUpdate: false, reason: 'offline' };
      });
  }

  return {
    DEFAULT_API: DEFAULT_API,
    DEFAULT_INTERVAL: DEFAULT_INTERVAL,
    normalizeVersion: normalizeVersion,
    compareVersion: compareVersion,
    pickLatest: pickLatest,
    shouldCheck: shouldCheck,
    checkUpdate: checkUpdate
  };
}));
