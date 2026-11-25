# Contract Audit Expectations — `bgshell-1-background-exec`

> ⚠️ 时序声明：本 expectations 为 **2026-10-18 事后补抽**（PR #60 审核意见 C10）。
> workflow §6.2 要求 Step 0（实施前）产出；本子计划实施时未产出，属流程违例，
> 已在 decisions.md 记录。抽取基线 = 修复批次完成后的 PR head
>（`c7e631fdaf`），契约源仅限下列文档，未从实现代码回填字段语义
> （实现位置列除外——该列本就是"事后定位"）。

## 1. 契约源（multi-doc）

| 文档 | 用途 | 相关节 |
|---|---|---|
| `docs/design/background-shell/architecture.md` | 主契约（目标/非目标/流程/数据结构） | §1-§4 |
| `docs/design/background-shell/detailed-design.md` | 细化契约（含 2026-10-18 A2/A3 复审修订） | §1-§6 |
| issue #46 §三.5 / §五.6 | 需求源（后台执行四能力 + 验收） | 正文 |
| 既有契约（引用不改） | `BackgroundJob`（core/background-job.ts：start fork 进 job scope、settle 恰好一次、status 枚举）；`ops.deliverAsync`（fork + 实例切换 + 唤醒）；bash 同步路径（零改动基线） | — |

## 2. Schema 字段（机械化）

| 字段 | 类型 | 契约来源 | 实现位置 | 一致性机制 |
|---|---|---|---|---|
| bash `run_in_background` | `boolean?`（缺省 false） | 细化 §4 | `tool/shell.ts` Parameters + wire 快照 | `parameters.test.ts.snap` |
| `task_id`（**返回 metadata + 文本双承载**；2026-10-20 独立审 ❌-4 修复：metadata 原缺 task_id/status，已补 `{ task_id, status: "running" }`——初版 expectations 按实现抽成"仅文本"，未标注与细化 §5.1 的冲突，属抽取错误，已更正） | `` `shell_${uuid}` `` | 细化 §5.1 | backgroundRun 返回 | metadata 断言 + 正则测试 |
| `BackgroundJob.start` `metadata.sessionId` | `SessionID`（2026-10-18 A2 修订新增） | 细化 §4 | backgroundRun | shell-background.test（cancel 路径） |
| shell_output `task_id` / `tail_lines` | `string?` / `number?`（默认 200） | 细化 §4 | ShellOutputTool | 直接调用测试 |
| shell_kill `task_id` | `string` | 细化 §4 | ShellKillTool | 直接调用测试 |
| 同步路径 metadata | `{ output, exit, truncated }` 不变 | 细化 §1（I1） | sync run | shell.test 23 项回归 |

## 3. 枚举值（机械化）

| 枚举 | 合法集合 | 来源 |
|---|---|---|
| job status | `running \| completed \| error \| cancelled` | `BackgroundJob`（既有，只消费） |
| job type | `"shell"`（本 feature 新增值；`"agent"` 为既有值） | 细化 §4 |
| 完成通知 status 行 | `exit N` \| `error: <msg>` \| `terminated`（细化 §5.4 原文 "killed" 措辞废弃——取消路通知被有意抑制不发送，见 P9；2026-10-20 勘误） | 细化 §5.4 |

## 4. 流程步骤（机械化）

- P1 权限 ask（与同步路径共用，启动时一次）；后台路径在解析/ask 前后、`backgroundRun` 入口与 `background.start` 后检查 `ctx.abort.aborted`（若启动竞态中被取消则立即 `background.cancel` 回收）
- P2 `run_in_background === true` 分支守卫（false/缺省 → 同步路径逐字节不变）
- P3 建 `shellTasks` 条目（buffer 空，有界尾部 200k chars）；`background.start` 失败时经 `Effect.onError` 清理条目
- P4 `BackgroundJob.start`（job scope fork；`metadata: { sessionId }`）
- P5 工具立即返回有界回执（首行独立 task_id + 指引文本；metadata 始终携带 `task_id` / `status`）
- P6 run 内：spawn → 流累积（appendCapped）→ exitCode await；失败错误经 `errorPreview` 单行/UTF-16 安全截断
- P7 run 内末尾：完成通知经 `ops.deliverAsync(..., "current")` 投递，非中断失败由 `Effect.catchCauseIf` 记警告吸收（不吞中断）
- P8 run 结算：`shellTasks.delete` 挂 `Effect.ensuring` 三路均达
- P9 会话级 cancel 级联经 `metadata.sessionId`、持久化 SQLite 子会话及 `agent` 委派图（含已结算节点）循环终止所有归属后台任务及活跃 runner（含重唤醒的根会话与后代 runner）；`Session.remove` 与 HTTP `DELETE /session/:id` 共用单 Pass 级联 helper

## 5. 行为契约（语义）

