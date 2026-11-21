# Contract Audit Decisions — bgshell-1-background-exec（二轮修复后回填）

二轮审核 ⚠️ 项与处置（格式：项 → 决定 → 依据）：

1. **expectations 事前时序违例** → 接受偏离并记录，不追认 — 首轮已按事后补抽完成（expectations.md 顶部声明）；重写历史无意义，回归保护由测试承担。
2. **路径 A 机械检查缺失** → N/A + 跟踪说明 — fork 无自备检查器；Step Pn 注释已补齐（grepext P1-P9 / bgshell P2-P9 / comprec P1-P8 / prompt-1 P1-P4 标注于 src），接入检查器后立即可校验。
3. **二轮 R 项修复引发的契约口径变化** → 同步修订 expectations 对应行 — 预算例外（R4）、dedup 基线（R3）、分页顺序（R2）、后台读路径归属（R1/R5/R6）均已在本 subplan（如适用）的 expectations.md 内以"2026-11-05 修订"标注。

2026-11-21：并行停止生产者和已观察的任务，等待后按已发现的属主重读任务注册表。将接受的主动脱离进程语义写入架构，修正 P7 的顺序与 variant 继承；用真实工具验证回执预算与非 BMP 字符边界。

父会话的取消遍历所有已登记的 agent 委派关系，包括已结算的中间节点。只有仍在运行的所属任务会被取消；已完成的委派保留终态，其他会话的任务继续执行。
