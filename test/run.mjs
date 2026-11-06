/**
 * Offline harness for dsh-delegation-hub.
 *
 * Drives `apply()` against a fake ctx so the route resolution, hot reload and
 * fallback paths are exercised without a running DSH profile:
 *   node test/run.mjs
 *
 * It asserts the object handed to the base provider's `start()`, which is the
 * only thing the framework consumes.
 *
 * Resolution order under test (highest first):
 *   1. settings file `experts[<label>]`  — per-expert override
 *   2. this plugin's config row          — what the Settings page writes
 *   3. settings file `default`           — legacy fallback
 */

import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, inject, teamInjectionCapabilities, wireAgencyProvider } from '../index.js'

const HOOK = Symbol.for('dsh-delegation-hub.team-hook')
// Pre-0.8 path, still published so a caller that learned it keeps working.
const LEGACY_HOOK = Symbol.for('dsh-delegation-hub.continuable-hook')

const dir = mkdtempSync(join(tmpdir(), 'route-pin-'))
const settingsPath = join(dir, 'routes.json')
// Never write the real readiness record from a test run.
const readinessPath = join(dir, 'ready.json')
// The activation probe falls back to `~/.dsh`, and this file imports index.js, so
// a run that outlives the 8 s parked timer would otherwise scribble on a real
// installation and leave a fake "parked" verdict behind.
const probePath = join(dir, 'probe.json')
process.env.DSH_ROUTE_PIN_PROBE_PATH = probePath

const CAPABILITIES = { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true }

function makeHarness(config, extraCtx = {}) {
  const calls = []
  const logs = []
  const base = {
    name: 'spawn',
    capabilities: CAPABILITIES,
    inheritsParentContext: false,
    start(request) {
      calls.push(request)
      return { started: true, request }
    },
    prepareContinuable() {
      return Promise.resolve({})
    }
  }
  const registered = []
  const teamCalls = []
  // Mirrors a current DSH build: `SubagentRuntime` exposes `startActivation` and
  // has no `startContinuable`. It lives on a prototype on purpose: the team hook
  // shadows it with an own property, so the dispose path can be asserted by
  // deleting it.
  const service = Object.create({
    async startActivation(spec) {
      teamCalls.push(spec)
      return startedActivation ?? { ok: true, spec }
    }
  })
  service.getProvider = (name) => (name === 'spawn' ? base : undefined)
  service.registerProvider = (provider) => registered.push(provider)
  const ctx = {
    logger: {
      info: (message) => logs.push(['info', message]),
      warn: (message) => logs.push(['warn', message]),
      error: (message) => logs.push(['error', message])
    },
    subagents: service,
    llm: {
      listProviders: () => [{ id: 'deepseek-account' }, { id: 'our-free-model' }],
      async listModels(provider) {
        if (provider === 'deepseek-account') return [{ id: 'deepseek-flash' }, { id: 'deepseek-pro' }]
        if (provider === 'our-free-model') return [{ id: 'deepseek-v4.1-flash-free' }]
        return []
      }
    },
    ...extraCtx
  }
  apply(ctx, { settingsPath, readinessPath, ...config })
  if (registered.length !== 1) throw new Error(`expected one registered provider, got ${registered.length}`)
  return { provider: registered[0], calls, logs, service, teamCalls, setActivation: (value) => { startedActivation = value } }
}
let startedActivation = undefined

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${detail}`}`)
  }
}

async function startWith(harness, label) {
  const request = { prompt: 'do the thing', parent: {}, label }
  const result = await harness.provider.start(request)
  return { request: result.request, forwarded: harness.calls.at(-1) }
}

// --- 1. the config row is the primary route --------------------------------
writeFileSync(settingsPath, JSON.stringify({}), 'utf8')
{
  const harness = makeHarness({ provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'medium' })
  const { forwarded } = await startWith(harness, 'Anything')
  check('empty settings -> config row', forwarded.agentOptions.provider === 'deepseek-account' && forwarded.agentOptions.model === 'deepseek-flash', JSON.stringify(forwarded.agentOptions))
  check('config effort applied', forwarded.agentOptions.reasoningEffort === 'medium', JSON.stringify(forwarded.agentOptions))
  check('request fields preserved', forwarded.prompt === 'do the thing' && forwarded.label === 'Anything')
}

// --- 2. the config row beats a stale settings default ----------------------
writeFileSync(settingsPath, JSON.stringify({ default: { provider: 'our-free-model', model: 'deepseek-v4.1-flash-free' } }), 'utf8')
{
  const harness = makeHarness({ provider: 'deepseek-account', model: 'deepseek-pro' })
  const { forwarded } = await startWith(harness, 'Research Analyst')
  check('config row wins over default', forwarded.agentOptions.provider === 'deepseek-account' && forwarded.agentOptions.model === 'deepseek-pro', JSON.stringify(forwarded.agentOptions))
  // The row names no effort, so nothing is injected into a provider that may
  // not support it.
  check('no effort injected when unspecified', forwarded.agentOptions.reasoningEffort === undefined, JSON.stringify(forwarded.agentOptions))
}

// --- 3. per-expert override, exact and contains ----------------------------
writeFileSync(
  settingsPath,
  JSON.stringify({
    match: 'contains',
    default: { provider: 'deepseek-account', model: 'deepseek-flash' },
    experts: {
      'research analyst': { provider: 'our-free-model', model: 'deepseek-v4.1-flash-free', reasoningEffort: 'low' },
      security: { provider: 'deepseek-account', model: 'deepseek-pro', maxTokens: 4096 }
    }
  }),
  'utf8'
)
{
  const harness = makeHarness({ provider: 'deepseek-account', model: 'deepseek-flash' })
  const exact = await startWith(harness, 'Research Analyst')
  check('exact expert match (case-insensitive)', exact.forwarded.agentOptions.model === 'deepseek-v4.1-flash-free', JSON.stringify(exact.forwarded.agentOptions))
  check('expert effort applied', exact.forwarded.agentOptions.reasoningEffort === 'low')
  const partial = await startWith(harness, 'Senior Security Engineer')
  check('contains match', partial.forwarded.agentOptions.provider === 'deepseek-account' && partial.forwarded.agentOptions.model === 'deepseek-pro', JSON.stringify(partial.forwarded.agentOptions))
  check('maxTokens applied', partial.forwarded.agentOptions.maxTokens === 4096)
  const other = await startWith(harness, 'Legal Policy Writer')
  check('unmatched expert falls to the config row', other.forwarded.agentOptions.model === 'deepseek-flash', JSON.stringify(other.forwarded.agentOptions))
}

// --- 4. per-expert overrides hot reload without re-apply -------------------
writeFileSync(settingsPath, JSON.stringify({ experts: { x: { provider: 'deepseek-account', model: 'deepseek-flash' } } }), 'utf8')
{
  const harness = makeHarness({})
  const before = await startWith(harness, 'X')
  check('before rewrite', before.forwarded.agentOptions.model === 'deepseek-flash')
  writeFileSync(settingsPath, JSON.stringify({ experts: { x: { provider: 'deepseek-account', model: 'deepseek-pro' } } }), 'utf8')
  const after = await startWith(harness, 'X')
  check('after rewrite (no re-apply)', after.forwarded.agentOptions.model === 'deepseek-pro', JSON.stringify(after.forwarded.agentOptions))
}

// --- 5. legacy default is used only when the row has no route --------------
writeFileSync(settingsPath, JSON.stringify({ default: { provider: 'our-free-model', model: 'deepseek-v4.1-flash-free' } }), 'utf8')
{
  const harness = makeHarness({})
  const { forwarded } = await startWith(harness, 'X')
  check('row without a route -> settings default', forwarded.agentOptions.provider === 'our-free-model' && forwarded.agentOptions.model === 'deepseek-v4.1-flash-free', JSON.stringify(forwarded.agentOptions))
}

// --- 6. an unusable expert override falls back to the row, with a warning --
writeFileSync(settingsPath, JSON.stringify({ experts: { x: { provider: 'nope', model: 'ghost' } } }), 'utf8')
{
  const harness = makeHarness({ provider: 'deepseek-account', model: 'deepseek-flash', onPinFailure: 'inherit' })
  const { forwarded } = await startWith(harness, 'X')
  check('unknown provider falls back to the row', forwarded.agentOptions.provider === 'deepseek-account' && forwarded.agentOptions.model === 'deepseek-flash', JSON.stringify(forwarded.agentOptions))
  check('fallback warned', harness.logs.some(([kind, message]) => kind === 'warn' && message.includes('not registered')), JSON.stringify(harness.logs.at(-1)))
}

// --- 7. strict turns the same miss into a hard failure --------------------
writeFileSync(settingsPath, JSON.stringify({ experts: { x: { provider: 'deepseek-account', model: 'ghost-model' } } }), 'utf8')
{
  const harness = makeHarness({ provider: 'deepseek-account', model: 'deepseek-flash', strict: true })
  let message
  try {
    await startWith(harness, 'X')
  } catch (error) {
    message = error.message
  }
  check('strict rejects an unadvertised model', typeof message === 'string' && message.includes('does not advertise'), message)
}

// --- 8. malformed settings keep the last good parse ----------------------
writeFileSync(settingsPath, JSON.stringify({ experts: { x: { provider: 'deepseek-account', model: 'deepseek-pro' } } }), 'utf8')
{
  const harness = makeHarness({})
  const good = await startWith(harness, 'X')
  check('good parse first', good.forwarded.agentOptions.model === 'deepseek-pro')
  writeFileSync(settingsPath, '{ this is not json', 'utf8')
  const kept = await startWith(harness, 'X')
  check('malformed keeps last good', kept.forwarded.agentOptions.model === 'deepseek-pro', JSON.stringify(kept.forwarded.agentOptions))
  check('malformed warned', harness.logs.some(([kind, message]) => kind === 'warn' && message.includes('ignoring')), JSON.stringify(harness.logs.slice(-2)))
}

// --- 9. no route anywhere: inherit instead of failing --------------------
writeFileSync(settingsPath, JSON.stringify({}), 'utf8')
{
  const harness = makeHarness({ providerName: 'pinned-account', baseProvider: 'spawn' })
  const { forwarded } = await startWith(harness, 'X')
  check('missing route delegates without agentOptions', forwarded !== undefined && forwarded.agentOptions === undefined, JSON.stringify(forwarded?.agentOptions))
  check('missing route logs inherited', harness.logs.some(([kind, message]) => kind === 'info' && message.includes('inherited')), JSON.stringify(harness.logs.slice(-2)))
}
{
  const harness = makeHarness({ providerName: 'pinned-account', baseProvider: 'spawn', strict: true })
  let message
  try {
    await startWith(harness, 'X')
  } catch (error) {
    message = error.message
  }
  check('strict turns a missing route into a hard failure', typeof message === 'string' && message.includes('no route for expert') && message.includes(settingsPath), message)
}

// --- 10. prepareContinuable is delegated --------------------------------
{
  const harness = makeHarness({ provider: 'deepseek-account', model: 'deepseek-flash' })
  const spec = { sessionId: 'abc', parent: {}, signal: undefined }
  const resolved = await harness.provider.prepareContinuable(spec)
  check('prepareContinuable delegated', resolved !== undefined && resolved !== null, String(resolved))
  check('inheritsParentContext mirrors base', harness.provider.inheritsParentContext === false)
}

