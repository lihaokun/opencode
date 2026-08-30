# 修正方案 — untyped provider context overflow 未触发压缩

> 状态：实现、回归与文档同步完成
> 日期：2026-08-29
> 基线：`dev@1df9f230adeea16e8c63eee5a4c4c07f12c4174a`
> 分支：`context-error-classification`
> 影响范围：Legacy `MessageV2.fromError` 的错误分类，以及既有 processor context-overflow recovery 的回归测试

本修复只把已经符合 shared `isContextOverflow()` 文案契约、但未被 ai-sdk 包装成
`APICallError` 的 provider failure 从 `UnknownError` 分类为 `ContextOverflowError`。之后完全复用现有
`SessionProcessor.halt()`、`SessionCompaction` 和 Prompt loop 路径；不修改 retry policy、压缩算法、
压缩次数、单次 provider request envelope 或外部 caller policy。行为层面会从“保存 `UnknownError` 并停止”
变为“满足既有 recovery gate 时发起压缩并继续”，因此恢复成功时会新增既有的摘要 request，并可能重放
当前 user turn；这不是零副作用的纯重命名。

---

## 第一部分：现象与复现

### 1.1 现象、触发条件与影响

OpenAI-compatible / LiteLLM 类 gateway 可能把 context overflow 作为 untyped `Error`、string，或
只带 `message` 的普通对象交给 OpenCode，而不是 ai-sdk 的 `APICallError`。生产观察到的稳定文案形如：

```text
litellm.BadRequestError: OpenAIException - Requested token count exceeds the model's maximum context length of 307200 tokens. You requested a total of 324629 tokens: 260629 tokens from the input messages and 64000 tokens for the completion.
```

生产日志中的 `stack=undefined` 只能证明不能依赖标准 `Error.stack`，不能反推出运行时输入一定是 string、普通
对象或某个 `Error` subclass。因此回归覆盖三个 fallback shape，但不把未采集到的原始 runtime type 写成事实。

shared matcher 已能识别其中的：

```text
exceeds the model's maximum context length of 307200 tokens
```

但是 `MessageV2.fromError()` 只在 `APICallError` 分支调用该 matcher。untyped failure 会落成
`UnknownError`，因此 processor 不设置 `needsCompaction`，而是保存普通终态错误并返回 `"stop"`。

OpenCode 自身不会 retry 这个 `UnknownError`。若外部自动化 caller 在收到失败后不断提交新的 user turn，
系统层面会形成重复失败；每轮新增的 user/synthetic 输入还可能继续放大 prompt。该外部循环是分类缺陷的
后果，不是 `SessionRetry` 对 `UnknownError` 的内部重试。

影响边界：

- typed `APICallError` context overflow：现有行为正确，不受影响；
- structured stream error `{ type: "error", error.code: "context_length_exceeded" }`：现有行为正确；
- untyped provider error whose extracted message matches `isContextOverflow()`：当前错误地变成 `UnknownError`；
- 不符合 overflow matcher 的普通 Error、rate limit、throttling、tool/plugin/internal failure：必须保持现有分类；
- generic fallback 没有 provider provenance；任何来源只要落入该 fallback 且 message 命中 shared matcher，
  都会被分类为 `ContextOverflowError`。这是最小方案的明确边界，而不是只对 LiteLLM class 的特判。

### 1.2 可直接运行的最小复现

从 `packages/opencode` 执行：

```bash
bun -e '
import { ProviderV2 } from "@opencode-ai/core/provider"
import { isContextOverflow } from "@opencode-ai/llm"
import { MessageV2 } from "./src/session/message-v2"

const message = "litellm.BadRequestError: OpenAIException - Requested token count exceeds the model\x27s maximum context length of 307200 tokens. You requested a total of 324629 tokens: 260629 tokens from the input messages and 64000 tokens for the completion."
const ctx = { providerID: ProviderV2.ID.make("test") }

console.log({
  matcher: isContextOverflow(message),
  error: MessageV2.fromError(new Error(message), ctx).name,
  string: MessageV2.fromError(message, ctx).name,
})
'
```

