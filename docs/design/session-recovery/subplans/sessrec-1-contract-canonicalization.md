# 细化设计 — Session Recovery / `sessrec-1-contract-canonicalization`

> 子计划 owner：M1 Shared Recovery Contracts and Canonical Semantics。
>
> 权威输入：当前approved `docs/design/session-recovery/architecture.md`、`detailed-design.md`与owner子计划集合。原stable snapshot的fresh independent design audit达到`0 P0 / 0 P1`，用户批准与四份Step 0 expectations均已完成。本文不得改变 G1–G12、M1–M8、I1–I13、三个recovery heads plus aggregate event head/cursor、raw-event sole authority、mechanical gate、Legacy-only 或 public/internal 隔离。
>
> 状态：D0 package-ownership correction已随`085698426f466b6fc01215c4cb34d89b73ef8290`推送，M1-A scalar/nominal foundation已随`deb84e90a9051511db3c9ca69f52cacdaf45af2e`推送。当前changeset实现F1 exact `Event.define`、F2 `partitionDefinitionsByPublication`、public manifest source partition与97个production/core caller迁移；F3–F31、LLM canonical registry/builders、recovery event set、future acceptance与Step 5 audit尚未完成。

## 1. 范围

### 1.1 本子计划唯一拥有的合同

本文是下列名词、wire/durable field set、canonical membership 与函数规约的唯一完整 owner；其它子计划只能引用，不得复制后另行改义：

1. identity：`RecoveryLineage`、`AssistantAttemptIdentity`、`DispatchAttemptContext`；
2. provider identity：`DispatchTarget`、`ProviderSafetyDomain`、`StorageMode`（`true` / `false` / `unknown`）；
3. secret-safe reference：`SealedRecoveryMaterialRef`；
4. dispatch evidence：available / opaque、replay fence、capability、authorization commitment；
5. tool / reasoning provenance、durable execution phase、reconstructible Continue replay payload 与tool authority partition；
6. `RecoverySourceVersion`、`RecoveryControlTailVersion`、provider-prefix、durable-continuation checkpoint 与sealed-use lease shared key input（lease/proof仍由M4拥有）；
7. `DurableRecoverySnapshot`、`RecoveryAssistantPublicMappingV1`、`PlannedRecoveryMaterialization`、`AdmissionPlan` 与 N/M policy；
8. proposal、durable record、available/opaque/recovery receipts；
9. optional versioned public projection、public allowlist，以及public event definition/committed event/cursor/listener/subscription/read-error/service/manifest nominal surfaces；
10. internal recovery Event definition、source/control event sets、operation envelope与trusted private all-durable replay set；
11. semantic / prepared / binding 三类 digest envelope 与 canonical encoding；
12. old-row / unknown-version fail-closed decode；
13. 24 个 canonical `ManualStopReason`、typed cause → reason 穷尽映射与稳定排序去重；
14. `assembleEventManifests`的唯一规范性合同，包括public-only brand construction与separate trusted private replay semantics。cause→`ManualStopReason` mapping与manifest assembly均只能在本文定义，architecture及其它子计划只引用，不复制第二份mapping/assembly规则。

预定生产影响范围：

- `packages/schema/src/llm.ts`
- `packages/schema/src/event.ts`
- `packages/schema/src/event-manifest.ts`
- `packages/schema/src/durable-event-manifest.ts`
- `packages/schema/src/v1/session.ts`
- `packages/schema/src/session-message.ts`（仅 current shared assistant projection consumer；若实施最终只扩展 Legacy V1，则保留兼容导出而不复制定义）
- `packages/schema/src/index.ts`
- `packages/llm/src/schema/{ids,events,messages,options,index}.ts`
- M1 新增源码文件应优先位于已有 `packages/llm/src/schema/` 或 `packages/schema/src/`；本文不预先批准跨 package 的第二套同义 union。
- Package partition为normative：schema拥有wire/event codecs、F1–F4 raw definition construction与F31 manifests；LLM拥有25-domain canonical registry、E1 enrichment与依赖enriched registry/canonical digest的F5–F7。任何跨边界shared type只能由schema向LLM单向导入，不得让schema source/test反向import LLM。

架构映射：M1 主责 G7、G8、G10 的共享合同基础，协作 G1–G6、G9、G11、G12；直接维护 I4、I6、I7、I10 的类型边界，并向 M2/M3/M4/M5/M6/M7/M8 提供单一 schema。

### 1.2 非范围与后续 owner

- M2：paused handle 的具体 class、provider adapter、authorize/release/cancel I/O。
- M3：tool gate 的 durable transaction 与实际执行、terminal settlement runtime。
- M4：EventTable migration、operation transaction、projector、three-head CAS、sealed store/nominal sealed-use lease 实现、snapshot-bound automatic proof、rebuilder 与 runtime publication suppression。
- M5：candidate selector/classifier predicate；M1 只拥有输入输出类型、cause mapping、reason order。
- M6：N/M admission 执行、decision/child commit、supersession/re-entry。
- M7：Anthropic/OpenAI closure 的协议细节；M1 只定义 provenance、closure descriptor 与 digest membership。
- M8：HTTP/SDK/CLI/TUI 行为；M1 只定义 public projection allowlist 与 shared codec。
- 不设计 Native V2 recovery flow；Native V2 仅是 shared-schema/publication regression consumer。
- D0不创建或运行测试，不新建audit-report/decisions/devlog，不修改migration/OpenAPI/generated SDK；仅在owner合同先修正后同步既有SESSREC-1 expectations，且不得回填future实现位置或通过状态。

### 1.3 证据边界

| 等级 | 本文允许的表述 |
|---|---|
| 当前 A/B/C/D | 此前架构基线记录 source-equivalent `135f20215`、Bun `1.3.14` 上 scoped checks 精确为 A=10、B=1、C=10（7 个 prompt + 3 个 TCP processor）、D=29（2 个 synthetic processor + 1 个 retry + 22 个 TUI + 4 个 routes），总计 50/50；该数字只证明各测试直接断言的当前行为，不证明本文 future contract，也不构成当前修订批准。 |
| 当前 S / partial implementation | `Event.Definition`现含frozen `type/publication/durable/data` metadata；F1 exact result、F2 owner-identity partition与现有public manifest source partition已实现并有runtime/type/core evidence。Durable row仍通过versioned type lookup和Effect Schema decode；Legacy `providerExecuted`、reasoning metadata与public assistant schema仍只是可扩展接缝。 |
| Future F | Recovery-specific types/definitions（含tool partition/phase、reconstructible carrier、sealed-use lease input与新增owner exports）、F3/F4/F31、strict field-set、canonical builders/digest、old-row decode、N/M policy、projection allowlist及其future acceptance仍为 `[F — planned; not created; not run]`。 |

### 1.4 跨子计划依赖方向与 authority 单向性

固定依赖主链为：

```text
M1 contracts
  → M4 raw authority / snapshot / receipts
  → M7 action-specific lowering / closure
  → M2 final no-send preparation / gate
  → M5 pure classifier proposal
  → M6 atomic admission / receipt-driven release
  → M8 safe public projection only
```

M3作为source-fact生产者把durable tool/reasoning/terminal evidence写给M4，不改变上述主链：M3不得直接构造M5 proposal或M2 receipt。单向性规则：

1. M1只定义可编码合同，不产生runtime authority。
2. M4只从raw internal operations构造snapshot/receipt；不得读取M8 projection。
3. M7只读取M4 snapshot与M1 types，输出lowering/closure descriptor；不release、不持久化decision。
4. M2只在M7 lowering之后完成final transform与paused preparation；其available materialization仍不是authority。
5. M5只输出proposal；**proposal永不成为authority**，不能授权release、分配decision revision或创建child。
6. M6只有取得并验证M4 automatic composite完整`OperationCommitResultV1<"automatic-child-admitted-and-consumed">`的receipt+operationPostState后才能调用M2 authorize/release；detached receipt永不授权。
7. 只有M4 projector/rebuilder可持有authority view并调用F28；M4在publication前用F29验证。M8只接收already-safe public projection并调用F30/F29 decode/assert，绝不调用F28；M8不得读取snapshot、record、receipt、digest、head或internal event，也不得扩展public字段。public projection的精确字段、omission/nullability与unknown枚举规则只由M1 §4.7.4/F28–F30拥有。

## 2. 与已有代码的复用点

| 现有项 | `[S — source seam only]` fact | 复用方式 | 禁止外推 |
|---|---|---|---|
| `packages/schema/src/event.ts` | `define/inventory/latest/versionedType/durable` 已集中定义 Event schema 与 manifest helper。 | 扩展 `Definition` 和 `define()` 以携带 source-level `publication`；新增按 publication 分区 helper；保留现有 durable version key 规则。 | 不能把当前所有 definition 都进入 public manifest 的行为保留给 internal recovery event。 |
| `packages/schema/src/event-manifest.ts` | 当前 `ServerDefinitions`、`Definitions` 为显式 inventory。 | 改为从 `AllDefinitions` 按 `publication` 构造 public inventories；internal 只保留在 durable/internal registry。 | 不能只在 `GlobalBus` 或 `EventV2Bridge` 过滤。 |
| `packages/schema/src/durable-event-manifest.ts` | durable registry 以 `${type}.${version}` 为 key。 | internal recovery durable definitions必须进入 raw durable registry，供 M4 replay/read 使用。 | durable 可读不等于可公开。 |
| `packages/schema/src/llm.ts` | 已是 schema package 对 LLM shared types 的单一入口。 | 承载跨 llm/core/opencode 的 recovery wire-safe schema、enums、field-set constants。 | 不放 raw secret、runtime handle 或 provider client object。 |
| `packages/llm/src/schema/*` | 已有 protocol/route/provider/model IDs、message/tool/reasoning/provider metadata。 | 复用 ID 基础与 typed message shapes；增加 M1 canonical/runtime-only generic wrappers，不复制 provider protocol lowerer。 | 任意 `ProviderMetadata` 不能自动成为 recovery proof。 |
| `packages/schema/src/v1/session.ts` | Legacy assistant、tool states、`providerExecuted?: boolean`、reasoning metadata、`UnknownError` 已存在。 | 添加 optional versioned display-only projection；old rows通过 M1 compatibility decoder投影 unknown。 | 缺失 `providerExecuted` 不能按 false；旧 metadata 不能推断 signature/continuation。 |
| `packages/schema/src/session-message.ts` | current shared assistant也有 optional provider fields。 | 只作为 shared compatibility consumer；若需公开 projection，只引用versioned `RecoveryPublicProjectionV1`。 | 不建立 Native V2 recovery authority，也不导出无版本alias。 |
| `Schema.Struct` / `Schema.decodeUnknown*` | 当前广泛用于 decode。 | 类型 decode 后仍必须调用 M1 exact field-set validator；authority decode不得依赖默认的 extra-field 行为。 | “Schema decode 成功”不等于 authority field set exact。 |
| `crypto.subtle.digest("SHA-256", ...)` / core `Hash.sha256` | 仓库已有 SHA-256 使用接缝。 | canonical bytes 与 digest envelope 由 M1 固定；不同 runtime 可使用等价 SHA-256 primitive。 | 不允许各 package 自行定义不同 canonical JSON。 |
| `ConfigV1.Info.experimental`、`ConfigAgentV1.Info.steps` | experimental object与 positive integer `steps` 已有 schema 接缝。 | 新增 strict safe-integer N/M 配置字段；policy normalize 复用 agent steps 输入。 | 当前 `PositiveInt` 只证明 integer/positive codec意图，不自动证明 safe integer。 |

## 3. 错误处理策略

### 3.1 错误模型

M1 schema/codec/canonical pure函数统一使用唯一carrier `ContractResult<A,E>`；`E`必须是§5.0.1逐export冻结的精确error子union。不得在同一层同时暴露`Result`与Effect两套签名，也不得以`undefined`同时表示absent、unknown与malformed。调用方若位于Effect runtime，只能在边界把该exact `ContractResult`一次性lift为runtime既有Effect，不能扩大/缩小error union或另造M1 carrier。

```ts
export type ConfigCodecError = Readonly<{
  kind:"config-codec"
  issue:"wrong-type"|"unsafe-integer"|"negative"|"zero-not-allowed"|"unknown-field"
  path:string
}>
export type EventDefinitionError = Readonly<{
  kind:"event-definition"
  issue:"invalid-type"|"invalid-publication"|"invalid-durable-version"|"aggregate-field-missing"|"schema-construction-failed"|"duplicate-type"|"duplicate-versioned-type"|"public-internal-leak"
  path:string
}>
export type RecoveryDecodeError = Readonly<{
  kind:"recovery-decode"
  issue:"malformed"|"unknown-event-type"|"unknown-event-version"|"unknown-field-set-version"|"discriminator-mismatch"|"not-recovery-event"|"aggregate-mismatch"|"sequence-mismatch"|"chain-broken"|"owner-mismatch"|"inconsistent-evidence"
  path:string
}>
export type FieldSetError = Readonly<{
  kind:"field-set"
  issue:"missing"|"extra"|"nullability"|"wrong-set"
  path:string
  field?:string
}>
export type NormalizationError = Readonly<{
  kind:"normalization"
  issue:"target"|"authority"|"storage"|"policy"|"provenance"|"capability"|"sealed-reference"|"receipt"|"identity"|"binding"
  path:string
}>
export type CanonicalizationError = Readonly<{
  kind:"canonicalization"
  issue:"unsupported"|"cycle"|"unsafe-number"|"negative-zero"|"lone-surrogate"|"raw-secret"|"schema-member"|"crypto-failed"
  path:string
}>
export type DigestMismatchError = Readonly<{
  kind:"digest-mismatch"
  issue:"metadata"|"domain"|"brand"|"value"
  domain:CanonicalCommitmentDomainV1
}>
export type PublicProjectionViolation = Readonly<{
  kind:"public-projection"
  issue:"malformed"|"unsupported-field"|"forbidden-key"|"forbidden-shape"|"unsafe-display-id"
  path:string
}>

export type RecoveryContractError =
  | ConfigCodecError
  | EventDefinitionError
  | RecoveryDecodeError
  | FieldSetError
  | NormalizationError
  | CanonicalizationError
  | DigestMismatchError
  | PublicProjectionViolation

export type ContractResult<
  A,
  E extends RecoveryContractError = RecoveryContractError,
> =
  | { readonly ok:true; readonly value:A }
  | { readonly ok:false; readonly error:E }

export type ErrorKinds<K extends RecoveryContractError["kind"]> =
  Extract<RecoveryContractError,{readonly kind:K}>
export type CodecError = ConfigCodecError | FieldSetError
export type DecodeError = RecoveryDecodeError | FieldSetError | DigestMismatchError | CanonicalizationError
export type NormalizationContractError = FieldSetError | NormalizationError | DigestMismatchError | CanonicalizationError
export type CanonicalContractError = FieldSetError | CanonicalizationError
export type DigestContractError = FieldSetError | CanonicalizationError | DigestMismatchError
export type ReceiptValidationError = RecoveryDecodeError | FieldSetError | NormalizationError | DigestMismatchError | CanonicalizationError
export type SealedRefStructuralValidationError = RecoveryDecodeError | FieldSetError | NormalizationError
```

函数标题中的`f(...) -> A`仅是导航标签，不是第二套raw-return API。§5.0.3是唯一完整callable inventory/ledger，规范签名分别由其signature anchor（§4.1.3 builders、§4.6.3 codecs、§4.9 helpers、§5.0.1 numbered F exports）唯一拥有：除F12这个total/trivial纯比较外，F1–F31/F16a、additional E1、policy codecs、25个input builders及三个M1 helper全部返回`ContractResult<A,E>`；每个`E`必须是对应signature anchor写出的精确子union，禁止扩大成裸`RecoveryContractError`、缩成`unknown`，也禁止throwing/Effect/`undefined` overload。标题写`-> void`时仍返回`ContractResult<void,E>`；F28即使投影为空也返回`ContractResult<RecoveryPublicProjectionV1|undefined,PublicProjectionViolation>`，其中`undefined`只表示“无可公开字段”，不是失败。caller位于Effect runtime时只能在边界lift一次并原样保留`E`。§4.5.1a的existing `PublicEventServiceV1`/listener/subscription是保留的runtime Effect/Stream接口，不是M1 pure callable inventory，故继续使用其当前精确Effect error contract。

错误分类：

- `kind:"recovery-decode"`：malformed JSON/object、未知event base type、未知event/field-set/envelope version、discriminator不匹配；
- `kind:"field-set"`：缺required、extra authority field、错误nullability、source/control set混入；
- `kind:"normalization"`：target/domain/storage/policy/provenance无法规范化；
- `kind:"canonicalization"`：unsupported value、cycle、unsafe number/`-0`、lone surrogate、raw secret marker、schema member缺失；
- `kind:"digest-mismatch"`：algorithm/domain/brand/version/value任一不匹配；
- `PublicProjectionViolation`：public projection输入包含禁止字段/shape或不安全child link；unknown结构版本由F30的`unsupported`结果表达，不与malformed混淆。

### 3.2 传播规则

1. authority decode 的 unknown version 永不 downgrade、best-effort 或忽略；M4/M5/M6 必须把它视为 authority invalid，停止 automatic release。
2. old Legacy row 可以成功解码为 typed `unknown`/opaque compatibility evidence，但绝不能升级为 available；“旧数据存在”与“恢复安全可证明”严格分离。
3. planning typed unavailable 通过 `RecoveryFailureCause` 进入 M5；free-form detail仅日志诊断，既不参与 reason stable identity，也不进入 public projection或 canonical digest。
4. canonicalization/digest failure在 pre-release 路径映射为对应 typed cause；不得回退到普通 `JSON.stringify`。
5. public projection violation必须拒绝 publication；不得采用“删除看起来危险的 key 后继续”的黑名单式降级。
6. programmer invariant failure可显式构造 `internal-classification-failure` cause。F23的source/kind switch必须保留compile-time `never` exhaustiveness，但runtime收到空、malformed或未来unknown discriminator时必须total地返回`ok:true`且唯一结果为`["internal-classification-failure"]`；禁止throw、`assertNever`或把unexpected runtime值伪装成已知cause。

### 3.3 24 个 canonical `ManualStopReason`

顺序与 architecture §5.4 完全一致，且只在本文定义一次：

```ts
export const ManualStopReasons = [
  "dispatch-evidence-inconsistent",
  "dispatch-ambiguous",
  "provider-introspection-unavailable",
  "planned-target-unavailable",
  "planned-authority-unavailable",
  "planned-request-materialization-failed",
  "planned-request-digest-failed",
  "planned-runtime-proof-unavailable",
  "provider-replay-unknown",
  "provider-continuation-unavailable",
  "provider-proof-unavailable",
  "recovery-action-inapplicable",
  "local-tool-replay-unknown",
  "open-tool-input",
  "unsettled-tool",
  "interrupted-tool",
  "uncertain-tool-result",
  "dispatch-lowering-unverifiable",
  "continuation-context-unavailable",
  "recovery-binding-stale",
  "recovery-budget-exhausted",
  "same-process-max-step-exhausted",
  "superseded-by-new-user-input",
  "internal-classification-failure",
] as const
export type ManualStopReason = typeof ManualStopReasons[number]
export type NonEmptyReadonlyArray<T> = readonly [T,...T[]]
```

## 4. 数据结构定义

### 4.1 基础值、版本与 canonical commitment

#### 4.1.1 Primitive aliases、brand 与 IDs

```ts
declare const recoveryBrand: unique symbol
export type Brand<Name extends string> = {
  readonly [recoveryBrand]: { readonly [Key in Name]: Key }
}

export type SafeInteger = number & Brand<"SafeInteger">
export type SafeNonNegativeInt = SafeInteger & Brand<"SafeNonNegativeInt">
export type SafePositiveInt = SafeInteger & Brand<"SafePositiveInt">
export type RecoveryChainID = string & Brand<"RecoveryChainID">
export type RecoveryAssistantID = string & Brand<"RecoveryAssistantID">
export type RecoveryDecisionID = string & Brand<"RecoveryDecisionID">
export type RecoveryOperationID = string & Brand<"RecoveryOperationID">
export type RecoveryAggregateID = string & Brand<"RecoveryAggregateID">
export type RecoveryPolicyScopeKey = string & Brand<"RecoveryPolicyScopeKey">
export type RecoverySealedRefID = string & Brand<"RecoverySealedRefID">
export type JsonScalar = null|boolean|SafeInteger|string
export type JsonScalarOrArray = JsonScalar|readonly JsonScalar[]
export type ExactFieldSetSpecification<T> = Readonly<
  | { kind:"literal"; value:null|boolean|string|SafeNonNegativeInt }
  | { kind:"string"; validate:(value:string)=>boolean }
  | { kind:"safe-integer"; minimum?:SafeInteger; maximum?:SafeInteger }
  | { kind:"array"; element:ExactFieldSetSpecification<unknown>; order:"semantic"|"registry-fixed" }
  | { kind:"object"; required:readonly string[]; optional:readonly string[]; fields:Readonly<Record<string,ExactFieldSetSpecification<unknown>>> }
  | { kind:"union"; discriminator:string; branches:Readonly<Record<string,ExactFieldSetSpecification<unknown>>> }
>
```

`Brand<Name>`的mapped key carrier只存在于TypeScript类型层，使`SafePositiveInt`/`SafeNonNegativeInt`在保留`SafeInteger` brand的同时仍彼此不可替换，并使25个commitment brands pairwise non-substitutable。禁止改回单一symbol字段直接存literal `Name`：多个brand相交时该字段会退化为`never`并错误扩大assignability。

ID共同不变量：非空、NFC、无首尾空白、不得包含NUL/control characters；codec只验证并brand现有ID，创建策略由对应owner负责；M1不从display name或timestamp派生authority ID。canonical number **只允许safe integer**：`Number.isSafeInteger(x)`必须为true；拒绝`NaN`、Infinity、float、`-0`与超出`Number.MAX_SAFE_INTEGER`的值。V1不支持decimal，因此不存在跨语言小数格式、指数、舍入或尾零规则。

#### 4.1.2 `CanonicalDigestValue` 与非可替换commitment brands

```ts
export type CanonicalDigestValue = Readonly<{
  version: 1
  algorithm: "sha256"
  encoding: "recovery-canonical-json"
  value: string // /^[0-9a-f]{64}$/
}>

export type Commitment<Name extends string> = CanonicalDigestValue & Brand<Name>
export type SemanticDigest = Commitment<"SemanticDigest">
export type PreparedDigest = Commitment<"PreparedDigest">
export type BindingDigest = Commitment<"BindingDigest">
export type OperationPayloadDigest = Commitment<"OperationPayloadDigest">
export type SupersessionBindingDigest = Commitment<"SupersessionBindingDigest">
export type EventChainDigest = Commitment<"EventChainDigest">
export type SourceFactsDigest = Commitment<"SourceFactsDigest">
export type RecoverySourceVersionDigest = Commitment<"RecoverySourceVersionDigest">
export type RecoveryControlTailDigest = Commitment<"RecoveryControlTailDigest">
export type RecoveryPolicyDigest = Commitment<"RecoveryPolicyDigest">
export type DispatchTargetDigest = Commitment<"DispatchTargetDigest">
export type SealedMaterialCommitment = Commitment<"SealedMaterialCommitment">
export type PausedHandleCommitment = Commitment<"PausedHandleCommitment">
export type RecoveryClosureDigest = Commitment<"RecoveryClosureDigest">
export type SourceAllowedEventSetDigest = Commitment<"SourceAllowedEventSetDigest">
export type ControlAllowedEventSetDigest = Commitment<"ControlAllowedEventSetDigest">
export type CredentialAuthorityVersionDigest = Commitment<"CredentialAuthorityVersionDigest">
export type ProviderAuthorizationProofDigest = Commitment<"ProviderAuthorizationProofDigest">
export type ControlPolicyDigest = Commitment<"ControlPolicyDigest">
export type ToolPlanDigest = Commitment<"ToolPlanDigest">
export type ToolCallDigest = Commitment<"ToolCallDigest">
export type ToolResultDigest = Commitment<"ToolResultDigest">
export type ReasoningTextDigest = Commitment<"ReasoningTextDigest">
export type ProviderPrefixDigest = Commitment<"ProviderPrefixDigest">
export type ProviderPrefixAncestryDigest = Commitment<"ProviderPrefixAncestryDigest">
```

所有commitment只能由§4.1.3的closed registry builder创建；decode后的结构值必须重新验证domain与exact input后才可brand。TypeScript结构兼容不足以授权替换：API不得接受裸`CanonicalDigestValue`代替任一branded输出，也不得以cast在domain间转换。未知version/algorithm/encoding/domain fail closed。

#### 4.1.3 Closed canonical commitment domain registry

registry版本固定为`CanonicalCommitmentRegistryVersion = 1`。registry是封闭的readonly tuple；新增domain、修改字段membership或改变顺序语义必须提升registry/domain input version，不能让caller传任意字符串domain。

```ts
export type CanonicalCommitmentDomainV1 =
  | "semantic-v1" | "prepared-v1" | "binding-v1"
  | "operation-payload-v1" | "supersession-binding-v1" | "event-chain-v1"
  | "source-facts-v1" | "source-version-v1" | "control-tail-v1"
  | "recovery-policy-v1" | "dispatch-target-v1"
  | "sealed-material-v1" | "paused-handle-v1" | "recovery-closure-v1"
  | "credential-authority-version-v1"
  | "provider-authorization-proof-v1" | "control-policy-v1"
  | "tool-plan-v1" | "tool-call-v1" | "tool-result-v1" | "reasoning-text-v1"
  | "provider-prefix-v1" | "provider-prefix-ancestry-v1"
  | "source-allowed-event-set-v1" | "control-allowed-event-set-v1"

export type CanonicalDomainSpec<
  Input,
  Output extends CanonicalDigestValue,
  BuildError extends RecoveryContractError,
> = Readonly<{
  registryVersion:1
  domain:CanonicalCommitmentDomainV1
  inputVersion:1
  exactFieldSet:ExactFieldSetSpecification<Input>
  buildInput:(source:unknown)=>ContractResult<Input,BuildError>
  brandDigest:(digest:CanonicalDigestValue)=>Output
}>

export type InputOf<S> =
  S extends CanonicalDomainSpec<infer I,infer _O,infer _E> ? I : never
export type OutputOf<S> =
  S extends CanonicalDomainSpec<infer _I,infer O,infer _E> ? O : never
export type BuildErrorOf<S> =
  S extends CanonicalDomainSpec<infer _I,infer _O,infer E> ? E : never
```

closed registry的每项exact top-level字段如下；每个引用的nested类型仍按其定义递归exact，optional字段只可omit，不可用`undefined`占位：

| domain | exact input type / exact fields | branded output / builder |
|---|---|---|
| `semantic-v1` | `SemanticDigestInputV1`: `version,target,targetDigest,storageMode,tools,providerOptions,modelOptions,generationOptions,httpOptions,system,history,body` | `SemanticDigest` / `buildSemanticDigestInput` |
| `prepared-v1` | `PreparedDigestInputV1`是`dispatchKind`闭合union：initial/ordinary branch exact为`version,dispatchKind,context,request,semanticDigest,replayFence,capabilities,authorization,pausedHandleCommitment,preparedBodyFormat,preparedBodyVersion`；automatic-recovery branch另且仅另含`sourceVersion,action,closure,closureDigest`。`request`是exact `SemanticDigestInputV1`，因此逐项绑定final target/authority/storage/tools/options/system/history/body；initial/ordinary禁止`RecoverySourceVersion`与recovery closure字段 | `PreparedDigest` / `buildPreparedDigestInput` |
| `binding-v1` | `BindingDigestInputV1`是`kind`闭合union：automatic branch保留`sourceAssistant,sourceVersion/sourceVersionDigest,controlTailVersion/controlTailDigest,candidateContext,action,target/targetDigest,semanticDigest,preparedDigest,authorization,closureDigest,admission,expectedHeads,controlPolicyDigest`；manual-stop branch exact绑定同一source/control versions、candidate/action、ordered canonical lower-level causes/reasons、`planningEvidence`、`closureStatus`、policy quartet/admission、expected heads、control policy与`handleClosure` commitment，且禁止target/semantic/prepared/authorization/closure digest字段 | `BindingDigest` / `buildBindingDigestInput` |
| `operation-payload-v1` | `OperationPayloadDigestInputV1`: `envelopeVersion,operationType,fieldSetVersion,expectedPredecessors,payload` | `OperationPayloadDigest` / `buildOperationPayloadDigestInput` |
| `supersession-binding-v1` | `SupersessionBindingDigestInputV1`闭合union：common exact为`version,kind,sessionID,sourceVersion,sourceVersionDigest,controlTailVersion,controlTailDigest,submissionPayloadDigest,supersessionPredecessors`（heads exact为`aggregateEventHead,recoveryHead`）；model另含`intendedInitialOperationID`，no-reply另含`replyDisposition:"commit-user-only"`。只含durable source/control与O10 pre-prepare facts，不含dispatch、policy、candidate assistant、prepared handle、automatic/manual binding或future完整operation payload | `SupersessionBindingDigest` / `buildSupersessionBindingDigestInput` |
| `event-chain-v1` | `EventChainDigestInputV1`: genesis branch exact `kind,hashVersion,aggregateID`; operation branch exact `kind,hashVersion,aggregateID,aggregateSequence,operationID,operationType,fieldSetVersion,previousDigest,payloadDigest` | `EventChainDigest` / `buildEventChainDigestInput` |
| `source-facts-v1` | `SourceFactsDigestInputV1`: `version,sourceAssistantID,highWater,eventTypeSetVersion,fieldSetRegistryVersion,allowedEventSetDigest,facts` | `SourceFactsDigest` / `buildSourceFactsDigestInput` |
| `source-version-v1` | `RecoverySourceVersionDigestInputV1`: `version,aggregateID,sourceAssistantID,highWater,eventChainHead,factsDigest,eventTypeSetVersion,fieldSetRegistryVersion,allowedEventSetDigest,fieldSets,providerPrefix` | `RecoverySourceVersionDigest` / `buildRecoverySourceVersionDigestInput` |
| `control-tail-v1` | `RecoveryControlTailDigestInputV1`: `version,aggregateID,sourceAssistantID,fromExclusive,toInclusive,eventCount,previousSourceHead,tailHash,emptyTailGenesis,eventTypeSetVersion,fieldSetRegistryVersion,allowedEventSetDigest,fieldSets` | `RecoveryControlTailDigest` / `buildRecoveryControlTailDigestInput` |
| `recovery-policy-v1` | `RecoveryPolicyDigestInputV1`: `version,defaultSemanticsVersion,maxIncompleteRecoveries,configuredMaxModelAssistants,agentSteps,effectiveMaxModelAssistants` | `RecoveryPolicyDigest` / `buildRecoveryPolicyDigestInput` |
| `dispatch-target-v1` | `DispatchTargetDigestInputV1`: `version,providerID,routeID,protocol,endpoint,authority,modelID,modelFamily` | `DispatchTargetDigest` / `buildDispatchTargetDigestInput` |
| `sealed-material-v1` | `SealedMaterialCommitmentInputV1`: `version,purpose,scope,keyID,keyVersion,derivation,keyedValue`；`derivation`固定`"hmac-sha256"`，`keyedValue`为完整32-byte HMAC lowercase hex，plaintext不在input | `SealedMaterialCommitment` / M4 `buildSealedMaterialCommitment` |
| `paused-handle-v1` | `PausedHandleCommitmentInputV1`: `version,context,targetDigest,preparedBodyVersion,keyID,keyVersion,derivation,keyedValue`；同样先对raw handle identity/material执行HMAC，raw handle不在input | `PausedHandleCommitment` / M2 audited builder |
| `recovery-closure-v1` | `RecoveryClosureDigestInputV1`: safe-retry branch exact `version,action`; Continue provider-neutral branch exact `version,action,sourceBinding,toolCalls,reasoning,providerPrefix`，其中tool arguments/result-or-error、reasoning content、prefix content均携reconstructible carrier及owner commitment；final target/storage/capability不在M7 pre-prepare closure digest中 | `RecoveryClosureDigest` / `buildRecoveryClosureDigestInput` |
| `credential-authority-version-v1` | `CredentialAuthorityVersionDigestInputV1`：provider-ID branch exact `version,derivation,providerID,authorityScope,providerVersionID`；HMAC branch exact `version,derivation,providerID,authorityScope,keyID,keyVersion,keyedValue` | `CredentialAuthorityVersionDigest` / `buildCredentialAuthorityVersionDigestInput` |
| `provider-authorization-proof-v1` | `ProviderAuthorizationProofDigestInputV1`: `version,descriptorID,descriptorVersion,targetDigest,storageMode,allowedAction,capabilityDescriptorVersion,replayMode,closureDigest` | `ProviderAuthorizationProofDigest` / `buildProviderAuthorizationProofDigestInput` |
| `control-policy-v1` | `ControlPolicyDigestInputV1`: `version,scopeKey,epoch,policyDigest,defaultSemanticsVersion` | `ControlPolicyDigest` / `buildControlPolicyDigestInput` |
| `tool-plan-v1` | `ToolPlanDigestInputV1`: `version,callID,name,planRevision,executionMode,input`；`input`为exact `RecoveryReplayPayloadCommitmentProjectionV1`，sealed branch只承诺ref/HMAC不含plaintext | `ToolPlanDigest` / `buildToolPlanDigestInput` |
| `tool-call-v1` | `ToolCallDigestInputV1`: `version,callID,name,executionKind,inputState,callObservation,planRevision,finalPlanDigest` | `ToolCallDigest` / `buildToolCallDigestInput` |
| `tool-result-v1` | `ToolResultDigestInputV1`: `version,callID,settlement,interruption,providerExecuted,outcome`；`outcome`为exact `result\|error` closed union并承诺payload projection，sealed plaintext只由keyed material commitment承诺，不以digest替代replay carrier | `ToolResultDigest` / `buildToolResultDigestInput` |
| `reasoning-text-v1` | `ReasoningTextDigestInputV1`: `version,blockID,provenance,continuationMode,protocol,targetDigest,content`；`content`为utf8-text replay projection，sealed reasoning plaintext不进入unkeyed digest | `ReasoningTextDigest` / `buildReasoningTextDigestInput` |
| `provider-prefix-v1` | `ProviderPrefixDigestInputV1`: `version,aggregateID,sessionID,sourceAssistantID,sourceHighWater,hashVersion,protocol,targetDigest,prefix`；`prefix`为canonical-wire replay projection，raw cursor/provider state不进入unkeyed digest | `ProviderPrefixDigest` / `buildProviderPrefixDigestInput` |
| `provider-prefix-ancestry-v1` | `ProviderPrefixAncestryDigestInputV1`：genesis branch exact `version,kind,aggregateID,sessionID,sourceAssistantID,sourceHighWater,hashVersion,prefixDigest`；extension branch另含`previousSourceHighWater,previousAncestryDigest` | `ProviderPrefixAncestryDigest` / `buildProviderPrefixAncestryDigestInput` |
| `source-allowed-event-set-v1` | `AllowedEventSetDigestInputV1`: `version,set:"source",eventTypeSetVersion,fieldSetRegistryVersion,entries` | `SourceAllowedEventSetDigest` / `buildSourceAllowedEventSetDigestInput` |
| `control-allowed-event-set-v1` | 同上但`set:"control"` | `ControlAllowedEventSetDigest` / `buildControlAllowedEventSetDigestInput` |

closed registry精确含25项。下列25个input builder与25个frozen spec是完整、唯一export inventory；builder只验证/构造secret-free exact input，F21才产生brand。不存在generic `buildCommitment(domain:string,...)`、cast builder或未版本化alias。

```ts
export type StandardCanonicalInputError = FieldSetError | CanonicalizationError
export type NormalizedCanonicalInputError = StandardCanonicalInputError | NormalizationError

export function buildSemanticDigestInput(source:SemanticDigestBuildSourceV1):ContractResult<SemanticDigestInputV1,NormalizedCanonicalInputError>
export function buildPreparedDigestInput(source:PreparedDigestBuildSourceV1):ContractResult<PreparedDigestInputV1,NormalizedCanonicalInputError>
export function buildBindingDigestInput(source:BindingDigestBuildSourceV1):ContractResult<BindingDigestInputV1,NormalizedCanonicalInputError>
export function buildOperationPayloadDigestInput<T extends RecoveryOperationType>(source:unknown,operationType:T):ContractResult<OperationPayloadDigestInputV1<T>,StandardCanonicalInputError>
export function buildSupersessionBindingDigestInput(source:unknown):ContractResult<SupersessionBindingDigestInputV1,StandardCanonicalInputError>
export function buildEventChainDigestInput(source:unknown):ContractResult<EventChainDigestInputV1,StandardCanonicalInputError>
export function buildSourceFactsDigestInput(source:unknown):ContractResult<SourceFactsDigestInputV1,StandardCanonicalInputError>
export function buildRecoverySourceVersionDigestInput(source:unknown):ContractResult<RecoverySourceVersionDigestInputV1,StandardCanonicalInputError>
export function buildRecoveryControlTailDigestInput(source:unknown):ContractResult<RecoveryControlTailDigestInputV1,StandardCanonicalInputError>
export function buildRecoveryPolicyDigestInput(source:unknown):ContractResult<RecoveryPolicyDigestInputV1,NormalizedCanonicalInputError>
export function buildDispatchTargetDigestInput(source:unknown):ContractResult<DispatchTargetDigestInputV1,NormalizedCanonicalInputError>
export function buildSealedMaterialCommitmentInput(source:unknown):ContractResult<SealedMaterialCommitmentInputV1,NormalizedCanonicalInputError>
export function buildPausedHandleCommitmentInput(source:unknown):ContractResult<PausedHandleCommitmentInputV1,NormalizedCanonicalInputError>
export function buildRecoveryClosureDigestInput(source:unknown):ContractResult<RecoveryClosureDigestInputV1,NormalizedCanonicalInputError>
export function buildCredentialAuthorityVersionDigestInput(source:unknown):ContractResult<CredentialAuthorityVersionDigestInputV1,NormalizedCanonicalInputError>
export function buildProviderAuthorizationProofDigestInput(source:unknown):ContractResult<ProviderAuthorizationProofDigestInputV1,NormalizedCanonicalInputError>
export function buildControlPolicyDigestInput(source:unknown):ContractResult<ControlPolicyDigestInputV1,StandardCanonicalInputError>
export function buildToolPlanDigestInput(source:unknown):ContractResult<ToolPlanDigestInputV1,NormalizedCanonicalInputError>
export function buildToolCallDigestInput(source:unknown):ContractResult<ToolCallDigestInputV1,NormalizedCanonicalInputError>
export function buildToolResultDigestInput(source:unknown):ContractResult<ToolResultDigestInputV1,NormalizedCanonicalInputError>
export function buildReasoningTextDigestInput(source:unknown):ContractResult<ReasoningTextDigestInputV1,NormalizedCanonicalInputError>
export function buildProviderPrefixDigestInput(source:unknown):ContractResult<ProviderPrefixDigestInputV1,NormalizedCanonicalInputError>
export function buildProviderPrefixAncestryDigestInput(source:unknown):ContractResult<ProviderPrefixAncestryDigestInputV1,NormalizedCanonicalInputError>
export function buildSourceAllowedEventSetDigestInput(source:unknown):ContractResult<AllowedEventSetDigestInputV1 & Readonly<{set:"source"}>,StandardCanonicalInputError>
export function buildControlAllowedEventSetDigestInput(source:unknown):ContractResult<AllowedEventSetDigestInputV1 & Readonly<{set:"control"}>,StandardCanonicalInputError>

export const semanticDigestSpecV1:CanonicalDomainSpec<SemanticDigestInputV1,SemanticDigest,NormalizedCanonicalInputError>
export const preparedDigestSpecV1:CanonicalDomainSpec<PreparedDigestInputV1,PreparedDigest,NormalizedCanonicalInputError>
export const bindingDigestSpecV1:CanonicalDomainSpec<BindingDigestInputV1,BindingDigest,NormalizedCanonicalInputError>
export const operationPayloadDigestSpecV1:CanonicalDomainSpec<OperationPayloadDigestInputV1,OperationPayloadDigest,StandardCanonicalInputError>
export const supersessionBindingDigestSpecV1:CanonicalDomainSpec<SupersessionBindingDigestInputV1,SupersessionBindingDigest,StandardCanonicalInputError>
export const eventChainDigestSpecV1:CanonicalDomainSpec<EventChainDigestInputV1,EventChainDigest,StandardCanonicalInputError>
export const sourceFactsDigestSpecV1:CanonicalDomainSpec<SourceFactsDigestInputV1,SourceFactsDigest,StandardCanonicalInputError>
export const recoverySourceVersionDigestSpecV1:CanonicalDomainSpec<RecoverySourceVersionDigestInputV1,RecoverySourceVersionDigest,StandardCanonicalInputError>
export const recoveryControlTailDigestSpecV1:CanonicalDomainSpec<RecoveryControlTailDigestInputV1,RecoveryControlTailDigest,StandardCanonicalInputError>
export const recoveryPolicyDigestSpecV1:CanonicalDomainSpec<RecoveryPolicyDigestInputV1,RecoveryPolicyDigest,NormalizedCanonicalInputError>
export const dispatchTargetDigestSpecV1:CanonicalDomainSpec<DispatchTargetDigestInputV1,DispatchTargetDigest,NormalizedCanonicalInputError>
export const sealedMaterialCommitmentSpecV1:CanonicalDomainSpec<SealedMaterialCommitmentInputV1,SealedMaterialCommitment,NormalizedCanonicalInputError>
export const pausedHandleCommitmentSpecV1:CanonicalDomainSpec<PausedHandleCommitmentInputV1,PausedHandleCommitment,NormalizedCanonicalInputError>
export const recoveryClosureDigestSpecV1:CanonicalDomainSpec<RecoveryClosureDigestInputV1,RecoveryClosureDigest,NormalizedCanonicalInputError>
export const credentialAuthorityVersionDigestSpecV1:CanonicalDomainSpec<CredentialAuthorityVersionDigestInputV1,CredentialAuthorityVersionDigest,NormalizedCanonicalInputError>
export const providerAuthorizationProofDigestSpecV1:CanonicalDomainSpec<ProviderAuthorizationProofDigestInputV1,ProviderAuthorizationProofDigest,NormalizedCanonicalInputError>
export const controlPolicyDigestSpecV1:CanonicalDomainSpec<ControlPolicyDigestInputV1,ControlPolicyDigest,StandardCanonicalInputError>
export const toolPlanDigestSpecV1:CanonicalDomainSpec<ToolPlanDigestInputV1,ToolPlanDigest,NormalizedCanonicalInputError>
export const toolCallDigestSpecV1:CanonicalDomainSpec<ToolCallDigestInputV1,ToolCallDigest,NormalizedCanonicalInputError>
export const toolResultDigestSpecV1:CanonicalDomainSpec<ToolResultDigestInputV1,ToolResultDigest,NormalizedCanonicalInputError>
export const reasoningTextDigestSpecV1:CanonicalDomainSpec<ReasoningTextDigestInputV1,ReasoningTextDigest,NormalizedCanonicalInputError>
export const providerPrefixDigestSpecV1:CanonicalDomainSpec<ProviderPrefixDigestInputV1,ProviderPrefixDigest,NormalizedCanonicalInputError>
export const providerPrefixAncestryDigestSpecV1:CanonicalDomainSpec<ProviderPrefixAncestryDigestInputV1,ProviderPrefixAncestryDigest,NormalizedCanonicalInputError>
export const sourceAllowedEventSetDigestSpecV1:CanonicalDomainSpec<AllowedEventSetDigestInputV1 & Readonly<{set:"source"}>,SourceAllowedEventSetDigest,StandardCanonicalInputError>
export const controlAllowedEventSetDigestSpecV1:CanonicalDomainSpec<AllowedEventSetDigestInputV1 & Readonly<{set:"control"}>,ControlAllowedEventSetDigest,StandardCanonicalInputError>

export const CanonicalCommitmentRegistryV1:readonly [
  typeof semanticDigestSpecV1,typeof preparedDigestSpecV1,typeof bindingDigestSpecV1,
  typeof operationPayloadDigestSpecV1,typeof supersessionBindingDigestSpecV1,typeof eventChainDigestSpecV1,
  typeof sourceFactsDigestSpecV1,typeof recoverySourceVersionDigestSpecV1,typeof recoveryControlTailDigestSpecV1,
  typeof recoveryPolicyDigestSpecV1,typeof dispatchTargetDigestSpecV1,typeof sealedMaterialCommitmentSpecV1,
  typeof pausedHandleCommitmentSpecV1,typeof recoveryClosureDigestSpecV1,typeof credentialAuthorityVersionDigestSpecV1,
  typeof providerAuthorizationProofDigestSpecV1,typeof controlPolicyDigestSpecV1,typeof toolPlanDigestSpecV1,
  typeof toolCallDigestSpecV1,typeof toolResultDigestSpecV1,typeof reasoningTextDigestSpecV1,
  typeof providerPrefixDigestSpecV1,typeof providerPrefixAncestryDigestSpecV1,
  typeof sourceAllowedEventSetDigestSpecV1,typeof controlAllowedEventSetDigestSpecV1,
]
```

`buildSealedMaterialCommitmentInput`与`buildPausedHandleCommitmentInput`不接收raw material/handle，只接收已经由M4/M2 audited HMAC producer生成的`keyedValue`及key metadata；credential HMAC branch同理。`ProviderAuthorizationCommitment`、control binding、tool/reasoning evidence与`ProviderPrefixCheckpoint`必须先经对应builder，再交F21；decode只能用F22按同一spec重算恢复信任。

##### 4.1.3a 每个canonical input builder的完整函数合同

下列common contract逐个适用于上面25个具名export，不是一个额外generic public callable。

- **exact caller/callee合同**：caller只能是表中owner，并提供该行input facts。B04–B25的callees精确为F4、primitive ID/safe-integer/hex validators及raw-secret sentinel scanner；B01/F18、B02/F19、B03/F20因同时承担normalization/cross-input validation，其附加pure callees以§5.3.2–§5.3.4为准。F4 pre为对应frozen spec、post为recursive exact；primitive validator post为no-coercion branded scalar；scanner post为不存在raw secret marker。全部builder都不调用F21、不产生digest/brand；只有F19/F20可调用F22验证其显式输入commitments，仍不读store。
- **Requires**：source是finite acyclic plain-data value；optional字段以omit表示；owner已在builder外完成任何I/O（HMAC、sealed lookup、provider introspection、raw fold），且只把secret-free facts传入。
- **Ensures**：`ok:true.value`恰为该行V1 input type，字段membership/union branch/order/nullability与registry spec完全一致，且与source中被允许的facts canonical equal；`ok:false.error`只来自该builder签名的exact error union，无partial input。
- **编号连续branches/exits**：B1以spec identity选择唯一具名domain；B2 F4验证top-level与recursive exact set；B3逐primitive refinement；B4执行domain cross-invariants与registry-fixed ordering；B5扫描raw secret/unsupported canonical member；B6 fresh-copy并再次F4；B7 freeze后`ok:true`。E1 field-set、E2 normalization、E3 canonicalization分别在对应步骤`ok:false`；无throw/default-domain/fallback JSON。
- **副作用/残留**：全部25个builder均pure，只分配fresh object/array；不HMAC、不hash、不brand、不查store、不改source、不写log/cache/DB，无durable residue。
- **finite progress/termination**：固定top-level字段加有限nested tree；object/array递归严格进入子值，acyclic pre保证终止；registry-fixed排序扫描有限tuple。
- **§4.3.2 proof**：pre给出finite secret-free source；B1得I1唯一domain；B2得I2 exact structure；B3得I3 scalar ranges；B4得I4 cross-invariants/order；B5得I5 canonical-safe/secret-free；B6得I6 output exact；I1∧…∧I6推出Ensures。所有callee纯且无外部capability，故side-effect/residue post为空且穷尽。

| builder | exact callers | 该builder附加Requires / branch obligation | exact success post |
|---|---|---|---|
| `buildSemanticDigestInput` | M2/M7/F18 | final lowered request；wire order fixed；sealed substitution complete | `SemanticDigestInputV1` |
| `buildPreparedDigestInput` | M2/M7/F19 | dispatchKind与context origin/authorization action exact；三branch均绑定exact final request；仅automatic另绑定source/action/closure；handle paused；provider hits=0 | `PreparedDigestInputV1` |
| `buildBindingDigestInput` | M5/F20 | automatic的snapshot/available planned/admission分离且cross-equal；manual-stop不要求available planned，改以ordered causes/reasons、planning/closure status与M2-validated no-handle/cancel commitment构造 | `BindingDigestInputV1` |
| `buildOperationPayloadDigestInput<T>` | M4/F5 | runtime `operationType===T`且payload/predecessor branch同T | `OperationPayloadDigestInputV1<T>` |
| `buildSupersessionBindingDigestInput` | M4 O10/type-10 fold/O1 | caller在builder外先F22复验source/control；builder自身仍只F4/primitive validation；model/no-reply branch exact；只含pre-prepare facts；不得含automatic/manual binding或future type1 payload；raw type-10持久化完整input以便recompute | `SupersessionBindingDigestInputV1` |
| `buildEventChainDigestInput` | M4/F5/F6/F7 | genesis/operation discriminator exact | `EventChainDigestInputV1` |
| `buildSourceFactsDigestInput` | M4/F6 | facts仅source set且stable order | `SourceFactsDigestInputV1` |
| `buildRecoverySourceVersionDigestInput` | M4/F6 |排除`versionDigest`自身；registry refs exact | `RecoverySourceVersionDigestInputV1` |
| `buildRecoveryControlTailDigestInput` | M4/F7 | empty/nonempty tail invariants exact | `RecoveryControlTailDigestInputV1` |
| `buildRecoveryPolicyDigestInput` | config/M6/F13 | normalized defaults/effective M；无provenance | `RecoveryPolicyDigestInputV1` |
| `buildDispatchTargetDigestInput` | M2/F10 | target normalized且credential commitment valid | `DispatchTargetDigestInputV1` |
| `buildSealedMaterialCommitmentInput` | M4 sealed owner | keyedValue已audited HMAC；无plaintext | `SealedMaterialCommitmentInputV1` |
| `buildPausedHandleCommitmentInput` | M2 handle owner | keyedValue已audited HMAC；无raw handle | `PausedHandleCommitmentInputV1` |
| `buildRecoveryClosureDigestInput` | M7 | action-specific closure branch exact | `RecoveryClosureDigestInputV1` |
| `buildCredentialAuthorityVersionDigestInput` | provider descriptor/vault | provider-ID或HMAC branch exact；无raw credential | `CredentialAuthorityVersionDigestInputV1` |
| `buildProviderAuthorizationProofDigestInput` | M2 descriptor owner | replayMode/closure/target/action cross-equal | `ProviderAuthorizationProofDigestInputV1` |
| `buildControlPolicyDigestInput` | config/M6/M4 | scope quartet exact | `ControlPolicyDigestInputV1` |
| `buildToolPlanDigestInput` | M3/M4 | exact final arguments carrier projection after secret replacement；sealed plaintext只由ref HMAC承诺，carrier另存且不可由digest替代 | `ToolPlanDigestInputV1` |
| `buildToolCallDigestInput` | M3/M4/M7 | finalPlanDigest present、call literals M1 V1且call order来自durable ordinal | `ToolCallDigestInputV1` |
| `buildToolResultDigestInput` | M3/M4/M7 | settlement terminal、interruption none；result/error discriminator与exact carrier projection一致 | `ToolResultDigestInputV1` |
| `buildReasoningTextDigestInput` | M3/M4 | provenance/mode/target exact；content为verified replay carrier projection，sealed text不进入unkeyed digest | `ReasoningTextDigestInputV1` |
| `buildProviderPrefixDigestInput` | M4/M7 | prefix为verified replay carrier projection的exact protocol representation；secret state sealed且plaintext不进入unkeyed digest | `ProviderPrefixDigestInputV1` |
| `buildProviderPrefixAncestryDigestInput` | M4 | genesis/extension ancestry inequalities exact | `ProviderPrefixAncestryDigestInputV1` |
| `buildSourceAllowedEventSetDigestInput` | LLM `buildRecoveryEventRegistry` | `set:"source"`且7 entries registry-fixed | `AllowedEventSetDigestInputV1 & {set:"source"}` |
| `buildControlAllowedEventSetDigestInput` | LLM `buildRecoveryEventRegistry` | `set:"control"`且3 entries registry-fixed | `AllowedEventSetDigestInputV1 & {set:"control"}` |

`entries`是按`operationType`固定排序的tuple；每项exact字段为`operationType,eventType,eventVersion,fieldSetVersion,exactFields`。`exactFields`递归列出每个JSON path的`presence(required|optional),specKind`及union branch literal，并按schema declaration order冻结；因此digest不只承诺top-level名字。source/control allowed-set digest因domain与`set`不同不可互换。

credential authority builder是registry中的特殊two-stage input producer：provider提供non-secret stable version ID时直接构造provider-ID branch；否则credential vault先对raw credential与authority scope执行HMAC-SHA-256，只把完整`keyedValue`及key metadata送入canonical registry。两路最终都由`credential-authority-version-v1`输出`CredentialAuthorityVersionDigest`；禁止raw credential进入canonical input或直接SHA-256。

#### 4.1.4 Three architectural digest envelopes

semantic/prepared/binding的architecture membership保持不变，但由closed registry收紧：

- Semantic membership：exact normalized target/authority、effective storage mode、final tool definitions、wire-semantic provider/model/generation/http options、actual lowered system/history/body；secret位置只放validated sealed commitment。明确排除 decision ID/revision、child identity、lineage/dispatch context、proof envelope、runtime handle、operationID、timestamp。
- Prepared membership：保持唯一`PreparedDigest` brand，但input按`dispatchKind`分支。initial/ordinary available branch绑定candidate context、exact final `SemanticDigestInputV1` request（target连同authority、storage、tools、provider/model/generation/http options、lowered system/history/body）、其`SemanticDigest`、replay fence、capability summary、provider authorization commitment、`PausedHandleCommitment`及prepared body format/version；明确禁止`RecoverySourceVersion`、automatic action与recovery closure。automatic-recovery branch在同一common material上另且仅另绑定source version、automatic action、action-specific closure descriptor与`RecoveryClosureDigest`。全部branch排除raw handle、raw secret、timestamp。
- Binding membership：保持唯一`BindingDigest` brand但input按`kind`分支。automatic branch保留source assistant、`RecoverySourceVersion`及digest、exact `RecoveryControlTailVersion`及digest、candidate dispatch context、action、available target及digest、semantic/prepared digests、authorization、closure digest、normalized N/M admission、expected heads与control policy digest。manual-stop branch绑定同一source/control版本、candidate/action、按F23 reason rank规范排序且去detail的lower-level causes及对应reasons、canonical planning-evidence commitment、closure status、normalized policy quartet/admission、expected heads、control policy与M2 live proof验证后形成的no-handle或mechanically-cancelled handle-closure commitment；该branch禁止要求、发明或携带target/targetDigest/semanticDigest/preparedDigest/authorization/closureDigest。两branch均排除decision ID/revision、operationID、receipt sequence、timestamp；proposal仍可在分配durable identity前计算。

### 4.2 Identity

#### 4.2.1 `RecoveryLineage`

```ts
export type RecoveryLineage = Readonly<{
  chainID:RecoveryChainID
  recoveryOrdinal:SafeNonNegativeInt
}>
```

字段：

- `chainID: RecoveryChainID` — 一次 user work及 incomplete successors 的稳定 ID；
- `recoveryOrdinal: SafeNonNegativeInt` — 只计 incomplete-triggered child，initial/ordinary 为 0 或保持原值。

类型不变量：`chainID` 非空、NFC、无首尾空白；ordinal 为 `0..Number.MAX_SAFE_INTEGER`。

唯一性/标识：`chainID` 在 session 内唯一；`(sessionID, chainID, recoveryOrdinal)` 标识恢复层级但不单独标识 assistant。

生命周期：new user input创建；ordinary continuation保持；incomplete child精确 `+1`；不可回退或跳号。

consumer：M4/M5/M6/M8 display projection。

#### 4.2.2 Candidate / committed assistant identities

共享value字段只有`assistantID`与`assistantSequence`，但authority discriminator与brand不可替换：

```ts
type AssistantAttemptValueV1 = Readonly<{
  assistantID: RecoveryAssistantID
  assistantSequence: SafeNonNegativeInt
}>

export type CandidateAssistantAttemptIdentity = Readonly<{
  authority: "candidate"
  value: AssistantAttemptValueV1
}> & Brand<"CandidateAssistantAttemptIdentity">

export type CommittedAssistantAttemptIdentity = Readonly<{
  authority: "committed"
  value: AssistantAttemptValueV1
  admittedByOperationID: RecoveryOperationID
  admittedAtAggregateSequence: SafeNonNegativeInt
}> & Brand<"CommittedAssistantAttemptIdentity">

type AssistantAttemptIdentity =
  | CandidateAssistantAttemptIdentity
  | CommittedAssistantAttemptIdentity
```

不变量：shell synthetic assistant不得构造任一variant；initial sequence=0；任一successor=predecessor+1。candidate只是提议值，不是authority，不可进入source facts、durable evidence、receipt post-state或public projection。`(sessionID,chainID,assistantSequence)`与`assistantID`在committed state一一对应。

M4必须使用纯、transaction-local的`deriveCommittedIdentity(candidate, envelope)`，不能使用要求“materialization已存在/commit已成功”作为pre的循环promotion。该函数只验证candidate与type 1/2/9 envelope的session/lineage/sequence/ordinal/operationID/aggregateSequence关系，并返回`DerivedCommittedIdentityV1`；返回值即使包含将写入的committed字段，也保持**非authority transaction-local value**，不得逃逸到receipt、source facts、public projection或M2/M5/M6。只有包含raw event、materializations与heads的M4 transaction成功commit，并由同一transaction commit result或之后的raw read-back重新验证后，M4才可brand并export `CommittedAssistantAttemptIdentity`/`CommittedDispatchAttemptContext`。commit是唯一authority boundary；rollback后derived value无效，M2/M5/M6不得cast或自行derive/brand。

#### 4.2.3 Candidate / committed dispatch contexts 与chain genesis

```ts
type DispatchAttemptValueV1 = Readonly<{
  version: 1
  sessionID: string
  lineage: RecoveryLineage
  assistant: AssistantAttemptValueV1
  dispatchOrdinal: SafeNonNegativeInt
  origin: "initial" | "ordinary" | "automatic-recovery"
  sourceAssistantID?: RecoveryAssistantID
}>

export type CandidateDispatchAttemptContext = Readonly<{
  authority: "candidate"
  value: DispatchAttemptValueV1
}> & Brand<"CandidateDispatchAttemptContext">

export type CommittedDispatchAttemptContext = Readonly<{
  authority: "committed"
  value: DispatchAttemptValueV1
  admittedByOperationID: RecoveryOperationID
  admittedAtAggregateSequence: SafeNonNegativeInt
}> & Brand<"CommittedDispatchAttemptContext">

type DispatchAttemptContext =
  | CandidateDispatchAttemptContext
  | CommittedDispatchAttemptContext

export type DerivedCommittedIdentityV1 = Readonly<{
  authority: "derived-pending-commit"
  assistant: AssistantAttemptValueV1 & {
    admittedByOperationID: RecoveryOperationID
    admittedAtAggregateSequence: SafeNonNegativeInt
  }
  dispatch: DispatchAttemptValueV1 & {
    admittedByOperationID: RecoveryOperationID
    admittedAtAggregateSequence: SafeNonNegativeInt
  }
}>

type RecoveryChainGenesisV1 = Readonly<{
  version: 1
  sessionID: string
  lineage: { chainID: RecoveryChainID; recoveryOrdinal: 0 }
  assistant: { assistantID: RecoveryAssistantID; assistantSequence: 0 }
  dispatchOrdinal: 0
  origin: "initial"
  expectedAssistantChainHead: { kind: "genesis"; sessionID: string; chainID: RecoveryChainID }
  expectedDispatchLedgerHead: { kind: "genesis"; sessionID: string; assistantID: RecoveryAssistantID }
}>
```

origin不变量：initial/ordinary不得含`sourceAssistantID`；automatic recovery必须含且不等于child assistant；ordinal 0是admission composite初始dispatch，后续dispatch精确`+1`。durable ledger key为`(sessionID,assistantID,dispatchOrdinal)`。

model-lineage genesis validation固定为：仅`initial-chain-genesis-and-dispatch`可携带`RecoveryChainGenesisV1`；M4在同一transaction中证明assistant-chain与该assistant的dispatch-ledger两个expected heads仍为genesis/absent、session内`chainID`与assistantID均未materialize、assistantSequence/dispatchOrdinal/recoveryOrdinal均为0。type-1的aggregate predecessor则必须精确等于调用时current `AggregateEventHeadV1`：只有它是该session dedicated recovery aggregate的首条recovery operation时才是aggregate genesis；post-supersession type-1必须引用type-10提交后的exact event head。任一不成立均conflict，不得按ordinary或replay降级。transaction内可先调用`deriveCommittedIdentity`计算待写值；successful raw commit/read-back后，只有M4可把对应值brand并暴露为committed。ordinary/automatic必须引用committed assistant predecessor，绝不能重新声明model-lineage genesis。

consumer：M2/M5/M6只可持有candidate；M3/M4/M7 durable/source路径只可持有committed；M4 committed result/read-back receipt是跨越commit authority boundary的proof。

### 4.3 Target、domain、storage 与 sealed material

#### 4.3.1 `CredentialAuthorityVersionCommitment` 与 `DispatchTarget`

```ts
type CredentialAuthorityScopeV1 = Readonly<{
  accountID?:string
  projectID?:string
  tenantID?:string
}>
type CredentialAuthorityVersionCommitment =
  | Readonly<{
      version: 1
      derivation: "provider-version-id"
      providerVersionID: string // provider明确声明为non-secret
      commitment: CredentialAuthorityVersionDigest
    }>
  | Readonly<{
      version: 1
      derivation: "hmac-sha256"
      keyID: string
      keyVersion: SafePositiveInt
      commitment: CredentialAuthorityVersionDigest
    }>

export type DispatchTarget = Readonly<{
  version: 1
  providerID: string
  routeID: string
  protocol: string
  endpoint: {
    scheme: "https"; host: string; port?: SafePositiveInt; path: string
    deploymentID?: string; regionID?: string
  }
  authority: {
    accountID?: string
    projectID?: string
    tenantID?: string
    credentialVersion: CredentialAuthorityVersionCommitment
  }
  modelID: string
  modelFamily?: string
}>
```

credential commitment不变量：provider-version-id路只接受provider文档明确标为non-secret且对credential rotation稳定变化的version ID；若provider无此ID，必须由credential vault使用版本化secret key执行HMAC-SHA-256。禁止`SHA-256(rawCredential)`、截断/编码token、把header/key/token传入canonical builder或记录providerVersionID字段。HMAC key ID/version不是credential本身，unknown key version fail closed。

Target不变量：所有ID非空/NFC/无首尾空白；provider/route/model大小写保持；scheme必须`https`；host lowercase ASCII；default 443省略；path绝对、无query/fragment/userinfo、移除非根尾斜杠但不percent-decode；authority至少一个scope ID，且credentialVersion required。exact target equality为所有结构字段完全相等；`DispatchTargetDigest`由closed `dispatch-target-v1` builder产生，不能使用裸digest替代。

生命周期：M2 final transform后构造；source target冻结，planned target独立构造并比较。consumer：M2/M4/M5/M6/M7；public禁止。

#### 4.3.2 `ProviderSafetyDomain`

```ts
export type ProviderSafetyDomain = Readonly<
  Pick<DispatchTarget,"version"|"providerID"|"routeID"|"protocol"|"endpoint"|"authority">
  & {
    modelScope:
      | Readonly<{kind:"exact";modelID:string}>
      | Readonly<{kind:"family";modelFamily:string}>
    contractVersion:SafePositiveInt
  }
>
```

字段：除 target 的 provider/route/protocol/endpoint/authority 外，增加：

- `modelScope: { kind:"exact"; modelID:string } | { kind:"family"; modelFamily:string }`；
- `contractVersion: SafePositiveInt`。

不变量：domain不得省略 target 的任何 endpoint/authority字段；family scope只有 provider contract明确声明时可构造；display name/prefix/current config均非法。

生命周期：由 audited provider descriptor产生；变更 contractVersion 会使旧 proof/binding stale。

consumer：M2/M5/M7。

#### 4.3.3 `StorageMode`

```ts
export type StorageMode = "true"|"false"|"unknown"
```

值域：字符串 literal `"true" | "false" | "unknown"`，不用 optional boolean代替。

不变量：provider option `undefined`/缺失只归一化为 `unknown`；不得暗算 false；`null`、数字、任意字符串为 invalid input而非 unknown。

consumer：OpenAI Responses planning/lowering、source evidence、digest。

#### 4.3.4 `SealedRecoveryMaterialRef` 与paused-handle commitment

```ts
export type SealedRecoveryMaterialRef = Readonly<{
  version: 1
  refID: RecoverySealedRefID
  issuer: "m4-sealed-store"
  purpose:
    | "idempotency-key" | "continuation-cursor" | "reasoning-signature"
    | "encrypted-reasoning" | "provider-state"
    | "tool-arguments" | "tool-result" | "tool-error"
    | "reasoning-content" | "provider-prefix-content"
  scope: { sessionID: string; assistantID: RecoveryAssistantID; targetDigest: DispatchTargetDigest }
  materialCommitment: SealedMaterialCommitment
  commitmentDerivation: "hmac-sha256"
  keyID: string
  keyVersion: SafePositiveInt
}>

export type PausedHandleDescriptorV1 = Readonly<{
  version: 1
  commitment: PausedHandleCommitment
  derivation: "hmac-sha256"
  keyID: string
  keyVersion: SafePositiveInt
}>

export type SealedRecoveryUseLeaseKeyInputV1 = Readonly<{
  version:1
  leaseContract:"m4-sealed-use-v1"
  ref:SealedRecoveryMaterialRef
  purpose:SealedRecoveryMaterialRef["purpose"]
  scope:SealedRecoveryMaterialRef["scope"]
  materialCommitment:SealedMaterialCommitment
  sealedGeneration:SafePositiveInt
  preparedHandleCommitment:PausedHandleCommitment
  source:Readonly<{
    sessionID:string
    aggregateID:RecoveryAggregateID
    sourceAssistantID:RecoveryAssistantID
    sourceVersionDigest:RecoverySourceVersionDigest
    controlTailVersionDigest:RecoveryControlTailDigest
  }>
  action:AutomaticRecoveryAction
  operation:Readonly<{
    sessionID:string
    aggregateID:RecoveryAggregateID
    operationID:RecoveryOperationID
    candidateContext:CandidateDispatchAttemptContext
    targetDigest:DispatchTargetDigest
  }>
}>

export type M4SealedRecoveryMaterialLookupProofV1 = Readonly<{
  proofVersion:1
  owner:"m4-sealed-store"
  refID:RecoverySealedRefID
  lookupState:"registered-readable"
  purpose:SealedRecoveryMaterialRef["purpose"]
  scope:SealedRecoveryMaterialRef["scope"]
  materialCommitment:SealedMaterialCommitment
  keyID:string
  keyVersion:SafePositiveInt
}> & Brand<"M4SealedRecoveryMaterialLookupProofV1">
```

不变量：ref不含raw material；`refID`只能由M4 sealed store以CSPRNG生成并brand，是不可解析、不可预测、与plaintext长度/内容无关联的opaque ID；M2/M7/caller不得自造或从secret hash派生refID。scope与使用点exact match。包括低熵idempotency key、短cursor、布尔/provider state在内的所有material commitment均必须keyed HMAC；禁止unkeyed SHA-256 plaintext digest及dictionary-testable commitment。paused handle同样只以keyed commitment出现，raw handle是linear runtime resource，不encode/digest/log。unknown/unreadable key version表示authority unavailable，不表示material absent。

`M4SealedRecoveryMaterialLookupProofV1`只是M4在其sealed-store lookup成功后产生的ephemeral nominal evidence；字段精确投影lookup时已验证的ref identity/scope/purpose/commitment/key version。M1不构造brand、不查询store、不决定key readability、不persist proof。F16只做ref structural/scope/purpose检查；F15/F19等later M1 caller若需要“已登记且key readable”结论，必须显式接收M4 proof并pure地逐字段比较ref与proof。proof cleanup/staleness与lookup capability仍完全由M4拥有。

`SealedRecoveryUseLeaseKeyInputV1`是M1导出的**structural shared key input**，不是lease、proof、capability或新增commitment domain。其exact invariants为：`purpose/scope/materialCommitment`逐字段等于`ref`；`source.sessionID==operation.sessionID==operation.candidateContext.value.sessionID==ref.scope.sessionID`；`source.aggregateID==operation.aggregateID`；`source.sourceAssistantID==ref.scope.assistantID`；`operation.targetDigest==ref.scope.targetDigest`；`operation.candidateContext.value.sourceAssistantID==source.sourceAssistantID`且origin为automatic-recovery；`sealedGeneration`由M4 sealed store在该ref scope内单调分配；`preparedHandleCommitment`、source/action、operation/session/aggregate/candidate/target identity全部是key members。M4 later可用此exact input构造snapshot-bound nominal sealed-use lease并拥有acquire/consume/revoke/expiry/cleanup；M1不定义nominal lease/proof type、不brand、不persist、不查询lease registry。任何字段变化均是不同lease key；raw secret、unsealed bytes、raw cursor、credential、runtime handle与provider client对象禁止出现。

生命周期：M4 sealed store唯一创建/读取/rotation/revoke/cascade sealed ref及lookup proof，并唯一拥有基于上述key input的lease实现；M2只可通过audited keyed builder创建paused handle descriptor。consumer：M2/M4/M5/M7；public禁止。

### 4.4 Dispatch、tool 与 reasoning evidence

#### 4.4.1 `AvailableDispatchEvidence`

```ts
export type PreparedDispatchKindV1 = "initial"|"ordinary"|"automatic-recovery"

export type AvailableDispatchEvidence = Readonly<{
  kind:"available"
  version:1
  preparedDispatchKind:PreparedDispatchKindV1
  context:CommittedDispatchAttemptContext
  target:DispatchTarget
  targetDigest:DispatchTargetDigest
  safetyDomain:ProviderSafetyDomain
  storageMode:StorageMode
  semanticDigest:SemanticDigest
  preparedDigest:PreparedDigest
  replayFence:ProviderReplayFence
  capabilities:ProviderCapabilitySummary
  authorization:ProviderAuthorizationCommitment
  pausedHandleCommitment:PausedHandleCommitment
}>
```

字段：

- `kind:"available"`、`version:1`；
- `preparedDispatchKind: PreparedDispatchKindV1`，必须与`context.value.origin` exact equal；
- `context: CommittedDispatchAttemptContext`；
- `target: DispatchTarget`与`targetDigest: DispatchTargetDigest`；
- `safetyDomain: ProviderSafetyDomain`；
- `storageMode: StorageMode`；
- `semanticDigest: SemanticDigest`；
- `preparedDigest: PreparedDigest`；
- `replayFence: ProviderReplayFence`；
- `capabilities: ProviderCapabilitySummary`；
- `authorization: ProviderAuthorizationCommitment`；
- `pausedHandleCommitment: PausedHandleCommitment`。

不变量：`preparedDispatchKind`与committed context origin一致；target属于domain；所有branded commitment均已按registry验证；paused-handle commitment不暴露runtime handle；available必须具有exact target/authority/proof，不允许unknown字段伪装。

生命周期：prepare时runtime形成；M4 ledger commit后durable；release后仍保留evidence但不保留plaintext/handle。

#### 4.4.2 `OpaqueDispatchEvidence`

```ts
export type OpaqueDispatchEvidence = Readonly<{
  kind:"opaque"
  version:1
  context:CommittedDispatchAttemptContext
  providerID:string
  modelID:string
  localTools:"present"|"absent"|"unknown"
  cause:RecoveryFailureCause
  pausedHandleCommitment:PausedHandleCommitment
}>
```

字段：

- `kind:"opaque"`、`version:1`；
- `context: CommittedDispatchAttemptContext`；
- `providerID`、`modelID`；
- `localTools: "present" | "absent" | "unknown"`；
- `cause: RecoveryFailureCause`，其source/kind必须属于dispatch/provider-introspection/planning/provider/closure的opaque-admission allowlist；
- `pausedHandleCommitment: PausedHandleCommitment`。

禁止字段：target、domain、storageMode、semantic/prepared digest、replay proof。

不变量：只允许 initial/ordinary dispatch；opaque incomplete source必定不能 automatic。

#### 4.4.3 `DispatchEvidence`

```ts
export type DispatchEvidence = AvailableDispatchEvidence|OpaqueDispatchEvidence
```

`AvailableDispatchEvidence | OpaqueDispatchEvidence` discriminated union。snapshot中按 ordinal升序、无 duplicate/gap；automatic source要求恰有唯一 ordinal 0 available entry且不存在任何后续 dispatch。

#### 4.4.4 `ProviderReplayFence` 与 capability/authorization

`ProviderReplayFence`：

```ts
export type ProviderReplayFence =
  | { kind:"no-provider-side-effect"; contractVersion:SafePositiveInt }
  | { kind:"attempt-idempotency"; domain:ProviderSafetyDomain; material:SealedRecoveryMaterialRef }
  | { kind:"durable-prefix-continuation"; domain:ProviderSafetyDomain; prefix:ProviderPrefixCheckpoint; material?:SealedRecoveryMaterialRef }
  | { kind:"unknown"; cause:RecoveryFailureCause }
```

capability不使用“字段缺失=不支持”，而使用closed typed decision，保留架构§12的开放能力空间：

```ts
type CapabilityDecision<Feature extends string, Mode extends string> =
  | { status:"supported"; feature:Feature; mode:Mode; contractVersion:SafePositiveInt }
  | { status:"typed-unavailable"; feature:Feature; cause:RecoveryFailureCause }
  | { status:"unknown"; feature:Feature; cause:RecoveryFailureCause }

export type ProviderCapabilitySummary = Readonly<{
  descriptorVersion: SafePositiveInt
  replay: CapabilityDecision<"replay", "none"|"attempt-idempotency"|"durable-prefix">
  localTools: CapabilityDecision<"local-tools", "client-function-call">
  serverTools: CapabilityDecision<"server-tools", "provider-server-tool">
  hostedTools: CapabilityDecision<"hosted-tools", "provider-hosted-tool">
  signedReasoning: CapabilityDecision<"signed-reasoning", "provider-end-signature">
  storedReasoning: CapabilityDecision<"stored-reasoning", "item-reference">
  storeFalseReasoning: CapabilityDecision<"store-false-reasoning", "stateless-encrypted-state">
}>
```

首批保守allowlist必须编码为数据而不是删除type variant：

- Anthropic：`localTools=supported(client-function-call)`；server/hosted tool固定`typed-unavailable`；signed reasoning只有provider-end provenance、exact target/model与audited lowerer同时成立时supported，否则typed unavailable/unknown。
- OpenAI Responses `store=true`：settled local function call/output可supported；stored reasoning只有item ID、target/authority/model/final transform均匹配时supported；hosted/provider-executed tool固定typed unavailable。
- OpenAI Responses `store=false`：不依赖reasoning state的local function call/output可supported；`storeFalseReasoning`的stateless encrypted reasoning与hosted item在本release固定typed unavailable。未来若架构评审批准并由actual lowerer/proof实现，只改变decision数据和descriptor version，不改变union形状。
- server tool、hosted tool、store-false reasoning即使本release不可用，也必须在schema、cause mapping、canonical capability input与tests中存在；不得通过删字段让“未表达”被误读为absent/safe。

`ProviderAuthorizationCommitment`固定字段：

```ts
export type ProviderAuthorizationCommitment = Readonly<{
  version:1
  descriptorID:string
  descriptorVersion:SafePositiveInt
  targetDigest:DispatchTargetDigest
  storageMode:StorageMode
  allowedAction:"initial"|"ordinary"|AutomaticRecoveryAction
  proofDigest:ProviderAuthorizationProofDigest
}>
```

不变量：`proofDigest`只能由`provider-authorization-proof-v1`的`buildProviderAuthorizationProofDigestInput`+F21产生；其`descriptorID/descriptorVersion/targetDigest/storageMode/allowedAction`必须与外层exact equal，`replayMode`必须由对应`ProviderReplayFence` closed branch归一化，`closureDigest`与同一prepared request一致。不得含raw credential、runtime closure或paused handle；descriptor/target/storage/action/capability/replay/closure任一声明变化必须改变proof digest并进一步改变PreparedDigest。

#### 4.4.5 `ToolEvidence`、reconstructible replay payload 与authority partition

```ts
export type RecoverySourceRangeV1 = Readonly<{
  firstSeq:SafeNonNegativeInt
  lastSeq:SafeNonNegativeInt
  fieldSetVersion:1
}>
```

`firstSeq<=lastSeq`且range内每个raw fact连续；只由M4 fold产生。

M1冻结下列V1 literals；M3不得以runtime/SDK同义词直接落盘，M4必须直接存储这些literal，或通过一个覆盖全部source literal且unknown input失败的total versioned mapping转换后再存储：

```ts
export type ToolExecutionKindV1 = "local" | "provider" | "unknown"
export type ToolInputStateV1 = "open" | "complete" | "unknown"
export type ToolCallObservationV1 = "durable" | "not-observed" | "unknown"
export type ToolSettlementV1 = "pending" | "running" | "completed" | "error"
export type ToolInterruptionV1 = "none" | "execution-interrupted" | "provider-result-missing" | "unknown"
export type ProviderExecutedStateV1 = "true" | "false" | "unknown"
export type ToolExecutionModeV1 = "execute-local" | "replace-local" | "short-circuit"

export type RecoveryReplayPayloadV1 =
  | Readonly<{
      version:1
      carrier:"inline"
      encoding:"recovery-canonical-json"
      valueKind:"canonical-wire-value"
      value:CanonicalWireValueV1
    }>
  | Readonly<{
      version:1
      carrier:"inline"
      encoding:"recovery-canonical-json"
      valueKind:"utf8-text"
      value:string
    }>
  | Readonly<{
      version:1
      carrier:"sealed"
      encoding:"recovery-canonical-json"
      valueKind:"canonical-wire-value"|"utf8-text"
      ref:SealedRecoveryMaterialRef
    }>

export type RecoveryReplayPayloadCommitmentProjectionV1 =
  | Readonly<{
      version:1
      carrier:"inline"
      valueKind:"canonical-wire-value"|"utf8-text"
      value:CanonicalWireValueV1
    }>
  | Readonly<{
      version:1
      carrier:"sealed"
      valueKind:"canonical-wire-value"|"utf8-text"
      ref:SealedRecoveryMaterialRef
    }>

export type ToolExecutionPhaseV1 =
  | Readonly<{
      phase:"planned"
      bodyState:"not-started"
      afterHookState:"not-started"
      automaticEligibility:"ineligible"
      rerunBody:"forbidden"
      rerunAfterHook:"forbidden"
    }>
  | Readonly<{
      phase:"body-outcome-durable"
      bodyState:"completed"|"error"
      afterHookState:"not-settled"
      automaticEligibility:"ineligible"
      rerunBody:"forbidden"
      rerunAfterHook:"forbidden"
    }>
  | Readonly<{
      phase:"final-after-hook-settled"
      bodyState:"completed"|"error"
      afterHookState:"settled"
      automaticEligibility:"continue-only"
      rerunBody:"forbidden"
      rerunAfterHook:"forbidden"
    }>
  | Readonly<{
      phase:"reconciled-terminal-manual-only"
      bodyState:"completed"|"error"|"unknown"
      afterHookState:"settled"|"unknown"
      automaticEligibility:"manual-only"
      rerunBody:"forbidden"
      rerunAfterHook:"forbidden"
    }>
  | Readonly<{
      phase:"unknown-intermediate"
      bodyState:"unknown"
      afterHookState:"unknown"
      automaticEligibility:"ineligible"
      rerunBody:"forbidden"
      rerunAfterHook:"forbidden"
    }>

export type ToolTerminalReplayPayloadV1 =
  | Readonly<{
      kind:"result"
      payload:RecoveryReplayPayloadV1 & Readonly<{valueKind:"canonical-wire-value"}>
    }>
  | Readonly<{
      kind:"error"
      payload:RecoveryReplayPayloadV1 & Readonly<{valueKind:"canonical-wire-value"}>
    }>

export type AuthoritativeToolEvidenceV1 = Readonly<{
  version:1
  authorityClass:"authoritative-source-v1"
  callOrdinal:SafeNonNegativeInt
  callID:string
  name:string
  executionKind:ToolExecutionKindV1
  inputState:ToolInputStateV1
  callObservation:ToolCallObservationV1
  settlement:ToolSettlementV1
  interruption:ToolInterruptionV1
  providerExecuted:ProviderExecutedStateV1
  planRevision:SafeNonNegativeInt
  phase:ToolExecutionPhaseV1
  arguments?:RecoveryReplayPayloadV1 & Readonly<{valueKind:"canonical-wire-value"}>
  terminalPayload?:ToolTerminalReplayPayloadV1
  finalPlanDigest?:ToolPlanDigest
  callDigest?:ToolCallDigest
  resultDigest?:ToolResultDigest
  sourceRange:RecoverySourceRangeV1
}>

export type CompatibilityToolEvidenceV1 = Readonly<{
  version:1
  authorityClass:"compatibility-only"
  legacyPartOrdinal:SafeNonNegativeInt
  callID?:string
  name?:string
  executionKind:ToolExecutionKindV1
  inputState:ToolInputStateV1
  callObservation:ToolCallObservationV1
  settlement:ToolSettlementV1
  interruption:ToolInterruptionV1
  providerExecuted:ProviderExecutedStateV1
  phase:Exclude<ToolExecutionPhaseV1,{phase:"final-after-hook-settled"}>
  arguments?:RecoveryReplayPayloadV1 & Readonly<{valueKind:"canonical-wire-value"}>
  terminalPayload?:ToolTerminalReplayPayloadV1
  causes:NonEmptyReadonlyArray<RecoveryFailureCause>
}>

export type ToolEvidence = AuthoritativeToolEvidenceV1|CompatibilityToolEvidenceV1

export type CanonicalToolEvidencePartitionV1 =
  | Readonly<{
      authorityClass:"truly-empty"
      authoritative:readonly []
      compatibility:readonly []
    }>
  | Readonly<{
      authorityClass:"authoritative-only"
      authoritative:NonEmptyReadonlyArray<AuthoritativeToolEvidenceV1>
      compatibility:readonly []
    }>
  | Readonly<{
      authorityClass:"compatibility-only"
      authoritative:readonly []
      compatibility:NonEmptyReadonlyArray<CompatibilityToolEvidenceV1>
    }>
  | Readonly<{
      authorityClass:"mixed"
      authoritative:NonEmptyReadonlyArray<AuthoritativeToolEvidenceV1>
      compatibility:NonEmptyReadonlyArray<CompatibilityToolEvidenceV1>
    }>
```

`CanonicalToolEvidencePartitionV1`是total且disjoint：分类只由两个数组的empty/nonempty笛卡尔积决定，四branch恰覆盖全部组合；`authorityClass`必须与cardinality双向一致，数组按各自durable `callOrdinal`/`legacyPartOrdinal`升序、各自无duplicate；authoritative与compatibility的fact identity包含authority class/source ordinal，同一`callID`可在两partition共存且必须分别保留，不得跨partition dedup、吞并或覆盖。M4 snapshot builder必须收集同一WAL/read snapshot内的**全部**known source tool facts和全部Legacy compatibility tool facts后才能选择branch；不得因为authoritative数组为空而省略compatibility，亦不得把compatibility-only投影成`truly-empty`。exact classifier固定为：

```text
(|authoritative|, |compatibility|) = (0,0)       iff truly-empty
(|authoritative|, |compatibility|) = (>0,0)      iff authoritative-only
(|authoritative|, |compatibility|) = (0,>0)      iff compatibility-only
(|authoritative|, |compatibility|) = (>0,>0)     iff mixed
```

四个predicate两两不相交且析取为true；任何discriminator/cardinality mismatch是`inconsistent-evidence`，不是fallback branch。

phase不变量：`planned`证明body尚未开始但仍不授权automatic rerun；`body-outcome-durable`证明body outcome已durable但after-hook未settled，因此必须已有arguments/terminal result-or-error及`finalPlanDigest/callDigest/resultDigest`，但仍不automatic；只有`final-after-hook-settled`可成为Continue候选，且必须是complete+durable local/client call、`providerExecuted:"false"`、`interruption:"none"`、`settlement:"completed"|"error"`，并具有arguments/terminal payload、`finalPlanDigest/callDigest/resultDigest`；`reconciled-terminal-manual-only`是M3/M4显式reconcile后的terminal observation但缺automatic proof，固定ManualStop；`unknown-intermediate`及任意不一致/中间crash state均不eligible。所有phase的`rerunBody/rerunAfterHook`固定forbidden：该carrier只证明已有执行事实，从不授权重跑不确定body或after-hook。

SafeRetry关于tool的必要条件精确为`tools.authorityClass=="truly-empty"`；`compatibility-only`、`mixed`、`authoritative-only`均禁止SafeRetry。Continue关于tool的必要条件精确为`tools.authorityClass=="authoritative-only"`且每项phase=`final-after-hook-settled`；compatibility存在、planned/body-outcome/reconciled/unknown任一存在都只能产生typed cause→ManualStop。M1只定义partition与structural eligibility facts；M4 later可在snapshot-bound view中构造nominal automatic proof，本文不定义或伪造该M4 proof type。

replay payload不变量：inline carrier保存可重建的exact canonical value；sealed carrier保存同一`recovery-canonical-json` payload bytes的exact scoped ref，不保存plaintext。`encoding:"recovery-canonical-json"`精确表示F17 payload canonical-JSON token stream本身的UTF-8 bytes（不含commitment domain prefix），单一root、无BOM、无trailing bytes；`valueKind:"utf8-text"`要求root为JSON string，`canonical-wire-value`要求root满足对应exact wire spec。sealed purpose映射是closed且双向exact：arguments→`tool-arguments`、result→`tool-result`、error→`tool-error`、reasoning text→`reasoning-content`、provider prefix→`provider-prefix-content`；不得用generic `provider-state`或其它purpose代替。tool arguments/results/errors的数组顺序和outer call order是语义；object key顺序按F17 canonical JSON规则归一。`terminalPayload.kind=="result"`当且仅当`settlement=="completed"`且phase bodyState为completed；`terminalPayload.kind=="error"`当且仅当`settlement=="error"`且phase bodyState为error。每个carrier确定唯一`RecoveryReplayPayloadCommitmentProjectionV1`：inline投影exact value，sealed投影exact ref（含keyed `materialCommitment`）而**不投影plaintext**。`finalPlanDigest`从arguments projection重算，`callDigest`从同一call literals/plan重算，`resultDigest`从result/error discriminator及terminal projection重算；reasoning/prefix同理。这样unkeyed owner digest只承诺secret-safe projection，sealed plaintext由ref内keyed HMAC承诺；digest只是commitment，绝不替代payload carrier。不存在`replay-payload-v1`或caller-selected generic payload domain：tool plan/call/result、reasoning text、provider prefix、source facts/operation payload/closure继续复用既有closed domains，因此registry仍精确25项且没有隐藏的第26项。sealed decode必须先由M4验证ref scope/purpose/material HMAC并unseal，再以strict canonical JSON decoder得到唯一root、拒绝trailing bytes/duplicate object key/noncanonical number/lone surrogate并重编码byte-equal；owner builder+F22重算使用同一carrier projection，不把unsealed secret/raw cursor喂给unkeyed digest。inline exact decode后以value projection重算。任一ref unreadable、purpose/scope mismatch、decode/re-encode/digest mismatch为authority unavailable/inconsistent，不得删除payload后继续。

生命周期：M3在tool plan/body outcome/after-hook各durable边界产生M1 literal；在append前完成secret replacement，非敏感payload可inline，敏感/raw output必须把exact canonical bytes交M4 sealed store并只持久化ref。M4 raw operation保存carrier+commitments，snapshot build收集完整partition并执行上述decode/recompute；closure必须逐项复制同一carrier与commitments。M7只能从M4 later提供的snapshot-bound nominal view解析这些authority-bound payload并构造实际`ModelMessage[]`，不得从digest、Legacy history、current UI part或provider cache反推内容。M5只读partition/phase，不读plaintext；public projection禁止全部payload/ref/digest。

#### 4.4.6 `ReasoningEvidence`

M1冻结并export以下literals；M3产生、M4持久化时必须直接使用这些literals，或使用一个total versioned mapping；M7只消费M4已验证literal，不得把SDK/provider的近义字符串当作durable值。

```ts
export type ReasoningProvenanceV1 =
  | "provider-end"
  | "step-boundary-forced-flush"
  | "cleanup-forced-flush"
  | "unknown"
export type ReasoningContinuationModeV1 =
  | "none"|"signed"|"stored-reference"|"unknown"
export type ReasoningEvidence = Readonly<{
  version:1
  blockID:string
  provenance:ReasoningProvenanceV1
  continuationMode:ReasoningContinuationModeV1
  protocol:string
  targetDigest:DispatchTargetDigest
  content?:RecoveryReplayPayloadV1 & Readonly<{valueKind:"utf8-text"}>
  textDigest?:ReasoningTextDigest
  stateRefs:readonly SealedRecoveryMaterialRef[]
  publicMetadata:Readonly<Record<string,JsonScalarOrArray>>
  sourceRange:RecoverySourceRangeV1
}>
```

字段：

- `version:1`、`blockID`；
- `provenance: ReasoningProvenanceV1`；
- `continuationMode: ReasoningContinuationModeV1`；
- `protocol`、`targetDigest`；
- `content?: RecoveryReplayPayloadV1 & {valueKind:"utf8-text"}` — Continue需要的exact reasoning text carrier；
- `textDigest?: ReasoningTextDigest`；
- `stateRefs: readonly SealedRecoveryMaterialRef[]`；
- `publicMetadata: Record<string, JsonScalarOrArray>` — 仅provider allowlist后的非敏感 metadata；
- `sourceRange`。

不变量：`signed|stored-reference`只允许`provenance:"provider-end"`；forced flush必须`continuationMode:"none"`，old-row无proof为`unknown`，不能升级；需要signature/encrypted state的协议若 stateRefs缺失则 unavailable；metadata未知key在authority decode时拒绝，不进入通用 bag。任何进入Continue closure的reasoning item必须同时有`content`与`textDigest`；digest只能由`reasoning-text-v1` builder从content的secret-safe commitment projection及同一block的M1 provenance/protocol/target构造；sealed exact text另由ref keyed material commitment绑定。inline/sealed content按§4.4.5统一decode/re-encode/F22规则验证；reasoning signature/encrypted state继续只以purpose/scope exact的`stateRefs`出现。M4直接保存M1 literal或total mapped literal及content carrier，在snapshot fold时复验，不能只保存digest/provider原始枚举后在read时猜测或从current message重建。forced/unknown content即使存在也不取得continuation authority。

### 4.5 Source/control versions 与 snapshot

#### 4.5.1 Frozen event-type / field-set registries

```ts
type RecoveryEventTypeSetVersion = 1 & Brand<"RecoveryEventTypeSetVersion">
type RecoveryFieldSetRegistryVersion = 1 & Brand<"RecoveryFieldSetRegistryVersion">
type RecoveryEventSetName = "source" | "control"

type RecoveryFieldSetRefV1 = Readonly<{
  operationType: RecoveryOperationType
  eventType: RecoveryEventType
  eventVersion: 1
  fieldSetVersion: 1
}>
type InternalRecoveryDefinitionV1<T extends RecoveryOperationType> = Readonly<{
  eventType:RecoveryEventTypeForV1<T>
  operationType:T
  publication:"internal"
  durable:{aggregate:"aggregateID";version:1}
  exactFieldSet:ExactFieldSetSpecification<RecoveryOperationEnvelope<T>>
}>
type AnyInternalRecoveryDefinitionV1 = {
  [T in RecoveryOperationType]: InternalRecoveryDefinitionV1<T>
}[RecoveryOperationType]
export type RecoveryEventDefinitionSetV1 = Readonly<{
  eventTypeSetVersion:RecoveryEventTypeSetVersion
  fieldSetRegistryVersion:RecoveryFieldSetRegistryVersion
  definitions:readonly AnyInternalRecoveryDefinitionV1[]
  fieldSets:readonly RecoveryFieldSetRefV1[]
  sourceEntries:readonly RecoveryFieldSetRefV1[]
  controlEntries:readonly RecoveryFieldSetRefV1[]
}>
export type RecoveryEventRegistryV1 = RecoveryEventDefinitionSetV1 & Readonly<{
  sourceAllowedEventSetDigest:SourceAllowedEventSetDigest
  controlAllowedEventSetDigest:ControlAllowedEventSetDigest
}>
```

`RecoveryEventTypeRegistryV1`冻结10个operation/event一一映射；`RecoveryFieldSetRegistryV1`冻结§4.8.2每个operation的递归exact schema。每个definition的durable selector精确读取envelope顶层`aggregateID`，该ID标识dedicated recovery aggregate；不得以payload/session的`sessionID`作为EventTable aggregate selector。M4拥有并验证`RecoveryAggregateOwnerV1 { aggregateID, sessionID }`的一对一owner mapping：row selector、envelope.aggregateID与owner mapping必须一致，payload中的每个sessionID必须等于mapped owner，否则authority invalid。source allowed tuple精确为operation 1–7，control tuple精确为8–10，顺序与§4.8.1一致。Schema-owned F3只构造并freeze `RecoveryEventDefinitionSetV1`，不计算digest且不得依赖LLM；LLM-owned `buildRecoveryEventRegistry`接收该exact frozen set，通过closed canonical builders分别产生`SourceAllowedEventSetDigest`与`ControlAllowedEventSetDigest`并返回enriched `RecoveryEventRegistryV1`。运行时不得从当前manifest临时排序重算另一集合。任一event-type-set version、field-set registry version、allowed-set digest变化都使既有source/control version不匹配并fail closed。

#### 4.5.1a Public event owner surfaces 与 trusted private durable replay

以下M1 types是public event source、public durable read与manifest assembly唯一可导出的event carriers。`Public*` brand只能由F2/F31对`definition.publication === "public"`的definition构造；structural cast、type-prefix判断或把internal definition塞入generic `Definition`均不能产生brand。

```ts
export type PublicEventDefinitionV1<D extends Definition = Definition> =
  D & Readonly<{ publication:"public" }> & Brand<"PublicEventDefinitionV1">

export type PublicDurableEventDefinitionV1<D extends Definition = Definition> =
  PublicEventDefinitionV1<D>
  & Readonly<{ durable:Readonly<{version:SafePositiveInt;aggregate:string}> }>
  & Brand<"PublicDurableEventDefinitionV1">

export type PublicCommittedEventV1<
  D extends PublicEventDefinitionV1 = PublicEventDefinitionV1
> = Readonly<Payload<D>> & Brand<"PublicCommittedEventV1">

export type PublicEventCursorV1 = Readonly<{
  version:1
  aggregateID:string
  sequence:SafeNonNegativeInt
}> & Brand<"PublicEventCursorV1">

export type PublicEventReadErrorV1 =
  | Readonly<{tag:"public-event-unsupported-version";observedVersion:SafePositiveInt}>
  | Readonly<{tag:"public-event-malformed";message:"Public event could not be decoded"}>
  | Readonly<{tag:"public-event-subscriber-overflow";message:"Public event subscriber overflowed"}>
  | Readonly<{tag:"public-event-read-failed";message:"Public event history could not be read"}>

export type PublicEventListenerV1 = (
  event:PublicCommittedEventV1
) => Effect.Effect<void,never>

export type PublicEventUnsubscribeV1 = Effect.Effect<void,never>
export type PublicEventSubscriptionV1<
  D extends PublicEventDefinitionV1 = PublicEventDefinitionV1
> = Stream.Stream<PublicCommittedEventV1<D>,PublicEventReadErrorV1>

export type PublicEventManifestV1 = Readonly<{
  publicDefinitions:readonly PublicEventDefinitionV1[]
  publicLatest:ReadonlyMap<string,PublicEventDefinitionV1>
  publicServer:readonly PublicEventDefinitionV1[]
}>

export type PublicDurableEventManifestV1 = Readonly<{
  definitions:ReadonlyMap<string,PublicDurableEventDefinitionV1>
  schema:Schema.Decoder<PublicCommittedEventV1,never>
}>

export interface PublicEventServiceV1 {
  publish<D extends PublicEventDefinitionV1>(
    definition:D,
    data:Data<D>,
  ):Effect.Effect<PublicCommittedEventV1<D>,PublicEventReadErrorV1>
  subscribe<D extends PublicEventDefinitionV1>(
    definition:D,
  ):PublicEventSubscriptionV1<D>
  all():PublicEventSubscriptionV1
  listen(listener:PublicEventListenerV1):Effect.Effect<PublicEventUnsubscribeV1,never>
  durable(input:Readonly<{
    aggregateID:string
    after?:PublicEventCursorV1
  }>):PublicEventSubscriptionV1<PublicDurableEventDefinitionV1>
  readAggregate(input:Readonly<{
    aggregateID:string
    after?:PublicEventCursorV1
    limit:SafePositiveInt
    manifest:PublicDurableEventManifestV1
  }>):Effect.Effect<Readonly<{
    events:readonly PublicCommittedEventV1<PublicDurableEventDefinitionV1>[]
    nextCursor?:PublicEventCursorV1
    hasMore:boolean
  }>,PublicEventReadErrorV1>
}
```

Public cursor只能由成功decode/commit的`PublicCommittedEventV1<PublicDurableEventDefinitionV1>`产生，并且`after.aggregateID`必须等于read input aggregate；caller不能brand任意recovery aggregate ID。public error union只有上述coarse literals，禁止携带raw cause/stack、internal type、aggregate owner、operation ID、receipt、digest、head、sealed ref、handle或provider body。public `all/listen/subscribe/durable/readAggregate`及bridge/sync/SSE/SDK只接受这些M1 carriers；因此`session.recovery.*`在public types、manifest、listener与cursor construction中均不可表示。

trusted private replay另有不导出public barrel的闭集：

```ts
type TrustedPrivateDurableReplayDefinitionV1<D extends Definition = Definition> =
  D & Readonly<{
    publication:"public"|"internal"
    durable:Readonly<{version:SafePositiveInt;aggregate:string}>
  }> & Brand<"TrustedPrivateDurableReplayDefinitionV1">

type TrustedPrivateDurableReplayManifestV1 = Readonly<{
  definitions:ReadonlyMap<string,TrustedPrivateDurableReplayDefinitionV1>
}>
```

该private set精确等于F31输入中**全部**带durable metadata的definitions，以`versionedType(type, durable.version)`为key；它可包含public durable definitions与10个internal recovery definitions，仅供M4/raw rebuilder、sealed authority reader及trusted migration/replay路径。它不等于`PublicDurableEventManifestV1.definitions`，不能赋值给public service/manifest/listener/subscription，不能进入OpenAPI/generated SDK/bridge/sync/SSE；private replay decode出来的internal payload仍是trusted raw authority input，不是`PublicCommittedEventV1`。

#### 4.5.2 `ProviderPrefixCheckpoint`

```ts
type ProviderPrefixCheckpoint = Readonly<{
  version: 1
  aggregateID: RecoveryAggregateID
  sessionID: string
  sourceAssistantID: RecoveryAssistantID
  sourceHighWater: SafeNonNegativeInt
  hashVersion: 1
  prefixDigest: ProviderPrefixDigest
  ancestryDigest: ProviderPrefixAncestryDigest
  protocol: string
  targetDigest: DispatchTargetDigest
  content: RecoveryReplayPayloadV1 & Readonly<{valueKind:"canonical-wire-value"}>
}>
```

所有字段required；`prefixDigest`与`ancestryDigest`必须分别由`provider-prefix-v1`和`provider-prefix-ancestry-v1` builder构造并由F22复验。`content`是可重建的exact canonical provider-prefix carrier，不是digest；materialized root必须是`CanonicalWireValueV1`。inline/sealed decode、canonical re-encode与F22重算规则同§4.4.5；sealed branch的purpose必须为`provider-prefix-content`，scope必须exact match checkpoint session/source assistant/target。prefix canonical input只接受content的secret-safe commitment projection；inline projection承诺exact M1 protocol representation，sealed projection承诺exact ref/HMAC而不含plaintext；任何敏感cursor/state必须作为nested validated sealed reference，或把整个content以exact scoped ref封存，raw cursor/provider state/credential不得进入raw operation、unkeyed prefix input或public envelope。ancestry genesis只允许该assistant首个checkpoint；extension要求same aggregate/session/source assistant、`previousSourceHighWater < sourceHighWater`且previous ancestry已F22验证。用于Continue的source snapshot、closure与prepared request三处prefix（含content carrier）必须canonical equal，且`aggregateID`必须等于source version的dedicated recovery aggregate及M4 owner mapping；不能只靠digest或从current history/provider cache重算替代frozen checkpoint。

#### 4.5.3 `RecoverySourceVersion`

```ts
type RecoverySourceVersion = Readonly<{
  version: 1
  aggregateID: RecoveryAggregateID
  sourceAssistantID: RecoveryAssistantID
  highWater: SafeNonNegativeInt
  eventChain: { hashVersion: 1; headDigest: EventChainDigest }
  factsDigest: SourceFactsDigest
  eventTypeSetVersion: RecoveryEventTypeSetVersion
  fieldSetRegistryVersion: RecoveryFieldSetRegistryVersion
  allowedEventSetDigest: SourceAllowedEventSetDigest
  fieldSets: readonly RecoveryFieldSetRefV1[]
  providerPrefix?: ProviderPrefixCheckpoint
  versionDigest: RecoverySourceVersionDigest
}>
```

不变量：绑定`0..highWater`完整aggregate event chain和仅source assistant的versioned source facts；`eventTypeSetVersion=1`、`fieldSetRegistryVersion=1`、`allowedEventSetDigest`必须与LLM-owned enriched `RecoveryEventRegistryV1` source digest exact match；`fieldSets`按registry tuple顺序、无duplicate，且每个entry属于source set。`versionDigest`由`source-version-v1` exact builder覆盖前述全部字段（排除自身）。未知event/field-set/registry version、gap、duplicate、extra authority field失败。source facts冻结后不修改。

#### 4.5.4 `RecoveryControlTailVersion`

```ts
type RecoveryControlTailVersion = Readonly<{
  version: 1
  aggregateID: RecoveryAggregateID
  sourceAssistantID: RecoveryAssistantID
  fromExclusive: SafeNonNegativeInt
  toInclusive: SafeNonNegativeInt
  eventCount: SafeNonNegativeInt
  previousSourceHead: EventChainDigest
  tailHash: EventChainDigest
  emptyTailGenesis: EventChainDigest
  eventTypeSetVersion: RecoveryEventTypeSetVersion
  fieldSetRegistryVersion: RecoveryFieldSetRegistryVersion
  allowedEventSetDigest: ControlAllowedEventSetDigest
  fieldSets: readonly RecoveryFieldSetRefV1[]
  versionDigest: RecoveryControlTailDigest
}>
```

不变量：`fromExclusive==sourceVersion.highWater`且`previousSourceHead==sourceVersion.eventChain.headDigest`；registry versions与control allowed-set digest必须exact match。empty tail时`toInclusive==fromExclusive`、count=0、`fieldSets=[]`，`tailHash==emptyTailGenesis`；`emptyTailGenesis`固定等于`previousSourceHead`（空fold identity），不是全零、caller常量或另一个未注册event-chain input。非空区间连续且count=`toInclusive-fromExclusive`，每项只可为control set 8–10。普通input/config/history/tool/source event、unknown recovery event、gap/duplicate均invalid。`versionDigest`由`control-tail-v1`覆盖全部字段（排除自身）。

#### 4.5.5 `TypedIncompleteTerminalFact` 与 `RecoveryConsumptionRef`

```ts
export type TypedIncompleteTerminalFact = Readonly<{
  version:1
  sessionID:string
  assistantID:RecoveryAssistantID
  kind:"canonical-incomplete-stream"|"clean-eof-without-settled-step"
  publicMessageKind:"adapter-incomplete"|"clean-eof"|"empty-unknown-finish"
  terminalSeq:SafeNonNegativeInt
  preTerminalFactsDigest:SourceFactsDigest
}>
type RecoveryConsumptionRef = Readonly<{
  version:1
  decisionID:RecoveryDecisionID
  revision:SafeNonNegativeInt
  sourceAssistantID:RecoveryAssistantID
  childAssistantID:RecoveryAssistantID
  bindingDigest:BindingDigest
  operationID:RecoveryOperationID
  committedSequence:SafeNonNegativeInt
}>
```

terminal branch只覆盖架构§4.6两条typed入口；ordinary interrupt/context-overflow/permission/max-step不编码成incomplete。`preTerminalFactsDigest`只绑定terminal之前的source facts，避免final facts digest自引用；decision/child/timestamp不在terminal source fact。Consumption仅对应automatic consumed record；child/source不同；不含runtime handle；snapshot ref与latestDecision/control-tail atomic operation exact equal。

#### 4.5.6 `DurableRecoverySnapshot`

```ts
export type DurableRecoverySnapshot = Readonly<{
  version:1
  sessionID:string
  sourceContext:CommittedDispatchAttemptContext
  terminal:TypedIncompleteTerminalFact
  dispatches:readonly DispatchEvidence[]
  tools:CanonicalToolEvidencePartitionV1
  reasoning:readonly ReasoningEvidence[]
  sourceVersion:RecoverySourceVersion
  controlTailVersion:RecoveryControlTailVersion
  durableContinuation?:ProviderPrefixCheckpoint
  latestDecision?:RecoveryDecisionRecord
  consumption?:RecoveryConsumptionRef
  assistantPublicMapping:RecoveryAssistantPublicMappingV1
}>
```

禁止字段：current config、planned target/storage、closure、runtime handle、new candidate identity。

不变量：transaction-consistent；arrays按stable identity排序且无duplicate；terminal属于source assistant；source/control versions覆盖snapshot引用的全部authoritative source facts。`tools`必须是§4.4.5 total/disjoint partition并包含同一WAL snapshot内全部authoritative及compatibility-only tool facts：compatibility不进入source facts digest、不被提升为authority，但绝不能被省略或折叠成empty。SafeRetry只允许`truly-empty`；Continue只允许`authoritative-only`且每项final-after-hook-settled；compatibility-only/mixed及任何中间phase固定不能automatic。authoritative tool/reasoning/provider-prefix中的每个Continue payload carrier与对应commitment都必须已完成materialize→strict decode→canonical re-encode→builder/F22验证，且其raw operation属于`sourceVersion`；snapshot不得只保存digest而丢payload，也不得从Legacy/current history补payload。`assistantPublicMapping`由M4在读取同一raw/materialization/Legacy assistant-message relation的WAL snapshot时产生；其`snapshotIdentity`必须逐字段等于本snapshot的session/source assistant/source high-water/source version digest/control-tail version digest，并且`latestDecisionRevision`的presence/value精确等于`latestDecision?.revision`。mapping entries只是internal `RecoveryAssistantID`到既有public `SessionV1.MessageID` relation的只读证据，不是display-ID map、public authority或history-derived猜测；M7 SafeRetry仍必须对source lookup执行absent/ambiguous/wrong-role/stale closed exits。M4 later构造的snapshot-bound nominal automatic/tool/sealed-use proofs不属于`DurableRecoverySnapshot`结构，也不由M1定义。

### 4.6 Planned materialization、AdmissionPlan 与 policy

#### 4.6.1 `RecoveryClosureDescriptor`

```ts
export type RecoveryClosureDescriptor =
  | { status:"not-needed"; action:"safe-retry" }
  | {
      status:"available"
      action:"continue-after-settled-tools"
      sourceBinding:Readonly<{
        aggregateID:RecoveryAggregateID
        sourceAssistantID:RecoveryAssistantID
        sourceVersionDigest:RecoverySourceVersionDigest
        controlTailVersionDigest:RecoveryControlTailDigest
      }>
      toolCalls: readonly Readonly<{
        callOrdinal:SafeNonNegativeInt
        callID:string
        name:string
        executionKind:"local"
        phase:Extract<ToolExecutionPhaseV1,{phase:"final-after-hook-settled"}>
        arguments:RecoveryReplayPayloadV1 & Readonly<{valueKind:"canonical-wire-value"}>
        terminalPayload:ToolTerminalReplayPayloadV1
        finalPlanDigest:ToolPlanDigest
        callDigest:ToolCallDigest
        resultDigest:ToolResultDigest
      }>[]
      reasoning: readonly Readonly<{
        blockID:string
        mode:Exclude<ReasoningContinuationModeV1,"none"|"unknown">
        provenance:"provider-end"
        content:RecoveryReplayPayloadV1 & Readonly<{valueKind:"utf8-text"}>
        textDigest:ReasoningTextDigest
        stateRefs:readonly SealedRecoveryMaterialRef[]
      }>[]
      providerPrefix:ProviderPrefixCheckpoint
      closureDigest:RecoveryClosureDigest
    }
```

类型不变量：SafeRetry只能`not-needed`，并要求source snapshot的tool partition精确为`truly-empty`；Continue只能available，要求partition精确为`authoritative-only`且每项phase为`final-after-hook-settled`。Continue descriptor是M7在M2前从M4 snapshot-bound view构造的target-neutral/provider-neutral durable closure：不得含final target、storage mode或capability descriptor version；`sourceBinding`逐字段绑定同一snapshot的aggregate/source/sourceVersion/controlTail，closure中的每个tool/reasoning/provider-prefix carrier与digest必须canonical equal于该snapshot，不得只复制digest、从Legacy/current history补内容或丢弃compatibility事实后构造。toolCalls只允许settled local/client function call，server/hosted/provider-executed kind不能出现；arguments、result/error、reasoning text及provider prefix均是可重建carrier，且对应owner digest已按§4.4.5复验。reasoning只收集具有provider-end provenance的`signed`或`stored-reference` content+sealed refs，不在此阶段按provider/storage删减或接受。tool/reasoning按durable order排列，duplicate call/result非法。

M7实际构造`ModelMessage[]`时只能解析descriptor中这些snapshot-bound carriers：inline直接取exact value，sealed只可通过M4-owned nominal sealed-use lease/unseal path读取并重新执行scope/purpose/material commitment、canonical decode/re-encode及owner digest验证；one-way digest、public projection、Legacy message、provider cache或current cursor均不是reconstruction source。M2唯一paused preparation产生final target/protocol/storage/body后，M7 `validatePreparedRecoveryInspection({candidate,inspection})`才以inspection target调用provider-specific allowlist/closure validators；不适配该final target的reasoning/tool形态返回typed unavailable，不能静默删除或在M2前预判。

生命周期：M7从M4 snapshot-bound view构造provider-neutral descriptor；M2把它纳入唯一final prepared request并产生原始inspection；M7在same object上完成provider-specific validation；M5随后验证planned materialization，M6不修改；M8不可消费。M1仅export descriptor shape，不拥有M4 nominal snapshot/tool/sealed-use proofs。

#### 4.6.2 `PlannedRecoveryMaterialization`

schema-safe descriptor：

```ts
type CanonicalManualStopCauseV1 = RecoveryFailureCause extends infer C
  ? C extends RecoveryFailureCause ? Readonly<Omit<C,"detail">> : never
  : never

type ManualStopPlanningEvidenceCommitmentV1 = Readonly<{
  version:1
  evidenceKind:"manual-stop-planning"
  action:AutomaticRecoveryAction
  materialization:
    | Readonly<{status:"unavailable";cause:CanonicalManualStopCauseV1}>
    | Readonly<{status:"available";authorizationUse:"not-selected-for-release"}>
}>

type ManualStopClosureStatusV1 =
  | Readonly<{status:"not-attempted";action:AutomaticRecoveryAction}>
  | Readonly<{status:"not-needed";action:"safe-retry"}>
  | Readonly<{status:"available";action:"continue-after-settled-tools"}>
  | Readonly<{status:"unavailable";action:AutomaticRecoveryAction;cause:CanonicalManualStopCauseV1}>

type ManualStopHandleClosureCommitmentV1 =
  | Readonly<{
      version:1
      kind:"no-handle"
      proofContract:"m2-no-prepared-handle-v1"
      candidateContext:CandidateDispatchAttemptContext
      state:"no-prepared-handle"
    }>
  | Readonly<{
      version:1
      kind:"mechanically-cancelled"
      proofContract:"m2-mechanically-cancelled-unreleased-handle-v1"
      candidateContext:CandidateDispatchAttemptContext
      pausedHandleCommitment:PausedHandleCommitment
      released:false
      sendClosureReachable:false
    }>

export type PlannedRecoveryMaterializationDescriptor =
  | {
      status:"available"; version:1; dispatchKind:"automatic-recovery"; action:AutomaticRecoveryAction;
      context:CandidateDispatchAttemptContext; target:DispatchTarget; targetDigest:DispatchTargetDigest;
      safetyDomain:ProviderSafetyDomain; storageMode:StorageMode;
      semanticDigest:SemanticDigest; preparedDigest:PreparedDigest;
      replayFence:ProviderReplayFence; capabilities:ProviderCapabilitySummary;
      authorization:ProviderAuthorizationCommitment; closure:RecoveryClosureDescriptor;
      pausedHandleDescriptor:PausedHandleDescriptorV1;
    }
  | {
      status:"unavailable"; version:1; dispatchKind:"automatic-recovery"; action:AutomaticRecoveryAction;
      cause:RecoveryFailureCause
      planningEvidence:ManualStopPlanningEvidenceCommitmentV1 & Readonly<{
        materialization:Readonly<{status:"unavailable";cause:CanonicalManualStopCauseV1}>
      }>
      handleClosure:Extract<ManualStopHandleClosureCommitmentV1,{kind:"no-handle"}>
    }
```

LLM runtime wrapper：

```ts
export type PlannedRecoveryMaterialization<Handle> =
  | Readonly<{
      descriptor:Extract<PlannedRecoveryMaterializationDescriptor,{status:"available"}>
      pausedHandle:Handle
    }>
  | Readonly<{
      descriptor:Extract<PlannedRecoveryMaterializationDescriptor,{status:"unavailable"}>
    }>
```

`CanonicalManualStopCauseV1`删除diagnostic-only `detail`，保留source/kind及branch-applicable stable subject（tool `callID`或supersession `operationID`）。manual binding中的cause tuple先按其F23映射reason在`ManualStopReasons`中的rank排序，同rank再按该canonical cause的F17 bytes排序并dedup；`reasons`必须恰为F23对该tuple的stable结果。`ManualStopPlanningEvidenceCommitmentV1`与`ManualStopHandleClosureCommitmentV1`都不是新增digest domain：它们是`binding-v1` manual branch的exact canonical members，最终只由`BindingDigest`承诺，故25-domain registry保持不变。

handle closure commitment只投影M2 owner validator确认后的branch事实，不复制或持久化M2 proof capability。`no-handle`要求M4在type-8 first-application内、写raw cursor前调用M2 no-handle validator；`mechanically-cancelled`要求caller先完成mechanical cancellation与K9，再由cleanup把live cancelled proof转换为secret-free one-shot cancel-proof tombstone，M4在type-8 first-application内、写raw cursor前调用M2 tombstone validator并比较同一candidate/paused commitment。cleanup前的live cancelled-unreleased validation只属于M2 cleanup自身的conversion precondition，不授权M4 commit；cleanup后只有same exact tombstone可授权一次type-8 validation，complete result后立即失效。M1不创建proof、不查询M2 registry、不拥有proof lifecycle或persistence。

不变量：runtime wrapper绝不把`pausedHandle`作为descriptor extra field；available exact为`{descriptor,pausedHandle}`，unavailable exact为仅`{descriptor}`。pausedHandle是runtime-only linear resource，不可encode/digest/log；available descriptor时provider hits=0且`dispatchKind`固定automatic-recovery；unavailable descriptor不得携带target/targetDigest/semanticDigest/preparedDigest/authorization/closure/paused handle或虚构这些材料，只携canonical planning evidence与validated no-handle commitment。

#### 4.6.3 `RecoveryPolicyInput` / frozen digest input / provenance

```ts
export type SessionRecoveryExperimentalConfigV1 = Readonly<{
  max_incomplete_recoveries?: SafeNonNegativeInt
  max_model_assistants?: SafePositiveInt
}>
export type SessionRecoveryExternalConfigProjectionV1 = Readonly<{
  experimental?: Readonly<{
    session_recovery?: SessionRecoveryExperimentalConfigV1
  }>
  agent?: Readonly<{
    steps?: SafePositiveInt
  }>
}>
export type RecoveryPolicyInput = Readonly<{
  maxIncompleteRecoveries?: SafeNonNegativeInt
  maxModelAssistants?: SafePositiveInt
  agentSteps?: SafePositiveInt
}>

export type RecoveryPolicyDigestInputV1 = Readonly<{
  version: 1
  defaultSemanticsVersion: 1
  maxIncompleteRecoveries: SafeNonNegativeInt
  configuredMaxModelAssistants: SafePositiveInt
  agentSteps: { kind: "absent" } | { kind: "present"; value: SafePositiveInt }
  effectiveMaxModelAssistants: SafePositiveInt
}>

type RecoveryPolicyProvenanceV1 = Readonly<{
  version: 1
  maxIncompleteRecoveries: "default-n2-v1" | "explicit-config"
  configuredMaxModelAssistants: "default-m64-v1" | "explicit-config"
  agentSteps: "absent" | "explicit-agent-config"
}>

export type NormalizedRecoveryPolicy = Readonly<{
  version: 1
  digestInput: RecoveryPolicyDigestInputV1
  provenance: RecoveryPolicyProvenanceV1
  policyDigest: RecoveryPolicyDigest
}>

export type RecoveryAdmissionPolicyBindingV1 = Readonly<{
  scopeKey: RecoveryPolicyScopeKey
  epoch: SafeNonNegativeInt
  policyDigest: RecoveryPolicyDigest
  defaultSemanticsVersion: 1
  controlPolicyDigest: ControlPolicyDigest
}>
```

external config codec的recovery wire paths冻结为`experimental.session_recovery.max_incomplete_recoveries`与`experimental.session_recovery.max_model_assistants`，并读取既有`agent.steps`作为effective-M输入；三个leaf只接受JSON number，分别通过`Number.isSafeInteger`+N `>=0`、M/steps `>=1` refinement，拒绝string/coercion/float/`-0`/unsafe integer/null。recovery leaf不得接受camelCase或其它alias wire key。`session_recovery`省略、recovery leaf省略均表示使用默认；canonical encode时默认值2/64省略对应recovery leaf，`agent.steps` absent保持omit、present保持原safe positive integer。deterministic mapping只允许`max_incomplete_recoveries → maxIncompleteRecoveries`、`max_model_assistants → maxModelAssistants`、`agent.steps → agentSteps`。

external/internal policy codecs均为M1 exports；external codec拥有snake_case nested config wire，internal codec拥有camelCase M1 wire，二者不得共享“接受两种key”的宽松decoder：

```ts
export type RecoveryPolicyInternalWireV1 = Readonly<{
  maxIncompleteRecoveries?:SafeNonNegativeInt
  maxModelAssistants?:SafePositiveInt
  agentSteps?:SafePositiveInt
}>
export type RecoveryPolicyCodecError = ConfigCodecError | FieldSetError

export function decodeRecoveryPolicyConfig(
  input:unknown,
):ContractResult<RecoveryPolicyInput,RecoveryPolicyCodecError>
export function encodeRecoveryPolicyConfig(
  input:RecoveryPolicyInput,
):ContractResult<SessionRecoveryExternalConfigProjectionV1,RecoveryPolicyCodecError>
export function decodeRecoveryPolicyInputV1(
  input:unknown,
):ContractResult<RecoveryPolicyInput,RecoveryPolicyCodecError>
export function encodeRecoveryPolicyInputV1(
  input:RecoveryPolicyInput,
):ContractResult<RecoveryPolicyInternalWireV1,RecoveryPolicyCodecError>
```

- **callers/callees**：external decode/encode仅由config owner、M6 config freeze调用；internal decode/encode仅由M1/M6 durable/control-policy boundary调用。四者callee只有F4 exact-field validator与safe-integer refinements；F4 pre为对应wire spec、post为无missing/extra/null/coercion，integer refinement post为branded范围。
- **Requires**：decode输入为unknown；encode输入必须是typed `RecoveryPolicyInput`且不得包含prototype/symbol/non-enumerable authority字段。
- **Ensures**：external decode只投影三个既定paths；external encode只写snake_case recovery leaves与既有`agent.steps`并执行default omission；internal decode/encode只接受/产生三个camelCase M1 fields，字段omit语义保持。所有返回均fresh exact object。
- **连续分支/退出**：1) plain-object检查；2) exact key检查；3) leaf逐项safe-integer refinement；4) external↔internal唯一映射；5) canonical omission；6) final F4复检；任一步失败返回`ContractResult.ok=false`且不返回partial projection，全部成功返回`ok:true`。
- **副作用/残留**：纯解析与fresh allocation；不改config、不写日志/DB/cache，无durable residue。
- **进度/终止**：固定最多三个leaf与两个nested object，有限扫描后终止。
- **§4.3.2 proof（pre→intermediate facts→post+side effect）**：pre给出unknown或typed input；步骤1–2建立I1“只存在owner wire keys”；步骤3建立I2“三leaf范围精确”；步骤4建立I3“映射双射且无alias”；步骤5建立I4“default omission唯一”；步骤6建立I5“输出exact”。I1∧I2∧I3∧I4∧I5推出上述Ensures；所有callee纯，因此副作用/残留为空且穷尽。

external codec不得静默丢弃`session_recovery` unknown field；internal codec拒绝snake_case、external codec拒绝camelCase。

默认与等价语义冻结如下：N absent归一为2，M absent归一为64；explicit N=2与default N=2在admission/binding上**等价并产生相同policyDigest**，explicit M=64同理。provenance单独保留用于internal diagnostics/audit，不进入policyDigest、binding digest、reason identity或public projection；因此不能借配置来源改变admission authority。`agentSteps` absent与present value不同，因为present参与effective M；其closed absent/present discriminator进入digest。任何未来改变默认值或上述等价规则必须提升`defaultSemanticsVersion`与domain input version。

不变量：不clamp，不接受float/negative/non-safe/string；N只计incomplete child；M只计committed model assistant，shell不计；semantic dispatch/model step/physical request均不计。`RecoveryAdmissionPolicyBindingV1`的四个admission authority字段`scopeKey/epoch/policyDigest/defaultSemanticsVersion`在AdmissionPlan、binding、operations 1/2/9、admission proof与receipt中逐项保留；`controlPolicyDigest`只能由`control-policy-v1` exact builder对同一四元组构造。M4必须验证session owner映射到该scope；epoch是该scope内单调版本，不可由caller自选。

#### 4.6.4 Heads 与 `AdmissionPlan`

```ts
type RecoveryHeadV1 =
  | { kind: "genesis"; sourceAssistantID: RecoveryAssistantID }
  | { kind: "record"; sourceAssistantID: RecoveryAssistantID; decisionID: RecoveryDecisionID; revision: SafeNonNegativeInt; operationID: RecoveryOperationID }
export type AssistantChainHeadV1 =
  | { kind: "genesis"; sessionID: string; chainID: RecoveryChainID }
  | { kind: "assistant"; assistant: CommittedAssistantAttemptIdentity }
type DispatchLedgerHeadV1 =
  | { kind: "genesis"; sessionID: string; assistantID: RecoveryAssistantID }
  | { kind: "dispatch"; context: CommittedDispatchAttemptContext }
export type AggregateEventHeadV1 =
  | { kind: "genesis"; aggregateID: RecoveryAggregateID; digest: EventChainDigest }
  | { kind: "event"; aggregateID: RecoveryAggregateID; sequence: SafeNonNegativeInt; digest: EventChainDigest }

export type AdmissionPlan = Readonly<{
  version: 1
  candidateContext: CandidateDispatchAttemptContext
  expectedHeads: {
    recoveryHead: RecoveryHeadV1
    assistantChainHead: AssistantChainHeadV1
    dispatchLedgerHead: DispatchLedgerHeadV1
    aggregateEventHead: AggregateEventHeadV1
  }
  policy: NormalizedRecoveryPolicy
  scopeKey: RecoveryPolicyScopeKey
  epoch: SafeNonNegativeInt
  policyDigest: RecoveryPolicyDigest
  defaultSemanticsVersion: 1
  nAvailable: boolean
  mAvailable: boolean
  controlPolicyDigest: ControlPolicyDigest
  bindingPolicyVersion: 1
}>
```

initial/ordinary admission只使用assistant-chain、dispatch-ledger与aggregate heads；automatic composite还使用recovery head。`scopeKey/epoch/policyDigest/defaultSemanticsVersion`必须与`policy.digestInput`、session policy scope和`controlPolicyDigest`互相一致。`nAvailable`恰等于candidate recovery ordinal `<= N`；`mAvailable`恰等于candidate assistant sequence `< effective M`。M4首次应用transaction必须按session owner mapping重读当前scope policy/epoch、committed counts/heads并重新计算，不能信任旧boolean或candidate brand；exact replay不得以新current policy否定历史commit，而必须验证stored operation中的完整historical policy binding、digest、counts与folded post-state。

### 4.7 Proposal、record、receipts 与 public projection

#### 4.7.1 Actions 与 proposal

```ts
export type AutomaticRecoveryAction = "safe-retry" | "continue-after-settled-tools"
export type RecoveryProposal =
  | { kind:"automatic"; action:AutomaticRecoveryAction; bindingDigest:BindingDigest }
  | { kind:"manual-stop"; action:AutomaticRecoveryAction; reasons:NonEmptyReadonlyArray<ManualStopReason>; bindingDigest:BindingDigest }
```

不变量：proposal无 decisionID/revision/operationID/timestamp/authority；ManualStop action显式、reasons stable order/dedup/non-empty且binding digest mandatory；automatic同样必须有binding digest。manual binding可在planned unavailable且没有target/semantic/prepared digest时构造，禁止用optional binding或虚构available material填洞。

#### 4.7.2 `RecoveryDecisionRecord`

```ts
type RecoveryDecisionRecordCommonV1 = Readonly<{
  version:1
  decisionID:RecoveryDecisionID
  revision:SafeNonNegativeInt
  sourceAssistantID:RecoveryAssistantID
  operationID:RecoveryOperationID
  committedSequence:SafeNonNegativeInt
  createdAt:string // RFC3339 UTC，仅audit，任何canonical commitment均排除
}>
export type RecoveryDecisionRecord =
  | (RecoveryDecisionRecordCommonV1 & { action:"manual-stop"; status:"finalized"; bindingDigest:BindingDigest; reasons:NonEmptyReadonlyArray<ManualStopReason> })
  | (RecoveryDecisionRecordCommonV1 & { action:AutomaticRecoveryAction; status:"consumed"; bindingDigest:BindingDigest; childAssistantID:RecoveryAssistantID })
  | (RecoveryDecisionRecordCommonV1 & { action:"manual-stop"; status:"superseded"; supersessionBindingDigest:SupersessionBindingDigest; reasons:readonly ["superseded-by-new-user-input"] })
```

`NonEmptyReadonlyArray<T>`精确定义为`readonly [T,...T[]]`。first revision=0，后续exact +1；automatic只有consumed+unique child并携automatic `BindingDigest`；manual finalized reasons按24 tuple并携manual `BindingDigest`；superseded只有固定singleton reason且只携`SupersessionBindingDigest`，不得要求或携带automatic/manual binding。各branch未列字段禁止，例如automatic不得含reasons、manual不得含child、superseded不得含`bindingDigest`。createdAt必须合法RFC3339 UTC但不进入semantic/prepared/binding/policy/operation payload以外的commitment（作为raw audit payload仍受operation payload digest保护）。

#### 4.7.3 Exact receipt、raw-operation proof 与folded post-state

```ts
export type RecoveryOperationLookupKeyV1<T extends RecoveryOperationType = RecoveryOperationType> = Readonly<{
  sessionID:string
  aggregateID:RecoveryAggregateID
  operationID:RecoveryOperationID
  expectedOperationType:T
}>

type CommittedRawOperationProofV1 = Readonly<{
  envelopeVersion: 1
  operationID: RecoveryOperationID
  aggregateID: RecoveryAggregateID
  aggregateSequence: SafeNonNegativeInt
  operationType: RecoveryOperationType
  fieldSetVersion: 1
  payloadDigest: OperationPayloadDigest
  previousDigest: EventChainDigest
  nextDigest: EventChainDigest
}>

type AssistantAdmissionProofV1 = Readonly<{
  scopeKey: RecoveryPolicyScopeKey
  epoch: SafeNonNegativeInt
  policyDigest: RecoveryPolicyDigest
  defaultSemanticsVersion: 1
  controlPolicyDigest: ControlPolicyDigest
  effectiveMaxModelAssistants: SafePositiveInt
  committedAssistantCountBefore: SafeNonNegativeInt
  candidateAssistantSequence: SafeNonNegativeInt
  mAvailable: true
}>

type AvailableAssistantAdmissionReceiptV1 = Readonly<{
  receiptVersion: 1
  receiptKind: "assistant-admission"
  evidenceKind: "available"
  admissionKind: "initial" | "ordinary"
  operation: CommittedRawOperationProofV1
  admission: AssistantAdmissionProofV1
  assistant: CommittedAssistantAttemptIdentity
  dispatch: CommittedDispatchAttemptContext
  preparedDispatchKind: PreparedDispatchKindV1
  target: DispatchTarget
  targetDigest: DispatchTargetDigest
  preparedDigest: PreparedDigest
  pausedHandleCommitment: PausedHandleCommitment
  postHeads: { assistantChainHead: AssistantChainHeadV1; dispatchLedgerHead: DispatchLedgerHeadV1; aggregateEventHead: AggregateEventHeadV1 }
}>

type OpaqueAssistantAdmissionReceiptV1 = Readonly<{
  receiptVersion: 1
  receiptKind: "assistant-admission"
  evidenceKind: "opaque"
  admissionKind: "initial" | "ordinary"
  operation: CommittedRawOperationProofV1
  admission: AssistantAdmissionProofV1
  assistant: CommittedAssistantAttemptIdentity
  dispatch: CommittedDispatchAttemptContext
  cause: RecoveryFailureCause
  pausedHandleCommitment: PausedHandleCommitment
  postHeads: { assistantChainHead: AssistantChainHeadV1; dispatchLedgerHead: DispatchLedgerHeadV1; aggregateEventHead: AggregateEventHeadV1 }
}>

type AvailableSubsequentDispatchReceiptV1 = Readonly<{
  receiptVersion: 1
  receiptKind: "subsequent-dispatch"
  evidenceKind: "available"
  operation: CommittedRawOperationProofV1
  dispatch: CommittedDispatchAttemptContext
  preparedDispatchKind: PreparedDispatchKindV1
  target: DispatchTarget
  targetDigest: DispatchTargetDigest
  preparedDigest: PreparedDigest
  pausedHandleCommitment: PausedHandleCommitment
  postHeads: { dispatchLedgerHead: DispatchLedgerHeadV1; aggregateEventHead: AggregateEventHeadV1 }
}>

type OpaqueSubsequentDispatchReceiptV1 = Readonly<{
  receiptVersion: 1
  receiptKind: "subsequent-dispatch"
  evidenceKind: "opaque"
  operation: CommittedRawOperationProofV1
  dispatch: CommittedDispatchAttemptContext
  cause: RecoveryFailureCause
  pausedHandleCommitment: PausedHandleCommitment
  postHeads: { dispatchLedgerHead: DispatchLedgerHeadV1; aggregateEventHead: AggregateEventHeadV1 }
}>

export type AutomaticRecoveryAdmissionReceiptV1 = Readonly<{
  receiptVersion: 1
  receiptKind: "automatic-recovery"
  evidenceKind: "available"
  operation: CommittedRawOperationProofV1
  decision: RecoveryDecisionRecord
  sourceVersion: RecoverySourceVersion
  controlTailVersion: RecoveryControlTailVersion
  bindingDigest: BindingDigest
  childAssistant: CommittedAssistantAttemptIdentity
  childDispatch: CommittedDispatchAttemptContext
  preparedDispatchKind: PreparedDispatchKindV1
  target: DispatchTarget
  targetDigest: DispatchTargetDigest
  preparedDigest: PreparedDigest
  pausedHandleCommitment: PausedHandleCommitment
  admission: AssistantAdmissionProofV1 & { nAvailable: true; maxIncompleteRecoveries: SafeNonNegativeInt }
  postHeads: {
    recoveryHead: RecoveryHeadV1
    assistantChainHead: AssistantChainHeadV1
    dispatchLedgerHead: DispatchLedgerHeadV1
    aggregateEventHead: AggregateEventHeadV1
  }
}>

type SourceFactReceiptV1 = Readonly<{
  receiptVersion:1
  receiptKind:"source-fact"
  factKind:"tool"|"reasoning"|"provider-prefix"|"incomplete-terminal"
  operation:CommittedRawOperationProofV1
}>
type DecisionFinalizedReceiptV1 = Readonly<{
  receiptVersion:1
  receiptKind:"decision-finalized"
  operation:CommittedRawOperationProofV1
  decision:Extract<RecoveryDecisionRecord,{action:"manual-stop";status:"finalized"}>
  bindingInput:ManualStopBindingDigestInputV1
  bindingDigest:BindingDigest
  handleClosure:ManualStopHandleClosureCommitmentV1
  postHeads:{recoveryHead:RecoveryHeadV1;aggregateEventHead:AggregateEventHeadV1}
}>
type SourceSupersededReceiptV1 =
  | Readonly<{
      receiptVersion:1
      receiptKind:"source-superseded"
      supersessionKind:"model"
      operation:CommittedRawOperationProofV1
      decision:Extract<RecoveryDecisionRecord,{status:"superseded"}>
      reservedInitialOperationID:RecoveryOperationID
      supersessionBindingInput:Extract<SupersessionBindingDigestInputV1,{kind:"model"}>
      supersessionBindingDigest:SupersessionBindingDigest
      postHeads:{recoveryHead:RecoveryHeadV1;aggregateEventHead:AggregateEventHeadV1}
    }>
  | Readonly<{
      receiptVersion:1
      receiptKind:"source-superseded"
      supersessionKind:"no-reply"
      operation:CommittedRawOperationProofV1
      decision:Extract<RecoveryDecisionRecord,{status:"superseded"}>
      supersessionBindingInput:Extract<SupersessionBindingDigestInputV1,{kind:"no-reply"}>
      supersessionBindingDigest:SupersessionBindingDigest
      postHeads:{recoveryHead:RecoveryHeadV1;aggregateEventHead:AggregateEventHeadV1}
    }>

export type AuthorityReceiptV1 =
  | AvailableAssistantAdmissionReceiptV1 | OpaqueAssistantAdmissionReceiptV1
  | AvailableSubsequentDispatchReceiptV1 | OpaqueSubsequentDispatchReceiptV1
  | AutomaticRecoveryAdmissionReceiptV1
  | SourceFactReceiptV1 | DecisionFinalizedReceiptV1 | SourceSupersededReceiptV1

export type DispatchReceiptV1 = Extract<AuthorityReceiptV1,{receiptKind:"assistant-admission"|"subsequent-dispatch"}>
export type RecoveryAdmissionReceiptV1 = Extract<AuthorityReceiptV1,{receiptKind:"automatic-recovery"}>
```

上述带`V1`名称是M1向M4/M2/M6导出的唯一canonical receipt names；不另导出无`V1`的`AssistantAdmissionReceipt`、`DispatchReceipt`、`RecoveryAdmissionReceipt`等informal aliases。每个receipt exact且immutable。`operation.operationType`必须与receiptKind/admissionKind对应：initial→1、ordinary→2、subsequent→3、decision-finalized→8、automatic→9。receipt只陈述committed raw proof与folded authority facts，不记录首次应用还是exact replay；initial/ordinary证明M admission、committed assistant/dispatch与相关heads，available receipt还证明`preparedDispatchKind`与context origin一致；type-8 receipt逐项携manual branch `bindingInput/bindingDigest/handleClosure`，使planned unavailable时无需target/semantic/prepared digest仍可验证；type-10 receipt逐branch携完整supersession input/digest，model另携reserved initial operation ID，no-reply不携reservation；automatic额外证明N、decision/consumption与three-head。opaque variant明确禁止target/targetDigest/preparedDigest/replay proof。detached receipt是observation-only value；transport authorization必须接收完整`OperationCommitResultV1<T>`并把其中`receipt + operationPostState`一起交F26/F27，不能只凭receipt授权。receipt不是public projection。

`RecoveryOperationLookupKeyV1<T>`是M1提供给M4 response-loss/read-back边界的唯一operation lookup identity shape；operation ID只在dedicated aggregate scope内判唯一，因此任何`lookupReceipt(operationID)`或仅operationID的result cache key均禁止。M4 lookup必须至少携`sessionID+aggregateID+operationID+expectedOperationType`，并在返回row/result前验证owner mapping与type；M1只定义输入shape，不拥有index、lookup I/O或persistence。

`FoldedAssistantAdmissionPostStateV1`、`FoldedSubsequentDispatchPostStateV1`、`FoldedAutomaticRecoveryPostStateV1`是M4将对应raw operation从aggregate genesis连续fold到该operation已存`aggregateSequence`后的exact operation post-state；它们只能由F5 decode + projector fold构造，是F26/F27的对照输入，不可由caller从receipt反构造，也不携带首次应用/replay模式。

#### 4.7.4 `RecoveryChildDisplayID` 与 `RecoveryPublicProjectionV1`

```ts
export type RecoveryChildDisplayID = string & Brand<"RecoveryChildDisplayID">
export type RecoveryPublicProjectionV1 = Readonly<{
  version: 1
  dispatchCount?: SafeNonNegativeInt
  evidence?: "available" | "opaque" | "mixed" | "unknown"
  sourceErrorPreserved?: true
  child?: { displayID: RecoveryChildDisplayID }
  outcome?: "safe-retry" | "continue-after-settled-tools" | "manual-stop" | "unknown"
}>
```

`RecoveryChildDisplayID` validation固定为：UTF-8长度1..128、NFC、无首尾空白/NUL/control、仅ASCII `[A-Za-z0-9][A-Za-z0-9._~-]{0,127}`；它不是`RecoveryAssistantID`、不得cast/解析/查表为authority。M4 transaction/rebuilder唯一拥有display ID allocation/reuse与`(sessionID,committed child assistant)→displayID`映射，确保session内唯一和稳定；M1 F28只消费已验证mapping并纯构造projection，M8只显示或构造非authority link，不能凭displayID读取internal child。删除/不可见child时omit整个child字段。

unknown事实omit而非伪造false/0；未知枚举归一为`unknown`。projection禁止target/authority、ordinal明细、digest、proof、operationID、decisionID/revision、CAS/head、receipt、sealed ref、tool/reasoning metadata。projection永不作为M4 rebuilder/M5/M6/M2输入。

### 4.8 Operation envelope、event sets 与 typed causes

#### 4.8.1 Exact operation inputs

```ts
export type RecoveryOperationType =
  | "initial-chain-genesis-and-dispatch"
  | "ordinary-assistant-and-dispatch-admitted"
  | "subsequent-dispatch-recorded"
  | "tool-evidence-recorded"
  | "reasoning-evidence-recorded"
  | "provider-prefix-recorded"
  | "incomplete-terminal-recorded"
  | "decision-finalized"
  | "automatic-child-admitted-and-consumed"
  | "source-superseded"

type RecoveryEventType =
  | "session.recovery.initial-chain-genesis-and-dispatch"
  | "session.recovery.ordinary-assistant-and-dispatch-admitted"
  | "session.recovery.subsequent-dispatch-recorded"
  | "session.recovery.tool-evidence-recorded"
  | "session.recovery.reasoning-evidence-recorded"
  | "session.recovery.provider-prefix-recorded"
  | "session.recovery.incomplete-terminal-recorded"
  | "session.recovery.decision-finalized"
  | "session.recovery.automatic-child-admitted-and-consumed"
  | "session.recovery.source-superseded"

type RecoveryEventTypeByOperationV1 = {
  "initial-chain-genesis-and-dispatch":"session.recovery.initial-chain-genesis-and-dispatch"
  "ordinary-assistant-and-dispatch-admitted":"session.recovery.ordinary-assistant-and-dispatch-admitted"
  "subsequent-dispatch-recorded":"session.recovery.subsequent-dispatch-recorded"
  "tool-evidence-recorded":"session.recovery.tool-evidence-recorded"
  "reasoning-evidence-recorded":"session.recovery.reasoning-evidence-recorded"
  "provider-prefix-recorded":"session.recovery.provider-prefix-recorded"
  "incomplete-terminal-recorded":"session.recovery.incomplete-terminal-recorded"
  "decision-finalized":"session.recovery.decision-finalized"
  "automatic-child-admitted-and-consumed":"session.recovery.automatic-child-admitted-and-consumed"
  "source-superseded":"session.recovery.source-superseded"
}
type RecoveryEventTypeForV1<T extends RecoveryOperationType> = RecoveryEventTypeByOperationV1[T]

type AvailableDispatchAdmissionV1 = Readonly<{
  kind: "available"
  preparedDispatchKind: PreparedDispatchKindV1
  context: CandidateDispatchAttemptContext
  target: DispatchTarget
  targetDigest: DispatchTargetDigest
  safetyDomain: ProviderSafetyDomain
  storageMode: StorageMode
  semanticDigest: SemanticDigest
  preparedDigest: PreparedDigest
  replayFence: ProviderReplayFence
  capabilities: ProviderCapabilitySummary
  authorization: ProviderAuthorizationCommitment
  pausedHandleCommitment: PausedHandleCommitment
}>
type OpaqueDispatchAdmissionV1 = Readonly<{
  kind: "opaque"
  context: CandidateDispatchAttemptContext
  providerID: string
  modelID: string
  localTools: "present" | "absent" | "unknown"
  cause: RecoveryFailureCause
  pausedHandleCommitment: PausedHandleCommitment
}>
export type DispatchAdmissionV1 = AvailableDispatchAdmissionV1 | OpaqueDispatchAdmissionV1

export type NewLineageReservationRefV1 = Readonly<{
  supersessionOperationID: RecoveryOperationID
  reservationDigest: SupersessionBindingDigest
}>

export type LegacyUserMessagePredecessorV1 = Readonly<{
  sessionID: string
  messageID: string
  messageDigest: CanonicalDigestValue
  role: "user"
}>
type LegacyAssistantMessageGenesisV1 = Readonly<{
  sessionID: string
  messageID: string
  assistantID: RecoveryAssistantID
  role: "assistant"
  parentID: string
  createdAtMs: SafeNonNegativeInt
  modelID: string
  providerID: string
  mode: string
  agent: string
  path: Readonly<{ cwd:string; root:string }>
  variant?: string
  initialAccounting: Readonly<{
    cost: 0
    tokens: Readonly<{ input:0; output:0; reasoning:0; cache:Readonly<{ read:0; write:0 }> }>
  }>
}>

export type RecoveryAssistantPublicMappingV1 = Readonly<{
  version: 1
  snapshotIdentity: Readonly<{
    sessionID: string
    sourceAssistantID: RecoveryAssistantID
    sourceHighWater: SafeNonNegativeInt
    sourceVersionDigest: RecoverySourceVersionDigest
    controlTailVersionDigest: RecoveryControlTailDigest
    latestDecisionRevision?: SafeNonNegativeInt
  }>
  entries: readonly Readonly<{
    assistantID: RecoveryAssistantID
    publicMessageID: SessionV1.MessageID
    role: SessionV1.Info["role"]
  }>[]
}>

type ManualStopDecisionMaterialV1 = Readonly<{
  decisionID: RecoveryDecisionID
  revision: SafeNonNegativeInt
  bindingInput: ManualStopBindingDigestInputV1
  bindingDigest: BindingDigest
  handleClosure: ManualStopHandleClosureCommitmentV1
  createdAt: string
  action: AutomaticRecoveryAction
  reasons: NonEmptyReadonlyArray<ManualStopReason>
}>
type AutomaticConsumedDecisionMaterialV1 = Readonly<{
  decisionID: RecoveryDecisionID
  revision: SafeNonNegativeInt
  createdAt: string
}>
type SupersededDecisionMaterialV1 = Readonly<{
  decisionID: RecoveryDecisionID
  revision: SafeNonNegativeInt
  supersessionBindingInput: SupersessionBindingDigestInputV1
  supersessionBindingDigest: SupersessionBindingDigest
  createdAt: string
}>
```

10个exact predecessor/payload pair如下；列出的字段是完整字段集，未列字段一律extra-field failure：

```ts
export type OperationSchemaByTypeV1 = {
  "initial-chain-genesis-and-dispatch": {
    expectedPredecessors: {
      aggregateEventHead: AggregateEventHeadV1
      assistantChainHead: Extract<AssistantChainHeadV1,{kind:"genesis"}>
      dispatchLedgerHead: Extract<DispatchLedgerHeadV1,{kind:"genesis"}>
    }
    payload: { kind:"initial-chain-genesis-and-dispatch"; sessionID:string; genesis:RecoveryChainGenesisV1; userMessagePredecessor:LegacyUserMessagePredecessorV1; assistantMessage:LegacyAssistantMessageGenesisV1; newLineageReservation?:NewLineageReservationRefV1; policy:NormalizedRecoveryPolicy; scopeKey:RecoveryPolicyScopeKey; epoch:SafeNonNegativeInt; policyDigest:RecoveryPolicyDigest; defaultSemanticsVersion:1; dispatch:DispatchAdmissionV1 }
  }
  "ordinary-assistant-and-dispatch-admitted": {
    expectedPredecessors: {
      aggregateEventHead:AggregateEventHeadV1
      assistantChainHead:Extract<AssistantChainHeadV1,{kind:"assistant"}>
      dispatchLedgerHead:Extract<DispatchLedgerHeadV1,{kind:"genesis"}>
    }
    payload: { kind:"ordinary-assistant-and-dispatch-admitted"; sessionID:string; lineage:RecoveryLineage; assistantMessage:LegacyAssistantMessageGenesisV1; policy:NormalizedRecoveryPolicy; scopeKey:RecoveryPolicyScopeKey; epoch:SafeNonNegativeInt; policyDigest:RecoveryPolicyDigest; defaultSemanticsVersion:1; dispatch:DispatchAdmissionV1 }
  }
  "subsequent-dispatch-recorded": {
    expectedPredecessors: { aggregateEventHead:AggregateEventHeadV1; dispatchLedgerHead:Extract<DispatchLedgerHeadV1,{kind:"dispatch"}> }
    payload: { kind:"subsequent-dispatch-recorded"; sessionID:string; dispatch:DispatchAdmissionV1 }
  }
  "tool-evidence-recorded": {
    expectedPredecessors: { aggregateEventHead:AggregateEventHeadV1 }
    payload: { kind:"tool-evidence-recorded"; sessionID:string; sourceAssistant:CommittedAssistantAttemptIdentity; evidence:AuthoritativeToolEvidenceV1 }
  }
  "reasoning-evidence-recorded": {
    expectedPredecessors: { aggregateEventHead:AggregateEventHeadV1 }
    payload: { kind:"reasoning-evidence-recorded"; sessionID:string; sourceAssistant:CommittedAssistantAttemptIdentity; evidence:ReasoningEvidence }
  }
  "provider-prefix-recorded": {
    expectedPredecessors: { aggregateEventHead:AggregateEventHeadV1 }
    payload: { kind:"provider-prefix-recorded"; sessionID:string; sourceAssistant:CommittedAssistantAttemptIdentity; checkpoint:ProviderPrefixCheckpoint }
  }
  "incomplete-terminal-recorded": {
    expectedPredecessors: { aggregateEventHead:AggregateEventHeadV1 }
    payload: { kind:"incomplete-terminal-recorded"; sessionID:string; sourceAssistant:CommittedAssistantAttemptIdentity; terminal:TypedIncompleteTerminalFact }
  }
  "decision-finalized": {
    expectedPredecessors: { aggregateEventHead:AggregateEventHeadV1; recoveryHead:RecoveryHeadV1 }
    payload: { kind:"decision-finalized"; sessionID:string; sourceVersion:RecoverySourceVersion; controlTailVersion:RecoveryControlTailVersion; decision:ManualStopDecisionMaterialV1 }
  }
  "automatic-child-admitted-and-consumed": {
    expectedPredecessors: {
      aggregateEventHead:AggregateEventHeadV1
      recoveryHead:RecoveryHeadV1
      assistantChainHead:Extract<AssistantChainHeadV1,{kind:"assistant"}>
      dispatchLedgerHead:Extract<DispatchLedgerHeadV1,{kind:"genesis"}>
    }
    payload: {
      kind:"automatic-child-admitted-and-consumed"; sessionID:string
      sourceVersion:RecoverySourceVersion; controlTailVersion:RecoveryControlTailVersion
      proposal:Extract<RecoveryProposal,{kind:"automatic"}>; admission:AdmissionPlan
      scopeKey:RecoveryPolicyScopeKey; epoch:SafeNonNegativeInt; policyDigest:RecoveryPolicyDigest; defaultSemanticsVersion:1
      decision:AutomaticConsumedDecisionMaterialV1
      childAssistantMessage:LegacyAssistantMessageGenesisV1
      childDispatch:AvailableDispatchAdmissionV1
    }
  }
  "source-superseded": {
    expectedPredecessors: { aggregateEventHead:AggregateEventHeadV1; recoveryHead:RecoveryHeadV1 }
    payload:
      | { kind:"source-superseded"; supersessionKind:"model"; sessionID:string; sourceVersion:RecoverySourceVersion; controlTailVersion:RecoveryControlTailVersion; decision:SupersededDecisionMaterialV1; reservedInitialOperationID:RecoveryOperationID; supersessionBindingInput:Extract<SupersessionBindingDigestInputV1,{kind:"model"}>; supersessionBindingDigest:SupersessionBindingDigest }
      | { kind:"source-superseded"; supersessionKind:"no-reply"; sessionID:string; sourceVersion:RecoverySourceVersion; controlTailVersion:RecoveryControlTailVersion; decision:SupersededDecisionMaterialV1; supersessionBindingInput:Extract<SupersessionBindingDigestInputV1,{kind:"no-reply"}>; supersessionBindingDigest:SupersessionBindingDigest }
  }
}
```

payload cross-invariants：operation discriminator、payload.kind与event type一一对应。type 1是**model-lineage genesis**：assistant-chain与新assistant ordinal-0 dispatch-ledger predecessors必须为exact genesis/absent并与`payload.genesis` IDs一致；aggregate predecessor可为genesis或event，但必须等于current `AggregateEventHeadV1`，且只有dedicated recovery aggregate首条operation才允许aggregate genesis。post-supersession type 1的aggregate predecessor必须等于matching type-10 post head。type 2/9的dispatch-ledger genesis assistantID等于candidate child assistant，assistant-chain predecessor sequence恰为candidate-1；9还要求candidate recoveryOrdinal=source lineage+1且sourceAssistantID exact。1的`userMessagePredecessor`必须引用已commit的Legacy user message并由digest验证，A3不得重复创建它；1/2的`assistantMessage`与9的`childAssistantMessage`必须逐项匹配candidate context、dispatch target和relation IDs，成为Legacy assistant info row的raw rebuild source。1/2/9的dispatch ordinal为0，且其`scopeKey/epoch/policyDigest/defaultSemanticsVersion`逐项等于各自`policy`或`admission`中的同名值与control-policy commitment；3的assistant已committed且ordinal=`predecessor+1`；1/2可available或opaque，3可available或opaque，9只available；available dispatch的`preparedDispatchKind`分别固定为1=`initial`、2/3=`ordinary`、9=`automatic-recovery`并与candidate context origin一致；4–7只引用committed source assistant。8只能重建`manual-stop/finalized` record；其`decision.bindingInput`必须是manual-stop branch，source/control版本与payload顶层逐字段equal，material action/reasons/handleClosure与`bindingInput.action/reasons/handleClosure` equal，重建record action固定`manual-stop`，F20重建后F22验证`bindingDigest`。该branch可由planned unavailable构造并明确禁止target/targetDigest/semanticDigest/preparedDigest/authorization/closureDigest；M4 first-application还必须在同一commit内、写raw cursor前以M2 owner validator验证对应live no-handle proof，或验证cleanup由same live cancelled proof转换出的secret-free one-shot cancel-proof tombstone；type-8不得要求cleanup后仍存在cancelled live proof。raw payload/receipt只保存M1 commitment projection，不保存M2 proof capability或tombstone。9从`sourceVersion + proposal + decision + childDispatch + envelope(operationID,aggregateSequence)`确定性重建automatic consumed record；10从完整`supersessionBindingInput`重算`SupersessionBindingDigest`，并由该input + decision + fixed reason + envelope确定性重建superseded record，禁止读取automatic/manual `BindingDigest`。三者的decision ID、revision、对应branch commitment、createdAt、operationID、committedSequence、action/status/reasons/child均不得取自非authority runtime state。8/9/10绑定source/control registry versions及allowed-set digests。

type-10 payload是closed `supersessionKind:"model"|"no-reply"` union，并在两branch持久化完整`supersessionBindingInput`及其`SupersessionBindingDigest`，使F5/replay/rebuild能调用同一builder+F22重算；只存digest/opID而丢失`submissionPayloadDigest`是非法field set。common input绑定payload同一`sourceVersion/controlTailVersion`及digests、session、submission payload digest和exact supersession predecessor heads。`model` branch另绑定`intendedInitialOperationID`且必须等于`reservedInitialOperationID`；它绝不是尚不可知的完整type-1 `OperationPayloadDigest`。后续type-1必须携带`newLineageReservation:{supersessionOperationID,reservationDigest}`，其中`reservationDigest`等于model `SupersessionBindingDigest`；O1/A3分别验证pre-prepare supersession binding与post-prepare完整payload digest，且reservation只能消费一次。`no-reply` branch固定`replyDisposition:"commit-user-only"`，禁止reservation/type1字段，完成old recovery supersession后只允许user-input commit，不允许M7/M2、policy freeze、type-1或任何model assistant admission。`SupersededDecisionMaterialV1`只引用同一supersession input/digest，不含`BindingDigest`。raw secret/runtime handle/public projection不得出现。

#### 4.8.2 `RecoveryOperationInputV1`、`RecoveryOperationEnvelope`、payload digest 与event-chain公式

```ts
export type RecoveryOperationInputV1<T extends RecoveryOperationType = RecoveryOperationType> = Readonly<{
  envelopeVersion: 1
  operationID: RecoveryOperationID
  aggregateID: RecoveryAggregateID
  operationType: T
  fieldSetVersion: 1
  expectedPredecessors: OperationSchemaByTypeV1[T]["expectedPredecessors"]
  payload: OperationSchemaByTypeV1[T]["payload"]
}>

export type RecoveryOperationEnvelope<T extends RecoveryOperationType = RecoveryOperationType> = Readonly<{
  envelopeVersion: 1
  operationID: RecoveryOperationID
  aggregateID: RecoveryAggregateID
  aggregateSequence: SafeNonNegativeInt
  operationType: T
  fieldSetVersion: 1
  expectedPredecessors: OperationSchemaByTypeV1[T]["expectedPredecessors"]
  payload: OperationSchemaByTypeV1[T]["payload"]
  payloadDigest: OperationPayloadDigest
  eventChain: { hashVersion:1; previousDigest:EventChainDigest; nextDigest:EventChainDigest }
}>
```

`OperationPayloadDigestInputV1`精确等于`{envelopeVersion,operationType,fieldSetVersion,expectedPredecessors,payload}`；显式排除operationID、aggregateID、aggregateSequence、payloadDigest自身与整个eventChain，domain固定`operation-payload-v1`。same `(aggregateID,operationID)`/different payloadDigest是conflict。

operation branch的`EventChainDigestInputV1`精确等于`{kind:"operation",hashVersion:1,aggregateID,aggregateSequence,operationID,operationType,fieldSetVersion,previousDigest,payloadDigest}`，domain固定`event-chain-v1`，公式为：

```text
nextDigest = SHA256(canonicalEncode("event-chain-v1", EventChainDigestInputV1))
```

`eventChain.previousDigest`必须等于`expectedPredecessors.aggregateEventHead.digest`。aggregate genesis固定为`SHA256(canonicalEncode("event-chain-v1",{kind:"aggregate-genesis",hashVersion:1,aggregateID}))`；任何operation只有在它是dedicated recovery aggregate首条raw operation时才允许`aggregateEventHead.kind="genesis"`、`aggregateSequence=0`且previousDigest等于该重算值；否则必须引用exact current event head并使用`aggregateSequence=predecessor.sequence+1`。因此type-1的model-lineage genesis与aggregate genesis相互独立。F5必须对type-10两branch从raw `supersessionBindingInput`调用B05+F22重算`SupersessionBindingDigest`（model因此必读持久化的`submissionPayloadDigest`），对type-1 reservation ref比较同一model digest，并重算payloadDigest与nextDigest；禁止信任stored值、仅凭operationID/digest lookup或只校验格式。

#### 4.8.3 Exact commit outputs、operation post-state 与receipt

每个M4 operation transaction的ephemeral返回是type-indexed closed `OperationCommitResultV1<T>`：exact字段固定为`{operation,applyMode,operationPostState,receipt}`，无optional catch-all。`applyMode:"first-application"|"exact-replay"`只存在于该ephemeral result，绝不进入raw operation、immutable receipt、folded durable state、digest或public projection。

| operation type | exact `operationPostState` | exact `ReceiptForV1<T>` |
|---|---|---|
| 1 initial | validated existing user-message predecessor + newly materialized Legacy assistant info/relation + admitted assistant/dispatch evidence + `assistantChainHead,dispatchLedgerHead,aggregateEventHead` | available/opaque `AvailableAssistantAdmissionReceiptV1`/`OpaqueAssistantAdmissionReceiptV1`，`admissionKind:"initial"` |
| 2 ordinary | newly materialized Legacy assistant info/relation + admitted assistant/dispatch evidence + same three post heads | 同两receipt，`admissionKind:"ordinary"` |
| 3 subsequent | committed dispatch evidence + `dispatchLedgerHead,aggregateEventHead` | available/opaque subsequent V1 receipt |
| 4 tool | folded tool evidence + `aggregateEventHead` | `SourceFactReceiptV1 & {factKind:"tool"}` |
| 5 reasoning | folded reasoning evidence + `aggregateEventHead` | `SourceFactReceiptV1 & {factKind:"reasoning"}` |
| 6 prefix | folded provider prefix + `aggregateEventHead` | `SourceFactReceiptV1 & {factKind:"provider-prefix"}` |
| 7 terminal | folded incomplete terminal + `aggregateEventHead` | `SourceFactReceiptV1 & {factKind:"incomplete-terminal"}` |
| 8 decision | deterministic ManualStop-finalized decision + manual branch binding input/digest + no-handle or cancelled handle-closure commitment + `recoveryHead,aggregateEventHead` | branch-exact `DecisionFinalizedReceiptV1` |
| 9 automatic | deterministic automatic-consumed decision/consumption + newly materialized Legacy child assistant info/relation + child dispatch evidence + three recovery heads `recoveryHead,assistantChainHead,dispatchLedgerHead` plus aggregate event head/cursor `aggregateEventHead` | `AutomaticRecoveryAdmissionReceiptV1` |
| 10 superseded | deterministic superseded decision + model reservation or no-reply absence proof + `recoveryHead,aggregateEventHead` | branch-exact `SourceSupersededReceiptV1` |

Fold/rebuild对8–10使用同一total derivation：payload中canonical decision material提供decisionID/revision/createdAt/reasons所需facts；type 8另从同一material取得manual `bindingInput/BindingDigest`与handle-closure commitment，并验证其source/control/action/reasons与payload exact equal，不从available plan补target或digests；type 9从proposal取得automatic `BindingDigest`；type 10从持久化的`supersessionBindingInput`重算`SupersessionBindingDigest`并与decision/payload双份字段exact equal，绝不要求automatic/manual binding。sourceVersion/proposal/child payload提供各branch source/action/child；envelope提供operationID与committedSequence。任何record字段都不得从clock、runtime object、projection或existing decision row补入。type 8只允许ManualStop finalized；type 9只允许automatic consumed；type 10只允许manual-stop superseded且固定singleton reason。

first application必须在同一transaction内验证current session→policy scope mapping、current`scopeKey/epoch/policyDigest/defaultSemanticsVersion`、counts与predecessor heads，再应用raw operation并fold post-state。exact replay必须从已存raw operation的aggregate genesis连续fold到其stored `aggregateSequence`，验证stored historical policy binding、operation post-state与receipt；current policy后来变化不使历史receipt失效。另一个独立的M4 full-prefix/read-head检查负责验证从genesis到current aggregate head的完整chain无gap/corruption且current heads等于full fold；F26/F27只验证目标operation sequence的operation post-state，不能用current head替代它。

#### 4.8.4 Internal Event definitions与allowed sets

每个operation type对应一个同名`session.recovery.*` durable definition，均显式`publication:"internal"`、durable aggregate selector=`aggregateID`、version=1，schema为`RecoveryOperationEnvelope<该type>`的recursive exact field set。`aggregateID`是dedicated recovery aggregate并由M4验证其session owner mapping；`sessionID`只作为payload owner事实，绝不能作为durable selector。source event set精确为1–7；control event set精确为8–10；两集合的version/digest规则见§4.5.1。automatic operation只属于control set。Public contract不新增任何recovery event。generic public EventTable definitions/writers保持原aggregate合同，不因M1 recovery chain而被要求增加recovery operation envelope、payload digest或event-chain字段；强制recovery authority chain只适用于recovery/sealed aggregates及其trusted writers。

#### 4.8.5 Source-specific lower-level causes与exhaustive mapping

caller不能提供`ManualStopReason`或预选stable reason。`RecoveryFailureCause`没有`code`字段，只由产生事实的lower-level discriminator构造：

```ts
export type RecoveryFailureCause =
  | { source:"dispatch"; kind:"ledger-conflict"; detail?:string }
  | { source:"dispatch"; kind:"multiple-plausible-attempts"; detail?:string }
  | { source:"provider-introspection"; kind:"descriptor-not-readable"; detail?:string }
  | { source:"planning"; kind:"target-not-materialized"; detail?:string }
  | { source:"planning"; kind:"authority-version-not-provable"; detail?:string }
  | { source:"planning"; kind:"request-materialization-threw"; detail?:string }
  | { source:"planning"; kind:"request-canonicalization-failed"; detail?:string }
  | { source:"planning"; kind:"paused-runtime-proof-missing"; detail?:string }
  | { source:"provider"; kind:"replay-state-indeterminate"; detail?:string }
  | { source:"provider"; kind:"continuation-capability-missing"; detail?:string }
  | { source:"provider"; kind:"authorization-proof-missing"; detail?:string }
  | { source:"provider"; kind:"action-contract-not-applicable"; detail?:string }
  | { source:"tool"; kind:"local-replay-state-indeterminate"; callID?:string; detail?:string }
  | { source:"tool"; kind:"input-not-closed"; callID?:string; detail?:string }
  | { source:"tool"; kind:"settlement-not-terminal"; callID?:string; detail?:string }
  | { source:"tool"; kind:"execution-was-interrupted"; callID?:string; detail?:string }
  | { source:"tool"; kind:"result-commitment-uncertain"; callID?:string; detail?:string }
  | { source:"closure"; kind:"lowered-closure-not-provable"; detail?:string }
  | { source:"closure"; kind:"continuation-context-missing"; detail?:string }
  | { source:"binding"; kind:"frozen-facts-mismatch"; detail?:string }
  | { source:"admission"; kind:"incomplete-recovery-limit-reached"; detail?:string }
  | { source:"admission"; kind:"model-assistant-limit-reached"; detail?:string }
  | { source:"supersession"; kind:"new-user-input-committed"; operationID:RecoveryOperationID; detail?:string }
  | { source:"internal"; kind:"classifier-invariant-violated"; detail?:string }
```

exact cause→reason registry如下，24行不可重排或合并：

| source/kind | ManualStopReason |
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

mapping只能在F23发生；cause生产者、M5 caller与M6 caller不能传reason。`detail/callID/operationID`不影响reason identity、排序或dedup，detail只进runtime/internal日志，不进binding/public。新增cause variant必须同时更新closed union、exact field set、mapping switch与24项coverage test；无default映射。

### 4.9 Supporting exact types（不得留给实现自行解释）

```ts
export type CanonicalWireValueV1 =
  | JsonScalar
  | readonly CanonicalWireValueV1[]
  | Readonly<{ readonly [key:string]:CanonicalWireValueV1 }>
type CanonicalNamedOptionsV1 = readonly Readonly<{ name:string; value:CanonicalWireValueV1 }>[]
type CanonicalToolDefinitionV1 = Readonly<{ name:string; description?:string; inputSchema:CanonicalWireValueV1 }>

export type SemanticDigestInputV1 = Readonly<{
  version:1; target:DispatchTarget; targetDigest:DispatchTargetDigest; storageMode:StorageMode
  tools:readonly CanonicalToolDefinitionV1[]
  providerOptions:CanonicalNamedOptionsV1; modelOptions:CanonicalNamedOptionsV1
  generationOptions:CanonicalNamedOptionsV1; httpOptions:CanonicalNamedOptionsV1
  system:readonly CanonicalWireValueV1[]; history:readonly CanonicalWireValueV1[]; body:CanonicalWireValueV1
}>
type PreparedDigestCommonInputV1 = Readonly<{
  version:1
  context:CandidateDispatchAttemptContext
  request:SemanticDigestInputV1
  semanticDigest:SemanticDigest
  replayFence:ProviderReplayFence
  capabilities:ProviderCapabilitySummary
  authorization:ProviderAuthorizationCommitment
  pausedHandleCommitment:PausedHandleCommitment
  preparedBodyFormat:string
  preparedBodyVersion:SafePositiveInt
}>
export type PreparedDigestInputV1 =
  | (PreparedDigestCommonInputV1 & Readonly<{dispatchKind:"initial"}>)
  | (PreparedDigestCommonInputV1 & Readonly<{dispatchKind:"ordinary"}>)
  | (PreparedDigestCommonInputV1 & Readonly<{
      dispatchKind:"automatic-recovery"
      sourceVersion:RecoverySourceVersion
      action:AutomaticRecoveryAction
      closure:RecoveryClosureDescriptor
      closureDigest:RecoveryClosureDigest
    }>)
type BindingAdmissionInputV1 = Readonly<{
  scopeKey:RecoveryPolicyScopeKey
  epoch:SafeNonNegativeInt
  policyDigest:RecoveryPolicyDigest
  defaultSemanticsVersion:1
  policy:RecoveryPolicyDigestInputV1
  nAvailable:boolean
  mAvailable:boolean
  bindingPolicyVersion:1
}>
type BindingDigestSourceCommonV1 = Readonly<{
  version:1
  sourceAssistant:CommittedAssistantAttemptIdentity
  sourceVersion:RecoverySourceVersion
  sourceVersionDigest:RecoverySourceVersionDigest
  controlTailVersion:RecoveryControlTailVersion
  controlTailDigest:RecoveryControlTailDigest
  candidateContext:CandidateDispatchAttemptContext
  action:AutomaticRecoveryAction
  admission:BindingAdmissionInputV1
  expectedHeads:AdmissionPlan["expectedHeads"]
  controlPolicyDigest:ControlPolicyDigest
}>
export type AutomaticBindingDigestInputV1 = BindingDigestSourceCommonV1 & Readonly<{
  kind:"automatic"
  target:DispatchTarget
  targetDigest:DispatchTargetDigest
  semanticDigest:SemanticDigest
  preparedDigest:PreparedDigest
  authorization:ProviderAuthorizationCommitment
  closureDigest:RecoveryClosureDigest
}>
export type ManualStopBindingDigestInputV1 = BindingDigestSourceCommonV1 & Readonly<{
  kind:"manual-stop"
  causes:NonEmptyReadonlyArray<CanonicalManualStopCauseV1>
  reasons:NonEmptyReadonlyArray<ManualStopReason>
  planningEvidence:ManualStopPlanningEvidenceCommitmentV1
  closureStatus:ManualStopClosureStatusV1
  handleClosure:ManualStopHandleClosureCommitmentV1
}>
export type BindingDigestInputV1 = AutomaticBindingDigestInputV1|ManualStopBindingDigestInputV1
export type OperationPayloadDigestInputV1<T extends RecoveryOperationType = RecoveryOperationType> = Readonly<{
  envelopeVersion:1; operationType:T; fieldSetVersion:1
  expectedPredecessors:OperationSchemaByTypeV1[T]["expectedPredecessors"]
  payload:OperationSchemaByTypeV1[T]["payload"]
}>
type SupersessionBindingDigestInputCommonV1 = Readonly<{
  version:1
  sessionID:string
  sourceVersion:RecoverySourceVersion
  sourceVersionDigest:RecoverySourceVersionDigest
  controlTailVersion:RecoveryControlTailVersion
  controlTailDigest:RecoveryControlTailDigest
  submissionPayloadDigest:CanonicalDigestValue
  supersessionPredecessors:Readonly<{
    aggregateEventHead:AggregateEventHeadV1
    recoveryHead:RecoveryHeadV1
  }>
}>
export type SupersessionBindingDigestInputV1 =
  | (SupersessionBindingDigestInputCommonV1 & Readonly<{
      kind:"model"
      intendedInitialOperationID:RecoveryOperationID
    }>)
  | (SupersessionBindingDigestInputCommonV1 & Readonly<{
      kind:"no-reply"
      replyDisposition:"commit-user-only"
    }>)
export type EventChainDigestInputV1 =
  | Readonly<{kind:"aggregate-genesis";hashVersion:1;aggregateID:RecoveryAggregateID}>
  | Readonly<{
      kind:"operation";hashVersion:1;aggregateID:RecoveryAggregateID;aggregateSequence:SafeNonNegativeInt
      operationID:RecoveryOperationID;operationType:RecoveryOperationType;fieldSetVersion:1
      previousDigest:EventChainDigest;payloadDigest:OperationPayloadDigest
    }>
type RecoverySourceFactV1 =
  | OperationSchemaByTypeV1["initial-chain-genesis-and-dispatch"]["payload"]
  | OperationSchemaByTypeV1["ordinary-assistant-and-dispatch-admitted"]["payload"]
  | OperationSchemaByTypeV1["subsequent-dispatch-recorded"]["payload"]
  | OperationSchemaByTypeV1["tool-evidence-recorded"]["payload"]
  | OperationSchemaByTypeV1["reasoning-evidence-recorded"]["payload"]
  | OperationSchemaByTypeV1["provider-prefix-recorded"]["payload"]
  | OperationSchemaByTypeV1["incomplete-terminal-recorded"]["payload"]
export type SourceFactsDigestInputV1 = Readonly<{
  version:1; sourceAssistantID:RecoveryAssistantID; highWater:SafeNonNegativeInt
  eventTypeSetVersion:RecoveryEventTypeSetVersion; fieldSetRegistryVersion:RecoveryFieldSetRegistryVersion
  allowedEventSetDigest:SourceAllowedEventSetDigest; facts:readonly RecoverySourceFactV1[]
}>
export type RecoverySourceVersionDigestInputV1 = Readonly<{
  version:1; aggregateID:RecoveryAggregateID; sourceAssistantID:RecoveryAssistantID; highWater:SafeNonNegativeInt
  eventChainHead:EventChainDigest; factsDigest:SourceFactsDigest
  eventTypeSetVersion:RecoveryEventTypeSetVersion; fieldSetRegistryVersion:RecoveryFieldSetRegistryVersion
  allowedEventSetDigest:SourceAllowedEventSetDigest; fieldSets:readonly RecoveryFieldSetRefV1[]
  providerPrefix?:ProviderPrefixCheckpoint
}>
export type RecoveryControlTailDigestInputV1 = Omit<RecoveryControlTailVersion,"versionDigest">
export type DispatchTargetDigestInputV1 = DispatchTarget
export type SealedMaterialCommitmentInputV1 = Readonly<{
  version:1; purpose:SealedRecoveryMaterialRef["purpose"]; scope:SealedRecoveryMaterialRef["scope"]
  keyID:string; keyVersion:SafePositiveInt; derivation:"hmac-sha256"; keyedValue:string
}>
export type PausedHandleCommitmentInputV1 = Readonly<{
  version:1; context:CandidateDispatchAttemptContext; targetDigest:DispatchTargetDigest
  preparedBodyVersion:SafePositiveInt; keyID:string; keyVersion:SafePositiveInt
  derivation:"hmac-sha256"; keyedValue:string
}>
export type RecoveryClosureDigestInputV1 =
  | Readonly<{version:1;action:"safe-retry"}>
  | Readonly<{
      version:1; action:"continue-after-settled-tools"
      sourceBinding:Extract<RecoveryClosureDescriptor,{status:"available"}>["sourceBinding"]
      toolCalls:Extract<RecoveryClosureDescriptor,{status:"available"}>["toolCalls"]
      reasoning:Extract<RecoveryClosureDescriptor,{status:"available"}>["reasoning"]
      providerPrefix:ProviderPrefixCheckpoint
    }>
export type AllowedEventSetDigestInputV1 = Readonly<{
  version:1; set:"source"|"control"; eventTypeSetVersion:RecoveryEventTypeSetVersion
  fieldSetRegistryVersion:RecoveryFieldSetRegistryVersion
  entries:readonly Readonly<{
    operationType:RecoveryOperationType; eventType:RecoveryEventType; eventVersion:1
    fieldSetVersion:1
    exactFields:readonly Readonly<{
      path:string; presence:"required"|"optional"
      specKind:"literal"|"string"|"safe-integer"|"array"|"object"|"union"
      discriminatorLiteral?:string
    }>[]
  }>[]
}>
export type CredentialAuthorityVersionDigestInputV1 =
  | Readonly<{ version:1; derivation:"provider-version-id"; providerID:string; authorityScope:CredentialAuthorityScopeV1; providerVersionID:string }>
  | Readonly<{ version:1; derivation:"hmac-sha256"; providerID:string; authorityScope:CredentialAuthorityScopeV1; keyID:string; keyVersion:SafePositiveInt; keyedValue:string }>
export type ProviderAuthorizationProofDigestInputV1 = Readonly<{
  version:1; descriptorID:string; descriptorVersion:SafePositiveInt; targetDigest:DispatchTargetDigest
  storageMode:StorageMode; allowedAction:"initial"|"ordinary"|AutomaticRecoveryAction
  capabilityDescriptorVersion:SafePositiveInt
  replayMode:"no-provider-side-effect"|"attempt-idempotency"|"durable-prefix-continuation"
  closureDigest:RecoveryClosureDigest
}>
export type ControlPolicyDigestInputV1 = Readonly<{
  version:1; scopeKey:RecoveryPolicyScopeKey; epoch:SafeNonNegativeInt
  policyDigest:RecoveryPolicyDigest; defaultSemanticsVersion:1
}>
export type ToolPlanDigestInputV1 = Readonly<{
  version:1; callID:string; name:string; planRevision:SafeNonNegativeInt
  executionMode:ToolExecutionModeV1; input:RecoveryReplayPayloadCommitmentProjectionV1
}>
export type ToolCallDigestInputV1 = Readonly<{
  version:1; callID:string; name:string; executionKind:ToolExecutionKindV1
  inputState:ToolInputStateV1; callObservation:ToolCallObservationV1
  planRevision:SafeNonNegativeInt; finalPlanDigest:ToolPlanDigest
}>
export type ToolResultDigestInputV1 = Readonly<{
  version:1; callID:string; settlement:"completed"|"error"
  interruption:"none"; providerExecuted:ProviderExecutedStateV1
  outcome:
    | Readonly<{kind:"result";payload:RecoveryReplayPayloadCommitmentProjectionV1}>
    | Readonly<{kind:"error";payload:RecoveryReplayPayloadCommitmentProjectionV1}>
}>
export type ReasoningTextDigestInputV1 = Readonly<{
  version:1; blockID:string; provenance:ReasoningProvenanceV1; continuationMode:ReasoningContinuationModeV1
  protocol:string; targetDigest:DispatchTargetDigest
  content:RecoveryReplayPayloadCommitmentProjectionV1 & Readonly<{valueKind:"utf8-text"}>
}>
export type ProviderPrefixDigestInputV1 = Readonly<{
  version:1; aggregateID:RecoveryAggregateID; sessionID:string; sourceAssistantID:RecoveryAssistantID
  sourceHighWater:SafeNonNegativeInt; hashVersion:1; protocol:string
  targetDigest:DispatchTargetDigest
  prefix:RecoveryReplayPayloadCommitmentProjectionV1 & Readonly<{valueKind:"canonical-wire-value"}>
}>
export type ProviderPrefixAncestryDigestInputV1 =
  | Readonly<{
      version:1;kind:"genesis";aggregateID:RecoveryAggregateID;sessionID:string
      sourceAssistantID:RecoveryAssistantID;sourceHighWater:SafeNonNegativeInt;hashVersion:1
      prefixDigest:ProviderPrefixDigest
    }>
  | Readonly<{
      version:1;kind:"extension";aggregateID:RecoveryAggregateID;sessionID:string
      sourceAssistantID:RecoveryAssistantID;sourceHighWater:SafeNonNegativeInt;hashVersion:1
      prefixDigest:ProviderPrefixDigest;previousSourceHighWater:SafeNonNegativeInt
      previousAncestryDigest:ProviderPrefixAncestryDigest
    }>

type RecoveryAggregateOwnerV1 = Readonly<{
  aggregateID:RecoveryAggregateID
  sessionID:string
}>
export type M4RecoveryAggregateOwnerMappingProofV1 = Readonly<{
  proofVersion:1
  owner:"m4-recovery-aggregate-owner-index"
  mappingState:"validated-one-to-one"
  aggregate:RecoveryAggregateOwnerV1
}> & Brand<"M4RecoveryAggregateOwnerMappingProofV1">
export type RecoveryDurableRowDecodeInputV1 = Readonly<{
  row:RecoveryDurableRowV1
  ownerProof:M4RecoveryAggregateOwnerMappingProofV1
}>
export type DecodedRecoveryOperation = Readonly<{
  eventType:RecoveryEventType; eventVersion:1; rowSequence:SafeNonNegativeInt
  owner:RecoveryAggregateOwnerV1
  operation:RecoveryOperationEnvelope
}>
export type LegacyCompatibilityEvidence = Readonly<{
  version:1; eligibleForAutomatic:false; assistantID?:RecoveryAssistantID
  dispatch:"missing-ledger"|"opaque"|"inconsistent"
  tools:readonly CompatibilityToolEvidenceV1[]; reasoning:readonly ReasoningEvidence[]
  causes:NonEmptyReadonlyArray<RecoveryFailureCause>
}>
export type RecoveryPublicAuthorityViewV1 = Readonly<{
  dispatchSummary?:{count:SafeNonNegativeInt;evidence:"available"|"opaque"|"mixed"|"unknown"}
  sourceErrorPreserved?:true
  child?:
    | {sessionID:string;assistant:CommittedAssistantAttemptIdentity;visibility:"hidden"}
    | {sessionID:string;assistant:CommittedAssistantAttemptIdentity;visibility:"public";displayID:RecoveryChildDisplayID}
  outcome?:"safe-retry"|"continue-after-settled-tools"|"manual-stop"|"unknown"
}>

type FoldedAssistantAdmissionPostStateV1<T extends "initial-chain-genesis-and-dispatch"|"ordinary-assistant-and-dispatch-admitted"> = Readonly<{
  operationEnvelope:RecoveryOperationEnvelope<T>
  validatedUserMessagePredecessor?:LegacyUserMessagePredecessorV1 // required only for T=type1; forbidden for T=type2
  assistantMessage:LegacyAssistantMessageGenesisV1
  admission:AssistantAdmissionProofV1; assistant:CommittedAssistantAttemptIdentity; dispatch:CommittedDispatchAttemptContext
  evidence:AvailableDispatchEvidence|OpaqueDispatchEvidence
  postHeads:{assistantChainHead:AssistantChainHeadV1;dispatchLedgerHead:DispatchLedgerHeadV1;aggregateEventHead:AggregateEventHeadV1}
}>
type FoldedSubsequentDispatchPostStateV1 = Readonly<{
  operationEnvelope:RecoveryOperationEnvelope<"subsequent-dispatch-recorded">
  dispatch:CommittedDispatchAttemptContext; evidence:AvailableDispatchEvidence|OpaqueDispatchEvidence
  postHeads:{dispatchLedgerHead:DispatchLedgerHeadV1;aggregateEventHead:AggregateEventHeadV1}
}>
type FoldedToolEvidencePostStateV1 = Readonly<{
  operationEnvelope:RecoveryOperationEnvelope<"tool-evidence-recorded">; evidence:AuthoritativeToolEvidenceV1
  postHeads:{aggregateEventHead:AggregateEventHeadV1}
}>
type FoldedReasoningEvidencePostStateV1 = Readonly<{
  operationEnvelope:RecoveryOperationEnvelope<"reasoning-evidence-recorded">; evidence:ReasoningEvidence
  postHeads:{aggregateEventHead:AggregateEventHeadV1}
}>
type FoldedProviderPrefixPostStateV1 = Readonly<{
  operationEnvelope:RecoveryOperationEnvelope<"provider-prefix-recorded">; checkpoint:ProviderPrefixCheckpoint
  postHeads:{aggregateEventHead:AggregateEventHeadV1}
}>
type FoldedIncompleteTerminalPostStateV1 = Readonly<{
  operationEnvelope:RecoveryOperationEnvelope<"incomplete-terminal-recorded">; terminal:TypedIncompleteTerminalFact
  postHeads:{aggregateEventHead:AggregateEventHeadV1}
}>
type FoldedDecisionFinalizedPostStateV1 = Readonly<{
  operationEnvelope:RecoveryOperationEnvelope<"decision-finalized">; decision:RecoveryDecisionRecord
  postHeads:DecisionFinalizedReceiptV1["postHeads"]
}>
export type FoldedAutomaticRecoveryPostStateV1 = Readonly<{
  operationEnvelope:RecoveryOperationEnvelope<"automatic-child-admitted-and-consumed">
  decision:RecoveryDecisionRecord; consumption:RecoveryConsumptionRef
  childAssistantMessage:LegacyAssistantMessageGenesisV1
  childAssistant:CommittedAssistantAttemptIdentity; childDispatch:CommittedDispatchAttemptContext
  evidence:AvailableDispatchEvidence; admission:AutomaticRecoveryAdmissionReceiptV1["admission"]
  postHeads:AutomaticRecoveryAdmissionReceiptV1["postHeads"]
}>
type FoldedSourceSupersededPostStateV1 =
  | Readonly<{
      operationEnvelope:RecoveryOperationEnvelope<"source-superseded">
      supersessionKind:"model"
      decision:Extract<RecoveryDecisionRecord,{status:"superseded"}>
      reservedInitialOperationID:RecoveryOperationID
      supersessionBindingInput:Extract<SupersessionBindingDigestInputV1,{kind:"model"}>
      supersessionBindingDigest:SupersessionBindingDigest
      postHeads:SourceSupersededReceiptV1["postHeads"]
    }>
  | Readonly<{
      operationEnvelope:RecoveryOperationEnvelope<"source-superseded">
      supersessionKind:"no-reply"
      decision:Extract<RecoveryDecisionRecord,{status:"superseded"}>
      supersessionBindingInput:Extract<SupersessionBindingDigestInputV1,{kind:"no-reply"}>
      supersessionBindingDigest:SupersessionBindingDigest
      postHeads:SourceSupersededReceiptV1["postHeads"]
    }>

type OperationPostStateByTypeV1 = {
  "initial-chain-genesis-and-dispatch":FoldedAssistantAdmissionPostStateV1<"initial-chain-genesis-and-dispatch">
  "ordinary-assistant-and-dispatch-admitted":FoldedAssistantAdmissionPostStateV1<"ordinary-assistant-and-dispatch-admitted">
  "subsequent-dispatch-recorded":FoldedSubsequentDispatchPostStateV1
  "tool-evidence-recorded":FoldedToolEvidencePostStateV1
  "reasoning-evidence-recorded":FoldedReasoningEvidencePostStateV1
  "provider-prefix-recorded":FoldedProviderPrefixPostStateV1
  "incomplete-terminal-recorded":FoldedIncompleteTerminalPostStateV1
  "decision-finalized":FoldedDecisionFinalizedPostStateV1
  "automatic-child-admitted-and-consumed":FoldedAutomaticRecoveryPostStateV1
  "source-superseded":FoldedSourceSupersededPostStateV1
}
export type OperationPostStateForV1<T extends RecoveryOperationType> = OperationPostStateByTypeV1[T]

type AuthorityReceiptByOperationV1 = {
  "initial-chain-genesis-and-dispatch":
    | (AvailableAssistantAdmissionReceiptV1 & {admissionKind:"initial"})
    | (OpaqueAssistantAdmissionReceiptV1 & {admissionKind:"initial"})
  "ordinary-assistant-and-dispatch-admitted":
    | (AvailableAssistantAdmissionReceiptV1 & {admissionKind:"ordinary"})
    | (OpaqueAssistantAdmissionReceiptV1 & {admissionKind:"ordinary"})
  "subsequent-dispatch-recorded":AvailableSubsequentDispatchReceiptV1|OpaqueSubsequentDispatchReceiptV1
  "tool-evidence-recorded":SourceFactReceiptV1&{factKind:"tool"}
  "reasoning-evidence-recorded":SourceFactReceiptV1&{factKind:"reasoning"}
  "provider-prefix-recorded":SourceFactReceiptV1&{factKind:"provider-prefix"}
  "incomplete-terminal-recorded":SourceFactReceiptV1&{factKind:"incomplete-terminal"}
  "decision-finalized":DecisionFinalizedReceiptV1
  "automatic-child-admitted-and-consumed":AutomaticRecoveryAdmissionReceiptV1
  "source-superseded":SourceSupersededReceiptV1
}
export type ReceiptForV1<T extends RecoveryOperationType> = AuthorityReceiptByOperationV1[T]
type OperationApplyModeV1 = "first-application"|"exact-replay"
export type OperationCommitResultV1<T extends RecoveryOperationType> = Readonly<{
  operation:RecoveryOperationEnvelope<T>
  applyMode:OperationApplyModeV1
  operationPostState:OperationPostStateForV1<T>
  receipt:ReceiptForV1<T>
}>

export type CandidateIdentityDerivationInputV1 = Readonly<{
  assistant:CandidateAssistantAttemptIdentity
  dispatch:CandidateDispatchAttemptContext
}>
export type IdentityAdmissionOperationTypeV1 =
  | "initial-chain-genesis-and-dispatch"
  | "ordinary-assistant-and-dispatch-admitted"
  | "automatic-child-admitted-and-consumed"
export type IdentityDerivationError = FieldSetError | RecoveryDecodeError | NormalizationError

export function deriveCommittedIdentity<T extends IdentityAdmissionOperationTypeV1>(
  candidate:CandidateIdentityDerivationInputV1,
  envelope:RecoveryOperationEnvelope<T>,
):ContractResult<DerivedCommittedIdentityV1,IdentityDerivationError>

export type FoldOperationPostStateInputV1<T extends RecoveryOperationType> = Readonly<{
  events:readonly DecodedRecoveryOperation[]
  throughSequence:SafeNonNegativeInt
  expectedOperationID:RecoveryOperationID
  expectedOperationType:T
}>
export type RecoveryFoldError = RecoveryDecodeError | FieldSetError | NormalizationError | DigestMismatchError | CanonicalizationError
export function foldOperationPostStateThroughSequence<T extends RecoveryOperationType>(
  input:FoldOperationPostStateInputV1<T>,
):ContractResult<OperationPostStateForV1<T>,RecoveryFoldError>

export type RecoveryCurrentPrefixExpectationV1 = Readonly<{
  owner:RecoveryAggregateOwnerV1
  aggregateEventHead:AggregateEventHeadV1
  recoveryHeads:ReadonlyMap<RecoveryAssistantID,RecoveryHeadV1>
  assistantChainHeads:ReadonlyMap<RecoveryChainID,AssistantChainHeadV1>
  dispatchLedgerHeads:ReadonlyMap<RecoveryAssistantID,DispatchLedgerHeadV1>
}>
export function validateCurrentRecoveryAggregatePrefixAndHeads(
  events:readonly DecodedRecoveryOperation[],
  expected:RecoveryCurrentPrefixExpectationV1,
):ContractResult<void,RecoveryFoldError>

export type EventManifestSet = PublicEventManifestV1 & Readonly<{
  publicDurable:PublicDurableEventManifestV1
  internalRuntime:ReadonlyMap<string,AnyInternalRecoveryDefinitionV1>
  durableReplay:TrustedPrivateDurableReplayManifestV1
}>
```

`CanonicalWireValueV1`虽以index signature表达递归JSON object，实际可进入任一domain前仍必须由该domain exact nested spec验证；它不是允许任意authority key的escape hatch。所有`keyedValue`匹配`/^[0-9a-f]{64}$/`且只能由相应HMAC builder生成。

`M4RecoveryAggregateOwnerMappingProofV1`与`M4SealedRecoveryMaterialLookupProofV1`是两个精确、ephemeral、nominal M4 proof input。M4分别在owner-index lookup或sealed-store lookup成功后构造brand；M1只检查F4 exact shape和与当前row/ref的逐字段equality。M1没有lookup/store handle、不能构造proof brand、不能persist/refresh/revoke proof，也不拥有mapping/key registry。proof stale/cleanup语义与所有I/O继续属于M4；因此F5/F16及其later consumers保持pure且依赖方向为M4 evidence→M1 comparison。

## 5. 模块细化

### 5.0 Workflow §4.3.2 callable inventory and open compliance ledger

本节冻结export surface并提供fresh review inventory；它不宣称机械检查已通过。F9与F12分别在自身段落逐项标为trivial并给出理由：F9是单个closed scalar switch（但有typed failure，故仍用`ContractResult`），F12是total structural comparison且是唯一裸返回函数。F1–F8、F10–F11、F13–F31、F16a均为non-trivial并承担完整proof obligation；任何实现新增callee、分支、循环或副作用前必须先修订本文并重新review。

#### 5.0.1 Exact exported TypeScript signatures

```ts
export type RecoveryDurableRowV1 = Readonly<{
  id:string
  type:string
  aggregateID:string
  sequence:unknown
  data:unknown
}>
export type LegacyRecoveryRowSetV1 = Readonly<{
  assistant:unknown
  parts:readonly unknown[]
}>
export type ToolEvidenceNormalizationModeV1 = "authoritative"|"old-row"
export type ToolEvidenceByNormalizationModeV1 = Readonly<{
  authoritative:AuthoritativeToolEvidenceV1
  "old-row":CompatibilityToolEvidenceV1
}>
export type ReasoningEvidenceNormalizationInputV1 =
  | Readonly<{
      mode:"authoritative"
      raw:unknown
      sealedLookupProofs:readonly M4SealedRecoveryMaterialLookupProofV1[]
    }>
  | Readonly<{
      mode:"old-row"
      raw:unknown
      sealedLookupProofs:readonly []
    }>
export type SealedRecoveryExpectedScopeV1 = SealedRecoveryMaterialRef["scope"]
export type NonEmptyRecoveryMaterialPurposesV1 = readonly [SealedRecoveryMaterialRef["purpose"],...SealedRecoveryMaterialRef["purpose"][]]
export type DispatchReceiptOperationTypeV1 =
  | "initial-chain-genesis-and-dispatch"
  | "ordinary-assistant-and-dispatch-admitted"
  | "subsequent-dispatch-recorded"
export type SemanticDigestBuildSourceV1 = Readonly<{
  target:unknown; storageMode:unknown; tools:readonly unknown[]
  providerOptions:unknown; modelOptions:unknown; generationOptions:unknown; httpOptions:unknown
  system:readonly unknown[]; history:readonly unknown[]; body:unknown
  sealedLookupProofs:readonly M4SealedRecoveryMaterialLookupProofV1[]
}>
type PreparedDigestBuildSourceCommonV1 = Readonly<{
  context:CandidateDispatchAttemptContext
  request:SemanticDigestInputV1
  semanticDigest:SemanticDigest
  safetyDomain:ProviderSafetyDomain
  replayFence:ProviderReplayFence
  capabilities:ProviderCapabilitySummary
  authorization:ProviderAuthorizationCommitment
  sealedLookupProofs:readonly M4SealedRecoveryMaterialLookupProofV1[]
  pausedHandleCommitment:PausedHandleCommitment
  preparedBodyFormat:string
  preparedBodyVersion:SafePositiveInt
}>
export type PreparedDigestBuildSourceV1 =
  | (PreparedDigestBuildSourceCommonV1 & Readonly<{dispatchKind:"initial"}>)
  | (PreparedDigestBuildSourceCommonV1 & Readonly<{dispatchKind:"ordinary"}>)
  | (PreparedDigestBuildSourceCommonV1 & Readonly<{
      dispatchKind:"automatic-recovery"
      sourceVersion:RecoverySourceVersion
      action:AutomaticRecoveryAction
      closure:RecoveryClosureDescriptor
      closureDigest:RecoveryClosureDigest
    }>)
export type AutomaticBindingDigestBuildSourceV1 = Readonly<{
  kind:"automatic"
  snapshot:DurableRecoverySnapshot
  planned:Extract<PlannedRecoveryMaterializationDescriptor,{status:"available"}>
  admission:AdmissionPlan
  action:AutomaticRecoveryAction
}>
export type ManualStopBindingDigestBuildSourceV1 = Readonly<{
  kind:"manual-stop"
  snapshot:DurableRecoverySnapshot
  candidateContext:CandidateDispatchAttemptContext
  admission:AdmissionPlan
  action:AutomaticRecoveryAction
  causes:readonly RecoveryFailureCause[]
  reasons:NonEmptyReadonlyArray<ManualStopReason>
  planningEvidence:ManualStopPlanningEvidenceCommitmentV1
  closureStatus:ManualStopClosureStatusV1
  handleClosure:ManualStopHandleClosureCommitmentV1
}>
export type BindingDigestBuildSourceV1 =
  | AutomaticBindingDigestBuildSourceV1
  | ManualStopBindingDigestBuildSourceV1
export type RecoveryProposalValidationInputsV1 = BindingDigestBuildSourceV1

export function define<
  Type extends string,
  Fields extends Readonly<Record<string,unknown>>,
>(input:Readonly<{
  type:Type
  publication?:"public"|"internal"
  durable?:Readonly<{version:SafePositiveInt;aggregate:keyof Fields & string}>
  schema:Fields
}>):ContractResult<Definition<Type,Struct<Fields>>,EventDefinitionError>

export function partitionDefinitionsByPublication<D extends Definition>(
  definitions:readonly D[],
):ContractResult<Readonly<{
  public:readonly PublicEventDefinitionV1<D>[]
  internal:readonly (D & Readonly<{publication:"internal"}>)[]
}>,EventDefinitionError>

export function buildRecoveryEventDefinitions():ContractResult<RecoveryEventDefinitionSetV1,EventDefinitionError|FieldSetError>
export function buildRecoveryEventRegistry(definitionSet:RecoveryEventDefinitionSetV1):ContractResult<RecoveryEventRegistryV1,FieldSetError|CanonicalizationError>
export function validateExactFieldSet<T>(value:unknown,specification:ExactFieldSetSpecification<T>,path?:string):ContractResult<void,FieldSetError>
export function decodeRecoveryDurableRow(input:RecoveryDurableRowDecodeInputV1):ContractResult<DecodedRecoveryOperation,DecodeError>
export function decodeRecoverySourceFieldSet(events:readonly DecodedRecoveryOperation[],sourceAssistantID:RecoveryAssistantID,highWater:SafeNonNegativeInt):ContractResult<RecoverySourceVersion,DecodeError>
export function decodeRecoveryControlTail(events:readonly DecodedRecoveryOperation[],sourceVersion:RecoverySourceVersion):ContractResult<RecoveryControlTailVersion,DecodeError>
export function decodeLegacyRecoveryEvidence(rowSet:LegacyRecoveryRowSetV1):ContractResult<LegacyCompatibilityEvidence,DecodeError|NormalizationError>
export function normalizeStorageMode(value:unknown):ContractResult<StorageMode,NormalizationError & Readonly<{issue:"storage"}>>
export function normalizeDispatchTarget(raw:unknown):ContractResult<DispatchTarget,NormalizationContractError>
export function normalizeProviderSafetyDomain(raw:unknown):ContractResult<ProviderSafetyDomain,NormalizationContractError>
export function targetWithinSafetyDomain(target:DispatchTarget,domain:ProviderSafetyDomain):boolean
export function normalizeRecoveryPolicy(input:RecoveryPolicyInput):ContractResult<NormalizedRecoveryPolicy,ConfigCodecError|NormalizationError|CanonicalizationError|FieldSetError>
export function normalizeToolEvidence<M extends ToolEvidenceNormalizationModeV1>(raw:unknown,mode:M):ContractResult<ToolEvidenceByNormalizationModeV1[M],NormalizationContractError|RecoveryDecodeError>
export function normalizeReasoningEvidence(input:ReasoningEvidenceNormalizationInputV1):ContractResult<ReasoningEvidence,NormalizationContractError|RecoveryDecodeError>
export function validateSealedRecoveryMaterialRef(ref:unknown,expectedScope:SealedRecoveryExpectedScopeV1,allowedPurposes:NonEmptyRecoveryMaterialPurposesV1):ContractResult<SealedRecoveryMaterialRef,SealedRefStructuralValidationError>
export function validateProviderCapabilitySummary(summary:unknown,target:DispatchTarget,storageMode:StorageMode):ContractResult<ProviderCapabilitySummary,NormalizationContractError>

export function canonicalEncode<
  I,
  O extends CanonicalDigestValue,
  E extends RecoveryContractError,
>(spec:CanonicalDomainSpec<I,O,E>,value:I):ContractResult<Uint8Array,FieldSetError|CanonicalizationError>
export function buildSemanticDigestInput(source:SemanticDigestBuildSourceV1):ContractResult<SemanticDigestInputV1,NormalizedCanonicalInputError>
export function buildPreparedDigestInput(source:PreparedDigestBuildSourceV1):ContractResult<PreparedDigestInputV1,NormalizedCanonicalInputError>
export function buildBindingDigestInput(source:BindingDigestBuildSourceV1):ContractResult<BindingDigestInputV1,NormalizedCanonicalInputError>
export function digestCanonicalCommitment<
  I,
  O extends CanonicalDigestValue,
  E extends RecoveryContractError,
>(spec:CanonicalDomainSpec<I,O,E>,input:I):ContractResult<O,E|FieldSetError|CanonicalizationError>
export function verifyDigest<
  I,
  O extends CanonicalDigestValue,
  E extends RecoveryContractError,
>(expected:O,spec:CanonicalDomainSpec<I,O,E>,input:I):ContractResult<void,E|FieldSetError|CanonicalizationError|DigestMismatchError>
export function mapCausesToManualStopReasons(causes:readonly RecoveryFailureCause[]):ContractResult<NonEmptyReadonlyArray<ManualStopReason>,never>
export function validateRecoveryProposal(proposal:unknown,inputs:RecoveryProposalValidationInputsV1):ContractResult<RecoveryProposal,ReceiptValidationError>
export function validateRecoveryDecisionRecord(record:unknown):ContractResult<RecoveryDecisionRecord,ReceiptValidationError>
export function validateDispatchReceipt<T extends DispatchReceiptOperationTypeV1>(receipt:ReceiptForV1<T>,operationPostState:OperationPostStateForV1<T>,pausedHandleCommitment:PausedHandleCommitment):ContractResult<ReceiptForV1<T>,ReceiptValidationError>
export function validateRecoveryAdmissionReceipt(receipt:AutomaticRecoveryAdmissionReceiptV1,proposal:Extract<RecoveryProposal,{kind:"automatic"}>,planned:Extract<PlannedRecoveryMaterialization<unknown>,{descriptor:{status:"available"}}>,operationPostState:FoldedAutomaticRecoveryPostStateV1):ContractResult<AutomaticRecoveryAdmissionReceiptV1,ReceiptValidationError>
export function projectRecoveryForPublic(authorityView:RecoveryPublicAuthorityViewV1):ContractResult<RecoveryPublicProjectionV1|undefined,PublicProjectionViolation>
export function assertPublicRecoveryProjectionSafe(value:unknown):ContractResult<void,PublicProjectionViolation>
export function decodeRecoveryPublicProjection(value:unknown):ContractResult<RecoveryPublicProjectionDecodeResult,never>
export function assembleEventManifests<D extends Definition>(allDefinitions:readonly D[]):ContractResult<EventManifestSet,EventDefinitionError|FieldSetError|RecoveryDecodeError>
```

F18/F19/F20的builder名称同时是25-domain inventory中的对应input builder，只有这一组exports，不存在第二个同名raw-return API。F1现有`Event.define`实现位置必须导出上面的签名；文中`Event.define`只是owner-qualified名称。`buildRecoveryEventRegistry`是additional exact M1 callable：它由LLM package唯一拥有，不占用新F编号、不新增digest domain，不接受generic domain/string或任意lookalike definition set；schema package只拥有F3 raw set construction。

下表是consumer可命名的M1 owner/export inventory增量；这些都是type export，不新增callable、digest domain或runtime authority。任何实现把它们恢复为private alias、复制为consumer-local同义type，或在M1中加入snapshot-automatic/tool-eligibility/sealed-use-lease nominal proof均违反owner合同；既有owner-index/sealed-lookup proof inputs仍按§4.3.4/§4.9的窄用途保留。

| exported owner type | exact owner/consumer | export proof obligation（均unchecked） |
|---|---|---|
| `RecoveryClosureDescriptor` | M1 owner；M7/M2/M5 consumer | Continue branch含snapshot `sourceBinding`及可重建tool/reasoning/prefix carriers+commitments；SafeRetry branch保持branch-exact；M4 nominal snapshot proof不在M1 |
| `LegacyUserMessagePredecessorV1` | M1 operation schema owner；M3/M4 type-1 materialization consumer | consumer可命名exact Legacy predecessor，不得重声明或降为private structural lookalike |
| `OperationSchemaByTypeV1` | M1 operation/field-set owner；M3/M4/F3/F5 consumer | 10 operation map可由consumer generic signature直接索引；field sets、ManualStop/type-10 branches保持exact |
| `RecoveryEventDefinitionSetV1` / `RecoveryEventRegistryV1` | schema F3 owns raw set；LLM `buildRecoveryEventRegistry` owns enrichment；F5–F7/M4 consume enriched registry，F31 consumes raw definitions | raw carrier has versions/definitions/fieldSets/source/control only；enriched carrier adds exactly the two existing allowed-set digest brands；same membership/ordering，no schema→LLM dependency or duplicate canonicalizer |
| `CanonicalWireValueV1` / `RecoveryReplayPayloadV1` / `RecoveryReplayPayloadCommitmentProjectionV1` / `ToolTerminalReplayPayloadV1` | M1 canonical payload/carrier owner；M3/M4/M7 consumer | digest仅commitment；inline/sealed均可重建并按purpose/scope/material+owner digest验证；public/raw secret exclusion保持 |
| `AuthoritativeToolEvidenceV1` / `CompatibilityToolEvidenceV1` / `CanonicalToolEvidencePartitionV1` | M1 authority-class owner；M3/M4/M5/M7 consumer | partition total/disjoint/complete；compatibility-only不可省略成empty；SafeRetry/Continue eligibility branch exact |
| `ToolExecutionPhaseV1` | M1 phase owner；M3/M4/M5/M7 consumer | planned/body-outcome/final-after-hook/reconciled/unknown闭合；仅final branch Continue-eligible；所有rerun authority forbidden |
| `SealedRecoveryUseLeaseKeyInputV1` | M1 shared structural key owner；M4 lease owner/consumer，M2/M7 comparison consumer | exact绑定ref/scope/purpose/material/generation/handle/source/action/operation/session；M1不export lease/proof brand |
| `DispatchAdmissionV1` | M1 operation-schema owner；M3 candidate/pre-commit与M4 transaction consumer | 只export closed available/opaque union；两个variant保持private，consumer用`Extract<DispatchAdmissionV1,{kind:"available"}>`或`Extract<DispatchAdmissionV1,{kind:"opaque"}>`，不得复制variant schema |
| `TypedIncompleteTerminalFact` | M1 terminal/source-fact owner；M3 terminal producer与M4 append/fold consumer | 两条typed incomplete入口、public-message discriminator、terminal sequence与pre-terminal facts commitment exact；ordinary interrupt/permission/max-step不得伪装为该fact |
| `AssistantChainHeadV1` / `AggregateEventHeadV1` | M1 predecessor/head owner；M3 candidate preallocation与M4 CAS/fold consumer | canonical predecessor/head union可直接命名；`RecoveryHeadV1`与`DispatchLedgerHeadV1`仍private，consumer从`AdmissionPlan["expectedHeads"]`、`OperationSchemaByTypeV1[T]["expectedPredecessors"]`或receipt/post-state indexed surface取得 |
| `AutomaticRecoveryAction` | M1 proposal/binding/operation owner；M3/M5/M6/M7 consumer | closed two-literal action union唯一；不得重声明consumer-local action alias或扩大第三branch |
| `RecoveryAdmissionPolicyBindingV1` | M1 policy-binding owner；M3/M4/M6 admission consumer | exact policy authority quintet`scopeKey/epoch/policyDigest/defaultSemanticsVersion/controlPolicyDigest`；不是M6 policy snapshot/proof的替代品 |

**Stable-audit P1-1 owner/export constructibility closure（unchecked）**：逐项扫描S2/S3/S4全部owner-qualified `M1.*` normative references后，S2与S4均只引用既有exports；S3除上表新增的六个真正跨模块owner types外，只剩private receipt variants。六个owner types各只在其原定义处增加一次`export`，没有新增structural duplicate、callable、authority、receipt variant或canonical domain。下列private helper/variant继续不export，downstream必须改用唯一公开surface：

| intentionally private M1 name/family | required exported replacement |
|---|---|
| `AvailableDispatchAdmissionV1` / `OpaqueDispatchAdmissionV1` | `Extract<DispatchAdmissionV1,{kind:"available"}>` / `Extract<DispatchAdmissionV1,{kind:"opaque"}>` |
| `AvailableAssistantAdmissionReceiptV1` / `OpaqueAssistantAdmissionReceiptV1` | `Extract<AuthorityReceiptV1,{receiptKind:"assistant-admission";evidenceKind:"available"}>` / same extraction with `evidenceKind:"opaque"`；按单一operation需要时改用已收窄`ReceiptForV1<T>` |
| `AvailableSubsequentDispatchReceiptV1` / `OpaqueSubsequentDispatchReceiptV1` | `Extract<ReceiptForV1<"subsequent-dispatch-recorded">,{evidenceKind:"available"}>` / same extraction with `evidenceKind:"opaque"` |
| `SourceFactReceiptV1` | `Extract<AuthorityReceiptV1,{receiptKind:"source-fact"}>`，或按exact operation使用已收窄`ReceiptForV1<T>`，其中`T`只能是四个source-fact operation之一 |
| `DecisionFinalizedReceiptV1` | `ReceiptForV1<"decision-finalized">` |
| `SourceSupersededReceiptV1` | `ReceiptForV1<"source-superseded">` |
| `OperationApplyModeV1` | `OperationCommitResultV1<T>["applyMode"]`；需要branch literal时直接使用`"first-application"`或`"exact-replay"` |
| `RecoveryHeadV1` / `DispatchLedgerHeadV1` | exact indexed extraction from `AdmissionPlan["expectedHeads"]`、`OperationSchemaByTypeV1[T]["expectedPredecessors"]`、`ReceiptForV1<T>`或`OperationPostStateForV1<T>`；不得建立同义owner alias |

#### 5.0.2 Signature-visible M1 helper contracts

**H1 `deriveCommittedIdentity`（M1 export，pure）**

- **callers/callees**：仅M4 first-application transaction；callees为F4、identity/sequence validators。caller保证candidate pair来自同一candidate context且envelope为type 1/2/9；callee保证无coercion、无brand promotion。
- **Requires**：candidate authority均为`"candidate"`；assistant value与dispatch value逐字段一致；envelope已通过F5等价validation但尚未commit。
- **Ensures**：成功只返回`DerivedCommittedIdentityV1`且admitted fields精确取envelope `operationID/aggregateSequence`；type1 sequence/ordinals为0，type2/9满足predecessor+1；不返回committed brand。
- **编号分支/退出**：1) F4 exact；2) pair一致性；3) switch type1/type2/type9；4) 各branch predecessor/session/lineage/ordinal检查；5) fresh derived value；6) F4复检并返回。任何mismatch在对应步骤`ok:false`退出，无partial derived value。
- **副作用/残留**：纯计算；不写transaction/materialization/head，不分配authority ID，无durable residue。
- **进度/终止**：固定字段与三branch，无循环，有限终止。
- **§4.3.2 proof**：pre→I1 exact candidate/envelope→I2 pair same attempt→I3 selected branch invariants→I4 admitted fields equal envelope→post derived-pending-commit；callee纯且无store handle，故side-effect post为空。

**H2 `foldOperationPostStateThroughSequence`（M1 export，pure）**

- **callers/callees**：M4 A2/A4及F26/F27 caller preparation；callees F5 post、F4、H1、F22/F25与operation reducers。caller提供从aggregate genesis开始的decoded finite prefix；reducers保证每步只从raw predecessor state产生next state。
- **Requires**：events按sequence升序；目标sequence存在且operationID/type匹配generic `T`；每项为F5成功值且owner/aggregate相同。
- **Ensures**：成功返回目标operation执行后的exact `OperationPostStateForV1<T>`，不是current-later state；gap/duplicate/unknown/conflict/partial materialization均失败。
- **编号分支/退出**：1) empty/target range检查；2) genesis校验；3) 有限fold逐row复核chain/predecessor；4) per-operation closed reducer；5) 到target时验证ID/type并截断；6) F4 exact post-state；7) 返回。任一row失败立即`ok:false`且不返回prefix state。
- **副作用/残留**：immutable local fold only；不读写DB、heads或materialization tables，无repair/residue。
- **进度/终止**：loop index每轮+1且上界`throughSequence+1≤events.length`；不变量是已消费prefix连续且folded state恰对应最后sequence。
- **§4.3.2 proof**：pre给出F5 prefix；I1 genesis正确；归纳每轮由predecessor+closed reducer得I2(k) exact post-state；target match得I3 typed `T`；F4得I4 exact shape；I1∧I2∧I3∧I4推出Ensures，且纯reducers推出零side effect。

**H3 `validateCurrentRecoveryAggregatePrefixAndHeads`（M1 export，pure）**

- **callers/callees**：M4 A3/A4/A5/S1/R1；callees H2的全prefix fold、F4与structural equality。caller必须先在同一read/write transaction读取current complete raw prefix及current materialized head snapshots。
- **Requires**：events声称覆盖genesis..expected aggregate head；expected owner/aggregate/head maps来自同一transaction。
- **Ensures**：成功iff完整prefix无gap/corruption且full fold的aggregate/recovery/assistant/dispatch heads逐项等于expected；历史operation receipt验证不能替代本函数。
- **编号分支/退出**：1) owner/aggregate exact；2) expected current range exact；3) H2/full reducer折到末端；4) 比较aggregate head；5) 按stable key比较三个head maps并拒绝missing/extra；6) success void。任一差异`ok:false`。
- **副作用/残留**：只比较caller snapshot；不repair、不write、不publish，无durable residue。
- **进度/终止**：prefix有限；head maps按有限stable keys各扫描一次。
- **§4.3.2 proof**：pre建立same-transaction snapshots；H2 post给I1 raw-derived full state；步骤4得I2 aggregate cursor相等；步骤5得I3所有head sets双向相等；I1∧I2∧I3推出current full-prefix/head exact。所有callee pure，故side effect为空。

#### 5.0.3 Consolidated exact callable inventory and proof ledger（review待核）

本表是本文**唯一完整callable inventory/ledger**。每个exported callable name在本表恰出现一次；F18/F19/F20同时是25-domain builders，分别以`B01/F18`、`B02/F19`、`B03/F20`单行计数，不在F组重复。规范签名仍只在“signature anchor”所指代码块定义；proof anchor包含Requires/Ensures、连续branches/exits、termination与side effects。状态统一保持unchecked，不把“anchor已写”误报为review已通过。

| ID | callable（唯一行） | signature anchor | proof anchor / status |
|---|---|---|---|
| B01/F18 | `buildSemanticDigestInput` | §4.1.3 builder block | §4.1.3a + §5.3.2；`[F — planned; proof present; review unchecked]` |
| B02/F19 | `buildPreparedDigestInput` | §4.1.3 builder block | §4.1.3a + §5.3.3；`[F — planned; proof present; review unchecked]` |
| B03/F20 | `buildBindingDigestInput` | §4.1.3 builder block | §4.1.3a + §5.3.4；`[F — planned; proof present; review unchecked]` |
| B04 | `buildOperationPayloadDigestInput` | §4.1.3 builder block | §4.1.3a row B04；`[F — planned; common proof present; review unchecked]` |
| B05 | `buildSupersessionBindingDigestInput` | §4.1.3 builder block | §4.1.3a row B05；`[F — planned; common proof present; review unchecked]` |
| B06 | `buildEventChainDigestInput` | §4.1.3 builder block | §4.1.3a row B06；`[F — planned; common proof present; review unchecked]` |
| B07 | `buildSourceFactsDigestInput` | §4.1.3 builder block | §4.1.3a row B07；`[F — planned; common proof present; review unchecked]` |
| B08 | `buildRecoverySourceVersionDigestInput` | §4.1.3 builder block | §4.1.3a row B08；`[F — planned; common proof present; review unchecked]` |
| B09 | `buildRecoveryControlTailDigestInput` | §4.1.3 builder block | §4.1.3a row B09；`[F — planned; common proof present; review unchecked]` |
| B10 | `buildRecoveryPolicyDigestInput` | §4.1.3 builder block | §4.1.3a row B10；`[F — planned; common proof present; review unchecked]` |
| B11 | `buildDispatchTargetDigestInput` | §4.1.3 builder block | §4.1.3a row B11；`[F — planned; common proof present; review unchecked]` |
| B12 | `buildSealedMaterialCommitmentInput` | §4.1.3 builder block | §4.1.3a row B12；`[F — planned; common proof present; review unchecked]` |
| B13 | `buildPausedHandleCommitmentInput` | §4.1.3 builder block | §4.1.3a row B13；`[F — planned; common proof present; review unchecked]` |
| B14 | `buildRecoveryClosureDigestInput` | §4.1.3 builder block | §4.1.3a row B14；`[F — planned; common proof present; review unchecked]` |
| B15 | `buildCredentialAuthorityVersionDigestInput` | §4.1.3 builder block | §4.1.3a row B15；`[F — planned; common proof present; review unchecked]` |
| B16 | `buildProviderAuthorizationProofDigestInput` | §4.1.3 builder block | §4.1.3a row B16；`[F — planned; common proof present; review unchecked]` |
| B17 | `buildControlPolicyDigestInput` | §4.1.3 builder block | §4.1.3a row B17；`[F — planned; common proof present; review unchecked]` |
| B18 | `buildToolPlanDigestInput` | §4.1.3 builder block | §4.1.3a row B18；`[F — planned; common proof present; review unchecked]` |
| B19 | `buildToolCallDigestInput` | §4.1.3 builder block | §4.1.3a row B19；`[F — planned; common proof present; review unchecked]` |
| B20 | `buildToolResultDigestInput` | §4.1.3 builder block | §4.1.3a row B20；`[F — planned; common proof present; review unchecked]` |
| B21 | `buildReasoningTextDigestInput` | §4.1.3 builder block | §4.1.3a row B21；`[F — planned; common proof present; review unchecked]` |
| B22 | `buildProviderPrefixDigestInput` | §4.1.3 builder block | §4.1.3a row B22；`[F — planned; common proof present; review unchecked]` |
| B23 | `buildProviderPrefixAncestryDigestInput` | §4.1.3 builder block | §4.1.3a row B23；`[F — planned; common proof present; review unchecked]` |
| B24 | `buildSourceAllowedEventSetDigestInput` | §4.1.3 builder block | §4.1.3a row B24；`[F — planned; common proof present; review unchecked]` |
| B25 | `buildControlAllowedEventSetDigestInput` | §4.1.3 builder block | §4.1.3a row B25；`[F — planned; common proof present; review unchecked]` |
| P1 | `decodeRecoveryPolicyConfig` | §4.6.3 codec block | §4.6.3 numbered common contract；`[F — planned; proof present; review unchecked]` |
| P2 | `encodeRecoveryPolicyConfig` | §4.6.3 codec block | §4.6.3 numbered common contract；`[F — planned; proof present; review unchecked]` |
| P3 | `decodeRecoveryPolicyInputV1` | §4.6.3 codec block | §4.6.3 numbered common contract；`[F — planned; proof present; review unchecked]` |
| P4 | `encodeRecoveryPolicyInputV1` | §4.6.3 codec block | §4.6.3 numbered common contract；`[F — planned; proof present; review unchecked]` |
| H1 | `deriveCommittedIdentity` | §4.9 supporting signatures | §5.0.2 H1；`[F — planned; proof present; review unchecked]` |
| H2 | `foldOperationPostStateThroughSequence` | §4.9 supporting signatures | §5.0.2 H2；`[F — planned; proof present; review unchecked]` |
| H3 | `validateCurrentRecoveryAggregatePrefixAndHeads` | §4.9 supporting signatures | §5.0.2 H3；`[F — planned; proof present; review unchecked]` |
| E1 | `buildRecoveryEventRegistry` | §5.0.1 additional exact callable | §5.1.3a；`[F — planned; proof present; D0 review passed]` |
| F1 | `define` | §5.0.1 | §5.1.1；`[P — implemented; runtime/type evidence; full Step 5 pending]` |
| F2 | `partitionDefinitionsByPublication` | §5.0.1 | §5.1.2；`[P — implemented; property/type/core evidence; full F31 closure pending]` |
| F3 | `buildRecoveryEventDefinitions` | §5.0.1 | §5.1.3；`[F — planned; proof present; review unchecked]` |
| F4 | `validateExactFieldSet` | §5.0.1 | §5.1.4；`[F — planned; proof present; review unchecked]` |
| F5 | `decodeRecoveryDurableRow` | §5.0.1 | §5.1.5；`[F — planned; pure explicit-M4-proof proof present; review unchecked]` |
| F6 | `decodeRecoverySourceFieldSet` | §5.0.1 | §5.1.6；`[F — planned; proof present; review unchecked]` |
| F7 | `decodeRecoveryControlTail` | §5.0.1 | §5.1.7；`[F — planned; proof present; review unchecked]` |
| F8 | `decodeLegacyRecoveryEvidence` | §5.0.1 | §5.1.8；`[F — planned; proof present; review unchecked]` |
| F9 | `normalizeStorageMode` | §5.0.1 | §5.2.1；`[F — planned; trivial proof present; review unchecked]` |
| F10 | `normalizeDispatchTarget` | §5.0.1 | §5.2.2；`[F — planned; proof present; review unchecked]` |
| F11 | `normalizeProviderSafetyDomain` | §5.0.1 | §5.2.3；`[F — planned; proof present; review unchecked]` |
| F12 | `targetWithinSafetyDomain` | §5.0.1 | §5.2.4；`[F — planned; trivial proof present; review unchecked]` |
| F13 | `normalizeRecoveryPolicy` | §5.0.1 | §5.2.5；`[F — planned; proof present; review unchecked]` |
| F14 | `normalizeToolEvidence` | §5.0.1 | §5.2.6；`[F — planned; proof present; review unchecked]` |
| F15 | `normalizeReasoningEvidence` | §5.0.1 | §5.2.7；`[F — planned; explicit-M4-proof proof present; review unchecked]` |
| F16 | `validateSealedRecoveryMaterialRef` | §5.0.1 | §5.2.8；`[F — planned; pure structural proof present; review unchecked]` |
| F16a | `validateProviderCapabilitySummary` | §5.0.1 | §5.2.9；`[F — planned; proof present; review unchecked]` |
| F17 | `canonicalEncode` | §5.0.1 | §5.3.1；`[F — planned; proof present; review unchecked]` |
| F21 | `digestCanonicalCommitment` | §5.0.1 | §5.3.5；`[F — planned; proof present; review unchecked]` |
| F22 | `verifyDigest` | §5.0.1 | §5.3.6；`[F — planned; proof present; review unchecked]` |
| F23 | `mapCausesToManualStopReasons` | §5.0.1 | §5.3.7；`[F — planned; total stable-reason proof present; review unchecked]` |
| F24 | `validateRecoveryProposal` | §5.0.1 | §5.4.1；`[F — planned; branch-exact proof present; review unchecked]` |
| F25 | `validateRecoveryDecisionRecord` | §5.0.1 | §5.4.2；`[F — planned; proof present; review unchecked]` |
| F26 | `validateDispatchReceipt` | §5.0.1 | §5.4.3；`[F — planned; proof present; review unchecked]` |
| F27 | `validateRecoveryAdmissionReceipt` | §5.0.1 | §5.4.4；`[F — planned; proof present; review unchecked]` |
| F28 | `projectRecoveryForPublic` | §5.0.1 | §5.4.5；`[F — planned; proof present; review unchecked]` |
| F29 | `assertPublicRecoveryProjectionSafe` | §5.0.1 | §5.4.6；`[F — planned; proof present; review unchecked]` |
| F30 | `decodeRecoveryPublicProjection` | §5.0.1 | §5.4.7；`[F — planned; proof present; review unchecked]` |
| F31 | `assembleEventManifests` | §5.0.1 | §5.5.1；`[F — planned; proof present; review unchecked]` |

覆盖计数是25 builders（B01–B25，其中B01–B03同时覆盖F18–F20）+4 policy codecs+3 helpers+1 registry-enrichment callable E1+32 numbered labels（F1–F31加F16a，F18–F20不重复成行）。Ledger中的E1仅指`buildRecoveryEventRegistry`；各函数内部的E1/E2/... exit labels只在自身函数段内局部作用，不是callable ID。E1不占F编号且不增加digest domain；任何新增/删除/重命名必须同时改变本计数、signature owner anchor与proof anchor。D0 changed rows已完成fresh independent review。

### 5.1 Event definition、manifest 与 exact decode

#### 5.1.1 F1 `Event.define(input) -> Definition`

规范性签名固定为：

```ts
export function define<
  Type extends string,
  Fields extends Readonly<Record<string,unknown>>,
>(input:Readonly<{
  type:Type
  publication?:"public"|"internal"
  durable?:Readonly<{version:SafePositiveInt;aggregate:keyof Fields & string}>
  schema:Fields
}>):ContractResult<Definition<Type,Struct<Fields>>,EventDefinitionError>
```

F1只能使用该`ContractResult` carrier；module initialization caller负责把`ok:false`转为单一初始化失败，不能另提供throwing/Effect overload改变合同。

- **功能描述**：扩展现有 Event definition，在定义源头冻结 publication；省略时兼容地默认为public，所有 recovery definition必须显式internal。
- **调用关系**：callers: 全部 event schema modules、F3；callees: `Schema.Struct`、现有`statics`。
- **Requires**：type非空；durable version为positive safe integer；aggregate字段名存在于schema；internal recovery caller显式传internal。
- **Ensures**：返回definition与payload schema均保留type/data/durable；static `publication`总是存在；未传publication时为public；payload wire不额外注入publication字段。
- **Invariants**：publication是definition metadata，不是event data；同一definition运行期间不可变。
- **副作用**：创建并freeze schema metadata，并把成功返回的exact object identity登记到module-private `WeakSet` owner registry；registry不持久化、不枚举、不publish且不保活definition。所有失败分支登记次数为0。
- **实现步骤**：
  1. 只接受own data properties；继承的publication/durable或accessor/hostile reflection fail closed。校验`input.publication ?? "public"`仅为两literal；非法返回`ContractResult.ok=false`，尚无副作用。
  2. 若durable存在，校验version与aggregate schema membership；失败退出。
  3. 对own enumerable schema fields逐项验证Effect schema并snapshot，再调用`Schema.Struct`；依赖其post：得到字段codec但不赋予public authority。
  4. 构造现有payload schema。
  5. `statics`返回`type/publication/data`及optional durable；non-durable definition仍创建own non-enumerable、non-writable `durable:undefined` slot以封死prototype注入；不把publication放入payload，并freeze fields/data/durable/definition metadata。
  6. 仅在所有构造与freeze成功后，将exact definition object加入module-private `WeakSet` owner registry并正常返回。
- **分支/退出**：public default（omit或own `undefined`）、explicit public、explicit internal；inherited/accessor publication或durable、invalid publication/version/aggregate/schema member均typed failure；无部分owner registration。
- **callee pre/post引用**：`Schema.Struct`要求字段codec有效并保证结构codec；`statics`只附加metadata，不改变decode结果。
- **正确性论证**：
  - 前置：input满足type/schema基本条件。
  - 论证：步骤1把publication归一为闭集；步骤2阻止不可寻址durable event；步骤3–5将metadata与wire分离，因此public filter可在不改变event payload的情况下机械判定，且旧definition省略字段仍明确变为public。
  - 后置：每个definition都有唯一source-level publication，internal不依赖名字前缀。
  - 副作用论证：除module-private weak owner identity登记外只创建schema/static metadata；WeakSet不枚举、不持久化、不保活且failed exit不写，因此无bus/store/network/public side effect。

#### 5.1.2 F2 `partitionDefinitionsByPublication(definitions) -> {public, internal}`

```ts
export function partitionDefinitionsByPublication<D extends Definition>(
  definitions:readonly D[],
):ContractResult<Readonly<{
  public:readonly PublicEventDefinitionV1<D>[]
  internal:readonly (D & Readonly<{publication:"internal"}>)[]
}>,EventDefinitionError>
```

- **功能描述**：按definition metadata分区并验证同一type/version没有跨publication重复；public branch在literal recheck后产生唯一`PublicEventDefinitionV1` brand。
- **调用关系**：callers: event manifests、F3；callees: F1 post、`Event.versionedType`。
- **Requires**：输入有限；每项由当前module instance的F1产生并仍以同一exact object identity存在。
- **Ensures**：每个输入恰进入一个输出；输出顺序保持输入顺序；duplicate latest/durable key失败。
- **Invariants**：`public ∩ internal = ∅`，并集等于输入。
- **副作用**：无；返回frozen arrays。
- **实现步骤**：
  1. 初始化public/internal数组与latest/durable key map。
  2. snapshot并验证finite safe length后逐definition；依赖F1 post：publication必存在、metadata frozen，且module-private `WeakSet`包含同一object identity。structural lookalike、clone与Proxy均拒绝。
  3. 检查type latest冲突；durable存在时以`versionedType`检查版本key冲突。
  4. 仅在Effect schema/frozen metadata/owner identity与literal publication全部recheck后构造`PublicEventDefinitionV1` brand并加入public；internal加入internal；unknown/default失败。brand constructor不接受generic caller assertion。
  5. freeze并返回。
- **分支/退出**：duplicate或未知publication错误退出，无返回部分数组；两合法分支正常合流。
- **循环**：不变量为前i项已恰分区且无duplicate；每轮i+1，有限length保证终止。
- **callee引用**：`versionedType(type,version)` post为稳定`${type}.${version}`；F1保证publication闭集。
- **正确性论证**：按循环不变量，结束时覆盖全部输入且互斥；duplicate先失败避免同一authority进入两surface。

#### 5.1.3 F3 `buildRecoveryEventDefinitions() -> RecoveryEventDefinitionSetV1`

- **Package owner**：`@opencode-ai/schema`。该package不得import `@opencode-ai/llm`。
- **功能描述**：创建10个internal durable recovery definitions、recursive exact field-set registry与互斥source/control tuple；不计算digest。
- **调用关系**：callers: schema event manifest、durable manifest、F31、LLM `buildRecoveryEventRegistry`；callees: F1（pre/post见§5.1.1）、F2（见§5.1.2）、F4（见§5.1.4）。明确不调用F17/F21或任何LLM callable。
- **Requires**：§4.8.1的`OperationSchemaByTypeV1`完整且TypeScript exhaustive assertion证明10个operation type均有branch；每个nested type已有exact spec。
- **Ensures**：成功调用均返回同一owner-held frozen singleton identity；该值固定含`eventTypeSetVersion:1`、`fieldSetRegistryVersion:1`、10项type-indexed `InternalRecoveryDefinitionV1<T>`/spec、一项7-entry source tuple与一项3-entry control tuple；全部internal+durable、selector均为envelope `aggregateID`且无public项；返回值没有allowed-set digest字段。
- **Invariants**：operation type、event type、payload discriminator、field-set entry一一对应；source/control互斥、顺序固定且全集恰为10项。
- **副作用**：仅在schema module initialization创建并freeze内存definition/spec对象；不注册runtime bus、不持久化、不publish、不hash；这是穷尽副作用列表。
- **实现步骤 / intermediate facts**：
  1. 从closed operation tuple逐项取得type/event/schema；由§4.8.1 pre得I1：每项有唯一exact predecessor/payload spec。
  2. 对每项调用F1；由F1 post得I2：definition metadata完整且publication internal、durable v1，不改变wire field set。
  3. 调F4自检spec可满足且字段名无duplicate；得I3：10项recursive exact spec可用于authority decode。
  4. 调F2；由F2 post得I4：全部项恰分区且public为空，否则typed initialization failure，无半set。
  5. 按固定tuple切分1–7/8–10并检查cardinality、交集、全集；得I5：source/control allowed membership闭合。
  6. freeze `RecoveryEventDefinitionSetV1`并一次性export。
- **分支/退出**：schema/duplicate/public/cardinality任一失败均在export前typed退出；成功只有单一路径。
- **正确性论证**：前置closed tuple + I1–I4推出10项定义完整且不公开；I5推出membership唯一；freeze后返回值满足Ensures且不引入反向dependency。
- **副作用论证**：步骤1–5只分配/验证schema objects，步骤6只发布frozen module value；callee均无外部写入或hash，故副作用穷尽。

#### 5.1.3a E1 `buildRecoveryEventRegistry(definitionSet) -> RecoveryEventRegistryV1`

- **Package owner**：`@opencode-ai/llm`；沿允许方向import schema-owned exact `RecoveryEventDefinitionSetV1`。
- **功能描述**：在不改变raw definition membership/order的前提下，为exact frozen set附加两个existing allowed-set digest brands并返回enriched registry。
- **调用关系**：callers: F5–F7、M4 reader/rebuilder；callees: F4、`buildSourceAllowedEventSetDigestInput`、`buildControlAllowedEventSetDigestInput`、F17、F21。
- **Requires**：输入是F3导出的exact frozen set；versions为1，definitions/fieldSets/source/control tuple identity、cardinality、order、disjoint/exhaustive均与F3一致；不得接受structural lookalike、caller-provided digest或generic domain string。
- **Ensures**：返回值是fresh frozen enriched object，保留输入全部raw field values以及`definitions/fieldSets/sourceEntries/controlEntries`的member identities/order，并只附加`sourceAllowedEventSetDigest:SourceAllowedEventSetDigest`和`controlAllowedEventSetDigest:ControlAllowedEventSetDigest`；两个digest分别由existing domains `source-allowed-event-set-v1`与`control-allowed-event-set-v1`构造，不新增第26个domain。
- **Invariants**：raw/enriched membership完全相同；source/control digest不可互换；schema package不依赖本callable；所有downstream membership/digest consumer使用同一enriched value。
- **副作用**：仅在LLM module initialization构造canonical inputs、计算pure digest并freeze内存对象；不注册bus、不持久化、不publish。
- **实现步骤 / intermediate facts**：
  1. 将输入的top-level与definitions/fieldSets/source/control member identities逐项比较schema导出的F3 owner-held frozen singleton，并以F4/cardinality/order guards复核，得到I1 exact F3 set；任一structural lookalike或identity mismatch均typed退出。
  2. 从I1固定source tuple调用B24，得I2 source input；从固定control tuple调用B25，得I3 control input。
  3. 分别调用F17/F21，得I4/I5两个domain-separated branded digests；任一失败不返回partial registry。
  4. 以fresh allowlisted object复制raw fields、附加I4/I5并freeze；不得spread caller extra fields。
- **分支/退出**：lookalike/stale/version/cardinality/field-set/canonical/hash failure均typed退出；成功单一路径。
- **正确性论证**：I1固定membership；B24/B25+F17/F21保证digest分别绑定同一versions、tuple和recursive exact fields；步骤4只附加这两项，故Ensures成立且无duplicate canonical owner。
- **副作用论证**：所有callee为pure `ContractResult`；只分配/冻结内存对象，副作用为空且穷尽。

#### 5.1.4 F4 `validateExactFieldSet(value, specification, path="$" ) -> void`

- **功能描述**：递归验证authority object的required/optional/forbidden字段、数组元素和closed discriminator；不依赖Effect Schema对extra key的默认策略。
- **调用关系**：callers: F5–F8、F18–F20、F24–F27；callees: primitive validators、`Object.keys`。
- **Requires**：specification自身无duplicate字段，且每个union discriminator值唯一。
- **Ensures**：成功时value的每个object key恰属于spec、required全存在、optional absent/nullability符合、union选中唯一branch；失败返回首个或全部typed path errors，value不变。
- **Invariants**：validator不删除/coerce字段。
- **副作用**：无。
- **实现步骤**：
  1. 根据spec kind分支：primitive/object/array/union/literal。
  2. primitive：检查type/value constraint；失败退出。
  3. object：确认非null普通object且非array；取keys，先检查extra，再required missing；按stable key顺序递归每个present字段。
  4. array：确认array；按index递归。
  5. union：先读取discriminator；missing/unknown失败；只递归匹配branch，禁止尝试多个branch后“最像的”降级。
  6. literal：精确相等，否则失败。
  7. 全部子项成功后返回void。
- **分支/退出**：每种kind与每个validation failure均typed exit；无“忽略extra”路径。
- **循环/递归**：对象/数组有限；每次递归进入严格子值；无cycle是Requires，故结构大小单调下降并终止。canonical输入若有cycle由F17单独检测。
- **callee引用**：primitive validator requires unknown input并ensures不coerce；`Object.keys`只枚举own enumerable string keys，schema inputs禁止symbol/non-enumerable authority字段。
- **正确性论证**：结构归纳：primitive/literal直接成立；object/array在所有直接成员通过且无extra/missing时满足exact spec；union由唯一discriminator选择唯一spec。因此成功蕴含field-set exact，且无修改副作用。

#### 5.1.5 F5 `decodeRecoveryDurableRow(input) -> DecodedRecoveryOperation`

- **Package owner**：`@opencode-ai/llm`；只向下依赖schema raw definitions/codecs与E1 enriched registry。
- **功能描述**：从raw EventTable row与显式M4 owner-mapping proof严格解析known recovery base type/version/envelope/field set；unknown version fail closed。
- **调用关系**：callers: M4 reader/rebuilder；callees仅为versioned type parser、E1 enriched registry、Effect Schema decode、F4、F22与structural equality；**不调用M4/store**。
- **Requires**：`input.row`提供id/type/aggregateID/seq/data且seq为DB读取值；`input.ownerProof`由M4在同一read authority scope内完成一对一owner-index lookup后构造，brand与lifecycle由M4拥有。
- **Ensures**：成功返回已验证operation且event type/version/fieldSet/payloadDigest一致，输出owner精确来自proof；unknown/malformed/owner mismatch不返回部分operation。
- **Invariants**：不读取owner mapping、materialization或public projection补字段；M1不能构造/refresh owner proof。
- **副作用**：无；只读两个显式输入并pure compare。
- **实现步骤**：
  1. 解析stored type最后一个`.`后的十进制version；无version、非safe positive integer→decode error。
  2. 查E1 enriched registry的exact versioned key；未找到时区分：known recovery base+unknown version→`unknown-event-version`；未知`session.recovery.*`→`unknown-event-type`；非recovery row→`not-recovery-event`供caller过滤。
  3. 调用definition data codec；依赖codec post为typed shape，但尚不信任extra key。
  4. 调F4验证event data与operation envelope exact field set。
  5. F4验证`ownerProof` exact且owner/mapping literals固定；校验definition durable selector确为`aggregateID`，并要求`row.aggregateID==envelope.aggregateID==ownerProof.aggregate.aggregateID`、payload内所有sessionID等于`ownerProof.aggregate.sessionID`、row seq等于envelope.aggregateSequence。不得读取M4 mapping或以payload.sessionID选择aggregate。
  6. 由known operation branch构造exact `OperationPayloadDigestInputV1`并调F22验证`OperationPayloadDigest`；type-10先要求raw持有branch-exact完整`supersessionBindingInput`，调用`buildSupersessionBindingDigestInput`+F22重算digest并与payload/decision逐项equal，model再验证`submissionPayloadDigest/intendedInitialOperationID`且no-reply验证commit-user-only literal；type-1 reservation ref必须比较对应model digest。不得把operationID/sequence误纳入payload domain或用operationID-only lookup补input。
  7. 校验`eventChain.previousDigest==expectedPredecessors.aggregateEventHead.digest`，构造exact `EventChainDigestInputV1`并调F22重算`nextDigest`；同时验证genesis sequence=0或ordinary sequence=predecessor+1。
  8. 校验event type、operationType、payload discriminator、registry field-set ref一一对应。
  9. 返回decoded operation及已验证raw row sequence。
- **分支/退出**：非recovery可由caller显式忽略；任何unknown recovery version/type、codec、field-set、aggregate、digest、discriminator mismatch均authority-invalid失败。
- **callee引用**：F3 guarantees raw definition set唯一，E1 guarantees enriched registry唯一；F4 guarantees exact fields；F22 guarantees digest对应canonical payload。
- **正确性论证**：前置row字段可读且M4已产出同scope owner proof；步骤1–4得到中间事实I1（known definition + recursive exact fields）；步骤5只比较显式proof并得到I2（row/envelope/owner/session/sequence一致）；步骤6得到I3（payload membership与commitment一致）；步骤7得到I4（previous head、sequence与公式计算的next digest一致）；步骤8得到I5（event/type/schema registry一致）。I1∧I2∧I3∧I4∧I5推出成功结果可作为raw authority decode输入。后置为完整decoded operation，无partial authority。
- **副作用论证**：version parse、schema decode、F4/F22与proof equality均为纯读取/计算；签名没有M4/store capability，函数不写row、registry、DB或日志，副作用为空且穷尽。

#### 5.1.6 F6 `decodeRecoverySourceFieldSet(events, sourceAssistantID, highWater) -> RecoverySourceVersion`

- **Package owner**：`@opencode-ai/llm`；与F5共用E1 enriched registry，不向schema反向暴露canonical runtime callable。
- **功能描述**：从已decode raw prefix提取版本化source facts并冻结source version。
- **调用关系**：callers: M4 snapshot/rebuilder；callees: F5、F4、F16、F17、对应payload builders、F21/F22。
- **Requires**：events按aggregate seq升序覆盖0..highWater；每项来自F5或已具有等价post。
- **Ensures**：成功返回完整event-chain/facts digest/field sets；普通control事件不进入facts digest；未知/gap/duplicate/conflict失败。
- **Invariants**：只选择指定source assistant的source set；source/control互斥。
- **副作用**：无。
- **实现步骤 / intermediate facts**：校验sequence从0连续并逐event复核F5 nextDigest，得到I1完整aggregate chain；按E1 enriched registry membership分支：source且属于assistant→验证并纳入facts，source属于其它assistant/control/ordinary event只纳入aggregate chain；对tool/reasoning/prefix source fact要求authoritative class、reconstructible carrier与对应owner commitment；inline carrier在此strict decode/re-encode，sealed carrier验证exact ref/purpose/scope/commitment shape且保留给M4 snapshot materialization（不得在F6内unseal）；两branch都从secret-safe carrier projection调用owner builder/F22，得到I2 source-bound payload carrier+commitment；fold并检测冲突，得到I3唯一source facts；从E1 enriched registry复制而非caller提供`eventTypeSetVersion/fieldSetRegistryVersion/sourceAllowedEventSetDigest`，按registry tuple排序field-set refs，得到I4 registry-bound membership；构造`SourceFactsDigestInputV1`计算`SourceFactsDigest`，再构造`RecoverySourceVersionDigestInputV1`计算`versionDigest`，得到I5两个branded commitments；组装并F4复检后返回。
- **分支/退出**：gap/duplicate、多个terminal、dispatch gap、同fact冲突、compatibility tool混入raw source、payload carrier missing/unreadable/noncanonical、commitment mismatch、未知版本、secret marker均失败。
- **循环**：不变量为已处理prefix连续、chain digest对应该prefix、facts仅来自source；每轮消费一项，有限数组终止。
- **callee引用**：F5 ensures每event exact；F16只验证sealed ref structural/purpose/scope；F17 canonical bytes稳定；payload builders/F22验证两类carrier projection的owner commitment；F21 SHA-256 envelope正确。
- **正确性论证**：前置为0..highWater exact prefix；I1保证aggregate chain完整，I2保证Continue所需carrier与owner commitment属于同一source fact（sealed actual material validation由snapshot boundary追加），I3保证facts仅属于指定committed source且无冲突，I4保证event/field-set version与source allowed-set commitment冻结，I5保证facts与source version不可被其它domain digest替换；五项合取推出Ensures。后置是完整`RecoverySourceVersion`，unknown/gap/conflict/payload loss无返回值。
- **副作用论证**：只读event array与frozen E1 enriched registry并执行纯fold/canonical/hash；不写event、snapshot或DB，副作用为空且穷尽。

#### 5.1.7 F7 `decodeRecoveryControlTail(events, sourceVersion) -> RecoveryControlTailVersion`

- **Package owner**：`@opencode-ai/llm`；与F5/F6共用E1 enriched registry。
- **功能描述**：验证source high-water之后的exact control range，不允许普通或source语义混入旧binding。
- **调用关系**：callers: M4 snapshot/re-entry、M6 composite recheck；callees: F5、E1 enriched registry membership、F17/F21。
- **Requires**：events按seq覆盖`source.highWater+1..currentHighWater`，可为空。
- **Ensures**：空tail产生固定empty genesis；非空只含allowed control set且hash/count/range exact。
- **Invariants**：任何普通input/config/history/tool/source event都使旧binding stale/invalid，而非被忽略。
- **副作用**：无。
- **实现步骤 / intermediate facts**：先验证source version的registry versions/source allowed digest/versionDigest，得到I1可信source boundary；若空，令`emptyTailGenesis=tailHash=previousSourceHead`（空fold identity），得到I2 empty exact range；若非空，校验第一seq=highWater+1及连续，逐项要求F5成功且membership=control，得到I3 exact control range；两分支均从E1 enriched registry复制control event/field registry versions与`ControlAllowedEventSetDigest`、按registry顺序收集field refs，得到I4；构造`RecoveryControlTailDigestInputV1`计算`versionDigest`并F4复检，得到I5后返回。
- **分支/退出**：空正常；非空allowed正常；gap/duplicate/source/ordinary/unknown/mismatched assistant失败。
- **循环**：每轮消费一event，有限终止；不变量为已处理tail连续且仅control。
- **callee引用**：F5/E1 post同上；F21保证hash。
- **正确性论证**：I1固定source边界；empty分支I2或nonempty分支I3恰覆盖全部输入；I4绑定control allowed set与field-set registry；I5绑定最终tail fields。故成功返回值代表exact tail，普通/source/unknown event不能被忽略，满足stale detection post。
- **副作用论证**：函数只读输入与E1 enriched registry并计算commitments；无持久化/publication/repair，副作用为空且穷尽。

#### 5.1.8 F8 `decodeLegacyRecoveryEvidence(rowSet) -> LegacyCompatibilityEvidence`

- **功能描述**：把feature前旧assistant/tool/reasoning rows解码为保守unknown/opaque evidence，不推断available。
- **调用关系**：callers: migration-compatible snapshot reader；callees: existing Legacy codecs、F14/F15、F4。
- **Requires**：输入可能缺future recovery字段但可包含当前Legacy message/part shape。
- **Ensures**：成功输出`eligibleForAutomatic:false`；每个observed Legacy tool part恰产生一个按`legacyPartOrdinal`排序的`CompatibilityToolEvidenceV1`，不得因缺字段/仅有兼容payload而省略；缺`providerExecuted`→unknown；无durable dispatch ledger→opaque/inconsistent cause；reasoning metadata无provenance→unknown；结构冲突失败。
- **Invariants**：old row永不创建available dispatch、authoritative tool、provider prefix、replay proof或sealed ref；compatibility payload即使可重建也不取得automatic authority。
- **副作用**：无。
- **实现步骤**：先用现有Legacy codec解码；codec失败→malformed old row；识别assistant/model及按durable part order枚举全部tool/reasoning；每个tool调用F14 old-row branch并保留ordinal/missing/unknown/observed payload及cause，不做“无证明即删除”；reasoning调用F15 old-row branch；因无recovery dispatch operation固定生成`{source:"dispatch",kind:"ledger-conflict"}` lower-level cause；返回完整compatibility evidence。
- **分支/退出**：无tool合法空compatibility数组；每个tool fields missing、reasoning metadata present/absent均只影响unknown摘要，不影响fact presence；冲突如同一Legacy part identity重复或同一call多终态→失败；绝无available/authoritative分支。
- **callee引用**：Legacy codec只保证当前shape；F14/F15保证missing不转false/provider-end，F14 old-row result nominally/structurally固定compatibility-only。
- **正确性论证**：枚举全部parts保证compatibility事实完整；automatic eligibility被常量false与compatibility authority class双重封闭；所有未知事实保持unknown，故旧行既不会被遗漏成truly-empty，也不会被错误提升为recovery proof。

### 5.2 Normalization 与 invariant validators

#### 5.2.1 F9 `normalizeStorageMode(value) -> StorageMode`

- **功能描述**：把provider storage option归一为三值。
- **调用关系**：callers: M2 adapters、F10/F18；callees: 无。
- **Requires**：输入为unknown。
- **Ensures**：`true→"true"`、`false→"false"`、`undefined/absent→"unknown"`、literal `"unknown"`仅内部已typed调用可保留；其它值typed error。
- **Invariants**：null不等于unknown，unknown不等于false。
- **副作用**：无。
- **所有分支**：上述五类完全覆盖；错误退出无值。
- **正确性论证**：trivial（有限闭集switch，无循环/跨模块/副作用；映射表即post）。

#### 5.2.2 F10 `normalizeDispatchTarget(raw) -> DispatchTarget`

- **功能描述**：从audited descriptor产生exact structured target；禁止display/current-config猜测。
- **调用关系**：callers: M2；callees: URL parser、F4、ID normalizer、F21（credential digest validation）。
- **Requires**：raw来自final adapter introspection；credential raw value未传入。
- **Ensures**：成功target满足§4.3.1；任何必填未知返回typed target/authority unavailable。
- **Invariants**：不trim后悄悄接受；除host/scheme协议规定lowercase外，ID保持case。
- **副作用**：无。
- **实现步骤**：F4校验raw descriptor exact；逐ID检查string/NFC/nonempty/no edge whitespace；解析endpoint并拒绝非https/userinfo/query/fragment；lowercase scheme/host、移除443、规范path尾斜杠；验证deployment/region；验证authority至少一项且无secret-like keys；验证credential digest envelope；组装后再次F4校验并返回。
- **分支/退出**：endpoint URL或structured endpoint输入可由adapter先统一，M1只接收统一raw descriptor；缺target字段→planned-target-unavailable；缺authority→planned-authority-unavailable；非法credential→authority error。
- **callee引用**：URL parser post提供结构化components但不保证业务安全，后续显式拒绝；F4保证字段exact；digest validator保证commitment格式。
- **正确性论证**：每个type invariant在对应步骤建立，组装后复检，因此返回值满足全部target不变量且不含raw secret。

#### 5.2.3 F11 `normalizeProviderSafetyDomain(raw) -> ProviderSafetyDomain`

- **功能描述**：规范化provider contract声明的安全domain。
- **调用关系**：callers: M2 provider descriptor；callees: F10共享endpoint/authority normalizers、F4。
- **Requires**：raw来自版本化audited descriptor；model family scope有显式contract flag。
- **Ensures**：返回closed modelScope与完整target-domain字段；未知scope/contractVersion失败。
- **Invariants**：family不得由model prefix猜测。
- **副作用**：无。
- **实现步骤**：exact field校验；规范共同字段；switch modelScope：exact要求modelID，family要求modelFamily和explicit family authorization；校验contractVersion positive safe；返回。
- **分支/退出**：exact/family两正常分支；unknown/missing/mixed字段失败。
- **callee引用**：F10 shared normalizers post保证endpoint/authority canonical。
- **正确性论证**：closed union与explicit family gate排除范围扩大，返回domain可机械比较。

#### 5.2.4 F12 `targetWithinSafetyDomain(target, domain) -> boolean`

- **功能描述**：结构化判定target是否属于domain。
- **调用关系**：callers: F14 receipt/evidence validators、M5/M7；callees: canonical structural equality。
- **Requires**：target来自F10，domain来自F11。
- **Ensures**：仅当provider/route/protocol/endpoint/authority全部equal，且model满足exact或family scope时true。
- **Invariants**：不使用display name、prefix、case folding、current config。
- **副作用**：无。
- **实现步骤**：比较共同字段；任一不等立即false；switch scope：exact比较modelID且若target有family不影响exact；family要求target.modelFamily存在并exact equal；true返回。
- **分支/退出**：共同字段mismatch false；exact true/false；family missing/mismatch false、match true；unknown scope assertNever。
- **正确性论证**：比较项恰等于domain定义的全部成员，无遗漏或额外推断，因此true等价于结构membership。

#### 5.2.5 F13 `normalizeRecoveryPolicy(input: RecoveryPolicyInput) -> ContractResult<NormalizedRecoveryPolicy>`

- **功能描述**：在`decodeRecoveryPolicyConfig`已完成nested snake_case codec与safe-integer refinement后，应用默认N=2、M=64与effective min规则。
- **调用关系**：callers: M6 initial/ordinary/recovery planner、`decodeRecoveryPolicyConfig`；callees: safe integer validator、F17/F21。
- **Requires**：输入只来自exact external config decoder或等价typed internal caller；配置层不得预clamp或接受alias。
- **Ensures**：合法输出满足§4.6.3并带policyDigest；非法类型/负数/float/non-safe/M=0均失败。
- **Invariants**：N、M不改变各自计数语义；default只在absent使用。
- **副作用**：无。
- **实现步骤 / intermediate facts**：区分absent/present并记录独立provenance；N absent→2/`default-n2-v1`，present→validated value/`explicit-config`，得到I1；M同理得到64或explicit及I2；agentSteps形成closed absent/present及I3；计算effective min得到I4；仅用归一数值与closed agentSteps构造exact `RecoveryPolicyDigestInputV1`（不放provenance），调用F17/F21得到`RecoveryPolicyDigest`及I5；组装provenance并返回。
- **分支/退出**：N=0、M=1、agentSteps=1合法；非法值typed failure；digest failure整体失败；absent default与explicit同值的digest equal是required branch assertion。
- **callee引用**：safe integer validator pre为unknown、post为branded范围且不coerce；F17 pre为registry exact input、post为deterministic canonical bytes；F21 post为`RecoveryPolicyDigest`。
- **正确性论证**：前置typed input已由exact external codec完成snake_case映射/refinement且未clamp；I1–I3覆盖每个配置来源，I4直接建立effective M，I5因provenance不在digest input建立default/explicit同值等价；组装后满足§4.6.3全部post。
- **副作用论证**：只解析输入并计算纯digest；provenance仅返回内存值，不写config/log/public state，副作用为空且穷尽。

#### 5.2.6 F14 `normalizeToolEvidence(raw, mode) -> ToolEvidenceByNormalizationModeV1[mode]`

- **功能描述**：把current/future或Legacy tool facts规范化为互斥authority class，保留完整compatibility事实、reconstructible replay carrier与durable execution phase并拒绝矛盾。
- **调用关系**：callers: M3/M4 fold、F8；callees: F4、F16 structural ref validator、F17 canonical payload token rules（inline复用，不新增callable）、对应digest builders/F22、stable range/ordinal validator；sealed payload lookup/unseal与actual material validation由M4 snapshot boundary拥有，F14不查询store。
- **Requires**：mode=`authoritative|old-row`；authoritative raw来自versioned source events并含M1 phase literal、carrier与commitment；old-row来自已知Legacy part且保留part ordinal。sealed carrier在F14只可作为purpose/scope exact ref进入，不能被当作已materialized automatic proof。
- **Ensures**：authoritative成功值精确为`AuthoritativeToolEvidenceV1`；old-row成功值精确为`CompatibilityToolEvidenceV1`且`authorityClass:"compatibility-only"`、phase绝不为automatic eligible；缺字段为unknown而不构造proof；冲突、payload不可重建或digest不匹配失败。
- **Invariants**：optional `providerExecuted`缺失不等于false；settlement/phase不由UI state猜测；digest是commitment而非payload；F14不构造M4 nominal proof。
- **副作用**：无。
- **实现步骤 / intermediate facts**：1) 按mode exact decode，authoritative要求source range/call ordinal，old-row要求legacy part ordinal，得到I1 disjoint authority class；2) total映射execution/input/call/settlement/interruption，missing按mode失败或unknown，得到I2；3) closed switch验证planned/body-outcome/final-after-hook/reconciled/unknown phase与settlement/interruption/providerExecuted组合，得到I3；4) 对arguments/terminal result-or-error carrier分支：inline执行exact decode/re-encode；sealed调用F16验证ref并检查arguments/result/error对应purpose及scope，actual material validation标记为M4 snapshot prerequisite；两branch都确定唯一secret-safe commitment projection，得到I4 reconstructible carrier；5) 从I4 projection调用tool plan/call/result builders+F22逐项重算，final/body-outcome phase要求三commitments全在且一致，得到I5；6) old-row即使payload完整也强制compatibility phase/causes，authoritative保留exact source range；7) F4复检/freeze返回。
- **分支/退出**：两authority mode；五phase；四settlement、三execution、inline/sealed、result/error及各missing/known分支完整覆盖。planned/body-outcome/unknown/reconciled均可返回typed evidence但不能automatic；logical conflict、noncanonical payload、ref/purpose/scope/material/digest mismatch均typed failure。
- **循环/终止**：carrier tree、sealed validation inputs与固定commitment集合有限；递归严格进入子值，finite acyclic pre保证终止。
- **callee引用**：F4 exact；F16只证明ref structural/purpose/scope；F17 token rules的inline inverse/re-encode证明unique canonical value；builders/F22证明owner commitment对应exact carrier projection。sealed registered/readable/material HMAC/decode match是M4 snapshot post，不由F14越权声称。
- **正确性论证**：I1使authoritative/compatibility不可混淆；I2–I3使phase与事实闭合且unknown不升级；I4保证inline actual content或sealed exact reconstruction carrier；I5使两类carrier projection立即绑定owner commitment，并为sealed保留不可省略的snapshot material-HMAC/decode obligation；old-row branch常量compatibility-only。因此F14既不把digest当reconstruction，也不把structural sealed ref、Legacy或crash intermediate误证为automatic，且所有callee纯使副作用为空。

#### 5.2.7 F15 `normalizeReasoningEvidence(input) -> ReasoningEvidence`

- **功能描述**：规范化provider-end与两类forced flush provenance及sealed state refs。
- **调用关系**：callers: M3/M4 fold、F8、M7；callees: F4、F16 structural sealed-ref validator、F17 text token rules（inline复用）、reasoning builder/F22、public metadata allowlist validator与inline M4-proof equality；不调用M4/store。
- **Requires**：input按mode闭合：authoritative必须有versioned provenance event，且`sealedLookupProofs`为每个state ref显式携M4 lookup产生的same-ref proof；old-row可只有text/metadata且proof tuple exact为空，不能生成ref authority。
- **Ensures**：只有显式provider-end保留该provenance；同时产生M1 exact `continuationMode`，signed/stored-reference只对应可证明provider-end，forced flush为none，old-row无proof时provenance/mode均unknown；敏感state只能以sealed refs表示。
- **Invariants**：metadata presence不证明provider-end/signature；forced flush不可升级；M4 durable fact必须直接存储M1 mode literal或total versioned mapping输出。
- **副作用**：无。
- **实现步骤**：按mode exact decode；switch provenance并以closed total table生成`continuationMode`；验证provider-end×signed/stored-reference、forced×none、old-row×unknown组合；验证protocol/target digest；若content存在，按§4.4.5分支：inline验证exact canonical string、重编码byte-equal并从exact text调用reasoning builder+F22；sealed `reasoning-content` ref执行F16并逐字段比较显式M4 lookup proof，要求textDigest存在并从exact ref projection调用builder/F22，同时把unseal/material-HMAC/decode/re-encode义务保留为M4 snapshot prerequisite；进入Continue所需branch缺content/textDigest或structural commitment不一致则失败；逐state ref调用F16取得structural exact，并在authoritative branch从显式proof tuple唯一匹配refID、逐字段比较registered-readable proof，old-row禁止proof升级；按provider-specific public metadata allowlist复制安全scalar/array；发现signature/encrypted/raw reasoning key立即secret violation；返回。
- **分支/退出**：四provenance分支；content absent/inline/sealed；required content/state、M4 proof/material missing/extra/duplicate/mismatch、canonical decode或text digest mismatch返回typed unavailable/decode failure（按caller context）；未知metadata key失败而非透传。
- **循环**：content tree、state refs/proofs/metadata keys有限；每轮处理一项，终止。
- **callee引用**：F16 ensures sealed structural scope/purpose/metadata；M4 proof producer owns lookup/readability，F15只比较显式proof；inline canonical decoder/re-encoder保证exact text reconstruction；两branch builder/F22保证content projection commitment；sealed unseal/material-HMAC/decode由M4 snapshot boundary追加；allowlist post保证无raw authority metadata。
- **正确性论证**：provenance只由closed discriminator建立，旧metadata不参与判断；inline content exact decode+digest recompute、sealed exact carrier+mandatory snapshot recompute共同防止one-way commitment替代实际text；F16+M4 proof equality在不读取store的情况下建立ref registered-readable但不越权声称material已decode；raw sensitive key被拒绝，故返回evidence满足来源、reconstructibility carrier与secret隔离。

#### 5.2.8 F16 `validateSealedRecoveryMaterialRef(ref, expectedScope, allowedPurposes) -> ref`

- **功能描述**：pure验证sealed ref的recursive structure、literal issuer、scope、purpose与keyed-commitment metadata；不声称store登记或key当前可读。
- **调用关系**：callers: F15、F18/F19、M2/M4/M7 structural boundary；callees仅F4、primitive/refID/hex/key-version validators与structural equality；**不调用M4/store/F22**。
- **Requires**：expectedScope来自当前session/committed assistant/`DispatchTargetDigest`；allowedPurposes非空closed set；若caller还需要registered-readable authority，必须另提供M4 lookup产生的`M4SealedRecoveryMaterialLookupProofV1`给F15/F19等later pure comparison。
- **Ensures**：成功ref recursive exact、issuer literal为M4、purpose/scope exact、derivation为HMAC、commitment envelope/key metadata结构合法且不含raw material；不保证refID已登记或key live/readable。
- **Invariants**：scope/issuer/metadata mismatch fail closed；任何raw/plaintext SHA digest字段为extra并失败；structural success不得升级为store authority。
- **副作用**：严格无；不lookup、不unseal、不rotate、不write。
- **实现步骤 / intermediate facts**：F4 exact得到I1无extra/raw字段；验证`issuer:"m4-sealed-store"`与opaque refID语法得到I2；验证purpose与scope得到I3；验证`commitmentDerivation:"hmac-sha256"`、`SealedMaterialCommitment` envelope、keyID/version及cross-field metadata结构得到I4；返回原ref。
- **分支/退出**：malformed/issuer/scope/purpose/derivation/key metadata mismatch typed failure；全部通过正常；没有lookup或unkeyed fallback branch。
- **正确性论证**：I1排除plaintext字段，I2建立唯一允许的issuer literal与opaque syntax（不冒充登记proof），I3建立use-site structural binding，I4建立keyed metadata shape；合取恰推出structural Ensures而不越权推出store readability。
- **副作用论证**：所有callee pure且签名没有store/proof constructor capability，故副作用为空且穷尽。M4 lookup/proof生产是F16之前或之外的M4-owned I/O，不属于M1 residue。

#### 5.2.9 F16a `validateProviderCapabilitySummary(summary, target, storageMode) -> ProviderCapabilitySummary`

- **功能描述**：验证provider capability descriptor完整表达开放能力空间，并施加本release保守allowlist；不允许通过删字段把unsupported伪装成absent。
- **调用关系**：callers: M2 final preparation、M7 closure planning、F19；callees: F4、F12、F23 cause registry validator、`assertNever`。
- **Requires**：summary来自版本化audited provider descriptor；target由F10产生；storageMode由F9产生。
- **Ensures**：所有7个capability字段均存在且为supported/typed-unavailable/unknown之一；Anthropic server/hosted、OpenAI hosted/provider-executed、OpenAI store=false reasoning在本release不能返回supported；合法supported项与target/protocol/storage匹配。
- **Invariants**：typed unavailable是有意义的typed结果，不被omit；unknown不等于unsupported或safe；descriptorVersion变化进入PreparedDigest。
- **副作用**：无。
- **实现步骤**：
  1. F4验证summary exact，缺任一能力字段立即field-set failure。
  2. 验证descriptorVersion positive safe，并校验每个decision的feature discriminator与字段名一致。
  3. 对7个decision有限循环：supported验证mode与provider contract；typed-unavailable/unknown验证lower-level cause的source/kind branch合法；未知status走assertNever。
  4. 按target.protocol/provider/storage分支施加首批allowlist：Anthropic拒绝server/hosted supported；OpenAI store=true拒绝hosted supported；OpenAI store=false要求storeFalseReasoning不是supported且storedReasoning不是supported；其它protocol只能返回对应unknown/typed-unavailable，不能凭通用shape supported。
  5. 验证replay supported mode与target所属domain、sealed ref availability由调用点另行满足；本函数只检查descriptor声明自洽。
  6. 返回frozen summary。
- **分支/退出**：每个capability的三status；Anthropic/OpenAI true/OpenAI false/OpenAI unknown/其它protocol；任一非法supported组合失败并由planning产生对应typed unavailable cause，不删除字段后继续。
- **循环**：固定7项，每轮消费一项，必终止；不变量为已处理decision字段存在、discriminator正确且满足当前allowlist。
- **callee引用**：F4 ensures exact fields；F9 storage三值不变量；F23 cause registry确保typed unavailable cause可稳定映射；F12在需要domain检查时保证结构membership。
- **正确性论证**：exact field-set保证开放能力均被表达；closed status与协议/storage矩阵排除首批未批准能力被标supported；保留typed-unavailable variant使未来扩展可提升descriptor而无需改变架构type，因此同时满足保守release与开放capability空间。

### 5.3 Canonical encoding 与 digest

#### 5.3.1 F17 `canonicalEncode(spec, value)`（generic `I/O/E`精确声明见§5.0.1）

- **功能描述**：对已声明canonical input执行versioned、domain-separated、key-order-independent编码。
- **调用关系**：callers: F6/F7/F13/F18–F21/F24；callees: F4、UTF-8 encoder。F14/F15只复用本节payload token grammar，不调用F17 domain-prefixed callable。
- **Requires**：spec对象identity来自§4.1.3 frozen registry而非caller仿造；value满足该spec recursive exact field set；acyclic；只含null/boolean/string/safe integer/array/plain object；raw secret已替换为sealed/keyed commitment。
- **Ensures**：相同语义值产生相同bytes；object insertion order无关；array order、field presence、null、scalar变化敏感；不同domain/version前缀不同。
- **Invariants**：不调用普通`JSON.stringify(value)`作为最终算法；不coerce unsupported值。
- **编码规则**：前缀为UTF-8字节序列 `opencode-session-recovery\u0000v1\u0000${domain}\u0000`（其中每个 `\u0000` 表示单个NUL分隔字节，而不是六个可见字符）；payload使用closed canonical JSON：object keys按UTF-16 code unit升序；strings拒绝lone surrogate并按JSON escape；numbers仅限`Number.isSafeInteger(value) && !Object.is(value,-0)`；float、finite decimal、exponent-only值与`-0`全部拒绝；undefined/function/symbol/bigint/Date/Map/Set/Uint8Array/nonplain prototype拒绝；optional absent与explicit null不同。
- **实现步骤 / intermediate facts**：以object identity查closed registry并取得domain/inputVersion/exact spec，得到I1 caller不能注入domain；F4检查value得到I2 recursive exact；初始化ancestor set；递归encode primitive/array/object并在每次number分支拒绝非safe integer与`-0`，得到I3 deterministic payload tokens；拼接固定registry domain prefix并UTF-8 encode得到I4 final bytes。
- **分支/退出**：每种JSON kind；unsupported/cycle/lone surrogate/unsafe number/secret-key sentinel均`RecoveryContractError` with `kind:"canonicalization"`；无部分bytes返回。
- **递归**：每次进入严格子节点；ancestor set检测cycle；有限acyclic图保证终止。对象排序有限。
- **callee引用**：F4 ensures exact fields；UTF-8 encoder ensures Unicode→bytes确定；不依赖locale sort。
- **正确性论证**：前置spec来自closed registry；I1建立domain闭合，I2建立membership exact，I3由固定排序/escape/only-safe-integer建立唯一payload编码，I4建立domain separation；因此同semantic input同bytes、任一成员变化敏感并满足Ensures。
- **副作用论证**：F4、排序、UTF-8 encoder均只分配内存；不读写外部状态，副作用为空且穷尽。

#### 5.3.2 F18 `buildSemanticDigestInput(request) -> SemanticDigestInputV1`

- **功能描述**：从exact lowered request建立semantic membership，显式排除recovery ephemeral identity。
- **调用关系**：callers: M2/M7；callees: F10、F9、tool definition canonicalizer、F16 structural validator、F4与inline proof equality；不调用M4/store。
- **Requires**：request已经过所有semantic transforms且尚未send；body为可canonical JSON；target exact；每个sealed ref都有M4另行lookup后产生的same-ref `M4SealedRecoveryMaterialLookupProofV1`显式输入。
- **Ensures**：输出只含§4.1.2 semantic members；不含decision/child/lineage/context/proof/timestamp/operationID/runtime handle/raw secret。
- **Invariants**：final tools按wire order保留；object key order不重要但array/order语义保留。
- **实现步骤**：校验target/storage；规范final tool definitions与wire options；遍历system/history/body，遇敏感slot必须替换为sealed ref/commitment；对每个ref先调F16得structural exact，再从显式proof tuple按refID唯一匹配并逐字段比较registered-readable proof；missing/extra/duplicate/mismatch proof失败；构造fresh allowlisted object；F4 exact；运行forbidden-key scanner；返回。
- **分支/退出**：无tools合法空array；storage unknown保留unknown；敏感raw值、unsupported body、forbidden identity key、sealed proof missing/extra/stale/mismatch均失败。
- **循环**：有限tool/message/body tree与proof tuple；每轮严格消费一ref/proof，终止同F17。
- **callee引用**：F10/F9 post建立target/storage；F16只保证sealed structural/scope/purpose exact；M4 proof producer post由显式nominal input承诺lookup成功，F18只做equality；F4保证field set。
- **正确性论证**：fresh allowlist construction保证未声明字段无法进入；F16+proof equality把结构合法与M4 lookup authority显式组合且不引入M1→M4 read；forbidden scanner提供第二道检查；成员表逐项加入，排除项无读取路径，因此semantic digest排除decision/child/timestamp等固定决策。

#### 5.3.3 F19 `buildPreparedDigestInput(input) -> PreparedDigestInputV1`

- **功能描述**：以唯一`PreparedDigest` brand构造dispatch-kind discriminated input；三branch都绑定exact final request，只有automatic recovery另绑定source/action/closure。
- **调用关系**：callers: initial/ordinary M2 preparation、automatic M2/M7；callees: F22、F12、F16 structural validator、F16a、F4与inline M4-proof equality；不调用M4/store。
- **Requires**：`input.request`是F18成功的exact final request input，semantic digest已由F21产生；context origin与dispatchKind一致；handle仍paused；provider hit=0；automatic closure已固定或明确not-needed；initial/ordinary输入不存在source/closure字段。
- **Ensures**：initial/ordinary成功值exact含final target/authority/storage/tools/options/system/history/body及common preparation proof，但不含`RecoverySourceVersion`、automatic action、closure或closure digest；automatic成功值在相同common members上另含source/action/closure。全部branch排除raw handle/raw secret/timestamp；首批typed-unavailable capability不能进入available prepared input。
- **Invariants**：一个branded paused-handle commitment只对应一个prepared body/version/context；`request.targetDigest/storageMode`与authorization/replay/capability target facts cross-equal；PreparedDigest brand不因branch拆成多个brand。
- **实现步骤 / intermediate facts**：B1 F22以`semanticDigestSpecV1`和exact `request`复验semantic digest，得到I1 final request逐字段绑定；B2验证request target属于safety domain、context origin=`dispatchKind`、authorization allowedAction与branch equal，得到I2；B3对replay/closure中的每个sealed ref调F16并与显式M4 lookup proof唯一逐字段比较，得到I3而不读store；B4 F16a验证capability summary与本release allowlist，验证authorization descriptor versions；B5 switch dispatchKind：initial/ordinary各构造只含common exact字段并拒绝source/action/closure extra；automatic要求sourceVersion、action及safe-retry→not-needed或continue→available closure；Continue逐字段验证closure `sourceBinding`等于sourceVersion aggregate/source/versionDigest及同一snapshot control-tail digest，并验证carrier/commitment/capability一致；B6加入`PausedHandleCommitment`及prepared body format/version；B7 fresh object+F4+forbidden scanner；B8返回。
- **分支/退出**：initial、ordinary、automatic三合法branch；origin/action mismatch、initial/ordinary recovery-field extra、automatic source/closure missing或mismatch、sealed proof missing/extra/stale、unknown proof、typed-unavailable capability、scope mismatch均typed失败。
- **callee引用**：F22保证semanticDigest对应exact request；F12 membership；F16仅保证ref structural exact，registered-readable结论来自显式M4 proof并由F19 pure equality组合；F16a guarantees capability字段完整且保守allowlist成立；F4 exact。
- **正确性论证**：I1把final target/authority/storage/lowered system/history/body/options直接带入prepared input；I2–I4绑定common authorization facts；dispatch switch使initial/ordinary在type层不可含recovery source/closure，而automatic额外字段完整；raw resource被commitment替代，故同一brand仍可branch-exact表示三类prepared request且不泄secret/handle。

#### 5.3.4 F20 `buildBindingDigestInput(source) -> BindingDigestInputV1`

- **功能描述**：从branch-exact source构造automatic或ManualStop proposal binding；ManualStop在planned unavailable且没有target/semantic/prepared digests时仍完全可构造。
- **调用关系**：callers: M5、F24、M4 type-8 rebuild；callees: F22、F12、F17、F23、source/control equality validators、F4；不调用M2/M4/store。
- **Requires**：两branch的snapshot均transaction-consistent，admission candidate/context与source candidate匹配且来源分离；snapshot tools已按§4.4.5完整收集并分类。automatic要求planned available、`dispatchKind:"automatic-recovery"`与action匹配：SafeRetry要求`truly-empty`，Continue要求`authoritative-only`且每项final-after-hook-settled并与closure payload/commitment/sourceBinding exact。manual要求显式candidate/action、lower-level causes、caller-observed planning evidence/closure status，以及M4已调用M2 owner validator后投影的no-handle或mechanically-cancelled `handleClosure`；不要求planned available，且compatibility-only/mixed/intermediate phase必须走此branch。
- **Ensures**：automatic输出保留全部available binding members；manual输出只含source/control、candidate/action、canonical ordered causes/reasons、planning evidence、closure status、policy quartet/admission、heads/control policy与handle closure，且recursive exact spec使target/targetDigest/semanticDigest/preparedDigest/authorization/closureDigest不可表示。两branch均不含decision/revision/operationID/timestamp/public projection。
- **Invariants**：函数纯，不回写任何输入；current config只能通过admission frozen policy进入；manual handle commitment只是M2 live proof验证结果的canonical projection，不是proof capability或persistence。
- **共同步骤 / intermediate facts**：B1验证source/control versions及digest与snapshot exact，得到I1；B2验证candidate/session/source/action关系，得到I2；B3重算N/M booleans并与AdmissionPlan一致，逐项验证`scopeKey/epoch/policyDigest/defaultSemanticsVersion`、policy digest input、session scope及`controlPolicyDigest`，从policy只复制`digestInput`且排除provenance，得到I3；B4复制expected heads/control policy。
- **automatic branch**：B5A要求planned available、context/action/`dispatchKind` exact；按action验证tool partition：safe-retry双向要求`truly-empty`且closure not-needed，continue双向要求`authoritative-only`、全部final-after-hook-settled，并逐项比较closure sourceBinding/call order/arguments/result-or-error/reasoning/prefix carriers及owner commitments；验证target-domain、target/semantic/prepared digests、authorization/closure并要求N/M true；B6A构造`kind:"automatic"` fresh object，F4/forbidden scanner后返回。
- **manual-stop branch**：B5M把valid raw causes去`detail`，保留branch-applicable stable subject；若input causes为空或F23判为runtime invalid，则canonical causes与reasons同时固定为`internal/classifier-invariant-violated`及`internal-classification-failure` singleton；否则按F23 mapped reason rank、同rank F17 canonical bytes排序并dedup，调用F23得到reasons并与source reasons exact equal；B6M验证`planningEvidence.action/materialization`与实际planned status/cause一致，但不读取available target或digests；验证`closureStatus.action`与cause relation；B7M switch handleClosure：no-handle要求same candidate且planning未留下lease，cancelled要求same candidate、paused commitment存在、released=false、sendClosureReachable=false；这里只比较M2-validated projection，不验证live registry；B8M允许N或M false并要求对应admission cause存在，构造`kind:"manual-stop"` fresh object，F4/forbidden scanner显式拒绝automatic-only material后返回。
- **分支/退出**：automatic/manual两branch完整；任一source/policy/context/action/cause/reason/planning/closure/handle mismatch→`recovery-binding-stale`或更早typed error；automatic budget false失败；manual budget false可构造且必须有对应cause；planned unavailable只允许manual branch并且不得补造target/digests。
- **callee引用**：F12/F22及version validators的post；F13 policy不变量；F23 total post保证stable nonempty reasons且unexpected runtime只得到internal reason；F4 recursive union spec保证branch forbidden fields不可出现。
- **正确性论证**：I1–I3冻结共同source/policy authority；automatic分支继续绑定全部available request material。manual分支由canonical cause/reason、planning/closure状态与handle closure替代不可得的request material，并由closed spec排除target/digest发明；因此两branch都可独立重算，且任一tail/policy/classification/transport-closure变化都会改变或使binding失配。

#### 5.3.5 F21 `digestCanonicalCommitment(spec, input) -> OutputOf<typeof spec>`

- **功能描述**：为§4.1.3 closed registry中的全部25个domain计算versioned SHA-256 envelope并施加非可替换brand；semantic/prepared/binding仍是其中三项。
- **调用关系**：callers: E1/F5–F7/F13/F18–F20、M2/M4/M5/M7；callees: F17（exact canonical bytes）、SHA-256 primitive、hex encoder、spec.brandDigest。
- **Requires**：spec object identity来自frozen registry；input来自同spec `buildInput`成功post；credential/sealed/paused的raw secret不走本函数，sealed/paused input只含keyed builder产生的非secret描述。
- **Ensures**：返回`version:1/algorithm:"sha256"/encoding:"recovery-canonical-json"/64-lowerhex`及spec-specific brand；相同spec+input相同digest，不同domain不能在typed API替换。
- **Invariants**：完整SHA-256 32 bytes，不截断；brand只在digest成功与F4 envelope复检后施加。
- **副作用**：只调用纯crypto primitive、分配bytes/string；无外部状态写入，穷尽。
- **实现步骤 / intermediate facts**：identity lookup得到I1 closed spec；调用spec.buildInput并要求与传入typed input canonical equal得到I2 exact membership；F17 post得到I3 domain-separated bytes；SHA-256并检查32 bytes得到I4 full digest；hex+F4得到I5 valid envelope；最后调用registry-owned brandDigest得到I6 non-substitutable output并返回。
- **分支/退出**：25个registry spec走同一算法；unknown/forged spec、builder mismatch、canonical/crypto/length失败均typed failure且无brand输出。
- **callee引用**：F17 Requires/Ensures见§5.3.1；SHA primitive pre=bytes、post=32-byte digest或typed exception；brandDigest pre=validated envelope、post=仅对应Output brand。
- **正确性论证**：I1–I3建立closed domain+exact canonical input，I4–I5建立正确完整digest envelope，I6建立type non-substitutability，故满足Ensures。
- **副作用论证**：所有callee post均无外部写入，只有local allocation，故副作用列表穷尽。

#### 5.3.6 F22 `verifyDigest(expected, spec, input)`（generic `I/O/E`精确声明见§5.0.1）

- **功能描述**：按同一closed spec重算并constant-time比较branded commitment。
- **调用关系**：callers: F5/F18–F20/F26/F27、M2/M4/M5/M6；callees: F4、F21、constant-time bytes equality。
- **Requires**：expected来自typed decode但尚未信任；spec来自registry；input为对应builder output。
- **Ensures**：成功iffmetadata、spec brand/domain与digest value exact match；失败无boolean/partial brand供caller忽略。
- **Invariants**：unknown version/algorithm/encoding、wrong brand/domain失败。
- **副作用**：无。
- **实现步骤 / intermediate facts**：F4验证envelope得I1；registry brand validator确认expected属于spec得I2；F21重算得I3；hex decode并constant-time compare得I4 equality；成功void。
- **分支/退出**：metadata/brand/recompute/value mismatch分别typed failure；仅I1–I4全真成功。
- **callee引用**：F21 post见上；constant-time equality pre为等长bytes、post为不按content early-return的equality result。
- **正确性论证**：I1∧I2阻止跨version/domain substitution，I3∧I4证明value来自exact input，故成功恰等于Ensures。
- **副作用论证**：全部callee纯计算，不写外部状态，副作用为空且穷尽。

#### 5.3.7 F23 `mapCausesToManualStopReasons(causes) -> NonEmptyReadonlyArray<ManualStopReason>`

- **功能描述**：把§4.8.5 lower-level source-specific causes穷尽映射为24项stable reasons；caller不能传reason或`code`。
- **调用关系**：callers: M5 classifier、M6 finalization；callees: F4 exact cause validator、closed cause→reason registry与total `unexpectedCauseToInternal(cause:never)` helper；无throwing callee。
- **Requires**：正常路径causes来自typed fact producers且元素没有`code/reason`extra字段；为保持runtime totality，函数也接受空、malformed或unsafe-cast future discriminator并稳定降级为internal reason。
- **Ensures**：总是返回`ok:true`；value非空、按`ManualStopReasons`tuple顺序、dedup；detail/callID/operationID不影响reason identity。空、F4 validation failure或unexpected runtime discriminator的唯一value为`["internal-classification-failure"]`。
- **Invariants**：24个`source+kind` pair与24 reasons一一映射；新增typed variant未更新switch时`const exhaustive:never = cause`编译失败；runtime unexpected不是已知cause，不throw且不信任其字段。
- **副作用**：无。
- **实现步骤 / intermediate facts**：B1若causes为空，直接返回frozen internal singleton；B2对有限causes逐项F4 exact，任一失败直接返回同一singleton，得到I1 typed lower-level cause；B3对`source`外层switch、`kind`内层switch执行24个显式leaf，每个switch的fallback先执行`const exhaustive:never = cause`形成compile-time exhaustiveness，再把`exhaustive`传给total `unexpectedCauseToInternal`并立即返回internal singleton，合法leaf得到I2唯一reason；B4加入Set得到I3 dedup；B5按固定24 tuple filter得到I4 stable order；B6若理论上结果空则返回internal singleton，否则freeze返回。
- **分支/退出**：24个leaf、empty、malformed、unexpected runtime discriminator完整覆盖；全部是`ok:true` success result，无`ok:false`、throw、assertion exception或读取`cause.code`/caller reason的路径。
- **循环**：第一循环每轮消费一个有限cause；第二循环固定24项；均单调终止，不变量分别为“已处理合法cause均有唯一mapped reason”与“输出为tuple已扫描前缀和Set交集”。
- **callee引用**：F4 post确保selected union branch exact；registry post为每个pair唯一reason；`unexpectedCauseToInternal`对静态`never`与任意runtime payload都total返回固定literal，不抛异常。
- **正确性论证**：合法输入时I1排除caller-preselected reason，I2保证exhaustive mapping，I3去重，I4稳定排序；异常输入在使用任何未验证字段前进入唯一internal singleton。因此所有runtime输入都满足nonempty/stable post且exact error union保持`never`。
- **副作用论证**：只分配Set/array并freeze，无日志/持久化/publication，副作用为空且穷尽。

### 5.4 Proposal/receipt validation 与 public projection

#### 5.4.1 F24 `validateRecoveryProposal(proposal, inputs) -> proposal`

- **功能描述**：验证proposal仍是无authority pure结果，且automatic/manual字段与各自binding source闭合；ManualStop binding mandatory且无需available request material。
- **调用关系**：callers: M5 return boundary、M6、M4 type-8 preparation；callees: F4、F20、F22、F23。
- **Requires**：`inputs.kind`与proposal kind匹配，并为生成proposal时的branch-exact source引用。automatic inputs含snapshot/available planned/admission；manual inputs含snapshot/candidate/action/causes/reasons/planning evidence/closure status/admission/handle closure，可能没有任何target或digest。
- **Ensures**：automatic action及available binding匹配，并且SafeRetry/Continue分别只对应`truly-empty`/`authoritative-only+all-final-after-hook-settled` tool partition；compatibility-only/mixed/intermediate/reconciled不得通过automatic branch。manual action/reasons和manual binding逐项匹配，binding input不含automatic-only material；proposal不含durable identity/receipt字段。
- **Invariants**：validator不分配decision/revision，不调用M2 proof validator或任何store；handleClosure只与已验证projection比较。
- **副作用**：无。
- **实现步骤**：B1 F4 exact；B2 switch proposal kind并要求inputs kind一致；B3A automatic调用F20重建automatic input并F22验证binding；B3M先调用F23对input causes得到canonical reasons并与proposal/input reasons相等，再调用F20重建manual input并F22验证binding，显式扫描并拒绝target/targetDigest/semanticDigest/preparedDigest/authorization/closureDigest；B4扫描forbidden authority identity fields；B5返回。
- **分支/退出**：automatic两action、manual两candidate action及planned available/unavailable、no-handle/cancelled完整覆盖；kind/action/binding/reason/planning/closure/handle/extra mismatch失败。
- **callee引用**：F20/F22保证对应branch binding；F23 total保证reasons，unexpected runtime只产生internal singleton而不throw。
- **正确性论证**：closed proposal/input双union和重算验证使proposal无法与其它plan拼接；manual不从available branch取材且forbidden scan阻止发明digests；禁止durable identity保持proposal-only。

#### 5.4.2 F25 `validateRecoveryDecisionRecord(record) -> record`

- **功能描述**：验证durable record lifecycle组合，不验证数据库 predecessor。
- **调用关系**：callers: M4 projector/rebuilder、snapshot decoder；callees: F4、F22格式、F23。
- **Requires**：record来自known operation payload。
- **Ensures**：automatic只能consumed+child+automatic binding；manual finalized+reasons+manual binding；superseded唯一reason+`SupersessionBindingDigest`且没有`bindingDigest`；revision safe。
- **Invariants**：createdAt不进入任一binding；supersession与automatic/manual commitment brands不可替换。
- **副作用**：无。
- **实现步骤**：exact decode；验证IDs/revision/digests；switch status/action组合；manual规范reason，并在caller提供type-8 material时要求binding input discriminator=`manual-stop`、F22重算digest且action/reasons exact；automatic要求child/`bindingDigest`且无reasons；superseded要求固定reason、`supersessionBindingDigest`且无`bindingDigest`，在type-10 caller中从persisted input重算；返回。
- **分支/退出**：所有合法组合及非法组合失败。
- **callee引用**：F23 reasons；digest schema validator。
- **正确性论证**：状态×action矩阵显式封闭，排除active-without-child和automatic finalized等架构禁止状态。

#### 5.4.3 F26 `validateDispatchReceipt(receipt, operationPostState, pausedHandleCommitment) -> ContractResult<DispatchReceiptV1>`

- **功能描述**：验证available/opaque initial/ordinary admission或subsequent dispatch receipt；authority对照是M4从dedicated recovery aggregate genesis连续fold到receipt所指raw operation的stored `aggregateSequence`得到的exact operation post-state，不是pre-commit evidence或current head。
- **调用关系**：callers: M2 authorize/cancel boundary；callees: F4、F5 post、F22、F12、M1 H2 `foldOperationPostStateThroughSequence` exact post。
- **Requires**：`operationPostState`为对应type 1/2/3的`OperationPostStateForV1<T>`，由M4对known committed raw prefix `0..receipt.operation.aggregateSequence`构造；M4已另行完成owner mapping检查；runtime handle仍paused并已得到同一个branded commitment。
- **Ensures**：成功receipt与raw operation、operation type、historical policy quartet与M admission（若assistant admission）、committed identities、relevant operation post heads、available target/prepared或opaque cause、paused handle逐项exact；可授权且仅授权该handle。
- **Invariants**：candidate/transaction-local derived value不能通过；opaque不能声称target/digest/proof；validator不repair/fill fields；`applyMode`不在receipt或operationPostState中。
- **副作用**：只读operation post-state并计算/比较；不release/cancel handle，不写DB，穷尽。
- **实现步骤 / intermediate facts**：
  1. F4 exact decode receipt与operation-post-state union，得到I1 closed V1 variants。
  2. 按receiptKind分assistant-admission/subsequent；验证operation type映射1/2/3、F5-validated raw operation fields/payloadDigest/event nextDigest全部equal，且fold边界精确等于stored aggregateSequence，得到I2 raw proof。
  3. assistant branch验证`scopeKey/epoch/policyDigest/defaultSemanticsVersion/controlPolicyDigest`、effective M/count-before/candidate sequence/`mAvailable:true`，并比较committed assistant/dispatch及assistant/dispatch/aggregate operation post heads，得到I3 admission authority；subsequent branch验证无assistant admission字段并比较dispatch与dispatch/aggregate operation post heads，得到I3'。
  4. 按evidenceKind分available/opaque：available验证`preparedDispatchKind`与operation/admission/context origin、target+targetDigest、F12 domain、prepared digest及folded available evidence；opaque验证cause/context且F4已排除target/digest/proof，得到I4。
  5. constant-time比较paused handle commitment，得到I5；I2∧(I3∨I3')∧I4∧I5后返回。
- **分支/退出**：2 receipt kinds × 2 evidence kinds全部覆盖；cross-kind、candidate/derived、missing raw op、different payload、historical policy mismatch、M false、partial operation post-state/head/handle mismatch均typed failure。
- **callee引用**：F5 post证明raw envelope/digests；F22 post证明branded commitment input；F12 post证明target-domain；M1 H2 pre=F5 prefix/post=目标stored sequence的raw-derived exact state。M1 H3 `validateCurrentRecoveryAggregatePrefixAndHeads`合同验证目标sequence之后直到current head的gap/corruption与current full-fold heads；F26不替代该检查，也不把current heads拿来对比历史operation receipt。
- **正确性论证**：I1封闭schema，I2绑定目标raw commit及其历史sequence，I3/I3'绑定该sequence的operation post-state，I4保持available/opaque限制，I5绑定linear handle；与独立current full-prefix/head检查分工后，不会把历史receipt误判为必须等于未来current head。
- **副作用论证**：所有callee为read-only validation/fold result consumer；F26没有handle method或storage接口，故副作用列表穷尽。

#### 5.4.4 F27 `validateRecoveryAdmissionReceipt(receipt, proposal, planned, operationPostState) -> ContractResult<AutomaticRecoveryAdmissionReceiptV1>`

- **功能描述**：验证automatic composite receipt对应同一binding、historical policy quartet、N/M admission、committed child、available dispatch、decision/consumption与目标operation sequence的three-head post-state。
- **调用关系**：callers: M6→M2 release、commit-response-loss recovery；callees: F4、F5 post、F22、F25、M1 H2 `foldOperationPostStateThroughSequence`。
- **Requires**：proposal automatic；planned runtime wrapper是exact `{descriptor:available,pausedHandle}`且candidate/handle未release，F27只读取/验证`planned.descriptor`与外部paused-handle commitment，不枚举、encode或触碰raw `pausedHandle`；`operationPostState`为M4从dedicated recovery aggregate genesis连续fold到type9 raw operation stored `aggregateSequence`得到的`FoldedAutomaticRecoveryPostStateV1`；owner mapping已验证。
- **Ensures**：成功receipt只授权exact single handle；raw operation、binding、source/control version digests和allowed-set versions、`scopeKey/epoch/policyDigest/defaultSemanticsVersion`、N/M、record/consumption/child/dispatch及该sequence的recovery/assistant/dispatch/aggregate heads全部exact。
- **Invariants**：transaction-local derived identity不能证明authority；只有committed operation post-state/read-back可证明candidate对应committed identity；validator不derive/brand、不repair，`applyMode`不可见。
- **副作用**：纯验证；不release/cancel、持久化或publish，穷尽。
- **实现步骤 / intermediate facts**：F4 exact得I1；验证operation type9及F5 raw proof/payloadDigest/nextDigest、fold边界=stored aggregateSequence得I2；F22重建proposal binding并要求child/receipt/folded evidence的`preparedDispatchKind="automatic-recovery"`，比较`planned.descriptor`的action/target/targetDigest/prepared/paused-handle descriptor commitment得I3；验证source/control registry versions、allowed-set digests与versionDigests得I4；比较operation/admission/receipt中的policy quartet并F22复验policy/control-policy digests得I5；F25验证consumed record并比较decision/consumption/committed child+dispatch得I6；按stored historical policy重算N/M且要求true，逐一比较该sequence的recovery/assistant/dispatch/aggregate post heads得I7；I1–I7全真返回。
- **分支/退出**：missing/different operation、binding stale、registry mismatch、historical policy mismatch、budget false、candidate/derived未跨commit authority boundary、partial operation post-state、任一目标sequence head/handle mismatch失败；没有从partial state合成receipt路径。
- **callee引用**：F5 post=known exact raw operation；F22 post=exact branded digest；F25 post=record lifecycle；M1 H2 post=目标stored sequence的raw-derived exact state。M4必须另调用M1 H3 `validateCurrentRecoveryAggregatePrefixAndHeads`检查该sequence之后直到current head的chain corruption/gap与current heads；F27不要求历史receipt heads等于未来current heads。
- **正确性论证**：I2绑定single raw commit及其历史sequence，I3/I4绑定proposal与frozen facts，I5绑定historical admission policy，I6/I7绑定该operation的authority post-state；独立current full-prefix/head检查负责后续腐败，因此response-loss只能重获原receipt，不能制造新authority或被later policy/head变化错误否定。
- **副作用论证**：所有步骤仅比较输入或调用pure validator；无外部写接口，副作用为空且穷尽。

#### 5.4.5 F28 `projectRecoveryForPublic(authorityView)`

```ts
export function projectRecoveryForPublic(
  authorityView:RecoveryPublicAuthorityViewV1,
):ContractResult<RecoveryPublicProjectionV1|undefined,PublicProjectionViolation>
```

- **功能描述**：在M4 projector/rebuilder内部从raw-folded authority用正向allowlist构造display-only projection。
- **调用关系**：**唯一caller: M4 projector/rebuilder**；M8不是caller且不能获得`authorityView`。callees精确为F4、F29，二者pre/post分别是“V1 exact spec→无extra/missing”与“public candidate→无forbidden shape”。
- **Requires**：authorityView由M4对F5 known raw operations重建；public child branch必须携committed identity与M4 transaction/rebuilder已验证、stable、session-scoped `RecoveryChildDisplayID`；hidden branch不得携display ID。F28无allocator/lookup capability。
- **Ensures**：`ok:true`只含§4.7.4字段；unknown omit/enum unknown；无authority字段；无信息时value为`undefined`；child ID是validated non-authority brand。`ok:false`只含`PublicProjectionViolation`且无partial projection。
- **Invariants**：不读取raw secret/tool/reasoning metadata；projection不回写raw authority；M8永不处于本函数调用链上游。
- **副作用/残留**：严格无副作用、无ID分配、无mapping查表、无DB/cache/log/publication写入、无durable residue。display mapping allocation/reuse只属于M4 transaction/rebuilder。
- **编号连续步骤 / intermediate facts**：1) F4验证authority view closed source shape，得I1；2) 新建空candidate且禁止object spread，得I2；3) dispatch/source/outcome逐个closed switch，得I3 safe scalars；4) child absent/hidden时omit，public时验证committed+display brand，得I4；5) 若candidate无字段，返回`ok:true,value:undefined`；6) 否则加入version1，F4 exact得I5；7) F29得I6 safe；8) freeze并返回`ok:true`。
- **编号分支/退出**：E1 source malformed→`ok:false`；E2 enum impossible/display invalid→`ok:false`；E3 no public facts→`ok:true(undefined)`；E4 nonempty safe→`ok:true(V1)`。四类互斥且完备，无throw/partial success。
- **进度/终止**：固定四个optional members与一次有限F29递归；递归严格进入projection子值，有限acyclic input保证终止。
- **§4.3.2正确性论证**：前置给出raw-folded、mapping-already-validated source；I1排除source shape伪造，I2排除authority spread，I3/I4只建立allowlisted display facts，I5/I6证明V1 exact且无forbidden shape；I1∧…∧I6推出Ensures。callee均pure且签名无store/allocator，因此副作用/残留为空且穷尽。

#### 5.4.6 F29 `assertPublicRecoveryProjectionSafe(value) -> void`

- **功能描述**：对**已经是public候选**的projection递归执行allowlist与forbidden-shape assertion；不接收authority view。
- **调用关系**：callers: F28、F30、M8 publication/decoding boundary；callees: F4、RecoveryChildDisplayID validator、forbidden-shape registry。
- **Requires**：F28 caller传fresh public object；M8 caller只能传public wire/decoded projection，绝不能传snapshot/record/receipt/internal event。
- **Ensures**：成功时V1 exact且不存在target/authority/digest/proof/operation/decision/revision/CAS/head/receipt/sealed/ledger ordinal/tool/reasoning metadata；child display ID仅满足non-authority codec。
- **Invariants**：assertion不拥有/查询display mapping，不把displayID转authority。
- **副作用**：无。
- **实现步骤 / intermediate facts**：F4 V1 exact得I1；validate display ID syntax得I2；递归key/value shape scan得I3；I1–I3后void。
- **分支/退出**：known V1成功；unknown version/extra/forbidden/unsafe display ID失败。
- **递归**：有限acyclic JSON严格子节点下降；终止。callee pre/post：F4 exact、display validator仅brand syntax、shape predicates pure closed。
- **正确性论证**：I1阻止未声明字段，I2维持non-authority child，I3阻止危险shape伪装；满足Ensures。
- **副作用论证**：所有callee pure且无mapping lookup，副作用为空且穷尽。

#### 5.4.7 F30 `decodeRecoveryPublicProjection(value)`

```ts
export type RecoveryPublicProjectionDecodeResult =
  | { status:"known"; value:RecoveryPublicProjectionV1 }
  | { status:"unsupported"; observedVersion:SafePositiveInt }
  | { status:"malformed"; error:PublicProjectionViolation }
export function decodeRecoveryPublicProjection(
  value:unknown,
):ContractResult<RecoveryPublicProjectionDecodeResult,never>
```

- **功能描述**：M8/clients只解码并assert already-safe public projection，明确区分known、unsupported version与malformed/unsafe。
- **调用关系**：callers: HTTP/SDK/CLI/TUI hydration consumers（含M8）；callees: safe-positive-int parser、public enum normalizer、F4/F29。
- **Requires**：value来自public wire optional field；没有internal authority object。
- **Ensures**：总是返回`ok:true`并包裹三个status之一（故exact error union为`never`）；known包含safe V1且unknown enum→`unknown`；unsupported不解释其它字段；malformed携typed violation；任何结果都不产生authority。
- **Invariants**：unsupported≠malformed；函数不throw、不返回`ok:false`或裸undefined。
- **副作用**：无。
- **实现步骤 / intermediate facts**：非plain object或missing/non-safe-positive version→malformed(I1)；version≠1→unsupported且不访问其它字段(I2)；version=1时先把evidence/outcome未知string归一unknown得到I3，再F4 exact和F29 safe assertion，成功得I4 known，否则malformed；返回对应union。
- **分支/退出**：malformed version、unsupported positive version、V1 known/unknown enum、V1 extra/unsafe完整覆盖。
- **callee引用**：integer parser post为brand或typed error；enum normalizer post为known literal/unknown；F29 post为safe public-only shape。
- **正确性论证**：I1/I2分离结构状态；I3只做display enum forward normalization；I4保证known safe；三branch互斥且完备，推出Ensures。
- **副作用论证**：只解析/分配返回值，不访问M4 mapping或任何store，副作用为空且穷尽。

### 5.5 Internal/public manifest assembly

#### 5.5.1 F31 `assembleEventManifests(allDefinitions) -> EventManifestSet`

- **功能描述**：生成exact `PublicEventManifestV1`、`PublicDurableEventManifestV1`、internal runtime recovery definition map与trusted private all-durable replay registry；不计算canonical digest。
- **调用关系**：callers: schema manifest modules、core public manifest、trusted M4 replay registry；callees: F2、schema-owned F3 raw definition set、`Event.latest`、`Event.durable`、public/private brand constructors。明确不调用E1/F17/F21。
- **Requires**：allDefinitions含与F3 `RecoveryEventDefinitionSetV1.definitions` identity/order一致的10个recovery definitions及现有definitions；现有未标publication的definitions经F1 default为public；brand constructors只接受F1 definition与F2分区事实。
- **Ensures**：`result.publicDefinitions/publicLatest/publicServer`与`result.publicDurable.definitions`只含`publication:"public"` branded definitions；`result.durableReplay.definitions`的nominal type是`TrustedPrivateDurableReplayManifestV1`，精确含allDefinitions中全部durable definitions，允许internal但不导出public barrel；`result.internalRuntime`精确含raw set的10个definitions且无allowed-set digest依赖。public manifest/listener/subscription/cursor/read-error/service type中不存在internal recovery variant。既有generic public EventTable definition/writer继续使用自身aggregate selector/schema，不被F3要求迁移为`RecoveryOperationEnvelope`或增加recovery chain字段；只有recovery/sealed aggregate definitions进入mandatory authority-chain assertion。
- **Invariants**：public surface只由`publication:"public"` metadata和F2 proof构造brand，不由type prefix猜测；trusted private set与public durable set不可互相赋值；manifest assembly对E1 enriched registry零依赖。
- **副作用**：schema模块初始化frozen arrays/maps/codecs；无hash、event publication或DB读写。
- **实现步骤**：1) F2分区；2) 仅对public partition逐项检查literal publication并brand为`PublicEventDefinitionV1`；3) 从该public branded array构造Latest/Server，并只过滤其中durable项、验证selector/version后brand为`PublicDurableEventDefinitionV1`并构造public durable codec；4) 从allDefinitions过滤全部durable项、保留其public/internal literal并brand为`TrustedPrivateDurableReplayDefinitionV1`，以versioned key构造private replay map；5) 按definition identity/order从internal partition exact匹配F3 raw set的10项构造`internalRuntime`；6) 断言每个internal key不在public maps/public codecs，每个public durable key也存在private set，raw 10项只存在于internal/private对应集合；7) freeze并返回exact `EventManifestSet`。
- **分支/退出**：duplicate latest/versioned key、unknown publication、brand precondition failure、internal public leak、missing private durable、private/public set equality误用、public codec可decode internal任一情况均初始化失败且不返回partial set。
- **循环**：有限registry cross-check，终止。
- **callee引用**：F2分区post保证互斥完备；`Event.latest`只接收public branded definitions；`Event.durable`分别对public-only与trusted-all输入构造不同map，返回值必须立即包入对应nominal type，禁止共享unbranded alias。
- **正确性论证**：public outputs的唯一constructor输入是F2 public partition且brand recheck literal publication，故internal在source type上不可表示；private replay对all durable闭包保证M4可读internal authority，同时nominally不能进入public service。步骤6再验证set关系和codec domain，因此“trusted durable readability”与“public publishability”被机械分离。

## 6. 跨模块接口与 callee 合同索引

本表只列直接consumer。initial/ordinary固定为existing ordinary converter → M2 → M4；automatic固定为M5 candidate selection → M7 lowering → M2 single preparation/original inspection → `M7.validatePreparedRecoveryInspection({ candidate, inspection })` → M5 final classification → M4 complete result → M2 authorize/cancel；M8只消费safe projection。尤其：M5 proposal永远无authority；M6必须以M4完整`OperationCommitResultV1<T>`驱动M2 authorization；M8只可接收M4已经由pure F28构造并经F29验证的safe projection，再以F30/F29 decode/assert；M8不调用F28。

| M1 输出 | Caller | Caller必须满足 | M1保证 | 后续不得做 |
|---|---|---|---|---|
| identity/context codecs | M2/M4/M6 | candidate/committed brand显式 | sequence/ordinal/genesis可机械验证；derive值transaction-local，commit/read-back后仅M4可brand | cast或普通string拼接绕过codec |
| target/domain/storage | M2/M5/M7 | final transform后 introspection | exact normalization、unknown不猜测 | display/prefix/current config补证 |
| available/opaque evidence | M2/M4/M5 | provider hit=0、handle commitment已生成 | opaque无proof，available字段完整 | 从opaque升级available |
| tool partition/phase/replay payload | M3/M4/M5/M7 | 同一snapshot收集全部authoritative+compatibility facts；payload inline或exact sealed ref；phase literal durable | four-way partition total/disjoint；SafeRetry仅truly-empty，Continue仅authoritative-only/all-final；arguments/result/error可重建且commitment可重算 | 省略compatibility、digest反推payload、重跑uncertain body/after-hook、M1自造M4 nominal proof |
| provenance | M3/M4/M7 | durable source facts与reasoning content carrier | missing/forced/unknown保留；provider-end Continue content可重建并commit | metadata presence当provider-end或只存text digest |
| raw event definition set / enriched registry | schema manifests/F31；LLM E1；M4/F5–F7 | schema consumers只用F3 raw definitions；E1只接收exact frozen `RecoveryEventDefinitionSetV1`；M4 decode使用enriched registry | raw set固定10 definitions/specs/7+3 tuples且无digest；enriched registry只附existing source/control digest brands，membership/order不变 | schema import LLM、manifest依赖digest、caller lookalike set、第二canonicalizer或generic domain builder |
| source/control decode | M4/M6 | raw sequence exact；sealed payload material显式验证 | unknown/gap/extra/payload loss fail closed | public projection/current history补字段或内容 |
| sealed-use lease key | M4/M2/M7 | 使用M1 exact structural input；M4拥有generation与nominal lease | ref/scope/purpose/material/handle/source/action/operation/session identity不可拆分 | M1持有lease registry/proof brand或把raw secret/handle写入key |
| planned/admission/proposal | M2/M5/M6 | 来源分离；runtime available为`{descriptor,pausedHandle}`；manual提供canonical causes/planning/closure/handle-close evidence | PreparedDigest dispatch-kind branch exact；automatic/manual binding membership固定且manual不需available material；closure绑定snapshot payload carriers | 把pausedHandle塞入descriptor、proposal当authority、给manual虚构target/digests或从digest/history重建ModelMessage |
| commit results / receipts | M4/M6/M2 | authorization caller持完整`OperationCommitResultV1<T>`；M4 fold到stored aggregateSequence的operation post-state exact，current full-prefix/head另验；response-loss lookup使用`RecoveryOperationLookupKeyV1` | result同时携operation/applyMode/post-state/receipt；raw/historical policy/operation post-state heads/N/M/handle/request/context匹配可验证；lookup identity aggregate-scoped | detached receipt只观察，不得用operationID-only lookup、pre-commit evidence、current head或partial state授权 |
| public projection | M4→public wire→M8 | M4独占authority/F28，M8只F30/F29 | allowlist、safe display ID且无authority | M8调用F28或读取internal event |
| public event carriers/service/manifests | public writer/listen/all/typed durable/bridge/sync/SSE/SDK | 只接受F2/F31产生的`PublicEventDefinitionV1`/`PublicCommittedEventV1`/public cursor及public durable manifest | public brand仅承诺`publication:"public"`；coarse read errors不含authority | cast internal definition/payload；把trusted private replay manifest传public surface；公开`session.recovery.*` |
| trusted private durable replay | M4 rebuilder/sealed migration | 只从F31 private all-durable set按versioned key读取 | public+internal durable exact闭包且不产生public brand | 接入public listener/subscription/manifest/OpenAPI或把private payload当public event |
| N/M policy | config/M6 | raw config未clamp | defaults N2/M64、safe integer、effective min | 把N/M当physical request budget |

## 7. 测试映射

M1-T01 foundation与M1-T03/T04/T04a的F1/F2 subset已有partial evidence；其它行仍为future owner并保持`[F — planned; not created; not run]`。`[P — partial implementation evidence]`只表示明确列出的子集已创建并运行，不表示完整test ID、F3/F31、recovery event set、public/private runtime closure或Step 5通过。

| Test ID | 未来 owner / 建议路径 | 覆盖函数/合同 | fixture / 输入 | 通过判据 | 状态 |
|---|---|---|---|---|---|
| M1-T01 | foundation：`packages/schema/test/recovery-contract-foundation.test.ts` + `.types.ts`；其余§4 codec tests仍待创建 | 当前仅§3.1/§4.1 scalar、ID、unbranded digest/domain与type-only commitment brands | safe integer/ID/digest/domain合法与非法边界、FastCheck、compile-time cross-brand fixtures | foundation `8/8`（207 assertions）；当前schema typecheck与non-manifest regression `29/29`通过；完整schema suite既有manifest 2 failures在clean D0/M1-A同样复现；剩余§4未覆盖 | [P — partial foundation evidence; remaining planned] |
| M1-T02 | 同上 | F4 | missing/extra/null/wrong discriminator/nested extra | 每个path typed failure；输入不被strip | [F — planned; not created; not run] |
| M1-T03 | F1/F2 subset：`packages/schema/test/event.test.ts` + `event.types.ts`；F3/F31 future：`recovery-event-manifest.test.ts` | F1–F3/F31 | 已覆盖exact define result、publication metadata/default、partition order/identity/disjointness/duplicates/hostile inputs；raw 10-definition set仍future | F1/F2 subset schema focused `19/19`（267 assertions）与typecheck通过；10/7+3 recovery set、internal recovery definitions、F31 manifests/OpenAPI zero-leakage仍未创建 | [P — F1/F2 subset evidence; F3/F31 remaining planned] |
| M1-T04 | F1/F2 compatibility subset：`packages/core/test/event.test.ts` + `session-history.test.ts`；F31/M4 private replay future | public definition metadata vs existing publish/replay payload；trusted private replay仍future | public definition与现有EventV2 publish/replay fixture；private replay fixture仍future | core focused `50/50`（93 assertions）与typecheck通过；publication不进入published payload；internal raw/private manifest/public service zero-notification closure仍未创建 | [P — compatibility subset evidence; private/public runtime closure planned] |
| M1-T04a | F2 definition-brand subset：`packages/schema/test/event.types.ts`；full F31 carriers future：`recovery-public-event-types.test-d.ts` | §4.5.1a/F2/F31 nominal closure | 已覆盖raw/internal definition不能替代`PublicEventDefinitionV1`、F2 public output可用、publication不进入Data/Payload/Encoded；committed event/cursor/service/private manifest仍future | schema typecheck通过；仅definition-level nominal boundary有证据 | [P — F2 definition-brand subset; F31 carrier closure planned] |
| M1-T04b | `packages/core/test/recovery-snapshot.test.ts`（M4协作） | `RecoveryAssistantPublicMappingV1` | same-WAL mapping、absent、duplicate、wrong-role、source high-water/digest/control-tail/latest-decision revision变化 | same snapshot mapping可lookup；其余分别closed absent/ambiguous/wrong-role/stale，不cast internal ID、不使用display ID/history猜测 | [F — planned; not created; not run] |
| M1-T05 | `packages/llm/test/recovery-canonical.test.ts` | F17 | 不同object insertion order、nested maps | canonical bytes/digest相等 | [F — planned; not created; not run] |
| M1-T06 | 同上 | F17/F21 | array order、absent/null、scalar、domain/kind变化 | 每个声明语义变化改变digest；kind跨域不相等 | [F — planned; not created; not run] |
| M1-T07 | 同上 | F17 | cycle、Date/Map/Set/Uint8Array、undefined、unsafe/nonfinite、lone surrogate | 全部typed `RecoveryContractError` with `kind:"canonicalization"`，无fallback JSON.stringify | [F — planned; not created; not run] |
| M1-T08 | 同上 | F18 | decision/child/lineage/operationID/timestamp变化 | SemanticDigest保持相等 | [F — planned; not created; not run] |
| M1-T09 | 同上 | F18 | target/tool/options/system/history/body变化 | SemanticDigest逐项变化 | [F — planned; not created; not run] |
| M1-T10 | 同上 | F19 | initial/ordinary/automatic三dispatchKind；final target/authority/storage/tools/options/system/history/body、fence/capability/auth/handle变化；recovery source/action/closure仅在automatic变化；branch extra/missing与sealed lookup proof mismatch | 单一PreparedDigest brand下三branch逐项敏感；initial/ordinary不含RecoverySourceVersion/closure且添加即拒绝；automatic缺source/action/closure拒绝；context origin/authorization action/lookup proof不一致拒绝 | [F — planned; not created; not run] |
| M1-T11 | 同上 | F20/F24/type-8 receipt | automatic source/control/candidate/action/target/digests/N/M/heads变化；manual planned unavailable无target/digests、ordered causes/reasons、planning evidence、closure status、policy quartet、no-handle/cancelled commitment变化；尝试注入automatic-only fields | 两binding branch均可构造且逐项敏感；manual在零target/semantic/prepared digest下通过并mandatory binding；注入/发明available material拒绝；type-8 material/receipt可从raw branch重建；decisionID/revision/time变化不影响binding | [F — planned; not created; not run] |
| M1-T12 | 同上 | secret exclusion | raw idempotency key/cursor/signature/encrypted state置于任意canonical/public输入 | encode/project拒绝；仅sealed ref commitment可通过 | [F — planned; not created; not run] |
| M1-T13 | 同上 | F9 | true/false/undefined/unknown/null/string/0 | 精确三值映射；非法值拒绝 | [F — planned; not created; not run] |
| M1-T14 | 同上 | F10–F12 | URL大小写/default port/trailing slash/query/userinfo、authority/model scopes | canonical target稳定；domain membership仅结构完全匹配 | [F — planned; not created; not run] |
| M1-T15 | `packages/core/test/config/config.test.ts` | external codec/F13 | nested `experimental.session_recovery.max_incomplete_recoveries/max_model_assistants` absent/0/1/2/64；camelCase/unknown leaf；agent.steps；negative/float/-0/unsafe/string/null | exact snake_case decode；omitted/default2/64 deterministic mapping与canonical omission；safe-integer refinement；effective min；alias/非法拒绝不clamp | [F — planned; not created; not run] |
| M1-T16 | `packages/schema/test/recovery-old-row.test.ts` | F8/F14/F15 | 当前Legacy rows含0/1/N tool parts且缺providerExecuted/provenance/ledger；兼容payload完整/缺失 | 每个observed tool part均保留为compatibility-only且ordinal稳定；eligible=false；unknown保留；无available proof；非空compatibility不得投影成truly-empty | [F — planned; not created; not run] |
| M1-T17 | `packages/llm/test/recovery-event-decode.test.ts` | F5–F7 | known v1+M4 owner proof、unknown v2、unknown event type、gap/duplicate/extra field、owner proof missing/aggregate/session mismatch/forged brand | known+matching proof成功；其余authority-invalid；F5 M4/store调用计数=0且不downgrade | [F — planned; not created; not run] |
| M1-T18 | 同上 | source/control sets | 普通input/tool/source event混入tail、atomic child control | 非allowed全部stale/invalid；control exact通过 | [F — planned; not created; not run] |
| M1-T19 | `packages/llm/test/recovery-contract-validation.test.ts` | F23 | 24 causes逆序、重复、空、malformed、unsafe-cast runtime unknown discriminator | 合法输出固定24顺序子序列、dedup、nonempty；empty/malformed/runtime unknown均`ok:true ["internal-classification-failure"]`且不throw；compile-time `never` exhaustiveness仍成立 | [F — planned; not created; not run] |
| M1-T20 | 同上 | F24/F25 | automatic/manual/superseded lifecycle矩阵；manual binding missing；superseded误用BindingDigest或缺supersession input/digest | 仅批准组合通过；manual binding mandatory；superseded只接受SupersessionBindingDigest；active-without-child无法表示 | [F — planned; not created; not run] |
| M1-T21 | 同上 | F26/F27/`RecoveryOperationLookupKeyV1` | receipt跨handle/target/digest/context、historical policy quartet mismatch、目标stored sequence partial post-state、目标sequence heads与later current heads不同、current full-prefix corruption、同operationID跨aggregate/type collision | 目标sequence mismatch全部拒绝；合法历史receipt不因later head/policy变化失效；独立current full-prefix/head corruption检查拒绝；lookup必须session+aggregate+operation+expected kind exact，operationID-only拒绝；exact replay receipt通过 | [F — planned; not created; not run] |
| M1-T22 | `packages/schema/test/recovery-public-projection.test.ts` | F28–F30 | safe optional字段、unknown enum/version、每个forbidden authority字段/shape | safe round-trip；unknown enum→unknown；unknown version omit/error；泄漏全部拒绝 | [F — planned; not created; not run] |
| M1-T23 | `packages/schema/test/compatibility.test.ts` | Legacy V1/current assistant optional projection | old payload无recovery、新payload有V1、old decoder fixture | omission向后兼容；既有UnknownError discriminator/message字段不变 | [F — planned; not created; not run] |
| M1-T24 | `packages/llm/test/exports.test.ts`、`packages/core/test/shared-schema.test.ts` | 单一export/依赖方向 | schema/llm/core import graph | 无循环、无第二套recovery union，Native V2/shared compile regression通过 | [F — planned; not created; not run] |
| M1-T25 | `packages/llm/test/recovery-capability.test.ts` | §4.4.4、§4.6.1、F16a/F19 | Anthropic server/hosted、OpenAI store=true hosted、OpenAI store=false encrypted reasoning，以及未来supported descriptor | 本release均保留typed field并返回typed-unavailable；不得omit或进入available closure；未来descriptor version路径可表达但默认不启用 | [F — planned; not created; not run] |
| M1-T26 | `packages/llm/test/recovery-canonical-registry.test.ts` | §4.1.3、E1、F17/F21/F22 | exact F3 frozen definition set、25个registry specs（含supersession binding与authorization/control/tool/reasoning/prefix等）、每项builder最小/完整input、model/no-reply supersession branches、forged domain/spec、cross-brand substitution、safe integer/decimal/-0 | registry cardinality精确25且每个normative brand有唯一constructible builder；supersession input只含durable source/control+pre-prepare facts、两branch可从type10 raw完整重算且不可替代BindingDigest/完整type1 payload digest；逐项domain/vector/brand exact；forged/cross-brand/decimal/-0拒绝 | [F — planned; not created; not run] |
| M1-T27 | `packages/llm/test/recovery-operation-schema.test.ts` | §4.8.1–§4.8.3、F5/F20 | 10个operation最小/完整payload；type1 aggregate genesis/current-event两branch、post-type10 exact predecessor、assistant/dispatch genesis、Legacy user predecessor/assistant info；type10 model/no-reply完整supersessionBindingInput（含submissionPayloadDigest）/digest；type8 manual available/unavailable planning与no-handle/cancelled proof commitment；ops 8–10 decision material；payload/reservation/nextDigest向量 | type1始终model-lineage genesis但仅首aggregate op使用aggregate genesis；model supersession input/digest与later完整type1 payload digest分别验证；仅存digest/opID或丢submissionPayloadDigest拒绝；no-reply input/digest可重算且无reservation/type1；type8在无target/semantic/prepared digest时仍可从raw branch重建，automatic-only字段为extra；8–10 record可仅从raw+envelope确定重建；schema/event/digest bit-exact | [F — planned; not created; not run] |
| M1-T28 | 同上 | §4.5.1–§4.5.4、F3/E1/F6/F7 | raw-set lookalike、event-type/field-set registry version变化、source/control allowed digest互换 | E1拒绝非exact frozen set；任一version/digest变化fail closed；source/control brands不可替换 | [F — planned; not created; not run] |
| M1-T29 | `packages/llm/test/recovery-identity-receipt.test.ts` | §4.2、§4.7.3、F26/F27 | candidate cast、transaction-local `deriveCommittedIdentity`、rollback/commit/read-back、closed `AuthorityReceiptV1`与`ReceiptForV1<T>`、ephemeral applyMode、initial/ordinary/subsequent/automatic operation post-state | derived值在commit前不可作为authority；commit/read-back才brand；immutable receipt无apply mode/materialization status；applyMode只在`OperationCommitResultV1<T>`；receipt逐raw/policy/head/N/M验证，partial拒绝 | [F — planned; not created; not run] |
| M1-T30 | `packages/llm/test/recovery-secret-commitment.test.ts` | §4.3.1/§4.3.4、F10/F15/F16/F18/F19 | provider non-secret version ID、vault HMAC、raw credential SHA、低熵material字典、structurally valid但无M4 lookup proof的ref、proof ref/scope/key mismatch、伪造proof brand | F16只给structural success且零store call；只有M4-produced registered-readable proof与ref逐字段equal时later M1 comparison通过；raw SHA/低熵unkeyed/missing或伪造proof拒绝；M1调用M4/store计数为0 | [F — planned; not created; not run] |
| M1-T31 | `packages/core/test/recovery-policy.test.ts` | §4.6.3–§4.6.4、F13/F20/F26/F27 | absent N/M vs explicit 2/64、provenance变化、scopeKey/epoch/policyDigest/defaultSemanticsVersion变化、first application current policy变化、exact replay later policy变化 | 同值default/explicit policyDigest相等而provenance不同；quartet任一变化使binding/control proof不等；first application stale拒绝；exact replay按stored historical policy通过 | [F — planned; not created; not run] |
| M1-T32 | `packages/schema/test/recovery-public-projection.test.ts` | §4.7.4、F28–F30 | M8尝试传authority、display ID非法/跨session、known/unsupported/malformed | 仅M4调用F28；M8只decode/assert；display ID非authority且三result精确区分 | [F — planned; not created; not run] |
| M1-T33 | `packages/schema/test/recovery-provenance-literals.test.ts` | §4.4.5–§4.4.6、F14/F15 | 每个M1 tool/reasoning V1 literal、SDK/provider同义词、total mapping缺branch/unknown、M4 direct storage/read-back | 只接受direct M1 literal或版本化total mapping输出；unknown/partial mapping拒绝；durable fold保持exact literal并复验对应tool/reasoning digest | [F — planned; not created; not run] |
| M1-T34 | `packages/core/test/recovery-tool-partition.test.ts`（M4/M5协作） | `CanonicalToolEvidencePartitionV1`、snapshot/F20/F24 | authoritative/compatibility两数组四种empty/nonempty组合、遗漏/重复Legacy part、跨partition同callID共存、compatibility-only且payload完整 | 四branch total/disjoint且cardinality双向exact；同partition重复拒绝、跨partition同callID两份均保留；SafeRetry仅truly-empty；compatibility-only/mixed永不automatic | [F — planned; not created; not run] |
| M1-T35 | `packages/core/test/recovery-tool-phase.test.ts`（M3/M4协作） | `ToolExecutionPhaseV1`、F14/closure | planned、body-outcome durable、after-hook未settled、final settled、reconciled terminal、unknown crash；尝试重跑body/after-hook | 仅final-after-hook-settled成为Continue候选；其它全部typed ManualStop；任何phase都不产生rerun authority | [F — planned; not created; not run] |
| M1-T36 | `packages/llm/test/recovery-replay-payload.test.ts`（M3/M4/M7协作） | tool/reasoning/prefix payload、F6/F14/F15/closure | ordered calls/arrays、result/error、reasoning text、prefix；inline/sealed；digest-only、trailing bytes、duplicate key、noncanonical number、purpose/scope/HMAC/digest mismatch | exact payload可重建并重编码byte-equal；owner digest重算通过；one-way digest无carrier拒绝；M7只从snapshot-bound closure构造bit-exact `ModelMessage[]` | [F — planned; not created; not run] |
| M1-T37 | `packages/llm/test/recovery-sealed-use-key.test-d.ts`、`packages/core/test/recovery-sealed-use-key.test.ts`（M4协作） | `SealedRecoveryUseLeaseKeyInputV1` | ref/scope/purpose/material/generation/handle/source/action/operation/session/aggregate/candidate/target逐项变化、raw secret/handle注入、从M1导入sealed-use lease nominal proof | 任一member变化产生不同key/mismatch；raw material拒绝；M4可拥有nominal lease而M1无lease/proof export或registry dependency | [F — planned; not created; not run] |
| M1-T38 | `packages/llm/test/recovery-owner-exports.test-d.ts` | owner/export inventory | M3/M4/M7直接命名`RecoveryClosureDescriptor`、`LegacyUserMessagePredecessorV1`、`OperationSchemaByTypeV1`、`DispatchAdmissionV1`、`TypedIncompleteTerminalFact`、`AssistantChainHeadV1`、`AggregateEventHeadV1`、`AutomaticRecoveryAction`、`RecoveryAdmissionPolicyBindingV1`及新增canonical payload/partition/lease-key types；consumer-local duplicate/private receipt/apply-mode import fixture | owner exports可从唯一M1 barrel命名；dispatch variant只可从exported union提取，private receipt variants只可由`ReceiptForV1<T>`/`AuthorityReceiptV1`提取，apply mode只可由`OperationCommitResultV1<T>["applyMode"]`或exact literals取得；private/duplicate alias与M4 snapshot/tool/sealed-use nominal proof从M1导入均拒绝（既有owner-index/sealed-lookup proof inputs除外）；callable与25-domain cardinality不变 | [F — planned; not created; not run] |

测试数据额外必须记录：provider hits=0、tool side effects=0、durable residue=N/A（M1 pure tests）；涉及M4协作测试时另断言raw row存在而public notifications为0。Golden fixture只能防回归，不能替代exact runtime proof。

## 8. 完整性自检

### 8.1 Workflow §4.3.1 六条

原stable snapshot与D0 changed snapshot均已由independent reviewer复核并达到`0 P0 / 0 P1`。以下六条已按D0 F3/E1/F31 call graph重新签结；用户批准、Step 0、D0与M1-A commit/push已完成。当前M1-A及M1-B F1/F2只有partial implementation evidence，其余implementation/future tests仍是独立后续gate。

- [x] 推导连续：F1–F31/F16a与additional E1均有pre→编号/有序intermediate facts→post；F3 raw construction→E1 enrichment→F5–F7/M4 consumption连续且无反向dependency。
- [x] 分支覆盖：publication、raw/enriched registry identity、public/private durable sets、public event known/unsupported/malformed/read-error、10 operation/version、source/control以及其余既有closed branches均覆盖。
- [x] 退出覆盖：F3 schema/cardinality failure、E1 lookalike/field/canonical/digest failure、F31 manifest isolation failure与既有typed exits均无partial export或silent downgrade。
- [x] callee契约引用：F3只引用F1/F2/F4；E1只引用F4/B24/B25/F17/F21；F31只引用F2/F3 raw set/Event helpers，不调用E1/F17/F21；其它non-trivial callables保持exact pre/post。
- [x] 循环刻画：F2/F3/E1/F4/F6/F7/F14/F15/F16a/F17/F18/F23/F29/F31的有限循环/递归均有终止依据与必要不变量。
- [x] 显式假设链与副作用穷尽：exact frozen raw-set identity、package direction、raw/enriched membership equality与module-init-only effects显式；schema无hash/LLM import，LLM E1无bus/store/publish。

### 8.2 合同覆盖 checklist

- [x] candidate/committed assistant与dispatch均有authority discriminator+brand；chain genesis验证冻结；纯`deriveCommittedIdentity`只产transaction-local非authority值，只有M4 commit/read-back可brand/export committed identity。
- [x] `DispatchTarget`/domain exact；credential authority version使用non-secret provider version ID或keyed HMAC；raw credential SHA-256禁止。
- [x] `StorageMode`严格三值；undefined→unknown，null非法。
- [x] sealed ref为M4-issued opaque branded ID；F16只pure structural/scope validation，registered-readable仅由显式M4 lookup proof与later M1 equality建立；低熵material与paused handle commitment均keyed；raw secret不进canonical/public。`SealedRecoveryUseLeaseKeyInputV1`完整绑定ref/scope/purpose/material/generation/handle/source/action/operation/session，且M1不拥有nominal lease/proof。
- [x] available/opaque evidence字段与禁止字段完整；opaque incomplete不可automatic；candidate admission与committed evidence不混用。
- [x] capability开放空间以closed typed decision表达；server/hosted/store-false reasoning本release为typed unavailable而非删除type。
- [x] tool authority carrier精确为truly-empty/authoritative-only/compatibility-only/mixed total disjoint partition；compatibility facts完整不可省略；SafeRetry只允许truly-empty，Continue只允许authoritative-only且全部final-after-hook-settled。
- [x] tool phase闭合覆盖planned/body-outcome durable/final after-hook settled/reconciled terminal manual-only/unknown intermediate；unknown/intermediate不automatic且任何phase均不授权rerun uncertain body/after-hook。
- [x] tool arguments/result/error、reasoning text、provider-prefix content均有reconstructible inline/sealed carrier、exact canonical encoding、owner commitment、lifecycle与decode/recompute validation；digest-only不能重建；raw cursor/credential/secret不进raw/public。
- [x] tool/reasoning provenance覆盖missing/unknown、provider-end与两类forced flush。
- [x] source/control version绑定F3 raw versions/membership与E1各自allowed-set branded digest；raw/enriched membership/order exact equal；empty tail identity与三处prefix（含content carrier）完整；F5只消费显式M4 owner-mapping proof且零M4/store read。D0 review passed。
- [x] `DurableRecoverySnapshot`不混入current plan/config；planned/admission来源分离；tools partition含同一snapshot全部authority/compatibility facts，Continue closure的sourceBinding与payload carriers/commitments绑定source+control versions；其M4-produced `RecoveryAssistantPublicMappingV1`绑定同一session/source/high-water/source+control digests/latest-decision revision，且不是display-ID map或history inference；available runtime materialization exact嵌套`{descriptor,pausedHandle}`而不污染descriptor。
- [x] proposal无authority；automatic/manual binding均mandatory且manual在无target/semantic/prepared digest时可构造；record为exact lifecycle union，superseded只用`SupersessionBindingDigest`；`AuthorityReceiptV1`、`ReceiptForV1<T>`与`OperationCommitResultV1<T>`名称/索引唯一；immutable receipt证明raw/operation post-state/heads且不含apply mode，ephemeral result独占applyMode；operation lookup key至少为session+aggregate+operation+expected kind。
- [x] external config仅接受nested snake_case `experimental.session_recovery`两leaf，omitted/default canonicalization、safe-integer refinement与deterministic camelCase internal mapping固定；N默认2、M默认64、effective min、N=0/M=1边界与default/explicit同值等价+separate provenance固定。
- [x] 10个operation均有exact discriminated predecessor/payload schema、payload digest domain、event-chain genesis/nextDigest公式、type-indexed operation post-state/receipt；type1区分model-lineage/aggregate genesis并携Legacy predecessor/materialization；8–10 deterministic record material完整；type10 model/no-reply closed union均持久化可重算supersession binding input/digest，model才可被type1一次性消费。
- [x] semantic/prepared/binding architecture digests保留；closed canonical registry仍精确覆盖25个domain；E1只复用B24/B25及existing source/control domains，不新增第26个domain或generic builder；其余commitments与V1 safe-integer约束不变。D0 review passed。
- [x] `RecoveryEventDefinitionSetV1`为schema-owned raw export，`RecoveryEventRegistryV1`为LLM E1 enriched export；其余既有M1 exact exports/private receipt/apply-mode/nominal-proof边界不变。Schema不得import E1，consumer不得复制raw/enriched lookalike。D0 review passed。
- [x] F3 raw internal Event source-level `publication:"internal"`且durable selector为dedicated recovery `aggregateID`；F31只消费raw definitions/publication metadata且对E1/digest零依赖；public/private nominal isolation与generic aggregate exclusion不变。D0 review passed。
- [x] old-row与unknown-version fail closed；旧字段missing不推断false/safe。
- [x] F28 authority projection仅M4可调用；M8只F30/F29 decode/assert already-safe projection；RecoveryChildDisplayID validation/ownership/non-authority固定。
- [x] F30返回known/unsupported/malformed exact union，未知enum与未知structure version区分。
- [x] 24个ManualStop reasons tuple保持原顺序；lower-level source-specific cause union不含reason/code；F23 compile-time穷尽、runtime total无throw、去重、非空，unexpected只返回internal singleton。

### 8.3 Current workflow gate：approved design + Step 0 + D0 review → commit/push → implementation

原M1合同已通过stable-snapshot independent design audit `0 P0 / 0 P1`，随后获得用户批准；`docs/audits/sessrec-1-contract-canonicalization/expectations.md`已完成并随`acc7d0bcf`推送。只读package dependency核查发现原F3会让schema调用LLM-owned F17/F21，因此当前D0按以下顺序收口：

1. **D0 contract correction**：F3改为schema-owned raw `RecoveryEventDefinitionSetV1`；additional E1 `buildRecoveryEventRegistry`由LLM唯一拥有；F31只消费raw definitions/publication metadata。当前状态：已完成。
2. **Fresh D0 independent review**：逐项核对25 builders、4 policy codecs、H1–H3、E1、F1–F31/F16a及§8.1/§8.2。当前状态：`0 P0 / 0 P1`；两个P2 metadata/wording项已修正。
3. **D0 commit/push**：四份D0文档已随`085698426f466b6fc01215c4cb34d89b73ef8290`推送。当前状态：已完成。
4. **M1-A implementation**：scalar/nominal foundation已验证、review并随`deb84e90a9051511db3c9ca69f52cacdaf45af2e`推送。
5. **M1-B implementation**：当前changeset实现F1/F2、97个production/core caller boundary与public manifest source partition；F3/F4仍等待本slice verification/review/commit/push。

用户批准、Step 0、D0与M1-A review/commit/push boxes已完成；M1-B F1/F2为partial implementation，完整M1、F31与future acceptance boxes保持unchecked。该状态不把未实现合同写成runtime proof。

### 8.4 架构不变量与正确性结论

- I4：F5–F7只从raw known-version operations构造source/control；authoritative replay carrier与owner commitment同属raw source fact，compatibility只进入snapshot partition且不提升authority，public projection无输入路径；保持raw sole authority。
- I6：F18/F19/F20分别构造semantic/prepared/binding，`DurableRecoverySnapshot`禁止current plan/config；Continue closure以sourceBinding及同snapshot payload carriers/commitments固定重建输入，sealed-use nominal lease仍由M4拥有；保持来源分离。
- I7：Schema F1–F3/F31提供raw definition-level internal分区、public-only nominal carriers/service/manifests与separate trusted private replay set且不依赖digest；LLM E1只为same raw membership补allowed-set digests供F5–F7/M4消费。M4唯一调用F28并在publication前F29验证，M8仅F30/F29处理already-safe projection；`session.recovery.*`在public type/source/codec中不可表示。
- I10：unknown version、field/payload/digest mismatch、owner mismatch、non-foldable/partial authority均无automatic available输出并由M4/M6 fatal stop；tool compatibility-only/mixed绝不等于empty，planned/body-outcome/reconciled/unknown phase绝不automatic。只有authority完整且独立classification得到canonical causes时才可走ManualStop。opaque/old row作为typed ineligible source可由M5产生ManualStop causes，但绝不修复authority corruption。

在H1–H7及后续M2–M8 callee合同成立时，M1提供的核心结论是：任何可进入automatic classifier/release链的值，都已经通过known-version exact decode、secret-safe canonicalization、来源分离和typed invariant验证；任何unknown、extra field、old-row ambiguity、digest mismatch或public-only事实都不能被M1表示为available authority。本文不声称release后的provider exactly-once，也不把当前50/50运行证据外推为上述future合同已实现。
