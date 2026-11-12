/**
 * dsh-delegation-hub — browser half.
 *
 * Adds a "Delegation Hub / 委派中枢" page to Settings as a left-nav section
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
  id: 'dsh-delegation-hub',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    /** Dictionary namespace of this page. */
    const NS = 'settings.delegation-hub'
    /**
     * Config-form namespaces to try, in order: the explicit row id this bundle
     * inserts, then the package-derived id the loader may fall back to.
     */
    const CONFIG_NS_CANDIDATES = ['delegation-hub', 'dsh-delegation-hub']
    // Empty slot = leave the effort unpinned (the host then omits it). max and
    // extra_high exist on real lanes (deepseek-flash: low/high/max; trae sends
    // extra_high), and a stored value outside this list would silently render
    // as the first option in a controlled select, so the list must cover them.
    // Since 0.9.3 this static list is only the FALLBACK: when the live catalog
    // carries the model's declared efforts (modelCatalog → model.reasoning,
    // the same projection the composer's effort menu reads), the select shows
    // those instead, so an effort the model would reject at request time
    // (UNSUPPORTED_REASONING_EFFORT) is never offered in the first place.
    const EFFORTS = ['', 'low', 'medium', 'high', 'max', 'extra_high']

    /**
     * Effort options the catalog declares for one route.
     *
     * @returns `{ efforts, defaultEffort }` when the model declares its
     *   efforts, `null` when the model declares NONE (requesting any effort
     *   fails UNSUPPORTED_REASONING_EFFORT — see dsh-llm resolveModelInfo), or
     *   `undefined` when the catalog cannot answer (not ready, provider/model
     *   missing). The caller keeps the static list on `undefined`, mirroring
     *   the precheck rule "unknown ≠ unsupported".
     */
    function declaredEfforts(groups, provider, model) {
      if (typeof provider !== 'string' || typeof model !== 'string' || provider === '' || model === '') return undefined
      if (!Array.isArray(groups)) return undefined
      const group = groups.find((candidate) => candidate?.id === provider)
      if (group === undefined) return undefined
      const entry = (group.models ?? []).find((candidate) => candidate?.id === model)
      if (entry === undefined) return undefined
      if (entry.reasoning === undefined || entry.reasoning === null) return null
      const efforts = Array.isArray(entry.reasoning.efforts) ? entry.reasoning.efforts : []
      return {
        efforts: efforts.filter(
          (effort) => effort !== null && typeof effort === 'object' && typeof effort.id === 'string' && effort.id !== ''
        ),
        defaultEffort: typeof entry.reasoning.defaultEffort === 'string' ? entry.reasoning.defaultEffort : undefined
      }
    }

    /** Option label for one effort: localized name when the catalog ships one. */
    function effortLabel(effort) {
      const name = typeof effort?.name === 'string' && effort.name.trim() !== '' ? effort.name.trim() : effort.id
      return name === effort.id ? effort.id : `${name}（${effort.id}）`
    }

    /**
     * The effort a changed model keeps: a declared-and-supported value stays,
     * anything the new model contradicts resets to the unpinned slot. An
     * unknown catalog keeps the current value — the composer behaves the same.
     */
    function effortForModel(groups, provider, model, current) {
      const declared = declaredEfforts(groups, provider, model)
      if (declared === undefined) return current
      if (declared === null) return ''
      if (typeof current !== 'string' || current === '') return current
      return declared.efforts.some((effort) => effort.id === current) ? current : ''
    }

    const zh = {
      title: '委派中枢',
      description:
        '专家团专家、Agent Teams 成员、单发子代理统一钉在这条模型路由上；大脑模型不受影响。保存后下一次委派即生效，无需重启。',
      provider: '提供商',
      model: '模型',
      effort: '推理强度',
      save: '保存',
      saving: '保存中…',
      saved: '已保存',
      unchanged: '没有改动',
      discard: '放弃改动',
      retry: '重试',
      readOnly: '本部署的设置为只读。',
      conflict: '设置已被其他窗口改动，请重新选择。',
      saveFailed: '保存失败，请重试。',
      needCatalog: '模型目录为空：请确认已登录模型账号，或先在对话里发一条消息让模型通道就绪，然后再选择提供商与模型。',
      precheckProvider: '模型提供方「{provider}」当前不在模型目录里。目录为空或提供方暂时离线时可忽略；再点一次保存强制写入。',
      precheckModel: '模型「{model}」不在提供方「{provider}」公布的目录里。适配器可能仍接受该 ID；再点一次保存强制写入。',
      catalogLoading: '正在读取模型列表…',
      catalogFailed: '模型列表读取失败。',
      noModels: '当前没有提供方公布模型。',
      savedUnavailable: '已保存但当前不可用',
      effortDefaultSuffix: '（默认）',
      effortStaleSuffix: '（该模型未声明）',
      effortNoneHint: '该模型未声明推理档位：留空（—）即可，任何档位都会被模型拒绝。',
      effortFallbackHint: '模型目录里查不到该模型的档位声明：暂按通用档位显示。',
      teamLabel: '团队模式注入',
      teamHint:
        '开启：团队模式（Agent Teams / 专家团）成员在创建时被改到上面选的模型。关闭：成员继承大脑模型，本页只影响显式走 pinned-account 的子代理。',
      engineLabel: '专家团引擎',
      engineTeam: '原生团队模式 — 并行执行、有任务板，召唤立即返回',
      engineBlocked: '单发子代理引擎 — agency-agents 配了 maxDepth，召唤要等全部跑完',
      engineAbsent: '未安装专家团 — 团队模式注入只作用于 Agent Teams 成员',
      engineUnknown: '读不到专家团配置，按团队模式估计',
      stepsLabel: '步骤路由（每步一个模型）',
      stepsAdd: '添加步骤',
      stepsExpertPlaceholder: '专家（可选，如 代码审查工程师）',
      stepsSkillsPlaceholder: '技能，逗号分隔（可选）',
      stepsNamePlaceholder: '步骤名，中英文均可（如 research / 调研）',
      stepsRemove: '移除',
      stepsHint:
        '每步一个模型：把目标拆成多个串行子委派，每个步骤单独配置模型，委派时在 label 末尾加 #步骤名（如 调研报告#research），该步即走对应路由。优先级：逐专家 > 团队角色 > 步骤 > 主路由。',
      stepsIssueName: '步骤名不能为空',
      stepsIssueRoute: '提供商与模型都要选择',
      stepsIssueDuplicate: '步骤名重复',
      stepsIssueMissingModel: '模型不在当前目录',
      stepsFixCount: '{count} 个步骤需要修正',
      failoverLabel: '故障切换路由（可选）',
      failoverHint:
        '仅对 Agent-Teams 团队成员生效：成员在运行中撞上额度耗尽、鉴权失效、适配器消失等车道级故障时，其后续请求会被改写到这条备用路由（仅切换一次）。单发子代理与专家团专家不走这条接缝，不受 failoverRoute 影响。留空 = 关闭。与「团队模式注入」共用下面两个下拉的选择。',
      failoverToggle: '启用故障切换',
      rolesLabel: '按角色路由（roles）',
      rolesHint:
        'Agent Teams 成员按其团队角色（实现者/验证者/审查者等，来自团队状态文件）套用对应路由，优先级高于上面的主路由。编辑 ~/.dsh/subagent-route-pin.json 的 roles 字段后下一次团队委派即生效；dsh-role-preset delivery 可一键写入三车道预设。',
      driftLabel: '当前生效路由',
      lastRunLabel: '最近一次委派',
      lastRunModel: '模型',
      lastRunStep: '步骤',
      lastRunExpert: '专家',
      lastRunSkills: '技能',
      lastRunOutcome: '结果',
      lastRunReason: '原因',
      lastRunAt: '时间',
      lastRunNone: '尚无委派记录。',
      lastRunPending: '正在读取委派记录…',
      lastRunUnavailable: '读取委派记录失败。',
      listSep: '、',
      hint:
        '需要 API Key 的提供方请到 设置 → 模型 里配置，随后会出现在这里。个别专家单独指定模型：编辑 ~/.dsh/subagent-route-pin.json 的 experts 字段（可选）。'
    }
    const en = {
      title: 'Delegation Hub',
      description:
        'Agency experts, Agent-Teams members, and one-shot subagents all run on this pinned route; the main agent is unaffected. Saved for the next delegation, no restart needed.',
      provider: 'Provider',
      model: 'Model',
      effort: 'Reasoning effort',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved',
      unchanged: 'No changes',
      discard: 'Discard',
      retry: 'Retry',
      readOnly: 'This deployment stores settings read-only.',
      conflict: 'Settings changed in another window. Choose the model again.',
      saveFailed: 'Save failed. Try again.',
      needCatalog: 'The model catalog is empty: sign in to a model account, or send one message in a conversation to ready the model lane, then pick a provider and model.',
      precheckProvider: 'Provider "{provider}" is not in the model catalog right now. Ignore this when the catalog is empty or the provider is offline; save once more to force the row.',
      precheckModel: 'Model "{model}" is not advertised by provider "{provider}". The adapter may still accept the id; save once more to force the row.',
      catalogLoading: 'Loading models…',
      catalogFailed: 'Could not load the model list.',
      noModels: 'No provider currently advertises a model.',
      savedUnavailable: 'Saved but currently unavailable',
      effortDefaultSuffix: ' (default)',
      effortStaleSuffix: ' (not declared by this model)',
      effortNoneHint: 'This model declares no reasoning efforts: leave it empty (—); any effort is rejected by the model.',
      effortFallbackHint: 'The catalog carries no effort declaration for this model: showing the generic list for now.',
      teamLabel: 'Inject into team mode',
      teamHint:
        'On: Agent-Teams / agency members are moved to the model above when they are created. Off: members inherit the main agent route and this page only affects explicit pinned-account subagents.',
      engineLabel: 'Agency engine',
      engineTeam: 'Native team mode — parallel, task board, delegation returns immediately',
      engineBlocked: 'One-shot subagent engine — agency-agents sets maxDepth, so a summon blocks until every expert finishes',
      engineAbsent: 'Agency is not installed — injection only reaches Agent-Teams members',
      engineUnknown: 'Could not read the agency row; assuming team mode',
      stepsLabel: 'Step routes (one model per step)',
      stepsAdd: 'Add step',
      stepsExpertPlaceholder: 'expert (optional)',
      stepsSkillsPlaceholder: 'skills, comma-separated (optional)',
      stepsNamePlaceholder: 'step name (e.g. research)',
      stepsRemove: 'Remove',
      stepsHint:
        'One model per step: split the goal into serial sub-delegations, each step configured with its own model, labelled with #step at the end of the label (e.g. 调研报告#research). Priority: experts > roles > steps > main route.',
      stepsIssueName: 'Step name cannot be empty',
      stepsIssueRoute: 'Pick both provider and model',
      stepsIssueDuplicate: 'Duplicate step name',
      stepsIssueMissingModel: 'Model is not in the current catalog',
      stepsFixCount: '{count} step(s) need fixing',
      failoverLabel: 'Failover route (optional)',
      failoverHint:
        'Agent-Teams members only: when a member hits a lane failure mid-flight (quota drained, auth revoked, adapter gone), its next requests are rewritten to this backup route (once). One-shot subagents and agency experts do not pass through that seam and are unaffected. Leave empty to disable. Shares the two dropdowns below with team injection.',
      failoverToggle: 'Enable failover',
      rolesLabel: 'Role routes (roles)',
      rolesHint:
        'Agent-Teams members are routed by their durable team role (实现者/验证者/审查者 from the team state file); roles outrank the main route above. Edit the roles field of ~/.dsh/subagent-route-pin.json and the next team delegation picks it up; dsh-role-preset delivery writes the three-lane preset in one shot.',
      driftLabel: 'Effective route',
      lastRunLabel: 'Last delegation',
      lastRunModel: 'Model',
      lastRunStep: 'Step',
      lastRunExpert: 'Expert',
      lastRunSkills: 'Skills',
      lastRunOutcome: 'Outcome',
      lastRunReason: 'Reason',
      lastRunAt: 'At',
      lastRunNone: 'No delegation recorded yet.',
      lastRunPending: 'Loading the delegation record…',
      lastRunUnavailable: 'Could not read the delegation record.',
      listSep: ', ',
      hint:
        'Providers that need an API key are configured in Settings → Models and then appear here. Per-expert overrides: edit the experts field of ~/.dsh/subagent-route-pin.json (optional).'
    }

    const inject = ['slots', 'locale', 'remote', 'remote.session', 'configForms']

    function emptyRoute() {
      return {
        provider: '',
        model: '',
        reasoningEffort: '',
        teamInjection: true,
        failoverProvider: '',
        failoverModel: '',
        steps: []
      }
    }

    function sameRoute(left, right) {
      return (
        left.provider === right.provider &&
        left.model === right.model &&
        left.reasoningEffort === right.reasoningEffort &&
        left.teamInjection === right.teamInjection &&
        left.failoverProvider === right.failoverProvider &&
        left.failoverModel === right.failoverModel &&
        sameSteps(left.steps, right.steps)
      )
    }

    function sameSteps(left, right) {
      // `fresh` rows (added but never typed into) carry no route yet: they are
      // skipped by the serializer, so they must be invisible here too —
      // otherwise 添加步骤 → 保存 compares an accepted route without the row
      // against a draft with it and reports 「保存失败」 for a no-op.
      const a = (Array.isArray(left) ? left : []).filter((row) => row?.fresh !== true)
      const b = (Array.isArray(right) ? right : []).filter((row) => row?.fresh !== true)
      if (a.length !== b.length) return false
      return a.every(
      (row, index) =>
        row.name === b[index].name &&
        row.provider === b[index].provider &&
        row.model === b[index].model &&
        (row.reasoningEffort ?? '') === (b[index].reasoningEffort ?? '') &&
        (row.expert ?? '') === (b[index].expert ?? '') &&
        (row.skills ?? '') === (b[index].skills ?? '')
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

    /**
     * Newest run record (model / step / expert / skills), fetched over the
     * host's same-origin `/delegation-hub/last-run` route. The browser cannot
     * read files and the host exposes no file-reading RPC, so that route is
     * the only way here; when it is absent (older host, route gated) the card
     * renders one status line instead of inventing data.
     */
    const lastRunStore = createStore({ status: 'idle', record: null })

    async function loadLastRun() {
      if (typeof fetch !== 'function') {
        lastRunStore.set({ status: 'unavailable', record: null })
        return
      }
      try {
        const response = await fetch('/delegation-hub/last-run')
        if (response === null || typeof response !== 'object' || response.ok !== true) {
          lastRunStore.set({ status: 'unavailable', record: null })
          return
        }
        const body = await response.json()
        lastRunStore.set({
          status: 'ready',
          record: body !== null && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length > 0 ? body : null
        })
      } catch {
        lastRunStore.set({ status: 'unavailable', record: null })
      }
    }

    function routeOf(snapshot) {
      const value = snapshot?.value ?? {}
      return {
        provider: typeof value.provider === 'string' ? value.provider : '',
        model: typeof value.model === 'string' ? value.model : '',
        reasoningEffort: typeof value.reasoningEffort === 'string' ? value.reasoningEffort : '',
        teamInjection: value.teamInjection !== false,
        failoverProvider:
          value.failoverRoute !== null && typeof value.failoverRoute === 'object' && typeof value.failoverRoute.provider === 'string'
            ? value.failoverRoute.provider
            : '',
        failoverModel:
          value.failoverRoute !== null && typeof value.failoverRoute === 'object' && typeof value.failoverRoute.model === 'string'
            ? value.failoverRoute.model
            : '',
        steps: (() => {
          let raw = value.stepsJson
          if (typeof raw !== 'string' || raw.trim() === '') return []
          try {
            raw = JSON.parse(raw)
          } catch {
            return []
          }
          if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return []
          return Object.entries(raw).map(([name, route]) => ({
            name,
            provider: route && typeof route.provider === 'string' ? route.provider : '',
            model: route && typeof route.model === 'string' ? route.model : '',
            reasoningEffort: route && typeof route.reasoningEffort === 'string' ? route.reasoningEffort : '',
            expert: route && typeof route.expert === 'string' ? route.expert : '',
            skills: route && Array.isArray(route.skills) ? route.skills.join(', ') : ''
          }))
        })()
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
        landed: false,
        precheck: null,
        needCatalog: false,
        // Set by save() when the step editor still flags rows. A blocked save
        // must say why instead of leaving the status line on 「没有改动」.
        stepBlocked: false
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
              reasoningEffort: effortForModel(state.catalog.groups, provider, firstModel, state.draft.reasoningEffort)
            },
            touched: true,
            conflict: false,
            failed: false,
            precheck: null,
            landed: false
          })
        },
        setModel(model) {
          const state = store.get()
          publish({
            draft: {
              ...state.draft,
              model,
              reasoningEffort: effortForModel(state.catalog.groups, state.draft.provider, model, state.draft.reasoningEffort)
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
        setStepEffort(index, reasoningEffort) {
          const state = store.get()
          const steps = state.draft.steps.map((row, i) => (i === index ? { ...row, reasoningEffort, fresh: false } : row))
          publish({ draft: { ...state.draft, steps }, touched: true, conflict: false, failed: false, landed: false, precheck: null, stepBlocked: false })
        },
        addStep() {
          const state = store.get()
          publish({
            draft: { ...state.draft, steps: [...state.draft.steps, { name: '', provider: '', model: '', reasoningEffort: '', expert: '', skills: '', fresh: true }] },
            touched: true,
            conflict: false,
            failed: false,
            landed: false,
            precheck: null,
            stepBlocked: false
          })
        },
        /**
         * Persist one step row's provider/model; the effort follows the
         * model's declared efforts and resets when the new model contradicts
         * it, mirroring the main route's behavior.
         */
        setStep(index, patch) {
          const state = store.get()
          let effective = { ...patch, fresh: false }
          if (patch.provider !== undefined || patch.model !== undefined) {
            const steps = state.draft.steps.map((row, i) => (i === index ? { ...row, ...patch, fresh: false } : row))
            const row = steps[index]
            effective = { ...patch, fresh: false, reasoningEffort: effortForModel(state.catalog.groups, row.provider, row.model, row.reasoningEffort ?? '') }
          }
          const steps = state.draft.steps.map((row, i) => (i === index ? { ...row, ...effective } : row))
          publish({ draft: { ...state.draft, steps }, touched: true, conflict: false, failed: false, landed: false, precheck: null, stepBlocked: false })
        },
        removeStep(index) {
          const state = store.get()
          publish({
            draft: { ...state.draft, steps: state.draft.steps.filter((_, i) => i !== index) },
            touched: true,
            conflict: false,
            failed: false,
            landed: false,
            precheck: null,
            stepBlocked: false
          })
        },
        setFailover(provider, model) {
          const state = store.get()
          publish({
            draft: { ...state.draft, failoverProvider: provider, failoverModel: model },
            touched: true,
            conflict: false,
            failed: false,
            landed: false,
            precheck: null
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
        /**
         * Persist the row. `flaggedStepCount` is the count the card already
         * derived from `stepIssues` for this frame — it is passed in so this
         * action never recomputes the criteria.
         *
         * A flagged step row used to be dropped by the serialization loop below
         * while the card still reported 「已保存」: the row was yellow on screen
         * and silently absent from stepsJson. The save is now refused with the
         * same reason text the card shows, and the whole mutate is skipped —
         * persisting the other fields while dropping a row would still be a
         * silent data loss.
         */
        async save(flaggedStepCount = 0) {
          const state = store.get()
          const snap = snapshot()
          if (saving || scope === undefined || snap === undefined || snap.status !== 'ready' || snap.writable !== true) return
          const draft = state.draft
          if (draft.provider === '' || draft.model === '') {
            // Empty selects used to silently swallow the click: the user saw a
            // dead button. Surface the reason instead.
            publish({ needCatalog: true, failed: false, conflict: false, landed: false, stepBlocked: false })
            return
          }
          if (flaggedStepCount > 0) {
            publish({ stepBlocked: true, failed: false, conflict: false, landed: false, needCatalog: false })
            return
          }
          // Catalog preflight (P1-④): a model the catalog does not advertise is
          // the one mistake that used to surface only as a failed delegation.
          // The catalog is advisory — empty groups or an offline provider are
          // skipped, and the user can still save (the row may name a model the
          // adapter accepts dynamically), but the mismatch is shown inline.
          if (state.catalog.status === 'ready' && state.catalog.groups.length > 0) {
            const group = state.catalog.groups.find((candidate) => candidate.id === draft.provider)
            const advertised =
              group === undefined
                ? 'provider-missing'
                : (group.models ?? []).some((candidate) => candidate.id === draft.model)
                  ? 'ok'
                  : 'model-missing'
            if (advertised !== 'ok' && state.precheck === null) {
              // First save attempt: show the mismatch and stop. Saving again
              // (state.precheck already set) forces the row through, because the
              // catalog is advisory and an adapter may accept unlisted ids.
              publish({
                precheck: advertised === 'provider-missing' ? { kind: 'provider' } : { kind: 'model' }
              })
              return
            }
          }
          publish({ precheck: null, stepBlocked: false })
          saving = true
          publish({ saving: true, failed: false, conflict: false, landed: false, needCatalog: false, stepBlocked: false })
          try {
            const failoverOps =
              draft.failoverProvider !== '' && draft.failoverModel !== ''
                ? [
                    {
                      op: 'set',
                      path: ['failoverRoute'],
                      value: { provider: draft.failoverProvider, model: draft.failoverModel }
                    }
                  ]
                : []
            const stepObject = {}
            for (const row of draft.steps ?? []) {
              if (row.name.trim() === '' || row.provider === '' || row.model === '') continue
              const lane = { provider: row.provider, model: row.model }
              if (typeof row.reasoningEffort === 'string' && row.reasoningEffort.trim() !== '') {
                lane.reasoningEffort = row.reasoningEffort.trim()
              }
              if (typeof row.expert === 'string' && row.expert.trim() !== '') lane.expert = row.expert.trim()
              if (typeof row.skills === 'string' && row.skills.trim() !== '') {
                lane.skills = row.skills.split(/[,，]/).map((skill) => skill.trim()).filter((skill) => skill !== '')
              }
              stepObject[row.name.trim()] = lane
            }
            // An empty editor must CLEAR the stored row, not skip the op: omitting
            // stepsJson leaves the old value in the document and the deleted rows
            // resurrect on the next sync. The host treats '' as absent, so an
            // explicit empty string is the clear signal (only sent when there is
            // something stored to clear).
            const storedSteps = snapshot()?.value?.stepsJson
            const stepOps =
              Object.keys(stepObject).length > 0
                ? [{ op: 'set', path: ['stepsJson'], value: JSON.stringify(stepObject) }]
                : typeof storedSteps === 'string' && storedSteps.trim() !== ''
                  ? [{ op: 'set', path: ['stepsJson'], value: '' }]
                  : []
            await scope.mutate(
              [
                { op: 'set', path: ['provider'], value: draft.provider },
                { op: 'set', path: ['model'], value: draft.model },
                { op: 'set', path: ['reasoningEffort'], value: draft.reasoningEffort },
                { op: 'set', path: ['teamInjection'], value: draft.teamInjection },
                ...failoverOps,
                ...stepOps
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
          available: false
        })
      }
      return rows
    }

    function label(t, key) {
      return typeof t === 'function' ? t(key) : key
    }

    /** Issue key → i18n key for one step-editor row. */
    const STEP_ISSUE_LABELS = {
      name: 'stepsIssueName',
      route: 'stepsIssueRoute',
      duplicate: 'stepsIssueDuplicate',
      missingModel: 'stepsIssueMissingModel'
    }

    /**
     * One effort `<select>` shared by the main route and step rows. Options
     * come from the model's declared efforts when the catalog carries them
     * (labeled with the localized name and marking the default), fall back to
     * the static EFFORTS list when the catalog cannot answer, and degrade to
     * just the empty slot when the model explicitly declares none. A stored
     * value the model no longer declares is still rendered (marked stale) so
     * a controlled select never silently snaps to the first option.
     */
    function effortSelect(t, value, options, onChange, disabled) {
      const { efforts, declared, defaultEffort, stale } = options
      const optionNodes = [h('option', { key: 'none', value: '' }, '—')]
      if (declared === null) {
        // The model explicitly declares no efforts; only the empty slot plus
        // any stale stored value survive.
      } else if (Array.isArray(efforts) && efforts.length > 0) {
        for (const effort of efforts) {
          const isDefault = effort.id === defaultEffort
          const text = `${effortLabel(effort)}${isDefault ? t('effortDefaultSuffix') : ''}`
          optionNodes.push(h('option', { key: effort.id, value: effort.id }, text))
        }
        if (stale !== undefined && stale !== '' && !efforts.some((effort) => effort.id === stale)) {
          optionNodes.push(h('option', { key: `stale-${stale}`, value: stale }, `${stale}${t('effortStaleSuffix')}`))
        }
      } else {
        for (const effort of EFFORTS) {
          if (effort === '') continue
          optionNodes.push(h('option', { key: effort, value: effort }, effort))
        }
      }
      return h(
        'select',
        { style: { ...SELECT_STYLE, minWidth: 0 }, value, disabled, onChange: (event) => onChange(event.currentTarget.value) },
        optionNodes
      )
    }

    /**
     * Live per-row issues of the step editor. Pure derivation from the draft
     * rows plus the catalog on every render — nothing is written back into the
     * draft or the store, so fixing a field clears the flag on the next frame
     * without a save. An empty name, a missing provider/model, a duplicated
     * name (trimmed, case-insensitive) and a model the ready catalog does not
     * advertise each flag their row; a catalog that is not ready or advertises
     * no groups never raises the last issue, to avoid false alarms while the
     * list is still loading or empty.
     *
     * A row the user added but has not touched (`fresh: true`, set by addStep
     * and cleared on the first setStep) raises no issues at all: flagging a
     * just-created placeholder row painted the whole editor yellow and its
     * "issues" would block a save that would skip the row anyway. The first
     * keystroke arms the full checks for that row.
     */
    function stepIssues(steps, catalog, rows) {
      const list = Array.isArray(steps) ? steps : []
      const nameCount = new Map()
      for (const row of list) {
        const key = String(row?.name ?? '').trim().toLowerCase()
        if (key === '') continue
        nameCount.set(key, (nameCount.get(key) ?? 0) + 1)
      }
      const catalogReady =
        catalog !== null &&
        typeof catalog === 'object' &&
        catalog.status === 'ready' &&
        Array.isArray(catalog.groups) &&
        catalog.groups.length > 0 &&
        Array.isArray(rows) &&
        rows.length > 0
      return list.map((row) => {
        if (row?.fresh === true) return []
        const issues = []
        const name = String(row?.name ?? '').trim()
        if (name === '') issues.push('name')
        if (String(row?.provider ?? '') === '' || String(row?.model ?? '') === '') issues.push('route')
        const nameKey = name.toLowerCase()
        if (nameKey !== '' && (nameCount.get(nameKey) ?? 0) > 1) issues.push('duplicate')
        if (
          catalogReady &&
          String(row?.provider ?? '') !== '' &&
          String(row?.model ?? '') !== '' &&
          !rows.some((candidate) => candidate.provider === row.provider && candidate.model === row.model)
        ) {
          issues.push('missingModel')
        }
        return issues
      })
    }

    const SELECT_STYLE = {
      width: '100%',
      boxSizing: 'border-box',
      padding: '6px 8px',
      borderRadius: '8px',
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-module-platform)',
      color: 'var(--dsw-alias-label-primary)',
      fontSize: '13px'
    }
    const BUTTON_STYLE = {
      boxSizing: 'border-box',
      padding: '6px 14px',
      borderRadius: '999px',
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-module-platform)',
      color: 'var(--dsw-alias-label-primary)',
      cursor: 'pointer',
      fontSize: '13px'
    }
    const HINT_STYLE = { margin: 0, fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' }
    // A text input and a select share the same box; keep one object so the two
    // never drift apart on a future style tweak.
    const INPUT_STYLE = SELECT_STYLE

    function fieldRow(text, control) {
      return h(
        'label',
        { style: { display: 'grid', gap: '6px', fontSize: '13px' } },
        h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, text),
        control
      )
    }

    /** Model actually in force on a record; falls back to the record's route. */
    function lastRunModelOf(record) {
      if (record === null || typeof record !== 'object') return ''
      if (typeof record.model === 'string' && record.model.trim() !== '') return record.model
      const route = record.route
      if (route !== null && typeof route === 'object' && typeof route.provider === 'string' && typeof route.model === 'string') {
        return `${route.provider}/${route.model}`
      }
      return ''
    }

    /**
     * Read-only info block under the engine line: which model / step / expert /
     * skills the newest delegation actually ran with. Rendered from the
     * last-run record only — no inputs, no actions, and the rest of the card's
     * layout is untouched. Missing fields degrade to a single status line.
     */
    function lastRunBlock(t, lastRun) {
      const record = lastRun !== null && typeof lastRun === 'object' && lastRun.record !== null && typeof lastRun.record === 'object'
        ? lastRun.record
        : null
      const lines = []
      if (lastRun !== null && typeof lastRun === 'object' && lastRun.status === 'ready' && record !== null) {
        const model = lastRunModelOf(record)
        lines.push(`${label(t, 'lastRunModel')}: ${model === '' ? '-' : model}`)
        // The host records why the delegation ended the way it did
        // (pinned/failed/failover + reason). A failed or switched run used to
        // read exactly like a successful one here, which is the one question a
        // user asks after a model error.
        const outcome = typeof record.outcome === 'string' ? record.outcome.trim() : ''
        const reason = typeof record.reason === 'string' ? record.reason.trim() : ''
        if (outcome !== '' && outcome !== 'pinned') {
          const detail = reason === ''
            ? `${label(t, 'lastRunOutcome')}: ${outcome}`
            : `${label(t, 'lastRunOutcome')}: ${outcome} · ${label(t, 'lastRunReason')}: ${reason}`
          lines.push(detail)
        }
        if (typeof record.at === 'string' && record.at.trim() !== '') {
          const stamp = Date.parse(record.at)
          const shown = Number.isNaN(stamp) ? record.at.trim() : new Date(stamp).toLocaleString()
          lines.push(`${label(t, 'lastRunAt')}: ${shown}`)
        }
        if (typeof record.step === 'string' && record.step.trim() !== '') lines.push(`${label(t, 'lastRunStep')}: ${record.step}`)
        if (typeof record.expert === 'string' && record.expert.trim() !== '') lines.push(`${label(t, 'lastRunExpert')}: ${record.expert}`)
        if (Array.isArray(record.skills)) {
          const skills = record.skills.filter((skill) => typeof skill === 'string' && skill.trim() !== '')
          if (skills.length > 0) lines.push(`${label(t, 'lastRunSkills')}: ${skills.join(label(t, 'listSep'))}`)
        }
      } else if (lastRun !== null && typeof lastRun === 'object' && lastRun.status === 'ready') lines.push(label(t, 'lastRunNone'))
      else if (lastRun !== null && typeof lastRun === 'object' && lastRun.status === 'unavailable') lines.push(label(t, 'lastRunUnavailable'))
      else lines.push(label(t, 'lastRunPending'))
      return h(
        'div',
        {
          'data-testid': 'last-run',
          style: {
            display: 'grid',
            gap: '4px',
            fontSize: '13px',
            borderTop: '1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,0.25))',
            paddingTop: '8px'
          }
        },
        h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, label(t, 'lastRunLabel')),
        ...lines.map((line) => h('span', {}, line))
      )
    }

    function DelegationHubCard(props) {
      const t = props.t
      const face = props.face
      const state = React.useSyncExternalStore(face.store.subscribe, face.store.get, face.store.get)
      const lastRun = React.useSyncExternalStore(lastRunStore.subscribe, lastRunStore.get, lastRunStore.get)
      const rows = candidates(state.catalog.groups, state.saved)
      const stepIssueList = stepIssues(state.draft.steps, state.catalog, rows)
      const flaggedStepCount = stepIssueList.reduce((total, issues) => total + (issues.length > 0 ? 1 : 0), 0)
      const providers = []
      for (const row of rows) {
        if (!providers.some((entry) => entry.id === row.provider)) {
          providers.push({ id: row.provider, name: row.providerName })
        }
      }
      const models = rows.filter((row) => row.provider === state.draft.provider)
      const editable = state.writable && state.status === 'ready' && !state.saving
      const dirty = !sameRoute(state.draft, state.saved)
      // Effort options for the main route: declared by the selected model when
      // the catalog knows it, generic list otherwise.
      const mainEffort = declaredEfforts(state.catalog.groups, state.draft.provider, state.draft.model)
      const mainEffortOptions =
        mainEffort === undefined
          ? { efforts: undefined, declared: undefined, defaultEffort: undefined, stale: undefined }
          : mainEffort === null
            ? { efforts: [], declared: null, defaultEffort: undefined, stale: state.draft.reasoningEffort }
            : { ...mainEffort, stale: state.draft.reasoningEffort }
      let status = ''
      if (state.catalog.status === 'loading') status = label(t, 'catalogLoading')
      else if (state.catalog.status === 'error') status = label(t, 'catalogFailed')
      else if (rows.length === 0) status = label(t, 'noModels')
      else if (state.conflict) status = label(t, 'conflict')
      else if (state.precheck !== null)
        status = (state.precheck.kind === 'provider' ? label(t, 'precheckProvider') : label(t, 'precheckModel'))
          .replace('{provider}', state.draft.provider)
          .replace('{model}', state.draft.model)
      else if (state.needCatalog) status = label(t, 'needCatalog')
      else if (state.stepBlocked) status = label(t, 'stepsFixCount').replace('{count}', String(flaggedStepCount))
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
          label(t, 'effort'),
          effortSelect(t, state.draft.reasoningEffort, mainEffortOptions, (value) => face.actions.setEffort(value), !editable)
        ),
        state.draft.provider !== '' && state.draft.model !== '' && mainEffort === null
          ? h('p', { style: HINT_STYLE }, label(t, 'effortNoneHint'))
          : state.draft.provider !== '' && state.draft.model !== '' && mainEffort === undefined && state.catalog.status === 'ready' && state.catalog.groups.length > 0
            ? h('p', { style: HINT_STYLE }, label(t, 'effortFallbackHint'))
            : null,
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
          'label',
          { style: { display: 'flex', gap: '8px', alignItems: 'center', fontSize: '13px' } },
          h('input', {
            type: 'checkbox',
            checked: state.draft.failoverProvider !== '' && state.draft.failoverModel !== '',
            disabled: !editable,
            onChange: (event) => {
              if (event.currentTarget.checked) {
                // Default the failover lane to the main route; the user can
                // then re-point either dropdown without touching the checkbox.
                face.actions.setFailover(state.draft.provider, state.draft.model)
              } else {
                face.actions.setFailover('', '')
              }
            }
          }),
          h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, label(t, 'failoverToggle'))
        ),
        state.draft.failoverProvider !== '' || state.draft.failoverModel !== ''
          ? h('div', { style: { display: 'grid', gap: '8px' } },
              fieldRow(
                `${label(t, 'failoverLabel')} · ${label(t, 'provider')}`,
                h(
                  'select',
                  {
                    style: SELECT_STYLE,
                    value: state.draft.failoverProvider,
                    disabled: !editable,
                    onChange: (event) => face.actions.setFailover(event.currentTarget.value, state.draft.failoverModel)
                  },
                  h('option', { value: '' }, '—'),
                  providers.map((provider) => h('option', { key: provider.id, value: provider.id }, provider.name))
                )
              ),
              fieldRow(
                `${label(t, 'failoverLabel')} · ${label(t, 'model')}`,
                h(
                  'select',
                  {
                    style: SELECT_STYLE,
                    value: state.draft.failoverModel,
                    disabled: !editable,
                    onChange: (event) => face.actions.setFailover(state.draft.failoverProvider, event.currentTarget.value)
                  },
                  h('option', { value: '' }, '—'),
                  rows
                    .filter((candidate) => candidate.provider === state.draft.failoverProvider)
                    .map((candidate) =>
                      h(
                        'option',
                        { key: `fo-${candidate.provider}/${candidate.model}`, value: candidate.model },
                        candidate.modelName
                      )
                    )
                )
              ),
              h('p', { style: HINT_STYLE }, label(t, 'failoverHint'))
            )
          : null,
        h(
          'p',
          { style: { margin: 0, fontSize: '13px', color: 'var(--dsw-alias-label-primary)', fontWeight: 600 } },
          label(t, 'stepsLabel'),
          flaggedStepCount > 0
            ? h(
                'span',
                { style: { marginLeft: '8px', fontWeight: 400, color: 'var(--dsw-alias-warning, #f0b429)' } },
                label(t, 'stepsFixCount').replace('{count}', String(flaggedStepCount))
              )
            : null
        ),
        ...(state.draft.steps ?? []).map((row, index) => {
          const issues = stepIssueList[index] ?? []
          const flagged = issues.length > 0
          return h(
            'div',
            {
              key: `step-${index}`,
              ...(flagged ? { 'data-step-issues': issues.join(',') } : {}),
              style: {
                display: 'grid',
                gap: '6px',
                padding: '6px 0',
                borderBottom: '1px solid var(--dsw-alias-border-l2)',
                ...(flagged
                  ? {
                      background: 'var(--dsw-alias-bg-warning-subtle, rgba(245, 180, 0, 0.14))',
                      borderLeft: '3px solid var(--dsw-alias-warning, #f0b429)',
                      paddingLeft: '8px'
                    }
                  : {})
              }
            },
            h(
              'div',
              { style: { display: 'grid', gridTemplateColumns: 'minmax(140px, 1.4fr) minmax(0, 1fr) minmax(0, 1fr) auto', gap: '8px', alignItems: 'center' } },
              h('input', {
                placeholder: label(t, 'stepsNamePlaceholder'),
                value: row.name,
                disabled: !editable,
                maxLength: 40,
                style: { ...INPUT_STYLE, minWidth: 0 },
                onChange: (event) => face.actions.setStep(index, { name: event.currentTarget.value })
              }),
              h(
                'select',
                {
                  style: SELECT_STYLE,
                  value: row.provider,
                  disabled: !editable,
                  onChange: (event) => face.actions.setStep(index, { provider: event.currentTarget.value, model: '' })
                },
                h('option', { value: '' }, '—'),
                providers.map((provider) => h('option', { key: provider.id, value: provider.id }, provider.name))
              ),
              h(
                'select',
                {
                  style: SELECT_STYLE,
                  value: row.model,
                  disabled: !editable,
                  onChange: (event) => face.actions.setStep(index, { model: event.currentTarget.value })
                },
                h('option', { value: '' }, '—'),
                rows
                  .filter((candidate) => candidate.provider === row.provider)
                  .map((candidate) => h('option', { key: `${index}-${candidate.provider}/${candidate.model}`, value: candidate.model }, candidate.modelName))
              ),
              h(
                'button',
                {
                  type: 'button',
                  style: BUTTON_STYLE,
                  disabled: !editable,
                  onClick: () => face.actions.removeStep(index)
                },
                label(t, 'stepsRemove')
              )
            ),
            h(
              'div',
              { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr) minmax(90px, 0.8fr)', gap: '8px' } },
              h('input', {
                placeholder: label(t, 'stepsExpertPlaceholder'),
                value: row.expert ?? '',
                disabled: !editable,
                maxLength: 60,
                style: { ...INPUT_STYLE, minWidth: 0 },
                onChange: (event) => face.actions.setStep(index, { expert: event.currentTarget.value })
              }),
              h('input', {
                placeholder: label(t, 'stepsSkillsPlaceholder'),
                value: row.skills ?? '',
                disabled: !editable,
                maxLength: 120,
                style: { ...INPUT_STYLE, minWidth: 0 },
                onChange: (event) => face.actions.setStep(index, { skills: event.currentTarget.value })
              }),
              effortSelect(
                t,
                row.reasoningEffort ?? '',
                (() => {
                  const declared = declaredEfforts(state.catalog.groups, row.provider, row.model)
                  return declared === undefined
                    ? { efforts: undefined, declared: undefined, defaultEffort: undefined, stale: row.reasoningEffort ?? '' }
                    : declared === null
                      ? { efforts: [], declared: null, defaultEffort: undefined, stale: row.reasoningEffort ?? '' }
                      : { ...declared, stale: row.reasoningEffort ?? '' }
                })(),
                (value) => face.actions.setStepEffort(index, value),
                !editable
              )
            ),
            flagged
              ? h(
                  'span',
                  { style: { fontSize: '12px', color: 'var(--dsw-alias-warning, #f0b429)' } },
                  issues.map((issue) => label(t, STEP_ISSUE_LABELS[issue])).join(label(t, 'listSep'))
                )
              : null
          )
        }),
        h(
          'button',
          {
            type: 'button',
            style: BUTTON_STYLE,
            disabled: !editable,
            onClick: () => face.actions.addStep()
          },
          label(t, 'stepsAdd')
        ),
        h('p', { style: HINT_STYLE }, label(t, 'stepsHint')),
        h(
          'p',
          { style: HINT_STYLE },
          `${label(t, 'rolesLabel')}: ${label(t, 'rolesHint')}`
        ),
        h(
          'p',
          { style: HINT_STYLE },
          `${label(t, 'engineLabel')}: ${engineText}`
        ),
        lastRunBlock(t, lastRun),
        h(
          'div',
          { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
          h(
            'button',
            {
              type: 'button',
              style: BUTTON_STYLE,
              disabled: !editable || !dirty,
              onClick: () => void face.actions.save(flaggedStepCount)
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
        'delegation-hub: dictionaries'
      )
      const controller = createController(ctx)
      const face = { store: controller.store, actions: controller.actions }
      ctx.effect(() => () => controller.actions.dispose(), 'delegation-hub: form subscription')
      // Fetch the newest run record once per mount (and again on remount, so a
      // stale page never keeps showing a record from an earlier generation).
      ctx.effect(() => {
        void loadLastRun()
        return () => {}
      }, 'delegation-hub: last-run')
      const onRemote = (event, handler) => {
        const subscribe = ctx.remote?.$on
        return typeof subscribe === 'function' ? subscribe.call(ctx.remote, event, handler) : () => {}
      }
      ctx.effect(() => onRemote('llm/adapters-updated', () => controller.actions.retryCatalog()), 'delegation-hub: adapter invalidations')
      ctx.effect(
        () => onRemote('settings/document-updated', () => controller.actions.retryCatalog()),
        'delegation-hub: settings invalidations'
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
                id: 'delegation-hub',
                order: 36,
                label: () => t('title'),
                locale: NS
              },
              (props) => h(DelegationHubCard, Object.assign({}, props, { face, t }))
            )
          ),
        'delegation-hub: settings section'
      )
    }

    return { apply, inject, name: 'delegation-hub' }
  }
})
