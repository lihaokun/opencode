# Contract Audit Expectations — `sessrec-4-legacy-lowering-public-contract`

**子计划**: `sessrec-4-legacy-lowering-public-contract`
**契约 review 时间**: `2026-08-15`
**Step 0 完成时间**: `2026-08-15`
**Step 5 验证时间**: `待 Step 5 填`

> 本文件是 Workflow Step 0 产物，仅从合同文档独立抽取；未读取 production source 或 tests。除本文件外，本轮不创建 implementation、tests、schema、scripts、migration、codegen、`audit-report.md` 或 `decisions.md`。

---

## 1. 契约源（多文档）

| # | 文档 | 章节 | 涵盖契约维度 |
|---:|---|---|---|
| 1 | `docs/workflow.md` | §6 | Step 0 十节结构、独立抽取、property-based、流程 marker、Step 5 双验证 |
| 2 | `templates/contract-audit/expectations-template.md` | 全文 | 固定十节、反向扩展声明、Step 5 占位 |
| 3 | `docs/design/session-recovery/architecture.md` | §1–§9、§12、Appendix A | Legacy scope、M7/M8目标、provider/public/temporal/security/performance boundary |
| 4 | `docs/design/session-recovery/detailed-design.md` | §0–§8、§10–§12 | owner/export/call graph、automatic ordering、projection/event/public wrapper handoff |
| 5 | `docs/design/session-recovery/subplans/sessrec-4-legacy-lowering-public-contract.md` | §1、§3–§12 | M7 exact lowering与M8 public/CLI/TUI/HTTP contracts |
| 6 | `docs/design/session-recovery/subplans/sessrec-1-contract-canonicalization.md` | §4.5.1a、§4.7.4、F28–F31 | public projection exact字段、F30三分支、nominal public event carriers |
| 7 | `docs/design/session-recovery/subplans/sessrec-2-durable-authority.md` | §9.3–§9.3.1 | K3/K7/K8/K9 exact lease与zeroization合同 |
| 8 | `docs/design/session-recovery/subplans/sessrec-3-legacy-runtime-recovery.md` | M2 types、§6.3.1、§9.15–§9.16 | reservation、exact nine-field prepare、serialized model/no-reply/shell handoff |

### 1.1 唯一 owner 与范围

| 领域 | 唯一 owner | 本子计划拥有 | 禁止越界 |
|---|---|---|---|
| M7 | SESSREC-4 | `M7.LoweredRecoveryCandidate`、SafeRetry exclusion、Continue scoped reconstruction、same-object validation | 不拥有M1 schema、M4 authority/leases、M5 classification、M2 handle lifecycle、M6 ordering |
| M8 | SESSREC-4 | public wrappers、projection decode/adapt、sanitizer、HTTP/SDK/CLI/TUI UX | 不读M4 raw authority，不分配display ID，不新增public recovery authority |
| Shared schema | SESSREC-1 | 直接import exact exported/indexed surfaces | 不创建structural alias、第二套enum/decoder/projector |
| Authority/lease | SESSREC-2 | 消费exact K3/K7/K8/K9 callables | 不renew/reopen/TTL，不由M7 close lease |
| Runtime/coordinator | SESSREC-3 | exact nine-field M2 handoff、M6 serialized result | 不写四字段“complete signature”，M8不得旁路queue |

### 1.2 A/B/C/D/S/F 证据边界

| 等级 | 当前证据 | 不得外推 |
|---|---|---|
| A | 10个Legacy CLI scoped checks | automatic recovery、通用replay safety、TUI E2E |
| B | 1个live HTTP/generated SDK scoped check | external consumer acceptance、recovery correctness |
| C | 10项：7 prompt + 3 TCP processor | ledger、CAS、proof、未直接断言的transport性质 |
| D | 29项：2 synthetic processor + 1 retry + 22 TUI + 4 routes | future durable authorization、产品E2E |
| S | `[S — source seam only]` | 运行次数、时序、请求数、future contract已实现 |
| F | `[F — planned; not created; not run]` | 不得写成已创建、已运行、已通过 |

当前边界保持 `A=10 B=1 C=10(7+3) D=29(2+1+22+4)=50`。S不计入50；本文件全部implementation/tests/schema/scripts/codegen/Step 5结果属于F。Step 5不得用A/B/C/D或S替代F验证。

---

## 2. Schema 字段（机械化）

### 2.1 Exact `M7.LoweredRecoveryCandidate`

| 字段名 | 类型 | 必选 | 来源 | 实现位置（待 Step 5 填） | 一致 |
|---|---|---:|---|---|---|
| `owner` | literal `"M7"` | yes | SESSREC-4 §4.1 | 待 Step 5 填 | pending |
| `action` | `M1.RecoveryClosureDescriptor["action"]` | yes | 同上 | 待 Step 5 填 | pending |
| `semanticMessages` | `readonly ModelMessage[]` | yes | 同上 | 待 Step 5 填 | pending |
| `closure` | `M1.RecoveryClosureDescriptor` | yes | 同上 | 待 Step 5 填 | pending |
| `snapshotProof` | `M4.AutomaticRecoveryProofSliceV1` | yes | 同上 | 待 Step 5 填 | pending |
| `preparedHandleCommitment` | `M1.PausedHandleCommitment` | yes | 同上 | 待 Step 5 填 | pending |
| `sealedUseLeases` | `readonly M4.SealedRecoveryUseLeaseV1[]` | yes | 同上 | 待 Step 5 填 | pending |

