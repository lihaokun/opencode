# 修正方案 — 子 Agent 只在初始委托结束时通知父亲，之后的每一次停机都无人知晓

- 模块：`agent-management` / `lifecycle`（委托结局通知），`session` / `prompt`（run 循环）
- 分类：§7 step 2 第二类（设计缺陷：通知绑在"委托 job"上，而父亲关心的是"子的 run"）
- 状态：已实施（待提交）

## 第一部分：现象与复现

**现象**：一个长期存活、被父亲反复用 `agent_send` 追加任务的子 agent，在某一轮把输出预算
耗尽（`finish === "length"`）后停机，父亲**没有收到任何消息**。父亲此后一直以为它还在干活，
直到用户自己去看子会话才发现它早就死了。

**实测时间线**（取自一个真实实例，父会话下的一个 worker）：

| 轮次 | 触发 | 结束方式 | 父亲是否得知 |
|---|---|---|---|
| 1 | `agent` 初始委托 | 正常停机 | ✅ 收到 `Agent completed` |
| 2–28 | 父亲 `agent_send` | 正常停机 | ❌ 无任何通知（子用 `agent_send` 回话时父亲才知道） |
| 29 | 父亲 `agent_send` | **`finish=length` 失败** | ❌ **静默** |

**复现条件**：子 agent 的任何一次**非初始**run 以失败结束（输出超长、provider 错误、工具错误）。
必现。正常结束的非初始 run 同样不通知，只是子通常会主动 `agent_send` 回话，掩盖了这一点。

**最小复现**（已固化为第六部分 R1）：父 P 创建子 C（`notify: true`）；C 第一次 run 正常结束；
P 对 C `agent_send`；C 第二次 run 以 `length` 结束。预期 P 收到 `Agent failed: …`；实际 P 什么都收不到。

**出错代码路径**

- `packages/opencode/src/agent-management/lifecycle.ts:237` `startDelegation`
  → `background.start({ run })`，`run` = 一次 `ops.prompt(...)` + `classify`
  → `background.wait({ id })` **只等这一个 job** → `inject(completed | error)`
- `lifecycle.ts:229` 的注释写明了这一设计："The one place an outcome is delivered automatically.
  A delegation is a task the creator handed out and is waiting on; a later message is not,
  which is why agent_send produces nothing."
- 第 2 次起的 run 由 `agent_send` → `deliverAsync` → `SessionPrompt.prompt` 直接驱动，
  **不经过任何 job**，因此没有人在等它的结果。

**预期 vs 实际**：预期"子 agent 停机，父亲就知道（含怎么停的）"；实际"只有第一次停机父亲知道"。

## 第二部分：根因分析

**症状**是失败静默；**根因是通知的触发点选错了对象**。

通知绑在 `BackgroundJob` 上，而 job 的生命周期 = 初始委托的**第一次 run**。
这个绑定在设计时是有意的（架构 §3："自动结局交付：只有 agent 的初始委托有"），前提是
"后续消息不是任务，`agent_send` 不产生结局"。实测推翻了这个前提：父亲就是用 `agent_send`
给子派后续任务的（29 轮里 28 轮），每一轮对父亲都是一个结局。

第二层原因：`agent_send` 的描述承诺 *"The recipient does not reply automatically"*，这句话在
父→子方向上把"子停机了"和"子回话了"混成一件事。子回话是子的一次 tool use；子停机是 runtime
的事实。前者由子决定，后者不该由子决定——尤其子死于 `length` 时根本没有机会回话。

曾考虑**打补丁**：保留 job 通知，再给 `agent_send` 驱动的 run 加一条"子没回话才通知"的规则。
否决（用户："这个规则太复杂了"）：它要判定"这一轮子有没有回话"，而回话和停机是两个独立事件，
一轮里先回话再死掉照样静默；且两套机制并存，`settled` 账本会有两处来源。

本方案**消除根因**：把通知从"job 结算"移到"子的 run 结束"，初始委托与后续 run 走**同一条路**。

## 第三部分：参考实现对照

不适用（非算法类）。代之以对自身契约的对照：

- `AGENT_DESCRIPTION`（`tool/agent.ts:65`）承诺 *"Its result arrives later as a message in your
  conversation"*——没有限定"只有第一次"。本方案让代码兑现这句话。
