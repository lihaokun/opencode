# 细化设计 — 后台 shell（background-shell）

> 状态：细化阶段（§4.3），待 §4.4 审查后实施。
> 架构依据：`docs/design/background-shell/architecture.md`（已确认，G5 维持最小形态、`shell_` 命名定案）。
> 待核实清单核实结果：①通知管线 = `AgentInbox.deliver` → `ops.deliverAsync`（把消息作为 user prompt 注入目标会话并唤醒 loop，`lifecycle.ts:449-462` → `inbox.ts:133`）；②进程生命周期可整体放进 job scope 的 run Effect 内（spawn→累积→退出，工具返回即解耦）；③工具接线 = registry builtin 列表 + `Tool.init`，agent 系工具（agent_list/agent_stop）不 ask 权限——`shell_output/shell_kill` 照此；④权限 = 后台命令沿用 bash 的启动时 ask，无新权限键。

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
| `BackgroundJob` | `start({type,title,run})` 把 run fork 进 job scope；`get/list` 返回 status/output 快照；`cancel` 杀 scope（进程组随 scope 关闭终止）；settle 恰好一次（token/pending 机制） | 任务注册与生命周期 |
| 通知管线 | `AgentInbox.deliver({message:{kind:"agent",message:{target, sender, sender_agent, body}}, ops})` → 内部 `ops.deliverAsync`（`inbox.ts:133`）——消息作为 prompt 注入目标会话并唤醒 loop | 完成通知（sender 标识为 shell 任务，见 §5.4） |
| promptOps 可达 | agent 工具经 `ctx.extra` 拿 `promptOps`（`agent.ts:110` "The agent tools require promptOps in ctx.extra"） | shell 后台分支同样经 `ctx.extra` 拿 promptOps（通知用） |
| shell spawn 管线 | `spawner.spawn(cmd(...))` + `Stream.runForEach(Stream.decodeText(handle.all))` 累积（`shell.ts:484-490`）+ `handle.exitCode` | 后台 run 的进程体 |
| 工具注册 | registry builtin 列表 `Tool.init`（registry.ts:240-259 一带） | 两个新工具 |

## 3. 错误处理策略

- **通知注入失败**：`Effect.ignore`（架构：注入失败不影响任务本身）+ `Effect.logWarning`——任务的 output/状态不受影响
- **shell_output 查询不存在的任务**：可诊断错误（"unknown task: <id>"），不抛 defect
- **shell_kill 对已结束任务**：幂等——返回当前快照（status: completed/error/cancelled）
- **后台进程 spawn 失败**（如命令不存在）：run 失败 → BackgroundJob settle 为 error → 通知照发（含错误文本）——模型经通知得知，无需轮询
- **工具返回后 loop 中断/会话删除**：deliverAsync 对已删会话 → ignore（H2 既有行为）

## 4. 数据结构定义

**bash schema 扩展**：`run_in_background: Schema.optional(Schema.Boolean)`（缺省 false；同步路径零改动——I1）。

**会话级任务缓冲**（模块私有，`shell.ts` 内 Map）：

```ts
const shellTasks = new Map<string, { command: string; sessionID: SessionID; buffer: string; startedAt: number }>()
```

生命周期：后台启动时建；buffer 为**有界尾部**（`BACKGROUND_BUFFER_MAX_CHARS = 200_000`，超限从头丢弃——所有读者都只读尾部，保留更多纯属内存泄漏面）；run 结算（成功/失败/中断三路）后从 Map 删除（终值输出已随 settle 进入 `job.info.output`，完成通知也已投递；shell_output 对已删除条目回退读 BackgroundJob 快照）。复审修订（2026-10-18，PR #60 审核意见 A3）：初版"不删 + 无界 buffer"会在长 run 中累积超长输出与每任务一条的残留条目，已按有界尾部 + 结算清理修正。

**BackgroundJob 注册**：`type: "shell"`、`title: command 前 80 字符`、`metadata: { sessionId: ctx.sessionID }`（与 agent 委派同形——cancelBackgroundJobs 的会话级联经此匹配，agent_stop/中断可达后台进程；复审修订 A2）、run 返回**全量累计输出**（settle 后进 `job.info.output`）。

**新工具 schema**：

```ts
shell_output: { task_id?: string（缺省 = 本会话最近 shell 任务）, tail_lines?: number（默认 200） }
shell_kill: { task_id: string }
```

## 5. 模块细化

### 5.1 shell.ts 后台分支

- **实现思路**：
  1. `run_in_background === true` 时走后台分支（I1：分支守卫，同步路径不动）
  2. 生成 task_id（`Identifier.ascending("shell")` 或复用 BackgroundJob 的 id 生成）
  3. 建 `shellTasks` 条目（buffer: ""）
  4. 构造 run Effect（整体在 job scope 执行）：
     - `Effect.scoped(Effect.gen(spawn 既有 cmd 构造 → Stream.runForEach 累积进 buffer 条目 → await exitCode → return buffer 全文))`
     - run 末尾：**完成通知**——构造 body（`[shell task finished] <command> · exit <code|signal>` + buffer 尾部 tail 行）→ `AgentInbox.deliver` → `ops.deliverAsync` → `Effect.ignore` + logWarning
  5. `BackgroundJob.start({ type: "shell", title, run })`（start 内部 fork 进 job scope——**工具调用 scope 关闭不影响**）
  6. 工具返回：`{ title: command, metadata: { task_id, status: "running" }, output: 指引文本（task_id / "output and completion arrive via shell_output and a completion message"） }`
