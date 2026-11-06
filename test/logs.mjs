#!/usr/bin/env node
/**
 * Post-upgrade smoke check against a REAL DSH boot.
 *
 * `test/run.mjs` proves the plugin still behaves; this script proves it is still
 * mounted in the running build. Those are different failures, and an upstream
 * interface change shows up here first.
 *
 * Why a file instead of grepping logs: `ctx.logger.info` reaches the DSH process
 * console (GUI dev console / terminal stdout) and is not persisted, while
 * `~/.dsh/logs/startup-*.log` is a diagnostics dump written only when startup
 * FAILS. So the plugin writes one readiness record per boot, and this check reads
 * it. The console lines are still the human-facing contract — pass `--log <file>`
 * to assert them too when you have captured them.
 *
 * Usage:
 *   node test/logs.mjs                          # check the readiness record
 *   node test/logs.mjs --strict                 # also fail when team injection is unavailable
 *   node test/logs.mjs --log ~/.dsh/console.txt # also require the three console lines
 *   node test/logs.mjs --ready path/to/ready.json
 *   node test/logs.mjs --probe path/to/probe.json
 *
 * The activation probe is checked first: it is the only file rewritten on every
 * boot, so it can distinguish "never imported" / "held back on an inject service"
 * / "apply() threw" from "mounted". A stale readiness record cannot.
 *
 * Exit 1 on a failed check.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PREFIX = 'delegation-hub:'
const DEFAULT_READY = join(homedir(), '.dsh', 'delegation-hub.ready.json')
const LOCAL_MANIFEST = new URL('../package.json', import.meta.url)

/** Console contract: these lines are promises about the DSH seam. */
const CONSOLE_LINES = [
  { key: 'provider delegates', required: true, test: (text) => new RegExp(`${PREFIX} provider ".*" delegates to ".*"`).test(text) },
  { key: 'hook installed', required: true, test: (text) => new RegExp(`${PREFIX} team-mode hook installed on ctx\\.subagents\\.(startActivation|startContinuable)`).test(text) },
  { key: 'capabilities published', required: true, test: (text) => text.includes(`${PREFIX} capabilities {"teamInjection":"`) },
  { key: 'team member -> provider/model', required: false, test: (text) => text.includes(`${PREFIX} team member label=`) }
]

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const value = (name, fallback) => {
  const inline = args.find((arg) => arg.startsWith(`${name}=`))
  if (inline !== undefined) return inline.slice(name.length + 1)
  const index = args.indexOf(name)
  const next = index < 0 ? undefined : args[index + 1]
  return next === undefined || next.startsWith('--') ? fallback : next
}

let missing = 0
const report = (state, label, detail) => {
  process.stdout.write(`  ${state.padEnd(4)} ${label}${detail === undefined ? '' : `  (${detail})`}`)
  process.stdout.write('\n')
}

const readyPath = value('--ready', DEFAULT_READY)
process.stdout.write(`readiness: ${readyPath}\n`)
// Read before the probe block: the probe's version is compared against it.
const localVersion = JSON.parse(readFileSync(LOCAL_MANIFEST, 'utf8')).version

