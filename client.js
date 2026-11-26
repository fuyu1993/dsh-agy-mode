window.__ModuleLoader__.load({
  id: 'dsh-agy-mode',
  factory: (require) => {
    /**
     * Antigravity planner mode — browser half.
     *
     * One surface: the model and reasoning-effort card on this bundle's page in
     * Plugins. The tool half of this plugin lives inside the agent preset and
     * has no UI; the values edited here reach it through the Host row
     * `agy-planner-config`, which republishes them for the preset row to read on
     * the next call.
     *
     * Plain JavaScript on purpose: nothing from a Harness Client package is
     * imported, every colour is a `--dsw-alias-*` token with a `light-dark`
     * fallback so a renamed token still renders, and the only stylesheet is a
     * component-owned <style> element under this plugin's `agy-` prefix.
     */

    const React = require('react')
    const h = React.createElement
    const { useState, useCallback, useSyncExternalStore } = React

    /** Profile entry id of the Host configuration row; also the settings namespace. */
    const ENTRY_ID = 'agy-planner-config'
    /** Locale namespace, matching what `ctx.locale.register` below declares. */
    const NS = 'agyMode'

    /** Reasoning efforts `agy` accepts, in the order the CLI documents them. */
    const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

    /** The three cost tiers this configuration sets, with their field prefixes. */
    const TIERS = [
      { id: 'plan', labelKey: 'tierPlan', hintKey: 'tierPlanHint' },
      { id: 'consult', labelKey: 'tierConsult', hintKey: 'tierConsultHint' },
      { id: 'review', labelKey: 'tierReview', hintKey: 'tierReviewHint' },
    ]

    const zh = {
      title: 'agy 模型与思考强度',
      description: '规划、快问、审核三档分别使用哪个 agy 模型和多高的思考强度。保存后下一次 agy 调用即生效，不必新建任务。',
      tierPlan: '规划档',
      tierPlanHint: 'agy_consult 默认走这一档：出实现方案。',
      tierConsult: '快问档',
      tierConsultHint: 'agy_consult 传 mode: "quick" 时走这一档，用于一句话就能答完的问题。',
      tierReview: '审核档',
      tierReviewHint: 'agy_review 质量闸门走这一档。',
      model: '模型',
      effort: '思考强度',
      modelPlaceholder: '留空 = 用 CLI 默认模型',
      effortDefault: 'CLI 默认',
      modelHint: '模型 id 以强度结尾（如 -high）时会自带强度，此时强度选项不生效。留空两项即交给 CLI 决定。',
      listModels: '重新读取本机模型',
      modelsTitle: '本机 agy 可用模型（点一下填入）',
      modelsEmpty: '还没读到模型列表，点「重新读取」再试；agy 未安装或未登录时会读不到。',
      catalogAt: '读取于',
      noForm: '配置服务未就绪，此页面暂时无法编辑。',
      readonly: '当前配置不可写。',
      saving: '保存中…',
      saved: '已保存',
      saveFailed: '保存失败，请重试。',
    }

    const en = {
      title: 'agy model and reasoning effort',
      description: 'Which agy model and how much reasoning each of the three tiers uses. A save applies to the next agy call; no new task needed.',
      tierPlan: 'Planning',
      tierPlanHint: 'The tier agy_consult uses by default, to produce an implementation plan.',
      tierConsult: 'Quick consult',
      tierConsultHint: 'The tier agy_consult uses with mode: "quick", for a question with a short answer.',
      tierReview: 'Review',
      tierReviewHint: 'The tier the agy_review quality gate uses.',
      model: 'Model',
      effort: 'Reasoning effort',
      modelPlaceholder: 'Blank uses the CLI default model',
      effortDefault: 'CLI default',
      modelHint: 'A model id ending in an effort (such as -high) carries its own, and the effort choice stops applying. Leaving both blank lets the CLI decide.',
      listModels: 'Read the model list again',
      modelsTitle: 'agy models on this machine (click to fill in)',
      modelsEmpty: 'No model list yet. Press the button again; an uninstalled or signed-out agy cannot be read.',
      catalogAt: 'read at',
      noForm: 'The configuration service is not ready, so this page cannot be edited right now.',
      readonly: 'This configuration is not writable.',
      saving: 'Saving…',
      saved: 'Saved',
      saveFailed: 'The save did not land. Try again.',
    }

    const CSS = `
.agy-card{display:flex;flex-direction:column;gap:14px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary,light-dark(#0f1115,#f9fafb))}
.agy-head{display:flex;flex-direction:column;gap:2px}
.agy-title{font-size:13px;font-weight:600}
.agy-desc{font-size:12px;color:var(--dsw-alias-label-secondary,light-dark(#5c6270,#a8aebc))}
.agy-tier{display:flex;flex-direction:column;gap:8px;padding:12px;border:1px solid var(--dsw-alias-border-secondary,light-dark(#e3e6ec,#2c313c));border-radius:10px;background:var(--dsw-alias-bg-layer-2,light-dark(#f7f8fa,#1a1e26))}
.agy-row{display:flex;align-items:center;gap:8px}
.agy-row-label{flex:0 0 auto;min-width:64px;font-size:12px;color:var(--dsw-alias-label-secondary,light-dark(#5c6270,#a8aebc))}
.agy-field{display:flex;flex-direction:column;gap:4px;flex:1 1 auto;min-width:0}
.agy-input,.agy-select{box-sizing:border-box;width:100%;height:28px;padding:0 8px;border:1px solid var(--dsw-alias-border-primary,light-dark(#d7dbe3,#353b48));border-radius:6px;background:var(--dsw-alias-bg-layer-1,light-dark(#ffffff,#12151b));color:inherit;font:inherit}
.agy-input:focus-visible,.agy-select:focus-visible,.agy-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#247bbf);outline-offset:1px}
.agy-input:disabled,.agy-select:disabled{opacity:.6;cursor:not-allowed}
.agy-hint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,light-dark(#7b8291,#8f96a5))}
.agy-btn{display:inline-flex;align-items:center;height:26px;padding:0 10px;border:1px solid var(--dsw-alias-border-primary,light-dark(#d7dbe3,#353b48));border-radius:6px;background:var(--dsw-alias-bg-layer-1,light-dark(#ffffff,#12151b));color:inherit;font:inherit;font-size:12px;cursor:pointer}
.agy-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-3,light-dark(#eef1f6,#21262f))}
.agy-btn:disabled{opacity:.55;cursor:not-allowed}
.agy-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.agy-note{font-size:12px}
.agy-note-ok{color:var(--dsw-alias-state-success-primary,light-dark(#1a7f5a,#4cc38a))}
.agy-note-err{color:var(--dsw-alias-state-error-primary,light-dark(#c02b45,#ef6b7e))}
.agy-models{margin:0;padding:8px 10px;max-height:150px;overflow:auto;border:1px solid var(--dsw-alias-border-secondary,light-dark(#e3e6ec,#2c313c));border-radius:8px;background:var(--dsw-alias-bg-layer-1,light-dark(#ffffff,#12151b));font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:17px;white-space:pre-wrap;word-break:break-word}
`

    /**
     * Subscribe one component to the entry's config form.
     * @param form - the configForms entry, or undefined while unavailable.
     */
    function useForm(form) {
      const subscribe = useCallback((notify) => (form === undefined ? () => {} : form.subscribe(notify)), [form])
      const snapshot = useCallback(() => (form === undefined ? undefined : form.getSnapshot()), [form])
      return useSyncExternalStore(subscribe, snapshot, snapshot)
    }

    /**
     * One tier's two controls.
     *
     * The model box is a free-text input with a `datalist`, not a `select`:
     * `agy models` answers per account and per CLI version, so a closed list
     * would reject an id the CLI accepts. The datalist offers the ids this row
     * actually read from the machine while still accepting a typed one.
     *
     * An empty model or the empty effort option means "let the CLI decide";
     * that is stored as an empty string rather than unset, because unsetting
     * reverts the field to the row's configured default instead.
     */
    function TierFields({ tier, t, value, catalog, writable, save }) {
      const [draft, setDraft] = useState(undefined)
      const current = value?.[`${tier.id}Model`]
      const shown = draft ?? (typeof current === 'string' ? current : '')
      const effortValue = value?.[`${tier.id}Effort`]
      const listId = `agy-models-${tier.id}`

      const commitModel = async () => {
        if (draft === undefined || draft === (current ?? '')) return
        setDraft(undefined)
        // Stored as-is, including the empty string: that is the "CLI default"
        // choice, and `readTier` drops it before the call.
        await save(`${tier.id}Model`, draft.trim())
      }

      return h('div', { className: 'agy-tier' },
        h('div', { className: 'agy-row' },
          h('span', { className: 'agy-row-label' }, t(tier.labelKey)),
          h('span', { className: 'agy-hint' }, t(tier.hintKey)),
        ),
        h('div', { className: 'agy-field' },
          h('label', { className: 'agy-hint', htmlFor: `agy-${tier.id}-model` }, t('model')),
          h('input', {
            id: `agy-${tier.id}-model`,
            className: 'agy-input',
            type: 'text',
            list: catalog.length > 0 ? listId : undefined,
            spellCheck: false,
            autoComplete: 'off',
            disabled: !writable,
            placeholder: t('modelPlaceholder'),
            value: shown,
            onChange: (event) => setDraft(event.target.value),
            onBlur: commitModel,
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                event.currentTarget.blur()
              }
            },
          }),
          catalog.length > 0
            ? h('datalist', { id: listId }, ...catalog.map(id => h('option', { key: id, value: id })))
            : null,
        ),
        h('div', { className: 'agy-field' },
          h('label', { className: 'agy-hint', htmlFor: `agy-${tier.id}-effort` }, t('effort')),
          h('select', {
            id: `agy-${tier.id}-effort`,
            className: 'agy-select',
            disabled: !writable,
            value: typeof effortValue === 'string' ? effortValue : '',
            onChange: (event) => save(`${tier.id}Effort`, event.target.value),
          },
            h('option', { value: '' }, t('effortDefault')),
            ...EFFORTS.map(level => h('option', { key: level, value: level }, level)),
          ),
        ),
        h('span', { className: 'agy-hint' }, t('modelHint')),
      )
    }

    /** The bundle's configuration card on its Plugins page. */
    function SettingsCard({ t }) {
      const form = t.form
      const snapshot = useForm(form)
      const [saving, setSaving] = useState(false)
      const [note, setNote] = useState(undefined)

      if (form === undefined) return h('div', { className: 'agy-card' }, h('span', { className: 'agy-hint' }, t.t('noForm')))

      const value = snapshot?.value ?? {}
      const writable = snapshot?.writable === true && !saving
      const catalog = typeof value.modelCatalog === 'string' && value.modelCatalog.length > 0
        ? value.modelCatalog.split('\n').filter(id => id.length > 0)
        : []

      const save = async (field, next) => {
        setSaving(true)
        setNote(undefined)
        try {
          // Always `set`, never `unset`: unsetting reverts the field to the
          // row's configured default, and the empty string is the explicit
          // "let the CLI decide" value the schema documents.
          await form.set(field, next)
          setNote('ok')
        } catch {
          setNote('err')
        } finally {
          setSaving(false)
        }
      }

      /** Ask the Host row to re-read `agy models`; the catalog arrives as config. */
      const refreshModels = () => save('modelProbeNonce', String(Date.now()))

      return h('div', { className: 'agy-card' },
        h('style', undefined, CSS),
        h('div', { className: 'agy-head' },
          h('span', { className: 'agy-title' }, t.t('title')),
          h('span', { className: 'agy-desc' }, t.t('description')),
        ),
        ...TIERS.map(tier => h(TierFields, {
          key: tier.id,
          tier,
          t: t.t,
          value,
          catalog,
          writable,
          save,
        })),
        h('div', { className: 'agy-actions' },
          h('button', { type: 'button', className: 'agy-btn', disabled: !writable, onClick: refreshModels }, t.t('listModels')),
          saving ? h('span', { className: 'agy-note' }, t.t('saving')) : null,
          !saving && note === 'ok' ? h('span', { className: 'agy-note agy-note-ok' }, t.t('saved')) : null,
          note === 'err' ? h('span', { className: 'agy-note agy-note-err' }, t.t('saveFailed')) : null,
          !writable && snapshot?.writable !== true ? h('span', { className: 'agy-hint' }, t.t('readonly')) : null,
        ),
        h('div', { className: 'agy-field' },
          h('span', { className: 'agy-hint' }, catalog.length === 0 ? t.t('modelsEmpty') : t.t('modelsTitle')),
          catalog.length === 0 ? null : h('pre', { className: 'agy-models' }, catalog.join('\n')),
          catalog.length > 0 && typeof value.modelCatalogAt === 'string' && value.modelCatalogAt.length > 0
            ? h('span', { className: 'agy-hint' }, `${t.t('catalogAt')} ${value.modelCatalogAt}`)
            : null,
        ),
      )
    }

    return {
      name: 'dsh-agy-mode',
      // `configForms` is the only data path: the model catalog arrives as a
      // config field this bundle's Host row fills in, so no remote is needed.
      inject: ['slots', 'locale', 'configForms'],

      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'agy-mode:dictionaries')
        const t = ctx.locale.bind(NS)

        const form = ctx.configForms.get(ENTRY_ID)

        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config',
          key: 'dsh-agy-mode',
          locale: NS,
        }, (props) => h(SettingsCard, { ...props, t: { ...t, t, form } })))
      },
    }
  },
})
