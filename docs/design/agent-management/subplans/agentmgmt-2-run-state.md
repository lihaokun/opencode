# 子计划设计 — agent-management / `agentmgmt-2-run-state`

> 四个 issue 的合并子计划：子 agent 的 run 身份与时序。
>
> - #75 父 agent 分不清子 agent 的时序和数量：run 编号与时间、`agent_status`、`agent_list` 过滤与上限、每步末尾的在跑计数与最近变化
> - #81 没有同步的停止钩子：子 agent 的完成在插件把关之前就到了父那里
> - #73 的服务端一半：agent 发来的消息打上发送方标记（TUI 一半不在本子计划内）
> - #76 的末尾段机制已在 `step-tail` 分支落地（`bfc07a0e80`、`97b272f37f`），本子计划在其上加子 agent 节
>
> 范围：**只做服务端与模型可见表面**。TUI 对 `agent_message` 标记的渲染（#73 的另一半）、花名册是否撤销，均不在本子计划内。
> 组织：一个分支 `step-tail`、五个 commit，顺序 **停止钩子 → run 记录与消息标记 → 末尾段子 agent 节 → 报告与 agent_send → agent_status 与 agent_list**。
> 基线：`step-tail` @ `97b272f37f`（`dev` @ `d9d7de31fb` 加三个 step-tail 提交）——文中行号以此为准，再遇 rebase 需复核。
> 设计决策来源：2026-10-23 与用户逐条确认的五个设计点加 #81 的三点，记录在 §6。

## 0. 架构定位

### 0.1 goal → 模块映射

| goal                                                         | 模块                                                                                     | commit |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | ------ |
| G7 插件能在一次 run 结束前把关，不放行则同一 run 继续（#81） | `SessionPrompt.runLoop` 的正常退出分支 + `Plugin.trigger`（新钩子）                      | 1      |
| G8 每个子 agent 的每次 run 有编号、起止时间、唤醒来源与结局  | `SessionPrompt.loop` 的 work 包装（run 记录 owner）+ `agent-management/run.ts`（纯函数） | 2      |
| G13 agent 发来的消息可被 TUI 按标记识别（#73 服务端）        | M3 `AgentInbox.deliver`（加 metadata，模型可见文本不变）                                 | 2      |
| G12 父在每步末尾看到在跑数量与最近 5 步的变化                | `StepTail` 子 agent 节（M5 表面的一部分，数据来自 G8）                                   | 3      |
| G9 父能把报告、停止通知与 agent_send 的返回对到具体的 run    | `reportRunEnd` 的报告属性、M4 `renderTermination`、M5 `agent_send` 的返回文本            | 4      |
| G10 查询单个 agent 的当前状态（架构 G2 改由此承载）          | M5 新工具 `agent_status`（可见性与权限跟随 `agent_list`）                                | 5      |
| G11 `agent_list` 输出有界、可过滤，且带 run 信息             | M5 `agent_list` 参数                                                                     | 5      |

### 0.2 关键假设

- **H6** 同一会话的 run 开始与结束写入由 runner 串行执行（架构 I3 单活动执行），run 记录的读改写不会自我竞争。外部前提：**会话元数据在运行期间没有其他写入方**——现有写入点只有 `lifecycle.create` 在创建时写一次（`lifecycle.ts:350`）。以后谁要在运行中改元数据，必须先看到本条。
- **H7** 插件钩子按顺序等待（`Plugin.trigger` 对每个钩子 `Effect.promise(() => fn(input, output))`，`plugin/index.ts:284-296`），因此 `(input, output)` 形态的钩子可以同步把关。
- **H8** 合成用户消息落库后，`runLoop` 下一轮顶部重读历史时它就是 `lastUser`，`lastAssistantBelongsToLatestTurn` 为假，退出条件不成立，循环继续——与压缩后自动继续用的是同一机制（`compaction.ts:548-581`）。
- **H9** `hasUnconsumedTurn` 是 re-arm 的唯一判据（`prompt.ts:1554-1566`）；`reportRunEnd` 已用它判断"不是真的结束"，run 记录的关闭与之共用，二者对同一次退出得到同一答案。
- **H10** 子会话的 `parentID` 创建后不变（架构 H2），所以"run 1 由创建者唤醒"可以直接取 `parentID`。

### 0.3 模块级不变量

- **I5（承重）run 号单调**：对任一有父会话，`agentRun.number` 只在"上一个 run 已关闭（有 `ended_at`）或尚无记录"的开始时加一；re-arm 不加；被钩子阻止的停止不加。
- **I6 报告对号**：每份结束报告（completed / failed）与停止通知所标的 run，等于发出时该会话 `agentRun.number`，且该 run 此刻已关闭。
- **I7 钩子先于一切结束效果**：`reportRunEnd`、run 记录关闭、runner 的 `onIdle` 只在钩子放行之后发生；被阻止的停止不产生任何 run 结束的可观察效果（无报告、无 `ended_at`、不转空闲、末尾段不出现 ended 行）。
- **I8 末尾段不入历史**（继承已落地的机制）；子 agent 节只从 run 记录与状态投影读，不从历史读。
- **I9 agent_status ≡ agent_list 的可见性与权限**：工具表中二者同生同灭；执行期按 `agent_list` 的权限键求值。
- **I10 标记不改文本**：#73 的标记只加在 part 的 metadata 上，`AgentInbox.render()` 的输出与结束报告的正文逐字不变。

