# Contract Audit Expectations — `sessrec-2-durable-authority`

**子计划**: `sessrec-2-durable-authority`
**契约 review 时间**: `2026-08-15`
**Step 0 完成时间**: `2026-08-15`
**Step 5 验证时间**: `待 Step 5 填`

> 本文件只从下列契约源独立抽取。它描述未来实现必须满足的事实，不声明任何 schema、脚本、实现、测试或审计已创建或已运行。

---

## 1. 契约源（多文档）

| # | 文档 | 章节 | 涵盖契约维度 |
|---|---|---|---|
| 1 | `templates/contract-audit/expectations-template.md` | 全文 | Step 0 文档结构、十类审计维度、反向扩展与 Step 5 记录 |
| 2 | `docs/workflow.md` | §3、§4.3、§5、§6、§7 | 契约格式、实现前完整性、contract-audit v2、双路径验证与变更流程 |
| 3 | `docs/design/session-recovery/architecture.md` | M1–M8、M4 raw authority、事务与 crash model、不变量与 safety theorem | 模块所有权、M4 sole authority、七 materializations、三 recovery heads、aggregate cursor、跨模块安全边界 |
| 4 | `docs/design/session-recovery/detailed-design.md` | owner/export index、M4 function inventory、call graphs、transaction/CAS/replay/correctness indexes | 精确 owner、函数集合、调用顺序、验证依赖与 Step 0 范围 |
| 5 | `docs/design/session-recovery/subplans/sessrec-1-contract-canonicalization.md` | canonical domains、operation/event registry、receipts/results、policy、tool/reasoning/sealed/public carriers | M1 唯一 canonical schema、closed literals、完整 replay result、public nominal carriers |
| 6 | `docs/design/session-recovery/subplans/sessrec-2-durable-authority.md` | §1–§13 | 本子计划主契约：M4 schema、authority views、C1、A1–A5、O1–O10、S1/S2、R1、P1–P5、K0–K10、MIG1、Rely–Guarantee、future tests |
| 7 | `docs/design/session-recovery/subplans/sessrec-3-legacy-runtime-recovery.md` | M2/M3/M5/M6 ownership、handle lifecycle、policy authority、re-entry、automatic handoff | M4 与 runtime proof、prepared handle、policy verifier、K7–K9、F26/F27 的精确接口 |
| 8 | `docs/design/session-recovery/subplans/sessrec-4-legacy-lowering-public-contract.md` | M7/M8 boundaries、same-view proof、publication isolation、public projection、composition proofs | nominal proof slice、lowering、公开面零泄漏、display-only projection 与跨 owner 组合 |

---

## 2. Schema 字段（机械化 — JSON Schema 校验）

> 下表按 durable object/table 分组列出必须机械校验的精确字段集合。字段名、required/nullability、closed discriminator、品牌归属和 owner 不能由实现自行扩展。

