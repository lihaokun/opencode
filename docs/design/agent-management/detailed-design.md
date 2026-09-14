# 细化设计 — agent-management

- 状态：细化阶段，**等待确认**。2026-09-14 随架构第三次重写：投递改 fork、停止删审计只发一条、
  名称降弱别名、`task` 工具删除、新增 roster 注入、工具可见性移到工具列表生成期。
- 日期：2026-09-06，末次修订 2026-09-14
- 上游依据：`docs/design/agent-management/architecture.md`（**等待再次确认**，本细化随其一同过闸）
- 代码基线：`dev` @ `a4293ca229`

## 1. 范围

覆盖架构 §4 的五个模块，共 24 个函数（17 个承担模块规约，7 个内部辅助）：

| 模块 | 承担规约的函数 | 内部辅助 | 承接 goal |
|---|---|---|---|
| M1 AgentTree | `neighborhood` / `children` / `descendants` / `isChild` / `resolveTarget` / `callerDepth` | `toSkeleton` | G1 G2 G4 G5 |
| M2 AgentStatusProjection | `of` | — | G1 G2 |
| M3 AgentInbox | `deliver` | `render` | G3 G4 |
| M4 AgentLifecycle | `create` / `plan` / `stop` | `prepareWorkdir` / `checkName` / `startDelegation` / `classify` / `renderTermination` | G4 G5 G6 |
| M5 AgentTools | `agent` / `agent_list` / `agent_send` / `agent_stop` / `visibleTools` / `rosterReminder` | — | G1–G6 |

另含对既有代码的改动（§2.3），含 `task` 工具删除的全部连带消费者。

## 2. 与已有代码的复用点

### 2.1 直接复用，不包装

| 复用项 | 用途 | 引用的契约 |
|---|---|---|
| `Session.get(id)` | M1/M3/M4 取 Session | 失败通道 `NotFound` |
| `Session.children(parentID)` | M1 取直接子 | ensures：返回 parent_id == parentID 的全部 Session |
| `Session.create(input)` | M4 建子 Session | `CreateInput` 含 `parentID` / `title` / `agent` / **`model`** / `metadata` / `permission`（`session.ts:348-357`） |
| `SessionStatus.get(sessionID)` | M2 读执行状态 | ensures：无记录时返回 `{ type: "idle" }` |
| `SessionRunState.cancel(sessionID)` | M4 停止单个 Agent | 既有语义：取消后台 job 并中断活动执行；**对 idle 是成功空操作** |
| `SessionPrompt.prompt(input)` | M3 投递、M4 起初始委托 | **`noReply !== true` 时返回 `loop(...)`，会阻塞到整轮结束**（`prompt.ts:1069-1070`）——M3 必须 fork |
| `BackgroundJob.start` / `wait` | M4 `startDelegation` | job id 由调用方给定，此处即子 SessionID |
| `sessions.updatePart` | M5 `rosterReminder` **落盘**注入 | 既有用法见 `reminders.ts:56`、`:76` |
| `Truncate.limits()` | M4 渲染通知时限长 | 与既有 subagent 错误渲染同一上界 |

### 2.2 需要提取或适配

| 项 | 现状 | 要做的 |
|---|---|---|
| `runTask` / `inject` / `notify` | **是 `TaskTool.execute` 内的闭包**（`task.ts:333` / `:369` / `:398`），不是可调用的 helper | 最小提取为共享内部实现，显式传窄数据。**只提取一份，不复制第二套** |
| 失败渲染四件套 `formatAssistantFailure` / `formatSubagentFailure` / `formatOutputLengthFailure` / `formatIncompleteResponse` 与 `hasUsableOutput` / `lastVisibleText` | 模块内函数 | 随上一条一并提取 |
| 工作树内部入口 | `Worktree.create()` 的 `boot` 是 fork 的，返回时目录为空 | 新增不进 HTTP schema 的内部入口，**返回时已达 ready 契约** |
| `info/exclude` 定位 | `snapshot/index.ts:186-193` 是 Snapshot 私有 | 抽成共享工具或在 M4 内重写那三行；**不得**调 Snapshot 的 `sync`——它会连带重写 Snapshot 自己的 block 列表 |
| `SessionReminders.apply` | 已有两种写法（内存 push / `updatePart` 落盘） | 增加 roster 分支，用**落盘**那种 |

### 2.3 必须修改的既有代码

**A. 深度与权限**

| 位置 | 改动 |
|---|---|
| 深度门兜底 | `?? 1` → `?? 3` |
| `core/src/v1/config/config.ts` | `subagent_depth` 的 schema 说明文字仍写 Defaults to 1 |
| `agent/subagent-permissions.ts` | `canTask` 改查 `agent` 键，且**不再默认追加 `agent` deny**；`todowrite` 不动。**不改则深度 3 完全失效或 agent 定义级 opt-out 静默失效**（架构 §6） |
| `childToolDenies` | 移除对 `agent` 的无条件 deny；保留 `todowrite` 与 `primary_tools`；合并时按三元组去重 |
| config 权限 schema | 同时接受 `task` 与 `agent`；`task` 标注 deprecated 并输出一次迁移 warning；读取时先转旧 `task` 再覆盖显式 `agent`，同 pattern 冲突 `agent` 胜；运行时只判 `agent` |
| `agent/agent.ts:196-211` | **内置受限 Agent 的 allowlist 必须显式 allow 四个管理工具**。`explore` 是 `"*": "deny"`，不加则全被过滤掉。用户自定义 Agent 的显式 deny 不覆盖 |
| `session/tools.ts` `resolve` | **在此处按 `input.session.id` 计算深度并过滤工具**（见 §5.5.5）。`Tool.Context` 此时不存在 |

**B. `task` 工具删除的连带消费者**

运行时（必须改成 `agent`）：

| 位置 | 现状 |
|---|---|
| `tool/registry.ts:268` | `Permission.evaluate("task", item.name, agent.permission).action !== "deny"` —— subagent type 过滤 |
| `session/prompt.ts` | agent part 的权限判断与「call the task tool」模型提示 |
| 内置 Plan Agent 等 | 硬编码的 permission key |

UI（必须改接 `agent`，否则 subagent 显示静默消失）：

| 位置 | 现状 |
|---|---|
| `tui/routes/session/index.tsx:221` | `part.tool === "task"`（foregroundTasks） |
| `tui/routes/session/index.tsx:1511`、`:1522`、`:1767`、`:2648` | subagent 导航、running 展示、display 分支 |
| `tui/routes/session/permission.tsx:286` | `if (permission === "task")` |
| `app/pages/session/timeline/message-timeline.tsx:95` | `part.tool !== "task"` 直接 return |
| `cli/cmd/run/subagent-data.ts:334` | `if (part.tool !== "task") return` |
| `cli/cmd/run/tool.ts:578`、`:1436` | kind 与 name 分支 |
| `cli/cmd/agent.ts:26` | 工具名清单 |

**纯展示层可同时识别历史 `task` part**，保证旧 transcript 可读；这不恢复执行能力。
**禁止全局盲替换**：历史展示、普通英文 "task" 含义、legacy 配置入口要逐项分类。
前台转后台相关 UI 随前台模式一并删除。

**C. 其余**

| 位置 | 改动 |
|---|---|
| `task.ts` 前台分支 / `onPromote` / `waitForPromotion` / `background.promote` / `background.extend` / 三段 background 常量 | 随前台与 extend 废弃一并清理 |
| `worktree/index.ts` | 新增 Agent 专用内部入口；**不给公开 `CreateInput` 加 `root`**——它就是 experimental HTTP 的 payload（`groups/experimental.ts:190`） |
| `tui/routes/session/index.tsx:208-213`、`:229-235` | 权限/question 聚合改为整棵后代，回复按 `request.sessionID` 路由（见 §5.5.6） |

**不需要的改动**：`session/session.ts` 的 `remove` 不联动删除工作目录（V1 不自动清理）。

## 3. 错误处理策略

