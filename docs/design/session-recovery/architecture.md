# Session 不完整流恢复架构

> Issue：[#7](https://github.com/lihaokun/opencode/issues/7)
>
> 状态：详细设计与四份Workflow Step 0 expectations已批准并推送；D0 package-ownership correction已随commit `085698426f466b6fc01215c4cb34d89b73ef8290`推送，M1-A scalar/nominal foundation已随commit `deb84e90a9051511db3c9ca69f52cacdaf45af2e`推送，M1-B F1/F2 event-definition/publication boundary及97个production/core caller迁移已随commit `8bcb26e5384a22804dd73da7aef85e5f0b4e99e8`推送。当前changeset实现并完成独立review的是M1-C F4 recursive exact field-set boundary；其文档同步与commit/push仍在当前gate。F3、F5–F31、recovery definitions、future acceptance与完整Step 5 audit仍未完成。
>
> 当前设计输入：branch `yixiao-issue-7-new`，D0 gate commit `085698426f466b6fc01215c4cb34d89b73ef8290`，M1-A commit `deb84e90a9051511db3c9ca69f52cacdaf45af2e`，M1-B commit `8bcb26e5384a22804dd73da7aef85e5f0b4e99e8`。50/50运行证据仍只绑定source-equivalent `135f20215`。
>
> 实施提案：`docs/fixes/session-fix-incomplete-stream-recovery.md`。

## 0. 文档权威与状态

文档权威层级固定：实施提案只对需求、根因、产品范围与原始证据清单具有规范性；它不拥有实现schema、接口、ordering、receipt/result或persistence contract。本文、`detailed-design.md`与owner子计划共同构成已批准implementation contract；冲突时不得用proposal旧文本覆盖later design。Owner repair、原设计fresh independent audit、用户批准、四份Workflow Step 0 expectations、D0 review/commit/push、M1-A review/commit/push及M1-B review/commit/push均已完成。当前SESSREC-1 M1-C F4已完成实现、运行验证与独立review，文档同步及commit/push仍在当前gate；不得把该局部实现外推为完整M1、automatic recovery或production readiness。

## 1. 评审基线、证据与产品范围

### 1.1 基线与证据来源

| 项目 | 结论 |
|---|---|
| 当前分支 | `yixiao-issue-7-new` |
| D0 gate / current implementation snapshot | D0已随`085698426f466b6fc01215c4cb34d89b73ef8290`推送，M1-A已随`deb84e90a9051511db3c9ca69f52cacdaf45af2e`推送，M1-B已随`8bcb26e5384a22804dd73da7aef85e5f0b4e99e8`推送。当前changeset只新增schema-owned F4 `validateExactFieldSet`及其runtime/type evidence；未实现F3 recovery event definitions、F5–F31、Legacy/V2 recovery runtime、DB、依赖或lockfile。 |
| 规范输入 | 已提交的 `docs/fixes/session-fix-incomplete-stream-recovery.md` |
| 上游证据 | **No upstream**：未读取或引用上游仓库、上游分支或上游实现。当前 Git tracking remote 不构成架构证据。 |
| 当前源码运行证据 | 在 source-equivalent HEAD `135f2021517a2d4ac6f3dfc8d5e175dd2c0da309`、Bun `1.3.14` 上新鲜执行：A=10 个 CLI，B=1 个 live HTTP/generated SDK，C=10（7 个 prompt + 3 个 TCP processor），D=29（2 个 synthetic processor + 1 个 retry + 22 个 TUI + 4 个 routes）；共 50 项，50 pass、0 fail、0 skip。不得把该结果改写为 future recovery 已验证。 |
| 历史证据关系 | 实施提案记录的 commit `0ea5c2959` 运行结果仅作为更早历史交叉检查；`135f20215` 的新鲜重跑是当前源码行为证据基线。 |
| 当前阶段 | M1-A与M1-B均已commit/push。M1-C F4已完成focused `14/14`（94 assertions）、schema typecheck、non-manifest schema regression `43/43`（383 assertions）、repository Turbo typecheck `30/30`与独立review `[]`；完整schema suite为`43/45`（399 assertions），仍只保留clean D0/M1-A同样复现的`event-manifest.test.ts`既有2项失败（`ServerDefinitions` expected 55 / actual 58及canonical-definition slice mismatch）。当前只剩M1-C文档同步与commit/push；F3、F5–F31、future recovery tests、migration/codegen与完整Step 5未执行。 |

### 1.2 A/B/C/D/S/F 证据追踪

| 等级 | 含义 | 当前可支持的结论 | 不可外推 |
|---|---|---|---|
| A | 真实 `opencode run` 子进程，经 Legacy Session、AI SDK 与 TCP fake provider；其中指定用例另做 SQLite transcript read-back | covered fixtures 中的 incomplete fail-stop、逐项断言的 partial/error preservation、ordinary tool continuation 与 child failure propagation | automatic recovery、通用 replay safety、所有 CLI 输出均已由 SQLite 独立验证、TUI E2E |
| B | live HTTP listener、generated SDK 与 TCP fake provider | public unprefixed Legacy transport wiring | 外部 consumer 产品验收、recovery correctness |
| C | 10项：7个`SessionPrompt`检查 + 3个TCP processor检查 | 仅covered prompt/TCP processor直接断言的Legacy settlement与provider-call behavior | dispatch ledger、CAS、replay proof、未被这10项直接断言的transport性质 |
| D | 29项：2个synthetic processor + 1个retry + 22个TUI + 4个routes | 精确断言覆盖的synthetic processor、retry、handler wiring、render/sync mechanics与policy behavior | 产品 E2E、recovery correctness、durable-before-execute、runtime authorization |
| S | 当前 HEAD 源码与 pinned dependency 的静态检查 | `[S — source seam only]`：调用关系、显式配置与 dependency default | 任何运行结果、请求次数、时序保证或产品行为证明 |
| F | 尚不存在的 future contract | `[F — planned; not created; not run]`：本文定义的proof obligation与验收边界；无当前执行结果 | 任何当前生产保证 |

当前 HEAD 的50项运行检查精确记为`A=10 B=1 C=10(7+3) D=29(2+1+22+4)=50`。Retry只归入D，不归入C。它们只支持逐项测试直接观察与断言的A/B/C/D结论；源码和pinned dependency的`[S — source seam only]`结论不计入这50项，也不构成运行证明。测试通过不得外推为未被断言的通用性质。本文新增的typed recovery、dispatch ledger、三个recovery CAS heads、paused transport gate、replay rebuilder、budget、wire projection和recovery TUI行为均为`[F — planned; not created; not run]`设计义务，无当前执行结果。

### 1.3 规范产品范围

| 路径 | 本文范围 |
|---|---|
| Legacy CLI | `opencode run`、normal prompt、进入模型的 command、ordinary continuation、child/subtask；通过公开 unprefixed Session operations。 |
| Legacy TUI | TUI 通过 generated SDK 调用公开 unprefixed operations；需要 backend、sync、renderer 与 production submission 的分层验收。 |
| Public operations | `session.prompt`、`session.prompt_async`、`session.command` 进入 serialized model recovery；`noReply`进入同一session queue并先以type-10 no-reply supersession或exact no-unresolved-source branch解析旧recovery，然后只commit user message；`session.shell`保持serialized compatibility，provider recovery为N/A。 |
| Shell | **N/A**：shell本身不创建provider stream。它仍进入per-session serialized submission queue，但绕过supersession recovery、policy freeze、M7/M2、N/M与model admission。shell synthetic assistant不进入model recovery chain、不分配`assistantSequence`且不消耗`M`；不得把它当recovery source/tool closure。 |
| Experimental native LLM | `OPENCODE_EXPERIMENTAL_NATIVE_LLM=true` 是 **Legacy 的 alternate transport**，不是 Native V2 Session。首批无同等 gate/proof 时 fallback、disable 或 opaque + ManualStop。 |
| Native V2 Session | 排除于 normative recovery scope；不新增 V2 recovery 模块、流程、spec、专属 recovery tests 或子计划。 |
| Shared regression | shared schema、LLM contracts、SQLite/EventV2 plumbing 的兼容修改必须运行 Native V2/shared regression，证明未回归；这不是 V2 recovery 产品验收。 |
| 外部 API/SDK consumer | 不属于 Issue #7 产品行为验收，但 public Legacy wire/OpenAPI/generated SDK compatibility 必须保持。 |

## 2. 目标与非目标

### 2.1 核心目标

| ID | 目标 |
|---|---|
| G1 | canonical incomplete 与无可信 final settlement 的 clean EOF 都形成 typed terminal failure，原 attempt 永不伪装成功。 |
| G2 | 自动恢复只在 source dispatch、provider replay、local-tool replay、planned request、admission 与 binding 全部可证明时释放 provider 请求。 |
| G3 | `SafeRetry` 创建新 model assistant，排除失败 attempt 的 partial text、reasoning、tool fragments 与 StructuredOutput。 |
| G4 | `ContinueAfterSettledTools` 创建新 model assistant，仅降低为 provider-valid 最小 settled-tool closure，不重放工具。 |
| G5 | 普通eligibility unavailable、未结算、过期或预算耗尽按closed classification走ManualStop/cancel；corrupt、partial、owner-mismatched、non-foldable、unresolved-ambiguous authority及无法安全resolve的ownership/persistence状态在进入M5前fatal stop。 |
| G6 | Legacy 本地工具完整 call 必须在任何 hook 或副作用执行前 durable。 |
| G7 | recovery lineage、assistant attempt、semantic dispatch 与 decision/child link 可追踪、连续且无分叉。 |
| G8 | raw event authority 可跨数据库重建 materializations、三个 recovery CAS heads 与 public projections。 |
| G9 | automatic recovery受`N`约束；同进程model-assistant admission统一要求`assistantSequence < effectiveM`。该值只由M1配置规范化从`configuredM`与optional `agent.steps`导出；runtime admission authority只能读取transaction-verified committed `NormalizedRecoveryPolicy.digestInput.effectiveMaxModelAssistants`，不得重算；shell synthetic assistant明确排除，二者均不冒充physical-request budget。 |
| G10 | public error、wire、SDK 与 TUI 保持兼容，内部 authority 不泄漏。 |
| G11 | Anthropic/OpenAI continuation 按实际 protocol、storage mode 与 audited lowering 区分，不能从通用消息形状猜测安全。 |
| G12 | context overflow、普通 transport retry、interrupt、permission denial、compaction、max-step 与 incomplete recovery 保持正交。 |

### 2.2 非目标

本文不承诺：

- provider dispatch 的任意 crash exactly-once；
- clustered/distributed Session ownership 或 split-brain 协调；
- global durable agent-step 或 physical-provider-request budget；
- 通用 timeout、watchdog、transport retry 重构；
- 在无明确幂等/续传契约时自动恢复 hosted tool；
- 自动支持所有动态 provider factory、middleware 或 transport rewrite；
- 新 public incomplete error discriminator；
- Native V2 recovery 行为、流程、spec 或产品验收。

## 3. 当前源码接缝与信任边界

以下是 HEAD `135f20215` 的架构接缝，不表示 future contract 已实现。

| 接缝 | 当前职责 | 架构影响 |
|---|---|---|
| `packages/opencode/src/session/prompt.ts` | Legacy assistant admission、外层 loop、ordinary continuation、command/shell 与 StructuredOutput 生命周期 | recovery coordinator、new assistant identity、N/M admission、attempt-local reset 与 supersession 的主要宿主 |
| `packages/opencode/src/session/processor.ts` | 消费 LLM batches、持久化 parts、tool settlement、clean EOF 检查与 outer retry | typed terminal settlement、drain-before-classify、dispatch ambiguity 与 fail-closed 边界 |
| `packages/opencode/src/session/llm/ai-sdk.ts` | AI SDK event 适配，识别 canonical incomplete | 必须产生 typed `incomplete-stream` 且继续 `retryable:false` |
| `packages/opencode/src/session/llm.ts`、`session/llm/request.ts` | Legacy transport 选择、高层 request preparation 与 AI SDK invocation | 当前 preparation 尚不是 exact paused request；future gate 必须位于最终 transform 与 network release 之间 |
| `packages/opencode/src/session/tools.ts` | AI SDK tool `execute()` 与 plugin/tool side effects | 当前不能证明 durable-before-execute；必须由 typed execution gate 包装 |
| `packages/opencode/src/session/message-v2.ts` | Legacy history lowering；当前跳过普通 errored assistant | `SafeRetry` 可复用该排除原则；`Continue` 需要 recovery-specific closure lowering |
| `packages/opencode/src/provider/transform.ts` | provider options 与 OpenAI Responses storage/item-ID transform | planned digest、effective storage mode 与 OpenAI continuation 可用性的组成部分 |
| `packages/llm/src/protocols/anthropic-messages.ts`、`openai-responses.ts` | shared protocol serializers/lowerers | 可作为 closure validator/canonicalizer 的实现基础，但只有与 actual Legacy no-send lowerer或 exact capture gate 共用时才构成 runtime proof |
| `packages/core/src/event.ts`、`packages/core/src/session/sql.ts`、`packages/core/src/database/migration/` | durable event transaction、Session SQLite schema 与 migrations | raw authority、projector、commit CAS、rebuilder 与 materialization ownership |
| `packages/opencode/src/event-v2-bridge.ts` | 当前 enrich 并把所有 EventV2 events 广播到 `GlobalBus`，durable event 还会产生 `sync` envelope | 当前**不是** internal-only；future recovery authority 必须采用 internal-only publish seam 或明确的 bridge/publication filter，且不得泄漏到 public/shared subscriber |
| `packages/schema/src/llm.ts`、`packages/schema/src/v1/session.ts` | shared contracts 与 Legacy durable/public envelopes | 单一 schema source；禁止 llm/opencode 复制独立 recovery unions |
| Legacy server route、generated SDK 与 TUI Session/prompt/sync/render | public unprefixed transport与用户可见 transcript | 只消费 public projections/既有 signals，不能收到 internal recovery transitions |

当前关键事实：

1. `publish/update` 成功返回后的 durable event/message/part 才是证据；内存字段赋值不是证据。
2. 当前 HEAD 的covered CLI、`SessionPrompt`与TCP `SessionProcessor`检查观察到各自直接断言的canonical incomplete fail-stop；仅D级retry unit直接断言canonical incomplete error的`SessionRetry.retryable(...)`返回`undefined`。retry不归入C；future合同继续禁止使用generic retry重跑旧processor。
3. Legacy AI SDK 可能在 processor durable observation 前执行工具；part 缺失不证明 side effect 未发生。
4. 当前 exact endpoint/authority/wire body 可能在 high-level preparation 后继续被 provider factory、middleware、transform 或 fetch wrapper 修改。
5. 当前 provider contract 不普遍证明 attempt-wide idempotency 或 durable-prefix continuation。
6. current public Legacy terminal error 是 `UnknownError`；本文不改变其 discriminator。

### 3.1 Current S reuse

以下复用项都只是`[S — source seam only]`，不计入50项运行证据，也不证明future recovery合同已实现：

- `packages/core/src/event.ts`既有SQLite immediate transaction/event publication service作为M4 raw append与same-transaction materialization的承载接缝；future实现必须新增dedicated recovery authority与source-level internal/public partition，不能把现有generic public event直接升级为recovery authority。
- `packages/opencode/src/session/message-v2.ts`现有ordinary history lowering及跳过errored assistant的原则可供SafeRetry复用；M7仍须以snapshot-owned exact mapping机械排除source，不能把现有行为外推为Continue closure proof。
- `packages/opencode/src/provider/transform.ts`与shared Anthropic/OpenAI protocol lowerer可供exact target/storage/closure canonicalization复用；只有与M2 final no-send capture及same-object inspection validation绑定后才形成future authorization evidence。
- Legacy unprefixed HTTP/generated SDK/sync/hydration/render路径可承载M8 public decode与展示；M8只消费M1 F30 public decode结果，不读取M4 raw/materialization/head/receipt或分配display ID。
- 现有Session SQLite migration、cascade与read-back接缝可供M4 owner/rebuilder复用；stable display-ID allocation/reuse仍由M4 transaction/rebuild路径拥有，M1 F28保持pure。
- 当前SQLite WAL使用`synchronous=NORMAL`；该`[S — source seam only]`只支持本文选择的validated process-crash fault model。本文不把transaction success外推为host crash、power loss、filesystem/device cache loss或storage corruption后的持久保证。

## 4. 核心概念与数据模型

### 4.1 五级 identity

| 层级 | 定义 | 计数/约束 |
|---|---|---|
| Logical recovery chain | 一次用户工作及其 incomplete-triggered successors | `chainID`；new user input 创建新 chain |
| Model assistant attempt | 一个进入Legacy model processor的durable assistant message与processor生命周期；shell synthetic assistant不属于该identity | `assistantSequence` 在model recovery chain内从0连续递增 |
| Semantic dispatch | 一次 Legacy model invocation 的语义请求 | `dispatchOrdinal` 在 assistant 内从 0 连续递增 |
| Model step | 同一 invocation 内由 SDK stop condition控制的 provider step | `[S — source seam only]`：当前 Legacy `streamText()` 调用未传 `stopWhen`，pinned `ai@6.0.168` 默认 `stepCountIs(1)`；50 项运行检查未普遍断言每个 invocation 的精确 step 数，且这不是 recovery budget |
| Physical provider request | transport 实际 HTTP/stream hit，包括 SDK 或外层 retry | 不由 `N`/`M` 直接计数 |

`RecoveryLineage` 持有 `chainID` 与只统计 incomplete child 的 `recoveryOrdinal`。`AssistantAttemptIdentity` 持有 `assistantID` 与所有 admitted assistant 共用的 `assistantSequence`。`DispatchAttemptContext` 把二者绑定到每一条 dispatch ledger entry。

初始 assistant 使用 ordinal/sequence 0；ordinary continuation 保持 `recoveryOrdinal`、递增 `assistantSequence`；incomplete child 同时递增二者。每一个实际 model step 及任何会改变 lowered request body 的 SDK resend都必须在 network release 前登记为独立 semantic dispatch ordinal；adapter若无法逐 step 暂停、计数并绑定 exact request，则对应 evidence 为 opaque。automatic source必须只有一个 available ordinal-0 dispatch，且其 proof机械证明该 invocation没有未登记的后续 step/resend；多个 dispatch、缺口或未知数量都不具备 automatic source资格。

### 4.2 Target、authority domain 与 sealed reference

完整 `DispatchTarget` 至少覆盖：

- provider ID；
- route ID；
- protocol；
- normalized endpoint/deployment/region ID；
- account/project/tenant/credential authority 的稳定非 secret ID 或版本化 digest；
- model ID；
- provider contract 要求时的 model family。

`ProviderSafetyDomain` 使用同一组 provider、route、protocol、endpoint 与 authority 字段；幂等或续传只在 contract 声明的 model/model-family 范围内有效。所有必填字段结构化完全相等才算 target 属于 domain；禁止 display name、prefix 或当前配置猜测。

敏感 replay material（包括raw idempotency key、continuation cursor，以及provider contract认定不可公开的reasoning signature/encrypted state）只能通过 `SealedRecoveryMaterialRef` 表达，包含opaque ref ID、canonical digest与key version。M4拥有session/assistant/target scoped sealed-store API：seal/write与引用authority同事务或通过可恢复的两阶段commit绑定，enforce最小权限、key rotation/旧版本读取策略、session cascade删除、日志/异常/crash dump脱敏，并在release/cancel后清除runtime plaintext。raw material不得进入EventTable payload、materialization、canonical envelope、日志、public SSE/SDK/TUI state；runtime只有在gated preparation内unseal并重新验证digest后才能使用。不可安全seal/unseal、版本不可读或scope不匹配时proof unavailable。允许公开保留的provider metadata必须由单独allowlist定义，不能因现有message metadata字段存在就绕过sealed合同。

Automatic reconstruction另受M4 nominal sealed-use lease约束。M2先为stable type-9 operation ID生成`reserved-no-send`的`PreparedHandleCommitmentReservationV1`，随后M4 K7 `acquireSealedRecoveryUseLease`必须在任何unseal、automatic semantic lowering或actual provider preparation之前完成；lease只允许`absent -> live -> closed`，绑定same-view proof、closure、ref/generation与prepared-handle commitment。Type-9 first application在cursor/raw commit前执行K8 transaction validation，release前再执行一次immediate K8 validation；K4/K5遇同ref/generation live lease必须拒绝rotate/redact。release、mechanical cancel、abandonment、lost-handle cleanup及所有失败terminal path均执行K9 close并zeroize；K10只在exclusive dead-process liveness fence下清理。禁止TTL expiry、renew、reopen、旧handle revival或按wall-clock/heartbeat推断进程死亡。

### 4.3 Dispatch ledger

每个 semantic dispatch 在 provider network release 前写 authoritative ledger：

- **available evidence**：exact target/authority、normalized storage mode（`true` / `false` / `unknown`）、semantic digest、prepared digest、replay fence、capability summary、origin 与 context；
- **opaque evidence**：provider/model、是否提供local tools的已知程度、typed introspection failure，以及由gate内部生成但不声称语义可检查的opaque handle commitment；不得伪造target、semantic/prepared digest或replay proof。

ledger 以 `(sessionID, assistantID, dispatchOrdinal)` 唯一，ordinal 连续且由 CAS append。automatic recovery 只接受恰有 ordinal 0 的唯一 available source dispatch。opaque initial/ordinary request在 mechanical gate 已实现时仍可发送，但其 incomplete outcome固定 ManualStop。

### 4.4 分离的五类恢复对象

| 对象 | 内容 | 权威性与生命周期 |
|---|---|---|
| `DurableRecoveryAuthorityViewV1` | M4 nominal same-WAL authority view：`DurableRecoverySnapshot`、`RecoverySnapshotIdentityV1`与`SnapshotBoundToolEligibilityV1`；snapshot含terminal fact、完整dispatch ledger、四路tool evidence partition、tool/reasoning replay carriers、frozen source version、control tail、durable continuation、既有decision/consumption及internal-assistant→public-message mapping | 只能由M4完整加载并branding；automatic consumer必须取得同一view的nominal `AutomaticRecoveryProofSliceV1`。mapping与proof slice均绑定same snapshot identity；不含当前config推导、planned target、runtime handle或plaintext |
| `PlannedRecoveryMaterialization` | closed runtime wrapper：available exact为`{descriptor, pausedHandle}`，descriptor绑定automatic-recovery action/context、exact target/storage、semantic/prepared digest、replay fence、capabilities、provider authorization、closure与`pausedHandleDescriptor`；unavailable exact仅为`{descriptor}`并携typed cause/planning/no-handle commitment | runtime-only planning result；raw linear handle不进入descriptor、digest、log或durable state；网络仍为0 hit；storage `undefined`必须归一化为`unknown`；unavailable不得虚构target/digest/authorization/closure或live handle |
| `AdmissionPlan` | exact next context、expected chain head、normalized `N`、committed `NormalizedRecoveryPolicy`及其`digestInput.effectiveMaxModelAssistants`、`assistantSequence < effectiveM` admission predicate、control-tail policy，以及exact `scopeKey/epoch/policyDigest/defaultSemanticsVersion` policy binding | classifier输入；first application transaction必须按session policy scope重读并验证committed policy，runtime只消费其已提交的effective bound，禁止重读config、直接访问top-level field或重新执行`min(configuredM, agent.steps)`；exact replay只验证stored historical policy |
| Proposal / Record | pure classifier产生proposal；ManualStop/finalization transition可形成finalized record；automatic action只由child-admission-and-consumption composite transition分配stable decision ID/revision并直接形成consumed record | proposal无durable authority；automatic record不存在active-without-child中间态；append-only revisions可consumed/superseded/finalized |
| Public projections | optional、versioned display schema：dispatch count、typed availability summary、source error保留状态、child link的非authority display ID与latest effective outcome；字段默认omit而非伪造false/zero，枚举unknown可解码 | rebuildable display only；不得包含target/authority、ledger ordinal明细、digest、proof、decision binding/consumption、CAS或sealed ref，也不得作为classifier、CAS或release输入 |

`RecoverySourceVersion` 冻结 terminal/tool/reasoning/dispatch source facts提交时的 aggregate high-water。它同时绑定：截至该 high-water 的完整 aggregate event hash chain，以及只从该 source assistant 的版本化 recovery source event/field set提取的 facts digest。`RecoveryControlTailVersion` 从 source high-water exclusive 到当前 high-water inclusive，绑定 exact sequence range、实际 tail hash、允许的 control event/field set版本与空 tail genesis。允许的 control语义仅为ManualStop/finalization/supersession revision与atomic automatic child-admission-and-consumption；任何普通input/config/history/tool event、未知 `session.recovery.*` type、缺失/额外 authority field、gap、duplicate或不识别版本都使旧binding stale或authority invalid。

Continue所称“三处prefix”固定为：frozen `RecoverySourceVersion` 中的 provider-prefix checkpoint、`DurableRecoverySnapshot` 中的 durable continuation checkpoint、planned authorization/proof中的 checkpoint。三者必须全部存在、canonical equal，并共同满足session/aggregate、source assistant、high-water、hash version/digest与ancestry；missing、extra或mismatch均fail closed。

### 4.5 三类 digest

| Digest | 绑定内容 | 明确排除/用途 |
|---|---|---|
| Semantic digest | exact target/authority、final tool definitions、wire-semantic provider/model options、实际 lowered system/history/body | 排除 decision/child identity、lineage link、proof envelope、timestamp；`SafeRetry` 要求 planned 与 source 相等 |
| Prepared digest | semantic payload，加 source fence/capabilities、当前 recovery authorization commitment 与 Continue closure | 绑定这一次 exact prepared dispatch；不要求与 source prepared digest相等 |
| Binding digest | source assistant/version、exact `RecoveryControlTailVersion`、candidate context、action、target、semantic/prepared digest、authorization、closure、`N`/`M` admission、`scopeKey/epoch/policyDigest/defaultSemanticsVersion` 与 control policy | 绑定 proposal/record/receipt；tail或policy binding任一组成变化使新提交stale；已提交operation的exact replay按stored historical binding验证 |

三类 digest 都有版本化 canonical encoding。对象 key insertion order 不影响 digest；secret raw value 不进入 canonical input；任何被声明的语义字段变化必须改变对应 digest。M1 closed registry精确含25个domain，其中包括`supersession-binding-v1`、`provider-authorization-proof-v1`、`control-policy-v1`、tool/reasoning/provider-prefix commitments及其它owner列出的closed domains。`PreparedDigestInputV1`是三分支closed union：`initial`与`ordinary`共享final request/context/replay/capability/authorization/paused-handle commitment字段且禁止source/closure字段；`automatic-recovery`另且仅另含source version、action、closure与closure digest。`BindingDigestInputV1`按`automatic | manual-stop` branch-exact：automatic绑定target/semantic/prepared/authorization/closure；ManualStop绑定canonical causes/reasons、planning evidence、closure status、policy/admission/heads/control policy与handle-closure commitment，并明确禁止target/semantic/prepared/authorization/closure digest字段。type-10两branch使用`SupersessionBindingDigestInputV1`：common绑定session、source/control versions、submission payload digest与aggregate/recovery predecessors；model另含intended type-1 operationID，no-reply另含`replyDisposition:"commit-user-only"`。它不含policy/assistant/dispatch/prepared或future完整type-1 payload。完整字段membership、builder名称与registry tests只由`sessrec-1-contract-canonicalization`定义；本文不复制第二份表。任何架构要求的commitment若无registered builder均视为合同不完整，不能由cast补造。

### 4.6 Typed durable terminal settlement

terminal settlement 由两条入口合流：

- adapter 发出的 canonical `incomplete-stream`；
- processor drain 后发现没有可信 final step settlement 的 clean EOF。

processor 必须先等待已登记工具，持久化 input/call/execution/settlement/interruption 与 reasoning provenance，再提交不含 decision 的 typed terminal fact。terminal fact成功提交后 reload snapshot；提交、reload 或 projection consistency 任一步失败，当前进程停止且不发起 recovery provider call。

public assistant仍投影既有`UnknownError`，并保留三类exact message：canonical adapter incomplete为`Provider stream ended without a terminal finish event`，clean EOF无settled step为`Provider stream ended without a settled model step`，empty unknown为`Provider stream ended with an unknown finish reason and no usable output`。Fatal/indeterminate sanitizer固定`Session recovery stopped before a safe final result`。Internal typed terminal、classification、ledger和proof不改变public discriminator。

### 4.7 Tool 与 reasoning evidence

M1 `CanonicalToolEvidencePartitionV1`把完整tool collection分成total、disjoint四路：

- `truly-empty`：`authoritative=[]`且`compatibility=[]`；
- `authoritative-only`：authoritative非空且compatibility为空；
- `compatibility-only`：authoritative为空且compatibility非空；
- `mixed`：两者均非空。

M4 `SnapshotBoundToolEligibilityV1`与nominal `AutomaticRecoveryProofSliceV1`绑定same `RecoverySnapshotIdentityV1`。SafeRetry只接受`truly-empty`；Continue只接受`authoritative-only`且每个tool phase均为`final-after-hook-settled`。`compatibility-only`、`mixed`、`manual-only`及任一nonfinal phase全部fail closed，不能因automatic proof数组为空而误判成zero-tool。

每条authoritative tool evidence使用五个durable phase：`planned`、`body-outcome-durable`、`final-after-hook-settled`、`reconciled-terminal-manual-only`、`unknown-intermediate`。所有phase均禁止重跑body/after-hook；只有`final-after-hook-settled`具`continue-only` eligibility。Restart对`planned`、`body-outcome-durable`或`unknown-intermediate`只可通过M4 O3a `reconcileInterruptedToolExecution`追加`reconciled-terminal-manual-only`：body、after-hook与provider调用次数都为0，只保留已durable outcome/carrier，不发明未知outcome。该phase关闭terminal barrier但永久禁止automatic recovery。

Tool replay payload使用M1 `RecoveryReplayPayloadV1`/`ToolTerminalReplayPayloadV1`：inline carrier只能保存secret-safe canonical wire value或UTF-8 text，必须strict decode、canonical re-encode并要求byte equality；敏感leaf只能保存`SealedRecoveryMaterialRef`，并在exact K7 lease保护的K3 dynamic scope内访问。M7必须按proof中的provider-prefix/tool/reasoning event sequence合并exact total order，并重算tool plan/call/result、reasoning text、provider prefix、ancestry与closure所有owner commitment。Legacy history、cache、public projection/current provider state或任何public data都不能补充replay authority。

可选 `providerExecuted` 缺失不能解码为 false。旧数据缺字段、definition 不可解析或事实冲突都投影 unknown。Reasoning evidence区分 natural provider end、step-boundary forced flush 与 cleanup forced flush，并durable保存M1 exact continuation mode（none/signed/stored-reference/unknown）。M1冻结tool execution/input/call/settlement/interruption/provider-executed与reasoning provenance/continuation mode的exact V1 literal domains；M3产生、M4持久化时必须直接使用这些literal，或使用覆盖全部source值、unknown失败的total versioned mapping，不能在read时从SDK/provider近义词猜测。只有 provider-end 且continuation mode与目标 protocol要求的 signature/encrypted state/metadata一致的 block默认可进入 Continue closure。

### 4.8 唯一 authority 与 rebuildable materializations

唯一权威关系：

```text
raw EventTable 中 dedicated recovery aggregate上的serialized internal session.recovery.* transitions
  = sole canonical replay authority

append-only relations / decisions / consumptions / dispatch ledger / projections
  = transactionally rebuildable materializations

three recovery CAS heads
  = derived online concurrency indexes

aggregate event head/cursor
  = raw append position, semantically distinct from the three recovery heads

assistant public projections
  = rebuildable display state
```

每个内部operation都具有caller在首次提交前生成的稳定 `operationID`，并绑定dedicated recovery aggregate、operation type、canonical payload digest与expected predecessor；同一aggregate内同一`operationID`不得绑定不同payload。每个durable recovery definition的aggregate selector精确读取operation envelope顶层`aggregateID`，不得使用payload `sessionID`选择aggregate。M4维护并验证`RecoveryAggregateID ↔ sessionID`一对一owner mapping；row selector、envelope.aggregateID与payload session owner任一不一致均authority invalid。M1 `RecoveryOperationLookupKeyV1<T>`把lookup identity固定为`sessionID + aggregateID + operationID + expectedOperationType`；M4 `lookupRecoveryOperationResult`还必须接收完整expected input、expected payload digest与expected receipt kind，先验证owner mapping，再以`(aggregateID, operationID)`及operation kind做scoped lookup。operationID-only或跨aggregate result cache禁止。aggregate sequence由M4在transaction内分配。commit响应丢失时，exact scoped match返回原operation、`applyMode:"exact-replay"`、folded operation post-state与stored receipt组成的完整`OperationCommitResultV1<T>`；valid scope内missing才可按同ID/payload重交，owner mismatch/conflict/partial/corrupt fail closed。detached receipt只有观察意义。

内部 transition 至少覆盖 initial-chain-genesis-and-dispatch、ordinary-assistant-and-dispatch-admitted、subsequent source dispatch、tool/reasoning evidence、provider prefix、incomplete terminal、decision revision、finalization及 child-admission-and-consumption composite operation。initial/ordinary在runtime先预分配无authority的candidate identity并prepare paused request；`initial-chain-genesis-and-dispatch`表示model-lineage genesis：它原子创建sequence 0 assistant、chain relation、assistant-chain genesis head、ordinal-0 ledger与dispatch head；其recovery aggregate predecessor始终是exact current `AggregateEventHeadV1`，只有aggregate首条operation才是aggregate genesis，post-type-10时必须等于type-10 post head。它验证existing Legacy user message且不重建user row。`ordinary-assistant-and-dispatch-admitted`绑定expected chain head并原子创建immediate successor、推进chain head、写ordinal-0 ledger与dispatch head。prepare失败时没有assistant admission、`M`消耗或head残留。它们与recovery child operation一样按aggregate sequence、版本化field sets与完整event hash chain canonicalize，成为rebuild所有model-assistant sequence/head和initial dispatch的唯一来源。

`session.recovery.*`只能进入raw `EventTable`和internal projector/rebuilder。M1在definition partition时只给literal `publication:"public"` definition及其payload/cursor/listener/subscription/read-error/service/public manifests构造public nominal carriers；trusted private all-durable replay manifest是separate nominal set，可含internal但不能传入public surface。由此`listen`/`all`/typed subscribe/public durable read、instance/global SSE、`EventV2Bridge`、durable `sync`与所有shared/Native V2 subscriber在source/type上默认拒绝internal；边界filter只是defense-in-depth，只在GlobalBus或bridge emit处过滤不足以满足合同。外部只看到安全projection与既有message/session signals，验收必须同时观察上述每个通道并证明raw authority仍可由trusted rebuilder读取。

Recovery authority采用dedicated aggregate不等于迁移整个public EventTable。既有generic public aggregates、event definitions与writers保持其原selector/schema/sequence合同，不强制增加`RecoveryOperationEnvelope`、operation payload digest、recovery event-chain digest或three-head字段；mandatory recovery authority chain fields/contracts只施加于recovery aggregate与sealed-material authority aggregate及其trusted writers。generic public event仍可进入其原durable/public manifest，不能被M4 recovery rebuilder误当recovery-chain row。

### 4.9 三个 recovery CAS heads

| Head | 保护对象 | 成功条件 |
|---|---|---|
| `recovery_head(sessionID, sourceAssistantID)` | decision series 的 revision、finalization、consumption、supersession | expected predecessor精确匹配，affected rows = 1 |
| `assistant_chain_head(sessionID, chainID)` | initial/ordinary/recovery model assistant 的唯一 immediate successor；不包含shell synthetic assistant | genesis要求head不存在且candidate sequence=0、chainID绑定initial assistant；successor要求expected current head精确匹配、candidate sequence=current+1且source仍是head；insert/update affected rows均精确为1 |
| `dispatch_ledger_head(sessionID, assistantID)` | 每个 semantic dispatch 的唯一 immediate ordinal | expected ordinal predecessor匹配，无 duplicate/gap |

Initial/ordinary composite admission-dispatch与automatic child都必须先追加各自serialized authoritative operation。Type-1的assistant-chain与该initial assistant自身的ordinal-0 dispatch-ledger predecessors固定genesis/absent，但aggregate predecessor为exact current aggregate event head/cursor；type-9则必须引用exact committed source/current assistant predecessor，只有child自己的ordinal-0 ledger predecessor为genesis。它们再由同一publication transaction的projector/materialization、相关recovery heads CAS与aggregate event head/cursor推进落地。Initial composite CAS-insert genesis assistant-chain head并创建sequence 0 assistant、ordinal-0 ledger及dispatch-ledger head；ordinary composite CAS expected assistant-chain head并创建唯一immediate successor、ordinal-0 ledger及dispatch-ledger head；automatic child另同时处理recovery head、decision consumption与同样的assistant-chain/dispatch-ledger写入。任一CAS失败都回滚operation event、assistant/message relation、ledger、projection、三个recovery heads的相关更新与aggregate event head/cursor；因此rebuilder可只从raw operations重建每条chain、初始dispatch及aggregate cursor历史。

### 4.10 Projector、commit 与 rebuilder

| 组件 | 职责 | 禁止事项 |
|---|---|---|
| M4 fold/materialization/display allocation | M4从validated raw prefix执行deterministic fold；operations 8–10由canonical payload+envelope重建decision，1/2/9导出Legacy assistant/message materialization；在first-application transaction及rebuild路径分配或复用stable display ID，并构造供M1消费的validated public-authority view/display mapping | 不把materialization或display mapping变成第二authority；不把display-ID allocation委托给M1/M8；不从public projection反推raw |
| Pure M1 public projector | M1 F28 `projectRecoveryForPublic`只从M4已验证的`M1.RecoveryPublicAuthorityViewV1`（已含M4分配的stable display mapping）构造`M1.ContractResult<M1.RecoveryPublicProjectionV1 \| undefined, M1.PublicProjectionViolation>`；`undefined`只表示无可公开字段 | 不写任何表、不分配或复用display ID、不读clock/runtime record/M4 store，不把projection变成authority；error阻止publication |
| M8 public decode/hydration | M8只沿public path调用M1 F30 `decodeRecoveryPublicProjection`，再做Legacy hydration/display与typed malformed handling | 不读取raw、materialization、head、receipt、sealed ref；不另造projection schema或分配display ID |
| Recovery heads + aggregate cursor commit | 首次应用operation时，在event publication transaction内按operation原子CAS所需recovery heads并推进aggregate event head/cursor，且每个insert/update affected rows必须=1；任一失败使fold/materialization、event row、sequence、projection、相关recovery heads与cursor全部回滚。exact same serialized operation重放时，只有raw event/payload/sequence、materializations、所有相关recovery heads及aggregate cursor都已精确等于folded post-state，才允许无副作用no-op | 不产生第二serialized authority；不得把0-row CAS自动当幂等成功，partial match、head/cursor mismatch或不同payload仍fail closed |
| Recovery replay rebuilder | 直接按raw aggregate sequence fold，重建/校验relations、stable display mapping、public projections、三个recovery heads与aggregate event head/cursor；完整prefix finalization前suppress live publication | 不从materialization反写或选择raw event branch，不从public projection修复authority；display ID仅按M4 owner规则稳定复用 |

same serialized event只在raw event/payload/sequence、全部materializations与相关heads已经精确处于该operation的folded post-state时，才可幂等no-op接受；这不是放宽首次CAS的affected-row=1要求。immutable authority receipt不记录任何应用模式；仅ephemeral M1 `OperationCommitResultV1<T>`含`applyMode:"first-application"|"exact-replay"`。same sequence different payload/type、partial materialization、unknown event/version、branch、gap、duplicate transition、orphan relation、multiple-effective revisions或head mismatch都 fail closed。session显式删除可按现有 cascade 删除整个 recovery aggregate及materializations。

本文所有“durable”“durable-before-execute”与crash/replay theorem都严格限定为validated process-crash fault model：SQLite transaction已向当前进程成功返回，数据库文件/OS仍可用，且不发生host crash、power loss、filesystem/device cache loss或storage corruption。当前candidate不要求把SQLite WAL提升为`synchronous=FULL`或更强，因此不声称这些excluded fault之后仍保留authority。若后续要把automatic release或tool side-effect fence扩展到该fault set，必须返回架构审查，明确要求并在release前验证FULL-or-stronger durability（含部署/PRAGMA enforcement与fault-injection expectations）；不能仅凭generic EventTable transaction或public aggregate作出保证。该fault-model限定不改变dedicated recovery aggregate边界：generic public EventTable aggregates不迁移、不加入recovery hash chain，也不被M4 rebuilder当作recovery authority。

candidate identity到待写committed字段的计算必须是pure transaction-local `deriveCommittedIdentity(candidate,envelope)`；其返回值在transaction commit前仍无authority，不能作为receipt/source/public输入。M4 first application在同一transaction完成raw append、projector与heads后，只有commit成功及commit result/read-back验证才可brand并暴露committed identity；rollback使derived value失效。first application同时检查current session policy scope与`scopeKey/epoch/policyDigest/defaultSemanticsVersion`，并只使用该committed normalized policy的`digestInput.effectiveMaxModelAssistants`执行`assistantSequence < effectiveM`检查；不得在M4 transaction内从runtime `configuredM`/`agent.steps`重新计算。exact replay验证stored historical policy与folded post-state，不因current policy后来变化而否定历史commit。

Initial、ordinary与subsequent nonautomatic authorization input必须包含complete result与same paused handle；M2只把`result.receipt + result.operationPostState + pausedHandleCommitment`交M1 F26。Automatic type-9 authorization package必须包含complete result、exact M5 proposal、original available planned materialization、same `PreparedHandleCommitmentReservationV1`、same live handle与same live leases；O8 first application已执行transaction K8，release前还必须完成immediate K8。M2只把F27 exact参数交M1，F27验证descriptor commitment；M2随后机械匹配result/planned/reservation/raw handle与leases。F27 exclusively保留给automatic type-9。两validator的post-state来自genesis至stored operation sequence；detached receipt不能授权。Historical post-state与current full-prefix/head validation保持分离。

## 5. 核心行为

### 5.1 Typed prepare → authorize → release / cancel gate

Canonical handle lifecycle 只有：

```text
prepared → authorized/open
prepared → cancelled
authorized/open → authorized/held/not-delegated
  → released/delegated
  → released/unknown-delivery
authorized/held/not-delegated → authorized/open → cancelled
```

`released/delegated`、`released/unknown-delivery`与`cancelled`互斥且terminal。Known predelegation failure必须先退出exclusive latch回到`authorized/open`，再机械cancel；delegate boundary未知只能进入`released/unknown-delivery` fatal ambiguity，禁止cancel、resend或把它降级为known-unsent。任何路径都不得在exact delegate boundary前预先把handle标为`released`。

- **Prepare**：在最终 middleware/provider transform之后、实际 `doStream`/fetch之前得到 exact normalized request、target/authority、storage mode与 digest inputs；provider hits必须为0。
- **Select/Classify**：automatic固定顺序是：1) load complete nominal M4 authority view；2) M5 selection；3) obtain same-view `AutomaticRecoveryProofSliceV1`；4) M7只构造provider-neutral `RecoveryClosureDescriptor`且不产生plaintext；5) stable type-9 operation ID；6) M2 reserve `PreparedHandleCommitmentReservationV1`，仍为no-send且provider preparation/hits均为0；7) M4 K7取得exact live sealed-use leases；8) M7在K3 scope内按replay carriers重建/unseal/lower；9) M2 exactly-one paused provider preparation，消费同一reservation；10) original `M2InspectionResult`；11) M7 same-object validation；12) M5 final classification；13) M4 O8/type-9 first application执行K8并commit；14)取得complete operation result；15)立即在release前再执行K8；16) F27与M2 exact reservation/handle authorization，产生`authorized/open` release capability；17) exclusive release latch取得后在`authorized/held/not-delegated`内只调用delegate一次，并仅由exact delegate boundary记录`released/delegated`或`released/unknown-delivery`；18) K9 close leases并zeroize；19) create empty attempt；20) allocate ordinal 0 exactly once；21) consume stream/events。只有`released/delegated`且K9成功可继续步骤19；unknown-delivery直接fatal。Initial/ordinary/subsequent不由M7 automatic lowering，继续ordinary converter→M2 preparation→M4 complete result→F26→settlement→release路径。selection与descriptor均不构成安全结论。
- **Authorize**：available/opaque initial/ordinary、subsequent dispatch与automatic recovery各自由M4返回对应完整`OperationCommitResultV1<T>`；detached receipt不构成授权。Automatic O8 first application重读source/control/committed policy，验证same-view proof、reservation、live leases与K8后，原子完成revision、三个recovery heads CAS、aggregate event head/cursor推进、child/ledger/consumption。M2对initial、ordinary与subsequent只走F26；automatic只走F27并再验证same reservation、same handle、same leases与complete type-9 result；authorization只把`prepared`转为`authorized/open`，不等于released。
- **Release**：automatic canonical release order唯一为complete result → immediate pre-release K8（same handle仍为`prepared`）→ F27 + M2 exact authorization到`authorized/open` → acquire exclusive latch到`authorized/held/not-delegated` → delegate once并在exact boundary记录`released/delegated`或`released/unknown-delivery` → K9 close/zeroize。Known-not-delegated失败先退latch到`authorized/open`再cancel；unknown-delivery为terminal fatal且不cancel/resend。Empty attempt、ordinal-0 settlement与stream consumption只在delegated且K9成功之后按固定顺序发生。Initial/ordinary/subsequent保留ordinary F26授权路径。
- **Cancel/Barrier**：ManualStop、typed planning unavailable、stale binding、CAS/persistence/lease failure、supersession、budget exhaustion、ownership loss或任何automatic pre-delegate failure统一先执行mechanical cancel；若handle尚未materialize则执行原子no-handle barrier。随后固定为K9 close/zeroize → resource cleanup → A5/S2/S1 lookup、replan、ManualStop或fatal。K9失败必须在cleanup与任何lookup/post-cancel work前立即fatal，并保留关联same reservation/handle/leases所需registry state。Immediate pre-release K8失败时handle仍`prepared`，F27、M2 authorization、release/delegate调用次数均为0。

