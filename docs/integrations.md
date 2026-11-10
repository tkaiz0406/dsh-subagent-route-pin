# 与本机其他 DSH 插件的搭配说明

本文件记录 `dsh-delegation-hub`（委派中枢，本仓库）与本机已装 DSH 插件的组合关系。

- 事实来源：本仓库 `README.md`、desktop profile 的 `C:\Users\沈思宏\.dsh\profiles\desktop\package.json` 与 `C:\Users\沈思宏\.dsh\profiles\desktop\cordis.patch.yml`、各插件包内 `package.json` 的 `description`、`C:\Users\沈思宏\.dsh\plugins-local` 下的本地插件源码。
- 核对日期：2026-11-08。
- 本插件定位：给被委派的子代理（专家团专家、Agent Teams 成员、单发子代理）单独指定 LLM 路由（provider + model + reasoningEffort），主 agent 路由不动。生效优先级 `experts > roles > steps > 配置行 > settings default`。
- 取证文件：`~/.dsh/delegation-hub.last-run.json`（单条判定）、`~/.dsh/delegation-hub.events.jsonl`（追加事件流）、`~/.dsh/delegation-hub.ready.json`（挂载与生效路由，含 `drift`）。
- 当前 profile 实配（`cordis.patch.yml`）：`delegation-hub` 行 `provider: xiaomi` / `model: mimo-v2.6-flash` / `reasoningEffort: high` / `strict: false` / `fallback: true` / `teamInjection: true`；`agent-default-model` 行 `provider: workbuddy-global` / `model: hy4free`（主 agent 车道）。

> **版本说明**：各插件标题括号里是整理时（2026-11-08）本机安装的版本，可能与 npm latest 略有滞后；「仓库」列给出该插件的上游地址（npm `repository` 字段，2026-11-10 核对），`dsh-our-free-model` 与 `dsh-purge` 为本机本地插件（link 安装，无公开仓库）。本插件的仓库：https://github.com/tkaiz0406/dsh-delegation-hub 。

| # | 插件 | 版本 | 仓库 |
| --- | --- | --- | --- |
| 1 | dsh-our-free-model | 本机本地 | （link 安装自 `C:/Users/沈思宏/.dsh/plugins-local/dsh-our-free-model`） |
| 2 | dsh-connect-workbuddy | 5.20.2 | https://github.com/dingminhua/dsh-connect-workbuddy |
| 3 | @michengai/dsh-agency-agents | 1.2.26 | https://github.com/MichengAI/dsh-agency-agents |
| 4 | @deepseek-ai/dsh-subagent-claude-code | 0.2.2-rc.1 | https://github.com/deepseek-ai/deepseek-harness |
| 5 | @nanmicoder/dsh-agent-teams | 0.1.29 | https://github.com/NanmiCoder/dsh-agent-teams |
| 6 | @michengai/dsh-code-review | 1.0.8 | https://github.com/MichengAI/dsh-code-review |
| 7 | @a9i5k4/dsh-auto-memory | 3.3.17 | https://github.com/Aik358/dsh-auto-memory |
| 8 | billion-context | 0.1.212 | https://github.com/ranxianglei/billion-context |
| 9 | dsh-context | 0.82.1 | https://github.com/bowenliang123/dsh-context |
| 10 | dsh-ops | 0.5.0 | https://github.com/T-Auto/dsh-ops |
| 11 | dsh-composition-doctor | 0.4.0 | https://github.com/lemonxiny55/dsh-composition-doctor |
| 12 | dsh-purge | 1.1.88 | （link 安装自 `D:/沈思宏/DSH桌面/dsh-purge-1.1.88`） |
| 13 | @weibaohui/dsh-continue | 0.3.12 | https://github.com/weibaohui/dsh-continue |
| 14 | @michengai/dsh-skills-manager | 1.2.35 | https://github.com/MichengAI/dsh-skills-manager |

## 一、路由与模型通道类

### 1. dsh-our-free-model（本机本地插件）

