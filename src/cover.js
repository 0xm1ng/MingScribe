/**
 * 书架封面配色（纯函数层）。
 *
 * 职责边界：
 *   - 只做「书名 → 一对渐变色」这件事，不碰 DOM、不知道卡片长什么样。
 *   - 同一书名永远得到同一对颜色（确定性），这样书架刷新时封面不会跳色。
 *
 * 为什么不直接拿哈希当色相：
 *   色相 0–359 里，大致 55°~95° 是土黄 / 橄榄黄绿那一段，
 *   饱和度与明度怎么调都显得脏（尘感重）。哈希落点均匀，
 *   必然有一部分书名的封面撞进这段区间 —— 书架看上去就"没设计过"。
 *   所以这里先定一组**精选锚点**（每个锚点都是一对调过的冷暖渐变），
 *   再让哈希只在锚点里挑一个。锚点避开脏色区，任意书名都能得到好看的颜色。
 *
 * 撞色处理：
 *   锚点取到 18 个，并按哈希再抖一档明度，
 *   两本书刚好撞成完全同色的概率被压到很低。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MingScribe = root.MingScribe || {};
    root.MingScribe.Cover = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * 精选色相锚点，每项是 [起始色相, 终止色相]。
   * 刻意覆盖「暖 → 冷」两端，并整段跳过土黄 / 橄榄黄绿区间。
   */
  var ANCHORS = [
    [348, 12],  // 玫红 → 朱红
    [356, 20],  // 绯红 → 橙红
    [12, 32],   // 朱红 → 橙
    [22, 40],   // 橙 → 琥珀
    [32, 46],   // 琥珀 → 金
    [152, 172], // 翡翠 → 青
    [162, 182], // 青绿 → 天青绿
    [172, 192], // 天青绿 → 青蓝
    [182, 202], // 青蓝 → 天青
    [190, 212], // 天青 → 蓝
    [200, 224], // 蓝 → 群青
    [212, 236], // 群青 → 靛
    [224, 248], // 靛 → 蓝紫
    [236, 258], // 蓝紫 → 紫罗兰
    [248, 268], // 紫罗兰 → 紫
    [262, 292], // 紫 → 洋红
    [282, 312], // 洋红 → 品红
    [302, 342]  // 品红 → 玫红紫
  ];

  /** 脏色区间的闭区间边界（含），只用于测试守卫，不参与计算。 */
  var MUDDY_HUE_MIN = 55;
  var MUDDY_HUE_MAX = 95;

  /** 起始色的明度档位：白字压在上面要看得清，所以上限卡在 49%。
      取 5 档而非 3 档，是为了把可用配色从 18×3 抬到 18×5，
      常见规模的书架（几十本）基本不会出现两本书同色。 */
  var LIGHT_STEPS = [41, 43, 45, 47, 49];

  /** 哈希模数，取大质数避免与锚点数量产生周期共振。 */
  var HASH_MOD = 1000000007;

  /** 把书名散列成一个非负整数。同一个书名必须永远得到同一个数。 */
  function hashOf(text) {
    var s = String(text == null || text === '' ? '?' : text);
    var h = 0;
    for (var i = 0; i < s.length; i++) {
      h = (h * 31 + s.charCodeAt(i)) % HASH_MOD;
    }
    return h;
  }

  /**
   * 取封面的两个渐变色（左上亮、右下暗）。
   * @param {string} title 书名
   * @returns {{c1: string, c2: string, h1: number, h2: number, tone: number}}
   */
  function colorFor(title) {
    var h = hashOf(title);
    var pair = ANCHORS[h % ANCHORS.length];
    // 除以锚点数再取模，避免明度与锚点下标产生相关性（18 与 3 不互质）
    var tone = Math.floor(h / ANCHORS.length) % LIGHT_STEPS.length;
    var light = LIGHT_STEPS[tone];
    return {
      c1: 'hsl(' + pair[0] + ', 62%, ' + light + '%)',
      c2: 'hsl(' + pair[1] + ', 66%, ' + (light - 15) + '%)',
      h1: pair[0],
      h2: pair[1],
      tone: tone
    };
  }

  return {
    ANCHORS: ANCHORS,
    MUDDY_HUE_MIN: MUDDY_HUE_MIN,
    MUDDY_HUE_MAX: MUDDY_HUE_MAX,
    hashOf: hashOf,
    colorFor: colorFor
  };
});
