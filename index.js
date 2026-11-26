/*
 * Antigravity planner mode — host half.
 *
 * Judgement belongs to the local Antigravity CLI (`agy`); execution belongs to
 * DSH. This plugin owns the transport, the review gate, and the delegation
 * budget:
 *
 *   agy_consult            one read-only planning or review turn, answer returned
 *   agy_review             structured quality verdict on finished work
 *   agy_models             the model ids and reasoning efforts this `agy` accepts
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
 * Tools are registered as plain definitions with raw JSON Schemas, so the
 * bundle imports nothing from DSH packages and needs no dependency of its own.
 *
 * @module dsh-agy-mode
 */

import { homedir, tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

export const name = 'agy-planner'
// Required services only; everything else is read through ctx.get() so the
// plugin still loads on a Host that lacks the optional ones.
export const inject = ['tools', 'subprocess']

/** Reasoning efforts the CLI accepts, in ascending order. */
export const AGY_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

/** Tool names that start delegated work, and so consume the budget. */
const DELEGATION_TOOLS = new Set(['subagent', 'subagent_fork', 'workflow'])

/** Tools whose call means the agent changed something worth reviewing. */
const MUTATING_TOOLS = new Set(['write', 'edit', 'apply_patch', 'bash', 'pwsh', 'terminal_send', 'str_replace_editor'])

/** Findings at these severities hold a task back; the rest are notes. */
const BLOCKING = new Set(['blocker', 'major'])

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

/**
 * Reconcile a model id with a reasoning effort.
 *
 * agy's model ids carry the effort as a suffix (`gemini-4-hydrogen-high`), and
 * passing `--effort` alongside a suffixed id is rejected as a conflict. So a
 * suffixed id wins: the effort argument is dropped rather than fighting the id.
 * An unsuffixed id (an orchestrator, a raw family name) takes the effort.
 */
function reconcileEffort(model, effort) {
  if (model === undefined) return { model, effort }
  const suffix = AGY_EFFORTS.find(candidate => model.endsWith(`-${candidate}`))
  if (suffix === undefined) return { model, effort }
  return { model, effort: undefined, implied: suffix }
}

/** Bound one CLI answer so a runaway plan cannot flood the conversation. */
function summarise(text, limit = 24000) {
  const value = text.trim()
  return value.length > limit ? `${value.slice(0, limit)}\n…[truncated ${value.length - limit} chars]` : value
}

/** The launcher reports a signed-out CLI only on stderr; surface it as advice. */
function authHint(stderr) {
  return /not logged into Antigravity/i.test(stderr)
    ? 'Antigravity CLI is not signed in. Sign in once in a terminal (`agy`, then finish the Google sign-in), then retry.'
    : undefined
}

/**
 * Whether a failure looks transient: a gateway hiccup or a throttled account is
 * worth one more attempt, a bad model id is not.
 */
function transientHint(output) {
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

/** Render one review as model-facing text, strongest findings first. */
function renderReview(review, { round, cost, scope }) {
  const order = { blocker: 0, major: 1, minor: 2, nit: 3 }
  const findings = [...review.findings].sort((a, b) => order[a.severity] - order[b.severity])
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
  /** How much of the working-tree diff is sent to agy. */
  const diffMaxChars = config.diffMaxChars ?? 48000
  /** Extra attempts for a transient gateway or throttle failure. */
  const retries = config.retries ?? 1

  /**
   * The user's delegation answer, keyed by the root Session it belongs to so
   * every descendant inherits one budget. Not durable by design: a new task
   * asks again.
   */
  const budgets = new Map()

  /**
   * agy conversations, keyed by the task root, so a follow-up resumes instead of
   * restarting. One conversation per task on purpose: a plan, a lookup and a
   * review all concern the same checkout, and splitting them would make agy
   * re-explore a repository it has already read. A conversation is dropped when
   * its directory changes, when it grows past `maxConversationTurns`, or when the
   * CLI cannot resume it.
   */
  const conversations = new Map()

  /** Accumulated agy spend per task root, so the cost is visible, not guessed. */
  const spends = new Map()

  /**
   * Per-Session review gate state:
   *   dirty      the agent changed something since its last review
   *   unresolved blocking findings the last review raised and nobody has cleared
   *   rounds     consecutive failing reviews, so a stuck loop stays bounded
   *   nudgedTurn the turn already steered, so one turn is nudged once
   *   stalled    the round cap was hit; stop steering and let the user decide
   */
  const gates = new Map()

  const gateOf = (sessionId) => {
    let gate = gates.get(sessionId)
    if (gate === undefined) {
      gate = { dirty: false, unresolved: undefined, rounds: 0, nudgedTurn: undefined, stalled: false, findings: undefined }
      gates.set(sessionId, gate)
    }
    return gate
  }

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
    spends.set(rootId, spend)
  }

  /** One line of spend, compact enough to ride along with every answer. */
  function costLine(rootId) {
    const spend = spends.get(rootId)
    if (spend === undefined || spend.calls === 0) return undefined
    const scale = value => (value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value))
    const cached = spend.input > 0 ? ` (${Math.min(100, Math.round((spend.cached / spend.input) * 100))}% cached)` : ''
    return `agy so far: ${spend.calls} call(s), ${scale(spend.input)} in${cached}, ${scale(spend.output)} out`
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

  // Track whether the agent changed anything since its last review, and what
  // the last review left unresolved. A review that fails is unfinished work,
  // not a cleared gate.
  ctx.effect(() => ctx.on('tools/execute', async (execution, next) => {
    const agent = execution.agent
    const result = await next()
    if (agent === undefined) return result
    const gate = gateOf(agent.session.id)
    if (execution.name === 'agy_review' && result.isError === false) {
      const value = result.value ?? {}
      const findings = Array.isArray(value.findings) ? value.findings : []
      const blocking = findings.filter((finding) => BLOCKING.has(finding.severity))
      gate.dirty = false
      gate.nudgedTurn = undefined
      if (value.verdict === 'pass') {
        gate.unresolved = undefined
        gate.rounds = 0
        gate.stalled = false
        gate.findings = undefined
      } else {
        // Keep the gate shut: a fail only clears once a later review passes.
        gate.unresolved = blocking.length > 0 ? blocking : [{ severity: 'major', problem: 'agy reported a failure without naming a finding' }]
        gate.rounds += 1
        gate.findings = findings
      }
      return result
    }
    if (MUTATING_TOOLS.has(execution.name) && result.isError === false) {
      gate.dirty = true
      gate.nudgedTurn = undefined
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
      const gate = gateOf(agent.session.id)
      if (!gate.dirty && gate.unresolved === undefined) return
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

  /** The directory agy should explore: explicit, else the session's directory. */
  function resolveCwd(args, exec) {
    if (args.cwd !== undefined) return args.cwd
    const session = exec.agent?.session
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

  /** Run one short-lived command in `cwd` and collect its text. */
  async function runCommand(argv, cwd, exec, maxBytes = 1024 * 1024) {
    const executable = await ctx.subprocess.resolveExecutable(argv[0], undefined, exec.signal)
    const handle = ctx.subprocess.spawn({
      argv: [executable, ...argv.slice(1)],
      cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes },
        stderr: { maxBytes: 64 * 1024 },
      },
      graceMs: 3000,
      signal: exec.signal,
    })
    const { exitCode } = await handle.done
    return { exitCode, stdout: textOf(handle.collected.stdout), stderr: textOf(handle.collected.stderr) }
  }

  /**
   * Collect what actually changed in the working tree.
   *
   * Sending this costs about the same as letting agy rediscover it, but it is
   * ground truth: an agy turn that answers without reading a file is cheap and
   * worthless, and a diff in the prompt cannot be skipped.
   */
  async function collectDiff(cwd, exec) {
    const status = await runCommand(['git', 'status', '--porcelain'], cwd, exec)
    if (status.exitCode !== 0) return undefined

    // `git diff HEAD` covers staged and unstaged; a repo with no commit yet
    // falls back to the plain working-tree diff.
    let diff = await runCommand(['git', '--no-pager', 'diff', 'HEAD'], cwd, exec, 8 * 1024 * 1024)
    if (diff.exitCode !== 0) diff = await runCommand(['git', '--no-pager', 'diff'], cwd, exec, 8 * 1024 * 1024)
    if (diff.exitCode !== 0) return undefined

    const files = status.stdout.split('\n').map(line => line.trim()).filter(line => line.length > 0)
    const untracked = files.filter(line => line.startsWith('??')).map(line => line.slice(2).trim())
    const body = diff.stdout
    if (body.trim().length === 0 && untracked.length === 0) {
      return { empty: true, files, untracked, diff: '' }
    }
    const clipped = body.length > diffMaxChars
      ? `${body.slice(0, diffMaxChars)}\n…[diff truncated at ${diffMaxChars} chars; ${body.length - diffMaxChars} omitted]`
      : body
    return { empty: false, files, untracked, diff: clipped }
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
    const tier = tiers[purpose] ?? tiers.consult
    if (args.effort !== undefined && !AGY_EFFORTS.includes(args.effort)) {
      throw new Error(`unknown reasoning effort ${JSON.stringify(args.effort)}; use one of ${AGY_EFFORTS.join(', ')}`)
    }
    // A model id that already carries the effort wins over the tier's effort.
    const { model, effort } = reconcileEffort(args.model ?? tier.model, args.effort ?? tier.effort)

    const cwd = resolveCwd(args, exec)
    const rootId = exec.agent === undefined ? undefined : rootIdOf(exec.agent)
    const executable = await ctx.subprocess.resolveExecutable(command, undefined, exec.signal)

    /** One attempt. `resume` is the conversation id to continue, if any. */
    const attempt = async (resume) => {
      const argv = [
        executable,
        '--print', prompt,
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
      // Keep the CLI's own log outside the checkout it is reading.
      argv.push('--log-file', join(tmpdir(), 'dsh-agy-consult.log'))

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

    // Reuse the conversation only when it belongs to this directory and has not
    // grown past the cap: a long transcript costs more than a fresh start.
    const key = rootId
    const known = key === undefined ? undefined : conversations.get(key)
    let resume = known !== undefined && known.cwd === cwd && known.turns < maxConversationTurns ? known.id : undefined
    if (key !== undefined && resume === undefined) conversations.delete(key)

    let output
    let attempts = 0
    for (; ;) {
      output = await attempt(resume)
      if (output.exitCode === 0) break
      const haystack = `${output.stdout}\n${output.stderr}`
      // A conversation the CLI cannot resume must not fail the task: start over.
      if (resume !== undefined) {
        conversations.delete(key)
        resume = undefined
        attempts += 1
        if (attempts > retries + 1) break
        continue
      }
      if (attempts < retries && transientHint(haystack) && !exec.signal.aborted) {
        attempts += 1
        await new Promise(resolve => setTimeout(resolve, 400 * attempts))
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
    if (key !== undefined && typeof parsed.conversation_id === 'string') {
      conversations.set(key, {
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
    description: 'Quality gate on finished work: agy returns a structured verdict (pass/fail) with concrete findings, ranked by severity. Call it after implementing and verifying, before reporting completion. By default the working-tree diff is collected and sent, so agy judges the real change rather than a description; use scope "repo" only when it must follow callers across files. A failure keeps the gate shut until a later review passes. Read-only: agy never changes files.',
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
      const cwd = resolveCwd(args, exec)
      const gate = exec.agent === undefined ? undefined : gateOf(exec.agent.session.id)

      // A diff is ground truth; a description is not. Collect one unless the
      // caller explicitly asks agy to explore the checkout instead.
      const wanted = args.scope ?? 'diff'
      const collected = wanted === 'diff' ? await collectDiff(cwd, exec) : undefined
      const scope = collected !== undefined && !collected.empty ? 'diff' : 'repo'

      if (scope === 'repo' && args.work === undefined) {
        throw new Error('No working-tree diff was found and no `work` description was given. Describe what changed, or set scope "repo" to let agy explore.')
      }

      const focus = args.focus === undefined || args.focus.length === 0
        ? 'correctness, error handling, tests, and whether the work actually satisfies the requirement'
        : args.focus.join(', ')

      const lines = [
        'You are the quality gate for work another engineer just finished. Judge the code, not the description.',
        '',
      ]
      if (scope === 'diff') {
        lines.push('This is the complete change under review (working tree against HEAD). Files touched:')
        lines.push(collected.files.map(file => `  ${file}`).join('\n') || '  (none reported)')
        if (collected.untracked.length > 0) {
          lines.push(`Untracked files (contents not included; open them if they matter): ${collected.untracked.join(', ')}`)
        }
        lines.push('', '```diff', collected.diff.trim() || '(empty)', '```')
      } else {
        lines.push('No diff was available. Inspect the repository yourself; do not assume the description is accurate.')
      }
      if (args.work !== undefined) lines.push('', `What the author says they did: ${args.work}`)
      if (args.requirements !== undefined) lines.push('', `Must satisfy: ${args.requirements}`)
      if (args.evidence !== undefined) lines.push('', `How they verified it: ${args.evidence}`)

      // Incremental review: re-litigating findings already reported wastes a
      // full call. Ask about what remains instead.
      if (gate?.findings !== undefined && gate.rounds > 0) {
        lines.push(
          '',
          'A previous review already reported these. Check each against the code above and only repeat the ones that still stand:',
          ...gate.findings.map(finding => `  - [${finding.severity}] ${finding.problem}${finding.file === undefined ? '' : ` (${finding.file})`}`),
        )
      }

      lines.push(
        '',
        `Weigh hardest: ${focus}.`,
        '',
        'Report only defects you can point at: wrong behaviour, missed cases, broken callers, unclear error handling, missing or inadequate tests, and anything that does not meet the requirement. Do not restate the work back.',
        '',
        'Judge the work against the requirement as stated, not against what you would have designed. A limitation the requirement never asked about is at most a minor note; never a blocker or major. When the requirement sets no contract for a case, say the case is uncovered rather than treating your assumed contract as broken.',
        'Blockers and major findings must be things that make the delivered work wrong, unsafe, or incomplete for what was asked.',
        'The verdict is "pass" when nothing at blocker or major severity remains; minor notes and nits may accompany a pass.',
      )

      const result = await runAgy(args, exec, { purpose: 'review', schema: REVIEW_SCHEMA, prompt: lines.join('\n') })
      if (result.structured === undefined) {
        // Without a structured answer there is no verdict to trust: report the
        // prose so the caller can judge, and say the gate did not run.
        throw new Error(`agy did not return a structured verdict. Its answer:\n${result.plain}`)
      }

      const structured = result.structured
      const findings = Array.isArray(structured.findings) ? structured.findings : []
      // A fail carrying nothing above minor is a pass with notes: the gate is
      // about blockers and majors, so a nit never holds a finished task back.
      const blocking = findings.some((finding) => BLOCKING.has(finding.severity))
      const verdict = blocking ? 'fail' : 'pass'
      const summary = typeof structured.summary === 'string' ? structured.summary : ''
      const round = gate === undefined ? 1 : gate.rounds + 1
      const review = { verdict, summary, findings }
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
    description: 'List the models the local Antigravity CLI accepts, so the user can choose one together with its reasoning effort.',
    parameters: objectSchema({}),
    output: {
      schema: objectSchema({
        models: { type: 'array', items: { type: 'string' } },
        efforts: { type: 'array', items: { type: 'string' } },
      }, ['models', 'efforts']),
      render: (_args, value) => text(`Models:\n${value.models.join('\n')}\n\nReasoning efforts: ${value.efforts.join(', ')}`),
    },
    async execute(_args, exec) {
      const { exitCode, stdout, stderr } = await runCommand([command, 'models'], homedir(), exec, 256 * 1024)
      if (exitCode !== 0) {
        throw new Error(`agy models exited with code ${exitCode}: ${summarise(stderr, 2000)}`)
      }
      const models = stdout
        .split('\n')
        .map(line => line.split('\t')[0].trim())
        .filter(line => line.length > 0)
      return { models, efforts: [...AGY_EFFORTS] }
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
      budgets.set(rootIdOf(exec.agent), budget)
      return budget
    },
  })
}