八个失败类型，均为可预期的调用方错误，不使用异常，不使用 `Effect.orDie`：

```
AgentNotFound       { session_id }
AgentTypeNotFound   { subagent_type }
AgentNameConflict   { name }
NotAChild           { caller, target }
SelfDelivery        { target }
DepthLimitReached   { depth, limit }
TargetNotResolved   { value, matches: SessionID[] }    ← matches 空=未找到，>1=歧义
WorktreeUnavailable { reason, paths?: string[] }       ← paths 给出可能的残留
```

传播规则：

- M1/M2/M3/M4 只产出上述类型，不吞错、不转 `undefined`；
- M5 是唯一把失败渲染为模型可读文本的地方；
- `Session.get` 的 `NotFound` 统一映射为 `AgentNotFound`；
- M4 `stop` 内单个成员失败**不中断整体**，记入 `StopOutcome.failed`；
- `AgentNameConflict` 零副作用；
  **`WorktreeUnavailable` 只保证不建 Session / 不投 prompt / 不启动 Agent，允许文件系统残留**。

## 4. 数据结构定义

本细化不引入新的跨模块类型。架构 §3 已定义 `AgentStatus` / `AgentSkeleton` / `AgentInfo` /
`WorkdirSource` / `AgentNeighborhood` / `TargetRef` / `AgentMessage` / `Accepted` /
`DelegationOutcome` / `StopOutcome` / `StopPlan` / `SubagentRoster`，此处不重复。

**`AgentSkeleton` 是跨模块共享类型**（架构 §3），不是模块私有——它出现在 M1→M5 与 M1→M4 的接口上。

## 5. 模块细化

### 5.1 M1 AgentTree

#### 5.1.1 `neighborhood(caller: SessionID) -> Effect<{ caller, members: AgentSkeleton[] }, AgentNotFound>`

- **功能描述**：解析调用者的父、子、兄弟，附 `relation` 与 `depth`。**不含 status。**
- **调用关系**：callers: M5 `agent_list`、M1 `resolveTarget`；callees: `Session.get`、
  `Session.children`、M1 `callerDepth`。
- **实现思路**：
  1. `Session.get(caller)`。失败 → `AgentNotFound{caller}`，无副作用。得 `self`。
  2. `callerDepth(caller)` 得 `d`。
  3. 判断 `self.parentID`：
     - **有**：`Session.get(self.parentID)` 得 `parent`；`Session.children(self.parentID)` 过滤掉
       `id == caller` 者即 siblings。
       - 依赖事实：父被删除时子会一并删除（既有 `Session.remove` 递归删子），故此处不会 `NotFound`；
         若仍失败视为存储不一致，映射 `AgentNotFound{self.parentID}`。
     - **无**：`parent = undefined`，`siblings = []`。
  4. `Session.children(caller)` 得 children。
  5. 组装 members：self（relation=self, depth=d）+ parent（parent, d−1，若有）
     + children（child, d+1）+ siblings（sibling, d）。每项经 §5.1.7 `toSkeleton` 转换。
  6. 按 **`(relation, time_created, session_id)`** 升序，relation 序取 `self < parent < child < sibling`。
     - 三元组而非二元组：`time_created` 是毫秒，同批派生的兄弟会并列；无稳定第三键会让 roster
       每次渲染换行序，模型据此误判"新开了一个 Agent"。
  7. 返回 `{ caller, members }`。
- **正确性论证**：
  - 前置：`caller` 对应的 Session 存在（M5 保证；本函数仍做防御性检查）。
  - 论证：步骤 1 建立 self 存在 → "恰有一个成员 relation == self" 由步骤 5 无条件加入 self 满足。
    步骤 3/4 的三个集合按架构 §3 的邻居定义逐条构造，三者两两不交（成环被 H2 排除），
    故每个成员的 relation 唯一。步骤 6 的排序键三元组全序且末键唯一，输出**严格稳定**。
    不含祖父、孙、叔伯、侄。
  - 后置：满足 `AgentNeighborhood` 全部类型不变量；**status 由 M5 补齐**。
  - 副作用论证：三个 callee 的功能规约均声明只读。

#### 5.1.2 `children(id: SessionID, depth: NonNegativeInt) -> Effect<AgentSkeleton[], AgentNotFound>`

- **功能描述**：取 `id` 的直接子。`depth` 由调用方给出（父深度 +1），本函数不自行推算。
- **实现思路**：`Session.children(id)` 逐项经 `toSkeleton(session, "child", depth)` 转换。
  `Session.children` 对不存在的 id 返回空数组而非失败，故本函数无失败分支；
  `AgentNotFound` 保留在签名中仅为与 M1 其余函数一致。
- **正确性论证**：trivial —— 单次 callee 调用加逐项纯转换。

#### 5.1.3 `descendants(id: SessionID, baseDepth: NonNegativeInt) -> Effect<AgentSkeleton[], AgentNotFound>`

- **功能描述**：取 `id` 的后代闭包，不含 `id` 自身，供 M4 `plan` 分层。
- **实现思路**：
  1. `frontier = [id]`，`acc = []`，`seen = {id}`，`level = baseDepth`。
  2. `frontier` 非空时：`level += 1`，对每个元素调 `children(m, level)`，把 `session_id ∉ seen` 的
     加入 `acc` 与 `seen`，构成 `next`；`frontier = next`。
     - 同一轮取出的成员深度相同，故该轮所有子的 depth 均为 `level`。
     - `seen` 去重是防御性的：H2 已排除环，它只保证存储异常时也必然终止。
  3. `frontier` 为空 → 返回 `acc`。
  - **终止性**：每轮加入 `acc` 的成员都新入 `seen` 且永不移除，`seen` 单调增长且有上界（Session 有限）。
  - **循环不变量**：`acc == seen \ {id}`；每个成员都是 `id` 的后代；`depth == baseDepth + 到 id 的边数`。
- **正确性论证**：不变量初始成立（acc 空、seen 只含 id）；每轮加入的恰是 parent_id 指向 frontier
  成员的 Session，由归纳它们都是 `id` 的后代 → 保持。退出时 frontier 空 ⇒ 无未展开后代 ⇒ 闭包。
  副作用：只经 `children` 读取。

#### 5.1.4 `isChild(caller, target) -> Effect<boolean, AgentNotFound>`

- **实现思路**：`Session.get(target)`，失败映射 `AgentNotFound{target}`；返回 `target.parentID === caller`。
- **正确性论证**：trivial —— `parentID` 创建时绑定且不变（H2），该比较等价于
  "target ∈ children(caller)"，无需再拉子列表。

#### 5.1.5 `resolveTarget(caller, value, scope: "neighbor" | "child") -> Effect<SessionID, TargetNotResolved | AgentNotFound>`

- **功能描述**：把 `target` 解析为 SessionID：以 `ses` 开头则直用，否则按**实例名**在指定集合内查找。
- **实现思路**：
  1. `value` 以 SessionID 前缀 `ses` 开头 → 直接返回，**不做名称查找**。实例名禁止以该前缀开头
     （§5.4.3 校验），故二者可判定地区分。
     - 本分支不校验存在性也不校验集合归属：`agent_send` 本就允许对任意存在的 Session 直投，
       存在性由 M3 校验；`agent_stop` 的直接子约束由 M4 `plan` 的 `isChild` 校验。
       名称解析不改变任一工具原有的寻址范围。
  2. 否则 `neighborhood(caller)`，取候选并**排除调用者自身**：
     - `scope === "neighbor"` → `members` 中 `relation !== "self"` 者。
       必须排除：不排除则调用者用自己的实例名会解析到自己，随后被 `deliver` 以 `SelfDelivery` 拒绝
       ——报错正确但归因错误，读起来像是名称查错了。
     - `scope === "child"` → `members` 中 `relation === "child"` 者。
       复用同一次 `neighborhood` 而非另调 `children`：后者要调用方给 depth，本函数没有那个信息。
  3. 过滤 `skeleton.name === value` 者（**只匹配 `name`，不匹配 `agent_type`**）：
     - 恰一个 → 返回其 session_id
     - 零个   → `TargetNotResolved{ value, matches: [] }`
     - **多个 → `TargetNotResolved{ value, matches: [全部候选的 session_id] }`。
       不发送、不停止、不择一、不广播。**