仅创建 `streamText()` 后延迟消费 stream不构成 paused gate；construction可能已经开始 `doStream`。AbortController也只证明可取消，不证明零发送。

### 5.2 Legacy durable-before-execute

所有最终可执行 local tools必须经统一 gate；本节与 §12 已固定的 two-fence 顺序完全一致：

1. 先完成不执行 hook/tool body 的纯 normalization 与 routing，materialize完整 raw invocation（原始 tool identity/input、call ID、owning assistant identity及将要调用的 before-hook identity）；
2. durable提交 raw invocation fence：input complete、call durable及 before-hook invocation commitment。提交成功前不得调用 side-effectful before hook、permission、MCP、plugin wrapper或tool body；
3. raw fence成功后才调用至多一次 side-effectful before hook。hook outcome纯归一化为唯一 final execution plan，并append `planned` phase；final-plan commit成功前不得执行body；
4. final-plan complete result验证成功后，short-circuit执行零次body，execute/replacement分支至多调用一次所选body；随后append `body-outcome-durable`，只保存owner replay carrier与commitments，body永不因settlement、restart或after-hook失败重跑；
5. after-hook至多一次；其outcome durable后append唯一automatic-eligible `final-after-hook-settled`。无法证明phase或在restart发现中间态时，不调用body/after-hook/provider，而由O3a append `reconciled-terminal-manual-only`；未知源映射`unknown-intermediate`。两类phase均可关闭terminal barrier但永久禁止automatic recovery；
6. terminal classification只接受durable phase。Raw fence失败时before hook/body/permission/MCP side effect均为0，final-plan fence失败时body side effect为0；O3a reconciliation的body、after-hook与provider调用数均为0。

