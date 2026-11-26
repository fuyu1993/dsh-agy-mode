/*
 * Antigravity planner mode — the configuration row's runtime behaviour.
 *
 * Kept apart from `config.js` for the same reason `config-model.js` is: that
 * file imports `@deepseek-ai/schemastery`, which resolves from a profile but not
 * from this checkout, so anything living there is invisible to `npm test`. The
 * `ctx.provide` bug below shipped precisely because the mount code had no test
 * that could reach it.
 *
 * Nothing here imports a DSH package. Services are read through the context
 * object it is handed, so a test can pass a plain stand-in.
 *
 * @module dsh-agy-mode/config-runtime
 */

import { parseModelCatalog, unwrap } from './config-model.js'

/** Profile entry id; also the settings namespace the page reads. */
export const ENTRY_ID = 'agy-planner-config'

/** The service name the preset-child row resolves with `ctx.get`. */
export const DEFAULTS_SERVICE = 'agyModeDefaults'

/** Deadline for one `agy models` probe. */
const MODEL_PROBE_TIMEOUT_MS = 20_000

/** One settings write recomposes the profile, so retry briefly before giving up. */
const PUBLISH_ATTEMPTS = 4

/** Delay between publish attempts, multiplied by the attempt number. */
const PUBLISH_RETRY_MS = 120

/**
 * How long to wait for the settings service to serve this entry before the
 * first write. The service projects entries only once the Loader has settled
 * every row, which is after this mount returns.
 */
const PUBLISH_DELAY_MS = 400

/** How often to look for a changed refresh request from the page. */
const NONCE_POLL_MS = 1000

/**
 * Mount the configuration row's behaviour.
 *
 * The reader is published with `ctx.provide`, not `ctx.set`: Cordis only lets a
 * fiber assign a name it has declared, and `set` throws
 * `cannot set property "agyModeDefaults" without provide` otherwise. `provide`
 * also registers its own disposer, so unloading the row removes the service.
 *
 * @param ctx - a Cordis-like context: `provide`, `get`, `effect`, `inject`.
 * @param config - this row's config, whose fields may be volatile references.
 * @param options - timing overrides, so a test does not wait on real delays.
 */
export function mountConfig(ctx, config = {}, options = {}) {
  const publishDelayMs = options.publishDelayMs ?? PUBLISH_DELAY_MS
  const pollMs = options.pollMs ?? NONCE_POLL_MS
  const probeTimeoutMs = options.probeTimeoutMs ?? MODEL_PROBE_TIMEOUT_MS
  const now = options.now ?? (() => new Date().toISOString())
  /** Injected so a test can await the startup probe instead of racing a timer. */
  const schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms))
  const repeat = options.repeat ?? ((fn, ms) => setInterval(fn, ms))
  const cancel = options.cancel ?? (handle => (typeof handle === 'number' ? clearTimeout(handle) : clearInterval(handle)))

  let disposed = false
  const track = (fn, label) => {
    // Registered as an effect so Cordis disposes it with the row; the tests
    // pass an `effect` that simply runs the factory.
    ctx.effect(() => {
      const dispose = fn()
      return () => {
        disposed = true
        if (typeof dispose === 'function') dispose()
      }
    }, label)
  }

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

  /** The settings service, captured from the context that declared it. */
  let settingsService
  ctx.inject(['settings'], (settingsCtx) => {
    settingsService = settingsCtx.get('settings')
  })

  /**
   * Write one field into this entry.
   *
   * A refused write is retried briefly rather than dropped: the page may have
   * edited the entry between the read and the write, and a silent failure looks
   * exactly like a working control with nothing to show.
   * @param field - config field name.
   * @param value - the string to store.
   * @returns whether the entry now carries the value.
   */
  const publish = async (field, value) => {
    for (let attempt = 0; attempt < PUBLISH_ATTEMPTS; attempt += 1) {
      if (disposed) return false
      const settings = settingsService ?? ctx.get('settings')
      if (settings === undefined || typeof settings.update !== 'function'
        || typeof settings.describe !== 'function' || settings.writable !== true) {
        await sleep(PUBLISH_RETRY_MS * (attempt + 1))
        continue
      }
      let row
      try {
        row = settings.describe().find(candidate => candidate.ns === ENTRY_ID)
      } catch {
        await sleep(PUBLISH_RETRY_MS * (attempt + 1))
        continue
      }
      if (row === undefined) {
        await sleep(PUBLISH_RETRY_MS * (attempt + 1))
        continue
      }
      if (row.value !== undefined && row.value[field] === value) return true
      try {
        await settings.update(ENTRY_ID, { [field]: value }, row.revision)
        return true
      } catch {
        await sleep(PUBLISH_RETRY_MS * (attempt + 1))
      }
    }
    return false
  }

  /**
   * Run `agy models` once and store the ids.
   *
   * Failure is silent by design: the page keeps showing no catalog and the user
   * can still type an id, which is the state a fresh install is in. Raising here
   * would take the whole configuration row down over a convenience control.
   */
  const probeModels = async () => {
    const subprocess = ctx.get('subprocess')
    if (subprocess === undefined) return false
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), probeTimeoutMs)
    try {
      const executable = await subprocess.resolveExecutable('agy', undefined, controller.signal)
      const handle = subprocess.spawn({
        argv: [executable, 'models'],
        cwd: options.cwd ?? process.cwd(),
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 256 * 1024 },
          stderr: { maxBytes: 64 * 1024 },
        },
        graceMs: 5000,
        signal: controller.signal,
      })
      const { exitCode } = await handle.done
      if (exitCode !== 0) return false
      const models = parseModelCatalog(handle.collected?.stdout?.readFrom(0)?.text)
      if (models.length === 0) return false
      const okCatalog = await publish('modelCatalog', models.join('\n'))
      const okAt = await publish('modelCatalogAt', now())
      return okCatalog && okAt
    } catch {
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  // Resolve the service before any probe can run, so a reader is available even
  // if the CLI is missing.
  ctx.provide(DEFAULTS_SERVICE, options.reader)

  // One probe per mount, so the first visit to the page already has a catalog.
  // The settings service answers only after the Loader settles, so the first
  // write has to wait for it.
  let startup
  track(() => {
    startup = schedule(() => { probeModels().catch(() => {}) }, publishDelayMs)
    return () => cancel(startup)
  }, 'agy-mode.model-probe')

  // The page's refresh control bumps `modelProbeNonce`; poll the reference for a
  // change, because a volatile field notifies nobody.
  let lastNonce = unwrap(config.modelProbeNonce) ?? ''
  let inflight = false
  let poll
  track(() => {
    poll = repeat(async () => {
      if (disposed || inflight) return
      const nonce = unwrap(config.modelProbeNonce) ?? ''
      if (nonce === lastNonce) return
      lastNonce = nonce
      inflight = true
      try {
        await probeModels()
      } finally {
        inflight = false
      }
    }, pollMs)
    return () => cancel(poll)
  }, 'agy-mode.model-probe-watch')

  // Exposed so a test can drive one probe without waiting on a timer.
  return { probeModels, publish }
}
