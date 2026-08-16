<!--
  Workflow Step 0 deliverable for Issue #7.
  Normative workflow: docs/workflow.md §6.
  Evidence discipline: extracted from design contracts before reading production source or tests.
  Step 1–3 implementation, tests, schemas, scripts, audit-report.md, and decisions.md are not created by this step.
-->

# Contract Audit Expectations — `sessrec-3-legacy-runtime-recovery`

**子计划**: `sessrec-3-legacy-runtime-recovery`（Issue #7，Legacy Runtime Recovery）
**契约 review 时间**: `2026-08-15`
**Step 0 完成时间**: `2026-08-15`
**Step 5 验证时间**: `待 Step 5 填`

> 本文件仅记录从契约独立抽取的 future implementation obligations。未读取 production source 或 tests；所有实现位置均保持 `待 Step 5 填`，不得据当前实现反向回填契约。

---

## 1. 契约源（多文档）

| # | 文档 | 章节 | 涵盖契约维度 |
|---|---|---|---|
| 1 | `templates/contract-audit/expectations-template.md` | 全文 | 10 节结构、反向扩展声明、Step 5 双验证记录 |
| 2 | `docs/workflow.md` | §6 | Step 0 独立抽取、机械化识别、property-based invariants、Step 5 路径 A/B 与五维度兜底 |
| 3 | `docs/design/session-recovery/architecture.md` | 模块边界、数据契约、主流程、不变量、安全定理、失败矩阵、验收边界 | M1–M8 ownership、I1–I13、A/B/C/D/S/F evidence boundary、总体安全与进展义务 |
| 4 | `docs/design/session-recovery/detailed-design.md` | owner/export index、M2/M3/M5/M6 callable index、call graph、transaction/CAS/replay、G/I/H/F 索引 | 跨模块 exact signatures、调用顺序、错误传播、re-entry、supersession、future acceptance |
| 5 | `docs/design/session-recovery/subplans/sessrec-3-legacy-runtime-recovery.md` | §1–§18，重点 §3–§16 | SESSREC-3 normative runtime owner contract；M2/M3/M5/M6 exact types/errors/enums/callables；流程、状态、性能、安全与 future tests |
| 6 | `docs/design/session-recovery/subplans/sessrec-1-contract-canonicalization.md` | §3.1、§3.3、§4.8.5、§5.0.1、F23、F26、F27 | M1 exact error/cause/reason ownership；24 ManualStop reasons；receipt/admission validation |
| 7 | `docs/design/session-recovery/subplans/sessrec-2-durable-authority.md` | owner-qualified types；A5；O3a/O6/O7/O8/O10；S1/S2；K7–K10 | M4 durable authority、exact replay/response loss、tool reconciliation、supersession与sealed-use lifecycle |
| 8 | `docs/design/session-recovery/subplans/sessrec-4-legacy-lowering-public-contract.md` | §3–§9，重点 §4.2–§6、§7.1、§7.4.1–§7.4.2、§7.14、§8–§9 | M7 exact lowering handoff与same-object validation；M8 coordinator/noReply/shell/fatal sanitizer public boundary |

### 1.1 Normative ownership precedence

1. M1 owns shared exact types, canonical schemas/builders, `RecoveryFailureCause`, `ManualStopReason`, F23/F26/F27, digests, receipt/result mappings, and the exact 24-reason order.
2. M2 owns Legacy runtime provenance, adapter availability, no-send reservation, paused handle/proofs, authorization, exclusive release latch, delegate boundary, cancellation, and cleanup.
3. M3 owns attempt-local ordinal settlement, durable-before-execute tool gating, O3a runtime coordination, drain, event isolation, and terminal classification.
4. M4 owns durable recovery authority, operations/readers, A5/S1/S2/O3a/O6/O7/O8/O10, and K7–K10 lease authority.
5. M5 owns pure candidate selection/classification over owner-qualified M4 views and M1 causes; it does not own stable reasons.
6. M6 owns committed policy authority consumption, N/M admission, orchestration, ManualStop, response-loss steering, re-entry, supersession, and per-session serialization.
7. M7 owns provider-neutral lowering and same-object prepared inspection validation; SESSREC-3 owns only the exact internal handoff to it.
8. M8 owns public wrappers, public result mapping, noReply/shell adapters, 204 behavior, hydration, and exact fatal sanitization.

### 1.2 Evidence boundary

| Marker | Step 0 interpretation |
|---|---|
| `[A]` | Current design-review evidence group A contains 10 checks. |
| `[B]` | Current design-review evidence group B contains 1 check. |
| `[C]` | Current design-review evidence group C contains 10 checks: 7 prompt checks and 3 TCP processor checks. |
| `[D]` | Current design-review evidence group D contains 29 checks: 2 synthetic processor, 1 retry, 22 TUI, and 4 route checks. |
| A–D total | Exactly 50 current design-review checks; these checks do not prove future implementation, migration, codegen, tests, Step 5 audit, or production readiness. |
| `[S — source seam only]` | Documents an existing source seam only; it is not one of the 50 checks and is not evidence that the future contract is implemented. No source seam was independently inspected during this Step 0. |
| `[F — planned; not created; not run]` | Future implementation/test/audit obligation only. Every future artifact named below remains uncreated and unrun at Step 0. |

---

## 2. Schema 字段（机械化）

> 本子计划的主要 schema 是 owner-qualified TypeScript runtime/durable contracts，不得为 Step 0 另建平行 JSON schema。Step 5 应机械检查 exact fields、closed unions、owner imports 与 forbidden structural aliases。所有位置待实现后填写。

### 2.1 M2 exact runtime and proof schemas

| 类型 / 字段组 | Exact fields / type | 必选 | 来源 | 实现位置（待 Step 5 填） | 一致 |
|---|---|---|---|---|---|
| `M2.PreparedHandleCommitmentReservationV1` | `reservationVersion:1`, `owner:"M2"`, `reservationID`, `candidateContext`, `operationID`, `action`, `target`, `targetDigest`, `preparedBodyVersion`, `gateKind`, `gateReservationID`, `handleGenerationID`, `pausedHandleCommitment`, `state:"reserved-no-send"`, `providerPreparationCount:0`, `auditedProviderTransportHitCount:0`, nominal brand | yes | SESSREC-3 §4.0/§4.1/§6.3.0 | 待 Step 5 填 | pending |
| `M2.PreparedHandleReservationValidationErrorV1` | `tag:"m2-prepared-handle-reservation-validation"`; cause closed union: `version`, `owner`, `state`, `candidate`, `operation`, `action`, `target`, `gate`, `generation`, `commitment`, `already-consumed`, `closed` | yes | SESSREC-3 §4.0 | 待 Step 5 填 | pending |
| `M2.ProviderRuntimeProvenance` | `version, providerID, modelID, npmSpecifier, packageVersion, factory, factoryID, modelLoader, fetchOwner, downstreamFetchID, middleware, preProviderSideEffects, provenanceDigest, availability, unavailableCause?` | yes | SESSREC-3 §4.2 | 待 Step 5 填 | pending |
| `M2.LegacyRuntimeInput` | `runtime`, `model`, `provider`, `language`, `provenance`, `aiSDKMaxRetries:0`, `nativeHiddenRetries:0` | yes | SESSREC-3 §4.0 | 待 Step 5 填 | pending |
| `M2.M2InspectionResult` | available: exact `M1.DispatchAdmissionV1` available admission + `frozenRequest`; unavailable: exact `M1.RecoveryFailureCause`; unavailable has no handle/partial request proof | yes | SESSREC-3 §4.0/§4.4/§4.5 | 待 Step 5 填 | pending |
| `M2.PreparedCommitPackageV1` | available/opaque closed union; exact M1 target/digests/replay/capability/authorization/commitment fields; available has pending seals and prepared proof; opaque has provider/model/localTools/cause and empty pending seals | yes | SESSREC-3 §4.1 | 待 Step 5 填 | pending |
| `M2.AvailableDispatchHandle` | `kind:"available"`, candidate context, available admission/package, handle commitment, optional recovery reservation only for automatic, canonical state ref, one release delegate, cleanup | yes | SESSREC-3 §4.1 | 待 Step 5 填 | pending |
| `M2.PreparedUnreleasedHandleProofV1` | version/lease/context/generation/commitment + `state:"prepared"`, `authorized:false`, `released:false`, `cancelled:false`, `sendClosureReachable:true`, nominal brand | yes | SESSREC-3 §4.1 | 待 Step 5 填 | pending |
| `M2.NoPreparedHandleProofV1` | version/context/current registry generation/`preparedHandleCount:0`/`state:"no-prepared-handle"`, nominal brand | yes | SESSREC-3 §4.1 | 待 Step 5 填 | pending |
| `M2.MechanicallyCancelledUnreleasedHandleProofV1` | version/lease/context/generation/commitment/previous state + cancelled terminal booleans and `sendClosureReachable:false`, nominal brand | yes | SESSREC-3 §4.1 | 待 Step 5 填 | pending |
| `M2.ReleaseCallableProofV1` | version/owner/lease/context/generation/commitment/receipt commitment + `state:"authorized"`, `releaseLatch:"open"`, nominal brand | yes | SESSREC-3 §4.0/§4.1 | 待 Step 5 填 | pending |
| `M2.DelegatedReleaseProofV1` | version/owner/latch/lease/context/generation/commitment + `state:"released"`, `delivery:"delegated"`, `delegateBoundaryRecorded:true` | yes | SESSREC-3 §4.0/§4.1 | 待 Step 5 填 | pending |
| `M2.UnknownDeliveryReleaseProofV1` | same binding fields + `delivery:"unknown-delivery"`, `delegateBoundaryRecorded:"unknown"`, `resendAllowed:false` | yes | SESSREC-3 §4.0/§4.1 | 待 Step 5 填 | pending |
| `M2.ReleasedUnknownDelivery` | `sendState:"unknown"`, `terminalState:"released-unknown-delivery"`, exact candidate/generation/commitment/proof, `resendAllowed:false` | yes | SESSREC-3 §4.0/§4.1 | 待 Step 5 填 | pending |
| `M2.AutomaticPreReleaseCancellationV1` | `cancelled-handle` with same reservation + exact cancelled handle; or `no-handle-barred` with same reservation + no-handle proof + `futureReservationConsumeAllowed:false` | yes | SESSREC-3 §4.1/§6.10.1 | 待 Step 5 填 | pending |
| `M2.MechanicallyCancelledDispatch` | exact handle + cancelled proof + `sendClosureReachable:false` | yes | SESSREC-3 §4.1/§6.11 | 待 Step 5 填 | pending |
| `M2.DispatchCleanupResult` | `closed` exact `{tag:"closed";cancellationProofRetained:false}`；或 `manual-stop-tombstone` exact `{tag:"manual-stop-tombstone";cancellationProofRetained:true;proof:M2.MechanicallyCancelledUnreleasedHandleProofV1;secretBytesRetained:0}` | branch-exact | SESSREC-3 §4.1/§6.11.1 | 待 Step 5 填 | pending |
| `M2.AISDKDispatchRuntime` / `M2.AISDKGateSlot` | one invocation/slot; exact context/reservation/gate IDs/expected generation+commitment; arrival/phase/state atomics; rendezvous and authorization Deferreds | yes | SESSREC-3 §4.3 | 待 Step 5 填 | pending |
| `M2.AuditedAISDKDescriptor` | id limited to Anthropic Messages/OpenAI Responses, exact package/version/descriptor version, `hiddenRetryCount:0`, provenance matcher, final-fetch inspector | yes | SESSREC-3 §4.4 | 待 Step 5 填 | pending |
| `M2.NativePausedCompilation` | exact generation/gate/reservation/request/route/transport/body/private prepared/inspection and one `executeOnce` delegate | yes | SESSREC-3 §4.5 | 待 Step 5 填 | pending |

