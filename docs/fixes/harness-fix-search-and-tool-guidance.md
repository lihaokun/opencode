# V1 搜索范围与工具提示修正

## 1. 现象与复现

- `grep({path: "a.txt", pattern: "needle"})` 会返回同目录 `b.txt` 中的匹配；不存在的文件路径也会退回父目录。原单文件测试目录只有一个文件，未检出扩大的搜索范围。
- 达到嵌套深度上限的 Agent 没有 `agent` 工具，但长输出的截断提示仍要求委派给 explore，并禁止自行读取完整输出。
- GPT 系统提示要求只能通过 `multi_tool_use.parallel` 并行，但 V1 没有注册该工具。

前两项已用隔离目录中的真实实现复现；第三项由生效的 GPT 模板与工具注册表对照确认。

## 2. 根因

grep 将文件路径转换成父目录 `cwd` 后，没有传递 `Ripgrep.GrepInput.file`，且吞掉 stat 错误。
截断提示只依据 Agent 定义权限决定是否委派，不了解实际工具可见性。
GPT 模板混入了当前宿主不存在的并行接口名称。

## 3. 参考对照

上游 [#22356](https://github.com/anomalyco/opencode/pull/22356) 曾修复文件搜索；
[#31566](https://github.com/anomalyco/opencode/pull/31566) 重构时丢失了 V1 的 file 参数。
当前 [上游 grep](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/tool/plugin/grep.ts)
和本库 Core 文件系统搜索都按文件类型传入 basename。这里只修 V1，不改 V2。
并行调用使用宿主原有的一次回复包含多个独立工具调用的能力，不新增工具。

## 4. 方案

- grep 明确支持文件或目录；文件调用传 `./` 前缀加 basename，目录搜索维持原行为。保留显式前缀，避免名为 `-` 的普通文件被 ripgrep 当成 stdin；不能用会折叠前缀的 `path.join(".", basename)`。
- 无法确认目标类型时失败，不再扩大范围；找不到路径给出明确错误。保留权限检查与软链接路径展示。
- 截断输出统一提示使用 Grep 或 Read 的 offset/limit 查看已保存内容，不强制委派。删除只用于选择该文案的 Agent 参数及调用方查询。
- GPT 模板改为在同一次回复中并行调用互不依赖的工具，去掉不存在的工具名。

## 5. 正确性与范围

文件路径作为独立参数传给 ripgrep，其余同目录文件不参与匹配；include 仍由原后端处理（显式文件路径优先于 include glob）。
搜索目标、显示路径与权限语义继续沿用现有流程。截断阈值、保存文件、预览方向与完整输出不变。
工具说明调整不改变可调用工具、权限或调度。其余 harness 审核项不在本次范围。

## 6. 验证

- grep：目标与兄弟文件同时匹配；仅兄弟文件匹配；相对路径及特殊文件名（含文件名恰为 `-` 的绝对路径和 `./-`）；不存在的文件/目录；软链接与 include。
- 截断：保留完整输出，头/尾截断均提供读取方式；深度受限 Agent 收到的工具结果不再要求委派。
- GPT：沿用现有模板选择测试，确认 GPT 路由不变。
- 运行相关工具、消息通知测试及 `bun typecheck`。

状态：四个 grep 回归在旧实现上全部失败；修复后相关工具、截断、Agent、系统提示及 Session 工具测试共 75 pass / 0 fail；Tool.define/插件注册包装 22 pass / 0 fail；真实 agent_send/完成通知回归 1 pass / 0 fail。合计 98 项通过，`bun typecheck` 通过。缺失路径、特殊文件名、文件/目录软链接和显式路径优先于 include 的行为均有覆盖；Windows 效果由 PR CI 验证。

CI 补正：首次完整分片检出 grep 参数说明的 JSON Schema 快照未同步（1048 pass / 1 fail）。已将快照同步为 file or directory，并运行完整 `test/tool/parameters.test.ts`：54 pass / 0 fail，15 个快照通过；保持原快照断言。

PR 复审补正：文件名恰为 `-` 时原 basename 参数被 ripgrep 当成 stdin。新增真实 GrepTool 回归先在 `79327c63b1` 上失败，再以显式 `./` 前缀修正；同时补齐 S21、行为契约、§5.4.3 和上位架构中遗留的状态查询提示要求。完整 grep 测试 11 pass / 0 fail，`bun typecheck` 通过；回归覆盖绝对路径和 `./-`，并验证兄弟文件不被搜索。

## 7. 代码更新清单

- `tool/grep.ts`、`tool/grep.txt`、grep 回归：目标范围和错误处理。
- `tool/truncate.ts`、`tool/tool.ts`、`tool/registry.ts`、`session/tools.ts` 及截断/Agent 工具测试：统一读取提示并移除无用参数。
- `session/prompt/gpt.txt`：修正并行调用说明。

## 8. 文档同步

本文件记录依据、范围和验证；grep 的参数说明及工具描述同步支持文件路径。
不改 Agent 管理状态契约、FSM Stop、规划权限或 V2。