| Schema / 字段 | 类型与约束 | 必选 | 来源 | 实现位置（待 Step 5 填） | 一致 |
|---|---|---:|---|---|---|
| `RecoveryAggregateOwnerV1.aggregateID` | branded `M1.RecoveryAggregateID`；全局唯一；role=`session-recovery` | yes | SESSREC-2 §4.2、C1、MIG1 | 待 Step 5 填 | 待 Step 5 填 |
| `RecoveryAggregateOwnerV1.sessionID` | string；与 recovery aggregate 一对一、双向 exact | yes | SESSREC-2 §4.2、§4.5.1 | 待 Step 5 填 | 待 Step 5 填 |
| `SessionRecoveryAggregateOwnerViewV1.recoveryAggregateID` | 与 public/legacy aggregate 和 sealed aggregate 两两不同 | yes | SESSREC-2 §3、§4.2 | 待 Step 5 填 | 待 Step 5 填 |
| `SessionRecoveryAggregateOwnerViewV1.sealedAggregateID` | branded M4 sealed ID；role=`session-recovery-sealed` | yes | SESSREC-2 §3、§4.2 | 待 Step 5 填 | 待 Step 5 填 |
| `event_sequence.owner_session_id` | internal aggregate owner FK；public-compatible rows可为 null | conditional | SESSREC-2 §4.2、MIG1 §10 | 待 Step 5 填 | 待 Step 5 填 |
| `event_sequence.aggregate_kind` | closed role；recovery/sealed/public 不得交叉 | conditional | SESSREC-2 §4.2、MIG1 §10 | 待 Step 5 填 | 待 Step 5 填 |
| `event_sequence.high_water` | safe integer；empty aggregate 为 absent，非空连续 | conditional | SESSREC-2 §4.2、A2、K0 | 待 Step 5 填 | 待 Step 5 填 |
| `event_sequence.genesis_digest` | recovery 使用 M1 `event-chain-v1` aggregate genesis；sealed 使用独立 M4 genesis | conditional | SESSREC-2 C1、A2、K0、MIG1 | 待 Step 5 填 | 待 Step 5 填 |
| `event.aggregate_id` | 顶层 envelope `aggregateID`；禁止用 payload `sessionID` 选 aggregate | yes | SESSREC-1 §4.5.1；SESSREC-2 §4.5.1、A3 | 待 Step 5 填 | 待 Step 5 填 |
| `event.seq` | 从 0 连续；与 aggregate cursor CAS 同事务 | yes | SESSREC-2 A2、A3、P3R/P3S | 待 Step 5 填 | 待 Step 5 填 |
| `event.publication` | recovery/sealed raw 固定 `internal` | yes | SESSREC-2 §8、P3R/P3S | 待 Step 5 填 | 待 Step 5 填 |
| `event.operation_family` | recovery=`m1-recovery-v1`；sealed=`m4-sealed-v1` | yes | SESSREC-2 P3R/P3S、§9.4 | 待 Step 5 填 | 待 Step 5 填 |
| `event.operation_id` | aggregate-scoped stable ID；`(aggregate_id,operation_id)` unique | yes | SESSREC-2 A3–A5、§9.4 | 待 Step 5 填 | 待 Step 5 填 |
| `event.operation_type` | M1 十 operation closed union，或 M4 rotate/redact closed union | yes | SESSREC-1 registry；SESSREC-2 §6、§9.4 | 待 Step 5 填 | 待 Step 5 填 |
| `event.operation_json` | recursive exact envelope；extra/missing/unknown fields 拒绝 | yes | SESSREC-1 exact field sets；SESSREC-2 A1/A3 | 待 Step 5 填 | 待 Step 5 填 |
| `event.receipt_json` | immutable exact receipt；不得持久化 `applyMode` | yes | SESSREC-1 receipts；SESSREC-2 A3/A4 | 待 Step 5 填 | 待 Step 5 填 |
| `event.post_state_digest` | canonical complete operation post-state commitment | yes | SESSREC-2 A2–A4、§9.4 | 待 Step 5 填 | 待 Step 5 填 |
| `event.authority_row_digest` | exact row domain；raw、receipt、post state 全覆盖 | yes | SESSREC-2 §4.2.4、A3/A4 | 待 Step 5 填 | 待 Step 5 填 |
| `relation` materialization | session/aggregate、assistant、operation、origin、source/child relation exact | branch-exact | SESSREC-2 §4.3、A2/A3 | 待 Step 5 填 | 待 Step 5 填 |
| `dispatch-ledger` materialization | assistant/context、ordinal、target/storage、prepared/semantic/authorization commitments、source seq | branch-exact | SESSREC-2 §4.3、O1/O2/O8 | 待 Step 5 填 | 待 Step 5 填 |
| `tool` materialization | exact five-phase literal、call ordinal/ID/name/revision、carrier、commitments、source range | branch-exact | SESSREC-1 §4.4.5；SESSREC-2 §4.3、O3/O3a | 待 Step 5 填 | 待 Step 5 填 |
| `reasoning` materialization | provenance、continuation mode、protocol/target、content carrier/text digest/state refs/source range | branch-exact | SESSREC-1 §4.4.6；SESSREC-2 §4.3、O4 | 待 Step 5 填 | 待 Step 5 填 |
| `decision` materialization | decision ID/revision/status/action/reasons/source/control/binding/supersession/child facts | branch-exact | SESSREC-1 decision schema；SESSREC-2 O7–O10 | 待 Step 5 填 | 待 Step 5 填 |
| `consumption` materialization | decision/revision/source/child/binding/operation/committed sequence | type-9 only | SESSREC-1 §4.5.5；SESSREC-2 O8 | 待 Step 5 填 | 待 Step 5 填 |
| `public-projection` materialization | append-only safe projection history + pure current max-`sourceEventSeq` view | branch-exact | SESSREC-1 public projection；SESSREC-2 A2/A3/R1 | 待 Step 5 填 | 待 Step 5 填 |
| `assistant_chain_head` | aggregate/session、assistant predecessor/current revision/digest/operation | affected branches only | SESSREC-2 §4.4、A3 | 待 Step 5 填 | 待 Step 5 填 |
| `dispatch_ledger_head` | aggregate/session/assistant、current ordinal/digest/operation | affected branches only | SESSREC-2 §4.4、A3 | 待 Step 5 填 | 待 Step 5 填 |
| `recovery_head` | aggregate/session/source、decision revision/status/operation/digest | affected branches only | SESSREC-2 §4.4、O7–O10 | 待 Step 5 填 | 待 Step 5 填 |
| `AggregateEventHeadV1` / aggregate cursor | raw append position；与三个 recovery heads 明确不同 | yes | architecture M4；SESSREC-2 A2/A3 | 待 Step 5 填 | 待 Step 5 填 |
| `DurableRecoveryAuthorityViewV1.viewVersion` | literal `1` | yes | SESSREC-2 §3、S1 | 待 Step 5 填 | 待 Step 5 填 |
| `DurableRecoveryAuthorityViewV1.snapshot` | exact M1 `DurableRecoverySnapshot` | yes | SESSREC-2 §3、S1 | 待 Step 5 填 | 待 Step 5 填 |
| `DurableRecoveryAuthorityViewV1.snapshotIdentity` | exact M4 `RecoverySnapshotIdentityV1` | yes | SESSREC-2 §3、S1 | 待 Step 5 填 | 待 Step 5 填 |
| `DurableRecoveryAuthorityViewV1.toolEligibility` | total/disjoint M4 snapshot-bound eligibility | yes | SESSREC-2 §3、S1 | 待 Step 5 填 | 待 Step 5 填 |
| `DurableRecoveryAuthorityViewV1` authority brand | module-private unique symbol；不可 structural cast/deserialize | yes | SESSREC-2 §3、S1 | 待 Step 5 填 | 待 Step 5 填 |
| `RecoverySnapshotIdentityV1` fields | session/source/high-water/source digest/control-tail digest/latest revision presence exact | yes | SESSREC-2 §3、S1 | 待 Step 5 填 | 待 Step 5 填 |
| `SnapshotBoundToolEligibilityV1` | safe-retry / continue / manual-only closed union；identity exact | yes | SESSREC-2 §3、S1 | 待 Step 5 填 | 待 Step 5 填 |
| `AutomaticRecoveryProofSliceV1` | private brand；same view/action/identity；Continue ordered proofs and closure binding | automatic only | SESSREC-2 §3、S1；SESSREC-4 same-view proof | 待 Step 5 填 | 待 Step 5 填 |
| `CommittedAssistantAuthorityViewV1<K>` | exact type-1/type-2/type-9 admission result、assistant/context、heads/facts、`nonterminal:true` | yes | SESSREC-2 §7.0.1；SESSREC-3 §4.11 | 待 Step 5 填 | 待 Step 5 填 |
| `sealed_recovery_material.ref_id` | M1 branded ref ID；session-owned unique | yes | SESSREC-2 §4.4、K2–K5 | 待 Step 5 填 | 待 Step 5 填 |
| `sealed_recovery_material.sealed_aggregate_id` | exact dedicated sealed owner | yes | SESSREC-2 §4.4、K0 | 待 Step 5 填 | 待 Step 5 填 |
| `sealed_recovery_material.creation_*` | parent recovery aggregate/operation/event sequence exact tuple | yes | SESSREC-2 K2、K0 | 待 Step 5 填 | 待 Step 5 填 |
| `sealed_recovery_material` scope fields | session/assistant/target/purpose/scope digest exact | yes | SESSREC-1 sealed ref；SESSREC-2 K2/K3 | 待 Step 5 填 | 待 Step 5 填 |
| `sealed_recovery_material.plaintext_commitment` | keyed HMAC commitment；不得以低熵明文的无键 SHA-256 替代 | yes | architecture security；SESSREC-2 K1/K2 | 待 Step 5 填 | 待 Step 5 填 |
| `sealed_recovery_material.generation` | safe nonnegative；K7 use 要求 current positive generation | yes | SESSREC-2 K0、K4–K8 | 待 Step 5 填 | 待 Step 5 填 |
| `sealed_recovery_material.state` | `active\|redacted`；redacted terminal | yes | SESSREC-2 K0/K5 | 待 Step 5 填 | 待 Step 5 填 |
| `sealed_recovery_material.key_version` | positive integer；rotation first apply 更新 | active | SESSREC-2 K4 | 待 Step 5 填 | 待 Step 5 填 |
| `sealed_recovery_material` six blob fields | wrap nonce/DEK/tag + cipher nonce/text/tag；redacted 时全 null | branch-exact | SESSREC-2 §9.4、K4/K5 | 待 Step 5 填 | 待 Step 5 填 |
| `sealed_recovery_material.last_operation_id` | creation 时 parent operation；maintenance 时 latest operation | yes | SESSREC-2 K2/K4/K5 | 待 Step 5 填 | 待 Step 5 填 |
| `sealed_recovery_use_lease.lease_id` | CSPRNG unique nominal lease identity | yes | SESSREC-2 §4.4、K7 | 待 Step 5 填 | 待 Step 5 填 |
| `sealed_recovery_use_lease.key_json/key_digest` | exact M1 lease key + M4 digest；full source/action/candidate/target/handle binding | yes | SESSREC-2 K7–K10 | 待 Step 5 填 | 待 Step 5 填 |
| `sealed_recovery_use_lease.snapshot_identity` | exact S1 snapshot identity | yes | SESSREC-2 K7/K8 | 待 Step 5 填 | 待 Step 5 填 |
| `sealed_recovery_use_lease.closure_binding` | safe-retry not-needed 或 Continue source/digest binding | yes | SESSREC-2 §9.3 | 待 Step 5 填 | 待 Step 5 填 |
| `sealed_recovery_use_lease.owner_process_instance_id` | exact process owner；K10 fence selector | yes | SESSREC-2 K7/K10 | 待 Step 5 填 | 待 Step 5 填 |
| `sealed_recovery_use_lease.state` | monotonic `live -> closed`；无 renew/reopen | yes | SESSREC-2 K7–K10 | 待 Step 5 填 | 待 Step 5 填 |
| `sealed_recovery_use_lease.close_reason` | `released`、`mechanically-cancelled`、`abandoned`、`lost-handle-cleanup`、`process-crash-cleanup`、`session-cascade` | closed only | SESSREC-2 K9/K10/K6 | 待 Step 5 填 | 待 Step 5 填 |
| `sealed_recovery_use_lease.row_digest` | exact key/state/owner/snapshot/closure binding commitment | yes | SESSREC-2 §4.4、K7–K10 | 待 Step 5 填 | 待 Step 5 填 |
| `RecoveryCascadeDeletionProofV1` | proofVersion/session/recovery+sealed IDs/deletedCounts/remainingCounts/FK=0/private brand | yes | SESSREC-2 §4.5、K6 | 待 Step 5 填 | 待 Step 5 填 |
| `RecoveryMigrationReceiptV1` | exact v1 receipt fields、counts、schema/backfill digests、journal sequence | yes | SESSREC-2 MIG1 §10.1 | 待 Step 5 填 | 待 Step 5 填 |
| `recovery_authority_migration_journal` | migration ID/from/to/receipt/schema digest/backfill digest/sequence/time | yes | SESSREC-2 MIG1 §10.1 | 待 Step 5 填 | 待 Step 5 填 |

