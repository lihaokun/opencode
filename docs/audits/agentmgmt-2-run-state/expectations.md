# Contract Audit Expectations — `agentmgmt-2-run-state`

> Step 0 产出（workflow §6.2）。契约抽取自契约文档，未经现有代码回填。
> 抽取时基线：`step-tail` @ `97b272f37f`。2026-10-29 随两轮设计审查后的子计划修订同步重写。

## 1. 契约源（multi-doc）

| 文档                                                                                              | 用途                                                                                                                                    | 相关节                 |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `docs/design/agent-management/subplans/agentmgmt-2-run-state.md`                                  | **主契约**（数据结构 / 接口 / 流程 / 论证 / 已确认决策 / 审查记录）                                                                     | §0–§9 全部             |
| issue #75 / #81 / #73 / #90                                                                       | 需求源；与 #75 原文的差异记在主契约 §6                                                                                                  | 各 issue 正文          |
| `docs/fixes/session-fix-step-tail-repeat-and-agents.md`                                           | 末尾段机制（已落地）与 #75 的修正方案；本子计划是其 4.4–4.9 的设计落点                                                                  | §4.1–§4.9、第六部分    |
| `docs/design/agent-management/architecture.md`                                                    | 既有架构（I3 单活动执行、Accepted 强度、通知通道、权限门、SubagentRoster 的撤销）                                                       | §3、§4.3–§4.5、§7、§10 |
| `docs/research/agent-management-research.md`                                                      | §12 的收敛被 §18 撤销的理由；§18.4 默认步数上限的三方对照                                                                               | §12、§18               |
| Claude Code hooks 文档 https://code.claude.com/docs/en/hooks（2026-10-23 读取）                   | 钩子语义的外部参照：阻止即继续、理由为下一条指令、8 次上限、调用工具清零                                                                | Stop / SubagentStop    |
| Claude Code CLI 文档 https://code.claude.com/docs/en/cli-reference、sub-agents（2026-10-29 读取） | 默认步数上限对照："No limit by default"；子 agent `maxTurns` 无默认                                                                     | —                      |
| 既有契约（本子计划引用且**不改**）                                                                | `render()` 的转义与文本、`deliverAsync` 的 fork + 路由、`hasUnconsumedTurn` 判据、`classifyExit` 三分类、`publish` 同步投影与同步监听者 | —                      |

## 2. Schema 字段（机械化）

