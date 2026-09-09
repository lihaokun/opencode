# 细化设计 — agent-management

- 状态：细化阶段，等待确认。2026-09-09 随架构重写而重写：M6 删除，`agent_send` 改走
  `prompt_async`，新增实例名与工作目录准备，`create` 改为只接收窄数据。
- 日期：2026-09-06，末次修订 2026-09-09
- 上游依据：`docs/design/agent-management/architecture.md`（**等待再次确认**，本细化随其一同过闸）
- 代码基线：`dev` @ `a4293ca229`

## 1. 范围

本细化覆盖架构 §4 的**五个模块**，共 24 个函数（17 个承担模块规约，7 个内部辅助）：

| 模块 | 承担规约的函数 | 内部辅助 | 承接 goal |
|---|---|---|---|
| M1 AgentTree | `neighborhood` / `children` / `descendants` / `isChild` / `resolveTarget` / `reserveName` / `callerDepth` | `toSkeleton` | G1 G2 G4 G5 |
| M2 AgentStatusProjection | `of` | — | G1 G2 |
| M3 AgentInbox | `deliver` | `render` | G3 G4 |
| M4 AgentLifecycle | `create` / `plan` / `stop` | `prepareWorkdir` / `startDelegation` / `classify` / `renderTermination` | G4 G5 G6 |
| M5 AgentTools | `agent` / `agent_list` / `agent_send` / `agent_stop` / `available` | `task` 兼容入口 | G1–G6 |

另含对既有代码的九处改动（§2.3）。本细化不改变架构确定的模块划分、接口规约与核心流程。

未启用 §6 v2 子计划流程：本 feature 为首次落地，契约由架构文档一次性确立。
后续对本 feature 的契约变更再按 §2.3 步骤 2 分配 subplan-id，前缀 `agm`。

本细化的覆盖基准是 `docs/design/agent-management/task-inventory.md`。

## 2. 与已有代码的复用点

### 2.1 直接复用，不包装

| 复用项 | 用途 | 引用的契约 |
|---|---|---|
| `Session.children(parentID)` | M1 取直接子 | ensures：返回 parent_id == parentID 的全部 Session |
| `Session.get(id)` | M1/M3/M4 取 Session | 失败通道 `NotFound` |
| `Session.create(input)` | M4 建子 Session | 入参含 `parentID` / `title` / `agent` / `permission` / `metadata` |
| `SessionStatus.get(sessionID)` | M2 读执行状态、M4 `stop` 判定转变 | ensures：无记录时返回 `{ type: "idle" }` |
| `SessionRunState.cancel(sessionID)` | M4 停止单个 Agent | 既有语义：取消后台 job 并中断该 Session 的活动执行。**注意对 idle 目标是成功空操作** |
| `SessionPrompt.prompt(input)` | M3 投递消息、M4 起初始委托 | 与 `prompt_async` 走同一实现 |
| `BackgroundJob.start` / `wait` | M4 `startDelegation` 起初始委托并等待结算 | 既有语义：job id 由调用方给定，此处即子 SessionID |
| 既有 `runTask` 的结果分类与 `formatAssistantFailure` / `formatSubagentFailure` / `formatOutputLengthFailure` / `formatIncompleteResponse` / `hasUsableOutput` / `lastVisibleText` | M4 `classify` | 逐条复制，不简化（清单 §5） |
| 既有 `notify` / `inject` | M4 初始委托结束后向创建者交付一次结局 | 既有语义：`completed` 注入完成、`error` 注入失败、其余静默 |
| `resolvePromptParts(prompt)` | M4 展开 `@file` 引用 | 返回 `parts[]`，**不是字符串** |
| `deriveSubagentSessionPermission` | M4 派生子权限 | **必须修改**，见 §2.3 |
| `Truncate.limits()` | M4 渲染终止通知时限长 | 与既有 subagent 错误渲染共用同一上界 |

### 2.2 需要适配

- **工作树内部入口**：新增一个不进 HTTP schema 的 Agent 专用创建函数（见 §2.3），
  内部复用既有 candidate / setup / populate 逻辑，但**返回时必须已达 ready 契约**。
- **`info/exclude` 写入**：`snapshot/index.ts` 的 `excludes()` / `sync()` 是 Snapshot 私有的。
  M4 需要同样的定位逻辑（`git rev-parse --path-format=absolute --git-path info/exclude`），
  实现时抽成共享工具函数或在 M4 内重写该三行；**不得**调用 Snapshot 的 `sync`——
  它会连带重写 Snapshot 自己的 block 列表。

### 2.3 必须修改的既有代码

逐条依据见 `task-inventory.md`。

| 位置 | 改动 | 清单条目 |
|---|---|---|
| `task.ts` 深度门 | `?? 1` → `?? 3` | 1.3 |
| `core/src/v1/config/config.ts` | `subagent_depth` 的 schema 说明文字仍写 Defaults to 1 | 1.3 |
| `task.ts` `ctx.ask` | **保留调用**，权限 key 用规范化后的 `agent`，兜底动作由 `ask` 改 `allow` | 1.4 |
| `task.ts` `childToolDenies` | 移除对 `agent` 的无条件 deny；保留 `todowrite` 与 `primary_tools`；合并时按三元组去重 | 2.3、2.4 |
| **`agent/subagent-permissions.ts`** | `canTask` 改查 `agent` 键，且**不再默认追加 `agent` deny**；`todowrite` 那条不动。这是独立于 `childToolDenies` 的第二个拒绝点，不改则深度 3 完全失效或 agent 定义级 opt-out 静默失效（架构 §6） | **2.2（由「保留」改「修改」）** |
| **config 权限 schema** | 同时接受 `task` 与 `agent`；`task` 标注 deprecated 并输出一次迁移 warning；读取时先转换 `task` 再覆盖显式 `agent`，同 pattern 冲突时 `agent` 胜；运行时只判 `agent` | 架构 §6 |
| `task.ts` `background` 分支 | 移除参数、实验开关与前台分支 | 1.1、4.4 |
| `task.ts` `onPromote` / `waitForPromotion` / `background.promote` | 前台废弃后成为死代码，一并清理 | 4.5 |
| `task.ts` `background.extend` 分支 | 移除 | 4.1 |
| `task.ts` 三段 background 常量 | 随前台与 extend 一并移除，`agent` 的描述重写 | 8.5 |
| **`worktree/index.ts`** | 新增 Agent 专用内部入口（destinationRoot 由系统固定计算、返回时 tracked files 已 ready）。**不给公开 `CreateInput` 加 `root`**——它就是 experimental HTTP 的 payload（`groups/experimental.ts:190`），加了会让客户端指定任意创建位置 | 架构 §4.4.1 |
| **`tui/src/routes/session/index.tsx`** | `children()`（`:208-213`）只有一层、`permissions()`/`questions()`（`:229-235`）对任何带 `parentID` 的 Session 直接 `return []`。改为根 Agent 聚合**整棵后代**，回复按 `request.sessionID` 路由。**这是深度改动的必要连带项，不是可选项** | 架构 §6 |

**不再需要的改动**（相对上一版）：

- `task.ts` 的 `notify` / `inject` **不必迁移，也不必改投递目标**。`inject` 恒向 `ctx.sessionID`
  投递、`notify` 对 `cancelled` 静默，这两条在新设计下都恰好正确：初始委托的调用者就是父，
  而 `cancelled` 通知改由 M4 `stop` 产出（见 §5.4.6 的单一生产者论证）。清单 6.1/6.3/6.4 相应改判。
- `session/session.ts` 的 `remove` **不必联动删除工作目录**：V1 完全不自动清理（架构 §6）。

## 3. 错误处理策略

**错误模型**：沿用仓库既有的 Effect typed error。本 feature 定义**八个**失败类型，均为可预期的
调用方错误，不使用异常，不使用 `Effect.orDie`。

```
AgentNotFound       { session_id }        目标 Session 不存在
AgentTypeNotFound   { subagent_type }     agent 创建时指定的 agent 定义不存在
AgentNameConflict   { name }              实例名在本树内已被占用
NotAChild           { caller, target }    agent_stop 的目标不是调用者的直接子
SelfDelivery        { target }            agent_send 的目标是发送者自己
DepthLimitReached   { depth, limit }      agent 创建时已达嵌套上限
TargetNotResolved   { value }             目标名称在可寻址集合中无匹配
WorktreeUnavailable { reason }            工作目录准备失败
```

**跨模块传播规则**：