Exact negative field set：不得包含target、protocol、storage mode、capability choice、semantic/prepared/binding digest、raw handle、final body、receipt、raw signature、raw sealed bytes、lookup proof或public projection字段。

### 2.2 Scoped Continue reconstruction

| 字段名 | 类型 | 必选 | 来源 | 实现位置（待 Step 5 填） | 一致 |
|---|---|---:|---|---|---|
| `authority` | `M4.DurableRecoveryAuthorityViewV1` | yes | SESSREC-4 §5.2.1 | 待 Step 5 填 | pending |
| `proof` | `Extract<M4.AutomaticRecoveryProofSliceV1, { kind: "continue-eligible" }>` | yes | 同上 | 待 Step 5 填 | pending |
| `closure` | `Extract<M1.RecoveryClosureDescriptor, { status: "available" }>` | yes | 同上 | 待 Step 5 填 | pending |
| `preparedHandleCommitment` | `M1.PausedHandleCommitment` | yes | 同上 | 待 Step 5 填 | pending |
| `sealedUseLeases` | `readonly M4.SealedRecoveryUseLeaseV1[]` | yes | 同上 | 待 Step 5 填 | pending |
| `use` | `(candidate: M7.LoweredRecoveryCandidate) => Effect.Effect<A, E>` | yes | 同上 | 待 Step 5 填 | pending |

`use`是plaintext non-escape的scoped continuation；不得以返回candidate、缓存messages或第二个lowering-result wrapper取代。

### 2.3 M7 → M2 exact nine-field handoff

| # | 字段 | Exact type | 必选 | 来源 | 实现位置（待 Step 5 填） | 一致 |
|---:|---|---|---:|---|---|---|
| 1 | `candidate` | `M1.CandidateAssistantAttemptIdentity` | yes | SESSREC-3 §6.3.1；SESSREC-4 §4.2 | 待 Step 5 填 | pending |
| 2 | `context` | `M1.CandidateDispatchAttemptContext` | yes | 同上 | 待 Step 5 填 | pending |
| 3 | `operationID` | `M1.RecoveryOperationID` | yes | 同上 | 待 Step 5 填 | pending |
| 4 | `snapshotProof` | `M4.AutomaticRecoveryProofSliceV1` | yes | 同上 | 待 Step 5 填 | pending |
| 5 | `closure` | `M1.RecoveryClosureDescriptor` | yes | 同上 | 待 Step 5 填 | pending |
| 6 | `sealedUseLeases` | `readonly M4.SealedRecoveryUseLeaseV1[]` | yes | 同上 | 待 Step 5 填 | pending |
| 7 | `reservation` | `M2.PreparedHandleCommitmentReservationV1` | yes | 同上 | 待 Step 5 填 | pending |
| 8 | `lowered` | `M7.LoweredRecoveryCandidate` | yes | 同上 | 待 Step 5 填 | pending |
| 9 | `runtimeInput` | `M2.LegacyRuntimeInput` | yes | 同上 | 待 Step 5 填 | pending |

Exact return：`Effect.Effect<M1.PlannedRecoveryMaterialization<M2.AvailableDispatchHandle>, M2.M2PrepareError>`。不得把四字段摘录、optional字段、object-spread补参或从`lowered`反推其它owner facts写成完整接口。

### 2.4 Public projection allowlist

| 字段 | 类型 | 必选 | 来源 | 实现位置（待 Step 5 填） | 一致 |
|---|---|---:|---|---|---|
| `version` | literal `1` | yes | SESSREC-1 §4.7.4 | 待 Step 5 填 | pending |
| `dispatchCount` | `SafeNonNegativeInt` | no | 同上 | 待 Step 5 填 | pending |
| `evidence` | `available`, `opaque`, `mixed`, `unknown` | no | 同上 | 待 Step 5 填 | pending |
| `sourceErrorPreserved` | literal `true` | no | 同上 | 待 Step 5 填 | pending |
| `child.displayID` | `M1.RecoveryChildDisplayID` | no | 同上 | 待 Step 5 填 | pending |
| `outcome` | `safe-retry`, `continue-after-settled-tools`, `manual-stop`, `unknown` | no | 同上 | 待 Step 5 填 | pending |

Forbidden public fields：state、pending/succeeded/failed、effective/final assistant、authority child ID、target、protocol/storage、digest、proof、operationID、decisionID/revision、CAS/head、receipt、sealed ref、ledger ordinal、tool/reasoning metadata。

### 2.5 Public error、event与CLI wire

| Schema | Exact fields | 来源 | 实现位置（待 Step 5 填） | 一致 |
|---|---|---|---|---|
| Incomplete public error | `{ name: "UnknownError", data: { message: <exact literal>, ref?: <existing schema only> } }` | SESSREC-4 §3.2 | 待 Step 5 填 | pending |
| Fatal sanitizer | `{ name: "UnknownError", data: { message: "Session recovery stopped before a safe final result" } }` | SESSREC-4 §3.2.1 | 待 Step 5 填 | pending |
| Public subscription item | `M1.PublicCommittedEventV1<D>` from `M1.PublicEventSubscriptionV1<D>` | SESSREC-1 §4.5.1a | 待 Step 5 填 | pending |
| Attempt frame | `{ type: "attempt", assistantID, sourceAssistantID, attempt, payload }` | SESSREC-4 §7.8.1 | 待 Step 5 填 | pending |
| Final frame | `{ type: "final-effective-result", assistantID, sourceAssistantID, result }` | 同上 | 待 Step 5 填 | pending |
| Reducer result | `{ state: M8.LegacyRunCompletionState, wakeHydrator: boolean }` | SESSREC-4 §3.3/§7.7 | 待 Step 5 填 | pending |

