#!/usr/bin/env node
/**
 * team-status — 看 Agent Teams 的实时状态。
 *
 * Agent Teams 自己的界面入口是条件渲染的：会话标题栏那个按钮只在
 * 「当前会话确实持有一个开跑的团队」时出现（TeamChatEntry 里 `if (!team) return null`），
 * 所以 staged 的计划、或者换个会话，你就什么都看不到。这个脚本绕开那个条件，
 * 直接读磁盘上的 `.agent-teams/<team>/team.json`。
 *
 *   node bin/team-status.mjs                 打印当前目录下所有团队
 *   node bin/team-status.mjs --dir <path>    指定工作区（可重复）
 *   node bin/team-status.mjs --serve         起本地面板（默认 127.0.0.1:7788，2 秒自刷新）
 *   node bin/team-status.mjs --serve --port 7800
 *
 * 读的全是只读状态文件，不碰 DSH、不改任何东西。
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import process from 'node:process'

const STATUS_ORDER = ['in_progress', 'pending', 'completed', 'failed', 'cancelled']
const STATUS_LABEL = {
  completed: '完成',
  in_progress: '进行中',
  pending: '待开始',
  failed: '失败',
  cancelled: '取消',
  idle: '空闲',
  running: '运行中',
  staged: '暂存(未批准)'
}

/* ---------------------------------------------------------------- args */

function parseArgs(argv) {
  const out = { dirs: [], scans: [], serve: false, port: 7788 }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--serve') out.serve = true
    else if (arg === '--port') out.port = Number(argv[++i])
    else if (arg.startsWith('--port=')) out.port = Number(arg.slice(7))
    else if (arg === '--dir') out.dirs.push(argv[++i])
    else if (arg.startsWith('--dir=')) out.dirs.push(arg.slice(6))
    else if (arg === '--scan') out.scans.push(argv[++i])
    else if (arg.startsWith('--scan=')) out.scans.push(arg.slice(7))
    else if (arg === '--help' || arg === '-h') out.help = true
    else out.dirs.push(arg)
  }
  if (!out.dirs.length && !out.scans.length) out.dirs.push(process.cwd())
  out.dirs = [...new Set(out.dirs.map((d) => path.resolve(d)))]
  out.scans = [...new Set(out.scans.map((d) => path.resolve(d)))]
  out.dirs = [...new Set([...out.dirs, ...expandScans(out.scans)])]
  return out
}

/** `--scan <root>`：把 root 本身和它的直接子目录里带 `.agent-teams` 的都算进来。 */
function expandScans(roots) {
  const found = []
  for (const root of roots) {
    if (fs.existsSync(path.join(root, '.agent-teams'))) found.push(root)
    let children = []
    try {
      children = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const child of children) {
      if (!child.isDirectory()) continue
      const candidate = path.join(root, child.name)
      if (fs.existsSync(path.join(candidate, '.agent-teams'))) found.push(candidate)
    }
  }
  return found
}

/* ---------------------------------------------------------------- read */

/* 委派事件流：一行一个 JSON 对象，坏行跳过（与 index.js 的 readEvents 同契约）。 */
function readEvents(dir) {
  const file = path.join(dir, 'delegation-hub.events.jsonl')
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const events = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const parsed = JSON.parse(line)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) events.push(parsed)
    } catch {
      /* 跳过损坏行 */
    }
  }
  return events
}

function renderEvents(events) {
  if (events.length === 0) return ''
  const FAILURES = new Set(['failed', 'failover'])
  const rows = events
    .slice(-40)
    .reverse()
    .map((event) => {
      const lane = FAILURES.has(event.outcome) ? 'ev-bad' : 'ev-ok'
      const route = event.route ? `${event.route.provider}/${event.route.model}` : '-'
      const source = event.source ?? ''
      const reason = event.reason ? ` · ${event.reason}` : ''
      return `<tr class="${lane}"><td>${escapeHtml(String(event.at ?? ''))}</td><td><code>${escapeHtml(String(event.label ?? ''))}</code></td><td>${escapeHtml(String(event.channel ?? '-'))}</td><td>${escapeHtml(String(event.outcome ?? ''))}</td><td><code>${escapeHtml(route)}</code></td><td>${escapeHtml(source)}${escapeHtml(reason)}</td></tr>`
    })
    .join('')
  return `<section>
  <header><h2>委派事件流</h2><span class="b b-pending">最近 ${Math.min(events.length, 40)} / 共 ${events.length}</span></header>
  <table><thead><tr><th>时间</th><th>label</th><th>通道</th><th>结果</th><th>路由</th><th>来源</th></tr></thead><tbody>${rows}</tbody></table>
  <p class="dim">数据源 delegation-hub.events.jsonl（追加式事件流，坏行自动跳过）。</p>
</section>`
}

/* Watchdog-flavoured observation (display only): a member whose newest
 * delegation event is older than STALE_MINUTES while its team still lists it
 * as in_progress gets a `~stale` flag. Read from the events stream, never
 * mutates anything, and TEAM_STATUS_STALE_MINUTES=0 turns it off. */
