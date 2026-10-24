# 评估：按"TUI/CLI-only 使用"原则完全移除 v2 相关代码

> 关联 issue：#71（迁移到上游 opencode v2 的代价与决策）、PR #80（任务跟踪）
> 结论先行：**在 fork 只通过 TUI/CLI 使用、不调用 SDK 的前提下，`/api` 路由轨与 V2 会话运行时在产品链路上零消费者，可整体移除（约 19,000–21,000 行 / 100+ 文件）**。同步策略已决（2026-10-22）：fork 与上游实质分叉、不再同步，同步税顾虑消除，直接进入执行（见 §6）。
> 调研日期：2026-10-22，基于 `dev` @ `d9d7de31fb`。

## 0. 调研原则

用户给定的原则：fork 的使用方式只有 TUI / CLI，不调用 SDK。**凡在该场景下无消费者的代码即可假设删除**，然后评估删除的影响。调研方法：从消费者出发反查依赖链（TUI 全量 `sdk.client.*` 调用面逐一映射到 SDK 生成类与实际 URL 路径），而非从代码出发正推。

## 1. 关键发现："v2" 在仓库里是五个不同的东西

直接"删掉所有 v2"不成立——名字带 v2 的东西大部分与 V2 运行时无关：

| # | 层 | 实际是什么 | TUI/CLI 场景判定 |
|---|---|---|---|
| 1 | `@opencode-ai/sdk/v2`（`packages/sdk/js/src/v2`） | **名不副实**：从 `packages/opencode` 的 openapi（V1 运行时）生成，打 `/session/*` 等 V1 路径。TUI、`cli/cmd/run`、acp 全靠它 | **不能删**——这是 V1 产品的 SDK，只是目录名叫 v2 |
| 2 | `EventV2`（`core/src/event.ts`）+ `EventV2Bridge` | **V1 运行时的事件总线**：`opencode/src/session/session.ts:627` 等 V1 代码经它 publish `SessionV1.Event`，桥接到 GlobalBus → TUI 的 `/global/event` | **不能删**——删了 TUI 就聋了 |
| 3 | **V2 会话运行时**：`core/src/session/{runner,execution,input,message-updater,run-coordinator}` + `core/src/session.ts`（SessionV2）+ `core/src/session/compaction.ts` | 真正的 V2 core（`SessionRunner`、`SessionExecution`）。上游写的，fork 零改动 | **可删**（保留项见 §4） |
| 4 | **`/api/*` 路由轨**：`packages/protocol` + `packages/server` handlers + 内嵌 server 挂载（`httpapi/server.ts:301` 挂 `SessionV2.node`） | app 的 "current API"。TUI/CLI 零使用（§2） | **整轨可删** |
| 5 | app 侧双协议层：`server-protocol.ts` 探测 + `server-compat.ts` + `server-session-v2-reducer.ts` | 方向注意：`createV1Api` 是 V1 支持本体，"current"（`/api`）才是 v2 侧 | 随 §5 web UI 决策处理 |

另：41 个文件名带 v2（`settings-v2/`、`prompt-input-v2`、`review-panel-v2`…）纯属 UI 第二代命名，与协议无关，不动。

## 2. 消费者核实：TUI/CLI 对 `/api` rail 零使用

### TUI

TUI 的全部 54 个 `sdk.client.*` 方法逐一比对到 `sdk/js/src/v2/gen/sdk.gen.ts` 的生成类：

- `session → Session2`：25 个端点全打 `/session/*` V1 路径，零 `/api`
- `question`、`permission`、`provider`、`command`、`mcp`、`project`、`pty`、`path`、`vcs`、`find`、`file`、`config` 等命名空间全部是 V1 类（`Question`、`Permission`、`Provider`、`Command`…，均 0 个 `/api` 端点）
- `/api` 端点只出现在 `Session3`、`Question2`、`Permission2`、`Pty2` 等带数字后缀的第二代类里，`OpencodeClient` 的命名空间属性没有一个指向它们
- 连名字最迷惑的 `sdk.client.v2.projectCopy`（`tui/src/component/dialog-move-session.tsx`）实际打 `/experimental/project/*/copy` V1 路径（`ProjectCopy2` 类）
- TUI 没有 PTY 终端面板（`/api` 的 pty 组只有 app 用）