**JSON Schema 文件**：本Step 0不创建schema。任何后续schema均为`[F — planned; not created; not run]`，必须从owner合同生成，不得从实现反推。

---

## 3. 枚举值（机械化 — 共享 owner import）

| 枚举 / union | Exact values | 共享 owner | Import 路径 | 一致性测试 |
|---|---|---|---|---|
| Recovery action | `safe-retry`, `continue-after-settled-tools` | `M1.RecoveryClosureDescriptor["action"]` | 待 Step 5 填 | `[F — planned; not created; not run]` |
| Proof kind | `safe-retry-eligible`, `continue-eligible` | `M4.AutomaticRecoveryProofSliceV1` | 待 Step 5 填 | 同上 |
| Tool partition | `truly-empty`, `authoritative-only`, `compatibility-only`, `mixed` | `M1.CanonicalToolEvidencePartitionV1` | 待 Step 5 填 | 同上 |
| Tool phase | `planned`, `body-outcome-durable`, `final-after-hook-settled`, `reconciled-terminal-manual-only`, `unknown-intermediate` | `M1.ToolExecutionPhaseV1` | 待 Step 5 填 | 同上 |
| F30 status | `known`, `unsupported`, `malformed` | `M1.RecoveryPublicProjectionDecodeResult["status"]` | 待 Step 5 填 | 同上 |
| Provider/storage | Anthropic Messages；OpenAI Responses `store=true`；OpenAI Responses `store=false`；其它/unknown unavailable | M7 provider constraints + M1 target/storage | 待 Step 5 填 | 同上 |
| Public message kind | `adapter-incomplete`, `clean-eof`, `empty-unknown-finish` | `M1.DurableRecoverySnapshot["terminal"]["publicMessageKind"]` | 待 Step 5 填 | 同上 |
| Coordinator result | `model-final`, `user-only`, `shell-final`, `fatal-stop` | `M6.CoordinatorResult` | 待 Step 5 填 | 同上 |
| Wrapper operation | `prompt`, `command`, `no-reply`, `shell` | M8 mapper input | 待 Step 5 填 | 同上 |
| Transport state | `connecting`, `live`, `interrupted`, `closed` | `M8.LegacyTransientTransportState` | 待 Step 5 填 | 同上 |
| K9 reason | `released`, `mechanically-cancelled`, `abandoned`, `lost-handle-cleanup` | M4 close callable | 待 Step 5 填 | 同上 |
| CLI frame type | `attempt`, `final-effective-result` | M8 CLI contract | 待 Step 5 填 | 同上 |
| Attempt role | `source`, `child` | M8 CLI contract | 待 Step 5 填 | 同上 |
| Publication | literal `public`; internal不可构造public brand | M1 F2/F31 | 待 Step 5 填 | 同上 |

实现必须直接import owner-qualified surfaces。F30 exact discriminator为`status`；consumer不得创建使用`kind`的平行结构。

---

## 4. 流程步骤（机械化 — TypeScript `// # Step Pn:`）

> TypeScript marker固定使用`// # Step Pn:`。P1–P21是automatic exact spine；P22–P29覆盖M8 public/UX flow。

| Step | Exact obligation | 来源 | 实现位置 | 验证 |
|---|---|---|---|---|
| P1 | M4 load complete nominal authority view | SESSREC-4 §6.1 | 待 Step 5 填 | `[F — planned; not created; not run]` |
| P2 | M5 select at most one action candidate | 同上 | 待 Step 5 填 | 同上 |
| P3 | Obtain same-view branded proof slice | 同上 | 待 Step 5 填 | 同上 |
| P4 | M7 build plaintext-free closure descriptor | SESSREC-4 §5.2 | 待 Step 5 填 | 同上 |
| P5 | Derive stable type-9 operation ID | detailed-design §3.1 | 待 Step 5 填 | 同上 |
| P6 | M2 reserve stable no-send commitment；prepare/hits 0 | SESSREC-3 §6.3 | 待 Step 5 填 | 同上 |
| P7 | M4 K7 before K3/unseal/lower/actual prepare | SESSREC-2 §9.3 | 待 Step 5 填 | 同上 |
| P8 | M7 K3-scoped exact reconstruction and digest recomputation | SESSREC-4 §5.2.1 | 待 Step 5 填 | 同上 |
| P9 | M2 exact nine-field prepare once, consuming same reservation | SESSREC-3 §6.3.1 | 待 Step 5 填 | 同上 |
| P10 | M2 original same-object inspection | 同上 | 待 Step 5 填 | 同上 |
| P11 | M7 same-object validation；provider allowlist only now | SESSREC-4 §5.3–§5.4 | 待 Step 5 填 | 同上 |
| P12 | M5 final classification | SESSREC-4 §6.1 | 待 Step 5 填 | 同上 |
| P13 | M4 type-9 commit-time K8 before raw/cursor commit | SESSREC-2 §9.3 | 待 Step 5 填 | 同上 |
| P14 | Complete automatic `OperationCommitResultV1` | detailed-design §3.1 | 待 Step 5 填 | 同上 |
| P15 | Immediate independent pre-release K8 while handle prepared | SESSREC-2 §9.3 | 待 Step 5 填 | 同上 |
| P16 | K8 success only: F27 + M2 authorization to `authorized/open` | SESSREC-4 §4.3 | 待 Step 5 填 | 同上 |
| P17 | Exclusive latch；delegate once；boundary-only released transition | architecture §5.1 | 待 Step 5 填 | 同上 |
| P18 | K9 close exact leases and zeroize | SESSREC-2 §9.3 | 待 Step 5 填 | 同上 |
| P19 | Delegated + K9 success only creates empty child attempt | detailed-design §3.1 | 待 Step 5 填 | 同上 |
| P20 | Allocate ordinal-0 settlement exactly once | 同上 | 待 Step 5 填 | 同上 |
| P21 | Consume stream；unknown-delivery fatal/no cancel/no resend | architecture §5.1 | 待 Step 5 填 | 同上 |
| P22 | Sync prompt/command wait full chain then shared mapper/encoder | SESSREC-4 §7.1/§7.3 | 待 Step 5 填 | 同上 |
| P23 | `prompt_async` transfer ownership then exact204/0 bytes | SESSREC-4 §7.4/§8.1 | 待 Step 5 填 | 同上 |
| P24 | noReply resolve old recovery before user-only commit | SESSREC-4 §7.4.1 | 待 Step 5 填 | 同上 |
| P25 | shell serialized, execute once, recovery/model bypass | SESSREC-4 §7.4.2/§7.14 | 待 Step 5 填 | 同上 |
| P26 | M4 mapping → F28/F29 → public field → F30 → M8 | detailed-design §3.8 | 待 Step 5 填 | 同上 |
| P27 | F2/F31 partition before public service/subscription | SESSREC-1 §4.5.1a/F31 | 待 Step 5 填 | 同上 |
| P28 | CLI freeze mode, hydrate final, frame output, resolve exit | SESSREC-4 §7.7–§7.10 | 待 Step 5 填 | 同上 |
| P29 | TUI new generation invalidates all old guards before hydration | SESSREC-4 §7.11–§7.12 | 待 Step 5 填 | 同上 |

