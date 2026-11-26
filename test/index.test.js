import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AGY_EFFORTS,
  apply,
  authHint,
  boundedSet,
  parsePorcelainStatus,
  prioritizeAndClipDiff,
  reconcileEffort,
  renderReview,
  resolveVerdict,
  summarise,
  transientHint,
} from '../index.js'

function makeAgent({ id = 'root-1', parentSession = undefined, depth = 0, cwd = process.cwd() } = {}) {
  const steered = []
  return {
    steered,
    agent: {
      session: {
        id,
        header: {
          id,
          parentSession,
          delegationDepth: depth,
          cwd,
        },
      },
      steer(msg) {
        steered.push(msg)
      },
    },
  }
}

function makeMockCtx({ spawnHandler, liveAgents = [] } = {}) {
  const tools = new Map()
  const guards = []
  const listeners = new Map()
  const sessions = new Map()
  const spawned = []

  const ctx = {
    tools: {
      register(def) {
        tools.set(def.name, def)
      },
      guard(fn) {
        guards.push(fn)
        return () => {}
      },
    },
    subprocess: {
      async resolveExecutable(cmd) {
        return cmd
      },
      spawn(opts) {
        spawned.push(opts)
        const result = spawnHandler ? spawnHandler(opts, spawned.length - 1) : { exitCode: 0, stdout: '{}', stderr: '' }
        const donePromise = Promise.resolve(result).then((res) => ({
          exitCode: res.exitCode ?? 0,
          stdout: res.stdout ?? '',
          stderr: res.stderr ?? '',
        }))
        let resolved = { exitCode: 0, stdout: '', stderr: '' }
        const wrappedDone = donePromise.then((res) => {
          resolved = res
          return { exitCode: res.exitCode }
        })
        return {
          done: wrappedDone,
          collected: {
            stdout: { readFrom: () => ({ text: resolved.stdout }) },
            stderr: { readFrom: () => ({ text: resolved.stderr }) },
          },
        }
      },
    },
    effect(factory) {
      factory()
    },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(fn)
      return () => {}
    },
    get(service) {
      if (service === 'agents') return { list: () => liveAgents }
      if (service === 'sessions') return sessions
      return undefined
    },
  }

  async function callTool(name, args, agent) {
    const def = tools.get(name)
    const execution = {
      name,
      args,
      agent,
      signal: new AbortController().signal,
    }
    for (const guard of guards) {
      const denied = guard(execution)
      if (denied !== undefined) return { isError: true, denied }
    }
    const executeChain = async () => {
      if (def === undefined) {
        return { isError: false, value: args?.mockResult ?? 'ok' }
      }
      const value = await def.execute(args, { agent, signal: execution.signal })
      return { isError: false, value }
    }
    const toolExecuteListeners = listeners.get('tools/execute') ?? []
    let idx = 0
    const next = async () => {
      if (idx < toolExecuteListeners.length) {
        const fn = toolExecuteListeners[idx++]
        return fn(execution, next)
      }
      return executeChain()
    }
    return next()
  }

  async function stopTurn(agent, turn = 1) {
    for (const fn of listeners.get('agent/turn-stopping') ?? []) {
      await fn({ agent, turn })
    }
  }

  return { ctx, tools, guards, sessions, spawned, callTool, stopTurn }
}

