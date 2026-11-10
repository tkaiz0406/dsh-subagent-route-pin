# DeepSeek 官方 SuperAgent 与 dsh-delegation-hub 兼容性调研

- 抓取日期：2026-11-08
- 联网方式：本机访问 GitHub / 外网全部走 clash 代理 `http://127.0.0.1:7897`（curl 加 `-x http://127.0.0.1:7897`）；下文每条来源标注「代理=是/否」
- 调研对象：DeepSeek 官方 SuperAgent（`deepseek-ai` 组织下的项目）；本插件 `dsh-delegation-hub`（工作区 `D:\沈思宏\DSH桌面\dsh-plugins\dsh-delegation-hub`，`package.json` name=`dsh-delegation-hub`，整理时 version=`0.9.0`，仓库现名 [tkaiz0406/dsh-delegation-hub](https://github.com/tkaiz0406/dsh-delegation-hub)）

---

## 1. 三态结论

**结论：已发布（作为开源研究原型已发布，但非产品化发布）。**

判定依据：

1. **官方 GitHub 组织下存在公开仓库** `github.com/deepseek-ai/dsh-superagent-prototype`，经 `api.github.com/search/repositories` 查询（HTTP 200，走代理）：
   - `created_at = 2026-10-31T09:32:46Z`，`pushed_at = 2026-11-03T09:29:14Z`
   - `stargazers_count ≈ 20909`，`forks_count = 2473`，`license = MIT`，`default_branch = main`，`open_issues = 0`
   - 用 `org:deepseek-ai superagent` 检索，`deepseek-ai` 组织下与 superagent 相关的仓库**仅此一个**
2. **README 首段原文**（raw.githubusercontent.com，HTTP 200，走代理）：
   > "Research prototype for reference only, not an official DeepSeek product."
   > "We have adapted it for publication, so it is not identical to our internal version or the implementation described in *Exploring Super-agent Design: Towards a More Autonomous Agent System*."

   ⇒ 官方自己把「已发布」限定为**研究原型发布**，并明确声明**不是官方 DeepSeek 产品**。
3. **未产品化**的证据：
   - `github.com/deepseek-ai/dsh-superagent-prototype/releases` 与 `/tags` 页面（HTTP 200，走代理）均 grep 到 `There aren’t any releases`，**无 release、无 tag**
   - `registry.npmjs.org/dsh-superagent` → **HTTP 404 Not found**，未发 npm
   - `package.json`：`name=dsh-superagent`，`version=0.1.0`，`private: true`
4. **未找到一手发布公告**：`deepseek.com` 官宣、arXiv 论文 *Exploring Super-agent Design: Towards a More Autonomous Agent System* 的多轮检索只返回百度百科/词典/模型页噪音（详见 §2 失败清单）。

> 三选一取舍：仓库实体、代码、文档、社区热度都已公开可查，所以不是「未确认」；仓库确实存在于官方组织且被官方 README 承认为其发布物，所以不是「未发布」。但「已发布」必须带限定语——**已发布 = 开源研究原型；未发布 = 产品/正式版本**。若问题问的是「官方 SuperAgent 产品是否已发布」，答案是**未发布**；若问的是「官方 SuperAgent 项目/代码是否已公开」，答案是**已发布**。本报告取「已发布（研究原型）」为主结论，并把产品态标为未发布。

---

## 2. 取证清单

### 2.1 成功来源（均走代理 `-x http://127.0.0.1:7897`，抓取日期 2026-11-08）

| # | 来源 URL | 抓取方式 | 结果 | 支撑的结论 |
|---|---|---|---|---|
| 1 | `https://api.github.com/search/repositories?q=org%3Adeepseek-ai+superagent` | curl（代理=是） | HTTP 200 | 官方仓库存在、star/fork/created/pushed/license 元数据 |
| 2 | `https://api.github.com/search/repositories?q=deepseek-superagent` | curl（代理=是） | HTTP 200 | 官方仓库唯一性；同时暴露社区 mirror/fork 列表 |
| 3 | `https://raw.githubusercontent.com/deepseek-ai/dsh-superagent-prototype/main/README.md` | curl（代理=是） | HTTP 200 | "Research prototype for reference only, not an official DeepSeek product."；DSH bundle 自述 |
| 4 | `https://raw.githubusercontent.com/deepseek-ai/dsh-superagent-prototype/main/package.json` | curl（代理=是） | HTTP 200 | `private:true`、`engines.dsh ^0.2.1-alpha.2`、~20 个 `dsh-*` peerDependencies、`@deepseek-ai/cordis 4.0.5-alpha.1`、`dsh.bundle.patch=./cordis.patch.yml` |
| 5 | `https://raw.githubusercontent.com/deepseek-ai/dsh-superagent-prototype/main/cordis.patch.yml` | curl（代理=是） | HTTP 200 | insert `dsh-superagent` / `dsh-superagent-github` / `dsh-superagent-feishu`(disabled) / `dsh-superagent-worker-preset`（`@deepseek-ai/dsh-agent-preset`，id=`dsh-superagent-worker`）；worker preset 不含 forked subagents、plugin manager、scheduling、goals、workflows |
| 6 | `https://github.com/deepseek-ai/dsh-superagent-prototype/releases`、`/tags` | curl HTML（代理=是，各 HTTP 200） | grep 到 `There aren’t any releases` | 无 release / 无 tag |
| 7 | `https://registry.npmjs.org/dsh-superagent` | curl（代理=是） | HTTP 404 `Not found` | 未发 npm |
| 8 | `https://github.com/deepseek-ai/dsh-superagent-prototype`（仓库 HTML） | curl（代理=是） | HTTP 200，约 242KB | 仓库页面存在、README 渲染一致 |
| 9 | 官方仓库 `docs/003-execution.md` | raw（代理=是） | HTTP 200 | Executor Session 名 `worker-<ticket id>`，目录 `<stateDir>/work`；main Session 用 `dsh-superagent-router` preset；"Worker subagents use DeepSeek Harness's `standard` preset"（含嵌套）；worker slots / 30 分钟后台上限 / prepare 命令 / concurrency 规则 |
| 10 | 官方仓库 `src/app/sessions.ts:137-165` | raw（代理=是） | HTTP 200 | `async ensure(id, cwd, title, role: 'orchestrator'\|'worker')`：`ctx.sessionController.resolveAgent` → 不在则 `ctx.sessionController.create({sessionId, workspaceId, agentPreset: role==='worker'?WORKER_PRESET:ROUTER_PRESET})` → `initializeRoleModel(...)` → decorate → `permissionPresets.set('danger-full-access')` → rename |
| 11 | 官方仓库 `src/app/role-models.ts` | raw（代理=是） | HTTP 200 | `resolveRoleModel` 走 `ctx.llm.resolveCallConfig({provider, model, reasoningEffort?})`；`initializeRoleModel(ctx, agent, model)` 仅在 session 尚无 requestHeader 且无 `model/selection` 事件时 `agent.session.append('model/selection', selected)`，并用 prepend 的 `system-prompt/assemble` 与 `agent/request` 钩子覆盖首请求，最后 `ctx.sessionPersistence.flush()` |
| 12 | 官方仓库 `src/executor/background.ts` | raw（代理=是） | HTTP 200 | `subagentsOf = (ctx) => ctx.get('subagents')`；`Subagents` 接口仅 `waitForChildren / listChildren / drainChildren`；`stopSubagents` 有 `DRAIN_LIMIT_MS` |
| 13 | `https://api.github.com/search/repositories?q=deepseek-super-agent` | curl（代理=是） | HTTP 200 | `LofiSu/deepseek-super-agent`：created `2026-10-31T15:22:14Z`，pushed `2026-11-08`，stars `12`，description 明写 `(not an official DeepSeek product)` |
| 14 | `https://api.github.com/search/repositories?q=org%3Adeepseek-ai`（分页浏览） | curl（代理=是） | HTTP 200 | deepseek-ai 组织下 superagent 相关仓库唯一 |

**本地源码取证（不联网，2026-11-08）**

| 位置 | 事实 |
|---|---|
| 本插件 `index.js:1003` | `const TEAM_SEAMS = ['startActivation', 'startContinuable']` |
| 本插件 `index.js:1644-1672` | `function applyInner(ctx, config = {})` 要求 `ctx.subagents.registerProvider` 为函数，否则 `mounted:false`，reason `ctx.subagents.registerProvider is unavailable in this DSH build` |
| 本插件 `index.js:1705` | `disposeProvider = ctx.subagents.registerProvider(provider)`，providerName 默认 `pinned-account`，baseProvider 默认 `spawn`（`index.js:192-193`） |
| 本插件 `index.js:1230-1232` | `TeamInjectionAdapter` 在 `ctx.subagents.startActivation`（或 `startContinuable`）上填 `request.agentOptions.provider/model/reasoningEffort/maxTokens` |
| 本插件 `index.js:1352-1387` | 钩子探测：`wrapped` 数组记录实际包住的 seam，一条都没包住则置 unavailable |
| 本插件 `index.js:862` 起 `pickRoute` | 路由优先级 `experts > roles > steps > 配置行 > settings default` |
| 本插件 `README.md:12-13` | 「单发子代理走 `provider.start()`：包装 provider 直接生效」「团队模式成员不经过 `provider.start()`：在 `subagents.startActivation()`（当前契约）或 `startContinuable()`（旧名）上挂一层钩子」 |
| 本插件 `README.md:262` | 探测 `ctx.subagents.startActivation` / `startContinuable` 至少一条可被定义 own property；两条都没有则 `unavailable` 并退化为「仅单发子代理可控」 |
| 官方仓库 `src/` grep `agentOptions` | **0 命中**（superagent 自身不读写 `request.agentOptions`） |

### 2.2 联网失败证据（如实记录）

| 手段 | 目标 | 具体报错 / 现象 |
|---|---|---|
| `web_search` 工具 | 通用检索 | `Error: configured web provider "modsearch" is not registered`（该通道未注册，连续两次同样报错） |
| `advanced_search`（timeRange 无 / day） | 官方 SuperAgent 公告 | 一次 `Search timed out after 30s`；其余 bing 结果多为聚合站/词典噪音，未给出官方发布公告 |
| `api.github.com` core 端点（未认证） | 仓库详情 | `API rate limit exceeded for 67.159.48.147.`（`X-RateLimit-Remaining: 0`）；改用 search 端点（`search/remaining: 10`）成功取得元数据；**code_search 端点因此 403**，未能用代码搜索交叉验证 |
| `web_fetch` | `https://github.com/deepseek-ai/dsh-superagent-prototype` | `Error: tool call timed out after 30000ms`；**改用 curl 走代理抓 HTML（HTTP 200，约 242KB）成功** |
| `advanced_search` / `web_search` | `deepseek.com` 官宣、arXiv `Exploring Super-agent Design: Towards a More Autonomous Agent System` | 仅返回百度百科 / 词典 / 模型页噪音，**无一手公告**；arXiv 论文未定位到可访问的官方条目 |
| 裸连（不加代理） | GitHub | 超时（任务约束已预告：裸连必超时，所有成功请求均显式带 `-x http://127.0.0.1:7897`） |

> 说明：`web_fetch` 超时与 GitHub core 限流均**已通过替代路径（curl 走代理 / search 端点）取证**，不影响 §1 结论；唯一未能补齐的是「官方发布公告 / 论文一手链接」，因此 §1 中「产品态未发布」的判断建立在「无 release、无 npm、README 自述非产品」三项正向证据上，而非依赖「搜不到公告」这一负向证据。

---

## 3. 兼容性分析

### 3.0 关键事实：官方 SuperAgent **不是独立运行时**

任务预设的分支「若官方 SuperAgent 是独立运行时（不依赖 DSH/Cordis）」**不成立**。实测形态：

- `package.json` peerDependencies 含 `@deepseek-ai/cordis 4.0.5-alpha.1`、`@deepseek-ai/dsh-agent`、`dsh-api-session-controller`、`dsh-llm`、`dsh-session`、`dsh-schemastery 3.18.5-alpha.1` 等约 20 个 `dsh-*` 包，版本约束 `^0.2.1-alpha.2`
- `dsh.bundle.patch = ./cordis.patch.yml`：它是一份通过 `cordis.patch.yml` `insert` 进 DSH profile 的 **bundle**
- `engines.dsh = ^0.2.1-alpha.2`，`dsh.client.platform = web`
- 运行期直接消费 DSH/Cordis 宿主服务：`ctx.sessionController`、`ctx.llm.resolveCallConfig`、`ctx.sessionPersistence`、`ctx.get('subagents')`

⇒ 它与 `dsh-delegation-hub` **同进程、同插件体系、同一套 Cordis 容器**。因此兼容性按「同宿主下两个 Cordis 插件能否协同」来分析，而不是「跨运行时移植」。

### 3.1 分档结论

#### 档位 A — 直接复用：superagent worker 派生的 DSH 子代理

- **对象**：worker session（`dsh-superagent-worker` preset）内通过 `subagent` 工具 / 原生委派派生的子代理，以及其嵌套子代理（`docs/003-execution.md` 明确 "Worker subagents use DeepSeek Harness's `standard` preset"，含嵌套）。
- **结论**：**直接复用**。
- **理由**：这些子代理走 DSH 自身的 `SubagentRuntime` 创建路径，与 superagent 无关。本插件的两条现成接缝都在宿主层：
  1. 单发子代理 → `ctx.subagents.registerProvider` 注册的 `pinned-account` 包装 provider，在 `provider.start(request)` 处生效（`index.js:1705`、`README.md:12`）；
  2. 团队/可续命子代理 → `startActivation`（旧名 `startContinuable`）钩子填 `request.agentOptions`（`index.js:1003`、`1230-1232`、`README.md:13`）。
- **前提条件**：这些子代理的创建**必须经过 `ctx.subagents` 的 provider 表或 activation 钩子**（即 DSH 标准委派路径），而非 superagent 自建会话。满足该前提时，**无需修改 superagent 一行代码**。
- **风险点**：`onPinFailure` 默认 `fail`——若用户配的路由在 worker 场景下不可用，会直接让委派报错；worker 场景建议 `onPinFailure: inherit` 或 `fallback: true`（默认已开），避免阻断 superagent 的工单流水线。

#### 档位 B — 需适配层：worker / orchestrator Session 自身的模型钉住

- **对象**：`sessions.ts:137-165` 的 `ensure(id, cwd, title, role)` 创建的 `worker-<ticket>` 与 orchestrator session。
- **结论**：**需适配层**（现有两条接缝覆盖不到）。
- **理由**：superagent 给这两个 session 定模型的路径是
  `ctx.sessionController.create(...)` → `initializeRoleModel(ctx, agent, settings.executor.model | settings.eval.model)` → `agent.session.append('model/selection', selected)` + prepend `system-prompt/assemble` / `agent/request` 钩子 → `ctx.sessionPersistence.flush()`。
  该路径：
  - **不经过** `provider.start()`（不是 `ctx.subagents` 的 provider 表条目）；
  - **不经过** `startActivation` / `startContinuable`（不是 subagent activation，而是 session 创建）；
  - **不读** `request.agentOptions`（`src/` 下 grep `agentOptions` **0 命中**）。
  ⇒ 本插件的两条 seam 对这两个 session **天然失效**，这不是 bug，是接缝不对齐。
- **可行的三条适配路径**（按改动面从小到大）：

  | 路径 | 改动面 | 说明 |
  |---|---|---|
  | **B-1 零代码：直接用 superagent 自己的设置** | 0 行 | superagent 已有 `settings.executor.model` / `settings.eval.model`（经 `ctx.llm.resolveCallConfig({provider, model, reasoningEffort})` 解析）。把这两项指到 dsh-delegation-hub 想用的同一 provider/model 即可「事实上对齐」，无需 hub 适配。**推荐首选**。 |
  | **B-2 hub 侧加第三条注入点** | hub 中等改动 | 包住 `ctx.sessionController.create`（或 `resolveAgent`），在返回 agent 后按 label/role 覆写 `model/selection`，或在 `agent/request` prepend 层写入。风险：与 superagent 的 `initializeRoleModel` prepend 争抢首请求覆盖顺序，且要探测 `sessionController` 是否可被定义 own property（与现有 `TeamInjectionAdapter` 探测模式一致）。 |
  | **B-3 superagent 侧加一个钩子** | superagent 中等改动 | 在 `initializeRoleModel` 内读取一个可选的外部路由源（如 `~/.dsh/subagent-route-pin.json` 的 `roles` 字段），有则优先。**需要改官方仓库**，升级即被冲掉，不建议。 |

- **取证方式**：用本插件的 `~/.dsh/delegation-hub.ready.json` / `delegation-hub.last-run.json` / `delegation-hub.events.jsonl` 与 superagent worker session 的 `model/selection` 事件对照，即可实测「worker session 模型是否偏离配置行」（ready.json 已有 `drift` 字段可复用）。

#### 档位 C — 架构上不可用：假设它脱离 DSH/Cordis 变成独立运行时

- **对象**：假想分支——官方 SuperAgent 未来改成自带 runtime（不挂 DSH、不用 Cordis）。
- **结论**：**架构上不可用**（该分支当前不存在，仅作边界声明）。
- **理由**：本插件 `applyInner` 硬依赖
  - `ctx.subagents.registerProvider`（`index.js:1649-1672`，缺失即 `mounted:false`）；
  - `ctx.subagents.startActivation` / `startContinuable`（`index.js:1003`，都缺则 `teamInjection: unavailable`）；
  - Cordis 容器 `inject = ['subagents', 'agents']` 与插件生命周期。
  独立运行时没有这三样，本插件**根本挂不上**，不是「功能降级」而是「无法加载」。
- **替代思路**（若真走到这一步）：
  1. 在其 session 创建层做等价注入——读本插件的 `~/.dsh/subagent-route-pin.json`（`experts` / `roles` / `steps` / `default`）作为外部路由源，由一个薄适配器在创建 child 时写入其模型配置；
  2. 反向方案：不追求「hub 控制它」，而是让 superagent 自身的 `executor.model` / `eval.model` 直接指向目标车道（同 B-1），hub 继续只管 DSH 侧子代理；
  3. 保留 hub 的事件流（`delegation-hub.events.jsonl`）作为**旁路观测**：只要还跑在同一台机器，独立运行时也可以把它的委派事件 append 到同一格式的 jsonl，由 hub 面板统一展示——数据层兼容、控制层不兼容。

### 3.2 汇总表

| 场景 | 档位 | 是否需改 superagent | 是否需改 hub | 一句话理由 |
|---|---|---|---|---|
| superagent worker 派生的 DSH 子代理（含嵌套） | **直接复用** | 否 | 否 | 走 `provider.start()` / `startActivation`，宿主层两条 seam 天然覆盖 |
| worker / orchestrator Session 自身模型 | **需适配层** | 否（首选 B-1 零代码） | 视路径而定（B-2 才需） | superagent 用 `sessionController.create` + `initializeRoleModel` 写 `model/selection`，绕过两条现成接缝 |
| 若脱离 DSH/Cordis 成为独立运行时 | **架构上不可用** | — | — | hub 硬依赖 `ctx.subagents.registerProvider` + Cordis `inject`，无法加载 |

---

## 4. 接入路径与最小改动面

**推荐路径（零改 superagent、零改 hub 核心）**

1. 在同一 DSH profile 里同时安装 `dsh-delegation-hub` 与 `dsh-superagent`（两者都是 Cordis bundle，可共存；superagent 的 `dsh.bundle.patch = ./cordis.patch.yml` 走它自己的 patch，与 hub 的 `cordis.patch.yml` 互不冲突，安装时注意 profile 补丁合并顺序）。
2. **子代理层（档 A）**：直接依赖 hub 现有两条 seam——
   - 单发：`ctx.subagents.registerProvider` 注册 `pinned-account`（`index.js:1705`）；
   - 团队：`startActivation` 钩子注入 `request.agentOptions`（`index.js:1230-1232`）。
   配置面：`~/.dsh/subagent-route-pin.json` 的 `experts` / `roles` / `steps` / `default`（优先级 `experts > roles > steps > 配置行 > default`，`index.js:862`）。
3. **Session 层（档 B，首选 B-1）**：把 superagent 的 `settings.executor.model` 与 `settings.eval.model` 设为 hub 想用的同一条车道（`provider` + `model` + 可选 `reasoningEffort`），让 `ctx.llm.resolveCallConfig` 解析到同一目标。这是**唯一不需要任何代码改动**的对齐方式。
4. **可观测性对账**：读 hub 的 `~/.dsh/delegation-hub.ready.json`（含 `drift: {pinned, effective, by}`）、`delegation-hub.last-run.json`、`delegation-hub.events.jsonl`，与 superagent worker session 的 `model/selection` 事件比对，确认两层模型一致。

**若必须让 hub 主动控制 worker session（路径 B-2，hub 侧最小改动面）**

- 新增第三条注入点：探测 `ctx.sessionController.create` / `resolveAgent` 能否被定义 own property（复用 `TeamInjectionAdapter` 的探测+降级模式，`index.js:1352-1387`）；
- 包住后按 label / role（`worker` / `orchestrator`）在 session 创建完成、`initializeRoleModel` 之后覆写 `model/selection`；
- 新增 `roles` 之外的 role 标签约定（如 `superagent:worker`、`superagent:orchestrator`），走现有 `pickRoute` 优先级；
- 复用 `onPinFailure` / `fallback` / `failoverRoute` 既有语义，不新造失败处理；
- 测试面：为「sessionController 不可包裹」准备降级路径（置 `unavailable`，退化为 B-1 纯配置模式），与现有 `README.md:262` 的能力标志契约保持一致。

**若不可行时的替代思路**：见 §3.1 档位 C 的三条（外部路由源适配器 / 纯 settings 对齐 / 事件流旁路观测）。

---

## 5. 「官方 SuperAgent」与「社区 deepseek-super-agent」的区分

| 维度 | 官方 SuperAgent | 社区 deepseek-super-agent |
|---|---|---|
| 仓库 | `github.com/deepseek-ai/dsh-superagent-prototype` | `github.com/LofiSu/deepseek-super-agent` |
| 归属 | `deepseek-ai` 官方组织 | 个人/社区作者 |
| 自述 | README："Research prototype for reference only, **not an official DeepSeek product**." | description 明写 "**(not an official DeepSeek product)**" |
| 创建时间 | `2026-10-31T09:32:46Z` | `2026-10-31T15:22:14Z`（晚约 6 小时） |
| 最近推送 | `2026-11-03T09:29:14Z` | `2026-11-08` |
| Star / Fork | ≈20909 / 2473 | 12 / — |
| 形态 | **DSH bundle**（Cordis patch + `dsh-*` peerDeps，跑在 DSH 宿主内） | 社区独立实现（独立于 DSH 宿主的实现，昨天已对比过） |
| 许可 | MIT | — |

**其他易混淆条目（均非官方本体）**：

- 大量 mirror/fork 指向 `deepseek-ai/dsh-superagent-prototype`（如 `migetaa`、`p75w4xt8mt-bit`、`agent-memory-atlas-archive` 等命名空间下的同名仓库）——是镜像，不是独立项目；
- `Check-mj/dsh-superagent-windows`——自称「非官方 fork」，Windows 适配版；
- `chunonesoft/open-superagent`——自称 `deepseek-ai/dsh-superagent-prototype` 的社区维护版。

**本报告的兼容性分析对象是官方 `deepseek-ai/dsh-superagent-prototype`**；社区 `LofiSu/deepseek-super-agent` 是独立实现，不参与 §3/§4 的接缝结论（其形态不同，若要评估需另行取证）。

---

## 6. 附：本插件侧关键锚点（供复核）

- `index.js:1003` `const TEAM_SEAMS = ['startActivation', 'startContinuable']`
- `index.js:1644` `function applyInner(ctx, config = {})`；`index.js:1649-1672` `registerProvider` 缺失 → `mounted:false`
- `index.js:1705` `disposeProvider = ctx.subagents.registerProvider(provider)`
- `index.js:1230-1232` TeamInjectionAdapter 写 `request.agentOptions.{provider,model,reasoningEffort,maxTokens}`
- `index.js:862` `pickRoute` 优先级 `experts > roles > steps > 配置行 > settings default`
- `README.md:12-13` 两条接缝说明；`README.md:262` 探测与降级契约
- `package.json` `name=dsh-delegation-hub` `version=0.9.0`