const STALE_MINUTES = (() => {
  const raw = Number(process.env.TEAM_STATUS_STALE_MINUTES)
  return Number.isFinite(raw) && raw >= 0 ? raw : 20
})()

function staleLabels(events, teams, now = Date.now()) {
  if (STALE_MINUTES === 0) return new Set()
  const newest = new Map()
  for (const event of events) {
    const label = typeof event?.label === 'string' ? event.label : ''
    if (label === '') continue
    const member = label.startsWith('agent-teams:') ? label.slice(label.lastIndexOf(':') + 1) : label
    const at = typeof event.at === 'string' ? Date.parse(event.at) : NaN
    if (Number.isNaN(at)) continue
    const prev = newest.get(member)
    if (prev === undefined || at > prev) newest.set(member, at)
  }
  const stale = new Set()
  for (const team of teams) {
    if (team.phase !== undefined && team.phase !== 'running') continue
    for (const member of team.members ?? []) {
      if (member?.status !== 'running' || typeof member?.name !== 'string') continue
      const at = newest.get(member.name)
      if (at !== undefined && now - at > STALE_MINUTES * 60000) stale.add(member.name)
    }
  }
  return stale
}

function readTeams(dir) {
  const root = path.join(dir, '.agent-teams')
  let entries
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const teams = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const file = path.join(root, entry.name, 'team.json')
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'))
      teams.push({ ...data, _dir: dir, _file: file })
    } catch {
      /* 半写入或非团队目录，跳过 */
    }
  }
  return teams.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
}

function summarize(team) {
  const tasks = Array.isArray(team.tasks) ? team.tasks : []
  const counts = {}
  for (const task of tasks) counts[task.status] = (counts[task.status] ?? 0) + 1
  const done = counts.completed ?? 0
  return { tasks, counts, done, total: tasks.length, pct: tasks.length ? Math.round((done / tasks.length) * 100) : 0 }
}

/* ---------------------------------------------------------------- text */

function pad(text, width) {
  let out = String(text ?? '')
  let len = [...out].length
  if (len > width) {
    out = [...out].slice(0, Math.max(0, width - 1)).join('') + '…'
    len = width
  }
  return out + ' '.repeat(Math.max(0, width - len))
}

function printTeams(teams, stale = new Set()) {
  if (!teams.length) {
    console.log('没有找到任何团队。检查 --dir 是否指向工作区根目录（它下面应有 .agent-teams/）。')
    return
  }
  for (const team of teams) {
    const { tasks, counts, done, total, pct } = summarize(team)
    const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10))
    console.log('')
    console.log(`${team.name}  ·  ${STATUS_LABEL[team.phase] ?? team.phase ?? '?'}${team.planReviewState === 'awaiting_review' ? ' · 待批准' : ''}`)
    console.log(`  目录   ${team._dir}`)
    console.log(`  profile ${team.profile?.name ?? '—'}    任务 ${bar} ${done}/${total} (${pct}%)`)
    if (team.planReviewState === 'awaiting_review') {
      console.log('  提示   计划还没批准：去 Web 的计划卡点 Approve & Run，否则成员不会启动。')
    }
    for (const member of team.members ?? []) {
      const model = [member.provider, member.model].filter(Boolean).join('/')
      const staleMark = stale.has(member.name) ? ' ~stale' : ''
      console.log(`  · ${pad(member.name, 12)} ${pad(member.role ?? '', 8)} ${pad(STATUS_LABEL[member.status] ?? member.status ?? '', 6)} ${model}${staleMark}`)
    }
    for (const task of [...tasks].sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
      const deps = (task.dependencies ?? []).length ? ` <- ${task.dependencies.join(',')}` : ''
      console.log(`    ${pad(task.id, 5)} ${pad(STATUS_LABEL[task.status] ?? task.status, 5)} ${pad(task.assignee ?? '-', 12)} ${pad(task.subject ?? '', 40)}${deps}`)
    }
    const pendingNames = STATUS_ORDER.filter((s) => counts[s])
    if (pendingNames.length) console.log(`  统计   ${pendingNames.map((s) => `${STATUS_LABEL[s] ?? s} ${counts[s]}`).join(' · ')}`)
  }
  console.log('')
}

/* ---------------------------------------------------------------- html */

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])

