# Session 不完整流恢复：根因分析与修正方案

> Issue: [#7](https://github.com/lihaokun/opencode/issues/7)
>
> 状态：CLI/TUI 产品范围内的实现前方案，尚未修改生产代码。
>
> 审视日期：2026-08-12。
>
> 产品范围：本方案仅覆盖常规 `opencode run`、TUI 及其内部 unprefixed `/session/...` SDK/HTTP 路径使用的 Legacy Session execution。不会修改或启用 Native V2 Session runner 的 recovery 行为、专属 tests 或 spec；但 Legacy recovery 所需的 shared LLM contracts、Session SQLite schema/migrations 与 EventV2 plumbing 会做向后兼容的 shared 修改，并必须运行 Native V2/shared regression，Native V2 不纳入 recovery 产品验收。外部直接 Session API/SDK consumer 与独立 V2 preview 也不属于本次产品验收。
>
> 证据范围：当前本地仓库与 Issue #7 正文；未查看上游仓库、上游分支或上游实现。
>
> 文档权威边界：`docs/design/session-recovery/architecture.md` 是 2026-08-11、无 Bun 运行时证据且仍包含 Native V2 recovery scope 的旧架构评审稿，与本轮证据和范围不一致；本次不修改该文件，它不能作为当前实施权威。本文获批后，必须在单独架构阶段明确 supersede/update 旧稿并再次审查，之后才能开始生产实现。
>
> 运行环境：本机 PATH 中的 Bun 1.3.14；审计基线 HEAD `0ea5c2959`。
>
> 验证状态：本轮在确认 branch/HEAD/Bun 后，重新实际执行 46 个 Bun tests 与 4 个精确单选的范围内 Legacy HttpApi exerciser scenarios，共 50 个范围内检查；50/50 通过，0 failed，0 skipped。另有一次 selector 过宽的辅助 exerciser 运行执行了 37 个 scenarios（全部通过），但不计入这 50 项验收。当前 Legacy fail-stop、partial/error 持久化、普通 tool continuation、child failure propagation 与 outer `SessionRetry` 的第二次 provider HTTP 请求已有运行时证据；本文提出的 automatic recovery、dispatch ledger/CAS、durable-before-execute、provider closure、budget、wire/replay compatibility 与 recovery TUI 展示尚未实现，仍是设计义务和实施后验收项。

### 证据等级与本轮运行记录

本文使用以下等级，避免把不同强度的证据混写：

- **A — 产品路径端测**：真实 `opencode run` Bun 子进程，经 Legacy Session、AI SDK、TCP fake provider 与 SQLite transcript；
- **B — live transport 集成**：真实 HTTP listener、generated SDK 与 TCP fake provider，但不是外部 API/SDK 产品场景；
- **C — Legacy runtime 集成**：真实 `SessionPrompt`/`SessionProcessor`、AI SDK 与 TCP fake provider，绕过外层 Session HTTP；
- **D — 辅助证据**：in-process route exerciser、synthetic TUI、unit test、源码或 pinned dependency；
- **F — 未来 contract**：当前生产实现不存在，不能标记为已证明。

顶部“运行时证据”包括 A/B/C 级真实执行与 D 级辅助测试；只有 A 级称为 CLI 产品路径端测。C 级 outer retry 与 D 级 policy 结论会明确标注，避免统称为产品 E2E。

| ID | 等级 | 实际执行 | 结果与直接观察 | 可以支持 | 不能支持 |
|---|---|---|---|---|---|
| E-CLI-1 | A | `run-process.test.ts`：`exits 0 and writes the response to stdout on a successful prompt`；`missing terminal finish preserves partial text and exits nonzero`；`missing terminal finish persists reasoning and an assistant error`；`--format json records partial output before a missing terminal error`；`exits nonzero without compaction when a high-usage stream misses its terminal finish` | 5/5；成功对照 exits 0；其余 4 个 incomplete fixtures exit nonzero；partial text 保留在 CLI stdout/JSON events，reasoning 与 assistant `UnknownError` 由 SQLite read-back 独立验证；无 conversation replay/compaction | 当前 Legacy fail-stop 与限定边界内的 partial/error preservation | typed recovery、recovery child，或所有 partial text 均已由 SQLite 独立读取 |
| E-CLI-2 | A | `run-process.test.ts`：`prints each completed text part in order around a tool continuation`；`--format json preserves reasoning, tool, and continuation ordering`；三个 child/subtask failure/crossover 用例 | 5/5；事件顺序正确、child error durable、covered completed bash part/marker 各一次 | 普通 continuation、child failure propagation、当前特定 fixture 不重放 completed tool | `ContinueAfterSettledTools`、任意路径 replay safety、durable-before-execute |
| E-LEGACY-1 | C | `prompt.test.ts` 的 7 个定向 reasoning/text/high-usage/tool/StructuredOutput missing-finish 用例 | 7/7；其中 2 个 re-entry fixtures 返回原失败 assistant；covered high-usage fixtures 无 compaction；StructuredOutput fixtures 不晋升；covered completed-tool fixtures 未重放 | fail-stop 细节与持久化边界 | automatic recovery、CLI/HTTP E2E |
| E-LEGACY-2 | C/D | `processor-effect.test.ts`：D 级 2 个 injected synthetic settlement tests；C 级 1 个 TCP missing-finish/compaction test 与 2 个 TCP 429/503 retry tests | 5/5；synthetic settlement fixtures 在无可信 settlement 时停止；TCP 429/503 fixtures 的测试 server 观察到 `llm.calls === 2`，503 retry attempt 为 1 | settlement guard 的辅助覆盖；outer retry 可重新进入 provider execution | 所有 5 项均经过 AI SDK/TCP、已存在 dispatch ledger、replay safety 或 `dispatch-ambiguous` classifier |
| E-POLICY-1 | D | `retry.test.ts`：`does not retry the canonical incomplete-stream unknown error` | 1/1；`retryable()` 返回 `undefined` | canonical incomplete 当前不进入通用 retry policy | CLI E2E 或 provider request count（须结合其他等级） |
| E-HTTP-1 | B | `httpapi-sdk.test.ts`：`matches generated SDK prompt streaming through fake LLM` | 1/1；live listener → generated SDK → unprefixed Legacy prompt → TCP provider → durable message | Legacy live transport wiring | 外部 API/SDK 产品验收、incomplete recovery |
| E-ROUTE-1 | D | `httpapi-exercise` 四次 `selected=1`：Legacy `session.prompt` / `session.prompt_async` / `session.command` / `session.shell` | 4/4 scenarios；各自 `pass=1 fail=0 skip=0` | production route tree、request decoding 与 Legacy handler wiring | socket-level E2E、command incomplete recovery；shell 本身无 provider turn |
| E-TUI-1 | D | `sync-live-hydration.test.tsx`（5）+ `inline-tool-wrap-snapshot.test.tsx`（17） | 22/22、8 snapshots；generic synthetic hydration/event-merge 与 inline-row rendering mechanics | TUI sync/render 基础机制 | recovery-shaped transcript、child 关联/顺序、busy/idle、production submission 或 keyboard-to-provider E2E |

本轮正式证据命令均从对应 package 执行。曾有两次在测试/scenario 执行前发生的命令调用错误（CLI test 初次从 `packages/tui` 启动；exerciser 初次使用了错误的 `bun run` 参数组合），以及一次 selector 过宽、额外执行 37 个全通过 scenarios 的辅助运行；它们都未产生测试断言/scenario 失败或仓库变更，也不计入 50 项正式验收。四个 route scenarios 随后分别以 `selected=1` 精确重跑并通过。

## 结论摘要

**当前运行时证据：**本轮新执行的 A 级真实 CLI subprocess 已确认 Legacy incomplete fail-stop、CLI stdout/JSON events 的 partial text 保留、SQLite read-back 的 reasoning 与 assistant error、普通 tool continuation、child failure propagation，以及已覆盖 fixtures 中 completed tool 未重放；C 级 Legacy Processor + TCP provider integration 已由测试 TCP server 直接观察到 recognized 429/503 会触发 outer `SessionRetry` 的第二次 provider 请求；D 级 policy unit test 确认 canonical incomplete 不进入该通用 policy。后两项不是 CLI 产品路径 E2E；静态源码与 pinned dependency 只用于解释 request/step 边界，不能替代这些运行时结果。

**拟实现的恢复 contract（当前尚未实现）：**Issue #7 不能通过“把 incomplete-stream 改成普通可重试错误”安全解决。未来恢复决策必须独立于通用 transport retry，并且必须在以下事实已经确定后执行：

1. 本次 provider turn 确实以 incomplete stream 结束；
2. 已启动的本地工具均已等待并完成持久化；
3. 分类依据来自持久化投影，而不是尚未提交的内存布尔值；
4. provider 侧不存在未观测副作用，或对应 action 受覆盖整个 attempt replay 的幂等契约/覆盖 durable prefix 的续传契约保护；
5. 本地工具没有被提供，或 runtime 已证明 durable-before-execute；
6. settled-tool continuation context 可以按目标 provider protocol 合法构造；
7. 自动恢复 recoveryOrdinal 与同进程 max-step guard 均未耗尽；
8. planned request 的完整 canonical digest、target endpoint/authority、proof 与 durable binding 一致；
9. recovery decision 通过唯一 consumption link 原子创建新的 assistant attempt，同一 chain recoveryOrdinal 不会重复创建；
10. 下一次 provider 调用使用新的 assistant attempt，并且不会覆盖失败 attempt。

本方案的具体实现只落到 CLI/TUI 会话执行实际使用的 Legacy 路径。真实 CLI subprocess 已覆盖 normal prompt、tool continuation 与 child/subtask；in-process route exerciser 已覆盖 unprefixed Legacy prompt/command/shell handler wiring。当前源码调用链显示 TUI prompt/command/shell 使用 Legacy SDK 操作，但仓库尚无完整 TUI submission route 端测。Legacy 路径实现本文 contract 并通过相应 CLI/TUI 会话验收后，方可在当前产品范围内验收 Issue #7。

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

以上是 Issue #7 的目标，不是当前代码已经满足的事实。本次 recovery 实现和验收覆盖常规 CLI/TUI 的 Legacy prompt、进入 model 的 command、ordinary tool continuation 与 child/subtask；shell 本身无 provider stream，recovery 标 N/A，只保留 route/transcript/side-effect 与后续独立 prompt/command 不重放的回归。

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

因此 Legacy 当前是 fail-stop，而不是自动恢复。该结论不再只依赖静态调用链：本轮重新实际执行的 CLI subprocess 用例 `missing terminal finish preserves partial text and exits nonzero`、`missing terminal finish persists reasoning and an assistant error`、`--format json records partial output before a missing terminal error` 与 high-usage 对照均通过，直接观察到 incomplete fixtures nonzero exit、CLI stdout/JSON events 中的 partial text、SQLite read-back 的 reasoning 与 durable `UnknownError`、`finish="unknown"` 和单次 conversation input；对应 7 个 Prompt integration 用例也重新通过：其中 2 个 re-entry fixtures 返回原失败 assistant；covered high-usage fixtures 无 compaction；StructuredOutput fixtures 不晋升；covered completed-tool fixtures 未重放。当前公开 error 仍是 generic `UnknownError`。本方案拟新增 typed durable terminal fact，但本次 public Legacy error discriminator 保持不变；未来若要新增 `MessageIncompleteStreamError`，必须通过单独批准的 versioned endpoint/schema 或明确 breaking-change 决策，不能默认破坏旧 SDK。

Legacy processor 还会对没有可信 final step settlement 的 clean EOF 做路径无关检查：`packages/opencode/src/session/processor.ts:580-600`。本轮实际执行的 `session.processor rejects every stream without a credible final step settlement` 与 `session.processor gives no-step settlement priority over an earlier empty unknown` 均通过，覆盖 empty、final-only、multi-step-incomplete 与 unknown-then-incomplete：`packages/opencode/test/session/processor-effect.test.ts:856-893`。

Legacy tool part 的关键持久化位置是：

- pending：`packages/opencode/src/session/processor.ts:258-274`；
- running：`packages/opencode/src/session/processor.ts:353-374`；
- completed：`packages/opencode/src/session/processor.ts:182-205`；
- error：`packages/opencode/src/session/processor.ts:208-225`；
- cleanup/interrupted：`packages/opencode/src/session/processor.ts:602-660`。

但是这些位置不能证明 Legacy AI SDK 路径“先持久化 call、后执行工具”。AI SDK 当前负责 tool dispatch：`packages/opencode/src/session/llm.ts:279-283`；本地工具副作用发生在 SDK 调用的 `execute()` 回调中：`packages/opencode/src/session/tools.ts:102-129`。`packages/opencode/test/session/snapshot-tool-race.test.ts:4-12` 的注释记录了这一历史竞态，其现有断言验证工具副作用、completed part 与 session diff 等用户可见后果，但没有用 latch/独立 storage reader 机械断言 `execute()` 与 processor durable commit 的 happens-before。故该文件是风险 reproducer/harness，不是 durable-before-execute 的充分证明。因此 Legacy 要安全自动恢复，必须新增专门的 durable-before-execute handshake 与 failure-injection 测试，或在提供了可执行本地工具时把 replay fence 视为 unknown。

### 1.3 静态复现场景

实现前至少要固定以下 Legacy 场景：

| 场景 | 当前 Legacy | 目标 |
|---|---|---|
| partial text 后 canonical incomplete | 持久化错误并停止 | 安全围栏成立时新 attempt 重试，否则 ManualStop |
| reasoning-only 后 incomplete | 持久化错误并停止 | 同上 |
| 空流或只有 `finish`、没有 `step-finish` | processor 已写 error 并停止，但还是 generic UnknownError | 稳定分类为 incomplete |
| 本地工具已 completed，随后 incomplete | 工具执行一次并停止 | 仅在 replay fence 安全且协议闭包可构造时继续；工具不得重放 |
| hosted tool call 无结果后 EOF | 不适用或由 adapter 决定 | 保留不确定来源并 ManualStop |
| tool pending/running 后 incomplete | cleanup 标记 interrupted | 保留 interruption/uncertainty 并 ManualStop |
| StructuredOutput partial 后 incomplete | 保持错误 | 不得把旧 attempt 的值晋升为成功 |
| 持久化失败 | 当前执行失败 | 当前进程 fail closed，绝不自动发起下一次 provider 调用 |

---

## 2. 根因分析

### 2.1 incomplete-stream 信号没有形成 Legacy 类型化契约

当前 `ProviderFailureClassification` 只有 `context-overflow`：

- `packages/llm/src/schema/errors.ts:4-5`。

`ProviderErrorEvent` 支持可选 classification，但 canonical Legacy adapter 没有填写。Legacy processor 的 clean EOF 检查也只落为 generic `UnknownError`。因此需要把 `incomplete-stream` 纳入单一类型化 contract，并由 Legacy AI SDK canonical adapter 与 `SessionProcessor.settleIncomplete()` 共同接入；不能通过 message string 猜测 classification。

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

**Provider-hosted 副作用：**只有收到相应 tool event 后才能知道 `providerExecuted`，而 LLM 事件 schema 的 `providerExecuted` 是可选字段。

如果 provider 已执行 hosted tool，但承载 call/result 的流片段丢失，客户端看到的仍可能是“没有 providerExecuted 证据”。

**Legacy 本地工具副作用：**源码 ownership 与 `snapshot-tool-race.test.ts` 的历史竞态注释表明 AI SDK 可能在 processor durable observation 之前调用本地工具；现有测试验证了副作用与最终 tool/session 状态，却没有机械断言两者的严格先后。因此这里是可信的安全风险与待证明时序，不把该 fixture 夸大为 happens-before 端测。Legacy 的“没有 durable tool part”仍不能作为本地工具尚未执行的安全证明。

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
  endpointID: string // 规范化 base URL / deployment / region 的非 secret 标识
  authorityID: string // account/project/tenant/credential scope 的稳定非 secret 标识
  modelID: string
  modelFamily?: string
}

type ProviderSafetyDomain = {
  providerID: string
  routeID: string
  protocol: string
  endpointID: string
  authorityID: string
  modelID?: string // provider 契约若只在单一 model 内有效则必填
  modelFamily?: string // provider 契约若只在单一 model family 内有效则必填
}

type DurableProviderPrefixVersion = {
  aggregateID: string // Legacy 中必须等于 sessionID
  assistantID: string
  eventSequenceHighWater: number
  hashVersion: "recovery-event-chain-v1"
  hashChainDigest: string
}

type SealedRecoveryMaterialRef = {
  refID: string
  digest: string // canonical comparison 只使用 digest
  keyVersion: string // sealed-at-rest key version；不含 raw secret/token
}

type ProviderRecoveryProof =
  | { type: "none-needed" }
  | {
      type: "idempotency"
      domain: ProviderSafetyDomain
      key: SealedRecoveryMaterialRef
    }
  | {
      type: "continuation"
      domain: ProviderSafetyDomain
      cursor: SealedRecoveryMaterialRef
      providerPrefixVersion: DurableProviderPrefixVersion
    }

