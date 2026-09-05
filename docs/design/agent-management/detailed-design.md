# 细化设计 — agent-management

- 状态：细化阶段，等待确认
- 日期：2026-09-06
- 上游依据：`docs/design/agent-management/architecture.md`（架构阶段已确认）
- 代码基线：`dev` @ `a4293ca229`

## 1. 范围

本细化覆盖架构 §4 的五个模块，共 18 个函数（14 个承担模块规约，4 个内部辅助）：

| 模块 | 函数 | 内部辅助 | 承接 goal |
|---|---|---|---|
| M1 AgentTree | `neighborhood` / `children` / `descendants` / `isChild` | `toInfo` | G1 G2 G4 G5 |
| M2 AgentStatusProjection | `of` | — | G1 G2 |
| M3 AgentInbox | `deliver` | `render` | G3 G4 |
| M4 AgentLifecycle | `create` / `plan` / `stop` | `renderTermination` | G4 G5 |
| M5 AgentTools | `agent` / `agent_list` / `agent_send` / `agent_stop` / `available` | `callerDepth`、`task` 兼容入口 | G1–G5 |

另含对既有代码的五处改动（§2.3）。本细化不改变架构确定的模块划分、接口规约与核心流程。

未启用 §6 v2 子计划流程：本 feature 为首次落地，契约由架构文档一次性确立，无既有契约被修改。
后续对本 feature 的契约变更再按 §2.3 步骤 2 分配 subplan-id，前缀 `agm`。

## 2. 与已有代码的复用点

### 2.1 直接复用，不包装

| 复用项 | 用途 | 引用的契约 |
|---|---|---|
| `Session.children(parentID)` | M1 取直接子 | ensures：返回 parent_id == parentID 的全部 Session |
| `Session.get(id)` | M1/M3/M4 取 Session | 失败通道 `NotFound` |
| `Session.create(input)` | M4 建子 Session | 入参含 `parentID` / `title` / `agent` / `permission` |
| `SessionStatus.get(sessionID)` | M2 读执行状态 | ensures：无记录时返回 `{ type: "idle" }` |
| `SessionRunState.cancel(sessionID)` | M4 停止单个 Agent | 既有语义：取消后台 job 并中断该 Session 的活动执行 |
| `SessionPrompt.prompt(input)` | M3 投递消息 | `noReply: true` 时只落库并返回该 message，不进 loop |
| `SessionPrompt.loop(input)` | M3 唤醒目标 | 经 `ensureRunning`：Running 时加入既有执行，Idle 时新起 |
| `deriveSubagentSessionPermission` | M4 派生子权限 | 既有函数，不改 |

### 2.2 需要适配

- `TaskPromptOps` 当前只有 `cancel` / `resolvePromptParts` / `prompt`，M3 还需要 `loop`。新增一个成员，
  签名与 `SessionPrompt.loop` 一致。
- `Truncate.limits()` 供 M3 渲染终止通知时限长，与既有 subagent 错误渲染共用同一上界。

### 2.3 必须修改的既有代码

| 位置 | 改动 | 依据 |
|---|---|---|
| `tool/task.ts` 深度门 | `cfg.subagent_depth ?? 1` → `?? 3` | 架构 §6 |
| `core/src/v1/config/config.ts` `subagent_depth` | schema 说明文字仍写 "Defaults to 1" | 同上 |
| `tool/task.ts` `childToolDenies` | 移除对 `agent` 权限的无条件 deny | 架构 §6 |
| `tool/task.ts` `ctx.ask` | 移除 | 架构 §6 |
| `tool/task.ts` background 分支 | 移除 `background` 参数、实验开关与前台分支 | 架构 §6 |
| `tool/task.ts` `notify` | 增加 `cancelled` 分支 | 架构 §4.4 |

## 3. 错误处理策略

**错误模型**：沿用仓库既有的 Effect typed error。本 feature 定义四个失败类型，均为可预期的调用方错误，
不使用异常，不使用 `Effect.orDie`。

```
AgentNotFound      { session_id }         目标 Session 不存在
NotAChild          { caller, target }     agent_stop 的目标不是调用者的直接子
SelfDelivery       { session_id }         agent_send 的目标是自己
DepthLimitReached  { depth, limit }       agent 创建时已达嵌套上限
```

**跨模块传播规则**：

