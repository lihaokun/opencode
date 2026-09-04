# 架构设计 — agent-management

- 状态：架构阶段，等待确认
- 工具表面：四个（调研 §12 已撤销 `agent_get`）
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
| G3 | 同一 Agent 树内任意方向的直接消息 | §1 缺口 3 |
| G4 | 主动停止不再需要或失控的 Agent，保留上下文 | §1 缺口 4 |
| G5 | 身份统一为可寻址、可恢复的 Session，消除 `task_id` 的语义错位 | §1 缺口 5 |

非目标沿用调研 §6，不在此重复。本文档额外承担调研明确甩给架构阶段的三笔欠账：状态枚举（§4.1）、停止级联与终止通知契约（§5.4 / §6.4）、消息交付顺序（§5.3 / §6.3）。

## 2. 核心流程

四个工具共用一条骨架：**解析目标 → 权限判定 → 执行 → 渲染**。差异只在第三步。

```
模型
 └─ M5 AgentTools（唯一对模型暴露的表面）
     ├─ 解析：M1 AgentTree     ← Session store 的 parentID 链
     ├─ 权限：M1 AgentTree     ← 同树判定 / 后代判定
     └─ 执行：
         agent           → M4 AgentLifecycle.createOrAdopt → M3 AgentInbox.deliver
         agent_list      → M1 AgentTree.tree      + M2 AgentStatusProjection.of
         agent_send      → M3 AgentInbox.deliver
         agent_stop      → M4 AgentLifecycle.stop → 逐层 M3 AgentInbox.deliver
```

三条值得单独展开的路径：

**消息投递（G3）**：`agent_send` 把发送者标识拼进正文首行，然后以**目标 Session 自己的身份**调用普通 Session 消息入口。目标正在运行时，`ensureRunning` 命中 Running 分支，消息成为该 run 下一个 provider turn 的输入（`runLoop` 每轮从数据库重读历史）；目标空闲时同一入口自然起新 run。两种情况下调用方都只拿到"已接受"，不等待目标完成。

**停止（G4）**：`agent_stop` 先由 M1 解出目标子树并按深度分层，然后**自底向上**逐层：取消该层 → 等待该层的终止通知交付到各自父 Agent → 再取消上一层。目标本身最后取消，它的终止通知交给树外的父 Agent。

**状态投影（G1/G2）**：进程内活动执行以 `SessionStatus` 为准；无活动执行时，从 Session 最后一条 assistant 消息的持久化字段推导终态。这样进程重启后仍能区分"正常结束"与"失败/被停止"。

## 3. 核心数据结构

均为跨模块共享类型。本 feature 未启用 product 层（无跨 feature 共享契约），按 §2.4 写在本节。

```
数据结构：AgentStatus

字段：
  - value: "running" | "idle" | "failed" | "cancelled" — Agent 当前的对外状态

类型不变量：
  - 取值封闭于上述四个字面量，不引入 "stopped"（调研 §5.4 已定：终态统一用 cancelled）
  - running 与其余三值互斥：running 表示"此刻确有活动执行"，其余三值均表示"无活动执行"

语义：
  - running    进程内存在该 Session 的活动执行（SessionStatus 为 busy 或 retry）
  - idle       无活动执行，且最近一次执行正常结束，或该 Session 从未执行过
  - failed     无活动执行，且最近一次执行以错误结束
  - cancelled  无活动执行，且最近一次执行被停止

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
  - time_created: number — Session 创建时间（epoch ms）

类型不变量：
  - depth == 0 ⟺ parent_id == undefined
  - 同一棵树内 session_id 唯一

唯一性 / 标识：
  - session_id 全局唯一，且是本 feature 唯一的公开标识（调研 §5.1）

生命周期：
  - 创建：由 M4 AgentLifecycle.createOrAdopt 在创建子 Session 时产生
  - 修改：status 为投影值，不落库；其余字段随 Session 变化
  - 删除：本 feature 不删除 Session；Agent 停止后 AgentInfo 仍可查

跨模块共享性：跨模块共享 — consumer: M1 AgentTree（产出骨架）、M2（填 status）、M5（渲染）
```

