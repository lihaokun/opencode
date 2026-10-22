# Contract Audit Expectations — `agentmgmt-2-run-state`

> Step 0 产出（workflow §6.2）。契约抽取自契约文档，未经现有代码回填。
> 抽取时基线：`step-tail` @ `97b272f37f`。

## 1. 契约源（multi-doc）

| 文档                                                             | 用途                                                                                                                       | 相关节              |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `docs/design/agent-management/subplans/agentmgmt-2-run-state.md` | **主契约**（数据结构 / 接口 / 流程 / 论证 / 已确认决策）                                                                   | §0–§8 全部          |
| issue #75 / #81 / #73                                            | 需求源；与 #75 原文的两处差异记在主契约 §6                                                                                 | 各 issue 正文       |
| `docs/fixes/session-fix-step-tail-repeat-and-agents.md`          | 末尾段机制（已落地）与 #75 的修正方案；本子计划是其 4.4–4.9 的设计落点                                                     | §4.1–§4.9、第六部分 |
| `docs/design/agent-management/architecture.md`                   | 既有架构（I3 单活动执行、Accepted 强度、通知通道、权限门）                                                                 | §3、§4.3–§4.5、§7   |
| `docs/research/agent-management-research.md`                     | §12 的收敛被 §18 撤销的理由                                                                                                | §12、§18            |
| Claude Code hooks 文档（Stop / SubagentStop）                    | 钩子语义的外部参照：阻止即继续、理由为下一条指令、8 次上限、调用工具清零                                                   | —                   |
| 既有契约（本子计划引用且**不改**）                               | `render()` 的转义与文本、`deliverAsync` 的 fork + 路由、`hasUnconsumedTurn`、`classifyExit` 三分类、`setMetadata` 整体替换 | —                   |

## 2. Schema 字段（机械化）

| 字段                                     | 类型                                                                                   | 契约来源    | 实现位置（计划）                            | 一致性机制                        |
| ---------------------------------------- | -------------------------------------------------------------------------------------- | ----------- | ------------------------------------------- | --------------------------------- |
| Session.metadata.agentRun.number         | `PositiveInt`                                                                          | 主契约 §4.1 | `agent-management/run.ts`                   | INV-5                             |
| Session.metadata.agentRun.started_at     | `number`（epoch ms）                                                                   | 主契约 §4.1 | 同上                                        | 与 `Session.time` 同口径          |
| Session.metadata.agentRun.woken_by       | `WakeSource`                                                                           | 主契约 §4.1 | 同上                                        | §3 枚举                           |
| Session.metadata.agentRun.ended_at       | `number`（可选）                                                                       | 主契约 §4.1 | 同上                                        | 与 outcome 同在同缺；≥ started_at |
| Session.metadata.agentRun.outcome        | `"completed" \| "failed" \| "stopped"`（可选）                                         | 主契约 §4.1 | 同上                                        | §3 枚举                           |
| WakeSource.kind / session / name / agent | 见主契约 §4.2                                                                          | 主契约 §4.2 | 同上                                        | kind = agent ⇒ session 必填       |
| TextPart.metadata（agent 消息）          | `{ kind: "agent_message", sender, sender_name?, sender_agent? }`                       | 主契约 §4.3 | `agent-management/inbox.ts`                 | 模型文本不变（INV-10）            |
| TextPart.metadata（人发进子会话的头行）  | `{ kind: "user_message" }`                                                             | 主契约 §4.3 | 同上                                        | 同上                              |
| TextPart.metadata（结束报告）            | 既有 `{ kind: "agent_notification", summary }` + `sender, sender_name?, sender_agent?` | 主契约 §4.3 | `session/prompt.ts` reportRunEnd            | 同上；TUI 只读 summary            |
| TextPart.metadata（钩子继续消息）        | `{ kind: "stop_hook", reason }`，part `synthetic: true`，text = reason                 | 主契约 §4.4 | `session/prompt.ts` runLoop                 | 合成消息，TUI 既有 synthetic 处理 |
| Hook input                               | `{ sessionID, parentID?, agent, message: { info, parts }, continuations }`             | 主契约 §4.4 | `plugin/src/index.ts` + `session/prompt.ts` | 类型声明 + 测试断言输入形状       |
| Hook output                              | `{ decision: "allow" \| "block"; reason?: string }`，默认 allow                        | 主契约 §4.4 | 同上                                        | block 无 reason ⇒ 视为 allow      |
| Config.stop_hook_block_cap               | `NonNegativeInt`，缺省 8                                                               | 主契约 §4.4 | `core/src/v1/config/config.ts`              | schema 校验                       |
| agent_status 参数                        | `{ target: string }`                                                                   | 主契约 §4.7 | `tool/agent.ts`                             | schema                            |
| agent_list 参数                          | `{ status?, relation?, query?, limit? }`，limit 缺省 50                                | 主契约 §4.7 | 同上                                        | schema；§3 枚举                   |
| renderOutput 属性                        | `run="<n>" ended="<ISO+tz>"`（有记录时）                                               | 主契约 §4.6 | `agent-management/delegation.ts`            | 测试断言标签文本                  |
| 摘要后缀                                 | ` (run <n>, ended HH:MM:SS)`                                                           | 主契约 §4.6 | `session/prompt.ts` reportRunEnd            | server 独占措辞；TUI 原样显示     |

