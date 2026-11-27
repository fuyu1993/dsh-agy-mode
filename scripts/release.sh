#!/usr/bin/env bash
#
# 发布一个版本：推送 → tag → Release → npm。
# Release a version: push, tag, GitHub Release, npm.
#
# 规则（见 CONTRIBUTING.md）：提交推送后必须依次完成打 tag、建 Release、发布
# 到 npm，四处指向同一个提交。本脚本把顺序固定下来，任一步失败即停，不留下
# 「推了但没发」的半成品。
#
# The rule (see CONTRIBUTING.md): a pushed commit is followed by a tag, a GitHub
# Release and an npm publish, all naming one commit. This script fixes the order
# and stops on the first failure rather than leaving a half-published version.
#
# 用法 / Usage:
#   scripts/release.sh --notes FILE    # 用指定文件作为 Release 正文（必填）
#   scripts/release.sh --notes FILE --title TEXT   # 指定 Release 标题
#   scripts/release.sh --notes FILE --dry-run      # 只检查，不发布
#
# 标题缺省为 tag 名；建议用双语形式，与 CONTRIBUTING.md 的约定一致。
# The title defaults to the tag name; the bilingual form CONTRIBUTING.md shows is
# preferred when you pass one.
#
# 前置 / Requires: clean tree, gh authenticated, npm authenticated for
# registry.npmjs.org, and the version not yet published.

set -euo pipefail

cd "$(dirname "$0")/.."

REGISTRY='https://registry.npmjs.org/'
DRY_RUN=0
NOTES=''
TITLE=''

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --notes)
      [ $# -ge 2 ] || { echo 'release: --notes needs a file' >&2; exit 2; }
      NOTES="$2"; shift 2 ;;
    --title)
      [ $# -ge 2 ] || { echo 'release: --title needs text' >&2; exit 2; }
      TITLE="$2"; shift 2 ;;
    -h|--help) awk 'NR>1 && /^#/ {sub(/^# ?/,""); print; next} NR>1 {exit}' "$0"; exit 0 ;;
    *) echo "release: unknown argument: $1" >&2; exit 2 ;;
  esac
done

say() { printf '\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\033[31mrelease: %s\033[0m\n' "$*" >&2; exit 1; }
step() { say "→ $*"; }

# --- 版本 / version ---------------------------------------------------------

VERSION=$(node -p "require('./package.json').version")
TAG="v$VERSION"
[ -n "$VERSION" ] || fail 'package.json has no version'

step "version $VERSION (tag $TAG)"

# --- 前置检查 / preconditions -----------------------------------------------

# 版本未被占用：已发布的版本不可覆盖，早失败好过推送后才发现。
if npm view "dsh-agy-mode@$VERSION" version --registry "$REGISTRY" >/dev/null 2>&1; then
  fail "dsh-agy-mode@$VERSION is already on the registry; bump the version first"
fi

# 工作区必须干净，否则打出的 tag 会指向一个不完整的提交。
[ -z "$(git status --porcelain --untracked-files=no)" ] \
  || fail 'working tree has uncommitted changes; commit them before releasing'

BRANCH=$(git rev-parse --abbrev-ref HEAD)
[ "$BRANCH" = 'main' ] || fail "not on main (on $BRANCH); releasing from another branch is not supported"

# tag 若已存在，说明这个版本已经打过，不能静默覆盖。
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  fail "tag $TAG already exists locally"
fi

# 认证先于推送：gh 或 npm 未登录时，早失败好过推了 main 和 tag 才发现，那会留下
# 一个本地 tag 挡住直接重跑。
# Auth before pushing: an unauthenticated gh or npm fails better here than after
# main and the tag are public, which would leave a local tag blocking a re-run.
step 'auth'
gh auth status >/dev/null 2>&1 || fail 'gh is not authenticated'
npm whoami --registry "$REGISTRY" >/dev/null 2>&1 \
  || fail "not authenticated for $REGISTRY (the default registry in ~/.npmrc is a mirror)"