/** Subprocess wrapper that executes real `git` commands when spawned, and mocks `agy`. */
function withRealGit(agyHandler) {
  return (opts, index) => {
    const [cmd, ...rest] = opts.argv
    if (cmd === 'git') {
      try {
        const stdout = execFileSync('git', rest, { cwd: opts.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
        return { exitCode: 0, stdout, stderr: '' }
      } catch (err) {
        return { exitCode: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }
      }
    }
    return agyHandler(opts, index)
  }
}

test('pure helpers: reconcileEffort, resolveVerdict, hints, summarise, boundedSet', () => {
  assert.deepEqual(reconcileEffort('gemini-4-hydrogen', 'high'), { model: 'gemini-4-hydrogen', effort: 'high' })
  assert.deepEqual(reconcileEffort('gemini-4-hydrogen-high', 'low'), { model: 'gemini-4-hydrogen-high', effort: undefined, implied: 'high' })
  assert.deepEqual(reconcileEffort(undefined, 'medium'), { model: undefined, effort: 'medium' })

  assert.equal(resolveVerdict({ verdict: 'pass', findings: [] }), 'pass')
  assert.equal(resolveVerdict({ verdict: 'fail', findings: [{ severity: 'minor', problem: 'nitpick' }] }), 'pass')
  assert.equal(resolveVerdict({ verdict: 'pass', findings: [{ severity: 'major', problem: 'bug' }] }), 'fail')
  assert.equal(resolveVerdict({ verdict: 'fail', findings: [] }), 'fail')

  assert.match(authHint('error: not logged into Antigravity') ?? '', /Sign in/)
  assert.equal(authHint('some other error'), undefined)
  assert.equal(transientHint('HTTP 503 overloaded'), true)
  assert.equal(transientHint('invalid model selection'), false)

  assert.equal(summarise('  hello world  ', 5), 'hello\n…[truncated 6 chars]')

  const map = new Map()
  boundedSet(map, 'a', 1, 2)
  boundedSet(map, 'b', 2, 2)
  boundedSet(map, 'a', 10, 2)
  boundedSet(map, 'c', 3, 2)
  assert.deepEqual([...map.entries()], [['a', 10], ['c', 3]])
})

test('parsePorcelainStatus preserves leading status spaces and extracts untracked files', () => {
  const raw = ' M index.js\nA  staged.js\n?? new dir/file.js\n?? "spaced name.js"\n'
  const parsed = parsePorcelainStatus(raw)
  assert.equal(parsed.files.length, 4)
  assert.deepEqual(parsed.untracked, ['new dir/file.js', 'spaced name.js'])
})

test('prioritizeAndClipDiff keeps source files ahead of lockfiles', () => {
  const lockChunk = 'diff --git a/package-lock.json b/package-lock.json\n' + '+x\n'.repeat(300)
  const srcChunk = 'diff --git a/src/app.js b/src/app.js\n+export const ok = true\n'
  const combined = `${lockChunk}${srcChunk}`
  const clipped = prioritizeAndClipDiff(combined, 600)
  assert.match(clipped.diff, /src\/app\.js/)
  assert.ok(clipped.omittedFiles.includes('package-lock.json'))
})

test('renderReview sorts findings by severity and renders PASS with notes', () => {
  const rendered = renderReview(
    {
      verdict: 'pass',
      summary: 'Looks good overall.',
      findings: [
        { severity: 'nit', problem: 'typo' },
        { severity: 'minor', file: 'a.js', line: 3, problem: 'edge case', fix: 'check null' },
      ],
    },
    { round: 1, scope: 'diff', cost: 'agy so far: 1 call(s), 100 in, 50 out' },
  )
  assert.match(rendered, /^agy review: PASS with notes/)
  assert.ok(rendered.indexOf('[minor]') < rendered.indexOf('[nit]'))
})

test('delegation budget guard enforces all paths', async () => {
  const root = makeAgent({ id: 'root-1', depth: 0 })
  const child = makeAgent({ id: 'child-1', parentSession: 'root-1', depth: 1 })
  const { ctx, sessions, callTool } = makeMockCtx({ liveAgents: [root.agent, child.agent] })
  sessions.set('root-1', root.agent.session)
  sessions.set('child-1', child.agent.session)
  apply(ctx)

  let res = await callTool('subagent', {}, root.agent)
  assert.equal(res.isError, true)
  assert.match(res.denied, /No delegation budget/)

  await callTool('agy_delegation_budget', { allow: true, maxChildren: 1, maxDepth: 1 }, root.agent)
  // 1 child is already live in liveAgents, so root cannot spawn another
  res = await callTool('subagent', {}, root.agent)
  assert.equal(res.isError, true)
  assert.match(res.denied, /1 are running/)

  // Child at depth 1 cannot spawn depth 2 when maxDepth is 1
  res = await callTool('subagent', {}, child.agent)
  assert.equal(res.isError, true)
  assert.match(res.denied, /1 delegation level/)

  // Allow 2 children -> root passes
  await callTool('agy_delegation_budget', { allow: true, maxChildren: 2, maxDepth: 1 }, root.agent)
  res = await callTool('subagent', {}, root.agent)
  assert.equal(res.isError, false)

  // Disable delegation
  await callTool('agy_delegation_budget', { allow: false, maxChildren: 2, maxDepth: 2 }, root.agent)
  res = await callTool('workflow', {}, root.agent)
  assert.equal(res.isError, true)
  assert.match(res.denied, /no subagents/)
})

test('agy_routes persists task routes across subagents and tiers', async () => {
  const root = makeAgent({ id: 'root-1', depth: 0 })
  const child = makeAgent({ id: 'child-1', parentSession: 'root-1', depth: 1 })
  const { ctx, sessions, spawned, callTool } = makeMockCtx({
    spawnHandler: () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        status: 'SUCCESS',
        conversation_id: 'conv-1',
        num_turns: 1,
        response: 'plan text',
        usage: { input_tokens: 1200, cache_read_tokens: 300, output_tokens: 200, thinking_tokens: 500 },
      }),
      stderr: '',
    }),
  })
  sessions.set('root-1', root.agent.session)
  sessions.set('child-1', child.agent.session)
  apply(ctx, {
    planModel: 'gemini-4-hydrogen',
    planEffort: 'high',
    consultModel: 'gemini-3.8-flash',
    consultEffort: 'low',
    reviewModel: 'gemini-4-hydrogen',
    reviewEffort: 'high',
    extraArgs: ['--disable-slash-commands'],
  })

  await callTool('agy_routes', { planModel: 'gemini-4-hydrogen', planEffort: 'xhigh' }, root.agent)
  const consultRes = await callTool('agy_consult', { prompt: 'do plan' }, child.agent)
  assert.equal(consultRes.isError, false)
  assert.match(consultRes.value.cost, /500 thinking/)

  const planArgv = spawned[0].argv
  assert.equal(planArgv[planArgv.indexOf('--model') + 1], 'gemini-4-hydrogen')
  assert.equal(planArgv[planArgv.indexOf('--effort') + 1], 'xhigh')
  assert.ok(planArgv.includes('--disable-slash-commands'))

  // Quick consult keeps cheap tier unless explicitly overridden
  await callTool('agy_consult', { prompt: 'quick check', mode: 'quick' }, child.agent)
  const quickArgv = spawned[1].argv
  assert.equal(quickArgv[quickArgv.indexOf('--model') + 1], 'gemini-3.8-flash')
  assert.equal(quickArgv[quickArgv.indexOf('--effort') + 1], 'low')
  assert.equal(quickArgv[quickArgv.indexOf('--conversation') + 1], 'conv-1')
})

