# Session 不完整流恢复：根因分析与修正方案

> Issue: [#7](https://github.com/lihaokun/opencode/issues/7)
>
> 状态：CLI/TUI 产品范围内的实现前方案，尚未修改生产代码。
>
> 审视日期：2026-08-12。
>
> 产品范围：本方案仅覆盖常规 `opencode run`、TUI 通过公开 unprefixed `/session/...` SDK/HTTP operations 使用的 Legacy Session execution。不会修改或启用 Native V2 Session runner 的 recovery 行为、专属 tests 或 spec；但 Legacy recovery 所需的 shared LLM contracts、Session SQLite schema/migrations 与 EventV2 plumbing 会做向后兼容的 shared 修改，并必须运行 Native V2/shared regression，Native V2 不纳入 recovery 产品验收。外部直接 Session API/SDK consumer 与独立 V2 preview 也不属于本次产品验收，但公开 Legacy route/wire compatibility 仍必须保持。
>
> 证据范围：当前本地仓库与 Issue #7 正文；未查看上游仓库、上游分支或上游实现。
>
> 文档权威边界：`docs/design/session-recovery/architecture.md` 是 2026-08-11、无 Bun 运行时证据且仍包含 Native V2 recovery scope 的旧架构评审稿，与本轮证据和范围不一致；本次不修改该文件，它不能作为当前实施权威。本文获批后，必须在单独架构阶段明确 supersede/update 旧稿并再次审查，之后才能开始生产实现。
>
> 运行环境：本机 PATH 中的 Bun 1.3.14；审计基线 HEAD `0ea5c2959`。
>
> 验证状态：本轮在确认 branch/HEAD/Bun 后，重新实际执行 46 个 Bun tests 与 4 个精确单选的范围内 Legacy HttpApi exerciser scenarios，共 50 个范围内检查；50/50 通过，0 failed，0 skipped。另有一次 selector 过宽的辅助 exerciser 运行执行了 37 个 scenarios（全部通过），但不计入这 50 项验收。当前 Legacy fail-stop、partial/error 持久化、普通 tool continuation、child failure propagation 与 outer `SessionRetry` 的第二次 provider HTTP 请求已有运行时证据；本文提出的 automatic recovery、dispatch ledger/CAS、durable-before-execute、provider closure、budget、wire/replay compatibility 与 recovery TUI 展示尚未实现，仍是设计义务和实施后验收项。

## 证据等级与本轮运行记录

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

**拟实现的恢复 contract（当前尚未实现）：**Issue #7 不能通过“把 incomplete-stream 改成普通可重试错误”安全解决。未来恢复独立于通用 transport retry，且仅在下表全部成立后执行：

| Gate | 已确定事实 |
|---|---|
| terminal/tool | provider turn 确实 incomplete；已启动本地工具均已等待并持久化，分类来自 durable projection而非内存布尔值 |
| replay/closure | provider 无未观测副作用或 action受覆盖 entire-attempt replay 的幂等/覆盖 durable prefix 的续传契约保护；本地工具未提供或 runtime 已证明 durable-before-execute；settled-tool continuation 可按目标 protocol合法构造 |
| admission/binding | recoveryOrdinal与同进程 max-step均未耗尽；planned canonical digest、endpoint/authority、proof与 durable binding一致；decision经唯一 consumption link原子创建新 assistant，chain ordinal不重复 |
| outcome | 下一 provider call使用新 assistant且不覆盖失败 attempt |

本方案的具体实现只落到 CLI/TUI 会话执行实际使用的 Legacy 路径。真实 CLI subprocess 已覆盖 normal prompt、tool continuation 与 child/subtask；in-process route exerciser 已覆盖 unprefixed Legacy prompt/command/shell handler wiring。当前源码调用链显示 TUI prompt/command/shell 使用 Legacy SDK 操作，但仓库尚无完整 TUI submission route 端测。Legacy 路径实现本文 contract 并通过相应 CLI/TUI 会话验收后，方可在当前产品范围内验收 Issue #7。

建议保留三种用户可见结果，但收紧自动恢复条件：

```text
IncompleteStreamRecovery
├── SafeRetry
├── ContinueAfterSettledTools
└── ManualStop
```

其中“没有观察到 `providerExecuted`”不能证明“provider 没有执行副作用”。在缺少 provider 级安全围栏时必须降级为 `ManualStop`。

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

Legacy tool part 的关键持久化位置是 pending `processor.ts:258-274`、running `:353-374`、completed `:182-205`、error `:208-225`、cleanup/interrupted `:602-660`（均位于 `packages/opencode/src/session/`）。

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

## 2. 根因分析

### 2.1–2.2 信号与 retry 边界根因

| 根因 | 当前事实 | 修正约束 |
|---|---|---|
| incomplete-stream 未形成 Legacy typed contract | `ProviderFailureClassification` 只有 `context-overflow`（`packages/llm/src/schema/errors.ts:4-5`）；canonical adapter 未填写可选 classification，clean EOF 也落为 generic `UnknownError` | 将 `incomplete-stream` 纳入单一 typed contract，由 canonical adapter 与 `SessionProcessor.settleIncomplete()` 共同接入；禁止按 message string 猜测 |
| transport retryability 与 agent replay safety 混同 | attempt 可能已持久化 partial text/reasoning、发出并执行本地 tool call、触发 hosted tool，或 provider 已产生但流未送达的副作用；通用 retry 位于 `processor.ts:727-745`，早于 Prompt 的 durable tool-state 检查 | canonical incomplete 保持 `retryable:false`，classification 与 retryable 正交；由专用 classifier 创建新 assistant attempt。不得删除 `retryable:false` 或让 `SessionRetry.policy()` 直接重跑旧 processor |

### 2.3 “没有观察到工具事件”不能证明没有副作用

存在两类独立的不确定性。**Provider-hosted 副作用：**只有收到相应 tool event 后才能知道 `providerExecuted`，而 LLM 事件 schema 的 `providerExecuted` 是可选字段。
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

结论：在 provider network release 前、且 exact request/tool capabilities 已由 paused preparation 确定后，必须随 assistant attempt 持久化不可变 source dispatch evidence。以下只给出概念字段；唯一 canonical 完整定义见 §3.3，避免两处类型镜像漂移：

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

持久化组件与约束：

| 组件/边界 | 规范 |
|---|---|
| `RecoveryTransitionProjector` / `RecoveryReplayRebuilder` | online/accepted replay 从 authoritative `operation` 幂等写 relations、child `MessageTable`与 projection，校验 `nextStateDigest`；repair直接 fold raw `EventTable`重建，不形成第二 authority |
| 三 CAS heads | `recovery_head(sessionID, sourceAssistantID)` 管 revision；`assistant_chain_head(sessionID, chainID)` 管所有 immediate successors；`dispatch_ledger_head(sessionID, assistantID)` 管 semantic-dispatch ordinal。各自定义 genesis/predecessor/next state、missing/corrupt与 affected-row=1；automatic child事务同时 CAS所需 heads、写 child ordinal 0并 consume，ordinary continuation推进 chain，每次 dispatch推进 ledger |
| revision/child relation | 同 source/version可有 append-only revisions但 folded state最多一个 active；decision series以 `(sessionID, decisionID, decisionRevision)` 唯一且 decisionID稳定；consumption/child对 decisionID唯一。recoveryOrdinal只约束 incomplete child，assistantSequence约束所有 attempt |
| composite operation | child admission是单一 serialized control operation，其 nested child context/commitment不是第二 source event；projector同事务写 Message/relations/ledger/consumption。post-commit `message.updated`只能是非 durable signal；若保留 durable MessageUpdated，须先设计 atomic publishBatch并调整 tail policy |
| replay/migration | `replayAll()` 在 accepted prefix fold/materializations/三 heads完成前 suppress live publication，并定义 prefix marker/batch transaction；same event幂等，same seq different payload/type或 transitionID跨 event拒绝。migration支持旧数据但不推断 safe authority；测试覆盖 head-CAS rollback、cross-db equivalence、publication suppression、corrupt heads/branch/gap/duplicate与 session cascade；无法原子/replay则禁用 automatic |

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

Issue #3 已建立且不得撤销的本地 fail-stop 不变量已经纳入顶部证据表与 §1.2：incomplete 不报成功；partial text/reasoning/tool state 保留；已覆盖 persisted-error、length、missing-finish/high-usage 与 child/subtask fixtures 不重放 completed tool（但这不是通用 replay-safety/durable-before-execute 证明）；StructuredOutput incomplete 不晋升；canonical incomplete 不走通用 retry。相关回归文件为 `prompt.test.ts`、`processor-effect.test.ts`、`message-v2.test.ts`（本轮未执行）、`retry.test.ts` 与 `run-process.test.ts`；Issue #7 只能在这些不变量上增加经过证明的恢复。

## 3. 修正方案

### 3.0 当前实施范围决策

兼容性说明：外部 API/SDK consumer 不属于 Issue #7 的产品行为验收，但 Legacy assistant schema、error discriminator 与 generated SDK 是公开 wire compatibility 面。新增 `dispatchSummary`、`incompleteRecovery` 必须采用旧数据可解码/新字段可选的兼容策略；公开 error 默认继续投影现有 `UnknownError`，typed terminal fact 先保持内部 durable contract。只有版本化 endpoint/schema 或明确接受 breaking change 后才暴露新 discriminator。补 OpenAPI/codegen drift、generated SDK type、Legacy HTTP round-trip 与旧客户端容忍性测试；不能以“外部 consumer 范围外”为由忽略 wire 影响。

本次实施范围是（recovery entrypoints 为 normal prompt/`opencode run`、进入 Legacy model 的 command、ordinary continuation 与 child/subtask；`SessionPrompt.shell()` 本身只执行/持久化本地 shell，不产生 provider stream，因此 shell incomplete recovery 为 N/A）：

1. 共享 LLM/schema 层中 Legacy 所必需的 typed classification、recovery contract 与纯语义；
2. Legacy provider/Prompt/Processor/tools/history-lowering 路径；
3. Legacy recovery 必需的 shared core persistence plumbing：Session SQLite relation、migration/generated schema、replay-safe projector/event payload 与 `EventV2` transaction seam；
4. Legacy 定向测试、CLI/child-session 回归、Legacy HTTP/generated SDK compatibility 与相应设计/开发文档。

这里列的是实现 ownership：不扩展其他 Session runtime 的 recovery 行为或产品验收，但 shared contract/storage schema 的兼容性修改及相应 shared/Native V2 回归验证仍是必要辅助工作。

该范围与当前证据支持的会话入口一致：真实 CLI subprocess 已覆盖 prompt、tool continuation 与 child/subtask；route exerciser 覆盖 Legacy prompt/command/shell handler wiring；TUI 提交到该 route 的边界当前仍以源码为证，尚缺完整 submission 端测。

### 3.1 必需不变量与可选策略

| 类别 | 约束 |
|---|---|
| 失败与身份 | incomplete attempt 永远保留 terminal error；每次恢复使用新 assistant ID；失败 attempt 不被覆盖；分类只读 durable projection，持久化失败时当前执行 fail closed |
| dispatch authority | provider network release 前持久化 attempt identity 与 evidence：available 记录 exact target/authority、capability、replay fence 与 prepared digest，opaque 记录原因；下一次调用前 durable 写入失败 attempt、工具结算、decision/consumption 与新 identity |
| 唯一性与预算 | incomplete child 的 `(sessionID, chainID, recoveryOrdinal)`、decision consumption 唯一；所有 assistant 的 `(sessionID, chainID, assistantSequence)` 唯一且是 immediate successor；自动恢复有 durable 参数 `N`，不冒充 physical-request budget |
| 副作用安全 | 不重放已执行工具；pending/running/interrupted/uncertain 工具、provider/local fence 任一 unknown 均不得自动恢复；Legacy 本地工具必须先有 durable-before-execute handshake |
| 上下文安全 | partial prose/reasoning 不得无条件进入下一请求；step-boundary/cleanup flush 不得冒充 provider-completed reasoning；StructuredOutput 等 attempt-local 状态必须隔离 |

策略参数：candidate 仅在 `candidateRecoveryOrdinal <= N` 时 admission；`N=2` 只是建议默认而非已批准 contract，测试必须覆盖 `N=0/1/2`。无 provider 幂等证明时仅接受 `no-provider-side-effects-offered`；local-tool 仅接受 `none-offered` 或已实现并测试的 `durable-before-execute`。decision 对用户可见，是否折叠旧失败 attempt 属于 UI 策略。

### 3.2 统一 failure classification

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

#### 3.2.1 Shared type ownership 与依赖方向

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

#### 3.2.2 Provider preparation/introspection 边界

当前 `LLMRequestPrep.Prepared` 只包含高层 system/messages/tools/params/options/headers（`packages/opencode/src/session/llm/request.ts:38-51`），后续 AI SDK middleware、动态 provider factory 或 transport fetch wrapper 仍可能改变最终 lowering/endpoint。`Provider.getLanguage()` 也只返回 opaque language model（`packages/opencode/src/provider/provider.ts:1868-1890`）；任意动态安装 provider factory 同样存在（`packages/opencode/src/provider/provider.ts:1814-1834`）。因此不能声称简单拆分现有 `prepare()` 就能对全部 Legacy provider 得到 exact wire request/authority。

本次必须新增**显式、allowlisted、版本化的 declarative preparation/introspection contract**：只有 provider/protocol adapter 能在发送前返回稳定 `DispatchTarget`、authority、effective storage mode、replay capability、semantic prepared representation 与 digest inputs 时，才能产生 automatic-safe fence。更重要的是，closure validator、digest materializer 与实际 dispatch 必须共享同一个 no-send audited final-body lowerer，或实际 transport 在网络 release 前捕获该次 exact normalized URL/body/tool/options，先用捕获结果完成 durable authorization，再允许发送。有限的 captured golden fixtures 只能做版本回归和已知样例对照，不能证明任意运行时请求经过 `ProviderTransform.message()`、AI SDK provider lowering、middleware/fetch wrapper 后都与 validator 表示等价，也不能单独让 adapter 变为 available。authorization commit 后若仍有 middleware、动态 provider factory 或 transport rewrite 能改变 tool/reasoning/history/storage semantics，则该 adapter 不得标记 available。transport fetch wrapper 若可改写 endpoint/account authority，也必须在 contract 中提前声明有效最终 target；若只能在实际 fetch 时才知道，则必须使用上述 per-request pre-release capture/authorization gate；没有该 gate、dynamic factory 未实现 contract、或 opaque model 无法证明 target 时，resolver 必须写 opaque evidence，incomplete 后 ManualStop。该保守降级不要求一开始支持所有 provider。

### 3.3 Durable recovery model

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

#### 3.3.1 Durable source snapshot

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

#### 3.3.2 Planned no-send materialization

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

#### 3.3.3 内部权威 decision 与公开 projection

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

### 3.4 权威 evidence 与 paused dispatch protocol

#### 3.4.1 Source checkpoint 与 control tail

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

这些 recovery transition 只允许进入 raw `EventTable` 与内部 projector/rebuilder 输入；不得作为普通 Session sync/global bus 事件经 `EventV2Bridge` 暴露。实现必须提供 internal-only durable publish seam，或在 bridge/publication 层明确 suppress/filter `session.recovery.*` payload，只对外发布不含 authority fields 的 `IncompleteRecoveryProjection` / `DispatchSummaryProjection` 和既有 message/session signals。验收必须证明公开 Legacy sync、generated SDK/TUI event surfaces 与 Native V2/shared subscribers 都不会收到 ledger、proof、digest、decision link、CAS predecessor、sealed ref 或 canonical transition operation。

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

实现前 canonical/replay tests 必须覆盖：

| 类别 | Cases |
|---|---|
| set/field golden | 四个 sets exact membership/order；每个 event required/nullable/forbidden fields；object insertion order不改 digest，任一 canonical field mutation改变 digest |
| reject | unknown recovery event、missing/forbidden authority field、source/control overlap；duplicate/gap/same-seq-different payload/type；unknown hash/event-types/field-set version |
| stale/prefix | source high-water后 user/config/history/tool event使 tail stale；prefix missing/extra/mismatch与 ancestry mutation拒绝 |
| replay | serialized events到新数据库后 source/control、revisions、consumption、child ledger、projection与 heads等价；online folder与 rebuilder final state相同，predecessor branch/gap均失败而不择一修复 |

有限 golden fixtures 只证明这些固定 canonical samples，不证明任意 runtime transport lowering；后者仍由 paused-request authorization integration 负责。

#### 3.4.2 Prepare → authorize → release / cancel

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

#### 3.4.3 Durable persistence authority

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

当前 `EventV2` 顺序为 projectors → `commit(seq)` → sequence/event row；accepted replay运行同 projectors，exact replay equality后返回，callback不序列化/重放。组件规范：

| 组件 | 职责 |
|---|---|
| `RecoveryTransitionProjector` | online/accepted replay从 discriminated `operation` 幂等写 immutable relations、decision/consumption、child Message/ledger与 projection；校验 fold所得 `nextStateDigest`；不写 heads；transitionID跨 event拒绝；composite operation是唯一 durable child authority |
| `RecoveryHeadsCommit` | online `PublishOptions.commit(seq)` 原子 CAS operation需要的三 heads，使用 explicit genesis/predecessor/next digest且 affected rows精确；任一失败回滚 projector/projection/event sequence/event row/heads |
| `RecoveryReplayRebuilder` | repair/validation按 raw aggregate sequence fold并重建 relations/projection/heads；新库 replay在完整 prefix/head finalization前 suppress publication并有 marker/batch；branch/gap/payload conflict/duplicate transition/two-active/orphan/sequence-hash mismatch均失败 |

`RecoveryTransitionProjector` 与 `RecoveryReplayRebuilder` 可复用 pure folder，但前者是 transaction projector，后者是对 raw authority 的 explicit rebuild。migration 必须支持 existing data且不推断旧 assistant 为 safe authority；live aggregate 内 individual transitions immutable，显式 session deletion 可按现有 cascade 删除整个 aggregate/materializations。

persistence/replay tests 覆盖 empty/existing migration、unique/cascade；online atomic happy path与 head-CAS full rollback；duplicate idempotency/conflict；revision/consume/supersede race；cross-db authority/materialization/digest/head equivalence；event deletion/reorder/tamper、branch/gap/bad head fail closed；tampered public projection不能授权且只能由 rebuilder恢复。

#### 3.4.4 Legacy 执行顺序

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

### 3.5 保守分类器

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

统一 reason 顺序只由 §3.3.3 的 `MANUAL_STOP_REASON_ORDER` 定义，不在此复制第二份列表。

classifier 不负责把低层 exception 猜成任意 reason；runtime adapter 必须返回 typed unavailable cause。`planned-runtime-proof-unavailable` 表示 runtime adapter 根本无法建立 paused authorization contract；`dispatch-lowering-unverifiable` 表示 adapter 声称可 preparation，但该次 exact lowerer/transport mutation 无法与 captured representation 建立等价。二者不可互换。ManualStop decision 不构造假 target、proof 或 binding。

### 3.6 新 attempt 与恢复顺序

§3.4.4 是唯一 authoritative prepare/authorize/release/cancel 顺序；Session 层补充约束如下：

| 阶段 | Legacy 约束 |
|---|---|
| tool 与 terminal | 本地工具在 `item.execute()` 前提交 complete input 与 durable call/running part，失败则不执行；adapter/`settleIncomplete()` 保留 typed classification；processor drain 后持久化 execution/input/call/settlement/interruption/reasoning provenance，再写 terminal fact并 reload snapshot |
| proposal 与 activation | runtime 针对候选 action prepare paused request；pure classifier 结合 admission plan 生成 proposal。ManualStop commit 为 finalized 后 cancel并 break；automatic transaction 重查 N/M/policy、attempt-local ownership、source/control/binding |
| child release | 只有三 heads CAS、decision consumption、exact child 与 ordinal-0 ledger 原子 commit并返回 receipt，same handle 才 authorize/release；所有 stale/CAS/persistence/ownership failure 均 cancel且 recovery provider hits 为 0 |
| re-entry | 仅同进程且原 runner ownership/fiber 活跃可 attach nonterminal child；跨进程/ownership 丢失为 `dispatch-ambiguous`；matching terminal child 只观察/分类；active decision 无 child 才能消费；link/ordinal/version 冲突 fail closed |
| 非 recovery | incomplete 不重跑旧 processor且继续排除于 `SessionRetry.policy()`；outer policy 若已产生第二 semantic dispatch则 ledger 多条、后续 incomplete fail closed（或实现选择首次 dispatch 后禁用 outer resend）。普通 provider error、interrupt、permission decline、context overflow 保持现有语义 |

新用户输入的 supersession/CAS 规则见 §3.9。

### 3.7 Recovery-aware model lowering

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

### 3.8 StructuredOutput 与其他 attempt-local 状态

每个 recovery attempt 必须重新初始化 `structured`、临时 output accumulator、processor-local provider evidence、未完成 fragment buffers 和绑定旧 assistant ID 的 toolcall map；建议把 `structured` 移入 while-loop 内的 attempt scope，而不是依赖分支清空。

### 3.9 identity、admission、supersession 与 crash 边界

| 边界 | 规范 |
|---|---|
| `dispatchOrdinal` | 每 assistant 从0开始，每个 semantic dispatch是唯一 immediate successor；unique `(sessionID, assistantID, dispatchOrdinal)`并由 `dispatch_ledger_head` CAS；duplicate/gap/unknown fail closed，automatic source必须只有 ordinal 0 |
| `assistantSequence` | 每 chain从0开始，initial/recovery/ordinary均占连续序号；unique `(sessionID, chainID, assistantSequence)`；candidate = source+1且 `assistant_chain_head` CAS source仍为 head |
| `recoveryOrdinal` | 只计 incomplete child：initial/new-user=0，recovery child=source+1，ordinary保持；unique key只作用 incomplete-child relation，不阻止同 ordinal ordinary continuation |
| max-step `M` | 当前 Legacy只有提示而无 hard admission，必须新增。合法 sequence `0..M-1`，candidate `<M`；M=1仅 initial、M=2最多一 successor；ordinary/recovery共用 budget，`MAX_STEPS_PROMPT`不能超额。配置规范化须细化；顺序为 plan/proposal→transaction重查→revision+三heads CAS→child/consumption→receipt release。exhausted不建 child/不release并以新 revision finalized `ManualStop(["same-process-max-step-exhausted"])`；写失败只保证当前进程 fail closed |
| recovery budget `N` | candidate ordinal=source+1且 `<=N`；N=0/1/2分别允许0/1/2 child，2仅建议；exhausted append `recovery-budget-exhausted`。N与M独立，任一失败均 cancel且 provider hits=0；无 global physical-request预算声明 |
| revision/supersession | first revision=0；reclassification append +1不覆盖；同 `(sessionID, sourceAssistantID, sourceVersionDigest)`最多一 active，new revision/consume/supersede经同 `recovery_head` predecessor CAS竞争。新 user lineage前先 finalize unresolved source为 `ManualStop(["superseded-by-new-user-input"])`，必要时 supersede automatic，commit后才新 chain `{recoveryOrdinal:0, assistantSequence:0}`；child先 consume则 steering/queue；CAS/persistence failure不release也不admit |
| crash | child dispatch evidence durable但无 settlement时，仅同进程且原 runner ownership活跃可 attach；restart/ownership loss为 ambiguous并关联唯一 child ManualStop，不可再次 consume/release/create same sequence。replay验证 revision、assistant、ledger无 branch/gap，不能从 public projection选分支 |

## 4. 正确性论证

以下是**实现并通过 §5 验收后**应成立的 obligations，不是当前生产保证；当前基线见顶部证据表与 §1.2。

| Obligation | 成立条件 |
|---|---|
| incomplete 不伪装成功 | typed terminal failure 留在原 attempt；成功只属于新 assistant；旧 error 不清除；adapter canonical incomplete 与 processor clean EOF 进入同一 typed failure |
| 不重放本地工具 | Legacy handshake 建立 complete-call durable-before-execute，否则 local fence unknown；SafeRetry 要求无 tool evidence且两类 replay fence 安全；Continue 仅把 settled call/result 当历史闭包，不重新排入执行；pending/running/interrupted 直接 ManualStop |
| 不从缺事件推导安全 | 自动 action 依赖 source 在 release 前 durable 的 `AttemptReplayFence` 与 candidate 的 exact no-send materialization；`providerExecuted=false/undefined` 或缺 part 不充分，缺字段投影 `executionKind:"unknown"`；任一 fence unknown 或 target/domain 不匹配均停止 |
| 不依赖未提交内存 | classifier 只读 transaction-consistent snapshot、planned materialization 与 admission；source fence 不从当前配置重算；proposal 绑定 next context、target/authority、semantic/prepared digest、source/control versions、N/M policy、closure 与 authorization；activation 才产生 record。stale request cancel并新 revision planning；SafeRetry 另要求 semantic digest equality |
| authority 不漂移 | public projections 仅 display；child 只引用 source/decision/revision/binding commitment，完整 proof 留在 consumed internal decision；任一 classification/publication/CAS/persistence failure cancel staged handle。storage unavailable 时只保证当前进程 fail closed，不承诺 ManualStop 一定 durable |
| interrupted 不冒充 settled | schema 保留 interruption/uncertainty provenance；任何该来源强制 ManualStop；Legacy cleanup 不得丢 provenance |
| 次数有界且无分叉 | chain/assistant/recovery/dispatch 四类 identity 各自连续唯一；`candidateRecoveryOrdinal <= N`（测 0/1/2，2 非默认合同）；`candidateAssistantSequence < M`，ordinary/recovery 共用 budget；exhaustion 写对应 reason并 cancel；三 heads CAS、unique keys与 consumption/binding 阻止并发 successor；无独立 physical-request budget |
| 模型上下文协议有效 | SafeRetry 排除整个 failed assistant；Continue 仅在 provider-specific settled-tool closure 可构造时成立，排除 partial prose/reasoning，只保留 provider-end provenance 与所需签名/加密 metadata；模型不兼容不复用。OpenAI Responses 必须区分 normalized `store:true` references 与 `store:false` exact typed stateless allowlist，后者须先证明无 item ID lowering |
| StructuredOutput 不泄漏 | attempt-local 值在新 assistant 前重置；旧值不能触发新 attempt 成功；成功只属于产生该值的 assistant |
| 明确不解决 | 任意 crash 后 provider exact-once、clustered/distributed Session ownership、无幂等/续传契约的 hosted-tool 自动恢复、global durable max-step、独立 global physical-request budget、通用 provider timeout/watchdog |

## 5. 测试方案

### 5.0 本轮已执行的当前态基线

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

以下 §5.1–§5.4 均为**实现后必须新增或扩展的 recovery 验收项**；§5.5 仅列建议验证命令。当前不存在的测试文件不得写成已执行。

### 5.1 Pure classifier 与 runtime gate 测试

测试必须按 action/ownership 分组，不能再用一列含义不明的 `safe` 同时代表 provider replay、local-tool replay、continuation proof 和 runtime lowering。

#### 5.1.1 SafeRetry classifier matrix

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

#### 5.1.2 ContinueAfterSettledTools classifier matrix

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

#### 5.1.3 ManualStop、revision 与 supersession matrix

| 类别 | 必测边界 |
|---|---|
| source consistency | non-durable marker、empty/multi/duplicate/gap ledger；source/terminal/dispatch/version/decision identity mismatch；opaque dispatch；fence/capability/target/domain 矛盾；child link 与 consumed decision action/revision/binding mismatch；old tool rows 缺字段投影 unknown |
| reason contract | 每个 phase-tagged unavailable cause exhaustive 一对一映射；closure subcause保留 typed diagnostic并映射 `continuation-context-unavailable`；single/multiple failures 固定排序、去重、non-empty fallback；input/tool/ledger 排序置换不改变结果 |
| revision/CAS | first revision 0，reclassification append +1；同 source version 最多一个 active；consume/supersede/new revision race 只有一个 predecessor CAS 成功 |
| supersession/admission | `superseded-by-new-user-input` commit 后才 admission 新 chain；child consumption 先赢则走 steering/queue；`N=0/1/2`、`M=1/2` 精确 admission；dispatchOrdinal/assistantSequence duplicate/gap/branch fail closed，ordinary continuation 保持 recoveryOrdinal 合法 |

#### 5.1.4 Runtime adapter/transport gate integration

这些不是 pure classifier tests，ownership 在 `packages/opencode`：

- `preparePausedRequest()` 完成时 provider hits 为 0；
- decision persistence、source reload、binding validation、CAS、child/ledger/consumption commit 的每个 failure injection 均调用 cancel，provider hits 为 0；
- commit 成功后一个 handle 只能 release 一次；double release/cancel-after-release 拒绝；
- process restart 后旧 handle 不可恢复，必须 prepare 新 handle并重新 revalidate/revise；
- authorization 后 middleware/provider/fetch mutation 必须被 exact digest/binding revalidation 捕获并零 release；
- classifier 只接收 typed planned result，不能通过 mock 让它自行证明 target/transport equivalence。

### 5.2 LLM schema / adapter / Legacy protocol-closure 测试

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

### 5.3 Legacy 集成与入口验收

| 入口 | provider incomplete | 验收边界 |
|---|---|---|
| normal prompt / `opencode run` | 是 | SafeRetry/Continue/ManualStop CLI + unprefixed Legacy HTTP |
| command | 进入 Legacy model 时是 | 至少一组 command incomplete E2E，不能只验 handler wiring |
| shell | 否 | recovery N/A；只验 SDK/route、transcript、side effect 一次及后续独立 prompt/command recovery 不重放 |
| ordinary continuation | 是 | 新 assistant identity、closure、工具不重放 |
| child/subtask | 是 | child transcript、父 task error/continuation、budget 与副作用不重放 |
| TUI prompt/command | 同对应 Legacy 入口 | production submission + backend recovery + sync/render；贯通全部边界后才称完整 E2E |
| TUI shell | 否 | production shell SDK + transcript/sync，不计 provider-incomplete E2E |

实现后 Legacy regression 必须覆盖以下分组，继续保留 Issue #3 fail-stop tests：

| 分组 | 必测场景与断言 |
|---|---|
| 基本 action | partial text/reasoning-only + safe fence 创建新 assistant，旧 assistant 保持 error；completed local tool 或 explicit tool error + incomplete 可 continuation且只执行一次；pending/running/interrupted、unknown hosted/provider fence、无 handshake 的 local-tools、opaque/dynamic provider均 ManualStop |
| dispatch 与 tool gate | 当前 `maxRetries=0`/`stepCountIs(1)`；outer retry 形成多 ledger 后 incomplete 为 `dispatch-ambiguous`（若依赖变化带来 inner retry/multi-step且 proof 只覆盖单 physical request则 fence unknown）；running part commit 后才 `item.execute()`，commit failure side effect=0；记录 assistant IDs、ledger、invocations 与 provider hits，不混同预算 |
| budget/state | `N=0/1/2` 产生原始 +0/1/2 recovery attempts；`M=1/2` 只允许 sequence `0` / `0,1`；ordinary continuation与 recovery 共用 M，exhaustion 不创建 child、不 release并 finalize exact reason；recovery 再 incomplete 继承 lineage/ordinal，ordinary continuation只递增 sequence |
| re-entry/supersession | active unconsumed decision才可 CAS consume；同进程 live runner可 attach；跨进程 nonterminal child、ownership loss、冲突 link/ordinal/sequence ambiguous；terminal child只观察。terminal 无 decision时重分类；新 input先 finalize `ManualStop(["superseded-by-new-user-input"])`，automatic revision被 supersede；child先 consume则 steering/queue；CAS failure不得 admission新 lineage |
| typed terminal与状态隔离 | empty、finish-only、multi-step incomplete由 `settleIncomplete()` 写 typed classification且排除于 generic retry；StructuredOutput旧值不晋升；reasoning forced flush不进入 closure；配置/tool registry变化仍读 source durable fence |
| digest/domain compatibility | plugin/tool schema/provider option/model/lowered history/body变化使 semantic digest不同并拒绝 SafeRetry；proof/fence/closure或授权后 exact request变化使 prepared/binding stale；endpoint/account/project/tenant/credential authority 任一变化都 domain mismatch；旧 tool row缺字段或 execution冲突投影 unknown |
| identity/crash | child relation、assistant sequence、decision consumption唯一且 immediate-successor；origin link与 consumed binding/actual authorization一致；crash 后只有 active-no-child 可消费，同进程 live可 attach，跨进程 nonterminal 或重复/缺口为 ambiguous |
| persistence failure injection | 覆盖 dispatch evidence、tool-call gate、settlement/provenance、terminal fact、reload、decision/finalization event、max-step、predecessor CAS、atomic child/message/ledger/consumption与 provider release gate；每点后续 provider hits=0，tool gate前 side effect=0。用新 reader确认 projector/relations/child/ledger/event/unique-key residue全部 rollback，re-entry仍不 dispatch；terminal/ManualStop commit failure只承诺当前进程停止 |
| transport proof | 默认 AI SDK transport必须共享 no-send final-body lowerer或 final-transform 后、fetch/`doStream` 前 exact gate；构造 `streamText()` 后 underlying fetch仍为0，matching receipt后才命中。golden不能授权。experimental native 是 Legacy alternate transport而非 Native V2；无 gate必须 fallback/disable，有 gate但 opaque则 incomplete ManualStop |
| provider closure | OpenAI normalized `store:true` reference与 `store:false` typed-stateless分支分测：transform 删除/保留 item ID、metadata、hosted reference、encrypted state；无-ID encrypted reasoning须先有 exact wire proof；hosted kind逐项 allowlist，unsupported zero release。proof/binding mismatch逐项覆盖 provider/route/protocol/endpoint/authority/model/family/proof kind/key/cursor/prefix aggregate/assistant/high-water/hash/ancestry，并按 mutation phase区分 inconsistent、proof-unavailable、binding-stale |
| exact reasons 与 TUI | cause/discriminator exhaustive mapping、多 failure去重/排序/non-empty；TUI 三层分别为 backend unprefixed endpoint recovery+idle、真实 transcript/event sync、Session renderer，以及 production Prompt normal prompt/command submission。shell只测 submission/transcript；ManualStop不建 child、不隐藏 error；只有 submission→endpoint→provider/events→renderer贯通才称产品 E2E |

### 5.4 CLI / TUI / child session 回归

| 层级 | 通过条件 |
|---|---|
| CLI/child | success 只来自 recovery assistant；旧 incomplete assistant 仍是 error；ManualStop 非成功；child/subtask 不因父层 retry 重放；budget exhausted 不挂起/循环 |
| TUI sync/render | 新增 recovery acceptance（当前不存在且本轮 22 tests 不能计入）：同步/展示 recovery child，保留旧 error，成功 child成为最终结果且 busy/idle/order正确，ManualStop不建 child |
| 产品声明 | backend transcript + TUI sync/render 只是两层 contract；另需 production Prompt submission route。仅当 submission、Legacy endpoint、provider incomplete、real events、renderer 全贯通才称完整 TUI E2E |

### 5.5 建议验证命令与 test ownership

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

Ownership 与 acceptance boundary（所有 `[future/new]` 文件创建前不得运行或计数）：

| Owner/test | 唯一职责 |
|---|---|
| schema `session-recovery.test.ts` | internal/public schemas、old-row decode、canonical source/control event/field sets |
| llm `recovery-canonicalizer.test.ts` | `semantic-replay-v1`、`prepared-request-v1`、`recovery-binding-v1` golden/mutation |
| core canonicalizer/persistence tests | `recovery-event-chain-v1`、source/control versions；raw-event authority、三 heads、rollback、constraints、composite projection、publication suppression、rebuilder |
| opencode classifier/runtime/coordinator/replay | pure action matrices与 exact reasons（不得 mock transport冒充 runtime proof）；final-transform gate、typed handles/receipt/release；revision/budget/supersession/crash；跨数据库等价 |
| opencode HTTP/continuation + existing tests | prompt_async/command actions；shell N/A boundary；ordinary/child与既有 shell side effect不重放；扩展 live generated-SDK round-trip和 real CLI action/visibility/budget |
| sdk/js | generated Legacy types/tests兼容；外部 consumer非产品场景但不得 wire break |
| TUI sync/render/submit | real transcript hydration；Session renderer；production Prompt normal prompt/command SDK，shell仅 submission/transcript；全链贯通才称产品 E2E |

`packages/schema` 当前只有 `typecheck` script，schema suite 必须显式 `(cd packages/schema && bun test)`。所有 `[future/new]` 文件创建前不得执行或计入通过数。targeted tests 通过后，再分别执行 `(cd packages/llm && bun run test)`、`(cd packages/core && bun run test)`、`(cd packages/opencode && bun run test)`、`(cd packages/tui && bun run test)`、`(cd packages/sdk/js && bun run test)`；migration artifacts 另执行 core `bun run migration --check`。始终不运行根目录 test。

### 5.6 代码更新与验收 ownership

| Owner | 实现与验收清单 |
|---|---|
| `packages/schema` | [ ] `src/llm.ts` 是 classification、target/domain、fence/proof、chain/link、terminal/decision、digest envelopes 的单一 wire source且不依赖 llm/opencode；[ ] `src/v1/session.ts` 组合 Legacy durable evidence/terminal/decision/consumption与 optional public `dispatchSummary`/`incompleteRecovery`，不复制 proof；[ ] tool execution/input/call/interruption与 reasoning provider-end/forced-flush provenance；old rows缺字段→unknown/ineligible；[ ] 四个 `RECOVERY_*_V1` canonical sets唯一来源及 membership/field/overlap/compatibility/hygiene tests |
| `packages/llm` | [ ] 从 schema import/re-export classification，不按 message猜测且 retryable正交；[ ] target/domain binder，authority/endpoint不稳定→unknown且不存 secret；[ ] 实现三个 versioned digest canonicalizers与 golden/mutation；[ ] allowlisted protocol adapter必须共享 audited final-body lowerer或 exact pre-release gate，golden不授权，未证明→opaque/ManualStop；[ ] Legacy adapter及 Anthropic/OpenAI closure/storage tests |
| `packages/core` | [ ] `session/sql.ts` raw-event-backed materializations与 `recovery_head`/`assistant_chain_head`/`dispatch_ledger_head`，生成 migration/schema；[ ] event-chain/source/control canonicalizer、`RecoveryTransitionProjector`、`RecoveryHeadsCommit`、explicit `RecoveryReplayRebuilder`，raw `EventTable` sole authority；[ ] canonicalizer/persistence/migration tests覆盖三 heads、rollback、composite child、publication suppression、replay/repair、existing-data、unique/cascade |
| Legacy `packages/opencode` transport | [ ] allowlisted declarative target/authority/storage adapter；dynamic/opaque fail closed；[ ] `preparePausedRequest → digests → durable authorization/CAS → release/cancel` typed gate，默认 AI SDK exact final-transform-before-fetch；experimental native Legacy无 gate则 fallback/disable、有 gate但 opaque则 incomplete ManualStop；[ ] failure injection证明 AI SDK/native stream均未调用；[ ] 每个 semantic dispatch前 ledger，outer retry第二 dispatch后只ManualStop或首 dispatch后禁用 resend |
| Legacy processor/tools/prompt | [ ] adapter与 `settleIncomplete()` 保留 typed classification，通用 retry不处理 incomplete；[ ] durable-before-execute handshake，running commit失败不执行；[ ] drain后写 tool/reasoning provenance、terminal fact、reload snapshot；[ ] 使用 internal-only durable publish seam，或在 `EventV2Bridge`/public publication 层 suppress/filter `session.recovery.*` authority payload，仅发布安全 projection/既有 signals；[ ] Prompt创建新 assistant、处理 pre-decision re-entry/finalization，reset attempt-local state；[ ] lineage/sequence/ledger/digests/proposal/record/binding/revision/authorization完整且 SafeRetry semantic digest equality；[ ] hard max-step admission与 entry guard；[ ] recovery-aware history、Anthropic/OpenAI store分支和 exact runtime closure proof |
| Wire/entrypoint | [ ] public error默认仍为 `UnknownError`，新 discriminator只经 versioned/breaking批准；optional projections需 OpenAPI/generated SDK/old-client compatibility；[ ] public Legacy sync/generated SDK/TUI events 与 Native V2/shared subscribers 不得泄漏 internal recovery event、ledger、proof、digest、decision link、CAS/sealed material；[ ] core验证 authority/CAS/rebuilder；opencode验证 runtime gate、coordinator、cross-db、prompt_async/command、continuation/child，shell N/A；[ ] existing live SDK与 CLI tests扩展；sdk/js正式 codegen后 typecheck/tests；TUI分别验证 sync/render/production submission，全链才称产品 E2E |
| 回归边界 | [ ] completed tool不重复；partial/StructuredOutput不误成功/泄漏；context-overflow、interrupt、permission decline、普通 provider error、model-switch metadata、same-process max-step不回归；[ ] digest检测 plugin/tool/options/history/authority/fence/proof/closure变化；decision/ordinal/crash不产生重复 child；[ ] 不声称 global durable max-step、独立 physical-request budget或任意 crash exact-once；[ ] 所有 `[future/new]` 创建前不得运行/计入 current 50 |

## 6. 文档与实施前决策

### 6.1 文档检查

| 项目 | 要求 |
|---|---|
| 本文与旧架构 | [ ] 当前唯一 Issue #7 proposal authority 为本文；旧 `docs/design/session-recovery/architecture.md` 虽仍保留历史标题/内容，但明确无实施授权；[ ] 生产实现前单独 rewrite/supersede 其旧 lifecycle/source-version/binding/`AttemptRecoveryEvidence`/Native V2 scope/module-interface 并重新架构审查；旧稿本轮不修改 |
| contract 与测试文档 | [ ] shared LLM/schema变化时更新 Legacy API/schema；[ ] 区分根 `bun run test` 与 package targeted tests |
| 完成记录 | [ ] 实现后新增 workflow 要求且含度量的 devlog；[ ] 非显然限制回写项目规范；[ ] Bun 1.3.14环境记录全部 Legacy typecheck/test与 pass/fail，并与本轮基线分开 |

### 6.2 仍需确认的架构决策

| 决策 | 已固定边界与待确认项 |
|---|---|
| replay fence/target/digests | 首批 allowlisted adapter；dynamic/middleware/fetch rewrite无法进 gate→unknown。provider capability/domain由adapter、local capability由runtime提供并 dispatch前持久化；automatic要求唯一 semantic dispatch，inner retry/multi-step未被幂等 fence覆盖则unknown。domain含 provider/route/protocol/endpoint/authority/model；SafeRetry semantic digest相等，prepared digest绑定 fence/proof/closure，Continue用 source+closure transform；待选首批 adapters |
| durable-before-execute与outer retry | 决定 processor begin/start tool API；不实施则提供本地工具时不得 automatic。并选择首次 dispatch 后禁用 outer resend，或逐 dispatch ledger且只有一次时 automatic |
| persistence/consumption | raw `EventTable` operations sole authority；relations/projections rebuildable；三 heads derived CAS；operation+nextStateDigest，handle不持久化；projector/heads/rebuilder及 replay suppression；固定 canonical sets API。旧架构须先 supersede/re-review |
| reasoning与closure | Legacy part表达 provider-end/step-boundary/cleanup；仅 provider-end默认可进入 closure。validator/digest必须共享 actual no-send lowerer或 exact pre-release capture；golden不证明 runtime；分类前得出 constructible/unavailable，授权后 rewrite则 fail closed |
| budgets | `candidateRecoveryOrdinal <= N`，测 `N=0/1/2`，2仅建议；确认配置入口/default/compatibility。max-step合法 sequence `0..M-1`、candidate `<M`，ordinary/recovery共用，确认规范化入口与 `MAX_STEPS_PROMPT` 集成 |
| wire/UI/ownership | optional projections，完整 ledger不进 message；public terminal仍 `UnknownError`，新 discriminator需 versioned/breaking批准；旧 error保留，TUI必须证明 child sync/render与 final state但无需新折叠样式；确认 schema是 wire source、llm仅实现 binder/validator/digest、Legacy组合消费，禁止复制 types |

在其余架构决策确认、设计细化并通过审查前，不应开始生产代码实现。
