# Contract Audit Report — `bgshell-1-background-exec`

> 状态：2026-11-24 独立审核并收敛修复后最终核对（§6.5 路径 B）。
> **时序声明**：首轮实施未按 §6.2 事前产出 `expectations.md`（已在 `expectations.md` 顶部记录流程偏离，不追认）。以下核对覆盖 2026-11-19～11-24 全部提交与收敛修复。

## 1. 结论（§6.6 退出标准）

- **Critical / Unresolved**：**0 critical / 0 unresolved**（一轮与二轮独立审核检出的根/后代 runner 取消、DB 子会话遍历、`BackgroundJob.cancel` 不可中断与并发等待、`ShellTool` `ask`/`start` abort 竞态、权限显式 deny 规则与 `CrossSpawnSpawner` 对称清理均已修复并补回归测试）。
- **路径 A（机械检查）**：`Step P1–P9` 注释全部就位（`shell.ts:676,689,705,737,743,766,818,823`、`run-state.ts:106`）；`bun typecheck` 四包通过；`git diff --check` 零报错。验收由 [#46](https://github.com/lihaokun/opencode/issues/46) 与 [PR #60](https://github.com/lihaokun/opencode/pull/60) 跟踪。

## 2. 路径 B 逐项核对表

| 编号 | 契约项 | 判定 | 代码 / 测试证据（`file:line`） |
|---|---|---|---|
| B1 | 根/后代 runner 与 DB 子会话级联取消（P1-5 + WS3-P1-2/P2-1） | ✅ | `packages/opencode/src/session/run-state.ts:89-138` 在 `stopTree(includeRoot)` 中沿 SQLite `Session.children` 扩展持久化子会话、复用 `tool/shell/tasks.ts:48-87` `cancelBackgroundJobsPass` 取消全部运行 job，并在静默循环中将根 `sessionID` 与后代 `Runner` 一并取消直至归零。回归：`shell-background.test.ts`（后代唤醒、根重唤醒、DB 持久化子会话三例）。 |
| B2 | `ctx.abort` 全路径防孤儿与防悬挂权限（P1-6 + WS3-P1-3） | ✅ | `packages/opencode/src/tool/shell.ts:669-675,758-766,795-801,817-833` 在入口、`ask` 前、`backgroundRun` 入口与 `background.start` 后四处守卫 `ctx.abort.aborted`（竞态取消立即 `background.cancel`），并挂 `Effect.onError` 清理 `shellTasks`。回归：`shell-background.test.ts`。 |
| B3 | `shell_output`/`shell_kill` 权限继承与显式规则（P1-7 + WS3-P2-2） | ✅ | `packages/opencode/src/permission/index.ts:240-262` 使 `shell_output`/`shell_kill` 继承 `bash` 规则同时尊重显式 `shell_output`/`shell_kill`/`shell_*` 规则（末匹配生效）。回归：`test/permission/next.test.ts`。 |
| B4 | `shell_kill` 无条目运行任务与前缀剥离（P2-5, P2-6） | ✅ | `shell.ts:957-1033` 在 `!entry && job.status === "running"` 时调用 `background.cancel`；已结算路径经 `splitStatusOutput` 剥离内部首行状态前缀，且自然结算竞态返回 `already settled`。回归：`shell-background.test.ts`。 |
| B5 | `Session.remove` / HTTP 删除级联（P2-7） | ✅ | `packages/opencode/src/session/session.ts:1137-1143` 复用 `tool/shell/tasks.ts:48-87` `cancelBackgroundJobsPass` 循环至静默；`handlers/session.ts:192-197` 先 `requireSession` + `promptSvc.cancel`（含 DB 子会话 runner）再 `session.remove`。回归：`test/session/session.test.ts`。 |
| B6 | `BackgroundJob.cancel` 与 `CrossSpawnSpawner` 进程组收尾（P2-8, P2-9 + WS3-P1-1/P2-4） | ✅ | `packages/core/src/background-job.ts:277-332` `cancel` 经 `Effect.uninterruptible` 保护并先 `Scope.close` 再完成 `done`，并发 `wait`/二次 `cancel` 均等待 `job.done`；`packages/core/src/cross-spawn-spawner.ts:345-495` 共享 `waitProcessGroupGone`（`ESRCH` 判死）、覆盖 `code !== 0`（含 `code === null`）且令 `handle.kill` 与释放器对称带 1 秒 `SIGKILL` 超时。回归：`packages/core/test/background-job.test.ts`。 |
| B7 | 错误单行/UTF-16 截断、标题清洗与空 `task_id`（P2-10a, P3） | ✅ | `shell.ts:52-66,704,881,913-915,935` 使用 `commandPreview`/`errorPreview`/`splitStatusOutput` 与 `params.task_id !== undefined`。回归：`shell-background.test.ts`（奇数前缀触发高代理裁剪 + 多行标题清洗）。 |
| B8 | 首轮事前 `expectations.md` 缺失 | ⚠️ | 历史流程偏离，已在 `expectations.md` 与 `decisions.md` 记录接受，不追认。 |

完整收敛记录见 [docs/fixes/runtime-fix-pr60-audit-convergence.md](../../fixes/runtime-fix-pr60-audit-convergence.md)。
