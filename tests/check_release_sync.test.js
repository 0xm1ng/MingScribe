/**
 * 发布同步守卫的纯逻辑测试（tools/check_release_sync.js）。
 *
 * 为什么值得测：2026-09-18 这个守卫自己出过一次误报 ——
 * GitHub 匿名 API 额度用尽（403 · remaining=0）被当成「网络不可用」，
 * 于是提示用户「网络恢复后重跑即可」，而实际上等网络没用、重跑也没用，
 * 正确处置是等额度重置或换 token。所以「把限流从网络故障里摘出来」这条
 * 判断必须有测试守着，不能靠以后随手改坏。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const Sync = require('../tools/check_release_sync.js');

/* ---------------- parseLsRemote ---------------- */

test('parseLsRemote：取出 main 与全部标签，并按字典序排序', () => {
  const text = [
    'df2e26a3dd6c7d82cb4f9cef3c54bffff0ce1786\trefs/heads/main',
    'e5ab5bef0326c993f83773c2a67ea7b4d7de6d67\trefs/tags/v0.1.0',
    '71159b4088e6ee8ad442f6e906f0be6078955b09\trefs/tags/v0.1.1'
  ].join('\n');

  const r = Sync.parseLsRemote(text);
  assert.equal(r.head, 'df2e26a3dd6c7d82cb4f9cef3c54bffff0ce1786');
  assert.deepEqual(r.tags, ['v0.1.0', 'v0.1.1']);
  assert.deepEqual(r.peeled, {});
});

test('parseLsRemote：注解标签的 ^{} 归并进同一标签，不重复计数', () => {
  const text = [
    'df2e26a3dd6c7d82cb4f9cef3c54bffff0ce1786\trefs/heads/main',
    '9438eec4ef5c8fedf66508d0c9d75672c8a96a2c\trefs/tags/v0.3.0',
    'e6c72000300168d626063e7960c71671a296c46d\trefs/tags/v0.3.0^{}'
  ].join('\n');

  const r = Sync.parseLsRemote(text);
  assert.deepEqual(r.tags, ['v0.3.0'], '标签只应出现一次');
  assert.equal(r.peeled['v0.3.0'], 'e6c72000300168d626063e7960c71671a296c46d',
    'peeled 必须指向真实提交，脚本靠它判断「空标签」');
});

test('parseLsRemote：忽略垃圾行与空输入，不抛异常', () => {
  const r = Sync.parseLsRemote('乱七八糟\n\n\trefs/heads/main\ndf2e26a\t');
  assert.equal(r.head, '');
  assert.deepEqual(r.tags, []);

  const empty = Sync.parseLsRemote('');
  assert.equal(empty.head, '');
  assert.deepEqual(empty.tags, []);

  const nul = Sync.parseLsRemote(null);
  assert.equal(nul.head, '');
  assert.deepEqual(nul.tags, []);
});

/* ---------------- classifyApiResult ---------------- */

test('classifyApiResult：200 走 ok，且解析出 JSON', () => {
  const r = Sync.classifyApiResult({
    url: 'https://api.github.com/x', status: 200, headers: {}, body: '{"sha":"abc"}'
  });
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'ok');
  assert.equal(r.json.sha, 'abc');
});

test('classifyApiResult：403 且额度为 0 → 判定为限流（不是网络故障）', () => {
  const r = Sync.classifyApiResult({
    url: 'https://api.github.com/repos/o/r/commits/main',
    status: 403,
    headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-limit': '60', 'x-ratelimit-reset': '1789696572' },
    body: '{"message":"API rate limit exceeded for 209.9.200.33. (But here\'s the good news: ...)"}'
  });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'ratelimit', '限流必须与网络故障区分开');
  assert.equal(r.ip, '209.9.200.33', '要能从报文里抠出出口 IP（额度按 IP 计）');
  assert.equal(r.resetAt, 1789696572000, 'reset 是秒，要换算成毫秒');
});

test('classifyApiResult：403 但额度还有剩 → 不能误判成限流', () => {
  const r = Sync.classifyApiResult({
    url: 'https://api.github.com/x', status: 403,
    headers: { 'x-ratelimit-remaining': '42' }, body: '{"message":"Resource not accessible"}'
  });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'http', '额度没满的 403 是权限/其他原因');
});

test('classifyApiResult：连不上才是 network', () => {
  const r = Sync.classifyApiResult({
    url: 'https://api.github.com/x', status: 0, headers: {}, body: '', error: 'getaddrinfo ENOTFOUND'
  });
  assert.equal(r.kind, 'network');
  assert.equal(r.status, 0);
});

test('classifyApiResult：401 / 404 归为 http，不带 resetAt', () => {
  const r404 = Sync.classifyApiResult({ url: 'u', status: 404, headers: {}, body: '' });
  assert.equal(r404.kind, 'http');
  assert.equal(r404.resetAt, null);
});

/* ---------------- humanizeWait ---------------- */

/* ---------------- describeReadFailure ---------------- */

test('describeReadFailure：API 也在网络层失败 → 才可以说「网络恢复后重跑」', () => {
  const lines = Sync.describeReadFailure({
    api: { kind: 'network', message: 'getaddrinfo ENOTFOUND' }
  }).join('\n');
  assert.match(lines, /先确认网络/);
  assert.match(lines, /网络恢复后重跑即可/);
});

test('describeReadFailure：API 有回应（限流）时绝不能说是网络故障', () => {
  const lines = Sync.describeReadFailure({
    api: { kind: 'ratelimit', status: 403, ip: '1.2.3.4', resetAt: 1789696572000, message: '额度用尽' }
  }).join('\n');
  assert.match(lines, /额度已用完/, '要按限流的口径解释');
  assert.match(lines, /网络本身是通的/, '必须澄清网络没问题');
  assert.doesNotMatch(lines, /网络恢复后重跑即可/,
    '限流时给「等网络恢复」的建议等于误导用户 —— 这条断言守着 2026-09-18 那次误报');
});

test('describeReadFailure：连 API 都没回应时不硬编原因', () => {
  const lines = Sync.describeReadFailure(new Error('boom')).join('\n');
  assert.match(lines, /没有拿到 GitHub API 的回应/);
});

/* ---------------- humanizeWait ---------------- */

test('humanizeWait：把重置时间说成人话（now 由参数注入，保证确定性）', () => {
  const now = 1000000000000;
  assert.equal(Sync.humanizeWait(now + 30 * 1000, now), '不到 1 分钟');
  assert.equal(Sync.humanizeWait(now + 5 * 60 * 1000, now), '约 5 分钟');
  assert.equal(Sync.humanizeWait(now + 90 * 60 * 1000, now), '约 2 小时');
  assert.equal(Sync.humanizeWait(now - 1000, now), '随时可以重试');
  assert.equal(Sync.humanizeWait(null, now), '', '拿不到重置时间时不硬编');
});
