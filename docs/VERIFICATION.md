# Verification

What was actually run against the `agy` on this machine (`agy` 1.5.17,
`~/.local/antigravity/bin/agy`), and what remains unverified.

## Verified

### Composition

- `dsh --profile <copy of desktop> --dump-config` composes `preset-agy` with 24
  child rows: the 23 Standard rows plus `agy-planner`.
- The mode name resolves both ways with the loader's own evaluation
  (`with (ctx) eval(expr)` against an empty scope): `Antigravity 规划模式` in
  Chinese, `Antigravity planner` in English. `DSH_AGY_MODE_LANG=en` overrides,
  and a missing locale file falls back to Chinese.
- The bundle parses as YAML with the loader's `!!js` tag, and the profile's own
  patch still parses.

### Tools

- `agy_models` returns 27 model ids and the five effort levels.
- `agy_consult` returns the CLI's answer and echoes the model and effort used;
  the configured default route (`gemini-4-hydrogen-high` / `high`) works when
  the call omits both.
- `agy_delegation_budget` records a budget and the guard then behaves on all
  four paths: no budget → denied, allowed → passed, depth 1 with `maxDepth` 1 →
  denied, `allow: false` → denied.
- `agy_review` returns structured output driven by agy's `--json-schema`.

### The quality gate

Measured with a deliberately wrong implementation
(`total = (a, b) => a - b`, requirement "total must be the sum of a and b"):

- verdict `fail`, 2 findings, severities `blocker` and `major`, with
  `app.js:1` and a concrete fix. The blocking finding was not generic: agy
  named the wrong operator.

Measured with the corrected implementation (`a + b`) plus its verification
output:

- verdict `pass` with minor notes only (no test suite; the requirement says
  nothing about non-number inputs).
- Before the prompt was scoped to the stated requirement, the same code was a
  `fail` with a major finding about string concatenation. The scoping changed
  the outcome, which is why it is in the prompt.

A `fail` carrying nothing above minor severity now renders as
`PASS with notes`, and the gate keys on severity rather than on the model's
verdict string alone.

### The closing-turn enforcement

- A clean session closes with no steering.
- After a successful mutating call, the close is steered exactly once, and the
  injected instruction names `agy_review`.
- Closing the same turn twice does not steer twice.
- After a successful `agy_review`, the session closes without steering.
- A **failed** mutating call does not mark the session dirty, so an error does
  not demand a review.

### CLI behaviour relied on

- `agy` in `--mode plan` cannot create files even with
  `--dangerously-skip-permissions`: a run that wrote files outside plan mode
  wrote none inside it.
- A signed-out CLI prints `not logged into Antigravity` on stderr, which the
  plugin maps to a sign-in hint instead of returning the empty answer the CLI
  produces.
- `--json-schema` yields `structured_output` alongside `response`.

## Not verified

- The rendered mode picker: the name, description and icon as drawn in the Web
  and desktop UI. The declaration and its language resolution are verified; the
  pixels are not.
- A complete real conversation: user answers → `agy_consult` plan → DSH
  implements → `agy_review` → fix → report, driven by a live model rather than
  a test harness.
- The review gate under a Host where `agents.list()` is unavailable: the
  descendant count then reports 0, so `maxChildren` cannot be exceeded by that
  path. The depth limit and the `allow` flag still apply.
- Behaviour against `agy` versions other than 1.5.17.

## After publishing

The package was renamed from `@local/dsh-agy-mode` to `dsh-agy-mode` before the
first push, so the install line in the README (`github:fuyu1993/dsh-agy-mode`)
matches the row name the plugin manager creates. A second commit added
`./package.json` to `exports`, because tooling that reads the manifest by
subpath otherwise fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`.
