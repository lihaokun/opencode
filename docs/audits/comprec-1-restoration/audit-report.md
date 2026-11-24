# Contract Audit Report — `comprec-1-restoration`

> 状态：2026-11-24 独立审核并收敛修复后最终核对（§6.5 路径 B）。
> **时序声明**：首轮实施未按 §6.2 事前产出 `expectations.md`（已在 `expectations.md` 顶部记录流程偏离，不追认）。以下核对基于最终收敛后的工作树源码与实测结果，覆盖 2026-11-19～11-24 全部变更。

## 1. 结论（§6.6 退出标准）

- **Critical / Unresolved**：**0 critical / 0 unresolved**（本轮独立审核检出的 P1-1、P1-2、P2-1～P2-4 及三连续压缩/`pbt-render-materials` Oracle 漏洞均已修复并补回归测试）。
- **路径 A（机械检查）**：`Step P1–P8` 注释全部就位（`prompt.ts:1552`、`restoration.ts:449,484,504,529,534,538,547`）；`bun typecheck` 四包通过；`git diff --check` 零报错。通用 `scripts/contract_audit` 生成器本仓库未引入，验收由 [#46](https://github.com/lihaokun/opencode/issues/46) 与 [PR #60](https://github.com/lihaokun/opencode/pull/60) 跟踪。

## 2. 路径 B 逐项核对表

| 编号 | 契约项 | 判定 | 代码 / 测试证据（`file:line`） |
|---|---|---|---|
| C1 | 触发点与依赖注入（Step P1，B6 + P2-1） | ✅ | `packages/opencode/src/session/prompt.ts:1536-1561` 仅在 compaction task arm 返回 `continue` 时注入一次，提供 `Session`/`Agent`/`FSUtil`/`Config`/`Todo`/`Skill` 六项服务；`SessionPrompt.node`（`:2418-2450`）已声明 `Todo.node`、`Skill.node`。回归：`prompt.test.ts`（`enabled=false` 与 `Todo.Service` 两用例）。 |
| C2 | 溢出压缩与恢复预算协调（P1-2） | ✅ | `packages/opencode/src/session/compaction.ts:426-435` 扣留 `summaryReserve`；`prompt.ts:1538-1551,2502-2509` 按主模型剩余 headroom 计算 `maxBudgetTokens`（`restorationBudgetCap`）传入 `restoration.ts:422-447` 封顶 `budget_tokens`。回归：`prompt.test.ts` 紧窗口 46k 溢出恢复用例。 |
| C3 | 未回答批次保护边界（P1-1 + P2-2） | ✅ | `prompt.ts:2471-2500` `pendingInputStart` 仅在 `!row.info.error && row.info.finish && !["tool-calls","unknown"].includes(row.info.finish)` 中断回溯；`prompt.ts:1839-1850` 413 拒绝分支先删空 `handle.message` 再落 marker。回归：`prompt.test.ts` `finish: "error"` / `finish: "tool-calls"` / `summary.n` 精确性用例。 |
| C4 | 载体选择与 `write` 缓存失效（P2-3） | ✅ | `packages/opencode/src/session/restoration.ts:489-493` 排除未结算 marker 作为 carrier；`restoration.ts:98-99` 在 `edit` 与 `write` 时清除 `retainedFileVersions`。回归：`restoration.test.ts` 两项专项回归。 |
| C5 | 磁盘 skill 读前 `stat` 与去重优先（P2-4） | ✅ | `restoration.ts:218-230` 对磁盘 `SKILL.md` 先 `stat` 校验大小；`restoration.ts:190-290` 允许 `retainedVersion` 命中文件返回 `skipped-duplicate` 而不被 `max_files`/预算耗尽误标 `reference`；`restoration.ts:520-523` 与 `external-directory.ts:30-33` 统一 POSIX 分隔符。回归：`restoration.test.ts` 两项回归。 |
| C6 | Step P2–P8 全流程与 G4 退役语义 | ✅ | `restoration.ts:449-567` 显式标注 `Step P2`～`Step P8`；写入前就地标记旧 sentinel `ignored: true`，保证每上下文语义有效恢复块 ≤ 1；`message-v2.ts:615,634` 防重复摘要覆盖。 |
| C7 | 测试 Oracle 真实性与全量回归 | ✅ | `compaction.test.ts:2886-2980` 三连续压缩每轮均建真实 marker 并经 `filterCompactedEffect`；`pbt-render-materials.test.ts:37-73` 修正 `## Files` 精确切片、精确契约上界 `B + max(128,min(2000,B))` 与 `budget_tokens: 0 → undefined`。 |
| C8 | 首轮事前 `expectations.md` 缺失 | ⚠️ | 历史流程偏离，已在 `expectations.md` 与 `decisions.md` 记录接受，不追认。 |

完整收敛记录见 [docs/fixes/runtime-fix-pr60-audit-convergence.md](../../fixes/runtime-fix-pr60-audit-convergence.md)。
