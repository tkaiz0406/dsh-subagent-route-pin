/**
 * Offline harness for the browser half (client.js).
 *
 * Loads the bundle exactly the way the client module loader does — a global
 * `window.__ModuleLoader__` plus a `require` for react — then runs `apply()`
 * against a fake browser plugin context and drives one save, so the config-form
 * wiring is exercised without a running DSH web client:
 *   node test/client.mjs
 */

import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${detail}`}`)
  }
}

/**
 * Find the save button in a rendered element tree and return it.
 *
 * The fake React here returns plain `{ type, props, children }` nodes, so a
 * depth-first walk is enough. The button is identified by its label text —
 * the card renders `saving ? '保存中…' : '保存'` — so this helper must be called
 * on a card that is not mid-save.
 */
function findSaveButton(node) {
  if (node === null || typeof node !== 'object') return undefined
  const children = Array.isArray(node.children) ? node.children : []
  const text = children.filter((child) => typeof child === 'string').join('')
  if (node.type === 'button' && text === '保存') return node
  for (const child of children) {
    const found = findSaveButton(child)
    if (found !== undefined) return found
  }
  return undefined
}

/** Test-side mirror of the card's dirty rule (sameRoute + sameSteps). */
function sameRouteLike(left, right) {
  const la = (Array.isArray(left.steps) ? left.steps : []).filter((row) => row?.fresh !== true)
  const ra = (Array.isArray(right.steps) ? right.steps : []).filter((row) => row?.fresh !== true)
  const stepsEq =
    la.length === ra.length &&
    la.every(
      (row, i) =>
        row.name === ra[i].name &&
        row.provider === ra[i].provider &&
        row.model === ra[i].model &&
        (row.reasoningEffort ?? '') === (ra[i].reasoningEffort ?? '') &&
        (row.expert ?? '') === (ra[i].expert ?? '') &&
        (row.skills ?? '') === (ra[i].skills ?? '')
    )
  return (
    left.provider === right.provider &&
    left.model === right.model &&
    left.reasoningEffort === right.reasoningEffort &&
    left.teamInjection === right.teamInjection &&
    left.failoverProvider === right.failoverProvider &&
    left.failoverModel === right.failoverModel &&
    stepsEq
  )
}

// --- load the bundle the way the host does --------------------------------
let loaded
const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot()
}
// The panel reads the host's same-origin last-run route; the fake answers with
// a recorded delegation (or fails on demand) so the info block can be asserted.
const fetchCalls = []
let fetchMode = 'record'
let lastRunFixture = {
  model: 'our-free-model/deepseek-v4.1-flash-free',
  step: 'research',
  expert: '代码审查工程师',
  skills: ['aik_auto_memory_use', 'leanrea-win']
}
let optionsFixture = {
  experts: [
    { slug: 'frontend-developer', name: 'Frontend Developer', emoji: '✨', description: 'UI specialist', division: 'engineering' },
    { slug: 'product-manager', name: '产品经理', emoji: '🧭', description: 'PM', division: 'product' }
  ],
  skills: [
    { name: 'need-subagent', description: 'decision skill' },
    { name: 'leanrea-win', description: 'RE quick path' }
  ]
}
const fakeFetch = async (url) => {
  fetchCalls.push(String(url))
  if (fetchMode === 'missing') return { ok: false, status: 404 }
  if (String(url) === '/delegation-hub/options') {
    return { ok: true, json: async () => (fetchMode === 'empty' ? {} : optionsFixture) }
  }
  return { ok: true, json: async () => (fetchMode === 'empty' ? {} : lastRunFixture) }
}
const sandbox = {
  window: {
    __ModuleLoader__: {
      load: (definition) => {
        loaded = definition
      }
    }
  },
  require: (id) => {
    if (id === 'react') return React
    throw new Error(`unexpected require(${id})`)
  },
  console,
  fetch: fakeFetch
}
runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), sandbox)

check('loader registration', loaded !== undefined && loaded.id === 'dsh-delegation-hub', loaded?.id)
const module_ = loaded.factory(sandbox.require)
check('module name', module_.name === 'delegation-hub', module_.name)
check(
  'injects the client services it uses',
  ['slots', 'locale', 'remote', 'configForms'].every((name) => module_.inject.includes(name)),
  JSON.stringify(module_.inject)
)