# 远端 tag 同名也算冲突：覆盖已发布的 tag 会让别人拉到与本地不同的提交。
# A remote tag of the same name is a conflict too: overwriting a published tag
# makes others fetch a different commit than the local one.
if git ls-remote --tags origin "refs/tags/$TAG" | grep -q .; then
  fail "tag $TAG already exists on origin"
fi

step 'tests'
npm test >/tmp/dsh-agy-mode-test.log 2>&1 || { tail -20 /tmp/dsh-agy-mode-test.log >&2; fail 'tests failed'; }
grep -E '^# (tests|pass|fail)' /tmp/dsh-agy-mode-test.log >&2

if [ -n "$NOTES" ] && [ ! -f "$NOTES" ]; then
  fail "release notes file not found: $NOTES"
fi

# 正文必填：占位正文会让 Release 看起来像发布过，实际什么都没说明。规则要求
# 两段都完整，脚本不替作者编内容。
# The notes are mandatory: a placeholder body makes a Release look published
# while explaining nothing, and the rule asks for two complete sections.
[ -n "$NOTES" ] || fail 'pass --notes FILE; a Release body is required (see CONTRIBUTING.md)'

# 正文必须中英双语，缺任何一段都不发——这是仓库规则，不是建议。这条放在
# dry-run 之前，否则检查形同虚设。
# Both sections are mandatory, and this check runs before the dry-run so a
# preview cannot report success on notes the real run would reject.
grep -q '^## 中文' "$NOTES" || fail "release notes lack a '## 中文' section: $NOTES"
grep -q '^## English' "$NOTES" || fail "release notes lack a '## English' section: $NOTES"

if [ "$DRY_RUN" = 1 ]; then
  step 'packing (dry run)'
  npm pack --dry-run --registry "$REGISTRY" 2>&1 | tail -6 >&2
  say 'dry run: checks passed, nothing was pushed, tagged, released or published'
  exit 0
fi

# --- 1. 推送 / push ---------------------------------------------------------

step 'push main'
git push origin main

# --- 2. 打 tag / tag --------------------------------------------------------

# annotated，而不是轻量 tag：它记录发布者与时间，且指向确切的提交。
git tag -a "$TAG" -m "$TAG" -m "由 scripts/release.sh 发布 / released by scripts/release.sh"
step "push $TAG"
git push origin "$TAG"

# --- 3. 建 Release / GitHub Release -----------------------------------------

[ -n "$TITLE" ] || TITLE="$TAG"
step "create release $TAG ($TITLE)"
gh release create "$TAG" --title "$TITLE" --notes-file "$NOTES" --verify-tag

# --- 4. 发布到 npm / publish -----------------------------------------------

# 显式指定 registry：本机 ~/.npmrc 默认指向镜像，认证只对 npmjs 有效。
step "publish to $REGISTRY"
npm publish --access public --registry "$REGISTRY"

# --- 5. 一致性校验 / verify -------------------------------------------------

step 'verify'
REMOTE_HEAD=$(git rev-parse 'origin/main' 2>/dev/null || true)
TAG_HEAD=$(git rev-parse "$TAG^{commit}")
[ "$REMOTE_HEAD" = "$TAG_HEAD" ] || fail "origin/main ($REMOTE_HEAD) and $TAG ($TAG_HEAD) disagree"

PUBLISHED_HEAD=$(npm view "dsh-agy-mode@$VERSION" gitHead --registry "$REGISTRY" 2>/dev/null | tr -d "'\"")
[ "$PUBLISHED_HEAD" = "$TAG_HEAD" ] \
  || fail "npm gitHead ($PUBLISHED_HEAD) and $TAG ($TAG_HEAD) disagree"

say "released $TAG ($TAG_HEAD) — git, tag, Release and npm all name the same commit"