### CLI（`opencode` 包内嵌）

- `cli/cmd/run`、`acp` 的调用面（`session.messages`、`session.promptAsync`、`question.*`、`permission.*`、`app.agents` 等）全走 V1 路径
- `cli/cmd/serve.ts` 起 `Server.listen`（内嵌 server），同双轨；摘除 `/api` 轨后只余 V1 轨，TUI 连接不受影响

### 协议探测的佐证

`app/src/utils/server-protocol.ts` 先探 `/global/health`，fork 内嵌 server 必命中 `{ healthy: true }` → app 连 fork server 恒走 v1 模式。`/api` rail 对 fork 自家产品链路无消费者。

## 3. 升级为"整包可删"的清单

| 包 | 行数 | 唯一消费者 | 结论 |
|---|---|---|---|
| `packages/sdk-next` | 68 | 无（全仓 0 引用） | 删 |
| `packages/cli`（lildax） | 705 | 无（fork 不发布；其 `serve` 是 standalone V2 rail 唯一入口） | 删 |
| `packages/client`（workspace） | 4,643 | 仅 sdk-next 声明依赖（app/session-ui 用 `vendor/opencode-ai-client-1.17.13-v2.tgz`，独立） | 删，连带 CI `check:generated` 步骤 |
| `packages/protocol` | 1,582 | 仅 `/api` rail | 随轨删 |
| `packages/server` | 1,682 | standalone rail + 被 opencode 引用的共享件（`cors`、`location`、`middleware/session-location`、`pty-environment`） | 删主体；四个共享件内联进 opencode |
| `packages/core` 的 V2 工具 `core/tool/`（含 fork 已在 V1 侧删除的 apply_patch 副本） | — | 仅 V2 runner 的 `BuiltInTools`；V1 工具在 `opencode/src/tool/`，零 import | 删 |
| core V2 运行时 + 测试 | ~6,500 + ~6,200 | 仅 `/api` rail 的 session/message handler 与 sdk-next | 删（保留项见 §4） |
| app 侧 `server-session-v2-reducer.ts` + `httpapi-session.test.ts` 的 24 处 `/api` 断言 | ~500 | app v2 协议模式 | 删 |

**合计约 19,000–21,000 行 / 100+ 文件。**

## 4. 必须保留的 V2 件（上轮评估的修正）

### 4.1 隐藏依赖链：TUI move-session 消费 V2 投影产物

```
TUI move.tsx（tui/src/component/prompt/move.tsx）
  → POST /experimental/control-plane/move-session（V1 路径）
  → core control-plane/move-session.ts
  → SessionStore.context
  → SessionHistory.load
  → 读 projector 写入的归一化表（session_message + session_context_epoch）
```

这条链是 **V1 运行时在消费 V2 投影器（`SessionProjector`）持续写入的数据**。因此以下 V2 件不能删：

- `EventV2` 总线（`core/src/event.ts` + `event/sql.ts`）+ `EventV2Bridge`
- `SessionProjector` + 归一化表 DDL/migration（38 个 migration 的 journal 不能动）
- `SessionStore` / `SessionHistory` / `SessionContextEpoch`
- `core/session/compaction.ts` 的 `buildPrompt`（被 `opencode/session/compaction.ts:23` import——先内联过去，再删文件）
- `core/src/v1/`（是 V1 wire schema 定义，不是 V2 运行时）
- `core/session/sql.ts` 中 V1 在用的 `SessionTable/MessageTable/PartTable/TodoTable`