没有该two-fence与五phase handshake时，source local replay fence只能是unknown；提供本地工具的incomplete attempt不得automatic recovery。

### 5.3 Pure、proposal-only、保守 classifier

Classifier：

- 不调用 provider、model factory、tool或storage；
- 不读取当前 config以重算 source evidence；
- 不创建/释放 handle；
- 不分配 CAS-dependent decision ID/revision；
- 不持久化；
- 只返回 `SafeRetry`、`ContinueAfterSettledTools` 或 ordered `ManualStop` proposal。

`SafeRetry` 必须同时满足：完整nominal authority view与same-view proof slice、partition exact为`truly-empty`、source一致且唯一 available dispatch、origin/consumed link一致、plan available、`N`/`M`可用、provider no-side-effects或matching attempt-wide idempotency、semantic digest相等、closure exact为`not-needed/safe-retry`。任何compatibility evidence、manual-only或nonfinal tool phase都拒绝SafeRetry。

`ContinueAfterSettledTools` 必须同时满足：complete view与proof slice exact为`continue-eligible`、partition exact为`authoritative-only`、所有tools exact为`final-after-hook-settled`、provider no-side-effects或matching durable-prefix continuation、三处prefix存在且同源/祖先验证通过、M7只从owner replay carriers按exact order重建provider-valid closure并重算全部commitments。`compatibility-only`、`mixed`、`reconciled-terminal-manual-only`与每个nonfinal phase均fail closed。

