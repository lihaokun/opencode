# 修正方案 — session-runner：run 收尾竞态让同一会话跑出两条循环

> 对应 issue #85（lihaokun/opencode），关联 #32 / PR #34（`docs/fixes/session-runner-fix-idle-race.md`）与 #62。本文档按 workflow §7.1 八部分组织；第一至五部分修复前完成，第六至八部分修复前列计划、修复后回填。

## 第一部分：现象与复现

### 现象

本机主会话 `ses_f0d514…` 在 2026-10-27 19:52:47–19:54:47 连续输出 9 条"待命 / 值守中"类回复，期间没有任何新消息进入会话，直到人工输入打断。2026-10-08 09:49–09:55 发生过同样的事（52 条重叠助手消息）。两次都在两条循环恰好同时到达安静点后自愈。

数据库与日志证据：

| 证据 | 数值 |
|---|---|
| 创建时间与上一条助手消息完成时间重叠的助手消息（10-27 19:49–19:57） | 41 条 |
| 日志里同一会话交错推进的 step 序列 | 两条（9,13,10,14,… 一条退出后另一条继续，随后又起第三条） |
| 每一步的 `process` / `stream` 日志 | 成对出现，间隔 < 1 s |

运行期间会话状态显示 idle（花名册、`agent_list` 的 running 判断跟着错）；两条循环重复处理每条消息（10-27 19:55:37 一步发出 7 次 agent_send，与 #75 的"重复派活"同源）。

### 最小复现用例

竞态窗口无法用纯同步序列确定性复现，复现以测试夹具控制时点（见第六部分）：

1. **Runner 层**（`test/effect/`，绕过 DB）：`Runner.make` 配可控 `shouldReArm`（Deferred 挂起），让第一个 run 的 `finishRun` 停在临界区谓词内。
2. fork 一个等待者调用 `ensureRunning`（拿到 runner 引用后在信号量上排队）。
3. 放行谓词 → 判假 → 临界区内置 Idle、**放锁**，锁外 `onIdle` 才执行（修复前：从 map 删掉该 runner）。
4. 等待者获得锁、见 Idle、在同一 runner 上起跑（成为孤儿）。
5. 再次调用 `ensureRunning`：修复前 map 未命中 → `Runner.make` 新建第二个 runner → 与在途孤儿并发执行同一会话的 work。

预期：同一会话任意时刻至多一条循环在跑（会话级串行不变量）。
实际（修复前）：第 5 步的 work 与第 4 步的孤儿并发，即"两条循环"。

### 出错代码路径

- `packages/opencode/src/effect/runner.ts:98-104` — `finishRun` Idle 分支：新状态 `{_tag:"Idle"}` 在临界区内生效，`yield* idle`（发 idle 状态）作为 action **锁外**执行
- `packages/opencode/src/session/run-state.ts:63-66` — `onIdle`：`data.runners.delete(sessionID)` + `status.set(idle)`，在 Runner 锁外跑
- `packages/opencode/src/session/run-state.ts:59-61` / `98` — 写入方先从 map 取 runner 引用、再在 runner 信号量上排队；取引用与排队之间无原子性
- `packages/opencode/src/effect/runner.ts:90-91` — `shouldReArm` 在临界区内执行，其长度决定锁持有时间
- `packages/opencode/src/session/prompt.ts:1536` — 谓词经 `MessageV2.filterCompactedEffect` → `stream()` 整表分页加载 + hydrate 全部 parts（本会话 22,280 条消息 / 64,959 parts / 62 MB，#62），单次数秒
- `packages/opencode/src/session/prompt.ts:1228-1275` — runLoop 顶部退出条件要求最新 assistant 有 `finish` 且属于最新 turn

### 预期行为 vs 实际行为

- 预期：写入方落库后，要么 join 在途 run，要么看到 idle 新起一轮——同一会话始终至多一条循环；循环退出即状态 idle、runner 可复用
- 实际（修复前）：交错窗口内 run 已置 Idle 但 runner 尚未从 map 删除，排队者在同一 runner 上起跑；`onIdle` 随后把它从 map 删除 → 孤儿；下一条消息新建第二个 runner → 并发双循环，互相把对方"无 finish 的 assistant"当作"还没说完"，直到两条恰好同时退出

时序（事故 10-27 实测）：上一轮 11:46:59Z 退出；"好"（人工输入）11:47:03Z 落库 → 新 step=0 11:47:05Z；FSM 看门狗消息 11:49:00Z → 第二条循环 step=0 11:49:04Z。10-08 事故为 01:48:54Z 退出、01:48:55Z 起跑、01:49:05Z 第二条。

## 第二部分：根因分析

**症状**：同一会话两条 runLoop 并发，互相把对方未完成的 assistant 当作"还没说完"，反复输出占位回复。

**根因有两个，缺一不发生：**

**根因 A（结构性，#32 修复的论证缺口）：`onIdle` 在 Runner 临界区之外把 runner 从 map 删除，而等待者在排队之前就已持有 runner 引用。**