**可选后续改造**：move-session 改读 V1 的 `MessageTable/PartTable`（`MessageV2` 已有同构读取逻辑），改完后 `SessionProjector/SessionStore/SessionHistory/SessionContextEpoch` 也可删，再省约 1,100 行。表 DDL 仍保留（已发布用户库的 migration journal 不能动）。

### 4.2 `location-services.ts` 的摘除方式

`core/src/location-services.ts` 是共享服务目录（V1 经 `LocationServiceMap` + 惰性 `LayerMap` 使用）。删 V2 运行时时从目录条目中摘除 V2 专属项即可：

- 可摘：`SessionRunnerModel.node`、`SessionRunnerLLM.node`、`SessionTodo.node`、`BuiltInTools.node`（已核实这些仅在目录中被引用，无其他共享消费者）
- 必须留：`Location`、`Config`、`AgentV2`、`FileSystem`、`Pty`、`SkillV2`、`PermissionV2` 等其余条目（V1 会话 boot 依赖）

## 5. 联动决策：web UI 的去留

`/api` rail 整体摘除后，app 的 `createV1Api` 未覆盖的命名空间（mcp/question/fs 等 spread 自 `/api` client）会 404——web UI 连 fork server 部分降级。TUI/CLI-only 场景下这不重要，二选一：

- **方案 A（最小动作）**：构建改用现成的 `--skip-embed-web-ui` flag（`opencode/script/build.ts:24`），app 留在树里仅作开发工件（其编译用 vendor tgz，不受 workspace client 删除影响）
- **方案 B（更彻底）**：连同 app/session-ui/ui/desktop/storybook 等前端包一起砍——量级另计，建议作为独立后续 issue

## 6. 同步策略（已决，2026-10-22）

**决策：fork 已与上游实质分叉，不再考虑与上游同步。** 本节原以"同步税"作为删除与否的决定性因素，记录如下作为背景：

调研时把上游同步税列为首要风险——fork 此前每轮 sync 上游 dev（最近一次 2026-09-20），删除面变大后每轮 sync 的 modify/delete 冲突会更多（这类冲突 git 处理成本低，`git rm` 即可），真正的风险是保留件（`schema/`、`v1/`、`EventV2` 总线）被上游重构牵连出需要理解两边语义的真冲突。因此当时结论是"先定同步策略，再决定是否执行删除"。

2026-10-22 用户确认：**fork 与上游已实质分叉，不再同步。** 该顾虑整体消除：

- 保留件今后完全由 fork 自主演进，不存在被上游重构牵连的问题
- modify/delete 冲突不复出现
- 原"继续全量 sync → 不删"分支作废，删除方案的代价收益单边化：CI 每轮少跑约 12,700 行死代码测试、bundle 更小、CLAUDE.md 约三分之一注意事项作废、投影器不再写无人读的表

执行跟踪在 PR #80。

## 7. 建议实施顺序（每阶段独立可回归）

> **实施修订（2026-10-22，方案 B → C）**：执行阶段 2 时发现本节原方案低估了一处消费者——TUI 的 `data.tsx` 快照层经 `sdk.client.v2.<ns>.<method>` 双层调用消费 `/api` rail 的 9 类只读端点（§2 的消费者正查只匹配了单层 `sdk.client.<ns>` 形态，漏掉这批）。完整把 TUI 快照层迁到 V1 端点的方案（B）执行受挫后回滚，用户改选 **C 方案：最小保留面**——不迁移，只重建 TUI 实际承重的 3 个只读端点（`/api/location`、`/api/reference`、`/api/fs/find`，autocomplete 与 location key 承重），其余 6 类确认零 TUI 读者后随快照域一并删除；`data.tsx` 缩减至 reference 快照。协议包与 server 包整体删除不变（3 端点直接实现在内嵌 server 的 V1 groups 里，wire 形状与既有 SDK 契约一致）。下述阶段 2 的"摘 rail + 删 V2 运行时"表述仍适用于 C，仅"四个共享件内联"扩为实际发生的内联（cors、pty-environment；`ServerAuthorization` re-export 零消费者直接删）。