type AttemptReplayFence = {
  provider:
    | { type: "no-provider-side-effects-offered" }
    | {
        type: "provider-idempotency-protected"
        scope: "semantic-request-replay"
        domain: ProviderSafetyDomain
        key: SealedRecoveryMaterialRef
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
- `provider.provider-idempotency-protected`：adapter 有明确、可测试的 provider 契约，同一稳定 idempotency key 覆盖原 assistant 的唯一 authorized semantic dispatch 以及 recovery 对该 dispatch semantic payload 的重放；planned recovery target 必须属于相同 `ProviderSafetyDomain`。当前常规 Legacy conversation 调用没有设置 `retries`，AI SDK `maxRetries` 因而为 0（`packages/opencode/src/session/llm.ts:326`），且 `streamText()` 未传 `stopWhen`，使用依赖中的默认 `stepCountIs(1)`；普通工具续传由 Prompt 外层创建下一 assistant。当前本地代码仍没有 provider 级 replay 幂等通用证明，不能默认使用。若未来为 conversation dispatch 开启 AI SDK 内层 retry/multi-step，fence 必须证明同一 key 覆盖该 invocation 内每个 model step/physical request，或将 fence 降为 `unknown`；
- `provider.provider-continuation-capable`：dispatch 前只能证明 provider/route 具备受保护续传能力；实际 cursor 必须在 stream 中产生，并与当时已提交的 append-only provider prefix checkpoint 原子持久化。`DurableProviderPrefixVersion` 的 assistantID、high-water sequence 与 hash-chain digest 必须由 durable 内容序列计算；分类时必须重新验证该 checkpoint 是当前完整 `RecoverySourceVersion` 所引用序列的祖先，而不是只比较一个由调用者复制的字符串。只有 capability、durable cursor、机械 ancestry proof 与 planned continuation target domain 全部匹配时，Continue 才安全。当前本地代码没有这种通用契约；
- `localTools.none-offered`：实际请求没有提供可执行本地工具；
- `localTools.durable-before-execute`：runtime 保证完整 call 已 durable commit 后才允许执行副作用；Legacy AI SDK 当前不具有该边界；
- `ProviderSafetyDomain` 必须覆盖 provider、route、protocol、规范化 endpoint/deployment/region 与 account/project/tenant/credential authority；这些字段只保存稳定非 secret 标识或其版本化 digest，不能保存 credential 本身。credential/account/endpoint 任一变化都产生不同 domain；若 auth 本身不提供可安全持久化的稳定 credential/account ID，可使用会随 credential rotation 改变但不可反推出 secret 的 keyed version digest；既无法取得稳定 ID 也无法安全生成该 digest 时 provider fence 必须是 `unknown`；
- continuation cursor 与敏感 idempotency key 不能以 raw value 进入 event/canonical envelope。可跨重启的实现必须将 raw material sealed/encrypted at rest，权威记录只携带 `refID + digest + keyVersion`，runtime 在 gated preparation 内 unseal 并重新校验 digest；若不能提供可 replay 的安全 sealed storage，则对应 continuation/idempotency authorization 在进程重启后必须 unavailable，不能仅凭 digest 构造请求；
- `target belongsTo domain` 使用版本化 canonical structural comparison：五个必填字段必须逐项完全相等；`domain.modelID` / `domain.modelFamily` 若存在也必须分别与 target 完全相等，只有 provider 契约明确声明跨 model/model-family 有效时 binder 才能省略对应限制。domain equality 使用同一规则，不允许通过 display name、字符串前缀或当前配置猜测；
- 无法证明任一维度时，该维度必须是 `unknown`。

Legacy 若要在提供本地工具时自动恢复，必须先把 `tools.ts` 的 AI SDK `execute()` 与 `SessionProcessor` 连接成 durable-before-execute handshake：先创建并提交 owning assistant 的 running tool part，提交失败则不得调用 `item.execute()`。若不做这项架构修改，只能 ManualStop。

该 fence 不仅约束 `SafeRetry`，也约束 `ContinueAfterSettledTools`。即使所有“已观察工具”都结算，也不能排除断流前还有一个未观察到的 hosted action 或 Legacy local action。

### 2.4 attempt identity 与当前 Legacy physical-request 边界

必须区分五个层级：

1. **logical recovery chain**：同一份用户工作触发的一串 incomplete-stream 恢复；
2. **assistant attempt**：一个持久化 assistant message 及其一次 `SessionProcessor.process()` 生命周期；
3. **semantic dispatch**：每次重新进入 Legacy `llm.streamBatches()` 并创建新的 AI SDK `streamText()` invocation；
4. **model step**：同一 `streamText()` invocation 中由 AI SDK stop condition 控制的一次 provider model step；当前默认只有 1 个；
5. **physical provider request**：transport 实际发出的一次 HTTP/stream 请求，包括同一 model step 的 AI SDK 内层 retry。

当前常规 Legacy conversation path 每个 assistant 只调用一次 `handle.process()`（`packages/opencode/src/session/prompt.ts:1195-1295`）。该调用没有设置 `StreamInput.retries`，所以 AI SDK `maxRetries` 为 0（`packages/opencode/src/session/llm.ts:326`）；也没有传 `stopWhen`。根 `package.json:67` 与 `bun.lock:3065` pin `ai@6.0.168`，本轮安装包中的 `ai/src/generate-text/stream-text.ts:304-305` 显示默认 `stepCountIs(1)`；具体 `node_modules/.bun` store hash 不作为稳定引用。这些都是“源码 + pinned dependency”事实；当前端测与其相容，但没有隔离 instrumentation 证明各自因果。工具执行完成后，当前 Prompt 通过 `result/outcome → continue` 回到外层循环并创建新的 assistant（`packages/opencode/src/session/prompt.ts:1334-1350`），不是由同一个 assistant 内的 AI SDK client-side continuation 再发请求。

因此，在**没有外层 retry**时，当前 pinned/default conversation 的一个 assistant attempt 按源码模型对应一个 semantic dispatch，普通 tool continuation 对应下一个 assistant；现有 CLI 端测直接证明后续 provider turn 和事件顺序，但没有同时观测 assistant ID、`streamText()` invocation ID 与 model-step ID，不能把该精确一一关系冒充成独立端测结果。`SessionRetry.policy()` 位于 `llm.streamBatches(streamInput)` 外层，会重新执行整个 effect 并创建新的 `streamText()` invocation（`packages/opencode/src/session/processor.ts:694-745`、`packages/opencode/src/session/llm.ts:360-369`）；本轮真实 TCP provider 的 429/503 测试直接观察到同一 processor assistant 下 `llm.calls === 2` 与 retry attempt 1，支持“outer retry 会重新进入 provider execution”。AI SDK 自身未来若启用 `maxRetries`，才会在同一 `streamText()` invocation 中重做底层 `doStream()`。标题生成明确传 `retries: 2`（`packages/opencode/src/session/prompt.ts:225-235`），但它不是本文 normal conversation assistant recovery path，也不能作为 conversation 内部 multi-step 的证据。

这意味着同一 assistant 在当前架构下**可能已经经历多个 semantic dispatches**。本方案不为这些旧 dispatch 补造单一 attempt fence：canonical incomplete 必须继续保持 `retryable:false`，且 automatic recovery 的额外 admission 条件是该 assistant 的 durable dispatch ledger 恰好只有一次 authorized semantic dispatch。若 `SessionRetry.policy()` 已开始第二次 dispatch、ledger 缺失/计数不明，或任一 dispatch fence/capability 不一致，classifier 固定 `dispatch-ambiguous`/ManualStop。另一种等价的保守实现是让 normal conversation 在首次 provider dispatch 后不再由外层 policy 重发；在没有逐-dispatch durable ledger 与覆盖全部 dispatch 的 replay proof 前，禁止 automatic recovery。


恢复上限按 logical recovery chain 中的 incomplete-triggered child 数计数；**本方案拟新增的** Prompt hard max-step guard 按 assistant admission 计数；当前 Legacy 只有 last-step prompt injection，没有该 hard admission guard。二者都不是 semantic-dispatch 或 physical-request budget。本文不新增独立的 transport request budget。实施后测试必须同时记录 assistant IDs、durable semantic-dispatch ledger entries、`streamText()` invocations 与 provider transport hits；注入“首次 dispatch 已可能产生副作用、retryable failure 触发外层第二次 dispatch、随后 incomplete”时必须 ManualStop 且 recovery provider hits 为 0。若产品需要全局 physical-request hard limit，必须另行设计 transport-level counter/guard。

### 2.5 缺少 durable recovery-chain 与实际 dispatch 证据

Legacy assistant 当前没有 recovery lineage/replay fence；实际工具集合在 Prompt 中动态解析。若 failure 与 decision 之间发生进程退出，不能用后来可能已经变化的配置、插件、权限或 tool registry 重算原请求的安全围栏。仅靠现有 history 无法证明跨重新进入的 retry budget 或原请求的 replay safety。

结论：在 provider network release 前、且 exact request/tool capabilities 已由 paused preparation 确定后，必须随 assistant attempt 持久化不可变 source dispatch evidence。以下只给出概念字段；唯一 canonical 完整定义见 §4.3，避免两处类型镜像漂移：

```text
RecoveryLineage
  └── chainID + recoveryOrdinal（只统计 incomplete-triggered child）

AssistantAttemptIdentity
  └── assistantID + chain 内单调 assistantSequence

DispatchAttemptContext
  └── 每条 dispatch 公共持有 lineage + 当前 attempt identity

RecoveryDecisionLink
  └── 仅 incomplete-triggered child 持有 source assistant + decision/binding；ordinary continuation 不复用

AttemptDispatchEvidence
  ├── available dispatch（origin 区分 initial / ordinary continuation / incomplete recovery）
  └── opaque initial / ordinary-continuation dispatch

每条 ledger entry 都携带独立 dispatchOrdinal；available entry 还绑定 exact target、
semanticReplayDigest、preparedRequestDigest、replay fence 与 capability；opaque entry
保留 provider/model 与不可 introspect 原因，但不能伪造 target/digest。
```

分类器必须读取该 assistant 的完整、按 `dispatchOrdinal` 排序的 durable dispatch ledger，不能根据当前配置重新计算。`dispatchOrdinal` 从 0 开始，每次 semantic dispatch 必须是当前 ledger 的唯一 immediate successor；同一 assistant 下序列必须连续、无重复、无缺口，并由 `(sessionID, assistantID, dispatchOrdinal)` 唯一约束与 append CAS 保证。只有 ledger 恰有一条（即唯一 ordinal 0）时才可派生 `authorizedDispatch`；多条、缺口或计数未知稳定映射 `dispatch-ambiguous`/`dispatch-evidence-inconsistent`。

第一次 assistant 使用 `chainID=assistantID`、`recoveryOrdinal=0`、`assistantSequence=0`。incomplete-triggered recovery child 必须同时满足 `recoveryOrdinal=source+1` 和 `assistantSequence=source+1`；ordinary continuation 保持 source recoveryOrdinal、但 `assistantSequence=source+1`。新用户输入创建新 chain，ordinal/sequence 都从 0 开始。所有 child admission 必须 CAS 验证 source assistant 仍是 current chain head，并以 `(sessionID, chainID, assistantSequence)` 唯一约束 candidate 是唯一 immediate successor。若进程在 dispatch evidence 已持久化后、terminal settlement 之前崩溃，重新进入时看到的是 dispatch ambiguity，必须 ManualStop，不能静默再次发送。

`preparedRequestDigest` 不能只 hash target，但它也不能承担“planned request 是 source replay”这一独立证明。每个 available semantic dispatch 同时持久化两个 digest：

- `semanticReplayDigest` 使用 `semantic-replay-v1` canonical encoding，只覆盖 exact target/authority、最终 tool definitions、影响 wire semantics 的 provider options/model parameters、以及实际 lowered system/history/body；明确排除 decisionID、child assistant identity、recovery chain/link、provider proof envelope 与 timestamp。`SafeRetry` 必须要求 planned `semanticReplayDigest === source dispatch.semanticReplayDigest`，否则即使 planned request 自洽也只能 `recovery-binding-stale`/ManualStop；
- `preparedRequestDigest` 使用 `prepared-request-v1` canonical encoding，覆盖上述 semantic payload，再加 replay fence/capability 与 discriminated authorization commitment：initial/ordinary dispatch 使用 explicit-null recovery authorization；recovery candidate 覆盖 consumed decision 中唯一 `RecoveryAuthorization` 的 digest/reference（包括 sealed key/cursor digest）以及 Continue closure。完整 provider recovery proof 只存在 consumed decision binding，child ledger/origin/digest 保存 commitment而非第二份 proof。它绑定**本次 exact dispatch/materialization**，不要求 SafeRetry source/planned 完整 prepared digest 相等，也不用于证明 Continue 的 intentional transform 等价。

secret header/value 本身不得落盘，但其 authority scope 与影响请求语义的稳定非 secret 标识必须纳入。任何插件、tool schema、provider option、模型参数、lowered history 或 proof 改变都必须产生相应不同 digest。canonicalizer 与字段集合须有 golden tests，禁止用对象默认 JSON key order 或 opaque `LanguageModelV3` identity 作为证明。recovery candidate 的 provider proof 与稳定 key/cursor 必须在 planned prepared digest 前完成绑定，且不得由稍后分配的 decisionID 派生，避免循环定义；source dispatch 的 prepared digest 只覆盖其当时 source fence/capability，不伪造未来 recovery authorization。Continue 不使用 source/planned semantic digest equality；它必须通过 explicit source + settled-tool closure transform validator，且 `closureDigest` 与 final prepared request 同时绑定该转换。

automatic proposal 必须由 source assistant、exact candidate `DispatchAttemptContext`、normalized N/M admission policy、action 与完整 `RecoveryBinding` 产生版本化 `bindingDigest`；activation transaction 再分配 durable `decisionID`/`decisionRevision`。incomplete-triggered child 的 `RecoveryDecisionLink` 同时携带 source assistant、decisionID、decisionRevision 与 bindingDigest，ordinary continuation 只有新的 `DispatchAttemptContext`，不复用该 decision link。binding 或 current planning 变化时不得覆盖旧 decision：必须 append `decisionRevision + 1`，并通过 transition 关闭旧 active revision。仅把 recovery JSON 写回 message row 再依赖 child 唯一性不够：两个 coordinator 可能产生分叉 revision 或同时消费。

存储 ownership 明确落在 shared Session SQLite schema `packages/core/src/session/sql.ts` 与 `packages/core/src/database/migration/`。**raw `EventTable` 中按 aggregate sequence 保存的 serialized recovery transition events 是唯一 canonical replay authority**；append-only relation/decision/consumption/ledger rows 是同事务 materialization，可从 raw events 重建，绝不能反向覆盖 raw event chain，也不能在缺少 matching event 时授权 dispatch。这里的 append-only 只指 live aggregate 生命周期内 transition immutable；显式删除 session 时，现有 aggregate/event/materialization cascade 可整体删除。assistant `incompleteRecovery`/`dispatchSummary` 仅是用户/API projection。

当前代码提供可复用的事务接缝：durable projector、`PublishOptions.commit(seq)`、sequence row 与 event row 位于同一 SQLite transaction（`packages/core/src/event.ts:239-352`），`EventV2Bridge` 会转发 publish options；replay 对新接受 event 运行相同 projector，而 exact same serialized event 在检测为 idempotent 后提前返回，原 callback 不会重放（`packages/core/src/event.ts:262-323`、`441-512`）。这只证明接缝存在，不证明 recovery schema/CAS/child protocol 已实现。

在线/accepted-replay 的 `RecoveryTransitionProjector` 从一个 authoritative discriminated `operation` 幂等写 relation rows、child `MessageTable` projection 与 display projection；event 另带 `nextStateDigest`，pure folder 从 predecessor + operation 导出 next state并校验 digest，不同时序列化一份可漂移的完整 `nextState`。`PublishOptions.commit(seq)` 只执行在线 CAS heads。显式 repair/validation 的 `RecoveryReplayRebuilder` 则直接按 raw `EventTable` fold 已有 rows，重建 materializations 与 heads；它不是另一个 authority。

必须有三个独立 durable tail/CAS domain：`recovery_head(sessionID, sourceAssistantID)` 管 decision revision lifecycle；`assistant_chain_head(sessionID, chainID)` 管所有 initial/ordinary/recovery assistant immediate successor；`dispatch_ledger_head(sessionID, assistantID)` 管每个 assistant 的 semantic-dispatch ordinal。每个 head 都定义 canonical genesis、expected predecessor、next digest/state、missing-versus-corrupt handling 与 affected-row=1 SQL 规则。automatic child admission 的 predecessor 是已 committed active decision transition，不是 source fact predecessor；同一 transaction CAS recovery + chain heads、创建 exactly bound child、写 child ordinal 0 ledger、consume decision。ordinary continuation也必须推进 chain head；每次 dispatch 都推进 ledger head。

关系表允许同一 `(sessionID, sourceAssistantID, sourceVersionDigest)` 存在 append-only decision revisions，但 folded state最多一个 active revision。`sourceVersionDigest` 是 §4.4.1 的完整 canonical envelope，明确绑定 `sourceAssistantID`。decision series 以 `(sessionID, decisionID, decisionRevision)` 唯一，decisionID 跨 revision 稳定；消费和 child relation 对 `(sessionID, decisionID)` 唯一。recoveryOrdinal 唯一性只作用于 incomplete-child relation；assistantSequence 作用于所有 attempt。

child admission 使用单一 serialized composite control operation，其 nested child context/dispatch commitment 被明确视为该 control transition payload，不再作为第二个 source-fact event。首个 recovery child 不另行调用 `Session.updateMessage`；`RecoveryTransitionProjector` 在同一 transaction 写兼容的 `MessageTable` row、child relation/ledger/consumption，replay 同样重建。post-commit 如需兼容 `message.updated` live notification，必须是非 durable派生通知，不能形成第二 authority。若选择保留普通 durable `MessageUpdated`，则必须先设计 `EventV2.publishBatch`/multi-event atomic protocol并相应放宽 control-tail policy；本文首选 composite operation。

`replayAll()` 当前逐 event commit；recovery replay 必须 suppress listener/global-bus/workspace live publication，直到所接受 prefix 全部 fold、materializations 与三个 heads 写入/验证完成。实现必须定义 partial-prefix crash marker/finalization 或提供 batch transaction；在 final head 之前不得发布可被 Session sync 消费的 recovery child。exact same serialized event 是 idempotent；same seq different payload/type 拒绝；同一 transitionID 出现在其他 event ID/seq 也必须拒绝，即使 operation payload相同。

migration 必须支持 existing session/message 数据且不推断旧 assistant 为 safe authority。测试必须覆盖 projector 后任一 head CAS 失败时 relation/projection/sequence/event/head 全回滚、跨新数据库 replay 等价、prefix publication suppression、错误/缺失 head、分叉/缺口/duplicate transition，以及显式 session deletion cascade。若 backend 无法提供这些原子性和 replayability，automatic recovery 不可启用。

该设计只解决已持久化 attempt 的链、预算、decision consumption 与请求前围栏，不声称解决任意时刻的 provider-dispatch crash recovery。

### 2.6 当前模型上下文 lowering 无法表达恢复语义

Legacy 对普通非 abort 的 errored assistant 整体跳过：

- `packages/opencode/src/session/message-v2.ts:248-255`。

这适合 `SafeRetry`，但会同时丢掉 `ContinueAfterSettledTools` 所需的完整 tool call/result。

但也不能简单“删除全部 reasoning”。provider-native reasoning 可能包含后续工具续传所需的 signature、encrypted state 或 metadata，并且只能在 continuation 模型兼容时复用。当前 durable `completed/end` 不足以证明 reasoning 是 provider 正常结束：

- Legacy 正常 `reasoning-end`、`step-finish` 强制收尾与 cleanup 都会写 `time.end`：`packages/opencode/src/session/processor.ts:229-235`、`459-465`、`625-631`；
- Legacy reasoning part 没有 `provider-end` / `step-boundary-flush` / `cleanup-flush` provenance。

因此当前 Legacy 修复需要 sequence-aware 的“工具续传闭包”，并在 Legacy reasoning part 中新增三态 durable completion provenance。只有明确由 provider `reasoning-end` 关闭、且具有协议要求的最终 signature/encrypted metadata 的 block 才默认可进入闭包；step-boundary/cleanup 强制 flush 的 block 必须排除，除非具体 protocol 提供独立、可测试的完整性证明。仅检查 `time.completed` 不充分。

### 2.7 StructuredOutput 状态跨 attempt 泄漏

Legacy `structured` 定义在主 while loop 外：`packages/opencode/src/session/prompt.ts:1084`，成功回调会写入该变量：`packages/opencode/src/session/prompt.ts:1252-1258`，随后在 `packages/opencode/src/session/prompt.ts:1303-1307` 被晋升为成功结果。

如果 incomplete-stream 恢复在同一个 Prompt loop 中创建新 attempt，旧 attempt 的 structured 值可能被新 attempt 误用。恢复前必须把 attempt-local StructuredOutput 状态重置，最好把变量移入 attempt 作用域。

---

## 3. 参考对照

本次不查看上游仓库。参考只包括当前本地实现、当前测试与 Issue #7 正文。

### 3.1 Issue #3 已建立的本地不变量

本地 Legacy 实现与相关 tests 已经建立以下当前态基线；本轮 official 50 仅实际执行下列 `prompt.test.ts`、`processor-effect.test.ts`、`retry.test.ts` 与 `run-process.test.ts` 的上述定向用例：

- incomplete stream 不能报告成功；
- partial text/reasoning/tool state 要保留；
- 在已覆盖的 persisted-error、length、missing-finish/high-usage 与 child/subtask fixtures 中，completed tool 没有再次执行；这不是任意未来 recovery 路径的通用 replay-safety 或 durable-before-execute 证明；
- StructuredOutput incomplete 不能晋升为成功；
- canonical incomplete-stream 不走通用 retry。

相关测试位于：

- `packages/opencode/test/session/prompt.test.ts`；
- `packages/opencode/test/session/processor-effect.test.ts`；
- `packages/opencode/test/session/message-v2.test.ts`（相关回归文件，本轮未执行）；
- `packages/opencode/test/session/retry.test.ts`；
- `packages/opencode/test/cli/run/run-process.test.ts`。

Issue #7 必须在这些 fail-stop 不变量上增加“经过证明的自动恢复”，不能撤销它们。

---

## 4. 修正方案

### 4.0 当前实施范围决策

兼容性说明：外部 API/SDK consumer 不属于 Issue #7 的产品行为验收，但 Legacy assistant schema、error discriminator 与 generated SDK 是公开 wire compatibility 面。新增 `dispatchSummary`、`incompleteRecovery` 必须采用旧数据可解码/新字段可选的兼容策略；公开 error 默认继续投影现有 `UnknownError`，typed terminal fact 先保持内部 durable contract。只有版本化 endpoint/schema 或明确接受 breaking change 后才暴露新 discriminator。补 OpenAPI/codegen drift、generated SDK type、Legacy HTTP round-trip 与旧客户端容忍性测试；不能以“外部 consumer 范围外”为由忽略 wire 影响。

本次实施范围是（recovery entrypoints 为 normal prompt/`opencode run`、进入 Legacy model 的 command、ordinary continuation 与 child/subtask；`SessionPrompt.shell()` 本身只执行/持久化本地 shell，不产生 provider stream，因此 shell incomplete recovery 为 N/A）：

1. 共享 LLM/schema 层中 Legacy 所必需的 typed classification、recovery contract 与纯语义；
2. Legacy provider/Prompt/Processor/tools/history-lowering 路径；
3. Legacy recovery 必需的 shared core persistence plumbing：Session SQLite relation、migration/generated schema、replay-safe projector/event payload 与 `EventV2` transaction seam；
4. Legacy 定向测试、CLI/child-session 回归、Legacy HTTP/generated SDK compatibility 与相应设计/开发文档。

这里列的是实现 ownership：不扩展其他 Session runtime 的 recovery 行为或产品验收，但 shared contract/storage schema 的兼容性修改及相应 shared/Native V2 回归验证仍是必要辅助工作。

该范围与当前证据支持的会话入口一致：真实 CLI subprocess 已覆盖 prompt、tool continuation 与 child/subtask；route exerciser 覆盖 Legacy prompt/command/shell handler wiring；TUI 提交到该 route 的边界当前仍以源码为证，尚缺完整 submission 端测。

### 4.1 必需不变量与可选策略

**必需不变量：**

1. incomplete attempt 永远保留 terminal error；
2. dispatch 前必须持久化 attempt identity 与 dispatch evidence：可 introspect provider 持久化 exact target/authority、capability summary、replay fence 与完整 prepared-request digest；不可 introspect provider 持久化 explicit opaque reason，并在 incomplete 时强制 ManualStop；
3. 下一次 provider 调用前，失败 attempt、工具结算、恢复 decision、decision-consumption link 与新 attempt identity 均已持久化；仅在 incomplete-recovery-child relation 中，同一 `(sessionID, chainID, recoveryOrdinal)` 只能创建一个 child，同一 decisionID 只能消费一次；所有 assistant 另由 `(sessionID, chainID, assistantSequence)` 唯一标识 immediate successor，ordinary continuation 不占用 recoveryOrdinal child 唯一键；
4. 自动恢复不得重放已执行工具；
5. pending/running/interrupted/uncertain 工具不得自动恢复；
6. provider 或 local-tool replay fence 任一维度为 `unknown` 时不得自动恢复；
7. Legacy AI SDK 提供本地工具时，必须先建立 durable-before-execute handshake，否则只能 ManualStop；
8. 恢复分类只读 durable projection；
9. 持久化失败时当前执行 fail closed；
10. 每次恢复使用新 assistant ID；
11. 自动恢复次数有显式、可持久化的上限；该上限不冒充 physical provider request 上限；
12. incomplete attempt 的 partial prose/reasoning 不得无条件进入下一次模型上下文；step-boundary/cleanup-flushed reasoning 不得被当作 provider-completed reasoning。

**策略参数与建议默认值，均需架构确认：**

- 将 recovery limit 表示为产品参数 `N`；candidate recovery 仅在 `candidateRecoveryOrdinal <= N` 时 admission。`N=2` 只是建议默认值，不是本文已确认的 contract；实现/测试必须覆盖 `N=0`、`N=1`、`N=2`；
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

不是所有 transport failure 都是 incomplete stream；classification 必须来自 canonical adapter 或 Legacy processor 的可信 settlement 检查，不能通过 message string 猜测。

#### 4.2.1 Shared type ownership 与依赖方向

本次必须固定单一 source of truth，避免 `packages/schema` 与 `packages/llm` 形成 cycle：

```text
@opencode-ai/schema  ←  @opencode-ai/llm  ←  packages/opencode
         ↑                                      │
         └──────────────────────────────────────┘
```

- `packages/schema/src/llm.ts` 拥有跨 package、可持久化/可编码的 wire schemas：`ProviderFailureClassification`、`DispatchTarget`、`ProviderSafetyDomain`、replay fence/proof、chain/link、terminal/recovery decision 及 canonical digest envelope/version 字段；
- `packages/schema/src/v1/session.ts` 只组合上述 shared schemas 形成 Legacy durable assistant/tool/reasoning envelope，不复制一套结构相似但独立的 TypeScript types；
- `packages/llm` 已依赖 `@opencode-ai/schema`（`packages/llm/package.json:45-50`），因此从 schema import contracts，并拥有 protocol adapter、domain binder、closure validator 与 canonical digest **实现**；它不得把 runtime-only implementation type 反向要求 schema import；
- `packages/opencode` 可同时依赖 schema 与 llm，负责 Legacy persistence/coordinator；runtime 内可以使用由 schema 解码类型派生的 helper aliases，但不得再声明第三套结构独立的 recovery unions；
- `packages/schema` 不得新增对 `@opencode-ai/llm` 或 `packages/opencode` 的 dependency/import。dependency graph 与 duplicate-type guard 要有 compile-time/contract-hygiene test。

这样 schema codec、LLM protocol semantics 与 Legacy durable projection 各有唯一职责，且 import 方向与当前 package 依赖一致。

#### 4.2.2 Provider preparation/introspection 边界

当前 `LLMRequestPrep.Prepared` 只包含高层 system/messages/tools/params/options/headers（`packages/opencode/src/session/llm/request.ts:38-51`），后续 AI SDK middleware、动态 provider factory 或 transport fetch wrapper 仍可能改变最终 lowering/endpoint。`Provider.getLanguage()` 也只返回 opaque language model（`packages/opencode/src/provider/provider.ts:1868-1890`）；任意动态安装 provider factory 同样存在（`packages/opencode/src/provider/provider.ts:1814-1834`）。因此不能声称简单拆分现有 `prepare()` 就能对全部 Legacy provider 得到 exact wire request/authority。

本次必须新增**显式、allowlisted、版本化的 declarative preparation/introspection contract**：只有 provider/protocol adapter 能在发送前返回稳定 `DispatchTarget`、authority、effective storage mode、replay capability、semantic prepared representation 与 digest inputs 时，才能产生 automatic-safe fence。更重要的是，closure validator、digest materializer 与实际 dispatch 必须共享同一个 no-send audited final-body lowerer，或实际 transport 在网络 release 前捕获该次 exact normalized URL/body/tool/options，先用捕获结果完成 durable authorization，再允许发送。有限的 captured golden fixtures 只能做版本回归和已知样例对照，不能证明任意运行时请求经过 `ProviderTransform.message()`、AI SDK provider lowering、middleware/fetch wrapper 后都与 validator 表示等价，也不能单独让 adapter 变为 available。authorization commit 后若仍有 middleware、动态 provider factory 或 transport rewrite 能改变 tool/reasoning/history/storage semantics，则该 adapter 不得标记 available。transport fetch wrapper 若可改写 endpoint/account authority，也必须在 contract 中提前声明有效最终 target；若只能在实际 fetch 时才知道，则必须使用上述 per-request pre-release capture/authorization gate；没有该 gate、dynamic factory 未实现 contract、或 opaque model 无法证明 target 时，resolver 必须写 opaque evidence，incomplete 后 ManualStop。该保守降级不要求一开始支持所有 provider。

### 4.3 Durable recovery model

recovery contract 必须区分四类对象，不能沿用旧架构稿中把它们合并的 historical `AttemptRecoveryEvidence`：

1. **原 attempt 的 durable source facts**：只能来自同一 transaction-consistent reload；
2. **本次候选 action 的 no-send planning result**：由当前 runtime adapter 针对一个 paused request 产生，不是 source durable fact；
3. **内部权威 decision record**：append-only transition chain 中可重放、可消费的事实；
4. **公开 projection**：只用于用户/API 展示，不能作为 classifier、CAS 或 dispatch authorization 的输入。

核心 identity 与 source dispatch ledger：

```ts
type RecoveryLineage = {
  chainID: string
  recoveryOrdinal: number // 只统计 incomplete-triggered recovery child
}

type AssistantAttemptIdentity = {
  assistantID: string
  assistantSequence: number // chain 内每个 admitted assistant 单调递增
}

type DispatchAttemptContext = {
  lineage: RecoveryLineage
  attempt: AssistantAttemptIdentity
}

type RecoveryDecisionLink = {
  sourceAssistantID: string
  decisionID: string
  decisionRevision: number
  bindingDigest: string
}

type DispatchOrigin =
  | { type: "initial-user" }
  | { type: "ordinary-continuation" }
  | {
      type: "incomplete-recovery"
      decision: RecoveryDecisionLink
    }

type AvailableDispatchEvidence = {
  type: "available"
  dispatchOrdinal: number
  context: DispatchAttemptContext
  origin: DispatchOrigin
  target: DispatchTarget
  semanticReplayDigest: string // semantic-replay-v1
  preparedRequestDigest: string // prepared-request-v1
  replayFence: AttemptReplayFence
  capabilities: {
    localToolsOffered: boolean
    providerSideEffectsOffered: boolean
  }
}

type OpaqueDispatchEvidence = {
  type: "opaque"
  dispatchOrdinal: number
  context: DispatchAttemptContext
  origin: { type: "initial-user" } | { type: "ordinary-continuation" }
  reason:
    | "provider-introspection-unavailable"
    | "target-authority-unavailable"
    | "wire-semantics-unverifiable"
  providerID: string
  modelID: string
  localToolsOffered: boolean | "unknown"
}

type AttemptDispatchEvidence = AvailableDispatchEvidence | OpaqueDispatchEvidence
```

`AttemptDispatchEvidence` 只记录该 assistant 当时真正 authorized 的 semantic dispatch 事实。它不保存“未来 recovery request 的 provider proof”。`DispatchOrigin.incomplete-recovery` 也只保存 `RecoveryDecisionLink`；dispatch revalidator 必须通过已经 consumed 的内部 decision 读取唯一 recovery authorization，再验证实际 dispatch 是否满足它。这样 source ledger 的 replay fence、内部 decision 的 recovery authorization 和 child origin 各自只有一个职责，不会出现三份可独立漂移的 proof。

每个 semantic dispatch 必须在 provider network release 前写入 authoritative ledger，并区分两条轴：semantic introspection 为 `available | opaque`，mechanical send gate 为 `implemented | unavailable`。普通初始请求遇到 opaque/dynamic provider 只有在 mechanical gate implemented、`OpaqueDispatchEvidence` commit 后才可发送；若 gate unavailable，covered execution 必须 fallback/disable，不能先发送后补 evidence。若 opaque request 随后 incomplete，固定 ManualStop。自动 recovery child 同时要求 gate implemented 与 `AvailableDispatchEvidence`。

#### 4.3.1 Durable source snapshot

```ts
type IncompleteStreamTerminalFact = {
  classification: "incomplete-stream"
  message: string
  lineage: RecoveryLineage
  attempt: AssistantAttemptIdentity
}

type RecoverySourceVersion = {
  sourceAssistantID: string
  factsDigest: string
  versionDigest: string
  aggregateID: string // Legacy 中必须等于 sessionID
  sourceEventSequenceHighWater: number
  hashVersion: "recovery-event-chain-v1"
  sourceSequenceHashChainDigest: string
  providerPrefixVersion?: DurableProviderPrefixVersion
}

type RecoveryControlTailVersion = {
  aggregateID: string
  sourceAssistantID: string
  fromSequenceExclusive: number
  toSequenceInclusive: number
  hashVersion: "recovery-event-chain-v1"
  controlEventTypesVersion: "v1"
  controlFieldsVersion: "v1"
  allowedEventTypesDigest: string
  tailHashChainDigest: string // empty tail 也有固定 canonical genesis encoding
}

type ToolRecoveryEvidence = {
  id: string
  name: string
  executionKind: "local" | "provider" | "unknown"
  inputState: "open" | "complete" | "unknown"
  callState: "not-observed" | "durable" | "unknown"
  state: "pending" | "running" | "completed" | "error"
  interruption:
    | undefined
    | "execution-interrupted"
    | "provider-result-missing"
}

type DurableProviderContinuation = {
  domain: ProviderSafetyDomain
  cursor: SealedRecoveryMaterialRef
  providerPrefixVersion: DurableProviderPrefixVersion
}

type DurableRecoverySnapshot = {
  source: "durable-recovery-snapshot"
  sourceAssistantID: string
  terminal: IncompleteStreamTerminalFact
  dispatchLedger: AttemptDispatchEvidence[] // 按 dispatchOrdinal 排序
  authorizedDispatch?: AttemptDispatchEvidence // 仅 ledger 恰有一条时派生
  frozenRecoverySourceVersion: RecoverySourceVersion
  currentControlTailVersion: RecoveryControlTailVersion
  providerContinuation?: DurableProviderContinuation
  tools: ToolRecoveryEvidence[]
  sourceDecisionState?: RecoveryDecisionState // 只描述当前 source assistant 自己的 decision lifecycle
  originConsumption?: {
    childAssistantID: string
    sourceAssistantID: string // parent source assistant
    decisionID: string
    decisionRevision: number
    bindingDigest: string
    decision: RecoveryDecisionRecord // recovery-child origin 的唯一 authorization
  }
}
```

`DurableRecoverySnapshot` **不得**包含新计算出的 target、closure、planned digest、当前 provider config 的推导结果或 paused request handle。其全部字段必须能从同一 reload boundary 的 assistant/part projection、authoritative relational ledger/decision transitions 与 event-log checkpoints 取得。

关键 identity equality 必须作为 source consistency 前置条件：

```text
sourceAssistantID
= terminal.attempt.assistantID
= authorizedDispatch.context.attempt.assistantID
= frozenRecoverySourceVersion.sourceAssistantID
= sourceDecisionState.current.sourceAssistantID（若当前 source 自己已有 decision）

originConsumption（若 source 本身是 recovery child）另行满足：
childAssistantID = sourceAssistantID，且其 parent source/decision/revision/binding
精确等于 authorizedDispatch.origin.decision；不得要求 parent sourceAssistantID = childAssistantID
```

`terminal.lineage` 也必须等于 `authorizedDispatch.context.lineage`。任何 identity mismatch 都是 `dispatch-evidence-inconsistent`，不能进入 planning。

工具 evidence 不得把可选 `providerExecuted` 缺失解码为 `false`。只有 durable call 与 dispatch definition 能证明 local/provider execution 时才能使用对应值；旧数据缺字段、tool definition 不可解析或二者冲突时必须是 `unknown`。`open`、`pending/running`、interruption、call 未 durable 或 execution kind unknown 都 fail closed。

#### 4.3.2 Planned no-send materialization

planning 结果必须由 runtime adapter 针对**一个具体候选 action**产生，并与 durable snapshot 分开：

```ts
type AutomaticRecoveryAction =
  | "safe-retry"
  | "continue-after-settled-tools"

type PlannedRecoveryUnavailableCause =
  | "planned-target-unavailable"
  | "planned-authority-unavailable"
  | "planned-request-materialization-failed"
  | "planned-request-digest-failed"
  | "planned-runtime-proof-unavailable"
  | "provider-proof-unavailable"
  | "dispatch-lowering-unverifiable"

type ContinuationClosureUnavailableCause =
  | "provider-end-reasoning-missing"
  | "reasoning-signature-missing"
  | "encrypted-reasoning-state-missing"
  | "reasoning-item-reference-missing"
  | "reasoning-provider-metadata-missing"
  | "hosted-item-reference-missing"
  | "storage-mode-not-replayable"
  | "continuation-item-kind-unsupported"
  | "model-incompatible"
  | "protocol-unsupported"

type PlannedRecoveryUnavailable =
  | { phase: "planning"; cause: PlannedRecoveryUnavailableCause }
  | {
      phase: "continuation-closure"
      cause: ContinuationClosureUnavailableCause
    }

type RecoveryAuthorization = {
  sourceAssistantID: string
  sourceDispatchOrdinal: number
  providerProof: ProviderRecoveryProof
}

type PlannedRecoveryMaterialization =
  | {
      type: "available"
      action: AutomaticRecoveryAction
      target: DispatchTarget
      semanticReplayDigest: string
      preparedRequestDigest: string
      replayFence: AttemptReplayFence
      capabilities: {
        localToolsOffered: boolean
        providerSideEffectsOffered: boolean
      }
      continuationClosure:
        | { type: "not-needed" }
        | { type: "constructible"; target: DispatchTarget; digest: string }
      authorization: RecoveryAuthorization
      preparedRequest: PreparedRequestHandle // runtime-only linear handle；永不持久化
    }
  | {
      type: "unavailable"
      action: AutomaticRecoveryAction
      unavailable: PlannedRecoveryUnavailable
      detail?: string // diagnostic only；不得代替 typed cause
    }
```

`PreparedRequestHandle`/`AuthorizedRequestHandle` 是 transport runtime 的线性资源，不进入 schema、event payload、digest 或 public projection。状态只允许 `prepared → authorized → released`、`prepared → cancelled`、`authorized → cancelled`；失去 ownership 时必须 cancel/fail closed。

planning 顺序固定为：

1. 从 durable snapshot 选择候选 action并预分配 exact candidate context；
2. `preparePausedRequest()` 在真实 transport gate 上产生 exact normalized URL/authority/body/tools/options/storage mode，但保持网络暂停；
3. 由该 exact request 计算 semantic/prepared digest、provider authorization 与 Continue closure；
4. 生成 normalized N/M、candidate sequence、chain-head expectation 与 policy digest 的 `RecoveryAdmissionPlan`；
5. pure classifier 读取 `{ durableSnapshot, plannedMaterialization, admissionPlan }`，只返回 proposal；
6. activation/CAS/child transaction 返回 matching receipt 后，同一 handle 才可 authorize/release。

current provider configuration 参与的是第 2–3 步 planned materialization，不会倒灌进 frozen source snapshot。captured golden fixtures 只证明固定样例稳定，不能代替每次 paused request 的 runtime authorization。

#### 4.3.3 内部权威 decision 与公开 projection

```ts
const MANUAL_STOP_REASON_ORDER = [
  "dispatch-evidence-inconsistent",
  "dispatch-ambiguous",
  "provider-introspection-unavailable",
  "planned-target-unavailable",
  "planned-authority-unavailable",
  "planned-request-materialization-failed",
  "planned-request-digest-failed",
  "planned-runtime-proof-unavailable",
  "provider-replay-unknown",
  "provider-continuation-unavailable",
  "provider-proof-unavailable",
  "recovery-action-inapplicable",
  "local-tool-replay-unknown",
  "open-tool-input",
  "unsettled-tool",
  "interrupted-tool",
  "uncertain-tool-result",
  "dispatch-lowering-unverifiable",
  "continuation-context-unavailable",
  "recovery-binding-stale",
  "recovery-budget-exhausted",
  "same-process-max-step-exhausted",
  "superseded-by-new-user-input",
  "internal-classification-failure",
] as const

type ManualStopReason = (typeof MANUAL_STOP_REASON_ORDER)[number]

type RecoveryDecisionAction =
  | { type: "safe-retry" }
  | { type: "continue-after-settled-tools" }
  | { type: "manual-stop"; reasons: ManualStopReason[] }

type RecoveryAdmissionPlan = {
  nextContext: DispatchAttemptContext
  normalizedMaxSteps: number
  recoveryLimit: number
  maxStepAvailable: boolean
  recoveryBudgetAvailable: boolean
  expectedChainHeadAssistantID: string
  allowedControlEventTypesVersion: "v1"
  allowedControlTailPolicyDigest: string
  policyDigest: string // N/M + control policy + candidate context 的 canonical digest
}

type RecoveryBinding = {
  sourceAssistantID: string
  nextContext: DispatchAttemptContext
  target: DispatchTarget
  semanticReplayDigest: string
  preparedRequestDigest: string
  recoverySourceVersion: RecoverySourceVersion
  admission: RecoveryAdmissionPlan
  closureDigest?: string
  authorization: RecoveryAuthorization
}

type RecoveryDecisionProposal = {
  sourceAssistantID: string
  sourceVersionDigest: string
  action: RecoveryDecisionAction
  bindingDigest: string
  binding?: RecoveryBinding
}

type RecoveryDecisionStatus =
  | "active"
  | "consumed"
  | "superseded"
  | "finalized"

type RecoveryDecisionRecord = RecoveryDecisionProposal & {
  decisionID: string // 同一 decision series 的 revisions 间稳定
  decisionRevision: number
  status: RecoveryDecisionStatus
}

type RecoveryDecisionState = {
  current: RecoveryDecisionRecord
  child?: {
    context: DispatchAttemptContext
    terminal: "none" | "incomplete" | "success" | "other-error"
  }
}

type DispatchSummaryProjection = {
  dispatchCount: number
  evidence: "available" | "opaque" | "inconsistent"
}

type IncompleteRecoveryProjection = {
  terminal: {
    classification: "incomplete-stream"
    message: string
    sourceAssistantID: string
  }
  decision?: {
    decisionID: string
    decisionRevision: number
    status: RecoveryDecisionStatus
    action: RecoveryDecisionAction
  }
}
```

pure classifier 只能生成 `RecoveryDecisionProposal`，不能自行分配 CAS-dependent `decisionID`/`decisionRevision` 或声称 durable authority。activation transaction 校验 predecessor、为同一 decision series 分配/复用稳定 `decisionID` 与 next revision，写入 transition 后才返回 authoritative `RecoveryDecisionRecord`。automatic decision 的 `action` 不得只靠调用者参数、公开 projection 或 binding 内容反推；`bindingDigest` 必须覆盖 authoritative action、完整 binding 与 admission policy。ManualStop proposal/record 只持久化 reasons，不构造虚假 target/proof/binding。

assistant optional `incompleteRecovery` / `dispatchSummary` 分别只使用 `IncompleteRecoveryProjection` / `DispatchSummaryProjection`。后者只能是上述可重建 display facts，不得包含 target/authority、fence/proof、key/cursor、semantic/prepared/binding digest、decision link 或 CAS metadata。公开 projection 不包含完整 dispatch ledger、provider proof、cursor、prepared request material、source/control-tail hash、CAS predecessor 或 paused handle；projection 不得被 classifier、admission CAS 或 dispatch gate 读取为 authority。公开 Legacy error 继续投影现有 `UnknownError` + canonical message；若未来新增 public error discriminator，必须另行做 wire compatibility 决策。

internal decision 的 active/consumed/superseded/finalized 生命周期由 append-only transition 关系表示，不在同一 mutable JSON object 上覆盖。first revision 为 0；reclassification、budget/max-step exhaustion 或 new-user supersession append revision + 1，并把旧 active revision标为 superseded；新 ManualStop revision 直接 finalized，不能改写旧 automatic action。同一 source version 最多一个 active revision。公开 projection 总是指向 latest effective committed revision。`recovery_head` 只指向当前 folded transition，具体 authority/replay 规则见后续 persistence 段。

### 4.4 权威 evidence 与 paused dispatch protocol

#### 4.4.1 Source checkpoint 与 control tail

不能只写“allowlisted events/fields”。实现必须在 shared schema 中声明以下**版本化 canonical sets**；这些名称是 future internal serialized recovery event kinds，不是当前已存在的生产事件：

```ts
const RECOVERY_SOURCE_FACT_EVENT_TYPES_V1 = [
  "session.recovery.dispatch-recorded",
  "session.recovery.tool-evidence-recorded",
  "session.recovery.reasoning-evidence-recorded",
  "session.recovery.provider-prefix-recorded",
  "session.recovery.incomplete-terminal-recorded",
] as const

const RECOVERY_CONTROL_EVENT_TYPES_V1 = [
  "session.recovery.decision-revision-activated",
  "session.recovery.decision-finalized",
  "session.recovery.child-admitted-and-consumed",
] as const

const RECOVERY_SOURCE_FACT_FIELDS_V1 = {
  "session.recovery.dispatch-recorded": [
    "sessionID", "assistantID", "dispatchOrdinal", "context", "origin",
    "evidenceType", "target", "semanticReplayDigest", "preparedRequestDigest",
    "replayFence", "capabilities", "opaqueReason", "providerID", "modelID",
  ],
  "session.recovery.tool-evidence-recorded": [
    "sessionID", "assistantID", "toolID", "toolName", "partSequence",
    "executionKind", "inputState", "callState", "state", "interruption",
  ],
  "session.recovery.reasoning-evidence-recorded": [
    "sessionID", "assistantID", "partID", "partSequence", "provenance",
    "providerMetadataDigest", "signatureDigest", "encryptedStateDigest",
  ],
  "session.recovery.provider-prefix-recorded": [
    "sessionID", "assistantID", "domain", "cursorDigest",
    "aggregateID", "eventSequenceHighWater", "hashVersion", "hashChainDigest",
  ],
  "session.recovery.incomplete-terminal-recorded": [
    "sessionID", "assistantID", "classification", "messageCode", "messageDigest",
    "lineage", "attempt",
  ],
} as const

const RECOVERY_CONTROL_TAIL_FIELDS_V1 = {
  "session.recovery.decision-revision-activated": [
    "sessionID", "transitionID", "expectedPredecessor",
    "operation", "nextStateDigest",
  ],
  "session.recovery.decision-finalized": [
    "sessionID", "transitionID", "expectedPredecessor",
    "operation", "nextStateDigest",
  ],
  "session.recovery.child-admitted-and-consumed": [
    "sessionID", "transitionID", "expectedPredecessor",
    "operation", "nextStateDigest",
  ],
} as const
```

字段是否适用于某个 union variant 必须用 canonical explicit `null`/discriminator 规则编码，不能依赖 JavaScript `undefined` omission。secret、原始 cursor、credential 和未 hash 的 provider metadata 不进入 canonical envelope；上表对应字段只能保存稳定 non-secret value 或 versioned digest。terminal 的用户文案由稳定 `messageCode`（例如 canonical incomplete-stream code）确定性重建，`messageDigest` 用于校验；不能要求跨数据库 replay 从 digest 反推原始任意字符串。

四个 set 的 ownership：

- schema/codec 与 exact membership：`packages/schema`；
- `semantic-replay-v1` / `prepared-request-v1` / `recovery-binding-v1` canonicalizer：`packages/llm`，只 import `packages/schema` envelope；
- `recovery-event-chain-v1`、source facts/version 与 control-tail canonicalizer/extraction：`packages/core`，只 import schema 的 canonical sets/envelopes；
- online persistence 与 replay rebuild：`packages/core`；
- Legacy `packages/opencode` 只提供 typed runtime values/event payload，不复制 canonical field lists 或 hash implementation；
- Legacy runtime 只生产 typed payload，不自行维护另一份 field list。

`recovery-event-chain-v1` 对 session aggregate 中**每个** `seq <= sourceEventSequenceHighWater` 的 durable serialized event 按原始 sequence 计算完整 hash chain；即使是与 recovery 无关的普通事件，也通过 full-payload digest 影响 `sourceSequenceHashChainDigest`。`factsDigest` 则只提取 `RECOVERY_SOURCE_FACT_EVENT_TYPES_V1` 中且 assistantID 等于 `RecoverySourceVersion.sourceAssistantID` 的 event，并严格按 event sequence 使用 `RECOVERY_SOURCE_FACT_FIELDS_V1` 生成 canonical fact envelopes。terminal/tool settlement 完成后冻结 `RecoverySourceVersion`。

source/control 分类必须互斥：任何 event type 不得同时属于两个集合。未知 `session.recovery.*` event type、已知 type 缺 required field、出现 schema 不允许的额外 authority field、同一 seq 重复、同 seq 不同 payload/type、field-set/hash version 不识别，都 fail closed。普通 user input、model/tool config 变化、normal assistant/tool event、transcript mutation 或 unrelated projection update 可以出现在冻结 source high-water **之前**并由完整 event hash 绑定，但不得出现在 frozen high-water 之后的 recovery control tail。

`RecoveryControlTailVersion` 从 `sourceEventSequenceHighWater + 1` 到当前 high-water，要求每个 durable event 都属于 `RecoveryAdmissionPlan.allowedControlEventTypesVersion` 指定的 `RECOVERY_CONTROL_EVENT_TYPES_V1`，并按 `RECOVERY_CONTROL_TAIL_FIELDS_V1` canonicalize；exact allowlist、fields version 与 empty-tail policy 共同产生 `allowedControlTailPolicyDigest`，并被 admission `policyDigest`/binding 覆盖。三类允许语义为：

- decision revision activation；
- ManualStop/finalization，包括 retry/max-step exhaustion 与 `superseded-by-new-user-input`；
- child admission 与 decision consumption 的单一原子 transition。

`transitionID`、`expectedPredecessor`、authoritative discriminated `operation` 与 `nextStateDigest` 是每个 control event 的 transition metadata；pure folder 从 predecessor + operation 唯一导出 next state并验证 digest。operation 内包含该 transition 所需的 decision/ManualStop/child/consumption 数据，不在顶层或完整 nextState 再复制一份。三个 head updates 本身不是额外 serialized events，也不能被 tail digest 从本地 callback 状态推断。任何普通 input/config/history/tool event 出现在 control tail 都使旧 binding stale，必须 cancel staged request并重新读取/分类。

provider continuation cursor 必须来自 stream；其 sealed material、`cursorDigest` 与 `provider-prefix-recorded` event/checkpoint 在同一 transaction 持久化。event/canonical envelope 只含 ref/digest/keyVersion 与 prefix，不含 raw cursor。Continue 比较前必须先验证 durable source、durable continuation 与 planned authorization 三处都存在 prefix/ref/digest；missing、extra 或不同绑定均 fail closed。runtime 在 gated preparation 内 unseal 后重新校验 digest，再强制 `prefix.assistantID = RecoverySourceVersion.sourceAssistantID = snapshot.sourceAssistantID`，并验证 aggregate/session、high-water、hash version/digest 与 ancestry；无法 unseal 或重启后无安全 material storage 时 continuation unavailable。

`RecoverySourceVersion.versionDigest` 只允许由以下完整 canonical envelope 计算：

```text
recovery-source-version-v1({
  aggregateID,
  sourceAssistantID,
  sourceEventSequenceHighWater,
  hashVersion,
  sourceSequenceHashChainDigest,
  factsDigest,
  providerPrefixVersion: explicit-null-or-canonical-value,
  sourceFactEventTypesVersion: "v1",
  sourceFactFieldsVersion: "v1",
})
```

`RecoveryControlTailVersion` 同理绑定 aggregate/source assistant、hash version、control event-types/fields version、from/to sequence、canonical type digest 与 tail hash；空 tail 使用固定 genesis encoding。不能只比较调用者复制的 digest string。`recovery-event-chain-v1` 必须直接按 raw `EventTable` 的 aggregate sequence 读取，并 hash canonical `{id, aggregateID, seq, type, data, previousDigest, hashVersion}`；manifest-filtered API 不足以覆盖每个 durable event。source fact extraction 只选该 `sourceAssistantID` 的 recovery facts，而完整 aggregate chain 仍绑定所有事件。

实现前必须规划以下 golden/mutation tests：

1. 四个 canonical sets 的 exact membership/order golden；
2. 每个 event kind 的 required/nullable/forbidden field golden；
3. object insertion order 改变不改变 digest，任一 canonical field 值改变必须改变相应 digest；
4. unknown recovery event、missing required field、forbidden authority field、source/control set overlap 均拒绝；
5. duplicate sequence、sequence gap、same sequence/different payload/type 均拒绝；
6. unknown hash/event-types/field-set version 均拒绝；
7. source high-water 后出现 user/config/history/tool event 使 control tail stale；
8. prefix missing/extra/mismatch 与 ancestry mutation 均拒绝；
9. serialized events 跨新数据库 replay 后，source facts/version、control tail、decision revisions、consumption、child ledger、projection 与 derived head 完全等价；
10. online fold 与 replay rebuilder 的 final head/active revision 相同；故意制造 predecessor branch/gap 时二者都失败而不是择一修复。

有限 golden fixtures 只证明这些固定 canonical samples，不证明任意 runtime transport lowering；后者仍由 paused-request authorization integration 负责。

#### 4.4.2 Prepare → authorize → release / cancel

network send 必须有机械上的 staged lifecycle：

```ts
type RecoveryAdmissionReceipt = {
  sourceAssistantID: string
  decisionID: string
  decisionRevision: number
  bindingDigest: string
  childContext: DispatchAttemptContext
  dispatchOrdinal: 0
  preparedRequestDigest: string
}

interface PreparedRequestHandle {
  authorize(receipt: RecoveryAdmissionReceipt): AuthorizedRequestHandle
  cancel(): Promise<void> // prepared → cancelled；先机械关闭 gate，再做 cleanup
}

interface AuthorizedRequestHandle {
  release(): Promise<Stream<LLMEventBatch>> // authorized → released；单次返回 processor 消费的 stream
  cancel(): Promise<void> // authorized → cancelled；release 后拒绝
}

preparePausedRequest(input): Promise<{
  normalizedRequest: CanonicalPreparedRequest
  digestInputs: PreparedRequestDigestInputs
  handle: PreparedRequestHandle
}>
```

执行协议：

1. **Prepare**：runtime adapter 在最终 middleware/`transformParams` 之后、实际 provider `doStream`/fetch 之前完成 exact lowering/endpoint/authority/tool/options/storage normalization，返回 `prepared` handle；此时 provider hit 必须为 0。
2. **Classify**：pure classifier 读取 durable snapshot、planned materialization 与 `RecoveryAdmissionPlan`，只产出 proposal。预算/max-step、candidate context 与 policy digest 此时已确定并绑定。
3. **Authorize**：activation/admission transaction 重读 source/control state，同时 CAS `recovery_head`、`assistant_chain_head` 与需要的 `dispatch_ledger_head`，原子写 decision revision、exact child、ordinal-0 ledger 与 consumption，返回不可变 `RecoveryAdmissionReceipt`。所有 mutable-tail/policy/CAS 检查都必须在该 transaction 内完成。
4. **Release**：同一个 prepared handle 只接受完全匹配的 receipt，转成 authorized handle；commit 后只校验 receipt/handle immutable identity，然后 `release()` 一次并返回 processor 消费的 `Stream<LLMEventBatch>`。不得在 commit 后再重算可变 policy 或替换 request。
5. **Cancel**：classifier ManualStop、typed planning unavailable、binding stale、CAS/持久化失败、supersession、budget/max-step exhaustion、coordinator ownership 丢失或任何 pre-release exception 都必须先机械关闭 gate，再 cleanup，并断言 provider hits 为 0。

仅构造 `streamText()` 后延迟消费 `fullStream` **不算 paused request**：pinned AI SDK 会在 construction/root operation 中启动 step/`doStream`，下游尚未迭代也可能已经发送。实现必须在最终 transform 之后、underlying `doStream`/custom-or-global fetch 之前提供真实 gate，或使用与实际发送共享的 audited exact no-send lowerer；当前 `AbortController` 只提供 cancellation，不证明零发送。

“materialize”仅表示构造 canonical request representation/digest inputs；“prepare paused request”表示 transport gate 已创建但尚未发送；“release”才是允许网络发送。不得再用“materialize new attempt”暗指 provider dispatch。`CanonicalPreparedRequest` 与 `PreparedRequestDigestInputs` 必须由 shared schema/canonicalizer 明确定义，前者是不含 secret raw values 的 exact normalized semantic representation，后者是生成 semantic/prepared digest 的 versioned inputs。

进程重启后不存在可恢复的内存 handle。re-entry 必须重新 prepare；若 immutable request、admission plan 或 policy 已变化，cancel 旧 handle并 append 新 decision revision，不能让旧 decision 静默授权新 request。仅凭 durable old decision 不得直接发送。若进程在 child/ledger/consumption commit 后、可观察 release/settlement 前崩溃，仍属于 ambiguous dispatch boundary，不能声称 exactly-once；按 crash policy fail closed。

#### 4.4.3 Durable persistence authority

权威关系固定为：

```text
raw EventTable serialized recovery transition events
  = sole canonical replay authority

append-only relations / decision / ledger / projection rows
  = transactional rebuildable materializations

recovery_head + assistant_chain_head + dispatch_ledger_head
  = derived online CAS indexes

assistant incompleteRecovery / dispatchSummary
  = public/user projection
```

四层不能互相替代。任一 materialized relation/head 缺少 matching raw event 时不能 authorize；任一 head 与从 raw chain fold 的结果不一致时 runtime fail closed。

当前 `EventV2` 的 durable transaction 顺序是 projector(s) → `commit(seq)` → sequence/event row insert。accepted replay 对新 event 也运行相同 projectors；exact replay 在 equality check 后返回；callback 不会序列化或重放。因此组件固定为：

##### RecoveryTransitionProjector

- 同时服务 online publish 与 accepted replay；从 authoritative discriminated `operation` 幂等写 immutable relations、decision/consumption、child `MessageTable`/ledger 与 rebuildable public projection；
- 校验 `nextStateDigest = fold(predecessor, operation)`，不接受 independently serialized full nextState；
- 不覆盖三个 CAS heads；同 transitionID 在其他 event ID/seq 一律拒绝；
- composite child operation 是唯一 durable child creation authority；post-commit live notification 只能是派生非 durable signal。

##### RecoveryHeadsCommit

- online publish 时由 `PublishOptions.commit(seq)` 原子 CAS `recovery_head`、`assistant_chain_head`、`dispatch_ledger_head` 中该 operation 需要的集合；
- 每个 head 使用 explicit genesis/predecessor/next digest，affected rows 必须恰为预期；missing genesis 可以初始化，非 genesis missing 或 digest 不符视为 corrupt；
- 任一失败使 projector rows、projection、event sequence/event row 与所有 head mutation 全部 rollback。

##### RecoveryReplayRebuilder

- explicit repair/validation 时直接按 raw `EventTable` aggregate sequence fold authoritative operations；重建 relations/projection 与三个 heads；
- `replayAll()` 导入新数据库时必须 suppress publication，直到完整 accepted prefix fold 和 head finalization 成功；定义 prefix marker/batch transaction，不能逐 event 暴露半成品 child；
- 分叉、缺口、same seq different payload/type、same transitionID different event、two-active revisions、orphan child/consumption、sequence/hash mismatch 都失败而不择一修复。

`RecoveryTransitionProjector` 与 `RecoveryReplayRebuilder` 可复用 pure folder，但前者是 transaction projector，后者是对 raw authority 的 explicit rebuild。migration 必须支持 existing data且不推断旧 assistant 为 safe authority；live aggregate 内 individual transitions immutable，显式 session deletion 可按现有 cascade 删除整个 aggregate/materializations。

必须有以下 persistence/replay tests：

- empty database schema、existing-data upgrade、unique index 与 cascade compatibility；
- online happy path：projector rows + head CAS + event row 同时 commit；
- projector 完成后 head CAS 失败：所有 rows/projection/event sequence/event row/head 全部回滚；
- duplicate same transition/same payload 幂等，same transition/different payload 拒绝；
- concurrent revision/consume/supersede race 只有一个 head CAS 成功；
- serialized events replay 到新数据库后 authority relations、active revision、consumption、child ledger、projection、canonical source/control digests 与 derived head 全部一致；
- 删除/重排/篡改单个 event、制造 predecessor branch/gap、预置错误 head 均 fail closed；
- public projection 被篡改时不能作为 authority dispatch；rebuilder从 transition chain重建后才能恢复一致 projection。

#### 4.4.4 Legacy 执行顺序

1. initial/ordinary semantic dispatch 先 `preparePausedRequest()`；available adapter 计算并 durable 写入 exact dispatch evidence，opaque adapter durable 写入 opaque evidence；事务成功后才 release 初始请求；
2. stream terminal 后等待已登记工具并持久化 executionKind、input/call phase、settlement/interruption 与 reasoning provenance；
3. 持久化不含 decision 的 `IncompleteStreamTerminalFact`；
4. reload `DurableRecoverySnapshot`；
5. 针对 SafeRetry 或 Continue 候选 prepare paused request，生成 `PlannedRecoveryMaterialization`；planning unavailable 时不伪造 binding；
6. 构造 exact `RecoveryAdmissionPlan`；pure classifier 读取 `{ durableSnapshot, plannedMaterialization, admissionPlan }`，产出 `RecoveryDecisionProposal`；
7. ManualStop proposal 经 transition commit 后 cancel handle并返回现有 break；automatic proposal 进入 activation/admission transaction；
8. transaction 重读 source/control/admission policy，验证 exact binding，同时 CAS recovery/chain/ledger heads；变化时 cancel并以新 revision重新 planning，不复用旧 proposal；
9. 同一 transaction 激活/消费 committed decision、创建 proposal 绑定的 exact child、ordinal-0 ledger 与 consumption，并返回 `RecoveryAdmissionReceipt`；
10. prepared handle 只接受 matching receipt，转为 authorized 后 release 一次并返回 child processor stream；任一前置步骤失败都 cancel，provider recovery hits 必须为 0。

这套协议不声称解决 provider 已收到 request、但客户端尚未观察到 response/settlement 时的任意 crash exactly-once 问题。

### 4.5 保守分类器

pure classifier 的输入固定为：

```ts
classifyIncompleteRecovery({
  durableSnapshot,
  plannedMaterialization,
  admissionPlan,
}: {
  durableSnapshot: DurableRecoverySnapshot
  plannedMaterialization: PlannedRecoveryMaterialization
  admissionPlan: RecoveryAdmissionPlan
}): RecoveryDecisionProposal
```

它不调用 provider、不解析当前 model factory、不创建 runtime handle，也不自行持久化。runtime adapter/transport gate 负责 exact lowering、target/authority、prepared handle、digest、provider authorization 与 release/cancel；admission planner 负责 exact candidate/N/M/policy；live runner ownership 是独立 runtime input，只用于 re-entry attach 决策，不进入 durable snapshot/classifier proof。classifier 只验证已有 typed durable/planned/admission inputs并产出 proposal。

```text
sourceConsistent
:= snapshot.source = durable-recovery-snapshot
   and terminal 是 confirmed durable incomplete fact
   and dispatchLedger.length = 1
   and authorizedDispatch is present
   and dispatch := authorizedDispatch
   and sourceAssistantID = terminal.attempt.assistantID
   and sourceAssistantID = dispatch.context.attempt.assistantID
   and terminal.lineage = dispatch.context.lineage
   and frozenRecoverySourceVersion.sourceAssistantID = sourceAssistantID
   and sourceDecisionState.current.sourceAssistantID = sourceAssistantID（若存在）
   and tool evidence 与 dispatch capability/fence 不矛盾：
       providerSideEffectsOffered=false/no-provider-side-effects 时不得出现 provider tool evidence；
       localToolsOffered=false/none-offered 时不得出现 local tool evidence
   and dispatchOrdinal/ledger envelope 可解码且无重复/缺口

originalDispatchAvailable
:= sourceConsistent
   and dispatch.type = available
   and replayFence 与 capability summary 不矛盾
   and every domain-bearing fence structurally covers dispatch.target
   and semantic/prepared digest version 可识别

recoveryOriginConsistent
:= dispatch.origin.type != incomplete-recovery
   or (
        originConsumption is present
        and originConsumption.childAssistantID = sourceAssistantID
        and originConsumption.sourceAssistantID = dispatch.origin.decision.sourceAssistantID
        and originConsumption.decisionID = dispatch.origin.decision.decisionID
        and originConsumption.decisionRevision = dispatch.origin.decision.decisionRevision
        and originConsumption.bindingDigest = dispatch.origin.decision.bindingDigest
        and originConsumption.decision.status = consumed
        and originConsumption.decision.action.type in {
          safe-retry,
          continue-after-settled-tools
        }
        and originConsumption.decision.binding is present
        and originConsumption.decision.binding.nextContext = dispatch.context
        and originConsumption.decision.binding.semanticReplayDigest = dispatch.semanticReplayDigest
        and originConsumption.decision.binding.preparedRequestDigest = dispatch.preparedRequestDigest
        and actualDispatchMatchesAuthorization(
          dispatch,
          originConsumption.decision.binding.authorization
        )
      )

planAvailableFor(action)
:= plannedMaterialization.type = available
   and plannedMaterialization.action = action
   and preparedRequest ownership 仍由当前 coordinator 持有

bindingFor(action)
:= canonical binding constructed from
   durableSnapshot + plannedMaterialization(action) + admissionPlan
   where admissionPlan.nextContext.attempt.assistantSequence
         = source attempt.assistantSequence + 1
   and admissionPlan.expectedChainHeadAssistantID = sourceAssistantID

localReplaySafe
:= dispatch.replayFence.localTools.type in {
     none-offered,
     durable-before-execute
   }

safeRetryProviderSafe
:= (
     dispatch.replayFence.provider.type = no-provider-side-effects-offered
     and plannedMaterialization.authorization.providerProof.type = none-needed
   )
   or (
     dispatch.replayFence.provider.type = provider-idempotency-protected
     and plannedMaterialization.authorization.providerProof.type = idempotency
     and canonical domain + sealed key ref/digest/keyVersion equality 成立
     and gated unseal 后 raw key digest 重新匹配
     and planned target belongsTo proof domain
   )

continuationPrefixConsistent
:= durableSnapshot.providerContinuation is present
   and frozenRecoverySourceVersion.providerPrefixVersion is present
   and planned authorization.providerProof.type = continuation
   and planned authorization.providerProof.providerPrefixVersion is present
   and three prefix checkpoints canonical equal
   and prefix ancestry/hash/source assistant checks 成立

continueProviderSafe
:= (
     dispatch.replayFence.provider.type = no-provider-side-effects-offered
     and planned authorization.providerProof.type = none-needed
   )
   or (
     dispatch.replayFence.provider.type = provider-continuation-capable
     and continuationPrefixConsistent
     and sealed cursor ref/digest/keyVersion、unsealed digest、domain/target membership 全部匹配
   )

hasUnsafeTool
:= exists tool where
     executionKind = unknown
     or inputState in { open, unknown }
     or callState != durable
     or state in { pending, running }
     or interruption is defined

allToolsSettled
:= tool count > 0
   and not hasUnsafeTool
   and every tool.executionKind in { local, provider }
   and every tool.inputState = complete
   and every tool.callState = durable
   and every tool.state in { completed, error }

SafeRetry
:= sourceConsistent
   and originalDispatchAvailable
   and recoveryOriginConsistent
   and planAvailableFor(safe-retry)
   and admissionPlan.recoveryBudgetAvailable
   and admissionPlan.maxStepAvailable
   and localReplaySafe
   and safeRetryProviderSafe
   and planned semanticReplayDigest = source dispatch.semanticReplayDigest
   and planned continuationClosure.type = not-needed
   and tool count = 0

ContinueAfterSettledTools
:= sourceConsistent
   and originalDispatchAvailable
   and recoveryOriginConsistent
   and planAvailableFor(continue-after-settled-tools)
   and admissionPlan.recoveryBudgetAvailable
   and admissionPlan.maxStepAvailable
   and localReplaySafe
   and continueProviderSafe
   and allToolsSettled
   and planned continuationClosure.type = constructible
   and closure target/digest 与 binding 一致

ManualStop
:= otherwise
```

关键 fail-closed 规则：

- valid explicit opaque source dispatch 是合法 durable fact，但 incomplete 后固定 `provider-introspection-unavailable`；
- ledger 多条、数量未知、identity mismatch、origin/consumed decision mismatch、digest/fence/capability 内部矛盾都映射 `dispatch-evidence-inconsistent` 或 `dispatch-ambiguous`；
- Continue 在做 prefix equality/ancestry 前必须先验证三处 prefix **都存在**。只要 durable source、durable continuation 或 planned proof 任一缺失/额外，即 `provider-continuation-unavailable` 或 `recovery-binding-stale`，不能用 optional equality 意外通过；
- planned materialization unavailable 按其 phase-tagged typed cause 形成 ManualStop proposal，不构造虚假 binding；只有 transition commit 后才是 durable ManualStop record；
- partial text/reasoning 本身不是 tool side effect，但 SafeRetry 仍需 provider 与 local-tool 两个 fence 同时安全；
- explicit tool error 可以是 settled，仍必须同时满足 local fence、provider safety 和 provider-valid closure；
- cleanup 产生的 interrupted/error、open input、call 未 durable、unknown execution kind、`pending/running` 均 ManualStop；
- classifier proposal 通过后也不能发送。activation transaction 必须重查 admission、持久化 authoritative decision、三 heads CAS并原子创建 exact child/ledger/consumption，返回 matching receipt 后才 authorize/release handle。

`MANUAL_STOP_REASON_ORDER` 必须先定义为唯一 const tuple，`ManualStopReason` 由该 tuple 派生；不能让 TypeScript union 的书写顺序成为第二顺序。原因评估按 causal gates 执行：先验证 source envelope/identity/ledger，结构失败时抑制所有需要 available dispatch 的 proof/tool/closure predicates；再处理 opaque evidence 的显式 reason table；planned unavailable 时只映射 typed unavailable cause，并抑制 target/proof/handle predicates；最后才评估彼此独立的 semantic safety 与 admission。由可评估 predicates/typed causes 得到的集合再按唯一顺序排序、去重且非空。schema discriminator、opaque/cause-to-reason total mapping 与顺序常量必须有 exhaustive test；若未映射则追加 `internal-classification-failure` 并 fail closed。`detail` 只用于诊断，不参与稳定 reason。

typed unavailable mapping 必须 exhaustive，不能再全部归入 `planned-target-unavailable`：

```text
planning/planned-target-unavailable                 → planned-target-unavailable
planning/planned-authority-unavailable              → planned-authority-unavailable
planning/planned-request-materialization-failed     → planned-request-materialization-failed
planning/planned-request-digest-failed              → planned-request-digest-failed
planning/planned-runtime-proof-unavailable          → planned-runtime-proof-unavailable
planning/provider-proof-unavailable                 → provider-proof-unavailable
planning/dispatch-lowering-unverifiable             → dispatch-lowering-unverifiable
continuation-closure/*                               → continuation-context-unavailable
# closure cause 仍作为 typed internal diagnostic；不得靠 free-form detail 断言
# recovery-action-inapplicable 由 action 与 tool/closure shape 不相容的 classifier predicate 产生
```

统一 reason 顺序为：

```text
dispatch-evidence-inconsistent
→ dispatch-ambiguous
→ provider-introspection-unavailable
→ planned-target-unavailable
→ planned-authority-unavailable
→ planned-request-materialization-failed
→ planned-request-digest-failed
→ planned-runtime-proof-unavailable
→ provider-replay-unknown
→ provider-continuation-unavailable
→ provider-proof-unavailable
→ recovery-action-inapplicable
→ local-tool-replay-unknown
→ open-tool-input
→ unsettled-tool
→ interrupted-tool
→ uncertain-tool-result
→ dispatch-lowering-unverifiable
→ continuation-context-unavailable
→ recovery-binding-stale
→ recovery-budget-exhausted
→ same-process-max-step-exhausted
→ superseded-by-new-user-input
→ internal-classification-failure
```

classifier 不负责把低层 exception 猜成任意 reason；runtime adapter 必须返回 typed unavailable cause。`planned-runtime-proof-unavailable` 表示 runtime adapter 根本无法建立 paused authorization contract；`dispatch-lowering-unverifiable` 表示 adapter 声称可 preparation，但该次 exact lowerer/transport mutation 无法与 captured representation 建立等价。二者不可互换。ManualStop decision 不构造假 target、proof 或 binding。

### 4.6 新 attempt 与恢复顺序

#### Legacy

§4.4.4 已定义 authoritative prepare/authorize/release/cancel 顺序；这里补充 Session 层语义：

1. 若请求提供 AI SDK 本地工具，新增 processor/tool handshake 必须在 `item.execute()` 前提交 complete input、durable call/running tool part；handshake 失败则不执行工具；
2. adapter 或 `settleIncomplete()` 产生 typed incomplete signal，`SessionProcessor` 保留 classification，不在 `provider-error` 分支丢成普通 `Error`；
3. processor 等待已登记工具并完成 executionKind、input/call phase、part/reasoning provenance 持久化；
4. Prompt 持久化 terminal fact 后 reload `DurableRecoverySnapshot`，再由 runtime adapter prepare 当前候选 action 的 paused request；durable snapshot 与 planned materialization 不得混合；
5. pure classifier 结合 typed admission plan 生成 `RecoveryDecisionProposal`；ManualStop 只有 commit 为 finalized record 后才作为 durable finalization，handle 随后 cancel并保持现有 break；
6. automatic proposal 的 activation transaction 重查 budget/max-step/policy、清空 attempt-local state 的 ownership计划、reload source/control tail并验证 exact binding；
7. 只有三 heads CAS + committed decision consumption + exact unique child/ordinal-0 ledger transaction 成功并返回 receipt 后，same handle 才能 authorize/release child stream；CAS、persistence、stale binding 或 ownership failure 全部 cancel，provider recovery hits 为 0；
8. re-entry 按互斥 durable state matrix 处理：仅同一进程且 runner ownership/fiber 仍明确存活时可 attach/await 匹配 nonterminal child；跨进程或 ownership 已丢失时，child/evidence 存在但无 terminal settlement一律 `dispatch-ambiguous`；matching terminal child 只观察/分类；active decision 无 child 时才可 CAS 消费一次；冲突 link、重复 ordinal 或 decision/source-version mismatch 均 fail closed；
9. incomplete-triggered recovery 不直接重跑旧 processor；canonical incomplete 继续不进入 `SessionRetry.policy()`。普通 retryable error 的 outer policy 若已产生第二 semantic dispatch，则 source ledger 多条使后续 incomplete fail closed；若实现选择首次 dispatch 后禁用 outer resend，则 policy 在该边界停止。新用户输入 supersede active recovery 的具体 transition/CAS 规则见后续 identity/sequence 段。

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
4. provider-executed tool representation 必须遵循实际 Legacy dispatch 的运行时证明边界：Anthropic Messages 可在 assistant sequence 内 inline lower其明确支持的 server-tool call/result；OpenAI Responses serializer 会跳过 provider-executed call，但 Legacy continuation 只有在 effective `store === true`、durable hosted-tool item reference 经 `ProviderTransform.message()` 后仍存在、且实际 dispatch 复用 audited lowerer或通过 exact per-request pre-release capture/authorization 时，才能用 `item_reference`；否则不得把 hosted item ID 或 dropped call/result 当作完整 replay；本地 tool result 仍保持实际发送路径要求的 tool message 表示；
5. 只在 continuation model 与历史模型兼容时复用 provider-native metadata。

明确排除：

- 未结束、step-boundary-flushed 或 cleanup-flushed 的 reasoning；
- 缺少 provider-end provenance/最终协议元数据的 reasoning；
- incomplete trailing text/prose；
- 未结束 tool input；
- pending/running/interrupted/uncertain tool；
- 与 tool 续传无关的旧 partial text。

这不是“保留全部 errored assistant”，也不是“无条件删除全部 reasoning”。本次只在 Legacy reasoning part 中新增 natural provider end 与 forced-flush 的 durable provenance；lowering 再按内容顺序和 provider 协议计算最小闭包。

闭包可构造性必须在分类前验证，而不是在决定 Continue 后再尝试。`packages/llm` 的 Anthropic serializer 会把 reasoning signature 与支持的 server-tool call/result 置于同一 assistant sequence：`packages/llm/src/protocols/anthropic-messages.ts:442-469`；这只能作为 validator/lowerer 的结构参考，除非实际 Legacy dispatch 复用同一 no-send lowerer，或 transport 对该次 exact final request 实施 pre-release capture/authorization。OpenAI Responses serializer 对 reasoning 的行为依 storage mode 分叉：storage enabled 时使用 `item_reference`，`store:false` 时只 replay 带完整 encrypted state 的 reasoning item：`packages/llm/src/protocols/openai-responses.ts:385-407`、`446-453`；对 hosted tool，它跳过 provider-executed call，且仅在 `store !== false` 且有 item ID 时输出 result reference：`packages/llm/src/protocols/openai-responses.ts:410-422`。但 Legacy preprocessing 在 effective `store !== true` 时删除 Responses item ID：`packages/opencode/src/provider/transform.ts:500-513`，且常见 OpenAI-family provider 默认 `store:false`：`packages/opencode/src/provider/transform.ts:1162-1175`。所以本次 Legacy classifier 必须按 storage mode 与 item kind 分支，而不是把 `store === true` 扩大成所有 OpenAI Responses continuation 的前提：

- **hosted/provider-executed item**：effective normalized `store === true` 时可使用最终 transform 保留的 durable item reference。effective normalized `store === false` 时采用初始 fail-closed allowlist：只有 actual audited Legacy lowerer 对**该 exact hosted item kind**提供完整 typed stateless representation 并通过 pre-release authorization 才可 continuation；首批实现可以 allowlist 为空。已知但首批未支持的 kind 使用 `continuation-item-kind-unsupported`，不是笼统声称 provider protocol 永远 `storage-mode-not-replayable`；缺所需 reference 则 `hosted-item-reference-missing`；
- **stored reasoning item reference**：effective normalized `store === true` 时，先要求 `providerMetadata.openai` namespace 是可解码 record；namespace 缺失只产生 `reasoning-provider-metadata-missing`。namespace 存在但 `itemId` 缺失/空/无效时只产生 `reasoning-item-reference-missing`，两 cause 互斥；
- **stateless encrypted reasoning**：只在 effective normalized `store === false` 分支讨论；encrypted state 属于 reasoning，不属于本地 tool call/result。当前 shared lowerer `lowerReasoning()` 仍要求 `itemId`，而 Legacy transform 在 `store !== true` 时删除 item ID，因此首批必须 either 修改 shared lowerer/types 使完整 encrypted reasoning 可在无 persisted item ID 时形成 exact wire representation并补 integration test，or 将该分支标记 unavailable。修改后仍需 provider-end provenance、model compatibility 与运行时 proof。本地 tool call/result 继续使用普通 tool messages，不从 encrypted reasoning 推导。`store` 未归一化为明确 `false` 时不得自行当作 stateless 分支。

golden/recorded fixtures 只做回归或 provider 接受性样例，不替代 per-request proof。

#### Experimental native LLM transport 的范围

`OPENCODE_EXPERIMENTAL_NATIVE_LLM=true` 是 Legacy Session 的 alternate LLM transport，不是 Native V2 Session runner。它仍可能被 Legacy Prompt/Processor 选择，但不属于本轮 50 项 current-evidence set，也不在本修复首批 automatic recovery enablement 范围内。

初始实现规则固定为：

- 默认 AI SDK Legacy transport 按本文 paused-request authorization contract实施；
- experimental native Legacy transport 在实现同一 exact evidence-before-send mechanical gate 前，不得在 covered execution 中 ungated 发送；必须 fallback 到 gated transport 或禁用。实现 gate 但 semantic introspection 仍 opaque 时，可写 opaque evidence并保持 initial request 可用；
- 该 transport 发生 incomplete 时固定 ManualStop，不能因为它名称含 “native” 而套用 Native V2 non-goal，也不能在缺少 runtime proof 时声称 parity；
- `packages/opencode/test/session/llm-native.test.ts` 的未来相关用例首先是 fail-closed compatibility test；若后续要为该 transport启用 automatic recovery，必须另行扩展 scope并补相同 release/cancel/provider-hit integration。

### 4.8 StructuredOutput 与其他 attempt-local 状态

每个新 recovery attempt 前必须重置：

- `structured`；
- 当前 attempt 的临时 output accumulator；
- processor-local provider evidence；
- 未完成 fragment buffers；
- 与上一 assistant ID 绑定的 toolcall map。

建议将 `structured` 移入 while-loop 内部的 attempt scope，而不是依赖分支手工清空。

### 4.9 identity、admission、supersession 与 crash 边界

#### 4.9.1 三类连续序列

- `dispatchOrdinal`：每个 assistant 内从 0 开始，每次 semantic dispatch 必须是唯一 immediate successor；`(sessionID, assistantID, dispatchOrdinal)` 唯一，由 `dispatch_ledger_head(sessionID, assistantID)` CAS 当前 tail。重复、缺口或未知 count 均 fail closed；automatic recovery 要求 source ledger 只有 ordinal 0；
- `assistantSequence`：每个 chain 从 0 开始，所有 initial/recovery/ordinary-continuation assistant 都占一个连续序号；`(sessionID, chainID, assistantSequence)` 唯一。candidate admission 必须满足 `candidateAssistantSequence = source.assistantSequence + 1`，并由 `assistant_chain_head(sessionID, chainID)` CAS 验证 source 仍是 current chain head；
- `recoveryOrdinal`：只统计 incomplete-triggered child。initial/new-user lineage 为 0；recovery child 为 `source + 1`；ordinary continuation 保持 source ordinal。`(sessionID, chainID, recoveryOrdinal)` 只约束 incomplete-child relation，不能阻止同 ordinal 下后续 ordinary continuation。

#### 4.9.2 hard max-step admission

- 当前 Legacy **没有 hard max-step admission guard**：它只递增内存 `step`、计算 `isLastStep` 并注入 `MAX_STEPS_PROMPT`，仍会创建 assistant 和调用 provider（`packages/opencode/src/session/prompt.ts:1141-1142`、`1187-1210`、`1281-1295`）。因此必须新增显式 admission predicate；
- max-step 统一按 admitted assistant attempt 定义，不使用 `completedSteps`：initial assistant 的 `assistantSequence=0`。规范化后 `maxSteps=M` 时，合法 sequence 为 `0 .. M-1`，candidate 仅在 `candidateAssistantSequence < M` 时 admission；因此 `M=1` 只允许 initial assistant，`M=2` 最多允许一个 successor；
- ordinary continuation 与 incomplete recovery 消费同一 assistant admission budget。`MAX_STEPS_PROMPT` 只能附加到最后一个已获准 assistant，不能借提示再超额创建 attempt；
- 0、负数、非整数、Infinity/缺失配置如何规范化必须在 detailed design 固定并测试；无论规范化策略为何，都不能绕过 `candidateAssistantSequence < M` 的 admission rule；
- automatic 顺序固定为：`typed admission plan + classifier proposal → activation transaction 重查 budget/max-step/policy → decision revision + recovery/chain/ledger heads CAS → exact bound child/consumption commit → receipt-authorized network release`；
- max-step exhausted 时不创建 child、不 release provider，并以同一 decision series 的新 revision supersede旧 automatic proposal/active revision，直接 finalized `ManualStop(["same-process-max-step-exhausted"])`。finalization 写入失败时只能保证当前进程 cancel/fail closed，不能声称 durable stop 已成功；
- 本修复不声称现有 max-step 已跨 crash 持久化；durable recovery ordinal 也不等价于完整 agent step 或 physical-request budget。

#### 4.9.3 参数化 recovery budget

- recovery limit 使用产品参数 `N`，而不是在 proof 中写死 2；candidate recovery 满足 `candidateRecoveryOrdinal = source.recoveryOrdinal + 1`，且仅当 `candidateRecoveryOrdinal <= N` 才 admission；
- `N=0` 禁止 automatic recovery，`N=1` 最多一个 recovery child，`N=2` 最多两个。本文只建议 `N=2` 作为可能默认，需另行确认；
- ordinal exhausted append ManualStop `recovery-budget-exhausted`。budget 与 max-step 是独立 predicates，任一不满足都必须 cancel paused request 且 provider hits 为 0。

#### 4.9.4 Decision revision 与 new-user supersession

- first decision revision 为 0；同一 source version 的 reclassification 必须 append `decisionRevision + 1`，不能覆盖旧 row；
- 同一 `(sessionID, sourceAssistantID, sourceVersionDigest)` 最多一个 active revision。创建新 revision 的 transition必须把旧 revision从 active 变为 superseded/finalized；consume 与 supersede 都以同一 `recovery_head` predecessor CAS 竞争；
- admission 新 user lineage 前，任何 unresolved incomplete source（包括 terminal 已 durable 但 crash 后尚无 decision，或 active unconsumed decision）都必须先通过 `recovery_head` CAS 形成/append finalized `ManualStop(["superseded-by-new-user-input"])`；若已有 automatic revision，则新 ManualStop revision supersede旧 revision。该 transition commit 后才创建新 chain `{ recoveryOrdinal: 0, assistantSequence: 0 }`；
- 若 recovery child consumption 已先赢得 CAS，新 user input 不得回写或“取消”已 consumed decision，而是遵循现有 steering/queue semantics；
- supersession persistence/CAS 失败时 fail closed：不 release recovery handle，也不在未记录 supersession 的情况下 admission 新 lineage。

#### 4.9.5 Crash boundary

- child dispatch evidence 已持久化但没有 terminal settlement 时，只有同一进程且原 runner ownership 仍活跃可 attach/await；进程重启或 ownership 丢失后属于 ambiguous dispatch，必须关联到唯一 child 并 ManualStop，不能重新消费 decision、再次 release 或创建相同 ordinal/sequence；
- replay 必须验证 revision transition chain、assistant immediate-successor chain 和 dispatch ledger 均无分叉/缺口；不能从 public projection 选择一个分支修复。

---

## 5. 正确性论证

本节是**方案实现并通过 §6 验收后**应成立的 proof obligations，不描述当前生产代码已经提供的保证。当前已验证基线见文档顶部证据表与 §1.2。

### 5.1 实施后不会把 incomplete attempt 伪装成成功

- 每次 incomplete attempt 都保留 typed terminal failure；
- recovery 成功会产生新的 assistant attempt；
- 旧 attempt 的错误不会被清除或改写成 success；
- 本次 Legacy 的 adapter canonical incomplete 与 processor clean EOF 都进入同一 typed failure；

### 5.2 实施后不会重放已执行的本地工具

- Legacy AI SDK 必须通过新增 handshake 建立 complete-call durable-before-execute 契约，否则 local-tool fence 为 unknown；
- SafeRetry 要求没有 tool evidence，且实际请求的 provider/local-tool replay fence 均安全；
- Continue 只把 settled call/result 作为历史上下文，不重新放入可执行队列，同时仍要求整个 attempt replay fence 安全；
- pending/running/interrupted 状态直接 ManualStop。

### 5.3 实施后不会从“缺少事件”推导副作用安全

- 自动 action 依赖 original request 在 network release 前持久化的 `AttemptReplayFence`，以及本次 candidate request 经 `preparePausedRequest()` 得到的 exact no-send materialization；
- observed `providerExecuted=false/undefined` 或缺少 Legacy tool part 都不是充分条件；缺失字段必须投影为 `executionKind: "unknown"`，不能补成 local；
- provider/local-tool 任一 fence unknown 时 ManualStop；
- provider 幂等/续传 fence 只在 planned target 的 provider/route/protocol/endpoint/authority 及可选 model/model-family 全部匹配其 safety domain 时有效；
- 因此断流丢失 hosted-tool 事件、跨 provider/model domain 重试或 Legacy AI SDK 在 event 前执行本地工具，都不会被误判为安全。

### 5.4 实施后不会依赖未提交内存状态

- classifier 只接受 `DurableRecoverySnapshot` 与独立的 `PlannedRecoveryMaterialization`；projection/relational/event checkpoint 必须 transaction-consistent，planned values 不得倒灌为 source facts；
- 原 attempt 的 replay fence 来自 release 前持久化事实，不从当前配置重算；
- 本次 Legacy classifier 在分类前 reload message/part/ledger/decision durable state；
- classifier proposal 绑定 exact `nextContext`、target/authority、semantic/prepared digest、冻结 source/control versions、N/M admission policy、closure 与唯一 authorization；activation transaction 生成 committed `RecoveryDecisionRecord`。pre-commit stale request 必须 cancel 并用新 revision重新 planning，不能在 release 前悄悄 re-prepare 后复用旧 decision；SafeRetry 另要求 source/planned semantic digest 相等；
- public `incompleteRecovery`/minimal `dispatchSummary` 只保存稳定 display summary，不保存 proof、cursor、request material、digests、decision link 或 CAS predecessor，也不参与 authorization；
- recovery child dispatch evidence 只反向引用 sourceAssistantID/decisionID/decisionRevision/bindingDigest 和 authorization commitment；完整 provider proof 只存在 consumed internal decision binding，不复制为第二 authority；
- 任一 classification、publication、CAS 或 persistence failure 都 cancel staged handle，保证当前 recovery path 不触发 provider release。

需要明确限制：如果存储不可用，系统无法保证把 ManualStop 本身写入 durable history；能保证的是当前进程 fail closed。本文不作逻辑上无法兑现的“持久化失败也一定能持久化错误”承诺。

### 5.5 实施后不会把 interrupted error 当作 settled error

- schema 持久化 interruption/uncertainty 来源；
- classifier 对任何带该来源的 tool 强制 ManualStop；
- Legacy 当前 attempt cleanup 必须保留 interruption provenance。

### 5.6 实施后恢复次数有界且 assistant admission 无分叉

- chainID 将同一逻辑链关联起来；assistantSequence、recoveryOrdinal、decision revision 与 dispatchOrdinal 各有独立连续性/唯一性约束；
- initial assistant 的 `assistantSequence=0`、`recoveryOrdinal=0`、首个 `dispatchOrdinal=0`；每个 successor assistantSequence 精确加 1，recovery child 的 recoveryOrdinal 加 1，ordinary continuation 保持 recoveryOrdinal；
- 参数 `N` 约束 `candidateRecoveryOrdinal <= N`；`N=0/1/2` 分别允许 0/1/2 个 recovery child，`N=2` 不是本文已确认默认；
- `maxSteps=M` 约束 `candidateAssistantSequence < M`；ordinary continuation 与 recovery child 共用该 admission budget；
- ordinal/max-step exhausted 分别 append `recovery-budget-exhausted` / `same-process-max-step-exhausted` 并 cancel paused request；
- `assistant_chain_head` CAS、assistantSequence 唯一键、`recovery_head` decision consumption 与 child binding 保证同一 source 不会并发创建两个 immediate successors；
- Legacy 测试记录 assistant IDs、ledger entries 与 provider hits，以发现意外 replay；本修复不新增独立 physical-request budget。

### 5.7 实施后模型上下文既不污染，也不破坏 provider 工具协议

- SafeRetry 不注入失败 attempt；
- Continue 只有在 provider-specific continuation closure 已验证可构造时才成立；
- Continue 排除 partial prose/reasoning；
- 仅保留 settled tool continuation 所需且具有 durable provider-end provenance 与最终协议元数据的 provider-native reasoning；
- 模型不兼容时不复用 provider-native metadata；OpenAI Responses 在 normalized `store === true` 时可使用最终保留且已授权的 hosted/stored references；normalized `store === false` 时只允许 exact hosted-item-kind 已由 actual Legacy lowerer证明完整 typed stateless representation 的 allowlisted 分支，首批可全部 fail closed。stateless encrypted reasoning 还要求先修改/证明当前 lowerer 可在无 persisted item ID 时形成 exact wire representation。

### 5.8 实施后 StructuredOutput 不跨 attempt 泄漏

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


---

## 6. 测试方案

### 6.0 本轮已执行的当前态基线

本轮使用 PATH 中的 Bun 1.3.14，在 branch `yixiao-issue-7-new`、HEAD `0ea5c2959` 上重新实际执行并通过 46 个 Bun tests 与 4 个精确单选的范围内 Legacy HttpApi exerciser scenarios，共 50 个范围内检查：50 pass，0 fail，0 skip。另一次 selector 过宽的辅助 exerciser 运行执行了 37 个 scenarios 且全部通过，但不计入该 50 项验收。详细测试名、等级和证据边界见文档顶部证据表。核心当前态结论是：Legacy incomplete fail-stop、partial/error preservation、普通 tool continuation、child failure propagation 与 outer retry provider hit 已有运行时证据；automatic recovery 尚未实现，不能从这些基线测试外推。

正式运行命令如下；所有命令都从具体 package 执行，未运行仓库根测试：

```bash
# A：10 个真实 CLI subprocess tests
(cd packages/opencode && bun test ./test/cli/run/run-process.test.ts \
  --test-name-pattern 'exits 0 and writes the response to stdout on a successful prompt|missing terminal finish preserves partial text and exits nonzero|missing terminal finish persists reasoning and an assistant error|--format json records partial output before a missing terminal error|exits nonzero without compaction when a high-usage stream misses its terminal finish|prints each completed text part in order around a tool continuation|--format json preserves reasoning, tool, and continuation ordering|persists a child length error and reports the parent task as failed without replay|persists a child missing-finish error and lets the parent recover without replay|propagates a child compaction crossover after one completed tool without replay')

# C：7 个 SessionPrompt + AI SDK + TCP tests
(cd packages/opencode && bun test ./test/session/prompt.test.ts \
  --test-name-pattern 'loop preserves reasoning-only output and stops on a missing terminal finish|loop preserves partial text and stops on a missing terminal finish|loop persists a high-usage missing finish without compaction or replay|high-usage missing finish prevents StructuredOutput promotion and compaction|high-usage missing finish does not replay a completed tool or start compaction|loop does not replay a completed tool after a later missing terminal finish|a missing terminal finish wins over a successful StructuredOutput tool result')

# C/D：5 个 SessionProcessor tests（2 个 injected synthetic settlement tests 为 D；1 个 TCP missing-finish/compaction 与 2 个 TCP 429/503 retry tests 为 C）
(cd packages/opencode && bun test ./test/session/processor-effect.test.ts \
  --test-name-pattern 'session.processor rejects every stream without a credible final step settlement|session.processor gives no-step settlement priority over an earlier empty unknown|session.processor preserves a missing-finish error when usage requests compaction|session.processor effect tests retry recognized structured json errors|session.processor effect tests publish retry status updates')

# D：1 个 canonical incomplete retry-policy unit
(cd packages/opencode && bun test ./test/session/retry.test.ts \
  --test-name-pattern 'does not retry the canonical incomplete-stream unknown error')

# B：1 个 live listener/generated SDK test
(cd packages/opencode && bun test ./test/server/httpapi-sdk.test.ts \
  --test-name-pattern 'matches generated SDK prompt streaming through fake LLM')

# D：22 个 synthetic TUI tests，另有 8 snapshots
(cd packages/tui && bun test \
  ./test/cli/cmd/tui/sync-live-hydration.test.tsx \
  ./test/cli/tui/inline-tool-wrap-snapshot.test.tsx)

# D：四次精确单选 Legacy route scenario；每次输出 selected=1
(cd packages/opencode && bun ./script/httpapi-exercise.ts --mode effect \
  --include session.prompt --start-at '/session/{sessionID}/message' \
  --stop-at '/session/{sessionID}/message' --fail-on-missing --fail-on-skip --progress)
(cd packages/opencode && bun ./script/httpapi-exercise.ts --mode effect \
  --include session.prompt_async --fail-on-missing --fail-on-skip --progress)
(cd packages/opencode && bun ./script/httpapi-exercise.ts --mode effect \
  --include session.command --fail-on-missing --fail-on-skip --progress)
(cd packages/opencode && bun ./script/httpapi-exercise.ts --mode effect \
  --include session.shell --fail-on-missing --fail-on-skip --progress)
```

TUI 当前只有 synthetic data/sync/render 基线。真实 Legacy transcript 端测与 synthetic renderer 测试组合可作为两层 contract acceptance 的准备，但不是 keyboard → production Prompt → Legacy endpoint → provider incomplete → real events → Session renderer 的完整 TUI E2E。

以下 §6.1–§6.4 均为**实现后必须新增或扩展的 recovery 验收项**；§6.5 仅列建议验证命令。当前不存在的测试文件不得写成已执行。

### 6.1 Pure classifier 与 runtime gate 测试

测试必须按 action/ownership 分组，不能再用一列含义不明的 `safe` 同时代表 provider replay、local-tool replay、continuation proof 和 runtime lowering。

#### 6.1.1 SafeRetry classifier matrix

| Source provider fence | Source local fence | Tool count | Planned action/proof | Semantic digest | Budget/admission | 预期 |
|---|---|---:|---|---|---|---|
| no-side-effects | none-offered | 0 | safe-retry / none-needed | equal | available | SafeRetry |
| idempotency(domain,key) | none-offered | 0 | matching idempotency | equal | available | SafeRetry |
| unknown | none-offered | 0 | none-needed（downstream proof predicates suppressed） | equal | available | ManualStop(`provider-replay-unknown`) |
| no-side-effects | unknown | 0 | none-needed | equal | available | ManualStop(`local-tool-replay-unknown`) |
| idempotency fence 本身 domain/key 自相矛盾 | none-offered | 0 | matching plan | equal | available | ManualStop(`dispatch-evidence-inconsistent`) |
| valid idempotency | none-offered | 0 | planning 无法取得 matching proof | equal | available | ManualStop(`provider-proof-unavailable`) |
| valid fence | none-offered | 0 | adapter 无 mechanical paused contract | equal | available | ManualStop(`planned-runtime-proof-unavailable`) |
| valid fence | none-offered | 0 | exact lowerer/capture 与 planned representation 不一致 | equal | available | ManualStop(`dispatch-lowering-unverifiable`) |
| no-side-effects or matching idempotency | none-offered or durable-before-execute | 0 | post-proposal/pre-CAS request/policy mutation | equal/changed | available | ManualStop(`recovery-binding-stale`) |
| no-side-effects or matching idempotency | none-offered or durable-before-execute | >0 | safe-retry / matching proof | equal | available | ManualStop(`recovery-action-inapplicable`) |
| no-side-effects or matching idempotency | none-offered or durable-before-execute | 0 | safe-retry / matching proof | equal | `N`/`M` exhausted | exact budget/max-step reason |

每行必须明确 source fence、planned proof kind、mutation phase、expected exact ordered reasons，不用 `safe` shorthand。

#### 6.1.2 ContinueAfterSettledTools classifier matrix

| Tool evidence | Local fence | Provider fence | Planned continuation proof/prefix | Closure | 预期 |
|---|---|---|---|---|---|
| completed/error, all durable | durable-before-execute | no-side-effects | none-needed; no continuation prefix | constructible | Continue |
| completed/error, all durable | durable-before-execute | continuation-capable | matching cursor/domain；三处 prefix present/equal/ancestor | constructible | Continue |
| completed/error | unknown | no-side-effects | none-needed（closure/proof predicates suppressed after local failure） | constructible | ManualStop(`local-tool-replay-unknown`) |
| pending/running | durable-before-execute | no-side-effects | none-needed（closure predicates suppressed） | unavailable | exact `unsettled-tool` |
| interrupted | durable-before-execute | no-side-effects | none-needed（closure predicates suppressed） | unavailable | `interrupted-tool` |
| provider-result-missing/unknown execution | durable-before-execute | no-side-effects | none-needed（closure predicates suppressed） | unavailable | `uncertain-tool-result` |
| settled | durable-before-execute | continuation-capable | source prefix missing | constructible | `provider-continuation-unavailable` |
| settled | durable-before-execute | continuation-capable | planning 时 prefix/cursor proof missing | constructible | `provider-proof-unavailable` |
| settled | durable-before-execute | continuation-capable | post-proposal/pre-CAS prefix/target mutation | constructible | `recovery-binding-stale` |
| settled | durable-before-execute | matching provider proof | typed closure cause: protocol/reasoning/model/item-kind unavailable | unavailable | `continuation-context-unavailable` + exact internal closure cause |
| settled | durable-before-execute | matching proof | adapter 无 mechanical paused contract | unavailable | `planned-runtime-proof-unavailable` |
| settled | durable-before-execute | matching proof | exact lowerer/capture 不可验证 | unavailable | `dispatch-lowering-unverifiable` |

#### 6.1.3 ManualStop/source-consistency matrix

覆盖：

- non-durable source marker、empty ledger、多 dispatch ledger、ordinal duplicate/gap；
- sourceAssistantID 与 terminal/dispatch/source-version/decision 任一 identity mismatch；
- explicit opaque source dispatch；
- replay fence/capability/target/domain 内部矛盾；
- child origin link 与 consumed decision ID/revision/binding/action 不匹配；
- old tool rows 缺 execution/provider phase 字段时投影为 unknown，不补成 false/local；
- each phase-tagged `PlannedRecoveryUnavailable` 的 exhaustive mapping：planning cause 一对一 reason；continuation closure subcause 保持 typed diagnostic并稳定映射 `continuation-context-unavailable`；
- single/multiple failures 的 exact global ordering、dedup、non-empty fallback；
- input/tool/ledger object order permutation 不改变结果。

#### 6.1.4 Decision revision/CAS/supersession matrix

覆盖：

- first revision 0，reclassification append revision + 1；
- 同 source version 最多一个 active revision；
- consume、supersede、new revision 三方 predecessor CAS race 只有一个成功；
- `superseded-by-new-user-input` transition commit 后才能 admission 新 chain；
- child consumption 先赢时 new user input 走 steering/queue，不覆盖 consumed decision；
- `N=0/1/2` 与 `M=1/2` 的 ordinal/assistantSequence exact admission；
- dispatchOrdinal 对每个 assistant、assistantSequence 对每个 chain 的 duplicate/gap/replay branch 全部 fail closed；recoveryOrdinal 的唯一/连续检查只针对 incomplete-child relation，ordinary continuation 保持相同 recoveryOrdinal 是合法的。

#### 6.1.5 Runtime adapter/transport gate integration

这些不是 pure classifier tests，ownership 在 `packages/opencode`：

- `preparePausedRequest()` 完成时 provider hits 为 0；
- decision persistence、source reload、binding validation、CAS、child/ledger/consumption commit 的每个 failure injection 均调用 cancel，provider hits 为 0；
- commit 成功后一个 handle 只能 release 一次；double release/cancel-after-release 拒绝；
- process restart 后旧 handle 不可恢复，必须 prepare 新 handle并重新 revalidate/revise；
- authorization 后 middleware/provider/fetch mutation 必须被 exact digest/binding revalidation 捕获并零 release；
- classifier 只接收 typed planned result，不能通过 mock 让它自行证明 target/transport equivalence。

### 6.2 LLM schema / adapter / Legacy protocol-closure 测试

- `ProviderFailureClassification` 编解码 `incomplete-stream`；
- Legacy canonical adapter 发出 classification 且 `retryable: false`；
- 非 canonical `finishReason="other"` 不误判；
- 普通 Transport/InvalidProviderOutput 不按 message string 误判；
- semantic-replay-v1、prepared-request-v1 与 recovery-binding-v1 canonicalizer 的 golden vectors：key insertion order 不影响 digest；tool schema/provider option/lowered history/authority 改变必须改变 semantic 与 prepared digest；fence/proof/closure envelope 改变只要求改变 prepared/binding digest；decisionID/child identity/recovery link 不得改变 semantic digest；secret value 不落盘；
- 默认 Legacy AI SDK 路径的 adapter contract test：证明 validator/digest 与实际 dispatch 复用同一个 no-send final-body lowerer，或 transport 对每次 exact normalized URL/body/tool/options 实施 pre-release capture → durable authorization → network release gate；captured final-request golden fixtures 只做回归，单独通过不能让 adapter available。authorization 后 plugin middleware/provider factory/fetch rewrite 仍能改变 wire semantics 时 adapter 必须降级 opaque，零 automatic dispatch；仅跑 `packages/llm` serializer test 不算 Legacy 证明；
- Anthropic Messages：provider-end reasoning signature + **adapter 明确支持且进入同一 audited lowerer / exact pre-release authorization 的** inline server-tool call/result（共享 serializer 的 result block 目前仅覆盖 web search、code execution、web fetch；`packages/llm/src/protocols/anthropic-messages.ts:290-304`）可形成结构闭包；unsupported server-tool name/result 必须 `protocol-unsupported`，缺 signature、forced-flush provenance、运行时 lowering proof 或 model incompatibility 时 unavailable；若声称 provider 端接受性，还需 recorded replay fixture，但该 fixture 不替代运行时 proof；
- OpenAI Responses normalized `store === true`：分别验证 stored reasoning reference 与 hosted/provider-executed item reference；两者都要求相应 identity/metadata 经最终 `ProviderTransform.message()` 后保留、matching target/authority/model/storage mode，且该次 request 通过 audited lowerer/pre-release authorization。缺 reference 必须 ManualStop；
- OpenAI Responses normalized `store === false`：先验证当前 lowerer 无 persisted item ID 时不能构造 stateless encrypted reasoning 的 negative case；若实现阶段修改 shared lowerer/types，再测试完整 encrypted reasoning + settled **local** tool continuation。encrypted state 只属于 reasoning，本地 tool call/result 仍是普通 tool messages。hosted/provider-executed item 逐 kind 测试：只有 actual audited Legacy lowerer 可完整 typed stateless lower 的 allowlisted kind 才可 Continue；首批 unsupported kind 使用 `continuation-item-kind-unsupported` 并零 release，而不是笼统 `storage-mode-not-replayable`；
- provider-end positive case 与 step-boundary/cleanup negative case分别测试，避免所有 completed reasoning 都被排除或都被接受；
- 以上 protocol closure 测试是当前 Legacy correctness 的依赖，不得推迟。

### 6.3 Legacy 集成回归

入口 applicability 必须先固定，避免“产品范围包含所有入口、测试却只覆盖 prompt”：

| 入口 | 是否可能触发 provider incomplete | recovery 验收要求 |
|---|---|---|
| normal prompt / `opencode run` | 是 | 完整 SafeRetry/Continue/ManualStop CLI + Legacy HTTP 回归 |
| command | command 最终进入 Legacy prompt/model 时是 | 至少一组 command 入口 incomplete recovery E2E，不能只测 handler wiring |
| shell | 否；`SessionPrompt.shell()` 只执行/持久化本地 shell，不调用 provider | incomplete recovery 标 N/A；只验 SDK/route、durable transcript、side effect 一次，以及后续**独立** prompt/command recovery 不重放既有 shell side effect |
| ordinary tool continuation | 是 | 新 assistant identity、closure、工具不重放 |
| child/subtask | 是 | child transcript、父 task error/continuation、recovery budget 与副作用不重放 |
| TUI prompt/command | 与对应 Legacy 入口相同 | production submission route test + backend recovery + sync/render contract；完整 E2E 声称需贯通全部边界 |
| TUI shell | 否 | 只验 production shell SDK call 与 transcript/sync；不计入 provider-incomplete E2E |

在现有 session tests 上补：

1. partial text + safe fence：新 assistant 自动恢复，旧 assistant 保持 error；
2. reasoning-only + safe fence：同上；
3. completed local tool + incomplete：工具只执行一次，新 attempt 收到 tool continuation closure；
4. explicit tool error + incomplete：可 continuation，工具不重放；
5. pending/running/interrupted tool：ManualStop；
6. hosted/provider replay fence unknown：ManualStop；
7. AI SDK 请求提供本地工具但尚未建立 durable-before-execute：即使没有 tool event 也 ManualStop；opaque/dynamic provider 的普通初始请求仍可发送，但 incomplete 后固定 ManualStop，且不会伪造 target/digest；
8. 当前 conversation 配置保持 AI SDK `maxRetries=0`、default `stopWhen=stepCountIs(1)`；外层 `SessionRetry` 触发第二个 `streamText()` invocation 时 durable ledger 变为多 semantic-dispatch，后续 incomplete 必须 `dispatch-ambiguous`/ManualStop。若配置/依赖变化引入 AI SDK 内层 retry或 multi-step而 adapter只证明单次 physical request，semantic-request replay fence 降为 unknown；
9. 新 handshake 在 running tool part commit 成功后才调用 `item.execute()`；commit 失败时副作用执行次数为 0；
10. 连续 incomplete 使用参数化 budget table：`N=0/1/2` 分别断言原始 + 0/1/2 个 recovery attempts，并验证 candidate ordinal 不超过 `N`；
11. 分别记录 assistant attempts 与具体 fixture 的 provider hits，验证没有额外 replay；不声称二者共享同一上限；
12. StructuredOutput 第一次 attempt 产生 partial/旧值、第二次 attempt 未产生值：不得成功；
13. persisted-error 重新进入时按互斥 matrix：active decision revision 无 child/consumption 时才可 CAS 消费；同进程 live runner 可 attach；跨进程 nonterminal child、冲突 link/ordinal/sequence 或 ownership 丢失均 ambiguous 停止；terminal child 只观察/分类；
14. failure 后配置/tool registry 改变时，分类仍使用原 attempt 持久化的 replay fence；
15. generic `SessionRetry.policy()` 仍不处理 canonical incomplete-stream；
16. reasoning 仅被 `step-finish` 或 cleanup 强制写入 `time.end` 时，不得当作 provider-end reasoning 进入 continuation closure；
17. durable terminal fact 已写、final decision 未写时 re-entry 重新分类，不直接 dispatch；
18. 新用户输入 admission 前，若旧 source 有 unresolved incomplete terminal（包括 no-decision crash state 或 active unconsumed decision），先以 `recovery_head` CAS 创建/append finalized `ManualStop(["superseded-by-new-user-input"])`；若已有 automatic revision则 supersede它。若 child consumption 已先获胜则走现有 steering/queue semantics，supersession persistence/CAS 失败时不得 admission 新 lineage；
19. planned target/proof unavailable 时 ManualStop，不伪造 target/binding；recovery attempt 再次 incomplete 时继承 lineage/recoveryOrdinal，不能重置预算；ordinary continuation 只递增 assistantSequence；
20. empty stream、finish-only/no credible settlement、multi-step incomplete 均由 `settleIncomplete()` 持久化 typed `classification: "incomplete-stream"`；safe evidence 进入专用 recovery，unsafe/unavailable evidence 形成 ManualStop，且均不进入 `SessionRetry.policy()`；
21. SafeRetry 中 plugin、tool schema、effective provider option、model parameter、lowered history/body 改变时 semanticReplayDigest 必须变化并拒绝 replay；proof/fence/closure envelope 或 authorization 后 exact request 改变时 preparedRequestDigest/binding 变化并 `recovery-binding-stale`，不 dispatch。若 validator 与 actual dispatch 的运行时 proof 无法建立，则 original 阶段写 opaque、planned continuation 阶段 `dispatch-lowering-unverifiable`；
22. endpoint/account/project/tenant/credential authority 改变时 domain mismatch；即使 providerID/routeID/modelID 相同也不得复用 key/cursor；
23. 旧 tool row 缺 providerExecuted/phase 字段、complete/error row 缺 durable call proof、或 execution kind 冲突时投影为 unknown 并 ManualStop；
24. durable decision 后 crash/re-entry：incomplete-child relation 对 `(sessionID, chainID, recoveryOrdinal)` 唯一，所有 assistant 对 `(sessionID, chainID, assistantSequence)` 唯一，candidate 必须是 source 的 immediate successor；同一 decisionID 只能消费并关联一个 child；child origin link 与 consumed decision binding 必须匹配，actual dispatch 另须满足其 authorization；active decision 无 child 才 CAS 消费；同进程 live runner 可 attach；跨进程/ownership 丢失的 nonterminal child、冲突 link、重复/缺口 ordinal/sequence 为 `dispatch-ambiguous`；matching terminal child 只观察/分类；
25. max-step 按 assistant admission 测试：`M=1` 只允许 sequence 0，`M=2` 只允许 sequence 0/1；ordinary continuation 与 recovery 都要求 `candidateAssistantSequence < M`，耗尽时不创建 child、不 release provider并 durable finalize `same-process-max-step-exhausted`；
26. failure injection 覆盖全部 fail-closed 边界：dispatch evidence commit；durable-before-execute tool call/running-part commit；tool settlement/provenance commit；incomplete terminal fact commit；terminal 后 durable reload；decision revision/ManualStop transition + projection event commit；same-process max-step finalization；active-revision predecessor CAS；atomic child Message/dispatch-evidence/consumption commit；provider release gate。每个注入点分别断言后续 provider 调用数为 0；tool gate 之前的失败还断言本地副作用执行数为 0。对每个 transaction/commit failure，必须新建 storage reader reload并断言 projector row、relational decision/consumption row、child message、dispatch ledger/evidence、event row与唯一键 residue 全部回滚到前态；随后 re-entry 仍不得 dispatch。不能只断言“当前进程 provider calls=0”。ManualStop/terminal 持久化失败时只声称当前进程停止，不伪称 durable finalization 成功；
27. 默认 `experimentalNativeLlm=false` 的 AI SDK Legacy transport 必须有共享 no-send final-body lowerer integration，或 final-transform 后、fetch/`doStream` 前的 exact per-request gate；测试明确证明仅构造 `streamText()`/运行 middleware 后 fake underlying fetch 仍为 0，matching receipt release 后才命中。captured golden fixture 只做回归，不能单独让 adapter available。`experimentalNativeLlm=true` 是 Legacy alternate transport，不是 Native V2；缺 mechanical evidence-before-send gate 时必须 fallback/disable，不能以 opaque evidence 为由 ungated 发送；有 gate但 semantic opaque 时 incomplete 固定 ManualStop；
28. OpenAI-family 覆盖 normalized `store:true` reference 分支与 normalized `store:false` typed-stateless 分支。测试 transform 删除/保留 reasoning item ID、reasoning provider metadata、hosted-tool item reference 与 encrypted state 的组合；`store:true` 只有所需 identity/metadata 最终保留且运行时 lowering 已授权时可 reference Continue；`store:false` 首先验证当前 lowerer 的 item-ID dependency，只有实现无 ID 的 encrypted-reasoning lowering 并通过 exact wire proof 后才允许 settled local-tool continuation。hosted item 逐 kind allowlist，unsupported kind 固定零 release；
29. provider proof/binding mismatch table 独立覆盖 providerID、routeID、protocol、endpointID、authorityID、modelID、modelFamily、proof kind、idempotency key、cursor、proof domain、prefix aggregateID/assistantID/event high-water/hash version/hash digest/append-only ancestry。每个 fixture 必须同时标注 mutation phase，并一次只改变一个维度：original dispatch/fence 内部矛盾 → `dispatch-evidence-inconsistent`；planned proof construction/domain unavailable → `provider-proof-unavailable`；persisted decision 后 revalidation 改变 → `recovery-binding-stale`。三类都断言 exact reason 与 provider 调用数 0；
30. classifier exact-reason suite 覆盖多失败组合、重复 predicate 去重、tool/evidence 输入顺序置换、全局固定顺序、每个 cause/discriminator 的 exhaustive mapping 与 ManualStop 非空保证；
31. TUI acceptance 至少拆成三层并分别命名：(a) `packages/opencode` Legacy integration 通过常规 TUI 使用的 unprefixed prompt/command endpoint 注入 incomplete，证明 recovery child、durable events 与 final idle；(b) `packages/tui/test/cli/cmd/tui/session-recovery-sync.test.tsx` 与 `packages/tui/test/cli/tui/session-recovery-render.test.tsx` 分别使用真实 transcript/event shapes 验证 sync 与 Session renderer；(c) `packages/tui/test/cli/tui/prompt-submit.test.tsx` 挂载 production Prompt component，实际触发 normal prompt/command SDK 调用并断言 unprefixed Legacy route。shell 只测 submission/transcript，不纳入 provider-incomplete E2E。前两层只能称 backend recovery + TUI sync/render contract acceptance；只有 submission、provider/events/renderer 贯通后才称完整 TUI product E2E。ManualStop 对照不创建 child、不隐藏原错误。

继续保留 Issue #3 现有测试，防止 fail-stop 语义回归。

### 6.4 CLI / TUI / child session 回归

扩展 `packages/opencode/test/cli/run/run-process.test.ts`：

- 最终成功只来自 recovery assistant；
- 旧 incomplete assistant 仍可见为 error；
- ManualStop 仍返回非成功状态；
- child/subtask 不因父层 retry 重放已执行工具；
- 达到 recovery 上限后 CLI 不挂起、不循环。

在 `packages/tui/test/cli/cmd/tui/` 按现有 sync/live-hydration harness 新增 recovery acceptance test。当前该文件不存在；本轮通过的 22 个 TUI tests 只覆盖 synthetic sync/render，不能计作以下验收：

- 常规 TUI Legacy prompt 收到原 assistant incomplete error 后，能继续同步并展示 recovery child；
- 原失败 attempt 保留且可见为 error，不被成功 child 覆盖或删除；
- recovery child 的最终内容成为当前成功结果，session busy/idle 与消息顺序正确；
- ManualStop 对照不产生 child，并保留原错误；
- backend transcript + TUI data/sync/render 是两层 contract acceptance，不能只把 `packages/opencode` CLI 集成测试改名当作 TUI 验收；另需 production Prompt component submission route test。若要宣称完整 TUI E2E，还必须把 submission、Legacy endpoint、provider incomplete、real events 与 renderer 串成一条测试链。

### 6.5 建议验证命令与 test ownership

本仓库禁止从根目录运行全量测试。所有命令必须从对应 package 执行。以下分为：

- **现有 regression files**：实现阶段需要扩展并重新运行；
- **`[future/new]`**：当前不存在，必须先由实现阶段创建；
- **package typecheck/test suite**：仅在 targeted tests 通过后运行；
- **codegen/SDK checks**：只在正式实现阶段运行，因为会产生 generated files；本次 document-only 审计不执行。

这些命令全部是 future implementation acceptance，不属于本轮 50 项 current baseline。

```bash
# packages/schema：wire codec、canonical event/field sets、compatibility
(cd packages/schema && bun run typecheck)
(cd packages/schema && bun test \
  test/compatibility.test.ts \
  test/contract-hygiene.test.ts \
  test/session-recovery.test.ts) # [future/new] recovery schemas + canonical set membership/round-trip

# packages/llm：pure canonicalizers 与 protocol closure semantics
(cd packages/llm && bun run typecheck)
(cd packages/llm && bun test \
  test/recovery-canonicalizer.test.ts \
  test/provider-error.test.ts \
  test/provider/anthropic-messages.test.ts \
  test/provider/openai-responses.test.ts)
# recovery-canonicalizer.test.ts = [future/new]

# packages/core：event/source/control canonicalizer、migration、authority、head CAS、replay rebuilder
(cd packages/core && bun run typecheck)
(cd packages/core && bun test \
  test/recovery-event-canonicalizer.test.ts \
  test/database-migration.test.ts \
  test/session-recovery-persistence.test.ts)
# recovery-event-canonicalizer.test.ts / session-recovery-persistence.test.ts = [future/new]
(cd packages/core && bun run migration --check)

# packages/opencode：Legacy classifier/coordinator、runtime proof、history、HTTP actions/continuation
(cd packages/opencode && bun run typecheck)
(cd packages/opencode && bun test \
  test/session/recovery-classifier.test.ts \
  test/session/recovery-runtime-proof.test.ts \
  test/session/recovery-coordinator.test.ts \
  test/session/recovery-replay.test.ts \
  test/session/recovery-continuation.test.ts \
  test/server/httpapi-session-recovery-actions.test.ts \
  test/session/llm.test.ts \
  test/session/llm-native.test.ts \
  test/session/snapshot-tool-race.test.ts \
  test/session/retry.test.ts \
  test/session/processor-effect.test.ts \
  test/session/message-v2.test.ts \
  test/session/prompt.test.ts \
  test/cli/run/run-process.test.ts \
  test/server/httpapi-sdk.test.ts)
# 上述六个 recovery classifier/runtime/coordinator/replay/continuation/actions files = [future/new]
# llm-native.test.ts 首批只验 Legacy experimental transport opaque/fail-closed，非 Native V2 Session

# packages/opencode：Legacy route entrypoint acceptance
(cd packages/opencode && bun ./script/httpapi-exercise.ts --mode effect \
  --include session.prompt --start-at '/session/{sessionID}/message' \
  --stop-at '/session/{sessionID}/message' --fail-on-missing --fail-on-skip)
(cd packages/opencode && bun ./script/httpapi-exercise.ts --mode effect \
  --include session.prompt_async --fail-on-missing --fail-on-skip)
(cd packages/opencode && bun ./script/httpapi-exercise.ts --mode effect \
  --include session.command --fail-on-missing --fail-on-skip)
(cd packages/opencode && bun ./script/httpapi-exercise.ts --mode effect \
  --include session.shell --fail-on-missing --fail-on-skip)
# 现有 exerciser 只证明 wiring；httpapi-session-recovery-actions.test.ts 必须补
# prompt_async/command incomplete；recovery-continuation.test.ts 补 ordinary continuation/child。
# shell 本身无 provider turn，只验 side effect 一次及后续独立 prompt/command recovery 不重放。

# packages/sdk/js：current generated SDK build/type/wire compatibility；正式实现/codegen 后执行
(cd packages/sdk/js && bun run build)
(cd packages/sdk/js && bun run typecheck)
(cd packages/sdk/js && bun run test)
# frozen Legacy v1 runtime/OpenAPI compatibility 由 packages/opencode existing tests 验证
(cd packages/opencode && bun test \
  test/server/httpapi-public-openapi.test.ts \
  test/server/httpapi-query-schema-drift.test.ts \
  test/server/sdk-v1-smoke.test.ts)

# packages/tui：sync、Session renderer、production Prompt submission
(cd packages/tui && bun run typecheck)
(cd packages/tui && bun test \
  test/cli/cmd/tui/session-recovery-sync.test.tsx \
  test/cli/tui/session-recovery-render.test.tsx \
  test/cli/tui/prompt-submit.test.tsx) # all [future/new]
```

Ownership 与 acceptance boundary：

- `packages/schema/test/session-recovery.test.ts`：internal/public schemas、old-row decode、canonical source/control event/field sets；
- `packages/llm/test/recovery-canonicalizer.test.ts`：`semantic-replay-v1`、`prepared-request-v1`、`recovery-binding-v1` golden/mutation vectors；
- `packages/opencode/test/session/recovery-classifier.test.ts`：Legacy durable snapshot + admission policy 的 pure action-specific matrices 和 exact ManualStop reasons；不得 mock transport 后声称 runtime proof；
- `packages/core/test/recovery-event-canonicalizer.test.ts`：`recovery-event-chain-v1`、source facts/version、control-tail golden/mutation/sequence tests；
- `packages/core/test/session-recovery-persistence.test.ts`：raw-event authority、live-aggregate immutable transitions、三 heads CAS、rollback、unique constraints、composite child projection、prefix publication suppression 与 explicit `RecoveryReplayRebuilder`；
- `packages/opencode/test/session/recovery-runtime-proof.test.ts`：default AI SDK Legacy transport 的 final-transform-before-fetch gate、typed prepared/authorized handle、receipt、stream-returning release/cancel/provider hits；
- `packages/opencode/test/session/recovery-coordinator.test.ts`：decision revision、budget/max-step、supersession、child admission、crash/re-entry state matrix；
- `packages/opencode/test/session/recovery-replay.test.ts`：serialized Legacy recovery events 跨新数据库后 authority/head/projection/ledger/digests 等价；
- `packages/opencode/test/server/httpapi-session-recovery-actions.test.ts`：HTTP/generated-SDK prompt_async 与 command incomplete recovery actions；shell 只验 N/A wiring/transcript/side-effect boundary；
- `packages/opencode/test/session/recovery-continuation.test.ts`：ordinary continuation、child/subtask 与既有 shell side effect 不被后续独立 recovery 重放；
- existing `httpapi-sdk.test.ts`：扩展 live listener/generated SDK incomplete recovery 与 optional wire projection round-trip；
- existing `run-process.test.ts`：扩展真实 CLI SafeRetry/Continue/ManualStop、old/new assistant visibility、budget termination；
- `packages/sdk/js`：generated Legacy SDK type/test compatibility；不把外部 consumer 变成产品场景，但必须防止 wire break；
- `packages/tui/test/cli/cmd/tui/session-recovery-sync.test.tsx`：真实 backend transcript/event shapes 的 sync/hydration contract；
- `packages/tui/test/cli/tui/session-recovery-render.test.tsx`：挂载 Session route/assistant renderer，验证 recovery child/error/order/final state；
- `packages/tui/test/cli/tui/prompt-submit.test.tsx`：挂载 production Prompt component，触发 normal prompt/command SDK calls；shell 只验本地 submission/transcript。只有 prompt/command submission、Legacy endpoint、provider incomplete、real events 与 renderer 全链路贯通后才称完整 TUI product E2E。

`packages/schema` 当前只有 `typecheck` script，schema suite 必须显式 `(cd packages/schema && bun test)`。所有 `[future/new]` 文件创建前不得执行或计入通过数。targeted tests 通过后，再分别执行 `(cd packages/llm && bun run test)`、`(cd packages/core && bun run test)`、`(cd packages/opencode && bun run test)`、`(cd packages/tui && bun run test)`、`(cd packages/sdk/js && bun run test)`；migration artifacts 另执行 core `bun run migration --check`。始终不运行根目录 test。

---

## 7. 代码更新检查清单

### 7.1 `packages/llm`

- [ ] 从 `@opencode-ai/schema` import/re-export 单一 `ProviderFailureClassification` source，覆盖 Legacy adapter/processor 所需的 `incomplete-stream`；不在 llm 内保留第二套 schema；
- [ ] 不用 message string 猜测 incomplete；
- [ ] 保持 classification 与 retryable 正交；
- [ ] 实现 provider target/domain binder，authority/endpoint 无法稳定解析时返回 unknown，不保存 secret；
- [ ] 实现 versioned `semantic-replay-v1`、`prepared-request-v1`、`recovery-binding-v1` canonical encoding 与 golden/mutation tests；不得复制 schema envelopes，object insertion order 不影响 digest，任一 canonical field mutation 必须改变对应 digest；
- [ ] 为默认 AI SDK 路径实现 allowlisted protocol adapter：actual dispatch 必须复用 audited no-send final-body lowerer，或使用 exact per-request pre-release capture/authorization gate；captured final-request golden 只做回归，不能单独授权；未证明时只允许 opaque/ManualStop；
- [ ] 添加 Legacy adapter integration tests，以及 Anthropic/OpenAI Responses 当前 Legacy 所需的 closure/storage-mode tests；共享 `packages/llm` serializer tests 只能作为结构单测，不能替代实际 AI SDK dispatch proof。

### 7.2 Shared / Legacy durable schema `packages/schema`

- [ ] `src/llm.ts` 作为跨 package wire contract 的单一 source，拥有 classification、target/domain、fence/proof、chain/link、terminal/decision 与 digest envelope schemas；不得依赖 llm/opencode；
- [ ] `src/v1/session.ts` 组合 shared schemas，为 Legacy 持久化 dispatch evidence、pre-decision terminal fact、internal `RecoveryDecisionRecord`/consumption link 与 recovery chain/binding；assistant public wire 只增加 optional `IncompleteRecoveryProjection` summary，不复制内部 proof/request/CAS unions；
- [ ] Legacy tool evidence 持久化 executionKind、input/call phase 与 interruption provenance，reasoning part 持久化 provider-end / step-boundary-flush / cleanup-flush provenance；
- [ ] old Session rows 缺失新增字段时按 unknown/closure-ineligible 解码，不补成 false/local/safe；新增 projection 字段保持 optional，评估 closed-union 新 discriminator 对 exhaustive consumer 的兼容影响；
- [ ] 定义 `RECOVERY_SOURCE_FACT_EVENT_TYPES_V1`、`RECOVERY_CONTROL_EVENT_TYPES_V1`、`RECOVERY_SOURCE_FACT_FIELDS_V1`、`RECOVERY_CONTROL_TAIL_FIELDS_V1` 的唯一 schema source；添加 exact membership/order、required/nullable/forbidden fields、source/control overlap rejection、旧数据 compatibility 与 dependency/duplicate-contract hygiene tests；用 §6.5 显式 schema test 命令执行。

### 7.3 Shared persistence `packages/core`

- [ ] 在 `packages/core/src/session/sql.ts` 定义 raw-event-backed recovery materializations，以及 `recovery_head`、`assistant_chain_head`、`dispatch_ledger_head` 三个 CAS indexes；生成 migration/schema artifacts；
- [ ] 实现 `recovery-event-chain-v1`、source facts/version、control-tail extractor、`RecoveryTransitionProjector`、`RecoveryHeadsCommit` 与 explicit `RecoveryReplayRebuilder`；raw `EventTable` 是 sole replay authority，operation + nextStateDigest 不复制完整 next state；
- [ ] `packages/core/test/recovery-event-canonicalizer.test.ts` 覆盖 exact raw-event hash envelope、source/control membership、assistant scope、golden/mutation；`packages/core/test/session-recovery-persistence.test.ts` 覆盖三 heads、rollback、composite child projection、prefix publication suppression、replay/repair、cascade；
- [ ] 运行 `packages/core/test/database-migration.test.ts` 与 `bun run migration --check`，覆盖 existing-data upgrade、unique indexes 与显式 session deletion cascade。

### 7.4 Legacy `packages/opencode`

- [ ] 为 allowlisted provider/protocol 新增 declarative preparation/introspection adapter，在选择实际 API mode/base URL/model、storage mode 与可能的 fetch endpoint rewrite 后返回稳定 target/route/protocol/endpoint/authority 及 semantic dispatch representation；opaque/dynamic/unregistered adapter 一律 unknown/ManualStop，不从 `LanguageModelV3` 事后推断，不持久化 secret；
- [ ] `session/llm.ts` 拆分 `preparePausedRequest → canonical semantic/prepared digest → durable authorization/event + online CAS → release/cancel`，确保默认 AI SDK Legacy transport 只能在 admission transaction 成功后 release，且 authorization 后仍可能改变 wire semantics 的 middleware/fetch rewrite 会使 planned result typed unavailable；experimental native Legacy transport 在实现同一 contract 前只写 opaque evidence并 fail closed；
- [ ] 为上述接缝注入 digest/evidence commit failure，断言 AI SDK `streamText()` 与 native provider stream 均未被调用；
- [ ] `session/llm/ai-sdk.ts` 发出 typed incomplete classification；
- [ ] `packages/schema/src/v1/session.ts` 增加 optional explicit `dispatchSummary` / `incompleteRecovery` projection 字段；完整多 entry ledger 留在 authoritative relation；公开 error 默认继续投影 `UnknownError`，只有版本化/明确 breaking 决策后才加入 `MessageIncompleteStreamError` discriminator；同步 OpenAPI/generated SDK compatibility；
- [ ] `session/processor.ts` 的 provider-error 与 `settleIncomplete()` 都保留 typed classification；
- [ ] `session/tools.ts` 与 processor Handle 增加 durable-before-execute handshake；running part commit 失败时不调用本地工具；
- [ ] 扩展 Legacy Session/EventV2Bridge 接缝传递 `PublishOptions.commit`，发布 schema-defined recovery operations；每次 semantic dispatch 前必须通过 mechanical evidence-before-send gate。semantic evidence 可 `available | opaque`，mechanical gate 则独立为 `implemented | unavailable`：opaque 初始请求只有 gate implemented 且 opaque evidence commit 后才能发送；automatic recovery 还要求 semantic available；experimental native 若缺 gate 必须 fallback/disable covered execution，不能 ungated 发送后再补 opaque evidence；
- [ ] 通用 retry policy 不处理 incomplete-stream；每次进入 `llm.streamBatches()` 前原子追加 semantic-dispatch ledger。若外层 policy 已产生第二次 dispatch，该 assistant 后续只允许 ManualStop；或在首次 conversation provider dispatch 后禁用外层重发；
- [ ] processor 完成工具 drain 后，Prompt 先持久化 `IncompleteStreamTerminalFact`、reload durable state，再交给 recovery classifier；
- [ ] `session/prompt.ts` 支持新 assistant recovery attempt，以及 pre-decision terminal 的 re-entry/finalization；
- [ ] 添加 durable RecoveryLineage、AssistantAttemptIdentity、逐 semantic-dispatch ledger/replay fence、semantic/prepared digests，以及 classifier `RecoveryDecisionProposal`、committed `RecoveryDecisionRecord` 与完整 automatic binding；binding 必须覆盖 exact `nextContext`、admission N/M/policy digest、冻结 source/control versions、closure 与唯一 authorization；decision link 含 revision；SafeRetry source/planned semantic digest 必须相等；
- [ ] `packages/opencode/test/session/recovery-replay.test.ts` 覆盖 serialized Legacy events 跨新数据库后的 Legacy message/projection/coordinator reload 行为；core authority/head/materialization 等价由 §7.3 的 core tests 负责。
- [ ] `structured` 与其他 attempt-local 状态按 attempt 重置；
- [ ] `session/message-v2.ts` 实现 recovery-aware history selection；Continue decision 前由与 actual dispatch 复用的 audited lowerer，或 exact per-request pre-release authorization adapter，检查 protocol/storage-mode closure；OpenAI Responses 分开处理 normalized `store:true` reference 与 `store:false` typed-stateless 分支：当前 lowerer 在 reasoning replay 上仍依赖 item ID，必须先修改并以 exact wire test 证明无 ID encrypted reasoning；hosted item 按 exact kind allowlist，首批 unsupported kind fail closed；settled local tool 仍使用普通 tool messages，并要求 provider-end provenance、model compatibility 与运行时 lowering proof；
- [ ] 新增 Legacy hard max-step admission guard（当前只有 last-step prompt injection），修正持久化错误 entry guard，只允许 binding 完整、hard admission 未耗尽且未被唯一消费的自动 action；
- [ ] 更新 CLI / child session 错误传播测试。

### 7.5 Wire / entrypoint test ownership

- [ ] `packages/core` 实现并测试 migration、raw-event sole authority、live-aggregate append-only materializations、三 heads CAS/rollback、canonical source/control extraction 与 explicit replay rebuilder；
- [ ] `packages/opencode` 实现并测试 default AI SDK Legacy runtime proof、typed prepared→authorized→released/cancelled gate、classifier/coordinator/revision/supersession、cross-database reload，以及 prompt_async/command HTTP actions与 ordinary continuation/child；shell recovery 为 N/A，只验 route/transcript/side-effect boundary；
- [ ] `packages/opencode/test/server/httpapi-sdk.test.ts` 扩展 live listener + generated SDK incomplete recovery/wire round-trip，不把当前 smoke test误称 recovery evidence；
- [ ] `packages/sdk/js` 在正式 codegen 后执行 typecheck/tests，验证 optional public projection 与旧 Legacy consumer compatibility；
- [ ] `packages/tui` 分开验证 recovery transcript sync/render 与 production Prompt submission；只有全链路贯通才声明 TUI product E2E；
- [ ] 所有 `[future/new]` 测试创建前不得运行或计入当前 50 项通过数。

### 7.6 回归与兼容性

- [ ] 已完成工具不重复执行；
- [ ] partial text/reasoning 不误报成功；
- [ ] StructuredOutput 不跨 attempt 泄漏；
- [ ] context-overflow compaction 行为不回归；
- [ ] 用户 interrupt、permission decline、普通 provider error 语义不回归；
- [ ] Legacy HTTP/OpenAPI/generated SDK round-trip 与旧客户端容忍新增 optional projection fields 的兼容性不回归；本次不新增 public error discriminator，若未来另行批准则使用独立 versioned/breaking compatibility suite；
- [ ] model switch 后 provider metadata 复用规则不回归；
- [ ] max-step 的 same-process 语义不回归，recovery dispatch 不绕过 guard；
- [ ] semantic/prepared/binding digest 按各自边界检测 plugin/tool/provider-option/history/authority/fence/proof/closure 变化，SafeRetry 不会把新语义请求误当 source replay；
- [ ] decision/ordinal 唯一消费与 crash re-entry 不产生重复 child；
- [ ] 未声称 durable global max-step、独立 physical-request budget 或任意 crash exact-once。

---

## 8. 文档更新检查清单

- [ ] 更新本文状态、最终字段名、分类表与实际测试结果；
- [ ] 在生产实现前单独 rewrite/supersede `docs/design/session-recovery/architecture.md` 的旧 lifecycle/source-version/binding/AttemptRecoveryEvidence/module-interface 段，并重新架构审查；该旧稿本轮不修改且不得作为实施 authority；
- [ ] 若本次共享 LLM/schema contract 改变，更新对应 Legacy API/schema 文档；
- [ ] 更新测试说明，明确根 `bun run test` 与 package-level targeted tests 的区别；
- [ ] 实现完成后新增 `docs/devlog/YYYY-MM-DD-<简述>.md`，包含 workflow 要求的度量；
- [ ] 将实现中发现的非显然限制同步回项目规范的“已知限制与注意事项”；
- [ ] 在正式 Bun 1.3.14 验收环境记录所有 Legacy typecheck/test 命令、通过数与失败数；已执行的范围核验测试与后续 recovery 验收结果分开记录。

---

## 实现前仍需确认的架构决策

1. **Attempt replay fence、target authority 与双 digest 的来源**：选择首批 allowlisted declarative provider/protocol adapters；opaque dynamic factory、未声明 middleware 或无法进入 pre-release authorization gate 的 fetch-time endpoint rewrite 必须 unknown。provider capability/domain 由 adapter 提供，local-tool capability 由 runtime 提供；二者都必须基于该次可证明的 semantic prepared dispatch，并在 dispatch 前随 attempt 持久化。当前 conversation 每次 `streamText()` invocation 是一个 semantic dispatch，AI SDK `maxRetries=0` / `stepCountIs(1)`；但外层 `SessionRetry` 可在同一 assistant 下创建第二 invocation，因此 automatic recovery 必须要求 ledger 恰好一次，或在首次 dispatch 后禁用该外层重发。幂等 fence必须覆盖原 semantic dispatch payload 与 recovery replay，且未来若内层 retry/multi-step 开启，必须覆盖 invocation 内所有 model steps/physical requests，否则降级 unknown。所有幂等/续传 fence还必须声明 provider/route/protocol/endpoint/account-authority/model safety domain。`semanticReplayDigest` 只绑定可比较的 semantic payload，SafeRetry 要求 source/planned 相等；`preparedRequestDigest` 额外绑定 fence/proof/closure 的 exact dispatch envelope，Continue 通过显式 source+closure transform 而非 digest equality。两者 canonicalizer 都必须有版本与 golden vectors；golden 不替代运行时 proof。
2. **Legacy durable-before-execute 与外层 retry**：是否在 `SessionProcessor.Handle` 增加 begin/start tool call API，并由 AI SDK `tools.ts execute()` 在副作用前调用；若不实施，Legacy 只要提供本地工具就不能自动恢复。同时必须选择：(a) normal conversation 首次 dispatch 后禁用外层 `SessionRetry` 重发，或 (b) 持久化逐 semantic-dispatch ledger；只有 ledger 恰好一次且 fence 一致时才允许 automatic recovery，多次/未知 dispatch 一律 ambiguous ManualStop。
3. **Legacy durable recovery metadata 与唯一消费的承载位置**：raw `EventTable` serialized recovery operations 是 sole replay authority；relations/projection 是 rebuildable materializations，`recovery_head`、`assistant_chain_head`、`dispatch_ledger_head` 是 derived online CAS indexes。必须持久化 decision action/revision/status/source version、exact child/admission binding/authorization 与 operation + nextStateDigest；runtime handle 永不持久化。实现分为 `RecoveryTransitionProjector`、`RecoveryHeadsCommit` 与 explicit `RecoveryReplayRebuilder`，accepted replay使用同 projector，repair 从 raw rows 重建；replay publication在完整 prefix/head finalization前抑制。另须固定 canonical sets 的 schema/core API。旧 `docs/design/session-recovery/architecture.md` 在实施前必须单独 supersede/update 并重新审查。
4. **Legacy reasoning completion provenance**：在 Legacy explicit part field 中表达 provider-end、step-boundary-flush 与 cleanup-flush；仅 provider-end 默认可进入 continuation closure。
5. **Continuation closure validator 与实际发送绑定**：Legacy allowlisted adapter 必须让 validator/digest 与 actual dispatch 复用同一 no-send final-body lowerer，或在 transport network release 前对该次 exact request capture并完成 durable authorization；公共 `packages/llm` serializer 与 captured golden fixtures只能作为结构/回归证据，不能单独证明任意请求等价。必须在 recovery decision 前得出 constructible/unavailable，并保证 authorization 后无 middleware/provider rewrite 改变语义；否则按 original/planned 阶段分别 opaque 或 `dispatch-lowering-unverifiable`/ManualStop。
6. **Recovery budget 参数 `N`**：contract 只规定 `candidateRecoveryOrdinal <= N`，并要求测试 `N=0/1/2`；本文仅建议 `N=2` 作为可能默认，需要确认配置入口、默认值与兼容策略。该预算不等于 assistant max-step 或 physical request budget。
7. **Legacy 序列化兼容与 wire envelope**：新增 assistant optional `dispatchSummary`/`incompleteRecovery` projection fields，以及 tool/reasoning provenance；完整 ledger 不压入单数 message 字段。对 terminal error 的公开 wire 采用兼容优先策略：旧 Legacy endpoint/SDK 继续投影现有 `UnknownError` + canonical message/classification projection；内部 durable classifier 使用 typed terminal fact。只有确认版本化 endpoint/schema 或接受 breaking change 后，才把新的 `MessageIncompleteStreamError` discriminator 暴露给 public closed union。必须补旧数据 decoder、OpenAPI/generated SDK与 exhaustive consumer compatibility tests。
8. **UI 展示与验收**：旧失败 attempt 必须保留；本次不要求新增折叠样式或恢复原因文案，但必须通过 TUI-level acceptance 证明 recovery child 会被继续同步/展示、原 error 不被覆盖、最终 session 状态正确。更丰富的视觉分组属于后续展示设计。
9. **Shared contract ownership**：确认 `packages/schema/src/llm.ts` 是 wire schema 单一 source，`packages/llm` 只拥有 binder/validator/digest implementation 并 import schema，Legacy 只组合/消费；不得通过复制 types 规避 dependency cycle。
10. **same-process max-step integration**：当前 Legacy 不存在 hard guard。contract 已固定为 initial `assistantSequence=0`、合法 sequence `0..M-1`、candidate 必须 `< M`，并由 `assistant_chain_head` immediate-successor CAS admission；仍需确认配置规范化入口和与现有 `MAX_STEPS_PROMPT` 的集成。ordinary continuation 与 recovery 共用该 assistant budget，exhausted finalization 写入失败时只保证当前进程 cancel/fail closed。

在其余架构决策确认、设计细化并通过审查前，不应开始生产代码实现。
