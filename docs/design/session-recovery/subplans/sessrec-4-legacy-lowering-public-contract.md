# 细化设计 — Session Recovery / sessrec-4-legacy-lowering-public-contract

> 状态：M7/M8函数级详细设计candidate；当前architecture/detail/subplans stable snapshot的fresh independent design audit已达到`0 P0 / 0 P1`，等待用户再次批准；生产实现、Step 0、Step 5 implementation audit与future tests均未开始。
>
> 权威输入：
>
> - `docs/design/session-recovery/architecture.md`
> - `docs/design/session-recovery/subplans/sessrec-1-contract-canonicalization.md`（M1）
> - `docs/design/session-recovery/subplans/sessrec-2-durable-authority.md`（M4）
> - `docs/design/session-recovery/subplans/sessrec-3-legacy-runtime-recovery.md`（M2/M3/M5/M6）
> - `docs/workflow.md` §3、§4.3
>
> 本文只拥有 M7 的 lowering 实现契约、M7 导出的 `LoweredRecoveryCandidate`，以及 M8 的 Legacy public/UX adapter 契约。M1/M2/M3/M4/M5/M6 的共享类型与 runtime/authority 行为只按其 exact owner-qualified export 引用；本文不创建同义 structural alias。

## 1. 范围、固定决策与非目标

### 1.1 覆盖范围

1. Legacy `SessionV1.WithParts[]` 的 SafeRetry source-before-all-transforms 截断，但只接受与完整 `M4.DurableRecoveryAuthorityViewV1` exact绑定的 branded `M4.AutomaticRecoveryProofSliceV1`。
2. ContinueAfterSettledTools 只从同一 branded proof slice 中的 M1 authority-bound reconstructible replay carriers构造target-neutral `M1.RecoveryClosureDescriptor`与actual ordered `ModelMessage[]`；裸 `M1.DurableRecoverySnapshot`、fold、Legacy history/cache/public projection都不是Continue输入。
3. Anthropic Messages、OpenAI Responses `store=true`、OpenAI Responses `store=false` 的保守 lowering/inspection。
4. M7 导出一个 `LoweredRecoveryCandidate`；它只在M4 lease-scoped dynamic use内作为M2完整九字段recovery `prepareDispatch`的exact `lowered`参数存在，并绑定stable `M2.PreparedHandleCommitmentReservationV1.pausedHandleCommitment: M1.PausedHandleCommitment`与same live M4 lease objects。
5. M5 selection → M7 target-neutral closure descriptor（无replay plaintext）→ M2 stable no-send handle-commitment reservation → M4 K7 live leases → M7 lease-scoped actual lowering → M2 唯一actual preparation/final-fetch/native same-object inspection → M7 validation → M5 final classification → M4 K8 commit validation+transaction → complete `M1.OperationCommitResultV1<"automatic-child-admitted-and-consumed">` → immediate pre-release M4 K8 validation（handle仍prepared）→ M1 F27 validation + M2 exact handle/reservation authorization → M2 release exactly once → M4 K9 close/zeroize 的owner顺序。
6. M1 public projection、M8 F30 decode、Legacy HTTP/SDK、CLI、interactive CLI、TUI、public event source partition。
7. shell serialized-queue/recovery-bypass 与 Native V2 regression-only 边界。

### 1.2 固定决策

- `safe-retry` candidate 完全不含 source assistant 的 info、parts、metadata、structured/provider options 或其 digest；它只接受 `proof.kind === "safe-retry-eligible"`、`proof.partition.authorityClass === "truly-empty"`、`proof === authority.toolEligibility` 且 `proof.snapshotIdentity === authority.snapshotIdentity` 的M4 branded object。裸snapshot/fold、compatibility-only、mixed、manual-only或structural proof lookalike一律拒绝。
- SafeRetry 先对完整 Legacy history 做 identity/order uniqueness pre-pass，再定位 source；所有 plugin/experimental transform、compaction、shaping、`ModelMessage[]` conversion、provider transform 和 digest 只接收 source 之前的 prefix。
- Continue只接受同一authority view中的`proof.kind === "continue-eligible"`；partition必须exact `authoritative-only`，每个`M4.AutomaticRecoveryToolEvidenceProofV1.evidence.phase`必须exact `final-after-hook-settled`，且tool/reasoning/provider-prefix proofs的brand、snapshot identity、source range、operation/event ordering与closure source binding全部exact。compatibility-only/mixed/manual-only、中间phase、reconciled-manual-only、plain snapshot/fold或structural duplicate均不能automatic。
- `M1.RecoveryClosureDescriptor` 是跨 M7/M2/M5 的唯一 shared closure shape。M7在任何unseal与actual message lowering前先从branded proof slice构造并用M1 builder/F22复验target/provider-neutral descriptor；descriptor只含M1 `RecoveryReplayPayloadV1` carriers与commitments，不含replay plaintext。M7 private helper不得导出第二套 closure/replay schema。
- R22 actual `ModelMessage[]`只可由proof slice中的M1 `RecoveryReplayPayloadV1`、`ToolTerminalReplayPayloadV1`与`OperationSchemaByTypeV1["provider-prefix-recorded"]["payload"]["checkpoint"]["content"]`重建。inline必须是secret-safe canonical value；sealed必须经same live lease的`M4.withUnsealedMaterial`。每个值都strict decode、canonical re-encode并通过exact M1 builder/F22重算owner commitment与closure digest。禁止Legacy history/cache/public projection、provider cache/current cursor、raw SQL/private replay输出或one-way digest inversion。
- M7不拥有handle/lease lifecycle，不classify、不commit、不authorize、不release。M2在actual preparation前只提供stable no-send `M2.PreparedHandleCommitmentReservationV1`（其commitment为`M1.PausedHandleCommitment`）；M4 K7拥有lease acquire，M2/M6拥有cancel/release orchestration，M4 K8拥有commit validation与complete result后的immediate pre-release validation，M1 F27与M2共同完成exact handle/reservation authorization，M4 K9拥有close/zeroization。M2 actual prepare仍恰一次；M7→M2必须调用S3 owner的完整九字段`prepareDispatch` declaration，不得把四字段摘录写成complete signature；pre-release K8、authorization与network release复用该次preparation的exact final-fetch/native object，且K8期间handle仍为prepared。
- M2 preparation 内产生 `M2.M2InspectionResult`；M7 validator在 M2 privileged preparation scope 内消费其 `available` branch，不导出或依赖第二套post-prepare inspection shape。
- M6 唯一拥有顺序：M3 terminal+`M4.DurableRecoveryAuthorityViewV1` → M5 `selectRecoveryCandidate` → M7 descriptor construction（无plaintext）→ M2 stable handle-commitment reservation → M4 K7 lease acquire → M7 lease-scoped target/provider-neutral lowering → M2完整九字段actual prepare once/original inspection → M7 same-object validation → M2 frozen planned materialization → M5 `classifyRecovery` 产出final `M1.RecoveryProposal` → M4 K8 commit validation+transaction → complete `M1.OperationCommitResultV1<"automatic-child-admitted-and-consumed">` → immediate pre-release M4 K8 validation（same handle仍prepared）→ M1 F27 validation + M2 exact handle/reservation authorization → M2 release same handle exactly once → M4 K9 close/zeroize。任何M7 descriptor/lowering前都必须已有该轮exact M5 selection；inspection后仍必须回到M5 final classification，M7/M2不得自行产出proposal。任一prepared/validation或automatic pre-release failure必须从prepared状态mechanical cancel → K9 close/zeroize → cleanup，再进入post-cancel work；pre-release K8 failure的F27与M2 authorization调用次数均为0，K9 failure在cleanup前fatal。
- automatic child、decision consumption、child recovery ordinal、public projection、三个recovery heads与aggregate event head/cursor在 `M4.commitAutomaticChild` 的一个 transaction 中提交；完整`M1.OperationCommitResultV1<"automatic-child-admitted-and-consumed">`成功后禁止再创建 child，detached `M1.AutomaticRecoveryAdmissionReceiptV1`不授权。
- automatic commit failure/unknown的唯一顺序是：mechanical cancel exact unreleased handle（只使send closure不可达，不先cleanup）→ M4 K9 close/zeroize same leases → M2 cleanup已cancel handle/close reservation registry → M4 A5 `lookupRecoveryOperationResult`按原`aggregateID + operationID + expectedInput + expectedPayloadDigest + expectedReceiptKind`做exact result lookup → 必要时M4 S2 `lookupCurrentRecoveryWinner` → winner follow/re-enter、replan、独立ManualStop或fatal post-cancel work。K9 failure在cleanup与A5/S2/replan/ManualStop之前立即fatal，且不得丢弃把handle/reservation与same leases关联起来所需的registry state；不得把winner改写为ManualStop或创建replacement handle。
- 只有同时满足四项时，failed automatic attempt才可进入独立ManualStop：A5 exact lookup已证明该automatic operation absent、M4 S2 `lookupCurrentRecoveryWinner`已证明no winner/unchanged、fresh M4 S1 `loadRecoverySnapshot`重新证明source binding未变、且automatic attempt之前已经存在由M5/F23独立classified的eligible safety cause。commit conflict、response ambiguity、lookup failure或事后新造cause均不满足此前提。进入这些lookup前必须已经成功mechanical cancel → K9 close/zeroize → cleanup；满足四项后仍须 `M4.commitManualStop` 返回完整`M1.OperationCommitResultV1<"decision-finalized">`，才可返回source；detached `M1.ReceiptForV1<"decision-finalized">`不授权。
- corrupt、partial、owner-mismatched、non-foldable、unresolved、unknown或 ambiguous authority/result/winner lookup一律fatal；不得进入M5 ManualStop proposal、不得调用`M4.commitManualStop`改写事实、不得返回source成功。若存在prepared handle，固定先mechanical cancel → K9 close/zeroize → cleanup，再执行A5/S2/fatal post-cancel work；K9自身失败则在cleanup前fatal并保留关联registry state。
- public projection ownership严格拆分：M4只拥有raw authority fold、materialization验证/写入与stable display-ID allocation/reuse，并产出`M1.RecoveryPublicAuthorityViewV1`；M1 F28 `projectRecoveryForPublic`纯构造`M1.RecoveryPublicProjectionV1 | undefined`且不写表/不分配ID；随后才进入`SessionV1.Assistant.recovery?` → M1 F30 decoder → M8 display/hydration。无 M8 CAS、revision、receipt或 authority。
- M1 known projection 的 `outcome:"manual-stop"` 是 authority owner 已提交事实到最终显示状态的确定性投影。它的 public semantic 仅是 final display state；不能授予 authority、驱动内部 action、授权 release/cancel/commit 或替代 M4 receipt/fold。
- `M1.RecoveryPublicProjectionV1` 只含 M1 已导出的字段：`version`、optional `dispatchCount`、optional `evidence`、optional `sourceErrorPreserved`、optional `child.displayID`、optional `outcome`。不得增加 `state`、pending/succeeded/failed、effective-assistant、final-assistant、authority child ID、target、digest、operationID、revision、head、receipt或 sealed ref。
- `M1.RecoveryChildDisplayID` 是 opaque display hint。M8 不把它 cast/parse/lookup 为 `SessionV1.MessageID` 或 `M1.RecoveryAssistantID`，也不以它证明 source/child/final authority。
- public source/child/final row只从普通 public transcript的真实 user/assistant parent-chain、message/part关系与 hydrated status 推导；projection只可附加 display hint。唯一例外是 known `outcome:"manual-stop"` 可把已识别的 source row显示为最终 ManualStop 状态，但仍不证明任何内部 authority。
- F30 decode精确区分 `known | unsupported | malformed`：`unsupported` → adapter省略 projection；`malformed` → typed hydration error；不得把 malformed 当 absent。projection absent/unsupported 或 malformed 且无 actual child 时，public consumer不得推断 ManualStop；malformed必须失败，absent/unsupported保持无该显示事实。
- fatal/indeterminate reconciliation只通过既有 safe public error、status 与 hydration surface表现为 non-success 或 typed unresolved；不新增 public authority event、`session.recovery.*` public variant或“fatal/unresolved authority”投影。
- 三个 exact `UnknownError` strings 由 M8 / `sessrec-4-legacy-lowering-public-contract` compatibility mapping唯一拥有，除非未来 M1 实际导出同一常量/schema。当前 M1 只拥有 `TypedIncompleteTerminalFact.publicMessageKind`，本文不虚构 M1 constants。
- `N` 是 `max_incomplete_recoveries` 的规范化值（缺省 `2`），只计 incomplete-triggered child admission；不计 initial、ordinary continuation、semantic dispatch、model step、physical provider request或 shell。
- `M`只取transaction-verified committed `NormalizedRecoveryPolicy.digestInput.effectiveMaxModelAssistants`，计所有committed model assistants：initial、ordinary continuation、recovery child；不计shell、dispatch、model step或physical provider request。历史 normalization 规则只归M1 `normalizeRecoveryPolicy`：它把configured `max_model_assistants`（缺省`64`）与optional `agent.steps`规范化为`effectiveM = min(configuredM, agent.steps)`，`agent.steps` absent时使用`configuredM`。M6 coordinator、runtime、first application与exact replay都不得重读config/`agent.steps`、重算或再次取min，只能消费transaction-verified committed digest input值。
- `N` 与 `M` 都不是 dispatch budget、provider-hit budget或 tool-liveness bound。
- synchronous prompt/command只建立 partial-correctness theorem：若 M6 返回 final `CoordinatorResult`，M8 mapping返回 final effective assistant；N/M 不证明 provider、tool或外部服务会完成。
- attach/hydration wait与 server operation liveness分离。M8 不自行设置绝对结束时刻或重试次数；等待只受现有 operation/session/transport lifecycle、user cancellation、source close与已有 reconnect policy约束。
- indeterminate HTTP disconnect后禁止 transparent resend。只有未来另行批准并公开稳定 idempotency contract 才能自动重发；hydration/status可 reconcile，absence不能证明请求未被接受。
- 每次成功建立 SSE connection 都分配严格递增的 connection generation。新 generation 先使所有旧 generation 的 cached session hydration guards失效；active/current sessions eager transcript+status hydrate，其它cached sessions保持invalid并在被选择时lazy transcript+status hydrate。
- CLI human transcript/progress可分别显示source与child attempts。machine-readable/JSON只能采用两种冻结模式之一：attempt-framed records（每条带assistant/source IDs，且有单独final-effective-result record），或synchronous final-result mode（恰一条final effective result）；禁止把unframed failed-source bytes与successful child output拼接。
- root/v2 `prompt_async` runtime success是 exact `204 No Content`、0 response bytes；generated root/v2 success payload type是 `void`，但 method仍返回现有 generated client response envelope。
- current `prompt_async` 的 `Cause.pretty` public publication只标记为`[S — source seam only]`，不是期望行为；sanitizer改动与 regression是 F obligation。
- shell recovery N/A：M8 shell submission仍进入M6 per-session serialized queue，但在M6内走shell branch并绕过model recovery/lowering；不消费N/M。Native V2只做 regression，不新增 recovery API/event/schema/authority。

### 1.3 非目标

- 不修改或重新定义 M1/M2/M3/M4/M5/M6 owner types；尤其不复制M1 replay/operation schema、M4 proof/lease brand或M2 handle proof。
- 不让M7拥有K7/K8/K9、lease table、generation transition、close/zeroization或handle lifecycle。
- 不在 M8 引入 public recovery authority、public `session.recovery.*` event或 idempotency API。
- 不支持 Anthropic server tools、OpenAI hosted tools或 OpenAI stateless reasoning continuation。
- 不以 projection、SSE顺序、idle事件或 display ID替代 durable/current public transcript关系。
- 不新增 M8-local timeout、retry count或 provider/tool completion保证。
- 不创建或运行测试；§10 仅列 future obligations。

## R. 与已有代码的复用点（top-level reuse）

本节是机械检索入口；只列复用，不把current seam写成future完成事实。每个current事实仍必须带exact `[S — source seam only]`，每个未实现/未创建/未运行义务仍必须带exact `[F — planned; not created; not run]`。

| 复用 owner / seam | M7/M8复用方式 | 禁止的替代实现 |
|---|---|---|
| M1 exact codecs、F23、F28–F31与public event nominal carriers | M5调用F23；M4唯一调用F28并在publication前F29；M8只调用F30/F29；F31/M1 service组装public source。各边界直接import owner-qualified type/callable，Effect边界最多lift一次M1`ContractResult` | M8调用F28、structural alias、local reason mapper、broad event union、prefix过滤 |
| M4 `loadRecoverySnapshot`、branded `DurableRecoveryAuthorityViewV1`/`AutomaticRecoveryProofSliceV1`、K3/K7/K8/K9、A5 `lookupRecoveryOperationResult`、`lookupCurrentRecoveryWinner`、`commitAutomaticChild`、`commitManualStop` | M7只消费与complete authority view exact绑定的automatic slice；sealed carrier只在K7 live lease下经K3读取；K8先在type-9 commit点复验，再在complete transaction result后的immediate pre-release点、handle仍prepared且F27尚未调用时复验same set/handle；K9只在release exactly once或cancel后close/zeroize；snapshot/mapping、exact response-loss lookup、complete winner、transaction result均由M4提供 | 裸snapshot/fold、structural proof/lease、receipt-only恢复、operationID-only lookup、M7/M8 authority或lease lifecycle |
| M5 `selectRecoveryCandidate`、`classifyRecovery` | 每次M7 lowering前先selection；M2 original inspection/validation后保留final classification | M7/M2自行select/classify或跳过post-inspection classification |
| `MessageV2.toModelMessagesEffect` positional callable | SafeRetry只把source-free prefix传入；保持inline options object | full-history transform、第二个converter options alias |
| M2 unique preparation/inspection/cancel/authorize/release | 完整九字段`prepareDispatch`、同一prepared object、同一inspection、同一handle；complete result后先由M4 immediate pre-release K8复验，再由M1 F27 + M2 exact handle/reservation authorization，最后release exactly once；prepared failure先mechanical cancel→K9→cleanup，K8 failure的F27 calls=0 | four-field complete signature、second prepare、handle substitution、cleanup-before-K9、A5/S2-before-K9/cleanup、reversed pre-release ordering |
| M6 `SessionRunState.submitSerialized`与existing shell owner | prompt/command/no-reply/shell都进入同一per-session queue；shell在M6内bypass recovery | wrapper旁路queue、noReply启动model chain、shell消费N/M |
| existing Legacy HTTP encoder、`HttpApiSchema.NoContent`、generated response envelope | prompt/command共享final encoder；prompt_async exact 204/0 bytes | raw JSON fallback、`Cause.pretty`、把generated method改成raw `Promise<void>` |
| existing CLI formatter、public transcript/status hydration、TUI `syncingSessions`与SSE lifecycle | event只作presentation/wakeup；final由sync/hydrator；reconnect复用coalescing/backoff | idle即完成、displayID lookup、M8-local timeout/retry |

## E. 错误处理策略（top-level error strategy）

1. **M7 planning/lowering**：plain snapshot/fold、proof brand/identity/action/partition/phase/source-range/order/carrier/canonical/digest/lease-set/handle-reservation任一失败都返回exact `M1.RecoveryFailureCause`；M7不写authority、不创建handle/lease、不把unknown降级为SafeRetry。sealed callback success/error/interrupt均不得把plaintext、lookup proof、lease或派生长期副本带出dynamic scope。
2. **M2 unavailable / M4 lease closure**：descriptor之后、actual prepare之前的reservation/K7/lowering失败由M2/M6把reservation标abandoned、调用M4 K9关闭已取得lease，K9成功后才cleanup reservation registry；actual prepared object之后的introspection/inspection/provider-specific validation失败严格执行M2 mechanical cancel exact object → M4 K9 close/zeroize same lease set → M2 cleanup exact object/registry → typed unavailable或其它post-cancel result。K9 failure在cleanup前fatal并保留关联handle/reservation/leases的registry state。所有branch无raw material escape，M4-owned DEK/KEK/plaintext/canonical scratch按K3/K9 all-exit zeroize；不得第二次prepare。
3. **M5 classification**：selection只在lowering前固定candidate；original inspection完成并冻结planned materialization后必须再次调用M5 `classifyRecovery`。ManualStop reason只能来自M1 F23对owner-produced causes的canonical mapping。
4. **automatic commit failure/unknown**：严格执行mechanical cancel → M4 K9 close/zeroize same leases → M2 cleanup exact handle/reservation registry → M4 A5 exact result lookup → 必要时M4 S2 complete-winner lookup → follow/re-enter、replan、ManualStop或fatal post-cancel work。K9 failure先fatal且不得cleanup。只有A5证明operation absent、S2证明no winner/unchanged、fresh complete `M4.DurableRecoveryAuthorityViewV1`证明source binding未变、并且存在automatic attempt前已独立classified的eligible cause，才可独立commit ManualStop。lookup unresolved/ambiguous/corrupt/partial/unknown一律fatal。
5. **ManualStop**：fresh proposal/binding成立后，若有prepared handle则mechanical cancel → K9 close/zeroize → cleanup必须happens-before `M4.commitManualStop`；K9 failure在cleanup/commit前fatal。failed automatic attempt还必须保持A5 absent + S2 unchanged + fresh same source binding + pre-existing M5/F23 eligible cause四项exact prerequisites。只有complete `M1.OperationCommitResultV1<"decision-finalized">`后才返回source；失败/unknown在exact lookup无法恢复complete result时返回`M6.FatalRecoveryStop`。
6. **public error**：三个incomplete literal只由M8 / `sessrec-4-legacy-lowering-public-contract` compatibility mapper拥有；fatal只经`sanitizeFatalRecoveryStop`映射到固定Legacy `UnknownError`。任何branch禁止raw cause/stack/authority/receipt/digest/sealed ref/provider body。
7. **hydration/transport**：transient transport状态与hydrator wakeup revision是可恢复local state；只有hydrator在actual relation/status无法完成且lifecycle终止时写`terminalHydrationFailure`。reducer不得把单个SSE fault直接升级为terminal hydration failure或exit failure。
8. **public event read**：malformed/unsupported public event在M1 subscription/decoder边界成为`M1.PublicEventReadErrorV1`；M8 subscriber不接收broad event，也不按type prefix过滤。