- 同步路径在 `run_in_background` 缺省时零变更（I1——shell.test 全量回归背书）
- 后台任务完成**投递消息唤醒**，模型不轮询（G4）
- 通知投递失败不影响任务状态（`Effect.catchCauseIf` 记警告吸收非中断异常、不吞中断）
- 取消的会话不再收到完成通知（A2 修订语义）
- **结算后 shell_output 报告真实退出码**（2026-10-20 独立审 ❌-1 修复：settle 输出以 status 行打头，回退分支解析之——原实现把 completed 一律渲染成 "exit 0"，非零退出被伪造为成功；已补非零退出回归）
- **shell_kill 幂等**（2026-10-20 独立审 ❌-2 修复：已结算任务经 BackgroundJob 快照应答 "already settled"，不再抛 unknown task；属主校验经 metadata.sessionId）
- `shell_output` 对已删除条目回退 BackgroundJob 快照（A3 修订语义）；`unknown task` 可诊断
- buffer 有界（超长输出不留全部——A3）
- 工具描述/返回文本说明重启丢任务（2026-10-20 独立审 ❌-5 修复：run_in_background 返回文本已补）

## 6. 时序/状态契约

- run 生命周期全部在 job scope：工具返回后进程继续
- settle 恰好一次（BackgroundJob token/pending 机制）
- 完成通知在 run 内末尾执行恰一次，先于 `shellTasks.delete`
- `hasLiveDescendant`（D14 修订）：运行中的 shell job 计入其属主会话——子 agent 带活 shell 不算停机；自身 agent job 不计入（否则 reportRunEnd 永不报告——回归 3e571f6d）

## 7. 不变量契约（property-based）

[历史记录，2026-11-19 的生成式测试已取代此覆盖说明] 本子计划的行为时序性强（进程/通知/取消），四组 PBT 性质（C11）未覆盖此模块；
不变量以确定性测试背书：cancel 不投递、buffer 有界、结算清理、hasLiveDescendant
自指排除。若未来增加纯函数性质的输入形状（如 appendCapped 独立化），补 PBT；
当前 `appendCapped` 为模块内联函数，单测经真进程用例覆盖（cap 断言）。

## 8. 性能契约（机械化）

- 工具调用立即返回（测试断言 < 2s，进程 sleep 2s）
- buffer cap 常量 `BACKGROUND_BUFFER_MAX_CHARS = 200_000`

## 9. 安全/副作用契约

- 权限沿用 bash 启动时 ask，无新权限键；`Permission.disabled` 让 `shell_output`/`shell_kill` 继承 `bash` 规则同时尊重显式 `shell_output`/`shell_kill`/`shell_*` 规则，保证 `explore` 可见、禁用 `bash` 时一并隐藏、显式禁用单工具仍生效
- 进程为 server 子进程（非持久化；重启丢失——与 BackgroundJob 家族一致）
- 通知只投递属主会话（`ctx.sessionID`）
- `BackgroundJob.cancel` 经 `Effect.uninterruptible` 保护并先完成 `Scope.close` 再解析 `done`，并发 `wait` 与二次 `cancel` 均等待 `job.done` 后返回，保证取消返回时进程清理已完成

## 10. 跨实现一致性

N/A——单实现（V1 tool 层）；ZCode 契约为参照非对齐目标（架构 §0：能力与
策略差异，不逐项复刻）。

## 2026-11-19 后台状态机与通知

增加带 seed 的 30 组 start/read/kill/finish 操作序列；读取与停止核对实际 stdout 和所有权。真进程覆盖不响应 TERM 的子进程、父 shell 先退出、配置字节/行预算与 UTF-8、通知失败、同毫秒排序。真实提示词通路验证完成通知继承当前身份。

## 2026-11-21 验收补充

- P5 优先返回完整句柄；启动正文符合 tool_output 配置，标题/回显与输出切点均不制造孤立代理。
- P7 使用投递时目标 Session 的身份。检查用户选择命名 variant 与显式默认 variant，既检查送入对话的消息，也检查完成后持久化的 Session。
- P9 等待当前 runner 及其任务结束，重新观察取消中已经提交的登记。由 Deferred 强制造成在第一次观察之后才出现的第二个 shell，并检验其最终为 cancelled。
- 正常退出并主动留下后台进程的 launcher 遵循与前台 shell 相同的所有权约定，见架构文档。关闭活动进程组及 TERM 后升级仍有真进程回归。

### 本轮 Step 5 的机械验证

`test/tool/shell-background.test.ts`、`test/session/session.test.ts`、`test/session/prompt.test.ts`、`test/permission/next.test.ts` 与 `packages/core/test/background-job.test.ts` 覆盖后台启动、续读、终止、取消级联、后代 runner 中断、权限别名与 Scope 清理顺序。收敛修复与完整核销见 [PR #60 独立审核收敛修复记录](../../fixes/runtime-fix-pr60-audit-convergence.md)。本地仓库没有通用 contract_audit 生成器。本子计划的功能与合并验收由 [#46](https://github.com/lihaokun/opencode/issues/46) 与 [PR #60](https://github.com/lihaokun/opencode/pull/60) 跟踪。

父会话的取消遍历所有已登记的 agent 委派关系，包括已结算的中间节点。只有仍在运行的所属任务会被取消；已完成的委派保留终态，其他会话的任务继续执行。