| 字段                                              | 类型                                                                                                                                                                                                                                                   | 契约来源      | 实现位置（计划）                            | 一致性机制                                                                           |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- | ------------------------------------------- | ------------------------------------------------------------------------------------ |
| Session.metadata.agentRun.number                  | `PositiveInt`                                                                                                                                                                                                                                          | 主契约 §4.1   | `agent-management/run.ts`                   | INV-5                                                                                |
| Session.metadata.agentRun.started_at              | `number`（epoch ms）                                                                                                                                                                                                                                   | 主契约 §4.1   | 同上                                        | 与 `Session.time` 同口径                                                             |
| Session.metadata.agentRun.woken_by                | `WakeSource`                                                                                                                                                                                                                                           | 主契约 §4.1   | 同上                                        | §3 枚举                                                                              |
| Session.metadata.agentRun.ended_at                | `number`（可选）                                                                                                                                                                                                                                       | 主契约 §4.1   | 同上                                        | 与 outcome 同在同缺；≥ started_at（构造保证，schema 不校验；`ended()` 只认两者齐全） |
| Session.metadata.agentRun.outcome                 | `RunOutcome`（可选）                                                                                                                                                                                                                                   | 主契约 §4.1   | 同上                                        | §3 枚举                                                                              |
| Session.metadata.agentRun.previous                | `{ number, ended_at, outcome }`（可选）                                                                                                                                                                                                                | 主契约 §4.1   | 同上                                        | previous.number = number − 1                                                         |
| WakeSource.kind / session / name / agent          | `kind` 见 §3；`session: SessionID`（kind = agent 时必填）；`name?`、`agent?: string`                                                                                                                                                                   | 主契约 §4.2   | 同上                                        | kind = agent ⇒ session 必填（构造保证，schema 不校验；读者容错）                     |
| SessionStatus.Projected.at                        | `number`（最近一次 set 的 epoch ms，内存；线上 `Info` 不变）                                                                                                                                                                                           | 主契约 §5.2.4 | `session/status.ts`                         | 每步置 busy 时更新（H12）                                                            |
| TextPart.metadata（agent 消息）                   | `{ kind: "agent_message", sender, sender_name?, sender_agent? }`                                                                                                                                                                                       | 主契约 §4.3   | `agent-management/inbox.ts`                 | 模型文本不变（INV-10）                                                               |
| TextPart.metadata（agent-message 路由的头行）     | `{ kind: "user_message" }`                                                                                                                                                                                                                             | 主契约 §4.3   | 同上                                        | 同上                                                                                 |
| TextPart.metadata（结束报告）                     | 既有 `{ kind: "agent_notification", summary }` + `sender, sender_name?, sender_agent?`                                                                                                                                                                 | 主契约 §4.3   | `session/prompt.ts` reportRunEnd            | 同上；TUI 只读 summary                                                               |
| TextPart.metadata（钩子继续消息）                 | `{ kind: "stop_hook", reason }`，part `synthetic: true`，text = reason，消息的 agent / model / system / tools 取 lastUser 的                                                                                                                           | 主契约 §4.4   | `session/prompt.ts` runLoop                 | 合成消息；TUI 渲染见 #90                                                             |
| Hook input                                        | `{ sessionID, parentID?, agent, message: { info: AssistantMessage, parts: Part[] }, continuations: NonNegativeInt }`（`agent` 是本轮用户消息的 agent；continuations 由钩子之外的新用户消息与工具调用清零）                                             | 主契约 §4.4   | `plugin/src/index.ts` + `session/prompt.ts` | 类型声明 + 测试断言输入形状                                                          |
| Hook output                                       | `{ decision: "allow" \| "block"; reason?: string }`，默认 allow                                                                                                                                                                                        | 主契约 §4.4   | 同上                                        | block 无 reason ⇒ 视为 allow；后写者胜                                               |
| Config.stop_hook_block_cap                        | `NonNegativeInt`，缺省 8；0 = 不调用钩子                                                                                                                                                                                                               | 主契约 §4.4   | `core/src/v1/config/config.ts`              | schema 校验                                                                          |
| 进度视图第一行                                    | `Now: <ISO+tz>. You are in run <n>, step <s>.` / 主会话 `You are at step <s>.`                                                                                                                                                                         | 主契约 §4.5   | `session/step-tail.ts`                      | 测试断言文本                                                                         |
| 进度视图总览行                                    | `Your subagents: <d> direct, <r> running, <i> idle.`                                                                                                                                                                                                   | 主契约 §4.5   | 同上                                        | 同上                                                                                 |
| 在跑行                                            | `<session_id>  <name>  run <n> since HH:MM:SS (<来源>), last step HH:MM:SS[; run <n−1> ended HH:MM:SS (<结局>)]`                                                                                                                                       | 主契约 §4.5   | 同上                                        | 同上                                                                                 |
| 已结束行                                          | `<session_id>  <name>  run <n> ended HH:MM:SS (<结局>)`                                                                                                                                                                                                | 主契约 §4.5   | 同上                                        | 同上                                                                                 |
| cut off 行                                        | `<session_id>  <name>  run <n> cut off since HH:MM:SS (not yet recorded as lost)`，不受窗口限制                                                                                                                                                        | 主契约 §4.5   | 同上                                        | 同上                                                                                 |
| 在跑而记录缺失或已关闭的行                        | `<session_id>  <name>  running (run record not updated yet)[, last step HH:MM:SS]`                                                                                                                                                                     | 主契约 §5.3.1 | `session/step-tail.ts`                      | 测试断言文本                                                                         |
| 已结束列表标题                                    | 窗口恰为 10 分钟 `Finished in the last 10 minutes, now idle:`；更长 `Finished since HH:MM:SS, now idle:`                                                                                                                                               | 主契约 §5.3.1 | `session/step-tail.ts`                      | 测试断言文本                                                                         |
| 省略行                                            | `… and N more running` / `… and N more finished`，不计入 10 行                                                                                                                                                                                         | 主契约 §4.5   | 同上                                        | 同上                                                                                 |
| renderOutput 属性                                 | `run="<n>" ended="<ISO+tz>"`（记录已关闭时；否则两者皆无；`ended` 由调用方按 run.ts 格式好传入）                                                                                                                                                       | 主契约 §4.6   | `agent-management/delegation.ts`            | 测试断言标签文本                                                                     |
| 摘要后缀                                          | ` (run <n>, ended HH:MM:SS)`（与属性同条件）                                                                                                                                                                                                           | 主契约 §4.6   | `session/prompt.ts` reportRunEnd            | server 独占措辞；TUI 原样显示                                                        |
| renderTermination 操作与记录行 | 操作行由 cancel 返回状态决定；独立的 `Latest run record after cancellation: N, ...` 为读取快照；无记录省略后者 | 主契约 §4.6 / §5.4.2 | `agent-management/lifecycle.ts` | 不声称取消的执行号 |
| `Runner.cancel` / `SessionRunState.cancel` 返回值 | 取消前状态标签 `Idle \| Running \| Shell \| ShellThenRun`（无 runner 时 `Idle`）                                                                                                                                                                       | 主契约 §5.4.2 | `effect/runner.ts`、`session/run-state.ts`  | renderTermination 操作行                                                             |
| agent_send 返回首句                               | 六种写法见主契约 §4.6；末尾恒加 `Current state of one agent: agent_status(target="…").`                                                                                                                                                                | 主契约 §4.6   | `tool/agent.ts`                             | 测试六例                                                                             |
| agent_status 参数                                 | `{ target: string }`                                                                                                                                                                                                                                   | 主契约 §4.7   | `tool/agent.ts`                             | schema                                                                               |
| agent_status 返回行                               | `session_id / name / agent_type / relation / status / run / previous run / last step / workdir`，run 行五种写法；非子会话无 run 与 previous run 行，在跑时有 last step 行                                                                              | 主契约 §4.7   | 同上                                        | 测试逐行                                                                             |
| agent_status 失败文本                             | 被拒 `agent_list is denied for you, and agent_status shows the same information.`；非邻居 `<id> is not one of your neighbours; only yourself, your parent, your direct children and your siblings can be looked up.`；名字零匹配 / 多匹配同 agent_send | 主契约 §3     | `tool/agent.ts`                             | 测试两例                                                                             |
| agent_list 参数                                   | `{ status?, relation?, query?, limit? }`，limit 缺省 50                                                                                                                                                                                                | 主契约 §4.7   | 同上                                        | schema；§3 枚举                                                                      |
| agent_list 列                                     | `session_id / name / agent_type / relation / status / run / last / title / workdir`；`last` 为 ISO 或空                                                                                                                                                | 主契约 §4.7   | 同上                                        | 测试表头与行                                                                         |
| agent_list 计数行                                 | `showing <shown> of <total> (<running> running, <idle> idle)`                                                                                                                                                                                          | 主契约 §4.7   | 同上                                        | 按截断前集合统计                                                                     |
| `Session.patch` 锁                                | 每会话一个 `Semaphore(1)`，覆盖读、合并、发布；获取超时 30 s 即 die（`OPENCODE_SESSION_PATCH_LOCK_MS` 可改，测试用）                                                                                                                                   | 主契约 §5.2.0 | `session/session.ts`                        | INV-11；重入守卫测试                                                                 |

