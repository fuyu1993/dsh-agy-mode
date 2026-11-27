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

## 发布流程 / Release procedure

**规则：提交推送到 git 之后，必须接着打 tag、建 Release、发布到 npm，三步做完才算发布。**
**Rule: once a commit is pushed, it is followed by a tag, a GitHub Release and an
npm publish. All three complete before a version counts as released.**

顺序固定，用脚本执行，不要手工逐步敲：
The order is fixed; run the script instead of typing the steps by hand:

```bash
# --notes 必填，两种模式都要；--title 缺省为 tag 名
npm run release:check -- --notes notes.md   # 只检查：认证、版本未占用、树干净、测试通过、打包正常
npm run release       -- --notes notes.md   # 真正发布：npm → 推送 → tag → Release → 一致性校验
```

手工等价于 / Equivalently, by hand:

```bash
# 1. npm 先发：它拒绝重复版本，是最安全的第一道闸门，也避免验证码在推送后过期
npm publish --access public --registry https://registry.npmjs.org/ --otp <code>
# 2-4. 其余三步
git push origin main
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
gh release create vX.Y.Z --title "vX.Y.Z — <中文> / <English>" --notes-file notes.md --verify-tag
```

**npm 为什么排第一**：一次性验证码（2FA）只有约 30 秒有效期。若先推 main、打 tag、
建 Release 再发布，验证码往往已过期，于是留下「GitHub 已发、npm 没有」的半成品——
正是这套流程要避免的状态。`npm publish` 拒绝重复版本，成功即证明版本号未被占用，
后续步骤失败都可安全重跑。2FA 账号请用 `--otp <code>`，或走 registry 的浏览器授权。

**Why npm goes first**: a 2FA one-time password lives about 30 seconds. Pushing
main, tagging and creating the Release before publishing usually lets it expire,
leaving GitHub ahead of npm — exactly the state this procedure exists to prevent.
`npm publish` refuses a duplicate version, so its success proves the version
number is free and any later step can be safely retried. A 2FA account should pass
`--otp <code>`, or use the registry's browser authorisation.

### 为什么四步必须一起 / Why all four

- **tag** 让一个版本号锚定到一个确切提交，没有它 `vX.Y.Z` 只是巧合。
  A tag anchors a version number to one commit; without it `vX.Y.Z` is a coincidence.
- **Release** 是给人读的改动说明与升级入口。
  The Release is the human-readable changelog and upgrade entry point.
- **npm** 是安装来源。DSH 插件页的「版本」栏只对 registry 安装渲染，只在 GitHub
  发布的话用户装到的版本与页面显示的对不上。
  npm is the install source. The DSH plugin page renders its version column only
  for registry installs, so a GitHub-only release leaves what users install out
  of step with what the page shows.

脚本最后会核对三者：`origin/main`、`vX.Y.Z` 的提交、npm 记录的 `gitHead` 必须
是同一个提交，否则报错退出。历史上 0.4.4 就出现过 npm 已发、main 未推、无 tag
的错位，这个校验是为了不再出现。

The script ends by checking that `origin/main`, the tag's commit and the `gitHead`
npm recorded are one commit, and fails otherwise. 0.4.4 once shipped to npm while
main lagged two commits behind and no tag existed; this check exists so that
cannot recur.

### 前置条件 / Preconditions

- npm 认证只对 `registry.npmjs.org` 有效：本机 `~/.npmrc` 默认指向镜像，所以脚本
  **显式**传 `--registry`，不要依赖默认值。
  npm auth is only valid for `registry.npmjs.org`; the local `~/.npmrc` defaults to
  a mirror, so the script passes `--registry` explicitly rather than trusting the
  default.
- 2FA 账号必须提供 `--otp`，或改用 registry 的浏览器授权；只给 token 会得到 `EOTP`。
  A 2FA account must provide `--otp` or use the registry's browser authorisation; a
  bare token yields `EOTP`.
- 已发布的版本不可覆盖，必须先改 `package.json` 的 `version`。
  A published version cannot be overwritten; bump `package.json` `version` first.
- `gh` 与 npm 都必须先登录：脚本在推送 main 之前就检查，避免推了 main 和 tag 才
  失败，留下一个本地 tag 挡住直接重跑。
  Both `gh` and npm must be authenticated; the script checks before pushing main,
  so a failure cannot leave main and a tag public while blocking a re-run.
- 发布沙箱/暂存（staged publishing）开启时，`npm publish` 后需到 npm 网页批准才会
  真正上线；脚本只在 `gitHead` 可读时通过校验。
  With staged publishing on, `npm publish` needs approval on the npm website
  before the version is live; the script only passes once `gitHead` is readable.

## 合并前 / Before merging

```bash
npm test          # 必须全过 / must be green
```

改动过代码的提交应经 `agy_review` 签收（本仓库自身运行在 Antigravity planner 模式下）。
Commits that change code should be signed off by `agy_review`; this repository
itself is developed in Antigravity planner mode.
