# 修正方案 — session：session.abort 级联取消全部子 agent job（esc 团灭后台子 agent）

> 对应 issue #87 第 1 点（lihaokun/opencode）。按 workflow §7.1 八部分组织；第一至五部分修复前完成，第六至八部分修复前列计划、修复后回填。

## 第一部分：现象与复现

### 现象

TUI 中主 agent 运行时按两次 esc（5 秒内）打断本轮 run，所有正在后台运行的子 agent **同时被取消**，而不是继续在后台运行。用户预期：esc 只打断主 agent 本轮，子 agent 的结果照常回填父会话。

### 最小复现用例

1. 主会话发起 prompt，模型回复中调用 `agent` 工具启动子 agent（delegation job 在后台跑）
2. 主 agent 继续跑（或 hang 在 LLM 流上）
3. 调 `POST /session/{parentID}/abort`（即 esc 两次的落点）

预期：父会话 runner 被取消、本轮 assistant 以 aborted 收尾；子 agent job `status === "running"` 不变，完成后经 `reportRunEnd` 通知父会话。
实际（修复前）：子 agent job 一并变为 `cancelled`，收尾通知变成取消路径。

### 出错代码路径

- `packages/tui/src/config/keybind.ts:97` — `escape` → `session.interrupt`
- `packages/tui/src/component/prompt/index.tsx:438-449` — 双击判定 → `sdk.client.session.abort`
- `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts:246-249` — abort handler → `promptSvc.cancel(sessionID)`
- `packages/opencode/src/session/prompt.ts:175-178` — `SessionPrompt.cancel` → `state.cancel`
- `packages/opencode/src/session/run-state.ts:81-89` — **根因点**：`SessionRunState.cancel` 无条件先调 `cancelBackgroundJobs`
- `packages/opencode/src/session/run-state.ts:117-149` — `cancelBackgroundJobs` 沿 `metadata.parentSessionId` / `metadata.sessionId` **传递扩散**，取消整棵子树的 running job
- `packages/opencode/src/agent-management/lifecycle.ts:284-290` — delegation job 的 `id` 即子会话 id、`metadata.parentSessionId` 指向父会话，因此扩散必然命中全部子 agent

### 预期行为 vs 实际行为

- 预期：abort 语义 = 「停掉这个会话自己的当前 run」；子 agent 生命周期只由显式入口（`agent_stop` 工具、删除会话）管理
- 实际：abort 隐式承担了 `agent_stop` 的「停整棵子树」语义

## 第二部分：根因分析

**症状**：esc 后子 agent 全部消失。

**根因**：`SessionRunState.cancel` 把两种不同语义捆在一个入口里——

1. **abort 语义**（HTTP `session.abort`，esc）：只停该会话的 runner；
2. **teardown 语义**（`agent_stop`、删除会话）：停掉该会话及其后代的一切在跑工作。

`cancelBackgroundJobs` 的 transitive 扩散是给 teardown 语义写的，但 abort 路径复用了同一函数且无开关。子 agent 的 job fiber fork 在 `BackgroundJob` 的独立 scope 里（`packages/core/src/background-job.ts:162-177`），父 runner 的 `Fiber.interrupt` 本身**传不到**它——级联完全来自 `cancelBackgroundJobs` 这一步。把它从 abort 路径摘掉即恢复正确语义，父 runner 中断时 `agent` 工具 part 照常标 `Cancelled`（`prompt.ts:438-457` 的 `onInterrupt`），子 job 不受影响。

**对照（参考实现）**：`AgentLifecycle.stop`（`lifecycle.ts:401-465`）是仓库内「有意级联」的规范实现——它自己经 `tree.descendants` 枚举整棵子树、逐层显式 cancel。这说明级联应该由**调用方显式要求**，而不是 `cancel` 默认隐含。本修复消除根因（拆开两种语义），不是绕过。

**不是根因的候选**（已排除）：

- `Runner.cancel`（`effect/runner.ts:200-231`）只动本会话 fiber，无辜；
- `startDelegation` 的 `Effect.onInterrupt(() => ops.cancel(child))`（`lifecycle.ts:264`）只在 job fiber 自身被中断时触发，abort 不触碰 job fiber；
- TUI 双击判定（`prompt/index.tsx:444`）只是触发方式，改它治标。

## 第三部分：参考实现对照

同上：`AgentLifecycle.stop` 显式枚举 + 显式 cancel vs `SessionRunState.cancel` 隐式扩散。同一输入（对父会话发起停止）：

- `agent_stop`：枚举子树 → 逐成员 `runState.cancel(member)` → 每个成员自身的 job（`job.id === member` 或 `metadata.sessionId === member`）都被取消，后代因被枚举为成员同样被取消 → 整树停止，**不依赖 transitive 扩散**（扩散在逐成员 cancel 下是冗余覆盖）。
- abort（修复后）：只 `cancel(sessionID, { cascade: false })` → 只停 runner，job 不动。

差异点即根因：唯一的 transitive 扩散调用在 `run-state.ts:82`，且被 abort 共享。

## 第四部分：修复方案

修什么（三处，全部向后兼容的可选参数）：

