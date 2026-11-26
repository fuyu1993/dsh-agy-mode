/*
 * Antigravity planner mode — host half.
 *
 * Three tools and one guard that hand judgement to the local Antigravity CLI
 * (`agy`) while the executing work stays with DSH. The preset owns the
 * workflow policy; this plugin owns the transport, its timeout, process
 * teardown, and enforcement of the delegation budget.
 *
 *   agy_consult            one read-only planning or review turn, answer returned
 *   agy_models             the model ids and reasoning efforts this `agy` accepts
 *   agy_delegation_budget  the user's answer on subagents, concurrency and depth
 *
 * Tools are registered as plain definitions with raw JSON Schemas, so the
 * bundle imports nothing from DSH packages and needs no dependency of its own.
 *
 * @module dsh-agy-mode
 */

import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

export const name = 'agy-planner'
// Required services only; `subagents`, `agents`, `workingDirectory` and
// `sessions` are read through ctx.get() so the plugin still loads without them.
export const inject = ['tools', 'subprocess']

/** Reasoning efforts the CLI accepts, in ascending order. */
export const AGY_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

/** Tool names that start delegated work, and so consume the budget. */
const DELEGATION_TOOLS = new Set(['subagent', 'subagent_fork', 'workflow'])

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

export function apply(ctx, config = {}) {
  const command = config.command ?? 'agy'
  const timeoutSeconds = config.timeoutSeconds ?? 900
  const defaultModel = config.defaultModel
  const defaultEffort = config.defaultEffort

  /**
   * The user's delegation answer, keyed by the root Session it belongs to so
   * every descendant inherits one budget. Not durable by design: a new task
   * asks again.
   */
  const budgets = new Map()

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

  ctx.tools.register({
    name: 'agy_consult',
    description: 'Ask the local Antigravity CLI (agy) to plan work or to review finished work. agy explores the repository read-only and returns its plan or critique; DSH carries out every change itself. agy does not see this conversation, so the prompt must be self-contained.',
    parameters: objectSchema({
      prompt: {
        type: 'string',
        description: 'Self-contained request: the goal, relevant paths, constraints, and the decision or review needed.',
      },
      mode: {
        type: 'string',
        enum: ['plan', 'review'],
        description: 'plan (default) asks for an implementation plan; review asks for a critique of existing work. Both run in read-only plan mode.',
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
      const model = args.model ?? defaultModel
      const effort = args.effort ?? defaultEffort
      if (effort !== undefined && !AGY_EFFORTS.includes(effort)) {
        throw new Error(`unknown reasoning effort ${JSON.stringify(effort)}; use one of ${AGY_EFFORTS.join(', ')}`)
      }

      const executable = await ctx.subprocess.resolveExecutable(command, undefined, exec.signal)
      const prompt = args.mode === 'review'
        ? `Review the work described below as a skeptical senior engineer. Report concrete defects, risks and missing tests with file paths and line numbers. Do not modify any file.\n\n${args.prompt}`
        : args.prompt
      const argv = [
        executable,
        '--print', prompt,
        '--dangerously-skip-permissions',
        '--output-format', 'json',
        '--mode', 'plan',
      ]
      if (model !== undefined) argv.push('--model', model)
      if (effort !== undefined) argv.push('--effort', effort)
      if (timeoutSeconds > 0) argv.push('--print-timeout', `${timeoutSeconds}s`)
      // Keep the CLI's own log outside the checkout it is reading.
      argv.push('--log-file', join(tmpdir(), 'dsh-agy-consult.log'))

      const handle = ctx.subprocess.spawn({
        argv,
        cwd: resolveCwd(args, exec),
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 1024 * 1024 },
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

      let answer = stdout
      let usage
      try {
        const parsed = JSON.parse(stdout)
        if (typeof parsed.response === 'string') answer = parsed.response
        if (parsed.usage !== undefined) usage = JSON.stringify(parsed.usage)
        if (parsed.status !== undefined && parsed.status !== 'SUCCESS') {
          throw new Error(`agy reported ${parsed.status}: ${summarise(answer || stderr, 2000)}`)
        }
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error
        // Plain-text output from an older CLI: keep the raw answer.
      }

      const trimmed = summarise(answer)
      if (trimmed.length === 0) {
        const hint = authHint(stderr)
        throw new Error(`agy returned an empty answer.${hint === undefined ? ` stderr: ${summarise(stderr, 2000)}` : ` ${hint}`}`)
      }
      return {
        text: trimmed,
        ...model === undefined ? {} : { model },
        ...effort === undefined ? {} : { effort },
        ...usage === undefined ? {} : { usage },
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