- M1/M2/M3/M4 只产出上述类型，不吞错、不转成 `undefined`；
- M5 是唯一把失败转成模型可读文本的地方；
- `Session.get` 的 `NotFound` 在 M1/M3/M4 统一映射为 `AgentNotFound`，不向上暴露 Session 层类型；
- M4 `stop` 内部单个成员取消失败**不中断整体**，记入 `StopOutcome.failed` 继续推进；
- `AgentNameConflict` 与 `WorktreeUnavailable` 的失败路径**必须零副作用**（架构 §3）。

## 4. 数据结构定义

本细化不引入新的跨模块类型。架构 §3 已定义 `AgentStatus` / `AgentInfo` / `WorkdirSource` /
`AgentNeighborhood` / `TargetRef` / `AgentMessage` / `Accepted` / `DelegationOutcome` /
`StopOutcome` / `StopPlan`，此处不重复。

一个**模块私有**类型：

```
AgentSkeleton = Omit<AgentInfo, "status">
```

M1 产出它，M5 补上 status 后成为 `AgentInfo`。理由见架构 §3「装配责任」：status 不属于 M1 的观测域，
M1 不应声称构造了完整的 `AgentInfo`。

新增的八个错误类型见 §3，已同步登记进架构 §3。

## 5. 模块细化

### 5.1 M1 AgentTree

#### 5.1.1 `neighborhood(caller: SessionID) -> Effect<{ caller, members: AgentSkeleton[] }, AgentNotFound>`

- **功能描述**：解析调用者的父、子、兄弟，附 `relation` 与 `depth` 标注。**不含 status。**
- **调用关系**：callers: M5 `agent_list`、M1 `resolveTarget`；callees: `Session.get`、`Session.children`、
  M1 `callerDepth`。
- **实现思路**：
  1. `Session.get(caller)`。失败（`NotFound`）→ `AgentNotFound{caller}`，无副作用。得 `self`。
  2. `callerDepth(caller)` 得 `d`。
  3. 判断 `self.parentID`：
     - **有**：`Session.get(self.parentID)` 得 `parent`；再 `Session.children(self.parentID)` 得同父集合，
       过滤掉 `id == caller` 者即 siblings。
       - 依赖事实：`Session.get(self.parentID)` 不会 `NotFound` —— 子 Session 的 `parentID` 在创建时绑定
         且此后不变（架构 §7 H2），父被删除时子会一并删除（既有 `Session.remove` 递归删子）。
         若仍失败，视为存储不一致，映射 `AgentNotFound{self.parentID}` 返回。
     - **无**（调用者是主 Agent）：`parent = undefined`，`siblings = []`。
  4. `Session.children(caller)` 得 children。
  5. 组装 members：`self`（relation=self, depth=d）+ `parent`（relation=parent, depth=d−1，若有）
     + children（relation=child, depth=d+1）+ siblings（relation=sibling, depth=d）。
     每项经 §5.1.5 `toSkeleton` 转换。
  6. 按 **`(relation, time_created, session_id)`** 升序排序，relation 的序取
     `self < parent < child < sibling`。
     - 三元组而非二元组：`time_created` 是毫秒，同一批派生的兄弟会并列；并列时无稳定第三键
       会让 roster 每次渲染换行序，模型据此推断"新开了一个 Agent"。
  7. 返回 `{ caller, members }`。
- **正确性论证**：
  - 前置：`caller` 对应的 Session 存在（由 M5 在工具入口保证；本函数仍在步骤 1 做防御性检查）。
  - 论证：
    - 步骤 1 建立 `self` 存在 → 类型不变量"恰有一个成员 relation == self"由步骤 5 无条件加入 `self` 满足。
    - 步骤 3/4 的三个集合按架构 §3 `AgentNeighborhood` 的邻居定义逐条构造。三者两两不交
      （parent 的 parent_id ≠ self.parentID 除非成环，H2 排除；child 的 parent_id == caller ≠ self.parentID
      除非自环，同样被 H2 排除），故每个成员的 relation 唯一。
    - 步骤 6 的排序键三元组全序且末键唯一（session_id 全局唯一），故输出**严格稳定**。
    - 集合构造只取上述三类，不含祖父、孙、叔伯、侄，满足"不含任何非邻居成员"。
  - 后置：返回值满足 `AgentNeighborhood` 除 status 外的全部类型不变量；status 由 M5 补齐。
  - 副作用论证：只调用 `Session.get` / `Session.children` / `callerDepth`，三者的功能规约均声明只读。

#### 5.1.2 `children(id: SessionID, depth: NonNegativeInt) -> Effect<AgentSkeleton[], AgentNotFound>`

- **功能描述**：取 `id` 的直接子。`depth` 是子的深度，由调用方给出（父深度 +1），本函数不自行推算。
- **调用关系**：callers: M1 `neighborhood`/`descendants`、M4 `plan`；callees: `Session.children`。
- **实现思路**：调用 `Session.children(id)`，逐项经 `toSkeleton(session, "child", depth)` 转换。
  `Session.children` 的 ensures 是"返回 parent_id == id 的全部 Session"，对不存在的 id 返回空数组而非失败，
  故本函数无失败分支；`AgentNotFound` 保留在签名中仅为与 M1 其余函数一致，实际不产生。
- **正确性论证**：trivial —— 单次 callee 调用加逐项纯转换，无分支、无循环、无副作用。

#### 5.1.3 `descendants(id: SessionID, baseDepth: NonNegativeInt) -> Effect<AgentSkeleton[], AgentNotFound>`

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
  - 论证：不变量在初始时成立（`acc` 空、`seen` 只含 `id`）。每轮把 `frontier` 中各节点的直接子加入，
    依 `children` 的 ensures，这些恰是 parent_id 指向 frontier 成员的 Session；由归纳，frontier 成员
    都是 `id` 的后代，故其子也是 → 不变量保持。退出时 `frontier` 为空，意味着不存在未展开的后代
    → `acc` 是后代闭包。
  - 后置：返回 `id` 的全部后代，不含 `id` 自身。
  - 副作用论证：只经 `children` 读取，无写入。

#### 5.1.4 `isChild(caller: SessionID, target: SessionID) -> Effect<boolean, AgentNotFound>`

- **功能描述**：判定 `target` 是否为 `caller` 的直接子。
- **实现思路**：`Session.get(target)`，失败映射 `AgentNotFound{target}`；成功则返回
  `target.parentID === caller`。
- **正确性论证**：trivial —— 单次读取加一次相等比较；`parentID` 在创建时绑定且不变（H2），故该比较
  等价于"target ∈ children(caller)"，无需再拉子列表。

#### 5.1.5 `toSkeleton(session, relation, depth) -> AgentSkeleton`

- **字段来源**：
  - `name` ← `session.metadata?.agentName`（可空）
  - `agent_type` ← `session.agent`（可空——`Session.Info.agent` 本身是 optional，
    尤其是尚未绑定 agent 的根 Session）
  - `workdir` ← `session.metadata?.agentWorkdir`（可空——`cwd` 与自建目录都写在这里，
    **不写 `Session.Info.directory`**：那是真实的 instance 执行目录，冒充它会让别处误以为
    运行时 cwd 已切换）
  - 其余字段同名映射
- **功能描述**：把 `Session.Info` 转成 `AgentSkeleton`。**不含 status** —— status 不是 M1 的观测域。
- **正确性论证**：trivial —— 纯字段映射，无分支。`depth` 由调用方传入。

#### 5.1.6 `resolveTarget(caller, value, scope: "neighbor" | "child") -> Effect<SessionID, TargetNotResolved | AgentNotFound>`

- **功能描述**：把调用方给的 `target` 解析为 SessionID：以 `ses` 开头则直用，否则按**实例名**在指定
  集合内查找。
- **调用关系**：callers: M5 `agent_send`（scope=neighbor）、M5 `agent_stop`（scope=child）；
  callees: M1 `neighborhood`。