Automatic failure suffix固定为：`mechanical cancel or no-handle barrier → K9 close/zeroize → cleanup → A5/S2/S1/replan/ManualStop/fatal`。K9 failure在cleanup/lookup前fatal；pre-release K8 failure时F27、M2 authorization、release/delegate均0。

---

## 5. 行为契约（语义，人审）

| 契约 | 来源 | Future verification | 实现位置 | 一致 |
|---|---|---|---|---|
| SafeRetry先做history identity/order uniqueness pre-pass，再用same-WAL mapping定位source；所有transform只收source-before prefix | SESSREC-4 §5.1 | `[F — planned; not created; not run]` exclusion matrix | 待 Step 5 填 | pending |
| SafeRetry排除source text/reasoning/tools/metadata/StructuredOutput/provider options及任何source-derived内容 | architecture §5.5 | source mutation property | 待 Step 5 填 | pending |
| SafeRetry仅same branded `truly-empty`；空proof数组不能冒充zero-tool | SESSREC-4 §1.2 | partition matrix | 待 Step 5 填 | pending |
| Continue仅same-view `continue-eligible`、`authoritative-only`、all final-after-hook-settled | 同上 | partition/phase matrix | 待 Step 5 填 | pending |
| Continue messages仅来自M1 replay carriers/provider-prefix content；Legacy/history/cache/public/current provider/raw SQL/digest inversion为0调用 | SESSREC-4 §5.2.1 | source-spy tests | 待 Step 5 填 | pending |
| Inline/sealed均strict decode、canonical re-encode、byte equality、owner digest/closure recomputation与exact total order | 同上 | vectors + property | 待 Step 5 填 | pending |
| Continue不重新执行tool；additional recovery tool side effects=0 | architecture §5.5 | counter | 待 Step 5 填 | pending |
| Plaintext candidate/messages只在K3 scoped continuation立即交M2；不得return/cache/clone/log/persist | SESSREC-4 §5.2.1 | escape/resource tests | 待 Step 5 填 | pending |
| M2 prepare exact九字段且exactly once消费same reservation；无second prepare/replacement object | SESSREC-3 §6.3.1 | call/type assertions | 待 Step 5 填 | pending |
| Provider-specific validation只在original inspection后，candidate保持provider-neutral | SESSREC-4 §5.3–§5.4 | pre-inspection calls=0 | 待 Step 5 填 | pending |
| Anthropic仅audited local/client function call/result-or-error exact grammar；server/hosted/provider-executed、ID/name/order/signature mismatch、forced flush均fail closed | SESSREC-4 §5.3.1 | allowlist matrix | 待 Step 5 填 | pending |
| OpenAI `store=true`仅settled local call/output-or-error及有完整identity/target/model proof的stored reasoning reference；hosted/strip拒绝 | SESSREC-4 §5.3.2 | stored matrix | 待 Step 5 填 | pending |
| OpenAI `store=false`仅无reasoning-state依赖的local closure；reasoning/encrypted/item ref/stateful prefix/hosted/unknown storage拒绝 | SESSREC-4 §5.3.3–§5.3.4 | stateless matrix | 待 Step 5 填 | pending |
| Projection display-only；displayID只作hint，不得parse/cast/lookup为MessageID/authority | SESSREC-1 §4.7.4；SESSREC-4 §7.12 | misuse regression | 待 Step 5 填 | pending |
| F30 known使用、unsupported omit、malformed typed hydration error；malformed不得当absent | SESSREC-1 F30；SESSREC-4 §7.2 | exact branches | 待 Step 5 填 | pending |
| known ManualStop outcome仅显示anchored source final，不授权internal action | SESSREC-4 §7.2 | negative capability | 待 Step 5 填 | pending |
| Internal event在source/type/manifest前排除；public安全不依赖prefix filter | SESSREC-1 F31；SESSREC-4 §7.6 | zero-leak matrix | 待 Step 5 填 | pending |
| Public subscriber保留`SubscriptionV1<D>`→`CommittedEventV1<D>`generic relation，不扩大broad EventV2/object | SESSREC-4 §7.6/§7.7/§7.11.1 | type fixtures | 待 Step 5 填 | pending |
| 三个incomplete strings逐字固定，discriminator仍`UnknownError` | SESSREC-4 §3.2 | exact snapshots | 待 Step 5 填 | pending |
| `adapter-incomplete` → `Provider stream ended without a terminal finish event` | 同上 | exact mapping | 待 Step 5 填 | pending |
| `clean-eof` → `Provider stream ended without a settled model step` | 同上 | exact mapping | 待 Step 5 填 | pending |
| `empty-unknown-finish` → `Provider stream ended with an unknown finish reason and no usable output` | 同上 | exact mapping | 待 Step 5 填 | pending |
| Fatal/indeterminate只用fixed sanitizer，不读取raw cause，不使用`Cause.pretty` | SESSREC-4 §3.2.1 | arbitrary failure fuzz | 待 Step 5 填 | pending |
| Sync prompt/command等待完整chain；automatic返回final child，complete ManualStop返回source，fatal不返回source成功 | SESSREC-4 §7.1/§7.3 | result matrix | 待 Step 5 填 | pending |
| `prompt_async`仅scope接受后204/empty；204不表示background成功 | SESSREC-4 §7.4 | byte/status test | 待 Step 5 填 | pending |
| noReply同queue，old recovery resolution先于user commit；policy/M5/M7/M2/type1/assistant/ledger/M/auth/release全0 | SESSREC-4 §7.4.1 | zero-call/write | 待 Step 5 填 | pending |
| shell同queue，process exactly once；绕过recovery/policy/M5/M7/M2/N/M/model authority，不是source/closure | SESSREC-4 §7.4.2/§7.14 | ordering/counter | 待 Step 5 填 | pending |
| CLI mode在invocation开始冻结；attempt-framed有独立attempt frames+唯一final，或sync-final恰一record；禁止source/child unframed拼接 | SESSREC-4 §7.8.1 | byte vectors | 待 Step 5 填 | pending |
| CLI exit仅final/typed failure决定；presentation/SSE/transient disconnect本身不决定exit | SESSREC-4 §7.9 | state table | 待 Step 5 填 | pending |
| TUI busy/final只由actual transcript relation + hydrated status决定；displayID/event count/idle单信号不决定final | SESSREC-4 §7.11–§7.12 | selector tests | 待 Step 5 填 | pending |
| Successful SSE连接generation严格递增；全cache旧guard失效，active/current eager，其它selected时lazy hydrate | SESSREC-4 §7.11 | race tests | 待 Step 5 填 | pending |
| HTTP/OpenAPI/generated SDK保持unprefixed Legacy兼容；root/v2 204 payload `void`且保留generated envelope | SESSREC-4 §7.4/§8.1 | OpenAPI/codegen/live SDK | 待 Step 5 填 | pending |
| Indeterminate disconnect禁止transparent resend；absence不证明未accept，只可actual relation/status reconcile | SESSREC-4 §7.5/§8.2 | injection | 待 Step 5 填 | pending |
| Native V2只做shared schema/EventV2/SQLite/LLM/generated-client regression；不新增recovery surface | SESSREC-4 §7.15 | regression/forbidden scan | 待 Step 5 填 | pending |