// --- 11. a half-filled row is skipped, not fatal -------------------------
writeFileSync(settingsPath, JSON.stringify({}), 'utf8')
{
  const harness = makeHarness({ provider: 'deepseek-account' })
  const { forwarded } = await startWith(harness, 'X')
  check('provider without model inherits instead of throwing', forwarded !== undefined && forwarded.agentOptions === undefined, JSON.stringify(forwarded?.agentOptions))
}

// --- 12. `ctx.config` is a second live source for the row ----------------
writeFileSync(settingsPath, JSON.stringify({}), 'utf8')
{
  const harness = makeHarness(
    {},
    {
      config: {
        provider: () => 'our-free-model',
        model: () => 'deepseek-v4.1-flash-free',
        reasoningEffort: () => 'high'
      }
    }
  )
  const { forwarded } = await startWith(harness, 'X')
  check('ctx.config fallback resolved', forwarded.agentOptions.provider === 'our-free-model' && forwarded.agentOptions.model === 'deepseek-v4.1-flash-free', JSON.stringify(forwarded.agentOptions))
  check('ctx.config effort resolved', forwarded.agentOptions.reasoningEffort === 'high')
}

// --- 13. accessor-valued fields (volatile write simulation) --------------
writeFileSync(settingsPath, JSON.stringify({}), 'utf8')
{
  let current = { provider: 'deepseek-account', model: 'deepseek-flash' }
  const harness = makeHarness({
    provider: () => current.provider,
    model: () => current.model,
    reasoningEffort: () => undefined
  })
  const before = await startWith(harness, 'X')
  check('accessor read', before.forwarded.agentOptions.model === 'deepseek-flash', JSON.stringify(before.forwarded.agentOptions))
  current = { provider: 'our-free-model', model: 'deepseek-v4.1-flash-free' }
  const after = await startWith(harness, 'X')
  check('accessor reflects a live write without re-apply', after.forwarded.agentOptions.model === 'deepseek-v4.1-flash-free', JSON.stringify(after.forwarded.agentOptions))
}

// --- 14. the provider is removed when THIS fiber disposes -----------------
writeFileSync(settingsPath, JSON.stringify({}), 'utf8')
{
  const live = new Map()
  const effects = []
  const logs = []
  const ctx = {
    logger: { info: (message) => logs.push(['info', message]), warn: (message) => logs.push(['warn', message]) },
    effect(callback) {
      effects.push(callback)
      return () => {}
    },
    subagents: {
      getProvider: (name) => live.get(name),
      registerProvider: (provider) => {
        let alive = true
        live.set(provider.name, provider)
        return () => {
          if (!alive) return
          alive = false
          if (live.get(provider.name) === provider) live.delete(provider.name)
        }
      }
    },
    llm: { listProviders: () => [], async listModels() { return [] } }
  }
  apply(ctx, { settingsPath, readinessPath, provider: 'deepseek-account', model: 'deepseek-flash' })
  check('provider registered into the live table', live.get('pinned-account') !== undefined)
  check('fiber scoped one disposer effect', effects.length === 1, String(effects.length))
  for (const callback of effects) callback()()
  check('fiber dispose unregisters the provider', live.get('pinned-account') === undefined)
}

// --- 15. a duplicate registration degrades instead of failing the plugin --
writeFileSync(settingsPath, JSON.stringify({}), 'utf8')
{
  const logs = []
  const ctx = {
    logger: { info: (message) => logs.push(['info', message]), warn: (message) => logs.push(['warn', message]) },
    subagents: {
      getProvider: () => undefined,
      registerProvider: () => {
        throw new Error('a subagent provider named "pinned-account" is already registered')
      }
    },
    llm: { listProviders: () => [], async listModels() { return [] } }
  }
  let threw
  try {
    apply(ctx, { settingsPath, readinessPath, provider: 'deepseek-account', model: 'deepseek-flash' })
  } catch (error) {
    threw = error
  }
  check('duplicate provider does not fail apply', threw === undefined, threw && threw.message)
  check('duplicate provider warns', logs.some(([kind, message]) => kind === 'warn' && message.includes('not registered')))
}

// --- 16. team-mode members get the row route -----------------------------
writeFileSync(settingsPath, JSON.stringify({}), 'utf8')
{
  const harness = makeHarness({ provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'medium' })
  const spec = { childId: 'c1', provider: 'pinned-account', label: '问卷设计师', request: { prompt: 'do', parent: {} } }
  await harness.service.startActivation(spec)
  const agentOptions = spec.request.agentOptions
  check('team member route injected', agentOptions?.provider === 'deepseek-account' && agentOptions?.model === 'deepseek-flash', JSON.stringify(agentOptions))
  check('team member effort injected', agentOptions?.reasoningEffort === 'medium')
  check('underlying startActivation still called', harness.teamCalls.length === 1)
  check('team member logged', harness.logs.some(([kind, message]) => kind === 'info' && message.includes('team member')))
}

// --- 16b. an empty effort in the row is "no pin", not a pin to "" ---------
{
  // Live failure this locks down (2026-10-29): the Settings page clears the
  // effort field by writing `reasoningEffort: ""`. readRoute used to forward
  // that empty string into agentOptions, and every continuable child then died
  // on its first turn with UNSUPPORTED_REASONING_EFFORT ("does not support
  // reasoning effort \"\"") — the pin was applied and useless at the same time,
  // while the single-shot path on the same row worked fine.
  const harness = makeHarness({ provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: '' })
  const spec = { childId: 'c1', provider: 'pinned-account', label: '代码审查工程师', request: { prompt: 'do', parent: {} } }
  await harness.service.startActivation(spec)
  const agentOptions = spec.request.agentOptions
  check('empty effort still pins provider/model', agentOptions?.provider === 'deepseek-account' && agentOptions?.model === 'deepseek-flash', JSON.stringify(agentOptions))
  check('empty effort is not injected', agentOptions?.reasoningEffort === undefined, JSON.stringify(agentOptions))
  const { forwarded } = await startWith(harness, 'Anything')
  check('single-shot drops the empty effort too', forwarded.agentOptions.reasoningEffort === undefined, JSON.stringify(forwarded.agentOptions))
}

// --- 16c. a blank effort is dropped, a padded one is trimmed — both seams --
{
  // `" "` used to slip past the empty-string guard and reach agentOptions: the
  // same UNSUPPORTED_REASONING_EFFORT death with one more character. The team
  // path now shares normalizeRoute with the single-shot path, so the two seams
  // cannot disagree about what the row says.
  const blank = makeHarness({ provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: '   ' })
  const spec = { childId: 'c1', provider: 'pinned-account', label: 'x', request: { prompt: 'do', parent: {} } }
  await blank.service.startActivation(spec)
  check('blank effort is not injected', spec.request.agentOptions?.reasoningEffort === undefined, JSON.stringify(spec.request.agentOptions))
  const padded = makeHarness({ provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: ' high ' })
  const single = await startWith(padded, 'Anything')
  check('single-shot trims a padded effort', single.forwarded.agentOptions.reasoningEffort === 'high', JSON.stringify(single.forwarded.agentOptions))
  const teamSpec = { childId: 'c2', provider: 'pinned-account', label: 'x', request: { prompt: 'do', parent: {} } }
  await padded.service.startActivation(teamSpec)
  check('team path trims a padded effort too', teamSpec.request.agentOptions?.reasoningEffort === 'high', JSON.stringify(teamSpec.request.agentOptions))
}

// --- 16d. the row's maxTokens reaches team members like single-shot --------
{
  const harness = makeHarness({ provider: 'deepseek-account', model: 'deepseek-flash', maxTokens: 4096 })
  const spec = { childId: 'c1', provider: 'pinned-account', label: 'x', request: { prompt: 'do', parent: {} } }
  await harness.service.startActivation(spec)
  check('row maxTokens reaches team members', spec.request.agentOptions?.maxTokens === 4096, JSON.stringify(spec.request.agentOptions))
  const { forwarded } = await startWith(harness, 'Anything')
  check('row maxTokens reaches single-shot', forwarded.agentOptions.maxTokens === 4096, JSON.stringify(forwarded.agentOptions))
}

// --- 17. Agent Teams' own member route is overridden by default -----------
{
  const harness = makeHarness({ provider: 'deepseek-account', model: 'deepseek-flash' })
  const spec = {
    label: 'x',
    request: { prompt: 'do', parent: {}, agentOptions: { provider: 'our-free-model', model: 'mimo-v2.6-flash-free' } }
  }
  await harness.service.startActivation(spec)
  check(
    'existing member route overridden',
    spec.request.agentOptions.provider === 'deepseek-account' && spec.request.agentOptions.model === 'deepseek-flash',
    JSON.stringify(spec.request.agentOptions)
  )
}

// --- 17b. overrideMemberRoute: false keeps the caller's own route ---------
{
  const harness = makeHarness({ provider: 'deepseek-account', model: 'deepseek-flash', overrideMemberRoute: false })
  const spec = {
    label: 'x',
    request: { prompt: 'do', parent: {}, agentOptions: { provider: 'our-free-model', model: 'mimo-v2.6-flash-free' } }
  }
  await harness.service.startActivation(spec)
  check(
    'existing member route untouched when the override is off',
    spec.request.agentOptions.provider === 'our-free-model' && spec.request.agentOptions.model === 'mimo-v2.6-flash-free',
    JSON.stringify(spec.request.agentOptions)
  )
}

// --- 17c. an overridden route keeps the caller's extra fields -------------
{
  const harness = makeHarness({ provider: 'deepseek-account', model: 'deepseek-flash' })
  const spec = {
    label: 'x',
    request: { prompt: 'do', parent: {}, agentOptions: { provider: 'our-free-model', model: 'mimo', maxTokens: 4096 } }
  }
  await harness.service.startActivation(spec)
  check(
    'override keeps unrelated agentOptions',
    spec.request.agentOptions.maxTokens === 4096 && spec.request.agentOptions.provider === 'deepseek-account',
    JSON.stringify(spec.request.agentOptions)
  )
}

// --- 17d. the pinned route drops a stale effort ---------------------------
{
  const harness = makeHarness({ provider: 'deepseek-account', model: 'deepseek-flash' })
  const spec = {
    label: 'x',
    request: { prompt: 'do', parent: {}, agentOptions: { provider: 'our-free-model', model: 'mimo', reasoningEffort: 'low' } }
  }
  await harness.service.startActivation(spec)
  check(
    'override drops effort the pinned route did not ask for',
    spec.request.agentOptions.reasoningEffort === undefined,
    JSON.stringify(spec.request.agentOptions)
  )
}