修复前输出：

```text
{
  matcher: true,
  error: "UnknownError",
  string: "UnknownError",
}
```

修复后预期：

```text
{
  matcher: true,
  error: "ContextOverflowError",
  string: "ContextOverflowError",
}
```

### 1.3 出错代码路径

```text
provider / gateway failure
  → LLM stream failure
  → SessionProcessor.process() / halt()
  → MessageV2.fromError(failure)
     ├─ APICallError
     │    → ProviderError.parseAPICallError()
     │    → isContextOverflow(message)
     │    → ContextOverflowError                         [正确]
     ├─ Error
     │    → NamedError.Unknown                          [缺口]
     └─ string / plain object
          → parseStreamError() 仅识别 structured error
          → NamedError.Unknown                          [缺口]
  → SessionProcessor.halt()
     → ContextOverflowError.isInstance(error) == false
     → 不设置 needsCompaction
     → process 返回 "stop"
```

相关实现：

- `packages/opencode/src/session/message-v2.ts`：`MessageV2.fromError()`；
- `packages/opencode/src/provider/error.ts`：`parseAPICallError()` / `parseStreamError()`；
- `packages/llm/src/provider-error.ts`：`isContextOverflow()`；
- `packages/opencode/src/session/processor.ts`：`halt()` 的既有 `ContextOverflowError` 分支；
- `packages/opencode/src/session/compaction.ts`、`prompt.ts`：既有一次性压缩恢复。

### 1.4 预期行为与实际行为

| 输入 failure                    | 当前                       | 预期                                                          |
| ------------------------------- | -------------------------- | ------------------------------------------------------------- |
| LiteLLM-shaped `Error(message)` | `UnknownError`，不触发压缩 | `ContextOverflowError`，满足 recovery gate 时返回 `"compact"` |
| 同文案 string / `{ message }`   | `UnknownError`             | `ContextOverflowError`                                        |
| typed `APICallError` overflow   | `ContextOverflowError`     | 保持不变                                                      |
| structured stream overflow      | `ContextOverflowError`     | 保持不变                                                      |
| 普通 Error                      | `UnknownError`             | 保持不变                                                      |
| rate limit / throttling 文案    | 非 overflow                | 保持不变                                                      |

---

## 第二部分：根因分析

### 2.1 根因：message matcher 被 runtime type gate 隔离

`isContextOverflow()` 表达的是 provider failure message 的共享语义分类，但当前唯一通用调用点
`parseAPICallError()` 要求输入先满足 `APICallError.isInstance(e)`。这把“错误是否 overflow”错误地依赖于
“ai-sdk 是否使用特定 Error class 包装该错误”。

同一句稳定 overflow 文案因 runtime shape 不同得到不同结果：

```text
APICallError(message) → ContextOverflowError
Error(message)        → UnknownError
string message        → UnknownError
```

provider/gateway 的封装差异不应改变 OpenCode 的恢复语义。

### 2.2 structured stream parser 不能替代 message fallback

`ProviderError.parseStreamError()` 只处理可解析 JSON 且满足既定 structured schema 的错误，例如：

```json
{ "type": "error", "error": { "code": "context_length_exceeded" } }
```

LiteLLM-shaped raw message 不是该 schema；它应在 structured parser 未命中后使用 shared message matcher，
而不是要求扩展每一种 gateway 私有 JSON/Error class。

### 2.3 症状与根因的区分

- 根因：untyped provider overflow 未被分类为 `ContextOverflowError`；
- 直接症状：processor 不进入既有 `needsCompaction` 路径；
- 放大器：外部 driver 收到 `stop` 后继续提交新 turn；
- 非根因：`SessionRetry`。`UnknownError` 当前已经不可 retry；
- 非根因：压缩算法。压缩从未获得本次 provider overflow signal。

