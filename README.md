# dsh-delegation-hub

给被委派的子代理（专家团专家、Agent Teams 成员、单发子代理）单独指定 LLM 路由，主 agent 不受影响。

解决的问题：DSH 默认让子 agent 继承主 agent 的模型路由，于是「大脑 + 4 路子代理」挤在同一个 provider 账号额度里，`summon_experts` 看起来卡死。装上本插件后，主 agent 可以跑免费车道，子代理跑另一个账号/模型，两条额度队列互不阻塞。

适用面：**按 provider 生效，不按专家名单**。agency 里 331 个专家、你新建的自定义专家、以后升级新增的专家，只要还读 `config.provider`，都自动命中同一条路由。

## 它做什么

- 注册一个包装 provider `pinned-account`，委托内置 `spawn`，在创建子 agent 前填入 `agentOptions`
- 单发子代理走 `provider.start()`：包装 provider 直接生效
- 团队模式成员不经过 `provider.start()`：在 `subagents.startActivation()`（当前契约）或 `startContinuable()`（旧名）上挂一层钩子，把路由填进 `request.agentOptions`（可用 `teamInjection: false` 关闭）
- **覆盖团队成员自带路由**（`overrideMemberRoute`，默认开）：Agent Teams 会按自己的 `memberLlmProvider` / `memberModel` 先填好 `agentOptions`，只填「空槽」等于一个成员也钉不上；开着时钉住的路由优先，关掉则尊重调用方已选的路由（只补空槽）
- **能力标志**：钩子探测结果会发布成 `{ teamInjection: 'installed' | 'unavailable', enabled, seams, reason }`，调用方能读到「团队注入此刻可不可用、挂在哪条缝上」，而不是只靠日志猜
- **零配置可用**：没配路由、或路由指向一个当前不存在的 provider/model 时，子 agent 继承主 agent 的模型，召唤不会失败
- **失败必提示**（`onPinFailure`，默认 `fail`）：你在设置页选过模型、它却跑不起来时，召唤直接报错并在错误里写明「哪个路由失败、为什么、去哪里改」，绝不静默换成别的模型；设成 `inherit` 才允许回退
- **自动接线**（`autoWireAgency`，默认开）：挂载时把 profile 里 `agency-agents` 行的 `provider` 补成 `pinned-account`（改前留 `.bak-autowire-*` 备份，已接线则不动），装完不需要手改 YAML
- 每次委派的结果写进 `~/.dsh/delegation-hub.last-run.json`（`pinned` / `failed` + 原因），排障不用翻日志
- 设置 → **委派中枢** 页面：提供商 / 模型 / 推理强度下拉 + 团队模式注入开关 + 专家团引擎提示，保存写回 profile 补丁，下一次委派生效
- 逐专家覆盖：`~/.dsh/subagent-route-pin.json` 的 `experts` 字段（可选，优先级高于页面）
- **团队面板事件树（0.10 新增）**：`dsh-team-status --serve` 面板新增「委派事件流」区块——读各扫描目录的 events.jsonl，按时间倒序列出最近 40 条（label/通道/结果/路由/来源），failover 与 failed 行红色高亮；坏行自动跳过。
- **任务拆分器（0.10 新增，含设置页编辑器）**：设置页「步骤路由」区直接添加步骤行（步骤名+提供商+模型下拉），保存写入配置行；settings 文件的 steps 字段同样生效（配置行按键优先，两者并集）。：settings 文件的 `steps` 字段让一次目标可以拆成多个串行子委派、每步用不同模型——委派时给 label 加 `#步骤名` 后缀（如 `调研报告#research`），该步即走对应路由。优先级 `experts > roles > steps > 配置行 > default`；不带后缀的 label 完全不受影响；未知步骤名回落配置行。一键写入：`node bin/step-preset.mjs dev`（或注册后的 `dsh-step-preset dev`，research/code/review 三车道，支持单步覆盖与 clear，写前自动备份）。
- **captain 报错上报（0.10 新增）**：配置了 failoverRoute 的团队成员在运行中触发故障切换时，插件会按 agent-teams 的信箱契约（isTeamMessage：id/from/to/content/ts）向船长信箱 `.agent-teams/<teamId>/inbox/captain.jsonl` 追加一条来自 `delegation-hub` 的报告（含失败码与改写路由），写入采用读全文+重写的原子模式，与 agent-teams 自身写入互不丢行。非团队 label 或 cwd 不可得时静默跳过。
- **委派事件流（0.9 新增）**：每次委派的判定（label/channel/source/route/outcome/reason）除单条覆盖的 `last-run.json` 外，还追加写入 `~/.dsh/delegation-hub.events.jsonl`（一行一个 JSON 对象，追加式永不覆盖）。`readEvents(path)`（由 `@…/dsh-delegation-hub` 导出）读取该流并跳过损坏行，供树状图、captain 报告与证据锚点消费。ready.json 新增 `drift` 字段：生效路由偏离配置行时给出 `{pinned, effective, by}`，一致时为 null。
- **运行中故障切换（0.9 新增）**：配置行加 `failoverRoute: {provider, model}` 后，被钉住的子代理在运行中撞上车道级故障（额度耗尽 QUOTA、限流 RATE_LIMIT、鉴权 AUTH、凭据缺失 MISSING_CREDENTIAL、适配器消失 NO_ADAPTER）时，其后续请求会被改写到该备用路由（仅切换一次，删除继承的推理强度），并写一条 `outcome: "failover"` 的 last-run 记录。区别于 `fallback`（只管启动阶段）：failover 管的是子代理已经跑起来之后的流内错误。不配置即关闭。
- **按角色路由（0.9 新增）**：settings 文件的 `roles` 字段把 Agent-Teams 成员按其团队角色钉到不同模型，优先级 `experts > roles > 配置行 > default`。角色来自 `.agent-teams/<teamId>/team.json` 的 `members[].role`（团队状态文件），示例：
  ```json
  {
    "roles": {
      "实现者": { "provider": "deepseek-account", "model": "deepseek-flash" },
      "验证者": { "provider": "deepseek-account", "model": "deepseek-flash" },
      "审查者": { "provider": "deepseek-account", "model": "deepseek-pro" }
    }
  }
  ```
  一键写入：`node bin/role-preset.mjs delivery`（或注册后的 `dsh-role-preset delivery`）；单角色覆盖 `dsh-role-preset delivery reviewer=xiaomi/mimo-v2.6-pro`；清除 `dsh-role-preset clear`。改动下一次团队委派即生效（settings 每次委派热读）；写前自动备份。
