# 修正方案 — session-runner：结束判定与转 idle 不原子，注入消息可能无人消费

> 对应 issue #32（lihaokun/opencode）。本文档按 workflow §7.1 八部分组织；第一至五部分修复前完成，第六至八部分修复前列计划、修复后回填。

## 第一部分：现象与复现

### 现象

后台 subagent 完成后，父 Session 有时不消费其完成通知——通知消息已落库，但没有任何执行去读它，直到下一次外部触发（用户再发消息）才和新消息一起被处理。子 Agent 相对父 Agent 结束得越快，越容易复现。

用户手动输入也可能撞上同一窗口，但概率低且用户可察觉（`prompt` 返回的是上一轮的 assistant 消息）后自行重发，实际报告集中于注入路径。

### 最小复现用例

竞态窗口无法用纯同步序列确定性复现，复现以测试夹具控制时点（见第六部分）：

1. `llm.push(reply().wait(release).text("partial").contentFilter().item())` 使第 1 次 provider 请求的响应尾部挂起，且以 **content-filter 结尾**——此刻 runLoop 已完成该轮开头的消息快照读取（最后一次读），阻塞在 `handle.process` 内，且该轮将以迭代内 break 结束、**不再有下一轮重读**
2. 直接向 Session 写入一条 user 消息（模拟 `tool/task.ts` 的 `inject` 路径：只落库，等 run 结束窗口）
3. 释放 hold，让第 1 轮以 content-filter break 收尾

> 复现必须选迭代内直接 break 的路径：若以正常 stop 结尾，processor 返回 continue、循环自行再走一轮并在开头重读消息，注入被"顺便"消费，测试修复前后都绿（假绿，见 devlog 教训）。

预期：run 结束时检测到未消费消息并重整一轮，第 2 次 provider 请求消费该消息。
实际（修复前）：run 用过期快照判定退出并转 idle；写入方的 `ensureRunning` 只会 join 在途 run，**传入的 work 被丢弃**——第 2 次 provider 请求永不发生，消息悬置。

### 出错代码路径

- `packages/opencode/src/session/prompt.ts:1094` — runLoop 每轮开头读消息快照（R）
- `packages/opencode/src/session/prompt.ts:1126-1144` — 用该快照判定退出（E），R→E 之间无挂起点
- `packages/opencode/src/session/prompt.ts:1391-1392` — break 后仍有 prune fork、返回值读取，之后 work 完成
- `packages/opencode/src/effect/runner.ts:76-106` — `finishRun`（`Effect.onExit` 触发）经 `SynchronizedRef.modify` 转 Idle——与 E 之间隔着多个异步边界
- `packages/opencode/src/effect/runner.ts:145-172` — 写入方 `ensureRunning` 的 `case "Running"` 分支 `return [awaitDone(st.run.done), st]`：join 并**丢弃传入 work**
- 注入写入方：`packages/opencode/src/tool/task.ts:227-254`（`inject` → `ops.prompt` → `createUserMessage` → `loop` → `ensureRunning`）

### 预期行为 vs 实际行为

- 预期：消息落库后，要么当轮读到并继续处理，要么 run 收尾时发现未消费并再跑一轮，要么写入方看到 idle 新起一轮——三者必居其一，消息不被悬置
- 实际（修复前）：落库落在"最后一次读"与"置 Idle"之间时，三个分支都不接管

时序表（T = 消息落库时刻）：

| T 的位置 | 修复前 | 修复后 |
|---|---|---|
| T < 最后一次读 | 当轮读到，继续处理 ✅ | 不变 ✅ |
| 最后一次读 < T < 置 Idle | 过期快照判定退出；写入方 join 丢 work ❌ | finishRun 临界区内重读持久化状态 → 重整一轮消费 ✅ |
| T > 置 Idle | 写入方看到 idle，新起一轮 ✅ | 不变 ✅ |

## 第二部分：根因分析