### 2.4 非目标

本修复不处理：

- `Token.estimate(chars / 4)` 的预估误差；
- compaction safety margin / model limit 配置；
- context overflow 已产生 assistant/tool evidence 后的恢复策略；
- 一次 recovery 后第二次 overflow 的终止规则；
- 外部 FSM/judge driver 的 retry policy；
- generic provider error taxonomy；
- #19 incomplete-stream retry、rollback、fence 或 billing 语义。

### 2.5 既有恢复语义带来的副作用

分类修正会让此前停在 `UnknownError` 的请求首次进入现有 overflow recovery，因此必须把下游行为算作本修复
可观察到的副作用：

1. processor 在当前失败 assistant 尚无 text/reasoning/tool evidence、auto compaction 开启且本轮允许恢复时
   返回 `"compact"`；
2. `SessionCompaction` 会调用 compaction model 生成摘要，因此至少新增一次 provider request；
3. 对 provider 拒绝当前 payload 的 overflow，现有 compaction 逻辑会从 compaction marker 向前找到当前
   non-compaction user message，压缩它之前的历史，然后复制该 user message/parts 作为新的 replay turn；
4. 如果同一个 user turn 的较早 assistant step 已完成工具调用，而后续 provider step 因工具结果使 payload
   过大才 overflow，那么 replay 只复制 user parts，不复制已完成的 assistant/tool parts。模型可能再次调用
   同一工具，非幂等工具因而存在重复副作用风险；
5. recoverable overflow 仍会按现有 processor 语义发布一次 `Session.Event.Error`，即使失败 assistant 最终不持久化
   `ContextOverflowError`、而是继续进入 compaction；事件消费者可能先看到 overflow 再看到后续恢复；
6. recovery gate 不满足时，durable assistant error 会从 `UnknownError` 变为 `ContextOverflowError`。这是本修复的
   目标，但依赖 error name 的外部消费者也会观察到分类变化。

第 4 点不是本修复新设计的 compaction 行为：typed `APICallError` overflow 和 preflight overflow 已走同一路径。
本修复会让 LiteLLM-shaped fallback error 也获得这套恢复语义，因而扩大了实际触发面。本分支不修改
`SessionCompaction` 的 replay policy；若不能接受该既有语义，应另立 compaction/tool idempotency 设计，不能把它
隐含在错误分类补丁里。

### 2.6 generic matcher 的 provenance 边界

`MessageV2.fromError()` 也可能接收 processor 内 plugin、snapshot 或其他内部失败。fallback 本身无法证明错误
来自 provider，而 shared matcher 含有 `too many tokens`、`request entity too large`、`exceeds the limit of N`
等较宽 pattern。因此最小方案的精确行为是：

```text
typed/structured 优先分支未命中
AND extracted message 命中 shared matcher
→ ContextOverflowError（不再区分错误来源）
```

rate-limit/throttling exclusions 仍生效，普通内部错误仍为 `UnknownError`；但一个内部错误若恰好使用 matcher-shaped
文案，会触发同样的 overflow recovery。要消除这个来源误判，需要在 provider boundary 保留 provenance 并在那里
分类，改动会明显大于本次讨论的“把 overflow 从 Unknown fallback 剥离出来”。本方案选择最小改动，同时把该
trade-off 作为实现前显式确认项。

---

## 第三部分：参考实现对照

本问题不是算法实现错误，不需要外部算法参考。内部正确参考是已有 `APICallError` 路径：

```ts
const parsed = ProviderError.parseAPICallError({ providerID, error })
if (parsed.type === "context_overflow") {
  return new ContextOverflowError(
    { message: parsed.message, responseBody: parsed.responseBody },
    { cause: error },
  ).toObject()
}
```

同一生产 message 已通过独立执行证明 `isContextOverflow(message) === true`。修复只把这个既有分类契约
应用到 typed/structured parser 均未覆盖的 fallback shape；不创建第二套 pattern。

