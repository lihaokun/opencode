# Contract Audit Report — comprec-1-restoration（二轮修复后回填）

> 状态：由 PR #60 二轮审核（2026-11-05）驱动回填。本报告按 workflow §6.5 路径 B 的产物结构记录，但**时序声明**：首轮实施未按 §6.2 事前产出 expectations（已在 expectations.md 顶部声明违例）；本报告与 decisions.md 是二轮修复后（commit 见 expectations.md 引用）整理的对照结论，不冒称事前独立审。

## 结论

- 二轮审核（reviewer 实测反例 + 代码对照）发现的全部 ❌ 项已在 HEAD 修复并补回归测试；修复明细见 PR #60 二轮修复 commits 与 devlog `docs/devlog/2026-11-05-pr60-second-review-round.md`。
- 路径 A（机械化检查）状态：**N/A**——本 fork 尚未自备 scripts/contract_audit 检查器（JSON Schema 校验 / Step 注释 grep / 共享枚举 import 检查）。Step Pn 注释已补（本轮 III.5），待检查器接入后即可 grep 校验。跟踪：暂无 issue，接入条件=首个下游项目需要。

## 2026-11-19 摘要输入超限的分档恢复

独立审核先从修复契约抽取基准、分档、尾部上限、转录及事件要求，再对照实现与测试。初审发现最后一个候选可能不足目标仍被发送，以及第二次请求准备期间取消可能留下未结算摘要。两项修复后均已独立复核，阻塞项为零。

- 读取数值缺口优先。无数值时用同模型成功输入（含缓存）及本地估值差；旧会话、其他模型和没有样本分别有回归。
- 档位以首次输入为基准，整组重放成本单独受限。两组性质测试各 500 次，覆盖取整、整组跨档、候选单调且互异以及上限。
- 在真实 Session/processor 上注入 provider 超限，检查准确的消息分组、迟到输入顺序、成功/最终失败/取消的摘要行和错误事件。普通 prompt 的成功样本通过本机 HTTP 测试服务验证。
