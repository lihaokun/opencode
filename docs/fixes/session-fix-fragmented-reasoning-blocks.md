# 修正方案 — `session: fragmented reasoning blocks`

- 状态：根因机制已确认；真实 provider 输入形状与最终修复分支待确认
- 分析日期：2026-08-05
- 对应问题：[Issue #8](https://github.com/lihaokun/opencode/issues/8)
- 分析基线：`49fa19830d`
- 影响模块：AI SDK LLM adapter、Session processor、TUI reasoning renderer
- 实现门禁：先取得一份脱敏的 `fullStream` reasoning 事件序列（至少保留 `type`、`id`、
  `providerMetadata` 是否存在及事件间的非 reasoning 类型），再在本文件的方案 A/B 中二选一；
  未确认前不修改代码或测试

## 一、现象与复现

### 1.1 现象

当 AI SDK provider 把连续 reasoning token chunk 表示成一系列离散的
`reasoning-start → reasoning-delta → reasoning-end` triple 时，opencode 会把每个 triple
持久化成独立 `reasoning` part。TUI 对每个 part 独立渲染一个带时长的 `Thought` header，因而
本应连续的思考文本被切成许多毫秒级块。

### 1.2 触发条件

已确认的必要条件：

1. 请求走 `streamText(...).fullStream → LLMAISDK.toLLMEvents()` 的 AI SDK 路径；
2. 一个 provider turn 内出现两个或更多相邻 reasoning triple；
3. triple 之间没有本应建立语义边界的 text、tool、step 或 finish 事件；
4. TUI 显示 reasoning part。

尚未从 Issue 取得、会决定正确修复层的条件：

- 事件是否真的缺少 `id`；
- 若有 `id`，相邻 triple 使用同一个 ID 还是不同 ID；
- `reasoning-start` / `reasoning-end` 是否带签名、加密状态或其他 `providerMetadata`；
- provider 包、版本、模型和最小请求。

满足已确认条件时，当前状态机确定性复现，不是概率问题。

### 1.3 最小复现

从 opencode 可见的 AI SDK `fullStream` 边界开始，向真实 adapter 输入 Issue 描述的两个匿名
triple：

```ts
const state = LLMAISDK.adapterState()
const input = [
  { type: "reasoning-start" },
  { type: "reasoning-delta", text: "codebase to get" },
  { type: "reasoning-end" },
  { type: "reasoning-start" },
  { type: "reasoning-delta", text: "a good understanding of" },
  { type: "reasoning-end" },
]

const output = await Effect.runPromise(
  Effect.forEach(input, (event) => LLMAISDK.toLLMEvents(state, event)).pipe(Effect.map((events) => events.flat())),
)
```

2026-08-05 在基线 `49fa19830d` 的实际输出：

```json
[
  { "type": "reasoning-start", "id": "reasoning-0" },
  { "type": "reasoning-delta", "id": "reasoning-0", "text": "codebase to get" },
  { "type": "reasoning-end", "id": "reasoning-0" },
  { "type": "reasoning-start", "id": "reasoning-1" },
  { "type": "reasoning-delta", "id": "reasoning-1", "text": "a good understanding of" },
  { "type": "reasoning-end", "id": "reasoning-1" }
]
```

现有窄测：

```text
bun test test/session/llm.test.ts \
  -t "creates stable block ids when AI SDK omits them" --timeout 90000

1 pass, 0 fail
```

该测试只覆盖一个匿名 reasoning block 的 ID 稳定性，没有覆盖连续 triple，也没有断言最终
Session part 数量。

重要限制：AI SDK 6.0.168 的公开 V3 `reasoning-start/delta/end` 类型都要求 `id: string`。
上述匿名输入忠实复现 Issue 提出的 fallback 路径，但它是运行时防御输入，不足以证明实际
provider 正在省略 ID。真实 provider 级复现仍缺 Issue 中未提供的信息。

### 1.4 出错代码路径

```text
provider stream
  → ai@6.0.168 streamText().fullStream
  → packages/opencode/src/session/llm/ai-sdk.ts
      currentReasoningID() 为匿名 block 分配 ID
      reasoning-end 立即发出并清 currentReasoningID
  → packages/opencode/src/session/processor.ts
      reasoning-start 按 LLM block ID 创建新 PartID
      reasoning-end 设置 time.end 并从 reasoningMap 删除 active part
  → packages/tui/src/routes/session/index.tsx
      AssistantMessage 逐 part 渲染 ReasoningPart
      ReasoningPart 逐个渲染 ReasoningHeader("Thought", duration)
```

当前基线关键位置：

- `packages/opencode/src/session/llm/ai-sdk.ts:74-76,179-209`；
- `packages/opencode/src/session/processor.ts:229-236,300-335`；
- `packages/tui/src/routes/session/index.tsx:1480-1494,1572-1677`；
- 测试缺口：`packages/opencode/test/session/llm.test.ts:489-503`。

### 1.5 预期行为与实际行为

- 预期：同一个逻辑 reasoning block 的 N 个 token delta 形成一个持久化 part、一个连续文本和
  一个 `Thought` header；真正不同的 reasoning block 仍保持分离。
- 实际：当前链路忠实地把每个 AI SDK start/end block 映射为一个持久化 part，因此 provider
  若把 token chunk 错当 block，TUI 也逐 token 显示 header。

## 二、根因分析

### 2.1 直接症状

`currentReasoningID` 在匿名 `reasoning-end` 后失去当前 ID，下一次匿名 start 分配递增 ID；
processor 又把每次 start/end 当成独立生命周期。这解释了 Issue 中观察到的多个 part。

### 2.2 已确认根因机制

问题不是 TUI 单独重复 header，而是 block/chunk 语义在进入 Session 前已经碎片化：

```text
一个 provider token chunk
  = 一个 AI SDK reasoning block
  = 一个 LLMEvent reasoning 生命周期
  = 一个持久化 Session reasoning part
  = 一个 TUI Thought
```

adapter、processor 和 TUI 各自按输入契约做了机械映射；首个需要纠正的位置取决于真实输入：

- **不同显式 ID**：provider 明确宣称它们是不同逻辑 block。首个差异位于 provider SDK 的
  stream construction；应优先在 provider 层修复。
- **相同显式 ID 被反复 start/end，或运行时缺少 ID**：provider 的生命周期不满足 AI SDK
  block 约定。opencode 可以选择在 adapter 做受限兼容归一化，但必须有一事件 lookahead，
  不能只改 ID 分配。

### 2.3 为什么 Issue 建议的单行修改不够

仅删除 `state.currentReasoningID = undefined` 不会合并 part：

1. adapter 仍为每个 triple 发出 `reasoning-end` 和下一次 `reasoning-start`；
2. processor 在 end 时设置 `time.end` 并删除 `reasoningMap[id]`；
3. 下一次 start 即使沿用相同 ID，也会创建新的 `PartID`；
4. TUI 仍收到两个 part，仍显示两个 `Thought`。

而且让 ID 跨真正的 text/tool/block 边界泄漏，会把本应分离的 reasoning 错误归为同一身份。
因此该单行改动既不能消除症状，也会削弱 block 生命周期不变量。

### 2.4 证据

- 合成事件流已通过真实 `LLMAISDK.toLLMEvents()` 复现递增 reasoning ID。
- `SessionProcessor.finishReasoning()` 在每个 end 后完成并移除 active part；相同 LLM ID 也不会
  自动复用已完成的 `PartID`。
- TUI 的 `AssistantMessage` 对 `props.parts` 做一对一渲染，`ReasoningPart` 对每个 part 构造
  独立 duration/header。
- `ai@6.0.168` 和 `@ai-sdk/provider` V3 类型把 `id` 定义为必填，并按 ID 维护 active
  reasoning part。
- `@ai-sdk/openai-compatible@2.0.56` 的参考实现收到多个 raw `reasoning_content` chunk 时，
  使用 `isActiveReasoning`：只发一次 start、对每个 chunk 发 delta，并在 text/tool/flush 才发
  end。
- 仓库 native LLM `Lifecycle.reasoningDelta()` 同样只在 ID 未 active 时发 start，并在明确
  `reasoningEnd()` 时关闭。
- 上游 `anomalyco/opencode` 最新 `dev` 的同一 adapter 截至 2026-08-05 仍保留相同行为；该文件
  最近相关提交为 `ae92f3158f2c`（2026-06-01）和初始 adapter `dbe36851bc83`
  （2026-05-18），没有现成上游修复可移植。

### 2.5 workaround 与同类风险

- TUI 可以在显示层把相邻 reasoning part 拼成一个 header，但持久化、回放和其他 consumer
  仍然碎片化；它只是 UI workaround，不是首选根因修复。
- processor 可以无条件合并相邻 reasoning part，但这会擦除显式不同 ID、签名和加密状态的
  合法 block 边界；当前证据不足以证明安全。
- text adapter 使用相同的 `currentTextID` fallback 模式。若某 provider 对 text 也逐 token
  发 anonymous start/delta/end，可能产生同类碎片；回归矩阵需要举一反三，但本 Issue 不应
  未经复现扩大代码范围。
- provider metadata 可能只在 reasoning end 携带。任何合并方案若吞掉中间 end，必须先证明
  metadata 不丢失或定义可判定的转移规则。

## 三、参考实现对照

同一逻辑输入是两个连续 raw reasoning token chunk `r1`、`r2`，随后出现 text/tool/stream
结束边界：

| 步骤 | 输入 / 状态               | Issue 所述 provider/fullStream       | 参考实现                           | 首个差异                   |
| ---- | ------------------------- | ------------------------------------ | ---------------------------------- | -------------------------- |
| 1    | `r1`，reasoning inactive  | start(id0), delta(r1), end(id0)      | start(id0), delta(r1)，保持 active | 是：过早 end               |
| 2    | `r2`，逻辑 reasoning 连续 | start(id1/匿名), delta(r2), end(id1) | delta(id0, r2)，仍保持 active      | 否，差异由步骤 1 传递      |
| 3    | text/tool/flush           | reasoning 已关闭                     | end(id0)                           | 否，参考实现在真实边界关闭 |
| 4    | opencode adapter          | 一对一映射两个 block                 | 一对一映射一个 block               | 否，差异从输入传递         |
| 5    | Session/TUI               | 两个 part/header                     | 一个 part/header                   | 否，差异从输入传递         |

参考实现来源：

- `node_modules/.bun/@ai-sdk+openai-compatible@2.0.56.../openai-compatible-chat-language-model.ts`
  的 `isActiveReasoning` 流程；
- `packages/llm/src/protocols/utils/lifecycle.ts` 的 `reasoningStart()`、
  `reasoningDelta()`、`reasoningEnd()`。

结论：如果真实事件使用不同显式 ID，算法首差异在 provider；如果真实事件缺 ID 或复用同一
ID，则可在 opencode adapter 增加兼容状态机，但仍需把“过早 end”延迟到可判定边界。

## 四、修复方案

### 4.1 证据门禁（两种方案共同前置）

从报告者环境捕获一段脱敏 `fullStream`，至少保留：

```ts
{
  type: string
  id?: string
  hasProviderMetadata: boolean
}
```

同时记录 provider npm 包与版本、模型、相邻 triple 之间是否出现 `raw` 或其他事件。不要记录
reasoning 文本、签名值、API key 或请求内容。

### 4.2 方案 A：修 provider 的 block 生命周期（不同显式 ID 时推荐）

- 修改位置：产生 AI SDK reasoning stream part 的 provider 包；确切文件待 provider 身份确认。
- 具体改动：对连续 raw reasoning token 维持一个 active ID；第一个 token 发 start，每个 token
  只发 delta，在 text、tool、step finish 或 stream flush 时发 end。
- 根因如何被消除：在 chunk 被错误提升为 block 的首个位置修正，opencode adapter、processor
  和 TUI 无需猜测 provider 的语义。
- 兼容性：保留真正不同 block 的显式 ID、顺序、签名和 metadata。
- 若 provider 是外部依赖：向对应 provider 提交修复，并在本仓库按可接受策略升级/约束版本；
  是否增加本地兼容层需单独确认。

### 4.3 方案 B：adapter 受限归一化（匿名或同 ID 重复 triple 时推荐）

- 修改位置：`packages/opencode/src/session/llm/ai-sdk.ts` 的 adapter state 与 reasoning cases。
- 具体改动：
  1. 增加一个待提交的 reasoning end 状态，不立即向下游发出可合并的 end；
  2. 下一事件若是匿名 start 且前一 block 也匿名，或显式 start ID 与待结束 ID 相同，则吞掉
     中间 end/start，沿用同一 ID；
  3. 下一事件若建立真实边界，先发 pending end，再按原顺序映射该事件；
  4. `finish-step` / `finish` / terminal reset 前必须 flush pending end；
  5. `raw` 是否作为透明事件、metadata 如何保留，按真实 trace 写成显式规则后才实施；
  6. 显式不同 ID 永不合并。
- 根因如何被消除：adapter 把违反/弱化 AI SDK block contract 的相邻 token triples 归一为一个
  完整 LLM reasoning 生命周期，下游自然只创建一个 part。
- 不修改：Session processor、TUI renderer、LLMEvent schema。

函数规约（方案 B）：

```text
函数：toLLMEvents(state, event)

数据结构：PendingReasoningEnd（adapter 私有）
字段：
  - id: string — 尚未向下游提交 end 的 LLM block ID
  - provenance: "anonymous" | "explicit" — ID 来源
  - providerMetadata: ProviderMetadata | undefined — end metadata
生命周期：reasoning-end 创建；可合并 start 消费；真实边界或 stream terminal flush 后删除

Requires:
  - event 按 fullStream 到达顺序逐个传入
  - 显式不同 ID 表示不同逻辑 block
Ensures:
  - 所有 reasoning delta 文本按输入顺序恰好输出一次
  - 显式不同 ID 的 start/end 边界按顺序保留
  - 可合并的匿名或同 ID 相邻 triple 输出恰好一个 start 和一个最终 end
  - 任何 text/tool/step/finish 语义边界前，pending reasoning end 已输出
  - finish/reset 后不存在 current 或 pending reasoning 状态
Invariants:
  - 下游可见的每个 reasoning-delta 都位于同 ID 的 start 与 end 之间
  - 同一时刻每个 adapter state 至多有一个匿名 current/pending reasoning block
副作用：更新调用方持有的 adapter state；不执行 I/O
```

### 4.4 不采用的方案

- **只删除 `currentReasoningID` reset**：不能减少持久化 part，且会跨真实边界泄漏 ID。
- **processor 无条件合并相邻 reasoning**：无法区分合法的不同显式 block，并可能破坏签名/
  encrypted metadata。
- **TUI-only grouping**：可作为临时缓解，但不修复持久化与回放；除非产品明确只要求视觉聚合，
  否则不作为本轮首选。

### 4.5 最小复现走修正后逻辑

- 方案 A：provider 输出 `start(r0), delta(r1), delta(r2), end(r0)`；adapter 一对一映射；
  processor 创建并完成一个 part；TUI 显示一个 `Thought`。
- 方案 B：第一个匿名 end 暂存；紧随的匿名 start 与它合并；两个 delta 都使用同一 synthetic
  ID；最终真实边界 flush 一个 end；processor/TUI 结果同上。

## 五、正确性论证

- 根因消除：两种方案都修正在“token chunk 被切成 block”的边界，而不是隐藏多个 header。
  方案 A 修首个产生点；方案 B 只在身份相同或缺失、且相邻可判定时归一化。
- 不变量保持：
  - reasoning delta 顺序、文本和至多一次交付保持；
  - 不跨 text/tool/step/finish 合并；
  - 显式不同 ID 不合并；
  - 每个下游 reasoning 生命周期 start/end 配对；
  - adapter 在 final finish 后仍完整 reset，可安全复用；
  - provider metadata 规则未确认前不实施，避免静默丢失签名状态。
- 无回归引入：测试同时锁定应合并与不得合并两类输入，并增加 Session processor 集成断言；
  运行完整 adapter、processor 相关测试和 package typecheck。
- Trivial 判定：不适用。修复涉及 streaming lookahead、block ID、metadata、终态 flush 和持久化
  part 数量，是状态机/跨度行为变更。

## 六、测试用例清单

| 类型     | 用例描述                                                                                         | 状态（修复后回填）                 |
| -------- | ------------------------------------------------------------------------------------------------ | ---------------------------------- |
| 回归     | Issue 最小输入：两个连续可合并 reasoning triple 最终只产生一个完整 LLM block                     | 待加；等待方案确认                 |
| 回归     | 经真实 SessionProcessor 后只持久化一个 reasoning part，文本为两个 delta 串接且只有一个 time span | 待加；等待方案确认                 |
| 新增     | 显式不同 ID 的相邻 reasoning block 保持两个 block/part                                           | 待加；等待方案确认                 |
| 新增     | text、tool、step-finish、finish 前正确 flush pending reasoning end，事件顺序不变                 | 待加；仅方案 B                     |
| 新增     | providerMetadata 出现在 start/delta/end 时不丢失；精确矩阵等待真实 trace 决定                    | 待定义；证据门禁                   |
| 新增     | adapter state 在 finish 后复用，从 `reasoning-0` 且无 pending state 开始                         | 待扩充；仅方案 B                   |
| 举一反三 | 匿名 text per-token triple 是否同样碎片化                                                        | 仅审计；无真实报告时不扩大实现范围 |
| 既有     | `test/session/llm.test.ts` adapter suite                                                         | 待运行                             |
| 既有     | `test/session/processor-effect.test.ts` 相关 suite                                               | 待运行                             |
| 静态     | `packages/opencode` 的 `bun typecheck`                                                           | 待运行                             |

## 七、代码更新清单

下表是条件清单；证据门禁后删除未选择的分支并把选中项细化到最终函数。

| 文件                                                      | 函数 / 行号                        | 改动概述                                            | 状态（修复后回填）        |
| --------------------------------------------------------- | ---------------------------------- | --------------------------------------------------- | ------------------------- |
| provider 包路径待确认                                     | reasoning stream transform         | 方案 A：连续 token 使用一个 active block 生命周期   | 条件项；待 provider trace |
| `packages/opencode/src/session/llm/ai-sdk.ts`             | `adapterState()` / `toLLMEvents()` | 方案 B：pending end + 受限相邻合并 + terminal flush | 条件项；待确认            |
| `packages/opencode/test/session/llm.test.ts`              | AI SDK adapter tests               | 固化最小回归与不得合并/flush/metadata 边界          | 待加；等待确认            |
| `packages/opencode/test/session/processor-effect.test.ts` | reasoning persistence scenario     | 验证最终 part 数量、串接文本和 span                 | 待加；等待确认            |

明确不计划修改 `packages/tui/src/routes/session/index.tsx` 和
`packages/opencode/src/session/processor.ts`，除非证据推翻上述分层判断并重新经过确认。

## 八、文档更新清单

| 文档路径                                                | 要改什么                                                 | 状态（修复后回填） |
| ------------------------------------------------------- | -------------------------------------------------------- | ------------------ |
| `docs/fixes/session-fix-fragmented-reasoning-blocks.md` | 回填 provider trace、最终分支、红灯、实现、验证和 commit | 待回填             |

既有 schema、公开接口和用户配置暂不改变。若最终方案需要重新定义“不同显式 ID 是否允许合并”
或 provider metadata 的跨 block 合并语义，则属于契约变更：必须先返回设计流程补充契约与审核
产物，不能直接按本修复计划编码。
