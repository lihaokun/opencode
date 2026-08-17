# Contract Audit Expectations — `sessrec-1-contract-canonicalization`

**子计划**: `sessrec-1-contract-canonicalization`（Issue #7，M1 Shared Recovery Contracts and Canonical Semantics）
**契约 review 时间**: `2026-08-15`
**Step 0 完成时间**: `2026-08-15`
**D0 contract sync / review**: `2026-08-16；0 P0 / 0 P1`
**Step 5 验证时间**: `待 Step 5 填`

> 证据边界：本文仍未执行完整Step 5，未整体回填实现位置/一致列。M1-A已随`deb84e90a9051511db3c9ca69f52cacdaf45af2e`推送；当前M1-B F1/F2已有partial evidence：schema focused `19/19`（267 assertions）、schema typecheck、non-manifest `29/29`（289 assertions）、core focused `50/50`（93 assertions）与core typecheck通过；完整schema suite仍仅有clean D0/M1-A同样复现的`event-manifest.test.ts`既有2项失败。该evidence不证明F3–F31、recovery event set、automatic recovery、full public/private closure或Step 5通过。

---

## 1. 契约源（多文档）

| # | 文档 | 章节 | 涵盖契约维度 |
|---|---|---|---|
| 1 | `templates/contract-audit/expectations-template.md` | 全文 | 十节结构、反向扩展、Step 5 占位 |
| 2 | `docs/workflow.md` | §6.2–§6.8 | 独立抽取、机械化检查、property invariants、双验证与退出准则 |
| 3 | `docs/design/session-recovery/architecture.md` | §4–§9、§11–§12 | shared schema、三类 digest、raw authority、public/internal、全局流程与不变量 |
| 4 | `docs/design/session-recovery/detailed-design.md` | §0–§7、§8.2、§11 | exact owner/export/call graph、policy/receipt/projection 与 implementation dependency |
| 5 | `docs/design/session-recovery/subplans/sessrec-1-contract-canonicalization.md` | §1–§8 | M1 唯一 owner：schema、25-domain registry/builders、10 operations、F1–F31/F16a、codecs、receipts、projection、future tests |
| 6 | Cross-owner design contracts | 仅按 architecture/detailed-design handoff 索引 | M2–M8 必须消费 M1 exact exports；不复制其它 owner 的私有 schema |

**权威规则**：字段、枚举、builder、operation 与 callable 的 exact spelling 以 SESSREC-1 owner 文档为准。consumer 近义 alias、structural duplicate、cast 或旧名称不构成第二合同。

---

## 2. Schema 字段（机械化 — JSON Schema / exact field-set 校验）

> “字段”列给出 closed type/branch 的完整 top-level membership；nested type 按其自身行 recursive exact。未列字段为 extra-field failure；optional 只允许 omit，不允许用 `undefined` 占位。所有实现位置统一留待 Step 5 回填。

### 2.1 基础 carrier、identity、target 与 commitment

| 类型 / branch | exact 字段与类型 | 必选 | 来源 | 实现位置（待 Step 5 填） | 一致 |
|---|---|---|---|---|---|
| `ContractResult<A,E>` | success `{ok:true,value:A}`；failure `{ok:false,error:E}` | branch-exact | SESSREC-1 §3.1 | 待 Step 5 填 | 待 Step 5 验证 |
| `RecoveryContractError` | closed union：`ConfigCodecError`、`EventDefinitionError`、`RecoveryDecodeError`、`FieldSetError`、`NormalizationError`、`CanonicalizationError`、`DigestMismatchError`、`PublicProjectionViolation`；各自 `kind/issue/path` 与 branch fields exact | yes | SESSREC-1 §3.1 | 待 Step 5 填 | 待 Step 5 验证 |
| Primitive brands / IDs | mapped-key `Brand<Name>`累积nominal keys；`SafeInteger:number`；`SafeNonNegativeInt`；`SafePositiveInt`；`RecoveryChainID`、`RecoveryAssistantID`、`RecoveryDecisionID`、`RecoveryOperationID`、`RecoveryAggregateID`、`RecoveryPolicyScopeKey`、`RecoverySealedRefID:string`；scalar refinements保留SafeInteger且彼此/IDs均不可替换 | yes | SESSREC-1 §4.1.1 | 待 Step 5 填 | 待 Step 5 验证 |
| `CanonicalDigestValue` | `version:1;algorithm:"sha256";encoding:"recovery-canonical-json";value:64-lowercase-hex` | yes | SESSREC-1 §4.1.2 | 待 Step 5 填 | 待 Step 5 验证 |
| 25 commitment brands | `SemanticDigest`、`PreparedDigest`、`BindingDigest`、`OperationPayloadDigest`、`SupersessionBindingDigest`、`EventChainDigest`、`SourceFactsDigest`、`RecoverySourceVersionDigest`、`RecoveryControlTailDigest`、`RecoveryPolicyDigest`、`DispatchTargetDigest`、`SealedMaterialCommitment`、`PausedHandleCommitment`、`RecoveryClosureDigest`、`CredentialAuthorityVersionDigest`、`ProviderAuthorizationProofDigest`、`ControlPolicyDigest`、`ToolPlanDigest`、`ToolCallDigest`、`ToolResultDigest`、`ReasoningTextDigest`、`ProviderPrefixDigest`、`ProviderPrefixAncestryDigest`、`SourceAllowedEventSetDigest`、`ControlAllowedEventSetDigest` | yes；non-substitutable | SESSREC-1 §4.1.2–§4.1.3 | 待 Step 5 填 | 待 Step 5 验证 |
| `RecoveryLineage` | `chainID:RecoveryChainID;recoveryOrdinal:SafeNonNegativeInt` | yes | SESSREC-1 §4.2.1 | 待 Step 5 填 | 待 Step 5 验证 |
| `CandidateAssistantAttemptIdentity` | `authority:"candidate";value:{assistantID;assistantSequence}` + candidate brand | yes | SESSREC-1 §4.2.2 | 待 Step 5 填 | 待 Step 5 验证 |
| `CommittedAssistantAttemptIdentity` | `authority:"committed";value:{assistantID;assistantSequence};admittedByOperationID;admittedAtAggregateSequence` + committed brand | yes | SESSREC-1 §4.2.2 | 待 Step 5 填 | 待 Step 5 验证 |
| `CandidateDispatchAttemptContext` | `authority:"candidate";value:{version:1;sessionID;lineage;assistant:{assistantID;assistantSequence};dispatchOrdinal;origin;sourceAssistantID?}` + brand | branch-exact | SESSREC-1 §4.2.3 | 待 Step 5 填 | 待 Step 5 验证 |
| `CommittedDispatchAttemptContext` | candidate value fields + `authority:"committed";admittedByOperationID;admittedAtAggregateSequence` + brand | branch-exact | SESSREC-1 §4.2.3 | 待 Step 5 填 | 待 Step 5 验证 |
| `DerivedCommittedIdentityV1` | `authority:"derived-pending-commit";assistant:{assistantID;assistantSequence;admittedByOperationID;admittedAtAggregateSequence};dispatch:{DispatchAttemptValueV1 fields;admittedByOperationID;admittedAtAggregateSequence}` | yes；non-authority | SESSREC-1 §4.2.3 | 待 Step 5 填 | 待 Step 5 验证 |
| `DispatchTarget` | `version;providerID;routeID;protocol;endpoint:{scheme:"https";host;port?;path;deploymentID?;regionID?};authority:{accountID?;projectID?;tenantID?;credentialVersion};modelID;modelFamily?` | yes；authority至少一个scope | SESSREC-1 §4.3.1 | 待 Step 5 填 | 待 Step 5 验证 |
| `CredentialAuthorityVersionCommitment` | provider-ID `{version;derivation:"provider-version-id";providerVersionID;commitment}` 或 HMAC `{version;derivation:"hmac-sha256";keyID;keyVersion;commitment}` | branch-exact | SESSREC-1 §4.3.1 | 待 Step 5 填 | 待 Step 5 验证 |
| `ProviderSafetyDomain` | target 的 provider/route/protocol/endpoint/authority + `modelScope:{kind:"exact";modelID}` 或 `{kind:"family";modelFamily}` + `contractVersion` | branch-exact | SESSREC-1 §4.3.2 | 待 Step 5 填 | 待 Step 5 验证 |
| `StorageMode` | literal `"true"`、`"false"`、`"unknown"` | yes | SESSREC-1 §4.3.3 | 待 Step 5 填 | 待 Step 5 验证 |
| `SealedRecoveryMaterialRef` | `version;refID;issuer:"m4-sealed-store";purpose;scope:{sessionID;assistantID;targetDigest};materialCommitment;commitmentDerivation:"hmac-sha256";keyID;keyVersion` | yes | SESSREC-1 §4.3.4 | 待 Step 5 填 | 待 Step 5 验证 |
| `PausedHandleDescriptorV1` | `version;commitment;derivation:"hmac-sha256";keyID;keyVersion` | yes | SESSREC-1 §4.3.4 | 待 Step 5 填 | 待 Step 5 验证 |
| `SealedRecoveryUseLeaseKeyInputV1` | `version;leaseContract;ref;purpose;scope;materialCommitment;sealedGeneration;preparedHandleCommitment;source:{sessionID;aggregateID;sourceAssistantID;sourceVersionDigest;controlTailVersionDigest};action;operation:{sessionID;aggregateID;operationID;candidateContext;targetDigest}` | yes | SESSREC-1 §4.3.4 | 待 Step 5 填 | 待 Step 5 验证 |
| M4 nominal proof inputs | owner proof `{proofVersion;owner;mappingState;aggregate:{aggregateID;sessionID}}`；sealed lookup proof `{proofVersion;owner;refID;lookupState;purpose;scope;materialCommitment;keyID;keyVersion}` | yes；M4-only brand | SESSREC-1 §4.3.4/§4.9 | 待 Step 5 填 | 待 Step 5 验证 |