## D. 数据结构定义与生命周期（top-level data type lifecycle）

| 数据类型 | 创建 | 有效期 / 转换 | 销毁 / 禁止复用 | owner / consumer |
|---|---|---|---|---|
| `M7.LoweredRecoveryCandidate` | M5 exact selection、M7 descriptor、M2 stable `M2.PreparedHandleCommitmentReservationV1`与M4 K7后，由M7在K3 lease-scoped dynamic use内创建 | semantic payload/closure target/provider-neutral；绑定same reservation commitment与exact `readonly M4.SealedRecoveryUseLeaseV1[]`；只在callback内作为完整九字段`prepareDispatch.lowered`直接交该轮M2 unique actual prepare | K3 callback/prepare round结束即失效；不得return plaintext-bearing candidate到M6、re-lower、clone或持久化；M7不close lease | M7 / M2 immediate consumer；M2/M6+M4 own lifecycle |
| `M4.DurableRecoveryAuthorityViewV1` / `M4.AutomaticRecoveryProofSliceV1` | M4 `loadRecoverySnapshot`从complete raw/materialized authority构造并brand | M7只接受`proof === authority.toolEligibility`且snapshot identity/action exact的eligible branch | plain snapshot/fold/manual-only/compatibility-only/mixed/structural duplicate永不提升；view stale即全部失效 | M4 / M5、M7、M6 |
| `M1.RecoveryAssistantPublicMappingV1` | M4与`M1.DurableRecoverySnapshot`同一WAL read创建 | 仅从`authority.snapshot.assistantPublicMapping`读取且authority/proof identity fresh时有效 | 任一source/control/high-water/revision变化即stale；不得cast/重建 | M1 shape、M4 producer / M7 lookup |
| `M4.SealedRecoveryUseLeaseV1` / `M4.SealedRecoveryUseReleaseValidationV1` | M4 K7/K8根据exact M1 key、snapshot proof、descriptor、positive generation与stable handle commitment构造 | lease只在live generation与K3 dynamic scope授权sealed use；K8 commit复验后，complete result触发immediate pre-release K8复验same exact set/object/prepared handle，之后才可F27+M2 authorization与release once | M4 K9/K10只允许release或cancel后的live→closed并zeroize；M7不得renew/reopen/close或声明拥有lifecycle | M4 / M7 scoped use、M2/M6 orchestration |
| `M1.PlannedRecoveryMaterialization<M2.AvailableDispatchHandle>` | M2 unique preparation + original inspection + M7 validation后创建 | available branch持exact one paused handle；final M5 classification与M4/M2 authorization消费同一对象 | failure仅在mechanical cancel→K9→cleanup后终止；success在release once→K9后终止；不得substitute/clone handle | M1 shape、M2 producer / M5、M6 |
| `M1.PublicCommittedEventV1<D>` | M1 public definition/service成功decode/commit后创建 | 只作为`M1.PublicEventSubscriptionV1<D>` item流经bridge/CLI/TUI/SDK | callback后可丢弃；不得从broad event cast或按prefixbrand | M1 / all public subscribers |
| `M1.RecoveryPublicProjectionV1` | M4 authority view经M1 F28 pure projection并经F29验证 | public message optional value；M8只以F30/F29 decode/assert | unsupported omit；malformed typed failure；绝不反向恢复authority | M1 shape/projector、M4 caller / M8 |
| `M8.LegacyRunCompletionState` | CLI invocation开始创建 | presentation、transient transport、hydrator wakeup、sync/hydrated final、terminal hydration failure分字段单调更新 | invocation结束丢弃；token/generation不可跨invocation复用 | M8 CLI local |
| `M8.LegacyConnectionGeneration` | 每次successful SSE connection后由TUI connection lifecycle分配 | strictly increasing；所有guard/fetch result必须绑定exact current generation | reconnect后prior generation全部失效；late result不得写current guard | M8 TUI local |
| `M8.LegacyInteractiveOperationToken` / `LegacyInteractiveWait` | 每次interactive operation创建 | exact object+token+session/user/source identity；Deferred one-shot | clear后永不复用；最多完成一次 | M8 interactive local |

生命周期总不变量：public display data不提升为authority；candidate/planned/handle/proof/lease不跨round复用；M7 plaintext-bearing candidate不跨K3 scoped continuation；M4 lease只live→closed且K8/K9使用same objects；event brand不由subscriber构造；transient transport/wakeup不等于terminal hydration failure；generation变化先invalidate后hydrate。

## C. 模块与 callable 清单（top-level module/callable inventory）

| 模块 | callable / surface | 输入门槛 | 输出 / 责任 |
|---|---|---|---|
| M7 descriptor/lowering | `buildProviderNeutralRecoveryClosure`、`lowerSafeRetryHistory`、`reconstructProviderNeutralContinueMessages`、`lowerLegacyRecoveryRequest` | exact M5 selection；same branded M4 authority/proof；descriptor先于reservation/K7；lowering只在same live lease set+stable handle commitment的K3 scope | callback-scoped exact `M7.LoweredRecoveryCandidate`；无authority/lease lifecycle ownership；actual ordered messages只来自M1 replay carriers |
| M7 same-object validation | `build*ClosureConstraint`、`validatePreparedRecoveryInspection` | M2 original available inspection；同一轮M5 selection、same candidate/reservation/lease objects仍绑定 | validation only；随后回M2 frozen planned materialization、M5 final classification、M4 K8 commit transaction；complete result后必须先immediate pre-release K8，再F27+M2 authorization、release once、K9 |
| M8 server mapping | `toLegacyCoordinatorResponse`、`serveLegacySyncOperation`、`promptAsync` | exact `M6.CoordinatorResult` / `M6.SerializedSubmission` | final effective assistant、exact 204或sanitized error |
| M8 queue wrappers | `submitLegacyNoReply`、`submitLegacyShell` | exact closed `M6.SerializedSubmission` branch | noReply user-only；shell shell-final；两者均不进入M7/M2 |
| M8 projection/hydration | `decodeLegacyRecoveryProjection`、`adaptDecodedLegacyRecoveryProjection`、`reconcileLegacyDisconnect`、`hydrateLegacyRunCompletion` | M1 F30 exact result、public transcript/status anchors | known/unsupported/malformed exact语义；actual relation final或typed non-success |
| M8 public events | `publishLegacyPublicState`、`reduceLegacyRunEvent`、`reduceLegacyRunTransport`、`applyLegacyTuiPublicEvent`以及CLI/TUI/SDK subscriber callbacks | event item exact来自`M1.PublicEventSubscriptionV1<D>`；transport transition独立输入 | ordinary public signal、presentation merge、transient transport与hydrator wakeup；无prefix filter |
| M8 interactive/TUI | `complete`、`hydrateLegacyTuiReconnect`、`applyLegacyTuiPublicEvent`、`deriveLegacyRecoveryView` | exact wait identity或current branded connection generation + hydrated status | one-shot completion、generation-safe event merge/eager/lazy hydration、pure view |
| M8 compatibility | `legacyIncompleteUnknownErrorMessage`、`sanitizeFatalRecoveryStop`、CLI framing/exit resolver、model converter exclusion | exact owner union/value | stable old-client output，无raw private field |

## 2. `[S — source seam only]` current evidence boundary

本节每一项都只描述当前源码接缝，不证明 future recovery contract已经实现。

| 标记 | current source seam | 精确边界 |
|---|---|---|
| [S — source seam only] | `packages/opencode/src/session/prompt.ts::{prompt,run,loop,command}` | 当前 service interface返回 `SessionV1.WithParts`；无 M6 recovery coordinator wiring。 |
| [S — source seam only] | `packages/opencode/src/session/message-v2.ts::{toModelMessagesEffect,toModelMessages}` | 输入 options仍为两个callable各自的inline object type；当前没有独立exported options type。 |
| [S — source seam only] | `packages/opencode/src/session/llm/request.ts::prepare`、`packages/opencode/src/session/llm.ts::run`、`packages/opencode/src/provider/transform.ts::message` | 是 future M2 final transform/no-send gate接缝；当前无 recovery candidate contract。 |
| [S — source seam only] | `packages/llm/src/route/client.ts` native compile/prepare path | 可作为 same-object no-send seam；future contract仍须禁止 second compile/prepare。 |
| [S — source seam only] | `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts::SessionApi` | `prompt`/`command` success schema为 `SessionV1.WithParts`；`promptAsync` success schema为 `HttpApiSchema.NoContent`。 |
| [S — source seam only] | `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts::{prompt,promptAsync,command}` | prompt手工 JSON stream，command走 typed encoder；当前没有 shared sync helper。 |
| [S — source seam only] | `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts::promptAsync` failure branch | 当前把 `Cause.pretty(cause)` 放入 public `NamedError.Unknown`；必须由 future sanitized mapping替换，不能写成当前已安全。 |
| [S — source seam only] | root/v2 generated `Session.promptAsync` | 204 success payload是 `void`；method surface是 generated client envelope，不是 raw `Promise<void>`。 |
| [S — source seam only] | `packages/schema/src/v1/session.ts::SessionV1.Assistant/WithParts` | 当前尚无 `recovery` field或 F30 decoder wiring。 |
| [S — source seam only] | `packages/opencode/src/session/message-v2.ts::{info,hydrate,page,get,stream}` | 当前 hydration对 info做 spread/cast；无 projection-specific tolerant decode。 |
| [S — source seam only] | `packages/core/src/session/projector.ts::messageData` | future optional projection persistence seam；当前无 M4 public projector contract。 |
| [S — source seam only] | `packages/opencode/src/cli/cmd/run.ts::{RunCommand,execute,loop,finish}` | 当前 SSE error会影响exit；successful sync `result.data`未成为 final authority；attach无 hydration resolver。 |
| [S — source seam only] | `packages/opencode/src/cli/cmd/run/stream.transport.ts::{Wait,complete,poll}` | 当前 `Wait`无 operation/user/source anchor；`complete`依赖generic idle；missing status可被视为idle；250ms只是poll cadence，不是timeout。 |
| [S — source seam only] | `packages/tui/src/context/sync.tsx::SyncProvider.session.sync` | `fullSyncedSessions` one-shot guard存在；当前sync不联合fetch status。 |
| [S — source seam only] | `packages/tui/src/context/sdk.tsx::startSSE` | 现有 reconnect为 lifecycle-cancelled unbounded backoff；无total deadline，成功重连后未强制 transcript+status hydration。 |
| [S — source seam only] | `packages/core/src/event.ts::EventV2.Interface`、`packages/opencode/src/event-v2-bridge.ts::EventV2Bridge.Service`、instance/global SSE handlers | 当前 source未分 public/internal recovery union；future必须在 listen/all/durable/bridge/SSE之前 partition。 |
| [S — source seam only] | `packages/opencode/src/session/message-v2.ts::toModelMessagesEffect` assistant branch | 当前显式读取 ordinary fields且不spread `msg.info`进 model message；future `recovery` field仍须 regression锁定排除。 |
| [S — source seam only] | `SessionRunState.ensureRunning`/`Runner.ensureRunning` 与 `SessionPrompt.cancel`/`Runner.cancel` | 当前同步等待无timeout；work属于long-lived scope，现有cancel是lifecycle owner。 |
| [S — source seam only] | `SessionRetry.policy` | provider retry有独立owner；M8不得改写成N/M或另加固定重试次数。 |

## 3. Exact owner/import 表与错误 ownership

### 3.1 Shared types

| Exact symbol | owner | 本文用途 |
|---|---|---|
| `M1.RecoveryAssistantID` | M1 | internal source/child authority identity；不用于public row ID |
| `M1.CandidateAssistantAttemptIdentity`、`M1.CandidateDispatchAttemptContext` | M1 | M2 unique preparation的non-authoritative candidate identity/context；不得使用M1 private union名 |
| `M1.RecoveryOperationID` | M1 | S3 owner `prepareDispatch.operationID` exact automatic operation identity；与reservation/proof/lease bindings逐字段一致 |
| `SessionV1.MessageID` | `packages/schema` | hydrated public transcript message identity |
| `M1.RecoveryChildDisplayID` | M1 | opaque display hint；禁止authority lookup |
| `Extract<M1.RecoveryClosureDescriptor,{status:"available"}>["providerPrefix"]`、`M1.OperationSchemaByTypeV1["provider-prefix-recorded"]["payload"]["checkpoint"]` | M1 indexed exported surfaces | frozen/durable/planned prefix与reconstructible content equality；不命名private `ProviderPrefixCheckpoint` alias |
| `M1.DurableRecoverySnapshot` | M1 | 只作为`M4.DurableRecoveryAuthorityViewV1["snapshot"]`的owner shape；M7 automatic intake不接受裸值 |
| `M1.DispatchTarget` | M1 | planned target/protocol/storage validation |
| `M1.RecoveryClosureDescriptor` | M1 | M7→M2→M5唯一shared closure；M7先构造无plaintext descriptor |
| `M1.RecoveryReplayPayloadV1`、`M1.RecoveryReplayPayloadCommitmentProjectionV1`、`M1.ToolTerminalReplayPayloadV1`、`M1.CanonicalWireValueV1` | M1 | R22 tool arguments/result/error、reasoning与provider-prefix唯一reconstructible carriers；禁止consumer-local replay alias |
| `M1.RecoveryClosureDigest`、`M1.ToolPlanDigest`、`M1.ToolCallDigest`、`M1.ToolResultDigest`、`M1.ReasoningTextDigest`、`M1.ProviderPrefixDigest`、`M1.ProviderPrefixAncestryDigest`、`M1.SemanticDigest` | M1 | purpose-specific digest；canonical decode/re-encode后用exact builder/F22重算；禁止generic commitment或digest inversion |
| `M1.SealedRecoveryMaterialRef`、`M1.SealedRecoveryUseLeaseKeyInputV1`、`M1.PausedHandleCommitment` | M1 | sealed carrier ref、K7 exact key与stable handle reservation |
| `M1.RecoveryFailureCause`、`M1.DurableRecoverySnapshot["terminal"]` | M1 exported/indexed surfaces | M7 typed fail-closed cause与M8 exact public-message mapping key；不命名private terminal alias |
| `M1.RecoveryClosureDescriptor["action"]` | M1 indexed exported surface | exact lowercase action literals；不命名private action alias |
| `M1.LegacyUserMessagePredecessorV1`、`M1.OperationSchemaByTypeV1` | M1 | Legacy predecessor与10-operation payload/predecessor exact indexed schema；M7/M8不得复制structural operation alias |
| `M1.RecoveryProposal` | M1 | M5 classifier output |
| `M1.AutomaticRecoveryAdmissionReceiptV1` | M1 | automatic M4 commit receipt |
| `M1.ReceiptForV1<"decision-finalized">` | M1 | ManualStop M4 commit receipt |
| `M1.RecoveryPublicProjectionV1` | M1 | 唯一public projection value |
| `M1.ContractResult<A,E>`、`M1.RecoveryPublicProjectionDecodeResult` | M1 | F30 exact outer result与inner `known\|unsupported\|malformed` union；M8不复制/unwrap成第二套decoder contract |
| `M1.PublicProjectionViolation` | M1 | malformed projection detail，只进入typed hydration error |
| `M1.PublicEventDefinitionV1<D>`、`M1.PublicDurableEventDefinitionV1<D>`、`M1.PublicCommittedEventV1<D>`、`M1.PublicEventCursorV1` | M1 | public event source/wire唯一nominal carriers；只能来自`publication:"public"` definition |
| `M1.PublicEventListenerV1`、`M1.PublicEventSubscriptionV1<D>`、`M1.PublicEventReadErrorV1`、`M1.PublicEventServiceV1` | M1 | listen/all/typed/durable/read public-only surface；subscriber item exact为`M1.PublicCommittedEventV1<D>`，internal payload不可表示 |
| `M1.PublicEventManifestV1`、`M1.PublicDurableEventManifestV1` | M1 | public manifest exports；与trusted private replay manifest不可赋值 |
| `M2.LegacyRuntimeInput` | M2 | existing Legacy runtime materialization input；S3 owner `prepareDispatch.runtimeInput` exact type |
| `M2.PreparedHandleCommitmentReservationV1` | M2 | S3 owner `prepareDispatch.reservation` exact stable no-send reservation；其commitment逐字段绑定candidate/context/operation/proof/closure/target/gate/generation与future handle |
| `M2.AvailableDispatchHandle` | M2 | recovery available `PlannedRecoveryMaterialization`内唯一live prepared handle type |
| `M2.M2InspectionResult` | M2 | unique preparation内包含final target/protocol/storage/body的original inspection result |
| `M2.M2PrepareError` | M2 | preparation error |
| `M2.DispatchAuthorizationError` | M2 | receipt authorization failure |
| `M2.DispatchReleaseError` | M2 | release/send-state failure |
| `M2.MechanicallyCancelledDispatch` | M2 | cancel后send closure不可达proof |
| `M4.RecoveryAuthorityErrorV1`、`M4.CurrentRecoveryWinnerV1` | M4 | automatic/ManualStop transaction failure与M4 `lookupCurrentRecoveryWinner` exact complete-winner/unchanged lookup result |
| `M4.DurableRecoveryAuthorityViewV1`、`M4.AutomaticRecoveryProofSliceV1`、`M4.AutomaticRecoveryToolEvidenceProofV1`、`M4.AutomaticRecoveryReasoningEvidenceProofV1`、`M4.AutomaticRecoveryProviderPrefixProofV1` | M4 | M7唯一automatic authority intake与R21/R22 branded proof carriers；manual-only branch不属于slice |
| `M4.SealedRecoveryUseLeaseV1`、`M4.SealedRecoveryUseReleaseValidationV1` | M4 | R24 K7/K8 exact live lease与release-near nominal validation；M7不重声明、不拥有lifecycle |
| `M1.RecoveryAssistantPublicMappingV1` | M1 shape；M4 producer | 只从`M4.DurableRecoveryAuthorityViewV1.snapshot.assistantPublicMapping`读取；M7只lookup，不cast/重建 |
| `M4.RecoverySnapshotReadErrorV1` | M4 | snapshot authority-view read failure |
| `M4.RecoverySealErrorV1` | M4 | K3/K7/K8/K9 sealed-use failure |
| `M6.SerializedSubmissionOperationID`、`M6.SerializedSubmission` | M6 | prompt/command/no-reply/shell internal coordinator input；不是public idempotency key/wire |
| `M6.CoordinatorResult` | M6 | M8唯一server-side final result input；runtime-private handoff |
| `M6.FatalRecoveryStop` | M6 | `CoordinatorResult.kind === "fatal-stop"` internal payload；只能交exact sanitizer，不得serialize raw fields |
| `M7.LoweredRecoveryCandidate` | M7（本文） | M7唯一导出；M2 recovery prepare exact input |
| `ModelMessage` | AI SDK/current converter owner | Legacy semantic message seam |
| `Provider.Model` | `packages/opencode` | converter model input |
| `SessionStatus.Info` | `packages/opencode/src/session/status.ts` | public hydration status |
| `HttpApiSchema.NoContent`、`HttpApiError.BadRequest`、`ApiNotFoundError` | Effect HTTP API / current route owners | prompt_async exact 204 runtime value与current endpoint error union；不使用无关旧错误owner |

禁止重新引入旧版generic ID/prefix/commitment、parallel prepared-handle/inspection、parallel M4 command/receipt、parallel classifier/target/current-chain/coordinator-error或converter-options alias。本文所有signature必须直接使用上表exact owner symbol；不存在exact export时只引用owner callable及其参数位置，不在M7/M8补一个同shape type。

### 3.2 M8-owned exact UnknownError mapping

M1当前未导出三个literal或shared UnknownError schema constant；因此本子计划把 literal→Legacy public error mapping唯一放在 M8 / `sessrec-4-legacy-lowering-public-contract` compatibility adapter。不得在 processor、AI adapter、HTTP或tests再建第二套literal owner。

```ts
export function legacyIncompleteUnknownErrorMessage(
  kind: M1.DurableRecoverySnapshot["terminal"]["publicMessageKind"],
):
  | "Provider stream ended without a terminal finish event"
  | "Provider stream ended without a settled model step"
  | "Provider stream ended with an unknown finish reason and no usable output"
```

精确映射：

1. `adapter-incomplete` → `Provider stream ended without a terminal finish event`
2. `clean-eof` → `Provider stream ended without a settled model step`
3. `empty-unknown-finish` → `Provider stream ended with an unknown finish reason and no usable output`

编码继续使用现有 Legacy `UnknownError` branch：`name: "UnknownError"`，`data.message`为上面literal，optional `data.ref`只按现有schema语义使用；不得放 raw cause、stack、receipt、digest、authority或 sealed material。

**Callers**：M3 terminal public mapping、M8 prompt_async sanitizer、HTTP/SSE/SDK adapter。

**Callees**：无；纯total switch。

**Requires**：input是M1 decoder产出的known `publicMessageKind`。

**Ensures**：返回且只返回对应的exact literal；unknown runtime value不产生raw-cause string。

**步骤与退出**：

1. switch exact `publicMessageKind`。
2. 三个known branch返回唯一literal。
3. compile-time exhaustive `never` branch；runtime unknown不得调用 `Cause.pretty`，而是进入existing sanitized unknown mapping。

**进展**：无循环、无等待。

**副作用/残留**：无。

**§4.3.2 正确性论证**：input union只有三个值；每值唯一映射到既有literal，exhaustive branch阻止silent fallback，所以返回值逐字稳定且无raw cause来源。

### 3.2.1 M8-owned exact fatal sanitizer

```ts
export function sanitizeFatalRecoveryStop(
  failure: M6.FatalRecoveryStop,
): SessionV1.Assistant["error"]
```

唯一public结果固定为existing Legacy error shape：

```ts
{
  name: "UnknownError",
  data: { message: "Session recovery stopped before a safe final result" }
}
```

**Callers**：`toLegacyCoordinatorResponse` fatal branch、`promptAsync` background failure publication、public status/error adapter。

**Requires**：input是M6 exact exported `FatalRecoveryStop`；caller不得先stringify/pretty-print/spread `failure.cause`。

