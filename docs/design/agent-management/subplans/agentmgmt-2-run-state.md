# 子计划设计 — agent-management / `agentmgmt-2-run-state`

> 四个 issue 的合并子计划：子 agent 的 run 身份与时序。
>
> - #75 父 agent 分不清子 agent 的时序和数量：run 编号与时间、`agent_status`、`agent_list` 过滤与上限、每步末尾的进度视图
> - #81 没有同步的停止钩子：子 agent 的完成在插件把关之前就到了父那里
> - #73 的服务端一半：agent 发来的消息打上发送方标记（TUI 一半不在本子计划内）
> - #76 的末尾段机制已在 `step-tail` 分支落地（`bfc07a0e80`、`97b272f37f`），本子计划在其上加进度视图
>
> 范围：**只做服务端与模型可见表面**。TUI 对 `agent_message` / `stop_hook` 标记的渲染（#73、#90）不在本子计划内。
> 组织：一个分支 `step-tail`、五个 commit，顺序 **停止钩子 → 会话 patch 加锁、run 记录与消息标记 → 末尾段进度视图 → 报告与 agent_send → agent_status 与 agent_list**。
> 基线：`step-tail` @ `97b272f37f`（`dev` @ `d9d7de31fb` 加三个 step-tail 提交）——文中行号以此为准，再遇 rebase 需复核。
> 设计决策来源：2026-10-23 的六个设计点，2026-10-28/29 设计审查（§9）后的十二项裁决，全部记录在 §6。
> 修订：2026-10-29 按设计审查（独立审核 + 自审）改写，审查报告见 §9。

## 0. 架构定位

### 0.1 goal → 模块映射

| goal                                                         | 模块                                                                                     | commit |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | ------ |
| G7 插件能在一次 run 结束前把关，不放行则同一 run 继续（#81） | `SessionPrompt.runLoop` 的正常退出分支 + `Plugin.trigger`（新钩子）                      | 1      |
| G8 每个子 agent 的每次 run 有编号、起止时间、唤醒来源与结局  | `SessionPrompt.loop` 的 work 包装（run 记录 owner）+ `agent-management/run.ts`（纯函数） | 2      |
| G8a 会话字段的并发 patch 不再互相覆盖（G8 的前提）           | `Session.patch` 按会话串行化                                                             | 2      |
| G13 agent 发来的消息可被 TUI 按标记识别（#73 服务端）        | M3 `AgentInbox.deliver`（加 metadata，模型可见文本不变）                                 | 2      |
| G12 父在每步末尾看到一张进度视图：谁在跑、谁刚停、现在几点   | `StepTail` 子 agent 节（M5 表面的一部分，数据来自 G8）；写入历史的花名册随之撤销         | 3      |
| G9 父能把报告、停止通知与 agent_send 的返回对到具体的 run    | `reportRunEnd` 的报告属性、M4 `renderTermination`、M5 `agent_send` 的返回文本            | 4      |
| G10 查询单个 agent 的当前状态（架构 G2 改由此承载）          | M5 新工具 `agent_status`（可见性与权限跟随 `agent_list`）                                | 5      |
| G11 `agent_list` 输出有界、可过滤，且带 run 信息             | M5 `agent_list` 参数                                                                     | 5      |

### 0.2 关键假设

- **H6** `Session.patch` 是"读整条会话、内存合并、发布 `Updated` 事件、投影整行写回"（`session.ts:826-839`，`core/src/session/projector.ts:234-240`），**没有锁**：并发的两个 patch 整行后写者胜。运行中并发 patch 同一会话的既有写入方：每条消息投递时的 `touch`（`prompt.ts:1189`）、每条消息的 `setAgentModel`（`prompt.ts:810`）、第一步异步 `setTitle`（`prompt.ts:325`），以及 HTTP `session.update` 对元数据的整体替换（`handlers/session.ts:205-207`，SDK 公开）。本子计划在 `Session.patch` 内按会话加信号量（§5.2.0）之后，前三者与 run 记录不再交错；HTTP 整体替换保持替换语义，记为已知破坏路径（§1）。
- **H6b** `Updated` 是持久化事件，投影在 `publish` 返回之前于事务内同步完成（`core/src/event.ts` 的 `commitDurableEvent` 在 `Effect.uninterruptible` 的事务里逐个执行 projector）。因此锁住"读、合并、发布"这一段即可保证后一个 patch 读到前一个的结果。
- **H6c** 没有 `Updated` 事件的监听者会回头 patch 同一会话（2026-10-29 核查：唯一监听者是 `share/share-next.ts:179` 的分享同步，只读；没有任何 `listen` / `subscribe` 监听者调用 `setTitle` / `setMetadata` / `setAgentModel` / `setPermission` / `touch`），所以锁内发布不会重入死锁。实现时以测试钉住：在 `Updated` 监听者里 patch 同一会话必须报错而不是挂起，或者文档化为禁止。
- **H7** 插件钩子按顺序等待（`Plugin.trigger` 对每个钩子 `Effect.promise(() => fn(input, output))`，`packages/opencode/src/plugin/index.ts:284-296`），因此 `(input, output)` 形态的钩子可以同步把关。它没有超时；钩子 reject 成为 defect，不是类型化错误。
- **H8** 合成用户消息落库后，`runLoop` 下一轮顶部重读历史时它就是 `lastUser`，`lastAssistantBelongsToLatestTurn`（`prompt.ts:1232-1235`）为假，退出条件不成立，循环继续——与压缩后自动继续用的是同一机制（`compaction.ts:548-581`）。
- **H9** runner 对一次 run 恰执行一次 work；re-arm 时重新执行的是**同一个 work 对象**（`effect/runner.ts:90-95` `startRun(work, fresh)`）。`work` 由 `loop()` 每次调用新建，所以 work 闭包里的局部变量在 re-arm 之间保留、在新 run 之间不共享。这是 §5.2.2 用闭包标志判断 re-arm 的依据。
- **H10** `hasUnconsumedTurn`（`prompt.ts:1554-1566`）是 runner re-arm 的判据；`reportRunEnd` 已用它判断"不是真的结束"。本子计划在 `onExit` 内只读一次，结果同时交给 run 记录关闭与报告（§5.2.2）。
- **H11** 子会话的 `parentID` 创建后不变（架构 H2），所以"run 1 由创建者唤醒"可以直接取 `parentID`。

### 0.3 模块级不变量

- **I5（承重）run 号单调**：对任一有父会话，run 号只在"新 run 开始"时加一；re-arm 不加；被钩子阻止的停止不加。新 run 与 re-arm 的区分来自 work 闭包标志（H9），不来自记录。记录写失败或进程崩溃留下的打开记录，在下一次新 run 开始时关为 `lost` 再开新号，两个 run 不共号。
- **I6 报告对号**：每份结束报告（completed / failed）与停止通知所标的 run，等于发出时该会话记录里已关闭的当前 run；记录缺失或未关闭时报告不带 run 属性。
- **I7 钩子先于一切正常结束效果**：模型自行给出最终回答的退出，先经钩子；放行后才有 run 记录关闭、`reportRunEnd`、runner 的 `onIdle`。被阻止的停止不产生任何 run 结束的可观察效果。不经钩子的退出（出错、权限或提问被拒、输出截断、人中断、`agent_stop`）仍走记录关闭与报告，它们不是模型自己决定的停止。
- **I8 末尾段不入历史**（继承已落地的机制）；进度视图只从 run 记录、会话行与状态投影读，不读历史。
- **I9 agent_status ≡ agent_list 的可见性与权限**：工具表中二者同生同灭（深度与权限两维）；执行期按 `agent_list` 的权限键求值。
- **I10 标记不改文本**：#73 的标记只加在 part 的 metadata 上，`AgentInbox.render()` 的输出与结束报告的正文逐字不变。
- **I11 patch 不丢字段**：对同一会话的任意并发 patch 序列，最终行等于某个串行执行的结果；没有任何一次 patch 写入的字段被另一次 patch 的旧快照抹掉。