- M1/M2/M3/M4 只产出上述类型，不吞错、不转成 `undefined`；
- M5 是唯一把失败转成模型可读文本的地方，渲染时复用架构 §3 `renderOutput` 的 envelope；
- `Session.get` 的 `NotFound` 在 M1/M3/M4 统一映射为 `AgentNotFound`，不向上暴露 Session 层类型；
- M4 `stop` 内部单个成员取消失败**不中断整体**，记入 `StopOutcome.failed` 继续推进（架构 §5 M5→M4 协议
  要求部分失败显式报告）。

## 4. 数据结构定义

本细化不引入新的跨模块类型。架构 §3 已定义 `AgentStatus` / `AgentInfo` / `AgentNeighborhood` /
`AgentMessage` / `Accepted` / `StopOutcome` / `StopPlan`，此处不重复。

新增的四个错误类型见 §3，属**模块私有**（仅本 feature 产出与消费），不进架构文档数据结构节。

## 5. 模块细化

### 5.1 M1 AgentTree

#### 5.1.1 `neighborhood(caller: SessionID) -> Effect<AgentNeighborhood, AgentNotFound>`

- **功能描述**：解析调用者的父、子、兄弟，附 `relation` 标注。
- **调用关系**：callers: M5 `agent_list`；callees: `Session.get`、`Session.children`。
- **实现思路**：
  1. `Session.get(caller)`。失败（`NotFound`）→ 映射为 `AgentNotFound{caller}` 返回，无副作用。
     成功得到 `self`。
  2. 判断 `self.parentID`：
     - **有**：`Session.get(self.parentID)` 得 `parent`；再 `Session.children(self.parentID)` 得同父集合，
       过滤掉 `id == caller` 者即 siblings。
       - 依赖事实：`Session.get(self.parentID)` 不会 `NotFound` —— 子 Session 的 `parentID` 在创建时绑定
         且此后不变（架构 §7 H2），父被删除时子会一并删除（既有 `Session.remove` 递归删子）。
         若仍失败，视为存储不一致，映射 `AgentNotFound{self.parentID}` 返回。
     - **无**（调用者是主 Agent）：`parent = undefined`，`siblings = []`。
  3. `Session.children(caller)` 得 children。
  4. 组装 members：`self`（relation=self）+ `parent`（relation=parent，若有）+ children（relation=child）
     + siblings（relation=sibling）。每项经 §5.1.5 `toInfo` 转换。
  5. 按 `(relation, time_created)` 升序排序，relation 的序取 `self < parent < child < sibling`。
  6. 返回 `{ caller, members }`。
- **正确性论证**：
  - 前置：`caller` 对应的 Session 存在（由 M5 在工具入口保证；本函数仍在步骤 1 做防御性检查）。
  - 论证：
    - 步骤 1 建立 `self` 存在 → 类型不变量"恰有一个成员 relation == self"由步骤 4 无条件加入 `self` 满足。
    - 步骤 2/3 的三个集合按架构 §3 `AgentNeighborhood` 的邻居定义逐条构造：parent 取 `self.parentID`、
      child 取 `parent_id == caller`、sibling 取 `parent_id == self.parentID ∧ ≠ caller`。三者两两不交
      （parent 的 parent_id ≠ self.parentID 除非成环，H2 排除；child 的 parent_id == caller ≠ self.parentID
      除非自环，同样被 H2 排除），故每个成员的 relation 唯一。
    - 步骤 5 的排序键 `(relation, time_created)` 全序，且 relation 取值有限，故输出稳定。
    - 集合构造只取上述三类，不含祖父、孙、叔伯、侄，满足"不含任何非邻居成员"。
  - 后置：返回值满足 `AgentNeighborhood` 全部类型不变量。
  - 副作用论证：只调用 `Session.get` / `Session.children`，两者的功能规约均声明只读，故无副作用。

#### 5.1.2 `children(id: SessionID) -> Effect<AgentInfo[], AgentNotFound>`

- **功能描述**：取 `id` 的直接子。
- **调用关系**：callers: M1 `neighborhood`/`descendants`、M4 `plan`；callees: `Session.children`。
- **实现思路**：调用 `Session.children(id)`，逐项经 `toInfo` 转换，relation 置 `child`。
  `Session.children` 的 ensures 是"返回 parent_id == id 的全部 Session"，对不存在的 id 返回空数组而非失败，
  故本函数无失败分支；`AgentNotFound` 保留在签名中仅为与 M1 其余函数一致，实际不产生。
