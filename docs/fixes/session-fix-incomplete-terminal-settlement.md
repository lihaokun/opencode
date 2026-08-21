# 修正方案：Legacy incomplete terminal settlement ordering

> 日期：2026-08-20  
> Issue：#7 / PR #19 rebase 后独立审核  
> 分支：`incomplete-stream-retry`  
> 状态：修复前方案，待确认  
> 范围：Legacy `SessionProcessor` 的 incomplete terminal ordering 与 retry rollback preparation failure settlement

---

# 第一部分：现象与复现

## 1.1 P1-A：incomplete terminal 在 durable cleanup 前发布 idle

### 现象

`SessionProcessor.halt()` 处理最终不可恢复的 `IncompleteStreamControl` 时，当前顺序为：

```text
设置内存 assistant.error / finish
→ 发布 session.error
→ 发布 session.status = idle
→ Effect.ensuring 中 release summaries
→ cleanup 闭合 currentText / reasoning / tool parts
→ cleanup 设置 time.completed
→ cleanup 持久化 assistant MessageUpdated
```

相关代码路径：

```text
packages/opencode/src/session/processor.ts
  process()
    → settleIncomplete()
    → Effect.catch(halt)
      → halt(IncompleteStreamControl)        // 当前约 765-785
        → status.set(idle)                   // 当前约 784
    → Effect.ensuring(... cleanup())         // 当前约 904-913
      → cleanup currentText / reasoning / tools
      → session.updateMessage(assistant)     // 当前约 761-762
```

CLI 与 stream transport 把首个 idle 当作 terminal signal：

```text
packages/opencode/src/cli/cmd/run.ts:788-794
packages/opencode/src/cli/cmd/run/stream.transport.ts:836-865
```

因此 idle 之后才发布的 retained part finalization / `MessageUpdated` 可能不再被短生命周期 consumer 观察。

### 最小复现用例

构造最终 retained physical attempt：

```ts
Stream.make(
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.textStart({ id: "retained-open-text" }),
  LLMEvent.textDelta({ id: "retained-open-text", text: "final partial" }),
  // 无 text-end / step-finish / finish；clean EOF
)
```

让前两次 incomplete 已消耗 budget，或用 replay fence 阻止下一次 replay。监听同一 session 的事件时间线，并模拟 CLI 只在 `part.type === "text" && part.time?.end` 时输出、在首个 idle 时停止。

**预期**：

```text
retained text PartUpdated(time.end 已设置)
→ assistant MessageUpdated(error + time.completed 已持久化)
→ session.status idle
```

consumer 在 idle 前能看到并输出 `final partial`。

**实际**：

```text
session.error
→ session.status idle
→ retained text PartUpdated(time.end)
→ assistant MessageUpdated(error + time.completed)
```

consumer 在 idle 处提前结束，可能遗漏 retained final partial，并观察到 idle session 的 durable assistant 仍无最终 error / `time.completed`。

### 影响范围与频次

- 仅影响 Legacy Session 新增的最终 incomplete terminal 路径。
- 需要 retained attempt 在 terminal 时仍有未闭合 text/reasoning/tool state；普通 `reply().text(...)` fixture 通常先发 `text-end`，因此现有 CLI E2E 未覆盖。
- exhaustion 与 replay-fenced stop 都可能触发。
- V2 不受影响。

## 1.2 P1-B：rollback removal defect 绕过 terminal settlement

### 现象

`rollbackAttempt()` 在 retry preparation 中逐个调用 `Session.removePart()`：

```text
packages/opencode/src/session/processor.ts:213-235
```

Part removal 经过 durable event/projector；数据库 I/O、disk-full 或 projector defect 可形成 Effect defect。该 defect 发生在 `Effect.retry(SessionRetry.policy(...))` 的 `beforeRetry` 内，而当前把 cause squash 成 typed failure 的 `catchCauseIf` 只包裹单次 physical attempt body。结果是 rollback defect 越过后续 `Effect.catch(halt)`：