**JSON Schema 文件**: `scripts/contract_audit/schemas/sessrec-2-durable-authority.schema.json` — `[F — planned; not created; not run]`
**Schema 校验脚本**: `scripts/contract_audit/run_all.py sessrec-2-durable-authority` — `[F — planned; not created; not run]`

---

## 3. 枚举值（机械化 — 共享常量 import）

| 枚举集合 | 精确值/约束 | 来源 | 共享 owner / 常量 | Import 路径 | 一致性测试 |
|---|---|---|---|---|---|
| Seven materializations | `relation`、`dispatch-ledger`、`tool`、`reasoning`、`decision`、`consumption`、`public-projection` | SESSREC-2 §4.3 | `M4.SevenMaterializationName` | 待 Step 5 填 | `T-A2/T-R1/T-MIG1` `[F — planned; not created; not run]` |
| Three recovery heads | `assistant-chain-head`、`dispatch-ledger-head`、`recovery-head` | SESSREC-2 §4.4 | `M4.ThreeHeadName` | 待 Step 5 填 | `T-A3/T-R1` `[F — planned; not created; not run]` |
| Tool authority partition | `truly-empty`、`authoritative-only`、`compatibility-only`、`mixed` | SESSREC-1 §4.4.5；SESSREC-2 S1 | `M1.CanonicalToolEvidencePartitionV1` | 待 Step 5 填 | `T-S1-001..028` `[F — planned; not created; not run]` |
| Tool durable phases | `planned`、`body-outcome-durable`、`final-after-hook-settled`、`reconciled-terminal-manual-only`、`unknown-intermediate` | SESSREC-1 §4.4.5 | `M1.ToolExecutionPhaseV1` | 待 Step 5 填 | `T-O3/T-O3A` `[F — planned; not created; not run]` |
| Tool rerun flags | body=`forbidden`、after-hook=`forbidden` for every phase | SESSREC-1 §4.4.5 | M1 phase literals | 待 Step 5 填 | `T-O3A-001..014` `[F — planned; not created; not run]` |
| Reasoning provenance | `provider-end`、`step-boundary-forced-flush`、`cleanup-forced-flush`、`unknown` | SESSREC-1 §4.4.6 | `M1.ReasoningProvenanceV1` | 待 Step 5 填 | `T-O4-001..014` `[F — planned; not created; not run]` |
| Reasoning continuation | `none`、`signed`、`stored-reference`、`unknown` | SESSREC-1 §4.4.6 | `M1.ReasoningContinuationModeV1` | 待 Step 5 填 | `T-O4/T-S1` `[F — planned; not created; not run]` |
| Recovery operation types | M1 frozen ten-operation registry；O1–O9 wrappers，O10 不是第 11 个 operation | SESSREC-1 §4.5/§4.8；SESSREC-2 §6 | `M1.RecoveryOperationType` / registry | 待 Step 5 填 | `T-A1/T-A2/T-O1..O10` `[F — planned; not created; not run]` |
| Sealed maintenance types | `sealed-rotate`、`sealed-redact` | SESSREC-2 §9.4 | `M4.SealedMaintenanceTypeV1` | 待 Step 5 填 | `T-K0/T-K4/T-K5` `[F — planned; not created; not run]` |
| Sealed state | `active`、`redacted` | SESSREC-2 K0/K5 | M4 sealed authority schema | 待 Step 5 填 | `T-K0/T-K5` `[F — planned; not created; not run]` |
| Sealed lease state | `live`、`closed`；只允许单向转换 | SESSREC-2 K7–K10 | M4 lease schema | 待 Step 5 填 | `T-K7..T-K10` `[F — planned; not created; not run]` |
| Lease close reasons | `released`、`mechanically-cancelled`、`abandoned`、`lost-handle-cleanup`、`process-crash-cleanup`、`session-cascade` | SESSREC-2 K6/K9/K10 | M4 close APIs | 待 Step 5 填 | `T-K6/T-K9/T-K10` `[F — planned; not created; not run]` |
| Automatic actions | `safe-retry`、`continue-after-settled-tools` | architecture；SESSREC-1 closure | `M1.AutomaticRecoveryAction` | 待 Step 5 填 | `T-S1/T-O8` `[F — planned; not created; not run]` |
| Apply mode | `first-application`、`exact-replay`；ephemeral only | SESSREC-1 result；SESSREC-2 A3/A4 | `M1.OperationCommitResultV1<T>` | 待 Step 5 填 | `T-A3/T-A4/T-A5` `[F — planned; not created; not run]` |
| Handle terminal delivery | `released/delegated`、`released/unknown-delivery`；unknown 不得 cancel/resend | architecture；SESSREC-3 handle lifecycle | M2 canonical handle state | 待 Step 5 填 | runtime handoff tests `[F — planned; not created; not run]` |
| Publication | `public`、`internal`；recovery/sealed definitions固定 internal | SESSREC-1 public carriers；SESSREC-2 §8 | M1 definition/manifest owner | 待 Step 5 填 | `T-P1..T-P5` `[F — planned; not created; not run]` |
| Policy defaults | `N=2`、configured `M=64`；runtime只消费 committed effective M | architecture；SESSREC-2 policy integration | M1/M6 policy owners | 待 Step 5 填 | `T-POLICY-001..018` `[F — planned; not created; not run]` |

---

## 4. 流程步骤（机械化 — TypeScript `// # Step Pn:` 注释 grep）

> 未来 TypeScript 实现必须使用下列精确注释拼写。编号是本 Step 0 的跨函数审计标记；不得改成 Python `# Step`、省略 `//` 或使用近义注释。

