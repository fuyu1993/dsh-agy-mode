# 贡献指南 / Contributing

## 提交注释 / Commit messages

**本项目所有 git 提交注释与发布注释一律中英双语。**
**All commit messages and release notes in this repository are bilingual.**

格式 / Format:

```
<type>: <中文标题> / <English subject>

<中文正文：做了什么、为什么、怎么验证的>

<English body: what changed, why, and how it was verified>
```

- 首行不超过 100 字符 / subject at most 100 columns
- 中文在前、英文在后，两边说同一件事，不互为梗概 / Chinese first, English second; both complete
- `type` 取 `feat`、`fix`、`docs`、`refactor`、`test`、`chore` 之一 / one of those

启用模板 / Enable the template:

```bash
git config commit.template .gitmessage
```

## 发布注释 / Release notes

GitHub Release 的正文必须包含 `## 中文` 与 `## English` 两段，各自完整：
改动、修复、验证方式都要写清，不能只写标题式罗列。

The release body must contain a `## 中文` section and a `## English` section, each
complete: what changed, what was fixed, and how it was verified.

```bash
gh release create vX.Y.Z --title "vX.Y.Z — <中文> / <English>" --notes-file notes.md
```

## 版本与 tag / Versions and tags

- `package.json` 的 `version` 是唯一来源 / `package.json` `version` is the only source of truth
- 每个发布版本一个 annotated tag `vX.Y.Z`，指向 `package.json` 声明该版本的**最后一个**提交
  Each release gets one annotated tag `vX.Y.Z`, pointing at the last commit whose
  `package.json` declares that version

## 合并前 / Before merging

```bash
npm test          # 必须全过 / must be green
```

改动过代码的提交应经 `agy_review` 签收（本仓库自身运行在 Antigravity planner 模式下）。
Commits that change code should be signed off by `agy_review`; this repository
itself is developed in Antigravity planner mode.
