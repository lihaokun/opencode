# Agent 管理能力调研

- 状态：调研阶段已确认（2026-09-04）；2026-09-05 三次修订见 §12–§14；2026-09-07 扩充范围见 §15
- 日期：2026-08-31
- 对应问题：[lihaokun/opencode#23](https://github.com/lihaokun/opencode/issues/23)
- 调研范围：现有 `task`/Subagent 能力及其管理面；不涉及实现

## 1. 背景与目标

现有 `task` 工具已经能够创建子 Session、以前台或后台方式运行 Subagent，并通过
`task_id` 恢复同一个子 Session。后台执行完成或失败后，结果会自动通知父 Session。

长时间多 Agent 编排仍缺少以下能力：

1. 无法可靠列出当前 Agent 树以及各 Agent 的状态；
2. 无法查询一个指定 Agent；
3. 除父 Agent 继续调用 `task(task_id=...)` 外，Agent 之间无法直接发送消息；
4. 无法通过模型工具主动停止不再需要或失控的 Agent；
5. `task_id` 实际标识的是可持续恢复的子 Session，名称却把 Agent 身份表达成了一次 Task。

本功能的目标是增加一个最小 Agent 管理面，使主 Agent 与 Subagent 能发现、查询、通信和停止
同一 Agent 树中的成员，同时复用现有 Session 与后台执行能力。

## 2. OpenCode 已有基础

| 已有能力 | 当前实现 | 可复用结论 |
|---|---|---|
| Agent 身份 | 每个 Subagent 都是带 `parentID` 的独立 Session | 直接使用 SessionID，不创建新的 Agent ID |
| 创建与恢复 | `task` 创建子 Session；`task_id` 可恢复原 Session | 保留同一 Session 的上下文和历史 |
| 后台生命周期 | `BackgroundJob` 已有 `start`、`extend`、`list`、`get`、`cancel` | 不需要新的公开 `run_id` 或另一套执行注册表 |
| Agent 树 | `Session.children(parentID)` 可读取持久化父子关系 | Agent roster 可由 Session 树恢复 |
| 消息执行 | TUI/HTTP 已能通过普通 Session 消息入口向指定 Session 发消息 | `agent_send` 直接复用同一入口，不经过 `task(task_id)` 或 `BackgroundJob.extend` |
| 完成通知 | 后台 Task 完成或失败后会自动向父 Session 注入结果 | 不恢复轮询式 `task_status(wait=...)` |

关键结论：缺口主要是公开管理面和 Agent 间消息路由，而不是缺少新的身份或执行模型。

## 3. Claude Code 对照

Claude Code 把可寻址、可恢复的执行者称为 Agent/Subagent：

- `Agent` 创建 Subagent；
- Agent roster 展示主 Agent 与 Subagent；
- `SendMessage` 可以给 Agent 追加指令；
- 向 idle/completed Agent 发送消息会恢复同一个 Agent；
- Named Subagent/teammate 可以与父 Agent 及其他 Agent 直接通信；
- `TaskStop` 可以停止后台 Agent，而不删除其既有上下文；
- 完成与失败消息自动送达，不需要 lead 主动轮询。

参考：

- [Claude Code Agent Teams](https://code.claude.com/docs/en/agent-teams)
- [Claude Code Subagents](https://code.claude.com/docs/en/sub-agents)
- [Claude Code Tools Reference](https://code.claude.com/docs/en/tools-reference)

Claude Code 另外提供共享 Task List 和跨独立 Session 消息。这两项不属于本次最小 Agent 管理面。

## 4. 方案比较

### 4.1 继续扩展 `task_*`

优点是沿用当前工具名。缺点是 `task_id` 实际标识长期存在的 Agent Session；当增加 roster、
Agent 间消息和恢复能力后，继续称为 Task 会混淆“执行者”和“工作项”。

结论：不采用为新接口的规范命名。

### 4.2 为每次执行增加 `run_id`

可以把一次执行与 Session 分开寻址，但当前需求只需要管理 Agent 当前的执行。现有
`BackgroundJob` 已经按子 SessionID 串行化同一 Agent 的执行；公开 `run_id` 会增加调用参数、状态转换和
错误使用方式，却不解决本次缺口。

结论：不采用。

### 4.3 统一为 Agent 管理面

把子 Session 视为可寻址 Agent，使用唯一的 `session_id`，并提供创建/恢复、列表、查询、消息和停止五项
能力。该方案与现有数据模型一致，也与 Claude Code 的核心 Agent 行为一致。

结论：推荐。

## 5. 推荐方案

公开工具固定为以下五个：

| 工具 | 职责 |
|---|---|
| `agent` | 创建新 Agent；恢复既有 Agent 由 `agent_send` 承担（见 §13） |
| `agent_list` | 列出同一 Agent 树中的主 Agent 与全部 Subagent |
| `agent_send` | 向同一 Agent 树中的任意 Agent 发送消息 |
| `agent_stop` | 停止调用者有权控制的 Agent 当前执行 |

### 5.1 身份

- 唯一公开标识为 `session_id`，其值就是现有 SessionID；
- 不增加 `task_id`、`agent_id`、`run_id` 的并行身份；
- Agent 的上下文、消息历史和父子关系继续存储在 Session 中；
- 一次执行只是 Agent 的内部运行状态，不是独立公开资源。

### 5.2 Agent 树

- 根 Session 是主 Agent；
- 带 `parentID` 的子 Session 是 Subagent；
- `agent_list` 返回调用者的邻居：父、子、兄弟，并标注关系（见 §14）；
- 不增加独立 `team_id`。

### 5.3 `agent_send`

- 可以用于主 Agent → Subagent、Subagent → 主/父 Agent，以及兄弟 Agent 之间的消息；
- 目标必须属于同一 Agent 树；
- `agent_send` 在消息正文开头添加由系统生成的发送者标识，然后调用与 TUI 相同的普通 Session 消息入口：

  ```text
  [Agent message from build (ses_abc123)]

  消息正文
  ```

- `session_id` 是发送者的权威身份，Agent 名称只用于可读性，调用方不能覆盖该前缀；
- 目标正在运行时，当前 provider turn 结束后，既有 runLoop 重读 Session 历史并处理新消息；
- 目标 idle 或已经结束当前执行时，普通 Session 消息入口自然启动新 run 并恢复原 Session；
- 调用只确认消息已接受，不等待目标完成，也不要求调用者轮询；
- 每次发送都是同一 Session 中的追加消息，不创建新的 Task、run 或独立结果承诺；
- Agent 处理完当前消息序列后只交付一个最终结果；中间 assistant 消息继续保存在 Session transcript 中；
- 工具名保持 `agent_send`。`agent_message_send` 信息重复，且不符合其余
  `agent_list/stop` 的 `<资源>_<动作>` 命名。

### 5.4 `agent_stop`

- 停止范围包含目标 Agent 及其后代的当前执行，顺序为从最深后代到目标 Agent 自底向上；
- 每个 Agent 进入 `cancelled` 后，通过现有父 Session 通知通道交付 `cancelled` 通知；若父 Agent 也在本次停止范围内，再继续取消父 Agent；
- 取消不删除任何 Session 或历史；
- 停止后仍可通过 `agent_send` 恢复；
- 重复停止是幂等操作；
- 停止目标限于调用者的直接子 Agent；不能停止父 Agent、主 Agent 或兄弟 Agent（见 §14）。停止一个子 Agent 会连带终止它的整棵后代，那是效果不是寻址范围；
- 工具动作名为 `agent_stop`，终态、通知状态和输出字段统一使用 `cancelled`，不增加 `stopped` 状态；
- 不使用 `run_id` 防御陈旧或重复调用。

### 5.5 查询与通知

- `agent_list` 返回 roster，每行自带该 Agent 的当前状态；不设独立的单 Agent 查询工具（理由见 §12）；
- 查询是即时快照，不提供 `wait`、timeout 或轮询模式；
- 完成、失败、取消均通过现有父 Session 自动通知通道交付；
- 状态必须区分当前确实在运行与 Session 存在但没有活动执行；准确状态枚举在架构阶段定义。

## 6. 范围边界

本次包含：

- 模型可调用的五个 Agent 工具；
- 同一 Agent 树内的 roster、查询、消息和停止；
- 复用 SessionID、Session 父子关系及现有后台执行机制；
- 保留上下文的停止与恢复。

本次不包含：

- Claude Code Agent Teams 的共享 Task List；
- 跨互不相关根 Session 的消息；
- 新的 `run_id`、`agent_id` 或 `team_id`；
- 阻塞等待、状态轮询或 `TaskOutput` 类工具；
- 进程崩溃后的自动继续执行；
- `mtime` 或不准确的 last-activity 心跳；
- V2 Session Core 改造；
- HTTP API、SDK、专用 TUI Agent panel。

## 7. 推荐结论

采用 Agent 作为唯一公开概念：

```text
Agent = 可寻址、可恢复、可通信的 Session
Execution = Agent 当前的内部执行状态
Message = 同一 Agent 树内的异步指令
Task = 工作描述，不再承担 Agent 身份
```

第一版只提供：

```text
agent
agent_list
agent_send
agent_stop
```

该方案直接覆盖 Issue #23 的 roster、查询、通信和停止缺口，并复用已有 Session 与
`BackgroundJob` 能力。调研确认后，下一步在架构文档中定义工具 schema、状态映射、消息交付顺序和权限边界。

## 8. `task` 兼容别名

新接口以 `agent` 为唯一规范名称，但可以保留现有 `task` 作为隐藏兼容别名：

- 模型工具列表只展示 `agent`，不同时展示语义重复的 `task`；
- 旧插件、权限配置或显式工具调用仍可使用 `task`，由同一实现转发；
- 兼容入口收到旧 `task_id` 时只把它规范化为 `session_id`，不建立第二套身份；
- 新工具输入、输出和文档统一使用 `session_id`；
- `task` 与 `agent` 不维护两套状态、执行路径或测试基准。

保留别名与恢复旧后台执行无关。OpenCode 进程重启后，进程内 `BackgroundJob` 已结束；持久化的子
Session 仍可列出，随后通过 `agent_send(session_id, message)` 启动新执行并恢复其历史。首版不尝试恢复旧
进程中的执行现场。

## 9. Claude Code 与 Codex 完整对照

本方案以 Claude Code 的 Agent 行为作为产品语义基线，同时确认其能力可以覆盖 Codex 的协作原语。工具数量
不要求逐项相同：当 Codex 把一项用户能力拆成多个底层动作时，本方案仍保持已确认的五工具表面。

| 能力 | 本方案 | Claude Code | Codex | 结论 |
|---|---|---|---|---|
| 创建 Agent | `agent` | `Agent` | `spawn_agent` | 对齐 |
| 恢复既有 Agent | `agent_send` | `SendMessage`（`Agent` 始终新建） | `followup_task` | 对齐；三方均由消息通道承担恢复 |
| 列出 Agent 树及状态 | `agent_list` | `ListAgents`（每行自带 busy/idle） | `list_agents` 提供树和状态 | 对齐；三方均由 roster 承载状态，均无单 Agent 查询工具 |
| 给运行中 Agent 发消息 | `agent_send` | `SendMessage` | `send_message` | 对齐 |
| 给 idle Agent 发消息并恢复 | `agent_send` | `SendMessage` 自动恢复 | `followup_task` | 功能覆盖，不额外拆工具 |
| 父子通信 | 同一 Agent 树内支持 | 支持 | 支持 | 对齐 |
| 兄弟通信 | 同一 Agent 树内支持 | Named Agent/teammate 支持 | 支持 | 对齐 |
| 停止当前执行 | `agent_stop` | `TaskStop` | `interrupt_agent` | 对齐；上下文保留 |
| 完成/失败/取消通知 | 自动送达 | 自动送达 lead | mailbox/update | 对齐 |
| 阻塞等待 | 不提供 | 自动投递为主 | `wait_agent` | OpenCode 已有自动通知，不增加等待工具 |
| 共享工作项列表 | 不提供 | Agent Teams 提供 | 非核心协作原语 | 明确非目标 |
| 跨无关根 Session 通信 | 不提供 | 新版 Claude Code 提供 | 限定当前 Agent 树 | 明确非目标 |

Codex 官方把消息排队与启动/恢复拆成 `send_message` 和 `followup_task`；Claude Code 的 `SendMessage` 则可以自然
恢复 idle/completed Agent。本方案选择 Claude Code 的产品语义，由一个 `agent_send` 覆盖两种目标状态，避免
为底层动作粒度增加新工具。

参考：

- [Claude Code Agent Teams](https://code.claude.com/docs/en/agent-teams)
- [Claude Code Subagents](https://code.claude.com/docs/en/sub-agents)
- [Claude Code Tools Reference](https://code.claude.com/docs/en/tools-reference)
- [OpenAI Docs: Multi-agent](https://developers.openai.com/api/docs/guides/responses-multi-agent)

## 10. OpenCode 上游提议覆盖

以下矩阵记录与本功能直接相关的 OpenCode 上游提议。这里的“覆盖”指五工具方案能够表达相应用户能力，不表示
一个新工具会自动修复既有生命周期 bug，也不把明确排除的 HTTP、SDK 或 TUI 表面偷偷带入首版。

| 需求簇 | 代表 issue / PR | 本方案对应 | 覆盖结论 |
|---|---|---|---|
| 后台 Agent roster 与状态 | [#41914](https://github.com/anomalyco/opencode/issues/41914)、[#37431](https://github.com/anomalyco/opencode/issues/37431)、[#39583](https://github.com/anomalyco/opencode/issues/39583)、[#36989](https://github.com/anomalyco/opencode/issues/36989) | `agent_list`（roster 自带状态） | 核心能力覆盖；slash command/sidebar 非首版 |
| 状态、输出与外部控制 API | [#36518](https://github.com/anomalyco/opencode/issues/36518)、[#41377](https://github.com/anomalyco/opencode/issues/41377) | `agent_list`、`agent_stop` | 模型工具核心覆盖；HTTP/SDK 与 optional-lane 专用控制非首版 |
| 实时进度和最后消息 | [#27898](https://github.com/anomalyco/opencode/issues/27898)、[#42368](https://github.com/anomalyco/opencode/issues/42368) | `agent_list` 即时快照 | 不提供流式预览，也不伪造 last-activity 心跳；最后消息由 session_id 直接读取历史获得 |
| 给子 Session 发送后续提示 | [#41667](https://github.com/anomalyco/opencode/issues/41667)、[#35728](https://github.com/anomalyco/opencode/issues/35728) | `agent_send` | 核心能力覆盖；专用 composer 非首版 |
| 运行中 steer/cancel/abort | [#38966](https://github.com/anomalyco/opencode/issues/38966)、[#42670](https://github.com/anomalyco/opencode/issues/42670)、[PR #32425](https://github.com/anomalyco/opencode/pull/32425)、[PR #34947](https://github.com/anomalyco/opencode/pull/34947) | `agent_send`、`agent_stop` | steering 与停止覆盖；不拆 soft-cancel/hard-abort 三套公开工具 |
| 取消后台 Subagent | [#36423](https://github.com/anomalyco/opencode/issues/36423) | `agent_stop` | 覆盖 |
| 停止后继续 | [#27511](https://github.com/anomalyco/opencode/issues/27511) | `agent_send` 恢复保留的 Session | 恢复能力覆盖；暂停原执行现场的 Suspend 保证非目标 |
| 兄弟 Agent 通信 | [#38964](https://github.com/anomalyco/opencode/issues/38964) | 同树任意方向的 `agent_send` | 覆盖 |
| 不同根 Session 通信 | [#38965](https://github.com/anomalyco/opencode/issues/38965) | 无 | 明确非目标 |
| Agent Teams 与命名消息 | [#12711](https://github.com/anomalyco/opencode/issues/12711)、[PR #12730](https://github.com/anomalyco/opencode/pull/12730) | 稳定 SessionID、Agent 树、消息 | 核心寻址和通信覆盖；共享 Task List、多模型团队和团队 TUI 非首版 |
| Persistent daemon push/pull | [#23775](https://github.com/anomalyco/opencode/issues/23775) | `agent_list`/`agent_send` 可表达 pull/push | 不提供常驻 daemon、工作区监听或崩溃恢复 |
| 既有后台管理实现提议 | [PR #15994](https://github.com/anomalyco/opencode/pull/15994)、[PR #40923](https://github.com/anomalyco/opencode/pull/40923)、[PR #34281](https://github.com/anomalyco/opencode/pull/34281) | 作为实现调研输入 | 不直接照搬额外 `task_status`/`agents_status` 工具 |
| Task 生命周期与取消正确性 | [#45480](https://github.com/anomalyco/opencode/issues/45480)、[PR #45482](https://github.com/anomalyco/opencode/pull/45482) | 管理面可以观察和停止 Agent | 只采纳通知、状态、停止和孤儿清理风险；不采纳“每条追加消息应有独立结果”的前提 |
| 完成通知与孤儿清理 | [#35066](https://github.com/anomalyco/opencode/issues/35066)、[#42286](https://github.com/anomalyco/opencode/issues/42286)、[#37314](https://github.com/anomalyco/opencode/issues/37314) | 自动通知、`agent_stop` 依赖底层正确性 | 属于实现前置与独立 bug，不增加公开工具 |

#45480 的第 5 项把两次 `task(task_id=...)` 调用视为两个需要分别关联结果的 Task。本方案不采用该产品前提：
第二次调用在 Agent 模型中只是向同一 Session 追加消息，`BackgroundJob` 保留该 Agent 消息序列处理完成后的
最新最终输出是正确行为。实现只需保证消息按 Session 时序持久化、不丢失，并在安全边界被消费；不增加
per-message output slot、correlation ID 或公开 `run_id`。

覆盖结论：

1. 五工具方案覆盖相关提议共同要求的创建/恢复、roster、查询、通信和停止五类核心能力；
2. HTTP/SDK、TUI、跨根 Session、共享 Task List、daemon、Suspend 和实时流式预览被明确记录为非目标，而非遗漏；
3. #45480 中的通知、停止和孤儿清理缺陷必须在实现阶段独立验证；其“每条消息独立结果”主张不属于本方案；
4. 上游 PR 作为实现参考，不改变本次已确认的公开工具集合。

## 11. 调研补充结论

补充对照不改变第 7 节推荐方案。首版规范表面仍然只有：

```text
agent
agent_list
agent_send
agent_stop
```

`task` 仅作为不向模型展示的兼容入口；Claude Code 是产品语义基线，Codex 用于验证能力完整性；OpenCode
上游提议矩阵用于确认覆盖与非目标边界，不用于扩张首版范围。

## 12. 修订：工具表面由五个收敛为四个（2026-09-05）

初版推荐 `agent` / `agent_list` / `agent_get` / `agent_send` / `agent_stop` 五个工具。架构阶段核对 Claude Code
实际工具集时发现 §9 对照表的「查询单个 Agent」一行不准确，据此撤销 `agent_get`。

### 事实修正

Claude Code 的 Agent 管理面实际只有四个模型可调用工具：`Agent`、`ListAgents`、`SendMessage`、`TaskStop`。
不存在"查询单个 Agent"的工具。

- §9 原先在该行的 Claude Code 列写的是「查看 Agent transcript/status」。那是**用户界面能力**——人可以打开某个
  Agent 的 transcript 查看——不是模型可调用的工具。填在工具对照列会读成 Claude Code 有对应工具。
- `ListAgents` 的每一行自带该 Agent 当前是 busy 还是 idle。**状态由 roster 承载，因此不需要第二个查询工具。**
- 最接近单项查询的 `TaskOutput` 已被 Claude Code 标记 DEPRECATED，替代方式是结果随工具返回值和完成通知
  自动送达。它按 `task_id` 寻址、`block=true` 阻塞等待、`block=false` 轮询状态——正是 §6 已排除的三样东西。

### 结论

`agent_get` 是 Claude Code 和 Codex 都没有的新增工具，而它要解决的需求（知道某个 Agent 现在是什么状态）
本就应当由 roster 承载。多一个工具只是把同一份信息换个形状再发一次。

首版规范表面因此为四个：

```text
agent
agent_list
agent_send
agent_stop
```

- 原 §1 缺口 2「无法查询一个指定 Agent」仍然成立，由 `agent_list` 的 roster 行满足，不再单列工具；
- §5.5 的「状态必须区分当前确实在运行与 Session 存在但没有活动执行」不变，落在 roster 的每一行上；
- 「最后消息」一类需求由调用方拿 `session_id` 直接读 Session 历史获得，不为此新增工具，也不提供流式预览。

本次修订只删工具、不加工具，其余章节的身份模型、消息语义、停止语义与非目标边界均不受影响。

## 13. 修订：恢复既有 Agent 统一由 `agent_send` 承担（2026-09-05）

初版 §5 给 `agent` 两个职责：创建新 Agent，或用既有 `session_id` 显式恢复。架构阶段写工具 schema 时
发现 `agent(session_id, prompt)` 与 `agent_send(session_id, message)` 是同一机制——都是向既有 Agent
追加一条 user message 并使其运行，差别只在意图叫法。

§9 原先把二者分列（对应 Codex 的 `followup_task` 与 `send_message`），但同一节已写明「本方案选择
Claude Code 的产品语义，由一个 `agent_send` 覆盖两种目标状态，避免为底层动作粒度增加新工具」。
两处自相矛盾，按后者裁定。

Claude Code 的 `Agent` 工具文档也明写：`SendMessage` 用于继续一个已存在的 Agent，**而一次新的
`Agent` 调用总是重新开始**。

### 结论

- `agent` 只负责创建，schema 不含 `session_id`；
- 恢复既有 Agent 一律经 `agent_send(session_id, message)`，目标 idle 时自然起新执行（§5.3 已有此语义）；
- 工具数量不变，仍是四个——本次去掉的是一个参数，不是一个工具。

```text
agent        创建
agent_list   roster
agent_send   消息；对 idle 目标即恢复
agent_stop   停止
```

与 Claude Code 的 `Agent` / `ListAgents` / `SendMessage` / `TaskStop` 逐项对应。

## 14. 修订：可见与可寻址范围收敛为邻居（2026-09-05）

初版 §5.2 让 `agent_list` 从调用者所在的**根 Session** 出发返回整棵 Agent 树，§5.4 允许停止任意**后代**。
架构阶段核对 Claude Code 后收敛为邻居模型。

### Claude Code 的实际范围

`ListAgents` 的第一句就是范围定义：

> Lists agents **you can SendMessage to** — **in-process subagents you spawned**, the teammates on your
> team, other local Claude sessions...

范围等于**可寻址集合**，subagent 一维是**自己派生的**，不是整棵树。`SendMessage` 的 `to` 佐证：
`"main"`（父方向，仅 background subagent 可用）、teammate 名（兄弟方向）、`ListAgents` 中的 agent
（自己派生的子）。合起来正是父 + 兄弟 + 子。

### 结论

- **可见**：`agent_list` 只返回父、子、兄弟，每行标注关系；调用者因此只持有这些 Agent 的 `session_id`；
- **可发**：`agent_send` 不做寻址校验，只要求目标 Session 存在且非自投递。范围由"调用者只从 roster
  拿得到邻居的 `session_id`"自然收敛，而非代码拦截——消息不转移权限，目标始终在它自己 Session 的
  权限下行动。§6「不包含跨互不相关根 Session 的消息」相应理解为**不主动提供跨树寻址能力**，
  而非在通道上强制阻断；
- **可停**：`agent_stop` 的目标限于直接子 Agent。停止会连带终止其整棵后代——那是**效果**，不是寻址范围，
  不需要能列出孙辈才能停子；
- 三者共用同一个邻居集合，**能看见什么就能发什么，能停的是其中的子集**，不存在"能操作但列不出来"的不对称。

### 嵌套深度

Claude Code 以环境变量 `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` 控制嵌套层数，**默认 3**（主会话之下三层），
设为 1 即关闭嵌套。OpenCode 的对应项是配置字段 `subagent_depth`，语义单位相同，当前默认 1（等于关闭嵌套）。
本 feature 将其默认值改为 **3**，与 Claude Code 一致。

触限时的行为一并对齐：Claude Code 在到限时**撤下工具**而非让调用失败。OpenCode 现状是调用时返回错误，
模型要先试一次、撞墙、再重新规划，白费一轮。改为到限时不再向该 Agent 提供相应工具，且撤下范围按
"寻址集合是否永久为空"判定：

| 工具 | 到限时 | 理由 |
|---|---|---|
| `agent` | 撤下 | 不能再派生 |
| `agent_stop` | 撤下 | 只能停子，而它永远不会有子 |
| `agent_send` | 保留 | 父与兄弟仍可寻址 |
| `agent_list` | 保留 | 父与兄弟仍可见 |

判据是**深度到限**，不是"当前没有子 Agent"——未到限但暂时无子的 Agent 必须保留 `agent_stop`，
否则工具会随派生忽隐忽现。

## 15. 扩充：subagent 的工作树隔离（2026-09-07）

> **[部分已废弃]** 本节的方向（软隔离入首版、强制隔离留 V2）成立，但落地细节有四处被 §16.10–§16.11 推翻：
> 生命周期表的**结算 / 恢复 / 停止 / Session 删除**四行（V1 改为完全不自动清理）、**环境文件**行
> （`.worktreeinclude` 移出首版，且它在 opencode 中并不存在）、**位置**行的忽略机制（改用 `info/exclude`
> 而非自我忽略 `.gitignore`）、以及「默认在自己的工作树里干活」这一强度措辞（改为建议式工作目录）。
> 「首版不做的四项」相应扩大。以 §16 为准。

初版范围没有提及工作树隔离，既未包含也未排除。本次把**软隔离**纳入首版，**强制隔离**记为
[lihaokun/opencode#33](https://github.com/lihaokun/opencode/issues/33) 待 V2 落地。

### 为什么现在要谈

本方案把 `subagent_depth` 默认由 1 提到 3、移除了子 Session 对 `agent` 工具的默认拒绝、并让执行恒为异步。
三者叠加使**多个 Agent 同时在同一份工作树上改文件**从边缘情况变成默认可能。不给隔离，等于本方案自己
制造了一个默认危险的配置。

### Claude Code 的做法

`isolation: worktree` 写在 subagent 定义的 frontmatter 里（也可按调用传）：subagent 得到一份从**默认分支**
切出的 worktree，**同进程、独立文件系统作用域**（原文：runs in a separate working directory, not a separate
process；uses the same Claude Code session but with an isolated filesystem scope）。命令层有主动检查：
Bash 的工作目录必须解析到 worktree 内、命令不得把 git 重定向回主 checkout、worktree 消失则命令失败。
无改动则自动清理。

### OpenCode 已有的零件

不需要改动文件系统解析即可拼出软隔离：

- 六个文件工具都接受**绝对路径**：`read` / `write` / `edit` / `lsp` / `glob` / `grep`；后两者还接受
  `path` 参数指定搜索根
- `shell` 有 `cwd` 参数
- `external_directory` 是**现成的强制点**：目标不在 instance 目录内即需过一次权限询问，`shell` 会扫描
  命令涉及的目录逐个询问
- `Worktree` 服务已具备 `create` / `list` / `remove` / `reset`，此前只在 experimental HTTP 与
  control-plane adapter 中使用，没有模型可调用的入口

### 首版采用：软隔离

- `agent` 默认为新 Agent 创建 worktree，初始 prompt 声明其工作目录的绝对路径
- 工作树建在主仓根下，`containsPath` 直接为真，因此**不需要任何权限放行**；越出项目的访问仍由
  `external_directory` 照常拦截
- `agent` 增加 `cwd` 参数：给出则使用该目录，不建 worktree
- ~~无改动则清理，对齐 Claude Code~~ **[已废弃 → §16.11]** V1 完全不自动清理

**强度边界要说清**：~~这是「默认在自己的工作树里干活」~~ **[措辞已废弃 → §16.11]**——运行时默认 cwd
并未切换，准确说法是「默认为 Agent 准备独立工作目录，并通过初始消息要求其显式在其中工作」。总之不是「关得进去出不来」。子 Agent 仍可用主
checkout 的绝对路径操作——主 checkout 在 instance 目录**之内**，`external_directory` 按设计放行；
它防的是出界，不是串门。

### 工作树生命周期

| 时机 | 行为 |
|---|---|
| 位置 | **主仓根下平铺**：`<主 checkout>/.opencode/worktrees/<slug>`，对齐 Claude Code 的「at your repository root」。项目内使 `containsPath` 为真，无需权限放行；平铺而非嵌套，否则父清理自己的工作树时会连同嵌在其中的子工作树一并删除；根目录写入内容为 `*` 的 `.gitignore` 自我忽略，否则 ripgrep 会搜出每个工作树里的副本 |
| 创建 | 未给 `cwd` 时建 worktree，**从当前 HEAD 切**。opencode 的 `Worktree.create` 已是此行为（`git worktree add --no-checkout -b <slug> <dir>`，不给 start-point 即 HEAD）。Claude Code 默认从远端默认分支切，但其文档指出子 Agent 需在进行中的工作上操作时应改用 `head`——我们的场景正是后者 |
| 嵌套 | 孙 Agent 从其父 subagent 的 HEAD 切，工作自然叠加 |
| 归属标记 | 复用 project 的 sandbox 列表：`Worktree.create` 已调用 `project.addSandbox(projectID, directory)`，记录的正是 opencode 自建的工作树。无需新增 schema，也不依赖路径形状 |
| 环境文件 | 新 worktree 是干净 checkout，`.env` 一类 gitignored 文件不存在。按 Claude Code 的 `.worktreeinclude`（gitignore 语法）复制「匹配模式且确被 gitignore」的文件，否则相当多真实项目里子 Agent 开箱跑不起来 |
| 结算 | 无改动则移除并清空 Session 的目录绑定；有改动则保留 |
| 恢复 | 目录仍在则直接用；目录不在且曾在 sandbox 列表中则**重建**；用户经 `cwd` 指定的目录不在则报错不重建 |
| 停止 | 同结算规则。取消通常留下部分改动，落入「有改动」而保留 |
| Session 删除 | 递归删除子 Session 时一并移除自建工作树 |

**恢复时重建与 Claude Code 相反，因为情形不同**：我们只移除过**无改动**的树，重建等价、不丢任何东西；
Claude Code 不重建面对的是**用户删除**的树，那可能含有工作，重建会掩盖丢失。

### 首版不做的四项

1. **周期性 sweep** —— 有改动的工作树会累积，需用户手动清理
2. **运行中加锁** —— Claude Code 会 `git worktree lock` 防并发清理；首版没有并发清理者（同一 Agent 至多
   一个执行），故不加
3. **崩溃后的孤儿回收**
4. **强制隔离**（见下节与 #33）

### 强制隔离为何不在首版

强制需要「本 Session 的文件系统根是 X」在工具层可判定。V1 没有这根轴：文件工具解析路径用 instance 级
目录，而 `InstanceState` 本身以目录为 cache key——换目录等于换到另一份 instance 分片，
`SessionRunState` / `SessionStatus` / `BackgroundJob` 全部换一份，`agent_list` 与 `agent_stop` 随之失效。

在 V1 上做强制隔离要先把「文件系统根」与「instance 状态分片键」解耦，属地基改造，且与 V2 正在建的
Location 作用域重复。详见 #33。

## 16. 修订：消息语义、实例名与工作树落地校正（2026-09-09）

本节记录第二轮设计评审后的决策。与 §12–§15 冲突处以本节为准；被推翻的部分在原节就地标注。
所有涉及代码的结论都在 `dev` 上逐条核实过，行号随文给出。

### 16.1 `agent_send` 是消息，不是调用

这是本轮最大的语义简化。此前设计让每条 `agent_send` 都拥有一次"最终结局"——注册 watcher、
建 BackgroundJob、承诺一次结果投递。取消。

- `agent_send` 不自动回复、不承诺返回结果、不建 BackgroundJob、不注册 watcher；
- 调用方只收到 `accepted`；
- 接收方自主决定是否回复，需要回复时再调一次 `agent_send`；
- 实现直接走普通 Session 异步入口 `POST /session/{id}/prompt_async`。

**只有 `agent` 的初始委托保留自动结果**：初始委托跑完后向创建者投递一次 completed/error，
复用 `task.ts` 现有的 `runTask` 分类与 `notify`/`inject` 通道。初始执行期间收到的 `agent_send`
只是追加消息，仍由该初始执行最终交付那一次结果。

这条不对称要明说：**`agent` 自动回结果，`agent_send` 永不回**。与 Claude Code 的 `SendMessage` 也
构成差异——CC 的云会话例外条款（"cannot message any session back yet — read its answer in its own
transcript"）反证了常规 `SendMessage` 会带回复。两条都记入架构 §9 差异表。

### 16.2 V1 的"安全 turn 边界"确实存在，就是循环头

此前对这个说法有过质疑。核实后可以精确表述。`session/prompt.ts:1090-1106`：

```ts
while (true) {
  let msgs = yield* MessageV2.filterCompactedEffect(sessionID)      // 每轮重读
  const { user: lastUser, assistant: lastAssistant } = MessageV2.latest(msgs)
  const lastAssistantBelongsToLatestTurn = lastAssistant !== undefined &&
    (lastAssistant.parentID === lastUser.id || MessageV2.compareChronology(lastUser, lastAssistant) < 0)
```

新 user 消息插入后，下一轮 `lastUser` 变为它，旧 assistant 既非其子也在其之前，
`lastAssistantBelongsToLatestTurn` 为假，退出条件全部不成立，循环继续处理新消息。
**边界即循环头，也就是两个 provider turn 之间。**目标 running / idle 两种状态都交给
`prompt_async` 与现有 Runner，Agent 管理层不手工判断状态来启动执行。

### 16.3 发消息必须显式携带目标的 agent / model / variant

`session/prompt.ts:636-690` 三层都验过：

```ts
const ag = agentName ? yield* agents.get(agentName) : yield* agents.defaultInfo()
const model = input.model ?? ag.model ?? (yield* currentModel(input.sessionID))
...
if (current.agent !== info.agent || current.model?.providerID !== info.model.providerID || ...) {
  yield* sessions.setAgentModel({ sessionID, agent: info.agent, model: { ... } })   // 落库
}
```

- 不传 `agent` ⇒ 切到默认 agent；
- 只传 `agent` ⇒ agent 定义的 model 压过 session 当前 model；
- 且结果**持久化写回 session 行**。

所以不能像 FSM 给主 Session 发通知那样只传 parts，否则子 Agent 的身份会被改掉并存下来。
`agent_send` 必须显式取目标 Session 当前的 agent / model / variant；`setAgentModel` 存的是
`variant ?? "default"`，回传时 `"default"` 必须省略，否则来回一趟会把 variant 钉死。

### 16.4 消息投递不保证送达（issue #32）

`effect/runner.ts:115-119` 的 `ensureRunning` 在目标已 Running 时**丢弃新 work**，
`finishRun`（`:70-81`）落 Idle 前**不检查这期间是否有新消息到达**。时序：

```
循环读 msgs（无新消息） → 消息落库 → ensureRunning 见 Running 丢弃 work
  → 循环按陈旧 msgs 退出 → Idle → 消息无人处理
```

静默、无界、无人被通知。这是既有缺陷，影响 FSM 通知、普通异步消息等**所有**调用方，
不由本方案引入，记为 [lihaokun/opencode#32](https://github.com/lihaokun/opencode/issues/32)。

**本方案不为它造绕行方案**（M6 因此删除，见 16.5），也**不依赖它被修复**。
修复与本 feature 并行推进：修法在 `effect/runner.ts` 内部加 `pendingWake` 标志位，
参照 V2 `core/src/session/run-coordinator.ts` 的 `settle`，签名不变、文件不重叠，两边可独立落地。

连带的口径修正：**取消通知与完成通知都是"投递一次，送达不保证"，不是不变量。**
此前把"父必然收到取消通知"写成保证是不成立的。

### 16.5 删除通用执行层 M6

按 16.1，"每条消息都有一次执行结局"的前提不再成立，M6 AgentExecution 整体删除：
`ensure(target)`、通用 `watch(target)`、`noticeDelivered` Map/Deferred、`cancelAndAwaitNotice`、
"M6 是所有 Agent 执行的唯一注册者/通知生产者"这两条不变量、以及每条消息的 `ExecutionOutcome`。

保留并复用的只有 `agent` 初始委托那一条：`BackgroundJob.start`、`runTask` 的完成/失败分类、
结束后向创建者通知一次。可以留一个很小的内部 `startAgent` 供规范 `agent` 与隐藏 `task` 别名共用，
但不重新引入通用 Session executor。

### 16.6 `agent_stop` 的状态判定不能依赖 BackgroundJob

被 `agent_send` 经 `prompt_async` 恢复的 Agent 可能正在运行却没有新的 BackgroundJob。
统一改用与 `agent_list` 相同的事实来源 `SessionStatus`。

必须**先读状态再取消**，因为 `session/run-state.ts:77-86`：

```ts
const cancel = (sessionID) => {
  yield* cancelBackgroundJobs(background, sessionID)
  const existing = data.runners.get(sessionID)
  if (!existing) { yield* status.set(sessionID, { type: "idle" }); return }   // idle 时成功空操作
  yield* existing.cancel
}
```

`cancel` 分不出"本来在跑、现已取消"与"本来就 idle"。据此按层汇总
`transitioned` / `unchanged` / `failed`，且**不给 idle / unchanged 成员发虚假的 cancelled 通知**，
重复 stop 对 idle 成员无效果。

### 16.7 可选实例名取代类型名寻址

`agent` 增加可选参数 `name?: string`：

- 可省略；省略时该 Agent 只能用 `session_id` 寻址；
- 提供时在整棵 Agent 树内唯一，创建后不可修改，不得以 SessionID 前缀 `ses` 开头；
- running / idle / cancelled / completed 都继续占用，Session 删除后才释放；
- 重名返回 `AgentNameConflict{name}` 并**零副作用**：不建 Session、不建 workspace、不投递 prompt，
  也不返回既有 Agent 的 session_id；
- 存入 `Session.Info.metadata.agentName`，不动 `Session.Info.agent`（后者是 agent 类型）。

三者的关系：

```
name       = auth-reviewer     可选实例名（可寻址）
agent_type = explore           Agent 定义类型（仅供阅读）
session_id = ses_abc123        权威身份（始终可寻址）
```

`agent_send` / `agent_stop` 的 `target` 接受 session_id 或 `agentName`，**名称只匹配 `agentName`，
不匹配 `subagent_type`**。零匹配 → `TargetNotResolved`；多匹配意味着唯一性不变量已损坏 → 拒绝。

**推翻 2026-09-08 曾采纳的"类型名 + latest wins"。**当时的依据之一"Claude Code 是 latest wins"
是错的：CC 文档只说"Append a row's `[ref]` only when the bare name is not enough — two rows share it,
or an error asks you to disambiguate"，即用 `[ref]` 消歧或直接报错，没有静默择一。而静默择一意味着
**消息发给了错的 Agent 且无人知晓**。

改用实例名而非"类型名 + 歧义报错"的理由：扇出是 subagent 的主用法，同类型多实例是设计目标场景，
类型名恰好在那时不可用；且消息前缀里三个 `explore` 无法区分来源。CC 的名字即 `subagent_type`，
是因为 CC 预期用户在 `.claude/agents/*.md` 里为具体任务定义具体类型；把它做成一等参数方向一致。

**唯一性机制**：不需要 schema 迁移。范围是一棵 Agent 树（至多数十个 Session），线性扫即可；
并发在同进程内用内存 reservation：检查与占位之间不 await 就无交错，进程重启后按需重扫重建。
这样 §16.7 的"多匹配 = 不变量已损坏"才是真正的不可能状态，而非 best-effort 检查的正常输出。

### 16.8 `task` 权限配置的一次性规范化

旧 `task` 权限配置不能静默忽略——`task: deny` 升级后变成允许即是权限放宽。采用配置读取时规范化：

```
legacy task permission config → canonical agent permission config → 运行时只判 agent
```

schema 暂时同时接受 `task` 与 `agent`，`task` 标注 deprecated 并输出一次迁移 warning 不报错；
先转换旧 `task` 规则，再覆盖显式 `agent` 规则，同 pattern 冲突时 `agent` 胜；
隐藏的 `task` 工具别名转发同一实现并使用规范化后的 `agent` 权限，不能成为绕过。

这条之所以够用，是因为 `session/tools.ts:87` 的合并顺序是
`Permission.merge(agent.permission, session.permission ?? [])`，**用户配置进的是
`agent.permission`，它每次运行都从 config 重新派生**，规范化一次即无陈旧副本残留。

**持久化 Session 的 `task` 规则不作运行时映射。**系统生成的 `task: * deny` 与用户意图的同名规则
形状完全相同（都是 `{task, *, deny}`）无法区分；但根 Session 的 `permission` 默认为 `undefined`，
配置里的 deny 并不进入 session ruleset，只有经 CLI/SDK 显式设过 session 权限再派生子 Agent 才会出现。
暴露面窄，记为已知限制一句，不为它改设计。

### 16.9 `deriveSubagentSessionPermission` 必须改（此前漏记）

`agent/subagent-permissions.ts` 给每个子 Session 追加：

```ts
const canTask = input.subagent.permission.some((rule) => rule.permission === "task")
...(canTask ? [] : [{ permission: "task", pattern: "*", action: "deny" }]),
```

而 `permission/index.ts:28` 的 `evaluate` 用 **`findLast`**，合并顺序 `(agent.permission, session.permission)`，
即**session ruleset 压过 agent 定义**。在 16.8 的"运行时只判 `agent`"下两条移植路径都是坏的：

- 仍发字面 `task`：规范化后 agent 定义带的是 `agent`，`canTask` 恒为 false，每个子仍被追加
  `task: * deny`；该规则在 `agent` 键的运行时下是死的 ⇒ 嵌套永远放行，**agent 定义级的 opt-out 静默失效**；
- 移植成 `agent: * deny`：session 压过 agent 定义 ⇒ 每个子都被拒绝 `agent`，**深度 3 一次都跑不起来**。

正确改法：**嵌套上限不再由权限系统承担，改由深度计数 + 工具可见性承担。**故
`canTask` 改查 `agent` 键，且**不再默认追加 `agent` deny**；`todowrite` 那条不动。
删掉默认 deny 不等于静默放行——无匹配时兜底是 `ask`（`permission/index.ts:34`），
再由 `agent` 的默认 `*: allow` 接住。

这是独立于 `task.ts` `childToolDenies` 的**第二个拒绝点**，此前两轮设计都漏了。

### 16.10 工作树：三处落地校正

**（一）`Worktree.create()` 返回时工作树是空的。**`worktree/index.ts:281-292`：

```ts
const createFromInfo = (info, startCommand) => {
  yield* setup(info)                                    // git worktree add --no-checkout ← 无文件
  yield* boot(info, startCommand).pipe(..., Effect.forkIn(scope))   // git reset --hard ← 异步
}
```

真正的 checkout 在 `boot` 里，而 `boot` 是 fork 的。"建工作树 → 启动 Agent"会让子 Agent
**每次都在空目录里开工**。Agent 专用入口必须满足 **ready 契约**：返回时目录存在且 tracked files
完整可读；checkout 失败 ⇒ `WorktreeUnavailable`，不启动 Agent。

**（二）位置必须在项目内，而且这是被迫的。**opencode 现有 worktree 建在
`Global.Path.data/worktree/<projectID>`（`worktree/index.ts` `makeWorktreeInfo`），即**项目之外**。
它之所以不需要 `external_directory`，是因为**现有 worktree 是独立 instance**——在里面开 Session 时
`ctx.directory` 就是它。而子 Agent **不换 instance**（§16.11），于是：

| worktree 位置 | 不换 instance 时 |
|---|---|
| 全局数据目录 | `containsPath` 假 ⇒ 每次文件访问都弹 `external_directory`，不可用 |
| 项目内 `.opencode/worktrees/` | `containsPath` 真 ⇒ 直接可用 |

`project/instance-context.ts:18-24` 的 `containsPath` 只查 `ctx.directory` 与 `ctx.worktree`，
**不查 sandbox**，所以 `setup()` 里那句 `project.addSandbox` 帮不上忙。
**不换 instance ⇒ 必须放项目内**，这条因果链要写进设计，同时记明这与 opencode 自身的 worktree
位置约定不同及其原因。

**（三）忽略机制改用 `info/exclude`，不写 `.gitignore`。**`snapshot/index.ts:186-193` 已有先例：

```ts
git(["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], { cwd: state.worktree })
```

`.git/info/exclude` 是仓库本地、从不提交、不出现在 `git status`；snapshot 的 `sync` 读回既有内容再追加，
故我们写入的条目不会被冲掉；它在 common dir，`--git-path` 从任何 linked worktree 解析过去都是同一个
文件，一条 `/.opencode/worktrees` 即可覆盖主 checkout 与全部子工作树；ripgrep 默认尊重它
（`--no-ignore-vcs` 才关闭），满足"`glob`/`grep` 不搜出各工作树副本"的要求。

此前设计的"在工作树根写内容为 `*` 的自我忽略 `.gitignore`"作废——那是往用户仓库工作树里造文件。
（`config/config.ts:309` 的 `ensureGitignore` 证明"自我忽略目录"这一惯例存在，但其内容写死且仅在
文件不存在时写，不能直接复用。）

### 16.11 工作树隔离强度：建议式，不是强制

首版不切换 per-Session `InstanceState`：`Session.Info.directory` 保持真实 instance 执行目录，
文件工具相对路径与 shell 默认 cwd 仍按 instance directory 解析。已核实：
`tool/read.ts:236` 是 `path.resolve(instance.directory, filepath)`，
`tool/shell.ts:612-613` 是 `params.workdir ? resolvePath(...) : instanceCtx.directory`。

因此为 Agent 准备的路径**只是建议工作目录**：初始 prompt 必须要求 Agent 使用绝对路径、shell 显式传
`workdir`；只有 Agent 遵守约定时 workspace 才能减少并行文件冲突。**不声称 Agent 无法访问或修改主
checkout。**真正的 per-Session 默认 cwd 与强制隔离留待 V2 Location / issue #33。

此前"默认在自己的工作树里干活"的措辞作废，改为：
> 默认为 Agent 准备独立工作目录，并通过初始消息要求 Agent 显式在其中工作；运行时默认 cwd 未切换。

**`.worktreeinclude` 移出首版。**它在 opencode 中**并不存在**（全仓仅出现在本设计文档里，
是从 Claude Code 搬来的概念），落地要从零写 gitignore 语法匹配器并逐个 `git check-ignore` 确认，
是一个子系统而非一行分支。首版让 Agent 按需从主 checkout 用绝对路径读取——软隔离本就允许。

**非 Git 项目同样是净新增**：`makeWorktreeInfo` 对非 git 直接返回 `NotGitError`、`list()` 返回 `[]`，
现有代码完全走不到。首版在同一管理根下建普通空目录，不自动复制项目文件，初始消息同时给出
source directory 与空 workspace directory，由 Agent 自主决定复制什么，不自动同步或合并回 source。

**V1 不自动清理**：completed / error / cancelled 都不删目录，Session 删除不连带删除，
不做无改动检测、运行锁、周期 sweep 或清理后重建。"workspace 会累积"是明确的 V1 已知限制。
因此 V1 也不需要用 project sandbox 列表推断 Session 所有权。

### 16.12 深度提到 3 的连带项：TUI 必须聚合整棵后代

`tui/src/routes/session/index.tsx:208-213` 的 `children()` 按
`x.parentID === parentID || x.id === parentID` 过滤，**只有一层**；
`:229-235` 的 `permissions()` / `questions()` 对任何带 `parentID` 的 Session 直接 `return []`。

深度为 1 时两者恰好等价。提到 3 之后，P → A → B 中 B 的 permission/question
**在根视图看不到、在 A 的视图也不显示**，该 Agent 永久挂起。

这不是"已知缺口"，是**深度改动的必要连带修改**：根 Agent 收集自身 + 全部后代，聚合 pending
permission/question，回复按 `request.sessionID` 路由到实际后代。必须有三层回归：
P → A → B，B 请求权限，P 的 TUI 显示，用户回复到达 B。不是新面板。
