# 架构 — 后台 shell（background-shell）（issue #46 P2 item 2）

> 状态：调研 + 架构合并稿（待确认后进细化）。
> 关联：issue #46 §三.5（"shell 后台执行与返回契约"）与 §五第 6 条；参照 `docs/research/zcode-replacement-assessment.md` §4.1（ZCode 后台 bash 契约）与 Claude Code 官方后台命令能力。
> 原则（issue 原文）：这是能力与策略差异，不把现状定性为 bug；**不为模仿参照产品而默认改变所有超时行为**。

## 0. 调研结论（§4.1 合并）

**现状**：shell 工具（对外 id `bash`）同步执行——超时终止进程、无后台模式。模型想跑长任务只能同步等待或放弃。

**fork 已有的积木（复用为主，新建为辅）**：

| 积木 | 位置 | 能力 |
|---|---|---|
| `BackgroundJob` | `core/background-job.ts` | 进程内任务注册表：start（fork 进 job scope）/ list/get（status: running/completed/error/cancelled + output + error 文本）/ wait(timeout) / cancel / extend（顺序续跑）。**有意非持久化**（注释明示）——进程重启即失，与子代理同等语义 |
| 完成消息注入 | agent 委派（`agent-management/lifecycle.ts` 的 notify 路径） | 子代理完成后，**结果作为消息注入父会话**——"Its result will arrive as a message when it finishes" |
| 运行可见性 | roster（`reminders.ts::applyAgentRoster`） | 每轮注入运行中子代理快照（compacted 触发 + 去重） |
| 同步 shell | `tool/shell.ts` | 进程管理、流式 output、超时/取消语义——保持不动 |

**ZCode 参照**：`run_in_background` 参数 + `backgroundTaskId` + 输出文件 + 完成通知 + 15s 阻塞预算自动转后台 + `TaskStop/TaskOutput`（后者已 DEPRECATED，方向是通知制）。

## 1. 目标与非目标

**目标**

- **G1 显式后台模式**：bash schema 新增 `run_in_background`——为 true 时工具**立即返回**任务句柄（task_id），进程在后台继续
- **G2 续读**：模型可查询后台任务的累计输出与状态（running/exit code）
- **G3 停止**：模型可终止后台任务（保留既有同步超时/取消语义不变）
- **G4 完成/失败通知**：任务结束时，结果（状态 + 退出码 + 输出尾部）作为消息注入会话——模型无需轮询
- **G5 可见性**：运行中的后台 shell 出现在每轮上下文（复用 roster 或等价机制）

**非目标（记录理由与引入条件）**

- **自动转后台（ZCode 的 15s 阻塞预算）**：harness 替模型决定后台化，最高频工具的同步契约被重写——bash 调用从"有输出和退出码"变成"启动了但不确定"，与 P0"结果必须可见且真实"的方向相反；且错杀顺序依赖场景（install/migration/测试等必须同步完成才能走下一步的命令）。显式参数 + 工具描述指引已覆盖需求（ZCode 自己也将 TaskOutput 转 DEPRECATED 走通知制）。引入条件：使用数据显示模型在已有文档指引下仍反复阻塞在可后台化命令上（提示词层失败），届时考虑保守版（更大预算如 60s，或仅已知 server 类命令模式）。
- **输出文件落盘**：内存缓冲已满足主场景，落盘引入第二事实来源 + 保留期/清理问题（truncate 7 天清理与"hint 指向失效文件"刚归档的坑类）+ 敏感输出（env dump）的作用域扩大；且任务非持久化而文件会活过重启——"文件在任务死"的诈尸引用比没有文件更糟（同型于 P0-3 修的问题）。引入条件：单任务输出超出合理内存界限（数 MB 级），届时落盘并写入 job metadata，保留期沿用 truncate 语义。
- **持久化/进程重启恢复**：物理不可能恢复进程——后台 shell 是 server 的 OS 子进程，重启即孤儿化或被杀；注册表可持久化元数据但"元数据在、进程死"的诈尸状态比明确丢失更糟。与子代理同等语义是全家族一致性（工具描述明说"重启丢任务"）。真实需求接近零：跨重启存活的长进程本质是服务，正确工具是 tmux/systemd/nohup（工具描述可指引）。引入条件：出现"模型必须拥有跨重启进程"的工作流——即"管理守护进程"，是另一个产品。
- **默认超时行为变更（同步路径零改动）**：shell 是流量最大的工具，P0 刚把它的结果可见性做实——动默认超时 = 动主路径契约，需要独立迁移叙事而非搭车能力新增。组合上同步 + 显式后台已覆盖空间（短/中同步、长/服务后台），唯一缝隙"很长且必须阻塞"自相矛盾（必须阻塞即阻塞是需求）。引入条件：与自动转后台共享（若立项才涉及配套超时调整）。

