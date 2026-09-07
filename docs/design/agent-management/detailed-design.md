# 细化设计 — agent-management

- 状态：细化阶段，等待确认
- 日期：2026-09-06
- 上游依据：`docs/design/agent-management/architecture.md`（架构阶段已确认）
- 代码基线：`dev` @ `a4293ca229`

## 1. 范围

本细化覆盖架构 §4 的六个模块，共 22 个函数（18 个承担模块规约，4 个内部辅助）：

| 模块 | 函数 | 内部辅助 | 承接 goal |
|---|---|---|---|
| M1 AgentTree | `neighborhood` / `children` / `descendants` / `isChild` | `toInfo` | G1 G2 G4 G5 |
| M2 AgentStatusProjection | `of` | — | G1 G2 |
| M3 AgentInbox | `deliver` | `render` | G3 G4 |
| M4 AgentLifecycle | `create` / `plan` / `stop` | `renderTermination` | G4 G5 |
| M6 AgentExecution | `ensure` / `runExecution` / `watch` / `cancelAndAwaitNotice` | `renderTermination` | G3 G4 |
| M5 AgentTools | `agent` / `agent_list` / `agent_send` / `agent_stop` / `available` | `callerDepth`、`task` 兼容入口 | G1–G5 |

另含对既有代码的五处改动（§2.3）。本细化不改变架构确定的模块划分、接口规约与核心流程。

未启用 §6 v2 子计划流程：本 feature 为首次落地，契约由架构文档一次性确立，无既有契约被修改。
后续对本 feature 的契约变更再按 §2.3 步骤 2 分配 subplan-id，前缀 `agm`。

本细化的覆盖基准是 `docs/design/agent-management/task-inventory.md`：`task.ts` 全部 42 条既有
行为的处置对照。首轮细化因未做此对照而遗漏 16 条，其中结果判定与失败分类整块 6 条现落在 M6。

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
| `Worktree.create` / `remove` | M4 建/清理子 Agent 的工作树 | 既有服务（`opencode/src/worktree/index.ts`），此前只由 experimental HTTP 与 control-plane adapter 使用 |
| `Git` 状态查询 | M6 判断 worktree 有无改动以决定是否清理 | 既有服务 |

### 2.2 需要适配

- `TaskPromptOps` 当前只有 `cancel` / `resolvePromptParts` / `prompt`，M3 还需要 `loop`。新增一个成员，
  签名与 `SessionPrompt.loop` 一致。
- `Truncate.limits()` 供 M3 渲染终止通知时限长，与既有 subagent 错误渲染共用同一上界。

### 2.3 必须修改的既有代码

逐条依据见 `task-inventory.md`。

| 位置 | 改动 | 清单条目 |
|---|---|---|
| `task.ts` 深度门 | `?? 1` → `?? 3` | 1.3 |
| `core/src/v1/config/config.ts` | `subagent_depth` 的 schema 说明文字仍写 Defaults to 1 | 1.3 |
| `task.ts` `ctx.ask` | **保留调用**，把 `agent` 的兜底动作由 `ask` 改 `allow`；`task` 与 `agent` 共用权限 key | 1.4 |
| `task.ts` `childToolDenies` | 移除对 `agent` 的无条件 deny；保留 `todowrite` 与 `primary_tools`；合并时按三元组去重 | 2.3、2.4 |
| `task.ts` `background` 分支 | 移除参数、实验开关与前台分支 | 1.1、4.4 |
| `task.ts` `onPromote` / `waitForPromotion` / `background.promote` | 前台废弃后成为死代码，一并清理 | 4.5 |
| `task.ts` `notify` / `inject` | 迁入 M6：补 `cancelled` 分支、投递目标改为**目标的 parentID**、暴露通知已落库的可等待信号 | 6.1、6.3、6.4 |
| `task.ts` `background.extend` 分支 | 移除 | 4.1 |
| `task.ts` 三段 background 常量 | 随前台与 extend 一并移除，`agent` 的描述重写 | 8.5 |
| `session/session.ts` `remove` | 递归删除子 Session 时一并移除其自建工作树（按 project 的 sandbox 列表判定），否则留下孤儿 | 调研 §15 |
| `tui/src/routes/session/index.tsx` `children()` | 权限与 question 的聚合改为整棵后代，否则深度提到 3 后孙辈的权限请求无处应答 | 架构 §10 缺口 5 |

## 3. 错误处理策略

**错误模型**：沿用仓库既有的 Effect typed error。本 feature 定义六个失败类型，均为可预期的调用方错误，
不使用异常，不使用 `Effect.orDie`。

