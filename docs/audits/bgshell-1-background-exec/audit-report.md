# Contract Audit Report — `bgshell-1-background-exec`

> 状态：2026-11-24 独立审核并收敛修复后最终核对（§6.5 路径 B）。
> **时序声明**：首轮实施未按 §6.2 事前产出 `expectations.md`（已在 `expectations.md` 顶部记录流程偏离，不追认）。以下核对覆盖 2026-11-19～11-24 全部提交与收敛修复。

## 1. 结论（§6.6 退出标准）

- **Critical / Unresolved**：**0 critical / 0 unresolved**（本轮独立审核检出的 P1-5、P1-6、P1-7 与 P2-5～P2-10 均已修复并补回归测试）。
- **路径 A（机械检查）**：`Step P1–P9` 注释全部就位（`shell.ts:677,690,706,738,744,759,810,815`、`run-state.ts:144`）；`bun typecheck` 四包通过；`git diff --check` 零报错。验收由 [#46](https://github.com/lihaokun/opencode/issues/46) 与 [PR #60](https://github.com/lihaokun/opencode/pull/60) 跟踪。

## 2. 路径 B 逐项核对表

| 编号 | 契约项 | 判定 | 代码 / 测试证据（`file:line`） |
|---|---|---|---|
| B1 | 活跃后代 runner 级联取消（P1-5） | ✅ | `packages/opencode/src/session/run-state.ts:88-115` 在 `stopTree` 迭代循环中同步取消所有已发现后代会话的 `Runner`，直至运行 job 与活跃后代 runner 均归零。回归：`shell-background.test.ts` 后代唤醒取消用例。 |
| B2 | `ctx.abort` 预检防孤儿进程（P1-6） | ✅ | `packages/opencode/src/tool/shell.ts:665-672,787-793,816-825` 三处守卫 `ctx.abort.aborted`，并在 `background.start` 上挂 `Effect.onError` 清理 `shellTasks`。回归：`shell-background.test.ts` 预取消不启动进程用例。 |
| B3 | `shell_output`/`shell_kill` 权限别名（P1-7） | ✅ | `packages/opencode/src/permission/index.ts:245-251` 将 `shell_output`/`shell_kill` 别名为 `bash`，`explore` 代理可见二者且 `bash: deny` 隐藏三者。回归：`test/permission/next.test.ts`。 |
| B4 | `shell_kill` 无条目运行任务与前缀剥离（P2-5, P2-6） | ✅ | `shell.ts:950-985` 在 `!entry && job.status === "running"` 时调用 `background.cancel`；已结算路径经 `splitStatusOutput` 剥离内部首行状态前缀。回归：`shell-background.test.ts`。 |
| B5 | `Session.remove` / HTTP 删除级联（P2-7） | ✅ | `packages/opencode/src/session/session.ts:1137-1179` 遍历委派树并循环至静默；`handlers/session.ts:192-197` 先 `requireSession` + `promptSvc.cancel` 再 `session.remove`。回归：`test/session/session.test.ts`。 |
| B6 | `BackgroundJob.cancel` 与 `CrossSpawnSpawner` 进程组收尾（P2-8, P2-9） | ✅ | `packages/core/src/background-job.ts:312-315` 先 `Scope.close` 再 `Deferred.succeed(done)`；`packages/core/src/cross-spawn-spawner.ts` 非零退出启用 `SIGTERM → waitGroupGone → SIGKILL`，取消 `SIGKILL` 后对 `Deferred.await(signal)` 设 1 秒上限。回归：`packages/core/test/background-job.test.ts`。 |
| B7 | 错误单行/UTF-16 截断与空 `task_id`（P2-10a, P3） | ✅ | `shell.ts:58-68,704,889,913` 使用 `errorPreview` / `commandPreview` 与 `params.task_id !== undefined`。回归：`shell-background.test.ts`。 |
| B8 | 首轮事前 `expectations.md` 缺失 | ⚠️ | 历史流程偏离，已在 `expectations.md` 与 `decisions.md` 记录接受，不追认。 |

完整收敛记录见 [docs/fixes/runtime-fix-pr60-audit-convergence.md](../../fixes/runtime-fix-pr60-audit-convergence.md)。