---

## 6. 时序/状态契约（人审）

| 契约 | 来源 | 实现位置 | 验证 |
|---|---|---|---|
| Descriptor before reservation/K7，且无plaintext | SESSREC-4 §5.2 | 待 Step 5 填 | `[F — planned; not created; not run]` trace |
| Reservation固定reserved-no-send；provider prepare/hits 0 | SESSREC-3 §3/§6.3 | 待 Step 5 填 | counter/state |
| K7 before K3/unseal/lowering/actual prepare | SESSREC-2 §9.3 | 待 Step 5 填 | poison-before-K7 |
| K3 all exits zeroize；lease保持live至K9 | SESSREC-2 §9.3.1 | 待 Step 5 填 | resource bracket |
| Commit-time K8在policy/source/control/head checks后、raw cursor commit前 | SESSREC-2 §9.3 | 待 Step 5 填 | transaction trace |
| Complete result后下一步immediate pre-release K8；handle仍prepared，F27尚未调用 | 同上 | 待 Step 5 填 | exact order |
| K8 success before F27/M2 authorization；authorization只到authorized/open | architecture §5.1 | 待 Step 5 填 | state machine |
| Latch保持authorized/held/not-delegated；仅delegate boundary写released | 同上 | 待 Step 5 填 | linear property |
| K9只在release/cancel/abandon/lost fact后live→closed并zeroize；永不revive | SESSREC-2 §9.3 | 待 Step 5 填 | transition property |
| Known-not-delegated先退latch再cancel；unknown-delivery不cancel/resend | architecture §5.1 | 待 Step 5 填 | failure injection |
| Prepared failure固定cancel/barrier→K9→cleanup→post-cancel；K9 failure pre-cleanup fatal | SESSREC-4 §4.3/§6.1 | 待 Step 5 填 | happens-before |
| Delegated+K9 success before empty attempt→ordinal0→consume | detailed-design §3.1 | 待 Step 5 填 | trace |
| SafeRetry truncation在所有transform/converter/provider transform前 | SESSREC-4 §5.1 | 待 Step 5 填 | input spies |
| Continue provider validation在inspection后、M5 final classify前 | SESSREC-4 §5.4 | 待 Step 5 填 | phase order |
| M4 display allocation→F28/F29→public field→F30→M8；F28/F30不写表/分配ID | SESSREC-1 F28–F30 | 待 Step 5 填 | call graph |
| F2/F31 partition先于public manifest/service/bridge/SSE/SDK/CLI/TUI | SESSREC-1 F31 | 待 Step 5 填 | source isolation |
| Sync full chain settles后才mapping/encode | SESSREC-4 §7.3 | 待 Step 5 填 | coordinator trace |
| Async ownership transfer before204；background与HTTP response分离 | SESSREC-4 §7.4 | 待 Step 5 填 | transfer trace |
| noReply recovery resolution before user commit before user-only return | SESSREC-3 §9.15 | 待 Step 5 填 | queue timeline |
| shell保持queue order但M6 branch bypass recovery/model | 同上 | 待 Step 5 填 | queue trace |
| Reducers只写presentation/transient/revision；hydrator独立写final/failure | SESSREC-4 §7.7–§7.9 | 待 Step 5 填 | state property |
| Successful connect后分配generation；先全量invalidate，再hydrate；旧结果不得写current guard | SESSREC-4 §7.11 | 待 Step 5 填 | race tests |
| Disconnect不rollback/cancel/ManualStop/resend；reconcile只读public state | SESSREC-4 §7.5 | 待 Step 5 填 | disconnect trace |

