# Contract Audit Report — `comprec-1-restoration`

> 状态：2026-11-24 独立审核并收敛修复后最终核对（§6.5 路径 B）。
> **时序声明**：首轮实施未按 §6.2 事前产出 `expectations.md`（已在 `expectations.md` 顶部记录流程偏离，不追认）。以下核对基于最终收敛后的工作树源码与实测结果，覆盖 2026-11-19～11-24 全部变更。

## 1. 结论（§6.6 退出标准）

- **Critical / Unresolved**：**0 critical / 0 unresolved**（一轮与二轮独立审核检出的全部功能、预算双口径、连续压缩重复计费、`finish: "stop"` 含工具调用、16–50 KiB 去重及测试 Oracle 问题均已修复并补回归测试）。
- **路径 A（机械检查）**：`Step P1–P8` 注释全部就位（`prompt.ts:1570`、`restoration.ts:482,517,537,562,567,571,580`）；`bun typecheck` 四包通过；`git diff --check` 零报错。验收由 [#46](https://github.com/lihaokun/opencode/issues/46) 与 [PR #60](https://github.com/lihaokun/opencode/pull/60) 跟踪。

## 2. 路径 B 逐项核对表

| 编号 | 契约项 | 判定 | 代码 / 测试证据（`file:line`） |
|---|---|---|---|
| C1 | 触发点与依赖注入（Step P1，B6 + P2-1） | ✅ | `packages/opencode/src/session/prompt.ts:1537-1580` 仅在 compaction task arm 返回 `continue` 时注入一次，提供 `Session`/`Agent`/`FSUtil`/`Config`/`Todo`/`Skill` 六项服务并复检 steering 后的最新模型；`SessionPrompt.node`（`prompt.ts:2462-2497`）已声明 `Todo.node`、`Skill.node`。回归：`prompt.test.ts`（`enabled=false` 与 `Todo.Service` 两用例）。 |
| C2 | 溢出压缩与恢复双口径预算协调（P1-2 + WS1-P2-1/2/3） | ✅ | `packages/opencode/src/session/compaction.ts:428-445` 扣除 `summaryReserve` 并在 `rawRequired` 中经 `withoutRestoration` 排除即将退役的旧恢复块；`prompt.ts:1538-1569,2539-2545` 按 `/3` 与 `/4` JSON 取最大消息开销并排除旧恢复块计算 `maxBudgetTokens`；`restoration.ts:348-452` 同时约束原始长度与 JSON 转义长度。回归：`prompt.test.ts` 紧窗口 JSON 溢出用例与 `pbt-render-materials.test.ts:197-274`。 |
| C3 | 未回答批次保护边界（P1-1 + P2-2 + WS1-P2-4） | ✅ | `prompt.ts:2502-2535` `pendingInputStart` 要求 `!hasToolCalls`（对齐 `runLoop:1446`），仅在非错误且无工具调用的终结助手或 `<= marker` 处中断回溯；`prompt.ts:1866-1877` 413 拒绝分支先删空 `handle.message` 再落 marker。回归：`prompt.test.ts` 与 `summary-recovery-budget.test.ts`（含 tool-bearing `stop` 与保留尾时间戳 PBT）。 |
| C4 | 载体选择与 `write` 缓存失效（P2-3） | ✅ | `packages/opencode/src/session/restoration.ts:522-526` 排除未结算 marker 作为 carrier；`restoration.ts:110-112` 在 `edit` 与 `write` 时清除 `retainedFileVersions`。回归：`restoration.test.ts` 专项回归。 |
| C5 | 磁盘 skill 读前 `stat` 与保留尾去重优先（P2-4 + WS1-P2-5） | ✅ | `restoration.ts:238-250` 对磁盘 `SKILL.md` 先 `stat` 校验大小；`restoration.ts:283-315` 对保留尾内 ≤64 KiB 文件先做 SHA-256 去重再判 `file_max_tokens`/`max_files`/预算耗尽；`restoration.ts:554-557` 与 `external-directory.ts:30-33` 统一 POSIX 分隔符。回归：`restoration.test.ts`（含 24 KB 保留尾去重回归）。 |
| C6 | Step P2–P8 全流程与 G4 退役语义 | ✅ | `restoration.ts:482-604` 显式标注 `Step P2`～`Step P8`；写入前就地标记旧 sentinel `ignored: true`，保证每上下文语义有效恢复块 ≤ 1；`message-v2.ts:618,638` 防重复摘要覆盖。 |
| C7 | 测试 Oracle 真实性与全量回归 | ✅ | `compaction.test.ts:2884-3010` 三连续压缩每轮均建真实 marker、经 `filterCompactedEffect` 并每轮调用 `SessionRestoration.apply` 验证 G4 退役；`pbt-render-materials.test.ts:39-70,197-274` 校验 `## Files` 切片、`B + D` 上界与 `/3` + `/4` JSON 双口径。 |
| C8 | 首轮事前 `expectations.md` 缺失 | ⚠️ | 历史流程偏离，已在 `expectations.md` 与 `decisions.md` 记录接受，不追认。 |

完整收敛记录见 [docs/fixes/runtime-fix-pr60-audit-convergence.md](../../fixes/runtime-fix-pr60-audit-convergence.md)。