## 3. 枚举值（机械化）

| 枚举                       | 合法集合                                                    | 共享常量                                       | import 路径                             |
| -------------------------- | ----------------------------------------------------------- | ---------------------------------------------- | --------------------------------------- |
| agentRun.outcome           | `completed` \| `failed` \| `stopped`                        | `AgentManagement.RUN_OUTCOMES`（新）           | `@/agent-management/schema`             |
| WakeSource.kind            | `agent` \| `user` \| `system`                               | `AgentManagement.WAKE_KINDS`（新）             | 同上                                    |
| part metadata.kind（新增） | `agent_message` \| `user_message` \| `stop_hook`            | 与既有 `NOTIFICATION_METADATA_KIND` 同文件导出 | 同上；TUI 各持一份（子计划 1 §10 约定） |
| Hook decision              | `allow` \| `block`                                          | `plugin` 包类型字面量                          | `@opencode-ai/plugin`                   |
| agent_list.status          | `running` \| `idle`（既有 AgentStatus）                     | 既有                                           | `@/agent-management/schema`             |
| agent_list.relation        | `self` \| `parent` \| `child` \| `sibling`（既有 relation） | 既有                                           | 同上                                    |
| classifyExit → outcome     | completed→completed、failed→failed、cancelled→stopped       | 映射表在 `run.ts`                              | —                                       |

## 4. 流程步骤（机械化）

`# Step Pn:` 注释约定，覆盖下列全部步骤（grep 校验）。

**停止把关（commit 1，`runLoop` 正常退出分支）**

- P1 上限检查：`continuations >= cap` → 记日志 → 退出
- P2 触发钩子（抛错 → 记日志 → 放行）
- P3 `decision !== "block"` 或 reason 空白 → 退出（空白记警告）
- P4 阻止：落库合成用户消息（text = reason，metadata stop_hook），`continuations + 1`，继续
- P5 清零：循环顶部 `hasToolCalls` 为真 → `continuations = 0`

**run 记录（commit 2，`loop` 的 work 包装）**

- P6 开始：重读元数据 → `wakeSource` → `begin` → 有新值才写回
- P7 结束：`Exit.isSuccess && hasUnconsumedTurn` → 不关闭；否则 `classifyExit` → `end` → 写回；再 `reportRunEnd`

**消息标记（commit 2，`deliver`）**

- P8 agent 路 part 带 `agent_message` 三字段；user 路头行带 `user_message`；结束报告带发送方三字段

**末尾段子 agent 节（commit 3）**

- P9 门：无直接子或 `agent_list` deny → 不附带
- P10 采集：每子的状态投影 + agentRun → changes；窗口起点 = 往前第 5 步的开始
- P11 渲染：过滤、升序、8 行上限、节序在重复计数之前

**报告与 agent_send（commit 4）**

- P12 `reportRunEnd` 读关闭后的 agentRun → run / ended 属性 + 摘要后缀
- P13 `renderTermination` 加 run 行（记录未关闭时写 stop requested）
- P14 `agent_send` 在 deliver **之前**取状态与 agentRun 快照 → 四种措辞 + agent_status 提示行

**agent_status / agent_list（commit 5）**