## 1. 范围

| commit | 触及文件                                                                                                                                                                                 | 契约变更                                                                                                                        |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 1      | `packages/plugin/src/index.ts`（Hooks 类型）；`packages/opencode/src/session/prompt.ts`；`packages/core/src/v1/config/config.ts`；`packages/core/src/plugin/skill/customize-opencode.md` | 新插件钩子 `experimental.session.stop`；新配置键 `stop_hook_block_cap`；合成继续消息的 metadata `stop_hook`                     |
| 2      | `packages/opencode/src/session/session.ts`（patch 加锁）；`agent-management/{schema,run,inbox}.ts`；`session/prompt.ts`                                                                  | `Session.patch` 按会话串行；会话元数据键 `agentRun`；part metadata `agent_message` / `user_message`；结束报告 metadata 增发送方 |
| 3      | `packages/opencode/src/session/{step-tail,prompt,reminders}.ts`                                                                                                                          | 末尾段新增进度视图（模型可见文本）；写入历史的花名册撤销                                                                        |
| 4      | `packages/opencode/src/agent-management/{delegation,lifecycle}.ts`；`session/prompt.ts`；`tool/agent.ts`                                                                                 | 报告属性 `run` / `ended`；摘要后缀；停止通知加 run 行；`agent_send` 返回文本                                                    |
| 5      | `packages/opencode/src/tool/{agent,registry}.ts`；`permission/index.ts`（`disabled` 别名表）；`agent/agent.ts`（内置受限 agent 放行列表）                                                | 新工具 `agent_status`；`agent_list` 参数、排序、上限与计数行                                                                    |

明确不做（记录再引入条件）：

- #73、#90 的 TUI 一半：按 `agent_message` / `stop_hook` 标记换样式。本子计划只保证标记存在且形状固定。
- `StopFailure` 类钩子：出错退出已有失败报告，没有新诉求。
- 结构化输出 run 的停止把关：它在步骤内部就结束，不经过正常退出分支；阻止后要求模型再产出一次 JSON。第一版不触发，文档写明。
- 停止钩子的 `additionalContext` 非阻止反馈：只做 allow / block 两态。
- 钩子超时：`Plugin.trigger` 没有超时，其他钩子也都没有；时长由插件自己负责（§6 第 12 点）。
- 默认步数上限：上游 V1/V2、Claude Code 交互模式、ZCode（#46 引用的提交）均无默认上限；`steps` 保持按 agent 的选择项（§6 第 13 点）。
- run 记录改为独立表或列：只有 agent 工具和末尾段读它，没有查询需求（§6 第 5 点）；HTTP `session.update` 以旧副本整体替换元数据仍会抹掉记录，读者容忍缺失，记为已知破坏路径。
- 崩溃后向父补发"上一个 run 丢失"的通知：父的下一步进度视图会在"已结束"列表里看到 `lost`，不另发消息。

## 2. 与已有代码的复用点

| 复用件                                                 | 位置                                                               | 用途                                                                                                                                                              |
| ------------------------------------------------------ | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Plugin.trigger` 顺序等待的 `(input, output)` 钩子形态 | `packages/opencode/src/plugin/index.ts:284-296`                    | 停止钩子不新造触发机制；reject 为 defect，用 `catchAllCause` 收                                                                                                   |
| 压缩后合成用户消息的写法                               | `compaction.ts:548-581`                                            | 钩子阻止时的继续消息：`updateMessage` + `updatePart(synthetic, metadata)`，不经 `prompt()`                                                                        |
| `runLoop` 顶部的退出判定                               | `prompt.ts:1225-1279`                                              | 钩子插在正常退出分支（1259-1279），出错退出分支（1241-1248）不动                                                                                                  |
| `hasUnconsumedTurn`                                    | `prompt.ts:1554-1566`                                              | `onExit` 内读一次，交给记录关闭与报告                                                                                                                             |
| `reportRunEnd` / `classifyExit`                        | `prompt.ts:1616-1690`、`:1987`                                     | 结局三分类映射到 outcome；报告加属性                                                                                                                              |
| `AgentDelegation.renderOutput` / `escapeMarkup`        | `delegation.ts:131-146`                                            | 报告的 `<agent …>` 标签加 `run` / `ended`                                                                                                                         |
| `renderTermination`                                    | `lifecycle.ts:477-490`                                             | 停止通知加 run 行                                                                                                                                                 |
| `AgentInbox.render` / `escapeField`                    | `inbox.ts:37-70`                                                   | 模型可见文本不变；进度视图与 agent_status 的名字、标题经同一转义                                                                                                  |
| `AgentTree.resolveTarget(scope: "neighbor")`           | `tree.ts:147-175`                                                  | `agent_status` 的目标解析，与 `agent_send` 同一套                                                                                                                 |
| `AgentStatusProjection.of`                             | `status.ts`                                                        | 在跑计数与 `agent_status` 的 running / idle                                                                                                                       |
| `Permission.disabled` 的别名表                         | `permission/index.ts:240-250`（edit/write→edit、MCP 资源→read）    | I9 工具表的一半：加 `agent_status → agent_list`；三个调用点同时生效（`llm/request.ts:251-257`、`session/system.ts:108,124`、`cli/cmd/debug/agent.handler.ts:89`） |
| `visibleAgentTools` / `AGENT_TOOL_IDS`                 | `tool/agent.ts:19,402-404`、`registry.ts:326-345`（深度过滤）      | `agent_status` 与 `agent_list` 并列                                                                                                                               |
| `applyAgentRoster` 的子列表与权限门                    | `reminders.ts:88-104`                                              | 进度视图用同一条 `agent_list` 权限规则；花名册本身在 commit 3 删除                                                                                                |
| `StepTail.render` / `message` / `MARKER`               | `step-tail.ts`                                                     | 进度视图是第一个 section，重复计数在后                                                                                                                            |
| 按键分配信号量                                         | `session/summary.ts:185-205`                                       | `Session.patch` 按会话加锁的写法                                                                                                                                  |
| `Session.patch` / `setMetadata`                        | `session.ts:826-855`                                               | 加锁点；元数据整体替换，写前重读                                                                                                                                  |
| 末尾段的缓存与标记处理                                 | `provider/transform.ts:358-362,487-510`                            | 已落地，进度视图不需要再改                                                                                                                                        |
| `deliverAsync` 立即 fork                               | `prompt.ts:181-209`（`forkIn(scope, { startImmediately: true })`） | `agent_send` 的快照必须在 deliver 之前取                                                                                                                          |

## 3. 错误处理策略

- **钩子抛错**（reject → defect）：`catchAllCause` 收住，记日志，按放行处理。Claude Code 对此的说明是"钩子不运行时 Claude 无法修复它"，一个跑不起来的钩子不该把 run 卡住。**不设超时**：挂住的钩子与挂住的工具执行同类，由插件负责；人可在 TUI 中止，中止走中断路径，不经钩子。
- **钩子阻止但没有理由**（缺省或空白）：记警告，按放行处理。理由是模型下一步的全部输入，空理由等于空转一步。
- **多个插件**：共享同一个 `output` 对象，后写者胜，与现有所有 `(input, output)` 钩子一致；文档写明。
- **run 记录写失败**：记警告，run 照常进行。后果是：开始写失败则本 run 没有记录，结束时 `end` 发现无记录只记警告；结束写失败则记录停在打开状态，下一次新 run 开始时把它关为 `lost` 再开新号（I5）。报告在记录缺失或未关闭时省略 run 属性（I6）。
- **进度视图数据读取失败**：整节省略（在 §5.3.2 的采集步骤 `catchAll` 到 `undefined`），重复计数节照常。
- **`agent_status` 的解析失败**：与 `agent_send` 同一套渲染——零匹配列邻居，多匹配列全部候选并要求用 session_id。
- **`agent_list` 的非法参数**：由参数 schema 拒绝，不进入执行。
- 测试失败处理遵循 workflow §5.4，禁止改测试凑绿。

## 4. 数据结构定义

### 4.1 `AgentRun`（会话元数据键 `agentRun`，commit 2）

```
数据结构：AgentRun

