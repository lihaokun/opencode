# 函数级细化 — sessrec-3 Legacy Runtime Recovery

> 状态：M2/M3/M5/M6函数级详细设计；fresh independent design audit已达到`0 P0 / 0 P1`，等待用户批准；生产实现、tests、Step 0 expectations、Step 5 implementation audit 与 devlog 均未开始。
>
> 权威输入：当前 [`../architecture.md`](../architecture.md)、`../detailed-design.md`与owner子计划集合。本文直接采用M1与M4当前owner-qualified exports；若owner contracts冲突，必须停止实现并修正文档，不在runtime中静默降级。
>
> 证据边界：本文读取当前仓库源码与 pinned dependencies，只形成`[S — source seam only]`结论；未查看上游。所有 future tests 均标记为 `[F — planned; not created; not run]`。

## 1. 范围、非范围与模块映射

### 1.1 本子计划拥有的模块

本文给出 M2/M3/M5/M6 可直接编码的函数级设计：

| 模块 | 本文 ownership | 主要未来落点 |
|---|---|---|
| M2 Legacy Dispatch Preparation and Transport Gate | M2-owned provider runtime provenance producer、stable no-send prepared-handle commitment reservation、available/opaque handle、AI SDK provider-specific fetch gate、native single-compile gate、M4 K7–K10 lease handoff、linear authorize/release/mechanical-cancel/cleanup、subsequent dispatch ledger handshake、AI SDK/native hidden retries=0 | `packages/opencode/src/provider/provider.ts`（`resolveSDK`/`getLanguage` provenance producer与controlled fetch安装）、`packages/opencode/src/session/llm.ts`、`session/llm/{ai-sdk,native-request,native-runtime,request}.ts`、新建的 session recovery runtime 文件；`packages/llm/src/route/{client,executor,transport/*}.ts` |
| M3 Legacy Execution Evidence and Terminal Settlement | `LegacyToolExecutionGate`、before-hook 前 durable raw invocation、hook rewrite/final plan revision、AI-SDK/native及preplanned-subtask execution adapters、tool/reasoning settlement、M4 O3a append-only restart reconciliation、typed terminal、drain、reload | `packages/opencode/src/session/{tools,processor,prompt}.ts`、preplanned subtask bridge与 session recovery runtime 文件 |
| M5 Pure Candidate Selector and Classifier | 只对 M4 `DurableRecoveryAuthorityViewV1`及其nominal `AutomaticRecoveryProofSliceV1`、M1 exact lower-level `RecoveryFailureCause` 做 pure candidate selection/classification；不拥有 reason mapping、dedup、fallback、order或snapshot structural proof | session recovery planner/classifier 文件 |
| M6 Legacy Recovery Runtime Orchestration and Admission Lifecycle | authoritative recovery-policy epoch、N/M、candidate preallocation、initial/ordinary atomic admission、automatic consumed composite、ManualStop、supersession、operationID response loss、M4 sealed-use lease lifecycle、所有committed model assistant的settlement/re-entry、attempt-local reset、internal serialized submission与`CoordinatorResult` handoff | `packages/opencode/src/session/{run-state,retry}.ts`、`session/recovery/{runtime,admission,reentry}*.ts`及`prompt.ts`中的internal serialized-runtime seam；不拥有public prompt/command/prompt_async/shell wrapper或其返回/UX语义 |

### 1.2 只引用、不复制的 sibling contracts

本文不重新定义跨模块共享字段：

- **M1 contract**：[`sessrec-1-contract-canonicalization.md`](./sessrec-1-contract-canonicalization.md) 拥有 identity、target/domain、storage mode、terminal、snapshot、planned materialization、proposal/record/receipt、24 reasons、三类 digest 与 canonical encoding。
- **M4 contract**：[`sessrec-2-durable-authority.md`](./sessrec-2-durable-authority.md) 拥有 raw transition、operationID replay、transactions、three heads、dispatch/tool/reasoning/decision materialization、snapshot reload、sealed store 与 internal publication suppression。
- **M7 contract**：[`sessrec-4-legacy-lowering-public-contract.md`](./sessrec-4-legacy-lowering-public-contract.md) 的 M7 部分拥有 SafeRetry history lowering、Continue closure、Anthropic/OpenAI grammar、three-prefix validation 与 final lowered representation。
- **M8 contract**：同一 sibling 文档的 M8 部分唯一拥有 public `prompt`、`command`、`prompt_async`、`shell` wrappers、HTTP/SDK/CLI/TUI返回与UX投影。本文只定义这些wrapper调用的M6 internal serialized submission与`CoordinatorResult`，不重复public签名或return mapping。

本文签名中的 `M1.*`、`M4.*`、`M7.*`、`M8.*` 是对这些唯一 owner 的引用，不表示在本文件复制一套 schema。

### 1.3 非范围

- 不设计 M1 schema 字段、M4 SQL/migration/projector 细节或 M7 provider closure grammar。
- 不改变 public error discriminator、OpenAPI/generated SDK/TUI/CLI wire；这些由 M8 拥有。
- 不新增 Native V2 recovery。
- 不承诺 release 后 provider exactly-once。
- 不重构通用 timeout/watchdog、compaction、permission、context overflow 或 generic retry policy。
- shell provider recovery 为 N/A；shell synthetic assistant 不分配 model assistant identity、不推进 model chain、不消耗 M。

## 2. 当前源码接缝与必须消除的缺口

| 当前源码 | 可复用接缝 | 当前缺口与 future 处理 |
|---|---|---|
| `packages/opencode/src/session/llm/request.ts::prepare` | 已集中完成 system/plugin params/headers/tool filtering | 仍是 high-level preparation；不能证明 final endpoint/body/authority。M2 在其后增加 runtime-specific gate。 |
| `packages/opencode/src/session/llm.ts::run/streamBatches` | runtime selection、`streamText`、native adapter、outer stream scope | 当前 assistant 已在 `prompt.ts` 先持久化，且 `streamText` 直接进入 provider。改为接收authorized dispatch、explicit attempt settlement destination，并由M2返回paused handle；不引入dispatch controller callback。 |
| pinned `ai@6.0.168` `wrap-language-model.ts` | `transformParams` 先于 wrapped model `doStream` | generic middleware 仍早于 provider `getArgs`/final body transform；不能据此声明 available。 |
| pinned `@ai-sdk/anthropic@3.0.82` | `doStream` 在 `getArgs`、`transformRequestBody`、URL/header 构造后调用 configured `fetch` | 只有受控、provider-specific fetch middleware在此处暂停并验证 descriptor 时可 available。 |
| pinned `@ai-sdk/openai@3.0.84` Responses | `doStream` 在 `getArgs`、`/responses` URL 与 final body 构造后调用 configured `fetch` | 同上；必须从 final body归一化 storage，不能从 high-level options猜测。 |
| `packages/opencode/src/provider/provider.ts::resolveSDK` | 所有 bundled provider 都被注入一个 opencode-owned fetch wrapper | wrapper 目前只做 timeout/SSE；future 可插入 gate。但存在 custom fetch、dynamic package/model loader 或未审计 middleware 时 evidence 必须 opaque。 |
| `packages/llm/src/route/client.ts::compile` | 已把 common request 单次转换为 validated body + transport-private prepared object，且不发送 | 当前 `prepare` 丢弃 private prepared，`stream` 再 compile。future 暴露 internal paused compile result并复用同一 object release。 |
| `packages/llm/src/route/transport/http.ts` | `prepare` 生成 exact `HttpClientRequest`；`frames` 才执行 | native HTTP JSON 可 available；WebSocket `open/sendText` 首批 opaque。 |
| `packages/llm/src/route/executor.ts` | HTTP execute/status mapping与既有内部retry plumbing集中 | gated native transport固定 internal retries=0；是否generic outer retry只消费`SessionRetry.policy`结果，不在native层复制status predicate；每次accepted re-entry创建new ordinal。 |
| `packages/opencode/src/session/tools.ts::resolve` | registry、MCP、workflow 最终都归一为 AI SDK `Tool.execute` | 当前 before hook与body都可能在 durable call 前执行。所有 executable wrapper必须统一经过 M3 gate。 |
| `packages/opencode/src/session/prompt.ts::createStructuredOutputTool` | structured output是一个明确的最终 tool wrapper | 当前绕过 `SessionTools.resolve`，且 `structured` 跨 loop iteration。future 也要 wrap，并把 capture放入 attempt-local state。 |
| `packages/opencode/src/session/processor.ts` | 单线程消费 batch、tool tracking、cleanup、outer retry、clean EOF detection | 当前 canonical incomplete被转成普通 Error；terminal缺 internal typed fact/snapshot reload；cleanup只等待250ms后强制error。future 按 M3 drain合同重构。 |
| `packages/opencode/src/session/prompt.ts::runLoop` | model loop、ordinary continuation、compaction、subtask、max-step prompt | 当前先写assistant再prepare；`step`混合非model branches；`structured`跨attempt。future由M6统一admission并只计model assistants。 |
| `packages/opencode/src/session/run-state.ts` 与 `effect/runner.ts` | 同session单runner、同步caller attach、shell serialization | 当前第二个 prompt先写user再attach旧run，不能机械实现supersession。future增加typed input submission/recovery ownership接口。 |
| session HTTP handlers | prompt/command同步等待，prompt_async fork后204 | public shape可保留；内部改为等待/后台运行完整automatic chain。 |

## 3. 固定实施选择

1. `experimental.session_recovery.max_incomplete_recoveries`：默认 `2`，合法值为非负 safe integer；非法类型、负数、浮点、非-safe integer由 config codec拒绝。
2. `experimental.session_recovery.max_model_assistants`：默认 `64`，合法值为正 safe integer；只有M1 policy normalization在构造`M1.NormalizedRecoveryPolicy`时计算一次`effectiveMaxModelAssistants = min(configuredMaxModelAssistants, agentSteps)`（`agentSteps` absent时等于configured值）。runtime、plugin、M6 admission与M4 first-apply此后只读取已提交的`normalizedPolicy.digestInput.effectiveMaxModelAssistants`；禁止再次读取config/`agent.steps`、再次取`min`、clamp或重算。任何输入中的非法`agent.steps`由M1 codec在commit policy前拒绝。
3. N 只计 incomplete-triggered child；M 只计 model assistant admission。ordinary continuation计 M 不计 N；semantic dispatch/model step/physical request均不计 N/M；shell不计 M。
4. M2在`packages/opencode/src/provider/provider.ts::resolveSDK/getLanguage`选择SDK、factory、model loader、fetch与middleware时生成不可变`ProviderRuntimeProvenance`并随resolved language model返回/缓存；只有该producer明确证明bundled factory、exact package/version、opencode-owned controlled fetch、audited model loader及无未审计semantic rewrite时，descriptor resolver才可返回available。producer任一字段缺失、cache provenance不匹配或来源不可证明时结果必须opaque；M2不得在`session/llm`侧根据provider/model名字重建provenance。
5. built-in AI SDK Anthropic Messages/OpenAI Responses仅在 audited provenance + provider-specific `doStream` transport gate能证明 exact target/authority/storage，且暂停发生在全部final transform之后、底层provider transport delegate（当前pinned provider中的configured fetch调用）之前时available。generic `wrapLanguageModel.transformParams`/`wrapStream`不构成final proof。
6. AI SDK custom fetch、dynamic provider factory/model loader、未知 middleware/fetch rewrite、可能执行remote credential refresh/telemetry的factory均opaque。opaque initial/ordinary可按兼容路径发；其 incomplete固定ManualStop。recovery origin遇到opaque直接typed unavailable。
7. native HTTP JSON复用单次compile的private prepared object可available；WebSocket、dynamic/custom transport首批opaque。
8. generic outer retry的唯一判定权是现有`SessionRetry.policy(...)`返回的Schedule decision；本文不新增或复制5xx、status-text、rate-limit-text等predicate。既有covered 429/503行为保持；canonical incomplete以typed guard排除。每个被policy接受的retry都先关闭旧invocation，再fresh调用`streamText`/native execution，并建立new operationID、next semantic dispatch ordinal、fresh per-dispatch settlement object、fresh runtime、fresh handle/slot与独立ledger。最终incomplete若存在多个plausible dispatch，事实生产者只产`{source:"dispatch",kind:"multiple-plausible-attempts"}`，由M1 F23映射为`dispatch-ambiguous`。
9. AI SDK显式`maxRetries=0`，native gated executor与所有audited provider descriptor的hidden/native retry count均为0。一个AI SDK fresh invocation只允许一个controlled-fetch arrival；unexpected second fetch必须在调用downstream前失败，绝不在同一ordinal旋转/复用slot。
10. initial/ordinary：先preallocate无authority candidate，prepare paused available/opaque handle，再由M4单一composite原子写assistant、M admission、ordinal-0 ledger、两个相关recovery heads（assistant chain与dispatch ledger）及aggregate event head/cursor。prepare失败无assistant；commit失败全回滚。
11. automatic：decision + child + ordinal-0 ledger + consumption + three recovery heads（recovery、assistant chain、dispatch ledger）plus aggregate event head/cursor在M4单一composite内提交，record提交后直接consumed。
12. caller在首次commit前生成stable operationID；response loss只按M4 exact replay/post-state合同处理。
13. restart不恢复旧内存handle、旧AI SDK slot、旧native prepared object、旧lease proof或旧unsealed bytes；只有同进程、same exact handle、never-released、same live M4 lease set且complete result可查时才允许一次release。所有committed initial/ordinary/recovery assistants共用generic settlement/re-entry；nonterminal predecessor未被attach或durable settle前禁止创建successor。restart观察到tool latest phase为`planned|body-outcome-durable|unknown-intermediate`时只调用M4 O3a追加`reconciled-terminal-manual-only`，body/after-hook/provider hit恒为0；terminal barrier可闭合但automatic永久禁止。
14. recovery-policy authority使用SQLite中与M4 first-apply transaction同事务可读的monotonic epoch + canonical policy digest。runtime config只有在policy row提交后才生效。每一个尚未commit的initial、ordinary或automatic admission都必须在自身planning开始时读取并冻结当时current committed `M6.RecoveryPolicyAuthoritySnapshot`，把M1完整historical policy binding带入operation；M4 operations 1/2/9的first apply都在transaction内exact比较scope/epoch/policyDigest/defaultSemanticsVersion，并只从tx verifier返回的current committed `M1.NormalizedRecoveryPolicy.digestInput.effectiveMaxModelAssistants`取得`effectiveM`后结合same-tx fold重算M admission（automatic另重算N）；不得从configured M、runtime `agent.steps`或caller snapshot再次取min。committed policy变化使所有尚未提交的candidate stale，包括existing chain的ordinary candidate；必须reload current policy authority与对应origin authority input；automatic必须重新加载fresh `M4.DurableRecoveryAuthorityViewV1`并重新selection/closure/reservation/K7/lowering/prepare，不能沿用旧proof slice、lease、handle或chain早先冻结值。exact existing operation/result先于current-policy检查并按stored historical binding replay，之后policy变化永不撤销已commit result/assistant/child。

### 3.1 统一错误传播、fatal stop 与transport-hit术语

#### 3.1.1 Consolidated private error union

本文函数不得裸抛未知异常越过M2/M3/M5/M6边界；外部异常在最近owner边界穷尽映射为：

```ts
type M7LoweringError = Readonly<{ tag: "m7-lowering"; cause: M1.RecoveryFailureCause }>

type LegacyRecoveryRuntimeError =
  | M2PrepareError
  | DispatchAuthorizationError
  | DispatchReleaseError
  | DispatchAbandonment
  | ToolExecutionGateError
  | TerminalSettlementError
  | PolicyAuthorityError
  | AdmissionError
  | ReentryError
  | M1.RecoveryContractError
  | M4.RecoveryAuthorityErrorV1
  | M7LoweringError

export type FatalRecoveryStop = Readonly<{
  tag: "fatal-recovery-stop"
  cause: LegacyRecoveryRuntimeError | unknown
  handleDisposition: "none" | "mechanically-cancelled-unsendable" | "released-or-unknown"
}>
```

`M6.FatalRecoveryStop`是M6向M8导出的internal runtime failure value，不是public schema：`cause`可含runtime-private error/unknown对象，只能交M8 exact fatal sanitizer做closed classification，禁止serialize、spread、`String`/`Cause.pretty`、日志raw dump或写入public event/wire；`handleDisposition`只驱动internal cleanup/reconciliation，不得进入public payload。M4 failures原样保留owner `M4.RecoveryAuthorityErrorV1`的kind-indexed `kind/reason/context` correlation；M6不得复制开放reason union、cast不匹配kind/reason或把typed corruption/persistence branch降级为missing/success。

传播顺序固定：

1. M2 introspection/lowering/provenance失败：initial/ordinary映射opaque cause或typed preparation failure；recovery映射`M1.PlannedRecoveryMaterializationDescriptor(status:"unavailable")`，不能裸throw给M5。
2. pre-release commit/authorization失败：先机械cancel，使handle unsendable；若assistant尚未admit则返回typed admission failure，若已admit则M3 durable settle为pre-dispatch abandonment；持久化失败转`FatalRecoveryStop`。
3. release边界失败：exclusive latch内local validation/synchronous pre-call可证未越过delegate→退出latch、mechanical cancel、automatic K9/cleanup后known-no-send abandonment；delegate boundary状态unknown→terminal `released/unknown-delivery`、K9/cleanup后`FatalRecoveryStop(handleDisposition:"released-or-unknown")`，禁止cancel/retry same handle/ordinal或resend。
4. tool/reasoning/terminal authority失败：停止当前processor和current process ownership，不进入classifier/recovery；不得把failure降级成public-only error。
5. M5只接收typed values并永不throw业务错误；unexpected exhaustive hole唯一映射`internal-classification-failure`。
6. ManualStop：无K7时也固定`mechanical cancel/no-handle barrier -> resource cleanup并保留secret-free one-shot manual-stop tombstone -> A5/S2/classification -> M4 commit -> complete result后tombstone invalidation`；若automatic已取得K7，则在cleanup前追加`K9 close/zeroize`，其余顺序相同。K9失败在cleanup/lookup/commit前fatal；commit失败返回`FatalRecoveryStop(handleDisposition:"mechanically-cancelled-unsendable")`并停止当前进程，不恢复resource、不重prepare或复用tombstone提交不同operation。
7. cleanup defect只记脱敏diagnostic，不改变已确定的安全结果；released/unknown-send资源cleanup不声称撤销provider side effect。

#### 3.1.2 Exact audited-provider-transport-hit language

本文的零发送主张只指 **`auditedProviderTransportHitCount === 0`**：AI SDK路径尚未调用controlled wrapper保存的downstream configured/base fetch；native路径尚未调用`streamPrepared`/HTTP `executeOnce`；WebSocket路径尚未`open/sendText`。它不等价于“系统没有任何I/O/网络/副作用”。

pre-release允许且必须枚举的动作仅有：read-only config/provider registry/model metadata读取；audited bundled module/factory/model-loader的本地构造；M7 pure lowering；canonical digest/crypto；in-memory fiber/Deferred/AbortController分配；M4 scoped sealed material read/unseal；native本地auth header/encoding/compile；以及M6/M4明确列出的SQLite authority transaction。M2本身除sealed read外不写authority。

pre-release明确禁止：downstream provider fetch/native frames/HTTP execute/WebSocket open或send；DNS/socket/proxy连接；remote credential refresh/discovery；provider telemetry/health check；custom/dynamic package install或import时的不可审计副作用；plugin/tool before/after hook、permission、MCP、shell/process/filesystem mutation；public event/HTTP/SSE publication；隐藏retry/resend。若`resolveSDK/getLanguage` producer不能证明factory/loader/fetch链不触发这些禁止动作，provenance为unavailable，initial/ordinary只能opaque，recovery不可发送。

## 4. 本模块私有 runtime 数据结构

### 4.0 类型归属、external aliases 与support unions

本文不建立任何M1/M4/M7 receipt、policy、projection、authority或lowering structural alias。签名直接使用owner-qualified exact exports：

- candidate/committed identity与context：`M1.CandidateAssistantAttemptIdentity`、`M1.CommittedAssistantAttemptIdentity`、`M1.CandidateDispatchAttemptContext`、`M1.CommittedDispatchAttemptContext`；
- pre-commit dispatch material：`M1.DispatchAdmissionV1`；automatic planning material直接使用M1 fixed nested `M1.PlannedRecoveryMaterialization<M2.AvailableDispatchHandle>`：available exact为`{descriptor: Extract<M1.PlannedRecoveryMaterializationDescriptor,{status:"available"}>, pausedHandle:M2.AvailableDispatchHandle}`，unavailable exact为`{descriptor: Extract<M1.PlannedRecoveryMaterializationDescriptor,{status:"unavailable"}>}`且无handle；committed evidence为`M1.DispatchEvidence`。禁止把`pausedHandle` structural spread/add到descriptor、把descriptor rebrand/alias，或把三者互换；
- receipts/results：assistant available/opaque分别使用`Extract<M1.AuthorityReceiptV1,{receiptKind:"assistant-admission";evidenceKind:"available"}>` / `Extract<M1.AuthorityReceiptV1,{receiptKind:"assistant-admission";evidenceKind:"opaque"}>`；subsequent available/opaque分别使用`Extract<M1.ReceiptForV1<"subsequent-dispatch-recorded">,{evidenceKind:"available"}>` / `Extract<M1.ReceiptForV1<"subsequent-dispatch-recorded">,{evidenceKind:"opaque"}>`；source fact使用`Extract<M1.AuthorityReceiptV1,{receiptKind:"source-fact"}>`或对应exact `M1.ReceiptForV1<T>`；decision finalized与source superseded分别使用`M1.ReceiptForV1<"decision-finalized">` / `M1.ReceiptForV1<"source-superseded">`；automatic直接使用`M1.AutomaticRecoveryAdmissionReceiptV1`。总surface为`M1.AuthorityReceiptV1`、`M1.ReceiptForV1<T>`与`M1.OperationCommitResultV1<T>`，apply mode只通过`M1.OperationCommitResultV1<T>["applyMode"]`取得；M4只构造/返回，不拥有替代receipt schema；
- policy/authority：`M1.NormalizedRecoveryPolicy`、`M1.RecoveryAdmissionPolicyBindingV1`、`M1.AdmissionPlan`以及§4.9 exact M6 exports `M6.RecoveryPolicyScopeKey`、`M6.RecoveryPolicyAuthoritySnapshot`、`M6.RecoveryPolicyAuthorityExpectation`、`M6.RecoveryPolicyAuthorityError`；scope key/expectation分别exact alias M1 owner types，snapshot/error只由M6 §4.9声明一次，M4 §3.6只消费而不复制；
- recovery authority/lowering：M5直接消费`M4.DurableRecoveryAuthorityViewV1`；automatic selection必须携带owner-produced nominal `M4.AutomaticRecoveryProofSliceV1`。M7 pre-lease closure直接使用M1 exact `M1.RecoveryClosureDescriptor`，post-K7 lowering唯一输出仍为`M7.LoweredRecoveryCandidate`；M7不得接收裸`M1.DurableRecoverySnapshot`、M4 private fold、manual-only branch或本地structural proof duplicate；
- M2 handle reservation/lease/proof：本文actual-export `M2.PreparedHandleCommitmentReservationV1`及其reserve/validate/close callables；single consume是M2 registry中由actual AI SDK slot安装或native paused compilation创建执行的原子状态转换，不是另一个跨模块schema。handle proof exports为`M2.PreparedHandleLeaseIDV1`、`M2.PreparedUnreleasedHandleProofV1`、`M2.NoPreparedHandleProofV1`、`M2.MechanicallyCancelledUnreleasedHandleProofV1`、`M2.ReleaseCallableProofV1`、`M2.DelegatedReleaseProofV1`、`M2.UnknownDeliveryReleaseProofV1`、`M2.ReleasedUnknownDelivery`、`M2.AutomaticPreReleaseCancellationV1`、`M2.HandleProofValidationErrorV1`与exact `proveNoPreparedHandleV1`/`validate*ProofV1`。reservation不是provider prepare、runtime handle或M4 lease；actual AI SDK slot/native compilation/paused handle必须消费same reservation且逐字段匹配；M4只能调用M2 validators，不复制fields/brand；
- M4 terminal/admission/re-entry/sealed-use authority：`M4.DurableRecoveryAuthorityViewV1`、`M4.AutomaticRecoveryProofSliceV1`、`M4.RecoverySnapshotIdentityV1`、`M4.SealedRecoveryUseLeaseV1`、`M4.SealedRecoveryUseReleaseValidationV1`与K7–K10 exact callables；`M4.InitialAdmissionAuthorityViewV1<P>`、`M4.OrdinaryAdmissionAuthorityViewV1<P>`、`M4.CommittedAssistantAuthorityViewV1<K>`/`M4.loadCommittedAssistantAuthorityView<K>(...)`。M6不定义local authority/lease record。terminal `M1.DurableRecoverySnapshot`只作为`M4.DurableRecoveryAuthorityViewV1.snapshot`的完整payload被M5/M6读取；M7 automatic path只消费selected nominal proof slice，且该view不用于initial/ordinary或generic nonterminal re-entry/lost-handle settlement；
- public projection/result：只引用M1/M8 owner docs，不在本文定义结构等价副本。

若implementation export名与上述latest owner contract不一致，先修owner export/引用；禁止以local alias保留旧名。

Tool/reasoning consumers必须直接采用SESSREC-2最终选定的M1↔M4 mapping：`M4.commitToolEvidence`仅接受/返回`M1.RecoveryOperationInputV1<"tool-evidence-recorded">` / `M1.OperationCommitResultV1<"tool-evidence-recorded">`，其receipt由M1 `ReceiptForV1<"tool-evidence-recorded">`决定；`M4.commitReasoningEvidence`同理只使用`"reasoning-evidence-recorded"` owner mapping。S3不得定义本地operation/fact-kind enum、近义literal或手写operation→receipt table；所有校验通过M1 exact indexed types与M4 owner callable result完成。

本文私有support types定义如下：

```ts
type DispatchOrigin = "initial" | "ordinary" | "automatic-recovery" | "outer-retry"
type SubsequentOrigin = "outer-retry" | "unexpected-step"

type DispatchAdapterDecision =
  | { tag: "ai-sdk-available"; descriptor: AuditedAISDKDescriptor; provenance: ProviderRuntimeProvenance }
  | { tag: "native-available"; transportID: "http-json"; provenance: ProviderRuntimeProvenance }
  | { tag: "opaque"; cause: M1.RecoveryFailureCause; provenance?: ProviderRuntimeProvenance }
  | { tag: "disabled"; cause: M1.RecoveryFailureCause }

export type M2InspectionResult =
  | { tag: "available"; admission: Extract<M1.DispatchAdmissionV1, { kind: "available" }>; frozenRequest: FinalFetchInput }
  | { tag: "unavailable"; cause: M1.RecoveryFailureCause }

export type PreparedHandleCommitmentReservationV1 = Readonly<{
  reservationVersion: 1
  owner: "M2"
  reservationID: string
  candidateContext: M1.CandidateDispatchAttemptContext
  operationID: M1.RecoveryOperationID
  action: M1.AutomaticRecoveryAction
  target: M1.DispatchTarget
  targetDigest: M1.DispatchTargetDigest
  preparedBodyVersion: M1.SafePositiveInt
  gateKind: "ai-sdk-controlled-fetch" | "native-http-json"
  gateReservationID: string
  handleGenerationID: string
  pausedHandleCommitment: M1.PausedHandleCommitment
  state: "reserved-no-send"
  providerPreparationCount: 0
  auditedProviderTransportHitCount: 0
}> & Brand<"M2PreparedHandleCommitmentReservationV1">

export type PreparedHandleReservationValidationErrorV1 = Readonly<{
  tag: "m2-prepared-handle-reservation-validation"
  cause:
    | "version" | "owner" | "state" | "candidate" | "operation" | "action"
    | "target" | "gate" | "generation" | "commitment" | "already-consumed" | "closed"
}>

export type M2PrepareError = Readonly<{ tag: "m2-prepare"; cause: M1.RecoveryFailureCause; phase: string }>
export type DispatchAuthorizationError = Readonly<{ tag: "dispatch-authorization"; cause: "state" | "result-kind" | "binding-mismatch" }>
export type MechanicalCancelError =
  | Readonly<{ tag: "already-released"; delivery: "delegated" | "unknown-delivery" }>
  | Readonly<{ tag: "release-in-progress"; latchID: string }>
export type DispatchReleaseError =
  | Readonly<{
      tag: "dispatch-release"
      sendState: "known-not-delegated"
      terminalState: "cancelled"
      transition: "authorized-held-not-delegated->authorized-open->cancelled"
      cause: unknown
    }>
  | Readonly<{
      tag: "dispatch-release"
      sendState: "delegated"
      terminalState: "released-delegated"
      transition: "authorized-held-not-delegated->released-delegated"
      releaseProof: M2.DelegatedReleaseProofV1
      cause: unknown
    }>
  | Readonly<{
      tag: "dispatch-release"
      sendState: "unknown"
      terminalState: "released-unknown-delivery"
      transition: "authorized-held-not-delegated->released-unknown-delivery"
      ambiguity: M2.ReleasedUnknownDelivery
      cause: unknown
    }>
type DispatchAbandonment = Readonly<{ tag: "dispatch-abandonment"; sendState: "known-not-delegated" | "unknown"; cause: M1.RecoveryFailureCause }>
type DispatchAuthorizingOperationType =
  | "initial-chain-genesis-and-dispatch"
  | "ordinary-assistant-and-dispatch-admitted"
  | "subsequent-dispatch-recorded"
  | "automatic-child-admitted-and-consumed"
type NonAutomaticDispatchAuthorizingOperationType = Exclude<
  DispatchAuthorizingOperationType,
  "automatic-child-admitted-and-consumed"
>
type DispatchAuthorizationInput =
  | Readonly<{
      kind:"initial-ordinary-or-subsequent"
      handle:LinearDispatchHandle
      result:M1.OperationCommitResultV1<NonAutomaticDispatchAuthorizingOperationType>
    }>
  | Readonly<{
      kind:"automatic-recovery"
      handle:M2.AvailableDispatchHandle
      reservation:M2.PreparedHandleCommitmentReservationV1
      result:M1.OperationCommitResultV1<"automatic-child-admitted-and-consumed">
      proposal:Extract<M1.RecoveryProposal,{kind:"automatic"}>
      planned:Extract<
        M1.PlannedRecoveryMaterialization<M2.AvailableDispatchHandle>,
        {descriptor:{status:"available"}}
      >
      sealedUseLeases:readonly M4.SealedRecoveryUseLeaseV1[]
      releaseValidation:M4.SealedRecoveryUseReleaseValidationV1
    }>
export type ReleaseCallableProofV1 = Readonly<{
  proofVersion: 1
  owner: "M2"
  leaseID: M2.PreparedHandleLeaseIDV1
  candidateContext: M1.CandidateDispatchAttemptContext
  handleGenerationID: string
  pausedHandleCommitment: M1.PausedHandleCommitment
  receiptCommitment: string
  state: "authorized"
  releaseLatch: "open"
}> & Brand<"M2ReleaseCallableProofV1">

type AuthorizedDispatch = Readonly<{
  handle: LinearDispatchHandle
  result: M1.OperationCommitResultV1<DispatchAuthorizingOperationType>
  releaseCallableProof: M2.ReleaseCallableProofV1
  automaticLeaseClosure?: Readonly<{
    leases: readonly M4.SealedRecoveryUseLeaseV1[]
    releaseValidation: M4.SealedRecoveryUseReleaseValidationV1
    reservation: M2.PreparedHandleCommitmentReservationV1
  }>
}>
export type DelegatedReleaseProofV1 = Readonly<{
  proofVersion: 1
  owner: "M2"
  latchID: string
  leaseID: M2.PreparedHandleLeaseIDV1
  candidateContext: M1.CandidateDispatchAttemptContext
  handleGenerationID: string
  pausedHandleCommitment: M1.PausedHandleCommitment
  state: "released"
  delivery: "delegated"
  delegateBoundaryRecorded: true
}> & Brand<"M2DelegatedReleaseProofV1">
export type UnknownDeliveryReleaseProofV1 = Readonly<{
  proofVersion: 1
  owner: "M2"
  latchID: string
  leaseID: M2.PreparedHandleLeaseIDV1
  candidateContext: M1.CandidateDispatchAttemptContext
  handleGenerationID: string
  pausedHandleCommitment: M1.PausedHandleCommitment
  state: "released"
  delivery: "unknown-delivery"
  delegateBoundaryRecorded: "unknown"
  resendAllowed: false
}> & Brand<"M2UnknownDeliveryReleaseProofV1">
type ReleasedStream = Readonly<{
  stream: Stream<LLMEvent>
  sendState: "delegated"
  releaseProof: M2.DelegatedReleaseProofV1
  authorization: Readonly<{
    result: M1.OperationCommitResultV1<DispatchAuthorizingOperationType>
    candidateContext: M1.CandidateDispatchAttemptContext
    handleGenerationID: string
    pausedHandleCommitment: M1.PausedHandleCommitment
    releaseCallableProofState: "consumed"
  }>
}>
export type ReleasedUnknownDelivery = Readonly<{
  sendState: "unknown"
  terminalState: "released-unknown-delivery"
  candidateContext: M1.CandidateDispatchAttemptContext
  handleGenerationID: string
  pausedHandleCommitment: M1.PausedHandleCommitment
  releaseProof: M2.UnknownDeliveryReleaseProofV1
  resendAllowed: false
}>

export type LegacyRuntimeInput = Readonly<{
  runtime: "ai-sdk" | "native"
  model: Provider.Model
  provider: Provider.Info
  language: LanguageModelV3
  provenance: ProviderRuntimeProvenance
  aiSDKMaxRetries: 0
  nativeHiddenRetries: 0
}>

type FinalFetchInput = Readonly<{ url: string; method: string; headers: Headers; bodyBytes: Uint8Array }>
type AITool = Tool
type ToolResult = unknown
type ToolRuntimeContext = Readonly<{ sessionID: string; callID: string; abort: AbortSignal; messages: readonly SessionV1.WithParts[] }>
type ToolExecutionGateError = Readonly<{ tag: "tool-gate"; phase: "raw-begin" | "before-hook" | "final-plan" | "body-outcome" | "after-hook" | "settlement"; cause: unknown }>
type TerminalSettlementError = Readonly<{ tag: "terminal-settlement"; cause: unknown }>
type AdmissionError = Readonly<{ tag: "admission"; cause: unknown }>
type ReentryError = Readonly<{ tag: "reentry"; cause: unknown }>
type ConfigDecodeError =
  | M1.RecoveryPolicyCodecError
  | M1.NormalizationError
  | M1.CanonicalizationError
  | M1.DigestMismatchError
  | M1.FieldSetError
type RunnerOwnership = Readonly<{ sessionID: string; token: string; live: AtomicRef<boolean> }> & Brand<"RunnerOwnership">
type RuntimeRegistry = ReadonlyMap<string, Readonly<{ assistant: M1.CommittedAssistantAttemptIdentity; runtime: CommittedAssistantRuntimeSnapshot; evidence?: AssistantRuntimeEvidence }>>

type ProviderTurnEvidence = Readonly<{
  dispatchOrdinal: M1.SafeNonNegativeInt
  settledStep: boolean
  canonicalIncomplete: boolean
  fetchViolation?: "unexpected-second-fetch"
}>
type DispatchOrdinalSettlement = Readonly<{
  context: M1.CommittedDispatchAttemptContext
  dispatchOrdinal: M1.SafeNonNegativeInt
  receiptOperationID: M1.RecoveryOperationID
  providerTurn: AtomicRef<ProviderTurnEvidence>
  terminalTrigger: AtomicRef<"open" | "normal-eof" | "canonical-incomplete" | "interrupt" | "transport-error" | "closed">
}>
type AssistantRuntimeEvidence = Readonly<{
  currentOrdinal: AtomicRef<M1.SafeNonNegativeInt | undefined>
  byOrdinal: Map<M1.SafeNonNegativeInt, DispatchOrdinalSettlement>
  settledOrdinalSummaries: Map<M1.SafeNonNegativeInt, ProviderTurnEvidence>
}>
type DispatchOrdinalSettlementDestination = Readonly<{
  assistant: M1.CommittedAssistantAttemptIdentity
  byOrdinal: AssistantRuntimeEvidence["byOrdinal"]
  currentOrdinal: AssistantRuntimeEvidence["currentOrdinal"]
  settledOrdinalSummaries: AssistantRuntimeEvidence["settledOrdinalSummaries"]
  expectedCurrentOrdinal: M1.SafeNonNegativeInt | undefined
  expectedNewOrdinal: M1.SafeNonNegativeInt
}>

type BodyOutcome =
  | { tag: "completed"; value: unknown }
  | { tag: "error"; error: unknown }
  | { tag: "interrupted"; cause: unknown }
  | { tag: "uncertain"; cause: unknown }
type ToolBody = (args: unknown, runtime: ToolRuntimeContext) => Promise<unknown>
type FinalToolPlan =
  | { tag: "execute"; toolName: string; args: unknown; execute: ToolBody }
  | { tag: "replacement"; toolName: string; args: unknown; execute: ToolBody }
  | { tag: "short-circuit"; outcome: BodyOutcome }
  | { tag: "reject"; error: unknown }
type DrainedDispatchOrdinal = Readonly<{
  dispatchOrdinal: M1.SafeNonNegativeInt
  evidence: ProviderTurnEvidence
  tools: readonly M1.ToolEvidence[]
  reasoning: readonly M1.ReasoningEvidence[]
}>
type TerminalDecision =
  | { tag: "normal-settled"; dispatchOrdinal: M1.SafeNonNegativeInt }
  | { tag: "incomplete"; dispatchOrdinal: M1.SafeNonNegativeInt; fact: M1.TypedIncompleteTerminalFact }
  | { tag: "evidence-inconsistent"; dispatchOrdinal: M1.SafeNonNegativeInt; cause: M1.RecoveryFailureCause }
  | { tag: "orthogonal-stop"; dispatchOrdinal: M1.SafeNonNegativeInt; error: unknown }
type AssistantProcessOutcome =
  | { tag: "finished" }
  | { tag: "ordinary-continuation-needed" }
  | { tag: "incomplete"; authority: M4.DurableRecoveryAuthorityViewV1 }
  | { tag: "compaction" }
  | { tag: "orthogonal-stop"; error: unknown }

type CandidateSelection =
  | {
      tag: "automatic"
      action: M1.AutomaticRecoveryAction
      snapshotProof: M4.AutomaticRecoveryProofSliceV1
    }
  | {
      tag: "manual"
      causes: readonly M1.RecoveryFailureCause[]
      authorityKind: "manual-only" | "planning-failure"
    }
type PreallocatedCandidate = Readonly<{
  context: M1.CandidateDispatchAttemptContext
  operationID: M1.RecoveryOperationID
  authority: "candidate"
}>
type SubsequentDispatchPreparationInput<
  K extends M4.CommittedAssistantAdmissionOperationV1 = M4.CommittedAssistantAdmissionOperationV1,
> = Readonly<{
  authority: M4.CommittedAssistantAuthorityViewV1<K>
  context: M1.CandidateDispatchAttemptContext
  origin: SubsequentOrigin
  semanticMessages: readonly ModelMessage[]
  runtimeInput: LegacyRuntimeInput
}>
type AdmittedAssistant =
  | Readonly<{
      context: M1.CommittedDispatchAttemptContext
      transport: "authorized-not-released"
      authorizedOrdinal0: AuthorizedDispatch
    }>
  | Readonly<{
      context: M1.CommittedDispatchAttemptContext
      transport: "automatic-released"
      releasedOrdinal0: ReleasedStream
    }>
type ChainTransition = AssistantProcessOutcome
type RecoveryOutcome = Readonly<{ effective: "source" | "child"; result: CoordinatorResult }>
type SourceAssistantResult = Readonly<{
  sourceAssistantID: string
  outcome: "manual-stop"
  result: M1.OperationCommitResultV1<"decision-finalized">
}>
type CommitResolution<T extends M1.RecoveryOperationType> =
  | { tag: "committed"; result: M1.OperationCommitResultV1<T> }
  | { tag: "missing" }
  | { tag: "conflict"; error: M4.RecoveryAuthorityErrorV1 }
  | { tag: "partial-or-corrupt"; error: M4.RecoveryAuthorityErrorV1 }
  | { tag: "persistence-fatal"; error: M4.RecoveryAuthorityErrorV1 }
  | { tag: "ambiguous"; error: M4.RecoveryAuthorityErrorV1 }
type AutomaticCommitResult =
  | { tag: "admitted"; assistant: AdmittedAssistant }
  | { tag: "replan-policy-stale"; authority: M4.DurableRecoveryAuthorityViewV1 }
  | {
      tag: "follow-winner"
      result:
        | M1.OperationCommitResultV1<"decision-finalized">
        | M1.OperationCommitResultV1<"automatic-child-admitted-and-consumed">
        | M1.OperationCommitResultV1<"source-superseded">
    }
  | { tag: "fatal-stop"; failure: FatalRecoveryStop }
type ExistingEvidenceDrainDecision =
  | { tag: "must-drain"; settlement: DispatchOrdinalSettlement }
  | { tag: "no-local-evidence" }
  | { tag: "inconsistent"; cause: M1.RecoveryFailureCause }
type SupersessionResult =
  | {
      tag: "model-proceed"
      proof: M4.SupersessionBeforePrepareProofV1
      supersessionResult?: M1.OperationCommitResultV1<"source-superseded">
    }
  | {
      tag: "no-reply-proceed-user-only"
      supersessionResult?: M1.OperationCommitResultV1<"source-superseded">
    }
  | {
      tag: "follow-automatic-winner"
      result: M1.OperationCommitResultV1<
        "automatic-child-admitted-and-consumed"
      >
      authority: M4.DurableRecoveryAuthorityViewV1
    }
  | { tag: "fatal-stop"; failure: FatalRecoveryStop }
```

