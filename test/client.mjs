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

/** Test-side mirror of the card's dirty rule (sameRoute + sameSteps). */
function sameRouteLike(left, right) {
  const la = Array.isArray(left.steps) ? left.steps : []
  const ra = Array.isArray(right.steps) ? right.steps : []
  const stepsEq =
    la.length === ra.length &&
    la.every(
      (row, i) =>
        row.name === ra[i].name &&
        row.provider === ra[i].provider &&
        row.model === ra[i].model &&
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
  console
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
                { id: 'deepseek-account', name: 'DeepSeek Account', models: [{ id: 'deepseek-flash', name: 'DeepSeek Flash' }] }
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
  face.actions.setModel('deepseek-flash')
  face.actions.setEffort('medium')
  await face.actions.save()
  const mutation = state.mutations.at(-1)
  const routeOps = mutation.ops.filter((op) => ['provider', 'model', 'reasoningEffort'].includes(op.path[0]))
  check('save sends the three route field ops + the revision', routeOps.length === 3 && mutation.expectedRevision === 3, JSON.stringify(mutation))
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

console.log(failures === 0 ? '\nall client checks passed' : `\n${failures} client check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
