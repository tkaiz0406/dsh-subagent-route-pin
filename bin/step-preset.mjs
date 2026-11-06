#!/usr/bin/env node
// dsh-delegation-hub — step-splitter presets.
//
// Writes a `steps` map into the user settings file so a delegating agent can
// split one goal into serial sub-delegations, each labelled `goal#<step>`,
// and every step lands on its own model — the deterministic "different model
// per step". Merge semantics mirror dsh-role-preset: only the managed step
// keys are replaced; experts/roles/default/match are preserved; a timestamped
// backup of the settings file is written before the first change.
//
// Usage:
//   node bin/step-preset.mjs <preset> [step=provider/model ...]
//
// Presets:
//   dev   research=deepseek-account/deepseek-flash  code=deepseek-account/deepseek-pro  review=deepseek-account/deepseek-pro
//   clear remove the managed step keys from the settings file
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const SETTINGS_PATH = process.env.DSH_ROUTE_PIN_SETTINGS_PATH || join(homedir(), '.dsh', 'subagent-route-pin.json')

const MANAGED_STEPS = ['research', 'code', 'review']

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
  if (name !== 'dev') {
    throw new Error(`unknown preset ${JSON.stringify(name)}; expected "dev" or "clear"`)
  }
  return {
    research: parseRoute(overrides.research, 'research') ?? { provider: 'deepseek-account', model: 'deepseek-flash' },
    code: parseRoute(overrides.code, 'code') ?? { provider: 'deepseek-account', model: 'deepseek-pro' },
    review: parseRoute(overrides.review, 'review') ?? { provider: 'deepseek-account', model: 'deepseek-pro' }
  }
}

function main() {
  const [name, ...rest] = process.argv.slice(2)
  if (name === undefined || name === '--help' || name === '-h') {
    console.log('usage: node bin/step-preset.mjs <dev|clear> [step=provider/model ...]')
    console.log('  steps: research, code, review')
    console.log('  example: node bin/step-preset.mjs dev code=xiaomi/mimo-v2.6-pro')
    console.log(`settings file: ${SETTINGS_PATH}`)
    process.exit(name === undefined ? 1 : 0)
  }
  const overrides = {}
  for (const item of rest) {
    const eq = item.indexOf('=')
    if (eq < 1) throw new Error(`override ${JSON.stringify(item)} must look like step=provider/model`)
    overrides[item.slice(0, eq)] = item.slice(eq + 1)
  }
  const steps = buildPreset(name, overrides)
  const settings = readSettings()
  const before = JSON.stringify(settings.steps ?? null)
  if (steps === null) {
    for (const key of MANAGED_STEPS) delete settings.steps?.[key]
    if (settings.steps !== undefined && Object.keys(settings.steps).length === 0) delete settings.steps
  } else {
    settings.steps = { ...(settings.steps ?? {}), ...steps }
  }
  const after = JSON.stringify(settings.steps ?? null)
  if (before !== after && existsSync(SETTINGS_PATH)) {
    copyFileSync(SETTINGS_PATH, `${SETTINGS_PATH}.bak-step-preset-${new Date().toISOString().replace(/[:.]/g, '-')}`)
  }
  writeFileSync(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  if (steps === null) {
    console.log(`cleared managed steps from ${SETTINGS_PATH}`)
  } else {
    for (const [key, route] of Object.entries(steps)) {
      console.log(`${key} -> ${route.provider}/${route.model}`)
    }
  }
  console.log('steps take effect on the next delegation; label the sub-delegation goal#<step>.')
}

try {
  main()
} catch (error) {
  console.error(`step-preset: ${error.message}`)
  process.exit(1)
}
