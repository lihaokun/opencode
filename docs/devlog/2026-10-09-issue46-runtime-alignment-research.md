# 开发日志 — issue #46 调研与讨论轮

日期：2026-10-09
分支：`issue-46-runtime-alignment`（自 `dev@1343833857` 切出）
关联：lihaokun/opencode#46、`docs/research/runtime-alignment-research.md`

## 做了什么

对 issue #46 展开动手前的调研与讨论轮，未改任何产品代码：

1. **P0 断言逐项核实**（3/3 成立）：shell 退出码投影缺口、MCP structuredContent 投影丢失、摘要输入二次截断。修正了 issue 对根因位置的两处描述（MCP 应修 `tools.ts` 投影层而非 catalog，因 content-first 是上游有意设计且有固化测试；通用工具全文 hint 在尾部，二次截断是常态而非边缘情况）。
2. **五项专项调查**：工具 metadata 投影面盘点（结论：全工具仅 bash `exit` 值得投影）、MCP 投影仓库内先例（code-mode `projectMcpResult`）、core runner 消费者确认（两套并行 runtime，core 份 serialize 是活代码）、提示词装配矩阵（共享段唯一结构正确位置 = `request.ts:195` 三元之后）、压缩恢复既有机制盘点（`applyAgentRoster` 是可复用模板；todo 零注入路径等缺口清单）。
3. **决策点整理**：8 个待拍板问题连同事实、选项、倾向写入调研文档 §4/§6。
4. 过程性发现：`!cmd` 直执行路径丢弃 `handle.exitCode`；`plan` reminder 依赖可被压缩抹掉的 `agent === "plan"` 历史标志；`session.compacted` 事件无任何生产消费方。
5. 经验教训回写 CLAUDE.md「已知限制与注意事项」一条（两套并行 runtime）。

## 关键决策与理由

- **先 P0 后 P1、先讨论后动手**：P0 三项是投影/截断缺口，验收标准明确、改动面小；提示词统一依赖 runtime 语义先稳定（issue 自述"修改 prompt 不能替代 runtime 修复"）。
- **修复不动 catalog、不引入通用 metadata allowlist**：前者与上游固化测试冲突，后者为一个字段背整个排除契约（无消费者不设 seam）。
- **P0-3 必须双份同改**：core runner 经 `cli serve` / sdk-next 可达，是活代码（见 CLAUDE.md 新增条目）。

## 待办（下一轮）

- 用户逐项拍板调研文档 §6 的 8 个问题。
- 拍板后：P0-1/2/3 各出 §7.1 修正方案文档（含回归测试计划），经确认后实现。
- P1 提示词统一、压缩恢复各自开 feature 设计流程。
- 上游 sync 风险跟踪：upstream 已把 `agent` → `task` 改名，与 agent-management 区正面重叠，P0 宜尽早。

## 度量

| 指标           | 数值                                          |
| -------------- | --------------------------------------------- |
| 新增代码行数   | 0                                             |
| 修改代码行数   | 0（CLAUDE.md 新增 1 条注意事项，非代码）      |
| 删除代码行数   | 0                                             |
| 涉及文件数     | 3（调研文档、本日志、CLAUDE.md）              |
| 新增测试用例数 | 0                                             |
| 测试通过率     | N/A（未改产品代码，未跑回归）                 |
| 发现 bug 数    | 7（3 个 P0 投影/截断缺陷 + 4 个次级缺口：!cmd 丢码、MCP 错误路径 sc 丢失、resource_link/audio 静默丢弃、todo 零注入路径） |
| 修复 bug 数    | 0                                             |
| 迭代轮次       | 调研 2 轮（初步核实 + 五项专项调查），设计 0 轮 |

## 经验教训

- **"看起来像死代码"必须查消费者到生产入口**：core 的第二份 serialize 差点被按"只改一份"处理；顺着 `cli serve` → server routes → `SessionExecutionLocal` 才确认是活代码。判定死代码的标准是"无生产可达链"，不是"主产品不调用"。
- **投影类缺陷先盘投影面再定方案**：先盘点全部工具的 metadata 与正文冗余情况，才能识别"通用 allowlist 投影"是过度设计、窄投影（字段存在性驱动）才是正解。
- **修契约缺口前先查既有行为是否"有意设计"**：MCP content-first 是上游 commit + 固化测试的有意行为，直接改 catalog 会与上游永久对抗；定位到正确的层（tools.ts 投影）才能修得干净。
- **装配类改动先画装配链**：`agent.prompt` 三元替换语义决定了共享行为段的唯一合法位置；不查装配链就动手，会在 `system.ts::provider` 里埋下"显式 prompt agent 静默丢失共享段"的结构性陷阱。