- **正确性论证**：trivial —— 单次 callee 调用加逐项纯转换，无分支、无循环、无副作用。

#### 5.1.3 `descendants(id: SessionID) -> Effect<AgentInfo[], AgentNotFound>`

- **功能描述**：取 `id` 的后代闭包，不含 `id` 自身。仅供 M4 展开停止级联。
- **调用关系**：callers: M4 `plan`；callees: M1 `children`。
- **实现思路**：
  1. `frontier = [id]`，`acc = []`，`seen = {id}`。
  2. 循环：`frontier` 非空时，取出全部元素，对每个调用 `children`，把结果中 `session_id ∉ seen` 的
     加入 `acc`、加入 `seen`、构成 `next`。`frontier = next`。
     - 分支：`children` 返回空 → 该分支不贡献 `next`，其余分支照常。
     - `seen` 去重是防御性的：H2 已排除环，去重只保证即使存储异常也必然终止。
  3. `frontier` 为空 → 退出循环，返回 `acc`。
  - **终止性**：每轮加入 `acc` 的成员都新入 `seen` 且永不移除，`seen` 单调增长；Session 总数有限
    （H2：深度有限，且每层成员有限），故 `seen` 有上界，循环必然终止。
  - **循环不变量**：`acc == seen \ {id}`，且 `acc` 中每个成员都是 `id` 的后代。
- **正确性论证**：
  - 前置：`id` 对应的 Session 存在；parentID 链无环（H2）。
  - 论证：
    - 不变量在初始时成立（`acc` 空、`seen` 只含 `id`）。
    - 每轮把 `frontier` 中各节点的直接子加入，依 `children` 的 ensures，这些恰是 parent_id 指向 frontier
      成员的 Session；由归纳，frontier 成员都是 `id` 的后代，故其子也是 → 不变量保持。
    - 退出时 `frontier` 为空，意味着不存在未展开的后代 → `acc` 是后代闭包。
  - 后置：返回 `id` 的全部后代，不含 `id` 自身。
  - 副作用论证：只经 `children` 读取，无写入。

#### 5.1.4 `isChild(caller: SessionID, target: SessionID) -> Effect<boolean, AgentNotFound>`

- **功能描述**：判定 `target` 是否为 `caller` 的直接子。
- **实现思路**：`Session.get(target)`，失败映射 `AgentNotFound{target}`；成功则返回
  `target.parentID === caller`。
- **正确性论证**：trivial —— 单次读取加一次相等比较；`parentID` 在创建时绑定且不变（H2），故该比较
  等价于"target ∈ children(caller)"，无需再拉子列表。

#### 5.1.5 `toInfo(session, relation, depth) -> AgentInfo`

- **功能描述**：把 `Session.Info` 转成 `AgentInfo` 骨架，`status` 留空由 M2 填。
- **正确性论证**：trivial —— 纯字段映射，无分支。`depth` 由调用方传入：`neighborhood` 中
  self 的 depth 需一次向上遍历取得，见 §5.5.5 `callerDepth`，其余成员的 depth 由 self 推出
  （parent = self−1，child = self+1，sibling = self）。

### 5.2 M2 AgentStatusProjection

#### 5.2.1 `of(sessionID: SessionID) -> Effect<AgentStatus>`

- **功能描述**：把进程内执行状态投影为 `running | idle`。
- **调用关系**：callers: M5 `agent_list`；callees: `SessionStatus.get`。
- **实现思路**：
  1. `SessionStatus.get(sessionID)`。其 ensures 声明无记录时返回 `{ type: "idle" }`，故无失败分支。
  2. 分支：`type === "busy"` 或 `type === "retry"` → `running`；`type === "idle"` → `idle`。
     `SessionStatus.Info` 的联合恰为这三支（`packages/schema/src/session-status-event.ts`），故分支穷尽，
     无 default 需要处理。
  3. 返回。
- **正确性论证**：
  - 前置：`sessionID` 对应的 Session 存在（M5 保证；本函数不依赖该事实，`SessionStatus.get` 对未知 id
    也返回 idle）。
  - 论证：`retry` 表示正在退避重试，属活动执行未结束，与 `busy` 同归 `running`；只有 `idle` 归 `idle`。
    三支穷尽 ⇒ 返回值必为二值之一 ⇒ 满足 `AgentStatus` 的"互斥且穷尽"。
  - 后置：返回 `running` 当且仅当进程内存在该 Session 的活动执行。
  - 副作用论证：`SessionStatus.get` 的功能规约声明只读；本函数不写 `SessionStatus`、不写消息。