test('review gate: subagent edits mark root dirty, empty fail locks gate, and edits reset stalled', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-agy-gate-'))
  try {
    execFileSync('git', ['init'], { cwd: dir })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
    writeFileSync(join(dir, 'app.js'), 'export const a = 1\n')
    execFileSync('git', ['add', '.'], { cwd: dir })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: dir })

    let reviewOutcome = { verdict: 'fail', summary: 'bad', findings: [] }
    const root = makeAgent({ id: 'root-1', depth: 0, cwd: dir })
    const child = makeAgent({ id: 'child-1', parentSession: 'root-1', depth: 1, cwd: dir })
    const { ctx, sessions, callTool, stopTurn } = makeMockCtx({
      spawnHandler: withRealGit(() => ({
        exitCode: 0,
        stdout: JSON.stringify({
          status: 'SUCCESS',
          conversation_id: 'conv-r',
          num_turns: 1,
          response: '',
          structured_output: reviewOutcome,
        }),
        stderr: '',
      })),
    })
    sessions.set('root-1', root.agent.session)
    sessions.set('child-1', child.agent.session)
    apply(ctx, { maxReviewRounds: 2 })

    // Clean stop -> no steer
    await stopTurn(root.agent, 1)
    assert.equal(root.steered.length, 0)

    // Subagent mutates a file -> root gate becomes dirty
    writeFileSync(join(dir, 'app.js'), 'export const a = 2\n')
    await callTool('write', { path: 'app.js' }, child.agent)
    await stopTurn(root.agent, 2)
    assert.equal(root.steered.length, 1)
    assert.match(root.steered[0].content[0].text, /agy_review/)

    // Empty fail keeps the gate locked (round 1)
    const rev1 = await callTool('agy_review', {}, root.agent)
    assert.equal(rev1.value.verdict, 'fail')
    await stopTurn(root.agent, 3)
    assert.equal(root.steered.length, 2)
    assert.match(root.steered[1].content[0].text, /agy still rejects/)

    // Round 2 fail hits maxReviewRounds -> stalls after steering once
    await callTool('agy_review', {}, root.agent)
    await stopTurn(root.agent, 4)
    assert.equal(root.steered.length, 3)
    assert.match(root.steered[2].content[0].text, /Stop looping/)
    await stopTurn(root.agent, 5)
    assert.equal(root.steered.length, 3) // stalled, no extra steer

    // New edit re-arms the gate after stalling
    await callTool('edit', { path: 'app.js' }, root.agent)
    await stopTurn(root.agent, 6)
    assert.equal(root.steered.length, 4)

    // Passing review clears gate; subsequent read-only bash does not trigger re-review
    reviewOutcome = { verdict: 'pass', summary: 'ok', findings: [] }
    const revPass = await callTool('agy_review', {}, root.agent)
    assert.equal(revPass.value.verdict, 'pass')
    await callTool('bash', { command: 'git status' }, root.agent)
    await stopTurn(root.agent, 7)
    assert.equal(root.steered.length, 4) // unchanged repo -> no spurious steer

    // Real file change via bash IS detected by fingerprint check
    writeFileSync(join(dir, 'app.js'), 'export const a = 3\n')
    await callTool('bash', { command: 'echo 3 > app.js' }, root.agent)
    await stopTurn(root.agent, 8)
    assert.equal(root.steered.length, 5)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('collectDiff includes untracked files, skips binaries, and captures mid-task commits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-agy-diff-'))
  try {
    execFileSync('git', ['init'], { cwd: dir })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
    writeFileSync(join(dir, 'base.js'), 'export const base = 1\n')
    execFileSync('git', ['add', '.'], { cwd: dir })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: dir })

    let lastPrompt = ''
    const root = makeAgent({ id: 'root-1', depth: 0, cwd: dir })
    const { ctx, callTool } = makeMockCtx({
      spawnHandler: withRealGit((opts) => {
        lastPrompt = opts.argv[opts.argv.indexOf('--print') + 1]
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            status: 'SUCCESS',
            conversation_id: 'conv-d',
            num_turns: 1,
            response: '',
            structured_output: { verdict: 'pass', summary: 'ok', findings: [] },
          }),
          stderr: '',
        }
      }),
    })
    apply(ctx)

    // Trigger an initial mutating call so baseHead captures the starting commit,
    // then commit inside a simulated bash turn + create untracked text & binary files.
    mkdirSync(join(dir, 'sub'))
    await callTool('edit', { path: 'base.js' }, root.agent)
    writeFileSync(join(dir, 'base.js'), 'export const base = 2\n')
    execFileSync('git', ['add', 'base.js'], { cwd: dir })
    execFileSync('git', ['commit', '-m', 'update base'], { cwd: dir })
    await callTool('bash', { command: 'git commit' }, root.agent)

    writeFileSync(join(dir, 'sub', 'fresh.js'), 'export const fresh = 42\n')
    writeFileSync(join(dir, 'sub', 'bin.dat'), Buffer.from([0, 1, 2, 3]))

    const res = await callTool('agy_review', {}, root.agent)
    assert.equal(res.value.scope, 'diff')
    assert.match(lastPrompt, /export const base = 2/)
    assert.match(lastPrompt, /update base/)
    assert.match(lastPrompt, /export const fresh = 42/)
    assert.match(lastPrompt, /sub\/bin\.dat \(binary\)/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runAgy serializes concurrent calls, recovers stale conversations, and retries transient errors', async () => {
  const root = makeAgent({ id: 'root-1', depth: 0 })
  let callNum = 0
  let active = 0
  let maxActive = 0

  const ctx = {
    tools: { register: () => {}, guard: () => () => {} },
    subprocess: {
      async resolveExecutable(cmd) { return cmd },
      spawn(opts) {
        callNum += 1
        const myCall = callNum
        active += 1
        maxActive = Math.max(maxActive, active)
        const p = (async () => {
          await new Promise(r => setTimeout(r, 15))
          active -= 1
          // Call 1 succeeds with conv-1
          if (myCall === 1) {
            return { exitCode: 0, stdout: JSON.stringify({ status: 'SUCCESS', conversation_id: 'conv-1', num_turns: 1, response: 'first' }), stderr: '' }
          }
          // Call 2 tries to resume conv-1 -> fail stale resume
          if (myCall === 2) {
            return { exitCode: 1, stdout: '', stderr: 'conversation not found' }
          }
          // Call 3 is cold retry -> transient 503
          if (myCall === 3) {
            return { exitCode: 1, stdout: '', stderr: 'HTTP 503 temporarily unavailable' }
          }
          // Call 4 succeeds
          return { exitCode: 0, stdout: JSON.stringify({ status: 'SUCCESS', conversation_id: 'conv-2', num_turns: 1, response: 'second' }), stderr: '' }
        })()
        let out = { exitCode: 0, stdout: '', stderr: '' }
        return {
          done: p.then(r => { out = r; return { exitCode: r.exitCode } }),
          collected: {
            stdout: { readFrom: () => ({ text: out.stdout }) },
            stderr: { readFrom: () => ({ text: out.stderr }) },
          },
        }
      },
    },
    effect: (fn) => fn(),
    on: () => () => {},
    get: () => undefined,
  }

  const tools = new Map()
  ctx.tools.register = (def) => tools.set(def.name, def)
  apply(ctx, { retries: 1 })

  const consult = tools.get('agy_consult')
  const exec = { agent: root.agent, signal: new AbortController().signal }
  const [r1, r2] = await Promise.all([
    consult.execute({ prompt: 'p1' }, exec),
    consult.execute({ prompt: 'p2' }, exec),
  ])

  assert.equal(maxActive, 1)
  assert.equal(r1.text, 'first')
  assert.equal(r2.text, 'second')
  assert.equal(callNum, 4)
})

test('agy_models surfaces authHint on failure and returns defaults', async () => {
  const root = makeAgent({ id: 'root-1', depth: 0 })
  let fail = true
  const { ctx, callTool } = makeMockCtx({
    spawnHandler: () => fail
      ? { exitCode: 1, stdout: '', stderr: 'not logged into Antigravity' }
      : { exitCode: 0, stdout: 'gemini-4-hydrogen\tGemini 4\ngemini-3.8-flash\tFlash\n', stderr: '' },
  })
  apply(ctx, { planModel: 'gemini-4-hydrogen', planEffort: 'high' })

  await assert.rejects(() => callTool('agy_models', {}, root.agent), /Sign in once/)
  fail = false
  const res = await callTool('agy_models', {}, root.agent)
  assert.deepEqual(res.value.models, ['gemini-4-hydrogen', 'gemini-3.8-flash'])
  assert.deepEqual(res.value.efforts, AGY_EFFORTS)
  assert.match(res.value.defaults.plan, /gemini-4-hydrogen \/ high/)
})