在authority已被验证为完整、owner-matched且可fold的前提下，其余typed ineligible/unknown recovery causes映射`ManualStop`。corrupt、partial、owner-mismatched、non-foldable或unresolved-ambiguous authority在进入classifier前即fatal，禁止伪装ManualStop。Classifier通过不等于允许发送；只有matching complete operation result可授权release。

### 5.4 Canonical `ManualStop` ordering

唯一稳定顺序为：

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

原因先按 causal gate判定，再按此顺序排序、去重且保证非空。结构失败抑制依赖available dispatch的下游predicate；typed unavailable cause必须穷尽映射，free-form detail不参与稳定reason。exact cause→reason表与mapping函数只由M1 `sessrec-1-contract-canonicalization`拥有；本文只冻结24-reason顺序并引用该mapping，不另定义第二份cause表。

### 5.5 Legacy lowering

#### `SafeRetry`

- M7从`DurableRecoveryAuthorityViewV1`与same-view safe-retry proof读取M4-produced exact `LegacyUserMessagePredecessorV1`/assistant mapping，严格验证identity后截取失败assistant之前的prefix；
- 排除失败assistant的text、reasoning、tools、provider metadata、StructuredOutput及任何source-derived content；
- partition必须是`truly-empty`，closure descriptor固定`not-needed/safe-retry`；
- 保留失败assistant在durable transcript/UI，新成功只属于recovery child。

#### `ContinueAfterSettledTools`

M7先通过`buildProviderNeutralRecoveryClosure({authority,proof})`构造不含plaintext的`RecoveryClosureDescriptor`。K7后，`reconstructProviderNeutralContinueMessages`只能在K3 dynamic scope内读取same-view proof携带的provider-prefix/tool/reasoning replay carriers：inline leaf必须secret-safe、strict decode且canonical re-encode byte-equal；sealed leaf必须持有same ref/generation live lease。它合并exact total order，重算tool plan/call/result、reasoning text、provider prefix、ancestry与closure commitments，再构造`LoweredRecoveryCandidate`并在同一scope内交给M2 preparation；plaintext-bearing messages/lowered output不得逃逸。

Legacy history、cache、public projection、current provider state、public data或digest inversion都不得提供Continue replay authority；M7不执行tool。Partial prose、open input、pending/running/interrupted/uncertain/manual-only tool、forced-flush reasoning及无关旧文本全部排除。Descriptor、reconstruction、planned materialization、same-object validation与M5 final classification必须按§5.1顺序完成，不能先决定Continue再试错。

### 5.6 Anthropic 与 OpenAI storage 区分

| Protocol | 可接受路径 | Fail-closed 路径 |
|---|---|---|
| Anthropic Messages | 仅audited local/client function call/result满足最小closure grammar：每个call ID/name唯一，result与call一一匹配且按provider要求邻接/有序；可附provider-end reasoning signature并按实际block scope验证 | server/hosted/provider-executed tool全部typed unavailable；call/result ID或name不匹配、duplicate/missing/extra result、非法text/reasoning交错、缺signature/metadata、forced flush、model不兼容或runtime lowerer未与authorization共用 |
| OpenAI Responses，normalized `store=true` | 仅settled local/client function call/output；可附具完整item identity、target/authority/model proof且最终transform保留的stored reasoning reference | hosted/provider-executed item/tool全部typed unavailable；metadata namespace/item reference缺失、target/authority/model/storage不匹配或最终transform删除identity |
| OpenAI Responses，normalized `store=false` | 仅不依赖reasoning state的settled local/client function closure | stateless encrypted reasoning、hosted/provider-executed item/tool全部typed unavailable；未明确归一化为false、需要item ID、缺完整state或只靠golden fixture猜测支持 |

Golden/recorded fixtures只能防回归，不能替代每次 exact pre-release runtime proof。

### 5.7 `N`/`M` budget

- external recovery config wire paths为`experimental.session_recovery.max_incomplete_recoveries`与`experimental.session_recovery.max_model_assistants`，另读取既有`agent.steps`。nested recovery leaf省略使用默认，canonical encode对默认2/64省略leaf；三者只接受JSON safe integer（N `>=0`、`configuredM`/steps `>=1`），拒绝recovery camelCase/alias、string coercion、float、`-0`、unsafe integer与null。internal deterministic mapping仅为`max_incomplete_recoveries→maxIncompleteRecoveries`、`max_model_assistants→configuredM`、`agent.steps→agentSteps`；exact decode/encode签名与focused projection只由M1子计划定义。
- `N`：logical chain中允许的 incomplete-triggered child上限；candidate recovery ordinal必须 `<= N`。默认2；`N=0/1/2`是必须覆盖的边界，explicit 2与omitted default在policy digest上等价但provenance分离。
- model-assistant bound：配置规范化时`configuredM`默认64；配置`agent.steps`时由M1一次性导出`effectiveMaxModelAssistants = min(configuredM, agent.steps)`，未配置时等于`configuredM`。Runtime candidate precheck与type-1/2/9 first application唯一可读authority是transaction-verified committed `NormalizedRecoveryPolicy.digestInput.effectiveMaxModelAssistants`；禁止runtime config/`agent.steps` reread、direct top-level-field access或再次取min。Initial、ordinary与recovery-child均检查`assistantSequence < effectiveM`；shell synthetic assistant位于model chain外。explicit 64与omitted default同样digest等价。
- 每次admission plan/binding、operations 1/2/9、admission proof与receipt都保留exact `scopeKey/epoch/policyDigest/defaultSemanticsVersion`。first application按session scope重读并验证committed normalized policy后只消费上述digest input；exact replay验证stored historical policy，不使用后来current policy重判历史commit。
- 任一预算耗尽都不建child、不consume、不release，并append新的finalized ManualStop revision。
- 二者都不计semantic dispatch、model step或physical provider request。

### 5.8 Revision、supersession、re-entry 与 crash

- first committed decision revision为0；若先前已有finalized/superseded revision，fresh reclassification的下一次commit append `revision + 1`，不覆盖旧record。无authority的planning/proposal重算不自行增加revision。
- folded state最多一个latest effective revision；ManualStop/finalization revision可finalized，automatic composite revision直接consumed，旧revision可superseded。本文不持久化automatic active-without-child状态。
- type-10是closed `model|no-reply` union，并持久化branch-exact完整`SupersessionBindingDigestInputV1`及其`SupersessionBindingDigest`。common input绑定session、source/control versions、submission payload digest与aggregate/recovery predecessors；model另绑定`reservedInitialOperationID`，later type-1再独立计算完整payload digest、携`NewLineageReservationRefV1`引用同一supersession digest并使用exact type-10 post aggregate head。no-reply固定`replyDisposition:"commit-user-only"`且无future reservation/proof，finalize old recovery后只允许commit user message，禁止policy/M7/M2/type-1/model assistant/ledger/M。若child consumption先赢，则reload/steer后重新评估serialized submission，不能fork。
- automatic decision与child admission/consumption是同一composite transaction：commit前不存在authoritative automatic record，commit后decision直接为consumed且唯一child已存在。automatic decision不具有可持久化的中间状态；pre-commit planning/proposal可重新执行，但从不具有dispatch authority。
- matching terminal child只观察或继续分类；仅同进程、原runner ownership仍活跃时可attach nonterminal child。
- crash边界分三类：automatic composite未commit且没有durable child/ledger时，旧proposal/reservation/handle/lease无authority；restart只可K10 exclusive cleanup后从fresh nominal view重新plan，不得复用旧对象。Composite已commit且原进程仍持有same reservation、canonical handle仍prepared与live leases时，可取回complete result，经immediate K8+F27/M2 exact authorization到authorized/open，再由exclusive latch与exact delegate boundary执行至多一次delegate。Boundary未知固定进入released/unknown-delivery terminal。Process restart、旧reservation/lease/handle丢失、ownership loss或child ledger durable但settlement不可证明均为ambiguity；不得再次consume、delegate或创建same sequence。
- crash发生在provider收到request而客户端未观察settlement的边界时，本文只保证fail closed，不声称exactly-once。

## 6. 八个 Legacy-oriented 模块

### M1. Shared Recovery Contracts and Canonical Semantics

- **Workflow**：定义typed classification、identity、target/domain、sealed refs、fence/proof、terminal、decision、canonical event sets与三类digest envelope；向LLM/core/Legacy提供单一schema。Schema-owned `buildRecoveryEventDefinitions`只构造十个internal durable definitions、recursive exact field-set specs及固定source/control tuples；LLM-owned `buildRecoveryEventRegistry`沿既有依赖方向导入该exact frozen set，并通过唯一25-domain canonical registry补齐两个allowed-set digests。
- **Requires**：dependency方向保持 `schema ← llm ← opencode`；schema-owned构造不得调用LLM canonical functions；所有authority字段可编码、版本化且不含raw secret。
- **Ensures**：同一语义只有一套wire/durable定义；canonical membership、nullable/discriminator与digest输入可机械验证；`RecoveryEventDefinitionSetV1`与enriched `RecoveryEventRegistryV1`分别只有schema/LLM一个构造owner，且后者不改变前者的10-operation membership。明确导出`RecoveryClosureDescriptor`、`LegacyUserMessagePredecessorV1`、`OperationSchemaByTypeV1`、`CanonicalWireValueV1`、`RecoveryReplayPayloadV1`、`RecoveryReplayPayloadCommitmentProjectionV1`、`ToolTerminalReplayPayloadV1`、四路evidence partition、五phase types，以及`DispatchAdmissionV1`、`TypedIncompleteTerminalFact`、`AssistantChainHeadV1`、`AggregateEventHeadV1`、`AutomaticRecoveryAction`、`RecoveryAdmissionPolicyBindingV1`。Available/opaque dispatch admission variants、其它receipt variants与`OperationApplyModeV1`保持private；consumer只能经`Extract<DispatchAdmissionV1,...>`、`ReceiptForV1<T>`/`AuthorityReceiptV1`、`OperationCommitResultV1<T>["applyMode"]`或exact indexed/literal surface取得。向M4导出唯一带V1名称的closed `AuthorityReceiptV1`、type-indexed internal definition/receipt/operation commit result合同，并为authorization/control/tool/reasoning/provider-prefix/supersession commitments提供25-domain exact versioned registry/input/builder/brand；另导出exact nominal `M4RecoveryAggregateOwnerMappingProofV1`与`M4SealedRecoveryMaterialLookupProofV1`输入形状，proof brand只能由M4在对应lookup成功后构造，M1仅pure compare。
- **Invariants**：schema不依赖llm/opencode；M1 pure函数只使用单一typed `ContractResult` carrier；source/control event sets互斥；unknown version fail closed；`assembleEventManifests`只消费raw definitions/publication metadata而不计算digest，`buildRecoveryEventRegistry`与cause→ManualStop mapping只由M1对应owner定义，本文与其它子计划只引用其合同而不复制。F23对runtime malformed/empty/future discriminator仍total返回唯一`internal-classification-failure` reason，不throw或留下空reason集合。
- **Side effects**：仅schema/codec与canonical contract变化；不dispatch、不持久化runtime state。