### 5.3 M3 AgentInbox

#### 5.3.1 `render(message: AgentMessage) -> string`

- **功能描述**：拼装带系统发送者前缀的正文。
- **实现思路**：返回 `` `[Agent message from ${sender_agent} (${sender})]` `` + `"\n\n"` + `body`。
  `sender_agent` 与 `sender` 均由 M5 从调用上下文填入，不取自模型入参，故不存在调用方伪造前缀的路径。
- **正确性论证**：trivial —— 纯字符串拼接，无分支、无副作用。

#### 5.3.2 `deliver(message: AgentMessage) -> Effect<Accepted, AgentNotFound | SelfDelivery>`

- **功能描述**：以目标 Session 自身的身份写入消息并唤醒目标。
- **调用关系**：callers: M4 `create`、M4 `stop`、M5 `agent_send`；callees: `Session.get`、
  `SessionPrompt.prompt`、`SessionPrompt.loop`。
- **实现思路**：
  1. 校验 `message.sender !== message.target`，否则返回 `SelfDelivery{target}`，无副作用。
  2. `Session.get(message.target)`。失败 → `AgentNotFound{target}`，无副作用。成功得 `target`。
     此处**不校验**邻居关系，也不校验同树（架构 §6）。
  3. 调用 `prompt({ sessionID: target.id, agent: target.agent, parts: [{type:"text", text: render(message)}],
     noReply: true })`。
     - **不传 `model` 与 `variant`**：`createUserMessage` 的既有逻辑是
       `model = input.model ?? ag.model ?? currentModel(sessionID)`，省略即回退到目标 agent 的模型或
       目标 Session 当前模型。传入调用者的选择会改写目标身份并落库（架构 §4.3）。
     - **必须传 `agent`**：省略时 `createUserMessage` 落到 `agents.defaultInfo()`，会把目标切成默认 agent。
     - callee 契约：`prompt` 在 `noReply === true` 时的 ensures 是"创建并持久化 user message 后返回该
       message，不进入 loop"。因此本步返回即满足 I2（接受即持久化）。
     - 失败分支：`prompt` 的失败通道为 `Image.Error`（附件解码）。本调用只传纯文本 part，不触发该路径；
       仍将其映射为 `AgentNotFound{target}` 兜底，不向上暴露 Image 层类型。
  4. fork `loop({ sessionID: target.id })`，不等待。
     - callee 契约：`loop` 经 `ensureRunning` —— 目标 Running 时丢弃传入 work 并 await 既有执行
       （消息由既有 runLoop 在下一个 provider turn 重读历史时消费）；Idle 时新起一次执行。
       两种情况都不产生第二个并行执行，故 I3 保持。
     - 该 fork 的失败被忽略：消息已在步骤 3 落库，唤醒失败不回滚已写入的消息（I2 的 preservation）。
  5. 返回 `Accepted{ target }`。
- **正确性论证**：
  - 前置：`message` 满足 `AgentMessage` 类型不变量中除"目标存在"以外的各项（前缀由 `render` 保证，
    sender 由 M5 填入）。
  - 论证：
    - 步骤 1、2 把"非自投递"与"目标存在"两条不变量在进入副作用之前验完，两者任一不成立即返回，
      故失败路径无副作用（满足 M5 的"判定失败的调用不写入任何消息"）。
    - 步骤 3 的 `noReply: true` 使落库与运行分离；`prompt` 的 ensures 保证返回时消息已持久化
      ⇒ 步骤 5 返回的 `Accepted` 满足 I2。
    - 步骤 4 在步骤 3 之后 ⇒ "消息持久化 happens-before 唤醒动作"（架构 §8 M3 的顺序约束）。
    - 目标 running 时由 `ensureRunning` 的 Running 分支保证不新起 run，满足后置条件"不新起 run"；
      非 running 时由 Idle 分支新起，满足"起一个新 run 消费该消息"。二分支覆盖 `AgentStatus` 全部取值。
  - 后置：返回 `Accepted` ⇒ 消息已落库；目标按其当时状态被加入或被启动。
  - 副作用论证：(1) 目标 Session 多一条 user message —— 步骤 3；(2) 可能启动目标的一次执行 —— 步骤 4；
    (3) 不写 `SessionStatus`、不改目标的 agent/model 绑定（步骤 3 显式传目标自己的 agent、不传 model）。
    无其它共享状态写入。

