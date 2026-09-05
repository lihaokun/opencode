# Agent 管理能力调研

- 状态：调研阶段已确认（2026-09-04）；2026-09-05 两次修订工具表面，见 §12、§13
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
- `agent_list` 从调用者所在的根 Session 出发，返回同一棵 Agent 树；
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
- 主 Agent 可以停止其后代；Subagent 只能停止自己的后代，不能停止父 Agent、主 Agent 或兄弟 Agent；
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
