/**
 * dsh-delegation-hub — Host half.
 *
 * Registers ONE extra subagent provider that delegates to an already-registered
 * provider (default `spawn`) while pinning the child LLM route. The framework
 * lets a delegating agent inherit its own route into every child; a provider
 * wrapper is the only place where a child's route can still be chosen before
 * the child Agent is created, because `SubagentManager.start` hands the request
 * to `provider.start(request)`.
 *
 * Route resolution, highest priority first:
 *   1. settings file `experts[<label>]`   — per-expert override (advanced, optional)
 *   2. this plugin's config row           — the normal control (Settings → Plugins)
 *   3. settings file `default`            — legacy fallback, only when the row has no route
 *
 * The config-row fields `provider` / `model` / `reasoningEffort` / `maxTokens`
 * are declared `volatile()`: the Host settings service writes them into the
 * profile patch and the Cordis loader updates this module's live config without
 * remounting it. They are therefore read through an accessor on every spawn, so
 * a change applies to the next delegation with no restart.
 *
 * The settings file is re-read on every `start()` (content-compared), so per
 * expert overrides also switch without a restart. An unreadable or malformed
 * file falls back to the last successful parse, then to the config row.
 *
 * Resolved routes are checked against `ctx.llm` catalogs on a best-effort
 * basis — catalog membership is advisory in DSH, so a mismatch warns and falls
 * back instead of blocking, unless `strict: true`.
 *
 * The team-mode hook is wrapped in `TeamInjectionAdapter`, which probes the
 * creation seams once — `startActivation` first (the current contract: the
 * native delegation tool and Agent-Teams both call it), then `startContinuable`
 * (the older name) — and publishes a capability flag
 * (`{ teamInjection, enabled, seams, reason }`) on the service under
 * `Symbol.for('dsh-delegation-hub.team-hook')`, also readable through the
 * pre-0.8 `…continuable-hook` symbol and through `teamInjectionCapabilities()`.
 * A caller that sees `unavailable` knows team members keep the parent route and
 * can degrade deliberately instead of trusting a log line; because `seams`
 * names what was actually wrapped, hooking a method the build does not call can
 * no longer pass for success.
 *
 * `fallback` (default on) makes a failed pin non-fatal: if the wrapped
 * provider's `start()` rejects, the request is retried once on the route the
 * caller already had (the parent/inherited route); a team member whose creation
 * call rejects is retried with `request.agentOptions` removed. Only start-time
 * failures are observable at this seam — a quota error raised later, inside the
 * child's own LLM stream, cannot be caught here.
 */

import { appendFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'

export const name = 'delegation-hub'

// Array form ONLY. Cordis reads `inject` as a service list; the `{ required, optional }`
// object form is not supported by this runtime and makes it wait forever for services
// literally named "required"/"optional" — parked plugin, no log line, and a settings page
// with empty provider/model dropdowns. Every plugin in the ecosystem uses the array form.
//
// `webServer` powers the same-origin read routes the Settings page fetches
// (/delegation-hub/last-run, /delegation-hub/options); without declaring it the
// service never appears on ctx and both registrations silently no-op. It is a
// core desktop service (the web GUI itself runs on it), same hard requirement
// as `subagents`. `skills` feeds the options route's skill-name candidates;
// the desktop profile always mounts @deepseek-ai/dsh-skill, and the listing
// call site still guards a missing/throwing registry down to [].
//
// `llm` is deliberately NOT listed: it is only read by the best-effort route check, whose
// call site is wrapped in try/catch, so a build without it must degrade, not park.
export const inject = ['subagents', 'agents', 'webServer', 'skills']

/**
 * Activation probe. `load.json` proves only that the entry file was imported; it
 * says nothing about whether the host ever called `apply()`. A plugin parked on a
 * service the context never provides looks healthy from the outside: no log line,
 * no error, and every setting it owns renders as an empty dropdown. This timer
 * turns that silence into a file we can read after a restart.
 */
const PROBE_DELAY_MS = (() => {
  // Overridable so a test can observe the parked branch without waiting 8 seconds.
  const raw = Number(process.env.DSH_ROUTE_PIN_PROBE_DELAY_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 8000
})()
let applied = false

/** Verbatim copy of the `spawn` provider's start-time capabilities. */
const CAPABILITIES = {
  agentOptions: true,
  outputSchema: true,
  depthLimit: true,
  toolFilter: true,
  persona: true
}

const SUCCESS_CACHE_MS = 10 * 60 * 1000
const FAILURE_CACHE_MS = 60 * 1000

/** Marks the service object that already carries this plugin's team hook. */
const CONTINUABLE_HOOK = Symbol.for('dsh-delegation-hub.continuable-hook')

const PLUGIN = 'delegation-hub'

const DEFAULT_SETTINGS_PATH = join(homedir(), '.dsh', 'subagent-route-pin.json')

/**
 * Where this plugin records its own readiness.
 *
 * `ctx.logger.info` reaches the DSH process console (visible in the GUI's dev
 * console or the terminal DSH was started from) but is not persisted, and
 * `~/.dsh/logs/startup-*.log` is a diagnostics dump written only when startup
 * FAILS. A post-upgrade check therefore needs a file it can read: one small JSON
 * record per boot, overwritten each time.
 */
const DEFAULT_READINESS_PATH = join(homedir(), '.dsh', 'delegation-hub.ready.json')

/**
 * Last delegated run, overwritten on every start. The readiness record answers
 * "did the plugin mount"; this one answers "did the route I picked actually work",
 * which is the question a user asks after the model failed.
 */
const RUN_RECORD_NAME = 'delegation-hub.last-run.json'
// Same-origin read route the Settings page uses to fetch the newest run record.
// The browser has no file access and the host exposes no file-reading RPC, so a
// named WebRoute is the only host-to-page surface for it.
const LAST_RUN_ROUTE = '/delegation-hub/last-run'
// Same-origin read route that lists the skills and Agency experts the page's
// step editor can offer as autocomplete choices. Free typing stays valid — the
// lists only seed a datalist, they never constrain the field.
const OPTIONS_ROUTE = '/delegation-hub/options'
// Append-only delegation event stream: one JSON object per line. Tree views,
// captain reports and evidence anchors read this instead of the single-slot
// last-run file, because overwriting would drop every earlier delegation.
const EVENTS_NAME = 'delegation-hub.events.jsonl'

/** Plugin version, read once; a missing package.json is not fatal. */
const PLUGIN_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version
  } catch {
    return undefined
  }
})()

/**
 * Publish the readiness record. Never throws: a read-only home directory must not
 * take the profile down, it only costs the post-upgrade check its evidence.
 */
function recordReadiness(path, record) {
  try {
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    return undefined
  } catch (error) {
    return describeError(error)
  }
}

/** Read a config value that may be a live accessor (volatile) or plain. */
function valueOf(field) {
  if (typeof field === 'function') return field()
  if (field !== null && typeof field === 'object' && typeof field.get === 'function') return field.get()
  return field
}

/**
 * Schema for the config form (Settings → Plugins). The bare specifier resolves
 * through the DSH loader; when this bundle is linked from outside the profile
 * tree that resolution fails, so every profile under `~/.dsh/profiles` is probed
 * as a fallback. Without a schema the plugin still pins routes from the settings
 * file, it just has no form.
 */
