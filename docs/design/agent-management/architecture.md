# 架构设计 — agent-management

- 状态：架构阶段，**等待再次确认**。2026-09-14 最终评审后第三次实质修订：`agent_send` 改为 fork 投递
  且 `Accepted` 降为 HTTP 204 强度（删除 I2）；`task` 工具删除而非隐藏；实例名降为弱别名
  （删除 I4、H3）；`agent_stop` 删除状态审计且只发一条向上通知（删除 I1）；
  新增子 Agent 列表 reminder；工具可见性移到工具列表生成期。
- 工具表面：四个（调研 §12 撤销 `agent_get`；§13 把恢复统一交给 `agent_send`）
- 日期：2026-09-04，末次修订 2026-09-14
- 对应问题：[lihaokun/opencode#23](https://github.com/lihaokun/opencode/issues/23)
- 上游依据：`docs/research/agent-management-research.md`（§16、§17 为后续修订，以 §17 为准）
- 代码基线：`dev` @ `a4293ca229`

## 1. 范围与目标

| 编号 | 目标 | 调研出处 |
|---|---|---|
| G1 | 可靠列出当前 Agent 树及各成员状态 | §1 缺口 1 |
| G2 | 查询指定 Agent 的身份、关系与状态 | §1 缺口 2；由 roster 行承载，不单列工具（§12） |
| G3 | 邻居（父 / 子 / 兄弟）间任意方向的直接消息 | §1 缺口 3；范围见 §14 |
| G4 | 主动停止不再需要或失控的 Agent，保留上下文 | §1 缺口 4 |
| G5 | 身份统一为可寻址、可恢复的 Session，消除 `task_id` 的语义错位 | §1 缺口 5 |
| G6 | 为每个 Agent 准备独立工作目录，降低并行改同一份 checkout 的冲突 | §15、§16.10–16.11 |

非目标沿用调研 §6。本文档额外承担调研甩给架构阶段的四笔欠账：工具 schema（§4.6）、
状态枚举（§3 `AgentStatus`）、停止级联与终止通知契约（§4.4）、消息交付顺序（§4.3）。

## 2. 核心流程

四个工具共用一条骨架：**解析目标 → 权限判定 → 执行 → 渲染**。差异只在第三步。

```
模型
 └─ M5 AgentTools（唯一对模型暴露的表面：四个工具 + 子 Agent 列表 reminder）
     ├─ 解析：M1 AgentTree     ← Session store 的 parentID 链
     ├─ 权限：M5 ctx.ask（key = agent）+ M1 直接子判定（仅 agent_stop）
     └─ 执行：
         agent           → M4 create（建工作目录 → 建 Session → 起初始委托）
         agent_list      → M1 neighborhood（skeleton）+ M2 of（状态）→ M5 组装 AgentInfo
         agent_send      → M3 deliver（fork 进普通异步消息入口，只回 accepted）
         agent_stop      → M4 stop（自底向上无条件 cancel → 向 caller 发一条 cancelled）

     上下文注入：M5 roster —— 每轮比较，变化时落盘一条子 Agent 列表
     自动结局交付：只有 agent 的初始委托有，复用既有 runTask 分类与 notify/inject
```

四条值得单独展开的路径：

**消息投递（G3）**：`agent_send` 把发送者标识拼进正文首行，以**目标 Session 自己的身份**
调用普通异步消息入口，并**把该调用 fork 出去**——异步性来自这个 fork，不在 `prompt()` 里
（`prompt()` 在 `noReply !== true` 时 `return yield* loop(...)`，会阻塞到目标整轮结束）。
目标状态完全交给现有 Runner：running 时现有 loop 在下一个 provider turn 边界读到它，
idle 时自然起新 run。调用方只拿到 `accepted`——**不自动回复、不承诺返回结果、不建 BackgroundJob、
不注册 watcher**，且 `accepted` **不保证消息已持久化**（见 §3 `Accepted`）。

**创建（G6 + G3 的起点）**：`agent` 准备工作目录（ready 后）→ 建子 Session（创建时即持久化
已解析的 agent/model/variant）→ 用**既有初始委托路径**起一次后台执行。这一条**保留自动结局**：
跑完后按既有六分支分类，向创建者**至多发起一次** completed/error 通知。
初始执行期间收到的 `agent_send` 只是追加消息，仍由该初始执行交付那一次结果。

**停止（G4）**：`agent_stop` 由 M1 解出目标子树并按深度分层，自底向上对每个成员**无条件**调
`SessionRunState.cancel`——不预读状态、不分类。**只有 `target` 发一条 `cancelled` 通知给 `caller`**；
递归取消的后代不发任何通知（它们的父都在停止集内，自己也在被停，没有在等的主体）。

**上下文注入**：每轮比较当前直接子列表与可见历史中最近一条 roster，**变化时落盘一条**。
它补上"后代被停但父没被通知"所丢的信息，并使被 issue #32 吞掉的完成通知降级为一轮延迟。

## 3. 核心数据结构

均为跨模块共享类型。本 feature 未启用 product 层，按 §2.4 写在本节。

```
数据结构：AgentStatus

字段：
  - value: "running" | "idle" — Agent 此刻是否有活动执行

类型不变量：
  - 取值封闭于上述两个字面量；二者互斥且穷尽

语义：
  - running    进程内存在该 Session 的活动执行（SessionStatus 为 busy 或 retry）
  - idle       无活动执行

不表达终态：执行的结局不进入本枚举。roster 只回答"此刻还在跑吗"。

跨模块共享性：跨模块共享 — consumer: M2（产出）、M5（渲染）
```

```
数据结构：AgentSkeleton

定义：AgentSkeleton = Omit<AgentInfo, "status">

存在理由：status 不属于 M1 的观测域。M1 只能从 Session store 读出身份与关系，
  读不出"此刻在不在跑"。让 M1 返回一个 status 字段为空或伪造的 AgentInfo，
  等于让它声称构造了它构造不出的东西。

类型不变量：
  - 与 AgentInfo 除 status 外逐字段相同

跨模块共享性：**跨模块共享** — producer: M1 AgentTree；consumer: M5 AgentTools、M4 AgentLifecycle
  （它出现在 M1→M5 与 M1→M4 的接口上，按 §2.4 的判定即为跨模块共享，不是模块私有）
```

```
数据结构：AgentInfo

字段：
  - session_id: SessionID — Agent 的唯一权威标识，即现有 SessionID
  - parent_id: SessionID | undefined — 父 Agent；undefined 表示该 Agent 是树根（主 Agent）
  - name: string | undefined — 可选实例名，取自 Session.Info.metadata.agentName
  - agent_type: string | undefined — Agent 定义类型，取自 Session.Info.agent；
    可空，因为该字段本身是 optional（尤其是尚未绑定 agent 的根 Session）
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
  - **name 不保证唯一**：并发创建可能产生重名（见 §6「实例名是弱别名」）
  - workdir.enforced 恒为 false：运行时默认 cwd 未切换，该路径只是建议

唯一性 / 标识：
  - session_id 全局唯一，且是本 feature 的**权威**公开标识（调研 §5.1）
  - name 是可选弱别名，指向同一个 session，不构成第二套身份，且可能指向多个

装配责任：
  - M1 产出 AgentSkeleton（不含 status）
  - M5 对每个成员调 M2 取 status，此时才组装出完整的 AgentInfo
  - **create 不产出完整 AgentInfo**：它无法诚实地回答 status（见 §6「创建不返回实时状态」）

生命周期：
  - 创建：M4 AgentLifecycle.create 创建子 Session 时产生
  - 修改：status 为投影值不落库；name 创建后不可修改；其余字段随 Session 变化
  - 删除：本 feature 不删除 Session；Agent 停止后仍可查

跨模块共享性：跨模块共享 — consumer: M1（产出 skeleton）、M2（供 status）、M5（组装并渲染）
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
  - members: **AgentSkeleton[]** — 调用者的邻居，含调用者自身

类型不变量：
  - caller ∈ members.map(session_id)
  - ∀ m ∈ members, m.relation ∈ {self, parent, child, sibling}，且恰有一个成员 relation == self
  - 邻居集合的定义：
      parent  = caller.parent_id 对应的 Agent（caller 为主 Agent 时不存在）
      child   = parent_id == caller 的全部 Agent
      sibling = parent_id == caller.parent_id 且 ≠ caller 的全部 Agent（caller 为主 Agent 时为空）
  - 不含祖父、孙、叔伯、侄、堂兄弟等任何非邻居成员（调研 §14）
  - members 按 **(relation, time_created, session_id)** 升序。三元组而非二元组：
    毫秒级 time_created 会并列，并列时无稳定第三键会让 roster 每次渲染换行序

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
     匹配 `name` 相等者，候选集合排除调用者自身：
     - 恰一个 ⇒ 取之
     - 零个   ⇒ 失败 TargetNotResolved{ value, matches: [] }
     - **多个 ⇒ 失败 TargetNotResolved{ value, matches: [...全部候选] }。
       不发送、不停止、不择一、不广播，要求调用方改用 session_id。**

类型不变量：
  - 名称只匹配 `name`，**不匹配 `agent_type`**：类型标识的是 Agent 定义而非实例，
    用它寻址在同类型多实例（扇出，本方案的主用法）时必然歧义
  - 名称解析只在调用者自己的可寻址集合内进行，不扩大寻址范围：
    `agent_send` 仍可对任意存在的 Session 用 session_id 直投，但名称只解析邻居；
    `agent_stop` 的名称只解析直接子，与其 session_id 形式的约束一致
  - session_id 始终是规范形式；名称是**弱**别名，可能匹配零个、一个或多个
  - **多匹配是正常可达分支**，不表示存储损坏（名称不再有唯一性不变量，见 §6）

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
  - 不要求 target 是 sender 的邻居，也不要求同树：消息不转移权限，目标始终在它自己
    Session 的权限下行动。寻址范围由"调用者只从 roster 拿得到邻居的标识"自然收敛（调研 §14）
  - 落库文本 = 系统前缀 + "\n\n" + body，前缀格式固定为：

      [Agent message from <sender_name> (<sender_agent>, <sender>)]
      To reply, use agent_send(target="<sender>", message="<your reply>").

    sender_name 缺省时省略该段；**回复说明恒用 session_id，不用 name**——
    session_id 在任何解析范围下都可用、且不会歧义，而 name 是弱别名
  - 调用方无法覆盖或伪造前缀（调研 §5.3）
  - 本结构**只服务 `agent_send` 与停止通知**：新 Agent 的初始任务不经它（见 §4.4）

生命周期：创建于 M3 deliver；不可变；随 Session 历史存续

跨模块共享性：跨模块共享 — consumer: M3（产出并投递）、M4（停止通知复用同一投递语义）
```

```
数据结构：Accepted

字段：
  - target: SessionID — 消息的投递目标

类型不变量：
  - 强度**与现有 HTTP 204 一致**：异步请求已被接受 / 已被调度
  - **不保证**：返回前消息已持久化、已处理、将被处理、或已被回复
  - 不携带目标的执行结果

为什么这么弱：投递复用现有异步消息入口，而那条路径的异步性来自外层 fork
  （handler 是 `prompt(...).pipe(catchCause(...), forkIn(scope))` 后直接返回 NoContent）。
  fork 内的失败只发 `Session.Event.Error`，调用方那时已经拿到 accepted 了。
  此前把它写成「Accepted ⇒ 已持久化」并据此推导停止排序与防复活，是把一个 204 当成了 200。

跨模块共享性：跨模块共享 — consumer: M3（产出）、M4（停止通知复用）、M5（渲染）
```

```
数据结构：DelegationOutcome

作用域：**只用于 `agent` 的初始委托**。`agent_send` 不产生本结构。

字段：
  - kind: "completed" | "failed" | "cancelled" — 初始委托的结局
  - text: string — 交给创建者的正文

语义与判定顺序（照既有 task 执行体逐条复制，不简化）：
  1. 返回的不是 assistant 消息                      ⇒ failed，正文说明协议异常
  2. error.name == "MessageAbortedError"           ⇒ cancelled（cancelled 的唯一自然来源）
  3. error 存在，或 finish == "length"              ⇒ failed，正文为既有 assistant 失败渲染
  4. 最后一个 tool part 状态为 error                ⇒ failed，正文为既有 subagent 工具失败渲染
  5. finish 缺失或为 "unknown"，且无可用输出         ⇒ failed，正文为既有 incomplete 渲染
  6. 以上皆否                                       ⇒ completed，正文取**最后一条** text part

映射到执行出口（结算状态由 run 体的 Effect exit 推出，不另设信息通道）：
  - 第 6 条        ⇒ 成功出口 ⇒ 结算 completed，正文进 output
  - 第 1、3、4、5 条 ⇒ 失败出口，正文即失败文本 ⇒ 结算 error，正文进 error
  - 第 2 条        ⇒ 中断出口 ⇒ 结算 cancelled

类型不变量：
  - 六条按序求值，先命中者胜；覆盖穷尽，不存在落空的初始委托
  - 第 2 条必须先于第 3 条求值：MessageAbortedError 本身也是一种 error，
    顺序颠倒会把取消误报为失败，且结算成 error 而非 cancelled
  - **text 允许为空字符串**：既有 `lastVisibleText` 是
    `parts.findLast((p) => p.type === "text")?.text ?? ""`，纯工具调用完成时合法返回空串。
    既然复用既有分类，就必须允许 `{kind:"completed", text:""}`，不虚构 fallback
  - 正文长度受既有截断上界约束

跨模块共享性：跨模块共享 — consumer: M4（产出并交付）、M5（渲染）
```

```
数据结构：StopOutcome

字段：
  - stopped: SessionID[] — 本次对其成功执行了 cancel 操作的成员
  - failed: { session_id: SessionID, reason: string }[] — cancel 过程中出错的成员及原因

类型不变量：
  - stopped ∪ failed.map(session_id) = ⋃ StopPlan.layers，二者不交
  - **stopped 不表示"本次由 running 转成 cancelled"**，只表示"对它执行了停止操作"。
    `SessionRunState.cancel` 对无 runner 的 Session 是成功空操作，事后无法区分两种情形；
    读状态再取消同样测不准（读到 running 之后、cancel 之前目标可能自行结束）。
    与其假装测得准，不如不报告这个维度
  - 不设 transitioned / unchanged 分类，不做状态审计
  - failed 非空 ⇒ M5 必须逐条呈现，不得静默丢弃
  - 不设 notified 字段：通知恒为一条、恒发给 caller，无需逐成员记录

跨模块共享性：跨模块共享 — consumer: M4（产出）、M5（渲染）
```

```
数据结构：本 feature 的失败类型

字段：
  - AgentNotFound       { session_id }              目标 Session 不存在
  - AgentTypeNotFound   { subagent_type }           创建时指定的 agent 定义不存在
  - AgentNameConflict   { name }                    创建时已在树内看见同名 Agent
  - NotAChild           { caller, target }          agent_stop 的目标不是调用者的直接子
  - SelfDelivery        { target }                  agent_send 的目标是发送者自己
  - DepthLimitReached   { depth, limit }            创建时已达嵌套上限
  - TargetNotResolved   { value, matches: SessionID[] }  名称解析失败；
                                                    matches 为空表示未找到，长度 > 1 表示歧义
  - WorktreeUnavailable { reason, paths?: string[] } 工作目录准备失败；paths 给出可能的残留

类型不变量：
  - 八者互斥，均为可预期的调用方错误，不用于表达内部缺陷
  - M1/M3/M4 只产出这些类型，不吞错也不转成 undefined
  - M5 是唯一把它们渲染为模型可读文本的地方
  - AgentNameConflict **不返回既有同名 Agent 的 session_id**——返回等于把"创建"静默改成"复用"
  - **WorktreeUnavailable 只保证不创建 Session、不投递初始 prompt、不启动 Agent**。
    已产生的 info/exclude 修改、目录、分支或半成品 worktree **可以残留**，在 paths 中给出。
    V1 本就不自动清理，承诺零文件系统副作用会逼出一套回滚逻辑，收益不抵成本

跨模块共享性：跨模块共享 — producer: M1、M3、M4；consumer: M5 AgentTools
```

```
数据结构：StopPlan

字段：
  - target: SessionID — 停止的子树根
  - layers: SessionID[][] — 按深度分层的成员，layers[0] 为最深层，末层为 target 自身
  - notify_boundary: SessionID — target 的父 Agent，即发起停止者；
    **本次停止唯一的通知接收方**

类型不变量：
  - ⋃ layers = target 的后代闭包 ∪ {target}
  - ∀ i < j，layers[i] 中成员的 depth > layers[j] 中成员的 depth（自底向上）
  - layers 末元素恰为 [target]
  - notify_boundary ∉ ⋃ layers（因 target 必是发起者的直接子，其父即发起者）
  - 由上一条：**唯一的通知接收方恒在停止集之外**，因此不可能被这条通知"唤醒"——
    它正在执行本次 agent_stop 调用，全程醒着

跨模块共享性：模块私有 — 仅 M4 使用
```

```
数据结构：SubagentRoster

字段：
  - text: string — 渲染成一行的直接子列表

类型不变量：
  - 只含**直接子**，不含父与兄弟（后两者与本 Agent 的决策关系不大，agent_list 随时可查）
  - 每项含 session_id、name（若有）、agent_type、status
  - 无直接子时不产出本结构（不注入任何内容）
  - 带一个固定前缀行作为识别标记，使下一轮能在历史中定位最近一条

跨模块共享性：跨模块共享 — producer: M5 AgentTools；consumer: 既有 SessionReminders 注入点
```

## 4. 模块划分与功能规约

**五个模块**。M1–M4 是机制，M5 是唯一对模型暴露的表面（四个工具 + roster 注入）。

### 4.1 M1 AgentTree

```
模块名称：AgentTree

功能描述：解析调用者的邻居集合（父 / 子 / 兄弟）与直接子集合，承担 `agent_stop` 的直接子判定，
  把 `TargetRef` 解析为 SessionID。另提供后代闭包供 M4 的停止级联使用——
  那是效果范围，不是寻址范围。

前置条件（Requires）：
  - 入参 session_id 对应的 Session 在 store 中存在
  - Session 的 parentID 链无环（由 Session 创建路径保证，见 §7 H2）

后置条件（Ensures）：
  - neighborhood(id) 返回的 AgentNeighborhood 满足其类型不变量，成员为 **AgentSkeleton**
    （不含 status —— status 不属于本模块的观测域，由 M5 调 M2 补齐）
  - children(id) 返回 parent_id == id 的全部 Agent
  - descendants(id) 返回 id 的全部后代，不含 id 自身；仅供 M4 展开停止级联
  - isChild(caller, target) ⟺ target ∈ children(caller)
  - resolveTarget 按 §3 `TargetRef` 求值；名称只在调用者的可寻址集合内匹配，
    故解析结果必属于调用方本就能寻址的范围，不扩大任何工具的作用域
  - resolveTarget 的候选集合排除调用者自身
  - **多匹配时返回全部候选并失败，不择一**

不变式（Invariants）：
  - **只读**：本模块不写任何状态。名称唯一性不再由本模块维护（见 §6），
    因此不存在 reservation 表之类的内存写入

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

**为什么状态只有两值**：调研 §5.5 只要求区分"当前确实在运行"与"存在但没有活动执行"。
Claude Code 的 `ListAgents` 同样只给 busy / idle。本模块**不读 `BackgroundJob`**——
经 `agent_send` 恢复的 Agent 可能正在运行却没有任何 BackgroundJob，`SessionStatus` 是唯一正确来源。

**本模块不服务 `agent_stop`**：停止不再预读状态（见 §4.4）。它只服务 `agent_list` 与 roster。

### 4.3 M3 AgentInbox

```
模块名称：AgentInbox

功能描述：构造带系统发送者前缀的消息，以目标 Session 自身的身份**fork 进**普通异步消息入口。
  **这是消息，不是调用**：不等待、不回复、不注册任何后续。

前置条件（Requires）：
  - message 满足 AgentMessage 的类型不变量
  - 目标 Session 存在（由本模块校验）

后置条件（Ensures）：
  - 消息携带的 agent / model / variant **显式取自目标 Session 当前持久化的值**，不取自调用者，
    也不省略（理由见下）
  - 投递调用被 **fork** 出去，本模块不等待它完成
  - 返回 Accepted —— 其强度见 §3：已接受 / 已调度，**不保证已持久化或将被处理**
  - 目标的 running / idle 由现有异步入口与 Session Runner 处理，
    **本模块不判断目标状态，也不手工启动执行**
  - 不自动回复、不承诺结果、不建 BackgroundJob、不注册 watcher

不变式（Invariants）：
  - 本模块不持有任何跨调用状态

副作用：（异步地）写入目标 Session 一条 user message，并按普通异步消息语义触发其处理
```

**为什么必须 fork**：`session/prompt.ts:1069-1070` 是

```ts
if (input.noReply === true) return message
return yield* loop({ sessionID: input.sessionID })
```

直接 await 会阻塞到目标整轮结束——那就把单向消息变成了 RPC。而 `noReply: true` 也不是解法：
它只落库不跑 loop，idle 的目标永远不会启动。HTTP handler 的做法才是对的：
`prompt(...).pipe(catchCause(...), forkIn(scope, { startImmediately: true }))` 后直接返回。
本模块照此实现，**并在 fork 内 catch**，否则失败会逃逸成 defect。

**身份取自目标而非调用者，且必须显式传**：`prompt.ts:636-690` 的解析优先级是
`input.model ?? agent 定义的 model ?? Session 当前 model`，不传 `agent` 时回落到**默认 agent**，
解析结果还会经 `setAgentModel` **写回 Session 行**。因此省略任一项都会把目标的身份改掉并存下来。
`setAgentModel` 存的是 `variant ?? "default"`，回传时 `"default"` 必须省略，否则来回一趟会把它钉死。

### 4.4 M4 AgentLifecycle

```
模块名称：AgentLifecycle

功能描述：创建 Agent 并起其初始委托；停止目标 Agent 及其后代的当前执行。
  恢复既有 Agent 不经本模块，由 M3 承担（调研 §13）。

前置条件（Requires）：
  - create: 目标 agent 定义存在；未超过 subagent 深度上限；
    调用者的 model 与 variant 由 M5 从工具上下文读出后作为参数传入
  - stop: 调用方已通过 M1 的直接子判定；target 存在

后置条件（Ensures）：
  - create 在开始时 **Session.get(caller) 取回真实父 Session**，使用其 permission 与
    metadata.agentWorkdir；不接受只有 SessionID 却当对象用
  - create **不直接引用工具上下文**（`ctx.messageID` / `ctx.metadata` 等）：
    读上下文是 M5 的职责，M4 只接收窄数据
  - create 总是新建一个以调用者为 parentID 的子 Session，不复用既有 Session
  - create 在 `Session.create` 时就**持久化已解析的 agent / model / variant**，
    不等首个异步 prompt 才绑定
  - create 的初始任务走**既有初始委托路径**，不经 AgentMessage：
    `resolvePromptParts(prompt)` 返回的是 `parts[]`（含展开的 @file 附件），必须原样交给该路径
  - 初始任务前置一个 text part 声明该 Agent 的**建议工作目录**绝对路径
  - create 起一次后台执行，结束后向**创建者**至多发起一次 `DelegationOutcome` 通知
  - create **不返回实时 status**（见 §6）
  - 工作目录准备必须在启动 Agent **之前**达到 ready；失败则 WorktreeUnavailable，
    保证不建 Session、不投 prompt、不启动 Agent，**但允许文件系统残留**
  - **不为任何目录预置权限放行**
  - stop 对 ⋃ StopPlan.layers 中每个成员**无条件**调 `SessionRunState.cancel`：
    有 run 则停止，无 run 则由既有 cancel 自然 no-op。**不预读状态、不分类**
  - stop 只向 `StopPlan.notify_boundary`（即 caller）发**一条** cancelled 通知，
    **递归取消的后代不发任何通知**
  - stop 不删除任何 Session、消息、历史或工作目录；stop 后目标仍可经 agent_send 恢复
  - stop 幂等：cancel 本身幂等；重复显式调用可以再次产生一条操作通知，
    不为通知去重增加状态
  - 对 layers 的处理自底向上——**只是发起顺序，不承担正确性**

不变式（Invariants）：
  - 无（原 I1 停止排序不变量已删除，理由见下）

副作用：创建 Session 与工作目录；启动 / 中断后台执行；向 caller 写入一条通知
```

**为什么只发一条通知，且为什么这样就不需要排序**：

```
停止集 = target + 它的全部后代
集合内每个成员的父都在集合内 —— 除了 target，它的父是 caller
⇒ 只有 target 需要向上通知，接收方是 caller
```

`caller` 恒在停止集外（`StopPlan` 不变量），且正在执行本次 `agent_stop`，**全程醒着**。
于是唯一被通知的对象不可能被这条通知唤醒——**复活路径彻底不存在**。
原 I1「a 的取消通知已持久化 happens-before p 被取消」随之删除：它本来是为了防止
"孙的取消通知复活刚被停掉的子"，而现在根本不给子发通知。

反过来说，评审建议的"给每个成员的父都发通知、接受迟到通知唤醒已取消的父"不可取：
投递是 fork 的，外层不等它就去 cancel 父，**落在前后是掷硬币**，不是极窄调度。

**后代不通知丢的信息由 roster 补**：父被唤回时，下一轮 §4.5 的 roster 就显示子已 idle。

**为什么不预读状态**：`session/run-state.ts:77-86` 的 `cancel` 对无 runner 的 Session 是
成功空操作，事后分不出"本来在跑、现已取消"与"本来就 idle"。而**先读再取消同样测不准**——
读到 running 之后、cancel 之前目标可能自行结束。与其假装测得准，不如不报告这个维度。

**为什么终止通知仍然存在**：取消不能静默结束。它复用完成/失败的同一条通道与同一个状态词
`cancelled`（调研 §5.4），强度同为"至多发起一次"。

#### 4.4.1 工作目录准备（G6）

```
未给 cwd + Git 项目：
  destination = <项目目录>/.opencode/worktrees/<slug>          ← 平铺，不嵌套
  baseDirectory = 父 Session 的 metadata.agentWorkdir.path ?? instance directory
  baseCommit    = git -C <baseDirectory> rev-parse HEAD
  git worktree add -b <branch> <destination> <baseCommit>
  → 必须等 tracked files checkout 完成（ready 契约）
  source = generated_git_worktree

未给 cwd + 非 Git 项目：
  同一管理根下建普通空目录，不复制任何项目文件
  初始消息同时给出 source directory 与空 workspace directory
  source = generated_empty_workspace

给了 cwd：
  不创建任何东西，直接把该路径作为建议工作目录
  source = provided_cwd

忽略登记（Git 项目）：
  经 git rev-parse --path-format=absolute --git-path info/exclude 定位，
  读回既有内容后追加 /.opencode/worktrees，已存在则跳过
```

**ready 契约是硬要求**。`worktree/index.ts:281-292` 的 `createFromInfo` 是
`setup()`（`git worktree add --no-checkout`，**目录里没有文件**）后把 `boot()`（`git reset --hard`）
**fork 出去**，`Worktree.create()` 返回时工作树是空的。本 feature 的入口必须在返回时满足
"目录存在且 tracked files 完整可读"。

**位置必须在项目内，而且是被迫的**。opencode 现有 worktree 建在
`Global.Path.data/worktree/<projectID>`，在项目之外；它不需要 `external_directory` 是因为
**现有 worktree 是独立 instance**。而子 Agent **不换 instance**，
`project/instance-context.ts:18-24` 的 `containsPath` 只查 `ctx.directory` 与 `ctx.worktree`、
**不查 sandbox**，放在全局数据目录会让每次文件访问都弹权限。**不换 instance ⇒ 必须放项目内。**

**必须平铺**。若嵌在创建者自己的工作树内，父被清理时会连同子的工作一并删除。

**忽略用 `info/exclude`**。仓库本地、从不提交、不出现在 `git status`；
`snapshot/index.ts:186-193` 已有先例且其 `sync` 读回既有内容再追加；它在 common dir，
一条覆盖主 checkout 与全部子工作树；ripgrep 默认尊重它。

**内部入口不进 HTTP schema**。`Worktree.CreateInput` **就是** experimental HTTP 的 payload
（`groups/experimental.ts:190`），给它加 `root` 会让客户端指定任意创建位置。

**V1 不自动清理**。任何结局都不删，Session 删除不连带删除。

### 4.5 M5 AgentTools

```
模块名称：AgentTools

功能描述：四个模型可调用工具的参数 schema（§4.6）、权限门、上下文读取、输出渲染，
  以及**子 Agent 列表的上下文注入**；本 feature 唯一对模型暴露的表面。

前置条件（Requires）：
  - 工具调用发生在某个 Session 的工具执行上下文中，调用者 SessionID 可知
  - roster 注入发生在 runLoop 的 reminder 阶段，可见历史与 Session 可知

后置条件（Ensures）：
  - 对模型暴露且仅暴露 agent / agent_list / agent_send / agent_stop（调研 §12）
  - **`task` 工具已删除**：运行时 tool ID 只剩 `agent`，不保留隐藏可执行别名。
    旧权限配置键 `task` 在读取时规范化为 `agent`；历史 transcript 的 `task` tool part
    继续在展示层可读；旧插件新发起的 `task` 调用按未知工具处理
  - **上下文读取在本模块**：从 `ctx.sessionID` / `ctx.messageID` 取调用者当次的 model 与 variant，
    作为窄数据传给 M4；`ctx.metadata(...)` 在 M4 返回后由本模块调用，
    且记录的是**子 Agent 实际解析后的 model**，不是父的继承候选
  - agent_list 对 neighborhood 的每个 skeleton 调 M2 取 status，此时组装完整 AgentInfo 并渲染；
    roster 同时显示 session_id 与 name
  - agent_send 只校验非自投递；目标存在性由 M3 校验
  - agent_stop 在目标不是调用者的直接子时失败，不产生副作用
  - **工具可见性在工具列表生成期计算**（见 §6），不在执行期
  - `agent` 经 `ctx.ask({ permission: "agent", patterns: [subagent_type], always: ["*"] })` 求值；
    默认 `*: allow` 使其不弹窗，但 deny 与显式 ask 仍生效
  - agent_list / agent_send / agent_stop 不新增逐次确认
  - **roster 注入**：每轮渲染当前直接子列表，与可见历史中最近一条 roster 比较，
    不同或不存在则**落盘**一条；无直接子则不注入

不变式（Invariants）：
  - 权限判定先于任何副作用；判定失败的调用不写入任何消息、不中断任何执行

副作用：委托给 M1–M4；roster 注入写入一条 synthetic part
```

**权限的不对称**：`agent_send` 可发给任一邻居，`agent_stop` 只能停直接子。
理由是破坏性不同——投递一条消息由接收方自行决定如何处理；停止则单方面中断对方的执行。

**roster 为什么在 M5**：它是模型看得见的东西，与四个工具同属"对模型暴露的表面"。
它不是新的执行机制，只是把 M1+M2 已有的读取结果按既有 reminder 通道呈现。

### 4.6 工具 schema

```
工具：agent
  description:    string    — 3-5 词的任务简述，用于 roster 与 UI
  prompt:         string    — 交给该 Agent 的任务正文
  subagent_type:  string    — agent 定义名
  name?:          string    — 可选实例名，**弱别名**：创建时无锁检查，不保证全局唯一；
                              创建后不可修改，不得以 `ses` 开头。省略则只能用 session_id 寻址
  cwd?:           string    — 指定工作目录；给出则使用它，不创建工作目录
返回：已创建并启动的说明，含 session_id / name / 建议工作目录。**不含实时 status**

工具：agent_list
  （无参数；范围恒为调用者的邻居：父、子、兄弟）
返回：每行含 session_id / name / agent_type / relation / status / title / workdir

工具：agent_send
  target:         string    — session_id，或调用者邻居中某个 Agent 的实例名
  message:        string    — 正文；系统前缀由 M3 添加，调用方不可覆盖
返回：accepted（已接受/已调度，不保证已送达或将被处理）

工具：agent_stop
  target:         string    — session_id，或调用者直接子中某个 Agent 的实例名
返回：StopOutcome（stopped / failed 两段）
```

## 5. 模块间接口规约

```
接口：M5 AgentTools → M1 AgentTree

输入数据：caller: SessionID，target: SessionID | undefined，TargetRef + scope（resolveTarget）
输出数据：AgentNeighborhood（成员为 AgentSkeleton）/ AgentSkeleton[]（children、descendants）/
  boolean（isChild）/ SessionID（resolveTarget）

协议约定：
  - 调用方责任：caller 取自工具执行上下文，不接受模型提供的值；调用 resolveTarget 时声明 scope；
    **status 由调用方另行向 M2 取并组装**，不得期待 M1 返回它
  - 被调用方责任：目标不存在、不是直接子、名称零匹配或多匹配时返回明确的否定结果；
    多匹配必须带回全部候选，不得择一
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
输出数据：Accepted

协议约定：
  - 调用方责任：sender 由系统填写；body 为模型提供的正文
  - 被调用方责任：**fork 后即返回**，不得等待目标处理，不得注册任何后续回调；
    返回的 Accepted 只表示已接受/已调度
```

```
接口：M5 AgentTools → M4 AgentLifecycle

输入数据：
  - create: { caller, name?, subagent_type, description, prompt, cwd?, model, variant }
    ——**全部为窄数据**，M4 不接触工具上下文；M4 自行 Session.get(caller) 取父的
      permission 与 metadata
  - stop: caller: SessionID，target: SessionID
输出数据：创建结果（**不含实时 status**）/ StopOutcome

协议约定：
  - 调用方责任：model 与 variant 由 M5 从 `ctx.messageID` 指向的 assistant 消息读出后传入；
    后代判定已通过（stop）；`ctx.metadata(...)` 由 M5 在 create 返回后调用
  - 被调用方责任：stop 返回时 StopPlan 全部层已处理完毕；部分失败必须显式报告；
    create 的失败保证不建 Session / 不投 prompt / 不启动 Agent，**但不保证无文件系统残留**
```

```
接口：M4 AgentLifecycle → M3 AgentInbox（停止通知）

输入数据：AgentMessage（target = StopPlan.notify_boundary，body = cancelled 通知正文）
输出数据：Accepted

协议约定：
  - 调用方责任：**每次 stop 只投递一条**，目标恒为 notify_boundary；
    不对停止集内的任何成员投递
  - 被调用方责任：与普通消息投递一致；只表示已接受/已调度
```

```
接口：M5 AgentTools → 既有 SessionReminders（roster 注入）

输入数据：已过滤的可见历史 messages、当前 Session
输出数据：SubagentRoster | undefined

协议约定：
  - 调用方责任（M5）：判据必须基于**已过滤**的可见历史，不得基于原始历史——
    这样压缩之后自动重发，无需特判
  - 被调用方责任（既有通道）：用 `sessions.updatePart` **落盘**，不用纯内存 push
    （理由见 §6「roster 必须落盘」）
```

## 6. 关键设计决策

| 决策 | 理由 |
|---|---|
| 唯一权威标识用 `session_id` | 调研 §4.2 已否决 `run_id`；Agent 的上下文、历史、父子关系本就存在 Session 上 |
| `agent_send` 是消息，不是调用 | 不自动回复、不承诺结果、不建 BackgroundJob、不注册 watcher，调用方只收 `accepted`。一条消息的"结局"在语义上不存在——接收方可能只是把它读进上下文继续原任务 |
| **投递必须 fork，不能 await `prompt()`** | `prompt.ts:1069-1070` 在 `noReply !== true` 时 `return yield* loop(...)`，直接 await 会阻塞到目标整轮结束，把单向消息变成 RPC。`noReply: true` 也不行——只落库不跑 loop，idle 目标永不启动。照 HTTP handler：`prompt(...).pipe(catchCause(...), forkIn(scope, {startImmediately: true}))`，**且必须在 fork 内 catch** |
| **`Accepted` 只有 HTTP 204 的强度** | 承上：异步性在 fork 里，调用方返回时消息未必已落库。原 I2「Accepted ⇒ 已持久化」及一切依赖它的论证删除。代价：fork 内失败只发 `Session.Event.Error`，模型拿不到投递失败反馈（§10 缺口 5） |
| **V1 没有按 Session 的 workspace 路由** | `requireSession` 只有 `session.get(sessionID)`，instance 由 HTTP 请求自己路由，不是按目标 session 选的。跨 workspace 的 `agent_send` 在 V1 **做不到**，如实记为限制（§10 缺口 12），不记为"已由 prompt_async 解决"。同一 project 内的 Agent 树共享 instance，目标场景不受影响 |
| 只有 `agent` 的初始委托保留自动结局 | 初始委托是创建者交出去的一项任务，有明确完成含义。产生一处**不对称并需明说**：`agent` 自动回结果，`agent_send` 永不回 |
| **通知强度只到"至多发起一次"** | 可保证：一个初始委托只注册一个 watcher，completed/error 时至多发起一次异步通知。不可保证：父恰好收到、消息必落库、必被消费。cancelled 同强度 |
| 消息身份取自目标 Session 且必须显式传 | `createUserMessage` 的优先级是 `input.model ?? agent 定义 model ?? Session 当前 model`，不传 `agent` 回落默认 agent，且结果经 `setAgentModel` 落库。**同一规则覆盖三处**：`agent_send`、初始委托 completed/error 的 `inject`（投递时**重新读**父的当前身份，父可能在子运行期间换过模型）、以及新建子 Session 时就持久化已解析身份 |
| **`task` 工具删除，不保留隐藏别名** | 推翻调研 §8。运行时 tool ID 只剩 `agent`；配置键迁移与历史展示兼容保留。代价是连带迁移：`registry.ts:268` 的 subagent type 过滤、内置 Agent allowlist、prompt 里的 agent part 判断与模型提示，以及 TUI/app/CLI 中约十余处按 `part.tool === "task"` 分支的渲染器——不迁移则 subagent 显示静默消失 |
| 旧 `task` 权限配置读取时一次性规范化为 `agent` | 不能静默忽略：`task: deny` 升级后变成允许即是权限放宽。先转换旧 `task`、再覆盖显式 `agent`，同 pattern 冲突时 `agent` 胜；运行时只判 `agent`。够用的依据：`session/tools.ts:87` 合并的是 `merge(agent.permission, session.permission)`，用户配置进的是 `agent.permission` 而它**每次运行都从 config 重新派生** |
| 持久化 Session 的 `task` 规则不作运行时映射 | 系统生成的与用户意图的同名规则形状完全相同，无法区分；而根 Session 的 `permission` 默认 `undefined`，配置里的 deny 并不进入 session ruleset。暴露面窄，记为 §10 缺口 10 |
| **`deriveSubagentSessionPermission` 必须改：不再默认拒绝嵌套** | `permission/index.ts:28` 的 `evaluate` 用 `findLast`，合并顺序使 **session ruleset 压过 agent 定义**；而 `subagent-permissions.ts` 给每个子追加 `task: * deny`。仍发字面 `task` ⇒ 规则变死码、agent 定义级 opt-out 静默失效；移植成 `agent: * deny` ⇒ **每个子都被拒绝 `agent`，深度 3 一次都跑不起来**。正确改法：嵌套上限改由深度计数 + 工具可见性承担，`canTask` 改查 `agent` 键且不再默认追加 deny |
| 移除 `childToolDenies` 对 `agent` 的默认拒绝 | 与上一条相互独立的第一道闸，须同改 |
| **内置受限 Agent 必须显式放行四个工具** | `agent/agent.ts:196-211` 的 `explore` 是 `"*": "deny"` 加白名单，不显式 allow 就整体被过滤掉。用户自定义 Agent 的显式 deny 继续被尊重 |
| **实例名是弱别名，允许并发重名** | 创建时无锁扫描当前树，看见同名即失败；**但两个并发创建可能同时通过检查并产生重名，此结果明确允许**。不引入 reservation、锁或唯一约束——为一个便利别名付同步代价不值。多匹配是正常可达分支：解析时返回全部候选并拒绝，要求改用 session_id。**重名是永久状态**：那两个 Agent 从此只能用 session_id 寻址 |
| 名称只匹配实例名，不匹配类型名 | 类型标识的是 Agent 定义而非实例。扇出是 subagent 的主用法，同类型多实例是设计目标场景，类型名恰在那时歧义 |
| 名称冲突零副作用且不返回既有 Agent | 返回既有 session_id 等于把"创建"悄悄变成"复用" |
| **`agent_stop` 不做状态审计** | `SessionRunState.cancel` 对无 runner 是成功空操作，事后分不出两种情形；而先读再取消**同样测不准**（读到 running 之后、cancel 之前目标可能自行结束）。与其假装测得准，不如不报告这个维度。`stopped` 只表示"执行了停止操作" |
| **停止只发一条通知，给 caller** | 停止集内每个成员的父都在集内——除了 target，它的父是 caller。caller 恒在集外且正在执行本次调用、全程醒着 ⇒ **唯一被通知者不可能被唤醒，复活路径彻底不存在**，原 I1 排序不变量随之删除。反例：给每个成员的父都发通知会让"迟到通知唤醒已取消的父"从极窄调度变成掷硬币（投递是 fork 的，外层不等它就去 cancel 父） |
| **子 Agent 列表作为落盘 reminder 注入** | 补上"后代被停但父没被通知"所丢的信息，并使被 #32 吞掉的完成通知从无声挂起降级为一轮延迟 |
| **roster 必须落盘，不能每轮内存重建** | 非落盘那种会**改写一条已经发出去的消息**：reminder 挂在最后一条 user message 上，同轮多个 step 里那条消息不变，step 1 发 `userMsg + roster_v1`、step 2 重建成 `roster_v2`，前缀对不上 ⇒ **从那条消息往后的缓存全部失效**，包括 step 1 产生的全部 assistant 与 tool 消息。落盘的 part 有稳定 id、字节级稳定；落盘之后"只出现一次"即成立 |
| roster 的判据基于**已过滤**的可见历史 | `filterCompacted` 把边界前的消息换成 summary，边界前的 roster 不再进请求；而 reminder 阶段拿到的本就是过滤后的视图。于是压缩后"倒找不到" ⇒ 自动重发。**首次派生、状态翻转、压缩之后三种情况走同一条规则，无需特判** |
| roster 只列直接子、只在有子时注入、渲染成一行 | 父与兄弟与本 Agent 的决策关系不大，`agent_list` 随时可查；绝大多数 subagent 没有子，一个字都不加 |
| 停止级联到整棵子树 | 避免"停了父、子变孤儿继续消耗"；是否改为只停目标本身列为 follow-up（issue #26） |
| **创建不返回实时 status** | 在 BackgroundJob 启动后硬编码 `running` 与"status 唯一来自 `SessionStatus`"冲突。创建只表达"已创建并启动"；完整 `AgentInfo.status` 只在 `agent_list` 装配 |
| **没有同步启动失败分支** | BackgroundJob 注册本身没有产品级"同步启动失败"：执行失败由 job 结算并走既有异步通知路径；内部 defect 不伪装成可恢复的模型错误 |
| **初始委托代码只有一份** | `runTask`（`task.ts:333`）、`inject`（`:369`）、`notify`（`:398`）都是 `TaskTool.execute` 内的**闭包**，不是可直接调用的 helper。必须最小提取为共享内部实现、显式传窄数据，不复制第二套 |
| **工具可见性在工具列表生成期计算** | `SessionTools.resolve` 的入参有 `session: Session.Info`、**没有 `Tool.Context`**；后者只在工具真正执行时才存在，而模型看到的 schema 在那之前已确定。深度过滤必须用 `input.session.id` 在 resolve 处做；`agent` 内的深度检查保留为第二道防线 |
| 触达深度上限时撤下工具 | 撤下 `agent` 与 `agent_stop`（到限者不能派生，也就不会有子可停），保留 `agent_send` 与 `agent_list`。**边角**：若 `subagent_depth` 被调低、或某深度 3 的 Session 是在上限更高时建的，它会有子却无 `agent_stop`；此时仍可由更上层停止其祖先 |
| Agent 恒为异步，取消 `background` 参数与实验开关 | 前台路径以 `background.wait` 阻塞，父停在那次 tool call 里，管理面完全不可用 |
| 不引入 `model` 参数，继承创建者当次的 model 与 variant | 照既有 `task.ts` 语义；**只在 subagent 未固定模型时**才继承 variant |
| 为每个新 Agent 准备独立工作目录（G6） | 深度 3 + 可再派生 + 恒异步，三者叠加使多 Agent 同改一份 checkout 从边缘情况变成默认可能 |
| **隔离强度：建议式，不是强制** | `tool/read.ts:236` 是 `path.resolve(instance.directory, filepath)`，`tool/shell.ts:612-613` 默认 cwd 为 `instanceCtx.directory`——运行时默认 cwd **未切换**。不声称 Agent 无法访问或修改主 checkout。见 issue #33 |
| 工作目录位置在项目内且平铺 | 不换 instance ⇒ `containsPath` 要求它在项目内；平铺是因为嵌套时父清理会删掉子的工作 |
| 忽略登记用 `info/exclude` | 仓库本地、从不提交、不出现在 `git status`，`snapshot/index.ts` 已有先例且保留既有内容 |
| 工作树基准是父建议工作目录的 HEAD | 只继承父已提交到 HEAD 的内容 |
| `.worktreeinclude` 移出首版 | 该机制在 opencode 中**不存在**，落地要从零写 gitignore 匹配器加逐个 `git check-ignore` |
| **`WorktreeUnavailable` 不承诺零文件系统副作用** | 只保证不创建 Session、不投初始 prompt、不启动 Agent。已产生的 `info/exclude` 修改、目录、分支或半成品 worktree 可以残留，在错误中给出路径。承诺零副作用会逼出一套回滚逻辑，而 V1 本就不自动清理 |
| V1 不自动清理工作目录 | 任何结局都不删、Session 删除不连带删 |
| 内部工作树入口不进 HTTP schema | `Worktree.CreateInput` **就是** experimental HTTP 的 payload，加 `root` 会让客户端指定任意创建位置 |
| `subagent_depth` 默认由 1 提到 3 | 与 CC 的 `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`（默认 3）对齐；现默认 1 恰是 CC 所说的"关闭嵌套" |
| **TUI 权限聚合改为整棵后代** | `tui/src/routes/session/index.tsx:208-213` 的 `children()` 只有一层，`:229-235` 对任何带 `parentID` 的 Session 直接 `return []`。深度 1 时二者等价；提到 3 之后 P → A → B 中 B 的 permission/question 在根视图看不到、在 A 的视图也不显示，**该 Agent 永久挂起**。必要连带项，不是可选项 |
| 不设 `agent_get` | CC 只有 `ListAgents` 且每行自带 busy/idle；`TaskOutput` 已废弃 |
| 一个 Agent 任一时刻至多一个活动执行 | 这是 `session_id` 足以作唯一标识的前提。机制由 I3 维护 |
| 不引入 correlation ID、per-message output 槽或 `run_id` | `agent_send` 根本不产生结局，自然无需为消息编号 |

## 7. 架构正确性论证

### goal → 模块映射

```
G1 「列出 Agent 树及状态」   → M1（skeleton）+ M2（状态）+ M5（组装与渲染，含 roster）
G2 「查询指定 Agent」        → 与 G1 同路径
G3 「邻居间任意方向消息」    → M3 AgentInbox（主）
G4 「停止并保留上下文」      → M4（主）+ M1（直接子判定 + 后代展开）+ M5（roster 兜信息）
G5 「身份统一」              → M5（表面约束）+ M1（身份与名称解析）
G6 「独立工作目录」          → M4 §4.4.1（准备）+ M5（在初始消息与 roster 中呈现）
```

### 模块协作论证

**G1/G2**：M1 保证 AgentNeighborhood 覆盖父/子/兄弟三类且有稳定序（三元组排序，毫秒并列不致换序），
即可寻址集合完整；M2 保证每个成员得到 running / idle 之一且二者互斥穷尽；M5 把两者拼成完整
AgentInfo。故"完整成员集合 × 明确状态"成立。G2 是 G1 在单成员上的投影。

**G3**：M3 对任一存在的目标 Session 均可投递，故邻居这一子集必然覆盖。处理保证由现有 Runner 承担：
running 时现有 loop 在下一个 provider turn 边界重读历史读到它，idle 时新起 run。
**强度限定**：G3 成立到"投递已被接受并调度"这一强度，**不到"必被处理"**——
受 issue #32 的 lost-wake 窗口影响（§10 缺口 5），且 `Accepted` 本身不保证已持久化。
这是既有渠道的既有强度，本 feature 不加强也不削弱。roster（§4.5）把"通知丢了"的后果
从无声挂起降级为一轮延迟，但那是缓解不是保证。

**G4**：M4 的后置条件给出"终止执行、不删除任何 Session 与历史、可恢复、幂等"。
"等待方不被静默挂起"这一半由两件事共同给出：
(a) `agent_stop` 的**工具返回值** `StopOutcome` 在同一轮就到达 caller；
(b) 向 caller 的那条 cancelled 通知（至多一次）。
停止集内的成员没有在等的主体——它们的父自己也在被停。
**唯一的通知接收方恒在停止集之外且全程醒着**，故不存在通知复活已停 Agent 的路径。

**G5**：M5 规定了对模型暴露的工具集合与参数命名，M1 保证所有解析最终都归到 SessionID，
实例名只是**弱**别名且解析范围不超过调用者本就能寻址的集合。二者合起来即"不存在第二套身份"。
弱别名不破坏这一点：它可能指向零个或多个，但永远不指向 session 之外的东西。

**G6**：§4.4.1 的三分支互斥且穷尽地覆盖工作目录来源，ready 契约保证 Agent 启动时目录可用。
**G6 只到"建议"强度**：`workdir.enforced` 恒为 false，运行时默认 cwd 未切换。

### 关键假设

本段只列本架构**控制不了**的外部前提。

```
H1: running 是进程内真相。SessionStatus 存于 InstanceState，进程重启后清空。
    因此崩溃前正在执行的 Agent 重启后一律投影为 idle。
    — 来源：既有基础设施；本架构不提供崩溃恢复

H2: Session 的 parentID 链无环且深度有限。
    — 来源：子 Session 只在创建时绑定 parentID 且此后不变；深度另有上限约束
```

外部前提只有这两条。以下五条曾被列为假设，现已归位：

| 原编号 | 内容 | 归位 |
|---|---|---|
| 旧 H2 | 至多一个活动执行 | §6 决策（概念定义）+ I3（机制维护） |
| 旧 H4 | 终止通知接收方仍在运行 | 由 `StopPlan` 类型不变量直接给出（notify_boundary ∉ 停止集），不再是假设 |
| 旧 H5 | 只交付一个最终结果 | `agent_send` 不产生结局，无需该假设 |
| 旧 H6 | 拆解期间不会派生新成员 | §10 已知缺口 |
| 旧 H3 | 同一 project 的创建在同进程内串行 | **删除**：名称降为弱别名后不再需要该前提（§6） |

### 模块级 invariant

```
I3: 单活动执行
    ∀ Agent a，任一时刻 a 至多有一个活动执行。
    维护方：本 feature 的概念定义（§6）；机制由既有 Session 运行状态机提供
    preservation：既有运行状态机对每个 Session 持单值状态，第二次运行请求加入已有执行
      而不并行开新的；M3 不新起 run 而是交给既有异步入口；M4 的取消以 Session 为单位。
      本不变量塌陷的代价是回到 run_id（§6），实现阶段须有回归钉住该机制。
```

**只剩这一条。**三条已删除的不变量与删除理由：

| 原编号 | 内容 | 删除理由 |
|---|---|---|
| I1 | 停止排序：取消通知已持久化 happens-before 父被取消 | 它是为了防"孙的通知复活刚停掉的子"。现在**不给停止集内任何成员发通知**，无对象可排序。且 `Accepted` 不再蕴含持久化，该排序本就无法建立 |
| I2 | Accepted ⇒ 消息已持久化 | 投递是 fork 的，返回时未必已落库。强度只到 HTTP 204（§3 `Accepted`） |
| I4 | 实例名树内唯一 | 名称降为弱别名，允许并发重名（§6）。多匹配从"存储损坏"变为正常可达分支 |

## 8. 并发规约

```
并发单元：M4 AgentLifecycle.stop

共享资源：
  - Session 运行状态注册表：SessionID → 活动执行句柄
  - caller Session 的消息历史（持久化）——唯一一条取消通知的写入处

顺序约束（Ordering Constraints）：
  - cancel(layers[i]) 先于 cancel(layers[i+1]) 发起
    —— **只是发起顺序，不承担正确性**。自底向上原本是为了防复活，
       而现在停止集内不发通知，无复活路径可言；保留它只因为先停深层能减少
       中间层在被停前又派生新成员的机会（§10 缺口 1 的缓解，不是消除）
  - 同一层内的取消可并发
  - **不存在"状态读取先于取消"的约束**：本设计不预读状态

Rely-Guarantee 条件：
  - Rely：无。并发的两次 stop 也安全——cancel 幂等，且两次各自发一条通知，
    不为去重增加状态
  - Guarantee：stop 只中断执行，不删除 Session、消息、历史或工作目录；
    只向 notify_boundary 投递一条通知，不向停止集内任何成员投递

线程安全性结论：
  - 安全。删除状态审计后，本单元不再读取任何可能与自身写入竞争的状态，
    也不再依赖跨模块的顺序保证
```

```
并发单元：M3 AgentInbox.deliver

共享资源：
  - 目标 Session 的消息历史
  - 目标 Session 的运行状态

顺序约束：
  - 无跨调用的顺序保证。两条并发 deliver 到同一目标的相对顺序由 fork 的调度决定，
    **不做任何保证**（此前依赖"持久化先于唤醒"的排序已随 I2 删除）

Rely-Guarantee 条件：
  - Rely：目标的 runLoop 每个 provider turn 开始时重读消息历史（`prompt.ts:1093`）
  - Guarantee：deliver 不修改目标 Session 的 agent 与 model 绑定
    （它显式传目标当前值，使 `setAgentModel` 的写回成为恒等写）

线程安全性结论：
  - 安全。两条并发消息可能以任意顺序进入同一个 turn 的上下文，
    这与两个人同时向一个会话打字的既有语义一致，不引入新的竞态类别
```

```
并发单元：M4 AgentLifecycle.create（名称检查）

共享资源：
  - Agent 树内已存在的 metadata.agentName

顺序约束：无。检查与创建之间**不加锁、不占位**

Rely-Guarantee 条件：
  - Rely：无
  - Guarantee：看见同名即失败且零副作用；**未看见则继续，即使另一并发创建正在用同一名字**

线程安全性结论：
  - 在"名称是弱别名"的前提下安全。两个并发创建可能都通过检查并产生重名，
    **这是明确允许的结果**，不是竞态缺陷。后果被 TargetRef 的多匹配分支兜住：
    解析时返回全部候选并拒绝，不会把消息发给错的 Agent
```

```
并发单元：M5 roster 注入

共享资源：
  - 当前 Session 最后一条 user message 的 parts

顺序约束：
  - 比较与写入之间无原子性要求：重复写一条相同的 roster 是幂等的浪费，不是错误

线程安全性结论：
  - 安全。注入发生在 runLoop 的 reminder 阶段，该阶段对单个 Session 是串行的
    （同一 Session 至多一个活动执行，I3）
```

## 9. 与 Claude Code 的有意差异

| 项 | Claude Code | 本方案 | 理由 |
|---|---|---|---|
| **消息是否带回复** | `SendMessage` 带回目标的回复（云会话例外条款反证常规会） | 单向：只回 `accepted` | 一条消息的"结局"在语义上不存在；强行配一个要维护 watcher 所有权、结局去重与取消竞态 |
| **结局的不对称** | `Agent` 与 `SendMessage` 都能拿到结果 | `agent` 的初始委托自动回一次，`agent_send` 永不回 | 初始委托是交出去的一项任务，有明确完成含义；后续消息没有 |
| **投递保证** | 未述 | 只到"已接受/已调度" | 复用既有异步入口的既有强度，不加强也不削弱 |
| 寻址标识 | 名字即地址（来自 `subagent_type`），`ListAgents` 每行 `name [ref]`，重名用 `[ref]` 消歧或报错 | `session_id` 为权威标识，可选实例名作**弱**别名；重名时列出候选并拒绝 | CC 预期用户为具体任务定义具体类型，故类型名即实例名；我们把它做成一等参数，扇出时才不歧义 |
| 模型选择 | `Agent` 有 `model` 参数 | 无，继承创建者当次的 model 与 variant | 首版不做 |
| 停止范围与通知 | `TaskStop` 按 id 停一个后台任务，文档未述子树级联 | 级联整棵子树，**但只向发起者发一条通知** | 防止孤儿继续消耗；只通知集外的发起者使复活路径不存在。备选见 issue #26 |
| roster 范围 | `ListAgents` 跨 in-process subagent、teammate、本机其他会话、云端会话 | 仅调用者所在的一棵 Agent 树，且只到邻居 | 调研 §6 明确排除跨互不相关根 Session 的编排 |
| **跨 workspace 通信** | `ListAgents` 可寻址本机其他会话与云端会话 | **做不到** | V1 的 HTTP 层没有按目标 Session 选 instance 的路由（§10 缺口 12） |
| **子列表注入上下文** | 未述 | 有，落盘 reminder，变化时发一条 | 补"后代被停不通知"所丢的信息，并缓解 #32 |
| 工作目录隔离强度 | 四项主动检查 | 建议式：准备目录并在初始消息中要求使用，但运行时默认 cwd 未切换 | 强制需要按 Session 可判定的文件系统根，V1 无此轴；见 issue #33 |
| 工作树基准 | 默认远端默认分支，可设 `head` | 恒为父建议工作目录的 HEAD | 子 Agent 需在父的进行中工作上操作，此为 CC 自己给的 `head` 适用场景 |
| gitignored 文件带入 | `.worktreeinclude` | 首版不做 | 该机制在 opencode 中不存在 |
| 工作目录回收 | 周期性 sweep | 无，全部累积待人工清理 | 见 §10 缺口 7 |

## 10. 已知缺口

1. **拆解期间新派生的后代不在停止集内**。子树展开按一次快照进行。自底向上只减少该机会，不消除。
2. **停止后代时的执行现场不可恢复**。保留 Session 与历史，但不保留中断点。
3. **崩溃后 running 退化为 idle**（H1）。不提供崩溃恢复。
4. **移除前台分支会波及既有测试**。前台路径当前承载着子 Agent 错误如何呈现给父 Agent 的一批断言，
   实现阶段须逐条迁移而非删除。
5. **消息可能被投递但不被消费，且投递失败模型不可见**（fork issue #32）。
   `ensureRunning`（`effect/runner.ts:115-119`）对已 Running 的目标丢弃新 work，
   `finishRun`（`:70-81`）落 Idle 前不检查这期间是否有新消息到达；此外投递是 fork 的，
   fork 内失败只发 `Session.Event.Error`，调用方那时已拿到 accepted。
   本 feature **不为它造绕行方案，也不依赖它被修复**；修复并行推进。
   roster（§4.5）把后果从无声挂起降级为一轮延迟。
6. **工作目录隔离为建议式**（fork issue #33）。运行时默认 cwd 并未切换。
7. **工作目录会累积**。完全不自动清理，需人工处理。`WorktreeUnavailable` 还可能留下半成品。
8. **进程崩溃后工作目录成为孤儿**。无回收机制。
9. **非 Git 项目的工作目录是空的**。不自动复制项目文件；Agent 若整目录复制须排除
   `.opencode/worktrees` 以免递归复制自身。
10. **持久化 Session 中的 `task` 规则不被映射**。暴露面限于经 CLI/SDK 显式设过 session 权限
    再派生子 Agent 的情形。
11. **重名不可恢复**。两个并发创建产生同名后，二者从此只能用 `session_id` 寻址；
    本 feature 不提供改名。
12. **跨 workspace 的 `agent_send` 做不到**。V1 的 HTTP 层没有按目标 Session 选 instance 的路由，
    `requireSession` 只是一次查找。同一 project 内的 Agent 树共享 instance，目标场景不受影响；
    拿到别的 workspace 的 session_id 时行为未定义，实现阶段应显式拒绝而非静默跑错 instance。

## 11. 下一阶段

架构确认后进入 §4.3 细化阶段，更新 `detailed-design.md`，需满足 §4.3.1 完整性 6 条与
§4.3.2 函数正确性论证。按 §2.3 步骤 2 为契约变更分配 subplan-id，feature 短称取 `agm`。