`M2.M2InspectionResult.tag="available"`是unique paused preparation在same final object上产生的original inspection：`admission.target`及其protocol/storage facts与`frozenRequest` final body共同构成M7 post-prepare validation的唯一输入；M2/M7不得复制、重建或以caller target替换。`tag="unavailable"`不含handle或partial final-request proof。

### 4.1 `LinearDispatchHandle`

模块私有、不可序列化的线性对象；跨模块 durable identity/evidence引用 M1，不复制字段。

```ts
type HandleState =
  | { tag: "prepared" }
  | {
      tag: "authorized"
      receiptCommitment: string
      releaseLatch:
        | { tag: "open" }
        | { tag: "held"; latchID: string; delegateBoundary: "not-delegated" }
    }
  | {
      tag: "released"
      latchID: string
      delivery: "delegated"
      delegateBoundaryRecorded: true
    }
  | {
      tag: "released"
      latchID: string
      delivery: "unknown-delivery"
      delegateBoundaryRecorded: "unknown"
      resendAllowed: false
    }
  | { tag: "cancelled"; cause: string; sendClosureReachable: false }

type ReleaseBoundaryError = Readonly<{
  tag: "release-boundary"
  cause: "latch" | "state" | "proof"
}>
type ReleaseDelegateBoundary = Readonly<{
  latchID: string
  recordDelegated: () => Effect.Effect<M2.DelegatedReleaseProofV1, ReleaseBoundaryError>
  recordUnknownDelivery: (cause: unknown) => Effect.Effect<M2.UnknownDeliveryReleaseProofV1, ReleaseBoundaryError>
}>
type ReleaseDelegateOutcome =
  | Readonly<{ tag: "delegated-stream"; stream: Stream<LLMEvent>; proof: M2.DelegatedReleaseProofV1 }>
  | Readonly<{ tag: "delegated-error"; cause: unknown; proof: M2.DelegatedReleaseProofV1 }>
  | Readonly<{ tag: "known-not-delegated"; cause: unknown }>
  | Readonly<{ tag: "unknown"; cause: unknown; proof: M2.UnknownDeliveryReleaseProofV1 }>

export type PreparedHandleLeaseIDV1 = string & Brand<"PreparedHandleLeaseIDV1">

export type PreparedUnreleasedHandleProofV1 = Readonly<{
  proofVersion: 1
  leaseID: M2.PreparedHandleLeaseIDV1
  candidateContext: M1.CandidateDispatchAttemptContext
  handleGenerationID: string
  pausedHandleCommitment: M1.PausedHandleCommitment
  state: "prepared"
  authorized: false
  released: false
  cancelled: false
  sendClosureReachable: true
}> & Brand<"PreparedUnreleasedHandleProofV1">

export type NoPreparedHandleProofV1 = Readonly<{
  proofVersion: 1
  candidateContext: M1.CandidateDispatchAttemptContext
  registryGeneration: M1.SafeNonNegativeInt
  preparedHandleCount: 0
  state: "no-prepared-handle"
}> & Brand<"NoPreparedHandleProofV1">

export type MechanicallyCancelledUnreleasedHandleProofV1 = Readonly<{
  proofVersion: 1
  leaseID: M2.PreparedHandleLeaseIDV1
  candidateContext: M1.CandidateDispatchAttemptContext
  handleGenerationID: string
  pausedHandleCommitment: M1.PausedHandleCommitment
  previousState: "prepared" | "authorized"
  state: "cancelled"
  released: false
  cancelled: true
  sendClosureReachable: false
}> & Brand<"MechanicallyCancelledUnreleasedHandleProofV1">

export type HandleProofValidationErrorV1 = Readonly<{
  tag: "m2-handle-proof-validation"
  cause: "version" | "context" | "lease" | "generation" | "commitment" | "receipt-commitment" | "registry-generation" | "prepared-count" | "state" | "release-latch" | "delivery" | "released" | "closure-reachable"
}>

export type PreparedCommitPackageV1 =
  | Readonly<{
      owner: "M2"; kind: "available"; context: M1.CandidateDispatchAttemptContext
      target: M1.DispatchTarget; targetDigest: M1.DispatchTargetDigest; safetyDomain: M1.ProviderSafetyDomain
      storageMode: M1.StorageMode; semanticDigest: M1.SemanticDigest; preparedDigest: M1.PreparedDigest
      replayFence: M1.ProviderReplayFence; capabilities: M1.ProviderCapabilitySummary
      authorization: M1.ProviderAuthorizationCommitment; pausedHandleCommitment: M1.PausedHandleCommitment
      pendingSeals: readonly M4.PendingSealV1[]; stateProof: M2.PreparedUnreleasedHandleProofV1
    }>
  | Readonly<{
      owner: "M2"; kind: "opaque"; context: M1.CandidateDispatchAttemptContext
      target: M1.DispatchTarget; targetDigest: M1.DispatchTargetDigest; safetyDomain: M1.ProviderSafetyDomain
      storageMode: M1.StorageMode; semanticDigest: M1.SemanticDigest; preparedDigest: M1.PreparedDigest
      replayFence: M1.ProviderReplayFence; capabilities: M1.ProviderCapabilitySummary
      authorization: M1.ProviderAuthorizationCommitment; providerID: string; modelID: string
      localTools: "present" | "absent" | "unknown"; cause: M1.RecoveryFailureCause
      pausedHandleCommitment: M1.PausedHandleCommitment; pendingSeals: readonly []
      stateProof: M2.PreparedUnreleasedHandleProofV1
    }>

export type AvailableDispatchHandle = Readonly<{
  kind: "available"
  context: M1.CandidateDispatchAttemptContext
  admission: Extract<M1.DispatchAdmissionV1, { kind: "available" }>
  prepared: Extract<M2.PreparedCommitPackageV1, { kind: "available" }>
  handleCommitment: M1.PausedHandleCommitment
  recoveryReservation?: M2.PreparedHandleCommitmentReservationV1
  state: AtomicRef<HandleState>
  releaseDelegate: (boundary: ReleaseDelegateBoundary) => Promise<ReleaseDelegateOutcome>
  cleanup: () => Promise<void>
}>

type OpaqueDispatchHandle = Readonly<{
  kind: "opaque"
  context: M1.CandidateDispatchAttemptContext
  admission: Extract<M1.DispatchAdmissionV1, { kind: "opaque" }>
  prepared: Extract<M2.PreparedCommitPackageV1, { kind: "opaque" }>
  handleCommitment: M1.PausedHandleCommitment
  state: AtomicRef<HandleState>
  releaseDelegate: (boundary: ReleaseDelegateBoundary) => Promise<ReleaseDelegateOutcome>
  cleanup: () => Promise<void>
}>

type LinearDispatchHandle = M2.AvailableDispatchHandle | OpaqueDispatchHandle
export type MechanicallyCancelledDispatch = Readonly<{
  handle: LinearDispatchHandle
  proof: M2.MechanicallyCancelledUnreleasedHandleProofV1
  sendClosureReachable: false
}>
export type AutomaticPreReleaseCancellationV1 =
  | Readonly<{
      tag: "cancelled-handle"
      reservation: M2.PreparedHandleCommitmentReservationV1
      cancelled: M2.MechanicallyCancelledDispatch
    }>
  | Readonly<{
      tag: "no-handle-barred"
      reservation: M2.PreparedHandleCommitmentReservationV1
      proof: M2.NoPreparedHandleProofV1
      futureReservationConsumeAllowed: false
    }>
type DispatchCleanupInput =
  | Readonly<{
      disposition: "cancelled"
      cancelled: M2.MechanicallyCancelledDispatch
      proofRetention: "invalidate" | "manual-stop-tombstone"
    }>
  | Readonly<{
      disposition: "automatic-pre-release-cancelled"
      cancellation: M2.AutomaticPreReleaseCancellationV1
      proofRetention: "invalidate" | "manual-stop-tombstone"
    }>
  | Readonly<{
      disposition: "released"
      handle: LinearDispatchHandle
      delivery: "delegated" | "unknown-delivery"
    }>
type DispatchCleanupResult =
  | Readonly<{ tag: "closed"; cancellationProofRetained: false }>
  | Readonly<{
      tag: "manual-stop-tombstone"
      cancellationProofRetained: true
      proof: M2.MechanicallyCancelledUnreleasedHandleProofV1
      secretBytesRetained: 0
    }>
```

类型不变量：

- canonical state单向且由同一`AtomicRef<HandleState>`线性化：`prepared -> authorized{releaseLatch:open}`；release owner只可先`authorized/open -> authorized/held/not-delegated`，再二选一`authorized/held/not-delegated -> released/delegated`或`authorized/held/not-delegated -> released/unknown-delivery`；exact known-not-delegated失败必须先`authorized/held/not-delegated -> authorized/open`退出latch，再由§6.11执行`authorized/open -> cancelled`。另有`prepared -> cancelled`。不存在`authorized -> released`的pre-delegate eager transition。
- `released/delegated`、`released/unknown-delivery`与`cancelled`三者互斥且terminal。`unknown-delivery`是M2私有fatal ambiguity终态，明确`resendAllowed:false`；它不等于provider success，也不得降级为cancelled/known-unsent。任一terminal state不可再次转换。
- release latch由`releaseDispatch`以`releaseCallableProof`从`authorized/open`独占CAS到`authorized/held/not-delegated`。latch持有期间canonical handle仍是`authorized`，mechanical cancel与第二个release都必须返回typed `release-in-progress`/state failure，不能并发改变state、unlink closure或调用delegate。只有`ReleaseDelegateBoundary.recordDelegated`能在exact delegate call boundary把held state原子变为`released/delegated`；无法确定boundary是否已越过时只能由`recordUnknownDelivery`变为`released/unknown-delivery`。
- `M2.PreparedHandleLeaseIDV1`在一个candidate context内唯一且只绑定一个handle generation；proof中的`candidateContext/handleGenerationID/pausedHandleCommitment/leaseID`必须逐字段等于M2 live registry与handle。proof是runtime nominal capability，不可serialize、persist、clone、rebrand或从receipt重建。
- `M2.NoPreparedHandleProofV1`可在initial/ordinary prepare前、automatic preparation明确未分配handle后，或§6.10.1已原子bar reservation并推进registry generation后产生；它只在对应candidate的exact `registryGeneration`仍current、live prepared-handle count恰为0且不存在该generation的lease时有效。第一次handle allocation会原子推进registry generation并永久失效所有此前no-handle proof；unavailable preparation若从未分配lease则可在当前generation重新证明no-handle。
- `M2.PreparedUnreleasedHandleProofV1`只在同lease仍为`prepared`时有效；authorize、release、cancel、generation replacement或scope close均使其失效。`sendClosureReachable:true`只表示M2私有closure存在且被authorization gate阻断，不授予transport authority。
- `M2.MechanicallyCancelledUnreleasedHandleProofV1`只可由同lease从`prepared`或`authorized/open`成功CAS到`cancelled`后产生；`authorized/held`禁止cancel。它证明`released:false`且release closure已unlink、永久不可达。一般cleanup使proof失效；但automatic branch若尚可能进入ManualStop，§6.11.1必须先完成全部resource/secret cleanup并仅保留`manual-stop-tombstone`（secret bytes=0），同一proof只可由M2 validator针对该tombstone继续验证一次。type-8 result resolution后立刻invalidate tombstone。故外部顺序仍是`cancel -> K9 -> cleanup -> A5/S2/classify`，而ManualStop的proof-validation/commit仍happens-before最终proof-tombstone invalidation。
- `M2.ReleaseCallableProofV1`只由§6.9成功的`prepared -> authorized/open` CAS同原子步骤构造，逐字段绑定lease/context/generation/commitment/receipt commitment；任何latch acquire、cancel、release或cleanup使proof失效。`DelegatedReleaseProofV1`只由delegate boundary的held→released/delegated CAS构造；`UnknownDeliveryReleaseProofV1`只由held→released/unknown-delivery CAS构造。三种proof都可由其产生分支完整构造，禁止从receipt、error或stream猜测/rebrand。
- available/opaque handle只持有candidate-stage `M1.DispatchAdmissionV1`与`M1.PausedHandleCommitment`；M1 committed `DispatchEvidence`只可由M4 commit/fold后产生。available持有exact paused request facts；opaque不把private target/digest/proof写入M1 raw/receipt/ledger。
- automatic available handle必须且只能携带`recoveryReservation`，并要求reservation candidate/context/operation/action/targetDigest/gate kind/gate reservation ID/handle generation/paused commitment与actual AI SDK slot或native paused compilation逐字段一致；initial/ordinary/subsequent handle必须omit该字段。M2 registry中的reservation state只能`reserved-no-send -> consumed-by-exact-preparation -> closed`；consume只能由AI SDK slot安装或native paused compilation创建二选一执行exactly once，不能换绑、重建、TTL续租或在actual prepare失败后再创建第二个reservation/handle。
- raw auth header、API key、cursor/signature等plaintext只存在M4 `withUnsealedMaterial` dynamic scope、M7 reconstruction scratch或handle私有闭包；M2/M4-owned retained bytes在K9 close与所有failure/cancel/abandon/lost-handle branch清零，永不进入日志、EventTable payload或public state。
- handle与preallocated candidate context、assistant、dispatch ordinal一一绑定；不能换绑。

exact validators与producer如下，M4只能调用这些M2 exports，不得检查proof fields或复制brand：

```ts
export function proveNoPreparedHandleV1(
  context: M1.CandidateDispatchAttemptContext,
): Effect.Effect<M2.NoPreparedHandleProofV1, M2.HandleProofValidationErrorV1>

export function validateNoPreparedHandleProofV1(input: Readonly<{
  proof: M2.NoPreparedHandleProofV1
  expectedContext: M1.CandidateDispatchAttemptContext
}>): Effect.Effect<void, M2.HandleProofValidationErrorV1>

export function validatePreparedUnreleasedHandleProofV1(input: Readonly<{
  proof: M2.PreparedUnreleasedHandleProofV1
  expectedContext: M1.CandidateDispatchAttemptContext
  expectedCommitment: M1.PausedHandleCommitment
}>): Effect.Effect<void, M2.HandleProofValidationErrorV1>

export function validateMechanicallyCancelledUnreleasedHandleProofV1(input: Readonly<{
  proof: M2.MechanicallyCancelledUnreleasedHandleProofV1
  expectedContext: M1.CandidateDispatchAttemptContext
  expectedCommitment?: M1.PausedHandleCommitment
}>): Effect.Effect<void, M2.HandleProofValidationErrorV1>

export function validateReleaseCallableProofV1(input: Readonly<{
  proof: M2.ReleaseCallableProofV1
  expectedContext: M1.CandidateDispatchAttemptContext
  expectedCommitment: M1.PausedHandleCommitment
  expectedReceiptCommitment: string
}>): Effect.Effect<void, M2.HandleProofValidationErrorV1>

export function reserveRecoveryPreparedHandleCommitment(input: Readonly<{
  candidate: M1.CandidateAssistantAttemptIdentity
  context: M1.CandidateDispatchAttemptContext
  operationID: M1.RecoveryOperationID
  action: M1.AutomaticRecoveryAction
  snapshotProof: M4.AutomaticRecoveryProofSliceV1
  closure: M1.RecoveryClosureDescriptor
  runtimeInput: M2.LegacyRuntimeInput
}>): Effect.Effect<
  M2.PreparedHandleCommitmentReservationV1,
  M2.M2PrepareError | M2.PreparedHandleReservationValidationErrorV1
>

export function validatePreparedHandleCommitmentReservation(input: Readonly<{
  reservation: M2.PreparedHandleCommitmentReservationV1
  expectedCandidate: M1.CandidateAssistantAttemptIdentity
  expectedContext: M1.CandidateDispatchAttemptContext
  expectedOperationID: M1.RecoveryOperationID
  expectedAction: M1.AutomaticRecoveryAction
  expectedSnapshotProof: M4.AutomaticRecoveryProofSliceV1
  expectedClosure: M1.RecoveryClosureDescriptor
}>): Effect.Effect<void, M2.PreparedHandleReservationValidationErrorV1>

export function closePreparedHandleCommitmentReservation(input: Readonly<{
  reservation: M2.PreparedHandleCommitmentReservationV1
  reason: "prepared-and-transferred" | "mechanically-cancelled" | "abandoned" | "lost-handle-cleanup"
}>): Effect.Effect<void, M2.PreparedHandleReservationValidationErrorV1>
```

`reserveRecoveryPreparedHandleCommitment`只做audited target/gate选择、fresh handle-generation/gate-reservation identity分配、M2 keyed HMAC builder与registry CAS；不调用`streamText`、controlled fetch、native compile/body/prepareTransport、M4 unseal或provider delegate，因此不是provider preparation且hit=0。它返回的target/targetDigest与paused commitment供M6构造每个M1 `SealedRecoveryUseLeaseKeyInputV1`；actual prepare必须消费而不是复制该reservation。reservation不支持TTL、renew、reopen、old-handle recreation或same-round replacement。

所有validator都重读同一M2 live registry/`AtomicRef<HandleState>`并closed-check version、context与branch-applicable state。no-handle validator另检查exact current `registryGeneration`、prepared count为0且无M2 handle lease；prepared/cancelled/release-callable validators另逐项检查lease、handle generation、commitment、released/cancelled状态、closure reachability以及authorized latch必须`open`。reservation validator还要求same nominal M4 proof slice private brand/identity、M1 closure、future type-9 operationID、action、target/gate/generation/commitment exact，且actual preparation count仍为0。随后只有chosen runtime的AI SDK slot安装或native paused compilation创建可在同一原子registry transition中把reservation标为consumed，并把same identities写入slot/compilation/handle；任一mismatch在provider preparation前失败，另一runtime consume path此后必报`already-consumed`。返回成功不延长M2 proof或M4 sealed-use lease，不产生durable authority。M4 first-apply只消费prepared proof，ManualStop只消费no-handle或mechanically-cancelled proof；exact replay在任何M2 validator前结束。生命周期：M2创建reservation/proof/handle lease；M4 K7创建sealed-use lease；M6决定authorize/release/cancel并在所有终态调用K9；M4只borrow M2 proofs；scope finalizer只能对`prepared|authorized/open`执行cancel，遇`authorized/held`必须等待release owner形成known-cancelled或released terminal，不得并发cancel。automatic任何pre-release failure在handle存在时先cancel；不存在handle时先原子close/bar reservation并证明no live handle；随后K9 close/zeroize，K9成功后才能cleanup，再做lookup/replan。若post-cleanup仍可能进入ManualStop，cleanup只保留secret-free one-shot cancel-proof tombstone；A5/S2/classification与type-8 commit后立即invalidate tombstone，保持ManualStop proof-validation/commit先于最终proof close。普通cleanup/scope close释放registry entry并使所有M2 proofs/reservation失效。

### 4.2 `ProviderRuntimeProvenance`

M2-owned、由`provider.ts::resolveSDK/getLanguage`在runtime选择时产生，session层只消费不可重建：

```ts
type ProviderRuntimeProvenance = Readonly<{
  version: 1
  providerID: string
  modelID: string
  npmSpecifier: string
  packageVersion: string | "unknown"
  factory: "bundled" | "dynamic" | "custom"
  factoryID: string
  modelLoader: "sdk.languageModel" | "audited-bundled-loader" | "dynamic-or-custom"
  fetchOwner: "opencode-controlled" | "custom" | "unknown"
  downstreamFetchID: string | "unknown"
  middleware: readonly Readonly<{ id: string; version: string; semanticRewrite: "audited" | "unknown" }>[]
  preProviderSideEffects: "audited-local-only" | "unknown"
  provenanceDigest: M1.CanonicalDigestValue
  availability: "available-candidate" | "opaque"
  unavailableCause?: M1.RecoveryFailureCause
}>

type ResolvedLanguageRuntime = Readonly<{
  language: LanguageModelV3
  provenance: ProviderRuntimeProvenance
}>
```

类型不变量：`available-candidate`要求exact bundled package/version、audited factory/model loader、`fetchOwner="opencode-controlled"`、所有middleware rewrite audited、pre-provider side effects audited-local-only；任一unknown/custom/dynamic或cache provenance mismatch只能`opaque`。provenance与language model同cache entry原子存取；禁止只缓存language后按名称重建provenance。

### 4.3 `AISDKDispatchRuntime` 与 `AISDKGateSlot`

```ts
type AISDKDispatchRuntime = Readonly<{
  invocationID: string
  context: M1.CandidateDispatchAttemptContext
  reservation?: M2.PreparedHandleCommitmentReservationV1
  slot: AISDKGateSlot
  fetchArrivals: AtomicRef<number>
  phase: AtomicRef<"constructed" | "first-paused" | "first-delegated" | "closed" | "poisoned">
}>

type AISDKGateSlot = Readonly<{
  context: M1.CandidateDispatchAttemptContext
  descriptor: AuditedAISDKDescriptor
  gateReservationID?: string
  expectedHandleGenerationID?: string
  expectedPausedHandleCommitment?: M1.PausedHandleCommitment
  rendezvous: Deferred<LinearDispatchHandle, M2PrepareError>
  authorization: Deferred<Readonly<{ tag: "release"; boundary: ReleaseDelegateBoundary }> | Readonly<{ tag: "cancel" }>, never>
  state: AtomicRef<"waiting-for-provider" | "paused" | "authorized" | "closed" | "poisoned">
}>
```

- 每个fresh `streamText` invocation创建一个dispatch runtime和一个slot；`maxRetries=0`。
- 第一次controlled-fetch arrival可占用slot并暂停。`fetchArrivals`从0原子变1；只有该分支能构造handle。
- 同一invocation任何第二次arrival使`fetchArrivals`从1变2并立即进入`poisoned`，在调用downstream前抛`unexpected-second-fetch`。若第一次仍paused则同时mechanical-cancel first handle，整个invocation audited-provider-transport-hit为0；若第一次已delegate，则只阻止第二次，M3把assistant durable settle为runtime-proof inconsistency/ambiguity，绝不创建或旋转同一invocation slot。
- outer retry必须关闭旧runtime并fresh invoke，使用new ordinal/new slot；不存在“第二fetch临时申请subsequent slot”的协议。

### 4.4 `AuditedAISDKDescriptor`

模块私有策略对象，只为 built-in exact package/version/protocol组合注册：

```ts
interface AuditedAISDKDescriptor {
  readonly id: "anthropic-messages" | "openai-responses"
  readonly packageVersion: string
  readonly descriptorVersion: number
  readonly hiddenRetryCount: 0
  readonly matches: (runtime: ProviderRuntimeProvenance) => boolean
  readonly inspectFinalFetch: (input: FinalFetchInput, provenance: ProviderRuntimeProvenance) => M2.M2InspectionResult
}
```

`inspectFinalFetch`输出M1-owned evidence或typed unavailable；不在本文复制其字段。descriptor必须验证：exact protocol path、normalized endpoint、provider/model、authority来源、storage normalization、final body、tool definitions、custom fetch/middleware provenance与secret redaction。

### 4.5 `NativePausedCompilation`

```ts
type NativePausedCompilation = Readonly<{
  generationID: string
  gateReservationID?: string
  reservation?: M2.PreparedHandleCommitmentReservationV1
  request: LLMRequest
  routeID: string
  transportID: "http-json"
  validatedBody: unknown
  privatePrepared: unknown
  inspection: M2.M2InspectionResult
  executeOnce: (boundary: ReleaseDelegateBoundary) => Promise<ReleaseDelegateOutcome>
}>
```

`packages/llm`内部私有对象：保留一次 `compile` 得到的 resolved request、route、validated body与transport-private prepared object；另附safe inspection result。它不是public `PreparedRequest`，不得被SDK序列化。

不变量：release必须调用同一route的`streamPrepared`并传同一private prepared object；不得再次调用body lowering或`prepareTransport`；`executeOnce`只由linear handle持有。automatic branch的`generationID/gateReservationID/reservation.pausedHandleCommitment/targetDigest`必须逐字段等于pre-K7 reservation，compile consumes该reservation exactly once；initial/ordinary omit reservation并保持F26 ordinary preparation。

### 4.6 `AttemptLocalState`

```ts
type AttemptLocalState = {
  structuredOutput: unknown | undefined
  structuredOutputCallID: string | undefined
  assistantEvidence: AssistantRuntimeEvidence
  activeToolInvocations: Map<string, ToolInvocationHandle>
}
```

- 每个admitted model assistant先新建一次空`AttemptLocalState`；ordinary/recovery child均不继承。`assistantEvidence.currentOrdinal`初始为`undefined`且`byOrdinal`为空。
- ordinal-0只由§7.0.1在attempt创建后、release前调用一次：caller显式传入该attempt的exact `byOrdinal/currentOrdinal/settledOrdinalSummaries`、`expectedCurrentOrdinal:undefined`与`expectedNewOrdinal:0`。admission helper、authorization helper与attempt constructor均不得隐式插入ordinal-0。
- subsequent dispatch只在M4 complete type-3 result授权后由§7.0.1调用一次：caller传相同attempt destination、刚刚closed/frozen的exact current ordinal与receipt给出的fresh next ordinal。prepare/commit/authorize helpers均不得分配或推进settlement state。
- 每个旧ordinal对象先freeze为summary，绝不复用/清零后续写。assistant-wide aggregation只保留按ordinal分区的summary与current ordinal；drain/classify显式传current ordinal。任何event、terminal trigger、tool/reasoning flush写入其它ordinal，或ordinal 0对象被ordinal 1继续使用，都是`dispatch/ledger-conflict` inconsistency，不能合并。
- source attempt的StructuredOutput、partial text/reasoning/tool runtime对象不得进入child；only durable facts通过M4 terminal snapshot跨incomplete recovery传播。

### 4.7 `DispatchOrdinalSettlementDestination`

该类型不是dispatch controller或orchestration object，也不拥有prepare、commit、authorize、release或ordinal预测。它只把§7.0.1唯一允许修改的attempt-local destination显式带入签名；`expectedCurrentOrdinal/expectedNewOrdinal`是CAS前置而非authority，committed result中的ordinal仍是唯一durable authority。不存在ordinal-0/subsequent preparation callback、ledger-count callback或caller↔controller循环。

### 4.8 `ToolInvocationHandle`

```ts
type ToolInvocationState =
  | "allocated" | "raw-durable" | "hook-running" | "final-plan-durable"
  | "body-running" | "body-outcome-durable" | "after-hook-running" | "settled"
  | "hook-failed" | "abandoned" | "interrupted" | "uncertain"

type ToolInvocationHandle = Readonly<{
  owner: M1.CommittedAssistantAttemptIdentity
  dispatchOwner: { kind: "provider-dispatch"; context: M1.CommittedDispatchAttemptContext } | { kind: "preplanned-local"; localExecutionID: string }
  callID: string
  rawInvocationDigest: M1.CanonicalDigestValue
  beginResult: AtomicRef<M1.OperationCommitResultV1<"tool-evidence-recorded"> | undefined>
  latestPlanResult: AtomicRef<M1.OperationCommitResultV1<"tool-evidence-recorded"> | undefined>
  state: AtomicRef<ToolInvocationState>
  completion: Deferred<M1.ToolEvidence, ToolExecutionGateError>
  abort: AbortController
}>
```

模块私有线性对象，绑定M4 tool begin receipt、raw invocation、latest final-plan revision与runtime completion Deferred。状态只允许：

```text
allocated -> raw-durable -> hook-running -> final-plan-durable
  -> body-running -> body-outcome-durable -> after-hook-running -> settled
  -> hook-failed/abandoned/interrupted/uncertain
```

任何crash/reload只读取M4 evidence，不恢复该对象。

Restart reconciliation使用独立one-shot allocation，不复活`ToolInvocationHandle`：

```ts
export type RestartToolReconciliationAllocationV1 = Readonly<{
  owner: M1.CommittedAssistantAttemptIdentity
  callOrdinal: M1.SafeNonNegativeInt
  observedOperationID: M1.RecoveryOperationID
  reconciliationOperationID: M1.RecoveryOperationID
  observedPhase: "planned" | "body-outcome-durable" | "unknown-intermediate"
  state: AtomicRef<"allocated" | "submitting" | "committed" | "closed-fatal">
}>

export type RestartToolReconciliationResultV1 =
  | Readonly<{ tag: "reconciled"; result: M1.OperationCommitResultV1<"tool-evidence-recorded"> }>
  | Readonly<{ tag: "already-terminal"; phase: "final-after-hook-settled" | "reconciled-terminal-manual-only" }>
  | Readonly<{ tag: "cancelled-before-allocation" }>
  | Readonly<{ tag: "fatal-stop"; failure: FatalRecoveryStop }>
```

allocation identity为`(owner assistantID, callOrdinal, observedOperationID)`；同一次startup/session-resume scan至多分配一次。它不含body、before/after hook、provider callback、runtime args副本或Deferred。`planned/unknown-intermediate`只能产生body/after-hook均unknown且无invented terminal payload的`reconciled-terminal-manual-only`；`body-outcome-durable`只保留already-durable body state、terminal carrier与commitments，after-hook固定unknown。成功/response replay后state terminal；cancel/owner loss在allocation前可停止而不写，allocation后必须把same operationID交resolution/finalizer，不得丢弃后重新执行body/hook。

### 4.9 Policy/authority owner exports

M6 actual-export以下exact types；`RecoveryPolicyScopeKey`与expectation分别是M1 owner type的exact re-export/alias，不创建第二brand或structural binding：

```ts
export type RecoveryPolicyScopeKey = M1.RecoveryPolicyScopeKey
export type RecoveryPolicyAuthorityExpectation = M1.RecoveryAdmissionPolicyBindingV1

export type RecoveryPolicyAuthoritySnapshot = Readonly<{
  authorityVersion: 1
  policy: M1.NormalizedRecoveryPolicy
  scopeKey: M6.RecoveryPolicyScopeKey
  epoch: M1.SafeNonNegativeInt
  policyDigest: M1.RecoveryPolicyDigest
  defaultSemanticsVersion: M1.RecoveryAdmissionPolicyBindingV1["defaultSemanticsVersion"]
  controlPolicyDigest: M1.ControlPolicyDigest
}>

export type RecoveryPolicyAuthorityError =
  | Readonly<{
      tag: "invalid-policy"
      scopeKey: M6.RecoveryPolicyScopeKey
      reason:
        | "normalized-policy-invalid"
        | "policy-digest-mismatch"
        | "control-policy-digest-mismatch"
        | "unsupported-default-semantics-version"
    }>
  | Readonly<{ tag: "missing"; scopeKey: M6.RecoveryPolicyScopeKey }>
  | Readonly<{
      tag: "stale"
      expected: M6.RecoveryPolicyAuthorityExpectation
      actual: M6.RecoveryPolicyAuthorityExpectation
    }>
  | Readonly<{
      tag: "corrupt"
      scopeKey: M6.RecoveryPolicyScopeKey
      reason:
        | "decode-failed"
        | "field-set-mismatch"
        | "epoch-invalid"
        | "policy-digest-mismatch"
        | "control-policy-digest-mismatch"
    }>
  | Readonly<{
      tag: "cas-conflict"
      scopeKey: M6.RecoveryPolicyScopeKey
      observedEpoch: M1.SafeNonNegativeInt
    }>
  | Readonly<{ tag: "busy"; scopeKey: M6.RecoveryPolicyScopeKey }>
  | Readonly<{
      tag: "persistence"
      scopeKey: M6.RecoveryPolicyScopeKey
      phase: "begin" | "read" | "write" | "readback" | "commit" | "rollback"
    }>
```