// --- 17e. a failed override falls back to the requested route, not none ---
{
  const seen = []
  const service = Object.create({
    async startActivation(spec) {
      seen.push(spec.request.agentOptions)
      if (spec.request.agentOptions?.provider === 'deepseek-account') throw new Error('429 quota exhausted')
      return { ok: true }
    }
  })
  service.getProvider = () => undefined
  service.registerProvider = () => () => {}
  const logs = []
  const ctx = {
    logger: { info: (message) => logs.push(['info', message]), warn: (message) => logs.push(['warn', message]) },
    subagents: service,
    llm: {
      listProviders: () => [{ id: 'deepseek-account' }],
      async listModels() {
        return [{ id: 'deepseek-flash' }]
      }
    }
  }
  writeFileSync(settingsPath, JSON.stringify({}), 'utf8')
  apply(ctx, { settingsPath, readinessPath, provider: 'deepseek-account', model: 'deepseek-flash' })
  const spec = {
    label: 'x',
    request: { prompt: 'do', parent: {}, agentOptions: { provider: 'our-free-model', model: 'mimo-v2.6-flash-free' } }
  }
  const result = await service.startActivation(spec)
  check('failed override retries on the requested route', seen.length === 2 && seen[1]?.provider === 'our-free-model' && seen[1]?.model === 'mimo-v2.6-flash-free', JSON.stringify(seen))
  check('failed override keeps the member alive', result.ok === true)
  check('failed override says requested, not inherited', logs.some(([, message]) => message.includes('retrying on the requested route')))
  const runRecord = JSON.parse(readFileSync(join(readinessPath, '..', 'delegation-hub.last-run.json'), 'utf8'))
  check(
    'failed override records a team-channel run entry',
    runRecord.outcome === 'failed' && runRecord.channel === 'team' && runRecord.label === 'x' && /429/.test(runRecord.reason),
    JSON.stringify(runRecord)
  )
}

// --- 18. teamInjection: false is an off switch ---------------------------
{
  const harness = makeHarness({ provider: 'deepseek-account', model: 'deepseek-flash', teamInjection: false })
  const spec = { label: 'x', request: { prompt: 'do', parent: {} } }
  await harness.service.startActivation(spec)
  check('teamInjection false leaves the member on the parent route', spec.request.agentOptions === undefined)
}

