# 开发日志 — P2 后台 shell 实施

日期：2026-10-14
分支：`issue-46-runtime-alignment`
提交：`ff732e89`
关联：issue #46 §三.5、`docs/design/background-shell/architecture.md` 与 `detailed-design.md`

## 做了什么

按已确认的架构与细化设计实施后台 shell：

1. **bash schema 新增 `run_in_background`**（缺省 false，同步路径零改动）；后台分支把进程完整生命周期（spawn → 输出累积 → 退出等待 → 完成通知）放进 `BackgroundJob.start` 的 job-scoped run Effect——工具立即返回 task_id，进程与调用解耦。timeout 在后台模式不适用（写入参数描述）。
2. **完成通知**：复用 agent 委派的 `ops.deliverAsync` 通道——`[shell task finished] <task_id> <command> · exit N` + 输出尾部作为消息注入会话并唤醒 loop；注入失败 ignore + 不影响任务状态。
3. **`shell_output`**：状态（running/exit/cancelled/error）+ 输出尾部（tail_lines 默认 200），缺省本会话最近任务；**`shell_kill`**：`BackgroundJob.cancel`（进程组终止），幂等。两工具不 ask（自有会话自有任务，对齐 agent_list/agent_stop 模式），无新权限键。
4. **registry 接线**：`shell_output`/`shell_kill` 加入 builtin。

## 关键决策与理由

- **进程生命周期进 job scope 的 run Effect**：spawn 在 run 内的 `Effect.scoped` 中获取——job scope 持有 fork，工具返回后进程存活；无需句柄搬运。
- **通知放 run 末尾而非 settle 钩子**：`BackgroundJob` 无 settle 回调——通知作为 run 的最后一步（`Effect.exit` 包裹进程体后、按成败分支构造 body 后 re-raise）恰好一次执行，且失败仍能让 settle 记为 error。
- **通知正文含 task_id**（对设计的小增强）：模型需要 id 关联后续的 shell_output/shell_kill。
- **实施中三次类型/结构修正**：execute 的 R 通道泄漏（`BackgroundJob.Service` 改为 ShellTool gen 层捕获）、`cmd` 位置参数形式、新工具缺 Schema 导入——均由 typecheck 指出。

## 测试

- 新增 6 个用例（真进程）：立即返回 + 注册表 running、输出续读（interim running → kill → cancelled）、完成通知真实投递（recorded promptOps 捕获 `[shell task finished]` + `exit 7` + task_id）、kill 终止、同步路径零变更回归、未知任务可诊断错误。
- **端到端补齐（`e5e20304`）**：wire 级用例——loop 中 fake LLM 发起 `run_in_background` 的真实 bash 调用；进程退出后通知经**真实 deliverAsync** 注入会话并唤醒新一轮请求，捕获的载荷含 `[shell task finished]`、`bg-done-marker` 与 `exit 0`。prompt.test 106 项全过。
- 回归：shell.test 23/23（同步零变更）、tool 目录 334 全过（含 bash wire schema 快照 +4 行更新）、**全套 3997 项 0 失败**、双包 typecheck 干净。

## 待办

- P2 第三项"按工具结果预算"：维持降级记录（P0-3 + truncate 已覆盖主场景），待 artifact 协议讨论合并考虑。
- 行为抽查（真模型）：dev server / watcher 场景跑一遍 run_in_background → 通知 → shell_output 全流程。
- 已知界限（记录于模块注释）：`shellTasks`/`BackgroundJob` 进程本地——重启丢任务；超长会话 × 大量后台任务的内存界限。

## 度量

| 指标           | 数值                                                    |
| -------------- | ------------------------------------------------------- |
| 新增代码行数   | ~374（后台分支 + 两工具 + 测试 + schema + 注册）        |
| 修改代码行数   | ~1                                                      |
| 删除代码行数   | 0                                                       |
| 涉及文件数     | 5 + 1（本日志）+ 1（bash wire schema 快照）             |
| 新增测试用例数 | 6                                                       |
| 测试通过率     | shell-background 6/6；shell.test 23/23；全套 3997/3997  |
| 发现 bug 数    | 0（3 次类型/签名修正如期由 typecheck 指出）             |
| 修复 bug 数    | 0                                                       |
| 迭代轮次       | 实现 1 轮                                               |

## 经验教训

- **Tool.define 的 Metadata 由同步执行路径的返回形状推断**：新增执行分支的返回 metadata 必须符合既有形状（`{output, exit, truncated, outputPath?}`），额外键会因 ExecuteResult 泛型约束被拒——task_id 放进 output 文本而非 metadata。
- **`Tool.Context` 的 R 通道必须是 never**：execute 内不得 `yield* Service`——服务在 Tool.define 的 gen 层捕获后闭包使用（fork 既有模式）。typecheck 的 R 泄漏报错出现在 layer 定义处而非 execute 处，定位时要看泛型展开的最后一行。
- **`cmd` 是位置参数构造器**（shell/shellKind/cwd/env 四参），不收对象——与 spawner.spawn 的配合照抄同步路径即可。