- **实现思路**：
  1. `value` 以 SessionID 前缀 `ses` 开头 → 直接返回，**不做名称查找**。实例名禁止以该前缀开头
     （见 §5.4.1 步骤 3），故二者可判定地区分，无需查表即可分流。
     - 这一分支不校验该 Session 是否存在，也不校验是否在集合内：`agent_send` 本就允许对任意存在的
       Session 直投（架构 §6），存在性由 M3 `deliver` 校验；`agent_stop` 的直接子约束由 M4 `plan`
       的 `isChild` 校验。名称解析不改变任一工具原有的寻址范围。
  2. 否则 `neighborhood(caller)`，取候选集合，**排除调用者自身**：
     - `scope === "neighbor"` → `members` 中 `relation !== "self"` 者。
       必须排除：不排除则调用者用自己的实例名会解析到自己，随后被 `deliver` 以 `SelfDelivery` 拒绝
       ——报错正确但归因错误，读起来像是名称查错了。
     - `scope === "child"` → `members` 中 `relation === "child"` 者。
       复用同一次 `neighborhood` 调用而非另调 `children`：后者需要调用方给出 depth，
       而本函数没有那个信息；邻居集合里的子已带 depth。
  3. 过滤 `skeleton.name === value` 者（**只匹配 `name`，不匹配 `agent_type`**）：
     - 恰一个 → 返回其 session_id
     - 零个   → `TargetNotResolved{value}`，错误正文附候选集合的
       `(session_id, name, agent_type, title)` 四元组，使模型无需再调一次 `agent_list`
       即可改用 session_id
     - **多个 → 唯一性不变量 I4 已损坏 ⇒ 同样返回 `TargetNotResolved{value}`，正文说明名称冲突
       并列出全部候选，要求改用 session_id。绝不择一。**
- **正确性论证**：
  - 前置：`caller` 对应的 Session 存在。
  - 论证：步骤 1 与步骤 2-3 互斥且穷尽（是否以 `ses` 开头）。步骤 3 的三分支覆盖候选集合的所有基数。
    在 I4 成立时"多个"分支不可达；I4 因 H3 不成立而降为 best-effort 时该分支可达，此时拒绝仍是
    正确行为——静默择一才会把消息发给错的 Agent。
    名称解析只在调用者自己的可寻址集合内进行，故不扩大任何工具的寻址范围——这是名称不构成
    第二套身份的依据：它只能指向调用者本来就能指向的东西。
  - 后置：返回的 SessionID 要么由调用方直接给出，要么来自调用者的可寻址集合。
  - 副作用论证：只经 `neighborhood` 读取，无写入。

#### 5.1.7 `reserveName(root: SessionID, name: string) -> Effect<void, AgentNameConflict>`

- **功能描述**：在一棵 Agent 树内占位一个实例名。**这是 I4 的唯一维护点。**
- **调用关系**：callers: M4 `create`；callees: M1 `descendants`（从 `root` 展开整棵树）。
- **实现思路**：
  1. `descendants(root, 0)` 加 `root` 自身，得整棵树的成员；
     收集所有 `name` 非空者，得到 `used: Set<string>`。
     - 规模论证：一棵 Agent 树的成员数受深度上限（3）与每层派生数约束，实际是数十级；
       线性扫描足够，**不需要索引，因而不需要 schema 迁移**。
  2. **在同一同步段内**（步骤 1 的结果落地后到步骤 3 之间不得有 `await` / `yield*` 让出点）
     检查 `name ∈ used ∪ reserved[root]`：
     - 命中 → `AgentNameConflict{name}`，**不写任何东西**
     - 未命中 → 写入内存表 `reserved[root].add(name)`，返回成功
  3. `reserved` 是进程内的 Map，按树根分组。它只在**创建进行中**保护那个窗口：
     Session 一旦建成，`metadata.agentName` 就成为持久事实，步骤 1 的扫描即可看见，
     此时可从 `reserved` 移除（也可不移除，多占位只会误拒重名，而重名本就该拒）。
     进程重启后 `reserved` 为空，靠步骤 1 重扫恢复。
- **正确性论证**：
  - 前置：`root` 对应的 Session 存在。
  - 论证：
    - **I4 保持**：设两次并发创建同名 `n`。依 H3（同一 project 的创建在同一进程内），
      两者的步骤 1–3 在同一 JS 事件循环线程上执行；步骤 2 的检查与写入之间无让出点，
      故这段是原子的。先执行者写入 `reserved`，后执行者在步骤 2 命中 `reserved` 而失败。
      因此至多一个成功。
    - 步骤 1 覆盖已建成的 Session，步骤 2 覆盖创建进行中的窗口，二者并集即"整棵树内已被占用的名称"，
      故不存在遗漏。
    - H3 不成立（多进程写同一 project）时，两个进程各自的 `reserved` 互不可见，
      两者可能都通过步骤 1 与 2 —— 此时 I4 降为 best-effort，见架构 I4 的强度声明。
  - 后置：返回成功 ⇒ 该名称在本进程内已被本次创建占住。
  - 副作用论证：只写进程内 `reserved` 表；失败路径不写。

#### 5.1.8 `callerDepth(id: SessionID) -> Effect<{ depth: NonNegativeInt, root: SessionID }, AgentNotFound>`

- **功能描述**：从 `id` 起沿 `parentID` 向上遍历计数，主 Agent 为 0；**顺带返回树根**，供
  `reserveName` 使用（否则要再上溯一次）。
- **调用关系**：callers: M1 `neighborhood`、M4 `create`、M4 `plan`、M5 `available`；callees: `Session.get`。
- **归属说明**：本函数是父子链遍历，与 M1 其余函数同源。首轮把它放在 M5，而 M1 与 M4 都要调用，
  形成 M5→M4/M1 与 M4/M1→M5 的反向依赖；归入 M1 后调用图恢复单向。
- **实现思路**：
  1. `depth = 0`，`current = Session.get(id)`。失败 → `AgentNotFound{id}`。
  2. 循环：`current.parentID` 非空时，`depth += 1`，`current = Session.get(current.parentID)`。
  3. `parentID` 为空 → 返回 `{ depth, root: current.id }`。
  - **终止性**：`parentID` 链无环且深度有限（H2），每步严格上移一层，必然到达 `parentID == undefined`。
  - 与既有 `task.ts:236-242` 的深度计算口径一致，实现时二者共用同一函数，避免漂移。
- **正确性论证**：非平凡（含循环 + 跨模块调用）。前置：`id` 对应的 Session 存在；链无环（H2）。
  论证：不变量"depth 等于已上移的层数 ∧ current 是 id 的第 depth 层祖先"在初始成立，每轮 +1 且上移
  一层保持；退出时 `current.parentID` 为空即 `current` 是根，故 depth 等于 `id` 到根的边数、
  `current.id` 即树根。后置：主 Agent 返回 `{depth: 0, root: id}`。副作用：只读。

### 5.2 M2 AgentStatusProjection

#### 5.2.1 `of(sessionID: SessionID) -> Effect<AgentStatus>`

- **功能描述**：把进程内执行状态投影为 `running | idle`。
- **调用关系**：callers: M5 `agent_list`、M4 `stop`；callees: `SessionStatus.get`。
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
    **不读 `BackgroundJob`**：经 `agent_send` 恢复的 Agent 可能正在运行却没有新 job（架构 §4.2），
    读 job 会把它误判为 idle，而 `agent_stop` 与 `agent_list` 必须用同一个事实来源。
  - 后置：返回 `running` 当且仅当进程内存在该 Session 的活动执行。
  - 副作用论证：`SessionStatus.get` 的功能规约声明只读。

### 5.3 M3 AgentInbox

#### 5.3.1 `render(message: AgentMessage) -> string`

- **功能描述**：拼装带系统发送者前缀的正文。
- **实现思路**：按架构 §3 `AgentMessage` 的固定格式拼装：

  ```
  [Agent message from <name> (<agent_type>, <sender>)]
  To reply, use agent_send(target="<sender>", message="<your reply>").

  <body>
  ```

  - `name` 缺省时该段省略，前缀退化为 `[Agent message from (<agent_type>, <sender>)]`；
    实现时应把括号内的可读部分整体折叠为 `<name> (<agent_type>)` / `<agent_type>` 两种形态之一。
  - **回复说明恒用 `sender` 的 session_id，不用 name**：session_id 在任何解析范围下都可用，
    而 name 只在接收方的可寻址集合里有效——兄弟发来的消息，接收方确实能按 name 回，
    但父发来的消息若父没有 name 就回不了。统一用 session_id 消除这个不一致。
  - 各字段均由 M5 从调用上下文填入，不取自模型入参，故不存在调用方伪造前缀的路径。
- **正确性论证**：trivial —— 纯字符串拼接，唯一分支是 `name` 是否存在，两支都已刻画。

#### 5.3.2 `deliver(message: AgentMessage) -> Effect<Accepted, AgentNotFound | SelfDelivery>`

- **功能描述**：以目标 Session 自身的身份写入消息，交给普通异步消息入口。
  **这是消息不是调用**：不等待、不回复、不注册任何后续。
- **调用关系**：callers: M5 `agent_send`、M4 `stop`（取消通知）；
  callees: `Session.get`、`SessionPrompt.prompt`。