**Steps/branches**：1) exact验证`tag:"fatal-recovery-stop"`与closed `handleDisposition`，只用于internal branch discrimination；2) 不读取或格式化`cause`内容；3) 构造上面exact constant；4) runtime malformed input仍返回同一constant并记internal redacted diagnostic，不回显值。

**Ensures**：public discriminator/message逐字固定；output不含cause、stack、handle disposition、authority ID、receipt、digest、sealed ref、provider body或operationID；不新增public recovery error kind。

**Side effects/progress**：pure finite construction；optional internal redacted diagnostic由caller owner处理，不进入返回值。

**§4.3.2正确性论证**：output完全由constant构造且不读取raw cause，故任意runtime-private failure都映射到同一old-client-decodable public value，不可能经`Cause.pretty`或structural spread泄漏。

### 3.3 M8 private adapter types

这些类型只存在于M8 local adapter，不冒充M1–M7 authority或shared schema。

```ts
export type LegacyHydrationError =
  | Readonly<{
      tag: "malformed-projection"
      violation: M1.PublicProjectionViolation
    }>
  | Readonly<{
      tag: "missing-status"
      sessionID: string
    }>
  | Readonly<{
      tag: "relation-inconsistent"
      sessionID: string
      reason: "missing" | "multiple" | "cycle" | "wrong-operation"
    }>
  | Readonly<{
      tag: "transport-cancelled" | "transport-closed"
      sessionID: string
    }>

declare const LegacyConnectionGenerationBrand: unique symbol
export type LegacyConnectionGeneration = number & {
  readonly [LegacyConnectionGenerationBrand]: true
}

export type LegacyTransientTransportState =
  | Readonly<{ tag: "connecting" }>
  | Readonly<{
      tag: "live"
      connectionGeneration?: M8.LegacyConnectionGeneration
    }>
  | Readonly<{
      tag: "interrupted" | "closed"
      observedAtWakeupRevision: number
    }>

export type LegacyRunCompletionState = Readonly<{
  presentationErrors: readonly string[]
  transientTransport: M8.LegacyTransientTransportState
  hydratorWakeupRevision: number
  syncFinal?: SessionV1.WithParts
  hydratedFinal?: SessionV1.WithParts
  terminalHydrationFailure?: M8.LegacyHydrationError
  currentUserID?: SessionV1.MessageID
  currentSourceID?: SessionV1.MessageID
}>

export type LegacyRunEventReduction = Readonly<{
  state: M8.LegacyRunCompletionState
  wakeHydrator: boolean
}>

declare const LegacyInteractiveOperationTokenBrand: unique symbol
export type LegacyInteractiveOperationToken = string & {
  readonly [LegacyInteractiveOperationTokenBrand]: true
}

export type LegacyInteractiveWait = {
  tick: number
  armed: boolean
  live: boolean
  sessionID: string
  operationToken: M8.LegacyInteractiveOperationToken
  userMessageID: SessionV1.MessageID
  sourceAssistantID?: SessionV1.MessageID
  signal: AbortSignal
  done: Deferred.Deferred<void, M8.LegacyHydrationError>
}
```

类型不变量：

- `LegacyHydrationError`不含raw cause、stack、authority、receipt、digest、sealed ref或provider body；它只表示hydrator已经判定的terminal non-success，不表示每次transport interruption。
- `LegacyConnectionGeneration`只能在successful SSE connection后由connection lifecycle从严格递增safe integer构造；subscriber、guard与fetch result只能携current generation，prior-generation late result不可写current state。
- `LegacyRunCompletionState.transientTransport`、`hydratorWakeupRevision`与`terminalHydrationFailure`是三个独立维度：reducer可更新前两者但不得写terminal failure；hydrator只在actual reconciliation无法完成且lifecycle terminal时写`terminalHydrationFailure`。
- `hydratorWakeupRevision`是non-negative safe integer并只按relevant public committed event或transport transition严格`+1`；`wakeHydrator === true` iff本次reduction使该revision增加。
- `LegacyRunCompletionState.syncFinal`与`hydratedFinal`由不同路径写入；sync final优先，presentation errors与transient transport永不决定final/exit。
- `LegacyInteractiveOperationToken`只在进程内做one-shot identity equality；不是M4 operation ID、public idempotency key或wire value。
- wait清除后不得复用token；Deferred最多完成一次。

## 4. M7 data contract 与跨模块接口

[F — planned; not created; not run] 本节全部为future M7/M2/M5 interface obligation；不是current export完成声明。

### 4.1 `M7.LoweredRecoveryCandidate`

```ts
export type LoweredRecoveryCandidate = Readonly<{
  owner: "M7"
  action: M1.RecoveryClosureDescriptor["action"]
  semanticMessages: readonly ModelMessage[]
  closure: M1.RecoveryClosureDescriptor
  snapshotProof: M4.AutomaticRecoveryProofSliceV1
  preparedHandleCommitment: M1.PausedHandleCommitment
  sealedUseLeases: readonly M4.SealedRecoveryUseLeaseV1[]
}>
```

类型不变量：

- `snapshotProof`必须是M7 intake时`proof === authority.toolEligibility`的same branded eligible object；candidate不接受或保存plain snapshot/fold/manual-only/structural proof。
- `action === "safe-retry"` iff `snapshotProof.kind === "safe-retry-eligible"`、partition exact `truly-empty`且`closure`是 `{status:"not-needed", action:"safe-retry"}`；此branch `sealedUseLeases`必须exact empty。
- `action === "continue-after-settled-tools"` iff `snapshotProof.kind === "continue-eligible"`、partition exact `authoritative-only`、每个tool proof phase exact `final-after-hook-settled`、`closure.status === "available"`且closure action同值。
- `preparedHandleCommitment`是M2在actual preparation前创建的stable no-send reservation；每个`sealedUseLeases[i].leaseKey.preparedHandleCommitment`必须逐字段等于它。M7不创建、更新、关闭或延长reservation/lease。
- `sealedUseLeases`按M1 sealed ref stable order与descriptor所需sealed refs双向set-equal；每个lease必须是M4 K7返回的same nominal live object，key内generation/purpose/scope/material commitment/source/action/operation/target/handle binding exact。零sealed ref时exact `[]`，不得创建占位lease。
- SafeRetry `semanticMessages`不含source及其任何派生内容。Continue `semanticMessages`是proof carriers重建出的actual ordered provider-neutral grammar；inline与sealed路径产生canonical equal消息顺序。
- candidate的semantic fields与`closure`在original M2 inspection前保持target/provider-neutral，不含final target、protocol、storage mode或capability choice。M4 lease/key中的target digest只是opaque use-authorization metadata，M7不得读取它选择provider branch或改写messages。
- candidate不含 `M1.SemanticDigest`：final target/options/body只有M2 unique actual preparation后才完整，semantic/prepared/binding digest由各owner在正确阶段创建。
- candidate不含handle、final body、receipt、raw signature、raw sealed bytes或lookup proof；plaintext-bearing `semanticMessages`只能在nested `M4.withUnsealedMaterial` dynamic scope内立即交M2，不得返回到M6、缓存、clone、日志或持久化。provider-specific allowlist只能在original M2 available inspection后运行。

### 4.2 M7 → M2 exact input

M2 owner文档中的private recovery `prepareDispatch` callable必须按S3 owner完整九字段声明；其 `lowered` 参数位置直接使用 `M7.LoweredRecoveryCandidate`，本文不把该private callable伪装成M2 exported symbol，也不允许把candidate/context/lowered/runtimeInput四字段摘录呈现为complete signature：

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
  runtimeInput: M2.LegacyRuntimeInput
}>): Effect.Effect<
  M1.PlannedRecoveryMaterialization<M2.AvailableDispatchHandle>,
  M2.M2PrepareError
