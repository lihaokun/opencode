# 修正方案 — `session: incomplete provider stream recovery`

- 状态：已完成第二轮契约审计的草案，等待确认；尚未修改实现
- 日期：2026-08-06
- 对应问题：[lihaokun/opencode Issue #7](https://github.com/lihaokun/opencode/issues/7)
- 前置修复：[Issue #3 修正方案](./session-fix-incomplete-provider-stream.md)
- 当前基线：`dev` / `49fa19830d`
- 计划中的契约子计划 ID：`session-1-incomplete-stream-recovery`

术语：本文统一称两套实现为 **legacy Session** 与 **current Session**；Issue #7 原文中的 “V2” 即
current `SessionRunner`。引用现有测试名或历史文档时可保留其 V2 字样。

## 一、现象与复现

### 1.1 现象

Issue #3 已保证缺少可信 terminal finish evidence 的 provider stream 不会再被当作成功；当前
Issue #7 的问题是该失败一律进入 fail-stop，无法根据本轮是否已有工具副作用选择安全恢复路径。

当前 legacy 路径为：

```text
AI SDK finish-step(other, rawFinishReason=undefined)
  -> step-finish(reason=unknown)
  -> provider-error(retryable=false, no classification)
  -> SessionProcessor throws Error(message)
  -> MessageV2.fromError => UnknownError
  -> SessionProcessor returns stop
  -> Prompt sees persisted assistant error and exits
```

current Session 路径为：

```text
LLMEvent.provider-error
  -> publisher immediately emits Step.Failed
  -> runner suppresses Step.Ended and returns needsContinuation=false
  -> no automatic retry / tool continuation
```

### 1.2 触发条件

核心触发条件：

1. provider/gateway 已开始交付本次 provider turn；
2. stream 在可信 terminal finish event 前结束，或 consumer 在正常 drain 后发现没有可信 step
   settlement；
3. adapter/runner 将该事实识别为 `incomplete-stream`；
4. 当前 attempt 可能只有 partial reasoning/text，也可能已有零个或多个 tool call/result。

生产环境中的典型触发是稳定 stream deadline 或中途 EOF。本文的确定性本地复现从 opencode 可见的
event 边界开始，不模拟特定网关内部的 TCP 时序。

### 1.3 影响范围与频次

- 对满足上述条件的 mock stream 为必现；
- legacy 顶层 Prompt、Task/subagent、structured output、compaction 共用 `SessionProcessor`，但 Prompt 与
  compaction 是两个独立 caller；只修改 Prompt 不能覆盖 summary recovery；
- current `SessionRunner` 对 provider-error 已明确 fail-stop；对成功 drain 但没有 step settlement 的流还可能
  直接返回，无 durable `Step.Ended`/`Step.Failed`；
- 长任务在固定 provider deadline 下会重复遇到，导致必须由用户手动发消息恢复；
- 不能通过无条件 replay 修复，因为已执行的本地或 provider-executed 工具可能有非幂等副作用。

### 1.4 最小复现用例与实测

2026-08-06 使用 Bun `1.3.14` 在 `yixiao-issue-7` / `49fa19830d` 上运行现有窄测试。测试全部通过，
因为它们锁定的正是当前 fail-stop 行为：

复现命令统一为：进入表中测试文件所属 package，执行
`/home/yixiao/.npm/_npx/60c3515df86f25b1/node_modules/.bin/bun test <package-relative-file> --test-name-pattern '<name>'`。

| 场景                                                 | 测试文件                                                  | `--test-name-pattern`                                                              | 当前观测                                                                |
| ---------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| legacy：partial text，无工具                         | `packages/opencode/test/session/prompt.test.ts`           | `loop preserves partial text and stops on a missing terminal finish`               | provider hit = 1；保留 partial text；assistant=`UnknownError`；停止     |
| legacy：本地工具已完成，后一 provider turn 截断      | `packages/opencode/test/session/prompt.test.ts`           | `loop does not replay a completed tool after a later missing terminal finish`      | provider hit = 2；工具副作用只发生 1 次；没有第 3 次 continuation       |
| legacy：retry policy                                 | `packages/opencode/test/session/retry.test.ts`            | `does not retry the canonical incomplete-stream unknown error`                     | `SessionRetry.retryable(...) === undefined`                             |
| current：本地工具已结算后 provider error             | `packages/core/test/session-runner.test.ts`               | `does not continue automatically after a provider error follows a local tool call` | request = 1；工具执行 1 次；没有 continuation                           |
| legacy：失败 assistant 投影                          | `packages/opencode/test/session/message-v2.test.ts`       | `filters assistant messages with non-abort errors`                                 | 整条 assistant 从下一轮模型上下文删除，包括已结算 tool result           |
| legacy：未结算工具 cleanup                           | `packages/opencode/test/session/processor-effect.test.ts` | `session.processor effect tests mark pending tools as aborted on cleanup`          | pending/running 被改写为 `error`，附 `metadata.interrupted=true`        |
| current：provider-executed 工具无 result             | `packages/core/test/session-runner.test.ts`               | `durably fails a hosted tool when its provider errors before returning a result`   | 工具被持久化为 error；runner 停止；无明确 unresolved-tool recovery 诊断 |
| legacy compaction：partial summary，无 settled step  | `packages/opencode/test/session/compaction.test.ts`       | `keeps a summary without a settled model step out of completed compactions`        | partial summary 保留为 failed；`result=stop`；不会新建 summary attempt  |
| legacy StructuredOutput：tool 已完成但 terminal 缺失 | `packages/opencode/test/session/prompt.test.ts`           | `high-usage missing finish prevents StructuredOutput promotion and compaction`     | tool result 已持久化；旧 structured 不提升；无 continuation/retry       |

测试结果：9 pass、0 fail（九个 test-name filter 独立运行）。关键复现事实：

```text
SafeRetry 候选（无 tool）         -> 0 次自动 retry
ContinueAfterSettledTools 候选    -> 工具未重复（正确），但 0 次 continuation
ManualStop 候选（unsettled tool） -> 停止，但 assistant error 不列出 call id/name/original state
Compaction SafeRetry 候选          -> failed partial summary 后直接 stop
```

### 1.5 出错代码路径

#### Legacy

```text
packages/opencode/src/session/llm/ai-sdk.ts::toLLMEvents
  -> provider-error lacks classification; retryable=false
packages/opencode/src/session/processor.ts::handleEvent(provider-error)
  -> throw new Error(value.message), discarding classification/retryable
packages/opencode/src/session/processor.ts::process
  -> Effect.retry wraps the same SessionProcessor + assistant message
  -> UnknownError is not retryable, halt persists assistant error
packages/opencode/src/session/prompt.ts::runLoop
  -> error-first guard breaks before tool continuation
packages/opencode/src/session/message-v2.ts::toModelMessagesEffect
  -> non-abort errored assistant is removed wholesale
```

#### Current Session

```text
packages/core/src/session/runner/llm.ts::runTurnAttempt
  -> provider-error is published immediately
packages/core/src/session/runner/publish-llm-event.ts::publish
  -> failAssistant emits Step.Failed before recovery evidence is fully classified
packages/core/src/session/runner/llm.ts::runTurnAttempt
  -> needsContinuation = !hasProviderError && needsContinuation
packages/core/src/session/runner/to-llm-message.ts::assistant
  -> if a failed assistant were continued naively, partial text/reasoning and tools would all be replayed
```

### 1.6 预期行为

同一个纯决策函数使用 failure boundary 上的工具事实，将 `incomplete-stream` 分成：

```text
SafeRetry
  = 没有已观察到的完整 tool call/provider-executed/started-tool evidence，事实持久化完整，
    并且重试预算未耗尽

ContinueAfterSettledTools
  = 至少一个完整 tool call，且每个 call 的 input + terminal result/error 已持久化

ManualStop
  = blocked / persistence failure / pending or running / hosted side effect 无 terminal result /
    部分工具结算 / 重试预算耗尽
```

所有路径都必须保留原 failed/incomplete assistant 作为审计事实。SafeRetry 和 continuation 均创建新的
assistant message ID；旧 partial prose/reasoning 不进入新请求；已结算工具不得重新执行。

这里的 SafeRetry 是**基于可观察协议前缀的安全判断**，不是对远端物理世界的全知保证。若 provider 在
任何 tool event 到达客户端前已经执行 hosted side effect，断流后客户端无法从本地 transcript 证明其
存在。本方案显式依赖 4.8 的关键假设；它能保证 opencode 不重放任何已观察/已持久化的工具调用，但不能
把网络分区下不可观测的远端执行提升为 exactly-once。

## 二、根因分析

### 2.1 直接症状与根因区分

直接症状是 Prompt/runner 在 incomplete error 后退出。根因不是单个 `retryable: false`，而是恢复决策
缺少正确的层次、事实模型与模型上下文投影：

1. **transport classification 缺失/丢失**：adapter 不发稳定 `incomplete-stream`；legacy consumer 又把
   结构化 provider error 降成普通 `Error`；
2. **attempt 生命周期边界错误**：现有 `Effect.retry` 位于 `SessionProcessor.process()` 内部，重试会复用
   同一个 assistant ID；但安全恢复要求旧 attempt 保留为失败、新 attempt 使用新 ID；
3. **副作用 evidence 不足**：legacy 只有 `hasToolEvidence: boolean`，不能区分 completed/error 与
   pending/running、local 与 provider-executed、多工具部分结算；
4. **判断时机错误会丢事实**：legacy cleanup 会把 pending/running 改成 `error + interrupted`。若 cleanup
   后只检查 terminal status，会把“不确定”误判成“已结算 error”；
5. **两套投影语义相反**：legacy 删除全部普通 errored assistant，因而丢 tool result；current 保留失败
   assistant 的全部 content，因而 naive continuation 会注入 partial prose/reasoning；
6. **current settlement invariant 不完整**：正常 drain 且无 `stepSettlement()`/provider-error 时可无终态返回；
7. **重试预算没有 assistant-attempt chain 语义**：现有 retry schedule 面向同一 effect attempt，并非
   “多个持久化 assistant attempts”；新预算必须在一次活跃 runner/Prompt 调用内关联不同 message ID，
   但不能顺带引入仓库当前明确排除的 post-crash provider-work recovery。
8. **terminal event/status 与自动恢复冲突**：legacy `session.error` 会被 `opencode run` 累积，并在会话
   最终成功时仍把进程退出码置为 1；CLI 又会在 `session.status=idle` 时结束监听。中间可恢复 attempt
   不能沿用 terminal event 或 idle status 语义。
9. **caller 范围不完整**：`SessionCompaction.process()` 直接创建并调用 processor；Prompt 的外层 while
   无法替 compaction 创建新的 summary message ID。
10. **StructuredOutput 有 attempt-local 内存状态**：`structured` 定义在 Prompt while 外；若 incomplete
    后继续而不清空，后继 attempt 可能错误提升旧 attempt 捕获的结果。
11. **provider retry 与 agent step 不能混计**：legacy while/current runner 的下一轮通常递增 step；若
    SafeRetry 也递增，`steps=1` 等配置会在 retry request 注入 `MAX_STEPS_PROMPT`，不再是 Issue 要求的
    同一 user/context。只有自然 tool continuation 才消耗下一个 logical step。
12. **logical turn 的一次性工作不能随 attempt 重复**：legacy `step===1` 还触发 title/summary 等维护工作；
    SafeRetry 若机械重进完整 while，会重复这些内部副作用。provider attempt 与 logical-turn preparation
    必须分开记账。

### 2.2 证据

- `ai-sdk.ts` 当前合成 `provider-error({ retryable:false })`，没有 classification；
- `processor.ts` 的 `case "provider-error"` 只执行 `throw new Error(value.message)`；
- `retry.ts` 的 `retryable()` 只识别 APIError/rate-limit 模式，不识别该 UnknownError；
- `prompt.ts` 在 tool continuation 判断之前对任意 persisted assistant error 执行 break；
- `message-v2.ts` 已有回归测试明确断言普通 errored assistant 投影为空；
- current publisher 在 provider-error 分支立即 `failAssistant()`，runner 用
  `!publisher.hasProviderError()` 阻止 continuation；
- current `to-llm-message.ts` 仅禁用 failed message 的 provider metadata 复用，仍投影 text/reasoning/tools；
- `SessionCompaction.process()` 直接创建 summary assistant 并调用一次 processor，error 后返回 `"stop"`；
- `packages/opencode/src/cli/cmd/run.ts` 会累积每个 `session.error`，监听到 idle 后结束，并在累积 error
  非空时设置 `process.exitCode=1`；
- `prompt.ts` 的 `structured` 位于 while 外，且每次 while 都 `step++`；`step===1` 触发 title/summary，
  `isLastStep` 决定是否注入 `MAX_STEPS_PROMPT`；
- 九个窄测试稳定复现 1.4 的行为。

### 2.3 是否存在 workaround

没有可靠 workaround。用户可手动发送新消息，但：

- 无工具场景浪费人工干预；
- settled-tool 场景需要模型看到工具结果，普通新消息不保证正确重建自然 continuation；
- unsettled/provider-executed 场景必须先人工核对副作用，自动重发可能重复外部操作；
- 提高 timeout 只能降低触发频次，不能建立缺失的恢复语义。

### 2.4 同类风险点

- structured-output 使用内部 `StructuredOutput` tool。Issue 的 SafeRetry 验收明确要求“没有完整
  tool-call”；因此无 tool evidence 的 structured request 走 SafeRetry，已经完成 `StructuredOutput`
  call 的 request 走 ContinueAfterSettledTools，不增加按 tool name 绕过状态机的例外；
- compaction/summary 共用 legacy processor，但不能把 partial summary 当作普通 model history；
- permission/question decline 是否 blocked 必须尊重既有 policy：legacy 默认 blocked，
  `continue_loop_on_deny=true` 时已持久化的 terminal tool error 可按 settled-tools 继续；current runner 的
  interrupt 语义不变；
- tool result event 已到达但持久化失败时，不得依据内存 `settled=true` 自动继续；
- 多工具并行时必须对全体量化，不能采用 `some(settled)`；
- provider-executed call 有 call 但无 result/error 时，必须 ManualStop；
- clean EOF 无 step settlement 与明确 `incomplete-stream` provider-error 应进入同一恢复分类；
- raw-defined provider-specific `unknown` 仍有 terminal evidence，不能仅因字符串 `unknown` 自动 replay；
- `session.error` 是 terminal/user-visible signal；把可恢复 attempt 也发成该事件会使 headless CLI 假失败；
- failed attempt 的 usage/cost 不能合并到 successor，也不能丢弃；provider 可能对每个请求分别计费；
- current post-crash continuation recovery 被根目录 `AGENTS.md` 明确留给独立设计，本修复只在当前活跃 drain
  内自动转换。

### 2.5 证据、需求与设计选择的边界

| 类别            | 本文内容                                                                                           | 约束方式                                       |
| --------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 已验证事实      | 1.4 的九个测试、1.5/2.2 的当前代码路径、CLI 对 `session.error` 的退出码行为                        | 必须能由当前 commit 的代码或测试直接复核       |
| Issue #7 硬约束 | 三路状态机、新 assistant ID、partial 隔离、all-tools-settled、ManualStop 诊断、legacy/current 一致 | 实现不得降低或改写                             |
| 本方案设计选择  | 默认最多 2 次 retry、复用仓库 2s/4s 退避、共享 classifier、非 terminal event 规则                  | 经确认后成为子计划契约；不是当前行为或上游事实 |
| 明示局限        | 不可观察 hosted side effect、provider 实际计费/物理连接、post-crash 自动恢复                       | 不作超出证据的保证                             |

## 三、参考实现对照（协议状态机 bug）

本问题不是数值算法 bug；对照对象为仓库内/上游的 stream recovery 实现。

| 步骤 | 输入 / 状态              | 当前实现                                                         | 参考实现                                                   | 首个差异                                |
| ---- | ------------------------ | ---------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------- |
| 1    | AI SDK raw finish 缺失   | Issue #3 adapter 发 terminal provider-error，但无 classification | Issue #7 要求稳定 `incomplete-stream`                      | 是                                      |
| 2    | provider-error 到 legacy | 丢弃 classification/retryable，转普通 Error                      | PR #39473 在 adapter 直接抛 retryable stream error         | 是；PR 仍未解决 side-effect safety      |
| 3    | 无工具 incomplete        | fail-stop                                                        | PR #40531 在同一 processor/message 内 retry                | 是；PR 不满足新 attempt ID/有界要求     |
| 4    | partial attempt retry    | 当前不 retry，保留审计                                           | PR #26167 删除当前 attempt parts 后在同一 message retry    | 是；PR 丢失失败 attempt 审计且仍复用 ID |
| 5    | settled tools incomplete | fail-stop                                                        | 三份上游 PR 都没有按全体 tool settlement 自动 continuation | 是                                      |
| 6    | unsettled/hosted tool    | generic fail-stop                                                | Issue #7 要求列出 call ID/name/state 且禁止自动恢复        | 是                                      |
| 7    | current                  | provider error 后 `needsContinuation=false`                      | 上述三份上游 PR 均只覆盖 legacy                            | 是                                      |

参考来源：

- [上游 PR #40531](https://github.com/anomalyco/opencode/pull/40531)：在同一个
  `SessionProcessor`/assistant message 内 retry，使用现有 schedule；
- [上游 PR #39473](https://github.com/anomalyco/opencode/pull/39473)：adapter 抛
  `ResponseStreamError`，仍进入同 message retry；
- [上游 PR #26167](https://github.com/anomalyco/opencode/pull/26167)：最多 3 次、删除 attempt parts，review
  讨论已确认同 message partial parts 混写问题，但没有新 ID、工具副作用状态机或 current runner；
- 当前仓库 `docs/fixes/session-fix-incomplete-provider-stream.md`：明确把自动 retry 与 current completion
  作为独立 non-trivial follow-up。

可复用点只有：精确识别 raw-missing、有限重试、attempt-local evidence、失败 part 与模型上下文隔离。
不能直接复用“在 `Effect.retry` 内重放同一 message”或“删除失败 attempt”的生命周期设计。

## 四、修复方案

### 4.1 共享数据契约

在 `@opencode-ai/schema` 增加 browser-safe recovery schema，使 legacy/current Session 使用同一
vocabulary；在 `@opencode-ai/core` 增加纯决策函数，使两套 runner 不复制状态机。

```ts
type IncompleteStreamAction = "safe-retry" | "continue-after-settled-tools" | "manual-stop"

type IncompleteStreamToolEvidence = {
  id: string
  name: string
  state: "pending" | "running" | "completed" | "error"
  completeCall: boolean
  inputPersisted: boolean
  providerExecuted: boolean
  terminalResultPersisted: boolean
  interrupted: boolean
}

type IncompleteStreamRecovery = {
  classification: "incomplete-stream"
  action: IncompleteStreamAction
  reason:
    | "no-tool-evidence"
    | "settled-tools"
    | "uncertain-side-effect"
    | "retry-exhausted"
    | "blocked"
    | "persistence-failure"
  retry: { attempt: number; limit: number } // 0=原始 attempt；1/2=新 attempt
  tools: IncompleteStreamToolEvidence[]
}
```

`terminalResultPersisted` 表示 durable completed/error payload 已写入；不要求 provider 的可选 raw
`result` 字段非空。completed 的 structured/content 或 error 的 error payload 均可构成 terminal payload。

类型不变量：

1. `tools` 中 ID 在当前 assistant attempt 内唯一，且与 durable tool parts 一一对应；
2. `terminalResultPersisted => completeCall && inputPersisted && state in {completed,error}`；
3. `pending/running => !terminalResultPersisted`；`interrupted=true` 的 evidence 不可视为正常 settled；
4. `action=safe-retry => tools.length===0 && attempt<limit`；不允许按 tool name 设置例外；
5. `action=continue-after-settled-tools => tools.length>0`；
6. continuation 中对每个 tool 均满足
   `completeCall && inputPersisted && terminalResultPersisted && state in {completed,error} && !interrupted`；
7. `action=manual-stop` 时若存在 uncertain tool，`tools` 保留其 id/name/failure-boundary state；
8. recovery 与 error 同属 failed assistant；不得把旧 assistant 改写为 success；
9. 一次活跃恢复链内 `0 <= attempt <= limit` 且按新 assistant 单调递增；自然 continuation/new user input
   开始新的 chain；
10. recovery 只是持久化审计/投影依据，不是 post-crash work item。

将 `recovery?: IncompleteStreamRecovery` 加到 legacy/current assistant message；current
`SessionEvent.Step.Failed` 同步增加该 optional 字段。旧记录无该字段时保持兼容。共享类型属于跨模块
Session 契约，必须同时写入 `docs/design/session/architecture.md`，不能只藏在子计划文档中。

在 `@opencode-ai/llm` 的 `ProviderFailureClassification` 增加 `"incomplete-stream"`。adapter 不填
`retryable`：EOF/raw-missing 是否 transport-transient 并非所有 provider 都能证明，而且 agent replay 由
Session facts 决定。普通 provider error 的既有 `retryable` 语义不变。

### 4.2 共享纯决策函数

输入必须满足 4.1 类型不变量，并来自 failure boundary 上已经成功持久化的 facts；若 decode/normalization
不能证明这些前置条件，caller 直接 ManualStop。legacy cleanup 与 current unresolved-tool tombstone 只能在
snapshot 之后运行。

```text
decide(blocked, persistenceFailed, tools, attempt, limit):
  if blocked:
    return ManualStop(blocked)

  if persistenceFailed:
    return ManualStop(persistence-failure)

  if tools.length == 0:
    if attempt < limit:
      return SafeRetry(no-tool-evidence)
    return ManualStop(retry-exhausted)

  if every(tool.completeCall
               and tool.inputPersisted
               and tool.terminalResultPersisted
               and tool.state in {completed,error}
               and not tool.interrupted):
    return ContinueAfterSettledTools(settled-tools)

  return ManualStop(uncertain-side-effect)
```

默认 `limit=2`，即最多三个不同 assistant IDs（attempt 0、1、2）。退避复用仓库现有
`RETRY_INITIAL_DELAY=2000` 与 `BACKOFF_FACTOR=2`，所以两个 retry 分别等待 2s、4s；不含 jitter。
这是明确的本方案选择，依据是与现有 retry status/delay 保持一致，而不是 Issue 或上游 PR 已规定的事实。
共享 core 模块导出该 limit/delay policy，legacy/current 均 import，不各自复制常量。该上限只用于
incomplete-stream，不改变既有 APIError/rate-limit policy，也不新增用户配置项。

`StructuredOutput` 不设 replay-safe 特权：

- 若截断前没有完整 tool call，`tools.length===0`，与其他 headless request 一样 SafeRetry；
- 若 `StructuredOutput` 已完成，则严格按 Issue 的 all-tools-settled 规则 Continue；
- 旧 attempt 捕获的 `structured` 不提升，后继 attempt 开始前必须清空该 ephemeral 变量。

### 4.3 Adapter 与 generic incomplete detection

`packages/opencode/src/session/llm/ai-sdk.ts` 的 raw-missing 分支发出：

```ts
LLMEvent.providerError({
  message: "Provider stream ended without a terminal finish event",
  classification: "incomplete-stream",
})
```

- 仍先交付 partial content、usage 与 `step-finish(reason="unknown")`；
- 必须保持当前 `streamBatches()` 原子边界，使同一次 adapter mapping 的 step settlement 与 terminal
  failure 不会被 `Stream.takeUntil(needsCompaction)` 拆开；
- incomplete 优先于由同一 failed attempt usage 触发的 compaction；
- terminal failure 后抑制矛盾的 final finish；
- raw-defined provider-specific unknown 具有 terminal evidence，不自动标为 incomplete。

Generic consumer：

- legacy 正常 drain 但没有可信 step settlement 时，合成同一 classification 后走共享决策；
- current runner 正常 drain 且 `stepSettlement()` 不存在、也没有其他 provider error 时同样合成；
- `step-finish(reason="unknown")` 字符串本身不足以证明 raw terminal 缺失，不作全局自动 replay。

### 4.4 Legacy SessionProcessor 与 Prompt

`SessionProcessor`：

1. caller 为每次 `create/process` 传入 `incompleteAttempt`（默认 0）与共享 `limit`；processor 不从消息
   数量猜测 chain；
2. 收到 `classification=incomplete-stream` 时保留结构化 failure，不降成普通 `Error`；
3. 在 cleanup 前从当前 assistant 的 persisted tool parts 建立 immutable facts snapshot；
4. effective `ctx.blocked`（含既有 deny policy 的结果）与任何 part/event persistence failure 优先
   ManualStop；
5. 调共享 classifier，把 error + recovery 持久化到当前 failed assistant；
6. 将 `process()` 结果扩为
   `"continue" | "compact" | "stop" | { type:"incomplete-recovery"; recovery }`，避免 caller 依赖
   message error/name/string 反推动作；
7. SafeRetry/Continue 只触发 message update，不发布 terminal `Session.Event.Error`；ManualStop 恰好发布一次
   `Session.Event.Error`，错误文本列出 uncertain call ID/name/original state；
8. SafeRetry 设置 `status=retry`，退避后回到 busy；Continue 保持 busy；二者都不得在 successor 前发布
   idle。ManualStop/预算耗尽才进入 idle；
9. cleanup 可把 unresolved tool 标为 interrupted，但不得覆盖 recovery snapshot 的 original state；
10. incomplete transition 清除/压过同一 attempt 的 `needsCompaction`；
11. 不在当前 processor 的 `Effect.retry` 中处理 incomplete-stream；普通 APIError retry 维持现状。

`SessionPrompt.runLoop`：

1. 保存一个 in-memory、按 failed message ID 绑定的 pending transition；只消费**本次活跃 loop 刚产生**
   的 recovery。初始历史中的 recovery 不自动启动 provider work，避免把持久化字段误作 crash-resume
   queue；
2. SafeRetry：令 successor attempt=`recovery.retry.attempt+1`，设置既有 retry status，等待 2s/4s 后
   继续 while，并把该 attempt 显式传给新 processor；
3. ContinueAfterSettledTools：不等待，直接继续 while；
4. 下一次 while 顶部的 error guard 只有在 latest failed assistant ID 与 pending transition 完全相等时才
   可绕过；开始创建 successor 后立即单次消费 token，防止任意历史 error 被放行；
5. 两者都由既有 assistant creation 代码生成新 `MessageID.ascending()`；
6. 每个新 provider attempt 前把 `structured=undefined`；
7. ManualStop 与普通 error 维持 break；
8. current process 返回后的 error check 先保存显式 transition，再执行 generic break；
9. 自然 tool continuation、新 user input 开始的新调用均把 incomplete attempt 重置为 0；
10. SafeRetry 保持同一 logical `step`/`isLastStep`/MAX_STEPS 状态；ContinueAfterSettledTools 才按自然
    continuation 递增 step。若期间有新 user/steer 被提升，则终止旧 retry chain，并以新输入的正常 step 1
    与 attempt 0 开始；
11. SafeRetry 重新从 durable history 构造模型上下文并过滤 failed partial，但不得再次执行该 logical step
    已完成的 title/summary/task-consumption 等一次性维护工作；“同一 context”指同一 parent user、同一
    logical-step flags 与等价 durable history，不承诺 environment/plugin 动态输出逐 byte 相同；
12. eventual success 不留下 terminal `session.error`，因此 `opencode run` 退出码为 0；ManualStop/预算耗尽
    仍发 terminal error 并退出 1。

### 4.5 Legacy compaction caller

`SessionCompaction.process()` 不能借用 Prompt while 隐式恢复，必须在自己的调用边界实现同一 active-chain
coordinator：

1. 每个 summary attempt 都先创建并持久化新的 `summary=true` assistant ID；
2. compaction 传入 `tools={}`，所以只能得到 SafeRetry 或 ManualStop，不存在 settled-tool continuation；
3. SafeRetry 以同一 summary input/context 串行新建 attempt，遵守同一 2 次预算与 2s/4s 退避；
4. failed partial summary 保留审计，但 legacy projection 继续过滤，不进入 retry request；
5. 只有无 error 的成功 summary 才发布 `SessionCompaction.Event.Compacted` 并触发 auto-continue；
6. 预算耗尽/ManualStop 返回 `"stop"`，不把 partial summary 标为 completed compaction；
7. 不实现进程重启后的自动 summary retry。

### 4.6 Recovery-aware 模型投影

Legacy `MessageV2.toModelMessagesEffect` 与 current `to-llm-message.ts` 使用相同白名单：

- `safe-retry` / `manual-stop`：整条 failed assistant 不进入 successor model context；
- `continue-after-settled-tools`：只投影 recovery facts 已证明 terminal 的 tool call/result；
- 不投影旧 partial text、reasoning、patch、step marker；
- local tool 使用 assistant tool-call + tool result；provider-executed tool 使用其 durable terminal
  payload，并保留 providerExecuted 标记；
- 选中的 tool parts 按原 durable 顺序投影，并以 call ID 保持 call/result 一一配对；不得按 recovery
  diagnostic array 重新排序；
- 同 provider/model continuation 只保留这些 settled tool call/result 所需的 provider metadata；failed
  prose/reasoning/response-level cache metadata 不复用。跨 model continuation 继续使用既有降级规则；
- 若实际 persisted content 与 recovery evidence 的 ID/state 不一致，projection 必须失败并终止自动
  continuation，不能静默补齐、降级或猜测；
- transcript/API 仍可展示 failed partial prose、reasoning、usage 与 cost；投影过滤不删除审计记录。

### 4.7 Current Session publisher 与 runner

`createLLMEventPublisher`：

- incomplete provider-error 先记录 failure boundary，不立即用不完整 evidence 发布 `Step.Failed`；
- 暴露 called/input-persisted/settled/providerExecuted/terminal-payload-persisted snapshot；
- persisted bit 只能在相应 event publish 成功后置位；当前“先改内存 map、再 publish”的分支需要调整或
  另设 durable-confirmed bit；
- 普通 provider error 维持现有 terminal failure 语义。

`SessionRunner.runTurnAttempt`：

1. outer runner 显式传入 active-chain `incompleteAttempt`（默认 0），不得从历史 failed message 猜测；
2. incomplete boundary 时冻结 tool facts；
3. 可等待/清理已有 tool fibers，但决策只使用 boundary snapshot，不能把事后 tombstone 当成当时 settled；
4. 调共享 classifier 并发布带 recovery 的 `Step.Failed`；
5. SafeRetry/Continue 返回显式 local transition，使 outer runner 串行新建 publisher/assistant ID；每个
   `runTurnAttempt` 仍严格只有一次 `llm.stream(request)`；
6. ManualStop 返回 `needsContinuation=false`，错误含 uncertain tool 诊断；
7. clean EOF 无 step settlement 走同一路径；
8. 不复用现有 `SessionEvent.Retried`：其 payload 是 APIError-shaped，且 projector 当前不投影它；本子计划
   以 `Step.Failed.recovery` + 后继 `Step.Started` 表达 attempt transition；
9. 不改变 context-overflow、steer/queue promotion、max-step、permission decline 语义；
10. transition 明确携带是否消耗 logical step：SafeRetry 复用 `currentStep`，Continue 按现有 outer loop
    进入 `currentStep+1`；若 pending steer 被提升，按既有规则重置 step，并把 incomplete attempt 重置为 0；
11. 自动 retry 只存在于当前 process-local active drain。若进程在 Step.Failed 与 successor 之间退出，不在
    新进程自动重放 provider work；这与根目录 `AGENTS.md` 的 post-crash 边界一致。

### 4.8 并发规约与关键假设

并发单元：legacy tool execution / current local tool fibers 与 failure classification。

- **共享资源**：当前 assistant 的 tool parts/current publisher tool map、durable event store、frozen recovery
  snapshot；
- **顺序约束**：`tool event durable write` happens-before `persisted bit=true` happens-before `failure snapshot`
  happens-before `decision` happens-before `cleanup/tombstone`；
- **Rely**：同一 Session 的 provider event publication 由既有 processor/runner 串行化；工具 fiber 只能通过
  规定的 update/publish 接口改变 durable tool state；
- **Guarantee**：classifier 输入被冻结后不可被 fiber settlement 升级；failure-boundary 为 pending/running
  的 call 即使随后完成也保持 ManualStop；projection 只读 recovery 证明过的 ID/state；
- **线程安全结论**：在上述串行 publication 与 write-confirmed bit 前提下成立；若 persistence 失败或无法
  建立 happens-before，则只允许 ManualStop。

关键假设：

1. provider/runtime 交付给 opencode 的 event prefix 忠实反映其已公开的 tool call/providerExecuted 状态；
2. opencode 发起的 local tool execution 之前，完整 call input 已进入可持久化的 tool state；
3. 未到达客户端的 hosted side effect 无法从本地证明，本修复不声称 exactly-once；
4. provider request 可能产生 token/计费副作用，即使无工具；SafeRetry 接受该成本，每个 attempt 独立记账；
5. Issue 的副作用状态机覆盖 agent tool/provider-executed tool；任意第三方 plugin hook 若在 message transform
   内自行产生外部副作用，不在本地 tool evidence 中可见，必须由 plugin 自身保证 retry-safe；
6. recovery persistence 本身失败时，系统可能无法写出完整诊断，但绝不能因此自动 retry/continue。

### 4.9 分布式接口七项契约

1. **连接模型**：caller 在 retry/continuation 时重新调用一次 `llm.stream(request)`，建立新的逻辑 provider
   stream，不续写旧 stream；作用域结束/abort 时由既有 runtime 关闭旧 stream。物理连接可能由 provider
   SDK/HTTP pool 复用，因此“每次新建 TCP 连接”不作保证。关闭旧 stream 不删除 transcript；自动重连
   只指新的 logical request。
2. **超时与截止时间**：connect/read/write/overall deadline 对本子计划均为 N/A，理由是本层不设置，
   而是继承各 provider SDK/runtime 配置。本层只消费已观察到的 EOF/typed failure/no-settlement。超时后远端请求/tool
   状态可能不可知，不假设“断连等于未执行”。
   若既有 provider 没有 deadline 且 stream 永久不结束，本状态机不会触发，也不新增 watchdog。
3. **重试与幂等**：新增 retry 方仅为 Session Prompt/compaction/current runner；最多 2 次，2s/4s 指数
   退避，无 jitter，串行。provider request 非幂等且无通用 idempotency key；只在本地没有任何 tool
   evidence 时重发。网关/SDK 的内部重试不受本层控制。settled-tool 路径仅发 continuation。
4. **交付与顺序**：recovery coordinator 会发起 1～3 个 logical requests，远端实际 delivery 是 bounded
   best-effort（可能送达 0～3 次），既不是 at-most-once，也不保证至少一次成功；opencode-originated local
   tool invocation 对已观察 call ID 保持
   at-most-once，provider/网络不可观察的 hosted 重复执行无保证。单 Session 内按 runtime event 顺序与
   durable happens-before 形成因果序；跨 Session 无全序。failed partial output 只进入 transcript，不进入
   successor request。
5. **失败模式**：假设 fail-stop/slow/partition，不处理 Byzantine provider。EOF、typed error、normal drain
   without settlement 都可见为 failed assistant + recovery；uncertain side effect ManualStop。诊断持久化失败
   时只能 best-effort surface 原始 persistence error。
6. **状态与会话**：有状态，以 session ID 关联，每个 provider turn 有独立 assistant message ID；新 logical
   request 可从 durable transcript 构造上下文。跨进程自动恢复为 N/A，理由是 current Session runner 明确
   没有 durable drain identity，必须另案设计。
7. **背压与流控**：新 retry queue 容量 `N/A（不创建队列）`，溢出策略为达到 attempt limit 后拒绝继续；
   同一 Session 使用既有串行 coordinator，provider stream 背压继承 runtime，不新增控制；不同 Session
   并发保持现状。

### 4.10 实施单元与确认门

该问题修改跨实现 schema、流程和不变量，按契约子计划处理：

1. 单元 A：Session architecture、subplan、expectations、共享 schema/classifier/classification；
2. 单元 B：legacy adapter/processor/Prompt/compaction/投影/CLI 语义与回归；
3. 单元 C：current publisher/runner/投影与回归；
4. 单元 D：生成客户端、跨实现契约审核、文档回填与广测。

进入单元 A 前必须由用户确认本方案，特别是默认 retry limit=2、2s/4s 无 jitter，以及新增直接
`fast-check` devDependency。每个单元完成后停下报告，不跨确认门一次性实施全部模块。

## 五、正确性论证

### 5.1 根因消除

- classification 在 adapter/consumer 边界稳定存在，不再靠 error message 匹配；
- replay 决策从 provider boolean 上移到拥有 attempt/tool/session facts 的共享 recovery classifier；
- retry 位于 assistant creation 外层，所以每次 replay 有新 ID，旧 failed attempt 不被改写或删除；
- selective projection 对 legacy/current 统一语义：SafeRetry 不带旧 output，Continue 只带 settled tools；
- retry attempt 随 failed assistant 持久化供审计；active coordinator 负责当前调用内的上限，且不会把
  persisted recovery 误作 post-crash work queue。

### 5.2 不变量保持

定义：

```text
I1: incomplete attempt 永远是 failed assistant，不能被改写成 success
I2: automatic replay => newAssistantID != failedAssistantID
I3: SafeRetry => tools.length == 0 and persistence healthy and attempt < limit
I4: Continue => tools.length > 0 and every(complete call + input persisted + terminal payload persisted + not interrupted)
I5: ManualStop <=> blocked or persistence failure or (tools.length == 0 and attempt >= limit) or uncertain tool set
I6: successor model context excludes failed partial prose/reasoning
I7: opencode recovery layer 不对 original call ID 发起第二次工具执行
I8: active recovery chain retry count <= shared policy limit
I9: legacyDecision(normalizedFacts) == currentDecision(normalizedFacts)
I10: 可自动恢复 attempt 不发 legacy terminal session.error；ManualStop 恰好发一次
I11: 每个 assistant attempt 的 usage/cost 独立保留，不与 successor 合并
I12: SafeRetry 不消耗 logical agent step；ContinueAfterSettledTools 恰好消耗一个自然 continuation step
I13: SafeRetry 不重复 logical-turn 一次性维护工作；failed partial 不进入重建后的模型上下文
I14: Continue 投影保持 settled tool 的原顺序、call/result 配对与必要 provider metadata
I15: legacy 自动恢复链在 successor 前不进入 idle；ManualStop/最终完成才结束 session activity
```

论证：

- I1/I2 由 recovery 持久化与外层新 message creation 保证；
- I3 由严格 `tools.length===0`、persistence-first 分支与 4.8 假设保证；它不声称能发现未交付的 hosted
  side effect；
- I4 由 `tools.length>0` 与 `every(...)` 保证，部分结算无法通过；
- I5 由分支优先级保证；blocked/persistence 先于任何自动动作；
- I6 由两个投影器只消费 recovery action 的白名单分支保证；
- I7 由 settled-tool 分支只投影 result、uncertain 分支停止、SafeRetry 无 original call ID 保证；
- I8 由 active coordinator 的 attempt + limit 比较保证；持久化字段用于审计，不触发 crash resume；
- I9 由两端调用同一个 pure function，而不是复制 switch 保证；
- I10 由 processor event 分支与 CLI 回归测试保证；
- I11 由每次新建 assistant 且不删除/合并旧 attempt 保证；
- I12 由显式 transition kind 与 max-step 边界回归测试保证；
- I13 由 attempt/turn 两层状态与 title/summary/task-consumption 回归测试保证；
- I14 由投影器按 durable parts 迭代、按 recovery ID 白名单选择及 provider-metadata 回归测试保证；
- I15 由显式 recovery transition 的 status 分支与 CLI event-order 回归测试保证。

### 5.3 无回归引入

- 只有 classification=`incomplete-stream` 或“normal drain 无可信 settlement”进入新状态机；
- 正常 `stop`、`tool-calls`、`length`、content-filter、context-overflow、明确 API error 仍走原路径；
- raw-defined unknown 保持 Issue #3 的兼容规则；
- 普通 retryable APIError 的现有 `Effect.retry` 不改；
- permission/question blocked 优先 ManualStop；
- compaction、structured-output success promotion 必须在 incomplete error 之后，不能覆盖它；
- 新 schema 字段均 optional，旧记录可解码；
- `streamBatches()` 的 step-finish + provider-error 原子性保持，high-usage incomplete 不先进入 compaction；
- post-crash runner 不自动恢复 provider work；
- auto-recovered headless/CLI 调用最终成功时不因中间 attempt 退出 1。

本修复 non-trivial：跨模块状态恢复、持久化、副作用与重试，不能标记 trivial。

## 六、测试用例清单

| 类型     | 用例描述                                                                                           | 状态（修复后回填）                                                  |
| -------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 回归     | legacy 无 tool incomplete：旧 assistant failed；新 ID retry；成功后自动完成                        | 待加                                                                |
| 回归     | legacy settled local tool：副作用一次；failed assistant 保留；下一 turn 看见 result                | 待加                                                                |
| 回归     | current settled local tool：execution 一次；新 assistant continuation；只带 tool context           | 待加                                                                |
| 回归     | retry 达 2 次上限：共 3 个不同 assistant IDs；最后 ManualStop                                      | 待加                                                                |
| 新增     | partial reasoning/text 在 failed transcript 可见，但 SafeRetry request 不含旧 partial              | 待加                                                                |
| 新增     | settled completed/error 混合的多工具集合可 continuation，全部只执行一次                            | 待加                                                                |
| 新增     | Continue 保持多工具原顺序/call ID 配对；同 provider 仅保留 tool 所需 metadata；跨 model 按既有降级 | 待加                                                                |
| 新增     | 多工具仅部分结算 => ManualStop，诊断列出每个 uncertain id/name/state                               | 待加                                                                |
| 新增     | local pending/running => ManualStop；cleanup 后 recovery 仍保留 original state                     | 待加                                                                |
| 新增     | providerExecuted terminal result/error => Continue；无 result => ManualStop                        | 待加                                                                |
| 新增     | tool result persistence failure => ManualStop，不依据内存 settled 继续                             | 待加                                                                |
| 新增     | permission/question 默认 deny => ManualStop；legacy continue-on-deny 且 error 已持久化 => Continue | 待加                                                                |
| 新增     | StructuredOutput 无完整 call 时 SafeRetry；已完成 call 时 Continue；旧 structured 不提升/不泄漏    | 待加                                                                |
| 新增     | compaction/summary incomplete 产生新 summary ID retry；不消费 failed partial；只在成功后 Compacted | 待加                                                                |
| 新增     | current clean EOF 无 step settlement：按同一 classifier 决策                                       | 待加                                                                |
| 新增     | raw-defined unknown 不进入 incomplete auto recovery                                                | 待加                                                                |
| 新增     | high-usage raw-missing 的 step-finish/provider-error 保持同 batch，recovery 优先于 compaction      | 待加                                                                |
| 新增     | auto recovery 最终成功不发 terminal `session.error`，`opencode run` exit 0；耗尽时 exit 1          | 待加                                                                |
| 新增     | SafeRetry/Continue 的 successor 前不发 idle；retry→busy 顺序稳定；ManualStop 才 idle               | 待加                                                                |
| 新增     | failed attempt 与 successor usage/cost 分别保留、不合并                                            | 待加                                                                |
| 新增     | current runner 在 process restart 后不把 persisted recovery 自动当作 provider work                 | 待加                                                                |
| 新增     | `steps=1` 时 SafeRetry 保持同一 logical step/request shape，不提前注入 MAX_STEPS；Continue 才递增  | 待加                                                                |
| 新增     | SafeRetry 间隙若提升新 user/steer，旧 chain 终止，新输入从 step 1 / attempt 0 开始                 | 待加                                                                |
| 新增     | SafeRetry 不重复 title/summary/task consumption；重建请求不含 failed partial                       | 待加                                                                |
| 回归     | stop/tool-calls/length/content-filter/context-overflow/API error 语义不变                          | 待跑/补                                                             |
| Property | 对 facts 组合生成：I3-I5 决策互斥且完备；I4 对任一 uncertain tool 恒不成立                         | 待加；计划在 core devDependency 显式使用 `fast-check@4.8.0`，需确认 |
| 跨实现   | 同一组 normalized vectors 输入 legacy/current normalizer，recovery action 完全一致                 | 待加                                                                |

现有 1.4 九个 stream fixture/触发序列必须保留为回归素材；预期从 fail-stop 改成 recovery 的用例应更新
断言，不得删除输入场景。真正属于 ManualStop 的安全性断言不得弱化。

## 七、代码更新清单

| 文件                                                            | 函数 / 行号                               | 改动概述                                                                   | 状态（修复后回填） |
| --------------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------- | ------------------ |
| `packages/schema/src/session-recovery.ts`                       | 新文件                                    | 定义 recovery/action/tool evidence schema 与不变量 vocabulary              | 待加               |
| `packages/schema/src/session-message.ts`                        | `Assistant`                               | current assistant 增加 optional recovery                                   | 待改               |
| `packages/schema/src/v1/session.ts`                             | `Assistant`                               | legacy assistant 增加 optional recovery                                    | 待改               |
| `packages/schema/src/session-event.ts`                          | `Step.Failed`                             | current failed event 携带 optional recovery                                | 待改               |
| `packages/llm/src/schema/errors.ts`                             | `ProviderFailureClassification`           | 增加 `incomplete-stream`                                                   | 待改               |
| `packages/core/src/session/incomplete-stream-recovery.ts`       | 新文件                                    | 共享纯决策函数                                                             | 待加               |
| `packages/opencode/src/session/llm/ai-sdk.ts`                   | `toLLMEvents`                             | raw-missing 发稳定 classification                                          | 待改               |
| `packages/opencode/src/session/processor.ts`                    | provider error / settlement / cleanup     | cleanup 前 facts、持久化 recovery、禁止同 message replay                   | 待改               |
| `packages/opencode/src/session/prompt.ts`                       | `runLoop`                                 | active-chain bounded SafeRetry、settled-tool continuation、新 assistant ID | 待改               |
| `packages/opencode/src/session/compaction.ts`                   | `processCompaction`                       | summary 自有 bounded new-ID retry；成功前不发 Compacted                    | 待改               |
| `packages/opencode/src/session/message-v2.ts`                   | `toModelMessagesEffect`                   | legacy recovery-aware selective tool projection                            | 待改               |
| `packages/core/src/session/runner/publish-llm-event.ts`         | publisher state / provider-error          | 保留 classification 与 failure-boundary facts                              | 待改               |
| `packages/core/src/session/runner/llm.ts`                       | `runTurnAttempt` / outer run              | current recovery transition、bounded retry、clean EOF detection            | 待改               |
| `packages/core/src/session/runner/to-llm-message.ts`            | `assistant`                               | current recovery-aware selective projection                                | 待改               |
| `packages/core/src/session/message-updater.ts`                  | `session.next.step.failed`                | 把 event recovery 投影到 current assistant                                 | 待改               |
| `packages/core/package.json` / `bun.lock`                       | devDependency                             | 若确认 property test，显式加入 `fast-check@4.8.0`                          | 待确认             |
| `packages/schema/test/*`                                        | schema contracts                          | optional omission、stable identifier、current/V1 字段 round-trip           | 待加/改            |
| `packages/opencode/test/session/llm.test.ts`                    | adapter tests                             | classification 与正常 finish 回归                                          | 待改               |
| `packages/opencode/test/session/processor-effect.test.ts`       | processor tests                           | 三路 facts、cleanup/persistence 边界                                       | 待改               |
| `packages/opencode/test/session/prompt.test.ts`                 | loop tests                                | 新 ID、有界 retry、settled continuation、structured、usage/cost            | 待改               |
| `packages/opencode/test/session/compaction.test.ts`             | compaction tests                          | summary new-ID retry、partial 隔离、Compacted 时序                         | 待改               |
| `packages/opencode/test/session/message-v2.test.ts`             | projection tests                          | partial 隔离、仅 settled tools                                             | 待改               |
| `packages/opencode/test/cli/run/run-process.test.ts`            | headless CLI                              | 中间 recovery 后成功 exit 0；ManualStop exit 1                             | 待改               |
| `packages/opencode/test/tool/task.test.ts`                      | Task/subagent                             | child auto recovery success 与 terminal ManualStop 传播                    | 待改               |
| `packages/core/test/session-runner.test.ts`                     | runner tests                              | current 三路、clean EOF、attempt limit                                     | 待改               |
| `packages/core/test/session-runner-tool-events.test.ts`         | publisher tests                           | failure-boundary tool facts 与 persistence ordering                        | 待改               |
| `packages/core/test/session-incomplete-stream-recovery.test.ts` | 新文件                                    | truth table/property/cross-vector tests                                    | 待加               |
| `packages/client/src/generated*`                                | `bun run generate` from `packages/client` | current public Assistant/Step.Failed 变更后生成，禁止手改                  | 待生成             |
| legacy JS SDK generated files                                   | `./packages/sdk/js/script/build.ts`       | legacy Assistant public schema 变更后生成，禁止手改                        | 待生成             |

具体行号以实施时当前分支为准；禁止顺手重构无关 session/provider 代码。

## 八、文档更新清单

| 文档路径                                                               | 要改什么                                                                                  | 状态（修复后回填） |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------ |
| `docs/fixes/session-fix-incomplete-stream-recovery.md`                 | 本八部分计划与实施/测试/commit 回填                                                       | 草案已加，待确认   |
| `docs/fixes/session-fix-incomplete-provider-stream.md`                 | 把“no-retry/current follow-up”状态更新为由 Issue #7 承接，不改写历史结论                  | 待改               |
| `docs/design/session/architecture.md`                                  | 新建 Session feature 主架构；归属跨模块 recovery schema/invariants 与 legacy/current 边界 | 待加               |
| `docs/design/session/subplans/session-1-incomplete-stream-recovery.md` | 半形式化共享 schema、三路流程、七项分布式契约、函数正确性论证                             | 待加               |
| `docs/audits/session-1-incomplete-stream-recovery/expectations.md`     | 实施前独立抽取十节 expectations                                                           | 待加；代码前门禁   |
| `docs/audits/session-1-incomplete-stream-recovery/audit-report.md`     | 实施后独立契约审核                                                                        | 待加               |
| `docs/audits/session-1-incomplete-stream-recovery/decisions.md`        | 记录 warnings、retry/backoff/property dependency 等决策                                   | 待加               |

本修复明确改变 schema、错误分类、attempt workflow、不变量及 legacy/current 跨实现一致性，文档清单不允许写“无”。