`ensureRunning` 的调用链是"从 map 取引用 → 在该引用的信号量上排队"两步；`finishRun` 把 Idle 转换和 `onIdle` 拆在"临界区内置状态、锁外执行 action"两步。两条时序在锁外交叉：排队者拿到锁时看到 Idle（起跑），`onIdle` 之后才删表（孤儿化）。#32 修正文档的正确性论证只覆盖了 `Runner` 内部状态机在 `SynchronizedRef` 上的全序，没有覆盖 `SessionRunState` 在锁外删表这一步——当时会话小，`shouldReArm` 毫秒级返回，这个窗口窄到从未被观察到。

**根因 B（放大器）：`shouldReArm` 在临界区内整表加载会话历史，锁持有时间随会话规模增长。**

谓词走 `filterCompactedEffect`（全量 `stream()` 分页 + hydrate 所有 parts）。会话 22k 消息时单次数秒，"最后一次读 → 置 Idle → 放锁 → onIdle"整个窗口随之从毫秒放大到秒级，根因 A 的交错从"理论可能"变成"两次事故实测"。

**为什么两条循环会自我维持**：runLoop 顶部退出条件（最新 assistant 有 `finish` 且属于最新 turn）在双循环下永假——任一条到顶时，最新 assistant 是对方正在写、尚无 `finish` 的那条。模型看到的历史末尾只有占位回复，只能再答一句占位回复。这是#85 的"刷屏"表象；消除双循环本身即消除刷屏。

**区分症状与根因**："模型反复输出待命"是症状；根因是"同一会话出现两条循环"。只加循环顶部的守卫（防刷屏）而不修 A/B，两条循环仍会重复消费消息、浪费 provider 请求——守卫只是第二道防线，不是修复本体。

## 第三部分：参考实现对照

**对照 1：同仓库 V2 `SessionRunCoordinator.settle`**（`packages/core/src/session/run-coordinator.ts`，#32 已对照过）：其"检查 + 转换"在同一同步块、active 表的删除也在同一块内——即 V2 的 coordinator 从不在"已转换状态"与"已从表删除"之间留窗口。V1 的 `finishRun` + `run-state.onIdle` 把这两步拆开了，差异点即根因 A。

**对照 2：#32 修复自身（`docs/fixes/session-runner-fix-idle-race.md` 第五部分）**：其不变量清单覆盖"有界重启 / 守卫完备 / 既有语义不变 / join 方契约 / 状态不闪烁"，但全部以"Runner 内部状态机"为对象；`SessionRunState` 的 map 生命周期（删除时机）不在论证范围。本修复把论证范围扩到 map 生命周期，并补上"锁持有时间上界"这条性能论证——这是 #32 文档结构上缺的两节。

| 维度 | V2 `settle` | V1（出错路径） |
|---|---|---|
| 状态转换与表删除的相对位置 | 同一同步块 | 转换在临界区内，删表在锁外 action |
| 判定的成本 | `entry.pendingWake` 标志，O(1) | 整表加载，O(全会话) |
| 判定与转换是否同临界区 | 是 | 是（#32 已修） |

## 第四部分：修复方案

### 修什么