- **正确性论证**：
  - 前置：`caller` 对应的 Session 存在。
  - 论证：步骤 1 与 2-3 互斥且穷尽。步骤 3 的三分支覆盖候选集合的所有基数。
    **多匹配是正常可达分支**（名称是弱别名，允许并发重名，架构 §6），不表示存储损坏；
    此时拒绝并带回候选是唯一安全的行为——静默择一会把消息发给错的 Agent 且无人知晓。
    名称解析只在调用者自己的可寻址集合内进行，故不扩大任何工具的寻址范围。
  - 后置：返回的 SessionID 要么由调用方直接给出，要么来自调用者的可寻址集合。
  - 副作用论证：只经 `neighborhood` 读取。

#### 5.1.6 `callerDepth(id) -> Effect<NonNegativeInt, AgentNotFound>`

- **功能描述**：沿 `parentID` 向上计数，主 Agent 为 0。
- **调用关系**：callers: M1 `neighborhood`、M4 `create`、M4 `plan`、M5 `visibleTools`；
  callees: `Session.get`。
- **归属说明**：父子链遍历与 M1 其余函数同源。放在 M5 会形成 M5→M4/M1 与 M4/M1→M5 的反向依赖。
- **实现思路**：`depth = 0`；`current.parentID` 非空时 `depth += 1` 并上移；为空时返回 `depth`。
  与既有深度计算口径一致，实现时共用同一函数避免漂移。
  - **终止性**：链无环且深度有限（H2），每步严格上移一层。
- **正确性论证**：不变量"depth 等于已上移层数"初始成立，每轮 +1 且上移一层保持；
  退出时 `current` 是根。副作用：只读。
  - **注意**：不再返回树根——名称唯一性检查已删除（架构 §6），无人需要它。

#### 5.1.7 `toSkeleton(session, relation, depth) -> AgentSkeleton`

- **字段来源**：
  - `name` ← `session.metadata?.agentName`（可空）
  - `agent_type` ← `session.agent`（可空——该字段本身 optional）
  - `workdir` ← `session.metadata?.agentWorkdir`（可空。**不写 `Session.Info.directory`**：
    那是真实的 instance 执行目录，冒充它会让别处误以为运行时 cwd 已切换）
  - 其余同名映射
- **正确性论证**：trivial —— 纯字段映射，无分支。**不含 status。**

### 5.2 M2 AgentStatusProjection

#### 5.2.1 `of(sessionID) -> Effect<AgentStatus>`

- **调用关系**：callers: M5 `agent_list`、M5 `rosterReminder`；callees: `SessionStatus.get`。
  **不再被 M4 `stop` 调用**——停止不预读状态（架构 §4.4）。
- **实现思路**：`SessionStatus.get(sessionID)`（无记录时返回 `{type:"idle"}`，故无失败分支）；
  `busy` 或 `retry` → `running`；`idle` → `idle`。该联合恰为三支
  （`packages/schema/src/session-status-event.ts`），分支穷尽，无 default。
- **正确性论证**：`retry` 是退避重试、活动执行未结束，与 `busy` 同归 `running`。
  三支穷尽 ⇒ 返回值必为二值之一。
  **不读 `BackgroundJob`**：经 `agent_send` 恢复的 Agent 可能正在运行却没有新 job。
  副作用：只读。

### 5.3 M3 AgentInbox

#### 5.3.1 `render(message: AgentMessage) -> string`

- **实现思路**：按架构 §3 的固定格式：

  ```
  [Agent message from <name> (<agent_type>, <sender>)]
  To reply, use agent_send(target="<sender>", message="<your reply>").

  <body>
  ```

  - `name` 缺省时把括号内折叠为 `<agent_type>` 一种形态。
  - **回复说明恒用 `sender` 的 session_id，不用 name**：name 是弱别名，可能重名或不存在；
    session_id 在任何解析范围下都可用且唯一。
  - 各字段由 M5 从调用上下文填入，不取自模型入参，故无伪造路径。
- **正确性论证**：trivial —— 纯拼接，唯一分支是 `name` 是否存在，两支均已刻画。

#### 5.3.2 `deliver(message: AgentMessage) -> Effect<Accepted, AgentNotFound | SelfDelivery>`

- **功能描述**：以目标 Session 自身的身份**fork 进**普通异步消息入口。
- **调用关系**：callers: M5 `agent_send`、M4 `stop`（一条取消通知）；
  callees: `Session.get`、`SessionPrompt.prompt`。
- **实现思路**：
  1. 校验 `sender !== target`，否则 `SelfDelivery{target}`，无副作用。
  2. `Session.get(target)`。失败 → `AgentNotFound{target}`，无副作用。得 `target`。
     **不校验邻居关系，不校验同树**（架构 §6）。
  3. 解析身份三项，全部显式取自目标 Session：
     - `agent = target.agent ?? agents.defaultInfo().name`。省略该参数会让 `createUserMessage`
       落到 `agents.defaultInfo()`（`prompt.ts:637`），与此 fallback 同值，但显式写出以免
       读者误以为"省略即保持"。
     - `model = target.model ?? 该 agent 定义的 model ?? provider 默认模型`。**必须显式传**：
       优先级是 `input.model ?? ag.model ?? currentModel(sessionID)`（`prompt.ts:646`），
       agent 定义的模型排在 Session 当前模型**之前**，省略会经 `setAgentModel`
       （`prompt.ts:672-688`）**改写并持久化**目标的绑定。
     - `variant = target.model?.variant`；**其值为 `"default"` 时不传**。
       `setAgentModel` 存的是 `variant ?? "default"`，原样回传会把"未指定"变成"显式 default"，
       来回一趟即钉死。
  4. **fork 投递**：

     ```
     prompt({ sessionID: target.id, agent, model, variant,
              parts: [{ type: "text", text: render(message) }] })
       .pipe(
         catchCause(记日志 + 发 Session.Event.Error),      ← 必须在 fork 内 catch
         forkIn(scope, { startImmediately: true }),
       )
     ```

     - **必须 fork**：`prompt.ts:1069-1070` 在 `noReply !== true` 时 `return yield* loop(...)`，
       直接 await 会阻塞到目标整轮结束，把单向消息变成 RPC。
     - **不能用 `noReply: true`**：它只落库不跑 loop，idle 的目标永远不会启动。
     - **必须在 fork 内 catch**：否则失败逃逸成 defect。照 HTTP handler 的做法
       （`handlers/session.ts:316-329`）记日志并发 `Session.Event.Error`。
     - **不判断目标 running / idle**：running 时现有 loop 在下一个 provider turn 边界重读历史
       读到它（`prompt.ts:1093` 每轮重读，新 user message 使 `lastAssistantBelongsToLatestTurn`
       为假故退出条件不成立）；idle 时自然起新 run。
  5. 立即返回 `Accepted{ target }`。
- **正确性论证**：
  - 前置：`message` 满足类型不变量中除"目标存在"以外的各项。
  - 论证：步骤 1、2 把"非自投递"与"目标存在"在进入副作用之前验完，失败路径无副作用。
    步骤 3 逐项显式解析，使"agent/model/variant 取自目标"成立；`variant` 的 `"default"` 折叠
    使写回成为恒等写。步骤 4 fork 后步骤 5 立即返回，故本函数**不阻塞**。
  - 后置：返回 `Accepted` ⇒ 投递已被接受并调度。
    **不蕴含**已持久化、已处理、将被处理或已回复（架构 §3 `Accepted`）。
    fork 内失败只发事件，调用方那时已返回，**模型拿不到投递失败反馈**（架构 §10 缺口 5）。
  - 副作用论证：（异步地）目标 Session 多一条 user message；因步骤 3 显式传三项，
    目标的绑定值不变。**不注册 BackgroundJob、不注册 watcher、不产生结局。**