// The activation probe is read FIRST, because it is the only evidence that can
// explain a stale readiness record. `ready.json` is written once per successful
// mount, so it stays on disk looking healthy after an upgrade the plugin failed
// to survive: "held back on an inject service" and "apply() threw" both leave the
// previous record untouched, and this check used to pass in exactly those two
// cases. The probe is rewritten on every boot, so it cannot go stale silently.
const probePath = value('--probe', join(homedir(), '.dsh', 'delegation-hub.probe.json'))
// A record written by an older build says `note` where this one says `reason`,
// and `error` where this one says `reason`. Reading only the new key turns the
// one useful sentence into `undefined` — the verdict stays right, the diagnosis
// does not. `??` alone is not enough: 0.8.15 wrote `reason: describeError(error)`,
// which is '' for an Error without a message, and an empty string stops the chain
// before the field that actually says something.
const probeReason = (probe) =>
  [probe.reason, probe.note, probe.error].find((text) => typeof text === 'string' && text.trim() !== '') ??
  '(the record has no usable reason text)'
{
  let probe
  let probeError
  try {
    probe = JSON.parse(readFileSync(probePath, 'utf8'))
  } catch (error) {
    probe = undefined
    probeError = error
  }
  // JSON.parse('null') succeeds and returns null, so an undefined check alone
  // lets a malformed record through to probe.phase, which throws a TypeError and
  // turns the verdict into a stack trace. Anything that is not a plain object is
  // "no usable record", not "no mount verdict".
  const malformed = probe !== undefined && (probe === null || typeof probe !== 'object' || Array.isArray(probe))
  // "The file is missing" and "the file is there but unreadable" are different
  // diagnoses that used to print the same sentence about the module not being
  // imported. A damaged record is lost evidence: it fails the gate even without
  // --strict, because the gate cannot then claim the mount was verified.
  const unreadable = probeError !== undefined && probeError.code !== 'ENOENT'
  if (unreadable) {
    report('MISS', 'activation probe: unreadable', `${probePath}: ${probeError.message}; delete it and restart DSH`)
    missing += 1
  } else if (probe === undefined) {
    // The probe is the only file that says whether this boot ran apply(), and the
    // record left by the previous boot still looks healthy. A warning here meant
    // "delete the file" passed the gate while "corrupt the file" failed it.
    report('MISS', 'activation probe', `no ${probePath}; the plugin was not imported in this boot`)
    missing += 1
  } else if (malformed) {
    // Same policy as an unreadable file: a record that exists but cannot be
    // interpreted is lost evidence, so it fails the gate with or without
    // --strict. Splitting the two by *how* the content is malformed (bad JSON vs
    // valid JSON of the wrong shape) made one of them pass.
    report('MISS', 'activation probe: not an object', `${JSON.stringify(probe)}; delete ${probePath} and restart DSH`)
    missing += 1
  } else if (probe.phase === 'parked') {
    report(
      'MISS',
      'activation probe: parked',
      `${probeReason(probe)} (inject: ${Array.isArray(probe.inject) ? probe.inject.join(', ') : 'unknown'})`
    )
    missing += 1
  } else if (probe.phase === 'failed') {
    report('MISS', 'activation probe: apply() threw', probeReason(probe))
    missing += 1
  } else if (probe.phase === 'degraded') {
    report('MISS', 'activation probe: refused to mount', probeReason(probe))
    missing += 1
  } else if (probe.phase === 'applied' && probe.mounted === true) {
    // Version first: printing "ok applied" and then warning about the same record
    // is the green-light-with-a-footnote that made this hard to read, and a record
    // written by another build is not proof that this build is mounted.
    if (probe.version !== localVersion) {
      report('MISS', 'probe version', `probe ${probe.version} vs local ${localVersion}; restart DSH`)
      missing += 1
    } else {
      report('ok', `activation probe: applied (${probe.version})`)
    }
    // An "ok" with no age reads the same whether this boot wrote it or the one
    // before it did. The readiness check has had an age line for a while; the
    // probe is the file that decides the verdict, so it needs one too.
    const probeAgeHours = probe.at === undefined ? Number.NaN : (Date.now() - Date.parse(probe.at)) / 3_600_000
    if (!Number.isFinite(probeAgeHours)) {
      report('MISS', 'probe age', String(probe.at))
      missing += 1
    }
    // A negative age means the clock moved backwards or the record was written
    // with a future timestamp. "ok, written -30 min ago" reads as healthy and is
    // the opposite of what it means. The tolerance is one minute, not one hour:
    // scheduling jitter is seconds, while a half-hour skew is already a wrong
    // answer to "was this written by this boot".
    else if (probeAgeHours < -1 / 60) {
      report('MISS', 'probe timestamp is in the future', `${probe.at}; check the system clock`)
      missing += 1
    } else if (probeAgeHours > 24) {
      report('WARN', `probe is ${Math.round(probeAgeHours / 24)} days old`, 'restart DSH, then re-run')
    } else report('ok', `probe written ${Math.round(probeAgeHours * 60)} min ago`)
  } else if (probe.phase === 'applied' && probe.invoked === undefined) {
    // A record written before this schema existed. It cannot answer "did the
    // early return keep its verdict", so it is not proof either way.
    report('WARN', 'activation probe', 'the record predates the mounted/invoked fields; restart DSH')
  } else {
    // An `applied` verdict without `mounted: true` is the shape a future early
    // return would produce if its verdict were dropped. Do not trust it.
    report('MISS', 'activation probe: no mount verdict', JSON.stringify({ phase: probe.phase, mounted: probe.mounted }))
    missing += 1
  }
}

let record
try {
  record = JSON.parse(readFileSync(readyPath, 'utf8'))
} catch (error) {
  report('MISS', 'readiness record', error instanceof Error ? error.message : String(error))
  process.stdout.write(
    '\nNo readiness record. Either the plugin is not mounted in this profile, or DSH\n' +
      'has not been restarted since the upgrade. Start DSH once, then re-run.\n'
  )
  process.exit(1)
}

// JSON.parse('null') returns null without throwing, so the catch above does not
// cover a record that parses into a non-object: reading `record.plugin` then
// throws a TypeError and the verdict becomes a stack trace. Same rule as the
// probe side — unusable evidence fails the gate, it does not crash it.
if (record === null || typeof record !== 'object' || Array.isArray(record)) {
  report('MISS', 'readiness record: not an object', JSON.stringify(record))
  process.stdout.write(`
${readyPath} does not hold a record. Delete it, start DSH again, then re-run.
`)
  process.exit(1)
}

