/**
 * updater 模块测试。
 *
 * 模块刻意做成「纯逻辑 + 注入 fetchJson」，所以这里**不需要联网**，
 * 也不会因为 GitHub 匿名限流（60 次/小时）而随机失败。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Updater = require('../src/updater.js');

/** 造一条 GitHub releases API 风格的记录。 */
function rel(tag, extra) {
  return Object.assign({
    tag_name: tag,
    name: 'MingScribe ' + tag,
    html_url: 'https://github.com/0xm1ng/MingScribe/releases/tag/' + tag,
    body: 'notes for ' + tag,
    published_at: '2026-09-15T00:00:00Z',
    draft: false,
    prerelease: false,
    assets: [{ name: 'MingScribe_0.1.0_x64-setup.exe', size: 1914973, browser_download_url: 'https://example/a.exe' }]
  }, extra || {});
}

test('normalizeVersion 能从各种写法里抽出版本号', () => {
  assert.equal(Updater.normalizeVersion('v0.1.0'), '0.1.0');
  assert.equal(Updater.normalizeVersion('MingScribe v1.2.3'), '1.2.3');
  assert.equal(Updater.normalizeVersion('release-2.0'), '2.0.0');
  assert.equal(Updater.normalizeVersion('0.1'), '0.1.0');
  assert.equal(Updater.normalizeVersion('没有版本号'), null);
  assert.equal(Updater.normalizeVersion(null), null);
});

test('compareVersion 按主次修订逐级比较', () => {
  assert.equal(Updater.compareVersion('0.1.0', '0.1.0'), 0);
  assert.equal(Updater.compareVersion('0.2.0', '0.1.9'), 1);
  assert.equal(Updater.compareVersion('0.1.9', '0.2.0'), -1);
  assert.equal(Updater.compareVersion('1.0.0', '0.99.99'), 1);
  // v 前缀不影响比较
  assert.equal(Updater.compareVersion('v0.1.0', '0.1.0'), 0);
  // 0.10 > 0.9（字符串比较会误判，这里必须是数值比较）
  assert.equal(Updater.compareVersion('0.10.0', '0.9.0'), 1);
});

test('pickLatest 跳过草稿与预发布', () => {
  const list = [
    rel('v0.2.0', { draft: true }),
    rel('v0.3.0', { prerelease: true }),
    rel('v0.1.0')
  ];
  assert.equal(Updater.pickLatest(list).version, '0.1.0');
});

test('pickLatest 不信任数组顺序，只按版本号取最大', () => {
  // GitHub 按创建时间倒序返回，但旧版本完全可能排在前面
  const list = [rel('v0.1.0'), rel('v0.9.0'), rel('v0.2.0')];
  assert.equal(Updater.pickLatest(list).version, '0.9.0');
});

test('pickLatest 遇到空列表或无一条正式版时返回 null', () => {
  assert.equal(Updater.pickLatest([]), null);
  assert.equal(Updater.pickLatest(null), null);
  assert.equal(Updater.pickLatest([rel('v0.1.0', { draft: true })]), null);
  assert.equal(Updater.pickLatest([{ tag_name: 'no-version-here' }]), null);
});

test('pickLatest 会把附件清单一起带上', () => {
  const latest = Updater.pickLatest([rel('v0.1.0')]);
  assert.equal(latest.assets.length, 1);
  assert.equal(latest.assets[0].name, 'MingScribe_0.1.0_x64-setup.exe');
  assert.equal(latest.assets[0].size, 1914973);
});

test('checkUpdate 发现新版本时给出版本、链接与说明', async () => {
  const r = await Updater.checkUpdate({
    currentVersion: '0.1.0',
    fetchJson: async () => [rel('v0.2.0'), rel('v0.1.0')]
  });
  assert.equal(r.hasUpdate, true);
  assert.equal(r.reason, 'newer');
  assert.equal(r.latest.version, '0.2.0');
  assert.match(r.latest.url, /releases\/tag\/v0\.2\.0/);
  assert.equal(r.latest.notes, 'notes for v0.2.0');
});

test('checkUpdate 已是最新时 hasUpdate 为 false', async () => {
  const r = await Updater.checkUpdate({
    currentVersion: '0.2.0',
    fetchJson: async () => [rel('v0.2.0'), rel('v0.1.0')]
  });
  assert.equal(r.hasUpdate, false);
  assert.equal(r.reason, 'up-to-date');
  assert.equal(r.latest.version, '0.2.0');
});

test('checkUpdate 网络失败时收敛成 offline，绝不抛异常', async () => {
  const r = await Updater.checkUpdate({
    currentVersion: '0.1.0',
    fetchJson: async () => { throw new Error('network down'); }
  });
  assert.equal(r.hasUpdate, false);
  assert.equal(r.reason, 'offline');
});

test('checkUpdate 没有可注入的网络函数时返回 no-fetch', async () => {
  const r = await Updater.checkUpdate({ currentVersion: '0.1.0' });
  assert.equal(r.hasUpdate, false);
  assert.equal(r.reason, 'no-fetch');
});

test('checkUpdate 一条正式版都没有时返回 no-release', async () => {
  const r = await Updater.checkUpdate({
    currentVersion: '0.1.0',
    fetchJson: async () => [rel('v0.5.0', { draft: true })]
  });
  assert.equal(r.hasUpdate, false);
  assert.equal(r.reason, 'no-release');
});

test('三处版本号必须一致：package.json / tauri.conf.json / app.js 的 APP_VERSION', () => {
  const root = path.join(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const conf = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const app = fs.readFileSync(path.join(root, 'src', 'app.js'), 'utf8');
  const m = /var APP_VERSION\s*=\s*'([^']+)'/.exec(app);

  assert.ok(m, 'src/app.js 里找不到 APP_VERSION —— 更新检查没有版本号可比');
  assert.equal(conf.version, pkg.version, 'tauri.conf.json 与 package.json 版本不一致');
  assert.equal(m[1], pkg.version, 'src/app.js 的 APP_VERSION 与 package.json 版本不一致');
});

test('shouldCheck 一天内只查一次，force 可强制', () => {
  const now = 1_800_000_000_000;
  const oneHour = 60 * 60 * 1000;

  assert.equal(Updater.shouldCheck({ lastCheckAt: 0, now }), true, '从没查过 → 该查');
  assert.equal(
    Updater.shouldCheck({ lastCheckAt: now - oneHour, now }),
    false,
    '一小时前刚查过 → 不该查'
  );
  assert.equal(
    Updater.shouldCheck({ lastCheckAt: now - oneHour, now, force: true }),
    true,
    'force 时忽略节流'
  );
  assert.equal(
    Updater.shouldCheck({ lastCheckAt: now - 25 * oneHour, now }),
    true,
    '超过一天 → 该查'
  );
});