---

## 7. 不变量契约（property-based）

| 不变量 | 来源 | Future property test |
|---|---|---|
| SafeRetry任意合法history输出不含任何source-derived字段/token/digest | SESSREC-4 §5.1 | `[F — planned; not created; not run]` `prop_safe_retry_full_source_exclusion` |
| duplicate/out-of-order/cross-session/ambiguous mapping均closed且零side effect | 同上 | `prop_safe_retry_fail_closed` |
| SafeRetry iff truly-empty；Continue前提包含authoritative-only/all final | SESSREC-4 §1.2 | `prop_partition_action_bijection` |
| Continue proof order唯一决定messages order；输入排列不改变canonical result或显式失败 | SESSREC-4 §5.2.1 | `prop_continue_order_deterministic` |
| Inline/sealed同canonical value产生相同messages/digests | 同上 | `prop_inline_sealed_equivalence` |
| carrier value/order/purpose/scope/generation任一变更导致验证失败 | 同上 | `prop_commitment_sensitivity` |
| Continue recovery tool execution恒0 | architecture §5.5 | `prop_continue_no_tool_reexecution` |
| Lowered candidate exact七字段且无target/storage/digest/handle/receipt/public fields | SESSREC-4 §4.1 | `prop_lowered_exact_field_set` |
| M2 handoff exact九字段；任意missing/extra/substitution失败 | SESSREC-3 §6.3.1 | `prop_prepare_exact_nine_fields` |
| proof/closure/reservation commitment/leases在handoff、inspection、K8、F27链一致 | SESSREC-4 §4.2–§4.3 | `prop_cross_owner_binding_chain` |
| Lease仅absent→live→closed；无renew/reopen/TTL | SESSREC-2 §9.3 | `prop_lease_monotonic` |
| pre-release K8 failure蕴含F27/auth/release=0及cancel→K9→cleanup | 同上 | `prop_k8_failure_zero_authorization` |
| unknown-delivery永不cancel/replacement/resend/source-success | architecture §5.1 | `prop_unknown_delivery_terminal` |
| Projection成功值只含allowlist；forbidden key/unsafe displayID/extra field失败 | SESSREC-1 §4.7.4/F29/F30 | `prop_projection_allowlist` |
| F30 total inner partition恰为known/unsupported/malformed，互斥完备 | SESSREC-1 F30 | `prop_projection_total_partition` |
| Projection/displayID/outcome对internal authority action为零影响 | SESSREC-4 §11.4 | `prop_projection_zero_authority` |
| Internal definition/value不能成为public item；所有public channels leakage=0 | SESSREC-1 F31 | `prop_internal_event_zero_leakage` |
| 三public kind与三字符串一一映射，malformed/future不回显raw | SESSREC-4 §3.2 | `prop_unknown_error_mapping` |
| 任意FatalRecoveryStop都产生同一fixed sanitizer output | SESSREC-4 §3.2.1 | `prop_fatal_sanitizer_constant` |
| noReply所有model-path counters恒0且success仅user-only | SESSREC-4 §7.4.1 | `prop_no_reply_zero_model_effects` |
| shell exactly once且recovery/model counters恒0 | SESSREC-4 §7.4.2 | `prop_shell_bypass` |
| CLI framed模式唯一final；sync-final总record数1；模式不切换 | SESSREC-4 §7.8.1 | `prop_cli_framing` |
| CLI exit只由final/typed failure决定，不受presentation/transient影响 | SESSREC-4 §7.9 | `prop_cli_exit` |
| `wakeHydrator`为true iff revision严格+1 | SESSREC-4 §3.3/§7.7 | `prop_wakeup_revision` |
| generation严格递增，旧generation event/fetch对current为no-op | SESSREC-4 §7.11 | `prop_tui_generation` |
| TUI final/busy只由actual relation+hydrated status决定 | SESSREC-4 §7.12 | `prop_tui_no_false_final` |
| prompt_async success恒204且body长度0 | SESSREC-4 §8.1 | `prop_prompt_async_no_content` |
| Indeterminate absence永不触发transparent resend | SESSREC-4 §7.5 | `prop_disconnect_no_resend` |
| Native V2不新增Legacy recovery surface，shared leakage=0 | SESSREC-4 §7.15 | `prop_native_v2_regression_only` |

