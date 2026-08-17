# SESSREC-1 M1-C：recursive exact field-set boundary

日期：2026-08-17
分支：`yixiao-issue-7-new`
范围：仅 M1-C F4 `validateExactFieldSet`；不包含 F3 recovery definitions、F5–F31、Legacy runtime recovery 或 Native V2 recovery。

## 背景与切片边界

前一切片 M1-B 已完成 F1/F2 source-level event publication boundary、public manifest source partition 与 97 个 production/core caller 迁移，并随 commit `8bcb26e5384a22804dd73da7aef85e5f0b4e99e8` 推送。

F3 不能与 F4 在同一未审切片中直接实现：F3 的前置条件要求十类 recovery operation schema、nested exact specifications 与 F4 均已存在，而当前仓库尚无 `RecoveryOperationType`、`OperationSchemaByTypeV1`、`RecoveryOperationEnvelope` 或十个 `session.recovery.*` definitions。为保持依赖顺序和“每完成一步先 commit/push”的 gate，本次只完成可独立验证的 F4；本切片 push 后才规划 F3。

## 实现内容

### Public contract

在 canonical schema owner `packages/schema/src/llm.ts` 中新增：

- frozen `ExactFieldSetSpecification<T>` 六分支 DSL：literal、string predicate、safe integer、array、object、union；
- 唯一 public callable `validateExactFieldSet<T>(...) -> ContractResult<void,FieldSetError>`；
- 唯一 `// # Step P4: validate recursive exact field membership` marker；
- stable path convention：root `$`、identifier `.field`、其它字段 JSON bracket notation、array `[index]`；
- deterministic single typed error，不提供 throwing、Effect、boolean 或 raw-void shortcut。

没有新增 top-level source file，因此没有通过 `packages/schema/package.json` 的 `./*` export map 意外形成第二 external subpath。

### Full specification compilation

早期实现只在 value traversal 真正进入某个 child 时才检查对应 specification。这样会让 absent optional field、empty array element 或 unselected union branch 中的 malformed spec 被遗漏。

最终实现先以显式 worklist 编译整个 reachable specification graph：

- 每个 specification object 按 identity 只编译一次；reused spec 的 own-key compilation pass 不重复执行；
- 在处理 child 前先登记当前 compiled node，因此 recursive specification graph 可有限终止；
- required/optional、fields、branches、min/max、array order 与 predicate type 全部在 value traversal 前验证；
- hostile/revoked Proxy reflection failure 收敛为 root path 的 typed `wrong-set`；
- malformed unused spec 同样 fail closed。

### Iterative value traversal

首版使用 JavaScript 递归。真实 runtime probe 构造 12,000 层合法 recursive union/object value 后，调用栈溢出被 catch 为 `wrong-set`，把合法有限输入错误拒绝。

最终改为显式 frame stack：

- `validate`、`array-next`、`object-next`、`leave-value`、`leave-union`、`complete` frames；
- lazy linked path，仅在错误出口 materialize 字符串；
- array/object 每次只推进一个 child continuation，不预先分配全部 child paths/frames；
- active value/union sets 检测 cycle；
- 12,000 层 finite value 不依赖 JavaScript call stack。

### Shared-DAG memoization

独立 review 的真实 probe 表明 shared acyclic graph 会被重复展开：

| 深度 | 修复前 leaf predicate 调用 |
|---:|---:|
| 12 | 4,096 |
| 16 | 65,536 |
| 20 | 1,048,576（约 19.1 秒） |

最终按 `(value object, specification object)` memoize 已成功完成的 pair。Depth-20 shared DAG 现在只执行一次 leaf predicate，避免指数重复验证。

该 memoization 的合同前提已显式化：调用期间 value/specification 的 prototype、own keys、descriptors、array entries/length 与 predicate result 必须稳定。任意 JavaScript validator 都无法对 adversarial time-varying Proxy reflection 证明调用结束后的 exactness；stateful/mutating Proxy 因而不满足 F4 Requires。Throwing/hostile reflection 仍在实现边界内 fail closed。