### 5.4 M4 AgentLifecycle

#### 5.4.1 `create(input) -> Effect<AgentInfo, DepthLimitReached | AgentNotFound>`

- **功能描述**：新建一个以调用者为父的子 Agent 并投递初始任务。
- **调用关系**：callers: M5 `agent`；callees: `Session.get`、`Session.create`、
  `deriveSubagentSessionPermission`、M3 `deliver`。
- **实现思路**：
  1. 由 §5.5.5 `callerDepth(caller)` 取调用者深度 `d`。
  2. 分支：`d >= cfg.subagent_depth`（默认 3）→ 返回 `DepthLimitReached{d, limit}`，无副作用。
     该检查在 M5 撤下工具之外**保留为第二道防线**：工具可见性由 M5 决定，但兼容入口 `task` 与
     插件直调仍可能绕过工具列表。
  3. 解析 `subagent_type` 对应的 agent 定义。不存在 → `AgentNotFound`（复用同一错误类型，data 带类型名）。
  4. 计算子 Session 权限：`deriveSubagentSessionPermission({ parentSessionPermission, subagent })`，
     再叠加既有 `childToolDenies` 中**保留**的两项（`todowrite`、`primary_tools`）。
     不再叠加对 `agent` 的 deny（§2.3）。
  5. `Session.create({ parentID: caller, title, agent, permission })` 得 `session`。
  6. 调用 M3 `deliver({ target: session.id, sender: caller, sender_agent, body: prompt })` 投递初始任务。
     - callee 契约：`deliver` 返回 `Accepted` 即消息已落库并已 fork 唤醒。新建 Session 必为 Idle，
       故走 Idle 分支新起执行。
     - 失败分支：`deliver` 失败时 Session 已创建。**不回滚** —— 空 Session 可由 `agent_send` 继续使用，
       删除反而丢失已分配的 id。失败原样上抛，M5 渲染时说明 Session 已建但任务未投递。
  7. 返回 `toInfo(session, relation="child", depth=d+1)`。
- **正确性论证**：
  - 前置：调用者 Session 存在。
  - 论证：
    - 步骤 2 在任何写入之前完成深度判定，故超限时无副作用。
    - 步骤 4 的权限是"父权限派生 ∩ agent 定义"再叠加保留的 deny 项，与既有 `task` 的构造一致，
      不放宽子 Agent 权限（越权约束见架构 §6，靠工具描述而非此处）。
    - 步骤 5 的 `parentID: caller` 使新 Session 满足 `AgentInfo` 的 `depth == 0 ⟺ parent_id == undefined`
      的对偶：`d+1 ≥ 1` 且 parent_id 非空。
    - 步骤 6 依 `deliver` 的 ensures 使初始任务落库并触发执行。
  - 后置：返回的 `AgentInfo` 对应一个新建的、parentID 为调用者的 Session；其初始任务已落库。
  - 副作用论证：(1) 新增一个 Session —— 步骤 5；(2) 该 Session 多一条 user message 并被启动 ——
    步骤 6 经 `deliver`；(3) 不修改调用者 Session 的任何字段。

#### 5.4.2 `plan(caller: SessionID, target: SessionID) -> Effect<StopPlan, NotAChild | AgentNotFound>`

- **功能描述**：把目标子树按深度分层，产出自底向上的停止计划。
- **调用关系**：callers: M4 `stop`；callees: M1 `isChild`、M1 `descendants`。
- **实现思路**：
  1. M1 `isChild(caller, target)`。为假 → `NotAChild{caller, target}`，无副作用。
     callee 契约：`isChild` 只读，失败通道为 `AgentNotFound`（目标不存在时）。
  2. M1 `descendants(target)` 得后代集合 `desc`。callee 契约：返回后代闭包，不含 target 自身，只读。
  3. 按 `depth` 把 `desc ∪ {target}` 分桶。target 的 depth 已知（调用者深度 +1），后代的 depth
     由 `descendants` 逐层展开时记录。
  4. 桶按 depth **降序**排列成 `layers`，即 `layers[0]` 为最深层，末层恰为 `[target]`。
     - 边界：`desc` 为空时 `layers == [[target]]`，仍满足"末元素恰为 `[target]`"。
  5. `notify_boundary = caller`。由步骤 1 已确认 `target.parentID === caller`，故该值恒为 target 的父，
     且恒不在 `⋃ layers` 内（caller 不是自己的后代，H2 排除环）。
  6. 返回 `{ target, layers, notify_boundary }`。