存放：Session.Info.metadata["agentRun"]，JSON 对象。只对有 parentID 的会话写入
  （命令子任务也写；主会话不写——它没有父，也没人查它的 run 号）。

字段：
  - number: PositiveInt — 当前（最近一次）run 的编号，从 1 起
  - started_at: number — 当前 run 开始的 epoch ms
  - woken_by: WakeSource — 唤醒当前 run 的来源（见 4.2）
  - ended_at?: number — 当前 run 关闭的 epoch ms；缺省表示仍在进行或尚未关闭
  - outcome?: RunOutcome — 当前 run 的结局；与 ended_at 同在同缺
  - previous?: { number: PositiveInt, ended_at: number, outcome: RunOutcome } — 上一个 run 的结束

RunOutcome = "completed" | "failed" | "stopped" | "lost"
  - completed / failed：classifyExit 的 completed / failed
  - stopped：classifyExit 的 cancelled（agent_stop、祖先停止级联、人在 TUI 中止）
  - lost：记录在新 run 开始时仍处于打开状态（进程崩溃或结束写失败），由新 run 的开始把它关闭；没有任何报告对应它

类型不变量：
  - ended_at 存在 ⇔ outcome 存在；ended_at ≥ started_at
  - number 单调（I5）；previous.number = number − 1（若 previous 存在）
  - 只保留当前 run 与上一个 run 的结束，再往前的没有读者：在跑列表的"上一个 run 已于某时结束"与
    agent_send 的第二句都只需要上一个
  - 时间以 epoch ms 存，与 Session.time 同口径；对外渲染时再转成带时区的完整时间

写入方：只有 SessionPrompt.loop 的 work 包装（开始与结束各一次），经 run.ts 的纯函数计算新值、
  Session.setMetadata 整体写回。写前重读元数据；并发安全由 Session.patch 的按会话锁保证（H6/H6b）。

生命周期：创建于子会话第一次 run 开始；每次新 run 开始时当前 run 的结束移入 previous；会话删除时随元数据消失。

跨模块共享性：跨模块共享 — producer: SessionPrompt.loop；consumer: StepTail 进度视图、
  M5 agent_status / agent_list / agent_send、reportRunEnd、M4 renderTermination
```

### 4.2 `WakeSource`（commit 2）

```
数据结构：WakeSource

字段：
  - kind: "agent" | "user" | "system"
  - session?: SessionID — kind = agent 时必填，发送方会话
  - name?: string — kind = agent 时的发送方实例名（若有）
  - agent?: string — kind = agent 时的发送方 agent 类型（若有）

推导规则（新 run 开始时，按序，先命中者胜）：
  1. number = 1（首次 run）⇒ { kind: "agent", session: parentID, name/agent 取父会话 }——
     创建者就是唤醒者（H11）
  2. 唤醒本次 run 的用户消息（run 开始时 MessageV2.latest(msgs).user）的首个 text part 的
     metadata.kind ∈ { "agent_message", "agent_notification" } ⇒ { kind: "agent", 取其 sender 三字段 }
     —— agent_send 的消息、停止通知、子 agent 的结束报告都落在这里（决策 §6 第 2 点）
  3. 该 part 的 metadata.kind = "user_message" ⇒ { kind: "user" }。**只覆盖 TUI 的 agent-message 路由**
     （`handlers/session.ts:337-347`，TUI `routes/session/index.tsx:425` 用它）；人经普通 prompt 端点
     发进子会话的消息没有标记，落入规则 4
  4. 其余 ⇒ { kind: "system" }（压缩后的自动继续、普通 prompt 端点等）

渲染规则（进度视图、agent_status、agent_list 共用）：
  - 从某会话 S 的视角：kind = agent 且 session = S ⇒ `your message`；
    kind = agent 且 session ≠ S ⇒ 发送方的 name，缺省时用 session id；
    kind = user ⇒ `user`；kind = system ⇒ `system`

跨模块共享性：跨模块共享 — producer: run.ts（纯函数）；consumer: 同 AgentRun
```

### 4.3 消息 part 的 metadata（commit 2；#73 服务端）

```
数据结构：AgentMessageMetadata（TextPart.metadata 的自由字段约定，与 agent_notification 同命名空间）

agent 发送方的消息（agent_send、停止通知）—— deliver 的 kind = "agent" 路径，渲染出的唯一 text part：
  - kind: "agent_message"
  - sender: SessionID
  - sender_name?: string
  - sender_agent?: string

人经 TUI agent-message 路由发进子会话的消息 —— deliver 的 kind = "user" 路径，头行 part：
  - kind: "user_message"

子 agent 的结束报告 —— reportRunEnd 写入父的 synthetic part，在既有 { kind: "agent_notification", summary }
  之上增加：
  - sender: SessionID（子会话）
  - sender_name?: string
  - sender_agent?: string

钩子阻止后的继续消息 —— runLoop 落库的 synthetic part：
  - kind: "stop_hook"
  - reason: string

类型不变量：
  - 模型可见的 part.text 逐字不变（I10）；metadata 只供 TUI 识别与 WakeSource 推导
  - 四个 kind 字面量与既有 "agent_notification" 一起由 agent-management/schema.ts 导出
    （常量 `PART_KINDS`）；TUI 无法 import（part metadata 在 SDK 侧是自由 record），按子计划 1 的 §10 约定各持一份
  - 旧记录没有标记，读者必须容忍缺失（WakeSource 规则 4 兜底）
```

### 4.4 停止钩子（commit 1；#81）

```
接口：SessionPrompt.runLoop → Plugin.trigger("experimental.session.stop", input, output)

input：
  - sessionID: SessionID
  - parentID?: SessionID — 子 agent 时存在；主会话为空。宿主不据此区分，插件自行决定管谁
  - agent: string — 本会话当前绑定的 agent 定义名
  - message: { info: AssistantMessage, parts: Part[] } — 模型的最终回答（SDK v2 已导出 AssistantMessage，
    `sdk/js/src/v2/gen/types.gen.ts:336`）；对应 Claude Code 的 last_assistant_message
  - continuations: NonNegativeInt — 本次 run 内连续被阻止的次数（计数器放在 loop() 的 work 闭包里，
    re-arm 之间保留，H9）；> 0 即 Claude Code 的 stop_hook_active

output（默认 { decision: "allow" }）：
  - decision: "allow" | "block"
  - reason?: string — block 时必填；作为模型下一步的全部输入

触发条件：runLoop 的正常退出分支——最后一条助手消息有终止 finish、不含工具调用、属于最新一轮
  （prompt.ts:1259-1279）。
  不触发（这些退出不经该分支，或不是模型自己决定的停止）：助手消息带错误（1241-1248）；
  权限或提问被拒且未配置继续（processor.ts:322-323 → prompt.ts:1511 `result === "stop"`）；
  输出被截断（prompt.ts:1478-1480 `finish === "length"`）；结构化输出在步骤内结束（1483-1488）；
  人中断；agent_stop。这些退出仍走 run 记录关闭与报告（I7）。
  到达配置步数上限的那一步（isLastStep）也不询问钩子，直接结束并记日志：上限是用户配置的硬边界
  （§6 第 11 点）。默认没有上限（`agent.steps ?? Infinity`，prompt.ts:1328）。
  主会话与子 agent 走同一个分支、同一个输入格式、同一套上限。

阻止的效果：落库一条用户消息，一个 text part：text = reason、synthetic: true、
  metadata { kind: "stop_hook", reason }；continuations + 1；循环继续，仍在同一次 run 内。
  继续消息是真实历史，进入压缩输入（与压缩后的自动继续消息同类）；TUI 过滤合成文本，所以人看不到
  理由（#90 跟进）。