- `agent_stop` 已经在**每次**取消时向调用者发一条 cancelled 通知（`lifecycle.ts:501`），不区分
  第几次 run。停机通知与取消通知在"每次都发"上对齐。
- Claude Code 的子 agent 为一次性（结束即返回结果）；我们的子是长驻的，因此"结束"必须按 run
  计数而非按 agent 计数，这是两者的本质差别，不能照抄。

## 第四部分：修复方案

### 规则

> **子 agent 停机就通知它的父亲**：completed 或 failed 各一条；cancelled 不发（`agent_stop` 自己发）。
> "停机"= 一次 run 结束、runner 不会立刻再起一次、且它自己派出去的 agent 没有还在跑的。对第几次 run、由谁触发（`agent`、父亲的 `agent_send`、兄弟的
> `agent_send`）一视同仁。

只对带 `notify` 的子生效：command-subtask 的子（`notifyOnFinish: false`，`prompt.ts:407`）
由调用方自己 `background.wait`，不进这条路。

### 机制：钩在 run 的 work 上，而不是订阅 idle 事件

最初与用户讨论时的方案是"在 `SessionPrompt` 层订阅 `session.status` idle 事件"。实施前核对发现
**idle 不等于 run 结束**：`processor.ts:774/796/809/929` 在出错路径会各自 `status.set(idle)`，
之后 runner 的 `onIdle` 再发一次——同一次 run 可以发出两次 idle；而 `run-state.ts:86` 对一个
不在跑的会话 `cancel` 也会发 idle。按事件做就得加去重状态。

改为**直接包住 run 的 work**。`SessionPrompt.loop` 把 `runLoop(sessionID)` 交给
`state.ensureRunning`；runner 对一次 run 恰好执行一次 work（re-arm 时重新执行同一个 work，
那本来就是下一次 run），多个并发调用方只是 join 同一个 `done`。所以在 work 上挂
`Effect.onExit` 就是"每次 run 结束恰好一次"，不需要任何去重，也不依赖事件顺序：

```ts
// session/prompt.ts — loop
const session = yield* sessions.get(input.sessionID)
const parentID = session.parentID
const work =
  parentID && session.metadata?.[METADATA_AGENT_NOTIFY] === true
    ? runLoop(input.sessionID).pipe(Effect.onExit((exit) => reportRunEnd(session, parentID, exit)))
    : runLoop(input.sessionID)
return yield* state.ensureRunning(input.sessionID, lastAssistant(input.sessionID), work, hasUnconsumedTurn(input.sessionID))
```

`reportRunEnd` 把 exit 收敛成既有的 `AgentDelegation.Outcome`：

| exit | outcome |
|---|---|
| success | `AgentDelegation.classify(result, child, limits)`（原封不动复用，`length` → failed，`MessageAbortedError` → cancelled） |
| 只含 interrupt 的 failure（`agent_stop` / 用户取消） | cancelled |
| 其他 failure（runLoop 内部 defect） | failed，文本 `formatSubagentFailure(Cause.pretty)`（对应旧路径 job `error`） |

然后：

- **子并没有停**（success exit 且 `hasUnconsumedTurn` 为真，即消息落在最后一次迭代之后、runner 马上
  re-arm 下一次 run，#32 窗口）→ 什么都不做，下一次 run 结束再报。用的是 runner 自己的判定，在它之前一刻读；
  两次读之间才到的消息只会让下一次 run 也报一次，不会漏报；
- cancelled → 只发 `agent.delegation settled`，不投递（与旧 `wait` 的 cancelled 分支一致）；
- **子自己的 agent 还有在跑的**（任一后代 busy，或有 running 的 job 其 parent 在后代集合里——job 由 agent 工具
  同步注册而 busy 要晚几个 tick 才置位）→ 不报也不结账，等那个后代报告把子唤醒、子再次停下时报。
  这是 Claude Code 的同一条规则（"stops with no live background children of its own"）；
- completed / failed → **fork** 一条投递：重读父的 agent / model / variant，`prompt(父, 合成消息)`，
  消息体与 metadata **与旧 `inject` 完全一致**（`renderOutput` + `{kind, summary}`），
  投递结束后 `ensuring` 发 `settled`。投递失败只记日志，账本照常结清。