### 2.2 Dispatch、tool、reasoning 与 source snapshot

| 类型 / branch | exact 字段与类型 | 必选 | 来源 | 实现位置（待 Step 5 填） | 一致 |
|---|---|---|---|---|---|
| `AvailableDispatchEvidence` | `kind:"available";version;preparedDispatchKind;context;target;targetDigest;safetyDomain;storageMode;semanticDigest;preparedDigest;replayFence;capabilities;authorization;pausedHandleCommitment` | yes | SESSREC-1 §4.4.1 | 待 Step 5 填 | 待 Step 5 验证 |
| `OpaqueDispatchEvidence` | `kind:"opaque";version;context;providerID;modelID;localTools:"present"\|"absent"\|"unknown";cause;pausedHandleCommitment`；禁止 target/domain/storage/digests/replay proof | yes | SESSREC-1 §4.4.2 | 待 Step 5 填 | 待 Step 5 验证 |
| `ProviderReplayFence` | no-side-effect `{kind;contractVersion}`；attempt-idempotency `{kind;domain;material}`；durable-prefix `{kind;domain;prefix;material?}`；unknown `{kind;cause}` | branch-exact | SESSREC-1 §4.4.4 | 待 Step 5 填 | 待 Step 5 验证 |
| `ProviderCapabilitySummary` | `descriptorVersion` + required decisions `replay/localTools/serverTools/hostedTools/signedReasoning/storedReasoning/storeFalseReasoning`；每项 supported 或 typed-unavailable/unknown | yes | SESSREC-1 §4.4.4 | 待 Step 5 填 | 待 Step 5 验证 |
| `ProviderAuthorizationCommitment` | `version;descriptorID;descriptorVersion;targetDigest;storageMode;allowedAction;proofDigest` | yes | SESSREC-1 §4.4.4 | 待 Step 5 填 | 待 Step 5 验证 |
| `RecoveryReplayPayloadV1` | inline canonical-wire `{version;carrier:"inline";encoding;valueKind:"canonical-wire-value";value}`；inline text同形；sealed `{version;carrier:"sealed";encoding;valueKind;ref}` | branch-exact | SESSREC-1 §4.4.5 | 待 Step 5 填 | 待 Step 5 验证 |
| `ToolExecutionPhaseV1` | five branches；每 branch exact含 `phase/bodyState/afterHookState/automaticEligibility/rerunBody:"forbidden"/rerunAfterHook:"forbidden"` | yes | SESSREC-1 §4.4.5 | 待 Step 5 填 | 待 Step 5 验证 |
| `AuthoritativeToolEvidenceV1` | `version;authorityClass;callOrdinal;callID;name;executionKind;inputState;callObservation;settlement;interruption;providerExecuted;planRevision;phase;arguments?;terminalPayload?;finalPlanDigest?;callDigest?;resultDigest?;sourceRange` | branch-dependent | SESSREC-1 §4.4.5 | 待 Step 5 填 | 待 Step 5 验证 |
| `CompatibilityToolEvidenceV1` | `version;authorityClass:"compatibility-only";legacyPartOrdinal;callID?;name?;executionKind;inputState;callObservation;settlement;interruption;providerExecuted;phase;arguments?;terminalPayload?;causes` | branch-dependent | SESSREC-1 §4.4.5 | 待 Step 5 填 | 待 Step 5 验证 |
| `CanonicalToolEvidencePartitionV1` | truly-empty = both empty；authoritative-only = auth nonempty/compat empty；compatibility-only inverse；mixed = both nonempty | branch-exact | SESSREC-1 §4.4.5 | 待 Step 5 填 | 待 Step 5 验证 |
| `ReasoningEvidence` | `version;blockID;provenance;continuationMode;protocol;targetDigest;content?;textDigest?;stateRefs;publicMetadata;sourceRange` | branch-dependent | SESSREC-1 §4.4.6 | 待 Step 5 填 | 待 Step 5 验证 |
| `RecoveryEventDefinitionSetV1` | `eventTypeSetVersion;fieldSetRegistryVersion;definitions;fieldSets;sourceEntries;controlEntries`；schema-owned exact frozen raw set；禁止digest fields | yes | SESSREC-1 §4.5.1/F3 | 待 Step 5 填 | 待 Step 5 验证 |
| `RecoveryEventRegistryV1` | raw definition-set fields + exact `sourceAllowedEventSetDigest;controlAllowedEventSetDigest`；LLM E1唯一enrichment owner | yes | SESSREC-1 §4.5.1/E1 | 待 Step 5 填 | 待 Step 5 验证 |
| Public event carriers | public definition/durable definition/committed event；cursor `{version;aggregateID;sequence}`；four coarse read errors；listener/unsubscribe/subscription；public/public-durable manifests；`PublicEventServiceV1` exact methods | branch-exact | SESSREC-1 §4.5.1a | 待 Step 5 填 | 待 Step 5 验证 |
| `ProviderPrefixCheckpoint` | `version;aggregateID;sessionID;sourceAssistantID;sourceHighWater;hashVersion;prefixDigest;ancestryDigest;protocol;targetDigest;content` | yes | SESSREC-1 §4.5.2 | 待 Step 5 填 | 待 Step 5 验证 |
| `RecoverySourceVersion` | `version;aggregateID;sourceAssistantID;highWater;eventChain:{hashVersion;headDigest};factsDigest;eventTypeSetVersion;fieldSetRegistryVersion;allowedEventSetDigest;fieldSets;providerPrefix?;versionDigest` | branch-dependent | SESSREC-1 §4.5.3 | 待 Step 5 填 | 待 Step 5 验证 |
| `RecoveryControlTailVersion` | `version;aggregateID;sourceAssistantID;fromExclusive;toInclusive;eventCount;previousSourceHead;tailHash;emptyTailGenesis;eventTypeSetVersion;fieldSetRegistryVersion;allowedEventSetDigest;fieldSets;versionDigest` | yes | SESSREC-1 §4.5.4 | 待 Step 5 填 | 待 Step 5 验证 |
| `TypedIncompleteTerminalFact` | `version;sessionID;assistantID;kind;publicMessageKind;terminalSeq;preTerminalFactsDigest` | yes | SESSREC-1 §4.5.5 | 待 Step 5 填 | 待 Step 5 验证 |
| `DurableRecoverySnapshot` | `version;sessionID;sourceContext;terminal;dispatches;tools;reasoning;sourceVersion;controlTailVersion;durableContinuation?;latestDecision?;consumption?;assistantPublicMapping`；禁止 current config/plan/target/handle/candidate | branch-dependent | SESSREC-1 §4.5.6 | 待 Step 5 填 | 待 Step 5 验证 |
| `RecoveryAssistantPublicMappingV1` | `version;snapshotIdentity:{sessionID;sourceAssistantID;sourceHighWater;sourceVersionDigest;controlTailVersionDigest;latestDecisionRevision?};entries:[{assistantID;publicMessageID;role}]` | yes | SESSREC-1 §4.8.1 | 待 Step 5 填 | 待 Step 5 验证 |