snapshot不变量：`policyDigest === policy.policyDigest`；`defaultSemanticsVersion === policy.digestInput.defaultSemanticsVersion === 1`；`controlPolicyDigest`必须由M1 owner builder对exact `{scopeKey,epoch,policyDigest,defaultSemanticsVersion}`重算；把snapshot投影为这五字段必须exact等于`M6.RecoveryPolicyAuthorityExpectation`。epoch是scope内monotonic safe integer，same `(scopeKey,epoch)`必须有same normalized policy bytes及全部binding fields。`selectedAgentID/selectedAgentVersion/configSourceVersion`只是publish调用的secret-free internal diagnostic context，不进入authority snapshot、policy row canonical bytes、epoch/CAS equality、operation input、digest或public surface；真正影响admission的`agent.steps`已在M1 normalized policy内闭合。

M6 policy row只持久化上述snapshot的exact authority fields与M1 exact normalized policy bytes；不得持久化config object、raw environment、credential、diagnostic context或consumer-local alias。SQLite row commit happens-before runtime snapshot visibility。M4 operations 1/2/9 first apply在自身transaction内只把完整`M6.RecoveryPolicyAuthorityExpectation`交§9.1.3，并消费其返回的committed M1 policy；exact replay先验证stored historical binding，不被后来policy变化撤销。error union是closed、secret-free internal control signal：不得附raw SQL error/config/agent object，不得直接进入M8/public/log。

### 4.10 Internal serialized submission 与 `CoordinatorResult` handoff

```ts
export type SerializedSubmissionOperationID = string & Brand<"SerializedSubmissionOperationID">
export type SerializedSubmission =
  | Readonly<{ kind: "model"; operationID: SerializedSubmissionOperationID; submissionPayloadDigest: M1.CanonicalDigestValue; sessionID: string; userInput: unknown; commandContext?: unknown }>
  | Readonly<{ kind: "no-reply"; operationID: SerializedSubmissionOperationID; submissionPayloadDigest: M1.CanonicalDigestValue; sessionID: string; userInput: unknown }>
  | Readonly<{ kind: "shell"; operationID: SerializedSubmissionOperationID; submissionPayloadDigest: M1.CanonicalDigestValue; sessionID: string; shellInput: unknown }>

export type UnpreparedNonAuthoritativeNewInputCandidate =
  | Readonly<{
      kind: "model"
      sessionID: string
      submissionPayloadDigest: M1.CanonicalDigestValue
      intendedInitialOperationID: M1.RecoveryOperationID
    }>
  | Readonly<{
      kind: "no-reply"
      sessionID: string
      submissionPayloadDigest: M1.CanonicalDigestValue
      replyDisposition: "commit-user-only"
    }>

export type CoordinatorResult =
  | Readonly<{ kind: "model-final"; effectiveAssistant: SessionV1.WithParts; sourceAssistantID?: SessionV1.MessageID }>
  | Readonly<{ kind: "user-only"; userMessage: SessionV1.WithParts }>
  | Readonly<{ kind: "shell-final"; assistant: SessionV1.WithParts }>
  | Readonly<{ kind: "fatal-stop"; failure: FatalRecoveryStop }>
```

Initial与ordinary admission authority不在M6复制shape。M6直接消费M4 exact exports：planning stage分别是`M4.InitialAdmissionAuthorityViewV1<M2.NoPreparedHandleProofV1>`与`M4.OrdinaryAdmissionAuthorityViewV1<M2.NoPreparedHandleProofV1>`；一次M2 prepare后分别提升为同一candidate的`...<M2.PreparedUnreleasedHandleProofV1>`并交O1/A3。Initial view含committed dedicated owner mapping、current aggregate head（fresh empty为C1/MIG1 genesis）、current policy、committed Legacy user predecessor、candidate/context、M4 supersession proof与staged M2 proof；ordinary view含自己的current owner/heads/policy/committed predecessor/candidate/staged proof。两者都禁止从`M1.DurableRecoverySnapshot`、public projection或local structural record构造。

M6唯一拥有并actual-export `M6.SerializedSubmissionOperationID`、`M6.SerializedSubmission`、`M6.CoordinatorResult`、`M6.FatalRecoveryStop`与per-session serialized queue。`SerializedSubmission`只在server/runtime内部可见：`userInput`、`commandContext`、`shellInput`不得进入public wire/log/event；operationID也不是public idempotency key。每个branch的`operationID + submissionPayloadDigest + sessionID`在enqueue后immutable；same ID/different digest conflict。

`CoordinatorResult`只在M6→M8 internal handoff可见：`model-final`只能携完整chain最终effective assistant（automatic success为final child，durable ManualStop为source）；`user-only`只对应noReply；`shell-final`只对应shell；`fatal-stop`只携`M6.FatalRecoveryStop`并必须经过M8 exact fatal sanitizer。任何runtime-private field、authority ID、receipt、digest、handle、stack/raw cause都不得由M8 spread/serialize到public wire。

pre-inspection model/no-reply candidate只能携当时已知的session/submission facts：model另携intended type-1 operationID，no-reply固定`replyDisposition:"commit-user-only"`并在类型上排除intended operationID/reservation ref；不得预先携带source/control/predecessor-dependent `SupersessionBindingDigestInputV1`或digest。O10 `inspect-current-authority`若返回exact branded `M4.SupersessionRequiredAuthorityV1`，M6才把该authority与candidate逐字段组合，经M1 `buildSupersessionBindingDigestInput`+F22构造branch-exact input/digest，复制进完整type-10 operation input后以O10 `complete-expected-input` branch重入。禁止candidate加入policy、assistant、dispatch、prepared facts、automatic/manual `BindingDigest`或future完整type-1 payload；禁止直接绕过O10调用O9。M8 public wrappers负责把public prompt/command/prompt_async/shell输入翻译为`M6.SerializedSubmission`并把`M6.CoordinatorResult`映射为既有public返回/204/UX。`noReply`不是wrapper旁路：它必须以`kind:"no-reply"`进入同一serialized queue，先解决required type-10 `no-reply` supersession，再commit user message并返回；不启动model chain。shell也留在serialized queue，但绕过supersession recovery、policy freeze、M7/M2、N/M与model admission。

### 4.11 Generic committed-assistant re-entry state and SESSREC-2 dependency

SESSREC-2由M4 actual-export nonterminal-only generic authority contract；S3只消费下列owner-qualified names，不在M6重新`export`、alias或复制结构，也不以public projection或terminal-only S1 snapshot代替：

```ts
K extends M4.CommittedAssistantAdmissionOperationV1
M4.CommittedAssistantAuthorityViewV1<K>

M4.loadCommittedAssistantAuthorityView<K>(input: Readonly<{
  aggregateID: M1.RecoveryAggregateID
  sessionID: string
  assistantID: M1.RecoveryAssistantID
  admissionOperationType: K
}>): Effect.Effect<
  M4.CommittedAssistantAuthorityViewV1<K>,
  M4.RecoveryAuthorityErrorV1
>
```

M4 owner contract在一个WAL read snapshot内证明dedicated owner mapping、exact type1/type2/type9 admission result、conditional assistant/context、current heads、contiguous dispatch ledger及tool/reasoning/prefix slices，并固定`nonterminal:true`。assistant已有incomplete terminal、finalized/superseded source decision或已作为consumed source时loader拒绝；它不构造也不转换为`M1.DurableRecoverySnapshot`。terminal recovery path只在exact incomplete-terminal commit result已知后直接调用M4 S1；normal terminal observation由其own complete terminal/result path处理，不调用generic loader或S1。

```ts
type CommittedAssistantRuntimeSnapshot<
  K extends M4.CommittedAssistantAdmissionOperationV1 = M4.CommittedAssistantAdmissionOperationV1,
> = Readonly<{
  authority: M4.CommittedAssistantAuthorityViewV1<K>
  ordinalSettlement: "exact-live" | "absent" | "inconsistent"
  ownership: "same-process-live" | "lost" | "unknown"
  handle: "same-never-released" | "released" | "release-unknown" | "lost" | "none"
  processor: "attachable" | "not-attachable"
}>

type ReentryDecision =
  | { tag: "attach-live-processor" }
  | { tag: "resume-never-released"; operationID: M1.RecoveryOperationID }
  | { tag: "settle-known-no-send" }
  | { tag: "settle-ambiguity" }
  | { tag: "ownership-cancelled-before-reconciliation" }
  | { tag: "fatal-authority-invalid" }
```

`CommittedAssistantRuntimeSnapshot`只是same-process registry observation：其`authority`字段原样嵌入exact M4 view，其余字段只记录runtime settlement/ownership/handle/processor状态；它不复制M4 durable fields、不导出authority brand，也不能作为M4 loader或view的替代品。适用于nonterminal committed initial、ordinary与automatic recovery child。generic re-entry与lost-handle settlement始终消费上述M4 view；其签名在type上排除`M1.DurableRecoverySnapshot`。nonterminal predecessor禁止successor；只有attach existing processor、resume exact never-released handle，或先durable settle abandonment/ambiguity后，successor admission才可继续。

### 4.12 Type-by-type lifecycle, locking, cancellation and thread-safety conclusions

| Type | Lifecycle | Locking / atomicity | Cancellation | Thread-safety conclusion |
|---|---|---|---|---|
| `DispatchAdapterDecision` / `M2InspectionResult` / `ProviderRuntimeProvenance` / `ResolvedLanguageRuntime` / `AuditedAISDKDescriptor` | invocation/cache generation内immutable；generation mismatch失效 | pure/frozen；cache pair原子替换 | N/A；不持有fiber/handle | immutable并发读安全；cache publication须由provider cache lock/atomic swap保护 |
| `PreparedCommitPackageV1`、`PreparedHandleCommitmentReservationV1`及M2 proof | reservation `reserved-no-send→consumed→closed`；prepared/cancel/release proof在exact handle/registry generation与适用state内有效；latch acquire/cancel/release/cleanup使前态proof失效；ManualStop可保留secret-free one-shot cancel tombstone | 只由M2 registry + canonical `HandleState` CAS验证；M4 borrow不加第二把锁；reservation与actual slot/compilation/handle exact compare后单次consume | automatic pre-release failure：有handle则mechanical cancel、无handle则原子bar reservation/prove-no-handle，随后K9 close/zeroize，K9成功后M2 resource cleanup/close reservation，再lookup/replan；ManualStop tombstone在type-8 resolution后invalidate | immutable值可并发读；有效性/consume仅经M2 validators/CAS；禁止TTL、renew、reopen或replacement reservation |
| `M4.SealedRecoveryUseLeaseV1` / `SealedRecoveryUseReleaseValidationV1` | K7 `absent→live`；K9/K10 `live→closed`；无renew/reopen/TTL | K7/K9 SQLite CAS；O8 first-apply K8在writer tx；pre-release K8在handle仍prepared且紧邻F27/M2 authorize的read scope | cancel/commit failure/prepare/inspection/M7/M5/K8 failure/abandon/lost handle/response loss均先K9 close再cleanup，之后才A5/S2/replan；dead process仅K10 exclusive fence | nominal lease可并发读但use只在current live row与same generation有效；K9 failure在任何会丢失lease relation的cleanup/lookup前fatal；proof不可缓存跨release |
| `AvailableDispatchHandle` / `OpaqueDispatchHandle` / `MechanicallyCancelledDispatch` / `AuthorizedDispatch` / `ReleasedStream` / `ReleasedUnknownDelivery` | `prepared→authorized/open→authorized/held/not-delegated→released/delegated-or-unknown-delivery`；known local failure先退latch到authorized/open再cancel；terminal后不可逆 | exact handle单一`AtomicRef<HandleState>`同时线性化authorization、exclusive release latch、delegate boundary与cancel；delegate call site唯一 | cancellation只允许§6.11从prepared或authorized/open；held期间禁止并发cancel/release；automatic终态按§6.10/K9关闭lease；released/unknown side effect不可撤销 | 通过single canonical CAS与single owner transfer线程安全；禁止复制、双owner、并发cancel/release或unknown后resend |
| `AISDKDispatchRuntime` / `AISDKGateSlot` | 每fresh invocation一个；close/poison后不复用 | arrivals/phase/state CAS + Deferred | AbortSignal/scope close唤醒并poison/cancel paused first handle | 同一invocation并发arrival安全；跨invocation共享slot不安全且禁止 |
| `NativePausedCompilation` | single compile到release/cleanup；execute once后terminal | caller线性ownership；无共享mutable transport object | pre-release cleanup zeroize；post-release仅abort/close stream | 非通用线程安全；仅在线性owner与single execute gate下安全 |
| `AssistantRuntimeEvidence` / `DispatchOrdinalSettlementDestination` / `DispatchOrdinalSettlement` | 每assistant attempt创建；ordinal对象append-only后freeze summary；attempt结束销毁 | §7.0.1对exact map/current CAS；event mutation先校验ordinal | ownership cancel先close intake/drain，不删除durable facts | 在per-assistant serialized processor下安全；外部并发writer禁止，late event只可经reconcile gate |
| `AttemptLocalState` | committed assistant后先创建空state；ordinal0随后exact once；successor不继承 | per-runner serialized ownership；内部current ordinal CAS | runner cancellation传播到tools/dispatch并最终destroy local maps | 不可跨assistant/runner共享；单owner + guarded callbacks下线程安全 |
| `ToolInvocationHandle` / `ToolInvocationState` | allocated到settled/error terminal；crash不恢复runtime object | state CAS、Deferred；durable phase fence由M4 transaction提供 | AbortController只中断body；已durable phase不回滚 | 同一callID多callback安全仅经state machine；raw body直接并发调用禁止 |
| `RestartToolReconciliationAllocationV1` | restart scan对每个latest intermediate raw anchor分配一次；提交/closed后销毁 | per-session resume owner + `(assistant,callOrdinal,observedOperationID)` unique map；O3a/A5提供durable single winner | allocation前cancel可退出；allocation后cancel转移same operationID给resolver/finalizer，body/hook调用恒0 | serialized resume owner下安全；并发reconciler只能一个allocation，M4 conflict/reload决定winner |
| `PreallocatedCandidate` / `SubsequentDispatchPreparationInput` / `AdmittedAssistant` | candidate precommit ephemeral；admitted/result immutable；fresh next context每dispatch一次 | no local lock；authority由M4 commit/result | precommit cancel handle；candidate discard不消费budget | immutable传递安全；authority mutation不得由caller并发执行 |
| `UnpreparedNonAuthoritativeNewInputCandidate` / `M4.SupersessionRequiredAuthorityV1` / `M4.SupersessionBeforePrepareProofV1` | candidate先活到O10 inspect outcome；仅supersession-required branch保留same immutable candidate供一次complete-input re-entry，且始终不增加source/control/predecessor/binding字段；branded authority只活到该次完整input构造且head变化失效；model proof只活到matching O1 first apply | per-session serialized owner；M4同tx附private brand，M6不得复制/deserialize；O10 complete branch重新验证same candidate+authority-derived input | unresolved old handle先mechanical cancel；candidate/authority/proof discard不产生new authority | immutable handoff可读；只有serialized owner可消费一次，跨runner/并发重用不安全且禁止 |
| `CommittedAssistantRuntimeSnapshot` / `RuntimeRegistry` / `ReentryDecision` | M4 view read snapshot + same-process registry observation；任何authority/head变化需reload | M4 read transaction + registry atomic lookup；不混合不同generation | reentry cancellation不得制造terminal；lost handle走durable settlement | snapshot immutable；registry access经per-session runner lock/atomic map才安全 |
| `RecoveryPolicyAuthoritySnapshot`引用及`SerializedSubmission`/`RunnerOwnership` | policy commit后immutable；submission enqueue到cached result；ownership撤销不可复活 | SQLite policy tx + per-session serialized queue/registry | disconnect仅detach waiter；runner cancel使live永久false | policy snapshot并发读安全；submission执行按session串行，跨session可并发 |
| Pure M5 unions (`CandidateSelection`) 与M1/M7 owner values | call scope immutable | 无锁、无共享写 | N/A | 纯值线程安全 |

所有未列为持锁对象的immutable value都不能把“可并发读”升级为“可并发执行其所引用closure”。锁顺序固定为per-session serialized ownership → M2 reservation/handle canonical-state CAS → M4 K7/K8/K9 transaction或borrow；K7完成并释放DB tx后才进入M4 `withUnsealedMaterial` callback/M7 lowering/M2 actual preparation。等待provider/tool、unseal callback或release时不得持SQLite transaction或session queue mutex。automatic pre-release K8 validation→F27/M2 authorize后，`releaseDispatch`只以same canonical state CAS取得exclusive latch；latch held期间handle保持authorized且环境不得cancel/release。delegate boundary将held state原子记为delegated或unknown terminal；exact not-delegated local failure先释放latch回authorized/open再mechanical cancel。任何automatic pre-release failure都在K9成功前保留lease relation且不得cleanup/A5/S2/replan；delegate terminal后K9 close。cancellation不反向释放durable authority，也不把unknown-send降级为known-unsent。

## 5. 全局调用图与跨模块接口

### 5.1 Initial / ordinary

```text
M8 wrapper -> M6 submitSerialized(stable internal operationID+digest)
  -> model allocates intended type-1 operationID / no-reply fixes commit-user-only disposition
  -> construct exact pre-inspection candidate from session/submission facts plus only that branch field
  -> M4 dedicated current-authority read supplies only O10 inspect expected aggregate head (no recovery snapshot/source/control/predecessor extraction in M6)
  -> O10 inspect-current-authority
       supersession-required only: branded M4 authority + candidate -> complete M1 type-10 binding/input -> O10 complete-expected-input
       no unresolved source: use O10 model proof or no-reply user-only outcome without type-10
  -> commit/validate Legacy user message for initial, or exact committed assistant predecessor for ordinary
  -> per-admission M6 freezeAdmissionPolicy
  -> preallocate candidate -> M2.proveNoPreparedHandleV1
  -> M4 origin-specific no-handle authority view
       initial: owner mapping + current aggregate head (genesis if empty) + current policy + Legacy user predecessor
       ordinary: owner mapping + current heads + current policy + committed assistant predecessor
  -> M1.AdmissionPlan from that exact origin input
  -> existing ordinary ModelMessage converter (M7 does not own initial/ordinary output)
  -> M2 prepareInitialOrOrdinaryDispatch
  -> M4 bind same view to M2.PreparedUnreleasedHandleProofV1
  -> M4 commitCompositeAdmissionDispatch -> M1.OperationCommitResultV1<"initial-chain-genesis-and-dispatch" | "ordinary-assistant-and-dispatch-admitted">
  -> response loss §9.11 (<=2 lookups + <=1 same-ID resubmit)
  -> nonautomatic M1 F26 validates result.receipt + result.operationPostState -> M2 authorize
  -> M6 newAttemptLocalState(empty ordinal destination)
  -> M3 allocateDispatchOrdinalSettlement(complete result, exact destination, expected undefined -> ordinal 0) exactly once
  -> release/process
```

### 5.2 Subsequent semantic dispatch / outer retry

```text
SessionRetry.policy accepted result OR audited unexpected subsequent model step
  -> drain/close exact current ordinal
  -> allocate one fresh next-ordinal candidate context + stable operationID
  -> M2 prepareSubsequentDispatch({ committed assistant, exact fresh context, origin }) exactly once
       -> one bound handle + M2.PreparedUnreleasedHandleProofV1
  -> M4 commitSubsequentDispatch -> exact complete M1 result
  -> nonautomatic M1 F26 authorize same handle
  -> M3 allocateDispatchOrdinalSettlement(exact attempt destination, current -> receipt next ordinal) exactly once
  -> release
```

`SessionRetry.policy` result是唯一generic retry predicate；covered 429/503 behavior保留，本文不复制status/text规则。same-invocation second fetch永不升级为next ordinal。

### 5.3 Incomplete recovery

```text
M3 drain(current ordinal)
  -> M4 commitIncompleteTerminal
  -> M4 loadRecoverySnapshot -> M4.DurableRecoveryAuthorityViewV1
  -> per-round M6 freezeAdmissionPolicy
  -> M5 selectRecoveryCandidate(authority view)
       manual-only authority -> ManualStop/fatal classification, no M7/M2/K7
       automatic -> exact nominal M4.AutomaticRecoveryProofSliceV1
  -> M7 build target/provider-neutral M1.RecoveryClosureDescriptor from that proof slice
       no unseal, no semantic payload lowering, no provider preparation
  -> M2 reserveRecoveryPreparedHandleCommitment
       stable no-send target/gate/handle commitment reservation; provider preparation count=0
  -> M4 K7 acquire exact live sealed-use leases for every sealed ref
       same snapshot proof + closure + source/action/operation/candidate/target/generation/handle commitment
  -> M7 reconstruct/unseal/lower replay payload only through same live leases
       -> exact M7.LoweredRecoveryCandidate
  -> M2 prepareDispatch exactly once using same reservation
       -> exact reserved AI SDK slot/native gate/handle
       -> original available M2.M2InspectionResult with final target/protocol/storage/body
  -> M7 validatePreparedRecoveryInspection({ candidate, inspection }) on same object
  -> M2 returns M1.PlannedRecoveryMaterialization<M2.AvailableDispatchHandle>
       available = { descriptor: M1 exact available descriptor, pausedHandle: same reserved handle }
       unavailable = M1 exact unavailable descriptor only; no live handle; no descriptor spreading
  -> M5 final classifyRecovery(authority view + same proof + planned)
  -> manual: mechanical cancel/no-handle barrier -> K9 close leases if acquired -> cleanup preserving secret-free one-shot tombstone -> A5/S2/S1 eligibility -> M4 commitManualStop with tombstone-backed M2 proof -> complete result -> tombstone invalidation
  -> automatic: M4 commitAutomaticChild/O8; O8 first-apply consumes K8 in transaction
       -> complete result -> M4 pre-release K8 validation on same handle + same leases
       -> F27 + M2 same-object authorize constructs authorized/open release-callable proof
       -> exclusive release latch retains authorized/not-delegated through local pre-call
       -> delegate boundary atomically records released/delegated exactly once, or terminal released/unknown-delivery
       -> K9 close/zeroize before cleanup; only delegated+K9 success proceeds to child ordinal0 settlement
```

SafeRetry只来自`toolEligibility.kind==="safe-retry-eligible"`，其partition精确`truly-empty`且proof slice携M1 exact not-needed closure。Continue只来自`kind==="continue-eligible"`，其partition精确`authoritative-only`、每项phase精确`final-after-hook-settled`且proof slice/order/carriers/provider-prefix绑定same snapshot。`manual-only`、compatibility-only、mixed、planned/body-outcome/reconciled/unknown phase、nonfinal/unknown或任何authority completeness失败均不得进入automatic branch。initial/ordinary/subsequent不使用sealed recovery payload，保持ordinary preparation→M4 result→F26→release，且没有reservation/K7/M7 recovery lowering或隐藏duplicate prepare。

### 5.4 Callee contract ledger used by every proof

| ID | Exact owner callable/type | Required pre | Guaranteed post |
|---|---|---|---|
| C-PROV | M2 §6.1/§6.1.1 | validated model; no invocation | same-generation language/SDK+provenance; unknown paths opaque |
| C-M2-PROOF | M2 §4.1 exact `proveNoPreparedHandleV1`/`validate*ProofV1` | same candidate context；live registry/lease；owner-qualified proof | exact no-handle/prepared/cancelled state or `M2.HandleProofValidationErrorV1`；zero durable write/state extension |
| C-M1 | M1 exact codecs/F23/F24/F26/F27 | owner-typed input; no raw secret | exact value/result or typed failure; F23 sole reason mapping/order |
| C-M4-ADMIT | `M4.loadInitialAdmissionAuthorityView` / `M4.loadOrdinaryAdmissionAuthorityView` / binders / `M4.commitCompositeAdmissionDispatch` | origin-specific no-handle view from dedicated current authority，then same candidate prepared once and bound to `M2.PreparedUnreleasedHandleProofV1`; current policy expectation | no terminal snapshot；atomic op1/2 result；handle still unreleased |
| C-M4-COMMITTED | SESSREC-2 exact generic `M4.loadCommittedAssistantAuthorityView<K>` / `M4.CommittedAssistantAuthorityViewV1<K>` | aggregate/session/assistant IDs + exact type1/type2/type9 admission operation type；nonterminal same-process reentry only | `nonterminal:true` authority/current dispatch/facts from one WAL snapshot；terminal/closed rejected；never constructs S1 snapshot |
| C-M4-DISPATCH | `M4.commitSubsequentDispatch` | prior ordinal closed; fresh next-ordinal context and one prepared handle/proof bound to committed assistant | atomic `OperationCommitResultV1<"subsequent-dispatch-recorded">`/next ledger |
| C-M4-EVIDENCE | `commitToolEvidence/commitReasoningEvidence/commitProviderPrefix/commitIncompleteTerminal` | exact M1 indexed operation input + prior fold + stable ID；no local literal mapping | corresponding exact-string `OperationCommitResultV1<T>`/`ReceiptForV1<T>` selected by M1↔M4 owner mapping or typed failure |
| C-M4-SNAPSHOT | `M4.loadRecoverySnapshot` | dedicated aggregate selector; no public projection/history truth | one-WAL-snapshot nominal `M4.DurableRecoveryAuthorityViewV1`，完整包装M1 snapshot、same-read mapping、exact identity与total `toolEligibility`；只有branded automatic slice可交M7 |
| C-M4-LEASE | M4 K7 `acquireSealedRecoveryUseLease`、K8 commit/release validators、K9 close、K10 crash cleanup | same nominal proof slice+M1 closure+M1 exact lease key+M2 stable reservation；positive generation；same type-9 operation/handle | `absent→live→closed`；K7 before unseal/prepare；O8与prepared-only pre-release K8 same live set；all close paths zeroize；no TTL/reopen |
| C-M4-AUTO | `M4.commitAutomaticChild` | validated proposal/same available handle/current policy expectation/snapshot identity/complete live lease set | O8 first-apply K8 validation + atomic consumed child+ordinal0+three recovery heads plus aggregate event head/cursor；complete `OperationCommitResultV1<"automatic-child-admitted-and-consumed">` |
| C-M4-MANUAL | `M4.commitManualStop` | validated F23 proposal + no-handle/cancel proof；automatic-attempt branch has A5/S2 absence/no-winner/fresh-source proof | finalized no-child complete result or typed failure |
| C-M4-WINNER | `M4.lookupCurrentRecoveryWinner` | losing exact recovery head | closed complete manual/automatic/superseded/unchanged result |
| C-M4-LOOKUP | `M4.lookupRecoveryOperationResult` | full aggregate-scoped tuple/input/digest/kind | original complete result or missing/conflict/inconsistent |
| C-M4-O3A | `M4.reconcileInterruptedToolExecution` | latest authoritative phase planned/body-outcome/unknown；exact reconciled input；no callbacks | append-only complete type-4 result；terminal-manual-only；barrier may close；automatic permanently forbidden |
| C-M7 | M7 closure-from-proof / post-K7 `lowerLegacyRecoveryRequest` / `validatePreparedRecoveryInspection` | only selected nominal `M4.AutomaticRecoveryProofSliceV1`；pre-K7 closure no unseal；post-K7 exact leases；validator consumes original available `M2.M2InspectionResult` | proof-bound M1 closure；source-free or exact replay reconstruction；post-prepare same-object target validation；never consumes plain snapshot/manual-only view |
| C-POLICY | M6 §9.1.1–§9.2 | decoded config/scope | committed snapshot; per-admission freeze; tx first-apply exact compare |
| C-GATE | M2 §6.9–§6.11.1 | exact complete result + release-callable proof + canonical linear state | authorize constructs `authorized/open` proof；exclusive latch retains authorized through local pre-call；only delegate boundary records released delegated/unknown；known-not-delegated exits latch then cancel；K9-before-cleanup monotonic |
| C-ORDINAL | M3 §7.0.1/§7.9/§7.10 | complete authorized result + exact destination map/current ordinal + expected transition | exactly one fresh isolated settlement insertion/CAS; exact drain/classify; no preparation/commit helper mutation |
| C-TOOL | M3 §7.2–§7.7 | admitted owner/current ordinal/complete call | raw fence -> hook -> plan fence -> body<=1 -> settlement |
| C-RUNNER | M6 §9.15 | stable internal operationID+digest | same-process attach/replay/conflict and one result per submission |

每个nontrivial callable在本文件自己的小节给出exact signature、callers/callees pre/post、Requires、numbered continuous steps、all branches/exits/residue、Ensures、side effects、loop/wait progress与structured proof；callee shorthand必须指向本表或具体section。

## 6. M2 — Legacy Dispatch Preparation and Transport Gate

本节每个小节只拥有一个 callable。所有M4 commit函数返回值按M1 `OperationCommitResultV1<T>`消费；receipt只使用M1 `*V1` exact exports。

### 6.1 `resolveSDKWithProvenance(model) -> SDKRuntimeResolution`

```ts
function resolveSDKWithProvenance(model: Provider.Model): Effect.Effect<{
  sdk: Provider.SDK
  provenance: ProviderRuntimeProvenance
}, Provider.InitError | M2PrepareError>
```

- **Callers**：`getLanguageRuntime`。
- **Callees（pre/post）**：Provider registry/env/cache要求model已验证，返回selected SDK或typed error；M1 canonicalizer要求secret-redacted typed facts，返回deterministic digest或typed failure。
- **Requires**：尚未构造provider request；factory/fetch/loader/middleware identity均可显式标为audited或unknown。
- **步骤**：1) 读registry/env/cache；2) cache hit逐项验证generation+provenance digest，match返回，mismatch淘汰；3) 解析factory/fetch/loader/middleware；4) positive allowlist全部成立才标`available-candidate`，否则写exact M1 cause并标opaque；5) 调本地SDK factory；实际行为偏离声明时降为opaque；6) canonicalize并原子缓存`{sdk,provenance}`。
- **分支/退出/残留**：available、opaque、Provider typed error、canonicalization error四路；error不留下available cache entry或sendable closure。
- **Ensures**：SDK与provenance同generation；session层不能按名字升级availability；pre-provider remote side effect不可排除时必opaque。
- **Side effects**：registry/env/cache、本地factory与内存；不调用provider transport、tool、M4或public event。
- **循环/等待**：有限registry/cache lookup；无wait。
- **正确性论证**：positive allowlist+实际行为复核阻止unknown来源成为available；原子cache保持SDK/provenance一致；列出的callees覆盖全部副作用，故post与副作用穷尽。

### 6.1.1 `getLanguageRuntime(model) -> ResolvedLanguageRuntime`

```ts
function getLanguageRuntime(model: Provider.Model): Effect.Effect<ResolvedLanguageRuntime, Provider.ModelNotFoundError | Provider.InitError | M2PrepareError>
```

- **Callers**：initial/ordinary preparation、`prepareSubsequentDispatch`、recovery `prepareDispatch`。
- **Callees（pre/post）**：§6.1在validated model上返回SDK+provenance；SDK language loader在其owner pre下返回language或typed error，且不得改变provenance而不被检测。
- **Requires**：model/provider selection固定；尚未启动本次invocation。
- **步骤**：1) 调§6.1；2) 调selected loader；3) 比较loader/fetch/middleware actual identity与provenance；4) mismatch将结果标opaque或error；5) 原子缓存并返回`ResolvedLanguageRuntime`。
- **分支/退出/残留**：language success；model missing/init failure；identity mismatch opaque；失败无invocation/slot/handle。
- **Ensures**：language与provenance不可分割且可供§6.2消费。
- **Side effects**：local loader/cache；available路径无remote refresh/transport。
- **循环/等待**：无循环；loader若为dynamic/custom只能opaque，其外部进度不被available proof消费。
- **正确性论证**：§6.1 post加step3 equality建立同generation事实；所有failure在invocation前退出，因此无sendable残留。

### 6.2 `resolveDispatchAdapter(input) -> DispatchAdapterDecision`

```ts
function resolveDispatchAdapter(input: Readonly<{
  runtime: "ai-sdk" | "native"
  model: Provider.Model
  provider: Provider.Info
  providerRuntime: ProviderRuntimeProvenance
  origin: DispatchOrigin
}>): DispatchAdapterDecision
```

- **Callers**：§6.3、§6.3.1。
- **Callees（pre/post）**：finite audited descriptor registry与native capability lookup；输入provenance来自§6.1.1。
- **Requires**：invocation/transport尚未开始。
- **步骤**：1) exact package/protocol lookup；2) AI SDK positive predicates全真→available，否则opaque；3) native exact HTTP JSON+audited inspector→available，WebSocket/custom→opaque；4) recovery origin遇opaque改为disabled typed cause；5) unknown runtime→disabled。
- **分支/退出/残留**：四个discriminator穷尽；内部defect映射typed disabled。
- **Ensures**：只有audited no-send seam可available；recovery绝不返回sendable opaque。
- **Side effects**：无。
- **循环**：descriptor集合有限，每轮消费一项。
- **正确性论证**：每个unknown/custom分支显式fail closed，故available蕴含完整positive evidence；pure lookup使副作用为空。

### 6.3 `prepareInitialOrOrdinaryDispatch(input) -> LinearDispatchHandle`

```ts
function prepareInitialOrOrdinaryDispatch(input: Readonly<{
  candidate: M1.CandidateAssistantAttemptIdentity
  context: M1.CandidateDispatchAttemptContext
  semanticMessages: readonly ModelMessage[]
  runtimeInput: LegacyRuntimeInput
  origin: "initial" | "ordinary"
}>): Effect.Effect<LinearDispatchHandle, M2PrepareError>
```

- **Callers**：M6 `admitInitialOrOrdinary`。
- **Callees（pre/post）**：§6.2选择唯一adapter；§6.4/§6.5/§6.7各返回candidate-stage handle；M1 admission builders返回exact `DispatchAdmissionV1`；M1 `buildPreparedDigestInput`只使用initial/ordinary branch（exact final request+semantic/replay/capability/authorization/paused commitment/body format），禁止automatic source/action/closure fields。
- **Requires**：ordinary converter已固定messages；candidate无authority；同context无其它handle。
- **步骤**：1) resolve adapter；2) AI/native available调用对应prepare；3) opaque调用§6.4；4) disabled返回typed error；5) 任一partial resource先§6.11 cancel再§6.11.1 cleanup。
- **分支/退出/残留**：available、opaque、typed error；error无assistant/ledger/head/sendable handle。
- **Ensures**：success handle持candidate admission material且`auditedProviderTransportHitCount===0`；不构造committed evidence。
- **Side effects**：local prepare、sealed scoped read、fiber/compile；无M4 admission/provider delegate。
- **循环/等待**：AI SDK gate wait遵循§6.5.2 conditional progress；无新timeout。
- **正确性论证**：adapter分支互斥；每个callee post保持candidate/no-send；failure cleanup不恢复closure，故post成立。

### 6.3.0 `reserveRecoveryPreparedHandleCommitment(input) -> PreparedHandleCommitmentReservationV1`

```ts
export function reserveRecoveryPreparedHandleCommitment(input: Readonly<{
  candidate: M1.CandidateAssistantAttemptIdentity
  context: M1.CandidateDispatchAttemptContext
  operationID: M1.RecoveryOperationID
  action: M1.AutomaticRecoveryAction
  snapshotProof: M4.AutomaticRecoveryProofSliceV1
  closure: M1.RecoveryClosureDescriptor
  runtimeInput: M2.LegacyRuntimeInput
}>): Effect.Effect<
  M2.PreparedHandleCommitmentReservationV1,
  M2.M2PrepareError | M2.PreparedHandleReservationValidationErrorV1
>
```