### 2.2 M2 exact errors

| Error type | Exact closed contract | 来源 | 实现位置（待 Step 5 填） | 一致 |
|---|---|---|---|---|
| `M2.M2PrepareError` | `{tag:"m2-prepare", cause:M1.RecoveryFailureCause, phase:string}` | SESSREC-3 §4.0 | 待 Step 5 填 | pending |
| `M2.DispatchAuthorizationError` | `{tag:"dispatch-authorization", cause:"state"\|"result-kind"\|"binding-mismatch"}` | SESSREC-3 §4.0/§6.9 | 待 Step 5 填 | pending |
| `M2.MechanicalCancelError` | `already-released` with delegated/unknown delivery; or `release-in-progress` with latch ID | SESSREC-3 §4.0/§6.11 | 待 Step 5 填 | pending |
| `M2.DispatchReleaseError` | known-not-delegated→cancelled; delegated terminal with proof; or unknown-delivery terminal with ambiguity; each preserves exact transition/send state | SESSREC-3 §4.0/§6.10 | 待 Step 5 填 | pending |
| `M2.HandleProofValidationErrorV1` | exact closed causes for version/context/lease/generation/commitment/receipt/registry/state/latch/delivery/released/closure reachability | SESSREC-3 §4.1 | 待 Step 5 填 | pending |
| `M2.ReleaseBoundaryError` | `{tag:"release-boundary", cause:"latch"\|"state"\|"proof"}` | SESSREC-3 §4.1 | 待 Step 5 填 | pending |

### 2.3 M3 exact attempt, settlement, tool and terminal schemas

| 类型 / 字段组 | Exact fields / branches | 必选 | 来源 | 实现位置（待 Step 5 填） | 一致 |
|---|---|---|---|---|---|
| `M3.AttemptLocalState` | fresh `structuredOutput`, `structuredOutputCallID`, `assistantEvidence`, `activeToolInvocations`; no inheritance across assistants | yes | SESSREC-3 §4.6/§12 | 待 Step 5 填 | pending |
| `M3.DispatchOrdinalSettlement` | committed context/ordinal/receipt operation ID + fresh provider-turn and terminal-trigger atomics | yes | SESSREC-3 §4.0/§7.0.1 | 待 Step 5 填 | pending |
| `M3.AssistantRuntimeEvidence` | `currentOrdinal`, `byOrdinal`, `settledOrdinalSummaries`; append/freeze by ordinal | yes | SESSREC-3 §4.0/§4.6 | 待 Step 5 填 | pending |
| `M3.DispatchOrdinalSettlementDestination` | exact assistant/maps/current/summaries plus expected current/new ordinal; no prepare/commit/authorize authority | yes | SESSREC-3 §4.0/§4.7 | 待 Step 5 填 | pending |
| `M3.ToolInvocationHandle` | exact committed owner, provider-dispatch or preplanned-local owner, call/digest/results/state/completion/abort | yes | SESSREC-3 §4.8 | 待 Step 5 填 | pending |
| `M3.RestartToolReconciliationAllocationV1` | owner/call ordinal/observed and reconciliation operation IDs/observed intermediate phase/one-shot state | yes | SESSREC-3 §4.8/§7.8.1 | 待 Step 5 填 | pending |
| `M3.RestartToolReconciliationResultV1` | reconciled complete result; already-terminal final/reconciled; cancelled-before-allocation; fatal-stop | yes | SESSREC-3 §4.8/§7.8.1 | 待 Step 5 填 | pending |
| `M3.BodyOutcome` | `completed`, `error`, `interrupted`, `uncertain` | yes | SESSREC-3 §4.0/§7.6 | 待 Step 5 填 | pending |
| `M3.FinalToolPlan` | `execute`, `replacement`, `short-circuit`, `reject`; exactly one final plan | yes | SESSREC-3 §4.0/§7.4 | 待 Step 5 填 | pending |
| `M3.DrainedDispatchOrdinal` | exact ordinal, provider evidence, ordered tool evidence, ordered reasoning evidence | yes | SESSREC-3 §4.0/§7.9 | 待 Step 5 填 | pending |
| `M3.TerminalDecision` | normal-settled, incomplete typed fact, evidence-inconsistent cause, orthogonal-stop error; each exact current ordinal | yes | SESSREC-3 §4.0/§7.10 | 待 Step 5 填 | pending |
| `M3.AssistantProcessOutcome` | finished, ordinary-continuation-needed, incomplete with whole M4 authority view, compaction, orthogonal-stop | yes | SESSREC-3 §4.0/§7.12 | 待 Step 5 填 | pending |
| `M3.ToolExecutionGateError` | tag `tool-gate`; exact phase `raw-begin`, `before-hook`, `final-plan`, `body-outcome`, `after-hook`, `settlement`; cause private | yes | SESSREC-3 §4.0/§7.1–§7.7 | 待 Step 5 填 | pending |
| `M3.TerminalSettlementError` | `{tag:"terminal-settlement", cause:unknown}`; never serialized publicly | yes | SESSREC-3 §4.0/§7 | 待 Step 5 填 | pending |

### 2.4 M5 exact selection/classification schemas

| 类型 / 字段组 | Exact fields / branches | 必选 | 来源 | 实现位置（待 Step 5 填） | 一致 |
|---|---|---|---|---|---|
| `M5.CandidateSelection` | automatic: exact action + same branded `M4.AutomaticRecoveryProofSliceV1`; manual: exact M1 causes + authority kind `manual-only` or `planning-failure` | yes | SESSREC-3 §4.0/§8.1 | 待 Step 5 填 | pending |
| `M5.classifyRecovery` input | whole M4 authority view, selection, optional closure/reservation/planned, exact lease tuple, exact `M1.AdmissionPlan` | yes | SESSREC-3 §8.2 | 待 Step 5 填 | pending |
| M5 output | exact `M1.RecoveryProposal`; automatic or manual-stop only after M1 owner validation; no local reason/result alias | yes | SESSREC-3 §8.2–§8.3 | 待 Step 5 填 | pending |

### 2.5 M6 exact policy, orchestration and coordinator schemas

| 类型 / 字段组 | Exact fields / branches | 必选 | 来源 | 实现位置（待 Step 5 填） | 一致 |
|---|---|---|---|---|---|
| `M6.RecoveryPolicyScopeKey` | exact alias/re-export of `M1.RecoveryPolicyScopeKey`; no second brand | yes | SESSREC-3 §4.9 | 待 Step 5 填 | pending |
| `M6.RecoveryPolicyAuthorityExpectation` | exact alias/re-export of `M1.RecoveryAdmissionPolicyBindingV1` | yes | SESSREC-3 §4.9 | 待 Step 5 填 | pending |
| `M6.RecoveryPolicyAuthoritySnapshot` | version, exact normalized policy, scope, epoch, policy digest, default semantics version, control-policy digest | yes | SESSREC-3 §4.9/§9.1.1–§9.2 | 待 Step 5 填 | pending |
| `M6.RecoveryPolicyAuthorityError` | invalid-policy, missing, stale, corrupt, cas-conflict, busy, persistence; each exact closed fields/reasons | yes | SESSREC-3 §4.9 | 待 Step 5 填 | pending |
| `M6.SerializedSubmissionOperationID` | internal nominal string; immutable after enqueue; not public idempotency key | yes | SESSREC-3 §4.10/§9.15 | 待 Step 5 填 | pending |
| `M6.SerializedSubmission` | model/no-reply/shell; each has internal operation ID, canonical digest, session ID, exact branch payload only | yes | SESSREC-3 §4.10/§9.15 | 待 Step 5 填 | pending |
| `M6.UnpreparedNonAuthoritativeNewInputCandidate` | model exact `{sessionID,submissionPayloadDigest,intendedInitialOperationID}`; no-reply exact `{sessionID,submissionPayloadDigest,replyDisposition:"commit-user-only"}` | yes | SESSREC-3 §4.10/§9.13 | 待 Step 5 填 | pending |
| `M6.CoordinatorResult` | `model-final`, `user-only`, `shell-final`, `fatal-stop` with exact branch payloads | yes | SESSREC-3 §4.10/§9.15 | 待 Step 5 填 | pending |
| `M6.FatalRecoveryStop` | `tag:"fatal-recovery-stop"`, private cause, handle disposition `none`, `mechanically-cancelled-unsendable`, or `released-or-unknown` | yes | SESSREC-3 §3.1.1/§4.10 | 待 Step 5 填 | pending |
| `M6.PreallocatedCandidate` | candidate context, stable operation ID, `authority:"candidate"`; no budget/head authority until M4 commit | yes | SESSREC-3 §4.0/§9.3 | 待 Step 5 填 | pending |
| `M6.AdmittedAssistant` | authorized-not-released with exact authorized ordinal 0; or automatic-released with exact delegated stream/proof | yes | SESSREC-3 §4.0/§9.5–§9.9 | 待 Step 5 填 | pending |
| `M6.AutomaticCommitResult` | admitted, replan-policy-stale with whole M4 view, follow-winner with exact type-8/type-9/type-10 complete result, fatal-stop | yes | SESSREC-3 §4.0/§9.9 | 待 Step 5 填 | pending |
| `M6.CommitResolution<T>` | committed complete result, missing, conflict, partial-or-corrupt, persistence-fatal, ambiguous | yes | SESSREC-3 §4.0/§9.11 | 待 Step 5 填 | pending |
| `M6.SupersessionResult` | model-proceed with M4 proof; no-reply-proceed-user-only; follow-automatic-winner with complete result+whole view; fatal-stop | yes | SESSREC-3 §4.0/§9.13 | 待 Step 5 填 | pending |
| `M6.ReentryDecision` | attach-live-processor, resume-never-released, settle-known-no-send, settle-ambiguity, ownership-cancelled-before-reconciliation, fatal-authority-invalid | yes | SESSREC-3 §4.11/§9.12 | 待 Step 5 填 | pending |
| M6 private errors | `AdmissionError`, `ReentryError`, `ConfigDecodeError`; all owner-mapped and internal-only | yes | SESSREC-3 §4.0/§3.1.1 | 待 Step 5 填 | pending |