fork 而非在子的 fiber 里等：旧 `inject` 也是在独立 fiber 里 await 父的整次 run；若改成在子的
work 里等，子会在父跑完之前一直 busy，花名册会把一个已经停机的子列成 running。

### 为什么钩子在 `session/prompt.ts` 而不是 `agent-management`

通知要调 `SessionPrompt.prompt`，而 `agent-management` 不能依赖 `SessionPrompt`（循环：
`SessionPrompt` 经 `ToolRegistry` 到达 `AgentLifecycle`，这正是 `ops` 要经 `ctx.extra` 注入的
原因，见 `schema.ts:197` 注释）。`prompt.ts` 已经 import `AgentTree` / `AgentStatusProjection`，
再 import 纯函数模块 `AgentDelegation` 与常量模块 `AgentManagement` 方向一致。

### 子会话要多记两样：description 与 notify

钩子在 `prompt.ts` 里只有 `Session.Info`，而 summary 要 `Agent completed: <description>`，
skip 与否要 `notify`。两者此前都只在 `startDelegation` 的闭包里。新增两个 session metadata 键
（旁边已有 `agentName` / `agentWorkdir`）：

- `agentDescription: string` — 原始 description（`title` 带 ` (@type subagent)` 后缀，不能直接用）。
  上一次修复（花名册）曾否决为这个目的加字段，理由是"只为观感"；这次它是**正确性**所需——summary
  是 TUI 一行提示的全部内容（`agentmgmt-1` 子计划 I2），后缀会出现在用户眼前。
- `agentNotify: boolean` — 显式 opt-in。**不**用"有 parentID 就通知"：旧库里可能存在其他来源的
  子会话；也**不**用"缺键视为 true"：升级前创建、仍在跑的子没有这个键，而它们的旧 waiter 在重启后
  本来也不存在，两边一致地不通知。

作用域正好是一次委派（= 一个子会话），与 `lifecycle.ts:290` 注释里"不能走 Effect Context，否则
孙也继承 false"的论证同构，且比参数传递更稳：它跟着会话落库，不随哪条调用链走。

### 账本（`agent.delegation`）怎么变

| 事件 | 旧 | 新 |
|---|---|---|
| `started` | `startDelegation` 注册时同步发（`notify` 时） | **不变**。必须同步：工具一返回父亲就可能 idle，`opencode run` 在"全体 idle 且无欠账"时退出，账要在那之前记上 |
| `settled` | `background.wait` 之后、`inject` 投递完才发 | 由钩子发，**每次 run 结束一次**，仍在投递完之后 |

`cli/cmd/run.ts:924` 用 `Set` 记账，多发的 `settled` 对空集是 no-op；初始委托的 started/settled
配对语义不变。非初始 run 不发 `started`（没有同步点可发），与现状相同——`run` 命令对 `agent_send`
驱动的交接本来就不记账，不在本次范围。

### `startDelegation` 剩下什么

`background.start({ run })` 保留（`agent_list` 状态、`agent_stop` 取消、command-subtask 的
`wait` 都靠它）；`if (notify) publish started` 保留；**`background.wait` 块与 `inject` 整体删除**。
`notify` 参数保留，只为 `started`。

### 用户可见文案

`agent_send` 的两处 *"The recipient does not reply automatically"*（`tool/agent.ts:85`、`:313`）
改为区分：发给自己的子 agent 时，它这一轮 run 结束你会收到通知（和它任何一次 run 一样）；
发给其他人则无自动回复。

### 修复后的预期行为（走第一部分的时间线）

| 轮次 | 结束方式 | 父亲收到 |
|---|---|---|
| 1 | 正常 | `Agent completed: <desc>`（不变） |
| 2–28 | 正常 | 每轮一条 `Agent completed: <desc>`，正文是该轮最后一段可见文本 |
| 29 | `length` | **`Agent failed: <desc>`**，正文为 `MessageOutputLengthError` 格式（与初始委托失败时一字不差） |

父亲收到的消息变多（每轮一条而非一条）。用户已接受："正常允许不会在发完消息后立即停止，
因为发消息是一轮 tool use"——子回话之后通常还会继续干活，回话与停机不在同一轮。

### 考虑过并否决的方案

**A. 订阅 idle 事件 + 去重。** 否决，见上：idle 与 run 结束不是一一对应，去重引入状态。