- **Callers**：M6 `recoverIncomplete`，只在M5选择nominal automatic proof slice且M7从该slice构造/复验M1 closure之后调用一次。
- **Callees（pre/post）**：§6.1.1/§6.2只做audited runtime/target/gate capability选择；M1 `buildDispatchTargetDigestInput`与M2 audited `buildPausedHandleCommitmentInput`/F21；M2 reservation registry CAS。不得调用§6.5、§6.7、`streamText`、controlled fetch、native compile/prepareTransport、M4 K3或provider delegate。
- **Requires**：proof private brand/action/identity与closure exact；candidate/context/future type-9 operationID frozen；provider preparation count=0；sealed-use leases尚未acquire；runtime provenance可在不构造provider request的情况下确定audited target/gate。
- **连续步骤**：1) validate proof+closure exact；2) resolve audited adapter/target without provider preparation；3) opaque/disabled/unknown target返回typed unavailable planning cause且不建reservation；4) allocate fresh reservationID/gateReservationID/handleGenerationID；5) build keyed paused-handle commitment overreserved identities/target/body version；6) CAS insert exact `reserved-no-send` row；7) readback/return nominal reservation。
- **分支/退出/残留**：success恰一reservation；typed unavailable/error无slot/compilation/handle/lease/unsealed bytes。partial registry insert rollback/close。不存在replacement reservation或old-handle recreation。
- **Ensures**：provider preparation count与audited hit均0；reservation足以构造M1 lease key并唯一约束future exact AI SDK slot/native gate/handle；它不是sendable handle、prepared package、provider inspection或authority。
- **Side effects**：local registry/CSPRNG/keyed HMAC only；无provider/M4 write/unseal。
- **循环/等待**：finite registry/descriptor lookup，无external wait。
- **正确性论证**：call graph排除所有provider prepare/transport入口；fresh IDs+keyed commitment+single CAS建立唯一future handle identity，故K7可在actual preparation前安全绑定same commitment。

### 6.3.1 `prepareDispatch(input) -> M1.PlannedRecoveryMaterialization`

```ts
function prepareDispatch(input: Readonly<{
  candidate: M1.CandidateAssistantAttemptIdentity
  context: M1.CandidateDispatchAttemptContext
  operationID: M1.RecoveryOperationID
  snapshotProof: M4.AutomaticRecoveryProofSliceV1
  closure: M1.RecoveryClosureDescriptor
  sealedUseLeases: readonly M4.SealedRecoveryUseLeaseV1[]
  reservation: M2.PreparedHandleCommitmentReservationV1
  lowered: M7.LoweredRecoveryCandidate
  runtimeInput: LegacyRuntimeInput
}>): Effect.Effect<M1.PlannedRecoveryMaterialization<M2.AvailableDispatchHandle>, M2PrepareError>
```

- **Callers**：M6 `recoverIncomplete`只对same reservation恰调用一次。SafeRetry在K7 exact empty且M7返回无K3 candidate后直接调用；Continue只由M7 `reconstructProviderNeutralContinueMessages`的scoped `use(lowered)` continuation调用，此时same K7 leases已完成reconstruction/lowering且innermost K3 scopes仍live，`lowered`不得返回M6或逃逸该continuation。
- **Callees（pre/post）**：`M7.LoweredRecoveryCandidate`是post-K7唯一automatic semantic input；`validatePreparedHandleCommitmentReservation`证明candidate/context/operation/action/proof/closure/target/gate/generation/commitment exact且preparation count=0；chosen runtime的§6.5.1或§6.8是唯一reservation consume point并创建exact matching slot或compilation，随后§6.5/§6.7构造same handle；descriptor/§6.7.1从same paused object产生owner-qualified original `M2.M2InspectionResult`，available branch含final target/protocol/storage/body；M7 exact callable`validatePreparedRecoveryInspection({ candidate: lowered, inspection })`按inspection target校验same object；M1 `buildPreparedDigestInput`只使用automatic-recovery branch。
- **Requires**：snapshotProof是M5 selected nominal slice且与closure/lowered/action same identity；`sealedUseLeases`与closure/lowered实际使用sealed refs双向exact、全部state live/current positive generation并绑定same source/action/operation/candidate/reservation target+commitment；Continue的M7/K3 scoped continuation仍live且M4-owned plaintext bytes只在该dynamic scope内可达，SafeRetry则无K3/plaintext carrier scope；reservation registry仍`reserved-no-send`；provider preparation count=0；hit=0。M2不得retain、return、cache或log `lowered`/`semanticMessages`；actual paused preparation与original inspection/validation返回后，control必须直接退回same M7 continuation，使K3 bracket在所有exit清零M4-owned bytes。
- **连续步骤**：1) validate proof/closure/lease set/reservation/lowered exact；2) choose exactly one audited runtime branch and transfer the still-unconsumed reservation；AI SDK branch在§6.5.1安装exact slot时原子consume，native branch在§6.8创建exact paused compilation时原子consume，另一branch永久不可调用；3) execute exactly one paused provider preparation：AI SDK one fresh `streamText` until first controlled-fetch pause，或native consume-bearing `compilePausedInternal` exactly once；4) require actual slot/compilation generation、gateReservationID、targetDigest、prepared body version与paused commitment equal reservation；5) construct same `M2.AvailableDispatchHandle`，无second consume/slot/compile/prepare；6) original inspector on that object yields`M2.M2InspectionResult`；7) unavailable inspection→mechanical cancel，return unavailable descriptor without live handle；8) available inspection原样传M7 same-object validator；9) validator success后M1 builders produce exact available descriptor；10) return `{descriptor,pausedHandle:sameHandle}`；11) any error afterallocation mechanical-cancel but does not cleanup/close K7 itself；because exact unavailable/error output intentionally carriesnohandle，M6 calls§6.10.1 withsame reservation to construct `cancelled-handle|no-handle-barred`，thenK9，then§6.11.1 cleanup/reservation close。
- **分支/退出/残留**：available exact nested wrapper；typed unavailable descriptor only；M2 infrastructure error。所有non-success actual handle unsendable；lease仍live until caller K9。不存在descriptor extension、额外inspection wrapper、replacement reservation/inspection/prepare、old-handle recreation或hidden retry。
- **Ensures**：success reservation、actual slot/native object、original inspection、descriptor与separate handle是same generation/object且hit=0；provider-specific constraints只在original available inspection后运行；M4 O8 receives descriptor+same M2 proof+same lease set；F27 retains original wrapper and M2 later checks raw handle/reservation/release-validation identity。
- **Side effects**：exactly one paused local provider preparation/original inspection；failure mechanical cancel；无authority/release。M4/M2 retained secret bytes由K3 bracket与caller K9/cleanup全出口清零。
- **循环/等待**：AI SDK gate wait进度依赖first gate/pre-gate terminal/abort/cancellation；native finite compile；无second prepare或新增timeout。
- **正确性论证**：K7 happens-before与reservation single-consume固定secret generation和future handle identity；actual slot/compile逐字段match后唯一prepare/inspection；M7 same-object validation与M1 builders闭合final representation；所有错误在release前cancel且由caller K9关闭，故no-send、one-prepare与lease lifecycle同时成立。

### 6.3.2 `prepareSubsequentDispatch<K>(input: SubsequentDispatchPreparationInput<K>) -> LinearDispatchHandle`

```ts
function prepareSubsequentDispatch<
  K extends M4.CommittedAssistantAdmissionOperationV1,
>(
  input: SubsequentDispatchPreparationInput<K>,
): Effect.Effect<LinearDispatchHandle, M2PrepareError>
```

- **Callers**：§7.12 only，在closed current ordinal后，分别由accepted outer retry或audited unexpected model step选择closed `origin`；§6.12.1只消费本函数返回的handle/proof binding，不回调本函数。
- **Callees（pre/post）**：§6.1.1取得fresh runtime+provenance；§6.2按`origin:"outer-retry"`或`"unexpected-step"`选择adapter；§6.4/§6.5/§6.7返回一个candidate-stage handle，其`prepared.stateProof`是same context的`M2.PreparedUnreleasedHandleProofV1`；M1 `buildPreparedDigestInput`使用nonautomatic ordinary branch（type3 prepared dispatch kind fixed ordinary），禁止automatic source/action/closure fields。
- **Requires**：`input.authority.nonterminal===true`且来自exact M4 generic loader；prior ordinal已§6.12 closed/frozen；`input.context`是`authority.assistant`唯一fresh next-ordinal candidate context，ordinal恰为authority current+1且尚无ledger/handle/settlement；origin与触发事实exact；no delegate yet。
- **连续步骤**：1) closed-check authority conditional assistant/context与fresh context的session/assistantID；2) closed-check origin；3) fresh resolve runtime/provenance；4) resolve adapter；5) available调用§6.5/§6.7，opaque仅允许nonautomatic compatibility path并调用§6.4；6) 要求返回handle/context/package/proof逐项same；7) partial failure mechanical-cancel+cleanup；8) return one handle。
- **分支/退出/残留**：available、opaque、typed preparation error；任一success恰有一个lease/handle/proof，error无sendable residue。同invocation second fetch不是subsequent preparation trigger。
- **Ensures**：返回handle同时绑定committed assistant与fresh next-ordinal context，`auditedProviderTransportHitCount===0`，且只能交一次M4 type-3 commit；不分配settlement、不推进current ordinal、不release。
- **Side effects**：fresh local runtime/slot/compile、sealed scoped read、handle registry；无M4 write/provider delegate/attempt map mutation。
- **循环/等待**：AI SDK conditional gate progress同§6.5；无caller callback、controller cycle或新增timeout。
- **正确性论证**：closed input把assistant、next context与origin固定；single adapter call只产生一个handle generation；same-context proof validator阻止换绑；所有failure先cancel，因此post与零发送成立。

### 6.4 `prepareOpaqueDeferred(input) -> OpaqueDispatchHandle`

```ts
function prepareOpaqueDeferred(input: Readonly<{
  context: M1.CandidateDispatchAttemptContext
  semanticMessages: readonly ModelMessage[]
  cause: M1.RecoveryFailureCause
  runtimeInput: LegacyRuntimeInput
}>): Effect.Effect<OpaqueDispatchHandle, M2PrepareError>
```

- **Callers**：§6.3 only。
- **Callees（pre/post）**：M1 opaque admission builder/canonicalizer；provider invocation只封装进release closure。
- **Requires**：origin initial/ordinary；invocation可完整延迟。
- **步骤**：1) 构造deferred closure；2) 构造exact opaque `DispatchAdmissionV1`；3) 计算paused commitment；4) 注册finalizer；5) canonicalization失败关闭closure。
- **分支/退出/残留**：prepared opaque或typed error；error无closure reachability。
- **Ensures**：prepare hit=0；不伪造available字段；recovery不调用本函数。
- **Side effects**：closure/commitment/finalizer allocation only。
- **循环/等待**：无。
- **正确性论证**：provider factory只在release closure内可达，handle state阻止提前调用；故no-send与opaque post成立。

### 6.5 `prepareAISDKAvailable(input) -> AvailableDispatchHandle`

```ts
function prepareAISDKAvailable(input: Readonly<{
  context: M1.CandidateDispatchAttemptContext
  semanticMessages: readonly ModelMessage[]
  runtimeInput: LegacyRuntimeInput
  descriptor: AuditedAISDKDescriptor
  recoveryReservation?: M2.PreparedHandleCommitmentReservationV1
}>): Effect.Effect<AvailableDispatchHandle, M2PrepareError>
```

- **Callers**：§6.3、§6.3.1。
- **Callees（pre/post）**：§6.5.1安装唯一slot；§6.5.2启动fresh invocation；§6.6冻结first final fetch；M1 builders产生candidate admission/commitment。
- **Requires**：descriptor exact match；`maxRetries=0`；无active slot。automatic context必须提供still-live、尚未consume的`recoveryReservation`且K7已完成；nonautomatic context必须omit reservation并保持F26 ordinary path。
- **步骤**：1) automatic在§6.5.1按reservation exact `gateReservationID/handleGenerationID/pausedHandleCommitment/targetDigest`原子validate+consume并install唯一slot；nonautomatic fresh install ordinary slot且不触及recovery reservation registry；2) start fiber exactly once；3) await rendezvous；4) first arrival必须逐字段匹配已由slot消费的same reservation并在inspection success后build same admission+handle；5) typed unavailable/pre-fetch throw→mechanical cancel/close fiber并error；6) second arrival按§6.6 poison；7) automatic handle携same reservation，ordinary handle omit。
- **分支/退出/残留**：available handle；typed error；abort/cancellation。first delegated后的second arrival通知M3 ambiguity，不改写first事实。
- **Ensures**：返回时final transform完成、downstream fetch未调用、slot唯一。
- **Side effects**：fiber/Deferred/final request freeze；无M4/provider delegate。
- **循环/等待**：无算法循环；wait进度依赖provider到达gate、pre-gate terminal、AbortSignal或runner cancellation，明确不保证外部stream无条件终止且不新增timeout。
- **正确性论证**：slot CAS给唯一first；authorization Deferred阻断delegate；error finalizer关闭资源，故返回handle必paused/no-send。

### 6.5.1 `installAISDKGateSlot(context, descriptor) -> AISDKDispatchRuntime`

```ts
function installAISDKGateSlot(
  context: M1.CandidateDispatchAttemptContext,
  descriptor: AuditedAISDKDescriptor,
  recoveryReservation?: M2.PreparedHandleCommitmentReservationV1,
): AISDKDispatchRuntime
```

- **Callers**：§6.5。
- **Callees**：AtomicRef/Deferred constructors（fresh object post）。
- **Requires**：本invocation无slot。
- **步骤**：1) allocate invocationID与unpublished slot scratch；2) automatic以reservation exact gateReservationID/expected generation/commitment/target binding对M2 registry执行唯一原子consume，成功后把same fields写入slot；ordinary fresh allocate且不携recovery fields；3) allocate Deferred/refs；4) bind exact context+descriptor；5) publish only to this invocation scope。automatic consume后的任何本地失败必须使slot不可达并由caller按K9→M2 close/cleanup顺序终结，不得尝试native branch或second slot。
- **分支/退出/残留**：allocation success或typed defect before publication；reservation mismatch/duplicate consume失败无partial published slot；consume后allocation defect留下unsendable scope-owned residue，不能第二次consume。
- **Ensures**：fetchArrivals=0、phase=constructed、single slot；automatic slot exact matchespre-K7 reservation，ordinary slot不伪造reservation。
- **Side effects**：内存分配。
- **循环/等待**：无。
- **正确性论证**：fresh constructors与single publication直接推出唯一性；无外部callee，副作用穷尽。

### 6.5.2 `startAISDKInvocationFiber(input) -> AISDKInvocationFiber`

```ts
function startAISDKInvocationFiber(input: Readonly<{
  runtime: AISDKDispatchRuntime
  language: LanguageModelV3
  semanticMessages: readonly ModelMessage[]
  abort: AbortSignal
}>): Effect.Effect<Fiber.RuntimeFiber<void, M2PrepareError>, M2PrepareError>
```

- **Callers**：§6.5。
- **Callees（pre/post）**：AI SDK `streamText` local construction with `maxRetries=0`; controlled fetch calls§6.6。
- **Requires**：runtime constructed、slot unpublished elsewhere。
- **步骤**：1) bind runtime context；2) construct stream once；3) start consumption until gate/terminal；4) map pre-gate error；5) abort interrupts fiber and closes slot。
- **分支/退出/残留**：fiber started；construction error；abort。started fiber remains scope-owned until handle cleanup/release。
- **Ensures**：fresh invocation恰一次；不自行retry或申请第二slot。
- **Side effects**：managed fiber/local provider request construction。
- **循环/等待**：external stream progress only via gate/terminal/abort/cancellation；no unconditional termination claim。
- **正确性论证**：single stream construction+`maxRetries=0`给fresh boundary；scope finalizer穷尽fiber residue。

### 6.6 `inspectAndPauseFinalFetch(runtime, request) -> Response`

```ts
function inspectAndPauseFinalFetch(runtime: AISDKDispatchRuntime, request: Request): Promise<Response>
```

- **Callers**：controlled fetch wrapper only。
- **Callees（pre/post）**：descriptor inspector pure；authorization Deferred；configured downstream fetch only on authorized first branch。
- **Requires**：request final；runtime/context/provenance exact；downstream未调用。
- **步骤**：1) atomic increment arrivals；2) count=1 freeze request并inspect；3) unavailable→cancel/throw；4) success complete rendezvous；5) await release/cancel；6) release owner在canonical handle仍`authorized/held/not-delegated`时完成local fetch-argument validation；任一同步pre-call failure返回`known-not-delegated`且不触碰boundary recorder；7) exact configured downstream fetch call site先调用`boundary.recordDelegated()`，原子形成released/delegated proof，再调用downstream exactly once；downstream同步throw返回delegated-error withsame proof；8) 若wrapper无法证明call site是否跨越则调用`recordUnknownDelivery`并返回unknown，绝不cancel/resend；9) cancel throws；10) count>1 poison and fail before this arrival's downstream call。
- **分支/退出/残留**：Response/delegated proof、known-not-delegated、unknown terminal、cancelled/unavailable/second-fetch/abort error；first already delegated/unknown时second only reports inconsistency。
- **Ensures**：matching first release最多一次downstream；authorize与exclusive-latch local pre-call阶段均不调用delegate；only boundary recorder transitions released。
- **Side effects**：pause/state signal；delegated boundary之后provider I/O。
- **循环/等待**：Deferred wait advances only on authorize/cancel/abort; no new deadline。
- **正确性论证**：arrival CAS唯一化first request；canonical release latch排除cancel/release race；boundary CAS happens-before downstream call，所有known failure在call site前退出，故at-most-once且state准确。

### 6.7 `prepareNativeAvailable(input) -> AvailableDispatchHandle`

```ts
function prepareNativeAvailable(input: Readonly<{
  context: M1.CandidateDispatchAttemptContext
  semanticMessages: readonly ModelMessage[]
  runtimeInput: LegacyRuntimeInput
  recoveryReservation?: M2.PreparedHandleCommitmentReservationV1
}>): Effect.Effect<AvailableDispatchHandle, M2PrepareError>
```

- **Callers**：§6.3、§6.3.1。
- **Callees（pre/post）**：§6.8 single compile；§6.7.1 exact inspection；M1 admission/commitment builders。
- **Requires**：audited HTTP JSON route；WebSocket/custom excluded；remote auth side effect excluded。automatic必须提供K7-after、still-valid且尚未consume的reservation；nonautomatic必须omit。
- **步骤**：1) build native request scratch without provider preparation；2) automatic把reservation exact generation/gate/target/commitment绑定到compile input，ordinary走fresh ordinary input；3) call§6.8 exactly once；automatic由§6.8在paused compilation创建点原子consume，ordinary不触及recovery registry；4) require compilation IDs/target/body version exact match reservation（automatic）；5) inspect same private prepared object；6) success build admission/handle并automatic携same reservation；7) failure mechanical cancel/zeroize，K9由caller先close后cleanup；不得回退AI SDK branch或second compile。
- **分支/退出/残留**：available or typed error；error无execute closure reachability。
- **Ensures**：body/prepareTransport各一次，release复用same object，hit=0。
- **Side effects**：local auth/encoding/sealed scope/allocation。
- **循环/等待**：finite compile; no external wait。
- **正确性论证**：single generation object同时供inspection与release，排除recompile/object swap。

### 6.7.1 `inspectNativePreparedRequest(compilation) -> M2.M2InspectionResult`

```ts
function inspectNativePreparedRequest(compilation: NativePausedCompilation): M2.M2InspectionResult
```

- **Callers**：§6.7。
- **Callees**：audited native descriptor + M1 canonical builders。
- **Requires**：compilation未execute且route HTTP JSON。
- **步骤**：1) validate route/target/authority/storage；2) canonicalize semantic/prepared facts；3) build available admission；4) any mismatch map exact cause。
- **分支/退出/残留**：available/unavailable；无throw跨boundary。
- **Ensures**：available facts来自same private object；unavailable无partial proof。
- **Side effects**：无（短期secret view在caller scope）。
- **循环**：finite fields。
- **正确性论证**：same-object read+C-M1 exact builders建立binding；closed mismatch mapping保证fail closed。

### 6.8 `LLMClient.compilePausedInternal(request) -> NativePausedCompilation`

```ts
function compilePausedInternal(
  request: LLMRequest,
  recoveryReservation?: M2.PreparedHandleCommitmentReservationV1,
): Effect.Effect<NativePausedCompilation, LLMError>
```

- **Callers**：§6.7。
- **Callees（pre/post）**：`resolveRequestOptions`、body/schema、`prepareTransport`各按owner contract本地执行并返回same generation object。
- **Requires**：route configured；caller不并发复用result。
- **步骤**：validate route与unpublished compile scratch→若automatic则在任何body/schema/prepareTransport materialization前，以reservation target/gate/generation/commitment对M2 registry执行唯一原子compare+consume→resolve→body/schema→prepareTransport once→freeze private object with same reservation IDs→return；任一步error释放buffers且不允许second compile/AI SDK fallback。
- **分支/退出/残留**：compilation或typed LLMError；无transport side effect。automatic mismatch/duplicate consume在compile materialization前失败；consume后failure留下unsendable scope-owned residue供caller K9→cleanup，不能重新consume；ordinary无reservation branch保持原行为。
- **Ensures**：不调用`streamPrepared`；generation一致；automatic exact match reservation，ordinary不隐藏第二prepare。
- **Side effects**：local cache/auth/encoding/allocation。
- **循环**：callee finite；无wait。
- **正确性论证**：顺序单次调用建立compile exactly once；调用图不含execute，故hit=0。

### 6.9 `authorizeDispatch(input) -> AuthorizedDispatch`

```ts
function authorizeDispatch(
  input: DispatchAuthorizationInput,
): Effect.Effect<AuthorizedDispatch, DispatchAuthorizationError>
```

- **Callers**：M6/M3 after exact commit result。
- **Callees（pre/post）**：nonautomatic branch只调用M1 F26并传`result.receipt + result.operationPostState + handle commitment`；automatic branch先消费M4 `validateSealedRecoveryUseLeasesImmediatelyBeforeRelease`返回的exact nominal `SealedRecoveryUseReleaseValidationV1`，再调用M1 F27 exact signature并传`result.receipt + proposal + planned + result.operationPostState`；F27读取`planned.descriptor` facts，M2独立比较raw handle/reservation/commitment/live lease proof；AtomicRef CAS。F26不接收runtime wrapper或leases，F27不拥有raw handle/lease lifecycle。
- **Requires**：`input.handle` prepared；caller持完整owner result，不是detached receipt。automatic branch必须传M5最终validated proposal、same original available wrapper/handle/reservation、complete K7 lease tuple及紧邻本调用新取得的K8 release validation；proof中的snapshot identity、sorted lease IDs/key digests/closure binding、operationID、prepared commitment逐字段等于result/planned/reservation/handle，leases仍live/current generation。nonautomatic branch在type上禁止proposal/planned/reservation/leases/proof且只走F26。
- **步骤**：1) switch `input.kind`；2) nonautomatic closed-check三个operation discriminators并调用F26；3) automatic require complete type-9 result and fresh pre-release K8 proof；4) compare proof↔result operation↔lease tuple↔reservation↔planned descriptor↔raw same handle；5) callF27 on original wrapper；6) compare candidate→committed derivation；7) validation success后以单个CAS把`prepared`变为`authorized{receiptCommitment,releaseLatch:{tag:"open"}}`，并在同一linearization point构造逐字段绑定的`M2.ReleaseCallableProofV1`；8) return `AuthorizedDispatch` carrying that proof and, for automatic, `automaticLeaseClosure`；9) any mismatch mechanical-cancel，automatic caller必须K9 close/zeroize成功后才cleanup/lookup/replan。
- **分支/退出/残留**：nonautomatic F26 authorized/open；automatic K8+F27 authorized/open；state/result/binding/proposal/planned/reservation/lease/proof error。每个success branch都可构造exact release-callable proof；error无delegate，automatic lease remains live only untilmandatory K9 close。
- **Ensures**：authorized wrapper绑定exact complete result、same handle与valid `releaseCallableProof`；canonical handle state仍未released且latch open。automatic额外绑定same reservation/live lease set/pre-release K8 proof；committed context来自validated operationPostState/receipt pair。
- **Side effects**：pure validation+M4 read proof consumption+one CAS；无provider hit。
- **循环**：finite lease set comparison；无wait。
- **正确性论证**：complete result→fresh K8→F27建立automatic authority，M2 raw identity comparison防handle substitution；同一CAS同时建立authorized/open state与constructible callable proof。任何failure不触及delegate，并在automatic branch严格执行cancel→K9→cleanup后才做其它work。

### 6.10 `releaseDispatch(authorized) -> ReleasedStream`

```ts
function releaseDispatch(
  authorized: AuthorizedDispatch,
): Effect.Effect<ReleasedStream, DispatchReleaseError | FatalRecoveryStop>
```

- **Callers**：M3/M6 execution。
- **Callees（pre/post）**：`validateReleaseCallableProofV1`；handle `releaseDelegate(boundary)`各自最多一次；`ReleaseDelegateBoundary.recordDelegated`/`recordUnknownDelivery`是唯一delegate-boundary state writers；native delegate是§6.13；automatic每个terminal branch必须调用M4 K9 `closeSealedRecoveryUseLeases`，K9成功后才§6.11.1/M2 reservation close。
- **Requires**：canonical handle是`authorized/releaseLatch:open`，`authorized.releaseCallableProof`逐字段live且ownership live、complete result未被替换；historical exact result永不因后来policy变化撤销。automatic必须携complete result之后紧邻取得、已由F27/M2 authorize消费且仍在dynamic release scope内的K8 proof、same live lease tuple与same reservation；authorize后不得有其它authority/prepare/unseal步骤。
- **连续步骤**：1) validate release-callable proof；automatic recompare K8 proof object identity/operation/commitment and lease tuple；reachable validation failure whilecanonical state remainsprepared/authorized-open calls§6.10.1→K9→cleanup beforereturn；2) allocate fresh `latchID` and CAS `authorized/open -> authorized/held/not-delegated`；underRely this CAS hasone owner。Unexpected loser rereadsstate：stillcancellable→§6.10.1→K9→cleanup；held indicatesforbidden concurrent release and returnsfatal withoutcancel/cleanup untilowner terminal；released/cancelled returnsclosed invariant failure，绝不调用delegate；3) 在exclusive latch内做仅本地的final state/proof validation与delegate synchronous pre-call setup；整个阶段canonical handle仍是`authorized`且boundary=`not-delegated`，§6.11与第二release都不得并发进入；4) 若local validation或synchronous pre-delegation setup以exact boundary proof失败，CAS `authorized/held/not-delegated -> authorized/open`退出latch，随后§6.11机械cancel `authorized/open -> cancelled`；automatic立即K9 reason`mechanically-cancelled`并zeroize，K9失败则在任何cleanup/lookup前返回`FatalRecoveryStop(handleDisposition:"mechanically-cancelled-unsendable")`；K9成功后cleanup/close reservation，再返回constructible known-not-delegated `DispatchReleaseError`；5) 否则仅调用same `releaseDelegate(boundary)`一次；delegate在exact call boundary必须先调用`recordDelegated`，以同一canonical CAS把`authorized/held/not-delegated -> released/delegated`并构造`DelegatedReleaseProofV1`，然后才越过provider delegate boundary；6) `delegated-stream|delegated-error`必须携同一proof；automatic立即K9 reason`released`并zeroize，K9失败在cleanup前fatal且绝不second release；K9成功后cleanup/close reservation。stream branch返回`ReleasedStream`并把exact result及proof-derived context/generation/commitment带入`authorization{releaseCallableProofState:"consumed"}`（不保留handle/closure），不再暴露可调用proof；delegated-error返回constructible`DispatchReleaseError{sendState:"delegated",terminalState:"released-delegated",releaseProof,...}`，不得same-handle retry；7) 若delegate boundary是否越过无法确定，唯一合法动作是`recordUnknownDelivery`把held state原子变为`released/unknown-delivery`并构造`UnknownDeliveryReleaseProofV1`；automatic立即K9 reason`abandoned`并zeroize，K9失败在cleanup/lookup前fatal；K9成功后cleanup/close reservation，返回`FatalRecoveryStop(cause: DispatchReleaseError{sendState:"unknown",terminalState:"released-unknown-delivery",...},handleDisposition:"released-or-unknown")`；禁止cancel、A5驱动resend、same/new handle resend或把unknown降级为known-unsent；8) delegate返回`known-not-delegated`只允许boundary仍held/not-delegated，并严格复用step4；若outcome与canonical boundary proof不一致，转step7 unknown terminal而不是猜测；9) 每branch counters固定：latch acquire≤1、delegate invocation≤1、delegated/unknown terminal CAS恰一或known branch cancel CAS恰一、automatic K9 attempt恰一、provider delegate hit仅可发生在delegated boundary CAS之后。
- **分支/退出/残留**：delegated stream or delegated terminal error only afterK9 close success；known-not-delegated cancelled error；released-unknown-delivery fatal ambiguity；latch/state/proof failure；K9 fatal。所有可安全清理branch在K9成功后zeroize/cleanup；K9失败保留lease relation供fatal handling，不先cleanup。closed audit rows可留存但不授权use。
- **Ensures**：本地delegate at-most-once；canonical state在delegate boundary前绝不离开authorized；same handle不retry。automatic lease从live单向closed且provider hit在delegated boundary前恒0；unknown terminal不可cancel/resend；无TTL/old-proof reuse。
- **Side effects**：exclusive canonical state CAS、provider I/O/stream resource、M4 K9 SQLite close、K9后M2 cleanup/zeroize。
- **循环/等待**：finite lease close；provider stream completion不在本函数；call establishment依赖delegate outcome/error/abort，不保证远端终止。
- **正确性论证**：complete result→pre-release K8→F27/M2 authorize产生open callable proof；exclusive latch把所有local pre-call work保持在authorized/not-delegated且排除concurrent cancel/release；只有boundary recorder可形成released delegated/unknown terminal。known branch先退latch再cancel，所有automatic terminal branch在任何cleanup/lookup前K9，故state/proof均可构造、same handle/lease不可重放且fatal ambiguity不被误当未发送。

### 6.10.1 `mechanicallyCancelAutomaticPreRelease(input) -> AutomaticPreReleaseCancellationV1`

```ts
function mechanicallyCancelAutomaticPreRelease(input: Readonly<{
  reservation: M2.PreparedHandleCommitmentReservationV1
  expectedContext: M1.CandidateDispatchAttemptContext
  cause: string
}>): Effect.Effect<M2.AutomaticPreReleaseCancellationV1, M2.MechanicalCancelError | M2.PreparedHandleReservationValidationErrorV1>
```

- **Callers**：§9.8/§9.9 every automatic failure afterreservation and beforedelegate boundary，including M7/lowering、prepare/inspection、M5、O8 CAS loser/response ambiguity、pre-release K8/F27/authorization failure。
- **Callees**：M2 reservation/handle registry CAS；§6.11 whenan exact handle exists；`proveNoPreparedHandleV1` whennone exists。
- **Requires**：same reservation/context；delegate boundary not recorded。Caller has not invokedK9/cleanup/lookup。
- **连续步骤**：1) validate reservation/context/generation；2) atomically inspect registry；3) exact prepared/authorized-open handle→§6.11 cancel and return`cancelled-handle`；4) exact same reservation/context/generation的live registry handle已是`cancelled`（例如prepare/inspection或authorization owner已先机械cancel）→把same handle交§6.11 already-cancelled branch，零state transition取得byte-equivalent `M2.MechanicallyCancelledUnreleasedHandleProofV1`并返回`cancelled-handle`；5) reservation not yetmaterialized or failed beforehandle publication→atomically bar allfuture consume/handle publication, advance registry generation, provecurrent no-handle, return`no-handle-barred`；6) authorized-held returnsrelease-in-progress；7) released delegated/unknown returnsalready-released exact delivery；8) no replacement reservation/handle。
- **分支/退出/残留**：two constructible success variants；`cancelled-handle`覆盖本函数执行cancel与owner在调用前已完成same exact cancel两种来源，后者不重复CAS。其它退出是typed held/released/registry failure。Success is the mandatory mechanical barrier beforeK9；it doesnot cleanup/lookup/classify。
- **Ensures**：success proves no delegate can subsequently be reached fromthis reservation；handle branch始终返回same exact byte-equivalent cancel proof，无论cancel transition由本函数还是same owner先完成；no-handle branch hasexact current no-handle proof and`futureReservationConsumeAllowed:false`。
- **Side effects**：M2 canonical registry/state CAS only；already-cancelled branch为registry read+proof reconstruction，state mutation=0。
- **循环**：finite CAS reread；held/terminal exits；already-cancelled直接返回。
- **正确性论证**：single registry linearization闭合“handle仍可cancel”“same handle已由owner cancel”与“handle从未可发布”三branch；§6.11的already-cancelled byte-equivalent proof保证第二branch不依赖重复transition。故unchanged`prepareDispatch` result signature不必暴露failed partial handle，caller在所有known-unsent registry state都可构造K9前的closed cancellation disposition。

### 6.11 `mechanicallyCancelDispatch(handle, cause) -> MechanicallyCancelledDispatch`

```ts
function mechanicallyCancelDispatch(handle: LinearDispatchHandle, cause: string): Effect.Effect<
  MechanicallyCancelledDispatch,
  M2.MechanicalCancelError
>
```

- **Callers**：所有pre-release failure、ManualStop、supersession、finalizer；`releaseDispatch` known-not-delegated branch only after it has exited the latch back toauthorized/open。
- **Callees**：canonical `HandleState` CAS + Deferred cancel signal。
- **Requires**：cause脱敏；caller不持release latch。finalizer遇held state不得抢占release owner。
- **步骤**：1) read state/lease registry；2) `prepared`或`authorized/open` CAS cancelled并unlink release closure；3) 原子构造与same lease/context/generation/commitment绑定的`M2.MechanicallyCancelledUnreleasedHandleProofV1`；4) already-cancelled只在same live cancelled registry entry下返回byte-equivalent proof；5) `authorized/held`返回`release-in-progress`且不改变state/closure/Deferred；6) released/delegated或released/unknown返回含exact delivery的`already-released`，不伪造cancel proof。
- **分支/退出/残留**：`M2.MechanicallyCancelledDispatch`（含exact proof）、release-in-progress或already-released；CAS race重读有限直到closed branch。automatic caller成功cancel后必须立即K9，K9成功前不得cleanup/lookup/replan。
- **Ensures**：success时send closure永久不可达且proof可由M4调用`M2.validateMechanicallyCancelledUnreleasedHandleProofV1`验证；held/released分支均零mutation，故cancel与release不并发。
- **Side effects**：AtomicRef/Deferred only。
- **循环**：CAS retry measure为有限state transitions；每次race观察更晚monotonic state，held或terminal立即退出。
- **正确性论证**：single canonical state排除held cancellation；closure每次调用前检查state，successful cancel直接推出unsendable；无cleanup/provider副作用。

### 6.11.1 `cleanupDispatch(input) -> DispatchCleanupResult`

```ts
function cleanupDispatch(
  input: DispatchCleanupInput,
): Effect.Effect<DispatchCleanupResult>
```

- **Callers**：cancel/commit/fatal finalizers、released stream/unknown-delivery finalizer；automatic only aftersuccessful K9。
- **Callees**：AbortController、fiber interrupt/join、native buffers、M4 sealed plaintext scope cleanup、M2 lease registry、diagnostic sink。
- **Requires**：机械状态已terminal；不得用released token证明unsent。automatic handle若携recovery reservation/leases，caller已成功调用K9；K9 failure时禁止进入本函数，因为cleanup会丢失live lease relation。`proofRetention:"manual-stop-tombstone"`只允许mechanically-cancelled automatic branch（direct或`AutomaticPreReleaseCancellationV1.tag="cancelled-handle"`）且caller仍可能按§9.9/§9.10进入type-8；no-handle/released/其它cancel branch必须invalidate。
- **步骤**：1) snapshot finite resources；`automatic-pre-release-cancelled`通过reservation从registry取得exact cancelled handle residue或barred no-handle row；2)逐项interrupt/close/zeroize/remove，包括M2 retained unsealed/lowered/final-body scratch；3) close/consume exact reservation terminal state；4) cancelled-handle+manual-stop retention时删除closure/fiber/buffers/secret并把registry entry缩减为secret-free one-shot tombstone，返回same nominal cancel proof；no-handle或其它branch原子移除exact lease/generation entry；5) defect记录脱敏diagnostic并继续；6) type-8 result resolution或branch确定不ManualStop后，final cleanup使tombstone invalid。
- **分支/退出/残留**：`closed`或`manual-stop-tombstone`；diagnostic defect不改变chosen result。M4 K9 failure由caller保持fatal，不得调用本函数。tombstone仅含proof validation所需nonsecret identity，send closure/retained bytes均不存在。
- **Ensures**：幂等；不release、不改变durable outcome；所有M2 secret/resource residue已清零。closed branch的proof/reservation被validators拒绝；tombstone branch仅same cancel proof可验证一次且type-8 resolution后拒绝。
- **Side effects**：local resource cleanup/diagnostic + optional secret-free tombstone only。
- **循环**：fixed finite resource set，每轮删除一项。
- **正确性论证**：cleanup不持有release transition能力；遍历穷尽资源集合。one-shot tombstone把“cleanup先于A5/S2”与“ManualStop validator仍有exact cancel proof”同时成立，且不保留lease secret或sendability。

