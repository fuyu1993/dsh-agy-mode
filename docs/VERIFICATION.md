# Verification

What was actually run against the `agy` on this machine (`agy` 1.5.18,
`~/.local/antigravity/bin/agy`), and what remains unverified.

## Automated tests

Run `npm test` (or `node --test`) to execute `test/index.test.js`, which verifies:

- Pure helpers: `reconcileEffort`, `resolveVerdict` (including empty `fail` locking the gate), `parsePorcelainStatus`, `prioritizeAndClipDiff` (source files prioritized ahead of lockfiles), `renderReview`, `authHint`, `transientHint`, `summarise`, `boundedSet`, `promptUnits`, `clipToUnits` (byte budget without splitting a character), and `isUntrackedNoise`.
- Delegation guard across all budget branches and `agy_routes` inheritance across child sessions and tiers.
- Review gate across root and subagent edits, empty-`fail` locking, `stalled` re-arming on new edits, and shell-only fingerprint verification against real temporary git repositories.
- `collectDiff` inclusion of untracked text files, binary skipping, symlink skipping, and `baseHead..HEAD` mid-task commit diffs.
- `runAgy` per-root serialization, stale conversation recovery, transient retries, and `agy_models` auth hints.
- A read-only shell call during an in-flight review leaving the pass valid.

30 tests in total as of 0.4.6.

### 0.4.5

Two defects found by an audit, both reachable in ordinary use.

- **An untracked symlink leaked its target into the prompt.** `collectUntrackedDiffs`
  checked that `resolve(root, relPath)` stayed under the repository, then called
  `stat` and `readFile` — both of which follow links. An untracked
  `leak -> ~/.npmrc` passed the path check and had the target's bytes quoted
  into the diff sent to agy. It now `lstat`s first and skips a symlink, and
  re-checks with `realpath` after reading in case the link was swapped in
  between. The skip is reported as `<path> (symlink)`, like every other omission.
- **A read-only command during a review invalidated the pass.** The gate samples
  a repository fingerprint only while the task is clean. The code still computed
  one after a shell call on an already-dirty task, discarded the answer, and fell
  through to `markDirty`, which bumps the epoch — so a `git status` arriving
  while `agy_review` was in flight made its verdict look stale and the task was
  steered back to re-review approved work. It also paid three git invocations
  plus up to 200 `stat`s for an answer it threw away.
  The first attempt at this fixed the symptom and broke the invariant: skipping
  `markDirty` for every shell call on a dirty directory also skipped a mutating
  `bash` that landed mid-review, so its edit was credited to a pass that never
  saw it. The gate now carries an in-flight review counter (`gate.reviews`), and
  a shell call is fingerprinted whenever the task is clean *or* a review is
  running; only an unchanged fingerprint short-circuits. No dirtiness shortcut
  remains.

Three tests guard this, and each was confirmed red against the behaviour it is
meant to reject rather than merely green against the new code:
`not ok 28` when the symlink guards are removed, `not ok 29` when a shell call on
a dirty task is not fingerprinted (the 0.4.4 behaviour), and `not ok 30` when a
dirty directory short-circuits `markDirty` (the rejected first attempt).

### 0.4.1

- **The configuration row could not be mounted at all.** 0.4.0 published its
  reader with `ctx.set('agyModeDefaults', …)`, which Cordis rejects with
  `cannot set property "agyModeDefaults" without provide` — a fiber may only
  assign a name it has declared. Every plugin page failed to load the row.
  Fixed by using `ctx.provide`, which declares the service and registers its
  own disposer.
- The mount code moved to `config-runtime.js` so `npm test` can reach it: it
  lived in `config.js`, which imports `@deepseek-ai/schemastery` and therefore
  cannot be loaded from this checkout. That is why 0.4.0 shipped the bug with a
  green suite.
- Four tests now cover it. Their stub enforces the real contract — `set` throws
  unless the name was provided — and reverting the fix to `ctx.set` reproduces
  the exact production error in four tests, so the rule cannot silently regress.

### 0.4.2

- `mountConfig` registered `options.reader` unconditionally, so a caller that
  passed none got a `undefined` service and the preset row would call
  `undefined(tier)` on every agy tool. It now falls back to `createReader(config)`,
  and a test mounts without a reader and reads a tier back.
- The unload test asserted the service existed but never that unloading removed
  it: the stub's `provide` returned a disposer without registering it, so the
  cleanup loop could not delete anything. The stub now registers the provider's
  disposer the way Cordis does, and the test asserts the service is gone
  afterwards.
- 27 tests. Reverting the `provide` call still turns five of them red.

### 0.4.0

