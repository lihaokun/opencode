# 开发日志：Legacy incomplete stream bounded recovery

> 日期：2026-08-20
> Issue：#7
> 分支：`incomplete-stream-retry`
> 范围：Legacy Session same-assistant transport replay

## 做了什么

- 在 shared LLM provider failure classification 中增加 `incomplete-stream`，由 AI SDK adapter 在 canonical missing raw finish 边界附加稳定分类。
- 在 Legacy `SessionProcessor` 内增加两个 private incomplete entries：explicit classified provider error 与 qualifying clean EOF。
- 把一次 logical assistant process 划分为多个 physical attempts；每次 attempt 建立 assistant `finish/cost/tokens` checkpoint，并在 part creation 时登记 ownership。
- safe replay 前使用既有 `Session.removePart()` 删除 current attempt authoritative parts，恢复同一个 assistant checkpoint；rollback preparation 失败时不发下一 provider request。
- 复用 `SessionRetry.policy()` 的 Effect schedule、delay 与 status，增加可选 decision/preparation hooks；ordinary 与 incomplete replay 共用一个单调 physical attempt ordinal。
- 为 incomplete 增加独立预算：initial request 之外最多 replay 两次；explicit 与 clean EOF 共用该预算，ordinary retry 不消耗。
- 建立 process-local monotonic replay fences：actual matching `experimental.text.complete` invocation、任一六类 normalized tool event、existing assistant terminal error 与 interrupt evidence。
- 延迟 processor `step-finish` summary launch：rolled-back attempt 不启动 summary，最终 retained attempt 由 process finalizer 在 cleanup body 前释放。
- 明确三层 observability：authoritative transcript 与 removal-aware projection 收敛到 retained attempt；append-only output 可以保留 transient failed-attempt bytes。
- 更新 Prompt、CLI、child Task 与 compaction regressions，验证同 assistant retry、三次 exhaustion、earlier tool side effect 恰好一次、authoritative final-attempt convergence 与 append-only caveat。

## 为什么

Issue #3 已保证缺少可信 terminal evidence 不能误报成功，但 Legacy processor 会直接终止 safe incomplete，也会在 ordinary retry 时把多个 physical attempts 的 parts 拼接到同一个 assistant。Issue #7 需要在不进入 Prompt continuation、不创建新 assistant、不扩大 public error contract 的前提下，增加有界且副作用安全的 transport replay。

修复核心不是通用 error provenance 或事务框架，而是四个局部缺口：

1. canonical incomplete 缺少 stable classification；
2. physical attempt 的 materialized delta 未独立追踪和撤销；
3. provider replay 缺少 processor 可观察的副作用 fences；
4. summary launch 早于 retained/rollback decision。

## 关键决策

- 只修改 Legacy Session；V2 仅作为架构参考。
- 不新增 public `IncompleteStreamError`，最终 unrecoverable incomplete 仍是 Legacy `UnknownError`。
- 不做模型 continuation，不创建 new user message、assistant ID 或 recovery turn。
- 任何 normalized tool event 都视为副作用 evidence，不区分完整度、状态或 provider/local execution。
- matching text-complete handler 在实际 invocation 前建立 fence；仅 registration 不建立 fence。
- model text/reasoning/step 已持久化、发布或被 append-only consumer 观察，本身不建立 replay fence。
- rollback 只承诺 authoritative/materialized transcript 与 removal-aware projection 收敛，不承诺所有历史输出 surface 擦除。
- rollback preparation 失败只保证 no-next-request；不引入 crash-atomic rollback、survivor reconciliation、durable batch 或 Snapshot global restore。
- final error/finish 按来源保留：unsettled clean EOF 为 `UNSETTLED_STEP_MESSAGE/error`，credible empty unknown 为 `EMPTY_UNKNOWN_MESSAGE/unknown`，canonical missing finish 保留 provider detail/unknown。

## 实施提交

| 单元 | Commit |
|---|---|
| 修正方案与旧契约 amendment | `4e4f384d3`、`ad59676db` |
| stable classification / adapter | `269aa2848` |
| processor private entries / checkpoint / retry hooks | `c10dea5ab`、`4fe35e621`、`b79bf8259` |
| plugin/tool/terminal-error fences | `2eb1d6e1e`、`e9673f094`、`ae34d166c` |
| ordinary rollback / summary deferral | `e3e4dbc59`、`28b35d189` |
| explicit / clean EOF bounded recovery | `0d133d5b2`、`d17915191` |
| observability / cross-layer regressions | `31e23f984`、`602df5a50` |
| final audit fixes | `bb8f5c879`、`9b9da8e80`、`df9eb3687` |

## 最终审核发现与修复

### 1. retry delay interrupt 未落地 aborted error

原 `Effect.onInterrupt` 只包裹单次 physical attempt。`beforeRetry` 已 rollback 后进入 2s/4s schedule delay 时取消，outer cleanup 会把 assistant 标 completed，但不会调用 `halt(AbortError)`。

修复：在整个 retry schedule 外增加 interruption handler；focused regression 等待 retry status 后取消，断言 request count 仍为 1、authoritative parts 已 rollback、assistant 持久化 `MessageAbortedError`、status 回到 idle。

