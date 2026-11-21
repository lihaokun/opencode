# Contract Audit Report — grepext-1-search-params（二轮修复后回填）

> 状态：由 PR #60 二轮审核（2026-11-05）驱动回填。本报告按 workflow §6.5 路径 B 的产物结构记录，但**时序声明**：首轮实施未按 §6.2 事前产出 expectations（已在 expectations.md 顶部声明违例）；本报告与 decisions.md 是二轮修复后（commit 见 expectations.md 引用）整理的对照结论，不冒称事前独立审。

## 结论

- 二轮审核（reviewer 实测反例 + 代码对照）发现的全部 ❌ 项已在 HEAD 修复并补回归测试；修复明细见 PR #60 二轮修复 commits 与 devlog `docs/devlog/2026-11-05-pr60-second-review-round.md`。
- 路径 A（机械化检查）状态：**N/A**——本 fork 尚未自备 scripts/contract_audit 检查器（JSON Schema 校验 / Step 注释 grep / 共享枚举 import 检查）。Step Pn 注释已补（本轮 III.5），待检查器接入后即可 grep 校验。跟踪：暂无 issue，接入条件=首个下游项目需要。

## 2026-11-19 分页的文件及上下文归属

本轮独立审核先将旧实现的反例固化，再从最终模型请求或真实进程状态复验。真实 rg 小目录测试生成多个文件、相隔命中、before/after 和分页；额外验证相邻命中共享前文、非 UTF-8 辅助行、深 offset、结果字节预算及下一页或全文入口。已复核 61,200 个窗口。实现 P7、P8 对应流式计数和上下文选择；固定路径排序适用于全部模式。 验证与保留项汇总见 [本轮修复方案](../../fixes/runtime-fix-pr60-review.md)。