- **兼容保留的旧名**（故意不改，避免静默丢失已配置的路由）：用户设置文件 `~/.dsh/subagent-route-pin.json` 与环境变量 `DSH_ROUTE_PIN_*` 沿用旧名；插件本身、探针记录、页面均已改名

## 安装

```bash
# 从 tarball
dsh plugin --profile desktop add "./dsh-delegation-hub-0.9.0.tgz"

# 从 npm（发布后）
dsh plugin --profile desktop add "dsh-delegation-hub"

# 从本地目录（开发调试，link 安装）
dsh plugin --profile desktop add "D:\\path\\to\\dsh-delegation-hub"
```

`dsh plugin` 要写 profile 目录，通常需要提权（关闭沙箱或以同一用户直接运行终端）。

`name` 是 DSH loader 的**模块解析键**，必须与 `package.json` 的 `name` 逐字一致，并且真的能在 profile 的 `node_modules` 里解析到。两个约束同时成立才加载：

- profile 的 `cordis.patch.yml` 按 `name` 匹配 `cordis.yml` 的基础条目，**不一致整条被跳过**（该行配置静默失效）；
- loader 拿这个字符串去 `node_modules` 里解析，**解析不到就静默不加载**——设置页那张卡片还在（客户端代码是单独扫描 `node_modules` 得到的，独立于宿主加载），但供应商/模型两个下拉是空的、推理强度停在第一项 `low`，也没有就绪记录。

