# 细化设计 — 后台 shell（background-shell）

> 状态：细化阶段（§4.3），已随实施与复审收敛同步至 HEAD。
> 架构依据：`docs/design/background-shell/architecture.md`（已确认，G5 维持最小形态、`shell_` 命名定案）。
> 待核实清单核实结果：①通知管线 = 经 `ctx.extra.promptOps.deliverAsync(input, "current")` 直接投递目标会话（以目标会话当下 agent/model/variant 唤醒 loop，不覆盖其身份）；②进程生命周期整体放进 job scope 的 run Effect 内（spawn→累积→退出，工具返回即解耦）；③工具接线 = registry builtin 列表 + `Tool.init`，`Permission.disabled` 让 `shell_output`/`shell_kill` 继承 `bash` 规则同时尊重显式 `shell_output`/`shell_kill`/`shell_*` 规则；④权限 = 后台命令沿用 bash 的启动时 ask，且在入口、`ask` 前、`backgroundRun` 入口与 `background.start` 后均守卫 `ctx.abort.aborted`。

## 1. 范围

- `packages/opencode/src/tool/shell.ts`：schema 新增 `run_in_background`；后台分支（进程生命周期进 job scope + 注册 + 通知）
- 新工具 `shell_output` / `shell_kill`（同文件，与 shell 同域）
- 会话级任务缓冲注册表（模块内 Map，进程本地）
- `tool/registry.ts`：两个新工具接线
- 测试：`test/tool/shell-background.test.ts`（真进程：后台启动/输出续读/kill/完成通知注入）+ 既有 shell 测试回归（同步路径零变更）

不覆盖：自动转后台、落盘、持久化（架构非目标）；agent 委派路径改动。

## 2. 与已有代码的复用点（核实结果）

| 项 | 事实 | 复用方式 |
|---|---|---|
| `BackgroundJob` | `start({type,title,run})` 把 run fork 进 job scope；`get/list` 返回 status/output 快照；`cancel` 经 `Effect.uninterruptible` 保护并先 `Scope.close` 再 `Deferred.succeed(done)`，并发 `wait`/二次 `cancel` 均等待 `job.done` 后返回；settle 恰好一次 | 任务注册与生命周期 |
| 通知管线 | `ops.deliverAsync(input, "current")`（`prompt.ts:187`）——fork + 实例切换 + 按目标会话当下身份唤醒 loop | 完成通知（见 §5.4） |
| promptOps 可达 | agent 工具经 `ctx.extra` 拿 `promptOps`（`agent.ts:156`） | shell 后台分支同样经 `ctx.extra` 拿 promptOps（通知用） |
| shell spawn 管线 | `spawner.spawn(cmd(...))` + `Stream.runForEach(Stream.decodeText(handle.all))` 累积（`shell.ts:549-552`）+ `handle.exitCode` | 后台 run 的进程体 |
| 工具注册 | registry builtin 列表 `Tool.init`（`registry.ts:235-285`） | 两个新工具 |

## 3. 错误处理策略

- **通知注入失败**：`Effect.catchCauseIf((cause) => !Cause.hasInterrupts(cause), ...)` 记 `Effect.logWarning` 吸收非中断异常（中断仍正常传播）——任务的 output/状态不受影响
- **启动前取消（`ctx.abort.aborted`）**：后台分支在解析/ask 前后与 `backgroundRun` 入口立即返回取消结果，绝不启动 OS 进程或注册 `BackgroundJob`；`background.start` 失败/中断时由 `Effect.onError` 清理 `shellTasks` 防泄漏
- **shell_output 查询不存在的任务**：可诊断错误（`"unknown task: <id>"`，含 `task_id: ""`）；空会话缺省查询报 `"no background shell tasks in this session"`
- **shell_kill 幂等与孤立运行任务**：`!entry` 且 `job.status === "running"` 时仍调用 `background.cancel` 终止任务；已结束任务经 `splitStatusOutput` 剥离内部首行状态后返回幂等快照
- **后台进程 spawn 失败**（如命令不存在）：run 失败 → `errorPreview` 做 UTF-16 安全单行 500 字符截断 → BackgroundJob settle 为 error → 通知照发（含错误文本）
- **工具返回后 loop 中断/会话删除**：会话取消级联终止进程；deliverAsync 对已删会话忽略（H2 既有行为）

## 4. 数据结构定义

**bash schema 扩展**：`run_in_background: Schema.optional(Schema.Boolean)`（缺省 false；同步路径零改动——I1）。