### 2.3 Closure、policy、proposal、receipt 与 projection

| 类型 / branch | exact 字段与类型 | 必选 | 来源 | 实现位置（待 Step 5 填） | 一致 |
|---|---|---|---|---|---|
| `RecoveryClosureDescriptor` SafeRetry | `{status:"not-needed";action:"safe-retry"}` | exact | SESSREC-1 §4.6.1 | 待 Step 5 填 | 待 Step 5 验证 |
| `RecoveryClosureDescriptor` Continue | `status:"available";action:"continue-after-settled-tools";sourceBinding;toolCalls;reasoning;providerPrefix;closureDigest`；items携reconstructible payload + owner digest | exact | SESSREC-1 §4.6.1 | 待 Step 5 填 | 待 Step 5 验证 |
| Planned descriptor available | `status:"available";version;dispatchKind:"automatic-recovery";action;context;target;targetDigest;safetyDomain;storageMode;semanticDigest;preparedDigest;replayFence;capabilities;authorization;closure;pausedHandleDescriptor` | yes | SESSREC-1 §4.6.2 | 待 Step 5 填 | 待 Step 5 验证 |
| Planned descriptor unavailable | `status:"unavailable";version;dispatchKind;action;cause;planningEvidence;handleClosure:no-handle`；禁止 target/digests/auth/closure/handle | yes | SESSREC-1 §4.6.2 | 待 Step 5 填 | 待 Step 5 验证 |
| Runtime planned wrapper | available exact `{descriptor,pausedHandle}`；unavailable exact `{descriptor}` | branch-exact | SESSREC-1 §4.6.2 | 待 Step 5 填 | 待 Step 5 验证 |
| External/internal policy input | external nested snake_case recovery leaves + `agent.steps`；internal camelCase `{maxIncompleteRecoveries?;maxModelAssistants?;agentSteps?}` | optional exact keys | SESSREC-1 §4.6.3 | 待 Step 5 填 | 待 Step 5 验证 |
| `RecoveryPolicyDigestInputV1` | `version;defaultSemanticsVersion;maxIncompleteRecoveries;configuredMaxModelAssistants;agentSteps:{kind:"absent"}\|{kind:"present";value};effectiveMaxModelAssistants` | yes | SESSREC-1 §4.6.3 | 待 Step 5 填 | 待 Step 5 验证 |
| `NormalizedRecoveryPolicy` | `version;digestInput;provenance:{version;maxIncompleteRecoveries;configuredMaxModelAssistants;agentSteps};policyDigest` | yes | SESSREC-1 §4.6.3 | 待 Step 5 填 | 待 Step 5 验证 |
| `RecoveryAdmissionPolicyBindingV1` | `scopeKey;epoch;policyDigest;defaultSemanticsVersion;controlPolicyDigest` | yes | SESSREC-1 §4.6.3 | 待 Step 5 填 | 待 Step 5 验证 |
| `AdmissionPlan` | `version;candidateContext;expectedHeads:{recoveryHead;assistantChainHead;dispatchLedgerHead;aggregateEventHead};policy;scopeKey;epoch;policyDigest;defaultSemanticsVersion;nAvailable;mAvailable;controlPolicyDigest;bindingPolicyVersion` | yes | SESSREC-1 §4.6.4 | 待 Step 5 填 | 待 Step 5 验证 |
| `RecoveryProposal` | automatic `{kind:"automatic";action;bindingDigest}`；manual `{kind:"manual-stop";action;reasons;bindingDigest}` | branch-exact | SESSREC-1 §4.7.1 | 待 Step 5 填 | 待 Step 5 验证 |
| `RecoveryDecisionRecord` | manual-finalized common + binding/reasons；automatic-consumed common + binding/child；superseded common + `SupersessionBindingDigest` + singleton reason | branch-exact | SESSREC-1 §4.7.2 | 待 Step 5 填 | 待 Step 5 验证 |
| `RecoveryOperationLookupKeyV1<T>` | `sessionID;aggregateID;operationID;expectedOperationType` | yes | SESSREC-1 §4.7.3 | 待 Step 5 填 | 待 Step 5 验证 |
| `CommittedRawOperationProofV1` | `envelopeVersion;operationID;aggregateID;aggregateSequence;operationType;fieldSetVersion;payloadDigest;previousDigest;nextDigest` | yes | SESSREC-1 §4.7.3 | 待 Step 5 填 | 待 Step 5 验证 |
| `AssistantAdmissionProofV1` | `scopeKey;epoch;policyDigest;defaultSemanticsVersion;controlPolicyDigest;effectiveMaxModelAssistants;committedAssistantCountBefore;candidateAssistantSequence;mAvailable:true` | yes | SESSREC-1 §4.7.3 | 待 Step 5 填 | 待 Step 5 验证 |
| `AuthorityReceiptV1` | available/opaque assistant admission；available/opaque subsequent dispatch；automatic recovery；source fact；decision finalized；model/no-reply superseded | branch-exact | SESSREC-1 §4.7.3 | 待 Step 5 填 | 待 Step 5 验证 |
| Automatic receipt | `receiptVersion;receiptKind; evidenceKind;operation;decision;sourceVersion;controlTailVersion;bindingDigest;childAssistant;childDispatch;preparedDispatchKind;target;targetDigest;preparedDigest;pausedHandleCommitment;admission:{...;nAvailable:true;maxIncompleteRecoveries};postHeads:{recoveryHead;assistantChainHead;dispatchLedgerHead;aggregateEventHead}` | yes | SESSREC-1 §4.7.3 | 待 Step 5 填 | 待 Step 5 验证 |
| `OperationCommitResultV1<T>` | `operation;applyMode:"first-application"\|"exact-replay";operationPostState;receipt` | yes | SESSREC-1 §4.8.3/§4.9 | 待 Step 5 填 | 待 Step 5 验证 |
| `RecoveryPublicProjectionV1` | `version;dispatchCount?;evidence?;sourceErrorPreserved?:true;child?:{displayID};outcome?`；display-only allowlist | optional | SESSREC-1 §4.7.4 | 待 Step 5 填 | 待 Step 5 验证 |
| Public projection decode | known `{status:"known";value}`；unsupported `{status:"unsupported";observedVersion}`；malformed `{status:"malformed";error}` | branch-exact | SESSREC-1 F30 | 待 Step 5 填 | 待 Step 5 验证 |