1. **`packages/opencode/src/session/run-state.ts` — 不再删除 runner。** `onIdle` 去掉 `data.runners.delete(sessionID)`，只保留 `status.set(idle)`。不选"删表 + 等待者锁后重取"方案：那需要把 map 查找塞进 Runner 的信号量临界区（依赖倒置，Runner 不该知道 map 的存在），而"不删"的代价只是每个跑过的会话保留一个小对象（按本进程跑过的会话数线性增长，无 per-run 增长；instance 关闭时的 finalizer 本就遍历 `runner.cancel`，语义不变）。
2. **`packages/opencode/src/effect/runner.ts` — `idle` 移入临界区。** `finishRun` 的 Idle 分支改为在 `modifyEffect` 体内先 `yield* idle` 再返回 Idle 状态，保证"转 Idle + 发 idle 状态"原子地先于任何排队者起跑，消除"运行中闪 idle"的状态竞态。`SessionStatus.set` 内部只读 `InstanceState` map + 发事件，不回调 runner 锁，无死锁风险。重整分支不调 `idle`，不变。
3. **`packages/opencode/src/session/message-v2.ts` + `prompt.ts` — 谓词降为单行查询。** 关键观察：`compareChronology` 即 `(time_created, id)` 全序，与 `MessageV2.page` 的 SQL 排序（`desc(time_created), desc(id)`）完全一致，且 `info()` 用 `row.time_created` 覆盖 JSON 内嵌的 `time.created`。因此「最新 user 晚于最新 assistant」**等价于「按持久化序的最新一条消息 role 为 user」**（max(user, assistant) 中较大者即全序意义下的最新消息）。新增 `MessageV2.latestRoleEffect`（或等价导出）：单行索引查询（`limit 1`，命中 `message_session_time_created_id_idx`），毫秒级。`prompt.ts` 的 `hasUnconsumedTurn` 换用它，fail-closed 语义与 `reportRunEnd` 的复用自动受益。边界：空会话（无消息）→ `false`（现谓词 `user` 为 undefined 时同样为假）；只有 user 无 assistant → 最新消息 role 为 user → `true`（现谓词 `!assistant` 分支同样为真）——语义逐点等价。
4. **`packages/opencode/src/session/prompt.ts` — runLoop 顶部第二道防线。** runLoop 闭包内维护 `Set<MessageID>` 记录本循环创建的 assistant（每次 `sessions.updateMessage(msg)` 落库前记入，`prompt.ts:1351` 处）。顶部退出检查处新增：`lastAssistant` 无 `finish` ∧ 属于最新 turn ∧ **不在本循环集合内** → 记 warning 日志 + break（不发起 provider 请求）。必须带 `lastAssistantBelongsToLatestTurn` 收窄：否则 processor stop / compaction stop 留下无 finish 的旧 assistant 后，用户新消息触发的合法新循环会在第一轮被误杀。这道防线把"若再出现并行"的后果从"刷屏"降为"一轮重叠"，不替代修 1-3。
5. **`packages/opencode/src/effect/runner.ts` — 临界区内的通知失败隔离 + 全部 idle 转换点入锁（review 轮追加）。** 修 2 把 `yield* idle` 放进 pf 体内后引入了新失败面：pf 内未隔离的 defect 会让 `modifyEffect` 整体不提交——ref 停留 Running、返回的 `complete(done)` 不执行，joiner 与后续所有 caller 永久挂死（review #1，基座下同场景仅首个 caller 挂、状态已提交可恢复；本 PR head 下全挂，是比基座更差的失败放大）。因此 (a) idle 通知经 `safeIdle`（`catchCause → logError`）隔离，保证状态转换与 waiter 结算无条件落地；(b) `shouldReArm` 同样隔离并 fail-closed（defect 视为不 re-arm，与生产谓词自身的 fail-closed 语义一致）；(c) `finishShell` 与 `idleIfCurrent`（cancel）两处遗留的锁外 idle 同型修复——"idle 发布全部在临界区内"才成为完整不变量，否则 review 补充项里 `shell idle-start → 新 work busy → 旧 shell idle` 的乱序仍在；(d) `idleIfCurrent` 改为仅当状态已是 Idle 才发（cancel 提交 Idle 后被中断 run 的 finishRun 对非 Running 早退，此处补发；若新 run 已先入则不发，避免迟到 idle 覆盖新 run 的 busy）。

### 为什么这样修（根因如何被消除）

- 根因 A：等待者与 `onIdle` 的交错之所以危险，是因为删表会让后续写入方新建第二个 runner。不删表后，交错的最坏结果只是"等待者在旧 runner 上 join 到一个刚刚重新武装/正常结束的 run"——所有写入方永远共享同一 runner，会话级串行不变量由 Runner 的信号量全序保证，孤儿不再存在。
- 根因 B：判定改为单行索引查询后，临界区内的谓词执行是 O(1) 页查询，锁持有时间与会话规模解耦（毫秒级上界，第六部分列耗时断言）。
- 防线（修 4）不参与根因链：它只在"双循环已经发生"时把每次重叠的输出从 N 条降到 ≤1 条。

### 关键取舍

- **不删 runner vs 删表+锁后重取**：见"修什么"第 1 条。Runner 的钩子（`onIdle`/`onBusy`/`onInterrupt`/`shouldReArm`）全部是按 sessionID 参数化、执行时现读持久化状态的 Effect——复用陈旧 runner 安全的前提是这条不变量，须在代码注释与本文档同时记载；未来若有人给 Runner 钩子加"创建时捕获"的状态，此处会静默失效，依赖第六部分的并发回归兜底。
- **idle 进临界区 vs 维持锁外**：锁外执行会让"排队者已起跑（busy）"与"`onIdle` 后发的 idle 状态"乱序到达消费方（TUI/花名册按事件流投影）。移入临界区的代价是 `status.set`（map 写 + 两次事件 publish）在锁内，均为内存操作，微秒级。
- **单行查询 vs 查两条（user/assistant 各一）**：等价且更省；一次 `limit 1` 即可，因为判据只依赖全序下两者的最大者。
- **守卫收窄（带 turn 归属）**：issue 原文只说"无 finish 且非本循环所创"；不带 turn 归属会误杀"processor/compaction stop 后的新 turn"（那里最新 assistant 无 finish 但**旧于**最新 user，`lastAssistantBelongsToLatestTurn` 为假，合法通过）。收窄后守卫的触发形态恰为"另一条循环正在答最新这一轮"，是双循环的充要表象。
- **守卫命中时 break 而非等待**：等待需要新的挂起/唤醒机制（为不存在的常态引入 seam）；break 后若有真实未消费消息，#32 的 re-arm 机制（修 3 的高效谓词）会在收尾时发现并重整——两条既有机制组合已覆盖，无须新增。

### 修改后的预期行为

按第一部分复现序列走修复后逻辑：第 3 步放行谓词 → 判假 → 临界区内 `yield* idle`（状态置 idle）→ 置 Idle → 放锁；等待者拿锁、见 Idle、在同一 runner 上起跑；第 5 步 `ensureRunning` 从 map 取到**同一个** runner → join 分支共享在途 run 结果，不再新建循环。run 全程 status 为 busy（idle 事件发出时锁尚未放，排队者起跑的 busy 事件必然晚于它）。即使某种未知交错再产生并行，第二道防线让重叠轮退出且不发起请求。