| 设计步骤 | 必须出现的计划标记 | 来源 | 实现位置（待 Step 5 填） | 验证 |
|---|---|---|---|---|
| C1 校验 session/三 aggregate IDs、pairwise distinct、fresh | `// # Step P1:` | SESSREC-2 C1 | 待 Step 5 填 | marker grep `[F — planned; not created; not run]` |
| C1 在 parent immediate tx 写 session→recovery cursor→sealed cursor→owner map 并 readback | `// # Step P2:` | SESSREC-2 C1 | 待 Step 5 填 | `T-C1` `[F — planned; not created; not run]` |
| A3 tx 外 exact structural validation；不读 current policy/resource | `// # Step P3:` | SESSREC-2 A3 | 待 Step 5 填 | `T-A3` `[F — planned; not created; not run]` |
| A3 `BEGIN IMMEDIATE`、owner validation、scoped `(aggregateID,operationID)` lookup | `// # Step P4:` | SESSREC-2 A3 | 待 Step 5 填 | `T-A3` `[F — planned; not created; not run]` |
| A4 existing branch 验证完整 expected input、historical operation prefix、stored receipt | `// # Step P5:` | SESSREC-2 A4 | 待 Step 5 填 | `T-A4` `[F — planned; not created; not run]` |
| A4 独立验证 current full prefix、七表、三 heads、sealed metadata，返回 original complete result | `// # Step P6:` | SESSREC-2 A4 | 待 Step 5 填 | `T-A4/T-A5` `[F — planned; not created; not run]` |
| A3 first apply 读取 raw fold；验证 prepared/origin/policy/N/M/predecessor | `// # Step P7:` | SESSREC-2 A3 | 待 Step 5 填 | `T-A3/T-POLICY` `[F — planned; not created; not run]` |
| O8 first apply 在 cursor 前执行 commit-time K8 exact live lease validation | `// # Step P8:` | SESSREC-2 O8/K8 | 待 Step 5 填 | `T-O8/T-K8` `[F — planned; not created; not run]` |
| A3 aggregate cursor CAS exactly one，0 row 不算成功 | `// # Step P9:` | SESSREC-2 A3 | 待 Step 5 填 | fault matrix `[F — planned; not created; not run]` |
| A3 raw authority anchor first，随后 K2 pending seals | `// # Step P10:` | SESSREC-2 A3/K2 | 待 Step 5 填 | `T-A3/T-K2` `[F — planned; not created; not run]` |
| A3 fixed order 写 Legacy relation、七 materializations | `// # Step P11:` | SESSREC-2 A3 | 待 Step 5 填 | `T-A3` `[F — planned; not created; not run]` |
| A3 fixed order CAS heads：assistant chain→dispatch ledger→recovery | `// # Step P12:` | SESSREC-2 A3 | 待 Step 5 填 | `T-A3/T-RG` `[F — planned; not created; not run]` |
| A3 transaction-local raw/fold/table/head/receipt/sealed readback 后 commit | `// # Step P13:` | SESSREC-2 A3 | 待 Step 5 填 | fault/readback matrix `[F — planned; not created; not run]` |
| A5 先验证 M1 lookup key 与 owner mapping，再 scoped lookup/A4 | `// # Step P14:` | SESSREC-2 A5 | 待 Step 5 填 | `T-A5` `[F — planned; not created; not run]` |
| O3a 读取 latest authoritative call，验证仅 intermediate→reconciled transition | `// # Step P15:` | SESSREC-2 O3a | 待 Step 5 填 | `T-O3A` `[F — planned; not created; not run]` |
| O3a 以 A3 append-only commit；body/hook/provider 调用恒 0 | `// # Step P16:` | SESSREC-2 O3a | 待 Step 5 填 | hit-count tests `[F — planned; not created; not run]` |
| S1 单 WAL snapshot 读取 owner/raw/七表/三 heads/sealed/public mapping | `// # Step P17:` | SESSREC-2 S1 | 待 Step 5 填 | `T-S1/T-PUBMAP` `[F — planned; not created; not run]` |
| S1 构造四向 tool partition、identity、eligibility、nominal authority view/proof slice | `// # Step P18:` | SESSREC-2 S1 | 待 Step 5 填 | `T-S1` `[F — planned; not created; not run]` |
| O7 验证 cancel/no-handle proof；K9/cleanup/A5/S2/S1 已按序完成 | `// # Step P19:` | SESSREC-2 O7 | 待 Step 5 填 | `T-O7` `[F — planned; not created; not run]` |
| O7 A3 提交 ManualStop，complete result 后 tombstone invalidation | `// # Step P20:` | SESSREC-2 O7 | 待 Step 5 填 | `T-O7` `[F — planned; not created; not run]` |
| O8 验证 same-view slice、closure、prepared handle、policy/source/control/lease tuple | `// # Step P21:` | SESSREC-2 O8 | 待 Step 5 填 | `T-O8` `[F — planned; not created; not run]` |
| O8 complete type-9 result 后 same handle prepared 状态执行独立 pre-release K8 | `// # Step P22:` | SESSREC-2 O8/K8 | 待 Step 5 填 | `T-O8/T-K8` `[F — planned; not created; not run]` |
| pre-release K8 success 才 F27→authorize→single release→K9；failure cancel→K9 且 F27/auth/release=0 | `// # Step P23:` | SESSREC-2 K8/K9；SESSREC-3 handoff | 待 Step 5 填 | ordering tests `[F — planned; not created; not run]` |
| O10 inspect dedicated current authority；unresolved 只返回 branded required authority | `// # Step P24:` | SESSREC-2 O10 | 待 Step 5 填 | `T-O10` `[F — planned; not created; not run]` |
| O10 complete-input 重算 full supersession binding，调用 O9/A5；model/no-reply/automatic closed map | `// # Step P25:` | SESSREC-2 O10 | 待 Step 5 填 | `T-O10` `[F — planned; not created; not run]` |
| K0 双 prefix 单调 fold：recovery creation→sealed maintenance→remaining creation | `// # Step P26:` | SESSREC-2 K0 | 待 Step 5 填 | `T-K0` `[F — planned; not created; not run]` |
| K1 keyed commitment+GCM pending seal；all-exit zeroize | `// # Step P27:` | SESSREC-2 K1 | 待 Step 5 填 | `T-K1` `[F — planned; not created; not run]` |
| K3 short tx 验证 dual prefix/physical/live lease，tx 外 key/decrypt/callback/finally zeroize | `// # Step P28:` | SESSREC-2 K3 | 待 Step 5 填 | `T-K3` `[F — planned; not created; not run]` |
| K4/K5 exact replay lookup first；missing 才 current guard，live lease conflict before mutation | `// # Step P29:` | SESSREC-2 K4/K5 | 待 Step 5 填 | `T-K4/T-K5` `[F — planned; not created; not run]` |
| K6 same parent tx counts→close live leases→delete exactly one session→zero counts/FK proof | `// # Step P30:` | SESSREC-2 K6 | 待 Step 5 填 | `T-K6` `[F — planned; not created; not run]` |
| K7 acquire live lease before unseal/lower/actual prepare；K9 live→closed；K10 exclusive fence cleanup | `// # Step P31:` | SESSREC-2 K7–K10 | 待 Step 5 填 | `T-K7..T-K10` `[F — planned; not created; not run]` |
| R1 pin expected head→dual raw fold→derived replace→readback；raw/cursors/sealed/leases unchanged | `// # Step P32:` | SESSREC-2 R1 | 待 Step 5 填 | `T-R1` `[F — planned; not created; not run]` |
| MIG1 classify branch→DDL/backfill→fresh pair genesis→integrity proof→journal last | `// # Step P33:` | SESSREC-2 MIG1 | 待 Step 5 填 | `T-MIG1` `[F — planned; not created; not run]` |
| P1–P5 source/manifest/reader/bridge/history hard public partition | `// # Step P34:` | SESSREC-2 §8 | 待 Step 5 填 | `T-P1..T-P5` `[F — planned; not created; not run]` |

**Marker 校验脚本**: `scripts/contract_audit/run_all.py sessrec-2-durable-authority` — `[F — planned; not created; not run]`

---

## 5. 行为契约（语义，人审）