- **正确性论证**：
  - 前置：`caller` 与 `target` 对应的 Session 均存在。
  - 论证：
    - 步骤 2 的 ensures 给出后代闭包 ⇒ `⋃ layers = desc ∪ {target}` 满足类型不变量第一条。
    - 步骤 4 的降序排列直接给出"∀ i < j，layers[i] 的 depth > layers[j] 的 depth"。
    - target 是子树中 depth 最小者（其余都是它的后代，depth 严格更大），故降序后它单独构成末层。
    - 步骤 5 的论证见上，给出 `notify_boundary ∉ ⋃ layers`。
  - 后置：返回值满足 `StopPlan` 全部类型不变量。
  - 副作用论证：只经 `isChild` / `descendants` 读取，无写入。

#### 5.4.3 `stop(caller: SessionID, target: SessionID) -> Effect<StopOutcome, NotAChild | AgentNotFound>`

- **功能描述**：自底向上停止目标子树，逐层交付终止通知。
- **调用关系**：callers: M5 `agent_stop`；callees: M4 `plan`、`SessionRunState.cancel`、M3 `deliver`。
- **实现思路**：
  1. `plan(caller, target)`。失败原样上抛，无副作用。
  2. `stopped = []`，`notified = []`，`failed = []`。
  3. 对 `layers` **按序**遍历（`i` 从 0 到末），每层：
     a. 并发对该层每个成员调用 `SessionRunState.cancel(m)`。
        - callee 契约：`cancel` 的返回类型为 `Effect<void>`，无失败通道；对无活动执行的 Session
          是空操作（幂等，架构 §4.4）。
        - 单个成员抛出未预期异常时捕获，记入 `failed{session_id, reason}`，**不中断本层其余成员**，
          也不中断后续层（§3 传播规则）。成功者记入 `stopped`。
     b. 对该层每个成员，向其父投递终止通知：`deliver({ target: parentOf(m), sender: m, ... })`。
        - 通知文本由 §5.4.4 `renderTermination` 产出。
        - **await 本层全部 `Accepted` 返回后**才进入下一层。这是 I1 的实现点。
        - 投递失败记入 `failed`，不中断。
        - 成功投递的父记入 `notified`（去重）。
     c. 进入 `i+1` 层。
     - **终止性**：`layers` 长度有限（由 `plan` 产出，等于子树深度跨度），`i` 单调递增至末层，必然终止。
  4. 返回 `{ stopped, notified, failed }`。
- **正确性论证**：
  - 前置：`target` 是 `caller` 的直接子（由步骤 1 的 `plan` 保证）。
  - 论证：
    - 步骤 3b 的 await 使"第 i 层全部通知已 `Accepted`" happens-before "第 i+1 层被取消"。
      结合 `deliver` 的 ensures（`Accepted` ⇒ 已落库），得到 I1：对任一被停止的 a，若其父 p 也在
      停止集内，则 p 位于比 a 更浅的层（p 是 a 的父 ⇒ depth 小 1 ⇒ 在后续层），a 的通知在第 i 层投递、
      p 在第 i+1 层才被取消，故通知落库 happens-before p 被取消。
    - 由此每条通知投递时接收方仍在运行，`deliver` 走 Running 分支加入既有执行，不会因 Idle 分支
      新起 run 而复活刚停止的 Agent（架构 §4.4）。
    - `notify_boundary`（即 caller）不在任何层内，末层 target 的通知投给它时它全程在运行
      —— 它正在执行本次 `agent_stop` 调用。
    - 单成员失败只写 `failed` 不中断 ⇒ 后置的"stopped ∪ failed = ⋃ layers"由步骤 3a 的二分穷尽保证。
  - 后置：`StopOutcome` 满足其类型不变量；目标子树全部成员的当前执行已终止或已记入 `failed`。
  - 副作用论证：(1) 子树各成员的活动执行被中断 —— 步骤 3a；(2) 各成员的父 Session 各多一条通知消息
    —— 步骤 3b 经 `deliver`；(3) 不删除任何 Session、消息或历史（`cancel` 的既有语义只中断执行）。