上限：连续阻止达到 cfg.stop_hook_block_cap（默认 8）后本次不再询问钩子，直接退出并记日志；
  任一步包含工具调用即清零。0 表示钩子根本不被调用。
  两条规则的出处：Claude Code hooks 文档（https://code.claude.com/docs/en/hooks，2026-10-23 读取）：
  "Claude Code applies an 8-consecutive-continuation cap … The count of consecutive continuations resets
  each time Claude calls a tool."

配置键：stop_hook_block_cap: NonNegativeInt，与 subagent_depth 同级（config.ts:84 旁）。
```

### 4.5 末尾段进度视图（commit 3）

```
数据结构：StepTail 进度视图（模型可见文本，只存在于本步请求）

目的：给模型一张"此刻"的仪表盘——现在几点、自己在哪、谁在跑、谁刚停——而不是一条事件流。

完整样子（两个列表都有内容时）：

  Now: 2026-10-27T19:54:07+08:00. You are in run 6, step 12.

  Your subagents: 9 direct, 8 running, 1 idle.
  Running now:
    ses_e8322dba1ffeym7PA3fbSUOgkq  cw-b572  run 2 since 19:40:56 (your message), last active 19:52:30; run 1 ended 19:38:10 (completed)
    ses_e82d509c7ffegJiVTIGVydNkNW  cw-b584  run 1 since 19:50:08 (your message), last active 19:51:40
    … and 6 more running
  Finished in the last 10 minutes, now idle:
    ses_e82e64cadffe1q2diMobtJb5ag  cw-b582  run 5 ended 19:49:18 (stopped)
    … and 2 more finished

  Your last step repeated the tool calls of the step before it: 2 times in a row; the results were identical too: 2 times in a row.

四个部分：
  1. 时钟与自身位置：当前时间带日期与时区；run 号与步号是本会话自己的。主会话没有 run 号，只写
     `You are at step 12.`
  2. 子 agent 总览与在跑列表：直接子 agent 的总数、在跑数、空闲数。在跑的逐个列出，每行 session_id、名字
     （无名字时省略）、run 号、开始时间、唤醒来源、最后活动时间（会话的 time.updated）；若其上一个 run 在
     窗口内结束，分号后带上"run N ended <时间> (<结局>)"——这一句专门对付 #75 的竞态
  3. 窗口内结束、现在空闲的列表：每行 session_id、名字、run 号、结束时间、结局（四种之一）
  4. 重复计数：第一组已实现的那句

窗口：取"最近 10 分钟"与"上一步开始以来"两者中更长者。保底项保证一步里跑了 30 分钟的编译时，期间
  结束的子 agent 至少被下一步看到一次。上一步开始时间由 runLoop 记录（每步进入时的 Date.now()）。

排序与上限：
  - 在跑：开始时间早的在前（跑得久的最容易被忘、最可能卡住），各最多 10 行，超出丢最新派出的，
    写 `… and N more running`
  - 已结束：结束时间晚的在前，最多 10 行，超出丢最早的，写 `… and N more finished`
  - 并列按 session_id，保证两步之间顺序稳定
  - 省略行不计入 10 行；整段至多 10 + 10 + 6 行

出现条件：
  - 第 2、3 部分只在有直接子 agent、且 agent_list 权限不是 deny 时出现
  - 第 4 部分只在计数大于 0 时出现
  - 四部分都没有时整段不附带；第 1 部分随任一部分出现，不单独出现

类型不变量：
  - 只读 run 记录、会话行（metadata、time.updated）与状态投影，不读历史、不读消息（I8）
  - 数据采集每步一次 SQL（按 parent_id 取全部直接子的 id、metadata、time_updated），状态来自内存投影
  - 名字经 escapeField
  - 时间：第一行用带时区的完整时间，其余用 HH:MM:SS，同一时区；报告属性与 agent_send 用同一时区的完整时间
  - 只陈述事实，不教用法

与花名册的关系：写入历史的花名册（applyAgentRoster）只在回合边界刷新、只列在跑的、越写越多；进度视图每步
  都是新的又不占历史，二者重叠。commit 3 删除花名册注入（保留 AGENT_ROSTER_SENTINEL 常量供旧记录识别），
  架构 §3 SubagentRoster 标为撤销。
```

### 4.6 报告、停止通知与 `agent_send` 的返回（commit 4）

```
结束报告（reportRunEnd）：
  模型可见：`<agent id="ses_xxx" state="completed|error" run="5" ended="2026-10-20T03:41:18+08:00">`
  TUI 摘要：`Agent completed: <描述> (run 5, ended 03:41:18)`，失败同理
  run / ended 取自关闭后的 agentRun；记录缺失或未关闭（结束写失败）时两个属性与摘要后缀一并省略（I6）

停止通知（renderTermination）新增一行，三种情况：
  - 目标的 run 被本次 stop 中断，且记录已关闭：`run: 5, stopped at 2026-10-20T03:41:18+08:00`
  - 被中断但记录尚未关闭（被取消 fiber 的 onExit 异步完成，stop 读到时还没写）：
    `run: 5, stop requested at <now>`，不等待
  - 目标本就空闲（run-state.ts:81-90 对无 runner 的目标 cancel 是空操作）：
    `run: 5 had already ended at <时间> (<结局>); nothing was running`
  被 agent_stop 停下的 run 仍不单独报告（架构 §4.4），但它的编号经这一行与 agent_status 可见

run 号允许不连续（决策 §6 第 3 点）：被取消的 run 由停止通知承载；自己仍有后代在跑时推迟的报告，
  报告的是实际关闭的那个 run，不回溯补发；lost 的 run 没有任何报告。工具描述里不解释这些。

agent_send 的返回（在 deliver 之前取目标的状态投影与 agentRun 作为快照；deliverAsync 立即 fork，之后读会
  读到混合状态）：
  目标空闲，记录已关闭：
    `ses_xxx (cw-b333) was idle; this message starts run 6 (sent 2026-10-20T03:41:27+08:00).`
    `Its run 5 ended at 2026-10-20T03:41:18+08:00 (completed); that report reaches you as a separate message.`
    结局为 stopped 时第二句尾改为 `; the stop notice told you.`，为 lost 时改为 `; it was cut off and has no report.`
  目标空闲，无记录：第二句省略；首次写 `starts run 1`
  目标空闲，记录未关闭（崩溃遗留，尚未被新 run 关闭）：
    `ses_xxx (cw-b333) was idle; its run 5 was cut off (started <时间>) and will be recorded as lost; this message starts run 6 (sent …).`
  目标在跑，记录未关闭：`ses_xxx (cw-b333) is in run 5 (started 2026-10-20T03:40:02+08:00); it reads this at its next step.`
  目标在跑，记录已关闭或缺失（开始写入尚未完成或已失败）：
    `ses_xxx (cw-b333) is running (its run record is not updated yet); it reads this at its next step.`
  目标不是子会话（如主会话）：只写 `is running` / `is idle`，不写 run 号
  末尾恒加一行：`Current state of one agent: agent_status(target="ses_xxx").`
  既有的三句"单向消息"说明保留在上述内容之后
  投递失败时工具返回失败文本，不输出以上任何一句
```

### 4.7 工具 schema（commit 5）

```
工具：agent_status
  target: string — session_id，或调用者邻居中某个 Agent 的实例名
返回（key: value 行）：
  session_id / name / agent_type / relation / status（running | idle）
  run：在跑且记录未关闭 → `6, started <ISO>, woken by <来源>`；空闲且记录已关闭 → `5, ended <ISO> (<结局>)`；
       记录未关闭但空闲 → `5, started <ISO>, cut off (will be recorded as lost)`；从未跑过 → `none yet`；
       非子会话 → 省略本行
  previous run：有 previous 时 → `4, ended <ISO> (<结局>)`
  last active：会话 time.updated 的 ISO
  workdir
可查范围、解析与权限：与 agent_list 相同（I9）

工具：agent_list（参数全部可选）
  status?:   "running" | "idle"
  relation?: "self" | "parent" | "child" | "sibling"
  query?:    string — 实例名或标题的子串，大小写不敏感；不匹配 agent_type
  limit?:    PositiveInt — 默认 50
