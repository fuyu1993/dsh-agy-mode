/*
 * Antigravity planner mode — live configuration row.
 *
 * The five tools this bundle provides live inside the `preset-agy` declaration,
 * so no other agent mode gains them. That placement has one consequence: a
 * preset child row is not a profile patch entry, and the settings service only
 * projects profile patch entries. A configuration inside the preset could
 * therefore never appear on this bundle's page in Plugins.
 *
 * So this second, Host-level row carries the same package's model and effort
 * choices as `volatile` fields, which is what makes them editable in the page
 * without restarting the plugin. It registers no tools and no hooks; it only
 * publishes a reader that `index.js` consults on every call, so an edit takes
 * effect on the next `agy_consult` or `agy_review` rather than the next session.
 *
 * It also runs `agy models` itself and publishes the ids into `modelCatalog`.
 * The browser cannot spawn the CLI, and the tool that can (`agy_models`) lives
 * inside the preset, so the page reads the catalog from this row instead.
 *
 * @module dsh-agy-mode/config
 */

import z from '@deepseek-ai/schemastery'
import { AGY_EFFORTS, TIERS, createReader, parseModelCatalog, unwrap } from './config-model.js'

// Re-exported so the Host row and its tests share one definition.
export { AGY_EFFORTS, TIERS, createReader, parseModelCatalog, readTier } from './config-model.js'

export const name = 'agy-planner-config'

/** Required only to list the models; the row still loads without it. */
export const inject = ['subprocess']

/** Profile entry id; also the settings namespace the page reads. */
const ENTRY_ID = 'agy-planner-config'

/** Deadline for one `agy models` probe. */
const MODEL_PROBE_TIMEOUT_MS = 20_000

/** One settings write recomposes the profile, so retry briefly before giving up. */
const PUBLISH_ATTEMPTS = 4

/** Delay between publish attempts, multiplied by the attempt number. */
const PUBLISH_RETRY_MS = 120

/**
 * How long to wait for the settings service to serve this entry before the
 * first publish attempt. The service projects entries only once the Loader has
 * settled every row, which is after this `apply` returns.
 */
const PUBLISH_DELAY_MS = 400

/**
 * One reasoning effort, plus the empty choice.
 *
 * A `union` of `const` renders as a choice control rather than free text, which
 * keeps a typo out of `agy --effort`. The empty string is a real option — it
 * means "let the CLI decide" — and `readTier` drops it before the call.
 * @param fallback - value used when the row does not set one.
 */
const effort = fallback => z.union([z.const(''), ...AGY_EFFORTS.map(value => z.const(value))])
  .default(fallback)
  .volatile()

/**
 * One model id.
 *
 * Deliberately a plain string rather than a union of known ids: `agy models`
 * answers per account and per CLI version, so a fixed list would go stale and
 * reject a valid id. An empty value means "CLI default". The page offers the
 * live ids from `modelCatalog` while still accepting one that is not listed.
 */
const model = (fallback, tier) => z.string()
  .default(fallback)
  .volatile()
  .description(`${tier} tier model id. Empty uses the CLI default. A suffixed id (…-high) carries its own effort and wins over the effort field.`)

export const Config = z.object({
  planModel: model('gemini-4-hydrogen', 'Planning'),
  planEffort: effort('high'),
  consultModel: model('gemini-3.8-flash', 'Quick-consult'),
  consultEffort: effort('low'),
  reviewModel: model('gemini-4-hydrogen', 'Review'),
  reviewEffort: effort('high'),
  /** Newline-joined ids from the last successful `agy models`; empty until it runs. */
  modelCatalog: z.string().default('').volatile(),
  /** When the catalog was read, so the page can say how fresh it is. */
  modelCatalogAt: z.string().default('').volatile(),
  /** Set by the page's refresh control; any change triggers one probe. */
  modelProbeNonce: z.string().default('').volatile(),
})

/**
 * Mount the configuration row.
 *
 * The reader is installed on the Host context (`ctx.set`) because the
 * preset-child row resolves it through `ctx.get`, and a child realm inherits
 * the Host root's services. No `settings.configure({ auto: false })` is needed:
 * no shipped client builds a form from a schema, so the page is the one this
 * bundle's `client.js` registers into `plugins.bundle.config`.
 *
 * @param ctx - the plugin context.
 * @param config - this row's config.
 */
export function apply(ctx, config = {}) {
  const reader = createReader(config)
  ctx.set('agyModeDefaults', reader)
  ctx.effect(() => () => {
    // Only clear if this row still owns the name (a reloaded row replaces it).
    if (ctx.get('agyModeDefaults') === reader) ctx.set('agyModeDefaults', undefined)
  }, 'agy-mode.defaults')

  /** The settings service, captured from the context that declared it. */
  let settingsService
  ctx.inject(['settings'], (settingsCtx) => {
    settingsService = settingsCtx.get('settings')
  })

  let disposed = false
  ctx.effect(() => () => { disposed = true }, 'agy-mode.dispose')

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

  /**
   * Write one field into this entry.
   *
   * A refused write is retried briefly rather than dropped: the page may have
   * edited the entry between the read and the write, and a silent failure looks
   * exactly like a working control with nothing to show.
   * @param field - config field name.
   * @param value - the string to store.
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
   * Failure is silent by design: the page simply keeps showing no catalog and
   * the user can still type an id, which is the same state a fresh install is
   * in. Raising here would take the whole configuration row down over a
   * convenience control.
   */
  const probeModels = async () => {
    const subprocess = ctx.get('subprocess')
    if (subprocess === undefined) return
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), MODEL_PROBE_TIMEOUT_MS)
    try {
      const executable = await subprocess.resolveExecutable('agy', undefined, controller.signal)
      const handle = subprocess.spawn({
        argv: [executable, 'models'],
        cwd: process.cwd(),
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 256 * 1024 },
          stderr: { maxBytes: 64 * 1024 },
        },
        graceMs: 5000,
        signal: controller.signal,
      })
      const { exitCode } = await handle.done
      if (exitCode !== 0) return
      const models = parseModelCatalog(handle.collected.stdout?.readFrom(0)?.text)
      if (models.length === 0) return
      await publish('modelCatalog', models.join('\n'))
      await publish('modelCatalogAt', new Date().toISOString())
    } catch {
      // A missing or signed-out CLI leaves the catalog empty.
    } finally {
      clearTimeout(timer)
    }
  }

  // One probe per plugin load, so the very first visit to the page already has
  // a catalog. The settings service answers only after the Loader settles, so
  // the first publish attempt has to wait for it.
  const startup = setTimeout(() => { probeModels().catch(() => {}) }, PUBLISH_DELAY_MS)
  ctx.effect(() => () => clearTimeout(startup), 'agy-mode.model-probe')

  // The page's refresh control bumps `modelProbeNonce`; poll the reference for
  // a change, because a volatile field notifies nobody.
  let lastNonce = unwrap(config.modelProbeNonce) ?? ''
  let inflight = false
  const poll = setInterval(async () => {
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
  }, 1000)
  ctx.effect(() => () => clearInterval(poll), 'agy-mode.model-probe-watch')
}