#### 5.4.4 `renderTermination(stopped: AgentInfo, limits) -> string`

- **功能描述**：产出终止通知文本。
- **实现思路**：包含四项：被停 Agent 的 `session_id`、其 `agent` 名与任务简述、"Session 与历史已保留，
  可用 `agent_send` 恢复"、"文件系统与版本控制状态可能包含部分改动"。经 `Truncate.limits()` 限长，
  与既有 subagent 错误渲染共用同一上界。
- **正确性论证**：trivial —— 纯文本组装，无分支、无副作用。

### 5.5 M5 AgentTools

#### 5.5.1 `agent(params, ctx) -> Effect<string>`

- **功能描述**：创建子 Agent 并渲染结果。
- **调用关系**：callees: M4 `create`。
- **实现思路**：
  1. 从 `ctx.sessionID` 取 caller，不接受模型提供的调用者身份（架构 §5 接口协议）。
  2. **不调用 `ctx.ask`**（架构 §6）。权限规则仍可在工具注册层拒绝本工具或某个 `subagent_type`。
  3. 调 M4 `create({ caller, subagent_type, description, prompt })`。
  4. 分支：成功 → 渲染 `AgentInfo`（含 `session_id`，供后续 `agent_send` / `agent_stop` 寻址）；
     `DepthLimitReached` → 渲染"已达嵌套上限"；`AgentNotFound` → 渲染"未知 agent 类型"。
  5. 返回文本。
- **正确性论证**：非平凡（跨模块调用）。前置：调用发生在某 Session 的工具上下文中。论证：步骤 1 使
  caller 不可伪造；步骤 3 的所有失败在步骤 4 被穷尽映射为文本，无未处理分支；成功路径的副作用完全
  由 `create` 承担，本函数自身不写 Session。后置：返回模型可读文本。副作用：委托给 M4，本函数无。

#### 5.5.2 `agent_list(ctx) -> Effect<string>`

- **功能描述**：渲染调用者的邻居 roster。
- **调用关系**：callees: M1 `neighborhood`、M2 `of`。
- **实现思路**：
  1. `neighborhood(ctx.sessionID)`。失败 → 渲染错误返回。
  2. 对每个成员调用 M2 `of(session_id)` 填 `status`。可并发，无顺序要求
     —— `of` 的功能规约声明只读且结果为即时快照。
  3. 渲染为紧凑表：`session_id` / `relation` / `agent` / `status` / `title`。
  4. 边界：`members` 只含自己（主 Agent 且无子）时仍返回该行，不返回空结果——空表会让模型误判为出错。
- **正确性论证**：非平凡（跨模块调用）。论证：步骤 2 对每个成员各调一次 `of`，成员集合有限且来自
  步骤 1 的输出，故遍历必然终止；`of` 无失败通道，故本步无失败分支。后置：每行的 status 是该次调用
  瞬间的快照，不保证行间一致——这是架构 §5 M5→M2 接口协议已声明的。副作用：无。

#### 5.5.3 `agent_send(params, ctx) -> Effect<string>`

- **功能描述**：向任一存在的 Session 投递消息。
- **调用关系**：callees: `Session.get`（取 sender 的 agent 名）、M3 `deliver`。
- **实现思路**：
  1. caller 取自 `ctx.sessionID`。
  2. 取 caller 的 `agent` 名作为 `sender_agent`（仅用于前缀可读性）。
  3. 构造 `AgentMessage{ target: params.session_id, sender: caller, sender_agent, body: params.message }`。
  4. 调 M3 `deliver`。**不做邻居校验，不做同树校验**（架构 §6）。
  5. 分支：`Accepted` → 渲染"已接受，未等待目标完成"；`SelfDelivery` → 渲染"不能给自己发消息"；
     `AgentNotFound` → 渲染"目标 Session 不存在"。
  6. 返回文本。
- **正确性论证**：非平凡（跨模块调用 + 状态变更）。论证：步骤 3 的 `sender` 取自上下文而非入参，
  故模型无法伪造发送者；`deliver` 的三种终态在步骤 5 被穷尽覆盖；失败两支均由 `deliver` 在写入前
  返回，故失败时无副作用。后置：返回文本表示"已接受"或明确的失败原因。副作用：成功路径下目标
  Session 多一条消息并可能被启动，均由 `deliver` 承担。

#### 5.5.4 `agent_stop(params, ctx) -> Effect<string>`