1. **阶段 1（零风险）**：删 `packages/sdk-next`、`packages/cli`、`packages/client`、core V2 测试——纯零消费者，typecheck/test 即可验证
2. **阶段 2**：摘内嵌 server 的 `/api` rail（`packages/protocol` + `packages/server` 主体 + `httpapi/server.ts` 的 `ServerApi` 挂载与 `SessionV2.node` + `makeApi` 引用）+ 四个共享件内联 + 删 `core/tool`、core V2 运行时（保留 §4 清单；`buildPrompt` 内联）。C 方案修订：rail 摘除以"重建 3 端点"收尾，protocol/server 整包删除
3. **阶段 3（可选）**：move-session 改读 V1 表 → 删 projector 链；web UI 按 §5 决策处理

## 8. 保留项不动的原因详解

对 PR 跟踪清单"执行约束"前四条逐条展开。

### 8.1 38 个 DB migration journal 不能动（表 DDL 保留）

**机制**：迁移注册表 `database/migration.gen.ts` 按文件名顺序静态 import 全部 38 个迁移，runner（`database/migration.ts`）用**文件里的 `id` 字符串**与用户数据库的 `migration` 表（`id TEXT PRIMARY KEY`）做差集——只执行用户库没记录过的迁移。

**为什么不能动**：

- 已发布版本（`v1.18.25-fmv1`、`v1.18.31-fmv2` 等）的用户库已把这 38 个 id 记入 `migration` 表。删掉某个迁移文件对老用户无感（id 已在表里，runner 跳过）；但若删的是**建表**迁移，新装用户从零建库时注册表少一项 → `session_message`/`event` 等表不会被创建 → 保留代码（`SessionProjector` 写 `session_message`、`MoveSession` 读它、`EventV2` 写 `event` 表）启动后第一次写入即崩。
- 兼容路径：`migration.ts:48-68` 专门处理从 Drizzle 老 journal（`__drizzle_migrations` 表）升级来的用户，seed 逻辑按 id 匹配。动历史迁移 id 会让这批用户的 journal seed 失配，已执行 SQL 被重放——例如 `20260622170816_reset_v2_session_state` 会**清空** `session_message`/`event`/`workspace` 等表的数据。
- **结论**：迁移文件是用户数据的不可变历史。删除 V2 运行时（写入方）≠ 删除表（数据的家）。空表零成本（SQLite 几十 KB），删了要么崩新装要么毁老库。表清理属于"未来某天出 fork 自有存储格式"的范畴，不在本次代码删除内。

### 8.2 `core/src/v1/` 是 V1 wire schema，不是 V2 运行时

**这是全调研最容易误判的一条**：目录名的 `v1` 指"V1 协议的数据格式定义"，不是"第一代实现"。

核实依据：

- `core/src/v1/session.ts`（68 行）只有 schema 与错误类型——`export {...} from "@opencode-ai/schema/session-v1"` 加 `NamedError.create` 定义（`ContextOverflowError`、`APIError` 等），无任何运行时逻辑。
- 消费它的 28 个 `packages/opencode` 文件全是 V1 核心代码：`session/message-v2.ts`（消息持久化格式）、`session/processor.ts`（会话循环）等。
- `packages/schema/src/event-manifest.ts:35-36` 直接从 `SessionV1.Event.Definitions` 构建整个事件清单（durable/live 两类）；V1 运行时经 `EventV2Bridge` publish 的正是这些 `SessionV1.Event.*` 事件 → GlobalBus → TUI `/global/event`。
- TUI 消费 `session.updated`、`message.part.updated` 等事件的类型就来自这条链（`tui/src/context/sync.tsx`、`routes/session/index.tsx`）。

**删了会怎样**：V1 运行时无法定义消息/事件格式，TUI 收不到事件，typecheck 直接失败。它与 `packages/schema` 一体，属产品地基。

