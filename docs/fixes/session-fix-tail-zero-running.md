# Step tail：退窗后仍明确显示 0 running

## 第一部分：现象与复现

2026-11-10 01:10（UTC+08）ker79 恢复 mldsa1103 主会话时，子 Agent 最晚已于前晚 21:37 结束。该轮请求没有 step tail；模型却沿用旧的 running 叙述。日志能确认尾巴缺席，不能据此断言模型复述的唯一原因。

最小复现：已有四个直接子 Session，均 idle、run 已在两小时前结束；以当前时间减十分钟为窗口下界调用 `StepTail.renderSubagents`。当前返回 undefined，预期返回 `Your subagents: 0 running.`，由原有拼接同时附上当前时间。

## 第二部分：根因分析

`renderSubagents` 把“没有需要展示的明细”当成“没有状态需要传达”。完成明细退窗正确，但 running=0 同样是当前事实。两列表为空导致整个子 Agent 节消失；无重复提醒时，时钟也一起消失。

## 第三部分：参考定义对照

这是本仓库提示契约的局部纠正，无外部算法参考。沿用现有 R（所有 running 直接子）和 F（窗口内结束或未结算的 idle 直接子）：

- children 为空：不附带子 Agent 节。
- children 非空，R/F 都为空：只输出 `Your subagents: 0 running.`。
- R/F 至少一项非空：保持既有总览、排序、截断及明细。

## 第四部分：修复方案

只调整 `renderSubagents` 的第二个空判断及注释。`prompt.ts` 原有逻辑会为非空 section 附加 `Now: ...`。不改变运行状态、窗口、权限门、采集失败处理、Session 存储或 V2；不加查询工具指令。

## 第五部分：正确性论证

- 根因消除：已知子集合即使全部退窗，仍向每个请求提供零运行状态，包括新一次恢复执行。
- 不变量：R 包含全部 running 直接子，因此 R 为空时零运行事实成立；过期项不重新进入 direct/idle 计数。
- 副作用边界：纯渲染增加一行固定文本；无子、权限 deny、采集失败仍省略，不把读取失败冒充零状态。尾巴仍不落库。
- 复杂度：沿用现有采集和排序，仅空分支返回值改变。

## 第六部分：测试用例清单

| 类别       | 覆盖                                                                      | 状态                                                 |
| ---------- | ------------------------------------------------------------------------- | ---------------------------------------------------- |
| 回归       | 四个过期子保留零状态，新 running 子不带回旧计数                           | 通过；修前固定回归、窗口边界和两个 PBT 共 4 fail     |
| 边界与性质 | 窗口含等号、时间推进、空输入、无记录 idle、cut off；分类 PBT 和 T7 oracle | 通过；FastCheck 200/100 runs，seed 97103/97104       |
| 请求集成   | 退窗后零状态+时钟；重复提醒共存；数小时后新 loop 恢复仍有零状态；不持久化 | 通过；真实 prompt 五请求，最后一请求模拟三小时后恢复 |
| 相邻回归   | 无子/deny、窗口生命周期、step-tail 完整测试和 typecheck                   | 38 个定向用例全部通过；typecheck 通过                |

验证记录：首轮定向测试 37 pass / 1 fail，失败来自新增测试误用只含时分秒的 `formatClock` 作为完整时钟预期；改为已有的 `formatInstant` 后，该集成用例独立重跑 1 pass / 0 fail（26 断言）。生产修复未因该失败修改。未宣称全仓或 CI 验证。

## 第七部分：代码更新清单

- `packages/opencode/src/session/step-tail.ts`：空视图返回值与注释。
- `packages/opencode/test/session/step-tail.test.ts`：固定回归、边界和性质断言。
- `packages/opencode/test/session/prompt.test.ts`：真实请求与恢复执行回归。

状态：已实施并验证，随本 PR 提交；补丁未发布、未替换远端二进制。

## 第八部分：文档更新清单

- 同步 agent-management architecture、detailed-design、子计划 2、expectations 的空视图契约。
- 同步 research §18.3 的空视图说明。
- 同步 step-tail 原 fix 摘要；旧退窗 fix 保留历史验证，在开头标记空视图分支已由本补丁替代。
- decisions 追加零状态决策，保留历史 D51。

状态：已同步；decisions D55 记录了本次用户确认的语义。
