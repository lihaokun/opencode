# Provider 流缺失终止帧误报成功修正方案

- 状态：实施中；串行单元 1（AI SDK adapter）已完成，等待单元 2 确认
- 初稿日期：2026-07-27
- 重审日期：2026-07-28
- 对应问题：[Issue #3](https://github.com/lihaokun/opencode/issues/3)
- 影响模块：AI SDK LLM adapter、Session 流终态、Prompt agent loop、Task 前后台结果传播、CLI 退出状态
- 源码基线：`74637461887da7514fcc272846a1fdcd946b3aeb`
- 前置修复：`docs/fixes/subagent-fix-output-length.md`（Issue #1 / PR #2）
- 本次实施范围：legacy `SessionPrompt` / `TaskTool` 路径
- 独立 follow-up：V2 `SessionRunner` 与 native Gemini 的协议特定终态风险；本次不修改对应
  runner/protocol 文件

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

当前 opencode adapter 丢弃 `rawFinishReason`，并把不在本地枚举中的 `"other"` 映射成
`"unknown"`。Session 将其保存为普通 `step-finish`，但不创建 assistant error。Prompt
loop 随后退出，Task 又只检查 `error` 和 `finish === "length"`，最终把子任务登记成成功：

- 只有 reasoning 时，父 agent 得到空的 `<task_result>`；
- 已产生部分 text 时，父 agent 得到残缺文本；
- 前台和后台 Task 都可能被登记成 `completed`；
- 顶层 provider turn 直接发生同类截断时，plain CLI 可能空输出并退出 0；
- 子 Task 截断时，父 agent 当前看不到 tool failure，因而无法有意识地恢复或向用户报错。

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

### 1.3 当前 HEAD 本地实证

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

| 观测边界 | 实际值 |
|---|---|
| `opencode run` | `exitCode=0` |
| Task part state | `"completed"` |
| child assistant finish | `"unknown"` |
| child assistant error | `undefined` |
| child reasoning part | 已保存 `"unfinished child reasoning"` |
| child text part | 不存在 |
| child provider turn 数 | `1`，无自动重放 |

临时审计测试已经删除。实施阶段必须把同一父子链固化到
`packages/opencode/test/cli/run/run-process.test.ts`，并把断言翻转为 Task error。

另有两层现有证据：

- `packages/opencode/test/cli/run/run-process.test.ts` 的
  `unknown stream finish preserves partial output and exits 0` 证明 partial unknown 当前仍被
  锁定为成功；
- `packages/llm/test/provider/openai-chat.test.ts` 的
  `does not finalize streamed tool calls without a finish reason` 证明原生 `LLMClient.stream()`
  可以交付 partial events 而不产生 terminal event；完成性校验由持久化流 consumer 负责。

### 1.4 现有兼容性锁

`packages/opencode/test/cli/run/run-process.test.ts` 当前有两个用例明确锁定旧行为：

- `unknown stream finish preserves partial output and exits 0`
- `--format json records partial output for an unknown stream finish`

两个用例都断言 `exitCode === 0`，后者还断言最后一个事件是
`step-finish(reason="unknown")`。它们证明当前行为不是单一 UI 偶发现象，而是已被测试固定的
跨层语义。修复时必须有意识地更新这些断言，同时保留 partial output/JSON event 的可观察性。

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

关键位置：

- `packages/opencode/src/session/llm/ai-sdk.ts:21,87,111`
- `packages/opencode/src/session/processor.ts:421,435,703`
- `packages/opencode/src/session/prompt.ts:1110,1288,1299`
- `packages/opencode/src/tool/task.ts:121,311,328,439`
- `packages/opencode/test/cli/run/run-process.test.ts:299,430`

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

根因由四个连续缺口组成。当前默认执行路径的选择也有明确代码依据：
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

| 状态 | unified | raw | 语义 |
|---|---|---|---|
| 缺少终止帧 | `other` | `undefined` | 不完整，必须失败 |
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
- 当前安装的 `@ai-sdk/openai-compatible@2.0.41` 初始化
  `{ unified: "other", raw: undefined }`，只有真实 `finish_reason` 才更新二者，且 flush
  无条件发出 finish。
- 当前安装的 `ai@6.0.168` 把上述两项原样投影为 `finish-step.finishReason` 与
  `finish-step.rawFinishReason`。
- `ai@6.0.168` 的公开 full-stream 类型在 `finish-step` 和 final `finish` 上都声明
  `rawFinishReason: string | undefined`；该字段是 AI SDK V3 事件契约，不是
  OpenAI-compatible 私有扩展。
- 当前安装的 `@ai-sdk/anthropic@3.0.82` 同样以
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
- 当前 HEAD 的真实父子 Task E2E 得到 Task `completed`、child `finish=unknown`、
  `error=undefined`、reasoning-only、child provider turn 数为 1。
- 现有 CLI 测试明确断言 unknown stream finish 应退出 0。

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
- 自动重试可能在 partial tool activity 之后重放非幂等 provider turn。

范围决策：

1. Issue #3 只修改 legacy AI SDK/SessionProcessor/TaskTool 路径，因为这是已复现的生产路径；
   共享的 SessionProcessor generic fallback 也会保护进入 legacy consumer 的 native stream，
   但不声称解决 provider-specific partial-unknown；
2. V2 runner/Gemini protocol-specific 规则作为独立 non-trivial follow-up，实施前另写
   `docs/fixes/session-v2-fix-missing-terminal-settlement.md` 并单独确认；
3. 不修改 `LLMClient.stream()` 的全局契约，现有
   `does not finalize streamed tool calls without a finish reason` 测试保持不变。

## 三、参考实现对照（算法类 bug 必填）

本问题不是数值算法 bug，而是流协议状态机 bug。对照对象使用当前 lockfile 实际安装的
AI SDK，以及仓库内已实现完成性检查的 `LLMClient.generate()`。

| 步骤 | 输入 / 状态 | 当前实现 | 参考契约 | 首个差异 |
|---|---|---|---|---|
| 1 | stream 初始化 | opencode 尚未参与 | SDK 初始化 `unified=other, raw=undefined` | 否 |
| 2 | 收到真实 `finish_reason` | opencode 尚未参与 | SDK 同时更新 unified 和 raw | 否 |
| 3 | EOF/flush | SDK finish 被继续消费 | SDK 暴露最终 unified 和 raw | 否 |
| 4 | `finish-step` 映射 | 只读取 unified，`other => unknown` | raw 仍可判定是否见过真实终止原因 | **是** |
| 5 | stream consumer 完成性 | Session 正常 drain 即继续 | `LLMClient.generate()` 在 `LLMResponse.complete()` 为空时报 canonical provider error | 是 |
| 6 | Session 终态 | unknown 无 error | 缺少协议终态必须是失败或 incomplete | 已由步骤 4/5 导致 |
| 7 | Task 投影 | empty/partial completed | incomplete child 不可投影为 completed | 已由步骤 4/5 导致 |

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

不能在第一次非空 `text-delta` 时永久把 `hasVisibleText` 置为 true：当前
`processor.ts:529-537` 的 `experimental.text.complete` 可以改写完整 text。实现应在
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

`provider-error` 是 terminal event，之后不能再向下游交付相互矛盾的 final
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
loop terminal；仅写 `assistant.error` 虽能停止当前 `process()`，但当前 Prompt 顶部既有退出
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
- 未同时触发 compaction 时让 `process()` 返回 `"stop"`；若同轮已设置
  `needsCompaction=true`，保持当前 `"compact"` 优先级，由 4.3 的 Prompt error guard 终止；
- 保留已经由现有 event handler 持久化的 partial reasoning/text/tool/usage/snapshot；
- 不覆盖更具体的现有 error；
- 不把已由 `step-finish(reason="length")` 创建的 `MessageOutputLengthError` 降级为
  `UnknownError`；只有 final finish、没有 step-finish 的非标准流仍按 no-step-settlement 分类；
- 不改变 abort、permission deny、context overflow 和 compaction 的优先级。

函数规约：`SessionProcessor.process(streamInput)`

- Requires：输入 assistant 属于当前 session；`LLM.Service.stream()` 事件保持原有顺序；
- Ensures：
  - 正常返回 `"continue"` 时，`assistant.error` 必须为空，且
    `credibleStepSettlement=true`；
  - raw 缺失 adapter error、empty unknown 或 no-step-settlement drain 均持久化一个
    assistant error，并发布 exactly one Session error；无 compaction 时返回 `"stop"`，有
    compaction 时可保持当前 `"compact"` 返回值，但 Prompt 必须因 error 终止；
  - no-step-settlement 将 assistant finish 固化为 `"error"`，其它两类保留
    `step-finish(reason="unknown")`；
  - 已存在的更具体 error 与 `length` 分类不被覆盖；
- 副作用：保留并持久化已交付的 part/usage/snapshot；可能发布一次 Session error；不发起新的
  provider request。

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

当前顺序只在 structured 提升前特判 `MessageOutputLengthError`/`finish==="length"`；其它
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

1. 已存在的明确 assistant error，例如 abort、API error、context overflow；
2. `finish="length"` 对应的 `MessageOutputLengthError`；
3. adapter 明确报告的“缺少原始终止原因”provider error；
4. Session 无 step settlement/空 unknown 兜底 `UnknownError`；
5. Task 边界 incomplete-response 防御。

低层级规则不得覆盖高层级错误。每个 assistant turn 最多发布一次 Session error。

### 4.6 网络接口契约检查

1. 连接模型
   - 每次 retry attempt 调用一次 `LLM.Service.stream()`；具体 HTTP step sequencing 仍由所选
     AI SDK/native runtime 负责；
   - HTTP 200 只表示响应头成功，不是模型完成证据；
   - 本修复不新增重连，也不把新连接拼接到旧 assistant turn；
   - adapter 检出 incomplete 后，Prompt/SessionRetry 不再发起后续请求；检测时已经执行或
     runtime 已经启动的 tool/HTTP side effect 无法回滚，因此只保留并显式报错。
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
   - 本次 incomplete attempt 的 partial state 不丢弃，且不由本修复重放。
5. 失败模式
   - 对端/中间层 fail-stop 后若客户端只观察到 drain，无可信 terminal evidence 即失败；
   - 网络分区、慢响应在 timeout 前的状态不可知；本修复不引入 split-brain 或额外写入方；
   - partial failure 通过 assistant error、Session error 和 Task error 向调用方可见，不再静默忽略。
6. 状态与会话
   - 状态归属现有 `sessionID`、assistant message ID 和 child session ID；
   - partial transcript 保留在原 session；
   - N/A：不提供跨连接恢复，因为没有 attempt/continuation 协议。
7. 背压与流控
   - 不修改 Effect Stream 的 pull、buffer、队列容量或并发；
   - N/A：不新增独立队列或溢出策略；
   - 仅在事件处理和 drain 边界增加固定数量的标量状态，不随 token/delta 数增长。

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

#### provider-specific 原始终止值

```text
SDK finish-step(other, raw="provider_custom_stop")
→ adapter: step-finish(unknown), no synthesized provider-error
→ 有 text/tool 时维持兼容行为
→ 无 text/tool 时由 Session/Task 空 unknown 防御拦截
```

## 五、正确性论证

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

| 类型 | 用例描述 | 状态（修复后回填） |
|---|---|---|
| 回归/Adapter | `finish-step(other, raw=undefined)` 严格产生 `[step-finish(unknown), provider-error(retryable=false)]` | 已通过 |
| 顺序/Adapter | raw 缺失且已有 partial text/reasoning 时，partial events 位于 terminal error 之前 | 已通过 |
| 终态/Adapter | raw-missing error 后的事件被抑制；final finish 重置 state，下一正常 stream 可复用 adapter | 已通过 |
| 兼容/Adapter | `finish-step(other, raw="provider_custom_stop")` 只映射 unknown，不合成错误 | 已通过 |
| 兼容/Adapter | `finish-step(stop, raw=undefined)` 保持 stop，不被 `"other"` 专用谓词误判 | 已通过 |
| 回归/Processor | empty unknown 使用“unknown/no usable output”错误，发布一次 error、返回 stop | 待加 |
| 回归/Processor | 整个 stream 无 step-finish/error 时使用 settled-step 错误并持久化 `finish="error"` | 待加 |
| 契约/Processor | 只有 final finish、没有 step-finish 时仍按 no-step-settlement 失败 | 待加 |
| 多步/Processor | 第一步正常 finish、第二步 start 后 drain 时仍失败 | 待加 |
| 互斥/Processor | 早期 empty unknown、后一 step 未结算时只产生 no-step-settlement 和一次 error event | 待加 |
| 兼容/Processor | raw-defined unknown 且有 usable text/tool 时不被 empty-unknown fallback 拒绝 | 待加 |
| 优先级/Processor | 已有 provider/API error 不被 generic fallback 覆盖且只发布一次 error | 待加 |
| 优先级/Processor | length 仍产生 `MessageOutputLengthError`，不降级为 unknown | 待验证 |
| 优先级/Processor | permission/question blocked turn 不被 generic fallback 改写为 provider error | 待加 |
| 隔离/Processor | retry attempt 重置 last finish/text/tool evidence，不读取前一 attempt 的状态 | 待加 |
| Plugin/Processor | `experimental.text.complete` 把 text 改空或补成非空时，usable-output 判定跟最终 part 一致 | 待加 |
| 恢复/Prompt | persisted error 即使带 completed tool part，在无新 user message 时也直接退出且不重放 provider | 待加 |
| 恢复/Prompt | persisted error 后新增 user message 仍可正常生成下一 turn | 待加 |
| 回归/Prompt | reasoning-only raw-missing 不重放、保留 reasoning、返回错误 | 待加 |
| 回归/Prompt | partial text raw-missing 保留 text、返回错误 | 待加 |
| 副作用/Prompt | 前一 step 完成 tool、后一 step 截断时 tool 只执行一次，检测后无第三次 provider request | 待加 |
| StructuredOutput | raw-missing incomplete error 不能被 structured success 覆盖 | 待加 |
| 回归/Task | empty unknown assistant 使前台 Task 失败并包含 child session ID | 待加 |
| 回归/Task | missing finish 且无 usable output 使 Task 失败 | 待加 |
| 边界/Task | whitespace text 与 pending-only tool part 均不算 usable output | 待加 |
| 兼容/Task | unknown 加非空 text 或非-pending tool part 保持现有成功投影 | 待加 |
| 隔离/Task | incomplete diagnostic 不泄露 reasoning text | 待加 |
| 状态/Task | background job、notification 和 promotion 均传播 error | 待加 |
| 安全/Task | 既有 assistant-error message 仍转义 task markup 并受大小限制；新 formatter 不读取 model text | 待加 |
| E2E/CLI | 顶层 reasoning-only no-finish 非零退出，数据库保留 unknown/error/reasoning | 待加 |
| E2E/CLI | 顶层 partial text no-finish 非零退出，partial text/JSON event 仍可观察 | 待加 |
| E2E/Subagent | 真实 child reasoning-only no-finish 使 Task part 为 error，child transcript 可查且 child turn 仅一次 | 待加 |
| E2E/Recovery | parent 收到 child Task error 后可生成恢复文本；父会话允许最终 exit 0 | 待加 |
| 回归/CLI | 翻转现有 text unknown exit-0 compatibility lock，同时保留 partial stdout | 待改 |
| 回归/CLI JSON | 翻转现有 JSON unknown exit-0 lock，保持 `partial → step_finish → error` 顺序且只有一个 error record | 待改 |
| 回归/Compaction | summary stream 缺少 step settlement 时返回 stop，不发布 `Compacted` success | 待加 |
| 契约/Retry | canonical raw-missing `UnknownError` 不匹配 `SessionRetry.retryable()` | 待加 |
| 契约/LLM | `LLMClient.stream()` partial/no-terminal 既有测试保持不变 | 待验证 |
| 全量 | 受影响测试文件全部通过 | 待跑 |
| 静态 | `packages/opencode` typecheck 通过 | 单元 1 后已通过；最终单元待复跑 |

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

| 文件 | 函数 / 行号 | 改动概述 | 状态（修复后回填） |
|---|---|---|---|
| `packages/opencode/src/session/llm/ai-sdk.ts` | `adapterState`/`toLLMEvents` | 使用 raw finish evidence 产生 canonical terminal error，并抑制 error 后的矛盾事件 | 已改 |
| `packages/opencode/src/session/processor.ts` | `Context`/`handleEvent`/`process` | 跟踪 attempt-local step/output evidence，通过现有 cleanup 持久化两类 generic error | 待改 |
| `packages/opencode/src/session/prompt.ts` | loop entry/post-process ordering | persisted error 先于 tool continuation；本轮 error 先于 structured success | 待改 |
| `packages/opencode/src/tool/task.ts` | failure formatter/`runTask` | 增加独立 incomplete-response 防御；复用现有 BackgroundJob error settlement | 待改 |
| `packages/opencode/test/session/llm.test.ts` | AI SDK adapter tests | 覆盖 raw 缺失/已定义、已知 reason、partial ordering 和 terminal suppression | 已加并通过 |
| `packages/opencode/test/session/processor-effect.test.ts` | processor settlement tests | 覆盖两类 fallback、多 step、attempt/plugin 隔离、错误优先级和单次发布 | 待加 |
| `packages/opencode/test/session/prompt.test.ts` | prompt loop regressions | 覆盖 reasoning/text/tool/structured、partial 保留和 no replay | 待加 |
| `packages/opencode/test/tool/task.test.ts` | Task foreground/background tests | 覆盖防御、promotion、转义和 reasoning 隔离 | 待加 |
| `packages/opencode/test/cli/run/run-process.test.ts` | real CLI regressions | 固化顶层/child no-finish，翻转旧 exit-0 断言，验证 parent recovery | 待加/待改 |
| `packages/opencode/test/session/compaction.test.ts` | summary settlement regression | 验证共用 processor 的 no-step-settlement error 阻止 `Compacted` success | 待加 |
| `packages/opencode/test/session/retry.test.ts` | incomplete retry contract | 固化 canonical raw-missing UnknownError 不可重试 | 待加 |

Adapter 的 raw-defined/raw-undefined 分支直接调用已导出的 `LLMAISDK.toLLMEvents()` 测试；
E2E raw-missing 使用现有 `reply().reason(...)` 且不调用 `.stop()`，无需扩展 test provider。

按工作流拆成四个串行实现单元，每个单元完成红测、实现、局部回归和状态回填后再进入下一单元：

1. [x] AI SDK adapter + adapter tests；
2. [ ] SessionProcessor + retry/processor/compaction tests；
3. [ ] Prompt/Task + 对应单元测试；
4. [ ] CLI 父子 E2E、全量受影响回归、typecheck 和文档回填。

单元 1 的测试先在未修改 adapter 时得到 `1 pass / 2 fail`，失败分别证明缺少
`provider-error` 以及 error 后仍交付 late text/final finish。实现后新增 3 个契约测试通过，
完整 `test/session/llm.test.ts` 为 `38 pass / 0 fail`，`packages/opencode` 的
`bun run typecheck` 通过。补齐 reasoning 顺序断言后，adapter 分组为 `11 pass / 0 fail`。

明确不在本次清单中的文件：

- `packages/core/src/session/runner/llm.ts`
- `packages/llm/src/protocols/gemini.ts`
- `packages/llm/src/route/client.ts`

这些文件属于 2.5 的独立 follow-up；Issue #3 实施不得顺手修改。

## 八、文档更新清单

| 文档路径 | 要改什么 | 状态（修复后回填） |
|---|---|---|
| `docs/fixes/session-fix-incomplete-provider-stream.md` | 记录当前基线、父子 E2E、根因、分布式契约、方案、证明和测试/代码状态 | 实施中；单元 1 已回填 |
| `docs/fixes/subagent-fix-output-length.md` | 增加 Issue #3 follow-up，区分显式 `length` 与缺失终止帧 | 待改 |

不修改公共 API/SDK schema、CLI 参数或配置文档。用户可观察行为会从 silent success 变为明确
失败，其契约、兼容边界和验证证据由本修复文档记录。

V2 follow-up 文档 `docs/fixes/session-v2-fix-missing-terminal-settlement.md` 不在本工作单元创建；
它需要独立复现、八部分计划和确认门，不能以 Issue #3 的文档代替。