「装上了但什么都没生效」基本都出在这。典型冲突：profile 用带 scope 的依赖键装（`node_modules/@owner/dsh-delegation-hub`），而包名是裸名 `dsh-delegation-hub` → 裸名解析不到。两种解法二选一：把依赖键改成包名本身，或在 `node_modules` 里给裸名建一个指向实际目录的 junction（Windows `New-Item -ItemType Junction`，不需要管理员）。

自检两行即可分辨：

```bash
node -e "require('dsh-delegation-hub/package.json')"   # 能解析 → 名字对
cat ~/.dsh/delegation-hub.load.json                   # 有这个 → 模块被 import 了（apply 不一定跑）
cat ~/.dsh/delegation-hub.ready.json                  # 有且 at 是本次启动 → 宿主真的激活了插件
```

装完后 profile 的 `cordis.patch.yml` 里新增一行（包内 `cordis.patch.yml` 已自带，无需手写）。`provider` 留空即「不钉路由」，子 agent 继承主 agent 的模型：

```yaml
- id: delegation-hub
  name: "dsh-delegation-hub"
  config:
    providerName: pinned-account
    baseProvider: spawn
    provider: deepseek-account
    model: deepseek-flash
    reasoningEffort: ''
    strict: false
    teamInjection: true
    overrideMemberRoute: true
    fallback: true
```

**装完不配也能用**：路由没填、或填的 provider/model 在当前账号里不存在时，插件只打一条警告，子 agent 照旧继承主 agent 的模型——不会让召唤失败。`strict: true` 才会把它变成硬错误。

## 真正要改的只有两处

想把子 agent 分到另一条车道，只需要两处：

1. **这条路由** —— `provider` / `model`，指向你账号里真实存在的组合。不用手改文件：打开 设置 → 委派中枢，点选后保存即可（写回同一行）。
2. **专家团那行的 `provider`** —— 改成 `pinned-account`，否则专家根本不经过本插件。

除此之外没有第三处。团队模式（Agent Teams）不走这条路径，见下文。

## 让专家团用上它

专家团（`@michengai/dsh-agency-agents`）默认走 `spawn`，需要把它的 provider 指过来：

```yaml
- id: agency-agents
  name: "@michengai/dsh-agency-agents"
  config:
    provider: pinned-account
    # 不要写 maxDepth —— 写了会强制单发阻塞引擎，召唤要等全部跑完
```

> 注意：profile 的 patch 行是**整行替换 config**，改这一行时要把 `enabled` / `customExperts` / `enabledTeams` 等原字段一起重述，否则会被清空。

Agent Teams（`@nanmicoder/dsh-agent-teams`）有自己的一套 `memberModel` / `memberLlmProvider`，插件不会覆盖它——两条路由各管各的，避免互相打架。

## 看团队跑到哪了（本地面板）

Agent Teams 自己是**条件渲染**的：会话标题栏那个入口只在「当前会话确实持有一个开跑的团队」时才出现，计划还在暂存（等你批准）、或者你换了会话、想看别的项目里的团队，界面上就什么都看不到。

插件带了一个只读的状态面板，直接读磁盘上的 `.agent-teams/<team>/team.json`：

```bash
# 起一个本地面板，浏览器打开它给的地址，2 秒自动刷新
npm run teams -- --scan "D:/你的工作区父目录"

# 只想在终端看一眼
npm run teams:once -- --dir "D:/你的项目"

# 装了 npm 包的话，也可以直接用 bin
dsh-team-status --serve --port 7800
```

参数：

