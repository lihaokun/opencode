# Incomplete provider stream 按副作用状态恢复修正方案

- 状态：修复前分析与方案草案，等待用户确认；尚未修改 production code
- 日期：2026-08-07
- 对应问题：[Issue #7](https://github.com/lihaokun/opencode/issues/7)
- 工作分支：`yixiao-issue-7-new`
- 前置修复：`docs/fixes/session-fix-incomplete-provider-stream.md`（Issue #3）
- 分析范围：仅当前本地仓库与 Issue #7，不查看上游仓库
- 问题分类：接口/架构层面的恢复状态机缺失，同时包含既有 fail-stop 行为的功能补充
- 当前验证限制：仓库要求 Bun 1.3.14，但当前环境中 `bun` 不存在，定向测试命令均在启动前以
  `command not found: bun` 失败；本文的当前行为结论来自源码、既有测试契约和本地提交记录的静态交叉验证

## 一、现象与复现

### 1.1 现象

Issue #3 已保证缺少可信 terminal finish event 的 provider stream 不会被误报为成功。当前统一行为是：

```text
incomplete provider stream
  -> provider-error
  -> assistant error
  -> 当前 Prompt/SessionRunner 停止
  -> 用户必须手动发送新消息或显式 resume
```

该 fail-stop 修复保证了安全，但没有区分以下三类本质不同的状态：

1. 当前 provider attempt 没有产生任何完整 tool call 或 provider-executed side effect，可以用新的
   assistant attempt 安全重试；
2. 当前 attempt 已有工具调用，但所有工具均已结算并持久化，可以跳过旧 provider request，直接把已结算
   tool result 交给下一 assistant turn；
3. 当前 attempt 存在 pending/running、provider-executed 无 result、持久化失败或部分结算，副作用状态不明，
   必须继续 fail-stop。

当前实现把这三类状态都压缩为普通 assistant error，因此长任务遇到稳定 stream deadline 时无法自动恢复。

### 1.2 Legacy 路径的当前可重复行为

#### 复现 A：无工具的 incomplete stream

现有测试 `packages/opencode/test/session/prompt.test.ts`：

- `loop preserves reasoning-only output and stops on a missing terminal finish`
- `loop preserves partial text and stops on a missing terminal finish`

输入是 reasoning/text 已部分产生，但 provider 没有 finish reason。当前断言固定为：

```text
provider request count = 1
assistant.finish = "unknown"
assistant.error = canonical incomplete error
Prompt loop stops
```

预期的新行为应是：原 assistant 保留 error 与 partial transcript，但 Prompt 创建新的 assistant ID，最多自动重试
2 次；旧 partial reasoning/text 不进入新 provider request。

#### 复现 B：工具已完成后 incomplete

现有测试：

- `loop does not replay a completed tool after a later missing terminal finish`
- `high-usage missing finish does not replay a completed tool or start compaction`

当前实现正确保证工具只执行一次，但随后直接停止。Issue #7 要求把该用例翻转为：

```text
completed tool count = 1
old assistant remains error
old provider request is not replayed
new assistant turn starts
new model request contains the settled tool call/result
```

#### 复现 C：工具状态不明

`SessionProcessor.cleanup()` 会等待未结算工具至多 250ms，然后把仍在 `ctx.toolcalls` 中的工具写成：

```text
status = "error"
error = "Tool execution aborted"
metadata.interrupted = true
```

该状态虽然在 schema 上是 terminal `error`，但语义上不是“工具已可信结算”，而是“执行是否产生副作用不可知”。
因此恢复分类不能只检查 `status in {completed,error}`，必须把 `metadata.interrupted=true` 视为
`ManualStop`。

### 1.3 Legacy 出错代码路径

```text
AI SDK finish-step(other, rawFinishReason=undefined)
  -> packages/opencode/src/session/llm/ai-sdk.ts
       emits provider-error(retryable=false), no stable classification
  -> packages/opencode/src/session/processor.ts
       case provider-error: throw new Error(message)
  -> MessageV2.fromError()
       converts to generic UnknownError
  -> SessionRetry.policy()
       does not recognize the generic error, so same Effect is not retried
  -> SessionProcessor.halt()/cleanup()
       persists assistant error and aborts unresolved tools
  -> packages/opencode/src/session/prompt.ts
       current-turn error gate breaks
       persisted-error entry gate also breaks before tool continuation
  -> packages/opencode/src/session/message-v2.ts
       drops the entire errored assistant from model context
```

关键位置：

- adapter classification：`packages/opencode/src/session/llm/ai-sdk.ts:120`
- attempt evidence：`packages/opencode/src/session/processor.ts:80`
- tool persistence：`packages/opencode/src/session/processor.ts:145`
- provider-error information loss：`packages/opencode/src/session/processor.ts:444`
- cleanup interruption marker：`packages/opencode/src/session/processor.ts:634`
- same-message Effect retry boundary：`packages/opencode/src/session/processor.ts:694`
- persisted-error loop guard：`packages/opencode/src/session/prompt.ts:1100`
- current-turn error guard：`packages/opencode/src/session/prompt.ts:1297`
- errored assistant context deletion：`packages/opencode/src/session/message-v2.ts:248`

### 1.4 V2 SessionRunner 的当前可重复行为

现有测试 `packages/core/test/session-runner.test.ts` 已固定：

- `does not continue automatically after a provider error follows a local tool call`
- `durably fails a hosted tool when its provider errors before returning a result`

当前 V2 路径：

```text
provider-error
  -> createLLMEventPublisher.failAssistant()
  -> Step.Failed(error.type="unknown")
  -> runner awaits local tool fibers
  -> all remaining tools are failed
  -> needsContinuation forced to false
```

相关位置：

- publisher 已有 `called/settled/providerExecuted` evidence：
  `packages/core/src/session/runner/publish-llm-event.ts:55`
- provider error 立即 fail assistant：
  `packages/core/src/session/runner/publish-llm-event.ts:404`
- provider error 禁止 continuation：
  `packages/core/src/session/runner/llm.ts:338`
- runner 返回 `needsContinuation=false`：
  `packages/core/src/session/runner/llm.ts:345`

V2 比 legacy 已经拥有更精确的内存 tool evidence，并且会等待本地 tool fiber 结算；但这些 evidence 没有形成统一
recovery decision，也没有持久化 recovery classification。

### 1.5 Legacy 与 V2 的额外不一致

Legacy 的 `MessageV2.toModelMessagesEffect()` 会删除普通 errored assistant；V2 的
`toLLMMessages()` 当前仍会把 errored assistant 的 partial text/reasoning 转成下一次模型上下文，仅关闭 provider
metadata 复用：

- Legacy：`packages/opencode/src/session/message-v2.ts:248`
- V2：`packages/core/src/session/runner/to-llm-message.ts:70`

因此，即使两条 runner 路径都增加 retry，若不统一 model-context lowering：

- Legacy 会丢掉 settled tool result；
- V2 会错误重放 incomplete partial prose/reasoning。

### 1.6 预期行为

统一分类：

```text
classification = "incomplete-stream"
```

Session 层基于本 attempt 的 durable side-effect evidence 计算：

```text
IncompleteStreamRecovery
  |- SafeRetry
  |- ContinueAfterSettledTools
  `- ManualStop
```

行为约束：

- `SafeRetry`：保留旧失败 attempt，使用新 assistant ID 和新 processor/publisher 请求 provider；最多重试 2 次；
- `ContinueAfterSettledTools`：不重放旧 request、不重新执行工具，创建下一 assistant turn，只注入已结算 tool context；
- `ManualStop`：不 retry、不 continuation，错误明确列出未结算工具；
- 三种情况都不能把旧 incomplete assistant 改写为成功；
- Legacy 与 V2 对同一 evidence 必须产生相同 recovery decision。

## 二、根因分析

### 2.1 直接症状与根因区分

直接症状是 Prompt/SessionRunner 在 incomplete error 后停止。仅删除 error-first guard 或把
`retryable:false` 改成 `true` 只能改变症状，不能保证副作用安全。

根因是：当前系统只有“provider transport failure”与“assistant terminal error”两个层次，没有位于二者之间的
**attempt-local side-effect recovery contract**。因此：

1. provider event 上的 transport 信息在 legacy processor 中丢失；
2. Session 层没有统一的 tool settlement evidence schema；
3. runner 没有把“是否安全重放”和“是否应继续下一 turn”建模为互斥决策；
4. model-context lowering 不知道 failed attempt 哪些内容可恢复；
5. retry 没有 durable attempt isolation 与跨 resume 的 bounded count。

### 2.2 根因一：`retryable` 同时承载了两个不同问题

`ProviderErrorEvent.retryable` 最多只能描述 provider/transport failure 是否可能是瞬态的，不能证明整个 agent attempt
可以安全 replay。完整 tool call 之后，即使 EOF 是瞬态的，重放仍可能重复本地命令、写文件、网络请求或
provider-executed side effect。

因此 recovery decision 不能由 adapter 的一个布尔值决定。

### 2.3 根因二：legacy provider-error 被压成普通 Error

`packages/opencode/src/session/processor.ts:444` 当前只执行：

```ts
throw new Error(value.message)
```

`classification`、`retryable` 和 provider metadata 均丢失。随后 `MessageV2.fromError()` 只能创建
`UnknownError`。这导致 Prompt 无法可靠区分 incomplete-stream、普通 provider error 和其它 unknown failure。

### 2.4 根因三：现有 Effect retry 不具备 attempt isolation

`SessionProcessor.process()` 的 `Effect.retry()` 包裹同一个 processor context 和同一个
`assistantMessage`。Issue #3 文档已明确该边界没有 durable attempt identity，也不会回滚已持久化 parts、cost、tool
facts。

因此 SafeRetry 不能加入当前 `SessionRetry.policy()`；必须退出旧 processor，并由外层 runner 创建新的 assistant
message/attempt。

### 2.5 根因四：tool terminal schema 不等于副作用已可信结算

下列状态不能被简单视为 settled：

- `pending`：只有 partial tool input；
- `running`：完整 call 已交付，side effect 可能已开始；
- `error + interrupted=true`：cleanup 强制收尾，真实副作用状态不明；
- provider-executed call 无 terminal result；
- tool result persistence/projection 失败。

只有真实 `completed` 或真实 tool `error`，且输入与 output/error 已持久化、没有 interrupted/persistence failure，才满足
ContinueAfterSettledTools。

### 2.6 根因五：Prompt 有两个独立停止门

只修改 loop 顶部 `lastAssistant.error` guard 不足够。当前 turn 完成后还有：

```text
handle.message.error -> break
```

因此 recovery action 必须同时驱动：

1. 当前 processor 返回后的 same-process transition；
2. crash/re-enter 后的 persisted-assistant transition。

两者必须使用同一 persisted recovery classification，避免进程内与恢复后的语义不同。

### 2.7 根因六：model context 没有 recovery-aware lowering

三种 recovery 对旧 assistant context 的要求不同：

- SafeRetry：旧 partial text/reasoning/tool-input 全部不进入模型上下文；
- ContinueAfterSettledTools：只注入已结算 tool call/result；旧 partial prose/reasoning 不注入；
- ManualStop：不自动发起下一 request；用户后续显式继续时也不应把 incomplete prose 当作完整历史。

当前 Legacy 整条删除、V2 几乎整条保留，都不满足统一契约。

### 2.8 根因七：StructuredOutput 状态不是 attempt-local

Legacy `runLoop()` 中 `structured` 定义在 while loop 外。若 incomplete stream 在 StructuredOutput tool 已成功后进入
ContinueAfterSettledTools，下一 provider turn 可能错误使用前一失败 attempt 留下的 `structured` 值进行成功提升。

Recovery 实现必须在创建新 assistant attempt 前清除旧 attempt 的 transient StructuredOutput promotion state，只有当前
成功 attempt 的 StructuredOutput 才能成为最终结果。

## 三、参考实现对照

本问题不是数值算法 bug，不查看上游仓库。参考对象只使用当前仓库内已有契约与实现。

### 3.1 Issue #3 fail-stop 契约

`docs/fixes/session-fix-incomplete-provider-stream.md` 已证明：

- incomplete stream 必须持久化 terminal assistant error；
- partial transcript 必须保留用于审计；
- 同一个 assistant message 不能直接 retry；
- completed tool 不能重放；
- provider-error 必须优先于 compaction/structured success。

Issue #7 必须在这些不变量之上增加恢复，不能撤销它们。

### 3.2 V2 publisher 的 tool evidence

`createLLMEventPublisher()` 已记录：

```text
called
settled
providerExecuted
providerMetadata
```

并通过 owning `assistantMessageID` 持久化 tool call/result。该结构证明 recovery classifier 所需证据可以在不猜测
provider prose 的情况下获得；缺口是没有暴露统一 decision，也没有把 interrupted/persistence failure 纳入状态。

### 3.3 V2 overflow recovery 的 attempt isolation

`packages/core/src/session/runner/llm.ts` 的 context-overflow recovery 已使用新的物理 provider attempt 重建同一逻辑 turn，
且只在没有 durable assistant output/tool execution 时允许。它可作为 SafeRetry 的本地结构参考：

- 新 provider attempt 由 runner 发起；
- 旧 attempt 不在原 publisher 内重试；
- bounded recovery；
- durable output/side effect 是 recovery fence。

Incomplete-stream recovery 需要更细的 tool-settlement分类，但不能复用 context-overflow 的“完全无 durable output”判定替代。

### 3.4 V2 Session spec 的现有约束

`specs/v2/session.md` 已声明：

- 每个 provider turn 只调用一次 `llm.stream(request)`；
- complete local tool call 在 side effect 开始前持久化；
- provider stream 关闭后等待本地 tool fiber；
- abandoned side effects 不得静默重放；
- post-crash continuation recovery 与 provider retry policy 目前是明确 deferred 的 future slice。

Issue #7 正好是该 future slice 的一个有界子集，因此 V2 spec 必须同步更新，不能只改 runner code。

## 四、修复方案

### 4.0 范围与流程分类

本问题跨越公共 LLM failure classification、Legacy SessionProcessor/Prompt、V2 SessionRunner、持久化错误模型和
model-context lowering，属于 workflow §7 的接口/架构层面问题。

本文件经确认后，应先进入 workflow §4 的架构/细化阶段，再编码。建议将实现拆成五个串行单元，每个单元独立红测、
实现、局部回归和审核；不得一次性跨所有模块修改。

Issue #7 是 bug follow-up，因此不自动套用“新增子计划必须走 §6 v2”的硬性规则；但其契约跨度较大，最终仍应执行
独立 subagent 审核与五维审核作为质量门。

### 4.1 公共 provider failure classification

修改 `packages/llm/src/schema/errors.ts`：

```ts
ProviderFailureClassification =
  | "context-overflow"
  | "incomplete-stream"
```

修改 `packages/opencode/src/session/llm/ai-sdk.ts`：

```text
finishReason="other" && rawFinishReason=undefined
  -> provider-error(
       classification="incomplete-stream",
       message=canonical message
     )
```

建议删除该事件上的固定 `retryable:false`，而不是改成 `true`。原因是该布尔值会再次诱导 consumer 把 transport
transience 当成 agent replay safety。Session 层只根据 `classification` 进入副作用恢复分类；其它 provider-error 维持现有
行为。

### 4.2 统一 recovery evidence 与纯分类器

在 core session 层增加一个无副作用的共享模块，例如：

```text
packages/core/src/session/incomplete-stream-recovery.ts
```

数据结构：

```ts
type ToolRecoveryEvidence = {
  id: string
  name: string
  state: "pending" | "running" | "completed" | "error"
  providerExecuted: boolean
  interrupted: boolean
}

type IncompleteStreamRecovery =
  | { type: "safe-retry" }
  | { type: "continue-after-settled-tools" }
  | {
      type: "manual-stop"
      unsettled: Array<{
        id: string
        name: string
        state: ToolRecoveryEvidence["state"]
        providerExecuted: boolean
      }>
    }
```

分类规则：

```text
hasCompleteToolCall
:= exists tool where state in {running, completed, error}
   or providerExecuted=true

allToolsSettled
:= tool count > 0
   and every tool.state in {completed,error}
   and every tool.interrupted=false

SafeRetry
:= not hasCompleteToolCall
   and no providerExecuted evidence
   and no persistence failure

ContinueAfterSettledTools
:= hasCompleteToolCall
   and allToolsSettled
   and no persistence failure

ManualStop
:= otherwise
```

说明：

- 仅 `pending` 且无 providerExecuted 表示 tool input 尚未形成完整调用，不构成外部副作用，可 SafeRetry；
- 真实 tool `error` 是已结算结果，可 continuation；
- cleanup/interruption 形成的 error 不是可信结算，必须 ManualStop；
- 任一 persistence/projection failure 直接 fail closed 到 ManualStop；
- 多工具中只要有一个不确定，整体 ManualStop。

Legacy 与 V2 分别把自己的 tool part/publisher state 映射成该 evidence，但不得各自重新实现分类表。

### 4.3 持久化 incomplete recovery error

必须为 failed assistant 持久化稳定分类，不能依赖 canonical message 文本比较。

建议共享 payload：

```ts
type IncompleteStreamFailure = {
  classification: "incomplete-stream"
  recovery: "safe-retry" | "continue-after-settled-tools" | "manual-stop"
  message: string
  unsettledTools?: Array<{
    id: string
    name: string
    state: "pending" | "running" | "error"
    providerExecuted: boolean
  }>
}
```

Legacy 在 `packages/schema/src/v1/session.ts` 增加 `IncompleteStreamError` named error；V2 在
`packages/schema/src/session-message.ts`/`session-event.ts` 增加对应 error union，而不是把字段塞进 generic
`UnknownError.message`。

持久化该 payload 有三个目的：

1. same-process 和 crash/re-enter 使用同一 recovery decision；
2. message lowering 可以区分 SafeRetry、tool continuation 和普通 error；
3. ManualStop 可以向用户稳定列出 unresolved call ID/name/state。

### 4.4 Legacy SessionProcessor

修改 `packages/opencode/src/session/processor.ts`：

1. `provider-error` 不再丢弃结构化 event；使用专用内部 error 或 terminal state 保留
   `classification/retryable/providerMetadata`；
2. 对 `classification="incomplete-stream"`，在旧 attempt 内不进入 `SessionRetry.policy()`；
3. 从当前 assistant 已持久化 tool parts 生成 `ToolRecoveryEvidence`；若读取/写入失败则 fail closed；
4. 在 cleanup 把 unresolved tool 改写为 interrupted error 之前冻结 recovery decision，或在分类时明确读取
   `interrupted=true`，防止把 cleanup 结果误判为 settled；
5. 持久化 `IncompleteStreamError`；原 assistant 的 partial reasoning/text/tool/usage/snapshot 保留；
6. `process()` 返回值扩展为能表达 recovery transition，例如：

```ts
type Result =
  | "compact"
  | "stop"
  | "continue"
  | "retry-incomplete"
  | "continue-after-settled-tools"
```

7. 现有 generic `Effect.retry()` 只处理普通 API/rate-limit error，不处理 incomplete-stream；
8. ordinary provider error、context overflow、length、content-filter、blocked 和 compaction 优先级保持不变。

### 4.5 Legacy Prompt loop

修改 `packages/opencode/src/session/prompt.ts`：

#### SafeRetry

- 当前 turn 收到 `retry-incomplete` 后，不复用当前 `SessionProcessor`；
- 下一 while iteration 按现有路径创建新的 `MessageID.ascending()` assistant；
- 同一 user message 最多允许 2 次自动 retry，即最多 3 个失败/成功 physical assistant attempts；
- retry count 从 durable history 中同一 `parentID` 的连续 incomplete SafeRetry error 计算，不能只用进程内局部计数，
  以免 crash/resume 后重置上限；
- 使用短指数退避，建议 1s、2s；不要复用无上限的 generic `SessionRetry.policy()`；
- 达到上限后 terminal stop，错误日志明确说明自动重试次数已耗尽；
- 每次 retry 使用新的 assistant ID；原 attempt 不改写、不删除。

#### ContinueAfterSettledTools

- 当前 turn 返回 `continue-after-settled-tools` 后直接进入下一 while iteration；
- persisted-error entry guard 识别相同 recovery classification，允许 crash/re-enter 后继续；
- 不重放旧 provider request，不重新执行旧工具；
- 现有 loop step 计数继续递增，保持 agent max-step/doom-loop 约束。

#### ManualStop

- current-turn 与 persisted-entry 两个 guard 均停止；
- error message 列出 unsettled tool call IDs、names、states 和 providerExecuted 标志；
- 用户发送新消息后仍可按现有 ID ordering 继续会话，但不能自动把旧 partial prose 当成成功历史。

#### StructuredOutput

`structured` 必须改为 attempt-local，或在进入任何 recovery transition 时清空。前一 failed attempt 的
StructuredOutput 值不能被下一 attempt 的正常 stop 分支提升为成功。

### 4.6 Legacy model-context lowering

修改 `packages/opencode/src/session/message-v2.ts`：

- 普通 errored assistant：维持当前整条删除；
- incomplete SafeRetry：整条删除，包括 partial prose/reasoning/pending tool input；
- incomplete ContinueAfterSettledTools：只降低真实 terminal 的 tool call/result；不包含 text、reasoning、step-start、
  pending/running/interrupted tool；
- incomplete ManualStop：自动路径不会调用 provider；用户显式继续时，默认不注入 partial prose/reasoning。若存在可信
  settled tool 与 unresolved tool 混合，也不应只注入部分 settled 子集，因为整体 side-effect history 不完整。

该 lowering 只根据 persisted error/recovery 与 persisted tool parts，不读取 processor 内存 evidence。

### 4.7 V2 publisher 与 SessionRunner

修改：

- `packages/core/src/session/runner/publish-llm-event.ts`
- `packages/core/src/session/runner/llm.ts`
- `packages/core/src/session/runner/to-llm-message.ts`
- `packages/schema/src/session-message.ts`
- `packages/schema/src/session-event.ts`

方案：

1. publisher 保留完整 `ProviderErrorEvent`，并暴露 tool evidence snapshot；
2. provider-error 后仍等待已经启动的本地 tool fibers：
   - 本地工具全部真实 settled 后可 ContinueAfterSettledTools；
   - provider-executed 工具没有 result 时保持 unresolved；
3. 在 `failUnsettledTools()` 把状态投影为 error 前冻结 recovery decision，或给 interruption error 增加明确 uncertain 标记；
4. runner 的单 turn 返回值从单一 `needsContinuation` 扩展为显式 transition；
5. SafeRetry 使用新 publisher，因此自然产生新的 assistant ID；
6. V2 retry count 同样从 durable projected history 计算，最多 2 次，不能因 `run`/进程重启重新获得预算；
7. ContinueAfterSettledTools 复用现有 inner continuation loop，但 recovery decision 不得被
   `hasProviderError()` 一律压成 false；
8. V2 `toLLMMessages()` 对 incomplete failed assistant 使用与 Legacy 相同 lowering：
   - SafeRetry 不注入旧 attempt；
   - Continue 只注入 settled tools；
   - partial text/reasoning 不注入；
9. raw provider stream failure 若能映射为 incomplete-stream，也走相同分类；其它 LLMError 保持普通 terminal failure。

### 4.8 用户可观察错误

ManualStop 建议固定 diagnostic：

```text
Provider stream ended before the attempt could be safely recovered.
Unsettled tool calls:
- <id> <name> state=<state> providerExecuted=<true|false>
Inspect side effects before continuing.
```

SafeRetry 达到上限：

```text
Provider stream remained incomplete after 2 automatic retries.
No tool side effects were detected, but the retry limit was reached.
```

ContinueAfterSettledTools 不隐藏原错误：旧 assistant transcript 仍显示 incomplete error；新的 assistant turn 继续完成
用户任务。

### 4.9 明确不采用的方案

#### 只把 `retryable:false` 改成 `true`

Legacy 会丢字段；若接入 generic retry，还会在同一个 assistant/processor 上重放并混写 parts。

#### 对所有 incomplete 直接 Effect.retry

无法隔离 attempt ID，可能重复工具和 provider-executed side effect。

#### 只要看到 tool-call 就 continuation

running、provider-executed 无 result、部分结算都缺少可信 model-facing result。

#### cleanup 后检查 `status in {completed,error}`

会把 `interrupted=true` 的 uncertain side effect 错判为 settled。

#### 仅修改 Prompt 顶部 error guard

当前 turn 的 post-process error guard仍会 break；message lowering 也仍然错误。

#### 只实现 Legacy 或只实现 V2

会让相同 LLM failure 在两条 runner 上产生不同安全语义，不满足 Issue 验收标准。

## 五、正确性论证

### 5.1 根因消除

- provider adapter 产生稳定 `incomplete-stream` classification，消除基于文案猜测；
- 共享 classifier 把 transport failure 与 side-effect safety 分离；
- runner 外层创建新 assistant attempt，消除 same-message replay；
- persisted recovery payload 保证 same-process、crash/re-enter 和 model lowering 使用同一事实；
- recovery-aware lowering 防止 partial prose 污染，同时保留 settled tool result；
- interrupted/persistence failure fail closed，避免把状态不明误判为安全。

### 5.2 核心不变量

```text
SafeRetry
=> no complete tool call
and no provider-executed side effect
and no persistence failure
```

```text
SafeRetry transition
=> new assistant ID
and old assistant remains error
and old partial prose/reasoning absent from new model request
```

```text
ContinueAfterSettledTools
=> tool count > 0
and every tool has a durable terminal result/error
and no interrupted/uncertain tool
```

```text
ContinueAfterSettledTools transition
=> every old tool executes at most once
and next model request contains the settled tool call/result
and old incomplete prose/reasoning is absent
```

```text
exists uncertain tool or persistence failure
=> ManualStop
```

```text
ManualStop
=> no automatic provider retry
and no automatic continuation
```

```text
SafeRetry failures for one logical user turn > 2 retries
=> terminal stop
```

```text
same evidence in Legacy and V2
=> same recovery classification
```

### 5.3 副作用安全

SafeRetry 的前置条件排除所有完整 tool call 和 provider-executed evidence，因此 replay 最多增加 provider token/cost，不会重放
已知外部工具操作。

ContinueAfterSettledTools 不 replay provider request，也不执行旧工具，只消费持久化 result。真实 completed/error 结果是自然 agent
loop 已有 continuation 所需的完整上下文。

ManualStop 对所有不确定状态 fail closed；即使工具实际上已经成功，也宁可要求人工检查，不冒重复执行风险。

### 5.4 Attempt identity 与 bounded retry

新 assistant message 是每个 physical provider attempt 的 durable identity。按同一 user `parentID` 从历史计算 retry count，保证进程重启
或显式 resume 不会绕过上限。

原 attempt 的 audit transcript 保持不变；新 attempt 的 request 不包含旧 partial output，因此不会把失败内容当成完成历史。

### 5.5 无回归引入

必须保持：

- Issue #3：incomplete stream 永远不是成功；
- normal `stop`、`tool-calls`、`length`、`content-filter` 和明确 API error 行为不变；
- context-overflow compaction recovery 不被 incomplete retry 取代；
- ordinary API/rate-limit retry 继续使用现有 policy；
- compaction cutoff 继续保留 canonical provider-error；
- completed tool 不重复执行；
- StructuredOutput 只由当前成功 attempt 提升；
- 用户在 ManualStop 后发送新消息仍可继续 session；
- no-tool retry 达到上限后不无限循环。

## 六、测试用例清单

以下测试均需先以红测或现有行为锁证明差异，再实施 production code。当前环境缺少 Bun，尚未运行。

| 类型 | 用例描述 | 状态 |
|---|---|---|
| Schema/LLM | `ProviderFailureClassification` 接受 `incomplete-stream`，拒绝未知值 | 待加 |
| Adapter | raw-missing 产生 `provider-error(classification="incomplete-stream")` | 待改 |
| Classifier | 无工具、只有 partial text/reasoning -> SafeRetry | 待加 |
| Classifier | 只有 pending tool input、无 providerExecuted -> SafeRetry | 待加 |
| Classifier | 单个 completed local tool -> ContinueAfterSettledTools | 待加 |
| Classifier | 单个真实 tool error -> ContinueAfterSettledTools | 待加 |
| Classifier | completed provider-executed tool result -> ContinueAfterSettledTools | 待加 |
| Classifier | running/pending complete call -> ManualStop | 待加 |
| Classifier | provider-executed 无 terminal result -> ManualStop | 待加 |
| Classifier | `error + interrupted=true` -> ManualStop | 待加 |
| Classifier | 多工具部分结算 -> ManualStop | 待加 |
| Classifier | persistence failure -> ManualStop | 待加 |
| Legacy/Processor | incomplete event 保留 classification，不降级为 generic UnknownError | 待加 |
| Legacy/SafeRetry | no-tool incomplete 创建新 assistant ID 并自动重试 | 待加 |
| Legacy/SafeRetry | partial reasoning/text 保留在旧 attempt，但不进入 retry request | 待加 |
| Legacy/SafeRetry | retry 成功后自动完成，无需新 user message | 待加 |
| Legacy/SafeRetry | 连续 3 次 incomplete 后停止；总自动 retry 为 2 | 待加 |
| Legacy/SafeRetry | crash/re-enter 不重置 retry budget | 待加 |
| Legacy/Continue | completed tool 只执行一次，下一 request 可见 tool result | 待加 |
| Legacy/Continue | tool error 作为 settled result 进入下一 request | 待加 |
| Legacy/Continue | incomplete assistant 仍为 error，partial prose 不进入 request | 待加 |
| Legacy/Manual | running/interrupted tool 不 retry、不 continue，diagnostic 列出 ID/name/state | 待加 |
| Legacy/Structured | failed attempt 的 StructuredOutput 不污染下一 attempt | 待加 |
| Legacy/Context | 普通 errored assistant 过滤行为不变 | 待回归 |
| V2/SafeRetry | no-tool provider-error 使用新 assistant ID 重试并受 2 次上限约束 | 待加 |
| V2/Continue | provider error 后本地 tool fiber settled，只执行一次并 continuation | 待加 |
| V2/Continue | completed hosted tool result 可 continuation，不重复 provider tool | 待加 |
| V2/Manual | hosted tool 无 result -> ManualStop | 待改 |
| V2/Manual | mixed settled/unsettled tools -> ManualStop | 待加 |
| V2/Context | errored incomplete partial text/reasoning 不进入下一 request | 待加 |
| Cross-runner | 同一 evidence 表驱动 Legacy/V2 得到相同 decision | 待加 |
| Regression | Issue #3 原始 incomplete/compaction crossover 测试全绿 | 待回归 |
| Regression | normal stop/tool-calls/length/content-filter/API error 全绿 | 待回归 |
| E2E/CLI | no-tool incomplete 自动 retry 成功，CLI 无需用户输入 | 待加 |
| E2E/CLI | retry exhaustion 非零退出且无无限请求 | 待加 |
| E2E/Tool | completed bash side effect marker 只有一行，随后 continuation 成功 | 待加 |
| E2E/Manual | uncertain tool 时无后续 provider request，错误含工具列表 | 待加 |
| Static | `packages/llm`、`packages/schema`、`packages/core`、`packages/opencode` typecheck | 待运行 |

计划验证命令需在 Bun 可用后按 package 执行，不能从仓库根目录运行测试：

```bash
cd packages/llm && bun test <target files>
cd packages/schema && bun run typecheck
cd packages/core && bun test test/session-runner.test.ts && bun run typecheck
cd packages/opencode && bun test --timeout 30000 <target files> && bun run typecheck
```

## 七、代码更新清单

以下为修复前计划，实际实施需在架构/细化确认后逐单元推进。

| 文件 | 函数/区域 | 计划改动 | 状态 |
|---|---|---|---|
| `packages/llm/src/schema/errors.ts` | `ProviderFailureClassification` | 增加 `incomplete-stream` | 待改 |
| `packages/llm/src/schema/events.ts` | `ProviderErrorEvent` | 复用 classification 契约，保持 event 结构 | 待核对 |
| `packages/opencode/src/session/llm/ai-sdk.ts` | raw-missing 分支 | 发出 stable classification，不决定 replay | 待改 |
| `packages/core/src/session/incomplete-stream-recovery.ts` | 新共享模块 | 定义 evidence、decision、纯分类器和诊断格式 | 待加 |
| `packages/schema/src/v1/session.ts` | assistant error union | 增加 durable incomplete recovery error | 待改 |
| `packages/schema/src/session-message.ts` | V2 assistant error | 增加 durable incomplete recovery payload | 待改 |
| `packages/schema/src/session-event.ts` | `Step.Failed` | 允许投影 typed incomplete error | 待改 |
| `packages/opencode/src/session/processor.ts` | provider-error/halt/process/cleanup | 保留结构化 error、计算 decision、返回 transition | 待改 |
| `packages/opencode/src/session/prompt.ts` | entry/post-process/attempt loop | 新 attempt retry、tool continuation、manual stop、bounded count | 待改 |
| `packages/opencode/src/session/message-v2.ts` | assistant lowering | recovery-aware tool-only context | 待改 |
| `packages/core/src/session/runner/publish-llm-event.ts` | publisher evidence/failure | 暴露 tool evidence，保留 provider classification | 待改 |
| `packages/core/src/session/runner/llm.ts` | turn transition/run loop | 统一 decision、bounded new-attempt retry/continuation | 待改 |
| `packages/core/src/session/runner/to-llm-message.ts` | errored assistant lowering | 丢 partial prose；Continue 只保留 settled tools | 待改 |
| `packages/core/src/session/message-updater.ts` | Step.Failed projection | 投影 typed incomplete error | 待核对/可能改 |
| `packages/opencode/test/session/llm.test.ts` | adapter tests | classification contract | 待改 |
| `packages/opencode/test/session/processor-effect.test.ts` | processor tests | decision/persistence/interrupted/persistence-failure | 待加 |
| `packages/opencode/test/session/prompt.test.ts` | loop tests | SafeRetry/Continue/Manual/StructuredOutput | 待加/翻转 |
| `packages/opencode/test/session/message-v2.test.ts` | lowering tests | tool-only recovery context | 待加 |
| `packages/opencode/test/session/retry.test.ts` | retry contract | 保证 incomplete 不进入 same-message generic retry | 待改 |
| `packages/core/test/session-runner.test.ts` | V2 runner tests | 三类 recovery、retry bound、context isolation | 待加/翻转 |
| `packages/opencode/test/cli/run/run-process.test.ts` | E2E | 自动恢复、tool exactly-once、ManualStop | 待加 |

建议串行实施单元：

1. **共享契约单元**：classification、typed error、纯 classifier 与表驱动测试；
2. **Legacy Processor 单元**：结构化 error、decision、persistence 与 processor 红测；
3. **Legacy Prompt/context 单元**：new-attempt retry、tool continuation、bounded count、StructuredOutput 与 E2E；
4. **V2 Runner 单元**：publisher evidence、turn transition、context lowering 与 runner 测试；
5. **整体验证单元**：CLI/tool E2E、Issue #3 全回归、四 package typecheck、独立审核与文档回填。

每个单元完成后停止，报告结果并等待确认，再进入下一单元。

## 八、文档更新清单

| 文档路径 | 计划更新 | 状态 |
|---|---|---|
| `docs/fixes/session-fix-incomplete-stream-recovery.md` | 本修复八部分计划、实施状态、测试证据和最终审核 | 已创建草案，待确认 |
| `docs/fixes/session-fix-incomplete-provider-stream.md` | 增加 Issue #7 follow-up 链接，说明 no-retry 契约被有界恢复扩展但 Issue #3 安全不变量不变 | 待改 |
| `specs/v2/session.md` | 将 provider incomplete recovery 从 deferred 更新为明确三态契约、attempt isolation 和 bounded retry | 待改 |
| `docs/test-reports/session-incomplete-stream-recovery.md` | 记录分层测试、回归、请求/副作用计数和 typecheck 结果 | 实施后待加 |
| `CLAUDE.md` | 仅在实施中发现可复用的项目级经验教训时更新“已知限制”；不写代码可推导事实 | 条件性 |
| `docs/devlog/2026-08-07-issue-7-incomplete-stream-recovery.md` | 完成关键里程碑后记录决策与度量 | 实施后待加 |

本次会改变 provider failure 后的可观察行为、持久化错误分类和 V2 recovery contract，因此不允许写“无文档更新”。

## 确认门

在用户确认本方案前：

- 不修改 production code；
- 不翻转或新增行为测试；
- 不实现自动 retry/continuation；
- 不提交或推送分支。

确认后下一步不是直接编码，而是按 workflow §4 先补充架构与函数级细化，重点确认：

1. durable incomplete error 的具体 schema；
2. retry budget 的历史计算规则；
3. Legacy/V2 共用 classifier 的模块位置和导出边界；
4. ManualStop 的用户可见诊断；
5. StructuredOutput 在 ContinueAfterSettledTools 下的精确语义。
