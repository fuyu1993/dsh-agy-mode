/*
 * Antigravity planner mode — host half.
 *
 * Judgement belongs to the local Antigravity CLI (`agy`); execution belongs to
 * DSH. This plugin owns the transport, the review gate, the route overrides,
 * and the delegation budget:
 *
 *   agy_consult            one read-only planning or review turn, answer returned
 *   agy_review             structured quality verdict on finished work
 *   agy_models             the model ids and reasoning efforts this `agy` accepts
 *   agy_routes             the user's per-task agy model and effort overrides
 *   agy_delegation_budget  the user's answer on subagents, concurrency and depth
 *
 * Cost matters as much as quality here, so three things are deliberate:
 *
 *   - Three effort tiers. Planning is one expensive shot; a mid-task question
 *     is not. A small question runs on a cheap model at low effort.
 *   - Conversation reuse. agy can resume a conversation (`--conversation`), so
 *     a follow-up does not re-explore the repository from cold.
 *   - Diff first. Sending the working-tree diff costs about the same as letting
 *     agy rediscover it, but the diff is ground truth instead of a guess.
 *
 * Tools are registered as plain definitions with raw JSON Schemas, so this
 * module imports nothing from DSH packages and needs no dependency of its own.
 * The one DSH package this bundle touches is `@deepseek-ai/schemastery`, and
 * only from `config.js` (the Host-level settings row), never from here.
 *
 * @module dsh-agy-mode/planner
 */

import { homedir, tmpdir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, readFile, realpath, stat, unlink } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

export const name = 'agy-planner'
// Required services only; everything else is read through ctx.get() so the
// plugin still loads on a Host that lacks the optional ones.
export const inject = ['tools', 'subprocess']

/** Reasoning efforts the CLI accepts, in ascending order. */
export const AGY_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

/** Tool names that start delegated work, and so consume the budget. */
const DELEGATION_TOOLS = new Set(['subagent', 'subagent_fork', 'workflow'])

/** Direct file-editing tools whose success always marks the task dirty. */
const FILE_MUTATING_TOOLS = new Set(['write', 'edit', 'apply_patch', 'str_replace_editor'])

/** Shell/terminal tools that may mutate files (checked via repo fingerprint). */
const SHELL_TOOLS = new Set(['bash', 'pwsh', 'terminal_send'])

/** Tools whose call means the agent may have changed something worth reviewing. */
const MUTATING_TOOLS = new Set([...FILE_MUTATING_TOOLS, ...SHELL_TOOLS])

/** Findings at these severities hold a task back; the rest are notes. */
const BLOCKING = new Set(['blocker', 'major'])

/** Files deprioritized when a large diff must be clipped to fit budget. */
const LOW_PRIORITY_DIFF_RE = /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|Gemfile\.lock|composer\.lock|go\.sum)$|\.(?:min\.js|min\.css|map|snap)$/i

/** Maximum tracked task roots per in-memory map to bound long-running processes. */
const MAX_TRACKED_ROOTS = 200

/**
 * Untracked paths never worth spending review budget on. These are editor and
 * tool state directories, not deliverables: agy reading them costs tokens and
 * tells it nothing about the change under review.
 */
const UNTRACKED_NOISE_RE = /(?:^|\/)(?:\.idea|\.vscode|\.openidea|\.fleet|\.DS_Store|node_modules|coverage|\.nyc_output|dist|build|out|target|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.turbo|\.parcel-cache|\.next|\.nuxt)(?:\/|$)/i

/**
 * Byte ceiling for one argv string, per platform.
 *
 * Linux caps a single argument at MAX_ARG_STRLEN (131072 bytes), Windows at
 * ~32k UTF-16 units for the whole command line, and macOS has no per-string
 * limit at all (measured: 1,000,000 bytes passes, 1,200,000 fails with E2BIG).
 * Truncation is measured in characters today, so a CJK diff can occupy three
 * bytes per character and overflow a limit its character count says it fits.
 */
export const PROMPT_LIMIT_BYTES = process.platform === 'linux'
  ? 120_000
  : process.platform === 'win32'
    ? 26_000
    : 500_000

/** Schema agy fills for one review, so the verdict is machine-readable. */
const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: {
      type: 'string',
      enum: ['pass', 'fail'],
      description: 'pass when the work is acceptable as delivered; fail when it must be corrected first.',
    },
    summary: { type: 'string', description: 'One or two sentences on the overall quality.' },
    findings: {
      type: 'array',
      description: 'Concrete defects, risks or missing checks. Empty when the work passes.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'nit'] },
          file: { type: 'string', description: 'Repository-relative path, when the finding is about a file.' },
          line: { type: 'integer' },
          problem: { type: 'string', description: 'What is wrong.' },
          fix: { type: 'string', description: 'What to change.' },
        },
        required: ['severity', 'problem'],
      },
    },
  },
  required: ['verdict', 'summary', 'findings'],
}

/** Set an entry in a bounded Map, refreshing insertion order as a lightweight LRU. */
export function boundedSet(map, key, value, maxEntries = MAX_TRACKED_ROOTS) {
  if (map.has(key)) map.delete(key)
  map.set(key, value)
  while (map.size > maxEntries) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
}

/**
 * Reconcile a model id with a reasoning effort.
 *
 * agy's model ids carry the effort as a suffix (`gemini-4-hydrogen-high`), and
 * passing `--effort` alongside a suffixed id is rejected as a conflict. So a
 * suffixed id wins: the effort argument is dropped rather than fighting the id.
 * An unsuffixed id (an orchestrator, a raw family name) takes the effort.
 */
export function reconcileEffort(model, effort) {
  if (model === undefined) return { model, effort }
  const suffix = AGY_EFFORTS.find(candidate => model.endsWith(`-${candidate}`))
  if (suffix === undefined) return { model, effort }
  return { model, effort: undefined, implied: suffix }
}

/**
 * Decide the gate verdict from agy's structured review output.
 *
 * A `fail` carrying only minor/nit notes passes with notes; a `fail` with zero
 * findings still locks the gate so an unexplained failure cannot slip through.
 */
export function resolveVerdict(structured) {
  const findings = Array.isArray(structured?.findings) ? structured.findings : []
  const blocking = findings.some((finding) => BLOCKING.has(finding?.severity))
  const emptyFail = structured?.verdict === 'fail' && findings.length === 0
  return blocking || emptyFail ? 'fail' : 'pass'
}

/** Bound one CLI answer so a runaway plan cannot flood the conversation. */
export function summarise(text, limit = 24000) {
  const value = text.trim()
  return value.length > limit ? `${value.slice(0, limit)}\n…[truncated ${value.length - limit} chars]` : value
}

/**
 * How many units one string occupies against a platform prompt budget.
 *
 * win32 counts UTF-16 code units (`CreateProcess` limit) while POSIX counts
 * UTF-8 bytes. Mixing them up is what lets a CJK prompt pass a character check
 * and then fail the spawn.
 */
export function promptUnits(text) {
  return process.platform === 'win32' ? text.length : Buffer.byteLength(text, 'utf8')
}

/**
 * Clip text to a budget measured in `promptUnits`, without splitting a
 * surrogate pair or a multi-byte character in half.
 * @param text - the text to clip.
 * @param limit - maximum units to keep.
 * @param note - appended when clipping happened; `{n}` receives the dropped count.
 */
export function clipToUnits(text, limit, note = '…[truncated {n}]') {
  if (limit <= 0) return ''
  if (promptUnits(text) <= limit) return text
  const suffix = note.replace('{n}', String(promptUnits(text) - limit))
  const budget = Math.max(0, limit - promptUnits(suffix))

  if (process.platform === 'win32') {
    let cut = Math.min(budget, text.length)
    // Never leave a lone high surrogate at the boundary.
    const code = text.charCodeAt(cut - 1)
    if (cut > 0 && code >= 0xd800 && code <= 0xdbff) cut -= 1
    return `${text.slice(0, cut)}${suffix}`
  }

  // Walk whole code points so the cut lands on a UTF-8 boundary.
  let used = 0
  let cut = 0
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8')
    if (used + size > budget) break
    used += size
    cut += char.length
  }
  return `${text.slice(0, cut)}${suffix}`
}

/** The launcher reports a signed-out CLI only on stderr; surface it as advice. */
export function authHint(stderr) {
  return /not logged into Antigravity/i.test(stderr)
    ? 'Antigravity CLI is not signed in. Sign in once in a terminal (`agy`, then finish the Google sign-in), then retry.'
    : undefined
}

/**
 * Whether a failure looks transient: a gateway hiccup or a throttled account is
 * worth one more attempt, a bad model id is not.
 */
export function transientHint(output) {
  return /(?:\b50[234]\b|rate.?limit|overloaded|temporarily unavailable|entitlement|try again later)/i.test(output)
}

/** One collected subprocess stream as text, tolerating a truncated tail. */
const textOf = reader => reader?.readFrom(0).text ?? ''

const text = (value) => [{ type: 'text', text: value }]

/** A JSON-Schema object node with the given properties (all optional unless listed). */
const objectSchema = (properties, required = []) => ({
  type: 'object',
  additionalProperties: false,
  properties,
  ...required.length === 0 ? {} : { required },
})