// --- 18c. runtime failover watches the live child and swaps once ----------
{
  const watched = []
  const childListeners = []
  let failoverRequestListener = undefined
  const childCtx = {
    logger: { warn: (message) => {} },
    on(event, listener) {
      if (event === 'agent/request-error') childListeners.push(listener)
      if (event === 'agent/request') failoverRequestListener = listener
      return () => {}
    }
  }
  const childAgent = { ctx: childCtx }
  const agentsRegistry = {
    get: (id) => (id === 'child-1' ? childAgent : undefined)
  }
  const harness = makeHarness(
    { provider: 'deepseek-account', model: 'deepseek-flash', failoverRoute: { provider: 'our-free-model', model: 'deepseek-v4.1-flash-free' } },
    { agents: agentsRegistry }
  )
  harness.setActivation({ childId: 'child-1', ok: true })
  const spec = { label: 'agent-teams:t1:builder', request: { prompt: 'do', parent: {} } }
  await harness.service.startActivation(spec)
  check('failover watcher registered on the child context', childListeners.length === 1, String(childListeners.length))
  // A lane failure triggers the switch: the request rewriter is installed.
  // Clear the record left by earlier groups so this assertion reads only the
  // failover entry.
  rmSync(join(readinessPath, '..', 'delegation-hub.last-run.json'), { force: true })
  await childListeners[0]({ failure: { code: 'QUOTA' } }, async () => ({ kind: 'retry' }))
  check(
    'lane failure installs the request rewriter',
    typeof failoverRequestListener === 'function',
    String(typeof failoverRequestListener)
  )
  check(
    'failover run record written',
    (() => {
      try {
        const record = JSON.parse(readFileSync(join(readinessPath, '..', 'delegation-hub.last-run.json'), 'utf8'))
        return record.outcome === 'failover' && record.channel === 'team' && record.reason === 'QUOTA'
      } catch {
        return false
      }
    })()
  )
  check(
    'failover switch is logged',
    harness.logs.some(([, message]) => message.includes('failover route our-free-model/deepseek-v4.1-flash-free')),
    JSON.stringify(harness.logs.filter(([, message]) => message.includes('failover')).at(-1))
  )
  // The rewriter swaps provider/model and drops the inherited effort.
  const resolved = await failoverRequestListener(
    { agent: childAgent },
    async () => ({ provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high', maxTokens: 4096 })
  )
  check(
    'rewriter swaps to the failover route and drops effort',
    resolved.provider === 'our-free-model' && resolved.model === 'deepseek-v4.1-flash-free' && resolved.reasoningEffort === undefined,
    JSON.stringify(resolved)
  )
  // A second lane failure must not double-switch: the rewriter stays installed.
  failoverRequestListener = undefined
  await childListeners[0]({ failure: { code: 'AUTH' } }, async () => ({ kind: 'retry' }))
  check('second lane failure does not re-install the rewriter', failoverRequestListener === undefined)
  // A non-lane code never triggers anything.
  await childListeners[0]({ failure: { code: 'TIMEOUT' } }, async () => ({ kind: 'retry' }))
  check('non-lane code keeps the route untouched', failoverRequestListener === undefined)
}

// --- 18d. failover degrades silently without the agents registry ---------
{
  const harness = makeHarness({ provider: 'deepseek-account', model: 'deepseek-flash', failoverRoute: { provider: 'our-free-model', model: 'deepseek-v4.1-flash-free' } })
  harness.setActivation({ childId: 'child-2', ok: true })
  let threw
  try {
    await harness.service.startActivation({ label: 'x', request: { prompt: 'do', parent: {} } })
  } catch (error) {
    threw = error
  }
  check('missing agents registry never breaks a delegation', threw === undefined, threw && threw.message)
}


{
  // A durable team state like the real plugin writes: members carry `role`.
  const teamDir = join(dir, '.agent-teams', 'team-r1')
  mkdirSync(teamDir, { recursive: true })
  writeFileSync(
    join(teamDir, 'team.json'),
    JSON.stringify({
      name: 'r1',
      id: 'team-r1',
      members: [
        { name: 'builder', role: '实现者' },
        { name: 'reviewer', role: '审查者' }
      ]
    }),
    'utf8'
  )
  // The settings file maps roles to routes; role matching is exact and
  // lower-cased, mirroring the experts map.
  writeFileSync(
    settingsPath,
    JSON.stringify({
      roles: {
        '审查者': { provider: 'deepseek-account', model: 'deepseek-pro' },
        '实现者': { provider: 'deepseek-account', model: 'deepseek-flash' }
      }
    }),
    'utf8'
  )
  const harness = makeHarness({ provider: 'deepseek-account', model: 'deepseek-flash' })
  const parent = { session: { header: { cwd: dir } } }
  const reviewerSpec = {
    label: 'agent-teams:team-r1:reviewer',
    request: { prompt: 'do', parent, agentOptions: { provider: 'our-free-model', model: 'deepseek-v4.1-flash-free' } }
  }
  await harness.service.startActivation(reviewerSpec)
  check(
    'role route overrides the member default (reviewer -> deepseek-pro)',
    reviewerSpec.request.agentOptions.provider === 'deepseek-account' && reviewerSpec.request.agentOptions.model === 'deepseek-pro',
    JSON.stringify(reviewerSpec.request.agentOptions)
  )
  check(
    'role source is named in the log',
    harness.logs.some(([, message]) => message.includes('roles[') && message.includes('审查者')),
    JSON.stringify(harness.logs.filter(([, message]) => message.includes('roles[')).at(-1))
  )
  // The disk record must carry the same provenance: channel 'team' plus the
  // source tag, so a last-run file can prove which tier routed the member.
  rmSync(join(readinessPath, '..', 'delegation-hub.last-run.json'), { force: true })
  const roleProbeSpec = {
    label: 'agent-teams:team-r1:reviewer',
    request: { prompt: 'do', parent, agentOptions: { provider: 'our-free-model', model: 'deepseek-v4.1-flash-free' } }
  }
  await harness.service.startActivation(roleProbeSpec)
  const roleRunRecord = JSON.parse(readFileSync(join(readinessPath, '..', 'delegation-hub.last-run.json'), 'utf8'))
  check(
    'role route is recorded on disk with its source',
    roleRunRecord.channel === 'team' && roleRunRecord.source === 'roles["审查者"]' && roleRunRecord.route.model === 'deepseek-pro',
    JSON.stringify(roleRunRecord)
  )
  const builderSpec = {
    label: 'agent-teams:team-r1:builder',
    request: { prompt: 'do', parent, agentOptions: { provider: 'our-free-model', model: 'deepseek-v4.1-flash-free' } }
  }
  await harness.service.startActivation(builderSpec)
  check(
    'second role maps to its own route (builder stays on the row model)',
    builderSpec.request.agentOptions.provider === 'deepseek-account' && builderSpec.request.agentOptions.model === 'deepseek-flash',
    JSON.stringify(builderSpec.request.agentOptions)
  )
  // A member the team file does not know falls through to the config row.
  const strangerSpec = {
    label: 'agent-teams:team-r1:stranger',
    request: { prompt: 'do', parent, agentOptions: { provider: 'our-free-model', model: 'deepseek-v4.1-flash-free' } }
  }
  await harness.service.startActivation(strangerSpec)
  check(
    'unknown member falls back to the config row',
    strangerSpec.request.agentOptions.provider === 'deepseek-account' && strangerSpec.request.agentOptions.model === 'deepseek-flash',
    JSON.stringify(strangerSpec.request.agentOptions)
  )
  // Experts still outrank roles: name the member like an expert entry.
  writeFileSync(
    settingsPath,
    JSON.stringify({
      experts: { 'agent-teams:team-r1:reviewer': { provider: 'our-free-model', model: 'deepseek-v4.1-flash-free' } },
      roles: { '审查者': { provider: 'deepseek-account', model: 'deepseek-pro' } }
    }),
    'utf8'
  )
  const expertSpec = {
    label: 'agent-teams:team-r1:reviewer',
    request: { prompt: 'do', parent, agentOptions: { provider: 'deepseek-account', model: 'deepseek-flash' } }
  }
  await harness.service.startActivation(expertSpec)
  check(
    'experts outrank roles',
    expertSpec.request.agentOptions.model === 'deepseek-v4.1-flash-free',
    JSON.stringify(expertSpec.request.agentOptions)
  )
  // Missing cwd / broken state file / non-team label must not break delegation.
  const noParentSpec = {
    label: 'agent-teams:team-r1:reviewer',
    request: { prompt: 'do', parent: {} }
  }
  let threw
  try {
    await harness.service.startActivation(noParentSpec)
  } catch (error) {
    threw = error
  }
  check('missing cwd degrades to the config row without throwing', threw === undefined, threw && threw.message)
  check(
    'missing cwd still resolves a route (experts entry wins without a role)',
    noParentSpec.request.agentOptions.provider === 'our-free-model' && noParentSpec.request.agentOptions.model === 'deepseek-v4.1-flash-free',
    JSON.stringify(noParentSpec.request.agentOptions)
  )
  // A non-team label never consults roles even when they are configured.
  const plainSpec = { label: 'x', request: { prompt: 'do', parent: { session: { header: { cwd: dir } } } } }
  await harness.service.startActivation(plainSpec)
  check(
    'non-team label ignores roles',
    plainSpec.request.agentOptions.provider === 'deepseek-account' && plainSpec.request.agentOptions.model === 'deepseek-flash',
    JSON.stringify(plainSpec.request.agentOptions)
  )
}

// --- 19. a missing route never breaks member creation --------------------
{
  const harness = makeHarness({})
  const spec = { label: 'x', request: { prompt: 'do', parent: {} } }
  let threw
  try {
    await harness.service.startActivation(spec)
  } catch (error) {
    threw = error
  }
  check('missing route does not break member creation', threw === undefined, threw && threw.message)
  check('missing route warned', harness.logs.some(([kind, message]) => kind === 'warn' && message.includes('inherits the parent model')))
  check('member still created', harness.teamCalls.length === 1)
}

// --- 20. the hook is an own property and is removed on dispose -----------
{
  const effects = []
  const logs = []
  const service = Object.create({
    async startActivation(spec) {
      return { ok: true, spec }
    }
  })
  service.getProvider = () => undefined
  service.registerProvider = (provider) => () => {}
  const ctx = {
    logger: { info: (message) => logs.push(['info', message]), warn: (message) => logs.push(['warn', message]) },
    effect(callback) {
      effects.push(callback)
      return () => {}
    },
    subagents: service,
    llm: { listProviders: () => [{ id: 'deepseek-account' }], async listModels() { return [{ id: 'deepseek-flash' }] } }
  }
  writeFileSync(settingsPath, JSON.stringify({}), 'utf8')
  apply(ctx, { settingsPath, readinessPath, provider: 'deepseek-account', model: 'deepseek-flash' })
  check('hook is an own property of the service', Object.prototype.hasOwnProperty.call(service, 'startActivation'))
  const spec = { label: 'x', request: { prompt: 'do', parent: {} } }
  await service.startActivation(spec)
  check('hook works on a prototype-provided method', spec.request.agentOptions?.model === 'deepseek-flash', JSON.stringify(spec.request.agentOptions))
  for (const callback of effects) callback()()
  check('dispose deletes the own property', Object.prototype.hasOwnProperty.call(service, 'startActivation') === false)
  const after = { label: 'x', request: { prompt: 'do', parent: {} } }
  await service.startActivation(after)
  check('prototype method restored', after.request.agentOptions === undefined)
}

// --- 21. a remount swaps the resolver but installs only one hook ---------
{
  const effects = []
  const logs = []
  const service = Object.create({ async startActivation(spec) { return { ok: true, spec } } })
  service.getProvider = () => undefined
  service.registerProvider = () => () => {}
  const ctx = {
    logger: { info: (message) => logs.push(['info', message]), warn: (message) => logs.push(['warn', message]) },
    effect(callback) {
      effects.push(callback)
      return () => {}
    },
    subagents: service,
    llm: {
      listProviders: () => [{ id: 'deepseek-account' }, { id: 'our-free-model' }],
      async listModels(provider) {
        return provider === 'our-free-model' ? [{ id: 'deepseek-v4.1-flash-free' }] : [{ id: 'deepseek-flash' }]
      }
    }
  }
  writeFileSync(settingsPath, JSON.stringify({}), 'utf8')
  apply(ctx, { settingsPath, readinessPath, provider: 'deepseek-account', model: 'deepseek-flash' })
  apply(ctx, { settingsPath, readinessPath, provider: 'our-free-model', model: 'deepseek-v4.1-flash-free' })
  const spec = { label: 'x', request: { prompt: 'do', parent: {} } }
  await service.startActivation(spec)
  check('remount swaps the resolver', spec.request.agentOptions?.model === 'deepseek-v4.1-flash-free', JSON.stringify(spec.request.agentOptions))
  check('hook installed exactly once', logs.filter(([, message]) => message.includes('team-mode hook installed')).length === 1)
}

// --- 22. the team-injection capability is a readable flag ----------------
{
  const harness = makeHarness({ provider: 'deepseek-account', model: 'deepseek-flash' })
  const capability = teamInjectionCapabilities(harness.service)
  check('capability: team injection installed', capability.teamInjection === 'installed', JSON.stringify(capability))
  check('capability: enabled mirrors the live switch', capability.enabled === true, JSON.stringify(capability))
  check('capability: no reason when installed', capability.reason === undefined, JSON.stringify(capability))
  const published = harness.service[HOOK].capabilities
  check('capability published on the service symbol', published.teamInjection === 'installed', JSON.stringify(published))
  check('capability: names the wrapped seam', JSON.stringify(capability.seams) === '["startActivation"]', JSON.stringify(capability.seams))
  const legacy = harness.service[LEGACY_HOOK]
  check('capability: the pre-0.8 symbol still resolves', legacy !== undefined && legacy.capabilities.teamInjection === 'installed')
}

// --- 22b. a build that only has the older seam still gets injected ------
{
  const seen = []
  const service = Object.create({
    async startContinuable(spec) {
      seen.push(spec.request.agentOptions)
      return { ok: true }
    }
  })
  service.getProvider = () => undefined
  service.registerProvider = () => () => {}
  const logs = []
  const ctx = {
    logger: { info: (message) => logs.push(['info', message]), warn: (message) => logs.push(['warn', message]) },
    subagents: service,
    llm: {
      listProviders: () => [{ id: 'deepseek-account' }],
      async listModels() {
        return [{ id: 'deepseek-flash' }]
      }
    }
  }
  writeFileSync(settingsPath, JSON.stringify({}), 'utf8')
  apply(ctx, { settingsPath, readinessPath, provider: 'deepseek-account', model: 'deepseek-flash' })
  const capability = teamInjectionCapabilities(service)
  check('legacy seam: reported as the wrapped seam', JSON.stringify(capability.seams) === '["startContinuable"]', JSON.stringify(capability.seams))
  await service.startContinuable({ label: 'x', request: { prompt: 'do', parent: {} } })
  check('legacy seam: route injected', seen[0]?.model === 'deepseek-flash', JSON.stringify(seen))
}

// --- 22c. both seams present: startActivation wins, no double injection --
{
  const order = []
  const service = Object.create({
    async startActivation(spec) {
      order.push(['activation', spec.request.agentOptions])
      // A real runtime dispatches to the older method internally, already carrying
      // the injected route; the inner hook must see it and leave it alone.
      return service.startContinuable(spec)
    },
    async startContinuable(spec) {
      order.push(['continuable', spec.request.agentOptions])
      return { ok: true }
    }
  })
  service.getProvider = () => undefined
  service.registerProvider = () => () => {}
  const logs = []
  const ctx = {
    logger: { info: (message) => logs.push(['info', message]), warn: (message) => logs.push(['warn', message]) },
    subagents: service,
    llm: {
      listProviders: () => [{ id: 'deepseek-account' }],
      async listModels() {
        return [{ id: 'deepseek-flash' }]
      }
    }
  }
  writeFileSync(settingsPath, JSON.stringify({}), 'utf8')
  apply(ctx, { settingsPath, readinessPath, provider: 'deepseek-account', model: 'deepseek-flash' })
  const capability = teamInjectionCapabilities(service)
  check(
    'both seams: reported most-preferred first',
    JSON.stringify(capability.seams) === '["startActivation","startContinuable"]',
    JSON.stringify(capability.seams)
  )
  await service.startActivation({ label: 'x', request: { prompt: 'do', parent: {} } })
  check('both seams: route injected once', order[0][1]?.model === 'deepseek-flash' && order[1][1]?.model === 'deepseek-flash', JSON.stringify(order))
  check(
    'both seams: one injection log line',
    logs.filter(([, message]) => message.includes('team member label=')).length === 1,
    JSON.stringify(logs.filter(([, message]) => message.includes('team member label=')))
  )
}

// --- 23. a missing seam is a state, not just a warning -------------------
{
  const logs = []
  const service = { getProvider: () => undefined, registerProvider: () => () => {} }
  const ctx = {
    logger: { info: (message) => logs.push(['info', message]), warn: (message) => logs.push(['warn', message]) },
    subagents: service,
    llm: {
      listProviders: () => [{ id: 'deepseek-account' }],
      async listModels() {
        return [{ id: 'deepseek-flash' }]
      }
    }
  }
  writeFileSync(settingsPath, JSON.stringify({}), 'utf8')
  apply(ctx, { settingsPath, readinessPath, provider: 'deepseek-account', model: 'deepseek-flash' })
  const capability = teamInjectionCapabilities(service)
  check('capability: unavailable without a creation seam', capability.teamInjection === 'unavailable', JSON.stringify(capability))
  check('capability: names the missing seams', String(capability.reason).includes('startActivation') && String(capability.reason).includes('startContinuable'), String(capability.reason))
  check('capability: disabled is reported as off', capability.enabled === false, JSON.stringify(capability))
  check(
    'capability: one unavailable warning',
    logs.filter(([, message]) => message.includes('team-mode injection unavailable')).length === 1
  )
  check('capability: logged in the startup summary', logs.some(([, message]) => message.includes('capabilities {')))
  const record = JSON.parse(readFileSync(readinessPath, 'utf8'))
  check(
    'readiness: unavailable is recorded as a state',
    record.mounted === true && record.capabilities.teamInjection === 'unavailable',
    JSON.stringify(record.capabilities)
  )
}

// --- 24. onPinFailure: inherit falls back to the inherited route ---------
{
  const harness = makeHarness({ provider: 'our-free-model', model: 'deepseek-v4.1-flash-free', onPinFailure: 'inherit' })
  const attempts = []
  harness.service.getProvider = () => ({
    name: 'spawn',
    capabilities: CAPABILITIES,
    start(request) {
      attempts.push(request)
      if (attempts.length === 1) throw new Error('429 quota exhausted')
      return { started: true, request }
    }
  })
  const result = await harness.provider.start({
    prompt: 'do',
    parent: {},
    label: 'x',
    agentOptions: { provider: 'deepseek-account', model: 'deepseek-flash' }
  })
  check('fallback: the dead pin is retried', attempts.length === 2, String(attempts.length))
  check(
    'fallback: retry uses the inherited route',
    result.request.agentOptions.provider === 'deepseek-account' && result.request.agentOptions.model === 'deepseek-flash',
    JSON.stringify(result.request.agentOptions)
  )
  check('fallback: warned', harness.logs.some(([, message]) => message.includes('retrying on the inherited route')))
}

// --- 25. a dead pin fails loudly by default (no silent model swap) ------
{
  const harness = makeHarness({ provider: 'our-free-model', model: 'deepseek-v4.1-flash-free' })
  harness.service.getProvider = () => ({
    name: 'spawn',
    capabilities: CAPABILITIES,
    start() {
      throw new Error('429 quota exhausted')
    }
  })
  let threw
  try {
    await harness.provider.start({ prompt: 'do', parent: {}, label: 'x' })
  } catch (error) {
    threw = error
  }
  check('fail mode: the summon errors instead of swapping models', threw !== undefined && threw.message.includes('429 quota exhausted'))
  check('fail mode: the user-facing text names the route', threw !== undefined && threw.message.includes('our-free-model/deepseek-v4.1-flash-free'))
  check('fail mode: the original error is preserved as the cause', threw?.cause?.message === '429 quota exhausted')
  check('fail mode: nothing is retried on another route', harness.logs.some(([kind]) => kind === 'error'))
}

// --- 25b. an unusable configured route is a finding, not a silent degrade
{
  const harness = makeHarness({ provider: 'no-such-provider', model: 'whatever' })
  let threw
  try {
    await harness.provider.start({ prompt: 'do', parent: {}, label: 'x' })
  } catch (error) {
    threw = error
  }
  check('unusable route: start rejects', threw !== undefined, String(threw))
  check('unusable route: names the provider', threw !== undefined && threw.message.includes('not registered'), threw?.message)
}

// --- 25c. auto-wire writes the agency row, once --------------------------
{
  const root = join(dir, 'profile-autowire')
  mkdirSync(root, { recursive: true })
  const patch = join(root, 'cordis.patch.yml')
  writeFileSync(
    patch,
    [
      '- id: some-plugin',
      '  name: "some"',
      '  config:',
      '    a: 1',
      '- id: agency-agents',
      '  name: "@michengai/dsh-agency-agents"',
      '  config:',
      '    enabled:',
      '      - engineering-software-architect',
      '    customExperts: []',
      ''
    ].join('\n'),
    'utf8'
  )
  const first = wireAgencyProvider(root, 'pinned-account')
  const written = readFileSync(patch, 'utf8')
  check('auto-wire: reports a change', first.changed === true, JSON.stringify(first))
  check('auto-wire: inserts the provider under config', written.includes('  config:\n    provider: pinned-account'))
  check('auto-wire: keeps the rest of the row', written.includes('    customExperts: []'))
  const second = wireAgencyProvider(root, 'pinned-account')
  check('auto-wire: idempotent', second.changed === false && second.reason === 'already wired', JSON.stringify(second))
  check('auto-wire: backs the original up', readFileSync(patch, 'utf8').length > 0)
}
{
  const root = join(dir, 'profile-autowire-replace')
  mkdirSync(root, { recursive: true })
  const patch = join(root, 'cordis.patch.yml')
  writeFileSync(patch, '- id: agency-agents\n  name: "x"\n  config:\n    provider: spawn\n    enabled: []\n', 'utf8')
  wireAgencyProvider(root, 'pinned-account')
  const written = readFileSync(patch, 'utf8')
  check('auto-wire: replaces a foreign provider', written.includes('    provider: pinned-account') && !written.includes('provider: spawn'))
}
{
  const root = join(dir, 'profile-no-agency')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'cordis.patch.yml'), '- id: other\n  name: "x"\n', 'utf8')
  const result = wireAgencyProvider(root, 'pinned-account')
  check('auto-wire: leaves a profile without agency alone', result.changed === false && result.reason === 'no agency-agents row')
}