**会话级任务缓冲**（独立模块 `packages/opencode/src/tool/shell/tasks.ts` 导出 `shellTasks`、`cancelSnapshot` 与共享 `cancelBackgroundJobsPass`，避免 `session → tool/shell → plugin → session` 循环依赖）：

```ts
export type ShellTaskEntry = {
  command: string
  sessionID: SessionID
  buffer: string
  exit: number | undefined
  error: string | undefined
  startedAt: number
}
export const shellTasks = new Map<string, ShellTaskEntry>()
```

生命周期：后台启动时建；buffer 为**有界尾部**（`BACKGROUND_BUFFER_MAX_CHARS = 200_000`，超限从头丢弃并跳过孤立低代理）；run 结算（成功/失败/中断三路——delete 挂 `Effect.ensuring`，中断路也必达）后从 Map 删除。**settle 输出以 status 行打头**（`${status}\n${entry.buffer}`，其中 `status` 为 `exit N` / `error: …` / `terminated`，取消时由 `cancelSnapshot` 写入 `stopped\n${entry.buffer}`），`job.info.output` 因此携带真实退出码与有界输出尾部，供 `shell_output` 与 `shell_kill` 结算后读取。

**BackgroundJob 注册**：`type: "shell"`、`title: commandPreview(command, 80)`、`metadata: { sessionId: ctx.sessionID }`（与 agent 委派同形——`cancelBackgroundJobsPass` 的会话级联经此匹配，agent_stop/中断可达后台进程），run 返回有界 `${status}\n${entry.buffer}`（200k 字符上限）。

**新工具 schema**：

```ts
shell_output: { task_id?: string（缺省 = 本会话最近 shell 任务）, tail_lines?: number（默认 200） }
shell_kill: { task_id: string }
```

## 5. 模块细化

### 5.1 shell.ts 后台分支

- **实现思路**：
  1. `run_in_background === true` 时先检查 `ctx.abort.aborted`（解析/ask 前后与 `backgroundRun` 入口均守卫，已取消直接返回，绝不 spawn）；`false`/缺省走同步路径（I1）。
  2. 生成 `taskId = "shell_" + randomUUID()`，建立 `shellTasks` 条目（`buffer: ""`，有界尾部 `BACKGROUND_BUFFER_MAX_CHARS = 200_000`，超限按块重切并跳过低代理保完整 UTF-16 标量）。
  3. 构造 `run` Effect（整体在 job scope 执行，尾部挂 `Effect.ensuring(shellTasks.delete(taskId))`）：
     - `Effect.scoped(Effect.gen(spawner.spawn(cmd(..., true)) → Stream.runForEach(appendCapped) → handle.exitCode))`
     - 失败时 `entry.error = errorPreview(String(Cause.squash(exit.cause)))`（单行 + UTF-16 安全 500 字符截断）。
     - 调度完成通知：`ops.deliverAsync({ sessionID, parts: [{ type: "text", text: backgroundPreview(body, limits, 1).output }] }, "current")`，非中断异常由 `Effect.catchCauseIf` 记警告吸收。
     - 成功返回 `${status}\n${entry.buffer}` 作为 `BackgroundJob` 结算快照。
  4. `background.start({ id: taskId, type: "shell", title: commandPreview(command, 80), metadata: { sessionId: ctx.sessionID }, run })`，失败时 `Effect.onError` 清理 `shellTasks`。
  5. 工具返回有界回执（首行独立放 `taskId`，metadata 始终携带 `{ task_id, status: "running", exit: null, truncated }`）。
- **退出覆盖**：启动前 abort 早退、start 失败清理后抛错、start 成功返回句柄三路。
- **callee 契约引用**：`BackgroundJob.start`（job scope fork + 单次 settle）、`deliverAsync(input, "current")`（目标实例当下身份唤醒）、`CrossSpawnSpawner`（非零退出与取消均执行 `SIGTERM → waitGroupGone → SIGKILL`，取消后 `Deferred.await(signal)` 有 1 秒超时上限防脱离进程的继承 stdio 死锁）。
- **循环刻画**：流累积沿有限进程输出流终止；取消侧新增两处有界收敛循环（见 §5.5）。
- **正确性论证**（non-trivial）：
  - 前置：权限已 ask；`ctx.abort` 未触发；spawner/background 服务就绪。
  - 论证：三处 `ctx.abort` 守卫 + `onError` 清理关闭了取消期间孤儿启动与 `shellTasks` 泄漏窗口；run 整体 fork 进 job scope ⇒ 工具返回后进程与累积继续（G1）；`ensuring` + `cancelSnapshot` 保证无论自然结束或取消，状态行与有界尾部都留存于 `BackgroundJob`（G2/I2）；通知在 run 唯一自然退出路径发一次（I3）；分支守卫保证同步路径零改动（I1）。
  - 副作用论证：OS 子进程、`shellTasks` 条目、`BackgroundJob` 记录、至多一次完成通知消息。

