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
> 设计决策来源：2026-10-23 的六个设计点，2026-10-28/29 两轮设计审查后的裁决，全部记录在 §6。审查记录见 §9。

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
- **H6b** `Updated` 是持久化事件，投影在 `publish` 返回之前于事务内同步完成（`core/src/event.ts` 的 `commitDurableEvent` 在 `Effect.uninterruptible` 的事务里逐个执行 projector，237-353）。因此锁住"读、合并、发布"这一段即可保证后一个 patch 读到前一个的结果。
- **H6c** `publish` 还会在返回前同步等待全部 `listen` 监听者（`event.ts:406-412`），所以锁内发布期间若有监听者回头 patch 同一会话，就会在不可重入的信号量上挂死。2026-10-29 核对的全部 `listen` 注册点（`grep "\.listen(" opencode/src core/src`，排除网络监听）：`share/share-next.ts:170` 只读会话并入队、flush 已 fork；`event-v2-bridge.ts:35` 只向同步的 `GlobalBus`（EventEmitter）转发，回调不能 yield；`server/.../handlers/event.ts:32` 只入队；`plugin/index.ts:255` 对插件的 `event` 钩子是 `void` 掉的，不等待，插件在钩子里再 patch 会在锁外排队而不是死锁；`session/llm.ts:176` 只过滤权限回复事件；2026-11-01 代码审核另核出 `project/vcs.ts:319`、`project/project.ts:388`、`core/src/event.ts:155`（只入队）、`cli/cmd/github.handler.ts:853`，均不 patch 会话。结论：现状没有重入路径。守卫（§5.2.0）：锁的获取带 30 秒超时，超时即 `die` 并带会话 id，让未来的重入或卡死成为可见的缺陷而不是永久挂起。
- **H7** 插件钩子按顺序等待（`Plugin.trigger` 对每个钩子 `Effect.promise(() => fn(input, output))`，`packages/opencode/src/plugin/index.ts:284-296`），因此 `(input, output)` 形态的钩子可以同步把关。它没有超时；钩子 reject 成为 defect，不是类型化错误。
- **H8** 合成用户消息落库后，`runLoop` 下一轮顶部重读历史时它就是 `lastUser`，`lastAssistantBelongsToLatestTurn`（`prompt.ts:1232-1235`）为假，退出条件不成立，循环继续——与压缩后自动继续用的是同一机制（`compaction.ts:548-581`）。
- **H9** runner 对一次 run 恰执行一次 work；re-arm 时重新执行的是**同一个 work 对象**（`effect/runner.ts:90-95` `startRun(work, fresh)`）；`ensureRunning` 在 Running 态只 `awaitDone`（`runner.ts:149-151`）。`work` 由 `loop()` 每次调用新建，所以 work 闭包里的局部变量在 re-arm 之间保留、在新 run 之间不共享。这是 §5.2.2 用闭包标志判断 re-arm 的依据。
- **H9b** `Runner.startRun` 不调 `onBusy`（`runner.ts:121-130`，只有 `startShell` 调），会话状态是 `runLoop` 顶部（`prompt.ts:1226`）每步置 busy 的。所以 work 里 run 记录的开始写入必须自己先置 busy，否则有一个"记录已打开、状态还是 idle"的启动窗口（§5.2.2）。
- **H10** `hasUnconsumedTurn`（`prompt.ts:1554-1566`）是 runner re-arm 的判据，在 runner 的临界区内读；`reportRunEnd` 已用它判断"不是真的结束"。本子计划在 work 的 `onExit` 内另读一次，结果同时交给 run 记录关闭与报告；两次读之间落下的消息由 §5.2.1 的"续跑时记录已关闭 ⇒ 新 run"兜住（§5.2.2 论证）。
- **H11** 子会话的 `parentID` 创建后不变（架构 H2），所以"run 1 由创建者唤醒"可以直接取 `parentID`。
- **H12** `SessionStatus.set` 在 `runLoop` 每步顶部被调用（`prompt.ts:1226`），是内存投影；给它加一个"最近一次置位时间"即可免费得到每个在跑子 agent 的最后一步时间，不需要任何落盘。

### 0.3 模块级不变量

- **I5（承重）run 号单调**：对任一有父会话，run 号只在"新 run 开始"时加一，新 run 的判定是：work 首次执行（闭包标志，H9），或续跑时记录已被 `onExit` 关闭（§5.2.1）。普通 re-arm（记录仍打开）不加；被钩子阻止的停止不加。记录写失败或进程崩溃留下的打开记录，在下一次新 run 开始时关为 `lost` 再开新号，两个 run 不共号。
- **I6 报告对号**：每份结束报告（completed / failed）与停止通知所标的 run，等于发出时该会话记录里已关闭的当前 run；记录缺失或未关闭时报告不带 run 属性。
- **I7 钩子先于一切正常结束效果**：模型自行给出最终回答的退出，先经钩子；放行后才有 run 记录关闭、`reportRunEnd`、runner 的 `onIdle`。被阻止的停止不产生任何 run 结束的可观察效果。不经钩子的退出（出错、权限或提问被拒、输出截断、人中断、`agent_stop`、步数上限）仍走记录关闭与报告，它们不是模型自己决定的停止。
- **I8 末尾段不入历史**（继承已落地的机制）；进度视图只从 run 记录、会话行与状态投影读，不读历史。
- **I9 agent_status ≡ agent_list 的可见性与权限**：工具表中二者同生同灭（深度与权限两维）；执行期按 `agent_list` 的权限键求值。
- **I10 标记不改文本**：#73 的标记只加在 part 的 metadata 上，`AgentInbox.render()` 的输出与结束报告的正文逐字不变。
- **I11 patch 不丢字段**：对同一会话的任意并发 patch 序列，最终行等于某个串行执行的结果；没有任何一次 patch 写入的字段被另一次 patch 的旧快照抹掉。

## 1. 范围

| commit | 触及文件                                                                                                                                                                                                 | 契约变更                                                                                                                        |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 1      | `packages/plugin/src/index.ts`（Hooks 类型）；`packages/opencode/src/session/prompt.ts`；`packages/core/src/v1/config/config.ts`；`packages/core/src/plugin/skill/customize-opencode.md`                 | 新插件钩子 `experimental.session.stop`；新配置键 `stop_hook_block_cap`；合成继续消息的 metadata `stop_hook`                     |
| 2      | `packages/opencode/src/session/{session,status}.ts`（patch 加锁；状态投影带时间）；`agent-management/{schema,run,inbox}.ts`；`session/prompt.ts`                                                         | `Session.patch` 按会话串行；会话元数据键 `agentRun`；part metadata `agent_message` / `user_message`；结束报告 metadata 增发送方 |
| 3      | `packages/opencode/src/session/{step-tail,prompt,reminders}.ts`；`agent-management/schema.ts`（`ROSTER_MAX_ROWS` 注释）；web `agents.mdx`                                                                | 末尾段新增进度视图（模型可见文本）；写入历史的花名册撤销                                                                        |
| 4      | `packages/opencode/src/agent-management/{delegation,lifecycle}.ts`；`effect/runner.ts`、`session/run-state.ts`（`cancel` 返回取消前状态）；`session/prompt.ts`；`tool/agent.ts`                          | 报告属性 `run` / `ended`；摘要后缀；停止通知加 run 行；`agent_send` 返回文本                                                    |
| 5      | `packages/opencode/src/tool/{agent,registry}.ts`；`permission/index.ts`（`disabled` 别名表）；`agent-management/{schema,tree}.ts`（`AgentSkeleton.run`）；文档 `customize-opencode.md`、web `agents.mdx` | 新工具 `agent_status`；`agent_list` 参数、排序、上限与计数行                                                                    |

明确不做（记录再引入条件）：

- #73、#90 的 TUI 一半：按 `agent_message` / `stop_hook` 标记换样式。本子计划只保证标记存在且形状固定。
- `StopFailure` 类钩子：出错退出已有失败报告，没有新诉求。
- 结构化输出 run 的停止把关：它在步骤内部就结束，不经过正常退出分支；阻止后要求模型再产出一次 JSON。第一版不触发，文档写明。
- 停止钩子的 `additionalContext` 非阻止反馈：只做 allow / block 两态。
- 钩子超时：`Plugin.trigger` 没有超时，其他钩子也都没有；时长由插件自己负责（§6 第 12 点）。
- 默认步数上限：上游 V1/V2、Claude Code 交互模式、ZCode（#46 引用的提交）均无默认上限；`steps` 保持按 agent 的选择项（§6 第 13 点，调研 §18.4）。
- run 记录改为独立表或列：只有 agent 工具和末尾段读它，没有查询需求（§6 第 5 点）；HTTP `session.update` 以旧副本整体替换元数据仍会抹掉记录，读者容忍缺失，记为已知破坏路径。
- 崩溃后向父补发"上一个 run 丢失"的通知：父的下一步进度视图会把它列为 `cut off`（§4.5），不另发消息。