async function loadSchemastery() {
  const candidates = ['@deepseek-ai/schemastery']
  let profiles = []
  try {
    profiles = readdirSync(join(homedir(), '.dsh', 'profiles'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    profiles = []
  }
  for (const profile of profiles) {
    for (const file of ['lib/index.mjs', 'lib/index.js']) {
      candidates.push(
        pathToFileURL(join(homedir(), '.dsh', 'profiles', profile, 'node_modules', '@deepseek-ai', 'schemastery', file)).href
      )
    }
  }
  for (const specifier of candidates) {
    try {
      const loaded = await import(specifier)
      const schema = loaded.default ?? loaded
      if (typeof schema?.object === 'function') return schema
    } catch {
      /* try the next specifier */
    }
  }
  return undefined
}

/** Build the config schema; a missing or incompatible schemastery is not fatal. */
function makeConfig(z) {
  if (z === undefined) return undefined
  try {
    return z.object({
      providerName: z.string().default('pinned-account'),
      baseProvider: z.string().default('spawn'),
      settingsPath: z.string().default(DEFAULT_SETTINGS_PATH),
      readinessPath: z.string().default(DEFAULT_READINESS_PATH),
      strict: z.boolean().default(false),
      fallback: z.boolean().default(true),
      // What a *configured* route does when it cannot run. 'fail' (default) makes
      // the summon error visible; 'inherit' silently falls back to the parent route.
      onPinFailure: z.string().default('fail'),
      // Fill the agency-agents row's provider in on mount so a fresh install needs
      // no hand-edited YAML. Off only when someone wants to wire it themselves.
      autoWireAgency: z.boolean().default(true),
      teamInjection: z.boolean().default(true).volatile(),
      // Agent Teams always fills `request.agentOptions` from its own
      // `memberLlmProvider` / `memberModel`, so "only fill an empty slot" would
      // never pin a single team member. Default on: the pinned route wins.
      overrideMemberRoute: z.boolean().default(true).volatile(),
      // Runtime failover (running-delegation lane): when a pinned child hits a
      // lane failure mid-flight (quota drained, auth revoked, adapter gone),
      // its next requests are rewritten to this route once. Distinct from
      // `fallback` (start-time only). Absent = the feature is off.
      failoverRoute: z
        .object({ provider: z.string().min(1), model: z.string().min(1) })
        .volatile(),
      // Step-splitter lanes edited on the Settings page (merged with the
      // settings-file steps at resolve time; the row wins per key).
      // Steps lanes serialized as a JSON string: schemastery 3.18.5 in some
      // profiles lacks z.record/z.dict, and z.any drops nested objects, so a
      // plain string is the only shape that survives every version.
      stepsJson: z.string().volatile(),
      provider: z.string().volatile(),
      model: z.string().volatile(),
      reasoningEffort: z.string().volatile(),
      maxTokens: z.number().step(1).min(1).volatile()
    })
  } catch {
    return undefined
  }
}

/**
 * Config schema exported under the name the Cordis loader reads. `volatile()`
 * on the route fields is what lets the Settings page write them into the live
 * config without remounting this plugin.
 */
export const Config = makeConfig(await loadSchemastery())

function text(value, field, fallback) {
  if (value === undefined || value === null || value === '') {
    if (fallback !== undefined) return fallback
    throw new Error(`${PLUGIN}: ${field} must be a non-empty string`)
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${PLUGIN}: ${field} must be a non-empty string`)
  }
  return value.trim()
}

/**
 * Point the agency-agents row at this provider.
 *
 * Agency only reaches this plugin when its row says `provider: pinned-account`;
 * leaving that as a hand edit is the step people skip. The rewrite is surgical
 * (one `provider:` line inside the agency block), the original file is backed up
 * once per change, and it is a no-op when the row is already wired or absent.
 */
export function wireAgencyProvider(profileRoot, providerName, logger) {
  const patchPath = join(profileRoot, 'cordis.patch.yml')
  let source
  try {
    source = readFileSync(patchPath, 'utf8')
  } catch {
    return { changed: false, reason: 'no cordis.patch.yml' }
  }
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const lines = source.split(/\r?\n/)
  const start = lines.findIndex((line) => /^-\s+id:\s*agency-agents\s*$/.test(line))
  if (start < 0) return { changed: false, reason: 'no agency-agents row' }
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^-\s+id:/.test(lines[i])) {
      end = i
      break
    }
  }
  const block = lines.slice(start, end)
  const providerIndex = block.findIndex((line) => /^\s+provider:\s*\S/.test(line))
  if (providerIndex >= 0) {
    if (block[providerIndex].trim() === `provider: ${providerName}`) return { changed: false, reason: 'already wired' }
    block[providerIndex] = block[providerIndex].replace(/provider:\s*\S+.*$/, `provider: ${providerName}`)
  } else {
    const configIndex = block.findIndex((line) => /^\s+config:\s*$/.test(line))
    if (configIndex < 0) return { changed: false, reason: 'no config block' }
    const indent = (block[configIndex].match(/^\s*/) ?? [''])[0] + '  '
    block.splice(configIndex + 1, 0, `${indent}provider: ${providerName}`)
  }
  const next = [...lines.slice(0, start), ...block, ...lines.slice(end)].join(eol)
  try {
    writeFileSync(`${patchPath}.bak-autowire-${Date.now()}`, source, 'utf8')
    writeFileSync(patchPath, next, 'utf8')
  } catch (error) {
    return { changed: false, reason: describeError(error) }
  }
  logger?.info?.(`${PLUGIN}: agency-agents row routes through "${providerName}" (${patchPath})`)
  return { changed: true, patchPath }
}

/** Wire every profile that actually depends on agency-agents. Never throws. */
function wireAgencyProfiles(providerName, logger) {
  let profiles = []
  try {
    profiles = readdirSync(join(homedir(), '.dsh', 'profiles'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return
  }
  for (const profile of profiles) {
    const root = join(homedir(), '.dsh', 'profiles', profile)
    try {
      const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
      const deps = { ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}) }
      if (deps['@michengai/dsh-agency-agents'] === undefined) continue
    } catch {
      continue
    }
    try {
      wireAgencyProvider(root, providerName, logger)
    } catch (error) {
      logger?.warn?.(`${PLUGIN}: cannot wire the agency row in ${root}: ${describeError(error)}`)
    }
  }
}

/**
 * Validate one `{ provider, model, reasoningEffort?, maxTokens? }` route.
 * `optional` lets the whole route be absent (the row may carry none and leave
 * every decision to the settings file).
 */
function normalizeRoute(value, field, optional = false) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${PLUGIN}: ${field} must be an object with provider and model`)
  }
  // Trim once, here, so every consumer — the optional-absence check below, the
  // row fields, the settings file — sees the same values. A whitespace-only
  // field must behave exactly like an absent one: the optional check used to
  // compare raw strings, so `reasoningEffort: " "` sailed past the `''` guard,
  // reached text(), and made the whole plugin refuse to mount.
  const provider = typeof value.provider === 'string' ? value.provider.trim() : value.provider
  const model = typeof value.model === 'string' ? value.model.trim() : value.model
  const effort = typeof value.reasoningEffort === 'string' ? value.reasoningEffort.trim() : value.reasoningEffort
  if (
    optional &&
    (provider === undefined || provider === '') &&
    (model === undefined || model === '') &&
    (effort === undefined || effort === '') &&
    (value.maxTokens === undefined || value.maxTokens === null)
  ) {
    return undefined
  }
  const route = {
    provider: text(provider, `${field}.provider`),
    model: text(model, `${field}.model`)
  }
  if (effort !== undefined && effort !== null && effort !== '') {
    route.reasoningEffort = text(effort, `${field}.reasoningEffort`)
  }
  if (value.maxTokens !== undefined && value.maxTokens !== null) {
    if (!Number.isSafeInteger(value.maxTokens) || value.maxTokens <= 0) {
      throw new Error(`${PLUGIN}: ${field}.maxTokens must be a positive integer`)
    }
    route.maxTokens = value.maxTokens
  }
  return route
}

function routeKey(route) {
  return `${route.provider}/${route.model}`
}

/** One-line rendering for logs; never throws on odd thrown values. */
function describeError(error) {
  return error instanceof Error ? error.message : String(error)
}

function normalizeSettings(parsed) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('the settings root must be a JSON object')
  }
  const settings = {
    default: normalizeRoute(parsed.default, 'default'),
    experts: new Map(),
    roles: new Map(),
    steps: new Map(),
    rawSteps: new Map(),
    match: 'exact'
  }
  if (parsed.match !== undefined) {
    if (parsed.match !== 'exact' && parsed.match !== 'contains') {
      throw new Error('match must be "exact" or "contains"')
    }
    settings.match = parsed.match
  }
  if (parsed.experts !== undefined && parsed.experts !== null) {
    if (typeof parsed.experts !== 'object' || Array.isArray(parsed.experts)) {
      throw new Error('experts must be an object keyed by expert name')
    }
    for (const [key, value] of Object.entries(parsed.experts)) {
      const route = normalizeRoute(value, `experts[${JSON.stringify(key)}]`)
      if (route !== undefined) settings.experts.set(key.trim().toLowerCase(), route)
    }
  }
  if (parsed.roles !== undefined && parsed.roles !== null) {
    if (typeof parsed.roles !== 'object' || Array.isArray(parsed.roles)) {
      throw new Error('roles must be an object keyed by member role')
    }
    for (const [key, value] of Object.entries(parsed.roles)) {
      const route = normalizeRoute(value, `roles[${JSON.stringify(key)}]`)
      if (route !== undefined) settings.roles.set(key.trim().toLowerCase(), route)
    }
  }
  if (parsed.steps !== undefined && parsed.steps !== null) {
    if (typeof parsed.steps !== 'object' || Array.isArray(parsed.steps)) {
      throw new Error('steps must be an object keyed by step name')
    }
    for (const [key, value] of Object.entries(parsed.steps)) {
      const route = normalizeRoute(value, `steps[${JSON.stringify(key)}]`)
      if (route !== undefined) {
        settings.steps.set(key.trim().toLowerCase(), route)
        if (value !== null && typeof value === 'object') settings.rawSteps.set(key.trim().toLowerCase(), value)
      }
    }
  }
  return settings
}

/**
 * Parse a team member label into its identity: `agent-teams:<teamId>:<member>`
 * plus the captain's workspace cwd (from the delegating parent's session
 * header). Returns undefined for anything that is not a well-formed team
 * label with a resolvable cwd.
 */
function teamRefFromLabel(label, parentAgent) {
  if (typeof label !== 'string' || !label.startsWith('agent-teams:')) return undefined
  const rest = label.slice('agent-teams:'.length)
  const sep = rest.indexOf(':')
  if (sep < 1 || sep === rest.length - 1) return undefined
  const teamId = rest.slice(0, sep)
  const memberName = rest.slice(sep + 1)
  if (teamId === '' || memberName === '') return undefined
  const cwd =
    parentAgent && typeof parentAgent === 'object'
      ? parentAgent.session && typeof parentAgent.session === 'object'
        ? parentAgent.session.header && typeof parentAgent.session.header === 'object'
          ? parentAgent.session.header.cwd
          : undefined
        : undefined
      : undefined
  if (typeof cwd !== 'string' || cwd === '') return undefined
  return { teamId, memberName, cwd }
}

/**
 * Resolve the Agent-Teams role for a delegated member from its label.
 *
 * Team labels look like `agent-teams:<teamId>:<memberName>` ( MEMBER_LABEL_PREFIX
 * in @nanmicoder/dsh-agent-teams ). The member's role lives in the durable team
 * state file `<captain cwd>/.agent-teams/<teamId>/team.json` under
 * `members[].role`. Every failure — no team label, unreadable state, unknown
 * member, odd shapes — degrades to `undefined`, because a role is an optional
 * routing refinement and must never break a delegation.
 * @param label - the delegation label carried on the seam spec.
 * @param parentAgent - the delegating parent agent; its session cwd locates the
 *   team state directory.
 * @returns the lower-cased role string, or undefined when unknown.
 */
function roleForLabel(label, parentAgent) {
  try {
    const ref = teamRefFromLabel(label, parentAgent)
    if (ref === undefined) return undefined
    const { teamId, memberName, cwd } = ref
    const teamPath = join(cwd, '.agent-teams', teamId, 'team.json')
    const team = JSON.parse(readFileSync(teamPath, 'utf8'))
    if (team === null || typeof team !== 'object' || !Array.isArray(team.members)) return undefined
    const member = team.members.find(
      (candidate) =>
        candidate !== null &&
        typeof candidate === 'object' &&
        typeof candidate.name === 'string' &&
        candidate.name === memberName
    )
    const role = member === undefined ? undefined : member.role
    return typeof role === 'string' && role.trim() !== '' ? role.trim().toLowerCase() : undefined
  } catch {
    return undefined
  }
}


/**
 * Deliver one lane-failure report to the team captain's mailbox, using the
 * exact JSONL contract of @nanmicoder/dsh-agent-teams (isTeamMessage requires
 * id/from/to/content/ts). Written read-merge-rewrite like its appendMailbox,
 * so writes from both sides interleave without dropping lines. Any failure —
 * missing cwd, unreadable directory, read-only home — degrades to a skipped
 * report; the failover itself has already happened and is recorded elsewhere.
 */