>
```

这是全局唯一actual-preparation complete declaration与return signature。本文不声明第二个lowered representation、replay carrier、prepared-handle brand、lease alias或inspection alias。M2 owner callable的九个parameter fields必须逐字使用上述owner-qualified types，并直接import `M7.LoweredRecoveryCandidate`；该跨文档引用仍须在§12 final audit中保持unchecked。

调用方 M6/M2 保证：descriptor已在无plaintext阶段构造；stable `M2.PreparedHandleCommitmentReservationV1`先于K7；K7先于任何sealed unseal/actual lowering；callback中的candidate只调用一次M2 actual prepare，并传齐`candidate/context/operationID/snapshotProof/closure/sealedUseLeases/reservation/lowered/runtimeInput`九字段。M2/M4保证：

1. `snapshotProof === lowered.snapshotProof`、`closure === lowered.closure`、`sealedUseLeases`与`lowered.sealedUseLeases`保持same array members/object identities；`reservation.pausedHandleCommitment`逐字段exact等于`lowered.preparedHandleCommitment`与随后same prepared handle commitment，且candidate/context/operationID/proof/closure绑定全部通过S3 owner reservation validator。不得clone/replace/reacquire，也不得从`lowered`反向猜缺失的九字段参数。
2. opaque/disabled/introspection-unavailable在创建actual live handle前返回`PlannedRecoveryMaterialization.status="unavailable"`；unavailable branch不含paused handle。caller以`abandoned`关闭leases并触发K9 zeroization。
3. available adapter恰执行一次final-fetch/native paused preparation；pre-release provider hit count为0。M2不得因reservation阶段再计一次prepare。
4. descriptor/native inspector在该same object上产生original available `M2.M2InspectionResult`，包含final target/protocol/storage/body。
5. M2把该original available inspection与same candidate原样交给`M7.validatePreparedRecoveryInspection({candidate:lowered,inspection})`；M7此时才使用inspection target调用provider-specific allowlist/closure validators。
6. unavailable inspection、validator failure或任一post-allocation preparation failure固定为：M2 mechanical cancel exact prepared object → M2/M6调用M4 K9以`mechanically-cancelled`关闭/zeroize same lease set → K9 success后M2 cleanup exact object并关闭reservation registry → 返回typed unavailable且无live handle/raw material。K9 failure在cleanup/registry discard前立即fatal，保留关联same handle/reservation/leases所需state；不得返回typed unavailable、replan或继续classification。success返回`PlannedRecoveryMaterialization.status="available"`且其中`pausedHandle`就是该同一`M2.AvailableDispatchHandle`。
7. M5 final classification后，M4 K8 commit validation必须以type-9 `M1.OperationSchemaByTypeV1["automatic-child-admitted-and-consumed"]["payload"]`内closure/package与same lease set复验；transaction完成并返回complete `M1.OperationCommitResultV1<"automatic-child-admitted-and-consumed">`后，下一步必须是M4 immediate pre-release K8 validation：same handle仍prepared，same complete result、same prepared commitment与same leases返回`M4.SealedRecoveryUseReleaseValidationV1`。只有该proof成功后，M2才调用M1 F27并完成same exact handle/reservation authorization，随后在proof dynamic scope内release同一handle exactly once。K8 failure必须从prepared状态mechanical cancel → K9 close/zeroize → cleanup，再进入post-cancel work；F27与M2 authorization calls=0，K9 failure在cleanup前fatal。
8. canonical success固定为complete result → immediate K8 while prepared → M1 F27/M2 authorization → release exactly once → M4 K9 close/zeroize；只有K9 success后才cleanup/close handle-reservation registry。任一prepared failure则mechanical cancel → K9 close/zeroize → cleanup，再进入A5/S2/replan/ManualStop/fatal等post-cancel work；K9 failure先fatal并保留relation registry。pre-prepare abandon/no-handle与owner-confirmed lost-handle另使用各自closed disposition调用K9，但同样不得在K9成功前丢弃lease relation state。M7没有lease lifecycle callable。之后禁止re-lower、re-serialize、re-prepare、lease substitution或handle substitution。

### 4.3 M5/M4/M2 sequence

1. M5 `selectRecoveryCandidate`必须先于任一M7 descriptor/lowering。M7只接受M4 complete authority view+same branded automatic slice，先构造/复验无plaintext `M1.RecoveryClosureDescriptor`；随后M2产生stable no-send handle commitment reservation，M4 K7取得exact live lease set，M7才在K3 dynamic scope重建actual messages并立即调用M2 actual prepare once。original inspection完成并冻结planned materialization后，M5 `classifyRecovery`仍是唯一final proposal owner。M5只在authority/planned/admission inputs均由各owner证明exact、可fold、owner一致且无unresolved/ambiguous branch后返回`M1.RecoveryProposal`。
2. `kind:"manual-stop"`：M6验证proposal来自M5/F23且source binding fresh；若有prepared handle则严格先mechanical cancel，使send closure不可达 → M4 K9关闭/zeroize same live leases → K9 success后M2 cleanup exact handle/reservation registry → 再调用`M4.commitManualStop`。K9 failure在cleanup与ManualStop commit前fatal并保留lease-relation registry。仅完整`M1.OperationCommitResultV1<"decision-finalized">` success或A5 exact replay恢复同一complete result后返回source final。detached`M1.ReceiptForV1<"decision-finalized">`不授权；unresolved/corrupt result lookup时fatal-stop。failed automatic attempt进入本branch还必须先满足A5 absent、S2 unchanged/no winner、fresh same source binding、pre-existing M5/F23 eligible cause四项exact prerequisites。
3. `kind:"automatic"`：M4在type-9 writer transaction内先调用K8 commit validation，输入closure/package/snapshot identity与same exact lease set；success后`M4.commitAutomaticChild` first-apply/exact replay返回完整`M1.OperationCommitResultV1<"automatic-child-admitted-and-consumed">`。first application与exact replay的budget判断都只消费transaction-verified committed `NormalizedRecoveryPolicy.digestInput.effectiveMaxModelAssistants`；不得读取runtime config/`agent.steps`或re-min。exact replay不要求historical lease仍live，但当前release path仍必须有same live set。
4. complete result返回后必须立即调用M4 pre-release K8 validation；此时原handle仍为prepared，K8以same result/commitment/lease objects返回nominal proof，且该success必须happens-before任何M1 F27或M2 authorization。只有K8 success后，M2才以该proof、complete result、M5 owner proposal与原available planned materialization调用M1 F27验证`receipt + operationPostState + proposal + planned`，并完成same exact handle/reservation authorization；随后M2仅在该dynamic proof scope内release exactly once，最后M4 K9以`released`关闭并zeroize。detached`M1.AutomaticRecoveryAdmissionReceiptV1`、detached/old K8 proof永不授权。
5. automatic commit failure/unknown：严格先mechanical cancel exact handle且不cleanup → M2/M6调用M4 K9以`mechanically-cancelled`关闭/zeroize same leases → K9 success后M2 cleanup exact handle/reservation registry → 随后调用M4 A5 `lookupRecoveryOperationResult`。A5输入必须由独立保留的首次提交完整exact tuple构造，不能只给operationID，也不得依赖已cleanup registry。A5返回complete automatic result→验证complete result但不得再authorize/release已cancel handle，直接follow/re-enter committed child winner，由generic committed-assistant re-entry决定后续，不创建新lease/handle于A5路径；A5 typed inconsistent/busy/unresolved→fatal。K9 failure在cleanup/A5前fatal并保留relation registry。
6. A5返回`undefined`只证明该exact operation missing；M6随后调用M4 S2 `lookupCurrentRecoveryWinner`。任一`manual-stop | automatic | superseded` complete winner均原样follow/re-enter；`unchanged`才构成no winner。只有“A5 operation absent + M4 S2 `lookupCurrentRecoveryWinner` no winner/unchanged + fresh M4 S1 `loadRecoverySnapshot` complete authority view证明source binding unchanged + automatic attempt前已由M5/F23独立classified的eligible safety cause”四项同时成立，才可在已完成cancel → K9 → cleanup之后回到步骤2提交独立ManualStop。ordinary conflict/commit failure本身不得生成cause。
7. corrupt、partial、owner mismatch、non-foldable、unknown、unresolved或ambiguous authority/result/winner一律fatal；prepared handle已按mechanical cancel → K9 → cleanup完成后才可执行A5/S2/fatal post-cancel work，禁止ManualStop、replacement prepare/lease或source-success fallback；若K9失败则cleanup与这些post-cancel work均不得执行。
8. K8 commit validation failure、complete result后的immediate pre-release K8 failure、`M2.DispatchAuthorizationError`或其它pre-release failure：handle仍prepared且未release，必须mechanical cancel → K9 close/zeroize same lease set → cleanup exact handle/reservation registry，再按需要执行A5/S2/replan/fatal post-cancel work。特别地，pre-release K8 failure时F27与M2 authorization calls=0；若涉及commit/result authority则按步骤5–7 exact resolution，禁止replacement prepare/lease。K9 failure先fatal并保留registry state。
9. `M2.DispatchReleaseError.sendState === "unknown"`：K9只能以owner确定的abandon/lost-handle事实关闭并zeroizelocal material，不得声称撤销可能已发生的send；禁止伪造ManualStop或透明重发，M6返回fatal-stop/ambiguity路径。

## 5. M7 callable specifications

建议归属：`packages/opencode/src/session/recovery/lowering.ts`。[F — planned; not created; not run] 以下均为future callable；source路径只具有§2 `[S — source seam only]`证据。

### 5.1 `lowerSafeRetryHistory`

```ts
export const lowerSafeRetryHistory: (input: {
  history: readonly SessionV1.WithParts[]
  authority: M4.DurableRecoveryAuthorityViewV1
  proof: Extract<M4.AutomaticRecoveryProofSliceV1, { kind: "safe-retry-eligible" }>
  closure: Extract<M1.RecoveryClosureDescriptor, { status: "not-needed"; action: "safe-retry" }>
  preparedHandleCommitment: M1.PausedHandleCommitment
  sealedUseLeases: readonly []
  model: Provider.Model
  options?: {
    stripMedia?: boolean
    toolOutputMaxChars?: number
  }
}) => Effect.Effect<M7.LoweredRecoveryCandidate, M1.RecoveryFailureCause>
```

**Callers**：`lowerLegacyRecoveryRequest` safe-retry branch，在M5 selection、descriptor construction与M2 stable commitment reservation之后。

**Callees**：M4 branded authority/proof validators；`MessageV2.toModelMessagesEffect`；M1 `buildRecoveryClosureDigestInput`/F22 exact verification。

**Requires**：M5已选择SafeRetry；`proof === authority.toolEligibility`，proof/authority private brands有效且`proof.snapshotIdentity === authority.snapshotIdentity`；proof action exact safe-retry、partition exact `Extract<M1.CanonicalToolEvidencePartitionV1,{authorityClass:"truly-empty"}>`、tool/reasoning proofs exact empty；`closure === proof.closure`并经M1 builder复验；`sealedUseLeases` exact empty；history属于same session；source terminal已commit；M2只有stable reservation，actual prepare/inspection尚未开始。

**Ensures**：candidate保存same proof/commitment/empty lease tuple；action/closure为safe-retry；source与之后message完全缺席；provider hits=0；durable/tool/K3 side effects=0；M7未cast/rebuild internal↔public identity。

**步骤、分支、退出**：

1. 验证M5 selection action exact safe-retry，再验证authority/proof same-object、brand、snapshot identity、action与closure object/canonical equality；plain snapshot/fold、manual-only、structural lookalike或任何mismatch → typed failure。
2. 要求partition exact `truly-empty`且complete authority view中的authoritative/compatibility collections都确为空；`compatibility-only`、`mixed`、`authoritative-only`、任何tool/reasoning/prefix replay item或nonempty proof list均失败，绝不把“没有automatic proof”解释为空。
3. 有限pre-pass扫描全部history，验证每row有`SessionV1.MessageID`、session一致、durable order单调、ID唯一；missing/duplicate/out-of-order → planning `M1.RecoveryFailureCause`。
4. 从`authority.snapshot.assistantPublicMapping`读取mapping；先要求它是该same authority snapshot内的object，再逐字段比较mapping identity与`authority.snapshotIdentity`的session/source assistant/source high-water/source-version digest/control-tail-version digest/latest-decision revision；任一不等→stale/frozen-facts failure。随后entries lookup source：absent→mapping-absent；multiple→mapping-ambiguous；role非assistant→wrong-role。不得另传mapping、cast internal ID、用displayID查找或从history猜mapping。
5. 得到唯一fresh public source index；构造`safePrefix = history.slice(0, sourceIndex)`，永不append source并丢弃full-history引用。
6. plugin/experimental preprocessing、compaction、shaping与`toModelMessagesEffect`只接收safePrefix；要求full history的callee使本branch failure。typed conversion failure不返回partial candidate。
7. 复验closure仍是proof-ownedexact safe-retry descriptor；组装candidate，保存same proof、stable commitment与exact empty leases。
8. 返回candidate给same dynamic orchestration；不得调用K3、actual prepare或provider-specific validator。

**循环/进展**：proof/closure checks有限；pre-pass与selection是有限`history.length`线性扫描；无外部等待。

**副作用/残留**：memory、authority view read与converter；失败/成功均无DB/event/tool/network/K3/handle/lease mutation。reservation/empty tuple lifecycle仍由M2/M6/M4拥有。

**§4.3.2 正确性论证**：M4 nominal same-object proof先建立complete snapshot authority且partition exact truly-empty；full uniqueness pass与same-WAL mapping closed exits建立唯一fresh source；slice严格止于source前并缩小所有后续callee输入域，所以source不能进入transform/conversion；same proof/commitment/empty tuple写入candidate建立SafeRetry与R21/R24不变量。

### 5.2 `buildProviderNeutralRecoveryClosure`

```ts
export const buildProviderNeutralRecoveryClosure: (input: {
  authority: M4.DurableRecoveryAuthorityViewV1
  proof: M4.AutomaticRecoveryProofSliceV1
}) => Effect.Effect<M1.RecoveryClosureDescriptor, M1.RecoveryFailureCause>
```

本函数只返回M1 exact exported descriptor，不返回`ModelMessage[]`、plaintext、lease、handle或consumer-local closure alias。

**Callers**：M6在exact M5 automatic selection之后、M2 commitment reservation/M4 K7/M7 actual lowering之前。

**Callees**：M4 authority/proof brand+identity validators；M1 `buildToolPlanDigestInput`、`buildToolCallDigestInput`、`buildToolResultDigestInput`、`buildReasoningTextDigestInput`、`buildProviderPrefixDigestInput`、`buildProviderPrefixAncestryDigestInput`、`buildRecoveryClosureDigestInput`与F22 `verifyDigest`。

**Requires**：`proof === authority.toolEligibility`且两者是M4 owner-produced nominal objects；authority view包含complete `M1.DurableRecoverySnapshot`而不是caller裁剪的fold；M5 selection action与proof action exact；尚无handle reservation、lease、unseal、actual message lowering、actual prepare或inspection。

**Ensures**：SafeRetry只返回proof-owned `not-needed/safe-retry` descriptor且partition exact truly-empty；Continue只返回available descriptor且partition exact authoritative-only、每个tool phase final-after-hook-settled。Continue descriptor按proof order携M1 reconstructible carriers+commitments与provider-prefix content，但不含replay plaintext/final target/protocol/storage/capability choice；所有owner digests与closure digest已由secret-safe commitment projection重算；provider/tool hits=0。

**步骤、分支、退出**：

1. 验证authority/proof private brands、`proof === authority.toolEligibility`、snapshot identity逐字段exact、M5 action equality。plain snapshot/fold、manual-only、structural lookalike、stale/foreign proof均typed failure。
2. SafeRetry：要求`proof.kind="safe-retry-eligible"`、partition exact truly-empty、tool/reasoning proofs exact empty，调用M1 closure builder/F22复验`proof.closure`并原样返回；任何compatibility/authoritative/mixed fact使branch failure。
3. Continue：要求`proof.kind="continue-eligible"`、partition exact authoritative-only、tool proofs nonempty；`closureSourceBinding`逐字段等于authority snapshot aggregate/source/sourceVersion/controlTail。
4. 按`eventSequence`与`callOrdinal`验证`proof.toolProofs`严格ordered、unique且raw operation属于same source version。每项`evidence`必须local、arguments为`M1.RecoveryReplayPayloadV1 & {valueKind:"canonical-wire-value"}`、terminal为exact `M1.ToolTerminalReplayPayloadV1`、phase exact final-after-hook-settled；result/error都保留，不执行tool。对carrier只构造`M1.RecoveryReplayPayloadCommitmentProjectionV1`，调用M1 tool plan/call/result builders与F22重算并比较三digest。
5. 按`eventSequence`验证reasoning proofs ordered/unique、provider-end、mode signed或stored-reference、content为`M1.RecoveryReplayPayloadV1 & {valueKind:"utf8-text"}`；以commitment projection调用reasoning builder/F22重算`textDigest`，保留exact state refs，不按provider/storage删除。
6. 要求`providerPrefixProof` brand/identity/order exact；checkpoint逐字段canonical equal于`authority.snapshot.sourceVersion.providerPrefix`与`authority.snapshot.durableContinuation`，其`content`直接使用`M1.OperationSchemaByTypeV1["provider-prefix-recorded"]["payload"]["checkpoint"]["content"]` surface。调用prefix/ancestry builders与F22重算；absent、digest-only或content mismatch失败。
7. 以proof durable order组装exact `M1.RecoveryClosureDescriptor`；调用closure builder/F22重算`M1.RecoveryClosureDigest`并反向比较。不得strict decode sealed plaintext；此阶段只验证inline canonical shape与sealed ref purpose/scope/material commitment。
8. provider-specific约束推迟到§5.4，只使用original inspection的final target/protocol/storage/body。

**循环/进展**：tool/reasoning/proof scans对finite branded arrays各消费一项；无等待。

**副作用/残留**：authority read、canonical projection与digest only；无K3/K7、executor、DB、event、network、plaintext、handle或lease residue。

**§4.3.2 正确性论证**：same-object M4 brand先证明complete authority与eligible partition；tool/reasoning/prefix proof scans建立source-bound order、final settlement与reconstructible carrier completeness；M1 exact builders/F22从secret-safe projections重算所有commitments和closure digest，因此descriptor可在无plaintext状态下target-neutrally建立，且没有Legacy/digest inversion或pre-inspection provider selection。

#### 5.2.1 `reconstructProviderNeutralContinueMessages`

```ts
export const reconstructProviderNeutralContinueMessages: <A, E>(input: {
  authority: M4.DurableRecoveryAuthorityViewV1
  proof: Extract<M4.AutomaticRecoveryProofSliceV1, { kind: "continue-eligible" }>
  closure: Extract<M1.RecoveryClosureDescriptor, { status: "available" }>
  preparedHandleCommitment: M1.PausedHandleCommitment
  sealedUseLeases: readonly M4.SealedRecoveryUseLeaseV1[]
  use: (candidate: M7.LoweredRecoveryCandidate) => Effect.Effect<A, E>
}) => Effect.Effect<A, E | M1.RecoveryFailureCause | M4.RecoverySealErrorV1>
```

`use`是防止plaintext-bearing `ModelMessage[]`逃逸的private scoped continuation；唯一planned caller是在同一dynamic scope内直接调用M2 owner `prepareDispatch`。本文不导出第二个lowering-result wrapper。

**Callers**：`lowerLegacyRecoveryRequest` Continue branch，在§5.2 descriptor、M2 stable no-send commitment reservation、M1 exact lease-key construction与M4 K7成功之后。

**Callees**：M1 exact V1 replay strict decoders/canonical encoder与上述builders/F22；每个sealed carrier唯一调用`M4.withUnsealedMaterial({ref,lease,use})`；`use(candidate)`立即进入M2 actual prepare once。

**Requires**：M5 selection仍绑定same action；authority/proof/closure object与§5.2输出same；`preparedHandleCommitment`是M2 stable reservation；`sealedUseLeases`与closure/proof中全部sealed carrier refs双向set-equal并按ref stable order，每个都是K7 same live nominal object且lease key的positive generation、purpose、scope、material commitment、source/action/operation/target/handle commitment exact；inline carrier已经M1 secret-safe policy允许。M7不拥有lease close/reopen/renew。

**Ensures**：`use`恰调用一次且参数是actual ordered `M7.LoweredRecoveryCandidate`；tool arguments、tool result/error、reasoning text、provider-prefix content仅来自M1 authority-bound replay carriers；inline与sealed material均strict decode→canonical re-encode→owner builder/F22 recompute后才进入messages；ordering、call/result adjacency、error-vs-result discriminator、reasoning placement与provider-prefix grammar exact preserved。candidate保存same proof、same commitment与same lease objects；additional tool/provider hits=0。callback success/error/interrupt后M4-owned raw bytes/DEK/KEK/canonical scratch清零，candidate/messages/lookup proof不得逃逸。

**步骤、分支、退出**：

1. 重验authority/proof/closure same object/brand/identity/action，closure digest与§5.2 F22结果；重验stable commitment及sealed ref↔lease双向set equality。missing/extra/duplicate/closed/stale/foreign/generation/purpose/scope/material/handle mismatch在读取plaintext前失败。
2. 构造一个由`providerPrefixProof.eventSequence`、每个tool proof `eventSequence/callOrdinal`与reasoning proof `eventSequence`组成的strict total order；duplicate、rollback、gap that violates owner order或cross-kind ambiguity失败。不得用Legacy message timestamps、array accident或provider cache重排。
3. 对每个`M1.RecoveryReplayPayloadV1` carrier执行同一materialize routine：
   1. `carrier:"inline"`：只接受M1 secret-safe exact value；strict decode其`CanonicalWireValueV1`或UTF-8 text，canonical re-encode并byte-compare。
   2. `carrier:"sealed"`：按ref找到same K7 lease，调用`M4.withUnsealedMaterial`；在callback内strict decode、canonical re-encode、验证M1 nominal lookup proof与ref purpose/scope/material commitment；不得return/cache raw bytes、lookup proof、lease或derived long-term copy。
   3. 以`M1.RecoveryReplayPayloadCommitmentProjectionV1`及materialized canonical value重建owner input，分别调用tool plan/call/result、reasoning、prefix/ancestry builder与F22；one-way digest不能提供value，digest mismatch立即失败。
4. provider-prefix content按其M1 canonical provider grammar解码为ordered prefix messages并置于proof order位置；不得从current cursor/cache补字段。tool arguments形成exact local call content；`ToolTerminalReplayPayloadV1.kind`决定result或error grammar且紧随对应call；reasoning text按proof order/provenance插入。inline/sealed路径必须产出canonical equal `ModelMessage[]`。
5. 对完成的messages与closure再次调用M1 closure builder/F22，确认carrier/order/digest未因shaping改变；unknown/prose/media/structured/hosted/provider-executed item或无法表达的grammar typed failure，不静默删除。
6. 组装candidate `{owner,action,semanticMessages,closure,snapshotProof:proof,preparedHandleCommitment,sealedUseLeases}`，不添加target/protocol/storage/capability；在最内层K3 scopes仍live时调用`use(candidate)`恰一次。
7. `use` success返回其A；typed error/defect/interrupt沿Effect语义退出。所有exit由nested K3 bracket清零raw material；M2/M6随后按事实调用K9：pre-actual-prepare failure=`abandoned`，post-handle failure=`mechanically-cancelled|lost-handle-cleanup`。M7不调用K9且不声称拥有lifecycle。

**循环/进展**：proof/carrier/message arrays有限；每carrier一次materialize与有限canonical traversal。K3 completion受existing store/keyring/cancellation lifecycle约束，无M7 timeout/renew loop。

**副作用/残留**：M4 K3 bounded authority/keyring/crypto reads与all-exit zeroization；M7 memory/canonicalization；M2 callback可创建唯一paused object。无tool execution、provider release、authority write或public event。失败/cancel无raw material、lookup proof、sendable replacement handle或live unowned lease residue；lease closure由M2/M6+M4 K9负责。

**§4.3.2 正确性论证**：input只含same M4 nominal proof与K7 capabilities；total-order merge固定cross-kind顺序，per-carrier materialize又排除Legacy/cache/digest inversion；strict decode/re-encode和owner builder/F22给出value、grammar与commitment equality；K3 bracket+scoped continuation阻止plaintext result逃逸；same proof/commitment/lease objects写入candidate使K8能先在commit点、再在complete result后的immediate pre-release点（handle仍prepared）复验同一对象，之后才进入F27+M2 exact authorization与release once；ownership段同时把lease lifecycle留给M2/M6/M4。

### 5.3 Provider-specific constraint callables

#### 5.3.1 `buildAnthropicClosureConstraint`

```ts
export const buildAnthropicClosureConstraint: (input: {
  closure: Extract<M1.RecoveryClosureDescriptor, { status: "available" }>
  inspection: Extract<M2.M2InspectionResult, { tag: "available" }>
}) => Effect.Effect<void, M1.RecoveryFailureCause>
```

**Callers/Callees**：`buildProviderClosureConstraint` / M1 target+descriptor validators。

**Requires**：closure来自§5.2；inspection是same paused object的original available result，且其final target protocol为Anthropic。

**Ensures**：final body只含R22 carrier-reconstructed local call/result-or-error并保持exact order/provider grammar；reasoning若有则mode signed且refs purpose/scope/material commitment/final target匹配same candidate lease-bound material；server/hosted/provider-executed item、silent strip或provider-prefix rewrite不可接受。

**步骤**：从inspection读取final protocol/target/body → 有限检查tool allowlist → 有限检查signed refs → mismatch退出 → 返回void success。

**退出/副作用/残留**：success只证明same-object final representation满足Anthropic约束；failure为typed cause；无side effect/residue。

**进展**：有限数组扫描，无等待。

**§4.3.2正确性论证**：所有Anthropic must-understand项均由allowlist覆盖，else全部fail closed，因此success蕴含post。

#### 5.3.2 `buildOpenAIStoredClosureConstraint`

```ts
export const buildOpenAIStoredClosureConstraint: (input: {
  closure: Extract<M1.RecoveryClosureDescriptor, { status: "available" }>
  inspection: Extract<M2.M2InspectionResult, { tag: "available" }>
}) => Effect.Effect<void, M1.RecoveryFailureCause>
```

**Callers**：`buildProviderClosureConstraint` OpenAI stored branch。

**Callees**：M1 target/storage/descriptor validators。

**Requires**：inspection是same paused object的original available result，且其final target为OpenAI Responses、canonical storage mode为true。

**Ensures**：final body只含R22 carrier-reconstructed local function_call/output或exact error grammar并保持order；stored-reference reasoning的item/target/model/lowerer commitments、provider-prefix content与same candidate sealed refs/leases可验证；silent strip、hosted/provider execution拒绝。

**步骤**：从inspection验证final protocol/storage true/body → 检查local pairs → 检查stored-reference refs/scope → no-reasoning branch允许 → mismatch退出 → 返回void success。

**进展/副作用/残留**：有限扫描；无等待、unseal、write、send或residue。

**§4.3.2正确性论证**：same-object final storage与reasoning mode同时验证，故stateless/stored混淆不能进入success。

#### 5.3.3 `buildOpenAIStatelessClosureConstraint`

```ts
export const buildOpenAIStatelessClosureConstraint: (input: {
  closure: Extract<M1.RecoveryClosureDescriptor, { status: "available" }>
  inspection: Extract<M2.M2InspectionResult, { tag: "available" }>
}) => Effect.Effect<void, M1.RecoveryFailureCause>
```

**Callers**：`buildProviderClosureConstraint` OpenAI stateless branch。

**Callees**：M1 target/storage/descriptor validators。

**Requires**：inspection是same paused object的original available result，且其final target为OpenAI Responses、canonical storage mode为false。

**Ensures**：final body只含R22 carrier-reconstructed local function_call/output或exact error grammar并保持order；reasoning array与stateful provider-prefix continuation必须empty；encrypted reasoning、stored item reference、hosted item及silent conversion均拒绝。

**步骤**：从inspection验证final protocol/storage false/body → 检查local pairs → reasoning非空立即failure → forbidden item failure → 返回void success。

**进展/副作用/残留**：有限扫描；无等待或residue。

**§4.3.2正确性论证**：success branch显式要求reasoning empty并拒绝所有state-carrying item，所以不发生stateless continuation泄漏。

#### 5.3.4 `buildProviderClosureConstraint`

```ts
export const buildProviderClosureConstraint: (input: {
  closure: Extract<M1.RecoveryClosureDescriptor, { status: "available" }>
  inspection: Extract<M2.M2InspectionResult, { tag: "available" }>
}) => Effect.Effect<void, M1.RecoveryFailureCause>
```

**Callers**：`validatePreparedRecoveryInspection` Continue branch only；M2前禁止调用。

**Callees**：上面三个provider-specific callable；每个callee pre/post如各节。

**Requires**：closure来自§5.2；inspection是current unique preparation的original available result并含canonical final target/protocol/storage/body。

**Ensures**：success证明same-object final representation与inspection target protocol/storage exact匹配；unsupported/unknown全部typed failure；不修改candidate、inspection或handle。

**步骤、分支、退出**：

1. 从inspection admission/frozen request读取final target/protocol/storage/body，不接受caller另传target。
2. Anthropic → §5.3.1。
3. OpenAI storage true → §5.3.2。
4. OpenAI storage false → §5.3.3。
5. OpenAI storage unknown、unsupported protocol或dynamic target → typed failure。
6. callee failure原样返回；success返回void。

**进展**：有限switch；callee有限扫描；无等待。

**副作用/残留**：无。

**§4.3.2正确性论证**：original inspection的canonical final target discriminator使分支互斥且穷尽首批allowlist；所有else fail closed，因此void success恰证明same-object final body匹配inspection target，且pre-prepare candidate保持provider-neutral。

### 5.4 `validatePreparedRecoveryInspection`

```ts
export const validatePreparedRecoveryInspection: (input: {
  candidate: M7.LoweredRecoveryCandidate
  inspection: Extract<M2.M2InspectionResult, { tag: "available" }>
}) => Effect.Effect<void, M1.RecoveryFailureCause>
```

**Callers**：M2 `AuditedAISDKDescriptor.inspectFinalFetch`/native paused compilation所在的unique preparation scope；不是普通M6/M8 caller。

**Callees**：M1 exact digest/checkpoint equality；M2 inspection evidence primitives；Continue branch调用§5.3.4并由其按inspection target分派Anthropic/OpenAI allowlist。K3已发生在§5.2.1 actual message reconstruction；本函数不得再次unseal或reconstruct body。

**Requires**：inspection由当前唯一actual prepare的exact final request产生；provider hit count=0；candidate是该prepare的same `lowered` object且仍处于K3 scoped continuation；candidate snapshot proof、stable commitment与lease objects未clone/replace/close；M6仍持有产生candidate的exact M5 selection且action一致。validation success后必须返回M2 frozen planned materialization，再由M5 final classification消费，不得直接进入M4/K8/release。

**Ensures**：

- SafeRetry final request仍source-free，proof partition仍truly-empty。
- Continue final planned prefix（含reconstructible provider-prefix content）等于candidate closure；actual message order/tool result-vs-error/reasoning grammar未被M2 transform删除或重排。
- target/protocol/storage/model/lowerer evidence只来自inspection且匹配Anthropic/OpenAI exact allowlist。
- local tool IDs/order/digests exact；required signed/stored state在same final object保留；forbidden kinds不存在。
- prepared handle commitment exact等于candidate reservation；same lease set/generations/material commitments仍live并留待M4 K8，不由M7关闭。
- success不授权、不release；failure严格使M2 mechanical cancel exact prepared object → M2/M6 K9 close/zeroize same leases → K9 success后M2 cleanup exact object/registry → typed failure或其它post-cancel work。K9 failure在cleanup前fatal并保留lease relation registry。

**步骤、分支、退出**：

1. 检查inspection evidence绑定current candidate/action、same proof identity、same stable commitment与same lease object tuple；absent/mismatch/closed/stale → failure，不reacquire。
2. 从original inspection读取final target/protocol/storage/body；unknown/mismatch → failure。candidate semantic fields不得提供或覆盖target；M4 lease key target metadata不得成为branch input。
3. safe-retry：要求snapshot proof kind safe-retry、partition truly-empty、leases exact empty；扫描final frozen request/evidence，任何source identity/content binding → failure；否则进入step 7，不调用Continue provider constraint。
4. continue：比较`Extract<M1.RecoveryClosureDescriptor,{status:"available"}>["providerPrefix"]`全部components及content carrier；再比较actual final body中的tool call/result-or-error/reasoning/provider-prefix order与candidate messages/closure，任何drop/reorder/grammar conversion mismatch → failure。
5. 调§5.3.4 `buildProviderClosureConstraint({closure:candidate.closure,inspection})`；其按same inspection target精确分派Anthropic/OpenAI stored/OpenAI stateless allowlist，任何unsupported/forbidden/mismatch → failure。
6. provider-specific validator不得重建body、替换inspection、修改closure/messages、重新unseal、关闭lease或触发second prepare。
7. M2 canonicalizer在same final object上建立final `M1.SemanticDigest`/prepared evidence，并要求prepared handle commitment等于candidate reservation；M7不复制digest。
8. 返回void；M2把同一preparation handle封装进available `PlannedRecoveryMaterialization<M2.AvailableDispatchHandle>`，保持same candidate/lease tuple可供M5与M4 K8。

**循环/进展**：final item scan有限；无external wait、K3或lease lifecycle loop。

**副作用/残留**：read-only same-object inspection；failure的mechanical cancel由M2负责，lease close/zeroization由M2/M6+M4 K9负责，M2 cleanup只在K9 success后发生；K9 failure保留registry relation并fatal。无send、tool、public event或durable write。

**§4.3.2正确性论证**：candidate、inspection、commitment与leases同源于单一scoped pipeline；步骤2只接受inspection-owned final target，步骤3-6覆盖action/order/provider所有must-understand约束且禁止second unseal/prepare；步骤7由M2在same object建立digest与commitment equality，因此success可推出exact final representation满足candidate并可由K8复验，failure又经owner cancel/K9消除sendable与secret residue。

### 5.5 `lowerLegacyRecoveryRequest`

```ts
export const lowerLegacyRecoveryRequest: <A, E>(input: {
  action: M1.RecoveryClosureDescriptor["action"]
  history: readonly SessionV1.WithParts[]
  authority: M4.DurableRecoveryAuthorityViewV1
  proof: M4.AutomaticRecoveryProofSliceV1
  closure: M1.RecoveryClosureDescriptor
  preparedHandleCommitment: M1.PausedHandleCommitment
  sealedUseLeases: readonly M4.SealedRecoveryUseLeaseV1[]
  model: Provider.Model
  options?: {
    stripMedia?: boolean
    toolOutputMaxChars?: number
  }
  use: (candidate: M7.LoweredRecoveryCandidate) => Effect.Effect<A, E>
}) => Effect.Effect<A, E | M1.RecoveryFailureCause | M4.RecoverySealErrorV1>
```

**Callers**：M6/M2 private automatic orchestration，exactly once per selected candidate，且only after §5.2 descriptor → M2 stable commitment reservation → M4 K7。

**Callees**：§5.1、§5.2.1；各callee pre/post如对应章节。`use(candidate)`唯一合法值是直接调用M2 owner完整九字段`prepareDispatch({candidate,context,operationID,snapshotProof,closure,sealedUseLeases,reservation,lowered:candidate,runtimeInput})`；九字段均由M6/M2既有owner facts显式传入，不从candidate结构猜测。§5.3 provider-specific validators不在本函数pre-inspection调用图中。

**Requires**：source terminal authority已commit；M5已产生exact single automatic selection且尚未final classify；`proof === authority.toolEligibility`并是eligible branded slice；`closure`是§5.2从same proof构造的same exact descriptor；stable commitment与K7 same live leases已存在，sealed refs set exact；provider hit count=0；M2 actual prepare尚未开始；final target/protocol/storage尚未由inspection materialize。

**Ensures**：`use`最多恰调用一次并接收满足§4.1的same-object-bound target/provider-neutral candidate；SafeRetry source-free/truly-empty；Continue actual ordered messages只来自M1 replay carriers且绑定same leases/commitment；无tool execution、provider release或authority write；未运行provider-specific constraints。success/error/interrupt均无raw plaintext/lookup-proof escape，lease lifecycle仍由M2/M6/M4拥有。

**步骤、分支、退出**：

1. 验证input action等于M5 selection action；再验证authority/proof brand+same-object+identity、closure canonical equality、stable commitment与lease-set equality。missing/mismatch、plain snapshot/fold/manual-only/structural proof或foreign lease → typed failure，`use` calls=0。
2. `safe-retry` → 要求proof safe-retry-eligible/truly-empty、closure not-needed、leases exact empty；原样传§5.1。success得到candidate后立即调用`use(candidate)`一次；mapping exits或其它failure使use=0。
3. `continue-after-settled-tools` → 要求proof continue-eligible/authoritative-only/all final-after-hook-settled、closure available；调用§5.2.1。它在K3 innermost scope组装candidate并调用same `use`一次。
4. unreachable action或proof/action cross-branch → exhaustive typed failure；不得默认为SafeRetry、不得drop compatibility fact或reasoning。
5. `use`返回A则原样返回；typed E、M1 planning failure、M4 seal failure、defect或interrupt按Effect channel退出。M7不自行retry、reacquire、close lease、cancel handle或classify。
6. caller在pre-actual-prepare failure按owner no-handle branch执行reservation abandon → M4 K9 close/zeroize → K9 success后cleanup reservation registry；若actual prepared handle已存在，严格执行M2 mechanical cancel → M4 K9 close/zeroize → K9 success后cleanup exact handle/reservation registry → typed failure或其它post-cancel work。K9 failure在cleanup前fatal并保留relation registry；禁止replacement prepare/lease。

**进展**：finite switch；SafeRetry有限history scan，Continue有限proof/carrier scan；K3与M2 callback是existing lifecycle-bounded conditional completion，无M7 retry/timeout loop。

**副作用/残留**：M7 authority/history read、memory/canonicalization；Continue可有M4 K3 read/crypto和M2 callback唯一prepare。无M7-owned DB/event/tool/network/lease mutation。all failure/cancel raw material=0 escape；owner mechanical-cancel→K9→cleanup obligations显式。

**§4.3.2正确性论证**：same M4 branded proof与§5.2 descriptor先固定eligible action和complete replay source，reservation/K7再固定generation/material/handle use；互斥branch分别继承SafeRetry source exclusion或R22 canonical reconstruction，scoped `use`保证plaintext-bearing candidate只进入M2一次；provider constraints仍晚于inspection，owner mechanical-cancel→K9→cleanup覆盖全部prepared failure exits，K9 failure又在cleanup前fatal，因此没有plain snapshot、digest inversion、double prepare、secret escape或M7 lease ownership。

## 6. M6 ownership、budget语义与 partial-correctness theorem

### 6.1 Coordinator sequence

1. M3 append terminal；M4 reload并返回`M4.DurableRecoveryAuthorityViewV1`。decode/fold/materialization/owner/brand validation必须先成功；corrupt、partial、owner-mismatched、non-foldable、unresolved或ambiguous authority立即fatal-stop，不进入M5/M7或ManualStop。M6/M7不得把`authority.snapshot`拆出后冒充automatic input。
2. M6只消费transaction-verified committed `NormalizedRecoveryPolicy.digestInput`：N只计incomplete child admissions；M只取其committed `effectiveMaxModelAssistants`并计全部model assistants。M6/runtime不得重读configured policy或`agent.steps`、不得重算或re-min；normalization已由M1 `normalizeRecoveryPolicy`在该committed digest input形成前完成。
3. M5从validated complete authority view选择至多一个automatic candidate；manual selection不调用M7。automatic selection必须拿到`proof === authority.toolEligibility`的`M4.AutomaticRecoveryProofSliceV1` eligible branch：SafeRetry仅truly-empty；Continue仅authoritative-only且all final-after-hook-settled。manual-only/compatibility-only/mixed/plain snapshot/fold/structural proof均不能调用M7。
4. M7 §5.2先构造并复验target/provider-neutral `M1.RecoveryClosureDescriptor`，无replay plaintext。M2随后只创建stable no-send `M1.PausedHandleCommitment` reservation；M6按M1 exact `SealedRecoveryUseLeaseKeyInputV1`为每个sealed ref构造key，M4 K7取得same live lease set。K7前unseal/lowering/actual prepare calls=0。
5. M7 `lowerLegacyRecoveryRequest`只在same live K3 scopes内重建actual ordered messages并把candidate作为`lowered`连同`candidate/context/operationID/snapshotProof/closure/sealedUseLeases/reservation/runtimeInput`显式交M2 owner完整九字段`prepareDispatch`一次；M2 actual prepare产生original available inspection，调用§5.4→§5.3。M2统一返回`M1.PlannedRecoveryMaterialization<M2.AvailableDispatchHandle>`；available含same handle/commitment，unavailable无live handle。post-allocation failure/cancel严格为mechanical cancel → K9 close/zeroize → cleanup；pre-allocation no-handle branch为abandon → K9 → cleanup。K9 failure在cleanup前fatal并保留registry relation；无raw escape/reacquire/second prepare。
6. original inspection/validation完成后，M5仍须调用`classifyRecovery`；只有它可对完整typed facts与validated planned materialization返回final`M1.RecoveryProposal`。M7/M2不得把inspection success直接视为automatic proposal。
7. ManualStop：fresh M5/F23 proposal + fresh source binding → mechanical cancel（若有prepared handle）→ K9 close/zeroize same leases → cleanup exact handle/reservation registry → `M4.commitManualStop` → complete`OperationCommitResultV1<"decision-finalized">`或A5 exact replay恢复同一result → 返回source；detached receipt不授权。failed automatic attempt还须A5 absent + S2 unchanged/no winner + fresh same source binding + pre-existing M5/F23 eligible cause四项。K9 failure在cleanup/commit前fatal；result unresolved/corrupt→fatal-stop。
8. automatic：M4 type-9 writer tx先K8 commit validation，使用`M1.OperationSchemaByTypeV1["automatic-child-admitted-and-consumed"]` exact payload/package、same snapshot identity与same lease objects；transaction返回complete result后，下一步立即执行M4 pre-release K8 validation，此时same handle仍prepared。K8以same result/handle commitment/leases返回nominal proof后，M2才调用M1 F27并完成exact handle/reservation authorization，再在proof scope内release原handle exactly once，M4 K9以released close/zeroize；detached receipt/proof不授权。
9. automatic commit failure/unknown：mechanical cancel（此时禁止cleanup），随后K9 close/zeroize leases → cleanup exact handle/reservation registry → A5 exact tuple lookup → 必要时S2 current-winner lookup。complete result直接follow winner且不authorize cancelled handle；A5 missing再查S2。只有operation absent + S2 no winner/unchanged + fresh complete authority view source binding unchanged + pre-existing M5/F23 eligible cause才可步骤7；任一fatal authority在cleanup后fatal-stop。K9 failure在cleanup/A5/S2前fatal并保留registry relation。
10. K8 commit failure或complete result后的pre-release K8 failure、authorization failure、其它automatic pre-release failure：禁止replacement prepare/lease、transparent resend、ManualStop commit或source-success，并统一执行prepared mechanical cancel → K9 close/zeroize → cleanup → A5/S2/replan/fatal as applicable。pre-release K8 failure时F27、M2 authorization calls=0；authorization failure仍在release前走同一顺序。release send-state unknown只按owner事实关闭local material且不声称撤销send，进入fatal-stop/ambiguity；K9 failure仍在registry cleanup前fatal。
11. M6最终返回`M6.CoordinatorResult`；M8不参与authority、lease或provider顺序。

### 6.2 N/M exact statements

- `N=0`：不允许任何incomplete-triggered child admission。
- `N=1`：只允许recovery ordinal 1 child。
- `N=2`（default）：允许ordinals 1与2。
- N admission rule：`candidateRecoveryOrdinal <= N`。
- M6 admission只读取transaction-verified committed `NormalizedRecoveryPolicy.digestInput.effectiveMaxModelAssistants`；runtime config与`agent.steps`在M6、first application、exact replay中均不可读，且不得re-min。
- 令该committed值为`effectiveM`；M计committed model assistants sequence `0 .. effectiveM-1`，candidate admission要求`candidateAssistantSequence < effectiveM`。
- outer provider retry/new semantic dispatch可以增加dispatch/provider hit而不消费N；成功commit新的model assistant才消费M；只有incomplete child admission消费N。
- shell不消费N/M；ordinary model assistant消费M但不消费N。

### 6.3 Synchronous final-result theorem（partial correctness only）

**Theorem**：若 `SessionRunState.submitSerialized(input)` 返回 `M6.CoordinatorResult`，且M8 mapper成功，则：

- `model-final` → response是`effectiveAssistant`；automatic chain时为最终child，committed ManualStop时为source。
- `user-only` → 仅对no-reply contract返回user message。
- `shell-final` → 仅shell入口返回assistant；prompt/command收到该branch为typed invariant error。
- `fatal-stop` → sanitized public operation failure；不返回source伪装成功。

**不声称**：N/M、finite admission graph或本mapper能证明provider、tool、network、sealed store或external completion最终返回。同步handler可在现有Runner/operation lifecycle下条件等待；user cancellation/source shutdown可终止wait。该等待与CLI attach hydration lifecycle彼此独立。

## 7. M8 callable specifications

[F — planned; not created; not run] 本节signature/flow均为future obligation；每个`[S — source seam only]`段只说明current seam，不把future行为标成source事实。

### 7.1 `toLegacyCoordinatorResponse`

```ts
export const toLegacyCoordinatorResponse: (input: {
  operation: "prompt" | "command" | "no-reply" | "shell"
  result: M6.CoordinatorResult
}) => Effect.Effect<SessionV1.WithParts, SessionV1.Assistant["error"]>
```

[S — source seam only] 当前不存在该mapper；prompt/command response construction不同。

**Callers**：shared sync handler、background sanitizer completion adapter。

**Callees**：M8 stable fatal sanitizer；§3.2 exact incomplete mapper（仅对应terminal kind时）。

**Requires**：result由M6 final return产生。

**Ensures**：遵守§6.3；不读projection决定server final；public error无raw cause。

**步骤、分支、退出**：

1. `model-final` + prompt/command → return `effectiveAssistant`。
2. `user-only` + no-reply → return `userMessage`；其它operation → typed invariant error。
3. `shell-final` + shell → return `assistant`；其它operation → typed invariant error。
4. `fatal-stop` → sanitize `failure`为existing stable `SessionV1.Assistant["error"]`并fail。
5. unknown discriminant → exhaustive defect，不serialize raw object。

**进展**：有限switch，无等待。

**副作用/残留**：无。

**§4.3.2正确性论证**：branch与M6 union一一对应，只有owner-provided final value进入success，fatal只进sanitizer，故partial theorem成立且projection不能成为server authority。

### 7.2 Projection decode与adapter omission

#### 7.2.1 `decodeLegacyRecoveryProjection`

```ts
export const decodeLegacyRecoveryProjection: (
  raw: unknown,
) => M1.ContractResult<M1.RecoveryPublicProjectionDecodeResult, never>
```

[S — source seam only] 当前schema/hydration中没有该function。

**Callers**：message hydration、CLI/TUI public reconciliation。

**Callees**：M1 F30 `decodeRecoveryPublicProjection`，exact return为`M1.ContractResult<M1.RecoveryPublicProjectionDecodeResult, never>`。

**Requires**：raw来自optional public `Assistant.recovery` wire field或任意untrusted hydration value。

**Ensures**：原样保留F30 outer `ContractResult`与inner exact三分支，不发生authority lookup、field extension或Effect-error替换。

**步骤、分支、退出**：

1. 直接调用M1 F30并返回同一`ContractResult`；不得在本层unwrap后另造raw union。
2. `ok:true,value.kind==="known"` → value exact，不添加字段。
3. `ok:true,value.kind==="unsupported"` → 保留该result给adapter；本函数不先抹成undefined。
4. `ok:true,value.kind==="malformed"` → 保留typed violation；不得猜测/normalize为absent。
5. F30 error type为`never`；runtime malformed wrapper进入internal invariant diagnostic，不回显raw值，也不把它伪装成known/unsupported。

**进展/副作用/残留**：无循环、无等待、无side effect/residue。

**§4.3.2正确性论证**：函数不重解释wire shape并原样返回M1 owner result，完整保留outer `ContractResult`与inner三分支，因此unsupported与malformed不可混淆，也不存在第二套decoder contract。

#### 7.2.2 `adaptDecodedLegacyRecoveryProjection`

```ts
export const adaptDecodedLegacyRecoveryProjection: (
  decoded: M1.RecoveryPublicProjectionDecodeResult,
) => Effect.Effect<M1.RecoveryPublicProjectionV1 | undefined, M1.PublicProjectionViolation>
```

**Callers**：public message hydrator。

**Callees**：无；只消费M1 decoded union。

**Requires**：decoded是§7.2.1/M1 F30返回的`ok:true` result中的exact `value`；caller不得自行重建inner union。

**Ensures**：known唯一成功值；unsupported唯一omission；malformed唯一typed error。

**步骤、分支、退出**：`known`→value；`unsupported`→undefined/omit；`malformed`→typed failure；无其它exit。

**进展/副作用/残留**：finite switch；无等待或residue。

**§4.3.2正确性论证**：恰实现“unsupported omit、malformed typed hydration error”，没有第四个fallback。

`known` value中若 `outcome === "manual-stop"`，adapter把它解释为 authority owner 已提交事实到最终显示状态的确定性投影，且只允许设置已识别source row的display-final/manual-stop presentation。它不能授权任何internal action，也不能替代receipt、fold、snapshot或actual child relation。projection absent/unsupported时不具有该显示事实；malformed时返回typed hydration error。两种情况下若actual transcript也无child，consumer仍不得推断ManualStop。fatal或indeterminate reconciliation必须沿`LegacyHydrationError`、existing stable public error/status或loading/unresolved状态返回non-success；不得新增public authority event或projection outcome。

### 7.3 Shared synchronous handler

```ts
export const serveLegacySyncOperation: (input: {
  operation: "prompt" | "command"
  submission: M6.SerializedSubmission
}) => Effect.Effect<SessionV1.WithParts, SessionV1.Assistant["error"]>
```

[S — source seam only] current `prompt`手工stream JSON而`command`走typed encoder；shared helper尚不存在。

**Callers**：`SessionHttpApi.prompt`、`SessionHttpApi.command` planned wrappers。

**Callees**：`SessionRunState.submitSerialized`、§7.1、shared `SessionV1.WithParts` HTTP API encoder。

**Requires**：decoded request/session合法；submission与operation匹配。若该serialized model branch将建立type-1 lineage，已提交user predecessor必须直接是`M1.LegacyUserMessagePredecessorV1`，后续M4 input/payload只通过`M1.OperationSchemaByTypeV1["initial-chain-genesis-and-dispatch"]`索引；M8不得重声明Legacy predecessor或operation structural alias。

**Ensures**：若M6返回且mapper/encoder成功，body为final effective value；prompt/command encoding parity；fatal sanitized。

**步骤、分支、退出**：

1. 验证operation/submission；mismatch → existing typed request error。
2. 调M6 submit；它可能在existing operation lifecycle下条件等待。
3. M6返回 → 调§7.1；mapping failure返回stable error。
4. shared schema encode；encode failure为typed HTTP/schema error，不fallback raw JSON/cause。
5. 写response；write success返回；disconnect/write failure不改变M6 durable state。

**进展**：本函数无loop；步骤2/5是external conditional wait。N/M不提供liveness proof；现有cancellation/source close拥有终止。

**副作用/残留**：M8只有HTTP wait/encode/write；M6可能产生其owned durable/provider side effects。disconnect后M8不cancel handle、不commitManualStop。

**§4.3.2正确性论证**：在M6返回的条件下，§7.1选owner final value，single encoder保证parity；其它branch均typed error，所以得到partial correctness而非unconditional termination。

### 7.4 `promptAsync`

```ts
export const promptAsync: (input: {
  prompt: SessionPrompt.PromptInput
  submission: M6.SerializedSubmission
}) => Effect.Effect<
  HttpApiSchema.NoContent,
  HttpApiError.BadRequest | ApiNotFoundError
