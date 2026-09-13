# MingScribe — 项目长期记忆

## 项目约定

- 仓库根目录 `D:\MingScribe`，Git 仓库，默认分支 `main`，首个提交 `7c4a7ed`。
- **`AGENTS.md`（2026-09-13 创建）为强制工作流约束**，必须遵守：
  1. 每次改动完成后，都必须创建一个对应的 Git commit，以便后续追踪和回滚。
  2. 每次改动后，都必须编写或更新相关测试，并在交付给用户前，确保所有测试和验证全部通过。
- Git 提交身份（仓库级）：`Ethan-bot-coder <grow180th@qq.com>`。

## 环境备注

- 沙箱 Bash 为精简 shim，无 coreutils（`ls`/`cat`/`grep` 不可用），列目录用 Glob，读文件用 Read。
- Windows 环境，Git 对文本文件默认 LF→CRLF 转换。