```text
physical attempt body catchCauseIf
→ Effect.retry(... beforeRetry = rollbackAttempt)
→ outer onInterrupt
→ Effect.catch(halt)        // 只捕获 typed failure，不捕获 defect
→ ensuring cleanup
```

现有 regression `session.processor does not request or summarize again when rollback removal fails` 只断言：

- process Exit failure；
- provider request count 为 1；
- summary 未启动。

它没有断言 durable assistant error、finish、`time.completed` 或 `SessionStatus`。实际可能出现：

- no-next-request 成立；
- assistant 未形成 terminal error；
- status 保持 `busy`；
- cleanup 仍写入 completed timestamp；
- rollback 已发生的 durable removals不原子恢复。

### 最小复现用例

沿用现有 fixture：

```ts
yield* events.project(SessionV1.Event.PartRemoved, (event) =>
  event.data.sessionID === chat.id
    ? Effect.die(new Error("rollback removal failed"))
    : Effect.void,
)
```

让 attempt 1 产生可 rollback part 后返回 ordinary retryable failure。

**预期**：

```text
request count == 1
no retry status / no successor request
assistant.error = UnknownError("rollback removal failed")
assistant.finish = "error"
assistant.time.completed 已持久化
session.status = idle
process 返回 "stop"
```

不要求已删除 part 原子恢复，也不要求 survivor reconciliation。

**实际**：

```text
request count == 1
process Exit failure（defect）
assistant 可能无 terminal error
status 可能保持 busy
```

### 影响范围与频次

- 仅影响 Issue #7 新增的 rollback preparation failure path；ordinary retry 与 incomplete retry 都复用该路径。
- 需要 durable removal/projector/storage 失败，正常运行中低频，但一旦发生会留下不可收敛的 terminal session 状态。
- 与已批准的 non-atomic rollback boundary 不同：本修复不要求数据原子恢复，只要求 process fail-closed 后形成可观察 terminal settlement。

---

# 第二部分：根因分析

## 2.1 P1-A 根因

根因不是 CLI 丢事件，而是 processor 对 terminal signal 的发布顺序违反 consumer 契约：

```text
idle ⇒ 本 turn 已完成 terminal persistence 与 retained part finalization
```

新增 `IncompleteStreamControl` 分支复用了 generic halt 中“立即 set idle”的局部模式，但 incomplete clean-EOF 的 retained attempt 可能仍持有 `ctx.currentText` / `ctx.reasoningMap` / pending tool state，必须依赖后续 `cleanup()` 才形成 durable terminal projection。把 idle 放在 cleanup 前，使 session status 与 durable assistant/parts 暂时矛盾。

现有测试均在 `handle.process()` join 完成后读取 storage，因此掩盖了事件时序问题；CLI E2E 的 fixtures 又会先闭合 text part，因此没有构造 failure scenario。

## 2.2 P1-B 根因

根因是 Effect cause normalization 边界放错层级：

- physical attempt body 的 defect 会在 retry 前被 squash 为 typed failure；
- `beforeRetry` / rollback preparation 位于该边界之外；
- rollback 中的 defect 因而不会到达 `halt()`；
- outer finalizer 只负责 cleanup，不负责为无 error 的 defect 建立 terminal error/status。

这不是 rollback 非原子性的根因修复。non-atomic durable removals 是已批准边界；真正缺口是：

```text
retry preparation failure
⇒ no next request
⇒ terminal error persisted
⇒ status eventually idle
```

当前只保证第一项。

## 2.3 共同根因

两项问题都来自 logical process 终态被拆散在三个位置：

1. `halt()` 建立 error/finish 并可能发布 idle；
2. retry schedule 的 `beforeRetry` 可能产生新的 cause；
3. `ensuring(cleanup())` 最后才闭合 parts 和持久化 assistant。

现有实现没有显式表达“哪些 terminal paths 必须把 idle 延迟到 cleanup 后”，也没有让 retry-schedule 内部 defect 进入同一 terminal settlement。

---

# 第三部分：参考实现对照

本次不是算法类 bug，不要求外部算法参考实现。

