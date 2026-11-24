# PR #60 独立审核收敛修复方案（2026-11-24）

> 流程：`docs/workflow.md` §7.1 八部分与三轨同步。
> 基线：`158cad7d2df3008f31879f3f4b86f62578a72125`（PR #60 独立全量审核起点）。
> 关联：[#46](https://github.com/lihaokun/opencode/issues/46)、[PR #60](https://github.com/lihaokun/opencode/pull/60) 与四大子计划设计与审计文档。

## 1. 现象与复现

在 `158cad7d2d` 上执行独立全量审核与实测探针，定位并复现了 **10 项 P1 阻塞缺陷**、**14 项 P2 重要缺陷**及 6 处测试 Oracle 漏洞：

1. **压缩与恢复（P1-1, P1-2, P2-1～P2-4）**：
   - `pendingInputStart` 在 `finish: "error"` 不可见助手或 `finish: "tool-calls"` 中间态提前 `break`，导致溢出压缩丢弃未回答 `U1` 及其工具结果。
   - 溢出压缩与 `SessionRestoration` 各自独立估算预算（`/3` vs `/4`），紧上下文窗口下默认开启的恢复块将已成功压缩的会话推入假性 `ContextOverflowError`。
   - `prompt.ts` 调用 `SessionRestoration.apply` 漏传 `Config`/`Todo`/`Skill` 服务且 `SessionPrompt.node` 缺 `Todo.node`/`Skill.node`，导致 `enabled: false` 在独立图层失效且 todo/skill 恢复静默降级。
   - provider 413 拒绝分支未删空 `handle.message` 使 `summary.n` 虚增 1；`restoration.ts` 未排除未结算 marker、`write` 未失效读缓存、磁盘 `SKILL.md` 未先 `stat`、`max_files` 检查先于去重。
2. **P0 结果可见性 / Core V2 / MCP / CodeMode（P1-3, P1-4, P2-11, P2-12）**：
   - Core V2 压缩序列化未读 `part.state.outputPaths` 且不识别 `ToolOutputStore.bound` 标记，真实 V2 落盘路径被完全丢弃；`savedOutputPath` 单次 `.exec` 易被前部引用遮蔽真实尾部错误路径。
   - CodeMode 沙箱内 `publicErrorMessage` 将截断 MCP 错误的 `Full output saved to: <path>` 脱敏成 `<redacted-path>`；失败 `withLogs` 与非 `McpError` 传输错误缺少截断上限。
3. **后台 Shell 与进程组生命周期（P1-5～P1-7, P2-5～P2-10）**：
   - `SessionRunState.cancel` 不取消已被后台 shell/`agent_send` 唤醒的活跃后代 runner；`ShellTool` 后台分支不检 `ctx.abort`；`Permission.disabled` 未将 `shell_output`/`shell_kill` 别名为 `bash`（导致内置 `explore` 不可见且 `bash: deny` 泄露二者）。
   - `ShellKillTool` 对无 `shellTasks` 条目的运行任务拒杀并误报 `already settled (running)`、已结算分支泄漏内部 `exit N`/`stopped` 首行；`Session.remove` 缺委派树循环取消；`BackgroundJob.cancel` 先解析 `done` 再关闭 `Scope`；`CrossSpawnSpawner` 非零退出不触发 `forceKillAfter` 且取消后 `Deferred.await(signal)` 无超时上限；错误截断破坏单行/UTF-16 代理对。
4. **Grep 与测试基建（P1-8～P1-10, P2-13, P2-14）**：
   - `contentPage` 在 `hasMore` 收齐末条 `after` 行或文件 `end` 时未停流，继续读取后续文件可能被无关超长行击穿；`GrepTool` 先拼分页续页提示再经 `Truncate.output` 截断导致续页指引丢失；非 UTF-8 `match` 行在 `content` 模式崩溃；行尾 `\n` 使 `Truncate` 行预算减半；`files_with_matches` 缺页头、`count` 越界混用 `matches` 单位；`oversizedRecord` 在长行上跑未锚定正则；`test/preload.ts` 在无代理环境强设 `no_proxy="*"`。

## 2. 根因分析

- **跨模块不变量未收口**：压缩保护边界（`pendingInputStart` vs `protectedStart`）、预算口径（`compaction` `/3` vs `restoration` `/4`）、权限别名（`agent_status` vs `shell_output/shell_kill`）、会话取消级联（`run-state` vs `session.remove`）和截断协议（V1 `Truncate` vs Core V2 `ToolOutputStore` vs CodeMode 沙箱脱敏）分别在局部补丁中演进，产生边界错位。
- **测试 Oracle 与真实实现脱钩**：多处测试 mock 掉了真实截断文案/路径、未在轮间建真实 compaction marker、或未覆盖多文件/`after > 0`/非 UTF-8 `match`/活跃后代 runner/独立 `SessionPrompt.node` 装配。

## 3. 参考行为对照

- 压缩回溯终止条件对齐 `compaction.ts:138` 与 `prompt.ts:1440`（仅非错误且非 `tool-calls`/`unknown` 的完成助手结束当前待处理批次）。
- `Permission.disabled` 对齐 `agent_status -> agent_list` 先例（Step S24），将 `shell_output`/`shell_kill` 统一映射至 `bash`。
- Core V2 工具结果截断对齐 `packages/core/src/tool-output-store.ts:159` 与 `ToolStateCompleted.outputPaths` 一等 schema 字段。
- CodeMode 保持 `@opencode-ai/codemode` 沙箱内部路径脱敏安全边界，在宿主侧按本次调用记录的 `outputPath` 精确还原 `Full output saved to: <path>`。
- `gemini.txt:12,41` 尊重历史维护者决议 D12 与 E② 最小刀法，不改写模板正文，改为在架构与审计文档中显式记档为已知残留冲突。

## 4. 实施方案

1. **压缩与恢复**：收紧 `pendingInputStart`；`compaction.ts` 预留 `summaryReserve` 并透传 `outputTokenMax`；`prompt.ts` 引入 `restorationBudgetCap` 向 `SessionRestoration.apply` 传入 `maxBudgetTokens`、完整注入 `Config`/`Todo`/`Skill` 并在 `SessionPrompt.node` 声明依赖、413 拒绝路径删除零 part 占位助手；`restoration.ts` 补齐 `write` 缓存失效、排除未结算 marker、磁盘 skill 读前 `stat`、已保留文件去重优先于 `max_files`/预算降级、todo 专用降级文案、POSIX `external_directory` 归一化及完整 `Step P2–P8` 标记；`message-v2.ts` 防重复摘要覆盖、`summary-budget.ts` 加 `?.length ?? 0` 防护。
2. **P0 / Core V2 / MCP / CodeMode**：`tool-result-projection.ts` 新增 `savedOutputPaths` 同时匹配 V1（含 CRLF）与 V2 `ToolOutputStore` 标记，`savedOutputPath` 取尾项；Core V2 `compaction.ts` 接收 `part.state.outputPaths` 合并去重并修正单复数；`code-mode.ts` 宿主侧追踪截断 `outputPath` 还原 `<redacted-path>` 并在脚本失败时对 `withLogs` 截断；`mcp/catalog.ts` 归一化 `-0` 判等、跳过 `null` `error.data`、对非 `McpError` 传输错误走 `truncateError`。
3. **后台 Shell 与进程组**：`run-state.ts` 在取消 quiesce 循环中同步取消已发现后代会话的 `Runner`；`session.ts` 升级 `cancelBackgroundJobs` 遍历委派树循环至静默，`handlers/session.ts` 删除会话前先 `promptSvc.cancel` 并转发 `deliverAsync` 第二参数；`permission/index.ts` 增加 `shell_output`/`shell_kill → bash` 别名；`shell.ts` 三处检查 `ctx.abort.aborted`、`background.start` 失败清理 `shellTasks`、引入 `errorPreview`/`splitStatusOutput`、修复 `shell_kill` 孤立运行任务与前缀剥离、修复 `task_id: ""`；`background-job.ts` 调换 `Scope.close` 先于 `Deferred.succeed(done)`；`cross-spawn-spawner.ts` 非零退出走 `SIGTERM → waitGroupGone → SIGKILL`、取消 `SIGKILL` 等待加 1s 上限。
4. **Grep / 提示词 / 测试基建**：`ripgrep.ts` 传递 `{"type":"end"}` 并在 `contentPage` 立即停流、用 `RgText` + `Schema.UnknownFromJsonString` 支持非 UTF-8 `match`/`context` 行、剥离 `\r?\n`、`oversizedRecord` O(1) 化、校验 `count` 非负整数；`grep.ts` 先 `trunc.output` 再拼续页与单页声明、修正 `count` 越界单位与 `files_with_matches` 页头；清理 `default.txt`/`trinity.txt` 空 `# Code style` 标题；`test/preload.ts` 仅在启动时存在代理时设置 `no_proxy="*"`。

## 5. 正确性论证

- **预算上界封闭**：`restorationBudgetCap` 对任意 `headroom` 满足 `(B + max(128, min(2000, B))) * 4 / 3 <= headroom`，同时覆盖 `estimatePayload`（`/3`）与 `willOverflow`（`/4`），故紧窗口溢出恢复不再因恢复块误报 `ContextOverflowError`。
- **取消循环终止**：`SessionRunState.cancel` 与 `Session.cancelBackgroundJobs` 维护单调增长的有限 `owners` 集合；每轮取消不可逆地中止活跃 runner（阻断新登记）并将运行中 job 转为 `cancelled`，有限步内归零；`BackgroundJob.cancel` 先 `Scope.close` 后解析 `done` 消除进程清理竞态。
- **Grep 有界流终止**：`contentPage` 收到 `hasMore` 后仅收集至 `last.line + after` 或当前文件 `{"type":"end"}` 即返回 `true` 中断子进程，不再读入后续无关文件。
- **安全边界保持**：CodeMode 仅在宿主侧按本次调用真实生成的 `outputPath` 精确替换 `Full output saved to: <redacted-path>`，不放宽沙箱内部通用路径脱敏规则。

## 6. 测试用例清单（全部实跑通过）

| 覆盖项 | 测试文件 | 新增 / 修正用例 | 状态 |
|---|---|---|---|
| P1-1 + P2-2 | `packages/opencode/test/session/prompt.test.ts`、`summary-recovery-budget.test.ts` | `overflow recovery preserves unanswered user turns across assistant finish error and tool-calls`；`PBT: pendingInputStart`（500 runs） | ✅ 通过 |
| P1-2 | `packages/opencode/test/session/prompt.test.ts`、`pbt-render-materials.test.ts` | 紧窗口溢出恢复集成用例；`PBT: restorationBudgetCap bounds renderMaterials under /3 estimateMessages`（500 runs） | ✅ 通过 |
| P2-1 | `packages/opencode/test/session/prompt.test.ts` | `SessionPrompt respects compaction.restoration.enabled=false`、`SessionPrompt wires Todo.Service into post-compaction restoration when enabled` | ✅ 通过 |
| P2-3 + P2-4 | `packages/opencode/test/session/restoration.test.ts` | 未结算 marker 不抢载体、`write` 失效缓存、磁盘 skill 读前 `stat`、保留尾重复文件优先 `skipped-duplicate`、`PBT: retainedFileVersions` 状态机（300 runs） | ✅ 通过 |
| Oracle 修复 | `packages/opencode/test/session/compaction.test.ts`、`pbt-render-materials.test.ts` | 三连续压缩真 marker + `filterCompactedEffect`；`## Files` 精确切片、精确上界、`budget_tokens: 0 → undefined` | ✅ 通过 |
| P1-3 + P2-11 | `packages/core/test/session-compaction.test.ts` | V2 `ToolOutputStore` 标记 + `outputPaths`（含短正文不丢 `outputPaths`）+ 多引用 + CRLF、`PBT: V2 serializeToolContent`（200 runs）与 `PBT: summarizeToolError`（200 runs） | ✅ 通过 |
| P1-4 + P2-12a | `packages/opencode/test/tool/code-mode.test.ts` | 沙箱外还原真实落盘路径（caught & uncaught）、失败脚本超大 `console.log` 截断（2 例） | ✅ 通过 |
| P2-12b + P3 | `packages/opencode/test/mcp/catalog.test.ts`、`pbt-mcp-projection.test.ts` | 非 `McpError` 传输错误截断、`null` `error.data` 省略、`PBT: all MCP failure kinds`（100 runs）、`-0` 语义判等去重 PBT（200 runs） | ✅ 通过 |
| P1-5, P1-6, P2-5, P2-6, P2-10a | `packages/opencode/test/tool/shell-background.test.ts` | 后代唤醒 runner 取消、预取消 `ctx.abort`、`shell_kill` 孤立运行任务与前缀剥离、空 `task_id` 与多行/非 BMP 错误（4 例） | ✅ 通过 |
| P1-7, P2-7, P2-8 | `test/permission/next.test.ts`、`test/session/session.test.ts`、`core/test/background-job.test.ts` | `shell_output`/`shell_kill` 别名跟随 `bash`、`Session.remove` 后代级联、`BackgroundJob.cancel` 先关 Scope 后解 `wait` | ✅ 通过 |
| P1-8～P1-10 + P2-13 | `packages/opencode/test/tool/grep.test.ts`、`pbt-grep-pagination.test.ts` | 文件末停流防后续 80 KiB 毒丸、非 UTF-8 `match` 行、单页截断保留续页与单页声明、1,200 短行不误截、页头与 `files` 单位、多文件上下文与提前停流可观测流 PBT（400 runs × 5） | ✅ 通过 |

## 7. 代码更新清单

| 包 / 文件 | 改动摘要 |
|---|---|
| `packages/core/src/session/tool-result-projection.ts` | `savedOutputPaths`（V1 CRLF + V2 `ToolOutputStore`）、`savedOutputPath` 取尾项、`hasOutputPath` 双格式 |
| `packages/core/src/session/compaction.ts` | `serializeToolContent` 接入 `part.state.outputPaths` 并修正单复数提示 |
| `packages/core/src/ripgrep.ts` | O(1) `oversizedRecord`、`RgText`+`decodeRgText`、`Schema.UnknownFromJsonString`、`{"type":"end"}` + `contentPage` 提前停流、剥离 `\r?\n`、`count` 校验 |
| `packages/core/src/background-job.ts` | `cancel` 先 `Scope.close` 后 `Deferred.succeed(done)` |
| `packages/core/src/cross-spawn-spawner.ts` | 非零退出升级 `SIGTERM → waitGroupGone → SIGKILL`、取消 `SIGKILL` 等待 1s 上限 |
| `packages/opencode/src/session/prompt.ts` | `pendingInputStart` 收紧、`restorationBudgetCap` + `maxBudgetTokens`、`Config`/`Todo`/`Skill` 接线与 `SessionPrompt.node` 依赖、413 删空占位、`deliverAsync` 签名对齐 |
| `packages/opencode/src/session/compaction.ts` | `summaryReserve`、`preserveRecentBudget` 透传 `outputTokenMax`、`metadata?.outputPath` 防护、去解构 |
| `packages/opencode/src/session/restoration.ts` | `maxBudgetTokens` 封顶、`write` 失效、排除未结算 marker、磁盘 skill `stat`、去重优先于 `max_files`、POSIX 路径归一化、`Step P4/P5/P8` 标记 |
| `packages/opencode/src/session/summary-budget.ts`、`message-v2.ts`、`tools.ts` | `?.length ?? 0` 防护、防重复摘要覆盖、消除 `else if`/冗余解构 |
| `packages/opencode/src/session/run-state.ts`、`session.ts`、`handlers/session.ts` | 后代活跃 runner 取消、`Session.remove` 委派树循环取消、HTTP `remove` 先 cancel 后删除、`deliverAsync` 透传 `identity` |
| `packages/opencode/src/permission/index.ts` | `shell_output` / `shell_kill` 别名为 `bash` |
| `packages/opencode/src/tool/shell.ts`、`shell/tasks.ts` | `ctx.abort` 守卫、`onError` 清理、`errorPreview`/`splitStatusOutput`、`shell_kill` 孤立运行任务与前缀剥离、空 `task_id`、注释与类型导入整理 |
| `packages/opencode/src/tool/grep.ts` | `Schema.Schema.Type<typeof Parameters>`、先截断后拼续页与单页声明、`files_with_matches` 页头、`count` 越界单位 |
| `packages/opencode/src/tool/code-mode.ts`、`mcp/catalog.ts` | 宿主侧还原 `<redacted-path>`、失败 `withLogs` 截断、非 `McpError` 截断、`null` `error.data` 跳过、`-0` 语义判等 |
| `packages/opencode/src/session/prompt/{default,trinity}.txt`、`test/preload.ts` | 移除空 `# Code style` 标题；`preload.ts` 仅在启动时存在代理时设置 `no_proxy="*"` |

## 8. 文档更新清单（三轨同步）

| 文档路径 | 同步内容 |
|---|---|
| `docs/design/{compaction-recovery,background-shell,grep-extension,prompt-unification}/{architecture,detailed-design}.md` | 对齐实际实现与 §4.3.1/§4.3.2 循环/函数论证；诚实记档 `gemini.txt:12,41` 已知残留冲突与 9 份活跃模板 |
| `docs/audits/{comprec-1-restoration,bgshell-1-background-exec,grepext-1-search-params,prompt-1-shared-agreement}/{expectations,audit-report,decisions}.md` | 同步契约期望、逐项路径 B `✅/⚠️` 核对表（`0 critical / 0 unresolved`）与去噪决策记录 |
| `docs/fixes/{session-fix-mcp-structured-content-projection,session-fix-summary-tool-output-truncation,session-fix-summary-retained-count,runtime-fix-pr60-audit-convergence}.md` | 回填收敛修复结论并新建本 §7.1 八部分完整记录 |
| `docs/research/runtime-alignment-research.md` | 同步 §7 决策表 #1–#11 实施与收敛口径 |