| 参数 | 作用 |
| --- | --- |
| `--dir <path>` | 指定工作区根目录（其下有 `.agent-teams/`），可重复 |
| `--scan <root>` | 把 root 自身和它的直接子目录里带 `.agent-teams` 的都扫进来 |
| `--serve` | 起 HTTP 面板（默认 `127.0.0.1:7788`） |
| `--port <n>` | 换端口 |

面板显示：团队阶段、计划是否**待批准**、成员（角色/状态/模型）、任务表（ID/状态/负责人/依赖/尝试次数）、完成进度条。暂存态会直接提示「计划还没批准：去 Web 的计划卡点 Approve & Run，否则成员不会启动」——这就是最常见的「看不到团队」原因。

它只读状态文件，不连 DSH、不改任何东西，所以任何会话、任何项目都能看。

## 验证

重启 DSH 后：

1. 设置 → 委派中枢 页面出现，底部显示「专家团引擎」
2. 日志出现 `delegation-hub: provider "pinned-account" delegates to "spawn"`
3. 日志出现 `delegation-hub: team-mode hook installed on ctx.subagents.startActivation`
4. 日志出现 `delegation-hub: capabilities {"teamInjection":"installed","enabled":true,"seams":["startActivation"]}`
5. 委派时出现 `delegation-hub: team member label="…" -> provider/model`

**这五行是接口契约，不是装饰**：第 2 行说明 provider 包装还挂得上，第 3、4 行说明创建子代理的那条缝还在（`seams` 会写出实际包住的方法名），第 5 行说明注入实际生效。升级 DSH 后少任何一行，都说明上游接口变了，先别怪额度。

这些行在哪看：`ctx.logger.info` 只进 DSH 进程控制台（GUI 的开发者控制台 / 终端 stdout），**不落盘**。`~/.dsh/logs/` 下只有启动**失败**时的诊断 dump，正常启动不写日志文件——所以别去那里找。

插件为此每次启动落一条就绪记录，升级后一条命令就能验：

```bash
npm run verify        # = node test/run.mjs && node test/logs.mjs --strict
npm run ready         # 只看盘上的就绪记录，不跑测试
```

就绪记录：`~/.dsh/delegation-hub.ready.json`

```json
{
  "schema": 1,
  "plugin": "delegation-hub",
  "version": "0.8.13",
  "at": "2026-10-20T12:04:11.208Z",
  "mounted": true,
  "providerName": "pinned-account",
  "baseProvider": "spawn",
  "route": "trae/deepseek-v4.1-flash",
  "routeSource": "config row",
  "configRow": "trae/deepseek-v4.1-flash",
  "settingsDefault": "xiaomi/mimo-v2.6-flash",
  "settingsDefaultShadowed": true,
  "experts": 0,
  "fallback": true,
  "teamInjection": true,
  "capabilities": { "teamInjection": "installed", "enabled": true, "seams": ["startActivation"] }
}
```

`route` / `routeSource` 是**当前真正生效**的路由。优先级是 `experts[专家名]` → 配置行（设置页写的那个）→ 设置文件的 `default`；配置行一旦有值，`~/.dsh/subagent-route-pin.json`（兼容保留的旧设置文件名）里的 `default` 就会被盖住，记录里用 `settingsDefaultShadowed: true` 明确标出来，同时打一条 WARN——否则「我改了 JSON 但模型没变」在外部完全查不出原因。

`test/logs.mjs` 校验：插件身份、版本与本地 `package.json` 一致、是否挂载、能力标志、**实际挂住的接缝**（`seams` 里没有 `startActivation` 会 WARN：那说明这个构建可能根本不调被包住的方法）、回退开关、`providerName -> baseProvider`、**生效路由与来源**（`settingsDefaultShadowed` 为真时 WARN 点名被盖住的那个值）、记录龄（超过 7 天提示重启 DSH）。探针文件里出现 `null`、数组、标量或解析不了的 JSON 一律判失败（`unreadable` / `not an object`）：「磁盘上有记录但读不出裁决」等于证据丢了，不能当成「已验证挂载」，这条判断**不随 `--strict` 变化**。`--strict` 只额外把 `teamInjection: 'unavailable'` 判失败——发版前该用这个。