**症状**：注入消息悬置，等下一次外部触发。

**根因**：「还有没有未处理消息」的判定（E，用内存快照）与「转为 idle」的状态转换（`finishRun` 的 `SynchronizedRef` 临界区）被拆在两层，中间隔着 work 完成、`Effect.onExit`、ref 排队数个异步边界。判定所依据的快照在转换时刻已过期，而 `ensureRunning` 的 join 分支假定"在途 run 会消费后续消息"——该假定在窗口内不成立。

之所以拆成两层，是因为 `Runner` 是泛型的（对任意 `work` 工作，不知道"消息"为何物），而"未处理消息"只存在于 Session 侧的 runLoop。

**对照**：V2 的 `SessionRunCoordinator.settle`（`packages/core/src/session/run-coordinator.ts:51-58`）把 `pendingWake` 检查与 `active.delete` 放在同一同步块，守卫为 `Exit.isSuccess(exit) && !entry.stopping`。V1 无法照搬标志位方案：V1 的信号是持久化的消息行而非瞬时事件，且存在不经过 `ensureRunning` 的写入方。**本修复消除根因**（把判定搬进转换所在的临界区、以持久化状态为据），不是绕过。

**竞态的一般形式**：不只 R→Idle 窗口。凡在 runLoop 最后一次读之后到达的消息——包括 run 中途、长流式期间 join 的并发 prompt——都依赖同一个过期快照退出。把判定改为"退出最后一刻重读持久化状态"后，一般形式一并修复。

## 第三部分：参考实现对照

按 CLAUDE.md 参考实现要求，对照同仓库内的 V2 实现（同一问题域的既有正确解）：

`packages/core/src/session/run-coordinator.ts:42-58`：

```ts
Effect.onExit((exit) => Effect.sync(() => settle(key, entry, exit))),
const settle = (key, entry, exit) => {
  if (Exit.isSuccess(exit) && !entry.stopping && entry.pendingWake) {
    entry.pendingWake = false
    ...
    const successor = entry.pendingWake ? makeEntry() : undefined
    ...
  }
}
```

逐步对比出错路径上的差异：

| 维度 | V2 `settle`（正确） | V1（出错路径） |
|---|---|---|
| 判定与转换的相对位置 | 同一同步块 | 判定在 fiber 内（早），转换在 `onExit` + ref 临界区（晚） |
| 判定依据 | `entry.pendingWake`，在转换时刻仍有效 | 内存快照，转换时刻已过期 |
| 守卫 | `Exit.isSuccess(exit) && !entry.stopping` | 无（转换无条件发生） |
| 重整方式 | `makeEntry()` 重启 run | 无 |

差异点即根因：V1 缺少"转换时刻的判定"与"守卫"。确认 V2 的 `wake`（`run-coordinator.ts:85` 附近）不依赖写入方加锁——写入方只置标志，竞态消除发生在结算侧；V1 的等价物是结算侧重读持久化状态（连写入方置标志都不需要）。

## 第四部分：修复方案

### 修什么

1. **`packages/opencode/src/effect/runner.ts`** — `Runner.make` opts 增加可选 `shouldReArm?: Effect.Effect<boolean>`；`finishRun` 从 `SynchronizedRef.modify` 改为 `modifyEffect`（`start`/`ensureRunning`/`finishShell` 已在用该形式），临界区内逻辑：
   - `st._tag !== "Running" || st.run.id !== id` → 维持现状（仅 `complete(done, exit)`，状态不动）
   - `shouldReArm && Exit.isSuccess(exit)` 且 `yield* shouldReArm` 为真 → 旧 `done` 照常 complete（join 的写入方拿旧结果，不挂起），`startRun(work, 新 Deferred)` 重启同一 work，状态保持 `Running`
   - 否则 → 维持现状（`idle` + `complete(done, exit)`，转 Idle）
   
   结构与 `finishShell` 的 `ShellThenRun` 分支（现有 `runner.ts:129`，临界区内 `yield* startRun`）同构。