### 2.4 Operations 与 digest inputs

| 类型 / branch | exact 字段与类型 | 必选 | 来源 | 实现位置（待 Step 5 填） | 一致 |
|---|---|---|---|---|---|
| `DispatchAdmissionV1` available | `kind;preparedDispatchKind;context:CandidateDispatchAttemptContext;target;targetDigest;safetyDomain;storageMode;semanticDigest;preparedDigest;replayFence;capabilities;authorization;pausedHandleCommitment` | yes | SESSREC-1 §4.8.1 | 待 Step 5 填 | 待 Step 5 验证 |
| `DispatchAdmissionV1` opaque | `kind;context;providerID;modelID;localTools;cause;pausedHandleCommitment`；available fields forbidden | yes | SESSREC-1 §4.8.1 | 待 Step 5 填 | 待 Step 5 验证 |
| `OperationSchemaByTypeV1` | exact 10-key map；每key拥有closed predecessors/payload；1/2/9 admission，4–7 source facts，8 manual decision，9 automatic child，10 model/no-reply supersession | yes | SESSREC-1 §4.8.1 | 待 Step 5 填 | 待 Step 5 验证 |
| `RecoveryOperationInputV1<T>` | `envelopeVersion;operationID;aggregateID;operationType;fieldSetVersion;expectedPredecessors;payload` | yes | SESSREC-1 §4.8.2 | 待 Step 5 填 | 待 Step 5 验证 |
| `RecoveryOperationEnvelope<T>` | input fields + `aggregateSequence;payloadDigest;eventChain:{hashVersion;previousDigest;nextDigest}` | yes | SESSREC-1 §4.8.2 | 待 Step 5 填 | 待 Step 5 验证 |
| `SemanticDigestInputV1` | `version;target;targetDigest;storageMode;tools;providerOptions;modelOptions;generationOptions;httpOptions;system;history;body` | yes | SESSREC-1 §4.9 | 待 Step 5 填 | 待 Step 5 验证 |
| `PreparedDigestInputV1` | common `version;context;request;semanticDigest;replayFence;capabilities;authorization;pausedHandleCommitment;preparedBodyFormat;preparedBodyVersion`；initial/ordinary only common；automatic adds source/action/closure | branch-exact | SESSREC-1 §4.9 | 待 Step 5 填 | 待 Step 5 验证 |
| Automatic binding | common source/control/candidate/action/admission/heads/control policy + `kind:"automatic";target;targetDigest;semanticDigest;preparedDigest;authorization;closureDigest` | yes | SESSREC-1 §4.9 | 待 Step 5 填 | 待 Step 5 验证 |
| Manual binding | same common + `kind:"manual-stop";causes;reasons;planningEvidence;closureStatus;handleClosure`；automatic-only fields forbidden | yes | SESSREC-1 §4.9 | 待 Step 5 填 | 待 Step 5 验证 |
| Supersession binding | common source/control/submission/predecessors；model adds intended type-1 operation ID；no-reply adds `replyDisposition:"commit-user-only"` | branch-exact | SESSREC-1 §4.9 | 待 Step 5 填 | 待 Step 5 验证 |

**计划 JSON Schema 文件**：`scripts/contract_audit/schemas/sessrec-1-contract-canonicalization.schema.json` — `[F — planned; not created]`。Future schema必须覆盖recursive exact sets、closed discriminators、optional omission、forbidden fields、safe integers、25 domains与10 operations。本 Step 0 未创建 schema。

---

## 3. 枚举值（机械化 — 共享常量 import）

### 3.1 Closed literal sets

| 枚举集合 | exact 值 | 来源 | 共享常量 / type | Import 路径 | 一致性测试 |
|---|---|---|---|---|---|
| `ManualStopReason` | 按固定顺序：`dispatch-evidence-inconsistent`、`dispatch-ambiguous`、`provider-introspection-unavailable`、`planned-target-unavailable`、`planned-authority-unavailable`、`planned-request-materialization-failed`、`planned-request-digest-failed`、`planned-runtime-proof-unavailable`、`provider-replay-unknown`、`provider-continuation-unavailable`、`provider-proof-unavailable`、`recovery-action-inapplicable`、`local-tool-replay-unknown`、`open-tool-input`、`unsettled-tool`、`interrupted-tool`、`uncertain-tool-result`、`dispatch-lowering-unverifiable`、`continuation-context-unavailable`、`recovery-binding-stale`、`recovery-budget-exhausted`、`same-process-max-step-exhausted`、`superseded-by-new-user-input`、`internal-classification-failure` | SESSREC-1 §3.3 | `ManualStopReasons` / `ManualStopReason` | 计划：M1 单一 owner barrel（未创建） | 计划 `M1-T19`（未创建） |
| `RecoveryFailureCause` | exact 24 source/kind pairs；tool可有`callID?`，supersession必有`operationID`，all可有`detail?`；无reason/code | SESSREC-1 §4.8.5 | `RecoveryFailureCause` + F23 | 计划：M1 owner barrel（未创建） | 计划 `M1-T19`（未创建） |
| `RecoveryOperationType` | `initial-chain-genesis-and-dispatch`、`ordinary-assistant-and-dispatch-admitted`、`subsequent-dispatch-recorded`、`tool-evidence-recorded`、`reasoning-evidence-recorded`、`provider-prefix-recorded`、`incomplete-terminal-recorded`、`decision-finalized`、`automatic-child-admitted-and-consumed`、`source-superseded` | SESSREC-1 §4.8.1 | `RecoveryOperationType` / `OperationSchemaByTypeV1` | 计划：M1 owner barrel（未创建） | 计划 `M1-T27`（未创建） |
| `RecoveryEventType` | 上述10项分别精确加 `session.recovery.` 前缀 | SESSREC-1 §4.8.1 | registry-indexed private type | 计划：M1 event registry（未创建） | 计划 `M1-T03/T27`（未创建） |
| Publication | `public`、`internal`；省略或显式`undefined` default public；recovery explicit internal | SESSREC-1 F1–F3 | definition metadata | F1/F2：`packages/schema/src/event.ts`；recovery definitions F3仍未创建 | F1/F2 subset：`event.test.ts`/`event.types.ts`/core event tests通过；F3/F31待后续 |
| Storage | `true`、`false`、`unknown` strings | SESSREC-1 §4.3.3 | `StorageMode` | 计划：M1 shared schema（未创建） | 计划 `M1-T13` |
| Origins | `initial`、`ordinary`、`automatic-recovery` | SESSREC-1 §4.2.3/§4.4.1 | `PreparedDispatchKindV1` | 计划：M1 shared schema（未创建） | 计划 `M1-T10/T27` |
| Actions | `safe-retry`、`continue-after-settled-tools` | SESSREC-1 §4.7.1 | `AutomaticRecoveryAction` | 计划：M1 owner export（未创建） | 计划 `M1-T20/T38` |
| Tool literals | execution `local/provider/unknown`；input `open/complete/unknown`；observation `durable/not-observed/unknown`；settlement `pending/running/completed/error`；interruption `none/execution-interrupted/provider-result-missing/unknown`；provider-executed `true/false/unknown`；mode `execute-local/replace-local/short-circuit` | SESSREC-1 §4.4.5 | exact `*V1` unions | 计划：M1 owner export（未创建） | 计划 `M1-T33/T35` |
| Tool phases | `planned`、`body-outcome-durable`、`final-after-hook-settled`、`reconciled-terminal-manual-only`、`unknown-intermediate` | SESSREC-1 §4.4.5 | `ToolExecutionPhaseV1` | 计划：M1 owner export（未创建） | 计划 `M1-T35/T38` |
| Tool partitions | `truly-empty`、`authoritative-only`、`compatibility-only`、`mixed` | SESSREC-1 §4.4.5 | `CanonicalToolEvidencePartitionV1` | 计划：M1 owner export（未创建） | 计划 `M1-T34/T38` |
| Reasoning | provenance `provider-end/step-boundary-forced-flush/cleanup-forced-flush/unknown`；mode `none/signed/stored-reference/unknown` | SESSREC-1 §4.4.6 | exact V1 unions | 计划：M1 shared schema（未创建） | 计划 `M1-T33/T36` |
| Apply mode | `first-application`、`exact-replay`；仅 result indexed surface可见 | SESSREC-1 §4.8.3 | private helper；public replacement `OperationCommitResultV1<T>["applyMode"]` | 计划：M1 result export（未创建） | 计划 `M1-T29/T38` |
| Projection decode | `known`、`unsupported`、`malformed` | SESSREC-1 F30 | `RecoveryPublicProjectionDecodeResult` | 计划：M1 public codec（未创建） | 计划 `M1-T22/T32` |