**B. 保留 job 通知，为 `agent_send` 驱动的 run 加例外规则。** 否决（用户），见第二部分。

**C. 让 `agent_send` 也起一个 job。** 否决：job 的 id 是子 SessionID（`agent_list` / `agent_stop`
依赖这一约定），一个子同时只能有一个 job；而 `agent_send` 可以在子忙时发出（join 当前 run）。

## 第五部分：正确性论证

1. **根因消除**：根因是通知的触发点是"job 结算"而父亲关心的是"run 结束"。修复把触发点
   移到 run 的 work 上，job 不再承担通知职责。初始委托的那次 run 和后续每次 run 经过同一个
   `loop` → 同一个钩子，不存在第二条路径，也就不存在"哪条路径漏了"的问题。

2. **不变量保持**：
   - **只在子真正停下时报**：re-arm（runner 自己的判定）与"后代还在跑"两种情况都不算停；后代结束必向子报告
     （本规则递归成立），子因此必被唤醒并再次停下，通知只是推迟，不会丢。已知空档：孙被用户从 TUI 中止
     （不经 `agent_stop`）时没有人唤醒子，父要等下一次有人唤醒子才收到；补丁前子同样不会被唤醒，非回归。
   - **每次 run 结束恰好一次**：`Runner.startRun` 对每次 run 执行一次 `work`（`runner.ts`），
     `Effect.onExit` 随 work 恰好触发一次；re-arm 重新执行 work（`finishRun` 的 `startRun(work, fresh)`）
     是下一次 run，再触发一次正是所需。join 的调用方只共享 `done`，不重复执行 work。
   - **通知形状不变**：`renderOutput` 调用、`metadata: {kind, summary}`、summary 措辞、
     "重读父的身份、不回退到子的 agent"三条规则逐字搬到 `reportRunEnd`；TUI（`index.tsx:2686`）
     与 `agentmgmt-1` 子计划的契约不受影响。
   - **cancelled 静默**：`classify` 的 `MessageAbortedError` 分支与 interrupt-only exit 都收敛为
     cancelled，钩子只发 `settled`；`agent_stop` 的取消通知仍是唯一来源，不会双份。
   - **账本 `started ⇒ 最终 settled`**：`started` 仍同步发；每次 run 结束都发 `settled`
     （含 cancelled 与投递失败——`ensuring`），且在投递之后，故 `run` 命令"全体 idle 且无欠账 ⇒
     结果已到父处"的推理仍成立。
   - **command-subtask 仍只收一条**：其子 `agentNotify: false`，钩子整体跳过，`handleSubtask`
     继续 `background.wait` 同一个 job（`prompt.ts:455-480` 不动）。
   - **子不因通知而 busy**：投递 fork 到层 scope，子的 work 立即返回，`finishRun` 随即置 idle。
   - **依赖方向**：`prompt.ts` → `agent-management/{delegation,schema}` 均为纯模块，无层依赖，
     与既有 `AgentTree` / `AgentStatusProjection` import 同向。

3. **无回归引入**：
   - `startDelegation` 删除的代码块只做"等 job → inject → settled"，其职责全部由钩子接管；
     `background.start` 与 `started` 保留，`agent_list` / `agent_stop` / command-subtask 不受影响。
   - 既有 e2e（`run-process.test.ts` 嵌套树用例）里中层 A 的第二次 run 现在也会通知 root，root 多跑
     一轮；断言的是 `root done` 出现与 exit 0，仍成立；实际跑通见第六部分。
   - 不带 `agentNotify` 的会话（根会话、历史子会话、command-subtask 的子）行为与修复前完全相同。

## 第六部分：测试用例清单

