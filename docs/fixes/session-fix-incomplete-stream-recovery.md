# Session 不完整流恢复：根因分析与修正方案

> Issue: [#7](https://github.com/lihaokun/opencode/issues/7)
>
> 状态：修订后的实现前方案，尚未修改生产代码。
>
> 审视日期：2026-08-10。
>
> 证据范围：当前本地仓库与 Issue #7 正文；未查看上游仓库、上游分支或上游实现。
>
> 验证限制：当前环境没有 `bun`，本文结论来自静态代码审查，测试计划尚未实际执行。

## 结论摘要

Issue #7 不能通过“把 incomplete-stream 改成普通可重试错误”安全解决。恢复决策必须独立于通用 transport retry，并且必须在以下事实已经确定后执行：

1. 本次 provider turn 确实以 incomplete stream 结束；
2. 已启动的本地工具均已等待并完成持久化；
3. 分类依据来自持久化投影，而不是尚未提交的内存布尔值；
4. provider 侧不存在未观测副作用，或对应 action 受覆盖整个 attempt replay 的幂等契约/覆盖 durable prefix 的续传契约保护；
5. 本地工具没有被提供，或 runtime 已证明 durable-before-execute；
6. settled-tool continuation context 可以按目标 provider protocol 合法构造；
7. 自动恢复预算未耗尽；
8. 下一次 provider 调用使用新的 assistant attempt，并且不会覆盖失败 attempt。

建议保留三种用户可见结果，但收紧自动恢复条件：

```text
IncompleteStreamRecovery
├── SafeRetry
├── ContinueAfterSettledTools
└── ManualStop
```

其中“没有观察到 `providerExecuted`”不能证明“provider 没有执行副作用”。在缺少 provider 级安全围栏时必须降级为 `ManualStop`。

---

## 1. 现象与复现

### 1.1 Issue #7 要求

根据 Issue #7 正文，目标行为是：

- 没有完整 tool call、没有 provider 侧副作用时，自动重试；
- 已出现 tool call，但全部工具已结算时，从已结算工具上下文继续；
- 存在 `pending` / `running` / 中断工具或其他不确定状态时，停止并保留错误；
- 每次恢复使用新的 assistant message / attempt；
- 失败 attempt 保留错误，不伪装成成功；
- 自动恢复有严格上限，避免永久循环；
- Legacy 与 V2 路径的语义一致。

以上是 Issue #7 的需求，不是当前代码已经满足的事实。

### 1.2 Legacy 当前事实

Legacy AI SDK 适配器已识别一种 canonical incomplete stream：

```ts
if (event.finishReason === "other" && event.rawFinishReason === undefined) {
  state.terminalFailure = true
  events.push(
    LLMEvent.providerError({
      message: incompleteStreamMessage,
      retryable: false,
    }),
  )
}
```

证据：`packages/opencode/src/session/llm/ai-sdk.ts:120-127`。

该错误随后会终止当前 attempt：

- `SessionProcessor` 将 `provider-error` 转成普通 `Error`，丢失 classification 与 retry 元数据：`packages/opencode/src/session/processor.ts:444-445`；
- 当前 processor retry 边界位于 `packages/opencode/src/session/processor.ts:727-745`，但 canonical incomplete-stream 错误不会进入通用重试；
- `SessionPrompt` 在当前 attempt 出错后执行通用 break：`packages/opencode/src/session/prompt.ts:1301`；
- 下一次进入循环时，持久化错误 guard 也会停止：`packages/opencode/src/session/prompt.ts:1100-1111`；
- `packages/opencode/test/session/retry.test.ts` 已明确断言 canonical incomplete-stream unknown error 不走通用 retry。

因此 Legacy 当前是 fail-stop，而不是自动恢复。

Legacy processor 还会对没有可信 final step settlement 的 clean EOF 做路径无关检查：`packages/opencode/src/session/processor.ts:580-600`。现有测试覆盖 empty、final-only 与 multi-step-incomplete：`packages/opencode/test/session/processor-effect.test.ts:856-893`。

Legacy tool part 的关键持久化位置是：

- pending：`packages/opencode/src/session/processor.ts:258-274`；
- running：`packages/opencode/src/session/processor.ts:353-374`；
- completed：`packages/opencode/src/session/processor.ts:182-205`；
- error：`packages/opencode/src/session/processor.ts:208-225`；
- cleanup/interrupted：`packages/opencode/src/session/processor.ts:602-660`。

但是这些位置不能证明 Legacy AI SDK 路径“先持久化 call、后执行工具”。AI SDK 当前负责 tool dispatch：`packages/opencode/src/session/llm.ts:279-283`；本地工具副作用发生在 SDK 调用的 `execute()` 回调中：`packages/opencode/src/session/tools.ts:102-129`；仓库的 race reproducer 明确记录工具可能在 processor 收到事件前执行：`packages/opencode/test/session/snapshot-tool-race.test.ts:4-12`。因此 Legacy 要安全自动恢复，必须新增 durable-before-execute handshake，或在提供了可执行本地工具时把 replay fence 视为 unknown。

### 1.3 V2 当前事实

V2 对显式 `provider-error` 已采取 fail-stop：

- publisher 收到 `provider-error` 后调用 `failAssistant()`：`packages/core/src/session/runner/publish-llm-event.ts:404-407`；
- runner 在 provider error 后阻止 continuation，并失败未结算工具：`packages/core/src/session/runner/llm.ts:338-345`。

V2 对原始 `LLMError` 流失败也会失败 assistant：`packages/core/src/session/runner/llm.ts:279-294`。

但是 V2 尚未覆盖“stream 正常 drain，却没有 `step-finish`”的完整性检查：

- `stepSettlement` 只由 `step-finish` 设置：`packages/core/src/session/runner/publish-llm-event.ts:396-401`；
- runner 仅在 `stepSettlement` 存在时发布 `Step.Ended`：`packages/core/src/session/runner/llm.ts:316-337`；
- 当 stream 是 Success、没有 provider error、也没有 `stepSettlement` 时，runner 仍可从 `runTurnAttempt()` 成功返回：`packages/core/src/session/runner/llm.ts:340-345`。

当前测试 `durably fails a hosted tool left unresolved at normal provider EOF` 只证明未返回结果的 hosted tool 会被标记失败：`packages/core/test/session-runner.test.ts:3197-3219`。它没有证明 assistant 会被标记为 incomplete-stream，也没有证明 partial text / reasoning 或已结算本地工具不会被当成成功 continuation。

因此，不能说当前 Legacy 与 V2 已经具有统一的 incomplete-stream fail-stop 行为。Issue #3 的 canonical 检测证据只直接覆盖 Legacy AI SDK 路径；V2 需要补充自己的 stream-settlement 检查。

### 1.4 静态复现场景

实现前至少要固定以下场景：

| 场景 | 当前 Legacy | 当前 V2 | 目标 |
|---|---|---|---|
| partial text 后 canonical incomplete | 持久化错误并停止 | 取决于事件来源；clean EOF 可漏检 | 安全围栏成立时新 attempt 重试，否则 ManualStop |
| reasoning-only 后 incomplete | 持久化错误并停止 | clean EOF 可漏检 | 同上 |
| 空流或只有 `finish`、没有 `step-finish` | processor 已写 error 并停止，但还是 generic UnknownError | 可成功 drain | 两条路径都必须稳定分类为 incomplete |
| 本地工具已 completed，随后 incomplete | 工具执行一次并停止 | 可能 continuation，未先分类 incomplete | 仅在 replay fence 安全且协议闭包可构造时继续；工具不得重放 |
| hosted tool call 无结果后 EOF | 不适用或由 adapter 决定 | tool 变 error，assistant 未必失败 | 保留不确定来源并 ManualStop |
| tool pending/running 后 incomplete | cleanup 标记 interrupted | cleanup 目前投影普通 error | 保留 interruption/uncertainty 并 ManualStop |
| StructuredOutput partial 后 incomplete | 保持错误 | V2 尚无对应能力 | 不得把旧 attempt 的值晋升为成功 |
| 持久化失败 | 当前执行失败 | 当前执行失败 | 当前进程 fail closed，绝不自动发起下一次 provider 调用 |

---

## 2. 根因分析

### 2.1 incomplete-stream 信号没有形成跨路径的类型化契约

当前 `ProviderFailureClassification` 只有 `context-overflow`：

- `packages/llm/src/schema/errors.ts:4-5`。

`ProviderErrorEvent` 支持可选 classification，但 canonical Legacy adapter 没有填写；V2 clean EOF 也不会产生 provider-error。

同时，classification 当前只直接出现在 `InvalidRequestReason`：`packages/llm/src/schema/errors.ts:34-40`。`TransportReason` 与 `InvalidProviderOutputReason` 没有 classification：`packages/llm/src/schema/errors.ts:122-145`。因此不能假设所有 V2 raw stream failure 都能自动携带 `incomplete-stream`。

结论：需要统一的 `incomplete-stream` 类型化信号，但必须分别接入：

- Legacy AI SDK canonical adapter；
- V2 protocol/route 能明确识别的异常；
- V2 runner 对成功 drain 但缺少 `step-finish` 的本地完整性检查。

### 2.2 transport retryability 与 agent replay safety 被混为一谈

“网络错误可重试”不等于“整个 agent attempt 可安全重放”。

一个 attempt 可能已经：

- 持久化 partial text / reasoning；
- 发出完整本地 tool call；
- 执行有副作用的本地工具；
- 触发 provider-hosted 工具；
- 产生了 provider 侧操作，但相关事件在断流中未到达客户端。

因此不能把 incomplete stream 加入 `SessionRetry.policy()` 后直接重跑同一个 processor。通用 retry 位于 `packages/opencode/src/session/processor.ts:727-745`，它发生在 Prompt 层检查持久化工具状态之前，无法证明整个 attempt 的重放安全。

本方案明确决定：

- 保留 incomplete-stream 的 `retryable: false`，阻止通用 transport retry；
- 由专用恢复分类器决定是否创建新的 assistant attempt；
- classification 与 `retryable` 是正交信息。

删除 `retryable: false` 不是实现 Issue #7 的必要条件，也不应在没有新的 retry 边界证明前执行。

### 2.3 “没有观察到工具事件”不能证明没有副作用

存在两类独立的不确定性。

**Provider-hosted 副作用：**V2 只有在收到 tool event 后才知道 `providerExecuted`：

- publisher 在 `tool-call` 时记录：`packages/core/src/session/runner/publish-llm-event.ts:313-334`；
- LLM 事件 schema 的 `providerExecuted` 是可选字段。

如果 provider 已执行 hosted tool，但承载 call/result 的流片段丢失，客户端看到的仍可能是“没有 providerExecuted 证据”。

**Legacy 本地工具副作用：**AI SDK 可以在 processor 收到 `tool-call` event 之前调用本地工具。`packages/opencode/test/session/snapshot-tool-race.test.ts:4-12` 是该时序的现有 reproducer。因此 Legacy 的“没有 durable tool part”也不能证明本地工具尚未执行。

以下推理在两种情况下都无效：

```text
没有观察到 tool evidence
=> 没有副作用
=> 可以安全重试
```

自动恢复必须依赖实际请求 dispatch 前确定并持久化的 attempt replay fence：

```ts
type DispatchTarget = {
  providerID: string
  routeID: string
  protocol: string
  modelID: string
  modelFamily?: string
}

type ProviderSafetyDomain = Omit<DispatchTarget, "modelID"> & {
  modelID?: string // provider 契约若只在单一 model 内有效则必填
}

type ProviderRecoveryProof =
  | { type: "none-needed" }
  | { type: "idempotency"; domain: ProviderSafetyDomain; key: string }
  | {
      type: "continuation"
      domain: ProviderSafetyDomain
      cursor: string
      providerPrefixVersion: string
    }

type AttemptReplayFence = {
  provider:
    | { type: "no-provider-side-effects-offered" }
    | {
        type: "provider-idempotency-protected"
        scope: "entire-attempt-replay"
        domain: ProviderSafetyDomain
        key: string
      }
    | {
        type: "provider-continuation-capable"
        scope: "after-durable-prefix"
        domain: ProviderSafetyDomain
      }
    | { type: "unknown" }
  localTools:
    | { type: "none-offered" }
    | { type: "durable-before-execute" }
    | { type: "unknown" }
}
```

证据要求：

- `provider.no-provider-side-effects-offered`：实际请求没有启用 provider-executed/hosted 能力；
- `provider.provider-idempotency-protected`：adapter 有明确、可测试的 provider 契约，同一稳定 idempotency key 同时覆盖原 assistant attempt、其 recovery replay 以及两者内部的全部 physical provider requests；planned recovery target 必须属于相同 `ProviderSafetyDomain`；当前本地代码没有这种通用证明，不能默认使用；Legacy AI SDK 若只得到单次 HTTP request 级幂等，而内部 continuation requests 没有逐次 durable evidence，则该 fence 必须是 `unknown`；
- `provider.provider-continuation-capable`：dispatch 前只能证明 provider/route 具备受保护续传能力；实际 cursor 必须在 stream 中产生并随其对应 durable prefix 持久化。只有 capability、durable cursor、cursor 对应的 providerPrefixVersion、该 prefix 与完整 recoverySourceVersion 的祖先关系，以及 planned continuation target domain 全部匹配时，Continue 才安全。当前本地代码没有这种通用契约；
- `localTools.none-offered`：实际请求没有提供可执行本地工具；
- `localTools.durable-before-execute`：runtime 保证完整 call 已 durable commit 后才允许执行副作用。V2 当前具有该边界：`packages/core/src/session/runner/llm.ts:242-271`；Legacy AI SDK 当前不具有；
- 无法证明任一维度时，该维度必须是 `unknown`。

Legacy 若要在提供本地工具时自动恢复，必须先把 `tools.ts` 的 AI SDK `execute()` 与 `SessionProcessor` 连接成 durable-before-execute handshake：先创建并提交 owning assistant 的 running tool part，提交失败则不得调用 `item.execute()`。若不做这项架构修改，只能 ManualStop。

该 fence 不仅约束 `SafeRetry`，也约束 `ContinueAfterSettledTools`。即使所有“已观察工具”都结算，也不能排除断流前还有一个未观察到的 hosted action 或 Legacy local action。

### 2.4 V2 内存 tool flags 不是持久化证据

publisher 当前有多类“先改内存、后发布 durable event”的状态：

- `assistantMessageID` / `assistantActive` 在 `Step.Started` 发布前设置：`packages/core/src/session/runner/publish-llm-event.ts:74-84`；
- tool map 与 fragment start state 在 `Tool.Input.Started` 发布前创建：`packages/core/src/session/runner/publish-llm-event.ts:165-183`；
- `assistantActive=false` / `assistantFailed=true` 在 `Step.Failed` 发布前设置：`packages/core/src/session/runner/publish-llm-event.ts:199-210`；
- `called = true` 在 `Tool.Called` 发布前：`packages/core/src/session/runner/publish-llm-event.ts:319-334`；
- `settled = true` 在 `Tool.Success` / `Tool.Failed` 发布前：`packages/core/src/session/runner/publish-llm-event.ts:342-373`、`376-393`；
- `failUnsettledTools()` 也在 `Tool.Failed` 发布前标记 settled：`packages/core/src/session/runner/publish-llm-event.ts:213-231`。

如果 `events.publish()` 失败，内存状态可能表示 assistant/tool/fragment 已开始或已结算，但 durable event 与 projection 并未成功提交。

结论：

1. 表示 durable 生命周期的内存状态必须在 publish 成功后更新，或在失败时显式回滚；不仅是 called/settled；
2. 恢复分类的权威输入必须来自 publish 成功后的 durable projection reload；
3. 任一必需持久化失败时，当前执行直接 fail closed，不能调用新的 provider attempt；
4. failure-injection 测试必须覆盖 `Step.Started`、`Step.Failed`、`Tool.Input.Started`、fragment start、`Tool.Called` 与 tool settlement；
5. 如果存储本身不可用，就不能声称已经“持久化 ManualStop”。此时只能保证当前进程不重试；持久化恢复状态必须等存储恢复后才能记录。

### 2.5 V2 会丢失 interrupted / uncertain 来源

V2 tool error schema 只有普通 `error`，没有 interruption/uncertainty 标记：

- `packages/schema/src/session-message.ts:110-138`。

两条 cleanup 路径都需要纳入设计：

- 当前 turn 的 `failUnsettledTools()`：`packages/core/src/session/runner/publish-llm-event.ts:213-231`；
- 新进程/新 run 启动前的 `failInterruptedTools()`：`packages/core/src/session/runner/llm.ts:119-137`，调用点 `packages/core/src/session/runner/llm.ts:390`。

如果 pending/running 工具只被投影成普通 terminal error，后续分类器可能把它误认为“已安全结算”。必须持久化区分：

- 工具明确返回的 error；
- runner 中断执行形成的 error；
- provider 未返回 hosted result 形成的 uncertain error。

后两者都必须阻止自动恢复。

### 2.6 attempt identity 在 Legacy 与 V2 中含义不同

必须区分三个层级：

1. **logical recovery chain**：同一份用户工作触发的一串 incomplete-stream 恢复；
2. **assistant attempt**：一个持久化 assistant message 及其外层 processor/runner 执行；
3. **physical provider request**：实际发给 provider 的一次 HTTP/stream 请求。

Legacy 的一个 assistant message / `SessionProcessor.process()` 可能因 AI SDK client-side tool continuation 发出多个 physical provider requests。因此 Legacy assistant ID 不能被描述为“一个物理 provider attempt ID”。

V2 当前每个 runner turn 明确调用一次 `llm.stream(request)`：`packages/core/src/session/runner/llm.ts:205-233`，其 assistant attempt 与 physical request 更接近一一对应。

恢复上限应按 logical recovery chain 中的自动恢复次数计数，而不是把 Legacy assistant ID 当作 physical request 计数器。本修复不新增独立的全局 physical-request budget；当前本地代码也没有证明 AI SDK 内部 multi-step physical requests 受外层 Prompt step counter 约束。测试应记录具体 fixture 的 provider hit 数以发现意外 replay，但不能把 recovery ordinal 误称为 physical request 上限。若产品需要 physical-request hard limit，必须另行设计 dispatch-level counter/guard。

### 2.7 缺少 durable recovery-chain 与实际 dispatch 证据

V2 assistant schema 当前没有 `parentID`、logical-turn ID、recovery-chain ID、retry ordinal 或 replay fence：

- `packages/schema/src/session-message.ts:164-189`。

V2 `Step.Started` 只保存 assistant ID、agent、model 与 snapshot：`packages/schema/src/session-event.ts:148-159`。但工具 definitions 与 provider options 是 dispatch 前动态组装的：`packages/core/src/session/runner/llm.ts:199-214`。

Legacy assistant 同样没有 recovery chain/replay fence；实际工具集合在 Prompt 中动态解析。若 failure 与 decision 之间发生进程退出，不能用后来可能已经变化的配置、插件、权限或 tool registry 重算原请求的安全围栏。

`session.next.retried` 虽然有 `attempt`，但没有 assistant/logical-chain 关联，并且 projector 当前忽略它。仅靠现有 history 无法证明跨重新进入的 retry budget或原请求的 replay safety。

结论：在 provider dispatch 前、且在实际请求与工具能力完成 materialization 后，必须随 assistant attempt 持久化不可变 dispatch evidence，例如：

```ts
type RecoveryChain = {
  chainID: string
  ordinal: number // 首次 incomplete 为 0；每次 incomplete-triggered dispatch 递增
}

type AttemptDispatchEvidence = {
  target: DispatchTarget
  replayFence: AttemptReplayFence
  capabilities: {
    localToolsOffered: boolean
    providerSideEffectsOffered: boolean
  }
  recovery?: RecoveryChain
  recoveryProof?: ProviderRecoveryProof
}
```

分类器必须读取该 attempt 自己的 durable dispatch evidence，不能根据当前配置重新计算。第一次 incomplete failure 可用该失败 assistant ID 确定性创建 `chainID`、`ordinal=0`；后续 ordinary tool continuation 传播相同 recovery chain 但不递增 ordinal，只有 incomplete-triggered 新 dispatch 才递增。新用户输入创建新 chain。若进程在 `Step.Started`/dispatch evidence 已持久化后、terminal settlement 之前崩溃，重新进入时看到的是 dispatch ambiguity，必须 `ManualStop`，不能静默再次发送。

该设计只解决已持久化 attempt 的链、预算与请求前围栏，不声称解决任意时刻的 provider-dispatch crash recovery。`specs/v2/session.md:165` 已明确把一般 post-crash continuation recovery 延后；本修复应保留该边界。

### 2.8 当前模型上下文 lowering 无法表达恢复语义

Legacy 对普通非 abort 的 errored assistant 整体跳过：

- `packages/opencode/src/session/message-v2.ts:248-255`。

这适合 `SafeRetry`，但会同时丢掉 `ContinueAfterSettledTools` 所需的完整 tool call/result。

V2 当前保留 errored assistant 的 text/reasoning，只是在有 error 时不复用 provider metadata：

- `packages/core/src/session/runner/to-llm-message.ts:71-99`。

这会把 incomplete attempt 的 partial prose/reasoning 注入下一次请求。

但也不能简单“删除全部 reasoning”。仓库已有证据表明 provider-native reasoning metadata 需要按模型复用：

- V2 reasoning 持久化包含 `providerMetadata` 与 completion time：`packages/schema/src/session-message.ts:147-157`；
- V2 测试验证 signed/encrypted reasoning 会在后续请求恢复：`packages/core/test/session-runner.test.ts:1511-1565`；
- V2 spec 规定 provider-native reasoning 只在历史模型与 continuation 模型一致时复用：`specs/v2/session.md:50-52`。

但当前 durable `completed/end` 也不足以证明 reasoning 是 provider 正常结束：

- Legacy 正常 `reasoning-end`、`step-finish` 强制收尾与 cleanup 都会写 `time.end`：`packages/opencode/src/session/processor.ts:229-235`、`459-465`、`625-631`；
- V2 `step-finish` 会调用 generic `flush()`，stream ensuring/cleanup 也调用同一 flush；开放 reasoning 都通过与正常 end 相同的 `Reasoning.Ended` event 持久化：`packages/core/src/session/runner/publish-llm-event.ts:109-117`、`132-162`、`396-401`；
- projector 对这些来源都设置 `time.completed`：`packages/core/src/session/message-updater.ts:364-370`；
- reasoning schema 没有 `provider-end` / `step-boundary-flush` / `cleanup-flush` provenance：`packages/schema/src/session-message.ts:147-157`。

因此需要 sequence-aware 的“工具续传闭包”，并新增三态 durable reasoning completion provenance。只有明确由 provider `reasoning-end` 关闭、且具有协议要求的最终 signature/encrypted metadata 的 block 才默认可进入闭包；step-boundary/cleanup 强制 flush 的 block 必须排除，除非具体 protocol 提供独立、可测试的完整性证明。仅检查 `time.completed` 不充分。

### 2.9 StructuredOutput 状态跨 attempt 泄漏

Legacy `structured` 定义在主 while loop 外：`packages/opencode/src/session/prompt.ts:1084`，成功回调会写入该变量：`packages/opencode/src/session/prompt.ts:1252-1258`，随后在 `packages/opencode/src/session/prompt.ts:1303-1307` 被晋升为成功结果。

如果 incomplete-stream 恢复在同一个 Prompt loop 中创建新 attempt，旧 attempt 的 structured 值可能被新 attempt 误用。恢复前必须把 attempt-local StructuredOutput 状态重置，最好把变量移入 attempt 作用域。

---

## 3. 参考对照

本次不查看上游仓库。参考只包括当前本地实现、当前测试、V2 spec 与 Issue #7 正文。

### 3.1 Issue #3 已建立的本地不变量

本地 Legacy 实现与测试已经建立：

- incomplete stream 不能报告成功；
- partial text/reasoning/tool state 要保留；
- completed tool 不能因错误而再次执行；
- StructuredOutput incomplete 不能晋升为成功；
- canonical incomplete-stream 不走通用 retry。

相关测试位于：

- `packages/opencode/test/session/prompt.test.ts`；
- `packages/opencode/test/session/processor-effect.test.ts`；
- `packages/opencode/test/session/message-v2.test.ts`；
- `packages/opencode/test/session/retry.test.ts`；
- `packages/opencode/test/cli/run/run-process.test.ts`。

Issue #7 必须在这些 fail-stop 不变量上增加“经过证明的自动恢复”，不能撤销它们。

### 3.2 V2 本地契约

`specs/v2/session.md` 已声明：

- complete local tool call 在副作用开始前持久化：`specs/v2/session.md:50`；
- runner 等待已启动工具，并禁止静默重放 abandoned side effects：`specs/v2/session.md:50`；
- provider-native reasoning metadata 的复用受模型一致性约束：`specs/v2/session.md:52`；
- provider retry/watchdog policy 当前延后：`specs/v2/session.md:153`；
- 一般 post-crash continuation recovery 当前延后：`specs/v2/session.md:165`。

因此本修复必须：

- 复用 durable-before-side-effect 的本地工具边界；
- 不把 incomplete recovery 混入通用 provider retry；
- 不声称顺带解决所有 crash/distributed ownership 问题；
- 若修改 V2 语义，同步修改该 spec。

---

## 4. 修正方案

### 4.1 必需不变量与可选策略

**必需不变量：**

1. incomplete attempt 永远保留 terminal error；
2. 实际请求 materialize 后、dispatch 前，attempt identity、capability summary 与 replay fence 已持久化；
3. 下一次 provider 调用前，失败 attempt、工具结算、恢复 decision 与新 attempt identity 均已持久化；
4. 自动恢复不得重放已执行工具；
5. pending/running/interrupted/uncertain 工具不得自动恢复；
6. provider 或 local-tool replay fence 任一维度为 `unknown` 时不得自动恢复；
7. Legacy AI SDK 提供本地工具时，必须先建立 durable-before-execute handshake，否则只能 ManualStop；
8. 恢复分类只读 durable projection；
9. 持久化失败时当前执行 fail closed；
10. 每次恢复使用新 assistant ID；
11. 自动恢复次数有显式、可持久化的上限；该上限不冒充 physical provider request 上限；
12. incomplete attempt 的 partial prose/reasoning 不得无条件进入下一次模型上下文；step-boundary/cleanup-flushed reasoning 不得被当作 provider-completed reasoning。

**建议默认值，需架构确认：**

- `MAX_INCOMPLETE_RECOVERY_RETRIES = 2`，含义是原始 attempt 之外最多再自动发起 2 个 recovery attempts；
- 无 provider 幂等证明时，provider 维度只允许 `no-provider-side-effects-offered`；local-tool 维度只允许 `none-offered` 或已经落实并测试的 `durable-before-execute`；
- recovery decision 对用户可见，但是否在 UI 中默认折叠旧失败 attempt 属于展示策略。

### 4.2 统一 failure classification

扩展：

```ts
export const ProviderFailureClassification = Schema.Literal(
  "context-overflow",
  "incomplete-stream",
)
```

Legacy adapter 在 canonical 分支填写：

```ts
LLMEvent.providerError({
  message: incompleteStreamMessage,
  classification: "incomplete-stream",
  retryable: false,
})
```

Legacy 还必须把 `SessionProcessor.settleIncomplete()` 识别的“没有可信 final step settlement”从 generic UnknownError 升级为同一 typed classification；不能只修 adapter canonical 分支。

V2 必须有两种来源：

1. route/protocol 能识别的 provider/transport failure 保留 classification；
2. stream 成功 drain 后若 `stepSettlement === undefined`，runner 合成 `incomplete-stream`，包括空流、partial text/reasoning、完整工具后缺少 `step-finish` 等情况。

不是所有 `TransportReason` 都是 incomplete stream。若要让 raw `LLMError` 携带 classification，应显式扩展相应 reason schema 或增加统一 helper，不能通过 message string 猜测。

### 4.3 Durable recovery model

建议把 recovery metadata 持久化到 assistant attempt，而不是只存在于进程内：

```ts
type RecoveryChain = {
  chainID: string
  ordinal: number
}

type AttemptDispatchEvidence = {
  target: DispatchTarget
  replayFence: AttemptReplayFence
  capabilities: {
    localToolsOffered: boolean
    providerSideEffectsOffered: boolean
  }
  recovery?: RecoveryChain
  recoveryProof?: ProviderRecoveryProof
}

type ManualStopReason =
  | "provider-replay-unknown"
  | "provider-continuation-unavailable"
  | "local-tool-replay-unknown"
  | "dispatch-evidence-inconsistent"
  | "recovery-binding-stale"
  | "open-tool-input"
  | "unsettled-tool"
  | "interrupted-tool"
  | "uncertain-tool-result"
  | "continuation-context-unavailable"
  | "retry-budget-exhausted"
  | "dispatch-ambiguous"

type RecoverySourceVersion = {
  digest: string // 完整 settled recovery input/model digest；明确排除 recovery decision 记录自身
  providerPrefixVersion?: string // 若使用 provider cursor，显式记录其祖先 prefix
}

type RecoveryBinding = {
  target: DispatchTarget
  recoverySourceVersion: RecoverySourceVersion
  closureDigest?: string
  providerProof: ProviderRecoveryProof
}

type IncompleteStreamRecovery =
  | { type: "safe-retry"; binding: RecoveryBinding }
  | { type: "continue-after-settled-tools"; binding: RecoveryBinding }
  | { type: "manual-stop"; reasons: ManualStopReason[] }

type IncompleteStreamFailure = {
  classification: "incomplete-stream"
  message: string
  chain: RecoveryChain
  recovery: IncompleteStreamRecovery
}
```

Legacy 与 V2 可以使用不同 schema 封装，但字段语义必须一致。

每个 assistant attempt 都必须先 materialize 实际 request/tool capabilities，再在 provider dispatch 前持久化 `AttemptDispatchEvidence`。replay fence 是该次实际请求的不可变事实，不能在 failure 后从当前配置重新计算。普通初始 attempt 的 `recovery` 可以为空；若它第一次发生 incomplete，则以失败 assistant ID 确定性创建 `RecoveryChain { chainID, ordinal: 0 }` 并随 failure/decision 持久化。incomplete-triggered 新 attempt 在 dispatch evidence 中携带相同 chainID 与递增 ordinal；后续普通 tool continuation 传播该 chain 但不递增。新用户输入或明确 operator intervention 创建新 chain。

### 4.4 权威 evidence model

分类器不直接读取 publisher 临时 flags，而读取 durable projection：

```ts
type ToolRecoveryEvidence = {
  id: string
  name: string
  state: "pending" | "running" | "completed" | "error"
  providerExecuted: boolean
  interruption:
    | undefined
    | "execution-interrupted"
    | "provider-result-missing"
}

type AttemptRecoveryEvidence = {
  source: "durable-projection"
  dispatch: AttemptDispatchEvidence
  chain: RecoveryChain
  plannedBinding: RecoveryBinding
  currentRecoverySourceVersion: RecoverySourceVersion
  providerContinuation?: {
    domain: ProviderSafetyDomain
    cursor: string
    providerPrefixVersion: string
  }
  tools: ToolRecoveryEvidence[]
  continuationClosure:
    | { type: "not-needed" }
    | {
        type: "constructible"
        target: DispatchTarget
        digest: string
      }
    | { type: "unavailable"; reason: string }
}
```

`pending` 已覆盖未完成 tool input；不应仅因为没有完整 `Tool.Called` 就忽略它。

`continuationClosure` 必须由 durable 内容序列、原模型/目标模型与具体 provider protocol 做无副作用验证：只有能够构造协议合法的 settled tool continuation request 时才是 `constructible`。缺少必需 reasoning signature/encrypted state、hosted-tool item ID、provider metadata，或模型不兼容时为 `unavailable`；无工具的 SafeRetry 为 `not-needed`。provider continuation cursor 不能在 dispatch 前凭空声明，必须来自 stream 并绑定当时的 immutable `providerPrefixVersion`。工具 settlement 会在该 prefix 后追加 durable facts，因此不能要求 prefix version 等于最终 recovery source；`RecoverySourceVersion` 必须显式携带其 `providerPrefixVersion` 祖先链接，并与 cursor 的 prefix 完全相等。`recoverySourceVersion` 是 failed attempt/tool settlements、影响 planned request 的输入与模型选择所形成的 recovery-relevant digest，不是会被 recovery decision 自身递增的“最新 aggregate sequence”；持久化 decision 本身不得让 binding 立刻失效。constructible 结论必须绑定目标 model/protocol、recoverySourceVersion、closure digest 与实际 provider proof（none/idempotency key/continuation cursor + providerPrefixVersion）。自动 dispatch 前必须重新 reload 并验证 `RecoveryBinding`；目标、历史版本、闭包 digest 或 provider proof 任一变化都要重新分类并持久化新 decision，不能复用旧结论。

V2 实现顺序：

1. 实际 request/tool capabilities materialize 后，先持久化 owning assistant 的 dispatch evidence，再调用 provider；
2. publisher 中所有代表 durable lifecycle 的内存状态只在对应 event publish 成功后更新，或在失败时回滚；
3. stream terminal 后等待本地 tool fibers；
4. 持久化所有明确 tool results；
5. 对未结算工具持久化带 interruption/uncertainty 来源的 error；
6. reload durable projection，包括该 attempt 原始 dispatch evidence；
7. 以目标模型与 provider protocol 验证 continuation closure 是否可构造；
8. 构造 `AttemptRecoveryEvidence`；
9. 分类并持久化 `IncompleteStreamFailure`；
10. 只有第 9 步成功且 action 为自动恢复时，才重新 materialize；actual target/recoveryProof 与 durable binding 完全一致且 recoverySourceVersion/closureDigest 仍有效后，才能持久化并 dispatch 新 assistant attempt。

Legacy 使用现有 message/part 持久化边界执行同一顺序。若任一步持久化失败，返回当前错误并停止，不 materialize 或 dispatch 新 provider attempt。

### 4.5 保守分类器

```text
evidenceConsistent
:= every providerExecuted tool implies dispatch.capabilities.providerSideEffectsOffered
   and every non-providerExecuted tool implies dispatch.capabilities.localToolsOffered
   and replayFence 与 capability summary 不矛盾
   and every domain-bearing provider fence covers dispatch.target

precondition
:= evidence.source = durable-projection
   and evidenceConsistent
   and incomplete failure 已确认
   and 当前 attempt 未处于 dispatch ambiguity

budgetAvailable
:= chain.ordinal < MAX_INCOMPLETE_RECOVERY_RETRIES

localReplaySafe
:= dispatch.replayFence.localTools.type in {
     none-offered,
     durable-before-execute
   }

safeRetryProviderSafe
:= (
     dispatch.replayFence.provider.type = no-provider-side-effects-offered
     and plannedBinding.providerProof.type = none-needed
   )
   or (
     dispatch.replayFence.provider.type = provider-idempotency-protected
     and plannedBinding.providerProof.type = idempotency
     and plannedBinding.providerProof.domain = dispatch.replayFence.provider.domain
     and plannedBinding.providerProof.key = dispatch.replayFence.provider.key
     and plannedBinding.target belongsTo plannedBinding.providerProof.domain
   )

continueProviderSafe
:= (
     dispatch.replayFence.provider.type = no-provider-side-effects-offered
     and plannedBinding.providerProof.type = none-needed
   )
   or (
     dispatch.replayFence.provider.type = provider-continuation-capable
     and providerContinuation is present
     and plannedBinding.providerProof.type = continuation
     and providerContinuation.domain = dispatch.replayFence.provider.domain
     and providerContinuation.domain = plannedBinding.providerProof.domain
     and providerContinuation.cursor = plannedBinding.providerProof.cursor
     and providerContinuation.providerPrefixVersion = plannedBinding.providerProof.providerPrefixVersion
     and currentRecoverySourceVersion.providerPrefixVersion = providerContinuation.providerPrefixVersion
     and plannedBinding.target belongsTo providerContinuation.domain
   )

bindingCurrent
:= plannedBinding.recoverySourceVersion = currentRecoverySourceVersion
   and (
     continuationClosure.type != constructible
     or (
       continuationClosure.target = plannedBinding.target
       and continuationClosure.digest = plannedBinding.closureDigest
     )
   )

hasToolEvidence
:= tool count > 0

hasUnsafeTool
:= exists tool where
     state in {pending, running}
     or interruption is defined

allToolsSettled
:= hasToolEvidence
   and not hasUnsafeTool
   and every tool.state in {completed, error}

SafeRetry
:= precondition
   and budgetAvailable
   and localReplaySafe
   and safeRetryProviderSafe
   and bindingCurrent
   and not hasToolEvidence
   and continuationClosure.type = not-needed

ContinueAfterSettledTools
:= precondition
   and budgetAvailable
   and localReplaySafe
   and continueProviderSafe
   and bindingCurrent
   and allToolsSettled
   and continuationClosure.type = constructible
   and plannedBinding.closureDigest is defined

ManualStop
:= otherwise
```

解释：

- durable tool evidence、capability summary、replay fence 或原 `dispatch.target` 的 domain 关系任一矛盾时，以 `dispatch-evidence-inconsistent` fail closed 到 ManualStop；
- partial text/reasoning 本身不构成 tool side effect，但只有 provider 与 local-tool 两个 fence 都安全且无 tool evidence 时才能 SafeRetry；
- `pending` tool input 也属于不确定工具状态，必须 ManualStop；
- provider idempotency fence 只证明 SafeRetry 对原 attempt 的重放安全；不同请求形态的 Continue 需要 pre-dispatch `provider-continuation-capable` 加 stream 产生的 durable cursor，或原请求根本没有 provider-side effects；
- 明确返回的 tool error 属于 settled，但仍须 local fence、provider continuation fence 与 provider-valid closure 同时成立才能 Continue；
- planned target 不属于 fence domain，或 providerPrefixVersion 祖先链接、recoverySourceVersion、closure digest、provider proof 已变化时，旧 decision 失效，必须重新分类；
- provider continuation capability 存在但 durable cursor/source binding 缺失时，`provider-continuation-unavailable` 并 ManualStop；
- settled tools 所需的 signature/encrypted state/item ID 缺失或模型不兼容时，`continuation-context-unavailable` 并 ManualStop；
- cleanup 产生的 interrupted/error 不是 settled proof，必须 ManualStop；
- Legacy AI SDK 未建立 durable-before-execute handshake 时，只要实际请求提供了本地工具，local-tool fence 就是 unknown；
- 达到上限后保持最后一次 incomplete error，不再调用 provider。

### 4.6 新 attempt 与恢复顺序

#### Legacy

1. Prompt materialize 实际工具与 provider capabilities；
2. 若提供 AI SDK 本地工具，调用新增的 processor/tool handshake，在 `item.execute()` 前持久化 running tool part；handshake 失败则不执行工具；
3. 在 provider dispatch 前把该 attempt 的 capability summary、replay fence，以及可选 recovery chain 持久化到 assistant；
4. adapter 或 `settleIncomplete()` 产生 typed incomplete signal；
5. `SessionProcessor` 保留 classification，不再在 `provider-error` 分支丢成普通 `Error`；
6. processor 等待工具并完成 part 持久化；
7. Prompt 从刚完成的 assistant message 构造 durable evidence；
8. 若有 settled tools，先验证目标模型/provider protocol 的 continuation closure 可构造；
9. 分类并持久化 recovery decision；
10. `ManualStop` 返回现有 break；
11. 自动 action 清空 attempt-local 状态，重新 materialize planned request；仅当新 dispatch evidence.target/providerProof 与 durable binding 一致时持久化 assistant 并进入 processor；
12. 不使用 `SessionRetry.policy()` 重跑旧 processor。

#### V2

1. materialize 实际 request/tool capabilities，并在 dispatch 前随 `Step.Started` 或等价 event 持久化 replay fence；
2. publisher/runner 识别 typed provider failure 或缺少 `step-finish` 的 clean EOF；
3. 禁止立即 continuation；
4. 等待本地工具，持久化明确 settlement；
5. 用带来源的状态处理 unresolved/interrupted 工具；
6. reload 原 attempt 的 projection 与 dispatch evidence；若有 settled tools，验证 continuation closure；
7. 分类并发布 `Step.Failed`；
8. `ManualStop` 返回；
9. 自动 action 重新 materialize 新 request；仅当实际 target/providerProof/recoverySourceVersion/closureDigest 与 durable binding 一致时，才持久化新的 `Step.Started`/dispatch evidence（同 chain、ordinal + 1）并调用 `llm.stream(request)`。

对于普通 provider error、用户 interrupt、权限拒绝、context overflow 等非 incomplete 错误，保持各自现有语义，不经过本分类器。

### 4.7 Recovery-aware model lowering

#### SafeRetry

- 完全排除失败 assistant 的 text、reasoning、tool fragments；
- 从失败 attempt 之前的上下文重新构造请求；
- 保留失败 attempt 在 durable history/UI 中，但不放入 model request。

#### ContinueAfterSettledTools

只构造“工具续传闭包”：

1. durable、settled 的 tool call/result；
2. provider protocol 为验证这些 tool items 所必需的 signed/encrypted reasoning block，但必须具有 durable `provider-end` provenance；仅有 `time.completed/end` 不够；
3. provider protocol 所需的结构分隔与最终 provider metadata（例如最终 signature/encrypted state）；
4. provider-executed tool call/result 保持 inline 表示；本地 tool result 保持协议要求的 tool message 表示；
5. 只在 continuation model 与历史模型兼容时复用 provider-native metadata。

明确排除：

- 未结束、step-boundary-flushed 或 cleanup-flushed 的 reasoning；
- 缺少 provider-end provenance/最终协议元数据的 reasoning；
- incomplete trailing text/prose；
- 未结束 tool input；
- pending/running/interrupted/uncertain tool；
- 与 tool 续传无关的旧 partial text。

这不是“保留全部 errored assistant”，也不是“无条件删除全部 reasoning”。Legacy reasoning part 与 V2 `Reasoning.Ended`/assistant reasoning schema 必须新增 natural provider end 与 forced-flush 的 durable provenance；lowering 再按内容顺序和 provider 协议计算最小闭包。

闭包可构造性必须在分类前验证，而不是在决定 Continue 后再尝试：Anthropic 会把 reasoning signature 与 tool call 置于同一 assistant sequence：`packages/llm/src/protocols/anthropic-messages.ts:442-469`；OpenAI Responses 会复用 reasoning item/encrypted state 与 hosted-tool item IDs：`packages/llm/src/protocols/openai-responses.ts:385-423`；`store:false` 时缺少最终 encrypted state 的 incomplete reasoning 不能安全 replay：`packages/llm/src/protocols/openai-responses.ts:446-453`。无法构造协议合法闭包时必须 ManualStop。

### 4.8 StructuredOutput 与其他 attempt-local 状态

每个新 recovery attempt 前必须重置：

- `structured`；
- 当前 attempt 的临时 output accumulator；
- processor-local provider evidence；
- 未完成 fragment buffers；
- 与上一 assistant ID 绑定的 toolcall map。

建议将 `structured` 移入 while-loop 内部的 attempt scope，而不是依赖分支手工清空。

### 4.9 max-step 与 crash 边界

- 同一进程内，recovery request 仍受现有 agent max-step guard 约束；
- 当前 V2 `step` 是 run-loop 内状态，新的 `run()` 会从 1 开始：`packages/core/src/session/runner/llm.ts:393-400`；
- 本修复不应声称现有 max-step 已跨 crash 持久化；
- durable recovery ordinal 只限制 incomplete-stream 自动恢复，不等价于完整 agent step budget；
- 新 attempt 已持久化但没有 terminal settlement 时属于 ambiguous dispatch，重新进入必须 ManualStop。

---

## 5. 正确性论证

### 5.1 不会把 incomplete attempt 伪装成成功

- 每次 incomplete attempt 都保留 typed terminal failure；
- recovery 成功会产生新的 assistant attempt；
- 旧 attempt 的错误不会被清除或改写成 success；
- V2 clean EOF 缺少 `step-finish` 也会进入 failure，而不是成功返回。

### 5.2 不会重放已执行的本地工具

- V2 local tool 已有完整 call durable-before-execute 契约；
- Legacy AI SDK 必须通过新增 handshake 建立同一契约，否则 local-tool fence 为 unknown；
- SafeRetry 要求没有 tool evidence，且实际请求的 provider/local-tool replay fence 均安全；
- Continue 只把 settled call/result 作为历史上下文，不重新放入可执行队列，同时仍要求整个 attempt replay fence 安全；
- pending/running/interrupted 状态直接 ManualStop。

### 5.3 不会从“缺少事件”推导副作用安全

- 自动 action 依赖实际请求 materialize 后、dispatch 前持久化的 `AttemptReplayFence`；
- observed `providerExecuted=false/undefined` 或缺少 Legacy tool part 都不是充分条件；
- provider/local-tool 任一 fence unknown 时 ManualStop；
- provider 幂等/续传 fence 只在 planned target 匹配其 safety domain 时有效；
- 因此断流丢失 hosted-tool 事件、跨 provider/model domain 重试或 Legacy AI SDK 在 event 前执行本地工具，都不会被误判为安全。

### 5.4 不会依赖未提交内存状态

- classifier 只接受 `source: "durable-projection"`；
- 原 attempt 的 replay fence 也来自 dispatch 前持久化事实，不从当前配置重算；
- publisher 的 assistant/tool/fragment lifecycle 状态在 publish 成功后更新，或失败时回滚；
- 分类前 reload projection；
- 自动 decision 持久化 target/recoverySourceVersion/closureDigest/providerProof，dispatch 前再次校验；stale binding 不执行；
- 任一 publication 失败会停止当前执行，不会触发下一次 provider 调用。

需要明确限制：如果存储不可用，系统无法保证把 ManualStop 本身写入 durable history；能保证的是当前进程 fail closed。本文不作逻辑上无法兑现的“持久化失败也一定能持久化错误”承诺。

### 5.5 不会把 interrupted error 当作 settled error

- schema 持久化 interruption/uncertainty 来源；
- classifier 对任何带该来源的 tool 强制 ManualStop；
- 当前 turn cleanup 与 startup cleanup 使用同一语义。

### 5.6 恢复次数有界

- chainID 将同一逻辑恢复链关联起来；
- ordinal 在新 assistant dispatch 前持久化；
- 原始 attempt ordinal 0，最多自动创建 ordinal 1 和 2；
- ordinal 达上限时持久化 `retry-budget-exhausted` 并停止；
- Legacy 测试记录每个 fixture 的实际 provider hits，以发现意外 replay；但本修复只保证 recovery assistant 次数有界，不新增独立的 physical-request budget。

### 5.7 模型上下文既不污染，也不破坏 provider 工具协议

- SafeRetry 不注入失败 attempt；
- Continue 只有在 provider-specific continuation closure 已验证可构造时才成立；
- Continue 排除 partial prose/reasoning；
- 仅保留 settled tool continuation 所需且具有 durable provider-end provenance 与最终协议元数据的 provider-native reasoning；
- 模型不兼容时不复用 provider-native metadata，沿用 V2 spec 现有约束。

### 5.8 StructuredOutput 不跨 attempt 泄漏

- attempt-local 变量在新 assistant 前重新初始化；
- 旧 incomplete attempt 的 structured 值不能触发新 attempt 的成功分支；
- 每次成功只属于产生该值的 assistant attempt。

### 5.9 明确未解决的边界

本方案不宣称解决：

- 任意时刻进程崩溃后的 provider request 精确一次执行；
- clustered/distributed Session ownership；
- provider 没有幂等或续传契约时的 hosted-tool 自动恢复；
- 全局 durable max-step budget；
- 独立的全局 physical provider request budget；
- provider timeout/watchdog 的通用策略。

这些边界与 `specs/v2/session.md:153`、`specs/v2/session.md:165` 的 deferred scope 一致。

---

## 6. 测试方案

当前环境缺少 Bun，因此以下均为待执行测试。

### 6.1 纯分类器测试

为同一 classifier 建表驱动测试：

| Tool evidence | Replay fence | Closure | Budget | 预期 |
|---|---|---|---|---|
| none | provider safe + local none | not-needed | available | SafeRetry |
| none | provider unknown + local none | not-needed | available | ManualStop |
| none | provider safe + local unknown | not-needed | available | ManualStop |
| none | idempotency domain mismatch | not-needed | available | ManualStop |
| none | both safe | not-needed | exhausted | ManualStop |
| completed | safe | constructible | available | ContinueAfterSettledTools |
| explicit error | safe | constructible | available | ContinueAfterSettledTools |
| completed | safe | unavailable | available | ManualStop |
| completed | safe | constructible but binding stale | available | ManualStop |
| pending | safe | unavailable | available | ManualStop |
| running | safe | unavailable | available | ManualStop |
| interrupted error | safe | unavailable | available | ManualStop |
| provider-result-missing | safe | unavailable | available | ManualStop |
| completed | unknown | constructible | available | ManualStop |
| completed | continuation-capable but cursor missing | constructible | available | ManualStop |
| mixed settled + pending | safe | unavailable | available | ManualStop |
| providerExecuted tool + capability says none | contradictory | constructible | available | ManualStop |
| original dispatch target outside fence domain | contradictory | not-needed | available | ManualStop |

表中的 `safe` 表示 provider 与 local-tool 两个维度均安全。另测：classifier 拒绝非 durable source，并拒绝缺少该 attempt 原始 dispatch evidence 的输入。

### 6.2 LLM schema / adapter 测试

- `ProviderFailureClassification` 编解码 `incomplete-stream`；
- Legacy canonical adapter 发出 classification 且 `retryable: false`；
- 非 canonical `finishReason="other"` 不误判；
- V2 protocol 已知 incomplete failure 保留 classification；
- 普通 Transport/InvalidProviderOutput 不按 message string 误判。

### 6.3 Legacy 集成回归

在现有 session tests 上补：

1. partial text + safe fence：新 assistant 自动恢复，旧 assistant 保持 error；
2. reasoning-only + safe fence：同上；
3. completed local tool + incomplete：工具只执行一次，新 attempt 收到 tool continuation closure；
4. explicit tool error + incomplete：可 continuation，工具不重放；
5. pending/running/interrupted tool：ManualStop；
6. hosted/provider replay fence unknown：ManualStop；
7. AI SDK 请求提供本地工具但尚未建立 durable-before-execute：即使没有 tool event 也 ManualStop；
8. Legacy AI SDK multi-step 只有单次 HTTP request 级 idempotency、没有 entire-attempt 保证 => provider fence unknown，ManualStop；
9. 新 handshake 在 running tool part commit 成功后才调用 `item.execute()`；commit 失败时副作用执行次数为 0；
10. 连续 incomplete：原始 + 最多 2 个 recovery attempts；
11. 分别记录 assistant attempts 与具体 fixture 的 provider hits，验证没有额外 replay；不声称二者共享同一上限；
12. StructuredOutput 第一次 attempt 产生 partial/旧值、第二次 attempt 未产生值：不得成功；
13. persisted-error 重新进入时只恢复明确、durable、未 dispatch 的 action；ambiguous attempt 停止；
14. failure 后配置/tool registry 改变时，分类仍使用原 attempt 持久化的 replay fence；
15. generic `SessionRetry.policy()` 仍不处理 canonical incomplete-stream；
16. reasoning 仅被 `step-finish` 或 cleanup 强制写入 `time.end` 时，不得当作 provider-end reasoning 进入 continuation closure。

继续保留 Issue #3 现有测试，防止 fail-stop 语义回归。

### 6.4 V2 集成回归

补充 `packages/core/test/session-runner.test.ts`：

1. clean EOF + partial text + no `step-finish` => typed incomplete failure；
2. clean EOF + reasoning-only => typed incomplete failure；
3. empty stream / finish-only => typed incomplete failure；
4. completed local tool + no `step-finish` => 等待 settlement 后分类，工具只执行一次；
5. hosted call 无 result + EOF => uncertainty marker + ManualStop；
6. explicit provider-error + completed local tool => continuation closure，不重放工具；
7. raw stream failure若无 incomplete classification => 保持普通错误，不误入本分类器；
8. 分别注入 `Step.Started`、`Step.Failed`、`Tool.Input.Started`、fragment start、`Tool.Called`、`Tool.Success/Failed` publication failure => 内存 lifecycle 不得冒充 durable state，且不发起下一 request；
9. startup `failInterruptedTools()` 保留 interruption marker；
10. provider 正常 `reasoning-end` + settled tool => 只有具备 provider-end provenance 与最终协议元数据的 signed/encrypted reasoning 被保留；
11. step-boundary/cleanup-flushed reasoning 即使有 `time.completed` 也不进入 continuation request；
12. settled tools 缺少必需 signature/encrypted state/hosted item ID 或目标模型不兼容 => `continuation-context-unavailable` + ManualStop；provider 声明 continuation capability 但没有 durable cursor/source binding => `provider-continuation-unavailable` + ManualStop；
13. incomplete trailing reasoning/text => 不进入 continuation request；
14. 模型切换 => 不复用不兼容 provider metadata；
15. recovery ordinal 达上限 => 不再调用 `llm.stream()`；
16. 已持久化新 Step.Started/dispatch evidence 但无 terminal settlement => re-entry ManualStop；
17. failure 后动态 tool registry/config 改变 => 分类仍读取原 attempt 持久化的 capability summary/replay fence；
18. SafeRetry planned target 切换到不同 provider safety domain => 原 idempotency fence 失效，重新分类或 ManualStop；
19. decision 后 providerPrefixVersion 祖先链接、recoverySourceVersion、target、closure digest 或 provider proof 改变 => dispatch 前重新 load/reclassify，不执行 stale decision；
20. 原 dispatch.target 不属于持久化 fence domain => `dispatch-evidence-inconsistent` + ManualStop；
21. 持久化 recovery decision 本身不改变 recoverySourceVersion；真正相关的 history/input/model 变化才使 binding stale。

### 6.5 CLI / child session 回归

扩展 `packages/opencode/test/cli/run/run-process.test.ts`：

- 最终成功只来自 recovery assistant；
- 旧 incomplete assistant 仍可见为 error；
- ManualStop 仍返回非成功状态；
- child/subtask 不因父层 retry 重放已执行工具；
- 达到 recovery 上限后 CLI 不挂起、不循环。

### 6.6 建议验证命令

根 `package.json:23` 只明确禁止根 package 的 `bun run test` 脚本；不能据此声称所有从仓库根启动的定向 `bun test` 都被禁止。为避免歧义，建议在对应 package 内运行：

```bash
bun run --cwd packages/llm typecheck
bun run --cwd packages/schema typecheck
bun run --cwd packages/core typecheck
bun run --cwd packages/opencode typecheck

(cd packages/llm && bun test test/provider-error.test.ts)
(cd packages/core && bun test test/session-runner.test.ts)
(cd packages/opencode && bun test test/session/retry.test.ts)
(cd packages/opencode && bun test test/session/processor-effect.test.ts)
(cd packages/opencode && bun test test/session/message-v2.test.ts)
(cd packages/opencode && bun test test/session/prompt.test.ts)
(cd packages/opencode && bun test test/cli/run/run-process.test.ts)
```

实现时若新增独立 classifier test，应加入对应命令。全部 targeted tests 通过后，再按 package 运行 package test script；不要运行根目录的 `bun run test`。

---

## 7. 代码更新检查清单

### 7.1 `packages/llm`

- [ ] 扩展 `ProviderFailureClassification`；
- [ ] 明确哪些 `LLMError` reason 可携带 classification；
- [ ] 不用 message string 猜测 incomplete；
- [ ] 保持 classification 与 retryable 正交；
- [ ] 添加 schema/protocol tests。

### 7.2 Legacy `packages/opencode`

- [ ] `session/llm/ai-sdk.ts` 发出 typed incomplete classification；
- [ ] `session/processor.ts` 的 provider-error 与 `settleIncomplete()` 都保留 typed classification；
- [ ] `session/tools.ts` 与 processor Handle 增加 durable-before-execute handshake；running part commit 失败时不调用本地工具；
- [ ] Prompt 在实际 tools/provider capabilities materialize 后、dispatch 前持久化 capability summary 与 replay fence；
- [ ] 通用 retry policy 不处理 incomplete-stream；
- [ ] processor 完成工具 drain 后再交给 recovery classifier；
- [ ] `session/prompt.ts` 支持新 assistant recovery attempt；
- [ ] 添加 durable chainID / ordinal / replay fence / recovery decision binding（target、recoverySourceVersion、closureDigest、providerProof）；
- [ ] `structured` 与其他 attempt-local 状态按 attempt 重置；
- [ ] `session/message-v2.ts` 实现 recovery-aware lowering，并在 Continue decision 前提供 protocol-valid closure 可构造性检查；
- [ ] 修正持久化错误 entry guard，只允许证据完整且未 dispatch 的自动 action；
- [ ] 更新 CLI / child session 错误传播测试。

### 7.3 V2 schema / event projection

- [ ] assistant/Step.Started 增加 recovery-chain identity、capability summary、replay fence 与实际 recoveryProof；
- [ ] Step.Failed 或等价 typed error 支持 incomplete classification 与 target/recoverySourceVersion/closureDigest/providerProof-bound recovery decision；
- [ ] tool error 增加 interruption/uncertainty provenance；
- [ ] Reasoning.Ended/assistant reasoning 增加 provider-end / step-boundary-flush / cleanup-flush provenance；
- [ ] 若 protocol 支持续传，event/projection 持久化 provider continuation cursor 及其 providerPrefixVersion/domain；
- [ ] projector 持久化新增字段；
- [ ] 检查 `session.next.retried`：若复用，补 assistant/chain 关联并投影；若不复用，说明其保留用途；
- [ ] 更新 schema round-trip tests 与所有 exhaustive switches。

### 7.4 V2 runner / publisher

- [ ] clean drain 缺少 `step-finish` 时合成 incomplete failure；
- [ ] incomplete 后先禁止 continuation，再等待工具；
- [ ] assistant/tool/fragment lifecycle state 只在对应 publish 成功后更新，或失败时回滚；
- [ ] 分类前 reload durable projection；
- [ ] 在分类前用目标模型与 provider protocol 验证 settled-tool continuation closure 可构造；
- [ ] recovery decision 持久化 target、recoverySourceVersion、closureDigest 与 providerProof；recoverySourceVersion 排除 decision 自身，dispatch 前重新验证全部 binding；
- [ ] idempotency/continuation target 必须匹配原 fence 的 provider safety domain；
- [ ] actual request materialize 后、dispatch 前持久化 provider 与 local-tool replay fence；
- [ ] `failUnsettledTools()` 保留 interruption/uncertainty 来源；
- [ ] `failInterruptedTools()` 使用相同来源语义；
- [ ] 持久化失败时不发起后续 provider request；
- [ ] 新 Step.Started 在 dispatch 前持久化 chainID/ordinal，并证明 actual dispatch target/providerProof 与 durable binding 一致；
- [ ] ambiguous dispatch 在 re-entry 时 fail closed；
- [ ] publisher 分别发布 provider-end、step-boundary-flush 与 cleanup-flush durable provenance；
- [ ] `to-llm-message.ts` 仅基于 provider-end provenance 实现 sequence-aware tool continuation closure。

### 7.5 回归与兼容性

- [ ] 已完成工具不重复执行；
- [ ] partial text/reasoning 不误报成功；
- [ ] StructuredOutput 不跨 attempt 泄漏；
- [ ] context-overflow compaction 行为不回归；
- [ ] 用户 interrupt、permission decline、普通 provider error 语义不回归；
- [ ] model switch 后 provider metadata 复用规则不回归；
- [ ] max-step 的 same-process 语义不回归；
- [ ] 未声称 durable global max-step、独立 physical-request budget 或任意 crash exact-once。

---

## 8. 文档更新检查清单

- [ ] 更新本文状态、最终字段名、分类表与实际测试结果；
- [ ] 更新 `specs/v2/session.md`：
  - [ ] incomplete stream 的 terminal-settlement 判定；
  - [ ] provider/local-tool replay fence 与 dispatch 前持久化；
  - [ ] Legacy AI SDK durable-before-execute 前置条件；
  - [ ] recovery chain 与 retry budget；
  - [ ] tool interruption/uncertainty 持久化；
  - [ ] reasoning provider-end/step-boundary-flush/cleanup-flush provenance；
  - [ ] provider-specific continuation closure 可构造性前置条件；
  - [ ] recovery-aware context lowering；
  - [ ] 与 deferred post-crash/provider-timeout scope 的边界；
- [ ] 若公共 Session event/message schema 改变，更新相关 API/schema 文档；
- [ ] 更新测试说明，明确根 `bun run test` 与 package-level targeted tests 的区别；
- [ ] 实现完成后新增 `docs/devlog/YYYY-MM-DD-<简述>.md`，包含 workflow 要求的度量；
- [ ] 将实现中发现的非显然限制同步回项目规范的“已知限制与注意事项”；
- [ ] 在 Bun 可用环境记录实际 typecheck/test 命令、通过数与失败数。

---

## 实现前仍需确认的架构决策

1. **Attempt replay fence 的来源与持久化**：provider capability 由 `LLMRequest`/route 还是各 protocol adapter 提供；local-tool capability 由 runtime 提供；二者都必须基于实际 materialized request，并在 dispatch 前随 attempt 持久化，默认是 `unknown`。Legacy AI SDK 的幂等 fence 必须覆盖其整个内部 physical-request sequence，不能只覆盖第一条 HTTP request；所有幂等/续传 fence 还必须声明 provider/route/protocol/model safety domain，planned target 必须匹配。
2. **Legacy durable-before-execute**：是否在 `SessionProcessor.Handle` 增加 begin/start tool call API，并由 AI SDK `tools.ts execute()` 在副作用前调用；若不实施，Legacy 只要提供本地工具就不能自动恢复。
3. **Durable recovery metadata 的承载位置**：扩展现有 assistant error/Step events，还是新增专用 recovery event；无论选择哪一种，都必须持久化 planned target、recoverySourceVersion、closureDigest 与 providerProof；continuation proof 还必须绑定 providerPrefixVersion，并在下一次 dispatch 前可重放和重新验证。
4. **Reasoning completion provenance**：Legacy part metadata 与 V2 Reasoning event/schema 如何统一表达 provider-end、step-boundary-flush 与 cleanup-flush；仅 provider-end 默认可进入 continuation closure。
5. **Continuation closure validator**：由公共 LLM protocol 层提供 dry-run/validation API，还是由 Legacy/V2 lowering 共享 helper；必须在 recovery decision 前得出 constructible/unavailable。
6. **默认预算**：本文建议原始 attempt 外最多 2 次自动恢复；需要确认这是产品默认还是可配置项。该预算不等于 physical request budget。
7. **Legacy 序列化兼容**：新增 dispatch/recovery/reasoning metadata 时需确认旧 Session message decoder 的兼容方式。
8. **UI 展示**：旧失败 attempt 必须保留；UI 是否折叠、如何展示自动恢复原因属于后续展示设计，不影响核心安全不变量。

在这些决策确认、设计细化并通过审查前，不应开始生产代码实现。