## 2. 与已有代码的复用点

| 复用件                                                 | 位置                                                                                           | 用途                                                                                                                                                              |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Plugin.trigger` 顺序等待的 `(input, output)` 钩子形态 | `packages/opencode/src/plugin/index.ts:284-296`                                                | 停止钩子不新造触发机制；reject 为 defect，用 `catchAllCause` 收                                                                                                   |
| 压缩后合成用户消息的写法                               | `compaction.ts:548-581`                                                                        | 钩子阻止时的继续消息：`updateMessage` + `updatePart(synthetic, metadata)`，不经 `prompt()`                                                                        |
| `runLoop` 顶部的退出判定                               | `prompt.ts:1225-1279`                                                                          | 钩子插在正常退出分支（1259-1279），出错退出分支（1241-1248）不动                                                                                                  |
| `hasUnconsumedTurn`                                    | `prompt.ts:1554-1566`                                                                          | `onExit` 内读一次，交给记录关闭与报告                                                                                                                             |
| `reportRunEnd` / `classifyExit`                        | `prompt.ts:1616-1690`、`:1987`                                                                 | 结局三分类映射到 outcome；报告加属性                                                                                                                              |
| `AgentDelegation.renderOutput` / `escapeMarkup`        | `delegation.ts:131-146`                                                                        | 报告的 `<agent …>` 标签加 `run` / `ended`                                                                                                                         |
| `renderTermination`                                    | `lifecycle.ts:477-490`                                                                         | 停止通知加 run 行                                                                                                                                                 |
| `AgentInbox.render` / `escapeField`                    | `inbox.ts:37-70`                                                                               | 模型可见文本不变；进度视图与 agent_status 的名字、标题经同一转义                                                                                                  |
| `AgentTree.resolveTarget(scope: "neighbor")`           | `tree.ts:147-175`                                                                              | `agent_status` 的目标解析，与 `agent_send` 同一套                                                                                                                 |
| `Session.children(parentID)`                           | `session.ts:688-696`（`where parent_id = ?` 一次 SQL；索引 `session_parent_idx`，`sql.ts:64`） | 进度视图的数据采集；`AgentTree.children`（`tree.ts:85-88`）就是它加 depth 计算，这里直接用 Session 的                                                             |
| `AgentStatusProjection.of` / `SessionStatus`           | `status.ts:14-33`                                                                              | 在跑计数、`agent_status` 的 running / idle；加"最近置位时间"得最后一步时间（H12）                                                                                 |
| `Permission.disabled` 的别名表                         | `permission/index.ts:240-250`（edit/write→edit、MCP 资源→read）                                | I9 工具表的一半：加 `agent_status → agent_list`；三个调用点同时生效（`llm/request.ts:251-257`、`session/system.ts:108,124`、`cli/cmd/debug/agent.handler.ts:89`） |
| `visibleAgentTools` / `AGENT_TOOL_IDS`                 | `tool/agent.ts:19,402-404`、`registry.ts:326-345`（深度过滤）                                  | `agent_status` 与 `agent_list` 并列                                                                                                                               |
| `applyAgentRoster` 的权限门                            | `reminders.ts:94-97`                                                                           | 进度视图用同一条 `agent_list` 权限规则；花名册本身在 commit 3 删除（`prompt.ts:1335-1339`、`reminders.ts:56-153`）                                                |
| `StepTail.render` / `message` / `MARKER`               | `step-tail.ts`                                                                                 | 进度视图是第一个 section，重复计数在后                                                                                                                            |
| 按键分配信号量                                         | `session/summary.ts:185-205`                                                                   | `Session.patch` 按会话加锁的写法                                                                                                                                  |
| `Session.patch` / `setMetadata`                        | `session.ts:826-855`                                                                           | 加锁点；元数据整体替换，写前重读                                                                                                                                  |
| `Runner.cancel`                                        | `runner.ts:200-231`                                                                            | 返回取消前的状态标签，供停止通知三分支                                                                                                                            |
| 末尾段的缓存与标记处理                                 | `provider/transform.ts:358-362,487-510`                                                        | 已落地，进度视图不需要再改                                                                                                                                        |
| `deliverAsync` 立即 fork                               | `prompt.ts:181-209`（`forkIn(scope, { startImmediately: true })`）                             | `agent_send` 的快照必须在 deliver 之前取                                                                                                                          |

## 3. 错误处理策略

- **钩子抛错**（reject → defect）：`catchAllCause` 收住，记日志，按放行处理。Claude Code 对此的说明是"钩子不运行时 Claude 无法修复它"，一个跑不起来的钩子不该把 run 卡住。**不设超时**：挂住的钩子与挂住的工具执行同类，由插件负责；人可在 TUI 中止，中止走中断路径，不经钩子。
- **钩子阻止但没有理由**（缺省或空白）：记警告，按放行处理。理由是模型下一步的全部输入，空理由等于空转一步。
- **多个插件**：共享同一个 `output` 对象，后写者胜，与现有所有 `(input, output)` 钩子一致；文档写明。
- **`Session.patch` 的锁获取超时**（30 秒）：`die`，消息带会话 id。这是对未来重入或卡死的守卫（H6c），正常情况下锁持有毫秒级，不会触发。
- **run 记录写失败**：记警告，run 照常进行。后果是：开始写失败则本 run 没有记录，结束时 `end` 发现无记录只记警告；结束写失败则记录停在打开状态，下一次新 run 开始时把它关为 `lost` 再开新号（I5）。报告在记录缺失或未关闭时省略 run 属性（I6）。
- **进度视图数据读取失败**：整节省略（在 §5.3.2 的采集步骤 `catchAll` 到 `undefined`），重复计数节照常。
- **`agent_status` 的解析失败**：与 `agent_send` 同一套渲染——零匹配列邻居，多匹配列全部候选并要求用 session_id。目标不在邻居集合内（用 session_id 指向孙辈等）：`<id> is not one of your neighbours; only yourself, your parent, your direct children and your siblings can be looked up.`；`agent_list` 被 deny：`agent_list is denied for you, and agent_status shows the same information.`
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
     创建者就是唤醒者（H11）。按记录号判：首次 run 的打开写入失败时，下一次 run 的记录号是 1，也落在本条
  2. 唤醒本次 run 的用户消息（run 开始时 MessageV2.latest(msgs).user）的首个 text part 的
     metadata.kind ∈ { "agent_message", "agent_notification" } ⇒ { kind: "agent", 取其 sender 三字段 }
     —— agent_send 的消息、停止通知、子 agent 的结束报告都落在这里（决策 §6 第 2 点）
  3. 该 part 的 metadata.kind = "user_message" ⇒ { kind: "user" }。**只覆盖 TUI 的 agent-message 路由**
     （`handlers/session.ts:337-347`，TUI `routes/session/index.tsx:425` 用它）；人经普通 prompt 端点
     发进子会话的消息没有标记，落入规则 4
  4. 其余 ⇒ { kind: "system" }（压缩后的自动继续、普通 prompt 端点等）
  注：规则 2 的 sender 来自 part metadata，普通 prompt 端点可写任意 metadata，所以经 SessionID 解码，
     解不出 ⇒ 落规则 4（代码审核 2026-11-01 第 4 条）。续跑窗口里 re-arm 的 run 读最新消息时，它的
     text part 可能还没落库（消息行先写、part 后写），此时规则 2/3 不命中、记为 system；只影响标注，接受（第 5 条）。

渲染规则（进度视图、agent_status、agent_list 共用）：
  - 从某会话 S 的视角：kind = agent 且 session = S ⇒ `your message`；
    kind = agent 且 session ≠ S ⇒ 发送方的 name，缺省时用 session id（两者都经 escapeField）；
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
  - agent: string — 本轮用户消息的 agent 定义名（`lastUser.agent`，通常即会话当前绑定的）
  - message: { info: AssistantMessage, parts: Part[] } — 模型的最终回答（SDK v2 已导出 AssistantMessage，
    `sdk/js/src/v2/gen/types.gen.ts:336`）；对应 Claude Code 的 last_assistant_message
  - continuations: NonNegativeInt — 连续被阻止的次数；> 0 即 Claude Code 的 stop_hook_active。
    清零规则（§6 第 17 点）：循环顶部最新的用户消息不是钩子写的继续消息（parts 里没有
    metadata.kind = "stop_hook" 的 text part）即清零——覆盖 re-arm 消费的新输入，也覆盖 run 中途插入、
    在同一次 runLoop 内被读到的消息（steer）；模型调用工具也清零

output（默认 { decision: "allow" }）：
  - decision: "allow" | "block"
  - reason?: string — block 时必填；作为模型下一步的全部输入

触发条件：runLoop 的正常退出分支——最后一条助手消息有终止 finish、不含工具调用、属于最新一轮
  （prompt.ts:1259-1279）。
  不触发（这些退出不经该分支，或不是模型自己决定的停止）：助手消息带错误（1241-1248）；
  权限或提问被拒且未配置继续（processor.ts:322-323 → prompt.ts:1511 `result === "stop"`）；
  输出被截断（prompt.ts:1478-1480 `finish === "length"`）；结构化输出在步骤内结束（1483-1488）；
  人中断；agent_stop。这些退出仍走 run 记录关闭与报告（I7）。
  到达配置步数上限的那一步也不询问钩子，直接结束并记日志：上限是用户配置的硬边界（§6 第 11 点）。
  `isLastStep` 是步骤内的局部量（prompt.ts:1329），退出分支在下一轮顶部，故用 run 级标志
  `lastStepReached` 带过去。默认没有上限（`agent.steps ?? Infinity`，prompt.ts:1328）。
  主会话与子 agent 走同一个分支、同一个输入格式、同一套上限。

阻止的效果：落库一条用户消息，一个 text part：text = reason、synthetic: true、
  metadata { kind: "stop_hook", reason }；continuations + 1；循环继续，仍在同一次 run 内。
  继续消息是真实历史，进入压缩输入（与压缩后的自动继续消息同类）；TUI 过滤合成文本，所以人看不到
  理由（#90 跟进）。

上限：连续阻止达到 cfg.stop_hook_block_cap（默认 8）后本次不再询问钩子，直接退出并记日志；
  任一步包含工具调用、或出现钩子之外的新用户消息即清零。0 表示钩子根本不被调用。
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
    ses_e8322dba1ffeym7PA3fbSUOgkq  cw-b572  run 2 since 19:40:56 (your message), last step 19:52:30; run 1 ended 19:38:10 (completed)
    ses_e82d509c7ffegJiVTIGVydNkNW  cw-b584  run 1 since 19:50:08 (your message), last step 19:51:40
    … and 6 more running
  Finished in the last 10 minutes, now idle:
    ses_e82e64cadffe1q2diMobtJb5ag  cw-b582  run 5 ended 19:49:18 (stopped)
    ses_e8333f0e1ffeIYpJBQz5jqZosm  cw-b569  run 3 cut off since 18:20:06 (not yet recorded as lost)
    … and 2 more finished

  Your last step repeated the tool calls of the step before it: 2 times in a row; the results were identical too: 2 times in a row.

四个部分：
  1. 时钟与自身位置：当前时间带日期与时区；run 号与步号是本会话自己的。主会话没有 run 号，只写
     `You are at step 12.`
  2. 子 agent 总览与在跑列表：直接子 agent 的总数、在跑数、空闲数。在跑的逐个列出，每行 session_id、名字
     （无名字时省略）、run 号、开始时间、唤醒来源、最后一步时间（状态投影最近一次置 busy 的时间，H12）；
     若其上一个 run 在窗口内结束，分号后带上"run N ended <时间> (<结局>)"——这一句专门对付 #75 的竞态
  3. 窗口内结束、现在空闲的列表：每行 session_id、名字、run 号、结束时间、结局（四种之一）。
     空闲且记录仍打开的（崩溃遗留，尚未被新 run 关为 lost）也列在这里，写
     `run N cut off since <开始时间> (not yet recorded as lost)`，不受窗口限制——它没有结束时间，不列就永远看不见
  4. 重复计数：第一组已实现的那句

窗口：取"最近 10 分钟"与"上一步开始以来"两者中更长者。保底项保证一步里跑了 30 分钟的编译时，期间
  结束的子 agent 至少被下一步看到一次。上一步开始时间由 runLoop 记录（上一次组装视图时的 Date.now()；压缩等不出视图的迭代不算）；
  本 run 第一步没有上一步，用 run 开始时间。

排序与上限：
  - 在跑：按 `started_at ?? time_created` 升序（跑得久的最容易被忘、最可能卡住），最多 10 行，超出丢最新派出的，
    写 `… and N more running`
  - 已结束：按 `ended_at ?? started_at` 降序（cut off 行用开始时间），最多 10 行，超出丢最早的，写 `… and N more finished`
  - 并列按 session_id，保证两步之间顺序稳定
  - 省略行不计入 10 行；整段至多 30 行（时钟 1 + 空行 1 + 总览 1 + 标题 2 + 列表 20 + 省略 2 + 空行 1 + 重复计数 1 + 余量）

出现条件：
  - 第 2、3 部分只在有直接子 agent、且 agent_list 权限不是 deny 时出现
  - 第 4 部分只在计数大于 0 时出现
  - 四部分都没有时整段不附带；第 1 部分随任一部分出现，不单独出现

类型不变量：
  - 只读 run 记录、会话行（metadata、time_created）与状态投影，不读历史、不读消息（I8）
  - 数据采集每步一次 SQL（`Session.children(parentID)`），状态与最后一步时间来自内存投影
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

停止通知（renderTermination）新增一行，三种情况，依据 `cancel` 返回的取消前状态与记录：
  - 取消前状态为 Running / ShellThenRun，且记录已关闭为 stopped：`run: 5, stopped at 2026-10-20T03:41:18+08:00`
  - 取消前状态为 Running / ShellThenRun，但记录未关闭或结局不是 stopped（被取消 fiber 的 onExit 异步完成，或
    恰在自然结束的窗口里）：`run: 5, stop requested at <now>`，不等待
  - 取消前状态为 Idle（run-state.ts:81-90 对无 runner 的目标 cancel 是空操作，或 runner 仍在表里但已 Idle）：
    `run: 5 had already ended at <时间> (<结局>); nothing was running`
  被 agent_stop 停下的 run 仍不单独报告（架构 §4.4），但它的编号经这一行与 agent_status 可见。无记录时不加 run 行

run 号允许不连续（决策 §6 第 3 点）：被取消的 run 由停止通知承载；自己仍有后代在跑时推迟的报告，
  报告的是实际关闭的那个 run，不回溯补发；lost 的 run 没有任何报告。工具描述里不解释这些。

agent_send 的返回（在 deliver 之前取目标的状态投影与 agentRun 作为快照；deliverAsync 立即 fork，之后读会
  读到混合状态）：
  目标空闲，记录已关闭：
    `ses_xxx (cw-b333) was idle; this message starts run 6 (sent 2026-10-20T03:41:27+08:00).`
    `Its run 5 ended at 2026-10-20T03:41:18+08:00 (completed); that report reaches you as a separate message.`
    结局为 failed 同上；stopped 时第二句尾改为 `; no completion report exists for a stopped run.`，
    lost 时改为 `; it was cut off and has no report.`
  目标空闲，无记录：第二句省略；首次写 `starts run 1`
  目标空闲，记录未关闭（崩溃遗留，尚未被新 run 关闭）：
    `ses_xxx (cw-b333) was idle; its run 5 was cut off (started <时间>) and will be recorded as lost; this message starts run 6 (sent …).`
  目标在跑，记录未关闭：`ses_xxx (cw-b333) is in run 5 (started 2026-10-20T03:40:02+08:00); it reads this at its next step.`
  目标在跑，记录已关闭或缺失（开始写入尚未完成、已失败，或 §5.2.2 的续跑窗口）：
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
  run，五种写法：
    在跑且记录未关闭 → `6, started <ISO>, woken by <来源>`
    在跑且记录已关闭或缺失 → `record not updated yet`
    空闲且记录已关闭 → `5, ended <ISO> (<结局>)`
    空闲且记录未关闭 → `5, started <ISO>, cut off (will be recorded as lost)`
    从未跑过 → `none yet`
    非子会话 → 省略本行（previous run 行同）
  previous run：有 previous 时 → `4, ended <ISO> (<结局>)`
  last step：在跑时 → 状态投影最近一次置 busy 的 ISO；空闲时省略。非子会话（根会话、自己）在跑时同样有本行
  workdir（路径经 escapeField：它可来自模型给的 cwd）
可查范围、解析与权限：与 agent_list 相同（I9）

工具：agent_list（参数全部可选）
  status?:   "running" | "idle"
  relation?: "self" | "parent" | "child" | "sibling"
  query?:    string — 实例名或标题的子串，大小写不敏感；不匹配 agent_type
  limit?:    PositiveInt — 默认 50
返回：
  表头 session_id / name / agent_type / relation / status / run / last / title / workdir
    run：agentRun.number，无记录留空；last：max(started_at, ended_at) 的 ISO，无记录留空
  排序：自己（relation = self）恒在第一行（§6 第 18 点）；然后在跑的在前；其余按活动时间倒序，
    活动时间 = 记录的 max(started_at, ended_at)，无记录取 time_created（一个键，两种来源混排）；并列按 session_id
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

- runLoop 级状态：`continuations = 0`、`lastStepReached = false`。循环顶部两处清零：`MessageV2.latest(msgs).user` 的 parts 里没有 `metadata.kind = "stop_hook"` 的 text part 时 `continuations = 0`（钩子之外的新输入：steer 与 re-arm 消费的输入）；`hasToolCalls` 求得为真时 `continuations = 0`。每步在 `isLastStep` 为真时置 `lastStepReached = true`。
- 把关插在 `yield* Effect.logInfo("exiting loop", …)`（1278）之前：
  1. `lastStepReached` → 记日志 `stop hook skipped at step limit` → 退出。
  2. `cap = cfg.stop_hook_block_cap ?? 8`；`continuations >= cap` → 记日志 `stop hook cap reached` → 退出。`cap = 0` 时钩子因此根本不被调用。
  3. `decision = plugin.trigger("experimental.session.stop", input, { decision: "allow" })`，`input` 按 4.4 组装，`message` 取 `lastAssistantMsg`。用 `Effect.catchAllCause` 收住 defect → 记日志 → 放行。
  4. `decision !== "block"` → 退出。`reason` 缺省或空白 → 记警告 → 退出。
  5. 阻止：照 `compaction.ts:548-581` 落库一条用户消息（`agent` / `model` 取 `lastUser` 的，`system` / `tools` 也取：`llm/request.ts` 每步从当前用户消息读逐消息 system 与工具开关，继续消息不带它们会在同一 run 里改变后续步的 system 与工具集——代码审核 2026-11-01 第 2 条），一个 text part：`text = reason`、`synthetic: true`、`metadata: { kind: "stop_hook", reason }`；`continuations += 1`；`continue`。
- **分支覆盖**：步数上限 / 到顶 / 钩子抛错 / 放行 / 阻止无理由 / 阻止有理由，六支各一测。
- **正确性论证**：
  - 前置：进入该分支即模型给出了最终回答且没有待执行的工具调用；出错退出分支（1241-1248）与步内 `break` 的各路径（1478-1511）都不经此处（4.4 的"不触发"清单）。
  - 论证：阻止时落库的用户消息使下一轮顶部 `lastAssistantBelongsToLatestTurn` 为假（H8），退出条件不成立，循环继续；这一切都在同一次 `runLoop` 调用内，故 `loop()` 的 `onExit`（run 记录关闭与 `reportRunEnd`）与 runner 的 `onIdle` 都尚未发生——这就是 I7。
  - **终止性（如实陈述）**：钩子只限制"连续"阻止：每一段不含工具调用、不含新输入的退出尝试至多询问钩子 `cap` 次、阻止 `cap` 次；模型一调用工具计数清零，钩子之外的新用户消息（steer，或 re-arm 消费的输入）也清零，所以"阻止、调工具、再阻止"或"到顶、新消息、再阻止"的往复不受上限约束，与 Claude Code 相同（它的 stop_hook_active 以一次停止尝试为单位）。steer 必须清零的原因：它在同一次 runLoop 内被读到——下一轮顶部 `lastAssistantBelongsToLatestTurn` 为假，直接进入下一步——不是新一次调用；若只按调用计，模型回答完 steer 再停时会沿用上一段的计数。默认没有步数上限（`agent.steps ?? Infinity`），`MAX_STEPS_PROMPT` 只是在最后一步追加提示文本、不撤工具。整体终止性不劣于现状：现状就是模型自己决定何时停。
  - 与末尾段的关系：继续消息不是工具调用，重复计数的"上一步"签名不变；它作为新的 `lastUser` 不影响任何已发送前缀。
  - 后置：放行 ⇒ 既有退出路径逐字不变；阻止 ⇒ 历史多一条合成用户消息、run 号不变、父未收到报告。
  - 副作用论证：至多写入一条用户消息与一个 part。

#### 5.1.3 配置键 `stop_hook_block_cap`（`core/src/v1/config/config.ts:84` 旁）

- `Schema.optional(NonNegativeInt)`，描述写明默认 8、0 表示不调用钩子、调用工具或新用户消息即清零。
- **正确性论证**：trivial。

#### 5.1.4 测试

- 脚本化 LLM：最终回答 → 假插件阻止两次再放行 → 请求数为 3，中间两次请求的最后一条用户消息文本等于理由，父（若为子 agent）只收到一份报告，报告在放行之后。
- 上限：`stop_hook_block_cap: 2` 时第三次不再询问钩子，到顶后新消息开始的下一次 run 再次询问、再次到顶；一步含工具调用后计数清零（再阻止两次仍生效）；run 中途插入的消息被同一次 runLoop 读到后，下一次停止从 0 起；`0` 时钩子调用次数为 0。
- 钩子抛错、阻止无理由 → 放行且 run 正常结束。
- 出错退出、权限被拒退出、`length` 退出、步数上限均不触发钩子（钩子被调用次数为 0），且父仍收到报告。
- 多插件：后一个把 block 改回 allow 时放行（文档化行为的回归）。
- T8（随机，每个种子一个实例以取随机 cap）：随机 cap（1–8）与随机步序列——工具步、最终回答（询问钩子）、带中途插入新消息的最终回答（steer，不询问，同一 run 内继续）——钩子按脚本连续阻止，阻止长度可超过 cap；参照实现按定义推进：工具步与 steer 清零，阻止加一，达到 cap 时不询问即退出。断言：每次询问的 `continuations` 等于参照值；每个请求的最后一条用户消息等于当时最新的 reason 或插入消息；落库的 stop_hook part 序列等于 reason 序列；每次询问之前子会话没有 idle 事件；父恰收到一份报告，报告的创建时间不早于最后一次询问；run 结束后子会话有 idle 事件。re-arm 由上面的定值用例覆盖（新一次 run 从 0 起）。

### 5.2 commit 2：patch 加锁、run 记录与消息标记

#### 5.2.0 `Session.patch` 按会话串行化（`session.ts:826-839`）

- 在 Session 层维护 `Map<SessionID, { gate: Semaphore(1), waiting }>`，`patch` 整体包在 `gate.withPermits(1)` 里：读行、合并、`publish(Updated)`。照 `summary.ts:185-205` 的写法；条目在无等待者时清理。
- **守卫**：`gate.take(1)` 经 `Effect.timeoutOrElse({ duration, orElse: die("Session.patch lock held too long or re-entered: <sessionID>") })`，再以 `acquireUseRelease` 包住读、合并、发布与 `release(1)`；只对获取计时，持有不计时。时长默认 30 秒，环境变量 `OPENCODE_SESSION_PATCH_LOCK_MS` 可改（测试缩短用，运行时不需要设）。正常锁持有毫秒级（一次行读 + 一次事务写 + 同步监听者，见 H6c），不会触发；未来的重入或卡死变成带会话 id 的 defect。
- **调用关系**：callers: `touch` / `setTitle` / `setMetadata` / `setAgentModel` / `setPermission` / `setRevert` 等既有方法（全部经 `patch`），以及 `updateMetadata`（同一把锁内读-判-写，§5.2.2）；callees: `get`、`events.publish`。
- **正确性论证**：
  - 前置：H6b——`publish` 返回时投影已写完；H6c——现状没有同步监听者回头 patch 同一会话。
  - 论证：同一会话的 patch 串行 ⇒ 每次 `get` 读到上一次 patch 的投影结果 ⇒ 合并基于最新行 ⇒ 没有旧快照覆盖（I11）。不同会话的 patch 互不阻塞。锁只覆盖 patch，正常执行路径不拿锁。
  - 后置：对任意并发 patch 序列，最终行等于某个串行执行的结果。
  - 副作用论证：无新副作用；超时守卫只在异常时 die。
- 测试：T9（随机）——对同一会话并发执行随机的 `setTitle` / `setMetadata` / `touch` / `setAgentModel` 序列；`session.updated` 在锁内按序发布，所以事件序列就是锁选定的串行顺序，断言相邻两行之间至多一个被写字段变化（丢失的更新表现为某字段回退到旧值）且最终行等于最后一个事件的行——这等价于"每个字段等于最后一次写它的值"；重入守卫——注册一个在 `Updated` 事件里 patch 同一会话的 `listen` 监听者，断言 patch 在超时（测试里缩短）后以带会话 id 的 defect 结束而不是永久挂起；锁时长——单次 patch 的锁持有 < 50 ms；`updateMetadata`——并发 N 次自增一个元数据计数器，结果恰为 N（丢失更新会少），`update` 返回 undefined 时不发 `Updated` 事件且写前写后是同一对象。

#### 5.2.1 `agent-management/run.ts`（新，纯函数）

- `begin(previous: AgentRun | undefined, now, wokenBy, fresh: boolean) -> AgentRun | undefined`：
  - `!fresh`（re-arm）且 `previous` 存在且无 `ended_at` → `undefined`（同一 run 继续，不写）。
  - `!fresh` 且 `previous` 已关闭 → 这是 §5.2.2 的续跑窗口：`onExit` 已判结束、报告已发，续跑是新一次 run → 按下面开新号。
  - `previous` 存在且无 `ended_at`（仅当 `fresh`：遗留打开）→ 先把它关为 `{ number, ended_at: now, outcome: "lost" }` 放入 `previous` 字段；否则 `previous` 字段 = 上一条的 `{ number, ended_at, outcome }`（若上一条存在）。
  - 返回 `{ number: (previous?.number ?? 0) + 1, started_at: now, woken_by, previous? }`。
- `end(current: AgentRun | undefined, now, outcome) -> AgentRun | undefined`：`current` 缺失或已有 `ended_at` → `undefined`（调用方记警告）；否则返回补上 `ended_at` / `outcome` 的副本。
- `outcomeOf(kind) -> RunOutcome`：`classifyExit` 三分类的映射表（completed→completed、failed→failed、cancelled→stopped），入参是分类结果的 `kind`，分类本身在 `onExit` 里只做一次；`lost` 只由 `begin` 产生。
- `wakeSource(message: WithParts | undefined, number, parent) -> WakeSource`：按 4.2 规则 1–4。
- `formatInstant(ms)`（带本地时区偏移的 ISO 8601）、`formatClock(ms)`（HH:MM:SS）、`describeSource(source, viewer)`（4.2 渲染规则）。
- **正确性论证**：
  - `begin` 五种输入（re-arm 打开 / re-arm 已关闭 / 无记录 / 已关闭 / 遗留打开）各一支；I5 由"`fresh` 或续跑遇已关闭记录时加一"给出；遗留打开的关闭保证两个 run 不共号。
  - `end` 三种输入（缺失 / 已关闭 / 打开）各一支；后置 `ended_at ≥ started_at` 由 `now ≥ started_at` 给出。
  - `wakeSource`：规则 1 优先于 2–4，因为首次 run 的唤醒消息是创建时的任务提示，没有标记；规则 2–3 读 `metadata.kind`，不读文本；规则 4 兜底使函数全域有定义。
  - `describeSource`：四分支穷尽 `kind × (session = viewer)`。
  - 全部无副作用。

#### 5.2.2 `SessionPrompt.loop` 的 work 包装（`prompt.ts:1568-1587`）

- 只对 `session.parentID` 存在的会话包装（`agentNotify` 为 false 的命令子任务也包）：

  ```ts
  let started = false // work 闭包：首次执行是新 run，之后都是 re-arm（H9）
  let own: number | undefined // 本次执行持有的记录号；打开写失败时为 undefined
  const work = Effect.gen(function* () {
    const fresh = !started
    started = true
    yield* status.set(id, { type: "busy" }) // 先置 busy，再开记录（H9b）
    own = yield* recordRunStart(id, parentID, fresh)
    return yield* runLoop(id)
  }).pipe(
    Effect.onExit((exit) =>
      Effect.gen(function* () {
        const unconsumed = Exit.isSuccess(exit) && (yield* hasUnconsumedTurn(id)) // 只读一次（H10）
        const outcome = unconsumed ? undefined : classifyExit(id, exit, limits) // 分类也只做一次
        const closed = outcome ? yield* recordRunEnd(id, outcomeOf(outcome.kind), own) : undefined
        if (notify) yield* reportRunEnd(session, parentID, outcome, closed)
      }),
    ),
  )
  ```

  **必须是一个 `onExit` 内顺序调用**，不能挂两个 `onExit`（后挂的先跑，报告会读到未关闭的记录）。

- 原子性：`recordRunStart` / `recordRunEnd` 的读、判、写经 `Session.updateMetadata({ sessionID, update })` 在 patch 锁内完成——`update` 是同步纯函数，拿到现有元数据，返回要写的元数据或 undefined 表示不写；调用返回写前与写后的元数据，没写时两者是同一个对象。这是代码审核（2026-11-01，audit-report §3.2 第 1 条）改的：`Runner.cancel` 先把 runner 置 Idle 再等旧 fiber 退出，期间新 run 可以开始，于是旧 run 的收尾与新 run 的开启并发；锁外的"读—判—写"让后写者抹掉先写者：旧 run 通过归属检查后，把已被新 run 关为 lost 并开出 N+1 的记录改回 `N stopped`，N+1 的记录消失，再下一次 run 又开 N+1。其他元数据写方：HTTP `session.update`（已知破坏路径）；`agentName` 等键创建后不再写。
- `recordRunStart(id, parentID, fresh)`：重读会话元数据；唤醒消息经 `sessions.messages({ limit: 1 })` 取最新一行（不加载历史）；`wokenBy = wakeSource({ number: (previous?.number ?? 0) + 1, parent, message })`；`next = begin(previous, now, wokenBy, fresh)`——`previous`、`wokenBy`、`next` 都在 `updateMetadata` 的 `update` 里算，`next` 存在才返回 `{ ...metadata, agentRun: next }`；父会话的名字与最新消息在锁外先读好，它们不是争用的数据。返回本次 run 持有的记录号，即写后元数据里的记录号：新开的号，re-arm 时仍打开的那个号。任何失败记警告，run 照常，返回 undefined——它什么都不持有。
- `recordRunEnd(id, outcome, own)`：只在 `unconsumed` 为假时调用（为真则 runner 将 re-arm，同一 run 继续，不关闭）；在 `updateMetadata` 的 `update` 里：记录号 ≠ `own`（含 `own` 为 undefined）或记录已关闭 → 不写：取消中的 run 收尾时，下一 run 可能已把它的记录关为 lost 并开了新号；打开写失败的 run 则可能面对一条它没开的遗留记录——两者都不是它的；否则写 `end(current, now, outcome)`。没写（写前写后相同）→ 记一条警告（带 `own` 与现有记录号）、返回 undefined；写了 → 返回写后的记录。
- `reportRunEnd` 改为接收 `onExit` 已分类的 `outcome`（`undefined` 表示有未消费的消息、不是真的结束）与刚关闭的记录 `closed`（没关成为 undefined，报告就不带 run 属性），不再自己读 `hasUnconsumedTurn`，也不再自己分类。
- **正确性论证**：
  - 前置：runner 对一次 run 恰执行一次 work，re-arm 重跑同一 work（H9）；runner 自己在临界区内再读一次 `hasUnconsumedTurn` 决定是否 re-arm（H10）。
  - **归属**（外部审核 2026-11-01 的两条 P2）：`cancel` 先把 runner 置 Idle 再中断 fiber，被中断 fiber 的 `onExit` 可能晚于下一 run 的 `recordRunStart`（它把旧记录关为 lost、开出 N+1）；不看归属，旧 run 的收尾会把 N+1 关成 stopped。打开写失败的 run 什么都没开，遗留的打开记录不是它的；不看归属，一次完成会冒用遗留号，报告也带上这个号。所以关闭以"记录号 = 持有号"为前提，持有号在 work 闭包里随每次（重）启动刷新。
  - 论证：新 run 与 re-arm 由闭包标志区分，与记录状态无关，崩溃或写失败不能让新 run 被误判为 re-arm（I5）。`onExit` 内只读一次，记录关闭与报告看到同一个答案：要么都认为 run 继续（都不动），要么都认为 run 结束（先关闭，后报告读到已关闭的记录，I6）。
  - **与 runner 读数不同的窗口**：消息恰落在 `onExit` 的读与 runner 的读之间时，这里判"结束"——记录关为 completed、报告 run N 发出——而 runner 判"续跑"，重跑同一 work：`fresh = false`，`begin` 看到记录已关闭，按 §5.2.1 开 run N+1，`woken_by` 取那条消息。续跑的结果以 run N+1 报告。父看到的序列是"run N 完成报告 → run N+1 完成报告"，与它随后发 `agent_send` 时读到的"starts run N+1"一致，不会出现两份同号报告，也不会有静默的续跑。这个窗口与 #32 修复后的现状相同，不扩大。
  - busy 先于记录：H9b 消除"记录已打开、状态还是 idle"的启动窗口，agent_send 与 agent_status 不会把刚启动的 run 说成 cut off。
  - 后置：每次 run 至多一次开始写入、至多一次结束写入；结束写入只落在本 run 持有号的记录上。
  - 副作用论证：至多两次 `setMetadata`（经 5.2.0 的锁）加一次内存状态置位；记账失败不影响 run。

#### 5.2.3 `AgentInbox.deliver` 的标记（`inbox.ts:114-122`，#73 服务端）

- Step 的 parts：`kind = "agent"` → `[{ type: "text", text: render(message), metadata: { kind: "agent_message", sender, sender_name?, sender_agent? } }]`；`kind = "user"` → 头行 part 加 `metadata: { kind: "user_message" }`，用户 parts 原样。
- `reportRunEnd` 写入父的 part：metadata 增 `sender: child.id`、`sender_name`、`sender_agent`。
- **正确性论证**：`render()` 与头行文本不变（I10）；metadata 经 `prompt()` 的 text part 输入透传（`reportRunEnd` 已这样传 `{kind, summary}`）。
- 测试：三条路径的 metadata 形状；模型收到的文本与改前逐字相同（断言请求体）；`[Message from user]` 路径不带 `agent_message`。

#### 5.2.4 `SessionStatus` 带时间（`status.ts`）

- 投影条目类型 `Projected = Info & { at?: number }`（最近一次 `set` 的 epoch ms），`get` / `list` 返回它；`set` 时存 `{ ...status, at: Date.now() }`，发布的事件仍只带 `status`。实施时的调整：`Info` 是 schema 包的线上契约（`session.status` 事件载荷），给它加字段会改公开事件与 SDK，而这个时间只在内存里有意义，所以不动 `Info`，只扩投影条目；空闲缺省没有 `at`。
- **正确性论证**：trivial（内存字段）；每步顶部的 `set busy` 使在跑会话的 `at` 就是最后一步开始时间（H12）。

#### 5.2.5 测试

- run 记录：首次 run 为 1 且 `woken_by` 为父；agent_send 唤醒的 run 加一且来源为发送方，`previous` 为上一个 run 的结束；结束报告唤醒祖辈时来源为发报告的子；人经 agent-message 路由唤醒为 user，经普通 prompt 端点为 system；re-arm（记录打开）不加号；`agent_stop` 记 `stopped`；钩子阻止不加号、不写 `ended_at`；遗留打开记录在新 run 开始时关为 `lost` 且新 run 号加一；结束写失败后的下一次 run 仍加一；续跑窗口（消息落在 `onExit` 读与 runner 读之间，用 Deferred 控制）产生 run N 报告与 run N+1 报告各一份；新 run 启动的头几毫秒内状态已是 busy；取消中的 run 收尾时下一 run 的记录已在（测试在取消前写入），收尾不动它、不发报告；打开写失败的 run 遇到遗留打开记录：记录原样、报告不带 run 属性，下一 run 把遗留关为 lost 并取下一个号。
- T3（随机，run 层）：两个子并发、各自顺序跑 2–4 次 run，8 个种子。每次 run 随机取唤醒来源（父 / agent 消息 / TUI 路由 / 普通 prompt）、结局（完成 / length 失败 / 挂住时被取消）与形态之一：普通；中途插入消息（同一 run 读到）；最后一轮结束时插入消息（content-filter 收尾，runner re-arm，同一 run 继续）；续跑窗口（在关闭记录的 `session.updated` 监听里插消息，恰落在 `onExit` 与 runner 两次读之间，run N 关闭、run N+1 开启）；结束写失败（测试用一层包装的 Session.Service 让关闭记录的 `setMetadata` 死一次，走真实的 catch 分支）；开始写失败（同一包装让打开记录的写入死一次：记录原样、无报告号、不进号）；取消时下一 run 已开启（取消前写入下一 run 的记录，收尾不得改它）；另随机在 run 前写入崩溃遗留的打开记录。经真实 `loop` 执行，断言：每个子的 run 号严格 +1，re-arm 不加号，续跑窗口加一号且两份报告；`woken_by` 符合四条规则（记录号为 1 即记父，包括首次 run 开始写失败之后的那次）；`ended_at ≥ started_at`；写失败与遗留的记录在下一次开始时被关为 lost；报告份数 = 完成与失败的 run 数（被取消的不报）；每条记录打开时会话已是 busy（INV-13）。报告对号（INV-6）与 agent_send 预告（INV-6b）要等 commit 4 给报告加 run 属性，届时扩 T3。

### 5.3 commit 3：末尾段进度视图

#### 5.3.1 `StepTail.renderSubagents(input) -> string | undefined`（纯函数）

- 入参：`{ now, self: { run?: number, step: number }, children: Child[], windowStart: number, viewer: SessionID }`，`Child = { id, name?, created: number, running: boolean, lastStep?: number, run?: AgentRun }`。
- 步骤：
  1. `running = children.filter(c => c.running)`，按 `run?.started_at ?? created` 升序、并列按 id；取前 10；超出记 `omittedRunning`。
  2. `finished = children.filter(c => !c.running && (c.run?.ended_at !== undefined ? c.run.ended_at >= windowStart : c.run !== undefined))`——已关闭的按窗口筛，未关闭的（cut off）不筛；按 `ended_at ?? started_at` 降序、并列按 id；取前 10；超出记 `omittedFinished`。
  3. 渲染 4.5 的格式：时钟与自身位置；总览行；在跑列表（每行 id、名字、run 号、since、来源、last step；若 `run.previous.ended_at >= windowStart` 附分号句）；已结束列表（已关闭行 / cut off 行）；省略行。
  4. 两个列表都为空时只返回总览行（时钟行由调用方按"随任一节出现"的规则加在整段最前）。已结束列表的标题：窗口恰为 10 分钟时写 `Finished in the last 10 minutes, now idle:`，更长时写 `Finished since HH:MM:SS, now idle:`。在跑而记录缺失或已关闭（开始写入未完成、已失败，或续跑窗口）的行写 `running (run record not updated yet)`，与 agent_send 的措辞一致。
- **正确性论证**：纯函数；行数上界 30；排序有确定的第二键（id）；`finished` 的筛选条件与 4.5 定义逐字对应；cut off 行不受窗口限制故崩溃遗留可见直到被新 run 关闭。
- 测试（`step-tail.test.ts`）：无子返回空；有子无变化只有总览；在跑按开始时间升序、无记录的按创建时间混排、记录已关闭的写 not updated yet、超 10 截断保留最早的；已结束按结束时间降序、超 10 截断保留最新的；cut off 行出现且不受窗口限制；上一个 run 在窗口内时附带分号句、不在窗口内不带；四种结局；来源三种；名字转义后仍是一行；标题两种；主会话第一行无 run 号；窗口取 10 分钟与上一步开始的较早者。

#### 5.3.2 `runLoop` 中的数据采集（`prompt.ts:1434` 组装 tail 处）

- runLoop 级状态 `previousStepStart`：初值为 runLoop 进入时间（本 run 第一步没有上一步，用 run 开始）；在组装视图处用它算窗口，然后记为本次视图的 `now`。只有真正发给模型的步推进它：压缩、子任务、溢出恢复这些不出视图就 `continue` 的迭代不算"上一步"，否则一次长压缩会把窗口下界推到真实上一步之后，期间结束的子就漏掉（代码审核 2026-11-01 第 3 条）。
- 采集（`catchAll` 到 `undefined` → 整节省略）：
  1. 权限门：`Permission.evaluate(AGENT_LIST_TOOL_ID, "*", merged)` 为 deny → 不附带（与 `reminders.ts:94-97` 同一规则）。
  2. **一次 SQL**：`sessions.children(id)`（`session.ts:688-696`，`where parent_id = ?`，一次查询、一次 hydrate）。为空 → 不附带。
  3. 状态投影取一次 `status.list()`（内存，一次拷贝；实施时从逐子 `get` 改为一次 `list`：600 个子时逐次 Effect 调用的开销就占去大半预算），对每行：`running = AgentStatusProjection.project(status) === "running"`（与 `agent_list` 同一映射函数）、`lastStep = at`；`run = metadata.agentRun`；名字 = `metadata.agentName`；`created = time.created`。采集放在 `StepTail.collectSubagents({ sessions, status, parentID })`，服务经参数显式传入（`Pick<Interface, "children">` / `Pick<Interface, "list">`），它能到达存储的路只有 `children` 这一条。
  4. `windowStart = min(now − 10 min, previousStepStart)`。
  5. 自身位置：子会话取自己的 `agentRun.number`（本步开始时已写），主会话无；步号 = `step`。
- `tail = StepTail.render([renderSubagents(...), renderRepeat(repeat)])`。
- 同一 commit 删除 `applyAgentRoster` 的注入与调用（`reminders.ts:56-153`、`prompt.ts:1335-1339`），保留 `AGENT_ROSTER_SENTINEL`；相关测试改为断言不再注入。
- **正确性论证**：
  - 读取量：一次 SQL 加一次内存投影拷贝，N 为直接子数；不读消息、不读部件、不算 depth。600 个直接子实测采集加渲染在负载 12 的机器上仍在 50 ms 内（expectations §8 的断言）。
  - 窗口的保底项保证"任何结束至少被下一步看到一次"：结束时间 ≥ 上一次视图的时刻（上一个真实步的开始）⇒ 在本步窗口内；第一步用 run 开始时间，run 开始前结束的由 10 分钟项覆盖。
  - 权限门与被删除的花名册同一条规则，信息暴露面不变。
  - 副作用：无（只读）。
- 测试（`prompt.test.ts`）：无子不附带；`agent_list` deny 不附带；进度视图与重复计数共存且节序正确（视图在前，重复计数收尾）；相邻三步请求的历史部分逐字相同（扩展 R1），视图与时钟都不进历史；花名册不再写入历史；600 个直接子的采集只调一次 `children`、不超过 50 ms。"30 分钟长步"与"首步用 run 开始"无法在真实时钟下集成验证，由 `StepTail.windowStart` 的单元测试与 `runLoop` 里 `previousStepStart` 的初值、每步更新两行代码承担。
- T7（随机）：随机生成子集合（状态、run 记录、创建时间、最后一步时间）与窗口，断言两个列表恰等于按 4.5 定义计算的集合、顺序满足定义、行数 ≤ 10、省略计数正确；相邻步之间同一输入产出同一文本。

### 5.4 commit 4：报告、停止通知与 `agent_send`

#### 5.4.1 `renderOutput` 与 `reportRunEnd`

- `renderOutput` 入参增 `run?: number`、`ended?: string`（调用方按 `run.ts` 的格式先格式化，delegation 不依赖 run 模块），两者齐全时输出 `run="…" ended="<ISO>"`。
- `reportRunEnd`：接收 `recordRunEnd` 刚写回的记录（同一个 `onExit` 里顺序传递，不再读一次）；记录已关闭才传 `run` / `ended` 并加摘要后缀 ` (run 5, ended 03:41:18)`；记录缺失、未关闭或关闭写失败时一并省略。
- **正确性论证**：I6 由 5.2.2 的顺序给出；TUI 只读 `summary`，后缀是 server 的措辞 owner（子计划 1 §4.1）。
- 测试：有记录 / 无记录 / 未关闭三例。

#### 5.4.2 `Runner.cancel` 返回值与 `renderTermination`

- `Runner.cancel`（`runner.ts:200-231`）改为返回取消前的状态标签 `Runner.StateTag`（`Idle | Running | Shell | ShellThenRun`）；`SessionRunState.cancel` 透传（无 runner 时返回 `Idle`）。`AgentLifecycle.stop` 对 target 记下这个值。
- `renderTermination` 入参增 `{ before: StateTag, run?: AgentRun, now }`，按 4.6 分支：`before ∈ {Running, ShellThenRun}` 且记录已关闭为 `stopped` → `run: N, stopped at <ISO>`；`before ∈ {Running, ShellThenRun}` 否则 → `run: N, stop requested at <now>`；`before ∈ {Idle, Shell}` 且记录已关闭 → `run: N had already ended at <ISO> (<结局>); nothing was running`（Shell 是人在该会话里跑命令，不是模型的 run）；实施时补第四种，`before ∈ {Idle, Shell}` 且记录仍打开（崩溃遗留）→ `run: N was cut off (started <ISO>) and will be recorded as lost; nothing was running`。无记录时不加 run 行。行的位置在 `title:` 之后。
- **正确性论证**：
  - 前置：`stop` 已对目标执行 cancel；`stop` 在发通知前重读目标元数据。
  - 论证：`before` 来自 cancel 本身的状态转换，不从记录推断，所以"本就空闲"不会被写成"已停止"；第一分支要求结局确为 stopped，自然结束的窗口（记录已关为 completed、runner 还在表里）落入第二分支，不会把完成时间说成停止时间；第二分支不等待被取消 fiber 的 `onExit`——通知的强度本就只到"已接受"。三分支由 `before × outcome` 穷尽。
  - 副作用：无（渲染）。
- 测试（`lifecycle.test.ts`）：目标的 work 挂在 Deferred 上使 cancel 看到 Running，记录按各情况预置：已关闭为 stopped → stopped at；打开或关闭为 completed（自然结束窗口）→ stop requested；空闲且已关闭 → had already ended；空闲且打开 → cut off；无记录 → 无 run 行。

#### 5.4.3 `agent_send` 的返回（`tool/agent.ts:288-319`）

- 在 `deliver` **之前**取快照：`status = projection.of(target)`、`run = target.metadata.agentRun`、`isChild = target.parentID !== undefined`、名字；目标不存在时快照为空，投递本身会以 `AgentNotFound` 失败并返回失败文本。
- 按 4.6 六种情况渲染（名字有则写成 `ses_xxx (cw-b333)`，经 `escapeField`）；随后 `agent_status` 提示行；再是既有的 `Accepted for …` 与两句单向说明。
- **正确性论证（决策 §6 第 4 点）**：目标在跑且记录未关闭时，消息进入当前 run 或紧接着的 re-arm run，run 号仍是 N（I5），"is in run N" 成立。目标空闲且记录已关闭时下一次开始的 run 必为 N+1（5.2.1 `begin` 对已关闭记录加一）；即使别的消息抢先唤醒，本消息也只是进入 run N+1。空闲且未关闭（遗留）时下一次开始会先关为 lost 再开 N+1，措辞如实写出。在跑且记录已关闭（续跑窗口或写入未完成）时不预告号。投递失败时工具本身返回失败文本，不输出这段话。快照在 deliver 之前取，避免 fork 已启动目标后读到 N+1 与 busy 的混合状态。
- 测试：六种情况各一例（`tools.test.ts`）；预告的 run 号与下一份报告一致——经注册表里真实的 `agent_send` 投递、父收到的第二份报告带 `run="2"`（`prompt.test.ts` 定值用例）。T3 没有改走工具投递：工具的 `deliverAsync` 会自己 fork 目标的 run，与 T3 用 `prompt.loop` 控制每次 run 的起止冲突，所以 INV-6b 由定值用例承担，T3 承担 INV-6。

### 5.5 commit 5：`agent_status` 与 `agent_list`

#### 5.5.1 `agent_status(params, ctx)`（`tool/agent.ts` 新工具，ID `agent_status`）

1. `Permission.evaluate(AGENT_LIST_TOOL_ID, "*", merged ruleset)` 为 deny → 返回失败文本（I9 执行期的一半）。先于解析：重名的失败文本列出候选 session_id，被拒的调用者不该拿到（外部审核 2026-11-01）。`agent_list` 自身没有执行期检查，只靠工具表隐藏；这里多一道是有意的不对称，安全方向正确，文档写明。
2. `resolveTarget(caller, params.target, "neighbor")`，失败渲染同 `agent_send`。
3. `neighborhood(caller)` 取成员（含 relation 与 `run`）；目标不在邻居集合内（例如用 session_id 指向孙辈）→ 失败文本，范围与 `agent_list` 严格相同；`status.get(target)` 一次取状态与最后一步时间（状态经 `AgentStatusProjection.project`，与 `agent_list` 同一映射；读两次会各看一个瞬间）。
4. 按 4.7 渲染（run 行五种写法；非子会话没有 run 与 previous run 行，在跑时仍有 last step 行）。

- **正确性论证**：解析范围与 `agent_list` 同为邻居；步骤 1 使"禁用 agent_list 的配置不会经 agent_status 泄露同样的信息"成立，且先于步骤 2，连候选 session_id 也不泄露；run 行五种写法由 `status × 记录状态` 穷尽。副作用：无。

#### 5.5.2 可见性

- `AGENT_TOOL_IDS` 加入 `agent_status`；`visibleAgentTools`（`tool/agent.ts:402-404`）在两个分支里都与 `agent_list` 并列。
- 权限隐藏：内置工具按权限 deny 隐藏的机制是 `Permission.disabled`（`permission/index.ts:240-250`）的别名表加 `request.ts:251-257` 的 `resolveTools`，不是注册表的 `visibleTools`（那只管 code-mode 的 MCP 目录）。在别名表加 `agent_status → agent_list`，三个调用点（`llm/request.ts`、`session/system.ts`、`debug/agent.handler.ts`）同时生效。`resolveTools` 还按 `user.tools?.[k]` 逐名开关：`agent_status` 作为独立名字可被单独关掉，但不能单独打开一个被 `agent_list` 规则隐藏的 `agent_status`（别名表先判）。
- 内置受限 agent 的放行列表（`agent/agent.ts:212-215`，调研 §17.7）：别名加入后 `agent_status` 随 `agent_list: allow` 自动放行，不需要再逐条追加；测试断言 explore 这类受限 agent 的工具表里二者同在。
- **正确性论证**：工具表存在性由两维决定——深度（`visibleAgentTools`）与权限（`disabled` 别名）；两维都把 `agent_status` 绑到 `agent_list` 的判定上，故 `agent_status ∈ tools ⇔ agent_list ∈ tools`（I9 工具表的一半）。副作用：无。

#### 5.5.3 `agent_list(params, ctx)`

1. 组装 `AgentInfo` 如今（`neighborhood` + `of`）；`agentRun` 随 `AgentSkeleton.run` 从 `toSkeleton` 读出的同一行带出，不再逐行读会话。
2. 过滤：`relation`、`status`、`query`（实例名或标题子串，大小写不敏感，匹配转义前的原文）。
3. 统计 `total / running / idle`（过滤后）。
4. 排序：自己在前；在跑在前；其余按活动时间（`last ?? time_created`）倒序；并列按 session_id。
5. 截断到 `limit ?? 50`；渲染表与计数行（`workdir` 路径与 name / title 一样经 `escapeField`：它可来自模型给的 cwd）。

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

2026-10-28/29（第一轮设计审查后，逐点确认）：

7. **记录只存当前 run 加上一个 run 的结束**，不存环。曾提议最近转换的环，随第 8 点的改法一起撤销：快照视图只需要这两样。
8. **末尾段改为快照视图**：时钟与自身位置、子 agent 总览、在跑列表（开始早的在前）、10 分钟内结束列表（结束晚的在前），各最多 10 行；窗口取 10 分钟与上一步开始以来的较长者。替代原"最近 5 步的变化列表"。写入历史的花名册随之撤销。
9. **结局四种**：completed、failed、stopped、lost。lost 只由新 run 开始时关闭遗留的打开记录产生，没有报告。崩溃后不向父补发通知。
10. **`Session.patch` 按会话加信号量**（方案 1，否决单独建表的方案 2）。HTTP `session.update` 保持整体替换语义，记为已知破坏路径。前提核查 H6c 已通过。
11. **re-arm 由 work 闭包标志判断**，不由记录判断；到达步数上限那一步不询问钩子。
12. **钩子不设超时**，时长由插件负责。
13. **不加默认步数上限**。三个参照实现在交互使用下都无默认上限（Claude Code 文档："No limit by default"）；ZCode 在 #46 引用的提交里给子 agent 写了 `maxTurns ?? 4`，但仓库内没有任何循环消费它，不作为证据。`steps` 保持按 agent 的选择项。
14. **多插件后写者胜**，与现有钩子一致；**人经普通 prompt 端点发进子会话记 `system`**（规则 3 只覆盖 agent-message 路由）；**`query` 不匹配 `agent_type`**。
15. **钩子阻止后的继续消息在 TUI 不可见**，第一版接受，#90 跟进。

2026-10-29（第二轮审查后，按常规判断处置，未再逐点征求确认）：

16. **续跑遇已关闭记录即新 run**（N1）：`onExit` 的读与 runner 的读不一致时，续跑开 run N+1 并以 N+1 报告，不出现同号两份报告，也不静默。**锁获取 30 秒超时即 die**（N2），作为重入与卡死的守卫；H6c 改为已核对的五个监听者清单。**"最后活动"改为"最后一步"**（N3），来自状态投影的置位时间，不落盘。**`cancel` 返回取消前状态**（N4），第一分支要求结局为 stopped。**work 先置 busy 再开记录**（N5）。**崩溃遗留以 cut off 行出现在已结束列表且不受窗口限制**（N6）。**直接用 `Session.children`**（N7）。**`agent_status` run 行五种**（N8）。**`lastStepReached` 用 runLoop 级标志**（N9）。**视图上界 30 行**（N10）。**`continuations` 按 runLoop 调用计、re-arm 从 0 起**（D-e，与 Claude Code 的 stop_hook_active 以一次停止尝试为单位一致）。**窗口首步用 run 开始时间**（D-a）。**stopped / lost 的第二句不假定停止者是调用者**（D-b）。**在跑列表排序键 `started_at ?? time_created`**（D-c）。

2026-10-30（commit 1 实施中发现，按常规判断处置）：

17. **清零规则改为"钩子之外的新用户消息"**，取代第 16 点 D-e 的"按 runLoop 调用计、re-arm 从 0 起"。原因：run 中途插入的消息（steer）在同一次 runLoop 内被读到——下一轮顶部 `lastAssistantBelongsToLatestTurn` 为假，直接进入下一步——不是新一次调用；按调用计时，模型回答完 steer 再停，计数沿用上一段，违背"新输入就是新的停止尝试"。新规则：循环顶部最新用户消息的 parts 没有 `stop_hook` 标记即清零；re-arm 消费的输入没有标记，自然落入其中。与 Claude Code 的 stop_hook_active 仍一致。T8 随之扩成随机 cap、可超上限的阻止、中途插入消息、询问前无 idle 与报告时序的断言。

2026-10-31（commit 5 实施前，用户确认）：

18. **`agent_list` 自己那一行置顶**，其后才是"在跑在前、其余按活动倒序"。模型容易漏看自己；`relation` 列仍写 `self`，`relation: "self"` 过滤只返回这一行。

与 #75 原文的差异：末尾段内容记 INFO 日志而不是写进助手消息的元数据（修正方案文档 §4.1）；`agent_send` 的措辞按第 4 点改；"最近 5 步的变化"按第 8 点改为快照。

## 7. 完整性自检 checklist

- [x] 推导连续：五个 commit 的插入点均给出前置守卫链与落点行号
- [x] 分支覆盖：钩子六支；`begin` 五种输入、`end` 三种；`wakeSource` 四条规则；`agent_send` 六种目标状态；`agent_status` run 行五种；`renderTermination` 三支；进度视图的无子 / deny / 无变化 / 截断 / cut off
- [x] 退出覆盖：钩子抛错与空理由的放行；记账失败不阻塞；锁超时 die；`agent_status` 的解析失败与权限拒绝；采集失败整节省略
- [x] callee 契约：`Plugin.trigger` 顺序等待且 reject 为 defect（H7）、`hasUnconsumedTurn` 两处读的关系（H10）、`setMetadata` 整体替换且经锁、runner 重跑同一 work（H9）、`startRun` 不置 busy（H9b）、`publish` 同步投影与同步监听者（H6b/H6c）、`Session.children` 一次 SQL、`resolveTarget(neighbor)`、`deliverAsync` 立即 fork 均显式引用
- [x] 循环刻画：钩子的连续阻止有上界 `cap`，整体终止性如实陈述为不劣于现状；其余无新循环
- [x] 显式假设链：H6–H12 列于 §0.2，各函数论证引用到条目
- [x] 不变量：I5–I11 各有维护方与测试落点（§5 对应小节）

## 8. 实施顺序与流程绑定

1. 设计确认（本文档）→ **Step 0**：`docs/audits/agentmgmt-2-run-state/expectations.md`（已随本文档同步修订）
2. commit 1（#81 钩子）→ 实现 + 测试 + §5.2 审核
3. commit 2（patch 加锁 + 状态投影带时间 + run 记录 + 消息标记）→ 同上，含 T3、T9；重入守卫测试先于加锁落地
4. commit 3（进度视图 + 花名册撤销）→ 同上，含 T7
5. commit 4（报告、停止通知、agent_send、`cancel` 返回值）→ 同上
6. commit 5（agent_status、agent_list）→ 同上，含 T4
7. Step 5 双验证（路径 A 以仓库单测承担；路径 B subagent 独立审）→ `audit-report.md`、`decisions.md`；回填修正方案文档 `session-fix-step-tail-repeat-and-agents.md` 第六、七、八部分与本文档的 commit hash
8. PR 到 `dev`（不合并，等用户）

## 9. 设计审查记录（2026-10-28/29）

按 workflow §4.4 做了两轮审查，每轮都是独立审核 agent（给契约文档与代码，不给作者结论）加作者自审。记录在 `docs/audits/agentmgmt-2-run-state/audit-report.md`。

第一轮（基线 `f143e06894`）六条结论：架构论证 ⚠️、细化结构 ✅、完整性六条 ⚠️、函数论证 ⚠️、满足规约 ⚠️、无歧义 ❌。必须改的两处与需决策的项目按 §6 第 7–15 点处理：

| 审查项                                    | 处置                                                        |
| ----------------------------------------- | ----------------------------------------------------------- |
| C1 单记录产不出变化列表                   | 视图改为快照（§6 第 8 点），记录改为当前加上一个（第 7 点） |
| C2 H6 不成立（HTTP 替换、patch 整行覆盖） | `Session.patch` 加锁（第 10 点），H6/H6b/H6c 重写           |
| C3/D1 I9 机制位置错                       | 改为 `Permission.disabled` 别名表（§5.5.2）                 |
| C4 遗留打开记录被当 re-arm                | 闭包标志 + 关为 lost（第 9、11 点）                         |
| C5 两次读 `hasUnconsumedTurn`             | `onExit` 内读一次（§5.2.2）                                 |
| C6/D6 停止通知缺第三分支                  | 三分支（§5.4.2）                                            |
| C7 终止性论据不成立；isLastStep 矛盾      | 如实改写；到上限跳过钩子（第 11 点）                        |
| C8 权限拒绝与 length 退出                 | 列入"不触发"，I7 改为"正常结束效果"                         |
| C9 超时无落点                             | 不设超时（第 12 点）                                        |
| C10–C15、D2–D13、E 各项                   | 已在 §4、§5 与 expectations 中逐条写死                      |

第二轮（基线 `8135b807e0`）：上一轮 ❌ 两项关闭；六条结论 ⚠️ ✅ ⚠️ ✅ ⚠️ ⚠️，新提 N1–N12、D-a–D-c，全部按 §6 第 16 点处置并写入本文档与 expectations；上位文档的残留（N11）同步清理。审核 agent 本轮没有 Bash 权限，监听者穷举（H6c）由作者以 grep 完成并列入 H6c。