```
AgentNotFound      { session_id }         目标 Session 不存在
AgentTypeNotFound  { subagent_type }      agent 创建时指定的 agent 定义不存在
NotAChild          { caller, target }     agent_stop 的目标不是调用者的直接子
SelfDelivery       { target }             agent_send 的目标是发送者自己
DepthLimitReached  { depth, limit }       agent 创建时已达嵌套上限
WorktreeUnavailable{ reason }             创建工作树失败（非 git 仓库 / 名称生成失败 / git 命令失败）
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

新增的六个错误类型见 §3。按 §2.4 的判定原则，它们被 M1/M3/M4/M6 产出、被 M5 消费，出现在多个模块的
接口规约里，因此属**跨模块共享**，已同步登记进架构 §3 数据结构节。

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

#### 5.1.2 `children(id: SessionID, depth: NonNegativeInt) -> Effect<AgentInfo[], AgentNotFound>`

- **功能描述**：取 `id` 的直接子。`depth` 是子的深度，由调用方给出（父深度 +1），本函数不自行推算。
- **调用关系**：callers: M1 `neighborhood`/`descendants`、M4 `plan`；callees: `Session.children`。
- **实现思路**：调用 `Session.children(id)`，逐项经 `toInfo(session, "child", depth, status)` 转换，`status` 由调用方逐项提供。
  `Session.children` 的 ensures 是"返回 parent_id == id 的全部 Session"，对不存在的 id 返回空数组而非失败，
  故本函数无失败分支；`AgentNotFound` 保留在签名中仅为与 M1 其余函数一致，实际不产生。
- **正确性论证**：trivial —— 单次 callee 调用加逐项纯转换，无分支、无循环、无副作用。

#### 5.1.3 `descendants(id: SessionID, baseDepth: NonNegativeInt) -> Effect<AgentInfo[], AgentNotFound>`

- **功能描述**：取 `id` 的后代闭包，不含 `id` 自身。每个成员的 `depth` 由展开层数相对 `baseDepth`
  递推得出，供 M4 `plan` 分层使用。仅供 M4 展开停止级联。
- **调用关系**：callers: M4 `plan`；callees: M1 `children`。
- **实现思路**：
  1. `frontier = [id]`，`acc = []`，`seen = {id}`，`level = baseDepth`。
  2. 循环：`frontier` 非空时，`level += 1`，取出全部元素，对每个调用 `children(m, level)`，把结果中
     `session_id ∉ seen` 的加入 `acc`、加入 `seen`、构成 `next`。`frontier = next`。
     - 同一轮取出的成员深度相同，故该轮所有子的 depth 均为 `level`，无需逐节点回溯。
     - 分支：`children` 返回空 → 该分支不贡献 `next`，其余分支照常。
     - `seen` 去重是防御性的：H2 已排除环，去重只保证即使存储异常也必然终止。
  3. `frontier` 为空 → 退出循环，返回 `acc`。
  - **终止性**：每轮加入 `acc` 的成员都新入 `seen` 且永不移除，`seen` 单调增长；Session 总数有限
    （H2：深度有限，且每层成员有限），故 `seen` 有上界，循环必然终止。
  - **循环不变量**：`acc == seen \ {id}`；`acc` 中每个成员都是 `id` 的后代；且其 `depth` 等于
    `baseDepth + 从 id 到它的边数`。
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

#### 5.1.5 `toInfo(session, relation, depth, status) -> AgentInfo`

- **字段来源**：`directory` 取 `Session.Info.directory`；其余字段同名映射。

- **功能描述**：把 `Session.Info` 转成完整 `AgentInfo`。`status` 由调用方给出——`AgentInfo.status`
  是必填字段，本函数不产出不完整的值：`agent_list` 先经 M2 `of` 取状态再传入，`create` 直接传 `running`
  （执行刚注册）。
- **正确性论证**：trivial —— 纯字段映射，无分支。`depth` 由调用方传入：`neighborhood` 中
  self 的 depth 需一次向上遍历取得，见 §5.5.5 `callerDepth`，其余成员的 depth 由 self 推出
  （parent = self−1，child = self+1，sibling = self）。

#### 5.1.6 `callerDepth(id: SessionID) -> Effect<NonNegativeInt, AgentNotFound>`

- **功能描述**：从 `id` 起沿 `parentID` 向上遍历计数，主 Agent 为 0。
- **调用关系**：callers: M1 `neighborhood`、M4 `create`、M4 `plan`、M5 `available`；callees: `Session.get`。
- **归属说明**：本函数是父子链遍历，与 M1 其余函数同源。首轮把它放在 M5，而 M1 与 M4 都要调用，
  形成 M5→M4/M1 与 M4/M1→M5 的反向依赖；归入 M1 后调用图恢复单向。
- **实现思路**：
  1. `depth = 0`，`current = Session.get(id)`。失败 → `AgentNotFound{id}`。
  2. 循环：`current.parentID` 非空时，`depth += 1`，`current = Session.get(current.parentID)`。
  3. `parentID` 为空 → 返回 `depth`。
  - **终止性**：`parentID` 链无环且深度有限（H2），每步严格上移一层，必然到达 `parentID == undefined`。
  - 与既有 `task.ts:236-242` 的深度计算口径一致，实现时二者共用同一函数，避免漂移。
- **正确性论证**：非平凡（含循环 + 跨模块调用）。前置：`id` 对应的 Session 存在；链无环（H2）。
  论证：不变量"depth 等于已上移的层数"在初始成立，每轮 +1 且上移一层保持；退出时 `current` 是根，
  故 depth 等于 `id` 到根的边数。后置：返回值即 `id` 的深度，主 Agent 为 0。副作用：只读。

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

- **功能描述**：以目标 Session 自身的身份写入消息，并确保目标存在一次在跑的执行。
- **调用关系**：callers: M4 `create`、M5 `agent_send`；callees: `Session.get`、`SessionPrompt.prompt`、
  M6 `ensure`。**不再被 M4 `stop` 调用** —— 取消通知由 M6 单一生产（架构 I5）。
- **实现思路**：
  1. 校验 `message.sender !== message.target`，否则返回 `SelfDelivery{target}`，无副作用。
  2. `Session.get(message.target)`。失败 → `AgentNotFound{target}`，无副作用。成功得 `target`。
     此处**不校验**邻居关系，也不校验同树（架构 §6）。
  3. 解析身份三项，全部显式取自目标 Session，逐项给出 fallback：
     - `agent = target.agent ?? agents.defaultInfo().name`。`Session.Info.agent` 可选；为空只可能出现在
       从未绑定过 agent 的主 Session 上。省略该参数会让 `createUserMessage` 落到 `agents.defaultInfo()`，
       与此 fallback 同值，但显式写出以免读者误以为"省略即保持"。
     - `model = target.model ?? 该 agent 定义的 model ?? provider 默认模型`。**必须显式传**：
       `createUserMessage` 的优先级是 `input.model ?? ag.model ?? currentModel(sessionID)`，
       agent 定义的模型排在 Session 当前模型**之前**，省略会让一条消息改写并持久化目标的绑定。
     - `variant = target.model?.variant`，同为空时不传。
  4. 调用 `prompt({ sessionID: target.id, agent, model, variant, parts: [{type:"text", text: render(message)}],
     noReply: true })`。
     - callee 契约：`prompt` 在 `noReply === true` 时的 ensures 是"创建并持久化 user message 后返回该
       message，不进入 loop"。因此本步返回即满足 I2。
     - 失败分支：`prompt` 的失败通道为 `Image.Error`（附件解码）。本调用只传纯文本 part，不触发该路径；
       仍将其映射为 `AgentNotFound{target}` 兜底，不向上暴露 Image 层类型。
  5. 调用 M6 `ensure(target.id)`，等待其返回。
     - callee 契约：目标已有在跑的执行 ⇒ 空操作，既有 watcher 继续持有唯一结局交付权；无在跑执行 ⇒
       注册一次执行与恰一个 watcher。两种情况都不产生第二个 watcher（架构 I4）。
     - 与首轮设计的区别：首轮是 fork `loop` 且忽略失败，结果是**没有任何结局交付者**。现在由 M6 承担
       注册与交付，`ensure` 的失败原样上抛——消息已落库不回滚（I2），但调用方需要知道执行没起来。
  6. 返回 `Accepted{ target }`。
- **正确性论证**：
  - 前置：`message` 满足 `AgentMessage` 类型不变量中除"目标存在"以外的各项。
  - 论证：
    - 步骤 1、2 把"非自投递"与"目标存在"在进入副作用之前验完，失败路径无副作用。
    - 步骤 3 逐项显式解析，使后置条件"agent / model / variant 取自目标"成立。三项都给了 fallback 链，
      不存在未定义取值。
    - 步骤 4 的 `noReply: true` 使落库与运行分离；`prompt` 的 ensures 保证返回时已持久化 ⇒ 步骤 6 的
      `Accepted` 满足 I2。
    - 步骤 5 在步骤 4 之后 ⇒ "消息持久化 happens-before 起执行"，满足 M3→M6 接口协议的调用方责任
      （否则新起的执行可能读不到该消息）。
  - 后置：返回 `Accepted` ⇒ 消息已落库且目标存在一次在跑的执行。
  - **I4 保持论证**：本函数不注册 watcher，只调 `ensure`；`ensure` 对已在跑的目标是空操作。故连发多条
    消息不产生第二个 watcher，它们进入同一消息序列由同一个 watcher 交付一次结局。
  - 副作用论证：(1) 目标 Session 多一条 user message —— 步骤 4；(2) 经 M6 可能注册一次执行 —— 步骤 5；
    (3) 因步骤 3 显式传三项，目标的 agent/model/variant 绑定值不变（`setAgentModel` 在解析值与当前值
    相同时不写）。无其它共享状态写入。

### 5.4 M4 AgentLifecycle

#### 5.4.1 `create(input) -> Effect<AgentInfo, DepthLimitReached | AgentTypeNotFound | AgentNotFound | WorktreeUnavailable>`

- **功能描述**：新建一个以调用者为父的子 Agent，继承调用者当次的模型身份，并投递初始任务。
- **调用关系**：callers: M5 `agent`；callees: `callerDepth`、`agent.get`、`MessageV2.get`、
  `deriveSubagentSessionPermission`、`Session.create`、`resolvePromptParts`、M3 `deliver`。
- **实现思路**：
  1. `callerDepth(caller)` 得 `d`。
  2. `d >= cfg.subagent_depth`（默认 3）→ `DepthLimitReached{d, limit}`，无副作用。工具可见性已在 M5
     撤下本工具，此处是第二道防线：`task` 兼容入口与插件直调不经工具列表。
  3. `agent.get(subagent_type)`。不存在 → `AgentTypeNotFound{subagent_type}`，无副作用。得 `next`。
  4. **读取调用者当次的 assistant 消息**取继承源（清单 §3.1）：
     `MessageV2.get({ sessionID: caller, messageID: ctx.messageID })`。角色不是 assistant → 失败。
     - 为什么必须读它：`variant` 只存在于消息上，Session 不持有；继承模型也取自这条消息，
       而非 Session 的当前模型——同一 Session 的不同轮次可能用不同模型。
  5. 解析模型身份，**照既有规则逐条复制**（清单 §3.2、§3.3）：
     - `model = next.model ?? { modelID: msg.modelID, providerID: msg.providerID }`
       —— subagent 定义固定模型优先，否则继承调用者当次的模型。
     - `variant = next.model ? undefined : msg.variant`
       —— **只在 subagent 未固定模型时**才继承 variant。固定了模型再带父的 variant 没有意义。
  6. 计算子 Session 权限：`deriveSubagentSessionPermission({ parentSessionPermission: caller.permission ?? [], subagent: next })`
     得 `childPermission`；再构造保留的两类 deny（`todowrite`、`experimental.primary_tools`），
     **不再包含对 `agent` 的 deny**（清单 §2.3）。
     - 合并时按 `(permission, pattern, action)` 三元组**去重**：`childPermission` 里已有同样规则的不重复追加
       （清单 §2.4）。
  6.1 解析工作目录（调研 §15）：
     - 给了 `cwd` → 直接用它，**不建 worktree**，**不追加任何权限放行**。
       - 安全理由：`cwd` 由模型提供。若为它自动放行 `external_directory`，模型可用
         `agent(cwd: <任意目录>)` 给自己开出绕过口。该目录在 instance 之外时，其首次文件操作照常
         触发一次权限询问，由用户裁决——这是有意保留的交互，与「四个工具不弹确认」不冲突：
         不弹的是工具本身，越出项目的访问仍由既有机制把关。
       - 自建工作树不需要这条规则，因为它在项目内（见上）。
     - 未给 → `Worktree.create()` 得 `info.directory`。
       - 根目录取**主仓根下**的 `<主 checkout>/.opencode/worktrees/<slug>`，不用 `Worktree.create`
         现有的 `Global.Path.data/worktree/<projectID>`。`CreateInput` 需增加一个根目录参数；
         既有调用方（experimental HTTP、control-plane adapter）不传，行为不变。
       - **必须平铺在主仓根下，不得嵌在创建者自己的工作树里**（对齐 Claude Code 的
         「under `.claude/worktrees/<name>/` at your repository root」）。嵌套会导致：子 Agent 的工作树
         位于父的工作树内且被 gitignore，父 `git status` 看不到它 → 父被判定无改动而清理 →
         **子的工作随父的工作树一并删除**。平铺后各工作树互为兄弟，父的清理不触及子。
       - **放在项目内是为了不需要权限放行**：`containsPath` 检查 `ctx.directory` 与 `ctx.worktree`，
         项目内的路径直接为真，`external_directory` 不会触发。放在项目外则每个自建工作树都要预置
         一条放行规则，而那条规则本身又要防着被 `cwd` 滥用。
       - 首次使用时在 `<ctx.worktree>/.opencode/worktrees/` 写一个内容为 `*` 的 `.gitignore`——
         **自我忽略**，不改用户的 `.gitignore`。必须忽略：ripgrep 默认尊重 gitignore
         （`ripgrep.ts:155-165` 无 `--no-ignore`），不忽略则 `glob`/`grep` 会把每个工作树里的副本
         都搜出来。
       - `git worktree add --no-checkout -b <slug> <dir>`，不给 start-point 即**从当前 HEAD 切**；
         并调用 `project.addSandbox(projectID, directory)` 登记归属。嵌套时「当前 HEAD」仍是创建者
         自己工作树的 HEAD（`git worktree add` 在其 cwd 内执行），因此工作逐层叠加；
         但**新工作树的位置在主仓根下**，与创建者的工作树平级。
       - 复制环境文件：读项目根的 `.worktreeinclude`（gitignore 语法），对每条模式取匹配文件，
         再用 `Git` 判定其确被 gitignore，二者皆真才复制进新工作树。只复制被忽略的文件，
         已跟踪文件不重复。该文件不存在则跳过本步。
       - 复制失败（单个文件读写错误）→ **记日志并继续**，不使创建失败：工作树本身可用，
         缺的是便利文件；为此让整次创建失败代价更大。初始任务正文中附一行说明哪些文件未复制成功。
     - `Worktree.create` 失败（`NotGitError` / `NameGenerationFailedError` / `CreateFailedError`）
       → 映射为 `WorktreeUnavailable{reason}` 返回，不建 Session。此时尚无任何副作用需要回滚
  7. `Session.create({ parentID: caller, title, agent: next.name, permission })`。
     - `title = description + " (@" + next.name + " subagent)"`，照既有约定（清单 §2.5）。roster 显示的就是它。
  8. `resolvePromptParts(prompt)` 展开正文里的 `@file` 引用（清单 §8.2），得到 parts；
     在其前面追加一段工作目录声明：该 Agent 的工作目录为 `<directory>` 的绝对路径，要求以绝对路径操作。
     - 声明是**约定**不是强制：六个文件工具都接受绝对路径，但子 Agent 仍可用主 checkout 的绝对路径
       操作而不被 `external_directory` 拦下（后者只防出 instance 目录）。强度边界见架构 §9 与 issue #33。
  9. M3 `deliver({ target: newSession.id, sender: caller, sender_agent, body: parts })`。
     - callee 契约：返回 `Accepted` ⇒ 初始任务已落库且执行已注册（M6 `ensure`）。新 Session 必为 idle，
       故走 `ensure` 的注册分支，产生本次执行的唯一 watcher，结局交付给新 Agent 的父（即 caller）。
     - 失败分支：Session 已创建。**不回滚** —— 空 Session 可由 `agent_send` 继续使用，删除反而丢失
       已分配的 id。失败原样上抛，M5 渲染时说明 Session 已建但任务未投递。
  10. 写工具元数据：`ctx.metadata({ title: description, metadata: { parentSessionId: caller, sessionId: newSession.id, model } })`
      （清单 §8.1）。TUI 的 task 卡片靠这些字段渲染，缺了卡片就是空的。
  11. 返回 `toInfo(newSession, relation="child", depth=d+1, status=running)`，其 `directory` 取步骤 6.1
      解析出的工作目录——调用方需要它才能去查看子 Agent 的产出。
      状态直接给 `running`：步骤 9 已确保执行注册，无需再查一次 `SessionStatus`。
- **正确性论证**：
  - 前置：调用者 Session 存在；`ctx.messageID` 指向调用者当次的 assistant 消息。
  - 论证：
    - 步骤 1–4 的四个失败分支都在任何写入之前，故失败时无副作用。
    - 步骤 5 逐条复制既有规则，使新 Agent 的模型身份与既有 `task` 一致；若省略（首轮设计的做法），
      新 Session 无 model，`createUserMessage` 会一路回退到 provider 默认模型，而不是继承调用者。
    - 步骤 6 的去重使权限集合不含重复规则；`deriveSubagentSessionPermission` 的既有语义保证子权限
      不宽于父。
    - 步骤 9 依 `deliver` 的 ensures 与 M6 `ensure` 的 ensures，得到"初始任务已落库 ∧ 恰一个 watcher
      已注册 ∧ 结局将交付给 caller"。这是 G4「结局由通知通道交付」在创建路径上的落点，
      也是首轮设计缺失的那一环。
    - 步骤 11 的 `depth = d+1` 与 `parentID = caller` 一致，满足 `AgentInfo` 的
      `depth == 0 ⟺ parent_id == undefined`。
  - 后置：返回的 `AgentInfo` 对应一个新建的子 Session；其初始任务已落库，执行已注册，结局有唯一交付者。
  - 副作用论证：(1) 新增一个 Session —— 步骤 7；(2) 该 Session 多一条 user message 且执行已注册 ——
    步骤 9 经 `deliver` 与 M6；(3) 工具调用的展示元数据 —— 步骤 10；(4) 不修改调用者 Session 的任何字段。

#### 5.4.2 `plan(caller: SessionID, target: SessionID) -> Effect<StopPlan, NotAChild | AgentNotFound>`

- **功能描述**：把目标子树按深度分层，产出自底向上的停止计划。
- **调用关系**：callers: M4 `stop`；callees: M1 `isChild`、M1 `descendants`。
- **实现思路**：
  1. M1 `isChild(caller, target)`。为假 → `NotAChild{caller, target}`，无副作用。
     callee 契约：`isChild` 只读，失败通道为 `AgentNotFound`（目标不存在时）。
  2. `targetDepth = callerDepth(caller) + 1`（由步骤 1 已确认 target 是 caller 的直接子）。
  3. M1 `descendants(target, targetDepth)` 得后代集合 `desc`，每个成员已带 `depth`。
     callee 契约：返回后代闭包，不含 target 自身；成员 depth = `targetDepth` + 到 target 的边数；只读。
  4. 按 `depth` 把 `desc ∪ {target}` 分桶。target 自身的 depth 为 `targetDepth`。
  5. 桶按 depth **降序**排列成 `layers`，即 `layers[0]` 为最深层，末层恰为 `[target]`。
     - 边界：`desc` 为空时 `layers == [[target]]`，仍满足"末元素恰为 `[target]`"。
  6. `notify_boundary = caller`。由步骤 1 已确认 `target.parentID === caller`，故该值恒为 target 的父，
     且恒不在 `⋃ layers` 内（caller 不是自己的后代，H2 排除环）。
  7. 返回 `{ target, layers, notify_boundary }`。
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

- **功能描述**：自底向上取消目标子树，逐层等待取消通知落库。**本函数不投递任何通知** —— 通知由 M6
  的 watcher 单一生产（架构 I5）。
- **调用关系**：callers: M5 `agent_stop`；callees: M4 `plan`、M6 `cancelAndAwaitNotice`。
- **实现思路**：
  1. `plan(caller, target)`。失败原样上抛，无副作用。
  2. `transitioned = []`，`unchanged = []`，`failed = []`。
  3. 对 `layers` 按序遍历（`i` 从 0 到末），每层：
     a. 并发对该层每个成员 `m` 调用 M6 `cancelAndAwaitNotice(m.session_id)`。
        - callee 契约：目标有在跑的执行 ⇒ 取消它并**等待其取消通知已持久化**后返回
          `{ transitioned: true }`；无在跑执行 ⇒ 不取消、不产生通知，返回 `{ transitioned: false }`。
        - `transitioned === true` → 记入 `transitioned`；`false` → 记入 `unchanged`。
        - 抛出未预期异常 → 记入 `failed{session_id, reason}`，**不中断本层其余成员，也不中断后续层**。
     b. **收齐本层全部返回后**才进入 `i+1` 层。这是 I1 的实现点：本层中 `transitioned` 的成员，
        其取消通知已在返回时落库；它们的父在后续层才被取消。
     - 三分支穷尽：每个成员必落入 `transitioned` / `unchanged` / `failed` 之一，故
       `StopOutcome` 的"三者并集等于 ⋃ layers 且两两不交"成立。
     - **终止性**：`layers` 长度有限（由 `plan` 产出，等于子树深度跨度），`i` 单调递增至末层。
  4. 返回 `{ transitioned, unchanged, failed }`。
- **正确性论证**：
  - 前置：`target` 是 `caller` 的直接子（由步骤 1 的 `plan` 保证）。
  - 论证：
    - **I1**：设 a 实际发生转变、其父 p 也在停止集内。p 是 a 的父 ⇒ p 的 depth 比 a 小 1 ⇒ 按 `plan`
      的降序分层，p 位于比 a 更靠后的层。步骤 3b 要求收齐第 i 层返回才进入第 i+1 层，而
      `cancelAndAwaitNotice` 在 `transitioned: true` 时已保证通知落库，故
      「a 的取消通知已持久化」happens-before「p 被取消」。排序是结构性的，不依赖 watcher 的调度时机
      —— 这正是首轮设计做不到的地方：那时通知由 fork 出去的 watcher 异步投递，`cancel` 返回并不意味着
      通知已落库。
    - **防复活**：由 I1，每条取消通知投递时其接收方（父）仍在运行，M6 的交付只会加入其当前执行，
      不会因 Idle 而新起一次，故不会复活刚被停止的 Agent。
    - **幂等**：对已无活动执行的成员，`cancelAndAwaitNotice` 返回 `transitioned: false`，不取消、
      不发通知。因此重复 `stop` 不产生额外通知，也不报错——首轮设计把所有未抛异常者都算作已停止
      并逐个发通知，正是重复通知与不实通知的来源。
    - **通知真实性**：`failed` 的成员未记入 `transitioned`，M6 也不会为它们产出成功的取消通知。
    - `notify_boundary`（即 caller）不在任何层内，它全程在运行——它正执行本次 `agent_stop` 调用。
      末层 target 的取消通知由 M6 交付给它，无排序要求。
  - 后置：`StopOutcome` 满足其类型不变量；`transitioned` 中每个成员的取消通知在返回前已持久化。
    "停止后仍可经 `agent_send` 恢复"由副作用论证第 (2) 条给出。
  - 副作用论证：(1) 经 M6 中断子树中原本在跑的成员的执行 —— 步骤 3a；(2) 不删除任何 Session、消息或
    历史，故被停成员的 Session 与历史完整存续，`deliver` 对其仍可投递并经 M6 的注册分支新起执行；
    (3) **本函数自身不写入任何消息** —— 取消通知由 M6 产出并写入各成员的父 Session。

### 5.5 M6 AgentExecution

本模块是本 feature **唯一**的执行注册者与结局通知生产者（架构 I5）。它承接清单第 5 节整块缺失的
结果判定，以及第 6.6 条的 watcher 归属。

#### 5.5.1 `ensure(target: SessionID) -> Effect<void, AgentNotFound>`

- **功能描述**：确保目标存在一次在跑的执行；已有则不动，没有则注册一次执行与恰一个 watcher。
- **调用关系**：callers: M3 `deliver`；callees: `BackgroundJob.get`、`BackgroundJob.start`、
  M6 `runExecution`、M6 `watch`。
- **实现思路**：
  1. `Session.get(target)` 取标题、agent 名与工作目录，供步骤 3 的 job 元数据用。
     失败 → `AgentNotFound{target}`，无副作用。这是本函数 `AgentNotFound` 失败通道的唯一来源。
  1.1 工作目录复原：目标的目录不存在时，查 project 的 sandbox 列表判定归属——
     - **在列表中**（本 feature 自建）→ `Worktree.create()` 重建，更新 Session 记录的目录与权限规则。
       安全性：本设计只在**无改动**时移除工作树（`watch` 步骤 4.2），故重建等价、不丢任何东西。
     - **不在列表中**（调用方经 `cwd` 指定）→ 不重建，原样让后续工具报错。那是调用方给的路径，
       替它造一个空目录会掩盖问题。
  2. `BackgroundJob.get(target)`。job id 即 SessionID（清单 §4.2 保留的身份约定）。
  3. 分支：存在且 `status === "running"` → **空操作直接返回**。既有 watcher 继续持有唯一交付权，
     本次消息进入该执行的消息序列（架构 I4）。
  4. 否则（无 job，或 job 已 settled）→ 先为本次执行建一个 `Deferred<void>` 存入
     `noticeDelivered: Map<SessionID, Deferred<void>>`（供 `cancelAndAwaitNotice` 等待），
     再 `BackgroundJob.start({ id: target, type: "agent", title, metadata, run: runExecution(target) })`。
     - callee 契约：`start` 在同 id 已有 running job 时返回既有 info 而不新起（既有语义），故与步骤 3
       双重保险，不会并行注册。
     - Deferred 必须在 `start` 之前建：执行可能瞬间结算，`watch` 会立刻去完成它。
  5. 注册 watcher：`watch(target)`，fork 不等待。
  6. 返回。
- **正确性论证**：
  - 前置：目标 Session 存在，且其待处理消息已落库（M3→M6 接口协议的调用方责任）。
  - 论证：步骤 3 与步骤 4 的 `start` 语义构成两道去重，任一生效都保证同一时刻同一 target 只有一个
    running job，因此只有一个 watcher —— I4 由此保持。步骤 5 在步骤 4 之后且只在非空操作分支执行，
    故不会为已有执行重复注册 watcher。
  - 后置：返回后目标必有一次在跑的执行，其 watcher 恰一个，且该次执行的 `noticeDelivered` 已就位。
  - 副作用论证：(1) 可能注册一次后台执行、一个 watcher 与一个 Deferred —— 步骤 4、5；
    (2) 不写消息、不改 Session 字段。

#### 5.5.2 `runExecution(target: SessionID) -> Effect<string, ExecutionFailure>`

- **功能描述**：驱动目标 Session 的 loop，按六条分支判定结局，并把结局**映射到 Effect 的三种出口**，
  使后台执行的结算状态自然带上分类。
- **调用关系**：callers: M6 `ensure`（作为 job 的 run 体）；callees: `SessionPrompt.loop`、
  既有渲染函数 `formatAssistantFailure` / `formatSubagentFailure` / `formatIncompleteResponse`、
  `hasUsableOutput`、`lastVisibleText`、`Truncate.limits`。
- **为什么返回值不是 `ExecutionOutcome`**：后台执行的状态由 run 体的 Effect **exit** 推出——成功记
  `completed`、失败记 `error`、中断记 `cancelled`。若把结局作为成功值返回，job 将永远结算为
  `completed`，`watch` 看不到失败与取消，`cancelAndAwaitNotice` 也永远等不到取消结算。既有执行体正是
  用 `succeed` / `fail` / `interrupt` 三种出口承载分类，本函数照此复制。
- **实现思路**：
  1. `loop({ sessionID: target })`，得 `result`。
     - callee 契约：经 `ensureRunning` —— Running 时加入既有执行，Idle 时新起。本函数是 job 的 run 体，
       调用时目标必为 Idle（`ensure` 步骤 2 已排除 running），故走新起分支。
  2. 按序判定，先命中者胜，各自映射到指定出口（清单 §5，逐条复制不简化）：

     | # | 条件 | Effect 出口 | job 结算 | `watch` 读到 |
     |---|---|---|---|---|
     | a | `result.info.role !== "assistant"` | `fail(协议异常文本)` | `error` | `info.error` |
     | b | `error.name === "MessageAbortedError"` | `Effect.interrupt` | `cancelled` | 无正文，由 `renderTermination` 现产 |
     | c | `error` 存在，或 `finish === "length"` | `fail(formatAssistantFailure(...))` | `error` | `info.error` |
     | d | 最后一个 tool part 状态为 error | `fail(formatSubagentFailure(...))` | `error` | `info.error` |
     | e | `finish` 缺失或 `"unknown"`，且 `!hasUsableOutput` | `fail(formatIncompleteResponse(...))` | `error` | `info.error` |
     | f | 以上皆否 | `succeed(lastVisibleText(result))` | `completed` | `info.output` |

     f 取**最后一条** text part，不是 `allVisibleText` 的全部拼接；后者只用于失败时的摘录。
  3. 各失败渲染的截断上界统一取 `Truncate.limits()`。
- **正确性论证**：
  - 前置：目标 Session 存在且当前无在跑执行。
  - 论证：
    - 六条按序求值且 f 是无条件兜底，分支穷尽，不存在落空的执行。
    - **b 必须在 c 之前**：`MessageAbortedError` 本身也是一种 `error`，顺序颠倒会把取消误报为失败，
      且 job 会结算成 `error` 而非 `cancelled`，`cancelAndAwaitNotice` 随之失效。
    - **d 在 e 之前**：工具失败时 `finish` 可能同时缺失；工具错误的信息量更大，先命中更有用。
    - 三种出口与 `BackgroundJob` 的结算规则一一对应（成功→completed、失败→error、
      中断→cancelled），故 `watch` 能仅凭 job 状态区分三类结局，无需第二个信息通道。
  - 后置：Effect 出口与 job 结算状态一致；成功时正文为最后一条可见文本，失败时为对应渲染，
    取消时无正文。
  - 副作用论证：`loop` 会驱动目标 Session 产生 assistant 消息与工具调用——这是执行本身，非本函数
    额外引入；本函数不写入任何消息。

#### 5.5.3 `watch(target: SessionID) -> Effect<void>`

- **功能描述**：等待目标的执行结算，把结局交付给**目标 Session 的父**。
- **调用关系**：callers: M6 `ensure`；callees: `BackgroundJob.wait`、`Session.get`、`SessionPrompt.prompt`。
- **实现思路**：
  1. `BackgroundJob.wait({ id: target })`，阻塞至结算。
  2. `Session.get(target)` 取 `parentID`。
     - **分支：无 `parentID`**（目标是主 Agent）→ 不交付，直接返回。人在 UI 上直接看到结果。
  3. 按 job 结算状态取正文：`completed` / `error` 用 `runExecution` 已产出的 `ExecutionOutcome.text`；
     `cancelled` 用 `renderTermination(target, limits)`。
  4. 以**父 Session 自身的身份**投递一条 synthetic 消息：
     `prompt({ sessionID: parentID, agent: parent.agent ?? ctx.agent, variant, parts: [{ type: "text",
     synthetic: true, text: renderOutput({ sessionID: target, state, summary, text }) }] })`。
     - 照既有 `inject` 的写法（清单 §6.2 标为保留）：它已经在用目标自己的 agent，正是所需。
     - **投递目标是 `target.parentID`，不是调用者**（清单 §6.3）：`agent_send` 可由兄弟发起，
       两者不同。既有代码恒用 `ctx.sessionID` 是因为旧路径下调用者恒等于父。
  4.1 送达确定性依赖 fork issue #32：当前 `prompt` 的唤醒在"判定—转 idle"窗口内可能空转，
      投递的消息会等到下一次外部触发才被消费。本设计不复刻投递保证，引用该修复。
  4.2 工作树清理：目标的目录在 project 的 sandbox 列表中（本 feature 自建），且 `Git` 报告其
      无改动、无未跟踪文件、无未推送提交 → `Worktree.remove({ directory })`（其内部 `removeSandbox`），
      并清空 Session 记录的目录。有改动则**保留**，等人处理（对齐 Claude Code 的 auto-cleaned
      if unchanged）。清理失败只记日志，不影响结局交付。
      - 取消路径同此规则：取消通常留下部分改动，落入「有改动」而被保留。
      - 与 Claude Code 的差别在恢复而非清理：CC 的工作树消失时清除绑定、降级为无隔离；本方案由
        `ensure` 步骤 1.1 重建。理由见该步骤——我们只删过无改动的树。
  5. 完成 `noticeDelivered.get(target)` 这个 Deferred，表示本次执行的结局通知已持久化，随后移除该表项。
     - 步骤 2 的无父分支同样要完成它——那种情况下没有通知可发，但等待方仍须被释放，否则
       `cancelAndAwaitNotice` 会永久阻塞。
  6. 返回。
- **正确性论证**：
  - 前置：目标已注册执行。
  - 论证：步骤 1 的 `wait` ensures 是"job 结算后返回其 info"，故步骤 3 拿到的状态是终态。
    步骤 2 的无父分支覆盖主 Agent，避免向不存在的 Session 投递。步骤 4 复用既有 envelope，
    使完成、失败、取消三种结局在父的 transcript 里形状一致（架构 §6"终止通知复用完成/失败通道"）。
    步骤 5 是 I1 得以成立的基础：没有它，`cancelAndAwaitNotice` 无从判断通知是否落库。
  - 后置：父 Session 恰多一条结局消息；该消息已持久化。
  - 副作用论证：(1) 父 Session 多一条 synthetic 消息 —— 步骤 4；(2) 该投递可能唤醒父的执行，
    这是期望行为（结局应被父处理）；(3) 目标无父时无任何副作用。

#### 5.5.4 `cancelAndAwaitNotice(target: SessionID) -> Effect<{ transitioned: boolean }>`

- **功能描述**：取消目标的当前执行并等待其取消通知落库；目标本无执行则不动。
- **调用关系**：callers: M4 `stop`；callees: `BackgroundJob.get`、`SessionRunState.cancel`。
- **实现思路**：
  1. `BackgroundJob.get(target)`。
  2. **分支：无 job，或 `status !== "running"`** → 返回 `{ transitioned: false }`。不取消、不通知。
     - 这一步是幂等的来源：`SessionRunState.cancel` 对 idle 目标是成功空操作（清单 §7.4），
       若不先判断就调用，会把"本来就没在跑"误报成"已停止"并触发不实通知。
  3. 否则 → `SessionRunState.cancel(target)`。
     - callee 契约：`Effect<void>`，无失败通道；取消该 Session 的后台 job 与活动执行。
  4. 等待 `noticeDelivered.get(target)`（由 `ensure` 步骤 4 建立、`watch` 步骤 5 完成）。
     该 Deferred 完成即表示本次执行的取消通知已写入目标的父 Session。
     - 目标无父时 `watch` 仍会完成它（见 `watch` 步骤 5 的分支），故不会永久阻塞。
  5. 返回 `{ transitioned: true }`。
- **正确性论证**：
  - 前置：目标 Session 存在。
  - 论证：步骤 2 与步骤 3/4 是互斥二分支，覆盖穷尽。`transitioned: true` 当且仅当走了步骤 3–4，
    而步骤 4 的等待保证返回时通知已落库 —— 这正是 M4→M6 接口协议承诺的、I1 依赖的语义。
    首轮设计缺的就是这一步：那时 `cancel` 返回只意味着执行被中断，通知还在 fork 出去的 watcher 里，
    自底向上的 happens-before 推不出来。
  - 后置：`transitioned` 为 true ⇒ 目标的执行已取消且其取消通知已持久化；为 false ⇒ 无任何副作用。
  - 副作用论证：(1) 仅在 true 分支中断目标执行 —— 步骤 3；(2) 取消通知由 `watch` 写入目标的父，
    本函数不自行写入；(3) false 分支零副作用。

#### 5.5.5 `renderTermination(target: SessionID, limits) -> string`

- **功能描述**：产出取消结局的正文。
- **实现思路**：包含被停 Agent 的 `session_id`、其 agent 名与任务简述、"Session 与历史已保留，
  可用 `agent_send` 恢复"、"文件系统与版本控制状态可能包含部分改动"。经 `Truncate.limits()` 限长，
  与既有失败渲染共用同一上界。
- **正确性论证**：trivial —— 纯文本组装，无分支、无副作用。

### 5.6 M5 AgentTools

**本模块共同约束**：四个工具**都不调用 `ctx.ask`**（架构 §6）。权限规则仍可在工具注册层拒绝某个工具
或某个 `subagent_type`；被派生 Agent 自身的工具调用继续在它自己的 Session 权限下受控，本 feature
不改动该机制。以下各函数不再重复这一条。

#### 5.6.1 `agent(params, ctx) -> Effect<string>`

- **功能描述**：创建子 Agent 并渲染结果。
- **调用关系**：callees: M4 `create`。
- **实现思路**：
  1. 从 `ctx.sessionID` 取 caller，不接受模型提供的调用者身份（架构 §5 接口协议）。
  2. 调 M4 `create({ caller, subagent_type, description, prompt })`。
  3. 分支：成功 → 渲染 `AgentInfo`（含 `session_id`，供后续 `agent_send` / `agent_stop` 寻址；
     工具展示元数据已由 `create` 步骤 10 写入）；
     `DepthLimitReached` → 渲染"已达嵌套上限"；`AgentTypeNotFound` → 渲染"未知 agent 类型"；
     `AgentNotFound` → 渲染"调用者 Session 不存在"。
  4. 返回文本。
- **正确性论证**：非平凡（跨模块调用）。前置：调用发生在某 Session 的工具上下文中。论证：步骤 1 使
  caller 不可伪造；步骤 2 的所有失败在步骤 3 被穷尽映射为文本，无未处理分支；成功路径的副作用完全
  由 `create` 承担，本函数自身不写 Session。后置：返回模型可读文本。副作用：委托给 M4，本函数无。

#### 5.6.2 `agent_list(ctx) -> Effect<string>`

- **功能描述**：渲染调用者的邻居 roster。
- **调用关系**：callees: M1 `neighborhood`、M2 `of`。
- **实现思路**：
  1. `neighborhood(ctx.sessionID)`。失败 → 渲染错误返回。
  2. 对每个成员调用 M2 `of(session_id)` 填 `status`。可并发，无顺序要求
     —— `of` 的功能规约声明只读且结果为即时快照。
  3. 渲染为紧凑表：`session_id` / `relation` / `agent` / `status` / `title` / `directory`。
     `directory` 不可省：各 Agent 可能在不同工作树里，缺了它无法判断谁在哪儿干活。
  4. 边界：`members` 只含自己（主 Agent 且无子）时仍返回该行，不返回空结果——空表会让模型误判为出错。
- **正确性论证**：非平凡（跨模块调用）。论证：步骤 2 对每个成员各调一次 `of`，成员集合有限且来自
  步骤 1 的输出，故遍历必然终止；`of` 无失败通道，故本步无失败分支。后置：每行的 status 是该次调用
  瞬间的快照，不保证行间一致——这是架构 §5 M5→M2 接口协议已声明的。副作用：无。

#### 5.6.3 `agent_send(params, ctx) -> Effect<string>`

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

#### 5.6.4 `agent_stop(params, ctx) -> Effect<string>`

- **功能描述**：停止直接子 Agent 及其后代。
- **调用关系**：callees: M4 `stop`。
- **实现思路**：
  1. caller 取自 `ctx.sessionID`。
  2. 调 M4 `stop(caller, params.session_id)`。
  3. 分支：成功 → 渲染 `StopOutcome` 三段：`transitioned`（本次真正停下的）、`unchanged`
     （调用时本就空闲、未产生通知的）、`failed`（出错的，**必须**逐条列出，架构 §5 M5→M4 协议要求
     显式报告）。三段都要呈现——只报 `transitioned` 会让模型以为 `unchanged` 的成员没被处理；
     `NotAChild` → 渲染"只能停止自己直接派生的 Agent"；`AgentNotFound` → 渲染"目标不存在"。
  4. 返回文本。
- **正确性论证**：非平凡（跨模块调用 + 状态变更）。论证：`stop` 的三种终态在步骤 3 被穷尽覆盖；
  `failed` 非空时的渲染是协议硬要求，不得省略或折叠。后置：返回文本如实反映哪些成员被停止、
  哪些父收到通知、哪些失败。副作用：委托给 M4。

#### 5.6.5 `available(ctx) -> Effect<ToolName[]>`

- **功能描述**：按调用者深度决定向模型暴露哪些工具。
- **调用关系**：callers: 工具注册；callees: M1 `callerDepth`。
- **实现思路**：
  1. M1 `callerDepth(ctx.sessionID)` 得 depth。callee 契约见 §5.1.6：只读，终止性已论证。
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

#### 5.6.6 `task` 兼容入口

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
- [x] 所有退出点（成功 / 失败 / 异常）已刻画 —— §3 定义五个失败类型，每个函数的失败分支均标注
      "无副作用"或说明已产生的副作用
- [x] 所有 callee 调用显式引用其 pre / post —— `Session.children`、`SessionStatus.get`、`prompt(noReply)`、
      `loop`/`ensureRunning`、`SessionRunState.cancel` 的契约均在使用点引述
- [x] 每个模块的函数覆盖该模块在架构 §4 的全部 Ensures 与不变式；M6 的 I4 由 `ensure` 的双重去重
      给出、I5 由 M3/M4 都不自行投递结局给出
- [x] `task-inventory.md` 中标为缺失的 16 条均已落到具体函数：结果判定 6 条 → `runExecution`；
      watcher 归属 2 条 → `ensure` / `watch`；身份继承 3 条 → `create` 步骤 4-5 与 `deliver` 步骤 3；
      标题与权限去重 2 条 → `create` 步骤 6-7；元数据与附件展开 2 条 → `create` 步骤 8、10；
      取消幂等 1 条 → `cancelAndAwaitNotice` 步骤 2
- [x] 每个模块的函数覆盖该模块在架构 §4 的全部 Ensures 与不变式 —— M3 的 I4 在 `deliver` 有独立保持论证；
      M4 的"停止后可恢复"由 `stop` 的副作用论证第 (3) 条给出，"notify_boundary 交付"由 `stop` 步骤 3b
      统一覆盖；M5 的"四个工具都不弹确认"提到模块前言，不逐函数重复
- [x] 所有循环有终止性论证 —— `descendants`（`seen` 单调增长且有上界）、`stop`（层数有限）、
      `callerDepth`（每步上移一层，链无环有限）
- [x] 工作树生命周期的每个分支都有归属与退出刻画 —— 创建失败映射为 `WorktreeUnavailable`；
      环境文件复制失败记日志并继续；清理与重建的归属判定统一走 project 的 sandbox 列表；
      清理由 M6 承担而非 M4（架构 §4.4 已相应移出）
- [x] 所有上游事实显式列出 —— H2（parentID 链无环且深度有限）在 `neighborhood` / `descendants` /
      `callerDepth` / `plan` 的使用点各自标注；I2、I3 在 `deliver` 的论证中显式引用
