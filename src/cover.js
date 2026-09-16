/**
 * 书架封面美术（纯函数层）。
 *
 * 职责边界：
 *   - 只做「书名 → 一组封面视觉参数」这件事，不碰 DOM、不知道卡片长什么样。
 *   - 同一书名永远得到同一套结果（确定性），这样书架刷新时封面不会跳。
 *
 * 三件事：
 *   1) 配色 `colorFor`  —— 一对渐变色。
 *   2) 图案 `artFor`    —— 按书的内容类型选一种纹理，并给出封面排版的度量。
 *   3) 排版 `titleScale` —— 书名摆在封面上该用多大字号。
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
 *
 * 为什么不再用「书名首字」当封面：
 *   一个字撑满整张封面既不像书，也没法区分同首字的两本。现在封面主视觉是
 *   **排版过的书名**（衬线、多行、按字数分档），外加一层**按书类匹配的图案纹理**
 *   （技术书是电路/网格、古籍是书脊线、科学是同心圆…），首字只留作右下角的淡水印。
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

  /* ---------------- 图案纹理 ---------------- */

  /**
   * 可平铺的纹理。全部是白/黑半透明的纯线条，压在任意深色渐变上都成立，
   * 因此不需要按主题各写一套。`w`/`h` 是平铺单元尺寸（px）。
   */
  var PATTERNS = {
    // 电路折线：工程 / 技术书
    circuit: {
      w: 64, h: 64,
      art: "<path d='M5 5h22v22h22' fill='none' stroke='rgba(255,255,255,.34)' stroke-width='1.3'/>" +
           "<path d='M64 46H40v18' fill='none' stroke='rgba(255,255,255,.22)' stroke-width='1.3'/>" +
           "<circle cx='5' cy='5' r='2.6' fill='rgba(255,255,255,.5)'/>" +
           "<circle cx='49' cy='27' r='2.6' fill='rgba(255,255,255,.5)'/>"
    },
    // 方格网：技术书的另一种气质
    grid: {
      w: 26, h: 26,
      art: "<path d='M26 0H0v26' fill='none' stroke='rgba(255,255,255,.30)' stroke-width='1'/>"
    },
    // 书脊竖线 + 上下短横：古籍 / 史书
    spine: {
      w: 30, h: 64,
      art: "<path d='M15 0v64' stroke='rgba(255,255,255,.30)' stroke-width='1.2'/>" +
           "<path d='M6 8h18M6 56h18' stroke='rgba(255,255,255,.22)' stroke-width='1'/>"
    },
    // 人字纹：古籍 / 文集
    chevron: {
      w: 24, h: 16,
      art: "<path d='M0 15L12 4L24 15' fill='none' stroke='rgba(255,255,255,.28)' stroke-width='1.4'/>"
    },
    // 同心圆：科学 / 自然
    rings: {
      w: 72, h: 72,
      art: "<circle cx='36' cy='36' r='26' fill='none' stroke='rgba(255,255,255,.26)' stroke-width='1.1'/>" +
           "<circle cx='36' cy='36' r='15' fill='none' stroke='rgba(255,255,255,.22)' stroke-width='1.1'/>" +
           "<circle cx='36' cy='36' r='5' fill='none' stroke='rgba(255,255,255,.32)' stroke-width='1.1'/>"
    },
    // 点阵：科学 / 工具书
    dots: {
      w: 20, h: 20,
      art: "<circle cx='3' cy='3' r='1.4' fill='rgba(255,255,255,.36)'/>"
    },
    // 水波：文学 / 小说
    wave: {
      w: 44, h: 26,
      art: "<path d='M0 19 Q11 8 22 19 T44 19' fill='none' stroke='rgba(255,255,255,.36)' stroke-width='1.3'/>"
    },
    // 斜纹：文学 / 随笔
    diag: {
      w: 18, h: 18,
      art: "<path d='M-4 4L4 -4M0 18L18 0M14 22L22 14' stroke='rgba(255,255,255,.28)' stroke-width='1.2'/>"
    }
  };

  /** 书的外层容器尺寸：3:4 封面，宽高比在两处（CSS 与这里的图例）保持一致。 */
  var COVER_ASPECT = 3 / 4;

  /**
   * 关键词 → 书类。命中越多越优先，同分按此数组顺序。
   * 只用来挑图案（纯视觉），判错没有功能后果，因此允许宽松匹配。
   */
  var GENRE_KEYWORDS = [
    ['tech', [
      'web', '安全', 'ctf', '编程', '代码', '程序', '算法', '计算机', '网络', '数据',
      'linux', 'python', 'java', 'script', 'html', 'css', '前端', '后端', '服务',
      '漏洞', '渗透', '逆向', '协议', '架构', '设计模式', '工程', '实战', '教程',
      '入门', '指南', '手册', 'security', 'hack', 'code', 'network', 'database',
      'docker', 'git', '正则', '操作系统', '编译', '运维', '接口', '开发'
    ]],
    ['classic', [
      '古籍', '经', '传', '史', '志', '诗', '词', '赋', '选集', '古典', '山海',
      '三国', '水浒', '西游', '红楼', '春秋', '战国', '唐宋', '明清', '论语',
      '道德', '庄子', '老子', '孟子', '孙子', '兵法', '资治', '通鉴', '古文',
      '国学', '周易', '楚辞', '世说', '聊斋', '阅微'
    ]],
    ['science', [
      '物理', '化学', '生物', '数学', '宇宙', '天文', '自然', '科学', '时间简史',
      '量子', '相对论', '进化', '基因', '细胞', '地质', '气候', '医学', '心理',
      'science', 'physics', 'math', 'biology'
    ]],
    ['literature', [
      '小说', '散文', '诗歌', '文学', '故事', '随笔', '童话', '寓言', '戏剧',
      '传记', '回忆录', '诗选', '文集', 'novel', 'story', 'poem', 'essay'
    ]]
  ];

  /** 书类 → 可选图案池。通用类不限，任意图案都成立。 */
  var GENRE_PATTERNS = {
    tech: ['circuit', 'grid'],
    classic: ['spine', 'chevron'],
    science: ['rings', 'dots'],
    literature: ['wave', 'diag'],
    general: ['wave', 'grid', 'dots', 'diag', 'chevron', 'rings', 'circuit', 'spine']
  };

  /** 书名在封面上的字号档位（px），按「视觉字数」递减。 */
  var TITLE_SCALE = [
    { max: 4, size: 30 },
    { max: 8, size: 24 },
    { max: 13, size: 19 },
    { max: 20, size: 16 },
    { max: Infinity, size: 14 }
  ];

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

  /**
   * 把一段 SVG 片段封成可以直接喂给 CSS `background-image` 的 data URI。
   * 用 encodeURIComponent 整体转义，内部一律写单引号，外层用双引号包裹，
   * 这样任何主题、任何引号环境都不会把 url() 截断。
   */
  function svgUri(art, w, h) {
    var doc = "<svg xmlns='http://www.w3.org/2000/svg' width='" + w + "' height='" + h +
      "' viewBox='0 0 " + w + " " + h + "'>" + art + '</svg>';
    return 'url("data:image/svg+xml,' + encodeURIComponent(doc) + '")';
  }

  /** 取出一种图案的 CSS 三件套（名字 / background-image / background-size）。 */
  function patternFor(name) {
    var p = PATTERNS[name] || PATTERNS.wave;
    return {
      name: PATTERNS[name] ? name : 'wave',
      css: svgUri(p.art, p.w, p.h),
      size: p.w + 'px ' + p.h + 'px'
    };
  }

  /**
   * 判断书名更接近哪一类。
   *
   * 按**关键词字数**累加得分，而不是数命中个数：越长的词越具体，理应更重。
   * 例如《时间简史》同时命中 science 的「时间简史」和 classic 的单字「史」，
   * 若按个数算会平局、被数组顺序判成古籍；按字数算就是 4 : 1，正确地归到科学。
   * 单字关键词只可能出现在不需要高精度的类别里，权重天然最低，误伤也最小。
   *
   * @returns {'tech'|'classic'|'science'|'literature'|'general'}
   */
  function genreOf(title) {
    var t = String(title == null ? '' : title).toLowerCase();
    var best = 'general';
    var bestScore = 0;
    for (var g = 0; g < GENRE_KEYWORDS.length; g++) {
      var name = GENRE_KEYWORDS[g][0];
      var words = GENRE_KEYWORDS[g][1];
      var score = 0;
      for (var i = 0; i < words.length; i++) {
        if (t.indexOf(words[i]) >= 0) score += words[i].length;
      }
      if (score > bestScore) {
        bestScore = score;
        best = name;
      }
    }
    return best;
  }

  /** 中文按 1 个字、其它按半个字计，用来判断书名占版面多宽。 */
  function visualLength(text) {
    var s = String(text == null ? '' : text);
    var n = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      var wide = (c >= 0x2e80 && c <= 0x9fff) || (c >= 0xff00 && c <= 0xffef);
      n += wide ? 1 : 0.5;
    }
    return n;
  }

  /** 书名在封面上该用多大字号（px）。 */
  function titleScale(text) {
    var v = visualLength(text);
    for (var i = 0; i < TITLE_SCALE.length; i++) {
      if (v <= TITLE_SCALE[i].max) return TITLE_SCALE[i].size;
    }
    return TITLE_SCALE[TITLE_SCALE.length - 1].size;
  }

  /** 水印用的大字：书名首个可见字符，拉丁字母转大写。 */
  function initialOf(title) {
    var s = String(title == null ? '' : title).trim();
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (ch === ' ' || ch === '《' || ch === '（' || ch === '(' || ch === '[') continue;
      return /[a-z]/.test(ch) ? ch.toUpperCase() : ch;
    }
    return '?';
  }

  /**
   * 一次拿齐封面所需的全部美术参数。
   * @param {string} title 书名
   * @returns {{genre: string, pattern: string, patternCss: string,
   *            patternSize: string, initial: string, nameSize: number}}
   */
  function artFor(title) {
    var h = hashOf(title);
    var genre = genreOf(title);
    var pool = GENRE_PATTERNS[genre] || GENRE_PATTERNS.general;
    var pat = patternFor(pool[h % pool.length]);
    return {
      genre: genre,
      pattern: pat.name,
      patternCss: pat.css,
      patternSize: pat.size,
      initial: initialOf(title),
      nameSize: titleScale(title)
    };
  }

  return {
    ANCHORS: ANCHORS,
    MUDDY_HUE_MIN: MUDDY_HUE_MIN,
    MUDDY_HUE_MAX: MUDDY_HUE_MAX,
    PATTERNS: PATTERNS,
    GENRE_PATTERNS: GENRE_PATTERNS,
    COVER_ASPECT: COVER_ASPECT,
    hashOf: hashOf,
    colorFor: colorFor,
    svgUri: svgUri,
    patternFor: patternFor,
    genreOf: genreOf,
    visualLength: visualLength,
    titleScale: titleScale,
    initialOf: initialOf,
    artFor: artFor
  };
});