>
```

[S — source seam only] current handler名为`promptAsync`并返回`NoContent.make()`，但background failure用`Cause.pretty`公开发布。

**Callers**：`SessionApi` endpoint `promptAsync`；root/v2 generated clients共享同一route family。

**Callees**：M6 scope-owned submit/fork、M8 sanitized public failure mapper、ordinary public signal publisher。

**Requires**：request decode完成；scope接受ownership transfer。

**Ensures**：ownership transfer成功后runtime status 204且body bytes=0；transfer失败返回existing typed error；background result不写HTTP body；failure publication sanitized。

**步骤、分支、退出**：

1. 验证prompt/submission；decode failure → existing error，无fork。
2. 把M6 operation转移到existing handler/session scope；fork/transfer failure → error，无204。
3. transfer success后立即构造`HttpApiSchema.NoContent.make()`；不调用JSON/body encoder。
4. background success只通过ordinary transcript/status/projection可见。
5. background fatal调用M8 sanitizer再publish existing stable public error；sanitizer/encode failure记录internal diagnostic并停止public publish，绝不调用`Cause.pretty`。
6. HTTP disconnect只影响response delivery；已转移operation继续受scope/cancel lifecycle拥有。

**进展**：handler本身无loop；ownership transfer是finite local step。background M6 completion是conditional，不由204/N/M保证。

**副作用/残留**：success residue为scope-owned operation；HTTP body residue=0 bytes。failure-before-transfer无operation residue。background durable/provider residue归M6。

**§4.3.2正确性论证**：204 branch只在transfer success后调用NoContent constructor且无body writer；failure publication唯一经过sanitizer，因此exact 204与no raw cause同时成立。

**Generated contract**：root/v2 response map的204 payload保持`void`；不要求把现有generated method envelope改成raw `Promise<void>`。

### 7.4.1 `submitLegacyNoReply`

```ts
export const submitLegacyNoReply: (input: {
  prompt: SessionPrompt.PromptInput & { noReply: true }
  submission: Extract<M6.SerializedSubmission, { kind: "no-reply" }>
}) => Effect.Effect<SessionV1.WithParts, SessionV1.Assistant["error"]>
```

**Callers**：public unprefixed prompt wrapper在decoded `noReply===true` branch。

**Callees**：`SessionRunState.submitSerialized`、`toLegacyCoordinatorResponse({operation:"no-reply",...})`、ordinary user-message encoder。

**Requires**：prompt/submission same session与same canonical payload digest；submission branch exact no-reply且无future model operationID/reservation；M8不得直接commit user row或调用M7/M2。

**Continuous steps/branches**：1) validate exact branch；2) submit到same per-session queue；3) M6先resolve type-10 no-reply supersession或exact no-unresolved-source branch；4) only then commit user message；5) require `CoordinatorResult.kind="user-only"`并返回该user row；6) model-final/shell-final为typed invariant error；7) fatal-stop经exact sanitizer失败返回。

**Ensures**：返回前old recovery resolution happens-before user commit；policy freeze、candidate allocation、M5/M7/M2、type-1、assistant/ledger/M、authorization/release调用次数均为0；success仅返回committed user message。

**Side effects/progress**：M8仅queue submit/wait/encode；M6拥有type-10/user commit。wait为existing lifecycle conditional wait，不新增timeout。

**§4.3.2正确性论证**：closed no-reply submission和M6 `user-only` result构成双向branch proof；zero-call list在M6 type union与wrapper call graph中不可达，因此noReply不能意外进入model recovery。

### 7.4.2 `submitLegacyShell`

```ts
export const submitLegacyShell: (input: {
  shell: SessionPrompt.ShellInput
  submission: Extract<M6.SerializedSubmission, { kind: "shell" }>
}) => Effect.Effect<SessionV1.WithParts, Session.BusyError | SessionV1.Assistant["error"]>
```

**Callers**：public unprefixed `session.shell` wrapper only。

**Callees**：`SessionRunState.submitSerialized`、existing shell owner、`toLegacyCoordinatorResponse({operation:"shell",...})`。

**Requires**：shell/submission same session与same canonical digest；branch exact shell；M8不得旁路serialized queue。

**Continuous steps/branches**：1) validate exact branch；2) submit same queue；3) M6 shell branch直接调用existing shell owner exactly once；4) require `CoordinatorResult.kind="shell-final"`并返回assistant；5) model-final/user-only为typed invariant error；6) fatal-stop经exact sanitizer失败返回。

**Ensures**：shell process side effect exactly once；supersession recovery、policy freeze、M5/M7/M2、N/M、model assistant admission、provider release与recovery projection调用次数均为0；synthetic assistant不获model/recovery authority。

**Side effects/progress**：existing shell process与serialized queue；不新增provider/network recovery wait。

**§4.3.2正确性论证**：queue branch唯一callee是existing shell owner且result discriminator只能shell-final/fatal；显式zero-call set排除recovery/model admission，因此serialization与N/A边界同时成立。

### 7.5 HTTP disconnect resolver

```ts
export const reconcileLegacyDisconnect: (input: {
  sessionID: string
  operation: "prompt" | "command"
  userMessageID?: SessionV1.MessageID
  sourceAssistantID?: SessionV1.MessageID
  signal: AbortSignal
}) => Effect.Effect<SessionV1.WithParts, M8.LegacyHydrationError>
```

`M8.LegacyHydrationError` 是M8 private typed UI/transport error，只允许sanitized tags（malformed projection、missing status、relation inconsistency、transport cancelled/closed），不得携带authority或raw cause。

[S — source seam only] 当前没有该resolver或public stable operation idempotency contract。

**Callers**：CLI noninteractive response-loss branch；attach使用独立§7.8 hydrator，不复用server liveness假设。

**Callees**：public transcript/status reads、§7.2、ordinary relation selector。

**Requires**：HTTP result indeterminate；caller提供现有AbortSignal与其已知local operation/user/source anchors。

**Ensures**：只返回actual public relation证明的final，或known ManualStop outcome对anchored source给出的final display result；所有absence/ambiguity/cancel branch为typed non-success；不发送新prompt/command，也不产生authority。

**步骤、分支、退出**：

1. anchor session/operation/user/source identity；缺少可区分identity时保持non-success，不猜请求未接受。
2. 读取public transcript与status；transport failure若signal仍live则等待existing source wake/retry lifecycle，若cancel/close则typed error。
3. projection known通常只作display hint；唯一特殊显示规则是anchored source的known `outcome:"manual-stop"` 可确定该source的final display state。unsupported omit；malformed立即typed hydration error；两者都不得推断ManualStop。
4. 从actual public parent-chain/assistant rows找current operation final：唯一terminal child→return child；anchored source有known `outcome:"manual-stop"`且无child→return source作为public final display result；ordinary terminal→return该assistant。该返回不授予任何internal authority。
5. missing status、missing relation、multiple candidates、cycle、only displayID，或无child且projection absent/unsupported → non-success；malformed已按步骤3 typed fail；不得猜测source ManualStop成功。
6. fatal/indeterminate reconciliation通过existing stable public error/status或`LegacyHydrationError`返回non-success/typed unresolved；signal aborted/source closed且仍indeterminate同样typed non-success。
7. 任一indeterminate branch禁止transparent resend；absence不证明non-acceptance，也不产生新public authority event。

**进展**：单次reconcile扫描有限transcript；外部等待是conditional并受existing signal/source lifecycle约束，无new timeout或retry count。

**副作用/残留**：public reads与local wait state only；无server retry、authority write、ManualStop或provider hit。

**§4.3.2正确性论证**：identity anchor排除其它turn，actual relations而非displayID确定child/ordinary final；ManualStop source final只来自M1 known outcome的display projection。absent/unsupported不推断、malformed失败，所有其它absence/ambiguity branch保持non-success，所以不会伪造completion、authority或重复提交。

### 7.6 `publishLegacyPublicState`

```ts
export const publishLegacyPublicState: (input: {
  result: M6.CoordinatorResult
  publicEvents: M1.PublicEventServiceV1
}) => Effect.Effect<void, SessionV1.Assistant["error"]>
```

[S — source seam only] current EventV2 source unpartitioned，且不存在该callable。

**Callers**：M6/M8 public adapter boundary after durable/public projection commit。

**Callees**：`M1.PublicEventServiceV1.publish`、ordinary message/status public definitions、M8 sanitizer；M4 raw/private writer不在调用图中。

**Requires**：`publicEvents`只能接受F2/F31 owner-produced `M1.PublicEventDefinitionV1`/`M1.PublicDurableEventManifestV1` carriers；input不暴露raw transition；trusted private durable replay manifest未注入该service。

**Ensures**：listen/all、typed public durable record、bridge、sync、instance/global SSE、SDK、CLI与TUI subscriber只从`M1.PublicEventSubscriptionV1<D>`收到exact nominal`M1.PublicCommittedEventV1<D>`，均收不到internal recovery payload；projection仍只随ordinary public message传播；public read error/cursor不含authority。

**步骤、分支、退出**：

1. ordinary message/status definitions必须先由M1 public brand constructor证明`publication:"public"`；internal definition/payload在`M1.PublicEventServiceV1` type boundary不可构造。
2. `publicEvents.publish<D>`只返回`M1.PublicCommittedEventV1<D>`；raw transition仍只进入M4 trusted private replay/store，private manifest不能传入public service。
3. ordinary result branch发布message/status；fatal branch先sanitize，sanitizer output再进入既有public assistant error shape。
4. bridge/sync/SSE/SDK/CLI/TUI从exact`M1.PublicEventSubscriptionV1<D>`逐项消费；每个callback/reducer参数必须逐字为`M1.PublicCommittedEventV1<D>`，不得扩大为a broad EventV2 union、generic object、unknown payload或unbranded structural union。public cursor只能从已提交public durable event产生。
5. M1 subscription decoder/manifest assembly负责在brand构造前拒绝非public/malformed value并返回`M1.PublicEventReadErrorV1`。M8与其它subscriber禁止检查`event.type`字符串prefix、禁止`session.recovery.*` drop filter、禁止cast补brand；它们对已经nominally public的未知ordinary definition只能按closed public-definition handling忽略/呈现。
6. encode/publish/read failure只返回M1 coarse public error经existing stable mapper转换后的public signal error或internal diagnostic；不发布raw transition/cause。

**进展**：每result产生有限signals；individual publisher/backpressure completion受existing bus/cancellation lifecycle约束，无unconditional termination claim。

**副作用/残留**：ordinary public signal与internal diagnostic；无provider/tool/authority transaction。

**§4.3.2正确性论证**：M1 public brand constructor只接受literal public definition，`PublicEventServiceV1`与`PublicEventSubscriptionV1<D>`的输入/输出又对该brand封闭，trusted private manifest nominally不能赋值；故internal value在public source前已不可表示，后续pipeline逐项只传`PublicCommittedEventV1<D>`。subscriber没有broad input或prefix-filter branch，因此zero leakage完全由source/type closure证明。

### 7.7 CLI reducer

```ts
export const reduceLegacyRunEvent: <
  D extends M1.PublicEventDefinitionV1,