2. **`packages/opencode/src/session/run-state.ts`** — `ensureRunning` / `startShell` / 内部 `runner()` 增加可选 `shouldReArm` 参数并传入 `Runner.make`（与既有 `onInterrupt` 同样的穿透方式）。
3. **`packages/opencode/src/session/prompt.ts`** — 构造谓词：`MessageV2.filterCompactedEffect` → `MessageV2.latest` → `user && (!assistant || compareChronology(user, assistant) > 0)`；错误 fail-closed（catch 成 `false`，保持修复前悬置语义并告警日志）；在 `loop()` 与 `shell()` 传入。
4. **`packages/opencode/src/session/message-v2.ts`** — 无改动：dev 基座已有导出的 `compareChronology`，谓词直接复用。（若在 empty-tool-calls 基座实施，其 `latest()` 用私有 `isAfter`，则需先导出。）

### 为什么这样修（根因如何被消除）

判定从"读过期快照"改为"转换临界区内重读持久化状态"。此后对任意写入方（含不调 `ensureRunning` 的写入方），在消息落库之后发生的每次 Idle 决策都能看到该消息：要么临界区内读到并重整，要么写入方随后看到 Idle 新起一轮。两种交错穷尽了写入方 `ensureRunning` 与 `finishRun` 临界区在 `SynchronizedRef` 上的全序，消息不再有无人接管的交错（论证见第五部分）。

写入方不参与加锁、不置标志——V1 的信号本就是持久化消息行，现读现判，不需要 V2 式瞬时标志及其生命周期管理。

### 关键取舍

- **谓词取窄判据 `user && (!assistant || compareChronology(user, assistant) > 0)`**（issue 提议），而非完整复刻退出条件的否定。成功退出但末条 assistant 无 `finish` 的状态（compaction stop、processor stop 等既有 break 路径）下，宽判据会重整并触发多余的 provider 请求；窄判据在这些状态为假，行为与修复前一致。代价：上述状态下新到消息仍等外部触发（与修复前相同，不属本 bug 的回归范围，已在第六部分列观察用例）。
- **错误 fail-closed**：谓词内 DB 读失败按"无未处理消息"处理，退化到修复前行为，不把失败引入 `Runner` 泛型层（钩子类型保持无错误通道）。
- **守卫合流**：中断即 interrupt-only failure，`Exit.isSuccess(exit)` 单条件同时覆盖"中断不复活"与"失败不重整循环"两条守卫（对应 V2 的 `isSuccess && !stopping`）。
- **重启的是当前 run 的 work**：join 方传入的 work 仍被丢弃（不变），但 Session 侧 work 即 `runLoop` 的 description，重执行即从持久化状态消费——对 Session 语义两者等价，且这是泛型 Runner 上唯一不自欺的选择（Runner 不知道 join 方 work 的存在）。

### 修改后的预期行为

按第一部分复现序列走修复后逻辑：hold 释放 → 第 1 轮 content-filter → 迭代内 break → `finishRun` 临界区：`st` 匹配、exit 成功、谓词读到 injected（`compareChronology(user, assistant) > 0` 为真）→ 旧 done complete（等待 `prompt.loop` 的 fiber 以第 1 轮结果返回）→ 重启 runLoop → 第 2 次 provider 请求 → assistant(`parentID=injected.id`) 落库 → 下一轮迭代退出条件成立 → break → 临界区谓词为假 → Idle。消息被消费，且无第三次空转请求。

## 第五部分：正确性论证

**1. 根因消除**：见第四部分。判定与转换合并进同一 `SynchronizedRef.modifyEffect` 临界区，判定依据改为转换时刻的持久化状态，"过期快照 + join 丢 work"的组合不再可达。

**2. 不变量保持**：