```
数据结构：AgentTreeView

字段：
  - root: SessionID — 调用者所在树的根 Session
  - members: AgentInfo[] — 树内全部成员，含 root 自身
  - caller: SessionID — 发起查询的 Agent

类型不变量：
  - caller ∈ members.map(session_id)
  - ∀ m ∈ members, m.parent_id == undefined ∨ m.parent_id ∈ members.map(session_id)
    （树是自封闭的：除根外每个成员的父都在集合内）
  - members 按 (depth, time_created) 升序，保证输出稳定

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
  - sender 与 target 属于同一棵 AgentTreeView
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
数据结构：StopPlan

字段：
  - target: SessionID — 停止的子树根
  - layers: SessionID[][] — 按深度分层的成员，layers[0] 为最深层，末层为 target 自身
  - notify_boundary: SessionID | undefined — target 的父 Agent；不在停止集内时非空

类型不变量：
  - ⋃ layers = target 的后代闭包 ∪ {target}
  - ∀ i < j，layers[i] 中成员的 depth > layers[j] 中成员的 depth（自底向上）
  - layers 末元素恰为 [target]
  - notify_boundary ∉ ⋃ layers

跨模块共享性：模块私有 — 仅 M4 AgentLifecycle 使用；列在此处是因为它承载 §7 的 I1 不变量
```

## 4. 模块划分与功能规约

五个模块。M1–M4 是机制，M5 是唯一对模型暴露的表面。

### 4.1 M1 AgentTree

```
模块名称：AgentTree

功能描述：从任一 SessionID 解析出所属 Agent 树、祖先链与后代闭包，并承担同树 / 后代两类权限判定。

前置条件（Requires）：
  - 入参 session_id 对应的 Session 在 store 中存在
  - Session 的 parentID 链无环（由 Session 创建路径保证，见 §7 H2）

后置条件（Ensures）：
  - tree(id) 返回的 AgentTreeView 满足其类型不变量（自封闭、稳定序）
  - descendants(id) 返回 id 的全部后代，不含 id 自身，不含任何祖先或兄弟
  - isSameTree(a, b) ⟺ root(a) == root(b)
  - isDescendant(a, b) ⟺ a ∈ descendants(b)

不变式（Invariants）：
  - 解析过程只读 Session store，不改变任何 Session 状态

副作用：无
```

### 4.2 M2 AgentStatusProjection

```
模块名称：AgentStatusProjection

功能描述：把进程内执行状态与 Session 的持久化终态合成为对外的 AgentStatus。

前置条件（Requires）：
  - 入参 session_id 对应的 Session 存在

后置条件（Ensures）：
  - SessionStatus.get(id).type ∈ {busy, retry} ⇒ 结果为 running
  - 否则取该 Session 最后一条 assistant 消息 m：
      m 不存在                              ⇒ idle
      m.error.name == "MessageAbortedError" ⇒ cancelled
      m.error 存在（其余任何 name）          ⇒ failed
      以上皆否                              ⇒ idle
  - 结果为即时快照，不提供 wait / timeout / 轮询（调研 §5.5）

不变式（Invariants）：
  - 投影只读，不写 SessionStatus，也不写消息

副作用：无
```

**为什么终态取自 assistant 消息而非 `BackgroundJob`**：`BackgroundJob` 是进程内注册表，重启即失。assistant 消息的 `error` / `finish` 是持久化字段。调研 §8 要求"进程重启后持久化的子 Session 仍可列出"，若终态依赖 `BackgroundJob`，重启后 `failed` 与 `cancelled` 会退化成 `idle`，roster 的状态列随之失去意义。代价是 `running` 仍然是进程内真相，见 §7 H1。

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

功能描述：创建或恢复 Agent；停止目标 Agent 及其后代的当前执行，并保证终止通知在父 Agent 被取消之前送达。

前置条件（Requires）：
  - createOrAdopt: 目标 agent 定义存在；未超过 subagent 深度上限
  - stop: 调用方已通过 M1 的权限判定；target 存在

后置条件（Ensures）：
  - createOrAdopt(session_id 已给定) 恢复同一 Session，保留其上下文与历史
  - createOrAdopt(未给 session_id) 创建以调用者为 parentID 的新子 Session
  - stop 终止 ⋃ StopPlan.layers 中每个成员的当前执行
  - stop 不删除任何 Session、消息或历史
  - stop 后目标仍可经 agent 或 agent_send 恢复
  - stop 幂等：对已无活动执行的目标重复调用不产生额外效果，也不报错
  - 对 layers 的处理自底向上：处理 layers[i] 前，layers[0..i-1] 的终止通知均已交付
  - notify_boundary 非空时，target 的终止通知交付给它

