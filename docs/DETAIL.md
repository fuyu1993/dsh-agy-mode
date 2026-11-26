# Antigravity planner mode

An agent mode for DeepSeek Harness that inherits Standard mode and splits the
work: the local Antigravity CLI (`agy`) owns judgement, DSH owns execution.
Quality sign-off is agy's, enforced by the mode rather than left to DSH's own
opinion of its work.

## What is different from Standard

| | Standard | This mode |
|---|---|---|
| Technical judgement | DSH | `agy` |
| Edits, commands, tests, commits | DSH | DSH |
| Quality sign-off | DSH | `agy_review` structured verdict |
| Closing a turn without review | allowed | steered back to review |
| Model and effort chosen up front | no | yes, both sides |
| Delegation budget | Host settings | per task, enforced |

The mode declares the same 23 plugin rows as Standard and adds one row of its
own, `agy-planner`, which registers all five tools inside the preset. Nothing is
mounted at Host level, so no other mode gains them.

## Mode name and language

The preset's `name` and `description` are `!!js` expressions that read the
interface language at load time and return the Chinese or English text:

```yaml
name: !!js "(() => { ... return lang.startsWith('en') ? \"Antigravity planner\" : \"Antigravity 规划模式\" })()"
```

Language resolution order:

1. `DSH_AGY_MODE_LANG` (`en` → English, anything else → Chinese),
2. `$DSH_HOME/locale.json` → `language`,
3. `$DSH_HOME/desktop-locale.json` → `desktop` (this profile writes `zh`),
4. fallback: Chinese.

The expressions use only `process` globals, so they evaluate in the loader's
empty scope and never depend on a service being available yet. `locale/zh.json`
and `locale/en.json` carry the plugin-page title and description, which follow
DSH's own locale mechanism.

## The start-of-task conversation

Before the first real work of a session, the mode asks four things with
`ask_user_question`:

1. the agy model and reasoning effort (`agy_models` supplies the ids),
2. DSH's own model and reasoning effort,
3. whether subagents are allowed, how many at once, how deep they may recurse,
4. whatever the plan needs that DSH cannot discover itself.

Question 3 is then recorded through `agy_delegation_budget`, which installs a
guard on `subagent`, `subagent_fork` and `workflow`.

## Workflow

1. DSH inspects the repository to build a self-contained brief.
2. `agy_consult` in plan mode returns the implementation plan. agy sees the
   repository, never this conversation.
3. DSH implements with its own tools and verifies the way the project expects.
4. `agy_review` returns a structured verdict on the changes.
5. Blockers and majors are fixed and re-reviewed; minors are reported.

The mode enforces step 4: a turn that mutated the workspace cannot close until
`agy_review` has run on those changes. The enforcement is a steering
instruction, not a hard stop, so a user who declines the review can end the
task by saying so.

## The review contract

`agy_review` sends a JSON Schema to agy's `--json-schema` flag and reads
`structured_output` back:

```json
{
  "verdict": "pass" | "fail",
  "summary": "...",
  "findings": [{ "severity": "blocker|major|minor|nit", "file": "...", "line": 1, "problem": "...", "fix": "..." }]
}
```

The plugin, not the model, decides the gate: any blocker or major forces
`fail`. A verdict of `pass` with only minor findings renders as
`PASS with notes`. If agy returns no structured output, the tool throws rather
than inventing a verdict.

The prompt scopes agy to the requirement as stated, so a limitation the
requirement never covered is a minor note rather than a blocker. Measured
effect: the same piece of deliberately loose code went from `fail` (major) to
`pass` (minor) after this constraint was added.

### The gate stays shut on a failure

A review that fails is unfinished work, not a cleared gate. The gate opens only
on a `pass`; until then a closing turn is steered back with the outstanding
findings named. A `fail` with no findings locks it too, treated as one major.

After `maxReviewRounds` consecutive failures the mode stops steering and asks
for the disagreement to be reported to the user, so a stuck loop costs three
calls rather than unbounded ones.

### Diff first

By default the plugin collects the change itself — `git diff HEAD` plus the
porcelain file list — and puts it in the prompt. The author's description is
included when given, but it is not the subject of review: the diff is.

The measurement behind this: the same change reviewed with the diff in the
prompt cost 10913 tokens; letting agy rediscover it cost 10807 tokens and
finished in one turn without reading a file. Equal cost, unverifiable answer.
`scope: "repo"` opts back into exploration for changes that need cross-file
tracking.

## Cost

Three tiers, because one effort for every call is either wasteful or shallow:

| Tier | Used by | Default |
|---|---|---|
| `plan` | `agy_consult` (default mode) | `gemini-4-hydrogen` / `high` |
| `consult` | `agy_consult` with `mode: quick` | `gemini-3.8-flash` / `low` |
| `review` | `agy_review` | `gemini-4-hydrogen` / `high` |

Two facts drive the design. An `agy` call has a fixed cost of about 10.8k input
tokens whatever it is asked, so the lever is *how many calls* and *what tier*,
not prompt wording. And `agy` can resume a conversation (`--conversation`), so
a follow-up need not re-explore the repository.

Conversations are keyed by the task root and shared across tiers: a plan, a
lookup and a review all concern the same checkout, and splitting them would
make agy re-read what it already read. A conversation is dropped when the
directory changes, when it exceeds `maxConversationTurns`, or when the CLI
cannot resume it (in which case the call is retried cold rather than failing).

Spend is accumulated per task and reported as
`agy so far: N call(s), X in (Y% cached), Z out`. `cache_read_tokens` is a
subset of `input_tokens` in agy's accounting (`total = input + output`), so the
two are never added.

### Model ids carry their own effort

`agy` model ids end in their effort (`gemini-4-hydrogen-high`), and passing
`--effort` alongside one is rejected as a conflict. So a suffixed id wins and
the effort argument is dropped; an unsuffixed id (a family name, an
orchestrator) takes the effort. A tier that must vary its effort therefore has
to use an unsuffixed id.

## Requirements and limits

- `agy` must be installed and signed in; a signed-out CLI reports only on
  stderr and is translated into a sign-in hint.
- `agy` always runs with `--mode plan`, so it cannot modify the repository even
  with `--dangerously-skip-permissions` (verified empirically).
- agy does not share the conversation; prompts must be self-contained.
- Delegation budgets live in memory per task root and are not durable, so a
  new task asks again. That is intentional.
- Each consultation costs time and quota; review large changes in batches.

## Verification

See [VERIFICATION.md](VERIFICATION.md).

## Default route

`gemini-4-hydrogen-high` at `high` effort, stored as `defaultModel` and
`defaultEffort` on the `agy-planner` row. It applies only when a call omits the
model or effort, and is offered as the recommendation during question 1.
