# Step tail：总览与完成明细共同退出窗口

用户确认的修复口径：已结束且退出窗口的子 Agent 不再计入尾巴；按 workflow 构建补丁。仅修改视图，不清理 Session、不改变 agent_list / agent_status 的查询范围。

## 第一部分：现象与复现

2026-11-03 ker79 的 `mldsa1103` 主会话 `ses_e5f839923ffelCmnTDYOp0d27b`：20:21 时四个子 Agent 已完成约 116–128 分钟；完成明细已消失，但每一步仍注入 `Your subagents: 4 direct, 0 running, 4 idle.`。主 Agent 在人审过程中持续复述“4 个 worker 空闲”。

路径：`SessionPrompt.subagentView → collectSubagents → renderSubagents → StepTail.message`。当前 `renderSubagents` 对 finished 做窗口过滤，却用所有 children 计算 direct/idle，且两列表空时仍返回总览。仅“全空时隐藏”不足：再启动一个 worker，旧的四个仍会被算入 idle。

最小复现（固化于 step-tail.test.ts）：四个 running=false、run.ended_at=now−2h 的 Child，在 windowStart=now−10min 下渲染。旧结果为 4 direct/0 running/4 idle；应为 undefined。再加入一个 running 子，应只显示 1 direct/1 running/0 idle。

## 第二部分：根因分析

筛选与统计使用了不同集合。设计细化 §5.3.1 还明确要求“两列表空时保留总览”，旧测试据此接受过期 idle 永久计数，故属于文档、实现和测试共同存在的语义偏差。不是窗口未推进、旧尾巴落库或 Session 未清理。

## 第三部分：参考定义对照

项目没有指定该投影的外部参考实现。采用集合定义作为独立 oracle，不复用生产过滤函数：

```text
R = 全部 running 的直接子（包括尚无 run 记录、或仍带上一关闭记录者）
F = idle 且有 run，且（run 未关闭 或 ended_at >= windowStart）的直接子
V = R ∪ F
direct = |V|; running = |R|; idle = |F|
V = ∅ ⇒ 不输出子 Agent 段
```

相同输入在旧实现中，F=∅ 却取 direct=|children|、idle=|children|−|R|；差异就在计数来源。空闲且没有 run 的子不属于任一列表，也不计入 V。

## 第四部分：修复方案

- 复用既有 running / finished 完整列表：未截断前求和作为 direct，finished.length 作为 idle。
- 两列表皆空时返回 undefined。prompt 既有拼接会自动省略此节；重复计数仍可独立产生尾巴与时钟。
- 保留窗口公式 `min(now−10min, previousStepStart)`、含等号边界、长步骤保底、cut off 例外、排序及每列表 10 行上限。计数包括因行数上限省略的有效条目。
- 同步主契约、细化、fix 摘要、research 和 expectations，标记旧“空列表保留总览”决策已被本修复取代。

## 第五部分：正确性论证

- 根因消除：统计直接取两个已筛选集合，过期结束项无法从另一条路径重新计入。只剩空闲旧 Session 时输出为空；新运行项出现时只恢复它自己的计数。
- 不变量：R/F 由 running 标志互斥，故 direct=running+idle，无重复计数。统计在截断前完成；排序/省略行及 cut off 的可见性保持。现有窗口推进机制不修改。
- 副作用边界：纯渲染函数不写数据、不改变运行状态或执行语义；没有可见子项时，重复提醒仍由独立 section 渲染。收集仍只有一次 children SQL 与一次状态投影。
- 终止性和复杂度：列表有限，沿用原筛选/排序；新增长度运算及空判定为常数开销。

## 第六部分：测试用例清单