// --- fake browser plugin context -----------------------------------------
function makeContext(options = {}) {
  const state = {
    registered: [],
    injections: [],
    mutations: [],
    catalogCalls: 0,
    dictionary: undefined,
    effects: [],
    localeBinds: []
  }
  let value = options.value ?? { provider: '', model: '', reasoningEffort: '' }
  let revision = options.revision ?? 7
  const listeners = new Set()
  const status = options.status ?? 'ready'
  const form = {
    getSnapshot: () => ({ status, writable: options.writable ?? true, revision, value }),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async mutate(ops, expectedRevision) {
      if (options.mutateThrows === true) throw new Error('nope')
      state.mutations.push({ ops, expectedRevision })
      const next = { ...value }
      for (const op of ops) next[op.path[0]] = op.value
      value = next
      revision += 1
      for (const listener of [...listeners]) listener()
    }
  }
  const ctx = {
    locale: {
      bind: (namespace) => {
        state.localeBinds.push(namespace)
        return (key) => (state.dictionary?.[key] ?? key)
      },
      register: (namespace, dictionaries) => {
        state.dictionary = dictionaries.zh
        return () => {}
      }
    },
    effect: (factory, label) => {
      const dispose = factory()
      state.effects.push({ label, dispose })
      return () => {}
    },
    configForms: {
      get: (namespace) => (state.requested ?? namespace) === namespace ? state.forms?.[namespace] : state.forms?.[namespace],
      whileServed: (namespaces, effect) => {
        state.servedNamespaces = namespaces
        return effect()
      }
    },
    slots: {
      inject: (name, effect) => {
        state.injections.push(name)
        return effect()
      },
      register: (options, component) => {
        state.registered.push({ options, component })
        return () => {}
      }
    },
    remote: {
      $on: (event, listener) => {
        state.events ??= []
        state.events.push(event)
        void listener
        return () => {}
      },
      session: {
        modelCatalog: async () => {
          state.catalogCalls += 1
          return {
            ok: true,
            value: {
              groups: [
                { id: 'our-free-model', name: 'Our Free Model', models: [{ id: 'deepseek-v4.1-flash-free', name: 'DeepSeek V4.1 Flash' }] },
                {
                  id: 'deepseek-account',
                  name: 'DeepSeek Account',
                  models: [
                    {
                      id: 'deepseek-flash',
                      name: 'DeepSeek Flash',
                      reasoning: {
                        efforts: [
                          { id: 'low', name: '低' },
                          { id: 'high', name: '高' },
                          { id: 'max', name: '极高' }
                        ],
                        defaultEffort: 'high'
                      }
                    },
                    { id: 'deepseek-pro', name: 'DeepSeek Pro', reasoning: { efforts: [{ id: 'high', name: '高' }] } }
                  ]
                }
              ],
              failures: []
            }
          }
        }
      }
    }
  }
  state.forms = { 'delegation-hub': form }
  return { ctx, state }
}

// --- the page is a settings section, registered without a served form -----
{
  const { ctx, state } = makeContext({ value: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'medium' } })
  module_.apply(ctx, {})
  check(
    'registers one settings.section page',
    state.registered.length === 1 && state.registered[0].options.name === 'settings.section',
    JSON.stringify(state.registered.map((entry) => entry.options?.name))
  )
  const page = state.registered[0]
  check('page id', page.options.id === 'delegation-hub', page.options.id)
  check('page is a component', typeof page.component === 'function')
  check('page label resolves through the dictionary', page.options.label() === '委派中枢', page.options.label())
  check('page declares its locale', page.options.locale === 'settings.delegation-hub', page.options.locale)
  check('subscriptions attached', state.events?.includes('llm/adapters-updated') === true, JSON.stringify(state.events))
  await new Promise((resolve) => setImmediate(resolve))
  check('catalog fetched once', state.catalogCalls === 1, String(state.catalogCalls))
}

// --- the injected face mirrors the accepted value -------------------------
{
  let current = { provider: 'our-free-model', model: 'deepseek-v4.1-flash-free', reasoningEffort: 'high' }
  let revision = 3
  const listeners = new Set()
  const { ctx, state } = makeContext()
  state.forms['delegation-hub'] = {
    getSnapshot: () => ({ status: 'ready', writable: true, revision, value: current }),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async mutate(ops, expectedRevision) {
      state.mutations.push({ ops, expectedRevision })
      const next = { ...current }
      for (const op of ops) next[op.path[0]] = op.value
      current = next
      revision += 1
      for (const listener of [...listeners]) listener()
    }
  }
  module_.apply(ctx, {})
  // The page is a settings section with no serve-time gate; the card face is
  // handed to it as a prop when the section renders.
  const face = state.registered[0].component({}).props.face
  const snapshot = () => face.store.get()
  check('face starts from the accepted route', snapshot().saved.provider === 'our-free-model' && snapshot().saved.model === 'deepseek-v4.1-flash-free', JSON.stringify(snapshot().saved))
  check('face is not dirty initially', snapshot().touched === false, JSON.stringify(snapshot()))
  await new Promise((resolve) => setImmediate(resolve))
  face.actions.setProvider('deepseek-account')
  check('provider change selects its first model', snapshot().draft.provider === 'deepseek-account' && snapshot().draft.model === 'deepseek-flash', JSON.stringify(snapshot().draft))
  check('a supported effort survives the model switch', snapshot().draft.reasoningEffort === 'high', JSON.stringify(snapshot().draft))
  face.actions.setModel('deepseek-flash')
  face.actions.setEffort('high')
  await face.actions.save()
  const mutation = state.mutations.at(-1)
  const routeOps = mutation.ops.filter((op) => ['provider', 'model', 'reasoningEffort'].includes(op.path[0]))
  check('save sends the three route field ops + the revision', routeOps.length === 3 && mutation.expectedRevision === 3 && routeOps.find((op) => op.path[0] === 'reasoningEffort')?.value === 'high', JSON.stringify(mutation))
  check('saved route lands', snapshot().saved.provider === 'deepseek-account' && snapshot().saved.model === 'deepseek-flash', JSON.stringify(snapshot().saved))
  check('landed flag set', snapshot().landed === true, JSON.stringify({ failed: snapshot().failed, landed: snapshot().landed }))
  check('no longer dirty', snapshot().touched === false, JSON.stringify(snapshot().touched))
}