- **功能描述**：停止直接子 Agent 及其后代。
- **调用关系**：callees: M4 `stop`。
- **实现思路**：
  1. caller 取自 `ctx.sessionID`。
  2. 调 M4 `stop(caller, params.session_id)`。
  3. 分支：成功 → 渲染 `StopOutcome`，`failed` 非空时**必须**逐条列出（架构 §5 M5→M4 协议要求显式报告）；
     `NotAChild` → 渲染"只能停止自己直接派生的 Agent"；`AgentNotFound` → 渲染"目标不存在"。
  4. 返回文本。
- **正确性论证**：非平凡（跨模块调用 + 状态变更）。论证：`stop` 的三种终态在步骤 3 被穷尽覆盖；
  `failed` 非空时的渲染是协议硬要求，不得省略或折叠。后置：返回文本如实反映哪些成员被停止、
  哪些父收到通知、哪些失败。副作用：委托给 M4。

#### 5.5.5 `available(ctx) -> Effect<ToolName[]>` 与 `callerDepth(id)`

- **功能描述**：按调用者深度决定向模型暴露哪些工具。
- **调用关系**：callers: 工具注册；callees: `Session.get`。
- **实现思路**：
  1. `callerDepth(id)`：从 `id` 起沿 `parentID` 向上遍历计数，主 Agent 为 0。
     - **终止性**：`parentID` 链无环且深度有限（H2），每步严格上移一层，故必然到达 `parentID == undefined`。
     - 与既有 `task.ts` 的深度计算完全一致，实现时抽为共享函数，避免两处口径漂移。
  2. 分支：`depth >= cfg.subagent_depth` → 返回 `[agent_list, agent_send]`；
     否则返回 `[agent, agent_list, agent_send, agent_stop]`。
  3. 判据是深度到限，**不是**当前是否有子 Agent（架构 §6）——否则 `agent_stop` 会随派生忽隐忽现。
- **正确性论证**：
  - 前置：`ctx.sessionID` 对应的 Session 存在。
  - 论证：到限的 Agent 无法再派生（步骤 2 撤下 `agent`，且 M4 `create` 的步骤 2 仍会拒绝），
    故其子集合永久为空 ⇒ `agent_stop` 的寻址集合永久为空 ⇒ 撤下不损失任何可用能力。
    `agent_send` 与 `agent_list` 的寻址集合含父与兄弟，与深度无关 ⇒ 保留。
  - 后置：返回的工具集合恰为寻址集合非空者。
  - 副作用论证：只读 Session，无写入。

#### 5.5.6 `task` 兼容入口

- **功能描述**：不向模型展示的旧名入口。
- **实现思路**：接受旧参数形状，把 `task_id` 规范化为 `session_id` 后转发：给了 `task_id` → 转 `agent_send`；
  未给 → 转 `agent`。旧的 `background` 参数被忽略（Agent 恒为异步，架构 §6）。不维护第二套状态、
  执行路径或测试基准（调研 §8）。
- **正确性论证**：trivial —— 参数改名加分发，无独立逻辑。

## 6. 完整性自检 checklist

- [x] 所有函数实现思路推导连续（无跳步）—— 每个非 trivial 函数按编号步骤展开，含入参校验、callee 调用、
      返回值三路处理
- [x] 所有 if / else / switch 分支已覆盖 —— `neighborhood` 的有无父、`of` 的三支状态、`deliver` 的
      running/非 running、`stop` 的单成员成功/失败、`available` 的到限/未到限均已刻画
- [x] 所有退出点（成功 / 失败 / 异常）已刻画 —— §3 定义四个失败类型，每个函数的失败分支均标注
      "无副作用"或说明已产生的副作用
- [x] 所有 callee 调用显式引用其 pre / post —— `Session.children`、`SessionStatus.get`、`prompt(noReply)`、
      `loop`/`ensureRunning`、`SessionRunState.cancel` 的契约均在使用点引述
- [x] 所有循环有终止性论证 —— `descendants`（`seen` 单调增长且有上界）、`stop`（层数有限）、
      `callerDepth`（每步上移一层，链无环有限）
- [x] 所有上游事实显式列出 —— H2（parentID 链无环且深度有限）在 `neighborhood` / `descendants` /
      `callerDepth` / `plan` 的使用点各自标注；I2、I3 在 `deliver` 的论证中显式引用