- *有界重启（终止性）*：重整执行 `runLoop`，其在发起 provider 请求前创建 assistant 消息（`prompt.ts:1201-1216`，`parentID: lastUser.id`、`MessageID.ascending()`），故重整轮结束后 `latest` 中最新 assistant 晚于最新 user，谓词变假；每次重整至多多消费一条新到消息，消息总量有限，故重整次数有界，每条消息恰被消费一次。
- *守卫完备*：重整仅在 `st` 匹配 ∧ `Exit.isSuccess(exit)` ∧ 谓词真时发生。用户中断/`cancel` → interrupt-only failure → 不重整（Session 不被复活）；provider 失败 → failure exit → 不重整（无失败循环）。cancel 与 finishRun 在同一 ref 上串行：cancel 先到则 `st.run.id !== id`，finishRun 先到则 cancel 中断的是重整后的新 fiber——两序皆安全。
- *既有语义不变*：谓词未传/为假/旧 run 状态不匹配时，`finishRun` 行为与修复前逐分支一致（`complete` + `idle` + Idle 转换）。`Runner` 全仓库唯一消费者是 `run-state.ts`，且钩子为可选，其他调用形态（shell、cancel、join）零影响。
- *join 方契约不变*：`awaitDone(st.run.done)` 仍 resolve 旧 run 结果；重整轮的结果经事件/status 正常外发，无人 join 亦无泄漏（fork 在 runner scope，idle/cancel 路径照常覆盖）。
- *状态不闪烁*：重整路径不调 `onIdle`，runner 保留在 map、status 保持 busy。

**3. 无回归引入**：依赖第六部分测试用例——runner 单元测试逐守卫覆盖（成功重整/谓词假零空转/失败不重整/中断不复活/join 方取旧结果），session 级测试覆盖端到端竞态与"无消息零空转"。

## 第六部分：测试用例清单

| 类型 | 用例描述 | 状态（修复后回填） |
|------|---------|------------------|
| 回归 | runner 级：谓词真时成功退出重整——work 执行两次、join 方拿到第一次结果、终态 Idle（对应第一部分最小复现的 Runner 层形态） | 已加: `test/effect/runner.test.ts` "re-arms finished work when shouldReArm is true" |
| 回归 | session 级：hold 制造窗口 + 窗口内写消息 + 释放 → 第 2 次 provider 请求消费该消息，assistant `parentID` 指向注入消息（修复前 RED：`llm.wait(2)` 超时） | 已加: `test/session/prompt.test.ts` "message written while the loop is finishing is consumed" |
| 新增 | runner 级：谓词假时不重整、无额外执行、终态 Idle（无消息零空转） | 已加: `test/effect/runner.test.ts` "does not re-arm when shouldReArm is false" |
| 新增 | runner 级：失败退出不重整（谓词真仍只执行一次，失败正常传播） | 已加: `test/effect/runner.test.ts` "does not re-arm after a failed exit" |
| 新增 | runner 级：中断不复活（cancel 后谓词真，无第二次执行） | 已加: `test/effect/runner.test.ts` "does not re-arm after cancel" |
| 新增 | session 级：正常单轮结束无空转轮次（calls == 1 且 idle） | 已加: 复用既有 `test/session/prompt.test.ts` 断言（`llm.calls`/`pending`），并在新回归用例内断言无第三次请求 |
| 新增 | session 级：谓词 DB 读失败 fail-closed（退化悬置，不崩 run） | 未加：fail-closed 在 session 侧以 `Effect.catch` 实现，测试需注入 DB 故障而现有夹具无干净注入点，记为后续改进项（见下方说明） |

> 修正：谓词 fail-closed 的最终形态以实现为准回填本表——若 session 侧用 `Effect.catchAll` 收敛错误通道，则 runner 层无需感知失败，该项落在 session 侧而无干净注入点时记为后续改进项，不在本轮虚报覆盖。

## 第七部分：代码更新清单