### 6.12 `closeDispatchInvocationRuntime(input) -> ClosedDispatchRuntime`

```ts
function closeDispatchInvocationRuntime(input: Readonly<{
  settlement: DispatchOrdinalSettlement
  runtime: AISDKDispatchRuntime | NativePausedCompilation
  cause: "retry" | "terminal" | "abort" | "superseded"
}>): Effect.Effect<Readonly<{ dispatchOrdinal: M1.SafeNonNegativeInt; closed: true }>, TerminalSettlementError>
```

- **Callers**：§6.12.1、M3 terminal path。
- **Callees（pre/post）**：M3 drain for exact ordinal、stream close/abort、§6.11.1 cleanup。
- **Requires**：settlement ordinal等于runtime context且仍current。
- **步骤**：1) reject cross-ordinal input；2) close intake；3) cause决定graceful close或abort；4) drain exact ordinal；5) freeze summary；6) cleanup runtime。
- **分支/退出/残留**：closed；drain/write failure fatal；external body wait遵循M3 progress contract。
- **Ensures**：previous ordinal sealed后才能创建next；无event可写入next object。
- **Side effects**：close/abort/evidence settlement/cleanup。
- **循环/等待**：finite evidence set；external tool wait只依赖terminal/abort/cancellation，不承诺无条件终止。
- **正确性论证**：ordinal equality+intake close建立隔离；drain后freeze建立retry前置，故跨ordinal contamination不可达。

### 6.12.1 `recordAndAuthorizeSubsequentDispatch<K>(input) -> AuthorizedDispatch`

```ts
function recordAndAuthorizeSubsequentDispatch<
  K extends M4.CommittedAssistantAdmissionOperationV1,
>(input: Readonly<{
  authority: M4.CommittedAssistantAuthorityViewV1<K>
  previousSettlement: DispatchOrdinalSettlement
  context: M1.CandidateDispatchAttemptContext
  origin: SubsequentOrigin
  prepared: LinearDispatchHandle
  operationID: M1.RecoveryOperationID
}>): Effect.Effect<AuthorizedDispatch, DispatchAbandonment | FatalRecoveryStop>
```

- **Callers**：§7.12 only，在§6.12 close与§6.3.2 single preparation之后调用。
- **Callees（pre/post）**：M4 `commitSubsequentDispatch`返回exact complete M1 result；§9.11 resolves response loss；§6.9 nonautomatic branch只调用M1 F26并authorizes same handle。
- **Requires**：`authority`来自SESSREC-2 generic committed-assistant loader且仍绑定same assistant/current dispatch；`previousSettlement`已closed/frozen并等于authority current ordinal；`context`是fresh next ordinal且等于previous+1；`prepared.context===context`且含same-context prepared proof；origin exact；no delegate；attempt destination尚无next ordinal object。
- **连续步骤**：1) compare authority/previous/context/origin/prepared binding；2) build exact M1 type-3 input withstable operationID、current predecessor与next ordinal；3) call M4 with`prepared.prepared`；4) success/exact replay consume full `OperationCommitResultV1<"subsequent-dispatch-recorded">`；5) response unknown按§9.11；6) conflict/partial/corrupt/persistence/ambiguity mechanical-cancel并settle/fatal；7) call§6.9 `kind:"initial-ordinary-or-subsequent"`，只经F26验证complete result+same handle；8) return authorized。
- **分支/退出/残留**：authorized fresh type-3 result；known-no-send abandonment；unknown ambiguity；fatal authority。No branch prepares replacement、allocates settlement、mutatescurrent ordinal或rotates second fetch。
- **Ensures**：success has exactly one new operationID/context/handle/ledger and remains unreleased；ordinal settlement尚未分配，caller必须随后对exact attempt destination调用§7.0.1一次。failure无sendable residue。
- **Side effects**：M4 write/read、handle authorize/cancel；无old close、fresh prepare、settlement allocation或release。
- **循环/等待**：response loss bound exactly§9.11；retry wait/close/prepare由caller顺序拥有，无callback cycle。
- **正确性论证**：pre显式证明old close与single prepared handle；M4 receipt是next ordinal authority；F26只授权same handle；把settlement allocation移出本函数消除hidden mutation与double allocation。

### 6.13 `executeNativeGatedOnce(compilation, boundary) -> ReleaseDelegateOutcome`

```ts
function executeNativeGatedOnce(
  compilation: NativePausedCompilation,
  boundary: ReleaseDelegateBoundary,
): Effect.Effect<ReleaseDelegateOutcome, LLMError>
```

- **Callers**：native handle release delegate。
- **Callees（pre/post）**：existing `streamPrepared/executeOnce` on `compilation.privatePrepared`, boundary recorder, error mapper；caller exclusive latch guarantees one call。
- **Requires**：matching ledger committed；same compilation未execute；canonical handle仍`authorized/held/not-delegated`且boundary latchID exact。
- **步骤**：1) validate generation/private object及所有local execute arguments；同步失败返回`known-not-delegated`，state仍held；2) exact `streamPrepared/executeOnce` call site先调用`boundary.recordDelegated()`，原子形成released/delegated proof；3) call execute once；sync error returns`delegated-error` withsame proof；4) map response to event stream并携same proof返回`delegated-stream`；5) 若transport wrapper无法证明step2/call边界是否发生，则只调用`recordUnknownDelivery`并返回unknown；不调用任何retry predicate。
- **分支/退出/残留**：delegated stream/proof、known-not-delegated或unknown proof；429/503/504/529等在delegated之后仅map/return，是否outer retry只由`SessionRetry.policy`决定。outcome/proof mismatch由§6.10转unknown terminal。
- **Ensures**：native internal retry count=0；physical execute≤1；released transition仅在delegate boundary recorder。
- **Side effects**：boundary CAS后one HTTP execute/stream resource。
- **循环/等待**：无retry loop；network progress依赖response/error/abort/cancellation，不声称无条件终止。
- **正确性论证**：local validation全部在authorized/held完成；唯一execute call site前的boundary CAS与无schedule/recursion直接推出internal retry 0、constructible proof与准确known/unknown partition。

## 7. M3 — Execution Evidence and Terminal Settlement

### 7.0.1 `allocateDispatchOrdinalSettlement(input) -> DispatchOrdinalSettlement`

```ts
function allocateDispatchOrdinalSettlement(input: Readonly<{
  authorized: AuthorizedDispatch
  destination: DispatchOrdinalSettlementDestination
}>): Effect.Effect<DispatchOrdinalSettlement, TerminalSettlementError>
```

- **Callers**：§9.6在empty attempt上分配ordinal-0 exactly once；§7.12在每个type-3 authorization后分配subsequent ordinal exactly once。admission、automatic commit、prepare、record与authorize helpers均不得调用本函数。
- **Callees（pre/post）**：`authorized`已由§6.9完成closed F26(nonautomatic)/F27(automatic) validation；本函数只读取complete result中的committed context/ordinal/operationID并调用fresh AtomicRef constructors、exact map insert/current CAS。
- **Requires**：caller传complete `authorized`而非detached receipt；`destination.assistant`与committed context same；`destination.byOrdinal/currentOrdinal/settledOrdinalSummaries`恰来自同一个fresh/live attempt；current ref byte-equal `expectedCurrentOrdinal`；result ordinal byte-equal `expectedNewOrdinal`。ordinal-0要求`expectedCurrentOrdinal===undefined`、maps empty、`expectedNewOrdinal===0`；subsequent要求prior ordinal object已closed/frozen且`expectedNewOrdinal=expectedCurrentOrdinal+1`。
- **连续步骤**：1) read authorized complete result and committed context；2) validate same assistant/destination objects；3) validate current ref and map keys against expected current；4) validate genesis0或contiguous next；5) validate prior closed/frozen for subsequent；6) allocate fresh provider/terminal refs；7) insert exact new key iff absent；8) CAS current from expected to new；9) if CAS fails, remove only this call's still-unpublished insert and return typed inconsistency；10) return object。
- **分支/退出/残留**：fresh object；duplicate/gap/current-race/cross-assistant/destination-mismatch typed inconsistency。Failure never replaces old entry, never leaves current advanced without matching map entry, and never retries allocation。
- **Ensures**：每个committed ordinal恰一fresh object；ordinal0与每个subsequent各分配一次；对象不继承旧settled/incomplete/fetch flag；no hidden prepare/commit/release mutation。
- **Side effects**：only the exact passed attempt-local map/current CAS；不调用M1 F26/F27、M2、M4或provider。
- **循环**：无；single compare/insert/CAS，无caller cycle。
- **正确性论证**：§6.9已建立transport authority；explicit destination+expected transition把唯一mutation暴露给caller；insert/CAS compensation保持map/current一致；fresh constructors与duplicate guard建立ordinal↔object一一对应。

### 7.1 `LegacyToolExecutionGate.wrapTool(input) -> AITool`

```ts
function wrapTool(input: Readonly<{ owner: M1.CommittedAssistantAttemptIdentity; dispatchOwner: ToolInvocationHandle["dispatchOwner"]; tool: AITool }>): Effect.Effect<AITool, ToolExecutionGateError>
```

- **Callers**：registry/MCP/workflow/native/StructuredOutput final tool assembly。
- **Callees**：§7.2 closure。
- **Requires**：identity/schema pure normalization完成；raw execute尚未暴露。
- **步骤**：1) copy metadata；2) no execute→return non-executable；3) existing marker same owner→reuse；4) foreign marker→error；5) replace execute with§7.2 closure。
- **分支/退出/残留**：non-executable、wrapped、reused、typed conflict。
- **Ensures**：所有reachable execute经two-fence gate。
- **Side effects**：wrapper/closure allocation。
- **循环**：无。
- **正确性论证**：exhaustive marker/execute switch覆盖所有入口；唯一replacement保证post；无runtime call故副作用穷尽。

### 7.1.1 `executePreplannedSubtaskThroughGate(input) -> ToolResult`

```ts
function executePreplannedSubtaskThroughGate(input: Readonly<{
  ownerAssistant: M1.CommittedAssistantAttemptIdentity
  subtaskPart: SessionV1.SubtaskPart
  taskTool: AITool
  runtime: ToolRuntimeContext
}>): Effect.Effect<ToolResult, ToolExecutionGateError | FatalRecoveryStop>
```

- **Callers**：`runModelChain` preplanned local branch。
- **Callees（pre/post）**：§7.3→§7.4→§7.5→§7.6→§7.6.1→§7.7；TaskTool only in §7.6。
- **Requires**：call complete/unique；无running projection/hook/permission/body side effect；使用`preplanned-local` owner而非伪造provider ordinal。
- **连续步骤**：1) pure raw+operationID；2) raw fence；3) before hook once；4) pure plan；5) final-plan fence；6) selected body≤1；7) body outcome commit；8) after hook+final settlement；9) return。
- **分支/退出/残留**：每个commit failure阻断下一副作用；hook throw/body error/interrupt/uncertain均settle，settlement failure fatal且不重跑body。
- **Ensures**：raw fence happens-before hook，plan fence happens-before body，body 0/1。
- **Side effects**：M4 evidence/projection、plugin/permission/TaskTool/subagent/abort；无current assistant dispatch ledger mutation。
- **循环/等待**：adapter无循环；TaskTool进度依callee terminal/abort/cancellation，不引入timeout。
- **正确性论证**：唯一连续callee chain及每个receipt gate阻断越序；§7.6唯一body call site；故two fences和at-most-once成立。

### 7.2 `executeToolInvocation(input) -> ToolResult`

```ts
function executeToolInvocation(input: Readonly<{
  owner: M1.CommittedAssistantAttemptIdentity
  dispatch: M1.CommittedDispatchAttemptContext
  callID: string
  toolName: string
  args: unknown
  execute: (args: unknown, runtime: ToolRuntimeContext) => Promise<unknown>
  runtime: ToolRuntimeContext
}>): Effect.Effect<ToolResult, ToolExecutionGateError | FatalRecoveryStop>
```

- **Callers**：wrapped provider tool execute。
- **Callees（pre/post）**：§7.3–§7.7与plugin before/after exact owner contracts。
- **Requires**：dispatch equals current ordinal settlement；call complete/unique；schema repair完成。
- **步骤**：1) raw fence；2) before hook once；3) hook throw→error settlement/body0；4) normalize plan；5) plan fence；6) short-circuit 0 body或execute/replacement 1 body；7) commit body outcome；8) after hook once；9) final settlement；10) only then resolve Deferred/return。
- **分支/退出/残留**：begin/plan failure side effects=0 for later phases；body completed/error/interrupted/uncertain；after throw不rerun body；settlement failure fatal with unresolved trusted result。
- **Ensures**：two-fence order、body≤1、durable terminal evidence before Deferred。
- **Side effects**：M4 evidence/projection、hooks、permission/MCP/local body、attempt-local capture。
- **循环**：replacement non-recursive；无loop。
- **正确性论证**：receipt checks are phase gates，§7.6唯一body call，§7.6.1/§7.7 precede return，故post；所有副作用在步骤中逐项列出。

### 7.3 `beginToolInvocation(input) -> OperationCommitResultV1<type-4>`

```ts
function beginToolInvocation(input: Readonly<{ handle: ToolInvocationHandle; raw: M1.ToolEvidence; operationID: M1.RecoveryOperationID }>): Effect.Effect<M1.OperationCommitResultV1<"tool-evidence-recorded">, M4.RecoveryAuthorityErrorV1>
```

- **Callers**：§7.1.1、§7.2。
- **Callees（pre/post）**：M4 `commitToolEvidence`返回exact M1 operation result/receipt；§9.11 response-loss。
- **Requires**：raw exact complete、before hook未调用；operation/receipt mapping只能来自M1 indexed type `"tool-evidence-recorded"`与M4 `commitToolEvidence` owner signature，不接受caller/local fact-kind literal。
- **步骤**：1) 以M1 builder构造`RecoveryOperationInputV1<"tool-evidence-recorded">`/digest；2) call `M4.commitToolEvidence`；3) response unknown按§9.11；4) 以M1 `OperationCommitResultV1<"tool-evidence-recorded">`/`ReceiptForV1<"tool-evidence-recorded">` exact decode验证result，不本地switch近义fact kind；5) store complete result reference；6) conflict/partial/persistence退出。
- **分支/退出/残留**：first/exact replay success；missing after bounded protocol；conflict；partial/corrupt；persistence fatal。非success hook/body=0。
- **Ensures**：success raw fence durable；receipt immutable。
- **Side effects**：M4 SQLite/projection only。
- **循环**：response protocol≤2 lookup+≤1 resubmit。
- **正确性论证**：M4 atomic post+exact receipt validation建立durable fence；所有failure在hook前退出，副作用穷尽。

### 7.4 `materializeFinalToolPlan(raw, hookOutcome) -> FinalToolPlan`

```ts
function materializeFinalToolPlan(raw: M1.ToolEvidence, hookOutcome: unknown): Effect.Effect<FinalToolPlan, ToolExecutionGateError>
```

- **Callers**：§7.1.1、§7.2。
- **Callees**：M1 canonicalizer、frozen registry lookup。
- **Requires**：raw fence durable；hook outcome captured。
- **步骤/分支**：unchanged、args rewrite、replacement、short-circuit、reject、unknown exact switch；unknown typed invalid。
- **退出/残留**：one plan或typed error；无runtime residue。
- **Ensures**：owner/callID不变、single final choice、exact args frozen。
- **Side effects**：无。
- **循环**：finite keys，每轮消费一key。
- **正确性论证**：closed switch互斥且canonicalizer固定identity/args，故single-plan post；pure callees使副作用为空。

### 7.5 `commitFinalToolPlan(handle, plan) -> OperationCommitResultV1<type-4>`

```ts
function commitFinalToolPlan(handle: ToolInvocationHandle, plan: FinalToolPlan): Effect.Effect<M1.OperationCommitResultV1<"tool-evidence-recorded">, M4.RecoveryAuthorityErrorV1>
```

- **Callers**：§7.1.1、§7.2。
- **Callees**：M4 `commitToolEvidence`、§9.11。
- **Requires**：matching raw receipt；body未执行；next revision exact。
- **步骤**：1) 用M1 exact `"tool-evidence-recorded"` builder构造tool evidence revision；2) call M4 owner callable；3) bounded response resolution；4) 以M1 indexed result/receipt type验证revision与fold，不本地定义fact-kind mapping；5) store latest complete result。
- **分支/退出/残留**：first/replay success；conflict/partial/persistence all body=0。
- **Ensures**：success plan revision durable/latest；failure cannot enter body。
- **Side effects**：M4 write/public running projection。
- **循环**：bounded§9.11 only。
- **正确性论证**：caller only invokes§7.6 after validated receipt；因此plan fence严格先于body。

### 7.6 `executeFinalToolPlan(plan, runtime) -> BodyOutcome`

```ts
function executeFinalToolPlan(plan: FinalToolPlan, runtime: ToolRuntimeContext): Effect.Effect<BodyOutcome>
```

- **Callers**：§7.1.1、§7.2。
- **Callees**：selected original/replacement body、permission/MCP、attempt-local StructuredOutput capture。
- **Requires**：plan receipt committed；execute ref frozen；AbortSignal valid。
- **步骤/分支**：short-circuit→0 calls；execute/replacement→single call；map success/error/interrupt/defect to BodyOutcome。
- **退出/残留**：always typed outcome；external body may still own side effects represented as uncertain。
- **Ensures**：body call count 0/1；no durable settlement。
- **Side effects**：selected body/permission/MCP/capture only。
- **循环/等待**：本函数无loop；external body progress依赖return/error/AbortSignal/runner cancellation，不保证无条件终止。
- **正确性论证**：union branch只有零或一个call site，catch mapping穷尽exits；无settlement callee。

### 7.6.1 `commitBodyOutcome(handle, outcome) -> OperationCommitResultV1<type-4>`

```ts
function commitBodyOutcome(handle: ToolInvocationHandle, outcome: BodyOutcome): Effect.Effect<M1.OperationCommitResultV1<"tool-evidence-recorded">, M4.RecoveryAuthorityErrorV1>
```

- **Callers**：§7.1.1、§7.2。
- **Callees**：M4 `commitToolEvidence`、§9.11。
- **Requires**：final-plan receipt durable；body不会重跑；outcome same invocation。
- **步骤**：1) build next exact evidence；2) commit；3) bounded lookup/resubmit；4) validate receipt/fold；5) advance state body-outcome-durable。
- **分支/退出/残留**：success；conflict/partial/persistence fatal，均不得rerun body或call after hook as success。
- **Ensures**：success body outcome durable；failure leaves outcome uncertain to caller。
- **Side effects**：M4 write/projection only。
- **循环**：bounded§9.11。
- **正确性论证**：exact operation result binds outcome; no body callee in function, so failure cannot duplicate side effects。

### 7.7 `settleToolInvocation(handle, outcomeReceipt) -> void`

```ts
function settleToolInvocation(handle: ToolInvocationHandle, outcomeResult: M1.OperationCommitResultV1<"tool-evidence-recorded">): Effect.Effect<void, ToolExecutionGateError | FatalRecoveryStop>
```

- **Callers**：§7.1.1、§7.2。
- **Callees**：plugin after once、M4 `commitToolEvidence` final revision、§9.11、Deferred completion。
- **Requires**：body outcome complete result exact `M1.OperationCommitResultV1<"tool-evidence-recorded">`并通过M1 indexed receipt/fold validation；body不可重跑；detached receipt或local fact-kind literal不满足pre。
- **步骤**：1) call after hook once；2) capture rewrite/throw；3) build final evidence；4) commit+resolve response loss；5) validate receipt；6) only success resolve Deferred；7) failure fatal/typed error。
- **分支/退出/残留**：completed/error/interrupted/uncertain；after throw maps error settlement；commit failure Deferred not trusted。
- **Ensures**：Deferred completion implies durable final evidence；after failure never reruns body。
- **Side effects**：after hook、M4 write/projection、Deferred/diagnostic。
- **循环**：bounded§9.11；无body wait。
- **正确性论证**：outcome already durable，after called once，final receipt precedes Deferred，故terminal barrier可靠。

### 7.8 `reconcileToolStreamEvent(event, settlement) -> void`

```ts
function reconcileToolStreamEvent(event: Readonly<{ context: M1.CommittedDispatchAttemptContext; callID: string; payload: unknown }>, settlement: DispatchOrdinalSettlement): Effect.Effect<void, TerminalSettlementError>
```

- **Callers**：§7.12 event consumer。
- **Callees**：M4 `commitToolEvidence` as needed、existing event projector；不得调用terminal-only M4 S1 `loadRecoverySnapshot`。
- **Requires**：event carries committed dispatch context。
- **步骤**：1) compare assistant+ordinal+operation generation；2) exact current ordinal reconcile callID/name/input；3) previous ordinal late event→commit `dispatch/ledger-conflict` inconsistency, never write current object；4) future/unknown ordinal→same inconsistency；5) duplicate exact no-op；6) cross-ordinal callID collision→inconsistent；7) provider-executed/orphan typed evidence。
- **分支/退出/残留**：exact merge/no-op/inconsistency commit；M4 failure fatal and intake stops。
- **Ensures**：no event from ordinal i mutates settlement j≠i。
- **Side effects**：M4 evidence/projection only。
- **循环**：无。
- **正确性论证**：ordinal comparison precedes every mutation；noncurrent branches only append inconsistency，故cross-contamination impossible。

### 7.8.1 `reconcileInterruptedToolExecutionOnRestart(input) -> RestartToolReconciliationResultV1`

```ts
function reconcileInterruptedToolExecutionOnRestart(input: Readonly<{
  authority: M4.CommittedAssistantAuthorityViewV1<M4.CommittedAssistantAdmissionOperationV1>
  tool: M1.AuthoritativeToolEvidenceV1
  ownership: RunnerOwnership
}>): Effect.Effect<M3.RestartToolReconciliationResultV1, FatalRecoveryStop>
```

- **Callers**：startup/session-resume coordinator，在generic M4 nonterminal view加载后、attach/resume/lost-handle decision与terminal barrier检查前，对每个latest authoritative call逐项调用。不是tool executor。
- **Callees（pre/post）**：M1 `ToolExecutionPhaseV1`/carrier/commitment exact validators；M4 O3a `reconcileInterruptedToolExecution`; §9.11 aggregate-scoped A5 response resolution；必要时reload exact generic M4 view。禁止调用before/after hook、body、permission、MCP、provider、M7/M2、S1。
- **Requires**：authority来自same WAL generic loader且`nonterminal:true`；tool是该view按callOrdinal唯一latest authoritative fact；compatibility-only facts不进入本函数；ownership仍是serialized resume owner；无restored `ToolInvocationHandle`/callback。
- **连续state/reentry branches**：1) validate assistant/call/order/latest anchor；2) phase=`final-after-hook-settled`→`already-terminal`，allocation/body/hook hits=0；3) phase=`reconciled-terminal-manual-only`→idempotent `already-terminal`；4) phase=`planned|body-outcome-durable|unknown-intermediate`且ownership已cancelled→`cancelled-before-allocation`，无operationID/write/callback；否则按exact anchor one-time allocate `RestartToolReconciliationAllocationV1`与stable operationID；5) planned/unknown构造M1 exact reconciled phase，body/after-hook unknown且不携invented terminal payload；6) body-outcome保留bodyState、already-durable arguments/terminal result-or-error carrier及plan/call/result commitments，afterHook unknown，禁止改写payload；7) callO3a once；8) success/exact replay require complete type-4 result并mark committed；9) response loss用§9.11 same operationID/input/digest；10) competing final/reconciled winner reload latest call，exact terminal→already-terminal，foreign/mismatch→fatal；11) missing after bounded lookup only permits same-ID resubmit once，never callback/body rerun；12) corrupt/duplicate/ambiguous/owner mismatch/carrier mismatch/DB fatal→closed-fatal；13) cancellation afterallocation transfers same allocation/operationID toscope finalizer and completes steps7–12 before ownership release，不能丢弃后走body/hook；14) process loss允许next restart重新观察latest raw anchor：若O3a已赢则branch3，否则重新做no-side-effect reconciliation，M4 append/CAS仍只允许一个latest terminal winner。
- **退出/残留**：`reconciled|already-terminal|cancelled-before-allocation|fatal-stop` exhaustive。success仅append one type-4 transition；cancelled-before-allocation无allocation/write；其它runtime allocation关闭；无ToolInvocationHandle/Deferred/secret bytes/provider request residue。
- **Ensures**：planned/body-outcome/unknown不会重跑body或after-hook；latest fold成为`reconciled-terminal-manual-only`，O6 terminal barrier可close；M4 S1必产manual-only causes，M5 automatic proof slice不可构造，automatic永久禁止。
- **Side effects**：one finite M4 read/O3a append/A5 resolution；tool/hook/provider hits=0。
- **循环/等待**：finite one-call branch；§9.11固定≤2 lookup+≤1 same-ID resubmit；无callback wait或TTL。
- **正确性论证**：phase closed switch把already-final与三种intermediate完全分离；M1 exact transition只允许append reconciled且rerun flags forbidden；body-outcome branch只复制durable carrier，other branches不发明结果；O3a/A5 single winner和one-shot allocation排除重复settlement，故barrier closure与permanent ManualStop同时成立。

### 7.9 `drainAttempt(ctx, settlement, trigger) -> DrainedDispatchOrdinal`

```ts
function drainAttempt(ctx: AttemptLocalState, settlement: DispatchOrdinalSettlement, trigger: "retry-transition" | "normal-eof" | "canonical-incomplete" | "interrupt" | "transport-error" | "reentry-settlement"): Effect.Effect<DrainedDispatchOrdinal, TerminalSettlementError | FatalRecoveryStop>
```

- **Callers**：§6.12、§7.11–§7.13、reentry exact-drain branch。
- **Callees（pre/post）**：transport close/abort；M4 `commitReasoningEvidence`/`commitToolEvidence`及reads，分别消费M1 exact indexed `"reasoning-evidence-recorded"`/`"tool-evidence-recorded"` mappings；tool Deferred completes only after§7.7 durable settlement。
- **Requires**：settlement is exact current ordinal；intake open or same-owner closed；active set becomes sealed by step1。
- **连续步骤**：1) CAS close intake and snapshot finite `(ordinal,callID)` set；2) verify no foreign ordinal entries；3) trigger=`normal-eof|retry-transition|canonical-incomplete` graceful close, `interrupt|transport-error|reentry-settlement` abort；close/abort failure records accurate trigger, not success；4) flush text partial；5) reasoning provenance `provider-end`/`step-boundary-forced-flush`/`cleanup-forced-flush` exact；6) abort tools only for interrupt/transport-error/reentry-settlement，other triggers allow already-running tools to settle；7) await every snapshot Deferred；8) ownership cancellation propagates abort but does not synthesize completed；9) reload evidence and verify no gap/new same-ordinal item；10) freeze summary/terminalTrigger closed。
- **分支/退出/残留**：drained；durable read/write failure fatal；cross-ordinal inconsistency fatal/typed cause；external tool nonresponse keeps wait pending until body terminal/abort/cancellation/process loss—no timeout and no false return。
- **Ensures**：success includes every registered current-ordinal terminal evidence；forced flush never provider-end；next ordinal may be created only after success。
- **Side effects**：close/abort、evidence writes/reads、Deferred wait；no new dispatch/tool start/admission。
- **循环 measure/progress**：finite snapshot set，每个completed item removes one；for an external unresolved item, progress relies explicitly on tool return/error, AbortSignal, runner cancellation or process termination and therefore does not claim unconditional termination。
- **正确性论证**：intake close fixesfinite set；Deferred post gives durable settlement；final reload establishes completeness；nontermination is represented as pending ownership, not incorrect classification。

### 7.10 `classifyTerminalObservation(drained, currentOrdinal) -> TerminalDecision`

```ts
function classifyTerminalObservation(drained: DrainedDispatchOrdinal, currentOrdinal: M1.SafeNonNegativeInt): TerminalDecision
```

- **Callers**：§7.12。
- **Callees**：M1 terminal constructor/cause validator。
- **Requires**：§7.9 success；caller passes assistantEvidence.currentOrdinal。
- **步骤**：1) ordinal mismatch→evidence-inconsistent `dispatch/ledger-conflict`；2) canonical signal→typed incomplete；3) no credible settled step clean EOF→typed incomplete；4) settled unknown/empty→orthogonal non-success；5) normal settled；6) ordinary error。
- **分支/退出/残留**：closed union，所有result carry exact ordinal。
- **Ensures**：only current ordinal determines terminal；ordinal0 evidence cannot satisfy ordinal1。
- **Side effects**：无。
- **循环**：无。
- **正确性论证**：first ordinal guard excludes stale evidence，priority switch互斥，M1 constructor rejects illegal terminal facts；pure function副作用为空。

### 7.11 `appendTerminalAndReload(input) -> DurableRecoveryAuthorityViewV1`

```ts
function appendTerminalAndReload(input: Readonly<{ aggregateID: M1.RecoveryAggregateID; sessionID: string; fact: M1.TypedIncompleteTerminalFact; operationID: M1.RecoveryOperationID }>): Effect.Effect<M4.DurableRecoveryAuthorityViewV1, FatalRecoveryStop>
```

- **Callers**：§7.12/§7.13。
- **Callees（pre/post）**：M4 `commitIncompleteTerminal` then M4 `loadRecoverySnapshot`; commit response loss uses§9.11。
- **Requires**：exact ordinal drain complete；all tool latest phases are`final-after-hook-settled|reconciled-terminal-manual-only`；restart intermediate phases先经§7.8.1/O3a；reasoning barrier durable。
- **步骤**：1) build type-7 input；2) commit；3) unknown response resolve bounded；4) exact success consume complete `OperationCommitResultV1<"incomplete-terminal-recorded">`并验证operation/receipt/operationPostState pair；5) separately callS1；6) require returned nominal view’s complete `snapshot` contains same terminal/operation high-water、same-read assistant mapping与exact `snapshotIdentity`；7) require`toolEligibility` total branch consistent with snapshot partition/phases，reconciled call只能manual-only；8) return whole `M4.DurableRecoveryAuthorityViewV1`，不得unwrap后丢brand/eligibility。detached terminal receipt不得替代step4。
- **分支/退出/残留**：commit first/replay + nominal view reload success；commit success but reload read failure→fatal；conflict/partial/corrupt/persistence→fatal；no branch returns synthetic/plain snapshot or structural eligibility。
- **Ensures**：returned view transaction-consistent and complete；SafeRetry/Continue availability only由M4 nominal branch表达；failure starts no recovery send。
- **Side effects**：M4 terminal write/read/public safe projection only。
- **循环**：§9.11 bound；S1 bounded existing DB busy retries only。
- **正确性论证**：complete terminal result precedesS1；M4 view brand bindssnapshot/identity/eligibility in one WAL read，step7 preserves O3a manual-only finality，故M5不可能从plain snapshot自行升级automatic。

### 7.12 `processReleasedDispatch(input) -> AssistantProcessOutcome`

```ts
function processReleasedDispatch(input: Readonly<{
  assistant: AdmittedAssistant
  attempt: AttemptLocalState
  authorized: AuthorizedDispatch
  preReleased?: ReleasedStream
}>): Effect.Effect<AssistantProcessOutcome, FatalRecoveryStop>
```

- **Callers**：M6 `runAdmittedAssistant`。
- **Callees**：§6.10、event consumer/§7.8、tool gate、§7.9–§7.11、`SessionRetry.policy`, §6.12.1。
- **Requires**：complete result durable/validated；fresh settlement for its ordinal已由§7.0.1创建；attempt current ordinal exact。`preReleased` present iff assistant transport is`automatic-released` and is the exact stream returned by§6.10 afterK9 released close；otherwise omitted and handle remainsauthorized-not-released。
- **连续步骤/branches**：1) ifpreReleased present consume it directly and do not callrelease again；else call§6.10 release；known-no-send已完成latch exit→cancel及automatic K9/cleanup（若适用），再→§7.13；delegated-error已released/K9/cleanup，作为typed transport error进入本ordinal的step3 policy/terminal flow但same handle不得重调；released-unknown-delivery已K9/cleanup并直接返回fatal ambiguity，禁止§7.13后续recovery触发resend；2) consume events only into current settlement；3) on error call `SessionRetry.policy` and use its Schedule decision as sole generic predicate；typed canonical incomplete bypasses policy；4) policy done→drain/classify terminal；5) policy accepts→write existing retry status；status write failure fatal，不send；6) wait existing policy duration；wait interrupt/ownership loss→abort+drain, noretry；7) after wait revalidate ownership and load exact M4 generic committed-assistant view/current dispatch；8) drain+close prior ordinal with`retry-transition`；9) allocate one fresh next-ordinal candidate context+stable operationID；10) call§6.3.2 once and obtain one bound handle/proof；11) call§6.12.1 once to commit+F26-authorize；12) call§7.0.1 once for next ordinal；13) release next and continue；14) EOF/incomplete drain current exact ordinal；15) classify；16) normal→finish/ordinary/compaction；17) incomplete→§7.11 returnswhole nominal authority view；18) persistence/reload/inconsistency→fatal。
- **退出/残留**：finished/ordinary/incomplete/compaction/orthogonal/fatal；every exit closes or transfers ownership of current resources。
- **Ensures**：every send has ledger+exactly-one fresh ordinal object；generic retry iff existing policy accepts；canonical incomplete never retry；no cross-ordinal evidence reuse；prepare/record/authorize/settlement allocation are four explicit one-way stages with no caller cycle。
- **Side effects**：provider streams、existing retry status/wait、M4 evidence/terminal、tools/parts、runtime cleanup。
- **循环 invariant/measure**：committed ordinals contiguous，每iteration current receipt/settlement match；no finite retry-count claim is added. Progress for accepted waits relies on existing Schedule timer or abort/cancellation; provider stream progress relies on terminal/error/abort/cancellation. Unconditional termination is not claimed。
- **正确性论证**：sole policy decision removes conflicting predicates；retry branch drains before fresh receipt/object；terminal branch consumes exact current ordinal；therefore ledger/evidence isolation and canonical-incomplete exclusion hold。

### 7.13 `settlePreDispatchAbandonment(input) -> AssistantProcessOutcome`

```ts
function settlePreDispatchAbandonment(input: Readonly<{ assistant: M1.CommittedAssistantAttemptIdentity; sendState: "known-not-delegated" | "unknown"; operationID: M1.RecoveryOperationID }>): Effect.Effect<AssistantProcessOutcome, FatalRecoveryStop>
```

- **Callers**：§6.10 known failure、§6.12.1 failure、reentry settlement。
- **Callees**：M4 exact incomplete-terminal operation as specified by M1，§9.11，then M4 S1 `loadRecoverySnapshot`。
- **Requires**：assistant/current dispatch由generic M4 nonterminal view或fresh admitted execution path证明exact；no same ordinal retry；send state derived at delegate boundary；caller未传terminal snapshot。
- **步骤**：1) known→pre-dispatch abandonment lower fact，unknown→dispatch ambiguity lower fact；2) owner builder将其构造成exact `M1.TypedIncompleteTerminalFact`；3) commit exact incomplete terminal；4) bounded response resolution并require complete `OperationCommitResultV1<"incomplete-terminal-recorded">`；5) then and only then call S1；6) return`{tag:"incomplete",authority}` preserving whole nominal view；7) authority failure fatal。
- **分支/退出/残留**：known/unknown incomplete success；conflict/partial/persistence/S1 failure fatal；uncommitted failed ordinal never gets fake ledger，committed unknown ledger retained。不存在normal-terminal或post-terminal generic-loader branch。
- **Ensures**：assistant incomplete-terminal before successor/recovery；same ordinal never resent；S1 snapshot cannot precede complete incomplete commit。
- **Side effects**：M4 write/read/projection+cleanup。
- **循环**：bounded§9.11。
- **正确性论证**：closed send-state mapping preserves uncertainty；M4 terminal+reload establishes predecessor barrier；no provider/tool callee。

