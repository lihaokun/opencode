# Issue #7 Session Recovery 全局详细设计索引

> Issue：[#7](https://github.com/lihaokun/opencode/issues/7)
>
> 状态：详细设计与四份Workflow Step 0 expectations已批准并推送；D0 M1 package-ownership correction已随`085698426f466b6fc01215c4cb34d89b73ef8290`推送，M1-A foundation已随`deb84e90a9051511db3c9ca69f52cacdaf45af2e`推送，M1-B F1/F2及97个production/core caller迁移已随`8bcb26e5384a22804dd73da7aef85e5f0b4e99e8`推送。当前changeset实现并完成独立review的是SESSREC-1 M1-C F4 recursive exact field-set boundary；文档同步与commit/push仍在当前gate。F3、F5–F31、recovery runtime、future acceptance与完整Step 5 audit仍未完成。
>
> 范围：仅 Legacy Session recovery。Native V2 只作为 shared compatibility regression consumer，不具有 recovery flow、API、event、expectations 或测试产品范围。
>
> 固定预算：automatic recovery默认`N = 2`；配置规范化时model-assistant默认`configuredM = 64`并导出`effectiveMaxModelAssistants`；runtime admission唯一 authority为transaction-verified committed `NormalizedRecoveryPolicy.digestInput.effectiveMaxModelAssistants`，predicate为`assistantSequence < effectiveM`，禁止runtime reread/re-min。
>
> 证据边界：50/50 scoped checks 仅是 source-equivalent `135f20215`、Bun `1.3.14` 上的当前直接 A/B/C/D 行为证据；S统一写作`[S — source seam only]`。M1-A、M1-B F1/F2与当前M1-C F4的runtime/property/type/package evidence都只是partial implementation evidence，不证明F3、F5–F31、automatic recovery、future acceptance或完整Step 5完成；其余future项仍为`[F — planned; not created; not run]`。

## 0. 文档权威、阶段与证据边界

### 0.1 权威顺序

1. 实施proposal只对Issue需求、根因、产品范围与原始证据具有规范性；它不拥有任何实现schema、接口、ordering或persistence contract。
2. 当前[`architecture.md`](./architecture.md)、本文件与owner子计划共同构成已通过independent design audit并获用户批准的implementation contract。D0只修正真实package dependency对应的M1内部call graph；发生冲突时不得以proposal旧实现描述覆盖当前合同。
3. 四个子计划分别唯一拥有函数级结构、分支、错误、proof 与私有类型；本文件只建立全局 owner/export/call/evidence/review 索引，不复制共享类型 shape 或函数 body。
4. `architecture.md` §12 的六项是已冻结设计选择，不是开放alternatives；全部六项此前已验证的P0/P1 owner issues（R21–R26）的owner contracts已修复，整个approved contract的fresh independent design audit已达到`0 P0 / 0 P1`且用户批准、Step 0均已完成；D0不得借package call-graph修正改写这些选择。
5. 同一跨模块名称出现漂移时，采用**声明该类型或函数的唯一 owner 文档**中的 exact versioned name；consumer 文档的旧 alias 不构成第二 owner。

### 0.2 当前阶段

| 项目 | 当前状态 |
|---|---|
| 架构 | 已通过independent design audit并获用户批准；D0 package-ownership correction与fresh review均已完成。 |
| 全局详细设计 | 已批准implementation contract；exact owner/export/callable/order已同步，D0 changed snapshot为`0 P0 / 0 P1`。 |
| Owner 子计划 | 四份函数级设计均存在；SESSREC-1已完成schema-owned raw definition set与LLM-owned enriched registry拆分，其余owner合同冻结。 |
| Independent design audit | 原stable six-document snapshot与D0 changed snapshot均为`0 P0 / 0 P1`；D0 reviewer另给出2个P2 metadata/wording项，已在本changeset修正。 |
| Step 0 | **已完成**：四份 per-subplan contract-audit expectations已创建、审查、commit并push（`acc7d0bcf`）。 |
| Production implementation | M1-A foundation与M1-B F1/F2已推送；当前changeset在`packages/schema/src/llm.ts`实现F4 `validateExactFieldSet`，且已完成runtime/type/property、package/monorepo验证与独立review。F3、F5–F31及M2–M8未开始。 |
| Future tests / Step 5 implementation audit / migration / codegen | M1-A、F1/F2与F4 focused/runtime/property/type/core compatibility evidence已创建并运行；F3、F5–F31 future acceptance、完整Step 5 audit-report、migration与codegen未创建或未执行。 |
| Shell | **N/A**于provider recovery；仍进入M6 per-session serialization，但绕过supersession recovery、policy、M7/M2、N/M与model admission。 |
| Public authority event | **不存在且禁止新增**；`session.recovery.*` authority variants 必须在 source-level event definition/publication partition 处排除。 |
| Current gate | M1-C F4文档同步、commit/push → F3 raw recovery definition set；不得提前进入F5–F31或SESSREC-2。 |

### 0.3 A/B/C/D/S/F

| 等级 | 当前可引用范围 | 不得外推 |
|---|---|---|
| A | 10 个真实 Legacy CLI scoped checks 及其直接断言 | automatic recovery、通用 replay safety、TUI E2E |
| B | 1 个 live HTTP/generated SDK scoped check | 外部 consumer 验收、recovery correctness |
| C | 10项：7个`SessionPrompt` + 3个TCP processor | ledger、CAS、proof、所有transport行为 |
| D | 29项：2个synthetic processor + 1个retry + 22个TUI + 4个routes | 产品E2E、durable-before-execute、runtime authorization |
| S | 当前 source-equivalent tree 与 pinned dependency 的静态 seams | 运行次数、时序、请求数或 future contract 已实现 |
| F | `[F — planned; not created; not run]` | 不得写成已创建、已运行、已通过或生产保证 |

当前直接运行边界严格为`A=10 B=1 C=10(7+3) D=29(2+1+22+4)=50`，即 **50 项、50 pass、0 fail、0 skip**，只包括A/B/C/D。S不计入50；F没有当前运行结果。历史 commit 或设计 HEAD 不得替代 source-equivalent `135f2021517a2d4ac6f3dfc8d5e175dd2c0da309` 的直接证据边界。

### 0.4 唯一 owner 导航

| 子计划 | 唯一 owner | 当前权威入口 |
|---|---|---|
| SESSREC-1 | M1 shared contracts、canonical semantics、versioned exports、24 reasons、public projection allowlist | [`sessrec-1-contract-canonicalization.md`](./subplans/sessrec-1-contract-canonicalization.md) §1.1、§3、§4、§5、§6 |
| SESSREC-2 | M4 dedicated raw authority、transactions、materializations、three heads、sealed authority、snapshot/rebuild/publication partition | [`sessrec-2-durable-authority.md`](./subplans/sessrec-2-durable-authority.md) §1.1、§3–§11 |
| SESSREC-3 | M2 transport gate、M3 execution/settlement、M5 classification、M6 coordinator/admission/re-entry | [`sessrec-3-legacy-runtime-recovery.md`](./subplans/sessrec-3-legacy-runtime-recovery.md) §4、§6–§11、§13–§18 |
| SESSREC-4 | M7 recovery lowering/closure、M8 public wrappers/projection hydration/CLI/TUI | [`sessrec-4-legacy-lowering-public-contract.md`](./subplans/sessrec-4-legacy-lowering-public-contract.md) §3–§12 |

## 1. 冻结范围、计数与 wire 约束

### 1.1 Normative scope

- Legacy CLI：`opencode run`、normal prompt、model-entering command、ordinary continuation、child/subtask。
- Public Legacy operations：`session.prompt`、`session.prompt_async`、`session.command`；`noReply`同队列且先resolve no-reply supersession后只commit user；shell serialized但recovery/model gate N/A。
- Legacy TUI：generated SDK、public sync/hydration、renderer 与 production submission 的分层兼容。
- Experimental native LLM：仅是 Legacy alternate transport；无同等 paused gate/proof 时 fallback、disable 或 opaque，opaque incomplete 固定 ManualStop。
- Native V2：只做 shared schema/EventV2/SQLite/LLM regression consumer。
- Public error discriminator 保持 `UnknownError`；不新增 recovery-specific public error kind。

### 1.2 Non-goals

- provider dispatch/network 边界 exactly-once；
- clustered ownership、lease、consensus、split-brain；
- global physical-request budget；
- 通用 timeout/watchdog/transport retry 重构；
- hosted/provider-executed tool 或不可证明 reasoning state 的自动 Continue；
- dynamic/custom/WebSocket/unknown transport 的首批 available 支持；
- Native V2 recovery product surface；
- shell provider recovery。

### 1.3 N、M 与三个 ordinal

1. `experimental.session_recovery.max_incomplete_recoveries` 默认 `N = 2`，只接受非负 JSON safe integer；`N = 0/1/2` 分别允许 0、仅 ordinal 1、ordinal 1–2 的 incomplete-triggered child。
2. `experimental.session_recovery.max_model_assistants`产生默认64的`configuredM`，只接受正JSON safe integer；配置规范化时optional `agent.steps`参与一次性导出`NormalizedRecoveryPolicy.digestInput.effectiveMaxModelAssistants`。Runtime admission只消费该transaction-verified committed字段，禁止读取runtime config/`agent.steps`、直接访问top-level convenience field或再次执行min。
3. Codec 拒绝 alias、camelCase、string coercion、float、`-0`、unsafe integer、`null`；canonical encode 省略 default leaf；explicit default 与 omitted default 的 policy digest 相同，但 provenance 分离。exact codec/mapping owner：SESSREC-1 §4.6/F13 及 policy codec functions。
4. `recoveryOrdinal` 只计 incomplete-triggered child；首个 child 是 1，admission 条件为 `candidateRecoveryOrdinal <= N`。
5. `assistantSequence`计initial、ordinary与recovery-child model assistants；三类admission统一要求`assistantSequence < effectiveM`。
6. `dispatchOrdinal` 是每个 assistant 的 semantic provider execution ordinal；ordinal 0 来自 admission，outer retry/后续 SDK step 各自分配新 ordinal、operationID、handle/slot、ledger 与 settlement。
7. `dispatchOrdinal` 不消耗 N/M；physical request 也不直接消耗 N/M。
8. shell 不分配 model `assistantSequence`、不消耗 N/M、不是 recovery source、不能进入 Continue closure；shell process side effect 保持一次。

### 1.4 Fixed capability/policy choices

- Available adapters 首批仅含 built-in AI SDK Anthropic Messages、OpenAI Responses、native HTTP JSON，且必须证明 final transform 后、transport delegate 前的 exact paused gate。
- Canonical incomplete 不走 generic retry；保留 existing outer 429/503 policy，但每次重新进入 provider execution 前必须先提交新 semantic dispatch ordinal。Recovery-gated native HTTP hidden resend 为 0。
- Continue allowlist：
  - Anthropic：仅 audited local/client function call/result；server/hosted/provider-executed tool unavailable。
  - OpenAI `store=true`：仅 settled local function call/output 与 exact identity/target proof 的 stored reasoning reference；hosted items unavailable。
  - OpenAI `store=false`：仅不依赖 reasoning state 的 local function closure；encrypted reasoning、item reference、hosted item unavailable。
- Provider disconnect 若 send state indeterminate，不能透明 resend、不能换 handle/operationID、不能把 source 当成功返回。

## 2. Exact type/export owner 索引

本节只冻结 exact owner/export name 与 owner anchor；字段与 invariant 只读 owner 文档。任何 consumer-side unversioned alias、local structural duplicate 或近义 enum 都不是合同。

### 2.1 M1 shared contracts

| 合同族 | Exact owner/export names | Owner anchor |
|---|---|---|
| Error carrier | `M1.ContractResult<A, E extends M1.RecoveryContractError = M1.RecoveryContractError>`、`M1.RecoveryContractError`及owner-exported exact error subunions | SESSREC-1 §3.1/§5.0.1 |
| Candidate/committed identity exports | `M1.CandidateAssistantAttemptIdentity`、`M1.CommittedAssistantAttemptIdentity`、`M1.CandidateDispatchAttemptContext`、`M1.CommittedDispatchAttemptContext`、`M1.DerivedCommittedIdentityV1` | SESSREC-1 §4.2；owner-private union/helper shapes不列为consumer export |
| Dispatch admission export | `M1.DispatchAdmissionV1` | SESSREC-1 §4.3/§5.0.1；closed available/opaque union可直接命名，variants保持private，consumer只用`Extract<M1.DispatchAdmissionV1,{kind:"available"}>`或`Extract<M1.DispatchAdmissionV1,{kind:"opaque"}>` |
| Terminal/head/action/policy-binding exports | `M1.TypedIncompleteTerminalFact`、`M1.AssistantChainHeadV1`、`M1.AggregateEventHeadV1`、`M1.AutomaticRecoveryAction`、`M1.RecoveryAdmissionPolicyBindingV1` | SESSREC-1 §4.2/§4.6/§5.0.1；consumer不得复制近义terminal/head/action/policy-binding alias；其它private heads只经indexed surfaces取得 |
| Target/storage/seal | `M1.DispatchTarget`、`M1.ProviderSafetyDomain`、`M1.StorageMode`、`M1.SealedRecoveryMaterialRef`、`M1.PausedHandleDescriptorV1`、`M1.SealedRecoveryUseLeaseKeyInputV1` | SESSREC-1 §4.3–§4.4 |
| Replay/evidence exports | `M1.CanonicalWireValueV1`、`M1.RecoveryReplayPayloadV1`、`M1.RecoveryReplayPayloadCommitmentProjectionV1`、`M1.ToolTerminalReplayPayloadV1`、`M1.AuthoritativeToolEvidenceV1`、`M1.CompatibilityToolEvidenceV1`、`M1.CanonicalToolEvidencePartitionV1`、`M1.ToolExecutionPhaseV1` | SESSREC-1 §4.4.5–§4.5.6；inline secret-safe，sealed leaf只经M4 lease authority；four-way partition与five phases由owner exact exports定义 |
| Canonical dispatch/binding inputs | `M1.PreparedDigestInputV1`、`M1.PreparedDigestBuildSourceV1`、`M1.AutomaticBindingDigestInputV1`、`M1.ManualStopBindingDigestInputV1`、`M1.BindingDigestInputV1`、`M1.SupersessionBindingDigestInputV1` | SESSREC-1 §4.1.3/§4.9；PreparedDigest有exact `initial`/`ordinary`/`automatic-recovery`三branch；ManualStop binding不含target/semantic/prepared/authorization/closure digest；supersession为model/no-reply branch-exact |
| Explicit M4 proof inputs | `M1.M4RecoveryAggregateOwnerMappingProofV1`、`M1.M4SealedRecoveryMaterialLookupProofV1`、`M1.RecoveryDurableRowDecodeInputV1` | SESSREC-1 §4.4.2/§4.9；M1定义exact nominal proof surface，M4仅在owner-index/sealed-store lookup成功后构造brand；M1 pure compare，consumer不得复制/persist/refresh proof |
| Source/plan exports | `M1.DurableRecoverySnapshot`、`M1.RecoveryAssistantPublicMappingV1`、`M1.RecoveryClosureDescriptor`、`M1.LegacyUserMessagePredecessorV1`、`M1.PlannedRecoveryMaterializationDescriptor`、`M1.PlannedRecoveryMaterialization<Handle>`、`M1.NormalizedRecoveryPolicy`、`M1.AdmissionPlan`、`M1.RecoveryProposal` | SESSREC-1 §4.5–§4.7；closure descriptor与Legacy predecessor是explicit exports，不得称private；mapping为same-WAL M4-produced field；runtime planned available exact为`{descriptor,pausedHandle}`，unavailable exact仅`{descriptor}` |
| Event definition/registry/manifest exports | schema-owned `M1.RecoveryEventDefinitionSetV1`、LLM-owned enriched `M1.RecoveryEventRegistryV1`、`M1.EventManifestSet` | SESSREC-1 §4.5.1/§4.9/F3/F31；raw set精确含10 definitions/field specs/source-control tuples且无digest，enriched registry只由`buildRecoveryEventRegistry`附加两个existing allowed-set digests；internal definition与trusted-private replay helper brands remain owner-private fields，consumer不得复制structural aliases |
| Public event surfaces | `M1.PublicEventDefinitionV1<D>`、`M1.PublicDurableEventDefinitionV1<D>`、`M1.PublicCommittedEventV1<D>`、`M1.PublicEventCursorV1`、`M1.PublicEventReadErrorV1`、`M1.PublicEventListenerV1`、`M1.PublicEventSubscriptionV1<D>`、`M1.PublicEventManifestV1`、`M1.PublicDurableEventManifestV1`、`M1.PublicEventServiceV1` | SESSREC-1 §4.5.1a/F2/F31；public brands只接受`publication:"public"` |
| Receipt/result exports | `M1.AutomaticRecoveryAdmissionReceiptV1`、`M1.AuthorityReceiptV1`、`M1.DispatchReceiptV1`、`M1.RecoveryAdmissionReceiptV1`、`M1.ReceiptForV1<T>` | SESSREC-1 §4.7.3；其它closed receipt variants remain owner-private members of exported unions；consumer必须通过type-indexed union/extract而非local alias引用 |
| Supersession/reservation/result exports | `M1.SupersessionBindingDigest`、`M1.SupersessionBindingDigestInputV1`、`M1.NewLineageReservationRefV1`、`M1.RecoveryOperationLookupKeyV1<T>`、`M1.OperationPostStateForV1<T>`、`M1.OperationCommitResultV1<T>` | SESSREC-1 §4.1.2/§4.7.3/§4.8.1–§4.8.3；type-10持久化branch-exact supersession input+digest，type-1 reservation ref只引用model digest；lookup identity至少session+aggregate+operation+expected type；apply-mode helper type为owner-private |
| Operation/decision rebuild exports | `M1.OperationSchemaByTypeV1`、`M1.RecoveryOperationInputV1<T>`、`M1.RecoveryOperationEnvelope<T>`、`M1.RecoveryDecisionRecord`、`M1.LegacyUserMessagePredecessorV1` | SESSREC-1 §4.7.2/§4.8；`OperationSchemaByTypeV1`与Legacy predecessor是owner exports；仅未exported canonical decision-material internals保持private |
| Public projection | `M1.RecoveryChildDisplayID`、`M1.RecoveryPublicProjectionV1`、`M1.RecoveryPublicProjectionDecodeResult`、`M1.RecoveryPublicAuthorityViewV1`、`M1.PublicProjectionViolation` | SESSREC-1 §3.1、§4.7.4、F28–F30 |

`applyMode` exact literals仅为`"first-application" | "exact-replay"`，只存在于ephemeral `M1.OperationCommitResultV1<T>`，不得写进immutable `M1.AuthorityReceiptV1` variants。Private receipt variants与owner-private `OperationApplyModeV1`均不得由consumer命名；receipt必须经`M1.ReceiptForV1<T>`/`M1.AuthorityReceiptV1`/`Extract<...>`取得，apply mode必须经`M1.OperationCommitResultV1<T>["applyMode"]`或exact literals取得。

M1 numbered callable index保持F1–F31/F16a不变：F1 `define`、F2 `partitionDefinitionsByPublication`、F3 schema-owned `buildRecoveryEventDefinitions`、F4 `validateExactFieldSet`、F5 `decodeRecoveryDurableRow`、F6 `decodeRecoverySourceFieldSet`、F7 `decodeRecoveryControlTail`、F8 `decodeLegacyRecoveryEvidence`、F9 `normalizeStorageMode`、F10 `normalizeDispatchTarget`、F11 `normalizeProviderSafetyDomain`、F12 `targetWithinSafetyDomain`、F13 `normalizeRecoveryPolicy`、F14 `normalizeToolEvidence`、F15 `normalizeReasoningEvidence`、F16 `validateSealedRecoveryMaterialRef`、F16a `validateProviderCapabilitySummary`、F17 `canonicalEncode`、F18 `buildSemanticDigestInput`、F19 `buildPreparedDigestInput`、F20 `buildBindingDigestInput`、F21 `digestCanonicalCommitment`、F22 `verifyDigest`、F23 `mapCausesToManualStopReasons`、F24 `validateRecoveryProposal`、F25 `validateRecoveryDecisionRecord`、F26 `validateDispatchReceipt`、F27 `validateRecoveryAdmissionReceipt`、F28 `projectRecoveryForPublic`、F29 `assertPublicRecoveryProjectionSafe`、F30 `decodeRecoveryPublicProjection`、F31 `assembleEventManifests`。

M1 additional exact callable exports include LLM-owned `buildRecoveryEventRegistry(definitionSet: M1.RecoveryEventDefinitionSetV1)`；它是raw definition set的唯一enrichment owner，不是F3a、不新增digest domain且不允许generic domain input。其余additional exports are policy codecs `decodeRecoveryPolicyConfig`、`encodeRecoveryPolicyConfig`、`decodeRecoveryPolicyInputV1`、`encodeRecoveryPolicyInputV1`；helpers `deriveCommittedIdentity`、`foldOperationPostStateThroughSequence`、`validateCurrentRecoveryAggregatePrefixAndHeads`；and the closed 25-domain input builders `buildSemanticDigestInput`、`buildPreparedDigestInput`、`buildBindingDigestInput`、`buildOperationPayloadDigestInput`、`buildSupersessionBindingDigestInput`、`buildEventChainDigestInput`、`buildSourceFactsDigestInput`、`buildRecoverySourceVersionDigestInput`、`buildRecoveryControlTailDigestInput`、`buildRecoveryPolicyDigestInput`、`buildDispatchTargetDigestInput`、`buildSealedMaterialCommitmentInput`、`buildPausedHandleCommitmentInput`、`buildRecoveryClosureDigestInput`、`buildCredentialAuthorityVersionDigestInput`、`buildProviderAuthorizationProofDigestInput`、`buildControlPolicyDigestInput`、`buildToolPlanDigestInput`、`buildToolCallDigestInput`、`buildToolResultDigestInput`、`buildReasoningTextDigestInput`、`buildProviderPrefixDigestInput`、`buildProviderPrefixAncestryDigestInput`、`buildSourceAllowedEventSetDigestInput`、`buildControlAllowedEventSetDigestInput`。F18–F20 are the same exports as the corresponding builder inventory entries, not duplicate APIs. Exact signatures/errors remain owned by SESSREC-1 §5.0.1.关键exact signatures为：

- M1 F23 `mapCausesToManualStopReasons(causes: readonly M1.RecoveryFailureCause[]) -> M1.ContractResult<M1.NonEmptyReadonlyArray<M1.ManualStopReason>, never>`；compile-time对closed cause union保持`never` exhaustiveness，runtime empty/malformed/future discriminator仍total返回唯一`["internal-classification-failure"]`，不得throw或返回空tuple。
- M1 F26 `validateDispatchReceipt<T extends M1.DispatchReceiptOperationTypeV1>(receipt: M1.ReceiptForV1<T>, operationPostState: M1.OperationPostStateForV1<T>, pausedHandleCommitment: M1.PausedHandleCommitment) -> M1.ContractResult<M1.ReceiptForV1<T>, M1.ReceiptValidationError>`；只供initial/ordinary/subsequent。
- M1 F27 `validateRecoveryAdmissionReceipt(receipt: M1.AutomaticRecoveryAdmissionReceiptV1, proposal: Extract<M1.RecoveryProposal,{kind:"automatic"}>, planned: Extract<M1.PlannedRecoveryMaterialization<unknown>,{descriptor:{status:"available"}}>, operationPostState: M1.FoldedAutomaticRecoveryPostStateV1) -> M1.ContractResult<M1.AutomaticRecoveryAdmissionReceiptV1, M1.ReceiptValidationError>`；exclusively供automatic type-9。planned runtime wrapper必须是original exact `{descriptor,pausedHandle}`；F27只读取并验证`planned.descriptor`及其paused-handle descriptor commitment，不枚举、encode或触碰raw handle。M2 authorization package另持complete type-9 result与same live handle，并在F27后比较result/descriptor commitment与wrapper中的同一handle。
- M1 F28 `projectRecoveryForPublic(authorityView: M1.RecoveryPublicAuthorityViewV1) -> M1.ContractResult<M1.RecoveryPublicProjectionV1 | undefined, M1.PublicProjectionViolation>`；pure且不写表、不分配display ID。
- M1 F30 `decodeRecoveryPublicProjection(value: unknown) -> M1.ContractResult<M1.RecoveryPublicProjectionDecodeResult, never>`；M8 public decode/hydration只沿该path消费projection。

### 2.2 M4 persistence/authority primitives

| Primitive family | Exact M4 function names | Owner anchor |
|---|---|---|
| Aggregate owner/core | `M4.SessionRecoveryAggregateOwnerPreparedV1`、`M4.SessionRecoveryAggregateOwnerViewV1`、`M4.RecoveryRawRowV1<T>`、`M4.AutomaticRecoveryToolEvidenceProofV1`、`M4.AutomaticRecoveryReasoningEvidenceProofV1`、`M4.AutomaticRecoveryProviderPrefixProofV1`、`M4.RecoveryFoldedStateV1`、`M4.PendingSealV1`；`M4.createSessionRecoveryAggregateOwner`、`M4.canonicalizeRecoveryOperation`、`M4.foldRecoveryPrefix`、`M4.applyRecoveryOperation`、`M4.validateExactReplayAndReturnReceipt`、`M4.lookupRecoveryOperationResult` | SESSREC-2 §3.1/§5.1–§5.5；A5 input固定`sessionID,aggregateID,operationID,expectedInput,expectedPayloadDigest,expectedReceiptKind`，operationID-only禁止 |
| Nominal recovery view/proof | `M4.RecoverySnapshotIdentityV1`、`M4.SnapshotBoundToolEligibilityV1`、`M4.AutomaticRecoveryProofSliceV1`、`M4.DurableRecoveryAuthorityViewV1` | SESSREC-2 §3.1/§4.2.3/§7；complete view由M4 branding，automatic slice必须来自same view；manual-only不能cast为automatic |
| Exact error exports | `M4.RecoveryErrorContextV1`、`M4.RecoveryErrorKindV1`、`M4.RecoveryErrorReasonByKindV1`、`M4.RecoveryErrorReasonV1`、`M4.RecoveryErrorV1<K>`、`M4.SessionRecoveryOwnerCreationErrorV1`、`M4.RecoveryAuthorityErrorV1`、`M4.RecoverySnapshotReadErrorV1`、`M4.RecoverySealErrorV1`、`M4.RecoveryRebuildErrorV1`、`M4.RecoveryPendingSealPersistErrorV1`、`M4.RecoveryMigrationErrorV1` | SESSREC-2 §3 error types；consumer不得使用bare/unversioned names |
| Operation wrappers | `M4.commitCompositeAdmissionDispatch`、`M4.commitSubsequentDispatch`、`M4.commitToolEvidence`、`M4.reconcileInterruptedToolExecution`、`M4.commitReasoningEvidence`、`M4.commitProviderPrefix`、`M4.commitIncompleteTerminal`、`M4.commitManualStop`、`M4.commitAutomaticChild`、`M4.commitNewInputSupersession`、`M4.commitAndValidateSupersessionBeforePrepare` | SESSREC-2 §6；O3a只append `reconciled-terminal-manual-only`，body/after-hook/provider调用为0 |
| Supersession/winner gate exports | `M4.SupersessionRequiredAuthorityV1`、`M4.NewInputSupersessionCommitResultV1`、`M4.SupersessionBeforePrepareResultV1`、`M4.SupersessionBeforePrepareProofV1`、`M4.CurrentRecoveryWinnerV1` | SESSREC-2 §3.1/§6.9–§6.10；O10先`inspect-current-authority`，unresolved只返回branded authority；caller构造complete type-10 input/digest后以`complete-expected-input`重入；仅model validated/no-source branch产生proof，no-reply无proof |
| Admission/generic committed view/read/rebuild | `M4.InitialAdmissionAuthorityViewV1<P>`、`M4.OrdinaryAdmissionAuthorityViewV1<P>`、`M4.CommittedAssistantAdmissionOperationV1`、`M4.CommittedAssistantOriginForV1<K>`、`M4.CommittedAssistantIdentityForV1<K>`、`M4.CommittedAssistantContextForV1<K>`、`M4.CommittedAssistantAuthorityViewV1<K>`；`M4.loadInitialAdmissionAuthorityView`、`M4.bindPreparedInitialAdmissionAuthorityView`、`M4.loadOrdinaryAdmissionAuthorityView`、`M4.bindPreparedOrdinaryAdmissionAuthorityView`、`M4.loadCommittedAssistantAuthorityView`、`M4.buildRecoveryAssistantPublicMappingInTransaction`、`M4.loadRecoverySnapshot`、`M4.loadRecoverySnapshotInTransaction`、`M4.lookupCurrentRecoveryWinner`、`M4.rebuildRecoveryAggregate` | SESSREC-2 §3.1/§7；terminal recovery read returns complete nominal `DurableRecoveryAuthorityViewV1` with same-view automatic slice；plain snapshot/public/history不能替代；initial/ordinary/generic re-entry paths保持分离 |
| Rebuild/deletion closed exports | `M4.SevenMaterializationName`、`M4.ThreeHeadName`、`M4.RecoveryOwnedTableName`、`M4.RebuildReceiptV1`、`M4.RecoveryCascadeDeletionProofV1`；`M4.deleteRecoveryOwnedStateForSession` | SESSREC-2 §4.5/§7/§9.7；delete helper只在existing higher-level immediate session-deletion transaction内执行fixed before/after counts、exactly-one session delete、all-owned-zero与`foreignKeyViolations:0` proof；失败回滚whole deletion |
| Publication/private read | `M4.RecoveryAuthorityPrivateEventReaderV1`；`M4.notifyCommittedPublic`、`M4.readRecoveryAggregatePrivate`、`M4.readSealedAggregatePrivate`、`M4.forwardPublic`、`M4.readPublicSyncHistory` | SESSREC-2 §8；public notifier/bridge只接收M1 nominal `PublicCommittedEventV1`/public manifests，structural `publication:"public"`或cast不能构造capability；internal writers不调用notifier；private reads只承接trusted private replay set |
| Sealed authority/digests | `M4.SealedAggregateID`、`M4.AuthorityRowDigest`、`M4.SealedRequestDigest`、`M4.SealedEventChainDigest`、`M4.SealedBlobCommitment`、`M4.RotationReceiptV1`、`M4.RedactionReceiptV1`、`M4.SealedMaintenanceTypeV1`、`M4.SealedAggregateEventHeadV1`、`M4.SealedRequestByTypeV1`、`M4.SealedMaintenanceEnvelopeV1<T>`、`M4.SealedMaintenanceReceiptForV1<T>`、`M4.SealedMaintenanceRawRowV1`、`M4.SealedAuthorityPrefixV1`、`M4.SealedAuthoritativeRowV1`、`M4.SealedFoldedStateV1`；`M4.prepareSealForOperation`、`M4.persistPendingSeals`、`M4.withUnsealedMaterial`、`M4.foldSealedAuthorityPrefix`、`M4.validateSealedExactReplayAndReturnReceipt`、`M4.rotateSealedMaterial`、`M4.redactSealedMaterial` | SESSREC-2 §3.2/§4.2.4/§9；A4/S1/R1验证dual prefixes、fold与physical rows |
| Sealed-use leases K7–K10 | `M4.SealedRecoveryUseLeaseV1`、`M4.SealedRecoveryUseReleaseValidationV1`；`M4.acquireSealedRecoveryUseLease`、`M4.validateSealedRecoveryUseLeasesForAutomaticCommit`、`M4.validateSealedRecoveryUseLeasesImmediatelyBeforeRelease`、`M4.closeSealedRecoveryUseLeases`、`M4.cleanupDeadProcessSealedRecoveryUseLeases` | SESSREC-2 §9；K7 before unseal/lower/prepare；K8 at type-9 first apply and immediately pre-release；K9 all terminal paths；K10 exclusive fence；K4/K5 reject live conflict；no TTL/renew/reopen/time inference |
| Opaque transaction/capability exports | `M4.ExclusiveStartupRebuildCapability`、`M4.RecoveryReadTransaction`、`M4.RecoveryImmediateTransaction`、`M4.RecoveryReadOrWriteTransaction` | SESSREC-2 §3.1；capability无consumer-local structural shape，closed transaction或expired startup capability必须typed reject |
| Migration | `M4.RecoveryAuthoritySchemaVersion`、`M4.RecoveryAuthorityMigrationID`、`M4.RecoveryMigrationReceiptV1`、`M4.migrateRecoveryAuthorityV1` | SESSREC-2 §10 |

M4 是唯一 raw authority writer/folder/rebuilder/materialization owner，并在transaction/rebuild中拥有stable display-ID allocation/reuse。M1独占pure F28 public projection function；F28只消费M4已验证的authority view/display mapping，不写表、不分配ID。M4及其它consumer只能直接使用§2.1列出的M1 exact exported或indexed surfaces；不得命名M1 private dispatch/receipt/head/apply-mode helpers。Receipt一律经`M1.ReceiptForV1<T>`/`M1.AuthorityReceiptV1`/`Extract<...>`取得，apply mode经`M1.OperationCommitResultV1<T>["applyMode"]`或exact literals取得；unversioned alias、local structural duplicate或非M1 literal均无owner地位。

Generic committed-assistant authority exact callable为`M4.loadCommittedAssistantAuthorityView<K extends M4.CommittedAssistantAdmissionOperationV1>({aggregateID:M1.RecoveryAggregateID,sessionID:string,assistantID:M1.RecoveryAssistantID,admissionOperationType:K}) -> Effect<M4.CommittedAssistantAuthorityViewV1<K>,M4.RecoveryAuthorityErrorV1>`。它按type-1/2/9 admission raw定位generic committed assistant/current dispatch authority，并只返回`nonterminal:true` view；terminal/closed assistant必须拒绝，normal terminal由其own complete-result path处理，exact incomplete terminal commit后才可由separate M4 `loadRecoverySnapshot`加载。M6不得定义consumer-local view、从`M1.DurableRecoverySnapshot`裁剪、或从public projection/history反构造。

O10 exact two-stage contract为：`M6.SessionRunState.submitSerialized`构造的pre-inspection candidate只有model `{sessionID,submissionPayloadDigest,intendedInitialOperationID}`或no-reply `{sessionID,submissionPayloadDigest,replyDisposition:"commit-user-only"}`，不含source/control/predecessor binding。第一次`M4.commitAndValidateSupersessionBeforePrepare({candidate,supersession:{kind:"inspect-current-authority",expectedAggregateEventHead}})`只读取dedicated owner/current prefix；若存在unresolved source，只返回`{kind:"supersession-required",authority:M4.SupersessionRequiredAuthorityV1}`。Caller必须且只能在取得该branded authority后，从authority与同一candidate构造完整branch-exact `M1.SupersessionBindingDigestInputV1`、`M1.SupersessionBindingDigest`、type-10 expected input与payload digest，再以`{kind:"complete-expected-input",expectedInput,expectedPayloadDigest}`重入同一callable。Inspection不得预造source/control/predecessor-dependent input或digest，caller不得直接调用O9或把authority当input/proof；只有validated model branch返回`M4.SupersessionBeforePrepareProofV1`，no-reply永不创建proof。

M4 first-application transaction只消费committed `M1.NormalizedRecoveryPolicy.digestInput.effectiveMaxModelAssistants`并检查candidate `assistantSequence < effectiveM`；它不得读取runtime config后重新执行`min(configuredM,agent.steps)`。Exact replay只验证stored historical policy与folded post-state。M4的persisted derived-row/head digest registry及authority/sealed digest registry均为owner-private frozen canonical registries：每列/domain只有一个exact input builder，A3/A4/A5/S1/K0/R1/MIG1按覆盖范围重算digest并逐字段比较；global consumer index只列M4 exported brands，不创建local builder/brand alias。

### 2.3 M2/M3/M5/M6 runtime owners

| Module | Exact names indexed here | Owner anchor |
|---|---|---|
| M2 | `M2.PreparedHandleCommitmentReservationV1`、`M2.PreparedHandleReservationValidationErrorV1`、`M2.reserveRecoveryPreparedHandleCommitment`；`M2.prepareDispatch({candidate,context,operationID,snapshotProof,closure,sealedUseLeases,reservation,lowered,runtimeInput}) -> M1.PlannedRecoveryMaterialization<M2.AvailableDispatchHandle>`；`M2.validatePreparedHandleCommitmentReservation`、`M2.closePreparedHandleCommitmentReservation`；以及`M2.LegacyRuntimeInput`、`M2.PreparedCommitPackageV1`、`M2.AvailableDispatchHandle`、`M2.M2InspectionResult`、proof/authorization/release/cancel exports | SESSREC-3 §4、§6；reservation稳定且no-send，K7在actual prepare前；prepare exactly once消费same reservation；M4只调用M2 validators，不复制fields |
| M3 tool/settlement | `allocateDispatchOrdinalSettlement`、`LegacyToolExecutionGate.wrapTool`、`executePreplannedSubtaskThroughGate`、`executeToolInvocation`、`beginToolInvocation`、`materializeFinalToolPlan`、`commitFinalToolPlan`、`executeFinalToolPlan`、`commitBodyOutcome`、`settleToolInvocation`、`reconcileToolStreamEvent`、`drainAttempt`、`classifyTerminalObservation`、`appendTerminalAndReload`、`processReleasedDispatch`、`settlePreDispatchAbandonment`、`decideExistingEvidenceDrain` | SESSREC-3 §7；settlement allocation只在complete F26/F27 authorization后由caller对exact destination显式调用：ordinal-0一次、每个type-3 subsequent一次；prepare/record/authorize helpers不分配或推进settlement |
| M5 | `selectRecoveryCandidate`、`collectRecoveryFailureCauses`、`classifyRecovery`；selection的dispatch cardinality/authority closed branches必须分开为missing ledger、exact selected opaque、gap-or-conflict、multiple plausible；只有exact one plausible available才进入tool/action selection；24-reason mapping只调用M1 F23 | SESSREC-3 §8 |
| M6 policy | `M6.RecoveryPolicyScopeKey`、`M6.RecoveryPolicyAuthoritySnapshot`、`M6.RecoveryPolicyAuthorityExpectation`、`M6.RecoveryPolicyAuthorityError` | SESSREC-3 §4.9、§9.1–§9.2 |
| M6 coordinator data | `M6.SerializedSubmissionOperationID`、`M6.SerializedSubmission`、`M6.UnpreparedNonAuthoritativeNewInputCandidate`、`M6.CoordinatorResult`、`M6.FatalRecoveryStop` | SESSREC-3 §3.1.1、§4.10–§4.11、§9.9–§9.15；initial/ordinary authority直接消费M4 staged views，generic committed re-entry直接消费`M4.CommittedAssistantAuthorityViewV1<K>`；M6不export source-snapshot proof、generic authority view或local structural duplicate；其余均为internal runtime exports，M8 consumer/sanitizer见SESSREC-4 §3.3/§7.1 |

M2 callable index：`M2.reserveRecoveryPreparedHandleCommitment`、`M2.validatePreparedHandleCommitmentReservation`、`M2.closePreparedHandleCommitmentReservation`、`M2.proveNoPreparedHandleV1`、`M2.validateNoPreparedHandleProofV1`、`M2.validatePreparedUnreleasedHandleProofV1`、`M2.validateMechanicallyCancelledUnreleasedHandleProofV1`、`M2.resolveSDKWithProvenance`、`M2.getLanguageRuntime`、`M2.resolveDispatchAdapter`、`M2.prepareInitialOrOrdinaryDispatch`、`M2.prepareDispatch`、`M2.prepareSubsequentDispatch`、`M2.prepareOpaqueDeferred`、`M2.prepareAISDKAvailable`、`M2.installAISDKGateSlot`、`M2.startAISDKInvocationFiber`、`M2.inspectAndPauseFinalFetch`、`M2.prepareNativeAvailable`、`M2.inspectNativePreparedRequest`、`M2.LLMClient.compilePausedInternal`、`M2.authorizeDispatch`、`M2.releaseDispatch`、`M2.mechanicallyCancelDispatch`、`M2.cleanupDispatch`、`M2.closeDispatchInvocationRuntime`、`M2.recordAndAuthorizeSubsequentDispatch`、`M2.executeNativeGatedOnce`，见SESSREC-3 §4.1/§6.1–§6.13。Subsequent path exact owner sequence为M2-owner-private `SubsequentDispatchPreparationInput` → `M2.prepareSubsequentDispatch(...) -> LinearDispatchHandle` → `M2.recordAndAuthorizeSubsequentDispatch(...) -> AuthorizedDispatch`；后者只调用`M4.commitSubsequentDispatch`与M1 F26，不分配settlement、不release。Caller随后且仅随后调用M3 `allocateDispatchOrdinalSettlement({authorized,destination})`一次，再由M2 `releaseDispatch`释放；prepare、record+authorize、settlement allocation与release是四个separate callables。跨模块shared spelling直接采用M1/M2/M4 exact exports，不允许consumer-local proof/lease/inspection/authority结构复制。

M6 callable index：`M6.decodeSessionRecoveryConfig`、`M6.publishRecoveryPolicyAuthority`、`M6.readRecoveryPolicyAuthority`、`M6.readRecoveryPolicyAuthorityInTransaction`、`M6.freezeAdmissionPolicy`、`M6.preallocateAssistantCandidate`、`M6.buildAdmissionPlan`、`M6.admitInitialOrOrdinary`、`M6.runAdmittedAssistant`、`M6.newAttemptLocalState`、`M6.recoverIncomplete`、`M6.commitAutomaticRecovery`、`M6.finalizeManualStop`、`M6.resolveCommitResponseLoss`、`M6.reenterCommittedAssistant`、`M6.settleCommittedAssistantWithoutHandle`、`M6.supersedeBeforeNewUserInput`、`M6.runModelChain`、`M6.SessionRunState.submitSerialized`。Generic nonterminal exact signatures为`M6.reenterCommittedAssistant<K extends M4.CommittedAssistantAdmissionOperationV1>({aggregateID,sessionID,assistantID,admissionOperationType,runtimeRegistry}) -> ReentryDecision`与`M6.settleCommittedAssistantWithoutHandle<K extends M4.CommittedAssistantAdmissionOperationV1>({authority:M4.CommittedAssistantAuthorityViewV1<K>,sendState,runtimeEvidence?}) -> AssistantProcessOutcome`；二者type-level禁止`M1.DurableRecoverySnapshot`。唯一coordinator entry spelling是`M6.SessionRunState.submitSerialized`，不是旧coordinator alias。

M2 canonical handle state只允许`prepared -> authorized/open -> authorized/held/not-delegated -> released/delegated|released/unknown-delivery`、`prepared -> cancelled`，以及known predelegation failure先`authorized/held/not-delegated -> authorized/open`再`-> cancelled`。Authorization不标released；exclusive latch持有期间仍是authorized。只有exact delegate boundary可写released。`released/unknown-delivery`是terminal fatal ambiguity，禁止cancel、same/new handle resend或source-success fallback。

### 2.4 M7 exact shared output

M7 shared data export是`M7.LoweredRecoveryCandidate`；它绑定`M1.RecoveryClosureDescriptor`、same-view `M4.AutomaticRecoveryProofSliceV1`、prepared-handle commitment与`M4.SealedRecoveryUseLeaseV1[]`，不含target/protocol/storage。Descriptor construction先于reservation/K7且不产生plaintext；Continue messages只能在K7后的K3 callback内重建并立即交给M2 actual preparation，plaintext-bearing candidate不得逃逸。

M7 callable index：`lowerSafeRetryHistory`、`buildProviderNeutralRecoveryClosure`、`reconstructProviderNeutralContinueMessages`、`buildAnthropicClosureConstraint`、`buildOpenAIStoredClosureConstraint`、`buildOpenAIStatelessClosureConstraint`、`buildProviderClosureConstraint`、`validatePreparedRecoveryInspection`、`lowerLegacyRecoveryRequest`，见SESSREC-4 §4–§5。Legacy history/cache/public projection/current provider state均不能供应replay authority。

### 2.5 M8 public wrappers/adapters

M8 adapter types：`M8.LegacyHydrationError`、`M8.LegacyConnectionGeneration`、`M8.LegacyTransientTransportState`、`M8.LegacyRunCompletionState`、`M8.LegacyRunEventReduction`、`M8.LegacyInteractiveOperationToken`、`M8.LegacyInteractiveWait`，见 SESSREC-4 §3.3。`LegacyRunEventReduction` exact为`{state,wakeHydrator}`；event/transport reducer不得把presentation或transient disconnect直接写成terminal hydration failure。

M8 callable index：`legacyIncompleteUnknownErrorMessage`、`sanitizeFatalRecoveryStop`、`toLegacyCoordinatorResponse`、`decodeLegacyRecoveryProjection`、`adaptDecodedLegacyRecoveryProjection`、`serveLegacySyncOperation`、`promptAsync`、`submitLegacyNoReply`、`submitLegacyShell`、`reconcileLegacyDisconnect`、`publishLegacyPublicState`、`reduceLegacyRunEvent`、`reduceLegacyRunTransport`、`hydrateLegacyRunCompletion`、`resolveRunExitCode`、local `complete`、`hydrateLegacyTuiReconnect`、`applyLegacyTuiPublicEvent`、`deriveLegacyRecoveryView`、existing `toModelMessagesEffect`，见 SESSREC-4 §3.2、§7。`reduceLegacyRunEvent<D>`与`applyLegacyTuiPublicEvent<D>`逐字接收当前`M1.PublicEventSubscriptionV1<D>`产出的`M1.PublicCommittedEventV1<D>`，不得扩大为broad event union或按prefix过滤。Normative return semantics固定为：sync prompt/command等待完整model/recovery chain；automatic success返回final child；committed ManualStop返回source；`prompt_async`只在scope-owned background operation被接受后返回204/empty body，chain继续background运行且failure只经exact sanitizer公开。

## 3. Final call graphs

### 3.1 Automatic recovery spine

```text
M3 drains, durably settles, and classifies the exact source ordinal
  -> M4.commitIncompleteTerminal
  -> 1. M4 loads complete nominal DurableRecoveryAuthorityViewV1
  -> M6 verifies re-entry/winner and freezes committed policy authority
  -> M6 preallocates candidate and AdmissionPlan
  -> 2. M5 selects at most one action candidate
  -> 3. obtain same-view M4.AutomaticRecoveryProofSliceV1
  -> 4. M7.buildProviderNeutralRecoveryClosure({authority,proof})
       returns M1.RecoveryClosureDescriptor without plaintext
  -> 5. derive stable type-9 operationID
  -> 6. M2.reserveRecoveryPreparedHandleCommitment(...)
       state reserved-no-send; provider preparation count 0; transport hits 0
  -> 7. M4.acquireSealedRecoveryUseLease (K7)
       before any unseal, automatic lowering, or actual provider preparation
  -> 8. M7 reconstructs replay carriers in K3 scope and lowers
       exact provider-prefix/tool/reasoning order; all owner digests recomputed
       plaintext-bearing messages/candidate cannot escape the callback
  -> 9. M2.prepareDispatch exactly once, consuming the same reservation
  -> 10. owner original available M2.M2InspectionResult
  -> 11. M7.validatePreparedRecoveryInspection on that same object
  -> 12. M5 final classification
  -> 13. M4 O8/type-9 first application validates leases via K8 and commits
  -> 14. complete M1.OperationCommitResultV1<"automatic-child-admitted-and-consumed">
  -> 15. immediate pre-release K8 validation
  -> 16. M1 F27 plus M2 exact result/proposal/descriptor/reservation/handle authorization
       canonical state becomes authorized/open, never released
  -> 17. M2 acquires the exclusive release latch, remains authorized/held/not-delegated,
       calls the delegate once, and only the exact boundary records released/delegated
       or terminal released/unknown-delivery
  -> 18. M4 K9 closes leases and runtime plaintext is zeroized
  -> 19. only delegated + K9 success creates the empty child attempt
  -> 20. M3 allocates child ordinal-0 settlement exactly once
  -> 21. consume stream/events
```

禁止plain snapshot substitution、receipt-before-prepare、pre-K7 unseal/lowering/preparation、double preparation、handle/reservation/lease substitution、post-commit replacement prepare或ordinal allocation before delegated+K9 success。Canonical release suffix必须逐字保持complete result → immediate pre-release K8 while the same handle is still `prepared` → F27 + M2 exact authorization to `authorized/open` → exclusive latch to `authorized/held/not-delegated` → delegate once and boundary-only `released/delegated|released/unknown-delivery` → K9 close/zeroize。Known-not-delegated failure先退latch到authorized/open再cancel；unknown-delivery terminal不得cancel/resend。若pre-release K8失败，必须`prepared -> cancelled`，F27、M2 authorization、release/delegate调用次数均为0，随后K9 close/zeroize→cleanup。Initial/ordinary/subsequent继续ordinary F26路径，不使用该automatic spine。

### 3.2 Initial、ordinary 与 subsequent dispatch

```text
M8 public wrapper
  -> M6 SessionRunState.submitSerialized
  -> O10 inspect-current-authority reads dedicated current authority directly
       empty aggregate uses C1/MIG1 genesis; no M1.DurableRecoverySnapshot
       no unresolved source -> model proof / no-reply user-only continuation
       unresolved source -> branded M4.SupersessionRequiredAuthorityV1 only
  -> caller builds complete branch-exact SupersessionBindingDigestInputV1
       + SupersessionBindingDigest + complete type-10 expected input/payload digest
       model input carries intended operationID; no-reply fixes replyDisposition commit-user-only
  -> O10 complete-expected-input re-entry commits/validates type-10
       only model branch returns M4.SupersessionBeforePrepareProofV1
  -> commit and validate existing Legacy user message
  -> M6 freezes current policy and preallocates initial candidate
  -> M2.proveNoPreparedHandleV1
  -> M4.loadInitialAdmissionAuthorityView
       committed owner mapping + exact current aggregate head (genesis if empty)
       current policy + committed Legacy user predecessor + candidate/context
       M4 supersession proof + M2.NoPreparedHandleProofV1
  -> M6.buildAdmissionPlan(origin:"initial", exact M4 view)
  -> existing Legacy ordinary semantic conversion (not M7)
  -> M2 one exact paused available/opaque preparation
  -> M4.bindPreparedInitialAdmissionAuthorityView
       same candidate + M2.PreparedUnreleasedHandleProofV1
  -> M4.commitCompositeAdmissionDispatch
       type 1: lineage genesis; aggregate exact current/type-10 post head
       Legacy assistant + M + ordinal-0 ledger + heads atomically
  -> M1 F26 validates result.receipt + result.operationPostState
  -> M2 same-handle authorize
  -> M3.allocateDispatchOrdinalSettlement exact ordinal-0 once
  -> M2.releaseDispatch

ordinary successor
  -> exact committed predecessor terminal/settled
  -> fresh current policy + candidate + M2.NoPreparedHandleProofV1
  -> M4.loadOrdinaryAdmissionAuthorityView (distinct input; no recovery snapshot)
  -> M6.buildAdmissionPlan(origin:"ordinary", exact M4 view)
  -> existing converter -> M2 prepare once -> bind prepared ordinary view
  -> type 2 commit with exact committed assistant predecessor
  -> complete-result authorization/release
```

Initial/ordinary ordinary history conversion 不由M7重新拥有；M7只拥有automatic SafeRetry/Continue lowering。`M1.DurableRecoverySnapshot`只由M4为已durable terminal incomplete source构造，并只进入automatic recovery/classification/re-entry；fresh/initial、ordinary与new-input no-source authority均不得构造或消费该snapshot。

```text
noReply serialized submission
  -> O10 no-reply supersession/no-source validation
       no future type-1 operationID/digest; no model proof
  -> commit user message only
  -> return user-only
  -> zero policy/M7/M2/type-1/assistant/ledger/M/authorization
```

```text
same admitted assistant requires another semantic provider execution
  -> M4.loadCommittedAssistantAuthorityView for the exact committed assistant/current dispatch
  -> close and freeze the previous ordinal
  -> allocate one fresh candidate dispatchOrdinal/context only
  -> M2.prepareSubsequentDispatch exactly once; no settlement mutation
  -> M2.recordAndAuthorizeSubsequentDispatch; no settlement allocation/release
       -> M4.commitSubsequentDispatch (type 3)
       -> dispatch_ledger_head exact successor CAS
       -> M1.OperationCommitResultV1<"subsequent-dispatch-recorded">
       -> M1 F26 only validates receipt + operationPostState + same-handle commitment
  -> M3.allocateDispatchOrdinalSettlement({authorized,destination}) exactly once
       for that exact committed ordinal and same attempt destination
  -> M2.releaseDispatch releases the authorized same handle
  -> M3 settles that exact ordinal
```

Ordinal 0 evidence不能满足 ordinal 1；late/cross-ordinal evidence 是 `dispatch/ledger-conflict`。Ledger/head commit失败不得 release，并须 durable settle pre-dispatch abandonment/error。

### 3.3 Source settlement and tool gate

```text
raw tool invocation durable commit
  -> side-effectful before hook exactly once
  -> materialize final plan
  -> append phase planned
  -> selected body called 0 or 1 times
  -> append phase body-outcome-durable
  -> after hook exactly once
  -> append phase final-after-hook-settled
  -> terminal classification

restart sees planned | body-outcome-durable | unknown-intermediate
  -> M4.reconcileInterruptedToolExecution (O3a)
  -> append reconciled-terminal-manual-only
  -> body calls 0; after-hook calls 0; provider hits 0
  -> terminal barrier may close; automatic remains permanently forbidden
```

所有最终可执行local tool family都经过`LegacyToolExecutionGate`。五个durable phase exact为`planned`、`body-outcome-durable`、`final-after-hook-settled`、`reconciled-terminal-manual-only`、`unknown-intermediate`；每个phase均`rerunBody:"forbidden"`、`rerunAfterHook:"forbidden"`。Continue只接受`final-after-hook-settled` authoritative evidence，绝不把tool放回execution queue。

### 3.4 SafeRetry and Continue

**SafeRetry**：M4返回complete nominal `DurableRecoveryAuthorityViewV1`；M5只接受same-view `safe-retry-eligible` slice，其partition必须exact `truly-empty`。M7通过`LegacyUserMessagePredecessorV1`/mapping验证same snapshot identity并严格截取source之前prefix；compatibility-only、mixed、manual-only或任一nonfinal phase均拒绝，不能把空automatic proof数组解释为zero-tool。

**ContinueAfterSettledTools**：M5只接受same-view `continue-eligible` slice，其partition必须exact `authoritative-only`且每个tool phase均`final-after-hook-settled`。M7 descriptor-first；K7后在K3 callback内按proof中的provider-prefix/tool/reasoning sequences合并exact total order。Inline replay leaves必须secret-safe、strict decode、canonical re-encode且byte-equal；sealed leaves只经same ref/generation live leases访问。M7重算tool plan/call/result、reasoning text、provider prefix、ancestry与closure commitments，再one-preparation/same-object validate，因此available success只在：

```text
same-view proof = exact replay order = recomputed commitments = planned/final
```

时成立。Legacy history、cache、public projection、current provider state/public data与digest inversion均禁止供应replay authority；tool执行次数为0。Partial prose、open/pending/running/interrupted/uncertain/manual-only tool、forced-flush reasoning、server/hosted/provider-executed tool、OpenAI stateless encrypted reasoning均fail closed。

### 3.5 ManualStop

```text
canonical M1 causes
  -> total M1 F23 mapCausesToManualStopReasons
       malformed/empty/future runtime input -> internal-classification-failure singleton
  -> construct branch-exact M1.ManualStopBindingDigestInputV1
       exact source/control/candidate/action + canonical causes/reasons
       + planningEvidence + closureStatus + policy/admission/heads/control policy
       + handleClosure; no target/semantic/prepared/authorization/closure digest fields
  -> M1 F24 validates nonempty ordered manual proposal and exact manual binding
  -> M2 mechanical cancel exact prepared/authorized-open handle
     OR atomic no-handle barrier + current M2.NoPreparedHandleProofV1
  -> M4 K9 close/zeroize exact leases
  -> M2 resource cleanup
       potential type-8 branch retains only a secret-free one-shot manual-stop tombstone
  -> after any required A5/S2/S1 absence/no-winner/fresh-source checks,
     M4 validates the exact M2 proof and commits type-8
  -> require exact complete M1.OperationCommitResultV1<"decision-finalized">
  -> immediately invalidate the tombstone
  -> M8 may return source as final effective assistant
```

所有automatic failure与ManualStop branch均固定`mechanical cancel/no-handle barrier -> K9 close/zeroize -> cleanup -> A5/S2/S1/replan/ManualStop/fatal`。K9 failure在cleanup与任何lookup/commit前fatal，并保留same reservation/handle/leases relation。Tombstone只含proof validation所需nonsecret identity，secret bytes=0、send closure不可达，只可验证一次；type-8 complete result resolution及所有winner/replan/fatal exit后立即失效。Persistence failure不得把source当成功、不得automatic release。

### 3.6 Automatic failure discrimination

- exact first application或exact replay：complete result后立即pre-release K8 while prepared，再以F27/M2把same handle转为`authorized/open`；authorization不标released；
- release owner取得exclusive latch后状态为`authorized/held/not-delegated`。Known predelegation failure必须先退latch到`authorized/open`再mechanical cancel；只有exact delegate boundary可写`released/delegated`，boundary未知只能写terminal `released/unknown-delivery`；
- failed/unknown automatic commit、CAS loser及其它pre-delegate failure：先mechanical cancel exact handle；若handle未materialize则原子bar reservation并证明no-handle。然后K9 close/zeroize→resource cleanup，之后才可调用M4 A5 `lookupRecoveryOperationResult`；输入保留首次提交的`sessionID + aggregateID + operationID + complete expectedInput + expectedPayloadDigest + expectedReceiptKind`，operationID-only lookup禁止；
- K9 failure：在cleanup、A5/S2/S1、replan、ManualStop或其它post-cancel work前立即fatal；不得丢弃same reservation/handle/leases relation registry；
- A5 complete automatic result：验证complete result，使可能存在的manual-stop tombstone失效并follow/re-enter committed child；不得authorize已cancel handle、创建replacement handle或改写ManualStop；
- A5 `undefined`只证明该valid aggregate scope内exact operation absent；随后必须调用M4 `lookupCurrentRecoveryWinner`。任一complete manual/automatic/superseded winner原样follow/re-enter并invalidate tombstone；只有`unchanged`构成no winner；
- 仅在“A5 operation absent + winner unchanged/no winner + fresh `loadRecoverySnapshot` source binding unchanged + automatic attempt前已有M5/F23独立classified eligible cause”四项同时成立时，才可用secret-free one-shot cancel tombstone独立提交type-8 ManualStop；complete type-8 result resolution后立即invalidate；commit failure/CAS loss本身不得生成cause；
- policy stale：barrier→K9→cleanup后invalidate tombstone，reload snapshot/current policy，重新 lower/prepare；
- A5/winner lookup inconsistent、busy、unresolved、corrupt/partial/owner-mismatched/non-foldable/ambiguous authority或result mismatch：cleanup已完成后invalidate tombstone并fatal，禁止ManualStop；
- `released/unknown-delivery`：K9/zeroize→cleanup→fatal ambiguity；不得cancel、A5驱动resend、replacement prepare、transparent resend或source-success fallback。

### 3.7 Policy, replay, re-entry and supersession

每次未提交的 initial/ordinary/automatic admission 在开始时冻结 exact quartet：

```text
scopeKey / epoch / policyDigest / defaultSemanticsVersion
```

M4 operation types 1、2、9在first-application transaction内重读并比较quartet，重算`recoveryOrdinal <= N`，并只消费transaction-verified committed `NormalizedRecoveryPolicy.digestInput.effectiveMaxModelAssistants`验证`assistantSequence < effectiveM`。禁止读取runtime config/`agent.steps`、直接读取top-level convenience field或再次执行min。Exact replay先按historical operation/post-state/policy验证，不被后来policy变化否定；historical post-state与future current heads分开验证。

Commit-response loss 只允许 bounded durable replay：最多 2 次 lookup、最多 1 次 same `operationID` + same payload resubmission；绝不换 ID、payload 或 handle。该合同不是 public HTTP idempotency key；公开请求在 indeterminate disconnect 后不能透明重发。

Re-entry适用于committed initial、ordinary、automatic child，但authority path分离。Automatic same-process resume once要求exact complete result + same reservation + canonical handle仍`prepared` + same live leases，并再次通过immediate K8与F27/M2 authorization到`authorized/open`，再经exclusive latch与boundary-only delegated transition；generic nonterminal view本身不授予transport。Known lost handle/lease/reservation先durable settlement；`released/unknown-delivery`或其它release/ownership ambiguity只能K9/cleanup后fatal settlement，禁止cancel/resend。Restart绝不从receipt/result重建旧reservation、lease、handle、request或plaintext；K10 cleanup后只能fresh plan，predecessor未terminal/attached/resumed/durably settled前不得创建successor。

Supersession顺序：new input先是closed model/no-reply unprepared candidate。O10直接读取dedicated owner mapping/current aggregate prefix/head；empty aggregate使用C1/MIG1 genesis并证明no unresolved source，不构造terminal recovery snapshot。存在unresolved source时，两branch都持久化完整branch-exact `M1.SupersessionBindingDigestInputV1`及其`M1.SupersessionBindingDigest`：common绑定session、source/control versions、submission payload digest与aggregate/recovery predecessors；model另含`intendedInitialOperationID`，later type-1携`M1.NewLineageReservationRefV1`引用同一digest、独立计算完整payload digest，并用exact type-10 post aggregate head；no-reply固定`replyDisposition:"commit-user-only"`且无future reservation/proof，old recovery finalization后只commit user，zero policy/M7/M2/type-1/model admission。Automatic winner存在时才加载terminal source snapshot并follow/steer后re-evaluate，不fork。Shell serialized但bypass recovery-head supersession。

### 3.8 Sealed authority and current public projection

Dedicated recovery aggregate 与 dedicated sealed aggregate 每 session 一对；operation selector 只读 envelope 顶层 `aggregateID`，M4 验证 `RecoveryAggregateID <-> sessionID` 一对一 owner mapping。Legacy/generic public EventTable aggregate 永不升级或复用为 recovery authority。

Raw signatures、cursor、provider state、KEK/DEK、plaintext、raw handle只存在于M2/M4 controlled scope；public/output/log surfaces不得包含这些值。Automatic lease lifecycle固定`absent -> live -> closed`：K7在unseal/lowering/actual provider preparation前；K8在type-9 first application且cursor/raw commit前，并在release前短读再次执行；K9覆盖release、mechanical cancel、abandoned、lost-handle cleanup及所有失败terminal path并zeroize；K10只凭`ExclusiveDeadProcessLeaseCleanupCapability`。K4/K5遇live same ref/generation拒绝rotate/redact。禁止TTL expiry、renew、reopen、旧handle revival或wall-clock/heartbeat death inference；redaction与zeroization是final。

Current public projection pipeline 唯一为：

```text
M4 raw-derived fold + M4 transaction-owned stable display-ID allocation/reuse
  -> M1.RecoveryPublicAuthorityViewV1
  -> pure M1.projectRecoveryForPublic
  -> M1.ContractResult<M1.RecoveryPublicProjectionV1 | undefined, M1.PublicProjectionViolation>
       error blocks publication; undefined means no public fields
  -> ordinary Legacy Assistant.recovery?
  -> M1.decodeRecoveryPublicProjection
  -> M1.ContractResult<M1.RecoveryPublicProjectionDecodeResult, never>
  -> M8 hydration/display
```

F30 exact branches：known 使用；unsupported 省略；malformed 返回 typed hydration error，不能当 absent。Projection 只允许 version、optional dispatchCount/evidence/sourceErrorPreserved/child.displayID/outcome；不得包含 pending authority state、effective assistant、authority child ID、target、digest、operationID、revision、CAS/head、receipt、sealed ref。

Internal/public event partition 必须在 definition/source 的 `publication` 与 manifest assembly 前完成。F2/F31只对literal `publication:"public"` definition构造M1 `PublicEventDefinitionV1`/`PublicCommittedEventV1`/cursor/listener/subscription/read-error/service/public manifests；trusted private all-durable replay manifest是separate nominal set，可含internal但不能赋给public surface。`M1.PublicEventSubscriptionV1<D>`的stream item exact为同一`D`的nominal `M1.PublicCommittedEventV1<D>`；bridge/sync/instance/global SSE/generated SDK/CLI/TUI callback必须保留该generic relation，不得扩大为broad EventV2 union、unknown structural payload或依赖`event.type` prefix filter。listen/all/typed/public durable/readAggregate因此在type/source上拒绝internal；边界字符串 filter仅是defense-in-depth。不存在 public `session.recovery.*` authority event。M8 `reduceLegacyRunEvent`与`reduceLegacyRunTransport`分别处理nominal public event和独立transport transition，均exact返回`{state,wakeHydrator}`；只有relevant public event或actual transport transition使hydrator revision递增并令`wakeHydrator:true`，transient interruption/close本身不得写terminal hydration failure。`applyLegacyTuiPublicEvent`只接受current connection generation的exact nominal event，且不替代transcript+status full hydration guard。

### 3.9 M8 response/wait spine

```text
sync prompt / sync command
  -> SessionRunState.submitSerialized
  -> wait for full M6 model/recovery chain
  -> M6.CoordinatorResult
  -> automatic: final terminal child
     ManualStop after complete type-8 commit: source
     fatal/indeterminate: sanitized non-success
  -> one shared Legacy response encoder

prompt_async
  -> enqueue scope-owned serialized background operation
  -> acceptance only
  -> HTTP 204 with empty body
  -> full chain continues in background
  -> later public result/error only through M1 public event carriers + M8 sanitizer
```

Sync wrapper不得在source incomplete或automatic child admission时提前返回；async 204不得被解释为model/recovery成功、ManualStop或provider acceptance。disconnect reconciliation不透明resend，且只能从actual public relation/known safe projection恢复final display result。

## 4. 跨子计划 handoff 索引

| Caller -> callee | Exact input/output owner | Required ordering/transaction | Failure/cancel rule |
|---|---|---|---|
| M4 -> M5/M7 | complete nominal `M4.DurableRecoveryAuthorityViewV1` + same-view `M4.AutomaticRecoveryProofSliceV1` | M5 action selection precedes M7 descriptor；SafeRetry=`truly-empty`；Continue=`authoritative-only`+all final | compatibility/mixed/manual/nonfinal fail closed；plain snapshot/local brand拒绝 |
| M7 descriptor -> M2 reservation -> M4 K7 | `M1.RecoveryClosureDescriptor`无plaintext；stable type-9 ID；`M2.PreparedHandleCommitmentReservationV1`；exact lease keys | reservation first，K7 before unseal/lower/actual prepare | any failure closes reservation/leases and zeroizes；provider hits0 |
| M7 K3 -> M2 -> M7 -> M5 | exact replay carriers + live leases -> `M7.LoweredRecoveryCandidate`；`M2.prepareDispatch({candidate,context,operationID,snapshotProof,closure,sealedUseLeases,reservation,lowered,runtimeInput})` consumes reservation；original inspection；same-object validation；planned materialization | exact nine owner-qualified fields；exact total-order reconstruction and all digest recomputation；one preparation；then final classify | no four-field complete signature、Legacy/history/cache/public/provider fallback或replacement prepare；plaintext cannot escape K3 |
| M6 -> M4 O10 | pre-inspection model candidate仅`sessionID/submissionPayloadDigest/intendedInitialOperationID`；no-reply仅`sessionID/submissionPayloadDigest/replyDisposition`；均无source/control/predecessor binding | first `inspect-current-authority`；仅收到branded `M4.SupersessionRequiredAuthorityV1`后构造完整branch-exact binding/type-10 input并`complete-expected-input`重入；old recovery result before user commit；model-only proof | automatic steer；corruption fatal；禁止direct O9或pre-inspection binding；no-reply zero model path |
| M6/M2 -> M4 initial | `M4.InitialAdmissionAuthorityViewV1<M2.NoPreparedHandleProofV1>` built from committed owner/current head/current policy/Legacy user/candidate，then same-candidate `...<M2.PreparedUnreleasedHandleProofV1>` + `M2.PreparedCommitPackageV1` | no terminal snapshot；empty aggregate current head=genesis；type-1 aggregate=current/type10 post；assistant/ledger genesis | A3 revalidates owner/head/policy/user/candidate and exact M2 proof；atomic Legacy assistant+ledger；type-1 user only validates |
| M6/M2 -> M4 ordinary | distinct `M4.OrdinaryAdmissionAuthorityViewV1<...>` with current owner/heads/policy/committed predecessor/candidate，staged no-handle→prepared | no terminal snapshot；type-2 exact successor and candidate ledger genesis | stale view cancels；atomic Legacy assistant+ledger |
| M6 -> M4 generic committed re-entry | exact `{aggregateID,sessionID,assistantID,admissionOperationType:K}` -> `M4.loadCommittedAssistantAuthorityView<K>` -> `M4.CommittedAssistantAuthorityViewV1<K>` | type-1/2/9 admitted assistant only；one WAL read snapshot；nonterminal only；no S1/public projection/history substitute | terminal/closed/corrupt/gap rejects；normal terminal follows own result path，exact incomplete terminal commit gates separate S1；M6不得复制view shape |
| M6/M3 -> M4/M2 subsequent preparation | `M4.CommittedAssistantAuthorityViewV1<K>` + closed previous settlement -> fresh candidate context -> owner-private `SubsequentDispatchPreparationInput` -> `prepareSubsequentDispatch` -> `recordAndAuthorizeSubsequentDispatch` | one preparation；type-3 ledger/head atomic commit；M1 F26 only；fresh settlement allocated after authorization and before release | view/close/prepare/CAS/F26/allocation失败均不release；known-no-send durable abandonment，unknown fatal ambiguity；不允许consumer-local authority/input alias |
| M4 lookup evidence -> M1 private validators | owner-index success -> exact nominal `M1.M4RecoveryAggregateOwnerMappingProofV1` in `M1.RecoveryDurableRowDecodeInputV1`；sealed-store success -> `M1.M4SealedRecoveryMaterialLookupProofV1` | M4 performs I/O/brand construction first；M1 only exact-shape and field-equality pure validation | consumer不得结构复制、persist/refresh/revoke proof；mapping/key lookup stale或失败保持M4 typed error |
| M3 -> M4 facts/terminal | M1 exact tool/reasoning/terminal literals | raw + derived state same transaction | commit/reload失败 stop；无 recovery send |
| M4 -> M5 | complete nominal authority view + same-view proof slice from one read transaction | read-only，no public/current-config splice | corrupt/partial/owner-mismatched/non-foldable/version-unknown/unresolved-ambiguous fatal before M5 |
| M5 -> M7 | at most one action candidate and exact same-view slice | pure selection then plaintext-free descriptor | M7不得切换action或cast manual-only proof |
| M7-validated M2 inspection -> M5 | exact planned materialization + descriptor/reservation/leases/same-view proof | final classify only after one prepare/validation | causes→M1 F23；proposal无authority |
| M6 -> M4 automatic | exact planned wrapper、proposal、quartet、committed predecessor、stable operationID、same-view proof、reservation、live leases | O8/type-9 first application K8 before raw/cursor commit；atomic child/decision/ledger/heads；complete result | every pre-delegate failure uses cancel/no-handle barrier→K9→cleanup before A5/S2/S1/replan/ManualStop/fatal；K9 failure stops first |
| M6 -> M4 ManualStop | eligible M1/F23 proposal、branch-exact `M1.ManualStopBindingDigestInputV1`、fresh source binding、exact current no-handle proof或secret-free one-shot cancelled-handle tombstone；M4只调用M2 exact validators | cancel/no-handle barrier→K9→resource cleanup；then exact type-8 transaction；complete result resolution happens-before immediate tombstone invalidation；manual binding无target/semantic/prepared/authorization/closure digest | failed-automatic还须cleanup后A5 absent→S2 unchanged→fresh S1 source binding→pre-existing classified cause；K9 failure在cleanup/lookup/commit前fatal；任一lookup/persistence unresolved或authority异常fatal |
| M6 -> M2 authorize/release | ordinary branches：complete result+same handle→F26；automatic suffix：complete type-9 result→immediate K8 while prepared→F27+M2 exact authorization to authorized/open | exclusive latch to authorized/held/not-delegated→delegate once→boundary-only released/delegated or released/unknown-delivery→K9；only delegated+K9 success→empty attempt→ordinal0 once→consume | known-not-delegated exits latch then cancel；pre-release failure uses cancel/no-handle barrier→K9→cleanup；K9 failure stops before cleanup/lookup；unknown terminal no cancel/resend |
| M4 -> M1 -> M8 projection | M4-owned stable display mapping + `M1.RecoveryPublicAuthorityViewV1` -> pure F28 exact `ContractResult` -> public Legacy field -> F30 exact `ContractResult` -> M8 hydration | authority与display mapping在M4 transaction/rebuild确定；F28/F30不写表、不分配ID；M8只走public decode path | F28 error阻止publication；F30 malformed typed hydration error，unsupported only may omit；无consumer-local projection alias |
| M1 public subscription -> M8 reducers | `M1.PublicEventSubscriptionV1<D>` stream item exact `M1.PublicCommittedEventV1<D>`；transport transitions为separate input | `reduceLegacyRunEvent`/`reduceLegacyRunTransport` exact返回`{state,wakeHydrator}`；`applyLegacyTuiPublicEvent`要求current connection generation | broad union/structural cast/prefix filter拒绝；transient transport不直接terminal fail；TUI event不替代transcript+status hydration guard |
| M6 noReply -> M4 O10 -> Legacy user commit | closed no-reply candidate；type-10 result or no-source branch；no reservation/proof | old recovery resolution strictly before user commit；then user-only return | automatic winner steer；corruption fatal；zero policy/M7/M2/type-1/assistant/ledger/M |
| M6 shell -> shell owner | serialized shell input only | stays in per-session queue but bypasses O10/recovery、policy、M7/M2、N/M and model admission | shell owner failure only；不得创建recovery/model authority |

## 5. Errors and 24 ManualStop reasons

### 5.1 Error owner index

| Owner | Canonical contract |
|---|---|
| M1 | `M1.ContractResult<A,E extends M1.RecoveryContractError = M1.RecoveryContractError>` / exact owner-exported error subunions；unknown version/extra field/canonicalization/digest/public projection violation fail closed；见SESSREC-1 §3.1/§5.0.1。 |
| M4 | Effect typed channel；`M4.SessionRecoveryOwnerCreationErrorV1`、`M4.RecoverySnapshotReadErrorV1`、`M4.RecoveryRebuildErrorV1`、`M4.RecoveryPendingSealPersistErrorV1`、`M4.RecoverySealErrorV1`、`M4.RecoveryAuthorityErrorV1`、`M4.RecoveryMigrationErrorV1`；见SESSREC-2 §3/§4.5–§4.6。 |
| M2 | prepare/introspection/runtime-proof/authorization/latch/delegate-boundary/cancel typed errors；authorization仅到authorized/open；known predelegation failure退latch再cancel；released/unknown-delivery fatal且不cancel/resend；K9 failure stops before cleanup。 |
| M3 | begin/final-plan/body-outcome/settlement/drain/terminal persistence errors；durable fence失败时相应 side effect 0。 |
| M5 | structured cause set 与 pure deterministic classification；不拥有 reason spelling。 |
| M6 | config/policy/budget/head/ownership/response-loss/re-entry errors；closed automatic failure discrimination。 |
| M7 | history/closure/protocol/storage/inspection unavailable；不 persist、不 release。 |
| M8 | hydration/public adapter errors；public wire仍为 `UnknownError`。 |

### 5.2 Exact Legacy `UnknownError` strings

唯一 mapping function：M8 `legacyIncompleteUnknownErrorMessage`，SESSREC-4 §3.2。

1. `adapter-incomplete` -> `Provider stream ended without a terminal finish event`
2. `clean-eof` -> `Provider stream ended without a settled model step`
3. `empty-unknown-finish` -> `Provider stream ended with an unknown finish reason and no usable output`

Wire 保持 `name: "UnknownError"` 与 exact `data.message`；不得加入 raw cause、stack、authority、receipt、digest 或 sealed material。Fatal/indeterminate sanitizer固定为`{ name: "UnknownError", data: { message: "Session recovery stopped before a safe final result" } }`。

### 5.3 Exact 24 reasons

唯一 tuple/order/mapping owner：SESSREC-1 §3.3 与 F23。

1. `dispatch-evidence-inconsistent`
2. `dispatch-ambiguous`
3. `provider-introspection-unavailable`
4. `planned-target-unavailable`
5. `planned-authority-unavailable`
6. `planned-request-materialization-failed`
7. `planned-request-digest-failed`
8. `planned-runtime-proof-unavailable`
9. `provider-replay-unknown`
10. `provider-continuation-unavailable`
11. `provider-proof-unavailable`
12. `recovery-action-inapplicable`
13. `local-tool-replay-unknown`
14. `open-tool-input`
15. `unsettled-tool`
16. `interrupted-tool`
17. `uncertain-tool-result`
18. `dispatch-lowering-unverifiable`
19. `continuation-context-unavailable`
20. `recovery-binding-stale`
21. `recovery-budget-exhausted`
22. `same-process-max-step-exhausted`
23. `superseded-by-new-user-input`
24. `internal-classification-failure`

Typed causes 可以多于 24；F23 独占 cause -> reason mapping、causal suppression、fixed-order sort、dedupe 与 nonempty repair。`detail`、`callID`、`operationID` 不参与 stable reason identity。

## 6. Transaction, CAS, replay and Rely-Guarantee

### 6.1 Authority and persistence index

- Canonical `M1.RecoveryOperationEnvelope<T>` stored in one dedicated recovery aggregate is sole recovery fact authority；generic public EventTable aggregates保持原selector/schema/sequence，不迁移、不加入recovery hash chain，也不得被M4 rebuilder当作recovery authority。
- 每 session 只有一个 dedicated recovery aggregate 与一个 dedicated sealed aggregate；M4 owner mapping 验证 session pair。
- 七个 raw-derived materializations：relation、dispatch ledger、tool、reasoning、decision、consumption、public projection；完整 schema 只见 SESSREC-2 §4.2。
- 三个 lineage CAS heads：`recovery_head`、`assistant_chain_head`、`dispatch_ledger_head`。`AggregateEventHeadV1` 是 raw cursor，不是第四个 recovery head。
- Writes 使用 `BEGIN IMMEDIATE`；DB lock、unique index、cursor CAS、head CAS 是 authority，process-local mutex 不是。
- First application 的 singleton insert/CAS 必须 `RETURNING` exactly one row；0-row 永远不是首次应用成功。
- Lookup scope 是 `(aggregateID, operationID)`；same ID/different payload digest conflict。
- Head write order：assistant chain -> dispatch ledger -> recovery。
- C1/MIG1 committed empty dedicated aggregate的M1 genesis是fresh initial current head，但不构成terminal source snapshot；initial/ordinary staged authority view在A3 first apply中按owner mapping/current head/current policy/Legacy predecessor/candidate/M2 proof逐项重验。
- A3 在 transaction 内完成 raw anchor、pending seals、七 materializations、relevant heads、full read-back；任一步失败全回滚，residue 0。

### 6.2 First application vs exact replay

1. Exact replay lookup/validation 在 current policy、N/M、key、handle 或其它 current-resource check 前执行。
2. Historical fold 从 genesis 到 stored operation sequence，验证 historical input、policy quartet、post-state、immutable receipt。
3. Current validation 独立 fold 到 current high-water，比较完整 raw chain、七 materializations 与 current three heads。
4. Historical post heads 不要求等于 later current heads。
5. `M1.OperationCommitResultV1<T>.applyMode` 指示 `first-application` 或 `exact-replay`；immutable receipt 不记录 apply mode。
6. Busy retry bounded 至多 3 次，必须保持 same operationID/payload/handle，不 reprepare、不 substitute。

### 6.3 Rely-Guarantee

**Rely**

- H1：单个dedicated recovery aggregate的raw event sequence可在SQLite transaction内全序追加，且M4能验证唯一session owner mapping；durability/safety只覆盖transaction成功返回后的validated process-crash fault model，不覆盖host crash、power loss、filesystem/device-cache loss或storage corruption；不处理多主写入。
- H2：audited M2 gate 位于 final transform 后、provider transport delegate 前。
- H3：provider replay/continuation capability 只来自 explicit versioned contract/proof，不能由近义 SDK field 猜测。
- H4：sealed authority满足scope/integrity/cascade；K7–K10 lease lifecycle、K4/K5 conflict、dual K8、K9 zeroization与exclusive-fence cleanup均可机械验证。
- H5：runtime ownership/release state 可识别；无法识别时按 lost/unknown fail closed。
- H6：public projection 兼容性以 OpenAPI/SDK/old-client decode 与 zero-leakage 验证为前提。
- H7：Native V2 不消费 internal recovery definitions/transitions。

**Guarantee**

- M1：exact/versioned schemas、closed registry、`ContractResult`、V1 receipts、commit result、24-reason mapping。
- M2：stable no-send reservation、one preparation consuming it、linear prepared→authorized/open→exclusive-held→boundary-released state、original inspection、exact reservation/lease/result validation、known predelegation latch exit+cancel、unknown-delivery terminal与no replacement send。
- M3：raw-before-hook、final-plan-before-body、five durable phases、O3a no-callback restart reconciliation、typed terminal。
- M4：dedicated raw sole authority、complete nominal authority view/same-view proof、atomic CAS、O3a、K7–K10 sealed-use lifecycle、first/replay separation、deterministic materialization与public isolation。
- M5：four-way partition-aware pure selection/final classification；compatibility/mixed/manual/nonfinal fail closed。
- M6：exact 21-step automatic coordinator；runtime只消费committed policy digest input；closed failure/re-entry/supersession handling。
- M7：plaintext-free descriptor、K3-scoped exact replay reconstruction/all-digest recomputation、same-object validation、no Legacy/public/current-provider authority fallback。
- M8：deterministic safe projection/public wrappers、Legacy compatibility、source-level event isolation。

## 7. G/I/H correctness index

### 7.1 G1–G12 owner map

| Goal | Final design index |
|---|---|
| G1 | M3 typed terminal -> M4 raw commit；original source `UnknownError` 保留。 |
| G2 | M4 complete view -> M5 selection -> same-view slice -> M7 descriptor -> stable ID/M2 reservation -> K7 -> K3 replay lowering -> M2 exact nine-field prepare/inspection -> M7 validation -> M5 classify -> O8/K8 complete result -> pre-release K8/F27/M2 authorized/open -> exclusive latch/delegate boundary once -> K9/zeroize；delegated only -> empty attempt/ordinal0/consume，unknown-delivery -> fatal。 |
| G3 | M7 SafeRetry full source exclusion；M6/M4 创建独立 child。 |
| G4 | M3 settled evidence + M7 minimal Continue closure；tool execution追加次数为0。 |
| G5 | M5/M6 unknown/stale/budget/ownership/persistence fail closed；M1 F23 stable reasons。 |
| G6 | M3 raw invocation -> hook -> final-plan revision -> body two-fence。 |
| G7 | M4 dedicated aggregate、owner mapping、three heads；fresh initial用genesis current head+origin-specific staged authority，ordinary用distinct view，M6无snapshot/旁路admission。 |
| G8 | M4 full raw prefix 重建七materializations、three heads、terminal recovery snapshot与safe public authority view；generic public aggregate排除。 |
| G9 | exact policy quartet、`recoveryOrdinal <= N`、`assistantSequence < effectiveM`；dispatch/physical request分离。 |
| G10 | source-level internal event partition；M4 -> M1 -> M8 deterministic safe projection。 |
| G11 | M7 exact Anthropic/OpenAI storage/protocol allowlist；hosted/encrypted/stateless unsupported fail closed。 |
| G12 | generic retry、interrupt、permission、compaction、max-step、shell 与 recovery authority 正交。 |

### 7.2 I1–I13 preservation index

| Invariant | Preservation owner/anchor |
|---|---|
| I1 source incomplete remains terminal error | M3 §7.10–§7.12；M8 §7.1/§7.9 |
| I2 delegate boundary requires matching complete durable result and automatic lease chain；released never precedes boundary | ordinary F26；automatic O8 K8 + complete type-9 result + immediate K8 + F27/M2 same reservation/handle/leases to authorized/open；exclusive latch remains authorized/held/not-delegated；boundary-only released delegated/unknown；then K9；detached receipt observation-only |
| I3 local side effects respect fences and restart never reruns uncertain callbacks | M3 five phases；M4 O3a append-only reconciliation；reconciled terminal is manual-only |
| I4 dedicated raw recovery aggregate is sole authority | M4 §3.7、§5、§7；generic public aggregate excluded |
| I5 no fork and no admitted-without-initial-ledger state | M4 three heads/composite operations；M6 §9 |
| I6 source/planned/admission/policy domains stay separated | M1 §4.5–§4.7；M5 §8；quartet bound at transaction |
| I7 internal authority is not public | M1 F31；M4 §8；M8 §7.6 |
| I8 partial/forced/unsupported content is not success context | four-way partition + five phases；M7 only owner replay carriers，exact order/digest recomputation，plaintext K3 scope |
| I9 recovery/model budgets are bounded and policy-exact | M1 F13 normalization；runtime/M4 only transaction-verified committed `digestInput.effectiveMaxModelAssistants`；no reread/re-min |
| I10 stale/unknown/ambiguous state never automatic releases | M1 F23–F27；M2/M5/M6 failure tables |
| I11 type-1 remains model-lineage genesis while aggregate genesis is only the first aggregate operation | M1 operation 1 schema/current `AggregateEventHeadV1` rule；M4 type-1 transaction；M6 model supersession reservation/type-1 flow |
| I12 noReply creates no model admission authority | closed type-10 no-reply branch；M6 user-only zero-effect path；M8 exact noReply wrapper |
| I13 decisions/messages rebuild only from raw authority and transport accepts only complete results | M1 operations 1/2/8/9/10 deterministic material；M4 fold/materialization/allocation；M1 pure projector；M2 initial/ordinary/subsequent F26-only gate与automatic type-9 F27-exclusive gate；detached receipt rejected |

### 7.3 Main safety theorem

```text
complete nominal DurableRecoveryAuthorityViewV1
and same-view AutomaticRecoveryProofSliceV1
and eligible four-way partition/final tool phases
and exact policy quartet plus committed effectiveMaxModelAssistants
and one M5-selected action
and plaintext-free RecoveryClosureDescriptor
and stable no-send M2 reservation
and exact live K7 sealed-use leases
and K3-scoped exact-order replay reconstruction with all commitments recomputed
and one same-object M2 paused preparation/original inspection
and exact M7 validation plus applicable M5 final proposal
and M4 O8 first-application K8 atomic child/ledger/three-head commit
and one complete OperationCommitResultV1
and immediate pre-release K8 plus F27/M2 same reservation/handle authorization to authorized/open
and one exclusive authorized/held/not-delegated latch owner
and exactly one delegate-boundary transition to released/delegated or released/unknown-delivery
=> at most one local provider delegate
=> delegated + K9 success before empty attempt, ordinal-0 allocation, and stream consumption
=> unknown-delivery is terminal fatal ambiguity with no cancel/resend
```

这是已通过fresh independent design audit的safety obligation，不是future implementation/runtime已证明结论。M3证明source/phases；M4证明nominal view、raw authority、O3a、K7–K10与atomicity；M5证明partition-aware conservative selection/classification；M7证明owner-carrier replay reconstruction与same-object inspection；M2证明reservation/one prepare/same handle、exclusive latch与boundary-only released transition；M6/M4证明committed policy/budget/child admission。任一pre-delegate合取项缺失均mechanical cancel/no-handle barrier→K9→cleanup，再follow verified winner、replan、ManualStop或fatal；K9 failure在cleanup/lookup前fatal，authority corruption一律fatal。

### 7.4 Partial correctness and liveness boundary

上述定理是safety/partial-correctness：若owner operations在H1限定的validated process-crash fault model内返回成功，则postcondition与at-most-one local release成立。它不承诺provider/network exactly-once、eventual response、eventual key availability、eventual SQLite progress、process survival，或host crash、power loss、filesystem/device-cache loss、storage corruption后的authority retention。`recoveryOrdinal <= N`与`assistantSequence < effectiveM`只证明recovery/model-assistant chain有界；bounded busy retry/lookup只证明本地算法终止边界。Indeterminate disconnect/release state进入ambiguity/fatal，不通过透明resend伪造liveness。当前candidate不要求SQLite `synchronous=FULL`；若未来扩展fault set，必须重新架构审查并在automatic release/tool side effect前验证FULL-or-stronger durability。

## 8. Evidence and future verification indexes

### 8.1 Current direct evidence only

| Level | Current direct set | Exact boundary |
|---|---|---|
| A | 10 CLI checks | covered Legacy fail-stop/transcript/tool/child assertions only |
| B | 1 live HTTP/generated SDK check | unprefixed Legacy transport wiring only |
| C | 10 = 7 prompt + 3 TCP processor | covered prompt/TCP processor behavior only |
| D | 29 = 2 synthetic processor + 1 retry + 22 TUI + 4 routes | directly asserted processor/retry/handler/render/sync/policy mechanics only |
| S | `[S — source seam only]` recorded by architecture/subplans | static source seam only；not part of 50 |

### 8.1.1 Current S reuse

- `[S — source seam only]` M4复用现有SQLite immediate transaction/event publication与Session migration/cascade/read-back接缝，但dedicated recovery aggregate、seven materializations、three heads及stable display-ID allocation/reuse仍是future owner合同。
- `[S — source seam only]` M7复用existing ordinary history lowerer与shared Anthropic/OpenAI protocol canonicalization接缝；initial/ordinary继续existing converter，automatic仍必须经过M2 final no-send capture与same-object inspection validation。
- `[S — source seam only]` M8复用Legacy unprefixed HTTP/generated SDK/sync/hydration/render接缝，并只消费M1 F30 public decode path；不读取M4 raw/materialization/head/receipt/sealed ref。
- `[S — source seam only]` 当前SQLite WAL使用`synchronous=NORMAL`；本candidate因此只把successful transaction作为validated process-crash fault model内的durable evidence，不外推到host crash、power loss、filesystem/device-cache loss或storage corruption。

这些静态复用项不计入50，不提供runtime hit/order/correctness保证，也不改变所有future项的`[F — planned; not created; not run]`状态。

### 8.2 Future test index

本节只把已真实创建并运行的M1-A、F1/F2与F4 partial evidence从future集合中剥离；其余行保持exact future marker，不声称对应fixture、migration、expectation或implementation已存在。

1. M1 partial/future split：`[P — partial implementation evidence]`覆盖M1-A、F1/F2与F4 exact field-set validator；`[F — planned; not created; not run]`仍覆盖F3、F5–F31/F16a、strict recovery codecs、25 commitment builders（含 `supersession-binding-v1`）、PreparedDigest exact initial/ordinary/automatic-recovery branches、automatic/manual-stop branch-exact BindingDigest、candidate/committed brands、`DispatchAdmissionV1`、`TypedIncompleteTerminalFact`、`AssistantChainHeadV1`、`AggregateEventHeadV1`、`AutomaticRecoveryAction`、`RecoveryAdmissionPolicyBindingV1`、all V1 receipts、aggregate-scoped `RecoveryOperationLookupKeyV1`、M4 owner/sealed nominal proof inputs、`OperationCommitResultV1`、仅 `first-application|exact-replay`、runtime malformed仍total的F23 fixed-24 mapping、policy quartet、pure F28/F30 owner separation；private dispatch/receipt/apply-mode helpers必须无法从consumer barrel命名，consumer只经exported/indexed surfaces取得；见 SESSREC-1 §7。
2. `[F — planned; not created; not run]` Type-1 lineage genesis/initial authority：empty aggregate只用C1/MIG1 aggregate genesis current head且不构造`M1.DurableRecoverySnapshot`；nonempty aggregate必须exact current `AggregateEventHeadV1`；post-type-10必须exact type-10 post head；`M4.InitialAdmissionAuthorityViewV1`逐项绑定owner/current policy/committed Legacy user/candidate与M2 no-handle→prepared proof；assistant-chain与该initial assistant自身的ordinal-0 ledger仍exact genesis；wrong head/reservation/proof拒绝。
3. `[F — planned; not created; not run]` Type-10/reservation：O10 `inspect-current-authority`对empty/no-source/model/no-reply/automatic winner与unresolved source各branch；unresolved只返回branded `M4.SupersessionRequiredAuthorityV1`，caller构造完整`SupersessionBindingDigestInputV1`+digest+type-10 expected input/payload digest后必须`complete-expected-input`重入；model validated/no-source才产生`M4.SupersessionBeforePrepareProofV1`，no-reply永无proof；later type-1 reservation ref引用同一model digest且独立计算complete payload digest。
4. `[F — planned; not created; not run]` M4 authority：dedicated recovery/sealed owner pair、owner mismatch、M4 owner-index/sealed lookup成功后exact nominal proof构造、first apply exactly-one且只消费committed `NormalizedRecoveryPolicy.digestInput.effectiveMaxModelAssistants`、failure injection zero residue、historical replay/current prefix split、three-head races、aggregate-scoped complete-result response-loss lookup、derived-row/head与authority/sealed digest registry重算、raw-referenced sealed metadata对dual prefix/fold/physical row exact replay、snapshot/rebuild equivalence、higher-level same-tx cascade deletion counts/FK proof、policy first/replay separation；见 SESSREC-2 §12。
5. `[F — planned; not created; not run]` M4 deterministic materialization：operations 8–10 exact decision reconstruction；operations 1/2/9 atomic Legacy assistant/message materialization；type-1 existing Legacy user validation/no recreation；conflicting rows fatal；M4 stable display-ID allocation/reuse与pure M1 projection。
6. `[F — planned; not created; not run]` M2/M4/M7 automatic chain：complete nominal view/same-view slice与four-way partition；M7 plaintext-free descriptor；stable type-9 ID；M2 reserved-no-send commitment；K7 before unseal/lower/prepare；K3 exact-order inline/sealed replay reconstruction与all-digest recomputation；one exact nine-field M2 prepare consuming reservation；original inspection/same-object validation；M5 final classification；O8 first-apply K8；complete result；immediate K8；F27/M2 authorized/open；exclusive latch authorized/held/not-delegated；delegate boundary once records released/delegated or released/unknown-delivery；K9/zeroize；delegated only→empty attempt→ordinal0 once→consume。Compatibility/mixed/manual/nonfinal、Legacy/cache/public/current-provider fallback、replacement prepare、early released与plaintext escape均拒绝。
7. `[F — planned; not created; not run]` Complete-result authorization/release boundary：detached receipts observation-only；ordinary branches用F26。Automatic package含complete type-9 result、exact proposal、original planned、same reservation/handle/leases；dual K8成功后F27/M2只建立authorized/open；exclusive latch后仍authorized/held/not-delegated，exact delegate boundary才记录released delegated/unknown，随后K9。Known-not-delegated退latch再cancel；unknown不cancel/resend。Receipt-only、mismatched、stale、lost或early-released inputs拒绝。
8. `[F — planned; not created; not run]` M3/M5/M6：five tool phases与O3a no-body/no-hook/no-provider reconciliation；reconciled terminal closes barrier but automatic remains forbidden；`recoveryOrdinal <= N`与committed-policy `assistantSequence < effectiveM`；type-9 exact predecessor/child-ledger genesis；all automatic failures barrier→K9→cleanup→A5/S2/S1/replan/ManualStop/fatal，K9 failure pre-cleanup fatal；ManualStop仅用secret-free one-shot tombstone且在exact absence/no winner/fresh binding/pre-existing cause时允许，type-8 result后invalidate。
9. `[F — planned; not created; not run]` Serialized submissions/admission origins：model O10 dedicated current-authority read before user commit（fresh empty=head genesis，recovery snapshot calls=0）then committed user→policy/candidate/no-handle initial view→plan→converter/M2/prepared view/type-1；ordinary使用distinct authority view且snapshot calls=0；只有terminal incomplete automatic使用`M1.DurableRecoverySnapshot`；noReply O10/no-source before user commit then user-only，断言policy/M7/M2/type-1/assistant/ledger/authorization/release/M全部为0；shell仍serialized但绕过O10/recovery、policy、M7/M2、N/M与model admission。
10. `[F — planned; not created; not run]` M4 sealed/publication + M8/shared regression：sealed scope/integrity/rotation/redaction/cascade/no-plaintext；`PublicEventSubscriptionV1<D>` item exact `PublicCommittedEventV1<D>`且public zero leakage；`reduceLegacyRunEvent`/`reduceLegacyRunTransport` exact `{state,wakeHydrator}`、transient transport不terminal fail、`applyLegacyTuiPublicEvent` generation gate；three UnknownError strings；OpenAPI/generated SDK old-client decode；Native V2/shared schema/EventV2/SQLite/LLM compatibility，但不创建 Native V2 recovery flow或expectations。

Future acceptance 必须分别报告 provider transport hits、local-tool side effects、durable residue、public leakage、final assistant/exit/busy state；不能只写“test passed”。

## 9. Dated resolution register and remaining review conditions

### 9.1 Current resolution register — 2026-08-14

下表记录此前P0/P1问题在当前owner contracts中的修复状态。全部六项此前已验证的P0/P1 owner issues（R21–R26）及后续审查finding已完成repair；原stable snapshot与D0 changed snapshot的fresh independent review均达到`0 P0 / 0 P1`，用户批准、Step 0及D0 commit/push也已完成。Production implementation已完成并推送M1-A与M1-B F1/F2；M1-C F4已完成实现、验证及独立review，文档同步与commit/push仍在当前gate。其余future tests、migration与codegen尚未开始。

| ID | Previously found P0/P1 issue | Current resolution | Exact owner-document anchors | Status |
|---|---|---|---|---|
| R01 | automatic prepare/result顺序与prepare-before-authority | 唯一21步顺序保持complete view→selection→same-view slice→descriptor→stable ID→reservation→K7→K3 reconstruction/lowering→one nine-field prepare/inspection→same-object validate→final classify→O8/K8→complete result→pre-release K8→F27/M2 authorized/open→exclusive latch/delegate boundary once→K9/zeroize→delegated-only empty attempt→ordinal0→consume；unknown-delivery fatal。 | SESSREC-2 §6/§9；SESSREC-3 §9；SESSREC-4 §4–§5 | Independent design audit passed; user approval completed |
| R02 | opaque/available/automatic receipt naming与字段漂移 | Shared schema只采用M1 exact V1 receipts与`AuthorityReceiptV1`；initial/ordinary/subsequent只调用F26，F27 exclusively保留给automatic type-9并要求exact proposal+original available planned+same handle；consumer旧alias无owner地位。 | SESSREC-1 §4.7.3、F26、F27；SESSREC-2 §3.3 consumer index | Independent design audit passed; user approval completed |
| R03 | internal definition 与 commit-result/apply-mode漂移 | Schema-owned raw `RecoveryEventDefinitionSetV1`与LLM-owned enriched `RecoveryEventRegistryV1`各有唯一constructor；consumer只使用exported carriers/`EventManifestSet`与`OperationCommitResultV1<T>`，不得复制definition/helper或反向依赖。apply mode仅 `first-application\|exact-replay` 且不进receipt。 | SESSREC-1 §4.5.1、§4.8.3–§4.8.4；SESSREC-1 M1-T29 | D0 fresh independent review passed; 0 P0 / 0 P1 |
| R04 | M7/M2 target circularity、shared duplicates、inspection owner与double prepare | M7先输出plaintext-free descriptor；M2 reservation固定prepared-handle commitment；K7后M7在K3 scope内形成no-target candidate，M2 one prepare消费reservation并拥有original inspection；M7按inspection target验证same object；no replacement/local aliases；initial/ordinary不用M7 automatic path。 | SESSREC-4 §4–§5；SESSREC-3 §4/§6 | Independent design audit passed; user approval completed |
| R05 | provider runtime provenance/second fetch/zero-network过宽 | M2 provenance与gate由SESSREC-3 §6拥有；第二 downstream call poison/fail closed，不slot-rotate；承诺只限 audited provider transport hits = 0。 | SESSREC-3 §6.1–§6.7、§10；SESSREC-2 §1.4 item 6 | Independent design audit passed; user approval completed |
| R06 | generic committed-assistant re-entry缺失 | Initial、ordinary、automatic child统一消费M4-only `CommittedAssistantAuthorityViewV1<K>`/`loadCommittedAssistantAuthorityView<K>`并由M6 re-entry/settlement处理；M6不export duplicate view/loader，restart不重建handle。 | SESSREC-2 §3.1/§7；SESSREC-3 §4.11、§9.12–§9.12.1、§11 | Independent design audit passed; user approval completed |
| R07 | transaction-time policy race | Durable monotonic policy authority与exact quartet冻结；type 1/2/9 first apply transaction内重读并只消费committed `NormalizedRecoveryPolicy.digestInput.effectiveMaxModelAssistants`，禁止从runtime/caller `configuredM`/`agent.steps` re-min；historical replay先验证stored policy。 | SESSREC-3 §9.1.1–§9.2；SESSREC-2 §3.6、§5.3–§5.5 | Independent design audit passed; user approval completed |
| R08 | tool ordering、preplanned subtask与effect边界 | Raw invocation -> before hook -> final plan -> body；preplanned subtask也走统一gate；zero-hit不扩大到所有local preparation effects。 | SESSREC-3 §7.1–§7.7、§13.4；SESSREC-2 §1.4 item 6 | Independent design audit passed; user approval completed |
| R09 | public wrapper duplicate ownership | M6只拥有internal serialized coordinator；M8唯一拥有public response/wait/HTTP/SDK/CLI/TUI wrappers。 | SESSREC-3 §9.15–§9.16；SESSREC-4 §7–§8 | Independent design audit passed; user approval completed |
| R10 | ManualStop persistence/cancel顺序与failed-automatic降级边界 | Every automatic failure固定mechanical cancel/no-handle barrier→K9→resource cleanup→A5/S2/S1/replan/ManualStop/fatal；K9 failure在cleanup/lookup前fatal。Potential ManualStop只保留secret-free one-shot cancel tombstone；complete result/winner原样follow。只有operation absent、winner unchanged、fresh source binding与attempt前pre-existing M5/F23 cause同时成立才允许type-8，complete result resolution后立即invalidate tombstone；其它authority/lookup异常fatal。 | SESSREC-3 §9.10、§13.4；SESSREC-4 §4.3、§9.3；SESSREC-2 §1.4/§5.5 | Independent design audit passed; user approval completed |
| R11 | canonical builder/evidence literal/SQL近义词冲突 | Canonical registry/builders与tool/reasoning literals只由M1拥有；M4 codec必须total/versioned消费，unknown失败，不得read-time猜测。 | SESSREC-1 §4.1.3、§4.4.5–§4.4.6、F17–F22；SESSREC-2 §4.2/§5.3 consumer boundary | Independent design audit passed; user approval completed |
| R12 | sealed commitment/raw secret边界 | M1 ref/commitment是shared contract；M4 separate sealed aggregate拥有storage integrity、rotation/redaction/unseal lifecycle；raw material不进入candidate/receipt/public path。 | SESSREC-1 §4.3.4/F16；SESSREC-2 §9；SESSREC-4 §4.1/§5.4 | Independent design audit passed; user approval completed |
| R13 | public projection authority、stable display-ID allocation与malformed omission | M4 transaction拥有stable display-ID allocation/reuse并产出raw-derived authority view；M1 F28为pure projection、不得分配ID；M8只F30 decode。Unsupported可省略，malformed必须typed error。 | SESSREC-1 §4.7.4、F28–F30；SESSREC-2 §8；SESSREC-4 §7.2 | Independent design audit passed; user approval completed |
| R14 | dedicated aggregate selector/owner/generic aggregate混淆 | Envelope顶层`aggregateID`选择dedicated recovery aggregate；M4验证session owner mapping；generic public aggregate明确排除。 | SESSREC-2 §3.7、§4.1–§4.2、§7；architecture Appendix A.4/A.6 | Independent design audit passed; user approval completed |
| R15 | post-supersession type-1 aggregate genesis矛盾、new input先写或future complete-payload reservation | Type-1改为model-lineage genesis：aggregate predecessor是exact current head，只有aggregate首operation才是aggregate genesis；post-type-10 append exact type-10 post head。O10先`inspect-current-authority`；unresolved只返回branded `SupersessionRequiredAuthorityV1`，M6构造branch-exact full `SupersessionBindingDigestInputV1`+digest与complete type-10 input/payload digest后以`complete-expected-input`重入；model validated/no-source才得proof，later type-1 reservation ref引用同一model digest并独立计算complete payload digest；no-reply固定commit-user-only且无reservation/proof。 | SESSREC-1 operation 1/10与reservation contracts；SESSREC-2 §1.5/§6.10；SESSREC-3 §9.13/§11 | Independent design audit passed; user approval completed |
| R16 | historical result、detached receipt、automatic F27 package与response-loss | Historical/current validation分离；aggregate-scoped lookup返回complete result。Automatic same-process path还要求same reservation/handle/live leases、dual K8与F27/M2 exact match到authorized/open，再经exclusive latch/boundary-only released transition；unknown-delivery不cancel/resend。Restart不重建旧reservation/lease/handle；public disconnect不透明重发。 | SESSREC-1 F26/F27；SESSREC-2 §5/§9；SESSREC-3 §6/§9.11；SESSREC-4 §8 | Independent design audit passed; user approval completed |
| R17 | source-level event partition与durable manifest概念混淆 | M1 public brands/carriers/service/manifests只接受literal public definitions；trusted private all-durable replay registry是separate nominal set且可含internal；`PublicEventSubscriptionV1<D>` item exact为`PublicCommittedEventV1<D>`，`session.recovery.*`在public listener/subscription/cursor/read-error/codec中不可表示；subscriber无broad-union/prefix-filter branch。 | SESSREC-1 §4.5.1a/F2/F3/F31；SESSREC-2 §8；SESSREC-4 §7.6/§11.5 | Independent design audit passed; user approval completed |
| R18 | M7 ownership与automatic phase漂移 | Initial/ordinary保持ordinary converter；automatic中M7先构造plaintext-free descriptor，K7后只在K3 scope内重建/lower，M2 one prepare后same-object validate，M5 final classify。M7不创建authority、不持久化lease、不做final classification。 | SESSREC-4 §4–§6；SESSREC-3 §9；SESSREC-2 §6/§9 | Independent design audit passed; user approval completed |
| R19 | Fresh initial admission错误依赖terminal recovery snapshot；M2 proof/lease在M4 consumer侧只有structural duplicate | C1/MIG1 genesis只建立dedicated current authority；O10、initial与ordinary使用M4 origin-specific reads/views，empty initial current head为genesis，policy/user/candidate与M2 no-handle→prepared proof逐项绑定；`M1.DurableRecoverySnapshot`只用于durable terminal source。M2 exact exports/validators拥有proof fields/invariants/lifecycle，M4只调用validator。 | SESSREC-2 §3.1/§4.2.1/§5.3/§6.1/§7；SESSREC-3 §4.1/§4.10/§5.1/§9.4–§9.15 | Independent design audit passed; user approval completed |
| R20 | SQLite WAL `synchronous=NORMAL`下把durability theorem误写为host/power/storage-loss保证 | Current candidate显式限定validated process-crash fault model并排除host/power/filesystem/device-cache/storage corruption；扩展fault set需重新架构审查。 | architecture §3.1、§4.10、§9.3；本文件 §6.1、§7.4 | Independent design audit passed; user approval completed |
| R21 | Prior P0：compatibility-only evidence可被误判为zero-tool | M1 four-way partition + M4 nominal complete view/same-view slice；SafeRetry仅`truly-empty`，Continue仅`authoritative-only`且all final；其它分支fail closed。 | SESSREC-1 §4.5.6；SESSREC-2 §3.1/§4.2.3/§7；SESSREC-3 §8 | **Independent design audit passed; user approval completed** |
| R22 | Prior P1：Continue缺少可重建payload | M1 inline/sealed replay carriers；M4 snapshot/proof materialization；M7 strict decode/re-encode、exact-order reconstruction与all-owner-digest recomputation；无Legacy/cache/public/provider fallback。 | SESSREC-1 §4.4.5–§4.6.1；SESSREC-2 §4.2；SESSREC-4 §5 | **Independent design audit passed; user approval completed** |
| R23 | Prior P1：tool phase不能区分body outcome与after-hook settled | Five durable phases + M4 O3a append-only no-callback reconciliation；`reconciled-terminal-manual-only` closes barrier but forbids automatic permanently。 | SESSREC-1 §4.4.5；SESSREC-2 O3a；SESSREC-3 §7 | **Independent design audit passed; user approval completed** |
| R24 | Prior P1：prepare-to-release sealed-use/redaction race | M2 stable no-send reservation与prepared→authorized/open→exclusive held→boundary-only released state；M4 K7–K10、dual K8、K4/K5 conflict、K9 all exits/zeroize、exclusive-fence K10；known predelegation退latch再cancel，unknown-delivery terminal no resend；no TTL/renew/reopen/time inference。 | SESSREC-2 §9；SESSREC-3 §6；SESSREC-4 §5.4 | **Independent design audit passed; user approval completed** |
| R25 | Additional P1：runtime policy authority仍有reread/re-min路径 | Runtime/first application只消费transaction-verified committed `NormalizedRecoveryPolicy.digestInput.effectiveMaxModelAssistants`；禁止config/steps reread、top-level direct access与re-min。 | SESSREC-1 policy contracts；SESSREC-2 §3.6/§5；SESSREC-3 §9.1 | **Independent design audit passed; user approval completed** |
| R26 | Additional P1：owner exports/signatures、supersession与automatic call order漂移 | M1六项新增shared exports已闭合，private receipt/apply-mode names只经exported/indexed surfaces消费；M4仅引用exported/indexed M1 surfaces；`submitSerialized` pre-inspection candidate保持最小，O10 branded authority后才complete-input re-entry；M2 `prepareDispatch` exact九字段、M2/M4/M7 frozen result→K8→authorization→latch/delegate→K9 suffix与21-step order已对齐。 | SESSREC-1 §4/§5.0.1；SESSREC-2 §3/§6/§9；SESSREC-3 §4/§9；SESSREC-4 §4–§5 | **Independent design audit passed; user approval completed** |

### 9.2 Genuinely remaining review conditions

以下是 review completion conditions，不是 implementation/F obligations，也不表示production工作已开始：

1. **已完成**：全部六项此前已验证的P0/P1 owner issues（R21–R26）及后续审查finding均已修复并同步；global consumer文档未创建alternate carrier/brand/owner。
2. **已完成**：当前stable six-document snapshot的独立design/cross-document audit达到`0 P0 / 0 P1`。
3. **已完成**：最终机械 owner/export review确认consumer只引用本文件 §2 的 exact owner-qualified/versioned names，无local structural duplicate、旧alias或近义literal。
4. **已完成**：Workflow §4.3.1/§4.3.2 与 §4.4 的最终详细设计审查无P0/P1 blocker。
5. **已完成**：用户已明确批准 detailed design；D0 changed snapshot另完成fresh independent review `0 P0 / 0 P1`。

## 10. Workflow six-rule and §4.4 review checklist

### 10.1 Six-rule coverage

本全局文档只索引 owner 证据；只有 owner 文档确实给出相应函数规约/proof 时才标为可检查。

| Rule | Current review evidence | Candidate status |
|---|---|---|
| 推导连续 | SESSREC-1 §5 compliance ledger；SESSREC-2 §5–§11；SESSREC-3 §6–§15；SESSREC-4 §5–§11；本文件 §3串联全局 spine。 | Independent design audit passed; user approval completed |
| 分支覆盖 | Automatic success/loser/stale/corrupt/persistence/send-unknown，SafeRetry mapping absent/ambiguous/wrong-role/stale，ManualStop，re-entry，supersession，public decode/read-error及public/private manifest branches均有owner表。 | Independent design audit passed; user approval completed |
| 退出覆盖 | prepare/commit/CAS/replay/authorize/release/settlement/projection failure均索引cancel、rollback、follow winner、replan或fatal。 | Independent design audit passed; user approval completed |
| Callee契约引用 | 本文件 §2、§4只引用唯一owner exact names/anchors；完整pre/post仍由owner函数节拥有。 | Independent design audit passed; user approval completed |
| 循环刻画 | `recoveryOrdinal <= N`、`assistantSequence < effectiveM`、bounded busy retry、bounded response-loss lookup、one-handle-per-round给出终止边界；provider/network liveness明确不承诺。 | Independent design audit passed; user approval completed |
| 显式假设链 | 本文件 §6.3 H1–H7、§7.4 partial-correctness/liveness；owner docs列对应 Rely–Guarantee/proof。 | Independent design audit passed; user approval completed |

### 10.2 Workflow §4.4 review candidate

- [x] 架构正确性论证可由 `architecture.md` G/M、I、H 与 main theorem 检查。
- [x] 全局索引与四个 owner 文档共同提供 scope/reuse/error/type/function/checklist 结构；全局文档不复制owner结构。
- [x] 六条完整性已有owner-level可审查证据与全局edge索引。
- [x] 非平凡函数的正确性论证可按 SESSREC-1 §5、SESSREC-2各function proof/§11、SESSREC-3各function proof/§15、SESSREC-4各function proof/§11检查。
- [x] G1–G12、M1–M8、I1–I13、H1–H7、three recovery heads plus aggregate event head/cursor、policy quartet、24 reasons、snapshot assistant mapping与public event nominal boundary已有唯一owner索引；不存在无owner的M4 mapping callable claim。
- [x] 全部六项此前已验证的P0/P1 owner issues（R21–R26）及后续审查finding均已修复，fresh independent design audit结论为`0 P0 / 0 P1`。
- [x] 修订后的stable six-document snapshot已完成fresh independent audit并达到`0 P0 / 0 P1`。
- [x] 最终机械 export/import、cross-doc anchor 与无歧义审查已签结。
- [x] 用户已明确批准 detailed design。
- [x] 四份Step 0 per-subplan contract-audit expectations已创建、审查、commit并push（`acc7d0bcf`）。
- [x] D0 package-ownership correction已完成fresh independent review并达到`0 P0 / 0 P1`；两个P2 metadata/wording项已修正。

以下implementation gates仍未整体完成：

- [ ] Production implementation整体未完成；M1-A、M1-B F1/F2与M1-C F4已实现，F3、F5–F31与M2–M8尚未完成。
- [ ] Future acceptance tests整体未完成；当前仅M1-A、F1/F2与F4 focused/runtime/property/type/core compatibility evidence已创建并运行。
- [ ] Recovery migration/codegen与完整Step 5 audit-report尚未执行或创建；M1-C devlog随本slice创建。

## 11. Step 0 gate and exact implementation dependency order

### 11.1 Mandatory gate before implementation order

以下顺序不可跳过：

```text
R21-R24 and R25-R26 owner contracts repaired and global candidate synchronized
  → fresh stable-snapshot independent design/cross-document re-audit with 0 P0/0 P1
  → user explicit approval of the revised architecture/detailed design
  → per-subplan contract-audit expectations Step 0 completed and pushed at acc7d0bcf
  → D0 schema/LLM ownership call-graph correction
  → fresh D0 independent review with 0 P0/0 P1
  → implementation dependency order
```

用户批准与四份Step 0 expectations均已完成。只读真实package dependency核查发现原F3同时由schema manifest调用LLM-owned F17/F21会形成反向依赖，因此D0已将schema F3收窄为raw `RecoveryEventDefinitionSetV1`，并由LLM `buildRecoveryEventRegistry`沿允许方向补两个existing allowed-set digests。D0、M1-A与M1-B的机械检查、review及commit/push均已完成；M1-C F4也已完成实现、验证与独立review，当前只待文档同步、commit与push。F3 raw recovery definition slice必须等待该gate，不得与F4混成同一未审步骤。

### 11.2 Implementation dependency order after Step 0 passes

1. M1：冻结/实现exact `*V1` contracts，包括`DispatchAdmissionV1`、`TypedIncompleteTerminalFact`、`AssistantChainHeadV1`、`AggregateEventHeadV1`、`AutomaticRecoveryAction`、`RecoveryAdmissionPolicyBindingV1` exports，并保持dispatch/receipt variants与`OperationApplyModeV1` private；实现total F23/F24、initial/ordinary/subsequent-only F26、automatic-type-9-exclusive F27 descriptor validation、25-domain registry/builders（含three-branch PreparedDigest、branch-exact automatic/manual BindingDigest与`supersession-binding-v1`）、aggregate-scoped `RecoveryOperationLookupKeyV1`、explicit M4 owner/sealed nominal proof inputs、closed type-10 union、type-1 current-aggregate/model-lineage-genesis rules、policy codec、pure public F28–F30 contracts。
2. M4 authority foundation：dedicated recovery/sealed aggregate owner/genesis、raw operations、transactions、materializations、three heads、owner-index/sealed lookup后构造M1 exact nominal proofs、origin-specific initial/ordinary staged authority views、terminal-only recovery snapshot/rebuild、aggregate-scoped complete first/replay results、derived-row/head及authority/sealed digest registries、dual-prefix+physical-row sealed replay、same-parent-transaction deletion proof、nominal public notifier boundary、deterministic decisions、Legacy assistant/message writes、stable display mapping、sealed authority。
3. M7/M2/M4 handshake：descriptor-first no-plaintext closure -> stable type-9 ID -> M2 no-send reservation -> M4 K7 -> M7 K3-scoped exact replay reconstruction/lowering -> M2 one prepare consuming reservation/original inspection -> M7 same-object validation -> planned materialization；禁止fallback、replacement prepare与plaintext escape。
4. M6 policy authority：publish/read/transaction-read/per-admission freeze exact quartet；runtime only committed `digestInput.effectiveMaxModelAssistants`。
5. M2/M4 gates：reservation validation/close、K7–K10、dual K8、same reservation/handle/lease complete-result authorization到authorized/open、exclusive latch与boundary-only delegated/unknown terminal、known predelegation latch exit+cancel、all-failure barrier→K9→cleanup、secret-free one-shot ManualStop tombstone及type-8 result后invalidation、subsequent ordinary F26 path；detached receipt不得授权transport。
6. M3：five durable tool phases、O3a restart handoff、ordinary per-result settlement与automatic post-release/K9 ordinal-0 allocation、drain、typed terminal commit/reload。
7. M5：automatic candidate selection + post-M7-validation final classification；M1 F23 是唯一 reason mapper。
8. M6 coordinator：O10 dedicated current-authority read、initial no-handle view→plan→prepare→prepared view、distinct ordinary view、terminal-snapshot-only automatic exact order、ManualStop exact M2 proof/absence/no-winner guard、re-entry、model/noReply branches、noReply user-only zero-effect path、serialized shell bypass。
9. M1/M4 projection implementation：M4 stable mapping/authority view -> pure F28 safe projection；source-level event partition与private durable replay registry。
10. M8：sync/async HTTP、disconnect reconciliation、UnknownError sanitizer、projection hydration、nominal `PublicEventSubscriptionV1<D>`→`PublicCommittedEventV1<D>` callbacks、event/transport `{state,wakeHydrator}` reducers、TUI generation gate、CLI/interactive/TUI、shell与Native regression；clients/codegen与future tests只在相应implementation/test步骤执行。

任何模块不得跨过未通过的 owner expectations/audit gate。Native V2不创建recovery expectations；shell保持N/A；不得新增public authority event。

## 12. Review-candidate conclusion

当前准确结论：

- proposal只保留requirements/root cause/product scope/original evidence权威，implementation contracts exclusively由当前architecture/detailed design/subplans拥有；
- detailed design已获用户批准，四份Step 0 expectations已完成、review、commit并push；这仍不是production-ready声明；
- 原stable-snapshot与D0 changed snapshot的fresh independent review结论均为`0 P0 / 0 P1`；D0只修正M1内部package ownership/call graph；
- D0、M1-A与M1-B commit/push gate已完成；SESSREC-1 M1-C F4已完成实现、验证与独立review，当前只待文档同步、commit与push；
- M1-A、F1/F2及F4 focused runtime/property/type/core compatibility evidence已真实创建并运行，但只覆盖这些partial slices；F3、F5–F31及其余future verification仍严格是`[F — planned; not created; not run]`；
- 50/50只证明source-equivalent当前A/B/C/D直接行为；`[S — source seam only]`只证明静态接缝；
- Legacy-only、N=2/M=64、`recoveryOrdinal`/`dispatchOrdinal`分离、shell N/A、无public authority event、three UnknownError strings、source-level event partition、partial-correctness/liveness边界与indeterminate disconnect不透明重发均保持冻结；
- M1-C F4文档同步、commit/push并验证远端后才可进入F3 raw recovery definition set；F5–F31与SESSREC-2仍不得提前开始。
