# Antigravity 规划模式 / Antigravity planner mode

给 DSH（DeepSeek Harness）加一个模式：判断交给本机 **Antigravity CLI（`agy`）**，干活交给 **DSH**。开工前由你选两边的模型和思考强度，子任务开不开、同时几个、递归几层也由你定。

**最要紧的一条**：dsh 干完的活质量不由 dsh 自己说了算 —— 交付前必须过 `agy_review`，agy 给结构化判定（pass / fail）和按严重度排的具体问题。有 blocker 或 major，这活就不算完。

继承「标准模式」的全部工具，额外加五个工具和两道强制：

| 工具 | 作用 |
|---|---|
| `agy_consult` | 让 `agy` 只读地跑一轮：`mode: plan` 出实现方案（规划档），`mode: quick` 便宜快答，`mode: review` 出文字批评。 |
| `agy_review` | 质量闸门：默认自己收集工作区 diff（含新增未跟踪文件及任务内提交）直送 agy，返回结构化 `verdict` 和 findings（blocker / major / minor / nit）。 |
| `agy_models` | 列出本机 `agy` 认的模型 id、思考强度档位与当前默认路由。 |
| `agy_routes` | 记录你在开工时选定的本任务 `agy` 模型与强度覆盖，供后续轮次与子任务自动继承。 |
| `agy_delegation_budget` | 记录你关于子任务的决定：开不开、同时几个、递归几层。没记录前，`subagent` / `subagent_fork` / `workflow` 一律被拦。 |

两道强制：

1. **质量闸门**（`agy_review`）—— 改过东西的回合不能直接结束，没有审核就收尾会被塞一条指令要求先审；agy 判 fail 之后闸门不打开，除非后续审核通过。
2. **子任务预算**（`agy_delegation_budget`）—— 派活前实时按存活子任务数与调用者深度校验。

```
┌─ 你 ──────────────────────────────────────────────┐
│ 1. agy 用哪个模型、多高的强度？                     │
│ 2. dsh 自己用哪个模型、多高的强度？                 │
│ 3. 子任务开不开？同时几个？递归几层？               │
└───────────────┬───────────────────────────────────┘
                ▼
   agy 规划（只读）──► dsh 实现 ──► agy_review ──► 汇报
                                      │
                          blocker/major？改完再审
```

---

## 目录