- **它解决什么**：免 API Key 的模型通道插件。源码 `src/adapter.js:78-79` 注册路由键 `our-free-model` 与 `our-free-model-region`（`ctx.llm.registerAdapter`，`index.js:447`），另挂 10 个账号渠道的 free-channel pack（启动日志 `free-channel pack mounted (10 account providers)`），带本地 OpenAI 网关、账号池与数据看板。安装位置 `C:\Users\沈思宏\.dsh\plugins-local\dsh-our-free-model`，以 link 方式进 desktop profile（`"dsh-our-free-model": "link:C:/Users/沈思宏/.dsh/plugins-local/dsh-our-free-model"`）。
- **组合用法**：它注册的 provider/model 进入 llm 目录后，委派中枢设置页（设置 → 委派中枢）的提供商与模型下拉即可直接选中；把子代理钉到这些通道，主 agent 保持 `agent-default-model` 行的路由，两条额度分开走。
- **冲突或注意事项**：委派时 `checkRoute` 对照 llm 目录做预校验——该插件热重载或渠道目录变动后，若钉住的 provider/model 组合已不存在，`strict: false` 只发警告，随后按 `onPinFailure` 处理（默认 `fail`：召唤直接报错并写明哪条路由失败、去哪里改；设成 `inherit` 才回退继承主 agent 路由）。本插件不读取它的积分、账号池与签到状态。

### 2. dsh-connect-workbuddy（5.20.2）

- **它解决什么**：把本机登录的 WorkBuddy 模型（国内版与国际版）接入 DSH：按上游目录读取逐模型积分倍率、逐模型图片输入开关、多账号切换与账号池自动换号、每日签到、输入框胶囊积分读数。
- **组合用法**：它的模型目录（如 `hy4free` / `max-model`，见 `cordis.patch.yml` 的 `dsh-connect-workbuddy` 行 `lastCatalog`）同样进 llm 目录，可作为子代理钉住路由的目标；当前主 agent 已配成 `workbuddy-global / hy4free`，子代理改钉 `xiaomi / mimo-v2.6-flash`（本插件当前配置行），即形成主、子两条通道。
- **冲突或注意事项**：子代理与主 agent 钉到同一个 provider 时共用该账号额度，账号池换号只按它自己的规则发生，本插件不感知；额度耗尽属于车道级故障，只有配置了 `failoverRoute` 的行才会被本插件接住（一次性改写后续请求并写 `outcome: "failover"` 记录），没配就按 `onPinFailure` / 宿主自身错误处理。

### 3. @michengai/dsh-agency-agents（1.2.26，专家团）

- **它解决什么**：为 DSH 提供 331 名可召唤的专业智能体（专家团），按名字召唤单个专家或整队专家。
- **组合用法**：`cordis.patch.yml` 的 `agency-agents` 行当前已是 `provider: pinned-account`（本插件注册的包装 provider，委托内置 `spawn`），召唤即经过本插件、按当前配置行钉住路由；本插件 `autoWireAgency` 默认开，挂载时会自动把 profile 里 `agency-agents` 行的 `provider` 补成 `pinned-account`，改前留 `.bak-autowire-*` 备份，装完不需要手改 YAML。按 provider 生效而非按专家名单，`enabled` 列出的 16 个专家、`customExperts`、以后新增的专家只要还读 `config.provider` 就自动命中。
- **冲突或注意事项**：①该行**不要写 `maxDepth`**——写了会强制单发阻塞引擎，召唤要等全部跑完；②profile patch 行是**整行替换 config**，改这行时必须把 `enabled` / `customExperts` / `enabledTeams` 等原字段一起重述，否则会被清空；③若把 `provider` 改回非 `pinned-account`，专家就绕过本插件，路由配置与取证文件里都不会再出现这些 label。

### 4. @deepseek-ai/dsh-subagent-claude-code（0.2.2-rc.1）

- **它解决什么**：基于官方 Agent SDK 的一次性 Claude Code 子代理 provider，让单发子代理跑在该通道上。
- **组合用法**：启用后它作为 provider 出现在 llm 目录，可被委派中枢的提供商/模型下拉选中；选中即意味着单发子代理走 `pinned-account` → 该 provider 的路线，`last-run.json` 的 `route` 字段会记录实际落点。
- **冲突或注意事项**：①当前 profile patch 中 `subagent-claude-code` 与 `tool-subagent-claude-code` 两行均为 `disabled: true`，目录里没有它，要用需先启用；②本插件注入依赖 provider 能力表声明 `agentOptions`（README「接口依赖」表：内置 `spawn` 自带），能力表未声明的 provider 拿不到注入的路由，此时子代理退回继承主 agent 路由，`ready.json` 的 `capabilities` 与日志 `team member label=…` 是判据。