1. `packages/opencode/src/session/run-state.ts` — `cancel(sessionID, options?: { cascade?: boolean })`：`cascade === false` 时跳过 `cancelBackgroundJobs`。**默认 `true`**（保持今天的行为，改动面最小）。
2. `packages/opencode/src/session/prompt.ts` — `SessionPrompt.Interface.cancel` 增加同样的可选参数并透传；`AgentPromptOps.cancel`（`lifecycle.ts` 消费的窄接口）不改，实现处照旧单参。
3. `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts:247` — abort handler 显式传 `{ cascade: false }`。

为什么这样修：abort 的 HTTP 入口是「打断这个会话」的唯一语义来源；把级联开关放在 `SessionRunState.cancel` 上、由 teardown 类调用方（`agent_stop`、workspace warp）继续用默认级联，abort 单点关闭，两种语义各归各位。

各调用方修复后的行为：

| 调用方 | 传参 | 行为 |
|---|---|---|
| HTTP `session.abort`（esc / IDE abort） | `{ cascade: false }` | 只停本会话 runner（**本次修复**） |
| `AgentLifecycle.stop`（agent_stop 工具） | 不变（默认级联） | 逐成员 cancel + 扩散，整树停止 |
| `Session.remove` → `Session.cancelBackgroundJobs`（`session.ts:1042-1057`） | 不经过 runState | 删除时逐层递归取消，不变 |
| workspace warp（`control-plane/workspace.ts:584`） | 不变（默认级联） | 迁移时停本地在跑工作，不变 |

修改后的预期行为（用复现用例走一遍）：abort 后父 runner 中断、assistant message 记 `MessageAbortedError`；子 job `running` 不变；子完成后 `reportRunEnd` 发布 `Agent completed: …` 并唤醒父会话（#53 已打通的 parent wake 通道）。

**范围声明**：本修复只动 TUI/CLI 实际走过的 V1 链路（`SessionPrompt`）。`packages/core` 的 V2 `SessionRunner` 是平行 runtime，产品主路径零 V2 消费者（见 CLAUDE.md 已知限制），本issue 不涉 V2；若日后 app/serve 启用且发现同型级联，另行开单。

## 第五部分：正确性论证

1. **根因消除**：级联的唯一来源是 `run-state.ts:82` 的无条件 `cancelBackgroundJobs`；abort 路径跳过它后，扩散链不复存在。子 job 的取消只剩显式入口（`agent_stop` 逐成员、`remove` 逐层递归、job 自身完成/失败），语义各自成立。
2. **不变量保持**：
   - `SessionRunState.cancel` 的 post（runner 转 Idle、status 置 idle/继续清理）不受影响——跳过的只是前置的 job 扫描，`existing.cancel` 分支逐字未动。
   - `cancelBackgroundJobs` 本体保留且签名不变，teardown 调用方行为逐字节等价。
   - `BackgroundJob.cancel` 幂等（`background-job.ts:294`：非 running 直接返回快照），`agent_stop` 下「逐成员 cancel + 扩散重叠」的双重取消无副作用，维持现状。
   - abort 后父会话 `assertNotBusy` 恢复可用、可重新 prompt——runner 分支未动，天然保持。
3. **无回归引入**：依赖第六部分用例 (a)(b)(c)(d)；其中 (c) 直接锁定 `agent_stop` 整树停止的既有断言（`test/agent-management/lifecycle.test.ts` "cancels the whole subtree and reports every member" 继续绿），(d) 锁定 `remove` 级联。

## 第六部分：测试用例清单（计划）

| 类型 | 用例描述 | 状态（修复后回填） |
|------|---------|------------------|
| 回归 | `test/session/prompt.test.ts`：父会话 loop hang 在 LLM，注册 `metadata.parentSessionId = parent` 的 running job；`prompt.cancel(parent, { cascade: false })` → job 仍 `running`，父会话 runner 已 idle | 待加 |
| 新增 | 同上但默认参（不传 options）→ job 被 `cancelled`（级联默认保持，锁 teardown 语义不回退） | 待加 |
| 新增 | `lifecycle.stop` 整树级联负例：既有 "cancels the whole subtree" 断言不修改、保持绿 | 待复跑 |
| 新增 | abort 后子 delegation 完成仍回填父会话（经 lifecycle.create 真实 delegation：abort 父 runner → 放行子 job → 父收到 `Agent completed` 通知消息） | 待加 |

## 第七部分：代码更新清单（计划）

| 文件 | 函数 / 行号 | 改动概述 | 状态（修复后回填） |
|------|------------|---------|------------------|
| `packages/opencode/src/session/run-state.ts` | `cancel`（LL81-90） | 增加 `options?: { cascade?: boolean }`，false 时跳过 `cancelBackgroundJobs` | 待改 |
| `packages/opencode/src/session/prompt.ts` | `Interface.cancel`（LL110）+ `cancel`（LL175-178） | 签名加可选参数并透传 | 待改 |
| `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts` | `abort`（LL246-249） | 传 `{ cascade: false }` | 待改 |
| `packages/opencode/test/session/prompt.test.ts` | 新用例 | 第六部分 (a)(b)(d) | 待改 |

## 第八部分：文档更新清单（计划）

| 文档路径 | 要改什么 | 状态（修复后回填） |
|---------|---------|------------------|
| `docs/devlog/2026-10-28-tui-esc-exit-message-menu.md` | 三合一修复 devlog（含度量段） | 待加 |
| 无契约文档涉及 — `SessionRunState.cancel` / `SessionPrompt.cancel` 的旧签名行为（无条件级联）未见任何 design/spec 文档声明；新增可选参数为纯扩展。 | — | — |