## 3. 枚举值（机械化）

| 枚举                       | 合法集合                                                                          | 共享常量                                                                | import 路径                             |
| -------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------- |
| RunOutcome                 | `completed` \| `failed` \| `stopped` \| `lost`                                    | `AgentManagement.RUN_OUTCOMES`（新）                                    | `@/agent-management/schema`             |
| WakeSource.kind            | `agent` \| `user` \| `system`                                                     | `AgentManagement.WAKE_KINDS`（新）                                      | 同上                                    |
| part metadata.kind         | 既有 `agent_notification` + 新增 `agent_message` \| `user_message` \| `stop_hook` | `AgentManagement.PART_KINDS`（新，含既有 `NOTIFICATION_METADATA_KIND`） | 同上；TUI 各持一份（子计划 1 §10 约定） |
| Hook decision              | `allow` \| `block`                                                                | `plugin` 包类型字面量                                                   | `@opencode-ai/plugin`                   |
| Runner 状态标签            | `Idle` \| `Running` \| `Shell` \| `ShellThenRun`（既有）                          | `Runner` 的 state tag                                                   | `@/effect/runner`                       |
| agent_list.status          | `running` \| `idle`（既有 AgentStatus）                                           | 既有                                                                    | `@/agent-management/schema`             |
| agent_list.relation        | `self` \| `parent` \| `child` \| `sibling`（既有 relation）                       | 既有                                                                    | 同上                                    |
| classifyExit → RunOutcome  | completed→completed、failed→failed、cancelled→stopped；lost 只由 begin 产生       | 映射表 `run.ts` 的 `outcomeOf`                                          | `@/agent-management/run`                |
| `Permission.disabled` 别名 | 既有 edit/write/apply_patch→edit、MCP 资源→read；新增 `agent_status→agent_list`   | 别名表在 `permission/index.ts`                                          | —                                       |