### 5.4 M4 AgentLifecycle

#### 5.4.1 `create(input) -> Effect<CreateResult, DepthLimitReached | AgentTypeNotFound | AgentNameConflict | AgentNotFound | WorktreeUnavailable>`

`input = { caller, name?, subagent_type, description, prompt, cwd?, model, variant }`
—— **全部为窄数据**。`model` / `variant` 由 M5 从 `ctx.messageID` 指向的 assistant 消息读出后传入；
本函数**不接触工具上下文**。

`CreateResult = { session_id, name?, agent_type, title, workdir }` ——
**不含 status**（架构 §6：创建不返回实时状态）。

- **调用关系**：callers: M5 `agent`；callees: M1 `callerDepth`、`Session.get`、`agent.get`、
  M4 `checkName`、M4 `prepareWorkdir`、`deriveSubagentSessionPermission`、`Session.create`、
  `resolvePromptParts`、M4 `startDelegation`。
- **实现思路**：
  1. **`Session.get(caller)` 取回真实父 Session** `parent`。失败 → `AgentNotFound{caller}`。
     - 必须取：后面要用 `parent.permission` 与 `parent.metadata?.agentWorkdir`。
       入参里的 `caller` 只是 SessionID，不能当对象用。
  2. `callerDepth(caller)` 得 `d`；`d >= cfg.subagent_depth`（默认 3）→ `DepthLimitReached{d, limit}`，
     无副作用。工具可见性已在 §5.5.5 撤下本工具，此处是第二道防线（插件或直接入口不经工具列表）。
  3. `name` 存在时 `checkName(caller, name)`（§5.4.3）。失败 → `AgentNameConflict{name}`，**无副作用**。
     - **必须在建工作目录与建 Session 之前**，否则名称冲突会留下孤儿目录。
  4. `agent.get(subagent_type)`。不存在 → `AgentTypeNotFound{subagent_type}`，无副作用。得 `next`。
  5. 解析模型身份，**照既有规则逐条复制**：
     - `resolvedModel = next.model ?? input.model` —— subagent 定义固定模型优先，否则继承调用者当次。
     - `resolvedVariant = next.model ? undefined : input.variant`
       —— **只在 subagent 未固定模型时**才继承 variant。固定了模型再带父的 variant 没有意义。
  6. 计算子 Session 权限：
     `deriveSubagentSessionPermission({ parentSessionPermission: parent.permission ?? [], subagent: next })`，
     再叠加保留的两类 deny（`todowrite`、`experimental.primary_tools`），
     **不再包含对 `agent` 的 deny**；合并时按 `(permission, pattern, action)` 三元组**去重**。
     - 依赖 §2.3 对 `subagent-permissions.ts` 的改动：该函数本身也不再默认追加 `agent` deny。
       **两处都改才有效**——`evaluate` 用 `findLast` 且 session ruleset 排在 agent 定义之后。
  7. `prepareWorkdir({ cwd: input.cwd, parentWorkdir: parent.metadata?.agentWorkdir })`
     得 `{ path, source }`（§5.4.2）。失败 → `WorktreeUnavailable{reason, paths}`。
     - **保证不建 Session、不投 prompt、不启动 Agent；不保证无文件系统残留**（架构 §3）。
     - 步骤 7 先于步骤 8 是有意的：反过来则失败会留下孤儿 Session。
  8. `Session.create({ parentID: caller, title, agent: next.name,
     **model: { id: resolvedModel.modelID, providerID: resolvedModel.providerID,
     variant: resolvedVariant ?? "default" }**, permission,
     metadata: { agentName: name, agentWorkdir: { path, source, enforced: false } } })`。
     - `title = description + " (@" + next.name + " subagent)"`，照既有约定。
     - **创建时就持久化已解析身份**（`CreateInput` 有 `model`，`session.ts:348-357`），
       不等首个异步 prompt 才绑定——否则在绑定之前的任何一次 `agent_send` 都会看到一个无 model
       的 Session 并按 fallback 链改写它。
     - `agentWorkdir` 写 metadata 而**不是** `Session.Info.directory`（架构 §6）。
  9. `resolvePromptParts(prompt)` 得 **`parts[]`**（含展开的 `@file` 附件）；在其**前面**插入一个
     text part 声明工作目录：

     ```
     Git / provided_cwd：
       Your working directory: <path>
       Use absolute paths for all file operations and pass workdir explicitly to shell commands.

     非 Git（空 workspace）：
       Source directory: <instance directory>
       Your workspace: <path>
       The workspace is initially empty.
       Copy only the files you need and use absolute paths for all operations.
     ```

     - **必须保持 parts 形态**：压成字符串会丢附件。初始任务**不经 `AgentMessage`**——
       那个结构的 `body` 是 string，只服务 `agent_send` 与停止通知。
     - 声明是**约定不是强制**：运行时默认 cwd 未切换（`tool/read.ts:236`、`tool/shell.ts:612`）。
  10. `startDelegation({ session: newSession, agent: next.name, model: resolvedModel,
      variant: resolvedVariant, parts, caller })`（§5.4.4）。
      - **无同步失败分支**：`BackgroundJob.start` 注册成功即返回；执行失败由 job 结算并走异步通知
        （架构 §6）。本步不向调用方报告"任务未起"这种错误，因为它不存在。
  11. 返回 `CreateResult`，`workdir` 取步骤 7 的结果。**不查 `SessionStatus`、不填 status。**
- **正确性论证**：
  - 前置：调用者 Session 存在；`model` / `variant` 已由 M5 读出。
  - 论证：
    - 步骤 1–6 的全部失败分支都在 `prepareWorkdir` 与 `Session.create` 之前，故**零副作用**，
      满足 `AgentNameConflict` 的硬要求。
    - 步骤 3 先于 7、8：名称冲突时连工作目录都不建。
    - 步骤 5 逐条复制既有规则；若省略，新 Session 无 model，`createUserMessage` 会一路回退到
      provider 默认模型而非继承调用者。
    - 步骤 8 的持久化使后续任何一次 `agent_send` 读到的都是已解析身份，
      §5.3.2 步骤 3 的 fallback 链因此几乎不会被触发——它只是防御。
    - 步骤 9 保持 parts 形态，使 `@file` 附件随初始任务送达。
    - 步骤 11 不填 status ⇒ 与"status 唯一来自 `SessionStatus`"一致，不存在
      "刚创建就自称 running、而 job 可能尚未开跑"的矛盾。
  - 后置：新建子 Session，工作目录已 ready，初始委托已注册，结局将**至多一次**交付给创建者。
  - 副作用论证：(1) 工作目录（含可能的 `info/exclude` 修改）—— 步骤 7；(2) 新 Session —— 步骤 8；
    (3) 一条 user message 与一个 BackgroundJob —— 步骤 10；(4) 不修改调用者 Session 的任何字段。

#### 5.4.2 `prepareWorkdir({ cwd?, parentWorkdir? }) -> Effect<{ path, source }, WorktreeUnavailable>`