>(input: {
  state: M8.LegacyRunCompletionState
  event: M1.PublicCommittedEventV1<D>
  sessionID: string
}) => M8.LegacyRunEventReduction
```

M8 private state精确区分：presentation errors、transient transport、hydrator wakeup revision、sync final`SessionV1.WithParts`、hydrated final`SessionV1.WithParts`、terminal hydration failure、current user/source IDs。它不存authority、receipt或displayID→MessageID map。

[S — source seam only] current `RunCommand.loop/finish`只有累积error string，任何SSE error可令exit 1。

**Callers**：RunCommand只可drain exact`M1.PublicEventSubscriptionV1<D>`并把每个item原样传入；CLI attach/TUI/SDK若复用该reducer也必须保留同一`D`，不得先扩大类型。

**Callees**：existing formatter only；无prefix filter、EventV2 bridge cast或hydrator finalizer。

**Requires**：state满足§3.3 invariant；event逐字是当前subscription产出的nominal`M1.PublicCommittedEventV1<D>`，不是a broad EventV2 union或structural lookalike。

**Ensures**：返回`{state,wakeHydrator}`；只更新presentation与`hydratorWakeupRevision`，不更新transport、sync/hydrated final、`terminalHydrationFailure`或exit code。`wakeHydrator`与revision increment exact对应。

**步骤、分支、退出**：

1. 用D对应的public payload contract读取session identity；other-session event→`{state,wakeHydrator:false}`，state逐字段unchanged。
2. exact public `session.error`或message error definition→append presentation error；若该event可能改变current relation观察，则revision`+1`并`wakeHydrator:true`，否则false；不得设置final/exit。
3. exact public message/part/status definition→merge presentation state，revision严格`+1`并返回`wakeHydrator:true`；不得仅凭idle/status event完成。
4. 其它nominal public definition→state unchanged且`wakeHydrator:false`；禁止读取type prefix来决定是否drop recovery value，因为internal value在subscription item type中不可表示。
5. M1 subscription read error不是event item；caller沿`M1.PublicEventReadErrorV1` error channel交§7.7.1 transport reducer或hydrator，不得伪造committed event。

**进展**：单event finite switch，无等待。

**副作用/残留**：纯`{state,wakeHydrator}` return；render/wakeup由caller按boolean负责。

**§4.3.2正确性论证**：nominal subscription item先排除internal/broad event；closed public-definition switch只写presentation/revision，final与terminal failure只能由sync/hydrator写，因此source error presentation不能污染最终child exit，且zero leakage不依赖prefix。

#### 7.7.1 CLI transient transport reducer

```ts
export const reduceLegacyRunTransport: (input: {
  state: M8.LegacyRunCompletionState
  transition:
    | Readonly<{
        tag: "connected"
        connectionGeneration?: M8.LegacyConnectionGeneration
      }>
    | Readonly<{ tag: "interrupted" | "closed" }>
}) => M8.LegacyRunEventReduction
```

**Callers/Callees**：CLI transport lifecycle callback / 无。

**Requires**：transition由transport owner产生，不是public event；generation若存在必须是current successful connection generation。

**步骤/分支**：`connected`写`transientTransport.tag="live"`；`interrupted|closed`写对应transient state；每个实际transition使`hydratorWakeupRevision +1`并返回`wakeHydrator:true`；duplicate state返回unchanged/false。任何branch都不写`terminalHydrationFailure`。

**Ensures**：transport signal只唤醒hydrator；hydrator随后依据actual transcript/status与lifecycle决定继续等待或写terminal failure。已有sync/hydrated final不被覆盖。

**进展/副作用/正确性**：finite pure switch；transport与terminal hydration state字段分离，所以可恢复断线不能直接变成final operation failure。

### 7.8 CLI/attach hydrator

```ts
export const hydrateLegacyRunCompletion: (input: {
  sessionID: string
  operation: "prompt" | "command" | "attach"
  userMessageID?: SessionV1.MessageID
  sourceAssistantID?: SessionV1.MessageID
  signal: AbortSignal
}) => Effect.Effect<SessionV1.WithParts, M8.LegacyHydrationError>
```

[S — source seam only] current attach `finish()`直接return，无hydration fallback。

**Callers**：response-loss/disconnect/attach only；normal sync success不调用。

**Callees**：public transcript/status reads、§7.2 adapter、ordinary relation selector。

**Requires**：caller提供session与已有local public anchors；signal属于当前CLI lifecycle。

**Ensures**：只返回actual current relation terminal，或known ManualStop outcome对anchored source给出的final display result；missing/malformed/ambiguous/cancel不返回final；provider/tool/durable authority side effects为0。

**步骤、分支、退出**：与§7.5共享public relation rules，但attach identity来自selected/current public user/source row；projection displayID永不lookup。known字段通常只作hint，唯有anchored source的known `outcome:"manual-stop"`确定其final display state；它不授予authority。projection absent/unsupported且无child不得推断ManualStop；malformed typed error；missing status/relations及fatal/indeterminate reconciliation保持non-success/typed unresolved；cancel/close后typed failure。

**进展**：每轮有限transcript scan；重复read/wakeup沿existing event/transport lifecycle条件等待，M8不自行设置结束时刻或重试上限。

**副作用/残留**：HTTP public reads、local state；provider hits/tool effects/durable writes=0。

**§4.3.2正确性论证**：sync primary路径与attach fallback分离；hydrator只接受actual current relation terminal或known ManualStop final display projection，所以attach不会因old source error、idle、absent/malformed projection或display ID伪造success。

### 7.8.1 CLI output framing

CLI在一次invocation开始时必须冻结一种output mode，运行中不得在framed与unframed之间切换：

1. **Human transcript/progress mode**：可把source attempt、每个child attempt及其错误/进度分别渲染；最终摘要明确标识final effective assistant。human renderer可使用文字分隔，不定义machine parse contract。
2. **Machine-readable attempt-framed mode**：每条attempt record都必须完整自分帧，至少具有以下exact discriminator/identity：

   ```ts
   { type: "attempt"; assistantID: SessionV1.MessageID; sourceAssistantID: SessionV1.MessageID; attempt: "source" | "child"; payload: unknown }
   ```

   source record中`assistantID === sourceAssistantID`；child record携带自己的`assistantID`和同一chain的`sourceAssistantID`。stream结束时必须再输出且只输出一条：

   ```ts
   { type: "final-effective-result"; assistantID: SessionV1.MessageID; sourceAssistantID: SessionV1.MessageID; result: SessionV1.WithParts }
   ```

   该record的`assistantID/result`必须对应M6 sync final或§7.8 hydrated final effective assistant。
3. **Machine-readable synchronous final-result mode**：等待sync/hydration final后输出恰一条`final-effective-result` record；不得输出attempt payload、progress bytes或第二条final record。
4. JSON/机器输出不得把failed source的unframed text/JSON bytes与successful child payload串接为一个值，也不得用presentation error替换final record。若无法形成合法frame或final，输出typed machine error并以non-success结束。
5. `resolveRunExitCode`仍只依据final effective assistant或typed failure；选择human/framed/final-result mode不改变exit semantics。

**§4.3.2正确性论证**：attempt-framed mode的每个payload都有discriminator与source/assistant identity，final另有唯一record；synchronous mode禁止任何pre-final bytes，因此两种机器模式都不能产生failed-source与successful-child的unframed拼接，且最终值与exit都绑定同一effective assistant。

### 7.9 CLI exit resolver

```ts
export function resolveRunExitCode(
  state: M8.LegacyRunCompletionState,
): 0 | 1
```

[S — source seam only] current `finish()`按accumulated SSE error设置exit。

**Callers**：RunCommand finalization after sync/hydration path settles。

**Callees**：无；pure state inspection。

**Requires**：state满足§3.3 invariant；任何hydrator仍在等待时caller不得提前调用。

**Ensures**：只由sync/hydrated final或typed failure决定0/1；presentation errors不决定exit。

**步骤、分支、退出**：

1. sync final存在 → 只看该assistant existing final error；error→1，否则0。
2. 无sync final且hydrated final存在 → 同上。
3. `terminalHydrationFailure`存在 →1；`transientTransport` interruption/close本身不进入该branch。
4. 无final且hydrator已按lifecycle settled →1；hydrator仍可被`hydratorWakeupRevision`唤醒时caller不得调用。
5. presentation errors不参与上述decision。

**进展/副作用/残留**：finite switch；pure，无等待或residue。caller唯一side effect是设置`process.exitCode`。

**§4.3.2正确性论证**：优先级把M6 sync final置于presentation前，fallback只用hydrated actual final，因此successful child exit 0即使source error曾显示。

### 7.10 Interactive `complete`

```ts
const complete: (
  next: M8.LegacyInteractiveWait,
  fallback: boolean,
) => Effect.Effect<void, M8.LegacyHydrationError>
```

`LegacyInteractiveWait`是M8 private local wait state，并精确包含current `tick/armed/live/done`以及：session ID、local one-shot operation token、current user `SessionV1.MessageID`、optional source `SessionV1.MessageID`、现有abort/source lifecycle。它不含M4 `RecoveryOperationID`，不建立public authority，也不新增deadline。

[S — source seam only] current source存在同名local `complete(next: Wait, fallback:boolean)`，但只检查generic idle；current `Wait`没有identity fields，missing status可被视为idle。

**Callers**：existing poll loop与§7.7 exact `M1.PublicCommittedEventV1<D>` reducer返回的`wakeHydrator:true` signal，均针对exact `next` object；raw/broad event callback不可直接调用。

**Callees**：status/messages public hydration、§7.2 adapter、actual relation selector、Deferred completion。

**Requires**：next满足§3.3 wait invariant且来自current transport lifecycle；fallback只是status-read failure policy hint，不改变identity。

**Ensures**：Deferred success iff actual anchored operation terminal，或anchored source具有known ManualStop final display outcome；每个wait最多resolve一次；missing status/idle/displayID/absent或unsupported projection不产生success。

**步骤、分支、退出**：

1. `state.wait !== next`、token/session/user/source mismatch、`!armed`或`!live` → no-op success，不触碰其它wait。
2. lifecycle aborted/footer closed/transport closed → clear exact wait并fail typed non-success。
3. status missing、request failure或fallback tick → 不视为idle success；保持wait或在source close后fail。
4. hydrate exact operation public transcript/status。
5. projection known通常只显示hint；anchored source的known `outcome:"manual-stop"`可确定final display state但不授予authority。unsupported/absent且无child→保持wait；malformed→clear exact wait并typed fail，绝不推断ManualStop。
6. actual current relation pending/working或不完整 → 保持wait。
7. unique terminal child/ordinary assistant，或无child且anchored source有known ManualStop outcome → clear wait、tick exactly once、resolve deferred exactly once。
8. multiple/cycle/inconsistent/fatal-indeterminate relation → typed fail或typed unresolved；不得placeholder、source-success猜测或新public authority event。

**进展**：单次call有限；existing poll cadence可重复调用。外部完成是conditional：provider/status永不terminal时wait持续到existing user/source cancellation；不声称unconditional termination。

**副作用/残留**：public reads、local wait/tick、Deferred；无authority/durable/provider/tool side effect。

**§4.3.2正确性论证**：object/token/identity guard排除stale turn，hydration gate位于Deferred success前，missing status不再等于idle；child/ordinary success来自actual terminal，ManualStop source success只来自known final display outcome，absent/unsupported/malformed均不能伪造该outcome；one-shot clear保证最多resolve一次。

### 7.11 TUI reconnect hydration

```ts
export const hydrateLegacyTuiReconnect: (input: {
  connectionGeneration: M8.LegacyConnectionGeneration
  previousConnectionGeneration?: M8.LegacyConnectionGeneration
  activeSessionIDs: readonly string[]
  currentSessionID?: string
  cachedSessionIDs: readonly string[]
  signal: AbortSignal
}) => Effect.Effect<void, M8.LegacyHydrationError>
```

[S — source seam only] current `startSSE`重连不会给connection分配generation、不会使全部旧generation的`fullSyncedSessions` guards失效，也不会强制联合fetch transcript/status。

**Callers**：每次successful initial SSE connect或reconnect callback；session selection path复用同一per-session transcript+status hydration primitive。

**Callees**：existing transcript sync、session status read、revision-aware store merge、existing `syncingSessions` coalescing。

**Requires**：SSE connection已成功后，connection lifecycle才把next strictly increasing non-negative safe integer构造为`M8.LegacyConnectionGeneration`；它大于`previousConnectionGeneration`（若存在）。IDs来自current TUI cache/selection state；signal属于该exact generation的component lifecycle。

**Ensures**：所有prior-generation cached hydration guards先失效；active/current sessions在新generation内eager完成transcript+status hydration才标记guard；其它cached sessions保持invalid，直到被选择时lazy完成transcript+status hydration；任一missing/failure/cancel为typed non-success/loading，不default idle。

**步骤、分支、退出**：

1. successful connect后才分配并发布新branded`connectionGeneration`；failed handshake不消费generation。duplicate、rollback、非safe或非严格`+1` generation为typed invariant failure，不复用旧guard。
2. 原子扫描全部`cachedSessionIDs`，删除或标记所有`guard.generation !== connectionGeneration`的hydration guards；不是只invalidate touched/active session。并发同session fetch仍由existing `syncingSessions` coalesce。
3. 构造eager集合=`activeSessionIDs ∪ {currentSessionID if present}`并去重；对每个eager session并行fetch full transcript与status，不只依赖event cache。
4. 每个eager session两者success → 按existing revision规则merge并写`guard.generation = connectionGeneration`；arrival time不覆盖newer revision。任一absent/failure → 该session guard保持invalid并显示typed loading/non-success。
5. 其它cached session不在reconnect callback中eager fetch。它被选择时，selection path检查guard generation；不等于current generation就lazy并行fetch该session的full transcript与status，成功merge后才写current-generation guard。
6. lazy/eager任一路在transcript或status absent/failure时都不得default idle、不得用projection cache推断final；malformed projection沿typed hydration error返回。
7. signal abort/component disposal → 停止该generation未完成fetch并返回typed cancelled；旧generation晚到结果不得写current-generation guard。
8. future reconnect重试仍由existing `startSSE` backoff/cancellation拥有；本文不规定attempt上限。

**进展**：每个generation与每次selection只发有限requests，但network completion是conditional；reconnect loop可持续到lifecycle cancel。

**副作用/残留**：HTTP reads、local store/generation/guard merge；无authority、ManualStop、provider或tool side effect。

**§4.3.2正确性论证**：全cache generation invalidation排除旧one-shot guard掩盖missed events；eager集合确保active/current立即联合hydrate，其它session selection gate确保首次使用前lazy联合hydrate；只有transcript+status同时成功才写current-generation guard，因此missing status不能伪造idle，旧generation晚到结果也不能污染current view。

#### 7.11.1 TUI exact public subscription callback

```ts
export const applyLegacyTuiPublicEvent: <
  D extends M1.PublicEventDefinitionV1,
