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
 * Everything testable lives in `config-model.js` (pure helpers) and
 * `config-runtime.js` (mount behaviour); this file is the schema plus the call
 * that connects them. The split is not cosmetic: a row whose mount code cannot
 * be reached by `npm test` is a row that ships bugs.
 *
 * @module dsh-agy-mode/config
 */

import z from '@deepseek-ai/schemastery'
import { AGY_EFFORTS, createReader } from './config-model.js'
import { mountConfig } from './config-runtime.js'

// Re-exported so the Host row and its tests share one definition.
export { AGY_EFFORTS, TIERS, createReader, parseModelCatalog, readTier } from './config-model.js'

export const name = 'agy-planner-config'

/** Required only to list the models; the row still loads without it. */
export const inject = ['subprocess']

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
 * @param ctx - the plugin context.
 * @param config - this row's config.
 */
export function apply(ctx, config = {}) {
  mountConfig(ctx, config, { reader: createReader(config) })
}