- **实现思路**：
  1. 校验 `message.sender !== message.target`，否则返回 `SelfDelivery{target}`，无副作用。
  2. `Session.get(message.target)`。失败 → `AgentNotFound{target}`，无副作用。得 `target`。
     此处**不校验**邻居关系，也不校验同树（架构 §6）。
  3. 解析身份三项，全部显式取自目标 Session，逐项给出 fallback：
     - `agent = target.agent ?? agents.defaultInfo().name`。`Session.Info.agent` 可选；为空只可能出现在
       从未绑定过 agent 的主 Session 上。省略该参数会让 `createUserMessage` 落到 `agents.defaultInfo()`
       （`prompt.ts:637`），与此 fallback 同值，但显式写出以免读者误以为"省略即保持"。
     - `model = target.model ?? 该 agent 定义的 model ?? provider 默认模型`。**必须显式传**：
       `createUserMessage` 的优先级是 `input.model ?? ag.model ?? currentModel(sessionID)`
       （`prompt.ts:646`），agent 定义的模型排在 Session 当前模型**之前**，省略会让一条消息
       改写并经 `setAgentModel`（`prompt.ts:672-688`）**持久化**目标的绑定。
     - `variant`：取 `target.model?.variant`；**其值为 `"default"` 时不传**。
       `setAgentModel` 存的是 `variant ?? "default"`，原样回传会把一个"未指定 variant"
       变成"显式指定 default variant"，来回一趟即钉死。
  4. 调用 `prompt({ sessionID: target.id, agent, model, variant,
     parts: [{ type: "text", text: render(message) }] })` ——
     即普通异步消息入口 `POST /session/{id}/prompt_async` 背后的同一实现。
     - **不判断目标是 running 还是 idle**：running 时现有 loop 在下一个 provider turn 边界重读历史
       读到它（`prompt.ts:1093` 每轮重读，新 user message 使 `lastAssistantBelongsToLatestTurn` 为假
       故退出条件不成立）；idle 时自然起新 run。两种状态都不需要本模块介入。
     - 失败分支：`prompt` 的失败通道为 `Image.Error`（附件解码）。本调用只传纯文本 part，不触发该路径；
       仍将其映射为 `AgentNotFound{target}` 兜底，不向上暴露 Image 层类型。
  5. 返回 `Accepted{ target }`。
- **正确性论证**：
  - 前置：`message` 满足 `AgentMessage` 类型不变量中除"目标存在"以外的各项。
  - 论证：
    - 步骤 1、2 把"非自投递"与"目标存在"在进入副作用之前验完，失败路径无副作用。
    - 步骤 3 逐项显式解析，使后置条件"agent / model / variant 取自目标"成立。三项都给了 fallback 链，
      不存在未定义取值；`variant` 的 `"default"` 折叠使写回成为恒等写。
    - 步骤 4 的 `prompt` 在返回前已创建并持久化 user message ⇒ 步骤 5 的 `Accepted` 满足 I2。
  - 后置：返回 `Accepted` ⇒ 消息已落库。
    **不蕴含**目标已处理、将处理或已被唤醒——受 issue #32 的 lost-wake 窗口影响（架构 §10 缺口 5）。
  - 副作用论证：(1) 目标 Session 多一条 user message —— 步骤 4；
    (2) 因步骤 3 显式传三项，目标的 agent/model/variant 绑定值不变（`setAgentModel` 在解析值与当前值
    相同时不写）。无其它共享状态写入。**不注册 BackgroundJob、不注册 watcher、不产生结局。**

### 5.4 M4 AgentLifecycle

#### 5.4.1 `create(input) -> Effect<AgentInfo, DepthLimitReached | AgentTypeNotFound | AgentNameConflict | AgentNotFound | WorktreeUnavailable>`

`input = { caller, name?, subagent_type, description, prompt, cwd?, model, variant, callerWorkdir? }`
—— **全部为窄数据**。`model` 与 `variant` 由 M5 从 `ctx.messageID` 指向的 assistant 消息读出后传入，
`callerWorkdir` 取自调用者 Session 的 `metadata.agentWorkdir`（供 baseCommit 取基线）；
本函数**不接触工具上下文**（架构 §5 接口）。

- **功能描述**：新建一个以调用者为父的子 Agent，准备其工作目录，起初始委托。
- **调用关系**：callers: M5 `agent`；callees: M1 `callerDepth`、M1 `reserveName`、`agent.get`、
  `deriveSubagentSessionPermission`、`Session.create`、`resolvePromptParts`、
  M4 `prepareWorkdir`、M4 `startDelegation`。
- **实现思路**：
  1. `callerDepth(caller)` 得 `{ depth: d, root }`。
  2. `d >= cfg.subagent_depth`（默认 3）→ `DepthLimitReached{d, limit}`，无副作用。工具可见性已在 M5
     撤下本工具，此处是第二道防线：`task` 兼容入口与插件直调不经工具列表。
  3. `name` 存在时：
     - 校验不以 `ses` 开头（否则与 SessionID 形状冲突，`resolveTarget` 的步骤 1 会把它当 id 直用）
       → 违反则 `AgentNameConflict{name}`（复用同一类型，正文说明是保留前缀）
     - `reserveName(root, name)`。失败 → `AgentNameConflict{name}`，**无副作用**
     - **这一步必须在建 Session、建 workspace、投递 prompt 之前**（架构 §3 失败类型的零副作用要求）
  4. `agent.get(subagent_type)`。不存在 → `AgentTypeNotFound{subagent_type}`，无副作用。得 `next`。
  5. 解析模型身份，**照既有规则逐条复制**（清单 §3.2、§3.3），以传入的 `model` / `variant` 为继承源：
     - `resolvedModel = next.model ?? input.model`
       —— subagent 定义固定模型优先，否则继承调用者当次的模型。
     - `resolvedVariant = next.model ? undefined : input.variant`
       —— **只在 subagent 未固定模型时**才继承 variant。固定了模型再带父的 variant 没有意义。
  6. 计算子 Session 权限：
     `deriveSubagentSessionPermission({ parentSessionPermission: caller.permission ?? [], subagent: next })`
     得 `childPermission`；再构造保留的两类 deny（`todowrite`、`experimental.primary_tools`），
     **不再包含对 `agent` 的 deny**（清单 §2.3）。
     - 合并时按 `(permission, pattern, action)` 三元组**去重**：`childPermission` 里已有同样规则的
       不重复追加（清单 §2.4）。
     - 依赖 §2.3 对 `subagent-permissions.ts` 的改动：该函数本身也不再默认追加 `agent` deny。
       两处都改才有效——`evaluate` 用 `findLast` 且 session ruleset 排在 agent 定义之后，
       只改这里而不改那里，session 层的 deny 仍会压过来。
  7. `prepareWorkdir({ cwd, callerWorkdir })` 得 `{ path, source }`，见 §5.4.2。
     失败 → `WorktreeUnavailable{reason}`，**无副作用**（此时尚未建 Session；`reserveName` 的内存占位
     可留可清，留下只会误拒同名重试，而同名重试本就该在名称释放后才成功）。
  8. `Session.create({ parentID: caller, title, agent: next.name, permission,
     metadata: { agentName: name, agentWorkdir: { path, source, enforced: false } } })`。
     - `title = description + " (@" + next.name + " subagent)"`，照既有约定（清单 §2.5）。
     - `agentWorkdir` 写进 metadata 而**不是** `Session.Info.directory`：后者是真实的 instance
       执行目录，冒充它会让别处误以为运行时 cwd 已切换（架构 §6「隔离强度」）。
  9. `resolvePromptParts(prompt)` 展开正文里的 `@file` 引用（清单 §8.2），得到 **`parts[]`**；
     在其**前面**插入一个 text part 声明工作目录：

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

     - **必须保持 parts 形态**：`resolvePromptParts` 的返回值含展开的 `@file` 附件 part，
       压成字符串会把附件丢掉。初始任务**不经 `AgentMessage`**——那个结构的 `body` 是 string，
       只服务 `agent_send`（架构 §3）。
     - 声明是**约定不是强制**：运行时默认 cwd 未切换（`tool/read.ts:236`、`tool/shell.ts:612`），
       子 Agent 仍可用主 checkout 的绝对路径操作。强度边界见架构 §6 与 issue #33。
  10. `startDelegation({ session: newSession, agent: next.name, model: resolvedModel,
      variant: resolvedVariant, parts, caller })`，见 §5.4.3。
      - 失败分支：Session 已创建。**不回滚** —— 空 Session 可由 `agent_send` 继续使用，删除反而丢失
        已分配的 id。失败原样上抛，M5 渲染时说明 Session 已建但任务未起。
  11. 返回 `AgentInfo`：`toSkeleton(newSession, "child", d+1)` 加 `status: "running"`。
      状态直接给 `running`：步骤 10 已起执行，无需再查一次 `SessionStatus`。