// --- catalog preflight: an unadvertised model blocks the first save -------
{
  const { ctx, state } = makeContext({ value: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: '' } })
  module_.apply(ctx, {})
  const face = state.registered[0].component({}).props.face
  const snapshot = () => face.store.get()
  await new Promise((resolve) => setImmediate(resolve))
  face.actions.setProvider('deepseek-account')
  face.actions.setModel('not-in-catalog')
  await face.actions.save()
  const blocked = state.mutations.length === 0
  check('unadvertised model blocks the first save', blocked, JSON.stringify(state.mutations))
  check(
    'precheck names the model mismatch',
    snapshot().precheck?.kind === 'model' && snapshot().precheck !== null,
    JSON.stringify(snapshot().precheck)
  )
  // Saving again forces the row through: the catalog is advisory.
  await face.actions.save()
  const mutation = state.mutations.at(-1)
  check(
    'second save forces the unadvertised model through',
    mutation !== undefined && mutation.ops.some((op) => op.path[0] === 'model' && op.value === 'not-in-catalog'),
    JSON.stringify(mutation)
  )
  check('precheck cleared after a forced save', snapshot().precheck === null, JSON.stringify(snapshot().precheck))
  // Switching the provider clears the warning and re-enables normal saves.
  face.actions.setModel('also-missing')
  await face.actions.save()
  check('provider/model change re-arms the precheck', snapshot().precheck?.kind === 'model', JSON.stringify(snapshot().precheck))
  face.actions.setProvider('our-free-model')
  check('provider change clears the precheck', snapshot().precheck === null, JSON.stringify(snapshot().precheck))
  await face.actions.save()
  check(
    'advertised provider/model saves without friction',
    snapshot().saved.provider === 'our-free-model' && snapshot().saved.model === 'deepseek-v4.1-flash-free',
    JSON.stringify(snapshot().saved)
  )
}

// --- failover lane: checkbox arms the route, save serializes the object ---
{
  const { ctx, state } = makeContext({ value: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: '' } })
  module_.apply(ctx, {})
  const face = state.registered[0].component({}).props.face
  const snapshot = () => face.store.get()
  await new Promise((resolve) => setImmediate(resolve))
  // Arming defaults the lane to the current draft route.
  face.actions.setFailover('our-free-model', 'deepseek-v4.1-flash-free')
  check(
    'failover lane armed with explicit routes',
    snapshot().draft.failoverProvider === 'our-free-model' && snapshot().draft.failoverModel === 'deepseek-v4.1-flash-free',
    JSON.stringify(snapshot().draft)
  )
  await face.actions.save()
  const failoverOp = state.mutations.at(-1).ops.find((op) => op.path[0] === 'failoverRoute')
  check(
    'save serializes failoverRoute as one object op',
    failoverOp !== undefined && failoverOp.value.provider === 'our-free-model' && failoverOp.value.model === 'deepseek-v4.1-flash-free',
    JSON.stringify(failoverOp)
  )
  check(
    'accepted route mirrors the failover lane back',
    snapshot().saved.failoverProvider === 'our-free-model' && snapshot().saved.failoverModel === 'deepseek-v4.1-flash-free',
    JSON.stringify(snapshot().saved)
  )
  // Disarming clears both selects and the next save omits the op entirely.
  face.actions.setFailover('', '')
  await face.actions.save()
  const lastOps = state.mutations.at(-1).ops
  check(
    'disarmed failover omits the route op',
    lastOps.every((op) => op.path[0] !== 'failoverRoute'),
    JSON.stringify(lastOps.map((op) => op.path[0]))
  )
}