**Future schema artifacts**: `[F — planned; not created; not run]` Step 5 owner-type/field-set checks and any project-provided contract-audit schema checks. This Step 0 creates no `*.schema.json` and must not introduce a schema parallel to M1/M4 owner contracts.

---

## 3. 枚举值（机械化 — 共享 owner import）

| 枚举集合 | Exact values | Normative owner / source | 共享常量或 owner type | Import / 实现位置 | 一致性测试 |
|---|---|---|---|---|---|
| M2 dispatch origin | `initial`, `ordinary`, `automatic-recovery`, `outer-retry` | M2 / SESSREC-3 §4.0 | private `DispatchOrigin` | 待 Step 5 填 | `[F — planned; not created; not run]` |
| M2 subsequent origin | `outer-retry`, `unexpected-step` | M2 / SESSREC-3 §4.0 | private `SubsequentOrigin` | 待 Step 5 填 | `[F — planned; not created; not run]` |
| M2 adapter decision tag | `ai-sdk-available`, `native-available`, `opaque`, `disabled` | M2 / SESSREC-3 §4.0/§6.2 | `DispatchAdapterDecision` | 待 Step 5 填 | `[F — planned; not created; not run]` |
| M2 runtime availability | `available-candidate`, `opaque` | M2 / SESSREC-3 §4.2 | `ProviderRuntimeProvenance["availability"]` | 待 Step 5 填 | `[F — planned; not created; not run]` |
| M2 audited gate kind | `ai-sdk-controlled-fetch`, `native-http-json` | M2 / SESSREC-3 §4.0 | reservation gate kind | 待 Step 5 填 | `[F — planned; not created; not run]` |
| M2 reservation lifecycle | `reserved-no-send`, `consumed-by-exact-preparation`, `closed` | M2 / SESSREC-3 §4.1 | M2 registry state | 待 Step 5 填 | `[F — planned; not created; not run]` |
| M2 canonical handle state | `prepared`; `authorized/open`; `authorized/held/not-delegated`; `released/delegated`; `released/unknown-delivery`; `cancelled` | M2 / SESSREC-3 §4.1 | private `HandleState` | 待 Step 5 填 | `[F — planned; not created; not run]` |
| M2 delegate outcome | `delegated-stream`, `delegated-error`, `known-not-delegated`, `unknown` | M2 / SESSREC-3 §4.1/§6.10 | `ReleaseDelegateOutcome` | 待 Step 5 填 | `[F — planned; not created; not run]` |
| M2 cancellation outcome | `cancelled-handle`, `no-handle-barred` | M2 / SESSREC-3 §4.1/§6.10.1 | `M2.AutomaticPreReleaseCancellationV1` | 待 Step 5 填 | `[F — planned; not created; not run]` |
| M2 reservation close reason | `prepared-and-transferred`, `mechanically-cancelled`, `abandoned`, `lost-handle-cleanup` | M2 / SESSREC-3 §4.1 | exact close callable input | 待 Step 5 填 | `[F — planned; not created; not run]` |
| M3 tool runtime state | `allocated`, `raw-durable`, `hook-running`, `final-plan-durable`, `body-running`, `body-outcome-durable`, `after-hook-running`, `settled`, `hook-failed`, `abandoned`, `interrupted`, `uncertain` | M3 / SESSREC-3 §4.8 | private `ToolInvocationState` | 待 Step 5 填 | `[F — planned; not created; not run]` |
| M1 durable tool phase consumed by M3 | `planned`, `body-outcome-durable`, `final-after-hook-settled`, `reconciled-terminal-manual-only`, `unknown-intermediate` | M1 / SESSREC-1 owner contract; SESSREC-3 §7.8.1 | `M1.ToolExecutionPhaseV1` | 待 Step 5 填 | `[F — planned; not created; not run]` |
| M3 body outcome | `completed`, `error`, `interrupted`, `uncertain` | M3 / SESSREC-3 §4.0/§7.6 | private `BodyOutcome` | 待 Step 5 填 | `[F — planned; not created; not run]` |
| M3 final tool plan | `execute`, `replacement`, `short-circuit`, `reject` | M3 / SESSREC-3 §4.0/§7.4 | private `FinalToolPlan` | 待 Step 5 填 | `[F — planned; not created; not run]` |
| M3 drain trigger | `retry-transition`, `normal-eof`, `canonical-incomplete`, `interrupt`, `transport-error`, `reentry-settlement` | M3 / SESSREC-3 §7.9 | exact callable input union | 待 Step 5 填 | `[F — planned; not created; not run]` |
| M3 terminal trigger state | `open`, `normal-eof`, `canonical-incomplete`, `interrupt`, `transport-error`, `closed` | M3 / SESSREC-3 §4.0 | settlement terminal trigger | 待 Step 5 填 | `[F — planned; not created; not run]` |
| M3 terminal decision | `normal-settled`, `incomplete`, `evidence-inconsistent`, `orthogonal-stop` | M3 / SESSREC-3 §4.0/§7.10 | private `TerminalDecision` | 待 Step 5 填 | `[F — planned; not created; not run]` |
| M3 restart result | `reconciled`, `already-terminal`, `cancelled-before-allocation`, `fatal-stop` | M3 / SESSREC-3 §4.8/§7.8.1 | `M3.RestartToolReconciliationResultV1` | 待 Step 5 填 | `[F — planned; not created; not run]` |
| M5 candidate selection | `automatic`, `manual`; manual authority kind `manual-only`, `planning-failure` | M5 / SESSREC-3 §4.0/§8.1 | private `CandidateSelection` | 待 Step 5 填 | `[F — planned; not created; not run]` |
| M6 serialized submission | `model`, `no-reply`, `shell` | M6 / SESSREC-3 §4.10/§9.15 | `M6.SerializedSubmission` | 待 Step 5 填 | `[F — planned; not created; not run]` |
| M6 coordinator result | `model-final`, `user-only`, `shell-final`, `fatal-stop` | M6 / SESSREC-3 §4.10/§9.15 | `M6.CoordinatorResult` | 待 Step 5 填 | `[F — planned; not created; not run]` |
| M6 fatal handle disposition | `none`, `mechanically-cancelled-unsendable`, `released-or-unknown` | M6 / SESSREC-3 §3.1.1 | `M6.FatalRecoveryStop` | 待 Step 5 填 | `[F — planned; not created; not run]` |
| M6 policy error tag | `invalid-policy`, `missing`, `stale`, `corrupt`, `cas-conflict`, `busy`, `persistence` | M6 / SESSREC-3 §4.9 | `M6.RecoveryPolicyAuthorityError` | 待 Step 5 填 | `[F — planned; not created; not run]` |
| M6 automatic commit result | `admitted`, `replan-policy-stale`, `follow-winner`, `fatal-stop` | M6 / SESSREC-3 §4.0/§9.9 | private `AutomaticCommitResult` | 待 Step 5 填 | `[F — planned; not created; not run]` |
| M6 response-loss resolution | `committed`, `missing`, `conflict`, `partial-or-corrupt`, `persistence-fatal`, `ambiguous` | M6 / SESSREC-3 §4.0/§9.11 | private `CommitResolution<T>` | 待 Step 5 填 | `[F — planned; not created; not run]` |
| M6 re-entry decision | `attach-live-processor`, `resume-never-released`, `settle-known-no-send`, `settle-ambiguity`, `ownership-cancelled-before-reconciliation`, `fatal-authority-invalid` | M6 / SESSREC-3 §4.11/§9.12 | private `ReentryDecision` | 待 Step 5 填 | `[F — planned; not created; not run]` |
| Automatic recovery action | `safe-retry`, `continue-after-settled-tools` | M1 owner; SESSREC-3 §8–§9 | `M1.AutomaticRecoveryAction` | 待 Step 5 填 | `[F — planned; not created; not run]` |

### 3.1 Exact 24 `ManualStopReason` values

> Normative owner is M1 F23. M5 may produce lower-level causes only; it must not copy this tuple, reorder it, deduplicate it, or define a fallback. Malformed/empty/future runtime cause input maps only to `internal-classification-failure`.