function reportToCaptain(ref, text) {
  try {
    const inboxDir = join(ref.cwd, '.agent-teams', ref.teamId, 'inbox')
    const file = join(inboxDir, 'captain.jsonl')
    let existing = ''
    try {
      existing = readFileSync(file, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    const separator = existing !== '' && !existing.endsWith('\n') ? '\n' : ''
    const message = {
      id: randomUUID(),
      from: 'delegation-hub',
      to: 'captain',
      content: text,
      ts: Date.now()
    }
    writeFileSync(file, `${existing}${separator}${JSON.stringify(message)}
`, 'utf8')
  } catch {
    /* a report must never break the delegation */
  }
}

/**
 * Build the step-directive prompt prefix for one delegation, or '' when the
 * step lane declares no expert and no skills. The directive is advisory
 * text in the child's first user message: it tells the child which persona
 * to adopt (agency expert name) and which skills to load (skill names),
 * without touching the host's persona/skill machinery — those stay owned by
 * the agent preset system. Anything odd degrades to ''.
 */
function stepDirectivePrefix(stepKey, lane) {
  try {
    if (lane === null || typeof lane !== 'object') return ''
    const expert = typeof lane.expert === 'string' ? lane.expert.trim() : ''
    const skills = Array.isArray(lane.skills)
      ? lane.skills.filter((skill) => typeof skill === 'string' && skill.trim() !== '')
      : []
    if (expert === '' && skills.length === 0) return ''
    const parts = []
    if (expert !== '') parts.push(`以「${expert}」专家的身份与专业水准完成本任务`)
    if (skills.length > 0) parts.push(`优先加载并使用技能：${skills.join('、')}`)
    return `[步骤 ${stepKey}] ${parts.join('；')}。\n\n`
  } catch {
    return ''
  }
}

/**
 * Prepend the step directive to the child's first prompt text block, in place
 * on the request object.
 *
 * The rewrite REBUILDS the prompt array instead of writing into the caller's
 * text block: both call sites keep a shallow `{ ...request }` copy and a retry
 * reuses the same prompt object, so an in-place prepend would stack a second
 * directive on the retry. A block that already starts with the directive is
 * left untouched, which makes the whole call idempotent.
 *
 * @param request - the seam request; `request.prompt` is replaced when it holds
 *   a text block. Anything else (no prompt, no text block, no directive) is a
 *   no-op.
 * @param stepKey - the resolved step name, used to build the directive.
 * @param lane - the step lane carrying `expert` / `skills`.
 */
function prependStepDirective(request, stepKey, lane) {
  if (request === null || typeof request !== 'object') return
  if (!Array.isArray(request.prompt)) return
  const directive = stepDirectivePrefix(stepKey, lane)
  if (directive === '') return
  const idx = request.prompt.findIndex((block) => block !== null && typeof block === 'object' && block.type === 'text')
  if (idx < 0) return
  const block = request.prompt[idx]
  const text = typeof block.text === 'string' && block.text.startsWith(directive) ? block.text : `${directive}${block.text ?? ''}`
  request.prompt = request.prompt.map((b, i) => (i === idx ? { ...b, text } : b))
}

/**
 * Attribution carried by every run record: the route actually in force plus the
 * step / expert / skills the label resolved through. Every field is best-effort
 * and omitted when absent, so records written before this existed still parse
 * and readers degrade field-by-field instead of breaking on a missing key.
 *
 * @param route - the route that ran. For a failover record this is the
 *   switched-to route, which is the one the child's later requests use.
 * @param picked - the pick result carrying `stepKey`/`lane` when the label
 *   resolved through a step lane; `undefined` when nothing matched.
 * @returns {{model?: string, step?: string, expert?: string, skills?: string[]}}
 */
function runAttribution(route, picked) {
  const out = {}
  try {
    if (route !== null && typeof route === 'object' && typeof route.provider === 'string' && typeof route.model === 'string') {
      out.model = `${route.provider}/${route.model}`
    }
    const pick = picked !== null && typeof picked === 'object' ? picked : undefined
    if (pick !== undefined && typeof pick.stepKey === 'string' && pick.stepKey.trim() !== '') out.step = pick.stepKey.trim()
    const lane = pick !== undefined && pick.lane !== null && typeof pick.lane === 'object' ? pick.lane : undefined
    if (lane !== undefined) {
      if (typeof lane.expert === 'string' && lane.expert.trim() !== '') out.expert = lane.expert.trim()
      if (Array.isArray(lane.skills)) {
        const skills = lane.skills
          .filter((skill) => typeof skill === 'string' && skill.trim() !== '')
          .map((skill) => skill.trim())
        if (skills.length > 0) out.skills = skills
      }
    }
  } catch {
    /* attribution is advisory; a malformed pick must never break a record */
  }
  return out
}

/** Read one step lane (route + expert + skills) from the merged steps map. */
function stepLaneOf(stepsMap, stepKey) {
  if (stepsMap === undefined || stepsMap === null) return undefined
  if (typeof stepsMap.get !== 'function') return undefined
  const lane = stepsMap.get(stepKey)
  if (lane === undefined || lane === null || typeof lane !== 'object') return undefined
  return lane
}

/**
 * The route-pinning provider. Everything is resolved lazily: the base provider
 * is looked up per call (this plugin may be applied before the spawn provider
 * registers), the config row is read through live accessors, and the settings
 * file is re-read per call (hot switching).
 */
class RoutePinProvider {
  capabilities = CAPABILITIES

  constructor(options) {
    this.options = options
    // `registerProvider` keys the provider table by `provider.name`, so the
    // wrapper must expose the configured name (it is not a class name).
    this.name = options.config.providerName
  }

  base() {
    const { ctx, config } = this.options
    if (typeof ctx.subagents.getProvider !== 'function') {
      throw new Error(`${PLUGIN}: ctx.subagents.getProvider is unavailable in this DSH build`)
    }
    const provider = ctx.subagents.getProvider(config.baseProvider)
    if (provider === undefined || provider === null) {
      throw new Error(`${PLUGIN}: base subagent provider "${config.baseProvider}" is not registered`)
    }
    return provider
  }

  get inheritsParentContext() {
    try {
      return this.base().inheritsParentContext === true
    } catch {
      return false
    }
  }

  prepareContinuable(request) {
    const base = this.base()
    if (typeof base.prepareContinuable !== 'function') {
      throw new Error(`${PLUGIN}: base provider "${this.options.config.baseProvider}" has no prepareContinuable`)
    }
    return base.prepareContinuable(request)
  }

  /**
   * The route currently configured on the plugin row, read live.
   *
   * Volatile fields are served as accessors whose identity survives a settings
   * write, so the captured config object is normally enough. `ctx.config` is
   * consulted as a second source in case a loader generation swapped the
   * accessors underneath us; a source without both fields is skipped instead of
   * raising, so an unrelated shape can never break a working route.
   */
  configuredRoute() {
    const { ctx, config } = this.options
    const sources = [config]
    // `ctx.config` is itself inject-gated: reading it on a context that did not
    // declare it raises `cannot get property "config" without inject` and kills
    // activation. It is only an optional second source, so a refused read must
    // behave exactly like an absent one.
    let live
    try {
      live = ctx.config
    } catch {
      live = undefined
    }
    if (live !== undefined && live !== null && live !== config) sources.push(live)
    for (const source of sources) {
      const provider = valueOf(source.provider)
      const model = valueOf(source.model)
      if (typeof provider !== 'string' || provider.trim() === '') continue
      if (typeof model !== 'string' || model.trim() === '') continue
      return normalizeRoute(
        {
          provider,
          model,
          reasoningEffort: valueOf(source.reasoningEffort),
          maxTokens: valueOf(source.maxTokens)
        },
        'config',
        true
      )
    }
    return undefined
  }

  /** Re-read the settings file, keeping the last good parse on failure. */
  readSettings() {
    const { ctx, config, state } = this.options
    let source
    try {
      source = readFileSync(config.settingsPath, 'utf8')
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.code === 'ENOENT') {
        if (state.settingsText !== undefined) {
          state.settingsText = undefined
          state.settings = undefined
          ctx.logger.info(`${PLUGIN}: ${config.settingsPath} removed; using the config row`)
        }
        return undefined
      }
      ctx.logger.warn(`${PLUGIN}: cannot read ${config.settingsPath}: ${String(error)}`)
      return state.settings
    }
    if (source === state.settingsText) return state.settings
    state.settingsText = source
    try {
      const settings = normalizeSettings(JSON.parse(source))
      state.settings = settings
      ctx.logger.info(
        `${PLUGIN}: settings reloaded from ${config.settingsPath} ` +
          `(match=${settings.match}, experts=${settings.experts.size}, default=${settings.default === undefined ? 'none' : routeKey(settings.default)})`
      )
      return settings
    } catch (error) {
      ctx.logger.warn(
        `${PLUGIN}: ignoring ${config.settingsPath}: ${describeError(error)}`
      )
      return state.settings
    }
  }

  /**
   * Resolve the route for one child. Per-expert overrides win, then the
   * member's Agent-Teams role (label `agent-teams:<team>:<member>` + the team
   * state file), then the row the Settings page writes, then a legacy
   * `default` in the settings file.
   */
  resolve(label, settings, configured, role, rowSteps) {
    // Merge the two steps sources up front: the Settings-page row wins per key,
    // the settings file supplies everything the row does not name. The row may
    // carry its lanes as a JSON string (the version-proof config shape).
    if (typeof rowSteps === 'string' && rowSteps.trim() !== '') {
      try {
        rowSteps = JSON.parse(rowSteps)
      } catch {
        rowSteps = undefined
      }
    }
    let stepsMap = settings !== undefined ? settings.steps : undefined
    let rawStepsMap = settings !== undefined ? settings.rawSteps : undefined
    if (rowSteps !== undefined && rowSteps !== null && typeof rowSteps === 'object' && !Array.isArray(rowSteps)) {
      const merged = new Map(stepsMap ?? [])
      const mergedRaw = new Map(rawStepsMap ?? [])
      for (const [key, value] of Object.entries(rowSteps)) {
        const route = normalizeRoute(value, `rowSteps[${JSON.stringify(key)}]`)
        if (route !== undefined) {
          merged.set(key.trim().toLowerCase(), route)
          if (value !== null && typeof value === 'object') mergedRaw.set(key.trim().toLowerCase(), value)
        }
      }
      stepsMap = merged
      rawStepsMap = mergedRaw
    }
    if (settings !== undefined) {
      const key = typeof label === 'string' ? label.trim().toLowerCase() : ''
      if (key !== '') {
        const exact = settings.experts.get(key)
        if (exact !== undefined) return { route: exact, source: `experts[${JSON.stringify(key)}]` }
        if (settings.match === 'contains') {
          for (const [candidate, route] of settings.experts) {
            if (key.includes(candidate)) return { route, source: `experts[${JSON.stringify(candidate)}] (contains)` }
          }
        }
      }
      if (typeof role === 'string' && role !== '') {
        const roleRoute = settings.roles.get(role)
        if (roleRoute !== undefined) return { route: roleRoute, source: `roles[${JSON.stringify(role)}]` }
      }
      // Step-splitter tier: a label ending in `#<name>` (or matching a step
      // key exactly) routes through that step. This is the deterministic
      // "different model per step": the delegating agent splits one goal into
      // serial sub-delegations, each labelled with its step name. The plain
      // label without the suffix never hits this tier, so unmixed delegations
      // are unaffected.
      const hash = key.lastIndexOf('#')
      const stepKey = hash >= 0 && hash < key.length - 1 ? key.slice(hash + 1) : key
      const stepRoute = stepsMap !== undefined ? stepsMap.get(stepKey) : undefined
      if (stepRoute !== undefined) {
        const via = hash >= 0 ? ' (#suffix)' : ''
        return { route: stepRoute, source: `steps[${JSON.stringify(stepKey)}]${via}`, stepKey, lane: stepLaneOf(rawStepsMap, stepKey) }
      }
    }
    if (configured !== undefined) return { route: configured, source: 'config row' }
    if (settings !== undefined && settings.default !== undefined) return { route: settings.default, source: 'settings default' }
    throw Object.assign(
      new Error(
        `${PLUGIN}: no route for expert ${JSON.stringify(label ?? null)} — ` +
          `pick a model in Settings → 委派中枢 (the plugin's own page), or put a "default" route in ${this.options.config.settingsPath}`
      ),
      { routeMissing: true }
    )
  }

  /**
   * The route a delegation would get right now, and where it came from.
   *
   * The readiness record used to answer "did it mount" only, which hid a real
   * failure mode: `~/.dsh/subagent-route-pin.json` could name one model while the
   * config row named another, and the row silently won. Reporting both — and which
   * one is effective — makes that visible without running a delegation.
   */
  effectiveRoute() {
    const settings = this.readSettings()
    const configured = this.configuredRoute()
    const settingsDefault = settings === undefined ? undefined : settings.default
    const experts = settings === undefined ? 0 : settings.experts.size
    if (configured !== undefined) {
      return {
        route: routeKey(configured),
        source: 'config row',
        configRow: routeKey(configured),
        settingsDefault: settingsDefault === undefined ? undefined : routeKey(settingsDefault),
        experts,
        shadowed: settingsDefault !== undefined
      }
    }
    if (settingsDefault !== undefined) {
      return {
        route: routeKey(settingsDefault),
        source: 'settings default',
        settingsDefault: routeKey(settingsDefault),
        experts
      }
    }
    return { route: undefined, source: 'none', experts }
  }

  /**
   * Best-effort catalog check. DSH treats catalog membership as advisory, so a
   * miss returns a problem string instead of throwing; `strict` turns it fatal.
   */
  async checkRoute(route) {
    const { ctx, state } = this.options
    const key = routeKey(route)
    const cached = state.checked.get(key)
    const now = Date.now()
    if (cached !== undefined) {
      const ttl = cached.problem === undefined ? SUCCESS_CACHE_MS : FAILURE_CACHE_MS
      if (now - cached.at < ttl) return cached.problem
    }
    let problem
    // A catalog that cannot be read is not the same as a route that passed:
    // caching that as a success would mark an unverified route as verified for
    // the whole success TTL, which quietly disables `strict` after one hiccup.
    let verified = true
    try {
      const providers = ctx.llm.listProviders()
      const known = providers.some((provider) => provider.id === route.provider)
      if (!known) {
        problem = `provider "${route.provider}" is not registered (available: ${providers.map((provider) => provider.id).join(', ') || 'none'})`
      } else {
        const models = await ctx.llm.listModels(route.provider)
        if (!models.some((model) => model.id === route.model)) {
          problem = `provider "${route.provider}" does not advertise model "${route.model}" (advertised: ${models.map((model) => model.id).join(', ')})`
        }
      }
    } catch (error) {
      verified = false
      ctx.logger.warn(`${PLUGIN}: route check skipped for ${key}: ${describeError(error)}`)
      problem = undefined
    }
    if (verified) state.checked.set(key, { at: now, problem })
    return problem
  }

  /** Persist the outcome of one delegation; never throws. */
  recordRun(entry) {
    const { config } = this.options
    try {
      writeFileSync(
        join(dirname(config.readinessPath), RUN_RECORD_NAME),
        `${JSON.stringify({ at: new Date().toISOString(), ...entry }, null, 2)}\n`,
        'utf8'
      )
    } catch {
      /* a read-only home must not break a delegation */
    }
    // Append the same outcome to the delegation event stream. The last-run
    // file is a single-slot overwrite (the newest verdict only); the stream is
    // what tree views, captain reports and evidence anchors read. Each line is
    // one JSON object; a crashed write leaves a torn line that readers skip.
    try {
      const record = { at: new Date().toISOString(), ...entry }
      if (record.event === undefined) record.event = 'delegation'
      appendFileSync(join(dirname(config.readinessPath), EVENTS_NAME), `${JSON.stringify(record)}\n`, 'utf8')
    } catch {
      /* a read-only home must not break a delegation */
    }
  }

  /**
   * Resolve + validate the route for one label.
   *
   * Returns `undefined` when no usable route exists and `strict` is off: the
   * child then simply inherits the parent's route, which is exactly what a
   * freshly installed plugin with no configuration should do. A missing route
   * must never make a delegation fail — that would turn an optional feature into
   * an outage on every machine that forgot one line of YAML.
   *
   * `soft: true` (team mode) additionally swallows a strict-mode throw, because a
   * broken route must not take member creation down with it.
   */
  async pickRoute(label, soft = false) {
    const { ctx, config } = this.options
    const strict = config.strict === true
    try {
      const settings = this.readSettings()
      const configured = this.configuredRoute()
      const picked = this.resolve(label, settings, configured, undefined, valueOf(this.options.config.stepsJson))
      let route = picked.route
      let source = picked.source
      const problem = await this.checkRoute(route)
      if (problem !== undefined) {
        const message = `${PLUGIN}: ${problem} (route came from ${source})`
        // A route only exists here because somebody configured it, so an unusable
        // one is a configuration mistake the user has to see; running on another
        // model silently is the one outcome they must never discover from a log.
        if (strict || config.onPinFailure !== 'inherit') {
          throw Object.assign(new Error(message), { routeFailure: true })
        }
        // "Fall back to the config row" is only a fallback when the route did not
        // come from that row. If it did, `route` and `configured` are the same
        // route: retrying it would sleepwalk into the same failure while the log
        // claimed a working fallback existed.
        if (configured === undefined || source === 'config row') {
          ctx.logger.warn(`${message}; no fallback route, so the child inherits the parent model`)
          return undefined
        }
        ctx.logger.warn(`${message}; falling back to the config row ${routeKey(configured)}`)
        route = configured
        source = 'config row (fallback)'
      }
      return { ...picked, route, source }
    } catch (error) {
      // Only routing findings may degrade to "the child inherits the parent
      // model". A TypeError from a bug in this plugin used to take the same
      // branch, so the real defect showed up as one warn line and a subagent
      // quietly running somewhere else.
      const finding =
        error !== null && typeof error === 'object' && (error.routeFailure === true || error.routeMissing === true)
      if (!finding) throw error
      // A configured-but-unusable route is a finding, not a missing optional: it
      // must reach the caller (and the user) instead of degrading like a bare install.
      if (error.routeFailure === true && soft !== true) throw error
      if (strict && soft !== true) throw error
      ctx.logger.warn(
        `${PLUGIN}: no usable route, the child inherits the parent model: ${describeError(error)}`
      )
      return undefined
    }
  }

  async start(request) {
    const { ctx, config } = this.options
    const label = request !== null && typeof request === 'object' ? request.label : undefined
    const base = this.base()
    const picked = await this.pickRoute(label)
    if (picked === undefined) {
      // Zero-config install (or a route that no longer exists): delegate untouched
      // so the child inherits the parent route instead of the summon failing.
      ctx.logger.info(
        `${PLUGIN}: label=${JSON.stringify(label ?? null)} -> inherited (no pinned route configured)`
      )
      return base.start({ ...request })
    }
    const { route, source } = picked
    const agentOptions = { ...(request.agentOptions ?? {}), provider: route.provider, model: route.model }
    if (route.reasoningEffort !== undefined) agentOptions.reasoningEffort = route.reasoningEffort
    if (route.maxTokens !== undefined) agentOptions.maxTokens = route.maxTokens
    // Step-directive: when this label resolved through a step lane that names
    // an expert and/or skills, prepend the advisory prefix to the child's
    // first prompt text block.
    if (picked.stepKey !== undefined) prependStepDirective(request, picked.stepKey, picked.lane)
    ctx.logger.info(
      `${PLUGIN}: label=${JSON.stringify(label ?? null)} -> ${routeKey(route)}` +
        `${route.reasoningEffort === undefined ? '' : ` effort=${route.reasoningEffort}`} (${source})`
    )
    try {
      const handle = await base.start({ ...request, agentOptions })
      this.recordRun({ label, route, outcome: 'pinned', ...runAttribution(route, picked) })
      return handle
    } catch (error) {
      // The pinned route is the one most likely to run dry (a free lane), so a
      // start-time failure must not be the end of the delegation: retry once on
      // whatever route the caller already had (normally the parent's).
      const inherited = request.agentOptions
      const sameRoute = inherited !== undefined && inherited.provider === route.provider && inherited.model === route.model
      const canRetry = config.fallback !== false && config.onPinFailure === 'inherit' && !sameRoute
      this.recordRun({ label, route, outcome: 'failed', reason: describeError(error), ...runAttribution(route, picked) })
      if (!canRetry) {
        // Loud by default. The user picked this route on purpose; running the child
        // on some other model without saying so is the exact failure this plugin
        // exists to prevent, so the summon error is the honest surface.
        ctx.logger.error(
          `${PLUGIN}: pinned route ${routeKey(route)} failed for label=${JSON.stringify(label ?? null)}: ${describeError(error)}`
        )
        const failure = new Error(
          `委派中枢 ${routeKey(route)} 调用失败：${describeError(error)}\n` +
            `处理：打开 设置 → 委派中枢 换一个可用模型（或在插件行把 onPinFailure 设为 inherit，允许失败时回退到主 agent 的模型）。`
        )
        failure.cause = error
        throw failure
      }
      ctx.logger.warn(
        `${PLUGIN}: pinned route ${routeKey(route)} failed to start (${describeError(error)}); ` +
          `retrying on the inherited route ${inherited === undefined ? '(parent default)' : routeKey(inherited)}`
      )
      return base.start({ ...request })
    }
  }
}

/** Values of the `teamInjection` capability flag. */
const TEAM_INJECTION_INSTALLED = 'installed'
const TEAM_INJECTION_UNAVAILABLE = 'unavailable'

/**
 * Creation seams a team-mode member can arrive through, most-preferred first.
 *
 * `startActivation` is the current contract: `SubagentRuntime` exposes it, the
 * native delegation tool calls it, and Agent-Teams' `startMember()` prefers it.
 * `startContinuable` is the older name kept by dsh 0.2.0-rc.x. `start` is the
 * single-shot path and is already covered by the provider wrapper, so it is not
 * hooked here.
 *
 * Hooking the wrong one of these is invisible from the outside — the plugin
 * mounts, logs a warning, and team members silently keep the parent route —
 * which is why the probe reports which seam it actually wrapped.
 */
const TEAM_SEAMS = ['startActivation', 'startContinuable']

/** Marks the service object that already carries this plugin's team hook. */
const TEAM_HOOK = Symbol.for('dsh-delegation-hub.team-hook')

/**
 * Pre-0.8 symbol. Still published and still read, so a caller that learned the
 * old path keeps working after the upgrade.
 */
const HOOK_SYMBOLS = [TEAM_HOOK, CONTINUABLE_HOOK]

/** First hook slot published on a service, under either symbol. */
function readHookSlot(service) {
  if (service === null || service === undefined) return undefined
  for (const symbol of HOOK_SYMBOLS) {
    const slot = service[symbol]
    if (slot !== undefined) return slot
  }
  return undefined
}

/** Publish a negative probe result, so "cannot inject" is readable, not inferred. */
function publishUnavailable(service, reason) {
  if (service === null || service === undefined) return
  const capabilities = { teamInjection: TEAM_INJECTION_UNAVAILABLE, enabled: false, seams: [], reason }
  for (const symbol of HOOK_SYMBOLS) service[symbol] = { capabilities }
}

/**
 * Lane failure codes that justify a runtime failover, mirroring
 * @nanmicoder/dsh-agent-teams FALLBACK_FAILURE_CODES: the lane is exhausted,
 * unauthorized, or gone — not a transient model error.
 */
const FAILOVER_FAILURE_CODES = new Set(['QUOTA', 'RATE_LIMIT', 'AUTH', 'MISSING_CREDENTIAL', 'NO_ADAPTER'])

/**
 * Team-mode hook, behind an adapter.
 *
 * Continuable children (Agent-Teams members, agency's native engine) never pass
 * through `provider.start(request)` on this seam: `SubagentRuntime.startActivation()`
 * dispatches to `SubagentManager.startLocal(spec)` whenever the provider
 * implements `prepareContinuable`, and `startLocal` reads `request.agentOptions`
 * itself to resolve the child's route. Filling that field before the call is
 * therefore the only injection point, and the service object is not frozen, so
 * one own property per seam on `ctx.subagents` covers it.
 *
 * The adapter turns a missing seam into a *state* instead of a log line:
 * `probe()` records which seams exist (and why none do), `capabilities()`
 * publishes `{ teamInjection, enabled, seams, reason }`, and a caller reads it
 * from `teamInjectionCapabilities(service)` or from the service symbol to decide
 * whether to degrade. Because the seam name is part of that state, "wrapped
 * `startContinuable` on a build that only has `startActivation`" can no longer
 * look like success.
 *
 * The hook is installed at most once per service; later plugin generations only
 * swap the resolver, so a remount never double-wraps. Injection never throws: a
 * missing route leaves the member on the inherited (parent) route, and with
 * `fallback` on, a rejected creation call is retried once without the injected
 * route instead of failing the delegation.
 */
class TeamInjectionAdapter {
  constructor(ctx, options) {
    this.ctx = ctx
    // The normalized config row `apply()` validated. The hook reads the route and
    // the switches from here; `options.config` is a Cordis field and reading it
    // from inside a seam hook throws `cannot get property "config" without inject`.
    this.options = options
    this.service = ctx.subagents
    this.installed = false
    this.reason = undefined
    /** Seams actually wrapped by this generation, most-preferred first. */
    this.seams = []
  }

  /** Seams this service exposes, most-preferred first. */
  availableSeams() {
    const service = this.service
    if (service === null || service === undefined) return []
    return TEAM_SEAMS.filter((seam) => typeof service[seam] === 'function')
  }

  /** Probe the seams without mutating anything. */
  probe() {
    const service = this.service
    if (service === null || service === undefined) {
      return {
        teamInjection: TEAM_INJECTION_UNAVAILABLE,
        seams: [],
        reason: 'ctx.subagents is unavailable in this DSH build'
      }
    }
    const seams = this.availableSeams()
    if (seams.length === 0) {
      return {
        teamInjection: TEAM_INJECTION_UNAVAILABLE,
        seams,
        reason: `ctx.subagents exposes none of ${TEAM_SEAMS.join(' / ')} in this DSH build`
      }
    }
    return { teamInjection: TEAM_INJECTION_INSTALLED, seams, reason: undefined }
  }

  /**
   * Capability snapshot. `enabled` mirrors the live (volatile) `teamInjection`
   * switch, so a caller can tell "cannot inject" from "turned off".
   */
  capabilities() {
    if (!this.installed) {
      return {
        teamInjection: TEAM_INJECTION_UNAVAILABLE,
        enabled: false,
        seams: [],
        reason: this.reason
      }
    }
    const slot = readHookSlot(this.service)
    let enabled
    if (slot !== undefined && typeof slot.resolve === 'function') {
      const provider = slot.resolve()
      if (provider !== undefined) enabled = valueOf(provider.options.config.teamInjection) !== false
    }
    return {
      teamInjection: TEAM_INJECTION_INSTALLED,
      enabled,
      seams: this.seams,
      reason: this.reason
    }
  }

  /**
   * Build one seam hook. Both `startActivation(spec)` and
   * `startContinuable(spec)` receive `{ label, request, ... }`, so one body
   * serves both; only the captured `raw` differs.
   */
  makeHook(seam, slot) {
    const service = this.service
    const ctx = this.ctx
    // `provider` / `model` / `reasoningEffort` stay live accessors, so the route is
    // rebuilt per call: a Settings-page edit must reach the next delegation without
    // a remount.
    const readRoute = (own) => {
      // The single-shot path resolves the row through normalizeRoute: values are
      // trimmed, an empty effort means "no pin", maxTokens is validated. Reading
      // the raw accessors here made the seams drift — a blank effort was
      // forwarded verbatim and killed every continuable child on its first turn
      // with UNSUPPORTED_REASONING_EFFORT, while a row maxTokens never reached a
      // team member at all. Reuse the same normalizer so one row cannot mean two
      // routes; a malformed row resolves to no route (soft mode then falls back)
      // instead of throwing.
      try {
        return normalizeRoute(
          {
            provider: valueOf(own.provider),
            model: valueOf(own.model),
            reasoningEffort: valueOf(own.reasoningEffort),
            maxTokens: valueOf(own.maxTokens)
          },
          'config',
          true
        )
      } catch {
        return undefined
      }
    }
    return async function routePinHook(spec) {
      const entry = slot.seams[seam]
      const request = spec !== null && typeof spec === 'object' ? spec.request : undefined
      let injected
      let original
      let fallback = false
      let mayInherit = false
      // Hoisted for the start-failure path below: `pinned` is declared inside the
      // first try block, but the retry branch runs in the second one.
      let pinnedInstance
      try {
        // Per call, not per mount: a remount swaps `slot.resolve` and `slot.options`,
        // and the pin has to follow the newest generation of the plugin.
        const pinned = slot.resolve()
        pinnedInstance = pinned
        const own = slot.options ?? {}
        const teamInjection = valueOf(own.teamInjection) !== false
        const overrideMemberRoute = valueOf(own.overrideMemberRoute) !== false
        // Two different retries live here, and only one of them is a model swap:
        //  · the caller named its own route (Agent Teams' memberLlmProvider) —
        //    dropping our pin and retrying on *that* route honours the caller;
        //  · the caller named nothing — retrying means "inherit the parent
        //    model", which the plugin row may forbid (`onPinFailure: fail`, the
        //    default). Same contract as the single-shot path.
        fallback = valueOf(own.fallback) === true
        mayInherit = valueOf(own.onPinFailure) === 'inherit'
        const configured = readRoute(own)
        if (pinned !== undefined && teamInjection && request !== null && typeof request === 'object') {
          // Agent Teams fills `agentOptions` from its own `memberLlmProvider` /
          // `memberModel`, so an empty-slot-only rule would never pin a member.
          // `overrideMemberRoute` (default on) lets the pinned route win; a caller
          // that already chose a route keeps it when the flag is off.
          const claimed =
            request.agentOptions !== undefined && request.agentOptions !== null && typeof request.agentOptions === 'object'
          const mayOverride = claimed ? overrideMemberRoute : true
          let picked
          if (mayOverride) {
            try {
              const role = roleForLabel(spec.label, request.parent)
              const resolved = pinned.resolve(spec.label, pinned.readSettings(), configured, role, valueOf(own.stepsJson))
              const problem = await pinned.checkRoute(resolved.route)
              if (problem === undefined) {
                picked = resolved
              } else {
                // Soft mode: an unusable route must not take the delegation down,
                // but it must never pass in silence either.
                ctx.logger.warn(
                  `${PLUGIN}: ${problem} (route came from ${resolved.source}); child inherits the parent model`
                )
              }
            } catch (error) {
              ctx.logger.warn(`${PLUGIN}: ${describeError(error)}; the child inherits the parent model`)
            }
          }
          // A nested seam (an older runtime calling one method from the other)
          // already carries the route: re-picking the same route would only add a
          // duplicate log line, so treat "already pinned" as done.
          const alreadyPinned =
            picked !== undefined &&
            claimed &&
            request.agentOptions.provider === picked.route.provider &&
            request.agentOptions.model === picked.route.model
          if (picked !== undefined && !alreadyPinned) {
            const agentOptions = claimed ? { ...request.agentOptions } : {}
            agentOptions.provider = picked.route.provider
            agentOptions.model = picked.route.model
            if (picked.route.reasoningEffort !== undefined) {
              agentOptions.reasoningEffort = picked.route.reasoningEffort
            } else if (claimed) {
              // The pinned route says nothing about effort; the claimed value was
              // calibrated for the *old* route, so let the runtime pick the default.
              delete agentOptions.reasoningEffort
            }
            if (picked.route.maxTokens !== undefined) agentOptions.maxTokens = picked.route.maxTokens
            if (claimed) original = request.agentOptions
            request.agentOptions = agentOptions
            injected = picked
            if (picked.stepKey !== undefined) prependStepDirective(request, picked.stepKey, picked.lane)
            pinned.recordRun({
              label: spec.label,
              route: picked.route,
              outcome: 'pinned',
              channel: 'team',
              source: picked.source,
              ...runAttribution(picked.route, picked)
            })
            ctx.logger.info(
              `${PLUGIN}: team member label=${JSON.stringify(spec.label ?? null)} -> ` +
                `${routeKey(picked.route)}${picked.route.reasoningEffort === undefined ? '' : ` effort=${picked.route.reasoningEffort}`} (${picked.source})`
            )
          }
        }
      } catch (error) {
        ctx.logger.warn(`${PLUGIN}: team member route injection skipped: ${describeError(error)}`)
      }
      try {
        const started = await entry.raw.call(service, spec)
        // Runtime failover: once the child is live, watch its request errors.
        // A lane failure (quota/auth/adapter) rewrites the child's subsequent
        // requests to the failover route exactly once. Requires the `agents`
        // registry (injected at the apply site); every unavailable piece
        // degrades to plain observation-by-absence — no watcher, no crash.
        try {
          const own = slot.options ?? {}
          const failover = valueOf(own.failoverRoute)
          if (
            failover !== undefined &&
            failover !== null &&
            typeof failover === 'object' &&
            typeof failover.provider === 'string' &&
            failover.provider !== '' &&
            typeof failover.model === 'string' &&
            failover.model !== '' &&
            started !== null &&
            typeof started === 'object' &&
            typeof started.childId === 'string'
          ) {
            slot.adapter.armFailover(
              started.childId,
              { provider: failover.provider, model: failover.model },
              spec.label,
              pinnedInstance?.recordRun.bind(pinnedInstance),
              request.parent,
              injected
            )
          }
        } catch (failoverError) {
          ctx.logger.warn(`${PLUGIN}: failover watch skipped: ${describeError(failoverError)}`)
        }
        return started
      } catch (error) {
        // A member that cannot start on the pinned route must not lose the whole
        // delegation: drop the injection and retry once on the inherited route.
        if (injected === undefined || fallback !== true) throw error
        // Retrying with no route in hand means the child runs on the parent model.
        if (original === undefined && mayInherit !== true) {
          ctx.logger.warn(
            `${PLUGIN}: team member ${JSON.stringify(spec.label ?? null)} failed to start on ${routeKey(injected.route)} ` +
              `(${describeError(error)}); onPinFailure is "fail", so it is not retried on the parent model`
          )
          throw error
        }
        // Restore what the caller asked for: dropping the whole object would also
        // throw away Agent Teams' own member route.
        if (original === undefined) delete request.agentOptions
        else request.agentOptions = original
        pinnedInstance?.recordRun({
          label: spec.label,
          route: injected.route,
          outcome: 'failed',
          reason: describeError(error),
          channel: 'team',
          ...runAttribution(injected.route, injected)
        })
        ctx.logger.warn(
          `${PLUGIN}: team member ${JSON.stringify(spec.label ?? null)} failed to start on ${routeKey(injected.route)} ` +
            `(${describeError(error)}); retrying on the ${original === undefined ? 'inherited' : 'requested'} route`
        )
        return entry.raw.call(service, spec)
      }
    }
  }

  /** Install the hook once, or swap the resolver on a later generation. */
  install(resolveProvider) {
    const service = this.service
    const ctx = this.ctx
    const probe = this.probe()
    if (probe.teamInjection === TEAM_INJECTION_UNAVAILABLE) {
      this.installed = false
      this.reason = probe.reason
      this.seams = []
      // Publish the negative result too: a caller that looks at the service after
      // a failed probe must be able to read *why* team injection is off.
      publishUnavailable(service, probe.reason)
      ctx.logger.warn(
        `${PLUGIN}: team-mode injection unavailable (${probe.reason}); team-mode members keep the parent route`
      )
      return this
    }
    const existing = readHookSlot(service)
    if (existing !== undefined && existing.adapter !== undefined) {
      existing.resolve = resolveProvider
      // The hook reads its config row from the slot, so a remount that only swaps
      // the resolver must swap the row too; otherwise generation N-1's route would
      // keep winning after a toggle or a settings edit.
      existing.options = this.options
      this.installed = true
      this.reason = undefined
      this.seams = Array.isArray(existing.installedSeams) ? existing.installedSeams : probe.seams
      return this
    }
    const slot = { resolve: resolveProvider, options: this.options, seams: {}, adapter: this }
    const wrapped = []
    for (const seam of probe.seams) {
      const raw = service[seam]
      const hadOwn = Object.prototype.hasOwnProperty.call(service, seam)
      const hook = this.makeHook(seam, slot)
      try {
        Object.defineProperty(service, seam, {
          value: hook,
          enumerable: false,
          configurable: true,
          writable: true
        })
      } catch (error) {
        ctx.logger.warn(
          `${PLUGIN}: cannot hook ctx.subagents.${seam} (${describeError(error)}); ` +
            'that seam keeps the parent route'
        )
        continue
      }
      slot.seams[seam] = { raw, hadOwn, hook }
      wrapped.push(seam)
    }
    if (wrapped.length === 0) {
      this.installed = false
      this.reason = `cannot define ${probe.seams.join(' / ')} on ctx.subagents`
      publishUnavailable(service, this.reason)
      ctx.logger.warn(`${PLUGIN}: ${this.reason}; team-mode members keep the parent route`)
      return this
    }
    slot.installedSeams = wrapped
    Object.defineProperty(slot, 'capabilities', { get: () => this.capabilities(), enumerable: true })
    for (const symbol of HOOK_SYMBOLS) service[symbol] = slot
    this.installed = true
    this.reason = undefined
    this.seams = wrapped
    ctx.logger.info(`${PLUGIN}: team-mode hook installed on ctx.subagents.${wrapped.join(' + ')}`)
    return this
  }

  /**
   * Watch one live child for lane failures and, when the failover route is
   * configured, rewrite its subsequent requests to that route exactly once.
   *
   * The child Agent is reached through the `agents` registry (injected at the
   * apply site): `agents.get(childId)` returns the live Agent whose `ctx` can
   * take scoped listeners. Three tiers of degradation, all silent-safe:
   *   · no registry / no live agent → no watcher (the child keeps its route);
   *   · `agent/request-error` with a non-lane code → ignored;
   *   · the failover rewrite is installed on the first lane failure only —
   *     `agent/request` then swaps provider/model on later steps, mirroring
     *     the official installModelSelection semantics minus the notice.
   * @param childId - the started child's session id.
   * @param route - the failover route from the config row.
   * @param label - the delegation label for log lines.
   * @param attribution - the pick that fed this child (step/expert/skills), so
   *   the failover record keeps the lane the delegation was pinned to.
   */
  armFailover(childId, route, label, recordRun, parentAgent, attribution) {
    const adapter = this
    const agents = adapter.ctx?.agents
    if (agents === undefined || agents === null || typeof agents.get !== 'function') return
    const agent = agents.get(childId)
    if (agent === undefined || agent === null || typeof agent !== 'object' || agent.ctx === undefined) return
    if (adapter.failoverWatched === undefined) adapter.failoverWatched = new WeakSet()
    if (adapter.failoverWatched.has(agent)) return
    adapter.failoverWatched.add(agent)
    const ctx = agent.ctx
    ctx.on?.('agent/request-error', async (payload, next) => {
      const code = payload?.failure?.code
      if (typeof code !== 'string' || !FAILOVER_FAILURE_CODES.has(code)) return next()
      if (typeof adapter.failoverSwitched !== 'object' || adapter.failoverSwitched === null) adapter.failoverSwitched = new WeakSet()
      if (adapter.failoverSwitched.has(agent)) return next()
      adapter.failoverSwitched.add(agent)
      const routeText = routeKey(route)
      try {
        ctx.on?.('agent/request', async (requestPayload, requestNext) => {
          if (requestPayload?.agent !== agent) return requestNext()
          const resolved = await requestNext()
          const { reasoningEffort: _dropped, ...withoutEffort } = resolved
          return {
            ...withoutEffort,
            provider: route.provider,
            model: route.model
          }
        })
        adapter.ctx.logger?.warn?.(
          `${PLUGIN}: member ${JSON.stringify(label ?? null)} failed with ${code}; ` +
            `switching its next requests to the failover route ${routeText}`
        )
        recordRun?.({ label, route, outcome: 'failover', reason: code, channel: 'team', ...runAttribution(route, attribution) })
        const ref = teamRefFromLabel(label, parentAgent)
        if (ref !== undefined) {
          reportToCaptain(
            ref,
            `成员 ${ref.memberName} 的模型路由在运行中触发故障切换：${code}（车道级故障）。` +
              `后续请求已改写到 failoverRoute ${routeText}（仅此一次）。` +
              `详情见 ~/.dsh/delegation-hub.events.jsonl。`
          )
        }
      } catch (error) {
        adapter.ctx.logger?.warn?.(`${PLUGIN}: failover switch failed: ${describeError(error)}`)
      }
      return next()
    })
  }

  /** Remove this generation's hooks, restoring whatever ran before them. */
  dispose(resolveProvider) {
    this.failoverWatched = undefined
    this.failoverSwitched = undefined
    const service = this.service
    const current = readHookSlot(service)
    if (current === undefined || current.resolve !== resolveProvider) return
    for (const [seam, entry] of Object.entries(current.seams ?? {})) {
      // Someone else wrapped this seam after us: leave their wrapper alone.
      if (Object.getOwnPropertyDescriptor(service, seam)?.value !== entry.hook) continue
      if (entry.hadOwn) service[seam] = entry.raw
      else delete service[seam]
    }
    for (const symbol of HOOK_SYMBOLS) {
      if (service[symbol] === current) delete service[symbol]
    }
    this.installed = false
    this.seams = []
  }
}

/**
 * Read the delegation event stream. One JSON object per line; torn or
 * malformed lines (a crashed write, manual editing) are skipped, never thrown,
 * because the stream is observational evidence and must stay readable even
 * when a single record is damaged.
 * @param eventsPath - absolute path of delegation-hub.events.jsonl.
 * @returns the parsed events in file order.
 */
export function readEvents(eventsPath) {
  try {
    const text = readFileSync(eventsPath, 'utf8')
    const events = []
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        const parsed = JSON.parse(line)
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) events.push(parsed)
      } catch {
        /* skip the torn line */
      }
    }
    return events
  } catch {
    return []
  }
}

