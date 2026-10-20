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
| `task_id`（工具返回文本内） | `` `shell_${uuid}` `` | 细化 §5.1 | backgroundRun | 正则测试断言 |
| `BackgroundJob.start` `metadata.sessionId` | `SessionID`（2026-10-18 A2 修订新增） | 细化 §4 | backgroundRun | shell-background.test（cancel 路径） |
| shell_output `task_id` / `tail_lines` | `string?` / `number?`（默认 200） | 细化 §4 | ShellOutputTool | 直接调用测试 |
| shell_kill `task_id` | `string` | 细化 §4 | ShellKillTool | 直接调用测试 |
| 同步路径 metadata | `{ output, exit, truncated }` 不变 | 细化 §1（I1） | sync run | shell.test 23 项回归 |

## 3. 枚举值（机械化）

| 枚举 | 合法集合 | 来源 |
|---|---|---|
| job status | `running \| completed \| error \| cancelled` | `BackgroundJob`（既有，只消费） |
| job type | `"shell"`（本 feature 新增值；`"agent"` 为既有值） | 细化 §4 |
| 完成通知 status 行 | `exit N` \| `error: <msg>` \| `terminated` | 细化 §5.4 |

## 4. 流程步骤（机械化）

- P1 权限 ask（与同步路径共用，启动时一次）
- P2 `run_in_background === true` 分支守卫（false/缺省 → 同步路径逐字节不变）
- P3 建 `shellTasks` 条目（buffer 空，有界尾部 200k chars）
- P4 `BackgroundJob.start`（job scope fork；`metadata: { sessionId }`）
- P5 工具立即返回 task_id + 指引文本
- P6 run 内：spawn → 流累积（appendCapped）→ exitCode await
- P7 run 内末尾：完成通知 deliverAsync（`[shell task finished] <task_id> <command> · <status>` + 尾部）→ `Effect.ignore`
- P8 run 结算（成功/失败/中断三路）：`shellTasks.delete`
- P9 会话级 cancel 级联经 `metadata.sessionId` 命中 shell job（agent_stop / runState.cancel）

## 5. 行为契约（语义）

- 同步路径在 `run_in_background` 缺省时零变更（I1——shell.test 全量回归背书）
- 后台任务完成**投递消息唤醒**，模型不轮询（G4）
- 通知投递失败不影响任务状态（`Effect.ignore`）
- 取消的会话不再收到完成通知（A2 修订语义）
- `shell_output` 对已删除条目回退 BackgroundJob 快照（A3 修订语义）；`unknown task` 可诊断
- buffer 有界（超长输出不留全部——A3）

## 6. 时序/状态契约

- run 生命周期全部在 job scope：工具返回后进程继续
- settle 恰好一次（BackgroundJob token/pending 机制）
- 完成通知在 run 内末尾执行恰一次，先于 `shellTasks.delete`
- `hasLiveDescendant`（D14 修订）：运行中的 shell job 计入其属主会话——子 agent 带活 shell 不算停机；自身 agent job 不计入（否则 reportRunEnd 永不报告——回归 3e571f6d）

## 7. 不变量契约（property-based）

本子计划的行为时序性强（进程/通知/取消），四组 PBT 性质（C11）未覆盖此模块；
不变量以确定性测试背书：cancel 不投递、buffer 有界、结算清理、hasLiveDescendant
自指排除。若未来增加纯函数性质的输入形状（如 appendCapped 独立化），补 PBT；
当前 `appendCapped` 为模块内联函数，单测经真进程用例覆盖（cap 断言）。

## 8. 性能契约（机械化）

- 工具调用立即返回（测试断言 < 2s，进程 sleep 2s）
- buffer cap 常量 `BACKGROUND_BUFFER_MAX_CHARS = 200_000`

## 9. 安全/副作用契约

- 权限沿用 bash 启动时 ask，无新权限键
- 进程为 server 子进程（非持久化；重启丢失——与 BackgroundJob 家族一致）
- 通知只投递属主会话（`ctx.sessionID`）

## 10. 跨实现一致性

N/A——单实现（V1 tool 层）；ZCode 契约为参照非对齐目标（架构 §0：能力与
策略差异，不逐项复刻）。