- **实现思路**：
  1. **给了 `cwd`** → 返回 `{ path: cwd, source: "provided_cwd" }`。不创建任何东西，
     **不追加任何权限放行**。
     - 安全理由：`cwd` 由模型提供。为它自动放行 `external_directory` 等于让模型用
       `agent(cwd: <任意目录>)` 开出绕过口。该目录在 instance 之外时，其首次文件操作照常触发
       一次权限询问，由用户裁决。
  2. **未给 `cwd`，且 `ctx.project.vcs === "git"`**：
     a. `destinationRoot = <ctx.directory>/.opencode/worktrees`，`destination = <root>/<slug>`。
        **平铺**（嵌套时父清理会删掉子的工作）；**在项目内**（`containsPath`
        只查 `ctx.directory` 与 `ctx.worktree`、不查 sandbox，放项目外会每次文件访问都弹权限）。
     b. 登记忽略：`git rev-parse --path-format=absolute --git-path info/exclude` 定位，
        读回既有内容，`/.opencode/worktrees` 已在其中则跳过，否则追加后写回。
        - **不调 Snapshot 的 `sync`**：它会连带重写 Snapshot 自己的 block 列表（§2.2）。
        - 必要性：ripgrep 默认尊重 `info/exclude`，不登记则 `glob`/`grep` 会搜出每个工作目录的副本。
     c. `baseDirectory = parentWorkdir?.path ?? ctx.directory`；
        `baseCommit = git -C <baseDirectory> rev-parse HEAD`。失败 → `WorktreeUnavailable`。
        - 显式取 baseCommit 而非依赖隐式 cwd：嵌套派生时创建者自己也在一个工作目录里。
        - 只继承父**已提交到 HEAD** 的内容；未提交修改不会出现。
     d. 调工作树内部入口：`git worktree add -b <branch> <destination> <baseCommit>` 后**等待**
        tracked files checkout 完成。
        - **ready 契约**：既有 `Worktree.create()` 的 `setup` 是 `--no-checkout`、
          populate 在 fork 出去的 `boot` 里（`worktree/index.ts:281-292`），返回时目录是**空的**。
          本入口必须在返回时满足"目录存在且 tracked files 完整可读"。
        - 任一步失败 → `WorktreeUnavailable{reason, paths: [destination, ...]}`，**不启动 Agent**，
          **但允许残留**（b 已写的 `info/exclude`、已建的目录或分支）。paths 交给人工处理。
     e. 返回 `{ path: destination, source: "generated_git_worktree" }`。
  3. **未给 `cwd`，且非 git 项目**：在同一 `destinationRoot` 下建普通空目录，
     **不复制任何项目文件**，返回 `{ path, source: "generated_empty_workspace" }`。
     - 既有 `makeWorktreeInfo` 对非 git 直接返回 `NotGitError`、`list()` 返回 `[]`，
       现有代码完全走不到，故本分支是**净新增**，不复用工作树逻辑。
     - 不登记 `info/exclude`（非 git 没有它）；该目录初始为空，对 ripgrep 可见可接受。
  4. `.worktreeinclude` **首版不做**：该机制在 opencode 中不存在，落地需要 gitignore 语法匹配器
     加逐个 `git check-ignore`。
- **正确性论证**：三分支由 `(cwd 是否给出, 是否 git)` 判定，互斥且穷尽。
  分支 2 的 a–e 顺序满足"位置确定 → 忽略登记 → 基线确定 → checkout ready"；
  步骤 2b 的"已存在则跳过"使其幂等，重复创建不让 `info/exclude` 累积重复行。
  后置：返回的 `path` 存在且（git 分支下）tracked files 完整可读。
  副作用：分支 1 无；分支 2 创建目录、写 `info/exclude`、建 worktree 与分支；分支 3 创建空目录。
  **任何分支都不修改主 checkout 的工作树内容。**

#### 5.4.3 `checkName(caller: SessionID, name: string) -> Effect<void, AgentNameConflict>`

- **功能描述**：**无锁、best-effort** 地检查实例名在当前 Agent 树内是否已被占用。
- **实现思路**：
  1. 校验 `name` 不以 `ses` 开头（否则与 SessionID 形状冲突，`resolveTarget` 步骤 1 会把它当 id 直用）
     → 违反则 `AgentNameConflict{name}`，正文说明是保留前缀。
  2. 从 `caller` 上溯到树根，`descendants(root, 0)` 加 root 自身，收集所有 `name` 非空者。
  3. 命中同名 → `AgentNameConflict{name}`，**不写任何东西**；未命中 → 成功。
- **正确性论证**：
  - **不保证唯一性。**检查与 `Session.create` 之间没有锁也没有占位，两个并发创建可能都通过步骤 3
    并产生同名 Agent。**这是明确允许的结果**（架构 §6：名称是弱别名），不是竞态缺陷。
  - 后果被 `resolveTarget` 的多匹配分支兜住：解析时返回全部候选并拒绝，
    不会把消息发给错的 Agent。代价是那两个 Agent 从此只能用 session_id 寻址，
    且本 feature 不提供改名（架构 §10 缺口 11）。
  - 为什么不加锁：为一个**便利别名**付同步代价不值。强唯一要么要进程内 reservation
    （多进程即失效），要么要数据库唯一约束（schema 迁移）。而失败模式已被安全地兜住。
  - 副作用论证：只读 Session store。

#### 5.4.4 `startDelegation({ session, agent, model, variant, parts, caller }) -> Effect<void>`

- **功能描述**：起初始委托的后台执行，并在结束后向**创建者**至多发起一次结局通知。
  **这是本 feature 中唯一产生自动结局的地方。**
- **调用关系**：callers: M4 `create`；callees: `BackgroundJob.start`、`SessionPrompt.prompt`、
  M4 `classify`、提取后的 `notify` / `inject`。
- **实现思路**：
  1. `BackgroundJob.start({ id: session.id, type, title, metadata, run })` ——
     **job id 即子 SessionID**，保留既有身份约定。
     - 不再有 `onPromote`（前台废弃）、不再有 `background.extend` 分支
       （run 边界而非 turn 边界，且排队期间消息不落库；新设计下后续消息走异步入口，天然是 turn 边界）。
  2. `run = runDelegation.pipe(Effect.onInterrupt(() => ops.cancel(session.id)))`。
  3. `runDelegation`：
     a. `prompt({ sessionID: session.id, agent, model, variant, parts })`，**在此等待**
        —— 这是初始委托，它本来就该跑完；与 §5.3.2 的 fork 不同，两者语义不同。
     b. 结果交给 `classify`（§5.4.5）得 `DelegationOutcome`。
     c. 按架构 §3 的出口映射收敛：`completed` → 成功出口；`failed` → 失败出口；
        `cancelled` → `Effect.interrupt`。
        - **必须映射到三种不同的 Effect 出口**：BackgroundJob 的结算状态由 run 体的 exit 推出，
          统一成功返回一个带 kind 的值会让每个 job 都结算成 `completed`。
  4. 注册 `notify(jobID)`：`background.wait` → `completed` 注入完成、`error` 注入失败、
     **其余（含 `cancelled`）静默**。
     - 投递经提取后的 `inject`，目标是 `caller`。初始委托的调用者**就是**父，故既有的
       "恒向调用者投递"写法正确，无需改成从 parentID 解析。
     - **`inject` 投递时必须重新读取父 Session 当前的 agent / model / variant**，
       不能省略 model，也不能用创建子 Agent 时捕获的旧值——**父可能在子运行期间换过模型**，
       用旧值会把它改回去并落库。这与 §5.3.2 步骤 3 是同一条规则。
     - `cancelled` 保持静默：`agent_stop` 的取消通知由 M4 `stop` 产出（§5.4.7），二者互补；
       补了会重复。若 job 因**非 `agent_stop`** 的原因结算 `cancelled`（例如用户在 TUI 取消了父，
       连带取消了子的 job），则无人通知——此时父自己也已被取消，不存在仍在等待的主体。
  5. 只在 `start` 时注册一次 `notify`。
- **正确性论证**：
  - **单一 watcher、至多一次通知**：`notify` 只在步骤 5 注册一次，`background.wait` 对一个 job
    只结算一次，故初始委托**至多发起一次**结局通知。初始执行期间经 `agent_send` 追加的消息
    进入同一个 loop 的消息序列，由这同一次执行消费，不产生第二个结局。
  - **不保证送达**：`inject` 走 fork 且失败被吞（既有行为），且受 issue #32 影响。
    可保证的是"至多发起一次"，不是"恰好收到一次"（架构 §6）。
  - 后置：初始委托跑完后，创建者**至多**收到一条 completed 或 error 通知。
  - 副作用论证：注册一个 BackgroundJob；执行结束后（异步地）向 `caller` 写入一条通知消息。

#### 5.4.5 `classify(result) -> DelegationOutcome`