### M2. Legacy Dispatch Preparation and Transport Gate

- **Workflow**：对initial与ordinary request保持ordinary final no-send preparation。Automatic先调用`reserveRecoveryPreparedHandleCommitment`，以candidate/context/stable type-9 operation ID/action/same-view proof/closure/runtime input生成`PreparedHandleCommitmentReservationV1`，此时provider preparation/hit均为0；K7成功后，recovery `prepareDispatch`的exact complete input固定为九字段`{candidate, context, operationID, snapshotProof, closure, sealedUseLeases, reservation, lowered, runtimeInput}`，其中`lowered`是K3-scoped `M7.LoweredRecoveryCandidate`。该callable exactly once消费同一reservation并产生original `M2InspectionResult`及同handle planned materialization。Canonical suffix固定为complete result→immediate pre-release K8 while prepared→F27+M2 exact authorization到`authorized/open`→exclusive latch到`authorized/held/not-delegated`→delegate once并仅在boundary记录released delivery→K9 close/zeroize；known predelegation failure先退latch再cancel，unknown boundary进入`released/unknown-delivery` fatal ambiguity且不cancel/resend。该K8失败则prepared→cancelled且F27/M2 authorization/release/delegate均0，再K9 close/zeroize→cleanup。不得生成opaque recovery origin、replacement prepare或child ledger。
- **Requires**：gate位于所有语义改变之后、network release之前；dynamic factory/middleware/fetch rewrite必须被纳入或降级opaque。
- **Ensures**：每次covered semantic dispatch都有evidence-before-send；automatic child只有matching complete result、pre-release K8与F27/M2 exact authorization才可取得exclusive latch并在delegate boundary调用一次；released绝不早于boundary，unknown-delivery不cancel/resend；detached receipt拒绝。
- **Invariants**：prepare时provider hits=0；handle线性；authorization后request不可替换；raw secret不落盘。
- **Side effects**：prepare可持有ephemeral transport资源；release发起provider I/O；cancel关闭资源。

### M3. Legacy Execution Evidence and Terminal Settlement

- **Workflow**：ordinary F26路径在authorization后由caller分配exact ordinal settlement；automatic F27路径则按固定顺序先建立authorized/open，经exclusive latch与exact delegate boundary记录released/delegated或released/unknown-delivery，再K9/zeroize。只有delegated+K9 success才create empty attempt、分配ordinal-0一次并消费stream；unknown-delivery fatal。Tool gate记录五个durable phase；restart中间态只请求M4 O3a append-only reconciliation，绝不调用body、after-hook或provider。Drain后settle tools/reasoning；canonical adapter与clean EOF统一为typed terminal并reload nominal authority view。
- **Requires**：所有tool execution都经过中央gate；durable publication成功是唯一事实；incomplete继续排除于generic retry。
- **Ensures**：terminal前工具和reasoning provenance完整；commit failure不执行local side effect、不进入recovery dispatch。
- **Invariants**：pending/running/interrupted/unknown不冒充settled；forced flush不冒充provider end；public terminal仍UnknownError。
- **Side effects**：写parts、internal source facts与terminal transition；成功gate后执行local tool。

### M4. Durable Recovery Authority, CAS and Replay

- **Workflow**：internal publisher追加raw transitions；M4 fold/materialization同事务落地并commit CAS heads；S1返回nominal `DurableRecoveryAuthorityViewV1`，其中tool partition与`AutomaticRecoveryProofSliceV1`共享exact `RecoverySnapshotIdentityV1`。O3a `reconcileInterruptedToolExecution`只append `reconciled-terminal-manual-only`，body/after-hook/provider调用为0。K7–K10拥有sealed-use lease的acquire、type-9 first-application/immediate pre-release双K8 validation、所有terminal path K9 close与exclusive dead-process K10 cleanup；K4/K5拒绝live-lease rotate/redact conflict。Rebuilder按raw chain修复/验证并suppress replay publication；generic nonterminal view供type-1/2/9 re-entry。New-input O10保持two-stage gate。
- **Requires**：raw `EventTable`按dedicated recovery aggregate sequence可读取；M4先在owner-index lookup成功后构造M1 exact nominal `M4RecoveryAggregateOwnerMappingProofV1`，并把它作为`RecoveryDurableRowDecodeInputV1.ownerProof`显式交M1 private decode；sealed material lookup成功时同理构造`M4SealedRecoveryMaterialLookupProofV1`供M1 pure comparison。proof不可由consumer结构复制、持久化或从public state重建。projector、commit与event row处于同一SQLite transaction；migration不推断旧assistant安全，也不要求generic public aggregates迁移recovery-chain字段。First application只消费transaction内重读的committed `NormalizedRecoveryPolicy.digestInput.effectiveMaxModelAssistants`，不得从runtime `configuredM`/`agent.steps`重新计算effective bound。
- **Ensures**：Legacy assistant/message materialization、relations、ledger、operations 8–10 deterministic decisions、child、heads与public projections可从raw authority重建；type-1 existing user predecessor只验证不重建；M4 transaction分配/复用stable display ID，M1 projector纯；竞争只产生一个合法successor；first application验证current policy binding，exact replay验证stored historical policy与目标operation sequence post-state。A4/S1/R1对raw-referenced sealed metadata同时验证recovery raw prefix、sealed-maintenance prefix、folded sealed state与physical row；合法later rotate/redact可接受，但missing/foreign/diverged/restored bytes fail closed，snapshot验证不decrypt也不要求material仍active。
- **Invariants**：raw recovery events sole authority；head与fold一致；历史operation post-state验证与current full-prefix/head corruption验证分离；generic committed view只表示`nonterminal:true`且不能从`DurableRecoverySnapshot`/public projection/history构造；无matching event的row/head不能authorize；internal transition不公开。M4对authority row、七个derived materialization rows、三个heads、recovery/sealed post-state及sealed request/event/blob拥有唯一frozen digest domain/registry；read-back/replay/snapshot/rebuild都必须重算并逐字段比较，consumer不得定义alternate brand/builder。
- **Side effects**：SQLite event/materialization/head/projection写入、sealed material写入/读取/rotation与session cascade删除；raw secret不进入日志或public surface。Session删除只由existing higher-level immediate transaction调用`M4.deleteRecoveryOwnedStateForSession`：验证fixed before/after owned-table counts、exactly-one session delete、全部recovery/sealed owned rows归零及FK violations=0，任一失败回滚整笔deletion。Public notifier/bridge只接收M1 nominal `PublicCommittedEventV1`；structural `publication:"public"`、cast或object spread不能创建capability，internal writers永不调用public notifier。

### M5. Recovery Planner and Pure Classifier

- **Workflow**：先从complete `DurableRecoveryAuthorityViewV1`执行pure dispatch selector；只有exact one plausible available继续。Tool action selection直接消费same-view nominal proof slice：`truly-empty`只候选SafeRetry；`authoritative-only`且每条phase为`final-after-hook-settled`只候选Continue；`compatibility-only`、`mixed`、manual-only及每个nonfinal phase只产生ManualStop causes。随后M7 descriptor→M2 reservation→K7→M7 reconstruction→M2 one prepare/inspection→M7 validation，M5再组合planned materialization、committed-policy AdmissionPlan、proof、closure/digests与budget输出final proposal。
- **Requires**：输入typed且authority已完整、owner-matched、可fold、无ambiguity；current config只存在于planned materialization；candidate selector不授予安全结论；ManualStop reason mapping穷尽。authority corruption由M6/M4 fatal处理，不送入M5。
- **Ensures**：每轮最多存在一个paused candidate handle；只在全部proof成立时proposal automatic，否则给稳定有序、去重、非空ManualStop reasons，未采用或失败的handle由M6立即cancel。
- **Invariants**：selection与classification均纯、确定、proposal-only；输入排列不改变结果；不持久化、不dispatch、不分配revision。
- **Side effects**：无。

### M6. Legacy Recovery Coordinator and Admission Lifecycle

- **Workflow**：统一拥有所有model-assistant admission。Initial/ordinary从transaction-verified committed policy读取`digestInput.effectiveMaxModelAssistants`并验证`assistantSequence < effectiveM`；first application只重验同一committed value，禁止runtime re-min。Automatic严格编排§5.1的21步：complete authority view→selection→same-view slice→plaintext-free descriptor→stable type-9 ID→M2 reservation→K7→K3 reconstruction/lowering→one complete-nine-field prepare→inspection→same-object validation→final classify→O8/K8 commit→complete result→pre-release K8→F27/M2 authorization→exclusive latch/delegate boundary once→K9/zeroize→empty attempt→ordinal 0 once→consume。只有delegated+K9 success进入empty attempt；unknown-delivery fatal。任何automatic failure先mechanical cancel或no-handle barrier，再K9、cleanup及A5/S2/S1/replan/ManualStop/fatal；K9 failure在cleanup/lookup前停止。处理policy-aware replay、model/no-reply supersession与re-entry。NoReply与shell边界不变。
- **Requires**：持有session runner ownership；任何model-assistant admission前已有transaction-verified committed `NormalizedRecoveryPolicy`、满足其`digestInput.effectiveMaxModelAssistants`的candidate与expected chain predecessor。Automatic另持有complete nominal authority view、same-view proof、descriptor、reservation及K7 live leases；attempt-local state可重置。
- **Ensures**：initial、ordinary与recovery-child model assistant都只通过唯一immediate-successor admission创建，且每次first application均保持`assistantSequence < effectiveM`；shell不改变model-chain head；每次recovery使用新assistant且旧failure保留；stale/CAS/budget/persistence failure零release；revision和child无分叉。
- **Invariants**：candidate是chain immediate successor；ordinary只递增assistant sequence，incomplete child还递增recovery ordinal；generic nonterminal re-entry只消费M4 owner-qualified `CommittedAssistantAuthorityViewV1<K>`，normal terminal走own result path，exact incomplete terminal commit后才加载S1 snapshot；一个decision最多消费一次；StructuredOutput不跨attempt。
- **Side effects**：为initial/ordinary写serialized composite admission-dispatch operation、assistant、chain/dispatch heads与ordinal-0 ledger；为recovery写automatic composite decision/child/ledger/consumption；调用gate authorize/release/cancel。prepare失败无durable admission side effect。

### M7. Recovery-aware History and Protocol Closure

- **Workflow**：只拥有automatic recovery descriptor/reconstruction/lowering。`buildProviderNeutralRecoveryClosure({authority,proof})`先从complete nominal view与same-view proof构造无plaintext `RecoveryClosureDescriptor`；K7后，`reconstructProviderNeutralContinueMessages`在K3 scope内按inline/sealed replay carriers与exact total order重建并重算全部commitments，形成携same proof、prepared-handle commitment与leases的`LoweredRecoveryCandidate`，立即交M2 one preparation；随后`validatePreparedRecoveryInspection`检查same object。Initial/ordinary使用existing ordinary converter。
- **Requires**：authority/proof/closure同一snapshot；sealed leaf已有exact live leases；inline leaf secret-safe且canonical byte-equal；M2 reservation先存在。禁止读取Legacy history/cache/public projection/current provider state或让plaintext-bearing lowered output逃逸K3 scope。
- **Ensures**：failed partial内容不晋升；settled tools只作为history且绝不重新执行；all owner digests重算一致；不可表达的closure返回typed unavailable。
- **Invariants**：provider-end与forced flush分离；OpenAI store分支不混用；closure在classification前固定。
- **Side effects**：仅构造runtime planned representation；不写authority、不发送网络。

### M8. Public Legacy Entrypoints, Projections and UX Compatibility

- **Workflow**：public unprefixed synchronous `prompt`/`command`在同一serialized coordinator operation上等待完整model/recovery chain，再经shared mapper返回final effective assistant；automatic success返回最终terminal child，committed ManualStop返回source。`prompt_async`只等待serialized operation被scope-owned background work接受即返回204/empty body，完整chain继续在background运行并通过sanitized public state发布；shell走N/A边界；安全projection经Legacy HTTP/generated SDK/TUI sync/render展示。
- **Requires**：internal transitions在definition/public carrier source及每个public/shared publication边界默认拒绝；public service/manifests只能接收M1 literal-public brands，trusted private replay set不得注入。bridge/CLI/TUI/SDK callback逐项消费`M1.PublicEventSubscriptionV1<D>`，其item exact为同一`D`的nominal `M1.PublicCommittedEventV1<D>`；不得先扩大为broad event union、generic object或按type prefix过滤。optional projection字段有冻结的version/nullability/omission合同且旧client可解码；TUI按真实transcript hydration/reconciliation而非live event次数或authority做展示。
- **Ensures**：sync prompt/command不在source incomplete时提前返回；automatic success body为final child，ManualStop只有complete type-8 commit后body为source；`prompt_async` success恒为204且不声称background已完成。public error仍UnknownError并保留冻结的message映射；旧assistant error可见，新child独立；ManualStop不建child；shell不被recovery重放；SafeRetry/Continue/ManualStop均有明确busy/idle与最终显示状态。CLI event/transport reducers分别只更新presentation或transient transport，并精确返回`{state, wakeHydrator}`；transient disconnect不能直接写terminal hydration failure。
- **Invariants**：ledger/proof/digest/decision link/CAS/sealed material不进入public wire/event；Native V2 subscriber不接收internal recovery payload；TUI只接受current connection generation的exact nominal public event，full-hydration guard仍须transcript+status共同成功后建立。
- **Side effects**：HTTP/SDK responses、public sync signals与TUI状态更新；不直接修改authority。

## 7. 关键模块接口合同

