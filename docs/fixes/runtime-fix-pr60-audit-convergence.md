# PR #60 独立审核收敛修复方案（一轮 + 二轮，2026-11-24）

> 流程：`docs/workflow.md` §7.1 八部分与三轨同步。
> 基线：首轮审核起点 `158cad7d2d`（收敛至 `18b8c50a6c`）；二轮零上下文对抗复审起点 `18b8c50a6c`（收敛至 `21f59cd53a` + 本文档提交）。
> 关联：[#46](https://github.com/lihaokun/opencode/issues/46)、[PR #60](https://github.com/lihaokun/opencode/pull/60) 与四大子计划设计与审计文档。

## 第一部分：现象与复现

在 `158cad7d2d`（首轮）与 `18b8c50a6c`（二轮零上下文对抗复审）上分四域执行代码级与实测复核，定位并复现了以下问题：

1. **压缩、溢出恢复与材料恢复**
   - **最小复现与调用链**：
     - 首轮：`pendingInputStart`（`prompt.ts:2502-2535`）在 `finish: "error"` 或 `"tool-calls"` 提前截断丢弃 `U1`；溢出恢复未给 `SessionRestoration.apply` 传 `maxBudgetTokens` 与 `Config`/`Todo`/`Skill` 服务；413 拒绝分支（`prompt.ts:1866-1877`）未删空 `handle.message`；`restoration.ts` 缺 `write` 失效、未排除未结算 marker、磁盘 `SKILL.md` 未先 `stat`、`max_files` 早于去重。
     - 二轮：`restorationBudgetCap`（`prompt.ts:2539-2545`）仅按 `/3` 估算约束原始长度且未对 `headroom` 取整，含大量 `"`/`\`/`\n` 的恢复 JSON（如 `headroom = 12_000` 注入 27.7 KB `{"a":"b","c":"d"}\n`）通过 `estimateMessages` 却触发 `compaction.willOverflow`（`compaction.ts:255-258`，`/4` JSON 估算）；连续压缩中未退役的旧恢复块在 Step P8 之前被重复计入 `messagesTokens` / `mandatory`；`pendingInputStart` 遗漏 `runLoop:1446` 的 `!hasToolCalls` 守卫；`materializeCandidates`（`restoration.ts:283-315`）先判 16 KB `file_max_tokens` 再做 SHA-256 去重，将保留尾中未修改的 16–50 KiB 完整文件误标为 `reference`；非溢出用量压缩漏传 `fixed_input_tokens` 且 `prompt.ts:1538` 缺 steering 后的模型/用户复检。
2. **P0 结果可见性 / Core V2 / MCP / CodeMode**
   - **最小复现与调用链**：
     - 首轮：Core V2 `serializeToolContent`（`packages/core/src/session/compaction.ts:90-104`）未读 `part.state.outputPaths` 且不识别 `ToolOutputStore.bound` 标记；CodeMode 沙箱内 `publicErrorMessage`（`packages/codemode/src/interpreter/runtime.ts:151-152`）把截断错误路径脱敏成 `<redacted-path>`；失败 `withLogs` 与非 `McpError` 传输错误无截断。
     - 二轮：`code-mode.ts` 按位置下标替换 `<redacted-path>` 在含空格/引号路径（如 `/Users/Jane Doe/...`）、捕获忽略 A 再暴露 B、同一错误日志+抛出、并发顺序或客体伪造场景下损坏或错配路径；成功路径先 `JSON.stringify` 再文本替换在 Windows `\` 或 `"` 路径下产出非法 JSON；`savedOutputPaths`（`packages/core/src/session/tool-result-projection.ts:45-64`）未识别 `ShellTool` 截断头（`...output truncated...\n\nFull output saved to: <path>`），`summarizeToolError` 仅保尾项，V1 completed 压缩忽略内嵌子错误路径，Core V2 `shell` 压缩未提路径；`McpCatalog.callTool`（`packages/opencode/src/mcp/catalog.ts:100-124`）放行非 `Error` 原始 reject 值且未保护内部 `DOMException("AbortError")`。
3. **后台 Shell、取消级联、Spawner & 权限**
   - **最小复现与调用链**：
     - 首轮：`SessionRunState.cancel` 漏取消被唤醒的后代 runner；`ShellTool` 后台分支不检 `ctx.abort`；`Permission.disabled` 未把 `shell_output`/`shell_kill` 映射至 `bash`；`ShellKillTool` 拒杀无 `shellTasks` 条目的运行任务并泄漏内部首行；`Session.remove` 缺委派树循环取消；`BackgroundJob.cancel` 先解析 `done` 再关 `Scope`。
     - 二轮：`BackgroundJob.cancel`（`packages/core/src/background-job.ts:288-332`）先写 `status: "cancelled"` 再 `Scope.close` 且未包 `Effect.uninterruptible`，并发 `wait`/二次 `cancel` 提前返回且中断调用方会泄露 OS 进程并永久挂起 waiter；`SessionRunState.cancel`（`packages/opencode/src/session/run-state.ts:89-138`）跳过根会话自身被后台 job 重唤醒的 `Runner` 且未遍历持久化 SQLite 子会话；`ShellTool`（`packages/opencode/src/tool/shell.ts:758-766,817-819`）缺少 `ask` 前与 `background.start` 后 `ctx.abort` 守卫；`Permission.disabled`（`packages/opencode/src/permission/index.ts:240-262`）无条件改写别名静默吞掉显式 `shell_output: deny` / `shell_*: deny`；`CrossSpawnSpawner`（`packages/core/src/cross-spawn-spawner.ts:345-495`）`handle.kill` 缺 `waitProcessGroupGone` 与 1 秒 `SIGKILL` 上限且释放器跳过 `code === null`。
4. **Grep 扩展、提示词统一与测试基建**
   - **最小复现与调用链**：
     - 首轮：`contentPage` 在 `hasMore` 收齐末条 `after` / 文件 `end` 后未停流；`GrepTool` 先拼续页再 `Truncate.output` 丢失续页提示；非 UTF-8 `match` 行崩溃；行尾 `\n` 使行预算减半；`oversizedRecord` 在长行跑正则；`default.txt`/`trinity.txt` 残留空 `# Code style` 标题；`test/preload.ts` 无代理时强设 `no_proxy="*"`。
     - 二轮：`ripgrep.ts:358-364` `count` 解析用 `Number(...)` 放行 `""`/`"   "`/`"1e2"`/`"0x10"`；`tool/grep.ts:193-207` `count` 模式漏输出 `Showing files` 分页范围行；`test/preload.ts:102-109` 在无代理环境未清理宿主 `no_proxy`/`NO_PROXY`；`httpapi-listen.test.ts` 其余 5 个真 TCP listener WebSocket 用例未套用 `testPtyRealListener`；三份 `audit-report.md` 行号与跨 7 份文档 `gemini.txt:12,41`（应为 `12,43`）存在漂移。

## 第二部分：根因分析

- **跨模块不变量未收口**：压缩边界（`pendingInputStart` vs `runLoop`）、双预算口径（`/3` `estimatePayload` vs `/4` JSON `willOverflow`）、退役与计费顺序（`withoutRestoration` vs Step P8）、沙箱内外路径标识（正则位置替换 vs 单次执行不透明 token）、取消原子性（状态公开 vs `Scope.close` vs 外部 replacement run 契约 `agentmgmt-2-run-state` T10）以及 `Permission.disabled` 继承与显式覆盖规则，分别在局部修补中出现边界错位。
- **弱化/重言测试断言掩盖回归**：`background-job.test.ts` 在 `cancel` 返回后才断言 `finalized`；`shell-background.test.ts` 用偶数 18 字符前缀未触发高代理裁剪；`code-mode.test.ts` 用伪造文案 mock 替代真实截断；`pbt-render-materials.test.ts` 未验 JSON 转义与小数 `headroom`；`pbt-mcp-projection.test.ts` 未构造左值 `"-0"` 文本；`compaction.test.ts` 三连压缩只在第 3 轮调 `apply`。

## 第三部分：参考行为对照

- 压缩回溯终止条件对齐 `prompt.ts:1442-1446`（非错误、非 `"tool-calls"`/`"unknown"` 且 `!hasToolCalls`）。
- 恢复预算双口径同时对齐 `summary-budget.ts:8-25`（`/3`）与 `compaction.ts:255-258`（`/4` `JSON.stringify`）。
- 权限可见性对齐 `Permission.disabled` 末匹配规则：`shell_output`/`shell_kill` 继承 `bash` 规则同时尊重显式 `shell_output`/`shell_kill`/`shell_*` 规则。
- `SessionRunState.cancel` 对齐 `agentmgmt-2-run-state` T10 契约：无后台 job 取消时保留 wind-down 期间外部新启的 replacement run；仅当本树确实取消了后台 job 时将根 `Runner` 纳入静默重检。
- CodeMode 保持 `@opencode-ai/codemode` 沙箱零宿主路径暴露，同时用单次执行 128-bit 不透明 token 达成跨平台（含 Windows/空格/引号）精确 1:1 还原。
- `gemini.txt:12,43` 尊重 D12 与 E② 最小刀法，不改写模板正文，仅修正 7 处文档行号与审计记档。

## 第四部分：修复方案

1. **P0 / Core V2 / MCP / CodeMode（`70d4638991`、`320389c20a`）**：
   - `code-mode.ts`：入沙箱前将 `out.outputPath` 替换为单次执行随机不透明 token（`__opencode_artifact_<nonce>_<id>__`），出沙箱后对 `result.value` 在 `JSON.stringify` 之前递归还原、对 `logs` 与失败消息独立还原；失败路径 `withLogs` 走 `truncate.output(..., { error: true })`。
   - `tool-result-projection.ts` + Core V2 `compaction.ts` + V1 `compaction.ts`：`savedOutputPaths` 统一识别 V1 `Truncate`（CRLF）、`ShellTool` 截断头与 Core V2 `ToolOutputStore` 标记；新增 `appendMissingOutputPaths` 统一去重、32 KiB 限流、剔除首换行并校验非截断边界伪命中（`hasOutputPath`）；V1 completed 压缩与 Core V2 `shell`/tool 压缩及 `summarizeToolError` 全部复用。
   - `mcp/catalog.ts`：导出共享 `parsesTo`（双侧 JSON 归一化兼容 `-0`）；`formatErrorData` 安全处理循环 `Object.create(null)` 与 BigInt；`callTool` 保护内部 `DOMException("AbortError")` 并对非 `Error` 原始 reject 值走 `truncateError`。
2. **压缩、溢出恢复与材料恢复（`88b46a3a12`、`95505a7e66`）**：
   - `restoration.ts`：导出 `withoutRestoration`；`materializeCandidates` 对保留尾 ≤64 KiB 文件先比对 SHA-256 返回 `skipped-duplicate` 再判 `file_max_tokens`；`inlineBudget` 与 `renderMaterials` 同时约束原始 UTF-16 与 `JSON.stringify` 转义长度（`maxJson = floor(maxRaw * 4 / 3)`）；补全 `write` 失效、磁盘 skill `stat`、POSIX `external_directory` 与 `Step P2–P8`。
   - `prompt.ts` + `compaction.ts` + `summary-budget.ts`：`restorationBudgetCap` 先对 `headroom` 取 `Math.floor`；`prompt.ts:1537-1569` 复检 steering 后最新 user/model、按 `withoutRestoration` 排除即将退役旧块并取 `max(/3, /4 JSON)` 核算 headroom；`compaction.ts` 在 `budgeted` 统一预留 `summaryReserve`、在 `rawRequired` 中剥离即将退役旧块并允许无限主窗+有限摘要窗的分段恢复；用量触发压缩传递 `fixedInputTokens`；`pendingInputStart` 补 `!hasToolCalls`；413 拒绝先删空占位；`providerGap` 在无效 `direct` 时回退 `total`。
3. **后台 Shell、取消级联、Spawner & 权限（`fb84eb0f66`、`d065ff8465`）**：
   - `background-job.ts`：`cancel` 包裹 `Effect.uninterruptible` 并用 `Effect.ensuring` 保证 `Scope.close` 后必定完成 `job.done`；`wait` 与并发 `cancel` 均以 `Deferred.isDone(job.done)` / `Deferred.await(job.done)` 等待清理完成；清理死属性 `onPromote`。
   - `tool/shell/tasks.ts` + `run-state.ts` + `session.ts`：抽取共享 `cancelBackgroundJobsPass` 消除重复代码；`SessionRunState.cancel` 遍历持久化 SQLite `Session.children` 并在取消到后台 job 时将根 `Runner` 纳入静默重检（无后台 job 时保持 `agentmgmt-2-run-state` T10 replacement run 契约）；`handlers/session.ts` 删除前先 `promptSvc.cancel` 并转发 `deliverAsync` 第二参数。
   - `tool/shell.ts`：入口、`ask` 前、`backgroundRun` 入口与 `background.start` 后（竞态取消立即 `background.cancel`）四处守卫 `ctx.abort.aborted`；移除未使用 `SessionID` 导入；清洗 `job.title` 换行；自然结算竞态返回 `already settled`。
   - `permission/index.ts`：`shell_output`/`shell_kill` 以 `Wildcard.match(tool, rule.permission) || Wildcard.match("bash", rule.permission)` 继承 `bash` 同时尊重显式规则。
   - `cross-spawn-spawner.ts`：抽取共享 `waitProcessGroupGone`（`code !== "ESRCH"`，不误判 `EPERM`），覆盖 `code !== 0`（含 `code === null`）并让 `handle.kill` 与释放器对称带 1 秒 `SIGKILL` 超时。
4. **Grep / 提示词 / 测试基建（`a824cc3c8a`、`21f59cd53a`）**：
   - `ripgrep.ts`：模块级 `UTF8_DECODER`、`RgText` + `Schema.UnknownFromJsonString`、`{"type":"end"}` + `contentPage` 提前停流、剥离 `\r?\n`、O(1) `oversizedRecord`、`count` 严格 `/^\d+$/u` + `Number.isSafeInteger`。
   - `tool/grep.ts`：先 `trunc.output` 再拼续页与单页声明；`files_with_matches` 与 `count` 分页均输出 `Showing files` 范围行；`count` 越界统一 `files` 单位；去除多余类型标注。
   - `default.txt`/`trinity.txt` 删空 `# Code style` 标题；`test/preload.ts` 无代理时清理 `no_proxy`/`NO_PROXY`；`httpapi-listen.test.ts` 全量 6 处真 TCP listener 用例统一守卫 `testPtyRealListener`。

## 第五部分：正确性论证

- **双口径预算封闭（`/3` + `/4` JSON）**：令 `H = Math.floor(headroom)`、`B = restorationBudgetCap(headroom)`、`D = max(128, min(2000, B))`。当 `B > 0` 时 `(B + D) * 4 <= 3 * H`；`renderMaterials` 与 `inlineBudget` 同时强制 `text.length <= (B + D) * 4` 与 `JSON.stringify(text).length <= Math.floor((B + D) * 4 * 4 / 3) <= 4 * H`，故同时满足 `Math.ceil(text.length / 3) <= H <= headroom`（`estimatePayload`）与 `Token.estimate(JSON.stringify(text)) <= H <= headroom`（`willOverflow`），对任意转义字符与小数 `headroom` 均成立（500 次随机 PBT + 紧窗口 JSON 集成测试验证）。
- **CodeMode 路径精确性与隔离**：每次错误截断的 `outputPath` 在进入沙箱前即替换为 128-bit 随机不透明 token（仅含 `[a-z0-9_]`），客体永不接触宿主路径且无法伪造其他调用的 token；出沙箱后先递归还原 `result.value` 再 `JSON.stringify`，保证任意含空格/引号/Windows 反斜杠的路径均产出合法 JSON 且 1:1 归属准确。
- **取消原子性与循环终止**：`BackgroundJob.cancel` 经 `Effect.uninterruptible` 与 `Effect.ensuring(Deferred.succeed(done))` 保证 `Scope.close` 必完成且并发 `wait`/二次 `cancel` 必阻塞至清理结束；`SessionRunState.cancel` 在有限会话图与有限运行 job 上单调扩充 `owners`，每轮取消不可逆地结束目标 job/runner，有限步归零，且无后台 job 时严格维持 `agentmgmt-2-run-state` T10 replacement run 不变量。
- **Grep 有界流终止**：`contentPage` 收到 `hasMore` 后仅收集至 `last.line + after` 或当前文件 `{"type":"end"}` 即返回 `true` 中断子进程；`count` 解析经 `/^\d+$/u` 杜绝隐式 `Number("") === 0` 等畸形行。

## 第六部分：测试用例清单（全部实跑通过）

| 类型 | 测试文件 | 用例概述 | 状态（回填 commit hash） |
|---|---|---|---|
| 回归 + PBT | `packages/opencode/test/session/prompt.test.ts`、`summary-recovery-budget.test.ts` | `pendingInputStart`（含 `error`/`tool-calls`/tool-bearing `stop`/保留尾 `<= marker` 时间戳，500 runs）、413 删占位、`providerGap` 回退 | ✅ `88b46a3a12`、`95505a7e66` |
| 回归 + PBT | `packages/opencode/test/session/prompt.test.ts`、`pbt-render-materials.test.ts` | 紧窗口 JSON 转义溢出恢复集成；`PBT: restorationBudgetCap` 验证 `/3` 与 `/4` JSON 双口径及小数 `headroom`（500 runs）；`## Files` 切片与 `max_files: 3`（300 runs） | ✅ `88b46a3a12`、`95505a7e66` |
| 回归 + 新增 | `packages/opencode/test/session/prompt.test.ts`、`restoration.test.ts`、`compaction.test.ts` | `enabled=false`、`Todo.Service` 接线、24 KB 保留尾 `skipped-duplicate`、三连续压缩每轮 `apply` 校验 G4 退役、V1 completed 内嵌 `savedOutputPaths`、`PBT: retainedFileVersions`（300 runs） | ✅ `88b46a3a12`、`95505a7e66` |
| 回归 + PBT | `packages/core/test/session-compaction.test.ts` | V2 `ToolOutputStore` + `ShellTool` 截断头 + 空/短正文 `outputPaths` + 截断边界防伪命中 + `summarizeToolError` 多路径、双 PBT（200 runs × 2） | ✅ `70d4638991`、`320389c20a` |
| 回归 + 新增 | `packages/opencode/test/tool/code-mode.test.ts`、`mcp/catalog.test.ts`、`pbt-mcp-projection.test.ts` | 空格/引号/Windows 路径 + 捕获忽略 A/暴露 B + 日志与抛出重复 + JSON 返回合法性 + 伪造 `<redacted-path>` 隔离；非 `Error` 原始 reject 截断、`DOMException("AbortError")`、循环无原型/BigInt/原始值 `McpError.data`；左值 `"-0"` 语义去重 PBT（200 runs） | ✅ `70d4638991`、`320389c20a` |
| 回归 + 新增 | `packages/core/test/background-job.test.ts`、`opencode/test/tool/shell-background.test.ts`、`permission/next.test.ts`、`session/session.test.ts`、`agent-management/lifecycle.test.ts` | `BackgroundJob.cancel` 中途并发 `wait`/二次 `cancel` 与调用方中断仍完成 `Scope.close`；根重唤醒取消、DB 持久化子会话取消、`ask` 前与 `start` 中 abort、奇数前缀高代理裁剪与标题清洗、TERM-resistant 完整过期验证、`shell_output`/`shell_kill`/`shell_*` 显式规则与 `bash` 继承、T10 全量 32/32 回归 | ✅ `fb84eb0f66`、`d065ff8465` |
| 回归 + PBT | `packages/opencode/test/tool/grep.test.ts`、`pbt-grep-pagination.test.ts`、`session/system.test.ts` | 80 KiB 后续文件毒丸停流、非 UTF-8 `match`、单页截断保留续页、1,200 短行、`count` 分页 `Showing files` 行与越界 `files` 单位、多文件上下文与提前停流 PBT（400 runs × 5）、`not.toContain("# Code style")` | ✅ `a824cc3c8a`、`21f59cd53a` |

## 第七部分：代码更新清单

| 包 / 文件 | 函数 / 行号 | 改动概述 | 状态（回填 commit hash） |
|---|---|---|---|
| `packages/core/src/session/tool-result-projection.ts` | `savedOutputPaths`, `hasOutputPath`, `appendMissingOutputPaths`, `summarizeToolError`（`:45-123`） | 支持 V1 CRLF / `ShellTool` / V2 `ToolOutputStore`；截断边界校验；共享 32 KiB 限流多路径追加 | ✅ `70d4638991`、`320389c20a` |
| `packages/core/src/session/compaction.ts` | `serializeToolContent`, `serialize`（`:85-145`） | 接入 `part.state.outputPaths` 并为 `shell` 与 completed 复用 `appendMissingOutputPaths` | ✅ `70d4638991`、`320389c20a` |
| `packages/opencode/src/tool/code-mode.ts` | `invokeChildTool`, `CodeModeTool`（`:136-350`） | 单次执行不透明 token 脱敏与 `JSON.stringify` 前递归还原；失败 `withLogs` 截断 | ✅ `70d4638991`、`320389c20a` |
| `packages/opencode/src/mcp/catalog.ts` | `parsesTo`, `formatErrorData`, `callTool`, `convertTool`（`:25-156`） | 共享 `-0` 归一化判等；循环无原型/BigInt 安全格式化；保护 `DOMException("AbortError")`；截断非 `Error` reject | ✅ `70d4638991`、`320389c20a` |
| `packages/opencode/src/session/prompt.ts` | compaction arm, `recoveryMarker`, 413/usage, `pendingInputStart`, `restorationBudgetCap`（`:1537-1580,1751-1885,2462-2545`） | steering 复检、排除退役旧块、`/3`+`/4` headroom、用量压缩 `fixedInputTokens`、`!hasToolCalls`、`Math.floor(headroom)`、六服务接线 | ✅ `88b46a3a12`、`95505a7e66` |
| `packages/opencode/src/session/compaction.ts` | `serialize`, `processCompaction`（`:72-88,425-445,532-538`） | V1 复用 `appendMissingOutputPaths` 保留内嵌路径；`rawRequired` 排除退役旧块；`summaryReserve`；无限主窗分段恢复 | ✅ `88b46a3a12`、`95505a7e66` |
| `packages/opencode/src/session/restoration.ts` | `withoutRestoration`, `materializeCandidates`, `inlineBudget`, `renderMaterials`, `restore`（`:38-45,238-315,348-452,482-604`） | 64 KiB 保留尾 SHA-256 优先去重；原始+JSON 双预算裁剪；`write` 失效；skill `stat`；`Step P2–P8` | ✅ `88b46a3a12`、`95505a7e66` |
| `packages/opencode/src/session/summary-budget.ts`、`message-v2.ts`、`tools.ts` | `providerGap`（`:47-61`）、`filterCompacted`（`:618,638`） | `providerGap` 无效 `direct` 回退 `total`；防重复摘要覆盖；去 `else`/冗余解构 | ✅ `88b46a3a12`、`95505a7e66` |
| `packages/core/src/background-job.ts` | `wait`, `cancel`（`:277-332`） | `cancel` `Effect.uninterruptible` + `Scope.close` 先于 `done`；并发 `wait`/二次 `cancel` 等待 `done` | ✅ `fb84eb0f66`、`d065ff8465` |
| `packages/core/src/cross-spawn-spawner.ts` | `waitProcessGroupGone`, release finalizer, `handle.kill`（`:345-495`） | 共享 `ESRCH` 进程组等待；覆盖 `code !== 0`（含 `null`）；`handle.kill` 对称补齐 1s `SIGKILL` 上限 | ✅ `fb84eb0f66`、`d065ff8465` |
| `packages/opencode/src/tool/shell/tasks.ts`、`session/run-state.ts`、`session/session.ts`、`handlers/session.ts` | `cancelBackgroundJobsPass`, `SessionRunState.cancel`, `Session.cancelBackgroundJobs`, `remove` | 共享单 Pass 级联消重；DB 子会话遍历；有后台 job 取消时重检根 `Runner`；HTTP 删除先 cancel 后 remove | ✅ `fb84eb0f66`、`d065ff8465` |
| `packages/opencode/src/tool/shell.ts`、`permission/index.ts` | `backgroundRun`, `execute`, `ShellOutputTool`, `ShellKillTool`, `Permission.disabled` | 四处 `ctx.abort` 防护（含 `ask` 前与 `start` 后取消）；删未使用导入；标题清洗与 `already settled`；`shell_output`/`shell_kill` 继承 `bash` 并尊重显式规则 | ✅ `fb84eb0f66`、`d065ff8465` |
| `packages/core/src/ripgrep.ts`、`opencode/src/tool/grep.ts`、`prompt/{default,trinity}.txt`、`test/preload.ts` | `decodeRgText`, `count` parser, `contentPage`, `GrepTool.execute`, preload | 模块级 `UTF8_DECODER`、提前停流、`count` `/^\d+$/u` 与 `Showing files` 范围行、无代理清 `no_proxy`、删空 `# Code style` | ✅ `a824cc3c8a`、`21f59cd53a` |

## 第八部分：文档更新清单（三轨同步）

| 文档路径 | 同步内容 | 状态（回填 commit hash） |
|---|---|---|
| `docs/design/{compaction-recovery,background-shell,grep-extension,prompt-unification}/{architecture,detailed-design}.md` | 同步状态头、精确行号与函数签名、双口径预算与 `pendingInputStart`/`GrepTool` §4.3.2 论证、取消级联与权限规则、修正 `gemini.txt:12,43` | ✅ `18b8c50a6c` + 本轮文档提交 |
| `docs/audits/{comprec-1-restoration,bgshell-1-background-exec,grepext-1-search-params,prompt-1-shared-agreement}/{expectations,audit-report,decisions}.md` | 机器校对全部 `file:line` 引用与 `5 properties`、清理 `decisions.md` 项目级 backlog 混入、修正 `Effect.ignore` 与 `gemini.txt:12,43` | ✅ `18b8c50a6c` + 本轮文档提交 |
| `docs/fixes/{session-fix-mcp-structured-content-projection,session-fix-summary-tool-output-truncation,runtime-fix-pr60-audit-convergence}.md` | 同步 `McpCatalog.parsesTo` 归属、不透明 token、Shell/V1 嵌入指针、`§7.1` 八部分完整结构与 commit hash 回填 | ✅ `18b8c50a6c` + 本轮文档提交 |
| `docs/research/runtime-alignment-research.md` | 修正 §7 #6（V1/V2 与 `formatExitCodeLine` 准确口径）及 #9 `gemini.txt:12,43` | ✅ `18b8c50a6c` + 本轮文档提交 |