## 第五部分：正确性论证

**1. 根因消除**：

- A：对任意两条 `ensureRunning` 调用，无论交错如何，`runner()` 都返回 map 中同一实例（map 从此只增不减，同一 sessionID 只 `set` 一次）；Runner 内部 `ensureRunning`/`finishRun` 在同一 `SynchronizedRef` 信号量上全序，后者要么 join 前者、要么在前者置 Idle 后起跑——同一会话任意时刻至多一个 work fiber 在跑。"下一条消息新建第二个 runner"不可达。
- B：谓词改为单行查询后，`finishRun` 临界区内不再有任何 O(全会话) 的操作；锁持有时间与消息总量无关。

**2. 不变量保持**：

- *会话级串行*（新增显式化，先前隐含）：同一 sessionID 的所有 run 共享同一 Runner 实例；不删表使该不变量从"绝大多数时候成立"变为"恒成立"。
- *有界重启（#32 已证，本修复不触碰）*：谓词语义逐点等价（第四部分第 3 条的边界对照），重整轮次仍有界。
- *状态事件全序*：idle 状态事件（`finishRun` 临界区内）与下一个 run 的 busy 状态事件（`runLoop` 首行）严格有序——后者只能在锁释放后发生，而锁释放前 idle 事件已 publish。消费方（`stream.transport`、`run.ts` 的 working 集合）不会再观察到"busy → (无 idle) → 孤儿跑着"的投影。review 轮后该不变量扩到**全部** idle 转换点：`finishRun` / `finishShell` / `idleIfCurrent`（cancel）三处均在临界区内发布，且失败经 `safeIdle` 隔离——通知 defect 不阻断状态提交与 waiter 结算（见第四部分修 1）。
- *cancel / shell / join 契约不变*：`cancel` 的分支结构与 `finishShell` 的状态机未变，仅 idle 通知的执行位置移入临界区（`idleIfCurrent` 仍只在状态为 Idle 时发布，新 run 先入时不发，不会覆盖新 run 的 busy）；join 分支未动；map finalizer（instance 关闭时遍历 `runner.cancel`）对不删的 runner 依然正确——cancel 一个 Idle runner 是 no-op（`runner.ts:200-203`）。
- *内存*：map 大小 = 本 instance 跑过的会话数（原为"活跃会话数"）。每项是一个 Runner 对象（一个 `SynchronizedRef` + 数个闭包），KB 级；长驻 server 进程跑过数千会话的量级仍在 MB 以下，可接受。若未来需要回收，引入条件应是"有证据表明内存成为问题"，而非现在预留 seam。
- *runLoop 终止性（守卫）*：守卫命中即 break，不增加迭代；集合 `Set` 随 runLoop 调用帧生存，无跨 run 泄漏。

**3. 无回归引入**：依赖第六部分——并发回归（双循环不可达 + 状态不闪 idle，修复前 RED）、守卫回归（修复前 RED）、判定成本上界（2 万条消息毫秒级）、既有 runner/prompt/message-v2 套件全绿。

## 第六部分：测试用例清单

