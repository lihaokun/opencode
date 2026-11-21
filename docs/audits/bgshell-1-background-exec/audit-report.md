# Contract Audit Report — bgshell-1-background-exec（二轮修复后回填）

> 状态：由 PR #60 二轮审核（2026-11-05）驱动回填。本报告按 workflow §6.5 路径 B 的产物结构记录，但**时序声明**：首轮实施未按 §6.2 事前产出 expectations（已在 expectations.md 顶部声明违例）；本报告与 decisions.md 是二轮修复后（commit 见 expectations.md 引用）整理的对照结论，不冒称事前独立审。

## 结论

- 二轮审核（reviewer 实测反例 + 代码对照）发现的全部 ❌ 项已在 HEAD 修复并补回归测试；修复明细见 PR #60 二轮修复 commits 与 devlog `docs/devlog/2026-11-05-pr60-second-review-round.md`。
- 路径 A（机械化检查）状态：**N/A**——本 fork 尚未自备 scripts/contract_audit 检查器（JSON Schema 校验 / Step 注释 grep / 共享枚举 import 检查）。Step Pn 注释已补（本轮 III.5），待检查器接入后即可 grep 校验。跟踪：暂无 issue，接入条件=首个下游项目需要。

## 2026-11-19 后台状态机与通知

本轮独立审核先将旧实现的反例固化，再从最终模型请求或真实进程状态复验。增加带 seed 的 30 组 start/read/kill/finish 操作序列；读取与停止核对实际 stdout 和所有权。真进程覆盖不响应 TERM 的子进程、父 shell 先退出、配置字节/行预算与 UTF-8、通知失败、同毫秒排序。真实提示词通路验证完成通知继承当前身份。 验证与保留项汇总见 [本轮修复方案](../../fixes/runtime-fix-pr60-review.md)。