| 文件 | 函数 / 行号 | 改动概述 | 状态（修复后回填） |
|------|------------|---------|------------------|
| `packages/opencode/src/effect/runner.ts` | `make` opts / `finishRun` / `startRun` | 增加 `shouldReArm` 钩子；`finishRun` 改 `modifyEffect`，临界区内按守卫 + 谓词决定重整或 Idle；`startRun` 向 `finishRun` 传递 `work` | 已改: 5705b5787f |
| `packages/opencode/src/session/run-state.ts` | `Interface.ensureRunning` / `Interface.startShell` / `runner` | 可选 `shouldReArm` 参数穿透至 `Runner.make` | 已改: 5705b5787f |
| `packages/opencode/src/session/prompt.ts` | 新增谓词 / `loop` / `shell` | 构造 fail-closed 谓词（复用 dev 基座的 `MessageV2.compareChronology`）并在 `loop`/`shell` 传入 | 已改: 5705b5787f |
| `packages/opencode/src/session/message-v2.ts` | — | 无改动：dev 基座已有导出的 `compareChronology`（empty-tool-calls 基座才需导出 `isAfter`） | 不适用 |
| `packages/opencode/test/effect/runner.test.ts` | 新增 5 用例 | 重整/守卫/join 契约 | 已加: 5705b5787f |
| `packages/opencode/test/session/prompt.test.ts` | 新增 1 用例 | 端到端竞态回归（修复前 RED） | 已加: 5705b5787f |

## 第八部分：文档更新清单

| 文档路径 | 要改什么 | 状态（修复后回填） |
|---------|---------|------------------|
| `docs/fixes/session-runner-fix-idle-race.md`（本文档） | 第六/七部分回填实际状态 | 已改（随本分支 docs 提交，含于本文件的提交落地） |
| `CLAUDE.md` 已知限制与注意事项 | 回写经验教训：判定与状态转换必须同临界区；V1 以持久化状态为判定依据时选"结算侧重读"而非瞬时标志 | 已改（同上） |
| `docs/devlog/2026-09-11-session-idle-race.md` | 新增开发日志（含度量段） | 已改（同上） |

> 本仓库尚无 Runner / SessionPrompt 的契约文档（`docs/design/`、`docs/research/` 不存在），本修复亦不改变 schema/枚举/对外 API；行为契约变更（Runner 可选钩子 + Session 收尾重整语义）以本文档第四部分为首次记载，issue #32 为分析底稿。

## 验证记录（Step 5）

基座说明：本修复最终落在 `dev` 之上（`origin/dev` + 2 提交）。dev 的修复前 `runner.ts`/`run-state.ts` 与分析时所在的 empty-tool-calls 基座逐字节一致，故修复前 RED 证据直接沿用；RED→GREEN 已在该基座完整实测（新竞态回归修复前第二次请求永不发生）。

- 定向（dev 基座）：`test/effect/runner.test.ts` + `test/session/prompt.test.ts` + `test/session/message-v2.test.ts` 合计 160 pass / 0 fail（含 dev 既有用例与本修复 6 个新用例）；`test/session/processor-effect.test.ts` 78 pass / 0 fail（确认 re-arm 行为不与 dev 既有 fixture 冲突）。
- typecheck：`tsgo --noEmit` 通过。
- 全量（dev 基座）：`packages/opencode` 全套件 3624 pass / 10 fail。10 个失败全部为环境性（cf-ai-gateway/transform 的 anthropic 适配 4、HttpApi SDK 超时 4、tool.write 文件权限 1、McpOAuthCallback 1），session/runner/processor/llm 域零失败，非本修复引入。
- 环境注记：本机 node_modules 曾处于未打补丁状态（`@ai-sdk/openai-compatible@2.0.41` 的 patch 未应用），导致 compatible reasoning 系列用例大量假失败；`rm` 该 store 副本后 `bun install --frozen-lockfile` 重建即恢复。跨分支切换后依赖树陈旧问题再次验证，判定失败前须先核对实际安装版本与 patch 状态。