if (record.plugin === 'delegation-hub') report('ok', 'plugin identity')
else {
  report('MISS', 'plugin identity', JSON.stringify(record.plugin))
  missing += 1
}

if (record.version === localVersion) report('ok', `version ${localVersion}`)
else {
  report('MISS', 'version', `record ${record.version} vs local ${localVersion}; restart DSH`)
  missing += 1
}

if (record.mounted === true) report('ok', 'mounted')
else {
  report('MISS', 'mounted', record.capabilities?.reason)
  missing += 1
}

const capability = record.capabilities ?? {}
if (capability.teamInjection === 'installed') {
  report('ok', `team injection ${capability.enabled === false ? 'installed but switched off' : 'installed'}`)
  // Which method the hook actually wrapped. `startContinuable` here on a build
  // whose runtime only calls `startActivation` would be a silent no-op, so the
  // seam is part of the contract, not a debug detail.
  const seams = Array.isArray(capability.seams) ? capability.seams : []
  if (seams.includes('startActivation')) report('ok', `seam ${seams.join(' + ')}`)
  else if (seams.length === 0) report('WARN', 'seam', 'the record predates seam reporting; restart DSH')
  else report('WARN', `seam ${seams.join(' + ')}`, 'no startActivation: this build may not call the wrapped seam')
} else if (flag('--strict')) {
  report('MISS', 'team injection', capability.reason)
  missing += 1
} else {
  report('WARN', 'team injection', capability.reason ?? 'unavailable')
}

report(record.fallback === true ? 'ok' : 'WARN', `fallback ${record.fallback === true ? 'on' : 'off'}`)
if (record.overrideMemberRoute === undefined) {
  report('WARN', 'member override', 'the record predates this field; restart DSH')
} else {
  report(
    record.overrideMemberRoute === true ? 'ok' : 'WARN',
    `member override ${record.overrideMemberRoute === true ? 'on' : 'off'}`,
    record.overrideMemberRoute === true ? undefined : 'Agent Teams members keep their own memberLlmProvider'
  )
}
// Neither field is required by the schema, so a hand-trimmed record prints
// "undefined -> undefined" as an ok line — on the one line that answers "which
// route is actually in force".
const routeLine = [record.providerName, record.baseProvider]
if (routeLine.every((text) => typeof text === 'string' && text !== '')) {
  report('ok', `fallback/route: ${record.providerName} -> ${record.baseProvider}`)
} else {
  report('WARN', 'fallback/route', `the record has no usable route: ${JSON.stringify({ providerName: record.providerName, baseProvider: record.baseProvider })}`)
}

// Which route is in force, and whether the settings file is being ignored.
// "I edited the JSON and the model did not change" is otherwise unanswerable
// from the outside: the row wins over the settings default and says nothing.
if (record.route === undefined) {
  report('WARN', 'effective route', 'the record predates this field; restart DSH')
} else {
  report('ok', `effective route: ${record.route} (from the ${record.routeSource})`)
  if (record.settingsDefaultShadowed === true) {
    report(
      'WARN',
      'settings default ignored',
      `${record.settingsDefault} in the settings file loses to the config row ${record.configRow}`
    )
  }
}

if (record.at !== undefined) {
  const ageHours = (Date.now() - Date.parse(record.at)) / 3_600_000
  // Unusable time evidence is a failed gate, not a footnote: the probe side
  // already treats an unparseable age as MISS, and a corrupted clock must not
  // read as "everything else is fine, exit 0".
  if (!Number.isFinite(ageHours)) {
    report('MISS', 'record timestamp unreadable', `${record.at}; the record is damaged, restart DSH`)
    missing += 1
  }
  else if (ageHours < -1 / 60) {
    report('MISS', 'record timestamp is in the future', `${record.at}; check the system clock`)
    missing += 1
  }
  else if (ageHours > 24 * 7) report('WARN', `record is ${Math.round(ageHours / 24)} days old`, 'restart DSH, then re-run')
  else report('ok', `recorded ${Math.round(ageHours * 60)} min ago`)
}

const logPath = value('--log', undefined)
if (logPath !== undefined) {
  process.stdout.write(`console log: ${logPath}\n`)
  let text
  try {
    text = readFileSync(logPath, 'utf8')
  } catch (error) {
    report('MISS', 'console log', error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
  for (const line of CONSOLE_LINES) {
    if (line.test(text)) report('ok', line.key)
    else if (line.required) {
      report('MISS', line.key)
      missing += 1
    } else report('none', line.key, 'no delegation yet')
  }
}

if (missing > 0) {
  process.stdout.write(
    `\n${missing} check(s) failed. The plugin is linked but the DSH interface moved:\n` +
      '  - compare `peerDependencies` in package.json with the installed build\n' +
      '  - see the compatibility matrix in README.md before blaming quota or the route\n'
  )
  process.exit(1)
}

process.stdout.write('\nready: the plugin mounted and the seams it depends on are intact\n')