/**
 * Public read-only view of the team-injection capability. Callers that hold the
 * `ctx.subagents` service can ask whether team-mode routing is live — and which
 * seam carries it — instead of grepping the log.
 */
export function teamInjectionCapabilities(service) {
  const slot = readHookSlot(service)
  if (slot === undefined) {
    return {
      teamInjection: TEAM_INJECTION_UNAVAILABLE,
      enabled: undefined,
      seams: [],
      reason: 'the route-pin hook is not installed on this service'
    }
  }
  // A failed probe records its reason instead of installing a hook.
  if (slot.adapter === undefined) return { ...slot.capabilities }
  return slot.adapter.capabilities()
}

/**
 * Breadcrumb written the moment the module is EVALUATED, before Cordis decides
 * whether to activate it. `ready.json` is written by `apply()`, so its absence is
 * ambiguous: the module may never have been imported, or it may have been imported
 * and held back because an `inject` service was missing (Cordis waits silently).
 * This file separates the two, which is otherwise unknowable from outside.
 */
function probePath() {
  return process.env.DSH_ROUTE_PIN_PROBE_PATH || join(homedir(), '.dsh', 'delegation-hub.probe.json')
}

/**
 * One shape for every verdict. A consumer reads `phase` / `mounted` / `reason`
 * and nothing else: `mounted` is present on all four phases, and `reason` is
 * always a string when the plugin is not serving. `invoked` (not `applied`) says
 * only what this file can actually know — that `apply()` was entered.
 *
 * `waitedMs` is a named parameter on purpose: a catch-all `...extra` would let a
 * future call site overwrite `mounted` and silently undo the verdict.
 */