采用项目内契约与既有 Effect 结构作为对照：

1. `packages/opencode/src/cli/cmd/run.ts:748-759, 788-794`
   - text 只有 `time.end` 后才可输出；
   - idle 是 terminal break。
2. `packages/opencode/src/cli/cmd/run/stream.transport.ts:836-865`
   - idle 可完成当前 turn wait。
3. `packages/opencode/src/session/processor.ts` 现有双层 interruption handling
   - 单次 attempt 与 retry schedule/backoff 的 cause 边界必须分别覆盖；
   - 本修复沿用同一原则，把 retry preparation 的 non-interrupt defect 也纳入 terminal normalization。
4. 已批准的 `docs/fixes/session-fix-incomplete-stream-recovery.md:642-650`
   - rollback preparation 失败必须 fail schedule、不得发下一 request；
   - 本修复补全其 terminal error/status 后置条件，不修改 rollback durability 边界。

---

# 第四部分：修复方案

## 4.1 边界与不做事项

只修改 Legacy processor 与相关 tests/docs。

明确不做：

- 不修改 V2；
- 不修改 public error union、OpenAPI 或 generated SDK；
- 不新增 production consumer retroactive deletion；
- 不把 rollback 改为事务、durable batch、Snapshot restore；
- 不做 survivor reconciliation 或恢复已删除 parts；
- 不处理 summary coalescing、plugin hook traversal 等独立 cleanup；
- 不改变 incomplete retry budget、same-assistant identity 或 physical ordinal。

## 4.2 P1-A：延迟 incomplete terminal idle

在 `SessionProcessor.create()` 内增加 process-local terminal-idle deferral state（最终命名按现有风格确定）：

```ts
let terminalIdleAfterCleanup = false
```

`halt(IncompleteStreamControl)`：

1. 保持现有 `UnknownError` 与 exact finish 映射；
2. 保持 `Session.Event.Error` publication；
3. 设置 `terminalIdleAfterCleanup = true`；
4. 不立即 `status.set(idle)`。

process finalizer 保持顺序：

```text
release retained attempt summaries
→ cleanup retained text/reasoning/tools
→ persist assistant error/finish/time.completed
→ if terminalIdleAfterCleanup: status.set(idle)
```

idle publication 必须放在 cleanup finalizer 的最外层 `ensuring` 中，使 cleanup 正常完成或其 error handler 运行后才发出。

不改变 generic error、context overflow 与既有 interrupt path 的 status ordering，除非该 path 同时来自本次 rollback-preparation deferral。

## 4.3 P1-B：把 rollback preparation cause 纳入 terminal settlement

在 `beforeRetry` 的 `rollbackAttempt(failure)` 周围登记 preparation failure evidence，但保持原 cause，不在该处把 interrupt 改写成普通错误：

```text
rollbackAttempt fails/dies/interrupts
→ 单调标记 terminal idle 需在 cleanup 后发布
→ 原 cause 继续传播
```

在完整 retry schedule（含 `beforeRetry` 与 backoff）外、outer interruption handler 之后、`Effect.catch(halt)` 之前增加 non-pure-interrupt cause normalization：

```text
outer onInterrupt（先锁存 abort）
→ catchCauseIf(non-pure-interrupt, squash to typed failure)
→ catch(halt)
→ finalizer cleanup
→ deferred idle
```

这样：

- pure interrupt 仍由 interruption path 处理；
- mixed interrupt 先锁存 abort，不被重新解释成 retryable failure；
- rollback/storage defect 进入 `halt()` 并映射为 existing `UnknownError`；
- rollback preparation failure 明确设置 `finish = "error"`；
- schedule 已失败，因此绝不发下一 provider request；
- terminal error 在 cleanup 中持久化，随后 status idle。

## 4.4 cleanup failure 与 approved boundary

若 rollback 已删除部分 parts 后失败：

- 不尝试推断 survivors；
- 不重新插入已删除 parts；
- 不承诺 authoritative transcript crash-atomic；
- 仍保证 assistant 有 terminal error、`time.completed` 尽力持久化、status 最终 idle。