// --- steps editor: rows serialize into one steps object op ---------------
{
  const { ctx, state } = makeContext({ value: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: '', steps: null } })
  module_.apply(ctx, {})
  const face = state.registered[0].component({}).props.face
  const snapshot = () => face.store.get()
  await new Promise((resolve) => setImmediate(resolve))
  face.actions.addStep()
  face.actions.setStep(0, { name: 'research', provider: 'our-free-model', model: 'deepseek-v4.1-flash-free' })
  face.actions.addStep()
  face.actions.setStep(1, { name: 'code', provider: 'deepseek-account', model: 'deepseek-pro' })
  await face.actions.save()
  const stepsOp = state.mutations.at(-1).ops.find((op) => op.path[0] === 'stepsJson')
  const stepsValue = stepsOp === undefined ? undefined : JSON.parse(stepsOp.value)
  check(
    'save serializes the steps map as one object op',
    stepsValue !== undefined &&
      stepsValue.research.provider === 'our-free-model' &&
      stepsValue.code.model === 'deepseek-pro',
    JSON.stringify(stepsOp)
  )
  check(
    'accepted route mirrors the steps rows back',
    snapshot().saved.steps.length === 2 && snapshot().saved.steps[0].name === 'research',
    JSON.stringify(snapshot().saved.steps)
  )
  // Removing both rows after they were stored must CLEAR the document row:
  // omitting the op would leave the old stepsJson in place and the deleted
  // rows would resurrect on the next sync. The host treats '' as absent.
  face.actions.removeStep(0)
  face.actions.removeStep(0)
  await face.actions.save()
  const lastOps = state.mutations.at(-1).ops
  const lastClear = lastOps.find((op) => op.path[0] === 'stepsJson')
  check(
    'no rows means an explicit empty-string clear op',
    lastClear !== undefined && lastClear.value === '',
    JSON.stringify(lastOps.map((op) => op.path[0]))
  )
}

// --- expert/skills edits mark the card dirty and reach the save op ---------
{
  const { ctx, state } = makeContext({ value: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: '', steps: null } })
  module_.apply(ctx, {})
  const face = state.registered[0].component({}).props.face
  const snapshot = () => face.store.get()
  await new Promise((resolve) => setImmediate(resolve))
  face.actions.addStep()
  face.actions.setStep(0, { name: 'review', provider: 'deepseek-account', model: 'deepseek-pro' })
  await face.actions.save()
  // Saved baseline now carries the row. Editing ONLY expert/skills must flip
  // dirty (the save button enables) and the fields must land in stepsJson.
  const savedRow = snapshot().saved.steps[0]
  face.actions.setStep(0, { expert: '代码审查工程师', skills: 'aik_auto_memory_use, leanrea-win' })
  const dirtyState = face.store.get()
  check(
    'expert/skills-only edit flips dirty (sameSteps compares the new fields)',
    dirtyState.touched === true &&
      dirtyState.draft.steps[0].expert === '代码审查工程师' &&
      !sameRouteLike(dirtyState.draft, dirtyState.saved),
    JSON.stringify({ dirtyCheck: sameRouteLike(dirtyState.draft, dirtyState.saved), touched: dirtyState.touched })
  )
  await face.actions.save()
  const op = state.mutations.at(-1).ops.find((entry) => entry.path[0] === 'stepsJson')
  const lane = op === undefined ? undefined : JSON.parse(op.value).review
  check(
    'expert/skills-only edit serializes into stepsJson',
    lane !== undefined && lane.expert === '代码审查工程师' &&
      Array.isArray(lane.skills) && lane.skills.length === 2,
    JSON.stringify(op)
  )
}

// --- removing every row sends an explicit clear op -------------------------
{
  const { ctx, state } = makeContext({
    value: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: '', stepsJson: JSON.stringify({ research: { provider: 'a', model: 'b' } }) }
  })
  module_.apply(ctx, {})
  const face = state.registered[0].component({}).props.face
  const snapshot = () => face.store.get()
  await new Promise((resolve) => setImmediate(resolve))
  // The stored stepsJson parses into one editor row.
  check(
    'stored stepsJson renders one editor row',
    snapshot().draft.steps.length === 1 && snapshot().draft.steps[0].name === 'research',
    JSON.stringify(snapshot().draft.steps)
  )
  face.actions.removeStep(0)
  await face.actions.save()
  const ops = state.mutations.at(-1).ops
  const clearOp = ops.find((entry) => entry.path[0] === 'stepsJson')
  check(
    'removing all rows sends an explicit empty-string clear op',
    clearOp !== undefined && clearOp.value === '',
    JSON.stringify(ops)
  )
}