function probeRecord(phase, { mounted, invoked, reason, waitedMs }) {
  return {
    schema: 1,
    plugin: PLUGIN,
    version: PLUGIN_VERSION,
    at: new Date().toISOString(),
    node: process.version,
    processId: process.pid,
    phase,
    mounted,
    invoked,
    ...(reason === undefined ? {} : { reason: describeError(reason) }),
    ...(waitedMs === undefined ? {} : { waitedMs }),
    inject: [...inject]
  }
}

/** Returns the write error (or undefined) so a read-only home stays visible. */
function writeProbe(record) {
  try {
    writeFileSync(probePath(), `${JSON.stringify(record, null, 2)}\n`)
    return undefined
  } catch (error) {
    // A read-only home must not change plugin behaviour, but it must not be
    // silent either: "no probe file" is otherwise read as "never imported".
    return describeError(error)
  }
}

function warnProbeFailure(ctx, error) {
  if (error === undefined) return
  try {
    ctx.logger.warn(
      `${PLUGIN}: cannot write the activation probe ${probePath()} (${error}); ` +
        'a missing probe file will be misread as "never imported"'
    )
  } catch {
    // The logger is what broke; the probe already carries the reason.
  }
}

function markLoaded() {
  try {
    const file = process.env.DSH_ROUTE_PIN_LOAD_PATH || join(homedir(), '.dsh', 'delegation-hub.load.json')
    writeFileSync(
      file,
      `${JSON.stringify({ schema: 1, plugin: PLUGIN, version: PLUGIN_VERSION, at: new Date().toISOString(), node: process.version, processId: process.pid }, null, 2)}\n`
    )
  } catch {
    // A read-only home must not stop the plugin from loading.
  }
}