- **Read-only shell no longer demands a review.** A task whose only shell call was `git status` closes with no steering; the same test then writes `app.js` through `bash` and gets steered, so the check distinguishes the two rather than skipping both. Measured against real temporary git repositories.
- **A read-only shell does not re-arm a stalled loop.** After `maxReviewRounds` is hit, `git status` leaves `stalled` and `rounds` alone.
- **A change during an in-flight review keeps the gate shut.** A subagent `write` lands while `agy_review` is running; the review returns `pass`, and the following close still steers with "changed while the review was running" instead of accepting the verdict.
- **`cwd` containment.** An outside directory is refused with a message naming the workspace and the two config keys; the session's own directory, a configured `allowedRoots` entry, and `allowExternalCwd: true` each pass.
- **Prompt budget.** With a CJK change of twice the prompt limit, the sent argv stays within `PROMPT_LIMIT_BYTES` and still carries `Must satisfy:`, `How they verified it:` and the pass/fail rubric — the tail that the old tail-truncation dropped first. The diff itself is clipped and says so.
- **Editor state stays out.** `.idea/workspace.xml` appears neither in the diff, the touched-file list, nor the omitted list; the untracked source file next to it does, and the prompt reports only a count of skipped paths.
- **Patch shape.** `cordis.patch.yml` parses with the loader's `js` tag: two insert rows (`agy-planner-config`, `preset-agy`), 24 child rows, `name` still a literal string, and 4 child `!!js` expressions preserved.

## Verified

### Composition

- `dsh --profile <copy of desktop> --dump-config` composes `preset-agy` with 24
  child rows: the 23 Standard rows plus `agy-planner`.
- The mode name is a literal string. An earlier revision resolved it from the
  interface language with a `!!js` expression; that fails on 0.2.2-rc.5 with
  `$.name expected string but got [object Object]`, because a preset row
  declares `EntryGroup` and the loader skips `interpolate` for its config while
  the plugin's own schema still requires a string. Verified fixed by parsing
  `cordis.patch.yml` with the loader's `!!js` tag and validating the row
  against the real `Config`: `name`/`description` are strings, `plugins` keeps
  its 4 child `!!js` expressions, and the row validates with 24 child rows.
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

### A failing review keeps the gate shut (0.3.0)

- `agy_review` returning `fail` leaves the gate closed: the next close steers
  with "agy still rejects this work" and names the outstanding findings.
- A `fail` carrying **no** findings also locks the gate, treated as one major.
- After `maxReviewRounds` consecutive failures the steering text changes to
  "stop looping, report the disagreement", and the following close is silent —
  the loop stops instead of burning calls.
- A later `pass` (even with minor notes) clears everything: no steering.

### Cost work (0.3.0)

Measured on this machine with `agy` 1.5.17:

- **Conversation reuse works.** Seeding a fact in one call and asking for it in
  the next, the second call carried `--conversation <id>` and answered the fact
  back correctly. Without reuse the same follow-up is a cold start.
- **One conversation per task.** A `plan` call followed by a `quick` call now
  resumes the same conversation; earlier they were keyed separately and both
  cold-started.
- **Tiers route independently.** With `planModel: gemini-4-hydrogen` /
  `planEffort: high` and `consultModel: gemini-3.8-flash` / `consultEffort:
  low`, the two calls spawned with exactly those argv pairs.
- **Diff scope.** With a real working-tree change, `agy_review` reported
  `scope: diff`, judged the actual diff, and passed with no `work` argument
  given. Against a directory that is not a git repo it falls back to `repo` and
  demands a description instead of reviewing nothing.
- **Cost accounting.** `agy`'s usage has `total = input + output`, so
  `cache_read_tokens` is a **subset** of `input_tokens` and the two must not be
  added. The first version did add them and printed `161% cached`; the ratio is
  now capped at 100 and the totals are correct (verified: 24.7k in / 36% cached
  over two calls).

### Model ids carry their own effort

`agy` rejects `--model gemini-3.8-flash-low --effort high` as a conflict:

```
error: invalid model selection (--model "gemini-3.8-flash-low" --effort "high")
```

The plugin now reconciles the two: a model id ending in an effort suffix wins
and `--effort` is omitted; an unsuffixed id takes the effort. Both paths were
verified by inspecting the spawned argv.

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
- Trimming `agy`'s own tool set. It ships 60 tools per call (16 of them
  browser automation) that a coding task never uses. `--settings` exists but
  rejects `agents`, `tools` and unknown keys alike, so the accepted key names
  are still unknown.
- Whether concurrent `agy` calls share the prompt cache. Three parallel calls
  did each report ~8.7k cached tokens, but that is one observation, not a rule.

## After publishing

The package was renamed from `@local/dsh-agy-mode` to `dsh-agy-mode` before the
first push, so the install line in the README (`github:fuyu1993/dsh-agy-mode`)
matches the row name the plugin manager creates. A second commit added
`./package.json` to `exports`, because tooling that reads the manifest by
subpath otherwise fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`.