- [模式名与语言](#模式名与语言)
- [它和其它模式的区别](#它和其它模式的区别)
- [安装](#安装)
- [配置](#配置)
- [质量闸门怎么判定](#质量闸门怎么判定)
- [开工前的四个问题](#开工前的四个问题)
- [边界与限制](#边界与限制)
- [验证情况](#验证情况)
- [许可证](#许可证)

---

## 模式名与语言

模式选择器里固定显示 **Antigravity planner**，描述也是一句英文，不随界面语言变化。

早期版本试过用 `!!js` 读界面语言动态换名，在 DSH 0.2.2-rc.5 上不成立：preset 这一行声明了 `EntryGroup`，而 loader 对这类行整块跳过 `!!js` 求值（它要等子插件各自激活才求值），但插件自己的 schema 又要求 `name` 是字符串，于是激活直接报 `expected string but got [object Object]`。所以这两项现在是字面量。

插件页里的标题与说明不受影响，仍来自 `locale/zh.json` 与 `locale/en.json`，由 DSH 自己的本地化机制切换。

## 它和其它模式的区别

| | 标准模式 | 本模式 |
|---|---|---|
| 谁做技术判断 | DSH 自己 | `agy`（本机 Antigravity CLI） |
| 谁动文件、跑命令、跑测试 | DSH | DSH（不变） |
| 成品质量谁说了算 | DSH 自己 | `agy_review` 的结构化判定 |
| 没审核就收尾 | 可以 | 会被拦住，要求先审 |
| 开工前是否先问模型/强度 | 否 | 是，两边都问 |
| 子任务预算 | 宿主设置 | 你在会话里当场定，且有硬拦截 |

`agy` 始终以自己的 **只读 plan 模式** 运行（`--mode plan`，即使给了 `--dangerously-skip-permissions` 也写不了文件 —— 本机实测确认）。所以规划与审核是它唯一能做的事。

## 安装

需要本机已装好并登录 `agy`（`agy --version` 有输出、`agy models` 能列模型）。

```bash
# 从 npm 安装（推荐：插件页会显示「版本」栏，可查看并升级到新版本）
dsh plugin --profile <你的 profile> add dsh-agy-mode

# 或从 GitHub 安装（版本栏不显示，升级需重装）
dsh plugin --profile <你的 profile> add github:fuyu1993/dsh-agy-mode

# 或克隆后本地安装
git clone https://github.com/fuyu1993/dsh-agy-mode.git
dsh plugin --profile <profile> add /绝对路径/dsh-agy-mode
```

只有从 npm 安装的插件，插件详情页才会出现「版本」栏（可更新到哪个版本、还有几个新版本、逐版本升级）。从 GitHub 或本地路径安装的，Host 不认为它有可查询的版本序列，那一栏就不会渲染。

装好后重启一次 DSH，新建任务时在模式选择器里选 **Antigravity planner**（这是固定英文名，不随界面语言变化）。

## 配置

### 在插件页改模型与思考强度（推荐）

**插件 → dsh-agy-mode** 页面顶部有一张「agy 模型与思考强度」卡片：规划、快问、审核三档各有一个模型输入框和强度下拉框。改完立即保存，**下一次 agy 调用就生效**，不用新建任务、不用重启。

模型是输入框而非下拉，因为 `agy models` 是按账号和 CLI 版本返回的（本机 27 个，且会变）；卡片上有「列出本机可用模型」按钮，点一下就能看到当前可用的 id。

页面写的是 `agy-planner-config` 这个 Host 行，它只存模型与强度，不注册任何工具，所以其它模式拿不到 agy 工具。

### `cordis.patch.yml` 里的其它设置

`agy-planner` 行（preset 内）：

| 字段 | 默认 | 含义 |
|---|---|---|
| `command` | `agy` | 可执行文件。裸名走 PATH，绝对路径会被校验。 |
| `timeoutSeconds` | `900` | 单次咨询的 `--print-timeout`。0 表示不设限。 |
| `reuseConversations` | `true` | 同一任务内续接 agy 会话，不重复冷启动。 |
| `maxConversationTurns` | `12` | 会话累积到这么多轮就换新的（太长反而更贵）。 |
| `maxReviewRounds` | `3` | 连续审核失败几次后停下，不再自动重试。 |
| `diffMaxBytes` | `48000` | 送审 diff 的长度上限（旧名 `diffMaxChars` 仍可读）。 |
| `maxPromptBytes` | Linux `120000` / macOS `500000` / Windows `26000` | 单次通过 CLI 参数传递的提示词上限，按平台计（旧名 `maxPromptChars` 仍可读）。 |
| `allowExternalCwd` | `false` | 是否允许 `cwd` 指向会话工作区之外。 |
| `allowedRoots` | `[]` | 额外允许 `cwd` 指向的目录。 |
| `extraArgs` | `[]` | 额外透传给 `agy` 的命令行参数列表。 |
| `retries` | `1` | 网关/限流这类瞬时失败的重试次数。 |
| `requireReview` | `true` | 改成 `false` 关掉「改了东西就必须审核」的收尾拦截（`agy_review` 工具仍在）。 |

`agy-planner-config` 行（Host 层）存 `planModel` / `planEffort` / `consultModel` / `consultEffort` / `reviewModel` / `reviewEffort`，也就是插件页编辑的那六个字段。优先级：单次调用参数 > 本任务 `agy_routes` > 插件页 > 内置默认。

**`cwd` 校验**：agy 带 `--dangerously-skip-permissions` 只读运行，能读任何被指向的目录，而会话的沙箱策略不随之生效。所以 `cwd` 默认必须落在会话工作区内（`realpath` + `relative` 判定，兼容 `/tmp` → `/private/tmp` 软链与 Windows 盘符），越界会明确报错，要放行就配上面两项。

**模型 id 自带强度**：agy 的模型名带后缀（`gemini-4-hydrogen-high`），此时再传 `--effort` 会被 agy 判为冲突并报错。插件会自动处理 —— 带后缀的 id 优先，不再额外传 effort；要让某一档真正换强度，就用不带后缀的 id（如 `gemini-4-hydrogen`）。

插件页与配置文件只影响默认值，模式本身仍会在开工前问你。

## 质量闸门怎么判定

`agy_review` 走 agy 的 `--json-schema` 结构化输出，返回：

```
{ verdict, summary, findings: [{ severity, file?, line?, problem, fix? }] }
```

判定规则由插件决定，不交给模型自觉：

- 有任何 **blocker** 或 **major** → `fail`，闸门保持关闭。
- 只有 minor / nit → `pass with notes`，可以交付，但要在汇报里说清。
- 审核提示词限定「按需求原文判，不按你想要的设计判」；需求没规定的场景只算 uncovered，不能当 blocker —— 实测中这条把「`total('2',3)` 返回 `'23'`」从 major 降到了 minor。

agy 若没返回结构化结果，插件**报错而不是猜**：拿不到判定就不假装通过了。

### 审了但没修，不算过关

闸门只认「**pass**」，不认「审过一次」。上一版有个漏洞：agy 判 fail 之后 DSH 直接收尾，插件并不知道问题没解决。

现在的行为：

- fail 之后闸门**不打开**，收尾会再拦一次，并点名还挂着哪几条 finding。
- 续审时把上一轮的 findings 一起发给 agy，让它只复核这些点，而不是把整个任务重审一遍。
- 连续失败到 `maxReviewRounds`（默认 3）就**停止自动重试**，改为要求 DSH 如实汇报分歧，交给你判断 —— 防止「改不对→再审→还不对」的烧钱循环。
- fail 但 agy 一条 finding 都没给，也照样锁住闸门（按一条 major 处理）。

### 默认送 diff，不让 agy 自己重读

`agy_review` 默认 `scope: "diff"`：插件自己跑 `git diff HEAD` 收集改动（含未提交），连同改动文件列表一起塞进提示词。

这么做的原因：实测同一份改动，把 diff 塞进提示词耗 10.9k token，让 agy 自己探索耗 10.8k —— **钱一样多**，但后者只转 1 轮就回答了，很可能根本没读文件。花同样的钱买到不可靠的结论。

`scope: "repo"` 才让 agy 自己探索仓库，适合需要跨文件追踪调用方的改动，代价是一次冷启动。

## 开工前的四个问题

第一次真正动手之前，模式要求 DSH 用 `ask_user_question` 一次问完：

1. **agy** 的模型与思考强度（先用 `agy_models` 拉清单）；
2. **DSH 自己**的模型与思考强度（输入框旁边的模型控件随时也能换）；
3. 子任务：开不开、同时几个、递归几层；
4. 还有哪些信息光靠读代码拿不到。

第 3 条由 `agy_delegation_budget` 落账，之后每次派活都按**当前存活子任务数**和**调用者深度**实时校验。没问过就派活，会被直接拒绝并提示先问你。

## 边界与限制

- `agy` **看不到这个对话**，所以提示词必须自包含；模糊的简报只会换来模糊的方案。
- 没登录时 `agy` 的报错只出现在 stderr，插件会把它翻译成「请先登录」而不是回一个空答案。
- 收尾拦截是「塞一条指令」而非硬失败：你明确说不要审核时，模型可以说明后结束。
- 续接会话省的是冷启动的钱，但上下文会累积；到 `maxConversationTurns` 会自动换新会话。
- 同一任务的 plan / quick / review 共用一个 agy 会话（同一个代码库，没必要分开重读）。换目录会自动新开。
- 只读的 shell 命令（`git status`、`npm test`）不再被当成改动：插件在调用前后各算一次仓库指纹，变了才算脏。这也保证一条只读命令不会把已停下的审核循环重新启动。
- 审核期间若有子任务改了文件，这次 `pass` **不算数**：闸门按 epoch 判定，会给出一条 major 并要求重审。
- `.idea/`、`.vscode/`、`node_modules/`、`dist/` 这类编辑器与构建产物不进送审 diff（只报一个跳过数量），既省 token 也不会被误当成改动。
- 网页渲染、浏览器操作这类 agy 自带工具对编程任务没用，但会在每次调用的固定开销里；目前没法裁剪。
- 审核要花一次 agy 调用的时间与额度；大改动建议一次审完，不要一句一改一审核。
- 子任务预算按任务记在内存里，**不落盘**：新任务会重新问，这是有意为之。
- 本模式不改变 profile 的权限策略；沙箱与审批设置仍然决定 DSH 自己能做什么。
- 每次咨询受 `timeoutSeconds` 与一小时工具超时双重限制。
- 每次调用的 token 花费会累计并在结果里回报（`agy so far: N call(s), X in (Y% cached), Z out`）。

## 验证情况

见 [docs/VERIFICATION.md](docs/VERIFICATION.md)：记录了本机实测过什么、哪些还没验。

简要：质量闸门用故意写错的代码测出 `fail` + blocker，用正确代码测出 `pass`；收尾拦截在「改过东西」时触发一次、同回合不重复、审核后不再触发、失败的工具调用不会误触发；五个工具与子任务预算的四种判定路径全部通过。0.4.5 起 `npm test` 共 29 项，覆盖 shell 指纹、审核期间并发改动、`cwd` 白名单、超大中文 diff 的字节截断、编辑器目录过滤、未跟踪符号链接的跳过，以及配置行的服务注册（`provide` 契约）、模型目录读取与卸载清理。

## 许可证

MIT，见 [LICENSE](LICENSE)。

## 贡献

提交注释与发布注释一律**中英双语**，规则见 [CONTRIBUTING.md](CONTRIBUTING.md)；`git config commit.template .gitmessage` 可启用模板。

Commit messages and release notes are **bilingual** (Chinese and English); see
[CONTRIBUTING.md](CONTRIBUTING.md), and `git config commit.template .gitmessage`
to enable the template.

发布一律走脚本，它把「推送 → 打 tag → 建 Release → 发布 npm → 校验四处同一提交」固定成一个事务：
Releases go through one script that fixes push, tag, Release, npm and the
same-commit check into a single transaction:

```bash
npm run release:check -- --notes notes.md   # 只检查，不发布
npm run release       -- --notes notes.md   # 发布
```
