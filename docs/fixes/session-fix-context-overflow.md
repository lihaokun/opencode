# 修正方案 — V1 上下文溢出识别、发送前压缩与有界恢复

- 状态：实现与回归已完成；受影响测试和两个 package typecheck 通过；OpenCode 全量中的既有基线失败已按 workflow 分类
- 对应问题：[#11](https://github.com/lihaokun/opencode/issues/11)（GLM/ZhipuAI 溢出措辞未识别）、[#12](https://github.com/lihaokun/opencode/issues/12)（V1 缺少发送前完整载荷估算）
- 影响模块：`packages/llm` provider-error 分类；`packages/opencode` V1 request preparation、prompt loop、processor 与 compaction
- 当前工作树：#11 pattern、canonical payload 复用、`willOverflow`、三态 token、processor gate、replay format 修复及回归测试均已实现并验证，尚未提交
- workflow 路径：`docs/workflow.md` §7 bug-fix flow + §7.1 八部分修正方案

本修复关闭三个相互独立但会产生同一外部症状的缺口：

1. provider 已报告 context overflow，但 #11 的文案未被分类；
2. provider 尚未报告错误时，#12 的 V1 只能看到上一轮 usage，无法在发送前发现本轮完整请求已经越界；
3. 加入 preflight 后，V1 没有一次恢复预算，不可缩小的载荷会重复创建 overflow compaction。

---

## 第一部分：现象与复现

### 1.1 可见现象、影响范围与频次

生产观测中，`zhipuai-coding-plan` / `glm-5.3` 的一个 primary 会话在 66 分钟内记录了 36 次同一错误，期间没有形成有效压缩，会话无法继续：

```text
ERROR stream error providerID=zhipuai-coding-plan modelID=glm-5.3 agent=build mode=primary
      error.error="AI_APICallError: Prompt exceeds max length"
...（同一错误重复 36 次）...
```

环境与排除项：

- 观测版本：`1.18.6-fm`；
- 用户配置和项目配置均没有 `compaction` 键，`cfg.compaction?.auto !== false`；
- 不是用户关闭自动压缩；
- #11 对返回该措辞的 provider 为稳定触发；
- #12 对“上一轮 usage 仍低于阈值、当前完整请求单步跨线”的 V1 请求为稳定触发；
- 初版 preflight 的重复压缩对不可缩小的 system、tool schema 或当前用户载荷为稳定触发。

影响范围：

- #11 影响通过共享 provider-error classifier 解析该措辞的调用方；
- #12 与三态恢复只修改 legacy V1 `SessionPrompt.runLoop`；
- 正常可容纳请求、`compaction.auto=false`、普通 usage compaction 和 V2 Session runner 不应改变；
- 故障主要表现为会话卡住、重复 summary/provider 请求和额外费用，不涉及数据库消息物理删除。

### 1.2 可直接运行的最小复现

测试必须从对应 package 目录运行。

#### R1 — #11 GLM 文案分类

```bash
cd packages/llm
bun test test/provider-error.test.ts -t "classifies GLM/zhipuai 'Prompt exceeds max length'"
```

测试输入：

```text
Prompt exceeds max length
AI_APICallError: Prompt exceeds max length
Prompt exceeds the maximum length
```

修复前：三者不命中 `isContextOverflow`。当前工作树加入 pattern 后该聚焦测试通过。

#### R2 — #12 单步越界

```bash
cd packages/opencode
bun test test/session/prompt.test.ts -t "loop compacts oversized history before send and fully replays the current user turn"
```

夹具使用本地 `TestLLMServer`，不访问外部 API：

```text
旧历史约 70k tokens，可被 summary 请求容纳
+ 当前用户回合
+ system/tools/固定提示
= 当前 canonical pre-transport payload 超过 usable context
```

`dev` 基线在发送前没有该次完整载荷判断；修复后 preflight 与真实发送复用同一个 canonical payload，并由该用例验证 summary/replay 后完整恢复当前用户回合。

#### R3 — provider recovery 后再次 overflow

```bash
cd packages/opencode
bun test test/session/prompt.test.ts -t "loop persists a second provider context overflow after one recovery"
```

stub 响应序列：

```text
initial main request → HTTP 413 context overflow
summary request      → success
replayed main retry  → HTTP 413 context overflow
```

`dev` 基线在第三步后会再次返回 `"compact"`，测试以第 4 个请求作为 watchdog，因此稳定暴露第二次 summary；修复后第三步持久化真实 `ContextOverflowError`，不会出现第 4 个请求。

### 1.3 出错代码路径

以下行号以验证完成后的当前工作树为准，后续格式化或合并可能轻微移动。

#### #11 分类链

```text
LLM provider/AI SDK error
→ packages/opencode/src/session/processor.ts:694-759 SessionProcessor.process
→ processor.ts:662-692 SessionProcessor.halt
→ processor.ts:139-143 MessageV2.fromError
→ packages/opencode/src/session/message-v2.ts:676-701 APICallError branch
→ packages/llm/src/provider-error.ts:37-39 isContextOverflow
```

修复前首个差异点是 `provider-error.ts` patterns 不包含 `Prompt exceeds max length`，因此 `MessageV2.fromError` 得到普通 `APIError`，`halt` 无法进入 `ContextOverflowError` 分支。

#### #12 admission 链

```text
packages/opencode/src/session/prompt.ts:1081-1371 SessionPrompt.runLoop
→ prompt.ts:1170-1177 仅用 lastFinished.tokens 做历史 usage 判断
→ prompt.ts:1235-1284 组装候选 tools/system/model messages
→ prompt.ts:1300-1311 SessionProcessor.process → LLM
```

`dev` 基线在 `handle.process` 前没有当次完整载荷估算。修复后的 `prompt.ts:1305-1326` 先调用 `LLM.preparePayload`，并把同一个结果同时交给 `willOverflow` 与真实发送路径。

#### 重复恢复链

```text
provider ContextOverflowError
→ processor.ts:674-684 对 auto=true 一律设置 needsCompaction
→ processor.ts:757-759 返回 "compact"
→ prompt.ts:1351-1359 每次创建 overflow compaction
→ prompt.ts:1158-1167 下一迭代执行 summary/replay
→ 重新组装仍然超限的 payload
→ 再次进入相同路径
```

修复前的初版 preflight 也在每轮超限时无条件 `create(...overflow:true)`，因此 preflight 与 provider exception 两个入口都缺少恢复收敛状态；三态 token 与 processor attempt gate 现已为两个入口建立同一 episode 上界。

### 1.4 预期行为与实际行为

| Case                                                                     | 修复前 / 当前初版实际行为                                      | 本修复预期行为                                                  |
| ------------------------------------------------------------------------ | -------------------------------------------------------------- | --------------------------------------------------------------- |
| GLM HTTP 400 `Prompt exceeds max length`                                 | 普通 API error，不能进入 overflow recovery                     | 分类为 `ContextOverflowError`，在满足恢复条件时压缩一次         |
| 上一轮 usage 70%，本轮完整 payload 105%                                  | 发送前看不见单步越界；交给 provider 拒绝                       | 用 canonical pre-transport payload 发送前估算，先压缩旧历史     |
| preflight 压缩后本地仍估为过大                                           | 再次创建 compaction，可能无限 summary                          | 跳过一次本地 estimate，必须给 provider 一次真实判定             |
| provider recovery 后 retry 再 overflow                                   | 再创建第二个 overflow compaction                               | 保留 retry 的真实 `ContextOverflowError`，本 episode 终止       |
| 当前用户回合之前没有旧历史                                               | 现有 overflow compaction 会摘要当前用户并走 synthetic continue | 不创建 compaction；完整原请求真实发送一次，禁止错误驱动恢复     |
| 当前 attempt 已产生文本/reasoning/tool protocol evidence 后又报 overflow | 仍可能压缩并重试，导致重复内容或工具副作用                     | 视为上游异常响应，原错误终止；仅错误驱动分支受影响              |
| disabled oversized tool                                                  | 初版 preflight 估候选 tools，可能假阳性压缩                    | disabled/permission-denied tool 不进入 effective payload 和估算 |

---

## 第二部分：根因分析

### 2.1 根因 A：provider-error 分类表缺项

`isContextOverflow` 是 provider 错误进入 V1 `ContextOverflowError` 的分类边界。pattern 缺少 GLM/ZhipuAI 的稳定措辞，使真实溢出在到达 processor 前被错误降为普通 API error。补 pattern 直接消除分类根因，不引入新的错误类型。

### 2.2 根因 B：V1 使用滞后的上一轮 usage 代替当前 request

`compaction.isOverflow({ tokens: lastFinished.tokens, model })` 回答的是“上一轮完成后是否应该做普通 usage compaction”，不能回答“当前即将发送的请求是否可容纳”。缺失项包括：

- 当前新增消息与 parts；
- agent/provider prompt；
- project/instruction/MCP/skill system；
- `PromptInput.system`；
- structured-output 固定提示；
- effective tool definitions；
- `experimental.chat.system.transform` 与 provider-specific tool 调整。

因此 #12 的根因不是阈值数值错误，而是估算对象和时点错误。

### 2.3 根因 C：prompt 与 LLM 各自准备请求，估算输入会漂移

修复前初版工作树的 preflight 在 `prompt.ts` 手工组装部分 system/messages，并把 `SessionTools.resolve` 的候选 tools 直接交给 `willOverflow`；实际发送在 `session/llm/request.ts` 中再次：

- 合入 agent/provider prompt 和 `PromptInput.system`；
- 运行 system transform；
- 根据 user tools 与 permission 过滤；
- 加入 `strict:false` / Copilot `_noop` 等 provider 调整；
- 根据 transport 把 system 放入 messages、instructions 或 workflow system prompt。

继续在 `prompt.ts` 复制规则会产生新的 false positive/false negative。根因修复应建立一次 canonical preparation，并让 estimate 与 send 复用结果。

### 2.4 根因 D：overflow recovery 没有 episode 边界

V1 `dev` 基线只有 `"compact" | "continue" | "stop"` 结果，没有表达“该 provider attempt 是否紧随一次 overflow compaction”。于是：

- preflight 每次看到 overflow 都能创建 marker；
- processor 每次看到 `ContextOverflowError` 都能设置 `needsCompaction`；
- summary/replay 后没有状态阻止第二次 recovery。

三态 token 负责收敛，payload estimate 负责发现；二者责任不同，不能互相替代。

### 2.5 同类安全边界：已有 assistant evidence 的晚到 overflow

这不是原始 #11/#12 事故的触发方式。常见 context-limit admission error 会在输出前返回；正常 output token 上限应表现为 `finish: length`。

但如果上游 API 在同一个 provider attempt 已经发出 text/reasoning/tool protocol evidence 后又报告 `ContextOverflowError`，把该 attempt 当作“从未执行”重放会重复内容或工具副作用。V2 已拒绝恢复这类错误，本次在 V1 的 **错误驱动 ContextOverflow 分支**加入同样防线；preflight、usage compaction、正常 tool 多轮均不受影响。

### 2.6 明确不是根因、也不在本次修复范围

- `compaction.auto=false`：现有 preflight policy 与 processor terminal branch 已分别处理；它不是 token 状态；
- compaction summary 自身失败/interrupt 时暴露哪个错误：保持 V1 现状；
- 正常 usage 驱动 compaction：不生产、不消费 overflow token；
- cancel、进程重启后是否记住已经压缩：明确接受局部 token 丢失；
- compaction 期间并发写入新用户消息的 task ownership/replay 排序：是既有压缩机制问题，另建 follow-up issue；
- byte-exact wire tokenization：preflight 是保守近似，provider 仍是最终权威。

---

## 第三部分：参考实现对照（V2）

### 3.1 参考位置

- `packages/core/src/session/runner/llm.ts:173-216`：先构造当前 request，再调用 `compactIfNeeded`；
- `packages/core/src/session/runner/llm.ts:231-288`：只有 assistant 尚未开始时才接管 provider overflow；
- `packages/core/src/session/runner/llm.ts:355-380`：post-overflow attempt 不再传 recovery callback；
- `packages/core/src/session/compaction.ts:128-159`：V2 history selection；
- `packages/core/src/session/compaction.ts:172-235`：overflow compaction 与 request preflight；
- `packages/core/test/session-runner.test.ts` 中 overflow recovery、second overflow、summary failure 与 interruption 用例。

V2 的核心结构：

```ts
const request = LLM.request({ system, messages, tools, ... })
if (yield* compaction.compactIfNeeded({ entries, model, request })) continueAfterCompaction()

// 第一次普通 attempt 才拿到 recoverOverflow
runTurnAttempt(sessionID, promotion, step, compaction.compactAfterOverflow)

// 紧随 overflow compaction 的 attempt 不拿 recovery callback
runTurnAttempt(sessionID, promotion, step)
```

### 3.2 同一输入逐步对照

#### 输入 A：上一轮 usage 70%，当前 request 105%

| 步骤     | V1 `dev`                                  | V2                                           |
| -------- | ----------------------------------------- | -------------------------------------------- |
| 1        | 读取 `lastFinished.tokens=70%`            | 从当前 history/system/tools 构造 request     |
| 2        | `isOverflow=false`                        | `compactIfNeeded` 估算当前 request           |
| 3        | 直接发送 105% payload                     | 发现超限，先执行 compaction                  |
| 首个差异 | 当前 request 从未成为 V1 preflight 的输入 | request 在 provider 前就是 compaction 的输入 |

该首个差异即 #12 根因：V1 的观察对象落后一个 provider turn。

#### 输入 B：initial overflow → summary success → retry overflow

| 步骤             | V1 `dev` 基线                     | V2                                                  |
| ---------------- | --------------------------------- | --------------------------------------------------- |
| initial overflow | processor 返回 `"compact"`        | 普通 `runTurnAttempt` 可调用 `compactAfterOverflow` |
| summary/replay   | 下一 loop 迭代重建                | transition 到 `runAfterOverflowCompaction`          |
| retry overflow   | processor 再次返回 `"compact"`    | retry 没有 recovery callback，错误正常发布/持久化   |
| 首个差异         | retry 与普通 attempt 没有身份差异 | 调用图明确区分 post-overflow attempt                |

该首个差异即重复压缩根因：V1 缺少一次 recovery episode 的状态。

#### 输入 C：本 attempt 已经产生 assistant evidence 后报告 overflow

V2 在 `runner/llm.ts:237` 和 `:284` 同时要求 `!publisher.hasAssistantStarted()`；否则真实 provider error 进入普通失败发布。V1 `dev` 基线没有等价 gate；本修复复用 V1 已有的 `ProviderTurnEvidence`，只在当前 attempt 尚未产生 text/reasoning/tool protocol evidence 时允许恢复。

#### 输入 D：只有一个超大当前用户回合

V2 `select` 可以在单个序列化 message 内拆分 prefix/suffix，因此可能摘要该 message 的一部分。V1 本修复做出有意的更强约束：**当前用户回合保持完整**。没有更旧历史时不创建 summary，直接让 provider 判定一次。这是经确认的 V1 差异，不照搬 V2。

### 3.3 #11 的参考适用性

#11 是共享 classifier 的局部 pattern 缺项，不存在独立的 V2 算法可供对照。V2 同样依赖 `@opencode-ai/llm` 的 context-overflow classification；补充共享 pattern 是两条路径共同需要的修复。

### 3.4 不移植的 V2 机制

本修复不移植 V2 的 durable `session_input`、safe-boundary promotion、EventV2 projection、Context Epoch、Session History checkpoint 或 run coordinator。它们可以解决 V1 compaction 期间并发输入排序，但远超 #11/#12 的最小范围。

---

## 第四部分：修复方案

### 4.1 目标到模块映射

| 目标                                                   | 责任模块                                                              |
| ------------------------------------------------------ | --------------------------------------------------------------------- |
| G1：识别 GLM overflow 文案                             | `packages/llm/src/provider-error.ts`                                  |
| G2：估算当前 canonical pre-transport payload           | `session/llm/request.ts` + `session/llm.ts` + `session/compaction.ts` |
| G3：发送前压缩且保留当前用户回合                       | `session/prompt.ts` + 现有 `session/compaction.ts` replay             |
| G4：每个 overflow recovery episode 至多一次 compaction | `session/prompt.ts` 三态 token + `session/processor.ts` attempt gate  |
| G5：已有 assistant evidence 时不重放上游异常           | `session/processor.ts` current-attempt evidence gate                  |

### 4.2 #11：补充 GLM/ZhipuAI pattern

位置：`packages/llm/src/provider-error.ts` 的 `patterns`。

```ts
;/prompt exceeds (?:the )?max(?:imum)? length/i
```

它覆盖 `Prompt exceeds max length` 与 `Prompt exceeds the maximum length`，保留现有 exclusions，因此不会把 rate-limit `too many tokens` 等排除项重新归类。

### 4.3 #12-A：拆分并复用 canonical pre-transport payload

#### `LLMRequestPrep.preparePayload`

在 `packages/opencode/src/session/llm/request.ts` 新增内部类型和函数：

```ts
export type PreparedPayload = {
  readonly system: string[]
  readonly messages: ModelMessage[]
  readonly tools: Record<string, Tool>
}

export const preparePayload = Effect.fn("LLMRequestPrep.preparePayload")(function* (input) {
  // 组合 agent/provider + caller + PromptInput.system
  // 运行 experimental.chat.system.transform
  // 过滤 user-disabled / permission-denied tools
  // 应用 strict:false、Copilot _noop 与稳定排序
  return { system, messages: input.messages, tools }
})
```

`messages` 是尚未重复注入 system 的 canonical model messages。这样估算 `{system,messages,tools}` 时不会因为普通 transport 已把 system 放入 `Prepared.messages` 而双算；OpenAI OAuth、workflow 和普通 AI SDK transport 之后仍按现有方式放置 system。

现有 `prepare` 改为接受可选的 `PreparedPayload`：

```text
有 prepared payload → 直接复用
没有 prepared payload → 自行调用 preparePayload（summary/title/其它旧调用保持兼容）
→ 再执行 options、chat.params、chat.headers、auth/transport placement
```

preflight 不提前运行 `chat.headers`、认证或网络逻辑。`system.transform` 对每个 logical payload 仍只执行一次；发送阶段必须复用结果，不能重复 hook。

#### `LLM.Service` seam

在 `packages/opencode/src/session/llm.ts`：

- `LLM.Interface` 增加内部 `preparePayload(input)`；
- `StreamInput` 增加可选 `preparedPayload`；
- `LLM.run` 优先复用 `input.preparedPayload`，否则沿旧路径准备；
- compaction summary、title 和其它没有提供该字段的调用保持原行为。

这不是公共 Protocol/HttpApi 类型，不需要生成 SDK。

#### 估算边界

`SessionCompaction.willOverflow` 继续只负责 policy/budget：

```text
compaction.auto === false → false
model.context === 0       → false
Token.estimate(JSON.stringify({ system, messages, tools })) >= usable → true
```

prepared tools 的可序列化字段已包含名称、description、`inputSchema.jsonSchema` 与 `strict`；function 字段会自然忽略，不新增独立 tool serializer。

该值定义为 **canonical pre-transport estimate**，不是 byte-exact wire token count。后续 provider/SDK normalization、`chat.params` 对输出上限的调整仍可能造成阈值误差，因此 provider error recovery 保留为最终权威兜底。

### 4.4 #12-B：在现有 preflight 位置计算可压缩历史

位置保持在 `packages/opencode/src/session/prompt.ts:1230-1311`：assistant 已创建、tools/system/messages 已组装、`handle.process` 尚未调用。

不新增 `SessionCompaction.canCompact` Service API。直接从当前 active `msgs` 计算局部事实：

```ts
const currentUserIndex = msgs.findLastIndex((message) => message.info.id === lastUser.id)
const canCompact = msgs
  .slice(0, Math.max(0, currentUserIndex))
  .some((message) => message.info.role === "user" && !message.parts.some((part) => part.type === "compaction"))
```

`msgs` 已由 `MessageV2.filterCompactedEffect` 取得 active transcript。现有 `processCompaction` 的 `hasContent` 保留为防御性兜底，但 preflight 不再等到 marker 创建后才知道无历史可压缩。

### 4.5 #12-C：三态 `runLoop` 局部 token

在 `SessionPrompt.runLoop` generator 内、`while` 外声明唯一可变控制流变量：

```ts
type CompactionToken = "none" | "compacted" | "skip"

let compactionToken: CompactionToken = "none"
```

语义：

| 状态        | 含义                                                                                                     |
| ----------- | -------------------------------------------------------------------------------------------------------- |
| `none`      | 当前 main attempt 可以正常 preflight；若有旧历史，首次 provider overflow 可以恢复                        |
| `compacted` | 本 episode 已决定并占用唯一一次 overflow compaction 额度；状态跨 marker task、summary、replay 迭代保持   |
| `skip`      | 紧随 overflow compaction 的真实 main attempt；已跳过一次本地 estimate，provider exception 也不得再次恢复 |

token：

- 不绑定 user/assistant/replay/compaction message ID；
- 不写入 DB、schema、config 或 Session 级 `Map`；
- 不根据 transcript 推导；
- 每个 `runLoop` generator 独立，不同 Session 不共享；
- cancel、return、未捕获异常、scope 关闭或进程重启都会销毁它；下一 run 允许重新压缩一次。

#### Producer 1：preflight 首次 overflow

进入 preflight 时必须按“进入该段时的旧状态”只消费一次：

```ts
const token = compactionToken
const skipEstimate = token === "compacted"
if (token === "compacted") compactionToken = "skip"
if (token === "skip") compactionToken = "none"

const overflow = skipEstimate ? false : yield * compaction.willOverflow({ ...preparedPayload, model })
```

然后：

```text
overflow=false
  → 使用 prepared payload 进入真实 provider attempt

overflow=true && canCompact=true
  → token = compacted（先占用额度）
  → 删除本轮尚未发送的空 assistant
  → create(auto:true, overflow:true)
  → continue

overflow=true && canCompact=false
  → token = skip
  → 不删除 assistant、不创建 compaction
  → 完整原请求真实发送一次
```

如果 `create` 失败或被中断，run 直接退出，局部 token 随 generator 销毁。compaction task、summary 和 replay 均不修改 token。

#### Producer 2：首次 provider exception recovery

prompt 在发送 main attempt 前计算：

```ts
const recoverContextOverflow = compactionToken === "none" && canCompact
```

该值不包含 `auto=false`；自动压缩配置仍由 `willOverflow` 和 processor 现有 policy 分支独立处理，不属于 token 状态。

processor 只有在该许可为 true、auto 开启且本 attempt 没有 assistant evidence 时，才把 `ContextOverflowError` 转成现有 `"compact"` transition。prompt 收到 **exception-driven** `"compact"` 后：

```text
token = compacted（先占用额度）
→ create(auto:true, overflow:true)
→ continue
```

`result === "compact"` 还有正常 usage compaction 来源。prompt 继续以 `!handle.message.finish` 区分：

- `finish` 为空：overflow recovery，生产 `compacted`；
- `finish` 已存在：普通 usage compaction，不读写 token。

历史 `lastFinished.tokens` 分支同样不读写 token。

#### 两个 consumer

1. preflight consumer：`compacted → skip`，跳过恰好一次本地 estimate，确保压缩后有一次真实 provider 判定；`skip` 到达下一次独立 main preflight 时先重置为 `none`。
2. provider-exception consumer：attempt 收到的 `recoverContextOverflow=false` 时，不走特殊 `needsCompaction` 分支，原始 provider error 正常落盘并 `stop`。

完整状态机：

```text
none
 ├─ preflight/provider 首次 overflow + 有旧历史
 │    → token=compacted → one overflow compaction → summary/replay
 │    → 下一 main preflight: compacted→skip，跳过 estimate，真实发送
 │         ├─ provider overflow → 禁止 recovery，真实错误落盘，run 结束
 │         └─ provider 非 overflow 完成
 │              ├─ run 结束 → token 销毁
 │              └─ 需要下一 main turn → 下一 preflight: skip→none，开启新 episode
 │
 └─ preflight overflow + 无旧历史
      → token=skip → 不 summary → 完整请求真实发送
           ├─ provider overflow → 真实错误落盘，run 结束
           └─ provider 非 overflow 完成 → 同上
```

`compacted` 理论上不应直接进入 main provider request；processor 只看到 boolean gate，因此即使调用方旁路 preflight，只要 token 非 `none` 也不会允许第二次恢复。

### 4.6 #12-D：processor attempt gate 与真实错误持久化

在 `packages/opencode/src/session/processor.ts` 给 `Handle.process` 增加仅属于 main attempt 的可选 options，默认值保持 summary/旧调用兼容：

```ts
type ProcessOptions = {
  readonly recoverContextOverflow?: boolean
}

process(streamInput, options?)
```

`compaction.process` 生成 summary 时不传 runLoop token/options，继续使用现有 summary overflow 语义。

`SessionProcessor.halt` 的 ContextOverflow 分支调整为：

```text
summary assistant
  → 保持现有行为

普通 assistant 且 auto=false
  → 真实错误终止（现有行为）

普通 assistant 且 recoverContextOverflow=false
  → 真实错误终止

普通 assistant 且当前 attempt 已开始 assistant evidence
  → 真实错误终止

否则
  → needsCompaction=true，返回现有 "compact" transition
```

“真实错误终止”必须仍在 processor 的 `catch(halt) → ensuring(cleanup)` 边界内完成：

- `assistant.error = ContextOverflowError`，保留 provider message/responseBody；
- `assistant.finish = "error"`；
- 发布 `Session.Event.Error`；
- cleanup 写 `time.completed`；
- `process` 返回 `"stop"`。

prompt 不创建本地伪造的 overflow error，避免 completed-without-error 的中断窗口。

#### current-attempt evidence

复用并小幅扩展现有 `ProviderTurnEvidence`，记录当前 `process()` 调用是否收到以下任一 assistant-starting event：

- `text-start`；
- `reasoning-start`；
- `tool-input-start` 或无显式 start 的 `tool-call`。

每次 `process()` 开始都重置 evidence，因此：

- 之前 provider turn 的 tool call 和 tool result 不会阻止下一独立 attempt 的正常 overflow recovery；
- 只有“同一次 request 先产生 assistant evidence，随后上游又报 ContextOverflow”会禁止恢复；
- `finish:length`、普通 usage compaction 与正常多轮工具调用不进入该错误分支。

### 4.7 replay 与当前用户完整性

有旧历史时继续复用现有 `overflow:true` replay：summary 排除触发用户回合，成功后复制原 user 的 agent/model/variant/system/tools/format 与 parts，再进行 post-compaction attempt。

持久层读取出的 `format` 是 plain decoded value，而 V1 event/schema encoder 要求对应 schema-class instance。replay 因此按 `json_schema` / `text` discriminant 重建 `OutputFormatJsonSchema` 或 `OutputFormatText`；否则 reviewer-shaped `/message` 会在 summary 成功后因 replay event 编码失败而返回 500。

没有旧历史时不调用 replay/summary，直接发送原 user 对应的 prepared payload。因此当前用户的 system、tools、JSON schema 和 parts 不会被摘要替换成 synthetic continue。

replay 只负责 transcript 内容恢复，不承载 token 身份或生命周期。

### 4.8 用第一部分复现走修复后流程

#### R1 GLM HTTP 400

```text
Prompt exceeds max length
→ shared pattern 命中
→ MessageV2.fromError 生成 ContextOverflowError
→ token=none、有旧历史、无当前 attempt evidence
→ processor 返回 "compact"
→ token=compacted，创建一次 summary/replay
→ compacted→skip，真实 retry
→ retry 成功，或 retry overflow 真实落盘；均不再 summary
```

#### R2 单步越界

```text
准备 canonical system/messages/effective tools 一次
→ willOverflow=true
→ canCompact=true
→ 删除未发送的空 assistant
→ token=compacted，创建一次 overflow compaction
→ summary/replay 完成
→ 下一 preflight 跳过 estimate，token=skip
→ 使用 replay 的完整当前回合真实发送
```

#### R3 retry 再 overflow

```text
initial failure → one summary → post-compaction retry
→ retry 的 recoverContextOverflow=false
→ processor 持久化第二次 provider 的 ContextOverflowError
→ stop；没有第 4 个 overflow-recovery 请求
→ 再次调用 loop 返回同一 terminal assistant，不新增消息或请求
```

---

## 第五部分：正确性论证

### 5.1 关键假设

- H1：token estimator 是近似值；provider 的真实接受/拒绝是最终事实，因此任何本地 overflow recovery 后必须允许一次真实 provider attempt。
- H2：`MessageV2.filterCompactedEffect` 返回本轮 active transcript；`canCompact` 只判断当前用户之前是否存在普通用户历史。
- H3：overflow summary 成功才会进入 replay/retry；summary failure/interrupt 沿 V1 现有终止语义退出。
- H4：请求次数测试使用 `title:"Pinned"`、本地不可重试 stub，并排除普通 usage compaction、tool 后续 turn 和 transport retry。
- H5：V1 compaction 期间没有 durable admission/safe-boundary promotion；并发新输入排序是单独 follow-up，不作为本修复正确性的承诺。

### 5.2 根因消除

#### #11

`Prompt exceeds (the) max(imum) length` 进入 shared pattern 后，`parseAPICallError → MessageV2.fromError` 必然选择 `ContextOverflowError` 分支，而不是普通 `APIError`。这直接修复分类表缺项。

#### #12

`preparePayload` 输出当前 logical payload 的 system/messages/effective tools，prompt 用同一对象估算并由 LLM 复用。故原来遗漏 `PromptInput.system`、permission filtering 和 provider tool adjustment 的两套准备逻辑被合并；上一轮 usage 不再承担本轮 admission 判断。

#### 重复恢复

每个 overflow recovery episode 从 `none` 开始：

1. 只有 `none` 能生产 overflow compaction；生产前立即变为 `compacted`；
2. `compacted` 的下一 main preflight 必然变为 `skip`，且不执行 estimate；
3. `skip` 对应 attempt 的 recovery permission 必为 false；
4. 该 attempt overflow 时只能 terminal，不能回到 `compacted`；
5. 该 attempt 非 overflow 完成后，本 episode 结束；若 loop 需要新的 main turn，下一 preflight 才把 `skip` 重置为 `none`。

因此一个 episode 最多创建一个 `overflow:true` compaction。状态没有回边可在同一 episode 再次生产 compaction，循环有界。

#### 晚到 provider overflow

evidence 在每次 `process()` 开始重置，并在 assistant-starting event 时单调变为 true。`ContextOverflowError ∧ evidence=true` 只能进入 terminal branch，因此已持久化内容或 tool protocol 不会因自动 recovery 被重放。

### 5.3 不变量保持

#### Request preparation invariant

- Pre：`StreamInput` 包含原 user、agent、model、system/messages 与候选 tools。
- Post：system transform 与 effective-tool selection 对同一 logical payload 最多执行一次；transport-specific placement、params 和 headers 仍由原 `prepare` 完成。
- Preservation：旧调用不提供 `preparedPayload` 时仍由 `prepare` 自行生成，summary/title 行为不变。

#### Prompt loop invariant

- I1：token 只属于当前 generator；不同 Session/run 不共享。
- I2：`compacted` 表示额度已占用，在转成 `skip` 前不发送 main provider request。
- I3：`skip` 对应的 main attempt 不能触发 exception-driven overflow compaction。
- I4：普通 usage compaction 不生产、不消费 token。
- I5：`canCompact=false` 时不创建 overflow marker，因此当前用户回合不会进入 summary。

preflight、task 和 result 分支按 4.5 的状态转移分别保持 I1-I5。

#### Processor invariant

- recovery 允许且无 assistant evidence：保持既有 `"compact"` transition；
- recovery 禁止、auto=false 或已有 assistant evidence：真实错误、`finish:error`、Error event 与 `completed` 在 processor 内形成一个 terminal assistant；
- summary assistant 未接收 runLoop gate，保持现有 summary error 行为；
- 每次 process 重置 evidence，之前 turn 的输出不污染下一次判断。

#### Transcript/replay invariant

- 有旧历史：现有 replay 复制当前 user 的语义字段与 parts；
- replay 的 format 按 discriminant 重建 schema class，结构化结果可继续通过 V1 event/schema 边界；
- 无旧历史：不摘要、不 replay，直接发送原 user；
- terminal retry error 的 parent 是 replay user，第二次 `loop()` 返回同一 completed assistant。

### 5.4 无回归引入

- 正常 payload：canonical estimate 为 false，使用同一 prepared payload 正常发送；
- `auto=false`：`willOverflow=false`，processor 现有 policy 直接持久化 provider overflow，token 不参与配置判断；
- context limit 为 0：保持不做 preflight；
- disabled/permission-denied tools：既不发送也不估算；enabled schema 仍计入；
- structured output：`StructuredOutput` tool 与 system prompt 在 preparation 前加入，replay 保留 format；
- normal usage compaction：`assistant.finish` 已存在，不触发 token producer；
- `finish:length` 与 incomplete stream：错误优先级保持现有语义；
- summary failure/interrupt：保持现状；
- 正常多轮 tool：上一 attempt 的 evidence 不阻止下一 provider attempt 首次恢复；
- 公共 Protocol、HttpApi、数据库 schema 与错误类型均不改变。

### 5.5 请求上界的准确口径

上界只统计 **单个 overflow recovery episode 的逻辑 LLM 请求**：

| 入口                          | 最多序列                                                          |
| ----------------------------- | ----------------------------------------------------------------- |
| preflight overflow + 有旧历史 | summary → post-compaction main attempt（2）                       |
| provider overflow + 有旧历史  | initial failed main → summary → post-compaction main attempt（3） |
| 无旧历史                      | original main attempt（1），无 summary                            |

它不统计 title、普通 usage summary、tool 后续 turn、用户新输入或 SDK 对其它瞬时错误的 transport retry。聚焦测试通过固定 title 与不可重试 stub 才能精确断言 HTTP hit 数。

### 5.6 生命周期与降级边界

- 同一 active `runLoop` 的 while 迭代共享 token；
- post-compaction attempt 非 overflow 完成并进入新的 main turn时，`skip→none` 开启新 episode；
- cancel、run return、异常或进程重启销毁 token，下一 run 最坏额外压缩一次；这是明确接受的非持久化降级；
- 不新增 Session Map、durable marker、message-ID 绑定或 crash recovery；
- 并发 prompt ordering 不由 token 保证，见第八部分 follow-up。

---

## 第六部分：测试用例清单

所有需要模型 transport 的 session/API 回归使用进程内 OpenCode HTTP handler 与 `TestLLMServer` 本地 API stub，不依赖真实 provider key 或外部网络；纯分类和预算用例直接调用真实实现。

当前工作树未提交，表中的“通过”均对应 2026-08-17 本地验证结果，无 commit hash。

| 类型                        | 用例描述 / test name                                                                                                                       | 结果 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---- |
| 回归 #11 unit               | `classifies GLM/zhipuai 'Prompt exceeds max length' as context overflow (regression #11)`                                                  | 通过 |
| 回归 #11 loop               | `loop compacts and replays once after provider context overflow`，HTTP 400 使用 GLM 原文                                                   | 通过 |
| 回归 #12 unit               | `session.compaction.willOverflow` 的 payload、system-only、tools-only、normal、context=0、auto=false 六项矩阵                              | 通过 |
| 回归 #12 loop               | `loop compacts oversized history before send and fully replays the current user turn`                                                      | 通过 |
| 重复 provider overflow      | `loop persists a second provider context overflow after one recovery`；无第 4 请求、terminal error 持久化、再次 loop 幂等、新 run 有新额度 | 通过 |
| current-only                | `loop sends an oversized current-only user turn once without compaction`                                                                   | 通过 |
| PromptInput.system          | `loop accounts for prompt-specific system text before sending`                                                                             | 通过 |
| invariant instructions      | `loop terminates with overflow when invariant system context cannot fit`                                                                   | 通过 |
| effective tools             | disabled、permission-denied、enabled oversized tool 三项 preflight/wire 对照                                                               | 通过 |
| prepared payload            | `prepares canonical system and effective tools without transport hooks`                                                                    | 通过 |
| prepared reuse              | `reuses a prepared payload and runs transport hooks only for the real request`                                                             | 通过 |
| processor recovery=true     | `session.processor recovers a context overflow when the attempt is eligible`                                                               | 通过 |
| processor recovery=false    | `session.processor persists context overflow when attempt recovery is disabled`                                                            | 通过 |
| late overflow evidence      | text-start、reasoning-start、tool-input-start、tool-call 四项同-attempt overflow terminal 回归                                             | 通过 |
| auto=false                  | `loop stops provider overflow instead of auto-compacting when disabled` + `willOverflow` policy unit                                       | 通过 |
| usage compaction            | `post-overflow usage compaction does not create another overflow recovery`                                                                 | 通过 |
| incomplete stream crossover | 三条 high-usage missing-finish/structured/tool fixture 使用正常 context，错误优先级保持                                                    | 通过 |
| Session isolation           | `overflow compaction tokens stay isolated across concurrent sessions`                                                                      | 通过 |
| new run                     | second-overflow 用例在 terminal 后提交新 user，验证新 `runLoop` 可重新恢复一次                                                             | 通过 |
| API `/message`              | `POST /message preserves reviewer-shaped input through one preflight compaction`                                                           | 通过 |
| API `/prompt_async`         | `POST /prompt_async returns 204 before one preflight compaction completes`                                                                 | 通过 |

API 回归的额外断言：

- `/message`：HTTP 200；summary/replay 后 request 仍含 effective system、tools、schema 和全部 parts；最终 assistant 已完成、无 error 且 `structured` 符合 schema；恰一个 `overflow:true` compaction；
- `/prompt_async`：用 gate 阻塞 summary 或 main response，先观察 204，再释放并轮询 transcript；最终 assistant `finish:stop`，无第二次 overflow summary。

不纳入本修复测试矩阵：summary failure 错误归属、compaction 期间并发新输入排序。前者保持现状，后者另建 issue。

### 6.1 最终验证命令与结果

```bash
cd packages/llm
bun test test/provider-error.test.ts
bun typecheck
bun test

cd packages/opencode
bun test test/session/compaction.test.ts
bun test test/session/llm.test.ts
bun test test/session/processor-effect.test.ts
bun test test/session/prompt.test.ts
bun test test/server/session-prompt-overflow.test.ts
bun typecheck
bun run test
```

随后运行 `packages/llm` 与 `packages/opencode` 受影响模块的完整 test suite；任何失败按 workflow §5.4 分类，不通过修改正确契约来迁就生产缺陷。

2026-08-17 结果：

| 范围                              | 结果                                                                       |
| --------------------------------- | -------------------------------------------------------------------------- |
| `packages/llm bun typecheck`      | 通过                                                                       |
| `packages/llm bun test`           | `299 pass / 30 skip / 0 fail / 667 assertions`                             |
| `packages/opencode bun typecheck` | 通过                                                                       |
| 五个受影响 OpenCode 文件          | `243 pass / 2 skip / 0 fail / 1191 assertions`                             |
| `packages/opencode bun run test`  | `3347 pass / 22 skip / 1 todo / 13 fail`；按下述基线分类，受影响文件无失败 |

OpenCode 全量失败分类：

- 12 个失败集中在既有 `test/server/httpapi-sdk.test.ts`，表现为进程内 route layer 返回空 body 503 及其级联；在 `/tmp` 的干净 `HEAD` 快照运行同一完整文件也失败（`4 pass / 14 fail / 2 errors`），首个 health 请求同样是空 body 503，因此分类为基线/测试环境问题；
- 另 1 个 `test/plugin/openai-ws.test.ts` idle-prune 用例在全量高负载下超过 150ms；隔离重跑通过（80ms），分类为时序抖动；
- 两类失败均不位于本修复依赖路径，也未通过修改生产契约或放宽本修复断言规避。

---

## 第七部分：代码更新清单

| 文件                                                            | 函数 / 当前行号                                                                    | 改动概述                                                                                      | 状态（修复后回填）   |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------- |
| `packages/llm/src/provider-error.ts`                            | `patterns` / L6                                                                    | 加入 GLM/Zhipuai overflow pattern                                                             | 已实现并验证；未提交 |
| `packages/llm/test/provider-error.test.ts`                      | provider error classification / L21                                                | 三种 GLM 文案回归                                                                             | 已实现并验证；未提交 |
| `packages/opencode/src/session/llm/request.ts`                  | `PreparedPayload`、`prepare`、`preparePayload` / L44、L69、L192                    | canonical payload 拆分与复用；headers/params 留在 send 阶段                                   | 已实现并验证；未提交 |
| `packages/opencode/src/session/llm.ts`                          | `StreamInput`、`Interface`、`LLM.run` / L35、L57、L89                              | 暴露内部 payload preparation；可选 prepared payload 透传与复用                                | 已实现并验证；未提交 |
| `packages/opencode/src/session/compaction.ts`                   | `willOverflow`、overflow replay / L189、L453                                       | canonical components 估算；replay 重建 schema-class format，保留 structured output            | 已实现并验证；未提交 |
| `packages/opencode/src/session/prompt.ts`                       | `runLoop` / L1088、L1235、L1305-1370                                               | while 外三态 token；本地 `canCompact`；prepared preflight；两个 producer/consumer；usage 隔离 | 已实现并验证；未提交 |
| `packages/opencode/src/session/processor.ts`                    | `ProcessOptions`、`ProviderTurnEvidence`、`halt`、`process` / L34、L90、L681、L707 | attempt recovery gate；assistant-started evidence；禁止恢复时真实错误原子落盘                 | 已实现并验证；未提交 |
| `packages/opencode/test/session/compaction.test.ts`             | `session.compaction.willOverflow`                                                  | payload/policy unit matrix；LLM test double 适配                                              | 已实现并验证；未提交 |
| `packages/opencode/test/session/llm.test.ts`                    | request preparation tests / L1286                                                  | canonical payload、hook 次数与 prepared reuse                                                 | 已实现并验证；未提交 |
| `packages/opencode/test/session/processor-effect.test.ts`       | processor overflow tests / L1075                                                   | recovery true/false、四类 late evidence、terminal persistence                                 | 已实现并验证；未提交 |
| `packages/opencode/test/session/prompt.test.ts`                 | overflow/crossover matrix / L1303-2178                                             | preflight/provider recovery、三态生命周期、effective tools、Session 隔离、usage/crossover     | 已实现并验证；未提交 |
| `packages/opencode/test/server/session-prompt-overflow.test.ts` | 新文件 / L155、L223                                                                | `/message` reviewer-shaped 与 `/prompt_async` parts-only API 回归                             | 已实现并验证；未提交 |

不修改：Protocol schema、Server `HttpApi` route/handler、数据库 schema、generated client/SDK。

---

## 第八部分：文档更新清单

本修复改变 V1 内部可观察的 overflow recovery 不变量和重复错误的终止时机，因此文档清单不能写“无”。

| 文档路径                                               | 要改什么                                                                                                        | 状态（修复后回填） |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | ------------------ |
| `docs/fixes/session-fix-context-overflow.md`           | 本八部分方案：复现、V2 对照、三态状态机、正确性证明、测试结果、代码和文档清单                                   | 已回填；未提交     |
| `docs/fixes/session-fix-incomplete-provider-stream.md` | 将 recoverable context overflow 限定为 auto 开启、attempt recovery 被允许、当前 attempt 尚无 assistant evidence | 已同步；未提交     |

已搜索 `docs/research`、`docs/design`、`docs/spec`、模块 README 与 `expectations.md`：没有发现 V1 Session overflow recovery 的其它契约载体。`packages/llm/README.md` 只描述公共 LLM API/route，不描述 provider-error pattern，本次无需修改。

### 8.1 新的内部行为契约

- 一个 **overflow recovery episode** 最多创建一个 `overflow:true` compaction；不是整个 `runLoop` 永久只能压缩一次；
- 紧随 overflow compaction 的 main attempt 跳过一次本地 estimate，并禁止 exception-driven recovery；
- 该 attempt 非 overflow 完成后，后续独立 provider turn 可获得新的 recovery episode；
- 无旧历史时不摘要当前用户回合，完整请求真实发送一次；
- 同一 attempt 已经出现 assistant-starting evidence 后再报 ContextOverflow，视为上游 API 异常并原样终止；
- token 只存在于当前 generator；不同 Session 隔离，跨 run/cancel/restart 不保留。

### 8.2 公共 API 与生成物

- 不新增或修改 public Protocol、Server `HttpApi`、数据库 schema、错误码或错误类型；
- `/message` 与 `/prompt_async` 只新增入口级回归，不改变 200/204 契约；
- 不运行 client `bun run generate`，不生成 legacy JS SDK。

### 8.3 独立 follow-up issue

待创建：`fix(opencode): preserve prompt ordering during concurrent compaction`。

范围只记录 V1 既有压缩机制的并发窗口：compaction marker 创建或 summary 进行期间写入新 user，可能导致一个输入未被单独处理或 original/replay 顺序反转。它同时存在于旧的异常驱动压缩与新增 preflight 路径，但不是三态 token 导致，本次不修改 task ownership、replay ordering 或 admission 架构。

### 8.4 untyped provider error 分类补充

后续修复 [session-fix-untyped-context-overflow.md](./session-fix-untyped-context-overflow.md) 扩展了本方案的
错误分类入口：typed `APICallError` 与 structured stream parser 均未覆盖、原本会落入 `UnknownError` 的
generic failure，在 message 命中 shared `isContextOverflow()` 时同样生成既有 `ContextOverflowError`。

该补充不修改本文件定义的 preflight、processor recovery gate、三态 episode token 或 compaction replay
语义；它只让 LiteLLM/openai-compatible gateway 的 untyped overflow failure 能进入同一条既有恢复路径。

---

## 反模式自检

- #11 修改 shared classifier 根因，不在 prompt 里按 provider 特判；
- #12 估算当前 canonical payload，不继续依赖滞后的上一轮 usage；
- estimate 与 send 复用 preparation，不在 prompt 复制 system/tool 规则；
- token 是 runLoop-local convergence guard，不扩展成 durable、message-bound 或 Session-global 状态；
- 本地 estimate 不伪造 provider error；压缩后或无历史时都保留一次真实 provider 判定；
- exception recovery 只在当前 attempt 尚无 assistant evidence 时发生，不重放已产生副作用的异常响应；
- usage compaction、summary failure、auto=false 和 concurrent prompt ordering 均保持各自既有责任边界；
- 本实现按该统一根因、状态机和测试契约一次性收敛，没有再按单个红测追加局部 workaround。