## 1. 范围

| commit | 触及文件                                                                                                                                                                   | 契约变更                                                                                                    |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 1      | `packages/plugin/src/index.ts`；`packages/opencode/src/session/prompt.ts`；`packages/core/src/v1/config/config.ts`；`packages/core/src/plugin/skill/customize-opencode.md` | 新插件钩子 `experimental.session.stop`；新配置键 `stop_hook_block_cap`；合成继续消息的 metadata `stop_hook` |
| 2      | `packages/opencode/src/agent-management/{schema,run,inbox}.ts`；`session/prompt.ts`                                                                                        | 会话元数据键 `agentRun`；part metadata `agent_message` / `user_message`；结束报告 metadata 增发送方字段     |
| 3      | `packages/opencode/src/session/{step-tail,prompt}.ts`                                                                                                                      | 末尾段新增子 agent 节（模型可见文本）                                                                       |
| 4      | `packages/opencode/src/agent-management/{delegation,lifecycle}.ts`；`session/prompt.ts`；`tool/agent.ts`                                                                   | 报告属性 `run` / `ended`；摘要后缀；停止通知加 run 行；`agent_send` 返回文本                                |
| 5      | `packages/opencode/src/tool/{agent,registry}.ts`；`agent-management/tree.ts`（如需）                                                                                       | 新工具 `agent_status`；`agent_list` 参数、排序、上限与计数行                                                |

明确不做（记录再引入条件）：

- #73 的 TUI 一半：按 `agent_message` 换样式。本子计划只保证标记存在且形状固定。
- 撤销写入历史的花名册：等本子计划上线后看实测再定（#75 原文）。
- `StopFailure` 类钩子：出错退出已有失败报告，没有新诉求。
- 结构化输出 run 的停止把关：它在步骤内部就结束，不经过正常退出分支；阻止后要求模型再产出一次 JSON。第一版不触发，文档写明。
- 停止钩子的 `additionalContext` 非阻止反馈：只做 allow / block 两态。
- run 记录改为独立表或列：只有 agent 工具和末尾段读它，没有查询需求（§6 第 5 点）。

## 2. 与已有代码的复用点

| 复用件                                                 | 位置                                              | 用途                                                                                       |
| ------------------------------------------------------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `Plugin.trigger` 顺序等待的 `(input, output)` 钩子形态 | `plugin/index.ts:284-296`                         | 停止钩子不新造触发机制                                                                     |
| 压缩后合成用户消息的写法                               | `compaction.ts:548-581`                           | 钩子阻止时的继续消息：`updateMessage` + `updatePart(synthetic, metadata)`，不经 `prompt()` |
| `runLoop` 顶部的退出判定                               | `prompt.ts:1222-1275`                             | 钩子插在"正常退出"分支，出错退出分支不动                                                   |
| `hasUnconsumedTurn`                                    | `prompt.ts:1554-1566`                             | run 记录关闭与 `reportRunEnd` 共用的 re-arm 判据                                           |
| `reportRunEnd` / `classifyExit`                        | `prompt.ts:1616-1690`、`:1987`                    | 结局三分类映射到 `outcome`；报告加属性                                                     |
| `AgentDelegation.renderOutput` / `escapeMarkup`        | `delegation.ts:131-147`                           | 报告的 `<agent …>` 标签加 `run` / `ended`                                                  |
| `renderTermination`                                    | `lifecycle.ts:476-490`                            | 停止通知加 run 行                                                                          |
| `AgentInbox.render` / `escapeField`                    | `inbox.ts:40-70`                                  | 模型可见文本不变；末尾段与 agent_status 的名字、标题经同一转义                             |
| `AgentTree.resolveTarget(scope: "neighbor")`           | `tree.ts:147-176`                                 | `agent_status` 的目标解析，与 `agent_send` 同一套                                          |
| `AgentStatusProjection.of`                             | `status.ts`                                       | 在跑计数与 `agent_status` 的 running / idle                                                |
| `visibleAgentTools` / `AGENT_TOOL_IDS`                 | `tool/agent.ts:19,403-404`、`registry.ts:326-345` | `agent_status` 的可见性跟随 `agent_list`                                                   |
| `applyAgentRoster` 的子列表与权限门                    | `reminders.ts:88-104`                             | 末尾段子 agent 节用同一条 `agent_list` 权限规则与同一个 `children(depth+1)` 读法           |
| `StepTail.render` / `message` / `MARKER`               | `step-tail.ts`                                    | 子 agent 节是第二个 section，节序在前                                                      |
| `Session.setMetadata`                                  | `session.ts:853-855`                              | 整体替换，必须先读后写                                                                     |
| 末尾段的缓存与标记处理                                 | `provider/transform.ts:358-362,485-510`           | 已落地，子 agent 节不需要再改                                                              |