## 二、团队协作类

### 5. @nanmicoder/dsh-agent-teams（0.1.29）

- **它解决什么**：多代理团队协作：captain、成员、带依赖的任务、成员间消息，配 Web GUI 树状监控；本插件的 `dsh-team-status` 面板读的正是它落盘的 `.agent-teams/<teamId>/team.json` 与任务状态。
- **组合用法**：①团队成员不经过 `provider.start()`，本插件在 `ctx.subagents.startActivation`（当前契约）上挂钩子，把路由填进 `request.agentOptions`；②`overrideMemberRoute` 默认开，覆盖它自己的 `memberLlmProvider` / `memberModel`（当前 profile 配 `deepseek-account / deepseek-flash`）——只填「空槽」一个成员也钉不上，开着才钉得住；③settings 文件的 `roles` 按 `team.json` 的 `members[].role` 分角色钉路由，当前 `delivery` profile 的角色为实现者 / 验证者 / 审查者，可分别指向不同模型；④配置了 `failoverRoute` 的成员运行中触发故障切换时，本插件按它的信箱契约（`isTeamMessage`：id/from/to/content/ts）向 `.agent-teams/<teamId>/inbox/captain.jsonl` 追加一条来自 `delegation-hub` 的报告，读全文+重写的原子模式与它自身写入互不丢行。
- **冲突或注意事项**：①两条路由各管各的：关掉本插件的 `teamInjection` 或设 `overrideMemberRoute: false`，就回到它自带的成员路由（后者只补空槽）；②它的 `memberLlmProvider`/`memberModel` 是团队粒度，本插件是逐委派粒度，同时配置时以本插件的优先级链为准（`experts > roles > steps > 配置行 > default`）；③改 `agent-teams` 行同样受整行替换 config 约束，`profiles` / `maxMembers` / `stateDir` 要一并重述；④计划处于暂存（未批准）时成员不启动，这是它自身的调度语义，路由配置再对也看不到成员运行。

### 6. @michengai/dsh-code-review（1.0.8）

- **它解决什么**：Codex 风格代码审查，带原生独立子 Agent、灵活范围选择与中英文报告。
- **组合用法**：它的「原生独立子 Agent」属于单发子代理一类；只要创建路径走 `provider.start()`（README 记载的单发子代理通道），`pinned-account` 包装 provider 直接生效，审查子代理即按配置行路由跑。验证方式：跑一次审查后看 `~/.dsh/delegation-hub.last-run.json` 与 `events.jsonl` 是否出现该 label 及其 `route`。
- **冲突或注意事项**：若它自建 agentOptions 或换用不走 `provider.start()` 的创建方式，本插件不介入——以取证文件为准，不以配置为准；报告语言与审查深度由它控制，本插件只管用哪条模型车道。

## 三、记忆与上下文类

### 7. @a9i5k4/dsh-auto-memory（3.3.17）

- **它解决什么**：主动联想记忆与上下文管理：零提示唤回、三层自动固化、技能固化、交接账本与 PLAN 白板、水位感知，落盘在工作区 `.dsh-memory/` 与用户级 `~/.dsh/memory/`。
- **组合用法**：本插件的三个取证文件是客观事实源，可直接被记忆系统引用——`events.jsonl` 记录每次委派的 label/通道/结果/路由/来源，`ready.json` 记录生效路由与 `drift`，写日志或交接账本时按这些文件陈述，不凭印象；它写 `.dsh-memory/`，本插件写 `~/.dsh/delegation-hub.*`，路径完全不相交。
- **冲突或注意事项**：两者无钩子互调——路由变更不会触发记忆写入，记忆的水位/压缩也不改变子代理路由；本插件不参与上下文裁剪，子代理看到的上下文由宿主与记忆插件决定。

### 8. billion-context（0.1.212）

- **它解决什么**：上下文压缩插件，压缩会话上下文以延长单会话可用时长，附带 acp 压缩缓存与状态工具（`compress` / `decompress` / `acp_status` 等）。
- **组合用法**：它作用于会话上下文层，本插件作用于「创建子代理时填 `agentOptions`」这一层，两者正交——换子代理路由不需要动压缩配置，压缩状态也不影响路由判定。
- **冲突或注意事项**：钉到不同模型会改变子代理的上下文窗口与计费口径（例如从 1M 窗口的 `mimo-v2.6-flash` 换到小窗口模型），压缩阈值仍按宿主与它的配置走，本插件不做窗口适配；子代理会话是否被压缩、压缩后是否可恢复，看它的 `acp_status`，路由对不对看 `ready.json` 的 `drift`。