返回：
  表头 session_id / name / agent_type / relation / status / run / last / title / workdir
    run：agentRun.number，无记录留空；last：max(started_at, ended_at) 的 ISO，无记录留空
  排序：在跑的在前；其余按 last 倒序，无记录的按 time_created 倒序；并列按 session_id
  末尾计数行：`showing <shown> of <total> (<running> running, <idle> idle)`——total 与两个计数按
    过滤后、截断前的集合统计
  不带参数时默认上限 50，这是对现有输出的有意改变
```

## 5. 模块细化

### 5.1 commit 1（#81）：停止钩子

#### 5.1.1 `Hooks["experimental.session.stop"]`（`packages/plugin/src/index.ts`）

- 按 4.4 的 input / output 加到 `Hooks` 接口，位置在 `experimental.compaction.autocontinue` 之后，注释说明触发条件、阻止效果、后写者胜、无超时。
- `customize-opencode.md` 的钩子列表补一条。
- **正确性论证**：trivial（类型声明）。运行时按名字触发，旧插件不实现即不受影响。

#### 5.1.2 `runLoop` 正常退出分支的把关（`prompt.ts:1259-1279`）

- run 级状态 `continuations` 放在 `loop()` 的 work 闭包里（H9），以参数传入 `runLoop`。在循环顶部、`hasToolCalls` 求得为真时清零（模型调用了工具）。
- 把关插在 `yield* Effect.logInfo("exiting loop", …)`（1278）之前：
  1. `isLastStep`（上一步已是配置上限）→ 记日志 `stop hook skipped at step limit` → 退出。
  2. `cap = cfg.stop_hook_block_cap ?? 8`；`continuations >= cap` → 记日志 `stop hook cap reached` → 退出。`cap = 0` 时钩子因此根本不被调用。
  3. `decision = plugin.trigger("experimental.session.stop", input, { decision: "allow" })`，`input` 按 4.4 组装，`message` 取 `lastAssistantMsg`。用 `Effect.catchAllCause` 收住 defect → 记日志 → 放行。
  4. `decision !== "block"` → 退出。`reason` 缺省或空白 → 记警告 → 退出。
  5. 阻止：照 `compaction.ts:548-581` 落库一条用户消息（`agent` / `model` 取 `lastUser` 的），一个 text part：`text = reason`、`synthetic: true`、`metadata: { kind: "stop_hook", reason }`；`continuations += 1`；`continue`。
- **分支覆盖**：步数上限 / 到顶 / 钩子抛错 / 放行 / 阻止无理由 / 阻止有理由，六支各一测。
- **正确性论证**：
  - 前置：进入该分支即模型给出了最终回答且没有待执行的工具调用；出错退出分支（1241-1248）与步内 `break` 的各路径（1478-1511）都不经此处（4.4 的"不触发"清单）。
  - 论证：阻止时落库的用户消息使下一轮顶部 `lastAssistantBelongsToLatestTurn` 为假（H8），退出条件不成立，循环继续；这一切都在同一次 `runLoop` 调用内，故 `loop()` 的 `onExit`（run 记录关闭与 `reportRunEnd`）与 runner 的 `onIdle` 都尚未发生——这就是 I7。
  - **终止性（如实陈述）**：钩子只限制"连续"阻止：每一段不含工具调用的退出尝试至多询问钩子 `cap` 次、阻止 `cap` 次；模型一调用工具计数清零，所以"阻止、调工具、再阻止"的往复不受上限约束，与 Claude Code 相同。默认没有步数上限（`agent.steps ?? Infinity`），`MAX_STEPS_PROMPT` 只是在最后一步追加提示文本、不撤工具。整体终止性不劣于现状：现状就是模型自己决定何时停。
  - 与末尾段的关系：继续消息不是工具调用，重复计数的"上一步"签名不变；它作为新的 `lastUser` 不影响任何已发送前缀。
  - 后置：放行 ⇒ 既有退出路径逐字不变；阻止 ⇒ 历史多一条合成用户消息、run 号不变、父未收到报告。
  - 副作用论证：至多写入一条用户消息与一个 part。

#### 5.1.3 配置键 `stop_hook_block_cap`（`core/src/v1/config/config.ts:84` 旁）

- `Schema.optional(NonNegativeInt)`，描述写明默认 8、0 表示不调用钩子、调用工具即清零。
- **正确性论证**：trivial。

#### 5.1.4 测试

- 脚本化 LLM：最终回答 → 假插件阻止两次再放行 → 请求数为 3，中间两次请求的最后一条用户消息文本等于理由，父（若为子 agent）只收到一份报告，报告在放行之后。
- 上限：`stop_hook_block_cap: 2` 时第三次不再询问钩子；一步含工具调用后计数清零（再阻止两次仍生效）；`0` 时钩子调用次数为 0。
- re-arm 之间计数保留：阻止一次后让消息落在 re-arm 窗口，再阻止时 `continuations` 为 2。
- 钩子抛错、阻止无理由 → 放行且 run 正常结束。
- 出错退出、权限被拒退出、`length` 退出、`isLastStep` 均不触发钩子（钩子被调用次数为 0），且父仍收到报告。
- 多插件：后一个把 block 改回 allow 时放行（文档化行为的回归）。
- T8（随机）：随机阻止序列（长度 < cap，穿插工具调用步），断言父恰收到一份报告且在最后一次放行之后；每次阻止请求的最后一条用户消息等于当次 reason；连续阻止次数永不超过 cap。

### 5.2 commit 2：patch 加锁、run 记录与消息标记

#### 5.2.0 `Session.patch` 按会话串行化（`session.ts:826-839`）

- 在 Session 层维护 `Map<SessionID, Semaphore(1)>`，`patch` 整体包在 `withPermits(1)` 里：读行、合并、`publish(Updated)`。照 `summary.ts:185-205` 的写法；条目在无等待者时清理。
- **调用关系**：callers: `touch` / `setTitle` / `setMetadata` / `setAgentModel` / `setPermission` / `setRevert` 等既有方法（全部经 `patch`）；callees: `get`、`events.publish`。
- **前置核查（H6c）**：没有 `Updated` 监听者回头 patch 同一会话。测试：在监听者里 patch 同一会话必须在超时内报错而不是永久挂起（用 `Effect.timeout` 断言），作为"禁止重入"的钉子。
- **正确性论证**：
  - 前置：H6b——`publish` 返回时投影已写完。
  - 论证：同一会话的 patch 串行 ⇒ 每次 `get` 读到上一次 patch 的投影结果 ⇒ 合并基于最新行 ⇒ 没有旧快照覆盖（I11）。不同会话的 patch 互不阻塞。锁只覆盖 patch，正常执行路径不拿锁。
  - 后置：对任意并发 patch 序列，最终行等于某个串行执行的结果。
  - 副作用论证：无新副作用；锁持有时间 = 一次行读 + 一次事务写，毫秒级。
- T9（随机）：对同一会话并发执行随机的 `setTitle` / `setMetadata` / `touch` / `setAgentModel` 序列，断言最终行的每个字段等于最后一次写该字段的值（无丢失）。

#### 5.2.1 `agent-management/run.ts`（新，纯函数）

- `begin(previous: AgentRun | undefined, now, wokenBy, fresh: boolean) -> AgentRun | undefined`：
  - `!fresh`（re-arm）→ `undefined`（不写）。
  - `previous` 存在且无 `ended_at`（遗留打开）→ 先把它关为 `{ number, ended_at: now, outcome: "lost" }` 放入 `previous` 字段；否则 `previous` 字段 = 上一条的 `{ number, ended_at, outcome }`（若上一条存在）。
  - 返回 `{ number: (previous?.number ?? 0) + 1, started_at: now, woken_by, previous? }`。
- `end(current: AgentRun | undefined, now, outcome) -> AgentRun | undefined`：`current` 缺失或已有 `ended_at` → `undefined`（调用方记警告）；否则返回补上 `ended_at` / `outcome` 的副本。
- `outcomeOf(exit) -> RunOutcome`：`classifyExit` 三分类的映射表（completed→completed、failed→failed、cancelled→stopped）；`lost` 只由 `begin` 产生。
- `wakeSource(message: WithParts | undefined, number, parent) -> WakeSource`：按 4.2 规则 1–4。
- `formatInstant(ms)`（带本地时区偏移的 ISO 8601）、`formatClock(ms)`（HH:MM:SS）、`describeSource(source, viewer)`（4.2 渲染规则）。
- **正确性论证**：
  - `begin` 四种输入（re-arm / 无记录 / 已关闭 / 遗留打开）各一支，I5 由"只在 `fresh` 时加一"直接给出；遗留打开的关闭保证两个 run 不共号。
  - `end` 三种输入（缺失 / 已关闭 / 打开）各一支；后置 `ended_at ≥ started_at` 由 `now ≥ started_at` 给出。
  - `wakeSource`：规则 1 优先于 2–4，因为首次 run 的唤醒消息是创建时的任务提示，没有标记；规则 2–3 读 `metadata.kind`，不读文本；规则 4 兜底使函数全域有定义。
  - `describeSource`：四分支穷尽 `kind × (session = viewer)`。
  - 全部无副作用。

#### 5.2.2 `SessionPrompt.loop` 的 work 包装（`prompt.ts:1568-1587`）

- 只对 `session.parentID` 存在的会话包装（`agentNotify` 为 false 的命令子任务也包）：

  ```ts
  let started = false // work 闭包：首次执行是新 run，之后都是 re-arm（H9）
  let continuations = 0 // 停止钩子的连续阻止计数，随 re-arm 保留
  const work = Effect.gen(function* () {
    const fresh = !started
    started = true
    yield* recordRunStart(session, fresh)
    return yield* runLoop(id, {
      continuations: () => continuations,
      bump: () => continuations++,
      reset: () => (continuations = 0),
    })
  }).pipe(
    Effect.onExit((exit) =>
      Effect.gen(function* () {
        const unconsumed = Exit.isSuccess(exit) && (yield* hasUnconsumedTurn(id)) // 只读一次（H10）
        yield* recordRunEnd(session, exit, unconsumed)
        if (notify) yield* reportRunEnd(session, parentID, exit, unconsumed)
      }),
    ),
  )
  ```

  **必须是一个 `onExit` 内顺序调用**，不能挂两个 `onExit`（后挂的先跑，报告会读到未关闭的记录）。

- `recordRunStart(session, fresh)`：重读会话元数据；`wokenBy = wakeSource(latest user, (previous?.number ?? 0) + 1, parent)`；`next = begin(previous, now, wokenBy, fresh)`；`next` 存在才 `setMetadata({ ...metadata, agentRun: next })`。
- `recordRunEnd(session, exit, unconsumed)`：`unconsumed` 为真 → 不关闭（runner 将 re-arm，同一 run 继续）；否则 `outcome = outcomeOf(exit)`；重读元数据；`next = end(current, now, outcome)`；存在才写回，缺失记警告。
- `reportRunEnd` 改为接收 `unconsumed`，不再自己读 `hasUnconsumedTurn`。
- **正确性论证**：
  - 前置：runner 对一次 run 恰执行一次 work，re-arm 重跑同一 work（H9）。
  - 论证：新 run 与 re-arm 由闭包标志区分，与记录状态无关，崩溃或写失败不能让新 run 被误判为 re-arm（I5）。`hasUnconsumedTurn` 只读一次，记录关闭与报告看到同一个答案：要么都认为 run 继续（都不动），要么都认为 run 结束（先关闭，后报告读到已关闭的记录，I6）。runner 自己的第三次读可能与这次不同：消息恰落在两次读之间时，这里判"结束"而 runner 判"续跑"——记录关闭为 completed、报告发出，runner 随后重跑 work，闭包标志已为 true → `begin` 判 re-arm → 不开新号，但 `end` 会发现记录已关闭 → 只记警告。后果是这一次续跑不被记录也不再报告；消息本身被处理。与修复前相同的窗口，不扩大。
  - 后置：每次 run 至多一次开始写入、至多一次结束写入。
  - 副作用论证：至多两次 `setMetadata`（经 5.2.0 的锁）；记账失败不影响 run。

#### 5.2.3 `AgentInbox.deliver` 的标记（`inbox.ts:114-122`，#73 服务端）

- Step 的 parts：`kind = "agent"` → `[{ type: "text", text: render(message), metadata: { kind: "agent_message", sender, sender_name?, sender_agent? } }]`；`kind = "user"` → 头行 part 加 `metadata: { kind: "user_message" }`，用户 parts 原样。
- `reportRunEnd` 写入父的 part：metadata 增 `sender: child.id`、`sender_name`、`sender_agent`。
- **正确性论证**：`render()` 与头行文本不变（I10）；metadata 经 `prompt()` 的 text part 输入透传（`reportRunEnd` 已这样传 `{kind, summary}`）。
- 测试：三条路径的 metadata 形状；模型收到的文本与改前逐字相同（断言请求体）；`[Message from user]` 路径不带 `agent_message`。

#### 5.2.4 测试

- run 记录：首次 run 为 1 且 `woken_by` 为父；agent_send 唤醒的 run 加一且来源为发送方，`previous` 为上一个 run 的结束；结束报告唤醒祖辈时来源为发报告的子；人经 agent-message 路由唤醒为 user，经普通 prompt 端点为 system；re-arm 不加号；`agent_stop` 记 `stopped`；钩子阻止不加号、不写 `ended_at`；遗留打开记录在新 run 开始时关为 `lost` 且新 run 号加一；结束写失败后的下一次 run 仍加一。
- T3（随机，run 层）：随机事件序列（向空闲 / 在跑的子发送、完成 / 失败 / 被停、re-arm、并发多子、随机注入一次"结束写失败"），经真实 `loop` 执行，断言：每个子的 run 号严格递增且每次只加一；每份报告的 run 号等于该时刻已关闭的 run；`ended_at ≥ started_at`；写失败的那次 run 在下一次开始时被记为 lost；agent_send 预告的 run 号与该子的下一份报告一致。

### 5.3 commit 3：末尾段进度视图

#### 5.3.1 `StepTail.renderSubagents(input) -> string | undefined`（纯函数）

- 入参：`{ now, self: { run?: number, step: number }, children: Child[], windowStart: number, viewer: SessionID }`，`Child = { id, name?, running: boolean, updated: number, run?: AgentRun }`。
- 步骤：
  1. `running = children.filter(c => c.running)`，按 `run?.started_at ?? updated` 升序、并列按 id；取前 10；超出记 `omittedRunning`。
  2. `finished = children.filter(c => !c.running && c.run?.ended_at !== undefined && c.run.ended_at >= windowStart)`，按 `ended_at` 降序、并列按 id；取前 10；超出记 `omittedFinished`。
  3. 渲染 4.5 的格式：总览行；在跑列表（每行 id、名字、run 号、since、来源、last active；若 `run.previous.ended_at >= windowStart` 附分号句）；已结束列表；省略行。
  4. 两个列表都为空时只返回总览行。
- **正确性论证**：纯函数；行数上界 10 + 10 + 4；排序有确定的第二键（id）；`finished` 的筛选条件与 4.5 定义逐字对应。
- 测试：无子时上层不调用；有子无变化只一行总览；在跑按开始时间升序、超 10 截断保留最早的；已结束按结束时间降序、超 10 截断保留最新的；上一个 run 在窗口内时附带分号句、不在窗口内不带；四种结局各一例；来源四种各一例；名字缺省时省略。

#### 5.3.2 `runLoop` 中的数据采集（`prompt.ts:1434` 组装 tail 处）

- run 级状态 `previousStepStart`：每步进入时记 `Date.now()`，组装 tail 时用的是上一步的值。
- 采集（`catchAll` 到 `undefined` → 整节省略）：
  1. 权限门：`Permission.evaluate(AGENT_LIST_TOOL_ID, "*", merged)` 为 deny → 不附带（与 `reminders.ts:94-97` 同一规则）。
  2. **一次 SQL**：`select id, metadata, time_updated from session where parent_id = ?`（经 Session 服务新增 `childrenRows(parentID)`，不经 `AgentTree.children`——后者逐个 hydrate 并算 depth，这里不需要）。为空 → 不附带。
  3. 对每行：`running = (yield* status.get(id)).type ∈ {busy, retry}`（内存）；`run = metadata.agentRun`；名字 = `metadata.agentName`。
  4. `windowStart = min(now − 10 min, previousStepStart)`。
  5. 自身位置：子会话取自己的 `agentRun.number`（本步开始时已写），主会话无；步号 = `step`。
- `tail = StepTail.render([renderSubagents(...), renderRepeat(repeat)])`。
- 同一 commit 删除 `applyAgentRoster` 的注入与调用（`reminders.ts:60-150`、`prompt.ts:1335`），保留 `AGENT_ROSTER_SENTINEL`；相关测试改为断言不再注入。
- **正确性论证**：
  - 读取量：一次 SQL 加 N 次内存查找，N 为直接子数；不读消息、不读部件、不走 `AgentTree`。606 个子 agent 也是一次几毫秒的查询加一次 JSON 解析（expectations §8 的断言）。
  - 窗口的保底项保证"任何结束至少被下一步看到一次"：结束时间 ≥ 上一步开始 ⇒ 在本步窗口内。
  - 权限门与被删除的花名册同一条规则，信息暴露面不变。
  - 副作用：无（只读）。
- 测试：无子不附带；`agent_list` deny 不附带；进度视图与重复计数共存且节序正确；30 分钟长步后结束的子在下一步可见；相邻两步请求的历史部分逐字相同（扩展 R1）；花名册不再写入历史。
- T7（随机）：随机生成子集合（状态、run 记录、更新时间）与窗口，断言两个列表恰等于按 4.5 定义计算的集合（在跑 = 投影 running；已结束 = 空闲且 `ended_at ≥ windowStart`）、顺序满足定义、行数 ≤ 10、省略计数正确；相邻步之间同一输入产出同一文本。

### 5.4 commit 4：报告、停止通知与 `agent_send`

#### 5.4.1 `renderOutput` 与 `reportRunEnd`

- `renderOutput` 入参增 `run?: number`、`ended?: number`，有值时输出 `run="…" ended="<ISO>"`。
- `reportRunEnd`：读关闭后的 `agentRun`；`ended_at` 存在才传 `run` / `ended` 并加摘要后缀 ` (run 5, ended 03:41:18)`；记录缺失或未关闭时一并省略。
- **正确性论证**：I6 由 5.2.2 的顺序给出；TUI 只读 `summary`，后缀是 server 的措辞 owner（子计划 1 §4.1）。
- 测试：有记录 / 无记录 / 未关闭三例。

#### 5.4.2 `renderTermination`

- 入参增 `run?: AgentRun`、`interrupted: boolean`（`stop` 对该成员的 cancel 是否命中了在跑的 run：由 `SessionRunState.cancel` 返回"是否有 runner"得到；需给 `cancel` 加返回值）。
- 三分支按 4.6：中断且已关闭 / 中断但未关闭 / 本就空闲。无记录时不加 run 行。
- **正确性论证**：
  - 前置：`stop` 已对目标执行 cancel；`stop` 在发通知前重读目标元数据。
  - 论证：`interrupted` 来自 cancel 的返回值，不从记录推断，所以"本就空闲"不会被写成"已停止"；"未关闭"分支不等待被取消 fiber 的 `onExit`——通知的强度本就只到"已接受"。三分支由 `interrupted × ended_at 是否存在` 穷尽（空闲时记录总是已关闭或缺失；空闲且未关闭是崩溃遗留，按"本就空闲"写并注明 cut off）。
  - 副作用：无（渲染）。
- 测试：三分支各一例，用 Deferred 控制被取消 fiber 的退出时机。

#### 5.4.3 `agent_send` 的返回（`tool/agent.ts:288-319`）

- 在 `deliver` **之前**取快照：`status = projection.of(target)`、`run = target.metadata.agentRun`、`isChild = target.parentID !== undefined`。
- 按 4.6 六种情况渲染；末尾加 `agent_status` 提示行；既有三句保留。
- **正确性论证（决策 §6 第 4 点）**：目标在跑且记录未关闭时，消息进入当前 run 或紧接着的 re-arm run，run 号仍是 N（I5），"is in run N" 成立。目标空闲且记录已关闭时下一次开始的 run 必为 N+1（5.2.1 `begin` 对已关闭记录加一）；即使别的消息抢先唤醒，本消息也只是进入 run N+1。空闲且未关闭（遗留）时下一次开始会先关为 lost 再开 N+1，措辞如实写出。投递失败时工具本身返回失败文本，不输出这段话。快照在 deliver 之前取，避免 fork 已启动目标后读到 N+1 与 busy 的混合状态。
- 测试：六种情况各一例；预告的 run 号与下一份报告一致（T3 覆盖）。

### 5.5 commit 5：`agent_status` 与 `agent_list`

#### 5.5.1 `agent_status(params, ctx)`（`tool/agent.ts` 新工具，ID `agent_status`）

1. `resolveTarget(caller, params.target, "neighbor")`，失败渲染同 `agent_send`。
2. `Permission.evaluate(AGENT_LIST_TOOL_ID, "*", merged ruleset)` 为 deny → 返回失败文本（I9 执行期的一半）。`agent_list` 自身没有执行期检查，只靠工具表隐藏；这里多一道是有意的不对称，安全方向正确，文档写明。
3. `sessions.get(target)`、`projection.of(target)`、`neighborhood(caller)` 取 relation。
4. 按 4.7 渲染。

- **正确性论证**：解析范围与 `agent_list` 同为邻居；步骤 2 使"禁用 agent_list 的配置不会经 agent_status 泄露同样的信息"成立。副作用：无。

#### 5.5.2 可见性

- `AGENT_TOOL_IDS` 加入 `agent_status`；`visibleAgentTools`（`tool/agent.ts:402-404`）在两个分支里都与 `agent_list` 并列。
- 权限隐藏：内置工具按权限 deny 隐藏的机制是 `Permission.disabled`（`permission/index.ts:240-250`）的别名表加 `request.ts:251-257` 的 `resolveTools`，不是注册表的 `visibleTools`（那只管 code-mode 的 MCP 目录）。在别名表加 `agent_status → agent_list`，三个调用点（`llm/request.ts`、`session/system.ts`、`debug/agent.handler.ts`）同时生效。`resolveTools` 还按 `user.tools?.[k]` 逐名开关：`agent_status` 作为独立名字可被单独关掉，但不能单独打开一个被 `agent_list` 规则隐藏的 `agent_status`（别名表先判）。
- 内置受限 agent 的放行列表（`agent/agent.ts` 内置定义的 tools 清单，调研 §17.7）同步加 `agent_status`。
- **正确性论证**：工具表存在性由两维决定——深度（`visibleAgentTools`）与权限（`disabled` 别名）；两维都把 `agent_status` 绑到 `agent_list` 的判定上，故 `agent_status ∈ tools ⇔ agent_list ∈ tools`（I9 工具表的一半）。副作用：无。

#### 5.5.3 `agent_list(params, ctx)`

1. 组装 `AgentInfo` 如今（`neighborhood` + `of`），每行再读 `agentRun`。
2. 过滤：`relation`、`status`、`query`（实例名或标题子串，大小写不敏感，匹配转义前的原文）。
3. 统计 `total / running / idle`（过滤后）。
4. 排序：在跑在前；其余按 `last` 倒序；无记录按 `time_created` 倒序；并列按 session_id。
5. 截断到 `limit ?? 50`；渲染表与计数行。

- **正确性论证**：结果 ⊆ 过滤后的集合 ⊆ 邻居；计数行按截断前的集合算，所以 `shown ≤ total`；默认上限是有意的行为改变，描述里写明。
- T4（随机）：随机生成邻居集合（含重名、无名、无记录）与参数，断言子集关系、计数行与全集统计一致、行数 ≤ limit、排序满足定义。

#### 5.5.4 工具描述

- 按 #59 的原则只写事实：`agent_status` 写它返回什么、范围与 `agent_list` 相同；`agent_list` 写参数含义、默认上限 50 与计数行的含义；`agent_send` 的描述补一句返回里有目标在投递那一刻的 run 状态。不解释 run 号为何会跳号。

## 6. 已确认的设计决策

2026-10-23：

1. **推翻调研 §12，新增 `agent_status`**。理由：#75 的竞态要求在发消息的当下知道目标的 run 号与时间；花名册只在回合边界更新且没有这两项；`agent_list` 能答但要翻整表。工具表面由四个改为五个，架构 G2 改由 `agent_status` 承载（调研 §18）。
2. **结束报告唤醒的 run，`woken_by` 记为发报告的子 agent**，不记 `system`。报告 part 的 metadata 为此加发送方三字段，与 agent_send 的消息同一套字段。
3. **run 号允许不连续**。被取消的 run 由停止通知承载；自己仍有后代在跑时推迟的报告，报告的是实际关闭的那个 run，不回溯补发。停止通知带 run 号与时间。
4. **`agent_send` 对空闲目标写 "starts run N+1 (sent …)"，不写 "started at"**。投递只到"已接受"，不能宣称已开始。
5. **`agentRun` 存在会话元数据里，不加表或列**。所有有父会话的会话都记录；主会话不记录。
6. **#81 的停止钩子**：钩子名 `experimental.session.stop`，输出 `{ decision, reason? }` 默认放行；上限 8 次、调用工具即清零、配置可改；结构化输出的 run 第一版不触发；主会话与子 agent 用同一个钩子、同一分支，宿主不区分；并入本子计划——**run 结束 = 循环退出且钩子放行**。

2026-10-28/29（设计审查后，逐点确认）：

7. **记录只存当前 run 加上一个 run 的结束**，不存环。曾提议最近转换的环，随第 8 点的改法一起撤销：快照视图只需要这两样。
8. **末尾段改为快照视图**：时钟与自身位置、子 agent 总览、在跑列表（开始早的在前）、10 分钟内结束列表（结束晚的在前），各最多 10 行；窗口取 10 分钟与上一步开始以来的较长者。替代原"最近 5 步的变化列表"。写入历史的花名册随之撤销。
9. **结局四种**：completed、failed、stopped、lost。lost 只由新 run 开始时关闭遗留的打开记录产生，没有报告。崩溃后不向父补发通知。
10. **`Session.patch` 按会话加信号量**（方案 1，否决单独建表的方案 2）。HTTP `session.update` 保持整体替换语义，记为已知破坏路径。前提核查 H6c 已通过。
11. **re-arm 由 work 闭包标志判断**，不由记录判断；到达步数上限那一步不询问钩子。
12. **钩子不设超时**，时长由插件负责。
13. **不加默认步数上限**。三个参照实现在交互使用下都无默认上限（Claude Code 文档："No limit by default"）；ZCode 在 #46 引用的提交里给子 agent 写了 `maxTurns ?? 4`，但仓库内没有任何循环消费它，不作为证据。`steps` 保持按 agent 的选择项。
14. **多插件后写者胜**，与现有钩子一致；**`continuations` 按 run 计**（闭包保留）；**人经普通 prompt 端点发进子会话记 `system`**（规则 3 只覆盖 agent-message 路由）；**`query` 不匹配 `agent_type`**。
15. **钩子阻止后的继续消息在 TUI 不可见**，第一版接受，#90 跟进。

与 #75 原文的差异：末尾段内容记 INFO 日志而不是写进助手消息的元数据（修正方案文档 §4.1）；`agent_send` 的措辞按第 4 点改；"最近 5 步的变化"按第 8 点改为快照。

## 7. 完整性自检 checklist

- [x] 推导连续：五个 commit 的插入点均给出前置守卫链与落点行号
- [x] 分支覆盖：钩子六支；`begin` 四种输入、`end` 三种；`wakeSource` 四条规则；`agent_send` 六种目标状态；`renderTermination` 三支；进度视图的无子 / deny / 无变化 / 截断
- [x] 退出覆盖：钩子抛错与空理由的放行；记账失败不阻塞；`agent_status` 的解析失败与权限拒绝；采集失败整节省略
- [x] callee 契约：`Plugin.trigger` 顺序等待且 reject 为 defect（H7）、`hasUnconsumedTurn` 只读一次（H10）、`setMetadata` 整体替换且经锁、runner 重跑同一 work（H9）、`publish` 同步投影（H6b）、`resolveTarget(neighbor)`、`deliverAsync` 立即 fork 均显式引用
- [x] 循环刻画：钩子的连续阻止有上界 `cap`，整体终止性如实陈述为不劣于现状；其余无新循环
- [x] 显式假设链：H6–H11 列于 §0.2，各函数论证引用到条目
- [x] 不变量：I5–I11 各有维护方与测试落点（§5 对应小节）

## 8. 实施顺序与流程绑定

1. 设计确认（本文档）→ **Step 0**：`docs/audits/agentmgmt-2-run-state/expectations.md`（已随本文档同步修订）
2. commit 1（#81 钩子）→ 实现 + 测试 + §5.2 审核
3. commit 2（patch 加锁 + run 记录 + 消息标记）→ 同上，含 T3、T9；H6c 的重入测试先于加锁落地
4. commit 3（进度视图 + 花名册撤销）→ 同上，含 T7
5. commit 4（报告、停止通知、agent_send）→ 同上
6. commit 5（agent_status、agent_list）→ 同上，含 T4
7. Step 5 双验证（路径 A 以仓库单测承担；路径 B subagent 独立审）→ `audit-report.md`、`decisions.md`；回填修正方案文档 `session-fix-step-tail-repeat-and-agents.md` 第六、七、八部分与本文档的 commit hash
8. PR 到 `dev`（不合并，等用户）

## 9. 设计审查记录（2026-10-28/29）

按 workflow §4.4 做了两条线的审查：独立审核 agent（给契约文档与代码，不给作者结论）与作者自审。首版六条结论：架构论证 ⚠️、细化结构 ✅、完整性六条 ⚠️、函数论证 ⚠️、满足规约 ⚠️、无歧义 ❌。必须改的两处与需决策的项目已按 §6 第 7–15 点处理，具体对应：

| 审查项                                    | 处置                                                        |
| ----------------------------------------- | ----------------------------------------------------------- |
| C1 单记录产不出变化列表                   | 视图改为快照（§6 第 8 点），记录改为当前加上一个（第 7 点） |
| C2 H6 不成立（HTTP 替换、patch 整行覆盖） | `Session.patch` 加锁（第 10 点），H6/H6b/H6c 重写           |
| C3/D1 I9 机制位置错                       | 改为 `Permission.disabled` 别名表（§5.5.2）                 |
| C4 遗留打开记录被当 re-arm                | 闭包标志 + 关为 lost（第 9、11 点）                         |
| C5 两次读 `hasUnconsumedTurn`             | `onExit` 内读一次（§5.2.2）                                 |
| C6/D6 停止通知缺第三分支                  | 三分支，`cancel` 返回是否命中在跑 run（§5.4.2）             |
| C7 终止性论据不成立；isLastStep 矛盾      | 如实改写；到上限跳过钩子（第 11 点）                        |
| C8 权限拒绝与 length 退出                 | 列入"不触发"，I7 改为"正常结束效果"                         |
| C9 超时无落点                             | 不设超时（第 12 点）                                        |
| C10–C15、D2–D13、E 各项                   | 已在 §4、§5 与 expectations 中逐条写死                      |
| 作者自审：cap=0 语义、TUI 不可见、文件名  | 已写明（§4.4、§1、§1 表）                                   |

修订后交同一审核 agent 复核，结果回填到 `docs/audits/agentmgmt-2-run-state/audit-report.md`。