>(input: {
  event: M1.PublicCommittedEventV1<D>
  eventConnectionGeneration: M8.LegacyConnectionGeneration
  currentConnectionGeneration: M8.LegacyConnectionGeneration
}) => Effect.Effect<void, M8.LegacyHydrationError>
```

**Callers**：TUI SSE adapter只可drain `M1.PublicEventSubscriptionV1<D>`并把item与建立该subscription的exact connection generation原样传入。SDK/CLI同类subscriber适用相同generic intake rule。

**Callees**：existing revision-aware public store merge、current-session hydrator wakeup；不调用authority/projection F28或prefix filter。

**Requires**：`event`是subscription nominal item；两generation都由successful connection lifecycle构造。caller不得传a broad EventV2 union、unbranded payload或把不同subscription的D擦除后cast。

**步骤/分支**：1) generation不等→旧event no-op，不写store/guard；2) generation exact current→按D的public definition contract做revision-aware merge；3) event影响active/current session→wake hydrator但不宣告terminal；4)其它public event仅merge或no-op；5)subscription error走`M1.PublicEventReadErrorV1` error channel并触发transport/hydration策略，不伪造event；6)任何branch禁止读取`event.type` prefix筛除internal value。

**Ensures**：只有current-generation exact nominal public event可写TUI public store；subscriber本身不设置current-generation full-hydration guard，guard仍只在§7.11 transcript+status均成功后写。

**进展/副作用/正确性**：single finite event merge；local public store/wakeup only。nominal source排除internal，generation equality排除late event，联合hydrate gate排除event-only false final。

### 7.12 TUI/current public selector

```ts
export function deriveLegacyRecoveryView(input: {
  messages: readonly SessionV1.WithParts[]
  status: SessionStatus.Info
  currentUserID: SessionV1.MessageID
  currentSourceID?: SessionV1.MessageID
}): Effect.Effect<Readonly<{
  busy: boolean
  sourceID?: SessionV1.MessageID
  childID?: SessionV1.MessageID
  finalID?: SessionV1.MessageID
  manualStop: boolean
  childDisplayHint?: M1.RecoveryChildDisplayID
}>, M8.LegacyHydrationError>
```

[S — source seam only] current TUI没有该selector；missing status在部分current selectors会default idle。

**Callers**：Prompt/session render after successful hydration。

**Callees**：§7.2 decoder/adapter、ordinary public parent-chain selector。

**Requires**：messages按durable public order、status已成功hydrated、currentUserID/currentSourceID来自ordinary UI wiring。

**Ensures**：busy/source/child由current actual relations/status确定；final除actual terminal child/ordinary assistant外，只允许known `outcome:"manual-stop"`把anchored source投影为final display state；displayID只出现在hint field；inconsistency为typed error且无placeholder或authority side effect。

**步骤、分支、退出**：

1. 有限扫描messages并验证public ID uniqueness/order。
2. 从currentUserID/currentSourceID与actual parent-chain选择current assistant rows；不得从projection找MessageID。
3. decode source `recovery`：unsupported omit；malformed typed error；known仅读取exact M1 fields。known `outcome:"manual-stop"`只允许设置该anchored source的`manualStop=true`与final display state，不授权任何internal action。
4. `child.displayID`只存`childDisplayHint`用于render；不得parse、cast、map lookup或证明child存在。
5. actual relation有唯一child row才设置childID；terminal child由actual row/status决定。若无child，只有known ManualStop outcome可设置`finalID=sourceID`；projection absent/unsupported不得推断ManualStop，malformed已失败。
6. working/pending actual current chain → busy true；terminal child→final child；known ManualStop final display→final source；无terminal且status missing不可能进入本函数success。
7. old-chain projection不影响current busy；source与child保持独立rows，source error可见。fatal/indeterminate reconciliation返回typed error/unresolved，不构造placeholder或public authority event。
8. multiple/cycle/relation mismatch → typed error，无placeholder。

**进展**：有限messages线性扫描；无external wait。

**副作用/残留**：pure selector，无residue。

**§4.3.2正确性论证**：步骤2/5用真实transcript关系建立row identity，displayID只作为输出hint；current anchor排除old chain，status/terminal决定busy与child final，M1 known ManualStop outcome只完成source final display projection。absent/unsupported不产生该状态、malformed失败，因此既可观察ManualStop又不产生public authority或placeholder。

### 7.13 Model converter projection exclusion

```ts
export const toModelMessagesEffect: (
  input: SessionV1.WithParts[],
  model: Provider.Model,
  options?: {
    stripMedia?: boolean
    toolOutputMaxChars?: number
  },
) => Effect.Effect<ModelMessage[]>
```

保持current positional callable与inline options object；不引入独立options alias。

[S — source seam only] current converter positional signature已显式读取ordinary assistant fields并不spread `msg.info`到model message。

**Callers**：ordinary Legacy conversion与§5.1 SafeRetry truncated conversion。

**Callees**：existing part/tool/media converters。

**Requires**：SafeRetry caller只传safePrefix；ordinary caller传ordinary history。

**Ensures**：`Assistant.recovery`、`RecoveryChildDisplayID`及projection任一字段不进入ModelMessage/provider metadata/tool input/semantic digest/provider digest。

**步骤、分支、退出**：

1. 有限遍历messages。
2. assistant branch只读取现有explicit ordinary fields/parts；禁止`...msg.info`。
3. recovery field存在→忽略，不进入任何constructed object。
4. part conversion success append ordinary content；typed failure按existing converter contract。
5. 返回ModelMessage[]。

**进展**：有限message/part扫描；无network wait。

**副作用/残留**：ordinary conversion only；无DB/event/tool execution/network。

**§4.3.2正确性论证**：output构造allowlist没有recovery字段入口，SafeRetry进一步在input域排除source，所以projection和source都不能影响provider request。

### 7.14 Shell N/A

`SessionPrompt.shell`必须作为`M6.SerializedSubmission`的shell branch进入同一per-session serialized queue，不得在wrapper旁路queue/supersession ordering；进入M6后绕过model recovery coordinator、M7 lowering与model admission。synthetic assistant不消费N/M、不获recovery authority、不被Continue closure选择或重放；shell process side effect exactly once；后续prompt/command建立new model chain；`Assistant.recovery` omitted。

### 7.15 Native V2 regression-only

Native V2不调用M7/M8，不新增recovery endpoint/event/schema authority。shared schema、EventV2、SQLite、LLM protocol或generated client变更只验证existing Native V2 surface和zero leakage。

## 8. HTTP/SDK、wait 与 disconnect distributed contract

[F — planned; not created; not run] 本节冻结future distributed/public UX contract；不声称current runtime已满足。

### 8.1 Root/v2 exact 204

- 同一`SessionApi` route family的runtime `promptAsync` success status为204。
- `HttpApiSchema.NoContent.make()` branch不得调用body writer；response byte length=0，无`null`、`{}`、newline或JSON content type。
- root/v2 generated response map的204 payload保持`void`；method保留generated envelope。
- background ownership transfer失败不得返回204。

### 8.2 Connection/failure semantics

1. **连接模型**：HTTP request wait与scope-owned server operation分离；SSE/TUI使用现有connection lifecycle。
2. **timeout/deadline**：M8不新增。Runner、AbortSignal、component/source close与existing retry policy是owner。
3. **retry/idempotency**：prompt/command是非透明重试接口。indeterminate disconnect后禁止自动resend；当前无public stable idempotency key。
4. **delivery/order**：HTTP response loss不回滚M4 commit；SSE可漏/重/乱，不能作authority。每次成功SSE connection使用新generation并invalidate全部prior-generation cached hydration guards。
5. **failure**：pre-accept disconnect时acceptance未知；post-transfer disconnect只终止response wait/write。两者都需hydrate；absence不能证明未accept、不能推断ManualStop。fatal/indeterminate reconciliation只通过existing safe error/status/hydration成为non-success或typed unresolved。
6. **state/session**：public reconciliation以session + local operation/user/source identity锚定；不暴露M4 operationID。known `outcome:"manual-stop"`仅是source final display projection，不是authority。
7. **backpressure**：沿用existing HTTP/EventV2/SSE backpressure；M8不另建queue或drop policy。

### 8.3 Wait progress classification

- M7 array scans、M8 pure reducers/selectors：finite-loop或no-loop progress。
- sync handler、hydration reads、event publication：conditional wait；在callee返回/transport可用的条件下前进。
- interactive/TUI reconnect：lifecycle-bounded conditional wait；可持续到user/source/component cancellation。
- 不以N/M、poll cadence、heartbeat或reconnect backoff推导provider/tool completion。

## 9. End-to-end flows

### 9.1 SafeRetry

1. M3提交typed incomplete terminal；M4 reload complete `DurableRecoveryAuthorityViewV1`，其`toolEligibility`必须是branded safe-retry-eligible/truly-empty proof。
2. M5从validated complete view选择SafeRetry；没有selection或proof不是same authority object不得调用M7。
3. M7先复验exact safe-retry closure；M2建立stable no-send handle commitment reservation。sealed refs/leases exact empty；K7/K3 calls=0。
4. M7 full Legacy history pre-pass，source-before-all-transforms截断，并在scoped `use`把same proof/commitment/empty-leases candidate交M2 actual prepare exactly once；unique final object内M7 validation，hits=0 before release。
5. M5 final classification返回automatic proposal。
6. M4 K8以empty lease set、same commitment与exact type-9 payload验证后，在one transaction提交decision/child/ordinal/projection、三个recovery heads及aggregate event head/cursor，并返回complete `OperationCommitResultV1<"automatic-child-admitted-and-consumed">`。
7. complete result返回后立即调用M4 pre-release K8 validation；此时原handle仍prepared，K8以same result/commitment/empty lease set返回nominal proof。随后M2调用M1 F27并完成exact handle/reservation authorization，在proof scope内release原handle exactly once，最后M4 K9关闭empty set。K8 failure从prepared mechanical cancel → K9 close/zeroize empty set → cleanup exact registry → post-cancel resolution，且F27/M2 authorization calls=0；K9 failure在cleanup前fatal；detached receipt/proof不授权。
8. M6等待其owned chain并返回model-final；若它返回，M8 sync mapper返回effective assistant。

### 9.2 ContinueAfterSettledTools

1. M4 complete authority view提供same branded continue-eligible proof：partition exact authoritative-only，all tools final-after-hook-settled，并含ordered tool/reasoning/provider-prefix replay carriers+commitments；裸snapshot/fold/manual/compatibility/mixed不可进入。
2. M5从validated complete view选择Continue；没有该selection或proof identity mismatch不得调用M7。
3. M7 §5.2只用proof carriers构造/复验target-neutral `M1.RecoveryClosureDescriptor`，不访问plaintext；M2建立stable no-send handle commitment reservation，M4 K7为每个sealed ref取得live positive-generation lease。
4. M7在nested K3 scopes中从M1 carriers重建actual ordered `ModelMessage[]`：inline/sealed都strict decode/re-encode，tool arguments/result/error、reasoning、provider-prefix按proof event order和provider grammar成形，并重算tool/reasoning/prefix/closure commitments；Legacy/history/cache/projection/digest inversion calls=0，additional tool execution=0。
5. candidate在同一dynamic scope作为`lowered`与其余八个owner facts一起进入M2完整九字段actual `prepareDispatch` once；original inspection含final target/protocol/storage/body，M7在same object上按inspection target调用Anthropic/OpenAI allowlists并验证durable=planned/final、same reservation/leases。provider-specific constraint在此之前calls=0。
6. M2返回`PlannedRecoveryMaterialization<M2.AvailableDispatchHandle>`：success含same handle；unavailable或validation failure严格mechanical cancel → K9 close/zeroize same leases → cleanup exact object/registry → typed unavailable，K9 failure则cleanup前fatal。随后M5 final classification→M4 K8 commit validation/transaction→complete `OperationCommitResultV1`→immediate pre-release M4 K8（handle仍prepared）→M1 F27 + M2 exact handle/reservation authorization→M2 release exactly once→M4 K9 close；K8/authorization等automatic pre-release failure统一从prepared mechanical cancel → K9 → cleanup → post-cancel resolution，pre-release K8 failure的F27 calls=0，禁止second prepare/reacquire/lease substitution。

### 9.3 ManualStop/fatal

1. ordinary planning/admission/budget等完整typed facts可在automatic attempt前由M5/F23独立形成eligible ManualStop cause/proposal；corrupt、partial、owner-mismatched、non-foldable、unknown、unresolved或ambiguous authority/result直接fatal，永不转换为ManualStop。
2. normal final-classification ManualStop：fresh source binding + exact M5/F23 proposal → 若有unreleased prepared handle则mechanical cancel，使send closure不可达 → M2/M6调用M4 K9关闭/zeroize same leases → K9 success后cleanup exact handle/reservation registry → 才可进入ManualStop commit；K9 failure在cleanup/commit前fatal并保留relation registry。
3. failed/unknown automatic commit：必须先mechanical cancel → K9 close/zeroize same leases → cleanup exact handle/reservation registry → M4 A5 exact tuple lookup → 必要时M4 S2 `lookupCurrentRecoveryWinner`。A5 complete automatic result或S2任一complete winner→follow/re-enter winner，不进入ManualStop；A5/S2 corrupt、partial、unresolved或ambiguous→fatal。
4. 只有A5明确返回missing、M4 S2 `lookupCurrentRecoveryWinner`明确返回unchanged/no winner、fresh M4 S1 `loadRecoverySnapshot`证明source binding unchanged、且步骤1的eligible cause在automatic attempt前已存在，才可沿步骤2进入independent ManualStop；commit failure本身不得创建cause。这四项是failed automatic attempt进入ManualStop的exact prerequisites，不得删减或替换。
5. 调`M4.commitManualStop`；仅完整`OperationCommitResultV1<"decision-finalized">`或A5 exact replay恢复同一complete result并经post-state验证后，M6 model-final effectiveAssistant才为source；detached receipt不授权。
6. ManualStop exact result lookup仍失败/unknown：M6 fatal-stop；release state unknown或任一fatal/indeterminate authority同样fatal-stop，且不得再调用ManualStop commit。所有prepared automatic failure的fatal work都位于mechanical cancel → K9 → cleanup之后；K9自身失败例外为cleanup前立即fatal。M8只返回exact sanitized non-success，不能返回source伪装成功。

### 9.4 Disconnect/reconnect

1. disconnect不隐式cancel/ManualStop/rollback。
2. sync response已收到则final primary。
3. response未知或attach从public transcript/status actual relations reconcile；projection字段通常为hint，known `outcome:"manual-stop"`只确定anchored source的final display state且不授予authority。
4. projection absent/unsupported且无child不得推断ManualStop；malformed typed hydration error；missing status、fatal或indeterminate reconciliation均为non-success/typed unresolved。
5. 每次successful SSE connection产生新generation，先invalidate所有prior-generation cached hydration guards；active/current sessions eager transcript+status hydrate，其它cached sessions在selected时lazy transcript+status hydrate。
6. indeterminate absence不授权resend，也不产生新public authority event。

## 10. Future tests 设计映射

以下全部未创建、未运行；每行按单一branch固定provider-hit、local-tool-side-effect与durable-residue expectation。

| 标签 | branch / fixture | provider hits | local-tool side effects | durable residue | 精确 pass criteria |
|---|---|---:|---:|---|---|
| [F — planned; not created; not run] | M7 SafeRetry duplicate/order rejection | 0 | 0 | 0 writes, 0 handles | full pre-pass先拒绝duplicate/out-of-order；source从所有transform输入缺席 |
| [F — planned; not created; not run] | M7 SafeRetry assistant mapping exits | 0 | 0 | 0 writes, 0 handles | non-identical mapping object、absent、duplicate、wrong-role、session/source/high-water/source+control digest/latest-decision revision mismatch分别closed stale/absent/ambiguous/wrong-role；不cast internal ID、不查display ID、不从history猜 |
| [F — planned; not created; not run] | M7 SafeRetry successful lowering | 0 | 0 | stable reservation + 0 leases; 0 writes/actual handles before callback | branded proof is same authority object、partition truly-empty、mapping from authority snapshot exact；candidate binds same proof/commitment/empty leases；ModelMessage source-free |
| [F — planned; not created; not run] | R21 M7 automatic intake rejection matrix | 0 | 0 | 0 leases/handles/writes | plain snapshot、plain fold、structural proof duplicate、manual-only、compatibility-only、mixed、wrong snapshot identity全部closed；SafeRetry only truly-empty，Continue only authoritative-only/all final-after-hook-settled |
| [F — planned; not created; not run] | R22 Continue descriptor without plaintext | 0 | 1 total source fixture; +0 recovery | source carriers only; 0 K3/K7/handles | descriptor uses exact M1 replay exports、provider-prefix indexed schema、all owner builders/F22；no plaintext/Legacy/cache/projection/digest inversion；pre-inspection provider validator calls=0 |
| [F — planned; not created; not run] | R22 Continue inline/sealed actual reconstruction | 0 | +0 recovery | stable reservation + exact K7 live leases, then K9 close | tool arguments/result/error、reasoning、provider-prefix strict decode/re-encode；event/call order、result-vs-error与provider grammar exact；inline/sealed canonical equal；all digests/closure recomputed |
| [F — planned; not created; not run] | M7 Continue evidence/order mismatch | 0 | 1 total source fixture; +0 recovery | K7 absent or K9-closed; no raw escape | any brand/identity/source-range/phase/order/carrier/prefix/tool/reasoning/digest/lease mismatch typed failure；provider-specific validators未调用；no replay fallback |
| [F — planned; not created; not run] | R24 K7 before unseal/lowering/actual prepare | 0 | 0 | stable reservation; exact per-ref positive-generation live leases | descriptor exists without plaintext；K7 happens-before K3/lowering/actual prepare；generation0、missing/extra/duplicate/foreign/stale lease closed；M7 lifecycle calls=0 |
| [F — planned; not created; not run] | M2 unique prepare+inspection isolated before commit | 0 | 0 | available planned materialization内same prepared handle + live lease set；fixture结束以cancel→K9→cleanup，不模拟automatic release | M2 exact call has all nine owner-qualified fields `candidate/context/operationID/snapshotProof/closure/sealedUseLeases/reservation/lowered/runtimeInput`；`lowered` exact `M7.LoweredRecoveryCandidate`；commitment equals reservation；original inspection含final target/protocol/storage/body；same final object；no four-field complete declaration、second prepare/reacquire；F27/release calls=0 |
| [F — planned; not created; not run] | M2 inspection/provider-validation failure | 0 | 0 | 0 live handles/leases after mechanical cancel→K9→cleanup; 0 durable writes | typed unavailable无paused handle；send closure unreachable；K3/K9 zeroization；K9 success happens-before cleanup；no raw material/lookup proof/candidate escape |
| [F — planned; not created; not run] | R24 K8 commit/immediate-pre-release same-object validation | 0 before release | 0 | type-9 complete result + same prepared handle/live leases until release once, then K9 closed | K8 commit compares exact `OperationSchemaByTypeV1` payload/package/snapshot/closure/commitment/lease set；complete result后immediate pre-release K8在handle仍prepared且F27 calls=0时比较same result/handle/reservation/object/generation/material；success后才F27+M2 exact authorization→release once→K9；K8 failure从prepared mechanical cancel→K9→cleanup、F27/M2 authorization calls=0；K9 failure cleanup前fatal；detached/old proof rejected |
| [F — planned; not created; not run] | Anthropic signed continue | 0 before release | +0 recovery | same prepared handle/leases through complete result → immediate pre-release K8 → F27/M2 authorization → release once → K9 close | carrier-reconstructed ordered local call/result-or-error+signed reasoning retained；server/hosted/strip rejected；sealed material only K3 scoped |
| [F — planned; not created; not run] | OpenAI stored continue | 0 before release | +0 recovery | same prepared handle/leases through complete result → immediate pre-release K8 → F27/M2 authorization → release once → K9 close | store=true ordered function_call/output-or-error、stored-reference/provider-prefix/sealed state exact；strip/mismatch/hosted rejected |
| [F — planned; not created; not run] | OpenAI stateless continue | 0 before release | +0 recovery | same prepared handle、empty lease set through complete result → immediate pre-release K8 → F27/M2 authorization → release once → K9 close | store=false reasoning/encrypted/item_reference/stateful prefix absent；unknown storage or silent conversion fails |
| [F — planned; not created; not run] | automatic SafeRetry success, retries disabled | 2: source 1 + child 1 | 0 | source + one composite child/decision/projection/heads/receipt + terminal child state | complete result → immediate pre-release K8 while prepared → F27/M2 exact authorization → release once → K9；result后无额外child create；M6 returns final child |
| [F — planned; not created; not run] | automatic Continue success, retries disabled | 2: source 1 + child 1 | 1 total source fixture; +0 recovery | source evidence + one composite child/decision/projection/heads/receipt + terminal child | complete result → immediate pre-release K8 while prepared → F27/M2 exact authorization → release once → K9；Continue does not execute tool again |
| [F — planned; not created; not run] | automatic response loss, A5 complete result | 1: source only before re-entry fixture | 0 | committed automatic child/result retained; cancelled local handle cleaned | mechanical cancel → K9 close/zeroize same leases → cleanup exact registry → A5 exact complete result → no authorization of cancelled handle → follow/re-enter committed child；ManualStop calls=0 |
| [F — planned; not created; not run] | automatic CAS loser, complete current winner | 1: source only before winner follow fixture | 0 | winner-owned durable result only | mechanical cancel → K9 close/zeroize same leases → cleanup exact registry → A5 missing/exact result resolution → M4 S2 `lookupCurrentRecoveryWinner` complete manual/automatic/superseded winner → follow/re-enter；no local ManualStop rewrite |
| [F — planned; not created; not run] | automatic operation absent/no winner with pre-existing classified cause, ManualStop succeeds | 1: source only | 0 | no automatic child/receipt; exactly one committed ManualStop decision | mechanical cancel → K9 close/zeroize same leases → cleanup exact registry → A5 undefined → M4 S2 `lookupCurrentRecoveryWinner` unchanged/no winner → fresh S1 source binding exact → pre-existing M5/F23 eligible cause → complete ManualStop result；source only then returned |
| [F — planned; not created; not run] | automatic lookup or ManualStop result unresolved | 1: source only | 0 | no false ManualStop/source-success residue | mechanical cancel → K9 close/zeroize same leases → cleanup exact registry → A5、M4 S2 `lookupCurrentRecoveryWinner`或ManualStop exact result unresolved → M6 fatal-stop；M8 exact sanitizer |
| [F — planned; not created; not run] | K9 failure after prepared mechanical cancel | 0 before release | 0 | handle/reservation/lease relation registry retained; no A5/S2/replan/ManualStop work | mechanical cancel succeeds → K9 fails → immediate fatal before cleanup；registry state needed to relate same leases is not discarded；A5/S2/replan/ManualStop calls=0 |
| [F — planned; not created; not run] | corrupt/partial/owner-mismatched/non-foldable authority | 1: source only | 0 | no child and no ManualStop decision | prepared handle存在时mechanical cancel → K9 close/zeroize → cleanup → exact A5/S2/fold fatal work；K9 failure cleanup前fatal；`commitManualStop` not called |
| [F — planned; not created; not run] | unresolved/ambiguous authority/result/winner | 1: source only | 0 | no invented authority/public event and no false ManualStop residue | prepared handle存在时mechanical cancel → K9 close/zeroize → cleanup → typed fatal/unresolved；K9 failure cleanup前fatal；no ManualStop conversion、winner guessing或source-success fallback |
| [F — planned; not created; not run] | release state unknown | 1: source only; child send count indeterminate by injected seam | 0 | automatic receipt/child committed; no replacement handle/child | fatal ambiguity；no transparent resend、ManualStop commit或source-success fallback |
| [F — planned; not created; not run] | N=0 admission | 1: source only | 0 | committed ManualStop decision, no child | N blocks first incomplete child; dispatch/provider hits not used asN |
| [F — planned; not created; not run] | N=1 chain, retries disabled | 2: source + child ordinal1 | 0 | exactly one recovery child; second admission absent; terminal ManualStop/fatal fixture fixed by commit branch | N counts child admission only |
| [F — planned; not created; not run] | N=2 chain, retries disabled | 3: source + child1 + child2 | 0 | exactly two recovery children, no ordinal3 | default N admits ordinals1/2 only |
| [F — planned; not created; not run] | outer retry before incomplete child | 2 physical source hits | 0 | two dispatch ledger entries, one committed source assistant, N consumption 0 | dispatch/provider retry does not consumeN; M counts oneassistant |
| [F — planned; not created; not run] | committed effectiveM=1 while runtime config/`agent.steps` differ | 1: source only | 0 | one model assistant, no child; committed ManualStop branch | M6/first application/exact replay consume only transaction-verified committed `NormalizedRecoveryPolicy.digestInput.effectiveMaxModelAssistants=1`；runtime config/`agent.steps` reads与re-min calls=0；M counts initial assistant and blocks child |
| [F — planned; not created; not run] | committed effectiveM=2 while runtime config/`agent.steps` differ | 2: source + one child | 0 | exactly two model assistants; next assistant absent | M6/first application/exact replay consume only transaction-verified committed `NormalizedRecoveryPolicy.digestInput.effectiveMaxModelAssistants=2`；runtime config/`agent.steps` reads与re-min calls=0；ordinary/recovery assistants shareM |
| [F — planned; not created; not run] | projection F30 known | 0 | 0 | one hydrated message value | exact M1 fields only；no state/effective/authority fields |
| [F — planned; not created; not run] | projection known ManualStop display | 0 | 0 | anchored source displayed final, no authority write | `outcome:"manual-stop"` determines display only；cannot authorize internal action |
| [F — planned; not created; not run] | projection F30 unsupported | 0 | 0 | hydrated message with projection omitted | future version omitted without message failure；no child means no ManualStop inference |
| [F — planned; not created; not run] | projection F30 malformed | 0 | 0 | no accepted hydrated projection | typed hydration error；not absent；no child means no ManualStop inference |
| [F — planned; not created; not run] | display ID misuse regression | 0 | 0 | existing public transcript unchanged | no cast/parse/lookup asMessageID/authority；actual relation selectschild |
| [F — planned; not created; not run] | exact UnknownError mapping | 0 | 0 | one existing Legacy public error record per case | exact three strings/discriminator；single M8 / `sessrec-4-legacy-lowering-public-contract` mapping owner |
| [F — planned; not created; not run] | root/v2 prompt_async acceptance | 0 before background release | 0 | one scope-owned operation, HTTP body 0 bytes | status204、NoContent、void payload envelope |
| [F — planned; not created; not run] | prompt_async background fatal sanitizer | 0 in injected pre-release failure | 0 | one sanitized public error, 0 raw cause payloads | replaces current Cause.pretty seam；no stack/authority/sealed material |
| [F — planned; not created; not run] | sync prompt automatic success, retries disabled | 2: source + child | 0 | source+child committed chain | final response ischild through shared encoder |
| [F — planned; not created; not run] | sync command committed ManualStop | 1: source only | 0 | source + ManualStop decision, no child | final response is source only afterreceipt |
| [F — planned; not created; not run] | disconnect before acceptance injected | 0 | 0 | 0 server operation/durable writes | client remainsindeterminate until hydration; no resend |
| [F — planned; not created; not run] | disconnect after automatic commit | 2: source + child | 0 | source+child/receipt durable; response absent | hydration findsactual child；absence never meansnon-acceptance |
| [F — planned; not created; not run] | CLI sync final child | 2: source + child | 0 | hydrated source+child | human source/child distinct；exit0 fromsync child |
| [F — planned; not created; not run] | CLI JSON attempt-framed child success | 0 UI-side | 0 | framed source+child attempts + one final record | every attempt carries assistant/source IDs；failed source bytes never unframed-concatenate with child |
| [F — planned; not created; not run] | CLI JSON synchronous final-result | 0 UI-side | 0 | exactly one final-effective-result record | no progress/attempt bytes；record and exit derive from final effective assistant |
| [F — planned; not created; not run] | CLI attach actual terminal child | 0 UI-side | 0 | preexisting hydrated source+child/status | no provider dispatch；actual relation final；exit0 |
| [F — planned; not created; not run] | CLI attach missing status | 0 UI-side | 0 | preexisting transcript only | non-success until cancel/source close；no invented timeout |
| [F — planned; not created; not run] | interactive terminal | 0 UI-side | 0 | preexisting hydrated source+child/status | anchored wait resolves once；idle/missing status不resolve |
| [F — planned; not created; not run] | TUI reconnect generation eager hydration | 0 UI-side | 0 | all prior-generation guards invalid; active/current merged | new generation invalidates whole cache；active/current transcript+status eager；no placeholder |
| [F — planned; not created; not run] | TUI reconnect generation lazy hydration | 0 UI-side | 0 | non-active cached guard stays invalid until selection | selected session transcript+status lazy hydrate before current-generation guard |
| [F — planned; not created; not run] | public event exact nominal zero leakage | 0 | 0 | 0 internal payloads in listen/all/typed/public durable/readAggregate/bridge/sync/SSE/SDK/CLI/TUI | compile/runtime subscribers drain`M1.PublicEventSubscriptionV1<D>`items as exact`M1.PublicCommittedEventV1<D>`；a broad EventV2 union/structural cast rejected；trusted private manifest non-assignable；no prefix-filter branch |
| [F — planned; not created; not run] | model converter projection exclusion | 0 | 0 | 0 writes | recovery/display fields absent fromModelMessage/digests |
| [F — planned; not created; not run] | shell N/A | 0 model provider hits | 1 shell process | shell transcript + new model chain; no recovery projection | shell consumesneitherNnorM and is neverContinue replayed |
| [F — planned; not created; not run] | Native V2 regression fixture | 1 existing native model hit | 0 | existing Native V2 records only | no Legacy recovery API/event/authority；shared zero leakage |

## 11. Composition correctness

### 11.1 Exactly-one preparation

M7先从same branded M4 proof构造无plaintext descriptor；M2 stable `PreparedHandleCommitmentReservationV1`与M4 K7只是actual prepare前的use gate，不计第二次prepare。M7 callback-scoped output不含handle/final target/protocol/storage，但绑定same proof、reservation commitment与exact M4 lease objects，并只作为完整九字段S3 owner `prepareDispatch`的`lowered: M7.LoweredRecoveryCandidate`进入M2 actual prepare一次；其余`candidate/context/operationID/snapshotProof/closure/sealedUseLeases/reservation/runtimeInput`均以exact owner-qualified types显式传入。M2产生original available inspection，M7只在其后按inspection target验证same object；M2统一返回`PlannedRecoveryMaterialization<M2.AvailableDispatchHandle>`。M4 K8先在type-9 commit点复验；transaction返回complete `OperationCommitResultV1`后，下一步是在same handle仍prepared时执行immediate pre-release K8。只有该proof成功，M1 F27与M2 exact handle/reservation authorization才运行，随后M2 release exactly once、M4 K9关闭/zeroize；K8 failure从prepared mechanical cancel → K9 → cleanup且F27/authorization calls=0。detached receipt/proof与failure不能授权或触发replacement prepare/lease。因此不存在四字段complete signature、plain snapshot/structural proof、replay alias、second prepare、lease substitution或stale prepared object。

### 11.2 Continue prefix theorem

M4 branded proof证明complete frozen authority与eligible partition；M7从tool/reasoning/provider-prefix carriers证明frozen=durable并strict decode/re-encode/recompute为actual ordered messages；M2 same-object inspection证明durable=planned/final。success蕴含frozen=durable=planned/final，且tool arguments/result/error、reasoning、provider-prefix的value/order/provider grammar、M1 descriptor与all owner commitments一致；Legacy/cache/projection/digest inversion不在证明链。

### 11.3 Atomic child/admission

`M4.commitAutomaticChild` all-or-nothing包含decision consumption、child、ordinal、projection、three heads、receipt。direct success时child已存在，并严格走complete result → immediate K8 while prepared → F27/M2 authorization → release once → K9。failure/unknown不能仅凭返回值声称无residue：M6必须mechanical cancel → K9 close/zeroize same leases → cleanup exact handle/reservation registry → A5 exact tuple lookup → 必要时M4 S2 `lookupCurrentRecoveryWinner` complete-winner/unchanged lookup → follow/re-enter、replan、ManualStop或fatal post-cancel work。K9 failure在cleanup与后续work前fatal并保留relation registry。complete winner原样follow/re-enter；只有A5 operation absent + M4 S2 no winner/unchanged + fresh S1 source binding + pre-existing M5/F23 classified eligible cause四项同时成立，才可独立ManualStop。corrupt、partial、owner-mismatched、non-foldable、unknown、unresolved或ambiguous authority/result/winner直接fatal。合法ManualStop固定为fresh proof → mechanical cancel → K9 → cleanup → durable complete result。

### 11.4 Projection/display safety

M1 projection字段allowlist不含internal authority、receipt或head。F30三分支保留；M8使用actual public transcript relations决定rows，displayID只render hint。known `outcome:"manual-stop"`是authority-to-display deterministic projection，只决定anchored source的final display state；absent/unsupported不推断，malformed typed fail。因此projection不能驱动classifier、CAS、authorization、cancel/commit/release、child lookup或final authority。

### 11.5 Public zero leakage

M1/M4在public event source/durable writer之前排除internal variants；M8只发布ordinary public signals。bridge/sync/SSE/SDK/CLI/TUI均从`M1.PublicEventSubscriptionV1<D>`接收exact`M1.PublicCommittedEventV1<D>`；subscriber没有broad-event或prefix-filter分支。

### 11.6 UX partial correctness与conditional progress

M6若返回CoordinatorResult，sync mapper返回final effective value；CLI sync-primary、attach hydration、interactive/TUI只接受actual current public relation terminal，或M1 known ManualStop outcome对anchored source给出的final display state。fatal/indeterminate reconciliation保持non-success/typed unresolved。CLI machine output要么attempt-framed并带唯一final record，要么只输出一个synchronous final record；exit仍来自同一final effective assistant。external provider/tool/status不完成时只得到conditional wait，N/M不提供liveness；existing cancellation/source lifecycle是终止owner。

### 11.7 Side-effect exhaustion

- M7：complete authority/proof/history read、memory、canonicalization与K3-scoped message shaping；0 authority write/lease lifecycle/tool/provider release。plaintext-bearing candidate只进M2 callback。
- M2：one stable handle-commitment reservation + one actual prepared handle；inspect；complete result后的M4 immediate pre-release K8成功后才执行M1 F27 + exact handle/reservation authorization与release exactly once；任一prepared/validation/automatic pre-release failure先mechanical cancel，K9 success后才cleanup registry，pre-release K8 failure的F27 calls=0；不拥有sealed lease store。
- M4：K7 acquire、K3 scoped unseal/all-exit zeroize、K8 commit validation、automatic composite transaction complete result、immediate pre-release K8 validation、release/cancel后的K9 close/zeroize，或independent ManualStop transaction；K9 failure使post-cancel cleanup/A5/S2/replan/ManualStop不可达并立即fatal。
- M8 server：mapping/HTTP/public ordinary signals；无recovery authority write。
- CLI/TUI：public reads、local state/output/deferred；无provider/tool/durable authority。
- Continue additional tool side effect=0；shell existing process exactly once。

## 12. Review gates、expected sequence 与 implementation order

### 12.1 进入实施前的唯一顺序

下列顺序是硬门槛，必须先于任何implementation ordering解释：

1. 完成本文及所有owner引用的design review。
2. 获得explicit user approval；review通过本身不等于批准实施。
3. 完成workflow §6要求的Step 0 expectations与机械化约束提取。
4. 按批准后的设计实施代码。
5. implementation稳定后执行generated client/code generation。
6. code generation完成后创建并运行§10 tests与regressions。

任一步未完成时不得跳到后一步；本文修订不表示已获得user approval、已完成Step 0或已授权implementation/codegen/tests。

### 12.2 批准后的 implementation ordering

1. M7 export `LoweredRecoveryCandidate`并只引用exact M1 replay/closure/operation exports与M4 branded proof/lease exports；跨文档final audit确认M2完整九字段`prepareDispatch`逐字声明`candidate/context/operationID/snapshotProof/closure/sealedUseLeases/reservation/lowered/runtimeInput`及其owner-qualified types，`lowered`直接import该type且无四字段complete declaration、local structural duplicate/private alias。
2. 接M7 descriptor-first与R22 replay reconstruction；接M2 stable `PreparedHandleCommitmentReservationV1`、M4 K7-before-K3/lowering/actual-prepare、M2 unique actual preparation内§5.4 validator；prepared/validation failure实现mechanical cancel → K9 → cleanup，K9 failure cleanup前fatal；不得新增second inspection/prepare/reacquire。
3. 接M5 final proposal、M4 K8 commit validation、`commitAutomaticChild` complete result、immediate pre-release M4 K8（handle仍prepared）、M1 F27 + M2 exact handle/reservation authorization、release exactly once与M4 K9 close/zeroize；锁定K8 failure从prepared mechanical cancel → K9 → cleanup且F27 calls=0，K9 failure cleanup前fatal。再接A5 `lookupRecoveryOperationResult`/S2 `lookupCurrentRecoveryWinner`/`commitManualStop` complete results，并锁定automatic failure的mechanical cancel → K9 → cleanup → A5/S2/replan/ManualStop/fatal post-cancel work、K9 failure在registry discard前fatal、complete winner follow/re-enter或四项proof后的ManualStop，以及fatal-authority/no-raw-escape分支。
4. M1/M4实现projection field与F30；M8只decode/display/hydrate，known ManualStop只作为final display state。
5. 接shared sync encoder、exact prompt_async NoContent与sanitizer。
6. 接CLI reducer/hydrator/output framing/exit、interactive anchored wait、SSE generation与TUI eager/lazy hydration/selector。
7. 实现source-level event partition，再接bridge/SSE/SDK regression。
8. 完成上述implementation后regen generated clients；之后才执行§10 future tests。

### 12.3 本文内独立设计复核结论

以下design-contract checks已由stable-snapshot independent design audit复核并达到`0 P0 / 0 P1`；勾选不表示Step 0、implementation、future tests或Step 5 implementation audit已完成。

- [x] M7唯一export与M2 recovery input均引用`M7.LoweredRecoveryCandidate`；M2 owner `prepareDispatch`只存在完整九字段`candidate/context/operationID/snapshotProof/closure/sealedUseLeases/reservation/lowered/runtimeInput` declaration且全部使用exact owner-qualified types，无四字段complete signature；M7 automatic intake只接受same `M4.DurableRecoveryAuthorityViewV1`绑定的branded `M4.AutomaticRecoveryProofSliceV1`，无plain snapshot/fold/manual/structural alias。
- [x] R21 SafeRetry only truly-empty；Continue only authoritative-only/all final-after-hook-settled；compatibility-only/mixed/manual-only均closed。
- [x] R22 actual ordered `ModelMessage[]`只从M1 `RecoveryReplayPayloadV1`/`ToolTerminalReplayPayloadV1`/provider-prefix indexed carrier重建，inline/sealed均canonical decode/re-encode并重算all owner digests；Legacy/history/cache/projection/digest inversion absent。
- [x] R24 descriptor-first无plaintext、M2 stable handle reservation、M4 K7-before-K3/lowering/actual-prepare、same leases/commitment写入candidate、K8 commit validation、complete result后immediate pre-release K8（handle仍prepared）、随后F27+M2 exact authorization、release exactly once、M4 K9 close/zeroize，以及K8 failure从prepared mechanical cancel→K9→cleanup且F27 calls=0、K9 failure cleanup前fatal与M7 zero lifecycle ownership已列出。
- [x] M1 `RecoveryClosureDescriptor`、`LegacyUserMessagePredecessorV1`、`OperationSchemaByTypeV1`、`TypedIncompleteTerminalFact`、`AutomaticRecoveryAction`与replay exports全部按exact owner-qualified/indexed surface使用；private `ProviderPrefixCheckpoint`/`DecisionFinalizedReceiptV1` names与consumer structural copies absent。
- [x] M1 F30 `known | unsupported | malformed` decoder、M6 coordinator、N/M/ordinal语义、partial-correctness与no-transparent-resend保持完整。
- [x] prepared/validation failure与每个prepared automatic failure顺序固定为mechanical cancel → K9 close/zeroize → cleanup exact handle/reservation registry → A5/S2/replan/ManualStop/fatal post-cancel work；K9 failure在cleanup前fatal并保留lease relation registry。只有A5 operation absent + S2 no winner/unchanged + fresh S1 source binding + pre-existing M5/F23 classified cause四项exact prerequisites成立才可ManualStop；complete winner follow/re-enter，fatal/indeterminate authority不转换。
- [x] known ManualStop projection、Anthropic/OpenAI allowlists、CLI machine framing、public nominal events与branded reconnect generation hydration契约保持完整。
- [x] 三个exact`UnknownError`strings、fatal sanitizer、noReply/shell wrappers、prompt_async sanitizer`[F — planned; not created; not run]`义务、Native V2 regression-only与exact S/F markers作为review candidates已列出。

### 12.4 Design review已完成；approval、Step 0与implementation仍未完成

- [x] 当前M1 hash `588d60447c5d8ebc29e4dc3907d7633ce3fde861d32be509077d9164d2a278c6` 与S3 hash `dd29f291d0715c83581beb5192e44e3d1601b44dec093a2561b5b38da2b64490` 的exact exports、indexed private-receipt replacements、M6 policy-authority owner types、stable commitment reservation、already-cancelled automatic barrier、exclusive release latch、cleanup-to-tombstone ManualStop validation及K7/K3-scoped actual-prepare ordering已同步，cross-document independent design audit达到`0 P0 / 0 P1`。
- [x] 当前M4 hash `cbc242093908658151ad102d3adb7b719059fba09145c4b1b1e3531df87dde9c` 的branded authority/proof与K3/K7/K8/K9 exports、S2 handoff canonical K8-before-F27 order、automatic cancel→K9→cleanup→post-cancel-work，以及M2 prepared/cancel/A5/winner/fatal wiring已同步并通过cross-document independent design audit；本文未虚构替代proof/lease/replay type。
- [x] design review已完成，stable snapshot结论为`0 P0 / 0 P1`。
- [ ] explicit user approval尚未获得。
- [ ] workflow Step 0 expectations尚未完成。
- [ ] `SessionV1.Assistant.recovery`、M1 F30 codec与M4 public projection pipeline尚未实现。
- [ ] current prompt_async `Cause.pretty` publication尚未替换；sanitizer/test只是F obligation。
- [ ] prompt/command shared final encoder与M6 coordinator wiring尚未实现。
- [ ] M1 literal-public nominal source/service/subscription与trusted private durable replay partition尚未实现；CLI/TUI/SDK exact subscriber wiring尚未实现。
- [ ] CLI output framing、interactive CLI、SSE generation与TUI reconnect/finality contracts尚未实现。
- [ ] root/v2 generated artifacts尚未regen；只冻结204 payload contract。
- [ ] §10 future tests尚未创建、未运行。
- [ ] Native V2 regression与shell regression尚未运行。
- [x] final cross-document independent design audit已完成并达到`0 P0 / 0 P1`；approval、Step 0与implementation项仍保持unchecked。

## K. 细化完整性六条 checklist（top-level six-rule checklist）

> 机械规则：本节保持exact六项。stable-snapshot independent cross-document review已通过，因此六项标为`- [x]`；仍须按§12.1顺序等待explicit user approval → workflow Step 0 → implementation，checklist本身不授权后续步骤。

- [x] **推导连续**：M5 selection → branded authority/proof → descriptor without plaintext → M2 stable commitment reservation → M4 K7 → K3-scoped R22 lowering → M2完整九字段actual `prepareDispatch` once/inspection → M7 validation → M5 classify → M4 K8 commit validation/transaction → complete `OperationCommitResultV1` → immediate pre-release M4 K8 while handle prepared → M1 F27 + M2 exact handle/reservation authorization → M2 release exactly once → M4 K9已逐步覆盖；K8 failure从prepared mechanical cancel→K9→cleanup且F27 calls=0、K9 failure cleanup前fatal；prepared/validation与automatic failure逐字为mechanical cancel → K9 close/zeroize → cleanup exact registry → A5/S2/replan/ManualStop/fatal post-cancel work，K9 failure cleanup前fatal，ManualStop四项precondition与cleanup位置无跳步。
- [x] **分支覆盖**：plain snapshot/fold/structural proof/manual-only rejection、SafeRetry truly-empty、Continue authoritative-only/final-settled、inline/sealed/result/error/reasoning/provider-prefix、lease empty/nonempty/stale/closed、M2 available/unavailable、K8 commit/immediate-pre-release success与failure、F27/M2 authorization、M4 direct/A5/winner/fatal、F30三branch、CoordinatorResult四branch与public subscription error均独立刻画。
- [x] **退出覆盖**：descriptor/K7/K3/canonical/prepare/inspection/K8/authorization/release success/error/interrupt、pre-release K8 failure的prepared cancel与F27 zero-call、reservation abandon、mechanical cancel、release exactly once、K9 all-exit zeroization、K9 failure的pre-cleanup fatal+registry retention、K9-success后的cleanup、normal final、winner re-entry、replan、ManualStop、fatal-stop、hydration/transport/public event/machine framing的返回值与residue均列出；无raw material escape或source-success猜测。
- [x] **callee契约引用**：M1 exact closure/replay/`LegacyUserMessagePredecessorV1`/`OperationSchemaByTypeV1` builders+F22、F23/F28–F31与public carriers；M4 authority proof/K3/K7/K8/K9/A5/S2/winner/commit；M5 select/classify；M2完整九字段private prepare declaration、inspection、cancel、cleanup、F27、release；M6 submitSerialized及Legacy encoder/hydrator均按owner-qualified exported或indexed surface引用，无四字段complete signature、private alias/structural duplicate。
- [x] **循环刻画**：history、proof event-order、tool/reasoning/provider-prefix carrier、lease-set、canonical value、event/message scans均有finite measure；A5/winner由owner bounded；K3/keyring与hydration/reconnect明确为existing lifecycle-bounded conditional wait且不以N/M证明外部liveness。
- [x] **显式假设链**：每次descriptor/lowering前有exact M5 selection与same branded proof；SafeRetry mapping来自authority snapshot且partition truly-empty；Continue closure先于reservation/K7且K7先于unseal/lowering/actual prepare；candidate保存same proof/commitment/lease objects，inspection后保留M5 final classification；M6/first application/exact replay只消费transaction-verified committed `NormalizedRecoveryPolicy.digestInput.effectiveMaxModelAssistants`且不重读/re-min；automatic release固定为complete result → immediate pre-release K8 while prepared → F27+M2 exact authorization → release once → K9，K8 failure从prepared mechanical cancel→K9→cleanup且F27 calls=0、K9 failure cleanup前fatal；M8 public/CLI/TUI/reconnect/shell/noReply/prompt_async与ManualStop四项前提保持；Step 0严格位于explicit approval之后、任何implementation之前。