## 3. 错误处理策略

- **钩子抛错或超时**：记日志，按放行处理。Claude Code 对此的说明是"钩子不运行时 Claude 无法修复它"，一个跑不起来的钩子不该把 run 卡住。
- **钩子阻止但没有理由**：记警告，按放行处理。理由是模型下一步的全部输入，空理由等于空转一步。
- **run 记录读写失败**：记警告，run 照常进行。记账永远不阻塞执行；代价是那次 run 在记录里缺号或缺结束时间，`agent_status` 会如实显示缺失。
- **末尾段子 agent 节的数据读取失败**：整节省略，重复计数节照常。
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
  - number: PositiveInt — 本会话第几次 run，从 1 起
  - started_at: number — 本次 run 开始的 epoch ms
  - woken_by: WakeSource — 唤醒本次 run 的来源（见 4.2）
  - ended_at?: number — 本次 run 关闭的 epoch ms；缺省表示 run 仍在进行或尚未关闭
  - outcome?: "completed" | "failed" | "stopped" — 本次 run 的结局；与 ended_at 同在同缺

类型不变量：
  - ended_at 存在 ⇔ outcome 存在
  - ended_at ≥ started_at
  - number 单调（I5）；同一会话任意时刻只有一个 AgentRun（最近一次 run），历史 run 不保留
  - 时间以 epoch ms 存，与 Session.time 同口径；对外渲染时再转成带时区的完整时间

写入方：只有 SessionPrompt.loop 的 work 包装（开始与结束各一次），经 run.ts 的纯函数计算新值、
  Session.setMetadata 整体写回。写前重读元数据（setMetadata 是替换不是合并）。

生命周期：创建于子会话第一次 run 开始；每次 run 开始覆盖；会话删除时随元数据消失。

跨模块共享性：跨模块共享 — producer: SessionPrompt.loop；consumer: StepTail 子 agent 节、
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

推导规则（run 开始时，按序，先命中者胜）：
  1. number = 1（首次 run）⇒ { kind: "agent", session: parentID, name/agent 取父会话 }——
     创建者就是唤醒者（H10）
  2. 唤醒本次 run 的用户消息（run 开始时 MessageV2.latest(msgs).user）的首个 text part 的
     metadata.kind ∈ { "agent_message", "agent_notification" } ⇒ { kind: "agent", 取其 sender 三字段 }
     —— agent_send 的消息、停止通知、子 agent 的结束报告都落在这里（决策 §6 第 2 点）
  3. 该 part 的 metadata.kind = "user_message" ⇒ { kind: "user" }（人经 TUI 发进子会话）
  4. 其余 ⇒ { kind: "system" }（压缩后的自动继续等）

渲染规则（末尾段、agent_status、agent_list 共用）：
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

人经 TUI 发进子会话的消息 —— deliver 的 kind = "user" 路径，头行 part：
  - kind: "user_message"

子 agent 的结束报告 —— reportRunEnd 写入父的 synthetic part，在既有 { kind: "agent_notification", summary }
  之上增加：
  - sender: SessionID（子会话）
  - sender_name?: string
  - sender_agent?: string

类型不变量：
  - 模型可见的 part.text 逐字不变（I10）；metadata 只供 TUI 识别与 WakeSource 推导
  - 三个 kind 字面量与既有 "agent_notification" 一起由 agent-management/schema.ts 导出；
    TUI 无法 import（part metadata 在 SDK 侧是自由 record），按子计划 1 的 §10 约定各持一份
  - 旧记录没有标记，读者必须容忍缺失（WakeSource 规则 4 兜底）
```

### 4.4 停止钩子（commit 1；#81）

```
接口：SessionPrompt.runLoop → Plugin.trigger("experimental.session.stop", input, output)

input：
  - sessionID: SessionID
  - parentID?: SessionID — 子 agent 时存在；主会话为空。宿主不据此区分，插件自行决定管谁
  - agent: string — 本会话当前绑定的 agent 定义名
  - message: { info: <助手消息>, parts: Part[] } — 模型的最终回答（SDK v2 若导出 AssistantMessage
    则用之，否则用 Message 并注明 role 恒为 assistant）；对应 Claude Code 的 last_assistant_message
  - continuations: number — 本次 run 内连续被阻止的次数；> 0 即 Claude Code 的 stop_hook_active

output（默认 { decision: "allow" }）：
  - decision: "allow" | "block"
  - reason?: string — block 时必填；作为模型下一步的全部输入

触发条件：runLoop 的正常退出分支——最后一条助手消息有终止 finish、不含工具调用、属于最新一轮。
  不触发：助手消息带错误、人中断、agent_stop 取消、结构化输出在步骤内结束。
  主会话与子 agent 走同一个分支、同一个输入格式、同一套上限。