- **实现思路**：按架构 §3 的六条判定顺序求值，**照既有 `runTask`（`task.ts:346-366`）逐条复制**：
  1. 不是 assistant 消息 → failed，`"Task prompt returned a non-assistant result"`
  2. `error.name === "MessageAbortedError"` → cancelled
  3. `error` 存在或 `finish === "length"` → failed，`formatAssistantFailure`
     （超长时经 `formatOutputLengthFailure`）
  4. 最后一个 tool part 状态为 error → failed，`formatSubagentFailure`
  5. `finish` 缺失或 `"unknown"` 且 `hasUsableOutput` 为假 → failed，`formatIncompleteResponse`
  6. 以上皆否 → completed，`lastVisibleText(result)`
- **正确性论证**：
  - **第 2 条必须先于第 3 条**：`MessageAbortedError` 本身也是一种 error，顺序颠倒会把取消误报为
    失败，且结算成 error 而非 cancelled，`agent_stop` 的语义随之崩坏。
  - 六条按序求值、先命中者胜；第 6 条是无条件兜底，故覆盖穷尽。
  - 正文取 `lastVisibleText`（**最后一条** text part）而非 `allVisibleText`（全部拼接）——
    后者只用于失败时的摘录。
  - **`text` 允许为空**：`lastVisibleText` 是 `parts.findLast(p => p.type === "text")?.text ?? ""`，
    纯工具调用完成时合法返回空串，此时结果是 `{kind:"completed", text:""}`。
    既然复用既有分类就必须允许它，**不虚构 fallback 文本**——伪造一句"（无输出）"会把
    一个正常结果渲染成像是出了问题。
  - 副作用论证：纯函数。

#### 5.4.6 `plan(caller, target) -> Effect<StopPlan, NotAChild | AgentNotFound>`

- **实现思路**：
  1. M1 `isChild(caller, target)`。为假 → `NotAChild{caller, target}`，无副作用。
  2. `targetDepth = callerDepth(caller) + 1`。
  3. M1 `descendants(target, targetDepth)` 得 `desc`。
  4. 按 `depth` 把 `desc ∪ {target}` 分桶；target 自身 depth 为 `targetDepth`。
  5. 桶按 depth **降序**成 `layers`，`layers[0]` 最深，末层恰为 `[target]`。
     - 边界：`desc` 为空时 `layers == [[target]]`。
  6. `notify_boundary = caller`。步骤 1 已确认 `target.parentID === caller`，
     故它恒为 target 的父，且恒不在 `⋃ layers` 内（H2 排除环）。
  7. 返回 `{ target, layers, notify_boundary }`。
- **正确性论证**：步骤 3 给出后代闭包 ⇒ `⋃ layers = desc ∪ {target}`。
  步骤 5 的降序直接给出层间 depth 严格递减。target 是子树中 depth 最小者，故降序后单独构成末层。
  步骤 6 给出 `notify_boundary ∉ ⋃ layers` ——**这条是"唯一通知接收方恒在停止集外"的依据**，
  也是 §5.4.7 不需要排序论证的原因。副作用：只读。

#### 5.4.7 `stop(caller, target) -> Effect<StopOutcome, NotAChild | AgentNotFound>`

- **功能描述**：自底向上**无条件**取消目标子树；只向 `notify_boundary` 发一条 cancelled 通知。
- **调用关系**：callers: M5 `agent_stop`；callees: M4 `plan`、`SessionRunState.cancel`、
  `Session.get`、M3 `deliver`、M4 `renderTermination`。
  **不调 M2** —— 不预读状态。
- **实现思路**：
  1. `plan(caller, target)`。失败原样上抛，无副作用。
  2. `stopped = []`，`failed = []`。
  3. 对 `layers` 按序遍历，每层并发对每个成员 `m`：
     - `SessionRunState.cancel(m)`。
       - 有 run → 停止；无 run → 由既有 cancel 自然 no-op（`run-state.ts:77-86` 直接
         `status.set(idle)` 返回）。
       - **不预读 `SessionStatus`，不区分两种情形。**理由：cancel 事后分不出；而先读再取消
         **同样测不准**——读到 running 之后、cancel 之前目标可能自行结束。
         与其假装测得准，不如不报告这个维度。
     - 成功 → 记入 `stopped`；抛出未预期异常 → 记入 `failed{session_id, reason}`，
       **不中断本层其余成员，也不中断后续层**。
     - 收齐本层后进入下一层。**这只是发起顺序**，不承担正确性（见论证）。
  4. **发一条通知**：`Session.get(target)` 取回 `Session.Info`，构造
     `deliver({ target: plan.notify_boundary, sender: target,
     sender_name: info.metadata?.agentName, sender_agent: info.agent,
     body: renderTermination(info) })`。
     - **只发这一条**。递归取消的后代不发任何通知。
     - `Session.get` 只在这里调一次，不对每个成员调。
     - `parentID` 缺失（理论上不可能，步骤 1 已确认 target 是 caller 的直接子）→
       按父子关系损坏处理，记入 `failed` 并明确报错，不静默。
     - 投递失败不改判 `stopped`：成员确实被取消了，通知没送到是另一回事
       （且 `Accepted` 本就不保证送达）。
  5. 返回 `{ stopped, failed }`。
- **正确性论证**：
  - 前置：`target` 是 `caller` 的直接子（由步骤 1 保证）。
  - 论证：
    - **不需要排序不变量**。停止集内每个成员的父都在集内——除了 target，它的父是
      `notify_boundary = caller`。由 `StopPlan` 类型不变量，caller ∉ 停止集；
      且它正在执行本次 `agent_stop` 调用，**全程醒着**。
      于是**唯一被通知的对象不可能被这条通知唤醒**，复活路径彻底不存在。
      原 I1（取消通知已持久化 happens-before 父被取消）随之删除：无对象可排序，
      且 `Accepted` 不再蕴含持久化，该排序本就无法建立。
    - **为什么不给每个成员的父都发**：那会让"迟到通知唤醒已取消的父"从极窄调度变成掷硬币——
      投递是 fork 的（§5.3.2），外层不等它就去 cancel 那个父。
      丢掉的信息（父不知道子被停过）由 §5.5.6 的 roster 补上。
    - **幂等**：`cancel` 本身幂等。重复显式 stop 会再发一条操作通知，
      **不为通知去重增加状态**——去重要记"上次发过什么"，而这条通知表达的是"执行了停止操作"，
      重复执行就该重复报告。
    - **自底向上的作用降级**：它不再防复活（没有对象可复活），保留只因为先停深层能减少中间层
      在被停前又派生新成员的机会——是对架构 §10 缺口 1 的缓解，不是消除。
    - 三分支：每个成员必落入 `stopped` 或 `failed`，二者不交且并集为 `⋃ layers`。
    - **终止性**：`layers` 长度有限（等于子树深度跨度）。
  - 后置：`StopOutcome` 满足其类型不变量。**`stopped` 不表示"由 running 转成 cancelled"**。
    "停止后仍可经 `agent_send` 恢复"由副作用论证第 (2) 条给出。
  - 副作用论证：(1) 中断子树中原本在跑的成员的执行；(2) 不删除任何 Session、消息、历史或工作目录，
    故被停成员完整存续、`deliver` 对其仍可投递并起新执行；(3) 向 caller 写入**一条**通知。

#### 5.4.8 `renderTermination(info: Session.Info) -> string`

- **功能描述**：渲染那条 `cancelled` 通知的正文。
- **入参是 `Session.Info`**，不是 `AgentSkeleton` —— §5.4.7 步骤 4 拿到的就是它，
  且本函数只需要 `id` / `parentID` / `metadata.agentName` / `agent` / `title`，
  不需要 status / relation / depth。多转一层没有收益。
- **实现思路**：状态词统一用 `cancelled`（不引入 `stopped`）；正文含被停 Agent 的 `session_id`、
  `name`（若有）、`agent_type`、`title`，并说明它可经 `agent_send` 恢复、
  其后代也已一并停止。长度受 `Truncate.limits()` 约束。