### 9. dsh-context（0.82.1）

- **它解决什么**：上下文洞察与管理插件，提供上下文仪表盘与 `/context` 类命令，用来理解上下文构成与演化。
- **组合用法**：用它的仪表盘观察主会话与子代理会话的 token 构成；本插件切换子代理路由后，可在同一处对照不同模型车道下的上下文增长，判断该不该给某一步换更便宜的模型（`steps` 配置行就是干这个的）。
- **冲突或注意事项**：仪表盘读的是会话上下文，不显示委派路由判定；路由问题一律以 `last-run.json` / `events.jsonl` / `ready.json` 三件套为准，两边不要混着查。profile patch 中该行是 `dsh-context: disabled: false`（启用）。

## 四、工具链类

### 10. dsh-ops（0.5.0）

- **它解决什么**：Windows x64 / Linux x64 / macOS 上的原生文件与 PTC 工具集，Windows 另带可选 Bash 载荷与宿主 PowerShell 集成。
- **组合用法**：本仓库的文档与检索工作直接用它的工具完成（如 `ops_inspect_local_file` 读 README、`ops_grep` 扫 profile 配置、`ops_glob` 列插件目录）；本机约定：中文字符串检索先落成 `.py` 字节级脚本再执行，不直接 `grep -r` 搜中文。
- **冲突或注意事项**：本机会话中官方 `read` 工具被它替换为 `ops_inspect_local_file`（dsh-ops 行设置），按文件读取会报「standard mode replaced the official tool read」——换工具名即可，不是故障；profile 里 `dsh-ops-bundle` 行 `disabled: true`，而 `dsh-ops-shell` / `dsh-ops-file` 两行 `disabled: false`，功能以实际启用的行准。它与本插件无配置交集。

### 11. dsh-composition-doctor（0.4.0）

- **它解决什么**：从可观测的组合路径解释 DSH 插件加载失败，默认只读、离线，带快照与升级预检。
- **组合用法**：本插件 README 记载的两类「装上了但什么都没生效」——`package.json` 的 `name` 与 profile 依赖键不一致导致 loader 解析不到而静默不加载、`cordis.patch.yml` 行的 `name` 不匹配导致整条被跳过——正落在它的诊断面里；两侧结合排查：它看组合路径，本插件看 `~/.dsh/delegation-hub.load.json`（模块被 import）、`~/.dsh/delegation-hub.ready.json`（宿主激活且 `at` 是本次启动）。
- **冲突或注意事项**：它只读诊断，不改任何配置；「挂载成功」的最终判据仍是本插件的 `npm run ready` / `node test/logs.mjs --strict`，两者结论不一致时以就绪记录为准并对照它的快照找差异。

### 12. dsh-purge（link 安装自 `D:/沈思宏/DSH桌面/dsh-purge-1.1.88`）

- **它解决什么**：提示词层的注入与清洗插件，profile 中以 `insert` 方式加入，`inject: [systemPrompt, tools]`，当前配置 `enabled: true` / `stripMnemon: true` / `capabilityProtocol: true` / `hooksDenyBypass: true`。
- **组合用法**：它动的是 systemPrompt 与 tools 注入层，本插件动的是 `agentOptions` 路由层，两层不重叠——同一会话里提示词按它的规则生效，子代理用哪条模型按本插件的优先级链生效，可同时开。
- **冲突或注意事项**：①两者都通过 profile patch 生效，patch 行整行替换 config，改 `delegation-hub` 行时不要连带改它的行；②排障分层：子代理「用错模型 / 起不来」查本插件三件套，子代理「不守指令 / 被拒答」查它的提示词采样，不要互相甩锅；③它的 `inject` 面作用于会话（含子代理），但不改变本插件的路由判定，也不写 `events.jsonl`。

### 13. @weibaohui/dsh-continue（0.3.12）

