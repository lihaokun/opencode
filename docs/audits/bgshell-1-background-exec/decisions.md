# Contract Audit Decisions — `bgshell-1-background-exec`

本子计划审核发现的偏离与契约收敛决策（格式：项 → 决定 → 依据）：

1. **首轮 `expectations.md` 事前时序违例** → 接受历史偏离并保留声明，不追认 — 事后补抽已完成并同步至最终 HEAD。
2. **路径 A 通用检查器未引入** → 标记 N/A 并以手工命令核验（`Step P1–P9` grep、`bun typecheck`、`git diff --check`）— 合并验收由 #46 / PR #60 跟踪。
3. **取消级联与进程组清理收敛（2026-11-21～11-24）** → `SessionRunState.cancel` 同步中断根 runner、所有运行中归属 job 与被后台 shell/`agent_send` 唤醒的活跃后代 runner 并重读至静默；`Session.remove` 与 HTTP `DELETE /session/:id` 对齐委派树级联；`BackgroundJob.cancel` 保证先关闭 Scope 再解析 `done`；`CrossSpawnSpawner` 统一 `SIGTERM → waitGroupGone → SIGKILL` 并为取消等待加 1s 上限。
4. **权限可见性与启动前取消（2026-11-24）** → `Permission.disabled` 将 `shell_output`/`shell_kill` 别名为 `bash`，避免 `explore` 子代理拿到指引却看不到工具或禁用 `bash` 时泄露二者；后台分支在解析/ask 前后与 `backgroundRun` 入口检查 `ctx.abort.aborted`，防止已取消调用启动孤儿进程。
