# -*- coding: utf-8 -*-
"""
从明确开源授权的 GitHub 书籍仓库构建 TXT 电子书。

设计约束：
1. 只处理许可证明确允许复制/分发的仓库（GPL-3.0 / CC-BY-SA-4.0 / CC-BY 等）。
2. 输出的 TXT 章节行需匹配 MingScribe 解析器的识别规则
   （行首「第N章/第N节」，整行 <=30 字符，不含 。！？…，、；）。
3. 仅提取 .md 文本，跳过 images/pic 等二进制资源。
"""
import io
import json
import os
import re
import ssl
import sys
import zipfile
import urllib.request

CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE

OUT_DIR = r"D:\电子书资源\txt"
CACHE_DIR = r"C:\Users\Admin\AppData\Local\Temp\ebooks_cache"

# (owner, repo, branch(None=自动), content_root, 输出文件名, 书名, 许可证)
BOOKS = [
    ("ProbiusOfficial", "Hello-CTF", None, "docs",
     "Hello-CTF - 开源CTF入门教程.txt", "Hello-CTF：开源 CTF 入门教程", "GPL-3.0"),
    ("LyleMi", "Learn-Web-Hacking", None, "source",
     "Web安全学习笔记.txt", "Web 安全学习笔记", "CC0-1.0（公有领域）"),
    ("OWASP", "wstg", None, "document",
     "OWASP Web安全测试指南(英文版).txt", "OWASP Web 安全测试指南（英文原版）", "CC-BY-SA-4.0"),
    ("firmianay", "CTF-All-In-One", None, "doc",
     "CTF-All-In-One - CTF竞赛权威指南.txt", "CTF All In One：CTF 竞赛权威指南", "CC-BY-SA-4.0"),
]

# 标题中禁止出现的标点（会被解析器判为正文）
BAD_TITLE_CHARS = re.compile(r"[。！？…，、；：:]")


def log(msg):
    print(msg, flush=True)


def api_get(url, timeout=25):
    req = urllib.request.Request(url, headers={"User-Agent": "curl/8.0"})
    with urllib.request.urlopen(req, timeout=timeout, context=CTX) as r:
        return json.loads(r.read())


def default_branch(owner, repo):
    return api_get(f"https://api.github.com/repos/{owner}/{repo}")["default_branch"]


def download(owner, repo, branch):
    os.makedirs(CACHE_DIR, exist_ok=True)
    cache = os.path.join(CACHE_DIR, f"{owner}__{repo}__{branch}.zip")
    if os.path.exists(cache) and os.path.getsize(cache) > 100 * 1024:
        log(f"  [缓存命中] {os.path.basename(cache)} ({os.path.getsize(cache)/1024/1024:.1f} MB)")
        return open(cache, "rb").read()
    url = f"https://codeload.github.com/{owner}/{repo}/zip/refs/heads/{branch}"
    log(f"  [下载] {url}")
    req = urllib.request.Request(url, headers={"User-Agent": "curl/8.0"})
    with urllib.request.urlopen(req, timeout=180, context=CTX) as r:
        data = r.read()
    with open(cache, "wb") as f:
        f.write(data)
    log(f"  [完成] {len(data)/1024/1024:.1f} MB")
    return data


TEXT_EXT = (".md", ".rst")


def strip_front_matter(text):
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end != -1:
            return text[end + 4:]
    return text


def clean_title(title, fallback):
    t = (title or "").strip()
    t = t.strip("#").strip()
    if not t:
        t = fallback
    t = BAD_TITLE_CHARS.sub(" ", t)
    t = re.sub(r"\s+", " ", t).strip()
    if len(t) > 26:
        t = t[:25].rstrip() + "…"
    return t or fallback