| 类型     | 用例                                                                                                                       | 状态                                                                                   |
| -------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 回归     | ker79 四个早已完成的子不再产生总览；加一个运行中的只统计一个                                                               | 已加并通过：`expired children leave the overview...`；修前失败                         |
| 边界     | ended_at 在窗口边界前/等于/后；长步骤窗口；idle 无记录排除、running 无记录保留；cut off 保留                               | 已加并通过：含等号边界与既有形态用例                                                   |
| 性质     | FastCheck 分类生成，计数与独立分类标签一致；添加任意过期/无记录 idle 不影响输出；跨过结束时间边界后退出，未结算/运行项保留 | 已加并通过：200/100 runs，seed 97103/97104；两性质修前均失败                           |
| 集成     | 真实 prompt 四请求：完成项在窗内→过期无尾巴→重复提醒独立保留→重新运行一个子只计一个；Session 数据保留                      | 已加并通过：`expired subagent counts disappear...`                                     |
| 相邻回归 | 既有 T7/T11 计数 oracle 同步；600 子采集计数按有效记录；step-tail、prompt、run-state、agent-management 测试及 typecheck    | 定向 37 pass / 0 fail；typecheck 通过；完整回归 930 pass / 1 skip / 1 既有失败，见下文 |

旧 overview-only 测试的断言因用户已确认的契约纠正而更新；不以维持旧断言为目的绕开修复。修前纯函数回归/边界/PBT 共 4 fail，修后通过。首次请求集成被沙箱禁止本地监听（EPERM），不算根因 RED；允许 localhost 测试服务器后 37 项定向测试全过。

负向验证：在独立测试进程用 Bun loader 只把计数换回全量 children，保留新空判定，模拟“只隐藏全空视图”的不完整修复。固定回归在混合场景失败（5/1/4 对 1/1/0），FastCheck 缩至一个 running 加一个过期项后失败。两个负向测试均检出，工作区实现未改。

集成修前对照：在 `8d447f210b` 隔离 checkout 上仅放入新测试，保留旧生产代码；四请求用例在第二请求仍包含 `Your subagents:` 的断言失败（1 fail），修后通过。

完整回归：13 文件、932 条，930 pass / 1 skip / 1 fail，9052 断言。唯一失败为 Vertex Anthropic wire 缺少 `thinking.block_binding`；在同一依赖环境的未改 `dev`（`8d447f210b`）和补丁分支上独立运行此用例均同样失败。此文件与其生产路径未修改，按既有失败记录，不掩盖或计为通过。跳过项为既有 V2 projector disabled。此次未声称全仓或 CI 全绿。

## 第七部分：代码更新清单

| 文件                                             | 改动                               | 状态               |
| ------------------------------------------------ | ---------------------------------- | ------------------ |
| packages/opencode/src/session/step-tail.ts       | renderSubagents 的统计集合及空视图 | 已实施，提交后回填 |
| packages/opencode/test/session/step-tail.test.ts | 回归、边界、FastCheck、T7 oracle   | 已实施，提交后回填 |
| packages/opencode/test/session/prompt.test.ts    | 请求集成、T11/600 子计数           | 已实施，提交后回填 |

## 第八部分：文档更新清单

| 文档                                                             | 更新                             | 状态               |
| ---------------------------------------------------------------- | -------------------------------- | ------------------ |
| docs/design/agent-management/subplans/agentmgmt-2-run-state.md   | §4.5/§5.3/测试口径及旧规则替代   | 已同步，提交后回填 |
| docs/design/agent-management/architecture.md、detailed-design.md | 视图出现条件与计数范围           | 已同步，提交后回填 |
| docs/research/agent-management-research.md                       | 记录已结束项共同退窗的澄清       | 已同步，提交后回填 |
| docs/fixes/session-fix-step-tail-repeat-and-agents.md            | §4.9 指向统一口径                | 已同步，提交后回填 |
| docs/audits/agentmgmt-2-run-state/expectations.md                | S14/S16、INV-8b 及 PBT           | 已同步，提交后回填 |
| docs/audits/agentmgmt-2-run-state/decisions.md、audit-report.md  | 保留历史审核、追加本补丁独立复核 | 待同步             |