### 7.13.1 `decideExistingEvidenceDrain(input) -> ExistingEvidenceDrainDecision`

```ts
function decideExistingEvidenceDrain(input: Readonly<{ assistant: M1.CommittedAssistantAttemptIdentity; currentDispatch: M1.CommittedDispatchAttemptContext; registry: AssistantRuntimeEvidence | undefined }>): ExistingEvidenceDrainDecision
```

- **Callers**：M6 `settleCommittedAssistantWithoutHandle`。
- **Callees**：none。
- **Requires**：caller从`M4.CommittedAssistantAuthorityViewV1`取得committed assistant/current dispatch exact；不依赖`M1.DurableRecoverySnapshot`。
- **步骤/分支**：1) no registry→`no-local-evidence`; 2) registry current ordinal/context exact and object open/closed same owner→`must-drain`; 3) registry exists but missing current object, foreign assistant/ordinal, duplicate object, or prior object marked current→`inconsistent` with`dispatch/ledger-conflict`。
- **退出/残留**：three branches exhaustive；does not mutate registry。
- **Ensures**：existing exact local evidence is always drained; drain is never optional; mismatched residue never ignored。
- **Side effects**：无。
- **循环**：finite map lookup only。
- **正确性论证**：closed predicates partition absent/exact/mismatched states，directly yielding exact drain obligation；pure read makes side effects empty。

## 8. M5 — Pure Candidate Selector and Classifier

M5只拥有pure selection/classification。事实生产者与validators产出M1 exact lower-level causes；stable reason mapping、dedup、empty/malformed/unsafe-cast fallback与order只由M1 total F23 `M1.mapCausesToManualStopReasons(...)`拥有。F23对任何runtime异常输入都稳定返回`["internal-classification-failure"]`而不throw；M5/M6不得接受caller-preselected reason或复制fallback。

### 8.1 `selectRecoveryCandidate(authority) -> CandidateSelection`

```ts
function selectRecoveryCandidate(
  authority: M4.DurableRecoveryAuthorityViewV1,
): CandidateSelection
```

- **Callers**：M6 `recoverIncomplete`。
- **Callees（pre/post）**：M4 nominal view/brand validator；M1 snapshot/partition/dispatch exact validators。M5不构造M4 brand、不调用M7、不从snapshot重新推导eligibility。
- **Requires**：exact M4 S1 return，完整含`authority.snapshot + authority.snapshotIdentity + authority.toolEligibility`且三者same WAL/same identity；无current plan/config/public truth。
- **连续步骤**：1) validate M4 view private brand and snapshot identity equality；失败是fatal authority invalid，不产生candidate；2) 对snapshot dispatch做closed四分：missing→`dispatch/ledger-conflict(detail:"missing-ledger")`；selected opaque→`provider-introspection/descriptor-not-readable`；gap/conflict→`dispatch/ledger-conflict(detail:"gap-or-conflict")`；multiple plausible→`dispatch/multiple-plausible-attempts`；3) 只有exact one plausible available current dispatch继续；4) switch exact `toolEligibility.kind`；5) `safe-retry-eligible`要求partition exact truly-empty、action/closure exact safe-retry、tool/reasoning proofs empty，返回automatic+same branded slice；6) `continue-eligible`要求partition exact authoritative-only nonempty、每个proof final-after-hook-settled且ordered/carrier/prefix/source identity complete，返回automatic+same branded slice；7) `manual-only`复制M4 nonempty causes并返回manual authorityKind；8) discriminator/cardinality/brand/phase mismatch视authority invalid/fatal，不把structural value降级成planning ManualStop；9) any planning dispatch cause在authority本身完整时返回manual planning-failure。
- **分支/退出/残留**：automatic exactly one nominal slice，或manual causes；authority invalid由caller fatal。SafeRetry不可由`authoritative.length===0`快捷判断；compatibility-only/mixed永不折叠truly-empty。
- **Ensures**：SafeRetry iff M4 nominal safe-retry slice；Continue iff M4 nominal continue slice；compatibility-only/mixed/reconciled/planned/body-outcome/unknown/nonfinal/manual-only永不automatic；selection不含stable reasons/handle或plain snapshot proof。
- **Side effects**：无。
- **循环 invariant/measure**：只扫描finite dispatch/proof arrays验证owner-provided order；每轮消费一项，不重新分类tool partition。
- **正确性论证**：M4 S1已对完整authority view做partition/cardinality/phase/carrier/sealed completeness closed switch并附private brand；M5只验证并保留该nominal result，故无法从缺失compatibility或structural duplicate升级automatic。

### 8.2 `classifyRecovery(input) -> M1.RecoveryProposal`

```ts
function classifyRecovery(input: Readonly<{
  authority: M4.DurableRecoveryAuthorityViewV1
  selection: CandidateSelection
  closure?: M1.RecoveryClosureDescriptor
  reservation?: M2.PreparedHandleCommitmentReservationV1
  sealedUseLeases: readonly M4.SealedRecoveryUseLeaseV1[]
  planned?: M1.PlannedRecoveryMaterialization<M2.AvailableDispatchHandle>
  admission: M1.AdmissionPlan
}>): M1.RecoveryProposal
```

- **Callers**：M6 `recoverIncomplete`。
- **Callees（pre/post）**：§8.3 returns exact causes；M1 F23 `M1.mapCausesToManualStopReasons(...)` returns canonical nonempty reasons；M1 `validateRecoveryProposal` verifies proposal purity/binding；M1 digest/binding validators。M5不调用M7 privileged inspector；inspection结果已封装在same-handle planned materialization。
- **Requires**：authority是same round完整nominal view；selection来自§8.1且若automatic携exact same branded slice；admission来源分离且exact。Early manual-only/planning-manual classification允许`planned` absent且必须无reservation/leases/prepare side effect；post-reservation/lowering/prepare failure允许owner-typed unavailable `planned`或absent planned cause。automatic success则要求closure/reservation/lease set与available planned全部present，planned对应post-K7唯一M7 candidate/context与same actual handle。
- **连续步骤**：1) call§8.3；2) if causes nonempty, call M1 F23 exactly once；3) construct/validate manual proposal；4) if causes empty, requireselection automatic且snapshotProof identity/action exact equals authority；5) requireclosure由该slice构造并M1 builder复验；6) requireM2 reservation、K7 complete live lease set、planned present+available且same context/action/target/commitment，`planned.pausedHandle.recoveryReservation===reservation`；7) SafeRetry branch再要求proof truly-empty/not-needed，Continue branch再要求authoritative-only/final-after-hook-settled/ordered proofs+available closure；8) verify admission source/control/heads/policy/N/M and only read committed `policy.digestInput.effectiveMaxModelAssistants`；9) all true construct automatic proposal；10) absent/unavailable planned或任何failed predicate成为exact lower cause并返回step2；11) manual-only/compatibility/mixed/nonfinal/reconciled/unknown authority can never reachstep4；12) impossible runtime hole flows total F23 singleton fallback。
- **分支/退出/残留**：validated automatic or validated manual proposal；never throws business error。Authority corruption is caller fatal, not a manual proposal input.
- **Ensures**：automatic iff exact M4 nominal slice + same snapshot closure/reservation/live leases/planned/admission conjunction；manual reasons solely M1 F23；proposal noauthority identity。
- **Side effects**：无；classification不unseal/prepare/renew lease。
- **循环**：finite proof/lease cause pass + F23 finite loops；no recursion。
- **正确性论证**：M4 nominal slice supplies complete authority predicate；§8.3 validates same snapshot/generation/handle chain；M1 F23 owns manual mapping；therefore only authoritative final proof can automatic，all compatibility/manual/nonfinal branches remain ManualStop/fatal without structural upgrade。

### 8.3 `collectRecoveryFailureCauses(input) -> M1.RecoveryFailureCause[]`

```ts
function collectRecoveryFailureCauses(input: Readonly<{
  authority: M4.DurableRecoveryAuthorityViewV1
  selection: CandidateSelection
  closure?: M1.RecoveryClosureDescriptor
  reservation?: M2.PreparedHandleCommitmentReservationV1
  sealedUseLeases: readonly M4.SealedRecoveryUseLeaseV1[]
  planned?: M1.PlannedRecoveryMaterialization<M2.AvailableDispatchHandle>
  admission: M1.AdmissionPlan
}>): M1.RecoveryFailureCause[]
```

- **Callers**：§8.2 only。
- **Callees（pre/post）**：M1 exact validators、M1/M7 typed validation results already carried by planned value；all return fact or exact `M1.RecoveryFailureCause`。
- **Requires**：inputs decode or carry owner-produced typed unavailable cause；no caller reason/code field。
- **Causal continuous steps**：1) first validateauthority brand/snapshot identity/toolEligibility consistency；structural forge/corrupt/partial is fatal outside this cause list；2) dispatch missing/opaque/gap/multiple四分按原priority收集；3) `toolEligibility.manual-only`直接复制其nonempty M4 causes，compatibility-only/mixed/reconciled/planned/body-outcome/unknown/nonfinal不得重新扫描成automatic；4) manual selection到此结束lowering/prepare predicates，automatic selection则必须same branded slice并继续steps5–11；5) SafeRetry exact truly-empty/not-needed，否则action cause；6) Continue exact authoritative-only + every final-after-hook-settled + ordered tool/reasoning/prefix proofs，否则typed tool/closure cause；7) reservation absent/mismatch/already-consumed-wrong-generation添加planning runtime proof cause；8) lease set missing/extra/duplicate/closed/stale generation/source/action/operation/candidate/target/commitment mismatch添加binding/provider proof cause；9) `planned` absent时添加当前阶段exact planning/lowering/materialization cause，unavailable时复制其exact cause；10) available验证descriptor/separate handle/recoveryReservation same object；11) inspection/lowering typed causes；12) policy/source/control/head mismatch and N/M causes，其中M只比较committed `digestInput.effectiveMaxModelAssistants`；13) supersession cause；14) impossible validator defect internal cause。
- **分支/退出/残留**：returns zero or more exact causes；missing、opaque、gap/conflict、multiple-plausible四个dispatch branches按上述priority判定，不合并成“not exactly one”快捷分支；malformed runtime object不是trusted variant；若owner validator能形成exact internal cause则收集该cause，否则保持unsafe runtime value只在§8.2 boundary交total F23，后者唯一降级为`internal-classification-failure`。Parent gate failure suppresses every child predicate that lacks readable facts。
- **Ensures**：every proven failure contributes at least one exact M1 cause；no stable reason mapping/sort/dedup；detail/callID/operationID remain diagnostic identity only。
- **Side effects**：无。
- **循环 invariant/measure**：finite validators/evidence；processed prefix causes correspond only to proven facts；each round consumes oneitem。
- **正确性论证**：parent-gated ordering ensures no fabricated downstream mismatch；closed owner validators ensure exact union leaves；since function never callsF23 or readsManualStopReason, M5 ownership remains cause-only。

### 8.4 24 reasons 只读索引（normative owner：M1 §4.8.5/F23）

本表仅帮助从lower-level cause定位M1 F23输出；不定义predicate、mapping implementation、dedup、fallback或order。若本表与M1不一致，以M1 owner contract为准并先修正本文索引。

| M1 cause `source/kind` | F23 stable reason |
|---|---|
| `dispatch/ledger-conflict` | `dispatch-evidence-inconsistent` |
| `dispatch/multiple-plausible-attempts` | `dispatch-ambiguous` |
| `provider-introspection/descriptor-not-readable` | `provider-introspection-unavailable` |
| `planning/target-not-materialized` | `planned-target-unavailable` |
| `planning/authority-version-not-provable` | `planned-authority-unavailable` |
| `planning/request-materialization-threw` | `planned-request-materialization-failed` |
| `planning/request-canonicalization-failed` | `planned-request-digest-failed` |
| `planning/paused-runtime-proof-missing` | `planned-runtime-proof-unavailable` |
| `provider/replay-state-indeterminate` | `provider-replay-unknown` |
| `provider/continuation-capability-missing` | `provider-continuation-unavailable` |
| `provider/authorization-proof-missing` | `provider-proof-unavailable` |
| `provider/action-contract-not-applicable` | `recovery-action-inapplicable` |
| `tool/local-replay-state-indeterminate` | `local-tool-replay-unknown` |
| `tool/input-not-closed` | `open-tool-input` |
| `tool/settlement-not-terminal` | `unsettled-tool` |
| `tool/execution-was-interrupted` | `interrupted-tool` |
| `tool/result-commitment-uncertain` | `uncertain-tool-result` |
| `closure/lowered-closure-not-provable` | `dispatch-lowering-unverifiable` |
| `closure/continuation-context-missing` | `continuation-context-unavailable` |
| `binding/frozen-facts-mismatch` | `recovery-binding-stale` |
| `admission/incomplete-recovery-limit-reached` | `recovery-budget-exhausted` |
| `admission/model-assistant-limit-reached` | `same-process-max-step-exhausted` |
| `supersession/new-user-input-committed` | `superseded-by-new-user-input` |
| `internal/classifier-invariant-violated` | `internal-classification-failure` |

## 9. M6 — Recovery Runtime Orchestration and Admission Lifecycle

### 9.1 `decodeSessionRecoveryConfig(raw: unknown) -> M1.NormalizedRecoveryPolicy`

```ts
export function decodeSessionRecoveryConfig(
  raw: unknown,
): Effect.Effect<M1.NormalizedRecoveryPolicy, ConfigDecodeError>
```

- **Callers**：config loader/publisher。
- **Callees（exact owner）**：M1 `decodeRecoveryPolicyConfig(raw)` strict external codec，随后M1 F13 `normalizeRecoveryPolicy(decoded)`；需要canonical external projection时只调用M1 `encodeRecoveryPolicyConfig`。M6 actual-export的normalized carrier就是owner-qualified `M1.NormalizedRecoveryPolicy`，不定义`SessionRecoveryConfig`或structural alias。
- **Requires**：arbitrary external config JSON；caller未预先coerce、camelCase-normalize、摘出N/M或单独传`agentSteps`。
- **步骤/分支**：1) 把完整raw exact传M1 external decoder；2) decoder唯一读取snake_case recovery leaves与既有`agent.steps`；3) absent N/M/steps、defaults、safe-integer、alias/unknown/null/float/nonfinite/unsafe/`-0`/range分支全部由M1 codec closed处理；4) 成功的exact `M1.RecoveryPolicyInput`原样传F13；5) F13产生完整`M1.NormalizedRecoveryPolicy`，其`digestInput.agentSteps`、effective M、provenance与policyDigest不可由M6覆写；6) owner error原样映射`ConfigDecodeError`，不clamp/coerce/partial publish。
- **退出/残留**：exact `M1.NormalizedRecoveryPolicy`或typed owner error；no partial publish/cache mutation。
- **Ensures**：external snake_case/default/value/provenance/effective-M语义只由M1拥有；explicit2/64与omitted defaults digest等价但provenance分离；M6 decoder没有第二codec、第二`agentSteps`参数或local normalized carrier。
- **Side effects**：无。
- **循环**：无；M1固定leaf扫描。
- **正确性论证**：完整raw只进入M1 external codec，故`agent.steps`与N/M来自同一decode；F13消费其唯一output并返回owner exact carrier，排除M6 separate-agentSteps divergence与schema复制；所有callee纯，副作用为空。

### 9.1.1 `publishRecoveryPolicyAuthority(input) -> RecoveryPolicyAuthoritySnapshot`

```ts
function publishRecoveryPolicyAuthority(input: Readonly<{
  scopeKey: M6.RecoveryPolicyScopeKey
  policy: M1.NormalizedRecoveryPolicy
  selectedAgentID: string
  selectedAgentVersion: string
  configSourceVersion: string
}>): Effect.Effect<M6.RecoveryPolicyAuthoritySnapshot, M6.RecoveryPolicyAuthorityError>
```

- **Callers**：config/agent reload only。
- **Callees（pre/post）**：M1 exact normalized-policy verifier/digest readback；SQLite immediate tx；exact shape M4 §3.6。不得再次调用normalize或读取selected agent的steps作为第二policy input。
- **Requires**：`policy`是§9.1返回的exact `M1.NormalizedRecoveryPolicy`，其agentSteps/effective M/digest已闭合；new runtime snapshot not visible。
- **步骤**：verify exact owner carrier→begin→read row→same policy digest+normalized bytes return existing epoch→different exact CAS epoch+1/write→readback→commit→publish runtime snapshot；failure rollback/no publish。
- **分支/退出/残留**：existing/new snapshot；CAS conflict reread once：same digest returns winner，different digest typed conflict；DB failure old snapshot remains authority。
- **Ensures**：commit happens-before visibility；same epoch same bytes/digest；N2/M64 default equivalence preserved。
- **Side effects**：policy SQLite row + postcommit memory swap/diagnostic。
- **循环**：single conflict reread，no spin。
- **正确性论证**：M1 canonical post+transaction/readback establishes exact row，publish-after-commit prevents half visibility；side effects exhaustive。

### 9.1.2 `readRecoveryPolicyAuthority(scopeKey) -> RecoveryPolicyAuthoritySnapshot`

```ts
function readRecoveryPolicyAuthority(scopeKey: M6.RecoveryPolicyScopeKey): Effect.Effect<M6.RecoveryPolicyAuthoritySnapshot, M6.RecoveryPolicyAuthorityError>
```

- **Callers**：§9.2 for every uncommitted admission; new-lineage sequencing。
- **Callees**：single committed SQLite read + M1 exact decode/digest verification。
- **Requires**：scope owner mapping known。
- **步骤**：read exact row→decode/version/digest/default semantics verify→return；missing/corrupt/busy/read error typed。
- **分支/退出/残留**：snapshot or typed error；read resources closed。
- **Ensures**：returned snapshot already committed and exact。
- **Side effects**：read/diagnostic only。
- **循环**：existing bounded DB busy handling only；no new timeout/retry policy。
- **正确性论证**：row verification establishes owner type; no mutable config read，thus post。

### 9.1.3 `readRecoveryPolicyAuthorityInTransaction(tx, expectation) -> NormalizedRecoveryPolicy`

```ts
function readRecoveryPolicyAuthorityInTransaction(tx: M4.RecoveryReadOrWriteTransaction, expectation: M6.RecoveryPolicyAuthorityExpectation): Effect.Effect<M1.NormalizedRecoveryPolicy, M6.RecoveryPolicyAuthorityError>
```

- **Callers**：M4 A3 first-apply for operations 1/2/9 only。
- **Callees**：tx-local row read + M1 canonical verifier。
- **Requires**：A3 tx active；exact replay lookup already reported missing；expectation historical quartet fixed。
- **步骤**：read same scope row→verify normalized digest/default semantics→compare scope/epoch/policyDigest/defaultSemanticsVersion→return exact normalized policy；A3只取其current committed `digestInput.effectiveMaxModelAssistants`作为`effectiveM`并结合same-tx fold重算M admission，automatic另重算N；禁止从configured M/runtime steps/caller snapshot再次派生；mismatch stale。
- **分支/退出/残留**：match or stale/corrupt typed error; no nested tx。
- **Ensures**：first apply uses current committed policy；exact replay never calls this function。
- **Side effects**：tx-local read only。
- **循环**：one finite row read。
- **正确性论证**：exact tuple comparison is the first-apply gate; replay-before-call preserves historical receipt validity。

### 9.2 `freezeAdmissionPolicy(scopeKey) -> RecoveryPolicyAuthoritySnapshot`

```ts
function freezeAdmissionPolicy(scopeKey: M6.RecoveryPolicyScopeKey): Effect.Effect<M6.RecoveryPolicyAuthoritySnapshot, M6.RecoveryPolicyAuthorityError>
```

- **Callers**：every initial candidate、every ordinary successor、every automatic recovery round；not once per chain。
- **Callees**：§9.1.2。
- **Requires**：admission not committed and no lowering/prepare started for this candidate。
- **步骤**：read current committed snapshot→copy immutable owner object→bind to candidate planning；error before preallocate/prepare。
- **分支/退出/残留**：snapshot or typed error；failure no candidate/handle。
- **Ensures**：this uncommitted admission uses current epoch/digest；later policy change makes M4 first apply stale and forces cancel/reload/replan。
- **Side effects**：read only。
- **循环**：无。
- **正确性论证**：per-admission call position plus M4§9.1.3 recheck removes stale-chain exception；historical exact replay remains independent。

### 9.3 `preallocateAssistantCandidate(input) -> PreallocatedCandidate`

```ts
function preallocateAssistantCandidate(input: Readonly<{ predecessor: M1.AssistantChainHeadV1; policy: M6.RecoveryPolicyAuthoritySnapshot; origin: "initial" | "ordinary" | "automatic-recovery" }>): Effect.Effect<PreallocatedCandidate, AdmissionError>
```

- **Callers**：§9.5/§9.8 after§9.2。
- **Callees**：ID generators + M1 candidate constructor。
- **Requires**：fresh authoritative predecessor；policy frozen for this admission；shell excluded。automatic origin必须`predecessor.kind=="assistant"`并exact等于committed source/current assistant；assistant-chain genesis立即拒绝。
- **步骤/branches**：initial sequence/recovery ordinal0；ordinary sequence+1 same recovery ordinal；automatic both+1/source bound且child ordinal-0 dispatch predecessor固定genesis；overflow reject。
- **退出/残留**：candidate or error；discard consumes no M/N/head。
- **Ensures**：immediate successor, candidate authority only。
- **Side effects**：ID/memory only。
- **循环**：无。
- **正确性论证**：closed origin formulas+M1 bounds produce exact candidate; no M4 write means nonauthority。

### 9.4 `buildAdmissionPlan(input) -> AdmissionPlan`

```ts
function buildAdmissionPlan(input:
  | Readonly<{
      origin: "initial"
      authority: M4.InitialAdmissionAuthorityViewV1<M2.NoPreparedHandleProofV1>
    }>
  | Readonly<{
      origin: "ordinary"
      authority: M4.OrdinaryAdmissionAuthorityViewV1<M2.NoPreparedHandleProofV1>
    }>
  | Readonly<{
      origin: "automatic-recovery"
      candidate: PreallocatedCandidate
      policy: M6.RecoveryPolicyAuthoritySnapshot
      authority: M4.DurableRecoveryAuthorityViewV1
    }>
): M1.AdmissionPlan
```

- **Callers**：§9.5/§9.8。
- **Callees**：M1 constructor/canonicalizer；initial/ordinary inputs已由M4 loader与`M2.validateNoPreparedHandleProofV1`验证。
- **Requires**：closed origin discriminator与input exact match。initial/ordinary staged authority规则不变且禁止terminal view字段。automatic必须传完整`M4.DurableRecoveryAuthorityViewV1`，candidate/policy与`authority.snapshot` same session/source/head；不得只传plain snapshot或structural eligibility。
- **步骤**：switch origin→initial/ordinary直接复制origin authority facts并只计算M→automatic先validate nominal view identity/complete snapshot，复制`authority.snapshot` source/current heads+candidate+policy并计算N/M→compute controlPolicyDigest→construct exact plan。M inequality只读取`policy.policy.digestInput.effectiveMaxModelAssistants`或owner snapshot中等价exact path，不读取configured/agentSteps。
- **分支/退出/残留**：三个origin各一plan或M1 typed defect mapped internal；unknown/default exhaustive failure；no authority write。
- **Ensures**：M4可在same-tx从对应origin authority重新计算每个used head/field/boolean；initial/fresh/ordinary不依赖不完整source snapshot。
- **Side effects**：无。
- **循环**：无。
- **正确性论证**：closed origin union阻止snapshot跨origin复用；M1 exact builder与direct inequalities避免off-by-one；pure construction给出side-effect post。

### 9.5 `admitInitialOrOrdinary(input) -> AdmittedAssistant`

```ts
function admitInitialOrOrdinary(input:
  | Readonly<{
      origin: "initial"
      semanticMessages: readonly ModelMessage[]
      scopeKey: M6.RecoveryPolicyScopeKey
      runtimeInput: LegacyRuntimeInput
      authority: M4.InitialAdmissionAuthorityViewV1<M2.NoPreparedHandleProofV1>
    }>
  | Readonly<{
      origin: "ordinary"
      semanticMessages: readonly ModelMessage[]
      scopeKey: M6.RecoveryPolicyScopeKey
      runtimeInput: LegacyRuntimeInput
      authority: M4.OrdinaryAdmissionAuthorityViewV1<M2.NoPreparedHandleProofV1>
    }>
): Effect.Effect<AdmittedAssistant, AdmissionError | FatalRecoveryStop>
```

- **Callers**：§9.14。
- **Callees**：§9.4；existing ordinary converter→§6.3；M4 origin-specific prepared-view binder；M4 `commitCompositeAdmissionDispatch`; §9.11；M1 F26 only；§6.9/§6.11/§6.11.1。§7.0.1由§9.6在attempt创建后唯一调用，不是本函数callee。
- **Requires**：origin-specific no-handle authority view来自same serialized owner/current dedicated authority，不使用`M1.DurableRecoverySnapshot`冒充initial/ordinary input。initial：owner mapping committed；type-1表示model-lineage genesis，assistant-chain与ordinal-0 ledger heads为genesis/absent；aggregate head可以genesis或event但必须current；post-model-supersession时等于proof内exact type-10 post head，user-message predecessor已commit且proof branch/reservation matching；policy/candidate/no-handle proof已在view中。ordinary：committed assistant predecessor/current heads exact，candidate child ledger genesis，own current policy/no-handle proof。runner ownership live。
- **连续步骤**：1) validate closed origin-specific M4 authority view；2) §9.4从该view构造plan并做M capacity precheck；3) existing converter提供semantic candidate并调用M2 prepare exactly once；4) 调M4 matching binder，以package的`M2.PreparedUnreleasedHandleProofV1`把same authority view提升为prepared stage；5) build exact op1/2 input+stable operationID+Legacy assistant genesis material，initial reservation branch携带type-10 operationID/digest ref；6) M4 commit并传prepared view first/replay；7) response unknown§9.11；8) consume complete result；9) policy/head/M stale first-apply→cancel+cleanup，caller重新freeze/preallocate/prove-no-handle/load view，禁止复用旧view；10) conflict/corrupt/partial/owner mismatch/non-foldable/ambiguity→cancel+fatal；11) nonautomatic branch只用F26验证`result.receipt+operationPostState+same handle commitment`；12) mismatch→cancel+fatal；13) §6.9 authorize complete result；14) return，不创建attempt或ordinal settlement。
- **分支/退出/残留**：prepare failure no authority；M4 rollback noauthority/send；exact existing result valid despite later policy；success atomically includesLegacy assistant info/relation+M/ledger/heads，type-1不重建user message；every failure unsendable and no fabricated ManualStop。
- **Ensures**：success returns `transport:"authorized-not-released"` with committed context+authorized ordinal0 handle，attempt settlement尚未分配；no model assistant before composite；type-1 may append after prior/type-10 aggregate event while remaininglineage genesis。
- **Side effects**：policy/read, local prepare/cancel, M4 write/read, handle/map state。
- **循环/等待**：§9.11 bound；policy stale causes caller loop only after observing a new committed snapshot, no busy-spin。
- **正确性论证**：dedicated no-handle view→single prepare→same-candidate prepared view排除snapshot fabrication与handle substitution；prepare precedes atomic M4；full result/receipt precedes authorize；per-admission policy+tx recheck enforces current policy；failure ordering removes sendable residue。

### 9.6 `runAdmittedAssistant(input: Readonly<{assistant: AdmittedAssistant}>) -> ChainTransition`

```ts
function runAdmittedAssistant(input: Readonly<{
  assistant: AdmittedAssistant
}>): Effect.Effect<ChainTransition, FatalRecoveryStop>
```

- **Callers**：§9.14/§9.8 child。
- **Callees**：§9.7 creates empty attempt；§7.0.1 allocates ordinal0 once；§7.12 processes；scope finalizers。
- **Requires**：assistant hascomplete ordinal0 result。`authorized-not-released` branch handle authorized/unreleased；`automatic-released` branch hasexact preReleased stream/proof, complete result→pre-release K8 whileprepared→F27/M2 authorize→delegate-boundary release→K9 already complete；no attempt state or settlement exists；ownership live。
- **连续步骤**：1) call§9.7创建empty attempt；2) switch transport only to selectcomplete result carrier：authorized-not-released uses`authorizedOrdinal0.result`；automatic-released uses`releasedOrdinal0.authorization.result` and requires`releaseCallableProofState:"consumed"`；call§7.0.1 exactly once withthat complete result and exact empty destination；3) require returned settlement current ordinal0；4) authorized-not-released passesno preReleased to§7.12，automatic-released passesexact `releasedOrdinal0` and§7.12 mustnot release again；5) process；6) switch outcomes；7) close resources/destroy attempt state。
- **分支/退出/残留**：attempt/allocation failure onauthorized-not-released→cancel/fatal；same failure onautomatic-released cannot undo send，close stream and settle ambiguity/fatal withoutsecond release；all process outcomes；fatal preserves durable facts。
- **Ensures**：one assistant lifecycle；ordinal0 allocated exactly once before event consumption；automatic transport release occurred inK8 dynamic scope and is never repeated；no attempt-local data crosses successor。
- **Side effects**：fresh local state、one ordinal0 map/CAS、M3 provider/tool/evidence + cleanup。
- **循环/等待**：dispatch retry loop owned by§7.12 progress contract。
- **正确性论证**：empty-state post supplies explicit allocator destination；unique call position prevents duplicate ordinal0；M3 exact post yields one transition；scope ownership ensures residue cleanup。

### 9.7 `newAttemptLocalState(assistant: AdmittedAssistant) -> AttemptLocalState`

```ts
function newAttemptLocalState(
  assistant: AdmittedAssistant,
): Effect.Effect<AttemptLocalState, TerminalSettlementError>
```

- **Callers**：§9.6 before ordinal0 allocation/release。
- **Callees**：fresh map/AtomicRef constructors only；不得调用§7.0.1。
- **Requires**：assistant committed/authorized；no existing attempt state。
- **步骤**：1) allocate StructuredOutput fields undefined；2) allocate empty tool map；3) allocate `assistantEvidence.byOrdinal`/summaries empty；4) allocate `currentOrdinal=undefined`；5) return exact object。
- **分支/退出/残留**：success或allocation defect before publication；failure no released handle and nopartial published attempt。
- **Ensures**：structured undefined、tool map empty、ordinal maps empty、current undefined；zero settlement allocations。
- **Side effects**：memory only。
- **循环**：无。
- **正确性论证**：fresh constructors establish isolation；excluding§7.0.1 makes lifecycle order mechanically visible and removes constructor/allocation cycle。

### 9.8 `recoverIncomplete(authority, ownership) -> RecoveryOutcome`

```ts
function recoverIncomplete(
  authority: M4.DurableRecoveryAuthorityViewV1,
  ownership: RunnerOwnership,
): Effect.Effect<RecoveryOutcome, FatalRecoveryStop>
```

- **Callers**：§9.14/reentry after complete incomplete-terminal result and S1。
- **Callees**：M4 S1/S2/A5、K7/K8/K9；§9.12；§9.2–§9.4；M5 §8.1–§8.3；M7 proof-to-closure/post-K7 lowering/same-object validation；M2 §6.3.0/§6.3.1/§6.10.1；§9.10；§9.9；§9.6。
- **Requires**：whole nominal authority view fromM4 S1；source typed terminal durable；ownership live。Caller不得unwrap为plain snapshot or construct structural proof.
- **连续步骤**：1) validate view brand/snapshotIdentity/complete snapshot/toolEligibility；corrupt/partial/owner mismatch/non-foldable/ambiguous fatal；2) resolve existing winner from exact heads；automatic winner follow/reenter child via generic loader，manual/superseded return owner result；3) no winner→freeze current committed policy；4) preallocate successor and build automatic admission plan fromwhole view；5) M5 `selectRecoveryCandidate(authority)`；6) selection manual-only/planning-manual→M5/F23 proposal then§9.10 with no M7/K7/prepare；authority invalid remainsfatal；7) automatic selection yields exact same `snapshotProof`；M7 builds M1 closure fromproof without unseal/lowering；SafeRetry only nominal truly-empty not-needed；Continue onlynominal authoritative-only final proofs；8) allocate stable type-9 operationID before reservation/lease；9) M2 §6.3.0 reserve exact no-send target/gate/handle commitment，no provider prepare；reservation failure has no lease/handle and may enter typed manual classification only afterclosing reservation；10) enumerate closure/lowering-required sealed refs and construct exact M1 lease keys fromsame proof/source/action/operation/candidate/reservation target+commitment/current positive generation；11) callK7 once per ref before any unseal/lower/actual prepare；zero refs require exact empty tuple；partial K7 failure first calls§6.10.1（necessarily`no-handle-barred`）thenK9`abandoned` on acquired subset and zeroize；K9 failure fatal before reservation cleanup/classification/lookup；K9 success→cleanup/close reservation→post-cancel ManualStop classification only if owner cause eligible and no authority corruption；12) M7 throughM4 K3 same leases reconstructs/unseals/strict-decodes replay payload and produces exact `M7.LoweredRecoveryCandidate`; all callback exits zeroize M4-owned buffers；lowering/M7 failure calls§6.10.1 exact no-handle barrier→K9 abandoned→cleanup/reservation close→classification；13) M2 §6.3.1 exactly one actual paused provider preparation consuming same reservation/leases/lowered；14) original inspection→M7 same-object validation→exact planned wrapper；prepare/inspection/M7 validation failure uniformly calls§6.10.1，which returnscancelled-handle orno-handle-barred withoutchangingthe exactprepare signature，thenK9 immediately；K9 failure fatal beforecleanup/lookup/replan，K9 success thencleanup；15) M5 final classification with whole authority+same proof+closure+reservation+leases+planned+admission；M5 failure/manual after handle allocation first§6.10.1 mechanical cancellation thenK9；16) all automatic post-cancel order is`mechanical cancel/no-handle barrier -> K9 close/zeroize -> resource cleanup -> lookup/classify/replan`。Potential ManualStop cleanup retains onlysecret-free one-shot cancel-proof tombstone；§9.10 validates/commits withthat proof theninvalidates tombstone，so cleanup still precedes post-cancel work while ManualStop proof use precedesfinal proof close；manual beforehandle usesK9`abandoned` if leases exist, cleanup, thenfresh no-handle proof；17) automatic→§9.9 with same view identity/proof/closure/reservation/leases/planned；18) O8 success includescommit-time K8；then exact complete result→pre-release K8→F27/M2 authorize/open proof→§6.10 exclusive-latch release→K9；19) only delegated+K9 success child admitted→§9.6 empty attempt+ordinal0 once；released/unknown-delivery returnsfatal ambiguity and never child/resend；20) child incomplete returnswhole new authority view and loops；21) policy/head/source/sealed generation stale followscancel/no-handle barrier→K9→cleanup→freshS1+policy+freshcandidate+freshoperationID+freshreservation/K7/lowering/prepare；no old lease/handle reuse；22) winner follow or fatal。
- **分支/退出/残留**：ManualStop only typed eligible complete-authority causes；automatic child；complete winner；policy/sealed/head replan；fatal. compatibility-only/mixed/manual-only/nonfinal/reconciled/unknown never prepare. Every round has≤1 reservation and≤1 actual provider preparation; all acquired leases closed exactly once on release/cancel/abandon/lost-handle.
- **Ensures**：automatic release only afterO8 complete result+both K8 validations+F27+same handle；canonical state remainsauthorized throughlocal pre-call，only delegate boundary recordsreleased；provider hit remains0 throughpre-release K8、authorization与latch-held local validation；ManualStop nochild；stale/persistence/corruption never release；unknown-delivery terminal never cancel/resend；K9 failure stops beforecleanup/lookup，successful terminal branch retains no M2/M4 secret。
- **Side effects**：M4 authority/lease reads+writes, M7 bounded unseal/lowering, M2 one preparation/cancel/cleanup, child M3 execution。
- **循环 invariant/measure**：successful child increments recoveryOrdinal and boundedN；all model admissions bounded committed effectiveM frompolicy digestInput. Replan requires changed committed identity/epoch/generation/head；unchanged repeated failure fatal. External child progress remains conditional.
- **正确性论证**：nominal S1 selection prevents structural automatic upgrade；reservation→K7→M7→one M2 prepare fixes handle/generation order；same-object inspection and final M5 classification bind plan；O8/K8/F27/release/K9 closes authority and resource lifecycle；F23 supplies fail-closed ManualStop alternative。