| Ordinal | Exact reason | Owner/import | 实现位置 | 一致性测试 |
|---:|---|---|---|---|
| 1 | `dispatch-evidence-inconsistent` | M1 F23 | 待 Step 5 填 | `[F — planned; not created; not run]` |
| 2 | `dispatch-ambiguous` | M1 F23 | 待 Step 5 填 | `[F — planned; not created; not run]` |
| 3 | `provider-introspection-unavailable` | M1 F23 | 待 Step 5 填 | `[F — planned; not created; not run]` |
| 4 | `planned-target-unavailable` | M1 F23 | 待 Step 5 填 | `[F — planned; not created; not run]` |
| 5 | `planned-authority-unavailable` | M1 F23 | 待 Step 5 填 | `[F — planned; not created; not run]` |
| 6 | `planned-request-materialization-failed` | M1 F23 | 待 Step 5 填 | `[F — planned; not created; not run]` |
| 7 | `planned-request-digest-failed` | M1 F23 | 待 Step 5 填 | `[F — planned; not created; not run]` |
| 8 | `planned-runtime-proof-unavailable` | M1 F23 | 待 Step 5 填 | `[F — planned; not created; not run]` |
| 9 | `provider-replay-unknown` | M1 F23 | 待 Step 5 填 | `[F — planned; not created; not run]` |
| 10 | `provider-continuation-unavailable` | M1 F23 | 待 Step 5 填 | `[F — planned; not created; not run]` |
| 11 | `provider-proof-unavailable` | M1 F23 | 待 Step 5 填 | `[F — planned; not created; not run]` |
| 12 | `recovery-action-inapplicable` | M1 F23 | 待 Step 5 填 | `[F — planned; not created; not run]` |
| 13 | `local-tool-replay-unknown` | M1 F23 | 待 Step 5 填 | `[F — planned; not created; not run]` |
| 14 | `open-tool-input` | M1 F23 | 待 Step 5 填 | `[F — planned; not created; not run]` |
| 15 | `unsettled-tool` | M1 F23 | 待 Step 5 填 | `[F — planned; not created; not run]` |
| 16 | `interrupted-tool` | M1 F23 | 待 Step 5 填 | `[F — planned; not created; not run]` |
| 17 | `uncertain-tool-result` | M1 F23 | 待 Step 5 填 | `[F — planned; not created; not run]` |
| 18 | `dispatch-lowering-unverifiable` | M1 F23 | 待 Step 5 填 | `[F — planned; not created; not run]` |
| 19 | `continuation-context-unavailable` | M1 F23 | 待 Step 5 填 | `[F — planned; not created; not run]` |
| 20 | `recovery-binding-stale` | M1 F23 | 待 Step 5 填 | `[F — planned; not created; not run]` |
| 21 | `recovery-budget-exhausted` | M1 F23 | 待 Step 5 填 | `[F — planned; not created; not run]` |
| 22 | `same-process-max-step-exhausted` | M1 F23 | 待 Step 5 填 | `[F — planned; not created; not run]` |
| 23 | `superseded-by-new-user-input` | M1 F23 | 待 Step 5 填 | `[F — planned; not created; not run]` |
| 24 | `internal-classification-failure` | M1 F23 | 待 Step 5 填 | `[F — planned; not created; not run]` |

---

## 4. 流程步骤（机械化 — TypeScript `// # Step Pn:` 注释 grep）

> Step 1–3 implementation must mark the controlling TypeScript code with the exact comment prefix `// # Step Pn:`. One marker may guard a closed helper block, but every row below must have one unambiguous marker and no duplicate competing owner marker. These P numbers are this subplan's audit-marker namespace, not a renumbering of the architecture's canonical 21-step automatic spine; P1–P21 preserve that spine's order, while P22–P59 cover the remaining runtime branches and owner handoffs.

### 4.1 Automatic recovery and release spine

| 设计步骤 | Exact obligation | 来源 | 实现位置（`// # Step Pn:`） | 验证 |
|---|---|---|---|---|
| P1 | Load and validate one complete nominal `M4.DurableRecoveryAuthorityViewV1`; corrupt/partial/owner-mismatched/non-foldable/unresolved/ambiguous is fatal. | SESSREC-3 §7.11/§8.1/§9.8 | 待 Step 5 填 | pending |
| P2 | M5 selects at most one candidate and preserves the same branded automatic proof slice; manual branches do not call M7. | SESSREC-3 §8.1/§9.8 | 待 Step 5 填 | pending |
| P3 | Build the provider-neutral, plaintext-free M1 closure from the same authority/proof before any reservation, unseal, lowering, or prepare. | SESSREC-4 §5.2; SESSREC-3 §9.8 | 待 Step 5 填 | pending |
| P4 | Allocate one stable type-9 operation ID for this round. | SESSREC-3 §9.8 | 待 Step 5 填 | pending |
| P5 | Create one M2 `reserved-no-send` commitment reservation; provider preparation and audited transport hits remain zero. | SESSREC-3 §4.1/§6.3.0/§9.8 | 待 Step 5 填 | pending |
| P6 | Construct exact lease keys and acquire K7 live leases before any unseal, lowering, or actual preparation; zero refs means exact `[]`. | SESSREC-2 K7; SESSREC-3 §9.8 | 待 Step 5 填 | pending |
| P7 | Reconstruct/lower in nested K3 scopes from M1 replay carriers only; no Legacy/cache/digest inversion/tool execution; plaintext cannot escape. | SESSREC-4 §5.2.1/§5.5 | 待 Step 5 填 | pending |
| P8 | Call the unique M2 `prepareDispatch` exactly once with exactly nine fields: `candidate`, `context`, `operationID`, `snapshotProof`, `closure`, `sealedUseLeases`, `reservation`, `lowered`, `runtimeInput`. | SESSREC-3 §6.3.1; SESSREC-4 §4.2 | 待 Step 5 填 | pending |
| P9 | Consume the same reservation exactly once and perform exactly one actual paused provider preparation; no replacement/fallback/hidden retry/second slot/second native compile/old-handle recreation. | SESSREC-3 §4.1/§6.3.1/§9.8 | 待 Step 5 填 | pending |
| P10 | Produce the original `M2.M2InspectionResult` on the same final object; no caller-supplied replacement target/body. | SESSREC-3 §4.0/§6.6/§6.7.1 | 待 Step 5 填 | pending |
| P11 | M7 validates the same candidate/inspection object and only then applies exact Anthropic/OpenAI provider-specific allowlists. | SESSREC-4 §5.3–§5.4 | 待 Step 5 填 | pending |
| P12 | M5 final-classifies the same authority/proof/closure/reservation/lease/planned/admission facts; inspection success alone does not authorize automatic recovery. | SESSREC-3 §8.2–§8.3/§9.8 | 待 Step 5 填 | pending |
| P13 | O8 first application validates K8 in the writer transaction before the raw cursor and returns a complete type-9 operation result; exact replay validates historical binding. | SESSREC-2 O8/K8; SESSREC-3 §9.9 | 待 Step 5 填 | pending |
| P14 | Immediately after the complete result, while the same handle is still `prepared`, run distinct pre-release K8 on the same result/commitment/live lease objects. | SESSREC-2 K8; SESSREC-3 §9.9 | 待 Step 5 填 | pending |
| P15 | Only pre-release K8 success may call M1 F27 and M2 exact authorization, transitioning the same handle/reservation to `authorized/open`. | SESSREC-1 F27; SESSREC-3 §6.9/§9.9 | 待 Step 5 填 | pending |
| P16 | Acquire the exclusive release latch: canonical state remains `authorized/held/not-delegated` during local validation; concurrent cancel/second release is rejected. | SESSREC-3 §4.1/§6.10 | 待 Step 5 填 | pending |
| P17 | The exact delegate boundary alone atomically records `released/delegated`; uncertain crossing records terminal `released/unknown-delivery` with `resendAllowed:false`. | SESSREC-3 §4.1/§6.10/§6.13 | 待 Step 5 填 | pending |
| P18 | Close and zeroize the exact leases with K9 using the owner-known release/cancel/abandon/lost-handle disposition; K9 failure is fatal before cleanup/lookup/replan. | SESSREC-2 K9; SESSREC-3 §9.8–§9.10 | 待 Step 5 填 | pending |
| P19 | Cleanup the exact M2 object/registry only after K9 success; retain at most a secret-free one-shot ManualStop tombstone when needed. | SESSREC-3 §6.11.1/§9.9–§9.10 | 待 Step 5 填 | pending |
| P20 | Only delegated + successful K9 creates the child’s empty attempt, then allocates ordinal 0 exactly once. Unknown delivery creates no attempt/settlement/consumption. | SESSREC-3 §9.6/§9.9 | 待 Step 5 填 | pending |
| P21 | Consume stream/events only after P20; child incomplete returns a new whole M4 authority view and re-enters with fresh policy/candidate/operation/reservation/leases. | SESSREC-3 §7.12/§9.8 | 待 Step 5 填 | pending |

### 4.2 Automatic failure, cancellation barrier, ManualStop and winner resolution

| 设计步骤 | Exact obligation | 来源 | 实现位置（`// # Step Pn:`） | 验证 |
|---|---|---|---|---|
| P22 | On every automatic pre-delegate failure, cancel the exact live prepared/authorized-open handle; if the same owner already cancelled it, reconstruct the byte-equivalent proof without a second CAS; if no handle materialized, atomically bar future reservation consumption, advance registry generation, and prove no handle. | SESSREC-3 §6.10.1/§9.8 | 待 Step 5 填 | pending |
| P23 | After P22, K9-close/zeroize the exact acquired lease set; K9 failure stops before cleanup, A5, S2, S1, replan, or ManualStop. | SESSREC-3 §9.8–§9.10 | 待 Step 5 填 | pending |
| P24 | After K9 success, cleanup exact runtime resources; preserve only a one-shot cancellation-proof tombstone with zero secret bytes when a later type-8 commit may need it. | SESSREC-3 §6.11.1/§9.10 | 待 Step 5 填 | pending |
| P25 | Resolve an automatic commit ambiguity with A5 using the full aggregate-scoped key, exact expected input, payload digest, and receipt kind; never use operation-ID-only lookup and never release/resubmit the cancelled handle. | SESSREC-2 A5; SESSREC-3 §9.9/§9.11 | 待 Step 5 填 | pending |
| P26 | If A5 returns the exact complete type-9 result, follow/re-enter the committed child winner; if genuinely absent, call S2 with the losing expected recovery head. | SESSREC-2 S2; SESSREC-3 §9.9 | 待 Step 5 填 | pending |
| P27 | Follow any complete S2 manual/automatic/superseded winner. Only `unchanged` permits a fresh S1 whole-view source-binding check. | SESSREC-2 S1/S2; SESSREC-3 §9.9 | 待 Step 5 填 | pending |
| P28 | A failed/unknown automatic commit may enter an independent ManualStop only when A5 proves absence, S2 proves unchanged/no winner, fresh S1 proves the same source binding, and an eligible M5/F23 cause existed before the commit failure. The failure itself creates no cause. | SESSREC-3 §9.9–§9.10 | 待 Step 5 填 | pending |
| P29 | Rebuild/validate the manual binding and F23 reason set; validate exact no-handle or tombstone-backed cancellation proof; no live lease may enter type-8 commit. | SESSREC-1 F23; SESSREC-3 §9.10 | 待 Step 5 填 | pending |
| P30 | Commit type 8 and accept only a complete `OperationCommitResultV1<"decision-finalized">` or exact A5 replay; detached receipt/persistence failure does not establish ManualStop. | SESSREC-2 O7/A5; SESSREC-3 §9.10 | 待 Step 5 填 | pending |
| P31 | Resolve type-8 result before invalidating the one-shot tombstone; every success, winner, replan, and fatal exit invalidates it. | SESSREC-3 §6.11.1/§9.10 | 待 Step 5 填 | pending |

### 4.3 Durable-before-execute tool and O3a flow