- **正确性论证**：trivial —— 纯拼接。

### 5.5 M5 AgentTools

**本模块共同约束**：`agent` 经
`ctx.ask({ permission: "agent", patterns: [subagent_type], always: ["*"] })` 求值——
**保留调用**，把默认动作由 `ask` 改为 `allow`。`deny` 与显式 `ask` 仍生效，subtype 级规则也仍生效。
删掉调用会连带删掉**唯一**求值 `deny` 的地方。`agent_list` / `agent_send` / `agent_stop`
不新增逐次确认。

#### 5.5.1 `agent(params, ctx) -> Effect<string>`

- **功能描述**：读上下文、过权限门、创建子 Agent 并渲染结果。**上下文读取全在本函数。**
- **实现思路**：
  1. caller 取自 `ctx.sessionID`，不接受模型提供的调用者身份。
  2. `ctx.ask({ permission: "agent", patterns: [params.subagent_type], always: ["*"] })`。
     `deny` → 失败返回，**无副作用**。`bypassAgentCheck` 时跳过（既有内部旁路，不动）。
  3. **读调用者当次的 assistant 消息**：`MessageV2.get({ sessionID: caller, messageID: ctx.messageID })`。
     角色不是 assistant → 失败。
     - 必须读它：`variant` 只存在于消息上，Session 不持有；继承模型也取自这条消息而非 Session
       的当前模型——同一 Session 的不同轮次可能用不同模型。
     - 为什么在 M5 而不在 M4：`ctx` 是工具层的东西。M4 只接收 `{ model, variant }` 窄数据。
  4. 调 M4 `create({ caller, name: params.name, subagent_type, description, prompt,
     cwd: params.cwd, model: { providerID, modelID }, variant })`。
     - **不传 `callerWorkdir`**：M4 自己 `Session.get(caller)` 取 `metadata.agentWorkdir`（§5.4.1 步骤 1）。
  5. 成功 → 写工具元数据：
     `ctx.metadata({ title: description, metadata: { parentSessionId: caller,
     sessionId: result.session_id, **model: 子 Agent 实际解析后的 model** } })`。
     - **记子 Agent 实际解析后的 model，不是父调用消息的继承候选**——subagent 定义可能固定了
       别的模型，记父的会让 TUI 元数据显示错误模型。该值可从 `create` 的结果或新 Session 已持久化的
       `model` 取得（§5.4.1 步骤 8 保证它此时已落库）。
  6. 分支渲染：成功 → "已创建并启动"，含 `session_id` / `name` / 建议工作目录；
     **不报告实时状态**，并提示实时状态查 `agent_list`。
     `DepthLimitReached` → "已达嵌套上限"；`AgentTypeNotFound` → "未知 agent 类型"；
     `AgentNameConflict` → "该名称已被占用或使用了保留前缀，请换一个或省略 name"
     （**不返回既有同名 Agent 的 session_id**）；
     `WorktreeUnavailable` → "工作目录准备失败：<reason>"，**并列出 `paths` 中的残留路径**；
     `AgentNotFound` → "调用者 Session 不存在"。
  7. 返回文本。
- **正确性论证**：步骤 1 使 caller 不可伪造；步骤 2 的权限门先于任何副作用（满足模块不变式）；
  步骤 4 的所有失败在步骤 6 被穷尽映射；成功路径的副作用完全由 `create` 承担。
  **步骤 6 不伪造 status**：`create` 返回时 BackgroundJob 可能尚未开跑，声称 `running` 会与
  `agent_list` 立刻打架。副作用：步骤 5 的展示元数据。

#### 5.5.2 `agent_list(ctx) -> Effect<string>`

- **功能描述**：渲染调用者的邻居 roster。**AgentInfo 在此组装。**
- **实现思路**：
  1. `neighborhood(ctx.sessionID)` 得 `AgentSkeleton[]`。失败 → 渲染错误返回。
  2. 对每个成员调 M2 `of(session_id)` 得 status，与 skeleton 合成完整 `AgentInfo`。可并发。
     - **这一步是架构 §3「装配责任」的落点**：M1 不声称构造了完整 AgentInfo。
  3. 渲染紧凑表：`session_id` / `name` / `agent_type` / `relation` / `status` / `title` / `workdir`。
     - `session_id` 与 `name` **都要显示**：前者是权威地址与歧义时的唯一出路，
       后者是便利形式。只显示其一都会让模型在另一种情形下卡住。
     - `name` 为空时该列留空，提示只能用 session_id 寻址该成员。
     - 同名成员**不做去重也不做标记**——它们本就可能重名（弱别名），
       模型需要看见两行才明白为什么按名字发会被拒。
  4. 边界：`members` 只含自己时仍返回该行，不返回空结果——空表会让模型误判为出错。
- **正确性论证**：成员集合有限且来自步骤 1，遍历必然终止；`of` 无失败通道。
  后置：每行 status 是该次调用瞬间的快照，不保证行间一致（架构 §5 接口已声明）。副作用：无。

#### 5.5.3 `agent_send(params, ctx) -> Effect<string>`

- **实现思路**：
  1. caller 取自 `ctx.sessionID`。
  2. 取 caller 的 `metadata.agentName` 与 `agent` 作为 `sender_name` / `sender_agent`。
  3. `resolveTarget(caller, params.target, "neighbor")`。失败 → 渲染，无副作用：
     - `matches` 为空 → "未找到该名称的 Agent"，附当前邻居清单
     - **`matches` 长度 > 1 → "该名称对应多个 Agent，请改用 session_id"，并列出全部候选 session_id**
  4. 构造 `AgentMessage{ target, sender: caller, sender_name, sender_agent, body: params.message }`。
  5. 调 M3 `deliver`。**不做邻居校验，不做同树校验。**
  6. 分支：`Accepted` → 渲染
     **"已接受。这是单向消息：目标不会自动回复，本调用也不等待它，且不保证消息已被处理。
     若需要回应，等待目标主动 `agent_send` 回来。"**；
     `SelfDelivery` → "不能给自己发消息"；`AgentNotFound` → "目标 Session 不存在"。
  7. 返回文本。
- **正确性论证**：步骤 4 的 `sender` 取自上下文而非入参，故模型无法伪造发送者；
  `deliver` 的三种终态在步骤 6 被穷尽覆盖；失败两支均由 `deliver` 在 fork 之前返回，故失败时无副作用。
  **步骤 6 的措辞是契约的一部分**：不写明单向且不保证处理，模型会把它当阻塞调用，
  然后在下一轮追问"结果呢"。副作用：成功路径下（异步地）目标多一条消息。

#### 5.5.4 `agent_stop(params, ctx) -> Effect<string>`

- **实现思路**：
  1. caller 取自 `ctx.sessionID`。
  2. `resolveTarget(caller, params.target, "child")`。失败 → 同 §5.5.3 的两种渲染。
  3. 调 M4 `stop(caller, 目标)`。
  4. 分支：成功 → 渲染 `StopOutcome` 两段：`stopped`（已对其执行停止操作的）与
     `failed`（出错的，**必须**逐条列出）。
     - 渲染措辞须说明 **`stopped` 表示"已执行停止操作"，不表示它此前一定在运行**——
       否则模型会把一个本就 idle 的成员读成"我刚把它打断了"。
     - 同时说明目标的整棵后代已一并停止，且它们仍可经 `agent_send` 恢复。
     `NotAChild` → "只能停止自己直接派生的 Agent"；`AgentNotFound` → "目标不存在"。
  5. 返回文本。
- **正确性论证**：`stop` 的两种终态在步骤 4 被穷尽覆盖；`failed` 非空时的渲染是协议硬要求。
  **本工具的返回值本身就是给 caller 的主要告知**——那条 cancelled 通知是补充，不是唯一渠道
  （架构 §7 G4 论证）。副作用：委托给 M4。

#### 5.5.5 `visibleTools(session: Session.Info) -> Effect<ToolName[]>`