## 4. 流程步骤（机械化）

`# Step Sn:` 注释约定（S 前缀，避免与 PBT 的 T 编号及修正方案文档的 P 编号混淆），覆盖下列全部步骤（grep 校验：`grep -rhoE "Step S[0-9]+" packages/opencode/src packages/plugin/src`；S7 落在 plugin 包）。

**停止把关（commit 1，`runLoop` 正常退出分支）**

- S1 步数上限：`lastStepReached` → 记日志 → 退出，不询问钩子
- S2 连续上限：`continuations >= cap` → 记日志 → 退出（cap = 0 即永不询问）
- S3 触发钩子，`catchAllCause`（抛错 → 记日志 → 放行）
- S4 `decision !== "block"` 或 reason 空白 → 退出（空白记警告）
- S5 阻止：落库合成用户消息（text = reason，metadata stop_hook；消息的 agent / model / system / tools 取 lastUser 的），`continuations + 1`，继续
- S6 清零：循环顶部最新用户消息无 `stop_hook` 标记 → `continuations = 0`；`hasToolCalls` 为真 → `continuations = 0`；每步 `isLastStep` 为真 → `lastStepReached = true`
- S7 Hooks 类型与 `customize-opencode.md` 条目

**会话 patch 加锁（commit 2）**

- S8 `Session.patch` 在每会话信号量内执行读、合并、发布；获取超时 30 s 即 die；重入守卫测试（监听者内 patch 同一会话须在缩短的超时后以 defect 结束）
- S9 `SessionStatus.Projected.at`：每次 `set` 记时间，事件不带

**run 记录（commit 2，`loop` 的 work 包装）**

- S10 闭包标志：首次执行 `fresh = true`，re-arm 为 false；work 先 `status.set busy`
- S11 开始（`Session.updateMetadata`，patch 锁内读-判-写）：重读元数据 → 遗留打开记录关为 lost 入 previous；续跑遇已关闭记录按新 run → `wakeSource` → `begin` → 有新值才写回 → 返回本次 run 持有的号（新开的，或 re-arm 时自己仍打开的；写失败为 undefined，且其后的 re-arm 也不认领任何记录）
- S12 结束（同一把锁内判归属并写）：`onExit` 内读一次 `hasUnconsumedTurn` → 为真不关闭；否则 `outcomeOf` → 记录号 = 本次 run 持有的号才 `end` → 写回 → 再 `reportRunEnd(outcome, closed)`；号不符（取消收尾与下一 run 开启重叠、打开写失败后的遗留记录）→ 不关、报告无 run 属性

**消息标记（commit 2，`deliver`）**

- S13 agent 路 part 带 `agent_message` 三字段；user 路头行带 `user_message`；结束报告带发送方三字段

**进度视图（commit 3）**

- S14 门：无直接子或 `agent_list` deny → 不附带；筛选后无有效项同样不附带子 Agent 节
- S15 采集：一次 children SQL 和一次 status.list；窗口下界取 `min(now − 10min, previousStepStart)`。状态由 work 持有，首步初始化，同号 re-arm 保留（含根），新号或新 loop 重置；收到带 finish 的响应即推进，先于各提前退出分支；预检撤回/provider 拒绝不推进。
- S16 渲染：在跑升序（`started_at ?? created`）、已结束降序（`ended_at ?? started_at`）、cut off 行不受窗口限制、各 10 行、省略行、上一个 run 的分号句；总览计数为两个列表截断前的集合，过窗结束/空闲无记录项不计数；两列表空时整节省略，重复计数独立保留；节序在重复计数之前
- S17 删除花名册注入（`applyAgentRoster` 调用与实现），保留 sentinel 常量

**报告与 agent_send（commit 4）**

- S18 `reportRunEnd` 读关闭后的 agentRun → 已关闭才加 run / ended 属性与摘要后缀
- S19 `Runner.cancel` / `SessionRunState.cancel` 返回取消前状态标签
- S20 `renderTermination`：cancel → 读取最新记录；操作行与记录快照行独立，不从前后记录推导被取消的 run。
- S21 `agent_send` 在 deliver **之前**取状态与 agentRun 快照 → 六种措辞 + agent_status 提示行；投递失败不输出

**agent_status / agent_list（commit 5）**