Framework与文件位置均为`[F — planned; not created; not run]`，待Step 1–3后回填；不得从当前tests反向生成本列表。

---

## 8. 性能契约（机械化）

> 合同未冻结绝对毫秒阈值，不得自创`elapsed < T`。本节冻结复杂度、调用次数和conditional-liveness；硬时长阈值必须先更新owner合同。

| 契约 | 来源 | Future test | 实测 |
|---|---|---|---|
| SafeRetry pre-pass/mapping/source scan为`O(history.length)`；transform只执行一次于safePrefix | SESSREC-4 §5.1 | `[F — planned; not created; not run]` operation-count scaling | 待 Step 5 填 |
| Continue arrays/carriers各有限消费一次；无retry/renew loop | SESSREC-4 §5.2.1 | operation-count property | 待 Step 5 填 |
| 每carrier最多一次K3 callback；`use`一次；M2 actual prepare一次 | 同上 | call-count test | 待 Step 5 填 |
| Provider constraint为finite switch与finite item scans | SESSREC-4 §5.3 | branch/item-count | 待 Step 5 填 |
| F28/F29/F30只遍历有限acyclic projection；无DB/mapping lookup | SESSREC-1 F28–F30 | bounded traversal | 待 Step 5 填 |
| CLI reducer为single-event finite switch | SESSREC-4 §7.7 | per-event count | 待 Step 5 填 |
| TUI selector `O(messages.length)`；generation invalidation `O(cachedSessionIDs.length)` | SESSREC-4 §7.11–§7.12 | scaling benchmark | 待 Step 5 填 |
| 每generation仅active/current eager transcript+status；其它cached不eager | SESSREC-4 §7.11 | request-count | 待 Step 5 填 |
| M8不新增timeout/retry/poll deadline，不以N/M证明external completion | SESSREC-4 §8.3 | call/config review | 待 Step 5 填 |
| K7/K8/K9 loops finite；M4 busy最多3，不由M7/M8扩大 | SESSREC-2 §9.3 | bounded attempts | 待 Step 5 填 |
| prompt_async handler不等待background completion | SESSREC-4 §7.4 | acceptance call-count | 待 Step 5 填 |

---

## 9. 安全/副作用契约（部分机械化）

| 契约 | 来源 | Future verification |
|---|---|---|
| M7不写authority/event/public state，不authorize/release，不执行tool/provider release | SESSREC-4 §11.7 | `[F — planned; not created; not run]` spies/diff review |
| Plaintext/raw sealed bytes/lookup proof/lease/DEK/KEK/scratch不逃逸K3；all exits zeroize | SESSREC-2 §9.3.1 | resource/error/interrupt tests |
| Candidate/descriptor/log/error/public surface不含raw secret/signature/cursor/provider state | architecture §4.2 | forbidden-field/log scan |
| Provider hits在authorization/release前0；pre-release failure send=0 | architecture §5.1 | transport counters |
| Continue recovery tool side effects=0；shell process exactly once | SESSREC-4 §11.7 | counters |
| Projection无authority字段且不能作为M2/M4/M5/M6 input | SESSREC-1 §4.7.4 | type/dependency scan |
| Internal events在listen/all/typed/public durable/readAggregate/bridge/sync/SSE/SDK/CLI/TUI leakage=0 | SESSREC-4 §7.6/§10 | channel matrix |
| Subscriber安全不依赖prefix filter；无`session.recovery.*` drop branch | SESSREC-4 §7.6 | AST/call review |
| UnknownError/sanitizer不含raw cause/stack/handle/authority/receipt/digest/sealed/provider body/operationID | SESSREC-4 §3.2–§3.2.1 | fuzz/public snapshots |
| prompt_async body=0 bytes；background fatal只经sanitizer，禁止Cause.pretty | SESSREC-4 §7.4/§8.1 | HTTP/leak test |
| Indeterminate状态禁止resend/replacement/source-success fallback | SESSREC-4 §7.5/§8.2 | injection |
| M8 hydration/CLI/TUI不得读取M4 raw/materialization/head/receipt/sealed ref | SESSREC-4 §7 | import boundary |
| displayID不得cast/parse/lookup为message/authority ID | SESSREC-4 §7.12 | misuse test |
| noReply和shell保持各自zero-call边界 | SESSREC-4 §7.4.1–§7.4.2 | zero-call/write |
| Native V2不新增recovery endpoint/event/schema/authority/expectations | SESSREC-4 §7.15 | forbidden diff |
| Step0只创建本文件；schema/script/audit-report/decisions/migration/codegen/tests均未创建未运行 | Workflow §6 | absolute file inventory |

---

## 10. 跨实现一致性（机械化 — 参考向量 / owner 对照）

