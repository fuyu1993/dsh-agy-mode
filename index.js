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
function renderReview(review) {
  const order = { blocker: 0, major: 1, minor: 2, nit: 3 }
  const findings = [...review.findings].sort((a, b) => order[a.severity] - order[b.severity])
  const blocking = findings.filter((finding) => finding.severity === 'blocker' || finding.severity === 'major')
  const head = review.verdict === 'pass'
    ? blocking.length === 0 && findings.length === 0
      ? 'agy review: PASS'
      : 'agy review: PASS with notes'
    : `agy review: FAIL — ${blocking.length} blocking finding(s) to fix before reporting completion`
  const body = findings.map((finding) => {
    const where = finding.file === undefined
      ? ''
      : ` (${finding.file}${finding.line === undefined ? '' : `:${finding.line}`})`
    const fix = finding.fix === undefined ? '' : `\n   fix: ${finding.fix}`
    return `- [${finding.severity}] ${finding.problem}${where}${fix}`
  })
  return [head, review.summary, ...body].join('\n')
}

export function apply(ctx, config = {}) {
  const command = config.command ?? 'agy'
  const timeoutSeconds = config.timeoutSeconds ?? 900
  const defaultModel = config.defaultModel
  const defaultEffort = config.defaultEffort
  const requireReview = config.requireReview ?? true

  /**
   * The user's delegation answer, keyed by the root Session it belongs to so
   * every descendant inherits one budget. Not durable by design: a new task
   * asks again.
   */
  const budgets = new Map()

  /**
   * Per-Session review gate state:
   *   dirty    the agent changed something since its last review
   *   reviewed something was reviewed after those changes
   *   nudge    the closing turn already asked for the review once
   *   turn     the review's own turn, so a review never demands another review
   */
  const gates = new Map()

  const gateOf = (sessionId) => {
    let gate = gates.get(sessionId)
    if (gate === undefined) {
      gate = { dirty: false, reviewed: false, nudge: 0, turn: undefined }
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

  // Track whether the agent changed anything since its last review. Anything
  // that can mutate the workspace marks the Session dirty; a review clears it.
  ctx.effect(() => ctx.on('tools/execute', async (execution, next) => {
    const agent = execution.agent
    const result = await next()
    if (agent === undefined) return result
    const gate = gateOf(agent.session.id)
    if (execution.name === 'agy_review' && result.isError === false) {
      gate.dirty = false
      gate.reviewed = true
      gate.nudge = 0
      return result
    }
    if (MUTATING_TOOLS.has(execution.name) && result.isError === false) {
      gate.dirty = true
      if (gate.nudge > 0) gate.nudge = 0
    }
    return result
  }), 'agy-mode.review-gate')

  /**
   * A turn must not close on unreviewed changes. Steering adds one instruction
   * to the closing turn; it never blocks the turn outright, so a user who
   * declines the review can always end the task.
   */
  if (requireReview) {
    ctx.effect(() => ctx.on('agent/turn-stopping', async ({ agent, turn }) => {
      if (agent.session.header.parentSession !== undefined && depthOf(agent) > 0) return
      const gate = gateOf(agent.session.id)
      if (!gate.dirty || gate.nudge > 0) return
      gate.nudge = turn
      agent.steer({
        // A steered message carries the same required fields as any user
        // message: identity, role, content, and its producer tag.
        id: randomUUID(),
        role: 'user',
        source: { kind: 'user' },
        content: [{
          type: 'text',
          text: 'Before you report this task as done: the work changed since it was last reviewed, and quality is agy\'s call. Call `agy_review` now with a self-contained description of what you changed and how you verified it (include the diff summary and the test or check results). Address every blocker and major finding, then report. If the user asked you not to review, say so and finish.',
        }],
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

  /**
   * Run one `agy` print-mode turn.
   * @param args the tool arguments.
   * @param exec the tool run context.
   * @param options.mode `plan` or `review`; review adds the reviewer brief.
   * @param options.schema a JSON Schema agy must satisfy, for structured output.
   * @param options.prompt the prompt text to send.
   */
  async function runAgy(args, exec, { mode, schema, prompt }) {
    const model = args.model ?? defaultModel
    const effort = args.effort ?? defaultEffort
    if (effort !== undefined && !AGY_EFFORTS.includes(effort)) {
      throw new Error(`unknown reasoning effort ${JSON.stringify(effort)}; use one of ${AGY_EFFORTS.join(', ')}`)
    }

    const executable = await ctx.subprocess.resolveExecutable(command, undefined, exec.signal)
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
    // Keep the CLI's own log outside the checkout it is reading.
    argv.push('--log-file', join(tmpdir(), 'dsh-agy-consult.log'))

    const handle = ctx.subprocess.spawn({
      argv,
      cwd: resolveCwd(args, exec),
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 4 * 1024 * 1024 },
        stderr: { maxBytes: 256 * 1024 },
      },
      graceMs: 5000,
      signal: exec.signal,
    })

    const { exitCode } = await handle.done
    const stdout = textOf(handle.collected.stdout)
    const stderr = textOf(handle.collected.stderr)
    if (exitCode !== 0) {
      const hint = authHint(stderr)
      throw new Error(`agy exited with code ${exitCode}${hint === undefined ? '' : `. ${hint}`}\n${summarise(stderr, 4000)}`)
    }

    let parsed
    try {
      parsed = JSON.parse(stdout)
    } catch {
      // Plain-text output from an older CLI: report the raw answer.
      const plain = summarise(stdout)
      if (plain.length === 0) {
        const hint = authHint(stderr)
        throw new Error(`agy returned an empty answer.${hint === undefined ? ` stderr: ${summarise(stderr, 2000)}` : ` ${hint}`}`)
      }
      return { plain, model, effort }
    }

    if (parsed.status !== undefined && parsed.status !== 'SUCCESS') {
      throw new Error(`agy reported ${parsed.status}: ${summarise(parsed.response ?? stderr, 2000)}`)
    }
    const usage = parsed.usage === undefined ? undefined : JSON.stringify(parsed.usage)
    const structured = parsed.structured_output
    const answer = typeof parsed.response === 'string' ? parsed.response : stdout
    if (structured === undefined) {
      const plain = summarise(answer)
      if (plain.length === 0) {
        const hint = authHint(stderr)
        throw new Error(`agy returned no structured output and an empty answer.${hint === undefined ? '' : ` ${hint}`}`)
      }
      return { plain, model, effort, usage }
    }
    return { structured, plain: summarise(answer), model, effort, usage }
  }

  ctx.tools.register({
    name: 'agy_consult',
    description: 'Ask the local Antigravity CLI (agy) to plan work or to review it in prose. agy explores the repository read-only and returns its plan or critique; DSH carries out every change itself. agy does not see this conversation, so the prompt must be self-contained. For a quality gate on finished work, use agy_review instead.',
    parameters: objectSchema({
      prompt: {
        type: 'string',
        description: 'Self-contained request: the goal, relevant paths, constraints, and the decision needed.',
      },
      mode: {
        type: 'string',
        enum: ['plan', 'review'],
        description: 'plan (default) asks for an implementation plan; review asks for a prose critique. Both run in read-only plan mode.',
      },
      model: {
        type: 'string',
        description: 'agy model id from agy_models. Omit for the configured default.',
      },
      effort: {
        type: 'string',
        enum: AGY_EFFORTS,
        description: 'Reasoning effort for this consultation. Omit for the configured default.',
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
      }, ['text']),
      render: (_args, value) => text(value.text),
    },
    timeoutMs: 60 * 60 * 1000,
    async execute(args, exec) {
      const prompt = args.mode === 'review'
        ? `Review the work described below as a skeptical senior engineer. Report concrete defects, risks and missing tests with file paths and line numbers. Do not modify any file.\n\n${args.prompt}`
        : args.prompt
      const result = await runAgy(args, exec, { mode: args.mode ?? 'plan', prompt })
      return {
        text: result.structured === undefined ? result.plain : `${result.plain}`,
        ...result.model === undefined ? {} : { model: result.model },
        ...result.effort === undefined ? {} : { effort: result.effort },
        ...result.usage === undefined ? {} : { usage: result.usage },
      }
    },
  })

  ctx.tools.register({
    name: 'agy_review',
    description: 'Quality gate on finished work: agy inspects the repository and returns a structured verdict (pass/fail) with concrete findings, ranked by severity. Call it after implementing and verifying, before reporting completion. Blockers and major findings must be fixed or explicitly justified. Read-only: agy never changes files.',
    parameters: objectSchema({
      work: {
        type: 'string',
        description: 'Self-contained description of what was changed: the files, the intent, and how it was verified (test or check output). Include the diff summary.',
      },
      requirements: {
        type: 'string',
        description: 'What the work must satisfy: the user request, acceptance criteria, or the plan agy produced earlier.',
      },
      focus: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional aspects to weigh hardest, such as "correctness", "error handling", "tests", "performance", "security", "API compatibility".',
      },
      model: {
        type: 'string',
        description: 'agy model id from agy_models. Omit for the configured default.',
      },
      effort: {
        type: 'string',
        enum: AGY_EFFORTS,
        description: 'Reasoning effort for this review. Omit for the configured default.',
      },
      cwd: {
        type: 'string',
        description: 'Directory agy explores. Defaults to the session working directory.',
      },
    }, ['work']),
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
        review: { type: 'string' },
      }, ['verdict', 'summary', 'findings', 'review']),
      render: (_args, value) => text(value.review),
    },
    timeoutMs: 60 * 60 * 1000,
    async execute(args, exec) {
      const focus = args.focus === undefined || args.focus.length === 0
        ? 'correctness, error handling, tests, and whether the work actually satisfies the requirement'
        : args.focus.join(', ')
      const prompt = [
        'You are the quality gate for work another engineer just finished. Inspect the repository yourself; do not assume the description is accurate.',
        '',
        `Work claimed: ${args.work}`,
        ...args.requirements === undefined ? [] : ['', `Must satisfy: ${args.requirements}`],
        '',
        `Weigh hardest: ${focus}.`,
        '',
        'Report only defects you can point at: wrong behaviour, missed cases, broken callers, unclear error handling, missing or inadequate tests, and anything that does not meet the requirement. Do not restate the work back.',
        '',
        'Judge the work against the requirement as stated, not against what you would have designed. A limitation the requirement never asked about is at most a minor note; never a blocker or major. When the requirement sets no contract for a case, say the case is uncovered rather than treating your assumed contract as broken.',
        'Blockers and major findings must be things that make the delivered work wrong, unsafe, or incomplete for what was asked.',
        'The verdict is "pass" when nothing at blocker or major severity remains; minor notes and nits may accompany a pass.',
      ].join('\n')

      const result = await runAgy(args, exec, { mode: 'review', schema: REVIEW_SCHEMA, prompt })
      if (result.structured === undefined) {
        // Without a structured answer there is no verdict to trust: report the
        // prose so the caller can judge, and say the gate did not run.
        throw new Error(`agy did not return a structured verdict. Its answer:\n${result.plain}`)
      }

      const structured = result.structured
      const findings = Array.isArray(structured.findings) ? structured.findings : []
      // A fail carrying nothing above minor is a pass with notes: the gate is
      // about blockers and majors, so a nit never holds a finished task back.
      const blocking = findings.some((finding) => finding.severity === 'blocker' || finding.severity === 'major')
      const verdict = blocking ? 'fail' : 'pass'
      const summary = typeof structured.summary === 'string' ? structured.summary : ''
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
        review: renderReview(review),
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
      const executable = await ctx.subprocess.resolveExecutable(command, undefined, exec.signal)
      const handle = ctx.subprocess.spawn({
        argv: [executable, 'models'],
        cwd: homedir(),
        stdio: { stdin: 'ignore', stdout: { maxBytes: 256 * 1024 }, stderr: { maxBytes: 64 * 1024 } },
        graceMs: 3000,
        signal: exec.signal,
      })
      const { exitCode } = await handle.done
      if (exitCode !== 0) {
        throw new Error(`agy models exited with code ${exitCode}: ${summarise(textOf(handle.collected.stderr), 2000)}`)
      }
      const models = textOf(handle.collected.stdout)
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