执行差异：

| 步骤                    | typed APICallError     | untyped Error（修复前） | untyped Error（修复后） |
| ----------------------- | ---------------------- | ----------------------- | ----------------------- |
| 提取 message            | 是                     | 是                      | 是                      |
| shared matcher          | 是                     | 否                      | 是                      |
| public error type       | `ContextOverflowError` | `UnknownError`          | `ContextOverflowError`  |
| processor recovery gate | 执行                   | 跳过                    | 执行                    |

---

## 第四部分：修复方案

### 4.1 修改范围

只修改 `MessageV2.fromError()` 的 generic fallback：

1. 保持 Abort、OutputLength、Auth、ECONNRESET、Zlib、header/stream transport、`APICallError` 等 typed 分支优先级；
2. `Error` fallback 在生成 `UnknownError` 前提取一次 `errorMessage(e)`；
3. matcher 命中则生成 `ContextOverflowError({ message })`；
4. 非 Error fallback 先保留现有 `parseStreamError()` structured 解析；
5. structured parser 未命中后，对 `errorMessage(e)` 使用同一 matcher；
6. matcher 未命中时保持既有 `UnknownError` 行为。

伪代码：

```ts
function contextOverflowFallback(e: unknown) {
  const message = errorMessage(e)
  if (!isContextOverflow(message)) return
  return new ContextOverflowError({ message }, { cause: e }).toObject()
}

// after APICallError branch
case e instanceof Error:
  return contextOverflowFallback(e) ?? new NamedError.Unknown({ message: errorMessage(e) }, { cause: e }).toObject()

default:
  try {
    const structured = ProviderError.parseStreamError(e)
    if (structured) return existingStructuredMapping(structured)
  } catch {}
  return contextOverflowFallback(e) ?? existingUnknownMapping(e)
```

实现可按现有 control-flow style 内联或提取紧邻 `fromError()` 的复用 helper；不得修改 shared matcher 内容来
针对单一实例打补丁。structured parser 的现有 fail-safe `try/catch` 必须保留；message fallback 只能位于该
parser 未返回映射之后。

### 4.2 修正后的主流程

```text
untyped LiteLLM failure
  → MessageV2.fromError
  → errorMessage(failure)
  → isContextOverflow(message) == true
  → ContextOverflowError
  → SessionRetry.retryable() == undefined
  → SessionProcessor.halt()
  → existing recovery gate:
       auto enabled
       AND recoverContextOverflow
       AND no assistant evidence
  → ctx.needsCompaction = true
  → process returns "compact"
  → existing Prompt compaction flow
```

若 recovery gate 不满足，仍按现有设计持久化 `ContextOverflowError` 并停止；本修复只保证分类正确，不承诺
所有 context overflow 都自动重放。

### 4.3 错误优先级与兼容

- typed `APICallError` 继续保留 status、headers、responseBody 等详细字段；generic fallback 不覆盖它；
- generic fallback 构造的 `ContextOverflowError` 只保留提取出的 message，不伪造未知的 status、headers 或
  responseBody；
- structured stream error 继续优先由 `parseStreamError()` 映射；
- rate limit/throttling 继续受 `isContextOverflow()` exclusions 排除；
- `ContextOverflowError` 继续不进入 ordinary retry；
- generic non-overflow Error 仍为 `UnknownError`；任何来源若主动抛出匹配既有 overflow 文案的 generic
  Error，都会按现有 message-based 分类契约进入 `ContextOverflowError`；
- `HeaderTimeoutError`、`ResponseStreamError` 等已有 typed transport 分支仍保持其 `APIError` 语义，即使其
  message 偶然命中 matcher；本修复只修正原本会落入 `UnknownError` 的 fallback；
- 不改 `provider-error`/LLM event schema，不增加 public error type。

### 4.4 用最小复现走修正后逻辑