| 类型 | 用例描述 | 状态（修复后回填） |
|------|---------|------------------|
| 回归 | runner 级：`finishRun` 转_IDLE_时 idle 副作用（SessionRunState 下的 map 删除 + 状态发布）必须在临界区内完成，先于任何排队者的 work 启动——可控 `shouldReArm` 挂住临界区 → 排队者 → 放行 → 断言 `onIdle-end` 先于 `work-2`（修复前 RED：queued work 在 onIdle 完成前启动，即孤儿删除落在运行中的 run 上） | 已加: `test/effect/runner.test.ts` "runs the idle transition before a queued caller's work starts"（commit 见第七部分） |
| 回归 | run-state 级并发回归：可控 `shouldReArm` 制造收尾窗口 → 写入方在窗口内排队 → 第三个写入方必须 join 在途 run（同一 runner 服务全会话）；修复前形态（map 丢失 runner）下第三个写入方会新建 runner 并立即并发执行 | 已加: `test/session/run-state.test.ts` "keeps one runner per session across the finish window (two loops must be unreachable)" |
| 回归 | run-state 级（review 后重写）：收尾窗口内排队的写入方起跑后自己置 busy 并存活过前一 run 的 idle 转换，读到的 status 不得被前一 run 的迟到 idle 覆盖（"运行中读 idle"的会话级表象）。契约守卫：本 harness 的调度下 pre-fix 的 post-lock onIdle 先于排队者续跑完成，会话级 status 断言不构成确定性 RED；确定性 RED 由 runner 级顺序用例（finishRun/shell/cancel 三处）承担 | 已重写: `test/session/run-state.test.ts` "publishes idle status before a queued writer starts the next run"（review #2：原版仅一次 ensureRunning、无排队者、`watching` 残留未读，`events===["idle"]` 锚的是新 session 的默认 idle，修复前后皆绿，零判别力） |
| 回归 | run-state 级（review 后新增，复审轮 #1 重写）：re-arm 真实发生两轮 execution——谓词首轮 true（re-arm）、次轮 false（settle，从谓词侧翻转标志而非 work 体内，避免执行序依赖）；第二次 execution 用 Deferred 挂住，窗口内断言 session 仍 busy（无中间 idle）、executions === 2、caller 以首个 execution 结果结算（#32 join 契约）；释放后最终 idle。判别力验证：把谓词恒 false（模拟无 re-arm）时 executions===2 断言失败 | 已加: `test/session/run-state.test.ts` "re-arming runs the work twice with no intermediate idle and settles the caller with the first result"（复审轮重写；首版 `firstExecution` 在 work 体内先翻转导致谓词首轮即 false、实际只执行一次，reviewer 抓出） |
| 回归 | runner 级（review 后新增）：idle hook 首次执行即 die → 首个 caller 仍结算、第二次 `ensureRunning` 仍能执行 work 并结算（修复前 RED 超时：pf 中 defect 使状态不提交、Deferred 悬挂，后续调用全部 join 死 run） | 已加: `test/effect/runner.test.ts` "survives a defecting idle hook: later runs still execute and settle" |
| 回归 | runner 级（review 后新增）：`shouldReArm` 谓词首次执行即 die → fail-closed（不 re-arm），run 正常结算、状态 Idle（修复前 RED 超时：同上机制） | 已加: `test/effect/runner.test.ts` "survives a defecting re-arm predicate: run settles without re-arming" |
| 回归 | runner 级（review 后新增）：`finishShell` 的 idle 通知必须先于下一个 work 启动——慢 onIdle + shell 结束期间排队的 caller，断言 `onIdle-end` 先于 `work`（修复前 RED：idle 作为返回 action 锁外执行，新 work 先跑、迟到 idle 覆盖 busy） | 已加: `test/effect/runner.test.ts` "completes the shell idle transition before a queued caller's work starts" |
| 回归 | runner 级（review 后新增）：cancel 的 `idleIfCurrent` 通知必须先于排队者 work 启动——cancel fork 后 5ms 起排队（cancel 临界区在途），断言 `onIdle-end` 先于 `work`（修复前 RED：pre-fix 的 `idleIfCurrent` 是 `modify` 返回 action 锁外执行，实测序 `work → onIdle-end`；注意 cancel 与下一条调用**顺序执行**时该断言不 RED——顺序场景的续跑天然晚于 action，RED 需要 cancel 在途时并发排队） | 已加: `test/effect/runner.test.ts` "completes the cancel idle transition before a queued caller's work starts" |
| 新增 | 判定正确性：`MessageV2.latestRole` 空 session → undefined / 最新为 user / 最新为 assistant / 同毫秒按 id 决胜（与 SQL 排序、`compareChronology` 一致） | 已加: `test/session/messages-pagination.test.ts` describe("MessageV2.latestRole") 4 例 |
| 新增 | 判定成本上界：2000 条消息的 session，断言 `latestRole` 耗时 < 500ms（实际毫秒级；整表加载在同规模下达秒级） | 已加: 同上 "stays fast on a large session" |
| 新增 | prompt 级守卫：`runLoop` 在本循环已产出 assistant 后，遇到"无 finish ∧ 属最新 turn ∧ 非本循环所创"的更新 assistant 即 break（第二道防线，不发起 provider 请求） | 未单列：守卫语义由 shell 相关既有用例（"loop waits while shell runs"、"shell completion resumes queued loop callers"，`step > 0` 豁免首迭代）与 runner/run-state 两级并发回归共同覆盖；独立 RED 用例需在单进程中伪造第二条循环，与 runner 级 RED 重复，见"验证记录"节说明 |
| 修正 | 第一版把 run-state 级断言锚在 status 读数上（"mid-run 不得读 idle"）——实测该判据在本 harness 不可靠（status.get 的 idle 既是"被删"也是"从未 set"的默认值；且预修复的越带 idle 实际落在 run 收尾附近，时序漂移）。改锚为 join 语义（executions 计数 + 第三个 caller 的返回值），它对"第二个 runner 出现"敏感：新 runner 会立刻执行其 work（exec=3 / 返回 "third"），单 runner 则 join（exec=2 / 返回 "waiting-work"） | 已改 |
| 新增（复审轮 #3，PBT） | Runner 种子化有限随机调度：mulberry32 LCG 驱动 8 个 seed × 6-9 操作（ensure/成功失败/慢速、cancel、shell）+ 种子化的 idle hook die 时点与慢通知窗口；断言调度排空后 runner 为 Idle、无悬挂通知、风暴后仍能接受并结算新 run（"不卡死"）。判别力：对 ad1e1bb052（pf 内无隔离 idle，会楔死的版本）2 轮全 RED——注意基座 d9d7de31fb 的 idle 在返回 action 里、pf 不 die，**不会**楔死，falsify 必须用 ad1e1bb052 | 已加: `test/effect/runner.pbt.test.ts` "join semantics, settlement, and idle-notification ordering hold under random schedules" |
| 新增（复审轮 #3，PBT） | latestRole 随机历史等价：seed 固定的 15 组合法历史（含空/仅 user/仅 assistant 边界、~234 条消息、时间戳小窗口高碰撞、乱序写入、62 条 JSON 内嵌时间与持久化列不一致），独立 oracle 重算 `(time_created, id)` 最大值，断言 `latestRole` 恒等。判别力：把 role 取反时 PBT 用例 RED（5 fail） | 已加: `test/session/messages-pagination.test.ts` "matches the (time_created, id) maximum on random histories" |
| 取舍（复审轮 #3） | PBT 以手写种子化 LCG 实现（§5.3 随机测试层），不引入 fast-check：为两个测试引入新框架依赖 + shrink 语义成本大于收益；有限序列 + 固定 seed + 失败输出轨迹已满足可复现性。不替代定向 RED/GREEN 回归（复审轮明确"PBT 是补充"） | 已按此实施 |