- **正确性论证**：
  - 前置：调用者 Session 存在；`model` 与 `variant` 已由 M5 从其当次 assistant 消息读出。
  - 论证：
    - 步骤 1–7 的全部失败分支都在 `Session.create` 之前，故这些失败**零副作用**，
      满足架构 §3 对 `AgentNameConflict` 与 `WorktreeUnavailable` 的硬要求。
    - 步骤 3 先于步骤 7、8：名称冲突时连工作目录都不建，不留下孤儿目录。
    - 步骤 7 先于步骤 8 是**有意的**：反过来则 `WorktreeUnavailable` 会留下一个孤儿 Session，
      违反架构 §3 对该错误零副作用的要求。代价是 `Session.create` 本身失败（未声明的错误通道）
      时会留下一个孤儿工作目录；V1 本就不自动清理，该目录与其它累积目录同等对待（架构 §10 缺口 7）。
    - 步骤 5 逐条复制既有规则，使新 Agent 的模型身份与既有 `task` 一致；若省略，
      新 Session 无 model，`createUserMessage` 会一路回退到 provider 默认模型而非继承调用者。
    - 步骤 6 的去重使权限集合不含重复规则；`deriveSubagentSessionPermission` 的既有语义保证
      子权限不宽于父。
    - 步骤 9 保持 parts 形态，使 `@file` 附件随初始任务一同送达。
    - 步骤 11 的 `depth = d+1` 与 `parentID = caller` 一致，满足 `AgentInfo` 的
      `depth == 0 ⟺ parent_id == undefined`。
  - 后置：返回的 `AgentInfo` 对应一个新建的子 Session；其工作目录已 ready，初始委托已起，
    结局将由 `startDelegation` 交付给创建者一次。
  - 副作用论证：(1) 内存名称占位 —— 步骤 3；(2) 工作目录 —— 步骤 7；(3) 新增一个 Session —— 步骤 8；
    (4) 该 Session 多一条 user message 且一个 BackgroundJob 已注册 —— 步骤 10；
    (5) 不修改调用者 Session 的任何字段。

#### 5.4.2 `prepareWorkdir({ cwd?, callerWorkdir? }) -> Effect<{ path, source }, WorktreeUnavailable>`

- **功能描述**：按架构 §4.4.1 的三分支准备工作目录。
- **调用关系**：callers: M4 `create`；callees: 工作树内部入口、`Git`、`InstanceState.context`。
- **实现思路**：
  1. **给了 `cwd`** → 返回 `{ path: cwd, source: "provided_cwd" }`。
     不创建任何东西，**不追加任何权限放行**。
     - 安全理由：`cwd` 由模型提供。若为它自动放行 `external_directory`，模型可用
       `agent(cwd: <任意目录>)` 给自己开出绕过口。该目录在 instance 之外时，其首次文件操作照常
       触发一次权限询问，由用户裁决——这是有意保留的交互。
  2. **未给 `cwd`，且 `ctx.project.vcs === "git"`**：
     a. `destinationRoot = <ctx.directory>/.opencode/worktrees`，`destination = <root>/<slug>`。
        **平铺**：所有 Agent 的目录互为兄弟，不嵌在创建者的目录里（嵌套时父清理会删掉子的工作）。
        **在项目内**：`containsPath`（`project/instance-context.ts:18-24`）只查 `ctx.directory` 与
        `ctx.worktree`、**不查 sandbox**，放在项目外会让每次文件访问都弹 `external_directory`。
     b. 登记忽略：`git rev-parse --path-format=absolute --git-path info/exclude` 定位，
        读回既有内容，`/.opencode/worktrees` 已在其中则跳过，否则追加后写回。
        - 用 `info/exclude` 而非在目录里写 `.gitignore`：前者仓库本地、从不提交、不出现在
          `git status`（`snapshot/index.ts:186-193` 已有先例），后者是往用户仓库工作树里造文件。
        - **不调用 Snapshot 的 `sync`**：它会连带重写 Snapshot 自己的 block 列表（§2.2）。
        - 必要性：ripgrep 默认尊重 `info/exclude`，不登记则 `glob`/`grep` 会把每个工作目录里的
          副本都搜出来。
     c. `baseDirectory = callerWorkdir?.path ?? ctx.directory`；
        `baseCommit = git -C <baseDirectory> rev-parse HEAD`。失败 → `WorktreeUnavailable`。
        - **显式取 baseCommit 而非依赖 cwd**：嵌套派生时创建者自己也在一个工作目录里，
          隐式的"当前 HEAD"取决于命令在哪儿执行，写死反而清楚。
        - 只继承父**已提交到 HEAD** 的内容；未提交修改不会出现。需要看到未提交修改时，
          父应先提交或显式让子使用同一 `cwd`。
     d. 调工作树内部入口：`git worktree add -b <branch> <destination> <baseCommit>` 后**等待**
        tracked files checkout 完成（`git reset --hard` 或等价的 populate）。
        - **ready 契约**：既有 `Worktree.create()` 的 `setup` 是 `--no-checkout`、真正的 populate 在
          fork 出去的 `boot` 里（`worktree/index.ts:281-292`），返回时目录是**空的**。
          本入口必须在返回时满足"目录存在且 tracked files 完整可读"。
        - 任一步失败 → `WorktreeUnavailable{reason}`，**不启动 Agent**。
     e. 返回 `{ path: destination, source: "generated_git_worktree" }`。
  3. **未给 `cwd`，且非 git 项目**：
     在同一 `destinationRoot` 下建普通空目录，**不复制任何项目文件**，
     返回 `{ path, source: "generated_empty_workspace" }`。
     - 既有 `makeWorktreeInfo` 对非 git 直接返回 `NotGitError`、`list()` 返回 `[]`，
       现有代码完全走不到，故本分支是净新增，不复用工作树逻辑。
     - 不登记 `info/exclude`（非 git 项目没有它）；该目录对 ripgrep 可见是可接受的，
       因为它初始为空。
  4. `.worktreeinclude` **首版不做**（架构 §6）：该机制在 opencode 中不存在，落地需要一个
     gitignore 语法匹配器加逐个 `git check-ignore` 确认。Agent 需要 `.env` 一类文件时，
     按建议式隔离的语义直接从主 checkout 用绝对路径读取。
- **正确性论证**：
  - 前置：instance 上下文可读。
  - 论证：三个分支由 `(cwd 是否给出, 是否 git 项目)` 判定，互斥且穷尽。
    分支 2 的 a–e 顺序满足"目录位置确定 → 忽略登记 → 基线确定 → checkout ready"，
    其中 e 之前的任一失败都在 `create` 建 Session 之前，故整条路径失败时零副作用。
    步骤 2b 的"已存在则跳过"使其幂等，重复创建不会让 `info/exclude` 累积重复行。
  - 后置：返回的 `path` 存在且（git 分支下）tracked files 完整可读；`source` 如实反映来源。
  - 副作用论证：分支 1 无；分支 2 创建目录、写 `info/exclude`、建 git worktree 与分支；
    分支 3 创建空目录。**任何分支都不修改主 checkout 的工作树内容。**

#### 5.4.3 `startDelegation({ session, agent, model, variant, parts, caller }) -> Effect<void>`

- **功能描述**：起初始委托的后台执行，并在结束后向**创建者**交付一次结局。
  **这是本 feature 中唯一产生自动结局的地方。**
- **调用关系**：callers: M4 `create`、`task` 兼容入口；callees: `BackgroundJob.start`、
  `SessionPrompt.prompt`、M4 `classify`、既有 `notify` / `inject`。