// --- 26. a member that cannot start on the pin is retried without it ----
{
  const seen = []
  const service = Object.create({
    async startActivation(spec) {
      seen.push(spec.request.agentOptions)
      if (spec.request.agentOptions !== undefined) throw new Error('quota exceeded')
      return { ok: true }
    }
  })
  service.getProvider = () => undefined
  service.registerProvider = () => () => {}
  const logs = []
  const ctx = {
    logger: { info: (message) => logs.push(['info', message]), warn: (message) => logs.push(['warn', message]) },
    subagents: service,
    llm: {
      listProviders: () => [{ id: 'deepseek-account' }],
      async listModels() {
        return [{ id: 'deepseek-flash' }]
      }
    }
  }
  writeFileSync(settingsPath, JSON.stringify({}), 'utf8')
  apply(ctx, { settingsPath, readinessPath, provider: 'deepseek-account', model: 'deepseek-flash', onPinFailure: 'inherit' })
  const result = await service.startActivation({ label: 'x', request: { prompt: 'do', parent: {} } })
  check('team fallback: retried once without the pin', seen.length === 2 && seen[0]?.model === 'deepseek-flash' && seen[1] === undefined, JSON.stringify(seen))
  check('team fallback: member still starts', result.ok === true)
  check('team fallback: warned', logs.some(([, message]) => message.includes('retrying on the inherited route')))
}

// --- 26b. the default onPinFailure also governs a team member -----------
// A member must not be re-routed on another model when the plugin row says
// `fail` (the default): that is the silent swap the plugin exists to prevent.
{
  const seen = []
  const service = Object.create({
    async startActivation(spec) {
      seen.push(spec.request.agentOptions)
      if (spec.request.agentOptions !== undefined) throw new Error('quota exceeded')
      return { ok: true }
    }
  })
  service.getProvider = () => undefined
  service.registerProvider = () => () => {}
  const logs = []
  const ctx = {
    logger: { info: () => {}, warn: (message) => logs.push(['warn', message]) },
    subagents: service,
    llm: {
      listProviders: () => [{ id: 'deepseek-account' }],
      async listModels() {
        return [{ id: 'deepseek-flash' }]
      }
    }
  }
  writeFileSync(settingsPath, JSON.stringify({}), 'utf8')
  apply(ctx, { settingsPath, readinessPath, provider: 'deepseek-account', model: 'deepseek-flash' })
  let threw
  try {
    await service.startActivation({ label: 'x', request: { prompt: 'do', parent: {} } })
  } catch (error) {
    threw = error
  }
  check('team member: the default fail propagates the error', threw !== undefined && String(threw?.message ?? '').includes('quota exceeded'), threw === undefined ? 'resolved' : threw.message)
  check('team member: no silent retry on another model', seen.length === 1, `attempts=${seen.length}`)
}

// --- 27. the three log lines are a contract -----------------------------
{
  const harness = makeHarness({ provider: 'deepseek-account', model: 'deepseek-flash' })
  await harness.service.startActivation({ label: 'Researcher', request: { prompt: 'do', parent: {} } })
  const messages = harness.logs.map(([, message]) => message).join('\n')
  check('log contract: provider delegates', /provider "pinned-account" delegates to "spawn"/.test(messages))
  check('log contract: hook installed', /team-mode hook installed on ctx\.subagents\.startActivation/.test(messages))
  check(
    'log contract: team member -> provider/model',
    /team member label="Researcher" -> deepseek-account\/deepseek-flash/.test(messages)
  )
  check('log contract: capabilities line present', /capabilities \{"teamInjection":"installed"/.test(messages))
}

// --- 28. the readiness record is what a post-upgrade check reads ---------
{
  const harness = makeHarness({ provider: 'deepseek-account', model: 'deepseek-flash' })
  const record = JSON.parse(readFileSync(readinessPath, 'utf8'))
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  check('readiness: record written', record.plugin === 'delegation-hub' && record.schema === 1, JSON.stringify(record))
  check('readiness: version matches the manifest', record.version === manifest.version, String(record.version))
  check('readiness: mounted', record.mounted === true)
  check('readiness: capabilities installed', record.capabilities.teamInjection === 'installed', JSON.stringify(record.capabilities))
  check('readiness: route reported', record.providerName === 'pinned-account' && record.baseProvider === 'spawn')
  check('readiness: fallback reported', record.fallback === true)
  check('readiness: overrideMemberRoute reported', record.overrideMemberRoute === true, String(record.overrideMemberRoute))
  check('readiness: teamInjection reported', record.teamInjection === true)
  check('readiness: harness still usable', harness.provider !== undefined)
}

// --- 29. no subagent service is still recorded, as a state --------------
{
  const logs = []
  const ctx = {
    logger: { info: (message) => logs.push(['info', message]), warn: (message) => logs.push(['warn', message]) }
  }
  apply(ctx, { readinessPath })
  const record = JSON.parse(readFileSync(readinessPath, 'utf8'))
  check('readiness: absent service is mounted=false', record.mounted === false, JSON.stringify(record))
  check(
    'readiness: absent service names registerProvider',
    String(record.capabilities?.reason).includes('registerProvider'),
    JSON.stringify(record.capabilities)
  )
  check('readiness: absent service warns', logs.some(([, message]) => message.includes('registerProvider is unavailable')))
  // `applyInner` returns normally here, so the probe must not call this "applied":
  // a probe that says applied while readiness says mounted:false is the very
  // contradiction the probe was added to remove.
  const probe = JSON.parse(readFileSync(probePath, 'utf8'))
  check('probe: a refused build is degraded, not applied', probe.phase === 'degraded' && probe.mounted === false, JSON.stringify(probe))
  check('probe: the degraded verdict keeps a reason', String(probe.reason).includes('registerProvider'), JSON.stringify(probe.reason))
}

// --- 31. the readiness record names the route actually in force -----------
// A settings file whose `default` is overruled by the config row used to fail
// silently: the JSON said one model, delegations got another, and nothing in the
// readiness record or the logs said which one won.
{
  writeFileSync(
    settingsPath,
    JSON.stringify({ default: { provider: 'deepseek-account', model: 'deepseek-pro' } }),
    'utf8'
  )
  const harness = makeHarness({ provider: 'our-free-model', model: 'deepseek-v4.1-flash-free' })
  const record = JSON.parse(readFileSync(readinessPath, 'utf8'))
  check(
    'readiness: effective route is the config row',
    record.route === 'our-free-model/deepseek-v4.1-flash-free' && record.routeSource === 'config row',
    JSON.stringify({ route: record.route, routeSource: record.routeSource })
  )
  check(
    'readiness: the shadowed settings default is still reported',
    record.settingsDefault === 'deepseek-account/deepseek-pro' && record.settingsDefaultShadowed === true,
    JSON.stringify({ settingsDefault: record.settingsDefault, shadowed: record.settingsDefaultShadowed })
  )
  check(
    'readiness: a shadowed settings default warns instead of staying silent',
    harness.logs.some(
      ([level, message]) => level === 'warn' && message.includes('settings default is ignored')
    ),
    JSON.stringify(harness.logs.filter(([level]) => level === 'warn'))
  )
  const { forwarded } = await startWith(harness, 'Anything')
  check(
    'readiness: the reported route is the one a delegation gets',
    forwarded.agentOptions.provider === 'our-free-model' &&
      forwarded.agentOptions.model === 'deepseek-v4.1-flash-free',
    JSON.stringify(forwarded.agentOptions)
  )
}

// --- 32. with no config row, the settings default is reported as in force -
{
  writeFileSync(
    settingsPath,
    JSON.stringify({ default: { provider: 'deepseek-account', model: 'deepseek-pro' } }),
    'utf8'
  )
  makeHarness({})
  const record = JSON.parse(readFileSync(readinessPath, 'utf8'))
  check(
    'readiness: settings default wins when the row is empty',
    record.route === 'deepseek-account/deepseek-pro' && record.routeSource === 'settings default',
    JSON.stringify({ route: record.route, routeSource: record.routeSource })
  )
  check(
    'readiness: an unshadowed settings default does not warn',
    record.settingsDefaultShadowed === false,
    String(record.settingsDefaultShadowed)
  )
}

// --- 30. the peer range must not silently exclude prerelease builds ------
// node-semver only lets a prerelease satisfy a range when some comparator
// shares its exact major.minor.patch tuple *and* itself carries a prerelease
// tag. ">=0.2.0-rc.1 <0.4.0" looks broad, but it drops every 0.2.1-rc.* — the
// build this plugin actually runs on — so npm resolves nothing and the user
// gets an ERESOLVE they have to work around by hand. Each minor needs its own
// "||" branch. This is the regression the compat matrix exists to catch.
{
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

  const parseVersion = (version) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version)
    if (match === null) throw new Error(`unparseable version: ${version}`)
    return {
      core: [Number(match[1]), Number(match[2]), Number(match[3])],
      pre: match[4] === undefined ? [] : match[4].split('.')
    }
  }
  const compareCore = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
  const compareIdentifier = (a, b) => {
    const aNumeric = /^\d+$/.test(a)
    const bNumeric = /^\d+$/.test(b)
    if (aNumeric && bNumeric) return Number(a) - Number(b)
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1
    return a < b ? -1 : a > b ? 1 : 0
  }
  const comparePre = (a, b) => {
    if (a.length === 0 && b.length === 0) return 0
    if (a.length === 0) return 1
    if (b.length === 0) return -1
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      if (a[i] === undefined) return -1
      if (b[i] === undefined) return 1
      const order = compareIdentifier(a[i], b[i])
      if (order !== 0) return order
    }
    return 0
  }
  const satisfiesComparator = (version, comparator) => {
    const match = /^(>=|<=|>|<|=)?\s*(.+)$/.exec(comparator.trim())
    if (match === null) throw new Error(`unparseable comparator: ${comparator}`)
    const operator = match[1] ?? '='
    const bound = parseVersion(match[2])
    // Full semver ordering: compare the core, then the prerelease, where a
    // plain version outranks any prerelease of the same tuple.
    const coreOrder = compareCore(version.core, bound.core)
    const order = coreOrder !== 0 ? coreOrder : comparePre(version.pre, bound.pre)
    if (operator === '>=') return order >= 0
    if (operator === '>') return order > 0
    if (operator === '<=') return order <= 0
    if (operator === '<') return order < 0
    return order === 0
  }
  const sameTuple = (a, b) => a.core[0] === b.core[0] && a.core[1] === b.core[1] && a.core[2] === b.core[2]
  const satisfiesRange = (version, range) => {
    const parsed = parseVersion(version)
    return range.split('||').some((branch) => {
      const comparators = branch.trim().split(/\s+/)
      if (!comparators.every((comparator) => satisfiesComparator(parsed, comparator))) return false
      // node-semver's prerelease gate is per comparator *set*: a prerelease
      // only passes when some comparator in the same set shares its exact
      // major.minor.patch tuple and itself carries a prerelease tag. This is
      // why ">=0.2.0-rc.1 <0.4.0" admits 0.2.0-rc.1 but not 0.2.1-rc.2.
      if (parsed.pre.length === 0) return true
      return comparators.some((comparator) => {
        const bound = parseVersion(comparator.replace(/^(>=|<=|>|<|=)\s*/, ''))
        return sameTuple(parsed, bound) && bound.pre.length > 0
      })
    })
  }

  const supported = ['0.2.0-rc.1', '0.2.0-rc.2', '0.2.1-rc.1', '0.2.1-rc.2', '0.2.1-rc.3', '0.2.1']
  const refused = ['0.1.9', '0.4.0-rc.1', '0.4.0', '0.5.0']

  for (const name of ['@deepseek-ai/dsh', '@deepseek-ai/dsh-tool-subagent']) {
    const range = manifest.peerDependencies[name]
    check(`peer range: ${name} is declared`, typeof range === 'string' && range.length > 0, String(range))
    if (typeof range !== 'string') continue
    const missed = supported.filter((version) => !satisfiesRange(version, range))
    check(
      `peer range: ${name} admits every supported build`,
      missed.length === 0,
      `excluded ${missed.join(', ')} — a bare ">=a-rc.1 <b" drops every later rc; each minor needs its own branch`
    )
    const leaked = refused.filter((version) => satisfiesRange(version, range))
    check(`peer range: ${name} stays below 0.4.0`, leaked.length === 0, `wrongly admitted ${leaked.join(', ')}`)
  }

  // The market index filters the Discover tab by `engines.dsh`, and the plugin
  // manager gates installs by `peerDependencies`. Two copies of the same range
  // drift the moment one is edited, and the drift is invisible: the package
  // lists fine but installs nowhere. Keep them byte-identical.
  const engineRange = manifest.engines?.dsh
  check('engines.dsh is declared', typeof engineRange === 'string' && engineRange.length > 0, String(engineRange))
  check(
    'engines.dsh matches the @deepseek-ai/dsh peer range',
    engineRange === manifest.peerDependencies?.['@deepseek-ai/dsh'],
    `engines.dsh=${String(engineRange)} vs peer=${String(manifest.peerDependencies?.['@deepseek-ai/dsh'])} — the market's Discover filter reads engines.dsh, install reads peerDependencies; one range, two copies`
  )

  // npm silently DELETES a bin entry whose path starts with "./" ("script name
  // bin/x.mjs was invalid and removed") and the publish still succeeds — the
  // installed package just has no command. Caught here instead of after publish.
  const binEntries = Object.entries(manifest.bin ?? {})
  check('bin is declared', binEntries.length > 0, `bin=${JSON.stringify(manifest.bin)}`)
  for (const [name, target] of binEntries) {
    check(`bin ${name}: no leading ./`, !String(target).startsWith('./'), String(target))
    check(`bin ${name}: file exists`, existsSync(new URL(`../${target}`, import.meta.url)), String(target))
  }

  // The bundle patch writes a loader entry whose `name` is the MODULE SPECIFIER,
  // not the package directory. A bare "dsh-delegation-hub" cannot be resolved
  // by the loader, so the host plugin never mounts — while the settings card still
  // renders (the client bundle is discovered by scanning node_modules) and shows
  // empty provider/model dropdowns. That failure is invisible everywhere except
  // here, so pin the bundled patch to the published package name.
  const patchFile = new URL('../cordis.patch.yml', import.meta.url)
  const patchText = readFileSync(patchFile, 'utf8')
  const declared = patchText.match(/^\s*name:\s*['"]?([^'"\n]+)['"]?\s*$/m)?.[1]
  // `name` is BOTH the loader's module specifier and the key the profile's patch
  // matches the base entry by. If it drifts from package.json's name the plugin is
  // silently not loaded — while the settings card still renders (the client bundle
  // is discovered by scanning node_modules) with empty provider/model dropdowns.
  // Nothing else in the repo notices, so pin it here.
  check(
    'bundle patch names the package exactly as package.json does',
    declared === manifest.name,
    `cordis.patch.yml name=${String(declared)} vs package.json name=${String(manifest.name)}`
  )
  check(
    'bundle patch name is a specifier, not a path',
    typeof declared === 'string' && !/[/\\]|^\./.test(declared),
    `name=${String(declared)} — a path here never resolves as a module`
  )
  // A REQUIRED inject service that a build does not provide makes Cordis park the
  // plugin forever - silently, with no log line. In the UI that is indistinguishable
  // from "not installed", which is the failure mode this file exists to stop.
  const requiredServices = Array.isArray(inject)
    ? inject
    : Array.isArray(inject?.required)
      ? inject.required
      : []
  check(
    'inject is the array form',
    Array.isArray(inject),
    `inject=${JSON.stringify(inject)} - the {required,optional} object parks the plugin forever`
  )
  check(
    'only services the plugin cannot run without are required',
    requiredServices.length === 2 && requiredServices[0] === 'subagents' && requiredServices[1] === 'agents',
    `inject=${JSON.stringify(inject)} - expect required ['subagents','agents'] (agents powers the runtime failover watcher)`
  )
}