## 第七部分：代码更新清单

| 文件 | 函数 / 行号 | 改动概述 | 状态（修复后回填） |
|------|------------|---------|------------------|
| `packages/opencode/src/session/run-state.ts` | `runner` 内 `onIdle` | 去掉 `data.runners.delete(sessionID)`（改为 `status.set(sessionID, {type:"idle"})`）；注释记载"钩子必须按 sessionID 参数化、执行时现读"的不变量 | 已改: `ad1e1bb052` |
| `packages/opencode/src/effect/runner.ts` | `finishRun` Idle 分支 | `yield* idle` 移入 `modifyEffect` 的 pf 体内（临界区内）；返回的 action 只剩 `complete(done, exit)`。实现注记：`modifyEffect` 返回的 action 在信号量释放**之后**才执行（`Effect.flatten` 在 `withPermit` 之外），所以 idle 必须写在 pf 体内而非返回的 action 里——第一版写在 action 里被自己的 runner 级 RED 用例抓住（work-2 仍先于 onIdle-end）。review 轮追加：idle 通知经 `safeIdle`（`catchCause → logError`）隔离 defect——pf 内未隔离的 defect 会让状态不提交（ref 停留 Running）且 Deferred 永不完成，后续调用全部 join 死 run（review #1）；`shouldReArm` 同样经 catchCause fail-closed（决策点 2） | 已改: `ad1e1bb052`（safeIdle/finishShell/idleIfCurrent 部分：`ae462ca435`） |
| `packages/opencode/src/effect/runner.ts` | `finishShell` Shell 分支 | review 轮追加：idle 从返回 action 移入 pf 体内 + `safeIdle`——与 finishRun 同型（review 补充项，基座既有问题随本 PR 一并修复） | 已改: `ad1e1bb052`（safeIdle/finishShell/idleIfCurrent 部分：`ae462ca435`） |
| `packages/opencode/src/effect/runner.ts` | `idleIfCurrent`（cancel 路径） | review 轮追加：从 `modify` 返回 action 改为 `modifyEffect` pf 内 `safeIdle`，仅当状态已 Idle 才发（cancel 已提交 Idle、被中断 run 的 finishRun 对非 Running 早退，此处补发通知；若有新 run 先入则不发，避免迟到 idle 覆盖新 run 的 busy）（决策点 1） | 已改: `ad1e1bb052`（safeIdle/finishShell/idleIfCurrent 部分：`ae462ca435`） |
| `packages/opencode/src/session/message-v2.ts` | 新增 `latestRole` | 单行索引查询返回最新消息 role（`limit 1`，`desc(time_created), desc(id)`，与 `compareChronology` 同序）；空 session 返回 undefined | 已改: `ad1e1bb052`（safeIdle/finishShell/idleIfCurrent 部分：`ae462ca435`） |
| `packages/opencode/src/session/prompt.ts` | `hasUnconsumedTurn` | 谓词从 `filterCompactedEffect`（整表加载）换为 `MessageV2.latestRole(sessionID) === "user"`，fail-closed 语义不变 | 已改: `ad1e1bb052`（safeIdle/finishShell/idleIfCurrent 部分：`ae462ca435`） |
| `packages/opencode/src/session/prompt.ts` | `runLoop` | 新增 `ownAssistants: Set<MessageID>`（本循环创建的 assistant，落库前记入）；顶部守卫：`step > 0 ∧ lastAssistant 无 finish ∧ 属最新 turn ∧ 非本循环所创` → log warning + break。`step > 0` 豁免首迭代——shell 命令留下的无 finish assistant 由后续 loop 合法接管（"shell completion resumes queued loop callers" 用例抓住过首版误杀） | 已改: `ad1e1bb052`（safeIdle/finishShell/idleIfCurrent 部分：`ae462ca435`） |
| `packages/opencode/test/effect/runner.test.ts` | 新增 5 用例 | 原有 idle 转换先于排队者 work 启动 1 例；review 轮追加 defecting idle hook / defecting re-arm predicate / finishShell 顺序 / cancel 顺序 4 例 | 已加: `ad1e1bb052`（review 轮追加部分：`ae462ca435`） |
| `packages/opencode/test/session/run-state.test.ts` | 新增文件，3 用例 | 会话级 runner 串行契约 + 收尾窗口 idle 顺序（review 后重写）+ re-arm 双轮执行无中间 idle（复审轮 #1 再重写） | 已加: `ad1e1bb052`（review 轮 `ae462ca435`，复审轮重写随下一提交） |
| `packages/opencode/test/effect/runner.pbt.test.ts` | 新增文件，1 PBT 用例（复审轮 #3） | 种子化有限随机调度下的 join/结算/不卡死性质 | 已加: 随复审轮提交 |
| `packages/opencode/test/session/messages-pagination.test.ts` | 新增 6 用例 | latestRole 正确性 4 例 + 成本上界 1 例 + 随机历史等价 PBT 1 例（复审轮 #3） | 已加: `ad1e1bb052`（PBT 随复审轮提交） |
| `packages/opencode/script/validate-rearm-large-session.ts` | header 说明更正（复审轮 #2） | "runs the REAL prompt.loop"改为查询基准说明——脚本实际只做 fill + 两个谓词查询计时，full-loop 端到端由回归套件承担 | 已改: 随复审轮提交 |