- **实现思路**：
  1. `BackgroundJob.start({ id: session.id, type, title, metadata, run })` ——
     **job id 即子 SessionID**，保留既有身份约定（清单 §4.2）。
     - 不再有 `onPromote`：前台模式已废弃（清单 §4.5）。
     - 不再有 `background.extend` 分支（清单 §4.1）：那是 run 边界而非 turn 边界，
       且排队期间消息不落库。新设计下后续消息走 `prompt_async`，天然是 turn 边界。
  2. `run = runDelegation.pipe(Effect.onInterrupt(() => ops.cancel(session.id)))`（清单 §4.3）。
  3. `runDelegation`：
     a. `prompt({ sessionID: session.id, agent, model, variant, parts })`，等待其返回。
     b. 结果交给 `classify`（§5.4.4）得 `DelegationOutcome`。
     c. 按架构 §3 的出口映射收敛：`completed` → 成功出口（正文进 output）；
        `failed` → 失败出口（正文即失败文本）；`cancelled` → `Effect.interrupt`。
        - **必须映射到三种不同的 Effect 出口**，不能统一成功返回一个带 kind 的值：
          BackgroundJob 的结算状态是由 run 体的 Effect exit 推出的，统一成功会让每个 job
          都结算成 `completed`。
  4. 注册 `notify(jobID)`：`background.wait` → `completed` 注入完成、`error` 注入失败、
     **其余（含 `cancelled`）静默**。投递经既有 `inject`，目标是 `caller`。
     - **保持既有 `inject` 恒向调用者投递的写法**：初始委托的调用者就是父，两者一致。
       （上一版设计因为 `agent_send` 也要产生结局才需要改成"从目标的 parentID 解析"，
       现在 `agent_send` 不产生结局，这条改动撤销——清单 6.3 相应改判。）
  5. 只在 `start` 时注册一次 `notify`（清单 §6.5）。
- **正确性论证**：
  - 前置：`session` 已创建；`parts` 已就绪；工作目录已 ready。
  - 论证：
    - **单一结局**：`notify` 只在步骤 5 注册一次，`background.wait` 对一个 job 只结算一次，
      故初始委托至多交付一个结局。初始执行期间经 `agent_send` 追加的消息进入同一个 loop
      的消息序列，由这同一次执行消费，不产生第二个结局。
    - **`cancelled` 不重复通知**：步骤 4 对 `cancelled` 静默，而 `agent_stop` 的取消通知由
      M4 `stop` 产出（§5.4.6）。两者互补而非重叠，故一次 `agent_stop` 只产生一条通知。
      - 若 job 因**非 `agent_stop`** 的原因结算为 `cancelled`（例如用户在 TUI 取消了父 Session，
        连带取消了子的 job），则无人通知——此时父自己也已被取消，不存在仍在等待的主体，
        与架构 I1 的论证同理。
  - 后置：初始委托跑完后，创建者收到恰一条 completed 或 error 通知；被 `agent_stop` 取消时
    收到恰一条 cancelled 通知（来自 `stop`）。
  - 副作用论证：注册一个 BackgroundJob；执行结束后向 `caller` 的 Session 写入一条通知消息。

#### 5.4.4 `classify(result) -> DelegationOutcome`

- **功能描述**：把初始委托的返回结果分类为 completed / failed / cancelled。
  **照既有 `runTask`（`task.ts:346-366`）六个分支逐条复制，不简化。**
- **实现思路**：按架构 §3 `DelegationOutcome` 的六条判定顺序求值：
  1. 返回的不是 assistant 消息 → failed，正文 `"Task prompt returned a non-assistant result"`
  2. `error.name === "MessageAbortedError"` → cancelled
  3. `error` 存在，或 `finish === "length"` → failed，正文 `formatAssistantFailure`
     （输出超长时经 `formatOutputLengthFailure` 带 token 数、部分输出摘录与截断提示）
  4. 最后一个 tool part 状态为 error → failed，正文 `formatSubagentFailure(该 tool 的 error)`
  5. `finish` 缺失或为 `"unknown"`，且 `hasUsableOutput` 为假 → failed，正文 `formatIncompleteResponse`
  6. 以上皆否 → completed，正文 `lastVisibleText(result)`
- **正确性论证**：
  - 论证：**第 2 条必须先于第 3 条求值**——`MessageAbortedError` 本身也是一种 error，
    顺序颠倒会把取消误报为失败，且结算成 error 而非 cancelled，`agent_stop` 的语义随之崩坏。
    六条按序求值、先命中者胜；第 6 条是无条件兜底，故覆盖穷尽，不存在落空的初始委托。
    正文取 `lastVisibleText`（**最后一条** text part）而非 `allVisibleText`（全部拼接）——
    后者只用于失败时的摘录，混用会让正常结果里混进中间思考。
  - 后置：返回值必为三种 kind 之一，且 `text` 非空。
  - 副作用论证：纯函数，只读入参。

#### 5.4.5 `plan(caller: SessionID, target: SessionID) -> Effect<StopPlan, NotAChild | AgentNotFound>`

- **功能描述**：把目标子树按深度分层，产出自底向上的停止计划。
- **调用关系**：callers: M4 `stop`；callees: M1 `isChild`、M1 `callerDepth`、M1 `descendants`。
- **实现思路**：
  1. M1 `isChild(caller, target)`。为假 → `NotAChild{caller, target}`，无副作用。
  2. `targetDepth = callerDepth(caller).depth + 1`（由步骤 1 已确认 target 是 caller 的直接子）。
  3. M1 `descendants(target, targetDepth)` 得后代集合 `desc`，每个成员已带 `depth`。
  4. 按 `depth` 把 `desc ∪ {target}` 分桶。target 自身的 depth 为 `targetDepth`。
  5. 桶按 depth **降序**排列成 `layers`，即 `layers[0]` 为最深层，末层恰为 `[target]`。
     - 边界：`desc` 为空时 `layers == [[target]]`，仍满足"末元素恰为 `[target]`"。
  6. `notify_boundary = caller`。由步骤 1 已确认 `target.parentID === caller`，故该值恒为 target 的父，
     且恒不在 `⋃ layers` 内（caller 不是自己的后代，H2 排除环）。
  7. 返回 `{ target, layers, notify_boundary }`。
- **正确性论证**：
  - 前置：`caller` 与 `target` 对应的 Session 均存在。
  - 论证：步骤 3 的 ensures 给出后代闭包 ⇒ `⋃ layers = desc ∪ {target}` 满足类型不变量第一条。
    步骤 5 的降序排列直接给出"∀ i < j，layers[i] 的 depth > layers[j] 的 depth"。
    target 是子树中 depth 最小者（其余都是它的后代，depth 严格更大），故降序后它单独构成末层。
    步骤 6 的论证见上，给出 `notify_boundary ∉ ⋃ layers`。
  - 后置：返回值满足 `StopPlan` 全部类型不变量。
  - 副作用论证：只经 `isChild` / `callerDepth` / `descendants` 读取，无写入。

#### 5.4.6 `stop(caller: SessionID, target: SessionID) -> Effect<StopOutcome, NotAChild | AgentNotFound>`

- **功能描述**：自底向上取消目标子树，对**实际发生转变**的成员向其父投递一条 `cancelled` 通知。
- **调用关系**：callers: M5 `agent_stop`；callees: M4 `plan`、M2 `of`、`SessionRunState.cancel`、
  `Session.get`、M3 `deliver`、M4 `renderTermination`。
- **实现思路**：
  1. `plan(caller, target)`。失败原样上抛，无副作用。
  2. `transitioned = []`，`unchanged = []`，`failed = []`。
  3. 对 `layers` 按序遍历（`i` 从 0 到末），每层并发对每个成员 `m`：
     a. **先读状态**：M2 `of(m)`。
        - `idle` → 记入 `unchanged`，**不取消、不发通知**，本成员到此结束。
        - `running` → 进入 b。
        - 必须先读：`SessionRunState.cancel` 对无 runner 的 Session 是**成功空操作**
          （`run-state.ts:77-86` 直接 `status.set(idle)` 返回），事后分不出两种情形。
          不先读就会给本就 idle 的成员发假的 cancelled 通知，重复 stop 也会重复发。
     b. `SessionRunState.cancel(m)`。抛出未预期异常 → 记入 `failed{session_id, reason}`，
        **不中断本层其余成员，也不中断后续层**。
     c. 成功 → 记入 `transitioned`，并向 `m` 的父投递一条通知。
        `StopPlan.layers` 只携带 `SessionID`（架构 §3），故此处 `Session.get(m)` 取回一次
        以拿到 `parentID` 与渲染通知所需的 `name` / `agent_type` / `title`：
        `deliver({ target: info.parentID, sender: m, sender_name, sender_agent,
        body: renderTermination(info) })`。
        - 只对 transitioned 成员取一次，idle 与 failed 成员不取——避免为不发通知的成员做无谓读取。
        - `m` 是 `target` 时其父即 `caller`（= `notify_boundary`）；否则其父也在停止集内，
          且位于更靠后的层。
        - 投递失败（目标不存在等）→ 记日志，**不改判**该成员的 transitioned 归属：
          它确实被取消了，通知没送到是另一回事。
     d. **收齐本层全部结果后**才进入 `i+1` 层。
     - 三分支穷尽：每个成员必落入 `transitioned` / `unchanged` / `failed` 之一。
     - **终止性**：`layers` 长度有限（由 `plan` 产出，等于子树深度跨度），`i` 单调递增至末层。
  4. 返回 `{ transitioned, unchanged, failed }`。