### 3.2 25 canonical domains / builders

| # | domain | exact input membership | output | 唯一 builder |
|---|---|---|---|---|
| 1 | `semantic-v1` | target/storage/tools/options/system/history/body | `SemanticDigest` | `buildSemanticDigestInput` |
| 2 | `prepared-v1` | common final request/context/fence/capability/auth/handle/body；automatic adds source/action/closure | `PreparedDigest` | `buildPreparedDigestInput` |
| 3 | `binding-v1` | automatic request binding；manual causes/reasons/planning/closure/policy/heads/handle closure | `BindingDigest` | `buildBindingDigestInput` |
| 4 | `operation-payload-v1` | envelope version/type/field-set/predecessors/payload | `OperationPayloadDigest` | `buildOperationPayloadDigestInput` |
| 5 | `supersession-binding-v1` | source/control/submission/predecessors + model/no-reply branch field | `SupersessionBindingDigest` | `buildSupersessionBindingDigestInput` |
| 6 | `event-chain-v1` | aggregate genesis or operation chain fields | `EventChainDigest` | `buildEventChainDigestInput` |
| 7 | `source-facts-v1` | source assistant/high-water/registry/allowed-set/facts | `SourceFactsDigest` | `buildSourceFactsDigestInput` |
| 8 | `source-version-v1` | aggregate/source/high-water/chain/facts/registries/field sets/prefix | `RecoverySourceVersionDigest` | `buildRecoverySourceVersionDigestInput` |
| 9 | `control-tail-v1` | range/count/heads/registry/field sets | `RecoveryControlTailDigest` | `buildRecoveryControlTailDigestInput` |
| 10 | `recovery-policy-v1` | defaults/configured M/agent steps/effective M | `RecoveryPolicyDigest` | `buildRecoveryPolicyDigestInput` |
| 11 | `dispatch-target-v1` | full normalized target | `DispatchTargetDigest` | `buildDispatchTargetDigestInput` |
| 12 | `sealed-material-v1` | purpose/scope/key metadata/HMAC value; no plaintext | `SealedMaterialCommitment` | `buildSealedMaterialCommitmentInput` |
| 13 | `paused-handle-v1` | context/target/body version/key metadata/HMAC value; no raw handle | `PausedHandleCommitment` | `buildPausedHandleCommitmentInput` |
| 14 | `recovery-closure-v1` | safe-retry action or Continue source/tool/reasoning/prefix | `RecoveryClosureDigest` | `buildRecoveryClosureDigestInput` |
| 15 | `credential-authority-version-v1` | provider-version-ID or HMAC branch | `CredentialAuthorityVersionDigest` | `buildCredentialAuthorityVersionDigestInput` |
| 16 | `provider-authorization-proof-v1` | descriptor/target/storage/action/capability/replay/closure | `ProviderAuthorizationProofDigest` | `buildProviderAuthorizationProofDigestInput` |
| 17 | `control-policy-v1` | version/scopeKey/epoch/policyDigest/defaultSemanticsVersion | `ControlPolicyDigest` | `buildControlPolicyDigestInput` |
| 18 | `tool-plan-v1` | call/name/revision/mode/input projection | `ToolPlanDigest` | `buildToolPlanDigestInput` |
| 19 | `tool-call-v1` | call/name/execution/input/observation/revision/plan digest | `ToolCallDigest` | `buildToolCallDigestInput` |
| 20 | `tool-result-v1` | call/terminal settlement/no interruption/providerExecuted/result-or-error projection | `ToolResultDigest` | `buildToolResultDigestInput` |
| 21 | `reasoning-text-v1` | block/provenance/mode/protocol/target/content projection | `ReasoningTextDigest` | `buildReasoningTextDigestInput` |
| 22 | `provider-prefix-v1` | aggregate/session/source/high-water/protocol/target/prefix projection | `ProviderPrefixDigest` | `buildProviderPrefixDigestInput` |
| 23 | `provider-prefix-ancestry-v1` | genesis or extension ancestry | `ProviderPrefixAncestryDigest` | `buildProviderPrefixAncestryDigestInput` |
| 24 | `source-allowed-event-set-v1` | registry versions + exactly seven recursive source entries | `SourceAllowedEventSetDigest` | `buildSourceAllowedEventSetDigestInput` |
| 25 | `control-allowed-event-set-v1` | registry versions + exactly three recursive control entries | `ControlAllowedEventSetDigest` | `buildControlAllowedEventSetDigestInput` |

**共享 import 纪律**：25 specs/builders必须来自LLM-owned `CanonicalCommitmentRegistryV1`单一owner barrel；schema只导出raw F1–F4/F31 surfaces。禁止generic `buildCommitment(domain:string,...)`、consumer registry、cast builder、未版本化alias或隐藏第26 domain。精确物理import path仍为`[F — planned; not created]`，待实现并在Step 5回填。

---

## 4. 流程步骤（机械化 — TypeScript `// # Step Pn:` 注释 grep）