- P15 `agent_status`：resolveTarget(neighbor) → `agent_list` 权限求值 → 读取 → 渲染
- P16 `agent_list`：组装 → 过滤 → 统计 → 排序 → 截断 → 计数行
- P17 可见性：`AGENT_TOOL_IDS` 与 `visibleAgentTools` 中 `agent_status` 与 `agent_list` 同列；注册表过滤以 `agent_list` 键求值

## 5. 行为契约（语义，人审）

- 钩子只在模型给出最终回答、没有待执行工具调用时触发；带错误的助手消息、人中断、agent_stop、结构化输出结束均不触发。
- 阻止后的继续发生在同一次 run 内：父没有收到报告，run 号不变，会话不转空闲。
- 连续阻止 8 次（或配置值）后强制放行；任一步调用了工具即清零；配置 0 表示不接受阻止。
- 主会话与子 agent 用同一个钩子、同一分支；宿主不按 `parentID` 做任何区分。
- run 号只在上一个 run 已关闭或无记录时加一；re-arm 不加；记录只保留最近一次 run。
- 首次 run 的唤醒来源是创建者（父）；结束报告唤醒的 run 来源记为发报告的子；人经 TUI 发进子会话记 `user`；其余记 `system`。
- 结束报告与停止通知标明它关闭的那个 run；run 号允许不连续，不回溯补发报告。
- `agent_send` 对空闲目标写"starts run N+1 (sent …)"，对在跑目标写"is in run N (started …)"；非子会话只写 running / idle；末尾恒附 `agent_status` 提示行；既有三句单向消息说明保留。
- `agent_status` 的可查范围、解析与权限与 `agent_list` 完全相同；`agent_list` 被禁用时 `agent_status` 不出现在工具表、执行也被拒。
- `agent_list` 不带参数时默认上限 50（有意的行为改变）；计数行按过滤后、截断前的集合统计。
- 末尾段子 agent 节只在有直接子且 `agent_list` 非 deny 的会话出现；无变化时只有第一行；最多 8 行变化，超出保留最近的并写省略行；同一变化在其后至多 5 步重复出现。
- 模型可见的消息文本不因任何 metadata 而变。
- 花名册（写入历史的那条）不变。

## 6. 时序/状态契约（人审）

- `runLoop` 退出 → 钩子 →（放行）→ run 记录关闭 → `reportRunEnd` → runner `onIdle`。被阻止时链在第二步折回循环。
- `recordRunEnd` 与 `reportRunEnd` 对同一次退出使用同一个 `hasUnconsumedTurn` 读数的语义：都在 `onExit` 内、前者先执行；二者可能各读一次，"消息恰在两次读之间到达"只意味着下一次 run 也报告，不意味着没有报告（既有 `reportRunEnd` 注释的同一论证）。
- `agent_send` 的状态快照取自 deliver 之前；返回文本描述的是投递那一刻，不承诺此后。
- `renderTermination` 读 agentRun 时被取消 fiber 的 `onExit` 可能尚未完成；此时写 `stop requested at`，不等待。
- 记账（run 记录）失败不阻塞 run，也不阻止报告发出；报告在无记录时省略 run / ended。
- 末尾段每步重建，不写入历史，不进压缩输入；窗口按本 run 的步起点计算，新 run 从头算。
- 钩子阻止落库的合成消息是真实历史，进入压缩输入（与压缩后的自动继续消息同类）。

## 7. 不变量契约（property-based）

> **框架声明**：仓库未引入 property-based 框架。沿用 `step-tail` 分支的做法：种子化随机生成 + 按定义重算的参照实现（`test/session/step-tail.test.ts`、`prompt.test.ts` 的 P5 / P6），一次失败即报种子。