- **退出覆盖**：后台分支仅两个出口（start 成功 → 返回句柄；start 失败 → 错误上抛为工具 error——注册表失败即无任务，可诊断）
- **callee 契约引用**：BackgroundJob.start 的 post（run 进 job scope、settle 恰好一次——I2 由其 token/pending 机制保证）；deliverAsync 的语义（fork + 切换到目标会话实例）
- **循环刻画**：无循环（流累积为既有管线）
- **正确性论证**（non-trivial）：
  - 前置：权限已 ask；spawner/fsys 服务在 ctx
  - 论证：run 整体 fork 进 job scope ⇒ 工具返回后进程与累积继续（G1）；buffer 挂模块 Map ⇒ shell_output 任意时刻可读（G2）；exitCode await + settle ⇒ 状态终值确定（I2）；通知在 run 内末尾执行恰一次 ⇒ I3；分支守卫 ⇒ I1
  - 副作用论证：新增副作用 = 进程本身（有意）、buffer Map 写入、注册表写入、通知消息——全部穷尽列出且均为 feature 目的

### 5.2 shell_output 工具

- **实现思路**：task_id 缺省 → 取 `shellTasks` 中本会话 startedAt 最大的条目；不存在 → "no background shell tasks in this session"；task_id 不在 Map → "unknown task"。读取：status（BackgroundJob.get）/ exit（job.info.error 或 exit code——exit code 存 buffer 条目，settle 时回填）/ 输出尾部（buffer 按 tail_lines 取尾）。渲染：
  ```
  [shell task <id>] <command>
  status: running | exit <code> | cancelled | error: <msg>
  <输出尾部 tail_lines 行>
  (running) | (finished — completion was delivered as a message)
  ```
- 正确性论证：trivial + 纯读（无分支嵌套；缺省 task_id 的选择规则已枚举）

### 5.3 shell_kill 工具

- **实现思路**：`BackgroundJob.cancel(task_id)` → 快照渲染（status: cancelled + 输出尾部）；任务不在本会话 Map → "unknown task"（防跨会话误杀）；已结束 → 返回现状态（幂等）
- 正确性论证：trivial（cancel 语义由注册表保证；会话归属校验单点）

### 5.4 完成通知（M4，实现于 5.1 run 末尾）

- body 首行 `[shell task finished]`（对齐 ZCode task-notification 惯例）+ command + exit 语义（正常 exit N / killed / error 文本）+ buffer 尾部 200 行
- deliverAsync 字段照抄委派通知的调用形状（sessionID = 父会话、parts = 单 text part）；sender 身份 = shell 任务（task_id 作为 title 前缀——inbox 的 agent 形状字段按其实际必填集最小化填充，实施时以 inbox.ts 的类型为准）

### 5.5 registry 接线

`registry.ts` builtin 增 `shellOutput: Tool.init(...)`、`shellKill: Tool.init(...)`，加入 builtin 数组（`shell` 之后）；权限键跟随 agent_list/agent_stop 模式（无 ask；可见性走既有 visibleTools 规则）。

### 5.6 测试（`test/tool/shell-background.test.ts`，复用 shell 测试的 toolLayer + 真进程）

1. **后台启动立即返回**：`run_in_background: true` + `sleep` 类命令 → execute 快速返回（<1s 量级）且 output 含 task_id、metadata.status = running
2. **输出续读**：后台 `printf` 已知文本 → 等待完成 → shell_output 读到文本与 exit 0
3. **完成通知注入会话**：后台任务结束后，会话中出现 `[shell task finished]` 消息（经 session 消息读取断言；notify 走真实 deliverAsync——需要 promptOps 注入测试层，形态对齐 agent 工具测试的 ctx.extra 注入）
4. **kill**：后台 sleep → shell_kill → status cancelled、进程终止
5. **同步路径零变更**：不传 run_in_background 的既有 shell 测试全过（回归）
6. **shell_output 未知任务** → 可诊断错误

## 6. 完整性自检 checklist

- [x] 推导连续（5.1 六步、5.2/5.3 枚举分支）
- [x] 分支覆盖（后台/同步、running/finished、存在/不存在、kill 幂等）
- [x] 退出覆盖（后台两出口、shell_output 三出口、shell_kill 幂等/未知）
- [x] callee 契约引用（BackgroundJob start/cancel post、deliverAsync 语义、promptOps 通道均已标注）
- [x] 循环刻画（无新增循环；流累积既有）
- [x] 上游事实显式（inbox deliverAsync 形状、promptOps 通道、settle 一次保证、注册表非持久化——均标注出处）