- S22 `agent_status`：`agent_list` 权限求值 → resolveTarget(neighbor) → 读取 → 渲染（run 行五种；非子会话只有 last step 行）
- S23 `agent_list`：组装 → 过滤 → 统计 → 排序（self 置顶 → 在跑 → 活动倒序 → id）→ 截断 → 计数行
- S24 可见性：`AGENT_TOOL_IDS` 与 `visibleAgentTools` 并列；`Permission.disabled` 别名 `agent_status→agent_list`

## 5. 行为契约（语义，人审）

- 钩子只在模型给出最终回答、没有待执行工具调用时触发；带错误的助手消息、权限或提问被拒、输出截断、人中断、agent_stop、结构化输出结束、到达步数上限均不触发。这些退出仍产生 run 记录关闭与报告。
- 阻止后的继续发生在同一次 run 内：父没有收到报告，run 号不变，会话不转空闲。继续消息进入历史与压缩输入；TUI 不显示它（#90）。
- 连续阻止 8 次（或配置值）后不再询问、直接结束；任一步调用了工具即清零；钩子之外的新用户消息即清零——run 中途插入、被同一次 runLoop 读到的消息（steer）与 re-arm 消费的输入都算；配置 0 表示钩子不被调用；多插件后写者胜；钩子无超时。
- 主会话与子 agent 用同一个钩子、同一分支；宿主不按 `parentID` 做任何区分。
- run 号只在新 run 开始时加一：work 首次执行，或续跑时记录已被 `onExit` 关闭；普通 re-arm 不加；遗留打开记录在新 run 开始时关为 lost。
- 首次 run 的唤醒来源是创建者（父）；结束报告唤醒的 run 来源记为发报告的子；人经 TUI 的 agent-message 路由记 `user`，经普通 prompt 端点记 `system`；其余记 `system`。
- 结束报告标明实际关闭的 run，停止通知只附最新记录快照、不声称取消身份；run 号允许不连续，不回溯补发报告；同一 run 号的报告至多一份；lost 的 run 没有报告；崩溃后不补发通知。
- `agent_send` 的六种措辞按投递前快照选择；非子会话只写 running / idle；末尾恒附 `agent_status` 提示行；既有三句单向消息说明保留；stopped / lost 的第二句不假定停止者是调用者。
- `agent_status` 的可查范围、解析与权限与 `agent_list` 完全相同；`agent_list` 被禁用时 `agent_status` 不出现在工具表、执行也被拒（有意的不对称：`agent_list` 自身无执行期检查）。
- `agent_list` 不带参数时默认上限 50；计数行按过滤后、截断前的集合统计；`query` 不匹配 `agent_type`；自己的行恒在第一行（§6 第 18 点）。
- 进度视图只在有直接子且 `agent_list` 非 deny 的会话出现；两个列表各最多 10 行；窗口至少覆盖上一次带视图的步开始以来（压缩等不出视图的迭代不推进它），首步为 run 开始以来；cut off 行不受窗口限制；"last step" 是状态投影最近一次置 busy 的时间；花名册不再写入历史。
- 新 run 启动时先置 busy 再开记录：任何时刻不会出现"记录已打开、状态 idle"的刚启动 run。
- 模型可见的消息文本不因任何 metadata 而变。
- 没有默认步数上限；`steps` 仍为按 agent 的选择项。

## 6. 时序/状态契约（人审）

- `runLoop` 退出 → 钩子 →（放行）→ `onExit`：一次 `hasUnconsumedTurn` 读 → run 记录关闭 → `reportRunEnd` → runner 自己的读 → re-arm 或 `onIdle`。被阻止时链在第二步折回循环。
- `onExit` 的读与 runner 的读不一致（消息恰落在两次读之间）时：记录关为 completed 且 run N 报告发出；runner 续跑同一 work，`fresh = false` 但记录已关闭 → 开 run N+1，续跑结果以 N+1 报告。不出现同号两份报告，也不静默。
- `agent_send` 的状态快照取自 deliver 之前；返回文本描述的是投递那一刻，不承诺此后。
- `renderTermination` 不关联取消执行与元数据编号。`before` 来自 cancel，记录来自取消后的独立读取；打开只称 not closed，不推断 running/cut off。
- 记账失败不阻塞 run，也不阻止报告发出；报告在记录缺失或未关闭时省略 run / ended。
- 进度视图每步重建，不写入历史，不进压缩输入；窗口按墙钟与上一次带视图的步开始计算，同号 re-arm 保留工作闭包里的下界；新号/新 loop 重置。
- `Session.patch` 对同一会话串行；锁只在 patch 时持有；`publish` 返回时投影已完成、同步监听者已跑完；`Updated` 监听者不得回头 patch 同一会话（现状五个监听者均不会；守卫是 30 s 超时 die）。

