# Session 不完整流恢复架构

> Issue：[#7](https://github.com/lihaokun/opencode/issues/7)
>
> 状态：架构评审稿；未进入函数级细化或生产实现。
>
> 当前来源：branch `yixiao-issue-7-new`，HEAD `135f2021517a2d4ac6f3dfc8d5e175dd2c0da309`。
>
> 实施提案：`docs/fixes/session-fix-incomplete-stream-recovery.md`。

## 0. 文档权威与状态

本文取代 2026-08-11 的同路径架构稿。自本文起，Issue #7 的架构评审以获批实施提案和当前 HEAD 为输入；实施提案负责需求、范围与原始证据清单，本文负责架构合同，并在 §1 记录当前 HEAD 的新鲜重跑结果及其证据边界。生产实现仍须等待本文评审以及后续详细设计完成。

## 1. 评审基线、证据与产品范围

### 1.1 基线与证据来源

| 项目 | 结论 |
|---|---|
| 当前分支 | `yixiao-issue-7-new` |
| 当前 HEAD | `135f2021517a2d4ac6f3dfc8d5e175dd2c0da309` |
| 规范输入 | 已提交的 `docs/fixes/session-fix-incomplete-stream-recovery.md` |
| 上游证据 | **No upstream**：未读取或引用上游仓库、上游分支或上游实现。当前 Git tracking remote 不构成架构证据。 |
| 当前 HEAD 运行证据 | 在 HEAD `135f2021517a2d4ac6f3dfc8d5e175dd2c0da309`、Bun `1.3.14` 上新鲜执行：10 个 CLI、7 个 `SessionPrompt`、5 个 `SessionProcessor`、1 个 retry policy、1 个 live HTTP/generated SDK、22 个 synthetic TUI Bun tests，以及 4 个精确单选 Legacy route scenarios；共 50 项，50 pass、0 fail、0 skip。 |
| 历史证据关系 | 实施提案记录的 commit `0ea5c2959` 运行结果仅作为历史交叉检查；本文以当前 HEAD 的新鲜重跑作为当前行为证据基线。 |
| 本轮动作 | 只改本文并重跑上述既有 scoped checks；不修改生产代码或测试，不执行 future recovery tests、codegen、commit 或 push。 |

### 1.2 A/B/C/D/S/F 证据追踪

| 等级 | 含义 | 当前可支持的结论 | 不可外推 |
|---|---|---|---|
| A | 真实 `opencode run` 子进程，经 Legacy Session、AI SDK 与 TCP fake provider；其中指定用例另做 SQLite transcript read-back | covered fixtures 中的 incomplete fail-stop、逐项断言的 partial/error preservation、ordinary tool continuation 与 child failure propagation | automatic recovery、通用 replay safety、所有 CLI 输出均已由 SQLite 独立验证、TUI E2E |
| B | live HTTP listener、generated SDK 与 TCP fake provider | public unprefixed Legacy transport wiring | 外部 consumer 产品验收、recovery correctness |
| C | `SessionPrompt`/`SessionProcessor`、AI SDK 与 TCP fake provider | Legacy settlement 边界及 covered outer retry fixture 可再次命中 provider | dispatch ledger、CAS、replay proof、所有 transport 的 retry 行为 |
| D | in-process route exerciser、synthetic TUI 与 unit tests | 精确断言覆盖的 handler wiring、render/sync mechanics 与 policy behavior | 产品 E2E、recovery correctness、durable-before-execute、runtime authorization |
| S | 当前 HEAD 源码与 pinned dependency 的静态检查 | source seams、调用关系、显式配置与 dependency default | 任何运行结果、请求次数、时序保证或产品行为证明 |
| F | 尚不存在的 future contract | 本文定义的 proof obligation 与验收边界 | 任何当前生产保证 |

当前 HEAD 的 50 项运行检查只支持逐项测试直接观察与断言的 A/B/C/D 结论；源码和 pinned dependency 的 S 级结论不计入这 50 项，也不构成运行证明。测试通过不得外推为未被断言的通用性质。本文新增的 typed recovery、dispatch ledger、三 CAS heads、paused transport gate、replay rebuilder、budget、wire projection 和 recovery TUI 行为均为 F 级设计义务。

### 1.3 规范产品范围

| 路径 | 本文范围 |
|---|---|
| Legacy CLI | `opencode run`、normal prompt、进入模型的 command、ordinary continuation、child/subtask；通过公开 unprefixed Session operations。 |
| Legacy TUI | TUI 通过 generated SDK 调用公开 unprefixed operations；需要 backend、sync、renderer 与 production submission 的分层验收。 |
| Public operations | `session.prompt`、`session.prompt_async`、`session.command` 进入 recovery；`session.shell` 保留兼容与回归，但 provider incomplete recovery 为 N/A。 |
| Shell | **N/A**：shell 本身不创建 provider stream。当前exact route scenario只验证handler返回200、assistant message与tool part；side effect一次、transcript/sync正确，以及后续独立prompt/command不重放shell，均是实施后的回归验收义务。shell synthetic assistant明确不进入model recovery chain、不分配`assistantSequence`且不消耗`M`；history/source selection按既有role/part语义保留其transcript，但不得把它当recovery source或tool closure。 |
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
| G5 | 任一 unknown、矛盾、未结算、过期、预算耗尽、ownership 丢失或持久化失败都 fail closed 为 `ManualStop` 或当前进程停止。 |
| G6 | Legacy 本地工具完整 call 必须在任何 hook 或副作用执行前 durable。 |
| G7 | recovery lineage、assistant attempt、semantic dispatch 与 decision/child link 可追踪、连续且无分叉。 |
| G8 | raw event authority 可跨数据库重建 materializations、三 CAS heads 与 public projections。 |
| G9 | automatic recovery 与同进程 model-assistant admission 分别受 `N` 与 `M` 约束；shell synthetic assistant明确排除，二者均不冒充 physical-request budget。 |
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
2. 当前 HEAD 的 covered CLI、`SessionPrompt` 与 `SessionProcessor` 用例观察到 canonical incomplete fail-stop；retry unit仅直接断言 canonical incomplete error 的 `SessionRetry.retryable(...)` 返回 `undefined`。未来合同继续禁止使用 generic retry 重跑旧 processor。
3. Legacy AI SDK 可能在 processor durable observation 前执行工具；part 缺失不证明 side effect 未发生。
4. 当前 exact endpoint/authority/wire body 可能在 high-level preparation 后继续被 provider factory、middleware、transform 或 fetch wrapper 修改。
5. 当前 provider contract 不普遍证明 attempt-wide idempotency 或 durable-prefix continuation。
6. current public Legacy terminal error 是 `UnknownError`；本文不改变其 discriminator。

## 4. 核心概念与数据模型

### 4.1 五级 identity

| 层级 | 定义 | 计数/约束 |
|---|---|---|
| Logical recovery chain | 一次用户工作及其 incomplete-triggered successors | `chainID`；new user input 创建新 chain |
| Model assistant attempt | 一个进入Legacy model processor的durable assistant message与processor生命周期；shell synthetic assistant不属于该identity | `assistantSequence` 在model recovery chain内从0连续递增 |
| Semantic dispatch | 一次 Legacy model invocation 的语义请求 | `dispatchOrdinal` 在 assistant 内从 0 连续递增 |
| Model step | 同一 invocation 内由 SDK stop condition控制的 provider step | S 级基线：当前 Legacy `streamText()` 调用未传 `stopWhen`，pinned `ai@6.0.168` 默认 `stepCountIs(1)`；50 项运行检查未普遍断言每个 invocation 的精确 step 数，且这不是 recovery budget |
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

### 4.3 Dispatch ledger

每个 semantic dispatch 在 provider network release 前写 authoritative ledger：

- **available evidence**：exact target/authority、normalized storage mode（`true` / `false` / `unknown`）、semantic digest、prepared digest、replay fence、capability summary、origin 与 context；
- **opaque evidence**：provider/model、是否提供local tools的已知程度、typed introspection failure，以及由gate内部生成但不声称语义可检查的opaque handle commitment；不得伪造target、semantic/prepared digest或replay proof。

ledger 以 `(sessionID, assistantID, dispatchOrdinal)` 唯一，ordinal 连续且由 CAS append。automatic recovery 只接受恰有 ordinal 0 的唯一 available source dispatch。opaque initial/ordinary request在 mechanical gate 已实现时仍可发送，但其 incomplete outcome固定 ManualStop。

### 4.4 分离的五类恢复对象

| 对象 | 内容 | 权威性与生命周期 |
|---|---|---|
| `DurableRecoverySnapshot` | terminal fact、完整 dispatch ledger、tool/reasoning evidence、frozen source version、control tail、durable continuation 与既有 decision/consumption | transaction-consistent reload；不含当前 config 推导、planned target、closure 或 runtime handle |
| `PlannedRecoveryMaterialization` | 针对一个 candidate action 的 exact target、normalized storage mode（`true` / `false` / `unknown`）、semantic/prepared digest、replay fence、capabilities、provider authorization、closure result 与 paused handle；或 typed unavailable cause | runtime-only planning result；网络仍为 0 hit；不是 source fact；storage `undefined`必须归一化为`unknown`而非暗算任一分支 |
| `AdmissionPlan` | exact next context、expected chain head、normalized `N`/`M`、budget availability、control-tail policy 与 policy digest | classifier输入；automatic composite transaction必须重查 |
| Proposal / Record | pure classifier产生proposal；ManualStop/finalization transition可形成finalized record；automatic action只由child-admission-and-consumption composite transition分配stable decision ID/revision并直接形成consumed record | proposal无durable authority；automatic record不存在active-without-child中间态；append-only revisions可consumed/superseded/finalized |
| Public projections | optional、versioned display schema：dispatch count、typed availability summary、source error保留状态、child link的非authority display ID与latest effective outcome；字段默认omit而非伪造false/zero，枚举unknown可解码 | rebuildable display only；不得包含target/authority、ledger ordinal明细、digest、proof、decision binding/consumption、CAS或sealed ref，也不得作为classifier、CAS或release输入 |

`RecoverySourceVersion` 冻结 terminal/tool/reasoning/dispatch source facts提交时的 aggregate high-water。它同时绑定：截至该 high-water 的完整 aggregate event hash chain，以及只从该 source assistant 的版本化 recovery source event/field set提取的 facts digest。`RecoveryControlTailVersion` 从 source high-water exclusive 到当前 high-water inclusive，绑定 exact sequence range、实际 tail hash、允许的 control event/field set版本与空 tail genesis。允许的 control语义仅为ManualStop/finalization/supersession revision与atomic automatic child-admission-and-consumption；任何普通input/config/history/tool event、未知 `session.recovery.*` type、缺失/额外 authority field、gap、duplicate或不识别版本都使旧binding stale或authority invalid。

Continue所称“三处prefix”固定为：frozen `RecoverySourceVersion` 中的 provider-prefix checkpoint、`DurableRecoverySnapshot` 中的 durable continuation checkpoint、planned authorization/proof中的 checkpoint。三者必须全部存在、canonical equal，并共同满足session/aggregate、source assistant、high-water、hash version/digest与ancestry；missing、extra或mismatch均fail closed。

### 4.5 三类 digest

| Digest | 绑定内容 | 明确排除/用途 |
|---|---|---|
| Semantic digest | exact target/authority、final tool definitions、wire-semantic provider/model options、实际 lowered system/history/body | 排除 decision/child identity、lineage link、proof envelope、timestamp；`SafeRetry` 要求 planned 与 source 相等 |
| Prepared digest | semantic payload，加 source fence/capabilities、当前 recovery authorization commitment 与 Continue closure | 绑定这一次 exact prepared dispatch；不要求与 source prepared digest相等 |
| Binding digest | source assistant/version、exact `RecoveryControlTailVersion`、candidate context、action、target、semantic/prepared digest、authorization、closure、`N`/`M` admission 与 control policy | 绑定 proposal/record/receipt；tail内容或任何其他组成变化使旧 binding stale |

三类 digest 都有版本化 canonical encoding。对象 key insertion order 不影响 digest；secret raw value 不进入 canonical input；任何被声明的语义字段变化必须改变对应 digest。

### 4.6 Typed durable terminal settlement

terminal settlement 由两条入口合流：

- adapter 发出的 canonical `incomplete-stream`；
- processor drain 后发现没有可信 final step settlement 的 clean EOF。

processor 必须先等待已登记工具，持久化 input/call/execution/settlement/interruption 与 reasoning provenance，再提交不含 decision 的 typed terminal fact。terminal fact成功提交后 reload snapshot；提交、reload 或 projection consistency 任一步失败，当前进程停止且不发起 recovery provider call。

public assistant仍投影既有`UnknownError`，并保留当前三类公开message映射而不擅自合并：canonical adapter incomplete为`Provider stream ended without a terminal finish event`，clean EOF无settled step为`Provider stream ended without a settled model step`，empty unknown保持其既有unknown-finish message。internal typed terminal、classification、ledger和proof不改变public error discriminator；若实现发现当前源码message发生漂移，必须先以当前HEAD runtime fixture冻结实际wire再更新详细设计，不能只凭静态常量假定兼容。

### 4.7 Tool 与 reasoning evidence

Tool evidence 必须区分：

- execution kind：local、provider 或 unknown；
- input：open、complete 或 unknown；
- call：durable、not observed 或 unknown；
- settlement：pending、running、completed 或 error；
- interruption：execution interrupted、provider result missing 或无。

可选 `providerExecuted` 缺失不能解码为 false。旧数据缺字段、definition 不可解析或事实冲突都投影 unknown。

Reasoning evidence区分 natural provider end、step-boundary forced flush 与 cleanup forced flush。只有 provider-end 且具备目标 protocol要求的 signature/encrypted state/metadata 的 block 默认可进入 Continue closure。

### 4.8 唯一 authority 与 rebuildable materializations

唯一权威关系：

```text
raw EventTable 中 serialized internal session.recovery.* transitions
  = sole canonical replay authority

append-only relations / decisions / consumptions / dispatch ledger / projections
  = transactionally rebuildable materializations

three CAS heads
  = derived online concurrency indexes

assistant public projections
  = rebuildable display state
```

每个内部operation都具有caller在首次提交前生成的稳定 `operationID`，并绑定session aggregate、operation type、canonical payload digest与expected predecessor；同一`operationID`不得绑定不同payload。aggregate sequence由M4在transaction内分配并随commit receipt返回，raw authority持久化`operationID`唯一索引。commit响应丢失时，caller只能按`operationID`查询既有raw event及folded post-state：exact match返回原sequence/receipt，missing可重新提交，conflict或partial state fail closed。

内部 transition 至少覆盖 initial-chain-genesis-and-dispatch、ordinary-assistant-and-dispatch-admitted、subsequent source dispatch、tool/reasoning evidence、provider prefix、incomplete terminal、decision revision、finalization及 child-admission-and-consumption composite operation。initial/ordinary在runtime先预分配无authority的candidate identity并prepare paused request；`initial-chain-genesis-and-dispatch`随后原子创建sequence 0 assistant、chain relation、genesis head、ordinal-0 ledger与dispatch head，`ordinary-assistant-and-dispatch-admitted`绑定expected chain head并原子创建immediate successor、推进chain head、写ordinal-0 ledger与dispatch head。prepare失败时没有assistant admission、`M`消耗或head残留。它们与recovery child operation一样按aggregate sequence、版本化field sets与完整event hash chain canonicalize，成为rebuild所有model-assistant sequence/head和initial dispatch的唯一来源。

`session.recovery.*` 只能进入 raw `EventTable` 和 internal projector/rebuilder。internal publisher必须在core live notification之前隔离，或对`listen`/`all`/typed subscribe、instance/global SSE、`EventV2Bridge`、durable `sync`与所有shared/Native V2 subscriber逐边界执行默认拒绝过滤；只在GlobalBus或bridge emit处过滤不足以满足合同。外部只看到安全projection与既有message/session signals，验收必须同时观察上述每个通道并证明raw authority仍可由rebuilder读取。

### 4.9 三个 CAS heads

| Head | 保护对象 | 成功条件 |
|---|---|---|
| `recovery_head(sessionID, sourceAssistantID)` | decision series 的 revision、finalization、consumption、supersession | expected predecessor精确匹配，affected rows = 1 |
| `assistant_chain_head(sessionID, chainID)` | initial/ordinary/recovery model assistant 的唯一 immediate successor；不包含shell synthetic assistant | genesis要求head不存在且candidate sequence=0、chainID绑定initial assistant；successor要求expected current head精确匹配、candidate sequence=current+1且source仍是head；insert/update affected rows均精确为1 |
| `dispatch_ledger_head(sessionID, assistantID)` | 每个 semantic dispatch 的唯一 immediate ordinal | expected ordinal predecessor匹配，无 duplicate/gap |

Initial/ordinary composite admission-dispatch与automatic child都必须先追加各自serialized authoritative operation，再由同一publication transaction的projector/materialization与heads commit落地。Initial composite CAS-insert genesis chain head并创建sequence 0 assistant、ordinal-0 ledger及dispatch head；ordinary composite CAS expected chain head并创建唯一immediate successor、ordinal-0 ledger及dispatch head；automatic child另同时处理recovery head、decision consumption与同样的chain/dispatch写入。任一CAS失败都回滚operation event、assistant/message relation、ledger、projection与heads；因此rebuilder可只从raw operations重建每条chain及初始dispatch的完整head历史。

### 4.10 Projector、commit 与 rebuilder

| 组件 | 职责 | 禁止事项 |
|---|---|---|
| Recovery transition projector | online/accepted replay 从 discriminated operation 幂等写 immutable relations、decision/consumption、child message/ledger和 public projection；验证 folded next-state digest | 不写 CAS heads，不把 projection变成 authority |
| Recovery heads commit | 首次应用operation时，在event publication transaction内按operation原子CAS所需heads且每个insert/update affected rows必须=1；任一失败使projector、event row、sequence、projection与heads全部回滚。exact same serialized operation重放时，只有raw event/payload/sequence、materializations及所有相关heads都已精确等于folded post-state，才允许无副作用no-op | 不产生第二serialized authority；不得把0-row CAS自动当幂等成功，partial match、head mismatch或不同payload仍fail closed |
| Recovery replay rebuilder | 直接按 raw aggregate sequence fold，重建/校验 relations、projections与heads；完整 prefix finalization 前 suppress live publication | 不从 materialization反写或选择 raw event branch，不从 public projection修复 authority |

same serialized event只在raw event/payload/sequence、全部materializations与相关heads已经精确处于该operation的folded post-state时，才可幂等no-op接受；这不是放宽首次CAS的affected-row=1要求。same sequence different payload/type、partial materialization、unknown event/version、branch、gap、duplicate transition、orphan relation、multiple-effective revisions或head mismatch都 fail closed。session显式删除可按现有 cascade 删除整个 aggregate及materializations。

## 5. 核心行为

### 5.1 Typed prepare → authorize → release / cancel gate

Lifecycle 只有：

```text
prepared → authorized → released
prepared → cancelled
authorized → cancelled
```

- **Prepare**：在最终 middleware/provider transform之后、实际 `doStream`/fetch之前得到 exact normalized request、target/authority、storage mode与 digest inputs；provider hits必须为0。
- **Select/Classify**：pure selector先从durable snapshot选出至多一个action-specific candidate；M7/M2完成该候选的no-send planning后，pure classifier只读durable snapshot、planned materialization和admission plan输出proposal。selection不构成安全结论。
- **Authorize**：available initial/ordinary以`AvailableDispatchReceipt`授权，绑定assistant、dispatch ordinal、exact target、prepared digest与paused-handle commitment；opaque initial/ordinary只能以`OpaqueDispatchReceipt`授权，绑定assistant、ordinal、typed opaque cause与不可伪造的opaque handle commitment，不声称target/digest/proof，且其incomplete固定ManualStop。recovery由automatic composite transaction重读source/control state与policy，完成revision、三heads CAS、child/ledger/consumption并返回`RecoveryAdmissionReceipt`，绑定exact target、prepared digest与同一paused handle。
- **Release**：同一个 paused handle只接受完全匹配的 receipt，单次释放已绑定请求。
- **Cancel**：ManualStop、typed planning unavailable、stale binding、CAS/persistence failure、supersession、budget exhaustion、ownership loss或任何 pre-release exception都机械关闭 gate；recovery provider hits保持0。

仅创建 `streamText()` 后延迟消费 stream不构成 paused gate；construction可能已经开始 `doStream`。AbortController也只证明可取消，不证明零发送。

### 5.2 Legacy durable-before-execute

所有最终可执行 local tools必须经统一 gate：

1. 所有可改变tool identity/input的纯 normalization、rewrite与routing先完成，materialize最终 execution plan、完整tool call与owning assistant identity；
2. durable提交该最终plan的input complete、call durable与running evidence；
3. commit成功后才允许 side-effectful plugin hook、tool wrapper或原始 execution；这些阶段不得再改变已提交的tool identity/input，若需要replacement或short-circuit必须作为新的typed plan/settlement先durable记录；
4. hook自身的side effect也受同一durable invocation fence约束，hook failure、replacement与synthetic result必须映射到typed settlement；
5. settlement/error/interruption durable后才允许 terminal classification；
6. 任一pre-execution commit失败时所有local side effect必须为0。

没有该 handshake时，source local replay fence只能是 unknown；提供本地工具的 incomplete attempt不得 automatic recovery。

### 5.3 Pure、proposal-only、保守 classifier

Classifier：

- 不调用 provider、model factory、tool或storage；
- 不读取当前 config以重算 source evidence；
- 不创建/释放 handle；
- 不分配 CAS-dependent decision ID/revision；
- 不持久化；
- 只返回 `SafeRetry`、`ContinueAfterSettledTools` 或 ordered `ManualStop` proposal。

`SafeRetry` 必须同时满足：source一致且唯一 available dispatch、origin/consumed link一致、plan available、`N`/`M`可用、local replay safe、provider no-side-effects或matching attempt-wide idempotency、semantic digest相等、无tool evidence、closure not needed。

`ContinueAfterSettledTools` 必须同时满足：上述source/origin/admission/local条件、所有tools完整 durable且settled、provider no-side-effects或matching durable-prefix continuation、三处prefix存在且同源/祖先验证通过、provider-valid closure可构造且binding一致。

其他情况均 `ManualStop`。Classifier通过不等于允许发送；只有matching authoritative receipt可授权release。

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

原因先按 causal gate判定，再按此顺序排序、去重且保证非空。结构失败抑制依赖available dispatch的下游predicate；typed unavailable cause必须穷尽映射，free-form detail不参与稳定reason。

### 5.5 Legacy lowering

#### `SafeRetry`

- 从失败assistant之前的history重新构造request；
- 排除失败assistant的text、reasoning、tools、provider metadata与StructuredOutput；
- 保留失败assistant在durable transcript/UI；
- 新成功只属于recovery child。

#### `ContinueAfterSettledTools`

最小closure只包含：

- durable settled tool call/result；
- protocol要求且具provider-end provenance的signed/encrypted reasoning；
- 必需的结构分隔与最终provider metadata；
- 与planned target/model/storage兼容的reference或typed stateless representation。

排除partial prose、open input、pending/running/interrupted/uncertain tool、forced-flush reasoning及无关旧文本。闭包必须在classification前构造并绑定digest，不能先决定Continue再试错。

### 5.6 Anthropic 与 OpenAI storage 区分

| Protocol | 可接受路径 | Fail-closed 路径 |
|---|---|---|
| Anthropic Messages | provider-end reasoning signature；actual audited Legacy lowerer支持的inline server-tool call/result满足最小closure grammar：每个call ID/name/kind唯一，result与call一一匹配且按provider要求邻接/有序，duplicate/missing/extra result为非法，error result仅在allowlist声明时接受，reasoning signature按其实际block scope验证 | unsupported server-tool kind、call/result ID或name不匹配、duplicate/missing result、非法text/reasoning交错、缺signature/metadata、forced flush、model不兼容或runtime lowerer未与authorization共用 |
| OpenAI Responses，normalized `store=true` | durable stored reasoning item reference；最终 transform保留的 hosted/provider-executed item reference | metadata namespace缺失、item reference缺失、target/authority/model/storage不匹配或最终transform删除identity |
| OpenAI Responses，normalized `store=false` | 只有actual audited Legacy lowerer可完整表达的typed stateless encrypted reasoning/hosted-item allowlist；local tool仍用普通tool messages | 未明确归一化为false、需要item ID但已删除、无完整encrypted state、hosted kind未allowlist或只靠golden fixture猜测支持 |

Golden/recorded fixtures只能防回归，不能替代每次 exact pre-release runtime proof。

### 5.7 `N`/`M` budget

- `N`：logical chain中允许的 incomplete-triggered child上限；candidate recovery ordinal必须 `<= N`。`N=0/1/2`是必须覆盖的边界，不批准固定默认2。
- `M`：同进程model recovery chain的hard model-assistant admission上限；合法assistant sequence为`0..M-1`。initial、ordinary continuation与recovery child受其约束，shell synthetic assistant不进入该chain也不消耗M。
- 任一预算耗尽都不建child、不consume、不release，并append新的finalized ManualStop revision。
- 二者都不计semantic dispatch、model step或physical provider request。

### 5.8 Revision、supersession、re-entry 与 crash

- first committed decision revision为0；若先前已有finalized/superseded revision，fresh reclassification的下一次commit append `revision + 1`，不覆盖旧record。无authority的planning/proposal重算不自行增加revision。
- folded state最多一个latest effective revision；ManualStop/finalization revision可finalized，automatic composite revision直接consumed，旧revision可superseded。本文不持久化automatic active-without-child状态。
- new user input先将unresolved source finalize为 `superseded-by-new-user-input`，commit成功后才创建新lineage；若child consumption先赢，则走既有steering/queue语义。
- automatic decision与child admission/consumption是同一composite transaction：commit前不存在authoritative automatic record，commit后decision直接为consumed且唯一child已存在。automatic decision不具有可持久化的中间状态；pre-commit planning/proposal可重新执行，但从不具有dispatch authority。
- matching terminal child只观察或继续分类；仅同进程、原runner ownership仍活跃时可attach nonterminal child。
- crash边界分三类：automatic composite未commit且没有durable child/ledger时，旧proposal/handle无authority，restart可从fresh snapshot重新plan；composite已commit且原进程仍持有可证明从未调用release的同一prepared handle时，可按operationID取回matching receipt并单次release；一旦release调用状态未知、process restart使旧handle丢失、ownership loss或child ledger durable但settlement不可证明，则dispatch ambiguity，不得再次consume、release或创建same sequence。
- crash发生在provider收到request而客户端未观察settlement的边界时，本文只保证fail closed，不声称exactly-once。

## 6. 八个 Legacy-oriented 模块

### M1. Shared Recovery Contracts and Canonical Semantics

- **Workflow**：定义typed classification、identity、target/domain、sealed refs、fence/proof、terminal、decision、canonical event sets与三类digest envelope；向LLM/core/Legacy提供单一schema。
- **Requires**：dependency方向保持 `schema ← llm ← opencode`；所有authority字段可编码、版本化且不含raw secret。
- **Ensures**：同一语义只有一套wire/durable定义；canonical membership、nullable/discriminator与digest输入可机械验证。
- **Invariants**：schema不依赖llm/opencode；source/control event sets互斥；unknown version fail closed。
- **Side effects**：仅schema/codec与canonical contract变化；不dispatch、不持久化runtime state。

### M2. Legacy Dispatch Preparation and Transport Gate

- **Workflow**：对initial与ordinary request进行final no-send lowering，解析target/authority/storage并生成available或opaque evidence与paused handle；对recovery candidate只允许生成available `PlannedRecoveryMaterialization`，introspection/proof/lowering不可用时返回typed unavailable并cancel，不得生成opaque recovery origin或child ledger；接收receipt后release或cancel。
- **Requires**：gate位于所有语义改变之后、network release之前；dynamic factory/middleware/fetch rewrite必须被纳入或降级opaque。
- **Ensures**：每次covered semantic dispatch都有evidence-before-send；automatic child只有matchingreceipt可单次release。
- **Invariants**：prepare时provider hits=0；handle线性；authorization后request不可替换；raw secret不落盘。
- **Side effects**：prepare可持有ephemeral transport资源；release发起provider I/O；cancel关闭资源。

### M3. Legacy Execution Evidence and Terminal Settlement

- **Workflow**：processor消费stream；tool gate先durable call再execute；drain后settle tools/reasoning；canonical adapter与clean EOF统一为typed terminal并reload snapshot。
- **Requires**：所有tool execution都经过中央gate；durable publication成功是唯一事实；incomplete继续排除于generic retry。
- **Ensures**：terminal前工具和reasoning provenance完整；commit failure不执行local side effect、不进入recovery dispatch。
- **Invariants**：pending/running/interrupted/unknown不冒充settled；forced flush不冒充provider end；public terminal仍UnknownError。
- **Side effects**：写parts、internal source facts与terminal transition；成功gate后执行local tool。

### M4. Durable Recovery Authority, CAS and Replay

- **Workflow**：internal publisher追加raw transitions；projector同事务materialize；commit CAS heads；rebuilder按raw chain修复/验证并suppress replay publication；同时拥有sealed-store的scope、rotation、cascade、redaction与runtime unseal生命周期。
- **Requires**：raw `EventTable`按aggregate sequence可读取；projector、commit与event row处于同一SQLite transaction；migration不推断旧assistant安全。
- **Ensures**：relations、ledger、decisions、child、heads与public projections可从raw authority重建；竞争只产生一个合法successor。
- **Invariants**：raw events sole authority；head与fold一致；无matching event的row/head不能authorize；internal transition不公开。
- **Side effects**：SQLite event/materialization/head/projection写入、sealed material写入/读取/rotation与session cascade删除；raw secret不进入日志或public surface。

### M5. Recovery Planner and Pure Classifier

- **Workflow**：先以pure、无authority的candidate selector从snapshot选出至多一个候选 action/context，固定优先级为：存在完整settled-tool evidence时只候选Continue，否则只候选SafeRetry；结构不一致或两者同时/均不可判定时直接候选ManualStop。随后由M7/M2针对该单一候选lower/prepare，M5再组合planned materialization与AdmissionPlan，验证source、proof、tool、closure、digest与budget并输出最终proposal。
- **Requires**：输入typed且来源分离；current config只存在于planned materialization；candidate selector不授予安全结论；ManualStop reason mapping穷尽。
- **Ensures**：每轮最多存在一个paused candidate handle；只在全部proof成立时proposal automatic，否则给稳定有序、去重、非空ManualStop reasons，未采用或失败的handle由M6立即cancel。
- **Invariants**：selection与classification均纯、确定、proposal-only；输入排列不改变结果；不持久化、不dispatch、不分配revision。
- **Side effects**：无。

### M6. Legacy Recovery Coordinator and Admission Lifecycle

- **Workflow**：统一拥有所有model-assistant admission。Initial/ordinary先校验`M`并预分配无authority的candidate identity，完成paused request preparation后，再以单一atomic admission-dispatch operation创建assistant、推进/建立`assistant_chain_head`、写ordinal-0 ledger与`dispatch_ledger_head`并消耗`M`；prepare或composite commit失败不留下assistant。recovery则reload snapshot、select candidate、prepare、classify、finalize ManualStop或以单一automatic composite transaction直接创建consumed revision并原子CAS三heads、admit child/ledger/consumption；用receipt驱动release；处理supersession/re-entry。shell synthetic assistant不经过本模块的model-chain admission。
- **Requires**：持有session runner ownership；任何model-assistant admission前已有normalized `M`与expected chain predecessor；recovery另持有paused handle，且automatic composite transaction重读source/control/admission policy；attempt-local state可重置。
- **Ensures**：initial、ordinary与recovery model assistant都只通过唯一immediate-successor admission创建并消耗`M`；shell不改变model-chain head；每次recovery使用新assistant且旧failure保留；stale/CAS/budget/persistence failure零release；revision和child无分叉。
- **Invariants**：candidate是chain immediate successor；ordinary只递增assistant sequence，incomplete child还递增recovery ordinal；一个decision最多消费一次；StructuredOutput不跨attempt。
- **Side effects**：为initial/ordinary写serialized composite admission-dispatch operation、assistant、chain/dispatch heads与ordinal-0 ledger；为recovery写automatic composite decision/child/ledger/consumption；调用gate authorize/release/cancel。prepare失败无durable admission side effect。

### M7. Recovery-aware History and Protocol Closure

- **Workflow**：为SafeRetry排除failed assistant；为Continue按durable sequence和目标protocol构造最小closure；验证Anthropic/OpenAI storage/model规则并生成closure digest。
- **Requires**：reasoning/tool provenance完整；actual Legacy dispatch复用audited lowerer或exact pre-release capture；planned target/storage已知。
- **Ensures**：failed partial内容不晋升；settled tools只作为history而不重新执行；不可表达的closure返回typed unavailable。
- **Invariants**：provider-end与forced flush分离；OpenAI store分支不混用；closure在classification前固定。
- **Side effects**：仅构造runtime planned representation；不写authority、不发送网络。

### M8. Public Legacy Entrypoints, Projections and UX Compatibility

- **Workflow**：public unprefixed prompt/prompt_async/command调用Legacy coordinator；shell走N/A边界；安全projection经Legacy HTTP/generated SDK/TUI sync/render展示。
- **Requires**：internal transitions在core notification及每个public/shared publication边界默认拒绝；optional projection字段有冻结的version/nullability/omission合同且旧client可解码；TUI按真实transcript hydration/reconciliation而非live event次数或authority做展示。
- **Ensures**：public error仍UnknownError并保留冻结的message映射；旧assistant error可见，新child独立；ManualStop不建child；shell不被recovery重放；SafeRetry/Continue/ManualStop均有明确busy/idle与最终显示状态。
- **Invariants**：ledger/proof/digest/decision link/CAS/sealed material不进入public wire/event；Native V2 subscriber不接收internal recovery payload。
- **Side effects**：HTTP/SDK responses、public sync signals与TUI状态更新；不直接修改authority。

## 7. 关键模块接口合同

| Interface | 输入 | 输出 | Caller责任 | Callee保证 |
|---|---|---|---|---|
| M6/M2 → M4 initial/ordinary composite admission-dispatch | serialized genesis/ordinary composite operation、preallocated candidate context、normalized M、expected chain predecessor、typed available/opaque evidence与handle commitment | committed assistant identity、chain/dispatch-head receipt（available或opaque discriminator）或typed failure | paused request已prepare但network尚未release；initial使用explicit genesis，ordinary引用current model head；available绑定exact target/prepared digest，opaque只绑定typed cause/opaque commitment | raw operation、assistant/message relation、M admission、ordinal-0 ledger及chain/dispatch CAS全有或全无；prepare失败无调用，commit失败无assistant；receipt只匹配同一handle/evidence |
| M2 → M4 subsequent dispatch recording | 同一assistant的后续model-step/resend evidence、expected ledger predecessor与handle commitment | matching available/opaque receipt或typed failure | assistant已admitted，network尚未release；ordinal必须为immediate successor | raw transition、ledger materialization与dispatch-head CAS原子成功；失败不release并进入typed abandonment/finalization |
| M3 → M4 settlement publication | ordered tool/reasoning/terminal facts | source checkpoint与reload boundary | 已drain并等待登记工具 | durable facts可按raw sequence重建 |
| M4 → M5 snapshot read | transaction-consistent authority/materializations | `DurableRecoverySnapshot` | 不从public projection补字段 | 不混入planned/current config事实 |
| M6/M5 candidate selection → M7/M2 | fresh snapshot与至多一个pure candidate action/context | exact action-specific lowering/paused preparation或typed unavailable | 不把candidate selection当最终安全分类；上一handle已cancel | 不自行切换action；输出与该candidate一一对应 |
| M2/M7 → M5 planning | exact paused materialization、closure或typed unavailable | classifier输入 | handle未release且ownership有效 | target/digests/proof/closure对应同一request |
| Admission planner → M5 | next context、expected head、normalizedN/M与policy digest | `AdmissionPlan` | sequence与policy可重查 | 不自行修改authority |
| M5 → M6 proposal | action、reasons、binding commitment | pending proposal | 不把proposal当record | durable decision commit前无dispatch authority |
| M6 → M4 automatic composite admission | automatic proposal、stable operationID、expected predecessors、source/control versions | consumed authoritative record与`RecoveryAdmissionReceipt` | transaction内重读所有mutable事实；不得先持久化active record | revision、三heads、child、ledger、consumption全有或全无；commit response丢失可按operationID查询原receipt |
| M6 → M2 release/cancel | immutable matchingreceipt或cancel cause | stream或closed handle | 不替换request、不重复release | mismatch拒绝；cancel后provider hits为0 |
| M7 → M2 prepared request | canonical Legacy-loweredbody与closure digest inputs | exactgate-bound request | protocol/storage proof完整 | actual send与authorized representation一致 |
| M4 → M8 projection | rebuildable safe display facts | Legacy message/session signal | 不请求authority字段 | internal `session.recovery.*`永不泄漏 |

## 8. 端到端流程

### 8.1 Initial/ordinary Legacy dispatch

1. M6校验normalized`M`与expected model-chain predecessor并预分配无authority的candidate context：initial使用explicit genesis（chainID绑定candidate、sequence 0、head必须不存在）；ordinary保持recovery ordinal并递增assistant sequence。此时尚无assistant/message/head或budget commit。
2. M7以candidate context构造canonical Legacy request body；M2 prepare最终paused request并解析exact target/authority/storage，形成available或opaque evidence。prepare失败只cancel，无durable assistant。
3. M6/M2/M4提交单一composite admission-dispatch operation：原子写assistant/message relation、`assistant_chain_head`、ordinal-0 ledger、`dispatch_ledger_head`与M admission。任一event/projector/CAS失败全部回滚且不release。
4. matching available/opaque receipt授权同一handle后M2 release；M3消费stream。opaque只允许initial/ordinary，其incomplete固定ManualStop。
5. 若同一invocation需要后续model step/resend，必须先按immediate ordinal提交后续dispatch evidence；commit失败时不release，并durable finalize该已admitted assistant为typed pre-dispatch abandonment/error，re-entry不得留下无ledger/无terminal悬挂attempt。
6. 若成功，维持现有Legacy success/ordinary continuation语义；若typed incomplete，进入terminal settlement。

### 8.2 `SafeRetry`

1. M3等待settlement，提交typed terminal并reload snapshot。
2. M6预分配exact incomplete child context；M7先从failed assistant之前构造canonical SafeRetry body。
3. M2在该最终lowered body经过所有transform后prepare paused candidate，计算semantic/prepared digest；semantic digest必须等于source。introspection或gate不可用时返回typed unavailable并cancel，不创建child。
4. M5验证唯一dispatch、双replay fence、零tool evidence、exact source/control versions、N/M与binding，生成proposal。
5. M6/M4以单一automatic composite transaction直接创建consumed revision，并原子提交三heads CAS、child、ordinal-0 ledger与consumption；不存在active-without-child中间态。
6. matchingreceipt授权同一handle release；新assistant独立成功或再次terminal。

### 8.3 `ContinueAfterSettledTools`

1. terminal settlement确认每个tool input/call durable、execution kind已知且completed/error，无interruption/uncertainty。
2. M7按target protocol构造最小closure并验证reasoning provenance、Anthropic/OpenAI storage与model compatibility。
3. M2绑定provider no-side-effects或durable-prefix continuation proof，以及exact prepared digest。
4. M5验证三处prefix、closure、local gate、N/M与binding，生成Continue proposal。
5. automatic composite admission与release同SafeRetry；settled tool只进入history，不进入execution queue。

### 8.4 `ManualStop`

1. 任一source/planning/proof/tool/closure/admission条件失败，M5按canonical order生成reasons。
2. M6将ManualStop revision append并finalize；若持久化失败，至少当前进程停止。
3. paused handle先cancel再cleanup；provider recovery hits为0。
4. public transcript保留原UnknownError和可选safe decision projection，不创建child。

### 8.5 Re-entry、supersession 与 crash

1. re-entry从raw authority/materializations校验latest effective revision、child、consumption与三heads。
2. 若automatic composite transaction尚未commit，只有无authority的planning/proposal，可从fresh snapshot重新prepare；若已commit，则decision必为consumed且唯一child存在，terminal child只观察/分类。
3. composite commit响应丢失但同进程live ownership与同一never-released prepared handle仍可证明时，可按operationID取回receipt后单次release；已调用release的状态未知时只能attach/settle既有child。同进程live ownership可attach nonterminal child；跨进程、旧handle丢失或ownership丢失均finalize ambiguity。
4. new user input与automatic composite transaction通过同一`recovery_head` predecessor竞争：new input先赢时append finalized `ManualStop(["superseded-by-new-user-input"])`后创建新chain；automatic先赢时唯一child已consumed，new input读取winner并走steering/queue，不自行分叉。

### 8.6 Shell 与 experimental native Legacy transport

- Shell synthetic assistant位于model recovery chain之外，不分配`assistantSequence`、不推进`assistant_chain_head`且不消耗`M`；它仍按既有公开transcript/history语义可见，但不进入provider incomplete classifier，也不得被选择为recovery source或Continue tool closure。后续独立prompt/command始终创建新model chain；history lowering可以读取此前公开transcript，但这不表示延续旧recovery chain。当前route scenario只证明handler/message/tool-part wiring；`prompt → shell → prompt/incomplete`、side effect一次、sync与不重放必须作为future回归验收。
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

M3把runtime observation转成durable typed facts；M4使这些facts成为唯一可重放authority。M2/M7针对一个仍暂停的exact request提供current planning，而M5在不产生副作用的前提下组合source、plan与admission。M6只有在M4原子接受proposal并返回matchingreceipt后才让M2 release。因而：

```text
Durable source
∧ Exact paused plan
∧ Conservative proposal
∧ Atomic admission/consumption
∧ Matching receipt
⇒ Authorized single release for a new assistant
```

任一合取项缺失都走cancel/ManualStop，不能以public projection、内存状态或当前配置补证。M4必须在core notification或每个public/shared publication边界默认拒绝internal transitions，M8只接收安全projection；只有这些逐通道过滤与泄漏验收成立时，authority才不会经产品surface泄漏。

### 9.3 关键假设

- H1：单个Session aggregate的raw event sequence可在SQLite transaction内全序追加；本文不处理多主写入。
- H2：transport gate确实位于所有request语义变换之后、network I/O之前；未满足的adapter必须opaque/fallback/disable。
- H3：provider idempotency/continuation能力只在adapter有明确、可测试contract时声明；缺证明等于unknown。
- H4：M4 sealed-store实现满足scope、rotation、cascade、redaction与plaintext lifetime合同；任一条件不可验证时对应proof unavailable。
- H5：Legacy runtime能识别当前runner ownership；无法识别时按ownership lost处理。
- H6：public optional projection必须通过frozen OpenAPI/generated SDK/旧client decode与HTTP/SSE JSON泄漏测试证明可向后兼容；若不能，必须另做versioned/breaking-change决策。
- H7：Native V2只消费shared兼容contract，不消费internal Legacy recovery transitions。

### 9.4 跨模块 invariants 与 preservation

| ID | Invariant | Preservation |
|---|---|---|
| I1 | incomplete原attempt始终保留terminal error | M3写terminal；M6只建child；M8不覆盖source |
| I2 | network release前存在matching durable ledger authority | M2暂停；M4 commit；M6 receipt；M2匹配后release |
| I3 | local tool side effect前call已durable | M3 execution gate；M4 commit失败则不execute |
| I4 | raw events是唯一authority | M4 projector/rebuilder单向materialize；M5/M6拒绝projection authority |
| I5 | decision、model assistant、dispatch无分叉且不存在admitted-without-initial-ledger状态 | M4三heads与unique constraints；initial/ordinary composite原子admit assistant+ordinal-0 ledger；M6只接受immediate successor |
| I6 | source/planned/admission互不污染 | M1 schema分离；M4 snapshot不含current plan；M5只组合不回写 |
| I7 | internal authority不公开 | M4 internal publication suppression；M8只投影safe fields |
| I8 | partial/forced content不进入成功上下文 | M7 lowering与provenance validator；M6 reset attempt-local state |
| I9 | budget有界 | M5 proposal检查；M6 transaction重查；M4 CAS后才admit |
| I10 | stale/unknown永不自动release | M5 fail closed；M6 cancel；M2 linear handle拒绝mismatch |

### 9.5 Failure matrix

| Failure point | Durable result | Provider/tool result | Required outcome |
|---|---|---|---|
| initial/ordinary prepare失败 | 无assistant/admission/ledger/head变化 | provider hit 0 | cancel/return typed failure |
| initial/ordinary composite commit失败 | assistant、M admission、ledger与heads全无 | provider hit 0 | cancel/stop |
| admitted assistant的后续dispatch evidence commit失败 | 既有assistant保留，失败ordinal未写 | provider hit 0 | durable pre-dispatch abandonment/error；re-entry不得发送该ordinal |
| local tool call commit失败 | 无durable call | side effect 0 | terminal failure/stop |
| settlement或terminal commit失败 | source不完整 | no recovery hit | 当前进程stop |
| snapshot corrupt/mismatch | authority不可证明 | no recovery hit | ordered ManualStop或stop |
| planning/closure typed unavailable | source不变 | paused provider hit 0 | finalized ManualStop |
| proposal后request/policy变化 | old binding stale；proposal仍无authority | paused provider hit 0 | cancel并从fresh snapshot重新plan；只有后续真正commit的record才分配/递增revision |
| 任一head CAS失败 | composite transaction全回滚 | provider hit 0 | 读取winner/replan或ManualStop |
| child/ledger/consumption事务失败 | 全回滚 | provider hit 0 | cancel/stop |
| receipt/handle mismatch | committed child存在但未release | provider hit 0 | fail closed；re-entry按ambiguity规则 |
| release后stream断裂 | child dispatch可能已发生 | outcome未知 | settle child；crash时不重复release |
| projector/materialization被篡改 | raw authority仍在或冲突 | no automatic dispatch | rebuilder恢复或fail closed |
| public projection被篡改 | authority不变 | 无授权效果 | 下次rebuild覆盖；不得驱动classifier |
| new input与automatic composite竞争 | 同一recovery-head predecessor只允许一个事务成功 | winner决定后续 | new-input winner先finalize再开新chain；automatic winner已有consumed child，loser读取winner且不分叉 |

### 9.6 Main theorem

**Safety theorem：**在H1–H7成立且M1–M8满足其Requires/Ensures时，任何由Issue #7 automatic recovery触发的provider release都对应一个新的、唯一的assistant child；其source terminal、唯一dispatch evidence、provider/local replay proof、planned request、closure、`N`/`M` admission、decision consumption与三heads更新已由同一binding和raw-event-backed transaction确认。否则系统不会执行automatic release。

证明分解：

1. I2与I3保证provider/local副作用前durable fence成立。
2. I4与I6保证classifier读取的source不是current config或public projection伪造。
3. M5的保守predicate保证unknown、矛盾、未结算与过期状态不产生automatic proposal。
4. I5与I9保证即使并发/re-entry，最多一个immediate child被admit且预算不超限。
5. receipt/handle matching保证committed request与released request不可拆配。
6. I1、I8与M7保证旧failure和partial内容不会被伪装为新成功。

该定理不扩展到release之后的任意provider crash exactly-once。

## 10. 关键设计决策

1. Recovery独立于generic transport retry；canonical incomplete继续`retryable:false`。
2. exact planning、durable authorization与network release机械分离。
3. raw internal recovery transitions是sole authority；SQL relations与projections均可重建。
4. 三heads分别解决decision revision、assistant successor与dispatch ordinal竞争，不合并成含糊单head。
5. selector/classifier纯且proposal-only；CAS-dependent identity只能由ManualStop/finalization commit或automatic composite admission分配。
6. source snapshot、planned materialization、AdmissionPlan、record与public projection分别建模。
7. semantic/prepared/binding digest承担不同proof obligation，不用一个hash替代全部等价关系。
8. Legacy local tools采用中央durable-before-execute gate；不接受“未观察到part”等价于“未执行”。
9. Continue使用provider-specific最小closure；不保留整个errored assistant，也不无条件删除所有reasoning。
10. public error保持`UnknownError`；typed terminal先作为internal durable contract。
11. internal `session.recovery.*`不进入public event bus；只发布安全projection。
12. Native V2不进入normative recovery设计，但shared schema/event变化必须通过其regression。
13. `N`与`M`独立，且都不声称限制physical provider requests。
14. crash ambiguity优先于自动重放；系统明确选择at-most-one-authorized-child，而非伪造exactly-once。

## 11. 后续详细设计与四个非 V2 子计划

本文评审通过后，先产出函数级 `detailed-design.md`，逐模块给出签名、分支、错误处理、transaction边界、correctness argument与可执行验收；本文不提前定义这些细节。

建议四个全局唯一子计划均只覆盖Legacy/shared compatibility，不建立V2 recovery子计划：

1. **`sessrec-1-contract-canonicalization`**：M1；typed classification、identity、target/domain、sealed refs、event sets、terminal/decision schema与三类digest canonicalizers。
2. **`sessrec-2-durable-authority`**：M4；raw event operations、SQLite migrations/materializations、projector、three-head commit、replay rebuilder与internal publication suppression。
3. **`sessrec-3-legacy-runtime-recovery`**：M2/M3/M5/M6；paused transport gate、dispatch ledger、durable tool execution、typed settlement、classifier、N/M、revision/supersession/re-entry与coordinator。
4. **`sessrec-4-legacy-lowering-public-contract`**：M7/M8；Anthropic/OpenAI closure、public unprefixed operations、UnknownError/optional projections、OpenAPI/generated SDK/TUI/CLI/child compatibility与shell N/A。

每个子计划必须先生成contract-audit expectations；future tests只在相应实现存在后创建与执行。Native V2仅列为shared regression consumer，不得出现V2 recovery expectations、flows、tests或spec changes。

## 12. 仍待选择的实施项

以下是真正需要在详细设计前选定、且本文不能从现有证据唯一推出的选择：

1. **首批available adapters**：哪些provider/protocol/Legacy transport能提供最终transform后的exact paused gate、完整target/authority和runtime proof；其余明确opaque/fallback/disable。
2. **Outer retry策略**：首次semantic dispatch后禁用outer resend，或完整实现逐dispatch ledger并规定只有唯一dispatch source可automatic。两者都必须保持canonical incomplete不进入generic retry。
3. **Legacy tool begin/start API形态**：选择processor-owned gate与AI SDK tool wrapper之间的具体ownership/ack机制；架构结果固定为durable call commit成功后才能execute。
4. **`N`/`M`配置合同**：配置入口、默认值、非法值规范化、兼容策略及与现有max-step prompt的集成；不得把建议值写成已批准固定合同。
5. **首批Continue allowlist**：Anthropic server-tool kinds、OpenAI `store=false` stateless reasoning/hosted kinds中哪些有actual audited Legacy lowerer支持；未选或未证明者统一typed unavailable。

UI无需在本阶段选择新的折叠样式：合同固定为旧error可见、新child独立、ManualStop不建child、busy/idle/order正确。若未来改变public discriminator或隐藏旧attempt，必须单独做wire/UX决策。

## Appendix A. 分布式边界七维合同

本文虽不设计cluster ownership，但provider stream、public HTTP与cross-process replay涉及分布式边界；不适用项也显式说明。

### A.1 连接模型

- Provider：连接模型由现有provider SDK/HTTP transport决定，可能是每请求短连接或内部连接池复用；Issue #7不新增或假定特定pool。逻辑request lifetime从matching receipt后的release开始，到normal terminal、transport failure、caller interruption或transport cleanup结束；关闭只释放client-side stream/connection资源，不证明provider回滚side effect或session state。prepare阶段不得建立会触发request发送的连接语义。
- Public Legacy HTTP：沿用现有server listener与client transport的连接复用/关闭策略。generated SDK的unprefixed prompt path有B级live HTTP运行证据；TUI使用unprefixed operations是S级源码接缝事实，当前没有production submission E2E。Issue #7不改变keep-alive/pool合同；client断开只终止该HTTP observation，不删除durable Session或回滚已授权provider request。
- Internal recovery authority：SQLite本地事务，无远程连接；transaction结束后释放本地DB资源，不改变已提交raw authority。
- 重连：provider stream断开不自动重放semantic dispatch；进入typed settlement/recovery。跨进程re-entry重新prepare，不能恢复旧内存handle。

### A.2 超时与 deadline

- 本文不新增connect/read/write/global deadline；沿用现有transport行为。
- timeout若无法证明request未发送，dispatch状态为unknown，不能转成SafeRetry证据。
- paused handle在ownership丢失或pre-release exception时必须cancel；cleanup timeout不能升级为release许可。
- 通用timeout/watchdog重构为N/A，原因是超出Issue #7范围。

### A.3 重试与幂等

- Canonical incomplete不由generic retry处理。
- Automatic SafeRetry的“重试方”是Legacy recovery coordinator，并创建新assistant；incomplete recovery本身不采用transport-style backoff/jitter，最大次数由durable `N` admission决定。
- Provider/SDK内层retry的最大次数、backoff与jitter：Issue #7不新增通用合同。S级源码检查显示，当前audited normal Legacy prompt invocation未传`retries`，`llm.ts`因而向AI SDK传入`maxRetries=0`；C级TCP 429/503 tests仅直接观察到covered fixtures的总provider calls为2及相应outer retry行为。二者都不得外推到所有adapter、transport或Legacy invocation。若dispatch proof不能枚举并覆盖全部physical requests，则provider fence为unknown。
- Legacy outer `SessionRetry.policy()`的最大次数、backoff与jitter：保持既有generic retry policy，不由本文重新定义；详细设计必须选择首次dispatch后禁用outer resend，或把每次resend记录为独立semantic dispatch。无论哪种选择，多个ledger entries的incomplete source都ManualStop。
- Provider idempotency只有在完整semantic-attempt scope、domain与sealed reference均有明确contract时成立；否则unknown。
- `N`限制recovery child，不限制physical request。

### A.4 交付与顺序语义

- raw recovery transitions按Session aggregate sequence全序、transactional append；accepted same-event replay幂等。
- public safe projection通过现有live event通道只是best-effort notification，不承诺断线期间at-least-once delivery；权威的用户可见恢复依赖HTTP transcript/session hydration与reconciliation。消费者不得把信号次数或是否收到单次event当authority。若未来需要cursor/ack/`Last-Event-ID` replay，必须单独设计。
- provider dispatch不承诺exactly-once；commit-before-release保证每个authorized child至多一次本地release调用，但网络边界仍可能结果未知。
- Tool side effect通过durable-before-execute建立happens-before。

### A.5 失败模式

- 假设本地进程、SQLite或provider为fail-stop/omission；不处理Byzantine provider或被攻破storage。
- 网络分区、slow response或stream truncation表现为typed/error/unknown settlement，不能从silence证明安全。
- SQLite/projector/CAS失败对当前进程可见并阻止release。
- Split-brain ownership为N/A：本文不支持clustered Session；若未来引入，必须新增lease/consensus设计。

### A.6 状态与会话

- Recovery是有状态协议，以session ID、chain ID、assistant ID、decision ID/revision与dispatch ordinal关联。
- raw `EventTable`保存authority；sealed material通过opaque reference关联，不保存raw value。
- 新连接/新进程可从raw events重建materializations，但不能恢复旧paused handle，也不能凭任何旧record直接发送；automatic record若存在已经consumed并关联唯一child。
- session删除按现有cascade删除aggregate与materializations。

### A.7 背压与流控

- Provider stream沿用现有consumer/backpressure机制；本文不新增buffer size合同。
- Tool settlement未完成时terminal classification等待，不通过丢弃evidence缓解背压。
- Internal replay在完整prefix/head finalization前suppress live publication，避免半重建状态冲击subscriber。
- Queue capacity与overflow policy为N/A：本文不引入新的跨进程消息队列；若现有TUI sync拥塞，只能影响display freshness，不能影响authority或dispatch admission。