### 5.2 shell_output 工具

- **实现思路**：`params.task_id !== undefined` 直接采用（含 `""`，走未知任务报错）；缺省时按 `started_at` 与插入逆序取本会话最近 `type === "shell"` 任务（同时覆盖已结算 `BackgroundJob` 与活 `shellTasks`），无任务报 `"no background shell tasks in this session"`。所有路径先校验 `job.type === "shell" && job.metadata?.sessionId === ctx.sessionID`。活任务读 `entry.buffer`，已结算任务经 `splitStatusOutput(job.output)` 拆出真实首行状态（或 `errorPreview(job.error)`）与输出正文，经 `tailOf` + `backgroundPreview` 内存内裁剪返回，不落盘。
- **正确性论证**：显式 ID 或按登记时间与插入次序选出的最近 ID 都走同一属主/类型校验；`splitStatusOutput` 兼容无换行快照；`errorPreview` 与 `commandPreview` 保证 2 行头部单行且合法 UTF-16。

### 5.3 shell_kill 工具

- **实现思路**：先查 `shellTasks`；若 `!entry`，查 `background.get(task_id)` 并校验 `type === "shell"` 与属主：若 `job.status === "running"` 仍执行 `background.cancel` 并返回 `stopped (<status>)`，若已结算则经 `splitStatusOutput(job.output)` 剥离内部首行状态后返回 `already settled (<status>)`（无正文时不附多余空行）。活条目分支校验属主后携带 `cancelSnapshot(task_id)` 调用 `background.cancel`，返回 `stopped (<finalStatus>)` 与尾部 50 行。
- **正确性论证**：消除了 `shellTasks.delete` 窗口期与无条目运行任务拒杀的缺口；已结算响应不再泄漏内部 `exit N`/`stopped` 前缀；`BackgroundJob.cancel` 先 `Scope.close` 后 `Deferred.succeed(done)` 保证返回时进程组已清理。

### 5.4 完成通知（M4，实现于 5.1 run 末尾）

- body 首行 `[shell task finished] <taskId> <commandPreview(160)> · <status>` + `tailOf(entry.buffer, 200)`，经 `backgroundPreview(..., limits, 1)` 裁剪。
- 经 `ops.deliverAsync({ sessionID: ctx.sessionID, parts: [{ type: "text", text }] }, "current")` 投递；`"current"` 模式只读目标会话当下 agent/model/variant（保留显式默认 variant），不回写会话身份。

### 5.5 registry 接线、权限与取消级联循环（`run-state.ts` / `session.ts` / `shell/tasks.ts` / `cross-spawn-spawner.ts`）

- `registry.ts` builtin 注册 `shell_output` 与 `shell_kill`；`permission/index.ts` `Permission.disabled` 使 `shell_output`/`shell_kill` 继承 `bash` 规则同时尊重显式 `shell_output`/`shell_kill`/`shell_*` 规则（末匹配生效）。
- **循环与终止性论证（§4.3.1/§4.3.2）**：
  1. `SessionRunState.cancel(sessionID)`：维护单调增长的 `owners` 集合；每轮 `stopTree(includeRoot)` 先沿持久化 SQLite `Session.children` 扩展后代（覆盖重启后由 `agent_send` 恢复的无 `agent` job 子会话），再调用共享 `cancelBackgroundJobsPass(background, owners)` 沿 `agent` 委派边扩展 `owners` 并取消全部运行中归属 job，同时取消 `owners` 中活跃的 `data.runners`——静默循环中传入 `includeRoot = true`，确保即使后台 shell 完成通知通过 `deliverAsync` 重新唤醒根会话自身的 `Runner`，也会一并取消直至单轮静默计数 `jobs + activeRunners === 0`。**终止性**：会话图与运行中 job 集合有限；每轮取消不可逆地中止目标 `Runner` 并将运行中 job 转为 `cancelled`，有限步内归零。
  2. `Session.cancelBackgroundJobs(background, sessionID)`（由 `Session.remove` 调用，HTTP `DELETE /session/:id` 先调 `promptSvc.cancel` 再调 `session.remove`）：复用同一 `cancelBackgroundJobsPass` 并 `Effect.repeat({ while: (count) => count > 0 })`，同理由在有限步内终止。
  3. `CrossSpawnSpawner` 进程组释放与 `handle.kill`：非零退出及外部信号致死（`code !== 0`，含 `code === null`）、主动取消和 `handle.kill` 在 `forceKillAfter` 启用时统一按 `SIGTERM → waitProcessGroupGone(检查 kill(-pid, 0) 直至 ESRCH，不把 EPERM 误判为死亡) → SIGKILL` 收敛，并在 `SIGKILL` 后对 `Deferred.await(signal)` 加 1 秒 `Effect.timeoutOption` 上限，避免 `setsid` 脱离进程继承 stdio 导致无限阻塞。