### Descriptor、prototype 与 accessor hardening

最终 boundary：

- 只读取 own data descriptors，不调用 value/spec accessor 或 `Symbol.toStringTag`；
- inherited required field 视为 missing；inherited optional authority field视为 extra，且 `Reflect.has` 不调用 inherited getter；
- symbol、non-enumerable、accessor、decorated array key 与 sparse index 均 fail closed；
- ordinary-object 检查沿 prototype chain 做 descriptor-only walk；
- 只接受 terminal、null-parent prototype 上与该 prototype identity 对应的 intrinsic `Object` constructor；
- 拒绝 `Date`、普通 class instance、名为 `Object` 的 class、替换 constructor 为 intrinsic `Object` 的 class，以及 detached/relabelled class prototype；
- 真实 `node:vm` foreign-realm plain object 仍通过；
- custom ordinary prototype 仍可通过，但 intermediate prototype 不能伪造 constructor authority。

### Deterministic order and bounded work

- extra field 使用 linear minimum scan，不再排序全部 keys；
- object child validation 固定按 `required` 后 `optional` 的 specification order；
- array 固定 numeric index order；
- specification identity cache消除每个 reused value occurrence 的重复 spec reflection；
- value/spec completed-pair cache消除 shared-DAG 的重复 subtree traversal。

## 独立审查 chronology

### 第一轮：9 项 finding

1. **Inherited optional authority field 被当作 absent**
   结果：代码修复。own descriptor absent 但 prototype chain 存在同名字段时返回 `extra`；回归证明 inherited getter 未被调用。

2. **`string.validate` 可修改 captured authority 或表现为 nondeterministic**
   结果：合同修复。Requires 明确 predicate 必须 total、deterministic、side-effect-free、non-mutating；throw 仍转换为 typed `wrong-set`。

3. **Generic `T` 不从 DSL shape 推导，可能被错误标注**
   结果：合同边界澄清。`T` 是 descriptive caller contract；F3 必须以 registry parity/property tests 建立 schema↔spec equivalence，不能把 F4 generic 当作该证明。

4. **Unused nested malformed specification 未验证**
   结果：代码修复。完整 spec graph 在 payload traversal 前编译；absent optional、empty array 与 unselected union 的 malformed child 均有永久回归。

5. **名为 `Object` 的 class 可伪装 ordinary object**
   结果：代码修复。constructor name 之外还验证 intrinsic `Function.prototype.toString` source；真实 foreign realm object 回归同时通过。

6. **Shared acyclic graph 指数重复验证**
   结果：代码修复。completed value/spec pair memoization；depth-20 leaf predicate 从 1,048,576 次降为 1 次。

7. **Wide container eager 构造 descriptors/paths/frames**
   结果：代码修复。array/object continuation 每次只推进一个 child；lazy path 仅在失败时 render。

8. **Reused specification 被反复 reflection/rebuild**
   结果：代码修复。完整 graph compile + identity cache；100 个 reused element 只触发一次 spec `ownKeys`。

9. **Extra-key sorting 带来不必要的 `O(n log n)`**
   结果：代码修复。改为 deterministic linear minimum scan。

### Targeted follow-up

Follow-up 又构造了三项针对 hardening/memoization 的反例：

1. **class prototype 的 constructor slot 被替换为 intrinsic `Object`**
   修复：intrinsic constructor 只能出现在 terminal null-parent prototype。

2. **同一 stateful Proxy 在第二次 reflection 暴露 extra key，但 completed pair 已跳过**
   处置：不是可机械证明的 mutable-view postcondition；新增 stable reflection Requires，并保留 hostile/throwing Proxy fail-closed runtime coverage。

3. **class prototype 被 detach 到 null，再 relabel constructor 为 intrinsic `Object`**
   修复：accepted constructor 的 own `prototype` 必须与正在检查的 terminal prototype identity 相同。

