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

// Depth-first element collector for the fake React tree.
function collect(node, predicate, out = []) {
  if (node === null || typeof node !== 'object') return out
  if (predicate(node)) out.push(node)
  for (const child of node.children ?? []) collect(child, predicate, out)
  return out
}

// The fake createElement keeps array children as arrays (real React flattens
// them), so option lists need one flatten pass before inspection.
function flat(children) {
  return children.flatMap((child) => (Array.isArray(child) ? child : [child]))
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

check('loader registration', loaded !== undefined && loaded.id === 'dsh-subagent-route-pin', loaded?.id)
const module_ = loaded.factory(sandbox.require)
check('module name', module_.name === 'subagent-route-pin', module_.name)
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
                {
                  id: 'our-free-model',
                  name: 'Our Free Model',
                  models: [
                    {
                      id: 'deepseek-v4.1-flash-free',
                      name: 'DeepSeek V4.1 Flash',
                      reasoning: {
                        efforts: [
                          { id: 'low', name: 'low' },
                          { id: 'high', name: 'high' },
                          { id: 'max', name: 'max' }
                        ],
                        defaultEffort: 'high'
                      }
                    }
                  ]
                },
                { id: 'deepseek-account', name: 'DeepSeek Account', models: [{ id: 'deepseek-flash', name: 'DeepSeek Flash' }] }
              ],
              failures: []
            }
          }
        }
      }
    }
  }
  state.forms = { 'subagent-route-pin': form }
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
  check('page id', page.options.id === 'subagent-route-pin', page.options.id)
  check('page is a component', typeof page.component === 'function')
  check('page label resolves through the dictionary', page.options.label() === '专家模型', page.options.label())
  check('page declares its locale', page.options.locale === 'settings.subagent-route-pin', page.options.locale)
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
  state.forms['subagent-route-pin'] = {
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

// --- the effort select follows the model's declared reasoning efforts -----
{
  const { ctx, state } = makeContext({
    value: { provider: 'our-free-model', model: 'deepseek-v4.1-flash-free', reasoningEffort: 'max' }
  })
  module_.apply(ctx, {})
  await new Promise((resolve) => setImmediate(resolve))
  const element = state.registered[0].component({})
  const tree = element.type(element.props)
  const selects = collect(tree, (node) => node.type === 'select')
  check('three selects render', selects.length === 3, String(selects.length))
  const effort = selects[2]
  const options = flat(effort.children).map((option) => option.props.value)
  check(
    'effort options follow the model catalog',
    JSON.stringify(options) === JSON.stringify(['', 'low', 'high', 'max']),
    JSON.stringify(options)
  )
  check('configured max stays selected', effort.props.value === 'max', effort.props.value)
  check(
    'unset option is labeled',
    flat(effort.children)[0].children[0] === '不指定（跟随默认）',
    String(flat(effort.children)[0].children[0])
  )
  // A model without catalog reasoning keeps the classic trio; a configured
  // value outside it stays visible as an extra leading option instead of the
  // select silently falling back to its first option.
  const face = element.props.face
  face.actions.setProvider('deepseek-account')
  const treeFallback = element.type(element.props)
  const effortFallback = collect(treeFallback, (node) => node.type === 'select')[2]
  const optionsFallback = flat(effortFallback.children).map((option) => option.props.value)
  check(
    'trio fallback plus the live value as an extra option',
    JSON.stringify(optionsFallback) === JSON.stringify(['', 'max', 'low', 'medium', 'high']),
    JSON.stringify(optionsFallback)
  )
  check(
    'extra option is marked unavailable',
    flat(effortFallback.children)[1].children[0] === 'max · 已保存但当前不可用',
    String(flat(effortFallback.children)[1].children[0])
  )
  // Switching back to a model that does not offer the drafted effort clears it.
  face.actions.setEffort('medium')
  face.actions.setProvider('our-free-model')
  check(
    'unoffered effort is cleared on model switch',
    face.store.get().draft.reasoningEffort === '',
    face.store.get().draft.reasoningEffort
  )
}

console.log(failures === 0 ? '\nall client checks passed' : `\n${failures} client check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