### 8.3 `@opencode-ai/sdk/v2` 目录名带 v2 但实为 V1 产品 SDK

三层证据：

- **生成源**：`sdk/js/script/build.ts:14` — `bun dev generate > openapi.json`，`cwd(opencode)` 即从 `packages/opencode`（V1 运行时路由）导出 openapi（162 个路径中 111 个非 `/api` 前缀）。
- **URL 逐个验证**：`sdk/js/src/v2/gen/sdk.gen.ts` 中 `Session2` 类 25 个端点全部是 `/session/*`；`/api/*` 端点只在 `Session3`、`Question2` 等另一组类里。目录名 "v2" 是上游生成器升级时的命名残留（hey-api 输出目录 `src/v2/gen`），不是协议代际。
- **消费者**：TUI 的 `sdk.tsx:1`、`cli/cmd/run`、acp 全 import 它；TUI 54 个 `sdk.client.*` 方法逐个映射后零 `/api` 调用。

**删了会怎样**：TUI 与 CLI run 模式失去全部 HTTP 客户端，产品不可用。真正与 V2 相关的是生成物里的 `/api` 类（`Session3` 等 58 个端点），随阶段 2 摘 rail 时把生成器 contract 源改掉后重新生成。

### 8.4 41 个文件名带 v2 的 UI 文件与协议无关

这些 "v2" 是 **UI 组件第二代**命名：

- `packages/ui/src/v2/`——纯组件库目录（components/styles），不 import 任何协议/HTTP 代码
- `settings-v2/dialog-settings-v2.tsx` 的 import：`solid-js`、`@opencode-ai/ui/v2/dialog-v2`、`TabsV2`——引用的是 UI 第二代组件
- `session-ui/src/v2/components/*`（31 个文件）、`review-panel-v2`、`prompt-input-v2` 同理：指"这一代 UI 组件"，与 server API 轨、`SessionV2` 服务无任何 import 关系

**删了会怎样**：纯 UI 回归，且在 web UI 去留（阶段 3）决策前它们仍在编译链里，删了 typecheck 直接失败。其去留跟 web UI 决策走，不跟 V2 协议删除走。

### 8.5 共同判定原则

这四条里 "v2" 字样的来源各不相同：**数据格式代际**（V1 wire schema）、**生成器输出目录名**（`sdk/js/src/v2`）、**UI 组件代际**（`ui/v2`）。真正待删的"V2 协议"只有 `core/src/session` 运行时与 `/api` 路由轨。文件名/目录名的字面 v2 不可作为删除依据——这正是本调研从消费者反查、而非按名字正删的原因。

## 附：核实过的事实清单（供实施者复核）

- TUI 无 `/api` 调用：`sdk.gen.ts` 中 `/api` 端点全部位于 `Session3`/`Question2`/`Permission2`/`Pty2` 等类，`OpencodeClient` 属性只暴露 V1 类
- `opencode/src/session/session.ts:14` 的 `SessionExecutionLocal` import 是死 import（0 使用点）
- `opencode/src/session/prompt.ts` 从 core runner 仅 import 常量 `MAX_STEPS_PROMPT`
- fork 对 `packages/core/src/session` 零改动（`git diff ebb7b76eca..HEAD` 为空）；仅动过 `v1/config` 两处（`subagent_depth` 描述、`agent*` permission 字段）
- `core/tool/`（V2 工具）与 `opencode/src/tool/`（V1 工具）两套独立，`packages/opencode` 零处 import `core/tool`
- `SessionRunnerModel/SessionRunnerLLM` 仅被 `location-services.ts` 引用
- app/session-ui 的 client 依赖是 `file:vendor/*.tgz`，与 workspace `packages/client` 无关
- 协议选择：app v1 模式下 `createV1Api` 覆盖 session/project/vcs/file/integration/pty，其余 namespace spread 自 `/api` client（rail 删除后的降级点）