| 设计步骤 | Exact obligation | 来源 | 实现位置（`// # Step Pn:`） | 验证 |
|---|---|---|---|---|
| P32 | Materialize the raw invocation and commit the durable raw fence before hooks, permission, MCP, body, or capture side effects. | SESSREC-3 §7.1–§7.3 | 待 Step 5 填 | pending |
| P33 | Run the before hook at most once after raw durability; hook failure settles an error and body calls remain zero. | SESSREC-3 §7.2 | 待 Step 5 填 | pending |
| P34 | Materialize one exact final plan and durably commit phase `planned` before executing any selected body. | SESSREC-3 §7.4–§7.5 | 待 Step 5 填 | pending |
| P35 | Execute original/replacement body at most once, or zero times for short-circuit/reject; never recurse through the gate. | SESSREC-3 §7.6 | 待 Step 5 填 | pending |
| P36 | Durably commit `body-outcome-durable`; commit failure never reruns the body or treats the outcome as trusted final. | SESSREC-3 §7.6.1 | 待 Step 5 填 | pending |
| P37 | Run the after hook at most once, then durably commit `final-after-hook-settled` before resolving Deferred or terminal classification. | SESSREC-3 §7.7 | 待 Step 5 填 | pending |
| P38 | On restart, accept only latest `planned`, `body-outcome-durable`, or `unknown-intermediate` for O3a reconciliation; allocate one one-shot reconciliation identity. | SESSREC-3 §7.8.1 | 待 Step 5 填 | pending |
| P39 | O3a appends `reconciled-terminal-manual-only` exactly once, preserving only already-durable body outcome carriers; body/after-hook/provider calls are zero. | SESSREC-2 O3a; SESSREC-3 §7.8.1 | 待 Step 5 填 | pending |
| P40 | O3a may close O6 terminal barrier but permanently forbids automatic recovery; final/reconciled phases are idempotent no-op/reload. | SESSREC-2 O3a/O6; SESSREC-3 §7.8.1 | 待 Step 5 填 | pending |

### 4.4 Ordinal settlement and accepted outer retry

| 设计步骤 | Exact obligation | 来源 | 实现位置（`// # Step Pn:`） | 验证 |
|---|---|---|---|---|
| P41 | Create a fresh empty attempt after admission; allocate ordinal 0 exactly once only after complete F26/F27 authorization. | SESSREC-3 §7.0.1/§9.6–§9.7 | 待 Step 5 填 | pending |
| P42 | For each accepted outer retry, write existing retry status, wait using existing policy, and revalidate live ownership; canonical incomplete bypasses retry. | SESSREC-3 §7.12/§10 | 待 Step 5 填 | pending |
| P43 | Load/revalidate the generic M4 committed-assistant view, drain/close/freeze the previous ordinal, and only then construct fresh context and operation ID. | SESSREC-3 §7.9/§7.12/§10 | 待 Step 5 填 | pending |
| P44 | Call `prepareSubsequentDispatch` exactly once with a fresh runtime/handle; hidden SDK/native retries remain zero. | SESSREC-3 §6.3.2/§10 | 待 Step 5 填 | pending |
| P45 | Commit exact type 3 and validate/authorize with F26; prepare/record/authorize do not allocate or advance settlement state. | SESSREC-1 F26; SESSREC-3 §6.12.1/§10 | 待 Step 5 填 | pending |
| P46 | Allocate one exact fresh subsequent settlement after authorization and before release; expected ordinal is contiguous and previous is frozen. | SESSREC-3 §7.0.1/§10 | 待 Step 5 填 | pending |
| P47 | Release once and route every event only to its exact ordinal; stale/late/future/duplicate/reused evidence becomes dispatch-ledger conflict, never merge. | SESSREC-3 §7.8/§10 | 待 Step 5 填 | pending |

### 4.5 Re-entry, O10 supersession, coordinator, noReply and shell

| 设计步骤 | Exact obligation | 来源 | 实现位置（`// # Step Pn:`） | 验证 |
|---|---|---|---|---|
| P48 | Nonterminal type-1/type-2/type-9 re-entry loads `M4.CommittedAssistantAuthorityViewV1<K>`; it never accepts `M1.DurableRecoverySnapshot`. | SESSREC-2 generic loader; SESSREC-3 §9.12 | 待 Step 5 填 | pending |
| P49 | Reconcile intermediate authoritative tool phases through P38–P40 before attach/resume/lost-handle decisions; restart does not recreate old handles/reservations/leases/requests/slots/plaintext. | SESSREC-3 §9.12/§11 | 待 Step 5 填 | pending |
| P50 | Same-process nonautomatic `authorized/open` may resume once after complete result/F26. Same-process automatic may resume only while still prepared with same reservation/live leases, then fresh pre-release K8→F27/M2 authorization→immediate release→K9. | SESSREC-3 §9.12/§11 | 待 Step 5 填 | pending |
| P51 | Automatic `authorized/open` outside the original contiguous release scope is cancelled→K9→cleanup→known-no-send settlement; lost held owner/boundary uncertainty becomes fatal unknown delivery. | SESSREC-3 §9.12/§11 | 待 Step 5 填 | pending |
| P52 | Build only the minimal pre-inspection O10 model/no-reply candidate; it contains no source/control/predecessor/binding facts. | SESSREC-3 §4.10/§9.13 | 待 Step 5 填 | pending |
| P53 | First call O10 `inspect-current-authority`; unresolved source returns only branded `M4.SupersessionRequiredAuthorityV1`. Direct O9 is forbidden. | SESSREC-2 O10; SESSREC-3 §9.13 | 待 Step 5 填 | pending |
| P54 | After owner authority, build the branch-exact supersession binding/input/digest and re-enter O10 `complete-expected-input`; old recovery resolution precedes user commit. | SESSREC-2 O10; SESSREC-3 §9.13 | 待 Step 5 填 | pending |
| P55 | `SessionRunState.submitSerialized` is the sole coordinator entry; same internal ID+digest attaches/caches, while same ID+different digest conflicts/fails. | SESSREC-3 §9.15 | 待 Step 5 填 | pending |
| P56 | Model branch follows O10 winner/no-source result, then commits user, freezes fresh policy, loads initial staged authority, admits/runs the model chain, and returns `model-final` or fatal. | SESSREC-3 §9.14–§9.15 | 待 Step 5 填 | pending |
| P57 | noReply enters the same serialized queue, resolves supersession/no-source before user commit, commits user only, and has zero policy freeze/model candidate/M5/M7/M2/handle/type-1/assistant/ledger/M/authorization/release calls. | SESSREC-3 §9.15; SESSREC-4 §7.4.1 | 待 Step 5 填 | pending |
| P58 | Shell enters the same serialized queue, invokes the existing shell owner exactly once, bypasses O10/recovery/policy/M7/M2/N/M/model admission, allocates no assistant sequence, and returns `shell-final` or fatal. | SESSREC-3 §9.15; SESSREC-4 §7.4.2/§7.14 | 待 Step 5 填 | pending |
| P59 | HTTP disconnect detaches only the waiter; no transparent resend is allowed without a public idempotency key, and the internal operation ID is never exposed as one. | SESSREC-3 §9.16/§14; SESSREC-4 §8 | 待 Step 5 填 | pending |

---

## 5. 行为契约（语义，人审）