- **功能描述**：按调用者深度决定向模型暴露哪些 Agent 工具。
- **调用点**：`session/tools.ts` 的 `SessionTools.resolve`，**不是工具执行期**。
- **实现思路**：
  1. M1 `callerDepth(session.id)` 得 depth。
  2. `depth >= cfg.subagent_depth` → `[agent_list, agent_send]`；
     否则 → `[agent, agent_list, agent_send, agent_stop]`。
  3. 判据是深度到限，**不是**当前是否有子 Agent——否则 `agent_stop` 会随派生忽隐忽现。
- **正确性论证**：
  - **入参是 `Session.Info` 而不是 `Tool.Context`**：`SessionTools.resolve` 的入参是
    `{ agent, model, session, processor, bypassAgentCheck, messages, promptOps }`，
    **有 `session`、没有 `Tool.Context`**；后者只在工具真正执行时才存在，
    而模型看到的工具 schema 在那之前就已确定。用执行期 context 计算可见性是阶段错误——
    schema 已经发出去了，改不了了。
  - 到限的 Agent 无法再派生（本函数撤下 `agent`，且 M4 `create` 步骤 2 仍会拒绝），
    故其子集合永久为空 ⇒ `agent_stop` 的寻址集合永久为空 ⇒ 撤下不损失能力。
    `agent_send` 与 `agent_list` 的寻址集合含父与兄弟，与深度无关 ⇒ 保留。
  - **边角**：若 `subagent_depth` 被调低、或某深度 3 的 Session 是在上限更高时建的子，
    它会有子却无 `agent_stop`。此时仍可由更上层停止其祖先（级联覆盖它）。
    不为它加"当前是否有子"的判据——那会让工具忽隐忽现。
  - 副作用论证：只读 Session。

#### 5.5.6 `rosterReminder(messages, session) -> Effect<void>`

- **功能描述**：把当前直接子列表作为**落盘** reminder 注入上下文。变化时发一条。
- **调用点**：既有 `SessionReminders.apply`（由 `runLoop` 在 `prompt.ts:1195` 每轮调用），
  新增一个分支。
- **实现思路**：
  1. `children(session.id, depth)` 得直接子。**为空 → 直接返回，不注入任何内容。**
     绝大多数 subagent 属于这一类，一个字都不加。
  2. 对每个子调 M2 `of` 取 status，渲染成**一行**：

     ```
     <SENTINEL> Your subagents: ses_abc123 (reviewer, idle) · ses_def456 (explore, running)
     ```

     - `<SENTINEL>` 是固定前缀行，供步骤 3 在历史中定位。
     - `name` 缺省时只显示 `(agent_type, status)`。
     - **只列直接子**，不列父与兄弟：后两者与本 Agent 的决策关系不大，`agent_list` 随时可查，
       每轮都带会白占 token。
  3. 在 **`messages`（已由 `filterCompactedEffect` 过滤）** 中倒找最近一条带 `<SENTINEL>` 的
     synthetic text part：
     - 没有找到 → 落盘发一条
     - 找到且文本**相同** → **跳过**（稳态零开销）
     - 找到但文本不同 → 落盘发一条
  4. 落盘用 `sessions.updatePart({ ..., type: "text", text, synthetic: true })`
     然后 push 到最后一条 user message 的 parts（既有写法见 `reminders.ts:56`、`:76`）。
- **正确性论证**：
  - **为什么必须落盘**：非落盘那种（`reminders.ts:28` 的纯内存 push）每轮重建，
    会**改写一条已经发出去的消息**——reminder 挂在最后一条 user message 上，
    同一轮多个 step 里那条消息不变，step 1 发的是 `userMsg + roster_v1`、
    step 2 重建成 `roster_v2`，前缀对不上 ⇒ **从那条 user message 往后的缓存全部失效**，
    包括 step 1 产生的全部 assistant 与 tool 消息。落盘的 part 有稳定 id、内容不再变，
    字节级稳定。落盘之后"只出现一次"即成立：它留在历史里，不需要每轮重复。
  - **压缩不需要特判**：`message-v2.ts:526-582` 的 `filterCompacted` 把边界前的消息重排为
    `[compaction-user, summary, ...retained tail..., continue-user]`，边界前的 roster part
    不再进请求；而步骤 3 判据基于的正是过滤后的视图（`prompt.ts:1093` → `:1195`）。
    于是压缩后"倒找不到" → 自动重发。**首次派生、状态翻转、压缩之后三种情况走同一条规则。**
  - **它补什么**：`agent_stop` 不给递归取消的后代发通知（§5.4.7），父被唤回时靠这里知道子已 idle；
    完成通知若被 issue #32 吞掉，父下一轮也能从这里看出子已 idle——
    **无声挂起因此降级为一轮延迟**。是缓解不是保证。
  - **已知代价**：若某个子在一轮**中途**翻转状态，该 step 会给已发出的 user message 追加 part，
    触发一次缓存失效。只在子真的翻转时发生，不是每轮，**有界**，且那恰是这条信息最值钱的时刻。
  - **幂等性**：重复写一条相同的 roster 是浪费不是错误；步骤 3 的相同判定使稳态下不写。
  - 副作用论证：至多写入一条 synthetic text part。

## 6. 完整性自检 checklist

- [x] 所有函数实现思路推导连续（无跳步）—— 每个非 trivial 函数按编号步骤展开
- [x] 所有 if / else / switch 分支已覆盖 —— `neighborhood` 的有无父、`of` 的三支状态、
      `resolveTarget` 的 id/名称与三种基数（**含多匹配这一正常可达分支**）、
      `prepareWorkdir` 的三分支、`classify` 的六分支、`stop` 的成功/失败、
      `visibleTools` 的到限与否、`rosterReminder` 的无子/未找到/相同/不同四支
- [x] 所有退出点已刻画 —— §3 定义八个失败类型；`AgentNameConflict` 的零副作用在 `create`
      步骤 3 的位置给出；**`WorktreeUnavailable` 明确声明只保证不建 Session/不投 prompt/不启动，
      允许文件系统残留**，不再虚构零副作用
- [x] 所有 callee 调用显式引用其 pre / post —— 特别是三条容易写错的：
      `prompt` 在 `noReply !== true` 时**阻塞到整轮结束**（故 M3 必须 fork）；
      `SessionRunState.cancel` 对 idle 是**成功空操作**（故 stop 不做状态审计）；
      `SessionTools.resolve` 的入参**没有 `Tool.Context`**（故可见性在 resolve 处算）
- [x] 每个模块的函数覆盖该模块在架构 §4 的全部 Ensures 与不变式 ——
      M1 只读且不再维护名称唯一性；
      M3 的 Accepted 强度在 `deliver` 后置条件中**显式声明不蕴含已持久化**；
      M4 的"只发一条通知"在 `stop` 步骤 4 与其正确性论证中给出，
      并论证了为何因此不需要排序不变量；
      M5 的权限门写在模块前言
- [x] 所有循环有终止性论证 —— `descendants`（`seen` 单调增长且有上界）、`stop`（层数有限）、
      `callerDepth`（每步上移一层，链无环有限）
- [x] **不存在"缺失"与"已补齐"并存的状态** —— `task-inventory.md` 每条都有终态处置与落点
- [x] 工作目录的每个分支都有归属与退出刻画 —— 三分支互斥穷尽；git 分支 a–e 的顺序与失败点已列；
      ready 契约是硬要求；**失败允许残留并在错误中给出 paths**；V1 不清理故无清理分支
- [x] 所有上游事实显式列出 —— H2 在 `neighborhood` / `descendants` / `callerDepth` / `plan`
      的使用点各自标注；issue #32 的影响在 `deliver` 的后置条件、`startDelegation` 的通知强度、
      `rosterReminder` 的缓解说明中各标一次；
      **H3 已删除**（名称降为弱别名后不再需要同进程串行创建这一前提）
- [x] 删除的不变量都给了删除理由 —— I1 见 `stop` 正确性论证、I2 见 `deliver` 后置条件、
      I4 见 `checkName` 正确性论证