## 第八部分：文档更新清单

| 文档路径 | 要改什么 | 状态（修复后回填） |
|---------|---------|------------------|
| `docs/fixes/session-runner-fix-idle-race.md`（#32 文档） | 追加"后记"节：指出其论证未覆盖 map 删除时机与锁持有时间，指向本文档 | 已改: `ad1e1bb052` |
| `docs/fixes/`（本文档） | 第六/七部分回填实际状态 | 已改（随本提交） |
| `CLAUDE.md` 已知限制与注意事项 | 回写教训：跨层资源生命周期（表删除）必须与状态转换同临界区，或干脆不删；临界区内谓词的长度是锁持有时间上界，随数据规模增长会把窄窗口放大成事故；泛型 Runner 钩子必须"执行时现读持久化状态"才可复用；`SynchronizedRef.modifyEffect` 返回的 action 在锁外执行 | 已改: `ae462ca435`（CLAUDE.md 在本仓库 gitignore 内，仅本地生效，教训已入行） |
| `docs/devlog/2026-10-28-session-run-idle-race-two-loops.md` | 新增开发日志（含度量段） | 已改: `ad1e1bb052` + review 轮 append `2b8850b9c3` |

> 本仓库尚无 Runner / SessionRunState 的契约文档（`docs/design/`、`docs/research/` 不存在）；本修复不改变 schema/枚举/对外 API。行为契约变更（会话级串行不变量显式化、runner 生命周期改为 process-lifetime、循环顶部守卫语义）以本文档第四部分为首次记载，issue #85 为分析底稿。

## 验证记录（Step 5）

基座：`dev` @ `d9d7de31fb`，分支 `fix/session-run-idle-race-85`。

- **RED 证据**（`git stash push -- src/session/run-state.ts src/effect/runner.ts` 后复跑）：
  - `test/effect/runner.test.ts` "runs the idle transition before a queued caller's work starts"：修复前 `idleEnd < work2` 断言失败（queued work 在 `onIdle-end` 之前启动，实测 order 为 `work-1, onIdle-start, work-2, onIdle-start, onIdle-end`）；修复后全绿。
  - `test/session/run-state.test.ts` "keeps one runner per session…"：修复前形态下（历史探针，map 丢失 runner 时）第三个 caller 立即在新 runner 上执行（exec=3、返回 "third"）；修复后 join（exec=2、返回 "waiting-work"）。注：本 harness 的 delete 落地时机依赖调度，对全预修复基线的复跑偶发为绿（delete 滞后到 run 收尾才落地，第三 caller 落在 join 窗口），该用例定位为**契约守卫**（锁死 join 语义与串行性），确定性 RED 由 runner 级用例承担。
- **定向（修复后全绿）**：`test/effect/` + `test/session/` 709 例（29 文件）701 pass / 7 skip / 0 fail；其中 prompt 套件 98 pass / 1 skip / 0 fail（含两处 shell+loop 交互用例，首版守卫误杀后被 `step > 0` 豁免修复）；runner 31、run-state 2（新）、message-v2 45、messages-pagination 60（含新 latestRole 5）。
- **typecheck**：删 `node_modules/.tsbuildinfo` 强制全量后 `bun run typecheck` 0 error。
- **其余套件**：`test/` 除 session/effect 外 8 fail —— cf-ai-gateway 4、McpOAuthCallback 1、HttpApi SDK 3（~21s 超时形态）。与基线对照：对 `HttpApi SDK` 套件做了修复前/后各一次隔离复跑（14 pass / 4 fail vs 14 pass / 4 fail，失败名单一致），cf-ai-gateway 与 McpOAuthCallback 与 #32 修复时记录的基线失败集同名——均为既有环境性失败，非本修复引入。
- 环境注记：HttpApi SDK 的 4 个超时失败在共享机负载下波动（全量跑 3 fail、隔离跑 4 fail、名单逐名一致），归因按"与基线同名"处理，未逐例深挖。

### review 轮验证（PR #89 review 后追加，2026-10-29）