有控制台输出时还能一起验那五行：

```bash
node test/logs.mjs --log captured-console.txt
```

默认 `provider delegates` / `hook installed` / `capabilities published` 三条必需，`team member label=` 在还没委派过时记为 `none`。

## 失败回退

`fallback: true`（默认）时，钉住的这条路由起不来不会直接砸掉委派：

| 场景 | 行为 | 日志 |
| --- | --- | --- |
| 单发子代理，`pinned-account` 的 `start()` 报错 | 去掉注入的路由，用调用方本来的路由重试一次 | `pinned route … failed to start (…); retrying on the inherited route …` |
| 团队成员，创建调用报错 | 把 `request.agentOptions` 还原成调用方原本要的那份（Agent Teams 自己的成员路由），重试一次 | `team member … failed to start on …; retrying on the requested route …` |
| 团队成员本来没带路由（被插件填的） | 删掉注入的 `agentOptions`，用继承路由重试一次 | `…; retrying on the inherited route` |
| 重试后仍然失败 | 抛出原始错误，不吞 | — |
| 注入的路由和继承路由本来就一样 | 不重试（重试等于再撞一次同一额度） | — |

边界要说清楚：**只在启动阶段可观测**。子代理跑起来之后，流式请求中途的 429/额度错误发生在 `start()` 返回之后，插件抓不到——那种情况要看 DSH 自己的重试与错误上报。所以 `fallback` 兜的是「开局就撞墙」，不是「跑到一半断粮」。

## 兼容性

### 兼容矩阵

| DSH / `@deepseek-ai/dsh-tool-subagent` | 状态 | 说明 |
| --- | --- | --- |
| `0.2.0-rc.1` ≤ 版本 < `0.4.0` | ✅ 覆盖范围 | 当前 `peerDependencies` 写的范围，`0.2.1-rc.2`、`0.2.1-rc.3` 实测 248 项（面板含事件流表）断言全绿；本机构建只有 `startActivation`（无 `startContinuable`），插件按 `startActivation` 注入 |
| `0.2.1-rc.3` | ✅ 已验证 | 桌面端 0.2.1-rc.3 上 readiness 记录显示 `seams: ["startActivation"]`、`teamInjection: installed`，配置行路由生效 |
| `0.2.0-rc.x` | ❓ 未验证 | 接口面看起来一致（旧版走 `startContinuable`），但没跑过；装了会看到 peer 警告 |
| `>= 0.4.0` | ⚠️ 未验证 | 超出 peer 范围，DSH 插件管理器会标「异常」并拒绝启动；上游一旦改动 provider 或创建子代理的接缝，日志会先缺，插件按能力标志降级 |

`peerDependencies` 从「钉死单个 `0.2.1-rc.2`」放宽到 `>=0.2.0-rc.1 <0.4.0`：DSH 每次发 rc 都不再让这个插件被判不兼容、也不会因此被插件管理器拦下。范围上限留在 `0.4.0`，是因为 provider 和创建子代理的接缝属于内部契约，跨 minor 需要重新验证——发版前请跑 `npm test`（248 项（面板含事件流表）断言）与 `npm run ready`（真实宿主上的 readiness）。

同一个范围还写在 `package.json` 的 `engines.dsh` 里，两处**必须逐字相同**（`npm test` 会比对，改一处不改另一处会红）：

| 位置 | 谁在读 | 读来干什么 |
| --- | --- | --- |
| `peerDependencies` | DSH 插件管理器、npm | 装不装得下；超出范围标「异常」并拒绝启动 |
| `engines.dsh` | 插件市场的索引构建（`probe-npm`）、Discover 页的筛选 | 在列表里按「我这个 DSH 版本能不能用」过滤，是装之前的第一个信号 |