最终同一 independent reviewer 返回 `[]`，无剩余 actionable P0/P1/P2 finding。

## 运行证据

所有 schema 手动测试均从 `packages/schema` 目录执行；repository typecheck 从 repository root 执行。Bun 版本为 `1.3.14`。

| 证据 | 结果 |
|---|---|
| F4 focused runtime | `14 pass / 0 fail / 94 assertions` |
| FastCheck | finite exact object/missing/extra property，`250` runs |
| Schema typecheck | `tsgo --noEmit` passed；包含 `.types.ts` negative fixtures |
| Schema non-manifest regression | `43 pass / 0 fail / 383 assertions` |
| Full schema suite | `43 pass / 2 fail / 399 assertions` |
| Repository Turbo typecheck | `30 successful / 30 total` |
| Mechanical scope | P4 marker `1`；P3 marker `0`；`session.recovery.*` source definitions `0`；schema→LLM imports `0`；`git diff --check` clean |
| Independent review | final `[]` |

Full schema 的两项失败未被修改或隐藏：

1. `public event manifest > owns the complete public event surface`：expected `ServerDefinitions = 55`，actual `58`；
2. `public event manifest > uses canonical definitions for current public events`：既有 canonical definition slice mismatch。

这两项在 clean D0/M1-A 已可复现，F4 non-manifest suite 与 monorepo typecheck均通过，因此本切片只记录 baseline，不修改 expectation。

## 明确未实现

本切片没有新增：

- P3、F3、`RecoveryOperationType`、`OperationSchemaByTypeV1`、`RecoveryOperationEnvelope`；
- 十个 `session.recovery.*` definitions；
- F5–F31、E1、canonical builders/digests；
- Legacy runtime recovery、DB/migration、OpenAPI/generated SDK；
- Native V2 recovery flow/API/event/acceptance。

## 经验教训

1. Authority-sensitive exact validator必须先验证完整 specification graph，不能让 payload traversal决定哪些合同分支值得检查。
2. “不使用 accessor”不仅是不用普通属性读取；prototype classification、optional inheritance、`Symbol.toStringTag` 与 hostile Proxy traps都必须走 descriptor/reflection boundary。
3. 深度安全与图复杂度是两个独立义务：显式stack解决 call-stack overflow，completed pair memoization解决shared-DAG指数展开。
4. 允许 custom/foreign ordinary objects 时，constructor name不足以识别class spoof；必须同时绑定terminal prototype、intrinsic source和constructor.prototype identity。
5. Arbitrary callback purity与time-varying Proxy reflection无法由TypeScript/JavaScript runtime普遍证明，必须把stable/pure owner obligations写进Requires，同时对可观察的throwing/hostile边界fail closed。
6. Phantom/descriptive generic不能替代schema↔spec parity proof；真正的一一对应必须由F3 closed registry和property tests建立。

上述可复用教训已同步到本地 ignored `CLAUDE.md`；该文件不会stage或commit。

## 度量

| 指标 | 数值 |
|---|---|
| 新增代码行数 | 约 1,506（production 648 + runtime/type tests 858） |
| 修改代码行数 | 约 68 行contract/status文档新增/重写，另有62行旧状态文本替换 |
| 删除代码行数 | 0 production/test；62行旧文档状态/合同文本被替换 |
| 涉及文件数 | 8 个待提交文件（1 source、2 tests、4 contract/status docs、1 devlog） |
| 新增测试用例数 | 14 个 runtime tests + 1 个 compile-time fixture |
| 测试通过率 | focused 14/14；non-manifest 43/43；full 43/45（2项已知baseline） |
| 发现 bug 数 | 12 个独立review finding（9 initial + 3 follow-up） |
| 修复 bug 数 | 12 个已处置（9 code hardening + 3 contract/precondition clarifications） |
| 迭代轮次 | 1 次设计切片；1 次初始实现；4 次 runtime/review hardening；3 次 targeted follow-up |
