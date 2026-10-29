/**
 * dsh-subagent-route-pin — browser half.
 *
 * Adds an "Expert model / 专家模型" page to Settings as a left-nav section
 * (`settings.section`), the same slot the "Our Free Model" page uses — the
 * "Plugins" page that `plugins.item` feeds is absent from some builds, which
 * left the card unreachable. The page edits
 * the plugin row's volatile config fields through the Host settings document —
 * the same store the main-agent model lives in — so a save is persisted into
 * `cordis.patch.yml` and applies to the next delegation without a restart.
 *
 * The model list comes from the live adapter catalog the composer's model
 * picker uses (`remote.session.modelCatalog()`), so our-free-model lanes, the
 * DeepSeek account lane, and any API-key provider configured in
 * Settings → Models appear here automatically.
 */

window.__ModuleLoader__.load({
  id: 'dsh-subagent-route-pin',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    /** Dictionary namespace of this page. */
    const NS = 'settings.subagent-route-pin'
    /**
     * Config-form namespaces to try, in order: the explicit row id this bundle
     * inserts, then the package-derived id the loader may fall back to.
     */
    const CONFIG_NS_CANDIDATES = ['subagent-route-pin', 'dsh-subagent-route-pin']
    /** Fallback effort levels for catalog rows that carry no `reasoning` block. */
    const EFFORTS = ['low', 'medium', 'high']

    const zh = {
      title: '专家模型',
      description:
        '专家团与显式使用 pinned-account 的子代理跑在这个模型上；大脑模型不受影响。保存后下一次召唤即生效，无需重启。',
      provider: '提供商',
      model: '模型',
      effort: '推理强度',
      effortUnset: '不指定（跟随默认）',
      save: '保存',
      saving: '保存中…',
      saved: '已保存',
      unchanged: '没有改动',
      discard: '放弃改动',
      retry: '重试',
      readOnly: '本部署的设置为只读。',
      conflict: '设置已被其他窗口改动，请重新选择。',
      saveFailed: '保存失败，请重试。',
      catalogLoading: '正在读取模型列表…',
      catalogFailed: '模型列表读取失败。',
      noModels: '当前没有提供方公布模型。',
      savedUnavailable: '已保存但当前不可用',
      teamLabel: '团队模式注入',
      teamHint:
        '开启：团队模式（Agent Teams / 专家团）成员在创建时被改到上面选的模型。关闭：成员继承大脑模型，本页只影响显式走 pinned-account 的子代理。',
      engineLabel: '专家团引擎',
      engineTeam: '原生团队模式 — 并行执行、有任务板，召唤立即返回',
      engineBlocked: '单发子代理引擎 — agency-agents 配了 maxDepth，召唤要等全部跑完',
      engineAbsent: '未安装专家团 — 团队模式注入只作用于 Agent Teams 成员',
      engineUnknown: '读不到专家团配置，按团队模式估计',
      hint:
        '需要 API Key 的提供方请到 设置 → 模型 里配置，随后会出现在这里。个别专家单独指定模型：编辑 ~/.dsh/subagent-route-pin.json 的 experts 字段（可选）。'
    }
    const en = {
      title: 'Expert model',
      description:
        'Agency experts and explicit pinned-account subagents run on this model; the main agent is unaffected. Saved for the next delegation, no restart needed.',
      provider: 'Provider',
      model: 'Model',
      effort: 'Reasoning effort',
      effortUnset: 'Not set (model default)',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved',
      unchanged: 'No changes',
      discard: 'Discard',
      retry: 'Retry',
      readOnly: 'This deployment stores settings read-only.',
      conflict: 'Settings changed in another window. Choose the model again.',
      saveFailed: 'Save failed. Try again.',
      catalogLoading: 'Loading models…',
      catalogFailed: 'Could not load the model list.',
      noModels: 'No provider currently advertises a model.',
      savedUnavailable: 'Saved but currently unavailable',
      teamLabel: 'Inject into team mode',
      teamHint:
        'On: Agent-Teams / agency members are moved to the model above when they are created. Off: members inherit the main agent route and this page only affects explicit pinned-account subagents.',
      engineLabel: 'Agency engine',
      engineTeam: 'Native team mode — parallel, task board, delegation returns immediately',
      engineBlocked: 'One-shot subagent engine — agency-agents sets maxDepth, so a summon blocks until every expert finishes',
      engineAbsent: 'Agency is not installed — injection only reaches Agent-Teams members',
      engineUnknown: 'Could not read the agency row; assuming team mode',
      hint:
        'Providers that need an API key are configured in Settings → Models and then appear here. Per-expert overrides: edit the experts field of ~/.dsh/subagent-route-pin.json (optional).'
    }

    const inject = ['slots', 'locale', 'remote', 'remote.session', 'configForms']

    function emptyRoute() {
      return { provider: '', model: '', reasoningEffort: '', teamInjection: true }
    }

    function sameRoute(left, right) {
      return (
        left.provider === right.provider &&
        left.model === right.model &&
        left.reasoningEffort === right.reasoningEffort &&
        left.teamInjection === right.teamInjection
      )
    }

    /** Small observable store; the component subscribes with useSyncExternalStore. */
    function createStore(initial) {
      let state = initial
      const listeners = new Set()
      return {
        get: () => state,
        set(next) {
          state = next
          for (const listener of [...listeners]) listener()
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        }
      }
    }

    function routeOf(snapshot) {
      const value = snapshot?.value ?? {}
      return {
        provider: typeof value.provider === 'string' ? value.provider : '',
        model: typeof value.model === 'string' ? value.model : '',
        reasoningEffort: typeof value.reasoningEffort === 'string' ? value.reasoningEffort : '',
        teamInjection: value.teamInjection !== false
      }
    }

    /**
     * Which agency engine is configured right now. `resolveTeamEngine` picks the
     * one-shot subagent engine as soon as the agency row carries `maxDepth`, and
     * native Agent Team mode otherwise, so the row's shape is the visible proxy.
     */
    function readEngine(ctx) {
      let form
      try {
        form = ctx.configForms.get('agency-agents')
      } catch {
        return 'unknown'
      }
      if (form === undefined || form === null) return 'absent'
      let snapshot
      try {
        snapshot = form.getSnapshot()
      } catch {
        return 'unknown'
      }
      if (snapshot === undefined || snapshot === null) return 'unknown'
      if (snapshot.status === 'missing') return 'absent'
      const value = snapshot.value ?? {}
      return Object.prototype.hasOwnProperty.call(value, 'maxDepth') ? 'blocked' : 'team'
    }

    /**
     * Bind the config form and the live model catalog into one card state.
     * `draft` only exists while the user has touched the selects; otherwise the
     * form mirrors the accepted value.
     */
    /**
     * Pick the config form that actually describes this plugin's row. The
     * settings service exposes one form per config namespace; a namespace is
     * usable once its snapshot reports a state other than "missing".
     */
    function pickNamespace(ctx) {
      let fallback
      for (const namespace of CONFIG_NS_CANDIDATES) {
        let form
        try {
          form = ctx.configForms.get(namespace)
        } catch {
          continue
        }
        if (form === undefined || form === null) continue
        fallback ??= form
        try {
          const snapshot = form.getSnapshot()
          if (snapshot !== undefined && snapshot !== null && snapshot.status !== 'missing') return form
        } catch {
          /* try the next candidate */
        }
      }
      return fallback
    }

    function createController(ctx) {
      const scope = pickNamespace(ctx)
      const store = createStore({
        status: 'loading',
        writable: false,
        revision: undefined,
        saved: emptyRoute(),
        draft: emptyRoute(),
        touched: false,
        engine: readEngine(ctx),
        catalog: { status: 'idle', groups: [], failures: [] },
        saving: false,
        failed: false,
        conflict: false,
        landed: false
      })
      let catalogGeneration = 0
      let disposed = false
      let saving = false

      const publish = (patch) => {
        store.set({ ...store.get(), ...patch })
      }

      const snapshot = () => {
        try {
          return scope === undefined ? undefined : scope.getSnapshot()
        } catch {
          return undefined
        }
      }

      const sync = () => {
        if (disposed) return
        const snap = snapshot()
        const current = store.get()
        if (snap === undefined) {
          publish({ status: 'error', writable: false })
          return
        }
        const saved = routeOf(snap)
        const externalChange = current.revision !== undefined && current.revision !== snap.revision
        const keepDraft = current.touched && !(externalChange && !saving)
        const draft = keepDraft ? current.draft : saved
        publish({
          status: snap.status ?? 'loading',
          writable: snap.writable === true,
          revision: snap.revision,
          saved,
          draft,
          engine: readEngine(ctx),
          conflict: current.conflict || (externalChange && current.touched && !saving)
        })
      }

      const loadCatalog = async () => {
        catalogGeneration += 1
        const generation = catalogGeneration
        publish({ catalog: { ...store.get().catalog, status: 'loading' } })
        try {
          const catalog = ctx.remote?.session?.modelCatalog
          if (typeof catalog !== 'function') throw new Error('model catalog unavailable')
          const response = await catalog.call(ctx.remote.session)
          if (disposed || generation !== catalogGeneration) return
          if (response?.ok) {
            publish({
              catalog: {
                status: 'ready',
                groups: response.value?.groups ?? [],
                failures: response.value?.failures ?? []
              }
            })
          } else {
            publish({ catalog: { ...store.get().catalog, status: 'error' } })
          }
        } catch {
          if (disposed || generation !== catalogGeneration) return
          publish({ catalog: { ...store.get().catalog, status: 'error' } })
        }
      }

      const unsubscribe = scope === undefined ? () => {} : scope.subscribe(() => sync())
      // The agency row decides which engine runs, so re-read it whenever that row
      // changes (deep-link edits, another window, plugin install/uninstall).
      let agencyForm
      try {
        agencyForm = ctx.configForms.get('agency-agents')
      } catch {
        agencyForm = undefined
      }
      const unsubscribeAgency =
        agencyForm === undefined || agencyForm === null || typeof agencyForm.subscribe !== 'function'
          ? () => {}
          : agencyForm.subscribe(() => publish({ engine: readEngine(ctx) }))
      sync()
      void loadCatalog()

      const actions = {
        setProvider(provider) {
          const state = store.get()
          const firstModel =
            state.catalog.groups.find((group) => group.id === provider)?.models?.[0]?.id ?? ''
          publish({
            draft: {
              ...state.draft,
              provider,
              model: firstModel,
              reasoningEffort: retainedEffort(state, provider, firstModel)
            },
            touched: true,
            conflict: false,
            failed: false,
            landed: false
          })
        },
        setModel(model) {
          const state = store.get()
          publish({
            draft: {
              ...state.draft,
              model,
              reasoningEffort: retainedEffort(state, state.draft.provider, model)
            },
            touched: true,
            conflict: false,
            failed: false,
            landed: false
          })
        },
        setEffort(reasoningEffort) {
          const state = store.get()
          publish({
            draft: { ...state.draft, reasoningEffort },
            touched: true,
            conflict: false,
            failed: false,
            landed: false
          })
        },
        setTeamInjection(teamInjection) {
          const state = store.get()
          publish({
            draft: { ...state.draft, teamInjection: teamInjection === true },
            touched: true,
            conflict: false,
            failed: false,
            landed: false
          })
        },
        discard() {
          const state = store.get()
          publish({ draft: state.saved, touched: false, conflict: false, failed: false, landed: false })
        },
        retryCatalog() {
          void loadCatalog()
        },
        async save() {
          const state = store.get()
          const snap = snapshot()
          if (saving || scope === undefined || snap === undefined || snap.status !== 'ready' || snap.writable !== true) return
          const draft = state.draft
          if (draft.provider === '' || draft.model === '') return
          saving = true
          publish({ saving: true, failed: false, conflict: false, landed: false })
          try {
            await scope.mutate(
              [
                { op: 'set', path: ['provider'], value: draft.provider },
                { op: 'set', path: ['model'], value: draft.model },
                { op: 'set', path: ['reasoningEffort'], value: draft.reasoningEffort },
                { op: 'set', path: ['teamInjection'], value: draft.teamInjection }
              ],
              snap.revision
            )
            saving = false
            const accepted = routeOf(snapshot())
            const landed = sameRoute(accepted, draft)
            publish({
              saving: false,
              failed: !landed,
              landed,
              touched: !landed,
              draft: landed ? accepted : draft,
              saved: accepted,
              revision: snapshot()?.revision
            })
          } catch (error) {
            saving = false
            const conflict =
              error?.code === 'SETTINGS_CONFLICT' || error?.name === 'SettingsConflictError'
            publish({ saving: false, failed: !conflict, conflict })
            sync()
          }
        },
        dispose() {
          disposed = true
          catalogGeneration += 1
          unsubscribe()
          unsubscribeAgency()
        }
      }

      return { store, actions }
    }

    /** Candidate model rows: live catalog plus the saved route if it vanished. */
    function candidates(groups, saved) {
      const rows = []
      for (const group of groups) {
        for (const model of group.models ?? []) {
          rows.push({
            provider: group.id,
            providerName: group.name ?? group.id,
            model: model.id,
            modelName: model.name ?? model.id,
            efforts: Array.isArray(model.reasoning?.efforts) ? model.reasoning.efforts : undefined,
            available: true
          })
        }
      }
      const present = rows.some((row) => row.provider === saved.provider && row.model === saved.model)
      if (!present && saved.provider !== '' && saved.model !== '') {
        rows.push({
          provider: saved.provider,
          providerName: saved.provider,
          model: saved.model,
          modelName: saved.model,
          efforts: undefined,
          available: false
        })
      }
      return rows
    }

    /** Effort levels the selected catalog row declares, or undefined when unknown. */
    function effortsOf(rows, provider, model) {
      const row = rows.find((entry) => entry.provider === provider && entry.model === model)
      return row === undefined || row.available !== true || !Array.isArray(row.efforts) || row.efforts.length === 0
        ? undefined
        : row.efforts
    }

    /**
     * Options for the effort select. The model's catalog entry wins when it
     * declares `reasoning.efforts`; the classic trio is only the fallback for
     * rows without that block. A live value the list does not offer stays
     * visible as an extra leading option — a controlled <select> would
     * otherwise fall back to its first option and pass a configured level
     * (say `max`) off as `low`.
     */
    function effortOptions(rows, provider, model, current) {
      const offered = effortsOf(rows, provider, model)
      const options = (offered ?? EFFORTS.map((id) => ({ id, name: id }))).map((effort) => ({
        id: effort.id,
        name: effort.name ?? effort.id,
        unavailable: false
      }))
      if (current !== '' && !options.some((option) => option.id === current)) {
        options.unshift({ id: current, name: current, unavailable: true })
      }
      return options
    }

    /**
     * Keep the drafted effort only when the next model still offers it. Rows
     * without catalog reasoning info cannot be judged, so their value is kept
     * (and stays visible through the extra-option branch above).
     */
    function retainedEffort(state, provider, model) {
      const current = state.draft.reasoningEffort
      if (current === '') return ''
      const rows = candidates(state.catalog.groups, state.saved)
      const offered = effortsOf(rows, provider, model)
      if (offered === undefined) return current
      return offered.some((effort) => effort.id === current) ? current : ''
    }

    function label(t, key) {
      return typeof t === 'function' ? t(key) : key
    }

    const SELECT_STYLE = {
      width: '100%',
      padding: '6px 8px',
      borderRadius: '8px',
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-module-platform)',
      color: 'var(--dsw-alias-label-primary)',
      fontSize: '13px'
    }
    const BUTTON_STYLE = {
      padding: '6px 14px',
      borderRadius: '999px',
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-module-platform)',
      color: 'var(--dsw-alias-label-primary)',
      cursor: 'pointer',
      fontSize: '13px'
    }
    const HINT_STYLE = { margin: 0, fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' }

    function fieldRow(t, text, control) {
      return h(
        'label',
        { style: { display: 'grid', gap: '6px', fontSize: '13px' } },
        h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, text),
        control
      )
    }

    function ExpertModelCard(props) {
      const t = props.t
      const face = props.face
      const state = React.useSyncExternalStore(face.store.subscribe, face.store.get, face.store.get)
      const rows = candidates(state.catalog.groups, state.saved)
      const providers = []
      for (const row of rows) {
        if (!providers.some((entry) => entry.id === row.provider)) {
          providers.push({ id: row.provider, name: row.providerName })
        }
      }
      const models = rows.filter((row) => row.provider === state.draft.provider)
      const editable = state.writable && state.status === 'ready' && !state.saving
      const dirty = !sameRoute(state.draft, state.saved)
      let status = ''
      if (state.catalog.status === 'loading') status = label(t, 'catalogLoading')
      else if (state.catalog.status === 'error') status = label(t, 'catalogFailed')
      else if (rows.length === 0) status = label(t, 'noModels')
      else if (state.conflict) status = label(t, 'conflict')
      else if (state.failed) status = label(t, 'saveFailed')
      else if (state.saving) status = label(t, 'saving')
      else if (state.landed) status = label(t, 'saved')
      else if (!dirty) status = label(t, 'unchanged')
      const engineText =
        state.engine === 'team'
          ? label(t, 'engineTeam')
          : state.engine === 'blocked'
            ? label(t, 'engineBlocked')
            : state.engine === 'absent'
              ? label(t, 'engineAbsent')
              : label(t, 'engineUnknown')
      return h(
        'div',
        { style: { display: 'grid', gap: '12px', padding: '4px 0' } },
        h(
          'p',
          { style: { margin: 0, fontSize: '13px', color: 'var(--dsw-alias-label-secondary)' } },
          label(t, 'description')
        ),
        fieldRow(
          t,
          label(t, 'provider'),
          h(
            'select',
            {
              style: SELECT_STYLE,
              value: state.draft.provider,
              disabled: !editable,
              onChange: (event) => face.actions.setProvider(event.currentTarget.value)
            },
            h('option', { value: '' }, '—'),
            providers.map((provider) => h('option', { key: provider.id, value: provider.id }, provider.name))
          )
        ),
        fieldRow(
          t,
          label(t, 'model'),
          h(
            'select',
            {
              style: SELECT_STYLE,
              value: state.draft.model,
              disabled: !editable,
              onChange: (event) => face.actions.setModel(event.currentTarget.value)
            },
            h('option', { value: '' }, '—'),
            models.map((row) =>
              h(
                'option',
                { key: `${row.provider}/${row.model}`, value: row.model },
                row.available ? row.modelName : `${row.modelName} · ${label(t, 'savedUnavailable')}`
              )
            )
          )
        ),
        fieldRow(
          t,
          label(t, 'effort'),
          h(
            'select',
            {
              style: SELECT_STYLE,
              value: state.draft.reasoningEffort,
              disabled: !editable,
              onChange: (event) => face.actions.setEffort(event.currentTarget.value)
            },
            h('option', { value: '' }, label(t, 'effortUnset')),
            effortOptions(rows, state.draft.provider, state.draft.model, state.draft.reasoningEffort).map(
              (option) =>
                h(
                  'option',
                  { key: option.id, value: option.id },
                  option.unavailable ? `${option.name} · ${label(t, 'savedUnavailable')}` : option.name
                )
            )
          )
        ),
        h(
          'label',
          { style: { display: 'flex', gap: '8px', alignItems: 'center', fontSize: '13px' } },
          h('input', {
            type: 'checkbox',
            checked: state.draft.teamInjection !== false,
            disabled: !editable,
            onChange: (event) => face.actions.setTeamInjection(event.currentTarget.checked)
          }),
          h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, label(t, 'teamLabel'))
        ),
        h('p', { style: HINT_STYLE }, label(t, 'teamHint')),
        h(
          'p',
          { style: HINT_STYLE },
          `${label(t, 'engineLabel')}: ${engineText}`
        ),
        h(
          'div',
          { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
          h(
            'button',
            {
              type: 'button',
              style: BUTTON_STYLE,
              disabled: !editable || !dirty,
              onClick: () => void face.actions.save()
            },
            state.saving ? label(t, 'saving') : label(t, 'save')
          ),
          h(
            'button',
            {
              type: 'button',
              style: BUTTON_STYLE,
              disabled: !editable || !dirty,
              onClick: () => face.actions.discard()
            },
            label(t, 'discard')
          ),
          state.catalog.status === 'error'
            ? h(
                'button',
                { type: 'button', style: BUTTON_STYLE, onClick: () => face.actions.retryCatalog() },
                label(t, 'retry')
              )
            : null,
          h('span', { style: HINT_STYLE }, status)
        ),
        state.writable === false
          ? h('p', { style: HINT_STYLE }, label(t, 'readOnly'))
          : null,
        h('p', { style: HINT_STYLE }, label(t, 'hint'))
      )
    }

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(
        () => ctx.locale.register(NS, { zh, en }),
        'subagent-route-pin: dictionaries'
      )
      const controller = createController(ctx)
      const face = { store: controller.store, actions: controller.actions }
      ctx.effect(() => () => controller.actions.dispose(), 'subagent-route-pin: form subscription')
      const onRemote = (event, handler) => {
        const subscribe = ctx.remote?.$on
        return typeof subscribe === 'function' ? subscribe.call(ctx.remote, event, handler) : () => {}
      }
      ctx.effect(() => onRemote('llm/adapters-updated', () => controller.actions.retryCatalog()), 'subagent-route-pin: adapter invalidations')
      ctx.effect(
        () => onRemote('settings/document-updated', () => controller.actions.retryCatalog()),
        'subagent-route-pin: settings invalidations'
      )
      // Unconditional: the page must exist even before (or without) a served
      // config form, because that form lives on the Plugins page this build may
      // not have. The card renders its own "unavailable" state instead.
      ctx.effect(
        () =>
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              {
                name: 'settings.section',
                id: 'subagent-route-pin',
                order: 36,
                label: () => t('title'),
                locale: NS
              },
              (props) => h(ExpertModelCard, Object.assign({}, props, { face, t }))
            )
          ),
        'subagent-route-pin: settings section'
      )
    }

    return { apply, inject, name: 'subagent-route-pin' }
  }
})
