# 开发日志 — P2 grep 扩展实施

日期：2026-10-13
分支：`issue-46-runtime-alignment`
提交：`99dd22e3`
关联：issue #46 §三.4、`docs/design/grep-extension/architecture.md` 与 `detailed-design.md`

## 做了什么

按已确认的架构与细化设计实施 grep 扩展：

1. **core 新增 `Ripgrep.search`**（原 `grep` 原样保留——它有第二个消费者 `filesystem/search.ts`，实施时发现的漏查消费者）：三输出模式（content 默认 / files_with_matches / count）、`-i`、`-A/-B/-C` context 记录解析（`--json` 的 `type:"context"`）、offset/limit 分页（**按 match 计数**的有状态窗口，上下文行永不跨界拆分；rg 无 `--offset` flag 已实证，服务层切片）。
2. **tool 层**：schema 新增 7 个 optional 参数（缺省 = 旧行为逐字节一致）；校验拒绝 context>10 与非 content 模式带 context；三模式渲染（绝对路径统一）；三态结局（has-more 带下一 offset / 恰好到底 / offset 越界区分于无匹配）。
3. **wire schema 快照 +33 行**（7 新参数），随行为变更更新并记录理由。

## 关键决策与理由

- **`grep`/`search` 拆分而非改 `grep`**：实施时发现 `grep` 还有第二个消费者（`filesystem/search.ts` 依赖 Match 完整形状 + `MAX_SAFE_INTEGER` limit 语义）——初版消费者盘点漏了它。拆分让 legacy 消费者零改动、新能力不背兼容包袱（设计文档的偏离已记录）。
- **分页按 match 计数**（细化决策）：流内有状态窗口（pending 缓冲 + match 计数），上下文行跟随 match 永不拆分；已知边界 = rg 去重可能丢窗口边界一侧的上下文（match 永不丢）。
- **行预算公式** `matchesWanted × (2 + contextLines) + 64`：每 match ≥1 行、context ≤ contextLines，系数 2 吸收去重方差——保证 rowBound 不在 match 窗口内截断。

## 测试

- 新增 7 个用例（三模式含单文件裸 count 怪癖、上下文 `:`/`-` 前缀、分页三态、insensitive、校验拒绝×2）；既有 6 用例全过（其中截断文案断言随行为变更更新，理由在测试内注释）。
- 回归：core 1102/1102（含 `serializeToolContent` 格式固化与 ripgrep 既有测试）、opencode tool 目录 328 全过、**全套 3990 项 0 失败**、双包 typecheck 干净。

## 待办

- P2 剩余：后台 shell（独立设计流程）、按工具结果预算（倾向并入 artifact 协议讨论）。
- 行为抽查（真模型）继续挂起待用户。

## 度量

| 指标           | 数值                                                    |
| -------------- | ------------------------------------------------------- |
| 新增代码行数   | ~518（core search ~200 + tool ~120 + 测试 ~150 + 快照 33） |
| 修改代码行数   | ~45                                                     |
| 删除代码行数   | ~45（原 grep 内联块）                                   |
| 涉及文件数     | 4 + 1（本日志）                                         |
| 新增测试用例数 | 7                                                       |
| 测试通过率     | grep 13/13；core 1102/1102；全套 3990/3990              |
| 发现 bug 数    | 1（实施中自现：窗口上限误用 offset——被自己的探针用例抓住） |
| 修复 bug 数    | 1                                                       |
| 迭代轮次       | 实现 1 轮（2 次小修：窗口 bug、相对/绝对路径）          |

## 经验教训

- **消费者盘点要覆盖服务的全部方法调用方**：初版判定"`grep` 只有 tool/grep.ts 一个消费者"漏了 `filesystem/search.ts`——`grep`/`search` 拆分（新方法承载新能力、旧方法零改动）事后被证明是对的形态，但起因是 typecheck 抓住了漏查的消费者。消费者清单应来自 typecheck/编译器反馈兜底，不靠记忆。
- **探针先行**：写工具层之前先用临时探针验证服务层行为（本轮探针立刻暴露窗口上限 bug），比整链联调时再定位便宜一个量级。
- **行为变更的测试更新要把"回归目标"写进注释**：截断文案断言更新时保留"不出现未知总数"的负向断言并注明理由——测试意图比字面断言活得久。