// --- empty catalog: saving with empty selects explains itself -------------
{
  const { ctx, state } = makeContext({ value: { provider: '', model: '', reasoningEffort: '' } })
  module_.apply(ctx, {})
  const face = state.registered[0].component({}).props.face
  const snapshot = () => face.store.get()
  await new Promise((resolve) => setImmediate(resolve))
  await face.actions.save()
  check(
    'empty-select save surfaces needCatalog instead of dying silently',
    snapshot().needCatalog === true && state.mutations.length === 0,
    JSON.stringify({ needCatalog: snapshot().needCatalog, mutations: state.mutations.length })
  )
}

// --- last-run info block: the card shows the effective delegation ---------
{
  const { ctx, state } = makeContext({ value: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: '' } })
  module_.apply(ctx, {})
  await new Promise((resolve) => setImmediate(resolve))
  check(
    'panel fetches the last-run record on apply',
    fetchCalls.includes('/delegation-hub/last-run'),
    JSON.stringify(fetchCalls)
  )
  const page = state.registered[0].component({})
  const rendered = JSON.stringify(page.type(page.props))
  check(
    'panel shows the effective model of the last delegation',
    rendered.includes('our-free-model/deepseek-v4.1-flash-free'),
    rendered.slice(0, 600)
  )
  check(
    'panel shows step/expert/skills of the last delegation',
    rendered.includes('research') &&
      rendered.includes('代码审查工程师') &&
      rendered.includes('aik_auto_memory_use、leanrea-win'),
    rendered.slice(0, 600)
  )
  // A missing record (404) degrades to explanatory copy, never a crash.
  fetchMode = 'missing'
  const next = makeContext({ value: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: '' } })
  module_.apply(next.ctx, {})
  await new Promise((resolve) => setImmediate(resolve))
  const nextPage = next.state.registered[0].component({})
  const nextRendered = JSON.stringify(nextPage.type(nextPage.props))
  check(
    'panel explains a missing last-run record instead of crashing',
    nextRendered.includes('读取委派记录失败') && !nextRendered.includes('our-free-model/deepseek-v4.1-flash-free'),
    nextRendered.slice(0, 600)
  )
  fetchMode = 'record'
}

// --- last-run block renders the outcome, the reason and the timestamp -----
// The host writes outcome/reason/at into the record; a failed or switched run
// must not read exactly like a successful one.
{
  lastRunFixture = { model: 'our-free-model/deepseek-v4.1-flash-free', outcome: 'failed', reason: 'QUOTA', at: '2026-11-09T02:50:43.466Z' }
  const { ctx, state } = makeContext({ value: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: '' } })
  module_.apply(ctx, {})
  await new Promise((resolve) => setImmediate(resolve))
  const page = state.registered[0].component({})
  const rendered = JSON.stringify(page.type(page.props))
  check(
    'last-run block shows the failure outcome and its reason',
    rendered.includes('结果: failed') && rendered.includes('原因: QUOTA'),
    rendered.slice(0, 700)
  )
  check(
    'last-run block shows when the delegation ran',
    rendered.includes('时间: ') && rendered.includes('2026'),
    rendered.slice(0, 700)
  )
  // A pinned run needs no extra line: the model line already says it worked.
  lastRunFixture = { model: 'our-free-model/deepseek-v4.1-flash-free', outcome: 'pinned' }
  const ok = makeContext({ value: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: '' } })
  module_.apply(ok.ctx, {})
  await new Promise((resolve) => setImmediate(resolve))
  const okPage = ok.state.registered[0].component({})
  const okRendered = JSON.stringify(okPage.type(okPage.props))
  check(
    'a pinned run renders no failure line',
    okRendered.includes('our-free-model/deepseek-v4.1-flash-free') &&
      !okRendered.includes('failed') &&
      !okRendered.includes('结果:'),
    okRendered.slice(0, 700)
  )
  lastRunFixture = {
    model: 'our-free-model/deepseek-v4.1-flash-free',
    step: 'research',
    expert: '代码审查工程师',
    skills: ['aik_auto_memory_use', 'leanrea-win']
  }
}

