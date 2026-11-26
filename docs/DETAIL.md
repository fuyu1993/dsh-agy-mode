# Antigravity planner mode

A DSH agent mode (preset) in which the **local Antigravity CLI (`agy`)** does the thinking — it inspects the repository, writes the plan, decides between approaches, and reviews the finished work — while **DSH does the work**: every edit, command, test run and commit.

It is Standard mode plus three tools and a delegation guard, so it keeps Standard's shell, file, search, job, skill, plan, goal, compaction, subagent, workflow, web, office and plugin tools.

## What is different from Standard

| Tool | Purpose |
|---|---|
| `agy_consult` | One read-only `agy` turn. `mode: plan` asks for an implementation plan, `mode: review` asks for a critique. Optional `model`, `effort` and `cwd`; returns agy's answer as text. |
| `agy_models` | The model ids this `agy` accepts, plus the reasoning efforts `low` … `max`. |
| `agy_delegation_budget` | Records the user's answer about delegated work: allowed or not, how many subagents may run at once, how many levels deep. |

`agy` always runs in its own read-only plan mode with approvals skipped, so it can read the checkout but cannot change it. Files, edits and commands stay DSH's job.

## The start-of-task conversation

Before the first real piece of work, the agent asks the user four things with `ask_user_question`:

1. the **agy** model and reasoning effort,
2. **DSH's** own model and reasoning effort — the model control beside the composer also switches this at any time,
3. whether subagents are allowed, how many at once, and how deep,
4. whatever the plan needs that inspection cannot answer.

The answer to (3) is recorded with `agy_delegation_budget`. Until it is recorded, every `subagent`, `subagent_fork` and `workflow` call is refused, so the mode cannot quietly fan out work the user never approved. After it is recorded, each delegated call is checked against the live subagent count and the caller's depth before it starts.

## Workflow

1. Inspect the repository with DSH's read-only tools to gather facts.
2. Send `agy_consult` a self-contained brief — goal, paths, constraints, success criteria — and take the returned plan as the basis.
3. Implement with DSH's own tools, verifying the way the project expects.
4. Before reporting completion, send the diff and verification result back through `agy_consult` in review mode; fix or explain each objection.
5. Report the outcome, including anything agy raised that was not addressed.

Plan mode (`/plan`) is unchanged in shape, but the plan itself comes from `agy_consult` until the user approves it.

## Requirements and limits

- `agy` must be on `PATH` and signed in once. A signed-out CLI is reported as such rather than as an empty answer.
- One consultation is bounded by `timeoutSeconds` (default 900) and by a one-hour tool timeout.
- `agy` does not see the conversation, so a vague prompt produces a vague plan. The preset instructs the agent to include the facts it gathered.
- The delegation budget is held in memory per task and is not durable: a new task asks again, which is the intent.
- The mode does not change the profile's permission policy; sandbox and approval settings still decide what DSH itself may do.

## Verification

See [VERIFICATION.md](VERIFICATION.md) for what was checked on this machine and
what remains unverified.

## Default route

The bundle sets `defaultModel: gemini-4-hydrogen-high` and `defaultEffort: high`
for `agy_consult`, matching the model this machine's `agy` is configured with.
The mode still asks before work starts; the defaults only pre-fill the
recommendation and cover a call that names no route. Change them in
`cordis.patch.yml` under the `agy-planner` child row.
