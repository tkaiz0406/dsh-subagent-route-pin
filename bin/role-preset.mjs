#!/usr/bin/env node
// dsh-delegation-hub — quality-gate role presets.
//
// Writes a `roles` map into the user settings file (~/.dsh/subagent-route-pin.json
// by default) so Agent-Teams members are routed by their durable role:
//   实现者/builder  -> the fast lane (cheap, quick model)
//   验证者/verifier -> the mid lane (balanced model)
//   审查者/reviewer -> the flagship lane (strongest model)
// Merge semantics: `roles` entries replace only the three gate roles; every
// other key in the settings file (experts, default, match) is preserved. A
// timestamped backup of the settings file is written before the first change.
//
// Usage:
//   node bin/role-preset.mjs <preset> [provider/model]...
//
// Presets:
//   delivery  builder=deepseek-account/deepseek-flash  verifier=deepseek-account/deepseek-flash
//             reviewer=deepseek-account/deepseek-pro   (plus 中文角色名同键)
//   clear     remove the three gate roles from the settings file
//
// Any route may be overridden:  node bin/role-preset.mjs delivery reviewer=xiaomi/mimo-v2.6-pro
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const SETTINGS_PATH = process.env.DSH_ROUTE_PIN_SETTINGS_PATH || join(homedir(), '.dsh', 'subagent-route-pin.json')

const GATE_ROLES = ['审查者', '验证者', '实现者']

function parseRoute(text, field) {
  if (text === undefined) return undefined
  const slash = text.indexOf('/')
  if (slash < 1 || slash === text.length - 1) {
    throw new Error(`${field} must look like provider/model, got ${JSON.stringify(text)}`)
  }
  return { provider: text.slice(0, slash), model: text.slice(slash + 1) }
}

function readSettings() {
  if (!existsSync(SETTINGS_PATH)) return {}
  try {
    const parsed = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch (error) {
    throw new Error(`cannot parse ${SETTINGS_PATH}: ${error.message}; fix or remove the file first`)
  }
}

function buildPreset(name, overrides) {
  if (name === 'clear') return null
  if (name !== 'delivery') {
    throw new Error(`unknown preset ${JSON.stringify(name)}; expected "delivery" or "clear"`)
  }
  const roles = {
    实现者: parseRoute(overrides['实现者'], '实现者') ?? parseRoute(overrides.builder, 'builder') ?? { provider: 'deepseek-account', model: 'deepseek-flash' },
    验证者: parseRoute(overrides['验证者'], '验证者') ?? parseRoute(overrides.verifier, 'verifier') ?? { provider: 'deepseek-account', model: 'deepseek-flash' },
    审查者: parseRoute(overrides['审查者'], '审查者') ?? parseRoute(overrides.reviewer, 'reviewer') ?? { provider: 'deepseek-account', model: 'deepseek-pro' }
  }
  return roles
}

function main() {
  const [name, ...rest] = process.argv.slice(2)
  if (name === undefined || name === '--help' || name === '-h') {
    console.log('usage: node bin/role-preset.mjs <delivery|clear> [role=provider/model ...]')
    console.log('  roles: 实现者|builder, 验证者|verifier, 审查者|reviewer')
    console.log('  example: node bin/role-preset.mjs delivery reviewer=xiaomi/mimo-v2.6-pro')
    console.log(`settings file: ${SETTINGS_PATH}`)
    process.exit(name === undefined ? 1 : 0)
  }
  const overrides = {}
  for (const item of rest) {
    const eq = item.indexOf('=')
    if (eq < 1) throw new Error(`override ${JSON.stringify(item)} must look like role=provider/model`)
    overrides[item.slice(0, eq)] = item.slice(eq + 1)
  }
  const roles = buildPreset(name, overrides)
  const settings = readSettings()
  const before = JSON.stringify(settings.roles ?? null)
  if (roles === null) {
    for (const key of GATE_ROLES) delete settings.roles?.[key]
    if (settings.roles !== undefined && Object.keys(settings.roles).length === 0) delete settings.roles
  } else {
    settings.roles = { ...(settings.roles ?? {}), ...roles }
  }
  const after = JSON.stringify(settings.roles ?? null)
  if (before !== after && existsSync(SETTINGS_PATH)) {
    copyFileSync(SETTINGS_PATH, `${SETTINGS_PATH}.bak-role-preset-${new Date().toISOString().replace(/[:.]/g, '-')}`)
  }
  writeFileSync(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  if (roles === null) {
    console.log(`cleared gate roles from ${SETTINGS_PATH}`)
  } else {
    for (const [key, route] of Object.entries(roles)) {
      console.log(`${key} -> ${route.provider}/${route.model}`)
    }
  }
  console.log(`roles take effect on the next Agent-Teams delegation (settings are re-read per delegation)`)
}

try {
  main()
} catch (error) {
  console.error(`role-preset: ${error.message}`)
  process.exit(1)
}
