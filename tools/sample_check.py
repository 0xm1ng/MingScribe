# -*- coding: utf-8 -*-
"""抽查生成的 TXT 质量：文件头、章节标题、一段正文。"""
import os
import re
import sys

FILES = [
    "Web安全学习笔记.txt",
    "OWASP Web安全测试指南(英文版).txt",
    "Hello-CTF - 开源CTF入门教程.txt",
]
BASE = r"D:\电子书资源\txt"
SHOW_TITLES = 12


def main():
    only = sys.argv[1] if len(sys.argv) > 1 else None
    for name in FILES:
        if only and only.lower() not in name.lower():
            continue
        p = os.path.join(BASE, name)
        print("\n" + "=" * 70)
        print(name)
        if not os.path.exists(p):
            print("  [不存在]")
            continue
        try:
            raw = open(p, encoding="utf-8-sig", errors="strict").read()
        except Exception as e:
            print(f"  [读取失败] {type(e).__name__}: {e}")
            continue
        size = os.path.getsize(p)
        titles = re.findall(r"^第\d+章 .{0,40}$", raw, flags=re.M)
        print(f"  大小 {size/1024:,.0f} KB | 字符 {len(raw):,} | 章节行 {len(titles)}")
        print("  --- 文件头 ---")
        print("  " + "\n  ".join(raw[:400].splitlines()[:8]))
        print("  --- 章节标题（前 %d）---" % SHOW_TITLES)
        for t in titles[:SHOW_TITLES]:
            print("   ", t)
        print("  --- 正文抽样（第 3 章开头 300 字）---")
        m = list(re.finditer(r"^第\d+章 .*$", raw, flags=re.M))
        if len(m) >= 3:
            seg = raw[m[2].end(): m[2].end() + 300]
            print("  " + "\n  ".join(seg.strip().splitlines()[:10]))
        # 残留检测
        residue = len(re.findall(r"^```", raw, flags=re.M)) + len(re.findall(r"!\[[^\]]*\]\(", raw))
        garbled = raw.count("\ufffd")
        print(f"  --- 质量：Markdown 残留 {residue} | 乱码字符 {garbled}")


if __name__ == "__main__":
    main()
