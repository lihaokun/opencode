# Contract Audit Decisions — `comprec-1-restoration`

本子计划审核发现的偏离与契约收敛决策（格式：项 → 决定 → 依据）：

1. **首轮 `expectations.md` 事前时序违例** → 接受历史偏离并保留声明，不追认 — 事后补抽已完成并同步至最终 HEAD，回归保护由测试与路径 B 逐项核对承担。
2. **路径 A 通用检查器未引入** → 标记 N/A 并以手工命令核验（`Step P1–P8` grep、`bun typecheck`、`git diff --check`）— 本仓库无独立 `scripts/contract_audit` 脚本，合并验收由 #46 / PR #60 跟踪。
3. **摘要保留计数与溢出恢复协调（2026-11-20～11-24）** → 将 `Assistant.n`、`CompactionPart.protected_from/request_user_id/fixed_input_tokens` 与 `SessionRestoration.apply({ maxBudgetTokens })` 纳入正式契约 — 溢出压缩保留 `summaryReserve`，恢复预算按主模型剩余 headroom 动态封顶（极端紧窗口时降为 0），避免默认恢复触发假性 `ContextOverflowError`。
4. **候选与去重语义收敛（2026-11-21～11-24）** → `retainedFileVersions` 以同路径完整可见 `read` 源字节 SHA-256 为证据并在 `edit`/`write` 时失效；磁盘 `SKILL.md` 读前先 `stat`；已保留且未变更文件优先判为 `skipped-duplicate` 不计入 `max_files` 降级；未结算 compaction marker 不得抢占恢复载体；写入新 sentinel 前就地退役旧 sentinel（`ignored: true`）。