## 7. 不变量契约（property-based）

> **框架声明**：原 T 系列沿用种子化随机生成 + 按定义重算的参照实现，一次失败即报种子。2026-11-03 总览退窗修复另用 `effect/testing` 的 FastCheck 验证分类计数、过期项不影响输出和跨时间边界退出。

- **INV-5（= I5）** 任意事件序列（发送到空闲的子、中途插入消息、re-arm、续跑窗口、完成 / 失败 / 被停、并发多子、崩溃遗留的打开记录、注入一次结束写失败、注入一次开始写失败、取消收尾时下一 run 已开启）经真实 `loop` 执行后，每个子的 run 号序列严格递增且每次只加一；普通 re-arm 不改变它，续跑窗口加一；写失败与遗留的记录在下一次开始时被记为 lost 且号不重复；一次 run 只关闭自己持有号的记录：取消收尾不动下一 run 的记录，开始写失败的 run 不冒用遗留记录、其报告无 run 属性，它被 re-arm 后同样不认领（晚到消息与写失败是两个独立抽取的维度）；每条记录打开时会话已是 busy。—— T3 加两条定值用例（钩子阻止不加号由定值用例覆盖）
- **INV-6（= I6）** 每份结束报告的 run 号等于发出时该子已关闭的 run，按结束顺序一一对应；同号报告至多一份；结束写失败的那份报告不带 run 属性；`ended ≥ started`。—— T3（停止通知的独立快照性质见 INV-14）
- **INV-6b** `agent_send` 对空闲且记录已关闭的目标预告的 run 号等于该子的下一份报告的 run 号。—— 定值用例（经注册表里真实的 `agent_send` 投递；T3 不改走工具投递，理由见主契约 §5.4.3）
- **INV-7（= I7）** 对任意步序列（工具步、询问钩子的最终回答、带中途插入新消息的最终回答）与任意 cap（1–8），钩子连续阻止长度不限：父收到的报告恰一份，其创建时间不早于最后一次询问；每次询问的 `continuations` 等于按定义推进的参照值；每个请求的最后一条用户消息文本等于当时最新的 reason 或插入消息；每次询问之前子会话的 `SessionStatus` 事件序列中没有 idle。—— T8
- **INV-7b** 每段连续无工具、无新输入的退出尝试中询问与阻止次数 ≤ cap；一步含工具调用或钩子之外的新用户消息后计数从 0 重新累积。—— T8（steer、超 cap 的阻止）；定值用例（新 run 再次询问）
- **INV-8（= I8）** 相邻两步请求的历史部分逐字相同（R1 扩展到带进度视图的会话）；视图文本不出现在会话历史与压缩输入中。
- **INV-8b** 随机生成子集合（状态、记录、创建时间、最后一步时间）与窗口：在跑列表恰等于投影 running 的子按 `started_at ?? created` 升序取前 10；已结束列表恰等于空闲且有 run 记录且（已关闭且 `ended_at ≥ windowStart`，或未关闭）的子按 `ended_at ?? started_at` 降序取前 10；总览 direct/running/idle 为这两个集合截断前的大小，总数等于两分项之和；过窗结束项/空闲无记录项加入输入不影响输出；集合空返回 undefined。省略计数等于被截去的数量；非空视图行数恰为标题、各行与省略行之和（名字与唤醒来源名含换行、制表符、`]` 时也不多出一行）；同一输入两次渲染文本相同。—— T7 与 FastCheck 退窗性质
- **INV-9（= I9）** 对权限规则形态 {无规则、`agent_list: deny` 通配、`agent_list` 具体 pattern 的 deny（`Permission.disabled` 只认 `pattern === "*"`，故不隐藏）、`agent_status: deny`} × 深度 {< limit, ≥ limit} 的全部组合，工具表中 `agent_status ∈ tools ⇔ agent_list ∈ tools`；`agent_list` 通配 deny 时 `agent_status` 执行被拒。—— 枚举
- **INV-10（= I10）** 对任意发送方字段，`render()` 的输出与基线逐字相同；四条路径的 metadata 形状固定。—— 枚举
- **INV-11（= I11）** 对同一会话的任意并发 patch 序列（随机的 setTitle / setMetadata / touch / setAgentModel；另 `updateMetadata` 并发自增 N 次恰得 N，每次写入的值各不相同），锁内按序发布的 `session.updated` 行序列中，title / metadata.note / agent / model.id 四个字段都不会回到出现过的值（丢失的更新就是回退），每次写入的值都在某一行出现过，最终行等于最后一个事件的行。这蕴含"每个字段等于最后一次写该字段的值"。—— T9
- **INV-12** `agent_list` 结果 ⊆ 过滤后的邻居集合 ⊆ 邻居；计数行与过滤后集合的统计一致；行数 ≤ limit；排序满足"self 在前，在跑在前，其余按活动（`last ?? time_created`）倒序，并列按 id"。—— T4
- **INV-13** 新 run 启动后任一时刻，`状态 idle ∧ 记录打开` 只在崩溃遗留下出现：T3 在每条记录打开的 `session.updated` 事件里读状态投影，断言已是 busy；agent_send / agent_status 的 cut off 措辞都以 idle 为前提，故等价于"从不对刚启动的 run 输出 cut off"。—— T3

