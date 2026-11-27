import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AGY_EFFORTS,
  PROMPT_LIMIT_BYTES,
  apply,
  authHint,
  boundedSet,
  clipToUnits,
  isUntrackedNoise,
  parsePorcelainStatus,
  prioritizeAndClipDiff,
  promptUnits,
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

function makeMockCtx({ spawnHandler, liveAgents = [], executors = {} } = {}) {
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
      // A tool with a real side effect runs it here, so middleware that samples
      // the workspace before and after a call sees what a real call would do.
      const sideEffect = executors[name]
      if (sideEffect !== undefined) await sideEffect(args, agent)
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
      // A shell call is only a candidate mutation; what it actually did decides.
      // This executor mimics what `echo 3 > app.js` leaves behind.
      executors: {
        // The mock `edit` tool would otherwise change nothing, leaving no diff
        // for the review to read. Write the file so the review has real input.
        edit: () => writeFileSync(join(dir, 'app.js'), 'export const a = 2\n'),
        bash: (args) => {
          const match = /echo\s+(\S+)\s*>\s*app\.js/.exec(args?.command ?? '')
          if (match !== null) writeFileSync(join(dir, 'app.js'), `export const a = ${match[1]}\n`)
        },
      },
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

    // Real file change via bash IS detected by the before/after fingerprint
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

// --- 0.4.0: shell fingerprinting, prompt budget, cwd containment, epochs ---

test('clipToUnits measures bytes on POSIX and never splits a character', () => {
  const cjk = '中'.repeat(50)
  // 50 CJK chars = 150 UTF-8 bytes; a 90-unit budget keeps 30 of them.
  const clipped = clipToUnits(cjk, 90, '…')
  assert.ok(promptUnits(clipped) <= 90)
  assert.ok(clipped.startsWith('中'))
  for (const char of clipped.replace('…', '')) assert.equal(char, '中')

  // ASCII shorter than the budget passes through untouched.
  assert.equal(clipToUnits('short', 100, '…'), 'short')

  // A budget of zero yields nothing rather than an empty-but-noted string.
  assert.equal(clipToUnits('anything', 0, '…'), '')
})

test('prioritizeAndClipDiff budgets in bytes and still prefers source files', () => {
  const lock = 'diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml\n' + '+x'.repeat(4000) + '\n'
  const src = 'diff --git a/src/app.js b/src/app.js\n' + '+y'.repeat(2000) + '\n'
  const clipped = prioritizeAndClipDiff(`${lock}${src}`, 5000)
  assert.ok(promptUnits(clipped.diff) <= 5000)
  assert.match(clipped.diff, /src\/app\.js/)
})

test('isUntrackedNoise separates editor state from deliverables', () => {
  for (const path of ['.idea/vcs.xml', '.vscode/settings.json', '.openidea/.gitignore', 'node_modules/x/y.js', 'dist/bundle.js', '.DS_Store'])
    assert.equal(isUntrackedNoise(path), true, path)
  for (const path of ['src/app.js', 'docs/DETAIL.md', 'README.md', 'built-in/notes.md'])
    assert.equal(isUntrackedNoise(path), false, path)
})

test('read-only shell does not mark a fresh task dirty, a mutating one does', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-agy-shell-'))
  try {
    execFileSync('git', ['init'], { cwd: dir })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
    writeFileSync(join(dir, 'app.js'), 'export const a = 1\n')
    execFileSync('git', ['add', '.'], { cwd: dir })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: dir })

    const root = makeAgent({ id: 'root-1', depth: 0, cwd: dir })
    const { ctx, sessions, callTool, stopTurn } = makeMockCtx({
      spawnHandler: withRealGit(() => ({ exitCode: 0, stdout: '{}', stderr: '' })),
      executors: {
        bash: (args) => {
          const match = /echo\s+(\S+)\s*>\s*app\.js/.exec(args?.command ?? '')
          if (match !== null) writeFileSync(join(dir, 'app.js'), `export const a = ${match[1]}\n`)
        },
      },
    })
    sessions.set('root-1', root.agent.session)
    apply(ctx, {})

    // First close of a task that only ran a read-only command: no review asked
    // for. This is the case that used to cost a full agy call for nothing.
    await callTool('bash', { command: 'git status' }, root.agent)
    await stopTurn(root.agent, 1)
    assert.equal(root.steered.length, 0)

    // A command that really writes the file does mark it dirty.
    await callTool('bash', { command: 'echo 2 > app.js' }, root.agent)
    await stopTurn(root.agent, 2)
    assert.equal(root.steered.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a read-only shell does not reset a stalled review loop, real work does', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-agy-stall-'))
  try {
    execFileSync('git', ['init'], { cwd: dir })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
    writeFileSync(join(dir, 'app.js'), 'export const a = 1\n')
    execFileSync('git', ['add', '.'], { cwd: dir })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: dir })

    const root = makeAgent({ id: 'root-1', depth: 0, cwd: dir })
    const { ctx, sessions, callTool, stopTurn } = makeMockCtx({
      spawnHandler: withRealGit(() => ({
        exitCode: 0,
        stdout: JSON.stringify({
          status: 'SUCCESS', conversation_id: 'c1', num_turns: 1, response: '',
          structured_output: { verdict: 'fail', summary: 'bad', findings: [{ severity: 'blocker', problem: 'wrong' }] },
        }),
        stderr: '',
      })),
      executors: {
        // The mock tools have no real effect; this one writes the file so the
        // repository actually holds a change for the review to find.
        edit: () => writeFileSync(join(dir, 'app.js'), 'export const a = 42\n'),
        write: () => writeFileSync(join(dir, 'app.js'), 'export const a = 42\n'),
        bash: (args) => {
          const match = /echo\s+(\S+)\s*>\s*app\.js/.exec(args?.command ?? '')
          if (match !== null) writeFileSync(join(dir, 'app.js'), `export const a = ${match[1]}\n`)
        },
      },
    })
    sessions.set('root-1', root.agent.session)
    apply(ctx, { maxReviewRounds: 1 })

    await callTool('edit', { path: 'app.js' }, root.agent)
    await callTool('agy_review', {}, root.agent)
    await stopTurn(root.agent, 1) // steers, then stalls
    const afterStall = root.steered.length
    assert.equal(afterStall, 1)

    // A read-only command while stalled must not re-arm another round.
    await callTool('bash', { command: 'git status' }, root.agent)
    await stopTurn(root.agent, 2)
    assert.equal(root.steered.length, afterStall)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a change during an in-flight review keeps the gate shut', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-agy-epoch-'))
  try {
    execFileSync('git', ['init'], { cwd: dir })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
    writeFileSync(join(dir, 'app.js'), 'export const a = 1\n')
    execFileSync('git', ['add', '.'], { cwd: dir })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: dir })

    const root = makeAgent({ id: 'root-1', depth: 0, cwd: dir })
    let onSpawn
    const { ctx, sessions, callTool, stopTurn } = makeMockCtx({
      spawnHandler: withRealGit(async () => {
        // A parallel edit lands while agy is still reviewing. It goes through
        // the write tool, which is the only thing that can move the gate's
        // epoch — writing the file behind the tool's back would be a change no
        // plugin could see, and so not the case under test.
        if (onSpawn !== undefined) {
          const callback = onSpawn
          onSpawn = undefined
          await callback()
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            status: 'SUCCESS', conversation_id: 'c1', num_turns: 1, response: '',
            structured_output: { verdict: 'pass', summary: 'ok', findings: [] },
          }),
          stderr: '',
        }
      }),
      executors: {
        write: () => writeFileSync(join(dir, 'app.js'), 'export const a = 7\n'),
      },
    })
    sessions.set('root-1', root.agent.session)
    apply(ctx, {})

    await callTool('write', { path: 'app.js' }, root.agent)
    const child = makeAgent({ id: 'child-1', parentSession: 'root-1', depth: 1, cwd: dir })
    sessions.set('child-1', child.agent.session)
    onSpawn = () => callTool('write', { path: 'app.js' }, child.agent)
    const review = await callTool('agy_review', {}, root.agent)
    assert.equal(review.value.verdict, 'pass')

    // The verdict passed, but not for what is on disk now.
    await stopTurn(root.agent, 1)
    assert.equal(root.steered.length, 1)
    assert.match(root.steered[0].content[0].text, /changed while the review was running/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cwd outside the session workspace is refused unless configured', async () => {
  const inside = mkdtempSync(join(tmpdir(), 'dsh-agy-cwd-in-'))
  const outside = mkdtempSync(join(tmpdir(), 'dsh-agy-cwd-out-'))
  try {
    const root = makeAgent({ id: 'root-1', depth: 0, cwd: inside })
    const { ctx, callTool } = makeMockCtx()

    // Default: contained to the session workspace.
    apply(ctx, {})
    await assert.rejects(
      () => callTool('agy_consult', { prompt: 'hi', cwd: outside }, root.agent),
      /outside the session workspace/,
    )

    // The session's own directory is allowed.
    const ok = await callTool('agy_consult', { prompt: 'hi', cwd: inside }, root.agent)
    assert.equal(typeof ok.value.text, 'string')

    // A configured extra root is allowed.
    const second = makeMockCtx()
    apply(second.ctx, { allowedRoots: [outside] })
    const allowed = await second.callTool('agy_consult', { prompt: 'hi', cwd: outside }, root.agent)
    assert.equal(typeof allowed.value.text, 'string')

    // The escape hatch works when the user asks for it.
    const third = makeMockCtx()
    apply(third.ctx, { allowExternalCwd: true })
    const open = await third.callTool('agy_consult', { prompt: 'hi', cwd: outside }, root.agent)
    assert.equal(typeof open.value.text, 'string')
  } finally {
    rmSync(inside, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('a review prompt keeps the rubric and requirement when the diff is huge', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-agy-budget-'))
  try {
    execFileSync('git', ['init'], { cwd: dir })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
    writeFileSync(join(dir, 'app.js'), 'export const a = 1\n')
    execFileSync('git', ['add', '.'], { cwd: dir })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: dir })
    // A change larger than the whole prompt budget, in CJK: three bytes per
    // character, so a character count would badly understate it.
    const chars = Math.ceil((PROMPT_LIMIT_BYTES * 2) / 3)
    writeFileSync(join(dir, 'app.js'), `export const a = '${'中'.repeat(chars)}'\n`)

    const root = makeAgent({ id: 'root-1', depth: 0, cwd: dir })
    let prompt
    const { ctx, sessions, callTool } = makeMockCtx({
      spawnHandler: withRealGit((opts) => {
        prompt = opts.argv[opts.argv.indexOf('--print') + 1]
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            status: 'SUCCESS', conversation_id: 'c1', num_turns: 1, response: '',
            structured_output: { verdict: 'pass', summary: 'ok', findings: [] },
          }),
          stderr: '',
        }
      }),
    })
    sessions.set('root-1', root.agent.session)
    apply(ctx, {})

    await callTool('agy_review', {
      requirements: 'The value must be the string "中" repeated.',
      evidence: 'npm test passed',
    }, root.agent)

    // The point of the reordering: the tail survives even though the diff is
    // clipped, and the argv stays under the platform limit.
    assert.ok(promptUnits(prompt) <= PROMPT_LIMIT_BYTES, `prompt is ${promptUnits(prompt)} units`)
    assert.match(prompt, /Must satisfy: The value must be the string/)
    assert.match(prompt, /How they verified it: npm test passed/)
    assert.match(prompt, /The verdict is "pass" when nothing at blocker or major severity remains/)
    assert.match(prompt, /\[diff truncated|\[file diff truncated/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('editor state does not enter the review diff', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-agy-noise-'))
  try {
    execFileSync('git', ['init'], { cwd: dir })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
    writeFileSync(join(dir, 'app.js'), 'export const a = 1\n')
    execFileSync('git', ['add', '.'], { cwd: dir })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: dir })
    mkdirSync(join(dir, '.idea'), { recursive: true })
    writeFileSync(join(dir, '.idea', 'workspace.xml'), '<project/>\n')
    writeFileSync(join(dir, 'feature.js'), 'export const newFeature = true\n')

    const root = makeAgent({ id: 'root-1', depth: 0, cwd: dir })
    let prompt
    const { ctx, sessions, callTool } = makeMockCtx({
      spawnHandler: withRealGit((opts) => {
        prompt = opts.argv[opts.argv.indexOf('--print') + 1]
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            status: 'SUCCESS', conversation_id: 'c1', num_turns: 1, response: '',
            structured_output: { verdict: 'pass', summary: 'ok', findings: [] },
          }),
          stderr: '',
        }
      }),
    })
    sessions.set('root-1', root.agent.session)
    apply(ctx, {})

    await callTool('agy_review', {}, root.agent)
    assert.match(prompt, /feature\.js/)
    assert.doesNotMatch(prompt, /workspace\.xml/)
    assert.match(prompt, /editor\/tool state skipped/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- the configuration row's pure half ---

test('readTier unwraps volatile references and drops empty choices', async () => {
  const { readTier, createReader, TIERS } = await import('../config-model.js')

  // A volatile field is a stable { get() } reference; the value must be read at
  // call time, not captured, or a page edit never reaches agy.
  let model = 'gemini-4-hydrogen'
  let effort = 'high'
  const live = {
    planModel: { get: () => model },
    planEffort: { get: () => effort },
  }
  assert.deepEqual(readTier(live, 'plan'), { model: 'gemini-4-hydrogen', effort: 'high' })

  // The same object, after an in-place edit: the reader follows it.
  model = 'gemini-4-carbon'
  effort = 'xhigh'
  assert.deepEqual(readTier(live, 'plan'), { model: 'gemini-4-carbon', effort: 'xhigh' })

  // Empty means "CLI default" and must reach agy as no flag at all, not "".
  assert.deepEqual(readTier({ planModel: { get: () => '' }, planEffort: { get: () => '' } }, 'plan'), {})
  // An unknown effort is dropped rather than forwarded to --effort.
  assert.deepEqual(readTier({ planEffort: { get: () => 'turbo' } }, 'plan'), {})
  // A plain (non-volatile) value still works, for a row that is not volatile.
  assert.deepEqual(readTier({ consultModel: 'gemini-3.8-flash' }, 'consult'), { model: 'gemini-3.8-flash' })

  const reader = createReader(live)
  assert.equal(typeof reader('plan'), 'object')
  assert.deepEqual(reader('nonsense'), {})
  assert.deepEqual(reader(undefined), {})
  for (const tier of TIERS) assert.equal(typeof reader(tier), 'object')
})

test('parseModelCatalog reads ids from agy models output', async () => {
  const { parseModelCatalog } = await import('../config-model.js')
  const sample = 'gemini-4-hydrogen-high\tGemini 4 Hydrogen (High)\ngemini-3.8-flash\tFlash\n\ngpt-oss-120b-medium\tOSS\n'
  assert.deepEqual(parseModelCatalog(sample), ['gemini-4-hydrogen-high', 'gemini-3.8-flash', 'gpt-oss-120b-medium'])
  // A signed-out CLI answers on stderr with an empty stdout: no ids, no throw.
  assert.deepEqual(parseModelCatalog(''), [])
  assert.deepEqual(parseModelCatalog(undefined), [])
  // A display name is never mistaken for an id.
  assert.deepEqual(parseModelCatalog('Gemini 4 Hydrogen (High)\n'), [])
})

test('a plugin-page choice reaches the agy argv for every tier', async () => {
  const root = makeAgent({ id: 'root-1', depth: 0 })
  const argvSeen = []
  /** Reply shaped for whichever tool asked, so the review path also completes. */
  const reply = (opts) => {
    const wantsVerdict = opts.argv.includes('--json-schema')
    return {
      status: 'SUCCESS',
      conversation_id: 'c1',
      num_turns: 1,
      response: 'ok',
      ...wantsVerdict ? { structured_output: { verdict: 'pass', summary: 'ok', findings: [] } } : {},
    }
  }
  const ctx = {
    tools: { register: () => {}, guard: () => () => {} },
    subprocess: {
      async resolveExecutable(cmd) { return cmd },
      spawn(opts) {
        argvSeen.push(opts.argv)
        return {
          done: Promise.resolve({ exitCode: 0 }),
          collected: {
            stdout: { readFrom: () => ({ text: JSON.stringify(reply(opts)) }) },
            stderr: { readFrom: () => ({ text: '' }) },
          },
        }
      },
    },
    effect(fn) { return fn() },
    on() { return () => {} },
    get(service) {
      if (service === 'workingDirectory') return { get: () => '/tmp' }
      // The row is mounted and answers for every tier; `consult` is left empty
      // on purpose, to prove an empty choice reaches agy as no flag at all.
      if (service === 'agyModeDefaults') {
        return (tier) => (tier === 'plan'
          ? { present: true, model: 'page-model', effort: 'xhigh' }
          : { present: true })
      }
      return undefined
    },
  }
  apply(ctx, {})

  const tools = new Map()
  // Re-register over the no-op collector to reach the real definitions.
  ctx.tools.register = def => tools.set(def.name, def)
  apply(ctx, {})

  await tools.get('agy_consult').execute({ prompt: 'plan please' }, { agent: root.agent, signal: new AbortController().signal })
  const planArgv = argvSeen.at(-1)
  assert.equal(planArgv[planArgv.indexOf('--model') + 1], 'page-model')
  assert.equal(planArgv[planArgv.indexOf('--effort') + 1], 'xhigh')

  // Consult tier: the page left it empty, so neither flag is passed. This is
  // the case that used to fall back to `low` and defeat "CLI default".
  await tools.get('agy_consult').execute({ prompt: 'quick question', mode: 'quick' }, { agent: root.agent, signal: new AbortController().signal })
  const consultArgv = argvSeen.at(-1)
  assert.equal(consultArgv.includes('--model'), false, 'consult must not send --model')
  assert.equal(consultArgv.includes('--effort'), false, 'consult must not send --effort')

  // Review tier, through the quality gate, with its own structured answer.
  await tools.get('agy_review').execute({ work: 'changed things' }, { agent: root.agent, signal: new AbortController().signal })
  const reviewArgv = argvSeen.at(-1)
  assert.equal(reviewArgv.includes('--model'), false, 'review must not send --model')
})

// --- the configuration row's mount behaviour ---

/**
 * A Cordis-like context that enforces the real `set`/`provide` contract.
 *
 * `set` throwing unless the name was provided is not a detail worth trusting a
 * stub to be lenient about: the shipped 0.4.0 called `set` on an undeclared name
 * and every plugin page failed with `cannot set property "agyModeDefaults"
 * without provide`. This stub reproduces that rule so the bug cannot return.
 */
function makeMountCtx({ settings, subprocess, provided = new Map() } = {}) {
  const cleanups = []
  const services = new Map(provided)
  if (settings !== undefined) services.set('settings', settings)
  if (subprocess !== undefined) services.set('subprocess', subprocess)
  return {
    services,
    cleanups,
    ctx: {
      provide(name, value) {
        if (services.has(name)) throw new Error(`service "${name}" has been registered already`)
        services.set(name, value)
        // Cordis registers the provider's disposer with the fiber, so unloading
        // the row removes the service. The stub does the same, or a test could
        // believe a service was removed when nothing ever removed it.
        const dispose = () => services.delete(name)
        cleanups.push(dispose)
        return dispose
      },
      set(name, value) {
        if (!services.has(name)) throw new Error(`cannot set property "${name}" without provide`)
        services.set(name, value)
        return true
      },
      get(name) { return services.get(name) },
      effect(factory) {
        const cleanup = factory()
        if (typeof cleanup === 'function') cleanups.push(cleanup)
        return cleanup
      },
      inject(deps, callback) { callback(this) },
    },
  }
}

test('the configuration row provides its reader instead of setting it', async () => {
  const { mountConfig, DEFAULTS_SERVICE } = await import('../config-runtime.js')

  const reader = tier => (tier === 'plan' ? { present: true, model: 'from-page' } : { present: true })
  const { ctx, services } = makeMountCtx()
  // No timers in this test: the probe and the poll are replaced by no-ops.
  mountConfig(ctx, {}, {
    reader,
    schedule: () => 0,
    repeat: () => 0,
    cancel: () => {},
  })

  // The preset-child row reads this through `ctx.get`, which needs no inject.
  assert.equal(services.get(DEFAULTS_SERVICE), reader)
  assert.deepEqual(services.get(DEFAULTS_SERVICE)('plan'), { present: true, model: 'from-page' })
})

test('the configuration row publishes the model catalog from agy models', async () => {
  const { mountConfig } = await import('../config-runtime.js')

  const writes = []
  let revision = 1
  const settings = {
    writable: true,
    describe: () => [{ ns: 'agy-planner-config', revision, value: {} }],
    async update(ns, patch) {
      writes.push({ ns, ...patch })
      revision += 1
    },
  }
  const subprocess = {
    async resolveExecutable(cmd) { return cmd },
    spawn(opts) {
      assert.deepEqual(opts.argv.slice(1), ['models'])
      return {
        done: Promise.resolve({ exitCode: 0 }),
        collected: { stdout: { readFrom: () => ({ text: 'gemini-4-hydrogen-high\tHydrogen\nclaude-opus-5-5-high\tOpus\n' }) } },
      }
    },
  }

  const { ctx } = makeMountCtx({ settings, subprocess })
  const runtime = mountConfig(ctx, {}, {
    reader: () => ({}),
    schedule: () => 0,
    repeat: () => 0,
    cancel: () => {},
    now: () => '2026-11-26T00:00:00.000Z',
  })

  assert.equal(await runtime.probeModels(), true)
  const catalog = writes.find(write => write.modelCatalog !== undefined)
  assert.equal(catalog.modelCatalog, 'gemini-4-hydrogen-high\nclaude-opus-5-5-high')
  assert.equal(writes.find(write => write.modelCatalogAt !== undefined)?.modelCatalogAt, '2026-11-26T00:00:00.000Z')
})

test('a missing or signed-out agy leaves the catalog alone instead of throwing', async () => {
  const { mountConfig } = await import('../config-runtime.js')
  const writes = []
  const settings = {
    writable: true,
    describe: () => [{ ns: 'agy-planner-config', revision: 1, value: {} }],
    async update(ns, patch) { writes.push(patch) },
  }
  let mode = 'no-subprocess'
  const subprocess = {
    async resolveExecutable() { if (mode === 'missing-cli') throw new Error('ENOENT'); return 'agy' },
    spawn() {
      return { done: Promise.resolve({ exitCode: 1 }), collected: { stdout: { readFrom: () => ({ text: '' }) } } }
    },
  }

  const first = makeMountCtx({ settings })
  const a = mountConfig(first.ctx, {}, { reader: () => ({}), schedule: () => 0, repeat: () => 0, cancel: () => {} })
  assert.equal(await a.probeModels(), false)

  mode = 'missing-cli'
  const second = makeMountCtx({ settings, subprocess })
  const b = mountConfig(second.ctx, {}, { reader: () => ({}), schedule: () => 0, repeat: () => 0, cancel: () => {} })
  assert.equal(await b.probeModels(), false)

  // A non-zero exit is a signed-out CLI: no ids, and no write attempted.
  mode = 'signed-out'
  const third = makeMountCtx({ settings, subprocess })
  const c = mountConfig(third.ctx, {}, { reader: () => ({}), schedule: () => 0, repeat: () => 0, cancel: () => {} })
  assert.equal(await c.probeModels(), false)
  assert.deepEqual(writes, [])
})

test('unloading the configuration row removes the reader', async () => {
  const { mountConfig, DEFAULTS_SERVICE } = await import('../config-runtime.js')
  const { ctx, services, cleanups } = makeMountCtx()
  mountConfig(ctx, {}, { reader: () => ({}), schedule: () => 0, repeat: () => 0, cancel: () => {} })
  assert.equal(services.has(DEFAULTS_SERVICE), true)
  // Cordis runs every effect's disposer on unload, the provider's included.
  // After that the preset row must find no service rather than a stale reader.
  for (const cleanup of cleanups) cleanup()
  assert.equal(services.has(DEFAULTS_SERVICE), false)
})

test('the configuration row supplies a reader even when the caller passes none', async () => {
  const { mountConfig, DEFAULTS_SERVICE } = await import('../config-runtime.js')
  const { ctx, services } = makeMountCtx()
  // No `reader` option, and a config shaped like the row's volatile fields.
  mountConfig(ctx, { planModel: 'only-model', planEffort: 'medium' }, {
    schedule: () => 0,
    repeat: () => 0,
    cancel: () => {},
  })
  const reader = services.get(DEFAULTS_SERVICE)
  assert.equal(typeof reader, 'function', 'a missing reader must not register undefined')
  assert.deepEqual(reader('plan'), { present: true, model: 'only-model', effort: 'medium' })
})

test('collectDiff skips an untracked symlink instead of quoting its target', async () => {
  // An untracked `leak -> <outside file>` passes a path-prefix check, and both
  // `stat` and `readFile` follow it. Before lstat, the target's bytes were
  // quoted into the diff and sent to agy.
  const dir = mkdtempSync(join(tmpdir(), 'dsh-agy-link-'))
  const outside = mkdtempSync(join(tmpdir(), 'dsh-agy-secret-'))
  try {
    execFileSync('git', ['init'], { cwd: dir })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
    writeFileSync(join(dir, 'base.js'), 'export const base = 1\n')
    execFileSync('git', ['add', '.'], { cwd: dir })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: dir })

    const secret = join(outside, 'credentials')
    writeFileSync(secret, 'AWS_SECRET_ACCESS_KEY=should-never-be-quoted\n')
    symlinkSync(secret, join(dir, 'leak'))

    let lastPrompt = ''
    const root = makeAgent({ id: 'root-1', depth: 0, cwd: dir })
    const { ctx, callTool } = makeMockCtx({
      spawnHandler: withRealGit((opts) => {
        lastPrompt = opts.argv[opts.argv.indexOf('--print') + 1]
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            status: 'SUCCESS',
            conversation_id: 'conv-link',
            num_turns: 1,
            response: '',
            structured_output: { verdict: 'pass', summary: 'ok', findings: [] },
          }),
          stderr: '',
        }
      }),
    })
    apply(ctx)

    await callTool('edit', { path: 'base.js' }, root.agent)
    writeFileSync(join(dir, 'base.js'), 'export const base = 2\n')
    await callTool('agy_review', {}, root.agent)

    // The secret must not appear, and the skip must be visible rather than silent.
    assert.doesNotMatch(lastPrompt, /AWS_SECRET_ACCESS_KEY/)
    assert.match(lastPrompt, /leak \(symlink\)/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('a read-only shell call during a review does not invalidate the pass', async () => {
  // The gate samples a fingerprint only while the task is clean. The old code
  // still paid for a fingerprint after the call and discarded the answer, then
  // fell through to `markDirty`, which bumps the epoch. A `git status` landing
  // while agy_review is in flight therefore made its pass look stale, and the
  // task was steered back to re-review work that had already been approved.
  const dir = mkdtempSync(join(tmpdir(), 'dsh-agy-epoch-'))
  try {
    execFileSync('git', ['init'], { cwd: dir })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
    writeFileSync(join(dir, 'base.js'), 'export const base = 1\n')
    execFileSync('git', ['add', '.'], { cwd: dir })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: dir })

    const root = makeAgent({ id: 'root-1', depth: 0, cwd: dir })
    let releaseReview
    const reviewGate = new Promise(resolve => { releaseReview = resolve })
    let reviewStarted
    const reviewStart = new Promise(resolve => { reviewStarted = resolve })

    const { ctx, callTool, stopTurn } = makeMockCtx({
      spawnHandler: withRealGit((opts) => {
        // Only the review is held open; `git` keeps running normally.
        if (!opts.argv.includes('--json-schema')) {
          return { exitCode: 0, stdout: 'ok', stderr: '' }
        }
        reviewStarted()
        // `spawn` awaits whatever the handler returns, so the review can be held
        // open while another tool call runs.
        return reviewGate.then(() => ({
          exitCode: 0,
          stdout: JSON.stringify({
            status: 'SUCCESS',
            conversation_id: 'conv-r',
            num_turns: 1,
            response: '',
            structured_output: { verdict: 'pass', summary: 'ok', findings: [] },
          }),
          stderr: '',
        }))
      }),
    })
    apply(ctx)

    // Make the task dirty, then review it.
    await callTool('edit', { path: 'base.js' }, root.agent)
    writeFileSync(join(dir, 'base.js'), 'export const base = 2\n')

    const reviewPromise = callTool('agy_review', {}, root.agent)
    await reviewStart
    // A read-only command arrives while the review is in flight.
    await callTool('bash', { command: 'git status --porcelain' }, root.agent)
    releaseReview()

    const res = await reviewPromise
    assert.equal(res.value.verdict, 'pass')

    // The pass must stand: closing the turn must not steer the agent back.
    await stopTurn(root.agent, 1)
    assert.deepEqual(root.steered, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