| Interface | 输入 | 输出 | Caller责任 | Callee保证 |
|---|---|---|---|---|
| M6 → M4 O10/type-10 gate | `submitSerialized` pre-inspection candidate仅含model `{sessionID,submissionPayloadDigest,intendedInitialOperationID}`或no-reply `{sessionID,submissionPayloadDigest,replyDisposition:"commit-user-only"}`；first call=`inspect-current-authority`+expected aggregate head；若返回branded `M4.SupersessionRequiredAuthorityV1`，caller才据该same-tx authority构造完整branch-exact binding/type-10 input/payload digest并以`complete-expected-input`重入 | model：type-10 complete result+`M4.SupersessionBeforePrepareProofV1`或no-unresolved-source proof；no-reply：type-10 complete result或no-unresolved-source user-only branch；inspection也可返回supersession-required authority或automatic complete winner | user尚未commit；zero M7/M2；pre-inspection candidate不得携source/control/predecessor binding；不得直接调用O9或把authority当type-10 input/proof | unresolved source只在complete-input re-entry提交；only model proof可进入type-1；no-reply禁止model admission；exact winner/fatal corruption |
| M6/M2 → M4 initial/ordinary composite | type-1/2 exact input、candidate、policy、M2 package；type-1含existing user predecessor与model proof/reservation ref | `OperationCommitResultV1<"initial-chain-genesis-and-dispatch" \| "ordinary-assistant-and-dispatch-admitted">`或typed failure | initial assistant/ledger predecessors genesis；aggregate=current head，post-type10=exact post head；ordinary committed predecessor | raw+Legacy assistant relation+ledger+两个相关recovery heads+aggregate event head/cursor+M atomic；type-1不重建user；authorization用complete result的receipt+post-state；detached receipt拒绝 |
| M2 → M4 subsequent dispatch recording | same assistant next-ordinal evidence、expected predecessor、handle commitment | `OperationCommitResultV1<"subsequent-dispatch-recorded">`或typed failure | assistant admitted，network未release，ordinal immediate successor | raw+ledger+dispatch recovery head+aggregate event head/cursor atomic；complete result才可authorize |
| M3 → M4 settlement publication | ordered tool/reasoning/terminal facts | exact typed `OperationCommitResultV1<T>` + source checkpoint/reload boundary | 已drain并等待登记工具；side-effect continuation不得使用detached receipt | durable facts可按raw sequence重建；complete result携带exact post-state |
| M4 → M5/M6/M7 authority read | transaction-consistent raw/materializations/Legacy relations、four-way partition与five-phase evidence | nominal `DurableRecoveryAuthorityViewV1`及same-view `AutomaticRecoveryProofSliceV1` | 不从public projection/history/display ID补字段；consumer不得复制brand | snapshot identity、partition与proof slice nominally一致；manual-only不能cast成automatic |
| M5 → M7 → M2 reservation → M4 K7 → M7/M2 → M5 | complete view、same-view proof与至多一个automatic action | plaintext-free descriptor；stable type-9 ID；reserved-no-send commitment；live leases；K3 reconstruction；one preparation/original inspection；same-object validation；final proposal | 任何unseal/lower/actual prepare前必须K7；reservation先于K7；authority corruption已fatal | 不切换action、不replacement prepare；all replay digests重算；available same handle，unavailable no live handle |
| M2/M7 → M5 planning | validated planned materialization、same-view proof、descriptor、reservation/leases或typed unavailable | classifier输入 | available handle未release且ownership有效；unavailable无live handle；plaintext不逃逸 | target/digests/proof/closure/reservation/leases对应同一prepared request |
| Admission planner → M5 | next context、expected head、normalized `N`、committed `NormalizedRecoveryPolicy.digestInput.effectiveMaxModelAssistants`、`assistantSequence < effectiveM`与quartet | `AdmissionPlan` | transaction验证committed policy；禁止runtime config/steps re-min | 不自行修改authority |
| M5 → M6 proposal | action、reasons、binding commitment | pending proposal | 不把proposal当record | durable decision commit前无dispatch authority |
| M6 → M4 automatic composite | exact proposal、decision material、Legacy child info、stable type-9 ID、same-view proof、reservation、live leases与exact predecessors | `OperationCommitResultV1<"automatic-child-admitted-and-consumed">` | first apply重读source/control/committed policy并在raw/cursor commit前执行K8；assistant predecessor不得genesis | deterministic consumed record+child+ledger+three heads+aggregate cursor atomic；exact replay complete result；detached receipt不授权 |
| M6 → M2 release/cancel | ordinary branches：complete result+same handle；automatic：complete type-9 result+exact proposal+original planned+same reservation/handle/leases；或cancel/no-handle barrier cause | delegated stream、released/unknown fatal或closed handle/leases | automatic先immediate K8，再F27+M2到authorized/open；exclusive latch保持authorized/held/not-delegated，boundary-only记录released，随后K9；任何pre-delegate failure先barrier→K9→cleanup | ordinary仅F26；automatic仅F27；known predelegation退latch再cancel；unknown不cancel/resend；K9 failure pre-cleanup fatal |
| M7 → M2 prepared request | K3-scoped `LoweredRecoveryCandidate`、descriptor、same-view proof、reservation与live leases | one exact gate-bound request + original inspection；`PlannedRecoveryMaterialization` | K7已完成；plaintext-bearing messages不得逃逸callback；不得pre-prepare运行provider constraints | consume reservation exactly once；M7按inspection验证same object；actual send与authorized representation一致 |
| M4 → M1 F28 → public field → M1 F30 → M8 | M4 validated `M1.RecoveryPublicAuthorityViewV1`含stable display mapping | F28 exact `ContractResult` → Legacy message/session signal → F30 exact `ContractResult` → M8 hydration/display | M4不把allocation委托给F28；M8不请求authority字段且只走F30 public decode path | F28/F30不写表/不分配ID；F28 error阻止publication，F30 malformed为typed hydration error；internal `session.recovery.*`永不泄漏 |
| M1 schema F3/F2/F31 → public event consumers；M1 LLM `buildRecoveryEventRegistry` → M4 private replay/rebuilder | schema-owned `RecoveryEventDefinitionSetV1` + all definitions with source-level publication metadata；LLM enrichment只接收same frozen set | public-only nominal carriers/service/manifests；`PublicEventSubscriptionV1<D>` item exact为`PublicCommittedEventV1<D>`；separate trusted private all-durable manifest；enriched `RecoveryEventRegistryV1`附加两个existing allowed-set digests | schema不得导入LLM或计算digest；public consumers不得cast generic/internal definitions、扩大item为broad union或按prefix过滤；private readers不得publish decoded raw payload | public brands只承诺literal public；private set可读internal但nominally不能进入listen/SSE/SDK；raw/enriched registry membership一致 |

## 8. 端到端流程

### 8.1 Initial/ordinary Legacy dispatch

1. M6取得origin-specific current heads。initial使用assistant-chain/dispatch-ledger genesis，但aggregate predecessor是exact current head；若来自model type-10，proof绑定reservation且aggregate predecessor等于type-10 post head。existing user message已commit并作为validated predecessor。ordinary引用exact committed model head。
2. existing ordinary converter构造canonical Legacy request body；M2 prepare最终paused request并解析exact target/authority/storage，形成available或opaque evidence。M7不拥有initial/ordinary lowering。
3. M4提交type1/type2 composite：原子写raw、Legacy assistant info/relation、ordinal-0 ledger、heads与M；type-1不insert user row。只有aggregate为空时type-1 aggregate sequence为0；否则append current+1。
4. Initial与ordinary admission只允许M2把complete result的receipt+operationPostState及same handle交M1 F26；F27不得用于这两个origin。F26成功后M3创建ordinal-0 settlement再release。opaque只允许initial/ordinary。
5. 若同一invocation需要后续model step/resend，必须先按immediate ordinal提交后续dispatch evidence；complete type-3 result只经M1 F26与fresh same handle授权，F27不得用于subsequent dispatch。commit或F26失败时不release，并durable finalize该已admitted assistant为typed pre-dispatch abandonment/error，re-entry不得留下无ledger/无terminal悬挂attempt。
6. 若成功，维持现有Legacy success/ordinary continuation语义；若typed incomplete，进入terminal settlement。

### 8.2 `SafeRetry`

1. M3等待settlement，提交typed terminal；M4加载complete nominal authority view。M5只在same-view slice为`safe-retry-eligible`且partition exact `truly-empty`时选择SafeRetry。
2. M7构造`not-needed/safe-retry` descriptor，无plaintext；M6生成stable type-9 ID，M2 reserve no-send commitment，M4 K7取得所需leases（SafeRetry通常为空但仍走同一lifecycle）。
3. M7在K3 scope内按exact predecessor/mapping构造source之前的canonical body；M2 one preparation消费reservation并产生original inspection，M7验证same object，M5 final classification。
4. M4 O8在first application内执行K8并atomic commit；取得complete result后立即pre-release K8，再经F27与M2 exact reservation/handle validation转为`authorized/open`。
5. M2取得exclusive latch到`authorized/held/not-delegated`，调用delegate一次并仅在exact boundary记录`released/delegated`或`released/unknown-delivery`；随后M4 K9 close leases并zeroize。只有delegated且K9成功才create empty attempt、allocate ordinal 0 exactly once、consume stream/events；unknown-delivery在K9/cleanup后fatal且不cancel/resend。新assistant独立成功或再次terminal。

### 8.3 `ContinueAfterSettledTools`

1. M4 complete view必须给出`continue-eligible` same-view slice：partition exact `authoritative-only`，每个tool exact `final-after-hook-settled`；compatibility/mixed/manual/nonfinal全部fail closed。
2. M7先构造plaintext-free descriptor；M2 reserve stable no-send commitment；M4 K7在任何unseal/lowering/actual prepare前取得exact leases。
3. M7在K3 scope内strict decode/re-encode inline carriers、通过leases访问sealed carriers，合并provider-prefix/tool/reasoning exact total order，重算全部owner commitments且不读取Legacy history/cache/public/current provider state；tool执行次数为0。
4. M2 exactly-once prepare消费reservation，M7 same-object validation，M5 final classification；M4 O8/K8 commit并返回complete result。
5. Immediate K8→F27/M2 exact authorization到`authorized/open`→exclusive latch/delegate boundary once→K9/zeroize；只有`released/delegated`继续empty attempt→ordinal 0 once→consume，`released/unknown-delivery`则fatal且不cancel/resend。

### 8.4 `ManualStop`

1. validated authority下的typed ineligible source/planning/proof/tool/closure/admission条件失败，M5按canonical order生成reasons；corrupt/partial/owner-mismatched/non-foldable/ambiguous authority直接fatal。F23 mapping必须total且返回ordered nonempty reason tuple。
2. normal final-classification ManualStop若已有prepared handle则先机械cancel；若handle尚未materialize则执行no-handle barrier。随后固定K9关闭全部live leases并zeroize；K9失败在任何resource cleanup、lookup、classification或commit前立即fatal并保留lease-relation registry。
3. K9成功后必须完成resource cleanup。若后续仍可能提交type-8，cleanup只能保留secret-free one-shot `manual-stop-tombstone`：send closure、plaintext与retained secret bytes均为0，只允许M2 exact validator消费同一cancel proof一次。
4. failed/unknown automatic commit在上述barrier→K9→cleanup完成后，才以首次提交的完整aggregate-scoped tuple调用M4 `lookupRecoveryOperationResult`。A5返回complete automatic result时立即使tombstone失效并follow/re-enter committed child，绝不再authorize该handle或改写为ManualStop；A5 typed inconsistent/busy/unresolved直接使tombstone失效并fatal。
5. 只有A5在valid owner scope明确返回operation absent后，M6才调用M4 `lookupCurrentRecoveryWinner`。任一complete manual/automatic/superseded winner都原样follow/re-enter；只有`unchanged`表示no winner。仅当“operation absent + no winner/unchanged + fresh `loadRecoverySnapshot`证明source binding unchanged + automatic attempt前已由M5/F23独立classified的eligible cause”四项同时成立，才可走独立ManualStop；commit failure本身不得新造cause。
6. M6 append并finalize ManualStop revision。只有完整`OperationCommitResultV1<"decision-finalized">`成功或exact replay恢复同一complete result后，才允许M8返回source；type-8 complete result resolution后立即invalidate tombstone。所有winner/replan/fatal exit同样使tombstone失效。Commit/lookup失败绝不退回automatic、release或source-success fallback。
7. 因机械cancel/no-handle barrier先于type-8 commit，automatic recovery对audited provider transport的delegate调用次数保持0；public transcript保留原UnknownError和可选safe decision projection，不创建child。

### 8.5 Re-entry、supersession 与 crash

1. re-entry从raw authority/materializations校验latest effective revision、child、consumption、三个recovery heads及aggregate event head/cursor。
2. 若automatic composite transaction尚未commit，只有无authority的planning/proposal，可从fresh snapshot重新prepare；若已commit，则decision必为consumed且唯一child存在，terminal child只观察/分类。
3. composite commit响应丢失但同进程live ownership与同一never-released prepared handle仍可证明时，只可用M1 `RecoveryOperationLookupKeyV1`的session/aggregate/operation/type identity加完整expected input/payload digest/receipt kind做aggregate-scoped lookup并取回complete result：initial/ordinary/subsequent只经M1 F26验证；automatic type-9取回complete result后必须立即在same handle仍为prepared时执行pre-release K8，成功后才可经M1 F27验证exact M5 proposal与original available `{descriptor, pausedHandle}` materialization，并由M2匹配same reservation/raw handle/live leases，转为`authorized/open`，取得exclusive latch后在`authorized/held/not-delegated`内调用delegate一次；只由exact boundary记录`released/delegated`或terminal `released/unknown-delivery`，随后K9 close/zeroize。该K8失败则prepared→cancelled且F27/M2 authorization/release/delegate均0。Known predelegation failure先退latch到authorized/open再cancel；unknown-delivery不得cancel或resend，只能K9/cleanup后fatal ambiguity。已越过delegate boundary的状态不再走cancel/A5 resend。同进程live ownership可attach nonterminal child；跨进程、旧handle丢失或ownership丢失均finalize ambiguity。
4. new input与automatic composite通过同一`recovery_head`竞争。model type-10先赢时绑定intended type-1 operationID与pre-prepare reservation digest；user commit后type-1以exact type-10 post aggregate head append并独立计算完整payload digest。no-reply type-10先赢时不绑定reservation，只commit user message且不admit model。automatic先赢则读取complete winner并steer/re-evaluate，不fork。

### 8.6 Model supersession 与 noReply user-only