markLoaded()

const activationProbe = setTimeout(() => {
  if (applied) return
  writeProbe(
    probeRecord('parked', {
      mounted: false,
      invoked: false,
      reason:
        'the module was imported but apply() was never called: the host is holding the plugin back, most likely on an injected service it never sees',
      waitedMs: PROBE_DELAY_MS
    })
  )
}, PROBE_DELAY_MS)
activationProbe.unref?.()
export function apply(ctx, config = {}) {
  applied = true
  // A late activation is still an activation. Disarm the parked check first, so a
  // slow host is never recorded as one that never called `apply()`.
  clearTimeout(activationProbe)
  try {
    const result = applyInner(ctx, config)
    // Fail-closed: only an explicit `{ mounted: true }` counts as mounted. A
    // future early return that forgets its verdict must never be recorded as a
    // success — that is exactly how this file ended up contradicting ready.json.
    // Returning normally is also not the same as "mounted": `applyInner` returns
    // after refusing a build without `subagents.registerProvider`.
    const mounted = result?.mounted === true
    warnProbeFailure(
      ctx,
      writeProbe(
        probeRecord(mounted ? 'applied' : 'degraded', {
          mounted,
          invoked: true,
          reason: mounted ? undefined : (result?.reason ?? 'applyInner returned without a mount verdict')
        })
      )
    )
    return result
  } catch (error) {
    // Cordis swings an activation error into the host console and nowhere else. A
    // user then sees the same symptom as "never loaded": empty dropdowns.
    warnProbeFailure(ctx, writeProbe(probeRecord('failed', { mounted: false, invoked: true, reason: error })))
    throw error
  }
}

