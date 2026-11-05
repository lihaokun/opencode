# Contract Audit Decisions — prompt-1-shared-agreement（二轮修复后回填）

二轮审核 ⚠️ 项与处置（格式：项 → 决定 → 依据）：

1. **expectations 事前时序违例** → 接受偏离并记录，不追认 — 首轮已按事后补抽完成（expectations.md 顶部声明）；重写历史无意义，回归保护由测试承担。
2. **路径 A 机械检查缺失** → N/A + 跟踪说明 — fork 无自备检查器；Step Pn 注释已补齐（grepext P1-P9 / bgshell P2-P9 / comprec P1-P8 / prompt-1 P1-P4 标注于 src），接入检查器后立即可校验。
3. **二轮 R 项修复引发的契约口径变化** → 同步修订 expectations 对应行 — 预算例外（R4）、dedup 基线（R3）、分页顺序（R2）、后台读路径归属（R1/R5/R6）均已在本 subplan（如适用）的 expectations.md 内以"2026-11-05 修订"标注。