| 设计步骤 | 来源 | 计划 marker / 义务 | 实现位置（待 Step 5 填） | 验证 |
|---|---|---|---|---|
| P1 publication | F1 | `// # Step P1: normalize source-level publication metadata` | `packages/schema/src/event.ts` | 当前grep恰1处；完整Step 5仍待执行 |
| P2 partition | F2 | `// # Step P2: partition public and internal definitions exactly once` | `packages/schema/src/event.ts` | 当前grep恰1处；完整Step 5仍待执行 |
| P3 raw definitions | schema F3 | `// # Step P3: build ten internal durable recovery definitions without digest` | 待 Step 5 填 | 计划 grep（未创建） |
| P4 field sets | F4 | `// # Step P4: validate recursive exact field membership` | 待 Step 5 填 | 计划 grep（未创建） |
| P5 row decode | F5 | `// # Step P5: decode owner-qualified durable recovery row` | 待 Step 5 填 | 计划 grep（未创建） |
| P6 source/control | F6/F7 | `// # Step P6: freeze source facts and exact control tail` | 待 Step 5 填 | 计划 grep（未创建） |
| P7 old rows | F8/F14/F15 | `// # Step P7: retain legacy evidence as compatibility-only` | 待 Step 5 填 | 计划 grep（未创建） |
| P8 normalization | F9–F13/F16a | `// # Step P8: normalize exact target capability and policy inputs` | 待 Step 5 填 | 计划 grep（未创建） |
| P9 replay refs | F14–F16 | `// # Step P9: validate replay carriers sealed references and owner commitments` | 待 Step 5 填 | 计划 grep（未创建） |
| P10 input builder / registry enrichment | §4.1.3a/E1 | `// # Step P10: build one closed canonical input and enrich the exact recovery registry` | 待 Step 5 填 | 计划 registry coverage（未创建） |
| P11 encode | F17 | `// # Step P11: canonical-encode exact secret-safe input` | 待 Step 5 填 | 计划 vectors（未创建） |
| P12 digest | F21/F22 | `// # Step P12: digest or verify the matching branded commitment` | 待 Step 5 填 | 计划 vectors（未创建） |
| P13 causes | F23 | `// # Step P13: map causes to stable nonempty ManualStop reasons` | 待 Step 5 填 | 计划 `M1-T19` |
| P14 proposal/record | F24/F25 | `// # Step P14: validate branch-exact proposal and decision lifecycle` | 待 Step 5 填 | 计划 `M1-T20` |
| P15 fold | H1/H2/H3 | `// # Step P15: derive pending identity and fold exact operation post-state` | 待 Step 5 填 | 计划 `M1-T21/T29` |
| P16 receipts | F26/F27 | `// # Step P16: validate receipt against exact folded operation post-state` | 待 Step 5 填 | 计划 `M1-T21/T29` |
| P17 projection | F28/F29/F30 | `// # Step P17: project and decode display-only recovery fields` | 待 Step 5 填 | 计划 `M1-T22/T32` |
| P18 manifests | F31 | `// # Step P18: assemble public-only and trusted-private manifests` | 待 Step 5 填 | 计划 `M1-T03/T04` |

**计划自动检查入口**：`scripts/contract_audit/run_all.py sessrec-1-contract-canonicalization` — `[F — planned; not created; not run]`。Future check验证P1–P18完整、唯一且邻近相应 callable。

---

## 5. 行为契约（语义，人审）

| 契约 | 来源 | 验证方式（未来；未创建） | 一致 |
|---|---|---|---|
| M1是shared recovery schema/canonical semantics唯一owner；dependency保持 `schema ← llm ← opencode` | architecture M1；SESSREC-1 §1 | `M1-T24/T38` + import review | 待 Step 5 验证 |
| Schema F3只产owner-held frozen singleton `RecoveryEventDefinitionSetV1`且不hash/import LLM；LLM E1按top-level/member identity只接受该same set并附加两个existing allowed-set digests；F5–F7归LLM消费enriched registry；F31对E1零依赖 | SESSREC-1 §4.5.1/F3/E1/F5–F7/F31 | `M1-T03/T26/T28/T38` + dependency/import review | 待 Step 5 验证 |
| 除F12外M1 pure callable使用exact `ContractResult<A,E>`；无throwing/Effect/undefined overload | SESSREC-1 §3.1/§5.0 | F1 type fixture与97个caller boundary已通过typecheck；其余callables future | [P — F1一致；完整Step 5待验证] |
| Unknown version/event/field-set、extra authority field、owner/digest mismatch、partial/non-foldable authority fail closed | SESSREC-1 §3.2/F4–F7 | `M1-T02/T17/T18/T28` | 待 Step 5 验证 |
| Old rows only compatibility/opaque/unknown；缺providerExecuted不当false，缺provenance不当provider-end | F8/F14/F15 | `M1-T16/T33/T34` | 待 Step 5 验证 |
| Storage exact三值；undefined→unknown；null/string/number非法；unknown不等于false | F9 | `M1-T13` | 待 Step 5 验证 |
| Target/domain只按完整结构与audited contract；不得display/prefix/current config猜测 | F10–F12 | `M1-T14` | 待 Step 5 验证 |
| Raw credentials/secrets/handles不得进入canonical/public；只允许non-secret version ID或keyed HMAC/sealed ref | §4.3.1/§4.3.4 | `M1-T12/T30` | 待 Step 5 验证 |
| SafeRetry只接受truly-empty；Continue只接受authoritative-only+all final-after-hook；其它fail closed | §4.4.5/§4.6.1 | `M1-T34/T35/T36` | 待 Step 5 验证 |
| Digest不替代payload；replay carrier必须可重建并byte-equal重编码、重算owner digest | §4.4.5–§4.6.1 | `M1-T36` | 待 Step 5 验证 |
| Canonical encoding domain-separated、object-order independent、array/presence/null/scalar sensitive；只safe integer | F17 | `M1-T05/T06/T07/T26` | 待 Step 5 验证 |
| F23 compile-time exhaustive；runtime malformed/empty/future total、不throw、唯一internal singleton | F23 | `M1-T19` | 待 Step 5 验证 |
| Proposal无authority；automatic/manual binding mandatory；manual不得发明target/digests | F20/F24 | `M1-T11/T20` | 待 Step 5 验证 |
| Record lifecycle closed：manual finalized、automatic consumed+child、superseded singleton+supersession digest | §4.7.2/F25 | `M1-T20/T27` | 待 Step 5 验证 |
| Detached receipt只观察；authorization须完整`OperationCommitResultV1<T>`+exact post-state | §4.7.3/F26/F27 | `M1-T21/T29` | 待 Step 5 验证 |
| F26 only types1/2/3；F27 exclusively type9，验证original planned、proposal、historical policy、N/M、child、heads | F26/F27 | `M1-T21/T29` | 待 Step 5 验证 |
| Policy external snake_case/internal camelCase；alias/coercion/float/-0/unsafe/null拒绝，不clamp | §4.6.3/F13 | `M1-T15/T31` | 待 Step 5 验证 |
| N default2，configuredM default64；effectiveM仅normalization计算；runtime只读committed digestInput字段 | architecture §5.7；§4.6.3 | cross-owner `M1-T15/T31` | 待 Step 5 验证 |
| F28 only M4 and pure；M8 only F30/F29；unknown display omit/normalize，malformed不当absent | F28–F30 | `M1-T22/T32` | 待 Step 5 验证 |
| Public error保持既有UnknownError；projection display-only且无authority | architecture G10；§4.7.4 | wire compatibility review | 待 Step 5 验证 |

---

## 6. 时序/状态契约（人审）