```text
input = Error("litellm... exceeds the model's maximum context length ...")
→ typed special cases: no match
→ APICallError: false
→ generic message fallback
→ matcher: true
→ ContextOverflowError
```

string / `{ message }` 输入在 structured parser 未命中后走同一 fallback，结果相同。

---

## 第五部分：正确性论证

### 5.1 根因消除

根因是 shared matcher 只对 `APICallError` 可达。修复使 typed/structured parser 未覆盖的 provider failure
也能使用同一 matcher，因此分类不再依赖特定 runtime Error class。生产文案已证明 matcher 命中，故最小复现
从 `UnknownError` 变为 `ContextOverflowError`。

### 5.2 不变量保持

- typed error 分支顺序不变；
- structured stream parser 优先级不变；
- matcher 仍是唯一 text classification source；
- rate-limit exclusions 不变；
- `ContextOverflowError` 的 retry/compaction gate 不变；
- 分类函数本身不发送 request；但分类结果会启用既有 recovery，恢复流程会新增 compaction summary request，
  并可能新增 replay provider request；
- user-turn replay、tool 重执行风险及一次 recovery 的边界均保持现有 `SessionCompaction` 语义；
- 不修改 message/part/session schema 或 durable chronology。

### 5.3 无回归

行为变化只发生在：

```text
typed/structured parser 未命中
AND errorMessage(e) 命中既有 context-overflow matcher
```

普通 Error 继续落成 `UnknownError`；rate-limit 文案由 exclusions 保持非 overflow。第六部分同时覆盖 typed
`APICallError`、structured error 与 recovery-disabled/evidence-started 边界，证明 recovery gate 未被扩大为
无条件重放。对于命中 matcher 的 generic internal error，分类变化是第 2.6 节明确接受的 source-agnostic 行为，
不能表述成“仅 provider failure 会变化”。

### 5.4 终止性

本修复不增加循环。分类成功后进入现有 bounded overflow recovery：一个 recovery episode 只允许既定次数的
压缩恢复；后续再次 overflow 按现有规则终止。外部 caller 是否重新提交新 turn 不在本函数控制范围。

---

## 第六部分：测试用例清单

| 类型           | 用例                                                                             | 关键断言                                                                            | 状态         |
| -------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------ |
| 回归/unit      | LiteLLM 原文作为普通 `Error`                                                     | `MessageV2.fromError()` 返回 `ContextOverflowError`，message 保真                   | 已加；本提交 |
| 回归/unit      | LiteLLM 原文作为 string / `{ message }`                                          | structured parser fallback 后返回 `ContextOverflowError`                            | 已加；本提交 |
| 兼容/unit      | 普通 Error / nonmatching plain object                                            | 仍返回 `UnknownError`，既有 message 序列化保持不变                                  | 已加；本提交 |
| 兼容/unit      | rate limit / too many requests 文案                                              | 不误判为 `ContextOverflowError`                                                     | 已加；本提交 |
| 兼容/unit      | typed `APICallError` overflow                                                    | 继续保留现有 message/responseBody 映射                                              | 既有用例通过 |
| 兼容/unit      | structured `context_length_exceeded`                                             | 继续由 `parseStreamError()` 映射                                                    | 既有用例通过 |
| 回归/processor | stream 在 assistant output 前以 LiteLLM-shaped plain `Error` 失败                | 与 typed overflow 等价：processor 返回 `"compact"`，不落成 assistant `UnknownError` | 已加；本提交 |
| 安全/processor | tool evidence 后发生同一 untyped overflow                                        | 保留 terminal `ContextOverflowError`，不在当前 processor attempt 内自动 compact     | 已加；本提交 |
| 回归           | `test/session/message-v2.test.ts` + `retry.test.ts` + `processor-effect.test.ts` | 全量通过                                                                            | 150 pass     |
| 类型           | `bun typecheck`（`packages/opencode`）                                           | 通过                                                                                | 已通过       |

最小复现必须固化为第一行 unit regression；只增加 processor integration 而缺少纯分类回归不算完成。

