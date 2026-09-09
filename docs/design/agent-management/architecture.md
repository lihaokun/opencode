# 架构设计 — agent-management

- 状态：架构阶段，**等待再次确认**。2026-09-09 第二轮评审后实质重写：`agent_send` 由「调用」降为
  「消息」，据此删除 M6 AgentExecution 及其不变量（旧 I4 单一最终结果、旧 I5 结局单一生产者）；
  新增可选实例名（及其唯一性不变量，现编号 I4）与 `task` 权限规范化；
  工作树的 ready 契约、位置因果与忽略机制三处校正；TUI 后代聚合由已知缺口提升为必要连带修改。
- 工具表面：四个（调研 §12 撤销 `agent_get`；§13 把恢复统一交给 `agent_send`）
- 日期：2026-09-04，末次修订 2026-09-09
- 对应问题：[lihaokun/opencode#23](https://github.com/lihaokun/opencode/issues/23)
- 上游依据：`docs/research/agent-management-research.md`（调研阶段已确认，§16 为本轮修订）
- 代码基线：`dev` @ `a4293ca229`

## 1. 范围与目标

调研 §1 列出五条缺口，本架构按 G1–G5 承接；调研 §15/§16.10–16.11 把工作树纳入首版，记为 G6：

| 编号 | 目标 | 调研出处 |
|---|---|---|
| G1 | 可靠列出当前 Agent 树及各成员状态 | §1 缺口 1 |
| G2 | 查询指定 Agent 的身份、关系与状态 | §1 缺口 2；由 roster 行承载，不单列工具（§12） |
| G3 | 邻居（父 / 子 / 兄弟）间任意方向的直接消息 | §1 缺口 3；范围见 §14 |
| G4 | 主动停止不再需要或失控的 Agent，保留上下文 | §1 缺口 4 |
| G5 | 身份统一为可寻址、可恢复的 Session，消除 `task_id` 的语义错位 | §1 缺口 5 |
| G6 | 为每个 Agent 准备独立工作目录，降低并行改同一份 checkout 的冲突 | §15、§16.10–16.11 |

非目标沿用调研 §6。本文档额外承担调研甩给架构阶段的四笔欠账：工具 schema（§4.7）、
状态枚举（§3 `AgentStatus`）、停止级联与终止通知契约（§4.4）、消息交付顺序（§4.3）。

## 2. 核心流程

四个工具共用一条骨架：**解析目标 → 权限判定 → 执行 → 渲染**。差异只在第三步。

```
模型
 └─ M5 AgentTools（唯一对模型暴露的表面）
     ├─ 解析：M1 AgentTree     ← Session store 的 parentID 链
     ├─ 权限：M5 ctx.ask（key = agent）+ M1 直接子判定（仅 agent_stop）
     └─ 执行：
         agent           → M4 create（建工作树 → 建 Session → 起初始委托）
         agent_list      → M1 neighborhood（骨架）+ M2 of（状态）→ M5 组装 AgentInfo
         agent_send      → M3 deliver（普通 prompt_async，只回 accepted）
         agent_stop      → M4 stop（读状态 → 逐层取消 → 向各自父投一次 cancelled）

     自动结局交付：只有 agent 的初始委托有，复用既有 runTask 分类与 notify/inject
```

三条值得单独展开的路径：

**消息投递（G3）**：`agent_send` 把发送者标识拼进正文首行，然后**以目标 Session 自己的身份**
调用普通异步消息入口 `POST /session/{id}/prompt_async`。目标状态完全交给现有 Runner：
running 时现有 loop 在下一个 provider turn 边界读到它，idle 时 `prompt_async` 自然起新 run。
Agent 管理层**不手工判断 running/idle 来启动执行**。调用方只拿到 `accepted`——
**不自动回复、不承诺返回结果、不建 BackgroundJob、不注册 watcher**（调研 §16.1）。

**创建（G6 + G3 的起点）**：`agent` 建工作树（ready 后）→ 建子 Session → 用**既有初始委托路径**
起一次后台执行。这一条**保留自动结局**：跑完后按既有 `runTask` 六分支分类，向创建者投递一次
completed/error。初始执行期间收到的 `agent_send` 只是追加消息，仍由该初始执行交付那一次结果。

**停止（G4）**：`agent_stop` 先由 M1 解出目标子树并按深度分层，然后自底向上逐层：
**先读 `SessionStatus` 判定 running/idle**，对 running 者取消并向其父投递一条 `cancelled` 消息，
对 idle 者不取消也不发通知。目标本身最后取消，其通知投给树外的父 Agent。

**状态投影（G1/G2）**：只读 `SessionStatus`——busy 或 retry 即 `running`，否则 `idle`。
roster 不表达执行结局。

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

不表达终态：执行的结局不进入本枚举。roster 只回答"此刻还在跑吗"。

跨模块共享性：跨模块共享 — consumer: M2 AgentStatusProjection（产出）、M5 AgentTools（渲染）
```

```
数据结构：AgentInfo

字段：
  - session_id: SessionID — Agent 的唯一公开标识，即现有 SessionID
  - parent_id: SessionID | undefined — 父 Agent；undefined 表示该 Agent 是树根（主 Agent）
  - name: string | undefined — 可选实例名，取自 Session.Info.metadata.agentName
  - agent_type: string | undefined — Agent 定义类型，取自 Session.Info.agent；
    可空，因为该字段本身可空（尤其是尚未绑定 agent 的根 Session）
  - title: string — Session 标题，供人读
  - status: AgentStatus — 见上
  - depth: NonNegativeInt — 相对树根的深度，根为 0
  - relation: "self" | "parent" | "child" | "sibling" — 相对查询发起者的关系（调研 §14）
  - time_created: number — Session 创建时间（epoch ms）
  - workdir: { path: string, source: WorkdirSource, enforced: false } | undefined
      — 该 Agent 的**建议**工作目录；enforced 恒为 false，见 §6「隔离强度」

类型不变量：
  - depth == 0 ⟺ parent_id == undefined
  - 同一棵树内 session_id 唯一
  - name 存在时在同一棵 Agent 树内唯一（见 §7 I4）
  - workdir.enforced 恒为 false：运行时默认 cwd 未切换，该路径只是建议

唯一性 / 标识：
  - session_id 全局唯一，且是本 feature 的**权威**公开标识（调研 §5.1）
  - name 是可选别名，指向同一个 session，不构成第二套身份

装配责任：
  - M1 只产出 Session 行 + relation + depth，**不含 status**——status 不属于 M1 的观测域
  - M5 对每个成员调 M2 取 status，此时才组装出完整的 AgentInfo

生命周期：
  - 创建：M4 AgentLifecycle.create 创建子 Session 时产生
  - 修改：status 为投影值不落库；name 创建后不可修改；其余字段随 Session 变化
  - 删除：本 feature 不删除 Session；Agent 停止后 AgentInfo 仍可查

跨模块共享性：跨模块共享 — consumer: M1（产出骨架）、M2（供 status）、M5（组装并渲染）
```

```
数据结构：WorkdirSource

字段：
  - value: "generated_git_worktree" | "generated_empty_workspace" | "provided_cwd"

语义：
  - generated_git_worktree    Git 项目，本 feature 建的真实 git worktree
  - generated_empty_workspace 非 Git 项目，本 feature 建的空目录
  - provided_cwd              调用方经 cwd 指定，本 feature 未创建任何东西

类型不变量：
  - 三者互斥且穷尽
  - provided_cwd 的目录不由本 feature 管理，任何情况下都不被本 feature 删除

跨模块共享性：跨模块共享 — consumer: M4（产出）、M5（渲染）
```

```
数据结构：AgentNeighborhood

字段：
  - caller: SessionID — 发起查询的 Agent
  - members: AgentInfo[] — 调用者的邻居，含调用者自身（status 由 M5 补齐，见 AgentInfo）

类型不变量：
  - caller ∈ members.map(session_id)
  - ∀ m ∈ members, m.relation ∈ {self, parent, child, sibling}，且恰有一个成员 relation == self
  - 邻居集合的定义：
      parent  = caller.parent_id 对应的 Agent（caller 为主 Agent 时不存在）
      child   = parent_id == caller 的全部 Agent
      sibling = parent_id == caller.parent_id 且 ≠ caller 的全部 Agent（caller 为主 Agent 时为空）
  - 不含祖父、孙、叔伯、侄、堂兄弟等任何非邻居成员（调研 §14）
  - members 按 **(relation, time_created, session_id)** 升序。三元组而非二元组：
    毫秒级 time_created 会并列，并列时顺序不稳定则 roster 每次渲染可能换行序

跨模块共享性：跨模块共享 — consumer: M1（产出）、M5（渲染 roster）
```

```
数据结构：TargetRef

字段：
  - value: string — 调用方给出的目标标识

解析规则（按序，先命中者胜）：
  1. 以 SessionID 前缀 `ses` 开头 ⇒ 直接作为 session_id 使用，不做名称查找
     （实例名禁止以该前缀开头，故两者可判定地区分）
  2. 否则视为**实例名**，在调用者的邻居集合（`agent_send`）或直接子集合（`agent_stop`）中
     匹配 `AgentInfo.name` 相等者，候选集合排除调用者自身：
     - 恰一个 ⇒ 取之
     - 零个   ⇒ 失败 `TargetNotResolved`，错误正文附候选清单
     - 多个   ⇒ 唯一性不变量（I4）已损坏 ⇒ 失败，**绝不择一**

类型不变量：
  - 名称只匹配 `AgentInfo.name`，**不匹配 `agent_type`**：类型标识的是 Agent 定义而非实例，
    用它寻址在同类型多实例（扇出，本方案的主用法）时必然歧义
  - 名称解析只在调用者自己的可寻址集合内进行，不扩大寻址范围：
    `agent_send` 仍可对任意存在的 Session 用 session_id 直投，但名称只解析邻居；
    `agent_stop` 的名称只解析直接子，与其 session_id 形式的约束一致
  - session_id 始终是规范形式；名称是同一 session 的别名，不构成调研 §5.1 否决的并行身份

跨模块共享性：跨模块共享 — consumer: M5 AgentTools（解析）、M1 AgentTree（提供候选集合）
```

```
数据结构：AgentMessage

字段：
  - target: SessionID — 接收方
  - sender: SessionID — 发送方，由系统填写
  - sender_name: string | undefined — 发送方实例名，存在时显示
  - sender_agent: string | undefined — 发送方 agent 类型，仅供阅读
  - body: string — 调用方提供的正文

类型不变量：
  - sender ≠ target（不允许自投递）
  - target 对应的 Session 存在
  - 不要求 target 是 sender 的邻居，也不要求同树：消息不转移权限，目标始终在它自己
    Session 的权限下行动。寻址范围由"调用者只从 roster 拿得到邻居的标识"自然收敛（调研 §14）
  - 落库文本 = 系统前缀 + "\n\n" + body，前缀格式固定为：

      [Agent message from <sender_name> (<sender_agent>, <sender>)]
      To reply, use agent_send(target="<sender>", message="<your reply>").

    sender_name 缺省时省略该段；**回复说明恒用 session_id，不用 name**——
    session_id 跨名称解析范围都可用，且是权威地址。"To reply"是说明工具与地址，不是要求必须回复
  - 调用方无法覆盖或伪造前缀（调研 §5.3）
  - 本结构**只服务 `agent_send`**：新 Agent 的初始任务不经它（见 §4.4）

生命周期：
  - 创建：M3 AgentInbox.deliver 构造
  - 修改：不可变
  - 删除：不单独删除；随 Session 历史存续

跨模块共享性：跨模块共享 — consumer: M3（产出并投递）、M4（停止通知复用同一投递语义）
```

```
数据结构：Accepted

字段：
  - target: SessionID — 消息已被写入的目标 Agent

类型不变量：
  - 该值存在 ⇒ 对应 AgentMessage 已持久化进 target 的 Session（见 §7 I2）
  - **不携带目标的执行结果，也不表示目标已开始、已处理或将会处理该消息**
  - 尤其不表示送达后必被消费：受 issue #32 影响，见 §10 缺口 5

跨模块共享性：跨模块共享 — consumer: M3（产出）、M4（停止通知复用）、M5（渲染）
```

```
数据结构：DelegationOutcome

作用域：**只用于 `agent` 的初始委托**。`agent_send` 不产生本结构（调研 §16.1）。

字段：
  - kind: "completed" | "failed" | "cancelled" — 初始委托的结局
  - text: string — 交给创建者的正文

语义与判定顺序（照既有 task 执行体逐条复制，不简化）：
  1. 返回的不是 assistant 消息                      ⇒ failed，正文说明协议异常
  2. error.name == "MessageAbortedError"           ⇒ cancelled（cancelled 的唯一自然来源）
  3. error 存在，或 finish == "length"              ⇒ failed，正文为既有 assistant 失败渲染
     （错误名与消息；输出超长时带 token 数、部分输出摘录与截断提示）
  4. 最后一个 tool part 状态为 error                ⇒ failed，正文为既有 subagent 工具失败渲染
  5. finish 缺失或为 "unknown"，且无可用输出         ⇒ failed，正文为既有 incomplete 渲染
  6. 以上皆否                                       ⇒ completed，正文取**最后一条** text part
     （不是全部 text 拼接——全部拼接只用于失败时的摘录）

映射到执行出口（结算状态由 run 体的 Effect exit 推出，不另设信息通道）：
  - 第 6 条        ⇒ 成功出口 ⇒ 结算 completed，正文进 output
  - 第 1、3、4、5 条 ⇒ 失败出口，正文即失败文本 ⇒ 结算 error，正文进 error
  - 第 2 条        ⇒ 中断出口 ⇒ 结算 cancelled，正文在交付时现产

类型不变量：
  - 六条判定按序求值，先命中者胜；覆盖穷尽，不存在落空的初始委托
  - 第 2 条必须先于第 3 条求值：MessageAbortedError 本身也是一种 error，顺序颠倒会把取消
    误报为失败，且结算成 error 而非 cancelled
  - 正文长度受既有截断上界约束，超出时附截断提示并指向 session_id

跨模块共享性：跨模块共享 — consumer: M4 AgentLifecycle（产出并交付）、M5 AgentTools（渲染）
```

```
数据结构：StopOutcome

字段：
  - transitioned: SessionID[] — 本次由"有活动执行"转为"已取消"的成员
  - unchanged: SessionID[] — 调用时本就无活动执行的成员；未取消、未产生通知
  - failed: { session_id: SessionID, reason: string }[] — 取消过程中出错的成员及原因

类型不变量：
  - transitioned ∪ unchanged ∪ failed.map(session_id) = ⋃ StopPlan.layers，三者两两不交
  - transitioned 中每个成员的取消通知**已投递一次**——注意是投递，不是送达（见 §10 缺口 5）
  - unchanged 非空不构成错误：stop 幂等，重复调用只会让成员落入 unchanged
  - **不给 unchanged 成员发送 cancelled 通知**：它本就没在跑，那条通知是假的
  - failed 非空 ⇒ M5 必须逐条呈现，不得静默丢弃（见 §5 M5→M4 接口协议）
  - 不设 notified 字段：通知接收方恒为各成员的父，可由成员反查，单列会与真实送达情况漂移

跨模块共享性：跨模块共享 — consumer: M4 AgentLifecycle（产出）、M5 AgentTools（渲染）
```

```
数据结构：本 feature 的失败类型

字段：
  - AgentNotFound       { session_id }        目标 Session 不存在
  - AgentTypeNotFound   { subagent_type }     创建时指定的 agent 定义不存在
  - AgentNameConflict   { name }              实例名在本树内已被占用
  - NotAChild           { caller, target }    agent_stop 的目标不是调用者的直接子
  - SelfDelivery        { target }            agent_send 的目标是发送者自己
  - DepthLimitReached   { depth, limit }      创建时已达嵌套上限
  - TargetNotResolved   { value }             目标名称在可寻址集合中无匹配
  - WorktreeUnavailable { reason }            工作目录准备失败（非 git、名称生成失败、
                                              git 命令失败、checkout 未达 ready 契约）

类型不变量：
  - 八者互斥，均为可预期的调用方错误，不用于表达内部缺陷
  - M1/M3/M4 只产出这些类型，不吞错也不转成 undefined
  - M5 是唯一把它们渲染为模型可读文本的地方
  - AgentNameConflict 与 WorktreeUnavailable 必须**零副作用**：不建 Session、不建 workspace、
    不投递 prompt、不启动执行，也不返回既有同名 Agent 的 session_id

跨模块共享性：跨模块共享 — producer: M1、M3、M4；consumer: M5 AgentTools
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

跨模块共享性：模块私有 — 仅 M4 AgentLifecycle 使用；列在此处是因为它承载 §7 的 I1
```

## 4. 模块划分与功能规约

**五个模块**。M1–M4 是机制，M5 是唯一对模型暴露的表面。
（原 M6 AgentExecution 已删除：它的前提是"每条消息都有一次执行结局"，而 `agent_send` 降为消息后
该前提不成立。见 §6 与调研 §16.5。）

### 4.1 M1 AgentTree

```
模块名称：AgentTree

功能描述：解析调用者的邻居集合（父 / 子 / 兄弟）与直接子集合，承担 `agent_stop` 的直接子判定，
  把 `TargetRef` 解析为 SessionID，并校验实例名在本树内唯一。
  另提供后代闭包供 M4 的停止级联使用——那是效果范围，不是寻址范围。

前置条件（Requires）：
  - 入参 session_id 对应的 Session 在 store 中存在
  - Session 的 parentID 链无环（由 Session 创建路径保证，见 §7 H2）

后置条件（Ensures）：
  - neighborhood(id) 返回的 AgentNeighborhood 满足其类型不变量，**但不含 status**
    ——status 不属于本模块的观测域，由 M5 调 M2 补齐
  - children(id) 返回 parent_id == id 的全部 Agent
  - descendants(id) 返回 id 的全部后代，不含 id 自身；仅供 M4 展开停止级联
  - isChild(caller, target) ⟺ target ∈ children(caller)
  - resolveTarget 按 §3 `TargetRef` 求值；名称只在调用者的可寻址集合内匹配，
    故解析结果必属于调用方本就能寻址的范围，不扩大任何工具的作用域
  - resolveTarget 的候选集合排除调用者自身
  - reserveName(root, name) 在整棵树内唯一时占位并返回成功，否则 AgentNameConflict；
    占位与检查之间不得让出执行权（见 §7 I4）

不变式（Invariants）：
  - 解析过程只读 Session store，不改变任何 Session 状态
  - 例外：reserveName 写内存占位表，不写 Session store

副作用：除 reserveName 的内存占位外无
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

**为什么状态只有两值**：调研 §5.5 只要求区分"当前确实在运行"与"Session 存在但没有活动执行"。
Claude Code 的 `ListAgents` 同样只给 busy / idle。本模块**不读 `BackgroundJob`**——
经 `agent_send` 恢复的 Agent 可能正在运行却没有任何 BackgroundJob（调研 §16.6），
`SessionStatus` 是唯一正确的事实来源，`agent_stop` 也用同一来源。

### 4.3 M3 AgentInbox

```
模块名称：AgentInbox

功能描述：构造带系统发送者前缀的消息，以目标 Session 自身的身份写入普通异步消息入口。
  **这是消息，不是调用**：不等待、不回复、不注册任何后续。

前置条件（Requires）：
  - message 满足 AgentMessage 的全部类型不变量
  - 目标 Session 存在

后置条件（Ensures）：
  - 返回前，消息已作为 user message 持久化进目标 Session
  - 消息携带的 agent / model / variant **显式取自目标 Session 当前持久化的值**，不取自调用者，
    也不省略（理由见下）
  - 目标的 running / idle 由现有 `prompt_async` 与 Session Runner 处理，
    **本模块不判断目标状态，也不手工启动执行**
  - 返回 Accepted。不自动回复、不承诺结果、不建 BackgroundJob、不注册 watcher

不变式（Invariants）：
  - I2（见 §7）：返回 Accepted ⇒ 消息已持久化

副作用：写入目标 Session 一条 user message，并按普通异步消息语义触发其处理
```

**身份取自目标而非调用者，且必须显式传**：`session/prompt.ts:636-690` 的解析优先级是
`input.model ?? agent 定义的 model ?? Session 当前 model`，且不传 `agent` 时回落到**默认 agent**，
解析结果还会经 `setAgentModel` **写回 Session 行**。因此省略任一项都会把目标 Agent 的身份改掉并存下来。
三项都要显式取目标当前值；`setAgentModel` 存的是 `variant ?? "default"`，回传时 `"default"` 必须省略，
否则来回一趟会把 variant 钉死。发送者身份由正文前缀承载即可，不进入执行参数（调研 §5.3）。

**为什么不用 FSM 给主 Session 发通知那种只传 parts 的写法**：那条路径的目标是主 Session，
其 agent 绑定本就是用户选的、回落到默认无害。子 Agent 不同——回落会把它换成默认 agent 并持久化。

### 4.4 M4 AgentLifecycle

```
模块名称：AgentLifecycle

功能描述：创建 Agent 并起其初始委托；停止目标 Agent 及其后代的当前执行。
  恢复既有 Agent 不经本模块，由 M3 承担（调研 §13）。

前置条件（Requires）：
  - create: 目标 agent 定义存在；未超过 subagent 深度上限；实例名（若给）在本树内未被占用；
    调用者的 model 与 variant 由 M5 从工具上下文读出后**作为参数传入**
  - stop: 调用方已通过 M1 的直接子判定；target 存在

后置条件（Ensures）：
  - create 总是新建一个以调用者为 parentID 的子 Session，不复用既有 Session
  - create **不直接引用工具上下文**（`ctx.messageID` / `ctx.metadata` 等）：
    读上下文是 M5 的职责，M4 只接收窄数据（见 §5 接口）
  - create 的初始任务走**既有初始委托路径**，不经 AgentMessage：
    `resolvePromptParts(prompt)` 返回的是 `parts[]`（含展开的 @file 附件），
    必须原样交给该路径；把它压成字符串会丢附件
  - 初始任务前置一个 text part 声明该 Agent 的**建议工作目录**绝对路径，
    并要求其使用绝对路径操作、shell 显式传 workdir
  - create 起一次后台执行，结束后按 §3 `DelegationOutcome` 向**创建者**交付一次结局
  - 工作目录准备（见 §4.4.1）必须在启动 Agent **之前**达到 ready，失败则 WorktreeUnavailable
    且零副作用
  - **不为任何目录预置权限放行**：自建工作目录在项目内，`containsPath` 直接为真；
    `cwd` 由模型提供，为它自动放行等于让模型可以用 `agent(cwd: <任意目录>)` 开出绕过口——
    该目录若在 instance 之外，其首次文件操作照常触发一次权限询问，由用户裁决
  - stop 对 ⋃ StopPlan.layers 中每个成员：**先读 SessionStatus**，
    running ⇒ 取消并向其父投递一条 cancelled 消息，计入 transitioned；
    idle ⇒ 不取消、不发通知，计入 unchanged
  - stop 不删除任何 Session、消息或历史；stop 后目标仍可经 agent_send 恢复
  - stop 幂等：重复调用只会让成员落入 unchanged
  - 对 layers 的处理自底向上：处理 layers[i] 前，layers[0..i-1] 的取消与通知投递均已发起
  - StopOutcome 只报告真实发生的停止

不变式（Invariants）：
  - I1（见 §7）

副作用：创建 Session 与工作目录；启动 / 中断后台执行；向父 Session 写入结局或取消通知
```

**为什么必须自底向上**：防复活。取消通知走普通消息入口，投递会让非 running 的目标起一次新执行。
级联中孙的取消通知要投给子，若自顶向下取消，子已经停了，这条通知会把它重新唤醒——
停止操作自己复活了它要停的东西。自底向上使每条通知投递时接收方仍在运行，只加入其当前执行。

**为什么必须先读状态再取消**：`session/run-state.ts:77-86` 的 `cancel` 对无 runner 的 Session
是**成功空操作**（直接 `status.set(idle)` 返回），分不出"本来在跑、现已取消"与"本来就 idle"。
不先读状态就无法区分 transitioned 与 unchanged，重复 stop 会重复发通知，本就 idle 的成员
也会收到假的 cancelled 通知。

**为什么终止通知必须存在**：取消不能静默结束。它复用完成/失败的同一条通道与同一个状态词
`cancelled`（调研 §5.4）。接收方是被停 Agent 的父：对末层而言是发起停止者本人，
对级联中间层而言是同样在停止集内的父。该场景要求 Agent 树至少三层，
因此本架构把 `subagent_depth` 默认提到 3（见 §6）。

**通知是投递一次，不是保证送达**：受 issue #32 影响，投递可能落进 lost-wake 窗口而不被消费
（见 §10 缺口 5）。完成与失败通知同理。此前把"父必然收到取消通知"写成不变量是不成立的。

#### 4.4.1 工作目录准备（G6）

```
未给 cwd + Git 项目：
  destination = <项目目录>/.opencode/worktrees/<slug>          ← 平铺，不嵌套
  baseDirectory = 创建者的 metadata.agentWorkdir.path ?? instance directory
  baseCommit    = git -C <baseDirectory> rev-parse HEAD
  git worktree add -b <branch> <destination> <baseCommit>
  → 必须等 tracked files checkout 完成（ready 契约）
  source = generated_git_worktree

未给 cwd + 非 Git 项目：
  同一管理根下建普通空目录，不复制任何项目文件
  初始消息同时给出 source directory 与空 workspace directory，由 Agent 自主决定复制什么
  source = generated_empty_workspace

给了 cwd：
  不创建任何东西，直接把该路径作为建议工作目录
  source = provided_cwd

忽略登记（Git 项目）：
  经 git rev-parse --path-format=absolute --git-path info/exclude 定位，
  读回既有内容后追加 /.opencode/worktrees，已存在则跳过
```

**ready 契约是硬要求**。`worktree/index.ts:281-292` 的 `createFromInfo` 是
`setup()`（`git worktree add --no-checkout`，**目录里没有文件**）后把 `boot()`（`git reset --hard`，
真正的 checkout）**fork 出去**，`Worktree.create()` 返回时工作树是空的。
本 feature 的入口必须在返回时满足"目录存在且 tracked files 完整可读"，否则子 Agent 会在空目录里开工。

**位置必须在项目内，而且是被迫的**。opencode 现有 worktree 建在 `Global.Path.data/worktree/<projectID>`，
在**项目之外**；它不需要 `external_directory` 是因为**现有 worktree 是独立 instance**，
进去开 Session 时 `ctx.directory` 就是它。而子 Agent **不换 instance**（见 §6「隔离强度」），
`project/instance-context.ts:18-24` 的 `containsPath` 只查 `ctx.directory` 与 `ctx.worktree`、
**不查 sandbox**，所以放在全局数据目录会让每次文件访问都弹 `external_directory`。
**不换 instance ⇒ 必须放项目内**。这与 opencode 自身的 worktree 位置约定不同，原因即此。

**必须平铺**。若嵌在创建者自己的工作树内，父被清理时会连同子的工作一并删除。

**忽略用 `info/exclude` 而非 `.gitignore`**。`.git/info/exclude` 仓库本地、从不提交、
不出现在 `git status`；`snapshot/index.ts:186-193` 已有先例且其 `sync` 读回既有内容再追加，
故我们的条目不会被冲掉；它在 common dir，一条即可覆盖主 checkout 与全部子工作树；
ripgrep 默认尊重它，满足"`glob`/`grep` 不搜出各工作树副本"。在工作树根写自我忽略 `.gitignore`
是往用户仓库工作树里造文件，已废弃。

**V1 不自动清理**。completed / error / cancelled 都不删目录，Session 删除不连带删除，
不做无改动检测、运行锁、周期 sweep 或清理后重建。因此 V1 也不需要用 project sandbox 列表
推断 Session 所有权。"workspace 会累积"是明确的已知限制（§10 缺口 7）。

### 4.5 M5 AgentTools

```
模块名称：AgentTools

功能描述：四个模型可调用工具的参数 schema（见 §4.6）、权限门、上下文读取与输出渲染；
  本 feature 唯一对模型暴露的表面。

前置条件（Requires）：
  - 调用发生在某个 Session 的工具执行上下文中，调用者 SessionID 可知

后置条件（Ensures）：
  - 对模型暴露且仅暴露 agent / agent_list / agent_send / agent_stop（调研 §12）
  - 保留隐藏兼容入口 task：不进模型工具列表，收到旧 task_id 时规范化为 session_id 后
    转发给同一实现，使用**规范化后的 `agent` 权限**，不建立第二条执行路径，也不成为权限绕过
  - **上下文读取在本模块**：从 `ctx.sessionID` / `ctx.messageID` 取调用者当次的 model 与 variant，
    作为窄数据传给 M4；`ctx.metadata(...)` 在 M4 返回后由本模块调用
  - agent_list 对 neighborhood 的每个成员调 M2 取 status，此时组装完整 AgentInfo 并渲染；
    roster 同时显示 session_id 与 name
  - agent_send 只校验目标 Session 存在与非自投递；不校验邻居关系，也不校验同树
  - agent_stop 在目标不是调用者的直接子时失败，不产生副作用
  - 调用者深度已达 subagent_depth 上限时，不向其提供 agent 与 agent_stop；
    agent_list 与 agent_send 仍提供（判据是深度到限，不是当前是否有子 Agent）
  - 输出为即时快照，不提供 wait / timeout / 轮询
  - `agent` 经 `ctx.ask({ permission: "agent", patterns: [subagent_type], always: ["*"] })` 求值；
    默认 `*: allow` 使其不弹窗，但 subtype 级 deny 仍然生效（见 §6）
  - agent_list / agent_send / agent_stop 不新增额外的逐次确认
  - 被派生 Agent 自身的工具调用继续在它自己的 Session 权限下受控，本 feature 不改动该机制

不变式（Invariants）：
  - 权限判定先于任何副作用；判定失败的调用不写入任何消息、不中断任何执行

副作用：委托给 M1–M4；本模块自身不直接操作 Session
```

**权限的不对称**：`agent_send` 可发给任一邻居（父、子、兄弟），`agent_stop` 只能停直接子。
理由是破坏性不同——投递一条消息由接收方自行决定如何处理，接收方保有主动权；
停止则单方面中断对方的执行。停止的**效果**仍级联到目标的整棵后代，但那不扩大寻址范围（调研 §14）。

### 4.6 工具 schema

```
工具：agent
  description:    string    — 3-5 词的任务简述，用于 roster 与 UI
  prompt:         string    — 交给该 Agent 的任务正文
  subagent_type:  string    — agent 定义名
  name?:          string    — 可选实例名，本树内唯一、不可修改、不得以 `ses` 开头。
                              省略则该 Agent 只能用 session_id 寻址
  cwd?:           string    — 指定工作目录；给出则使用它，不创建工作树。
                              省略则为该 Agent 准备独立工作目录（§4.4.1）
（无 background 参数：Agent 恒为异步执行，调用立即返回 AgentInfo，结局经通知通道送达）
（无 session_id 参数：一次 agent 调用总是新建；恢复既有 Agent 用 agent_send，见调研 §13）
（无 model 参数：继承创建者当次的 model 与 variant，见 §6）
返回：AgentInfo

工具：agent_list
  （无参数；范围恒为调用者的邻居：父、子、兄弟）
返回：AgentNeighborhood.members，每行含 session_id / name / agent_type / relation /
      status / title / workdir

工具：agent_send
  target:         string    — session_id，或调用者邻居中某个 Agent 的实例名
  message:        string    — 正文；系统前缀由 M3 添加，调用方不可覆盖
返回：Accepted

工具：agent_stop
  target:         string    — session_id，或调用者直接子中某个 Agent 的实例名
返回：StopOutcome

（`target` 的解析规则见 §3 `TargetRef`。session_id 始终是规范形式；实例名是可选别名。）
```

## 5. 模块间接口规约

```
接口：M5 AgentTools → M1 AgentTree

输入数据：caller: SessionID，target: SessionID | undefined，TargetRef + scope（resolveTarget），
  root + name（reserveName）
输出数据：AgentNeighborhood（neighborhood，不含 status）/ AgentInfo 骨架[]（children、descendants）/
  boolean（isChild）/ SessionID（resolveTarget）/ void | AgentNameConflict（reserveName）

协议约定：
  - 调用方责任：caller 取自工具执行上下文，不接受模型提供的值；调用 resolveTarget 时声明 scope；
    **status 由调用方另行向 M2 取并组装**，不得期待 M1 返回它
  - 被调用方责任：目标不存在、不是直接子、名称无匹配或名称冲突时返回明确的否定结果，
    不抛出未分类异常
```

```
接口：M5 AgentTools → M2 AgentStatusProjection

输入数据：session_id: SessionID
输出数据：AgentStatus

协议约定：
  - 调用方责任：仅对 neighborhood 中的成员请求状态
  - 被调用方责任：结果是调用瞬间的快照；不保证与后续任何一次调用一致
```

```
接口：M5 AgentTools → M3 AgentInbox

输入数据：AgentMessage
输出数据：Accepted { target: SessionID }

协议约定：
  - 调用方责任：sender 由系统填写；body 为模型提供的正文；目标存在性已确认
  - 被调用方责任：返回 Accepted 时消息已持久化；不得在持久化前返回；
    **不得等待目标处理，也不得注册任何后续回调**
```

```
接口：M5 AgentTools → M4 AgentLifecycle

输入数据：
  - create: { caller, name?, subagent_type, description, prompt, cwd?, model, variant, callerWorkdir? }
    ——**全部为窄数据**，M4 不接触工具上下文
  - stop: caller: SessionID，target: SessionID
输出数据：AgentInfo（create）/ StopOutcome（stop）

协议约定：
  - 调用方责任：model 与 variant 由 M5 从 `ctx.messageID` 指向的 assistant 消息读出后传入；
    后代判定已通过（stop）；`ctx.metadata(...)` 由 M5 在 create 返回后调用
  - 被调用方责任：stop 返回时 StopPlan 全部层已处理完毕；部分失败必须显式报告，不得静默；
    create 的失败必须零副作用
```

```
接口：M4 AgentLifecycle → M3 AgentInbox（停止通知）

输入数据：AgentMessage（target = 被停 Agent 的父，body = cancelled 通知正文）
输出数据：Accepted

协议约定：
  - 调用方责任：只对**实际发生转变**的成员投递；对 unchanged 成员不得投递
  - 被调用方责任：与普通消息投递一致；同样只保证持久化，不保证被消费
```

## 6. 关键设计决策

| 决策 | 理由 |
|---|---|
| 唯一权威标识用 `session_id` | 调研 §4.2 已否决 `run_id`；Agent 的上下文、历史、父子关系本就存在 Session 上，再引入并行身份只增加误用面 |
| **`agent_send` 是消息，不是调用** | 本轮最大简化。不自动回复、不承诺返回结果、不建 BackgroundJob、不注册 watcher，调用方只收 `accepted`，接收方自主决定是否回复。直接复用普通 `prompt_async`。理由：一条消息的"结局"在语义上不存在——接收方可能只是把它读进上下文继续原任务。强行给每条消息配一个结局，就要为此维护 watcher 所有权、结局去重与取消时的通知竞态，而这些复杂度买到的东西模型并不需要 |
| 只有 `agent` 的初始委托保留自动结局 | 初始委托是**创建者交出去的一项任务**，它有明确的完成含义，创建者也确实在等它。复用既有 `runTask` 分类与 `notify`/`inject` 通道。由此产生一处**不对称并需明说**：`agent` 自动回结果，`agent_send` 永不回 |
| **删除 M6 AgentExecution** | 它的前提是"每条消息都有一次执行结局"。前提没了，`ensure` / 通用 `watch` / `noticeDelivered` / `cancelAndAwaitNotice` / I4 / I5 一并删除。可留一个很小的内部 `startAgent` 供规范 `agent` 与隐藏 `task` 别名共用，但不重新引入通用 Session executor |
| 消息身份取自目标 Session 且必须显式传 | `createUserMessage` 的优先级是 `input.model ?? agent 定义 model ?? Session 当前 model`，不传 `agent` 回落默认 agent，且结果经 `setAgentModel` 落库。省略任一项都会改写并持久化目标的身份。见 §4.3 |
| 目标状态交给现有 Runner，本 feature 不判断 | running 时现有 loop 在下一个 provider turn 边界重读消息（`prompt.ts:1090-1106` 每轮重读，新 user message 使 `lastAssistantBelongsToLatestTurn` 为假、退出条件不成立），idle 时 `prompt_async` 自然起新 run。两种状态都不需要管理层介入 |
| 停止先读状态再取消 | `SessionRunState.cancel` 对 idle 目标是成功空操作，分不出两种情形。不先读状态就会重复发通知、给 idle 成员发假通知 |
| 停止自底向上 | 否则子的取消通知会复活刚被停掉的父；见 §4.4 |
| 通知是"投递一次"，不是不变量 | 受 issue #32 影响，投递可能落进 lost-wake 窗口。本 feature **不为它造绕行方案，也不依赖它被修复**；修复与本 feature 并行推进（`effect/runner.ts` 加 `pendingWake`，参照 V2 `run-coordinator.ts` 的 `settle`，签名不变、文件不重叠） |
| `StopOutcome` 区分 transitioned 与 unchanged | 见上；且不给 unchanged 成员发 cancelled 通知 |
| 终止通知复用完成 / 失败通道，不新增状态词 | 调研 §5.4：统一用 `cancelled`，不引入 `stopped` |
| `AgentStatus` 只有 running / idle 两值，来源恒为 `SessionStatus` | 调研 §5.5 只要求区分在跑与不在跑。**不读 `BackgroundJob`**：经 `agent_send` 恢复的 Agent 可能正在运行却没有新 job，`agent_list` 与 `agent_stop` 必须用同一个事实来源 |
| 停止级联到整棵子树 | 与既有停止语义一致，避免"停了父、子变孤儿继续消耗"；是否改为只停目标本身列为 follow-up（issue #26） |
| **可选实例名 `name?`，寻址不用类型名** | 类型标识的是 Agent 定义而非实例。扇出（一次开三个 `explore`）是 subagent 的主用法，同类型多实例是设计目标场景，类型名恰在那时歧义；消息前缀里三个 `explore` 也无法区分来源。曾采纳的"类型名 + latest wins"作废——其依据"Claude Code 是 latest wins"是错的，CC 用每行的 `[ref]` 消歧或直接报错，从不静默择一，而静默择一意味着消息发给了错的 Agent 且无人知晓 |
| 实例名唯一性用树内扫描 + 同进程占位，不做 schema 迁移 | 范围是一棵 Agent 树（至多数十个 Session），线性扫足够；并发在同进程内检查与占位之间不 await 即无交错，进程重启后按需重扫重建。这样"多匹配 = 不变量已损坏"才是真正的不可能状态，而非 best-effort 检查的正常输出 |
| 名称冲突零副作用且不返回既有 Agent | 返回既有 session_id 等于把"创建"悄悄变成"复用"，模型会以为自己新开了一个 Agent。错误只提示换名或省略 |
| `agent` 保留 `ctx.ask`，把默认动作改为 allow | Claude Code 明确「No user permission approval is required to launch a subagent itself」，可做的是 `permissions.deny` 而非每次询问。**杠杆不是删掉 `ctx.ask`**——它并非弹窗而是按规则求值：`deny` 拒绝、`allow` 放行、只有 `ask` 弹 UI，而无规则命中时 `evaluate` 兜底为 `ask`（`permission/index.ts:34`）。`task` 今天弹窗正是因为这个兜底。删掉调用会连带删掉**唯一**求值 `deny` 的地方，subtype 级 deny 随之失效 |
| **旧 `task` 权限配置在读取时一次性规范化为 `agent`** | 不能静默忽略：`task: deny` 升级后变成允许即是权限放宽。schema 暂时同时接受两者，`task` 标注 deprecated 并输出一次迁移 warning 不报错；先转换旧 `task` 规则、再覆盖显式 `agent` 规则，同 pattern 冲突时 `agent` 胜；运行时只判规范的 `agent`。之所以够用：`session/tools.ts:87` 的合并顺序是 `merge(agent.permission, session.permission)`，用户配置进的是 `agent.permission` 而它**每次运行都从 config 重新派生**，规范化一次即无陈旧副本 |
| 持久化 Session 的 `task` 规则不作运行时映射 | 系统生成的 `task: * deny` 与用户意图的同名规则形状完全相同，无法区分。但根 Session 的 `permission` 默认 `undefined`，配置里的 deny 并不进入 session ruleset，只有经 CLI/SDK 显式设过 session 权限再派生子 Agent 才会出现，暴露面窄。记为已知限制（§10 缺口 10），不为它改设计 |
| **`deriveSubagentSessionPermission` 必须改：不再默认拒绝嵌套** | `permission/index.ts:28` 的 `evaluate` 用 `findLast`，合并顺序使 **session ruleset 压过 agent 定义**；而 `subagent-permissions.ts` 给每个子追加 `task: * deny`。两条移植路径都是坏的：仍发字面 `task` ⇒ 规范化后 `canTask` 恒为 false，规则变死码，**agent 定义级 opt-out 静默失效**；移植成 `agent: * deny` ⇒ **每个子都被拒绝 `agent`，深度 3 一次都跑不起来**。正确改法：嵌套上限改由深度计数 + 工具可见性承担，`canTask` 改查 `agent` 键且**不再默认追加 `agent` deny**（`todowrite` 不动）。删掉默认 deny 不等于静默放行——兜底是 `ask`，再由 `agent` 的默认 `*: allow` 接住。这是独立于 `childToolDenies` 的**第二个拒绝点** |
| 移除子 Session 对 `agent` 工具的默认拒绝（`childToolDenies`） | 与上一条相互独立的第一道闸。`task.ts` 对每个子 Session 无条件追加一条 `task: deny`，只改深度不动它，子 Agent 仍一个都派生不出来。Claude Code 用 agent 定义自身的 `tools` / `disallowedTools` 决定能否再派生，默认是给的。`todowrite` 与 `primary_tools` 的拒绝项保持不变 |
| 跨会话越权用工具描述约束，不加强制门 | Claude Code 的 `SendMessage` 原文：「NEVER ask a peer to perform an action that was denied or blocked in your session」。强制方案（目标以发送者∩目标权限的交集执行）要改权限派生逻辑，代价远超收益 |
| Agent 恒为异步，取消 `background` 参数与实验开关 | 前台路径以 `background.wait({ id })` 阻塞，父 Agent 停在那次 tool call 里，发不出任何管理工具——管理面对前台子 Agent 完全不可用。Claude Code 的 `Agent` 同样没有 background 参数。`task` 兼容入口收到旧的 `background: false` 时忽略该参数 |
| 不引入 `model` 参数，继承创建者当次的 model 与 variant | 照既有 `task.ts` 语义：`model = subagent 固定模型 ?? 创建者当次模型`，且**只在 subagent 未固定模型时**才继承 variant。Claude Code 的 `Agent` 有 `model` 参数，本版不做（调研 §16 评审记录） |
| 为每个新 Agent 准备独立工作目录（G6） | 深度提到 3、子 Agent 可再派生、执行恒为异步，三者叠加使多个 Agent 同时改同一份 checkout 从边缘情况变成默认可能。不隔离等于本方案自己制造一个默认危险的配置 |
| **隔离强度：建议式，不是强制** | 首版不切换 per-Session `InstanceState`。`tool/read.ts:236` 是 `path.resolve(instance.directory, filepath)`，`tool/shell.ts:612-613` 默认 cwd 为 `instanceCtx.directory`——运行时默认 cwd **未切换**。准确说法是「默认为 Agent 准备独立工作目录，并通过初始消息要求其显式在其中工作」，**不声称 Agent 无法访问或修改主 checkout**。强制需要按 Session 可判定的文件系统根，而 V1 的 `InstanceState` 以目录为 cache key，换目录即换分片，管理面随之失效。见 issue #33 |
| 工作目录位置在项目内且平铺 | 见 §4.4.1：不换 instance ⇒ `containsPath` 要求它在项目内，否则每次文件访问都弹权限；平铺是因为嵌套时父清理会删掉子的工作。这与 opencode 自身把 worktree 放在 `Global.Path.data` 的约定不同，原因即此 |
| 忽略登记用 `info/exclude` | 仓库本地、从不提交、不出现在 `git status`，`snapshot/index.ts` 已有先例且其 `sync` 保留既有内容；在 common dir，一条覆盖全部工作树；ripgrep 默认尊重。在工作树根写自我忽略 `.gitignore` 是往用户仓库里造文件，已废弃 |
| 工作树基准是创建者建议工作目录的 HEAD | 只继承父已提交到 HEAD 的内容；未提交修改不会出现，需要时父应先提交或显式让子用同一 `cwd`。Claude Code 默认从远端默认分支切，但明确指出子 Agent 需在进行中工作上操作时应改用 `head`——我们正是后者 |
| **`.worktreeinclude` 移出首版** | 它在 opencode 中**并不存在**（全仓仅出现在本设计文档里，是从 Claude Code 搬来的概念），落地要从零写 gitignore 语法匹配器并逐个 `git check-ignore` 确认，是一个子系统而非一行分支。首版让 Agent 按需从主 checkout 用绝对路径读取——建议式隔离本就允许 |
| V1 不自动清理工作目录 | 任何结局都不删、Session 删除不连带删、不做无改动检测 / 运行锁 / 周期 sweep / 清理后重建。累积是明确的已知限制。因此 V1 也不需要用 project sandbox 列表推断所有权 |
| 内部工作树入口不进 HTTP schema | `Worktree.CreateInput` **就是** experimental HTTP 的 payload（`groups/experimental.ts:190`），给它加 `root` 会让客户端指定任意创建位置。改为新增内部专用入口，destinationRoot 由系统固定计算，现有公开 `Worktree.create()` 行为不变；内部复用 candidate/setup/populate 逻辑，但**返回时必须已达 ready 契约** |
| `subagent_depth` 默认由 1 提到 3 | 与 Claude Code 的 `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`（默认 3）对齐，单位相同；现默认 1 恰是 CC 所说的"关闭嵌套"。默认 1 时 Agent 树最多两层，终止通知与自底向上排序都无对象 |
| 触达深度上限时撤下工具，而非让调用失败 | Claude Code 到限时不再向该 Subagent 提供 `Agent`。撤下范围按"寻址集合是否永久为空"判定：`agent` 与 `agent_stop` 撤下，`agent_send` 与 `agent_list` 保留。判据是深度到限，不是当前是否有子 Agent。**边角**：若 `subagent_depth` 被调低，或某深度 3 的 Session 是在上限更高时建的子，它会有子却无 `agent_stop` 可用——此时仍可由更上层停止其祖先 |
| **TUI 权限聚合改为整棵后代（深度改动的必要连带项）** | `tui/src/routes/session/index.tsx:208-213` 的 `children()` 只有一层，`:229-235` 对任何带 `parentID` 的 Session 直接 `return []`。深度 1 时二者等价；提到 3 之后 P → A → B 中 B 的 permission/question **在根视图看不到、在 A 的视图也不显示，该 Agent 永久挂起**。根 Agent 须收集自身 + 全部后代、聚合 pending、回复按 `request.sessionID` 路由。不是新面板，是把过滤条件从一层改为闭包 |
| 不设 `agent_get`，状态并入 roster 每一行 | Claude Code 只有 `ListAgents` 且每行自带 busy/idle；其最接近的 `TaskOutput` 已废弃且按 task_id 寻址、阻塞等待、轮询状态，三者均为调研 §6 排除项 |
| 保留隐藏的 `task` 兼容入口 | 调研 §8：旧插件、权限配置与显式调用仍需可用，但不进模型工具列表；入口把 `task_id` 规范化为 `session_id` 后转发同一实现，并使用规范化后的 `agent` 权限，不成为绕过 |
| 一个 Agent 任一时刻至多一个活动执行 | 调研 §7 的概念定义。这是 `session_id` 足以作唯一标识的前提：允许并行执行则 `agent_stop(session_id)` 无法指明停哪一个，`run_id` 必然回归。机制由 I3 维护 |
| 不引入 correlation ID、per-message output 槽或 `run_id` | `agent_send` 根本不产生结局，自然无需为消息编号。上游 #45480 第 5 项的相反前提已被调研 §10 否决 |

## 7. 架构正确性论证

### goal → 模块映射

```
G1 「列出 Agent 树及状态」   → M1 AgentTree（骨架）+ M2 AgentStatusProjection（状态）+ M5（组装与渲染）
G2 「查询指定 Agent」        → 与 G1 同路径；调用方从 roster 中取行，不单列工具
G3 「邻居间任意方向消息」    → M3 AgentInbox（主）
G4 「停止并保留上下文」      → M4 AgentLifecycle（主）+ M1（直接子判定 + 后代展开）+ M2（状态判定）
G5 「身份统一」              → M5 AgentTools（表面约束）+ M1（身份与名称解析）
G6 「独立工作目录」          → M4 AgentLifecycle §4.4.1（准备）+ M5（在初始消息与 roster 中呈现）
```

### 模块协作论证

**G1/G2**：M1 的后置条件保证 AgentNeighborhood 覆盖父 / 子 / 兄弟三类且有稳定序（三元组排序，
毫秒并列不致换序），即可寻址集合完整；M2 保证每个成员得到 running / idle 之一且二者互斥穷尽；
M5 把两者拼成完整 AgentInfo。故"完整成员集合 × 明确状态"成立，G1 成立。G2 是 G1 在单成员上的投影。

**G3**：G3 要求"邻居间任意方向的消息能被目标处理"。M3 对任一存在的目标 Session 均可投递，
故邻居这一子集必然覆盖。处理保证由现有 Runner 承担：running 时现有 loop 在下一个 provider turn
边界重读历史读到它，idle 时 `prompt_async` 起新 run。两种状态覆盖 AgentStatus 的全部取值。
**限定条件**：该保证受 issue #32 的 lost-wake 窗口影响（§10 缺口 5），故 G3 成立到"投递即被持久化
且在无该窗口时必被处理"这一强度，而非绝对送达。这是既有渠道的既有强度，本 feature 不加强也不削弱。

**G4**：G4 要求"停止且保留上下文，且等待方不被静默挂起"。M4 的后置条件给出前半部分
（终止执行、不删除任何 Session 与历史、可恢复、幂等）。后半部分由 I1 保证：每个**实际发生转变**的
Agent 的父都会收到一次取消通知投递，除非该父自己也在停止集内——那种情况下它同样被停止，
不存在"仍在等待"的主体。未发生转变者本就没有等待方。故不存在被静默挂起的等待方，G4 成立
（同样受缺口 5 限定）。

**G5**：G5 是表面约束而非运行时行为。M5 的后置条件规定了对模型暴露的工具集合与参数命名，
M1 保证所有解析最终都归到 SessionID，实例名只是同一 session 的别名且解析范围不超过调用者
本就能寻址的集合。二者合起来即"不存在第二套身份"，G5 成立。

**G6**：M4 §4.4.1 的三个分支（Git / 非 Git / 显式 cwd）互斥且穷尽地覆盖了工作目录的来源，
ready 契约保证 Agent 启动时目录可用，M5 在初始消息与 roster 中呈现该路径。
**G6 只到"建议"强度**：`workdir.enforced` 恒为 false，运行时默认 cwd 未切换，
故 G6 成立的是"为并行工作提供了一个各自的落脚点并明确告知"，不是"隔离"。见 §6 与 issue #33。

### 关键假设

本段只列本架构**控制不了**的外部前提。属于本 feature 自身概念定义或设计取舍的性质归 §6 决策，
由本架构维护的性质归下方模块级 invariant，已知不成立的性质归 §10 已知缺口。

```
H1: running 是进程内真相。SessionStatus 存于 InstanceState，进程重启后清空。
    因此崩溃前正在执行的 Agent 重启后一律投影为 idle。
    — 来源：既有基础设施；调研 §6「不包含进程崩溃后的自动继续执行」，本架构不提供崩溃恢复。
      重启后进程内所有执行本就已经终止，idle 与事实一致

H2: Session 的 parentID 链无环且深度有限。
    — 来源：子 Session 只在创建时绑定 parentID 且此后不变；深度另有上限约束

H3: 同一 project 的 Agent 创建在同一进程内串行发生。
    — 来源：opencode 每个 instance 一个 server 进程，JS 单线程。
      I4 的名称唯一性依赖它；该前提不成立时唯一性降为 best-effort，
      TargetRef 的"多匹配即不变量损坏"会退化为可达状态
```

以下四条曾被误列为假设，现已归位：

| 原编号 | 内容 | 归位 |
|---|---|---|
| 旧 H2 | 至多一个活动执行 | §6 决策（概念定义）+ I3（机制维护） |
| 旧 H4 | 终止通知接收方仍在运行 | I1 的推论，不再单列 |
| 旧 H5 | 只交付一个最终结果 | 随 M6 删除；`agent_send` 不产生结局，无需该假设 |
| 旧 H6 | 拆解期间不会派生新成员 | §10 已知缺口（本架构未做保证） |

### 模块级 invariant

```
I1: 停止排序不变量
    对任意**实际发生转变**的 Agent a，若 a 的父 p 也在本次停止集内，
    则「a 的取消通知已投递」happens-before「p 被取消」。
    （p 不在停止集内时 p 恒为发起停止者，它全程在运行，无排序要求；
      a 未发生转变时不产生通知，无排序对象。）
    维护方：M4 AgentLifecycle
    preservation：M4 按 StopPlan.layers 自底向上推进，处理第 i 层前必须收齐第 0..i-1 层
      的取消与通知投递。
    **强度声明**：这是"已投递"的排序，不是"已送达"。M3 只保证持久化（I2），
      是否被消费受 issue #32 影响。此前把它写成"已持久化 happens-before 取消"再据此推出
      "父必然收到"是越界的——持久化确实先于取消，但持久化不等于被处理。

I2: 接受即持久化
    M3 返回 Accepted ⇒ 该消息已写入目标 Session。
    维护方：M3 AgentInbox
    preservation：M3 在持久化之后才返回。由此 agent_stop 无法吞掉一条已被接受的消息——
      停止只终止执行，不改写历史。
    **不蕴含**：不蕴含目标已处理、将处理或已被唤醒。

I3: 单活动执行
    ∀ Agent a，任一时刻 a 至多有一个活动执行。
    维护方：本 feature 的概念定义（见 §6）；机制由既有 Session 运行状态机提供，本架构复用不重实现
    preservation：既有运行状态机对每个 Session 持单值状态，第二次运行请求加入已有执行而不并行开新的；
      M3 不新起 run 而是交给 `prompt_async`，后者对 running 目标同样不并行开新的；
      M4 的取消以 Session 为单位。
      本不变量塌陷的代价是回到 run_id（见 §6），故实现阶段须有回归钉住该机制。

I4: 实例名树内唯一
    ∀ Agent 树 T，∀ 名称 n，T 中至多一个 Agent 的 name == n。
    维护方：M1 AgentTree.reserveName
    preservation：创建路径先在树内扫描既有 name 并在同一同步段内占位，检查与占位之间不 await，
      故在 H3 成立时无交错。名称创建后不可修改，且 running / idle / cancelled / completed
      的 Session 都继续占用，Session 被删除后才释放，因此不存在"名称被回收后指向另一个 Agent"
      的窗口。
      本不变量是 TargetRef「多匹配 ⇒ 拒绝」得以成为不可达分支的依据；H3 不成立时它降为
      best-effort，该分支变为可达，届时拒绝仍是正确行为。
```

## 8. 并发规约

```
并发单元：M4 AgentLifecycle.stop

共享资源：
  - Session 运行状态注册表：SessionID → 活动执行句柄
  - 各成员父 Session 的消息历史（持久化）——取消通知写入处

顺序约束（Ordering Constraints）：
  - 对实际发生转变的 a：deliver(a 的取消通知) must happen-before cancel(parent(a))，
    当 parent(a) ∈ 停止集（父不在停止集时它恒为发起者，不会被取消，无约束对象）
  - cancel(layers[i]) must happen-before cancel(layers[i+1])
  - 同一层内的取消可并发，层与层之间串行
  - **状态读取 must happen-before 取消**：先读 SessionStatus 判定 running/idle，
    否则无法区分 transitioned 与 unchanged（`SessionRunState.cancel` 对 idle 是成功空操作）

Rely-Guarantee 条件：
  - Rely（环境承诺）：停止期间不会有外部调用对同一子树发起第二次 stop
    （幂等性使重复 stop 无害，但并发的两次 stop 不保证层序交错后的通知顺序）
  - Guarantee（自身承诺）：stop 只中断执行，不删除 Session、消息或历史；
    不向 unchanged 成员投递通知；不向停止集内已取消的 Agent 投递会使其重新运行的消息

线程安全性结论：
  - M4.stop 在 Rely 成立时安全。并发的同子树 stop 属于已知未覆盖场景，
    首版通过工具层不做并发去重来暴露它，而不是静默容忍
  - **状态读取与取消之间存在固有窗口**：读到 running 后目标可能在取消前自行结束，
    此时该成员被计入 transitioned 并发出一条取消通知，而它其实是正常结束的。
    该窗口无法在不引入跨模块锁的前提下消除；后果是一条措辞偏差的通知，不是状态错乱。
    记为 §10 缺口 11
```

```
并发单元：M3 AgentInbox.deliver

共享资源：
  - 目标 Session 的消息历史
  - 目标 Session 的运行状态

顺序约束：
  - 消息持久化 must happen-before 交给 prompt_async 的后续处理
  - 两条并发 deliver 到同一目标的相对顺序由消息写入顺序决定，不做额外保证

Rely-Guarantee 条件：
  - Rely：目标的 runLoop 每个 provider turn 开始时重读消息历史（`prompt.ts:1093`）
  - Guarantee：deliver 不修改目标 Session 的 agent 与 model 绑定
    （它显式传目标当前值，使 `setAgentModel` 的写回成为恒等写）

线程安全性结论：
  - 安全。两条并发消息可能以任意顺序进入同一个 turn 的上下文，
    这与两个人同时向一个会话打字的既有语义一致，不引入新的竞态类别
```

```
并发单元：M1 AgentTree.reserveName

共享资源：
  - 内存中的名称占位表（按树根分组）

顺序约束：
  - 扫描既有 name 与写入占位必须在同一同步段内完成，中间不得 await

Rely-Guarantee 条件：
  - Rely（H3）：同一 project 的 Agent 创建在同一进程内串行发生
  - Guarantee：占位成功即返回，失败即 AgentNameConflict 且不留下任何痕迹

线程安全性结论：
  - 在 H3 成立时安全：JS 单线程内无 await 的同步段不可被打断。
    H3 不成立（多进程写同一 project）时唯一性降为 best-effort，见 I4
```

## 9. 与 Claude Code 的有意差异

工具集合逐项对应 Claude Code（`Agent` / `ListAgents` / `SendMessage` / `TaskStop`），
但以下语义有意不同，不应被读成处处对齐：

| 项 | Claude Code | 本方案 | 理由 |
|---|---|---|---|
| **消息是否带回复** | `SendMessage` 带回目标的回复（云会话例外条款「cannot message any session back yet — read its answer in its own transcript」反证了常规情况会） | 单向：只回 `accepted`，接收方需回复时再调一次 `agent_send` | 一条消息的"结局"在语义上不存在；强行配一个结局要维护 watcher 所有权、结局去重与取消竞态，买到的东西模型并不需要。见 §6 |
| **结局的不对称** | `Agent` 与 `SendMessage` 都能拿到结果 | `agent` 的初始委托自动回一次结果，`agent_send` 永不回 | 初始委托是创建者交出去的一项任务，有明确完成含义；后续消息没有 |
| 寻址标识 | 名字即地址（名字来自 `subagent_type` 本身），`ListAgents` 每行 `name [ref]`，重名用 `[ref]` 消歧或报错 | `session_id` 为权威标识，可选实例名 `name?` 作为别名；roster 两者都显示 | CC 预期用户在 `.claude/agents/*.md` 里为具体任务定义具体类型，故类型名即实例名；我们把它做成一等参数，扇出时才不歧义。调研 §5.1 定 `session_id` 为权威标识 |
| 模型选择 | `Agent` 有 `model` 参数 | 无，继承创建者当次的 model 与 variant | 首版不做；沿用既有 `task.ts` 的继承语义 |
| 停止范围 | `TaskStop` 按 id 停一个后台任务，文档未述子树级联 | 级联整棵子树，自底向上 | 防止停掉父之后子 Agent 变孤儿继续消耗；备选方案见 issue #26 |
| roster 范围 | `ListAgents` 跨 in-process subagent、teammate、本机其他会话、云端会话 | 仅调用者所在的一棵 Agent 树，且只到邻居 | 调研 §6 明确排除跨互不相关根 Session 的通信与编排 |
| 工作目录隔离强度 | 四项检查：文件编辑不得指向主 checkout、命令 cwd 必须解析到 worktree、git 不得经 `-C`/`--git-dir`/`GIT_DIR`/`GIT_WORK_TREE`/`cd` 重定向、命令形状不可验证时拒绝 | 建议式：准备目录并在初始消息中要求使用，但**运行时默认 cwd 未切换**，不拦主 checkout | 强制需要按 Session 可判定的文件系统根，V1 无此轴；见 issue #33 |
| 工作树基准 | 默认远端默认分支（`fresh`），可设 `head` | 恒为创建者建议工作目录的 HEAD | 子 Agent 需在父的进行中工作上操作，此为 CC 自己给的 `head` 适用场景 |
| gitignored 文件带入 | `.worktreeinclude` | 首版不做 | 该机制在 opencode 中不存在，落地是一个 gitignore 匹配子系统。见 §6 |
| 运行中锁 | `git worktree lock`，防并发清理 | 无 | 首版无并发清理者，且根本不自动清理 |
| 工作目录回收 | 周期性 sweep，按 `cleanupPeriodDays` 且不丢工作时移除 | 无，全部累积待人工清理 | 见 §10 缺口 7 |

## 10. 已知缺口

以下各项在本架构中显式存在，不被本架构修复，实现阶段须单独核对：

1. **拆解期间新派生的后代不在停止集内**。子树展开按一次快照进行，快照之后派生的后代不在集内。
2. **停止后代时的执行现场不可恢复**。停止保留 Session 与历史，但不保留中断点；恢复是从历史继续。
   调研 §6 已将 Suspend 语义列为非目标。
3. **崩溃后 running 退化为 idle**（H1）。本架构不提供崩溃恢复。
4. **移除前台分支会波及既有测试**。前台路径当前承载着子 Agent 错误如何呈现给父 Agent 的一批断言
   （CLI run 相关用例走的就是这条路）。恒为异步后这些用例的观察点从 tool 返回值移到通知消息，
   实现阶段须逐条迁移而非删除。
5. **消息可能被投递但不被消费**（fork issue #32）。`effect/runner.ts:115-119` 的 `ensureRunning`
   对已 Running 的目标丢弃新 work，`finishRun`（`:70-81`）落 Idle 前不检查这期间是否有新消息到达。
   落进该窗口的消息静默滞留，无人被通知。这是既有缺陷，影响 FSM 通知、普通异步消息等**所有**调用方。
   本 feature **不为它造绕行方案，也不依赖它被修复**；修复并行推进，两边文件不重叠。
   `agent_send`、取消通知、完成通知都受其影响，故 I1/I2 的强度到"已投递"为止。
6. **工作目录隔离为建议式**（fork issue #33）。子 Agent 可用主 checkout 的绝对路径绕开它；
   运行时默认 cwd 并未切换。收口依赖 V2 的 Location 作用域。
7. **工作目录会累积**。首版完全不自动清理，需人工用既有 `Worktree.remove` 或 `git worktree remove`。
8. **进程崩溃后工作目录成为孤儿**。无回收机制。
9. **非 Git 项目的工作目录是空的**。不自动复制项目文件，Agent 需自行按需复制；
   若它选择整目录复制，必须排除 `.opencode/worktrees` 以免递归复制自身。
10. **持久化 Session 中的 `task` 规则不被映射**。系统生成与用户意图的同名规则无法区分，
    故一律不映射。暴露面限于经 CLI/SDK 显式设过 session 权限再派生子 Agent 的情形。
11. **状态读取与取消之间的固有窗口**。读到 running 后目标可能在取消前自行结束，
    该成员仍被计入 transitioned 并发出取消通知。后果是一条措辞偏差的通知，不是状态错乱。

## 11. 下一阶段

架构确认后进入 §4.3 细化阶段，更新 `docs/design/agent-management/detailed-design.md`，
需满足 §4.3.1 完整性 6 条与 §4.3.2 函数正确性论证。届时按 §2.3 步骤 2 为契约变更分配 subplan-id，
feature 短称取 `agm`。

实现阶段的回归基准见 `task-inventory.md` 与调研 §16；至少覆盖：
初始委托的一次性结局、`agent_send` 对 running/idle 两种目标均走 `prompt_async` 且只回 accepted、
接收方据前缀中的 session_id 自主回复、`agent_send` 保持目标 agent/model/variant、
`agent_stop` 能停止无 BackgroundJob 的 Agent、idle/重复 stop 落 unchanged 且不发假通知、
深度 0–2 有四工具而深度 3 只有 list/send、legacy `task` 配置被规范化且显式 `agent` 覆盖冲突项、
可选 name 全树唯一且冲突零副作用、target 名称匹配实例名而非类型名、
Git 工作树在文件 ready 后才启动 Agent、非 Git 为同一管理根下的空目录、provided cwd 不自动放行、
任一结局都不自动删除工作目录、三层后代 permission/question 在主 TUI 可见并可回复。