阻止的效果：落库一条用户消息，一个 text part：text = reason、synthetic: true、
  metadata { kind: "stop_hook", reason }；continuations + 1；循环继续，仍在同一次 run 内。

上限：连续阻止达到 cfg.stop_hook_block_cap（默认 8）后本次不再询问钩子，直接退出并记日志；
  任一步包含工具调用即清零。两条都是 Claude Code 文档原文的规则。0 表示永不接受阻止。

配置键：stop_hook_block_cap: NonNegativeInt，与 subagent_depth 同级（config.ts:84 旁）。
```

### 4.5 末尾段子 agent 节（commit 3）

```
数据结构：StepTail 子 agent 节（模型可见文本，只存在于本步请求）

附带条件：会话有直接子 agent，且调用者的 agent_list 权限不是 deny（与花名册同一条规则）。
  两条都不满足时整节省略；有子但近 5 步无变化时只有第一行。

第一行：`Your subagents running now: N` —— N 为直接子中状态投影为 running 的个数

变化列表（可选）：
  标题行 `Changes in your last 5 steps:`
  每行 `  HH:MM:SS  <name|session_id>  run <k> started (<来源>)`
   或 `  HH:MM:SS  <name|session_id>  run <k> ended (<outcome>)`
  - 窗口起点：本 run 内往前第 5 步的开始时间（本步是第 s 步时取第 max(1, s−5) 步的开始；
    s ≤ 5 时即 run 开始）。同一变化会在随后至多 5 步里重复出现，这是有意的：
    报告被排到发送之后的那一步也能看到它，正是 #75 的竞态
  - 对每个直接子，其 agentRun 的 started_at 与 ended_at 各生成一行（若落在窗口内），按时间升序
  - 上限 8 行；超出时丢弃最早的，并在列表开头写一行 `  … and N more changes`
  - 来源按 4.2 的渲染规则；名字经 escapeField

类型不变量：
  - 只读 agentRun 与状态投影，不读历史（I8）
  - 节序：子 agent 节在前，重复计数节在后（修正方案文档 §4.1）
  - 时间用主机本地时间的 HH:MM:SS；报告属性与 agent_send 用同一时区的完整时间——同一会话里
    两处必须是同一时区，否则模型对不上时序
```

### 4.6 报告、停止通知与 `agent_send` 的返回（commit 4）

```
结束报告（reportRunEnd）：
  模型可见：`<agent id="ses_xxx" state="completed|error" run="5" ended="2026-10-20T03:41:18+08:00">`
  TUI 摘要：`Agent completed: <描述> (run 5, ended 03:41:18)`，失败同理
  run / ended 取自关闭后的 agentRun（I6）

停止通知（renderTermination）新增一行：
  `run: 5, stopped at 2026-10-20T03:41:18+08:00`
  —— 被 agent_stop 停下的 run 仍不单独报告（架构 §4.4），但它的编号经这一行与 agent_status 可见

run 号允许不连续（决策 §6 第 3 点）：被取消的 run 由停止通知承载；自己仍有后代在跑时推迟的报告，
  报告的是实际关闭的那个 run，不回溯补发。工具描述里不解释这些；解释在本文档与报告措辞里。

agent_send 的返回（在 deliver 之前读取目标的状态投影与 agentRun 作为快照）：
  目标空闲，有记录：
    `ses_xxx (cw-b333) was idle; this message starts run 6 (sent 2026-10-20T03:41:27+08:00).`
    `Its run 5 ended at 2026-10-20T03:41:18+08:00 (completed); that report reaches you as a separate message.`
  目标空闲，无记录：第二句省略；首次 run 写 `starts run 1`
  目标在跑：`ses_xxx (cw-b333) is in run 5 (started 2026-10-20T03:40:02+08:00); it reads this at its next step.`
  目标没有 agentRun 也不是子会话（如主会话）：只写 `is running` / `is idle`，不写 run 号
  末尾恒加一行：`Current state of one agent: agent_status(target="ses_xxx").`
  既有的三句"单向消息"说明保留在上述内容之后
```

### 4.7 工具 schema（commit 5）

```
工具：agent_status
  target: string — session_id，或调用者邻居中某个 Agent 的实例名
返回（key: value 行）：
  session_id / name / agent_type / relation / status（running | idle）
  run：在跑 → `6, started <ISO>, woken by <来源>`；空闲有记录 → `5, ended <ISO> (completed)`；
       从未跑过 → `none yet`；非子会话 → 省略本行
  workdir
可查范围、解析与权限：与 agent_list 相同（I9）

工具：agent_list（参数全部可选）
  status?:   "running" | "idle"
  relation?: "self" | "parent" | "child" | "sibling"
  query?:    string — 名字或标题的子串，大小写不敏感
  limit?:    PositiveInt — 默认 50