### 5.6 测试（`test/tool/shell-background.test.ts`、`test/permission/next.test.ts`、`test/session/session.test.ts`、`core/test/background-job.test.ts`）

1. 后台启动立即返回、输出续读、真实非零退出码、完成通知注入与 variant 保持
2. 取消与竞态：预取消 `ctx.abort` 不启动进程、并发取消+新登记交错、已结算委派下的后代 shell 与被唤醒的后代 runner 级联取消、`Session.remove` 后代级联、`BackgroundJob.cancel` 先关 Scope 后解 `wait`
3. 边界：`shell_kill` 击杀无 `shellTasks` 条目的运行任务与剥离已结算前缀、`shell_output({ task_id: "" })` 未知任务、多行/非 BMP 误差单行截断、TERM-resistant 进程强制升级、`Permission.disabled` 别名跟随 `bash`

## 6. 完整性自检 checklist

- [x] 推导连续（5.1–5.5 逐模块完整覆盖，含 `run-state.ts` / `session.ts` / `cross-spawn-spawner.ts`）
- [x] 分支覆盖（后台/同步、abort 预检、running/settled、活条目/无条目、存在/不存在、kill 幂等）
- [x] 退出覆盖（后台三出口、shell_output/shell_kill 全部返回与错误通道）
- [x] callee 契约引用（BackgroundJob、deliverAsync("current")、CrossSpawnSpawner、Permission.disabled）
- [x] 循环刻画（`SessionRunState.cancel`、`Session.cancelBackgroundJobs`、`CrossSpawnSpawner` 三处循环均给出单调性与有限终止论证）
- [x] 上游事实显式（`promptOps` 通道、`deliverAsync` 语义、`BackgroundJob` 单次 settle、进程组边界）

2026-11-19 修订：完成通知采用目标 Session 当下的 agent、model、variant；投递异常不改写进程结局。取消向进程组发送 TERM，并有界升级，含 shell 先退出且子进程仍存活的情况。shell_output / shell_kill 在内存内按有效行数、UTF-8 字节预算保留尾部。终端换行不占用一个额外的输出行；同毫秒启动时选后启动的任务。

## 2026-11-21 回执、取消交错与身份

- 启动回执不复制命令正文。第一行独立放任务 ID，随后给出读取指引；回执经过与读取相同的行数和字节预算。命令在原有工具输入中仍完整可见。尾缓冲截取若落在 UTF-16 低代理处，从其后一位开始；有效的输入字符不会在缓冲左边界变成半个字符。
- 自然退出先调度通知，再由 BackgroundJob 结算。投递在目标实例读取当前 Session 身份，明确区分默认 variant 和普通用户新 prompt 的省略值。通知不写回 Session 的 agent/model/variant，因此不会用一次较早的读取覆盖用户的新选择。
- Session 取消并行中断 runner 和已有的任务，等待这批 finalizer 完成。此时 runner 已停止登记；以其间已发现的属主为起点，每次取消后重新读取 job 列表，直到没有仍在运行的所属任务。原子取消先记终态，再关闭该 job 的 scope。有限的已提交登记只需处理一次。取消不承诺跨重启恢复或回收已主动脱离的服务；进程组范围见架构文档。
- 回归在已有任务的 finalizer 内阻塞，与同一 runner 已提交的第二个真实 shell 登记精确交错；读取第二个句柄的最终状态。另测通知抵达 provider 后的 Session 和用户消息 variant、长命令回执及随机非 BMP 码点落在缓冲左界。

父会话的取消遍历所有已登记的 agent 委派关系，包括已结算的中间节点。只有仍在运行的所属任务会被取消；已完成的委派保留终态，其他会话的任务继续执行。
