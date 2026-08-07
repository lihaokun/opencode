# 修正方案 — `session: fragmented reasoning blocks`

- 状态：首轮修复已证实不完整；2026-08-07 已完成根因补证与方案修订，补修代码尚未实施
- 分析日期：2026-08-05
- 补证日期：2026-08-05
- consumer 合同复审日期：2026-08-05
- 首轮实现与审计日期：2026-08-05
- 失败复盘与方案修订日期：2026-08-07
- 对应问题：[Issue #8](https://github.com/lihaokun/opencode/issues/8)
- Reporter 补证：[`issuecomment-5189552479`](https://github.com/lihaokun/opencode/issues/8#issuecomment-5189552479)
- Issue 最新补充分析与实测方案（collaborator `yixiao5428`）：
  [`issuecomment-5210940023`](https://github.com/lihaokun/opencode/issues/8#issuecomment-5210940023)
- 分析基线：`49fa19830d`
- 补修前生产代码审计基线：`64e676ac45`（`yixiao-issue-8`）
- 本轮文档复审基线：`bb5e07ca01`
- 影响模块：OpenAI-compatible provider、AI SDK LLM adapter、Session processor 及所有 PartUpdated consumers
- 首轮本地修复层：仅对 `@ai-sdk/openai-compatible` 启用 adapter pending-end 生命周期规范化；
  该框架保留并继续覆盖已复现的 content bridge，但它的 `txt-0` 前提不能覆盖真实空数组输入
- 修订后推荐范围：使用仓库现有 `patchedDependencies` 机制修正锁定 provider parser 的空数组判断，
  只让非空 `tool_calls` 结束 reasoning；保留首轮 adapter 代码，不再放宽 same-ID 合并条件
- 实现门禁记录：首轮依次提交真实 HTTP 红测 `af9463c6dd`、生产修复 `1c670a4a98`、边界测试
  `ab333813c3` 与 incomplete-stream 补证 `d13dcd5125`；这些提交只证明首轮假设覆盖的
  reasoning/content 交错，不证明真实 `tool_calls: []` 输入已经修复

## 一、现象与复现

### 1.1 现象

真实 GLM-5.2 流在每个 `reasoning_content` chunk 上同时携带 `tool_calls: []`。锁定 AI SDK provider
把这个空数组误判为 tool-call 边界，于是每个 chunk 都变成独立的
`reasoning-start → reasoning-delta → reasoning-end` triple；opencode 再把每个 triple 持久化成独立
`reasoning` part。TUI 对每个 part 渲染一个带时长的 `Thought` header，因而出现 Issue 所示的大量
毫秒级思考块。

reasoning/content 交错是 2026-08-05 独立构造并复现的另一种 producer 序列，也是首轮 adapter
workaround 的覆盖对象；它不是最新现场所证实的主要触发输入，不能再用来替代空数组根因。

首轮修复上线后，用户确认使用 `yixiao-issue-8` 当前分支最新代码自行编译，问题仍然出现；最新
现场数据为单条 assistant message 包含 596–1409 个 reasoning parts，每个 part 只有 1–3 token，
相邻 part 的 end/start 约相差 2 ms。该反馈直接否定“首轮修复已解决 Issue”的状态结论。

### 1.2 触发条件

Issue 现场证据及本地复现与其对齐的关键项（来源在 2.5 节分级）：

- OpenCode：`49fa19830d427b0ec59db255fb12d95542b4f7c8`；
- provider：`@ai-sdk/openai-compatible@2.0.41`；
- AI SDK：`ai@6.0.168`；
- 模型：自定义 OpenAI-compatible `/v1/chat/completions` endpoint 上的 `glm52`；
- 运行时日志：`llm.runtime=ai-sdk, llm.provider=Test-GLM5, llm.model=glm52`，确认走 V1 AI SDK
  adapter，不是 V2 native runtime；
- 最新 collaborator comment 记录的现场 wire shape：每个 `reasoning_content` chunk 同时携带
  `tool_calls: []`；本地没有访问 Reporter endpoint，但已用相同 SSE shape 经锁定依赖链独立复现。

修复前缺陷在满足以下条件时必现：

1. 请求走 `streamText(...).fullStream → LLMAISDK.toLLMEvents()` 的 AI SDK 路径；
2. provider 的 reasoning chunk 携带空数组 `tool_calls: []`；
3. `@ai-sdk/openai-compatible@2.0.41` 以 `delta.tool_calls != null` 判断是否进入 tool-call 分支，
   因而把空数组误当成 tool-call 边界并在每个 chunk 后结束 reasoning；
4. 所有 reasoning 生命周期复用该 package 硬编码的显式 ID `reasoning-0`；
5. reasoning 事件不含 `providerMetadata`；这也是 2.0.41 源码生成该三类事件时的固定形状；
6. 相邻 `reasoning-end → reasoning-start` 之间没有 text 或真实 tool event；
7. 若要观察 Issue 所述可见症状，TUI 需显示 reasoning part；持久化碎片本身不依赖 TUI。

原始 Reporter 早期样本重复 34 次；最新 collaborator comment 记录的数据库样本为 596–1409 个
parts。满足上述条件时，每个
reasoning chunk 都被 parser 结束并立即在下一 chunk 重开，结果由状态机决定，不是概率问题。

### 1.3 最小复现

#### 1.3.1 首轮复现：reasoning/content 交错

2026-08-05 使用真实 `@ai-sdk/openai-compatible@2.0.41`、真实 `ai@6.0.168 streamText()`
和本地假 SSE endpoint 复现。假 endpoint 依次返回：

```text
delta.reasoning_content = "reason-1"
delta.content           = "text-1"
delta.reasoning_content = "reason-2"
delta.content           = "text-2"
finish_reason           = "stop"
[DONE]
```

从 `result.fullStream` 采集到的实际 AI SDK 事件顺序是：

```text
start
start-step
reasoning-start  id="reasoning-0"  metadata=false
reasoning-delta  id="reasoning-0"  text="reason-1"  metadata=false
reasoning-end    id="reasoning-0"  metadata=false
text-start       id="txt-0"        metadata=false
text-delta       id="txt-0"        text="text-1"    metadata=false
reasoning-start  id="reasoning-0"  metadata=false
reasoning-delta  id="reasoning-0"  text="reason-2"  metadata=false
reasoning-end    id="reasoning-0"  metadata=false
text-delta       id="txt-0"        text="text-2"    metadata=false
text-end         id="txt-0"        metadata=false
finish-step
finish
```

其中 `start` 会被 adapter 丢弃，`start-step` / `finish-step` 会分别映射成 LLMEvent
`step-start` / `step-finish`。这项实证校正了 Reporter 从持久化 part 表反推的一处细节：text block
只 start/end 一次；两个 reasoning 生命周期之间是同一 active `txt-0` 的 delta，不是每次都有
完整的 text triple。该差异
不改变 reasoning 碎片结论，但决定了 adapter normalization 必须允许同 ID reasoning 跨 text
delta 继续同一个下游 lifecycle。

把上述 `fullStream` 映射成 processor 输入后，修复前基线执行：

```text
reasoning-start(r0) → 创建 PartID=P1
reasoning-end(r0)   → 完成 P1，删除 active r0
reasoning-start(r0) → 创建 PartID=P2
reasoning-end(r0)   → 完成 P2
```

最终 reasoning parts 为 `P1(text="reason-1")` 与 `P2(text="reason-2")`，TUI 显示两个
`Thought`。Reporter 的 34 次交替是同一最小状态转移的重复。

修复前已有窄测：

```text
bun test test/session/llm.test.ts \
  -t "creates stable block ids when AI SDK omits them" --timeout 90000

1 pass, 0 fail
```

该测试只覆盖一个匿名 reasoning block 的 adapter ID 稳定性，不覆盖本 Issue：真实事件始终带
显式 `reasoning-0`，adapter 也正确保留该 ID。测试缺口位于“已知存在该 quirk 的 provider 在同
step 内 end/reopen 相同 ID 时，adapter 是否先规范化成单一 LLMEvent lifecycle”。

这份复现证明了 pending-end 规范化的方向可行，但它包含 `txt-0` bridge，不能代表用户真实的
空 `tool_calls` 输入。首轮把 bridge 从“已观察到的一种输入”错误提升为“允许合并的必要条件”。

#### 1.3.2 最新根因复现：reasoning 与空 `tool_calls`

2026-08-07 使用真实 `@ai-sdk/openai-compatible@2.0.41`、真实 `ai@6.0.168 streamText()` 与假
`fetch` 返回以下 SSE 形状：

```text
delta.reasoning_content = "r1", delta.tool_calls = []
delta.reasoning_content = "r2", delta.tool_calls = []
delta.content           = "done"
finish_reason           = "stop"
[DONE]
```

锁定依赖的原始 `fullStream` 实际输出：

```text
start → start-step
reasoning-start(r0) → reasoning-delta(r0,"r1") → reasoning-end(r0)
reasoning-start(r0) → reasoning-delta(r0,"r2") → reasoning-end(r0)
text-start(t0) → text-delta(t0,"done") → text-end(t0)
finish-step → finish
```

把同一输出交给当前 `LLMAISDK.toLLMEvents()` 且打开 compatible gate，仍得到两次
`reasoning-start` 和两次 `reasoning-end`。原因是 pending 创建后没有 text event 可绑定
`pendingReasoningEnd.textID`；下一次 same-ID start 会先 drain pending，再按新 lifecycle 转发。
当前 adapter 测试 `does not coalesce an empty end-to-start gap or a different text id` 把一个脱离
provider 原因的显式 end/start 视为两个 lifecycle。该边界本身没有被空数组语义证伪；真正缺失的是
位于它上游、能证明空数组不应产生这组 end/start 的真实 parser 回归。

### 1.4 出错代码路径

```text
custom OpenAI-compatible SSE
  → @ai-sdk/openai-compatible@2.0.41
      reasoning_content: start/delta(reasoning-0)
      tool_calls: []: `!= null` 分支错误地 end(reasoning-0)，但不产生任何 tool event
      next reasoning_content: 立即 reopen/delta(reasoning-0)
  → ai@6.0.168 streamText().fullStream
  → packages/opencode/src/session/llm/ai-sdk.ts
      首轮 `textID` 条件不匹配，drain pending 后仍输出重复的 reasoning-0 生命周期
  → packages/opencode/src/session/processor.ts
      reasoning-start 按 LLM block ID 创建新 PartID
      reasoning-end 设置 time.end 并从 reasoningMap 删除 active part
  → packages/tui/src/routes/session/index.tsx
      AssistantMessage 逐 part 渲染 ReasoningPart
      ReasoningPart 逐个渲染 ReasoningHeader("Thought", duration)
```

分析基线关键位置：

- `node_modules/.bun/@ai-sdk+openai-compatible@2.0.41+d6123d32214422cb/node_modules/`
  `@ai-sdk/openai-compatible/dist/index.js:725-766,863-870`；
- `packages/opencode/src/session/llm/ai-sdk.ts:10-56,350-447`；
- `packages/opencode/src/session/llm.ts:227-283,360-389`；
- `packages/opencode/src/session/processor.ts:229-236,300-335`；
- `packages/opencode/src/session/processor.ts:701-754`（retry attempt reset 与最终 cleanup）；
- `packages/tui/src/routes/session/index.tsx:1480-1494,1572-1677`；
- 合成空间隔边界测试：`packages/opencode/test/session/llm.test.ts:292-317`。

现场 TUI 调用链确认为 V1 Session 路径。最新 Issue comment 把请求写成
`POST /session/{sessionID}/prompt_async`，但当前仓库 `sdk.client.session.prompt()` 实际调用
`POST /session/{sessionID}/message`；两者都不会把该请求导向 V2 native runtime，因此这处端点名误差
不影响已由 runtime 日志确认的 AI SDK 根因。

### 1.5 预期行为与实际行为

- 空数组根因的预期：锁定 provider 遇到 `tool_calls: []` 时不得结束 active reasoning；N 个连续
  reasoning chunks 在 `fullStream` 层就应是一个 start、N 个 delta，直到 content、非空 tool 或 flush
  才出现唯一 end。
- 首轮独立行为的预期：已经复现的 `txt-0` content bridge 继续由当前 gated adapter 规范化；显式且
  脱离该 producer 证据的空 end/start、其他 provider、匿名/不同 ID、metadata 与真实 barrier 仍保持
  当前边界，不借本补修扩大合并范围。
- 当前分支实际：首轮 adapter 只合并经过 `txt-0` bridge 的 reopen。空 `tool_calls` 造成的空间隔会
  被 drain 为真实 end/start，processor 为每段分配新 PartID，TUI 继续逐 part 显示 header。

## 二、根因分析

### 2.1 直接症状

同一 provider step 中的所有 reasoning 事件都携带显式 ID `reasoning-0`，但
`SessionProcessor.finishReasoning()` 在每个 end 后删除 `ctx.reasoningMap["reasoning-0"]`。
下一次同 ID start 因而被当成从未见过的 block，获得新的持久化 PartID。

### 2.2 已确认根因机制

根因是 provider 层与下游生命周期契约不匹配，以及首轮本地兼容条件建立在不完整输入样本上：

1. GLM-5.2 的每个 reasoning SSE chunk 都携带 `tool_calls: []`。
   `@ai-sdk/openai-compatible@2.0.41` 使用 `delta.tool_calls != null`，所以空数组也进入该分支：
   parser 先合成 `reasoning-end("reasoning-0")`，但 `for (const ... of [])` 不产生任何 tool event；
   下一个 reasoning chunk 又用硬编码 ID `reasoning-0` 重新 start。
2. LLMEvent/processor/CLI 的既有约定把 `reasoning-end` 当作终态。仓库的
   `Lifecycle.reasoningEnd()` 会把 ID 从 active set 删除，processor 会写入 `time.end` 并删除 active
   mapping，CLI streaming consumer 也会在 `time.end` 出现后把 PartID 标为完成。
3. 因而 processor 为重新 start 的 lifecycle 创建新 PartID 是对当前 end 语义的一致解释，不是
   可以孤立修改的 map bug。修复必须在伪 end 进入公共 LLMEvent/PartUpdated 合同前完成；对已确认
   的空数组根因，最窄位置就是产生该 end 的 provider parser。
4. 首轮兼容已经暂存 end，却要求 pending 必须先绑定 `txt-0` 才允许 same-ID reopen 合并。真实
   `tool_calls: []` 序列在 end/reopen 之间没有 text event，故 `textID` 始终是 `undefined`，每次 reopen
   都先 drain end。首轮 adapter 是 content-bridge 的有效 workaround，但没有覆盖这条真实序列；
   直接修 parser 可消除伪事件，也无需放宽 adapter 对任意显式空 end/start 的解释。

TUI 不是根因，只是一对一呈现已经碎片化的持久化 parts：

```text
GLM-5.2 reasoning_content + tool_calls: []
  → provider parser 在每个 chunk 后反复 end/reopen 同一 reasoning-0
  → adapter 忠实保留显式 reasoning-0
  → processor 按终态契约为 reopen 分配新 PartID
  → Session 中出现 P1, P2, ... PN
  → TUI 显示 N 个 Thought
```

从“首个产生异常生命周期”的角度，`@ai-sdk/openai-compatible` 的空 `tool_calls` 判断是已确认
根因。仓库已有 `patchedDependencies`，并正在维护其他 AI SDK provider patch，因此可以在该产生点
作可复现的本地修复；不必为了这个精确根因继续扩大 adapter 合并条件。processor 之后的状态已经
被持久化并发布给 consumer，届时再撤销 end 仍会改变公共事件语义，所以 processor/TUI 不是正确
修复层。

### 2.3 `ai-sdk.ts` ID reset 不是本次因果点

`currentReasoningID(state, event.id)` 总是优先采用显式 `event.id`。本次所有 start/delta/end 都
传入 `reasoning-0`，因此 `state.currentReasoningID = undefined` 后下一事件仍恢复为
`reasoning-0`，没有分配 `reasoning-1`。

仅删除该 reset 也不会减少 part：adapter 仍发出每个 end/start，processor 仍按终态合同创建新
PartID。保留 reset 还能避免匿名 ID 跨真正边界泄漏；本方案不改变该 fallback 行为。

### 2.4 为什么否决 processor-only reopen

Reporter 建议保留 map entry 的方向抓住了“希望复用 PartID”的结果，但不能按字面实现：

1. 第一次 end 已给 part 设置 `time.end`；
2. 如果 entry 不删除，下一次 start 会命中 `if (value.id in ctx.reasoningMap) return`；
3. start 被忽略，没有清除 `time.end`；
4. 后续 delta 会追加到仍被 TUI 判为 completed 的 part；
5. active 与 completed 两种生命周期状态被混在同一 map 中。

前一版方案把 completed part 移入 candidate，并在 reopen 时发布同 PartID 的
`time.end: number → undefined`。全文 consumer 审计证明这也不成立：

- TUI 的 reactive store 可以接收完整 part replacement，因此视觉上能重新变成 `Thinking`；
- legacy `opencode run --thinking` 在每次带 end 的 PartUpdated 上输出完整 reasoning，最终 end 会
  再次输出累计文本，存在重复输出；
- `run/session-data.ts` 在首次 end 后把 PartID 放进 `data.ids` 并丢弃增量状态，后续同 PartID 的
  reopen update/delta 会被忽略，存在文本丢失；
- share、SDK event stream 与外部 consumer 同样会观察到一个此前没有定义过的“终态撤销”。

所以 processor-only reopen 并非最小内部修改，而是 PartUpdated 生命周期合同变更。若选择该路，
必须进入契约设计并同步全部内外部 consumer；本 Issue 不采用。

### 2.5 证据

- 原始 Reporter `ssyram` 给出 commit、provider 版本、模型、相同 ID、metadata 缺失和 34 次重复
  次数；collaborator `yixiao5428` 的最新 comment 另行记录 runtime 日志、现场 SSE 片段、596–1409
  个持久化 parts，以及候选 adapter 补修在真实 endpoint 上的 63/63 与 1/1 start/end 对比。两者
  来源不同，不能合并称为 Reporter 证据。
- 本地假 SSE 经真实 `@ai-sdk/openai-compatible@2.0.41 → ai@6.0.168 fullStream` 得到同样的
  reasoning end/reopen 序列：2026-08-05 的 content-bridge 复现校正 text 事件顺序；2026-08-07
  的空 `tool_calls` 复现则直接证明当前首轮 adapter 仍输出两套 reasoning lifecycle。
- 锁定 provider 源码的精确条件是 `delta.tool_calls != null`；`[]` 满足条件，先结束 active reasoning，
  随后的空循环不产生 tool event。该 producer 的 reasoning 事件只写入 `type`、`id` 和 delta 文本，
  不写 `providerMetadata`。
- [npm 版本列表](https://www.npmjs.com/package/@ai-sdk/openai-compatible?activeTab=versions) 显示
  `ai-v6` 标签为 `@ai-sdk/openai-compatible@2.0.62`（overall `latest` 已是 3.x；本仓库仍锁定
  AI SDK v6），对应 commit
  `da5fbd2703c54dfbaea7ec725757da5b121beef0` 仍保留同一逻辑，因此单纯从 2.0.41 升级不能
  消除此问题。
- adapter 对显式 ID 做无损映射；本次没有经过匿名 ID fallback。
- `SessionProcessor.finishReasoning()` 设置 end、更新 part 后删除 active mapping；下一次同 ID
  start 必然调用 `PartID.ascending()`。
- processor 在每次 retry attempt 开始时重置 `reasoningMap`，最终 cleanup 位于整个 retry 之后；这
  证明 pending end 必须在 retryable failure 重新抛出前交付，不能只依赖最终 cleanup。
- `packages/llm/src/protocols/utils/lifecycle.ts` 的 reference lifecycle 在 end 时从 active set 删除
  reasoning ID，支持“end 是终态”的现有解释。
- `run.ts` 与 `run/session-data.ts` 的机械检查证明 `time.end` 被 consumer 当作终态，排除了无审计
  的 end retraction。
- 当前 text 路径证明 `txt-0` 在真实复现中只 start 一次、在 stream flush 才 end；它不能反证
  reasoning-end 的终态语义。
- native OpenAI Chat parser 对相同概念使用 `if (toolDeltas.length)` 才结束 reasoning，说明
  “只有非空 tool-call delta 才构成 tool barrier”是仓库内可对照的正确语义；但 runtime 日志证明
  本用户没有走 native parser。
- TUI 对 `props.parts` 一对一渲染，无法恢复已丢失的 LLM block ID。
- 上游 `anomalyco/opencode` 的 `dev@4a57013cf8cb163f58638273fd9da8538cd33cb7` 截至
  2026-08-05 没有现成 adapter 或 processor 修复可移植：
  [`4a57013`](https://github.com/anomalyco/opencode/commit/4a57013cf8cb163f58638273fd9da8538cd33cb7)。

证据等级必须保持分离：

- **直接观察**：本地锁定依赖源码、两类假 SSE 输入、真实 dependency-chain 的 fullStream 输出、
  当前 adapter/processor/consumer 代码、现有合成空间隔边界测试与独立复跑结果；
- **原始 Reporter 现场证据**：版本、模型、由 part 表重建的 34 段事件与持久化碎片；其早期
  content/text 顺序不是原始 wire 抓包；
- **最新 collaborator comment 证据**：runtime 日志、现场 SSE 片段、596–1409 个持久化 parts，
  以及候选 adapter 补修前后的 63/63 与 1/1 事件计数；该候选 patch 尚未出现在共享分支，本文不把
  它的 endpoint/test/typecheck 结果冒充为本地验证；
- **机械推论**：对任意 `reasoning_content + tool_calls: []` chunk，锁定 parser 必然输出 end；当前
  `textID` gate 必然 drain pending，processor 必然创建多个 PartID；
- **产品选择**：把这些 segments 归并为一个 Thought 不是原始 ID 能证明的事实，而是本 Issue 要
  达到的兼容行为；完成时机/duration 取舍已由用户在实现前确认。

### 2.6 首轮 adapter 取舍与修订后风险

在第一次 reasoning-end 到达时，系统无法知道未来是否会 reopen。因此无法同时满足：

1. 普通 provider 的首次 end 立即对 consumer 生效；
2. `time.end` 一旦发布就永不撤销；
3. 不缓冲未来事件且最终只产生一个 part。

首轮 adapter workaround 保留第 2、3 项，明确牺牲受影响 provider 的部分第 1 项：pending end 会延迟到
`text-end`、tool、step 或 finish barrier。其残余风险是普通 `@ai-sdk/openai-compatible`
reasoning→text（之后不 reopen）的 TUI 会在 text streaming 期间继续显示 `Thinking`，duration 也
包含这段等待时间。该行为已作为显式产品取舍接受，并由回归测试固定。

这个不可能三角不适用于本次空数组根因的直接 parser patch：`tool_calls: []` 本来就不是语义边界，
修正判断后不会生成需要预测未来的伪 `reasoning-end`，也不会额外延迟普通 reasoning 的终态。当前
分支因首轮 content-bridge workaround 已经存在上述时机取舍，但本次补修没有必要扩大它。

其他方向及风险：

- TUI-only 聚合不修复数据库、API、回放与其他 consumer，且 TUI 当前没有原始 LLM block ID；
- processor end retraction 会改变公开 PartUpdated 终态合同；
- 无 provider gate 或不限制 package 合成 ID 的 adapter 合并可能影响其他 provider 的 signed/encrypted
  reasoning，或把真正不同的 block 合并；
- 直接 parser patch 需要随锁定依赖升级维护；仓库已有 `patchedDependencies` 和多个 AI SDK patch，
  这个成本存在但不是新机制。patch 只修空数组，不改变 content/reasoning 交错；后者继续由首轮
  adapter workaround 处理；
- text fallback 没有反复 end/reopen 的复现依据，本次不扩大范围。

## 三、参考实现对照

本问题的空数组判断有明确参考语义：仓库 native OpenAI Chat parser 仅在
`toolDeltas.length > 0` 时结束 reasoning。公共生命周期约束同时来自现有 LLMEvent lifecycle 与终态
consumer：`Lifecycle.reasoningEnd()` 删除 active ID，processor 写入 `time.end`，CLI 在 end 后
终结 PartID。因此修复必须在 provider parser/adapter 进入这些合同之前完成，而不是改变终态合同。

首轮 content-bridge workaround 还涉及一项独立产品选择：`reasoning-0` 是 package 对所有 reasoning
硬编码的合成 ID，并非模型提供的语义 block ID；
“同 ID”本身不能数学证明两个 segments 必属同一思考。把该 package 在一个 step、同一 active text
block 两侧产生的 segments 归并，是基于 Issue 的产品预期与已证实 producer 机制所选择的兼容策略，
不是从 ID 唯一推出的事实。因此实现前先由用户确认了完成时机/duration 取舍。

同一输入在三个状态机中的差异如下：

| 步骤 | AI SDK 2.0.41 输出                 | 修复前 adapter / processor         | 首轮 gated adapter / processor         | 首个差异 |
| ---- | ---------------------------------- | --------------------------------- | -------------------------------------- | -------- |
| 1    | `reasoning-start(r0)`              | 转发；创建 active P1              | 转发；创建 active P1                   | 否       |
| 2    | `reasoning-delta(r0, "reason-1")`  | 转发；追加到 P1                   | 转发；追加到 P1                        | 否       |
| 3    | content 前合成 `reasoning-end(r0)` | 转发；完成 P1                     | 暂存 pending end；P1 保持 active       | 是       |
| 4    | `text-start/delta(t0)`             | 创建/更新 text P2                 | 原样转发；创建/更新 text P2            | 由 3     |
| 5    | `reasoning-start(r0)`              | 转发；创建新 P3                   | 消费 pending end 并抑制冗余 start      | 由 3     |
| 6    | `reasoning-delta(r0, "reason-2")`  | 转发；追加到 P3                   | 转发；追加到仍 active 的 P1            | 由 3     |
| 7    | 再次 `reasoning-end(r0)`           | 转发；完成 P3                     | 再次暂存 pending end                   | 由 3     |
| 8    | `text-end(t0)`                     | 完成 P2；已有两个 reasoning parts | 先发唯一 reasoning-end，再发 text-end  | 由 3     |
| 9    | `finish-step/finish`               | 终结 step/turn                    | 终结 step/turn；只有 P1 一个 reasoning | 由 3     |

精确参考来源：

- 锁定依赖 2.0.41 的 `dist/index.js:725-766,863-870` 与等价 ESM 入口
  `dist/index.mjs:712-753`；
- AI SDK v6 维护标签 2.0.62 对应的 Vercel AI commit
  [`da5fbd2`](https://github.com/vercel/ai/blob/da5fbd2703c54dfbaea7ec725757da5b121beef0/packages/openai-compatible/src/chat/openai-compatible-chat-language-model.ts)，
  仍使用 `delta.tool_calls != null`，并在 content 前 end reasoning；
- `packages/llm/src/protocols/utils/lifecycle.ts:27-62` 的 active reasoning lifecycle；
- `packages/opencode/src/cli/cmd/run.ts:715-773` 与
  `packages/opencode/src/cli/cmd/run/session-data.ts:1001-1053` 的终态消费逻辑。

外部 package 的长期理想修复是接受同一空数组判断补丁并发布新 `ai-v6` 版本。当前已检查的 2.0.62
仍没有该修复；在上游发布前，本仓库可用现有 dependency patch 机制固定行为。

上述表格仍是有效的 content-bridge 对照，但不是用户最新现场的根因输入。对空 `tool_calls` 输入，
首个差异发生在 provider parser 的空数组判断；修复不需要等待 adapter 看见伪 end/reopen：

| 步骤 | 未 patch 的 2.0.41 | patch 后 provider 输出 | 当前 adapter / processor |
| ---- | ----------------- | ---------------------- | ------------------------ |
| 1 | `start(r0), delta(r0,"r1")` 后因 `[] != null` 输出 `end(r0)` | `start(r0), delta(r0,"r1")`；空数组不结束 reasoning | start/delta；P1 保持 active |
| 2 | 下一 chunk 再输出 `start(r0), delta(r0,"r2"), end(r0)` | reasoning 已 active，只输出 `delta(r0,"r2")` | delta 继续追加到 P1 |
| 3 | 每个 reasoning chunk 重复一套 lifecycle | N 个 chunk 仍只有一个 start 与 N 个 delta | 不创建额外 PartID |
| 4 | 后续 content/非空 tool/flush 才是真实边界 | 在真实边界输出唯一 `end(r0)` | 首轮 adapter/processor 按既有合同完成 P1 |

仓库 native OpenAI Chat parser 的 `if (toolDeltas.length)` 是本次空数组判断的可信参考：空数组不是
tool-call barrier。它证明外部 parser 的 `!= null` 是直接缺陷，但不意味着用户请求走了 native
runtime。它与锁定 provider 源码的逐行对照共同支持在 V1 provider parser 产生点修复。

## 四、修复方案

### 4.1 修订后推荐方案：维护锁定 provider 的 dependency patch

修改 `@ai-sdk/openai-compatible@2.0.41` 的 parser 判断，但不修改公共 LLMEvent/Session 生命周期：

1. 使用根 `package.json` 已有的 `patchedDependencies` 机制新增
   `patches/@ai-sdk%2Fopenai-compatible@2.0.41.patch`，并同步 `bun.lock`。
2. 在 package source、ESM runtime 入口 `dist/index.mjs` 和 CJS runtime 入口 `dist/index.js` 中，把
   `if (delta.tool_calls != null)` 改为 `if (delta.tool_calls?.length)`（编译产物可使用等价表达式）。
   同时修改两个 runtime 入口，避免测试/开发因 import/require 条件不同而只覆盖一半。
3. `tool_calls: []` 不再结束 active reasoning，也不进入空循环；下一 reasoning chunk 只追加 delta。
   非空 tool-call 数组仍先结束 reasoning，再按原逻辑产生 tool events。
4. content、flush、finish、usage、metadata、tool-call buffering 和错误语义完全保持 2.0.41 原行为。
5. 保留首轮 adapter normalization 及其测试，不在本补修中放宽 same-ID pending 条件或删除
   `textID`。该 adapter 继续只承担已单独复现并确认过的 content-bridge workaround。
6. 向 Vercel AI 报告同一最小复现可作为后续动作，但本地 patch 和回归测试不依赖上游发布时间。

半形式化合同：

```text
Requires:
  - delta.tool_calls 为 null/undefined 或符合 schema 的数组
  - parser 按 reasoning_content → content → tool_calls 的既有顺序处理同一 delta

Ensures:
  - tool_calls.length == 0 时，该分支不改变 isActiveReasoning，不输出 reasoning-end/tool event
  - tool_calls.length > 0 时，输出和状态转换与未 patch 的 2.0.41 完全相同
  - content/flush 产生 reasoning-end 的条件与时机不变
  - 每个 reasoning_content 文本按输入顺序恰好输出一次

Side effects:
  - 仅改变锁定 dependency parser 对空 tool-call 数组的判断
  - 不新增 adapter/processor 状态，不修改 Session、TUI、LLMEvent 或公开配置
```

### 4.2 备选方案数据结构：id-only adapter（本次不采用）

仅当项目明确拒绝 dependency patch 时，才考虑最新 comment 提出的 same-ID adapter 放宽。以下
4.2–4.4 记录该备选方案的完整安全边界；本次不应与 4.1 同时实施，也不列入代码更新清单。

```text
数据结构：ReasoningNormalizationOptions（adapter 私有）

字段：
  - coalesceOpenAICompatibleReasoning: boolean

类型不变量：
  - 由 LLM.streamBatches 根据当前 model.api.npm 在每个 stream 开始时确定
  - 同一个 adapter state 的整个生命周期内不可变

生命周期：
  - 创建：每次 AI SDK stream 创建 adapterState 时
  - 修改：不允许；finish reset 只能重置计数和 active/pending 状态，不能丢失该 flag

跨模块共享性：llm.ts → ai-sdk.ts 的模块私有参数，不进入 schema

数据结构：PendingReasoningEnd（adapter 私有、ephemeral）

字段：
  - id: "reasoning-0" — 必须是该 package 源码合成的显式 reasoning ID

类型不变量：
  - normalization gate === true
  - normalizationDisabled === false
  - normalizationReasoningActive === true（下游已收到对应 reasoning-start）
  - currentReasoningID === id
  - currentTextID === undefined 或 currentTextID === "txt-0"
  - 已观察到的 current reasoning lifecycle 事件 raw providerMetadata 均为 null/undefined
  - 对应 LLMEvent.reasoning-end 尚未发出
  - 同时至多存在一个 pending end

生命周期：
  - 创建：eligible reasoning-end 到达
  - 消费：`reasoning-0`、无 metadata 的 reasoning-start/delta 在任何非 barrier 间隔后证明 package
    lifecycle 被 reopen；间隔可以为空，也可以只含同一 `txt-0` 的 start/delta
  - flush：表 4.3 所列任一 barrier、iterable exhaustion 或 retryable failure
  - 丢弃：不允许静默丢弃；interrupt 时由 processor 最终 cleanup 完成已发出的 active part

跨模块共享性：ai-sdk.ts 私有，不持久化
```

adapter state 还需增加两个有界运行时字段：

- `normalizationDisabled: boolean`：本 stream 是否已观察到超出已证实 signature 的 reasoning
  metadata；
- `normalizationReasoningActive: boolean`：adapter 是否已从一个满足 gate、raw event 显式
  `id === "reasoning-0"` 且无 metadata 的 start，向下游发出尚未 end 的 package-signature
  lifecycle；不能只看输出/current ID，因为匿名 fallback 也可能合成同名 ID，孤立 delta 也会设置
  `currentReasoningID`。

所有 mapping 路径都必须维护第二个字段：只有上述显式 package-signature start 实际输出后设 true；
对应 end 实际输出、pending drain、观察到 raw metadata 或 finish reset 后设 false。匿名 fallback
即使碰巧输出字符串 `reasoning-0` 也不得设置它。

raw metadata 判定使用
`event.providerMetadata != null`，而不是 Schema 解码后的值。首次观察到任意 reasoning raw
metadata 时先 flush 已有 pending，再把 `normalizationDisabled` 置为 true；本 stream 后续完全按
当前逐事件映射。finish reset 清除两个运行时字段，但保留 immutable gate。

这里必须区分“已证实 producer contract”和“在线预测”：2.0.41 及已检查的 2.0.62 源码不会给
reasoning start/delta/end 添加 metadata，所以支持域内不需要预测未来事件。若未来 dependency
开始添加 metadata，已发生的输出无法被在线算法追溯拆分；runtime 会停止新的合并，并保持现有
metadata mapper 的行为（合法 schema 保留，非法值仍按现状丢弃），而真实 provider 集成测试必须
失败并触发依赖升级复审。文档不再声称能在看见未来 metadata 之前证明一个任意 producer 的完整
lifecycle 无 metadata。

### 4.3 备选 adapter 的状态转移与 barrier

| 输入事件/条件                                   | pending 状态         | 输出与状态动作                                                               |
| ----------------------------------------------- | -------------------- | ---------------------------------------------------------------------------- |
| gate=false                                      | 必须为空             | 完全保持当前逐事件映射                                                       |
| 匿名 ID 的 reasoning 事件                       | 任意                 | 先 flush pending，再保持 currentReasoningID fallback                         |
| 任一 reasoning event 带 raw metadata            | 任意                 | 先 flush pending，不改变既有 metadata 映射；关闭本 stream 后续 normalization |
| eligible `reasoning-end(reasoning-0)`           | 无                   | 不输出；保存 `{ id }`，等待 same-ID reopen 或明确 barrier                    |
| duplicate eligible `reasoning-end(reasoning-0)` | 同 id                | 幂等保持一个 pending，不产生 orphan end                                      |
| `reasoning-start(reasoning-0)`，无 metadata     | 同 id                | 消费 pending，抑制冗余 start，原 lifecycle 继续                              |
| `reasoning-delta(reasoning-0)`，无 metadata     | 同 id                | 防御性消费 pending 并原样输出 delta                                          |
| reasoning ID 不是 `reasoning-0`                 | 任意                 | 先 flush pending end，再按当前逻辑处理新 lifecycle                           |
| 首个/同一 `text-start/text-delta(txt-0)`        | 可存在               | pending 保持不变；原样转发，作为可选透明 bridge                              |
| 不同 text ID 的 `text-start/delta`              | 可存在               | 先 flush pending end，再按当前 text 逻辑处理                                 |
| `text-end`                                      | 可存在               | 先 flush pending end，再转发 text-end                                        |
| 任意 tool 事件                                  | 可存在               | 先 flush pending end，再转发 tool 事件                                       |
| `start/start-step/finish-step/finish`           | 可存在               | 先 flush pending end，再按现有逻辑忽略/转发 boundary；finish 后 reset        |
| `source/file/tool-output-*/tool-approval-*`     | 可存在               | 先 flush pending end，再保持现有忽略行为                                     |
| `raw`                                           | 可存在               | 仅为底层观测副本；保持透明和现有 billing extraction                          |
| `abort`                                         | 可存在               | flush pending end，再保持现有 abort 映射                                     |
| AI SDK/network error（可能 retry）              | 可存在               | stream 先产出 pending end batch，再原样失败；不得改变错误分类                |
| iterable 正常耗尽但没有 finish event            | 可存在               | stream 尾部幂等 drain；已有 finish 时 pending 为空                           |
| stream interruption                             | 可存在               | 保持 interrupt 路径；processor 最终 cleanup 完成 active part                 |

允许的间隔有两种：空的 end→start（真实 `tool_calls: []` signature），或只含同一 `txt-0`
start/delta（首轮 content-bridge signature）；`raw` 只因它是底层 chunk 的观测副本而透明。其他当前
不产生 session-visible LLMEvent 的事件仍是语义 barrier，不能因为最终被忽略就允许 reasoning 跨越。

核心伪代码：

```text
eligible(event) iff:
  gate is true
  and normalizationDisabled is false
  and normalizationReasoningActive is true
  and event.id == "reasoning-0"
  and event.providerMetadata == null
  and (currentTextID is undefined or currentTextID == "txt-0")

on reasoning event with raw providerMetadata:
  output = drainPendingReasoningEnd()
  normalizationDisabled = true
  normalizationReasoningActive = false
  return output + mapNormally(event)  // 合法 metadata 保留；非法值仍按当前 mapper 丢弃

on metadata-free reasoning-start(reasoning-0) while no pending and gate is true:
  output = mapNormally(event)
  normalizationReasoningActive = true
  return output

on eligible reasoning-end(id) while no pending:
  pending = { id }
  return []

on duplicate eligible reasoning-end(id) while same-id pending:
  keep pending unchanged
  return []

on text-start/text-delta(event) while pending:
  if event.id == "txt-0" and (currentTextID is undefined or currentTextID == "txt-0"):
    keep pending unchanged
  else:
    output += drainPendingReasoningEnd()
  return output + mapNormally(event)

on same-id metadata-free reasoning-start while pending:
  pending = undefined
  return []

on same-id metadata-free reasoning-delta while pending:
  pending = undefined
  return mapNormally(event)  // normalizationReasoningActive 保持 true

on anonymous or non-reasoning-0 reasoning event while pending:
  output = drainPendingReasoningEnd()
  return output + mapNormally(event)

before barrier(event):
  output = drainPendingReasoningEnd()
  return output + mapNormally(event)

on stream failure(error):
  events = drainPendingReasoningEnd()
  if events is not empty: emitBatch(events)
  fail(error)  // 保留原对象/分类，供 SessionRetry.policy 使用

on successful iterable exhaustion:
  events = drainPendingReasoningEnd()
  if events is not empty: emitBatch(events)
```

`drainPendingReasoningEnd(state)` 是 adapter 导出的幂等 helper：有 pending 时返回一个 end 并同步
清除 pending/current reasoning ID，并把 normalizationReasoningActive 置为 false；无 pending 时返回
空数组且不得清除其他 active 状态。
`toLLMEvents()` 的 barrier 与 `llm.ts` 的 stream exhaustion/failure wrapper 必须共用它，避免多套
flush 逻辑漂移。

### 4.4 备选 adapter 的函数规约

```text
函数：LLMAISDK.toLLMEvents（reasoning normalization 子状态机）

Requires:
  - AISDKEvent 按 fullStream 顺序串行交付
  - normalization options 在该 adapter state 生命周期内不可变
  - pendingReasoningEnd 满足 PendingReasoningEnd 不变量或为 undefined

Ensures:
  - gate=false 时，对任意输入产生与修改前相同的 LLMEvent 序列
  - 对已证实的 `reasoning-0`、无 metadata gated 序列，无论 same-ID reopen 之间为空还是仅含
    `txt-0` bridge，都只输出一个 reasoning-start、全部 delta、一个 reasoning-end
  - 每个 reasoning delta 按输入顺序恰好输出一次；text/tool 事件不缓冲、不重排
  - 匿名 ID、不同 reasoning/text ID 或跨 barrier 的 lifecycle 不被合并
  - `tool_calls: []` 造成的空 end→start 间隔被合并；真实 tool 事件仍作为 barrier
  - raw reasoning metadata 不因本修复改变既有 schema 映射；一经观察就停止本 stream 后续
    normalization
  - 除 interrupt 外，每个 pending end 最终被同 ID reopen 消费，或在 barrier/failure/exhaustion 前
    恰好 flush 一次；interrupt 由 processor cleanup 完成下游 active part
  - retryable stream failure 在重抛同一 error 前先交付 pending end；retry 不遗留未完成 part
  - finish reset 后 counters/IDs/pending/两个 normalization runtime flags 清空，但 immutable gate
    保留给同配置 state 的复用

Invariants:
  - pending 存在时，下游仍有且仅有一个对应的 active reasoning lifecycle
  - 已输出的 reasoning-end 永不撤销
  - adapter 不创建、不读取 PartID，不修改 Session/TUI schema 或 end 的单调终态合同

副作用：
  - 仅更新 per-stream adapter state
  - 不修改 provider response、Session storage、LLMEvent schema 或公开配置
```

### 4.5 反事实与首轮改动必要性审计

先给出不绕弯的结论：如果从分支最初只针对现在已证实的 `tool_calls: []` 根因，首轮 adapter 改动
并非必要，直接 parser patch 即可。当前分支已经包含首轮 adapter；本次应保留它来维持已确认的
content-bridge 行为，但没有必要再放宽 same-ID 条件。只有选择 comment 的 adapter 补修作为替代
方案时，`textID` 才会因“只写不读”而应随同删除。

需要区分三种不同的“只改 comment 提到的部分”：

1. **在分支最初基线上只改 comment 展示的两个 adapter 条件**：不能，因为当时尚不存在
   `pendingReasoningEnd`、normalization gate、barrier drain 或 error/exhaustion drain；那两行是对
   首轮状态机的增量补丁，不是可独立应用的完整修复。
2. **在当前首轮实现上只放宽两个条件并保留其余代码**：能解决已观察的空 `tool_calls` 症状，
   最新 collaborator comment 记录的真实 endpoint 63/63 → 1/1 结果支持这一点；但
   `pendingReasoningEnd.textID` 随后只写
   不读，成为死状态，保留它会让文档和实现继续暗示一个并不存在的正确性条件。
3. **在分支最初基线上直接 patch 外部 parser，把 `delta.tool_calls != null` 改为
   `delta.tool_calls?.length`**：能从产生点解决本次空数组伪边界，是该精确症状的最小根因修复；
   仓库已有 dependency patch 机制；它不会改变由真实 content 边界造成的 reasoning reopen，而当前
   分支已有首轮 adapter 继续处理该独立行为。

若拒绝 dependency patch、坚持 comment 的 adapter 补修，才适用下表：

| 首轮改动 | 修订后判断 | 理由 |
| -------- | ---------- | ---- |
| npm package gate | 保留 | 限制 producer 支持域，避免影响 native 和其他 provider |
| pending-end marker | 保留并简化 | 在公共终态发布前消除伪 end/start，避免 processor 撤销终态 |
| barrier drain helper | 保留 | 不同 ID、真实 tool、step、finish 等必须结束 pending lifecycle |
| failure/exhaustion drain | 保留 | 无正常 finish 时也必须恰好交付 terminal end |
| metadata opt-out 与 active flag | 保留 | 防止把带签名/metadata 或匿名 fallback 的 lifecycle 泛化合并 |
| `pendingReasoningEnd.textID` | 仅备选方案删除 | 放宽 same-ID 条件后只写不读；正确 drain 由通用 barrier 完成 |
| “必须先观察 `txt-0` 才合并” | 删除 | 被真实 `tool_calls: []` SSE 直接证伪，正是首轮失效原因 |
| content-bridge 回归 | 保留 | 覆盖另一种已独立复现的 producer 序列，但不能替代真实空数组回归 |

最新 comment 中“继续绑定 textID 可确保在正确时机 drain”的解释不准确：若采用其两个条件改动，
same-ID start/delta 已不再读取 `textID`；而 text-end、不同 text ID、tool、step、finish、failure 和
exhaustion 的正确 drain 本来就由通用 barrier/helper 保证。若采用该备选实现，应删掉这项无效
复杂度；采用 4.1 parser patch 时不改 adapter，`textID` 仍服务于首轮 content-bridge 条件。

首轮真正缺失的不是更多合成 adapter 分支断言，而是一条包含 `reasoning_content + tool_calls: []`
的真实 SSE → 锁定 provider parser → `streamText.fullStream` → adapter/processor 回归。若这条测试在
首轮红测阶段存在，`textID` 前提会在生产修改前立即暴露为错误。

### 4.6 方案比较与不采用项

| 方案                             | 优点                                   | 结论 / 代价                                                                 |
| -------------------------------- | -------------------------------------- | --------------------------------------------------------------------------- |
| 维护锁定 provider parser patch    | 从产生点消除空数组伪 tool barrier       | **采用**；现有 patch 机制可承载；content 交错继续由首轮 adapter 处理          |
| 等待/升级外部 provider           | 若上游接受则无需本地兼容               | 已检查 2.0.62 仍保留该状态机（未单独实跑）；外部发布时间不可控              |
| 放宽 gated adapter same-ID 合并  | 不改 dependency；comment 有 endpoint 实测 | 备选；比根因 patch更宽，且需删除变成死状态的 `textID`                      |
| 全 provider adapter 合并         | 代码判断更少                           | 不采用；会影响 signed/encrypted 或语义不同的 provider                       |
| processor end retraction         | 普通首次 end 时机不变                  | 不采用；破坏 CLI/JSON/外部 PartUpdated 终态假设                             |
| processor 直接不 delete          | 改动表面最小                           | 不采用；completed part 仍在 active map，生命周期错误                        |
| TUI-only grouping                | 不改 streaming core                    | 不采用；DB/API/回放仍碎片，且 TUI 没有可靠原始 block ID                     |
| provider/model 名称硬编码        | 可把时机变化限制到 `glm52`             | 不采用；名称不构成协议能力合同，无法覆盖同类 endpoint                       |
| 时间 debounce / lookahead buffer | 可能猜中短间隔 reopen                  | 不采用；非确定、增加延迟，CI 与真实网络下不可证明                           |

明确不修改 `currentReasoningID` 的匿名 fallback/reset；它不是本次因果点。npm gate 取自已有
`Provider.Model.api.npm`，不新增用户配置。

### 4.7 最小复现走修正后逻辑

```text
chunk 1: reasoning_content="reason-1", tool_calls=[]
  → parser 发 reasoning-start(r0), reasoning-delta(r0,"reason-1")
  → patched empty-array guard 不进入 tool 分支，不发 reasoning-end
  → processor 创建 P1(active)，追加 reason-1

chunk 2: reasoning_content="reason-2", tool_calls=[]
  → isActiveReasoning 仍为 true；parser 只发 reasoning-delta(r0,"reason-2")
  → processor 继续向 P1 追加 reason-2

后续 content="answer"
  → parser 按既有逻辑发唯一 reasoning-end(r0) 和 text start/delta
  → 首轮 adapter 按既有 content-bridge 规则暂存 end，并在 text-end/barrier 前恰好 drain 一次
  → processor 完成 P1，并创建/完成 text P2

finish-step/finish
  → 按现有逻辑完成 turn/reset state
```

最终只存在一个 reasoning part P1 和一个 text part P2；P1 保持一个单调 lifecycle，TUI 显示
一个 `Thought`，CLI/JSON consumer 只观察到一次 reasoning terminal update。

若没有 content 而直接结束 stream，provider flush 仍按原逻辑发唯一 reasoning-end；首轮 adapter 在
finish-step/finish barrier 前 drain。非空 tool-call 数组同样保留原来的 reasoning-end + tool 事件。

### 4.8 时间、实时显示与 consumer 语义

- dependency patch 本身不延迟任何合法终态：空数组不是真实 tool boundary；content、非空 tool 与
  flush 的 end 时机保持 2.0.41 原行为。
- 当前分支首轮 adapter 已经使 reasoning→text 的 end 延迟到 text-end；这是既存 content-bridge
  取舍，不是本次 parser patch 新增的行为。
- 对真实空数组序列，duration 从第一次 reasoning start 到真实 content/tool/flush 边界，不再被每个
  token chunk 人为切碎。
- processor、DB projector、TUI、legacy run、session-data 与 share 不需要修改，因为它们收到的仍是
  单调且合法的 start/delta/end / PartUpdated 序列。
- 若产品不再接受首轮 adapter 对普通 compatible provider 的完成时机延迟，应另开范围重新评估并
  可能回滚该 workaround；这不影响空数组 parser patch 的正确性。

## 五、正确性论证

### 5.1 根因消除

异常生命周期由 2.0.41 的 `delta.tool_calls != null` 首次产生。把条件改为非空数组判断后，`[]`
不再改变 `isActiveReasoning`，所以后续 reasoning chunk 不会 reopen，也不会生成可供 adapter/processor
碎片化的伪 end/start。修复发生在异常事件产生点，不依赖 TUI 聚合或终态撤销。

### 5.2 不变量保持

- **空数组语义**：`tool_calls.length === 0` 表示没有 tool-call delta；不结束 reasoning，与 native
  `if (toolDeltas.length)` 参考一致。
- **非空数组守恒**：`tool_calls.length > 0` 时仍进入原分支，先 end active reasoning，再逐项处理
  tool delta；真实 tool boundary 不被合并。
- **其他字段守恒**：reasoning_content、content、flush、finish、usage、metadata 与错误路径不变。
- **文本与顺序守恒**：每个 reasoning/text/tool delta 仍按输入顺序恰好输出一次；不缓存或复制文本。
- **公共合同保持**：adapter、processor、PartID、TUI 与 LLMEvent schema 不改；已经输出的 end 仍是
  单调终态。
- **运行入口一致**：patch 同时覆盖 ESM `dist/index.mjs`、CJS `dist/index.js` 和 package source，避免
  不同解析条件产生行为漂移。
- **升级可见性**：patch key 绑定精确版本 2.0.41；升级流程必须显式核对新版本源码与 patch 注册，
  不能仅假设工具一定会阻止陈旧 patch 被旁路，也不能静默恢复 `!= null`。

### 5.3 无回归引入

- 用 Issue 最新的 `reasoning_content + tool_calls: []` 真实 SSE shape 固化 provider parser、adapter 与
  HTTP processor 回归，断言 parser 自身只产生 1 start/N delta/1 end，并最终只持久化一个 part；
- 用非空 tool-call 数组证明真实 tool boundary 仍先结束 reasoning 并完整生成 tool events；
- 保留首轮 content-bridge、gate、metadata、barrier、failure/exhaustion 测试，证明 dependency patch
  没有改变 adapter 合同；
- 运行 adapter suite、processor effect suite、CLI streaming 相关既有测试与 package typecheck；
- 审核 patch 同时覆盖 package source/CJS/ESM，最终 diff 不修改 processor、TUI、schema 或无关
  runtime 分支。

### 5.4 Trivial 判定

不适用。虽然核心条件是一行，但它位于第三方 streaming parser，并影响 reasoning/tool 生命周期；
还需要维护 source/CJS/ESM 三份等价产物、精确版本 patch 和真实 parser/processor 回归。

## 六、测试用例清单

| 类型 | 用例描述                                                 | 关键断言                                                                                                        | 当前状态与证据                                              |
| ---- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 回归 | gated adapter 输入首轮 GLM content 交错序列两次          | 1 start、2 delta、1 end；end 在 text-end 前；text 事件原序                                                      | 首轮通过：`coalesces the openai-compatible...`              |
| 回归 | HTTP mock `.reason.text.reason.text` 走真实 AI SDK 路径  | 一个 reasoning part、一个 text part；文本完整                                                                   | 先红后绿；`processor-effect.test.ts`                         |
| 回归 | Reporter 规模：相同模式重复 34 次                        | 1 start、34 delta、1 end；pending 最终为空                                                                       | 通过：`keeps one bounded...34 segments`                     |
| 回归 | 真实 parser 链输入 `reasoning_content + tool_calls: []`  | provider fullStream 自身为 1 start/N delta/1 end；一个持久化 reasoning part                                     | **待加；必须先红后绿，作为补修实现门禁**                    |
| 新增 | reasoning 后出现非空 `tool_calls`                       | reasoning-end 仍在首个 tool event 前；tool input/call 文本与 ID 完整                                           | 待加                                                        |
| 新增 | gate=false 的相同事件序列                                | 保持修复前逐事件生命周期                                                                                         | 通过                                                        |
| 新增 | gated 普通单段 reasoning→text，不再 reopen               | end 延迟到 text-end；text delta 不缓冲                                                                           | 通过；显式锁定已接受的时机取舍                              |
| 既有 | 合成的空 end→start adapter 间隔                          | 当前 adapter 仍把它视为两个 lifecycle；dependency patch 保证空数组不再生成该间隔                               | 保留当前测试，不改预期                                      |
| 新增 | 匿名 ID、不同 reasoning ID                               | pending 先 flush，不发生跨 lifecycle 合并                                                                        | 首轮通过；预期保持                                          |
| 新增 | 不同 text ID                                             | pending 先 flush，再按原 text mapper 处理                                                                        | 通过                                                        |
| 新增 | raw metadata 出现在 start、delta、end 或 pending 之后    | raw 存在即禁用；合法 metadata 保留；已发终态不撤销                                                               | 通过；非法 schema 仍走未改动的既有 decoder                  |
| 新增 | raw、ignored、tool 与 step barrier                       | raw 透明；其他语义 barrier 先 flush；可见事件顺序不变                                                           | 通过：代表事件单测 + 未改 mapper 分支审计                   |
| 新增 | text-end、finish-step、finish 与 state reset             | end 同批位于 settlement 前；incomplete 三事件不拆批；reset 保留 gate                                             | 通过                                                        |
| 新增 | duplicate end、bridged delta、orphan end                 | pending 幂等；delta 恢复；没有已发 start 的 end 不进入 pending                                                   | 通过                                                        |
| 新增 | typed stream error 与 drain helper                       | error Cause 保持同一对象；pending drain 幂等                                                                     | 通过：adapter 组件测试；`llm.ts` 组合路径经代码审计         |
| 集成 | compatible stream 在 pending 后异常结束                  | reasoning part 在 incomplete settlement 前获得 terminal end                                                     | 通过：`finalizes pending reasoning...incomplete`            |
| 新增 | iterable exhaustion 与 interrupt                         | exhaustion 使用同一 drain；interrupt 不被 catch，仍由 processor cleanup                                         | 通过：helper/组合代码审计 + 既有 interruption suites       |
| 既有 | `test/session/llm.test.ts`                               | 当前 adapter/stream 行为保持通过                                                                                 | 2026-08-07 复审实跑：52 pass；补修后须重跑                  |
| 既有 | `test/session/processor-effect.test.ts`                  | incomplete settlement、retry/interrupt 与既有 processor 行为通过                                                | 2026-08-07 复审实跑：35 pass；补修后须重跑                  |
| 既有 | CLI session-data 与 stream transport                     | 没有 end retraction；现有 reasoning/重放 consumer 合同不变                                                      | 2026-08-07 复审实跑：13 + 30 pass；补修后须重跑            |
| 静态 | `packages/opencode` 的 `bun typecheck`                   | 类型检查通过                                                                                                     | 2026-08-07 复审实跑通过；补修后须重跑                      |

## 七、代码更新清单

| 文件                                                      | 函数 / 区域                                    | 改动                                                                           | 当前状态 |
| --------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------ | -------- |
| `packages/opencode/src/session/llm.ts`                    | `streamBatches()` / `adapterState()`           | 传入 npm gate；exhaustion/failure drain pending，失败原样交给 retry policy      | 首轮已完成，保留 |
| `packages/opencode/src/session/llm/ai-sdk.ts`             | flags / `drainPendingReasoningEnd()`           | immutable gate、active/metadata flags 与幂等 drain                             | 首轮已完成，保留 |
| `package.json` / `bun.lock`                               | `patchedDependencies`                          | 注册 `@ai-sdk/openai-compatible@2.0.41` 精确版本 patch                         | 待改     |
| `patches/@ai-sdk%2Fopenai-compatible@2.0.41.patch`        | package source / `dist/index.mjs` / `index.js` | 空数组判断改为非空数组判断                                                     | 待加     |
| `packages/opencode/test/session/llm.test.ts`              | real SSE / provider scenarios                  | 先增加空 `tool_calls` 真实 parser 红测与非空 tool 边界测试；保留空间隔预期     | 待改     |
| `packages/opencode/test/session/processor-effect.test.ts` | HTTP mock scenarios                            | 增加空数组输入的单 reasoning part 持久化回归；保留异常结束测试                 | 待改     |

首轮最终 diff 未修改、修订方案也不计划修改：

- `packages/opencode/src/session/processor.ts`；
- `packages/tui/src/routes/session/index.tsx`；
- `packages/llm/src/schema/events.ts` 或 Session schema；
- CLI run/session-data、share、SDK consumer；
- text、tool 持久化逻辑本身。

## 八、文档更新清单

| 文档路径                                                | 更新内容                                                                                                   | 当前状态 |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------- |
| `docs/fixes/session-fix-fragmented-reasoning-blocks.md` | 补入空 `tool_calls` 证据，撤销首轮完成结论，修订状态机/必要性/测试与代码清单                                | 已完成   |

本方案不改变 schema、公开接口、错误码、用户配置或 PartUpdated 终态语义；它只改变
`@ai-sdk/openai-compatible@2.0.41` 对空 `tool_calls` 数组的 parser 分支：空数组不再构成 reasoning
terminal，非空数组、content 与 flush 仍是原有边界。该行为由本修复文档、精确版本 dependency patch
与真实 parser 回归共同固定。依赖升级必须复审 patch 是否仍需要；若未来要修改 content 边界、公共
end 语义或 adapter 合并范围，则超出本补修方案，必须重新确认。

## 九、首轮实现记录与 2026-08-07 复审

### 9.1 首轮红绿门禁与提交边界

| 提交         | 内容                                                     | 结果 |
| ------------ | -------------------------------------------------------- | ---- |
| `af9463c6dd` | 真实 HTTP `.reason.text.reason.text` 回归                | 修复前按预期失败：期望 1 个 reasoning part，实际 2 个 |
| `1c670a4a98` | npm-gated pending-end 状态机与 stream drain              | 红测转绿；既有 adapter suite 与 typecheck 通过 |
| `ab333813c3` | adapter 合同边界、34 段规模、metadata/barrier/reset 测试 | 分层回归通过 |
| `d13dcd5125` | compatible stream 异常结束时的 pending terminal 集成证据 | processor 完成 reasoning 后按既有 incomplete 规则停止 |

每个工作单元都在继续下一步前单独提交。实现没有把红测和生产修改压进同一个 commit，因此可以从
Git 历史直接复核失败合同、修复和边界证明。

但这些边界都基于 reasoning/content bridge 假设，没有输入 `tool_calls: []`。因此提交结构合规，
不等于根因覆盖充分；它们是首轮历史证据，不能继续作为 Issue 已修复的证明。

### 9.2 2026-08-05 首轮验证结果

所有命令均从 `packages/opencode` 运行：

| 命令 / suite | 结果 |
| ------------ | ---- |
| targeted HTTP 回归（生产修改前） | 0 pass，1 fail；`reasoning.length` expected 1 / received 2 |
| targeted HTTP 回归（生产修改后） | 1 pass，0 fail |
| `bun test test/session/llm.test.ts --timeout 90000` | 52 pass，0 fail，169 assertions |
| `bun test test/session/processor-effect.test.ts --timeout 90000` | 35 pass，0 fail，220 assertions |
| `bun test test/cli/run/session-data.test.ts --timeout 90000` | 13 pass，0 fail，22 assertions |
| `bun test test/cli/run/stream.transport.test.ts --timeout 90000` | 30 pass，0 fail，62 assertions |
| `bun typecheck` | 通过；`tsgo --noEmit` |
| `git diff --check` | 通过 |

这里报告的是按首轮假设选择的分层 suites，不宣称运行了整个 monorepo 的所有测试，也不证明最新
空 `tool_calls` 现场已修复。

### 9.3 首轮五维合同审计的有效范围

| 维度 | 审计证据 | 结论 |
| ---- | -------- | ---- |
| 数据 | 新状态仅含 frozen gate、两个 boolean 与一个固定 ID pending marker；不缓存 token/text；无 schema/config 变化 | 通过 |
| 函数 | gate=false 走原 mapper；支持域只接受显式 r0/t0、无 raw metadata；所有非 raw barrier 共用同一 drain | 通过 |
| 持久化 | HTTP 回归只生成一个 reasoning part；异常结束时 part 有 `time.end`；未修改 processor/PartID/DB projector | 通过 |
| consumer | 从未发布 end retraction；CLI session-data 与 stream transport suites 全过；TUI/share/SDK 无需适配 | 通过 |
| 集成 | gate 只取 `model.api.npm` 精确值；native 在 state 创建前返回；其他 AI SDK provider 默认关闭；错误分类不改 | 通过 |

上述审计对 gate、终态单调性、consumer 隔离和 drain 机制仍有效；“支持域只接受显式 r0/t0”中的
`t0` 必要条件无效，持久化与集成结论只对首轮 fixture 成立。真实 producer fixture 缺失使审计产生了
假阴性，这是本次必须修正的测试设计问题。

### 9.4 首轮范围与当前残余风险

从设计确认提交 `f4f68de772` 到实现审计提交 `d13dcd5125`，代码与测试 diff 只涉及四个预定文件：

- `packages/opencode/src/session/llm.ts`；
- `packages/opencode/src/session/llm/ai-sdk.ts`；
- `packages/opencode/test/session/llm.test.ts`；
- `packages/opencode/test/session/processor-effect.test.ts`。

没有修改 processor 生产逻辑、TUI、LLMEvent/Session schema、依赖、CLI consumer 或公开配置。
当前首先要消除的不是理论残余风险，而是已确认的未修缺陷：空 `tool_calls` 会持续产生碎片。
推荐的 dependency patch 不新增 terminal 延迟，也不依赖合成 ID 或 metadata；它只把空数组改为
非边界。当前分支首轮 adapter 已有的 terminal/duration 延迟仍然存在，并继续只由 content-bridge
合同与相应测试约束。依赖升级时必须重新核对上游 parser 条件、三份 patch 目标与真实 integration
fixture；若上游已修复，则删除本地 patch 并先证明同一回归仍通过。

### 9.5 2026-08-07 复审结论与下一门禁

- 用户确实运行当前分支最新构建；“反馈来自旧版本”已被排除。
- runtime 日志确实指向 V1 AI SDK；native parser 只作为判断语义的参考，不是本次执行路径。
- 最新 comment 的根因与本地锁定依赖源码完全一致，并已用真实 dependency chain + 假 SSE 独立复现。
- comment 声称的候选 adapter 补修、真实 endpoint 计数和 typecheck 是 collaborator `yixiao5428`
  提供的结果；补修前生产 HEAD `64e676ac45` 未包含该候选代码，所以本文只把这些结果作为 comment
  证据，不冒充共享分支验证。本文独立复跑当前未补修基线得到 87 tests、389 assertions 全过，恰好
  说明现有 suites 没有根因级红测，不能证明问题已修复；CLI consumer 13 + 30 tests 与 package
  typecheck 也已独立复跑通过，只证明既有合同在当前基线未回归。
- 推荐使用现有 `patchedDependencies` 精确修正 2.0.41 的空数组判断，并同时覆盖 package source、
  ESM 与 CJS 入口；首轮 adapter 保留但不放宽，`textID` 也不删除。comment 的 id-only adapter 改法
  能修复已观察症状，但范围更宽，只在项目明确拒绝 dependency patch 时作为备选。
- 下一实现门禁：先提交能在当前代码上稳定失败的 `tool_calls: []` 真实 parser/processor 回归，等待
  确认后再提交 dependency patch；随后补非空 tool 边界测试并复跑分层 suites/typecheck。每完成一个
  工作单元先单独 commit，再继续下一步。