| 契约 | 来源 | 实现位置 | 验证 |
|---|---|---|---|
| Candidate/derived在commit前非authority；raw+materializations+heads commit/read-back后仅M4可brand committed identity | §4.2.2–§4.2.3/H1 | 待 Step 5 填 | 计划 `M1-T29` |
| Initial model lineage sequence/ordinal=0且assistant/dispatch predecessors genesis；aggregate genesis仅首operation，post-type10引用exact post head | §4.2.3/§4.8 | 待 Step 5 填 | 计划 `M1-T27` |
| Ordinary只递增assistant sequence；incomplete child还递增recovery ordinal；dispatch ordinal连续无gap/duplicate | architecture §4.1 | 待 Step 5 填 | property test计划 |
| Source冻结0..highWater；control tail从exclusive边界开始，普通/source event混入即stale/invalid | F6/F7 | 待 Step 5 填 | `M1-T17/T18/T28` |
| Empty tail满足tailHash=emptyTailGenesis=previousSourceHead；nonempty count=toInclusive-fromExclusive | §4.5.4 | 待 Step 5 填 | property test计划 |
| Tool phase顺序planned→body-outcome→final；reconcile可追加manual-only；所有phase禁止rerun | architecture §5.2；§4.4.5 | 待 Step 5 填 | `M1-T35` |
| Continue三处prefix都存在、同源、canonical equal；missing/extra/mismatch fail closed | architecture §4.4/§5.6 | 待 Step 5 填 | `M1-T36` |
| Type10先inspection，再由branded authority构造完整binding并re-enter；model有reservation，no-reply无reservation/proof | architecture §8.6；§4.8.1 | 待 Step 5 填 | `M1-T27` + cross-owner |
| Types8–10 record只从raw payload+envelope deterministic rebuild，不从clock/runtime/projection补字段 | §4.8.1–§4.8.3 | 待 Step 5 填 | `M1-T27` |
| First apply重验current policy/heads；exact replay验证stored historical policy/post-state；current full-prefix validation独立 | §4.8.3/F26/F27/H3 | 待 Step 5 填 | `M1-T21/T31` |
| applyMode只在ephemeral result；不进receipt/raw/folded/digest/public | §4.8.3 | 待 Step 5 填 | `M1-T29/T38` |
| Public/internal必须在schema definition/source和manifest前分区；F31只消费raw F3 definitions/publication metadata；末端字符串filter只defense-in-depth | architecture §4.8；F1–F3/F31 | F1/F2与现有public manifest source partition已实现；F3/F31 private/public durable assembly仍future | [P — F1/F2 subset；M1-T03/T04/T04a其余待验证] |
| F28在M4 stable display-ID allocation之后；F28–F30不分配ID、不查表、不写DB | §4.7.4/F28–F30 | 待 Step 5 填 | `M1-T32` |
| Global automatic 21-step runtime顺序由cross-owner持有；M1仅提供exact descriptor/input/receipt validators | architecture §5.1；detailed-design §3.1 | 待 Step 5 填 | Step 5 cross-owner review |

---

## 7. 不变量契约（property-based）

> 当前F1/F2 subset复用`effect/testing`导出的FastCheck；其余future property suites仍未创建。

| 不变量 | 来源 | 未来测试 |
|---|---|---|
| Canonical bytes对object insertion order不变；对array order/presence/null/scalar/domain变化敏感 | F17 | `property_canonical_order_and_sensitivity`（计划） |
| Canonical numbers恒safe integer且非-0；float/nonfinite/unsafe拒绝 | §4.1.1/F17 | `property_only_safe_integer_numbers_encode`（计划） |
| Registry cardinality=25且domain/spec/builder/brand一一对应 | §4.1.3 | `property_registry_exact_25_bijection`（计划） |
| 每builder输出recursive exact、secret-free、fresh、pure，optional只omit | §4.1.3a | `property_builder_exact_pure_secret_free`（计划） |
| digest→verify roundtrip恒成功；domain/member变化恒失败 | F21/F22 | `property_digest_roundtrip_domain_separation`（计划） |
| Four-way tool partition对两个数组empty/nonempty笛卡尔积total/disjoint | §4.4.5 | `property_tool_partition_total_disjoint`（计划） |
| 同partition ordinal升序无duplicate；跨partition同callID保留两份 | §4.4.5 | `property_tool_partition_preserves_classes`（计划） |
| 任意phase rerunBody/rerunAfterHook恒forbidden；仅final continue-only | §4.4.5 | `property_tool_phase_never_reruns`（计划） |
| Replay carrier decode/re-encode byte-equal；trailing/duplicate/noncanonical/purpose/scope/HMAC mismatch失败 | §4.4.5–§4.6.1 | `property_replay_carrier_exact`（计划） |
| F3每次成功返回同一owner-held frozen singleton，固定10 definitions/field specs与7/3 tuples且无digest；E1拒绝structural lookalike，保留same member identity/order并只附两个existing digest brands | §4.5.1/F3/E1 | `property_raw_enriched_registry_identity`（计划） |
| Source/control sets固定7/3、互斥、并集10、brands不可互换 | §4.5.1 | `property_source_control_partition`（计划） |
| Valid raw prefix sequence连续且chain逐项衔接；gap/duplicate/different payload失败 | F5/F6/H2/H3 | `property_event_chain_exact`（计划） |
| Empty tail identity四条件恒成立 | §4.5.4 | `property_empty_control_tail_identity`（计划） |
| Nonempty tail count公式且只含operations8–10 | §4.5.4/F7 | `property_control_tail_count_membership`（计划） |
| recoveryOrdinal/assistantSequence successor arithmetic与N/M bounds恒成立 | architecture §4.1/§5.7 | `property_lineage_budget_bounds`（计划） |
| Default/explicit同值policyDigest相等而provenance不同；agentSteps presence按合同入digest | §4.6.3/F13 | `property_policy_default_equivalence`（计划） |
| F23对cause permutation/duplicates输出fixed tuple有序子序列；invalid输入internal singleton | F23 | `property_manual_stop_mapping_total_stable`（计划） |
| Closed unions无forbidden fields；manual/opaque不能携available-only fields | F20/F24–F27 | `property_branch_exact_fields`（计划） |
| 10 operation↔event↔payload.kind↔field-set一一对应 | §4.8.1–§4.8.2 | `property_operation_schema_bijection`（计划） |
| `(aggregateID,operationID)` exact replay；same key different payload/type conflict；operationID-only非法 | §4.7.3/§4.8.2 | `property_lookup_aggregate_scoped`（计划） |
| F26/F27 success iff receipt/raw/stored post-state/policy/heads/handle exact；later heads不破坏历史有效性 | F26/F27 | `property_receipt_exact_historical_state`（计划） |
| Public success只含allowlist；任意深度forbidden authority shape失败；unknown enum→unknown | F28–F30 | `property_public_zero_leakage`（计划） |
| Public/internal partition互斥完备并保持顺序；internal永无public brand | F2/F31 | F2 finite-list FastCheck + type fixture已通过；F31 carrier/service closure仍计划 |

---

## 8. 性能契约（机械化 — 不发明阈值）

> 契约未给wall-clock `T_max`、吞吐或内存上限，Step 0不得发明 `assert elapsed < T`。只抽取finite-progress/asymptotic obligations。

| 契约 | 来源 | 未来验证 | 实测 |
|---|---|---|---|
| F2/F3/E1/F6/F7/H2/H3对有限输入单调有限扫描，无无界retry/wait | §5.0–§5.1 | complexity/property counters（计划） | 待 Step 5 填 |
| F4/F17对finite acyclic tree终止；递归严格进入子值；object keys有限排序 | F4/F17 | generated finite-tree termination（计划） | 待 Step 5 填 |
| F16a固定7 capability；F23扫描causes+固定24 tuple；registry固定25 | F16a/F23/§4.1.3 | operation-count assertions（计划） | 待 Step 5 填 |
| Policy codecs最多2 nested objects/3 leaves；无I/O/retry/global scan | §4.6.3 | pure call-count test（计划） | 待 Step 5 填 |
| M1 pure functions external DB/network/store call count=0 | §3/§5 | spies/capability absence（计划） | 待 Step 5 填 |
| 数值性能硬约束 | 契约未定义 | N/A；不得创建虚构threshold | N/A（待契约变更） |

---

## 9. 安全/副作用契约（部分机械化）