function applyInner(ctx, config = {}) {
  const readinessPath = text(valueOf(config.readinessPath), 'config.readinessPath', DEFAULT_READINESS_PATH)
  if (
    ctx.subagents === undefined ||
    ctx.subagents === null ||
    typeof ctx.subagents.registerProvider !== 'function'
  ) {
    // A DSH build without the subagent service, or a future rename of it: refuse
    // loudly instead of throwing, so the rest of the profile still boots.
    ctx.logger.warn(`${PLUGIN}: ctx.subagents.registerProvider is unavailable; no route is pinned`)
    // Record the failure too: "the plugin is gone" is exactly what a post-upgrade
    // check must be able to distinguish from "the plugin was never installed".
    recordReadiness(readinessPath, {
      schema: 1,
      plugin: PLUGIN,
      version: PLUGIN_VERSION,
      at: new Date().toISOString(),
      node: process.version,
      processId: process.pid,
      mounted: false,
      capabilities: {
        teamInjection: TEAM_INJECTION_UNAVAILABLE,
        enabled: false,
        reason: 'ctx.subagents.registerProvider is unavailable in this DSH build'
      }
    })
    // Returning a verdict, not just `undefined`: `apply()` cannot otherwise tell a
    // mounted plugin from one that declined to mount.
    return { mounted: false, reason: 'ctx.subagents.registerProvider is unavailable in this DSH build' }
  }
  const settingsPath = text(valueOf(config.settingsPath), 'config.settingsPath', DEFAULT_SETTINGS_PATH)
  const normalized = {
    providerName: text(valueOf(config.providerName), 'config.providerName', 'pinned-account'),
    baseProvider: text(valueOf(config.baseProvider), 'config.baseProvider', 'spawn'),
    settingsPath,
    readinessPath,
    strict: valueOf(config.strict) === true,
    // Default on: a dead pinned lane must degrade, not fail the delegation.
    fallback: valueOf(config.fallback) !== false,
    // 'fail' (default): a route the user picked must never die silently.
    onPinFailure: valueOf(config.onPinFailure) === 'inherit' ? 'inherit' : 'fail',
    autoWireAgency: valueOf(config.autoWireAgency) !== false,
    teamInjection: config.teamInjection,
    overrideMemberRoute: config.overrideMemberRoute,
    // Volatile fields stay as their live accessors; the provider reads them per spawn.
    provider: config.provider,
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    maxTokens: config.maxTokens,
    // The runtime failover route, carried as-is (raw accessor or object) so the
    // hook can read it with valueOf per delegation, same as the other volatile
    // fields.
    failoverRoute: config.failoverRoute,
    // Step-splitter lanes from the Settings page as a JSON string (version-proof
    // shape); parsed and merged with the settings-file steps per key.
    stepsJson: config.stepsJson
  }
  const state = { settings: undefined, settingsText: undefined, checked: new Map() }
  const provider = new RoutePinProvider({ ctx, config: normalized, state })
  let disposeProvider
  try {
    disposeProvider = ctx.subagents.registerProvider(provider)
    ctx.logger.info(
      `${PLUGIN}: provider "${normalized.providerName}" delegates to "${normalized.baseProvider}", ` +
        `settings ${normalized.settingsPath}`
    )
  } catch (error) {
    // A provider with this name already exists (another generation of this plugin
    // is still mounted): keep serving with it instead of failing the whole plugin,
    // because the extra provider only adds routes.
    ctx.logger.warn(
      `${PLUGIN}: provider "${normalized.providerName}" not registered ` +
        `(${describeError(error)}); ` +
        `agency-agents routes through "${normalized.providerName}" keep using the existing instance`
    )
  }
  if (disposeProvider !== undefined) {
    // The subagent service registers the provider inside ITS OWN effect scope, so a
    // remount of this plugin (toggle, non-volatile config edit, reload generation)
    // would otherwise hit DUPLICATE_PROVIDER. Tie the removal to this fiber instead.
    try {
      ctx.effect(() => () => disposeProvider(), `${PLUGIN}: provider`)
    } catch (error) {
      ctx.logger.warn(
        `${PLUGIN}: cannot scope the provider disposer: ${describeError(error)}`
      )
    }
  }
  if (normalized.autoWireAgency) {
    // Zero hand edits: a fresh install only has to be installed, not wired.
    try {
      wireAgencyProfiles(normalized.providerName, ctx.logger)
    } catch (error) {
      ctx.logger.warn(`${PLUGIN}: agency auto-wire skipped: ${describeError(error)}`)
    }
  }
  // Team mode: continuable children bypass provider.start(), so their route has to
  // be filled into the request before SubagentManager reads it.
  const resolveProvider = () => provider
  const adapter = new TeamInjectionAdapter(ctx, normalized).install(resolveProvider)
  // One canonical readiness line + a machine-readable flag, so a deploy check can
  // assert "team injection is live" without pattern-matching a WARN.
  const capability = adapter.capabilities()
  ctx.logger.info(`${PLUGIN}: capabilities ${JSON.stringify(capability)}`)
  // Which route is actually in force, and whether the settings file is being
  // ignored because the config row wins. Without this, "I changed the JSON and
  // nothing happened" has no visible cause anywhere in the logs.
  const effective = provider.effectiveRoute()
  if (effective.shadowed === true) {
    ctx.logger.warn(
      `${PLUGIN}: ${normalized.settingsPath} sets default ${effective.settingsDefault}, ` +
        `but the config row pins ${effective.configRow} and wins; the settings default is ignored`
    )
  }
  const readinessError = recordReadiness(normalized.readinessPath, {
    schema: 1,
    plugin: PLUGIN,
    version: PLUGIN_VERSION,
    at: new Date().toISOString(),
    node: process.version,
    processId: process.pid,
    mounted: true,
    providerName: normalized.providerName,
    baseProvider: normalized.baseProvider,
    settingsPath: normalized.settingsPath,
    route: effective.route,
    routeSource: effective.source,
    configRow: effective.configRow,
    settingsDefault: effective.settingsDefault,
    experts: effective.experts,
    settingsDefaultShadowed: effective.shadowed === true,
    // Mount-time snapshot of "effective route vs. the pinned config row".
    //
    // Both fields come out of effectiveRoute() as `provider/model` strings, so
    // this is a plain string comparison. It is null by construction, and that is
    // the honest answer rather than a bug to paper over:
    //   · with a config row, `route` and `configRow` are the same routeKey();
    //   · without one, `configRow` is absent, so there is no baseline to differ
    //     from.
    // The interesting deviations happen per delegation (experts/roles/steps
    // outranking the row), which a mount-time record cannot see. Read those from
    // the `source` field of events.jsonl or last-run.json.
    drift:
      effective.route === undefined || effective.configRow === undefined
        ? null
        : effective.route === effective.configRow
          ? null
          : { pinned: effective.configRow, effective: effective.route, by: effective.source },
    fallback: normalized.fallback,
    teamInjection: normalized.teamInjection !== false,
    overrideMemberRoute: normalized.overrideMemberRoute !== false,
    capabilities: capability
  })
  if (readinessError !== undefined) {
    ctx.logger.warn(
      `${PLUGIN}: cannot write the readiness record ${normalized.readinessPath} (${readinessError}); ` +
        'the post-upgrade check has to read the console log instead'
    )
  }
  if (adapter.installed) {
    try {
      ctx.effect(() => () => adapter.dispose(resolveProvider), `${PLUGIN}: team hook`)
    } catch (error) {
      ctx.logger.warn(`${PLUGIN}: cannot scope the team hook disposer: ${describeError(error)}`)
    }
  }
  registerLastRunRoute(ctx, readinessPath)
  registerOptionsRoute(ctx)
  return { mounted: true }
}