返回：
  表头 session_id / name / agent_type / relation / status / run / last / title / workdir
    run：agentRun.number，无记录留空；last：max(started_at, ended_at) 的 ISO，无记录留空
  排序：在跑的在前；其余按 last 倒序，无记录的按 time_created 倒序
  末尾计数行：`showing <shown> of <total> (<running> running, <idle> idle)`——total 与两个计数按
    过滤后、截断前的集合统计
  不带参数时默认上限 50，这是对现有输出的有意改变
```

## 5. 模块细化

### 5.1 commit 1（#81）：停止钩子

#### 5.1.1 `Hooks["experimental.session.stop"]`（`plugin/src/index.ts`）

- 按 4.4 的 input / output 加到 `Hooks` 接口，位置在 `experimental.compaction.autocontinue` 之后，注释说明触发条件与阻止效果。
- `customize-opencode.md` 的钩子列表补一条。
- **正确性论证**：trivial（类型声明）。运行时按名字触发，旧插件不实现即不受影响。

#### 5.1.2 `runLoop` 正常退出分支的把关（`prompt.ts:1261-1275`）

- 新增 run 级状态 `continuations = 0`。在循环顶部、`hasToolCalls` 求得为真时清零（模型调用了工具）。
- 把关插在 `yield* Effect.logInfo("exiting loop", …)` 之前：
  1. `cap = cfg.stop_hook_block_cap ?? 8`；`continuations >= cap` → 记日志 `stop hook cap reached` → 退出（既有 `break`）。
  2. `decision = plugin.trigger("experimental.session.stop", input, { decision: "allow" })`，`input` 按 4.4 组装，`message` 取 `lastAssistantMsg`。抛错 → 记日志 → 放行。
  3. `decision !== "block"` → 退出。`reason` 缺省或空白 → 记警告 → 退出。
  4. 阻止：照 `compaction.ts:548-581` 落库一条用户消息（`agent` / `model` 取 `lastUser` 的），一个 text part：`text = reason`、`synthetic: true`、`metadata: { kind: "stop_hook", reason }`；`continuations += 1`；`continue`。
- **分支覆盖**：到顶 / 钩子抛错 / 放行 / 阻止无理由 / 阻止有理由，五支各一测。
- **正确性论证**：
  - 前置：进入该分支即模型给出了最终回答且没有待执行的工具调用；出错退出分支在它之前已 `break`，所以带错误的助手消息不经此处。
  - 论证：阻止时落库的用户消息使下一轮顶部 `lastAssistantBelongsToLatestTurn` 为假（H8），退出条件不成立，循环继续；这一切都在同一次 `runLoop` 调用内，故 `loop()` 的 `onExit`（`reportRunEnd` 与 run 记录关闭）与 runner 的 `onIdle` 都尚未发生——这就是 I7。终止性：每次阻止使 `continuations` 加一，清零只在模型调用工具时发生；连续阻止有上界 `cap`，而模型调用工具后 run 的其余部分由既有 `MAX_STEPS` 保证有界。
  - 与末尾段的关系：继续消息不是工具调用，重复计数的"上一步"签名不变；它作为新的 `lastUser` 不影响任何已发送前缀。
  - 后置：放行 ⇒ 既有退出路径逐字不变；阻止 ⇒ 历史多一条合成用户消息、run 号不变、父未收到报告。
  - 副作用论证：至多写入一条用户消息与一个 part。

#### 5.1.3 配置键 `stop_hook_block_cap`（`core/src/v1/config/config.ts:84` 旁）

- `Schema.optional(NonNegativeInt)`，描述写明默认 8、0 表示不接受阻止、调用工具即清零。
- **正确性论证**：trivial。

#### 5.1.4 测试

- 脚本化 LLM：最终回答 → 假插件阻止两次再放行 → 请求数为 3，中间两次请求的最后一条用户消息文本等于理由，父（若为子 agent）只收到一份报告，报告在放行之后。
- 上限：`stop_hook_block_cap: 2` 时第三次不再询问钩子；一步含工具调用后计数清零（再阻止两次仍生效）。
- 钩子抛错、阻止无理由 → 放行且 run 正常结束。
- 出错退出不触发钩子（钩子被调用次数为 0）。

### 5.2 commit 2：run 记录与消息标记

#### 5.2.1 `agent-management/run.ts`（新，纯函数）

- `begin(previous: AgentRun | undefined, now, wokenBy) -> AgentRun | undefined`：`previous` 存在且无 `ended_at` → 返回 `undefined`（re-arm，不写）；否则返回 `{ number: (previous?.number ?? 0) + 1, started_at: now, woken_by }`。
- `end(current: AgentRun | undefined, now, outcome) -> AgentRun | undefined`：`current` 缺失或已有 `ended_at` → `undefined`（不写，记警告由调用方做）；否则返回补上 `ended_at` / `outcome` 的副本。
- `wakeSource(message: WithParts | undefined, number, parent) -> WakeSource`：按 4.2 规则 1–4。
- `formatInstant(ms) -> string`（带本地时区偏移的 ISO 8601）、`formatClock(ms) -> string`（HH:MM:SS）、`describeSource(source, viewer) -> string`（4.2 渲染规则）。
- **正确性论证**：全部为无副作用的纯函数；`begin` 与 `end` 的四种输入组合各一测；I5 由 `begin` 的条件直接给出。

#### 5.2.2 `SessionPrompt.loop` 的 work 包装（`prompt.ts:1568-1588`）

- 只对 `session.parentID` 存在的会话包装（`agentNotify` 为 false 的命令子任务也包）：

  ```
  work = recordRunStart(session) → runLoop(id) → onExit(exit => recordRunEnd(session, exit) → reportRunEnd(...))
  ```

  `reportRunEnd` 仍只在 `agentNotify === true` 时挂上；`recordRunEnd` 在它**之前**执行，这样报告读到的是已关闭的 run（I6）。

- `recordRunStart`：重读会话元数据；`previous = metadata.agentRun`；`wokenBy = wakeSource(latest user, previous?.number + 1, parent)`；`next = begin(previous, now, wokenBy)`；`next` 存在才 `setMetadata({ ...metadata, agentRun: next })`。
- `recordRunEnd`：`Exit.isSuccess(exit) && hasUnconsumedTurn(id)` → 不关闭（与 `reportRunEnd` 同一判据，H9）；否则 `outcome` 由 `classifyExit` 的三分类映射（completed → completed、failed → failed、cancelled → stopped）；重读元数据；`next = end(current, now, outcome)`；存在才写回。写失败只记警告。
- **正确性论证**：
  - 前置：runner 对一次 run 恰执行一次 work（既有，`startDelegation` 的 run-end notice 论证同此）。
  - 论证：开始与结束各写一次，二者串行（H6）；re-arm 时 `hasUnconsumedTurn` 为真 → 不关闭 → 下一次 work 的 `begin` 看到无 `ended_at` → 不加号。这给出 I5。被钩子阻止的停止根本不退出 `runLoop`，不到这里（I7）。`reportRunEnd` 读 `agentRun` 时已关闭（顺序由 `onExit` 内的先后给出），给出 I6。
  - 后置：每次 run 至多一次开始写入、至多一次结束写入。
  - 副作用论证：至多两次 `setMetadata`；记账失败不影响 run。

#### 5.2.3 `AgentInbox.deliver` 的标记（`inbox.ts:114-120`，#73 服务端）

- Step P3 的 parts：`kind = "agent"` → `[{ type: "text", text: render(message), metadata: { kind: "agent_message", sender, sender_name?, sender_agent? } }]`；`kind = "user"` → 头行 part 加 `metadata: { kind: "user_message" }`，用户 parts 原样。
- `reportRunEnd` 写入父的 part：metadata 增 `sender: child.id`、`sender_name`、`sender_agent`。
- **正确性论证**：`render()` 与头行文本不变（I10）；metadata 经 `prompt()` 的 text part 输入透传（`reportRunEnd` 已这样传 `{kind, summary}`）。
- 测试：三条路径的 metadata 形状；模型收到的文本与改前逐字相同（断言请求体）；`[Message from user]` 路径不带 `agent_message`。

#### 5.2.4 测试

- run 记录：首次 run 为 1 且 `woken_by` 为父；agent_send 唤醒的 run 加一且来源为发送方；结束报告唤醒祖辈时来源为发报告的子；人经 TUI 端点唤醒为 user；re-arm 不加号；`agent_stop` 记 `stopped`；钩子阻止不加号、不写 `ended_at`。
- P3（PBT，run 层）：随机事件序列（向空闲 / 在跑的子发送、完成 / 失败 / 被停、re-arm、并发多子），经真实 `loop` 执行，断言：每个子的 run 号严格递增；每份报告的 run 号等于该时刻已关闭的 run；`ended_at ≥ started_at`；agent_send 预告的 run 号与该子的下一份报告一致。

### 5.3 commit 3：末尾段子 agent 节

#### 5.3.1 `StepTail.renderSubagents(input) -> string | undefined`（纯函数）

- 入参：`{ running: number, changes: Change[], windowStart: number, now, viewer: SessionID }`，`Change = { at, who: { name?, session }, kind: "started" | "ended", run, source?: WakeSource, outcome? }`。
- 步骤：过滤 `at ≥ windowStart`；按 `at` 升序；超过 8 行取最后 8 行并在前面加 `… and N more changes`；渲染 4.5 的格式；`changes` 为空时只返回第一行。
- **正确性论证**：纯函数；行数上界 9；排序稳定（`at` 并列时按 session_id）。

#### 5.3.2 `runLoop` 中的数据采集（`prompt.ts:1433` 组装 tail 处）

- run 级状态 `stepStarts: number[]`，每步进入时 push `Date.now()`。
- 采集：`children = tree.children(id, depth + 1)`；为空或 `agent_list` 为 deny → 不附带（与 `applyAgentRoster` 同一规则）。对每个子：`projection.of` 得状态；`sessions.get` 得 `agentRun`，生成至多两条 `Change`。`windowStart = stepStarts[max(0, stepStarts.length − 6)]`（本步已 push，往前第 5 步）。
- `tail = StepTail.render([renderSubagents(...), renderRepeat(repeat)])`。
- **正确性论证**：读取量与直接子数线性，与花名册每轮的读取同量级；只在有子的会话上发生。窗口按本 run 的步起点算，新 run 从头算（run 级状态）。
- 测试：无子不附带；有子无变化只一行；变化在窗口内出现、出窗口消失；超 8 行截断保留最近的；来源标注四种各一例；`agent_list` deny 时不附带；节序与重复计数节共存。
- P7（PBT）：随机生成子的 run 事件与步起点序列，断言每条变化恰在其后至多 5 步的末尾段里出现、之后不再出现；行数 ≤ 9。

### 5.4 commit 4：报告、停止通知与 `agent_send`

#### 5.4.1 `renderOutput` 与 `reportRunEnd`

- `renderOutput` 入参增 `run?: number`、`ended?: number`，有值时输出 `run="…" ended="<ISO>"`。
- `reportRunEnd`：读关闭后的 `agentRun`，传入 `run` / `ended`；摘要后缀 ` (run 5, ended 03:41:18)`。无记录（记账失败）时省略属性与后缀。
- **正确性论证**：I6 由 5.2.2 的顺序给出；TUI 只读 `summary`，后缀是 server 的措辞 owner（子计划 1 §4.1）。

#### 5.4.2 `renderTermination`

- 入参增 `run?: AgentRun`，有记录时加一行 `run: 5, stopped at <ISO>`（`ended_at` 由 5.2.2 在取消退出时写入；`stop` 发通知时重读目标元数据）。
- 注意顺序：`stop` 的通知在 `cancel` 之后发出，但 `recordRunEnd` 在被取消 fiber 的 `onExit` 里异步完成，`stop` 读到的记录可能尚未关闭。此时写 `run: 5, stop requested at <now>`；不等待。**不为此加同步**：通知的强度本就只到"已接受"。
- 测试：两种时序各一例（用 Deferred 控制取消退出的时机）。

#### 5.4.3 `agent_send` 的返回（`tool/agent.ts:300-315`）

- 在 `deliver` **之前**取快照：`status = projection.of(target)`、`run = target.metadata.agentRun`、`isChild = target.parentID !== undefined`。
- 按 4.6 四种情况渲染；末尾加 `agent_status` 提示行；既有三句保留。
- **正确性论证（决策 §6 第 4 点）**：目标在跑时，按 I5 消息进入当前 run 或紧接着的 re-arm run，run 号仍是 N，"is in run N" 成立。目标空闲时下一次开始的 run 必为 N+1；即使别的消息抢先唤醒，本消息也只是进入 run N+1，"starts run N+1" 仍成立。投递失败时工具本身返回失败文本，不输出这段话。快照在 deliver 之前取，避免 fork 已启动目标后读到 N+1 与 busy 的混合状态。
- 测试：空闲有记录、空闲无记录、在跑、非子会话四例；预告的 run 号与下一份报告一致（P3 覆盖）。

### 5.5 commit 5：`agent_status` 与 `agent_list`

#### 5.5.1 `agent_status(params, ctx)`（`tool/agent.ts` 新工具，ID `agent_status`）

1. `resolveTarget(caller, params.target, "neighbor")`，失败渲染同 `agent_send`。
2. `Permission.evaluate(AGENT_LIST_TOOL_ID, "*", merged ruleset)` 为 deny → 返回失败文本（I9 执行期的一半）。
3. `sessions.get(target)`、`projection.of(target)`、`neighborhood(caller)` 取 relation。
4. 按 4.7 渲染。

- **正确性论证**：解析范围与 `agent_list` 同为邻居；步骤 2 使"禁用 agent_list 的配置不会经 agent_status 泄露同样的信息"成立。副作用：无。

#### 5.5.2 可见性（`tool/agent.ts:19,403-404`、`registry.ts:326-345`）

- `AGENT_TOOL_IDS` 加入 `agent_status`；`visibleAgentTools` 在两个分支里都与 `agent_list` 并列。
- `registry.ts` 的权限过滤对 `agent_status` 以 `agent_list` 的规则求值：`Permission.visibleTools` 以工具名为键，这里在过滤时把 `agent_status` 的判定键改写为 `agent_list`（I9 工具表的一半）。
- 内置受限 agent 的放行列表（架构调研 §17.7）同步加 `agent_status`。

#### 5.5.3 `agent_list(params, ctx)`

1. 组装 `AgentInfo` 如今（`neighborhood` + `of`），每行再读 `agentRun`。
2. 过滤：`relation`、`status`、`query`（名字或标题子串，大小写不敏感，经 escape 前的原文匹配）。
3. 统计 `total / running / idle`（过滤后）。
4. 排序：在跑在前；其余按 `last` 倒序；无记录按 `time_created` 倒序；并列按 session_id。
5. 截断到 `limit ?? 50`；渲染表与计数行。

- **正确性论证**：结果 ⊆ 过滤后的集合 ⊆ 邻居；计数行按截断前的集合算，所以 `shown ≤ total`；默认上限是有意的行为改变，描述里写明。
- P4（PBT）：随机生成邻居集合（含重名、无名、无记录）与参数，断言子集关系、计数行与全集统计一致、行数 ≤ limit、排序满足定义。

#### 5.5.4 工具描述

- 按 #59 的原则只写事实：`agent_status` 写它返回什么、范围与 `agent_list` 相同；`agent_list` 写参数含义、默认上限 50 与计数行的含义；`agent_send` 的描述补一句返回里有目标在投递那一刻的 run 状态。不解释 run 号为何会跳号。

## 6. 已确认的设计决策（2026-10-23）

1. **推翻调研 §12，新增 `agent_status`**。理由：#75 的竞态要求在发消息的当下知道目标的 run 号与时间；花名册只在回合边界更新且没有这两项；`agent_list` 能答但要翻整表。工具表面由四个改为五个，架构 G2 改由 `agent_status` 承载（调研 §18）。
2. **结束报告唤醒的 run，`woken_by` 记为发报告的子 agent**，不记 `system`。报告 part 的 metadata 为此加发送方三字段，与 agent_send 的消息同一套字段。
3. **run 号允许不连续**。被取消的 run 由停止通知承载；自己仍有后代在跑时推迟的报告，报告的是实际关闭的那个 run，不回溯补发。停止通知带 run 号与时间，格式与报告一致。
4. **`agent_send` 对空闲目标写 "starts run N+1 (sent …)"，不写 "started at"**。投递只到"已接受"，不能宣称已开始。在跑目标写 "is in run N (started …)"。两句在竞态下的成立性见 5.4.3。
5. **`agentRun` 存在会话元数据里，先读后写，不加表或列**。所有有父会话的会话都记录；主会话不记录。写入方只有本会话 run 的开始与结束，由 runner 串行（H6）。
6. **#81 的停止钩子**：钩子名 `experimental.session.stop`，输出 `{ decision, reason? }` 默认放行；上限 8 次、调用工具即清零、配置可改；结构化输出的 run 第一版不触发；主会话与子 agent 用同一个钩子、同一分支，宿主不区分；并入本子计划，因为 run 结束的边界正是在这里定义的——**run 结束 = 循环退出且钩子放行**。

与 #75 原文的两处差异：末尾段内容记 INFO 日志而不是写进助手消息的元数据（消息部件没有通用元数据字段，修正方案文档 §4.1）；`agent_send` 的措辞按第 4 点改。

## 7. 完整性自检 checklist

- [x] 推导连续：五个 commit 的插入点均给出前置守卫链与落点行号
- [x] 分支覆盖：钩子五支；`begin` / `end` 四种输入组合；`wakeSource` 四条规则；`agent_send` 四种目标状态；`renderTermination` 两种时序；子 agent 节的无子 / 无变化 / 截断 / deny
- [x] 退出覆盖：钩子抛错与空理由的放行；记账失败不阻塞；`agent_status` 的解析失败与权限拒绝
- [x] callee 契约：`Plugin.trigger` 顺序等待（H7）、`hasUnconsumedTurn`（H9）、`setMetadata` 整体替换、`runner` 一次 work 一次 run、`resolveTarget(neighbor)` 均显式引用
- [x] 循环刻画：钩子阻止的连续次数有上界 `cap`，调用工具后由既有 `MAX_STEPS` 兜底；其余无新循环
- [x] 显式假设链：H6–H10 列于 §0.2，各函数论证引用到条目
- [x] 不变量：I5–I10 各有维护方与测试落点（§5 对应小节）

## 8. 实施顺序与流程绑定

1. 设计确认（本文档）→ **Step 0**：产出 `docs/audits/agentmgmt-2-run-state/expectations.md`（v2 强制，覆盖 §4 七个契约 + I5–I10）
2. commit 1（#81 钩子）→ 实现 + 测试 + §5.2 审核
3. commit 2（run 记录 + 消息标记）→ 同上，含 P3
4. commit 3（末尾段子 agent 节）→ 同上，含 P7
5. commit 4（报告、停止通知、agent_send）→ 同上
6. commit 5（agent_status、agent_list）→ 同上，含 P4
7. Step 5 双验证（路径 A 以仓库单测承担；路径 B subagent 独立审）→ `audit-report.md`、`decisions.md`；回填修正方案文档 `session-fix-step-tail-repeat-and-agents.md` 第六、七、八部分与本文档的 commit hash
8. PR 到 `dev`（不合并，等用户）
