/*
 * Antigravity planner mode — the pure half of the configuration row.
 *
 * Kept apart from `config.js` so it can be tested without a DSH installation:
 * `config.js` imports `@deepseek-ai/schemastery`, which resolves from a profile
 * but not from this checkout, and a test that needs the schema would only run
 * where the plugin happens to be installed.
 *
 * Everything here is data in, data out. No services, no filesystem.
 *
 * @module dsh-agy-mode/config-model
 */

/** Reasoning efforts the CLI accepts, in ascending order. */
export const AGY_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

/** The tier names this row configures, in the order the form shows them. */
export const TIERS = ['plan', 'consult', 'review']

/**
 * Unwrap one volatile reference, tolerating a plain value.
 *
 * A volatile field is a stable `{ get() }` reference that the Loader updates in
 * place when the page saves. Reading it at `apply()` time would freeze whatever
 * was there at activation, which is exactly the value the page is meant to
 * change — so every read goes through here, at call time.
 * @param value - a volatile reference, or a plain value.
 */
export const unwrap = value => (value !== undefined && value !== null && typeof value.get === 'function' ? value.get() : value)

/**
 * Publish the current choices for one tier.
 *
 * An empty model or an effort outside `AGY_EFFORTS` is dropped rather than
 * forwarded: that is what makes the "CLI default" choice in the form mean
 * "send no flag", instead of sending `--model ""`.
 *
 * @param config - this row's config, whose fields may be volatile references.
 * @param tier - `plan`, `consult` or `review`.
 * @returns the model and effort to use, with unset fields omitted.
 */
export function readTier(config, tier) {
  const modelValue = unwrap(config?.[`${tier}Model`])
  const effortValue = unwrap(config?.[`${tier}Effort`])
  return {
    ...typeof modelValue === 'string' && modelValue.length > 0 ? { model: modelValue } : {},
    ...typeof effortValue === 'string' && AGY_EFFORTS.includes(effortValue) ? { effort: effortValue } : {},
  }
}

/**
 * The value published on the Host context as `agyModeDefaults`.
 *
 * The answer carries `present: true` so the caller can tell "the page says this
 * tier is unset, use the CLI default" from "this row is not mounted at all".
 * Without that distinction a cleared field silently fell back to the row's own
 * default, which is exactly what the user was trying to clear.
 * @param config - this row's config.
 * @returns a function returning one tier's live choices.
 */
export function createReader(config) {
  return function agyModeDefaults(tier) {
    if (typeof tier !== 'string' || !TIERS.includes(tier)) return {}
    return { present: true, ...readTier(config, tier) }
  }
}

/**
 * Parse one `agy models` answer into ids.
 *
 * The CLI prints `id<TAB>Display name` per line, and a signed-out run answers on
 * stderr with nothing on stdout, so an empty result is a normal outcome rather
 * than an error to raise.
 * @param stdout - raw command output.
 */
export function parseModelCatalog(stdout) {
  return String(stdout ?? '')
    .split(/\r?\n/)
    .map(line => line.split('\t')[0].trim())
    .filter(line => line.length > 0 && !/\s/.test(line))
}