// --- step rows flag live issues and clear them on the fix (no save) ------
{
  const { ctx, state } = makeContext({ value: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: '', steps: null } })
  module_.apply(ctx, {})
  const face = state.registered[0].component({}).props.face
  await new Promise((resolve) => setImmediate(resolve))
  const render = () => {
    const page = state.registered[0].component({})
    return JSON.stringify(page.type(page.props))
  }
  // Row 1 is brand new: empty name and no provider/model yet. The fresh
  // placeholder raises NO issues — the old behavior painted the whole editor
  // yellow the moment 添加步骤 was clicked, and its save would skip the row
  // anyway. The first keystroke arms the checks for that row.
  face.actions.addStep()
  let rendered = render()
  check(
    'a freshly added step row is not flagged before any input',
    !rendered.includes('data-step-issues') && !rendered.includes('需要修正'),
    rendered.slice(0, 900)
  )
  face.actions.setStep(0, { name: '' })
  rendered = render()
  check(
    'after the first input the incomplete row is flagged yellow with a reason',
    rendered.includes('data-step-issues') &&
      rendered.includes('rgba(245, 180, 0, 0.14)') &&
      rendered.includes('步骤名不能为空') &&
      rendered.includes('提供商与模型都要选择'),
    rendered.slice(0, 900)
  )
  check(
    'flagged rows raise a fix count next to the steps label',
    rendered.includes('1 个步骤需要修正'),
    rendered.slice(0, 900)
  )
  // Fixing the fields clears the flag on the next render — no save involved.
  face.actions.setStep(0, { name: 'research', provider: 'our-free-model', model: 'deepseek-v4.1-flash-free' })
  rendered = render()
  check(
    'fixing the fields clears the flag without saving',
    !rendered.includes('data-step-issues') && !rendered.includes('1 个步骤需要修正'),
    rendered.slice(0, 900)
  )
  // A duplicated name (trimmed, case-insensitive) and a model the ready
  // catalog does not advertise flag their row with the matching reason.
  face.actions.addStep()
  face.actions.setStep(1, { name: ' research ', provider: 'our-free-model', model: 'not-in-catalog' })
  rendered = render()
  check(
    'duplicate name and off-catalog model flag the row with reasons',
    rendered.includes('步骤名重复') &&
      rendered.includes('模型不在当前目录') &&
      rendered.includes('2 个步骤需要修正'),
    rendered.slice(0, 900)
  )
  // An untouched placeholder row stays unflagged even while sibling rows are
  // flagged: the fix count counts only armed rows.
  face.actions.addStep()
  rendered = render()
  check(
    'a new untouched row among flagged rows stays unflagged',
    rendered.includes('2 个步骤需要修正') && !rendered.includes('3 个步骤需要修正'),
    rendered.slice(0, 900)
  )
}

// --- effort options follow the model's declared efforts ---------------------
{
  const { ctx, state } = makeContext({ value: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: '' } })
  module_.apply(ctx, {})
  const face = state.registered[0].component({}).props.face
  const snapshot = () => face.store.get()
  await new Promise((resolve) => setImmediate(resolve))
  const render = () => JSON.stringify(state.registered[0].component({}).type(state.registered[0].component({}).props))
  // deepseek-flash declares low/high/max with default high.
  let rendered = render()
  check(
    'declared efforts replace the generic list (medium/extra_high absent)',
    rendered.includes('value":"high"') && !rendered.includes('value":"medium"') && !rendered.includes('value":"extra_high"'),
    rendered.slice(0, 400)
  )
  check(
    'effort options carry the localized names and the default mark',
    rendered.includes('低（low）') && rendered.includes('（默认）'),
    rendered.slice(0, 400)
  )
  // Switching to a model that only declares high resets an unsupported value.
  face.actions.setEffort('low')
  check('a declared effort is selectable', snapshot().draft.reasoningEffort === 'low', JSON.stringify(snapshot().draft))
  face.actions.setModel('deepseek-pro')
  check(
    'switching models resets an effort the new model does not declare',
    snapshot().draft.model === 'deepseek-pro' && snapshot().draft.reasoningEffort === '',
    JSON.stringify(snapshot().draft)
  )
  rendered = render()
  check(
    'the single-effort model offers only that effort',
    rendered.includes('高（high）') && !rendered.includes('低（low）'),
    rendered.slice(0, 400)
  )
  // A model with no reasoning declaration at all: switching to it resets the
  // stored effort immediately (no effort options exist to keep).
  face.actions.setModel('deepseek-flash')
  face.actions.setEffort('max')
  check('max is declared by deepseek-flash', snapshot().draft.reasoningEffort === 'max', JSON.stringify(snapshot().draft))
  face.actions.setProvider('our-free-model')
  check(
    'undeclared-effort model resets the stored effort to empty',
    snapshot().draft.reasoningEffort === '',
    JSON.stringify(snapshot().draft)
  )
}

// --- a stale stored effort is rendered but marked, never silently snapped ---
{
  const { ctx, state } = makeContext({ value: { provider: 'deepseek-account', model: 'deepseek-pro', reasoningEffort: 'max' } })
  module_.apply(ctx, {})
  await new Promise((resolve) => setImmediate(resolve))
  const page = state.registered[0].component({})
  const rendered = JSON.stringify(page.type(page.props))
  check(
    'a stored effort the model does not declare renders marked as stale',
    rendered.includes('value":"max"') && rendered.includes('max（该模型未声明）'),
    rendered.slice(0, 500)
  )
}