两份范围漂移是静默的：包照样列在市场上，只是筛不到、或装到一半才报不兼容。所以它是一条断言，不是一句注释。

### 接口依赖

| 依赖 | 说明 |
| --- | --- |
| `ctx.subagents.registerProvider` | 缺失时置能力标志 `teamInjection: 'unavailable'` 并告警，不阻断 profile 启动 |
| `ctx.subagents.startActivation` / `startContinuable` | 至少一条存在且可被定义 own property；两条都在时优先 `startActivation`（当前构建的原生委派与 Agent Teams 都走它），两条都不在则置 `unavailable` 并退化为「仅单发子代理可控」 |
| `@deepseek-ai/dsh-tool-subagent` 的 provider 接口 | 能力表必须声明 `agentOptions`；内置 `spawn` 自带 |
| 浏览器侧 `configForms` / `slots` / `locale` / `remote.session.modelCatalog` | 页面用；缺失时卡片显示「不可用」状态 |
| 设置行 patch 语义 | 整行替换 config，不是合并 |

读取能力标志（宿主侧）：

```js
import { teamInjectionCapabilities } from 'dsh-delegation-hub'

// { teamInjection: 'installed' | 'unavailable', enabled?: boolean, seams: string[], reason?: string }
const capability = teamInjectionCapabilities(ctx.subagents)
if (capability.teamInjection === 'unavailable') {
  // 团队成员会保持父路由 —— 这里决定要不要降级/提示用户
}
// seams 是实际包住的方法名：['startActivation'] 表示当前构建真的会走到它
```

同一份结果也挂在 `ctx.subagents[Symbol.for('dsh-delegation-hub.team-hook')].capabilities` 上；0.8 之前的 `…continuable-hook` 符号仍然读写，旧调用方不用改。

`teamInjection` 依赖接缝方法可被定义 own property；若 DSH 后续冻结该服务对象，插件置 `unavailable` 并退化为「仅单发子代理可控」。

## 测试

```bash
node test/run.mjs        # 248 项（面板含事件流表）断言，不需要 DSH 在跑
node test/logs.mjs       # 检查真实启动留下的就绪记录
npm run verify           # 两个一起，且 --strict
```

248 项（面板含事件流表）断言：路由优先级、文件热读、strict 校验、团队注入、覆盖团队成员自带路由（默认覆盖 / `overrideMemberRoute: false` 时尊重 / 保留调用方其他字段 / 丢弃旧路由的 effort / 覆盖失败退回调用方原路由）、开关关闭、缺路由不阻断、dispose 还原、重复挂载换路由、能力标志（installed / unavailable / 无任何接缝）、多接缝（只有 `startActivation` / 只有 `startContinuable` / 两条都在时优先前者且只注入一次）、启动失败回退（单发 / 团队 / 关闭开关 / 重试仍失败 / 同路由不重试）、日志契约、就绪记录（正常挂载 / 缺服务 / 版本一致 / 生效路由与来源 / 设置文件 default 被配置行盖住时报警 / 缺路由字段时 WARN 而不是打印 `undefined -> undefined` / 未来时间戳不报健康年龄）、激活探针（成功覆盖陈旧 parked / 版本与 package.json 严格相等 / 拒绝挂载时记 `degraded` 而非 `applied` / 只 import 不 apply 记 `parked` / `apply()` 抛错记 `failed` 且保留原文 / 四个相位都带 `mounted` 与 `invoked` / 冒烟检查读旧 schema 的 `note`/`error` 不丢原因 / 空字符串理由会落到旧字段 / 过旧探针报版本与年龄 / 损坏 JSON 记 `unreadable` 且不冒充「未被 import」/ 非对象记录同样判失败且判定不随 `--strict` 变化 / 未来时间戳不报健康年龄 / 探针缺失判失败而不是「删掉就过」 / 版本不一致判 `MISS` 而不是先给绿灯 / 就绪记录为非对象时判失败且不崩栈、判定与损坏 JSON 一致）、发包元数据（engines.dsh 与 peer 范围一致 / bin 路径无前导 ./ 且文件存在 / 包内 cordis.patch.yml 的 name 指向本包且是可解析的模块路径）。