| 契约 | 来源 | 验证方式 | 一致 |
|---|---|---|---|
| M2 availability is granted only for exact audited built-in AI SDK Anthropic Messages, exact audited built-in AI SDK OpenAI Responses, or audited native HTTP JSON with provenance and a pause after all semantic transforms but before delegation. | SESSREC-3 §4.2–§4.5/§6.1–§6.8 | `[F — planned; not created; not run]` provenance/gate matrix | pending |
| Dynamic/custom/unknown middleware, factories, loaders, fetches, WebSockets, remote discovery/credential refresh, or unproved pre-provider side effects are opaque/disabled. Opaque remains compatible for initial/ordinary dispatch but automatic recovery cannot send it. | SESSREC-3 §3.1.2/§6.1–§6.4 | `[F — planned; not created; not run]` opaque compatibility and automatic rejection matrix | pending |
| A no-send reservation is not a provider handle and performs no provider preparation or transport; exact counters begin at zero. | SESSREC-3 §4.1/§6.3.0 | `[F — planned; not created; not run]` reservation counter test | pending |
| Exactly one actual preparation consumes the same reservation; no second preparation, fallback, hidden retry, second slot, second native compilation, replacement handle, or old-handle reconstruction exists. | SESSREC-3 §4.1/§6.3.1/§9.8 | `[F — planned; not created; not run]` preparation cardinality counters | pending |
| Authorization does not mean released. The canonical handle remains authorized while the exclusive latch is held and not delegated. | SESSREC-3 §4.1/§6.9–§6.10 | `[F — planned; not created; not run]` handle-state matrix | pending |
| `released/unknown-delivery` is fatal ambiguity: no cancel, same-handle resend, replacement handle, A5-driven resend, ManualStop fabrication, or source-success fallback. | SESSREC-3 §3.1.1/§4.1/§6.10/§9.9 | `[F — planned; not created; not run]` unknown-delivery prohibition matrix | pending |
| Already-cancelled automatic preparation returns/reconstructs the same byte-equivalent cancellation proof without a second CAS; no-handle branch bars future reservation consumption and proves no handle. | SESSREC-3 §6.10.1/§9.8 | `[F — planned; not created; not run]` cancellation barrier race/property test | pending |
| Tool raw commit failure produces zero later hook/body/permission/MCP side effects; final-plan commit failure produces zero body side effects; body never reruns after execution regardless of later settlement failure. | SESSREC-3 §7.1–§7.7 | `[F — planned; not created; not run]` phase-failure side-effect counters | pending |
| Only `final-after-hook-settled` is Continue-eligible. All five durable phases forbid rerunning body and after hook; O3a intermediate reconciliation is permanently manual-only. | SESSREC-3 §7.8.1/§8 | `[F — planned; not created; not run]` five-phase eligibility matrix | pending |
| Ordinal 0 is allocated once per admitted assistant; every type-3 subsequent ordinal gets one new settlement after authorization and before release. No helper implicitly allocates/advances it. | SESSREC-3 §7.0.1/§9.6/§10 | `[F — planned; not created; not run]` allocator call-count and mutation ownership test | pending |
| Generic outer retry authority is solely existing `SessionRetry.policy(...)`; canonical incomplete bypasses policy; SDK/native hidden retry count is zero. | SESSREC-3 §7.12/§10/§14.3 | `[F — planned; not created; not run]` retry predicate table | pending |
| M5 accepts only complete nominal M4 authority views and same branded proof slices; SafeRetry requires nominal truly-empty; Continue requires authoritative-only, nonempty, ordered, all-final evidence with exact source/prefix identity. | SESSREC-3 §8.1–§8.3 | `[F — planned; not created; not run]` selector/classifier nominality matrix | pending |
| Dispatch cardinality branches remain distinct: missing ledger, exact selected opaque, gap/conflict, and multiple plausible attempts. Only exactly one plausible available dispatch proceeds. | SESSREC-3 §8.1/§10 | `[F — planned; not created; not run]` four-way dispatch classification test | pending |
| M5 returns M1 lower causes only. M1 F23 alone maps, orders, deduplicates, and applies the single malformed fallback. | SESSREC-1 F23; SESSREC-3 §8 | `[F — planned; not created; not run]` cause→reason ownership test | pending |
| Default N is 2 and default configured M is 64; values are JSON-safe integers with N nonnegative and configured M positive. Effective M is normalized once by M1, including existing `agent.steps`. | SESSREC-1 policy contract; SESSREC-3 §9.1 | `[F — planned; not created; not run]` config codec/defaults/property test | pending |
| Runtime and M4 first application consume only transaction-verified committed `NormalizedRecoveryPolicy.digestInput.effectiveMaxModelAssistants`; no runtime config/`agent.steps` reread, top-level convenience access, re-min, re-clamp, or recalculation. | SESSREC-3 §9.1.3/§9.4 | `[F — planned; not created; not run]` committed-policy authority test | pending |
| N counts incomplete-triggered children only. M counts every committed model assistant, including initial, ordinary, and automatic. Shell, dispatch ordinals, model steps, and physical requests consume neither budget. | SESSREC-3 §6.2/§9.3–§9.4 | `[F — planned; not created; not run]` N/M accounting model test | pending |
| Admission predicates are exactly `candidateRecoveryOrdinal <= N` and `candidateAssistantSequence < effectiveM`; default N=2 admits ordinals 1 and 2 only. | SESSREC-3 §6.2/§9.4 | `[F — planned; not created; not run]` boundary tests N=0/1/2 and M=1/2/64 | pending |
| Every uncommitted initial, ordinary, and automatic admission freezes the current committed policy; first application revalidates it transactionally; exact replay validates historical policy and is not revoked by later policy changes. | SESSREC-3 §9.1–§9.5 | `[F — planned; not created; not run]` policy epoch/replay matrix | pending |
| A5 response-loss protocol accepts only exact complete results, uses at most two exact aggregate-scoped lookups and one same-ID/same-input/same-payload resubmission, and never uses global/operation-ID-only lookup. | SESSREC-2 A5; SESSREC-3 §9.11 | `[F — planned; not created; not run]` A5 cardinality/scope test | pending |
| Initial/ordinary/fresh no-source/O10 inspection do not construct or consume S1 snapshots. S1 is terminal-only after a complete incomplete-terminal result; generic nonterminal re-entry uses the M4 generic view. | SESSREC-2 S1/O10; SESSREC-3 §9.12–§9.15 | `[F — planned; not created; not run]` loader-call exclusion matrix | pending |
| O10 is two-stage. The caller cannot build source/control/predecessor binding until O10 returns branded required authority; direct O9 is forbidden. Only model branches can receive a model-before-prepare proof. | SESSREC-2 O10; SESSREC-3 §9.13 | `[F — planned; not created; not run]` O10 staged-binding counters | pending |
| `SessionRunState.submitSerialized` is the sole coordinator spelling. `CoordinatorResult` branch must match operation: model-final for model, user-only for noReply, shell-final for shell; fatal passes only through M8 sanitizer. | SESSREC-3 §9.15; SESSREC-4 §7.1 | `[F — planned; not created; not run]` coordinator branch matrix | pending |
| noReply commits only the user message after old recovery resolution and never enters model admission/recovery. Shell remains serialized and runs the existing shell side effect exactly once but is not a model/recovery source or Continue closure. | SESSREC-3 §9.15; SESSREC-4 §7.4.1–§7.4.2/§7.14 | `[F — planned; not created; not run]` zero-call and exactly-once shell tests | pending |
| `M6.FatalRecoveryStop` is internal. M8 maps it to the exact existing `UnknownError` message `Session recovery stopped before a safe final result`; raw cause is never read/formatted into public output. | SESSREC-4 §3.2.1 | `[F — planned; not created; not run]` fatal sanitizer exact-value test | pending |

---

## 6. 时序/状态契约（人审）

| 契约 | 来源 | 实现位置 | 验证 |
|---|---|---|---|
| Canonical handle transitions are one-way: prepared→authorized/open; prepared→cancelled; authorized/open→authorized/held/not-delegated; then delegated or unknown-delivery; known pre-delegate failure exits latch to authorized/open then cancels. | SESSREC-3 §4.1 | 待 Step 5 填 | `[F — planned; not created; not run]` state-machine transition/property test |
| Released-delegated, released-unknown-delivery, and cancelled are mutually exclusive terminal states; no terminal state transitions again. | SESSREC-3 §4.1 | 待 Step 5 填 | `[F — planned; not created; not run]` terminal-state immutability test |
| Held latch rejects concurrent cancel and concurrent second release; only the release owner may record delegated/unknown boundary. | SESSREC-3 §4.1/§13 | 待 Step 5 填 | `[F — planned; not created; not run]` concurrency interleaving test |
| Reservation is created before K7; K7 precedes K3/unseal/lowering/actual prepare; one actual prepare precedes original inspection and M7 validation. | SESSREC-3 §9.8/§13.4 | 待 Step 5 填 | `[F — planned; not created; not run]` ordered call trace |
| O8 commit-time K8 precedes raw cursor commit; complete type-9 result immediately precedes distinct pre-release K8 while handle remains prepared; F27/authorization/release follow only on success. | SESSREC-2 O8/K8; SESSREC-3 §9.9 | 待 Step 5 填 | `[F — planned; not created; not run]` ordered call trace and zero forbidden calls |
| All automatic pre-delegate failures follow cancel/no-handle barrier→K9→cleanup→post-cancel work. K9 failure prevents cleanup/A5/S2/S1/replan/ManualStop. | SESSREC-3 §9.8–§9.10/§13.4 | 待 Step 5 填 | `[F — planned; not created; not run]` failure injection matrix |
| ManualStop proof validation/commit happens before final tombstone invalidation; tombstone exists only after resource cleanup and contains zero secret bytes/reachable send closure. | SESSREC-3 §6.11.1/§9.10 | 待 Step 5 填 | `[F — planned; not created; not run]` tombstone lifecycle test |
| Raw tool durable fence precedes before hook; planned fence precedes body; body outcome fence precedes after hook; final settlement precedes Deferred/terminal classification. | SESSREC-3 §7.1–§7.7/§13.4 | 待 Step 5 填 | `[F — planned; not created; not run]` tool order trace |
| Previous dispatch ordinal drains/closes/freezes before fresh retry context preparation; type-3/F26 precede the sole next-settlement allocation, which precedes release. | SESSREC-3 §7.12/§10 | 待 Step 5 填 | `[F — planned; not created; not run]` retry order trace |
| Per-ordinal evidence never mutates another ordinal; late/future/duplicate/cross-ordinal events append conflict rather than merge. | SESSREC-3 §7.8/§10 | 待 Step 5 填 | `[F — planned; not created; not run]` event interleaving property test |
| Policy row commit happens before runtime visibility; every candidate freezes a committed snapshot; first application compares the exact expectation in the same M4 transaction. | SESSREC-3 §9.1.1–§9.2 | 待 Step 5 填 | `[F — planned; not created; not run]` publication/CAS test |
| Exact historical result/replay is independent of later policy changes, but a new uncommitted admission must freeze the new current policy. | SESSREC-3 §9.1.3/§9.2 | 待 Step 5 填 | `[F — planned; not created; not run]` historical replay test |
| A nonterminal predecessor blocks successor admission until attach/resume or durable known-no-send/ambiguity settlement establishes a terminal barrier. | SESSREC-3 §9.12/§11 | 待 Step 5 填 | `[F — planned; not created; not run]` successor barrier test |
| O3a intermediate reconciliation occurs before attach/resume/lost-handle decisions and before any incomplete terminal snapshot load. | SESSREC-3 §7.8.1/§9.12 | 待 Step 5 填 | `[F — planned; not created; not run]` restart ordering trace |
| In O10 model/noReply flows, old recovery resolution happens before user commit. An automatic winner is followed and the serialized submission is reevaluated; no lineage fork is allowed. | SESSREC-3 §9.13–§9.15 | 待 Step 5 填 | `[F — planned; not created; not run]` supersession race matrix |
| HTTP disconnect after acceptance detaches response delivery only; it does not roll back durable state, cancel the handle, commit ManualStop, or transparently resend. | SESSREC-3 §9.16/§14; SESSREC-4 §8 | 待 Step 5 填 | `[F — planned; not created; not run]` disconnect lifecycle test |
| K10 is the only dead-process lease cleanup and requires an exclusive liveness fence; no TTL, renew, reopen, heartbeat-age inference, wall-clock death inference, or old-handle revival. | SESSREC-2 K10; SESSREC-3 §11 | 待 Step 5 填 | `[F — planned; not created; not run]` dead-process cleanup matrix |

---

## 7. 不变量契约（property-based — `fast-check` or project-selected JS/TS framework）

> Every listed property remains `[F — planned; not created; not run]`. Step 5 must record the actual framework/test paths without changing the mathematical statement.