- **INV-14** 取消交接期间任意初始记录状态、任意目标/后代清理顺序下，通知分别描述 cancel 状态和读取的最新记录，不猜测取消编号；replacement 是否被取消由真实 Runner 中断集合断言。—— T10（3 种子，每种子 2 时序 × 3 记录状态，随机深度/编号/时间/结局；另枚举 Idle/Running × 最终记录缺失/打开/四种结局，共 12 格）。
- **INV-15** 同号 re-arm 的下一份视图覆盖上一真实步骤期间的孩子完成；新号续跑或独立新 run 不继承旧宽窗口。根 Session 同样保留普通 re-arm 窗口；10 分钟边界含等号。—— T11（2 种子 × 4 生命周期，每例 4 个完成时间位置；第二组种子增加前置工具步及已展示的更早完成项，共三次请求，验证提前退出前也推进下界）。

## 8. 性能契约（机械化）

- 进度视图每步的数据采集 = 一次 SQL（`Session.children`，按 parent_id）+ 一次内存状态投影拷贝；不读历史、不读消息、不算 depth。单测断言：构造 600 个直接子的会话，采集只调用一次 `Session.children`，采集加渲染耗时上界 50 ms。观测点是 Session.Interface 边界而不是 SQL：Database 层没有查询计数器也没有 Drizzle 日志钩子，而采集函数的参数类型是 `Pick<Interface, "children">`，它能到达存储的路只有这一条，`children` 本身是一条 `where parent_id = ?`。
- 进度视图文本 ≤ 30 行。
- run 记录每次 run 写两次，不按步写；`SessionStatus.at` 是内存写。
- `Session.patch` 的锁持有时间 = 一次行读 + 一次事务写 + 同步监听者（分享同步的缓存读与入队、事件桥的同步转发、HTTP 事件流入队）；单测断言单次 patch 的锁持有 < 50 ms；获取超时 30 s。
- 钩子每段连续无工具、无新输入的退出尝试至多调用 `cap` 次：第 cap + 1 次尝试在 S2 不询问即退出。
- `agent_list` 的输出长度受 `limit`（默认 50）约束（单测断言默认 50 行上限）。

## 9. 安全/副作用契约

- 进度视图、`agent_status`、`agent_list` 中来自模型的名字与标题一律经 `AgentInbox.escapeField`，run 记录里的唤醒来源名（`woken_by.name`，经 `describeSource`；无名字时输出的 session id 同样转义）与 `workdir` 路径（可来自模型给的 cwd；`agent_status` 与 `agent_list` 两处）也在其中，换行无法伪造一行。
- 钩子的 `reason` 原样成为模型的下一条输入；它来自用户安装的插件，与压缩后的合成继续消息同信任级，不转义。
- 钩子不能执行工具、不能改历史，只能决定继续与否；连续阻止有上界。
- `agent_status` 不暴露 `agent_list` 之外的任何信息（相同范围、相同权限键）。
- metadata 只增不改：既有 `agent_notification` 的两个字段不变；旧记录无标记时所有读者容忍缺失。
- run 记录写入只发生在本会话 run 的开始与结束；记账失败不影响执行。写入经 `Session.patch` 的锁，不覆盖 `agentName` / `agentWorkdir` / `agentDescription` / `agentNotify`。
- 已知破坏路径：HTTP `session.update` 以客户端的旧副本整体替换元数据会抹掉 `agentRun`（以及其他 agent 元数据）；保持替换语义，读者容忍缺失。
- `Session.patch` 的锁超时 die 是防御性的，正常路径不触发；一旦触发说明有重入或卡死，消息带会话 id。
- 不修改用户配置、无新增网络出口。

