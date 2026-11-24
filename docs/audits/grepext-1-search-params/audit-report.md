# Contract Audit Report — `grepext-1-search-params`

> 状态：2026-11-24 独立审核并收敛修复后最终核对（§6.5 路径 B）。
> **时序声明**：首轮实施未按 §6.2 事前产出 `expectations.md`（已在 `expectations.md` 顶部记录流程偏离，不追认）。以下核对覆盖 2026-11-19～11-24 全部变更，并在真实本地 `rg` 二进制下全量运行验证。

## 1. 结论（§6.6 退出标准）

- **Critical / Unresolved**：**0 critical / 0 unresolved**（一轮与二轮独立审核检出的提前停流、截断续页顺序、非 UTF-8 `match` 解码、`count` `/^\d+$/u` 校验与 `Showing files` 分页范围行、PBT 覆盖均已修复并实测通过）。
- **路径 A（机械检查）**：`Step P1–P9` 注释全部就位（`grep.ts:12,63,65,78,90,119,136`、`ripgrep.ts:175,393`）；`bun typecheck` 四包通过；`git diff --check` 零报错。验收由 [#46](https://github.com/lihaokun/opencode/issues/46) 与 [PR #60](https://github.com/lihaokun/opencode/pull/60) 跟踪。

## 2. 路径 B 逐项核对表

| 编号 | 契约项 | 判定 | 代码 / 测试证据（`file:line`） |
|---|---|---|---|
| G1 | `hasMore` 后提前停流（P1-8） | ✅ | `packages/core/src/ripgrep.ts:423,453-498` 传递 rg `{"type":"end"}` 事件，`contentPage` 在 `hasMore` 且收齐 `last.line + after` 或遇到 `{ end: true }` 时立即返回 `true` 停流。回归：`grep.test.ts` 后续文件 80 KiB 毒丸行测试。 |
| G2 | 截断与续页提示顺序（P1-9） | ✅ | `packages/opencode/src/tool/grep.ts:154-170` 先对单页主体调用 `trunc.output(body)` 再拼接续页提示，`page.truncated && result.hasMore` 时附加单页保存声明与 `increase offset`。回归：`grep.test.ts`。 |
| G3 | 非 UTF-8 `match` 行解码（P1-10） | ✅ | `packages/core/src/ripgrep.ts:34-65,420-441` 以模块级 `UTF8_DECODER` + `RgText`（`{ text } \| { bytes }`）+ `decodeRgText` 统一解码 `match` 与 `context` 行，并用 `Schema.UnknownFromJsonString` 替代手写 `JSON.parse`。回归：`grep.test.ts` `0xFF` match 行测试。 |
| G4 | 行尾换行剥离、页头、单位与 O(1) 过滤（P2-13 + WS4-P2-1/2） | ✅ | `ripgrep.ts:28-32` `oversizedRecord` O(1) `startsWith`；`ripgrep.ts:462` 剥离 `\r?\n`；`ripgrep.ts:355-366` 用 `/^\d+$/u` + `Number.isSafeInteger` 严格校验 `count`；`grep.ts:172-207` 修正 `count` 越界单位为 `files` 并为 `files_with_matches` 与 `count` 均输出 `Showing files` 分页范围行。回归：`grep.test.ts`（1,200 短行、`files_with_matches`/`count` 页头与越界单位用例）。 |
| G5 | 多文件 + `before`/`after` 上下文与提前停流 PBT | ✅ | `test/tool/pbt-grep-pagination.test.ts:16-202` 覆盖多文件、多 `before`/`after` 组合与可观测提前停流（400 runs × 5 properties + 1 锚点单测）。 |
| G6 | 首轮事前 `expectations.md` 缺失 | ⚠️ | 历史流程偏离，已在 `expectations.md` 与 `decisions.md` 记录接受，不追认。 |

完整收敛记录见 [docs/fixes/runtime-fix-pr60-audit-convergence.md](../../fixes/runtime-fix-pr60-audit-convergence.md)。