def clean_rst(text):
    """把 reStructuredText 清洗为纯文本。"""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    # 指令与注释（.. note:: / .. code-block:: / .. image:: 等）
    text = re.sub(r"^\s*\.\..*$", "", text, flags=re.M)
    # 字段列表
    text = re.sub(r"^\s*:[\w-]+:.*$", "", text, flags=re.M)
    # 标题下划线行
    text = re.sub(r"^\s*([=\-~^\"'`#*+])\1{2,}\s*$", "", text, flags=re.M)
    # 超链接 `文字 <url>`_ → 文字
    text = re.sub(r"`([^`<]+?)\s*<[^>]+>`(?:__?)?", r"\1", text)
    text = re.sub(r"\|[^|]+\|_replace", "", text)
    # 强调
    text = re.sub(r"\*\*([^*]+)\*\*", r"\1", text)
    text = re.sub(r"(?<!\*)\*([^*\n]+)\*(?!\*)", r"\1", text)
    text = re.sub(r"``([^`]+)``", r"\1", text)
    # 代码块缩进收敛
    text = re.sub(r"^    ", "  ", text, flags=re.M)
    text = re.sub(r"^\s*::\s*$", "", text, flags=re.M)
    # 列表
    text = re.sub(r"^\s*[-*]\s+", "  · ", text, flags=re.M)
    text = re.sub(r"^\s*#\.\s+", "  ", text, flags=re.M)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def clean_markdown_body(text):
    """把 Markdown 正文清洗为适合纯文本阅读的形式。"""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = strip_front_matter(text)

    # HTML 注释
    text = re.sub(r"<!--.*?-->", "", text, flags=re.S)
    # mkdocs 片段引入语法
    text = re.sub(r"--8<--.*", "", text)
    # mkdocs 容器：!!! note "标题" / ??? note "标题"
    text = re.sub(r'^!!!\s+(\w+)\s*"?([^"\n]*)"?\s*$', r"【\2】", text, flags=re.M)
    text = re.sub(r'^\?\?\+\s+\w+\s*"?([^"\n]*)"?\s*$', r"【\1】", text, flags=re.M)

    # 代码块：先抽出，避免内部符号被清洗
    blocks = []

    def _stash(m):
        blocks.append(m.group(1))
        return f"\n@@CODE{len(blocks) - 1}@@\n"

    text = re.sub(r"```[a-zA-Z0-9_+-]*\n(.*?)```", _stash, text, flags=re.S)

    # 图片
    text = re.sub(r"!\[([^\]]*)\]\([^)]*\)", lambda m: f"[图片：{m.group(1)}]" if m.group(1).strip() else "", text)
    # 链接
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)
    # 引用块
    text = re.sub(r"^\s*>\s?", "", text, flags=re.M)
    # 强调符号
    text = re.sub(r"\*\*([^*]+)\*\*", r"\1", text)
    text = re.sub(r"(?<!\*)\*([^*\n]+)\*(?!\*)", r"\1", text)
    text = re.sub(r"`([^`]+)`", r"\1", text)

    # 标题行：保留文字，作为段落前的小标题
    text = re.sub(r"^\s*#{1,6}\s*(.+?)\s*$", r"\n\1\n", text, flags=re.M)

    # 表格：去掉分隔行，| 换成空白
    text = re.sub(r"^\s*\|?[\s:\-\|]+\|[\s:\-\|]*$", "", text, flags=re.M)
    text = re.sub(r"\|", "  ", text)

    # 列表符号保留，但统一缩进
    text = re.sub(r"^\s*[-*+]\s+", "  · ", text, flags=re.M)

    # 多余空行
    text = re.sub(r"\n{3,}", "\n\n", text)

    # 还原代码块
    for i, code in enumerate(blocks):
        text = text.replace(f"@@CODE{i}@@", "\n" + code.strip("\n") + "\n")

    return text.strip()


def read_md(z, name):
    try:
        raw = z.read(name)
    except KeyError:
        return None
    for enc in ("utf-8", "gb18030", "utf-16"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="ignore")


def order_files(z, prefix, content_root, all_md):
    """优先用 SUMMARY.md 决定顺序，否则按路径排序。"""
    rel = [(n[len(prefix):], n) for n in all_md]
    summary_name = None
    for r, n in rel:
        if r.lower() == f"{content_root}/summary.md" or r.lower() == "summary.md":
            summary_name = n
            break
    if not summary_name:
        return [n for _, n in sorted(rel)]

    body = read_md(z, summary_name) or ""
    ordered, seen = [], set()
    for m in re.finditer(r"\(([^)\s]+\.md)(?:#[^)]*)?\)", body):
        target = m.group(1)
        target = target.split("#")[0]
        if not target.endswith(".md"):
            continue
        cand = os.path.normpath(os.path.join(os.path.dirname(content_root), target)) if not target.startswith(content_root) else target
        cand = cand.replace("\\", "/")
        for r, n in rel:
            if r.lower() == cand.lower() and n not in seen:
                ordered.append(n)
                seen.add(n)
                break
    # 未被目录收录的文件，按路径补在后面
    for _, n in sorted(rel):
        if n not in seen:
            ordered.append(n)
            seen.add(n)
    return ordered