## 10. 跨实现一致性

| 项                                                    | 机制                                                                                                                                                                                                                       |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent_message` / `user_message` / `stop_hook` 字面量 | server 侧常量 `PART_KINDS` 与 `agent_notification` 同文件；TUI 实现 #73 / #90 时各持一份并以 fixture 测试钉住                                                                                                              |
| 时间格式                                              | 视图第一行、报告属性、`agent_send`、`agent_status` 用带本地时区偏移的 ISO 8601；视图列表与摘要后缀用 HH:MM:SS；同一进程同一时区；`run.ts` 两个纯函数是唯一出处                                                             |
| 摘要后缀措辞                                          | owner = server（reportRunEnd）；TUI 原样显示                                                                                                                                                                               |
| 钩子语义                                              | 与 Claude Code 文档的 Stop / SubagentStop 对齐：阻止即继续、理由为下一条指令、8 次上限、调用工具或新输入清零、stop_hook_active 以一次停止尝试为单位；差异（不做 additionalContext、不触发结构化输出、无超时）记在主契约 §1 |
| 默认步数上限                                          | 与上游 V1/V2 和 Claude Code 一致：无默认；对照记录在调研 §18.4                                                                                                                                                             |
| 工具描述                                              | 只写事实，不教用法（#59）；不解释 run 跳号                                                                                                                                                                                 |

## Step 5 验证记录（2026-10-31 回填，基线 `fe2470fdfd`）

- [x] 路径 A：以仓库单测承担——§2 / §3 由 `run.test.ts`、`inbox.test.ts`、`prompt.test.ts`（报告 metadata）、`next.test.ts` 钉住；§4 `Step S1–S24` grep 全覆盖（命令见 §4，S7 在 plugin 包）；§5 / §6 定值用例在 `prompt.test.ts`、`lifecycle.test.ts`、`tools.test.ts`、`session.test.ts`；§7 T3 / T4 / T7 / T8 / T9 加 INV-6b、INV-9、INV-10 的定值与枚举；§8 五条性能断言。专用脚本仍 N/A，理由同子计划 1
- [x] 路径 B：独立审核 agent（给契约文档 + git diff，不给实现位置列）→ `audit-report.md` §3.1；❌ 2 已修，⚠️ 11 处置见 `decisions.md`
- [x] `decisions.md`：D1–D17
- [x] §5.2 五维度审核：实施期间未按 commit 留下书面自审（原表述不实，2026-11-01 更正）；补做一次覆盖全部实施提交的审核 → `audit-report.md` §3.2、`decisions.md` D25–D40；最终人工验证待用户
- [x] 2026-11-01 补充：一份外部审核（基线 `9daaf4b85e`，3 P2 + 2 边界 + PBT 缺口）与 §5.2 审核一起处置 → `decisions.md` D18–D40。契约随之改动：INV-5 增归属与开始写失败、取消交接；S11 / S12 改为 `Session.updateMetadata` 锁内读-判-写；S22 门先于解析；§2 agent_status 行、钩子继续消息行；§9 增来源名 / session id / workdir 转义；INV-8b 行数恰等于定义；INV-11 增 `updateMetadata` 并发自增；窗口下界改为"上一次带视图的步"
- [x] 2026-11-01 第二轮外部审核（基线 `05aba09705`）：R1–R3 处置 → `decisions.md` D41–D46、`audit-report.md` §3.3。契约随之改动：S11 的 re-arm 只续接自己持有的记录；S15 下界只在响应到手后推进；S20 增取消前读与"has started since"；INV-5 增"开始写失败后的 re-arm 不认领"；§6 停止通知四种情况
- [x] 修正方案文档 `session-fix-step-tail-repeat-and-agents.md` 第六、七、八部分已回填 commit

- [x] 2026-11-02 第三轮修正：S15 的窗口随 work 生命周期保留，带 finish 响应在提前退出前推进；S20 操作与快照分离。新增 INV-14/T10、INV-15/T11，14 定向用例通过；独立复核 0 unresolved；完整模块 900 pass / 7 skip / 1 todo / 2 fail，两项时间预算失败单跑均过，原失败仍保留，见 audit-report §3.4 / decisions D47–D50。
