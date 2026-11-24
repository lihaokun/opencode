# Contract Audit Decisions — `grepext-1-search-params`

本子计划审核发现的偏离与契约收敛决策（格式：项 → 决定 → 依据）：

1. **首轮 `expectations.md` 事前时序违例** → 接受历史偏离并保留声明，不追认 — 事后补抽已完成并同步至最终 HEAD。
2. **有界计数、提前停流与非 UTF-8 兼容（2026-11-21～11-24）** → 保留 `--sort=path` 与流式跳过；非末页只报告 `total_lower_bound` 与 `"at least"`，EOF 报告精确 `total`；`contentPage` 消费 `{"type":"end"}` 并在收齐末条 `after` 后立即停流；`RgText` 同时支持 `{ text }` 与 `{ bytes }` 使 `content` 模式与 `files_with_matches`/`count` 在非 UTF-8 文本上行为一致；`count` 校验收紧为 `/^\d+$/u` 拒绝空串/科学计数法等畸形行。
3. **单页截断与分页续页顺序（2026-11-24）** → `GrepTool` 先对单页主体执行 `Truncate.output`，再拼接分页续页提示并在单页截断时明示保存文件仅含当前页；`files_with_matches` 与 `count` 分页均输出 `Showing files` 范围行；`count` 越界统一用 `files` 单位。