1. Both branches enter the same per-session serialized queue. `submitSerialized` first constructs only the pre-inspection candidate: model `{sessionID, submissionPayloadDigest, intendedInitialOperationID}` or no-reply `{sessionID, submissionPayloadDigest, replyDisposition:"commit-user-only"}`. Before user commit it calls O10 `inspect-current-authority` with the exact dedicated aggregate head; the candidate and this read contain no source/control/predecessor binding and construct neither `M1.DurableRecoverySnapshot` nor any supersession digest.
2. If inspection finds an exact unresolved source, O10 returns only branded `M4.SupersessionRequiredAuthorityV1` containing the same-tx source/control/predecessor facts. The caller then builds the complete branch-exact `SupersessionBindingDigestInputV1`, its `SupersessionBindingDigest`, and the complete type-10 expected input/payload digest, and must re-enter O10 through `complete-expected-input`; direct O9, partial input, digest-only input, or treating the authority as a proof/input is forbidden.
3. Model complete-input branch binds submission payload digest, source/control versions, aggregate/recovery predecessors and intended type-1 operationID. Only after O10 commits/validates type-10 may it return `M4.SupersessionBeforePrepareProofV1`; then the user message is committed. The later type-1 validates that user predecessor, names the type-10 operation, carries `NewLineageReservationRefV1.reservationDigest` equal to that model supersession digest, independently computes its complete post-prepare payload digest, and appends after the exact type-10 post aggregate head. The no-unresolved-source model branch receives the distinct branded model proof without a type-10 commit.
4. NoReply complete-input branch commits/validates branch-exact type-10 `supersessionKind:"no-reply"` input with `replyDisposition:"commit-user-only"` only when inspection returned supersession-required; otherwise the inspect branch returns exact no-unresolved-source user-only continuation. Neither no-reply branch creates a proof or carries a future operationID/reservation, and both then commit only the user message. They perform zero policy reads/freezes, candidate assistant allocation, M7/M2 calls, prepared handles, type-1 operations, model assistants, dispatch ledgers, M consumption, authorization, or release.
5. Corrupt/partial/owner-mismatched/non-foldable/ambiguous old authority is fatal in both branches. An automatic winner is reloaded and followed/steered before the serialized submission is re-evaluated.

### 8.7 Shell 与 experimental native Legacy transport

- Shell仍进入per-session serialized submission queue，但绕过supersession recovery、policy freeze、M7/M2、N/M与model admission。Shell synthetic assistant位于model recovery chain之外，不分配`assistantSequence`、不推进`assistant_chain_head`且不消耗`M`；它仍按既有公开transcript/history语义可见，但不进入provider incomplete classifier，也不得被选择为recovery source或Continue tool closure。后续独立prompt/command始终创建新model chain；history lowering可以读取此前公开transcript，但这不表示延续旧recovery chain。当前route scenario只证明handler/message/tool-part wiring；`prompt → shell → prompt/incomplete`、side effect一次、sync与不重放必须作为future回归验收。
- Experimental native Legacy transport必须满足同一evidence-before-send与release/cancel机械gate；首批未满足时fallback/disable。即使可记录opaque initial evidence，其incomplete也固定ManualStop。

## 9. 架构正确性论证

### 9.1 Goal → module mapping

| Goal | 主模块 | 协作模块 |
|---|---|---|
| G1 | M3 | M1、M4、M8 |
| G2 | M2、M5、M6 | M4、M7 |
| G3 | M7 | M5、M6、M8 |
| G4 | M3、M7 | M2、M5、M6 |
| G5 | M5、M6 | M2、M3、M4 |
| G6 | M3 | M4 |
| G7 | M4、M6 | M1、M2 |
| G8 | M4 | M1、M8 |
| G9 | M5、M6 | M4 |
| G10 | M8 | M1、M4 |
| G11 | M7 | M2、M5 |
| G12 | M3、M6 | M8 |

### 9.2 Collaboration proof

M3把runtime observation与five-phase tool facts转成durable evidence；M4使其成为唯一可重放authority并产出same-view nominal proof。Automatic由M7 plaintext-free descriptor、M2 no-send reservation、K7/K3 reconstruction、one paused preparation、M5 final classification组成；M6只在O8 first-application K8成功并取得complete result后进入pre-release K8与F27/M2 same reservation/handle/lease authorization。Initial、ordinary与subsequent保留F26。Automatic authorization只建立`authorized/open`；exclusive latch保持`authorized/held/not-delegated`直到exact delegate boundary记录`released/delegated`或`released/unknown-delivery`，随后立即K9/zeroize。只有delegated且K9成功才创建empty attempt与ordinal-0 settlement。因而：

```text
Complete nominal authority view and same-view automatic proof slice
∧ Exact evidence partition and final tool phases
∧ Plaintext-free closure descriptor and recomputed replay commitments
∧ Stable no-send reservation and live K7 leases
∧ One exact paused plan and conservative final proposal
∧ O8 first-application K8 plus atomic admission/consumption
∧ Matching complete operation result and immediate pre-release K8
∧ F27/M2 same reservation/handle authorization to authorized/open
∧ Exclusive latch with exactly one delegate-boundary transition
⇒ released/delegated then K9/zeroize for a new assistant, or terminal unknown-delivery fatal ambiguity
```

任一普通eligibility合取项缺失都走cancel/ManualStop；authority corrupt/partial/owner-mismatched/non-foldable/ambiguous则fatal。任何缺口不能以public projection、内存状态、clock或当前配置补证。M4必须在core notification或每个public/shared publication边界默认拒绝internal transitions，M8只接收安全projection；只有这些逐通道过滤与泄漏验收成立时，authority才不会经产品surface泄漏。

### 9.3 关键假设

- H1：单个dedicated recovery aggregate的raw event sequence可在SQLite transaction内全序追加，且M4能验证其唯一session owner mapping；safety/durability只覆盖transaction已成功返回后的validated process-crash fault model，不覆盖host/power/filesystem/device-cache loss或storage corruption；本文也不处理多主写入。
- H2：transport gate确实位于所有request语义变换之后、network I/O之前；未满足的adapter必须opaque/fallback/disable。
- H3：provider idempotency/continuation能力只在adapter有明确、可测试contract时声明；缺证明等于unknown。
- H4：M4 sealed-store满足scope/integrity/cascade及K7–K10 lease lifecycle；K4/K5 conflict、dual K8、all-exit K9 zeroization与exclusive-fence K10均可验证，任一条件失败则automatic proof unavailable。
- H5：Legacy runtime能识别当前runner ownership；无法识别时按ownership lost处理。
- H6：public optional projection必须通过frozen OpenAPI/generated SDK/旧client decode与HTTP/SSE JSON泄漏测试证明可向后兼容；若不能，必须另做versioned/breaking-change决策。
- H7：Native V2只消费shared兼容contract，不消费internal Legacy recovery transitions。

### 9.4 跨模块 invariants 与 preservation

| ID | Invariant | Preservation |
|---|---|---|
| I1 | incomplete原attempt始终保留terminal error | M3写terminal；M6只建child；M8不覆盖source |
| I2 | network delegate boundary前存在matching durable ledger authority与complete operation result，且released不早于boundary | M2暂停；M4 commit/lookup complete result；initial/ordinary/subsequent仅M1 F26验证complete result+same handle；automatic type-9固定先immediate pre-release K8 while prepared，再由M1 F27与M2 exact authorize same reservation/handle/leases到authorized/open；exclusive latch保持authorized/held/not-delegated，只有delegate boundary可记录released/delegated或released/unknown-delivery，随后K9 |
| I3 | local tool side effect前call已durable | M3 execution gate；M4 commit失败则不execute |
| I4 | raw events是唯一authority | M4 projector/rebuilder单向materialize；M5/M6拒绝projection authority |
| I5 | decision、model assistant、dispatch无分叉且不存在admitted-without-initial-ledger状态 | M4三个recovery heads、aggregate event head/cursor与unique constraints；initial/ordinary composite原子admit assistant+ordinal-0 ledger；M6只接受immediate successor |
| I6 | source/planned/admission互不污染 | M1 schema分离；M4 snapshot不含current plan；M5只组合不回写 |
| I7 | internal authority不公开 | M4 internal publication suppression；M8只投影safe fields |
| I8 | partial/forced content不进入成功上下文 | M7 lowering与provenance validator；M6 reset attempt-local state |
| I9 | budget有界且policy authority唯一 | M5 proposal检查`recoveryOrdinal <= N`与`assistantSequence < effectiveM`；M6/M4 first application只消费transaction-verified committed `NormalizedRecoveryPolicy.digestInput.effectiveMaxModelAssistants`，禁止runtime re-min；CAS后才admit |
| I10 | stale/unknown永不被误作known-unsent或再次release | M5 fail closed；pre-delegate failure走cancel/no-handle barrier→K9→cleanup；M2 linear state拒绝mismatch，unknown boundary终态固定released/unknown-delivery且禁止cancel/resend |
| I11 | type-1始终lineage genesis但aggregate只在首operation genesis | M4验证current AggregateEventHead；post-type10 exact head；assistant/ledger genesis |
| I12 | noReply无model admission authority | closed type-10 no-reply无reservation/proof；M6 user-only；shell另行bypass |
| I13 | decision/message可仅从raw确定重建且transport只认complete result | 8–10 canonical decision material；1/2/9 Legacy material；M4 display mapping；M2对initial/ordinary/subsequent只调用M1 F26，对automatic type-9只调用M1 F27并提供exact proposal+original available planned |

### 9.5 Failure matrix

| Failure point | Durable result | Provider/tool result | Required outcome |
|---|---|---|---|
| initial/ordinary prepare失败 | 无assistant/admission/ledger/head变化 | provider hit 0 | cancel/return typed failure |
| initial/ordinary composite commit失败 | assistant、M admission、ledger与heads全无 | provider hit 0 | cancel/stop |
| admitted assistant的后续dispatch evidence commit失败 | 既有assistant保留，失败ordinal未写 | provider hit 0 | durable pre-dispatch abandonment/error；re-entry不得发送该ordinal |
| local tool call commit失败 | 无durable call | side effect 0 | terminal failure/stop |
| settlement或terminal commit失败 | source不完整 | no recovery hit | 当前进程stop |
| snapshot corrupt/partial/owner mismatch/non-foldable/ambiguous | authority不可证明 | no recovery hit | fatal stop；不得ManualStop |
| planning/closure typed unavailable | source不变 | paused provider hit 0 | finalized ManualStop |
| proposal后request/policy变化 | old binding stale；proposal仍无authority | paused provider hit 0 | cancel并从fresh snapshot重新plan；只有后续真正commit的record才分配/递增revision |
| 任一head CAS失败 | composite transaction全回滚 | provider hit 0 | exact读取winner/replan；ManualStop仅absence/no winner+valid binding |
| child/ledger/consumption事务失败 | 全回滚 | provider hit 0 | cancel/stop |
| complete result/handle mismatch、detached receipt或任一automatic pre-delegate failure | committed child可能存在但delegate未越界 | provider hit 0 | mechanical cancel/no-handle barrier→K9→cleanup→A5/S2/S1/replan/fatal；K9 failure在cleanup/lookup前fatal |
| exclusive latch内known-not-delegated failure | child已commit；handle仍authorized/held/not-delegated | provider hit 0 | 退latch到authorized/open→cancel→K9→cleanup；不得标released |
| delegate boundary未知 | child已commit；handle terminal released/unknown-delivery | outcome未知 | K9/zeroize→cleanup→fatal ambiguity；不得cancel、A5 resend或replacement prepare |
| released/delegated后stream断裂 | child dispatch已越过delegate boundary | outcome未知 | K9/cleanup后settle child；crash时不重复release |
| projector/materialization被篡改 | raw authority仍在或冲突 | no automatic dispatch | rebuilder恢复或fail closed |
| public projection被篡改 | authority不变 | 无授权效果 | 下次rebuild覆盖；不得驱动classifier |
| new input与automatic composite竞争 | 同一recovery-head predecessor只允许一个事务成功 | winner决定后续 | new-input winner先finalize再开新chain；automatic winner已有consumed child，loser读取winner且不分叉 |

### 9.6 Main theorem

**Safety theorem（independent-design-audit accepted obligation）：**在H1–H7成立、处于H1限定的validated process-crash fault model且M1–M8满足其Requires/Ensures时，任何由Issue #7 automatic recovery触发的provider delegate boundary都对应一个新的、唯一的assistant child；其complete nominal authority view、same-view proof slice、four-way partition/final phases、recomputed replay commitments、stable no-send reservation、live K7 leases、planned request、closure、transaction-verified committed policy bound、O8 K8、decision consumption、三个recovery heads与aggregate cursor、immediate pre-release K8及F27/M2 exact validation由同一binding链确认。Authorization只建立authorized/open；exclusive latch保持authorized/held/not-delegated，只有exact delegate boundary可记录released/delegated或terminal released/unknown-delivery，绝不提前标released。Delegated后K9 close/zeroize先于empty attempt与ordinal-0 allocation；unknown-delivery在K9/cleanup后fatal且不得cancel/resend。否则系统不会执行automatic delegate。该设计义务已通过stable-snapshot independent audit `0 P0 / 0 P1`并获用户批准，但尚未实现，也不构成future implementation/runtime proof；它不覆盖host crash、power loss、filesystem/device-cache loss或storage corruption后的authority retention。

证明分解：

1. I2与I3保证provider/local副作用前durable fence成立。
2. I4与I6保证classifier读取的source不是current config或public projection伪造。
3. M5的保守predicate保证unknown、矛盾、未结算与过期状态不产生automatic proposal。
4. I5与I9保证即使并发/re-entry，最多一个immediate child被admit且预算不超限。
5. complete result的receipt+operationPostState与same-handle matching建立authorized/open；exclusive latch与boundary-only released transition保证committed request、唯一delegate与terminal delivery不可拆配或提前标released。
6. I1、I8与M7保证旧failure和partial内容不会被伪装为新成功。

该定理是partial-correctness/liveness boundary，不承诺eventual response、eventual key/SQLite progress或provider/network exactly-once；也不扩展到H1排除的host/power/storage-loss fault set。

## 10. 关键设计决策

1. Recovery独立于generic transport retry；canonical incomplete继续`retryable:false`。
2. exact planning、durable authorization与network release机械分离。
3. raw internal recovery transitions是sole authority；SQL relations与projections均可重建。
4. “three recovery heads plus aggregate event head/cursor”：三个recovery heads分别解决decision revision、assistant successor与dispatch ordinal竞争；aggregate event head/cursor独立维护raw append位置，二者保持语义区分且不合并成含糊单head。
5. selector/classifier纯且proposal-only；CAS-dependent identity只能由ManualStop/finalization commit或automatic composite admission分配。
6. source snapshot、planned materialization、AdmissionPlan、record与public projection分别建模。
7. semantic/prepared/binding digest承担不同proof obligation，不用一个hash替代全部等价关系。
8. Legacy local tools采用中央durable-before-execute gate；不接受“未观察到part”等价于“未执行”。
9. Continue在M2前只构造target/provider-neutral、plaintext-free `RecoveryClosureDescriptor`与no-send reservation；K7后才在K3 scope内重建/lower，M2 one preparation产生original inspection后由M7按same object执行provider-specific validation。不保留整个errored assistant，也不无条件删除所有reasoning。
10. public error保持`UnknownError`；typed terminal先作为internal durable contract。
11. internal `session.recovery.*`不进入public event bus；M1 public event brands/service/manifests只接受literal public definitions，trusted private all-durable replay set单独存在且不可赋给public surface；只发布安全projection。
12. Native V2不进入normative recovery设计，但shared schema/event变化必须通过其regression。
13. `N`与`M`独立，且都不声称限制physical provider requests。
14. crash ambiguity优先于自动重放；indeterminate disconnect禁止透明resend；系统明确选择at-most-one-authorized-child，而非伪造exactly-once。