// --- step rows: effort per step, reset on model change, serialized ----------
{
  const { ctx, state } = makeContext({ value: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: '', steps: null } })
  module_.apply(ctx, {})
  const face = state.registered[0].component({}).props.face
  const snapshot = () => face.store.get()
  await new Promise((resolve) => setImmediate(resolve))
  face.actions.addStep()
  face.actions.setStep(0, { name: 'review', provider: 'deepseek-account', model: 'deepseek-pro' })
  face.actions.setStepEffort(0, 'high')
  await face.actions.save()
  const op = state.mutations.at(-1).ops.find((entry) => entry.path[0] === 'stepsJson')
  const lane = op === undefined ? undefined : JSON.parse(op.value).review
  check(
    'step effort serializes into stepsJson and lands in the accepted route',
    lane !== undefined && lane.reasoningEffort === 'high' && snapshot().saved.steps[0].reasoningEffort === 'high',
    JSON.stringify(op)
  )
  face.actions.setStep(0, { model: 'deepseek-flash' })
  check(
    'switching a step model keeps an effort the new model declares',
    snapshot().draft.steps[0].reasoningEffort === 'high',
    JSON.stringify(snapshot().draft.steps[0])
  )
  face.actions.setStepEffort(0, 'max')
  face.actions.setStep(0, { model: 'deepseek-pro' })
  check(
    'switching a step model resets an effort the new model does not declare',
    snapshot().draft.steps[0].reasoningEffort === '',
    JSON.stringify(snapshot().draft.steps[0])
  )
}

// --- a flagged step row refuses the save instead of dropping it silently ---
// The serialization loop skips rows with an empty name or a missing
// provider/model. Before this guard the card still reported 「已保存」 and the
// yellow row was simply absent from stepsJson. The row must be armed by an
// input first: a fresh placeholder row raises no issues and cannot block.
{
  const { ctx, state } = makeContext({ value: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: '', steps: null } })
  module_.apply(ctx, {})
  const face = state.registered[0].component({}).props.face
  const snapshot = () => face.store.get()
  await new Promise((resolve) => setImmediate(resolve))
  face.actions.addStep()
  face.actions.setStep(0, { name: '' }) // arm the row: it now has an empty name
  const page = state.registered[0].component({})
  const flagged = page.type(page.props)
  // The card computes the flag count and hands it to the click handler.
  const saveButton = findSaveButton(flagged)
  check(
    'the save button passes the live flag count to the action',
    saveButton !== undefined && typeof saveButton.props.onClick === 'function',
    JSON.stringify(flagged).slice(0, 400)
  )
  const before = state.mutations.length
  await face.actions.save(1)
  check(
    'a flagged step row blocks the save (no mutate op is sent)',
    state.mutations.length === before,
    JSON.stringify({ before, after: state.mutations.length })
  )
  check(
    'the blocked save explains itself instead of claiming success',
    snapshot().stepBlocked === true && snapshot().landed === false,
    JSON.stringify({ stepBlocked: snapshot().stepBlocked, landed: snapshot().landed, failed: snapshot().failed })
  )
  const blockedRender = JSON.stringify(page.type(page.props))
  check(
    'the blocked status line names the number of rows to fix',
    blockedRender.includes('1 个步骤需要修正') && !blockedRender.includes('已保存'),
    blockedRender.slice(-700)
  )
  // Fixing the row unblocks the very same action — the guard must not latch.
  face.actions.setStep(0, { name: 'research', provider: 'our-free-model', model: 'deepseek-v4.1-flash-free' })
  await face.actions.save(0)
  check(
    'a clean step editor saves normally (the guard does not over-block)',
    state.mutations.length === before + 1 && snapshot().landed === true,
    JSON.stringify({ mutations: state.mutations.length, landed: snapshot().landed, stepBlocked: snapshot().stepBlocked })
  )
}

// --- layout: every select/input must size its box inside its grid cell -----
// The step-route row and the main route put width:100% controls inside
// minmax(0,1fr) grid tracks. Without box-sizing:border-box the default
// content-box adds padding+border on top of 100%, which pushes the control
// past its column edge and overlaps the neighbor in narrow settings panes.
// jsdom cannot measure real geometry, so this walks the rendered VDOM and
// asserts the declaration directly — a regression removing border-box is
// caught here even though we cannot see pixels.
{
  function walk(node, out) {
    if (node === null || typeof node !== 'object') return out
    const children = Array.isArray(node.children) ? node.children : [node.props?.children].filter((c) => c !== undefined && c !== null)
    // Only <select> controls live in a grid cell and share SELECT_STYLE:
    // checkbox <input>s are free-floating and legitimately carry no box sizing.
    if (node.type === 'select') out.push(node)
    for (const child of Array.isArray(children) ? children.flat(Infinity) : []) {
      if (child !== null && typeof child === 'object') walk(child, out)
    }
    return out
  }
  const { ctx, state } = makeContext({ value: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: '', steps: null } })
  module_.apply(ctx, {})
  const page = state.registered[0].component({})
  const root = page.type(page.props)
  const controls = walk(root, [])
  const styleOf = (node) => (node.props && node.props.style && typeof node.props.style === 'object' ? node.props.style : {})
  const noBorderBox = controls.filter((n) => styleOf(n).boxSizing !== 'border-box')
  check(
    'every select/input is sized border-box so 100% width cannot overflow its grid cell',
    controls.length > 0 && noBorderBox.length === 0,
    noBorderBox.length > 0 ? `controls without border-box: ${JSON.stringify(noBorderBox.map((n) => n.props?.style))}` : JSON.stringify({ controls: controls.length })
  )
}