## 2. 核心流程

```
bash(run_in_background: true)
  ├─ permission ask（不变，启动时一次）
  ├─ spawn 进程（既有 shell 管线），输出流式累积到任务缓冲
  ├─ BackgroundJob.start({ type: "shell", title: command, run })
  ├─ 工具立即返回：task_id + 初始状态（"running"）+ 读法说明
  ↓ 进程退出
BackgroundJob settle（status: completed/error/cancelled + exit code + 输出尾部）
  ↓ 完成通知
会话消息注入：[shell task finished] task_id / command / exit code / 输出尾部
  ↓
模型在下一轮请求看到通知（无需轮询）
```

续读：`shell_output` 工具（或等价）读任务快照（status + exit + 累计输出尾部，可带 tail 参数）。
停止：`shell_kill` 工具 → `BackgroundJob.cancel`（杀进程组，语义同同步取消）。

## 3. 数据结构（§3.1）

**bash schema 扩展**：`run_in_background: optional Boolean`（默认 false——同步路径零改动）。

**任务注册**：复用 `BackgroundJob`（`type: "shell"`，`title: command 截断`，metadata 携带 exit/输出尾部）。**不新增 schema 字段**——任务状态在注册表内，通知消息是持久化文本 part。

**shell_output 工具 schema**：`task_id?: string`（缺省 = 最近一个 shell 任务）+ `tail_lines?: number`（默认 200，输出尾部窗口）。

**shell_kill 工具 schema**：`task_id: string`。

## 4. 模块划分与功能规约（§3.2）

### M1 `tool/shell.ts` 扩展

`run_in_background` 为 true 时：走既有 spawn 管线但**不等待退出**——进程句柄与流式累积包装为 `BackgroundJob.start({ run })`（run = 等待进程退出并返回累计输出文本）；工具返回 task_id + 状态说明 + 读法指引（"results arrive as a message; use shell_output for interim output"——对齐 agent 工具的返回风格）。超时参数在后台模式**不适用**（无等待即无超时——语义说明写入描述）。

### M2 新工具 `shell_output`

读 BackgroundJob 快照：status / exit code / 输出尾部（tail_lines 窗口）。缺省 task_id = 该会话最近启动的 shell 任务（从注册表按 type+时间过滤）。任务不存在 → 可诊断错误。

### M3 新工具 `shell_kill`

`BackgroundJob.cancel(id)`（终止进程组）→ 返回终止后状态。已结束的任务 → 返回当前状态（幂等）。

### M4 完成通知

BackgroundJob settle 后注入会话消息——**复用 agent 委派的 notify 管线**（同一条"结果作为消息"通路），消息文本：`[shell task finished] <command 截断> · exit <code>` + 输出尾部。失败/取消分别有明确文案。注入失败不影响任务本身。

### M5 可见性

两个选项（细化时定）：(a) 扩展 roster 行纳入 shell 任务；(b) 首选最小——通知制已保证"结束可知"，运行中可见性由 shell_output 的"缺省最近任务" + 返回句柄承担，roster 扩展记为引入条件。

## 5. 接口规约（§3.3）

**接口：bash 工具 → BackgroundJob**：start 的 `run` Effect 由 shell 进程句柄构造（等待退出 + 累计输出）；cancel/wait 语义由注册表定义。
**接口：shell_output/shell_kill → BackgroundJob**：get/cancel 直通；会话过滤（只看本会话启动的任务）在工具层。
**调用方责任**：模型在后台任务运行期间不得假设其影响已生效（输出/退出码以通知或 shell_output 为准——写入工具描述）。