def build(owner, repo, branch, content_root, out_name, book_title, license_name):
    if not branch:
        branch = default_branch(owner, repo)
    log(f"\n{'='*66}\n{book_title}\n  来源：https://github.com/{owner}/{repo}  许可证：{license_name}")
    data = download(owner, repo, branch)
    z = zipfile.ZipFile(io.BytesIO(data))

    names = z.namelist()
    prefix = names[0].split("/")[0] + "/"
    root = f"{prefix}{content_root}/"
    all_md = [n for n in names if n.lower().endswith(TEXT_EXT) and n.startswith(root)]
    if not all_md:
        log(f"  [跳过] {root} 下未找到 .md/.rst")
        return None

    all_md = [n for n in all_md if "/node_modules/" not in n]
    ordered = order_files(z, prefix, content_root, all_md)
    log(f"  章节文件：{len(ordered)} 个")

    parts = []
    parts.append(f"{book_title}\n")
    parts.append(f"来源仓库：https://github.com/{owner}/{repo}\n")

    chapter_no = 0
    total_chars = 0
    skipped = 0
    for n in ordered:
        ext = os.path.splitext(n)[1].lower()
        raw_md = read_md(z, n)
        if raw_md is None:
            skipped += 1
            continue
        src = strip_front_matter(raw_md.replace("\r\n", "\n"))
        fallback = os.path.splitext(os.path.basename(n))[0]
        fallback = re.sub(r"^\d+[._\-]\s*", "", fallback).replace("-", " ").replace("_", " ")

        if ext == ".rst":
            # reStructuredText：标题由下一行的下划线符号标记
            m = re.search(r"^(.+?)\n([=\-~^'\"])\2{2,}\s*$", src, flags=re.M)
            title = clean_title(m.group(1) if m else "", fallback)
            body = clean_rst(raw_md)
            if m:
                body = re.sub(
                    r"^\s*" + re.escape(m.group(1).strip()) + r"\s*$", "", body, count=1, flags=re.M
                )
        else:
            # Markdown：一级标题作为章节名
            m = re.search(r"^#\s+(.+?)\s*$", src, flags=re.M)
            title = clean_title(m.group(1) if m else "", fallback)
            body = clean_markdown_body(raw_md)
            if m:
                body = re.sub(
                    r"^\s*#\s+" + re.escape(m.group(1).strip()) + r"\s*$", "", body, count=1, flags=re.M
                )
        body = body.strip()
        if not body:
            skipped += 1
            continue

        chapter_no += 1
        parts.append(f"\n\n第{chapter_no}章 {title}\n\n{body}\n")
        total_chars += len(body)

    text = "".join(parts)
    out_path = os.path.join(OUT_DIR, out_name)
    os.makedirs(OUT_DIR, exist_ok=True)
    with open(out_path, "w", encoding="utf-8-sig", newline="\n") as f:
        f.write(text)

    # 回读校验：安全软件可能刚写入就隔离，或置为不可读状态
    survived = False
    blocked_msg = ""
    try:
        with open(out_path, "rb") as f:
            f.read(4096)
        survived = True
    except Exception as e:
        blocked_msg = f"{type(e).__name__}: {e}"

    size_kb = os.path.getsize(out_path) / 1024 if os.path.exists(out_path) else 0
    log(f"  生成：{out_name}")
    log(f"  章节数：{chapter_no}   字符数：{total_chars:,}   文件大小：{size_kb:,.0f} KB   （空文件跳过 {skipped}）")
    if not survived:
        log("  [警告] 写入后无法读回，极可能被 Windows Defender 阻断")
        log(f"         原因：{blocked_msg}")
        log("         处理：Windows 安全中心 → 病毒和威胁防护 → 保护历史记录 → 还原并添加排除项")
    return out_name, book_title, chapter_no, total_chars, owner, repo, license_name


def main():
    only = sys.argv[1] if len(sys.argv) > 1 else None
    books = [b for b in BOOKS if not only or only.lower() in b[1].lower() or only.lower() in b[0].lower()]
    results = []
    for cfg in books:
        try:
            r = build(*cfg)
            if r:
                results.append(r)
        except Exception as e:
            log(f"  [失败] {cfg[1]}: {type(e).__name__}: {e}")

    # 来源与授权说明
    if results:
        lines = [
            "电子书资源说明",
            "=" * 60,
            f"生成日期：2026-09-13",
            f"生成工具：MingScribe/tools/build_ebooks.py",
            "",
            "【重要：关于版权】",
            "本目录下所有书籍均来自明确采用开源许可的公开仓库，",
            "许可协议允许自由复制、分发与再发布。请勿将本目录用于商业售卖。",
            "如需商用，请先查阅各书对应的 LICENSE 条款。",
            "",
            "【书目与授权】",
        ]
        for out_name, book_title, cn, tc, owner, repo, lic in results:
            lines.append("")
            lines.append(f"· {book_title}")
            lines.append(f"  文件：{out_name}")
            lines.append(f"  来源：https://github.com/{owner}/{repo}")
            lines.append(f"  许可：{lic}")
            lines.append(f"  规模：{cn} 章 / {tc:,} 字")
        lines += [
            "",
            "【授权摘要】",
            "· GPL-3.0：可自由使用、复制、修改、分发；衍生作品须同样以 GPL-3.0 开源。",
            "· CC-BY-SA-4.0：可自由复制、分发、改编；须署名原作者，且衍生作品采用相同协议。",
            "",
            "【格式说明】",
            "· 编码：UTF-8 with BOM（兼容 Windows 记事本与 MingScribe 阅读器）",
            "· 章节行格式：「第N章 标题」，可被 MingScribe 阅读器自动识别为目录",
            "· 原始 Markdown 中的图片链接已替换为 [图片：说明]，代码块内容保留",
        ]
        p = os.path.join(OUT_DIR, "00-来源与授权说明.txt")
        with open(p, "w", encoding="utf-8-sig", newline="\n") as f:
            f.write("\n".join(lines))
        log(f"\n说明文件：{p}")

    log(f"\n{'='*66}\n全部完成，共 {len(results)} 本")
    return 0


if __name__ == "__main__":
    sys.exit(main())