`test/run.mjs` 证明的是**插件逻辑没坏**；`test/logs.mjs` 证明的是**它在这个 DSH 构建里还挂着**。两件事会分别失败，上游接口变更先体现在后者。

## 升级回归

升级 DSH 后按这个顺序走，别跳步：

```bash
node test/run.mjs                 # 1. 逻辑层：248 项（面板含事件流表）还绿吗
# 2. 重启 DSH（只改插件不用，改 DSH 本体必须）
npm run ready                     # 3. 挂载层：就绪记录还是这次启动写的吗
```

第 3 步读到 `capabilities.teamInjection: "unavailable"` 就是上游把创建子代理的接缝动了——此时单发子代理仍可控，团队模式成员退回父路由。读到 `seams` 里没有 `startActivation`，说明钩子包住的方法当前构建不调用，同样是接口变了。把 `peerDependencies` 和兼容矩阵一起对一遍，再决定是适配还是回滚。

## 发布

包名是**不带 scope** 的 `dsh-delegation-hub`（npm 上确认未被占用），因此不需要拥有任何 npm 组织/scope，登录任意账号即可发布：

```bash
npm login --registry=https://registry.npmjs.org/
npm publish --registry=https://registry.npmjs.org/   # 无 scope，默认为 public
pnpm pack --pack-destination dist
```

> **两个源必须显式指定**。国内机器通常把全局 `registry` 指向 `registry.npmmirror.com`，那是个只读镜像：`npm login` 会把你带到 CNPM 的注册页并报 `Public registration is not allowed`，而 `npm publish` 打到它上面直接 401。本机 `npm config get registry` 返回的就是 `https://registry.npmmirror.com`，所以上面每条命令都带 `--registry`。想省掉参数就在**项目根目录**建一个只含 `registry=https://registry.npmjs.org/` 的 `.npmrc`（项目级配置优先于全局），并把它加进 `.gitignore`。
>
> 发布前先跑 `npm publish --dry-run --registry=https://registry.npmjs.org/`，确认 `Publishing to https://registry.npmjs.org/` 且**没有任何 `npm warn`**——`bin` 路径写成 `./bin/x.mjs` 这类问题只在 warn 里出现，`publish` 照样 exit 0，发出去的包里却没有命令。

> 若以后要改到自己的 scope（例如 `@yourname/dsh-delegation-hub`），必须同时改这 **4 处**，少一处就会出现「装上了但不加载」：
>
> | # | 位置 | 作用 |
> | --- | --- | --- |
> | 1 | `package.json` → `name` | 安装名、依赖解析名 |
> | 2 | `cordis.patch.yml` → 行的 `name` | profile 加载器按包名找入口 |
> | 3 | `client.js` → `__ModuleLoader__.load({ id })` | 浏览器端模块 id |
> | 4 | `client.js` → `CONFIG_NS_CANDIDATES` | 设置页绑定配置行的候选名 |
>
> 另需同步 `test/client.mjs`、`test/browser-harness.html` 里的 id 断言，以及 README 里的安装示例。

GitHub 仓库名与 npm 包名保持一致（`dsh-delegation-hub`），仓库归属 `tkaiz0406` 是 GitHub 账号，与 npm scope 无关，`repository`/`homepage`/`bugs` 无需随 npm 改名。

## 回滚

```bash
dsh plugin --profile desktop remove "dsh-delegation-hub"
```

或删掉 profile `cordis.patch.yml` 里 `id: delegation-hub` 那一行。

## License

MIT — 见 [LICENSE](LICENSE)。