/**
 * Publish the newest run record over a same-origin WebRoute.
 *
 * The Settings page shows the model / step / expert / skills of the last
 * delegation by fetching `LAST_RUN_ROUTE`: the browser cannot read files and the
 * host exposes no file-reading RPC, so a named WebRoute is the only
 * host-to-page surface for it.
 *
 * Best-effort on purpose — a build without `webServer`, or a service gate that
 * refuses the read, costs the page its info block and must never cost the
 * plugin its mount. The route lives in its own effect scope so a remount does
 * not leave a dead handler behind.
 *
 * @param ctx - the Cordis plugin context (needs `webServer`, `effect`, `logger`).
 * @param readinessPath - the readiness record path; the run record is its
 *   sibling (`RUN_RECORD_NAME` in the same directory).
 */
function registerLastRunRoute(ctx, readinessPath) {
  try {
    const webServer = ctx.webServer
    if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') return
    const disposeRoute = webServer.register({
      kind: 'exact',
      path: LAST_RUN_ROUTE,
      handler: (_req, res) => {
        let body = '{}'
        try {
          const recordText = readFileSync(join(dirname(readinessPath), RUN_RECORD_NAME), 'utf8')
          // A torn or non-object record is served as "no record" rather than
          // as broken JSON: the page renders the same empty state either way.
          const parsed = JSON.parse(recordText)
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) body = recordText
        } catch {
          /* missing or torn record -> {} */
        }
        res.statusCode = 200
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(body)
      }
    })
    if (typeof disposeRoute !== 'function') return
    try {
      ctx.effect(
        () => () => {
          try {
            disposeRoute()
          } catch {
            /* a dead route must not break teardown */
          }
        },
        `${PLUGIN}: last-run route`
      )
    } catch {
      /* no effect scope in this build: the route lives with the process */
    }
  } catch (error) {
    ctx.logger.warn(`${PLUGIN}: last-run route not registered: ${describeError(error)}`)
  }
}

/**
 * Parse the `key: value` frontmatter head of one Agency expert markdown file.
 * Mirrors the agency plugin's own reader (`parseFrontmatterMetadata`): quoted
 * values are unquoted, a missing name/description leaves the field undefined
 * and the caller skips the file. Returns null when the file has no frontmatter
 * block at all.
 */
function parseExpertFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (match === null) return null
  const get = (key) => {
    const found = match[1].match(new RegExp(`^${key}\\s*:\\s*(.*)$`, 'm'))
    if (found === null) return undefined
    const raw = found[1].trim()
    return raw.length >= 2 && (raw.startsWith('"') || raw.startsWith("'")) && raw.endsWith(raw[0])
      ? raw.slice(1, -1)
      : raw
  }
  return { name: get('name'), description: get('description'), emoji: get('emoji') }
}

/** One division directory (walk one level deep; no recursion needed — the agency layout is flat). */
function listDivisionExperts(root, division) {
  const dir = join(root, division)
  if (!existsSync(dir)) return []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const experts = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    const filePath = join(dir, entry.name)
    let text
    try {
      text = readFileSync(filePath, 'utf8')
    } catch {
      continue
    }
    const parsed = parseExpertFrontmatter(text)
    if (parsed === null || !parsed.name || !parsed.description) continue
    experts.push({
      slug: entry.name.slice(0, -3),
      name: parsed.name,
      emoji: typeof parsed.emoji === 'string' ? parsed.emoji : '',
      description: parsed.description,
      division
    })
  }
  return experts
}

/**
 * Resolve the agency plugin's installed assets root by walking up from this
 * plugin's own node_modules — the desktop profile installs both under the same
 * profile node_modules tree, so directory walking is a stable anchor across
 * install layouts (a bare require.resolve would import the agency entry, which
 * this plugin must not do). Falls back to the desktop profile tree.
 */
function resolveAgencyAssetsRoot() {
  try {
    // Start at this plugin's own directory (dirname of index.js) and walk up.
    const here = dirname(decodeURIComponent(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')))
    let dir = here
    for (let hop = 0; hop < 6; hop += 1) {
      const candidate = join(dir, '@michengai', 'dsh-agency-agents', 'assets', 'agency-agents-zh')
      if (existsSync(candidate)) return candidate
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch {
    /* unreadable module URL: fall through */
  }
  // Fallback: the desktop profile tree, where this plugin is also installed.
  try {
    const candidate = join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', '@michengai', 'dsh-agency-agents', 'assets', 'agency-agents-zh')
    if (existsSync(candidate)) return candidate
  } catch {
    /* no home: skip */
  }
  return undefined
}

/**
 * List Agency experts the same way the agency plugin builds its own catalog:
 * every `<root>/<division>/*.md` with name+description frontmatter becomes one
 * expert keyed by its file slug. Custom personas recorded in
 * `~/.dsh/agency-expert-personas.json` (a name → persona-prompt map the Agency
 * settings page writes) join the list as custom entries so a user-typed expert
 * shows up alongside the bundled roster.
 */
function listAgencyExperts() {
  const experts = new Map()
  const root = resolveAgencyAssetsRoot()
  if (root !== undefined) {
    let divisions = []
    try {
      divisions = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    } catch {
      divisions = []
    }
    for (const division of divisions) {
      for (const expert of listDivisionExperts(root, division)) {
        if (!experts.has(expert.slug)) experts.set(expert.slug, expert)
      }
    }
  }
  // Custom personas: the Agency settings page stores overrides keyed by slug.
  try {
    const customPath = join(homedir(), '.dsh', 'agency-expert-personas.json')
    if (existsSync(customPath)) {
      const parsed = JSON.parse(readFileSync(customPath, 'utf8'))
      if (parsed !== null && typeof parsed === 'object' && parsed.experts !== null && typeof parsed.experts === 'object') {
        for (const [slug, persona] of Object.entries(parsed.experts)) {
          if (typeof slug !== 'string' || slug === '' || typeof persona !== 'string') continue
          const existing = experts.get(slug)
          experts.set(slug, {
            slug,
            name: existing?.name ?? slug,
            emoji: existing?.emoji ?? '✳️',
            description: existing?.description ?? '自定义专家',
            division: existing?.division ?? 'custom'
          })
        }
      }
    }
  } catch {
    /* torn custom file: bundled roster still stands */
  }
  return [...experts.values()]
}

/**
 * List model-invocable skill names via the host `skills` service. Missing
 * service, throwing registry and unready catalogs all degrade to an empty
 * list — the datalist is a convenience, never a gate.
 */
function listSkillOptions(ctx) {
  try {
    const registry = typeof ctx.get === 'function' ? ctx.get('skills') : undefined
    if (registry === undefined || registry === null || typeof registry.list !== 'function') return []
    const skills = registry.list()
    if (!Array.isArray(skills)) return []
    return skills
      .filter((skill) => skill !== null && typeof skill === 'object' && typeof skill.name === 'string' && skill.name !== '')
      .map((skill) => ({ name: skill.name, description: typeof skill.description === 'string' ? skill.description : '' }))
  } catch {
    return []
  }
}

/**
 * Publish the step-editor autocomplete options over a same-origin WebRoute.
 *
 * The page's expert/skills inputs become datalist-backed combos: the dropdown
 * offers the skills the host skill registry lists and the Agency expert roster,
 * while free typing stays valid for values that are not installed yet. Read
 * only, best-effort on purpose — every failure mode degrades to empty lists,
 * which renders exactly the plain text inputs the page shipped with.
 */
function registerOptionsRoute(ctx) {
  try {
    const webServer = ctx.webServer
    if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') return
    const disposeRoute = webServer.register({
      kind: 'exact',
      path: OPTIONS_ROUTE,
      handler: (_req, res) => {
        let body = JSON.stringify({ experts: [], skills: [] })
        try {
          body = JSON.stringify({ experts: listAgencyExperts(), skills: listSkillOptions(ctx) })
        } catch {
          /* keep the empty body rather than a 500: the combo must not break */
        }
        res.statusCode = 200
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(body)
      }
    })
    if (typeof disposeRoute !== 'function') return
    try {
      ctx.effect(
        () => () => {
          try {
            disposeRoute()
          } catch {
            /* a dead route must not break teardown */
          }
        },
        `${PLUGIN}: options route`
      )
    } catch {
      /* no effect scope in this build: the route lives with the process */
    }
  } catch (error) {
    ctx.logger.warn(`${PLUGIN}: options route not registered: ${describeError(error)}`)
  }
}