function renderTeam(team, staleSet = new Set()) {
  const { tasks, done, total, pct } = summarize(team)
  const badge = (status) => `<span class="b b-${escapeHtml(status)}">${escapeHtml(STATUS_LABEL[status] ?? status ?? '?')}</span>`
  const staged = team.planReviewState === 'awaiting_review'
  const members = (team.members ?? [])
    .map((m) => {
      const model = [m.provider, m.model].filter(Boolean).join('/')
      const stale = staleSet.has(m.name) ? ' <span class="b b-staged">~stale</span>' : ''
      return `<li><b>${escapeHtml(m.name)}</b> <span class="dim">${escapeHtml(m.role ?? '')}</span> ${badge(m.status)} <code>${escapeHtml(model)}</code>${stale}</li>`
    })
    .join('')
  const rows = [...tasks]
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    .map((task) => {
      const deps = (task.dependencies ?? []).map((d) => escapeHtml(d)).join(' ')
      return `<tr><td><code>${escapeHtml(task.id)}</code></td><td>${badge(task.status)}</td><td>${escapeHtml(task.assignee ?? '-')}</td><td>${escapeHtml(task.subject ?? '')}${deps ? `<div class="dim">依赖 ${deps}</div>` : ''}</td><td>${task.attempt ?? 0}</td></tr>`
    })
    .join('')
  return `<section>
  <header><h2>${escapeHtml(team.name)}</h2>${badge(team.phase)}${staged ? '<span class="b b-staged">待批准</span>' : ''}</header>
  <p class="dim">${escapeHtml(team.description ?? '')}</p>
  <p class="dim">profile <code>${escapeHtml(team.profile?.name ?? '—')}</code> · 目录 <code>${escapeHtml(team._dir)}</code></p>
  <div class="bar"><i style="width:${pct}%"></i><span>${done}/${total} · ${pct}%</span></div>
  ${staged ? '<p class="warn">计划还没批准：去 Web 的计划卡点 Approve &amp; Run，否则成员不会启动。</p>' : ''}
  <h3>成员</h3><ul class="members">${members || '<li class="dim">无</li>'}</ul>
  <h3>任务</h3>
  <table><thead><tr><th>ID</th><th>状态</th><th>负责人</th><th>任务</th><th>尝试</th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="dim">无</td></tr>'}</tbody></table>
</section>`
}

const PAGE = (teams, dirs, events = [], stale = new Set()) => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="refresh" content="2">
<title>Agent Teams 状态</title>
<style>
  :root{color-scheme:dark}
  body{margin:0;padding:24px 28px;background:#0f1115;color:#e6e8ee;font:14px/1.6 "Segoe UI",system-ui,sans-serif}
  h1{font-size:18px;margin:0 0 4px}
  h2{font-size:16px;margin:0}
  h3{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#8b93a7;margin:18px 0 6px}
  section{border:1px solid #232733;border-radius:10px;padding:14px 16px;margin:14px 0;background:#141821}
  header{display:flex;gap:8px;align-items:center}
  .dim{color:#8b93a7;margin:4px 0}
  .warn{color:#ffb454}
  .bar{position:relative;height:18px;border-radius:9px;background:#1d2230;overflow:hidden;margin:8px 0}
  .bar i{position:absolute;inset:0 auto 0 0;background:#3f7d5a}
  .bar span{position:relative;display:block;text-align:center;font-size:11px;line-height:18px}
  .b{font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid #2c3242;color:#aab2c5}
  .b-completed{color:#6ee7a8;border-color:#2f5f45}
  .b-in_progress{color:#7db8ff;border-color:#2c4f7d}
  .b-failed{color:#ff8080;border-color:#6d2f2f}
  .b-pending{color:#aab2c5}
  .b-idle{color:#aab2c5}
  .b-staged,.b-staged-plan{color:#ffb454;border-color:#6d5127}
  .members{list-style:none;padding:0;margin:0;display:flex;flex-wrap:wrap;gap:10px}
  .members li{border:1px solid #232733;border-radius:8px;padding:4px 10px}
  table{width:100%;border-collapse:collapse}
  th,td{text-align:left;padding:5px 8px;border-bottom:1px solid #1d2230;vertical-align:top}
  th{color:#8b93a7;font-weight:500;font-size:12px}
  code{background:#1d2230;border-radius:4px;padding:0 4px;font-size:12px}
  tr.ev-bad td{color:#ff8080}
  tr.ev-ok td{color:#c8cede}
</style></head>
<body>
<h1>Agent Teams 状态</h1>
<p class="dim">每 2 秒自动刷新 · ${escapeHtml(new Date().toLocaleString('zh-CN'))} · 扫描目录 ${dirs.map((d) => `<code>${escapeHtml(d)}</code>`).join(' ')}</p>
${teams.length ? teams.map((team) => renderTeam(team, stale)).join('\n') : '<section><p class="dim">没有找到团队。检查启动时的工作目录，或加 --dir 指向你的项目根目录。</p></section>'}
${renderEvents(events)}
</body></html>`

/* ---------------------------------------------------------------- main */

function collect(dirs) {
  const teams = []
  const events = []
  for (const dir of dirs) {
    teams.push(...readTeams(dir))
    events.push(...readEvents(dir))
  }
  return {
    teams: teams.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)),
    events,
    stale: staleLabels(events, teams)
  }
}

async function serve(args) {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
      return
    }
    const { teams, events, stale } = collect(args.dirs)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(PAGE(teams, args.dirs, events, stale))
  })
  const port = await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(args.port, '127.0.0.1', () => resolve(server.address().port))
  })
  const url = `http://127.0.0.1:${port}`
  console.log(`Agent Teams 面板: ${url}`)
  console.log(`扫描: ${args.dirs.join(', ')}`)
  console.log('Ctrl+C 停止。团队状态每 2 秒自动刷新。')
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].split('/**')[1].trim())
  process.exit(0)
}
if (args.serve) await serve(args)
else { const result = collect(args.dirs); printTeams(result.teams, result.stale) }
