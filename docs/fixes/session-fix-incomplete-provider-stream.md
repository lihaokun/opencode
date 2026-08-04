# Provider 流缺失终止帧误报成功修正方案

- 状态：原始修复已实施；2026-08-04 compaction crossover 修订单元 1 已完成，待确认后进入单元 2
- 初稿日期：2026-07-27
- 重审日期：2026-07-28
- Compaction crossover 重审日期：2026-08-04
- 对应问题：[Issue #3](https://github.com/lihaokun/opencode/issues/3)
- 对应 review：[PR #5 comment](https://github.com/lihaokun/opencode/pull/5#issuecomment-5170765949)
- 影响模块：AI SDK LLM adapter、LLM service batch boundary、Session 流终态、Prompt agent loop、
  Task 前后台结果传播、CLI 退出状态
- 原始复现/修复前源码基线（pre-rebase）：`74637461887da7514fcc272846a1fdcd946b3aeb`
- 当前 PR base：`d12b1e924d7a18551767690e9f02294d0b3c6f1a`
- Compaction crossover 审计基线：`dbed80fccf0afeb2656736f8abe0f3b07d4b95e0`
- 前置修复：`docs/fixes/subagent-fix-output-length.md`（Issue #1 / PR #2）
- 本次实施范围：legacy `SessionPrompt` / `TaskTool` 路径
- 独立 follow-up：V2 `SessionRunner` 与 native Gemini 的协议特定终态风险；本次不修改对应
  runner/protocol 文件
- 当前 PR 代码/测试提交：`c5edbe9c95d11a198b1f5dbe769c4f1d55eec2a2`、
  `80c34f68991897867b1ed0366bdfe6a3567f0cad`、`cc1c76d008255aa02c8d571431139da89b4bb95b`、
  `1662d53e5f0393dae23bcb895255d54b6f0e5594`
- 当前 PR 文档整合提交：`dbed80fccf0afeb2656736f8abe0f3b07d4b95e0`
- 本地 crossover 单元 1 提交（尚未推送）：`1ba447213b`（计划审计）、`8c652ba107`（红测）、
  `612419fb31`（实现与回归）、`f2080642fd`（backpressure 证据补强）

阅读约定：第一至三节记录原始修复前基线的现象、根因与参考对照；第四至八节记录已经实施的
原始方案及验证；第九节是原审核结论及其失效说明；第十节记录 compaction crossover 修订计划
及分单元实施状态。第十节描述“修复前”“当前缺陷”或原实现时，指上述 crossover 审计基线；
带“单元 1 实施后”标记的内容指本地 `f2080642fd`。

## 一、现象与复现

### 1.1 现象

OpenAI-compatible provider 已返回 HTTP 200 并开始传输 reasoning/text，但上游连接在模型生成
过程中被截断。Issue 记录的 gateway 已无法改写 HTTP status，opencode 最终观察到的响应流
没有带 `finish_reason` 的终止 chunk，也没有产生可供 SessionProcessor 处理的显式 provider
error。

AI SDK 把这种“流正常耗尽但没有终止原因”的状态表示为：

```ts
{
  finishReason: "other",
  rawFinishReason: undefined,
}
```

在原始修复前基线，opencode adapter 丢弃 `rawFinishReason`，并把不在本地枚举中的 `"other"` 映射成
`"unknown"`。Session 将其保存为普通 `step-finish`，但不创建 assistant error。Prompt
loop 随后退出，Task 又只检查 `error` 和 `finish === "length"`，最终把子任务登记成成功：

- 只有 reasoning 时，父 agent 得到空的 `<task_result>`；
- 已产生部分 text 时，父 agent 得到残缺文本；
- 前台和后台 Task 都可能被登记成 `completed`；
- 顶层 provider turn 直接发生同类截断时，plain CLI 可能空输出并退出 0；
- 子 Task 截断时，父 agent 当时看不到 tool failure，因而无法有意识地恢复或向用户报错。

### 1.2 触发条件

核心触发条件为：

1. provider/gateway 已经完成 HTTP 握手并返回 200；
2. 流中已经出现零个或多个 reasoning、text 或 tool 相关事件；
3. provider 没有发送任何原始终止原因；
4. transport 对 opencode 表现为普通 drain（可有 `[DONE]`，也可只是 EOF），而不是 rejected
   fetch/body stream 或 AI SDK `error` part；
5. 请求走 AI SDK adapter，或其他 runtime 同样在没有可信终态时正常耗尽事件流。

Issue 中的实际环境是 `glm-5.2` 经本地 new-api gateway 调用。上游 TCP reset 发生在 reasoning
阶段，gateway 已经把 200 返回给 opencode，因而 opencode 无法再用 HTTP status 判断这次
模型生成是否完整。

### 1.3 原始修复前基线本地实证

2026-07-28 在基线 `7463746188` 上使用真实 `opencode run`、真实 TaskTool、真实 child
Session 和 test provider 执行临时 E2E。测试结果：

```text
1 pass
0 fail
7 assertions
```

父 turn 先调用真实 `task`，child 的 provider response 使用：

```ts
reply().reason("unfinished child reasoning")
// 故意不调用 .stop()
```

测试夹具的真实 wire 行为由 `packages/opencode/test/lib/llm-server.ts` 决定：

```text
role chunk
reasoning_content chunk
[DONE]
```

其中没有 `finish_reason`。这是一份“客户端可见终态条件相同”的确定性最小复现，不声称逐字节
模拟 Issue 中 gateway 到上游的 TCP reset。真实 trigger 是 TCP reset；本地复现从 gateway
之后的 opencode 可见边界开始。

修复前 E2E 观测：

| 观测边界               | 实际值                                |
| ---------------------- | ------------------------------------- |
| `opencode run`         | `exitCode=0`                          |
| Task part state        | `"completed"`                         |
| child assistant finish | `"unknown"`                           |
| child assistant error  | `undefined`                           |
| child reasoning part   | 已保存 `"unfinished child reasoning"` |
| child text part        | 不存在                                |
| child provider turn 数 | `1`，无自动重放                       |

该临时审计测试当时已删除；同一父子链后来在
`packages/opencode/test/cli/run/run-process.test.ts` 的
`persists a child missing-finish error and lets the parent recover without replay` 中固化，并把断言
翻转为 Task error。

另有两层现有证据：

- `packages/opencode/test/cli/run/run-process.test.ts` 的
  原用例 `unknown stream finish preserves partial output and exits 0` 证明 partial unknown 在
  修复前被锁定为成功；
- `packages/llm/test/provider/openai-chat.test.ts` 的
  `does not finalize streamed tool calls without a finish reason` 证明原生 `LLMClient.stream()`
  可以交付 partial events 而不产生 terminal event；完成性校验由持久化流 consumer 负责。

### 1.4 修复前兼容性锁（已翻转）

`packages/opencode/test/cli/run/run-process.test.ts` 在原始修复前有两个用例明确锁定旧行为：

- `unknown stream finish preserves partial output and exits 0`
- `--format json records partial output for an unknown stream finish`

两个用例都断言 `exitCode === 0`，后者还断言最后一个事件是
`step-finish(reason="unknown")`。它们证明修复前行为不是单一 UI 偶发现象，而是已被测试固定的
跨层语义。当前 PR 提交 `1662d53e5f` 已将它们翻转/重命名为
`missing terminal finish preserves partial text and exits nonzero` 和
`--format json records partial output before a missing terminal error`，同时保留 partial
output/JSON event 的可观察性。

### 1.5 出错代码路径

```text
OpenAI-compatible SSE
  → @ai-sdk/openai-compatible stream flush
  → ai stream-text finish-step(rawFinishReason=undefined)
  → packages/opencode/src/session/llm/ai-sdk.ts
      finishReason("other") => "unknown"
  → packages/opencode/src/session/processor.ts
      assistant.finish = "unknown", no assistant.error
  → packages/opencode/src/session/prompt.ts
      current iteration treats unknown as unfinished
      next iteration exits for every non-tool-calls finish
  → packages/opencode/src/tool/task.ts
      no error and not length => lastVisibleText()
  → BackgroundJob/parent Session
      Task completed, empty or partial child output
  → CLI
      direct top-level truncation exits 0; child truncation is hidden from the parent as a successful tool result
```

原始修复前关键位置（以文件和符号为准，避免后续改动导致行号漂移）：

- `packages/opencode/src/session/llm/ai-sdk.ts`：`finishReason()` / `toLLMEvents()`；
- `packages/opencode/src/session/processor.ts`：`handleEvent(step-finish)` / `process()`；
- `packages/opencode/src/session/prompt.ts`：loop entry / single-turn post-process；
- `packages/opencode/src/tool/task.ts`：`runTask()` result projection；
- `packages/opencode/test/cli/run/run-process.test.ts`：修复前 unknown text/JSON compatibility tests。

### 1.6 预期行为

满足 `finishReason === "other" && rawFinishReason === undefined` 时，必须认为本次 provider
turn 缺少可信终止证据：

- 保留已经收到的 reasoning、text、tool part、usage 和 `step-finish(reason="unknown")`；
- 同一个 assistant message 必须持久化 terminal error；
- 必须发布且只发布一次 Session error；
- Prompt loop 必须停止，不能把残缺响应提升为 structured/success；
- Task 前台、后台和 promotion 路径必须传播失败；
- 顶层 provider turn 直接截断时，CLI 必须非零退出；
- child provider turn 截断时，Task tool 必须进入 error；父 agent 可以消费该 tool error 后恢复，
  因而父会话最终 CLI exit code 不作为 child 传播成功与否的判据；
- 不自动重放 provider turn，不重复执行工具；
- 原始值已定义但本地不认识的 provider finish reason 不应仅因映射为 `unknown` 就无条件失败。

## 二、根因分析

### 2.1 直接症状

Session 数据中存在：

```text
assistant.finish = "unknown"
assistant.error = undefined
visible text = empty or partial
```

Task 将上述状态映射为 `completed`，使父 agent 无法区分完整响应与中途截断；同一状态直接
发生在顶层 assistant 时，Session 没有 error，CLI 因而退出 0。

### 2.2 根因

以下根因描述原始修复前基线，由四个连续缺口组成。该基线默认执行路径的选择也有明确代码依据：
`packages/opencode/src/session/llm.ts` 只有在 `experimentalNativeLlm` 开启时才尝试 native
runtime，否则调用 `streamText()` 并把 `fullStream` 交给 `LLMAISDK.toLLMEvents()`。

#### 缺口一：transport EOF 被 SDK 表示为普通 finish

`@ai-sdk/openai-compatible` 在流开始时使用：

```ts
let finishReason = {
  unified: "other",
  raw: undefined,
}
```

只有收到 `choice.finish_reason` 才会更新。stream flush 无条件发出 finish，因此 EOF 本身不会
产生异常。这一行为使应用层必须检查 `rawFinishReason`，不能只检查 unified reason。

#### 缺口二：adapter 丢失原始终态证据

`ai-sdk.ts` 只读取 `event.finishReason`。`"other"` 不属于 opencode 的 `FinishReason`
schema，于是被压成 `"unknown"`。adapter 没有读取 SDK 已经提供的
`event.rawFinishReason`，从而把以下状态合并：

| 状态                  | unified | raw          | 语义                 |
| --------------------- | ------- | ------------ | -------------------- |
| 缺少终止帧            | `other` | `undefined`  | 不完整，必须失败     |
| provider 自定义终止值 | `other` | 已定义字符串 | 有终止证据，语义未知 |

这是首个不可逆信息丢失点，也是主要修复位置。

#### 缺口三：Session/Prompt 对 `unknown` 的状态机定义矛盾

`SessionProcessor` 只为 `length` 创建 terminal error，`unknown` 被保存为无错误 finish。
Prompt 在本轮末尾把 `unknown` 排除出 `finished`，却在下一轮顶部对所有非
`tool-calls` finish 执行 `break`。最终既不继续生成，也不报错。

#### 缺口四：Task 结果投影擦除了异常状态

Task 只在 `assistant.error` 存在或 `finish === "length"` 时失败。`unknown` 直接进入
`lastVisibleText()`：

- reasoning 不属于 visible text，因此 reasoning-only 结果变成 `""`；
- partial text 原样返回，但不携带“不完整”标志；
- BackgroundJob 将成功 Effect 记录为 `completed`。

### 2.3 证据

- AI SDK stream event 类型同时公开 `finishReason` 和 `rawFinishReason`。
- 原始修复前基线与 crossover 审计基线的 opencode workspace lockfile 均解析到
  `@ai-sdk/openai-compatible@2.0.41`；该版本初始化
  `{ unified: "other", raw: undefined }`，只有真实 `finish_reason` 才更新二者，且 flush
  无条件发出 finish。
- 两个基线均使用的 `ai@6.0.168` 把上述两项原样投影为 `finish-step.finishReason` 与
  `finish-step.rawFinishReason`。
- `ai@6.0.168` 的公开 full-stream 类型在 `finish-step` 和 final `finish` 上都声明
  `rawFinishReason: string | undefined`；该字段是 AI SDK V3 事件契约，不是
  OpenAI-compatible 私有扩展。
- 两个基线均使用的 `@ai-sdk/anthropic@3.0.82` 同样以
  `{ unified: "other", raw: undefined }` 初始化 stream finish state，并在收到
  `stop_reason` 时同时更新 unified/raw。这证明通用 AI SDK bridge 使用 raw evidence 的判定
  不依赖 OpenAI provider ID。
- `packages/llm/src/protocols/utils/lifecycle.ts` 的标准 native lifecycle 在完成时连续发出
  `step-finish` 与 final `finish`；SessionProcessor 只在前者持久化 step/usage/snapshot，
  当前对 final `finish` 不执行状态更新。
- 当前 opencode `finishReason()` 明确把所有未知 unified 值映射成 `"unknown"`。
- `SessionProcessor.step-finish` 只为 `"length"` 创建错误。
- Prompt 的同一状态在相邻两个判断中分别被视为 unfinished 和 loop terminal。
- Task failure gate 没有检查 `"unknown"` 或缺失 finish。
- 原始修复前基线的真实父子 Task E2E 得到 Task `completed`、child `finish=unknown`、
  `error=undefined`、reasoning-only、child provider turn 数为 1。
- 原始修复前 CLI 测试明确断言 unknown stream finish 应退出 0；当前 PR 提交 `1662d53e5f` 已翻转
  该断言。

### 2.4 Workaround

没有可靠 workaround。

- 增加 provider timeout 不能解决 opencode 已把响应观察为普通 drain 的情况；
- 提高 token 上限与本问题无关；
- 父 agent 无法从空字符串判断“合法空回答”还是截断；
- 检查 `finish="unknown"` 只能在数据库/API 消费者中事后发现；
- gateway 可以尝试把上游 reset 转成显式 SSE error，但 opencode 仍需防御其他 clean EOF。

### 2.5 同类风险点与范围决策

- `packages/core/src/session/runner/llm.ts` 的 V2 runner 直接消费 `LLMClient.stream()`。
  stream 成功 drain 且没有 `publisher.stepSettlement()`/provider error 时，当前代码仍返回成功，
  不发布 `Step.Ended` 或 `Step.Failed`；
- `packages/core/src/tool/builtins.ts` 明确列出 Task 尚未移植到 V2，所以该风险不是 Issue #3
  当前 subagent 调用链；
- native OpenAI Chat 在未见 `finish_reason` 时不发 finish；这与 `LLMClient.stream()` 允许交付
  partial events 的既有契约一致，完成性必须由持久化 consumer 校验；
- native Gemini 在仅收到 usage、没有 `finishReason` 时仍会生成
  `step-finish(reason="unknown")`，不能只靠“缺少 step-finish”判断完整性；
- 单独出现 `step-finish(reason="error")`、却没有 provider-error/assistant error 的流也可能被
  legacy Prompt 当作普通 finish；当前没有把它与 Issue #3 的 raw-missing 触发链混为一谈，
  本次保持既有行为，并列入 protocol-specific follow-up；
- 测试 stub 或未来 runtime adapter 可能直接结束而不发 finish/error；
- compaction/summary 使用同一个 SessionProcessor，不能接受无可信 step settlement 的空 summary；
- StructuredOutput 不能覆盖同一 turn 已经存在的截断错误；
- 若未来为 incomplete stream 增加自动重试，partial tool activity 之后可能重放非幂等 provider
  turn；原始修复与当前 crossover 修订均保持 no-retry。

范围决策：

1. Issue #3 只修改 legacy AI SDK/SessionProcessor/TaskTool 路径，因为这是已复现的生产路径；
   共享的 SessionProcessor generic fallback 也会保护进入 legacy consumer 的 native stream，
   但不声称解决 provider-specific partial-unknown；
2. V2 runner/Gemini protocol-specific 规则作为独立 non-trivial follow-up，实施前另写
   `docs/fixes/session-v2-fix-missing-terminal-settlement.md` 并单独确认；
3. 不修改 `LLMClient.stream()` 的全局契约，现有
   `does not finalize streamed tool calls without a finish reason` 测试保持不变。

## 三、参考实现对照（算法类 bug 必填）

本问题不是数值算法 bug，而是流协议状态机 bug。对照对象使用原始修复前基线与 crossover
审计基线中版本一致的 lockfile AI SDK，以及仓库内已实现完成性检查的
`LLMClient.generate()`。

| 步骤 | 输入 / 状态              | 修复前实现                         | 参考契约                                                                             | 首个差异          |
| ---- | ------------------------ | ---------------------------------- | ------------------------------------------------------------------------------------ | ----------------- |
| 1    | stream 初始化            | opencode 尚未参与                  | SDK 初始化 `unified=other, raw=undefined`                                            | 否                |
| 2    | 收到真实 `finish_reason` | opencode 尚未参与                  | SDK 同时更新 unified 和 raw                                                          | 否                |
| 3    | EOF/flush                | SDK finish 被继续消费              | SDK 暴露最终 unified 和 raw                                                          | 否                |
| 4    | `finish-step` 映射       | 只读取 unified，`other => unknown` | raw 仍可判定是否见过真实终止原因                                                     | **是**            |
| 5    | stream consumer 完成性   | Session 正常 drain 即继续          | `LLMClient.generate()` 在 `LLMResponse.complete()` 为空时报 canonical provider error | 是                |
| 6    | Session 终态             | unknown 无 error                   | 缺少协议终态必须是失败或 incomplete                                                  | 已由步骤 4/5 导致 |
| 7    | Task 投影                | empty/partial completed            | incomplete child 不可投影为 completed                                                | 已由步骤 4/5 导致 |

参考实现来源：

- `node_modules/.bun/@ai-sdk+openai-compatible@2.0.41+d6123d32214422cb/node_modules/`
  `@ai-sdk/openai-compatible/dist/index.mjs:656-705,850-895`
- `node_modules/.bun/ai@6.0.168+d6123d32214422cb/node_modules/ai/dist/index.mjs:7246-7247,`
  `7341-7345,7458-7467`
- `node_modules/.bun/ai@6.0.168+d6123d32214422cb/node_modules/ai/dist/index.d.ts:2663-2675`
- `node_modules/.bun/@ai-sdk+anthropic@3.0.82+d6123d32214422cb/node_modules/`
  `@ai-sdk/anthropic/dist/index.mjs:4349-4352,4991-4998,5062-5068`
- `packages/llm/src/route/client.ts:382-390`
- `packages/llm/src/schema/events.ts:593-605`
- `packages/llm/src/protocols/utils/lifecycle.ts:80-99`
- `packages/llm/test/provider/openai-chat.test.ts:591-616`

## 四、修复方案

### 4.0 修复内数据与不变量

以下状态为 `SessionProcessor.process()` 内单次 stream attempt 的 ephemeral evidence，不增加
公共 schema：

数据结构：`ProviderTurnEvidence`

- `activeStep: boolean`：收到 `step-start` 后为 true，随后的 `step-finish` 后为 false；
- `completedSteps: number`：本次 stream 已收到的 `step-finish` 数量；
- `lastStepFinish: FinishReason | undefined`：本 attempt 最近一次 `step-finish` 的 reason；
- `hasCompletedVisibleText: boolean`：本 attempt 至少有一个已经过
  `experimental.text.complete` 处理、最终 `trim().length > 0` 的已关闭 text part；
- `hasToolEvidence: boolean`：本 attempt 已收到至少一个完整 `tool-call` event；仅
  `tool-input-start/delta` 不算完整调用；

类型不变量：

```text
hasVisibleText
:= hasCompletedVisibleText
 ∨ (currentText is open ∧ currentText.text.trim().length > 0)

hasUsableOutput := hasVisibleText ∨ hasToolEvidence
credibleStepSettlement := completedSteps > 0 ∧ activeStep = false
eligibleForGenericIncomplete
:= assistant.error is absent ∧ blocked = false
```

reasoning 不计入 `hasUsableOutput`，因为 Task 不把 reasoning 投影给父 agent；但无论成功或失败，
reasoning part 都必须保留在 child session。

不能在第一次非空 `text-delta` 时永久把 `hasVisibleText` 置为 true：
`SessionProcessor.handleEvent("text-end")` 的 `experimental.text.complete` 可以改写完整 text。实现应在
`text-end` 的 plugin 结果落定后更新 `hasCompletedVisibleText`；若流在 `text-end` 前耗尽，
则直接检查仍在 `ctx.currentText` 中的 partial text。这样既保留 attempt-local 性质，也不会让
plugin 改空/补全后的真实持久化结果与 fallback 判定不一致。

这里校验的是 Session 所需的 step settlement，不把 final `finish` 单独当作已持久化 step：
当前 processor 在 `step-finish` 更新 assistant finish、usage、snapshot 和 step part，而对
final `finish` 直接返回；仓库内标准 native lifecycle 与 AI SDK adapter 都会先发
`step-finish`。

生命周期：

- 在 `Effect.retry()` 所包裹的 stream effect 每次 attempt 开始时创建/重置，不能让前一次
  retry attempt 的 finish/text/tool 证据污染下一次；
- `step-start`、text、tool 和 `step-finish` 事件按原流顺序更新 evidence；
- `lastStepFinish` 必须使用本 attempt 的事件，不能直接把上一次 retry 遗留在
  `assistantMessage.finish` 上的值当作当前证据；
- `process()` 返回后丢弃，不写入公共数据库字段。

跨模块责任：

- AI SDK adapter 负责保留“raw 缺失”这一 provider-specific 事实；
- SessionProcessor 负责把 event stream 分类为成功终态或 terminal error；
- Prompt 对 incomplete stream 只消费统一的 assistant error/finish，不重复 transport 判定；现有
  content-filter/structured-output 分类保持原位；
- TaskTool 负责阻止历史数据或非标准 stub 再次投影为空成功。

### 4.1 AI SDK adapter：在首个信息丢失点精确分类

修改 `packages/opencode/src/session/llm/ai-sdk.ts`。

增加内部谓词，识别：

```ts
event.finishReason === "other" && event.rawFinishReason === undefined
```

该判定基于 AI SDK V3 full-stream contract，而不是 provider ID。只检查 `"other"`：
`finishReason="stop"` 等已知 unified reason 即使 raw 缺失也不在本修复中改判；`"other"` 且
raw 已定义则仍代表“有 provider 终止证据、但本地不认识其语义”。

在 `finish-step` 映射中：

1. 在 adapter state 记录本流已进入 terminal failure；
2. 仍先发出 `LLMEvent.stepFinish({ reason: "unknown", usage, metadata })`；
3. 紧接着发出 `LLMEvent.providerError`，固定消息为
   `Provider stream ended without a terminal finish event`；
4. `retryable` 明确为 `false`；
5. partial content 和 usage 必须在错误前按原顺序交付；
6. 不修改公共 `FinishReason` schema，不增加新的 SDK wire 值。

本 adapter 合成的 `provider-error` 是 terminal event，之后不能再向下游交付相互矛盾的 final
`finish(reason="unknown")`。若 AI SDK 在该 failure 后继续产生事件，adapter 应忽略它们；
收到对应 final `finish` 时只重置 adapter state，不再次发错，也不转发 `LLMEvent.finish`。
正常、未失败的 `finish` 仍按当前逻辑映射并重置 state。只出现 final `finish` 而没有任何
step terminal 的非标准实现由 Session 的 no-step-settlement 兜底处理。

当 `rawFinishReason !== undefined` 时，即使 unified 被映射为 `"unknown"`，adapter 也不因
这一点单独发错。这保留 provider-specific finish reason 的现有兼容性。

函数规约：`LLMAISDK.toLLMEvents(state, finishStep)`

- Requires：`finishStep.type === "finish-step"`，AI SDK 已完成本 step 的 content/tool 事件交付；
- Ensures：
  - 若 `finishReason === "other" ∧ rawFinishReason === undefined`，返回事件严格为
    `[step-finish(reason="unknown"), provider-error(retryable=false)]`；
  - 否则只返回一个 `step-finish`；
  - terminal provider error 之后不再输出其它 LLMEvent；对应 final `finish` 只负责重置 state；
  - usage/provider metadata 与当前实现等价；
- 副作用：只更新 adapter 的 step/counter/terminal 状态，不写 Session。

这比 Issue 中“只拦截空 unknown”更严格：只要 raw terminal evidence 缺失，即使已经有 partial
text 或完整 tool-call event，该 assistant turn 仍标记失败。理由是内容存在不能证明生成完整；
已经执行的 tool side effect 保留且不自动重放。raw 已定义的 unknown 继续由下层兼容规则处理。

### 4.2 SessionProcessor：建立跨 runtime 终态不变量

修改 `packages/opencode/src/session/processor.ts`。

在每次 stream attempt 开始时创建 4.0 定义的 `ProviderTurnEvidence`。多 step stream 必须按
`step-start → step-finish` 更新 `activeStep`，不能只记录“历史上曾收到任意 step-finish”，
否则“第一步完成、第二步截断”仍会漏报。

normal drain 后只运行一次互斥分类，顺序固定为：

```text
if not eligibleForGenericIncomplete: none
else if not credibleStepSettlement: no-step-settlement
else if lastStepFinish = "unknown" and not hasUsableOutput: empty-unknown
else: none
```

no-step-settlement 优先，避免“早期 unknown step 已完成、后一 step 未结算”同时命中两条规则并
发布两次 error。

增加两个分类分支。

#### 兜底 A：空 `unknown`

在 `Stream.runDrain` 正常返回后，若 `lastStepFinish === "unknown"`、
`eligibleForGenericIncomplete=true`，并且本 attempt 没有非空 text/完整 tool-call 输出证据，
则为同一个 assistant message 创建现有 `UnknownError`：

```text
Provider stream ended with an unknown finish reason and no usable output
```

该文案必须与 adapter 的“raw terminal evidence 缺失”错误区分。raw-defined
provider-specific reason 确实带有终止证据，不能对它错误地报告“missing terminal finish
event”。使用 `NamedError.Unknown({ message }).toObject()`，且不得包含 reasoning 内容或
provider secret metadata。

#### 兜底 B：流耗尽但没有可信 step settlement

若 `Stream.runDrain` 正常返回，且 `eligibleForGenericIncomplete=true`，同时
`credibleStepSettlement=false`，则创建另一条明确的 `UnknownError`：

```text
Provider stream ended without a settled model step
```

该分支将 `ctx.assistantMessage.finish` 设为 `"error"`。原因是没有 `step-finish` 可提供 durable
loop terminal；仅写 `assistant.error` 虽能停止当前 `process()`，但修复前 Prompt 顶部既有退出
分支以 `lastAssistant.finish` 为入口，且没有 error-first 判断。显式 `"error"` 为 Session
consumer 提供 durable terminal marker，4.3 的 persisted-error guard 则保证即使存在 tool
part 也不会在恢复时重放。empty-unknown 与 raw-missing 已有持久化的 `"unknown"`
step-finish，不改写它们的 finish，只增加 error。

这同时覆盖：

- 整个 stream 没有任何 `step-finish`，因而没有完成 Session step 的持久化结算；
- 早期 step 已完成，但最后一个 `step-start` 后没有 `step-finish`。

两类 fallback 都只在 normal drain 后执行。若 adapter 已经发出 `provider-error`，stream
先进入既有 failure/halt 路径，fallback 不运行，因此 adapter 的精确分类优先于 generic
empty-unknown/no-step-settlement 防御。`ctx.blocked=true` 时两类 fallback 也不运行，避免把
permission/question deny 覆盖成 provider incomplete。

这覆盖进入 legacy SessionProcessor 的 native runtime、测试 stub 和未来 adapter 在 EOF
时完全不发 finish 的情况；它不替代 2.5 所列 native Gemini partial-unknown 的协议特定
follow-up。

两类兜底都必须：

- 在内存中的 `ctx.assistantMessage` 设置 error，并依赖现有 `cleanup()` 末尾的
  `session.updateMessage()` 完成最终持久化；fallback 本身不增加一次重复写入；
- 只发布一次 `Session.Event.Error`；
- incomplete error 必须先于 compaction cutoff 落地；raw-missing 的
  `[step-finish(reason="unknown"), provider-error]` adapter batch 必须在 compaction cutoff
  判定前作为整体处理，具体修订见第十节；
- 保留已经由现有 event handler 持久化的 partial reasoning/text/tool/usage/snapshot；
- 不覆盖更具体的现有 error；
- 不把已由 `step-finish(reason="length")` 创建的 `MessageOutputLengthError` 降级为
  `UnknownError`；只有 final finish、没有 step-finish 的非标准流仍按 no-step-settlement 分类；
- 第十节除修正 raw-missing 的 batch/cutoff 顺序外，还把 persisted assistant error 与 blocked
  明确提升到正常返回时的 final `"stop"` 优先级；这会阻止 API/length error 或 permission deny 被
  usage compaction 结果覆盖。Abort 继续使用既有 Effect interruption 语义，不在本修订中承诺一个
  正常返回值。Auto context-overflow recovery 不持久化 assistant error，仍保持
  `"compact"`；其它 error-free compaction 路径不变。

函数规约：`SessionProcessor.process(streamInput)`

- Requires：输入 assistant 属于当前 session；LLM service 的 flat event/batch 均保持原有事件顺序；
- Ensures：
  - 正常返回 `"continue"` 时，`assistant.error` 必须为空，且
    `credibleStepSettlement=true`；
  - raw 缺失 adapter error、empty unknown 或 no-step-settlement drain 均持久化一个
    assistant error，并发布 exactly one Session error；同一 turn 不得因 token overflow
    在该 error 落地前返回 `"compact"`；
  - no-step-settlement 将 assistant finish 固化为 `"error"`，其它两类保留
    `step-finish(reason="unknown")`；
  - 已存在的更具体 error 与 `length` 分类不被覆盖；
- 副作用：保留并持久化已交付的 part/usage/snapshot；可能发布一次 Session error；incomplete
  settlement 本身不在当前 LLM stream/retry attempt 之外发起额外 provider request。

正确性论证：

- `activeStep` 在每个 `step-start` 建立，在随后的 `step-finish` 清除，因此 drain 时
  `activeStep=true` 精确表示最后一步未结算；
- `completedSteps=0` 捕获完全没有 step terminal 的空流/非标准 stream；
- 两者合成 `credibleStepSettlement`，覆盖单 step 与多 step 的所有正常退出；
- `lastStepFinish` 与输出证据按 attempt 重置，不会复用前一次 retry 的 finish/text/tool；
- text evidence 在 plugin 完成后判定，open partial 则直接读取 `ctx.currentText`；
- generic fallback 仅在 `assistant.error` 为空且 `blocked=false` 时创建，故不会覆盖高优先级
  error 或 permission/question deny。

### 4.3 Prompt loop：错误优先，禁止成功提升

修改 `packages/opencode/src/session/prompt.ts`，但不在这里重复 provider-specific 判定。

修复前顺序只在 structured 提升前特判 `MessageOutputLengthError`/`finish==="length"`；其它
`assistant.error` 要到后面的 `result==="stop"` 才生效。因此当 structured tool 已产生值、
随后同一 stream 截断时，`structured !== undefined` 分支会先执行。

修复顺序：

1. 每轮读取 `lastUser/lastAssistant` 后，若 `lastAssistant.error` 存在且
   `lastUser.id < lastAssistant.id`，在 tool-call continuation 判断前直接退出；新 user message
   的 ID 更新时不命中，仍允许用户在失败后继续会话；
2. 保持 length 专用 post-process 分支不变；
3. 紧接着对任意 `handle.message.error` 返回 `"break"`；
4. 只有无 error 时才允许 `structured !== undefined` 的成功提升；
5. `unknown` 无 error 的 raw-defined 兼容状态维持现有 loop 退出语义；
6. 无 error 的已有 tool call 循环逻辑不变。

函数规约：Prompt loop entry 与单轮 post-process

- Requires：entry 已加载当前 latest user/assistant；post-process 中 `handle.process()` 已返回，
  assistant message 已包含本轮最终 error/finish；
- Ensures：
  - 没有更新 user message 的 persisted assistant error 不会进入 provider/tool continuation；
  - `assistant.error !== undefined ⇒ structured` 不在该轮被新写入；
- 副作用：只增加 error-first 分支，不创建第二种 incomplete error，不修改 parts。

正确性论证：SessionProcessor 是 incomplete-stream error 的分类来源；Prompt entry guard 保证
crash/resume 后不重放失败 turn，post-process guard 保证同一进程中 error 不被 structured
success 覆盖，两处都不复制 raw finish/terminal evidence 规则，也不取代 Prompt 现有的
content-filter/structured-output 分类。

### 4.4 TaskTool：调用边界的防御性校验

修改 `packages/opencode/src/tool/task.ts`。

Task 边界使用已持久化结果定义：

```text
hasUsableOutput(result)
:= ∃ text part, text.trim().length > 0
 ∨ ∃ tool part, part.state.status ≠ "pending"
```

`pending` 只证明收到过不完整的 `tool-input-*`；当前 processor 只有处理完整 `tool-call` 后才会
把 part 推进到 `running`，因此 pending-only 不能作为“已有 tool call”的兼容证据。

在 `runTask()` 成功返回前增加防御：

- `assistant.error` 仍是最高优先级；
- `finish === "length"` 的现有兼容防御保持不变；
- `finish` 缺失，且没有非空 visible text/tool 输出时，Task 失败；
- `finish === "unknown"`，且没有非空 visible text/tool 输出时，Task 失败；
- 该分支使用独立 incomplete-response formatter，不能复用当前
  `!error => formatOutputLengthFailure()` 的错误假设；
- 错误诊断包含 child session ID 和 incomplete/unknown 状态；
- 不暴露 reasoning text；
- 既有 assistant-failure 分支中的 model-controlled message 继续经过现有 markup escaping 和
  大小限制；
- 前台、后台、background promotion 和 notification 必须得到一致状态。

固定 diagnostic 结构：

```text
Subagent task failed: IncompleteResponse
Child session: <sessionID>
finish_reason=<unknown|missing>
No visible output or complete tool call was produced
```

该 formatter 不读取 reasoning 或 model text；已有 `assistant.error` 分支仍使用
`formatAssistantFailure()`，继续通过现有 bounded/escaped rendering 传播 provider error
message。

这层不替代 adapter/Session 主修复。它只防止历史数据、stub 或未来调用方再次把空的未知
终态投影成 `completed`。

函数规约：`TaskTool.runTask()`

- Requires：`ops.prompt()` 返回 assistant message；
- Ensures：
  - `assistant.error` 存在或 `finish==="length"` 时维持现有失败行为；
  - `(finish===undefined ∨ finish==="unknown") ∧ ¬hasUsableOutput` 时返回 failed Effect；
  - 其它状态保持现有 `lastVisibleText()` 投影；
  - incomplete diagnostic 包含 child session ID，但不包含 reasoning text；
- 副作用：不修改 child transcript；foreground/background 均通过现有 BackgroundJob settlement
  把 failed Effect 记录成 error。

正确性论证：

- 主修复保证新产生的 raw-missing turn 已有 `assistant.error`，Task 首个失败分支会传播；
- missing/empty-unknown 分支覆盖旧数据和非标准 stub，阻止空 completed；
- raw-defined unknown 且有 usable output 不命中 defensive 分支，保持既有兼容行为。

### 4.5 错误优先级

从高到低：

1. 已存在的明确 assistant error，例如 abort、API error、auto compaction 关闭时持久化的 context
   overflow；
2. `finish="length"` 对应的 `MessageOutputLengthError`；
3. adapter 明确报告的“缺少原始终止原因”provider error；
4. Session 无 step settlement/空 unknown 兜底 `UnknownError`；
5. Task 边界 incomplete-response 防御。

低层级规则不得覆盖高层级错误。每个 assistant turn 最多发布一次 Session error。

### 4.6 网络接口契约检查

1. 连接模型
   - 原始修复中每次 retry attempt 调用一次 `LLM.Service.stream()`；第十节改用一次
     `streamBatches()`，两者都只建立一个底层 runtime stream；具体 HTTP step sequencing 仍由所选
     AI SDK/native runtime 负责；
   - HTTP 200 只表示响应头成功，不是模型完成证据；
   - 本修复不新增重连，也不把新连接拼接到旧 assistant turn；
   - 目标行为（需第十节补齐）是 adapter 检出 incomplete 后，Prompt/SessionRetry 不再因
     compaction 发起后续请求；检测时已经执行或 runtime 已经启动的 tool/HTTP side effect 无法
     回滚，因此只保留并显式报错。
2. 超时与截止时间
   - 既有 abort、timeout 和 stream error handling 保持现状，本修复不增加新 deadline；
   - 已被 runtime 表示为 timeout/error 的请求继续走既有显式 error；
   - 在 timeout 之前发生普通 drain 时，由 terminal evidence 校验识别 incomplete。
3. 重试与幂等
   - 合成的 incomplete terminal 不自动重试，最大次数为 0；
   - 当前 provider turn 没有 durable attempt identity、rollback 或统一幂等键；
   - 对本次新分类，opencode 不做代码层 replay；不对 provider/tool 的端到端
     exactly-once/effective-once 作保证。
4. 交付与顺序
   - LLMEvent 按现有 stream 顺序消费；
   - 已由现有 handler 接受的 reasoning/text/tool/usage 先持久化，再记录 terminal error；
   - 本次 incomplete attempt 的 partial state 不丢弃，且不由本修复重放；
   - 第十节保留单次 runtime emission 经 adapter 映射后的 batch 边界；Processor 处理完整 batch 后
     才检查 cutoff，且不为分类目的对下一次 runtime emission 发起 demand。
5. 失败模式
   - 对端/中间层 fail-stop 后若客户端只观察到 drain，无可信 terminal evidence 即失败；
   - 网络分区、慢响应在 timeout 前的状态不可知；本修复不引入 split-brain 或额外写入方；
   - partial failure 通过 assistant error、Session error 和 Task error 向调用方可见，不再静默忽略。
6. 状态与会话
   - 状态归属现有 `sessionID`、assistant message ID 和 child session ID；
   - partial transcript 保留在原 session；
   - N/A：不提供跨连接恢复，因为没有 attempt/continuation 协议。
7. 背压与流控
   - 不修改 Effect Stream 的 buffer、队列容量或并发；
   - 原始修复未改变 demand；第十节把 cutoff 从“每个映射后 event”移动到“每个原子 batch”，
     Processor 不会为判定 terminal error demand 下一 batch；
   - N/A：不新增独立队列或溢出策略；
   - 原始修复只增加固定数量的标量 evidence；第十节 AI SDK path 复用 adapter 现有数组，native
     path 增加短生命周期 singleton batch，不缓存累计 event，也不随 token/delta 数增长。

### 4.7 不自动重试

本修复不把 incomplete terminal 加入 `SessionRetry`。

理由：

- `SessionProcessor` 当前把 `provider-error` 转成普通 `Error`，`MessageV2.fromError()` 将其
  解析为 `UnknownError`；
- `SessionRetry.retryable()` 只接受 retryable/5xx API error、rate-limit 文案和既有 overload
  JSON 模式；canonical incomplete message 不匹配这些分支；
- adapter 同时显式设置 `retryable=false`，记录 provider event 的意图；
- 两个 generic fallback 在 `Stream.runDrain` 成功后设置 assistant error，但不让 Effect
  失败，因此 `Effect.retry()` 不会为它们启动下一 attempt；
- 当前 retry 包裹整个 stream consumption，没有 attempt identity；
- 已持久化的 partial part 没有事务回滚；
- tool/provider side effect 没有统一幂等键；
- 无法证明重放不会重复计费或执行外部操作；
- Issue #1 的 `length` 修复已经采用“保留 partial、终止、不重放”的一致策略。

未来若增加自动恢复，必须单独设计 attempt 隔离、幂等键、side-effect fence 和 transcript
合并协议，不能作为本 bug 的隐式附带行为。

### 4.8 用最小复现走一遍修正后逻辑

#### reasoning-only 截断

```text
reasoning delta + [DONE], no finish_reason
→ SDK finish-step(other, raw=undefined)
→ adapter: step-finish(unknown), provider-error
→ processor: reasoning/usage/finish 已保存，error 已持久化
→ prompt: stop
→ child Task/background: error
→ parent: 收到 tool error，可恢复或明确报告
```

父 agent 不会看到空 `completed`，但开发者仍能通过 child session 检查 reasoning part。
若同一情况直接发生在顶层 provider turn，Session error 使 plain CLI 非零退出。

#### partial text 截断

```text
text delta
→ SDK finish-step(other, raw=undefined)
→ adapter: step-finish(unknown), provider-error
→ processor: partial text 保留，error 已持久化
→ task/CLI: failure diagnostic + preserved partial transcript
```

partial text 不再被当作完整成功结果。

若同一 raw-missing `step-finish` 还触发 token overflow，第十节要求 Processor 在 compaction
cutoff 前完整处理 adapter 已生成的同一 batch；canonical `provider-error` 必须先落地，之后同样
走上述 error 路径，而不是创建 compaction。

#### provider-specific 原始终止值

```text
SDK finish-step(other, raw="provider_custom_stop")
→ adapter: step-finish(unknown), no synthesized provider-error
→ 有 text/tool 时维持兼容行为
→ 无 text/tool 时由 Session/Task 空 unknown 防御拦截
```

## 五、正确性论证

本节是整体修复的目标契约。当前 PR 的四个代码/测试提交完成了非 crossover 路径，但第九节的证据没有覆盖
raw-missing 与 compaction 同时发生的情况；第十节补齐该缺口后，本节不变量才在声明范围内完整
成立。

### 5.1 根因消除

- adapter 在 `rawFinishReason` 被丢弃前完成分类，消除首个不可逆信息丢失点；
- Session 不再允许“流已耗尽、无可信 step settlement/error”的 assistant 成为成功终态；
- Task 不再允许空 unknown/missing-finish child 被投影成 completed；
- Prompt 对 incomplete stream 只消费统一 error，不需要推断 provider transport 细节。

### 5.2 核心不变量

修复后必须保持：

```text
Task completed
⇒ child assistant.error is absent
∧ child assistant.finish ≠ "length"
∧ ¬((child assistant.finish ∈ {undefined, "unknown"}) ∧ ¬hasUsableOutput)
```

以及：

```text
AI SDK unified="other" ∧ rawFinishReason=undefined
⇒ assistant terminal error
```

和：

```text
stream drained ∧ no credible step settlement ∧ no prior error ∧ blocked=false
⇒ assistant terminal error ∧ assistant.finish = "error"
```

多 step 不变量：

```text
stream drained ∧ (completedSteps = 0 ∨ activeStep = true) ∧ no prior error ∧ blocked=false
⇒ assistant terminal error
```

Compaction crossover 修订后的 final result 不变量：

```text
assistant.error is present ∨ blocked=true
⇒ SessionProcessor.process() = "stop"
```

Recoverable context overflow 在 auto compaction 开启时不持久化 `assistant.error`，因此不与该不变量
冲突，仍可返回 `"compact"`。

### 5.3 Partial state 保持

raw-missing adapter 路径中，`step-finish` 必须先于 provider error 交付；generic fallback
则只在 normal drain 后分类。因此：

- reasoning/text part 不删除；
- tool part 不伪造回滚；
- usage/provider metadata 按现有规则保存；
- child session 保持可检查；
- 失败诊断不把 reasoning 内容复制给父 agent。

### 5.4 无回归引入

- 已知 `stop`、`length`、`tool-calls`、`content-filter`、`error` 的 provider finish 映射不变；
  persisted assistant error 的恢复入口新增 error-first 退出是本次明确的耐久性修正；
- `length` 继续使用专用 `MessageOutputLengthError`；
- raw 已定义的 provider-specific finish 不被 adapter 无条件判错；
- 已知 unified reason 不会仅因 raw 缺失被本次谓词改判；
- adapter terminal error 后不再交付相互矛盾的 final finish；
- 已存在错误不被 generic incomplete error 覆盖；
- permission/question deny 不被 generic incomplete error 覆盖；
- structured output 不得覆盖真实截断错误；
- completed tool 不自动重放；
- persisted assistant error 在无新 user message 时不因 tool part 绕过 loop entry guard；
- persisted error 后的新 user message 仍可继续会话；
- 顶层 CLI text/JSON 模式继续输出已收到的 partial events，只改变最终失败状态；
- child Task 失败不强制父会话最终失败；父 agent 仍可消费 tool error 后恢复；
- 前后台 Task 的 cancellation/promotion 语义保持现有契约。

### 5.5 Trivial 判定

不适用。本修复跨越 provider adapter、流状态机、持久化错误、Task 投影和 CLI 可观察行为，
属于非 trivial behavioral invariant correction，必须保留本计划、分层红测和回归审计。

## 六、测试用例清单

| 类型             | 用例描述                                                                                               | 状态（修复后回填） |
| ---------------- | ------------------------------------------------------------------------------------------------------ | ------------------ |
| 回归/Adapter     | `finish-step(other, raw=undefined)` 严格产生 `[step-finish(unknown), provider-error(retryable=false)]` | 已通过             |
| 顺序/Adapter     | raw 缺失且已有 partial text/reasoning 时，partial events 位于 terminal error 之前                      | 已通过             |
| 终态/Adapter     | raw-missing error 后的事件被抑制；final finish 重置 state，下一正常 stream 可复用 adapter              | 已通过             |
| 兼容/Adapter     | `finish-step(other, raw="provider_custom_stop")` 只映射 unknown，不合成错误                            | 已通过             |
| 兼容/Adapter     | `finish-step(stop, raw=undefined)` 保持 stop，不被 `"other"` 专用谓词误判                              | 已通过             |
| 回归/Processor   | empty unknown 使用“unknown/no usable output”错误，发布一次 error、返回 stop                            | 已通过             |
| 回归/Processor   | 整个 stream 无 step-finish/error 时使用 settled-step 错误并持久化 `finish="error"`                     | 已通过             |
| 契约/Processor   | 只有 final finish、没有 step-finish 时仍按 no-step-settlement 失败                                     | 已通过             |
| 多步/Processor   | 第一步正常 finish、第二步 start 后 drain 时仍失败                                                      | 已通过             |
| 互斥/Processor   | 早期 empty unknown、后一 step 未结算时只产生 no-step-settlement 和一次 error event                     | 已通过             |
| 兼容/Processor   | raw-defined unknown 且有 usable text/tool 时不被 empty-unknown fallback 拒绝                           | 已通过             |
| 优先级/Processor | 已有 provider/API error 不被 generic fallback 覆盖且只发布一次 error                                   | 已通过             |
| 优先级/Processor | length 仍产生 `MessageOutputLengthError`，不降级为 unknown                                             | 已通过             |
| 优先级/Processor | permission/question blocked turn 不被 generic fallback 改写为 provider error                           | 已通过             |
| 隔离/Processor   | retry attempt 重置 last finish/text/tool evidence，不读取前一 attempt 的状态                           | 已通过             |
| Plugin/Processor | `experimental.text.complete` 把 text 改空或补成非空时，usable-output 判定跟最终 part 一致              | 已通过             |
| 恢复/Prompt      | persisted error 即使带 completed tool part，在无新 user message 时也直接退出且不重放 provider          | 已通过             |
| 恢复/Prompt      | persisted error 后新增 user message 仍可正常生成下一 turn                                              | 已通过             |
| 回归/Prompt      | reasoning-only raw-missing 不重放、保留 reasoning、返回错误                                            | 已通过             |
| 回归/Prompt      | partial text raw-missing 保留 text、返回错误                                                           | 已通过             |
| 副作用/Prompt    | 前一 step 完成 tool、后一 step 截断时 tool 只执行一次，检测后无第三次 provider request                 | 已通过             |
| StructuredOutput | raw-missing incomplete error 不能被 structured success 覆盖                                            | 已通过             |
| 回归/Task        | empty unknown assistant 使前台 Task 失败并包含 child session ID                                        | 已通过             |
| 回归/Task        | missing finish 且无 usable output 使 Task 失败                                                         | 已通过             |
| 边界/Task        | whitespace text 与 pending-only tool part 均不算 usable output                                         | 已通过             |
| 兼容/Task        | unknown 加非空 text 或非-pending tool part 保持现有成功投影                                            | 已通过             |
| 隔离/Task        | incomplete diagnostic 不泄露 reasoning text                                                            | 已通过             |
| 状态/Task        | background job、notification 和 promotion 均传播 error                                                 | 已通过             |
| 安全/Task        | 既有 assistant-error message 仍转义 task markup 并受大小限制；新 formatter 不读取 model text           | 已通过             |
| E2E/CLI          | 顶层 reasoning-only no-finish 非零退出，数据库保留 unknown/error/reasoning                             | 已通过             |
| E2E/CLI          | 顶层 partial text no-finish 非零退出，partial text/JSON event 仍可观察                                 | 已通过             |
| E2E/Subagent     | 真实 child reasoning-only no-finish 使 Task part 为 error，child transcript 可查且 child turn 仅一次   | 已通过             |
| E2E/Recovery     | parent 收到 child Task error 后可生成恢复文本；父会话允许最终 exit 0                                   | 已通过             |
| 回归/CLI         | 翻转现有 text unknown exit-0 compatibility lock，同时保留 partial stdout                               | 已改并通过         |
| 回归/CLI JSON    | 翻转现有 JSON unknown exit-0 lock，保持 `partial → step_finish → error` 顺序且只有一个 error record    | 已改并通过         |
| 回归/Compaction  | summary stream 缺少 step settlement 时返回 stop，不发布 `Compacted` success                            | 已通过             |
| 契约/Retry       | canonical raw-missing `UnknownError` 不匹配 `SessionRetry.retryable()`                                 | 已通过             |
| 契约/LLM         | `LLMClient.stream()` partial/no-terminal 既有测试保持不变                                              | 已通过             |
| 全量             | 受影响测试文件全部通过                                                                                 | 已通过             |
| 静态             | `packages/opencode` typecheck 通过                                                                     | 已通过             |

所有“不重放”测试必须按 request marker 或目标 tool side-effect 计数，排除并发 title 请求。

实施阶段验证命令（使用仓库实际 package script/测试入口）：

```bash
cd packages/opencode
bun test --timeout 30000 \
  test/session/llm.test.ts \
  test/session/processor-effect.test.ts \
  test/session/retry.test.ts \
  test/session/prompt.test.ts \
  test/tool/task.test.ts \
  test/session/compaction.test.ts
bun test --timeout 90000 test/cli/run/run-process.test.ts
bun run typecheck

cd ../llm
bun test test/provider/openai-chat.test.ts
```

先按表中单个红测运行并确认修复前失败，再运行对应文件，最后执行上述受影响集合与 typecheck。

## 七、代码更新清单

| 文件                                                      | 函数 / 行号                       | 改动概述                                                                           | 状态（修复后回填） |
| --------------------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------- | ------------------ |
| `packages/opencode/src/session/llm/ai-sdk.ts`             | `adapterState`/`toLLMEvents`      | 使用 raw finish evidence 产生 canonical terminal error，并抑制 error 后的矛盾事件  | 已改               |
| `packages/opencode/src/session/processor.ts`              | `Context`/`handleEvent`/`process` | 跟踪 attempt-local step/output evidence，通过现有 cleanup 持久化两类 generic error | 已改               |
| `packages/opencode/src/session/prompt.ts`                 | loop entry/post-process ordering  | persisted error 先于 tool continuation；本轮 error 先于 structured success         | 已改               |
| `packages/opencode/src/tool/task.ts`                      | failure formatter/`runTask`       | 增加独立 incomplete-response 防御；复用现有 BackgroundJob error settlement         | 已改               |
| `packages/opencode/test/session/llm.test.ts`              | AI SDK adapter tests              | 覆盖 raw 缺失/已定义、已知 reason、partial ordering 和 terminal suppression        | 已加并通过         |
| `packages/opencode/test/session/processor-effect.test.ts` | processor settlement tests        | 覆盖两类 fallback、多 step、attempt/plugin 隔离、错误优先级和单次发布              | 已加并通过         |
| `packages/opencode/test/session/prompt.test.ts`           | prompt loop regressions           | 覆盖 reasoning/text/tool/structured、partial 保留和 no replay                      | 已加并通过         |
| `packages/opencode/test/tool/task.test.ts`                | Task foreground/background tests  | 覆盖防御、promotion、转义和 reasoning 隔离                                         | 已加并通过         |
| `packages/opencode/test/cli/run/run-process.test.ts`      | real CLI regressions              | 固化顶层/child no-finish，翻转旧 exit-0 断言，验证 parent recovery                 | 已加/已改并通过    |
| `packages/opencode/test/session/compaction.test.ts`       | summary settlement regression     | 验证共用 processor 的 no-step-settlement error 阻止 `Compacted` success            | 已加并通过         |
| `packages/opencode/test/session/retry.test.ts`            | incomplete retry contract         | 固化 canonical raw-missing UnknownError 不可重试                                   | 已加并通过         |

Adapter 的 raw-defined/raw-undefined 分支直接调用已导出的 `LLMAISDK.toLLMEvents()` 测试；
E2E raw-missing 使用现有 `reply().reason(...)` 且不调用 `.stop()`，无需扩展 test provider。

按工作流拆成四个串行实现单元，每个单元完成红测、实现、局部回归和状态回填后再进入下一单元：

1. [x] AI SDK adapter + adapter tests；
2. [x] SessionProcessor + retry/processor/compaction tests；
3. [x] Prompt/Task + 对应单元测试；
4. [x] CLI 父子 E2E、全量受影响回归、typecheck 和文档回填。

单元 1 的测试先在未修改 adapter 时得到 `1 pass / 2 fail`，失败分别证明缺少
`provider-error` 以及 error 后仍交付 late text/final finish。实现后新增 3 个契约测试通过，
完整 `test/session/llm.test.ts` 为 `38 pass / 0 fail`，`packages/opencode` 的
`bun run typecheck` 通过。补齐 reasoning 顺序断言后，adapter 分组为 `11 pass / 0 fail`。

单元 2 的 Processor 红测先得到 `2 pass / 6 fail`：失败均为当前代码把 empty unknown、
no-step-settlement、plugin-cleared text 或 retry 后的空 unknown 误判为 `continue`；兼容的
usable output 与 specific provider error 分支通过。compaction 的 no-step summary 红测也从
`continue` 失败。实现后 Processor 新增契约组为 `9 pass / 0 fail`；完整
`processor-effect.test.ts` 为 `27 pass / 0 fail`，`retry.test.ts` 为 `34 pass / 0 fail`，
`compaction.test.ts` 为 `57 pass / 1 skip / 0 fail`，`packages/opencode` typecheck 通过。

单元 3 的 Prompt 红测先得到 `4 pass / 2 fail`：失败分别证明 persisted assistant error 会因
completed tool 被重放，以及 missing-terminal error 会被 StructuredOutput 成功提升覆盖。Task
首次组合红测得到 `0 pass / 5 fail`，其中 foreground、promotion、background 三条直接断言为
错误状态却收到成功状态，两条三案例测试触发默认 5 秒上限；随后单独运行确认 missing/empty
边界断言在旧实现失败，而 usable-output 兼容用例在旧实现通过。实现后 Prompt 目标组为
`6 pass / 0 fail`，Task 目标组为 `5 pass / 0 fail`；完整 `prompt.test.ts` 为
`66 pass / 1 skip / 0 fail`，完整 `task.test.ts` 为 `37 pass / 0 fail`，
`packages/opencode` typecheck 通过。四个代码/测试改动文件的 Prettier check 通过；定向 oxlint 为
`0 error / 16 warning`，warning 均位于本单元未改动的既有代码行。

单元 4 先在真实回环端口和 CLI 子进程环境中运行两条旧 compatibility lock，得到
`0 pass / 2 fail`：两条断言都期望 `exitCode=0`，实际均为 `1`，证明底层修复已经通过现有
`session.error` 通道改变 CLI 终态。将夹具改为同一 provider turn 内 `reply().text/reason()`
后不调用 `.stop()`，新增的顶层 partial、顶层 reasoning 持久化、child Task 失败与 parent
recovery 四条 E2E 为 `4 pass / 0 fail / 34 assertions`。完整
`run-process.test.ts` 为 `18 pass / 0 fail / 97 assertions`；六个受影响 opencode 测试文件合计
`259 pass / 2 skip / 0 fail / 962 assertions`；`packages/llm` 的
`openai-chat.test.ts` 为 `27 pass / 0 fail / 41 assertions`。`packages/opencode` 与
`packages/llm` typecheck 均通过。CLI 源码无需修改：现有 `session.error` 消费分支已经把错误
记录到 JSON/text 输出并设置 `process.exitCode=1`。

明确不在本次清单中的文件：

- `packages/core/src/session/runner/llm.ts`
- `packages/llm/src/protocols/gemini.ts`
- `packages/llm/src/route/client.ts`

这些文件属于 2.5 的独立 follow-up；Issue #3 实施不得顺手修改。

## 八、文档更新清单

| 文档路径                                               | 要改什么                                                            | 状态（修复后回填） |
| ------------------------------------------------------ | ------------------------------------------------------------------- | ------------------ |
| `docs/fixes/session-fix-incomplete-provider-stream.md` | 记录当前基线、父子 E2E、根因、分布式契约、方案、证明和测试/代码状态 | 已完成并回填       |
| `docs/fixes/subagent-fix-output-length.md`             | 增加 Issue #3 follow-up，区分显式 `length` 与缺失终止帧             | 已完成             |

不修改公共 API/SDK schema、CLI 参数或配置文档。用户可观察行为会从 silent success 变为明确
失败，其契约、兼容边界和验证证据由本修复文档记录。

V2 follow-up 文档 `docs/fixes/session-v2-fix-missing-terminal-settlement.md` 不在本工作单元创建；
它需要独立复现、八部分计划和确认门，不能以 Issue #3 的文档代替。

## 九、最终五维审核

1. **一致性**：adapter、SessionProcessor、Prompt、Task 和 CLI 共用同一错误事实；Prompt/Task
   不重新推断 provider-specific raw finish，CLI 不创建第二种错误分类。
2. **风格**：实现沿用现有 Effect、Session error、BackgroundJob 和 `renderOutput()` 路径；
   没有新增依赖、公共 schema、配置项或并行状态机。
3. **正确性（原审核）**：raw 缺失、无 step settlement、persisted error、structured output、
   前后台 Task、CLI text/JSON、child transcript 和 parent recovery 均有测试；但这些用例没有把
   raw-missing 与 high-usage compaction 放在同一 turn，因此不足以证明 terminal error 总能到达
   Prompt/Task 边界。
4. **性能（原审核）**：adapter/processor 本身只增加固定数量的标量状态和终态分支，Task 的
   `hasUsableOutput()` 对已有 parts 线性扫描一次；但“没有新增网络请求”的结论遗漏了 crossover：
   被误判为 compact 后，既有 compaction summary 和 synthetic continuation 会带来额外 provider
   请求。
5. **可维护性**：canonical error 只在 adapter/processor 产生，Prompt 只做 error-first
   ordering，Task 只做调用边界防御；V2 runner 与 native Gemini 风险继续作为独立 follow-up，
   未混入本次 legacy 修复。

原审核结论在不触发 compaction 的路径上仍成立。PR #5 review 新发现的交叉条件证明“legacy
范围内已消除、无未解决 critical finding”不再成立；整体状态重新打开，以第十节的修订审核门
为准。

## 十、2026-08-04 Compaction cutoff 吞错修订计划

### 10.1 现象与复现

PR #5 review 发现，canonical raw-missing stream 与自动 compaction 同时发生时，已由 adapter
生成的 terminal `provider-error` 可能在 SessionProcessor 层被截断。AI SDK adapter 的事件顺序
是：

```text
partial reasoning/text/tool events
step-finish(reason="unknown", high usage)
provider-error("Provider stream ended without a terminal finish event")
```

Processor 当前的消费管线是：

```ts
Stream.tap((event) => handleEvent(event)),
Stream.takeUntil(() => ctx.needsCompaction),
Stream.runDrain,
```

`handleEvent(step-finish)` 先持久化 finish/usage，并在 usage overflow 时设置
`ctx.needsCompaction=true`。Effect `Stream.takeUntil` 包含触发停止条件的当前元素，但不会拉取下一
元素，因此紧随其后的 `provider-error` 不进入 `handleEvent`。

2026-08-04 在 `origin/yixiao-issue-3` 对应 production tree 上完成了三层临时审计复现；临时测试
改动均已撤销：

1. Effect 最小流 `step-finish -> provider-error` 在 tap 中由前一事件设置 cutoff 后，实际只观察到
   `step-finish`；
2. Processor 集成输入使用 context=20、output limit=10，wire usage 为 input=100/output=1，返回
   partial text 且无 raw finish；实际返回 `"compact"`，保留 `finish="unknown"` 和 partial text，
   但 `assistant.error` 为空；
3. Prompt E2E 为同一 session 依次准备 incomplete response、compaction summary response 和
   continuation response，实际发生 3 次 LLM 请求，最终返回正常 `finish="stop"`，原始错误完全
   不可见；临时断言同时验证 `llm.hits=3`、response queue 为空。StructuredOutput 变体还会把
   截断前的工具值提升为成功结果。

单元 1 在提交 `8c652ba107` 中把第二层复现固化为真实本地 SSE 回归。修复前单独运行得到：

```text
Expected: "stop"
Received: "compact"
0 pass
1 fail
```

该红测保留 partial text、high usage、raw-missing `[DONE]` 和单次 provider request，直接证明失败
发生在 Processor crossover，而不是 Prompt/Task 的后续投影。

吞掉 canonical `provider-error` 的最小交叉条件：

1. 自动 compaction 开启，模型具有有限且非零的 context limit；
2. AI SDK adapter 判定 `finishReason="other" && rawFinishReason===undefined`；
3. `step-finish` usage 达到 `SessionCompaction.isOverflow()` 阈值。

若还要从“错误类型丢失”进一步变成 silent success/hidden compaction，则需要第四个条件：在
`step-finish` 前已有非空 text 或完整 tool-call evidence，使 generic empty-unknown fallback 不命中。
Reasoning-only/empty 变体同样会吞掉 canonical error，但 generic fallback 会补一个较弱的 error，
因此不会进入 silent compaction；第十节仍要让它保留准确的 canonical error。

以下观测表对应具备 usable text/tool 的 silent-success 变体：

| 观测边界                              | 预期                                    | 实际                                             |
| ------------------------------------- | --------------------------------------- | ------------------------------------------------ |
| Processor result                      | `"stop"`，持久化 canonical error        | `"compact"`                                      |
| Assistant                             | `finish="unknown"` 且存在 error         | `finish="unknown"`、`error=undefined`            |
| Session event                         | exactly one `Session.Event.Error`       | 无 error event                                   |
| Compaction                            | 不创建 marker/summary，不 auto-continue | 创建 marker、summary，并可能继续生成             |
| StructuredOutput                      | 不提升成功                              | 可写入 `result.info.structured`                  |
| 本地复现中带 marker 的目标 LLM 请求数 | 当前 no-retry 契约下为 1                | compaction summary 与 auto-continue 均成功时为 3 |

出错路径：

```text
LLMAISDK.toLLMEvents()
  -> step-finish(unknown)
  -> provider-error(canonical raw-missing)
SessionProcessor.handleEvent(step-finish)
  -> persist finish/usage
  -> needsCompaction=true
Stream.takeUntil()
  -> stop before provider-error
settleIncomplete()
  -> usable text/tool => no fallback error
process()
  -> compact wins
Prompt loop
  -> structured promotion or compaction marker/summary/synthetic continue
```

该问题与 bounded retry follow-up 分离：这里修复“terminal failure 是否可靠到达 Session 状态机”；
只有该事实可靠落地后，retry 分类、次数上限和 tool-activity fence 才有可执行输入。

### 10.2 根因分析

直接症状是 `provider-error` 被吞掉；根因不是 adapter 未发错，也不是 Prompt 的 error-first guard
失效，而是两个相邻缺陷叠加：

1. `llm.ts` 把一次 `toLLMEvents()` 返回的数组 flatten 成独立 event，丢失“这些 event 来自同一
   runtime emission”的原子边界；
2. Processor 在每个 flatten 后 event 上把两个不同生命周期状态合并到同一个布尔量：

```text
compaction requested by usage
!=
event stream is safe to stop consuming
```

`step-finish` 是 step settlement，不是整个 event stream 的 terminal settlement。当前 AI SDK
adapter 在 canonical raw-missing 情况下必须先发 `step-finish` 以保留 usage/finish，再在同一个
返回数组中发 terminal `provider-error`。LLM service 先丢失数组边界，Processor 又在前一 event
上立即把“需要压缩”提升为“停止读取”，共同破坏了 adapter 已建立的原子映射契约。

后续三个机制只能放大问题，不能修复根因：

1. `settleIncomplete()` 为兼容 raw-defined unknown，允许 unknown 加 usable text/tool 正常结束；
   它无法从已丢失的事件恢复 raw-missing 事实；
2. `process()` 在返回值上以 `needsCompaction` 优先于 assistant error，但本场景甚至没有 error
   可供 Prompt guard 消费；
3. Prompt compaction 会创建 durable marker、调用 summary model 并合成 continuation，最终成功
   turn 可以掩盖原始失败。

这是内部 LLM stream contract 与 attempt-local state machine 的组合缺陷。公共 `FinishReason`/
`LLMEvent` schema、adapter 事件内容、Prompt/Task 对 assistant error 的消费契约都不需要改变；
需要补的是 opencode LLM service 的 batch-preserving 内部接口。

### 10.3 参考契约对照

本修订不是数值算法 bug。参考对象是本仓库 AI SDK adapter 已实现的事件顺序契约，以及 Effect
`Stream.takeUntil` 在同一输入上的实际语义。

| 步骤                    | 当前 Processor            | 参考事件契约                                              | 首个差异       |
| ----------------------- | ------------------------- | --------------------------------------------------------- | -------------- |
| partial content         | 持久化                    | 先于 terminal settlement 交付                             | 否             |
| `step-finish(unknown)`  | 持久化并立即 cutoff       | 只完成 step；同一 adapter batch 尚有 raw-missing failure  | **是**         |
| `provider-error`        | 同一 batch 内仍不再处理   | 同一 batch 的 terminal failure 必须交付 consumer          | 已由上一步导致 |
| final classification    | usable output => 无 error | raw-missing => terminal error                             | 已由上一步导致 |
| usage-driven compaction | 立即提升为 ready          | provisional unknown 只允许在 error-free settlement 后提升 | 已由上一步导致 |

对照位置：

- `packages/opencode/src/session/llm/ai-sdk.ts`：canonical 相邻事件由同一次 `finish-step` 映射产生；
- `packages/opencode/src/session/llm.ts`：adapter 返回的数组经 `Stream.fromIterable()` 顺序展开，
  两个事件之间不会插入其它 Session event；
- `packages/opencode/src/session/processor.ts`：tap 后的 `takeUntil` 和 compaction 状态提升；
- `packages/opencode/test/session/llm.test.ts`：
  `maps AI SDK stream chunks without losing session-visible fields` 固化单步 raw-defined unknown 后的
  final finish 示例；`turns a missing raw finish reason into a terminal provider error after partial output`
  固化 canonical pair 由一次 adapter 调用返回；
- `packages/opencode/test/session/processor-effect.test.ts`：
  `session.processor effect tests stop after token overflow requests compaction` 固化既有 known-finish
  cutoff；
- 已安装 `ai@6.0.168` 的 `streamText()` 控制流在 `finish-step` 后既可能直接发 final `finish`，也可能
  在已完成 client tool calls 后递归启动下一 model step；后者在发出下一 `start-step` 前已经调用
  `stepModel.doStream()`，因此“多拉一个 successor”可能新增并随后中止 provider 请求；
- `packages/llm/src/protocols/utils/lifecycle.ts`：正常 lifecycle 同样区分 step settlement 与 final
  finish；
- Effect 最小复现实测确认 cutoff 当前会保留 `step-finish` 并丢弃下一 `provider-error`。

因此，安全边界不是“unknown 后的下一个 event”，而是“同一次 upstream runtime emission 经
adapter 映射出的 event batch”。Canonical raw-missing pair 已在同一数组内，无需由 Processor
demand 下一次 AI SDK emission；raw-defined unknown 的下一 emission 则可能是 final `finish`，也可能
属于新的 model step，不能为分类目的主动 demand。当前没有在 native runtime 找到同样的
`step-finish(unknown) -> provider-error` producer，因此本修订只声称修复已复现的 legacy AI SDK
路径；其它 protocol-specific incomplete 序列仍属于 2.5 的 follow-up。

### 10.4 修复方案

修改 `packages/opencode/src/session/llm.ts` 与 `packages/opencode/src/session/processor.ts`，在
opencode 内部 LLM service 增加 batch-preserving stream。批次是 ephemeral internal type，不修改
`@opencode-ai/llm` 的公共 `LLMEvent` schema：

```text
LLMEventBatch := ReadonlyArray<LLMEvent>
```

批次不变量：

1. `batch.length > 0`；空 adapter mapping 在 LLM 层过滤；
2. 一个 batch 中的 event 全部来自同一次 upstream runtime emission，保持 adapter 返回顺序；
3. 不合并两个 upstream emission；AI SDK `toLLMEvents()` 的返回数组原样成为一个 batch；
4. native runtime 的每个现有 `LLMEvent` 包装为 singleton batch；
5. batch 只存在于内存流中，不持久化、不跨进程、不改变 provider wire protocol。

接口规约：`LLM.Service.streamBatches(input)`

- Requires：底层 runtime emission 有稳定顺序；AI SDK adapter 对一次 emission 只调用一次
  `toLLMEvents()`；
- Ensures：
  - AI SDK mapping 的非空数组逐个、按序产出为 batch，不拆分或跨 emission 合并；
  - native event 逐个产出为 singleton batch；
  - 调用只建立一个 runtime stream/subscription；Processor 完成当前 batch 后不会仅为分类目的对
    下一 batch 发起 demand；
  - 现有 flat `stream(input)` 从同一个 batch source 顺序展开，保持既有 consumer/test 可观察事件；
- Side effects：维持既有 AbortController acquire/release；相对当前 cutoff 不新增由本层发起的
  upstream demand、provider request demand、buffer、队列或并发 worker。

Processor 的事件与 settlement 规则：

1. `SessionProcessor` 改用 `streamBatches()`；每个 batch 内按数组顺序串行执行现有
   `handleEvent()`，完整 batch 成功处理后才由 `Stream.takeUntil(() => ctx.needsCompaction)` 检查
   cutoff；
2. `step-finish` 的 reasoning closure、usage、finish、step part、snapshot、message 与
   `needsCompaction` 计算顺序保持不变；
3. canonical batch `[step-finish(unknown), provider-error]` 中，前一 event 即使设置
   `needsCompaction=true`，后一 event 仍在同一个 batch 内进入现有 error handler 并使 batch 失败；
   `takeUntil` 不会在失败 batch 上执行下一次 cutoff 判定；
4. raw-defined unknown 的 `finish-step` mapping 只有一个 `step-finish` event；该 singleton batch
   完成后立即命中既有 cutoff，不 demand AI SDK 的下一 emission，因此 Processor 不会为分类目的
   请求 final `finish`、下一 `start-step` 或下一 provider step；
5. `Stream.runDrain` 正常返回后仍只运行一次现有 `settleIncomplete()`；empty unknown 在 final
   result 分类前创建 generic error；
6. `process()` 的 final result 顺序改为 error-first：

   ```text
   if blocked or assistant.error: "stop"
   else if needsCompaction: "compact"
   else: "continue"
   ```

   自动 context-overflow recovery 仍可返回 `"compact"`，因为该既有分支在 auto compaction 开启时
   只设置 `needsCompaction`，不把 recoverable overflow 持久化为 `assistant.error`；compaction-summary
   assistant 还受既有 `!assistant.summary` usage-overflow guard 保护，不会仅因 summary usage 设置
   `needsCompaction`；

7. 把 `ctx.needsCompaction=false` 与既有 `ProviderTurnEvidence` 重建放在每次 retry attempt 的入口；
   failed attempt 的 usage decision 不得泄漏到下一 attempt，batch 本身也没有跨 attempt 状态。该
   调整不回滚既有 retry 已持久化的 part/cost/tool 事实，也不扩大 retry 分类或次数。

选择该方案而不采用以下替代方案：

- 不把所有 unknown 加 usable output 改判失败：这会破坏 raw-defined provider-specific finish
  的既有兼容契约；
- 不采用 one-successor lookahead：当前 AI SDK 合法多步控制流可能在下一 `start-step` 前已经调用
  `stepModel.doStream()`；额外 demand 在 runtime 尚未预取时可能新增并随后 abort provider 请求，
  因而 lookahead 不能证明相对当前 cutoff 无网络副作用；
- 不把 raw-missing 标记复制进公共 event/schema 或 assistant metadata：adapter 已经发出准确的
  terminal error；保留既有 batch 边界即可，无需增加第二个事实来源；
- 不移除 `takeUntil` 并无条件 drain 所有 overflow stream：这可能允许后续 model step/tool
  activity；本方案只完成当前已经拉取的 adapter batch；
- 不调换 canonical pair 为 `provider-error -> step-finish`：现有 handler 在 provider error 上抛错，
  会使 usage/finish/step settlement 丢失；
- 不在 Prompt/Task 补猜 raw-missing：到达这些层时原始证据已经不可逆丢失。

函数规约：`SessionProcessor.process(streamInput)` 的 compaction settlement

- Requires：`streamBatches()` 满足上述批次不变量；当前 AI SDK canonical raw-missing batch 是
  `[step-finish(reason="unknown"), provider-error]`；
- Ensures：
  - canonical raw-missing 即使 usage overflow 且已有 usable output，也持久化 exactly one
    assistant error，并且当前 no-retry 契约下返回 `"stop"`；
  - `process()` 正常返回且 `assistant.error !== undefined` 或 `blocked=true` 时 final result 为
    `"stop"`，不返回 `"compact"`；
  - raw-defined unknown 加 usable output 且 overflow 仍返回 `"compact"`，且 Processor 不对下一
    AI SDK emission 发起 demand；无 usable output 时 generic incomplete error 优先，返回 `"stop"`；
  - retryable failed attempt 设置过的 `needsCompaction` 不影响下一 attempt；
  - known stop/tool-calls 等 finish 的既有 compaction cutoff 不变；
  - recoverable context overflow 在没有 persisted assistant error 时仍可返回 `"compact"`；
- Side effects：保留已交付 partial part、usage、snapshot 和已执行 tool 事实；不创建新 schema 或
  额外 `LLM.Service` subscription，Processor 不对下一 runtime emission 发起 demand。失败路径不创建
  compaction marker、compaction-summary assistant、
  `SessionCompaction.Event.Compacted`、synthetic continuation 或其对应的额外 model cost/usage。
  `step-finish` 已有的 `SessionSummary.summarize()` diff bookkeeping 保持不变，它不是 compaction
  model summary。Prompt loop 退出时既有的异步 `SessionCompaction.prune()` 无论成功或失败都会
  调度，本修订不改变它；“不创建 compaction side effect”不等于禁止该既有 prune 对历史 completed
  tool part 写入 `time.compacted`。

### 10.5 正确性论证

**根因消除**：修复保留 `toLLMEvents()` 已经表达的原子映射边界，把 compaction cutoff 从 batch
内部移动到 batch 成功处理之后。Canonical pair 无需 lookahead 就完整进入既有 handler；
raw-defined unknown 与 native singleton event 则仍在原位置 cutoff，Processor 不 demand 下一 runtime
emission。
Final result 再以 persisted error/blocked 优先，消除“同一 batch 先设 compact、后落 error”造成的
结果冲突。不靠内容启发式或下游补偿重建丢失事实。

核心顺序不变量：

```text
canonicalRawMissing
=> batch = [step-finish(unknown), provider-error]
```

```text
for each batch:
handleEvent(batch[0..n-1]) succeeds
precedes cutoff evaluation
```

```text
canonicalRawMissing && overflow
=> provider-error handled before any successful cutoff evaluation for that batch
```

```text
batch handling fails
=> takeUntil does not classify that batch as a successful compaction boundary
```

```text
assistant.error || blocked
=> process result = "stop"
```

```text
needsCompaction && !assistant.error && !blocked
=> process result = "compact"
```

```text
rawDefinedUnknownOverflow
=> cutoff after current singleton batch
∧ Processor does not demand the next upstream emission
```

**不变量保持**：step/usage/partial/tool 的持久化顺序不变；raw-defined unknown compatibility
不变；known finish 与 native event 的 immediate cutoff 不变；batch 不持久化，也不跨 attempt；
`needsCompaction` 与其它 attempt-local evidence 同时重置。生产 AI SDK path 复用 adapter 已创建的
数组，native path 只增加 singleton wrapper；不增加 token 相关状态、buffer、并发、subscription
或由 Processor 发起的 upstream demand。

**性能与背压**：处理复杂度仍为 `O(event count)`，batch 内保持串行，不引入并行 handler。AI SDK
path 复用 `toLLMEvents()` 已创建的数组；native path 每个 event 增加一个短生命周期 singleton
array，空间不随累计 token 增长。实现审核需确认没有缓存 batch，也没有改变 AbortController 的
释放时点。

**无回归引入**：

- raw-missing partial text、reasoning、StructuredOutput 和 completed tool 都统一依赖 canonical
  error，不新增分叉错误类型；
- Prompt 已有 error-first ordering 会阻止 structured promotion，并在 process 返回 stop 后退出；
- Task/CLI 已有 assistant/session error 消费路径继续生效；
- 已执行工具不回滚，但当前 no-retry 路径不会因 compaction 自动发起 compaction summary、
  continuation、新的本地工具动作或相应的额外 model cost/usage；
- raw-defined unknown high-usage 仍可正常 compaction，避免把兼容场景误判为 provider failure；
- length/high-usage 由 persisted `MessageOutputLengthError` 得到 `"stop"`；recoverable context overflow
  没有 persisted assistant error，仍得到 `"compact"`；
- compaction disabled、context limit 为 0、未 overflow 的现有路径没有行为变化。

**残余假设与边界**：正确性依赖 production AI SDK path 不在 `streamBatches()` 之后再次 flatten
再重建批次；静态/单元测试必须锁定该接口。Native runtime 当前每 event singleton，因此本修订
不把两个独立 native events 推断为同一原子 settlement；若未来 native producer 也需要表达
“step settlement + terminal error 不可拆分”，必须在其 adapter 层显式形成同一 batch。已在
runtime 内完成或由 runtime 自身预取的 tool/provider side effect 不回滚；本修订保证的是
Processor 不为分类目的 demand 下一 emission，不能把 runtime 内部 eager work 误写成 exactly-once。

### 10.6 测试用例清单

| 类型               | 用例描述                                                                                                                          | 状态（修复后回填）                       |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 契约/LLM           | raw-missing `finish-step` 的 `[step-finish, provider-error]` 保持在一个 batch，flat stream 顺序不变                               | 已通过（单元 1）                         |
| 契约/LLM           | raw-defined `finish-step` 是 singleton batch；consumer 停止后 source 的 next-emission demand count 为 0                           | 已通过（单元 1）                         |
| Wiring/Processor   | 注入 flat `stream()` 调用即失败的 service，证明 Processor 只调用一次 `streamBatches()`                                            | 已通过（单元 1）                         |
| 最小回归/Processor | raw-missing atomic batch + high usage + partial text：返回 stop、canonical error exactly once、保留 text/usage，subscription 为 1 | 已通过（单元 1）                         |
| 边界/Processor     | raw-missing atomic batch + high usage + reasoning-only：保留 canonical error，不降级为 generic fallback                           | 已通过（单元 1）                         |
| 兼容/Processor     | raw-defined unknown singleton + high usage + usable text：仍返回 compact、无 error、Processor next-batch demand count 为 0        | 已通过（单元 1）                         |
| Empty/Processor    | unknown singleton + high usage + no usable output：generic error 优先，返回 stop、Processor next-batch demand count 为 0          | 已通过（单元 1）                         |
| 优先级/Processor   | length + high usage 返回 stop；recoverable context overflow 无 persisted error 时仍返回 compact                                   | 已通过（单元 1）                         |
| 优先级/Processor   | blocked turn 即使已有 usage compaction 请求也返回 stop，不创建 compaction                                                         | 已通过（单元 1）                         |
| 隔离/Processor     | retryable failed batch 设置过 compaction 后，下一 attempt 重置 decision，不提前 cutoff                                            | 已通过（单元 1）                         |
| 回归/Prompt        | raw-missing + high usage + partial text：无 compaction marker/summary/continuation 或额外 compaction LLM 请求                     | 待加                                     |
| StructuredOutput   | high-usage raw-missing 在 StructuredOutput 后发生：structured 不提升、本地测试 tool 计数为 1、无 compaction/continuation 请求     | 待加                                     |
| Tool side effect   | high-usage raw-missing 在 completed tool 后发生：本地测试 tool 计数为 1、assistant/Task 失败且不 replay                           | 待加                                     |
| Event              | crossover 只发布一次 `Session.Event.Error`，不发布 `SessionCompaction.Event.Compacted`                                            | 待加                                     |
| Persistence        | 失败 assistant 的 `time.completed` 已定义、`finish="unknown"`、error name/message 为 canonical；重新进入 loop 不 replay           | 待加                                     |
| E2E/CLI            | 顶层 crossover 保留 partial 输出、记录一个 error、非零退出、无额外 compaction/continuation provider 请求                          | 待加                                     |
| E2E/Subagent       | child crossover 投影为 Task error 而非 completed；child tool 不重放                                                               | 待加                                     |
| 既有回归           | known stop high usage 仍立即请求 compaction；原 Issue #3 受影响集合全部通过                                                       | known stop 已通过；完整集合待单元 3      |
| 静态               | 单元 1 立即通过 `packages/opencode` typecheck；最终再通过 `packages/llm` typecheck、格式和 batch-interface usage 检查             | opencode/格式/usage 已通过；llm 待单元 3 |

所有请求数断言必须使用本地测试 provider 的专用 request marker，区分当前 turn、compaction summary
与 synthetic continuation，并排除并发 title 请求；batch demand 断言使用 Deferred/counter 记录下一
upstream emission 是否被 demand，不能只检查本地 handler。事件测试必须在触发请求前建立订阅，使用
Deferred/latch 等可观察信号，禁止固定 sleep 竞态。

实施顺序遵守先红后绿：先固化 LLM batch 与 Processor 最小回归并确认当前 flat stream 会拆开
canonical pair，再实现 batch-preserving interface 与 error-first result；随后逐层增加 Prompt、
tool/structured、CLI/Task 和 persistence 交叉测试，最后运行第六节已有受影响集合与 typecheck。

单元 1 绿灯证据：

- 真实 SSE 红测修复后为 `1 pass / 0 fail / 9 assertions`；
- 完整 `test/session/llm.test.ts` 为 `39 pass / 0 fail / 108 assertions`；
- 完整 `test/session/processor-effect.test.ts` 为 `33 pass / 0 fail / 210 assertions`；
- 完整 `test/session/compaction.test.ts` 为 `57 pass / 1 skip / 0 fail / 166 assertions`；
- 完整 `test/session/retry.test.ts` 为 `34 pass / 0 fail / 46 assertions`；
- 完整 `test/session/llm-native-recorded.test.ts` 为 `3 pass / 1 skip / 0 fail / 24 assertions`；
- `packages/opencode` 的 `bun run typecheck` 与五个变更文件的 Prettier 均通过，`git diff --check`
  无输出；全仓 `LLM.Service.of(...)` 仅余两个测试文件且均提供 required `streamBatches()`。

其中 `f2080642fd` 补强了两个容易误判的观察点：真实 raw-defined SSE 的 step settlement 是
singleton batch；Processor 测试把 successor 放在惰性 `Stream.fromEffect()` 中，raw-defined 与
empty-unknown cutoff 后 counter 均严格为 0。该断言观测 source evaluation，不再仅以 handler
未收到 successor 代替 backpressure 证据。

### 10.7 代码更新清单

| 文件                                                      | 函数 / 行号                                  | 改动概述                                                                 | 状态（修复后回填）                                     |
| --------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------ |
| `packages/opencode/src/session/llm.ts`                    | `Interface`/live stream factory              | 增加原子 `streamBatches()`；flat `stream()` 从同一 batch source 派生     | 已改（`612419fb31`）                                   |
| `packages/opencode/src/session/processor.ts`              | `process()` batch drain/final classification | batch 内顺序处理后再 cutoff；error/blocked 优先于 compact                | 已改（`612419fb31`）                                   |
| `packages/opencode/test/session/llm.test.ts`              | live adapter stream contract                 | 固化 batch 边界、flat 兼容和 no-next-emission demand                     | 已加并通过（`612419fb31`、`f2080642fd`）               |
| `packages/opencode/test/session/processor-effect.test.ts` | overflow settlement regressions              | 固化 partial/reasoning/raw-defined/empty、优先级和 exactly-one error     | 已加并通过（`8c652ba107`、`612419fb31`、`f2080642fd`） |
| `packages/opencode/test/session/compaction.test.ts`       | LLM service fixture/event guard              | 单元 1 同步 required batch interface；单元 2 证明无 completed compaction | fixture 已通过；event guard 待单元 2                   |
| `packages/opencode/test/session/prompt.test.ts`           | loop/structured/persistence regressions      | 证明不创建 compaction、不提升 structured、不 replay                      | 待加                                                   |
| `packages/opencode/test/tool/task.test.ts`                | completed-tool child boundary                | 证明 child/tool side effect 不被误报 completed 或重放                    | 待核对/待加                                            |
| `packages/opencode/test/cli/run/run-process.test.ts`      | real CLI/child E2E                           | 覆盖退出码、partial、单 error、请求次数和 Task 传播                      | 待加                                                   |

预期无需修改：

- `packages/opencode/src/session/llm/ai-sdk.ts`：当前返回数组与 canonical message 正确；
- `packages/opencode/src/session/prompt.ts`：error 可靠落地后，已有 error-first guard 足够；
- `packages/opencode/src/tool/task.ts` 与 CLI production code：已有 error propagation 足够；
- `packages/opencode/src/session/retry.ts`：本单元保持 raw-missing 不可重试；bounded retry 属于独立
  follow-up，不能与 failure-settlement 修复混合。

按 workflow 拆成三个串行实施单元，每个单元完成红测、实现/补测、局部回归和文档状态回填后
停下报告：

1. [x] LLM atomic batch contract + Processor batch cutoff/error-first result、最小/兼容红测、required
       service fixture 编译适配及 `packages/opencode` typecheck；
2. [ ] Prompt、StructuredOutput、completed tool、event 和 persistence 交叉回归；
3. [ ] CLI/Task E2E、完整受影响集合、typecheck、五维审核和 PR 说明同步。

### 10.8 文档更新清单与确认门

| 文档路径                                               | 要改什么                                                                  | 状态（修复后回填）              |
| ------------------------------------------------------ | ------------------------------------------------------------------------- | ------------------------------- |
| `docs/fixes/session-fix-incomplete-provider-stream.md` | 撤销旧 compaction 优先假设，记录 crossover 八部分计划、实施证据和最终审核 | 单元 1 已回填；最终审核待单元 3 |
| PR #5 body/comment                                     | 说明 failure-settlement 修复、交叉回归和验证结果                          | 待实现后更新                    |

不修改公共 API/SDK schema、CLI 参数或用户配置文档。本修订恢复原计划已经声明的“raw-missing
必须失败”契约，属于内部 ephemeral LLM stream contract 与状态机修正，不引入 user-facing 能力、
新模块边界或跨 feature 契约；所需数据/接口/函数规约已在 10.4 内完整定义，因此不另开 feature/
subplan。其它设计/README 没有新的契约需要同步。

2026-08-04 全文证据重审结果：

- Effect 最小流再次得到 handled events `["step-finish"]`，确认当前 `takeUntil` 确实吞掉 successor；
- batch 方案的 Effect 最小验证得到 canonical handled
  `["step-finish", "provider-error"]`，而 raw-defined singleton 只处理 `"step-finish"` 且下一 batch
  demand count 为 0；
- 已安装 `ai@6.0.168` 源码再次确认：多步 continuation 在下一 `start-step` 前调用
  `stepModel.doStream()`，据此否决 one-successor lookahead；
- 重新拉取 PR #5 的 issue comments、inline review comments 和 reviews；最新技术 finding 仍为
  `issuecomment-5170765949`，没有更晚的 review thread；
- PR #5 当前 base/head 与五个提交重新核对为 `dev@d12b1e924d -> yixiao-issue-3@dbed80fccf`；四个
  代码/测试提交与一个文档提交均已使用 rebase 后的当前 OID；
- 全仓 `LLM.Service.of(...)` 仅出现在 `processor-effect.test.ts` 与 `compaction.test.ts`；前者已在
  单元 1 的主测试文件清单中，后者必须同步 required `streamBatches()` fixture 并由单元 1 typecheck
  锁定；
- production `SessionProcessor.process()` 的 consumer 仅为 Prompt 与 SessionCompaction；Prompt 已有
  persisted-error guard，compaction summary 的 usage cutoff 受 `!assistant.summary` 保护，而 recoverable
  context overflow 不持久化 assistant error，因此 error-first 正常返回分类不会破坏 summary recovery；
- 本地 `issue3-pre-rebase@ee41b4d28a` 与当前 `dbed80fccf` 的 tree 均为 `20027f1623`，两者
  `git diff` 为空，因此 pre-rebase 的分层测试报告可对应到当前 PR tree；
- 原始六个 opencode 受影响测试文件重跑为
  `259 pass / 2 skip / 0 fail / 962 assertions`；
- CLI subprocess E2E 在允许 loopback listener 的环境重跑为
  `18 pass / 0 fail / 97 assertions`；
- native OpenAI Chat provider contract 重跑为 `27 pass / 0 fail / 41 assertions`；
- `packages/opencode` 与 `packages/llm` typecheck 均通过。

这些结果重新确认当前 PR 的四个代码/测试提交及其历史回填，没有替代第十节待加的 crossover
红测；现有全绿测试集合正因为缺少 high-usage raw-missing 组合，才没有捕获 reviewer finding。

2026-08-04 单元 1 实施结果：`8c652ba107` 保存修复前真实 SSE 红灯，`612419fb31` 实现并验证
batch-preserving stream、batch 后 cutoff、error/blocked-first 与 retry compaction reset，
`f2080642fd` 用真实 raw-defined SSE 和惰性 successor counter 补齐 singleton/backpressure 证据。
本地分支当前基于 `origin/yixiao-issue-3@dbed80fccf` 前进，未修改或恢复
`yixiao-issue-3-retry`；上述提交尚未推送，因此 PR #5 远端 head 仍是审计基线。

确认门：单元 1 已完成红绿测试、实现提交和文档回填；在此停下报告。未经下一次确认不进入
单元 2，不更新 PR body/comment，也不恢复 `yixiao-issue-3-retry` 中的 bounded retry 草稿。