- **它解决什么**：自动续跑插件：agent 会话中断后自动续上，有序规则表按失败类型（限流 / 额度 / 鉴权 / 上下文超限 / 崩溃孤儿）路由——自动退避重试、换模型继续、压缩上下文后继续或止损通知，规则可视化编辑，带活动日志。
- **组合用法**：分工明确——它管**会话中断后的续跑**（主会话层面），本插件管**子代理用哪条路由以及运行中的车道故障**：`failoverRoute` 监听 QUOTA / RATE_LIMIT / AUTH / MISSING_CREDENTIAL / NO_ADAPTER 五类车道码，一次性改写被钉住子代理的后续请求并写 `failover` 记录、向 captain 信箱报信；子代理开局就撞墙则由本插件 `fallback`（默认开）按继承路由重试一次。两者串起来覆盖「子代理换车道」与「会话续命」两件事。
- **冲突或注意事项**：两套规则独立配置、互不读取对方的规则表——它的规则表不识别 `failoverRoute`，本插件也不读它的续跑规则；重试次数与退避策略可能叠加（本插件只在启动阶段重试一次且同路由不重试，它按自己的规则表走），排查「为什么重试了这么多次」要两边的日志一起看。

### 14. @michengai/dsh-skills-manager（1.2.35）

- **它解决什么**：在 DSH 中统一加载并安全管理本机 Agent Skills；配套的 `@linxin666/dsh-client-ui-skill-explorer`（0.4.15）在 Web 面板里按来源浏览、启停、新建与删除技能。
- **组合用法**：本插件 `steps` 配置行的「技能」列（逗号分隔）与设置页步骤编辑器里填的技能名，是以**提示前缀**注入子代理首条消息的（形如「优先加载技能 …」）；技能本身能否被加载由技能管理侧决定——先在这两个插件里确认技能已加载/启用，前缀指令才有落点。每步的「专家」列同理，是给子代理的身份前缀。
- **冲突或注意事项**：前缀注入是 Advisory 性质，不动宿主的 persona/skill 机制——技能没装、名字写错时，子代理只会收到一句文字提示，不会报错，`events.jsonl` 里也看不出技能缺失；改技能启停不影响已配置的 `steps` 路由，两者独立。

## 快速索引

| 插件 | 分组 | 组合要点 | 主要注意 |
| --- | --- | --- | --- |
| dsh-our-free-model | 路由与模型通道 | 免费通道进 llm 目录，可直接钉 | 目录变动时按 `strict` / `onPinFailure` 处理 |
| dsh-connect-workbuddy | 路由与模型通道 | 主 agent 车道来源，也可作子代理目标 | 同 provider 时额度共用 |
| @michengai/dsh-agency-agents | 路由与模型通道 | `provider: pinned-account` 已接线 | 不写 `maxDepth`；patch 行整行替换 |
| @deepseek-ai/dsh-subagent-claude-code | 路由与模型通道 | 启用后可作钉住目标 | 当前两行均 `disabled: true`；需能力表声明 `agentOptions` |
| @nanmicoder/dsh-agent-teams | 团队协作 | 钩子注入 + 覆盖成员自带路由 + 角色路由 + captain 信箱报告 | `overrideMemberRoute` / `teamInjection` 决定是否钉 |
| @michengai/dsh-code-review | 团队协作 | 审查子代理走 `provider.start()` 即被捕获 | 以 `last-run.json` 实测为准 |
| @a9i5k4/dsh-auto-memory | 记忆与上下文 | 取证文件作记忆的事实源 | 无钩子互调，路径不相交 |
| billion-context | 记忆与上下文 | 压缩与路由正交 | 换模型后窗口差异不做适配 |
| dsh-context | 记忆与上下文 | 仪表盘对照上下文增长 | 路由判定看三件套 |
| dsh-ops | 工具链 | 文档读写与检索工具 | `read` 被替换为 `ops_inspect_local_file` |
| dsh-composition-doctor | 工具链 | 解释静默不加载的组合路径 | 只读；判据仍是 `npm run ready` |
| dsh-purge | 工具链 | prompt/tools 层与路由层不重叠 | patch 行互不影响；排障分层 |
| @weibaohui/dsh-continue | 工具链 | 会话续跑与子代理车道兜底互补 | 两套规则独立，重试可能叠加 |
| @michengai/dsh-skills-manager | 工具链 | `steps` 技能前缀的落点 | 技能缺失不报错，只体现为文字提示 |