| 契约 | 来源 | 验证方式（测试名） | 一致 |
|---|---|---|---|
| Dedicated recovery aggregate 的 raw EventTable rows 是唯一 canonical replay authority；七 materializations 全是可重建 view，三 heads 是 online CAS index，aggregate cursor 只是 raw append position | architecture M4；SESSREC-2 A2/A3/R1 | `T-A2/T-A3/T-R1` `[F — planned; not created; not run]` | 待 Step 5 填 |
| 每 session 恰有一个 recovery aggregate 和一个 sealed aggregate；二者与 public/legacy aggregate 及彼此不同 | architecture；SESSREC-2 C1/MIG1 | `T-C1/T-MIG1` `[F — planned; not created; not run]` | 待 Step 5 填 |
| C1 只在 parent session-creation transaction 创建 owner pair/cursors；MIG1 只为 existing sessions 建 fresh empty pair；均不得写 recovery raw/derived/sealed material | SESSREC-2 C1/MIG1 | `T-C1/T-MIG1` `[F — planned; not created; not run]` | 待 Step 5 填 |
| Aggregate 选择只读 operation envelope 顶层 `aggregateID`；所有 payload `sessionID` 必须等于 owner mapping，但不能作 SQL selector | SESSREC-1 registry；SESSREC-2 A3/P3R | `T-A3/T-P3R` `[F — planned; not created; not run]` | 待 Step 5 填 |
| A3 existing operation 必须先走 A4；exact replay 不依赖 current policy、N/M、prepared proof、key、lease 或 runtime resource | SESSREC-2 A3/A4 | `T-A3/T-A4/T-POLICY` `[F — planned; not created; not run]` | 待 Step 5 填 |
| Exact replay 只有在 aggregate/session/type/full expected input/payload digest/receipt kind、historical operation fold、current full fold、七表、三 heads 和 sealed metadata 全部一致时才返回原完整 `M1.OperationCommitResultV1<T>` | SESSREC-2 A4/A5 | `T-A4/T-A5` `[F — planned; not created; not run]` | 待 Step 5 填 |
| Exact replay result 必须含 original operation、operationPostState、stored receipt 和 ephemeral `applyMode:"exact-replay"`；receipt-only/detached receipt 不完整且不授权 transport | SESSREC-1 result；SESSREC-2 A4/A5 | `T-A5` `[F — planned; not created; not run]` | 待 Step 5 填 |
| `applyMode` 只存在于 return value，不持久化进 raw row/receipt | SESSREC-1；SESSREC-2 A3/A4 | schema/result tests `[F — planned; not created; not run]` | 待 Step 5 填 |
| First application 的 zero affected rows 从不自动视为成功；cursor/raw/materialization/head/owner insert 均要求 exactly one + readback | SESSREC-2 C1/A3/K2/K4/K5 | fault injection `[F — planned; not created; not run]` | 待 Step 5 填 |
| Policy verifier 只在 first application 读取 committed normalized policy，并逐项验证 `scopeKey/epoch/policyDigest/defaultSemanticsVersion` | architecture policy；SESSREC-2 A3 | `T-POLICY` `[F — planned; not created; not run]` | 待 Step 5 填 |
| Effective M 的唯一 runtime 来源是 transaction-verified `normalizedPolicy.digestInput.effectiveMaxModelAssistants`；禁止读取 top-level convenience field、runtime config、`agent.steps` 或重新 min/max | architecture；SESSREC-2 A3/policy matrix | `T-POLICY-001..018` `[F — planned; not created; not run]` | 待 Step 5 填 |
| Later policy 变化不能使历史 exact replay 失效 | architecture；SESSREC-2 A3/A4 | policy replay property `[F — planned; not created; not run]` | 待 Step 5 填 |
| M4 authority view 只能在同一事务验证 raw、materializations、heads、sealed metadata、public mapping 后附 nominal brand；plain snapshot/fold/projection/history/lookalike 不可替代 | SESSREC-2 S1；SESSREC-4 same-view proof | `T-S1` `[F — planned; not created; not run]` | 待 Step 5 填 |
| Automatic proof slice 必须来自同一个 exact authority view，绑定 exact snapshot identity/action；M7 只能消费 branded slice | SESSREC-2 S1；SESSREC-4 | `T-S1` and lowering type tests `[F — planned; not created; not run]` | 待 Step 5 填 |
| Tool partition 是全覆盖且互斥的四向分类；同 callID 可在 authoritative/compatibility 两区共存，禁止跨区 dedup | SESSREC-1 §4.4.5；SESSREC-2 S1 | partition property tests `[F — planned; not created; not run]` | 待 Step 5 填 |
| SafeRetry 只接受 `truly-empty`；Continue 只接受 `authoritative-only` 且每项恰为 `final-after-hook-settled` | architecture；SESSREC-1；SESSREC-2 S1/O8 | `T-S1/T-O8` `[F — planned; not created; not run]` | 待 Step 5 填 |
| Compatibility-only、mixed、planned、body-outcome、reconciled、unknown、manual-only 或任一 evidence inconsistency 全部 fail closed 到 ManualStop/fatal typed path | SESSREC-1；SESSREC-2 S1 | `T-S1/T-O3A` `[F — planned; not created; not run]` | 待 Step 5 填 |
| O3a 只追加 `reconciled-terminal-manual-only`，可关闭 terminal barrier，但执行 tool body、after-hook、provider 各 0 次且永久禁止 automatic recovery | SESSREC-2 O3a | `T-O3A-001..014` `[F — planned; not created; not run]` | 待 Step 5 填 |
| Replay payload 必须保存可重建 inline canonical value 或 exact sealed ref；one-way digest 不可替代 payload carrier | SESSREC-1 tool/reasoning/prefix；SESSREC-2 O3–O5/S1 | carrier round-trip tests `[F — planned; not created; not run]` | 待 Step 5 填 |
| K0–K10 共同形成 sealed lifecycle：K0/K0a fold/replay，K1 prepare，K2 parent-rooted persist，K3 scoped unseal，K4 rotate，K5 redact，K6 cascade，K7 acquire，K8 dual validate，K9 close，K10 fenced crash cleanup | SESSREC-2 §9 | `T-K0..T-K10` `[F — planned; not created; not run]` | 待 Step 5 填 |
| Initial sealed authority 必须来自 parent recovery raw payload；不得发明 sealed-create public/internal operation | SESSREC-2 K2/K0 | `T-K2/T-K0` `[F — planned; not created; not run]` | 待 Step 5 填 |
| K4/K5 exact replay lookup 必须发生在 current generation/state、lease、key prefetch 或 crypto 检查前 | SESSREC-2 K4/K5 | `T-K4/T-K5` `[F — planned; not created; not run]` | 待 Step 5 填 |
| Redaction 是不可逆 terminal authority；old row bytes、closed lease、cleanup 或 replay 不得恢复 active material | SESSREC-2 K5/K10 | redaction finality properties `[F — planned; not created; not run]` | 待 Step 5 填 |
| K7 要求 positive current generation；generation 0 不可 cast/offset，必须显式 K4 后 fresh S1 再评估 | SESSREC-2 K7 | `T-K7/T-K4/T-S1` `[F — planned; not created; not run]` | 待 Step 5 填 |
| O8 first application 的 commit-time K8 只保护 commit，不授权 F27/release；complete type-9 result 后必须再做独立 pre-release K8 | SESSREC-2 O8/K8 | `T-O8/T-K8` `[F — planned; not created; not run]` | 待 Step 5 填 |
| pre-release K8 success 才可传 complete result+post-state 给 F27 并 authorize/release same handle once；failure 必须 cancel，F27/authorization/release 调用数均 0，再 K9 | SESSREC-2 K8；SESSREC-3 handoff | ordering/hit-count tests `[F — planned; not created; not run]` | 待 Step 5 填 |
| O7 ManualStop 固定顺序：cancel/no-handle barrier→K9/zeroize→cleanup+tombstone→A5/S2/S1→type-8 commit→complete result→tombstone invalidation | SESSREC-2 O7 | `T-O7` `[F — planned; not created; not run]` | 待 Step 5 填 |
| O10 inspect 遇 unresolved source 只能返回 branded complete authority facts，不能缺完整 type-10 input 就内部调用 O9；caller 补齐后重入 complete-input branch | SESSREC-2 O10 | `T-O10` `[F — planned; not created; not run]` | 待 Step 5 填 |
| O10 model branch 才可返回 prepare proof；no-reply 只能 user-only；automatic winner只能 reload/steer，均不得擅自进入 M7/M2/O1 | SESSREC-2 O10；SESSREC-3 serialized submission | `T-O10` `[F — planned; not created; not run]` | 待 Step 5 填 |
| R1 只重建 Legacy deterministic missing rows、七 materializations 和三 heads；绝不修改 raw、receipts、owner、recovery/sealed cursors、sealed physical rows或lease rows | SESSREC-2 R1 | `T-R1` `[F — planned; not created; not run]` | 待 Step 5 填 |
| Session deletion 必须在同一 higher-level immediate tx 调 K6，关闭 live leases、delete session exactly one、验证 fixed before/after counts 全零和 FK violations=0；任一失败全 rollback | SESSREC-2 K6 | `T-K6` `[F — planned; not created; not run]` | 待 Step 5 填 |
| MIG1 fresh/upgrade/idempotent branches closed；existing public payload bytes 不 decode/re-encode、不混入 recovery authority | SESSREC-2 MIG1 | `T-MIG1` `[F — planned; not created; not run]` | 待 Step 5 填 |
| Internal recovery/sealed event 永不调用 public notifier；R1/MIG1/K4/K5/A3 silent | SESSREC-2 §8.7 | `T-P1..P5/T-SECRET` `[F — planned; not created; not run]` | 待 Step 5 填 |

---

## 6. 时序/状态契约（人审）