| 类型 | 用例 | 状态 |
|---|---|---|
| 回归 R1 | 子第二次 run 以 `length` 结束 ⇒ 父收到 `Agent failed: <desc>` 且正文含 `MessageOutputLengthError`（第一部分复现） | 已加 `prompt.test.ts` "a later run that dies of length still reports to the parent" |
| 回归 R2 | 子第二次 run 正常结束 ⇒ 父收到第二条 `Agent completed` | 已加 "every run end reports, not only the first" |
| 迁移 M1 | completed 通知 part 带 `{kind, summary: "Agent completed: <desc>"}` 且正文 `<agent id=…>`（原 lifecycle 测试） | 已迁至 `prompt.test.ts` |
| 迁移 M2 | failed 通知 summary 为 `Agent failed: <desc>`（原 lifecycle 测试） | 合并进 R1 |
| 迁移 M3 | 通知不把父切到子的 agent（父 `agent` 保持 undefined）（原 lifecycle 测试） | 已迁 |
| 迁移 M4 | 投递时重读父的身份：父在子运行中改 variant，通知消息带新 variant（原 lifecycle 测试） | 已迁 |
| 新增 N1 | 子被取消（interrupt）⇒ 不投递、但发 `settled` | 已加 |
| 新增 N4 | 消息落在 #32 re-arm 窗口 ⇒ 第一次 run 收尾不报，子真正停下时报一次 | 已加 "says nothing when the child is about to run again" |
| 新增 N5 | 子停下时孙还 busy ⇒ 不报不结账；孙的报告唤醒子、子再停 ⇒ 报一次、settled 一次 | 已加 "waits for the child's own agents before reporting" |
| 新增 N2 | 子无 `agentNotify`（command-subtask / 历史会话）⇒ 不投递、不发 `settled` | 已加 |
| 新增 N3 | `create` 落库 `agentDescription` / `agentNotify`，`notify: false` 时为 false | 已加 `lifecycle.test.ts` |
| 既有 | `run-process.test.ts` 父子 / 嵌套树 / 失败渲染用例 | 跑通（见 PR） |
| 既有 | `lifecycle.test.ts` 其余用例、`event-manifest.test.ts`、TUI 通知渲染测试 | 跑通 |

## 第七部分：代码更新清单

| 文件 | 位置 | 改动 | 状态 |
|---|---|---|---|
| `packages/opencode/src/agent-management/schema.ts` | 常量区 | 新增 `METADATA_AGENT_DESCRIPTION` / `METADATA_AGENT_NOTIFY`；`NOTIFICATION_METADATA_KIND` 注释改掉 `inject()` | 已改 |
| `packages/opencode/src/agent-management/lifecycle.ts` | `create` 的 `sessions.create` metadata | 写入两个新键 | 已改 |
| 同上 | `startDelegation` | 删除 `background.wait` 块与 `inject`；重写函数注释 | 已改 |
| `packages/opencode/src/session/prompt.ts` | `loop` | 对 `agentNotify` 子会话包 `Effect.onExit` | 已改 |
| 同上 | 新增 `reportRunEnd` | exit → outcome → fork 投递 → `settled` | 已改 |
| `packages/opencode/src/tool/agent.ts` | `agent_send` 两处文案 | 父→子方向会在 run 结束收到通知 | 已改 |
| `packages/schema/src/agent-event.ts` | `Delegation` 注释 | `settled` 每次 run 结束发一次，由子自己的 run 报告 | 已改 |
| `packages/opencode/test/session/prompt.test.ts` | 新 describe | R1 / R2 / M1–M4 / N1 / N2 | 已改 |
| `packages/opencode/test/agent-management/lifecycle.test.ts` | "delegation notice" describe | 删除 4 个迁走的用例；加 N3 | 已改 |
| `packages/opencode/test/tool/__snapshots__/parameters.test.ts.snap` | `agent_send` 描述 | 快照不含该文案，`parameters.test.ts` 不改即过 | 无需改 |

## 第八部分：文档更新清单

| 文档 | 要改什么 | 状态 |
|---|---|---|
| `docs/design/agent-management/architecture.md` | §3 "自动结局交付：只有 agent 的初始委托有" 改为"每次 run 结束"；§6 账本一节 `settled` 的来源与次数 | 已改 |
| `docs/design/agent-management/detailed-design.md` | §5.4.4 `startDelegation`：去掉 watcher / inject，指向 `SessionPrompt.reportRunEnd`；"至多一次"改为"每次 run 至多一次"；§5.4.9 不变 | 已改 |
| `docs/design/agent-management/subplans/agentmgmt-1-tui-subagent-surface.md` | 4.1 / 5.1.1 中 `inject()` 的写入方改为 `reportRunEnd`，字段与措辞不变 | 已改 |
| `docs/design/agent-management/task-inventory.md` | 6.x 行关于 `inject` 的"保留"记录加一行后记 | 已改 |