| 项 | 来源 | 验证 |
|---|---|---|
| SESSREC-4与SESSREC-3的prepare declaration逐字九字段、owner-qualified types、exact return一致 | SESSREC-4 §4.2；SESSREC-3 §6.3.1 | `[F — planned; not created; not run]` type/declaration check |
| Lowered candidate exact七字段在M7 producer、M2 consumer、inspection/K8链一致，无duplicate/extra | SESSREC-4 §4.1 | exact-field compile test |
| F28 only M4 caller；M8 only F30/F29 consumer；display allocation only M4 | SESSREC-1 F28–F30 | import/call graph |
| Projection字段/omission/unknown normalization在schema/HTTP/SDK/CLI/TUI一致 | SESSREC-1 §4.7.4/F30 | canonical JSON vectors |
| `SubscriptionV1<D>`→`CommittedEventV1<D>`在bridge/SDK/CLI/TUI不擦除 | SESSREC-1 §4.5.1a；SESSREC-4 §7.6 | compile/runtime vectors |
| Anthropic shared lowerer、M2 inspection、M7 validator保持相同grammar | SESSREC-4 §5.3.1 | request golden + inspection；golden不替代runtime proof |
| OpenAI true/false storage在transform/inspection/validator/body不混branch | SESSREC-4 §5.3.2–§5.3.4 | paired vectors |
| 三个UnknownError strings跨M3/M8/HTTP/SSE/SDK/CLI/TUI逐字一致，M8唯一mapper | SESSREC-4 §3.2 | shared snapshots |
| Fatal sanitizer跨sync/async/status adapter bit-exact | SESSREC-4 §3.2.1 | canonical JSON comparison |
| prompt/command共享final encoder，HTTP与generated SDK decode一致 | SESSREC-4 §7.3 | route parity/SDK roundtrip |
| OpenAPI204、runtime0bytes、generated payload void、response envelope一致 | SESSREC-4 §8.1 | OpenAPI/codegen/live SDK |
| CLI三模式final effective assistant与exit resolver一致 | SESSREC-4 §7.8.1–§7.9 | transcript/JSON/exit matrix |
| CLI/TUI/SDK统一F30 semantics，malformed不得在任一surface omit | SESSREC-4 §7.2 | cross-consumer vectors |
| TUI generation gate、transcript+status guard、selector在race下结果一致 | SESSREC-4 §7.11–§7.12 | deterministic scheduler |
| Shell/noReply serialized semantics在service/HTTP/SDK/CLI/TUI一致 | SESSREC-3 §9.15；SESSREC-4 §7.4 | cross-entrypoint counters |
| Native V2/shared regression不产生Native recovery surface | SESSREC-4 §7.15 | regression/forbidden scan |
| Step5报告继续区分A/B/C/D/S/F，不把当前50项或S seam写为F通过 | architecture §1.2；detailed-design §8 | report audit |

---

## 反向扩展声明

> 未识别任何允许的implementation-only扩展。默认零反向扩展：实现有而合同没有即不一致；必须先修改唯一owner设计并同步本文件，不能从实现反向回填。

| 扩展项 | 类型 | 动机 | 向后兼容性 |
|---|---|---|---|
| 无 | 零扩展声明 | M7/M8 schema、allowlist、public wire与ordering均为closed合同 | N/A；未来扩展须先走契约变更 |

明确禁止：给`LoweredRecoveryCandidate`增加target/storage/digest/handle；给projection增加state/effective assistant/authority ID；新增public `session.recovery.*`；新增recovery-specific public error kind；引入transparent resend/public idempotency；扩大provider allowlist；新增Native V2 recovery；修改CLI frame而不更新合同。

---

## Step 5 验证记录（待填）

### 路径 A 自动检查结果

- [ ] `[F — planned; not created; not run]` exact type/schema/field checks。
- [ ] `[F — planned; not created; not run]` TypeScript `// # Step Pn:` P1–P29 coverage。
- [ ] `[F — planned; not created; not run]` shared owner import/no duplicate checks。
- [ ] `[F — planned; not created; not run]` property invariants。
- [ ] `[F — planned; not created; not run]` provider hits、tool side effects、durable residue、public leakage、final assistant、exit、busy分别报告。
- [ ] `[F — planned; not created; not run]` HTTP/OpenAPI/generated SDK、CLI/TUI、shell/noReply、Native V2 regressions。
- [ ] 当前未创建`scripts/contract_audit/`、JSON Schema或检查脚本；入口待后续回填。

### 路径 B Subagent 独立审结果

- [ ] `[F — planned; not created; not run]` 独立 reviewer 仅接收契约文档、future git diff 与 expectations 列字段；不得提供实现位置列，避免 echo bias。
- [ ] `[F — planned; not created; not run]` `docs/audits/sessrec-4-legacy-lowering-public-contract/audit-report.md`已产出。
- [ ] `[F — planned; not created; not run]` critical/unresolved=0。
- [ ] `[F — planned; not created; not run]` warning处置记录于`decisions.md`。
- [ ] 当前`audit-report.md`与`decisions.md`均未创建。

### §5.2 五维度兜底

- [ ] 一致性：owner names、字段、枚举、九字段、K-order、public surfaces。
- [ ] 风格：TypeScript markers、owner imports、无structural alias。
- [ ] 正确性：SafeRetry/Continue proof、provider fail-closed、display-only、wrapper/finality。
- [ ] 性能：finite/linear/bounded call-count；不自创wall-clock/liveness。
- [ ] 可维护性：single owner/mapper/decoder/projector、public/private closure、Native V2 boundary。

### Step 5 回填占位

| 项 | 状态 |
|---|---|
| Step 5 日期 | pending |
| Implementation locations | 全部 `待 Step 5 填` |
| Path A | pending / not run |
| Path B | pending / not run |
| A/B/C/D/S/F re-check | pending |
| Exit decision | pending |

---

*本 expectations 于2026-08-15由合同文档独立抽取。任何后续修改必须先修改唯一owner合同，再同步本文件；不得从production implementation或tests反向回填。所有future implementation、tests、schema、scripts、codegen、audit与regression统一保持`[F — planned; not created; not run]`，直到对应workflow阶段实际完成。*