若 cleanup 自身也失败，沿用 existing cleanup cause handling；本修复只保证 deferred idle 在 cleanup attempt/error handling 之后发布，不扩展为 durable repair framework。

## 4.5 修改后的 P1-A 执行路径

```text
final incomplete retained attempt
→ halt sets UnknownError + exact finish
→ publish session.error
→ mark idle deferred
→ release retained summaries
→ finalize retained text/reasoning/tool parts
→ persist assistant(error + finish + time.completed)
→ publish idle
→ CLI/transport terminate
```

## 4.6 修改后的 P1-B 执行路径

```text
attempt 1 retryable failure
→ decide retry
→ rollback preparation starts
→ removePart/projector defect
→ mark idle deferred
→ preserve cause through retry schedule
→ outer cause normalization
→ halt maps UnknownError + finish=error
→ no retry status / no successor request
→ cleanup attempts terminal persistence
→ publish idle
→ process returns stop
```

---

# 第五部分：正确性论证

## 5.1 P1-A 根因消除

定义 terminal ordering invariant：

```text
I_terminal:
processor 为 incomplete terminal 发布 idle
⇒ retained parts 已完成 cleanup publication
∧ assistant(error, finish, time.completed) 已完成 durable update/publication
```

修复后，incomplete branch 只设置 deferral flag，不发布 idle。唯一对应 idle publication 位于 cleanup 之后。Effect 同一 fiber 内按顺序执行，因此：

```text
cleanup PartUpdated / MessageUpdated happens-before status idle
```

故任何以 idle 为 break/completion signal 的 consumer，在 idle 前都有机会观察 retained final part 与 terminal assistant update，根因被消除。

## 5.2 P1-B 根因消除

定义 retry preparation failure postcondition：

```text
P_prepare_fail:
rollback preparation 未成功
⇒ providerRequestCount 不增加
∧ assistant.error 为 terminal error
∧ assistant.finish = "error"（非 interrupt）
∧ cleanup attempt 完成后 status = idle
```

- `beforeRetry` failure 使 schedule step 失败，故下一 provider request 不会启动；
- schedule 外 cause normalization 使 defect 到达 `halt()`；
- `halt()` 建立 existing `UnknownError` 与 `finish="error"`；
- cleanup 持久化 assistant；
- deferred idle finalizer 最后发布 idle。

故 `P_prepare_fail` 成立。

## 5.3 interruption 不变量保持

外层 `onInterrupt` 保持在 cause normalization 前：

```text
interrupt evidence
→ aborted 单调置位
→ MessageAbortedError 优先建立
→ cause squash 不得触发 successor request
```

pure interrupt 不被 non-interrupt normalization 捕获；mixed cause 先执行 interruption handler。现有 retry-delay 与 mixed-cause regressions必须继续通过。

## 5.4 已批准 rollback boundary 保持

本修复不改变 part removal 次数、顺序或 durability：

- rollback 仍逐个走 `Session.removePart()`；
- 部分 removal 后失败仍可能留下 residual authoritative state；
- 不恢复 survivors，不保证 crash atomicity；
- append-only/removal-unaware surface 仍可保留 transient output。

因此没有把本次修复扩大为已明确拒绝的事务/修复框架。

## 5.5 无回归论证

- successful retained attempt：deferral flag 为 false，行为不变；
- safe incomplete retry：rollback 成功时 flag 不置位，budget/status/backoff 不变；
- context overflow：继续使用 PR #14 的 outer compaction recovery；
- tool/plugin/terminal-error fences：decision 不变；
- V2/public contracts：无修改；
- generic Legacy errors：除 rollback-preparation failure 新路径外不改变 ordering。

---

# 第六部分：测试用例清单

