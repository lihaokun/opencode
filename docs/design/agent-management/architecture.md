# 架构设计 — agent-management

- 状态：架构阶段，等待确认
- 工具表面：四个（调研 §12 撤销 `agent_get`；§13 把恢复统一交给 `agent_send`）
- 日期：2026-09-04
- 对应问题：[lihaokun/opencode#23](https://github.com/lihaokun/opencode/issues/23)
- 上游依据：`docs/research/agent-management-research.md`（调研阶段已确认）
- 代码基线：`dev` @ `a4293ca229`

## 1. 范围与目标

调研 §1 列出五条缺口，本架构按 G1–G5 编号承接：

| 编号 | 目标 | 调研出处 |
|---|---|---|
| G1 | 可靠列出当前 Agent 树及各成员状态 | §1 缺口 1 |
| G2 | 查询指定 Agent 的身份、关系与状态 | §1 缺口 2；由 roster 行承载，不单列工具（调研 §12） |
| G3 | 邻居（父 / 子 / 兄弟）间任意方向的直接消息 | §1 缺口 3；范围见调研 §14 |
| G4 | 主动停止不再需要或失控的 Agent，保留上下文 | §1 缺口 4 |
| G5 | 身份统一为可寻址、可恢复的 Session，消除 `task_id` 的语义错位 | §1 缺口 5 |

非目标沿用调研 §6，不在此重复。本文档额外承担调研甩给架构阶段的四笔欠账：工具 schema（本文档 §4.6）、状态枚举（本文档 §3 `AgentStatus`）、停止级联与终止通知契约（本文档 §4.4，对应调研 §5.4）、消息交付顺序（本文档 §4.3，对应调研 §5.3）。

## 2. 核心流程

四个工具共用一条骨架：**解析目标 → 权限判定 → 执行 → 渲染**。差异只在第三步。

```
模型
 └─ M5 AgentTools（唯一对模型暴露的表面）
     ├─ 解析：M1 AgentTree     ← Session store 的 parentID 链
     ├─ 权限：M1 AgentTree     ← 邻居判定 / 直接子判定
     └─ 执行：
         agent           → M4 AgentLifecycle.create → M3 AgentInbox.deliver
         agent_list      → M1 AgentTree.tree      + M2 AgentStatusProjection.of
         agent_send      → M3 AgentInbox.deliver
         agent_stop      → M4 AgentLifecycle.stop → 逐层 M3 AgentInbox.deliver
```

三条值得单独展开的路径：

**消息投递（G3）**：`agent_send` 把发送者标识拼进正文首行，然后以**目标 Session 自己的身份**调用普通 Session 消息入口。目标正在运行时，`ensureRunning` 命中 Running 分支，消息成为该 run 下一个 provider turn 的输入（`runLoop` 每轮从数据库重读历史）；目标空闲时同一入口自然起新 run。两种情况下调用方都只拿到"已接受"，不等待目标完成。

**停止（G4）**：`agent_stop` 先由 M1 解出目标子树并按深度分层，然后**自底向上**逐层：取消该层 → 等待该层的终止通知交付到各自父 Agent → 再取消上一层。目标本身最后取消，它的终止通知交给树外的父 Agent。

**状态投影（G1/G2）**：只读 `SessionStatus`——busy 或 retry 即 `running`，否则 `idle`。roster 不表达执行结局，结局由既有通知通道在结束时送达等待方。

## 3. 核心数据结构

均为跨模块共享类型。本 feature 未启用 product 层（无跨 feature 共享契约），按 §2.4 写在本节。

```
数据结构：AgentStatus

字段：
  - value: "running" | "idle" — Agent 此刻是否有活动执行

类型不变量：
  - 取值封闭于上述两个字面量
  - 二者互斥且穷尽

语义：
  - running    进程内存在该 Session 的活动执行（SessionStatus 为 busy 或 retry）
  - idle       无活动执行

不表达终态：执行的结局（完成 / 失败 / 取消）不进入本枚举，由既有父 Session 自动通知通道
  交付（调研 §5.5）。roster 只回答"此刻还在跑吗"，不重复通知已经送达过的结论。

跨模块共享性：跨模块共享 — consumer: M2 AgentStatusProjection（产出）、M5 AgentTools（渲染）
```

```
数据结构：AgentInfo

字段：
  - session_id: SessionID — Agent 的唯一公开标识，即现有 SessionID
  - parent_id: SessionID | undefined — 父 Agent；undefined 表示该 Agent 是树根（主 Agent）
  - agent: string — 该 Session 绑定的 agent 定义名（Session.Info.agent）
  - title: string — Session 标题，供人读
  - status: AgentStatus — 见上
  - depth: NonNegativeInt — 相对树根的深度，根为 0
  - relation: "self" | "parent" | "child" | "sibling" — 相对查询发起者的关系（调研 §14）
  - time_created: number — Session 创建时间（epoch ms）

类型不变量：
  - depth == 0 ⟺ parent_id == undefined
  - 同一棵树内 session_id 唯一

唯一性 / 标识：
  - session_id 全局唯一，且是本 feature 唯一的公开标识（调研 §5.1）

生命周期：
  - 创建：由 M4 AgentLifecycle.create 在创建子 Session 时产生
  - 修改：status 为投影值，不落库；其余字段随 Session 变化
  - 删除：本 feature 不删除 Session；Agent 停止后 AgentInfo 仍可查

跨模块共享性：跨模块共享 — consumer: M1 AgentTree（产出骨架）、M2（填 status）、M5（渲染）
```

```
数据结构：AgentNeighborhood

字段：
  - caller: SessionID — 发起查询的 Agent
  - members: AgentInfo[] — 调用者的邻居，含调用者自身

类型不变量：
  - caller ∈ members.map(session_id)
  - ∀ m ∈ members, m.relation ∈ {self, parent, child, sibling}，且恰有一个成员 relation == self
  - 邻居集合的定义：
      parent  = caller.parent_id 对应的 Agent（caller 为主 Agent 时不存在）
      child   = parent_id == caller 的全部 Agent
      sibling = parent_id == caller.parent_id 且 ≠ caller 的全部 Agent（caller 为主 Agent 时为空）
  - 不含祖父、孙、叔伯、侄、堂兄弟等任何非邻居成员（调研 §14）
  - members 按 (relation, time_created) 升序，保证输出稳定

跨模块共享性：跨模块共享 — consumer: M1（产出）、M5（渲染 roster）
```

```
数据结构：AgentMessage

字段：
  - target: SessionID — 接收方
  - sender: SessionID — 发送方，由系统填写
  - sender_agent: string — 发送方的 agent 名，仅供可读
  - body: string — 调用方提供的正文

类型不变量：
  - sender ≠ target（不允许自投递）
  - target ∈ sender 的 AgentNeighborhood（父 / 子 / 兄弟之一）
  - 落库文本 = 系统前缀 + "\n\n" + body，前缀格式固定为
    `[Agent message from <sender_agent> (<sender>)]`
  - 调用方无法覆盖或伪造前缀（调研 §5.3）

生命周期：
  - 创建：M3 AgentInbox.deliver 构造
  - 修改：不可变
  - 删除：不单独删除；随 Session 历史存续

跨模块共享性：跨模块共享 — consumer: M3（产出并投递）、M4（停止时复用同一投递语义）
```

```
数据结构：Accepted

字段：
  - target: SessionID — 消息已被写入的目标 Agent

类型不变量：
  - 该值存在 ⇒ 对应 AgentMessage 已持久化进 target 的 Session（见 §7 I2）
  - 不携带目标的执行结果，也不表示目标已开始或已完成处理

跨模块共享性：跨模块共享 — consumer: M3 AgentInbox（产出）、M4 AgentLifecycle（依赖它排序）、M5 AgentTools（渲染）
```

```
数据结构：StopOutcome

字段：
  - stopped: SessionID[] — 本次停止实际处理的成员，按 StopPlan.layers 的处理顺序排列
  - notified: SessionID[] — 收到终止通知的父 Agent；停止集内的父不在其中
  - failed: { session_id: SessionID, reason: string }[] — 未能完成停止的成员及原因

类型不变量：
  - stopped ∪ failed.map(session_id) = ⋃ StopPlan.layers
  - failed 非空 ⇒ M5 必须把它显式呈现给调用方，不得静默丢弃（见 §5 M5→M4 接口协议）

跨模块共享性：跨模块共享 — consumer: M4 AgentLifecycle（产出）、M5 AgentTools（渲染）
```

```
数据结构：StopPlan

字段：
  - target: SessionID — 停止的子树根
  - layers: SessionID[][] — 按深度分层的成员，layers[0] 为最深层，末层为 target 自身
  - notify_boundary: SessionID — target 的父 Agent，即发起停止者；恒非空，且恒不在停止集内

类型不变量：
  - ⋃ layers = target 的后代闭包 ∪ {target}
  - ∀ i < j，layers[i] 中成员的 depth > layers[j] 中成员的 depth（自底向上）
  - layers 末元素恰为 [target]
  - notify_boundary ∉ ⋃ layers（因 target 必是发起者的直接子，其父即发起者）

跨模块共享性：模块私有 — 仅 M4 AgentLifecycle 使用；列在此处是因为它承载 §7 的 I1 不变量
```

## 4. 模块划分与功能规约

五个模块。M1–M4 是机制，M5 是唯一对模型暴露的表面。

### 4.1 M1 AgentTree

```
模块名称：AgentTree

功能描述：解析调用者的邻居集合（父 / 子 / 兄弟）与直接子集合，并承担邻居 / 直接子两类寻址判定；
  另提供后代闭包供 M4 的停止级联使用——那是效果范围，不是寻址范围。

前置条件（Requires）：
  - 入参 session_id 对应的 Session 在 store 中存在
  - Session 的 parentID 链无环（由 Session 创建路径保证，见 §7 H2）

后置条件（Ensures）：
  - neighborhood(id) 返回的 AgentNeighborhood 满足其类型不变量
  - children(id) 返回 parent_id == id 的全部 Agent
  - descendants(id) 返回 id 的全部后代，不含 id 自身；仅供 M4 展开停止级联
  - isNeighbor(caller, target) ⟺ target ∈ neighborhood(caller).members 且 target ≠ caller
  - isChild(caller, target) ⟺ target ∈ children(caller)

不变式（Invariants）：
  - 解析过程只读 Session store，不改变任何 Session 状态

副作用：无
```

### 4.2 M2 AgentStatusProjection

```
模块名称：AgentStatusProjection

功能描述：把进程内执行状态投影为对外的 AgentStatus。

前置条件（Requires）：
  - 入参 session_id 对应的 Session 存在

后置条件（Ensures）：
  - SessionStatus.get(id).type ∈ {busy, retry} ⇒ 结果为 running
  - 否则 ⇒ 结果为 idle
  - 结果为即时快照，不提供 wait / timeout / 轮询（调研 §5.5）

不变式（Invariants）：
  - 投影只读，不写 SessionStatus，也不写消息

副作用：无
```

**为什么状态只有两值**：调研 §5.5 只要求区分"当前确实在运行"与"Session 存在但没有活动执行"，这正好是两个值。执行的结局早已通过既有通知通道送达等待方，roster 再复述一遍是冗余；Claude Code 的 `ListAgents` 同样只给 busy / idle。由此本模块不读 `BackgroundJob`，也不从消息历史反推终态，投影只有一个来源。

### 4.3 M3 AgentInbox

```
模块名称：AgentInbox

功能描述：构造带系统发送者前缀的消息，以目标 Session 自身的身份写入并唤醒目标。

前置条件（Requires）：
  - message 满足 AgentMessage 的全部类型不变量
  - 目标 Session 存在

后置条件（Ensures）：
  - 返回前，消息已作为 user message 持久化进目标 Session
  - 消息携带的 agent / model 取自目标 Session，不取自调用者
  - 目标此刻 running ⇒ 消息在其当前 run 的下一个 provider turn 进入上下文，不新起 run
  - 目标此刻非 running ⇒ 起一个新 run 消费该消息
  - 调用方不阻塞等待目标完成，返回值只表示"已接受"

不变式（Invariants）：
  - I4（见 §7）：一个 Agent 处理完当前消息序列后只交付一个最终结果，不为单条消息建立结果承诺；
    中间 assistant 消息留在 transcript

副作用：写入目标 Session 一条 user message；可能启动目标 Session 的一次 run
```

**身份取自目标而非调用者**：消息落进目标 Session 后，目标 `runLoop` 每一轮都从最新 user message 重新解析 agent 与 model，且解析结果会写回 Session。若透传调用者的选择，一条消息会把目标换成发送者的 agent 和模型并持久化。发送者身份由正文前缀承载即可，不进入执行参数（调研 §5.3「Agent 名称只用于可读性」）。

### 4.4 M4 AgentLifecycle

```
模块名称：AgentLifecycle

功能描述：创建 Agent；停止目标 Agent 及其后代的当前执行，并保证终止通知在父 Agent 被取消之前送达。恢复既有 Agent 不经本模块，由 M3 承担（调研 §13）。

前置条件（Requires）：
  - create: 目标 agent 定义存在；未超过 subagent 深度上限
  - stop: 调用方已通过 M1 的权限判定；target 存在

后置条件（Ensures）：
  - create 总是新建一个以调用者为 parentID 的子 Session，不复用既有 Session
  - stop 终止 ⋃ StopPlan.layers 中每个成员的当前执行
  - stop 不删除任何 Session、消息或历史
  - stop 后目标仍可经 agent_send 恢复
  - stop 幂等：对已无活动执行的目标重复调用不产生额外效果，也不报错
  - 对 layers 的处理自底向上：处理 layers[i] 前，layers[0..i-1] 的终止通知均已交付
  - notify_boundary 非空时，target 的终止通知交付给它

不变式（Invariants）：
  - I1（见 §7）：任一被停止 Agent 的终止通知交付，发生在其父 Agent 被取消之前

副作用：中断目标子树的执行 fiber；向每个被停 Agent 的父 Session 写入一条终止通知消息
```

**为什么必须自底向上**：终止通知复用 M3 的投递语义，而 M3 对非 running 目标会起新 run。若自顶向下取消，子 Agent 的通知会投递给一个刚被停掉的父 Agent 并把它重新唤醒——等于停止操作自己复活了它要停的东西。自底向上使每条通知投递时其接收方仍在运行，命中"加入当前 run"分支。

**为什么终止通知必须存在**：取消不能静默结束。通知与完成、失败走同一条通道，是一条普通消息，
正常唤醒接收方（调研 §5.4）。接收方分两类：

- **发起停止的 Agent**（即 target 的父，因为 target 必是它的直接子）。它虽然知道自己下了命令，
  但通知在它的 transcript 里留下记录，且它此刻在运行，消息加入当前 run，无副作用。
- **级联中每个被停 Agent 的父**。这些父自己也在停止集内，它们同样会被取消。

**为什么必须自底向上**：理由是防复活，不是"有第三方在等"。终止通知复用 M3 的投递语义，
而 M3 对非 running 目标会起新 run。级联中孙的取消通知要投给子，若自顶向下取消，子已经停了，
这条通知会把它重新唤醒——停止操作自己复活了它要停的东西。自底向上使每条通知投递时接收方仍在运行，
命中"加入当前 run"分支。

该场景要求 Agent 树至少三层，因此本架构把 `subagent_depth` 的默认值提到 3（见 §6）。

### 4.5 M5 AgentTools

```
模块名称：AgentTools

功能描述：四个模型可调用工具的参数 schema（见 §4.6）、权限门与输出渲染；本 feature 唯一对模型暴露的表面。

前置条件（Requires）：
  - 调用发生在某个 Session 的工具执行上下文中，调用者 SessionID 可知

后置条件（Ensures）：
  - 对模型暴露且仅暴露 agent / agent_list / agent_send / agent_stop（调研 §12）
  - 保留隐藏兼容入口 task：不进模型工具列表，收到旧 task_id 时规范化为 session_id 后转发给同一实现，不建立第二条执行路径（调研 §8）
  - 所有工具的目标参数名为 session_id，不出现 task_id / agent_id / run_id
  - agent_send 在目标不是调用者的邻居时失败，不产生副作用
  - agent_stop 在目标不是调用者的直接子时失败，不产生副作用
  - 调用者深度已达 subagent_depth 上限时，不向其提供 agent 与 agent_stop；agent_list 与 agent_send 仍提供
    （判据是深度到限，不是当前是否有子 Agent，否则工具会随派生忽隐忽现）
  - 输出为即时快照，不提供 wait / timeout / 轮询
  - 用户权限确认（ctx.ask）只在 agent 上进行，沿用既有 task 工具的行为，pattern 取 subagent_type；
    agent_list / agent_send / agent_stop 不弹确认——列举只读，消息与停止都发生在调用者已有权限
    派生出的 Agent 之间，逐次确认会让多 Agent 编排无法使用

不变式（Invariants）：
  - 权限判定先于任何副作用；判定失败的调用不写入任何消息、不中断任何执行

副作用：委托给 M1–M4；本模块自身不直接操作 Session
```

**权限的不对称**：`agent_send` 可发给任一邻居（父、子、兄弟），`agent_stop` 只能停直接子。理由是两者的破坏性不同——投递一条消息由接收方自行决定如何处理，接收方保有主动权；停止则单方面中断对方的执行，允许子 Agent 停止父或兄弟会让编排失去可预测的控制方向。停止的**效果**仍级联到目标的整棵后代，但那不扩大寻址范围：孙辈是连带结果，不是可选目标（调研 §14）。

### 4.6 工具 schema

调研 §7 要求架构阶段定义工具 schema。四个工具的参数如下；所有目标参数一律名为 `session_id`。

```
工具：agent
  description:    string    — 3-5 词的任务简述，用于 roster 与 UI
  prompt:         string    — 交给该 Agent 的任务正文
  subagent_type:  string    — agent 定义名
（无 background 参数：Agent 恒为异步执行，调用立即返回 AgentInfo，
  结局经既有通知通道送达。前台模式与本 feature 不兼容，见 §6）
（无 session_id 参数：一次 agent 调用总是新建；恢复既有 Agent 用 agent_send，见调研 §13）
返回：AgentInfo

工具：agent_list
  （无参数；范围恒为调用者的邻居：父、子、兄弟）
返回：AgentNeighborhood.members，每行含 relation 与 status

工具：agent_send
  session_id:     string    — 目标，须是调用者的邻居
  message:        string    — 正文；系统前缀由 M3 添加，调用方不可覆盖
返回：Accepted

工具：agent_stop
  session_id:     string    — 目标，须是调用者的直接子；停止会连带其整棵后代
返回：StopOutcome
```

## 5. 模块间接口规约

```
接口：M5 AgentTools → M1 AgentTree

输入数据：caller: SessionID，target: SessionID | undefined
输出数据：AgentNeighborhood（neighborhood）/ AgentInfo[]（children、descendants）/ boolean（isNeighbor、isChild）

协议约定：
  - 调用方责任：caller 取自工具执行上下文，不接受模型提供的值
  - 被调用方责任：目标不存在或不是邻居时返回明确的否定结果，不抛出未分类异常
```

```
接口：M5 AgentTools → M2 AgentStatusProjection

输入数据：session_id: SessionID
输出数据：AgentStatus

协议约定：
  - 调用方责任：仅对已通过邻居判定的成员请求状态
  - 被调用方责任：结果是调用瞬间的快照；不保证与后续任何一次调用一致
```

```
接口：M5 AgentTools → M3 AgentInbox

输入数据：AgentMessage
输出数据：Accepted { target: SessionID }

协议约定：
  - 调用方责任：sender 由系统填写；body 为模型提供的正文；邻居判定已通过
  - 被调用方责任：返回 Accepted 时消息已持久化；不得在持久化前返回
```

```
接口：M4 AgentLifecycle → M3 AgentInbox

输入数据：AgentMessage（body 为终止通知文本，sender 为被停止的 Agent）
输出数据：Accepted

协议约定：
  - 调用方责任：仅在该层全部成员已取消后投递；投递目标为被停 Agent 的父
  - 被调用方责任：与 §5 第三条接口相同——返回即已持久化，M4 依赖这一点来排序（见 §7 I1）
```

```
接口：M5 AgentTools → M4 AgentLifecycle

输入数据：caller: SessionID，target: SessionID（stop）/ 创建参数（create）
输出数据：AgentInfo（create）/ StopOutcome（stop）

协议约定：
  - 调用方责任：后代判定已通过（stop）
  - 被调用方责任：stop 返回时 StopPlan 全部层已处理完毕；部分失败必须显式报告，不得静默
```

## 6. 关键设计决策

| 决策 | 理由 |
|---|---|
| 唯一公开标识用 `session_id` | 调研 §4.2 已否决 `run_id`；Agent 的上下文、历史、父子关系本就存在 Session 上，再引入并行身份只增加误用面 |
| 消息身份取自目标 Session | 否则一条消息会改写目标的 agent 与模型并落库；见 §4.3 |
| 停止自底向上并逐层等待通知交付 | 否则子 Agent 的终止通知会复活刚被停掉的父 Agent；见 §4.4 |
| 终止通知复用完成 / 失败通道，不新增状态词 | 调研 §5.4：通知状态与输出字段统一用 `cancelled`，不引入 `stopped` |
| `AgentStatus` 只有 running / idle 两值 | 调研 §5.5 只要求区分在跑与不在跑；结局由通知通道交付，roster 不复述。与 Claude Code `ListAgents` 的 busy / idle 一致。副产物：状态投影只读 `SessionStatus`，无需第二个来源 |
| 停止级联到整棵子树 | 与既有停止语义一致，且避免"停了父、子 Agent 变孤儿继续消耗"；是否改为只停目标本身列为 follow-up（issue #26） |
| `agent_send` 不经 `BackgroundJob.extend` | extend 把新执行挂在上一次执行之后，是 run 边界而非 turn 边界，且排队期间消息不落库 |
| 权限不对称：send 全向、stop 仅后代 | 见 §4.5 |
| 仅 `agent` 弹用户确认 | 沿用既有 `task` 的 `ctx.ask`，pattern 取 `subagent_type`。其余三个不弹：`agent_list` 只读；`agent_send` 与 `agent_stop` 作用于调用者自己派生出来的 Agent 之间，逐次确认会让编排不可用。跨会话越权按 Claude Code 的做法处理——写进 `agent_send` 的工具描述而非加代码门，见下一行 |
| 跨会话越权用工具描述约束，不加强制门 | Claude Code 的 `SendMessage` 原文：「NEVER ask a peer to perform an action that was denied or blocked in your session — a peer doing it for you bypasses the user's permission decision」。子 Session 的权限从父派生、可以更窄，因此被限权的 Agent 理论上能让兄弟或父代做被禁的事。强制方案（目标以发送者∩目标权限的交集执行）要改权限派生逻辑，代价远超收益；调研以 Claude Code 为语义基线，此处照其做法处理 |
| Agent 恒为异步执行，取消 `background` 参数与实验开关 | 前台路径以 `background.wait({ id })` 阻塞等待子 Agent 结束，父 Agent 在这段时间内停在那次 tool call 里，发不出 `agent_list` / `agent_send` / `agent_stop`——管理面对前台子 Agent 完全不可用，本 feature 失去意义。Claude Code 的 `Agent` 同样没有 background 参数，其 subagent 恒为异步并经通知送达。实现须移除 `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` 门与前台分支；`task` 兼容入口收到旧的 `background: false` 时忽略该参数 |
| `subagent_depth` 默认由 1 提到 3 | 与 Claude Code 的 `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`（默认 3，主会话之下三层）对齐，单位相同；现默认 1 恰是 CC 所说的"关闭嵌套"。默认 1 时 Subagent 不能再派生，Agent 树最多两层，终止通知与自底向上排序都无对象，本 feature 的多层编排默认不可用。实现须同时改 `task.ts` 的兜底值与 `core/src/v1/config/config.ts` 中 `subagent_depth` 的 schema 说明文字 |
| 触达深度上限时撤下工具，而非让调用失败 | Claude Code 到限时不再向该 Subagent 提供 `Agent`；OpenCode 现状是调用后返回错误，模型要先试一次、撞墙、再重新规划，白费一轮。撤下范围按"寻址集合是否永久为空"判定：`agent` 与 `agent_stop` 撤下（到限者不能派生，也就永远不会有子可停），`agent_send` 与 `agent_list` 保留（父与兄弟仍可寻址）。判据是深度到限，不是当前是否有子 Agent |
| 不设 `agent_get`，状态并入 roster 每一行 | Claude Code 只有 `ListAgents` 且每行自带 busy/idle，无单 Agent 查询工具；其最接近的 `TaskOutput` 已废弃且按 task_id 寻址、阻塞等待、轮询状态，三者均为调研 §6 排除项。多一个工具只是把同一份信息换个形状再发一次。详见调研 §12 |
| 保留隐藏的 `task` 兼容入口 | 调研 §8：旧插件、权限配置与显式调用仍需可用，但不进模型工具列表；入口只把 `task_id` 规范化为 `session_id` 后转发同一实现，不维护第二套状态、执行路径或测试基准 |
| 一个 Agent 任一时刻至多一个活动执行 | 调研 §7 的概念定义（`Execution = Agent 当前的内部执行状态`，单数）。这是 `session_id` 足以作唯一标识的前提：允许并行执行则 `agent_stop(session_id)` 无法指明停哪一个，`run_id` 必然回归，调研 §4.2 的否决随之失效。机制由 I3 维护 |
| 消息不是 call，不承诺 per-message 结果 | 一个 Agent 处理完当前消息序列后只交付一个最终结果，而非每条消息各配一个。上游 #45480 第 5 项的相反前提（每次调用应有独立结果）已被调研 §10 否决。由此不引入 correlation ID、per-message output 槽或 `run_id`。机制由 I4 维护 |

## 7. 架构正确性论证

### goal → 模块映射

```
G1 「列出 Agent 树及状态」   → M1 AgentTree（主）+ M2 AgentStatusProjection（辅）+ M5（渲染）
G2 「查询指定 Agent」        → 与 G1 同路径：M1（主）+ M2（辅）+ M5（渲染）；
                               调用方从 roster 中按 session_id 取行，不单列工具
G3 「邻居间任意方向消息」    → M3 AgentInbox（主）+ M1（邻居判定）
G4 「停止并保留上下文」      → M4 AgentLifecycle（主）+ M3（终止通知）+ M1（直接子判定 + 后代展开）
G5 「身份统一」              → M5 AgentTools（表面约束）+ M1（身份解析）
```

### 模块协作论证

**G1/G2**：G1 要求"可靠列出可寻址的 Agent 与其状态"。M1 的后置条件保证 AgentNeighborhood 覆盖父 / 子 / 兄弟三类且有稳定序，即可寻址集合完整；M2 的后置条件保证每个成员得到 running / idle 之一且二者互斥穷尽。二者拼接即"完整成员集合 × 明确状态"，故 G1 成立。G2 是 G1 在单成员上的投影，同理成立。

**G3**：G3 要求"邻居间任意方向的消息能被目标处理"。M1 的 `isNeighbor` 保证方向合法性判定完备；M3 的后置条件分两种目标状态给出了处理保证——running 时进入当前 run 的下一个 provider turn，非 running 时起新 run 消费。两种状态覆盖了 AgentStatus 的全部取值（running 与 idle 互斥且穷尽），故任意目标状态下消息都会被处理，G3 成立。

**G4**：G4 要求"停止且保留上下文，且等待方不被静默挂起"。M4 的后置条件给出前半部分（终止执行、不删除任何 Session 与历史、可恢复、幂等）。后半部分由 I1 保证：每个被停 Agent 的父都会收到终止通知，除非该父自己也在停止集内——那种情况下它同样被停止，不存在"仍在等待"的主体。故不存在被静默挂起的等待方，G4 成立。

**G5**：G5 是表面约束而非运行时行为。M5 的后置条件直接规定了对模型暴露的工具集合与参数命名，M1 保证所有解析都以 SessionID 为输入，二者合起来即"不存在第二套身份"，G5 成立。

### 关键假设

本段只列本架构**控制不了**的外部前提。属于本 feature 自身概念定义或设计取舍的性质归 §6 决策，
由本架构维护的性质归下方模块级 invariant，已知不成立的性质归 §9 已知缺口。

```
H1: running 是进程内真相。SessionStatus 存于 InstanceState，进程重启后清空。
    因此崩溃前正在执行的 Agent 重启后一律投影为 idle。
    — 来源：既有基础设施；调研 §6「不包含进程崩溃后的自动继续执行」，本架构不提供崩溃恢复，
      故不修复该退化。重启后进程内所有执行本就已经终止，idle 与事实一致，
      失真的只是"它当初是怎么结束的"，而那条信息在结束时已由通知通道送达过

H2: Session 的 parentID 链无环且深度有限。
    — 来源：子 Session 只在创建时绑定 parentID 且此后不变；深度另有上限约束
```

外部前提只有这两条。以下三条曾被误列为假设，现已归位：

| 原编号 | 内容 | 归位 |
|---|---|---|
| 旧 H2 | 至多一个活动执行 | §6 决策（概念定义）+ I3（机制维护） |
| 旧 H4 | 终止通知接收方仍在运行 | I1 的推论，不再单列 |
| 旧 H5 | 只交付一个最终结果 | §6 决策（否决 per-message 结果）+ I4（机制维护） |
| 旧 H6 | 拆解期间不会派生新成员 | §9 已知缺口（本架构未做保证） |

### 模块级 invariant

```
I1: 停止排序不变量
    对任意被停止的 Agent a，若 a 的父 p 也在本次停止集内，
    则「a 的终止通知已持久化」happens-before「p 被取消」。
    （p 不在停止集内时 p 恒为发起停止者，它全程在运行，无排序要求。）
    维护方：M4 AgentLifecycle 排序 / M3 AgentInbox 提供"返回即已持久化"的保证
    preservation：M4 按 StopPlan.layers 自底向上推进，处理第 i 层前必须已收到第 0..i-1 层
      全部通知投递的 Accepted 返回。M3 的接口协议规定 Accepted 意味着已落库，
      因此排序是结构性的，不依赖调度时序。

I2: 接受即持久化
    M3 返回 Accepted ⇒ 该消息已写入目标 Session。
    维护方：M3 AgentInbox
    preservation：M3 在持久化之后才返回；后续的唤醒动作即使失败也不回滚已写入的消息。
      由此 agent_stop 无法吞掉一条已被接受的消息——停止只终止执行，不改写历史。

I3: 单活动执行
    ∀ Agent a，任一时刻 a 至多有一个活动执行。
    维护方：本 feature 的概念定义（见 §6）；机制由既有 Session 运行状态机提供，本架构复用不重实现
    preservation：既有运行状态机对每个 Session 持单值状态，第二次运行请求加入已有执行而不并行开新的；
      M3 对 running 目标不新起 run，而是让消息加入现有执行；M4 的取消以 Session 为单位。
      本不变量塌陷的代价是回到 run_id（见 §6），故实现阶段须有回归钉住该机制。

I4: 单一最终结果
    ∀ Agent a，a 处理完当前消息序列后只向等待方交付一个最终结果，而非每条输入消息各一个。
    维护方：M3 AgentInbox（不为单条消息建立结果承诺）；机制由既有单 output 槽语义提供
    preservation：M3 的投递只向目标追加 user message，不注册任何 per-message 的完成回调；
      既有后台执行对每个 Agent 只保留最新一次最终输出，并在无待处理执行时才结算完成信号。
      中间 assistant 消息不因此丢失，它们留在 Session transcript 中可按 session_id 读取。
```

## 8. 并发规约

```
并发单元：M4 AgentLifecycle.stop

共享资源：
  - Session 运行状态注册表：SessionID → 活动执行句柄
  - 后台执行注册表：SessionID → 执行记录（进程内）
  - 目标子树各 Session 的消息历史（持久化）

顺序约束（Ordering Constraints）：
  - deliver(a 的终止通知) must happen-before cancel(parent(a))，当 parent(a) ∉ 停止集
  - cancel(layers[i]) must happen-before cancel(layers[i+1])
  - 同一层内的取消可并发，层与层之间串行

Rely-Guarantee 条件：
  - Rely（环境承诺）：停止期间不会有外部调用对同一子树发起第二次 stop
    （幂等性使重复 stop 无害，但并发的两次 stop 不保证层序交错后的通知顺序）
  - Guarantee（自身承诺）：stop 只中断执行，不删除 Session、消息或历史；
    不向停止集内的 Agent 投递会使其重新运行的消息

线程安全性结论：
  - M4.stop 在 Rely 成立时安全。并发的同子树 stop 属于已知未覆盖场景，
    首版通过工具层不做并发去重来暴露它，而不是静默容忍
```

```
并发单元：M3 AgentInbox.deliver

共享资源：
  - 目标 Session 的消息历史
  - 目标 Session 的运行状态

顺序约束：
  - 消息持久化 must happen-before 唤醒动作
  - 两条并发 deliver 到同一目标的相对顺序由消息写入顺序决定，不做额外保证

Rely-Guarantee 条件：
  - Rely：目标的 runLoop 每个 provider turn 开始时重读消息历史
  - Guarantee：deliver 不修改目标 Session 的 agent 与 model 绑定

线程安全性结论：
  - 安全。两条并发消息可能以任意顺序进入同一个 turn 的上下文，
    这与两个人同时向一个会话打字的既有语义一致，不引入新的竞态类别
```

## 9. 与 Claude Code 的有意差异

工具集合逐项对应 Claude Code（`Agent` / `ListAgents` / `SendMessage` / `TaskStop`），但两处语义有意不同，
不应被读成处处对齐：

| 项 | Claude Code | 本方案 | 理由 |
|---|---|---|---|
| 停止范围 | `TaskStop` 按 id 停一个后台任务，文档未述子树级联 | 级联整棵子树，自底向上 | 防止停掉父之后子 Agent 变孤儿继续消耗（#37314）；备选方案见 issue #26 |
| roster 范围 | `ListAgents` 跨 in-process subagent、teammate、本机其他会话、云端会话 | 仅调用者所在的一棵 Agent 树 | 调研 §6 明确排除跨互不相关根 Session 的通信与编排 |

## 10. 已知缺口

以下三项在本架构中显式存在，不被本架构修复，实现阶段须单独核对：

1. **拆解期间新派生的后代不在停止集内**。既有子树展开按一次快照进行，快照之后派生的后代不在停止集内。
2. **停止后代时的执行现场不可恢复**。停止保留 Session 与历史，但不保留中断点；恢复是从历史继续，不是从断点续跑。调研 §6 已将 Suspend 语义列为非目标。
3. **崩溃后 running 退化为 idle**（H1）。本架构不提供崩溃恢复。
4. **移除前台分支会波及既有测试**。前台路径当前承载着子 Agent 错误如何呈现给父 Agent 的一批断言（CLI run 相关用例走的就是这条路）。恒为异步后这些用例的观察点从 tool 返回值移到通知消息，实现阶段须逐条迁移而非删除。

## 11. 下一阶段

架构确认后进入 §4.3 细化阶段，产出 `docs/design/agent-management/detailed-design.md`，需满足 §4.3.1 完整性 6 条与 §4.3.2 函数正确性论证。届时按 §2.3 步骤 2 为契约变更分配 subplan-id，feature 短称取 `agm`。