| 不变量 | 来源 | Future property test |
|---|---|---|
| For any automatic round, `reservationCount ≤ 1`, `actualProviderPreparationCount ≤ 1`, and reservation consumption is exactly once iff actual preparation materializes. | SESSREC-3 §4.1/§9.8 | `[F — planned; not created; not run]` |
| Before the exact delegate boundary, `auditedProviderTransportHitCount === 0`; after a delegated outcome, delegate count is exactly 1; after unknown delivery, resend count remains 0. | SESSREC-3 §3.1.2/§6.10 | `[F — planned; not created; not run]` |
| For every reachable handle state, exactly one canonical state is active; terminal states are mutually exclusive and absorbing. | SESSREC-3 §4.1 | `[F — planned; not created; not run]` |
| While latch is held, canonical state is authorized/not-delegated and every competing cancel/release transition is rejected. | SESSREC-3 §4.1/§13 | `[F — planned; not created; not run]` |
| A valid M2 proof’s context/generation/commitment/lease fields equal the live registry; any authorize/release/cancel/cleanup/generation change invalidates every incompatible prior proof. | SESSREC-3 §4.1 | `[F — planned; not created; not run]` |
| No-handle proof is valid iff current registry generation has zero prepared handles and no lease; first handle allocation invalidates all prior no-handle proofs. | SESSREC-3 §4.1 | `[F — planned; not created; not run]` |
| Automatic known-unsent terminal branches close every acquired K7 lease exactly once before cleanup; released/unknown never claims side-effect rollback. | SESSREC-3 §9.8–§9.10 | `[F — planned; not created; not run]` |
| For any tool invocation, raw fence precedes hook; planned fence precedes body; body call count is in `{0,1}`; once body outcome is durable, all later failures leave body call count unchanged. | SESSREC-3 §7.1–§7.7 | `[F — planned; not created; not run]` |
| For any latest intermediate tool phase reconciled by O3a, body/hook/provider call counts are 0 and the resulting latest phase is `reconciled-terminal-manual-only`; automatic eligibility is false forever. | SESSREC-3 §7.8.1 | `[F — planned; not created; not run]` |
| For every admitted assistant, ordinal keys are contiguous from 0; each key maps to a distinct settlement object; current ordinal equals the greatest published key; frozen prior objects never receive later events. | SESSREC-3 §7.0.1/§10 | `[F — planned; not created; not run]` |
| Any event whose context ordinal differs from the target settlement leaves the target unchanged and yields exact dispatch-ledger inconsistency evidence. | SESSREC-3 §7.8 | `[F — planned; not created; not run]` |
| M5 automatic result implies exactly one plausible available dispatch and the same nominal proof slice; SafeRetry iff truly-empty; Continue iff authoritative-only, nonempty, ordered, and all final-after-hook-settled. | SESSREC-3 §8 | `[F — planned; not created; not run]` |
| Compatibility-only, mixed, manual-only, reconciled, planned, body-outcome, unknown, malformed, or structural-lookalike inputs never imply automatic recovery. | SESSREC-3 §8 | `[F — planned; not created; not run]` |
| F23 output is always nonempty, deduplicated, in exact owner order, and malformed/empty/future runtime input yields exactly `["internal-classification-failure"]`. | SESSREC-1 F23 | `[F — planned; not created; not run]` |
| For all valid N/effectiveM and candidate counters, admission is equivalent to `(candidateRecoveryOrdinal <= N) && (candidateAssistantSequence < effectiveM)` for automatic, and ordinary ignores N while still enforcing M. | SESSREC-3 §6.2/§9.4 | `[F — planned; not created; not run]` |
| With default `N=2`, automatic recovery ordinals admitted are exactly `{1,2}` subject to M; default configuredM=64 is never used directly when normalized effectiveM differs due to `agent.steps`. | SESSREC-3 §6.2/§9.1 | `[F — planned; not created; not run]` |
| For any committed policy snapshot, `policyDigest === policy.policyDigest`, `defaultSemanticsVersion === policy.digestInput.defaultSemanticsVersion === 1`, and same `(scopeKey,epoch)` implies identical normalized bytes and binding fields. | SESSREC-3 §4.9 | `[F — planned; not created; not run]` |
| A5 calls are bounded by `lookupCount ≤ 2` and `resubmitCount ≤ 1`; every resubmission preserves aggregate, operation type, operation ID, expected input, payload digest, and receipt kind. | SESSREC-3 §9.11 | `[F — planned; not created; not run]` |
| A failed automatic attempt yields ManualStop only if all four prerequisites hold: A5 absent, S2 unchanged, fresh S1 same binding, and pre-existing eligible cause; otherwise outcome is winner/replan/fatal. | SESSREC-3 §9.9–§9.10 | `[F — planned; not created; not run]` |
| noReply always has zero model-policy/admission/recovery/preparation/release counters and exactly one committed user message on success. | SESSREC-3 §9.15 | `[F — planned; not created; not run]` |
| Shell has exactly one existing shell side effect on successful branch, zero N/M/model/recovery calls, and no assistant sequence allocation. | SESSREC-3 §9.15; SESSREC-4 §7.14 | `[F — planned; not created; not run]` |
| Same serialized submission ID+same digest executes at most once and attaches/caches one result; same ID+different digest never executes as the same operation. | SESSREC-3 §9.15 | `[F — planned; not created; not run]` |
| After every successful automatic terminal cleanup, retained M2/M4 secret bytes are zero; a ManualStop tombstone, if present, contains zero secret bytes and no reachable send closure. | SESSREC-3 §4.1/§9.10 | `[F — planned; not created; not run]` |

---

## 8. 性能契约（机械化 where contractual）

> The contracts define bounded work/progress conditions but no current hard wall-clock threshold. Step 0 must not invent `T_max`. Any future elapsed-time threshold requires an explicit design-contract amendment before it becomes an expectation.

| 契约 | 来源 | Future verification | 实测 |
|---|---|---|---|
| M5 selection/classification, provider constraints, proof/lease scans, map checks, and reducers perform finite passes over finite arrays/maps/lease/resource sets; no unbounded internal loop or recursion. | SESSREC-3 §7–§9/§15 | `[F — planned; not created; not run]` complexity/call-count tests | 待 Step 5 填 |
| A5 response-loss resolution has a static upper bound of 2 exact lookups + 1 exact resubmission and contains no loop. | SESSREC-3 §9.11 | `[F — planned; not created; not run]` call-count assertion | 待 Step 5 填 |
| Policy publication permits one CAS-conflict reread and no spin; DB busy handling remains the existing bounded owner contract. | SESSREC-3 §9.1.1–§9.1.2 | `[F — planned; not created; not run]` call-count assertion | 待 Step 5 填 |
| Audited AI SDK/native hidden retry count is zero; one invocation does not rotate slots on a second fetch. | SESSREC-3 §4.3–§4.5/§10 | `[F — planned; not created; not run]` hidden-retry and fetch-arrival counters | 待 Step 5 填 |
| No new general timeout, watchdog, transport deadline, queue capacity, reconnect policy, or drop policy is introduced. | SESSREC-3 §10/§14; SESSREC-4 §8 | `[F — planned; not created; not run]` configuration/diff review | 待 Step 5 填 |
| Provider/tool/stream/body progress is conditional on terminal/error/AbortSignal/runner cancellation/process termination. N/M bounds and finite admission graph do not prove external completion or unconditional termination. | SESSREC-3 §7.6/§7.9/§9.14/§14 | Step 5 semantic review; no fabricated elapsed assertion | 待 Step 5 填 |
| Serialized queue/backpressure uses existing owner capacity/Busy behavior; no new queue or drop policy is owned by this subplan. | SESSREC-3 §14.7; SESSREC-4 §8 | Step 5 owner-interface review | 待 Step 5 填 |

---

## 9. 安全/副作用契约（部分机械化）

| 契约 | 来源 | 验证（机械化/人审） |
|---|---|---|
| Raw auth headers, API keys, continuation cursors, signatures, plaintext sealed material, raw handles, receipts, authority IDs, digests, operation IDs, stack/raw causes, and lease secrets never enter logs, public wire/events, SSE, SDK state, or TUI state. | Architecture security invariants; SESSREC-3 §3.1/§4.1/§14 | `[F — planned; not created; not run]` taint/redaction tests + Step 5 review |
| `M6.FatalRecoveryStop` is never serialized, spread, stringified, pretty-printed, or raw-logged; only M8 exact sanitizer may consume it for public output. | SESSREC-3 §3.1.1/§4.10; SESSREC-4 §3.2.1 | `[F — planned; not created; not run]` sanitizer and forbidden-call scan |
| Internal `session.recovery.*` authority events never enter public EventV2/SSE/SDK/TUI surfaces; only M1 public projection/publication definitions may cross the boundary. | Architecture/detailed design; SESSREC-4 public contract | `[F — planned; not created; not run]` public-manifest/event-surface scan |
| M5 classification is pure: zero dispatch, prepare, unseal, persistence, revision allocation, mutable config read, hook/tool/provider call, or public publication. | SESSREC-3 §8 | `[F — planned; not created; not run]` effect/call graph and counter test |
| M7 plaintext-bearing candidate/messages live only within the scoped K3 continuation and are handed directly to M2 once; they are not returned to M6, cached, cloned, logged, or persisted. | SESSREC-4 §4–§5 | `[F — planned; not created; not run]` scope/escape analysis and failure injection |
| Before release, audited provider transport hits are zero. Allowed local reads/allocations/crypto/compile do not weaken the prohibition on downstream fetch/native execute/WebSocket/open/send/remote discovery/telemetry/hidden resend. | SESSREC-3 §3.1.2 | `[F — planned; not created; not run]` transport seam counters |
| Every automatic cancellation/release/abandon/lost-handle terminal path zeroizes exact M2/M4 secret/resource residue through K9 before cleanup; K9 failure deliberately preserves relation state and fails fatal. | SESSREC-3 §9.8–§9.10 | `[F — planned; not created; not run]` resource lifecycle fault matrix |
| ManualStop tombstone retains exactly zero secret bytes and no reachable send closure, is one-shot, and is invalidated after type-8 resolution or any other terminal steering. | SESSREC-3 §4.1/§9.10 | `[F — planned; not created; not run]` tombstone reachability/property test |
| Unknown delivery is never downgraded to known-unsent, success, ManualStop, or retry. Cleanup does not claim to revoke a possibly delegated provider side effect. | SESSREC-3 §3.1.1/§4.1/§9.9 | `[F — planned; not created; not run]` ambiguity fail-closed matrix |
| Tool durable fences prevent hook/body/permission/MCP side effects before their required commit; O3a restart reconciliation invokes all callbacks and provider zero times. | SESSREC-3 §7 | `[F — planned; not created; not run]` fault injection counters |
| Shell side effects occur only through the existing shell owner once; noReply has no shell/model/provider/tool side effect beyond its exact type-10/user commit path. | SESSREC-3 §9.15; SESSREC-4 §7.4.1–§7.4.2 | `[F — planned; not created; not run]` coordinator side-effect matrix |
| HTTP disconnect never triggers transparent resend, handle cancellation, durable rollback, or ManualStop. Internal operation IDs and private authority identifiers never become public idempotency keys. | SESSREC-3 §9.16/§14; SESSREC-4 §8 | `[F — planned; not created; not run]` disconnect/public-wire tests |
| This Step 0 modifies no production source or tests and creates no audit report, decisions file, schema, script, or test artifact. | User constraint / workflow §6 Step 0 | `git diff/status` scope check at completion |