// --- step editor combos: expert/skills inputs offer installed choices ------
// The host serves /delegation-hub/options with the Agency expert roster and
// the skill registry's names; the card wires them into per-row datalists so
// the dropdown offers installed values while free typing stays valid for
// anything not installed yet.
{
  function findByType(node, type, out) {
    if (node === null || typeof node !== 'object') return out
    if (node.type === type) out.push(node)
    const children = Array.isArray(node.children) ? node.children : node.props?.children
    for (const child of Array.isArray(children) ? children.flat(Infinity) : []) {
      if (child !== null && typeof child === 'object') findByType(child, type, out)
    }
    return out
  }
  const { ctx, state } = makeContext({ value: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: '', steps: null } })
  module_.apply(ctx, {})
  await new Promise((resolve) => setImmediate(resolve))
  const face = state.registered[0].component({}).props.face
  face.actions.addStep()
  face.actions.setStep(0, { name: 'review', provider: 'deepseek-account', model: 'deepseek-pro' })
  const page = state.registered[0].component({})
  const root = page.type(page.props)
  check(
    'the card fetches the options route once per mount',
    fetchCalls.includes('/delegation-hub/options'),
    JSON.stringify(fetchCalls)
  )
  const datalists = findByType(root, 'datalist', [])
  const optionNodes = findByType(root, 'option', []).filter((node) => typeof node.props?.value === 'string' && node.props.value !== '')
  const inputs = findByType(root, 'input', []).filter((node) => typeof node.props?.list === 'string')
  const expertList = datalists.find((node) => node.props?.id === 'delegation-hub-experts-0')
  const skillList = datalists.find((node) => node.props?.id === 'delegation-hub-skills-0')
  check(
    'step rows carry per-row datalists for experts and skills',
    expertList !== undefined && skillList !== undefined,
    JSON.stringify(datalists.map((node) => node.props?.id))
  )
  check(
    'expert datalist offers the agency roster values from the options route',
    expertList !== undefined &&
      optionNodes.some((node) => node.props.value === 'frontend-developer') &&
      optionNodes.some((node) => node.props.value === 'product-manager'),
    JSON.stringify(optionNodes.map((node) => node.props.value))
  )
  check(
    'skill datalist offers the registry skill names',
    skillList !== undefined && optionNodes.some((node) => node.props.value === 'need-subagent'),
    JSON.stringify(optionNodes.map((node) => node.props.value))
  )
  check(
    'the expert input points at its row datalist while staying freely typable',
    inputs.some((node) => node.props.list === 'delegation-hub-experts-0') && inputs.some((node) => node.props.list === 'delegation-hub-skills-0'),
    JSON.stringify(inputs.map((node) => node.props.list))
  )
  // A failing options route must degrade to the plain inputs, never break the card.
  fetchMode = 'missing'
  {
    const degraded = makeContext({ value: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: '', steps: null } })
    module_.apply(degraded.ctx, {})
    await new Promise((resolve) => setImmediate(resolve))
    const degradedFace = degraded.state.registered[0].component({}).props.face
    degradedFace.actions.addStep()
    degradedFace.actions.setStep(0, { name: 'review', provider: 'deepseek-account', model: 'deepseek-pro' })
    const page = degraded.state.registered[0].component({})
    const tree = page.type(page.props)
    const degradedLists = findByType(tree, 'datalist', [])
    const degradedOptions = findByType(tree, 'option', []).filter((node) => node.props?.value === 'frontend-developer' || node.props?.value === 'need-subagent')
    check(
      'a failing options route renders the card with empty datalists instead of breaking',
      degradedLists.length > 0 && degradedOptions.length === 0,
      JSON.stringify({ lists: degradedLists.map((node) => node.props?.id), leaked: degradedOptions.length })
    )
  }
  fetchMode = 'record'
}

console.log(failures === 0 ? '\nall client checks passed' : `\n${failures} client check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