| 契约 | 来源 | 实现位置 | 验证 |
|---|---|---|---|
| `BEGIN IMMEDIATE` 在任何 first-apply authority read/write 前取得 writer lock；禁止 DEFERRED→write lock upgrade | architecture transaction model；SESSREC-2 §11 | 待 Step 5 填 | `T-RG` `[F — planned; not created; not run]` |
| A3 tx 内顺序固定：owner/scoped lookup→historical/current validation→policy/source/head→type-9 K8→cursor→raw→K2→derived→heads→readback→commit | SESSREC-2 A3/Rely–Guarantee | 待 Step 5 填 | transaction trace tests `[F — planned; not created; not run]` |
| Head write order固定 `assistant chain → dispatch ledger → recovery`；aggregate cursor 独立且不算第四 recovery head | architecture；SESSREC-2 A3 | 待 Step 5 填 | ordered SQL trace `[F — planned; not created; not run]` |
| 任一 CAS/readback/validation/commit failure rollback 整个 owned transaction，外部只见完整前态或完整后态，零 partial residue | architecture；SESSREC-2 A3/K2/K4/K5/R1/K6/MIG1 | 待 Step 5 填 | fault matrix `[F — planned; not created; not run]` |
| Raw event、immutable receipt、operation post-state、pending seals、七 views、relevant heads、aggregate cursor 同一事务原子 | architecture；SESSREC-2 A3 | 待 Step 5 填 | `T-A3` `[F — planned; not created; not run]` |
| Write transaction 内禁止 provider/tool/unseal/keyring/config/listener/public projector 或可能 re-enter DB 的 callback | architecture；SESSREC-2 §11.3/§11.5 | 待 Step 5 填 | callback prohibition audit `[F — planned; not created; not run]` |
| K3 必须先在 short read tx 完成 dual-prefix/physical/live-lease validation并关闭 tx，之后才 keyring/decrypt/callback | SESSREC-2 K3 | 待 Step 5 填 | `T-K3` `[F — planned; not created; not run]` |
| K7 在任何 unseal、M7 lowering、M2 actual preparation 前完成；仅 reservation 可先存在 | SESSREC-2 K7；SESSREC-3 recovery graph | 待 Step 5 填 | `T-K7/T-RG` `[F — planned; not created; not run]` |
| K8 有两个不同 gate：commit-time K8 在 raw cursor 前；pre-release K8 在 complete result 后且 same handle 仍 prepared 时、F27 前 | SESSREC-2 K8/O8 | 待 Step 5 填 | `T-K8` `[F — planned; not created; not run]` |
| K9/K10 只允许 `live→closed`；无 TTL、renew、reopen、old-handle revival | SESSREC-2 K7–K10 | 待 Step 5 填 | `T-K9/T-K10` `[F — planned; not created; not run]` |
| K10 只有 exclusive dead-process liveness fence 后可 cleanup；wall clock、heartbeat age、TTL 均不能证明死亡 | SESSREC-2 K10 | 待 Step 5 填 | `T-K10` `[F — planned; not created; not run]` |
| K4/K5 first apply 发现 same ref/generation live lease 必须在 crypto/mutation 前 conflict；live lease 保持 generation 不变直到 K9 | SESSREC-2 K4/K5/K7–K9 | 待 Step 5 填 | race harness `[F — planned; not created; not run]` |
| O3a restart reconcile 只从 latest intermediate raw anchor 到 reconciled terminal；competing final/reconciled winner 走 closed conflict/reload | SESSREC-2 O3a | 待 Step 5 填 | `T-O3A/T-RG` `[F — planned; not created; not run]` |
| O7 在任何 ManualStop commit 前必须证明 handle 已不可发送且 leases 已关闭/zeroized；commit failure 不可重新 prepare/release | SESSREC-2 O7 | 待 Step 5 填 | `T-O7` `[F — planned; not created; not run]` |
| O8 complete result 不等于 transport authority；same handle 的动态 proof chain 必须持续到 pre-release K8/F27/authorize/release | architecture；SESSREC-2 O8；SESSREC-3 | 待 Step 5 填 | `T-O8/T-K8` `[F — planned; not created; not run]` |
| Delegate boundary 前 known local failure 可退回 authorized/open 后 cancel；跨界不确定必须 terminal `released/unknown-delivery`，禁止 cancel/resend | architecture crash/transport model；SESSREC-3 | 待 Step 5 填 | handle-state tests `[F — planned; not created; not run]` |
| Public live notify 只能发生在 public DB commit/tx close 后；observer failure不重试 authority transaction | SESSREC-2 P2/P4 | 待 Step 5 填 | `T-P2/T-P4` `[F — planned; not created; not run]` |
| Rebuild 在完整 prefix 验证完成前抑制 live publication；R1 本身始终 silent | architecture publication/rebuild；SESSREC-2 R1 | 待 Step 5 填 | rebuild publication tests `[F — planned; not created; not run]` |
| MIG1 journal 最后写；migration commit 前 application session writer 不开放 | SESSREC-2 MIG1 | 待 Step 5 填 | `T-MIG1/T-RG` `[F — planned; not created; not run]` |
| Durable crash claim 仅覆盖 SQLite 报告 transaction success 后的 validated process crash/restart 且 storage usable | architecture crash model | 待 Step 5 填 | crash-restart harness `[F — planned; not created; not run]` |
| 不宣称 host crash、power loss、filesystem/device-cache loss、storage corruption 或 provider exactly-once；当前方案不宣称 `synchronous=FULL` | architecture fault exclusions | 待 Step 5 填 | claim/document audit `[F — planned; not created; not run]` |

---

## 7. 不变量契约（property-based — 不变量测试覆盖）

| 不变量 | 来源 | 测试 |
|---|---|---|
| 任意合法 raw prefix 的 A2 fold deterministic；相同 prefix byte-equivalent；gap/duplicate/hash break/unknown family 必失败 | SESSREC-2 A2 | `T-A2-001..012` `[F — planned; not created; not run]` |
| 任意 committed state：七 materializations + 三 heads = A2(raw prefix)；aggregate cursor=head position；无第八 materialization/第四 recovery head | architecture；SESSREC-2 A2/A3/R1 | fold/model property suite `[F — planned; not created; not run]` |
| 对任意 operation fault point，A3 结果只能是 complete before-state 或 complete after-state，不能有 orphan raw/seal/derived/head | SESSREC-2 A3/K2 | transactional fault property `[F — planned; not created; not run]` |
| 对任意 exact replay，返回 original complete result；current policy/resource change 不改变 replay result；任一 current corruption 使 replay fail closed | SESSREC-2 A4/A5 | `T-A4/T-A5/T-POLICY` `[F — planned; not created; not run]` |
| Owner mapping 是 bijection：`RecoveryAggregateID ↔ sessionID`，且 recovery/sealed/public roles disjoint | SESSREC-2 C1/MIG1/P3R/P3S | owner-ID generator properties `[F — planned; not created; not run]` |
| Tool partition 四 branch 的 predicate 两两不交且析取为 true；discriminator 与 cardinality 双向一致 | SESSREC-1 §4.4.5 | fast-check partition truth table `[F — planned; not created; not run]` |
| Tool/reasoning/prefix SQL literal mapping 对 M1 closed domains total 且 bijective；round-trip 不产生近义值 | SESSREC-2 §4.3/A2 | literal round-trip properties `[F — planned; not created; not run]` |
| SafeRetry iff tool partition truly-empty；Continue only if authoritative-only and every phase final；其它分支 automatic proof 不可构造 | SESSREC-2 S1 | nominal eligibility properties `[F — planned; not created; not run]` |
| O3a 对任意合法 intermediate phase，唯一 successor 是 reconciled terminal manual-only；body/hook/provider counters 恒 0 | SESSREC-2 O3a | state-machine property `[F — planned; not created; not run]` |
| K0 对任意合法双 prefix deterministic；每 ref 有唯一 parent creation authority 和单调 maintenance generation/state | SESSREC-2 K0 | `T-K0-001..014` `[F — planned; not created; not run]` |
| K0a missing iff exact owner scope内 operation absent；existing rotate/redact 只能返回对应 conditional receipt type | SESSREC-2 K0a | `T-K0A-001..016` `[F — planned; not created; not run]` |
| K7 同 exact live key/owner replay返回同 nominal lease；same generation different key/owner 至多一个 winner | SESSREC-2 K7 | lease uniqueness properties `[F — planned; not created; not run]` |
| K7/K8/K9/K10 lease state monotonically `absent→live→closed`；closed 永不回 live | SESSREC-2 K7–K10 | lease state-machine properties `[F — planned; not created; not run]` |
| K8 expected lease set 与 provided/readback set 双向 exact；missing/extra/duplicate 均失败；zero-ref iff exact empty tuple | SESSREC-2 K8 | `T-K8-001..018` `[F — planned; not created; not run]` |
| Redaction 后任意 restored old bytes/old lease/old request 均不能使 K3 成功；generation/state monotonic | SESSREC-2 K5/K3/K10 | redaction finality properties `[F — planned; not created; not run]` |
| K6 对 fixed `RecoveryOwnedTableName` tuple：`deletedCounts=beforeCounts-afterCounts`、所有 `remainingCounts=0`、FK violations=0 | SESSREC-2 K6 | cascade count properties `[F — planned; not created; not run]` |
| R1 对同 raw/sealed prefixes 与 pinned head 幂等；只改变允许的 derived state，authority bytes不变 | SESSREC-2 R1 | rebuild idempotency properties `[F — planned; not created; not run]` |
| MIG1 任意失败点 rollback schema/data/journal；target+journal exact 时重复运行返回同 stored receipt | SESSREC-2 MIG1 | migration fault/idempotency properties `[F — planned; not created; not run]` |
| Public manifest sets 满足：publicLatest⊆public、publicServer⊆public、publicWriter⊆public∩durable、durableReplay=publicDurable∪internalDurable | SESSREC-2 P1 | manifest set properties `[F — planned; not created; not run]` |
| 对任意 internal recovery/sealed event，public listener/all/subscribe/durable/readAggregate/bridge/sync/SSE/SDK/CLI/TUI emission count 恒 0 | architecture；SESSREC-2 P1–P5；SESSREC-4 | publication noninterference properties `[F — planned; not created; not run]` |
| Public projection 任意输出都不包含 authority/target/ledger ordinal/digest/proof/operation/revision/head/receipt/sealed ref/internal child ID | SESSREC-1 public projection；SESSREC-4 | public projection key-set properties `[F — planned; not created; not run]` |
| 任意 cross-session/cross-aggregate operation/receipt/ref/lease/proof substitution 均不能通过 exact owner checks | architecture；SESSREC-2 A5/K3/K7/S1 | cross-owner adversarial properties `[F — planned; not created; not run]` |