- **RED 证据**（`git stash push -- src/effect/runner.ts` 后，pre-fix = PR head `ad1e1bb052`，3 轮全 RED）：
  - "survives a defecting idle hook…"：2004ms 超时——pf 内 defect 使状态不提交，第二次 `ensureRunning` 永久 join 死 Deferred（review #1 的复现）。
  - "survives a defecting re-arm predicate…"：2003ms 超时，同机制。
  - "completes the shell idle transition…"：实测序 `work → onIdle-end`（迟到的 shell idle 落在新 work 之后）。
  - "completes the cancel idle transition…"：cancel 在途时排队，实测序 `work → onIdle-end`。**注意**：cancel 与下一次调用顺序执行（无并发排队）时该用例不 RED——顺序场景下 post-lock action 天然先完成、下一次调用的 acquire 晚于它（探针实测 pre-fix 序 `onIdle-start, onIdle-end, work`）；RED 必须 cancel fork 后、提交完成前并发排队。
  - run-state 级 "publishes idle status before a queued writer…"：pre-fix 下不 RED（探针实测 pre-fix 序为 `work2-start, work2-busy-set, work2-read=busy`——post-lock onIdle 的续跑先于排队者 acquire 完成，busy 后到覆盖 stale idle，会话级 status 断言在本 harness 调度下对该交错不敏感）。定位为**契约守卫**，与 join 语义用例同为会话级守卫；确定性 RED 由上述 runner 级用例承担。重写点（review #2）：原版仅一次 ensureRunning、`watching` 残留未读、`events===["idle"]` 锚的是新 session 的默认 idle——修复前后皆绿、零判别力。
- **GREEN**：修复后 runner 35（31+4）0 fail ×3、run-state 3（重写 1 + 新增 1 + 既有 join 用例）0 fail ×3；typecheck 0 error。
- **顺带发现（非本修复引入）**：`messages-pagination` 的 "stays fast on a large session" 在裸 `bun test` 下必超时——bun 默认用例超时 5s，而 package script（CI 路径）带 `--timeout 30000`。2000 行 fill + 查询在共享机负载下 >5s，30s 上限内稳定通过（CI 与 `bun run test` 均绿）。裸 `bun test <file>` 的 5s 默认值与本用例的 fill 成本不匹配，与修复无关。

### 复审轮验证（PR #89 复审后追加，2026-10-30）

- **re-arm 测试重写（复审 #1）**：复审指出的缺陷成立——首版把 `firstExecution` 在 work 体内先翻转，谓词读到的是翻转后的值，首次 finish 即返回 false，**从未 re-arm**（reviewer 隔离副本加 `executions===2` 实测 1）。重写后谓词从谓词侧翻转（首轮 true 次轮 false），第二次 execution 用 Deferred 挂住观测窗口。判别力：谓词恒 false（无 re-arm）时 `executions===2` 失败（sed 副本实测 fail）；修复后 3 轮全绿。
- **PBT falsify（复审 #3）**：
  - Runner 调度 PBT 对 **ad1e1bb052**（pf 内无隔离 idle 的楔死版本）2 轮全 RED；对**基座 d9d7de31fb 不 RED**——基座的 idle 在返回 action 里，pf 不 die，不会楔死（reviewer 自己的表格同样记录 base→可恢复）。falsify 时必须 checkout ad1e1bb052 的文件版本而非 stash（stash 回退到的是当前 HEAD）。
  - latestRole 等价 PBT：把 role 取反（sed 副本）后 5 fail；restore 后 61 pass。种子分布实测：234 条消息、62 条 JSON 时间与持久化列不一致。
- **全套定向**：`test/effect/`（runner 35 + PBT 1）+ `test/session/`（run-state 3 + messages-pagination 61 + 其余）修复后全绿；typecheck 0 error。

## 端到端验证（补充）

- **`test:httpapi` 三段门禁**（server + SDK 全链路，209 场景 × 3 模式）：coverage **209/0**、auth **209/0**、effect **209/0**（effect 段在本共享机需 >590s，首次被外层超时截断后单独复跑完成）。
- **大会话查询基准**（`script/validate-rearm-large-session.ts`，一次性基准脚本，真 SQLite + tmpdir instance，20,000 条消息实写）。**注意范围**：这是**查询基准**，不是 full-loop 端到端验证——脚本实测的是新旧两个谓词查询在同一大会话上的耗时；runLoop/finishRun 的端到端行为由 runner/run-state 回归套件覆盖（review 轮 #2 曾指出脚本 header 误称"runs the REAL prompt.loop"，已改为查询基准说明）：

  | 指标 | 实测 |
  |---|---|
  | 旧谓词（`filterCompactedEffect` 整表加载） | **1,342ms** |
  | 新谓词（`MessageV2.latestRole` 单行查询） | **2.0ms** |
  | 差距 | ~670× |

  与事故画像吻合：22k 消息的会话旧谓词在 finishRun 临界区内持有锁数秒；新谓词毫秒级。脚本为一次性验证件，未纳入常规套件（fill 20k 需 ~19s，不适合作单测）。（reviewer 独立复测：2,264ms → 2.285ms，同数量级。）