- **正确性论证**：
  - 前置：`target` 是 `caller` 的直接子（由步骤 1 的 `plan` 保证）。
  - 论证：
    - **I1**：设 a 实际发生转变、其父 p 也在停止集内。p 是 a 的父 ⇒ p 的 depth 比 a 小 1 ⇒ 按 `plan`
      的降序分层，p 位于比 a 更靠后的层。步骤 3d 要求收齐第 i 层才进入第 i+1 层，而步骤 3c 的
      `deliver` 在返回时消息已持久化（I2），故「a 的取消通知已投递」happens-before「p 被取消」。
      **强度**：这是"已投递"的排序，不是"已送达"——是否被消费受 issue #32 影响（架构 §10 缺口 5）。
    - **防复活**：由 I1，每条取消通知投递时其接收方（父）仍在运行，`prompt_async` 只会让消息
      加入其当前执行，不会因 Idle 而新起一次，故不会复活刚被停止的 Agent。
    - **幂等**：对已 idle 的成员，步骤 3a 直接记入 `unchanged`，不取消、不发通知。
      因此重复 `stop` 不产生额外通知，也不报错。
    - **通知真实性**：只有步骤 3c 才发通知，而它只在 3a 判定 running 且 3b 取消成功后执行，
      故不存在给 idle 或 failed 成员发通知的路径。
    - **单一生产者**：`cancelled` 通知只由本函数产出；`startDelegation` 的 `notify` 对 `cancelled`
      静默（§5.4.3 步骤 4）。二者互补，一次 `agent_stop` 只产生一条通知。
    - **固有窗口**：步骤 3a 读到 `running` 后、3b 取消前，目标可能自行结束。此时它被计入
      `transitioned` 并收到一条 cancelled 通知，而它其实是正常结束的。该窗口无法在不引入
      跨模块锁的前提下消除；后果是一条措辞偏差的通知，不是状态错乱（架构 §10 缺口 11）。
    - `notify_boundary`（即 caller）不在任何层内，它全程在运行——它正执行本次 `agent_stop` 调用。
  - 后置：`StopOutcome` 满足其类型不变量。"停止后仍可经 `agent_send` 恢复"由副作用论证第 (2) 条给出。
  - 副作用论证：(1) 中断子树中原本在跑的成员的执行 —— 步骤 3b；(2) 不删除任何 Session、消息或
    历史，故被停成员的 Session 与历史完整存续，`deliver` 对其仍可投递并起新执行；
    (3) 向实际转变成员的父 Session 各写入一条通知消息 —— 步骤 3c。

#### 5.4.7 `renderTermination(m: AgentSkeleton) -> string`

- **功能描述**：渲染 `cancelled` 通知的正文。
- **实现思路**：状态词统一用 `cancelled`（调研 §5.4，不引入 `stopped`），
  正文含被停 Agent 的 `session_id`、`name`（若有）、`agent_type` 与 `title`，
  并说明它可经 `agent_send` 恢复。长度受 `Truncate.limits()` 约束，与既有 subagent 错误渲染同一上界。
- **正确性论证**：trivial —— 纯字符串拼接。

### 5.5 M5 AgentTools

**本模块共同约束**：`agent` 经 `ctx.ask({ permission: "agent", patterns: [subagent_type], always: ["*"] })`
求值——**保留调用**，把默认动作由 `ask` 改为 `allow`（架构 §6）。`deny` 与显式 `ask` 仍生效，
subtype 级规则也仍生效。`agent_list` / `agent_send` / `agent_stop` 不新增逐次确认。
被派生 Agent 自身的工具调用继续在它自己的 Session 权限下受控，本 feature 不改动该机制。

（上一版写的"四个工具都不调用 `ctx.ask`"是错的：删掉调用会连带删掉**唯一**求值 `deny` 的地方。）

#### 5.5.1 `agent(params, ctx) -> Effect<string>`

- **功能描述**：读上下文、过权限门、创建子 Agent 并渲染结果。**上下文读取全在本函数**。
- **调用关系**：callees: `MessageV2.get`、`ctx.ask`、M4 `create`、`ctx.metadata`。
- **实现思路**：
  1. 从 `ctx.sessionID` 取 caller，不接受模型提供的调用者身份（架构 §5 接口协议）。
  2. `ctx.ask({ permission: "agent", patterns: [params.subagent_type], always: ["*"] })`。
     `deny` → 失败返回，**无副作用**。
     - `bypassAgentCheck` 时跳过（既有内部旁路，清单 §1.5，不动）。
  3. **读调用者当次的 assistant 消息**取继承源（清单 §3.1）：
     `MessageV2.get({ sessionID: caller, messageID: ctx.messageID })`。角色不是 assistant → 失败。
     - 为什么必须读它：`variant` 只存在于消息上，Session 不持有；继承模型也取自这条消息，
       而非 Session 的当前模型——同一 Session 的不同轮次可能用不同模型。
     - 为什么在 M5 而不在 M4：`ctx` 是工具层的东西。M4 只接收 `{ model, variant }` 窄数据
       （架构 §5 接口），否则生命周期层要依赖工具上下文的形状。
  4. 取该 Session 的 `metadata.agentWorkdir` 作为 `callerWorkdir`（供 baseCommit 取基线）。
  5. 调 M4 `create({ caller, name: params.name, subagent_type, description, prompt,
     cwd: params.cwd, model: { providerID, modelID }, variant, callerWorkdir })`。
  6. 成功 → 写工具元数据：
     `ctx.metadata({ title: description, metadata: { parentSessionId: caller,
     sessionId: info.session_id, model } })`（清单 §8.1）。TUI 的 task 卡片靠这些字段渲染。
  7. 分支渲染：成功 → 渲染 `AgentInfo`（含 `session_id` 与 `name`，供后续寻址，
     并附工作目录路径）；`DepthLimitReached` → "已达嵌套上限"；
     `AgentTypeNotFound` → "未知 agent 类型"；`AgentNameConflict` → "该名称已被占用，
     请换一个或省略 name"（**不返回既有 Agent 的 session_id**，架构 §6）；
     `WorktreeUnavailable` → "工作目录准备失败：<reason>"；`AgentNotFound` → "调用者 Session 不存在"。
  8. 返回文本。
- **正确性论证**：非平凡（跨模块调用 + 权限门）。前置：调用发生在某 Session 的工具上下文中。
  论证：步骤 1 使 caller 不可伪造；步骤 2 的权限门先于任何副作用（满足架构 §4.5 的模块不变式）；
  步骤 5 的所有失败在步骤 7 被穷尽映射为文本，无未处理分支；成功路径的副作用完全由 `create` 承担。
  后置：返回模型可读文本。副作用：步骤 6 的展示元数据；其余委托给 M4。

#### 5.5.2 `agent_list(ctx) -> Effect<string>`

- **功能描述**：渲染调用者的邻居 roster。**AgentInfo 在此组装。**
- **调用关系**：callees: M1 `neighborhood`、M2 `of`。
- **实现思路**：
  1. `neighborhood(ctx.sessionID)` 得 `AgentSkeleton[]`。失败 → 渲染错误返回。
  2. 对每个成员调用 M2 `of(session_id)` 得 status，与 skeleton 合成完整 `AgentInfo`。
     可并发，无顺序要求 —— `of` 的功能规约声明只读且结果为即时快照。
     - **这一步是架构 §3「装配责任」的落点**：M1 不声称构造了完整 AgentInfo。
  3. 渲染为紧凑表：`session_id` / `name` / `agent_type` / `relation` / `status` / `title` / `workdir`。
     - `session_id` 与 `name` **都要显示**：前者是权威地址与歧义时的唯一出路，
       后者是 `agent_send` / `agent_stop` 的便利形式。只显示其一都会让模型在另一种情形下卡住。
     - `name` 为空时该列留空，提示模型只能用 session_id 寻址该成员。
     - `workdir` 不可省：各 Agent 可能在不同目录里，缺了它无法判断谁在哪儿干活。
  4. 边界：`members` 只含自己（主 Agent 且无子）时仍返回该行，不返回空结果——空表会让模型误判为出错。
- **正确性论证**：非平凡（跨模块调用）。论证：步骤 2 对每个成员各调一次 `of`，成员集合有限且来自
  步骤 1 的输出，故遍历必然终止；`of` 无失败通道，故本步无失败分支。后置：每行的 status 是该次调用
  瞬间的快照，不保证行间一致——这是架构 §5 M5→M2 接口协议已声明的。副作用：无。