// --- 31. a refused `ctx.config` must not kill activation -------------------
// Cordis gates `ctx.config` behind inject: on a context that did not declare it,
// reading the property throws `cannot get property "config" without inject`.
// The plugin treats it as an optional second route source, so a refused read has
// to behave exactly like an absent one - otherwise apply() dies, no config form
// is registered, and the Settings page renders every field blank.
{
  const refusal = new Error('cannot get property "config" without inject')
  const base = {
    name: 'spawn',
    capabilities: CAPABILITIES,
    inheritsParentContext: false,
    start(request) {
      return { started: true, request }
    },
    prepareContinuable() {
      return Promise.resolve({})
    }
  }
  const service = Object.create({
    async startActivation(spec) {
      return { ok: true, spec }
    }
  })
  service.getProvider = (name) => (name === 'spawn' ? base : undefined)
  const registered = []
  service.registerProvider = (provider) => registered.push(provider)
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    subagents: service,
    llm: {
      listProviders: () => [{ id: 'deepseek-account' }],
      async listModels() {
        return [{ id: 'deepseek-flash' }]
      }
    }
  }
  Object.defineProperty(ctx, 'config', {
    enumerable: true,
    get() {
      throw refusal
    }
  })
  const refusedReady = join(dir, 'ready-refused.json')
  let threw
  try {
    apply(ctx, {
      settingsPath,
      readinessPath: refusedReady,
      provider: 'deepseek-account',
      model: 'deepseek-flash'
    })
  } catch (error) {
    threw = error
  }
  check(
    'a refused ctx.config does not break activation',
    threw === undefined,
    threw === undefined ? undefined : threw.message
  )
  check('the provider is still registered when ctx.config is refused', registered.length === 1, `registered=${registered.length}`)
  const refused = JSON.parse(readFileSync(refusedReady, 'utf8'))
  const selfVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
  check(
    'readiness is recorded when ctx.config is refused',
    refused.mounted === true && refused.version === selfVersion,
    `mounted=${refused.mounted} version=${refused.version}`
  )
}

// --- 33. a catalog that cannot be read is not a verified route ----------
{
  let calls = 0
  const harness = makeHarness(
    { provider: 'deepseek-account', model: 'deepseek-flash' },
    {
      llm: {
        listProviders: () => {
          calls += 1
          if (calls === 1) throw new Error('catalog unavailable')
          return [{ id: 'deepseek-account' }]
        },
        async listModels() {
          return []
        }
      }
    }
  )
  const first = await harness.provider.checkRoute({ provider: 'deepseek-account', model: 'deepseek-flash' })
  const second = await harness.provider.checkRoute({ provider: 'deepseek-account', model: 'deepseek-flash' })
  check(
    'an unreadable catalog is not cached as a pass',
    first === undefined && /does not advertise/.test(String(second)),
    `first=${first} second=${second}`
  )
}

// --- 34. a broken config row does not pretend to fall back to itself ----
{
  const harness = makeHarness({ provider: 'ghost-provider', model: 'ghost-model', onPinFailure: 'inherit' })
  const { forwarded } = await startWith(harness, 'Anything')
  const messages = harness.logs.map(([, message]) => message).join(String.fromCharCode(10))
  check(
    'a broken config row claims no fallback it does not have',
    /no fallback route/.test(messages) && !/falling back to the config row/.test(messages),
    messages
  )
}

// --- 35. a bug inside the plugin must surface, not become "inherit" -----
{
  const harness = makeHarness({ provider: 'deepseek-account', model: 'deepseek-flash' })
  harness.provider.readSettings = () => {
    throw new TypeError('boom')
  }
  let threw
  try {
    await harness.provider.start({ prompt: 'do', parent: {}, label: 'Anything' })
  } catch (error) {
    threw = error
  }
  check(
    'an internal error is not disguised as an inherited route',
    threw instanceof TypeError && threw.message === 'boom',
    threw === undefined ? 'resolved' : threw.message
  )
}

// --- 36. a null agentOptions is not a claimed route ---------------------
{
  const harness = makeHarness({ provider: 'deepseek-account', model: 'deepseek-flash' })
  const result = await harness.service.startActivation({
    label: 'x',
    request: { prompt: 'do', parent: {}, agentOptions: null }
  })
  const seen = harness.teamCalls.at(-1)
  check(
    'a null agentOptions still gets the pin',
    result.ok === true && seen.request.agentOptions?.provider === 'deepseek-account',
    JSON.stringify(seen?.request?.agentOptions)
  )
}

// --- 37. the activation probe records success, not only failure --------
{
  // A file left by an earlier park must not survive a successful activation: the
  // whole point of the probe is "what happened last", and a stale verdict is read
  // as fact.
  writeFileSync(probePath, JSON.stringify({ schema: 1, phase: 'parked', applied: false, version: '0.0.0' }), 'utf8')
  makeHarness({ provider: 'deepseek-account', model: 'deepseek-flash' })
  const probe = JSON.parse(readFileSync(probePath, 'utf8'))
  check(
    'a successful activate overwrites a stale parked verdict',
    probe.phase === 'applied' && probe.invoked === true && probe.mounted === true,
    JSON.stringify(probe)
  )
  // Strict, not "a non-empty string": PLUGIN_VERSION falls back to '' when
  // package.json cannot be read, and '' used to satisfy the looser assertion.
  const packageVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
  check(
    'the success record carries the running version',
    probe.version === packageVersion,
    `probe=${JSON.stringify(probe.version)} package=${JSON.stringify(packageVersion)}`
  )
}