---

## 8. 性能契约（机械化 — 有界操作/复杂度断言）

> 契约未给出可据实抽取的硬墙钟秒数，因此 Step 0 不虚构 `elapsed < T`。机械化性能审计以有限扫描、调用次数、重试上界、non-blocking 与无 spin 为准；若 Step 5 需要墙钟阈值，必须先更新契约。

| 契约 | 来源 | 测试 | 实测 |
|---|---|---|---|
| A2 对 recovery rows 单调单次扫描；nested evidence collections 有限；无 spin | SESSREC-2 A2 | operation-count/linear-growth test `[F — planned; not created; not run]` | 待 Step 5 填 |
| K0 双 prefix 由两个单调 index 各扫描一次；pending refs finite | SESSREC-2 K0 | dual-prefix linear-growth test `[F — planned; not created; not run]` | 待 Step 5 填 |
| A3/A5/S1/S2/R1/K-family busy retry 最多 3 次；operationID/payload/handle 不变 | SESSREC-2 §11.3 | retry-count tests `[F — planned; not created; not run]` | 待 Step 5 填 |
| Exact replay existing branch不执行 first-apply steps，不重 prepare、不读 current policy/key、不开 provider/tool callback | SESSREC-2 A3/A4 | call-count test `[F — planned; not created; not run]` | 待 Step 5 填 |
| P2 listener/queue snapshot finite；每项一次 non-blocking attempt，无 retry loop | SESSREC-2 P2 | notifier bounded-attempt test `[F — planned; not created; not run]` | 待 Step 5 填 |
| P4 固定 guard/encode，至多 ordinary+sync 两次 emit attempt | SESSREC-2 P4 | bridge call-count test `[F — planned; not created; not run]` | 待 Step 5 填 |
| P5 单页 `limit` 有界、每 row decode 一次；函数不内建无界 pagination loop | SESSREC-2 P5 | bounded-page test `[F — planned; not created; not run]` | 待 Step 5 填 |
| K7/K9/K10 row/ref loops finite；无 TTL polling loop | SESSREC-2 K7–K10 | lease bounded-operation test `[F — planned; not created; not run]` | 待 Step 5 填 |
| O3a 每次只定位一个 latest call 并最多一次 A3 append；tool/hook/provider hit=0 | SESSREC-2 O3a | `T-O3A` `[F — planned; not created; not run]` | 待 Step 5 填 |
| R1 单 transaction、有限 prefixes/refs/derived rows；禁止逐表 commit/spin | SESSREC-2 R1 | rebuild transaction-count test `[F — planned; not created; not run]` | 待 Step 5 填 |
| MIG1 sessions/public rows 各有限遍历一次；busy retry最多3；禁止逐 aggregate commit | SESSREC-2 MIG1 | migration operation-count test `[F — planned; not created; not run]` | 待 Step 5 填 |
| 不在 SQLite transaction/session mutex 持有期间等待 provider/tool/unseal callback | SESSREC-2 §11 | deadlock/liveness harness `[F — planned; not created; not run]` | 待 Step 5 填 |

---

## 9. 安全/副作用契约（部分机械化）

| 契约 | 来源 | 验证（机械化/人审） |
|---|---|---|
| Raw recovery events、receipts、materializations、heads、logs、public projection、SSE/SDK/TUI 禁止 plaintext secret | architecture sealed authority；SESSREC-2 K1–K5 | `T-SECRET-001..008` `[F — planned; not created; not run]` |
| 敏感 material 只能以 `M1.SealedRecoveryMaterialRef` 持久化；plaintext commitment 必须 keyed HMAC，禁止低熵 secret 的无键 SHA-256 | architecture；SESSREC-1 sealed refs；SESSREC-2 K1 | schema/crypto review `[F — planned; not created; not run]` |
| K1/K3/K4/K7–K10 所有 terminal paths 必须 zeroize M4-owned DEK/KEK/plaintext/canonical scratch；callback no-copy 只在 trusted boundary 声明 | SESSREC-2 K1/K3/K4/K9/K10 | zeroization/finalizer tests `[F — planned; not created; not run]` |
| K3 callback、lookup proof、lease、plaintext 不得进入 public DI/HTTP/plugin/tool callback；只允许 core-private M7/M2 capability | SESSREC-2 K3 | capability/type and runtime injection tests `[F — planned; not created; not run]` |
| Errors/logs 只允许 IDs、seq、typed tag、digest短前缀、key version；禁止 raw payload/full digest/nonce/tag/ciphertext/plaintext/credential/KEK/DEK | SESSREC-2 §4.5/§4.6 | log scan `[F — planned; not created; not run]` |
| Public error mapper 只能输出 coarse code/correlation ID；不得泄漏 internal type、aggregate owner、operationID、receipt、digest、head、sealed ref、handle、provider body | SESSREC-1 public errors；SESSREC-2 §4.6/P5 | API/SSE snapshot tests `[F — planned; not created; not run]` |
| `session.recovery.*` 必须在 source definition/manifest/type 层即 internal；仅在 bridge 做 prefix filter 不充分 | architecture publication isolation；SESSREC-2 P1 | manifest set tests `[F — planned; not created; not run]` |
| Public `listen/all/subscribe/durable/readAggregate`、EventV2Bridge、durable sync、instance/global SSE、generated SDK、CLI、TUI、Native V2/shared subscribers 只接受 M1 nominal public carriers | SESSREC-1 public carriers；SESSREC-2 P1–P5；SESSREC-4 | cross-surface nonleak tests `[F — planned; not created; not run]` |
| Trusted private all-durable replay 是独立 nominal capability，不可赋给 public service/manifest/listener/subscription，也不可进 OpenAPI/SDK/SSE | SESSREC-1 §4.5.1a；SESSREC-2 P1/P3 | type/injection tests `[F — planned; not created; not run]` |
| Public sync/history SQL 必须硬编码 `publication='public'` 且使用 public durable decoder；任一 partial decode 丢弃整个 local page | SESSREC-2 P5 | `T-P5` `[F — planned; not created; not run]` |
| M4 internal writers A3/K4/K5/R1/MIG1 不调用 `notifyCommittedPublic`，也不存在 public `notifyCommittedInternal` | SESSREC-2 §8.7 | call graph/static grep `[F — planned; not created; not run]` |
| Safe public projection 是 display-only；M4 在 transaction/rebuild 分配或复用 stable display IDs，M1 projector纯函数不可写表/分配 ID | architecture；SESSREC-1 projection；SESSREC-4 | projection side-effect tests `[F — planned; not created; not run]` |
| Public projection 不得驱动 classifier、CAS、authorization、release 或 replay | architecture；SESSREC-4 | call graph audit `[F — planned; not created; not run]` |
| Session cascade 包含 recovery raw/derived/heads、sealed aggregate/material、lease/journal-owned mappings；不声明 SQLite/WAL/backup 法证级擦除 | SESSREC-2 K6 | `T-K6` `[F — planned; not created; not run]` |
| Production API 禁止 direct mutation M4-owned tables/columns；repair 仅显式 R1 且只 derived state | SESSREC-2 §11.2 | static ownership audit `[F — planned; not created; not run]` |
| Unknown delegate boundary 必须 terminal unknown-delivery，零 cancel/resend；不作 provider exactly-once 声明 | architecture；SESSREC-3 handle gate | transport fault tests `[F — planned; not created; not run]` |
| 扩大 crash fault model 必须重新 architecture review、强制/readback `synchronous=FULL` 或更强并做 fault injection；当前不得暗示已满足 | architecture crash model | configuration/claim audit `[F — planned; not created; not run]` |