验证命令均从 `packages/opencode` 执行：

```bash
bun test test/session/message-v2.test.ts --timeout 30000
bun test test/session/retry.test.ts --timeout 30000 --max-concurrency 1
bun test test/session/processor-effect.test.ts --timeout 30000 --max-concurrency 1
bun typecheck
```

结果分别为 42/42、37/37、71/71 和 typecheck 通过。受限沙箱内所有需要绑定 localhost 临时端口的既有 HTTP
mock 用例会统一报 `EADDRINUSE`；相同命令在允许 localhost bind 后全部通过，因此该失败已分类为执行环境限制，
没有修改测试或生产逻辑规避。

---

## 第七部分：代码更新清单

| 文件                                                      | 函数 / 位置                       | 改动                                                                                                             | 状态         |
| --------------------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------ |
| `packages/opencode/src/session/message-v2.ts`             | imports / `MessageV2.fromError()` | generic Error 与 structured-parser fallback 使用 shared `isContextOverflow()`，命中时构造 `ContextOverflowError` | 已改；本提交 |
| `packages/opencode/test/session/message-v2.test.ts`       | `session.message-v2.fromError`    | 增加 Error/string/plain-object、普通错误与 exclusion 回归                                                        | 已改；本提交 |
| `packages/opencode/test/session/processor-effect.test.ts` | context-overflow scenarios        | 增加 untyped provider failure 的 compact/terminal gate 集成回归                                                  | 已改；本提交 |

`packages/opencode/test/session/retry.test.ts` 只重跑，不因本修复新增或搬迁分类用例：retry policy 没有变化，
纯 `fromError()` 回归应与现有同类测试放在 `message-v2.test.ts`。

明确不修改：

- `packages/opencode/src/session/retry.ts`；
- `packages/opencode/src/session/processor.ts` 生产逻辑；
- `packages/opencode/src/session/compaction.ts`；
- `packages/opencode/src/session/prompt.ts`；
- `packages/llm/src/provider-error.ts` patterns；
- provider adapter、Protocol、HttpApi、SDK/generated code、数据库 schema。

---

## 第八部分：文档更新清单

| 文档                                                 | 更新                                                                                                                   | 状态           |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------- |
| `docs/fixes/session-fix-untyped-context-overflow.md` | 本次八部分根因、方案、证明、测试/代码状态；实现后回填 commit 与验证结果                                                | 已回填；本提交 |
| `docs/fixes/session-fix-context-overflow.md`         | 实现后补充 cross-reference：provider error recovery 的分类入口扩展到 typed/structured parser 未覆盖的 message fallback | 已同步；本提交 |

无需更新 public docs、Protocol/HttpApi、SDK 或用户配置文档：本修复不改变公开 schema，只让已有
`ContextOverflowError` 契约覆盖原本遗漏的 provider failure shape。

---

## 实现前审核 gate

- [x] 用户确认只改分类层，不扩展 retry/compaction 状态机；
- [x] unit regression 同时覆盖 Error 与非 Error fallback；
- [x] structured parser 仍先于 generic message fallback；
- [x] structured parser 的既有 fail-safe `try/catch` 保留；
- [x] typed `APICallError` 详细字段保持不变；
- [x] rate-limit exclusions 有负例；
- [x] processor 只在现有 recovery gate 满足时返回 `"compact"`；
- [x] 用户确认 generic fallback 是 source-agnostic：内部错误若恰好命中 shared matcher 也会被重分类；
- [x] 用户确认启用既有 overflow recovery 会增加 summary/replay request，并接受 user-turn replay 可能再次执行工具；
- [x] 本分支不顺带修改 `SessionCompaction` replay/tool idempotency policy；
- [x] 不把外部 caller retry 描述成 OpenCode internal retry；
- [x] 不声称 OpenCode把 error assistant 正文重新注入模型历史；
- [x] 实现前未修改生产代码。