## 11. 后续详细设计与四个非 V2 子计划

本文、函数级`detailed-design.md`与四个owner子计划共同构成已通过independent design audit并获用户批准的implementation contract。四份Workflow Step 0 expectations、D0 correction、M1-A foundation与M1-B F1/F2均已完成、commit并push。当前SESSREC-1 M1-C只进一步实现并完成review F4 recursive exact field-set boundary；不得把这些partial evidence写成F3 raw recovery definitions、完整M1、automatic recovery、F31 public/private closure或future acceptance已完成。

四个全局唯一子计划均只覆盖Legacy/shared compatibility，不建立V2 recovery子计划：

1. **`sessrec-1-contract-canonicalization`**：M1；typed classification、identity、operation schemas、replay carriers、four-way partition、five tool phases、25-domain registry、terminal/decision/Legacy message rebuild material；shared exports含`DispatchAdmissionV1`、`TypedIncompleteTerminalFact`、`AssistantChainHeadV1`、`AggregateEventHeadV1`、`AutomaticRecoveryAction`、`RecoveryAdmissionPolicyBindingV1`，private variants/helpers只经exported/indexed surfaces消费。
2. **`sessrec-2-durable-authority`**：M4；nominal authority view/proof slice、raw operations、O3a reconciliation、K7–K10 leases、Legacy materialization、three-head commit、rebuild与publication suppression。
3. **`sessrec-3-legacy-runtime-recovery`**：M2/M3/M5/M6；no-send reservation、complete-result gate、tool/settlement、exact automatic ordering、N/M、supersession/re-entry/coordinator。
4. **`sessrec-4-legacy-lowering-public-contract`**：M7/M8；descriptor-first replay reconstruction/lowering、same-object validation、public unprefixed operations、UnknownError/optional projections、OpenAPI/generated SDK/TUI/CLI/child compatibility与shell N/A。

### 11.1 Repaired owner contracts accepted by independent design audit

下列全部六项此前已验证的P0/P1 owner issues（R21–R26）均已修复并同步进入本architecture contract；stable six-document snapshot的independent design audit结论为`0 P0 / 0 P1`。Audit结论本身不替代用户批准；针对该设计的用户批准已在后续gate完成。该结论也不证明future implementation/tests：

1. **R21 / prior P0 — evidence partition**：M1四路`CanonicalToolEvidencePartitionV1`、M4 nominal `DurableRecoveryAuthorityViewV1`/same-view `AutomaticRecoveryProofSliceV1`已闭合SafeRetry/Continue eligibility；compatibility-only、mixed、manual-only与nonfinal phase fail closed。
2. **R22 / prior P1 — reconstructible replay payload**：M1 inline/sealed replay carriers、M4 snapshot/proof materialization与M7 exact-order reconstruction/commitment recomputation合同已闭合；Legacy history/cache/public/current-provider fallback禁止。
3. **R23 / prior P1 — durable tool phase**：五phase与M4 O3a append-only no-side-effect reconciliation已闭合；`reconciled-terminal-manual-only`关闭barrier但永久禁止automatic。
4. **R24 / prior P1 — sealed-use lifecycle**：M2 stable no-send reservation与M4 K7–K10 lifecycle、双K8、K4/K5 conflict、K9 zeroization及exclusive-fence K10已闭合；无TTL/renew/reopen/time-based death inference。
5. **R25 / additional P1 — policy authority**：runtime只消费transaction-verified committed `NormalizedRecoveryPolicy.digestInput.effectiveMaxModelAssistants`；config/`agent.steps` reread、top-level direct access与runtime re-min均禁止。
6. **R26 / additional P1 — owner export/call-order convergence**：M1现导出`DispatchAdmissionV1`、`TypedIncompleteTerminalFact`、`AssistantChainHeadV1`、`AggregateEventHeadV1`、`AutomaticRecoveryAction`、`RecoveryAdmissionPolicyBindingV1`及既有replay/closure/predecessor/operation-schema surfaces；private receipt variants与`OperationApplyModeV1`仍只经exported/indexed surfaces消费。M2 reservation/full prepare input、M4仅exported/indexed M1 references、O10 branded-authority two-stage supersession、M4 nominal view/O3a/K7–K10、M7 descriptor/reconstruction/validation与exact 21-step automatic order已对齐。

这些obligations已通过fresh stable-snapshot independent design audit、用户批准与Step 0 expectations抽取。D0 package-ownership correction、M1-A foundation与M1-B F1/F2的review/commit/push gate均已完成；M1-C F4也已完成实现、验证与独立review，当前只待文档同步、commit与push。只有该gate完成后才进入F3 raw recovery definitions；F5–F31与SESSREC-2仍不得提前开始。

## 12. 固定实施选择（independent design audit、用户批准与Step 0均已完成）

以下六项在当前implementation contract中保持冻结，不是开放alternatives；D0 package-ownership correction不得改变这些选择，implementation也不得自行改选：

1. **首批available adapters**：built-in AI SDK Anthropic Messages、OpenAI Responses以及native HTTP JSON，只有在最终transform后、底层send前具备exact paused gate和完整target/authority/storage proof时available；dynamic/custom/WebSocket/unknown路径保持opaque、fallback或disable。
2. **Outer retry策略**：保留现有429/503 generic retry行为，但每次重新进入provider execution前写独立semantic dispatch ordinal与ledger；canonical incomplete仍不重试，多dispatch source的incomplete固定ambiguous。Recovery-gated native transport首批不允许隐藏的内部HTTP resend。
3. **Legacy tool begin/start API**：由M3 `LegacyToolExecutionGate`统一拥有。完整原始call和hook invocation先durable，才允许side-effectful before hook；hook rewrite/replacement/short-circuit再写final-plan revision，随后才能execute。
4. **`N`/model-assistant配置合同**：用户已选择`N`默认2、`configuredM`默认64；N为非负safe integer，`configuredM`与`agent.steps`为正safe integer，非法值由codec拒绝。仅M1 normalization在配置`agent.steps`时计算`effectiveM = min(configuredM, agent.steps)`，未配置时取`configuredM`；runtime、M4 first application与exact replay只消费transaction-verified committed `NormalizedRecoveryPolicy.digestInput.effectiveMaxModelAssistants`，不得读取配置或再次取min。Initial、ordinary与recovery-child admission均要求`assistantSequence < effectiveM`；shell synthetic assistant不分配sequence且不消耗该bound。
5. **首批Continue allowlist**：Anthropic只允许audited local/client function call/result，server/hosted tool unavailable；OpenAI `store=true`只允许settled local function call/output及满足完整identity/target proof的stored reasoning reference，hosted items unavailable；`store=false`首批只允许不依赖reasoning state的local function closure，encrypted reasoning/hosted items unavailable。
6. **Public/UX**：display-only optional projection放在Legacy assistant；不新增public recovery authority event。旧error可见、新child独立、ManualStop不建child、recovery pending期间保持busy，最终effective assistant决定同步返回与CLI exit。

完整函数签名、字段、分支与验收由`detailed-design.md`及四个子计划唯一拥有；如果源码证明上述任一机械前提无法成立，必须返回架构阶段重新评审，不能在实现中静默降低。

### 12.1 Global future acceptance delta

以下均为`[F — planned; not created; not run]`：

- Type-1在empty aggregate、nonempty aggregate、紧随model type-10三种情况下均保持model-lineage genesis；wrong type-10 post head/reservation拒绝。
- Type-10 model/no-reply字段互斥；reservation digest six-member vectors；noReply对policy/M7/M2/type-1/assistant/ledger/M/release的调用与写入均为0。
- Operations 8–10从raw+envelope确定性重建所有decision fields；operations 1/2/9 atomic Legacy assistant/message materialization且type-1不重建user。
- O1/O2/O8/A5及authorization/ordinal settlement使用complete result；detached valid receipt拒绝。
- Automatic严格遵守complete M4 view→M5 select→same-view slice→M7 plaintext-free descriptor→stable type-9 ID→M2 no-send reservation→K7→K3 replay reconstruction/lowering→M2 exact nine-field prepare/original inspection→M7 same-object validate→M5 classify→O8/K8 commit→complete result→immediate K8→F27/M2 authorized/open→exclusive latch/delegate boundary once→K9/zeroize→delegated-only empty attempt→ordinal 0 once→consume；unknown-delivery fatal且不cancel/resend，type-9拒绝assistant genesis与child-ledger non-genesis。
- Corrupt/partial/owner-mismatched/non-foldable/ambiguous authority fatal；failed automatic commit的ManualStop需要exact absence/no winner与valid binding。
- Shell保持serialized但recovery/model budgets/preparation为0；M4 display mapping由transaction分配/复用，M1 projector pure，rebuild稳定。

## Appendix A. 分布式边界七维合同

本文虽不设计cluster ownership，但provider stream、public HTTP与cross-process replay涉及分布式边界；不适用项也显式说明。

### A.1 连接模型

- Provider：连接模型由现有provider SDK/HTTP transport决定，可能是每请求短连接或内部连接池复用；Issue #7不新增或假定特定pool。逻辑request lifetime从matching complete result→pre-release K8→F27/M2 authorization后，exclusive latch内的exact delegate boundary开始，到normal terminal、transport failure、caller interruption或transport cleanup结束；关闭只释放client-side stream/connection资源，不证明provider回滚side effect或session state。prepare与authorized/held本地pre-call阶段不得建立已越过request-send boundary的语义。
- Public Legacy HTTP：沿用现有server listener与client transport的连接复用/关闭策略。generated SDK的unprefixed prompt path有B级live HTTP运行证据；TUI使用unprefixed operations只有`[S — source seam only]`，当前没有production submission E2E。Issue #7不改变keep-alive/pool合同；client断开只终止该HTTP observation，不删除durable Session或回滚已授权provider request。
- Internal recovery authority：SQLite本地事务，无远程连接；transaction结束后释放本地DB资源，不改变已提交raw authority。
- 重连：provider stream断开不自动重放semantic dispatch；进入typed settlement/recovery。跨进程re-entry重新prepare，不能恢复旧内存handle。

### A.2 超时与 deadline

- 本文不新增connect/read/write/global deadline；沿用现有transport行为。
- timeout若无法证明delegate boundary尚未越过，dispatch必须进入`released/unknown-delivery` fatal terminal，不能转成cancelled、known-unsent或SafeRetry证据。
- paused或authorized/open handle在ownership丢失或pre-delegate exception时必须走mechanical cancel/no-handle barrier→K9→cleanup；authorized/held必须由release owner先判定known-not-delegated并退latch，或记录unknown terminal。Cleanup timeout不能升级为delegate许可。
- 通用timeout/watchdog重构为N/A，原因是超出Issue #7范围。

### A.3 重试与幂等

- Canonical incomplete不由generic retry处理。
- Automatic SafeRetry的“重试方”是Legacy recovery coordinator，并创建新assistant；incomplete recovery本身不采用transport-style backoff/jitter，最大次数由durable `N` admission决定。
- Provider/SDK内层retry的最大次数、backoff与jitter：Issue #7不新增通用合同。`[S — source seam only]`显示当前audited normal Legacy prompt invocation未传`retries`，`llm.ts`因而向AI SDK传入`maxRetries=0`；C级3个TCP processor检查只归类为covered processor/provider-call observations，不归类为retry evidence。唯一retry检查归入D，且只直接断言其covered `SessionRetry.retryable(...)` behavior。上述观察都不得外推到所有adapter、transport或Legacy invocation。若dispatch proof不能枚举并覆盖全部physical requests，则provider fence为unknown。
- Legacy outer `SessionRetry.policy()`的最大次数、backoff与jitter：保持既有generic retry policy，不由本文重新定义；详细设计必须选择首次dispatch后禁用outer resend，或把每次resend记录为独立semantic dispatch。无论哪种选择，多个ledger entries的incomplete source都ManualStop。
- Provider idempotency只有在完整semantic-attempt scope、domain与sealed reference均有明确contract时成立；否则unknown。
- `N`限制recovery child，不限制physical request。

### A.4 交付与顺序语义

- raw recovery transitions按dedicated recovery aggregate sequence全序、transactional append；aggregate selector为envelope.aggregateID，M4验证session owner mapping；accepted same-event replay幂等。generic public EventTable aggregates维持各自原顺序合同，不纳入recovery chain。
- public safe projection通过现有live event通道只是best-effort notification，不承诺断线期间at-least-once delivery；权威的用户可见恢复依赖HTTP transcript/session hydration与reconciliation。消费者不得把信号次数或是否收到单次event当authority。若未来需要cursor/ack/`Last-Event-ID` replay，必须单独设计。
- provider dispatch不承诺exactly-once；complete result→pre-release K8→authorization→exclusive latch保证每个authorized child至多一次本地delegate boundary。Boundary未知固定记录`released/unknown-delivery`并禁止cancel/resend，不把网络ambiguity伪装为known-unsent。
- Tool side effect通过durable-before-execute建立happens-before。

### A.5 失败模式

- 假设本地进程、SQLite或provider为fail-stop/omission；不处理Byzantine provider或被攻破storage。
- 网络分区、slow response或stream truncation表现为typed/error/unknown settlement，不能从silence证明安全。
- SQLite/projector/CAS或其它pre-delegate failure对当前进程可见，并强制mechanical cancel/no-handle barrier→K9→cleanup；K9 failure在cleanup/lookup前fatal。
- Split-brain ownership为N/A：本文不支持clustered Session；若未来引入，必须新增lease/consensus设计。

### A.6 状态与会话

- Recovery是有状态协议，以session ID、chain ID、assistant ID、decision ID/revision与dispatch ordinal关联。
- raw `EventTable`中的dedicated recovery aggregate保存recovery authority；sealed material通过其专用authority aggregate/opaque reference关联，不保存raw value。generic public aggregates不因此升级为recovery authority。
- 新连接/新进程可从raw events重建materializations，但不能恢复旧paused handle，也不能凭任何旧record直接发送；automatic record若存在已经consumed并关联唯一child。
- session删除按现有cascade删除aggregate与materializations。

### A.7 背压与流控

- Provider stream沿用现有consumer/backpressure机制；本文不新增buffer size合同。
- Tool settlement未完成时terminal classification等待，不通过丢弃evidence缓解背压。
- Internal replay在完整prefix/head finalization前suppress live publication，避免半重建状态冲击subscriber。
- Queue capacity与overflow policy为N/A：本文不引入新的跨进程消息队列；若现有TUI sync拥塞，只能影响display freshness，不能影响authority或dispatch admission。