### 9.9 `commitAutomaticRecovery(input) -> AutomaticCommitResult`

```ts
function commitAutomaticRecovery(input: Readonly<{
  authority: M4.DurableRecoveryAuthorityViewV1
  snapshotProof: M4.AutomaticRecoveryProofSliceV1
  closure: M1.RecoveryClosureDescriptor
  reservation: M2.PreparedHandleCommitmentReservationV1
  sealedUseLeases: readonly M4.SealedRecoveryUseLeaseV1[]
  proposal: Extract<M1.RecoveryProposal, { kind: "automatic" }>
  planned: Extract<
    M1.PlannedRecoveryMaterialization<M2.AvailableDispatchHandle>,
    { descriptor: { status: "available" } }
  >
  admission: M1.AdmissionPlan
  policy: M6.RecoveryPolicyAuthoritySnapshot
  operationID: M1.RecoveryOperationID
}>): Effect.Effect<AutomaticCommitResult>
```

- **Callers**：§9.8 only。
- **Callees**：M4 O8 `commitAutomaticChild`（内部first-apply K8）；§9.11 A5；M4 S2/S1；M4 `validateSealedRecoveryUseLeasesImmediatelyBeforeRelease`；M1 F27；§6.9/§6.10/§6.10.1/§6.11/§6.11.1；M4 K9；§9.10 only under explicit pre-existing independent-cause rule。§7.0.1只由后续§9.6调用。
- **Requires**：whole authority/snapshotProof/closure same identity/action；reservation/lease set/planned/handle all same source/action/type-9 operation/candidate/target/generation/commitment；planned exact nested wrapper；proposal final M5 automatic；policy frozen；O8 input carries exact lease tuple and snapshotIdentity；hit=0。
- **连续 discrimination**：1) validate type-9 predecessor/child genesis and all cross-bindings；2) callO8 with exact input、`planned.pausedHandle.prepared`、policy expectation、`authority.snapshotIdentity`、same leases；3) O8 first-apply K8 verifies live set before raw cursor；success/exact replay returnscomplete result；exact replay from historical result cannot release unlesssame current handle+leases still live and subsequent K8 succeeds；4) on complete result immediately callpre-release K8 validator withreservation/handle commitment+same leases，no intervening unseal/prepare/authority step；5) K8 success→call§6.9 automatic withsame proof/reservation/leases，F27+raw identity authorize并取得`authorized/open` release-callable proof；6) call§6.10 immediately；it acquiresexclusive latch while state remainsauthorized/not-delegated，only delegate boundary recordsreleased/delegated orreleased/unknown；only delegated stream+K9 released success constructs`admitted`；7) O8 CAS loser or original-response ambiguity before release firstcalls§6.10.1 and requires`cancelled-handle`；then immediatelyK9`mechanically-cancelled`+zeroize。K9 failure returnsfatal immediately withall subsequent-action counters0；8) K9 success后立即§6.11.1 cleanup；因后续仍可能ManualStop，该cleanup返回secret-free one-shot cancel-proof tombstone。只有cleanup完成后才允许A5 exact tuple，missing才S2；complete automatic/manual/superseded winner→invalidate tombstone andfollow winner，never release cancelled handle；9) A5 absent+S2 unchanged+freshS1 same source binding and a safety cause classified beforeautomatic attempt may enterindependent ManualStop；§9.10使用tombstone中的same exact cancel proof，complete type-8 result resolution后立即invalidate。fixed order`cancel -> K9 -> cleanup/zeroize -> A5/S2/freshS1 -> ManualStop commit -> final tombstone invalidation`；10) policy/head/source/sealed-generation stale with operation absent/no winner→K9与resource cleanup alreadycomplete→invalidate any tombstone→freshS1/current policy returnreplan；11) corrupt/partial/owner mismatch/nonfoldable/unresolved/ambiguous lookup orauthority→K9与resource cleanup alreadycomplete→invalidate tombstone→fatal，neverManualStop；12) pre-release K8 failure occurs whilehandle stillprepared and calls§6.10.1 withF27/auth/release/delegate counters all0；F27/authorization failure similarly calls§6.10.1 beforelatch/delegate；both thenK9，K9 failure fatal beforecleanup，K9 success→cleanup thenuseknown complete result/generic child authority to settle known-no-send，no replacement prepare/release；13) failures fromM7/M5/prepare/inspection arriving beforeO8 obeysame immediate cancel-or-no-handle barrier→K9→cleanup rule in§9.8，and no A5/S2/replan occurs beforeK9；14) §6.10 known-not-delegated already performs latch exit→cancel→K9→cleanup，then this function returnsfatal/settlement steering for the committed child without resend；delegated-error already hasreleased/delegated→K9→cleanup and steers typed transport failure withoutsame-handle retry；released-unknown-delivery already performsK9 abandoned→cleanup and returnsfatal ambiguity，nevercancel/A5 resend/ManualStop；15) every automatic terminal branch attemptsK9 exactlyonce；K9 failure preserves lease relation and isfatal，no second release；16) no branch allocates ordinal settlement here。
- **分支/退出/残留**：`admitted|replan-policy-stale|follow-winner|fatal-stop` exhaustive。Only admitted branch has one delegated boundary, one provider delegate and closed released leases；all others have cancelled orreleased-unknown terminal state and leases closed, except explicit K9-fatal which deliberately precedescleanup/lookup。
- **Ensures**：automatic authority commit consumescommit-time K8；release path isexact `complete result -> pre-release K8 -> F27/M2 authorize/open -> exclusive release latch -> delegate-boundary released -> K9`。`admitted` carries`transport:"automatic-released"` plus exact delegated stream/proof and closed released leases；provider hit=0 throughauthorized latch local validation；M1 descriptor exact；historical result not revoked but cannot revive old handle/lease；everypre-release failure K9-closes/zeroizes beforecleanup/A5/S2/replan，ManualStop keeps its cancel proof untilcomplete type-8 resolution；unknown never resend。
- **Side effects**：M4 O8/A5/S2/S1/K8/K9, M2 authorize/latch/cancel/release/cleanup；no settlement allocation；optional ManualStop only throughcomplete type-8 result。
- **循环/等待**：§9.11 fixed bound；S2/S1/K8/K9 each finite；no TTL/spin。
- **正确性论证**：O8 K8 provescommit-time live binding；complete-result-adjacent K8 provesrelease-time same generation/operation/handle；F27+M2 identity andconstructible callable proof prevent substitution；exclusive latch removesauthorized/release/cancel race。Cancel→K9→cleanup beforeA5/S2 and K9-fatal early exit preventloss of lease relation；boundary-only released transition and unknown terminal preventduplicate child/send or ambiguity resend。

### 9.10 `finalizeManualStop(input) -> SourceAssistantResult`

```ts
function finalizeManualStop(input: Readonly<{
  authority: M4.DurableRecoveryAuthorityViewV1
  proposal: Extract<M1.RecoveryProposal, { kind: "manual-stop" }>
  candidateContext: M1.CandidateDispatchAttemptContext
  handleDisposition:
    | Readonly<{ kind: "no-handle"; proof: M2.NoPreparedHandleProofV1 }>
    | Readonly<{ kind: "live-unreleased"; handle: LinearDispatchHandle }>
    | Readonly<{
        kind: "cancelled-cleanup-tombstone"
        proof: M2.MechanicallyCancelledUnreleasedHandleProofV1
        secretBytesRetained: 0
      }>
  sealedLeaseDisposition:
    | Readonly<{ kind: "none"; leases: readonly [] }>
    | Readonly<{
        kind: "closed"
        leases: readonly M4.SealedRecoveryUseLeaseV1[]
        reason: "mechanically-cancelled" | "abandoned" | "lost-handle-cleanup"
        reservation?: M2.PreparedHandleCommitmentReservationV1
      }>
  operationID: M1.RecoveryOperationID
}>): Effect.Effect<SourceAssistantResult, FatalRecoveryStop>
```

- **Callers**：§9.8 and explicit§9.9 independent-cause branch only。
- **Callees**：M1 F23 + `buildBindingDigestInput` manual-stop branch + F22 + `validateRecoveryProposal`；§6.11；M4 `commitManualStop`；§9.11；§6.11.1。
- **Requires**：proposal came fromM5/F23 overcomplete authority view；manual-only/planning cause current and source binding fresh；proposal branch-exact manual binding forbidsautomatic target/prepared fields；candidateContext exact。If K7 ever acquired leases, caller alreadymechanically cancelled/abandoned as applicable, successfully K9-closed exact complete set and zeroized retained bytes；`sealedLeaseDisposition.kind="closed"` proves that lifecycle. No live lease may enter type-8 commit。`handleDisposition`三分支closed：early manual passescurrent no-handle proof；direct live branch same context/unreleased且本函数负责cancel；post-O8/pre-release failure passes§6.11.1 cleanup产出的secret-free one-shot cancelled tombstone。
- **连续步骤**：1) validatewhole authority identity and rebuildF23/manual binding；2) failed automatic attempt additionally requireK9+resource cleanup alreadycomplete、A5 absent+S2 unchanged+freshS1 same source andpre-existing cause；3) switch handleDisposition：no-handle→validate exact current proof；live-unreleased→mechanical cancel and obtain proof，若leases exist先K9 thenresource cleanup withmanual-stop tombstone beforecontinuing；cancelled-cleanup-tombstone→validate same tombstone/proof/context and `secretBytesRetained===0`；4) if leases exist requireK9 closed disposition same handle/reservation/operation and no retained bytes；5) project handleClosure/rebuild binding exact proposal；6) callM4 type-8 withseparate valid M2 no-handle/cancel proof；7) resolve response loss exact；8) complete result success→invalidate cancel tombstone/final no-op cleanup and return `authority.snapshot` source+result；9) CAS loser follow complete winner only aftertombstone invalidation，not claim thisManualStop；10) conflict/partial/corrupt/persistence/ambiguity invalidate tombstone andfatal。
- **分支/退出/残留**：durable ManualStop only withcomplete type-8 result；failure never returnsmanual outcome；authority corruption no fallback；lease close failure fatal beforeinitial resource cleanup/lookup/commit。Tombstone never carriesclosure/secret and is terminally invalidated on every exit。
- **Ensures**：mechanical cancel→K9 close/zeroize→resource cleanup happen-beforepost-cancel A5/S2/classification/commit whenapplicable；M4 proof validation/commit happen-beforefinal tombstone invalidation；success nochild/consumption and noM2/M4 secret residue。
- **Side effects**：M2 cancel/resource cleanup/tombstone invalidation/reservation close、M4 K9/write/read/projection。
- **循环**：bounded§9.11 + finite cleanup。
- **正确性论证**：F23 validation fixes reason identity；secret-free one-shot tombstone preserves exact cancel proof afterrequired early cleanup without preserving sendability/lease bytes；only exact receipt constructs result, so persistence failure cannot masquerade as durable ManualStop。

### 9.11 `resolveCommitResponseLoss<T>(input) -> CommitResolution<T>`

```ts
function resolveCommitResponseLoss<T extends M1.RecoveryOperationType>(input: Readonly<{
  lookupKey: M1.RecoveryOperationLookupKeyV1<T>
  expectedInput: M1.RecoveryOperationInputV1<T>
  expectedPayloadDigest: M1.OperationPayloadDigest
  expectedReceiptKind: M1.ReceiptForV1<T>["receiptKind"]
  resubmitSameOperation: () => Effect.Effect<M1.OperationCommitResultV1<T>, M4.RecoveryAuthorityErrorV1>
  safeToResubmit: () => boolean
}>): Effect.Effect<CommitResolution<T>>
```

- **Callers**：all M4 write wrappers in this document。
- **Callees（pre/post）**：M4 A5 `lookupRecoveryOperationResult({key,expectedInput,expectedPayloadDigest,expectedReceiptKind})`，其中`key=input.lookupKey`是exact aggregate-scoped `M1.RecoveryOperationLookupKeyV1<T>`；A5验证owner mapping、historical operation prefix与full current fold并返回complete result或`undefined`；original commit wrapper same scoped ID resubmit。
- **Requires**：`lookupKey.sessionID+aggregateID+operationID+expectedOperationType`、payload digest、predecessors与complete expected input fixed before first submit and pairwise equal；operationID-only/global lookup禁止；dispatch resubmit retains same live paused handle/ownership；non-dispatch uses operation-specific safety pre。
- **exact sequence**：1) call A5 lookup #1 with `{key:input.lookupKey,expectedInput,expectedPayloadDigest,expectedReceiptKind}`；2) exact returns original complete `OperationCommitResultV1<T>` (operation/applyMode/operationPostState/receipt), never detached/rebuilt receipt；3) wrong scope/type/payload→conflict；4) partial/corrupt/unknown→partial-or-corrupt；5) DB read/busy/persistence error→persistence-fatal or ambiguous according to owner discriminator；6) genuine scoped missing and `safeToResubmit=false`→missing；7) genuine scoped missing+safe→resubmit same aggregate/operation ID/payload once；8) resubmit success returns exact result；9) resubmit response lost→lookup #2；10) exact/missing/conflict/partial/persistence branches as above；no further call。
- **退出/残留**：committed/missing/conflict/partial-or-corrupt/persistence-fatal/ambiguous exhaustive；function never mutates handle or publishes public result。
- **Ensures**：at most two aggregate-scoped lookups plus one same-aggregate/same-operationID resubmission；only complete exact folded result accepted；no operationID-only/global lookup、newID、zero-row fake success或current-policy revocation。
- **Side effects**：≤2 M4 reads + ≤1 original same-ID transaction resubmit。
- **循环/termination**：no loop; fixed finite decision tree。
- **正确性论证**：complete tuple lookup plus exact result retains operationPostState/receipt equality; missing is sole resubmit gate; fixed call counts prove bound; all nonexact states fail closed。

### 9.12 `reenterCommittedAssistant<K>(input) -> ReentryDecision`

```ts
function reenterCommittedAssistant<
  K extends M4.CommittedAssistantAdmissionOperationV1,
>(input: Readonly<{
  aggregateID: M1.RecoveryAggregateID
  sessionID: string
  assistantID: M1.RecoveryAssistantID
  admissionOperationType: K
  runtimeRegistry: RuntimeRegistry
}>): Effect.Effect<ReentryDecision, ReentryError | FatalRecoveryStop>
```

- **Callers**：§9.14/restart/attach for nonterminal reentry；§9.8只在继续驱动尚未terminal的automatic child时可调用，不以terminal source snapshot调用。
- **Callees**：exact `M4.loadCommittedAssistantAuthorityView<K>`；§7.8.1/O3a restart reconciliation；same-process registry；M4 A5 for exact never-released only。M4 S1不在本函数直接调用。
- **Requires**：selector exact，admission type closed type1/type2/type9；nonterminal reentry且尚未admit successor；不得传receipt/operationID/plain snapshot替代selector。Restart registry empty/unknown时必须先处理view中all latest intermediate authoritative tool phases。
- **连续步骤/branches**：1) loadexact generic view；2) terminal/closed/authority invalid→known terminal owner orfatal，no partial；3) scan latest authoritative tool calls：final/reconciled no-op，planned/body-outcome/unknown逐项§7.8.1/O3a；fatal branch stops；`cancelled-before-allocation`立即向resume coordinator返回ownership-cancelled decision，no write/no attach/no successor；4) reload same generic view afterany O3a append；if terminal barrier now externally committed, exit toterminal owner path；5) compare assistant/context/admission result/registry；6) live exact processor→attach；7) same exact never-released nonautomatic `authorized/open` handle may resume fromcomplete authorizing result/F26；automatic may resume only ifhandle is still`prepared` withsame live K7 leases+reservation, thenexact complete result→fresh pre-release K8 whileprepared→F27/M2 authorize→immediate release。Automatic `authorized/open` observed outsideits original contiguous release scope cannot reacquireprepared-only K8；mechanical cancel→K9→cleanup→settle-known-no-send。`authorized/held` withlive owner onlyattach/wait，owner lost becomesunknown terminal；8) known no delegate lost→settle-known；9) released/unknown-delivery or lost held ownership→K9/K10 as applicable beforecleanup，thenfatal ambiguity/observation settlement，neverresend；10) registry mismatchfatal。
- **退出/残留**：closed ReentryDecision；only O3a append/K9 cleanup may write beforedecision；no S1 untilcomplete incomplete terminal。Terminal observation不是本union branch。
- **Ensures**：generic view preserved for all origins；intermediate tools becomeappend-only manual-only withoutcallbacks；predecessor blocks successor；restart never recreates handle/lease/request；automatic old handle onlysame-process samelease validation。

- **Side effects**：M4 generic authority/A5/registry reads only。
- **循环**：无。
- **正确性论证**：M4 `nonterminal:true` view supplies exact admission/current dispatch/facts；registry only adds same-process facts；exact lookup cannot manufacture handle；terminal rejection保持S1与generic view互斥。

### 9.12.1 `settleCommittedAssistantWithoutHandle<K>(input) -> AssistantProcessOutcome`

```ts
function settleCommittedAssistantWithoutHandle<
  K extends M4.CommittedAssistantAdmissionOperationV1,
>(input: Readonly<{
  authority: M4.CommittedAssistantAuthorityViewV1<K>
  sendState: "known-not-delegated" | "unknown"
  runtimeEvidence?: AssistantRuntimeEvidence
  sealedUseLeases?: readonly M4.SealedRecoveryUseLeaseV1[]
  lostReservation?: M2.PreparedHandleCommitmentReservationV1
}>): Effect.Effect<AssistantProcessOutcome, FatalRecoveryStop>
```

- **Callers**：§9.12 lost-handle branches only。
- **Callees**：§7.13.1 exact drain predicate；if must-drain then§7.9；if no-local-evidence no drain；if inconsistent fatal；then§7.13。§7.13 exact incomplete commit success后才调用S1；generic loader不在terminal post-state重调。
- **Requires**：`authority.nonterminal===true`且来自exact M4 loader，证明initial/ordinary/automatic child committed/current dispatch exact；no attachable processor/exact handle；successor forbidden。`M1.DurableRecoverySnapshot`在type上禁止。
- **连续步骤**：1) compare authority/current dispatch/runtime evidence；2) beforelost-handle settlement，scan/reconcile intermediate tools via§7.8.1；3) decide drain；4) must-drain exact；no-local continue without inventing；inconsistent fatal；5) ifautomatic lost handle hasknown lease tuple，K9 close reason`lost-handle-cleanup` and zeroize beforeM2 cleanup；missing/ambiguous lease registry isfatal，not TTL cleanup；6) close lost reservation；7) commit known/unknown abandonment/ambiguity exact incomplete terminal；8) consume complete result；9) only thenS1 and returnwhole`{tag:"incomplete",authority}`；10) any commit/lookup/K9/S1 failure fatal。
- **分支/退出/残留**：drain three branches、lease none/known/ambiguous、send known/unknown explicit；no optional drain、old-handle recreation、normal fabrication、post-terminal generic view或precommit snapshot。
- **Ensures**：existing evidence retained；intermediate tools manual-only；successor only after terminal durable；lost handle leases closed+zeroized；S1 whole view preserved。
- **Side effects**：conditional O3a/drain/K9 + M4 incomplete terminal write；S1 aftercomplete result；registry cleanup。
- **循环/等待**：drain progress contract§7.9；no new timeout。
- **正确性论证**：closed drain predicate partitions runtime state；generic nonterminal authority identifies the exact current dispatch；complete terminal result is the gate for the only legal S1 call。

### 9.13 `supersedeBeforeNewUserInput(input) -> SupersessionResult`

```ts
function supersedeBeforeNewUserInput(input: Readonly<{
  candidate: M6.UnpreparedNonAuthoritativeNewInputCandidate
  expectedAggregateEventHead: M1.AggregateEventHeadV1
}>): Effect.Effect<SupersessionResult, FatalRecoveryStop>
```

- **Callers**：§9.15 model/no-reply only。
- **Callees**：M4 O10 `commitAndValidateSupersessionBeforePrepare`的`inspect-current-authority`与`complete-expected-input`两branch；M1 exact supersession input/payload builders、`buildSupersessionBindingDigestInput`+F22；§6.10.1/§6.11 old handle、M4 K9、§6.11.1 cleanup。M6不得直接调用O9 `commitNewInputSupersession`；O10内部拥有O9/A5/S2/S1。
- **Requires**：new input has zero message/assistant/dispatch/handle authority；candidate是closed pre-inspection model/no-reply union，只有session/submission digest以及model intended type-1 operationID或no-reply fixed user-only disposition；candidate不含source/control/predecessors、supersession binding input/digest或M4 authority brand；expected aggregate head来自same serialized owner current-authority read。
- **步骤**：1) exact validate pre-inspection candidate；2) 调O10 `inspect-current-authority`，以C1/MIG1 owner mapping+dedicated current prefix/head判定empty/no-unresolved/unresolved/winner，禁止构造`M1.DurableRecoverySnapshot`；3) no unresolved source→O10返回`model-no-unresolved-source` branded proof或no-reply user-only branch（无type-10 operation）；4) unresolved→O10只返回branded `M4.SupersessionRequiredAuthorityV1`，不得内部commit或返回partial proof；5) M6 cancel old handle；若它是已K7的automatic pre-release reservation，调用§6.10.1→K9`mechanically-cancelled`→§6.11.1 cleanup，K9 failure在O10 complete/A5/S2前fatal；nonautomatic仅§6.11→cleanup。Only aftercleanup，把authority的source/control/predecessors/next revision与candidate逐字段组合，构造branch-exact `SupersessionBindingDigestInputV1`，经M1 builder/F22取得digest，并把full input+digest exact复制进type-10 payload/decision material；6) build完整`RecoveryOperationInputV1<"source-superseded">`+payload digest并以O10 `complete-expected-input` branch重入，禁止direct O9；7) model validated complete result→return`model-proceed`及O10 branded proof bound to exact post aggregate head/reservation；8) no-reply validated complete result→return user-only且无model proof；9) automatic winner→O10 only after current authority proves source complete `OperationCommitResultV1<"incomplete-terminal-recorded">`调用S1并返回whole same-snapshot `M4.DurableRecoveryAuthorityViewV1`+complete type-9 result，M6 follow child；10) manual/existing-superseded closed source由O10归入branch3的no-unresolved outcome，不另造winner union；11) corrupt/missing/partial/owner mismatch/non-foldable/ambiguous/persistence without valid winner fatal；12) old handle cleanup alreadycomplete beforeO10 complete branch；result resolution只做idempotent no-op finalization。no M7/M2 before model proof；no M7/M2 at all for no-reply；detached receipt不授权任一branch。
- **分支/退出/残留**：O10 inspect的model/no-reply no-source、supersession-required、automatic-winner与O10 complete-input的model/no-reply validated/automatic-winner均closed；M6投影为model-proceed/no-reply-user-only/follow automatic/fatal。inspection authority仅用于一次完整input构造，head变化即stale；new lineage never forks winner；no-reply cannot enter model path。
- **Ensures**：old recovery winner resolution happens-before user commit；model proof preserves exact type-10 post head and reservation reference；no-reply carries no future type-1 reservation；shell excluded。
- **Side effects**：old mechanical cancel、automatic K9、pre-O10-complete cleanup、M4 supersession/read/runner steering。
- **循环**：single CAS+single winner reload, no spin。
- **正确性论证**：two-stage O10使source/control/predecessor facts只能来自branded same-tx inspection authority，complete branch再以exact full input/digest经O9/A5验证；recovery-head CAS total-orders old recovery/new input；closed candidate/result unions prevent no-reply proof fabrication；only complete verified result/proof permits branch-specific continuation。

### 9.14 `runModelChain(input) -> SessionV1.WithParts`

```ts
function runModelChain(input: Readonly<{
  sessionID: string
  scopeKey: M6.RecoveryPolicyScopeKey
  initialMessages: readonly ModelMessage[]
  initialAuthority: M4.InitialAdmissionAuthorityViewV1<M2.NoPreparedHandleProofV1>
  ownership: RunnerOwnership
}>): Effect.Effect<SessionV1.WithParts, FatalRecoveryStop>
```

- **Callers**：§9.15 model branch/subtask child。
- **Callees**：M4 origin-specific authority readers/binders；§9.12/§9.12.1 only for already-committed assistants；preplanned tool；§9.2–§9.6/§9.8；ordinary converter；compaction/task handlers。
- **Requires**：new user turn durable and exact user-message predecessor captured；initialAuthority是M4 no-handle staged view，来自committed dedicated owner mapping/current aggregate head（fresh empty为genesis）、current policy、same candidate与same model `source-superseded`/no-source proof；post-supersession aggregate head等于type-10 post head；它不是`M1.DurableRecoverySnapshot`。ownership live；shell/no-reply excluded。
- **步骤**：1) validate initial no-handle view；2) process finite nonmodel work；3) initial admission passes exact lineage-genesis/current-aggregate authority to§9.5；4) admit→§9.6 creates empty attempt→allocates ordinal0 once→run；5) ordinary continuation的live predecessor若需same-process reentry，先以`M4.loadCommittedAssistantAuthorityView<K>`/§9.12 resolve exact nonterminal current dispatch；lost handle走§9.12.1，不得读取terminal recovery snapshot；已完成ordinary predecessor由其own complete process/terminal result证明，不调用nonterminal loader；6) predecessor normal terminal/settled后fresh freeze policy→preallocate candidate→`M2.proveNoPreparedHandleV1`→`M4.loadOrdinaryAdmissionAuthorityView`，不得读取/复用terminal recovery snapshot或prior policy；7) ordinary admit/run；8) only an `incomplete` transition whose terminal commit already succeeded calls§9.8 with the fresh whole `M4.DurableRecoveryAuthorityViewV1` returned byS1；9) compaction perowner then loop；10) final return effective assistant。
- **分支/退出/残留**：M exhausted ordinary uses existing max-step contract without over-limit assistant; incomplete M/N cause flows M5/F23; ManualStop source; automatic final child; orthogonal error。
- **Ensures**：only committed model admissions countM；ordinary notN；no stale-chain policy exception；no nonterminal predecessor successor。
- **Side effects**：nonmodel existing writes、M4 admissions/recovery、M2/M3 execution/status。
- **循环 invariant/measure**：model admissions≤M; automatic children≤N; finite queued nonmodel items. Provider/tool external progress is conditional on terminal/abort/cancellation; no unconditional termination claim。
- **正确性论证**：reentry barrier precedes each admission; §9.5 per-admission policy+atomicity; bounded counters preserveN/M; outcome switch returns latest effective assistant。

### 9.15 `SessionRunState.submitSerialized(input) -> CoordinatorResult`

```ts
function submitSerialized(input: SerializedSubmission): Effect.Effect<CoordinatorResult>
```

- **Callers**：M8 public wrappers only。
- **Callees**：per-session runner；M1 canonical submission digest validator；§9.13；user-message commit owner + §9.11-style exact same-process lookup; §9.14; existing owner-qualified `SessionPrompt.startShell/shellImpl`。
- **Requires**：M8 constructed one internal operationID+canonical payload digest for this handler invocation；session exists。
- **连续 identity/queue steps**：1) lookup `(sessionID,operationID)`；2) missing→enqueue/store digest/ownership；3) same ID+same digest active→attach；4) completed→cached internal result；5) same ID+different digest→fatal/conflict；6) acquire serialized ownership；7) `shell`直接调用existing shell owner，仍串行但绕过supersession/policy/M7/M2/N/M/model admission；8) `model`先分配intended type-1 operationID，并只以`sessionID+submissionPayloadDigest+intendedInitialOperationID`构造exact `M6.UnpreparedNonAuthoritativeNewInputCandidate`；M4 dedicated current-authority read此时只提供§9.13/O10 inspect所需的current `expectedAggregateEventHead`（empty aggregate为C1/MIG1 genesis），不得向candidate或其它coordinator state复制source/control versions、recovery predecessor或supersession binding material；随后调用§9.13，只有其O10 `inspect-current-authority`返回branded `M4.SupersessionRequiredAuthorityV1`后，才由§9.13从该authority+candidate构造complete type-10 expected input/binding并以`complete-expected-input`重入O10；automatic winner则follow/steer后以fresh current facts重新评估而不fork；9) model-proceed后commit user message，response loss只same operation lookup；10) validate committed user row；11) fresh freeze current policy→preallocate initial candidate→`M2.proveNoPreparedHandleV1`→`M4.loadInitialAdmissionAuthorityView`，其owner/current head/policy/user predecessor/candidate/no-handle proof与complete type-10/no-source M4 proof exact绑定；12) 把该M4 no-handle view传§9.14，existing converter/M2只在§9.5单次执行；13) `no-reply`只以`sessionID+submissionPayloadDigest+replyDisposition:"commit-user-only"`构造exact pre-inspection candidate，机械排除intended type-1 operationID/reservation ref/binding input/digest；M4 read同样只提供O10 inspect的current aggregate head并调用§9.13，只有branded supersession-required authority branch才在§9.13构造完整no-reply type-10 binding/input并重入O10；only no-reply-proceed后commit user message并立即return user-only；14) no-reply机械禁止`freezeAdmissionPolicy/preallocateAssistantCandidate/M5/M7/M2/commitCompositeAdmissionDispatch/authorizeDispatch`；15) disconnect只detach waiter；16) completion stores/resolves。
- **分支/退出/残留**：model-final/user-only/shell-final/fatal-stop；no-reply permitted effects只有queue、required type-10 no-reply supersession、user commit；其policy reads/freezes、candidate assistant、M7/M2 calls/handles、type-1、assistant/ledger/head/M consumption均为0。shell serialized但recovery/model effects为0。
- **Ensures**：stable internal identity supports same-process response-loss attach/lookup；sameID mismatch conflicts；old recovery finalization precedesmodel/no-reply user commit；noReply cannot admit model；M6 does not define public HTTP resend/idempotency。
- **Side effects**：runner registry/queue、user transcript、model chain或shell process；no M8 public signal ownership。
- **循环/wait progress**：finite queue prefix decreases per completion；active model/shell waits rely on their terminal/abort/cancellation contracts, no new general timeout/unconditional termination。
- **正确性论证**：identity lookup before enqueue prevents duplicate same-process execution；serialized ownership orders submissions。Exact candidate union把pre-inspection state闭合为session/submission facts加model intended type-1 ID或no-reply fixed disposition；M4 pre-inspection read只提供O10 inspect aggregate head，因此coordinator无法提前拥有source/control/predecessor-dependent binding。§9.13仅在O10返回same-transaction branded `M4.SupersessionRequiredAuthorityV1`后构造完整type-10 input/digest并重入complete branch；故validated supersession/no-source outcome happens-before user commit，且branch-specific callees最终产生唯一`CoordinatorResult`并保持M6/M8 boundary。

### 9.16 M8 public wrapper boundary（引用，不拥有）

M8 exact ownership remains in `sessrec-4-legacy-lowering-public-contract.md`：

1. 每个public handler调用至多构造并提交一个`SerializedSubmission`，其internal operationID/digest只用于该same-process accepted operation与waiter attach，不是public idempotency key。
2. prompt/command/noReply/shell按现有mapping调用§9.15；sync prompt/command必须等待`runModelChain`完整返回，automatic success的`model-final.effectiveAssistant`是最终child，committed ManualStop是source；`noReply`不得先写user或attach旧run；prompt_async只fork/transfer一次scope-owned完整operation并在acceptance后返回既有204/empty body，model/recovery chain继续background运行。
3. HTTP/SDK/CLI/TUI disconnect在M6接受identity后只detach response waiter，不cancel handle/undo transaction；server operation继续。
4. **没有public stable idempotency contract时，indeterminate disconnect后M8、SDK、CLI/TUI不得透明HTTP resend，也不得把新internal operationID伪装成原operation replay。** 只可hydrate/observe durable transcript/status/projection；用户显式重试是新操作。未来若要透明resend，必须先由M8/OpenAPI/SDK定义public idempotency key。
5. public event/HTTP/UX/error redaction仍由M8；M6只返回internal result。

## 10. Outer retry、multiple dispatch 与 abandonment 的精确规则

1. generic retry iff现有`SessionRetry.policy(...)`对本次typed error返回continue decision；本文不维护第二套status/body/text predicate。covered 429/503行为保持。M1 canonical incomplete typed guard在调用policy前直接排除。
2. accepted retry固定顺序：status write成功→existing policy wait→wait未被abort/cancel且ownership仍live→generic M4 view revalidation→drain/close current ordinal→fresh next-ordinal context+operationID→`prepareSubsequentDispatch` exactly once→M4 type3 ledger→F26 authorize→对exact attempt destination分配fresh settlement exactly once→release。status write、wait cancel、ownership loss、drain、prepare、commit、authorize、allocation任一失败都不send next ordinal。
3. 每次retry state完全fresh；assistant-wide summary与per-ordinal objects分离。prepare/record/authorize均不改变destination map/current ordinal，唯一mutation是§7.0.1。late old event、future ordinal、duplicate current object或ordinal0 evidence满足ordinal1 terminal均产`dispatch/ledger-conflict` cause。
4. AI SDK `maxRetries=0`、descriptor hidden retry=0、native gated internal retry=0。同invocation second fetch在自身downstream前失败且不rotation；first已delegate只保留first send事实并settle ambiguity。
5. 最终incomplete dispatch selection按M5 closed四分处理：missing→`dispatch/ledger-conflict(detail:"missing-ledger")`；exact selected opaque→`provider-introspection/descriptor-not-readable`；gap/conflict→`dispatch/ledger-conflict(detail:"gap-or-conflict")`；multiple plausible current attempts→`dispatch/multiple-plausible-attempts`。只有最后一项经M1 F23映射`dispatch-ambiguous`；不得以“not exactly one ordinal0”合并四类。
6. opaque runtime内部重发不可枚举；initial/ordinary兼容，但incomplete exact selected opaque只产provider-introspection cause；若另有可证明的ledger gap/conflict或multiple plausible，再分别产其exact dispatch cause，不互相替代。
7. retry/tool/provider waits不新增通用timeout。finite set loops按集合大小终止；external stream/body progress只依赖terminal/error/abort/runner cancellation/process termination，不宣称无条件termination。

## 11. Supersession、crash 与 re-entry 状态表