/** Unquote a `git status --porcelain` path when git C-quotes special characters. */
function unquoteGitPath(raw) {
  const trimmed = raw.trim()
  if (!(trimmed.startsWith('"') && trimmed.endsWith('"'))) return trimmed
  return trimmed
    .slice(1, -1)
    .replace(/\\([\\"tnr])/g, (_m, ch) => ({ '\\': '\\', '"': '"', t: '\t', n: '\n', r: '\r' }[ch] ?? ch))
}

/** Parse `git status --porcelain -uall` output into display lines and untracked paths. */
export function parsePorcelainStatus(stdout) {
  const lines = stdout.split(/\r?\n/).filter(line => line.length >= 4)
  const files = lines.map(line => line.trim())
  const untracked = []
  for (const line of lines) {
    if (!line.startsWith('?? ')) continue
    const path = unquoteGitPath(line.slice(3))
    if (path.length > 0 && !path.endsWith('/')) untracked.push(path)
  }
  return { files, untracked }
}

/**
 * The path out of one trimmed porcelain display line.
 *
 * `parsePorcelainStatus` trims each line (`M  src/a.js` → `M src/a.js`), so the
 * status columns are no longer fixed-width. The path starts after the last
 * whitespace in the leading status run, which is either one or two characters.
 * @param line - one trimmed porcelain line.
 */
function porcelainPath(line) {
  return unquoteGitPath(line.replace(/^[ MADRCU?!]{1,2}\s+/, ''))
}

/** Extract the `b/...` path from a `diff --git` chunk header. */
function diffChunkPath(chunk) {
  const firstLine = chunk.split(/\r?\n/, 1)[0] ?? ''
  const match = firstLine.match(/^diff --git a\/.+ b\/(.+)$/)
  return match === null ? undefined : unquoteGitPath(match[1])
}

/**
 * Clip a unified diff to a budget, keeping source files ahead of lockfiles
 * and generated bundles so noise does not crowd out real code changes.
 * @param diffText - the unified diff.
 * @param maxUnits - budget in `measure` units.
 * @param measure - unit counter; defaults to `promptUnits`.
 */
export function prioritizeAndClipDiff(diffText, maxUnits, measure = promptUnits) {
  if (measure(diffText) <= maxUnits) return { diff: diffText, omittedFiles: [] }

  const chunks = diffText.split(/^(?=diff --git )/m).filter(chunk => chunk.length > 0)
  if (chunks.length <= 1) {
    const omitted = chunks.length === 1 ? [diffChunkPath(chunks[0])].filter(Boolean) : []
    return {
      diff: clipToUnits(diffText, maxUnits, `\n…[diff truncated at ${maxUnits} units; {n} omitted]`),
      omittedFiles: omitted,
    }
  }

  const primary = []
  const secondary = []
  for (const chunk of chunks) {
    const file = diffChunkPath(chunk)
    if (file !== undefined && LOW_PRIORITY_DIFF_RE.test(file)) secondary.push({ file, chunk })
    else primary.push({ file, chunk })
  }

  const kept = []
  const omittedFiles = []
  let used = 0
  const reserve = 256
  const limit = Math.max(0, maxUnits - reserve)

  for (const item of [...primary, ...secondary]) {
    const size = measure(item.chunk)
    if (used + size <= limit) {
      kept.push(item.chunk)
      used += size
      continue
    }
    if (kept.length === 0 && limit > 0) {
      kept.push(clipToUnits(item.chunk, limit, '\n…[file diff truncated]'))
      used = limit
    }
    if (item.file !== undefined) omittedFiles.push(item.file)
  }

  const suffix = omittedFiles.length === 0
    ? ''
    : `\n…[diff truncated at ${maxUnits} units; omitted/clipped files: ${omittedFiles.join(', ')}]`
  return { diff: `${kept.join('')}${suffix}`, omittedFiles }
}

/**
 * Whether an untracked path is editor/tool state rather than a deliverable.
 * @param relPath - repository-relative path.
 */
export function isUntrackedNoise(relPath) {
  return UNTRACKED_NOISE_RE.test(relPath)
}

/**
 * Format untracked non-binary text files into synthetic diff blocks within a
 * unit budget. Editor state directories are skipped before they consume any.
 * @param cwd - repository root.
 * @param untracked - repository-relative untracked paths.
 * @param budgetUnits - budget in `promptUnits`.
 * @param measure - unit counter; defaults to `promptUnits`.
 */
async function collectUntrackedDiffs(cwd, untracked, budgetUnits, measure = promptUnits) {
  const wanted = untracked.filter(path => !isUntrackedNoise(path))
  const noisy = untracked.filter(path => isUntrackedNoise(path))
  if (wanted.length === 0 || budgetUnits <= 256) {
    return { text: '', omitted: [...wanted], skippedNoise: noisy.length }
  }
  const root = resolve(cwd)
  const blocks = []
  const omitted = []
  let remaining = budgetUnits

  for (const relPath of wanted) {
    const absPath = resolve(root, relPath)
    if (absPath !== root && !absPath.startsWith(`${root}${sep}`)) {
      omitted.push(relPath)
      continue
    }
    // `resolve` alone does not settle containment: a symlink inside the
    // repository can point anywhere, and both `stat` and `readFile` follow it.
    // An untracked `leak -> ~/.npmrc` would otherwise pass the path check and
    // have its target's bytes quoted into the diff sent to agy. `lstat` sees the
    // link itself, so a symlink is skipped rather than resolved.
    try {
      const link = await lstat(absPath)
      if (link.isSymbolicLink()) {
        omitted.push(`${relPath} (symlink)`)
        continue
      }
    } catch {
      omitted.push(relPath)
      continue
    }
    if (remaining < 200) {
      omitted.push(relPath)
      continue
    }
    let buf
    try {
      const info = await stat(absPath)
      if (!info.isFile()) continue
      if (info.size > 256 * 1024) {
        omitted.push(`${relPath} (${info.size} bytes)`)
        continue
      }
      buf = await readFile(absPath)
      // The link could have been swapped in between the `lstat` and the read.
      // Cheap to re-check, and the failure it prevents is a secret in the prompt.
      const real = await realpath(absPath)
      if (real !== absPath) {
        omitted.push(`${relPath} (symlink)`)
        continue
      }
    } catch {
      omitted.push(relPath)
      continue
    }

    // Skip binary files containing NUL bytes in the leading sample.
    const sampleLen = Math.min(buf.length, 4096)
    let isBinary = false
    for (let i = 0; i < sampleLen; i++) {
      if (buf[i] === 0) {
        isBinary = true
        break
      }
    }
    if (isBinary) {
      omitted.push(`${relPath} (binary)`)
      continue
    }

    const content = buf.toString('utf8')
    const lines = content.length === 0 ? [] : content.replace(/\r\n/g, '\n').split('\n')
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    const body = lines.map(line => `+${line}`).join('\n')
    const header = `diff --git a/${relPath} b/${relPath}\nnew file mode 100644\n--- /dev/null\n+++ b/${relPath}\n@@ -0,0 +1,${lines.length} @@\n`
    const fullBlock = `${header}${body}\n`
    if (measure(fullBlock) <= remaining) {
      blocks.push(fullBlock)
      remaining -= measure(fullBlock)
    } else if (blocks.length === 0 && remaining > measure(header) + 80) {
      const sliceLen = remaining - measure(header) - 64
      blocks.push(`${header}${clipToUnits(body, sliceLen, '\n…[new file truncated]')}\n`)
      remaining = 0
      omitted.push(`${relPath} (partial)`)
    } else {
      omitted.push(relPath)
    }
  }

  // Editor state is reported only as a count: naming those paths would put
  // them back in front of agy, which is what skipping them avoided.
  return { text: blocks.join(''), omitted, skippedNoise: noisy.length }
}

/** Render one review as model-facing text, strongest findings first. */
export function renderReview(review, { round, cost, scope }) {
  const order = { blocker: 0, major: 1, minor: 2, nit: 3 }
  const findings = [...review.findings].sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9))
  const blocking = findings.filter((finding) => BLOCKING.has(finding.severity))
  const notes = findings.length === 0
    ? 'agy review: PASS'
    : 'agy review: PASS with notes'
  const head = review.verdict === 'pass'
    ? notes
    : `agy review: FAIL — ${blocking.length} blocking finding(s) remain (round ${round})`
  const body = findings.map((finding) => {
    const where = finding.file === undefined
      ? ''
      : ` (${finding.file}${finding.line === undefined ? '' : `:${finding.line}`})`
    const fix = finding.fix === undefined ? '' : `\n   fix: ${finding.fix}`
    return `- [${finding.severity}] ${finding.problem}${where}${fix}`
  })
  const foot = [
    review.verdict === 'pass' ? undefined : 'Fix every blocker and major, then call agy_review again.',
    `scope: ${scope}${cost === undefined ? '' : ` · ${cost}`}`,
  ].filter(line => line !== undefined)
  return [head, review.summary, ...body, '', ...foot].join('\n')
}

export function apply(ctx, config = {}) {
  const command = config.command ?? 'agy'
  const timeoutSeconds = config.timeoutSeconds ?? 900
  const defaultModel = config.defaultModel
  const defaultEffort = config.defaultEffort
  const requireReview = config.requireReview ?? true
  const extraArgs = Array.isArray(config.extraArgs) ? config.extraArgs.map(String) : []

  /**
   * Three tiers, because one effort for everything is either too expensive or
   * too shallow. A plan is the one place a strong model pays for itself; a
   * mid-task lookup does not; the final review is worth the strong route again.
   */
  const tiers = {
    plan: {
      model: config.planModel ?? defaultModel,
      effort: config.planEffort ?? defaultEffort,
    },
    consult: {
      model: config.consultModel ?? defaultModel,
      effort: config.consultEffort ?? 'low',
    },
    review: {
      model: config.reviewModel ?? defaultModel,
      effort: config.reviewEffort ?? config.planEffort ?? defaultEffort,
    },
  }

  /** Whether a follow-up resumes the earlier agy conversation. */
  const reuseConversations = config.reuseConversations ?? true
  /** Turns one conversation may accumulate before a fresh one is started. */
  const maxConversationTurns = config.maxConversationTurns ?? 12
  /** Consecutive failing reviews before the mode stops looping. */
  const maxReviewRounds = config.maxReviewRounds ?? 3
  /**
   * Total prompt budget in `promptUnits` (bytes on POSIX, UTF-16 units on
   * win32). `maxPromptBytes` is the honest name; `maxPromptChars` is still read
   * so an existing row keeps its intent instead of reverting to the default.
   */
  const promptLimit = Math.min(
    config.maxPromptBytes ?? config.maxPromptChars ?? PROMPT_LIMIT_BYTES,
    PROMPT_LIMIT_BYTES,
  )
  /**
   * Ceiling for the diff on its own. The review prompt is budgeted from the
   * other end (see `agy_review`), so this only bounds `collectDiff` when it is
   * called without an explicit budget.
   */
  const diffBudgetUnits = Math.min(
    config.diffMaxBytes ?? config.diffMaxChars ?? 48_000,
    promptLimit,
  )
  /** Extra attempts for a transient gateway or throttle failure. */
  const retries = config.retries ?? 1

  /**
   * The user's delegation answer, keyed by the root Session it belongs to so
   * every descendant inherits one budget. Not durable by design: a new task
   * asks again.
   */
  const budgets = new Map()

  /**
   * Whether agy may be pointed outside the session workspace.
   *
   * agy runs with `--dangerously-skip-permissions` in read-only plan mode, so it
   * can read any file it is pointed at and that content then travels to the
   * model. The session's own filesystem policy does not travel with it, which
   * makes an unvalidated `cwd` a way around the sandbox the user chose.
   */
  const allowExternalCwd = config.allowExternalCwd ?? false
  /** Extra roots agy may be pointed at, besides the session workspace. */
  const allowedRoots = Array.isArray(config.allowedRoots) ? config.allowedRoots.map(String) : []

  /**
   * User-chosen model/effort overrides per task root (`plan`, `consult`, `review`),
   * recorded via `agy_routes` so subagents and compacted turns do not drift back
   * to static defaults.
   */
  const routes = new Map()

  /**
   * agy conversations, keyed by the task root, so a follow-up resumes instead of
   * restarting. One conversation per task on purpose: a plan, a lookup and a
   * review all concern the same checkout, and splitting them would make agy
   * re-explore a repository it has already read. A conversation is dropped when
   * its directory changes, when it grows past `maxConversationTurns`, or when the
   * CLI cannot resume it.
   */
  const conversations = new Map()

  /** Per-task-root mutex so parallel calls do not race on the same agy conversation. */
  const conversationLocks = new Map()

  /** Accumulated agy spend per task root, so the cost is visible, not guessed. */
  const spends = new Map()

  /** Base commit SHA captured before first mutation for `(rootId, cwd)`, so mid-task commits stay reviewable. */
  const baseHeads = new Map()

  /**
   * Per-task-root review gate state:
   *   dirtyCwds   Map<cwd, epoch> of directories holding unreviewed changes
   *   epoch       monotonically increasing counter, bumped by every real change
   *   unresolved  blocking findings the last review raised and nobody has cleared
   *   rounds      consecutive failing reviews, so a stuck loop stays bounded
   *   nudgedTurn  the turn already steered, so one turn is nudged once
   *   stalled     the round cap was hit; stop steering until new edits happen
   *   findings    findings from the last failing review for incremental re-check
   *
   * `dirtyCwds` replaced a single `dirty` flag because one gate serves a whole
   * task root, and a task whose subagents work in two checkouts was clearing
   * both at once when only one had been reviewed. The `epoch` is what makes a
   * review's "pass" honest: a change that lands while the review is in flight
   * bumps it, so the review's verdict no longer covers what is on disk.
   */
  const gates = new Map()

  const depthOf = agent => agent.session.header.delegationDepth ?? 0

  /**
   * Walk up `parentSession` links to the task root. The subagent service knows
   * the managed root, but a resumed or unmanaged child may not be registered
   * there, so the header chain keeps the budget shared when it is not.
   */
  function rootIdByHeaders(session) {
    let header = session.header
    const seen = new Set([header.id])
    while (header.parentSession !== undefined && !seen.has(header.parentSession)) {
      const parent = ctx.get('sessions')?.get(header.parentSession)
      if (parent === undefined) return header.parentSession
      seen.add(parent.header.id)
      header = parent.header
    }
    return header.id
  }

  /** Root Session id of the caller's task. */
  function rootIdOf(agent) {
    const subagents = ctx.get('subagents')
    if (subagents !== undefined) {
      try {
        return subagents.rootOf(agent).session.header.id
      } catch {
        // Fall through to the durable header chain.
      }
    }
    return rootIdByHeaders(agent.session)
  }

  const gateOf = (rootId) => {
    let gate = gates.get(rootId)
    if (gate === undefined) {
      gate = {
        dirtyCwds: new Map(),
        epoch: 0,
        unresolved: undefined,
        rounds: 0,
        nudgedTurn: undefined,
        stalled: false,
        findings: undefined,
        // Reviews currently in flight for this root. A shell call arriving
        // during one must be judged by its effect even on an already-dirty
        // directory: otherwise its edit is silently credited to that review.
        reviews: 0,
      }
      boundedSet(gates, rootId, gate)
    }
    return gate
  }

  /**
   * Record that `cwd` now holds an unreviewed change.
   *
   * Bumping the epoch unconditionally is deliberate: a shell call that was not
   * worth fingerprinting (because the gate already knew it was dirty) is still
   * a call that could have touched a file, and a review running concurrently
   * must not be credited with having seen it.
   */
  function markDirty(gate, cwd, reason) {
    gate.epoch += 1
    boundedSet(gate.dirtyCwds, cwd, { epoch: gate.epoch, reason })
    gate.nudgedTurn = undefined
  }

  /** Every live Session below `rootId`, counted through the durable headers. */
  function liveDescendants(rootId) {
    const agents = ctx.get('agents')
    if (agents === undefined) return 0
    const live = agents.list()
    const seen = new Set([rootId])
    for (let added = true; added;) {
      added = false
      for (const agent of live) {
        const { id, parentSession } = agent.session.header
        if (seen.has(id) || parentSession === undefined || !seen.has(parentSession)) continue
        seen.add(id)
        added = true
      }
    }
    return seen.size - 1
  }

  /** Add one call's token accounting to the task total. */
  function recordSpend(rootId, usage) {
    if (usage === undefined || usage === null) return
    const spend = spends.get(rootId) ?? { calls: 0, input: 0, output: 0, cached: 0, thinking: 0 }
    const number = value => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
    spend.calls += 1
    spend.input += number(usage.input_tokens)
    spend.output += number(usage.output_tokens)
    spend.cached += number(usage.cache_read_tokens)
    spend.thinking += number(usage.thinking_tokens)
    boundedSet(spends, rootId, spend)
  }

  /** One line of spend, compact enough to ride along with every answer. */
  function costLine(rootId) {
    const spend = spends.get(rootId)
    if (spend === undefined || spend.calls === 0) return undefined
    const scale = value => (value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value))
    const cached = spend.input > 0 ? ` (${Math.min(100, Math.round((spend.cached / spend.input) * 100))}% cached)` : ''
    const thinking = spend.thinking > 0 ? `, ${scale(spend.thinking)} thinking` : ''
    return `agy so far: ${spend.calls} call(s), ${scale(spend.input)} in${cached}, ${scale(spend.output)} out${thinking}`
  }

  /** Serialize async operations for the same task root to avoid conversation races. */
  async function withRootLock(key, fn) {
    if (key === undefined) return fn()
    const prev = conversationLocks.get(key) ?? Promise.resolve()
    let release
    const gate = new Promise(resolve => { release = resolve })
    const chain = prev.then(() => gate, () => gate)
    conversationLocks.set(key, chain)
    await prev.catch(() => {})
    try {
      return await fn()
    } finally {
      release()
      if (conversationLocks.get(key) === chain) conversationLocks.delete(key)
    }
  }

  /** Run one short-lived command in `cwd` and collect its text. */
  async function runCommand(argv, cwd, signal, maxBytes = 1024 * 1024) {
    const executable = await ctx.subprocess.resolveExecutable(argv[0], undefined, signal)
    const handle = ctx.subprocess.spawn({
      argv: [executable, ...argv.slice(1)],
      cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes },
        stderr: { maxBytes: 64 * 1024 },
      },
      graceMs: 3000,
      signal,
    })
    const { exitCode } = await handle.done
    return { exitCode, stdout: textOf(handle.collected.stdout), stderr: textOf(handle.collected.stderr) }
  }

  /** Capture the initial HEAD commit for `(rootId, cwd)` if not yet recorded. */
  async function ensureBaseHead(rootId, cwd, signal) {
    if (rootId === undefined || cwd === undefined) return undefined
    const key = `${rootId}\0${cwd}`
    if (baseHeads.has(key)) return baseHeads.get(key)
    try {
      const head = await runCommand(['git', 'rev-parse', '--verify', 'HEAD'], cwd, signal, 4096)
      if (head.exitCode === 0) {
        const sha = head.stdout.trim()
        if (sha.length > 0) {
          boundedSet(baseHeads, key, sha)
          return sha
        }
      }
    } catch {
      // Not a git repo or unborn HEAD; ignore.
    }
    return undefined
  }

  /** Compute a lightweight working-tree + HEAD fingerprint for shell-only dirty checks. */
  async function repoFingerprint(cwd, signal) {
    try {
      const status = await runCommand(['git', 'status', '--porcelain', '-uall'], cwd, signal, 512 * 1024)
      if (status.exitCode !== 0) return undefined
      const head = await runCommand(['git', 'rev-parse', '--verify', 'HEAD'], cwd, signal, 4096)
      let diff = head.exitCode === 0
        ? await runCommand(['git', '--no-pager', 'diff', 'HEAD'], cwd, signal, 4 * 1024 * 1024)
        : await runCommand(['git', '--no-pager', 'diff'], cwd, signal, 4 * 1024 * 1024)
      if (diff.exitCode !== 0) return undefined

      const hash = createHash('sha256')
      hash.update(head.exitCode === 0 ? head.stdout.trim() : 'UNBORN')
      hash.update('\0')
      hash.update(status.stdout)
      hash.update('\0')
      hash.update(diff.stdout)

      // Without a HEAD commit `git diff` reports unstaged changes only, so a
      // file staged in a fresh repository hashes identically before and after
      // another edit-plus-stage. Fold the index in for that case.
      if (head.exitCode !== 0) {
        const staged = await runCommand(['git', '--no-pager', 'diff', '--cached'], cwd, signal, 4 * 1024 * 1024)
        if (staged.exitCode === 0) {
          hash.update('\0')
          hash.update(staged.stdout)
        }
      }

      const { untracked } = parsePorcelainStatus(status.stdout)
      const root = resolve(cwd)
      for (const relPath of untracked.slice(0, 200)) {
        // Editor state is excluded from the review diff, so it must not make
        // the repository look changed either.
        if (isUntrackedNoise(relPath)) continue
        const absPath = resolve(root, relPath)
        if (absPath !== root && !absPath.startsWith(`${root}${sep}`)) continue
        try {
          const info = await stat(absPath)
          hash.update(`\0${relPath}:${info.size}:${info.mtimeMs}`)
        } catch {
          hash.update(`\0${relPath}:missing`)
        }
      }
      return hash.digest('hex')
    } catch {
      return undefined
    }
  }

  /** The directory agy should explore: explicit, else the session's directory. */
  function resolveCwd(args, exec) {
    if (args?.cwd !== undefined) return args.cwd
    const session = exec?.agent?.session
    const workingDirectory = ctx.get('workingDirectory')
    if (workingDirectory !== undefined && session !== undefined) {
      try {
        return workingDirectory.get(session)
      } catch {
        // Fall through to the session header.
      }
    }
    return session?.header.cwd ?? process.cwd()
  }

  /**
   * Reject a `cwd` agy was pointed at that the session does not own.
   *
   * The comparison uses `realpath` on both sides and `path.relative` for
   * containment: `realpath` collapses `/tmp` → `/private/tmp` on macOS (and
   * any workspace symlink), while `relative` refuses `/repo-2` for `/repo`
   * and catches a Windows drive change, which a `startsWith` test does not.
   *
   * @param requested - the directory agy was asked to explore.
   * @param exec - the tool run context, for the caller's own workspace.
   * @returns the canonical directory to pass to `agy`.
   */
  async function assertAllowedCwd(requested, exec) {
    let target
    try {
      target = await realpath(requested)
    } catch {
      throw new Error(`cwd ${requested} does not exist or is not readable.`)
    }
    if (allowExternalCwd) return target

    const session = exec?.agent?.session
    const workingDirectory = ctx.get('workingDirectory')
    let workspace
    if (workingDirectory !== undefined && session !== undefined) {
      try {
        workspace = workingDirectory.get(session)
      } catch {
        // Fall through to the session header.
      }
    }
    workspace ??= session?.header.cwd
    if (workspace === undefined) return target

    const roots = []
    try {
      roots.push(await realpath(workspace))
    } catch {
      roots.push(resolve(workspace))
    }
    for (const root of allowedRoots) {
      try {
        roots.push(await realpath(root))
      } catch {
        // A configured root that does not exist must not disable the rest.
      }
    }

    const inside = roots.some((root) => {
      const rel = relative(root, target)
      return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
    })
    if (!inside) {
      throw new Error(
        `cwd ${requested} is outside the session workspace ${workspace}. `
        + 'Pass a directory inside it, or set `allowExternalCwd: true` / add it to `allowedRoots` on the agy-planner row.',
      )
    }
    return target
  }

  /**
   * The canonical form of a directory, for use as a map key.
   *
   * `dirtyCwds` and `baseHeads` are keyed by directory, and the same repository
   * reaches them from two sides: a shell tool's cwd and an agy tool's `cwd`.
   * Those strings differ for a symlinked checkout (`/tmp/x` versus
   * `/private/tmp/x` on macOS), which would leave one side's entry invisible to
   * the other. Resolving both collapses them into one entry.
   * @param dir - the directory to canonicalize.
   * @returns the resolved path, or the input when it cannot be resolved.
   */
  async function canonicalCwd(dir) {
    if (dir === undefined) return dir
    try {
      return await realpath(dir)
    } catch {
      return resolve(dir)
    }
  }

  // Enforce the user's answer on every delegated start. A guard is monotonic:
  // once it denies a call, no later listener can turn that call back on.
  ctx.effect(() => ctx.tools.guard((execution) => {
    if (!DELEGATION_TOOLS.has(execution.name) || execution.agent === undefined) return undefined
    const rootId = rootIdOf(execution.agent)
    const budget = budgets.get(rootId)
    if (budget === undefined) {
      return 'No delegation budget has been set for this task. Ask the user (subagents allowed? how many at once? how deep?), then call `agy_delegation_budget`.'
    }
    if (!budget.allow) {
      return 'The user allowed no subagents for this task. Carry the work out directly.'
    }
    const depth = depthOf(execution.agent)
    if (depth + 1 > budget.maxDepth) {
      return `The user allowed ${budget.maxDepth} delegation level(s); this agent is already at depth ${depth}. Carry the work out directly.`
    }
    const live = liveDescendants(rootId)
    if (live >= budget.maxChildren) {
      return `The user allowed ${budget.maxChildren} running subagent(s) and ${live} are running. Wait for one to finish, or carry the work out directly.`
    }
    return undefined
  }), 'agy-mode.delegation-guard')

  // Track whether the task root changed anything since its last review, and what
  // the last review left unresolved. Keyed by rootId so subagent edits mark
  // the root task dirty too.
  ctx.effect(() => ctx.on('tools/execute', async (execution, next) => {
    const agent = execution.agent
    const rootId = agent === undefined ? undefined : rootIdOf(agent)
    const isMutating = MUTATING_TOOLS.has(execution.name)
    // `agy_review` is not itself a mutation, but it needs the same key to clear
    // the directory its verdict covers, so it resolves one too.
    const needsCwd = isMutating || execution.name === 'agy_review'
    // One canonical directory for this call, used as the key for `baseHeads`
    // and `dirtyCwds`. A symlinked checkout must land on one entry, whoever
    // reopened it.
    const callCwd = needsCwd ? await canonicalCwd(resolveCwd(execution.args, { agent })) : undefined
    if (isMutating && rootId !== undefined) {
      await ensureBaseHead(rootId, callCwd, execution.signal)
    }

    // Sample the repository before a shell call so its effect can be measured
    // rather than assumed. Only read when the gate believes it is clean: an
    // already-dirty task does not need the answer, and the check costs three
    // git invocations.
    const isShell = SHELL_TOOLS.has(execution.name)
    // The epoch at the moment agy_review was entered. The diff is collected
    // inside the tool, after this point, so any later bump is a change the
    // review cannot have judged.
    const reviewEpoch = execution.name === 'agy_review' && rootId !== undefined ? gateOf(rootId).epoch : undefined
    const reviewCwd = callCwd
    // Sample the repository before a shell call when the answer can matter: on a
    // clean task (to learn whether this call is what dirtied it) and during an
    // in-flight review (where a read-only command must not appear to change
    // anything, and a mutating one must not be credited to that review).
    const entryGate = rootId === undefined ? undefined : gateOf(rootId)
    const reviewing = entryGate !== undefined && entryGate.reviews > 0
    const alreadyDirty = entryGate !== undefined && entryGate.dirtyCwds.has(reviewCwd)
    let before
    if (isShell && agent !== undefined && rootId !== undefined && (!alreadyDirty || reviewing)) {
      before = await repoFingerprint(reviewCwd, execution.signal)
    }

    // Count this review as in flight for the whole of its own execution, so
    // concurrent shell calls are measured rather than assumed.
    if (entryGate !== undefined && execution.name === 'agy_review') entryGate.reviews += 1

    let result
    try {
      result = await next()
    } finally {
      // Always release, including on a thrown or rejected review: a leak here
      // would keep sampling fingerprints for the rest of the task.
      if (entryGate !== undefined && execution.name === 'agy_review') entryGate.reviews = Math.max(0, entryGate.reviews - 1)
    }
    if (agent === undefined || rootId === undefined) return result
    const gate = gateOf(rootId)

    if (execution.name === 'agy_review' && result.isError === false) {
      const value = result.value ?? {}
      const findings = Array.isArray(value.findings) ? value.findings : []
      const blocking = findings.filter((finding) => BLOCKING.has(finding.severity))
      const reviewedCwd = callCwd
      gate.nudgedTurn = undefined

      if (value.verdict === 'pass') {
        // A pass only covers the state the review ran against. If anything
        // landed while it was in flight, the epoch moved and this verdict is
        // stale — a parallel subagent edit must not ride a review that never
        // saw it.
        if (gate.epoch !== reviewEpoch) {
          gate.unresolved = [{
            severity: 'major',
            problem: 'the workspace changed while the review was running, so the pass does not cover that change',
          }]
        } else {
          gate.dirtyCwds.delete(reviewedCwd)
          gate.unresolved = undefined
          gate.rounds = 0
          gate.stalled = false
          gate.findings = undefined
        }
      } else {
        // Keep the gate shut: a fail only clears once a later review passes.
        // This directory's dirty entry is cleared only when nothing else landed
        // during the review; otherwise the in-flight edit is still unseen.
        if (gate.epoch === reviewEpoch) gate.dirtyCwds.delete(reviewedCwd)
        gate.unresolved = blocking.length > 0 ? blocking : [{ severity: 'major', problem: 'agy reported a failure without naming a finding' }]
        gate.rounds += 1
        gate.findings = findings
      }
      return result
    }

    if (isMutating && result.isError === false) {
      // Compare only when both readings exist. An unavailable reading (not a
      // git repository, git missing) is not evidence of a change, and treating
      // it as one would demand a review of work that never happened.
      if (isShell) {
        // Only a sampled call can be judged by its effect. `before` is absent
        // when the gate was already dirty at entry, when there is no agent (a
        // subagent has its own root), or when cwd could not be resolved. Reading
        // the fingerprint anyway cost three git invocations plus up to 200
        // `stat`s and then discarded the answer, and — worse — a read-only
        // command would still fall through to `markDirty`, bumping the epoch and
        // invalidating a `pass` that was in flight at that moment.
        if (before !== undefined) {
          const after = await repoFingerprint(reviewCwd, execution.signal)
          // Unchanged repository: a read-only command. Recording it would force
          // a review of a diff that does not exist, would re-arm a stalled loop,
          // and — when a review is in flight — would bump the epoch and make a
          // legitimate pass look stale.
          if (after !== undefined && after === before) return result
        }
      }
      markDirty(gate, reviewCwd, FILE_MUTATING_TOOLS.has(execution.name) ? 'edit' : 'shell')
      // Once real work happens after hitting the round cap, re-arm the gate.
      if (gate.stalled) {
        gate.stalled = false
        gate.rounds = 0
      }
    }
    return result
  }), 'agy-mode.review-gate')

  /** Compose the steering text for one closing turn. */
  function nudgeText(gate) {
    if (gate.unresolved !== undefined) {
      const list = gate.unresolved
        .map((finding) => `[${finding.severity}] ${finding.problem}`)
        .join('; ')
      if (gate.rounds >= maxReviewRounds) {
        return `agy has rejected this work ${gate.rounds} times and the findings are still: ${list}. Stop looping: report the disagreement to the user — what agy objects to, what you changed each round, and what you would do with their guidance. Do not mark the task complete on your own authority.`
      }
      return `agy still rejects this work: ${list}. Fix every blocker and major, then call \`agy_review\` again with the new diff. Do not report the task as done while agy fails it; if you believe a finding is wrong, say why and let the user decide.`
    }
    if (gate.rounds >= maxReviewRounds) return undefined
    return 'Before you report this task as done: the work changed since it was last reviewed, and quality is agy\'s call. Call `agy_review` now (default `scope: diff` sends the working-tree diff for you), include how you verified it, and address every blocker and major finding. If the user asked you not to review, say so and finish.'
  }

  /**
   * A turn must not close on unreviewed — or reviewed-but-unfixed — changes.
   * Steering adds one instruction to the closing turn; it never blocks the turn
   * outright, so a user who declines the review can always end the task.
   */
  if (requireReview) {
    ctx.effect(() => ctx.on('agent/turn-stopping', async ({ agent, turn }) => {
      if (agent.session.header.parentSession !== undefined && depthOf(agent) > 0) return
      const gate = gateOf(rootIdOf(agent))
      if (gate.dirtyCwds.size === 0 && gate.unresolved === undefined) return
      if (gate.nudgedTurn === turn) return
      if (gate.stalled) return

      const body = nudgeText(gate)
      if (body === undefined) return
      gate.nudgedTurn = turn
      if (gate.unresolved !== undefined && gate.rounds >= maxReviewRounds) gate.stalled = true
      agent.steer({
        // A steered message carries the same required fields as any user
        // message: identity, role, content, and its producer tag.
        id: randomUUID(),
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: body }],
      })
    }), 'agy-mode.review-reminder')
  }

  /**
   * Collect what actually changed in the repository (working tree + any commits
   * created since the task's base HEAD + non-binary untracked files).
   * @param cwd - repository root.
   * @param exec - tool run context.
   * @param baseHead - HEAD captured before the task's first mutation.
   * @param budgetUnits - cap for the diff body, in `promptUnits`.
   */
  async function collectDiff(cwd, exec, baseHead, budgetUnits = diffBudgetUnits) {
    const status = await runCommand(['git', 'status', '--porcelain', '-uall'], cwd, exec.signal)
    if (status.exitCode !== 0) return undefined

    let diffRef = 'HEAD'
    let commits = ''
    let baseLabel = 'working tree against HEAD'
    const headCheck = await runCommand(['git', 'rev-parse', '--verify', 'HEAD'], cwd, exec.signal, 4096)
    const hasHead = headCheck.exitCode === 0
    const currentHead = hasHead ? headCheck.stdout.trim() : undefined

    if (hasHead && baseHead !== undefined && baseHead !== currentHead) {
      const checkBase = await runCommand(['git', 'cat-file', '-e', `${baseHead}^{commit}`], cwd, exec.signal, 4096)
      if (checkBase.exitCode === 0) {
        diffRef = baseHead
        baseLabel = `working tree + commits since ${baseHead.slice(0, 7)}`
        const logRes = await runCommand(['git', '--no-pager', 'log', '--oneline', `${baseHead}..HEAD`], cwd, exec.signal, 64 * 1024)
        if (logRes.exitCode === 0) commits = logRes.stdout.trim()
      }
    }

    let diff = hasHead
      ? await runCommand(['git', '--no-pager', 'diff', diffRef], cwd, exec.signal, 8 * 1024 * 1024)
      : await runCommand(['git', '--no-pager', 'diff'], cwd, exec.signal, 8 * 1024 * 1024)
    if (diff.exitCode !== 0 && hasHead && diffRef !== 'HEAD') {
      diff = await runCommand(['git', '--no-pager', 'diff', 'HEAD'], cwd, exec.signal, 8 * 1024 * 1024)
      diffRef = 'HEAD'
      baseLabel = 'working tree against HEAD'
      commits = ''
    }
    if (diff.exitCode !== 0) return undefined

    const { files, untracked } = parsePorcelainStatus(status.stdout)
    const body = diff.stdout
    if (body.trim().length === 0 && untracked.length === 0) {
      return { empty: true, files: [], untracked, omittedUntracked: [], skippedNoise: 0, diff: '', stat: '', commits, baseLabel }
    }

    let statText = ''
    if (promptUnits(body) > budgetUnits) {
      const statRes = hasHead
        ? await runCommand(['git', '--no-pager', 'diff', '--stat', diffRef], cwd, exec.signal, 128 * 1024)
        : await runCommand(['git', '--no-pager', 'diff', '--stat'], cwd, exec.signal, 128 * 1024)
      if (statRes.exitCode === 0) statText = statRes.stdout.trim()
    }

    const clipped = prioritizeAndClipDiff(body, budgetUnits)
    const remainingBudget = Math.max(0, budgetUnits - promptUnits(clipped.diff))
    const untrackedResult = await collectUntrackedDiffs(cwd, untracked, remainingBudget)
    const combined = [clipped.diff.trimEnd(), untrackedResult.text.trimEnd()].filter(Boolean).join('\n\n')

    return {
      empty: false,
      // The touched-file list is what agy reads first, so it must not advertise
      // editor state either: a path listed here but absent from the diff reads
      // as "changed and not shown", which is worse than not listing it.
      files: files.filter(line => !isUntrackedNoise(porcelainPath(line))),
      untracked: untracked.filter(path => !isUntrackedNoise(path)),
      omittedUntracked: untrackedResult.omitted,
      skippedNoise: untrackedResult.skippedNoise,
      diff: combined,
      stat: statText,
      commits,
      baseLabel,
    }
  }

  /** Effective default model & effort for a tier, factoring in task-level `agy_routes` overrides. */
  function resolveTierRoute(rootId, purpose) {
    const base = tiers[purpose] ?? tiers.consult
    // The plugin page writes to the Host `agy-planner-config` row; a value set
    // there outranks this row's static config but not a per-task `agy_routes`
    // choice, because the latter is what the user picked for this task.
    const hosted = ctx.get('agyModeDefaults')?.(purpose) ?? {}
    // `present` means the configuration row is mounted and answered for this
    // tier. A field it left empty is then an explicit "CLI default" choice, so
    // this row's own default must not quietly step back in.
    const answered = hosted.present === true
    const tierBase = {
      model: hosted.model ?? (answered ? undefined : base.model),
      effort: hosted.effort ?? (answered ? undefined : base.effort),
    }
    const override = rootId === undefined ? undefined : routes.get(rootId)
    if (override === undefined) return tierBase
    const specific = override[purpose]
    const fallback = purpose === 'review' ? override.plan : undefined
    return {
      model: specific?.model ?? fallback?.model ?? tierBase.model,
      effort: specific?.effort ?? fallback?.effort ?? tierBase.effort,
    }
  }

  /**
   * Run one `agy` print-mode turn, resuming the task's conversation when it can.
   * @param args the tool arguments.
   * @param exec the tool run context.
   * @param options.purpose which tier and conversation this call belongs to.
   * @param options.schema a JSON Schema agy must satisfy, for structured output.
   * @param options.prompt the prompt text to send.
   */
  async function runAgy(args, exec, { purpose, schema, prompt }) {
    if (args.effort !== undefined && !AGY_EFFORTS.includes(args.effort)) {
      throw new Error(`unknown reasoning effort ${JSON.stringify(args.effort)}; use one of ${AGY_EFFORTS.join(', ')}`)
    }
    // Validate the directory only when the caller named one: the default is the
    // session's own workspace, which the user already scoped. Checking it here
    // rather than inside `resolveCwd` keeps that helper synchronous for the
    // tools/execute middleware.
    const cwd = args.cwd === undefined
      ? resolveCwd(args, exec)
      : await assertAllowedCwd(args.cwd, exec)
    const rootId = exec.agent === undefined ? undefined : rootIdOf(exec.agent)
    const tier = resolveTierRoute(rootId, purpose)
    // A model id that already carries the effort wins over the tier's effort.
    const { model, effort } = reconcileEffort(args.model ?? tier.model, args.effort ?? tier.effort)

    // Guard argv against the platform's per-string limit, measured in bytes on
    // POSIX rather than characters: a CJK prompt occupies three bytes per
    // character, so a character count is not a limit at all.
    const boundedPrompt = clipToUnits(prompt, promptLimit, `\n…[prompt truncated at ${promptLimit} units to fit the CLI argv limit]`)

    const executable = await ctx.subprocess.resolveExecutable(command, undefined, exec.signal)

    return withRootLock(rootId, async () => {
      const logFile = join(tmpdir(), `dsh-agy-${process.pid}-${randomUUID().slice(0, 8)}.log`)

      /** One attempt. `resume` is the conversation id to continue, if any. */
      const attempt = async (resume) => {
        const argv = [
          executable,
          '--print', boundedPrompt,
          '--dangerously-skip-permissions',
          '--output-format', 'json',
          // The CLI's own plan mode is read-only: it may inspect, never modify.
          '--mode', 'plan',
        ]
        if (model !== undefined) argv.push('--model', model)
        if (effort !== undefined) argv.push('--effort', effort)
        if (timeoutSeconds > 0) argv.push('--print-timeout', `${timeoutSeconds}s`)
        if (schema !== undefined) argv.push('--json-schema', JSON.stringify(schema))
        if (resume !== undefined) argv.push('--conversation', resume)
        if (extraArgs.length > 0) argv.push(...extraArgs)
        // Per-call log outside the checkout so concurrent runs never contend.
        argv.push('--log-file', logFile)

        const handle = ctx.subprocess.spawn({
          argv,
          cwd,
          stdio: {
            stdin: 'ignore',
            stdout: { maxBytes: 4 * 1024 * 1024 },
            stderr: { maxBytes: 256 * 1024 },
          },
          graceMs: 5000,
          signal: exec.signal,
        })
        const { exitCode } = await handle.done
        return { exitCode, stdout: textOf(handle.collected.stdout), stderr: textOf(handle.collected.stderr) }
      }

      // Reuse the conversation only when enabled, same cwd, and under turn cap.
      const key = rootId
      const known = reuseConversations && key !== undefined ? conversations.get(key) : undefined
      let resume = known !== undefined && known.cwd === cwd && known.turns < maxConversationTurns ? known.id : undefined
      if (key !== undefined && resume === undefined) conversations.delete(key)

      let output
      let transientAttempts = 0
      try {
        for (; ;) {
          output = await attempt(resume)
          if (output.exitCode === 0) break
          const haystack = `${output.stdout}\n${output.stderr}`
          // A conversation the CLI cannot resume must not fail the task: start cold once.
          if (resume !== undefined) {
            conversations.delete(key)
            resume = undefined
            continue
          }
          if (transientAttempts < retries && transientHint(haystack) && !exec.signal?.aborted) {
            transientAttempts += 1
            await new Promise(resolve => setTimeout(resolve, 400 * transientAttempts))
            continue
          }
          break
        }

        if (output.exitCode !== 0) {
          const hint = authHint(output.stderr)
          const transient = transientHint(`${output.stdout}\n${output.stderr}`)
          throw new Error(`agy exited with code ${output.exitCode}${hint === undefined ? '' : `. ${hint}`}${
            transient ? ' The gateway or account looked temporarily unavailable; retrying the same call later may work, or run it on another model.' : ''
          }\n${summarise(output.stderr, 4000)}`)
        }
      } finally {
        await unlink(logFile).catch(() => {})
      }

      let parsed
      try {
        parsed = JSON.parse(output.stdout)
      } catch {
        // Plain-text output from an older CLI: report the raw answer.
        const plain = summarise(output.stdout)
        if (plain.length === 0) {
          const hint = authHint(output.stderr)
          throw new Error(`agy returned an empty answer.${hint === undefined ? ` stderr: ${summarise(output.stderr, 2000)}` : ` ${hint}`}`)
        }
        return { plain, model, effort, cost: rootId === undefined ? undefined : costLine(rootId) }
      }

      if (parsed.status !== undefined && parsed.status !== 'SUCCESS') {
        throw new Error(`agy reported ${parsed.status}: ${summarise(parsed.response ?? output.stderr, 2000)}`)
      }

      // Remember the conversation so the next call in this task can continue it.
      if (reuseConversations && key !== undefined && typeof parsed.conversation_id === 'string') {
        boundedSet(conversations, key, {
          id: parsed.conversation_id,
          turns: typeof parsed.num_turns === 'number' ? parsed.num_turns : 1,
          cwd,
        })
      }
      if (rootId !== undefined) recordSpend(rootId, parsed.usage)

      const usage = parsed.usage === undefined ? undefined : JSON.stringify(parsed.usage)
      const cost = rootId === undefined ? undefined : costLine(rootId)
      const structured = parsed.structured_output
      const answer = typeof parsed.response === 'string' ? parsed.response : output.stdout
      if (structured === undefined) {
        const plain = summarise(answer)
        if (plain.length === 0) {
          const hint = authHint(output.stderr)
          throw new Error(`agy returned no structured output and an empty answer.${hint === undefined ? '' : ` ${hint}`}`)
        }
        return { plain, model, effort, usage, cost }
      }
      return { structured, plain: summarise(answer), model, effort, usage, cost }
    })
  }

  ctx.tools.register({
    name: 'agy_consult',
    description: 'Ask the local Antigravity CLI (agy) to plan work or to critique it in prose. agy explores the repository read-only; DSH carries out every change itself. Follow-ups in the same task resume the earlier agy conversation, so a short question stays short. agy does not see this conversation, so the prompt must be self-contained. For the quality gate on finished work, use agy_review instead.',
    parameters: objectSchema({
      prompt: {
        type: 'string',
        description: 'Self-contained request: the goal, relevant paths, constraints, and the decision needed.',
      },
      mode: {
        type: 'string',
        enum: ['plan', 'review', 'quick'],
        description: 'plan (default) asks for an implementation plan at the planning tier; review asks for a prose critique; quick is a cheap, low-effort answer for a lookup or a small decision.',
      },
      model: {
        type: 'string',
        description: 'agy model id from agy_models. Omit for the tier default.',
      },
      effort: {
        type: 'string',
        enum: AGY_EFFORTS,
        description: 'Reasoning effort for this consultation. Omit for the tier default.',
      },
      cwd: {
        type: 'string',
        description: 'Directory agy explores. Defaults to the session working directory.',
      },
    }, ['prompt']),
    output: {
      schema: objectSchema({
        text: { type: 'string' },
        model: { type: 'string' },
        effort: { type: 'string' },
        usage: { type: 'string' },
        cost: { type: 'string' },
      }, ['text']),
      render: (_args, value) => text(value.cost === undefined ? value.text : `${value.text}\n\n${value.cost}`),
    },
    timeoutMs: 60 * 60 * 1000,
    async execute(args, exec) {
      const mode = args.mode ?? 'plan'
      const prompt = mode === 'review'
        ? `Review the work described below as a skeptical senior engineer. Report concrete defects, risks and missing tests with file paths and line numbers. Do not modify any file.\n\n${args.prompt}`
        : args.prompt
      const result = await runAgy(args, exec, { purpose: mode === 'quick' ? 'consult' : 'plan', prompt })
      return {
        text: result.plain,
        ...result.model === undefined ? {} : { model: result.model },
        ...result.effort === undefined ? {} : { effort: result.effort },
        ...result.usage === undefined ? {} : { usage: result.usage },
        ...result.cost === undefined ? {} : { cost: result.cost },
      }
    },
  })

  ctx.tools.register({
    name: 'agy_review',
    description: 'Quality gate on finished work: agy returns a structured verdict (pass/fail) with concrete findings, ranked by severity. Call it after implementing and verifying, before reporting completion. By default the working-tree diff (plus new untracked files and any commits made during this task) is collected and sent, so agy judges the real change rather than a description; use scope "repo" only when it must follow callers across files. A failure keeps the gate shut until a later review passes. Read-only: agy never changes files.',
    parameters: objectSchema({
      work: {
        type: 'string',
        description: 'What was changed and why. Optional under scope "diff": the diff is collected for you.',
      },
      requirements: {
        type: 'string',
        description: 'What the work must satisfy: the user request, acceptance criteria, or the plan agy produced earlier.',
      },
      evidence: {
        type: 'string',
        description: 'How it was verified: the exact test or check commands and their outcome. Reviews without evidence are weak; paste the real output, not a claim.',
      },
      scope: {
        type: 'string',
        enum: ['diff', 'repo'],
        description: 'diff (default) sends the collected working-tree diff; repo makes agy explore the checkout itself and costs a full cold start.',
      },
      focus: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional aspects to weigh hardest, such as "correctness", "error handling", "tests", "performance", "security", "API compatibility".',
      },
      model: {
        type: 'string',
        description: 'agy model id from agy_models. Omit for the review tier default.',
      },
      effort: {
        type: 'string',
        enum: AGY_EFFORTS,
        description: 'Reasoning effort for this review. Omit for the review tier default.',
      },
      cwd: {
        type: 'string',
        description: 'Directory agy works from. Defaults to the session working directory.',
      },
    }),
    output: {
      schema: objectSchema({
        verdict: { type: 'string', enum: ['pass', 'fail'] },
        summary: { type: 'string' },
        findings: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'nit'] },
              file: { type: 'string' },
              line: { type: 'integer' },
              problem: { type: 'string' },
              fix: { type: 'string' },
            },
            required: ['severity', 'problem'],
          },
        },
        scope: { type: 'string' },
        round: { type: 'number' },
        review: { type: 'string' },
        cost: { type: 'string' },
      }, ['verdict', 'summary', 'findings', 'scope', 'round', 'review']),
      render: (_args, value) => text(value.review),
    },
    timeoutMs: 60 * 60 * 1000,
    async execute(args, exec) {
      // Validate a caller-named directory BEFORE collecting anything: the diff
      // walk runs `git` there and reads untracked files, so refusing later (in
      // `runAgy`) would already have touched a directory this session may not
      // own.
      // Canonical, because `baseHeads` is keyed by the same form the
      // `tools/execute` middleware writes: a symlinked checkout (`/tmp` and
      // `/private/tmp` on macOS) must not resolve to two different entries, or
      // the task's starting commit would be invisible here.
      const cwd = args.cwd === undefined
        ? await canonicalCwd(resolveCwd(args, exec))
        : await assertAllowedCwd(args.cwd, exec)
      if (args.cwd !== undefined) args = { ...args, cwd }
      const rootId = exec.agent === undefined ? undefined : rootIdOf(exec.agent)
      const gate = rootId === undefined ? undefined : gateOf(rootId)
      const baseHead = rootId === undefined ? undefined : baseHeads.get(`${rootId}\0${cwd}`)

      const focus = args.focus === undefined || args.focus.length === 0
        ? 'correctness, error handling, tests, and whether the work actually satisfies the requirement'
        : args.focus.join(', ')

      // The tail carries the requirement, the evidence and the grading rules —
      // the three things agy cannot infer from a diff. It is assembled before
      // the diff so the budget can be taken from what is left, because the
      // prompt is truncated at its END: a full-size diff used to silently drop
      // the requirement and the pass/fail rubric instead of shrinking itself.
      const tail = [
        args.work === undefined ? undefined : `What the author says they did: ${args.work}`,
        args.requirements === undefined ? undefined : `Must satisfy: ${args.requirements}`,
        args.evidence === undefined ? undefined : `How they verified it: ${args.evidence}`,
        // Incremental review: re-litigating findings already reported wastes a
        // full call. Ask about what remains instead.
        gate?.findings !== undefined && gate.rounds > 0
          ? [
            'A previous review already reported these. Check each against the code above and only repeat the ones that still stand:',
            ...gate.findings.map(finding => `  - [${finding.severity}] ${finding.problem}${finding.file === undefined ? '' : ` (${finding.file})`}`),
          ].join('\n')
          : undefined,
        '',
        `Weigh hardest: ${focus}.`,
        '',
        'Report only defects you can point at: wrong behaviour, missed cases, broken callers, unclear error handling, missing or inadequate tests, and anything that does not meet the requirement. Do not restate the work back.',
        '',
        'Judge the work against the requirement as stated, not against what you would have designed. A limitation the requirement never asked about is at most a minor note; never a blocker or major. When the requirement sets no contract for a case, say the case is uncovered rather than treating your assumed contract as broken.',
        'Blockers and major findings must be things that make the delivered work wrong, unsafe, or incomplete for what was asked.',
        'The verdict is "pass" when nothing at blocker or major severity remains; minor notes and nits may accompany a pass.',
      ].filter(line => line !== undefined).join('\n')

      const preamble = 'You are the quality gate for work another engineer just finished. Judge the code, not the description.'
      // Everything that is not the diff. It is assembled first so the diff gets
      // only what is left: the prompt is truncated at its end, and the tail is
      // exactly the part agy cannot infer from the code.
      const head = [
        `This is the change under review (BASE_LABEL). Files touched:`,
        'FILES',
      ]
      // One pass to learn how much room the non-diff sections will need, with a
      // placeholder diff, so the real budget is measured rather than guessed.
      const nonDiffProbe = [
        preamble,
        '',
        ...head,
        '', 'DIFF',
        tail,
      ].join('\n')
      const nonDiffUnits = promptUnits(nonDiffProbe) - promptUnits('DIFF')
      // `promptLimit` is the configured ceiling; the platform cap is the hard
      // floor. Whichever is smaller is what the assembled prompt must fit.
      const budgetCeiling = Math.min(promptLimit, PROMPT_LIMIT_BYTES)
      const diffBudget = Math.max(1024, budgetCeiling - nonDiffUnits - 512)

      // A diff is ground truth; a description is not. Collect one unless the
      // caller explicitly asks agy to explore the checkout instead.
      const wanted = args.scope ?? 'diff'
      const collected = wanted === 'diff' ? await collectDiff(cwd, exec, baseHead, diffBudget) : undefined
      const scope = collected !== undefined && !collected.empty ? 'diff' : 'repo'

      if (scope === 'repo' && args.work === undefined) {
        throw new Error('No working-tree diff was found and no `work` description was given. Describe what changed, or set scope "repo" to let agy explore.')
      }

      const lines = [preamble, '']
      if (scope === 'diff') {
        lines.push(`This is the change under review (${collected.baseLabel}). Files touched:`)
        lines.push(collected.files.map(file => `  ${file}`).join('\n') || '  (committed since task start)')
        if (collected.commits) {
          // The commit list and the stat are not the change itself, so they are
          // clipped rather than allowed to crowd out the diff.
          lines.push('', 'Commits created during this task:', clipToUnits(collected.commits, 4_000, '…[more commits omitted]'))
        }
        if (collected.stat) {
          lines.push('', 'Diff stat:', clipToUnits(collected.stat, 4_000, '…[stat truncated]'))
        }
        if (collected.omittedUntracked.length > 0) {
          lines.push(`Untracked files omitted due to size/binary/budget (open if needed): ${clipToUnits(collected.omittedUntracked.join(', '), 2_000, '…')}`)
        }
        if (collected.skippedNoise > 0) {
          lines.push(`Untracked editor/tool state skipped (${collected.skippedNoise} path(s)); it is not part of the change.`)
        }
      } else {
        lines.push('No diff was available. Inspect the repository yourself; do not assume the description is accurate.')
      }

      // The assembled prompt must fit before the tail is appended, because
      // `runAgy` can only clip from the end — and the end is the rubric.
      const beforeDiff = `${lines.join('\n')}\n`
      const closing = `\n${tail}`
      const diffRoom = budgetCeiling - promptUnits(beforeDiff) - promptUnits(closing) - 32
      if (scope === 'diff') {
        if (diffRoom <= 128) {
          // The requirement, the evidence and the rubric already fill the
          // budget. Sending a stub diff beats sending a prompt whose tail
          // `runAgy` would have to cut, and saying so is better than letting
          // agy believe it saw the change.
          lines.push('', '(The change was omitted: the prompt budget is exhausted by the requirement and evidence. Judge on those, and say so rather than assuming the diff is empty.)')
        } else {
          const body = collected.diff.trim() || '(empty)'
          lines.push('', '```diff', clipToUnits(body, diffRoom, '\n…[diff clipped to fit the prompt budget]'), '```')
        }
      }
      lines.push(tail)

      const result = await runAgy(args, exec, { purpose: 'review', schema: REVIEW_SCHEMA, prompt: lines.join('\n') })
      if (result.structured === undefined) {
        // Without a structured answer there is no verdict to trust: report the
        // prose so the caller can judge, and say the gate did not run.
        throw new Error(`agy did not return a structured verdict. Its answer:\n${result.plain}`)
      }

      const structured = result.structured
      const findings = Array.isArray(structured.findings) ? structured.findings : []
      const verdict = resolveVerdict(structured)
      const summary = typeof structured.summary === 'string' ? structured.summary : ''
      const round = gate === undefined ? 1 : gate.rounds + 1
      const review = { verdict, summary, findings }

      // Gate state is settled by the `tools/execute` middleware, which also
      // knows whether anything landed while this review was in flight.
      // Clearing the dirty set here would be a decision taken from the review's
      // own point of view, with no way to see a concurrent edit.

      return {
        verdict,
        summary,
        findings: findings.map((finding) => ({
          severity: finding.severity ?? 'minor',
          ...finding.file === undefined ? {} : { file: finding.file },
          ...finding.line === undefined ? {} : { line: finding.line },
          problem: finding.problem ?? '',
          ...finding.fix === undefined ? {} : { fix: finding.fix },
        })),
        scope,
        round,
        review: renderReview(review, { round, cost: result.cost, scope }),
        ...result.cost === undefined ? {} : { cost: result.cost },
      }
    },
  })

  ctx.tools.register({
    name: 'agy_models',
    description: 'List the models the local Antigravity CLI accepts together with the active default routes, so the user can choose one and its reasoning effort.',
    parameters: objectSchema({}),
    output: {
      schema: objectSchema({
        models: { type: 'array', items: { type: 'string' } },
        efforts: { type: 'array', items: { type: 'string' } },
        defaults: {
          type: 'object',
          additionalProperties: false,
          properties: {
            plan: { type: 'string' },
            consult: { type: 'string' },
            review: { type: 'string' },
          },
          required: ['plan', 'consult', 'review'],
        },
      }, ['models', 'efforts', 'defaults']),
      render: (_args, value) => text(
        `Models:\n${value.models.join('\n')}\n\nReasoning efforts: ${value.efforts.join(', ')}\n\nConfigured defaults:\n  plan: ${value.defaults.plan}\n  consult: ${value.defaults.consult}\n  review: ${value.defaults.review}`,
      ),
    },
    async execute(_args, exec) {
      const { exitCode, stdout, stderr } = await runCommand([command, 'models'], homedir(), exec.signal, 256 * 1024)
      if (exitCode !== 0) {
        const hint = authHint(stderr)
        throw new Error(`agy models exited with code ${exitCode}${hint === undefined ? '' : `. ${hint}`}: ${summarise(stderr, 2000)}`)
      }
      const models = stdout
        .split('\n')
        .map(line => line.split('\t')[0].trim())
        .filter(line => line.length > 0)
      const rootId = exec.agent === undefined ? undefined : rootIdOf(exec.agent)
      const fmt = (tier) => `${tier.model ?? '(cli default)'} / ${tier.effort ?? '(model default)'}`
      const defaults = {
        plan: fmt(resolveTierRoute(rootId, 'plan')),
        consult: fmt(resolveTierRoute(rootId, 'consult')),
        review: fmt(resolveTierRoute(rootId, 'review')),
      }
      return { models, efforts: [...AGY_EFFORTS], defaults }
    },
  })

  ctx.tools.register({
    name: 'agy_routes',
    description: 'Record the user\'s chosen agy model and reasoning effort for this task (planning, quick consult, and review), so every later call and subagent inherits them automatically instead of relying on memory.',
    parameters: objectSchema({
      planModel: { type: 'string', description: 'Model id for planning (and review fallback if reviewModel is omitted).' },
      planEffort: { type: 'string', enum: AGY_EFFORTS, description: 'Reasoning effort for planning (and review fallback).' },
      consultModel: { type: 'string', description: 'Model id for quick lookups (`mode: quick`). Omit to keep the cheap consult default.' },
      consultEffort: { type: 'string', enum: AGY_EFFORTS, description: 'Reasoning effort for quick lookups.' },
      reviewModel: { type: 'string', description: 'Model id for `agy_review`. Omit to inherit planModel.' },
      reviewEffort: { type: 'string', enum: AGY_EFFORTS, description: 'Reasoning effort for `agy_review`. Omit to inherit planEffort.' },
    }),
    output: {
      schema: objectSchema({
        plan: { type: 'string' },
        consult: { type: 'string' },
        review: { type: 'string' },
      }, ['plan', 'consult', 'review']),
      render: (_args, value) => text(`Active agy routes for this task:\n  plan: ${value.plan}\n  consult: ${value.consult}\n  review: ${value.review}`),
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('agy_routes needs a calling agent')
      for (const key of ['planEffort', 'consultEffort', 'reviewEffort']) {
        if (args[key] !== undefined && !AGY_EFFORTS.includes(args[key])) {
          throw new Error(`unknown reasoning effort ${JSON.stringify(args[key])}; use one of ${AGY_EFFORTS.join(', ')}`)
        }
      }
      const rootId = rootIdOf(exec.agent)
      const prev = routes.get(rootId) ?? {}
      const next = {
        plan: {
          model: args.planModel ?? prev.plan?.model,
          effort: args.planEffort ?? prev.plan?.effort,
        },
        consult: {
          model: args.consultModel ?? prev.consult?.model,
          effort: args.consultEffort ?? prev.consult?.effort,
        },
        review: {
          model: args.reviewModel ?? prev.review?.model,
          effort: args.reviewEffort ?? prev.review?.effort,
        },
      }
      boundedSet(routes, rootId, next)
      const fmt = (tier) => {
        const resolved = reconcileEffort(tier.model, tier.effort)
        return `${resolved.model ?? '(cli default)'} / ${resolved.effort ?? resolved.implied ?? '(model default)'}`
      }
      return {
        plan: fmt(resolveTierRoute(rootId, 'plan')),
        consult: fmt(resolveTierRoute(rootId, 'consult')),
        review: fmt(resolveTierRoute(rootId, 'review')),
      }
    },
  })

  ctx.tools.register({
    name: 'agy_delegation_budget',
    description: 'Record the user\'s answer about delegated work for this task: whether subagents may run at all, how many may run at once, and how many delegation levels deep they may go. Enforcement is immediate for every later subagent, subagent_fork and workflow call.',
    parameters: objectSchema({
      allow: {
        type: 'boolean',
        description: 'Whether the user allows this task to delegate work to subagents at all.',
      },
      maxChildren: {
        type: 'number',
        description: 'How many subagents may run at the same time. May be 0.',
      },
      maxDepth: {
        type: 'number',
        description: 'How many delegation levels are allowed below you (1 = your direct children only, 0 = you cannot delegate).',
      },
    }, ['allow', 'maxChildren', 'maxDepth']),
    output: {
      schema: objectSchema({
        allow: { type: 'boolean' },
        maxChildren: { type: 'number' },
        maxDepth: { type: 'number' },
      }, ['allow', 'maxChildren', 'maxDepth']),
      render: (_args, value) => text(value.allow
        ? `Delegation allowed: up to ${value.maxChildren} running subagent(s), ${value.maxDepth} level(s) deep.`
        : 'Delegation disabled for this task; all work is carried out directly.'),
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('agy_delegation_budget needs a calling agent')
      const maxChildren = Math.max(0, Math.trunc(args.maxChildren))
      const maxDepth = Math.max(0, Math.trunc(args.maxDepth))
      const allow = Boolean(args.allow) && maxChildren > 0 && maxDepth > 0
      const budget = { allow, maxChildren, maxDepth }
      boundedSet(budgets, rootIdOf(exec.agent), budget)
      return budget
    },
  })
}