不变式（Invariants）：
  - I1（见 §7）：任一被停止 Agent 的终止通知交付，发生在其父 Agent 被取消之前

副作用：中断目标子树的执行 fiber；向每个被停 Agent 的父 Session 写入一条终止通知消息
```

**为什么必须自底向上**：终止通知复用 M3 的投递语义，而 M3 对非 running 目标会起新 run。若自顶向下取消，子 Agent 的通知会投递给一个刚被停掉的父 Agent 并把它重新唤醒——等于停止操作自己复活了它要停的东西。自底向上使每条通知投递时其接收方仍在运行，命中"加入当前 run"分支。

**为什么终止通知必须存在**：调研 §5.4 授权主 Agent 停止其后代。停掉一个孙 Agent 时，当初以后台方式启动它、此刻仍在运行的中间 Subagent 正等待自动通知；不发通知它将永远等待，而工具描述又要求它不要轮询。通知与完成、失败走同一条通道，是一条普通消息，正常唤醒接收方（调研 §5.4）。

### 4.5 M5 AgentTools

```
模块名称：AgentTools

功能描述：五个模型可调用工具的参数 schema、权限门与输出渲染；本 feature 唯一对模型暴露的表面。

前置条件（Requires）：
  - 调用发生在某个 Session 的工具执行上下文中，调用者 SessionID 可知

后置条件（Ensures）：
  - 对模型暴露且仅暴露 agent / agent_list / agent_send / agent_stop（调研 §12）
  - 保留隐藏兼容入口 task：不进模型工具列表，收到旧 task_id 时规范化为 session_id 后转发给同一实现，不建立第二条执行路径（调研 §8）
  - 所有工具的目标参数名为 session_id，不出现 task_id / agent_id / run_id
  - agent_send / agent_stop 在目标不属于调用者所在树时失败，不产生副作用
  - agent_stop 在目标不是调用者后代时失败，不产生副作用
  - 输出为即时快照，不提供 wait / timeout / 轮询

不变式（Invariants）：
  - 权限判定先于任何副作用；判定失败的调用不写入任何消息、不中断任何执行

副作用：委托给 M1–M4；本模块自身不直接操作 Session
```

**权限的不对称**：`agent_send` 允许同树内任意方向（子→父、兄弟之间均可），`agent_stop` 只允许停后代。理由是两者的破坏性不同——投递一条消息由接收方自行决定如何处理，接收方保有主动权；停止则单方面中断对方的执行，允许子 Agent 停止父 Agent 会让编排失去可预测的控制方向。

## 5. 模块间接口规约

```
接口：M5 AgentTools → M1 AgentTree

输入数据：caller: SessionID，target: SessionID | undefined
输出数据：AgentTreeView（tree）/ boolean（isSameTree、isDescendant）

协议约定：
  - 调用方责任：caller 取自工具执行上下文，不接受模型提供的值
  - 被调用方责任：目标不存在或不在同树时返回明确的否定结果，不抛出未分类异常
```

```
接口：M5 AgentTools → M2 AgentStatusProjection

输入数据：AgentInfo（不含 status）
输出数据：AgentStatus

协议约定：
  - 调用方责任：仅对已通过同树判定的成员请求状态
  - 被调用方责任：结果是调用瞬间的快照；不保证与后续任何一次调用一致
```

```
接口：M5 AgentTools → M3 AgentInbox

输入数据：AgentMessage
输出数据：Accepted { target: SessionID }

协议约定：
  - 调用方责任：sender 由系统填写；body 为模型提供的正文；同树判定已通过
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

输入数据：caller: SessionID，target: SessionID（stop）/ 创建参数（createOrAdopt）
输出数据：AgentInfo（createOrAdopt）/ StopOutcome { stopped: SessionID[] }（stop）

协议约定：
  - 调用方责任：后代判定已通过（stop）
  - 被调用方责任：stop 返回时 StopPlan 全部层已处理完毕；部分失败必须显式报告，不得静默