| Durable/runtime state | Exact owner action | Forbidden | Result |
|---|---|---|---|
| terminal source, no decision | fresh S1 whole `DurableRecoveryAuthorityViewV1` + per-round policy + plan | plain snapshot/old proposal/policy | replan |
| prepared recovery handle, O10 `complete-expected-input` internally commits type-10 and wins | cancel；ifautomatic K7 thenK9→cleanup；onlythen O10 complete/A5 verifies `OperationCommitResultV1<"source-superseded">` | direct O9、O10/A5 beforeK9-cleanup、release old handle | source superseded |
| `commitAutomaticChild("automatic-child-admitted-and-consumed")` wins | O8 commit-K8 complete result→pre-release K8→F27/M2 authorized/open proof→exclusive latch→delegate-boundary released/delegated→K9；O8 response-loss/CAS loser usescancel→K9→cleanup(tombstone if needed)→A5/S2 thenfollows winner | second child/eager authorized→released/old-handle release/ManualStop source | follow winner |
| completed normal assistant | observe its own complete process/terminal result or durable Legacy projection owner path | call nonterminal M4 loader/load S1 | deterministic observe |
| exact incomplete-terminal complete result | load S1 and recover/observe | precommit/nonterminal S1 | terminal recovery snapshot |
| nonterminal + exact live processor/current ordinal object | nonterminal M4 view + registry exact then attach | second processor/successor | attach |
| same process exact nonautomatic handle `authorized/open`, never latched/released | generic M4 view + A5 exact/F26 proof revalidation thenrelease once | new ID/new handle/eager released state | resume once |
| same process exact automatic handle still`prepared` aftercomplete result | same live leases/reservation→fresh pre-release K8 whileprepared→F27/M2 authorize→immediate release/K9 | authorize withoutK8/reuse stale K8 | resume contiguous suffix once |
| automatic handle `authorized/open` found outsideoriginal release scope | mechanical cancel→K9→cleanup→known-no-send settlement | reacquireprepared-only K8/release/resend | terminal then recover/observe |
| same-process handle `authorized/held/not-delegated` with live release owner | attach/wait forowner to producecancelled orreleased terminal；no concurrent cancel/release | steal latch/finalizer cancel/second delegate | owner completes transition |
| held latch owner lost before exact boundary proof | markterminal released/unknown-delivery；automatic K9/K10 as process-liveness contract allows，thenfatal ambiguity | rollback toauthorized/cancel/resend | fail closed/fatal |
| handle known never delegated but lost | generic M4 view→§7.13.1 exact drain→known-no-send incomplete settle complete→S1 | optional skip of evidence/pre-settlement S1/post-terminal generic reload | terminal then recover |
| released/unknown-delivery or release ownership lost | K9 close/zeroize beforecleanup；generic M4 view→exact drain/ambiguity durable settlement only forlater observation，current caller returnsfatal ambiguity | cancel/resend/recreate/successor first/post-terminal generic reload | fatal/observe only |
| ordinal registry mismatches current receipt | fatal inconsistency | merge/ignore old evidence | stop |
| policy/source/head/sealed generation changes before first apply | cancel；automatic K9 close+cleanup；initial/ordinary rebuild staged authority，automatic freshS1 whole view+policy+candidate+operationID+reservation+K7+lower+one prepare | stale commit；reuse oldproof/lease/handle；initial/ordinary调用S1 | replan |
| exact historical result after policy change | validate operation+receipt+post-state | revoke via current policy | replay/observe |
| response lost | nonautomatic/non-dispatch uses§9.11 bounds；automatic pre-release O8 firstcancel→K9→cleanup，thenA5/S2 and never same-handle resubmit/release | automatic lookup beforeK9、new operationID、resend | exact/missing/conflict/fatal |
| automatic commit fails | exact absence/no-winner + valid source binding before ManualStop；otherwise fatal | corruption→ManualStop | closed fail-safe |
| no-reply supersession/no-source valid | commit user only | policy/M7/M2/type-1/assistant/ledger/M | user-only |
| same-process submission same ID+digest | attach/cached result | execute duplicate | same result |
| same submission ID different digest | conflict | accept/merge | fatal/conflict |
| HTTP disconnect without public idempotency key | detach+hydrate/observe | transparent resend | server continues/unknown client view |
| restart tool latest `planned` | allocate one reconciliation token→O3a append unknown/unknown reconciled manual-only | body/after-hook callback、invent result | barrier-close/manual-only |
| restart tool latest `body-outcome-durable` | preserve durable outcome carrier/commitments→O3a append afterHook unknown reconciled manual-only | rerun body/after-hook、rewrite outcome | barrier-close/manual-only |
| restart tool latest `unknown-intermediate` | O3a append unknown/unknown reconciled manual-only | infer fromLegacy/history、rerun callbacks | barrier-close/manual-only |
| restart tool latest `final-after-hook-settled`/already reconciled | no-op/reload | duplicate settlement allocation | terminal proof/manual-only as owned |
| live sealed-use leases + process death | onlyM4 K10 with exclusive dead-process fence closes+zeroizes | TTL/heartbeat/wall-clock death、reopen old lease | closed cleanup |
| process restart | generic loader→O3a intermediate reconciliation→registry empty settlement；known incomplete complete result→S1 whole view | resume/recreate old handle/slot/lease/request fromreceipt；partial terminal view | observe/settle/recover |

## 12. Attempt-local StructuredOutput 与 tool协调

1. `structured`从`runLoop`外层变量移入`AttemptLocalState`。
2. `createStructuredOutputTool`只创建raw tool definition；最终插入tools map前必须调用`LegacyToolExecutionGate.wrapTool`。
3. StructuredOutput before hook raw invocation先durable；capture `onSuccess(args)`只在final plan committed后执行。
4. capture只写当前attempt state并记录callID；source attempt incomplete时即使tool settled，也不得直接设置source assistant success。
5. ordinary continuation/recovery child创建fresh state；旧capture不复制。
6. 只有当前attempt normal terminal且matching StructuredOutput call durable completed时，M6 runtime orchestration把该attempt的value写入该assistant并结束。
7. hook rewrite使args变化时，final plan revision和最终capture使用rewrite后值；raw值只作为prior revision evidence。
8. hook replacement/short-circuit若不产生合法StructuredOutput typed result，则当前attempt不能以structured success结束。

## 13. Rely–Guarantee 与并发/顺序合同

### 13.1 共享资源

- per-session `SessionRunState` submission operation registry/queue/ownership；M4 recovery/assistant/dispatch/aggregate heads；M6 policy row/runtime snapshot；M2 handle/runtime slots；M3 `AssistantRuntimeEvidence.byOrdinal`与tool map。

### 13.2 Rely

- M4 exact operations/full-fold readers obey owner contracts and S1 returnsnominal `DurableRecoveryAuthorityViewV1`；K7–K10 enforce live-generation lease lifecycle；O3a isappend-only/no-callback；Provider resolution pairs provenance；M7 proof/closure/candidate immutable；runner cancellation token never revalidates；while M2 canonical state is`authorized/held/not-delegated`, environment/finalizer does not cancel、release或steal latch and onlythe release owner may record delegated/unknown boundary；M8 never transparently resends indeterminate HTTP request absent public idempotency key。

### 13.3 Guarantee

- M2 ordinary path preservesF26 and one ordinary prepare；automatic reserves stable commitment beforeK7, consumes exact reservation inone actual prepare, thenrequires`complete result -> pre-release K8 -> F27/M2 authorized/open proof -> exclusive latch`；canonical state staysauthorized untildelegate boundary atomically recordsdelegated/unknown。Every automatic pre-release failure performsmechanical cancel/no-handle barrier→K9/zeroize→cleanup beforeA5/S2/lookup/replan；K9 failure fatal first；M3 each committed dispatch getsfresh ordinal state, two-fence tools, andrestart intermediate phases onlyO3a withcallbacks0；M5 consumesnominal view/slice and F23 only；M6 uses committed policy digestInput effectiveM, exact winner/A5/K7–K10 handling, no-reply/shell bypass, no successor before terminal/attach/settle；M8 public only。

### 13.4 Ordering constraints

```text
raw tool commit -> before hook -> final-plan commit -> body<=1
  -> body outcome commit -> after hook -> final settlement -> terminal classification

initial/ordinary M4 no-handle authority view -> M1.AdmissionPlan -> existing converter
  -> M2 prepare once -> same view bound to M2.PreparedUnreleasedHandleProofV1
  -> M4 commit complete result
terminal M1.DurableRecoverySnapshot is excluded from initial/ordinary/new-input no-source

generic M4 committed-assistant authority view (`nonterminal:true`) -> attach/resume/lost-handle settlement without S1
  -> lost-handle exact incomplete-terminal commit complete -> only then M4 S1 whole nominal `DurableRecoveryAuthorityViewV1`
known terminal incomplete path -> complete terminal result -> M4 S1 whole nominal view directly; generic loader is not called

restart latest tool planned/body-outcome/unknown -> one reconciliation allocation
  -> M4 O3a append reconciled-terminal-manual-only -> barrier may close
  -> body/after-hook/provider hits=0 -> automatic permanently forbidden

M4 S1 complete nominal authority view -> M5 selection
  -> exact automatic M4.AutomaticRecoveryProofSliceV1 only
  -> M7 target/provider-neutral M1 closure construction (no unseal/lowering)
  -> M2 stable no-send prepared-handle commitment reservation (not provider prepare)
  -> M4 K7 exact live leases before any unseal/lower/prepare
  -> M7 K3-backed replay reconstruction/unseal/lowering using same proof+closure+leases
  -> M2 exactly one paused provider preparation consuming same reservation
  -> original M2.M2InspectionResult -> M7 same-object validation
  -> M1.PlannedRecoveryMaterialization<M2.AvailableDispatchHandle>
  -> M5 final classification on same authority/proof/closure/reservation/leases
  -> M4 O8 commit with commit-time K8 -> complete result
  -> while handle is still prepared: M4 pre-release K8 validation
  -> F27 + M2 same handle/reservation authorize -> authorized/open release-callable proof
  -> acquire exclusive release latch; canonical state remains authorized/not-delegated through local pre-call
  -> exact delegate boundary atomically records released/delegated once
       or released/unknown-delivery terminal with resendAllowed=false
  -> K9 released/abandoned + zeroize -> cleanup
  -> only delegated branch creates empty attempt -> explicit ordinal0 allocation exactly once -> consume returned stream/events

initial/ordinary/subsequent -> ordinary M2 preparation exactly once -> M4 complete result
  -> F26 only -> create empty attempt/settlement -> release；no K7/M7 sealed recovery path
  -> exact ordinal drain/freeze -> fresh next context -> prepareSubsequentDispatch once
  -> type3 complete result -> F26 authorize -> explicit same-attempt next-ordinal allocation exactly once

model `source-superseded` complete-result proof -> user commit -> type-1 using exact current/type-10 post aggregate head
no-reply `source-superseded`/no-unresolved-source validation -> user commit only -> zero policy/M7/M2/type-1/model admission
shell serialized ownership -> existing shell owner -> zero recovery/model budget/preparation

policy row commit -> runtime visibility -> per-admission freeze
  -> M4 first-apply tx exact compare; exact replay bypasses current-policy revocation

collect M1 causes -> M1 F23 -> validate manual proposal
  -> if handle: mechanical cancel；if K7 leases: K9 close+zeroize
  -> resource cleanup before post-cancel work; retain only secret-free one-shot cancel tombstone if needed
  -> M2.NoPreparedHandleProofV1 or tombstone-backed M2.MechanicallyCancelledUnreleasedHandleProofV1
  -> exact M2 validator -> M4 ManualStop complete result -> final tombstone/reservation invalidation

automatic pre-release failure after K7
  -> mechanical cancel if handle exists, else atomic no-handle/reservation barrier
  -> K9 close + zeroize
  -> K9 failure: fatal before cleanup/A5/S2/lookup/replan
  -> K9 success: cleanup (optional secret-free ManualStop proof tombstone)
  -> only then A5/S2/lookup/classify/replan; tombstone invalidated after type-8 resolution

nonautomatic/non-dispatch response unknown -> lookup #1 -> optional same-ID resubmit once -> optional lookup #2
O8 CAS loser/response ambiguity -> cancel -> K9 -> cleanup -> A5 -> if missing S2; no same-handle resubmit

submission internal ID+digest acceptance -> serialized operation
  -> response detach on disconnect; no public transparent resend
```

## 14. 分布式接口七维合同

### 14.1 连接模型
- available gate只保证`auditedProviderTransportHitCount===0`直到release；automatic的reservation/K7/K3/lowering/prepare/O8/K8/F27全部pre-hit；WebSocket/custom opaque；restart不恢复handle/slot/connection/lease/unsealed request。

### 14.2 timeout/deadline
- 不新增通用deadline/watchdog。既有fixed DB busy retry与SessionRetry delay只按owner合同引用。provider/tool/model waits显式依赖terminal/error/AbortSignal/runner cancellation/process termination，不声称unconditional termination；delegate后timeout是send unknown。

### 14.3 retry/idempotency
- generic predicate唯一为`SessionRetry.policy` result；gated executors internal retry=0；accepted retry fresh operationID/ordinal/handle/ledger/settlement。
- M4 response loss只按§9.11 same operationID；public HTTP prompt/command没有stable idempotency contract，因此indeterminate disconnect不得透明resend。internal `SerializedSubmission.operationID`不能由新HTTP request安全重用。

### 14.4 delivery/order
- M4 raw transitions全序；local handle release at-most-once。Canonical handle在exclusive latch local pre-call阶段保持authorized/not-delegated；only exact delegate boundary CAS producesreleased/delegated。Boundary不可判定则terminal released/unknown-delivery且network outcome unknown，never cancel/resend；tool side effect前two durable fences；per-ordinal event不跨ordinal merge。

### 14.5 failure modes
- automatic commit closed discrimination见§9.9：CAS loser/response ambiguity先cancel→K9→cleanup，之后才A5/S2；policy stale只在same ordering后reload/replan；corruption/partial/owner mismatch/non-foldable/ambiguity一律fatal。K9 failure在任何cleanup/lookup前fatal。failed commit只有exact absence/no winner且fresh source binding仍valid时才可尝试独立ManualStop complete commit；failed persistence本身不是durable ManualStop。network omission/partition/slow response不证明unsent；boundary unknown固定released/unknown-delivery fatal。

### 14.6 state/session
- durable authority按session/chain/assistant/dispatch/decision；M4 sealed-use lease rows仅maintenance authority，runtime reservation/handle/K8 proof/ordinal settlement/submission waiter不可序列化。same-process attach要求exact identity/digest/live lease；cross-process只读authority并用O3a/K10 reconcile，不恢复old request。

### 14.7 backpressure
- provider stream沿用Effect Stream；terminal等待registered exact-ordinal tools；每轮one paused recovery handle；serialized queue按existing capacity/Busy contract，不发明新limit。

## 15. 端到端正确性论证

### 15.1 Initial/ordinary theorem
Initial/ordinary先使用M4 distinct staged authority view：initial直接绑定committed owner mapping、current aggregate head（fresh empty为C1/MIG1 genesis）、current policy、Legacy user、candidate与M2 no-handle proof；ordinary绑定自己的current heads/policy/committed predecessor/candidate；两者terminal recovery snapshot calls=0。随后existing converter→M2 once→same view的`M2.PreparedUnreleasedHandleProofV1`→M4。Type-1 is model-lineage genesis but its aggregate predecessor is exact current head；after model type-10 it is the exact type-10 post head，while assistant/ordinal0 ledger heads remain genesis。M4 atomically validates existing user predecessor and createsLegacy assistant+relation+ledger+heads。Nonautomatic complete result only经F26 authorize；然后先创建empty attempt，再对exact destination分配ordinal0一次，最后release。

### 15.2 Tool theorem
Raw receipt precedes before hook，final-plan receipt precedes the sole body call，body/final receipt precedes Deferred/terminal。Every tool is bound to exact provider ordinal or explicit preplanned-local domain；cross-ordinal events become inconsistency rather than merge。Restart never restores runtime callbacks: latest planned/body-outcome/unknown uses one O3a append to reconciled-terminal-manual-only, preserves only already-durable carriers, invokes body/after-hook/provider zero times, closes terminal barrier and permanently excludes automatic recovery。

### 15.3 Automatic recovery theorem
M5 reads the complete nominal M4 authority view and can select only its branded automatic proof slice: SafeRetry iff truly-empty; Continue iff authoritative-only and every proof final-after-hook-settled. compatibility/mixed/manual-only/reconciled/intermediate/unknown can never be structurally upgraded. M7 first builds the exact target-neutral M1 closure without unseal. M2 reserves one stable no-send target/gate/handle commitment without provider preparation. M4 K7 acquires all current-generation leases before M7 K3-backed reconstruction/unseal/lowering. M2 then performs exactly one paused provider preparation whose AI SDK slot/native gate/handle matches the reservation, produces the original inspection, and M7 validates the same object. M5 final-classifies on the same authority/proof/closure/reservation/lease set/planned wrapper. O8 first-apply consumes commit-time K8；complete result is followed immediately，while handle is still prepared，by pre-release K8；then F27/M2 same-object authorization constructs authorized/open proof。Exclusive latch retainscanonical authorized/not-delegated throughlocal validation；onlydelegate boundary atomically recordsreleased/delegated once，or terminalreleased/unknown-delivery。K9 close/zeroize precedescleanup and onlydelegated+K9 success admits child. Initial/ordinary/subsequent remain F26-only ordinary preparation paths. Every automatic pre-release failure performsmechanical cancel/no-handle barrier→K9→cleanup beforeA5/S2/lookup/replan；K9 failure isfatal beforerelation loss；dead process usesK10 only。Never TTL/reopen/recreate。Corrupt/partial/ambiguous authority is fatal；post-failed-commit ManualStop additionally requirespost-cleanup tombstone-backed cancel proof、A5 absence、S2 unchanged、fresh same binding、pre-existing cause、K9 closure and its own complete type-8 result。

### 15.4 Retry theorem
Retry occurs iff existing`SessionRetry.policy` accepts and canonical incomplete is excluded. Prior ordinal drains/closes before one fresh next context and one `prepareSubsequentDispatch`；type3 commit/F26 authorization precede the sole explicit next-settlement allocation，which precedes release；therefore ordinal i settlement cannot satisfy ordinal i+1 and no helper can double-advance current ordinal。Dispatch missing、opaque、gap/conflict、multiple plausible remain distinct M5 branches；only exact causes then flow throughF23。Wait termination remains conditional ontimer/abort/cancellation/provider terminal，not unconditional。

### 15.5 Crash/response theorem
M4 response loss returns complete results using at most two aggregate-scoped exact lookups and one same-ID resubmission；partial/corrupt is never accepted。Automatic O8 pre-release ambiguity is stricter：cancel→K9→cleanup happens beforeA5/S2 and neverresubmits/releases same handle。Every nonterminal committed assistant re-enters throughgeneric `nonterminal:true` view；restart first O3a-reconciles intermediate tools, then attaches/settles, never recreates handle/slot/lease/request. Same-process never-released automatic handle may resume release only ifstillprepared withsame live leases/reservation，thenfresh prepared-only K8→F27/M2 authorize→immediate boundary；automatic authorized/open found outsideoriginal contiguous scope iscancelled/K9/settled known-no-send，not released。Authorized/held belongs exclusively tolive release owner。Lost held owner or boundary uncertainty becomesreleased/unknown-delivery andfatal，never rollback/cancel/resend。Dead-process leases close only throughK10 exclusive liveness fence, neverTTL. Known incomplete usescomplete terminal result thenS1 whole nominal view；generic view andS1 remain mutually exclusive。Two-stage O10, no-reply, shell bypass, historical result and successor barriers remain unchanged。

## 16. Future test mapping

以下全部为 `[F — planned; not created; not run]`：

### 16.1 M2 gate
- `[F — planned; not created; not run]` SDK/language+provenance same generation；dynamic/custom/unknown opaque。
- `[F — planned; not created; not run]` Anthropic/OpenAI final-fetch pause hit0 until exact receipt；native compile once/release same object。
- `[F — planned; not created; not run]` exact M2 proof/reservation exports：no-handle registry generation；`PreparedHandleCommitmentReservationV1` stable no-send creation/validation/single-consume/close；reserved target/gate/generation/commitment matches actual AI SDK slot/native compilation/handle；stale/double-consume/replacement/TTL/reopen rejected；prepared/cancelled/release-callable/delegated/unknown-delivery proof validators/constructors；secret-free one-shot ManualStop tombstone；M4 structural copies absent。
- `[F — planned; not created; not run]` exact automatic order asserted by counters: M4 nominal slice→M7 no-unseal closure→M2 reservation(provider preparation0)→K7→M7 K3 reconstruction/lowering→M2 actual prepare exactly1→original inspection→M7 same-object validation→M5 final→O8 commit-K8 complete result→pre-release K8 whileprepared→F27/M2 authorized/open proof→exclusive latch stillauthorized/not-delegated→delegate boundary released/delegated1→K9；provider hit0 untilboundary；available exact wrapper/unavailable nohandle；no secondprepare/inspection/slot/compile。
- `[F — planned; not created; not run]` K7 key set same snapshot/closure/source/action/operation/candidate/target/positive generation/handle commitment；zero-ref exact empty；K8 commit/release missing-extra-closed-stale mismatch；K9 released/cancelled/abandoned/lost-handle branches zeroize M2/M4 bytes；K10 exclusive process fence；no TTL/old handle recreation。
- `[F — planned; not created; not run]` second fetch first-paused/first-delegated branches fail before second downstream and never rotate slot。
- `[F — planned; not created; not run]` nonautomatic authorize usesF26 only、automatic F27 only；authorize constructsopen callable proof。Release state matrix mechanically asserts：local validation/synchronous pre-call failure keepsauthorized/held then exits toauthorized/open→cancelled；delegated boundary alone transitionsauthorized/held→released/delegated；boundary uncertainty transitions→released/unknown-delivery and returnsfatal；held-state concurrent cancel/release rejected；latch/delegate/terminal/K9 counters≤1。Attempt created empty before ordinal0；explicit exact destination/current transition allocates ordinal0 exactly once and each subsequent exactly once；prepare/record/authorize do not mutate settlement；detached valid receipt rejected。

### 16.2 M3 tool/terminal
- `[F — planned; not created; not run]` all tool families/preplanned local use raw fence→hook→plan fence→body0/1→outcome→settlement。
- `[F — planned; not created; not run]` begin/plan/body-outcome/final commit first/replay/conflict/partial/persistence branches; body never reruns。
- `[F — planned; not created; not run]` exact drain trigger matrix for retry/eof/incomplete/interrupt/transport/reentry, including abort cancellation and durable failure。
- `[F — planned; not created; not run]` ordinal0 settledStep=true cannot satisfy ordinal1 clean-EOF/incomplete; ordinal1 uses fresh false object and classifies fromordinal1 only。
- `[F — planned; not created; not run]` late ordinal0 event duringordinal1 creates`dispatch/ledger-conflict` cause and never mutatesordinal1。
- `[F — planned; not created; not run]` existing evidence drain predicate: absent/exact/mismatched three branches; exact is mandatory drain, mismatch fatal。
- `[F — planned; not created; not run]` R23/O3a phase matrix：planned、body-outcome-durable、unknown-intermediate各append reconciled-terminal-manual-only exactly once；body/after-hook/provider counters0；body-outcome carrier/commitments preserved，others invent none；final/reconciled no-op；response loss A5、competing winner、cancel-before/after allocation、process restart、corrupt/ambiguous fatal；O6 barrier closes andM5 automatic remains unreachable。

### 16.3 M5 classifier
- `[F — planned; not created; not run]` M5 input must beM4 `DurableRecoveryAuthorityViewV1`; plain M1 snapshot/structural slice rejected；SafeRetry only nominal truly-empty complete slice；Continue only nominal authoritative-only all-final slice boundsame identity；compatibility-only/mixed/manual-only/planned/body-outcome/reconciled/unknown/nonfinal manual/fatal；dispatch four branches independent；selection preserves exact branded slice。
- `[F — planned; not created; not run]` each 24 exact cause leaf throughM1 F23; dedup/order/empty/malformed tests live againstF23, no local ordering helper。
- `[F — planned; not created; not run]` causal suppression and input-order determinism；M5 never callsM7 privileged inspector。

### 16.4 N/M/policy/admission
- `[F — planned; not created; not run]` M6 full-raw decoder calls M1 external codec+F13 and returns exact `M1.NormalizedRecoveryPolicy`；N=0/1/2，M=1/2，defaultsN2/M64/effective `agent.steps`；invalid config rejected；publisher has no separate `agentSteps` input。
- `[F — planned; not created; not run]` policy changes between twoordinary admissions: second freezes new epoch/digest; old candidate first-apply stale/cancel/replan; no stale-chain continuation。
- `[F — planned; not created; not run]` policy changes after exact committed receipt: replay/authorize existing same handle remains valid; next uncommitted admission usesnew policy。
- `[F — planned; not created; not run]` operations1/2/9 first apply compare current quartet，take `effectiveM` only from tx-verified committed `NormalizedRecoveryPolicy.digestInput.effectiveMaxModelAssistants` and combine same-tx fold for M（automatic also N）；configured/runtime/caller re-min prohibited；exact replay does not read current policy。
- `[F — planned; not created; not run]` type-1 fresh empty/nonempty/post-type10 exact-head matrix；initial M4 view binds committed owner/current policy/Legacy user/candidate/no-handle→prepared proof且recovery snapshot calls=0；ordinary distinct M4 view and snapshot calls=0；wrong owner/policy/user/candidate/reservation/head/proof rejected；assistant/ledger genesis；existing user not recreated；Legacy assistant composite all-or-none；F26 authorization后create empty attempt，再explicit ordinal0 allocation exactly once。

### 16.5 Retry/ManualStop/automatic/crash
- `[F — planned; not created; not run]` table drives existing`SessionRetry.policy` result; covered429/503 preserved; canonical incomplete excluded; no document-owned5xx/text predicate。
- `[F — planned; not created; not run]` every accepted retry gets generic view→close→fresh context/operationID→one`prepareSubsequentDispatch` handle/proof→type3/F26→one explicit next-settlement allocation；wait interrupt/status write failure/ownership loss/prepare/commit/allocation failure produce no nextsend。
- `[F — planned; not created; not run]` automatic global/S4 order exact counters：S1 nominal view→M5 selected slice→M7 closure→M2 reservation→K7→M7 reconstruct/lower→M2 one prepare/inspection→M7 validate→M5→O8 commit-K8 complete result→pre-release K8 whileprepared→F27/M2 authorized/open→exclusive latch→delegate-boundary released/delegated→K9；SafeRetry mapping/identity exits；wrong predecessor/ledger rejected；corrupt/partial/ambiguous fatal；initial/ordinary F26/no-K7 regression。
- `[F — planned; not created; not run]` failure-order table drives prepare/inspection/M7/M5/O8-CAS-loser/O8-response-ambiguity/pre-release-K8/F27/authorization/local-pre-call branches；all automatic paths assertmechanical cancel or no-handle barrier→K9→cleanup beforelookup/replan，O8 branches assertA5/S2 counters0 untilK9+cleanup complete；pre-release K8 failure assertsF27/auth/latch/release/delegate counters0；K9 failure assertscleanup/A5/S2/S1/replan counters0。
- `[F — planned; not created; not run]` failed automatic commit permitsManualStop only aftercancel/no-handle barrier→K9→resource cleanup withsecret-free tombstone→exact absence/no winner+valid source binding→separate complete type-8 result→tombstone invalidation；corruption neverManualStop。
- `[F — planned; not created; not run]` ManualStop exact order causes→total F23→branch-exact manual `BindingDigestInputV1`/F22→no-handle or tombstone-backed cancel proof→M4 separate proof validation/commit→final tombstone invalidation；forbidden automatic target/prepared fields rejected；no child/consumption。
- `[F — planned; not created; not run]` §9.11 uses exact aggregate-scoped `RecoveryOperationLookupKeyV1<T>`；same operationID across aggregate/type never matches；first lookup exact/missing/conflict/partial, one same-scope same-ID resubmit, final second lookup；maximum2+1 mechanically asserted。
- `[F — planned; not created; not run]` generic nonterminal reentry for exact type1/type2/type9 selectors consumes`M4.CommittedAssistantAuthorityViewV1<K>(nonterminal:true)`；terminal/closed loader rejection不构造partial view；lost-handle exact drain→complete incomplete terminal→S1；restart noresume；successor barrier。

### 16.6 Entry points/attempt local
- `[F — planned; not created; not run]` stable internal submission ID+digest: missing enqueue, same exact attach/cache, same ID different digest conflict, result belongs to caller。
- `[F — planned; not created; not run]` model/noReply O10 two-stage gate：`submitSerialized`在inspect前的model candidate exact只有`sessionID+submissionPayloadDigest+intendedInitialOperationID`，no-reply exact只有`sessionID+submissionPayloadDigest+replyDisposition:"commit-user-only"`；pre-inspection M4 read只返回O10 inspect current aggregate head，candidate/coordinator source/control versions、recovery predecessor、`SupersessionBindingDigestInputV1`、digest与完整type-10 input construction counters均为0；inspect unresolved只返回branded `SupersessionRequiredAuthorityV1`；M6据该authority构造exact branch input+`supersession-binding-v1` digest与完整type-10 input，再以`complete-expected-input`重入O10，direct O9 prohibited；fresh empty/no-unresolved branch terminal snapshot calls=0；old recovery finalized before user commit；noReply zero policy/model-candidate/M5/M7/M2/handle/`commitCompositeAdmissionDispatch`/assistant/ledger/M/authorize。
- `[F — planned; not created; not run]` indeterminate HTTP disconnect detaches waiter and does not transparently resend without public idempotency key; hydration only。
- `[F — planned; not created; not run]` prompt_async one fork/204/full background chain；M8 ownspublic signals。
- `[F — planned; not created; not run]` StructuredOutput fresh each assistant；shell serialized but zero policy/M7/M2/N/M/recovery admission and no recovery source。

## 17. 实施顺序

future实施顺序固定且不得互换。本文只列设计与Step 0输入，不声明任何检查、实现或测试状态。

1. Step 0 owner/export checklist：冻结M1 actual `*V1` exports/F23/F24/F26/F27、`NormalizedRecoveryPolicy.digestInput.effectiveMaxModelAssistants`与nested planned materialization；冻结M4 `DurableRecoveryAuthorityViewV1`、`AutomaticRecoveryProofSliceV1`、S1/O3a/O8/A5/S2/K7–K10/generic reentry exact signatures；冻结M7 closure/lowering/validation seam。任何缺口阻断implementation，不以local alias绕过。
2. Step 0 mechanical call-order checklist：为automatic写stage markers/counters，逐项覆盖S1→M5→M7 closure→M2 reservation→K7→M7 reconstruction/lowering→M2 prepare once→inspection→M7 validation→M5→O8 commit-K8 complete result→pre-release K8 whileprepared→F27/M2 authorized/open proof→exclusive latch stillauthorized/not-delegated→delegate-boundary released→K9；另锁定所有pre-release failure的cancel/no-handle barrier→K9→cleanup→post-work及O8 A5/S2 stale-order；为initial/ordinary/subsequent锁定F26/no-K7/no-duplicate-prepare。
3. M6 policy publish/read/tx-read与per-admission freeze；operations1/2/9只读取committed `digestInput.effectiveMaxModelAssistants`，exact replay不读current policy。
4. R24 M2 reservation exact type/registry/validators；canonical handle/release-latch state、release-callable/delegated/unknown proof与ManualStop tombstone；M4 K7–K10 integration；AI SDK/native exact reservation match、one actual prepare、all failure/cancel/abandon/lost/response-loss K9-before-cleanup zeroize。
5. R23 M3 restart scan/one-shot allocation/O3a append-only reconciliation；all phase/reentry/error/cancel branches；O6 barrier andpermanent manual-only。
6. M3 ordinary explicit ordinal allocator、two-fence tools、exact drain/terminal/response branches。
7. M5 nominal authority-view selector/final classifier and M1 F23 only；plain snapshot/structural proof compile/runtime rejection。
8. M6 initial/ordinary/automatic/ManualStop closed discrimination、generic reentry/existing-evidence drain、serialized submission identity；先实现exact pre-inspection candidate与O10 inspect-only aggregate-head handoff，再实现仅由branded `M4.SupersessionRequiredAuthorityV1`触发的完整type-10 binding/input construction及O10 complete re-entry；M8 sibling boundary保持。
9. Future tests按§16创建时覆盖state-transition、cancel-K9-cleanup-A5/S2、stale-order、GFM/code-fence/table/whitespace、stale-name、exact-owner/import与call-order scans；本文阶段不创建或运行tests/audit/devlog。

## 18. 细化完整性自检

- M5只收集/分类M1 `RecoveryFailureCause`；dispatch missing、opaque、gap/conflict、multiple plausible四分独立；M1 F23是唯一mapping/dedup/fallback/order authority；24 reasons仅索引。
- Automatic exact sequence已冻结：M4 nominal view/slice→M7 no-unseal M1 closure→M2 stable no-send reservation→K7→M7 lease-bound reconstruction/lowering→M2 one actual paused preparation→original inspection→M7 same-object validation→M5 final→O8 commit-K8 complete result→pre-release K8 whileprepared→F27/M2 authorized/open proof→exclusive latch保持authorized/not-delegated→delegate-boundary released/delegated or unknown terminal→K9/zeroize→cleanup。SafeRetry only truly-empty，Continue only authoritative-only all-final；plain snapshot/structural proof/manual-only不可进入M7。
- Type owner index包含M2 `PreparedHandleCommitmentReservationV1`、release-callable/delegated/unknown-delivery proofs、`ReleasedUnknownDelivery`与secret-free ManualStop tombstone behavior、M3 restart reconciliation types、M4 nominal view/slice/lease/release-proof exact names；无local M1/M4 structural duplicates。Reservation/handle proofs/leases各自owner/lifecycle/validator明确；detached result/receipt/lease proof不授权。
- stale planning-request、dispatch-controller与combined prepare-record-settlement contracts已删除；reservation、K7–K10与named preparation helpers无caller cycle。R23 `reconcileInterruptedToolExecutionOnRestart`覆盖five phase switch、one-time allocation、A5 response loss、competing winner、cancel/process-loss，且callbacks/hits=0。
- 本次触及的nontrivial callable均列exact signature、callers/callees pre/post、Requires、连续编号步骤、branches/exits/residue、Ensures、side effects、loop/wait progress与structured proof。
- generic retry唯一谓词为现有`SessionRetry.policy` result；covered429/503保持；canonical incomplete排除；每次accepted retry按generic nonterminal view→close→fresh context/operationID→one preparation/proof→type3/F26→one explicit settlement allocation→release。
- Automatic commit对success/CAS winner/policy-head-generation stale/corruption/partial/result mismatch/K8 failure/release failure/response ambiguity给出closed owner/action；all pre-release failure exits mechanical cancel/no-handle barrier→K9 close/zeroize→cleanup→A5/S2/lookup/replan as applicable；O8 loser/ambiguity在K9+cleanup前A5/S2 counters=0；K9 failure在cleanup/lookup前fatal；failed persistence不冒充ManualStop。
- existing evidence drain predicate三分支exact且无optional drain；tool/retry/provider waits不新增timeout或无条件termination claim。
- response loss统一引用§9.11并限制最多2 lookup + 1 same-operationID resubmit。
- attempt先创建empty state；§7.0.1签名显式接收exact destination map/current/expected transition；ordinal0与每个subsequent各exactly once；prepare/commit/authorize不隐式推进；assistant-wide summary分离、cross-ordinal inconsistency与ordinal0不能满足ordinal1 test已定义。
- M6 decoder exact调用M1 external codec+F13并返回`M1.NormalizedRecoveryPolicy`，publisher无separate agentSteps；每个uncommitted initial/ordinary/automatic admission冻结current committed policy；initial/fresh使用M4 owner/current-head/user/candidate staged view，ordinary使用distinct staged view，二者recovery snapshot calls=0；automatic只使用M4 S1返回的whole terminal `M4.DurableRecoveryAuthorityViewV1`及其same-view branded slice，不直接消费plain snapshot；M4 first apply recheck；exact existing receipt不撤销；无stale-chain ordinary例外。
- `SerializedSubmission`有internal stable operationID+digest；M8无public idempotency时禁止indeterminate disconnect透明HTTP resend。`submitSerialized`在O10 inspect前只构造exact branch candidate并只读取current aggregate head，source/control versions、recovery predecessor、supersession binding input/digest与完整type-10 input均不存在于candidate/coordinator state；unresolved只返回branded `M4.SupersessionRequiredAuthorityV1`，§9.13据其构造完整type-10 input后仅以`complete-expected-input`重入O10，never direct O9。
- M4 errors原样保持kind-indexed `kind/reason/context` correlation；N/M normalization only once；all runtime/first-apply M reads only tx-verified committed `M1.NormalizedRecoveryPolicy.digestInput.effectiveMaxModelAssistants`，无config/agent.steps reread/re-min。
- M4 generic committed-assistant view/loader exact按`K` signature且只服务`nonterminal:true`；restart intermediate tools先O3a；reentry/lost-handle签名排除terminal view；complete incomplete-terminal commit后才调用S1 whole nominal view。M6 internal/M8 public ownership、aggregate-scoped A5、two-stage O10、noReply、shell bypass、F26/F27 split、tool durable-before-execute、N=2/M=64与evidence tags保留。
- 最终机械scan逐项检查state-transition、cancel-K9-cleanup-A5/S2 stale-order、M1/M2/M4/M7 owner-qualified exports/signatures、GFM fences/tables/whitespace与stale names；automatic seam必须精确携M4 view/slice、M1 closure/lease key、M2 reservation、K7–K10、unique `prepareDispatch(...) -> M1.PlannedRecoveryMaterialization<M2.AvailableDispatchHandle>`、original inspection、same-object validator、release callable proof与boundary-only released transition；不得local alias/brand/caller target/old handle绕过。
- future tests统一标记`[F — planned; not created; not run]`，本文证据仍是设计级，不冒充运行结果。