| 类型 | 用例描述 | 状态（修复后回填） |
|------|---------|------------------|
| 回归 P1-A | processor 构造 retained `text-start + text-delta + clean EOF`，断言 finalized text `PartUpdated` 与 assistant `MessageUpdated(error + time.completed)` 均早于 idle | 已加并通过：`session.processor finalizes retained incomplete output before publishing idle`（`49a969975`） |
| 回归 P1-A consumer | 模拟 run consumer 只输出 `time.end` text 并在 idle 停止，断言 `final partial` 在 idle 前可见 | 已由同一 event-timeline regression 锁定 `text:partial-3 → assistant-terminal → idle`（`49a969975`）；真实 subprocess 在最终全量阶段重跑 |
| 回归 P1-B | 强化现有 rollback-removal-failure：process 返回 stop、request count=1、durable `UnknownError("rollback removal failed")`、finish=error、time.completed、status=idle、无 summary | 待改 |
| 新增交叉 | rollback preparation pure/mixed interrupt 仍不 replay，MessageAbortedError 优先且 idle 在 cleanup 后收敛 | 由既有 retry-delay / mixed interrupt regressions覆盖并重跑；若实现改动暴露缺口则新增 focused case |
| 回归 | explicit incomplete success/exhaustion、clean EOF、ordinary rollback、plugin/tool/error fences | 待重跑 |
| 回归 | PR #14 context overflow eligible/disabled/assistant-started cases | 待重跑 |
| E2E | `run-process.test.ts` 全文件，确认 append-only 与 authoritative DB 契约不变 | 待重跑 |
| 全量 | Legacy session suite、LLM schema、opencode/llm typecheck、changed-file lint、`git diff --check` | 待重跑 |

所有真实 retry backoff 用例必须设置大于累计 backoff 的显式 per-test timeout。

---

# 第七部分：代码更新清单

| 文件 | 函数 / 行号 | 改动概述 | 状态（修复后回填） |
|------|------------|---------|------------------|
| `packages/opencode/src/session/processor.ts` | `halt()` / `process()` finalizer | incomplete terminal idle 延迟到 cleanup/terminal persistence 后 | 已改：`49a969975` |
| `packages/opencode/src/session/processor.ts` | `beforeRetry` / retry schedule outer cause boundary | 标记 rollback preparation failure、保留 interrupt evidence、把 non-interrupt defect 导入 halt、设置 finish=error | 待改 |
| `packages/opencode/test/session/processor-effect.test.ts` | terminal ordering regression | 增加 retained unclosed partial 与 idle/message/part ordering断言 | 已加：`49a969975` |
| `packages/opencode/test/session/processor-effect.test.ts` | rollback-removal-failure regression | 增加 terminal error/finish/completed/status/no-next-request 断言 | 待改 |
| `packages/opencode/test/cli/run/run-process.test.ts` | incomplete CLI E2E（如 fixture 可稳定表达） | 验证 terminal partial 在 idle 前可见；否则只重跑现有完整文件并在测试报告注明 processor fixture 是最小可控边界 | 待判定 |

---

# 第八部分：文档更新清单

| 文档路径 | 要改什么 | 状态（修复后回填） |
|---------|---------|------------------|
| `docs/fixes/session-fix-incomplete-terminal-settlement.md` | 本八部分方案；修复后回填测试、代码与 commit 状态 | 已创建方案（`10dac571b`）并回填 P1-A（`49a969975`）；P1-B/最终验证待回填 |
| `docs/fixes/session-fix-incomplete-stream-recovery.md` | 补充 rollback preparation fail-closed 的 terminal error/status 后置条件；补充 incomplete terminal `cleanup/message/parts happens-before idle` 契约 | 已补 P1-A terminal ordering；P1-B terminal settlement 待补 |
| `docs/devlog/2026-08-20-incomplete-stream-recovery.md` | 记录 rebase 后独立审核发现、修复、验证与更新后度量 | 待改 |
| 上层项目 `CLAUDE.md`（nested repo 外） | 增加“terminal idle 不得早于 durable terminal projection；retry preparation defect 必须进入 terminal cause normalization”经验 | 待改（不进入 PR） |

不涉及 `expectations.md`：本次是既有子计划的 bug fix，按 §7 流程处理，不新开 v2 子计划。