## 6. 关键设计决策

1. **显式参数，不做自动转后台**（issue 原则；非目标第 1 条）。
2. **复用 BackgroundJob 而非新建注册表**：与子代理共享同一套状态/取消/等待语义；"type: shell" 区分域。
3. **完成通知复用委派 notify 管线**：通知制而非轮询制（ZCode 的 TaskOutput DEPRECATED 同方向）。
4. **进程内输出缓冲，不落盘**（非目标第 2 条）。
5. **输出读取与终止做成两个小工具**（CC 的 BashOutput/KillShell 先例），而非单工具 action 参数——模型对单一职责工具的选择更可靠。
6. **工具命名前缀 `shell_`** 而非 `bash_`：`shell/id.ts:13-14` 已成文记录 "bash" 是兼容遗留、计划随 2.0 改名为 shell——新工具无兼容包袱，不该把旧误称（工具实际运行 bash/pwsh/powershell/cmd 四种 shell）烘焙进新契约面，否则 2.0 改名从改一个工具变成改三个。可发现性不依赖名字前缀：后台模式的返回文本会显式指引 "use shell_output…"（agent 工具用同样模式指引 agent_list/send/stop）。反方先例是 Claude Code 的 `BashOutput/KillShell`（bash 前缀同族），但 CC 的 "Bash" 是正当命名、无遗留问题；ZCode 的 `Task*` 家族（按任务域分组）反而更接近本方案。

## 7. 架构正确性论证（§4.2.1）

**goal → 模块映射**：G1 → M1；G2 → M2；G3 → M3；G4 → M4；G5 → M5。

**模块协作论证**

- G1 要求"立即返回句柄、进程继续"。M1 的 spawn 在 BackgroundJob.start 的 job scope 内 fork——scope 与调用方 run 作用域解耦（注册表持有），工具返回不再等待进程 ⇒ 进程存活与工具返回解耦 ⇒ G1。
- G2 要求随时可读。M2 直通注册表快照（status/output 实时）⇒ G2。
- G3 要求可终止。M3 → BackgroundJob.cancel（杀 scope 内进程组）⇒ G3。
- G4 要求结束可知。settle 触发 M4 注入 ⇒ 模型下一轮可见 ⇒ G4。
- G5：通知制覆盖"结束"，句柄覆盖"运行中可查" ⇒ G5（最小形态）。

**关键假设**

- H1：后台 shell 的生命周期 ≤ 进程生命周期（`BackgroundJob` 非持久化）——进程重启丢任务，与子代理同等；工具描述须说明。
- H2：完成注入的会话在任务结束时仍存在（会话删除后注入跳过——notify 管线的既有行为）。
- H3：输出内存缓冲可接受（非目标第 2 条成立的前提下）；超长输出以 tail_lines 窗口读取，全量不回灌。
- H4：并发多任务由 `BackgroundJob` 的 Map + token 语义保证隔离（既有、已测基础设施）。

**模块级不变量**

- I1：同步路径零行为变更（run_in_background 缺省 = 现状逐字节）— 维护方：M1 分支守卫。
- I2：每任务的 settle 恰好一次 — 维护方：`BackgroundJob` 既有 token/pending 机制。
- I3：通知消息每任务至多一条 — 维护方：M4 在 settle 回调注册一次。

**preservation 论证**：I1 由分支守卫保证（后台路径仅在新参数为 true 时进入）；I2/I3 是既有基础设施性质（注册表与回调注册点各一处）。

## 8. 细化阶段待核实清单

- agent 委派 notify 管线的确切调用形状（注入消息的 parts 结构、agent 字段取值——后台 shell 的通知以什么身份出现）
- shell 进程句柄能否在"不等待"模式下保持输出流累积（现同步管线 stream.forEach 累积——后台形态需要把累积挂在 job scope 而非工具调用 scope）
- 工具注册表对新增两个工具的接线（registry.ts 内置列表 + 权限键）
- 权限语义确认：后台命令的 ask 时机（启动时）与同步一致，无需新权限键