```

## 6. 关键设计决策

| 决策 | 理由 |
|---|---|
| 唯一公开标识用 `session_id` | 调研 §4.2 已否决 `run_id`；Agent 的上下文、历史、父子关系本就存在 Session 上，再引入并行身份只增加误用面 |
| 状态终态取自 assistant 消息，不取自 `BackgroundJob` | 后者是进程内注册表，重启即失；见 §4.2 |
| 消息身份取自目标 Session | 否则一条消息会改写目标的 agent 与模型并落库；见 §4.3 |
| 停止自底向上并逐层等待通知交付 | 否则子 Agent 的终止通知会复活刚被停掉的父 Agent；见 §4.4 |
| 终止通知复用完成 / 失败通道，不新增状态词 | 调研 §5.4：终态、通知状态与输出字段统一用 `cancelled`，不引入 `stopped` |
| 停止级联到整棵子树 | 与既有停止语义一致，且避免"停了父、子 Agent 变孤儿继续消耗"；是否改为只停目标本身列为 follow-up（issue #26） |
| `agent_send` 不经 `BackgroundJob.extend` | extend 把新执行挂在上一次执行之后，是 run 边界而非 turn 边界，且排队期间消息不落库 |
| 权限不对称：send 全向、stop 仅后代 | 见 §4.5 |
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
G3 「同树任意方向消息」      → M3 AgentInbox（主）+ M1（同树判定）
G4 「停止并保留上下文」      → M4 AgentLifecycle（主）+ M3（终止通知）+ M1（后代判定）
G5 「身份统一」              → M5 AgentTools（表面约束）+ M1（身份解析）
```

### 模块协作论证

**G1/G2**：G1 要求"可靠列出树与状态"。M1 的后置条件保证 AgentTreeView 自封闭且有稳定序，即树本身完整；M2 的后置条件保证每个成员得到四值之一且语义互斥。二者拼接即"完整成员集合 × 明确状态"，故 G1 成立。G2 是 G1 在单成员上的投影，同理成立。

**G3**：G3 要求"同树任意方向的消息能被目标处理"。M1 的 `isSameTree` 保证方向合法性判定完备；M3 的后置条件分两种目标状态给出了处理保证——running 时进入当前 run 的下一个 provider turn，非 running 时起新 run 消费。两种状态覆盖了 AgentStatus 的全部取值（running 与其余三值互斥且穷尽），故任意目标状态下消息都会被处理，G3 成立。

**G4**：G4 要求"停止且保留上下文，且等待方不被静默挂起"。M4 的后置条件给出前半部分（终止执行、不删除任何 Session 与历史、可恢复、幂等）。后半部分由 I1 保证：每个被停 Agent 的父都会收到终止通知，除非该父自己也在停止集内——那种情况下它同样被停止，不存在"仍在等待"的主体。故不存在被静默挂起的等待方，G4 成立。

**G5**：G5 是表面约束而非运行时行为。M5 的后置条件直接规定了对模型暴露的工具集合与参数命名，M1 保证所有解析都以 SessionID 为输入，二者合起来即"不存在第二套身份"，G5 成立。

### 关键假设

本段只列本架构**控制不了**的外部前提。属于本 feature 自身概念定义或设计取舍的性质归 §6 决策，
由本架构维护的性质归下方模块级 invariant，已知不成立的性质归 §9 已知缺口。

```
H1: running 是进程内真相。SessionStatus 存于 InstanceState，进程重启后清空。
    因此崩溃前正在执行的 Agent 重启后投影为 idle（若其最后一条 assistant 消息无 error）。
    — 来源：既有基础设施；调研 §6「不包含进程崩溃后的自动继续执行」，本架构不提供崩溃恢复，
      故不修复该退化

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
    对任意被停止的 Agent a，若 a 的父 p 不在本次停止集内，
    则「a 的终止通知已持久化」happens-before「p 被取消」。
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

## 9. 已知缺口

以下三项在本架构中显式存在，不被本架构修复，实现阶段须单独核对：

1. **拆解期间新派生的后代不在停止集内**。既有子树展开按一次快照进行，快照之后派生的后代不在停止集内。
2. **停止后代时的执行现场不可恢复**。停止保留 Session 与历史，但不保留中断点；恢复是从历史继续，不是从断点续跑。调研 §6 已将 Suspend 语义列为非目标。
3. **崩溃后 running 退化为 idle**（H1）。本架构不提供崩溃恢复。

## 10. 下一阶段

架构确认后进入 §4.3 细化阶段，产出 `docs/design/agent-management/detailed-design.md`，需满足 §4.3.1 完整性 6 条与 §4.3.2 函数正确性论证。届时按 §2.3 步骤 2 为契约变更分配 subplan-id，feature 短称取 `agm`。