| 契约 | 来源 | 验证（未来；未创建） |
|---|---|---|
| Raw credential/token/key/cursor/reasoning/tool/prefix plaintext/runtime handle不进canonical、raw、materialization、receipt、public、log/error | architecture §4.2/§4.8；SESSREC-1 §4.3–§4.4 | `M1-T12/T30/T36` + grep/human review |
| Low-entropy commitment必须HMAC-SHA-256；禁止SHA256(rawSecret)/truncation/dictionary-testable digest | §4.3.1/§4.3.4 | `M1-T30` |
| refID由M4 CSPRNG opaque生成；M1不lookup/unseal/rotate/construct M4 proof | §4.3.4/F16 | store-call=0 + forged brand rejection |
| M1 pure functions除module freeze外不dispatch/persist/publish/read current config/store/clock，不写log/cache/DB；schema F3 additionally不得hash或import LLM，E1不得bus/store/publish | architecture M1；§5 | capability-free tests + dependency review |
| `session.recovery.*`全部internal，仅raw/private replay可读；所有public channels不可表示/解码 | architecture §4.8；§4.5.1a/F31 | `M1-T03/T04/T04a`，public notifications=0 |
| Public read errors仅四coarse branches，不含authority details | §4.5.1a | schema leakage tests |
| Public projection正向allowlist；禁止authority object spread、blacklist strip继续、display ID反查 | F28/F29 | `M1-T22/T32` |
| Private durable manifest与public durable manifest nominally不可赋值 | §4.5.1a/F31 | compile test `M1-T04a` |
| Unknown/malformed authority不得用projection/history/cache/provider state/digest inversion补证 | architecture §5；§3.2 | negative integration review |
| M1 planned scope限shared schema/LLM contracts；不引入Native V2 recovery、migration或generated SDK changes | §1.1–§1.2 | Step 5 protected-scope diff review |

**计划副作用检查**：future `scripts/contract_audit/` 验证M1 pure callable无network/DB/store imports、internal recovery不进public manifests、raw-secret sentinel零命中；`[F — planned; script not created]`。

---

## 10. 跨实现一致性（机械化 — 参考向量 / owner-consumer exactness）

| 项 | 来源 | 验证 |
|---|---|---|
| 25 domains canonical bytes/SHA-256/envelope/brand在schema/llm/core bit-exact | §4.1.3/F17/F21/F22 | 计划 `recovery-canonical-registry.test.ts` vectors（未创建） |
| Prefix exact UTF-8 `opencode-session-recovery\0v1\0${domain}\0`；NUL是单byte；keys按UTF-16 code units | F17 | byte vectors（未创建） |
| V1 numeric only safe integer；无decimal/rounding/exponent/尾零；-0拒绝 | §4.1.1/F17 | cross-runtime vectors（未创建） |
| 10 operation/event/payload/field-set/post-state/receipt一一对应；schema F3 raw set与LLM E1 enriched registry membership/order exact；M4不得复制schema或重建另一registry | §4.5.1/§4.8；detailed-design owner index | `M1-T03/T26/T28/T38` + import audit（计划） |
| Type1 genesis/type10 branches/later reservation digest在M1/M4/M6 exact；no-reply无type1 reservation | architecture §5.8；§4.8.1 | operation vectors + cross-owner audit（计划） |
| M2–M8只用M1 exports；private variants通过Extract/indexed surfaces | detailed-design §2；§5.0.1 | `M1-T38` compile tests（计划） |
| Evidence/partition/phases/carriers/literals在M3 producer、M4 fold、M5 classifier、M7 lowering exact | §4.4/§6 | `M1-T33–T38` + cross-owner review（计划） |
| Policy snake_case/camelCase/default/provenance/digest/effectiveM在config/M1/M4/M6 exact | architecture §5.7；§4.6.3 | `M1-T15/T31`（计划） |
| M4 returns complete result；F26 types1/2/3，F27 type9；detached receipt/current head不能替代stored post-state | architecture §4.10/§7；F26/F27 | `M1-T21/T29` + runtime integration（计划） |
| Public brands only literal-public definitions；private reader可读internal；all public/shared/Native V2/M8只nominal public carriers | architecture §4.8；F2/F31 | F2 definition-level nominal boundary已由`event.types.ts`验证；F31 committed carrier/service/private reader仍计划 |
| Projection chain M4 stable mapping→M1 F28→wire→M1 F30→M8；pure/no allocation；malformed与unsupported分离 | detailed-design §3.8；F28–F30 | `M1-T22/T32` + M8 integration（计划） |
| Legacy public保持UnknownError；optional projection old-client compatible；internal zero leakage | architecture G10；§4.7.4 | `M1-T23` + OpenAPI/SDK regression（计划） |
| Native V2仅shared regression consumer，不创建recovery operation/event/expectations | architecture §1.3/§11；§1.2 | Step 5 scope review |

**参考向量状态**：`[F — planned; not created; not run]`。Future vectors至少覆盖25 domains、10 operations、24 causes/reasons、policy default/explicit equivalence、public known/unsupported/malformed与cross-brand rejection。

---

## 反向扩展声明

| 扩展项 | 类型 | 动机 | 向后兼容性 |
|---|---|---|---|
| 无已知反向扩展（Step 0） | N/A | 未读取生产实现，不从代码回填 | Step 5独立审计；任何新增field/domain/enum/operation/public surface在契约更新前均不一致 |
| 禁止预授权扩展 | enforcement | 防止generic domain、consumer alias、public authority event、额外operation/receipt/projection field实现先行 | 必须先走契约变更并重新同步本文 |

---

## Step 5 验证记录（待填）

### 路径 A 自动检查结果

- [ ] 计划运行 `scripts/contract_audit/run_all.py sessrec-1-contract-canonicalization`；当前 `[F — planned; script not created; not run]`。
- [ ] 计划校验 `scripts/contract_audit/schemas/sessrec-1-contract-canonicalization.schema.json`；当前 `[F — planned; schema not created; not run]`。
- [ ] 25-domain cardinality/builders/specs/brands exact。
- [ ] 10 operation/event/field-set/post-state/receipt mappings exact。
- [ ] Schema F3 owner-held singleton无digest/LLM import；LLM E1按identity exact enrichment only；F5–F7由LLM消费enriched registry；F31对E1/digest零依赖；raw/enriched membership与order exact。
- [ ] TypeScript `// # Step P1:` 至 `// # Step P18:` markers完整且唯一。
- [ ] Shared enum/union从M1 owner import，无duplicate definitions。
- [ ] Public/internal source partition与zero-leakage通过。
- [ ] M1 pure side-effect/secret checks通过。
- [ ] 性能只验证finite-progress/operation-count；无契约数值阈值。

### 路径 B Subagent 独立审结果

- [ ] 计划产出 `docs/audits/sessrec-1-contract-canonicalization/audit-report.md`；当前 `[F — planned; not created]`。
- [ ] 0 critical / unresolved；当前pending，未审。
- [ ] 警告计划记录到 `docs/audits/sessrec-1-contract-canonicalization/decisions.md`；当前 `[F — planned; not created]`。
- [ ] Reviewer仅接收契约文档 + future diff + 本表列字段，不以实现位置echo审查。

### §5.2 五维度兜底

- [ ] 一致性：pending
- [ ] 风格：pending
- [ ] 正确性：pending
- [ ] 性能：pending
- [ ] 可维护性：pending

### Step 5 回填约束

- 所有实现位置单元格当前保持 `待 Step 5 填`，仅Step 5按实际diff回填。
- 除已明确标为M1-A partial foundation evidence的两个`recovery-contract-foundation` test files外，future test/schema/script path仅为计划，不表示文件存在。
- 不得把design audit、当前50/50 A/B/C/D或S seam写成implementation/Step 5 pass。
- 若发现contract/implementation冲突，先修contract或实现并记录决策，再更新本文；禁止从代码反向改写expectation掩盖偏差。

---

*本 expectations 由 Step 0 从契约文档独立抽取；D0行仅在owner设计合同先修正后同步。当前只记录M1-A foundation的行政状态与真实partial test evidence，不回填Step 5实现位置/一致结论。后续contract修改必须先改契约文档，再同步本表。Bug类契约修复走 `workflow.md §7`；feature类扩展按 `workflow.md §2.3` 判定。*