### 2. mixed Fail + Interrupt 被 squash 后 replay

只保留 schedule 外层 handler 时，mixed cause 会先经过 `catchCauseIf`，被 squash 成 ordinary retryable failure；取消 evidence 在 retry decision 前丢失，可能发 successor request。

修复：保留 attempt 内层 handler，在 cause squashing 前单调设置 `aborted` 并落地 abort error；同时保留 schedule 外层 handler覆盖 preparation/backoff。focused mixed-cause regression 证明 request count 为 1、process 终止为 stop、durable assistant 为 `MessageAbortedError`。

### 3. compaction exhaustion direct test timeout

compaction fixture 使用真实 2s + 4s backoff，但单文件 bare `bun test` 默认 timeout 为 5s。修复为该用例设置 15s 显式 timeout；focused direct command 与 full compaction file 均通过。

## 验证

| 验证项 | 结果 |
|---|---|
| `packages/llm/test/schema.test.ts` | 9 pass / 0 fail / 23 assertions |
| `packages/opencode/test/session/processor-effect.test.ts` | 62 pass / 0 fail |
| `packages/opencode/test/session/compaction.test.ts` | 57 pass / 1 skip / 0 fail / 168 assertions |
| `packages/opencode/test/session` | 464 pass / 7 skip / 1 todo / 0 fail / 1668 assertions |
| `packages/opencode/test/tool/task.test.ts` | 37 pass / 0 fail / 201 assertions |
| `packages/opencode/test/cli/run/run-process.test.ts` | 20 pass / 0 fail / 131 assertions |
| `packages/llm` typecheck | 通过 |
| `packages/opencode` typecheck | 通过 |
| `git diff --check` | 通过 |
| 独立五维审核 | 0 个 unresolved finding |

root-wide `bun run lint` 仍报告与本分支无关的既有 unused-variable warnings；未为清理无关文件扩大 Issue #7 scope。最终仍需由远端 GitHub Actions 执行完整 Linux/Windows matrix。

## 五维审核

1. **一致性**：实现与批准方案一致；两个 incomplete entries、same-assistant rollback、独立预算、fences、exact final semantics、summary 与 observability contract 均有 regression。
2. **风格**：复用既有 Effect schedule、Session removal/update、cleanup、summary API 与 typed LLM events；未新增依赖或 public error hierarchy。
3. **正确性**：最终审核发现的 retry-delay interrupt、mixed interrupt replay 与 compaction timeout 已修复；独立复审无 unresolved correctness/security finding。
4. **性能**：incomplete replay 最多两次；新增 bookkeeping 为 attempt-local set/counter/checkpoint。未引入 hot-path network call、全局 gate 或 consumer retrofit。
5. **可维护性**：classification 在 shared schema 单点定义；recovery 保持 processor-private；V2、Prompt continuation、plugin/tool runtime 与 public SDK 边界不受影响。

## 范围核对

- 无 V2 production/test diff。
- 无 public Legacy assistant error union、OpenAPI 或 generated SDK diff。
- 无 production Prompt、Task、CLI、compaction、TUI、Mini、ACP、GitHub/share、publisher/projector diff。
- `prompt.test.ts`、`compaction.test.ts`、`run-process.test.ts` 仅更新批准范围内的跨层 regressions。
- `task.test.ts` 保持不变；其 stub boundary 不经过 provider physical attempts，actual child retry 由 CLI integration 覆盖。

## 经验教训

- Provider 协议事实必须在 adapter 边界形成稳定 classification；下游不能靠错误文案猜测类别。
- Durable removal 与 removal-aware convergence 不等于 append-only 历史擦除；设计与测试必须明确 observer 能力边界。
- Effect retry 的 interruption handling 不能只包裹 attempt body，也要覆盖 rollback preparation 与 backoff；mixed cause 必须在 squashing 前锁存 interrupt evidence。
- 使用真实 backoff 的 exhaustion 测试必须显式设置足够 timeout，不能依赖 package wrapper 隐式放宽。

以上经验均已同步回写上层项目 `CLAUDE.md` 的「已知限制与注意事项」，并由本次 focused regressions 固化。

## 度量

| 指标 | 数值 |
|------|------|
| 新增代码行数 | 约 1,930 行（production + tests 的 `git diff --numstat` `+` 侧，不含文档） |
| 修改代码行数 | 约 183 行（既有行替换，按 `-` 侧估算） |
| 删除代码行数 | 0 行独立功能删除（diff 的 183 个 `-` 行计入“修改”） |
| 涉及文件数 | 15 个（production 4、tests 7、docs/devlog 4） |
| 新增测试用例数 | 净新增约 30 个；另重命名/强化约 15 个既有 regressions |
| 测试通过率 | 530/530 required local tests 通过；另 7 skip / 1 todo；0 fail |
| 发现 bug 数 | 3 个实施后审核问题（retry-delay interrupt、mixed interrupt replay、compaction timeout） |
| 修复 bug 数 | 4 个（Issue #7 根因组 + 3 个审核问题） |
| 迭代轮次 | 设计约 8 轮 / 核心实现 14 单元 / 最终审核修复 3 轮 |
