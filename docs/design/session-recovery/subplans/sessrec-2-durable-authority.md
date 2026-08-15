# 细化设计 — Session Recovery / sessrec-2-durable-authority

> 状态：M4 持久化权威函数级详细设计；当前为fresh independent design audit已达到`0 P0 / 0 P1`的 **revised-design candidate**，尚未获得本轮user approval，workflow Step 0尚未开始。本文只细化当前架构基线，不改变 M1/M2/M6/M7/M8 的 owner 边界。
>
> 设计基线：本地 design HEAD `bc7811088db9cf6d856e656cc3c694ca8e7a3517`。
>
> 证据边界：见 §1.3。本文没有运行测试、没有读取 upstream、没有读取敏感历史，也不声称 future M4 实现已经存在。

## 1. 范围、证据与冻结主链

### 1.1 M4 负责

M4 把 session recovery 的 durable truth 固定为：

1. `EventTable` 中 canonical raw operation envelope 是唯一事实权威；
2. relation、dispatch ledger、tool、reasoning、decision、consumption、M1 safe public projection 共 **七个** materialization 只能由 raw fold 导出；
3. `recovery_head`、`assistant_chain_head`、`dispatch_ledger_head` 共 **三个** recovery head 只作并发前置条件与快速一致性检查；M1 `AdmissionPlan["expectedHeads"]["aggregateEventHead"]` 是 raw sequence/hash cursor，不计入三个 recovery head；
4. sealed store 只保存恢复执行必须使用的敏感材料；raw、receipt、materialization、head、日志和 public projection 只保存不敏感结构或 keyed commitment；
5. initial/ordinary admission-dispatch、subsequent dispatch、四类 source fact、ManualStop、automatic child、new-input supersession、receipt lookup、snapshot、rebuild、sealed rotate/redact 都通过本文定义的唯一 authority path；
6. 每个新session在SessionOwner同一创建transaction内原子建立fresh dedicated recovery/sealed aggregate pair、两个empty cursors与owner map；existing session只由MIG1建立等价fresh pair。二者都与legacy/public session aggregate分离。

M4 提供以下 public-to-sibling internal service functions：

- `createSessionRecoveryAggregateOwner`（仅作为SessionOwner parent transaction helper）；
- `commitCompositeAdmissionDispatch`；
- `commitSubsequentDispatch`；
- `commitToolEvidence` / `reconcileInterruptedToolExecution`；
- `commitReasoningEvidence`；
- `commitProviderPrefix`；
- `commitIncompleteTerminal`；
- `commitManualStop`；
- `commitAutomaticChild`；
- `commitNewInputSupersession`；
- `commitAndValidateSupersessionBeforePrepare`；
- `lookupRecoveryOperationResult`；
- `loadInitialAdmissionAuthorityView` / `bindPreparedInitialAdmissionAuthorityView`；
- `loadOrdinaryAdmissionAuthorityView` / `bindPreparedOrdinaryAdmissionAuthorityView`；
- `loadCommittedAssistantAuthorityView`（nonterminal initial/ordinary/automatic reentry only）；
- `buildRecoveryAssistantPublicMappingInTransaction`；
- `loadRecoverySnapshot`（terminal incomplete source only；返回M4 nominal authority view）；
- `rebuildRecoveryAggregate`；
- sealed prepare/open/rotate/redact、`acquire/validate/close/cleanup` sealed-use lease 与 session cascade support。

### 1.2 M4 不负责

- M1 唯一拥有 identity、target/domain/storage、digest、operation envelope、exact receipt、N/M policy、safe projection schema 与 source/control event sets。
- M2 唯一拥有 runtime handle、exact one-time paused preparation、mechanical cancel、authorize 与 release。
- M6 唯一拥有 serialized submission、runner ownership、supersession/new-lineage orchestration 与 policy-authority publication。
- M7 唯一拥有 action-specific semantic/pre-prepare candidate、history lowering、Continue closure 与 provider-specific semantic constraints。
- M8 只消费 M1 safe projection；不得读取 raw、receipt、head、sealed ref 或 snapshot，也不得另造结构等价 projection schema。
- M4 不从 legacy message/part/session_input/public projection 推断 recovery eligibility。
- M4 不承诺 provider/network exactly-once，不持久化 runtime handle，不执行 provider/tool callback。

### 1.3 证据标签与边界

| 标签 | 本文允许的含义 |
|---|---|
| `[S — source seam only]` | 只说明本地 source-equivalent tree 中存在可复用 seam 或当前限制；不是运行证明，也不证明 future recovery contract。source-equivalent evidence HEAD 固定为 `135f2021517a2d4ac6f3dfc8d5e175dd2c0da309`。 |
| `[F — planned; not created; not run]` | future schema、function、migration、test 或 proof obligation；未创建、未运行。 |
| `No upstream` | 本轮未读取、比较或推断任何 upstream branch、remote commit 或敏感历史。 |

本文所有 §2 的现有代码描述仅为 `[S — source seam only]`。所有新增类型、表、函数、迁移和 §12 测试均为 `[F — planned; not created; not run]`。design HEAD 与 source-equivalent evidence HEAD 仅用于标识设计/source 观察基线，二者不得被写成实现完成证据。

本文“durable/commit后恢复”定理的故障模型只覆盖：SQLite向caller确认commit后发生的process crash/restart，以及SQLite/WAL在当前平台与配置明确保证的committed-state恢复；不声称在host power loss、kernel/storage-controller lie、filesystem corruption、lost fsync或介质损坏后仍保留最后commit。首个实现若要把定理扩大到这些故障，startup必须设置并read-back验证`PRAGMA synchronous=FULL`（或平台上有书面等价保证的更强模式）、完成power-cut fault campaign并提升本节证据；仅观察到WAL或`NORMAL`不得外推。当前`[S — source seam only]`只说明WAL/foreign-key/busy seam，不证明FULL durability。

### 1.4 冻结的唯一 handoff

各dispatch origin的preparation owner不同，但都只能用complete result授权：

```text
initial/ordinary:
  existing ordinary converter
    -> M2 exact one-time paused preparation
    -> M4 composite raw authority commit

subsequent:
  M2 fresh next-ordinal preparation
    -> M4 subsequent-dispatch raw authority commit

automatic:
  M5 candidate selection from M4.DurableRecoveryAuthorityViewV1
    -> selected M4 snapshot-bound nominal proof slice
    -> M7 constructs the target-neutral M1 RecoveryClosureDescriptor from that slice only, with no unseal/lowering
    -> M2 stable no-send prepared-handle commitment reservation
    -> M4 K7 acquires exact snapshot/closure-bound sealed-use leases before any unseal/lowering/preparation
    -> M7 automatic semantic lowering using only the same proof slice + closure + live leases
    -> M2 exact one-time paused preparation/original inspection
    -> M7.validatePreparedRecoveryInspection({ candidate, inspection })
    -> M5 final classification
    -> M4 automatic composite raw authority commit with K8 live-lease validation

all dispatch-authorizing commits:
  provider/audited transport hits remain 0 before authorization
  M4 atomically commits pending seals + raw envelope
    + materializations + relevant heads
  M4 returns complete M1.OperationCommitResultV1<T>

nonautomatic only (F26 unchanged):
  M2 passes result.receipt + result.operationPostState to F26
  M2 performs exact same-handle authorization and releases that handle exactly once

automatic only:
  M4 returns complete M1.OperationCommitResultV1<"automatic-child-admitted-and-consumed">
  the same handle remains prepared/unreleased/hit=0
  M2 immediately calls M4 pre-release K8 validation for the same live leases and handle
  K8 success only -> M2 passes the complete result + result.operationPostState to F27
    -> M2 exact same-handle authorization -> release exactly once -> K9 released close/zeroize
  K8 failure -> M2 mechanically cancels the still-prepared handle
    -> F27 calls=0; M2 authorization calls=0; release calls=0
    -> K9 mechanically-cancelled/abandoned close -> zeroize
```

禁止以下逆序或替代：

1. **禁止 receipt-before-prepare**：没有 already-prepared unreleased handle commitment 时，M4 dispatch commit 的 available/opaque/automatic 分支都不合法；
2. **禁止 prepare-after-receipt**：receipt 不能授权 caller 在 commit 后重新 lower、重新 compile、重新生成 handle；
3. **禁止 double preparation**：M7 candidate 只能交给 M2 一次 exact preparation；retry 只能复用同一仍存活 handle 或 fail closed，不能用同 operationID 生成第二 handle；
4. **禁止 proposal authority**：M5/M6 proposal、M7 candidate、M2 prepared package 都不是 durable authority；
5. **禁止 handle substitution / detached-receipt authorization**：nonautomatic沿既有F26合同消费完整`OperationCommitResultV1<T>`并验证`result.receipt + result.operationPostState`及same runtime handle；automatic必须先取得complete type-9 result，在同一handle仍prepared时立即通过pre-release K8，成功后才把complete result + `result.operationPostState`交F27并由M2执行exact same-handle authorization；receipt单独匹配不得release；
6. **禁止 automatic F27-before-K8**：pre-release K8 success happens-before任何F27、M2 authorization或release调用。K8 failure固定把prepared handle mechanical cancel，F27/M2 authorization/release调用数均为0，再K9 close并zeroize；
7. **禁止 zero-hit 扩大**：本文的 zero-hit 只指 audited provider transport delegate/fetch/frame 尚未发生，不声称系统零本地 I/O。

### 1.5 Supersession-before-new-authority

model 与 no-reply submission 共享 old-recovery winner gate，但后续 branch 不同：

```text
new input exists only as an unprepared, non-authoritative candidate
  -> model/no-reply inspection first obtains exact source/control/predecessor facts
  -> caller builds M1 SupersessionBindingDigestInputV1 + SupersessionBindingDigest
       common binds sessionID + source/control versions/digests
       + submissionPayloadDigest + exact type-10 predecessors
       model additionally binds intendedInitialOperationID
       no-reply additionally binds replyDisposition:"commit-user-only"
  -> O10 inspect returns no-source outcome, automatic winner, or exact
       supersession-required source/control/predecessor authority
  -> required only: caller constructs complete type-10 input, then O10 validates/commits
       model: stores reservedInitialOperationID + full model supersessionBindingInput/digest
       no-reply: stores full no-reply supersessionBindingInput/digest and no type-1 reservation fields
  -> A5 validates the complete type-10 OperationCommitResultV1
       automatic winner -> S2/S1 reload/steer; no new authority yet
       corrupt/partial/owner-mismatched/non-foldable/ambiguous authority -> fatal
  -> model only: O10 returns matching SupersessionBeforePrepareProofV1
       existing ordinary converter -> M2 one-time preparation -> O1 type-1
       type-1 aggregate predecessor = exact type-10 post AdmissionPlan["expectedHeads"]["aggregateEventHead"]
       type-1 assistant-chain and child ordinal-0 ledger predecessors remain genesis/absent
       O1/A3 validate the reservation separately from the complete post-prepare type-1 payload digest
  -> no-reply only: after exact supersession result, commit the user input and return user-only
       no policy freeze, M7, M2, type-1, model assistant, dispatch ledger, or M consumption
```

O10 是 M4 唯一 persistence/validation gate。inspection本身不commit：发现unresolved source时必须返回branded `supersession-required` exact source/control/predecessor authority，caller据此补齐完整type-10 input后再由O10 complete-input branch commit；不存在“inspection只拿到head/source ID却直接走O9”的partial branch。type-10两branch都必须持久化完整M1 `SupersessionBindingDigestInputV1`及`SupersessionBindingDigest`，包括`submissionPayloadDigest`与same source/control/predecessor facts；只保存digest/operationID而遗漏full input非法。model binding另含intended type-1 operationID，其digest不是 future `OperationPayloadDigest`，因为 target、assistant、policy、dispatch 与 prepared facts尚不存在；later type-1完整payload仍由A1独立canonicalize，并以`NewLineageReservationRefV1.reservationDigest`引用该model `SupersessionBindingDigest`。no-reply binding固定`replyDisposition:"commit-user-only"`且不能携带intended type-1 operationID/ref，也不能产生可供O1使用的proof。若 automatic 先赢，M6 follow/steer 后重新评估 serialized submission，绝不 fork；若 type-10 已 commit 但 later model preparation/O1 失败，old source 保持 superseded，只能复用同一 intended operationID/reservation 重试或 fatal stop，不能复活 old proposal。pre-existing Legacy user message 只在 user commit 后成为 type-1 validated predecessor；O1 不得重复创建 user row。

## 2. `[S — source seam only]` 复用 seam 与当前限制

以下全部为 `[S — source seam only]`：

- `packages/core/src/event.ts` 的 durable commit 已使用 SQLite immediate transaction，并把 projector 放在 raw commit transaction 内；M4 复用 transaction/service，不开放 generic caller-composed multi-head hook。
- `packages/core/src/database/database.ts` 配置 WAL、foreign keys 与 busy timeout；M4 仍显式使用 `BEGIN IMMEDIATE` 写事务。
- Exactly-one affected-row proof必须使用`RETURNING` materialized rows并检查`rows.length === 1`（例如`returning().all()`）；`.run()`、driver `changes`猜测或只调用`.get()`而不排除多row都不能证明first apply。对schema上已证明最多一row的PK/UNIQUE语句，`.get()`仍须由adapter规范化为0/1 array并执行同一length assertion。
- `EventV2Bridge`、public listeners、SSE 与 sync 当前是泄漏 seam；source-level publication 与 private/public interface split 必须同时实施，不能只加 bridge guard。
- `CredentialTable`、`Auth`、JSON `Storage`、`ToolOutputStore` 都不是 recovery sealed authority；M4 不把 KEK、DEK 或 plaintext 写入这些 store。
- process-injected keyring 是首个 key provider：active version 来自 `OPENCODE_RECOVERY_SEAL_ACTIVE_KEY_VERSION`，32-byte base64 KEK 来自 `OPENCODE_RECOVERY_SEAL_KEY_<v>`；缺失/非法配置 typed fail closed。

## 3. Owner links、共享类型与固定不变量

### 3.1 Owner-qualified exports 与 M4-private signature types

本文签名只引用owner实际export。M1 exact names固定为`M1.RecoveryOperationType`、`M1.RecoveryOperationLookupKeyV1<T>`、`M1.RecoveryOperationInputV1<T>`、`M1.RecoveryOperationEnvelope<T>`、`Extract<M1.RecoveryEventRegistryV1["definitions"][number], { operationType: T }>`、`M1.OperationSchemaByTypeV1`、`M1.ReceiptForV1<T>`、`M1.AuthorityReceiptV1`、`M1.OperationPostStateForV1<T>`、`M1.OperationCommitResultV1<T>`、`M1.SupersessionBindingDigestInputV1`、`M1.SupersessionBindingDigest`、`M1.M4RecoveryAggregateOwnerMappingProofV1`、`M1.M4SealedRecoveryMaterialLookupProofV1`、`M1.DurableRecoverySnapshot`、`M1.RecoveryPublicProjectionV1`、`M1.EventManifestSet`与其余在SESSREC-1实际定义的owner-qualified names；名称本身未带`V1`时不得在M4擅自加后缀，带`V1`时不得省略。M2只使用`M2.PreparedCommitPackageV1`、`M2.PreparedHandleLeaseIDV1`、`M2.PreparedUnreleasedHandleProofV1`、`M2.NoPreparedHandleProofV1`、`M2.MechanicallyCancelledUnreleasedHandleProofV1`以及exact `validate*ProofV1` exports；M6只使用`M6.UnpreparedNonAuthoritativeNewInputCandidate`与policy owner types。Session owner types直接引用其owner export。M4不声明任何M1/M2 receipt、definition、prepared-package、handle proof/lease、operation input/post-state、snapshot或public projection的alias、Pick/Omit重组、structural duplicate或编号占位type。

`M6.UnpreparedNonAuthoritativeNewInputCandidate`的type invariant由M6 owner contract保证：未调用M7 lowering、未调用M2 prepare、没有runtime handle/paused commitment、没有raw/public/message/assistant/dispatch authority；M4 O10只用M6 exported validator消费它，不复制fields。函数签名中inline的readonly input object只属于该函数的ephemeral call frame，不export为跨模块type，也不得被当作M1/M2结构替代品。

以下是M4拥有且会出现在signature、result、proof、error或private-reader边界上的完整type surface。代码块中的M1/M2成员均是owner type的直接引用，不是M4 copy：

```ts
declare const recoverySnapshotAuthorityViewBrand: unique symbol
declare const automaticRecoveryProofSliceBrand: unique symbol
declare const automaticRecoveryToolEvidenceProofBrand: unique symbol
declare const automaticRecoveryReasoningEvidenceProofBrand: unique symbol
declare const automaticRecoveryProviderPrefixProofBrand: unique symbol
declare const sealedRecoveryUseLeaseBrand: unique symbol
declare const sealedRecoveryUseReleaseValidationBrand: unique symbol
declare const deadProcessLeaseCleanupCapabilityBrand: unique symbol
declare const supersessionBeforePrepareProofBrand: unique symbol
declare const supersessionRequiredAuthorityBrand: unique symbol
declare const recoveryCascadeDeletionProofBrand: unique symbol

export type RecoveryRawRowV1<T extends M1.RecoveryOperationType = M1.RecoveryOperationType> = Readonly<{
  rowID: string
  aggregateID: M1.RecoveryAggregateID
  aggregateSequence: M1.SafeNonNegativeInt
  eventType: Extract<M1.RecoveryEventRegistryV1["definitions"][number], { operationType: T }>["eventType"]
  eventVersion: 1
  publication: "internal"
  operationFamily: "m1-recovery-v1"
  operation: M1.RecoveryOperationEnvelope<T>
  receipt: M1.ReceiptForV1<T>
  postStateDigest: M1.CanonicalDigestValue
  authorityRowDigest: M4.AuthorityRowDigest
}>

export type RecoverySnapshotIdentityV1 = Readonly<{
  identityVersion: 1
  sessionID: string
  aggregateID: M1.RecoveryAggregateID
  sourceAssistantID: M1.RecoveryAssistantID
  sourceHighWater: M1.SafeNonNegativeInt
  sourceVersionDigest: M1.RecoverySourceVersionDigest
  controlTailVersionDigest: M1.RecoveryControlTailDigest
  controlTailToInclusive: M1.SafeNonNegativeInt
  controlTailHash: M1.EventChainDigest
  latestDecisionRevision?: M1.SafeNonNegativeInt
}>

export type AutomaticRecoveryToolEvidenceProofV1 = Readonly<{
  proofVersion: 1
  snapshotIdentity: M4.RecoverySnapshotIdentityV1
  aggregateID: M1.RecoveryAggregateID
  operationID: M1.RecoveryOperationID
  eventSequence: M1.SafeNonNegativeInt
  evidence: M1.AuthoritativeToolEvidenceV1 & Readonly<{
    phase: Extract<M1.ToolExecutionPhaseV1, { phase: "final-after-hook-settled" }>
    arguments: M1.RecoveryReplayPayloadV1 & Readonly<{ valueKind: "canonical-wire-value" }>
    terminalPayload: M1.ToolTerminalReplayPayloadV1
    finalPlanDigest: M1.ToolPlanDigest
    callDigest: M1.ToolCallDigest
    resultDigest: M1.ToolResultDigest
  }>
  readonly [automaticRecoveryToolEvidenceProofBrand]: true
}>
export type AutomaticRecoveryReasoningEvidenceProofV1 = Readonly<{
  proofVersion: 1
  snapshotIdentity: M4.RecoverySnapshotIdentityV1
  aggregateID: M1.RecoveryAggregateID
  operationID: M1.RecoveryOperationID
  eventSequence: M1.SafeNonNegativeInt
  evidence: M1.ReasoningEvidence & Readonly<{
    provenance: "provider-end"
    continuationMode: "signed" | "stored-reference"
    content: M1.RecoveryReplayPayloadV1 & Readonly<{ valueKind: "utf8-text" }>
    textDigest: M1.ReasoningTextDigest
  }>
  readonly [automaticRecoveryReasoningEvidenceProofBrand]: true
}>
export type AutomaticRecoveryProviderPrefixProofV1 = Readonly<{
  proofVersion: 1
  snapshotIdentity: M4.RecoverySnapshotIdentityV1
  aggregateID: M1.RecoveryAggregateID
  operationID: M1.RecoveryOperationID
  eventSequence: M1.SafeNonNegativeInt
  checkpoint: M1.OperationSchemaByTypeV1["provider-prefix-recorded"]["payload"]["checkpoint"]
  readonly [automaticRecoveryProviderPrefixProofBrand]: true
}>

export type SnapshotBoundToolEligibilityV1 =
  | Readonly<{
      kind: "safe-retry-eligible"
      action: "safe-retry"
      snapshotIdentity: M4.RecoverySnapshotIdentityV1
      partition: Extract<M1.CanonicalToolEvidencePartitionV1, { authorityClass: "truly-empty" }>
      closure: Extract<M1.RecoveryClosureDescriptor, { status: "not-needed"; action: "safe-retry" }>
      toolProofs: readonly []
      reasoningProofs: readonly []
      readonly [automaticRecoveryProofSliceBrand]: true
    }>
  | Readonly<{
      kind: "continue-eligible"
      action: "continue-after-settled-tools"
      snapshotIdentity: M4.RecoverySnapshotIdentityV1
      partition: Extract<M1.CanonicalToolEvidencePartitionV1, { authorityClass: "authoritative-only" }>
      closureSourceBinding: Extract<M1.RecoveryClosureDescriptor, { status: "available" }>["sourceBinding"]
      toolProofs: M1.NonEmptyReadonlyArray<M4.AutomaticRecoveryToolEvidenceProofV1>
      reasoningProofs: readonly M4.AutomaticRecoveryReasoningEvidenceProofV1[]
      providerPrefixProof: M4.AutomaticRecoveryProviderPrefixProofV1
      readonly [automaticRecoveryProofSliceBrand]: true
    }>
  | Readonly<{
      kind: "manual-only"
      snapshotIdentity: M4.RecoverySnapshotIdentityV1
      partition: M1.CanonicalToolEvidencePartitionV1
      causes: M1.NonEmptyReadonlyArray<M1.RecoveryFailureCause>
      toolProofs: readonly []
      reasoningProofs: readonly []
    }>

export type AutomaticRecoveryProofSliceV1 = Exclude<
  M4.SnapshotBoundToolEligibilityV1,
  { kind: "manual-only" }
>

export type DurableRecoveryAuthorityViewV1 = Readonly<{
  viewVersion: 1
  snapshot: M1.DurableRecoverySnapshot
  snapshotIdentity: M4.RecoverySnapshotIdentityV1
  toolEligibility: M4.SnapshotBoundToolEligibilityV1
  readonly [recoverySnapshotAuthorityViewBrand]: true
}>

export type RecoveryFoldedStateV1 = Readonly<{
  sessionID: string
  aggregateID: M1.RecoveryAggregateID
  aggregateEventHead: M1.AdmissionPlan["expectedHeads"]["aggregateEventHead"]
  legacyAssistantMaterializationIntents: readonly M1.OperationSchemaByTypeV1["initial-chain-genesis-and-dispatch"]["payload"]["assistantMessage"][]
  relations: readonly Readonly<{
    assistant: M1.CommittedAssistantAttemptIdentity
    admissionContext: M1.CommittedDispatchAttemptContext
  }>[]
  dispatchLedger: readonly (M1.AvailableDispatchEvidence | M1.OpaqueDispatchEvidence)[]
  tools: readonly M1.AuthoritativeToolEvidenceV1[]
  reasoning: readonly M1.ReasoningEvidence[]
  decisions: readonly M1.RecoveryDecisionRecord[]
  consumptions: readonly NonNullable<M1.DurableRecoverySnapshot["consumption"]>[]
  projectionHistory: readonly Readonly<{
    sourceAssistantID: M1.RecoveryAssistantID
    sourceEventSequence: M1.SafeNonNegativeInt
    operationID: M1.RecoveryOperationID
    value: M1.RecoveryPublicProjectionV1
  }>[]
  currentProjectionView: ReadonlyMap<M1.RecoveryAssistantID, M1.RecoveryPublicProjectionV1>
  assistantChainHeads: readonly M1.AdmissionPlan["expectedHeads"]["assistantChainHead"][]
  dispatchLedgerHeads: readonly M1.AdmissionPlan["expectedHeads"]["dispatchLedgerHead"][]
  recoveryHeads: readonly M1.OperationSchemaByTypeV1["decision-finalized"]["expectedPredecessors"]["recoveryHead"][]
  providerPrefixFacts: readonly M1.OperationSchemaByTypeV1["provider-prefix-recorded"]["payload"]["checkpoint"][]
  incompleteTerminalFacts: readonly M1.OperationSchemaByTypeV1["incomplete-terminal-recorded"]["payload"]["terminal"][]
  operationPostStates: ReadonlyMap<M1.SafeNonNegativeInt, M1.OperationPostStateForV1<M1.RecoveryOperationType>>
  postStateDigest: M1.CanonicalDigestValue
}>

export type PendingSealV1 = Readonly<{
  version: 1
  ref: M1.SealedRecoveryMaterialRef
  sessionID: string
  assistantID: M1.RecoveryAssistantID
  targetDigest: M1.DispatchTargetDigest
  materialKind: M1.SealedRecoveryMaterialRef["purpose"]
  keyVersion: M1.SafePositiveInt
  generation: 0
  wrapNonce: Uint8Array
  wrappedDEK: Uint8Array
  wrapTag: Uint8Array
  cipherNonce: Uint8Array
  ciphertext: Uint8Array
  cipherTag: Uint8Array
  plaintextCommitment: M1.SealedMaterialCommitment
  scopeDigest: M1.CanonicalDigestValue
}>

export type SealedRecoveryUseLeaseIDV1 = string & M1.Brand<"M4SealedRecoveryUseLeaseIDV1">
export type SealedRecoveryUseClosureBindingV1 =
  | Readonly<{
      action: "safe-retry"
      closure: Extract<M1.RecoveryClosureDescriptor, { status: "not-needed"; action: "safe-retry" }>
    }>
  | Readonly<{
      action: "continue-after-settled-tools"
      sourceBinding: Extract<M1.RecoveryClosureDescriptor, { status: "available" }>["sourceBinding"]
      closureDigest: Extract<M1.RecoveryClosureDescriptor, { status: "available" }>["closureDigest"]
    }>
export type SealedRecoveryUseLeaseV1 = Readonly<{
  leaseVersion: 1
  leaseID: M4.SealedRecoveryUseLeaseIDV1
  leaseKey: M1.SealedRecoveryUseLeaseKeyInputV1
  leaseKeyDigest: M4.SealedUseLeaseKeyDigest
  snapshotIdentity: M4.RecoverySnapshotIdentityV1
  closureBinding: M4.SealedRecoveryUseClosureBindingV1
  ownerProcessInstanceID: string
  state: "live"
  acquiredAtOperationID: M1.RecoveryOperationID
  readonly [sealedRecoveryUseLeaseBrand]: true
}>
export type SealedRecoveryUseReleaseValidationV1 = Readonly<{
  proofVersion: 1
  snapshotIdentity: M4.RecoverySnapshotIdentityV1
  leases: readonly Readonly<{
    leaseID: M4.SealedRecoveryUseLeaseIDV1
    leaseKeyDigest: M4.SealedUseLeaseKeyDigest
    closureBinding: M4.SealedRecoveryUseClosureBindingV1
  }>[]
  operationID: M1.RecoveryOperationID
  preparedHandleCommitment: M1.PausedHandleCommitment
  state: "live-after-complete-result-before-f27-authorization-and-release"
  readonly [sealedRecoveryUseReleaseValidationBrand]: true
}>
export type SealedRecoveryUseLeaseCloseReasonV1 =
  | "released" | "mechanically-cancelled" | "abandoned"
  | "lost-handle-cleanup" | "process-crash-cleanup" | "session-cascade"
export type ExclusiveDeadProcessLeaseCleanupCapability = Readonly<{
  capabilityVersion: 1
  deadOwnerProcessInstanceID: string
  livenessFence: "exclusive-process-owner-lock-acquired"
  readonly [deadProcessLeaseCleanupCapabilityBrand]: true
}>

export type SessionRecoveryAggregateOwnerPreparedV1 = Readonly<{
  preparedVersion: 1
  sessionID: string
  publicSessionAggregateID: SessionOwner.PublicSessionAggregateID
  recoveryAggregateID: M1.RecoveryAggregateID
  sealedAggregateID: M4.SealedAggregateID
  recoveryGenesisHead: Extract<M1.AdmissionPlan["expectedHeads"]["aggregateEventHead"], { kind: "genesis" }>
  sealedGenesisDigest: M4.SealedEventChainDigest
  lifecycle: "parent-transaction-only"
}>

export type SessionRecoveryAggregateOwnerViewV1 = Readonly<{
  viewVersion: 1
  sessionID: string
  publicSessionAggregateID: SessionOwner.PublicSessionAggregateID
  recoveryAggregateID: M1.RecoveryAggregateID
  sealedAggregateID: M4.SealedAggregateID
  schemaVersion: 1
  ownerProof: M1.M4RecoveryAggregateOwnerMappingProofV1
}>

export type InitialAdmissionAuthorityViewV1<
  P extends M2.NoPreparedHandleProofV1 | M2.PreparedUnreleasedHandleProofV1,
> = Readonly<{
  viewVersion: 1
  origin: "initial"
  owner: M4.SessionRecoveryAggregateOwnerViewV1
  aggregateEventHead: M1.AdmissionPlan["expectedHeads"]["aggregateEventHead"]
  recoveryHead: M1.OperationSchemaByTypeV1["decision-finalized"]["expectedPredecessors"]["recoveryHead"]
  assistantChainHead: Extract<M1.AdmissionPlan["expectedHeads"]["assistantChainHead"], { kind: "genesis" }>
  dispatchLedgerHead: Extract<M1.AdmissionPlan["expectedHeads"]["dispatchLedgerHead"], { kind: "genesis" }>
  policy: M6.RecoveryPolicyAuthoritySnapshot
  userMessagePredecessor: M1.LegacyUserMessagePredecessorV1
  candidate: M1.CandidateAssistantAttemptIdentity
  context: M1.CandidateDispatchAttemptContext
  handleProof: P
  supersessionProof: M4.SupersessionBeforePrepareProofV1
}>

export type OrdinaryAdmissionAuthorityViewV1<
  P extends M2.NoPreparedHandleProofV1 | M2.PreparedUnreleasedHandleProofV1,
> = Readonly<{
  viewVersion: 1
  origin: "ordinary"
  owner: M4.SessionRecoveryAggregateOwnerViewV1
  aggregateEventHead: M1.AdmissionPlan["expectedHeads"]["aggregateEventHead"]
  recoveryHead: M1.OperationSchemaByTypeV1["decision-finalized"]["expectedPredecessors"]["recoveryHead"]
  assistantChainHead: Extract<M1.AdmissionPlan["expectedHeads"]["assistantChainHead"], { kind: "assistant" }>
  dispatchLedgerHead: Extract<M1.AdmissionPlan["expectedHeads"]["dispatchLedgerHead"], { kind: "genesis" }>
  policy: M6.RecoveryPolicyAuthoritySnapshot
  predecessor: M1.CommittedAssistantAttemptIdentity
  candidate: M1.CandidateAssistantAttemptIdentity
  context: M1.CandidateDispatchAttemptContext
  handleProof: P
}>

export type CommittedAssistantAdmissionOperationV1 =
  | "initial-chain-genesis-and-dispatch"
  | "ordinary-assistant-and-dispatch-admitted"
  | "automatic-child-admitted-and-consumed"
export type CommittedAssistantOriginForV1<K extends M4.CommittedAssistantAdmissionOperationV1> =
  K extends "initial-chain-genesis-and-dispatch" ? "initial" :
  K extends "ordinary-assistant-and-dispatch-admitted" ? "ordinary" : "automatic"
export type CommittedAssistantIdentityForV1<K extends M4.CommittedAssistantAdmissionOperationV1> =
  K extends "automatic-child-admitted-and-consumed"
    ? M1.OperationPostStateForV1<"automatic-child-admitted-and-consumed">["childAssistant"]
    : M1.OperationPostStateForV1<Extract<K, "initial-chain-genesis-and-dispatch" | "ordinary-assistant-and-dispatch-admitted">>["assistant"]
export type CommittedAssistantContextForV1<K extends M4.CommittedAssistantAdmissionOperationV1> =
  K extends "automatic-child-admitted-and-consumed"
    ? M1.OperationPostStateForV1<"automatic-child-admitted-and-consumed">["childDispatch"]
    : M1.OperationPostStateForV1<Extract<K, "initial-chain-genesis-and-dispatch" | "ordinary-assistant-and-dispatch-admitted">>["dispatch"]
export type CommittedAssistantAuthorityViewV1<
  K extends M4.CommittedAssistantAdmissionOperationV1 = M4.CommittedAssistantAdmissionOperationV1,
> = Readonly<{
  viewVersion: 1
  admissionOperationType: K
  origin: M4.CommittedAssistantOriginForV1<K>
  nonterminal: true
  owner: M4.SessionRecoveryAggregateOwnerViewV1
  admissionResult: M1.OperationCommitResultV1<K>
  assistant: M4.CommittedAssistantIdentityForV1<K>
  context: M4.CommittedAssistantContextForV1<K>
  aggregateEventHead: M1.AdmissionPlan["expectedHeads"]["aggregateEventHead"]
  assistantChainHead: Extract<M1.AdmissionPlan["expectedHeads"]["assistantChainHead"], { kind: "assistant" }>
  dispatchLedgerHead: Extract<M1.AdmissionPlan["expectedHeads"]["dispatchLedgerHead"], { kind: "dispatch" }>
  recoveryHead: M1.OperationSchemaByTypeV1["decision-finalized"]["expectedPredecessors"]["recoveryHead"]
  dispatches: readonly (M1.AvailableDispatchEvidence | M1.OpaqueDispatchEvidence)[]
  tools: readonly M1.ToolEvidence[]
  reasoning: readonly M1.ReasoningEvidence[]
  providerPrefixFacts: readonly M1.OperationSchemaByTypeV1["provider-prefix-recorded"]["payload"]["checkpoint"][]
}>

export type SupersessionRequiredAuthorityV1 = Readonly<{
  viewVersion: 1
  sessionID: string
  owner: M4.SessionRecoveryAggregateOwnerViewV1
  sourceAssistant: M1.CommittedAssistantAttemptIdentity
  sourceContext: M1.CommittedDispatchAttemptContext
  sourceVersion: M1.OperationSchemaByTypeV1["decision-finalized"]["payload"]["sourceVersion"]
  controlTailVersion: M1.OperationSchemaByTypeV1["decision-finalized"]["payload"]["controlTailVersion"]
  expectedPredecessors: M1.OperationSchemaByTypeV1["source-superseded"]["expectedPredecessors"]
  nextDecisionRevision: M1.SafeNonNegativeInt
  readonly [supersessionRequiredAuthorityBrand]: true
}>

export type NewInputSupersessionCommitResultV1 =
  | Readonly<{ kind: "superseded"; result: M1.OperationCommitResultV1<"source-superseded"> }>
  | Readonly<{ kind: "automatic-winner"; result: M1.OperationCommitResultV1<"automatic-child-admitted-and-consumed"> }>

export type SupersessionBeforePrepareResultV1 =
  | Readonly<{ kind: "model-supersession-validated"; result: M1.OperationCommitResultV1<"source-superseded">; proof: M4.SupersessionBeforePrepareProofV1 }>
  | Readonly<{ kind: "model-no-unresolved-source"; proof: M4.SupersessionBeforePrepareProofV1 }>
  | Readonly<{ kind: "no-reply-supersession-validated"; result: M1.OperationCommitResultV1<"source-superseded"> }>
  | Readonly<{ kind: "no-reply-no-unresolved-source" }>
  | Readonly<{ kind: "supersession-required"; authority: M4.SupersessionRequiredAuthorityV1 }>
  | Readonly<{ kind: "automatic-winner"; result: M1.OperationCommitResultV1<"automatic-child-admitted-and-consumed">; snapshot: M4.DurableRecoveryAuthorityViewV1 }>

export type CurrentRecoveryWinnerV1 =
  | Readonly<{ kind: "unchanged"; head: M1.OperationSchemaByTypeV1["decision-finalized"]["expectedPredecessors"]["recoveryHead"] }>
  | Readonly<{ kind: "manual-stop"; result: M1.OperationCommitResultV1<"decision-finalized"> }>
  | Readonly<{ kind: "automatic"; result: M1.OperationCommitResultV1<"automatic-child-admitted-and-consumed"> }>
  | Readonly<{ kind: "superseded"; result: M1.OperationCommitResultV1<"source-superseded"> }>
```

M4 private raw/fold/result types的§3.1 contract如下：

| 数据结构 | 字段与type invariant | 唯一性/identity | 生命周期 | Owner / consumers |
|---|---|---|---|---|
| `M4.RecoveryRawRowV1<T>` | 字段exact如上；`operation.aggregateID/aggregateSequence/operationType`分别等于row字段，`eventType=Extract<M1.RecoveryEventRegistryV1["definitions"][number], { operationType: T }>["eventType"]`，receipt必须是`M1.ReceiptForV1<T>`，`operation.eventChain.nextDigest`是该row的M1 chain digest；不得出现public、M4 sealed family或ephemeral `applyMode` | `(aggregateID,aggregateSequence)`与`(aggregateID,operation.operationID)`各自唯一；`rowID`只作physical identity并由authority-row digest绑定 | A3 first apply创建；immutable；session cascade删除；P3R decode后仅在tx/fold scope存活 | M4 private；P3R产出，A2/A3/A4/A5/S1/R1/MIG1/K0-family消费 |
| `M4.ToolEvidenceSqlMappingV1`、`M4.ReasoningEvidenceSqlMappingV1` | `mappingVersion:1`+§4.2.3逐domain finite forward/reverse maps；没有codec/normalizer字段 | 每张map key/value set与M1/SQL exact domain等势、双射；mapping record module-singleton | module initialization构造并freeze；schema v1内不可变 | M4 / A2、A3、S1、R1、MIG1 |
| `M4.RecoverySnapshotIdentityV1`、`M4.DurableRecoveryAuthorityViewV1` | view完整包装一个M1 `DurableRecoverySnapshot`，不Pick/Omit；identity逐字段取snapshot的session/aggregate/source high-water/source+control digests/control tail end+hash/latest revision；private brand只在S1同一pinned transaction完成raw/七表/三head/sealed/material mapping read-back后附加 | identity是上述closed tuple；view中的`snapshotIdentity`、`snapshot.assistantPublicMapping.snapshotIdentity`及source/control fields必须双向exact | S1每次读取临时创建；任一raw/head/control/decision变化即失效；不可持久化、deserialize或从projection/history构造 | M4 owner；M5接收完整view；M7只接收其中action-matching nominal proof slice，不接收裸snapshot |
| `M4.AutomaticRecoveryToolEvidenceProofV1`、`M4.AutomaticRecoveryReasoningEvidenceProofV1`、`M4.AutomaticRecoveryProviderPrefixProofV1`、`M4.AutomaticRecoveryProofSliceV1`、`M4.SnapshotBoundToolEligibilityV1` | 每个evidence proof显式绑定同一`RecoverySnapshotIdentityV1`与raw operation anchor，并把M1 owner evidence窄化为required carrier/commitment/final phase；safe-retry/continue slice自身也带module-private brand。truly-empty且其它action prerequisites有效的slice携M1 exact not-needed closure；Continue slice携exact source binding、ordered tool/reasoning proofs与唯一provider-prefix proof，足以让M7只从slice构造M1 `RecoveryClosureDescriptor` available branch；compatibility-only/mixed、authoritative中任一非final/不一致，或任意partition的其它required sealed/closure/snapshot prerequisite失败均为manual-only并保留原partition | evidence proof identity=`(snapshotIdentity,aggregateID,eventSequence,operationID)`；slice identity=`(action,snapshotIdentity,partition,closure source binding,ordered proof identities)`；partition discriminator与proof cardinality双向一致，Continue proof arrays/checkpoint与snapshot authoritative order/source-control identity一一对应 | 只由S1 snapshot builder在materialize/decode/recompute全部成功后附brand；M7构造closure后必须用M1 builder重算`closureDigest`并反向比较descriptor的source binding/carriers/order与slice；prefix/identity变化即失效；不可持久化/deserialize伪造 | M4 / M5消费view；M7只消费`AutomaticRecoveryProofSliceV1`，不接收裸snapshot/fold/manual-only branch；M7产出的M1 closure随same candidate/prepared handle继续绑定 |
| `M4.RecoveryFoldedStateV1` | 字段exact如上；七个materialization分别是relations/dispatch/tools/reasoning/decisions/consumptions/projectionHistory，current view只由history最大sequence纯导出；raw fold中的tools只含M1 `AuthoritativeToolEvidenceV1`，Legacy compatibility不进入raw fold；三个head集合与aggregate head分离；所有M1 value均由M1 exact reducer/projector产生 | identity是`(aggregateID,aggregateEventHead)`；同一完整prefix只能有一个byte-equivalent fold | A2每次从genesis重建；纯immutable临时值；不得持久化为第二authority | M4 private；A2产出，A3/A4/A5/S1/R1消费；M5/M7不得直接接收fold |
| `M4.PendingSealV1` | 字段exact如上；六个cipher/wrap blobs均nonempty；`generation=0`；ref purpose/scope、session/assistant/target、commitment与parent M1 payload exact match；不含runtime handle | `ref.id`全局唯一；在一个parent operation内按refID无duplicate | K1创建；仅可由A3 first-apply中的K2消费一次；tx/调用结束清除可变buffer引用 | M4 private；K1产出，M2/M3暂持，A3/K2消费 |
| `M4.SealedRecoveryUseClosureBindingV1`、`M4.SealedRecoveryUseLeaseV1`、`M4.SealedRecoveryUseReleaseValidationV1` | lease完整嵌入M1 `SealedRecoveryUseLeaseKeyInputV1`，另含opaque lease ID、M4 key digest、exact snapshot identity、M1 closure source/digest binding、owner process instance、live state与private brand；release validation是complete type-9 result返回后、同一handle仍prepared时、任何F27/M2 authorization/release之前对同一组live lease执行的最后一次CAS read nominal proof，不含raw material | live uniqueness=`leaseKeyDigest`且同`refID+sealedGeneration`只能有closed history或一个live row；key digest绑定M1 exact members，row digest另绑定snapshot identity与safe-retry not-needed或Continue sourceBinding+closureDigest，且action双向一致 | K7以branded slice+exact M1 closure acquire后才允许unseal/lowering/preparation；O8 first apply执行commit-time K8；complete result后立即执行独立pre-release K8，成功才允许F27→M2 exact authorization→release once→K9，失败则prepared→mechanically-cancelled且F27/authorization/release calls=0，再K9/zeroize；proof/lease不可deserialize伪造 | M4 owner；M7/M2借用lease；O8消费commit-time K8，M2以pre-release K8 proof动态scope守卫F27/authorization/release；K4/K5只读live-conflict guard |
| `M4.SessionRecoveryAggregateOwnerPreparedV1` | 三aggregate ID pairwise distinct；recovery genesis必须是M1 exact aggregate-genesis head；`lifecycle`固定parent-only | sessionID唯一；一个session恰有一pair | C1在parent tx内创建；parent commit前不得逃逸；commit/rollback后prepared capability失效 | M4 owner；SessionOwner唯一consumer |
| `M4.SessionRecoveryAggregateOwnerViewV1` | 字段exact如上；四个IDs/roles/schema必须由committed owner row+两个dedicated cursors同一read验证，public/recovery/sealed IDs pairwise distinct；`ownerProof`必须是M1 exact `M4RecoveryAggregateOwnerMappingProofV1`且逐字段等于session/recovery tuple | identity=`(sessionID,recoveryAggregateID,sealedAggregateID)`；一个committed session唯一；M1定义proof exact surface/brand，M4 owner validator在same-tx双向mapping验证后唯一附加，consumer不能structurally forge | C1 parent commit或MIG1完成后才可由M4 read service构造；owner mapping/cascade变化即proof/view失效 | M4 owner；initial/ordinary/supersession/committed-assistant authority readers、M1 private decode与O1/A3消费 |
| `M4.InitialAdmissionAuthorityViewV1<P>` | 字段exact如上；只接受`origin:"initial"`；aggregate head是dedicated aggregate exact current head，empty时必须是C1/MIG1 genesis；policy是current committed M6 snapshot；Legacy user predecessor已commit；candidate/context同一；assistant/ordinal-0 ledger均genesis；`handleProof`只能是exact M2 no-handle或prepared proof | identity=`(owner,aggregateEventHead,policy quartet,user predecessor,candidate context,supersession proof)`；recovery head对type-1仅作observed current value，不成为terminal source | M6在user commit后以no-handle proof取得planning view；M2一次prepare后由M4 binder换成同candidate prepared proof；O1/A3 first-apply消费；head/policy/proof变化即stale | M4 owner；M6/M2 handoff、O1/A3消费；不得由`M1.DurableRecoverySnapshot`构造 |
| `M4.OrdinaryAdmissionAuthorityViewV1<P>` | 字段exact如上；committed assistant predecessor/current assistant-chain head exact；candidate自己的ordinal-0 ledger genesis；current aggregate/recovery heads、owner、policy来自ordinary authority read；handle proof staged同initial | identity=`(owner,current heads,policy quartet,predecessor,candidate context)` | predecessor terminal/settled后以no-handle planning view开始；一次prepare后bind prepared proof；O1/A3 first-apply消费；任一current fact变化即stale | M4 owner；M6 ordinary path、O1/A3消费；不得由terminal recovery snapshot替代 |
| `M4.CommittedAssistantAuthorityViewV1<K>` | generic `K`只允许type1/type2/type9；字段exact如上；`origin/assistant/context`由K条件索引到M1 operation post-state；`nonterminal:true`；dispatch/tool/reasoning/prefix slices只含该assistant截至同一current prefix的facts | identity=`(owner,admissionResult.operation,assistant,aggregateEventHead,dispatchLedgerHead)`；K、raw operation type与relation origin exact相等 | loader同一WAL snapshot构造；assistant出现terminal incomplete fact、finalized/consumed/superseded source decision或owner/head变化即拒绝/失效 | M4 owner；M2/M6 initial/ordinary/automatic same-process reentry消费；type9 result仅在original same handle仍prepared并fresh pre-release K8 success后才可F27/authorization/release；不得替代或从`M1.DurableRecoverySnapshot`构造 |
| `M4.SupersessionRequiredAuthorityV1` | exact含committed owner、source assistant/context、M1 source/control versions、type10 exact expected predecessors与next decision revision；private unique-symbol brand只由O10 inspection same-tx fold构造 | identity=`(owner,sourceVersion.versionDigest,controlTailVersion.versionDigest,expectedPredecessors,nextDecisionRevision)` | O10 inspect unresolved-source branch临时产生；只供caller构造完整type10 input并再次调用O10 complete-input branch；head变化即stale | M4 owner；M6 supersession input builder消费；不是receipt/snapshot/prepared proof |
| `M4.NewInputSupersessionCommitResultV1` | closed two-branch union；每个committed branch携带complete M1 result，无detached receipt | branch discriminator + contained operation tuple | O9 call scope immutable result | M4 owner；O10/M6消费 |
| `M4.SupersessionBeforePrepareResultV1` | closed six-branch union；仅两个model success/no-source branch可携带M4 preparation proof；inspection unresolved source只返回branded `supersession-required` authority；no-reply无proof；automatic带complete result+same-snapshot M1 snapshot | branch discriminator；proof/result/authority tuple必须same session/aggregate/head | O10验证后产生；`supersession-required`必须先构造完整expected input再重入O10，不能直接commit；model proof仅供对应O1 first-apply | M4 owner；M6 sequencing消费 |
| `M4.CurrentRecoveryWinnerV1` | closed four-branch union；winner branch始终携带A4验证的complete M1 result | current recovery head的operationID决定唯一winner | S2 read snapshot内构造，return后immutable observation；不自行授权transport | M4 owner；O7/O8/O9/O10/M6消费 |

其余M4 signature-visible type不得只以名称出现而无contract：

| 数据结构 | 字段 | Type invariants / identity | 生命周期 | Owner / consumers |
|---|---|---|---|---|
| `M4.SealedAggregateID` | branded string；不得等于任何recovery/public aggregate ID | 全数据库aggregate ID namespace内唯一，owner map sealed role唯一 | C1/MIG1创建；不可修改；session cascade删除 | M4 / sealed services、owner validators |
| `M4.AuthorityRowDigest`、`M4.SealedRequestDigest`、`M4.SealedEventChainDigest`、`M4.SealedBlobCommitment`、`M4.SealedUseLeaseKeyDigest`、`M4.SealedUseLeaseRowDigest` | 均为`M1.CanonicalDigestValue`的distinct M4 brand；domain分别固定`m4-authority-row-v1`,`m4-sealed-request-v1`,`m4-sealed-event-chain-v1`,`m4-sealed-blob-v1`,`m4-sealed-use-lease-key-v1`,`m4-sealed-use-lease-row-v1`，字段membership见§3.2/§9.4/§9.3.1 | 不同brand/domain不可cast；digest identity由exact domain input唯一决定 | 对应builder创建；raw/receipt/lease row中immutable或append-only state transition；decode必须重算后brand | M4 / A3/A4/P3/K0/K3/K4/K5/K7–K10/R1/MIG1 |
| `M4.SupersessionBeforePrepareProofV1` | §6.10 exact two-branch fields并含module-private `unique symbol` readonly brand | unforgeable exact codec+nominal brand；identity为`(sessionID,aggregateID,intendedInitialOperationID,validatedHighWater)`；supersession branch另绑定type-10 operationID及full model supersession binding input/digest | O10在fresh validation后创建；仅对应O1 first-apply可消费；no-reply永不创建；不能deserialize/structurally construct | M4 / O1、A3 |
| `M4.SevenMaterializationName`、`M4.ThreeHeadName`、`M4.RecoveryOwnedTableName` | §4.5 closed literal tuples | set内无alias/unknown；分别标识7 materializations、3 heads与session cascade的完整M4-owned table set | module init freeze，schema version内不可变 | M4 / R1、K6、receipts |
| `M4.RebuildReceiptV1`、`M4.RotationReceiptV1`、`M4.RedactionReceiptV1`、`M4.RecoveryMigrationReceiptV1` | 分别见§4.5、§9.5、§9.6、§10.1 exact fields | discriminator+aggregate/operation或migration ID唯一；immutable；不得含`applyMode` | 对应transaction commit后创建/恢复；只读返回 | M4 / maintenance、startup owner |
| `M4.RecoveryCascadeDeletionProofV1` | §4.5 exact fields+module-private unique-symbol brand | session/pair+fixed pre/post count proof：`deletedCounts=before-after`且`remainingCounts`全0；`foreignKeyViolations:0`；consumer不能structurally construct | 只在parent deletion tx内有效；parent commit后作为diagnostic proof | M4 / SessionOwner deletion |
| `M4.SealedMaintenanceTypeV1`、`M4.SealedAggregateEventHeadV1`、`M4.SealedRequestByTypeV1`、`M4.SealedMaintenanceEnvelopeV1<T>` | §9.4 exact fields | type discriminator决定request；head identity为sealed aggregate+genesis/event sequence；envelope identity为aggregate+operationID | K4/K5 first apply构造；raw commit后immutable | M4 / K0a、P3S、K3、R1、MIG1 |
| `M4.SealedMaintenanceRawRowV1`、`M4.SealedAuthorityPrefixV1`、`M4.SealedAuthoritativeRowV1`、`M4.SealedFoldedStateV1` | §9.4/§9.4.1 exact fields；prefix直接引用`M4.RecoveryRawRowV1[]`，不复制M1 row；fold明确排除time columns | recovery/sealed owner tuple exact；两个chain identity独立；raw按aggregate sequence/opID唯一，fold map按refID唯一 | P3S/P3R读取、K0纯fold，随caller scope释放；raw/physical row由session cascade删除 | M4 / K0a/K3/K4/K5/R1/MIG1 |
| `M4.ExclusiveStartupRebuildCapability` | 无data field；opaque nominal process capability | 单进程startup maintenance owner唯一，不能deserialize/HTTP构造 | startup exclusive window创建，R1 return后borrow失效 | M4 / R1 |
| `M4.ExclusiveDeadProcessLeaseCleanupCapability` | exact含dead owner process instance与`exclusive-process-owner-lock-acquired` liveness fence、private brand；不含时间戳/TTL | 只有process coordinator在取得该instance的exclusive OS/process-owner lock并确认不存在live owner后可构造；不能deserialize/HTTP构造 | startup或lost-handle coordinator一次cleanup scope内有效，return后失效 | M4 / K10 only |
| `M4.RecoveryReadTransaction`、`M4.RecoveryImmediateTransaction`、`M4.RecoveryReadOrWriteTransaction` | 无可序列化data field；opaque active SQLite transaction capability | 绑定一个connection/snapshot；closed后任何使用typed failure | transaction owner创建并关闭；helper只borrow、不commit | M4 database adapter / A4、S1 helper、P3R/P3S、K2、K0a |
| `M4.RecoveryAuthorityPrivateEventReaderV1` | §8.1两个private methods，参数与返回均owner-qualified | 只有core-private capability可取得；public DI container不注册 | process startup构造，shutdown释放 | M4 / authority、snapshot、rebuild、sealed services |

M4 error surface统一使用下列exact record，而不是未定义的裸error names：

```ts
export type RecoveryErrorContextV1 = Readonly<{
  sessionID?: string
  aggregateID?: string
  operationID?: M1.RecoveryOperationID
  sequence?: M1.SafeNonNegativeInt
}>
export type RecoveryErrorKindV1 =
  | "owner-creation" | "operation-conflict" | "replay-inconsistent"
  | "receipt-type-mismatch" | "snapshot-inconsistent" | "rebuild-conflict"
  | "prepared-handle-invalid" | "policy-authority-stale" | "seal"
  | "migration" | "busy-exhausted" | "database-read" | "database-write"
export type RecoveryErrorReasonByKindV1 = Readonly<{
  "owner-creation":
    | "session-conflict" | "aggregate-id-role-collision" | "aggregate-id-cross-session"
    | "partial-owner-state" | "recovery-genesis-diverged" | "sealed-genesis-diverged" | "first-insert-zero-rows"
  "operation-conflict":
    | "payload-digest-mismatch" | "operation-family-mismatch" | "operation-type-mismatch"
    | "predecessor-mismatch" | "head-cas-lost" | "first-apply-zero-rows"
  "replay-inconsistent":
    | "owner-mapping-missing" | "owner-mapping-partial" | "missing-raw" | "missing-receipt"
    | "chain-broken" | "operation-prefix-diverged" | "current-prefix-diverged" | "head-diverged"
    | "unknown-version" | "partial-authority" | "aggregate-mismatch" | "sealed-parent-authority-missing"
    | "physical-sealed-row-diverged" | "sealed-cursor-diverged"
  "receipt-type-mismatch": "receipt-kind-mismatch"
  "snapshot-inconsistent":
    | "owner-mapping-missing" | "owner-mapping-partial" | "missing-raw" | "chain-broken"
    | "current-prefix-diverged" | "head-diverged" | "unknown-version" | "partial-authority" | "aggregate-mismatch"
  "rebuild-conflict":
    | "owner-mapping-missing" | "owner-mapping-partial" | "aggregate-mismatch"
    | "expected-aggregate-head-mismatch" | "foreign-derived-row"
  "prepared-handle-invalid": "prepared-handle-mismatch"
  "policy-authority-stale": "policy-history-mismatch"
  "seal":
    | "request-digest-mismatch" | "generation-mismatch" | "state-mismatch" | "rotate-redact-race"
    | "first-persist-zero-rows" | "parent-authority-mismatch" | "sealed-cursor-diverged"
    | "sealed-parent-authority-missing" | "physical-sealed-row-diverged"
    | "live-use-lease-conflict" | "lease-key-mismatch" | "lease-state-mismatch"
    | "process-liveness-not-proven"
  "migration":
    | "schema-version" | "partial-schema" | "aggregate-role-collision" | "duplicate-sequence"
    | "sequence-gap" | "canonicalization" | "backfill-cas" | "foreign-key" | "integrity-check"
    | "concurrent-writer" | "journal"
  "busy-exhausted": "busy-timeout"
  "database-read": "auth-scope" | "unsafe-cursor" | "limit" | "query" | "public-decode" | "read-io"
  "database-write": "query" | "write-io"
}>
export type RecoveryErrorReasonV1<K extends M4.RecoveryErrorKindV1 = M4.RecoveryErrorKindV1> =
  M4.RecoveryErrorReasonByKindV1[K]
export type RecoveryErrorV1<K extends RecoveryErrorKindV1 = RecoveryErrorKindV1> =
  K extends RecoveryErrorKindV1
    ? Readonly<{
        errorVersion: 1
        kind: K
        reason: M4.RecoveryErrorReasonV1<K>
        context: RecoveryErrorContextV1
      }>
    : never
export type SessionRecoveryOwnerCreationErrorV1 = M4.RecoveryErrorV1<"owner-creation" | "busy-exhausted" | "database-read" | "database-write">
export type RecoverySnapshotReadErrorV1 = M4.RecoveryErrorV1<"snapshot-inconsistent" | "replay-inconsistent" | "busy-exhausted" | "database-read">
export type RecoveryRebuildErrorV1 = M4.RecoveryErrorV1<"rebuild-conflict" | "replay-inconsistent" | "busy-exhausted" | "database-read" | "database-write">
export type RecoveryPendingSealPersistErrorV1 = M4.RecoveryErrorV1<"seal" | "replay-inconsistent" | "database-read" | "database-write">
export type RecoverySealErrorV1 = M4.RecoveryErrorV1<"seal" | "replay-inconsistent" | "busy-exhausted" | "database-read" | "database-write">
export type RecoveryAuthorityErrorV1 = M4.RecoveryErrorV1<Exclude<RecoveryErrorKindV1, "owner-creation">>
export type RecoveryMigrationErrorV1 = M4.RecoveryErrorV1<"migration" | "busy-exhausted" | "database-read" | "database-write">
```

error `reason`不是开放字符串：`RecoveryErrorReasonByKindV1`是唯一kind-indexed mapping，`RecoveryErrorV1<K>`通过distributive conditional保持`kind:K`与`reason:RecoveryErrorReasonV1<K>`相关，禁止用全局reason union、cast或`kind/reason`不匹配的structural object绕过。每个callable只能使用§4.5及其函数小节列出的closed `K→reason` branch，module initialization以每个kind的literal tuple双向set equality+`never` exhaustiveness验证mapping无missing/extra。`context`只允许安全ID/sequence且optional字段必须omit而非`undefined`；完整digest、payload、sealed ref、key/ciphertext永远不进入error。error identity是`kind+reason+context`的diagnostic value，不是authority；由失败callee创建、沿Effect error channel传播，transaction owner负责rollback后即释放；M4拥有，M2/M6/SessionOwner/maintenance只消费closed branch，不复制或扩展。

### 3.2 M1 operation envelope domains

M1 recovery operation必须直接使用`M1.RecoveryOperationInputV1<T>`与`M1.RecoveryOperationEnvelope<T>`及其实际exported exact codecs；字段shape由M1唯一拥有，本文不复制。M4只冻结其持久化所依赖的domain/field-membership obligations：

Domain rules：

- payload digest domain 唯一为 M1 `operation-payload-v1`，exact input 是 `{envelopeVersion,operationType,fieldSetVersion,expectedPredecessors,payload}`；
- event-chain digest domain唯一为M1 `event-chain-v1`，且只能使用`M1.EventChainDigestInputV1`两branch：aggregate genesis exact input=`{kind:"aggregate-genesis",hashVersion:1,aggregateID}`；operation exact input=`{kind:"operation",hashVersion:1,aggregateID,aggregateSequence,operationID,operationType,fieldSetVersion,previousDigest,payloadDigest}`。两者都必须调用M1 `buildEventChainDigestInput`与该registered domain的digest builder；
- operationID、aggregateID、aggregateSequence 不得误放进 payload digest；
- receipt、post-state digest、publication与SQLite row identity不进入M1 payload/event-chain digest；它们由M4 `authority-row-v1`另行覆盖。SQLite operational timestamps不进入authority；但M1 payload中显式的decision `createdAt`与Legacy assistant `createdAtMs`是record重建字段，必须进入完整operation payload digest，禁止从runtime clock或DB time column补入；
- pre-prepare supersession使用独立M1 `supersession-binding-v1`与`SupersessionBindingDigestInputV1` closed union：common exact绑定`sessionID,sourceVersion,sourceVersionDigest,controlTailVersion,controlTailDigest,submissionPayloadDigest,supersessionPredecessors`；model另且仅另含`kind:"model",intendedInitialOperationID`，no-reply另且仅另含`kind:"no-reply",replyDisposition:"commit-user-only"`。两branch完整input与digest都持久化于type-10 payload/decision，M4调用M1 owner builder+F22重算；它不替代later type-1完整payload digest；
- `AuthorityRowDigestInputV1` exact字段固定为`{version:1,rowID,aggregateID,aggregateSequence,publication,operationFamily,operationType,fieldSetVersion,encodedEnvelope,encodedReceipt,postStateDigest}`；`encodedEnvelope/encodedReceipt`是各owner exact codec产生的canonical value而非任意JSON string；builder固定`buildAuthorityRowDigestInput`，domain固定`m4-authority-row-v1`，输出brand为`M4.AuthorityRowDigest`；
- 对recovery/sealed internal operation，`authority_row_digest`只允许insert时写入且production API没有UPDATE路径。A3/A4/A5/S1/R1/K0/K0a/K4/K5/MIG1对其负责的dedicated internal rows逐row重新构造exact input并验证digest；因此receipt/post-state/publication/row identity的byte-level mutation会被拒绝。public-generic rows不进入该M4 digest contract。该commitment用于应用级accidental/corruption detection，不声称抵御可同时改写数据库所有rows/digests的Byzantine管理员；
- sealed maintenance 使用 §9.4 的 M4-private domain，不能 cast 为 M1 recovery operation，也不进入 M1 source/control event set；
- unknown domain/version/field set fail closed。

### 3.3 Exact M1 operation results 与 receipts

M4只使用M1 `*V1` exact exports。A3/A4/A5与O1–O9全部返回完整`M1.OperationCommitResultV1<T>`（O9 winner union的committed branches携带complete result）；M4不export `DispatchReceipt`/`RecoveryAdmissionReceipt`或structural result alias。调用者若只投影detached receipt，该值仅供观察/非transport comparison，不能授权provider release。

Immutable/result rules：

1. encoded M1 receipt原样存入产生它的raw `EventTable` row；replay/lookup只decode该stored receipt及其folded post-state，不重建新receipt。
2. `operation.operationType`与M1 receipt family按exact string discriminator匹配；available/opaque branch同时匹配M2 package、raw payload和folded materialization。
3. `applyMode`只使用M1 `OperationCommitResultV1<T>["applyMode"]` literals `"first-application"|"exact-replay"`，且只存在于ephemeral result，绝不进入raw/receipt/digest/public projection。
4. M2 transport authorization必须接收完整result。nonautomatic保持既有F26顺序：把`result.receipt + result.operationPostState`交F26并验证same paused handle。automatic必须在complete type-9 result后保持same handle prepared，立即先通过独立pre-release K8；只有K8 success才把complete result + `result.operationPostState`交F27并执行M2 exact same-handle authorization与single release。K8 failure时F27/authorization/release calls均为0，先mechanical cancel，再K9 close/zeroize；detached receipt、candidate、current head或K8 proof单独都不足以授权。
5. operations 1/2/9的historical policy quartet由input/raw/post-state/receipt逐项一致；exact replay先验证历史值，first application missing branch才读current policy。
6. candidate→committed identity、Legacy assistant info、relation、receipt与post-state只在A3 transaction-local derivation中形成；commit/read-back前不得缓存、export或用于public/runtime authority。

### 3.4 M1 safe projection ownership

七个materialization中的public projection表只保存M1实际export的`M1.RecoveryPublicProjectionV1`，并只通过M1 exported safe projector/exact codec构造与decode；本文不复制其字段或enum shape。

- M4 first-application transaction在需要公开child link时按M4-owned deterministic derivation分配/复用稳定、session-scoped、不可反解的display ID，验证同一`(sessionID,childAssistantID)`永远同值后，才把该validated value交给pure M1 projector；
- A2/S1只读验证projection中的mapping，不分配；R1 rebuild保留已验证mapping或按同一M4 deterministic derivation复得同值，绝不产生新随机display identity；M8只decode/display M1 value；
- unknown fact omit，不伪造 false/0；unknown enum 归一为 `unknown`；
- 禁止 target/authority/storage/digest/proof/operationID/decision/revision/head/receipt/sealed ref/ledger ordinal/tool/reasoning metadata；
- projection不是独立authority，但作为七个transactional materialization之一必须与产生它的raw fold同事务一致：M1 safe projector/codec在commit前失败会使A3整体rollback，因此不存在“已合法raw但缺失/伪造SQL projection”的partial commit；transaction commit后的M8 `message.updated`等public notification失败只记diagnostic，不回滚raw authority。online projector与rebuilder都调用M1实际export的safe projector与exact projection codec。

### 3.5 M2 prepared package 与 same-handle proof

M4只消费M2唯一owner-export的`M2.PreparedCommitPackageV1`、`M2.PreparedUnreleasedHandleProofV1`、`M2.NoPreparedHandleProofV1`与`M2.MechanicallyCancelledUnreleasedHandleProofV1`；本文不复制其字段、lease ID、brand或validator逻辑。package由一次final transform后的same object产生，available/opaque exact union、private facts、pending seals、paused commitment与proof freshness均以SESSREC-3 §4.1/§6为准，runtime send closure留在M2且不序列化。

M4的exact obligations是：dispatch入口先做non-resource structural/owner validation，以input payload session验证`sessionID↔aggregateID`后按`(aggregateID,operationID,expectedKind)`scoped lookup；existing必须先A4 exact replay。只有missing/first-application branch才调用`M2.validatePreparedUnreleasedHandleProofV1`验证package proof与candidate context/paused commitment，initial/ordinary planning authority view在prepare前只调用`M2.validateNoPreparedHandleProofV1`，ManualStop只调用`M2.validateNoPreparedHandleProofV1`或`M2.validateMechanicallyCancelledUnreleasedHandleProofV1`。M4不得读取proof fields后自行判定、延长lease或把proof持久化。available package refs必须逐项匹配M1 raw payload refs与target scope；opaque raw/receipt/ledger严格省略available-only authority字段且pending refs为空。M4返回完整`M1.OperationCommitResultV1<T>`；nonautomatic M2 authorization保持把result中的`receipt + operationPostState`交F26并匹配同一handle commitment。automatic M2必须在complete type-9 result后保持该handle prepared，立即调用独立pre-release K8；K8 success后才把complete result + `operationPostState`交F27并执行exact authorization/release once，随后K9；K8 failure则mechanical cancel，F27/authorization/release calls=0，再K9/zeroize。A5只读恢复complete result，不能据此生成新handle；detached receipt只可观察。

### 3.6 N/M 与 policy-authority version

- default N=2、default M=64；explicit 2/64 与 default 在 policy digest 中等价；
- `defaultSemanticsVersion=1`，改变默认或等价规则必须提升版本；
- N 只计 incomplete child；M 只计 committed model assistant；shell、semantic dispatch、physical request 不计；
- M4 operations 1/2/9不读mutable config object，也不信caller boolean；函数签名直接使用`M6.RecoveryPolicyAuthorityExpectation`，receipt/input直接使用M1/M6 owner-exported historical policy authority type。M4不声明policy alias、SQL schema、publish/read algorithm或snapshot shape。

M6唯一拥有policy table/SQL、publish/read接口及exact error types；本文只引用owner-qualified `M6.publishRecoveryPolicyAuthority`、`M6.readRecoveryPolicyAuthority`与`M6.readRecoveryPolicyAuthorityInTransaction`的pre/post，闭合M4 integration obligations：

- **Owner/callers/callee post**：M6 config reload负责publish，M6 new-lineage sequencing负责standalone read；A3仅first-apply operations 1/2/9调用owner-qualified tx verifier。M6 post必须保证row已commit后才公开runtime snapshot、epoch单调、same epoch=same normalized bytes/digest；M1 exported normalizer/digest保证default N=2/M=64与explicit 2/64等价。
- **M4 pre/workflow**：A3 exact replay branch在任何owner-qualified policy call之前完成；missing operation才把input/receipt historical `scopeKey/epoch/policyDigest/defaultSemanticsVersion`交tx verifier。verifier在A3 existing tx内exact读取、重算digest/default semantics并比较，不begin/nest、不读取runtime config、不重试到新epoch；成功normalized policy只允许读取transaction-verified committed `normalizedPolicy.digestInput.effectiveMaxModelAssistants`并结合fold重算M/N；不得访问不存在的top-level field，不得再次从configured值、provenance、runtime config或runtime agent steps重读/重算effective M。
- **All errors/rollback**：M6 publish/read的invalid/CAS/DB错误沿其exported error union处理，M4不翻译成成功或partial snapshot；tx verifier missing/corrupt/stale映射`RecoveryPolicyAuthorityStale`并由A3 rollback first apply。已提交operation receipt的historical values由A4 operation-prefix验证，不因current policy/budget改变失去replay资格。
- **Post/side effects/invariants**：M4不写policy row、不swap runtime snapshot；tx verifier只有tx-local read/canonical bytes，资源随A3 tx释放；无session/EventTable/provider/tool/listener/public publication。由此保持policy version、N=2/M=64、commit-before-runtime-publication与replay-before-current-policy。
- **Termination**：M4 tx verifier一次有限row read，无loop；M6 publish/read的retry/termination服从其owner contract，本文不重述。
- **Test IDs**：T-POLICY-001..018（M4部分只覆盖tx verifier与A3交互；M6 owner tests不在本文重复定义）。

same epoch必须same normalized policy/digest；policy change使未提交initial/ordinary/automatic candidate stale，但不撤销已提交receipt。A3 first-application从M6 tx verifier返回的**当前已commit** `M1.NormalizedRecoveryPolicy`取`effectiveM := normalizedPolicy.digestInput.effectiveMaxModelAssistants`，不得从configured M、runtime `agent.steps`或caller snapshot再次取min；再从same-tx fold重算`committedAssistantCountBefore`与candidate sequence，并仅以`candidateAssistantSequence < effectiveM`执行M，automatic另执行N。receipt/post-state中的`effectiveMaxModelAssistants`必须exact等于该committed `effectiveM`；因此default M=64不是caller precondition而是transactional authority check。

### 3.7 全局不变量

M4-I1. Raw-first：只有 recognized canonical raw envelope 能创造 recovery fact。

M4-I2. Atomicity：C1的session+dedicated pair+owner map由parent session-creation tx全有或全无；A3一次operation的parent raw/receipt、payload-rooted pending seals、七materialization delta、三个relevant heads、recovery cursor同tx；K4/K5 maintenance raw/receipt/sealed row/sealed cursor同tx。

M4-I3. First apply = exactly one：C1 owner/cursor inserts、A3 raw anchor与每个预期singleton insert/CAS、K2每个pending row、K4/K5 raw/row/cursor都必须`RETURNING`恰好一行；零行不是首次成功。

M4-I4. Exact replay：same `(aggregateID,operationID)`、same operation family/full input/payload digest、same historical operation-prefix fold/immutable receipt，以及独立验证的same full current prefix/fold全部成立才no-op；replay lookup先于current policy/N/M/key/resource check。

M4-I5. No direct mutation：C1只创建session owner map与两个empty cursors；A3（含K2）只写recovery operation/七表/三head/payload-rooted initial sealed rows；K4/K5只写sealed maintenance raw/cursor与目标row；MIG1/R1/K6仅按各自显式allowlist。其它模块不得直接写这些对象。

M4-I6. Snapshot consistency：owner pair、raw high-water/event chain、七materializations（含append-only projection history/current view）、三heads、source/control versions来自同一read transaction。

M4-I7. Publication isolation：internal definition 永不进入 public manifest/listener/bridge/SSE/sync。

M4-I8. Rebuild silence：rebuild 不调用 live publish/listener/bridge/sync，也不伪造 internal live event。

M4-I9. Secret minimization：plaintext/KEK/DEK/raw handle 不进入 raw、receipt、materialization、head、projection、log、sync/SSE。

M4-I10. Supersession-first：new input 在 old source supersession winner 决议前只能是 non-authoritative/unreleased candidate。

M4-I11. ManualStop order：若存在 unreleased handle，M2 mechanical cancel happens-before M4 ManualStop commit；commit failure 也不恢复 send closure。

M4-I12. Sealed-use lease与automatic授权顺序：任何automatic unseal/lowering/preparation之前已有绑定M1 exact key的live lease；A3 type-9 first apply保留commit-time K8并在cursor前验证same lease。complete type-9 result返回后，同一handle必须继续prepared并立即执行独立pre-release K8；F27与M2 authorization/release严格happens-after该K8 success，release恰一次后K9。pre-release K8 failure固定prepared→mechanically-cancelled，F27/M2 authorization/release calls=0，再K9 close/zeroize。K4/K5与live lease冲突；lease只live→closed、无TTL复活，所有M4-owned plaintext/material buffers在release/cancel/abandon/cleanup退出清零，redaction finality不被cleanup逆转。

## 4. 数据结构与 SQL ownership

### 4.1 `event_sequence` / `EventTable` 扩展

`event_sequence` 增加：

| 列 | SQLite | 语义 |
|---|---|---|
| `event_chain_digest` | TEXT nullable | 仅`session-recovery`/`session-recovery-sealed`必填；分别是M1/M4 domain-separated internal chain high-water；`public-generic`保持null/legacy owner contract |
| `event_chain_version` | INTEGER nullable | 仅两个dedicated internal aggregate固定1；`public-generic`不被M4强加recovery chain version |
| `owner_session_id` | TEXT nullable | session-owned recovery/sealed aggregate必填，FK `session(id) ON DELETE CASCADE`；public/non-session aggregate可null |
| `aggregate_kind` | TEXT NOT NULL default `public-generic` | CHECK `public-generic\|session-recovery\|session-recovery-sealed`；kind一经创建不可变 |

Dedicated internal empty-cursor representation固定为：existing high-water `sequence`列允许且仅允许在`aggregate_kind IN ('session-recovery','session-recovery-sealed')`时为`NULL`；`sequence=NULL`表示零raw rows，`event_chain_digest`已存对应domain genesis，version=1。first-event reservation必须`UPDATE event_sequence SET sequence=0,event_chain_digest=:event0Digest WHERE aggregate_id=:id AND sequence IS NULL AND event_chain_digest=:exactGenesis RETURNING aggregate_id`恰好一row；subsequent reservation使用`sequence=:expected`→`expected+1`。public-generic high-water/nullability继续服从其existing owner schema，M4不改变其语义。

`event` 增加：

| 列 | SQLite | Null | 语义 |
|---|---|---:|---|
| `publication` | TEXT | 否 | `public\|internal`，值只能从 source definition 派生 |
| `operation_id` | TEXT | 是 | recovery/sealed operation 必填 |
| `operation_family` | TEXT | 是 | `m1-recovery-v1\|m4-sealed-v1` |
| `operation_type` | TEXT | 是 | closed type discriminator |
| `field_set_version` | INTEGER | 是 | operation row 固定 1 |
| `payload_digest` | TEXT JSON | 是 | branded digest encoded value |
| `previous_event_digest` | TEXT JSON | 是 | aggregate genesis或前一 digest |
| `event_chain_digest` | TEXT JSON | 是 | recovery/sealed internal operation必填；public-generic row由其既有owner contract决定，M4不回填/解释 |
| `receipt` | TEXT JSON | 是 | internal operation的exact immutable authority receipt；不含ephemeral `applyMode` |
| `post_state_digest` | TEXT JSON | 是 | internal operation在其operation sequence处的fold commitment |
| `authority_row_digest` | TEXT JSON | 是 | recovery/sealed internal operation必填的§3.2 `m4-authority-row-v1`；public-generic row不由M4添加该digest |

约束/index：

- `event_aggregate_operation_idx` unique partial `(aggregate_id,operation_id) WHERE operation_id IS NOT NULL`；
- `event_aggregate_payload_digest_idx` non-unique `(aggregate_id,payload_digest) WHERE payload_digest IS NOT NULL`；
- `event_aggregate_chain_digest_idx` unique partial `(aggregate_id,event_chain_digest) WHERE event_chain_digest IS NOT NULL`；
- `event_aggregate_authority_row_digest_idx` unique partial `(aggregate_id,authority_row_digest) WHERE authority_row_digest IS NOT NULL`；
- 保留`event_aggregate_seq_idx` unique `(aggregate_id,seq)`与existing PK/type indexes；所有materialization raw FK精确为`(aggregate_id,event_seq) -> event(aggregate_id,seq)`；
- final CHECK：`publication IN ('public','internal')`；operation family null iff operation_id/type/field_set/payload/receipt/post-state all null；non-null family必须`IN ('m1-recovery-v1','m4-sealed-v1')`且publication=`internal`、其余operation columns与event/authority digests全非空、field_set_version=1；public-generic/legacy row允许operation/event-chain/authority-row字段全null；
- recovery/sealed operation的family/type/version/digests/receipt/post-state全必填；legacy/public-generic rows保持其owner schema，不得被迁移为recovery operation或被迫获得M4 chain/digest；
- recovery authority lookup的API key必须直接使用M1 `RecoveryOperationLookupKeyV1<T>`，其exact scope为`sessionID,aggregateID,operationID,expectedOperationType`：M4先验证session↔aggregate committed owner mapping并产生/验证`M4RecoveryAggregateOwnerMappingProofV1`，SQL再使用`(aggregate_id,operation_id)`并比较decoded kind；禁止M4自造结构等价key、全局`operation_id` lookup、省略session owner expectation或把wrong-kind row当命中；
- `authority_row_digest`按§3.2 exact domain覆盖internal encoded envelope/receipt、post-state、publication与row identity；A2/A4/S1/R1/MIG1只对dedicated internal rows重算，不允许只检查格式或信任stored digest；generic public EventTable writer/migration digest不属于M4 contract。

### 4.2 Aggregate ownership metadata与七个materialization

`session_recovery_aggregate_owner(session_id TEXT PRIMARY KEY REFERENCES session(id) ON DELETE CASCADE, recovery_aggregate_id TEXT NOT NULL UNIQUE REFERENCES event_sequence(aggregate_id) ON DELETE CASCADE, sealed_aggregate_id TEXT NOT NULL UNIQUE REFERENCES event_sequence(aggregate_id) ON DELETE CASCADE, schema_version INTEGER NOT NULL CHECK(schema_version=1), CHECK(recovery_aggregate_id<>sealed_aggregate_id))` 是ownership metadata，不是raw-derived recovery materialization。固定triggers `recovery_owner_cross_role_insert`/`recovery_owner_cross_role_update` 在同一SQLite writer lock下拒绝任一new recovery/sealed ID出现在该表任一role列中；因此跨row、跨role全局不相交由数据库执行，不只靠application precheck。每个session恰有一个**dedicated** recovery aggregate与一个**dedicated** sealed aggregate；二者不能跨session复用，也都必须与legacy/public session aggregate及所有`public-generic` aggregate不同。对应`event_sequence` rows必须分别为`owner_session_id=sessionID, aggregate_kind='session-recovery'|'session-recovery-sealed'`。A3/S1/R1/K2/K4/K5/K6/MIG1都以M1 `aggregateID` selector验证双向mapping，generic EventTable writer不能创建、删除或复用该mapping。session delete通过`event_sequence.owner_session_id ON DELETE CASCADE`删除两个aggregate及EventTable rows，同时删除owner/derived/sealed child rows。

#### 4.2.1 C1 `createSessionRecoveryAggregateOwner`

```ts
export function createSessionRecoveryAggregateOwner(
  tx: SessionOwner.SessionCreationImmediateTransaction,
  input: Readonly<{
    session: SessionOwner.SessionCreationInput
    publicSessionAggregateID: SessionOwner.PublicSessionAggregateID
    recoveryAggregateID: M1.RecoveryAggregateID
    sealedAggregateID: M4.SealedAggregateID
  }>,
): Effect.Effect<M4.SessionRecoveryAggregateOwnerPreparedV1, M4.SessionRecoveryOwnerCreationErrorV1>
```

- **Owner/落点/Callers**：M4提供transaction-local helper，existing session-creation owner是唯一caller；它必须在创建session的同一parent immediate transaction内调用。generic EventTable API与post-hoc repair API不可调用。
- **Callees contracts**：SessionOwner exact session insert/identity validator；event-sequence exactly-one insert helper；M1 `buildEventChainDigestInput`+registered `event-chain-v1` digest builder；M4 sealed genesis builder；owner-row exact codec；FK/unique readback。recovery genesis必须逐字构造`M1.EventChainDigestInputV1` `{kind:"aggregate-genesis",hashVersion:1,aggregateID:recoveryAggregateID}`并得到`M1.EventChainDigest`/`AdmissionPlan["expectedHeads"]["aggregateEventHead"](kind:"genesis")`；`aggregateKind`与`ownerSessionID`只存owner metadata并受owner-row/schema digest覆盖，绝不进入M1 EventChainDigest。sealed genesis独立使用M4 `m4-sealed-aggregate-genesis-v1` exact input `{version:1,aggregateID:sealedAggregateID,aggregateKind:"session-recovery-sealed",ownerSessionID}`；public aggregate没有M4 genesis digest。
- **Requires**：tx active且由session creation拥有；session input strict；三个aggregate ID pairwise distinct；recovery/sealed IDs不存在于任意event_sequence/owner row，public ID不得已有internal kind；函数禁止begin/commit并禁止publish。
- **Workflow/branches**：验证IDs/kinds→调用SessionOwner在parent tx内insert session exactly one→按recovery后sealed固定顺序insert两个`event_sequence` genesis rows（high-water为空、各自genesis digest/version=1）→insert owner map exactly one→双向readback session/两个sequence/owner→返回`M4.SessionRecoveryAggregateOwnerPreparedV1`（只证明parent tx内四个inserts可见，绝不声称committed）；任一existing ID/mapping、0/多row或readback差异都抛typed error给parent。
- **All errors/rollback/replay**：duplicate session/ID、recovery=sealed/public、kind冲突、FK/DB/readback failure全部使**整个session creation transaction** rollback；外部不可见session-only、single-sequence或owner-only partial state。该函数没有same-ID replay branch；session creation operation的幂等性由SessionOwner parent contract处理，parent exact replay不得再次调用C1写row。
- **Post**：C1成功返回时只保证四个insert在parent tx内exact可见；SessionOwner随后commit成功才使session恰有一对dedicated aggregates与一条owner map并可对外返回committed session。若parent在C1返回后commit失败/unknown，外部不得使用prepared value，必须按SessionOwner exact creation lookup处理；recovery aggregate只能含M1 internal recovery rows，sealed aggregate只能含M4 maintenance rows，legacy/public aggregate永不混链。Committed empty recovery cursor的exact M1 genesis是后续§7.0 fresh initial authority view的current aggregate head；它不是incomplete source、`M1.DurableRecoverySnapshot`或no-source snapshot，且C1此时没有policy/user/candidate/handle proof可供admission。
- **Side effects/resource lifecycle**：仅parent tx内四个inserts（session 1 + event_sequence 2 + owner 1）与local canonical bytes；prepared value随parent tx结束失效；无EventTable event row、七表/三head/seal、runtime handle、listener/provider/keyring或durable C1 receipt。
- **Invariants**：建立I1/M4-I5/M4-I6/I7所依赖的owner边界与dedicated-chain genesis；pairwise uniqueness和single tx建立no mixed legacy/recovery chain与no partial mapping。
- **Termination**：固定四次exactly-one insert与有限readback，无循环；busy/retry及最终commit由parent session-creation contract有界管理。
- **Test IDs**：T-C1-001..012。

#### 4.2.2 Legacy assistant/message materialization与七个recovery materialization

operations 1/2/9还必须在A3同一transaction内写existing Legacy Session owner的assistant info/message row及parent relation所需字段；这些public rows不是第八个recovery authority表，M1 raw operation仍是唯一rebuild authority。M4不复制或改写Legacy table schema：它调用Session owner transaction-local exact inserter，并逐字段传入M1 `OperationSchemaByTypeV1["initial-chain-genesis-and-dispatch"]["payload"]["assistantMessage"]`。每个assistant compatibility materialization的per-event ordinal固定为其raw `aggregateSequence`，schema/version/role/message identity/parent relation/createdAtMs全部来自该M1 genesis exact codec；禁止用table max、wall clock、public event ordinal或insert order派生。type-1先通过Session owner read helper验证existing user-message predecessor的session/id/role/digest，禁止insert、upsert、repair、silent recreation或把user row再次投影成新的per-event row；因此user compatibility事实是“validated pre-existing predecessor”，assistant compatibility事实才是“raw-sequence anchored materialization”。Legacy assistant row、recovery relation/ledger/heads/raw receipt全在A3 transaction中all-or-nothing，任一Session owner validation/FK/unique failure整体rollback。A4/S1 same-tx readback逐字段验证assistant row及user predecessor；R1从validated M1 raw按同一aggregateSequence/schema重建missing assistant rows并验证existing user predecessor，different-existing row fatal且不覆盖；MIG1不从legacy rows反向制造raw/ordinal。session delete沿existing Session-owned `ON DELETE CASCADE`与recovery owner cascade删除两侧。

七个recovery materialization exact SQL schema固定为：

1. `session_recovery_relation(session_id TEXT NOT NULL, aggregate_id TEXT NOT NULL, chain_id TEXT NOT NULL, assistant_id TEXT NOT NULL, assistant_sequence INTEGER NOT NULL CHECK(assistant_sequence>=0), recovery_ordinal INTEGER NOT NULL CHECK(recovery_ordinal>=0), parent_assistant_id TEXT, relation_kind TEXT NOT NULL CHECK(relation_kind IN ('initial','ordinary','automatic-child')), operation_id TEXT NOT NULL, event_seq INTEGER NOT NULL, relation_digest TEXT NOT NULL, PRIMARY KEY(session_id,assistant_id), UNIQUE(session_id,chain_id,assistant_sequence), UNIQUE(aggregate_id,operation_id), UNIQUE(aggregate_id,event_seq), FOREIGN KEY(session_id) REFERENCES session(id) ON DELETE CASCADE, FOREIGN KEY(aggregate_id,event_seq) REFERENCES event(aggregate_id,seq) ON DELETE CASCADE)`；
2. `session_recovery_dispatch_ledger(session_id TEXT NOT NULL, aggregate_id TEXT NOT NULL, assistant_id TEXT NOT NULL, dispatch_ordinal INTEGER NOT NULL CHECK(dispatch_ordinal>=0), operation_id TEXT NOT NULL, event_seq INTEGER NOT NULL, evidence_kind TEXT NOT NULL CHECK(evidence_kind IN ('available','opaque')), dispatch_kind TEXT NOT NULL CHECK(dispatch_kind IN ('initial','ordinary','subsequent','automatic-child')), target_json TEXT, target_digest TEXT, storage_mode TEXT CHECK(storage_mode IN ('true','false','unknown')), semantic_digest TEXT, prepared_digest TEXT, paused_handle_commitment TEXT NOT NULL, replay_fence TEXT, capabilities TEXT, authorization_commitment TEXT, sealed_refs TEXT NOT NULL, opaque_cause TEXT, ledger_digest TEXT NOT NULL, PRIMARY KEY(session_id,assistant_id,dispatch_ordinal), UNIQUE(aggregate_id,operation_id), UNIQUE(aggregate_id,event_seq,assistant_id,dispatch_ordinal), FOREIGN KEY(session_id,assistant_id) REFERENCES session_recovery_relation(session_id,assistant_id) ON DELETE CASCADE, FOREIGN KEY(aggregate_id,event_seq) REFERENCES event(aggregate_id,seq) ON DELETE CASCADE)`；application exact CHECK：available时target/target_digest/storage/semantic/prepared/replay/capabilities/authorization全非空、opaque_cause空；opaque时这些available-only列全空、opaque_cause非空、sealed_refs canonical `[]`。opaque private preparation facts只在M2 handle/package中用于commit前handshake，不进入raw/materialization/receipt/projection；same-handle验证依靠paused commitment与M2 runtime proof。
3. `session_recovery_tool(session_id TEXT NOT NULL, aggregate_id TEXT NOT NULL, assistant_id TEXT NOT NULL, call_ordinal INTEGER NOT NULL CHECK(call_ordinal>=0), tool_call_id TEXT NOT NULL, evidence_seq INTEGER NOT NULL, name TEXT NOT NULL, execution_kind TEXT NOT NULL CHECK(execution_kind IN ('local','provider','unknown')), input_state TEXT NOT NULL CHECK(input_state IN ('open','complete','unknown')), call_observation TEXT NOT NULL CHECK(call_observation IN ('durable','not-observed','unknown')), settlement TEXT NOT NULL CHECK(settlement IN ('pending','running','completed','error')), interruption TEXT NOT NULL CHECK(interruption IN ('none','execution-interrupted','provider-result-missing','unknown')), provider_executed TEXT NOT NULL CHECK(provider_executed IN ('true','false','unknown')), plan_revision INTEGER NOT NULL CHECK(plan_revision>=0), phase_json TEXT NOT NULL, arguments_payload_json TEXT, terminal_payload_json TEXT, final_plan_digest TEXT, call_digest TEXT, result_digest TEXT, source_first_seq INTEGER NOT NULL CHECK(source_first_seq>=0), source_last_seq INTEGER NOT NULL CHECK(source_last_seq>=source_first_seq), source_field_set_version INTEGER NOT NULL CHECK(source_field_set_version=1), authority_class TEXT NOT NULL CHECK(authority_class='authoritative-source-v1'), fact_digest TEXT NOT NULL, operation_id TEXT NOT NULL, PRIMARY KEY(session_id,assistant_id,call_ordinal,evidence_seq), UNIQUE(session_id,assistant_id,tool_call_id,evidence_seq), UNIQUE(aggregate_id,evidence_seq,call_ordinal), FOREIGN KEY(session_id,assistant_id) REFERENCES session_recovery_relation(session_id,assistant_id) ON DELETE CASCADE, FOREIGN KEY(aggregate_id,evidence_seq) REFERENCES event(aggregate_id,seq) ON DELETE CASCADE)`；该表逐字段保存M1 `AuthoritativeToolEvidenceV1`，包括exact `callOrdinal`、`ToolExecutionPhaseV1`、ordered arguments carrier、result/error discriminator+carrier、`finalPlanDigest/callDigest/resultDigest`与source range。`phase_json`只能是M1五branch exact codec；`arguments_payload_json/terminal_payload_json`只能是M1 `RecoveryReplayPayloadV1`/`ToolTerminalReplayPayloadV1` exact canonical encoding：inline只允许已判定非敏感的canonical value，任何敏感、provider原始或可能含secret的bytes必须先K1封存并只保存purpose-exact sealed ref。row不得保存raw arguments/result/error bytes，也不得从digest、Legacy part、current message/history或provider cache补carrier。`authority_class`只陈述这是raw source authority，不等于automatic eligibility；automatic proof只可由S1在完整M1 partition、phase、carrier materialization与snapshot identity验证后临时构造。
4. `session_recovery_reasoning(session_id TEXT NOT NULL, aggregate_id TEXT NOT NULL, assistant_id TEXT NOT NULL, reasoning_id TEXT NOT NULL, evidence_seq INTEGER NOT NULL, provenance TEXT NOT NULL CHECK(provenance IN ('provider-end','step-boundary-forced-flush','cleanup-forced-flush','unknown')), continuation_mode TEXT NOT NULL CHECK(continuation_mode IN ('none','signed','stored-reference','unknown')), protocol TEXT NOT NULL, target_digest TEXT NOT NULL, content_payload_json TEXT, text_digest TEXT, state_refs TEXT NOT NULL, public_metadata_json TEXT NOT NULL, source_first_seq INTEGER NOT NULL CHECK(source_first_seq>=0), source_last_seq INTEGER NOT NULL CHECK(source_last_seq>=source_first_seq), source_field_set_version INTEGER NOT NULL CHECK(source_field_set_version=1), authority_class TEXT NOT NULL CHECK(authority_class='authoritative-source-v1'), fact_digest TEXT NOT NULL, operation_id TEXT NOT NULL, PRIMARY KEY(session_id,assistant_id,reasoning_id,evidence_seq), UNIQUE(aggregate_id,evidence_seq,reasoning_id), FOREIGN KEY(session_id,assistant_id) REFERENCES session_recovery_relation(session_id,assistant_id) ON DELETE CASCADE, FOREIGN KEY(aggregate_id,evidence_seq) REFERENCES event(aggregate_id,seq) ON DELETE CASCADE)`；列逐字段保存M1 `ReasoningEvidence`，特别是完整`provenance/continuationMode/protocol/targetDigest/content/textDigest/stateRefs/publicMetadata/sourceRange`。`content_payload_json`是M1 `RecoveryReplayPayloadV1 & {valueKind:"utf8-text"}` exact carrier；敏感reasoning text必须sealed为purpose `reasoning-content`，raw text禁止进入raw/materialization/public row。`signed|stored-reference`仍只配`provider-end`，forced flush只配`none`；unknown/forced evidence可作为authoritative source fact保留，但不自动eligible。provider-prefix不新建第八recovery materialization：operation 6 raw payload必须完整保存M1 `OperationSchemaByTypeV1["provider-prefix-recorded"]["payload"]["checkpoint"]["content"]` carrier、prefix/ancestry commitments、protocol/target/source identity和sealed refs；A2/S1/A4/R1从raw重放并逐项read-back。terminal facts同样从raw slice重建。
5. `session_recovery_decision(session_id TEXT NOT NULL, aggregate_id TEXT NOT NULL, source_assistant_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=0), decision_id TEXT NOT NULL, operation_id TEXT NOT NULL, event_seq INTEGER NOT NULL, created_at TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('finalized','consumed','superseded')), action TEXT NOT NULL CHECK(action IN ('manual-stop','safe-retry','continue-after-settled-tools')), reason_codes TEXT, binding_digest TEXT, supersession_binding_digest TEXT, source_version_digest TEXT NOT NULL, control_tail_digest TEXT NOT NULL, decision_digest TEXT NOT NULL, child_assistant_id TEXT, PRIMARY KEY(session_id,source_assistant_id,revision), UNIQUE(session_id,decision_id), UNIQUE(aggregate_id,operation_id), UNIQUE(aggregate_id,event_seq), FOREIGN KEY(session_id,source_assistant_id) REFERENCES session_recovery_relation(session_id,assistant_id) ON DELETE CASCADE, FOREIGN KEY(aggregate_id,event_seq) REFERENCES event(aggregate_id,seq) ON DELETE CASCADE)`；state/action/child/reason组合由M1 exact validator补强。`reason_codes`不是任意JSON：`state='finalized' AND action='manual-stop'`时必须non-null，先从raw decision binding中的exact lower-level causes调用M1 F23 `mapCausesToManualStopReasons`，再用M1 owner-exported `NonEmptyReadonlyArray<ManualStopReason>` ordered exact codec编码；decoded value必须逐项等于decision record reasons，顺序严格为M1固定24-tuple的子序列且dedup/nonempty。`state='superseded'`时使用M1 decision exact codec编码唯一singleton `['superseded-by-new-user-input']`，不得调用F23伪造cause；`state='consumed'`时`reason_codes IS NULL`。commitment columns同样closed：finalized/consumed使用`binding_digest`且`supersession_binding_digest IS NULL`；superseded使用`supersession_binding_digest`且`binding_digest IS NULL`，其值必须由payload persisted full `SupersessionBindingDigestInputV1`经M1 builder/F22重算，禁止cast为`BindingDigest`。decode/readback/R1必须按同一branch反向验证，禁止`JSON.parse`后set比较、SQL排序、caller-preordered reason或`[]`占位。operations 8–10必须由M1 canonical decision material、operation envelope/committed sequence及payload内source/proposal/child facts确定`decision_id/revision/created_at/state/action/reasons/branch commitment/source/control/child`全部字段；任何缺字段、DB clock/runtime clock、non-authoritative proposal object或existing projection补值均fail closed。
6. `session_recovery_consumption(session_id TEXT NOT NULL, aggregate_id TEXT NOT NULL, decision_id TEXT NOT NULL, decision_revision INTEGER NOT NULL, source_assistant_id TEXT NOT NULL, child_assistant_id TEXT NOT NULL, operation_id TEXT NOT NULL, event_seq INTEGER NOT NULL, consumption_digest TEXT NOT NULL, PRIMARY KEY(session_id,decision_id,decision_revision), UNIQUE(session_id,child_assistant_id), UNIQUE(aggregate_id,operation_id), FOREIGN KEY(session_id,source_assistant_id,decision_revision) REFERENCES session_recovery_decision(session_id,source_assistant_id,revision) ON DELETE CASCADE, FOREIGN KEY(session_id,child_assistant_id) REFERENCES session_recovery_relation(session_id,assistant_id) ON DELETE CASCADE, FOREIGN KEY(aggregate_id,event_seq) REFERENCES event(aggregate_id,seq) ON DELETE CASCADE)`；
7. `session_recovery_public_projection(session_id TEXT NOT NULL, aggregate_id TEXT NOT NULL, source_assistant_id TEXT NOT NULL, projection_version INTEGER NOT NULL CHECK(projection_version=1), projection_json TEXT NOT NULL, source_event_seq INTEGER NOT NULL, operation_id TEXT NOT NULL, projection_digest TEXT NOT NULL, PRIMARY KEY(session_id,source_assistant_id,source_event_seq), UNIQUE(aggregate_id,operation_id), UNIQUE(aggregate_id,source_event_seq,source_assistant_id), FOREIGN KEY(session_id,source_assistant_id) REFERENCES session_recovery_relation(session_id,assistant_id) ON DELETE CASCADE, FOREIGN KEY(aggregate_id,source_event_seq) REFERENCES event(aggregate_id,seq) ON DELETE CASCADE)`；每次projection变化只append，production无UPDATE/replace。`recovery_projection_current_idx(session_id,source_assistant_id,source_event_seq DESC)`支持current lookup；`session_recovery_public_projection_current`是按最大`source_event_seq`导出的非authority view，M8只可读该view/owner service而不读history raw。projection_json必须通过M1实际export的exact projection codec，不得以编号占位符、未export informal shape或alias替代。

#### 4.2.3 Tool/reasoning exact SQL literal mappings

M4拥有的是SQL literal mapping，不是假称M1导出SQL codec。实现固定导出`M4.ToolEvidenceSqlMappingV1`与`M4.ReasoningEvidenceSqlMappingV1`两个frozen mapping records；每个record含`mappingVersion:1`、对下表每个M1 domain的一张finite forward map及机械反演的reverse map。forward key set必须与M1 closed domain逐字相等，value set必须与对应SQL CHECK逐字相等，cardinality相等且无duplicate；module initialization若任一missing/extra/collision则fail closed。encode只接受M1 exact literal；decode只接受SQL CHECK中的literal；未知值、大小写变体、SDK/provider synonym、NULL均typed failure，不fallback到`unknown`。A2/A3/S1/R1/MIG1对每个stored literal执行`decode(encode(x))=x`与`encode(decode(sql))=sql`。

| M1 exact domain | Total/bijective v1 mapping to SQL |
|---|---|
| `M1.ToolExecutionKindV1` | `local→local`, `provider→provider`, `unknown→unknown` |
| `M1.ToolInputStateV1` | `open→open`, `complete→complete`, `unknown→unknown` |
| `M1.ToolCallObservationV1` | `durable→durable`, `not-observed→not-observed`, `unknown→unknown` |
| `M1.ToolSettlementV1` | `pending→pending`, `running→running`, `completed→completed`, `error→error` |
| `M1.ToolInterruptionV1` | `none→none`, `execution-interrupted→execution-interrupted`, `provider-result-missing→provider-result-missing`, `unknown→unknown` |
| `M1.ProviderExecutedStateV1` | `true→true`, `false→false`, `unknown→unknown`；SQL使用TEXT，禁止`1/0/NULL`近似 |
| `M1.ReasoningProvenanceV1` | `provider-end→provider-end`, `step-boundary-forced-flush→step-boundary-forced-flush`, `cleanup-forced-flush→cleanup-forced-flush`, `unknown→unknown` |
| `M1.ReasoningContinuationModeV1` | `none→none`, `signed→signed`, `stored-reference→stored-reference`, `unknown→unknown` |

Authority、compatibility与automatic proof严格三分：SQL mapping只保证M1 literal identity，不授予eligibility。A2只把raw operation 4中的`AuthoritativeToolEvidenceV1`与operation 5中的`ReasoningEvidence`写入七materializations；Legacy compatibility facts不写入这些raw-derived rows，也不进入source/control digest。S1在同一pinned WAL snapshot内另以M1 old-row decoder完整枚举Legacy compatibility parts，仅用于构造`CanonicalToolEvidencePartitionV1`；这些facts即使携带可读payload也不能成为replay source，M7绝不能读取Legacy history/message/current part。S1随后按partition cardinality与phase构造M4 nominal view：`truly-empty`才有SafeRetry slice；`authoritative-only`且每项`final-after-hook-settled`、carrier/commitment/material全部通过才有Continue slice；`compatibility-only`、`mixed`或任一authoritative非final/inconsistent phase只能是ManualStop。reasoning `provenance/continuation_mode/content carrier`逐值进入raw fold、row digest、read-back与R1 comparison；`ReasoningTextDigest`仍只由M1 `reasoning-text-v1` exact input验证。

#### 4.2.3a Durable tool phase与restart reconciliation

M4逐row持久化M1 `ToolExecutionPhaseV1` exact branch，不从settlement/UI state反推。合法append-only transition matrix固定为：

| previous durable phase | normal next | process-crash/restart next | body/after-hook side effect | terminal barrier | automatic eligibility |
|---|---|---|---|---|---|
| absent | `planned` | N/A | 仅M3在写`planned`前尚未调用body；row commit后M4不授权重跑 | open | forbidden |
| `planned` | `body-outcome-durable`（同process且body outcome已由M3明确取得） | `reconciled-terminal-manual-only`，`bodyState:"unknown",afterHookState:"unknown"` | restart reconciler调用body=0、after-hook=0 | reconciled后可close | ManualStop only |
| `body-outcome-durable` | `final-after-hook-settled`（同process且after-hook实际完成并先形成exact payload/commitments） | `reconciled-terminal-manual-only`，保留`bodyState`，`afterHookState:"unknown"` | restart reconciler不重跑body或after-hook | reconciled后可close | ManualStop only |
| `unknown-intermediate` | 无normal automatic transition | `reconciled-terminal-manual-only`，unknown/unknown | body=0、after-hook=0 | reconciled后可close | ManualStop only |
| `final-after-hook-settled` | terminal self replay only | unchanged | body=0、after-hook=0 | closed | Continue候选，仍需完整partition/carrier/snapshot proof |
| `reconciled-terminal-manual-only` | terminal self replay only | unchanged | body=0、after-hook=0 | closed | ManualStop only |

`planned` durable并不证明“安全可重跑”：M1已把`rerunBody/rerunAfterHook`固定为forbidden，process crash可能发生在外部side effect与下一durable boundary之间，因此restart一律append reconciled terminal-manual-only。reconciliation通过新的M1 type-4 `tool-evidence-recorded` raw operation追加同callOrdinal/callID的新source fact；旧row immutable，new sourceRange/phase由M1 exact codec验证。该transition不调用tool body、before/after hook、provider、M2或M7，不生成result/error payload；若body-outcome已有carrier/commitments则原样保留并重验但仍manual-only。O6 terminal barrier允许所有open calls已经是`final-after-hook-settled`或`reconciled-terminal-manual-only`时提交terminal；M5 automatic proof只接受前者，后者无论payload多完整都产生typed tool cause并ManualStop。

#### 4.2.4 Persisted derived-row/head digest registry

七表与三个head保留digest列，因此每一列都必须有唯一domain、exact input、builder与read-time recomputation；没有“仅格式检查”或信任stored digest的分支。所有input先把SQL literal经§4.2.3/M1 exact codec decode成owner logical value，optional字段必须omit而非`undefined`/`NULL`占位，array/object用owner canonical codec；digest字段自身、SQLite rowid、index/order、operational timestamp均不进入input。registry固定如下：

| Persisted column | Domain / builder | Exact V1 input（除`version:1`外列出全部字段） |
|---|---|---|
| relation.`relation_digest` | `m4-relation-row-v1` / `buildRelationRowDigestInput` | `sessionID,aggregateID,chainID,assistantID,assistantSequence,recoveryOrdinal,parentAssistantID?,relationKind,operationID,eventSequence` |
| dispatch.`ledger_digest` | `m4-dispatch-ledger-row-v1` / `buildDispatchLedgerRowDigestInput` | `sessionID,aggregateID,assistantID,dispatchOrdinal,operationID,eventSequence,evidenceKind,dispatchKind,target?,targetDigest?,storageMode?,semanticDigest?,preparedDigest?,pausedHandleCommitment,replayFence?,capabilities?,authorizationCommitment?,sealedRefs,opaqueCause?`；available/opaque字段presence按§4.2.2闭合 |
| tool.`fact_digest` | `m4-tool-row-v1` / `buildToolRowDigestInput` | `sessionID,aggregateID,assistantID,callOrdinal,toolCallID,evidenceSequence,name,executionKind,inputState,callObservation,settlement,interruption,providerExecuted,planRevision,phase,arguments?,terminalPayload?,finalPlanDigest?,callDigest?,resultDigest?,sourceRange,authorityClass,operationID`；payload字段是M1 exact carrier/projection，不是stored JSON text或raw bytes |
| reasoning.`fact_digest` | `m4-reasoning-row-v1` / `buildReasoningRowDigestInput` | `sessionID,aggregateID,assistantID,reasoningID,evidenceSequence,provenance,continuationMode,protocol,targetDigest,content?,textDigest?,stateRefs,publicMetadata,sourceRange,authorityClass,operationID`；content是M1 exact replay carrier |
| decision.`decision_digest` | `m4-decision-row-v1` / `buildDecisionRowDigestInput` | `sessionID,aggregateID,sourceAssistantID,revision,decisionID,operationID,eventSequence,createdAt,state,action,reasons?,bindingDigest?,supersessionBindingDigest?,sourceVersionDigest,controlTailDigest,childAssistantID?`；commitment optional fields按decision branch互斥；`reasons?`只能来自§4.2.2的M1 F23/decision codec branch |
| consumption.`consumption_digest` | `m4-consumption-row-v1` / `buildConsumptionRowDigestInput` | `sessionID,aggregateID,decisionID,decisionRevision,sourceAssistantID,childAssistantID,operationID,eventSequence` |
| projection.`projection_digest` | `m4-public-projection-row-v1` / `buildPublicProjectionRowDigestInput` | `sessionID,aggregateID,sourceAssistantID,projectionVersion,projection,sourceEventSequence,operationID`；`projection`是M1 exact decoded `RecoveryPublicProjectionV1`，不是stored JSON text |
| assistant chain.`state_digest` | `m4-assistant-chain-head-v1` / `buildAssistantChainHeadDigestInput` | `sessionID,aggregateID,chainID,assistantID,assistantSequence,recoveryOrdinal,eventSequence,operationID` |
| dispatch ledger.`state_digest` | `m4-dispatch-ledger-head-v1` / `buildDispatchLedgerHeadDigestInput` | `sessionID,aggregateID,assistantID,dispatchOrdinal,eventSequence,operationID` |
| recovery.`state_digest` | `m4-recovery-head-v1` / `buildRecoveryHeadDigestInput` | `sessionID,aggregateID,sourceAssistantID,revision,decisionID,eventSequence,operationID` |
| event.`post_state_digest` for M1 recovery | `m4-recovery-operation-post-state-v1` / `buildRecoveryOperationPostStateDigestInput` | `aggregateID,aggregateSequence,operationID,operationType,operationPostState`；post-state必须是M1 `OperationPostStateForV1<T>` exact codec value |
| event.`post_state_digest` for M4 sealed maintenance | `m4-sealed-operation-post-state-v1` / `buildSealedOperationPostStateDigestInput` | `aggregateID,aggregateSequence,operationID,operationType,recoveryCreationHighWater,sealedAggregateHead,rowsByRefID`；map按refID binary order编码，time columns排除 |
| sealed-use-lease.`lease_key_digest` | `m4-sealed-use-lease-key-v1` / `buildSealedUseLeaseKeyDigestInput` | exact single member `key:M1.SealedRecoveryUseLeaseKeyInputV1`；递归绑定ref/generation/material/scope/purpose/source/action/operation/session/target/prepared-handle commitment |
| sealed-use-lease.`row_digest` | `m4-sealed-use-lease-row-v1` / `buildSealedUseLeaseRowDigestInput` | `leaseID,leaseKeyDigest,snapshotIdentity,closureBinding,ownerProcessInstanceID,state,closeReason?,acquiredAtOperationID,closedByOperationID?`；closure binding按action是safe-retry exact not-needed或Continue exact sourceBinding+M1 closureDigest；time columns排除，live/closed presence closed |

reconstructible carrier有额外的双重read-back registry，不能被row digest替代：tool arguments/result/error分别按M1 `tool-plan-v1/tool-result-v1` owner builder与`finalPlanDigest/resultDigest`重算，call literals按`tool-call-v1`与`callDigest`重算；reasoning content按`reasoning-text-v1`重算；provider-prefix content按`provider-prefix-v1`且ancestry按`provider-prefix-ancestry-v1`重算。outer tool order固定`callOrdinal`，同call transition order固定raw `aggregateSequence`，result/error discriminator、array order、sourceRange与phase均逐项比较。inline carrierstrict decode后canonical re-encode byte-equal；sealed carrier必须验证ref purpose/scope/keyed material commitment/current generation，并通过live M4 sealed-use lease后unseal、strict decode/re-encode，再使用secret-safe projection重算owner commitment。任何carrier缺失、digest-only、order变化、duplicate key/trailing bytes、sealed metadata或snapshot identity不一致均fail closed。raw/SQL/public rows永不保存unsealed bytes；M7只从snapshot-bound nominal Continue proof中的carrier构造M1 `RecoveryClosureDescriptor`，并调用owner-exported `buildRecoveryClosureDigestInput`与`recovery-closure-v1` spec重算`RecoveryClosureDigest`：exact input绑定`version,action,sourceBinding,toolCalls,reasoning,providerPrefix`及全部carrier/commitment/order，禁止Legacy history/current message/provider cache补值。type-9 raw/admission/receipt readback必须把该descriptor/digest与slice snapshot identity及prepared request逐字段比较；closure digest不是carrier替代品。

每个domain在M4 private canonical registry中恰有一个frozen exact specification与同名builder，输出是domain-validated `M1.CanonicalDigestValue`；domain string是canonical preimage prefix，跨列digest不得cast/substitute。A3 first apply从transaction-local A2/K0 logical candidate调用builder后insert；同tx readback必须重新decode每个physical row、重建input、重算并constant-time比较，再逐字段比较candidate。A4/A5/S1/K0a/K3/R1/MIG1读取各自覆盖的完整row/head set时执行同一规则；K7–K10对lease rows执行同一规则；R1先从raw fold构造expected input，再重算existing rows以识别foreign/corrupt，重建row仍用同一builder。任何missing/extra/unknown codec/domain、stored digest mismatch或“digest相等但logical field不同”均`replay-inconsistent`，不得自动补digest。若future删除任一digest列，必须同一schema revision删除本registry entry、writer/readback/rebuild comparison与index；禁止留下不参与验证的冗余commitment。

Fixed secondary index names：`recovery_relation_parent_idx(session_id,parent_assistant_id)`、`recovery_dispatch_event_idx(aggregate_id,event_seq)`、`recovery_tool_current_idx(session_id,assistant_id,tool_call_id,evidence_seq DESC)`、`recovery_reasoning_current_idx(session_id,assistant_id,reasoning_id,evidence_seq DESC)`、`recovery_decision_current_idx(session_id,source_assistant_id,revision DESC)`、`recovery_consumption_source_idx(session_id,source_assistant_id)`、`recovery_projection_event_idx(aggregate_id,source_event_seq)`、`recovery_projection_current_idx(session_id,source_assistant_id,source_event_seq DESC)`。PK/UNIQUE、current view与index definitions都由schema digest覆盖。

所有表：

- session-owned FK `ON DELETE CASCADE`；
- raw reference FK `(aggregate_id,event_seq)->event(aggregate_id,seq) ON DELETE CASCADE`；
- write only by `applyRecoveryOperation`, rebuild, migration initialization or session cascade；
- row digest 是 canonical row commitment，不替代逐字段 fold comparison。

M1 operations 6/7 的 `providerPrefix`/`incompleteTerminal` exact materialization result 是 raw-fold slice，不要求独立 SQL table；snapshot/replay/rebuild必须从完整 raw prefix计算并验证，不能因无单表而跳过。

### 4.3 三个 recovery head

```sql
CREATE TABLE recovery_head(
  session_id TEXT NOT NULL, aggregate_id TEXT NOT NULL, source_assistant_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>=0), decision_id TEXT NOT NULL,
  event_seq INTEGER NOT NULL, operation_id TEXT NOT NULL, state_digest TEXT NOT NULL,
  PRIMARY KEY(session_id,source_assistant_id),
  FOREIGN KEY(session_id) REFERENCES session(id) ON DELETE CASCADE,
  FOREIGN KEY(aggregate_id,event_seq) REFERENCES event(aggregate_id,seq) ON DELETE CASCADE
);
CREATE TABLE assistant_chain_head(
  session_id TEXT NOT NULL, aggregate_id TEXT NOT NULL, chain_id TEXT NOT NULL,
  assistant_id TEXT NOT NULL, assistant_sequence INTEGER NOT NULL CHECK(assistant_sequence>=0),
  recovery_ordinal INTEGER NOT NULL CHECK(recovery_ordinal>=0), event_seq INTEGER NOT NULL,
  operation_id TEXT NOT NULL, state_digest TEXT NOT NULL,
  PRIMARY KEY(session_id,chain_id),
  FOREIGN KEY(session_id) REFERENCES session(id) ON DELETE CASCADE,
  FOREIGN KEY(aggregate_id,event_seq) REFERENCES event(aggregate_id,seq) ON DELETE CASCADE
);
CREATE TABLE dispatch_ledger_head(
  session_id TEXT NOT NULL, aggregate_id TEXT NOT NULL, assistant_id TEXT NOT NULL,
  dispatch_ordinal INTEGER NOT NULL CHECK(dispatch_ordinal>=0), event_seq INTEGER NOT NULL,
  operation_id TEXT NOT NULL, state_digest TEXT NOT NULL,
  PRIMARY KEY(session_id,assistant_id),
  FOREIGN KEY(session_id) REFERENCES session(id) ON DELETE CASCADE,
  FOREIGN KEY(aggregate_id,event_seq) REFERENCES event(aggregate_id,seq) ON DELETE CASCADE
);
```

- genesis insert：`ON CONFLICT DO NOTHING RETURNING` 恰好一行；
- update：`WHERE` 包含完整 expected predecessor，`RETURNING` 恰好一行；
- fixed write order：assistant chain → dispatch ledger → recovery；
- raw aggregate cursor先在 transaction 内 reservation，再写 raw/materializations/heads，commit 前 full read-back；外部不可见 reservation。

### 4.4 Sealed store 与 pending row

`M4.PendingSealV1`的唯一export与完整§3.1 contract见§3.1；本节不再声明第二份shape。K1/K2/A3签名必须直接使用该owner-qualified type。

```sql
CREATE TABLE sealed_recovery_material(
  ref_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  sealed_aggregate_id TEXT NOT NULL,
  creation_recovery_aggregate_id TEXT NOT NULL,
  creation_operation_id TEXT NOT NULL,
  creation_event_seq INTEGER NOT NULL CHECK(creation_event_seq>=0),
  assistant_id TEXT NOT NULL,
  target_digest TEXT NOT NULL,
  material_kind TEXT NOT NULL CHECK(material_kind IN ('idempotency-key','continuation-cursor','reasoning-signature','encrypted-reasoning','provider-state','tool-arguments','tool-result','tool-error','reasoning-content','provider-prefix-content')),
  key_version INTEGER NOT NULL CHECK(key_version>0),
  state TEXT NOT NULL CHECK(state IN ('active','redacted')),
  wrap_nonce BLOB, wrapped_dek BLOB, wrap_tag BLOB,
  cipher_nonce BLOB, ciphertext BLOB, cipher_tag BLOB,
  plaintext_commitment TEXT NOT NULL,
  scope_digest TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation>=0),
  time_created INTEGER NOT NULL,
  time_rotated INTEGER,
  time_redacted INTEGER,
  last_operation_id TEXT NOT NULL,
  FOREIGN KEY(session_id) REFERENCES session(id) ON DELETE CASCADE,
  FOREIGN KEY(sealed_aggregate_id) REFERENCES event_sequence(aggregate_id) ON DELETE CASCADE,
  FOREIGN KEY(creation_recovery_aggregate_id,creation_event_seq) REFERENCES event(aggregate_id,seq) ON DELETE CASCADE,
  CHECK(last_operation_id=creation_operation_id OR generation>0),
  CHECK((state='active' AND wrap_nonce IS NOT NULL AND wrapped_dek IS NOT NULL AND wrap_tag IS NOT NULL AND cipher_nonce IS NOT NULL AND ciphertext IS NOT NULL AND cipher_tag IS NOT NULL)
     OR (state='redacted' AND wrap_nonce IS NULL AND wrapped_dek IS NULL AND wrap_tag IS NULL AND cipher_nonce IS NULL AND ciphertext IS NULL AND cipher_tag IS NULL))
);
CREATE UNIQUE INDEX sealed_recovery_scope_idx
  ON sealed_recovery_material(session_id,assistant_id,target_digest,material_kind,ref_id);

CREATE TABLE sealed_recovery_use_lease(
  lease_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  recovery_aggregate_id TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  sealed_generation INTEGER NOT NULL CHECK(sealed_generation>0),
  lease_key_json TEXT NOT NULL,
  lease_key_digest TEXT NOT NULL,
  snapshot_identity_json TEXT NOT NULL,
  closure_binding_json TEXT NOT NULL,
  owner_process_instance_id TEXT NOT NULL,
  acquired_at_operation_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('live','closed')),
  close_reason TEXT CHECK(close_reason IN ('released','mechanically-cancelled','abandoned','lost-handle-cleanup','process-crash-cleanup','session-cascade')),
  closed_by_operation_id TEXT,
  row_digest TEXT NOT NULL,
  time_created INTEGER NOT NULL,
  time_closed INTEGER,
  FOREIGN KEY(session_id) REFERENCES session(id) ON DELETE CASCADE,
  FOREIGN KEY(ref_id) REFERENCES sealed_recovery_material(ref_id) ON DELETE CASCADE,
  CHECK((state='live' AND close_reason IS NULL AND closed_by_operation_id IS NULL AND time_closed IS NULL)
     OR (state='closed' AND close_reason IS NOT NULL AND time_closed IS NOT NULL))
);
CREATE UNIQUE INDEX sealed_recovery_use_lease_live_key_idx
  ON sealed_recovery_use_lease(lease_key_digest) WHERE state='live';
CREATE UNIQUE INDEX sealed_recovery_use_lease_live_generation_idx
  ON sealed_recovery_use_lease(ref_id,sealed_generation) WHERE state='live';
CREATE INDEX sealed_recovery_use_lease_ref_history_idx
  ON sealed_recovery_use_lease(ref_id,sealed_generation,state,lease_id);
```

`sealed_recovery_use_lease`是M4 separately named non-authorizing maintenance/CAS table：它不属于七个recovery materialization、三个head或M1 raw source/control event set，不产生decision/receipt/transport authority；其唯一作用是证明某个exact M1 lease key与same snapshot/closure binding当前仍live并阻止该generation被rotate/redact。`lease_key_json`必须是M1 `SealedRecoveryUseLeaseKeyInputV1` exact secret-safe encoding，逐字段绑定sealed ref/generation/material commitment/scope/purpose/source/action/operation/session/target/prepared-handle commitment；`snapshot_identity_json`必须是M4 exact `RecoverySnapshotIdentityV1`，`closure_binding_json`必须是action-matching `SealedRecoveryUseClosureBindingV1`，Continue含M1 sourceBinding+closureDigest而不含carrier plaintext。三者共同进入row digest并由K7/K8/readback反向比较；raw secret、unsealed bytes与runtime handle不得出现。live row只允许K7 exactly-one insert；K9/K10只允许CAS `live→closed`，永不复活或UPDATE key/snapshot/closure binding。time columns仅operational，不进入lease key/authority，expiry绝不依赖wall clock。

plaintext commitment是keyed HMAC，不是raw SHA-256。M1 parent payload只携带M1实际export的pending-seal metadata/commitment fields（包括M1 plaintext commitment与scope digest）；M4不得向M1 payload添加M4-only blob commitment字段。M4 rotate/redact receipt可在其私有domain内携带对active six blobs或redacted marker的M4 blob commitment，以验证maintenance后的physical row。初始row不发明`sealed-create` public/private operation：`creation_recovery_aggregate_id + creation_operation_id + creation_event_seq`必须指向A3同tx插入的M1 parent recovery raw row；该row exact payload中的pending-seal metadata/ref/scope/target/commitment是该sealed row的genesis raw authority。generation=0时`last_operation_id=creation_operation_id`；rotate/redact后它等于最近M4 maintenance operationID，但永不替代raw scoped replay。`time_created/time_rotated/time_redacted`仅是non-authoritative operational timestamps：不进入K0 folded state、post-state digest、receipt equality或full authoritative table comparison；rebuild/replay只验证nullability/state组合，不重构时间值。

### 4.5 Error union

所有error aliases只使用§3.1的owner-qualified `M4.*ErrorV1`；本节不再声明未定义member或无版本local union。所有result/proof也只使用唯一M4 export：

```ts
export type SevenMaterializationName =
  | "relation" | "dispatch-ledger" | "tool" | "reasoning"
  | "decision" | "consumption" | "public-projection"
export type ThreeHeadName = "assistant-chain-head" | "dispatch-ledger-head" | "recovery-head"
export type RecoveryOwnedTableName =
  | "session-recovery-aggregate-owner"
  | "recovery-event-sequence" | "sealed-event-sequence"
  | "recovery-event" | "sealed-maintenance-event"
  | M4.SevenMaterializationName | M4.ThreeHeadName
  | "sealed-recovery-material" | "sealed-recovery-use-lease"
export type RebuildReceiptV1 = Readonly<{
  receiptVersion: 1
  receiptKind: "recovery-rebuild"
  aggregateID: M1.RecoveryAggregateID
  previousAggregateHead: M1.AdmissionPlan["expectedHeads"]["aggregateEventHead"]
  postAggregateHead: M1.AdmissionPlan["expectedHeads"]["aggregateEventHead"]
  rebuiltRowCounts: Readonly<Record<M4.SevenMaterializationName | M4.ThreeHeadName, M1.SafeNonNegativeInt>>
  postStateDigest: M1.CanonicalDigestValue
}>
export type RecoveryCascadeDeletionProofV1 = Readonly<{
  proofVersion: 1
  sessionID: string
  recoveryAggregateID: M1.RecoveryAggregateID
  sealedAggregateID: M4.SealedAggregateID
  deletedCounts: Readonly<Record<M4.RecoveryOwnedTableName, M1.SafeNonNegativeInt>>
  remainingCounts: Readonly<Record<M4.RecoveryOwnedTableName, 0>>
  foreignKeyViolations: 0
  readonly [recoveryCascadeDeletionProofBrand]: true
}>
export type RotationReceiptV1 = Readonly<{
  receiptVersion: 1
  receiptKind: "sealed-rotation"
  aggregateID: M4.SealedAggregateID
  operationID: M1.RecoveryOperationID
  requestDigest: M4.SealedRequestDigest
  refID: M1.RecoverySealedRefID
  previousGeneration: M1.SafeNonNegativeInt
  nextGeneration: M1.SafePositiveInt
  previousKeyVersion: M1.SafePositiveInt
  nextKeyVersion: M1.SafePositiveInt
  previousBlobCommitment: M4.SealedBlobCommitment
  nextBlobCommitment: M4.SealedBlobCommitment
  eventSequence: M1.SafeNonNegativeInt
  eventDigest: M4.SealedEventChainDigest
}>
export type RedactionReceiptV1 = Readonly<{
  receiptVersion: 1
  receiptKind: "sealed-redaction"
  aggregateID: M4.SealedAggregateID
  operationID: M1.RecoveryOperationID
  requestDigest: M4.SealedRequestDigest
  refID: M1.RecoverySealedRefID
  previousGeneration: M1.SafeNonNegativeInt
  nextGeneration: M1.SafePositiveInt
  previousBlobCommitment: M4.SealedBlobCommitment
  redactedBlobCommitment: M4.SealedBlobCommitment
  eventSequence: M1.SafeNonNegativeInt
  eventDigest: M4.SealedEventChainDigest
}>
```

其exact字段摘要如下：

| Type | Exact fields |
|---|---|
| `M4.RebuildReceiptV1` | `receiptVersion:1,receiptKind:"recovery-rebuild",aggregateID,previousAggregateHead,postAggregateHead,rebuiltRowCounts,postStateDigest`；head均为`M1.AdmissionPlan["expectedHeads"]["aggregateEventHead"]`，counts key domain=`M4.SevenMaterializationName\|M4.ThreeHeadName` |
| `M4.RecoveryCascadeDeletionProofV1` | `proofVersion:1,sessionID,recoveryAggregateID,sealedAggregateID,deletedCounts,remainingCounts,foreignKeyViolations:0`与private unique-symbol brand；两个counts都覆盖`M4.RecoveryOwnedTableName`完整closed tuple；`deletedCounts=beforeCounts-afterCounts`，`remainingCounts`是post-cascade exact zero record，二者不得混名/复用 |
| `M4.RotationReceiptV1` | `receiptVersion:1,receiptKind:"sealed-rotation",aggregateID,operationID,requestDigest,refID,previousGeneration,nextGeneration,previousKeyVersion,nextKeyVersion,previousBlobCommitment,nextBlobCommitment,eventSequence,eventDigest` |
| `M4.RedactionReceiptV1` | `receiptVersion:1,receiptKind:"sealed-redaction",aggregateID,operationID,requestDigest,refID,previousGeneration,nextGeneration,previousBlobCommitment,redactedBlobCommitment,eventSequence,eventDigest` |


Required discriminators：

- owner creation：`session-conflict|aggregate-id-role-collision|aggregate-id-cross-session|partial-owner-state|recovery-genesis-diverged|sealed-genesis-diverged|first-insert-zero-rows`；
- operation conflict：`payload-digest-mismatch|operation-family-mismatch|operation-type-mismatch|predecessor-mismatch|head-cas-lost|first-apply-zero-rows`；prepared proof只能用`kind:"prepared-handle-invalid",reason:"prepared-handle-mismatch"`，policy只能用`kind:"policy-authority-stale",reason:"policy-history-mismatch"`，receipt discriminator只能用`kind:"receipt-type-mismatch",reason:"receipt-kind-mismatch"`；
- replay inconsistent：`owner-mapping-missing|owner-mapping-partial|missing-raw|missing-receipt|chain-broken|operation-prefix-diverged|current-prefix-diverged|head-diverged|unknown-version|partial-authority|aggregate-mismatch|sealed-parent-authority-missing|physical-sealed-row-diverged|sealed-cursor-diverged`；
- snapshot mapping：owner/missing/gap/chain/A2/head errors只能构造`M4.RecoveryErrorV1<"snapshot-inconsistent">`及其indexed reason；SQLite busy只能构造`<"busy-exhausted">`/`"busy-timeout"`；read I/O只能构造`<"database-read">`/`"read-io"`；
- rebuild mapping：owner/expected-head/foreign-derived-row conflict→`M4.RecoveryRebuildErrorV1`的`kind:"rebuild-conflict"` indexed branch；raw/authority/fold corruption→`kind:"replay-inconsistent"`；busy/read/write分别使用其indexed branch，不能借用其它kind的同名/近义reason；
- migration：`schema-version|partial-schema|aggregate-role-collision|duplicate-sequence|sequence-gap|canonicalization|backfill-cas|foreign-key|integrity-check|concurrent-writer|journal`；
- seal：`request-digest-mismatch|generation-mismatch|state-mismatch|rotate-redact-race|first-persist-zero-rows|parent-authority-mismatch|sealed-cursor-diverged|sealed-parent-authority-missing|physical-sealed-row-diverged|live-use-lease-conflict|lease-key-mismatch|lease-state-mismatch|process-liveness-not-proven`。

Errors/logs只含 IDs、seq、typed tag、digest短前缀、key version；禁止 raw payload、full digest、nonce/tag/ciphertext、plaintext、credential、KEK/DEK。

### 4.6 Document-level error-handling strategy

- **Carrier**：M4 functions使用Effect typed error channel；programmer-only impossible state可作为defect终止当前startup/request，但不得被catch成authority success。durable receipt/result不编码error或retry state；`applyMode`仅ephemeral。
- **Translation boundary**：callee exact codec/digest/fold corruption统一翻译为`M4.RecoveryAuthorityErrorV1(kind:"replay-inconsistent")`；owner/head/CAS semantic mismatch翻译为conflict；SQLite busy exhaustion与read/write I/O保持独立typed member；key/crypto保持`M4.RecoverySealErrorV1`。每个S1/R1/K2/K4/K5/K7–K10小节列closed mapping，禁止unknown→missing或conflict→success。
- **Retryable vs terminal**：只有`RecoveryBusyExhausted`之前的database adapter内部最多3次同operationID/same handle retry；busy exhausted、policy stale、head CAS loss带valid S2 winner是caller可重新load/steer的typed outcome。corruption、partial owner/authority、unknown version、receipt mismatch、key integrity failure与无valid winner均terminal/fatal stop，不自动repair、不换ID、不重prepare。
- **Caller obligations**：dispatch first-apply失败时，若已创建automatic handle，M6/M2必须按`mechanical cancel或no-handle barrier → K9 close/zeroize → cleanup → post-cancel work`执行；K9失败立即fatal，cleanup、A5/K0a/S2/S1/replan均不得先行。Nonautomatic handle沿其F26 owner合同cancel/cleanup。commit response unknown只在automatic K9与cleanup完成后使用A5/K0a同tuple exact lookup。automatic complete type-9 result后必须保持same handle prepared并立即调用pre-release K8；在K8 success前F27、M2 authorization与release均不得调用。K8 failure固定mechanical cancel，F27/authorization/release calls=0，再K9 mechanically-cancelled/abandoned close与zeroize，之后才cleanup/lookup。K8 success后F27+M2 exact authorization产生`authorized/open`；`releaseDispatch`在exclusive latch内保持`authorized/held/not-delegated`直到delegate boundary：known predelegation failure先回`authorized/open`再cancel→K9→cleanup，delegated才转`released/delegated`，unknown delivery转terminal `released/unknown-delivery`并K9/zeroize/cleanup/fatal，均不得重发。K10 liveness fence不足保持lease live而非TTL过期；O10 automatic winner要求owner-qualified M6 reload/steer且不得进入M7/M2；R1/MIG1错误由maintenance/startup owner决定停止，不降级public truth。
- **Rollback/publication**：write function在typed error返回前rollback其owned tx；caller-owned tx只向owner抛错，由owner rollback。rollback/unknown commit都不调用P2/P4；observer failure不得反向重试authority transaction。
- **Public redaction**：internal errors到HTTP/SSE/GlobalBus只能经既有public error mapper输出coarse code/correlation ID；raw type/payload/full digest/operationID/sealed ref/key metadata不得外泄。内部diagnostic仍服从上面的日志allowlist。
- **Fatal stop**：当owner mapping partial、raw/authority chain corrupt、exact replay不一致、automatic winner无法验证、cancel无法证明unsendable或migration/rebuild integrity失败时，当前session runner/startup task必须fail closed；禁止fallback legacy session/public projection或猜测winner。

### 4.7 Workflow §4.3.2 callable proof blocks

本节是下列non-trivial callable的规范性proof companion；它补足各函数小节的功能规约，不能被摘要性“algorithm”行替代。每个block都显式给出pre、按序intermediate facts与callee contracts、全部error/rollback、post、穷尽side effects及progress/termination。

#### C1 `createSessionRecoveryAggregateOwner`

- **Pre**：SessionOwner持active parent immediate tx；session/三aggregate IDs exact且pairwise distinct；recovery/sealed IDs全局fresh。
- **Ordered facts/callees**：SessionOwner identity validator post给出session insert eligibility→M1 `buildEventChainDigestInput` post给出exact `{kind:"aggregate-genesis",hashVersion:1,aggregateID}`→M1 `event-chain-v1` digest post给出recovery genesis→M4 sealed builder给出独立sealed genesis→exactly-one insert helpers依次建立session、recovery cursor、sealed cursor、owner map→FK/unique readback post证明四row同tx一致。
- **Errors/rollback**：任一identity/domain/collision/0-or-many/readback/DB错误抛`M4.SessionRecoveryOwnerCreationErrorV1`给parent；C1不commit，parent回滚全部四insert；无same-ID replay、无partial prepared result。
- **Post**：只返回`M4.SessionRecoveryAggregateOwnerPreparedV1`，证明parent tx内fresh pair可见；parent commit前无外部authority。
- **Side effects**：穷尽为parent tx四insert与local digest bytes；零Event row/materialization/head/seal/notify/runtime resource。
- **Progress**：固定builder、四insert、有限readback；无loop；busy/retry由parent有界管理。

#### A3 `applyRecoveryOperation`

- **Pre**：definition/input owner codecs通过；dedicated owner pair存在；stable operationID；branch-specific prepared/policy/origin-authority/pending parameters满足§5.3。
- **Ordered facts/callees**：tx外M1 structural validator建立I1→`BEGIN IMMEDIATE`与owner validator建立I2 same dedicated aggregate→scoped lookup建立I3 existing-or-missing→existing时A4 post直接给complete exact replay result并终止→missing时A2 current fold；operations1/2验证M4 origin-specific authority view并调用M2 exact prepared-proof validator，operation9验证prepared proof、branded same-snapshot slice-derived closure与closed lease tuple；M6 tx policy reader只从`normalizedPolicy.digestInput.effectiveMaxModelAssistants`取得effective M，Legacy predecessor reader与M1 builders建立I4 fresh candidate→type9 K8从canonical input重建exact key set并验证current live rows建立I4L（其它type sealedUse none）→cursor CAS exactly-one建立I5 reserved sequence→raw insert建立I6 sole anchor→K2 post建立I7 payload-rooted seals→SessionOwner inserter与seven materializers建立I8→head CAS建立I9→P3R/A2/readback建立I10 physical=fold并复验lease rows未变→commit后才brand并返回complete first-application result。
- **Errors/rollback**：structural failure零tx；busy有界后typed；existing mismatch零写；first-apply proof/policy/N/M/predecessor/CAS/raw/K2/materialization/head/codec/readback/commit failure全部rollback到完整前态；unknown commit只允许A5 same tuple lookup；dispatch caller按owner contract cancel，不重prepare。
- **Post**：exact replay为DB/runtime零修改的stored complete result；first apply为raw、receipt、Legacy materialization、seven tables、three heads、seals、cursor原子且`applyMode`只在return。type-9保留commit-time K8；A3返回complete result时same handle仍prepared，且A3不调用pre-release K8、F27、M2 authorization、release或K9。
- **Side effects**：穷尽为一个SQLite write transaction与temporary canonical/cipher buffers；无provider/tool/keyring/config/listener/publication；A3不改变M2 handle。type-9的complete-result→pre-release K8→F27/M2 authorization→release once→K9由caller在A3返回后执行。
- **Progress**：existing/missing closed branch各一次；prefix/delta/ref loops有限；busy最多3，无spin。

#### A4 `validateExactReplayAndReturnReceipt` 与 S1 transaction helper

- **Pre**：A4收到active caller tx与scoped existing row；`loadRecoverySnapshotInTransaction`收到active pinned read tx；二者都不得begin/commit。
- **Ordered facts/callees**：owner/kind validator建立same aggregate→P3R ordered decode建立complete prefix→authority-row verifier+M1 event-chain builder建立每row exact→A2分别建立historical operation fold与current full fold→M1 receipt/post-state codec建立stored result exact→七表/三head readers逐字段及§4.2.4 digest比较→raw若含sealed refs则P3S/K0+physical comparator建立referenced metadata exact；S1 helper同序且额外要求exact source terminal fact、same-tx assistant-public mapping、Legacy compatibility enumeration与four-way partition cardinality proof。它先构造complete M1 `DurableRecoverySnapshot`与exact `RecoverySnapshotIdentityV1`，再以closed switch证明truly-empty或authoritative-only-final+complete provider-prefix，按raw order附evidence proof brands及automatic-slice brand；compatibility/mixed/nonfinal/reconciled/carrier/prefix/sealed-generation不合格构造nonempty manual causes。empty current authority由§7.0/O10处理，不构造snapshot。
- **Errors/rollback**：owner/chain/receipt/fold/table/head、partition/cardinality/order/carrier/commitment/prefix/snapshot identity mismatch typed conflict/inconsistent；read/busy按caller union；helpers零写且不rollback，write caller A3负责rollback，read caller负责close；绝不repair、降级missing、提前unseal/acquire lease或从Legacy payload补content。
- **Post**：A4返回original complete replay result；S1 helper返回同一WAL snapshot的M4 nominal authority view，完整包装M1 snapshot。只有带private brand且逐字段绑定该identity的SafeRetry/Continue slice可交M7；Continue slice包含ordered tool/reasoning/provider-prefix proof与closure source binding，足以让M7构造并重算M1 `RecoveryClosureDescriptor`而无需裸snapshot。
- **Side effects**：穷尽为tx-local reads、statement/fold buffers；无write/notify/policy/key/runtime callback。
- **Progress**：两个finite prefix scans与fixed table comparisons；helper无retry/spin，wrapper retry有界。

#### O3a `reconcileInterruptedToolExecution`

- **Pre**：same assistant/call的latest authoritative phase是planned、body-outcome-durable或unknown-intermediate；new exact input只表示`reconciled-terminal-manual-only`；caller没有tool body/after-hook/provider callback。
- **Ordered facts/callees**：single WAL latest-call read+A2建立I1 exact call identity/order/prior phase→M1 `ToolExecutionPhaseV1` exact validator建立I2唯一restart transition且rerun flags forbidden→carrier/commitment comparator建立I3 body-outcome only preserves already durable payload, other branches invent none→A3/A4建立I4 append-only type-4 raw+tool row/readback→latest fold建立I5 terminal barrier closed/manual-only。
- **Errors/rollback**：missing/duplicate/ambiguous call、prior phase already final/foreign reconciled、carrier/order/digest mismatch、CAS/readback/DB failure均typed；A3 rollback all writes；任何trace的body/after-hook/provider invocation count固定0，且不fallback Legacy/history/current part。
- **Post**：success只追加一个no-side-effect reconciled terminal fact；O6可close terminal barrier，但S1只能产生manual-only causes，M5/M7 automatic path不可达。
- **Side effects/progress**：穷尽为一次finite read/fold与一个bounded A3 transaction；无runtime handle、tool/provider/hook、unseal/publication；无spin。

#### O10 `commitAndValidateSupersessionBeforePrepare`

- **Pre**：M6 exact candidate仍unprepared/non-authoritative；input是`inspect-current-authority`或完整`complete-expected-input`，branch与model/no-reply一致；new-input authority不存在。
- **Ordered facts/callees**：M6 candidate validator建立I1 closed branch→model时只验证candidate-owned `submissionPayloadDigest/intendedInitialOperationID`，no-reply验证submission digest与user-only field exclusion，建立I2/I2n且不预构造source-dependent binding digest→inspect以owner/P3R/A2+M1 F6/F7建立I3 current state closed classification：empty/no-source、exact unresolved source、automatic winner或fatal；empty/no-source建立I4 proof/user-only，exact unresolved source建立I4r sourceVersion+controlTailVersion+committed source/context+type10 predecessors+next revision并在cursor reread后附private brand，返回`supersession-required`，不调用O9；complete-input以M1 exact codec、`supersession-binding-v1` builder/F22与operation payload builder建立I5 full type10后调用O9，A5/A4建立I6 complete type10/type9 result；model-only proof builder建立I7 exact post head/high-water；automatic branch S2/S1建立I7a same-snapshot winner；closed mapper返回named M4 result。
- **Errors/rollback**：candidate/reservation/full-input/source/control/predecessor/result/authority/proof/owner/fold ambiguity均不创建proof或brand且零M7/M2 resource；O9 write failure由A3 rollback；response loss只A5 same tuple；corrupt/partial/ambiguous fatal，不转ManualStop/user/model fallback。inspection发现unresolved source时不能缺input调用O9，也不能返回source-ID-only partial branch。
- **Post**：inspection unresolved恰返回complete branded `supersession-required` facts，caller补齐完整type10后必须重入complete-input；model committed/no-source branch仅返回可供same intended type-1使用的proof；no-reply仅user-only continuation；automatic仅reload/steer；无branch自行prepare/release。
- **Side effects**：穷尽为inspection finite reads/local authority allocation，或complete-input至多一次O9 SQLite commit+有限A5 reads，automatic另含S1/S2 reads；无policy/M7/M2/O1/provider/publication。
- **Progress**：closed union一branch；inspect finite prefix一次，complete-input每callee至多一次有界调用；无spin。

#### `loadInitialAdmissionAuthorityView`

- **Pre**：committed session/owner pair、committed Legacy user predecessor、current committed policy、same initial candidate/context、fresh M2 no-handle proof与matching M4 supersession proof均由caller提供；shell/no-reply excluded。
- **Ordered facts/callees**：DEFERRED tx first owner/cursor read建立I1 pinned dedicated aggregate→P3R/A2建立I2 exact empty-genesis或current prefix→owner/head readers建立I3 current aggregate/recovery及initial assistant/ledger genesis→SessionOwner exact user reader建立I4 committed same-session user predecessor→M6 snapshot verifier建立I5 current policy quartet→candidate/context exact validator与`M2.validateNoPreparedHandleProofV1`建立I6 no prepared handle→supersession proof codec/brand validator建立I7 same session/aggregate/intended operation/current-or-type10-post head→cursor/owner reread建立I8 unchanged→构造initial no-handle view。
- **Errors/rollback**：owner/public-role/head/user/policy/candidate/no-handle/supersession stale、prefix corruption、busy/read failure均typed；只读无write rollback，任一失败不返回partial view、不调用M2 prepare。
- **Post**：返回值逐字段绑定同一WAL snapshot的current authority与same candidate，empty aggregate合法且使用exact M1 genesis；它只供planning与一次prepare，不是terminal snapshot。
- **Side effects**：穷尽为一个DEFERRED tx、Legacy/policy/authority reads与local immutable allocation；无write/snapshot/provider/handle mutation。
- **Progress**：一次finite prefix scan和fixed reads；busy最多3，无spin。

#### `bindPreparedInitialAdmissionAuthorityView`

- **Pre**：输入是仍fresh的initial no-handle view；M2只对该view的same candidate/context执行过一次prepare，package仍unreleased/hit=0。
- **Ordered facts/callees**：M4 initial-view brand/field validator建立I1 origin+owner+candidate完整→package discriminator/candidate/context comparison建立I2 same preparation→`M2.validatePreparedUnreleasedHandleProofV1`建立I3 same live handle/lease/paused commitment→以原view全部authority fields不变、仅把`handleProof`替换为validated prepared proof建立I4 prepared view。
- **Errors/rollback**：view stale/structurally forged、package origin/candidate/context/commitment/proof mismatch typed；binder不重读DB、不延长no-handle proof、不返回partial prepared view；caller按M6 contract mechanical-cancel package。
- **Post**：返回值与输入authority byte-equivalent（除proof stage），且只能供O1/A3 first apply；不能用于第二次prepare或terminal recovery。
- **Side effects**：穷尽为M2 proof-registry read/validation与local immutable allocation；无DB write/read、provider hit、handle release。
- **Progress**：fixed field comparison与一次M2 validator，constant bounded，无loop。

#### `loadOrdinaryAdmissionAuthorityView`

- **Pre**：committed session/owner pair、exact terminal-or-settled predecessor、current committed policy、same ordinary candidate/context与fresh M2 no-handle proof存在；candidate尚无authority。
- **Ordered facts/callees**：DEFERRED tx owner/cursor read建立I1 pinned dedicated aggregate→P3R/A2建立I2 exact current fold→relation/assistant-chain reader建立I3 predecessor committed且current、candidate own ledger genesis→current aggregate/recovery heads建立I4→M6 snapshot verifier建立I5 policy quartet→candidate/context exact validator与`M2.validateNoPreparedHandleProofV1`建立I6→cursor/owner reread建立I7 unchanged→构造ordinary no-handle view。
- **Errors/rollback**：empty-without-predecessor、predecessor nonterminal/unsettled/not-current、owner/head/policy/candidate/proof stale、prefix corruption、busy/read failure均typed；只读无rollback write，不fallback terminal snapshot/public history。
- **Post**：返回view把exact committed predecessor/current assistant-chain head、candidate ordinal-0 ledger genesis、current aggregate/recovery/policy与no-handle stage绑定到同一snapshot。
- **Side effects**：穷尽为一个DEFERRED tx、authority/policy/predecessor reads与local allocation；无write/provider/handle mutation/snapshot construction。
- **Progress**：一次finite prefix scan和fixed reads；busy最多3，无spin。

#### `bindPreparedOrdinaryAdmissionAuthorityView`

- **Pre**：输入是仍fresh的ordinary no-handle view；M2只对其same candidate/context执行过一次prepare，package仍unreleased/hit=0。
- **Ordered facts/callees**：M4 ordinary-view validator建立I1 origin/predecessor/owner完整→package discriminator/candidate/context comparison建立I2 same preparation→`M2.validatePreparedUnreleasedHandleProofV1`建立I3 same live handle/lease/paused commitment→保留全部ordinary authority fields并只替换proof stage建立I4 prepared view。
- **Errors/rollback**：view/package/origin/candidate/context/commitment/proof mismatch typed；零DB、零partial return，caller mechanical-cancel；不把initial或terminal view转换成ordinary。
- **Post**：返回值只供matching type-2 O1/A3 first apply，predecessor/head/policy/candidate与输入exact相同；不能第二次prepare或release。
- **Side effects**：穷尽为M2 proof validation与local immutable allocation；无DB/provider/handle state transition。
- **Progress**：fixed comparisons+一次validator，无loop/spin。

#### `loadCommittedAssistantAuthorityView`

- **Pre**：session/aggregate/assistant IDs exact，expected admission operation type K为type1/type2/type9之一；caller请求nonterminal same-process reentry而非terminal recovery。
- **Ordered facts/callees**：DEFERRED tx owner/cursor pin建立I1→P3R/A2+derived comparison建立I2 current full authority→relation anchor定位唯一admission operation建立I3 K/origin exact→historical operation prefix+stored receipt codec建立I4 complete admission result→current assistant-chain/dispatch heads与assistant-filtered dispatch/tool/reasoning/prefix slices建立I5→terminal/control scan建立I6该assistant无incomplete terminal且未finalized/consumed/superseded→cursor/owner reread建立I7 unchanged→构造generic view。
- **Errors/rollback**：missing/duplicate relation、K/origin mismatch、opaque/corrupt receipt、terminal或closed assistant、head/table divergence、busy/read均typed；只读无repair/partial view，terminal branch必须改用S1。
- **Post**：返回`CommittedAssistantAuthorityViewV1<K>`，其conditional assistant/context与M1 operation post-state exact，current facts同snapshot且`nonterminal:true`；不构造`M1.DurableRecoverySnapshot`。
- **Side effects**：穷尽为一个DEFERRED tx、finite folds/reads与local immutable allocation；无write/handle/provider/publication。
- **Progress**：finite prefix与assistant facts各一次scan，busy最多3，无spin。

#### `buildRecoveryAssistantPublicMappingInTransaction`

- **Pre**：active pinned tx；owner/fold/sourceVersion/controlTail/latest-decision selector均来自该tx且source terminal snapshot正在构造；caller未提供mapping entries。
- **Ordered facts/callees**：owner/fold identity comparison建立I1 same aggregate/high-water→M1 F6/F7 digest verifier建立I2 source/control exact→latest-decision selector建立I3 optional revision exact→fold relations枚举snapshot需要的committed assistants建立I4 finite unique IDs→SessionOwner exact Legacy assistant-message reader逐ID建立I5 exactly-one same-session assistant-role publicMessageID→binary assistantID sort/duplicate check建立I6 entries→构造snapshotIdentity并调用M1 exact mapping codec建立I7→same-tx cursor/owner reread建立I8 unchanged→return。
- **Errors/rollback**：absent/duplicate/wrong-role/cross-session/stale Legacy mapping、source/control/latest revision mismatch、cursor change、codec/read error均typed；helper不begin/commit/write，不从history/display map猜测，不返回partial entries。
- **Post**：返回M1 `RecoveryAssistantPublicMappingV1`的snapshotIdentity逐字段等于same snapshot，entries是internal assistant→existing public message的exact只读证据；可直接嵌入S1 snapshot。
- **Side effects**：穷尽为caller tx内Legacy/relation reads、finite sort与local allocation；无ID allocation/write/publication。
- **Progress**：finite assistant set每项一次exact read，sort终止；无retry/spin。

#### R1 `rebuildRecoveryAggregate`

- **Pre**：maintenance capability有效；owner pair exact；expected-head五branch之一成立；raw/cursors/owner不可由R1修改。
- **Ordered facts/callees**：writer lock+owner/genesis builder建立I1 pinned pair/head→P3R/P3S+authority verifier建立I2 dual raw truth→A2/K0 post建立I3 deterministic recovery/sealed folds→physical sealed comparator建立I4 fold=sealed table→SessionOwner exact validator建立I5 Legacy predecessor safety→display-ID owner derivation建立I6 stable mapping→scoped derived delete/reinsert建立I7 candidate materialization→readback与cursor reread建立I8 exact且head未变→commit。
- **Errors/rollback**：capability/head/foreign-derived conflict与raw/sealed/fold corruption、busy/read/write全部typed；任一步失败rollback derived changes，raw/owner/cursor/sealed/old derived保持前态；不auto-repair authority。
- **Post**：only Legacy missing deterministic rows和seven/three derived state等于fold；raw/receipt/cursors/sealed physical rows不变；empty branch零genesis event。
- **Side effects**：穷尽为一个SQLite transaction中的allowed derived replacement/Legacy inserts；零notify/keyring/decrypt/provider/tool。
- **Progress**：finite prefixes/refs/rows；busy最多3；单commit，无逐表spin。

#### P2 `notifyCommittedPublic`

- **Pre**：M1 branded public committed event；public manifest guard通过；DB tx已commit/closed。
- **Ordered facts/callees**：public guard post排除internal→listener registry snapshot固定finite order→每listener isolated callback产生attempt fact→每queue `tryOffer` post产生accepted/full/closed三branch→diagnostic sink只记录coarse result。
- **Errors/rollback**：guard defect零forward；listener defect不中断后续；queue full/closed drop live attempt并由P5补齐；diagnostic defect吞并；无DB tx故无rollback或authority retry。
- **Post**：internal零listener/queue；每snapshot consumer至多一次attempt；accepted queue保留本invocation order。
- **Side effects**：穷尽为public callbacks、bounded offers、diagnostic；无SQLite/internal/provider/tool。
- **Progress**：finite snapshots，每项一次non-blocking call，无retry。

#### P3R `readRecoveryAggregatePrivate` / P3S `readSealedAggregatePrivate`

- **Pre**：core-private capability与active matching tx；aggregate属于exact recovery或sealed role。
- **Ordered facts/callees**：owner/cross-role validator建立I1并附M1 `M4RecoveryAggregateOwnerMappingProofV1` brand→ordered EventTable SQL建立I2 same aggregate rows→P3R把每row与同一owner proof组成M1 `RecoveryDurableRowDecodeInputV1`，对应private registry exact decoder建立I3 correct owner/internal family/version→sequence/genesis checker建立I4 empty或0..high-water连续→immutable return。
- **Errors/rollback**：owner partial、mixed publication/family、gap、unknown/extra codec、DB read typed；不fallback public decoder；reader不begin/commit/write，write caller负责rollback。
- **Post**：P3R只返回`M4.RecoveryRawRowV1[]`；P3S只返回`M4.SealedMaintenanceRawRowV1[]`；两者不混链、不serialize。
- **Side effects**：穷尽为tx-local reads/decode/statement allocation；零keyring/crypto/notify。
- **Progress**：单次ordered finite scan，每row一次decode，无spin。

#### P4 `forwardPublic`

- **Pre**：M1 branded public event与active public subscription；private decoder不可达。
- **Ordered facts/callees**：public guard建立I1→public encoder建立I2 safe wire→GlobalBus ordinary attempt完成I3（defect isolated）→若public durable manifest含type则sync attempt完成I4→diagnostic记录各attempt。
- **Errors/rollback**：guard/encode失败零emit；ordinary defect不阻止sync；sync/diagnostic defect不反向抛P2；无DB rollback/retry。
- **Post**：所有emit来自同一encoded public event；internal ordinary/sync均0；successful双emit order为ordinary-before-sync only。
- **Side effects**：穷尽为ordinary/sync attempts、diagnostic、subscription borrow；无SQLite/internal/provider/tool。
- **Progress**：固定guard/encode与至多两次emit，无loop。

#### P5 `readPublicSyncHistory`

- **Pre**：auth scope、safe closed cursor与bounded limit；只注入public-durable writer manifest/decoder，不注入private durableReplay。
- **Ordered facts/callees**：auth/cursor validator建立I1→DEFERRED tx pin snapshot→closed cursor选择aggregate或workspace SQL并硬过滤`publication='public'`建立I2→M1 public durable decoder逐row建立I3 public exact→全部成功后close并return ordered page。
- **Errors/rollback**：auth/cursor/query/decode/busy/read失败丢弃local partial page；只读无write rollback；不fallback private/raw decoder；重复cursor允许同page。
- **Post**：aggregate或global order无歧义，结果仅public durable events，internal不占结果。
- **Side effects**：穷尽为SQLite read、local decode buffers；无listener/bus/write/provider。
- **Progress**：limit有限、每row一次decode、busy最多3；分页由caller驱动非本函数loop。

#### K2 `persistPendingSeals`

- **Pre**：A3-owned active immediate tx；parent raw已insert；pending exact匹配M1 payload refs且无duplicate/plaintext。
- **Ordered facts/callees**：P3R scoped parent read建立I1 exact anchor→M1 pending-ref extractor建立I2 expected set→owner/ref validator建立I3 same session/sealed role→stable ref sort建立I4 deterministic order→insert-returning每项建立I5 generation0 row→readback建立I6 physical=payload commitment。
- **Errors/rollback**：parent/payload/ref/scope/owner/existing/0-or-many/readback失败抛M4 pending-seal error给A3；K2不commit，A3 rollback parent raw/cursor/全部seal/derived，无orphan；replay不调用。
- **Post**：每row creation tuple/last operation绑定parent raw；sealed maintenance cursor不变。
- **Side effects**：穷尽为caller tx内sealed row inserts/readback；无sealed raw event/keyring/provider/notify。
- **Progress**：finite unique refs，sort后每项一次，无retry。

#### K0 `foldSealedAuthorityPrefix`

- **Pre**：same exact owner tuple；完整ordered recovery prefix与sealed maintenance prefix；两个domain独立。
- **Ordered facts/callees**：M1 recovery codec/event-chain/authority verifier建立I1 creation transitions→M4 sealed genesis/event/receipt verifier建立I2 maintenance order→双指针按`recoveryCreationHighWater`应用creates建立I3 historical state→每maintenance generation/state transition建立I4→剩余creates应用后canonical ref map digest建立I5 current state。
- **Errors/rollback**：owner/domain/gap/digest/high-water/creation/ref/generation/post-state任一异常返回replay-inconsistent；纯函数零写无rollback，不skip坏row。
- **Post**：每current ref有唯一M1 parent genesis与ordered M4 maintenance；same dual prefix得到byte-equivalent fold。
- **Side effects**：穷尽为local maps/sorts/canonical bytes；无DB/keyring/crypto/notify。
- **Progress**：两个finite prefix由单调indices各扫描一次，nested refs有限；无递归/spin。

#### K0a `validateSealedExactReplayAndReturnReceipt`

- **Pre**：active caller tx；stable aggregate/operation/type/full request/digest/kind；不提供DB sequence。
- **Ordered facts/callees**：owner validator建立I1→scoped lookup建立missing/existing；missing立即return undefined→existing时request builder+constant-time digest建立I2→P3R/P3S+K0建立I3 historical/current authority→physical table/cursor comparator建立I4→M4 receipt codec建立I5 original receipt。
- **Errors/rollback**：request mismatch conflict；owner/parent/fold/table/receipt/cursor mismatch inconsistent；read/busy typed；零写、不begin/commit，write caller rollback；missing前不做key/resource work。
- **Post**：undefined只表示exact owner scope内operation absent；existing只返回stored immutable receipt。
- **Side effects**：穷尽为tx-local reads/fold buffers；无key/crypto/write/notify。
- **Progress**：一次lookup、两个finite scans、fixed compare，无retry/spin。

#### K7–K10 sealed-use lease lifecycle

- **Pre**：K7收到same branded `AutomaticRecoveryProofSliceV1`、由M7无unseal构造且M1 builder复验的exact `RecoveryClosureDescriptor`、M1 exact `SealedRecoveryUseLeaseKeyInputV1`、positive current generation与owner process ID，且M2 stable no-send handle commitment reservation已存在。commit-time K8收到canonical type-9 input、same branded snapshot identity与complete lease set；独立pre-release K8只在complete `OperationCommitResultV1<"automatic-child-admitted-and-consumed">`已返回且same runtime handle仍prepared/unreleased/hit=0时收到该result、handle commitment与same complete lease set。K9只在release/cancel/abandon/lost-handle事实后调用；K10持exclusive dead-process liveness fence。
- **Ordered facts/callees**：K7 M1 key validator→P3R/P3S/K0→physical comparator→live-key/live-generation unique CAS→row-digest readback建立L1 unique live use；commit-time K8从canonical operation input重建sorted expected key set→set equality→每row live/current generation/key+row digest建立L2 commit guard；A3完成type-9 commit并返回complete result、handle保持prepared→M2立即调用独立pre-release K8从complete result+same handle重建同一sorted set并建立L2R release guard→仅L2R success后把complete result+operationPostState交F27并执行M2 exact authorization→same handle release once→K9 released close；L2R failure则same prepared handle mechanical cancel，F27/authorization/release calls=0，再K9 cancelled/abandoned close；K9 reason/owner/key validator→live→closed CAS+readback建立L3 no reopen；K10先验证exclusive fence，再按dead owner扫描并建立L4 process-crash closed set。
- **Errors/rollback**：generation0、redacted/foreign/stale ref、same-generation different key、missing/extra/duplicate/closed lease、handle/operation/source/action mismatch、CAS/readback/DB failure均fail closed；owned writer tx rollback。commit-time K8 failure由A3 rollback。pre-release K8 failure发生在type-9已commit但handle仍prepared的handoff点：必须mechanical cancel，F27/M2 authorization/release调用数均为0，再K9/zeroize；不得把已commit result降级为authorization success。K10 fence不足不begin mutation并保持live；没有branch以TTL、heartbeat age或wall clock替代fence，也不自动rotate、lower、prepare、release或revive。
- **Post**：K7 success happens-before any unseal/lower/actual prepare；commit-time K8 success只证明cursor前same live generation/handle，不能授权F27/release；独立pre-release K8 success证明complete type-9 result返回后、same handle仍prepared的紧邻授权点仍为same live generation/handle，并且严格happens-before F27、M2 exact authorization与single release。K9/K10 success只使lease closed并触发M4-owned material zeroization。live guard使K4/K5无法在use期间改变generation/state；closed cleanup不能恢复redacted bytes或旧request。
- **Side effects/progress**：穷尽为bounded SQLite reads/writes、CSPRNG/digest与zeroize；无provider/tool/keyring decrypt/publication；finite sets，busy最多3，无TTL loop。

#### K4 `rotateSealedMaterial`

- **Pre**：stable full request tuple；owner pair/parent authority存在；current key/generation只约束first apply。
- **Ordered facts/callees**：short read+K0a建立I1 replay-or-missing→existing直接stored receipt→missing时request builder/digest建立I2→keyring prefetch建立non-authority I3→`BEGIN IMMEDIATE`+K0a race relookup建立I4→P3R/P3S/K0建立I5 current active generation→GCM rewrap+blob commitment建立I6→raw/row/cursor exactly-one writes建立I7→K0/table readback建立I8→commit。
- **Errors/rollback**：existing mismatch零写零key；missing后key/owner/generation/crypto/CAS/raw/readback/commit failure rollback old row；race existing返回stored receipt；unknown commit从K0a重新lookup；all exits zeroize keys/DEK。
- **Post**：replay零resource mutation；first apply only rewrap/generation/keyVersion/lastOperation+maintenance raw/cursor，material ciphertext/plaintext commitment不变。
- **Side effects**：穷尽为replay reads，或first-apply keyring read+local crypto+one SQLite tx+zeroize；无decrypt material/provider/notify。
- **Progress**：short lookup和writer relookup各至多一次，busy最多3，finite folds/crypto。

#### K5 `redactSealedMaterial`

- **Pre**：stable full request tuple；owner pair/parent authority存在；active generation只约束first apply。
- **Ordered facts/callees**：short read+K0a建立I1 replay-or-missing→missing时request builder/digest建立I2→`BEGIN IMMEDIATE`+K0a race relookup建立I3→P3R/P3S/K0建立I4 current active generation→redacted marker builder建立I5→raw/row/cursor exactly-one writes建立I6→K0/table readback建立I7→commit。
- **Errors/rollback**：existing mismatch/corruption零写；owner/parent/generation/rotate race/CAS/raw/readback/commit failure rollback完整active row；unknown commit从K0a重查；无key/decrypt fallback。
- **Post**：replay返回stored receipt；first apply blobs全null、state redacted、generation+1、last operation更新，K3永久拒绝。
- **Side effects**：穷尽为SQLite reads或一个SQLite write tx/local marker bytes；无keyring/decrypt/provider/notify。
- **Progress**：两个lookup至多各一次、finite folds、busy最多3，无spin。

## 5. Pure canonicalization/fold 与通用 apply/replay

### 5.1 A1 `canonicalizeRecoveryOperation`

```ts
export function canonicalizeRecoveryOperation<T extends M1.RecoveryOperationType>(
  input: M1.RecoveryOperationInputV1<T>,
  aggregateSequence: M1.SafeNonNegativeInt,
  previousDigest: M1.EventChainDigest,
): Effect.Effect<M1.RecoveryOperationEnvelope<T>, M4.RecoveryAuthorityErrorV1>
```

- **Owner/落点**：M4 private core authority module；M1 canonical builders是callee owner。
- **Callers**：A3 apply、MIG1 recovery-row validator、R1 rebuild validator。
- **Callees**：M1 exact field-set validator、`buildOperationPayloadDigestInput`、`digestCanonicalCommitment`、event-chain builder。
- **Requires**：input type/payload discriminator一致；sequence/previous来自transaction snapshot；无 raw secret/runtime handle/public projection。
- **Ensures**：返回 recursive exact M1 envelope；payload/event-chain digest重算且domain正确；相同输入得到byte-equivalent envelope。
- **Errors**：unknown type/version、extra/missing field、unsafe integer、digest/canonicalization failure；无 partial value。
- **Side effects/transaction/replay/resource**：纯函数；无事务、I/O、随机数、时钟、provider；只分配短期 canonical bytes并在digest后释放引用。
- **Algorithm**：validate exact input → build payload digest → build sequence/event-chain input → build next digest → assemble → validate exact envelope。
- **Test IDs**：T-A1-001..006。
- **正确性论证（§4.3.2）**：
  - **前置**：caller给出recognized M1 type与transaction-derived predecessor。
  - **步骤/callee**：M1 exact validator排除extra/secret；payload builder post固定domain membership；event-chain builder post把aggregate/seq/op/type/previous/payload全部绑定。
  - **全部错误/回滚**：任一validator/digest失败在纯函数内退出，无DB状态，故无需补偿；没有fallback domain。
  - **后置**：两次digest post与最终exact decode合取推出返回值满足M1 envelope。
  - **副作用穷尽**：调用图仅pure validator/canonical bytes/crypto；无外部service。
  - **不变量保持**：M4-I1/M4-I4/I9由exact domain与secret exclusion保持。
  - **终止**：recursive encoder对有限acyclic exact JSON逐子节点递归；每次严格缩小，必终止。

### 5.2 A2 `foldRecoveryPrefix`

```ts
export function foldRecoveryPrefix(
  aggregateID: M1.RecoveryAggregateID,
  rows: readonly M4.RecoveryRawRowV1[],
): Effect.Effect<M4.RecoveryFoldedStateV1, M4.RecoveryAuthorityErrorV1>
```

`M4.RecoveryFoldedStateV1`是M4 private fold result，exact含：七materializations（其中projection member为append-only `projectionHistory`，另含由history最大`sourceEventSeq`纯导出的`currentProjectionView`，view不计第八materialization）、三个recovery heads、M1 aggregate event head、provider-prefix/incomplete-terminal raw slices、`postStateDigest`。projection values逐项为`M1.RecoveryPublicProjectionV1`。

- **Owner/落点**：M4 private reducer；row/type validators由M1拥有。
- **Callers**：A3/A4/A5、S1 snapshot、R1 rebuild、sealed fold另用K-domain reducer。
- **Callees**：A1 envelope validation、M1实际export的recovery transition/safe projector/projection codec、canonical row encoders。
- **Requires**：owner mapping证明`aggregateID`是该session的dedicated `session-recovery` aggregate；rows按 `(aggregateID,seq)` 从0到high-water完整提供且每row都是publication=`internal`、family=`m1-recovery-v1`；不信数据库现有materialization。
- **Ensures**：空prefix得到exact empty recovery fold/head；recognized internal prefix得到唯一fold；operation4逐transition重建完整`AuthoritativeToolEvidenceV1`（callOrdinal、five-phase、ordered arguments/result-or-error carriers、plan/call/result commitments、sourceRange），operation5重建reasoning content carrier，operation6重建provider-prefix content+ancestry；A2不读取Legacy compatibility、不构造snapshot-bound proof。operations 8–10只从canonical raw payload+envelope/sequence确定性重建decision，1/2/9重建Legacy assistant intent；public/legacy/mixed-family、carrier缺失/digest-only/order或phase非法、gap/hash break失败；同prefix byte-equivalent output。
- **Errors/side effects**：纯 read-model计算；无写、publish、clock、random/provider。
- **Algorithm**：从C1保存的M1 `event-chain-v1` aggregate-genesis开始，每次都以exact input `{kind:"aggregate-genesis",hashVersion:1,aggregateID}`调用M1 builder重算，绝不信任stored genesis或使用M4 metadata digest；若rows空则验证empty cursor语义并返回empty fold；否则首row必须seq=0且previous等于该M1 genesis，逐row使用operation branch exact input验证aggregate/seq/previous/next、internal publication与M1 family并执行closed recovery reducer；**不允许legacy/public row进入该prefix，也没有“只推进legacy chain”分支**；每步更新fold与post digest。
- **Test IDs**：T-A2-001..012。
- **正确性论证**：
  - **前置**：有限rows属于同aggregate。
  - **步骤/callee**：owner/genesis pre排除mixed public chain；每步A1/M1 validator建立internal raw真实性；closed reducer对10 operation逐项应用；M1 safe projector只从fold view构造allowlist projection。
  - **错误/回滚**：owner/genesis/public-or-legacy-row/gap/duplicate/unknown/illegal transition立即返回inconsistent；函数无写，不存在partial authority暴露。
  - **后置**：归纳：genesis fold满足I1；若前缀k满足，recognized reducer与exact predecessor使k+1满足；故全prefix输出唯一。
  - **副作用穷尽**：只分配maps/arrays/digest bytes。
  - **不变量保持**：七表/三head logical invariants、available/opaque closed union、decision lifecycle与projection safety在每个 reducer branch验证。
  - **终止**：rows有限且index每轮+1；nested tool/reasoning collections有限。

### 5.3 A3 `applyRecoveryOperation`

```ts
export function applyRecoveryOperation<T extends M1.RecoveryOperationType>(
  definition: Extract<M1.RecoveryEventRegistryV1["definitions"][number], { operationType: T }>,
  input: M1.RecoveryOperationInputV1<T>,
  prepared: M2.PreparedCommitPackageV1 | undefined,
  pendingSeals: readonly M4.PendingSealV1[],
  policyExpectation: M6.RecoveryPolicyAuthorityExpectation | undefined,
  admissionAuthority:
    | M4.InitialAdmissionAuthorityViewV1<M2.PreparedUnreleasedHandleProofV1>
    | M4.OrdinaryAdmissionAuthorityViewV1<M2.PreparedUnreleasedHandleProofV1>
    | undefined,
  sealedUse:
    | Readonly<{ kind: "none"; leases: readonly [] }>
    | Readonly<{
        kind: "automatic"
        snapshotIdentity: M4.RecoverySnapshotIdentityV1
        leases: readonly M4.SealedRecoveryUseLeaseV1[]
      }>,
): Effect.Effect<M1.OperationCommitResultV1<T>, M4.RecoveryAuthorityErrorV1>
```

- **Owner/落点**：`packages/core/src/session/recovery/authority.ts` private service。
- **Direct callers**：O1–O9 only；O10只经O9间接调用A3，M6后续owner-qualified sequencing另经O1调用；generic EventV2 caller不可见。
- **Callees contracts**：M1 definition/input exact validators只做structural/historical-field验证；owner validator以M1 `aggregateID`验证dedicated session mapping；A4先验证operation-sequence fold再验证current full prefix；first-apply才调用M2 prepared proof validator、policy tx reader、A1/A2、K2、M1 receipt/projector codecs与SQLite exactly-one CAS helpers。
- **Requires**：definition durable/internal；session及C1创建的dedicated pair已存在；operationID stable。exact replay只要求完整historical expected input/digest/kind，允许prepared/policy resource已不存在或stale；以下branch rules只在scoped lookup missing、进入first apply时生效，且expected predecessors必须来自fresh snapshot：
  1. M1 dispatch operations 1/2/3/9：`prepared`必须matching（9只允许available）；`pendingSeals`必须与`prepared.pendingSeals`、raw payload refs三者按refID exact相等，available逐ref匹配targetDigest，opaque两者均空；1/2/9必须携带input内historical `scopeKey/epoch/policyDigest/defaultSemanticsVersion`并传matching `policyExpectation`，3的policy必须undefined。operation1必须传`M4.InitialAdmissionAuthorityViewV1<M2.PreparedUnreleasedHandleProofV1>`，operation2必须传对应ordinary view；两者owner/current aggregate head/policy/candidate/context/predecessor/package proof逐项match。type-1若携带`newLineageReservation`，view的supersession proof必须绑定same session/aggregate、exact type-10 operationID、完整model `SupersessionBindingDigestInputV1`及其`SupersessionBindingDigest`、intended operationID和type-10 post aggregate head，且ref.`reservationDigest` exact等于该binding digest；若无reservation，proof必须是fresh `model-no-unresolved-source` branch。operations3/9的`admissionAuthority`必须undefined；operation9另要求`sealedUse.kind="automatic"`且snapshotIdentity/lease set与payload closure、prepared commitment、source/action/candidate/operation/target及所有实际unsealed refs exact；零ref时leases exact空。operations1/2/3要求`sealedUse.kind="none"`；
  2. O4/O5对应M1 operations 5/6：`prepared`、policy与`admissionAuthority`必须undefined，`sealedUse.kind="none"`，但允许`pendingSeals`；它们必须与exact payload引用的pending metadata/commitments按refID全等，不得引用package；
  3. operations 4/7/8/10：`prepared`、policy与`admissionAuthority`必须undefined、`pendingSeals=[]`且`sealedUse.kind="none"`。
- **Ensures**：first apply全量原子提交并返回ephemeral exact result；existing same operation先走A4 zero-write replay，即使current policy/M/N/key/resource已变化仍返回stored receipt；commit后不publish internal event。`applyMode`只在返回result，不进入stored receipt。
- **Transaction/resource rule**：一个uninterruptible `BEGIN IMMEDIATE`；禁止nested transaction；transaction callback内禁止provider/tool/unseal/keyring/config callback/publication。prepared proof、key availability和current budget都不是exact replay的前置。
- **Workflow/branches**：
  1. transaction外只验证definition/type、M1 aggregate selector与expectedInput的exact structural/historical fields；不验证prepared freshness、不读current policy/N/M/key、不创建/取消resource；
  2. acquire `BEGIN IMMEDIATE`（busy只可能从本step开始）；验证session owner mapping/aggregate kind，然后立即按`(aggregateID,operationID)` lookup；
  3. existing branch：把stored row与完整expected input/expected receipt kind交A4；A4先fold到该operation sequence验证historical operation/receipt/policy fields，再独立验证current high-water full prefix/七表/三head；成功直接返回`applyMode:"exact-replay"`+stored receipt，且**不执行steps 4–14**；mismatch/corruption零写失败；
  4. missing/first-apply branch：验证dedicated pair/empty-or-current cursors完整。operation1/2分别验证exact origin-specific prepared authority view：owner mapping/current aggregate head/current policy/candidate/context/predecessor必须与input/package/current tx一致，并调用`M2.validatePreparedUnreleasedHandleProofV1`；不得接受`M1.DurableRecoverySnapshot`或local structural view。type-1 reservation branch另验证view内supersession proof的type-10 operationID、full model supersession binding input/digest、ref reservation digest、intended operationID、session/aggregate与type-10 post aggregate head；no-reservation branch验证fresh `model-no-unresolved-source` proof。两者都不把reservation当成完整type-1 payload digest；再验证pending set与policy参数。type-9在本step验证`sealedUse.kind="automatic"`的snapshot identity与lease set structural exact，实际live CAS row validation在step6 policy/source/control facts确定后、cursor reservation前调用K8；其它type要求none。view/proof/prepared/lease structure无效均typed failure；
  5. 读取完整current recovery raw prefix并A2 fold；所有operation的aggregate predecessor都必须是exact current `AdmissionPlan["expectedHeads"]["aggregateEventHead"]`：仅empty aggregate允许C1/MIG1 genesis/seq=0，否则seq=current+1。type-1 view的aggregate head必须逐字等于该current head，且assistant-chain genesis/absent与the new initial assistant's own ordinal-0 dispatch-ledger genesis/absent；post-supersession type-1的aggregate predecessor必须等于exact type-10 post head。ordinary view必须绑定exact committed predecessor/current assistant-chain head与candidate ordinal-0 ledger genesis；
  6. operations 1/2/9调用owner-qualified `M6.readRecoveryPolicyAuthorityInTransaction`，要求current row与input/expectation的historical fields exact相等；operations1/2还要求authority view policy quartet逐字段相等。callee返回的committed `M1.NormalizedRecoveryPolicy`是唯一M输入：取`effectiveM := normalizedPolicy.digestInput.effectiveMaxModelAssistants`，禁止再读runtime config/agent steps或从configured M重算；从step5 fold重算`committedAssistantCountBefore`与candidate sequence并要求`candidateAssistantSequence < effectiveM`，且写入receipt/post-state的effective value exact等于它（9另按同一committed policy重算N）；policy/budget stale只阻止first apply；type-9随后调用K8，在same writer tx对expected sealed ref set逐项验证lease row仍live、generation/current sealed authority/snapshot identity/source/action/operation/target/prepared commitment exact；
  7. A1构造candidate envelope；transaction-local构造receipt、七表delta、post heads/post-state、authority-row digest及operations 1/2/9所需Legacy assistant/message materialization。type-1先exact读取并验证view与input共同绑定的既存user-message predecessor（same session/id/role/digest），绝不insert或修复该user row；type2验证view predecessor仍是current committed terminal/settled assistant；types 1/2/9从raw payload构造assistant info row及relation。candidate→committed derivation此时仍non-authoritative，任何rollback都丢弃；
  8. CAS recovery aggregate cursor exactly one（empty aggregate从genesis/high-water none预约seq=0）；
  9. insert parent recovery raw authority anchor exactly one；该raw先包含所有payload-referenced pending-seal metadata/commitments；
  10. 若pending非空，调用K2并传parent `(aggregateID,operationID,aggregateSequence)`及exact parent payload；K2只据此创建genesis sealed rows并把`last_operation_id`设为parent operationID；
  11. fixed order写Legacy assistant info/message relation与七materializations：Legacy assistant info→relation→dispatch→tool→reasoning→decision→consumption→public projection；operations 8–10的decision row只能由canonical payload decision material + operation envelope/committed sequence + source/proposal/child facts确定性重建，禁止DB clock、runtime decision object或existing projection补字段。不受影响family明确no-op，projection只append；
  12. fixed order写relevant heads：assistant-chain→dispatch-ledger→recovery；
  13. transaction内重读recovery raw current prefix并重算每rowauthority digest、七表/三head/receipt；对每个新seal另从parent raw payload验证cross-aggregate creation tuple、sealed authoritative fields与owner mapping；逐字段与A2/K0 candidate state比较；
  14. commit后才把transaction-local candidate标为committed并返回`applyMode:"first-application"`；不调用public/internal live notify。
- **All errors/rollback/replay**：step1 structural error零tx；step2 busy最多3次后typed busy且零写；owner/missing-pair/partial-cursor typed fail且不repair；existing mismatch由A4 conflict/inconsistent且不受current policy/resource影响；first-apply predecessor/policy/M/N/prepared/pending stale、cursor/raw/K2/materialization/head 0/多row、codec或readback差异全部rollback；commit status unknown只用A5同tuple恢复，禁止新ID/新prepare。existing operation不重新persist seal、不修改handle；first-apply failure由wrapper/M6 mechanical-cancel已创建handle。
- **Post**：first-application commit后parent raw、stored receipt、payload-rooted sealed rows、七表append delta、三head与fold exact相等；type-9保留cursor前commit-time K8，返回complete result时same handle仍prepared且所用lease保持同一live generation。M2必须立即执行独立pre-release K8，success后才可F27→M2 exact authorization→release once→K9；failure则mechanical cancel且F27/authorization/release calls=0，再K9/zeroize。A3不关闭或延长lease；exact-replay返回historical stored receipt且DB/runtime零修改；任一失败外部只见完整前态。
- **Side effects/resource lifecycle**：唯一durable side effect是该SQLite transaction；无provider/tool/keyring callback/public notify。prepared runtime state由M2/caller管理且A3不修改；canonical/pending cipher buffers在tx/调用scope后释放；rollback丢弃所有transaction-local committed-object candidates。
- **Invariants**：A3按适用branch保持I1–M4-I10；I11的mechanical-cancel-before-ManualStop责任属于O7+M2/M6，A3不声称独立建立I11。
- **Termination**：raw/materialization/seal loops均对finite prefix/delta；busy retry最多3次；existing与first-apply branches各固定一次，无busy-spin。
- **Test IDs**：T-A3-001..034。

### 5.4 A4 `validateExactReplayAndReturnReceipt`

```ts
export function validateExactReplayAndReturnReceipt<T extends M1.RecoveryOperationType>(
  tx: M4.RecoveryReadOrWriteTransaction,
  definition: Extract<M1.RecoveryEventRegistryV1["definitions"][number], { operationType: T }>,
  aggregateID: M1.RecoveryAggregateID,
  operationID: M1.RecoveryOperationID,
  expectedInput: M1.RecoveryOperationInputV1<T>,
  expectedReceiptKind: M1.ReceiptForV1<T>["receiptKind"],
): Effect.Effect<M1.OperationCommitResultV1<T>, M4.RecoveryAuthorityErrorV1>
```

- **Owner/落点/Callers**：M4 private replay validator；A3 existing branch、A5 lookup。
- **Callees**：A1/A2、authority-row/§4.2.4 derived digest verifier、M1 definition/receipt codecs、transaction-local七表/三head readers；若operation/current prefix含sealed refs，还调用P3R/P3S→K0与sealed authoritative-table metadata comparator（不decrypt/读key）。
- **Requires**：lookup已按同一aggregate+operation找到row；expected input完整；tx snapshot active。
- **Ensures**：只在same owner-mapped aggregate/family/type/full expected input/payload digest、该operation sequence处的historical prefix/fold/receipt，以及独立的完整current raw/authority-row chain/full fold/七表/三head全部match时返回stored result；零写。operations 1/2/9先从historical input+stored receipt验证`scopeKey/epoch/policyDigest/defaultSemanticsVersion`，不读取current policy row。
- **Errors/transaction/replay/resource**：conflict与corruption分离；不begin/commit；由caller tx释放statements/fold buffers；可重复byte-equivalent；missing/partial owner pair不是missing operation而是inconsistent。
- **Algorithm**：owner mapping/aggregate kind→重算expected payload digest并比较stored family/type/publication/full input→读取genesis..stored aggregateSequence并验证每row chain/authority digest→A2 fold **operation prefix**、decode stored immutable receipt并验证historical policy/receipt/raw/handle commitment→再读取genesis..current high-water、验证完整current chain/authority digests并A2 fold **current prefix**→逐字段比较当前Legacy assistant/message relation、七表/三head/raw slices（append-only projection用current view+全history）→从operation/current raw payload抽取所有sealed metadata refs；若非空，在same tx读取P3S并以P3R+P3S→K0重建current sealed authority，逐ref比较parent creation tuple、session/assistant/target/scope/purpose/plaintext commitment、generation/state/key version/last operation与physical metadata/blob-or-marker commitment，允许合法later rotate/redact但拒绝missing/foreign/forged/restored bytes；不要求active、不decrypt→返回原operation、stored receipt、exact operation post-state与ephemeral `applyMode:"exact-replay"` complete result。
- **Test IDs**：T-A4-001..016。
- **正确性论证**：
  - **前置**：row scoped lookup成立。
  - **步骤/callee**：A1排除same-ID different payload；operation-prefix A2+receipt codec证明历史提交时的input/policy/receipt exact；current-prefix A2+derived comparison独立排除后来chain或materialization corruption；M1 receipt validator排除kind/handle/identity substitution。
  - **错误/回滚**：aggregate/type/full-input/digest/historical-policy mismatch→conflict；任一operation-prefix/current-prefix chain/fold/receipt/table mismatch→inconsistent；函数零写，write tx由A3统一rollback。
  - **后置**：成功返回的只能是原raw中immutable result，不是新authority。
  - **副作用穷尽**：SQL reads + pure fold；无write/publish/handle transition。
  - **不变量保持**：I4直接成立；不自动repair保持I1/M4-I5。
  - **终止**：完整prefix有限；逐表比较有限。

### 5.5 A5 `lookupRecoveryOperationResult`

```ts
export function lookupRecoveryOperationResult<
  T extends M1.RecoveryOperationType,
>(input: Readonly<{
  key: M1.RecoveryOperationLookupKeyV1<T>
  expectedInput: M1.RecoveryOperationInputV1<T>
  expectedPayloadDigest: M1.OperationPayloadDigest
  expectedReceiptKind: M1.ReceiptForV1<T>["receiptKind"]
}>): Effect.Effect<
  M1.OperationCommitResultV1<T> | undefined,
  M4.RecoveryAuthorityErrorV1
>
```

- **Callers**：M6 commit-response-loss resolver、M2 same-process never-released re-entry。
- **Owner/落点**：M4 private authority service；public HTTP/SDK不可达。
- **Callees**：M1 internal definition registry按`expectedInput.payload.kind`取得exact definition；single DEFERRED read transaction；A1重算payload digest；A4。
- **Requires**：caller保留首次提交的M1 exact `RecoveryOperationLookupKeyV1<T>`、完整expectedInput、expectedPayloadDigest与receipt kind；`expectedInput.aggregateID/operationID/operationType`及`expectedInput.payload.sessionID`逐项等于`key.aggregateID/operationID/expectedOperationType/sessionID`；不能只给operationID或自造M4 lookup key。
- **Ensures**：先验证`key.sessionID↔key.aggregateID` committed dedicated owner mapping，再以SQL `(aggregate_id,operation_id)`和`key.expectedOperationType`执行scoped lookup；有效scope中missing raw返回undefined，owner pair missing/partial/corrupt返回typed inconsistent而不是undefined。存在时由M1 exported private registry取得exact definition并把完整expectedInput传给A4，A4先验证historical operation prefix、再验证current full prefix后返回原operation、`applyMode:"exact-replay"`、exact operation post-state与stored receipt组成的完整`OperationCommitResultV1<T>`；same operationID in other session/aggregate或wrong kind永不命中；不读取current policy/N/M/key/resource，不创建prepared proof或新handle。
- **Side effects/replay**：只读；可重复；不prepare/authorize/release。nonautomatic lookup result只有与同一仍存活prepared handle一起通过F26与M2 exact validation时才可授权。automatic lookup result还必须在same handle仍prepared时立即通过独立pre-release K8；K8 success后才可调用F27/M2 authorization/release once，K8 failure则cancel且F27/authorization/release calls=0，再K9/zeroize。detached receipt或lookup本身没有transport authority。
- **Test IDs**：T-A5-001..009。
- **正确性论证**：
  - **前置**：expected tuple稳定。
  - **步骤/callee**：M1 lookup-key codec校验`key`并将其四字段与expectedInput逐项比较→M4 owner validator产生/验证`M4RecoveryAggregateOwnerMappingProofV1`→definition registry返回`key.expectedOperationType` matching codec→A1重算并比较expectedPayloadDigest→scoped SQL排除跨session/aggregate/kind碰撞→A4接收完整definition+expectedInput并提供same kind/digest/full fold。
  - **错误 traces**：missing→undefined；mismatch/corruption→typed failure，不降级missing；read busy最多3次后busy error。
  - **后置**：只有exact original complete operation result可返回；不存在receipt-only recovery。
  - **副作用穷尽**：单read transaction，无writes/notify/runtime state。
  - **不变量保持**：M4-I4/M4-I6。
  - **终止**：一次lookup + finite validation；bounded busy retry。

## 6. 九个 M1 operation wrappers 与 O10 supersession gate

O1–O9是M1 operation wrappers：只构造M1 exported exact input并委托A3；O10不是operation wrapper，而是M4 supersession persistence/validation gate。O1–O7/O9调用A3时必须传`sealedUse:{kind:"none",leases:[]}`；只有O8传`kind:"automatic"`的exact snapshot identity+lease set。每个wrapper proof都引用A3且不省略其错误/rollback语义；所有receipt/type名称以M1实际export为准，M4不得保留未定义informal alias。

### 6.1 O1 `commitCompositeAdmissionDispatch`

```ts
export function commitCompositeAdmissionDispatch<
  T extends
    | "initial-chain-genesis-and-dispatch"
    | "ordinary-assistant-and-dispatch-admitted",
>(
  input: M1.RecoveryOperationInputV1<T>,
  prepared: M2.PreparedCommitPackageV1,
  policy: M6.RecoveryPolicyAuthorityExpectation,
  authority:
    | M4.InitialAdmissionAuthorityViewV1<M2.PreparedUnreleasedHandleProofV1>
    | M4.OrdinaryAdmissionAuthorityViewV1<M2.PreparedUnreleasedHandleProofV1>,
): Effect.Effect<M1.OperationCommitResultV1<T>, M4.RecoveryAuthorityErrorV1>
```

- **Owner/落点/Callers**：M4 authority wrapper；M6 initial/ordinary/new-lineage path only。
- **Callees**：A3/A4/A5、M1 receipt codec；M2 prepared-proof validator、policy verifier与M4 origin-specific authority-view validator只由A3 scoped replay miss后的first-apply branch调用；initial new-lineage safe projection由A3调用M1-owned projector。
- **Requires**：C1/MIG1 committed dedicated aggregate pair存在且与legacy/public session aggregate distinct；existing ordinary converter已构造semantic candidate，M2已exact prepare一次；handle prepared/unreleased/hit=0。type discriminator与authority origin必须exact match。Initial authority不得来自`M1.DurableRecoverySnapshot`：它直接携带committed owner mapping、dedicated aggregate exact current head（empty时C1/MIG1 genesis）、current policy、committed Legacy user predecessor、candidate/context、prepared proof与M4 supersession proof。type-1表示model-lineage genesis，始终要求new assistant-chain genesis/absent与the new initial assistant's own ordinal-0 dispatch-ledger genesis/absent；post-model-supersession时其aggregate predecessor必须等于exact type-10 post head，并携带`NewLineageReservationRefV1`。A3分别验证reservation operationID、`reservationDigest==SupersessionBindingDigest`、persisted full model binding input/intended operationID与完整post-prepare type-1 payload digest；no-source type-1使用fresh `model-no-unresolved-source` proof。Ordinary authority直接绑定current owner/aggregate/recovery heads、current policy、exact committed predecessor、candidate/context与prepared proof，不使用terminal snapshot；candidate ledger genesis。M availability不是caller布尔前提：A3仅first-apply在tx内读取policy row并从fold重算committed count/candidate sequence；exact replay只验证historical fields。
- **Ensures**：raw operation、Legacy assistant info/message relation、admission safe projection append、ordinal0 ledger、relevant heads、payload-rooted pending seals和M1 exact stored receipt原子；type-1不insert user row。返回完整`OperationCommitResultV1<T>`，handle仍未release；`applyMode`仅在ephemeral result。
- **Errors/side effects/transaction/replay/resource**：完全按A3；任一失败caller先mechanical-cancel；exact replay只在同一handle仍prepared时可继续authorize，否则只返回authority结果而不得重建handle。
- **Test IDs**：T-O1-001..014。
- **正确性论证**：
  - **前置**：candidate非authority、prepared package exact且origin-specific M4 authority view处于prepared stage。
  - **步骤/callee**：O1把package/authority view原样交A3；A3先lookup/A4，missing才逐项验证owner/current head/policy/predecessor/candidate与M2 prepared proof，并在initial branch验证supersession proof；A3 post建立raw+assistant+dispatch+heads+projection原子；M1 codec保证available/opaque exact receipt。
  - **错误/rollback**：prepare proof stale、M exhausted、genesis/predecessor/CAS/projection/seal/raw failure均A3 rollback；caller cancel，hit=0；无receipt-before-prepare分支。
  - **后置**：成功才有committed assistant/dispatch authority和complete result；本nonautomatic路径保持既有F26合同，release仍需M2以`result.receipt + result.operationPostState`调用F26并验证same live handle。
  - **副作用穷尽**：SQLite composite；无provider/tool/public raw event publish。
  - **不变量保持**：M4-I1–M4-I5、M4-I7、M4-I9；new-lineage分支保持I10。
  - **终止**：A3 bounded。

### 6.2 O2 `commitSubsequentDispatch`

```ts
export function commitSubsequentDispatch(
  input: M1.RecoveryOperationInputV1<"subsequent-dispatch-recorded">,
  prepared: M2.PreparedCommitPackageV1,
): Effect.Effect<
  M1.OperationCommitResultV1<"subsequent-dispatch-recorded">,
  M4.RecoveryAuthorityErrorV1
>
```

- **Owner/落点/Callers**：M4 authority wrapper；M2/M6 `recordAndAuthorizeSubsequentDispatch`唯一caller。
- **Callees**：M1 subsequent input+receipt codec、A3/A4/A5；M2 prepared proof/commitment validator只由A3 replay miss branch调用。
- **Requires**：committed assistant；fresh invocation；ordinal=predecessor+1；old invocation closed；new handle prepared/unreleased/hit=0；package exact private facts与pending seal target scope匹配。
- **Ensures**：raw+ledger+dispatch head+aggregate cursor+seals原子；不改chain/recovery head；handle仍prepared。
- **Errors/transaction/replay/resource/algorithm**：proof/ordinal/predecessor/payload/seal/CAS/readback error typed并A3 rollback；caller mechanical-cancel；one immediate tx；exact replay要求same live handle才可authorize；algorithm build exact M1 input without resource validation→A3 lookup/A4 or first-apply proof checks→M1 receipt decode；runtime resource留M2。
- **Test IDs**：T-O2-001..012。
- **正确性论证**：
  - **前置**：M2 proof与M4 predecessor建立fresh no-send dispatch。
  - **步骤/callee**：M1 codec固定operation3/receipt family；A3 unique cursor/head CAS与fold建立ordinal连续和immutable receipt。
  - **全部错误/rollback**：proof/commit/head/receipt/seal任一失败全rollback且caller cancel；response loss只A5；无slot rotation。
  - **后置**：success ledger durable且samehandle尚未release。
  - **副作用穷尽**：SQLite transaction；M2后续cancel/authorize；无provider/tool/public internal publish。
  - **不变量保持**：M4-I1–M4-I5/M4-I7/M4-I9。
  - **终止**：A3/A5 bounded。

### 6.3 O3 `commitToolEvidence`

```ts
export function commitToolEvidence(
  input: M1.RecoveryOperationInputV1<"tool-evidence-recorded">,
): Effect.Effect<
  M1.OperationCommitResultV1<"tool-evidence-recorded">,
  M4.RecoveryAuthorityErrorV1
>
```

- **Owner/落点/Callers**：M4 source-fact wrapper；M3 tool begin/plan/outcome settlement adapters。
- **Callees**：M1 ToolEvidence exact validator、A2/A3、source-fact receipt codec。
- **Requires**：committed source assistant；stable operationID；payload evidence exact为M1 `AuthoritativeToolEvidenceV1`，完整携`callOrdinal`、M1 phase literal、arguments/result-or-error replay carriers与其`finalPlanDigest/callDigest/resultDigest`（按phase presence）；M3保证evidence immutable且side effect发生在对应durable boundary合同内；no prepared handle/policy parameter。restart reconciliation只能走O3a。
- **Ensures**：raw+append-only tool snapshot+aggregate cursor原子；SQL row完整保存phase/carriers/commitments/order/source range并同tx read-back重算；不推进三个recovery head；stored receipt exact。
- **Errors/transaction/replay/resource/algorithm**：malformed/illegal phase transition/unknown-as-false/carrier缺失或digest-only/order/predecessor/DB/readback typed；A3 immediate tx rollback；exact replay A4；algorithm exact carrier+phase validate→A3→decode receipt；M4不调用tool body/hook且无runtime resource。
- **Test IDs**：T-O3-001..016。
- **正确性论证**：
  - **前置**：M3 stable immutable evidence与committed source。
  - **步骤/callee**：M1 validator建立closed transition；A2验证prior fold；A3 insert/readback建立raw=tool snapshot。
  - **全部错误/rollback**：非法回退、unknown伪false、schema/CAS/DB/readback均rollback；replay mismatch零写失败。
  - **后置**：success追加一个authority fact且不改heads。
  - **副作用穷尽**：SQLite only；不调用tool hook/body/provider/publication。
  - **不变量保持**：M4-I1–M4-I7/M4-I9。
  - **终止**：finite evidence/fold、bounded tx。

### 6.3.1 O3a `reconcileInterruptedToolExecution`

```ts
export function reconcileInterruptedToolExecution(
  input: M1.RecoveryOperationInputV1<"tool-evidence-recorded">,
): Effect.Effect<
  M1.OperationCommitResultV1<"tool-evidence-recorded">,
  M4.RecoveryAuthorityErrorV1
>
```

- **Owner/Callers**：M4 restart reconciler；M3 startup/session-resume coordinator是唯一caller。它不是tool executor，不能持有body/after-hook callback。
- **Requires**：input evidence必须是M1 `AuthoritativeToolEvidenceV1`且phase exact为`reconciled-terminal-manual-only`；same call的latest raw phase只能是`planned|body-outcome-durable|unknown-intermediate`，或same operation exact replay。planned/unknown branch使用unknown/unknown；body-outcome branch保留completed/error bodyState及既有carrier/commitments但afterHookState固定unknown。`rerunBody/rerunAfterHook`均forbidden。
- **Workflow**：single WAL read定位same assistant/callOrdinal latest authoritative fact→验证old phase与new reconciled branch的closed transition、same callID/name/planRevision/source identity/order→验证任何保留carrier/commitment exact→调用A3 type-4 append→read-back latest tool row与raw fold→return complete result。若同operation已存在则A4 exact replay；若另一个terminal phase已赢则closed conflict/reload，不覆盖。
- **Errors/rollback**：missing/duplicate call、phase regression、attempt to add invented result/error、carrier/digest/order mismatch、DB/CAS/readback failure typed并A3 rollback。任何错误都不调用tool body/after-hook；corrupt intermediate fatal，不以Legacy/current part猜状态。
- **Post**：成功只增加一条no-side-effect raw transition并使该call terminal-manual-only；O6 barrier可继续，M5 automatic永远禁止。
- **Side effects/termination**：SQLite read+one A3 transaction only；tool/provider/hook hits=0；finite single-call fold，busy bounded。
- **Test IDs**：T-O3A-001..014。

### 6.4 O4 `commitReasoningEvidence`

```ts
export function commitReasoningEvidence(
  input: M1.RecoveryOperationInputV1<"reasoning-evidence-recorded">,
  pendingSeals: readonly M4.PendingSealV1[],
): Effect.Effect<
  M1.OperationCommitResultV1<"reasoning-evidence-recorded">,
  M4.RecoveryAuthorityErrorV1
>
```

- **Owner/落点/Callers**：M4 source-fact wrapper；M3 reasoning checkpoint/flush producer。
- **Callees**：M1 reasoning/ref validators、K1 output validator、K2、A2/A3、source-fact receipt codec。
- **Requires**：committed source；M3 provenance exact/immutable；payload evidence完整携M1 reasoning `content?:RecoveryReplayPayloadV1`、`textDigest?`、stateRefs与sourceRange；`prepared=undefined`。inline content必须已证明非敏感，敏感text/state只用purpose-exact pending sealed refs；`pendingSeals`按refID exact等于content/state ref metadata/commitments，scope/target/assistant匹配。该branch不允许M2 package。
- **Ensures**：parent raw是initial sealed rowsgenesis authority；raw+reasoning materialization（含content carrier）+pending seals+cursor原子；K2写creation tuple；同tx按reasoning-text owner builder重算commitment并read-back；无plaintext durable residue，public projection零content/ref/digest。
- **Errors/transaction/replay/resource/algorithm**：provenance/ref/scope/plaintext sentinel/write/CAS/readback typed；A3 immediate tx rollback包括K2 rows；exact replay不persist seals；algorithm validate refs→A3/K2→receipt；pending ciphertext由caller在return后释放。
- **Test IDs**：T-O4-001..014。
- **正确性论证**：
  - **前置**：M3 immutable provenance与K1 pending refs。
  - **步骤/callee**：M1 validators建立provenance/scope；K2+A3同tx建立seal/raw/reasoning一致；A2/readback验证fold。
  - **全部错误/rollback**：plaintext/provenance/ref/write任一失败整体rollback，无orphan；replay不重seal。
  - **后置**：success only ciphertext refs durable且reasoning fact exact。
  - **副作用穷尽**：SQLite ciphertext/authority writes；无provider/key callback/publication。
  - **不变量保持**：M4-I1–M4-I7/M4-I9。
  - **终止**：finite refs/fold、bounded tx。

### 6.5 O5 `commitProviderPrefix`

```ts
export function commitProviderPrefix(
  input: M1.RecoveryOperationInputV1<"provider-prefix-recorded">,
  pendingSeals: readonly M4.PendingSealV1[],
): Effect.Effect<
  M1.OperationCommitResultV1<"provider-prefix-recorded">,
  M4.RecoveryAuthorityErrorV1
>
```

- **Owner/落点/Callers**：M4 source-fact wrapper；M3 provider-prefix checkpoint producer。
- **Callees**：M1 `OperationSchemaByTypeV1["provider-prefix-recorded"]["payload"]["checkpoint"]`/ref validators、K2、A2/A3、source-fact receipt codec。
- **Requires**：committed source；M3 checkpoint exact/immutable/stable operationID，完整携M1 `OperationSchemaByTypeV1["provider-prefix-recorded"]["payload"]["checkpoint"]["content"]` canonical-wire carrier、prefix/ancestry commitments、protocol/target/source identity；`prepared=undefined`。secret cursor/state必须purpose `provider-prefix-content` sealed ref；`pendingSeals`与payload refs/metadata/commitments/scope exact。该branch不接受prepared package。
- **Ensures**：raw prefix fact是initial sealed rowsgenesis authority；pending seals与cursor原子，K2记录parent tuple；A2/S1/R1从raw完整重放carrier并重算prefix+ancestry commitments，无第八SQL表、无digest-only checkpoint、无raw secret/public carrier。
- **Errors/transaction/replay/resource/algorithm**：checkpoint/gap/ref/scope/CAS/write/readback typed；A3 immediate rollback包括seals；replay不重seal；algorithm validate checkpoint/refs→A3→receipt；pending buffers释放。
- **Test IDs**：T-O5-001..011。
- **正确性论证**：
  - **前置**：M3 immutablecheckpoint、committed source、valid pending refs。
  - **步骤/callee**：M1 validator建立checkpoint exact；K2/A3建立raw/ref atomicity；A2使raw slice进入full snapshot fold。
  - **全部错误/rollback**：gap/ref/write/readback任一失败rollback；sameID mismatch冲突零写。
  - **后置**：success snapshot可从raw重获exact prefix fact。
  - **副作用穷尽**：SQLite only；无provider/publication/plaintext。
  - **不变量保持**：M4-I1–M4-I7/M4-I9。
  - **终止**：finite refs/fold、bounded tx。

### 6.6 O6 `commitIncompleteTerminal`

```ts
export function commitIncompleteTerminal(
  input: M1.RecoveryOperationInputV1<"incomplete-terminal-recorded">,
): Effect.Effect<
  M1.OperationCommitResultV1<"incomplete-terminal-recorded">,
  M4.RecoveryAuthorityErrorV1
>
```

- **Owner/落点/Callers**：M4 source-fact wrapper；M3 drain/terminal settlement。
- **Callees**：M1 terminal/tool/reasoning/safe projection validators、A2/A3、source-fact receipt codec。
- **Requires**：source committed；M3 terminal fact immutable/stable operationID；每个observed tool call的latest durable phase必须是`final-after-hook-settled`或经O3a追加的`reconciled-terminal-manual-only`，不得仍是planned/body-outcome/unknown intermediate；reasoning已settled到允许terminal的fold；terminal事实完整。
- **Ensures**：raw terminal fact+允许的tool/reasoning final snapshots+safe projection delta+aggregate cursor原子；不直接创建decision。reconciled call允许barrier close但在S1 view中固定manual-only，不能因为terminal已commit而变成Continue。
- **Errors/transaction/replay/resource/algorithm**：barrier/schema/transition/projection/CAS/readback typed；A3 immediate rollback；exact replay A4；algorithm A2 barrier→validate terminal→A3→receipt；无handle/runtime resource。
- **Test IDs**：T-O6-001..014。
- **正确性论证**：
  - **前置**：source committed且tool/reasoning settlement barrier由fresh raw prefix证明。
  - **步骤/callee**：A2 pre-fold验证barrier；M1 terminal validator建立完整terminal fact；A3在同tx写raw、允许的tool/reasoning delta与M1 safe SQL projection并read-back。
  - **全部错误/rollback**：未settled、illegal transition、terminal schema、safe projector/codec、raw/materialization/readback任一失败均A3整体rollback；commit后public notification failure只diagnostic，不改变已一致的SQL projection/raw。
  - **后置**：success时terminal与其所依赖source facts同一high-water，且没有decision提前创建。
  - **副作用穷尽**：只含SQLite authority transaction；不调用classifier/provider/tool body或public raw event publisher。
  - **不变量保持**：M4-I1–M4-I7/M4-I9。
  - **终止**：A2/A3遍历finite prefix/delta且busy retry有界。

### 6.7 O7 `commitManualStop`

```ts
export function commitManualStop(
  input: M1.RecoveryOperationInputV1<"decision-finalized">,
  disposition: M2.NoPreparedHandleProofV1 | M2.MechanicallyCancelledUnreleasedHandleProofV1,
): Effect.Effect<
  M1.OperationCommitResultV1<"decision-finalized">,
  M4.RecoveryAuthorityErrorV1
>
```

- **Owner/落点/Callers**：M4 control-operation wrapper；M6 `finalizeManualStop` only。
- **Callees**：exact `M2.validateNoPreparedHandleProofV1` / `M2.validateMechanicallyCancelledUnreleasedHandleProofV1`、M1 decision/safe projection/receipt validators、A3/A4/A5。
- **Requires**：仅M1 type-8 ManualStop-finalization可调用；decision material canonical且足以确定性重建完整record。Caller已经完成`mechanical cancel或no-handle barrier → automatic K9 close/zeroize（若曾取得lease）→ resource cleanup`；若曾创建handle，传入的M2 proof是cleanup保留的secret-free one-shot cancel-proof tombstone并证明send closure unreachable，released/unknown-send不能使用此函数声称zero-hit。若此前automatic commit返回failure/unknown，caller必须在上述K9/cleanup后由A5/S2 exact lookup证明operation absence且无winner，并重新验证source binding仍fresh；corrupt/partial/ambiguous authority不得转ManualStop。
- **Ensures**：raw decision、decision row、M1 safe projection、recovery head、aggregate cursor原子；无child/consumption；M4不cleanup runtime resource。Complete result返回后caller立即使one-shot tombstone失效；commit response unknown只可用同operation A5 resolution，不能创建新proof或恢复已cleanup resource。
- **Ordering**：`mechanical cancel或no-handle barrier → K9 close/zeroize（如适用）→ cleanup并保留secret-free one-shot tombstone → A5/S2/S1验证 → commitManualStop → complete result → tombstone invalidation`。K9失败在cleanup/lookup/commit前fatal；该顺序不可倒置。
- **Errors/transaction/replay/resource/algorithm**：invalid disposition在tx前失败；decision/head/DB/readback由A3 rollback；response lossA5；algorithm validate one-shot disposition→validate decision→A3→stored complete result；M4不持runtime resource，cleanup已经由M6完成。非response-loss failure保持session fatal stop，不能重新prepare或复用tombstone提交不同operation。
- **Test IDs**：T-O7-001..014。
- **正确性论证**：
  - **前置**：M2 proof已经建立无可达send closure或根本无handle；automatic lease已K9 closed/zeroized，runtime resource已cleanup，仅保留secret-free one-shot disposition tombstone；A5/S2/S1在cleanup后证明absence/no-winner/fresh source。
  - **步骤/callee**：one-shot proof validator不把tombstone持久化；M1 decision validator固定manual-stop lifecycle；A3提交raw/decision/projection/head；complete result后caller使tombstone失效。
  - **错误/rollback**：cancel proof invalid时M4不begin；decision/CAS/DB/readback失败A3 rollback，但handle仍cancelled且resource已cleanup；response loss仅A5同operation resolution；不存在失败后automatic/release/reprepare fallback。
  - **后置**：success durable ManualStop且无child、tombstone失效；failure保持unsendable并由M6 fatal stop。
  - **副作用穷尽**：M4只写SQLite；mechanical cancel/K9/cleanup是更早的M2/M6 side effect且顺序明确；无provider delegate。
  - **不变量保持**：M4-I1–M4-I5/M4-I7/M4-I9/M4-I11。
  - **终止**：proof validation constant；A3 bounded。

### 6.8 O8 `commitAutomaticChild`

```ts
export function commitAutomaticChild(
  input: M1.RecoveryOperationInputV1<"automatic-child-admitted-and-consumed">,
  prepared: Extract<M2.PreparedCommitPackageV1, { kind: "available" }>,
  policy: M6.RecoveryPolicyAuthorityExpectation,
  snapshotIdentity: M4.RecoverySnapshotIdentityV1,
  sealedUseLeases: readonly M4.SealedRecoveryUseLeaseV1[],
): Effect.Effect<
  M1.OperationCommitResultV1<"automatic-child-admitted-and-consumed">,
  M4.RecoveryAuthorityErrorV1
>
```

- **Owner/落点/Callers**：M4 control/admission wrapper；M6 `commitAutomaticRecovery` only。
- **Callees**：A3/A4/A5/S2与M1实际export的source/control/binding/admission/automatic-receipt validators；M2 prepared proof与owner-qualified policy tx verifier只由A3 replay miss branch调用。
- **Requires**：顺序固定为M5从`DurableRecoveryAuthorityViewV1`选择branded `M4.AutomaticRecoveryProofSliceV1` → M7只用该slice构造并经M1 builder复验target-neutral `RecoveryClosureDescriptor`（不unseal/lower）→ M2预留stable prepared-handle commitment但尚未unseal/prepare → K7以same slice+closure按每个sealed ref acquire exact live lease → M7只用该slice+closure+leases unseal/lower → M2单次prepare/original inspection → `M7.validatePreparedRecoveryInspection({ candidate, inspection })` → M5 final classification → O8；handle当前prepared/unreleased/hit=0；proposal automatic但非authority；`snapshotIdentity`逐字段等于slice/proposal/source/control，SafeRetry closure exact not-needed，Continue closure的source binding、ordered carriers/commitments/provider prefix与slice canonical equal且`closureDigest`已由M1 builder重算；`sealedUseLeases`与closure+prepared request实际使用的sealed refs双向exact并全部绑定same action/candidate/future type-9 operationID/target/prepared commitment；source/control versions、binding、N/M与aggregate/recovery heads exact；assistant-chain predecessor必须exact committed source/current assistant且非genesis；child ledger predecessorgenesis/absent，prepared available；pending seals完整。
- **Ensures**：一个transaction先执行**commit-time K8**验证same live leases，再从canonical operation payload+envelope确定性重建automatic-consumed decision，并写raw、consumption、Legacy child assistant info/message relation、child ordinal0 available ledger、safe projection、pending seals、three heads、aggregate cursor；返回完整`OperationCommitResultV1<"automatic-child-admitted-and-consumed">`。same handle与leases仍live/prepared，F27/M2 authorization/release尚未调用。返回后M2必须在不改变handle prepared状态的情况下立即执行独立**pre-release K8**；只有该K8 success才把complete result + `result.operationPostState`交F27并执行M2 exact same-handle authorization，随后release exactly once，最后K9以released关闭leases并zeroize。零sealed ref时输入/expected lease tuple均exact空。
- **禁止**：函数内prepare；无prepared commitment时commit；opaque automatic；receipt后创建新handle；partial child/decision；把commit-time K8当作pre-release K8；pre-release K8之前调用F27/M2 authorization/release。
- **Errors/transaction/replay/resource/algorithm**：prepared/policy/source/control/snapshot identity/binding/N/M/head/lease/seal/DB/receipt typed；A3 one immediate tx；exact replay不要求historical lease仍live，但只有same old handle仍prepared且独立pre-release K8成功时才可继续automatic handoff。first apply保留raw cursor前commit-time K8。CAS loser S2，response loss A5。commit/A3 failure由caller mechanical cancel后K9 close；complete result后的pre-release K8 failure固定prepared→mechanically-cancelled，F27 calls=0、M2 authorization calls=0、release calls=0，再K9 mechanically-cancelled/abandoned close与zeroize；若handle lost则lost-handle cleanup。任何failure不延长/revive lease。
- **Test IDs**：T-O8-001..028。
- **正确性论证**：
  - **前置**：prepared proof、snapshot/binding/policy expectation成立。
  - **步骤/callee**：M2 proof建立same unreleased handle；commit-time K8在A3 tx内证明same snapshot/operation/handle的lease set仍live且sealed generation未变；transaction-local policy read建立current epoch/digest；A3 fold同时建立decision/consumption/child/ledger/heads；M1 receipt validator把receipt绑定同handle；A3返回complete type-9 result且handle仍prepared→M2立即调用独立pre-release K8→仅其success后把complete result+operationPostState交F27→M2 exact same-handle authorization→single release→K9。
  - **错误/rollback**：policy/head/source/control/binding/N/M/prepared/seal任一stale→rollback、无receipt，callercancel；CAS loser→S2从winning head发现并验证winner；本operation commit response loss→A5用完整expected input；receipt mismatch→不authorize。pre-release K8 missing/closed/stale/mismatch/DB failure不回滚已commit type-9 authority，但必须mechanical cancel still-prepared handle，F27/authorization/release calls=0，再K9/zeroize。
  - **后置**：成功的automatic authority与唯一child/dispatch不可拆分；只有complete type-9 result之后、same handle仍prepared且pre-release K8 success的动态scope可进入F27/M2 exact authorization并release once。
  - **副作用穷尽**：O8/M4只含SQLite composite；无provider/tool/public raw publication；A3/O8不修改handle。caller handoff side effects严格为pre-release K8 read，随后二选一：success的F27+M2 authorization+single release+K9，或failure的mechanical cancel+K9；两branch都zeroize。
  - **不变量保持**：M4-I1–M4-I10，尤其no receipt-before-prepare与single child。
  - **终止**：A3/bounded response resolution；无busy-spin。

### 6.9 O9 `commitNewInputSupersession`

```ts
export function commitNewInputSupersession(
  input: M1.RecoveryOperationInputV1<"source-superseded">,
): Effect.Effect<M4.NewInputSupersessionCommitResultV1, M4.RecoveryAuthorityErrorV1>
```

- **Owner/落点/Callers**：M4 control-operation wrapper；M6 `supersedeBeforeNewUserInput`唯一caller。
- **Callees**：M1 source-superseded input/receipt/decision validators、A3、S2、A5（仅本operation response loss）。
- **Requires**：new input尚未形成user/message/assistant/dispatch authority或prepared handle；old source/recovery head unresolved且fresh；old paused recovery handle已由M6 mechanical cancel（若存在）。payload是M1 exact closed union且两branch都持久化完整`supersessionBindingInput`与`supersessionBindingDigest`，input common fields逐项等于payload source/control/session与expected predecessors并含submissionPayloadDigest，decision中的同名input/digest也必须exact相等。`supersessionKind:"model"`要求binding kind model、`reservedInitialOperationID==binding.intendedInitialOperationID`；`supersessionKind:"no-reply"`要求binding kind no-reply、`replyDisposition:"commit-user-only"`并机械排除reserved/type-1 fields。O9调用M1 `supersession-binding-v1` builder+F22重算，禁止只信stored digest；两branch都携带足以从full binding input+payload+envelope确定性重建superseded decision的canonical material，且superseded record使用`supersessionBindingDigest`而非automatic/manual `BindingDigest`。
- **Ensures**：`superseded` branch只提交old source superseded decision/safe projection append/recovery head/aggregate cursor并返回完整type-10 result；model post-state保留reservation与exact post aggregate head，no-reply post-state明确无reservation。`automatic-winner` branch零写并返回S2/A4验证的完整type-9 result。两者都不创建new input、新assistant/dispatch/consumption；no-reply result不能生成model preparation proof。
- **Errors/transaction/replay/resource/algorithm**：A3 immediate tx；algorithm validatecandidate-nonauthority→A3 CAS→success map `superseded` / CAS loser S2→automatic map `automatic-winner` / manual-or-existing-superseded按closed conflict rule / response loss A5；storage/corruption无valid winner fatal；无newhandle resource。
- **Winner rules**：O9自身永不进入M7/M2。CAS success只把exact receipt交回O10验证；automatic consumed winner由O10/M6调用S1 reload并steer/queue；storage failure且无valid winner→fatal stop。
- **Test IDs**：T-O9-001..014。
- **正确性论证**：
  - **前置**：new candidate无authority，old predecessor exact。
  - **步骤/callee**：M1 exact codec固定model/no-reply full supersession-binding input fields与branch exclusion；`supersession-binding-v1` builder/F22证明submission/source/control/predecessor及model intended ID或no-reply disposition完整，且digest不是automatic/manual BindingDigest；A3 recovery-head CAS给出old supersession/automatic全序；success从persisted full binding input+decision material+envelope确定性fold source-superseded；CAS loser调用S2从head.operationID验证closed winner。
  - **错误/rollback**：CAS lost时无supersession write，S2 missing/corrupt则fatal而非猜测；DB/readback失败rollback；任何failure path不调用O1/M2 release。
  - **后置**：success后old source不能再被old proposal消费；但new input仍无authority，直到后续O1成功。
  - **副作用穷尽**：仅old recovery SQLite authority；无new-lineage/public wrapper/provider side effect。
  - **不变量保持**：I10直接成立，M4-I1–M4-I7/I9保持。
  - **终止**：单CAS+一次winner reload；不spin。

### 6.10 O10 `commitAndValidateSupersessionBeforePrepare`

M4唯一拥有并export以下proof；no-reply没有对应proof：

```ts
export type SupersessionBeforePrepareProofV1 =
  | Readonly<{
      proofVersion: 1
      kind: "model-supersession"
      sessionID: string
      aggregateID: M1.RecoveryAggregateID
      submissionPayloadDigest: M1.CanonicalDigestValue
      intendedInitialOperationID: M1.RecoveryOperationID
      supersessionOperationID: M1.RecoveryOperationID
      supersessionBindingInput: Extract<M1.SupersessionBindingDigestInputV1, { kind: "model" }>
      supersessionBindingDigest: M1.SupersessionBindingDigest
      aggregateEventHead: M1.AdmissionPlan["expectedHeads"]["aggregateEventHead"]
      recoveryHead: M1.OperationSchemaByTypeV1["decision-finalized"]["expectedPredecessors"]["recoveryHead"]
      validatedHighWater: M1.AdmissionPlan["expectedHeads"]["aggregateEventHead"]
      readonly [supersessionBeforePrepareProofBrand]: true
    }>
  | Readonly<{
      proofVersion: 1
      kind: "model-no-unresolved-source"
      sessionID: string
      aggregateID: M1.RecoveryAggregateID
      submissionPayloadDigest: M1.CanonicalDigestValue
      intendedInitialOperationID: M1.RecoveryOperationID
      aggregateEventHead: M1.AdmissionPlan["expectedHeads"]["aggregateEventHead"]
      recoveryHead: M1.OperationSchemaByTypeV1["decision-finalized"]["expectedPredecessors"]["recoveryHead"]
      validatedHighWater: M1.AdmissionPlan["expectedHeads"]["aggregateEventHead"]
      readonly [supersessionBeforePrepareProofBrand]: true
    }>
```

proof是unforgeable exact value：除exact codec外还含module-private `supersessionBeforePrepareProofBrand: unique symbol` property，export consumer无法structurally construct或deserialize补brand；codec验证branch、owner、session/aggregate、candidate binding、heads与high-water，M4只在same-tx validation全部成功后附加brand。model-supersession branch还验证type-10 operationID/full model supersession binding input+digest/intended operationID。proof不含runtime handle/prepared facts，不是authority receipt，也不能从no-reply result构造。

O10不是第11个M1 operation，也不拥有M6 orchestration；它是M4唯一的supersession persistence/result-validation gate。入口不接受M7 candidate、`M2.PreparedCommitPackageV1`或admission input：

```ts
export function commitAndValidateSupersessionBeforePrepare(input: Readonly<{
  candidate: M6.UnpreparedNonAuthoritativeNewInputCandidate
  supersession:
    | Readonly<{
        kind: "complete-expected-input"
        expectedInput: M1.RecoveryOperationInputV1<"source-superseded">
        expectedPayloadDigest: M1.OperationPayloadDigest
      }>
    | Readonly<{
        kind: "inspect-current-authority"
        expectedAggregateEventHead: M1.AdmissionPlan["expectedHeads"]["aggregateEventHead"]
      }>
}>): Effect.Effect<M4.SupersessionBeforePrepareResultV1, M4.RecoveryAuthorityErrorV1>
```

`inspect-current-authority`直接读取C1/MIG1 dedicated owner mapping与current aggregate/recovery heads；empty aggregate使用exact genesis并证明无unresolved source，nonempty只按raw fold识别closed winner/source state。它不构造`M1.DurableRecoverySnapshot`，也绝不尝试在缺少完整type-10 input时调用O9：若发现exact unresolved source，唯一合法返回是`{kind:"supersession-required",authority}`，其中branded authority已包含构造完整type-10所需的same-tx source/control/predecessor facts；caller构造完整`M1.RecoveryOperationInputV1<"source-superseded">`与payload digest后，必须以`complete-expected-input` branch再次进入O10。O10产出的`M4.SupersessionBeforePrepareProofV1`是唯一后续type-1 proof；O1原样接收，A3只在scoped replay miss后的first-application branch复验。M4不复制M2 handle proof，也不接收M6 structural source-snapshot proof。

- **Owner/落点/Callers**：M4 control persistence service；M6 serialized submission sequencing是唯一caller。只有`model-*` continuation可进入existing ordinary converter → M2 → O1；`no-reply-*` continuation只能进入user-message commit；`supersession-required`只能进入M6 complete type-10 input builder再回调O10。
- **Callees contracts**：candidate exact validator证明unprepared/non-authoritative及model/no-reply closed union；`complete-expected-input` branch先用M1 exact input/payload builder重算，再调用O9并用A5以完整`expectedInput/expectedPayloadDigest`恢复/验证complete result；`inspect-current-authority` branch在一个DEFERRED tx内直接验证C1/MIG1 owner mapping、P3R/A2 current prefix、relation/current heads并调用M1 F6/F7 source/control builders；automatic winner branch才用S2/S1 reload exact terminal winner snapshot。O10不调用policy read、M7、M2、O1、authorize或release。
- **Requires**：candidate未lower/prepare且IDs stable；两branch candidate都携带exact `submissionPayloadDigest`，model另携`intendedInitialOperationID`，no-reply机械排除该ID并固定user-only disposition；candidate在inspection前**不可能**拥有source/control/predecessor-dependent binding digest。`complete-expected-input`的type-10 input必须字段完整、branch与candidate一致，其persisted `supersessionBindingInput/digest`与decision copy必须通过M1 builder/F22，且sourceVersion/controlTailVersion/expectedPredecessors exact等于先前inspection authority或fresh same facts，submission digest/branch fields exact等于candidate；inspect branch的expected aggregate head来自same serialized owner的dedicated current-authority read，empty时为C1/MIG1 genesis；进入函数时不存在new-input message/user/assistant/dispatch authority。
- **Workflow/branches**：
  1. exact validate candidate与union；只验证pre-inspection可知的submission digest、model intended operationID或no-reply disposition，禁止要求/接受预先构造的supersession binding digest；
  2. `complete-expected-input`先对完整expected input执行M1 exact codec、`supersession-binding-v1` builder/F22、operation payload digest与candidate submission/branch/intended-ID、source/control/predecessor、payload↔decision binding-copy cross-check，再调用O9。`superseded` outcome立即由A5验证完整type-10 result、historical/current prefixes与post heads；model返回`model-supersession-validated` + proof，proof aggregate head等于result.operationPostState exact post head；no-reply返回`no-reply-supersession-validated`且绝不构造proof；`automatic-winner` reload并验证complete type-9 result/head/snapshot一致，不产生proof；
  3. `inspect-current-authority`只打开一个DEFERRED read tx，pin committed owner mapping/cursor，以P3R/A2验证dedicated current prefix/head而不调用`loadRecoverySnapshotInTransaction`。empty aggregate要求exact C1/MIG1 genesis且raw/derived/heads为空；nonempty要求current fold完整。若无unresolved terminal source，model branch在tx内构造`model-no-unresolved-source` proof，no-reply branch只返回user-only continuation。若存在exact unresolved terminal source且没有control winner，则在same tx从validated fold构造M1 `OperationSchemaByTypeV1["decision-finalized"]["payload"]["sourceVersion"]`、`OperationSchemaByTypeV1["decision-finalized"]["payload"]["controlTailVersion"]`、committed source assistant/context、type-10 exact `{aggregateEventHead,recoveryHead}` predecessors与`nextDecisionRevision`，最后重读cursor/owner mapping并仅在相等时附加private brand，返回`supersession-required`；本branch不调用O9、不分配decision/operation payload、不返回partial proof。若current head指向automatic winner，才走S2/S1 automatic branch；manual/superseded已决source属于no-unresolved closed outcome。任何head变化为stale conflict；
  4. caller收到`supersession-required`后必须用authority+candidate逐字段构造M1 complete `SupersessionBindingDigestInputV1`：common含source/control versions+digests、session、submissionPayloadDigest、exact predecessors；model另含intended operationID，no-reply另含`replyDisposition:"commit-user-only"`。调用M1 builder得到digest，并把full input+digest exact复制进type-10 payload与`M1.OperationSchemaByTypeV1["source-superseded"]["payload"]["decision"]`，补齐decisionID/createdAt等caller-owned fields后构造完整operation input，以`complete-expected-input`重入O10。禁止直接调O9、禁止只持久化digest/operationID、禁止只传source ID/head或把authority本身当input/proof；
  5. model continuation的type-1 operationID必须等于intendedInitialOperationID；reservation branch携带`{supersessionOperationID,reservationDigest:supersessionBindingDigest}`并使用proof/result exact post aggregate head，no-source branch不携带reservation ref。no-reply continuation禁止policy/M7/M2/O1/model admission。
- **All errors/rollback/resource**：candidate/input/result/authority/proof mismatch零M7/M2 resource；corrupt、partial、owner-mismatched、non-foldable或source/control/predecessor ambiguous authority一律fatal，不转ManualStop。complete-input commit response loss只由A5同tuple恢复完整result；任何error都不返回prepare proof或partially branded authority。
- **Post**：inspection只返回no-source proof/user-only outcome、complete branded `supersession-required` authority或validated automatic winner，绝无“已发现source但缺input仍内部commit”的impossible branch。model validated branch只给后续preparation提供proof，本身没有new authority/prepare/release；no-reply branch只允许随后commit user input；automatic branch只允许reload/steer。detached receipt不能替代complete result或proof。
- **Side effects/resource lifecycle**：complete-input branch至多包含O9 SQLite supersession commit；inspection为dedicated current-authority read与local branded authority/proof allocation；automatic winner另有S2/S1-terminal/A5 reads；无policy/M7/M2/O1/provider/public publication。
- **Invariants**：保持M4-I1–M4-I5/M4-I7/M4-I9，并通过inspect→complete-input两阶段closed continuation建立M4-I10与supersession-before-prepare。
- **Termination**：closed union只走一branch；inspection一次finite fold，complete-input的O9/A5及automatic的S1/S2各至多一次有界调用，无spin。
- **Test IDs**：T-O10-001..020。

## 7. Admission authority、terminal snapshot 与 rebuild

### 7.0 Origin-specific initial/ordinary admission authority views

Initial/fresh-session与ordinary admission不得构造或消费`M1.DurableRecoverySnapshot`。M4以dedicated owner mapping/current aggregate prefix提供两个origin-specific staged views；automatic recovery仍只消费§7.1 terminal source snapshot。

```ts
export function loadInitialAdmissionAuthorityView(input: Readonly<{
  sessionID: string
  policy: M6.RecoveryPolicyAuthoritySnapshot
  userMessagePredecessor: M1.LegacyUserMessagePredecessorV1
  candidate: M1.CandidateAssistantAttemptIdentity
  context: M1.CandidateDispatchAttemptContext
  handleProof: M2.NoPreparedHandleProofV1
  supersessionProof: M4.SupersessionBeforePrepareProofV1
}>): Effect.Effect<
  M4.InitialAdmissionAuthorityViewV1<M2.NoPreparedHandleProofV1>,
  M4.RecoveryAuthorityErrorV1
>

export function bindPreparedInitialAdmissionAuthorityView(input: Readonly<{
  authority: M4.InitialAdmissionAuthorityViewV1<M2.NoPreparedHandleProofV1>
  prepared: M2.PreparedCommitPackageV1
}>): Effect.Effect<
  M4.InitialAdmissionAuthorityViewV1<M2.PreparedUnreleasedHandleProofV1>,
  M4.RecoveryAuthorityErrorV1
>

export function loadOrdinaryAdmissionAuthorityView(input: Readonly<{
  sessionID: string
  policy: M6.RecoveryPolicyAuthoritySnapshot
  predecessor: M1.CommittedAssistantAttemptIdentity
  candidate: M1.CandidateAssistantAttemptIdentity
  context: M1.CandidateDispatchAttemptContext
  handleProof: M2.NoPreparedHandleProofV1
}>): Effect.Effect<
  M4.OrdinaryAdmissionAuthorityViewV1<M2.NoPreparedHandleProofV1>,
  M4.RecoveryAuthorityErrorV1
>

export function bindPreparedOrdinaryAdmissionAuthorityView(input: Readonly<{
  authority: M4.OrdinaryAdmissionAuthorityViewV1<M2.NoPreparedHandleProofV1>
  prepared: M2.PreparedCommitPackageV1
}>): Effect.Effect<
  M4.OrdinaryAdmissionAuthorityViewV1<M2.PreparedUnreleasedHandleProofV1>,
  M4.RecoveryAuthorityErrorV1
>
```

- **Owner/Callers**：M4 authority-read/binder service；M6 initial/ordinary admission path only。C1/MIG1只建立owner pair与genesis；这些functions在committed user/predecessor与candidate/policy存在后读取current authority，不把C1 prepared capability延长到runtime。
- **Callees/Requires**：一个DEFERRED read tx、owner/cross-role validator、P3R/A2 current aggregate fold、Legacy user/predecessor exact reader、M6 current policy snapshot verifier、M2 exact no-handle/prepared validators。initial要求committed Legacy user predecessor、matching M4 supersession proof、assistant-chain与candidate ordinal-0 ledger genesis；ordinary要求exact terminal/settled committed predecessor/current assistant-chain head与candidate ledger genesis。candidate/context逐字段same；shell/no-reply excluded。
- **Workflow**：loader pin owner+cursor→验证committed owner mapping→读取current aggregate head（raw empty时使用C1/MIG1 exact M1 aggregate genesis；nonempty时使用latest exact event head）→读取current recovery/assistant/dispatch heads而不构造terminal source→验证current policy、Legacy predecessor、candidate与`M2.NoPreparedHandleProofV1`→构造no-handle staged view→close tx。一次M2 preparation后binder只接受same candidate/context的`M2.PreparedCommitPackageV1.stateProof`，调用`M2.validatePreparedUnreleasedHandleProofV1`并返回prepared staged view；binder不重读或延长已失效的no-handle proof。
- **Branches/errors**：empty aggregate是initial合法branch且aggregate head为genesis；nonempty/post-type-10 initial使用exact current/type-10 post head。owner partial、public aggregate混用、head/policy/predecessor/candidate/proof stale、ordinary predecessor nonterminal、binder package mismatch均typed failure；loader/binder零write、零snapshot、零provider hit。M2 prepare后的failure由M6 mechanical-cancel。
- **Post/lifecycle**：view完整绑定owner mapping、current aggregate head、current policy、origin predecessor、candidate与handle-proof stage。no-handle view只供`buildAdmissionPlan`与single preparation；prepared view只供O1/A3 first apply。A3 transaction仍重读owner/current head/policy/predecessor并调用M2 validator，因此view stale不会commit。任何head/policy/proof/owner变化或cleanup使view失效。
- **Termination/proof**：loader一次finite prefix fold/readback；binder constant-time owner validator；无loop/spin。Dedicated current authority+staged M2 proof取代不可能满足M1 terminal shape的“empty/incomplete snapshot”，因此fresh initial可admit而automatic terminal snapshot边界保持。
- **Test IDs**：T-ADMVIEW-001..018。

### 7.0.1 `loadCommittedAssistantAuthorityView`（nonterminal reentry only）

```ts
export function loadCommittedAssistantAuthorityView<
  K extends M4.CommittedAssistantAdmissionOperationV1,
>(input: Readonly<{
  aggregateID: M1.RecoveryAggregateID
  sessionID: string
  assistantID: M1.RecoveryAssistantID
  admissionOperationType: K
}>): Effect.Effect<
  M4.CommittedAssistantAuthorityViewV1<K>,
  M4.RecoveryAuthorityErrorV1
>
```

- **Owner/Callers**：M4 committed-assistant authority reader；M2/M6 same-process reentry对已经由type1/type2/type9 admission commit、但尚未形成terminal incomplete source的assistant调用。public/M8、fresh admission与automatic classifier不得调用。
- **Callees/Requires**：single DEFERRED tx、owner/cross-role validator、P3R/A2、七表/三head exact readers、M1 private operation/receipt/post-state codecs与SessionOwner Legacy assistant/message exact reader。`admissionOperationType` closed为type1/type2/type9；relation必须把assistant唯一锚定到该type admission raw。caller不得传receipt/operationID作为替代selector，也不得传`M1.DurableRecoverySnapshot`。
- **Workflow/branches**：pin owner+cursor→完整P3R/A2 fold并逐row/head digest readback→按`(sessionID,assistantID)` relation定位exact admission operationID/event sequence→验证raw operation type=K及relation origin分别initial/ordinary/automatic-child→fold到该operation sequence并decode stored receipt/post-state，构造`admissionResult` with ephemeral `applyMode:"exact-replay"`→从current full fold筛选该assistant的dispatch/tool/reasoning/provider-prefix facts并要求stable-order/no-duplicate→读取current assistant-chain/dispatch-ledger/recovery/aggregate heads→拒绝该assistant已有`OperationSchemaByTypeV1["incomplete-terminal-recorded"]["payload"]["terminal"]`、finalized/superseded source decision或作为已consumed source；type9 child本身可作为新nonterminal assistant，但其parent source consumption不使child terminal→重读cursor/owner→按K条件索引assistant/context并返回generic view。
- **Errors/rollback**：owner/relation/raw/K mismatch、missing/duplicate/wrong-role Legacy row、operation-prefix/current-prefix/receipt/table/head digest divergence、terminal/closed assistant、busy/read均typed；zero write，不repair、不fallback public history。terminal incomplete必须由caller改用S1，不能返回`nonterminal:true`的partial view。
- **Post/lifecycle**：成功view的admission result、assistant/context、current heads与assistant facts来自同一WAL snapshot；`origin`由K exact决定且`nonterminal:true`。view只服务当前same-process reentry判断，任一新raw/head/terminal fact提交后失效；它与S1 terminal snapshot互斥且不可互转。K=type9的replay result本身不授权transport：只有原same handle仍prepared时才可立即pre-release K8，success后F27→M2 exact authorization→release once→K9；failure cancel且F27/authorization/release calls=0→K9/zeroize。
- **Side effects/termination**：一个read tx与finite prefix/fact scans/local immutable values；无write/prepare/authorize/release/provider/publication；busy最多3，无spin。
- **Test IDs**：T-COMMITTED-VIEW-001..016。

### 7.0.2 `buildRecoveryAssistantPublicMappingInTransaction`

```ts
export function buildRecoveryAssistantPublicMappingInTransaction(
  tx: M4.RecoveryReadOrWriteTransaction,
  input: Readonly<{
    owner: M4.SessionRecoveryAggregateOwnerViewV1
    folded: M4.RecoveryFoldedStateV1
    sourceVersion: M1.OperationSchemaByTypeV1["decision-finalized"]["payload"]["sourceVersion"]
    controlTailVersion: M1.OperationSchemaByTypeV1["decision-finalized"]["payload"]["controlTailVersion"]
    latestDecision:
      | Readonly<{ kind: "absent" }>
      | Readonly<{ kind: "present"; value: M1.RecoveryDecisionRecord }>
  }>,
): Effect.Effect<M1.RecoveryAssistantPublicMappingV1, M4.RecoveryAuthorityErrorV1>
```

- **Owner/Callers**：M4 same-transaction mapping builder；只被S1 transaction helper及其同tx snapshot readback调用。M8/public projector/rebuilder display-ID allocator不是caller。
- **Requires/Callees**：tx active且已pin owner/cursor；`folded.aggregateID/aggregateEventHead`来自该tx P3R/A2；source/control versions已由M1 F6/F7从同fold构造；latestDecision selector与fold exact。callees为SessionOwner Legacy assistant-message relation exact reader、M1 `RecoveryAssistantPublicMappingV1` exact codec与owner/head reread helper。
- **Exact algorithm**：验证owner/session/aggregate与source/control high-water/digests→从fold relations收集snapshot引用的source、decision child与其它M1 snapshot-required committed assistant IDs，binary sort/dedup→每个ID在same tx读取exactly-one existing Legacy assistant message，要求same session、assistant role且relation identity/digest与raw fold一致；absent/duplicate/wrong-role/cross-session均fail closed→entries按assistantID binary order编码为`{assistantID,publicMessageID,role}`→构造`snapshotIdentity={sessionID,sourceAssistantID,sourceHighWater,sourceVersionDigest,controlTailVersionDigest,latestDecisionRevision?}`，其中optional revision只在present branch写入且值exact等于decision.revision→M1 exact codec round-trip→重读owner/cursor unchanged→return。
- **Errors/post/side effects**：任一mapping/source/control/decision/head/codec/read error不返回partial mapping；不分配display ID、不从message history猜测、不begin/commit/write。success mapping与S1其它字段来自exact same WAL snapshot，entries只是internal assistant→existing public message证据。finite IDs各一次read+sort，无spin。
- **Test IDs**：T-PUBMAP-001..012。

### 7.1 S1 `loadRecoverySnapshot` / transaction-local helper

```ts
export function loadRecoverySnapshot(input: Readonly<{
  aggregateID: M1.RecoveryAggregateID
  sessionID: string
  sourceAssistantID: M1.RecoveryAssistantID
}>): Effect.Effect<M4.DurableRecoveryAuthorityViewV1, M4.RecoverySnapshotReadErrorV1>

export function loadRecoverySnapshotInTransaction(
  tx: M4.RecoveryReadTransaction,
  input: Readonly<{
    aggregateID: M1.RecoveryAggregateID
    sessionID: string
    sourceAssistantID: M1.RecoveryAssistantID
  }>,
): Effect.Effect<M4.DurableRecoveryAuthorityViewV1, M4.RecoverySnapshotReadErrorV1>
```

- **Owner/落点/Callers**：M4 terminal recovery snapshot service。public S1只被M3 terminal reload、M5 classifier、M6 automatic recovery/reentry与M2 same-process resume validator调用；transaction-local helper只被S1与S2调用。Initial、fresh-session、ordinary与new-input no-source checks必须使用§7.0/O10 dedicated authority reads，禁止调用S1。
- **Callees contracts**：owner validator验证C1 pair及recovery kind；P3R读取recovery raw；A2只接受dedicated internal prefix；authority-row verifier；七表/三head readers；M1 exported terminal snapshot/source/control builders；§7.0.2 `buildRecoveryAssistantPublicMappingInTransaction`在同一个tx内构造M1 exact mapping。helper不begin/commit，S1 wrapper只begin一个DEFERRED transaction。
- **Requires**：caller使用M1 aggregate selector `aggregateID`且不拼接SessionStore/public projection作为额外truth；helper tx active且已pin同一WAL snapshot；`sourceAssistantID`必填并且exact source已有durable `M1.OperationSchemaByTypeV1["incomplete-terminal-recorded"]["payload"]["terminal"]`。Empty aggregate、pre-assistant session、initial/ordinary candidate均不满足pre，不能构造`M1.DurableRecoverySnapshot`。
- **Workflow/branches**：
  1. S1 begin DEFERRED并第一次读取owner pair+recovery cursor以pin snapshot，然后调用helper；helper caller直接从其现有tx开始；
  2. 验证recovery/sealed pair存在、角色/owner/cross-role uniqueness；以M1 exact `{kind:"aggregate-genesis",hashVersion:1,aggregateID}`+`event-chain-v1` builder重算recovery genesis并比较cursor，ownerSessionID/aggregateKind不得混入该digest。missing/partial pair立即typed inconsistent，不lazy create/repair；
  3. empty cursor、source absent、source nonterminal或terminal fact不属于该source立即返回typed ineligible/inconsistent，不构造snapshot；
  4. 按`seq<=highWater`用P3R读取完整internal raw、读取append-only七表（projection含history+current view）与三head→A2→逐字段compare→定位exact terminal source并用M1 F6/F7构造source/control versions与latest-decision selector；tool SQL rows必须逐项等于raw `AuthoritativeToolEvidenceV1`并完整读回phase、callOrdinal、arguments/result-or-error carriers及三commitments；reasoning rows完整读回content carrier；provider-prefix从raw完整读回content+prefix/ancestry commitments；
  5. 在same WAL snapshot使用M1 old-row decoder枚举全部Legacy compatibility tool parts，只构造`M1.CompatibilityToolEvidenceV1[]`，不读取其payload作为replay source；把A2 authoritative数组与compatibility数组按各自ordinal排序、拒绝duplicate后构造M1 `CanonicalToolEvidencePartitionV1`。四个cardinality branch total/disjoint：只有(0,0)为truly-empty；compatibility-only/mixed永不折叠empty；
  6. 从authoritative tool/reasoning/provider-prefix carriers提取全部sealed refs；在same tx读取P3S并以P3R+P3S→K0重建current sealed authority，逐ref验证parent creation tuple、scope/purpose/assistant/target/material commitment/generation/state/key metadata与physical metadata exact。redacted/unreadable ref只能产生manual-only cause；current `generation=0`也不能伪装成M1 `SealedRecoveryUseLeaseKeyInputV1.sealedGeneration:SafePositiveInt`，因此含该ref的snapshot本次固定manual-only，只有显式K4先把它合法rotate到positive generation并重新S1才可重新评估。S1不自动rotate、不从Legacy/history补内容、不decrypt，也不提前构造需要future candidate/operation/prepared-handle commitment的use lease；
  7. 在同一tx调用`buildRecoveryAssistantPublicMappingInTransaction`，构造完整M1 `DurableRecoverySnapshot`后生成`RecoverySnapshotIdentityV1`并双向比较snapshot/source/control/mapping/latest revision。随后按partition+phase及action所需sealed/snapshot prerequisites closed switch构造nominal tool eligibility：truly-empty且SafeRetry所需refs/metadata均有效→附`automaticRecoveryProofSliceBrand`的safe-retry slice，携M1 `RecoveryClosureDescriptor` exact `{status:"not-needed",action:"safe-retry"}`；authoritative-only且每项final-after-hook-settled、tool/reasoning/provider-prefix carrier、commitment与sealed metadata全通过，且snapshot `durableContinuation`与source version checkpoint canonical equal→按callOrdinal一一构造tool proofs、按durable order构造provider-end reasoning proofs及唯一raw-anchored provider-prefix proof，再附brand构造Continue slice，其`closureSourceBinding`逐字段等于snapshot aggregate/source/source+control digests；checkpoint missing/duplicate/mismatch、compatibility-only/mixed或任一nonfinal/reconciled/inconsistent authoritative item→manual-only nonempty causes。不存在fallback、structural fake brand或空Continue proof slice；S1返回后M7先从slice构造target-neutral closure但不得unseal/lower，M2再提供reserved prepared-handle commitment，K7以same slice+closure及该snapshot identity对应的source/action/candidate/operation exact key acquire lease，成功后才可真正unseal/lower/actual prepare；
  8. 用complete snapshot、identity、eligibility附`recoverySnapshotAuthorityViewBrand`构造`M4.DurableRecoveryAuthorityViewV1`；M5可读完整view，M7只可取得与selected action匹配的`M4.AutomaticRecoveryProofSliceV1`并逐字段验证same identity。Continue时M7只能从slice中ordered tool/reasoning/provider-prefix carriers构造M1 `RecoveryClosureDescriptor` available branch，调用M1 exact closure builder重算`closureDigest`，再反向比较descriptor source binding/order/carriers/commitments与slice；M7不能取得裸snapshot/fold/manual-only branch，也不能从Legacy/history/cache补closure；
  9. 最后在same snapshot重读recovery/sealed cursors与owner mapping并要求等于step1/read set；wrapper commit/close read tx，helper只返回给caller。
- **All errors/mapping/replay**：owner/genesis/source-terminal、missing/gap/unknown/authority digest/fold/materialization/head/current-view divergence统一映射`RecoverySnapshotInconsistent`或`M4.RecoveryAuthorityErrorV1(kind:"replay-inconsistent")`；SQLite busy exhaustion与read I/O分别映射`RecoveryBusyExhausted`/`RecoveryDatabaseReadError`；零写无需rollback。old/public rows不能进入dedicated prefix，返回typed unknown/ineligible而不推断authority。
- **Post**：返回`M4.DurableRecoveryAuthorityViewV1`完整包装M1 snapshot；raw high-water/chain、七materializations、三heads、terminal source/control versions、assistant public mapping、完整tool partition、reconstructible carriers、sealed metadata observation和owner pair来自同一WAL snapshot且逐字段=fold。tool eligibility三branch total/disjoint，SafeRetry只在truly-empty，compatibility-only/mixed与nonfinal/reconciled phase固定ManualStop；SafeRetry/Continue slice均nominal且绑定exact snapshot identity，Continue另绑定closure source identity、ordered tool/reasoning proofs与唯一provider-prefix proof，M7只能由其构造并重算M1 `RecoveryClosureDescriptor`。S1不提前取得candidate-specific lease；不存在empty/fresh/ordinary snapshot branch。
- **Side effects/resource lifecycle**：SQLite reads/local immutable allocations only；wrapper结束后无statement/lock，helper resources跟caller tx；无write/publish/unseal/provider/runtime handle。
- **Invariants**：直接建立I6；public projection只作为fold-derived append-only materialization比较，不反向成为truth，保持I1/M4-I4/M4-I7。
- **Termination**：finite prefix/table reads；wrapper busy retry最多3；helper不retry/spin。
- **Test IDs**：T-S1-001..028。

### 7.2 S2 `lookupCurrentRecoveryWinner`

```ts
export function lookupCurrentRecoveryWinner(input: Readonly<{
  aggregateID: M1.RecoveryAggregateID
  sessionID: string
  sourceAssistantID: M1.RecoveryAssistantID
  losingExpectedHead: M1.OperationSchemaByTypeV1["decision-finalized"]["expectedPredecessors"]["recoveryHead"]
}>): Effect.Effect<M4.CurrentRecoveryWinnerV1, M4.RecoveryAuthorityErrorV1>
```

- **Owner/落点**：M4 private authority service。
- **Callers**：O7/O8/O9 CAS-loser handling、M6 supersession/automatic steering。
- **Callees**：single DEFERRED transaction、`loadRecoverySnapshotInTransaction`、scoped raw lookup by winning head `(aggregateID,operationID)`、A4 with the winning operation decoded from theM1 exported private registry。
- **Requires**：caller持有刚刚losing的expected recovery head；不得猜winner operationID；dedicated owner pair已存在。
- **Ensures**：在**同一个**read transaction中验证owner/cursor/current head、winning raw、operation-prefix与full current fold后返回closed winner；unknown/partial/corrupt winner失败，不default automatic/manual。
- **Errors/transaction/replay/resource**：S2只打开一个DEFERRED tx并把它传给S1 helper/A4，禁止调用会另开tx的public S1；head unchanged单独返回；owner/missing winning raw、kind mismatch或fold divergence为inconsistent；busy/read按S1 union映射；无handle/publication。
- **Algorithm**：begin/pin cursor→transaction-local S1 snapshot→readcurrent recovery head→若等于losing返回unchanged→由head.operationID scoped lookup winning raw→M1 private registry decode type8/9/10→A4 operation/current folds→map closed result→close tx。
- **Test IDs**：T-S2-001..010。
- **正确性论证**：
  - **前置**：losing head exact。
  - **步骤/callee**：single snapshot使head/raw一致；head携带winning operationID而非caller猜测；A4建立raw/receipt/full-fold equality；closed map覆盖manual/automatic/superseded。
  - **全部错误 traces**：unchanged正常分支；missing/unknown/corrupt typed failure；busy bounded；零写无需rollback。
  - **后置**：automatic winner complete result本身只足以让M6 reload/steer，不授权transport。仅当原same handle仍prepared/unreleased/hit=0时，M2才可立即执行独立pre-release K8；K8 success后才把complete result+operationPostState交F27并执行M2 exact authorization→release once→K9。K8 failure必须mechanical cancel，F27/authorization/release calls=0，再K9/zeroize；detached receipt/result或commit-time proof不足。
  - **副作用穷尽**：SQL reads/pure validation。
  - **不变量保持**：M4-I4/M4-I6/M4-I10。
  - **终止**：固定reads+finite fold；retry bounded。

### 7.3 R1 `rebuildRecoveryAggregate`

```ts
export function rebuildRecoveryAggregate(input: Readonly<{
  aggregateID: M1.RecoveryAggregateID
  sessionID: string
  expectedAggregateHead?: M1.AdmissionPlan["expectedHeads"]["aggregateEventHead"]
  absentHeadCapability?: M4.ExclusiveStartupRebuildCapability
}>): Effect.Effect<M4.RebuildReceiptV1, M4.RecoveryRebuildErrorV1>
```

- **Owner/落点/Callers**：M4 maintenance service；explicit maintenance/startup integrity task only；A4/S1不得自动调用。`ExclusiveStartupRebuildCapability`是M4实际export的unforgeable process capability，不可HTTP构造。
- **Callees contracts**：owner validator、BEGIN IMMEDIATE、P3R recovery reader、P3S sealed-maintenance reader、K0 dual-prefix fold、sealed authoritative-table exact reader/comparator、A2、authority-row verifier、M1 exact operation/evidence/projection codecs与safe projector、M4-owned SQL row encoders/literal mappings、head writers与exact readback。
- **Requires**：C1/MIG1 owner mapping证明该session恰有且仅有input recovery/sealed pair且与public aggregate distinct；caller持maintenance capability；无nested tx；R1不创建/repair owner mapping、event_sequence genesis/cursor、raw、sealed material或sealed-use lease。R1对sealed state与lease table只做read-only full consistency validation：parent creation tuple、scope/commitment、generation/state、key version、last operation/blob marker与每条lease exact key/row digest、live uniqueness、closed monotonicity必须成立；不得decrypt、读取key、rotate、redact、acquire/close/revive lease。
- **`expectedAggregateHead` exact branches**：
  1. present + byte-equal current raw head：允许rebuild；该head在整个tx中作为pinned raw authority；
  2. present + stale/different：返回`RecoveryRebuildConflict(reason:"expected-aggregate-head-mismatch")`，零derived write；
  3. absent + valid `absentHeadCapability`：只允许startup/offline exclusive branch，在取得writer lock后读取current head并pin；
  4. absent + missing/invalid capability：typed conflict，禁止隐式“accept any head”；
  5. valid empty aggregate：current head必须是以M1 `event-chain-v1` exact aggregate-genesis input `{kind:"aggregate-genesis",hashVersion:1,aggregateID}`重算得到的`AdmissionPlan["expectedHeads"]["aggregateEventHead"](kind:"genesis")`，且high-water absent、raw/derived/heads全空；present可传该M1 exact empty head，或走authorized absent branch；rebuild返回zero row counts且不制造genesis event。
- **Workflow**：acquire writer→validate pair/kinds/genesis→P3R read/validate full recovery raw/authority chain→按上述head branch pin→A2 candidate（empty或non-empty，含operations 1/2/9 Legacy assistant rows及8–10 deterministic decisions）→P3S读取/验证完整sealed maintenance prefix→K0对P3R+P3S dual prefix fold→sealed authoritative-table reader按refID读取same owner的完整physical set并与K0 `rowsByRefID` exact比较→读取全部sealed-use lease rows，重算M1 key input/M4 key+row digests并验证每个live row引用current exact generation、closed row不复活且partial unique成立→验证existing Legacy user predecessors；对raw要求的assistant info/message relation，missing可由Session owner exact inserter重建，same-key different row fatal且不覆盖→验证display mapping：保留validated mapping，缺失时按M4-owned deterministic derivation复得同值→只删除`session_id + aggregate_id`匹配的七表/三head derived rows→按fixed order reinsert（projection全history append rows）→read-back Legacy rows/current view+history/heads→重读recovery/sealed cursors及raw heads必须仍等于pinned→commit。
- **All errors/mapping/rollback**：owner/second aggregate/cross-role/expected-head/foreign-derived-row映射`M4.RecoveryRebuildErrorV1(kind:"rebuild-conflict")`；recovery/sealed raw/authority/parent seal/K0/physical sealed-table corruption映射`M4.RecoveryAuthorityErrorV1(kind:"replay-inconsistent")`；busy/read/write映射`M4.RecoveryRebuildErrorV1`同名member。任何sealed validation/delete/insert/readback/cursor变化失败rollback，旧derived state仍可见；不跳坏event、不repair raw/owner/cursor/sealed row。
- **Post**：raw、receipts、owner pair、recovery/sealed cursors、sealed physical rows与sealed-use lease rows不变；K0 current sealed fold/physical set/lease references exact，Legacy assistant/message materialization、七materializations/三heads及display mapping exact等于online fold；receipt heads等于pinned recovery raw head。
- **Side effects/resource lifecycle**：仅缺失Legacy assistant/message rows的deterministic inserts与七表/三head SQLite replacement writes；零EventV2 notify/bridge/sync/keyring/provider；statements/temporary maps/capability borrow在tx后释放。
- **Invariants**：M4-I1/M4-I5/M4-I8/I9保持；single tx保持观察原子性；valid empty branch保持dedicated genesis且不伪造authority。
- **Termination**：finite recovery/sealed refs/derived sets；busy retry最多3；无逐表commit/spin。
- **Test IDs**：T-R1-001..018。

## 8. Public/internal publication contracts

### 8.1 Source definition 与 manifest types

Public/publication/manifest侧只引用M1实际export的`M1.PublicEventDefinitionV1<D>`、`M1.PublicDurableEventDefinitionV1<D>`、`M1.PublicCommittedEventV1<D>`、`M1.PublicEventCursorV1`、`M1.PublicEventReadErrorV1`、`M1.PublicEventListenerV1`、`M1.PublicEventSubscriptionV1<D>`、`M1.PublicEventManifestV1`、`M1.PublicDurableEventManifestV1`与`M1.PublicEventServiceV1`；本文不复制这些shape、service interface、read-error union或default rules，也不保留任何unversioned alias。

M4只定义private reader interface：

```ts
export interface RecoveryAuthorityPrivateEventReaderV1 {
  readRecoveryAggregatePrivate(
    aggregateID: M1.RecoveryAggregateID,
    tx: M4.RecoveryReadOrWriteTransaction,
  ): Effect.Effect<readonly M4.RecoveryRawRowV1[], M4.RecoveryAuthorityErrorV1>
  readSealedAggregatePrivate(
    aggregateID: M4.SealedAggregateID,
    tx: M4.RecoveryReadOrWriteTransaction,
  ): Effect.Effect<readonly M4.SealedMaintenanceRawRowV1[], M4.RecoveryAuthorityErrorV1>
}
```

- old definitions省略publication只可default public；new recovery/sealed definitions必须显式internal；
- public latest、public server/OpenAPI与generic public-durable writer各自只接收M1 assembler的public definition partition；三者都不能接收private registry、internal definition或`EventManifestSet.durableReplay`；
- trusted private `M1.EventManifestSet.durableReplay`是all-durable replay registry，明确包含public+internal durable definitions，只可注入P3R/P3S/A4/S1/R1/MIG1等core-private readers；`internalRuntime`同样不进入public DI container；
- publication不能由publish options、metadata、HTTP/replay参数覆盖。

### 8.2 P1 M1 manifest integration obligation

M4不重新声明M1 `assembleEventManifests`签名、算法、`M1.EventManifestSet` shape或error union；实现必须调用M1实际export的owner-qualified manifest assembler与definition types。本文只增加以下M4 integration obligations：

- recovery与sealed source definitions逐项使用M1 exported source-definition codec并固定`publication:"internal"`；不得定义M4 structural duplicate或让publish options覆盖；
- assembler输入是all definitions，但public consumers只能取得由publication partition生成的三个public-only views：`EventManifestSet.publicLatest`、`EventManifestSet.publicServer`，以及existing generic public-durable writer用`publicDefinitions`单独构造的public durable manifest。该writer manifest不是`EventManifestSet.durableReplay`的alias；
- trusted private `EventManifestSet.durableReplay`必须由all durable definitions构造，因此含public+internal；它只注册到core-private replay reader。`EventManifestSet.internalRuntime`只注册到trusted internal runtime。两者均不可注入public Event writer、Latest/Server/OpenAPI、listener、bridge、SSE、sync、SDK或测试fixture的public service container；
- startup执行四向set proof：`publicLatest.keys ⊆ public`、`publicServer.keys ⊆ public`、`publicDurableWriter.keys ⊆ public∩durable`、`durableReplay.keys = publicDurable∪internalDurable`；并证明每个recovery/sealed key只在`internalRuntime/durableReplay`，每个generic public durable key同时在public writer与durableReplay。任一missing/extra/cross-set/duplicate立即startup failure；
- M1 assembler任一duplicate/unknown/cross-set error按其owner error原样使startup fail closed，M4不catch后构造partial manifest；
- integration纯startup、无DB/listener/wire；成功保持I7，失败零partial registry；finite definitions的termination由M1 owner contract保证。
- **Test IDs**：T-P1-001..012。

### 8.3 P2 `notifyCommittedPublic`

```ts
export function notifyCommittedPublic(event: M1.PublicCommittedEventV1): Effect.Effect<void, never>
```

- **Owner/落点/Callers**：core M1.PublicEventServiceV1 post-commit notifier；generic public durable commit hook唯一caller；M4 internal writers永不调用。
- **Callees contracts**：M1/public manifest runtime guard；public listener registry snapshot；bounded queue的`tryOffer`（non-blocking）；diagnostic sink。guard成功才可触达后续callee。
- **Requires**：event必须由M1 canonical public registry/manifest decoder附加其module-private nominal capability brand；`publication:"public"` structural field、cast或caller object spread都不能构造`M1.PublicCommittedEventV1`。definition来自F31 public partition且DB transaction已commit/closed。该函数不接收raw/private registry value。
- **Workflow/branches**：guard publication/type→snapshot注册顺序下的finite listeners→对每个listener按snapshot order调用/隔离→对每个public stream queue按固定registry order `tryOffer`。queue accepted则本次invocation enqueue一次；queue full/closed则drop本次live notification并记录coarse diagnostic，consumer必须用P5/public durable replay补齐；不得阻塞或重试authority tx。
- **All errors/rollback/replay**：guard失败是defect并零forward；listener throw/interrupt逐listener隔离，后续listener仍执行；queue overflow/closed只diagnostic；diagnostic自身失败被吞并。函数无DB tx，故无rollback。它只保证**单次函数invocation内对每个snapshot listener/queue至多一次attempt**，不承诺跨crash/restart/external duplicate的exactly-once；durable DB history是恢复来源。
- **Post**：internal event无法进入listener/queue；每个accepted queue保持该notifier invocation的event order；observer failure不改变已commit authority，也不生成第二次authority write。
- **Side effects/resource lifecycle**：public listener callbacks、bounded queue offers、diagnostic only；listener snapshot与borrowed subscriptions在return释放，不泄漏ref；无SQLite/provider/tool/internal publication。
- **Invariants**：M4-I7；commit-before-notify；live best-effort与durable replay分离。
- **Termination**：listener/queue snapshot有限，每项一次non-blocking attempt，无retry loop。
- **Test IDs**：T-P2-001..007。

### 8.4 P3R `readRecoveryAggregatePrivate`

```ts
export function readRecoveryAggregatePrivate(
  aggregateID: M1.RecoveryAggregateID,
  tx: M4.RecoveryReadOrWriteTransaction,
): Effect.Effect<readonly M4.RecoveryRawRowV1[], M4.RecoveryAuthorityErrorV1>
```

- **Owner/落点/Callers**：M4 private recovery raw reader；direct callers仅A3/A4/A5/S1 helper/R1/MIG1，以及需要dual-prefix validation的K0a/K3/K4/K5。A2/K0是pure reducer，只接收rows而不调用reader；其它K-family或public/generic caller不得调用P3R。
- **Callees contracts**：owner map/kind exact validator，其success构造M1 `M4RecoveryAggregateOwnerMappingProofV1`；transaction-local EventTable ordered SQL；M1 exported `RecoveryDurableRowDecodeInputV1`与private recovery registry/codec。
- **Requires**：unforgeable core-private capability、active matching tx、M1 `aggregateID` selector属于session的dedicated recovery role；禁止HTTP/bridge/service injection。consumer不能自己构造owner proof。
- **Workflow/branches**：validate pair/kind/双向mapping→仅在全部成立后附M1 owner-proof brand→读取`aggregate_id=? ORDER BY seq`且只接受publication internal/family m1-recovery-v1→每row以exact `{row,ownerProof}`调用M1 decoder，禁止只传row或structural owner fields→验证seq从0连续（empty允许[]）→return immutable rows。public/legacy/m4 row出现在该aggregate立即inconsistent，不混合返回。
- **All errors/rollback**：owner missing/partial/cross-role、aggregate mismatch、gap、unknown version/decoder、mixed publication/family typed；不begin/commit、不fallback public decoder；write caller由其owner rollback，read caller零写。
- **Post/side effects/resource**：返回只含sameaggregate ordered recovery rows且不publish/serialize；副作用仅tx-local reads/local decode，statements随tx释放。
- **Invariants/termination**：保持I6/I7与dedicated no-mixed-chain；finite ordered rows一次scan终止。
- **Test IDs**：T-P3R-001..009。

### 8.4.1 P3S `readSealedAggregatePrivate`

```ts
export function readSealedAggregatePrivate(
  aggregateID: M4.SealedAggregateID,
  tx: M4.RecoveryReadOrWriteTransaction,
): Effect.Effect<readonly M4.SealedMaintenanceRawRowV1[], M4.RecoveryAuthorityErrorV1>
```

- **Owner/落点/Callers**：M4 private sealed-maintenance raw reader；direct callers仅A4、S1 helper、K0a/K3/K4/K5/R1/MIG1。A4/S1只为raw-referenced sealed metadata/current physical consistency验证，不decrypt/要求active；K0是pure reducer；K2读取parent recovery row而不伪造sealed raw；K6只按owner/FK count删除，不调用P3S。
- **Callees contracts**：owner map/kind validator；transaction-local EventTable ordered SQL；M4 exported sealed-maintenance exact registry/codec。
- **Requires**：private capability、active matching tx、aggregate属于same session dedicated sealed role；initial sealed creation authority不在此aggregate伪造row，而由K0另接收P3R parent recovery prefix。
- **Workflow/branches**：validate pair/sealed kind/genesis cursor→读取sealed aggregate rows按seq→只接受internal/m4-sealed-v1 rotate|redact→exact decode request/event/authority fields→连续性检查（empty允许[]）→return immutable rows。
- **All errors/rollback**：owner/genesis/mixed family/public row/gap/unknown codec typed inconsistent；不begin/commit、不调用keyring/crypto/public decoder；caller tx按owner处理rollback。
- **Post/side effects/resource**：返回ordered maintenance prefix，不含parent creation rows；只有tx-local reads/local decode，statements随tx释放，零wire/publication。
- **Invariants/termination**：保持I6/M4-I7/I9与sealed domain isolation；finite rows一次scan终止。
- **Test IDs**：T-P3S-001..009。

### 8.5 P4 `EventV2Bridge.forwardPublic`

```ts
export function forwardPublic(event: M1.PublicCommittedEventV1): Effect.Effect<void, never>
```

- **Owner/落点/Callers**：opencode EventV2Bridge；P2/M1.PublicEventServiceV1 public subscription唯一caller。
- **Callees contracts**：public-only schema encoder；GlobalBus ordinary publisher；public durable sync-envelope publisher；diagnostic sink。任一callee不得接收private registry decoder/output。
- **Requires**：public branded committed event；defensive runtime publication/type assertion；bridge subscription resource active。无internal/raw overload。
- **Workflow/branches**：assert public→public encoder。assert/encode失败则coarse diagnostic并终止本event，ordinary/sync均零emit；成功后先ordinary emit attempt，再在event被M1 public manifest标记durable时sync emit attempt。ordinary observer defect被隔离并记录，**不阻止**后续sync attempt；sync defect独立记录。两次emit的承诺只是本invocation attempt order `ordinary-before-sync`，不承诺跨bus/global/external delivery全序或exactly-once。
- **All errors/rollback/replay**：`Effect<void,never>`通过defect isolation+diagnostic吸收observer failures；guard/encode defect零forward；ordinary/sync defects不抛回P2、不重试DB authority。无DB tx，durable gap由P5/public history读取补齐。
- **Post**：所有实际emission都来自同一public encoded event；internal assertion失败零ordinary/zero sync；若两次都成功，其invocation order固定ordinary后sync。
- **Side effects/resource lifecycle**：GlobalBus ordinary/sync attempts与diagnostic；subscription unsubscribe释放listener，encoded buffer在return释放；无SQLite/provider/tool/internal publish。
- **Invariants**：M4-I7、post-commit observer isolation、live/durable recovery分离。
- **Termination**：固定guard/encode、至多两次non-recursive emit，无retry loop。
- **Test IDs**：T-P4-001..008。

### 8.6 P5 public sync/history SQL

```ts
export function readPublicSyncHistory(input: Readonly<{
  workspaceID: string
  cursor:
    | Readonly<{
        kind: "aggregate"
        aggregateID: string
        afterSequence?: M1.SafeNonNegativeInt
      }>
    | Readonly<{
        kind: "workspace-global"
        afterGlobalSequence?: M1.SafeNonNegativeInt
      }>
  limit: M1.SafePositiveInt
}>): Effect.Effect<
  readonly M1.PublicCommittedEventV1<M1.PublicDurableEventDefinitionV1>[],
  M1.PublicEventReadErrorV1
>
```

- **Owner/落点/Callers**：opencode sync history/workspace-move reader；authenticated sync/history handlers only。live SSE走P2/P4，不把其delivery promise并入P5。
- **Callees contracts**：auth scope validator；single DEFERRED tx；EventTable public SQL；M1 exported public durable manifest decoder。private registry不可注入。
- **Requires**：workspace authorized；limit≤existing sync max；cursor safe。aggregate cursor必须显式含aggregateID，禁止`aggregateID` absent却只给`afterSequence`；workspace scan只使用existing public global sequence，不混用aggregate seq。
- **Workflow/branches**：validate auth/limit/cursor→begin/pin read tx→aggregate branch SQL硬编码`workspace_id=? AND aggregate_id=? AND publication='public' AND seq>? ORDER BY seq,id LIMIT ?`；workspace-global branch硬编码`workspace_id=? AND publication='public' AND global_sequence>? ORDER BY global_sequence,id LIMIT ?`→逐row用public durable decoder exact decode→全部成功才return并close tx。
- **All errors/rollback/replay**：auth/unsafe cursor/limit/query/unknown public version/decode typed；任一row失败丢弃local partial array并返回error，不fallback raw/private decoder；只读无rollback writes。重复同cursor可返回同page，caller用最后一row相应cursor推进；internal rows不占public decoded result但SQL filter前已排除。
- **Post**：aggregate branch只返回同aggregate严格seq/id order；workspace branch只返回workspace global order；两者均仅public durable events，HTTP不能覆盖publication/manifest。
- **Side effects/resource lifecycle**：SQLite read/local decode only；statements/rows buffer随tx关闭；无listener/GlobalBus/write/provider。
- **Invariants**：M4-I7；pagination无跨aggregate sequence ambiguity；durable history与live best-effort分离。
- **Termination**：limit有界，每rowdecode一次；read busy retry最多3，无unbounded pagination loop。
- **Test IDs**：T-P5-001..012。

### 8.7 Internal operation publication rule

A3、K4、K5、R1、MIG1 成功后都 **不调用** `notifyCommittedPublic`，也不存在 `notifyCommittedInternal` public service。若M8需要刷新，只能从M1 safe projection通过既有public message/session signal发布；raw internal event type/payload始终零泄漏。

## 9. Sealed material functions与raw maintenance replay

### 9.1 K1 `prepareSealForOperation`

```ts
export function prepareSealForOperation(input: Readonly<{
  scope: M1.SealedRecoveryMaterialRef["scope"]
  materialKind: M1.SealedRecoveryMaterialRef["purpose"]
  plaintext: Uint8Array
}>): Effect.Effect<M4.PendingSealV1, M4.RecoverySealErrorV1>
```

- **Owner/落点/Callers**：M4 sealed service；M2 exact preparation、M3 reasoning/prefix fact producer。
- **Callees**：keyring active-key read、CSPRNG、AES-256-GCM、M1 keyed commitment builder。
- **Requires**：plaintext是caller可控唯一buffer；scope exact；active KEK valid。
- **Ensures**：返回ciphertext/wrapped DEK/ref及M1 exported plaintext commitment/scope digest fields；零disk write；finally清零DEK/KEK copy/plaintext buffer。
- **Algorithm**：resolve key→random ref/DEK/nonces→调用M1 exported pending-seal commitment builders→encrypt plaintext→wrap DEK→assemble exact pending→zeroize。
- **Test IDs**：T-K1-001..009。
- **正确性论证**：
  - **前置**：valid scope/buffer。
  - **步骤/callee**：CSPRNG建立opaque IDs/keys；HMAC建立keyed commitment；GCM建立confidentiality/integrity；M1 ref validator建立scope。
  - **错误 traces**：key/random/crypto/validation任一失败无DB residue，finally全清零；无plaintext fallback。
  - **后置**：只有pending ciphertext离开scope，raw plaintext不返回。
  - **副作用穷尽**：keyring read、randomness、memory mutation；无DB/provider/log secret。
  - **不变量保持**：M4-I9。
  - **终止**：固定crypto步骤；无loop。

### 9.2 K2 `persistPendingSeals`

```ts
export function persistPendingSeals<T extends M1.RecoveryOperationType>(
  tx: M4.RecoveryImmediateTransaction,
  parent: Readonly<{
    aggregateID: M1.RecoveryAggregateID
    operationID: M1.RecoveryOperationID
    aggregateSequence: M1.SafeNonNegativeInt
    operationType: T
    exactPayload: M1.OperationSchemaByTypeV1[T]["payload"]
  }>,
  pending: readonly M4.PendingSealV1[],
): Effect.Effect<void, M4.RecoveryPendingSealPersistErrorV1>
```

- **Owner/落点/Callers**：M4 sealed transaction helper；A3 first-apply after parent raw insert only。A4/A5 replay、K4/K5 maintenance与generic writer不可调用。
- **Callees contracts**：P3R/scoped parent raw read in existing tx；M1 exact payload pending-ref extractor；`M4.PendingSealV1` validator；owner pair/ref-scope validator；transaction-local insert-returning helper。
- **Requires/branch rules**：tx active且由A3拥有；parent tuple指向本tx已插入的exact M1 recovery raw row；该row payload完整包含每个pending ref的metadata/scope/target/assistant/keyed commitment。dispatch operations 1/2/3/9要求pending set=prepared refs=payload refs；O4/O5 operations 5/6要求pending set=payload refs且无prepared package；其它operation pending必须空。no plaintext/no duplicate ref。
- **Workflow**：按parent tuple scoped read raw→exact decode/recompute payload refs→验证owner mapping中parent recovery aggregate与target sealed aggregate属于same session→pending按refID stable sort并逐项比较payload metadata/commitment→insert sealed row exactly one，写`creation_recovery_aggregate_id=parent.aggregateID, creation_operation_id=parent.operationID, creation_event_seq=parent.aggregateSequence, generation=0, last_operation_id=parent.operationID`→逐row readback authoritative fields；time_created只检查nonnull，不进入fold equality。
- **All errors/rollback/replay**：parent missing/mismatch、payload/ref/scope/branch malformed、duplicate/existing ref、owner pair partial、insert/readback 0/多row映射`M4.RecoveryPendingSealPersistErrorV1`；不begin/commit/retry。任一失败抛给A3并整体rollback parent raw/cursor/其它seals/derived rows，无orphan；existing ref永不按cipher比较接受。exact replay不调用K2。
- **Post**：每个initial sealed row都可从parent recovery raw exact payload重建genesis authoritative fields；rows仅tx-local可见直到A3 commit，sealed maintenance aggregate/cursor不因creation而改变。
- **Side effects/resource lifecycle**：existing tx内sealed row inserts/readback only；无M4 sealed raw event、keyring/provider/publication；cipher/canonical buffers由A3/caller在tx结束后释放。
- **Invariants**：M4-I1/M4-I2/M4-I3/M4-I5/M4-I9；cross-aggregate authority来自parent raw而非invented public authority。
- **Termination**：finite unique pending set，stable sort后每项一次；无retry/spin。
- **Test IDs**：T-K2-001..012。

### 9.3 K7–K10 sealed-use lease lifecycle

M4 lease lifecycle是`absent -> live -> closed`单向CAS；不存在renew、reopen、TTL expiry或“时间到了视为dead”。M2必须在M7第一次unseal/lowering和M2 actual preparation之前先产生stable、no-send、尚未release的`PausedHandleCommitment` reservation；M6用selected branded snapshot proof、candidate、future type-9 operationID、action、target与该commitment构造M1 `SealedRecoveryUseLeaseKeyInputV1`。M4不得向该M1 key私加不存在的`closureDigest`字段；K7改为同时接收same branded proof slice与M7从它构造并经M1 builder复验的`RecoveryClosureDescriptor`，把snapshot identity及safe-retry not-needed或Continue sourceBinding+closureDigest作为M4 row-digest-bound `closureBinding`持久化，再逐字段要求M1 key的source/action/candidate/target/handle members与它一致。K8把operation payload closure、package commitment、snapshot identity、row closure binding与key反向比较。每个需要unseal的ref各有一条key；零sealed ref时lease tuple必须exact为空且不插入占位row。

```ts
export function acquireSealedRecoveryUseLease(input: Readonly<{
  key: M1.SealedRecoveryUseLeaseKeyInputV1
  snapshotProof: M4.AutomaticRecoveryProofSliceV1
  closure: M1.RecoveryClosureDescriptor
  ownerProcessInstanceID: string
}>): Effect.Effect<M4.SealedRecoveryUseLeaseV1, M4.RecoverySealErrorV1>

export function validateSealedRecoveryUseLeasesForAutomaticCommit(
  tx: M4.RecoveryImmediateTransaction,
  input: Readonly<{
    operation: M1.RecoveryOperationInputV1<"automatic-child-admitted-and-consumed">
    snapshotIdentity: M4.RecoverySnapshotIdentityV1
    leases: readonly M4.SealedRecoveryUseLeaseV1[]
  }>,
): Effect.Effect<void, M4.RecoverySealErrorV1>

export function validateSealedRecoveryUseLeasesImmediatelyBeforeRelease(input: Readonly<{
  result: M1.OperationCommitResultV1<"automatic-child-admitted-and-consumed">
  preparedHandleCommitment: M1.PausedHandleCommitment
  leases: readonly M4.SealedRecoveryUseLeaseV1[]
}>): Effect.Effect<M4.SealedRecoveryUseReleaseValidationV1, M4.RecoverySealErrorV1>

export function closeSealedRecoveryUseLeases(input: Readonly<{
  leases: readonly M4.SealedRecoveryUseLeaseV1[]
  reason: "released" | "mechanically-cancelled" | "abandoned" | "lost-handle-cleanup"
  closedByOperationID: M1.RecoveryOperationID
}>): Effect.Effect<void, M4.RecoverySealErrorV1>

export function cleanupDeadProcessSealedRecoveryUseLeases(input: Readonly<{
  capability: M4.ExclusiveDeadProcessLeaseCleanupCapability
  closedByOperationID: M1.RecoveryOperationID
}>): Effect.Effect<void, M4.RecoverySealErrorV1>
```

- **K7 acquire**：先验证`snapshotProof` private brand/action/identity，调用M1 closure builder重算`closure`并要求其not-needed或available branch、sourceBinding/order/carriers/commitments/provider-prefix/digest与slice exact；再M1 exact validate key及cross-invariants，特别要求`key.sealedGeneration`是owner-exported `SafePositiveInt`，不得cast/offset current generation 0，且key source/action/operation/candidate/target/prepared-handle commitment与snapshot/closure-selected request一致；same transaction读取sealed parent/current K0 fold与physical row，要求ref exact active、current generation逐值等于该positive key member、purpose/scope/material/key metadata相等；计算M4 lease-key/row digests，CSPRNG leaseID，`INSERT ... RETURNING`恰一row，并持久化/读回exact snapshot identity与closure binding。same key已有live row只能在exact same owner/lease read-back时返回原nominal lease；same ref/generation若已有different live key，或same key的owner/字段不同，均由live-generation/live-key unique CAS映射为conflict。acquire完成前K3/M7/M2不得unseal/lower/actual prepare；generation 0必须先经显式K4 first application变成1并重新加载S1，K7绝不隐式rotate。
- **K8 O8 validation**：A3 type-9 first-apply在writer tx内、policy/source/control/head checks之后且raw cursor CAS之前调用；从operation/proposal的M1 closure、prepared package及`RecoverySnapshotIdentityV1`重建expected key/snapshot/closure-binding set，按refID排序与lease tuple双向set equality，逐row验证state live、owner、key JSON/digest、snapshot identity、closure source/digest、row digest、current sealed generation及prepared commitment。任一missing/closed/stale/mismatch使A3 rollback；exact replay不要求旧lease仍live。
- **K8 pre-release validation**：O8/A3已返回complete type-9 result后，same runtime handle必须仍prepared/unreleased/hit=0，M2在任何F27、M2 authorization或release调用之前立即调用该独立function；single read tx逐项重复same live/key/generation/complete-result operation/handle comparison，返回nominal `SealedRecoveryUseReleaseValidationV1`，其中snapshot identity、按refID order的lease ID/key digest/closure binding、operation ID与prepared commitment均来自本次readback。只有success proof的动态scope可把complete result + `result.operationPostState`交F27、执行M2 exact same-handle authorization并立即release同一handle exactly once；随后K9 released close。lease保持live直到release成功或cancel/abandon closure，因此K4/K5不能在validation与release之间修改generation。detached proof、旧proof或不同handle不可用；commit-time K8 success不能替代本次pre-release K8。
- **K8 pre-release failure**：missing/extra/duplicate/closed/stale lease、generation/result/operation/handle mismatch、read/busy/codec failure均在handle仍prepared时fail closed；M2必须mechanically cancel该handle，F27 calls=0、M2 authorization calls=0、release calls=0，然后K9以`mechanically-cancelled`或`abandoned`关闭same leases并zeroize。已commit type-9 authority不回滚、不授权替代handle，也不得重用commit-time K8 proof。
- **K9 close**：trusted M2/M6 private caller只在single release成功、mechanical cancel、abandon或lost-handle determination后以`WHERE lease_id/key_digest/state='live' RETURNING`逐rowCAS closed；exact already-closed same reason可idempotent success，different reason/owner/key冲突。automatic success固定pre-release K8→F27/M2 exact authorization→release once→K9 released；pre-release K8 failure固定cancel且F27/authorization/release calls=0→K9 cancelled/abandoned。close后M4立即zeroize仍持有的unsealed plaintext/DEK/KEK/canonical scratch并drop nominal refs；callback私自复制仍受K3 trusted no-copy boundary。closed row只作audit/conflict evidence，不再授权任何use且永不revive。
- **K10 process crash cleanup**：仅持`ExclusiveDeadProcessLeaseCleanupCapability`且该capability证明dead owner process instance的exclusive OS/process-owner lock已取得时，按owner process ID扫描live rows并CAS为`process-crash-cleanup` closed；不读取wall clock、heartbeat age或TTL，不假定slow process dead。cleanup不重新lower/prepare、不生成新operationID/candidate/handle、不把old request标live；后续若业务仍需恢复，必须从fresh S1 view、fresh candidate、fresh intended type-9 operationID与fresh M2 handle commitment重新走K7，旧lease/key/handle不能复活。若liveness fence不可证明，返回`process-liveness-not-proven`并保持row live。
- **Rotation/redaction finality**：K4/K5 exact replay仍先返回stored receipt；missing/first-apply branch在key/crypto或state mutation前查询`refID+expectedGeneration` live leases，任一存在返回`live-use-lease-conflict`且零写。K5 redactioncommit后所有旧generation lease即使physical row被篡改恢复也因K0/table/lease generation mismatch永久不能open；cleanup只能close lease，绝不撤销redaction或重建ciphertext。
- **Side effects/progress**：K7/K9/K10只有bounded SQLite transactions与local digest/random；commit-time K8只borrow A3 caller tx，pre-release K8只开独立bounded read tx且不调用F27/M2 authorization/release。所有row/ref loops finite且busy最多3。lease table是separately named maintenance table，不计七materializations；fresh schema、upgrade migration、schema digest、cascade counts、R1 read-only consistency与future tests必须显式包含它。
- **正确性论证**：K7的M1 exact key validator+dual-prefix/physical comparator+exactly-one live-key index建立“此snapshot/action/operation/candidate/target/handle对当前positive generation的唯一live use”；任一前置、insert或readback失败rollback且unseal hits=0。commit-time K8从canonical type-9 input重建同一closed key set并在cursor前验证，但不产生F27/release authority；complete result返回后，独立pre-release K8在same handle仍prepared时从complete result+same handle重建同一set，live guard使两次K8之间K4/K5必冲突。只有pre-release K8 success proof动态scope可pass result/post-state to F27并执行M2 exact authorization+release once；任一missing/extra/closed/stale/mismatch失败均mechanical cancel，F27/authorization/release calls=0，再K9/zeroize。K9/K10只允许CAS live→closed，row digest/readback证明无renew/reopen；K10的exclusive liveness fence是唯一crash前提，故slow/live process不会由时间误杀。所有success/failure/interrupt cleanup都zeroize M4-owned material；closed row、cleanup或restored bytes均不能绕过K0 generation/state与live-key equality，因此redaction finality保持。
- **Test IDs**：K7 `T-K7-001..020`；K8 `T-K8-001..018`；K9 `T-K9-001..014`；K10 `T-K10-001..014`。

### 9.3.1 K3 `withUnsealedMaterial`

```ts
export function withUnsealedMaterial<A, E>(input: Readonly<{
  ref: M1.SealedRecoveryMaterialRef
  lease: M4.SealedRecoveryUseLeaseV1
  use: (input: Readonly<{
    bytes: Uint8Array
    lookupProof: M1.M4SealedRecoveryMaterialLookupProofV1
    lease: M4.SealedRecoveryUseLeaseV1
  }>) => Effect.Effect<A, E>
}>): Effect.Effect<A, E | M4.RecoverySealErrorV1>
```

- **Owner/落点/Callers**：M4 sealed service；M7 snapshot-bound closure lowering与M2 same automatic prepared-handle/provider adapter scope only。
- **Callees**：aggregate owner/ref/lease row reader、short DEFERRED read tx、P3R/P3S、K0、sealed authoritative-table exact comparator、keyring historical key read、GCM/HMAC、Effect bracket。
- **Requires**：`input.ref`来自M4 nominal snapshot proof slice，`input.lease`由K7在任何unseal/lowering/preparation之前取得；lease key的ref/purpose/scope/material/generation/source/action/operation/session/target/prepared-handle commitment逐字段与本次selected snapshot/candidate/request相等。`use`只能由core-private M7/M2 capability注册，public DI/HTTP/plugin/tool callback不可取得。callback同时接收M1 exact nominal lookup proof与同一live M4 lease，并禁止缓存/返回plaintext、proof、lease或派生长期副本；语言无法阻止恶意callback复制bytes，因此non-escape只在trusted boundary成立。
- **Ensures**：same WAL snapshot中的P3R creation prefix、P3S maintenance prefix、K0 current fold、physical sealed row与`sealed_recovery_use_lease` live row exact一致，且fold current state active/generation等于lease key、historical key可读后，M4才构造M1 lookup proof并把新plaintext buffer连同same nominal lease交callback恰一次。all exits清零M4-owned DEK/KEK/plaintext/canonical buffers并释放lookup proof；lease仍live，直到K9因release/cancel/abandon/cleanup关闭。committed redaction、closed/stale lease或raw/table divergence永久阻止open。
- **Transaction**：一个短DEFERRED tx按ref+leaseID读取candidate sealed/lease rows但不信state，验证owner mapping后用P3R/P3S→K0重建current sealed authority；把`rowsByRefID[refID]`、physical row与lease exact key/row digest逐字段比较，并要求lease state live、generation与current sealed generation相等。只有exact active+live才复制six ciphertext blobs，然后结束tx。keyring、decrypt、callback/provider I/O绝不在DB tx内。
- **Errors/replay/resource/algorithm**：missing parent/ref/lease、closed/stale lease、owner/dual-prefix/current-table divergence、committed redacted、scope/purpose/material/generation/key/GCM/HMAC全部typed；多次open只读不改row/lease；algorithm short tx candidate+lease read→P3R/P3S→K0 current fold→exact physical+lease compare/active-live check→copy blobs+validated proof fields→close tx→historical key read→unwrap/decrypt/verify→only now brand lookup proof→bracket callback once with readonly `{bytes,lookupProof,lease}`→finally zeroize/drop proof；cipher/plain buffers不逃逸。若maintenance raw已redact但physical row恢复old active bytes，K0/table/lease mismatch在key read前fail closed。
- **Test IDs**：T-K3-001..016。
- **正确性论证**：
  - **前置**：snapshot-bound carrier proof、K7 live lease与callback no-cache contract。
  - **步骤/callee**：owner mapping与P3R/P3S同snapshot建立完整creation+maintenance authority；K0 post给出current logical row；physical+lease comparator排除stale restored/partial row并证明current active generation与exact live use key；tx关闭后historical key/GCM/HMAC建立ciphertext真实性与key-readable事实；M1 lookup-proof exact surface由M4 brand constructor建立；bracket post保证`{bytes,lookupProof,lease}` callback once与all-exit finalizer。
  - **全部错误 traces**：missing/parent/chain/table divergence/redacted/scope/key/integrity在callback与key read前或callback前typed失败；callback success/error/interrupt都finally清零；无DB write/rollback。
  - **后置**：只有raw-maintenance-authorized、physical exact且key-readable的current active plaintext与matching M1 nominal sealed lookup proof被交给持core-private capability的trusted callback；M4 owned buffer只在dynamic callback scope存活并在退出清零。该结论依赖callback no-copy contract，不声称语言可阻止恶意副本。
  - **副作用穷尽**：DB dual-prefix/table read、keyring read、callback、local zeroize。
  - **不变量保持**：M4-I1/M4-I4/I9与no-callback-in-tx。
  - **终止**：两个finite prefix scan、固定crypto/callback一次；无unbounded loop。

### 9.4 Sealed maintenance raw envelope

Rotate/redact authority固定使用dedicated `SealedAggregateID`上的M4-private raw operations；initial sealed creation则固定由same-owner dedicated recovery aggregate中的parent M1 raw operation提供genesis authority。不存在无operationID的production row mutation path：

```ts
export type SealedMaintenanceTypeV1 = "sealed-rotate" | "sealed-redact"
export type SealedAggregateEventHeadV1 =
  | Readonly<{ kind: "genesis"; aggregateID: M4.SealedAggregateID; digest: M4.SealedEventChainDigest }>
  | Readonly<{ kind: "event"; aggregateID: M4.SealedAggregateID; sequence: M1.SafeNonNegativeInt; digest: M4.SealedEventChainDigest }>
export type SealedRequestByTypeV1 = {
  "sealed-rotate": Readonly<{ refID: M1.RecoverySealedRefID; expectedGeneration: M1.SafeNonNegativeInt; expectedState: "active"; targetKeyVersion: M1.SafePositiveInt }>
  "sealed-redact": Readonly<{ refID: M1.RecoverySealedRefID; expectedGeneration: M1.SafeNonNegativeInt; expectedState: "active" }>
}
export type SealedMaintenanceEnvelopeV1<T extends M4.SealedMaintenanceTypeV1> = Readonly<{
  envelopeVersion: 1
  aggregateID: M4.SealedAggregateID
  aggregateSequence: M1.SafeNonNegativeInt
  operationID: M1.RecoveryOperationID
  operationType: T
  fieldSetVersion: 1
  creationAuthority: Readonly<{
    recoveryAggregateID: M1.RecoveryAggregateID
    operationID: M1.RecoveryOperationID
    aggregateSequence: M1.SafeNonNegativeInt
  }>
  recoveryCreationHighWater: M1.SafeNonNegativeInt
  request: M4.SealedRequestByTypeV1[T]
  requestDigest: M4.SealedRequestDigest
  eventChain: Readonly<{ hashVersion: 1; previousDigest: M4.SealedEventChainDigest; nextDigest: M4.SealedEventChainDigest }>
}>
export type SealedMaintenanceReceiptForV1<T extends M4.SealedMaintenanceTypeV1> =
  T extends "sealed-rotate" ? M4.RotationReceiptV1 : M4.RedactionReceiptV1
export type SealedMaintenanceRawRowV1<T extends M4.SealedMaintenanceTypeV1 = M4.SealedMaintenanceTypeV1> = Readonly<{
  rowID: string
  aggregateID: M4.SealedAggregateID
  aggregateSequence: M1.SafeNonNegativeInt
  publication: "internal"
  operationFamily: "m4-sealed-v1"
  operation: M4.SealedMaintenanceEnvelopeV1<T>
  receipt: M4.SealedMaintenanceReceiptForV1<T>
  postStateDigest: M1.CanonicalDigestValue
  authorityRowDigest: M4.AuthorityRowDigest
}>
```

`M4.SealedMaintenanceRawRowV1` identity为`(aggregateID,aggregateSequence)`及`(aggregateID,operation.operationID)`；operation family/publication/type/sequence与row字段必须exact，receipt type由`T`唯一决定，`applyMode`禁止进入row。K4/K5 first apply创建且immutable，P3S读取，K0a/K3/R1/MIG1消费，session cascade删除；M4独占owner。

`SealedRequestDigestInputV1` exact fields=`{envelopeVersion:1,operationType,fieldSetVersion,request}`，domain=`m4-sealed-request-v1`，显式排除aggregateID/sequence/operationID/creationAuthority/recoveryCreationHighWater/digest/eventChain。`SealedEventChainDigestInputV1` exact fields=`{hashVersion:1,aggregateID,aggregateSequence,operationID,operationType,fieldSetVersion,creationAuthority,recoveryCreationHighWater,previousDigest,requestDigest}`，domain=`m4-sealed-event-chain-v1`。`SealedBlobCommitmentInputV1`是closed union：active exact fields=`{version:1,state:"active",refID,generation,keyVersion,wrapNonce,wrappedDEK,wrapTag,cipherNonce,ciphertext,cipherTag}`；redacted exact fields=`{version:1,state:"redacted",refID,generation}`；domain固定`m4-sealed-blob-v1`。K4/K5必须从signature中的request fields重建request input、重算digest并与caller-supplied `requestDigest` constant-time比较；从physical row重建blob input，不能信任digest或只比较digest。receipt原样存入raw event且受`m4-authority-row-v1`覆盖。

#### 9.4.1 K0 `foldSealedAuthorityPrefix`

```ts
export type SealedAuthorityPrefixV1 = Readonly<{
  sessionID: string
  recoveryAggregateID: M1.RecoveryAggregateID
  sealedAggregateID: M4.SealedAggregateID
  recoveryRows: readonly M4.RecoveryRawRowV1[]
  maintenanceRows: readonly M4.SealedMaintenanceRawRowV1[]
}>
export type SealedAuthoritativeRowV1 = Readonly<{
  refID: M1.RecoverySealedRefID
  sessionID: string
  sealedAggregateID: M4.SealedAggregateID
  creationAuthority: Readonly<{ recoveryAggregateID: M1.RecoveryAggregateID; operationID: M1.RecoveryOperationID; aggregateSequence: M1.SafeNonNegativeInt }>
  assistantID: M1.RecoveryAssistantID
  targetDigest: M1.DispatchTargetDigest
  materialKind: M1.SealedRecoveryMaterialRef["purpose"]
  keyVersion: M1.SafePositiveInt
  state: "active" | "redacted"
  plaintextCommitment: M1.SealedMaterialCommitment
  scopeDigest: M1.CanonicalDigestValue
  generation: M1.SafeNonNegativeInt
  lastOperationID: M1.RecoveryOperationID
  physicalCommitment:
    | Readonly<{ kind: "unanchored-generation-zero" }>
    | Readonly<{ kind: "active-blob"; value: M4.SealedBlobCommitment }>
    | Readonly<{ kind: "redacted-marker"; value: M4.SealedBlobCommitment }>
}>
export type SealedFoldedStateV1 = Readonly<{
  sessionID: string
  recoveryAggregateID: M1.RecoveryAggregateID
  sealedAggregateID: M4.SealedAggregateID
  recoveryCreationHighWater: M1.AdmissionPlan["expectedHeads"]["aggregateEventHead"]
  sealedAggregateHead: M4.SealedAggregateEventHeadV1
  rowsByRefID: ReadonlyMap<M1.RecoverySealedRefID, M4.SealedAuthoritativeRowV1>
  postStateDigest: M1.CanonicalDigestValue
}>

export function foldSealedAuthorityPrefix(
  prefix: M4.SealedAuthorityPrefixV1,
): Effect.Effect<M4.SealedFoldedStateV1, M4.RecoveryAuthorityErrorV1>
```

`SealedFoldedStateV1` exact含`recoveryCreationHighWater,sealedAggregateHead,rowsByRefID,postStateDigest`；`rowsByRefID`只含authoritative fields，明确排除三个non-authoritative time columns。

- **Owner/Callers/Callees**：M4 sealed private pure reducer；K0a/K4/K5/R1/MIG1调用。K6不fold。callees为M1 recovery exact codecs/pending-ref extractor、M4 sealed maintenance codecs、两个genesis/request/event/authority-row digest verifiers与owner tuple validator。
- **Requires**：prefix owner IDs来自同一exact mapping；`recoveryRows`是从M1 recovery genesis开始的完整ordered internal prefix；`maintenanceRows`是从M4 sealed genesis开始的完整ordered rotate/redact prefix。两个sequence/domain保持独立，禁止按数值seq混并或把parent M1 row cast为M4 row。
- **Workflow/explicit cross-aggregate order**：
  1. validate owner tuple与完整recovery prefix的M1 genesis/chain/authority rows；用M1 exact payload extractor建立按`(recoverySeq,refID binary)`排序的creation transitions，但暂不一次性全部应用；
  2. validate sealed genesis并按sealed aggregate seq扫描maintenance rows。每row的`recoveryCreationHighWater`必须在recovery prefix内且相对前一maintenance单调不减；先把尚未应用且`recoverySeq<=该highWater`的creation transitions依序加入state，再要求row.`creationAuthority` exact等于request ref的genesis tuple且其sequence≤highWater；随后验证M4 event/authority digest/stored receipt并应用rotate/redact。若该ref已有prior M4 maintenance blob commitment，则receipt previousBlobCommitment必须等于fold current；若是generation0首次maintenance，则该receipt建立M4 physical-blob anchor，K4/K5 transaction必须从table bytes重算并比较后才能commit。next/redacted commitment成为新state；每row stored postStateDigest必须等于**仅含该highWater前creates+截至该sealed seq maintenances**的historical state；
  3. maintenance扫描完成后，才把剩余`recoverySeq>last recoveryCreationHighWater`的later creation transitions加入current state；因此later recovery creates不污染earlier maintenance historical post-state。对最终canonical authoritative map按refID计算current postStateDigest；time columns不参与。
- **All errors/rollback/replay**：owner mismatch、public/mixed recovery row、parent payload/ref duplicate、任一domain genesis/gap/duplicate/digest break、recoveryCreationHighWater越界/回退、creationAuthority不匹配、maintenance-before-known-ref、historical post-state mismatch、illegal generation/state/terminal transition均`M4.RecoveryAuthorityErrorV1(kind:"replay-inconsistent")`；纯函数零写无需rollback。同exact双prefix得到byte-equivalent output。
- **Post**：每个current sealed row都有唯一parent recovery raw genesis authority与零个或多个按sealed seq全序的maintenance events；两个aggregate的domain/order均可独立审计。
- **Side effects/resource lifecycle**：local maps/canonical bytes only，digest后释放；无DB/keyring/crypto/publication。
- **Invariants**：M4-I1/M4-I4/M4-I5/M4-I9；initial authority不发明public/sealed-create event，maintenance generation/state单调。
- **Termination**：两个finite prefix各一次scan，nested pending refs有限且按refID一次；无递归/spin。
- **Test IDs**：T-K0-001..014。

#### 9.4.2 K0a `validateSealedExactReplayAndReturnReceipt`

```ts
export function validateSealedExactReplayAndReturnReceipt<
  T extends M4.SealedMaintenanceTypeV1,
>(
  tx: M4.RecoveryReadOrWriteTransaction,
  expected: Readonly<{
    aggregateID: M4.SealedAggregateID
    operationID: M1.RecoveryOperationID
    operationType: T
    request: M4.SealedRequestByTypeV1[T]
    requestDigest: M4.SealedRequestDigest
  }>,
  expectedReceiptKind: M4.SealedMaintenanceReceiptForV1<T>["receiptKind"],
): Effect.Effect<M4.SealedMaintenanceReceiptForV1<T> | undefined, M4.RecoverySealErrorV1>
```

- **Owner/Callers/Callees**：M4 sealed private validator；K4/K5 existing branch与response-loss resolver调用。callees为owner validator、P3R/P3S、scoped stored row lookup、K0、M4 exported exact receipt codec、sealed authoritative table/cursor readback。
- **Requires**：caller只提供stable aggregate/operation/type/full request fields/digest及由`M4.SealedMaintenanceReceiptForV1<T>["receiptKind"]`导出的receipt kind，不提供独立`R` generic、DB-assigned sequence或event chain；因此`T="sealed-rotate"`在type level只能要求/返回`RotationReceiptV1`，`T="sealed-redact"`只能要求/返回`RedactionReceiptV1`。tx active；lookup必须由本函数按same `(aggregateID,operationID)`执行。
- **Workflow**：validate owner pair/kind与stable tuple的non-crypto structure→**立即scoped lookup stored envelope**；missing直接返回`undefined`且不做request digest/key/resource work→existing后才rebuild exact request input并constant-time comparecaller/stored digest、comparetype/full request→P3R读取完整parent recovery prefix、P3S读取完整current maintenance prefix→K0 fold owner-scoped dual prefix→定位operation sequence并验证其historical maintenance prefix/stored receipt→再验证current full fold、cursor/head；对已有M4 maintenance anchor的active row从six blobs重算M4 blob commitment、redacted row重算redacted marker并与fold比较；generation0且尚无maintenance的row只比较M1-rooted logical fields与active blob nullability/integrity留给K3，另比较其余authoritative fields→decode stored receipt逐字段比较→return original receipt。
- **All errors/mapping/rollback**：missing operation是typed success value `undefined`，只允许K4/K5进入first apply；sameID request/type/digest mismatch=`RecoverySealConflict`；owner/parent/chain/fold/receipt/table/cursor mismatch=`M4.RecoveryAuthorityErrorV1(kind:"replay-inconsistent")`；busy/read映射`M4.RecoverySealErrorV1` member。零写，不begin/commit；write caller统一rollback。time columns只检查state-required nullability，不做authority equality。
- **Post**：missing时只返回`undefined`且不触碰key/resource；existing时只返回same stable request在原raw row中存储的immutable receipt；digest-only/sequence substitution、missing parent creation authority与partial current state均被拒绝。
- **Side effects/resource lifecycle**：tx-local reads+pure dual fold；statements/maps随caller tx释放；无key prefetch/crypto/write/publish。
- **Invariants**：M4-I4/I9与cross-aggregate genesis authority；exact replay在key/resource检查前可完成。
- **Termination**：一次scoped lookup+两个finite prefix scans+finite table compare，无retry/spin。
- **Test IDs**：T-K0A-001..016。

### 9.5 K4 `rotateSealedMaterial`

```ts
export function rotateSealedMaterial(input: Readonly<{
  aggregateID: M4.SealedAggregateID
  operationID: M1.RecoveryOperationID
  refID: M1.RecoverySealedRefID
  expectedGeneration: M1.SafeNonNegativeInt
  expectedState: "active"
  targetKeyVersion: M1.SafePositiveInt
  requestDigest: M4.SealedRequestDigest
}>): Effect.Effect<M4.RotationReceiptV1, M4.RecoverySealErrorV1>
```

`M4.RotationReceiptV1` exact immutable fields：`receiptVersion:1,receiptKind:"sealed-rotation",aggregateID,operationID,requestDigest,refID,previousGeneration,nextGeneration,previousKeyVersion,nextKeyVersion,previousBlobCommitment,nextBlobCommitment,eventSequence,eventDigest`；使用M4 owner-qualified export，不定义本地duplicate。

- **Owner/落点/Callers**：M4 sealed maintenance service；explicit key rotation maintenance service。
- **Callees contracts**：exact request builder、short DEFERRED scoped lookup+K0a、P3R/P3S、keyring、BEGIN IMMEDIATE、GCM unwrap/rewrap、sealed request/event/authority-row builders、K0/table/cursor readback。
- **Requires**：caller-stable aggregateID/operationID/full request fields/digest；function从`refID/expectedGeneration/expectedState/targetKeyVersion`重建exact request并重算digest。dedicated pair已存在；initial row必须可由K0从parent recovery raw payload重建。current generation/key availability只约束first apply，不约束exact replay。
- **Workflow/branches**：
  1. 只做安全integer/discriminator等non-crypto structural validation，立即开启short DEFERRED read并调用K0a；K0a先按`(aggregateID,operationID)`lookup，existing才重建request/digest并完成dual-prefix/full-table exact validation→关闭tx并返回stored receipt。**scoped lookup发生在任何request digest计算、key prefetch、unwrap/rewrap、current generation/resource check之前**；
  2. K0a返回`undefined`（missing）→关闭read tx，重建exact request并重算/比较requestDigest；成功后才允许keyring prefetch target/current KEK material；prefetch不是authority；
  3. BEGIN IMMEDIATE后再次验证owner mapping并重复scoped lookup以关闭race；若此时existing，走K0a并finally清零prefetched keys，仍不crypto；
  4. first apply用P3R/P3S+K0验证完整initial/current authority，重验expected generation/state/current key version及previousBlobCommitment；在任何key unwrap/rewrap前查询`sealed_recovery_use_lease(refID,expectedGeneration,state='live')`，任一row即`live-use-lease-conflict`且rollback/零crypto；无live lease才从row genesis tuple填`creationAuthority`并pin当前recovery cursor，分配sequence/digests，GCM只unwrap/rewrap DEK，写raw+row CAS+cursor+receipt并K0/table/lease readback；commit。
- **All errors/rollback/replay**：existing mismatch→conflict/inconsistent零写且不触keyring；missing后key unavailable、owner/cursor/generation/state/K0 parent missing、crypto/CAS/race/raw/readback失败全rollback保留old wrap；commit unknown只重新从step1 same scoped lookup，禁止先prefetch；finally清零DEK/KEKs。time_rotated non-authoritative，仅state branch检查nonnull。
- **Post**：exact replay不依赖current key/policy/resource；first-apply success只改变DEK wrapping、generation/keyVersion/lastOperationID及maintenance raw/cursor，material ciphertext/plaintext commitment/ref/scope不变且raw可重放证明。
- **Side effects/resource lifecycle**：replay只有SQLite reads；first apply含keyring read、SQLite tx、local crypto/zeroize；不decrypt material ciphertext、不publish/provider。
- **Invariants**：M4-I1/M4-I2/M4-I4/M4-I9；rotate/redact generation单winner；cross-aggregate parent authority完整。
- **Termination**：最多一次initial read、一次writer-race relookup、3次busy retry与finite crypto/folds；无spin。
- **Test IDs**：T-K4-001..024。

### 9.6 K5 `redactSealedMaterial`

```ts
export function redactSealedMaterial(input: Readonly<{
  aggregateID: M4.SealedAggregateID
  operationID: M1.RecoveryOperationID
  refID: M1.RecoverySealedRefID
  expectedGeneration: M1.SafeNonNegativeInt
  expectedState: "active"
  requestDigest: M4.SealedRequestDigest
}>): Effect.Effect<M4.RedactionReceiptV1, M4.RecoverySealErrorV1>
```

`M4.RedactionReceiptV1` exact immutable fields：`receiptVersion:1,receiptKind:"sealed-redaction",aggregateID,operationID,requestDigest,refID,previousGeneration,nextGeneration,previousBlobCommitment,redactedBlobCommitment,eventSequence,eventDigest`；使用M4 owner-qualified export，不定义本地duplicate。

- **Owner/落点/Callers**：M4 sealed maintenance service；explicit privacy/redaction service。
- **Callees contracts**：exact request builder、short DEFERRED scoped lookup+K0a、P3R/P3S、BEGIN IMMEDIATE、sealed request/event/authority-row builders、K0/table/cursor readback。
- **Requires**：stable aggregate/operation/full request/digest；function从ref/generation/state重建exact request；dedicated owner pair及parent creation authority存在。active generation/state只约束first apply。
- **Workflow/branches**：non-crypto structural validation→short read tx调用K0a先scoped lookup；existing才重建request/digest并返回stored receipt，不检查current generation/state/lease→K0a返回`undefined`时关闭read tx后重建/比较request digest，再BEGIN IMMEDIATE→K0a race relookup，existing仍返回stored receipt、`undefined`才进入first apply→K0验证parent+current authority及previousBlobCommitment→查询same ref/generation live use lease，任一存在返回`live-use-lease-conflict`且零mutation→无live lease才填creationAuthority/pin high-water/分配digest→generation/state CAS置redacted、raw+receipt+cursor→K0 full fold/table/lease readback→commit。
- **All errors/rollback/replay**：existing request mismatch conflict、fold corruption inconsistent且零写；missing first-apply owner/parent/generation/state/CAS rotate race/raw/readback失败rollback保留active；response loss从short lookup开始；不decrypt/keyring。time_redacted non-authoritative，只检查redacted branch nonnull。
- **Post**：exact replay不受current row/resource变化影响；first apply success只可能在无live lease时发生，使state redacted、six blobs null、generation+1、last_operation_id=current operation，scope/commitment/creation tuple保留；K3及任何旧generation lease永久失败，cleanup/old request不得恢复active bytes或revive lease。
- **Side effects/resource lifecycle**：replaySQLite reads；first applySQLite writes only；无keyring/decrypt/publish，buffers/statement随scope释放。
- **Invariants**：M4-I1/M4-I2/M4-I4/M4-I9；与K4 generation CAS单winner。
- **Termination**：一次short lookup、一次writer relookup、bounded transaction/retry与finite folds。
- **Test IDs**：T-K5-001..024。

### 9.7 K6 session cascade deletion support

```ts
export function deleteRecoveryOwnedStateForSession(
  tx: SessionDeletionImmediateTransaction,
  sessionID: string,
): Effect.Effect<M4.RecoveryCascadeDeletionProofV1, M4.RecoveryAuthorityErrorV1>
```

- **Owner/落点/Callers**：M4 private deletion support module；existing session deletion immediate transaction唯一caller；无standalone public delete。
- **Callees**：§4.2 aggregate-owner lookup、session row DELETE、FK cascade、fixed `RecoveryOwnedTableName` count queries、`foreign_key_check`。
- **Requires**：parent session delete authority已经在同一higher-level transaction确定；tx owns session row；owner mapping exact给出recovery/sealed aggregate IDs；不得nested begin；所有K3 callbacks已结束且M4-owned plaintext buffers已zeroize。若仍有live lease，K6必须先在同tx把它们CAS closed reason=`session-cascade`，不等待TTL。
- **Ensures**：先在同一tx按fixed table tuple读取`beforeCounts`，CAS关闭该session全部live leases并read-back无live row，再delete session→`event_sequence.owner_session_id`与owner row cascade→两个aggregate的EventTable rows，并cascade七materializations/三heads/sealed rows/lease rows；随后读取`afterCounts`并要求逐key为0，构造exact counts/FK proof。lease table作为separately named maintenance table计入`RecoveryOwnedTableName`删除证明，但不计七materializations。
- **Errors/transaction/replay/resource/algorithm**：missing/duplicate owner、unexpected second aggregate、before/after count unsafe或负差、任一remaining count非0、FK failure typed；同一higher-level immediate tx，不单独retry/commit；算法为read mapping→按fixed tuple读before→delete session exactly1→按fixed tuple读after/计算deleted→FK check→brand proof；statements释放。session delete本身的operation idempotency由parent owner contract处理，K6不把0-row当success。
- **Publication**：只允许existing public session Deleted signal按其owner contract在commit后发布；不发布internal recovery rows。
- **Test IDs**：T-K6-001..016。
- **正确性论证**：
  - **前置**：tx/session/owner mapping exact且无live plaintext callback。
  - **步骤/callee**：session→event_sequence owner FK、session→owner/derived/sealed FKs、event_sequence→event FK形成显式cascade chain；same-tx fixed `beforeCounts`、exactly-one delete、fixed `afterCounts`全0、逐key subtraction与FK check分别建立实际`deletedCounts`和零`remainingCounts`，private brand只在全部事实成立后附加。
  - **全部错误/rollback**：owner/delete/count/FK任一失败由parent tx rollback，恢复完整session/raw/derived/sealed；不发布Deleted。
  - **后置**：success无recovery/sealed orphan并返回typed proof。
  - **副作用穷尽**：higher-level SQLite deletion；commit后existing public Deleted signal；无internal/provider/tool/keyring。
  - **不变量保持**：M4-I5/M4-I7/M4-I9；删除后authority API只能返回session missing。
  - **终止**：fixed table tuple与single FK check有限。SQLite/WAL/backup历史页不声称法证级擦除。

## 10. MIG1 implementable migration contract

### 10.1 Module、signature 与schema version

```ts
export const RecoveryAuthoritySchemaVersion = 1 as const
export const RecoveryAuthorityMigrationID = "2026-08-session-recovery-authority-v1" as const

export function migrateRecoveryAuthorityV1(
  tx: Database.ImmediateMigrationTransaction,
  input: Readonly<{
    migrationID: typeof RecoveryAuthorityMigrationID
    expectedFromSchemaVersion: M1.SafeNonNegativeInt
    targetSchemaVersion: typeof RecoveryAuthoritySchemaVersion
    aggregateOwners: readonly Readonly<{
      sessionID: string
      recoveryAggregateID: M1.RecoveryAggregateID
      sealedAggregateID: M4.SealedAggregateID
    }>[]
  }>,
): Effect.Effect<M4.RecoveryMigrationReceiptV1, M4.RecoveryMigrationErrorV1>
```

- **Owner/落点**：`packages/core/src/database/migration/recovery-authority-v1.ts`；由`DatabaseMigration.apply`注册。
- **Callers**：database migration runner only。
- **Callees**：aggregateOwners exact validator、transaction-local DDL、M1 `buildEventChainDigestInput`+registered `event-chain-v1` digest builder、M4 sealed genesis builder、SQLite integrity/foreign-key checks、migration journal writer；不调用generic public row canonical encoder。
- **Requires**：支持两个exact startup入口：(a) fresh database，application schema处于owner-declared empty baseline且`session/event/event_sequence`尚无row；`aggregateOwners=[]`，MIG1创建完整v1 schema/journal，后续每个new session只走C1；(b) supported pre-v1 upgrade，base Session/Event schema exact存在，`aggregateOwners`按sessionID binary order逐existing session显式给出fresh dedicated recovery/sealed IDs。upgrade input中的IDs在全input跨session/跨role全局唯一、彼此不同且不得等于任何existing/public-generic/legacy session aggregateID；不得从event payload/message推断。unsupported/partial baseline均fail closed。migration只在startup migration tx执行。
- **Transaction/lock**：runner先取得`BEGIN IMMEDIATE`并传tx；函数禁止再begin/commit/rollback。WAL下该lock排除所有并发writer；现有reader可完成其旧snapshot。应用启动在migration成功前不得开放session writer。
```ts
export type RecoveryMigrationReceiptV1 = Readonly<{
  receiptVersion: 1
  receiptKind: "recovery-authority-migration"
  migrationID: typeof RecoveryAuthorityMigrationID
  fromSchemaVersion: M1.SafeNonNegativeInt
  toSchemaVersion: 1
  sessionsMapped: M1.SafeNonNegativeInt
  recoveryAggregatesCreated: M1.SafeNonNegativeInt
  sealedAggregatesCreated: M1.SafeNonNegativeInt
  publicRowsUntouched: M1.SafeNonNegativeInt
  aggregatesValidated: M1.SafeNonNegativeInt
  schemaDigest: M1.CanonicalDigestValue
  backfillDigest: M1.CanonicalDigestValue
  journalSequence: M1.SafeNonNegativeInt
}>
```

Migration journal exact table：`recovery_authority_migration_journal(migration_id TEXT PRIMARY KEY, from_schema_version INTEGER NOT NULL, to_schema_version INTEGER NOT NULL, receipt_json TEXT NOT NULL, schema_digest TEXT NOT NULL, backfill_digest TEXT NOT NULL, journal_sequence INTEGER NOT NULL UNIQUE, time_committed INTEGER NOT NULL)`；receipt_json immutable，无production UPDATE。

### 10.2 DDL 与mapping algorithm

1. 先读取application schema-version、base-schema classifier与同ID migration journal并执行closed branch：
   - schema=`targetSchemaVersion`且journal存在：进入idempotent verification，不比较`expectedFromSchemaVersion`；验证§4 internal columns/tables/index/check/FK/triggers、每session dedicated pair/genesis/owner mapping、schema/backfill digest，exact返回stored receipt；
   - exact fresh empty baseline + journal不存在 + `aggregateOwners=[]`：进入fresh-schema branch，创建Session/Event owner base tables（通过其owner migration hook）与本M4 v1 schema，不执行public shadow-copy/backfill，counts均0；
   - exact supported pre-v1 base schema=`expectedFromSchemaVersion`且journal不存在：进入upgrade branch；
   - 其它组合（target无journal、from有journal、fresh baseline却有rows/owners、unknown/partial version）立即typed failure。
2. fresh/upgrade first branch都确认没有同名intermediate/backup table或partial M4 owner/internal table/index/trigger；upgrade还要求base owner schema exact，fresh要求owner baseline empty。任一partial combination即`partial-schema`，不自动repair。
3. transaction-local DDL创建owner+七表/三head/sealed material+sealed-use lease/journal并调用Session/M1/M6 owner-exported fresh-or-upgrade migration hooks。fresh branch由owner hooks直接创建最终`event_sequence/event`列与constraints；upgrade branch才给existing tables增加nullable internal owner/kind/genesis与operation columns及partial indexes/checks。两branch都验证最终Session/MessageTable schema、assistant/user role constraints、relation/FK/cascade能力满足operations 1/2/9 atomic materialization；tool/reasoning表必须含M1 exact phase/carrier/commitment columns，sealed material purpose CHECK含tool/reasoning/prefix payload purposes，sealed-use lease table/partial live-key+live-generation unique indexes/history index/key+row digest domains/owner-process cleanup capability schema均完整。M4不复制/改写owner schema。upgrade的public-generic rows/aggregates允许新增列为null；M4不要求public aggregate获得recovery chain/authority digest。
4. fresh branch无existing public row，记录`publicRowsUntouched=0`并跳过copy。upgrade若SQLite需要shadow rebuild，只按existing columns复制public `event`/`event_sequence` rows并把新增M4 columns设为public-compatible null/default；“public serialized bytes unchanged”精确定义为每个existing public row的原有`id,aggregate_id,seq,versioned_type,data/encoded_data` TEXT/BLOB值按SQLite value与BLOB byte sequence逐项相等，row count/PK/order identity相等。新增nullable/default columns、index/trigger/schema page布局不纳入byte-equality，也不声称数据库文件物理pages不变。逐PK proof/FK后swap；**不decode/重新encodepublic payload、不生成chain/digest、不定义legacy canonical domain、不改变generic public writer authority。**
5. validate `aggregateOwners`：每个session存在且恰出现一次；recovery/sealed IDs全局fresh、跨session/跨role唯一、pairwise distinct，并与数据库中所有aggregate IDs（尤其legacy public session aggregate）不相等。cross-role triggers必须已安装并在tx内fault-check。
6. 按sessionID binary order，为每session按recovery→sealed固定顺序insert两个`event_sequence` rows exactly one：kind/owner exact且high-water empty。recovery row必须以M1 exact `{kind:"aggregate-genesis",hashVersion:1,aggregateID:recoveryAggregateID}`调用`event-chain-v1` builder并存其`M1.EventChainDigest`/version1；ownerSessionID与aggregateKind只进入owner metadata/schema/backfill digest，不进入EventChainDigest。sealed row独立存M4 `m4-sealed-aggregate-genesis-v1` digest/version1；随后insert owner map exactly one。任一0/多row或existing ID失败。
7. 不把任何existing legacy/public row映射进new recovery aggregate，不创建recovery raw/materialization/head/sealed row，也不从message/part/session_input/public projection猜测eligibility。迁移完成时所有fresh dedicated aggregates均为空；future A3/K4/K5从各自genesis开始seq0。
8. 建立/验证§4 fixed indexes/FKs/checks/current projection view与owner cross-role triggers；重读每session双向mapping、两个genesis cursors与public aggregate不相交；public row count/PK identity与step4列出的原有serialized TEXT/BLOB values必须与migration前exact相同。
9. `PRAGMA foreign_key_check`必须0 row；`PRAGMA integrity_check`必须单一`ok`；计算schema digest与只覆盖new internal schema/mappings/genesis plus public-byte-preservation proof的backfill digest。
10. 写immutable migration journal/receipt；runner commit。commit前不得publish runtime config/snapshot；成功后runtime C1只服务新session，不重复创建existing session mapping。

### 10.3 Idempotency、rollback、concurrent writers与typed errors

- schema=target + exact target journal/proof存在→idempotent success，允许caller仍传原`expectedFromSchemaVersion`；branch判定先看current schema/journal，不会被from-version precheck挡住；
- target columns存在但journal缺失、journal存在但schema/mapping/genesis/public-byte-preservation proof不符、shadow/old table残留、partial pair、unknown schema version→typed failure，不自动继续；
- 任一DDL/copy/pair insert/genesis/owner CAS/integrity/journal失败由runner rollback，包括SQLite transactional DDL与journal；
- multi-process writer在BEGIN IMMEDIATE处被busy timeout阻塞；migration runner最多3次指数退避+bounded jitter，仍busy返回`concurrent-writer`；不得切换DEFERRED或逐aggregate commit；
- application writer必须在schema-version startup gate后开放；不能一边backfill一边写新row。

### 10.4 MIG1 proof

- **前置**：runner持有唯一immediate migration tx，schema version exact。
- **步骤/callee**：DDL建立nullable internal extension与private tables；byte-preserving copy证明public rows不被M4重解释；C1-equivalent genesis builders与exactly-one inserts为每existing session建立fresh pair；cross-role triggers/FK/integrity/full reread建立mapping/genesis/public isolation；journal最后写。
- **全部错误/rollback**：version/partial schema/public-byte-change/ID collision/cross-role/partial pair/genesis/cursor/FK/integrity/journal任何失败抛typed error，runner rollback所有DDL/data/journal；busy在tx前无写。
- **后置**：成功时schema v1完整，每existing session映射fresh empty recovery/sealed aggregates，legacy/public aggregate及rows byte-preserved且未获得recovery authority，journal/receipt immutable。
- **副作用穷尽**：单SQLite migration transaction；无public row digest rewrite、EventV2 notify、provider/tool/keyring/unseal/public projection publication。
- **不变量保持**：M4-I1/M4-I5/M4-I7/I9与dedicated no-mixed-chain；legacy不升级保持old-data-unknown。
- **终止**：sessions/public rows有限，copy/ID validation各一次；retry最多3；integrity checks由SQLite终止或typed DB failure。
- **Test IDs**：T-MIG1-001..028。

## 11. Explicit Rely–Guarantee、ordering 与deadlock avoidance

### 11.1 Writer/read seams table

| Seam | Rely（环境承诺） | Guarantee（本seam承诺） | Transaction/ordering | Retry/deadlock rule |
|---|---|---|---|---|
| C1 new-session owner creation | SessionOwner提供fresh session/public aggregate identity并持parent immediate tx；IDs stable | session+fresh dedicated recovery/sealed cursors+cross-role owner map all-or-none；零raw/derived/seal/publication | parent tx内session→recovery cursor→sealed cursor→owner map→readback | retry只由parent管理；collision/partial state terminal，不nested begin |
| A3/O1/O2/O7–O9 control/admission writer | M6提供stable IDs/serialized ownership；M2 proof/cancel token不伪造；O8另提供branded same-snapshot slice-derived closure与exact live lease set；C1 pair已commit | scoped lookup/A4先于current policy/resource；type-9 first apply K8在cursor前；parent raw→K2 payload-rooted seals→七表/三head同tx；internal零publish | `BEGIN IMMEDIATE`; owner→lookup/replay or first-apply fold→policy/source/head→K8(type9)→cursor→raw→K2→derived→heads→readback | busy最多3；CAS loserS2读winner；replay不重prepare/check current budget/require old lease |
| O3–O6 M3 source-fact writer seam | M3提供committed assistant、stable operationID、immutable exact evidence/provenance；tool/reasoning literals遵守M1 codec | exact replay先行；first apply raw/fact/payload-rooted O4/O5 seals同tx；不调用tool/provider | A3 immediate tx；M3 callback在tx外，receipt return后才继续 | busy/failure停止下一副作用；sameID A5，不改evidence |
| O3a restart reconciliation | restart coordinator只提供latest authoritative planned/body-outcome/unknown call与new reconciled exact input；不提供body/hook callback | append-only type-4 transition到`reconciled-terminal-manual-only`，保留可验证既有outcome carrier但不发明result；body/hook/provider hits=0；允许O6 barrier但永久拒绝M5 automatic | one read定位latest call→A3 immediate append/readback；existing same operation只A4 replay | competing final/reconciled winner走closed conflict/reload；corrupt/ambiguous fatal，不从Legacy/history猜测 |
| generic public EventTable writer | source definition publication=public；不写/复用dedicated aggregate或M4 columns | 仅按其existing public owner contract写public aggregate；绝不写七表/三head/sealed/M4 digest | 与M4共享SQLite single writer lock；commit后P2 | M4不规定public digest/retry；不得在listener中nested write |
| M6 policy owner / A3 tx verifier | M6只publish committed row；owner-qualified normalizer exact | M4 exact replay在任何current read前；first apply1/2/9 exact comparehistorical fields并重算M/N | tx verifier复用A3 tx，不begin/config callback；M6 publish ordering由M6 owner contract | mismatch stale；不retry到new policy，不lock upgrade |
| K2 cross-aggregate initial seal creation | A3已在same tx插入含exact pending metadata的parent recovery raw；owner pair stable | sealed row creation tuple/last_operation_id绑定parent raw；无invented sealed-create/public event | A3 writer lock内parent raw→K2 rows→dual-authority readback | 任一ref failure由A3全rollback；replay不调用K2 |
| K7/K8 sealed-use acquire/validate | M5只交付same-snapshot branded automatic slice；M7先从slice构造/复验target-neutral M1 closure且不unseal；M2再预留stable no-send handle commitment；M1 lease key完整且generation positive；pre-release K8还要求complete type-9 result且same handle仍prepared | K7在任何unseal/lower/actual prepare前exactly-one live CAS；commit-time K8在type-9 cursor前验证但不授权F27；complete result后独立pre-release K8严格先于F27/M2 authorization/release。success才F27→exact authorize→release once→K9；failure cancel且F27/authorization/release calls=0→K9/zeroize | K7 immediate owner→dual fold/physical row→lease insert/readback；A3 tx内commit-time K8在policy/source/head后、cursor前；A3 return complete result→same handle prepared→pre-release K8独立short read→success F27/auth/release/K9或failure cancel/K9 | 无TTL/renew/reopen；generation0 fail closed且只能显式K4后fresh S1；closed/stale/mismatch不重建request或复用commit-time proof |
| K9/K10 sealed-use close/cleanup | M2/M6只在release/cancel/abandon/lost-handle事实后调用K9；K10持exclusive dead-process liveness fence | exact live→closed CAS并zeroize/drop M4 material；K10不由clock/heartbeat推断死亡、不lower/prepare/revive | K9 bounded immediate tuple CAS；K10 fence acquisition happens-before owner-process scan/CAS | same close idempotent；different reason/key conflict；fence不足保持live并fail closed |
| K4/K5 sealed writer | initial rows可由P3R parent prefix重建；所有maintenance mutation只走K4/K5 | exact replay before key/current-resource；first apply先拒绝same ref/generation任一live lease，再raw sealed event+row+receipt+cursor同tx；generation single winner/redaction terminal | short lookup/K0a→missing才prefetch(K4)→immediate race relookup→K0→live-lease guard→first apply | busy最多3；live lease/generation loser conflict；response loss从lookup开始；cleanup不能撤销redaction |
| K6 session deletion | parent deletion owns session row；foreign_keys ON；所有unseal callbacks已结束 | same tx先把live leases CAS `session-cascade`并证明无live row，再cascade owner/EventTable/七表/三head/sealed/lease且internal零publication | one higher-level immediate tx；counts→lease close/readback→delete session→verify counts/FK | 与A3/K4/K7/K9/C1竞争single writer；bounded busy，无TTL等待/lock upgrade |
| R1 rebuild | runtime recovery raw只由A3写，sealed maintenance只由K4/K5写，MIG1仅startup建empty aggregates；maintenance capability唯一 | 先以P3R/P3S→K0和physical exact comparator验证current sealed authority；不改raw/owner/cursor/seal；derived全替换或不变；silent | one immediate tx；pin expected heads→dual-prefix/sealed-table compare→delete/reinsert derived→readback | busy最多3；head/sealed mismatch零写；不逐表commit |
| MIG1 migration | startup gate阻止application writers | nullable internal schema+fresh pair mappings+journal all-or-none；public bytes不变 | runner-owned immediate tx；禁止nested begin | 3次后fail startup；不在线迁移 |
| §7.0/S1/S2/A5/P3R/P3S readers | writers使用WAL tx且不改已commit row identity；dedicated pair stable | admission staged views、generic nonterminal committed-assistant view或terminal snapshot在one WAL read内完整读取，不组合tx外truth；S1 mapping builder同tx；initial/ordinary/nonterminal reentry与terminal recovery输入分离；raw-referenced sealed metadata同snapshot验证；recovery/sealed domains分离 | public reader begin DEFERRED；helper/P3复用caller tx；first cursor read pins | busy最多3；不从read tx升级write；不auto-repair |
| O10 supersession gate | M6传入closed model/no-reply unprepared candidate+complete type-10 expected input/digest或expected dedicated current head | inspect用owner/P3R/A2/F6/F7验证empty/no-source/source/winner；unresolved只返回branded `supersession-required` complete facts且不调用O9；complete-input才O9+A5；model only返回proof，no-reply仅user-only，automatic才terminal snapshot/result | O10只做M4 write/read；inspect authority→complete input→model proof happens-before user/converter/M2，no-reply禁止M7/M2/O1 | partial input/mismatch/corruption fatal；response lossA5 complete result；无handle可retry/cancel |
| P2/P4 live public publication | source definition/brand正确public且DB已commit | per invocation at-most-one attempts、internal零wire、observer defect不回滚 | P2 listener/queue snapshot→P4 ordinary then sync attempts | queue overflow diagnostic+P5 replay；不重试authority tx |
| P5 public durable/history read | auth/cursor valid；public DB commit是source | SQL hard public filter+public decoder；aggregate/global cursor无歧义 | one DEFERRED read tx；与live notifier无transaction relation | busy bounded；caller分页；无observer retry |
| K3 keyring/unseal callback | callback遵守no-cache/plaintext contract；P3R/P3S/K0 raw authority与physical row未被direct mutation | same snapshot exact compare current sealed authority，DB read tx先结束；callback exactly once；finally zeroize | short tx dual-prefix fold+physical compare→close→keyring/decrypt/callback | raw/table divergence或redacted在key read前fail；不在DB tx等待provider |
| M2 prepare/authorize/release seam | initial/ordinary由existing converter给semantic candidate；automatic只接M4 branded same-snapshot slice，先预留stable no-send handle commitment；model supersession先持matching O10 proof；M4 result exact | prepare once hit=0；nonautomatic F26顺序不变。automatic K7 precedes unseal/lower/actual prepare，commit-time K8 precedes type-9 cursor；complete type-9 result后same handle仍prepared，独立pre-release K8 precedes any F27/M2 authorization/release。success才pass complete result+post-state to F27、exact authorize、exclusive latch delegate once、K9；failure cancel且F27/authorization/release calls=0、K9/zeroize | initial/ordinary: converter→M2→M4→F26→authorize/release；automatic: S1 view→M5 slice→M7 slice-only target-neutral closure(no unseal)→M2 commitment reservation→K7 slice+closure lease→M7 unseal/lower→M2 prepare+inspection→M7 validate→M5 classify→M4/commit-time K8→complete type-9 result(handle prepared)→pre-release K8→success branch F27→M2 exact authorize→exclusive latch→delegated release once→K9；failure branch mechanical cancel→K9→cleanup→A5/S2/replan。known predelegation failure保持authorized直到cancel；unknown delivery进入terminal released/unknown-delivery并K9/cleanup/fatal | preparation不因DB retry重做；commit unknown只在K9/cleanup后走A5；detached receipt/lease/commit-time K8 proof拒绝；cancel/abandon/lost handle都K9 close；pre-release failure不得调用F27/auth/release；K9 failure禁止cleanup/lookup |

### 11.2 No-direct-mutation rule

- C1是runtime唯一可在parent session-creation tx创建owner map与两个empty internal cursors的路径；MIG1只在startup为existing sessions做C1-equivalent mapping。二者都不写raw/derived/sealed material；
- 七materializations/三head/recovery operation columns只允许A3 first apply写、R1 derived-only替换、MIG1 schema initialization、K6 cascade；initial sealed row只允许A3-owned K2从parent raw创建；sealed maintenance operation/cursor/row transition只允许K4/K5；
- generic public writer只写其public-generic aggregate与publication=public rows，M4不要求或授权其写generic authority/event-chain digest；generic EventV2 projector、SessionStore、M6、M8、diagnostic/replay tool不得直接UPDATE M4-owned tables/columns；
- repair只能显式R1且仅七表/三head；owner/genesis/raw/cursor/sealed不由R1 repair，A4/A5/S1/K0a发现不一致不得auto-repair；
- test fault injection可通过transaction adapter模拟失败，但不能把direct write作为production API。

### 11.3 Multi-process WAL behavior

- SQLite WAL允许并发reader与单writer；`BEGIN IMMEDIATE`在transaction开始即争writer lock，避免先读后升级死锁；
- 不依赖进程内mutex证明跨进程互斥；数据库lock、unique index、cursor/head CAS才是authority；
- busy retry policy固定最多3次，指数退避上界由database service常量控制并含bounded jitter；operationID/payload/handle不变；
- busy exhaustion返回typed error。dispatch caller mechanical-cancel，绝不重prepare或release；
- 不在write transaction调用任意可能re-enter DB的Effect callback、Event listener、provider/tool、config plugin、keyring callback或M8 projector callback。

### 11.4 Ordering constraints

```text
session + C1 dedicated aggregate-pair creation commit
  happens-before A3/K2/K4/K5/S1/S2/R1/K6 use

initial committed user / ordinary committed predecessor
  happens-before current policy + candidate + M2.NoPreparedHandleProofV1
  happens-before M4 origin-specific no-handle authority view and M1.AdmissionPlan
  happens-before existing converter semantic candidate
  happens-before M2 one-time exact prepare
  happens-before M4 binds same view to M2.PreparedUnreleasedHandleProofV1
  happens-before M4 dispatch composite commit

M4.loadCommittedAssistantAuthorityView<K>
  requires committed type1/type2/type9 assistant with no terminal/closed source fact
  returns nonterminal:true generic view for initial/ordinary/automatic reentry
  is rejected once that assistant becomes terminal and never returns M1.DurableRecoverySnapshot

M1.DurableRecoverySnapshot construction
  requires durable terminal incomplete source
  includes assistantPublicMapping built in the same pinned transaction
  is excluded from fresh/initial/ordinary/nonterminal reentry/new-input no-source authority

S1 complete M4.DurableRecoveryAuthorityViewV1
  happens-before M5 selects one branded M4.AutomaticRecoveryProofSliceV1
  happens-before M7 constructs and verifies target-neutral M1.RecoveryClosureDescriptor from that slice with no unseal
  happens-before M2 reserves one stable no-send prepared-handle commitment
  happens-before K7 binds that same slice/closure and acquires the exact positive-generation live lease set
  happens-before any unseal, automatic lowering, or M2 actual preparation
  happens-before M2 one-time exact prepare + original M2.M2InspectionResult
  happens-before M7 validatePreparedRecoveryInspection
  happens-before M5 final classification
  happens-before A3 type-9 K8 live validation and automatic composite commit

M4 complete nonautomatic OperationCommitResultV1
  happens-before unchanged F26 validation of result.receipt + result.operationPostState
  happens-before M2 exact same-handle authorize
  happens-before M2 same-handle release exactly once

M4 complete OperationCommitResultV1<"automatic-child-admitted-and-consumed">
  happens-before independent pre-release K8 while the same handle remains prepared/unreleased/hit=0
  K8 success happens-before passing complete result + result.operationPostState to F27
  happens-before M2 exact same-handle authorization
  happens-before M2 same-handle release exactly once
  happens-before K9 released close and M4-owned material zeroization
  K8 failure happens-before mechanical cancel of the still-prepared handle
  establishes F27 calls=0 and M2 authorization/release calls=0
  happens-before K9 mechanically-cancelled/abandoned close and zeroization

K4/K5 first-application mutation
  happens-after exact replay lookup and current K0 validation
  requires no live lease for the exact ref generation
K10 process-crash cleanup
  happens-after exclusive dead-process liveness fencing
  never revives an old request, lease, candidate, or handle

M2 mechanical cancel or no-handle barrier
  happens-before automatic K9 close/zeroize when leases exist
  happens-before cleanup/finalizer completion and one-shot tombstone creation
  happens-before A5/S2/S1 ManualStop eligibility validation
  happens-before M4 ManualStop commit
  happens-before complete result and tombstone invalidation

O10 inspection exact unresolved-source validation
  happens-before O10 returns M4.SupersessionRequiredAuthorityV1
  happens-before caller constructs complete type-10 expected input
  happens-before O10 complete-input validation/commit

O10 model supersession/no-source complete-result validation
  happens-before O10 returns M4.SupersessionBeforePrepareProofV1
  happens-before existing ordinary converter handles the same submission/reservation
  happens-before M2 new-lineage preparation
  happens-before O1 type-1 authority using exact current/type-10 post aggregate head
  happens-before same-handle release

O10 no-reply supersession/no-source validation
  happens-before Legacy user-message-only commit
  excludes policy freeze, M7, M2, O1, model assistant, dispatch ledger, and M consumption

automatic winner validated by O10 S2/S1
  happens-before M6 reload/steer
  excludes M7/M2/O1 for that candidate branch

A3 parent recovery raw operation with exact pending-seal payload
  happens-before K2 initial sealed row insert in the same invisible transaction
  happens-before K0 treats that row as genesis sealed authority
  happens-before any K4/K5 maintenance event for that ref

raw/source fact commit
  happens-before S1 snapshot reload
  happens-before M5 classification
  happens-before O8 automatic composite

public DB commit
  happens-before P2/P4 live public notify
internal M4 commit never happens-before any internal notify because no such notify exists
```

### 11.5 Transaction nesting/callback/resource rules

1. C1复用SessionOwner parent immediate tx并禁止begin/commit；其它public M4 write wrapper不由caller外包DB tx，A3/K4/K5/R1各按contract拥有transaction；
2. A3/K2/P3R/P3S/S1 transaction-local helper接受tx参数，禁止再次begin；K2必须在parent recovery raw insert后调用；
3. MIG1 tx由migration runner拥有，函数不得commit；
4. K3在同一short read tx内完成P3R/P3S→K0 current fold与physical sealed-row exact compare；关闭tx后才读取key并执行decrypt/callback；
5. K4必须先完成scoped exact-replay lookup；只有missing branch可在tx外key prefetch，writer tx内仍relookup并revalidate；K5无key prefetch；
6. O10没有M7/M2 handle；matching proof返回后，prepared handle在owner-qualifiedM6/A3 DB retry期间保持同一对象，scope cancellation先mechanical cancel再local cleanup；
7. S2只开一个read tx并调用S1 helper/A4，禁止public S1 nested tx；R1的P3R/P3S复用其writer tx；
8. K7/K9各自拥有短`BEGIN IMMEDIATE`且不接受caller tx；A3 first-apply内commit-time K8复用A3 tx；complete type-9 result返回且same handle仍prepared后，pre-release K8自己开短DEFERRED read并在tx close/success proof产生前不得调用F27/M2 authorization/release。failure关闭read tx后mechanical cancel，F27/authorization/release calls=0，再K9；K10必须先取得exclusive dead-process fence再开writer tx，任何lease function都不在tx内unseal/调用M2/M7/provider；
9. no lock ordering cycle：SQLite writer lock是唯一durable lock；in-memory handle CAS/process-owner fence不在持有SQLite lock时等待；keyring/provider/tool/config/listener callback不在持锁时调用。

### 11.6 Normative per-function invariant/resource matrix

本表是各函数小节合同的一部分，用于把`invariants/transaction/replay/resource lifecycle`逐函数闭合；与各小节签名、owner、callers/callees、pre/post/errors、algorithm、proof和test IDs合并阅读，不能用本表省略小节语义。

| IDs | Invariant | Transaction/replay | Resource lifecycle |
|---|---|---|---|
| C1 | dedicated pair跨role唯一、no mixed chain；recovery genesis=M1 exact `event-chain-v1` aggregate branch | parent session-create immediate；no replay write | local M1/M4 genesis bytes；零raw/notify |
| A1 | exact M1 domain、无secret | pure/deterministic | canonical bytes digest后释放 |
| A2 | dedicated raw prefix→unique Legacy intents/seven fold/three heads；只fold authoritative tool/reasoning/prefix carriers与exact phases/order；不读Legacy compatibility、不造automatic proof；8–10 decisions deterministic | pure/same prefix same output；M1 exact empty genesis valid | fold maps/carrier decode buffers local；无clock/runtime fill |
| A3 | scoped replay-before-current-check；parent raw-first/exactly-one | one immediate；existing only A4，first apply branch-specific seals | same M2 handle不修改；tx candidates/buffers close |
| A4 | historical operation fold+original receipt，then current full fold | caller tx、zero write、no current policy/resource | statements/two fold buffers caller tx释放 |
| A5 | M1 `RecoveryOperationLookupKeyV1<T>`+full expectedInput+digest+receipt kind required；returns complete result | one deferred；owner proof validation then aggregate-scoped lookup；repeat read-only | no handle/pair creation/authorization；snapshot closes |
| O1 | model-lineage genesis；aggregate=current head；assistant/ledger genesis；Legacy user predecessor validated | A3/A4/A5；post-type-10 exact head+reservation separately checked | complete result；prepared handle仍paused；failure cancel |
| O2 | ordinal strictly +1；fresh invocation | A3/A4/A5 | old runtime closed；new handle paused/cancelled |
| O3 | tool append-only、exact `ToolExecutionPhaseV1`/call order/carriers/commitments、M4 SQL mapping total/bijective；nonfinal不升级proof | A3/A4 | no tool callback/resource |
| O3a | planned/body-outcome/unknown→append-only reconciled terminal manual-only；不重跑body/after-hook | latest-call read→A3/A4；competing terminal closed conflict | no callbacks；保留carrier重验；hits=0 |
| O4 | provenance+continuation-mode/content carrier exact；forced/unknown可authoritative但automatic-ineligible；payload-rooted seals without prepared | A3/K2；replay不re-seal | pending cipher buffers release；no plaintext |
| O5 | prefix exact、payload-rooted seals、no eighth table | A3/K2；replay不re-seal | refs/cipher buffers finite |
| O6 | settlement barrier before terminal；no decision | A3/A4 | no processor/tool/provider callback |
| O7 | cancel/no-handle barrier→K9/zeroize（如适用）→cleanup+secret-free one-shot tombstone→A5/S2/S1→commit；complete result后tombstone失效 | A3/A5；response loss只解析same operation | cleanup已在commit前完成；failure保持unsendable并fatal，不重prepare/复用tombstone |
| O8 | branded same-snapshot slice→M1 closure exact；positive-generation lease set exact；committed assistant predecessor；child ledger genesis/ordinal0；N/M/policy fresh；F27-before-pre-release-K8 forbidden | A3/A5/S2；first apply保留commit-time K8 before cursor；deterministic decision+Legacy child atomic；replay不要求old lease | complete type-9 result且same handle仍prepared→immediate pre-release K8；success才F27+M2 exact authorize+release once+K9；failure mechanical cancel、F27/authorization/release calls=0、K9/zeroize |
| O9 | closed model/no-reply type-10；candidate zero authority | A3/A5/S2；complete result；decision deterministic | no new handle；no-reply no model proof |
| O10 | only model success/no-source returns prepare proof；inspect unresolved returns branded source/control/predecessor authority；no-reply user-only；automatic steer-only；empty/no-source direct read | inspect=P3R/A2/F6/F7且O9=0；complete-input=O9/A5；S1 only terminal winner；no O1/M7/M2 tx | no handle；no partial input/proof；complete results local；no-reply/automatic no proof |
| §7.0 admission views | committed owner/current head/policy/predecessor/candidate；no-handle→prepared stage exact | each loader one deferred；each binder pure/M2 validator；A3 revalidates | four callable-specific §4.3.2 proofs；no terminal snapshot；proof lifecycle remains M2-owned |
| committed assistant view | K-indexed type1/type2/type9 result/assistant/context；nonterminal exact；type9 result单独不授权F27 | one deferred；historical admission+current full fold；terminal/closed rejected | initial/ordinary/automatic reentry only；no handle/snapshot creation；type9 continuation仍要求original prepared handle→pre-release K8→success F27/auth/release/K9或failure cancel/F27-auth-release-zero/K9 |
| assistant public mapping builder | snapshot identity/source/control/latest revision与Legacy mappings同tx exact | caller-pinned tx；read-only；no cache/history inference | M1 mapping local；no display ID allocation/publication |
| S1 | complete M1 snapshot+exact identity；four-way total/disjoint tool partition；safe-retry only truly-empty；Continue only authoritative final with ordered tool/reasoning/prefix proofs；compatibility/mixed/nonfinal/generation0 manual | wrapper one deferred；helper caller tx；empty/source-absent rejected；same-tx assistant mapping/sealed metadata；不acquire lease | branded immutable authority view/slices；M7 slice-only；wrapper closes statements |
| S1 helper | same terminal source snapshot/view as S2；provider-prefix proof与closure source binding exact | existing read tx/read-only | resources follow caller tx；no unseal/lease |
| S2 | winner fromhead、single tx、never guessed | one deferred with S1 helper/A4 | no handle/publication |
| R1 | expected-head branch exact；raw/owner/cursors immutable | one immediate；same raw idempotent；empty valid | temporary rows/maps/tx close；silent |
| P1 | public latest/server/public-durable writer只public；private durableReplay=public+internal | pure startup set proof | M4不复制assembler/types，private registry不进public DI |
| P2 | only committed public；per-invocation at-most-one attempts | post-commit/no DB replay；overflow uses P5 | listener/queue snapshot lifecycle |
| P3R | private recovery capability/dedicated family | existing tx/read-only | statements follow tx scope |
| P3S | private sealed capability/maintenance family | existing tx/read-only | statements follow tx scope |
| P4 | public guard；ordinary-before-sync attempt only | no DB tx；defects isolated | subscription/encoded buffer release |
| P5 | hard public filter；aggregate/global cursor closed union | one deferred/repeatable page | statements close；bounded result |
| K1 | keyed commitment、zero plaintext persistence | no DB replay | DEK/KEK/plaintext finally zeroized |
| K2 | parent raw exact payload iscreation authority | existing A3 tx；first apply only | cipher buffers caller/A3释放 |
| K3 | callback only aftercurrent dual-prefix/physical exact validation、same live lease/current positive generation与crypto | short read tx then key/decrypt/callback；closed/stale/redacted pre-callback fail | callback once；proof+lease不逃逸；all M4 buffers finally zeroized |
| K0 | dual-domain owner prefix；sealed generation/state monotonic | pure/deterministic | two local fold maps；time fields excluded |
| K0a | stable request scoped lookup+historical/current dual fold/original receipt | caller tx/zero write、missing=`undefined` before key/resource | statements/fold buffers tx-scoped |
| K4 | replay lookup beforekey；first apply拒绝same generation live lease；only DEK rewrap、generation+1 | short read→missing prefetch→one immediate relookup/K0/live guard | DEK/KEKs zeroized；replay no key；generation0可显式rotate到1 |
| K5 | replay lookup beforestate check；first apply拒绝live lease；redacted terminal/finality | short read→one immediate relookup/K0/live guard | no decrypt/key resource；cleanup不能restore |
| K6 | owner/FK cascade noorphan；先close session live leases并验证0 live | parent immediate tx | no active callback/plaintext；lease rows separately counted；proof local |
| K7 | exact M1 lease key、positive current generation、same snapshot/action/operation/candidate/target/handle；live exactly-one CAS | one immediate；dual-prefix/table validation→insert/readback；no implicit rotate | nominal lease only；no unseal/lower/prepare before success |
| K8 | commit-time branch在type-9 cursor前验证input/live set但不授权F27；pre-release branch在complete result后、same handle仍prepared时验证same complete live set、generation、result/operation/handle，严格先于F27/M2 authorization/release | commit-time borrow A3 writer tx；pre-release one short independent read；zero-ref exact empty；两次不可互代 | success proof dynamic-scope only允许result/post-state→F27→M2 exact authorize→release once→K9；failure cancel且F27/authorization/release calls=0→K9/zeroize；不close/renew lease |
| K9 | release/cancel/abandon/lost-handle exact live→closed；same close idempotent | bounded immediate CAS/readback | zeroize/drop M4 material；never revive |
| K10 | exclusive dead-process fence only；no TTL/heartbeat inference | fence happens-before bounded owner-process live→closed CAS | no request/candidate/handle recreation；fresh recovery required |
| MIG1 | fresh empty pair/schema/journal all-or-none；public bytes unchanged | runner immediate；target+journal exact idempotent | shadow state only tx-visible；startup gate |
| M6 policy owner / M4 tx verifier | historical policy in input/receipt；same epoch=same digest | M4 only existing A3 tx read；owner publish not re-specified | runtime swap belongs M6 and only post-commit |

## 12. Future test mapping

以下全部为 `[F — planned; not created; not run]`：

| IDs | owner / fixture | 精确 pass criteria |
|---|---|---|
| T-C1-001..012 | session creation owner fixture | session+two fresh cursors+owner map atomic；recovery genesis exact M1 `event-chain-v1` aggregate input/vector；owner metadata不改digest；cross-session/role/public ID collision、每insert rollback、empty readback、zero publication；genesis可作fresh initial current head但terminal snapshot construction=0 |
| T-A1-001..006 | core canonicalization | M1 payload/event domains exact；extra/secret/unsafe number/unknown version失败；deterministic bytes |
| T-A2-001..012 | core fold property tests | empty/nonempty prefix；authoritative tool five-phase/order/carriers/commitments与reasoning/prefix carrier exact fold/readback；A2 compatibility decoder/proof constructor calls=0；8–10 decision exact rebuild且无clock fill；1/2/9 Legacy assistant intents；public/legacy/mixed/gap/hash非法失败 |
| T-A3-001..034 | `recovery-authority.test.ts` fault matrix | scoped exact replay在policy/N/M/prepared/key/resource前；type1/2 first apply逐项重验M4 origin view owner/current head/policy/predecessor/candidate与M2 exact prepared proof；first apply cursor→raw→K2→七表/三head每点失败全rollback；branch-specific seals |
| T-A4-001..016 | exact replay corruption matrix | historical operation-prefix/input/policy/receipt先验证，current full prefix/fold另验证；任一篡改拒绝 |
| T-A5-001..009 | response-loss | M1 `RecoveryOperationLookupKeyV1<T>` scoped exact lookup返回original operation/applyMode/post-state/receipt complete result；跨session/aggregate/kind不命中；partial不当missing；detached receipt无authorization |
| T-O1-001..014 | initial/ordinary/new-lineage | fresh initial uses M4 staged authority without recovery snapshot；type-1 aggregate genesis与nonempty current-head均成功；post-type-10 exact head；wrong owner/policy/user/candidate/reservation/head/M2 proof失败；ordinary distinct view；assistant/ledger genesis；existing user验证且不重建；complete result authorize |
| T-O2-001..012 | subsequent dispatch | fresh invocation/ordinal+1；concurrent CAS single winner；prepared refs=payload refs；failure cancel hit0 |
| T-O3-001..016 | tool evidence | M4-owned mapping对M1 exact tool domains total/bijective round-trip；all five `ToolExecutionPhaseV1` branches exact；callOrdinal/arguments/result-or-error/carrier/three commitments/sourceRange order readback；unknown literals不伪false且automatic-ineligible；illegal transition/missing carrier/digest-only rollback |
| T-O3A-001..014 | restart tool reconciliation | planned/body-outcome/unknown分别append reconciled terminal manual-only；body outcome carrier exact保留；body/after-hook/provider hits=0；competing final/reconciled reload；Legacy/history fallback=0；O6 barrier可close而S1/M5 automatic=0 |
| T-O4-001..014 | reasoning evidence | no prepared package；exact provenance+continuation-mode/content carrier/text digest/source order；forced/unknown authoritative可persist但automatic-ineligible；payload-rooted parent seal authority/scope、plaintext SQL/log零泄漏 |
| T-O5-001..011 | provider prefix | no prepared package；payload-rooted seals；raw slice进入snapshot；无第八table依赖 |
| T-O6-001..014 | terminal | terminal与tool/reasoning final facts原子；planned/body-outcome/unknown barrier拒绝；final或reconciled允许close；reconciled不自动；decision未提前创建 |
| T-O7-001..014 | ManualStop | mechanical cancel严格先于commit；commit failure handle仍unsendable；相关leases K9 cancel/abandon close；无child/release |
| T-O8-001..028 | automatic child | only branded same-snapshot action slice；Continue closure source/order/carriers/prefix/closureDigest exact；assistant-chain genesis/wrong source拒绝；child ledger non-genesis/nonzero拒绝；commit-time K8 exact live lease set/generation/operation/handle before cursor且F27 calls=0；zero-ref empty set；deterministic decision+Legacy child atomic；complete type-9 result返回时same handle仍prepared；immediate pre-release K8 success后才F27+M2 exact authorization+release once+K9；pre-release K8每种failure均prepared→cancelled、F27/authorization/release calls=0、K9/zeroize；exact replay不依赖closed historical lease但授权仍需same live handle+fresh pre-release K8 |
| T-O9-001..014 | supersession | both branches persist/recompute full `SupersessionBindingDigestInputV1`+digest including submission payload/source/control/predecessors；model intended ID exact；no-reply user-only disposition and no type1 ref；superseded decision uses supersession digest not BindingDigest；complete superseded/automatic result；failure zero new authority |
| T-O10-001..020 | M4 supersession gate | reservation vectors/pre-prepare exclusions；inspection empty/no-source branch snapshot calls=0；unresolved source只返回branded `supersession-required` exact source/control/predecessors，O9 calls=0；complete-input reentry才commit；model proof exact post head；no-reply user-only/no proof/zero policy-M7-M2-O1；automatic winner才load terminal snapshot；A5 complete result |
| T-ADMVIEW-001..018 | initial/ordinary authority views | committed owner/current head genesis-or-event/current policy/Legacy predecessor/candidate exact；四个callable各自proof trace；M2 no-handle→prepared proof lifecycle；stale head/policy/proof rejected；initial/ordinary snapshot calls=0 |
| T-COMMITTED-VIEW-001..016 | generic committed-assistant authority | K=type1/type2/type9分别映射origin/assistant/context；admission historical+current facts same WAL；initial/ordinary/automatic nonterminal reentry成功；type9 replay result单独F27/authorization/release calls=0，只有原same prepared handle+fresh pre-release K8 success才进入F27/auth/release/K9，failure cancel/K9；terminal/finalized/consumed/superseded source拒绝并要求S1；no snapshot/handle creation |
| T-PUBMAP-001..012 | same-tx assistant public mapping | source/control/high-water/latest revision identity exact；entries binary order；absent/duplicate/wrong-role/cross-session/stale拒绝；second tx/cache/history/display-ID allocation calls=0 |
| T-S1-001..028 | terminal snapshot WAL concurrency | complete M1 snapshot wrapper+identity exact；four-way partition truth table(0/0,>0/0,0/>0,>0/>0) total/disjoint；compatibility-only/mixed不可折叠empty；SafeRetry仅truly-empty；all nonfinal/reconciled manual；Continue proofs一一绑定same snapshot raw anchors、ordered carriers/commitments与唯一provider-prefix；M7只收branded slice且structural fake/other snapshot拒绝；Legacy payload replay calls=0；generation0/redacted/unreadable manual；S1 lease acquisition/unseal=0；concurrent commit只见完整前/后态 |
| T-S2-001..010 | recovery winner lookup | S1 helper+A4同一read tx；从winning head发现closed winner；unknown/corrupt不猜测 |
| T-R1-001..018 | rebuilder | Legacy assistant/message + deterministic decisions + validated/deterministic display mapping；expected-head branches；sealed exact compare；different-existing/failure rollback；零event |
| T-P1-001..012 | manifest integration | M1 owner assembler；public latest/server/public-durable writer三面只含public；trusted private `EventManifestSet.durableReplay`含public+internal且不注入public service；internal只在internalRuntime/durableReplay；set equality/cross-injection失败startup；M4无duplicate assembler/type |
| T-P2-001..007 | core public notify | internal零listener；per-invocation at-most-one attempts；listener isolation；queue overflow diagnostic+durable replay、不回滚 |
| T-P3R-001..009 | private recovery reader | capability/owner/kind/empty/ordered internal only；每row decode必须携M4 same-tx构造的M1 `M4RecoveryAggregateOwnerMappingProofV1`，structural/foreign proof拒绝；closed callers含A-family/S1/R1/MIG1与dual-prefix K0a/K3/K4/K5；HTTP不可达；public/mixed拒绝 |
| T-P3S-001..009 | private sealed reader | capability/owner/genesis/ordered maintenance only；closed callers含A4/S1 metadata validation与K0a/K3/K4/K5/R1/MIG1；initial authority另由P3R parent；A4/S1不decrypt/要求active；HTTP不可达 |
| T-P4-001..008 | bridge | internal ordinary/sync emission0；ordinary defect不阻止sync attempt；invocation order不扩大全局delivery |
| T-P5-001..012 | sync/history | aggregate cursor必须aggregateID；workspace用global cursor；hard public SQL+decoder；partial decode零response；live语义分离 |
| T-K1-001..009 | seal prepare | HMAC/GCM/key unavailable/finally zeroize；零DB residue |
| T-K2-001..012 | pending persist | parent tuple/payload exact；dispatch与O4/O5 branch rules；creation tuple/last_operation_id；duplicate/conflict/A3 rollback无orphan |
| T-K3-001..016 | unseal callback | P3R/P3S→K0 current authority、physical row与same live positive-generation lease exact；closed/stale/generation0/restored-old-active/redacted在key/callback前拒绝；scope/AAD/GCM/HMAC；M1 lookup proof只在key-readable后附brand并与bytes+lease callback once；all exits zeroize/drop proof；public/plugin无法取得capability |
| T-K0-001..014 / T-K0A-001..016 | sealed fold/replay | M1 creation prefix+M4 maintenance prefix domains/order；stable request scoped lookup missing=`undefined` before resource；K0a return/receiptKind由operation generic T条件索引且rotate/redact交叉compile失败；historical/current full fold；digest substitution/parent missing失败 |
| T-K7-001..020 | sealed-use acquire | exact full M1 key vectors覆盖ref/generation/material/scope/purpose/source/action/operation/session/candidate/target/handle；branded slice+M1 closure builder、snapshot identity与safe/Continue closure binding持久化/readback；generation0/foreign/redacted/stale拒绝且无implicit rotate；exact same owner replay returns nominal lease，different owner conflict；insert/readback/digest/unique fault rollback；unseal/lower/prepare before acquire calls=0 |
| T-K8-001..018 | sealed-use validation | commit-time K8与独立pre-release K8分别验证same complete lease set、current generation、snapshot/closure source、operation/result/candidate/target/handle且不可互代；complete result→same handle still prepared→pre-release K8→F27→M2 exact authorization→release once→K9顺序断言；在pre-release K8 success前F27/authorization/release calls=0；missing/extra/duplicate/closed/stale/mismatch/read failure均prepared→mechanically-cancelled、F27/authorization/release calls=0、K9/zeroize；zero-ref exact empty；detached/old/commit-time proof不能authorize |
| T-K9-001..014 | sealed-use close | released/cancelled/abandoned/lost-handle live→closed；same reason idempotent、different reason/key conflict；all M4 buffers zeroized；closed row不授权/renew/reopen |
| T-K10-001..014 | dead-process cleanup | exclusive process-owner fence required；wall clock/TTL/heartbeat ignored；only dead owner live rows close；fence failure leaves rows live；no lower/prepare/new candidate/operation/handle；future use requires fresh S1/K7 |
| T-K4-001..024 | rotation | exact replay lookup before key prefetch/crypto；writer race relookup；same ref/generation live lease conflict before unwrap；generation0→1 explicit path then fresh S1；raw+receipt+row/cursor同tx；only rewrap |
| T-K5-001..024 | redaction | exact replay before current state；parent authority；same-generation live lease conflict before mutation；rotate race single winner；blobs null/open fail；closed/old lease and cleanup cannot restore bytes or revoke redaction finality |
| T-K6-001..016 | session delete | active callback precondition；same-tx live leases→session-cascade closed→0 live→owner/EventTable/七表/三head/projection/sealed/lease cascade；lease separately counted, not materialization；`deletedCounts=before-after`且`remainingCounts`全0；failure rollback；internal event0 |
| T-MIG1-001..028 | database migration | exact fresh/upgrade branches；tool/reasoning phase+carrier columns；all sealed material purposes；separate lease table/live-key+live-generation partial unique indexes/history index/key+row digest/schema digest/cascade；seven materializations/three heads unchanged；recovery genesis exact M1 vector；cross-role exclusion；upgrade public bytes unchanged；rollback/idempotency/integrity/journal/writer exclusion |
| T-RG-001..026 | multi-process SQLite harness | C1/A3-K2/O3a/K7-K10/K4-K5/O10/S1-S2/R1/delete races；lease acquire-vs-rotate/redact/delete/crash cleanup single winners；commit-time与pre-release K8 live guard不可互代；pre-release read race只允许success F27/auth/release/K9或failure cancel/F27-auth-release-zero/K9；single writer、bounded busy、no nested callback/process-fence deadlock |
| T-SECRET-001..008 | SQL/log/SSE scans | plaintext/KEK/DEK/raw handle/full secret digest零出现 |
| T-POLICY-001..018 | M4 policy integration | historical fields in input/receipt；A3 replay before tx verifier；N=2/M=64；effective M唯一读取`normalizedPolicy.digestInput.effectiveMaxModelAssistants`；不存在top-level access；configured M/provenance/runtime config/runtime agent steps reread或重算calls=0；first-apply stale rejection；M6 owner publish tests不重复 |

## 13. 完整性自检 checklist

以下项目保持unchecked：它们是implementation前的future mechanical/independent audit gates；本文修订只闭合设计contract，不把未创建/未运行的实现与测试写成已验证事实。

### 13.1 Review blockers

- [ ] Initial/ordinary保持M4 origin-specific no-handle view→plan→existing converter→M2 once→same view prepared proof→M4→既有F26授权顺序；fresh empty current head为C1/MIG1 genesis且snapshot calls=0。automatic保持terminal snapshot→M5 select→M7 lower→M2 original inspection→`M7.validatePreparedRecoveryInspection({ candidate, inspection })`→M5 classify→M4 commit-time K8→complete type-9 result（same handle仍prepared）→immediate pre-release K8；只有success才pass complete result+post-state to F27→M2 exact authorization→release once→K9，failure必须prepared→cancelled、F27/authorization/release calls=0→K9/zeroize；detached receipt/proof拒绝。
- [ ] O10接受closed model/no-reply unprepared candidate；inspection empty/no-source直接读dedicated current authority，unresolved只返回branded `supersession-required` exact source/control/predecessor facts且O9 calls=0；caller补齐complete expected input后重入O10才commit；model/no-reply完整supersession binding input+digest持久化并重算，model proof绑定full binding与exact type-10 post head；no-reply无reservation/proof且只user commit；automatic winner才load terminal snapshot/reload/steer。
- [ ] A3按`(aggregateID,operationID)`先做A4 exact replay，再做current policy/N/M/prepared/key/resource checks；historical operation prefix与current full prefix分开验证。
- [ ] R21 snapshot authority：M4 `DurableRecoveryAuthorityViewV1`完整包装M1 snapshot；safe-retry/continue slice均有private brand并绑定exact snapshot identity；四种tool partition cardinality total/disjoint，只有truly-empty SafeRetry，compatibility-only/mixed及任一nonfinal/reconciled phase ManualStop；Continue包含ordered raw-anchored tool/reasoning/provider-prefix proofs与closure source binding；M7只收slice且不能收裸snapshot/fold/manual branch。
- [ ] R22 replay carriers：tool arguments/result/error、reasoning content、provider-prefix content均有canonical inline/sealed reconstructible carrier、exact ordering/source range/phase与owner commitment双重readback；M7构造M1 `RecoveryClosureDescriptor`后重算closure digest并反向比较；Legacy/history/cache不得作为content；raw/public/SQL均无unsealed sensitive bytes。
- [ ] R23 tool phase：all five M1 phases逐值persist；O3a只把restart-observed planned/body-outcome/unknown append到reconciled terminal manual-only，body/after-hook hits=0；O6 barrier可close但M5 automatic固定拒绝；future phase/test matrix覆盖competing winner与carrier preservation。
- [ ] R24 sealed-use lease：separate `sealed_recovery_use_lease` maintenance/CAS table完整绑定M1 key；generation必须positive且0不能cast；K7先于unseal/lower/actual prepare；commit-time K8保留在type-9 cursor前且不授权F27，complete result后same handle prepared时立即执行独立pre-release K8，success才F27→M2 exact authorization→release once→K9，failure cancel且F27/authorization/release calls=0→K9/zeroize；K4/K5 live conflict，K9/K10/cascade只live→closed并zeroize；无TTL/renew/reopen，dead-process cleanup需exclusive fence，redaction finality不可逆；该表不计七materializations/三heads。
- [ ] Pending-seal rules closed：dispatch package refs=payload refs；O4/O5无prepared package但可带payload refs；其它operations必须空。
- [ ] Initial sealed row由parent recovery raw exact payload提供genesis authority；K2写parent aggregate/operation/sequence与non-null last_operation_id；K0/K0a按M1 creation prefix→M4 maintenance prefix显式domain/order fold。
- [ ] K4/K5 exact replay lookup先于key/current-state/resource check；response loss从same scoped lookup开始。
- [ ] C1把session+fresh dedicated recovery/sealed empty cursors+cross-role owner map放在同一session-creation tx；MIG1为existing sessions创建fresh pair，legacy/public aggregate不混链且public bytes不改。
- [ ] C1/A2/S1/R1/MIG1 recovery aggregate genesis全部逐字使用M1 `event-chain-v1` `{kind:"aggregate-genesis",hashVersion:1,aggregateID}`与`M1.EventChainDigest`；不存在任何M4-local recovery-genesis domain或owner metadata→EventChainDigest cast。
- [ ] M4-private signature/result/error/proof/authority-view types均在§3.1/owner section有exact fields、invariants、identity、lifecycle、owner/consumers；exported M4 proofs使用module-private unique-symbol brands；`RecoveryErrorV1<K>`保持kind-indexed reason correlation；K0a receipt由operation generic条件索引；M2 exact proof/lease只由S3 owner定义，M4只调用`validate*ProofV1`且无structural copy。
- [ ] Tool/reasoning SQL mapping对M1 exact domains total+bijective；provenance与continuation-mode完整持久化；compatibility-only evidence不能进入automatic proof；无fictitious M1 SQL codec。七derived-row/三head与recovery/sealed post-state digest均有exact domain/builder/recompute rule；decision `reason_codes`绑定M1 F23 ordered codec branch。
- [ ] Public latest/server/public-durable writer三面只含public；trusted private `EventManifestSet.durableReplay`含public+internal但不注入任何public surface；P1 set obligations/tests闭合。
- [ ] §7.0 initial/ordinary staged authority、generic `CommittedAssistantAuthorityViewV1<K>` nonterminal reentry与S1 terminal snapshot三边界分离；四个admission loader/binder各有独立§4.3.2 proof；S1同tx构造assistant-public mapping并验证referenced sealed metadata；S1/S2 single-terminal-snapshot、R1 expected-head五branch/error mapping及P3R/P3S→K0/physical sealed exact validation、P3R/P3S caller split、FK `(aggregate_id,event_seq)->event(aggregate_id,seq)`均显式。
- [ ] P2–P5 delivery/cursor/error/resource proofs、M4 policy integration、K0/K0a与error-handling strategy均按pre→callee steps→all errors/rollback→post→side effects→invariants→termination闭合；publication依赖M1 canonical registry nominal capability而非forgeable field；不重定义M1/M6 owner实现。
- [ ] §12每个per-function Test ID range exact一致，并覆盖C1/P3R/P3S/O10/cross-aggregate seal authority；§11 Rely–Guarantee覆盖对应seams与ordering。
- [ ] Evidence wording is S-only seams；design HEAD/source-equivalent evidence HEAD/No upstream/F labels exact。

### 13.2 Architecture preservation

- [ ] `EventTable` raw envelope remains sole authority：recovery facts来自dedicated M1 raw；initial sealed facts来自parent recovery raw；maintenance来自dedicated M4 raw。seven materializations and three recovery heads remain fixed。
- [ ] Type-1是model-lineage genesis且aggregate predecessor为exact current head；post-type-10使用exact post head；assistant/ordinal0 ledger仍genesis。M1 types owner-qualified，无informal receipt/result alias。
- [ ] M1 safe projection table是append-only materialization并有current view/index；M8仍是display-only consumer。
- [ ] first-apply input/receipt携带historical policy scope/epoch/digest/default semantics；N=2、M=64固定；M唯一读取tx verifier返回的committed `normalizedPolicy.digestInput.effectiveMaxModelAssistants`，不存在top-level字段访问，也不从configured M/provenance/runtime config/runtime agent steps重读或重算；policy变化不撤销committed replay。
- [ ] Automatic authority handoff固定为commit-time K8（A3/O8内）与pre-release K8（complete type-9 result后）两个独立gate：same handle在后者完成前保持prepared；F27不得提前；success-only result/post-state→F27→M2 exact authorization→release once→K9，failure prepared→cancelled且F27/authorization/release calls=0→K9/zeroize。nonautomatic F26不变。
- [ ] ManualStop ordering固定为cancel/no-handle barrier→automatic K9 close/zeroize（如适用）→cleanup并保留secret-free one-shot tombstone→A5/S2/S1 eligibility→type-8 commit→complete result后tombstone失效；M4-I11由O7+M2/M6拥有。failed automatic commit后仅在上述barrier/cleanup后由exact lookup证明absence/no winner且source binding仍valid才可ManualStop；authority corruption必须fatal。
- [ ] Internal source-level publication通过M1 manifest integration、P2/P4/P5 hard split零泄漏；R1 silent；public-generic writer/digests不在M4 scope。
- [ ] Secret/keyed commitment/callback lifetime/rotation/redaction/cascade与non-authoritative timestamps边界显式。

### 13.3 Implementation gate

- [ ] Gate顺序固定：本文先标记为revised-design review candidate → 独立design review完成且所有findings关闭 → user explicit approval → workflow Step 0 expectations产出并通过；在candidate、review、approval、Step 0四个gate依序完成前，不得进入任何implementation-order list、代码、测试或codegen。
- [ ] All implementation/test claims remain `[F — planned; not created; not run]`；本文没有把source seam或历史测试外推为future proof。
- [ ] No implementation may begin by weakeningexactly-one rows、dedicated aggregate ownership、historical+current exact replay、parent-operation sealed authority、O10 proof-before-prepare、same-handle authorization、cancel-before-ManualStop、single-snapshot S2、P2/P5 delivery split、private publication or no-direct-mutation rules。