---

## 10. 跨实现 / owner-interface 一致性

| 项 | Exact consistency obligation | 来源 | 验证 |
|---|---|---|---|
| M1 receipt/result ownership | M2/M3/M5/M6 import exact `M1.AuthorityReceiptV1`, `M1.ReceiptForV1<T>`, `M1.OperationCommitResultV1<T>`, operation-indexed inputs, causes, policies, digests, and proposals; no structural duplicates or local operation→receipt table. | SESSREC-1 owner contract; SESSREC-3 §4.0 | `[F — planned; not created; not run]` owner-import/duplicate-definition scan |
| F23 consistency | M5 collects causes only; M1 F23 is the only reason mapping/order/dedup/fallback implementation and exact 24-tuple owner. | SESSREC-1 F23; SESSREC-3 §8 | `[F — planned; not created; not run]` import/call ownership test |
| F26/F27 consistency | Initial/ordinary/subsequent authorize only through F26; automatic authorize only through F27 after pre-release K8 and exact complete result/planned/proposal/handle binding. Detached receipts never authorize. | SESSREC-1 F26/F27; SESSREC-3 §6.9/§9.5/§9.9 | `[F — planned; not created; not run]` authorization branch/call-count test |
| M2↔M4 proof consistency | M4 borrows M2 nominal proofs through M2 validators and never inspects/copies proof fields or brands. M2 does not own durable lease authority. | SESSREC-2 owner contract; SESSREC-3 §4.1 | `[F — planned; not created; not run]` structural-copy and validator-use scan |
| M2↔M7 prepare consistency | The single actual private M2 prepare declaration has exactly nine owner-qualified fields and directly uses `M7.LoweredRecoveryCandidate`; no abbreviated or second complete signature exists. | SESSREC-4 §4.2; SESSREC-3 §6.3.1 | `[F — planned; not created; not run]` TypeScript signature/AST check |
| M2↔M7 same-object consistency | The exact lowered candidate/proof/closure/lease objects/reservation and original inspection remain identity-consistent; provider-specific validation runs only after original inspection and cannot trigger second unseal/prepare. | SESSREC-4 §4–§5 | `[F — planned; not created; not run]` identity and call-order tests |
| M3↔M4 tool evidence consistency | Tool/reasoning commits use exact M1 operation mappings and M4 owner callables; O3a is append-only and callback-free; S1 is not used during nonterminal event/tool processing. | SESSREC-2 O3a; SESSREC-3 §7 | `[F — planned; not created; not run]` signature and call graph audit |
| M3↔M4 terminal consistency | A complete type-7 result precedes S1; M3 returns the whole nominal M4 view without unwrapping/rebranding; generic loader and terminal S1 remain mutually exclusive. | SESSREC-2 S1; SESSREC-3 §7.11/§9.12 | `[F — planned; not created; not run]` loader/result sequencing test |
| M4↔M6 policy consistency | M6 expectation is the exact M1 binding; M4 operations 1/2/9 first-apply read the committed policy in transaction and consume only committed effectiveM; exact replay does not reread current policy. | SESSREC-2 policy integration; SESSREC-3 §4.9/§9.1.3 | `[F — planned; not created; not run]` transaction policy seam test |
| M4 A5 consistency | All callers pass exact aggregate-scoped lookup key, complete expected input, payload digest, and receipt kind; no operation-ID-only overload or local result reconstruction exists. | SESSREC-2 A5; SESSREC-3 §9.11 | `[F — planned; not created; not run]` signature/usage audit |
| M4 S1/S2 consistency | S2 consumes losing expected recovery head and returns the closed winner union; S1 is terminal-only and returns the whole nominal authority view. | SESSREC-2 S1/S2; SESSREC-3 §9.8–§9.13 | `[F — planned; not created; not run]` exact signature/branch test |
| M4 K7–K10 consistency | M6/M2 use exact K7–K10 callables and nominal lease objects; no local lease schema, TTL, renew, reopen, heartbeat/wall-clock cleanup, or old-generation revival. | SESSREC-2 K7–K10; SESSREC-3 §4.12/§11 | `[F — planned; not created; not run]` owner import and lifecycle tests |
| M5↔M4 nominality | M5 accepts only `M4.DurableRecoveryAuthorityViewV1` and preserves `M4.AutomaticRecoveryProofSliceV1`; plain snapshot/fold/manual structural aliases are rejected. | SESSREC-3 §8 | `[F — planned; not created; not run]` TypeScript negative compile/runtime tests |
| M6↔M4 re-entry consistency | Re-entry uses `M4.loadCommittedAssistantAuthorityView<K>`/`CommittedAssistantAuthorityViewV1<K>` for nonterminal type-1/type-2/type-9; no `DurableRecoverySnapshot` overload exists. | SESSREC-2 generic loader; SESSREC-3 §9.12 | `[F — planned; not created; not run]` signature/negative test |
| M6↔M4 O10 consistency | M6 uses O10 inspect→branded authority→complete-input re-entry, never direct O9; model/no-reply pre-inspection candidate fields remain branch-exact. | SESSREC-2 O10; SESSREC-3 §9.13 | `[F — planned; not created; not run]` call graph and field-set test |
| M6↔M8 handoff consistency | M6 exports only internal `SerializedSubmission`, `CoordinatorResult`, and `FatalRecoveryStop`; M8 maps exact branch results and sanitizes fatal without treating public projection as server authority. | SESSREC-3 §4.10/§9.16; SESSREC-4 §3/§7 | `[F — planned; not created; not run]` handoff signature/public leakage test |
| noReply/shell wrapper consistency | M8 wrappers call the same `M6.SessionRunState.submitSerialized` queue; noReply yields only `user-only`, shell yields only `shell-final`, and all zero-call obligations match M6. | SESSREC-3 §9.15; SESSREC-4 §7.4.1–§7.4.2 | `[F — planned; not created; not run]` cross-owner branch matrix |
| Public fatal consistency | M8 exact sanitizer always returns existing Legacy `UnknownError` with message `Session recovery stopped before a safe final result`; malformed/private details never alter the public value. | SESSREC-4 §3.2.1 | `[F — planned; not created; not run]` exact reference vector |
| Native V2 isolation | Native V2 does not call M7/M8 and receives no new recovery endpoint/event/schema authority; only zero-leakage regression applies. | SESSREC-4 §7.15 | `[F — planned; not created; not run]` API/event/schema diff audit |

---

## 反向扩展声明

| 扩展项 | 类型 | 动机 | 向后兼容性 |
|---|---|---|---|
| 无（Step 0 不接受、推断或预授权任何实现侧反向扩展） | N/A | 实现与测试未读取；expectations 完全来自契约。若 Step 1–5 发现实现需要契约未定义的字段、行为、错误、枚举、重试、超时、public surface 或 owner alias，必须先更新 normative design contract，再同步本文件。 | 在契约先行修订前不存在“兼容扩展”；不得以 unknown-field tolerance、private helper 或 current source seam 为理由保留偏离。 |

---

## Step 5 验证记录（待填）

### 路径 A：自动检查结果

- [ ] `[F — planned; not created; not run]` 项目自备 contract-audit 自动入口已确定并记录。
- [ ] `[F — planned; not created; not run]` TypeScript `// # Step P1:` through `// # Step P59:` marker coverage and uniqueness check passes.
- [ ] `[F — planned; not created; not run]` Exact TypeScript field-set/closed-union/owner-import checks pass; no parallel M1/M4/M7 schemas or copied enum tuples exist.
- [ ] `[F — planned; not created; not run]` Exact nine-field private M2 prepare signature check passes.
- [ ] `[F — planned; not created; not run]` Shared enum/reason ownership checks pass; M1 F23 is the sole 24-reason implementation.
- [ ] `[F — planned; not created; not run]` Property-based tests in §7 pass.
- [ ] `[F — planned; not created; not run]` Call-count/order/failure-injection checks for preparation, transport, latch, K7–K10, tools, ordinals, A5, noReply, and shell pass.
- [ ] `[F — planned; not created; not run]` Security/public-surface leakage checks pass.
- [ ] `[F — planned; not created; not run]` Git diff scope check confirms only intended Step 1–3 implementation/test artifacts changed and protected unrelated modules remain unchanged.
- [ ] No hard elapsed-time assertion is added unless a normative contract amendment defines the threshold first.

**Future path-A artifacts**: planned only; no schema, script, or test file was created or run in Step 0.

### 路径 B：Subagent 独立审结果

- [ ] `[F — planned; not created; not run]` `docs/audits/sessrec-3-legacy-runtime-recovery/audit-report.md` is produced at Step 5 from contract docs + git diff, without giving the implementation-location column to the independent auditor.
- [ ] 0 critical / unresolved items.
- [ ] Every warning is fixed or explicitly decided.
- [ ] `[F — planned; not created; not run]` `docs/audits/sessrec-3-legacy-runtime-recovery/decisions.md` is created only if Step 5 warnings require decisions.

### §5.2 五维度兜底

- [ ] 一致性：implementation and tests match all owner-qualified signatures, fields, enums, ordering, branch, and evidence-boundary obligations.
- [ ] 风格：TypeScript ownership/import/comment conventions are consistent; markers use exact `// # Step Pn:` spelling.
- [ ] 正确性：state machines, CAS/latch/lease ordering, response loss, re-entry, ManualStop and supersession remain fail-closed.
- [ ] 性能：bounded work/retry contracts hold; no invented timeout/queue/retry or unsupported unconditional termination claim.
- [ ] 可维护性：M1–M8 ownership remains singular; no duplicated schemas, enums, receipt mappings, classifier logic, policy authority, or public sanitizer.

### Step 5 completion metadata

| 项 | 状态 |
|---|---|
| Step 5 date | pending |
| Implementation locations | all `待 Step 5 填` |
| Path A | pending |
| Path B | pending |
| Five-dimension review | pending |
| Future schemas | planned / not created / not run |
| Future scripts | planned / not created / not run |
| Future tests | planned / not created / not run |
| `audit-report.md` | planned / not created |
| `decisions.md` | conditional planned / not created |

---

*本 expectations 由 Workflow Step 0 于 2026-08-15 从 design owner contracts 独立抽取。当前 A/B/C/D/S 证据不证明 `[F]` future obligations 已实现、已测试或可投产。任何后续契约修改必须先更新 normative design owner 文档，再同步本表；bug 类契约修复走 `workflow.md §7`，feature 类扩展按 `workflow.md §2.3` 判定子计划边界。*