- **INV-5（= I5）** 任意事件序列（发送到空闲 / 在跑的子、完成 / 失败 / 被停、re-arm、并发多子、钩子阻止）经真实 `loop` 执行后，每个子的 `agentRun.number` 序列严格递增且每次只加一；re-arm 与钩子阻止不改变它。—— P3
- **INV-6（= I6）** 每份结束报告与停止通知的 run 号等于发出时该子已关闭的 run；`ended ≥ started`。—— P3
- **INV-6b** `agent_send` 对空闲目标预告的 run 号等于该子的下一份报告的 run 号。—— P3
- **INV-7（= I7）** 对任意阻止序列（长度 < cap），父收到的报告恰一份且在最后一次放行之后；中间每次请求的最后一条用户消息文本等于当次 reason。—— 枚举 + 随机阻止次数
- **INV-7b** 连续阻止次数永不超过 cap；一步含工具调用后计数从 0 重新累积。
- **INV-8（= I8）** 相邻两步请求的历史部分逐字相同（已有的 R1 断言扩展到带子 agent 节的会话）；末尾段文本不出现在会话历史与压缩输入中。
- **INV-8b** 随机生成子的 run 事件与步起点序列：每条变化恰在其后至多 5 步的末尾段出现、之后不再出现；行数 ≤ 9；超出 8 条时保留时间最近的。—— P7
- **INV-9（= I9）** 对任意权限配置与深度，工具表中 `agent_status ∈ tools ⇔ agent_list ∈ tools`；`agent_list` 为 deny 时 `agent_status` 执行被拒。—— 枚举配置
- **INV-10（= I10）** 对任意发送方字段，`render()` 的输出与基线逐字相同；三条路径的 metadata 形状固定。—— 枚举
- **INV-11** `agent_list` 结果 ⊆ 过滤后的邻居集合 ⊆ 邻居；计数行与过滤后集合的统计一致；行数 ≤ limit；排序满足"在跑在前，其余按 last 倒序"。—— P4

## 8. 性能契约（机械化）

- 末尾段子 agent 节每步的读取量 = 直接子数 × (一次状态投影 + 一次会话读取)，与花名册每轮的读取同量级；不读历史、不扫描全树。无时长断言；若实现中引入超线性扫描回填本节。
- `agent_list` 的输出长度受 `limit`（默认 50）约束；#75 实测的 290 行 / 48,599 字符输出在默认参数下不再出现（单测断言默认 50 行上限）。
- 钩子触发每次 run 结束至多 `cap + 1` 次。

## 9. 安全/副作用契约

- 末尾段、`agent_status`、`agent_list` 中来自模型的名字与标题一律经 `AgentInbox.escapeField`，换行无法伪造一行。
- 钩子的 `reason` 原样成为模型的下一条输入；它来自用户安装的插件，与压缩后的合成继续消息同信任级，不转义。
- 钩子不能执行工具、不能改历史，只能决定继续与否；阻止的次数有上界。
- `agent_status` 不暴露 `agent_list` 之外的任何信息（相同范围、相同权限键）。
- metadata 只增不改：既有 `agent_notification` 的两个字段不变；旧记录无标记时所有读者容忍缺失。
- run 记录写入只发生在本会话 run 的开始与结束；记账失败不影响执行；不修改用户配置、无新增网络出口。
- 写入会话元数据前重读，不覆盖 `agentName` / `agentWorkdir` / `agentDescription` / `agentNotify`。

## 10. 跨实现一致性

| 项                                                    | 机制                                                                                                                                                                |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent_message` / `user_message` / `stop_hook` 字面量 | server 侧常量与 `agent_notification` 同文件；TUI 实现 #73 时各持一份并以 fixture 测试钉住（子计划 1 §10 同款）                                                      |
| 时间格式                                              | 报告属性与 `agent_send` 用带本地时区偏移的 ISO 8601；末尾段与摘要后缀用 HH:MM:SS；同一进程同一时区；`run.ts` 两个纯函数是唯一出处                                   |
| 摘要后缀措辞                                          | owner = server（reportRunEnd）；TUI 原样显示                                                                                                                        |
| 钩子语义                                              | 与 Claude Code 文档的 Stop / SubagentStop 对齐：阻止即继续、理由为下一条指令、8 次上限、调用工具清零；差异（不做 additionalContext、不触发结构化输出）记在主契约 §1 |
| 工具描述                                              | 只写事实，不教用法（#59）；不解释 run 跳号                                                                                                                          |

## Step 5 验证记录（实施后回填）

- [ ] 路径 A：以仓库单测承担（schema / metadata 形状断言、`# Step Pn:` grep、枚举常量 import 断言），逐项回填测试名；专用脚本仍 N/A，理由同子计划 1
- [ ] 路径 B：subagent 独立审（给契约文档 + git diff，不给实现位置列）→ `audit-report.md`
- [ ] `decisions.md`：⚠️ 项处置
- [ ] §5.2 五维度审核通过
- [ ] 修正方案文档 `session-fix-step-tail-repeat-and-agents.md` 第六、七、八部分回填 commit