---

## 10. 跨实现一致性（机械化 — owner-qualified 类型 / 参考向量 / 跨模块对照）

| 项 | 来源 | 验证 |
|---|---|---|
| M1 独占 schema、closed domains、digest inputs、operation inputs/results/receipts、policy schema、public carriers、public projection schema；M4 不得 local duplicate/alias/cast | architecture M1/M4 ownership；SESSREC-1/2 | export/import ownership audit `[F — planned; not created; not run]` |
| M4 独占 raw authority、SQL mapping、transactions、folds、materializations、heads、owner proofs/views、replay/rebuild、sealed authority/leases/cascade/private publication reads | architecture；SESSREC-2 | owner surface audit `[F — planned; not created; not run]` |
| M2 独占 runtime handle/proofs、reservation、one-time prepare/cancel/authorize/release/cleanup；M4 只调用 owner-qualified validator，不复制 proof shape | architecture；SESSREC-2/3 | type-level API tests `[F — planned; not created; not run]` |
| M6 独占 policy publication/read与 orchestration；M4 first apply 只消费 tx verifier 返回的 committed normalized policy | architecture；SESSREC-2/3 | `T-POLICY` `[F — planned; not created; not run]` |
| M7 独占 recovery lowering/closure reconstruction；只能消费 M4 branded proof slice 和 live lease path，不能消费 plain snapshot/public projection/history | architecture；SESSREC-2 S1/K3；SESSREC-4 | cross-module compile/runtime tests `[F — planned; not created; not run]` |
| M8 独占 public wrappers/UX；只 decode M1 safe projection，不能取得 authority IDs/proofs/raw/private registry | architecture；SESSREC-4 | public boundary tests `[F — planned; not created; not run]` |
| M1 recovery genesis vector 在 C1/A2/S1/R1/MIG1 bit-exact：`event-chain-v1` input恰为 `{kind:"aggregate-genesis",hashVersion:1,aggregateID}` | SESSREC-2 C1/A2/S1/R1/MIG1 | shared reference vectors `[F — planned; not created; not run]` |
| Tool/reasoning phase/provenance/continuation literals在 M1 codec、M3 producer、M4 SQL、A2 fold、S1 view、M7 consumer全链 exact；禁止 near-synonym enum | SESSREC-1；SESSREC-2；SESSREC-3/4 | cross-owner literal vectors `[F — planned; not created; not run]` |
| Digest/reference vectors必须对 M1 25 个 closed domains 及 M4 sealed request/event/blob/authority-row/lease domains bit-exact；不得出现 caller-selected generic domain | SESSREC-1 digest registry；SESSREC-2 §9.4 | digest vector suite `[F — planned; not created; not run]` |
| Inline/sealed canonical replay payload在 producer、raw、SQL、fold、snapshot proof、closure、M7 decode间 carrier/order/commitments exact；sealed projection只承诺 ref/HMAC不含 plaintext | SESSREC-1 replay carriers；SESSREC-2 O3–O5/S1 | carrier reference vectors `[F — planned; not created; not run]` |
| `OperationCommitResultV1<T>`、`ReceiptForV1<T>`、lookup key、expected receipt kind 的 T-indexed mapping exact；cross-type receipt compile/runtime fail | SESSREC-1 operation registry；SESSREC-2 A4/A5/K0a | conditional-type and vector tests `[F — planned; not created; not run]` |
| Seven materialization names、ThreeHeadName、RecoveryOwnedTableName 在 schema、A3、R1、K6、MIG1、audit schema 使用同一 owner constant | SESSREC-2 §4/R1/K6/MIG1 | shared-constant identity test `[F — planned; not created; not run]` |
| Public manifest/public durable writer/private durableReplay 的 set membership 在 M1 assembler、M4 startup integration、P2–P5、M8 surface exact | SESSREC-1 public carriers；SESSREC-2 P1–P5；SESSREC-4 | manifest reference sets `[F — planned; not created; not run]` |
| Cross-owner exactness：session/aggregate/assistant/source/action/operation/candidate/target/handle/generation 任一字段替换都必须在 M4 owner/view/lease/result validation 失败 | architecture；SESSREC-2 A5/S1/K3/K7/K8/O8/O10 | adversarial cross-owner matrix `[F — planned; not created; not run]` |

---

## 反向扩展声明

| 扩展项 | 类型 | 动机 | 向后兼容性 |
|---|---|---|---|
| 无已批准反向扩展 | none | 本 Step 0 不从实现回填任何字段、行为、接口或近义 enum | Step 5 若发现实现存在契约外扩展，默认判为不一致；必须先按 `workflow.md` 更新 architecture/detailed design/owner subplan，经 review/approval 后再同步本表，不能以“兼容扩展”为由自动接受 |

**反向扩展审计**: implementation-only schema/behavior/API scan — `[F — planned; not created; not run]`

---

## Step 5 验证记录（待填）

### 路径 A 自动检查结果

- [ ] `scripts/contract_audit/run_all.py sessrec-2-durable-authority` 全过 — `[F — planned; not created; not run]`
- [ ] JSON Schema 字段、required/nullability、closed enum、nominal owner 对照全过 — `[F — planned; not created; not run]`
- [ ] TypeScript `// # Step P1:` 至 `// # Step P34:` marker 检查全过 — `[F — planned; not created; not run]`
- [ ] Future test ranges `T-C1`、`T-A1..A5`、`T-O1..O10`、`T-S1/S2`、`T-R1`、`T-P1..P5`、`T-K0..K10`、`T-MIG1`、`T-RG`、`T-SECRET`、`T-POLICY` 全过 — `[F — planned; not created; not run]`

### 路径 B Subagent 独立审结果

- [ ] 独立 reviewer 仅接收契约文档、future git diff 与 expectations 列字段；不得提供实现位置列，避免 echo bias — `[F — planned; not created; not run]`
- [ ] `docs/audits/sessrec-2-durable-authority/audit-report.md` 已产出 — `[F — planned; not created; not run]`
- [ ] 0 个 critical / unresolved 项 — `[F — planned; not created; not run]`
- [ ] 警告项处置已记录到 `docs/audits/sessrec-2-durable-authority/decisions.md` — `[F — planned; not created; not run]`

### §5.2 五维度兜底

- [ ] 一致性 — `[F — planned; not created; not run]`
- [ ] 风格 — `[F — planned; not created; not run]`
- [ ] 正确性 — `[F — planned; not created; not run]`
- [ ] 性能 — `[F — planned; not created; not run]`
- [ ] 可维护性 — `[F — planned; not created; not run]`

### Step 5 回填占位

| 项 | 回填值 |
|---|---|
| 实现 commit / revision | 待 Step 5 填 |
| 自动审计命令与结果 | 待 Step 5 填 |
| 独立审查结论 | 待 Step 5 填 |
| 未解决项 | 待 Step 5 填 |
| 最终一致性结论 | 待 Step 5 填 |

---

*本 expectations 由 Step 0 从契约文档独立抽取，禁止从现有实现回填。任何后续修改必须先改契约文档，再同步本表。bug 类契约修复走 `workflow.md §7`；feature 类扩展按 `workflow.md §2.3` 判定续做本子计划或新建子计划。*
