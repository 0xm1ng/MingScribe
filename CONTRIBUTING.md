# 贡献指南

感谢你愿意花时间在这个项目上。这里写的是「改之前必须知道的事」，按重要性排序。

## 两条铁律

改代码前请先读 `README.md` 的「分层约定」一节，那是整个项目的地基。浓缩成两条：

1. **所有格式先转成统一中间格式**（章节列表 + 纯文本），显示层只认它。
   所以它长这样 `{ title, text, totalChars, chapters[{index,title,start,end,text}], stats }`。
2. **阅读位置一律用「章节序号 + 章内字符偏移」，禁止用页码。**
   页码会随字号、窗口尺寸变化，用它做锚点必然错位。

违反这两条的改动，会让进度、搜索、划线、导出同时出问题。

## 开发流程

```bash
npm test          # 182 个用例，Node 内置 runner，零第三方依赖
```

按 `AGENTS.md` 的约定：**每次改动都要提交 Git，并同步补/改测试，交付前全部通过。**

浏览器端到端自检（依赖本机 Edge，不进 `npm test`）：

```bash
node tools/e2e_smoke.js
```

## 四个容易踩的坑

### 1. 新模块必须挂到 `window.MingScribe`

每个 `src/*.js` 都是 UMD：Node 里 `require()` 走 `module.exports` 分支，浏览器里走 `root.MingScribe.X = api` 分支，**两条路互不相干**。所以「单元测试全绿但页面直接报 `X is not defined`」是能发生的——本项目真踩过。

`tests/modules.test.js` 就是守这个的：它在**没有 `module` / `require` 的沙箱**里加载每个脚本，校验全局挂载与 `app.js` 的 `var X = window.MingScribe.X;` 声明一致。**新增模块后要同步把里面 `scripts.length >= N` 的断言改大。**

### 2. 改解析逻辑必须 +1 `PARSER_VERSION`

`src/app.js` 里有 `var PARSER_VERSION = N`。书架打开 EPUB 时**优先用缓存正文重建，不会重解析原文件**。所以任何会改变解析结果的改动，都必须把它 +1，否则老用户看到的还是旧结果。

同理，`src/bookstore.js` 的 `buildMeta` 是**白名单字段**——新增 meta 字段不显式加进去会被静默丢弃。

### 3. 切页必须确定性

`src/paginate.js` 是纯函数，同参数 + 同容器尺寸 ⇒ 同页边界。早期版本会「实测溢出再反推缩放重切」，导致前进 3 页再后退 3 页回不到原处。安全余量是常量 `ROWS_SAFETY = 0.9`，别改成自适应。

另外**段落边距按「每段一次」计费**（`blockExtra`），不能摊进每行——摊进去会随段落数累积误差、整页溢出被裁。

### 4. 测试不要写死时区

`Exporter.formatDateTime` 按**本地时区**渲染（`getHours()` 那一族）。所以：

- 期望值要用**本地时间**构造：`new Date(2026, 8, 14, 10, 10)` → `'2026-09-14 10:10'`，任何时区都成立。
- 反过来，`Date.UTC(...)` 配一个写死的日期字符串**只在东八区成立**——本机跑是绿的，GitHub runner 是 UTC，必挂。2026-09-15 就是这么红了一整轮。
- 本地自检：`TZ=UTC npm test`（或 `TZ=America/New_York`）。CI 里除了三个平台的 UTC，还专门多跑一个 `America/New_York` 的 job 守着这类问题。

## 加一种新格式该动哪里

- **能转成 EPUB 的**（MOBI / AZW3 / DOCX / FB2 / RTF / ODT …）：在 `src/convert.js` 的 `isConvertible` 里加扩展名即可，不需要新解析器——产物会喂给现有的 `Epub.parseEpub`。
- **要新写解析器的**：新建 `src/xxx.js`，输出统一中间格式，然后接进 `app.js` 的入口。进度 / 搜索 / 划线 / 导出**一行都不该改**；如果改了，说明中间格式没对齐。
- **PDF 不做转换**：它是固定版式，转 EPUB 必乱版。要支持得单独开阅读视图，见 README 的「PDF 支持路线图」。

## 依赖原则

网页版目前**零第三方依赖**，这是刻意保持的（`index.html` 双击即用）。往网页版加运行时依赖前，请先开 issue 讨论。桌面版（Tauri）侧的依赖不受此限。

## 提交信息

用 Conventional Commits 前缀即可：`feat:` / `fix:` / `docs:` / `test:` / `refactor:`。中文描述没问题，本项目一直这么写。