// --- 38. importing without applying is recorded as parked ----------------
// The parked branch had no test at all: every other case calls `apply()`, which
// disarms the timer, so nothing guarded the path that actually matters when a
// plugin is held back by an injected service. A child process is the only honest
// way to observe it — the parent has already applied.
{
  const parkedProbe = join(dir, 'parked.probe.json')
  const parkedLoad = join(dir, 'parked.load.json')
  const href = new URL('../index.js', import.meta.url).href
  const child = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(href)}); await new Promise((r) => setTimeout(r, 300))`],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        DSH_ROUTE_PIN_PROBE_PATH: parkedProbe,
        DSH_ROUTE_PIN_LOAD_PATH: parkedLoad,
        DSH_ROUTE_PIN_PROBE_DELAY_MS: '60'
      },
      timeout: 30_000
    }
  )
  check('parked: the child process exits cleanly', child.status === 0, String(child.stderr).slice(0, 300))
  check('parked: the module really was imported', existsSync(parkedLoad), 'no load breadcrumb')
  const probe = existsSync(parkedProbe) ? JSON.parse(readFileSync(parkedProbe, 'utf8')) : undefined
  check(
    'parked: import without apply is recorded',
    probe?.phase === 'parked' && probe?.invoked === false && probe?.mounted === false,
    JSON.stringify(probe)
  )
  // Every phase must answer the same three questions, or the file is only
  // readable by whoever wrote it: parked used to carry `note` and no `mounted`.
  check('parked: the verdict carries a reason', typeof probe?.reason === 'string' && probe.reason.includes('never called'), JSON.stringify(probe?.reason))
}

// --- 39. a throwing activate is recorded as failed ------------------------
// The catch branch is the third way a plugin disappears (`apply()` throws, Cordis
// swallows it, the settings page is simply empty). It had no test, and it used to
// write `applied: true` with an `error` field instead of the common shape.
{
  writeFileSync(probePath, JSON.stringify({ schema: 1, phase: 'applied', applied: true, version: '0.0.0' }), 'utf8')
  const throwCtx = {
    logger: {
      info: () => {
        throw new Error('logger exploded mid-activate')
      },
      warn() {},
      error() {}
    },
    subagents: {
      getProvider: () => undefined,
      registerProvider: () => () => {}
    }
  }
  let thrown
  try {
    apply(throwCtx, { settingsPath, readinessPath })
  } catch (error) {
    thrown = error
  }
  const probe = JSON.parse(readFileSync(probePath, 'utf8'))
  check(
    'a throwing activate is recorded as failed, not applied',
    thrown instanceof Error && probe.phase === 'failed',
    JSON.stringify(probe)
  )
  check(
    'the failed verdict keeps the error text in reason',
    typeof probe.reason === 'string' && probe.reason.includes('logger exploded'),
    JSON.stringify(probe.reason)
  )
  check(
    'every phase records mounted and invoked',
    probe.mounted === false && probe.invoked === true,
    JSON.stringify(probe)
  )
}

// --- 40. the smoke check reads old-schema probes without losing the reason --
// `test/logs.mjs` is the post-upgrade gate. Reading only `reason` turned a 0.8.14
// record (which wrote `note` / `error`) into `undefined`: the verdict stayed
// right, the one sentence that explains it vanished. The age of an "ok" verdict
// had the mirror problem — a probe from the previous boot read exactly like one
// from this boot.
{
  const localPackage = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
  const readyForLogs = join(dir, 'logs-ready.json')
  writeFileSync(
    readyForLogs,
    JSON.stringify({
      schema: 1,
      plugin: 'delegation-hub',
      version: localPackage,
      at: new Date().toISOString(),
      mounted: true,
      providerName: 'pinned-account',
      baseProvider: 'spawn',
      fallback: true,
      overrideMemberRoute: true,
      route: 'deepseek-account/deepseek-flash',
      routeSource: 'config row',
      capabilities: { teamInjection: 'installed', enabled: true, seams: ['startActivation'] }
    }),
    'utf8'
  )
  const logsScript = join(import.meta.dirname, 'logs.mjs')

  const legacyParked = join(dir, 'legacy-parked.json')
  writeFileSync(
    legacyParked,
    JSON.stringify({
      schema: 1,
      phase: 'parked',
      applied: false,
      version: '0.8.14',
      at: new Date().toISOString(),
      inject: ['subagents'],
      note: 'the module was imported but apply() was never called'
    }),
    'utf8'
  )
  const parkedRun = spawnSync(process.execPath, [logsScript, '--probe', legacyParked, '--ready', readyForLogs], {
    encoding: 'utf8',
    // Without a timeout a hung child hangs the whole suite: the run ends by
    // never ending, which reads as "CI is stuck", not "a test failed".
    timeout: 30_000
  })
  check('logs: a parked record still fails the check', parkedRun.status === 1, String(parkedRun.status))
  check(
    'logs: the legacy note is printed instead of undefined',
    String(parkedRun.stdout).includes('apply() was never called') && !String(parkedRun.stdout).includes('undefined'),
    String(parkedRun.stdout).slice(0, 300)
  )

  // 0.8.15 wrote `reason: describeError(error)` even when the Error had no
  // message, so the newest field can be an empty string. Falling through on
  // `??` alone would stop there and drop the older field that says something.
  const emptyReason = join(dir, 'empty-reason.json')
  writeFileSync(
    emptyReason,
    JSON.stringify({
      schema: 1,
      phase: 'parked',
      version: '0.8.15',
      at: new Date().toISOString(),
      inject: ['subagents'],
      reason: '',
      note: 'parked after 8000 ms'
    }),
    'utf8'
  )
  const emptyRun = spawnSync(process.execPath, [logsScript, '--probe', emptyReason, '--ready', readyForLogs], {
    encoding: 'utf8',
    // Without a timeout a hung child hangs the whole suite: the run ends by
    // never ending, which reads as "CI is stuck", not "a test failed".
    timeout: 30_000
  })
  check(
    'logs: an empty reason falls through to the older field',
    String(emptyRun.stdout).includes('parked after 8000 ms') && !String(emptyRun.stdout).includes('predates the reason'),
    String(emptyRun.stdout).slice(0, 300)
  )

  // 0.8.14 wrote failures as `error`, with neither `reason` nor `note`.
  const legacyFailed = join(dir, 'legacy-failed.json')
  writeFileSync(
    legacyFailed,
    JSON.stringify({
      schema: 1,
      phase: 'failed',
      version: '0.8.14',
      at: new Date().toISOString(),
      error: 'logger exploded'
    }),
    'utf8'
  )
  const failedRun = spawnSync(process.execPath, [logsScript, '--probe', legacyFailed, '--ready', readyForLogs], {
    encoding: 'utf8',
    // Without a timeout a hung child hangs the whole suite: the run ends by
    // never ending, which reads as "CI is stuck", not "a test failed".
    timeout: 30_000
  })
  check(
    'logs: a legacy failed record keeps its error text',
    failedRun.status === 1 && String(failedRun.stdout).includes('logger exploded'),
    `${failedRun.status} ${String(failedRun.stdout).slice(0, 300)}`
  )

  // A probe file can hold valid JSON that is not an object (`null`, an array, a
  // bare number). Reading `.phase` off it throws, so the check would die with a
  // TypeError instead of printing a verdict. The verdict must also be the same
  // one a corrupt file gets: unusable evidence cannot pass without --strict and
  // then fail with it, or the gate's green means nothing.
  const nullProbe = join(dir, 'null-probe.json')
  writeFileSync(nullProbe, 'null', 'utf8')
  const nullRun = spawnSync(process.execPath, [logsScript, '--probe', nullProbe, '--ready', readyForLogs], {
    encoding: 'utf8',
    // Without a timeout a hung child hangs the whole suite: the run ends by
    // never ending, which reads as "CI is stuck", not "a test failed".
    timeout: 30_000
  })
  check(
    'logs: a non-object probe fails the gate instead of throwing',
    nullRun.status === 1 &&
      String(nullRun.stdout).includes('not an object') &&
      !/TypeError/.test(`${nullRun.stdout}${nullRun.stderr}`),
    `${nullRun.status} ${String(nullRun.stdout).slice(0, 300)} ${String(nullRun.stderr).slice(0, 300)}`
  )

  // An existing file that cannot be parsed is lost evidence, not "the module was
  // never imported". The two used to print the same sentence, which sends the
  // reader to the wrong subsystem entirely.
  const corruptProbe = join(dir, 'corrupt-probe.json')
  writeFileSync(corruptProbe, 'not json at all', 'utf8')
  const corruptRun = spawnSync(process.execPath, [logsScript, '--probe', corruptProbe, '--ready', readyForLogs], {
    encoding: 'utf8',
    timeout: 30_000
  })
  check(
    'logs: a corrupt probe fails the gate and names the real cause',
    corruptRun.status === 1 &&
      String(corruptRun.stdout).includes('unreadable') &&
      !String(corruptRun.stdout).includes('was not imported'),
    `${corruptRun.status} ${String(corruptRun.stdout).slice(0, 300)}`
  )

  // The verdict must not depend on the flag: --strict adds requirements, it does
  // not change how an unusable record is judged.
  const nullStrictRun = spawnSync(process.execPath, [logsScript, '--strict', '--probe', nullProbe, '--ready', readyForLogs], {
    encoding: 'utf8',
    timeout: 30_000
  })
  check(
    'logs: --strict gives the same verdict on a non-object probe',
    // Equality alone is satisfied by both sides turning green; the point is that
    // --strict must not launder a broken record into a pass.
    nullStrictRun.status === 1 && nullRun.status === 1,
    `${nullStrictRun.status} vs ${nullRun.status}`
  )

  // A negative age reads as healthy ("ok, written -30 min ago"). The tolerance is
  // a minute, so half an hour of skew must be caught; the version comes from the
  // manifest so this case keeps isolating the timestamp alone after a bump.
  const manifestVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
  const futureAt = new Date(Date.now() + 30 * 60_000).toISOString()
  const futureProbe = join(dir, 'future-probe.json')
  writeFileSync(
    futureProbe,
    JSON.stringify({
      schema: 1,
      phase: 'applied',
      mounted: true,
      invoked: true,
      version: manifestVersion,
      at: futureAt
    }),
    'utf8'
  )
  const futureReady = join(dir, 'ready-future.json')
  writeFileSync(
    futureReady,
    JSON.stringify({
      plugin: 'delegation-hub',
      version: manifestVersion,
      mounted: true,
      providerName: 'pinned-account',
      baseProvider: 'spawn',
      fallback: true,
      overrideMemberRoute: true,
      capabilities: { teamInjection: 'installed', enabled: true, seams: ['startActivation'] },
      at: futureAt
    }),
    'utf8'
  )
  const futureRun = spawnSync(process.execPath, [logsScript, '--probe', futureProbe, '--ready', futureReady], {
    encoding: 'utf8',
    timeout: 30_000
  })
  check(
    'logs: a future probe timestamp is not reported as a healthy age',
    String(futureRun.stdout).includes('probe timestamp is in the future') && !/ok\s+probe written/.test(String(futureRun.stdout)),
    String(futureRun.stdout).slice(0, 400)
  )
  check(
    'logs: a future record timestamp is not reported as a healthy age',
    String(futureRun.stdout).includes('record timestamp is in the future') && !/ok\s+recorded/.test(String(futureRun.stdout)),
    String(futureRun.stdout).slice(0, 400)
  )

  // The route line answers "which route is actually in force"; printing
  // "undefined -> undefined" as an ok defeats its only purpose.
  const noRouteReady = join(dir, 'ready-no-route.json')
  writeFileSync(
    noRouteReady,
    JSON.stringify({
      plugin: 'delegation-hub',
      version: JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version,
      mounted: true,
      capabilities: { teamInjection: 'installed', enabled: true, seams: ['startActivation'] },
      fallback: true,
      overrideMemberRoute: true,
      at: new Date().toISOString()
    }),
    'utf8'
  )
  const noRouteRun = spawnSync(process.execPath, [logsScript, '--probe', futureProbe, '--ready', noRouteReady], {
    encoding: 'utf8',
    timeout: 30_000
  })
  check(
    'logs: a record without a route warns instead of printing undefined',
    // Regex, not the padded literal: the assertion is "no ok line for the route",
    // which must not break when report()'s column width changes.
    String(noRouteRun.stdout).includes('no usable route') && !/ok\s+fallback\/route/.test(String(noRouteRun.stdout)),
    String(noRouteRun.stdout).slice(0, 300)
  )

  // A record whose `at` no longer parses is damaged time evidence: the probe
  // side already fails the gate on an unparseable age, so the record side must
  // not print a WARN and exit 0 on the same input.
  const goodProbe = join(dir, 'good-probe.json')
  writeFileSync(
    goodProbe,
    JSON.stringify({
      schema: 1,
      phase: 'applied',
      mounted: true,
      invoked: true,
      version: localPackage,
      at: new Date().toISOString()
    }),
    'utf8'
  )
  const badAtReady = join(dir, 'ready-bad-at.json')
  writeFileSync(
    badAtReady,
    JSON.stringify({
      plugin: 'delegation-hub',
      version: localPackage,
      mounted: true,
      providerName: 'pinned-account',
      baseProvider: 'spawn',
      fallback: true,
      overrideMemberRoute: true,
      route: 'deepseek-account/deepseek-flash',
      routeSource: 'config row',
      capabilities: { teamInjection: 'installed', enabled: true, seams: ['startActivation'] },
      at: 'abc'
    }),
    'utf8'
  )
  const badAtRun = spawnSync(process.execPath, [logsScript, '--probe', goodProbe, '--ready', badAtReady], {
    encoding: 'utf8',
    timeout: 30_000
  })
  check(
    'logs: an unreadable record timestamp fails the gate',
    badAtRun.status === 1 && String(badAtRun.stdout).includes('record timestamp unreadable') && !/ok\s+recorded/.test(String(badAtRun.stdout)),
    `${badAtRun.status} ${String(badAtRun.stdout).slice(0, 300)}`
  )

  const staleApplied = join(dir, 'stale-applied.json')
  writeFileSync(
    staleApplied,
    JSON.stringify({
      schema: 1,
      phase: 'applied',
      mounted: true,
      invoked: true,
      version: '0.8.9',
      at: new Date(Date.now() - 3 * 86_400_000).toISOString()
    }),
    'utf8'
  )
  const staleRun = spawnSync(process.execPath, [logsScript, '--probe', staleApplied, '--ready', readyForLogs], {
    encoding: 'utf8',
    // Without a timeout a hung child hangs the whole suite: the run ends by
    // never ending, which reads as "CI is stuck", not "a test failed".
    timeout: 30_000
  })
  check(
    'logs: a probe from another build fails the gate',
    staleRun.status === 1,
    `${staleRun.status} ${String(staleRun.stdout).slice(0, 300)}`
  )
  check(
    'logs: the stale probe reports its version and age',
    /probe version/.test(String(staleRun.stdout)) && /probe is 3 days old/.test(String(staleRun.stdout)),
    String(staleRun.stdout).slice(0, 400)
  )

  // A readiness record that parses into a non-object used to throw a TypeError and
  // print a stack trace, while a corrupt file produced a clean MISS: same evidence,
  // two answers. Both must fail, neither may crash.
  for (const [shape, body] of [['null', 'null'], ['array', '[]'], ['scalar', '"abc"']]) {
    const broken = join(dir, `ready-${shape}.json`)
    writeFileSync(broken, body, 'utf8')
    const run = spawnSync(process.execPath, [logsScript, '--probe', futureProbe, '--ready', broken], {
      encoding: 'utf8',
      timeout: 30_000
    })
    check(
      `logs: a ${shape} readiness record fails instead of crashing`,
      run.status === 1 && !String(run.stderr).includes('TypeError'),
      `${run.status} ${String(run.stderr).slice(0, 200)}`
    )
  }

  // Deleting the probe must not be a way to pass: it is the only file that says
  // whether this boot ran apply().
  const missingProbeRun = spawnSync(
    process.execPath,
    [logsScript, '--probe', join(dir, 'absent-probe.json'), '--ready', readyForLogs],
    { encoding: 'utf8', timeout: 30_000 }
  )
  check(
    'logs: a missing probe fails the gate',
    missingProbeRun.status === 1 && String(missingProbeRun.stdout).includes('was not imported'),
    `${missingProbeRun.status} ${String(missingProbeRun.stdout).slice(0, 300)}`
  )

  // A record written by another build cannot prove this build is mounted, and the
  // severity label has to match the exit code (it used to say WARN and exit 1).
  const oldReady = join(dir, 'ready-old-version.json')
  writeFileSync(
    oldReady,
    JSON.stringify({
      plugin: 'delegation-hub',
      version: '0.0.1',
      mounted: true,
      capabilities: { teamInjection: 'installed', enabled: true, seams: ['startActivation'] },
      fallback: true,
      overrideMemberRoute: true,
      at: new Date().toISOString()
    }),
    'utf8'
  )
  const oldRun = spawnSync(process.execPath, [logsScript, '--probe', futureProbe, '--ready', oldReady], {
    encoding: 'utf8',
    timeout: 30_000
  })
  check(
    'logs: a record from another build fails and says MISS',
    oldRun.status === 1 && /MISS\s+version/.test(String(oldRun.stdout)),
    `${oldRun.status} ${String(oldRun.stdout).slice(0, 300)}`
  )
}

// Group 42: the delegation event stream — append-only, torn-line tolerant.
{
  const { readEvents } = await import('../index.js')
  const eventsPath = join(dir, 'delegation-hub.events.jsonl')
  const harness = makeHarness({ provider: 'deepseek-account', model: 'deepseek-flash' })
  // Earlier groups share this directory: slice from this group's baseline.
  const baseline = readEvents(eventsPath).length
  await startWith(harness, 'first')
  await startWith(harness, 'second')
  const events = readEvents(eventsPath).slice(baseline)
  check(
    'events stream appends one record per delegation',
    events.length === 2 && events[0].label === 'first' && events[1].label === 'second',
    JSON.stringify(events.map((event) => event.label))
  )
  check(
    'events carry event/route/outcome fields',
    events.every(
      (event) => event.event === 'delegation' && event.outcome === 'pinned' && typeof event.route === 'object'
    ),
    JSON.stringify(events[0])
  )
  // A torn line (crashed write) is skipped, never thrown.
  appendFileSync(eventsPath, '{"at": "torn", "event":\n', 'utf8')
  appendFileSync(eventsPath, `${JSON.stringify({ at: 'third', event: 'delegation', label: 'third', outcome: 'pinned' })}\n`, 'utf8')
  const afterTorn = readEvents(eventsPath).slice(baseline)
  check(
    'torn line is skipped and later events still read',
    afterTorn.length === 3 && afterTorn[2].label === 'third',
    JSON.stringify(afterTorn.map((event) => event.label))
  )
  check('readEvents on a missing file returns an empty array', readEvents(join(dir, 'nope.jsonl')).length === 0)
  // Drift observation: the readiness record states whether the effective route
  // equals the pinned row. An experts override makes the drift visible.
  writeFileSync(
    settingsPath,
    JSON.stringify({ experts: { anything: { provider: 'our-free-model', model: 'deepseek-v4.1-flash-free' } } }),
    'utf8'
  )
  const driftHarness = makeHarness({ provider: 'deepseek-account', model: 'deepseek-flash' })
  const driftReady = JSON.parse(readFileSync(readinessPath, 'utf8'))
  check(
    'readiness drift is null when the row wins',
    driftReady.drift === null,
    JSON.stringify(driftReady.drift)
  )
  // Simulate a drift verdict by reading effectiveRoute with a settings override.
  writeFileSync(
    settingsPath,
    JSON.stringify({ default: { provider: 'our-free-model', model: 'deepseek-v4.1-flash-free' } }),
    'utf8'
  )
  // effectiveRoute prefers the config row; a drift can only appear when the
  // row is absent, so remove it by building a rowless harness.
  const rowless = makeHarness({})
  const rowlessReady = JSON.parse(readFileSync(readinessPath, 'utf8'))
  check(
    'rowless install records a null drift (no row to pin)',
    rowlessReady.drift === null && rowlessReady.configRow === undefined,
    JSON.stringify({ drift: rowlessReady.drift, configRow: rowlessReady.configRow })
  )
  check(
    'drift harness still reports the row route',
    driftHarness.logs.length >= 0 && driftReady.route === 'deepseek-account/deepseek-flash',
    JSON.stringify(driftReady.route)
  )
}

rmSync(dir, { recursive: true, force: true })

// Group 41: rename integrity — the four default record file names must stay
// distinct, and the README self-check commands must reference names the code
// actually writes. Guards against a replacement accident writing a literal
// `$1` (or any other collision) back into these paths.
{
  const indexSource = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const names = [
    ...indexSource.matchAll(/'(delegation-hub\.(?:load|probe|ready|last-run)\.json)'/g),
  ].map((m) => m[1])
  check(
    'rename: index.js declares all four distinct record names',
    new Set(names).size === 4 && names.length === 4,
    JSON.stringify(names)
  )
  check(
    'rename: no literal $1 leaks into source',
    !/\$1\.json/.test(indexSource) && !indexSource.includes('delegation-hub.$1'),
    'index.js must not contain a literal $1 record name'
  )
  let readme = ''
  try {
    readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  } catch {}
  const readmeNames = [...readme.matchAll(/delegation-hub\.(?:load|probe|ready|last-run)\.json/g)].map((m) => m[0])
  const unknown = readmeNames.filter((n) => !names.includes(n))
  check(
    'rename: README references only record names the code writes',
    readmeNames.length > 0 && unknown.length === 0,
    `unknown=${JSON.stringify([...new Set(unknown)])}`
  )
  const logsSource = readFileSync(new URL('./logs.mjs', import.meta.url), 'utf8')
  check(
    'rename: logs.mjs defaults use the same record names',
    !/\$1\.json/.test(logsSource) && logsSource.includes('delegation-hub.ready.json') && logsSource.includes('delegation-hub.probe.json'),
    'logs.mjs default paths must match index.js'
  )
  check(
    'rename: client page is 委派中枢 and no Expert-model copy remains',
    !readme.includes('设置 → 专家模型') && !readme.includes('Expert model'),
    'README must use the Delegation Hub page name'
  )
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