#### 5.5.3 `agent_send(params, ctx) -> Effect<string>`

- **功能描述**：向任一存在的 Session 投递消息。**只回 accepted，不等待、不回复。**
- **调用关系**：callees: `Session.get`、M1 `resolveTarget`、M3 `deliver`。
- **实现思路**：
  1. caller 取自 `ctx.sessionID`。
  2. 取 caller 的 `metadata.agentName` 与 `agent` 作为 `sender_name` / `sender_agent`
     （仅用于前缀可读性）。
  3. `resolveTarget(caller, params.target, "neighbor")` 得目标 SessionID。
     失败 → 渲染 `TargetNotResolved` 的候选清单返回，无副作用。
  4. 构造 `AgentMessage{ target, sender: caller, sender_name, sender_agent, body: params.message }`。
  5. 调 M3 `deliver`。**不做邻居校验，不做同树校验**（架构 §6）。
  6. 分支：`Accepted` → 渲染"已接受。**这是单向消息：目标不会自动回复，本调用也不等待它。**
     若需要回应，等待目标主动 `agent_send` 回来。"；
     `SelfDelivery` → "不能给自己发消息"；`AgentNotFound` → "目标 Session 不存在"。
  7. 返回文本。
- **正确性论证**：非平凡（跨模块调用 + 状态变更）。论证：步骤 4 的 `sender` 取自上下文而非入参，
  故模型无法伪造发送者；`deliver` 的三种终态在步骤 6 被穷尽覆盖；失败两支均由 `deliver` 在写入前
  返回，故失败时无副作用。
  **步骤 6 的措辞是契约的一部分**：不写明单向，模型会把 `agent_send` 当成阻塞调用，
  然后在下一轮追问"结果呢"。后置：返回文本表示"已接受"或明确的失败原因。
  副作用：成功路径下目标 Session 多一条消息，由 `deliver` 承担。

#### 5.5.4 `agent_stop(params, ctx) -> Effect<string>`

- **功能描述**：停止直接子 Agent 及其后代。
- **调用关系**：callees: M1 `resolveTarget`、M4 `stop`。
- **实现思路**：
  1. caller 取自 `ctx.sessionID`。
  2. `resolveTarget(caller, params.target, "child")` 得目标 SessionID；失败 → 渲染候选清单返回。
  3. 调 M4 `stop(caller, 目标)`。
  4. 分支：成功 → 渲染 `StopOutcome` 三段：`transitioned`（本次真正停下的）、`unchanged`
     （调用时本就空闲、未产生通知的）、`failed`（出错的，**必须**逐条列出，架构 §5 M5→M4 协议要求
     显式报告）。三段都要呈现——只报 `transitioned` 会让模型以为 `unchanged` 的成员没被处理；
     `NotAChild` → "只能停止自己直接派生的 Agent"；`AgentNotFound` → "目标不存在"。
  5. 返回文本。
- **正确性论证**：非平凡（跨模块调用 + 状态变更）。论证：`stop` 的三种终态在步骤 4 被穷尽覆盖；
  `failed` 非空时的渲染是协议硬要求，不得省略或折叠。后置：返回文本如实反映哪些成员被停止、
  哪些本就空闲、哪些失败。副作用：委托给 M4。

#### 5.5.5 `available(ctx) -> Effect<ToolName[]>`

- **功能描述**：按调用者深度决定向模型暴露哪些工具。
- **调用关系**：callers: 工具注册；callees: M1 `callerDepth`。
- **实现思路**：
  1. M1 `callerDepth(ctx.sessionID)` 得 `{ depth }`。callee 契约见 §5.1.8：只读，终止性已论证。
  2. 分支：`depth >= cfg.subagent_depth` → 返回 `[agent_list, agent_send]`；
     否则返回 `[agent, agent_list, agent_send, agent_stop]`。
  3. 判据是深度到限，**不是**当前是否有子 Agent（架构 §6）——否则 `agent_stop` 会随派生忽隐忽现。
- **正确性论证**：
  - 前置：`ctx.sessionID` 对应的 Session 存在。
  - 论证：到限的 Agent 无法再派生（步骤 2 撤下 `agent`，且 M4 `create` 的步骤 2 仍会拒绝），
    故其子集合永久为空 ⇒ `agent_stop` 的寻址集合永久为空 ⇒ 撤下不损失任何可用能力。
    `agent_send` 与 `agent_list` 的寻址集合含父与兄弟，与深度无关 ⇒ 保留。
  - **边角**：若 `subagent_depth` 被调低，或某深度 3 的 Session 是在上限更高时建的子，
    它会有子却无 `agent_stop` 可用。此时仍可由更上层停止其祖先（级联覆盖它）。
    记为已接受的边角，不为它加"当前是否有子"的判据——那会让工具忽隐忽现。
  - 后置：返回的工具集合恰为寻址集合非空者（除上述边角）。
  - 副作用论证：只读 Session，无写入。

#### 5.5.6 `task` 兼容入口

- **功能描述**：不向模型展示的旧名入口。
- **实现思路**：接受旧参数形状，把 `task_id` 规范化为 `session_id` 后转发：
  给了 `task_id` → 转 `agent_send`；未给 → 转 `agent`（经同一个 `startDelegation`）。
  旧的 `background` 参数被忽略（Agent 恒为异步，架构 §6）。
  **权限用规范化后的 `agent` key**，不能成为绕过。不维护第二套状态、执行路径或测试基准（调研 §8）。
  - 与旧行为的一处差异：既有 `task.ts:268-270` 在 `task_id` 取不到 Session 时**静默回落为新建**。
    此处取消该回落——目标不存在应报 `AgentNotFound`，不悄悄新建一个（清单 §2.1）。
- **正确性论证**：trivial —— 参数改名加分发，无独立逻辑。

## 6. 完整性自检 checklist

- [x] 所有函数实现思路推导连续（无跳步）—— 每个非 trivial 函数按编号步骤展开，含入参校验、
      callee 调用、返回值三路处理
- [x] 所有 if / else / switch 分支已覆盖 —— `neighborhood` 的有无父、`of` 的三支状态、
      `resolveTarget` 的 id/名称与三种基数、`prepareWorkdir` 的三分支、`classify` 的六分支、
      `stop` 的 idle/running/failed、`available` 的到限与否均已刻画
- [x] 所有退出点（成功 / 失败 / 异常）已刻画 —— §3 定义八个失败类型，每个函数的失败分支均标注
      "无副作用"或说明已产生的副作用；`AgentNameConflict` 与 `WorktreeUnavailable` 的零副作用
      在 `create` 的正确性论证中逐条给出（步骤 3 与 7 均在 `Session.create` 之前）
- [x] 所有 callee 调用显式引用其 pre / post —— `Session.children`、`SessionStatus.get`、
      `SessionRunState.cancel`（含"对 idle 是成功空操作"这一关键契约）、`prompt`、
      `BackgroundJob.start/wait`、既有 `notify`/`inject` 的契约均在使用点引述
- [x] 每个模块的函数覆盖该模块在架构 §4 的全部 Ensures 与不变式 ——
      M1 的 I4 由 `reserveName` 的同步段论证给出；
      M3 的 I2 由 `deliver` 步骤 4-5 给出，且明确声明**不蕴含**被消费；
      M4 的 I1 由 `stop` 步骤 3d 的收齐语义给出，强度限定为"已投递"；
      M4 的"停止后可恢复"由 `stop` 的副作用论证第 (2) 条给出；
      M5 的权限门写在模块前言，不逐函数重复
- [x] 所有循环有终止性论证 —— `descendants`（`seen` 单调增长且有上界）、`stop`（层数有限）、
      `callerDepth`（每步上移一层，链无环有限）
- [x] `task-inventory.md` 的每一条都有落点，且**不再存在"缺失"与"已补齐"并存的状态** ——
      见该文件的重新标注
- [x] 工作目录的每个分支都有归属与退出刻画 —— 三分支互斥穷尽；git 分支的 a–e 顺序与失败点已列；
      ready 契约是硬要求且失败即 `WorktreeUnavailable` 不启动 Agent；
      V1 不清理故无清理分支
- [x] 所有上游事实显式列出 —— H2（parentID 链无环且深度有限）在 `neighborhood` / `descendants` /
      `callerDepth` / `plan` 的使用点各自标注；H3（同进程串行创建）在 `reserveName` 的论证中引用；
      I2、I4 在 `deliver` 与 `resolveTarget` 的论证中显式引用；
      issue #32 的影响在 `deliver` 的后置条件与 `stop` 的 I1 强度声明中各标一次
