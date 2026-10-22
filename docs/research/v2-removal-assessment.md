# 评估：按"TUI/CLI-only 使用"原则完全移除 v2 相关代码

> 关联 issue：#71（迁移到上游 opencode v2 的代价与决策）
> 结论先行：**在 fork 只通过 TUI/CLI 使用、不调用 SDK 的前提下，`/api` 路由轨与 V2 会话运行时在产品链路上零消费者，可整体移除（约 19,000–21,000 行 / 100+ 文件）**。真正的前置决策不是技术而是上游同步策略（见 §6）。
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

## 6. 决定性因素：上游同步税

fork 每轮 sync 上游 dev。删除面变大（四个整包 + core 运行时）后，每轮 sync 的 modify/delete 冲突会更多——但这类冲突 git 处理成本低（`git rm` 即可）。真正的风险是**保留件与上游改动交叉**：`schema/`、`v1/`、`EventV2` 总线这些保留件若上游重构（v2 线调整共享 event manifest 等），会出现需要理解两边语义的真冲突。

- 若 fork 决定**长期独立演进**（少同步/只挑拣）→ 按本方案删，收益实在：CI 每轮少跑约 12,700 行死代码测试、bundle 更小、CLAUDE.md 约三分之一注意事项作废、投影器不再写无人读的表
- 若 fork **仍打算定期全量同步** → 不删。保留的代价（CI 时间 + bundle 几十 KB）低于每轮解决冲突与保留件被牵连重构的风险

**先在 #71 定同步策略，再决定是否执行删除。**

## 7. 建议实施顺序（每阶段独立可回归）

1. **阶段 1（零风险）**：删 `packages/sdk-next`、`packages/cli`、`packages/client`、core V2 测试——纯零消费者，typecheck/test 即可验证
2. **阶段 2**：摘内嵌 server 的 `/api` rail（`packages/protocol` + `packages/server` 主体 + `httpapi/server.ts` 的 `ServerApi` 挂载与 `SessionV2.node` + `makeApi` 引用）+ 四个共享件内联 + 删 `core/tool`、core V2 运行时（保留 §4 清单；`buildPrompt` 内联）
3. **阶段 3（可选）**：move-session 改读 V1 表 → 删 projector 链；web UI 按 §5 决策处理

## 附：核实过的事实清单（供实施者复核）

- TUI 无 `/api` 调用：`sdk.gen.ts` 中 `/api` 端点全部位于 `Session3`/`Question2`/`Permission2`/`Pty2` 等类，`OpencodeClient` 属性只暴露 V1 类
- `opencode/src/session/session.ts:14` 的 `SessionExecutionLocal` import 是死 import（0 使用点）
- `opencode/src/session/prompt.ts` 从 core runner 仅 import 常量 `MAX_STEPS_PROMPT`
- fork 对 `packages/core/src/session` 零改动（`git diff ebb7b76eca..HEAD` 为空）；仅动过 `v1/config` 两处（`subagent_depth` 描述、`agent*` permission 字段）
- `core/tool/`（V2 工具）与 `opencode/src/tool/`（V1 工具）两套独立，`packages/opencode` 零处 import `core/tool`
- `SessionRunnerModel/SessionRunnerLLM` 仅被 `location-services.ts` 引用
- app/session-ui 的 client 依赖是 `file:vendor/*.tgz`，与 workspace `packages/client` 无关
- 协议选择：app v1 模式下 `createV1Api` 覆盖 session/project/vcs/file/integration/pty，其余 namespace spread 自 `/api` client（rail 删除后的降级点）
