# 每步末尾附加段：一步内重复拒绝、跨步重复计数、子 agent 运行状态

- 状态：修复完成，待 PR（第六至八部分的实际状态见文末"回填"）
- Issue：#76（死循环）、#75（子 agent 时序与数量）；附带 #73 的服务端部分（agent 消息打标记）
- 分支：`step-tail`（基于 `dev@d9d7de31fb`）
- 影响模块：`packages/opencode` 的 SessionPrompt 循环、SessionTools、SessionProcessor、agent-management（inbox、delegation、tool/agent）、`provider/transform.ts` 的缓存断点
- 分类：§7 第二类（算法内部逻辑错误）＋第三类（新增工具与输出契约，需同步设计文档与 §6 契约审核）

## 第一部分：现象与复现

### 1.1 #76：同一失败调用跨步重复 178 次

fermat 主会话 `ses_eab1fbdaaffehPhBL8zpBtj52H`（volce `glm-5.3-flash`，`opencode --auto`，`1.18.31-fmv3-pr59.2`），2026-10-20 22:09:59–22:41:33：

| 项目                | 数值                                                           |
| ------------------- | -------------------------------------------------------------- |
| 同一次 run 内的步数 | step 5 → 187，期间无新消息、无 run 重启                        |
| 每步内容            | 只有一个 Edit，输入逐字相同，`oldString == newString`          |
| 每步结果            | `No changes to apply: oldString and newString are identical.`  |
| API 调用            | 178 次（日志 `stream` 178、助手消息 178、step-finish 178）     |
| 每次上下文          | 83.9–86.9 万 token；每次输出均为同样的 152 token，推理 0 token |
| 合计发送            | 1.52 亿 token，约 31 分钟                                      |
| `doom_loop` 记录    | 0                                                              |

**最小复现**（脚本化 LLM，`test/session/prompt.test.ts` 的 `useServerConfig` 夹具）：

1. 新建会话并写入一个文件；
2. 让脚本化 LLM 每一步都返回同一个 `edit` 调用，`oldString` 与 `newString` 相同；
3. 运行 `prompt.loop`，脚本提供 N 步后返回纯文本结束。

实际：N 次 Edit 全部执行、全部报错，没有任何检测或提示。

**一步内的情形**：脚本化 LLM 在一次返回里给出 3 个相同的工具调用。实际：第 3 个触发 `doom_loop` 权限询问；TUI 在 auto 模式下自动回复 `once`；三个调用都会执行。

### 1.2 #75：父 agent 分不清子 agent 的时序与数量

本机主会话 `ses_f0d514ecbffewBeKO9m9H1ND2W`，自 2026-10-18 23:35 压缩以来：

| 项目                                   | 数值                            |
| -------------------------------------- | ------------------------------- |
| 主 agent 调用 agent_send               | 429 次                          |
| 发出时目标的结束报告已到、本步尚未看到 | 35 次（8%），报告早到 0.2–61 秒 |
| 直接子 agent                           | 394 个                          |
| 调用 agent_list                        | 1 次；返回 290 行、48,599 字符  |

**最小复现**：父 agent 某一步开始后，子 agent 的 run 结束、结束报告写入；父 agent 在同一步内对该子 agent 调 agent_send。下一步父 agent 看到的记录顺序是"自己的 agent_send → 结束报告"，且两者都不带 run 身份与时间，无法判断报告属于哪一次 run。

### 1.3 出错代码路径

- `packages/opencode/src/session/processor.ts`：`create` 内 `doomLoop: DoomLoop.create()`（约 178 行）；`tool-call` 事件中 `ctx.doomLoop.check` 后 `permission.ask({ permission: "doom_loop" })`（约 486 行）。
- `packages/opencode/src/session/prompt.ts`：循环每步 `processor.create`（约 1363 行）；`SessionTools.resolve`（约 1382 行）；组装 `messages`（约 1428 行）。
- `packages/opencode/src/session/doom-loop.ts`：周期 1–10 检测器。
- `packages/tui/src/context/sync.tsx`：`permission.asked` 在 auto 模式下回复 `once`（约 192 行）。
- `packages/opencode/src/agent-management/delegation.ts`：`renderOutput` 只有 `id`、`state`。
- `packages/opencode/src/tool/agent.ts`：agent_send 返回 `Accepted for …`；agent_list 无参数。

### 1.4 预期与实际

| 场景                  | 预期                            | 实际                                             |
| --------------------- | ------------------------------- | ------------------------------------------------ |
| 一次返回内重复调用    | 第 3 个起不执行，以错误返回     | 询问被自动放行，全部执行                         |
| 跨步原样重复          | 模型每步看到"已重复 N 次"的事实 | 无任何信号，上下文每步只追加同样的一对调用与报错 |
| 结束报告与 agent_send | 带 run 编号与时间，可判断先后   | 不带，只能靠记录顺序，而顺序在竞态下是反的       |
| 查看子 agent          | 可查单个、可过滤                | 只能整表输出                                     |

## 第二部分：根因分析

### 2.1 检测范围从一开始就是一步

上游在 2025-10-30 引入死循环检测（anomalyco/opencode#3445）：每个 `tool-call` 事件读取"当前助手消息"的最后 3 个部件比较。当时的循环已经是每轮 `stopWhen: stepCountIs(1)`、每步 `processor.next()` 新建一条助手消息，所以"当前助手消息"即"当前一步"。检测只能发现模型一次返回里的连续相同调用，从未覆盖跨步重复。

本 fork 的 #20/#22（`docs/fixes/session-processor-fix-periodic-doom-loop.md`）把检测扩展为周期 1–10，并明确规定状态只保存在 processor 内、不读取历史。processor 每步新建，范围仍是一步。当时的复现在一步之内，未识别"一步"与"一次 run"的区别。

**根因 1**：检测器生命周期等于一步；最常见的"一步一个调用、原样重复"不可见。

### 2.2 触发后的处理可被自动放行

检测触发后发起 `doom_loop` 权限询问（`agent.ts` 默认 `ask`）。TUI 的 auto 模式对任何询问回复 `once`；无头 `run --auto` 同理。此外检查位于 processor 的事件处理，与 AI SDK 的工具执行并行，询问本身不阻止该调用执行（修复中以测试确认）。

**根因 2**：一步内的保护依赖人工应答，在无人值守下失效。

### 2.3 跨步重复的不动点

风暴期间每步推理 0 token、输出逐字相同。每轮只向上下文追加一对与上一轮相同的"调用＋报错"（约 169 token），模型的输入几乎不变，于是产生相同输出；历史里相同调用越多，下一次越可能相同。报错文本本身固定不变，不能打破这个不动点。

诱因（不在本修复范围，另行处理）：上下文长期处于 80 万以上（#77、配置上限）；任务为数连续右括号；FSM 状态禁用了 bash。

**根因 3**：跨步重复时，模型每步看到的新信息为零。

本修复对跨步重复采用"每步附加事实计数"而非拦截，**这是缓解而非消除**：按维护者决定，跨 run 的重复可能是 agent 的有意行为，跨步也不设上限、不结束 run。

### 2.4 子 agent 状态缺少身份与时间

- 结束报告与 agent_send 返回都没有 run 编号与时间；父 agent 只能依记录顺序推断，而 1.2 的竞态下记录顺序与实际发生顺序相反。
- 花名册只在轮次开始或压缩后写入，只列在跑的子 agent，总数与空闲数不可见。
- agent_list 无参数，子 agent 多时输出过大，模型几乎不调用。

## 第三部分：参考实现对照

项目规则未列出这两类机制的现成参考实现。沿用 #22 的做法，以"按定义直接计算"的朴素实现作为参考，并与上游原始实现对照。不使用非一手来源。

### 3.1 一步内重复：三段相等

参考定义（与 #22 相同）：

```text
threeEqualBlocks(seq, p) := len(seq) ≥ 3p ∧ seq[-3p:-2p] = seq[-2p:-p] = seq[-p:]
detect(seq) := ∃ p ∈ [1,10]. threeEqualBlocks(seq, p)
```

`seq` 为本步内按发出顺序排列的 `[tool, input]` 签名。现有检测器的判定与之一致（已有随机对照测试），本修复不改算法，只改检测器所在位置与触发后的处理。

### 3.2 跨步计数

参考定义，`steps` 为本次 run 内已完成步骤的列表，每步记为 `(calls, results)`，`calls` 为按顺序的 `[tool, input]` 列表（input 按模型给出的键顺序序列化，与 3.1 的签名相同），`results` 为按顺序的 `[status, output 或 error]` 列表：

```text
callRepeat(steps)   := 末尾满足 steps[i].calls = steps[i-1].calls 且 calls 非空 的最长连续 i 的个数
resultRepeat(steps) := 末尾满足 steps[i].calls = steps[i-1].calls 且 steps[i].results = steps[i-1].results 且 calls 非空 的最长连续 i 的个数
```

增量实现每步只比较上一步，按"相同加一、不同清零"更新；朴素实现每步从完整列表重新计算。二者在任意序列上应逐步相等（第六部分 PBT）。

### 3.3 与上游 #3445 在 1.1 输入上的差异

| 调用         | 上游 #3445                    | 本 fork 现状（#22） | 本修复                          |
| ------------ | ----------------------------- | ------------------- | ------------------------------- |
| 第 1 步 Edit | 当前消息只有 1 个部件，不比较 | 新检测器，签名数 1  | 无上一步，计数 0                |
| 第 2 步 Edit | 同上                          | 新检测器，签名数 1  | 调用相同、结果相同，计数 1/1    |
| 第 k 步 Edit | 同上                          | 同上                | 计数 k−1，第 k+1 步请求末尾附带 |

首个差异出现在第 2 步：现有实现的状态在步间被丢弃。

## 第四部分：修复方案

### 4.1 每步末尾附加段（共用机制）

- **位置**：`prompt.ts` 组装 `messages` 时，在历史消息之后、最后一步的 `MAX_STEPS_PROMPT` 之前，追加一条 user 消息。内容由若干节组成，无内容时不追加。
- **不持久化**：只存在于本步请求中，下一步重新生成。不写入会话历史，不进入压缩输入。
- **缓存**：该消息带 `providerOptions.opencode.tail = true` 标记；`provider/transform.ts` 的 `applyCaching` 选取最后两条消息时跳过带此标记的消息。
- **Anthropic 自动缓存**：配置了顶层 `cacheControl` 时不走 `applyCaching`，服务端把断点放在最后一个可缓存块，也就是末尾段；末尾段每步都变，于是每步只写不读。此时在末尾段之前的最后一条消息上加一个显式断点，取值与顶层 `cacheControl` 相同（含 TTL，避免长短 TTL 顺序冲突）。显式断点只加这一个，自动断点仍落在末尾段，占用一个槽位。
- **标记不出 transform**：`ProviderTransform.message` 在放置缓存断点之后、提供方键重映射之前删除该标记。原因：重映射会把 `providerOptions[providerID]` 改名为 SDK 键，提供方 ID 恰为 `opencode`（Zen）时标记会变成 `anthropic.tail` 等 SDK 选项。现有 SDK 忽略未知字段，删除是防御，保证请求体不受标记影响。
- **Mistral**：该系列要求 tool 消息后不能直接接 user，transform 会在两者之间插入一条 assistant `Done.`。有末尾段时这条插入也只出现在每步可变的后缀里，不影响前缀缓存。
- **追溯**：每步以 INFO 日志记录末尾段文本（`message="step tail"`，含 session 与 step）。消息部件没有通用元数据字段，不为此改动数据结构。
- 节的顺序：子 agent 状态（4.9）在前，重复计数（4.3）在后。

### 4.2 #76 一步内重复：拒绝执行

- 每步由 `prompt.ts` 在本步最终工具表组装完成之后（`SessionTools.resolve` 的结果再加上 StructuredOutput）调用 `SessionTools.refuseRepeats`，为本步创建一个 `DoomLoop` 检测器（工具表每步重建，检测器天然是一步的范围）。
- 包装最终工具表中每个工具的执行函数（含内置工具、MCP 工具、三个 MCP 资源工具、StructuredOutput，代码模式同样经过）：调用前执行 `check(tool, input)`；检测为真时**不执行**，以错误返回：

  ```text
  Not run: within this one response, the same tool calls have now been repeated three times in a row.
  ```

  不点名工具：周期大于 1 的循环由多个工具组成，"同一工具 k 次"的说法对它不成立。统一包装与旧 processor 检查的覆盖面一致（它看到每一个调用）。

- 兼容 `doom_loop` 权限键：按会话与 agent 的合并规则求值，`allow` 时不拒绝；`ask`、`deny` 均直接拒绝，不发起询问。
- 删除 processor 中的检测器与 `doom_loop` 询问。TUI 的 auto 回复逻辑不变（不再收到此类询问）。

### 4.3 #76 跨步重复：只计数

- 状态由 `runLoop` 持有，run 开始为空、run 结束丢弃。
- 每步结束且 run 决定继续时，读取刚结束这一步的助手消息的工具部件，与本 run 上一步的签名比较，按 3.2 的定义更新 `callRepeat` 与 `resultRepeat`：调用相同则 `callRepeat + 1`，否则清零；调用与结果都相同则 `resultRepeat + 1`，否则清零；本步没有工具调用时两者清零。发送前因预估溢出而撤回、转去压缩的一步，以及服务端报上下文越界、转去压缩的一步（结果为压缩且消息没有 finish），都不是完成的步骤，不参与比较，计数原样带到压缩后真正执行的那一步。空回复也不构成一步：processor 在同一步内重试，重试得到的响应才是这一步的内容。
- `callRepeat > 0` 时下一步请求的末尾附带一节。模型读到它时上一步已经结束，所以说"你的上一步"：

  ```text
  Your last step repeated the tool calls of the step before it: 3 times in a row; the results were identical too: 3 times in a row.
  ```

  `resultRepeat = 0` 时后半句改为 `the results differed this time.`

- 不设上限，不结束 run，不拦截。
- 已知局限：只比较相邻两步，交替循环（失败编辑 → 读文件 → 失败编辑）不计数。

### 4.4 #75 run 记录

> 2026-10-29：本节与 4.9 按子计划 `agentmgmt-2-run-state`（§4.1、§4.2、§4.5）修订；冲突时以子计划为准。

- 子 agent 会话（有 `parentID`）的元数据增加 `agentRun`：当前 run 的 `{ number, started_at, woken_by, ended_at?, outcome? }` 加上一个 run 的结束 `previous?: { number, ended_at, outcome }`。结局四种：completed、failed、stopped、lost。
- **开始**：`loop()` 包装的工作开始时，由 work 闭包的标志区分新 run 与 re-arm（runner 续跑重执行同一个 work）。新 run 时 `number + 1`，写入 `started_at` 与 `woken_by`，上一条记录的结束移入 `previous`；遗留的打开记录（崩溃或结束写失败）先关为 `lost`。re-arm 不写。
- **结束**：工作退出时在同一个 `onExit` 里只读一次 re-arm 判据，再依次关闭记录、发报告。成功退出且有未消费的消息则不关闭；否则写入 `ended_at` 与 `outcome`（被中断为 `stopped`）。
- **woken_by**：首次 run 记创建者（父）；此后取唤醒本 run 的最新用户消息的来源：agent 消息与子 agent 的结束报告（二者都带发送方标记）记发送方 session、名字与类型；人经 TUI 的 agent-message 路由记 `user`；其余记 `system`。
- **agent 消息打标记**（#73 的服务端部分）：`AgentInbox.deliver` 投递 agent 发送方的消息时，文本部件增加 `metadata: { kind: "agent_message", sender, sender_name, sender_agent }`；人经 TUI 发进子会话的头行部件带 `{ kind: "user_message" }`；结束报告的部件在既有 `agent_notification` 之上增加发送方三字段。模型看到的文本不变；TUI 的展示改动仍在 #73 另做。
- **会话 patch 加锁**：`Session.patch` 原本无锁、整行后写者胜，run 记录会被每条消息投递时的 `touch` / `setAgentModel` 覆盖；子计划 2 在 `Session.patch` 内按会话串行化。
- **run 结束的定义**（#81，2026-10-23 并入）：循环正常退出且插件钩子 `experimental.session.stop` 放行。钩子阻止则落库一条合成用户消息（理由）并在同一 run 内继续，不加号、不关闭记录、不发报告。详见子计划 §4.4。

### 4.5 #75 结束报告

- `renderOutput` 增加属性：`<agent id="…" state="completed" run="5" ended="2026-10-20T03:41:18+08:00">`。时间为带时区的完整时间。
- 摘要（TUI 一行显示）追加 `(run 5, ended 03:41:18)`。
- 停止通知分开陈述 Session 取消操作与 `Latest run record after cancellation: N, ...` 记录快照，不把读到的编号推断成被取消的执行。run 号仍允许不连续；不回溯补发报告。第三轮复审的根因、窗口生命周期修正及 PBT 见 [Run 观察修正](session-fix-run-observations.md)。

### 4.6 #75 agent_send 返回

在投递**之前**读取目标的状态投影与 `agentRun` 作为快照（投递是立即 fork 的，之后读会读到混合状态），按快照分六种措辞（原文见子计划 §4.6）：

- 目标空闲、记录已关闭：`ses_xxx (cw-b333) was idle; this message starts run 6 (sent <时间>). Its run 5 ended at <时间> (completed); that report reaches you as a separate message.`（stopped / lost 的第二句不假定停止者是调用者）
- 目标空闲、无记录：第二句省略，首次写 `starts run 1`
- 目标空闲、记录未关闭（崩溃遗留）：写 `was cut off … will be recorded as lost`，仍预告 N+1
- 目标在跑、记录未关闭：`ses_xxx (cw-b333) is in run 5 (started <时间>); it reads this at its next step.`
- 目标在跑、记录已关闭或缺失：`is running (its run record is not updated yet)`，不预告号
- 目标没有 `agentRun` 也不是子会话（如主会话）：只写 `running` 或 `idle`
- 末尾一行：`Current state of one agent: agent_status(target="ses_xxx").`

### 4.7 #75 新增 agent_status

- 参数：`target`（必填，session id 或名字）。
- 返回：session id、名字、类型、关系、状态（running / idle）、run 行（五种写法：在跑且记录未关闭 / 在跑且记录已关闭或缺失 / 空闲且已关闭 / 空闲且未关闭即 cut off / 从未跑过）、上一个 run 的结束与结局、在跑时的最后一步时间、工作目录。
- 可查范围与 agent_list 相同（自己、父、直接子、兄弟），复用 `AgentTree.resolveTarget(scope: "neighbor")`。
- **权限与可见性跟随 agent_list**：工具表中按深度与 `Permission.disabled` 的别名表（`agent_status → agent_list`）同生同灭；执行时按 `agent_list` 的规则求值。

### 4.8 #75 agent_list 过滤与上限

- 新增可选参数：`status`（`running` | `idle`）、`relation`（`self` | `parent` | `child` | `sibling`）、`query`（名字或标题子串）、`limit`（默认 50）。
- 排序：在跑的在前，其余按最近活动时间倒序。
- 每行增加 run 编号与最近一次开始或结束时间。
- 末尾计数行：`showing 50 of 394 (10 running, 384 idle)`。
- 不带参数时默认上限 50，这是对现有输出的有意改变。

### 4.9 #75 末尾段的进度视图

- 仅当会话有筛选后有效的直接子 agent 且 `agent_list` 权限非 deny 时附带；总览与明细共同退窗（2026-11-03 修正，见 `session-fix-tail-window-counts.md`）。
- 第一行：当前时间（带日期与时区）与自身位置，如 `Now: 2026-10-27T19:54:07+08:00. You are in run 6, step 12.`
- 总览行：`Your subagents: 9 direct, 8 running, 1 idle.`；计数取在跑列表与窗口内结束/未结算列表的完整集合（截断前），不是历史子 Session 总数。两个列表都空时整节省略。
- 在跑列表：每行 session_id、名字、run 号、开始时间、唤醒来源、最后活动时间；上一个 run 在窗口内结束时附 `; run 5 ended 19:49:18 (completed)`。开始早的在前，最多 10 行，超出写 `… and N more running`。
- 窗口内结束、现在空闲的列表：每行 session_id、名字、run 号、结束时间、结局。结束晚的在前，最多 10 行，超出写 `… and N more finished`。
- 窗口取"最近 10 分钟"与"上一步开始以来"中更长者。
- 来源标注取 `woken_by`：本会话发送为 `your message`，其他 agent 为其名字，人为 `user`，其余为 `system`。
- 数据采集每步一次 SQL（按 parent_id 取直接子的元数据与更新时间），状态来自内存投影，不读历史。
- 写入历史的花名册在进度视图上线后撤销（2026-10-29 决定；原"最近 5 步的变化列表"方案同时撤销）。

## 第五部分：正确性论证

1. **缓存不受影响**：末尾段位于全部持久化内容之后，且从不持久化；第 n 步与第 n+1 步请求在真实历史部分逐字相同。缓存断点选择跳过末尾段，断点仍落在最后两条真实消息上。
2. **一步内拒绝只作用于重复本身**：检测为真的前提是同一签名序列连续出现三遍，前两遍照常执行；不同输入或不同工具不受影响；`allow` 规则保留了用户的退出选项。
3. **跨步计数不改变运行语义**：只追加文本，不拦截、不改变 run 的结束条件；每次 run 开始时状态为空，跨 run 不累计。增量更新与 3.2 的定义在每步相等（"相同加一、不同清零"等价于末尾最长连续段长度）。
4. **run 编号单调且与报告一致**：编号只在上一个 run 关闭后的新开始时加一；re-arm 的判断与 `reportRunEnd` 使用同一个 `hasUnconsumedTurn`，因此每份报告的编号就是该次关闭的 run 的编号；agent_send 在目标空闲时预告的"run N+1"即投递触发的下一次开始。
5. **权限一致**：agent_status 的可见性与执行权限都由 agent_list 的规则决定，禁用 agent_list 的配置不会经 agent_status 泄露同样的信息。
6. **不变量保持**：结束报告的触发条件、`hasLiveDescendant` 与 #53 的行为均不改变，只增加报告中的属性；写入历史的花名册在进度视图上线后撤销（子计划 2 commit 3），其信息由每步的进度视图承担。

## 第六部分：测试用例清单（计划）

**回归（必做）**

- R1：1.1 最小复现。断言 N 次 Edit 均执行，第 2 步起每步请求末尾含重复计数节且计数递增；末尾段不出现在会话历史中。
- R2：一次返回内 3 个相同调用，第 3 个未执行、以错误返回，run 继续。CLI `run`（非交互，询问一律自动拒绝）与 serve 下同样不产生询问，run 正常结束。
- R3：1.2 竞态。子 agent 结束报告含 run 与时间；agent_send 返回含目标 run 状态。

**边缘**

- 规则 `doom_loop: allow` 时一步内重复不拒绝。
- 轮询：相同命令、结果不变 → 两个计数都递增；结果变化 → 只有调用计数递增；不拦截。
- 不同输入的连续编辑计数为 0；新 run 计数从 0 开始。
- 一步多个调用按顺序整组比较；顺序不同视为不同。
- 发送前因溢出撤回并压缩的一步不清零计数（先在修正前的代码上确认失败）。
- R4（审核补正）：服务端报越界并压缩的一步不清零计数；一次返回内三个相同的 StructuredOutput 调用，第三个被拒绝；Anthropic 自动缓存模式下请求体除顶层 `cache_control` 外，末尾段之前的最后一块带同 TTL 的显式断点。三项均先在 `bfc07a0e80` 上确认失败。
- re-arm 不增加 run 编号；agent_stop 记 `stopped`；无上一个 run 时 agent_send 返回省略第二句。
- agent_status：按名字和 id 查询；超出可查范围报错；agent_list 被禁用时 agent_status 不可见。
- agent_list：各过滤项、默认上限、排序、计数行。
- 末尾子 agent 节：无子 agent 时不附带；变化超过 8 行时截断。
- 缓存：第 n+1 步请求的真实历史部分与第 n 步逐字相同；`applyCaching` 从不在末尾段上加断点；Anthropic 请求体中最后一个断点落在工具结果上，不落在末尾段文本上。
- 标记：提供方 ID 为 `opencode` 时，标记不进入 SDK 选项，该提供方自己的其他选项照常重映射。
- 工具表统一包装：同一工具表内第三次相同调用被拒绝且工具未执行；中间插入不同调用会打断连续；`doom_loop: allow` 时全部执行。

**随机（PBT）**

- P1：随机生成多步 `(calls, results)` 序列（工具、输入、成功/失败随机，含重复与交替），每步比较增量计数与 3.2 朴素定义。
- P2：随机生成一步内的调用序列，比较拒绝位置与 3.1 三段相等 oracle（复用现有 oracle）。
- P5（run 层，审核补正）：随机生成一次 run 内每步的结局序列（调用 A、调用 B、无工具调用的完成步、服务端越界后压缩），经真实 `runLoop` 与脚本化 LLM 执行，每个请求的末尾段与"只计已完成步骤"的 3.2 定义比对。
- P6（run 层，审核补正）：随机选取最终工具表中的工具（含 StructuredOutput）与周期，经真实 `runLoop` 发出一次返回内的周期重复，拒绝位置与 3.1 oracle 比对。
- P3：随机生成子 agent 事件序列（发送到空闲 / 在跑、完成 / 失败 / 被停、re-arm），断言 run 编号严格递增、每份报告编号等于当时进行中的 run、agent_send 预告的编号与下一份报告一致、结束时间不早于开始时间。
- P4：随机生成子 agent 集合与过滤参数，断言 agent_list 结果为全集子集、计数行与全集统计一致、行数不超过上限。

**既有用例的改写**（契约按 4.2 有意改变：不再询问，拒绝后 run 继续）

- `test/session/processor-effect.test.ts`：4 个"询问 / deny 即停"用例改为 1 个周期 2 用例加 3 个周期 1 用例（默认、allow、deny），断言 processor 不询问、不停止、调用全部记录。检测已不在 processor 内，这些用例的假 LLM 自带工具结果，只能验证 processor 不再介入。
- `test/cli/run/periodic-doom-loop-process.test.ts`：5 个"询问后退出码 1"用例改为"最后执行的那个调用被拒绝、其余完成、run 继续、退出码 0、无询问"；deny 用例同样改为拒绝后继续。其余 4 个（未达阈值、近似未命中、周期 11 超界、allow）不变。
- `test/cli/serve/periodic-doom-loop-process.test.ts`：once 与 reject 两个回复流程在新契约下不存在，合并为 1 个用例：同一会话两次提示，各自的循环都在最后一个调用被拒绝，全程没有权限请求，run 正常结束。

## 第七部分：代码更新清单（计划）

| 文件                                                   | 改动                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/opencode/src/session/prompt.ts`              | 末尾段组装；跨步计数状态（只计完成的步骤）；最终工具表组装后调用重复拒绝；run 记录的开始与结束                                                                                                                                                                              |
| `packages/opencode/src/session/step-tail.ts`（新）     | 末尾段的纯函数：计数更新、各节渲染                                                                                                                                                                                                                                          |
| `packages/opencode/src/session/tools.ts`               | 导出 `refuseRepeats`：一步内检测器与执行包装                                                                                                                                                                                                                                |
| `packages/opencode/src/session/processor.ts`           | 删除检测器与 `doom_loop` 询问                                                                                                                                                                                                                                               |
| `packages/opencode/src/provider/transform.ts`          | 缓存断点跳过末尾段；自动缓存模式下在末尾段前加显式断点；放置断点后删除标记                                                                                                                                                                                                  |
| `packages/opencode/src/agent-management/inbox.ts`      | agent 消息打标记                                                                                                                                                                                                                                                            |
| `packages/opencode/src/agent-management/schema.ts`     | `agentRun` 元数据键与类型                                                                                                                                                                                                                                                   |
| `packages/opencode/src/agent-management/delegation.ts` | 报告属性与摘要                                                                                                                                                                                                                                                              |
| `packages/opencode/src/tool/agent.ts`                  | agent_send 返回、agent_list 参数、agent_status、描述                                                                                                                                                                                                                        |
| `packages/opencode/src/tool/registry.ts`               | 注册 agent_status 并跟随 agent_list 的可见性                                                                                                                                                                                                                                |
| 测试                                                   | `test/session/step-tail.test.ts`（新）、`prompt.test.ts`、`processor-effect.test.ts`、`tools.test.ts`、`test/provider/transform.test.ts`、`test/cli/run/periodic-doom-loop-process.test.ts`、`test/cli/serve/periodic-doom-loop-process.test.ts`、agent-management 相关测试 |

## 第八部分：文档更新清单（计划）

- 本文档：回填第六、七部分的实际状态与提交。
- `docs/fixes/session-processor-fix-periodic-doom-loop.md`：注明"状态只保存在 processor 内"的范围局限，由本修复取代其处理方式。
- `packages/web/src/content/docs/permissions.mdx`、`agents.mdx`（英文，沿用 #22 只改英文的先例）：`doom_loop` 改为描述一步内拒绝与 `allow` 关闭。
- `docs/design/agent-management/architecture.md`、`detailed-design.md`、子计划 `agentmgmt-2-run-state.md`、调研 §18：run 记录、报告属性、agent_send 返回、agent_status、agent_list 参数、末尾段、停止钩子。（已写，待回填 commit）
- `docs/audits/agentmgmt-2-run-state/expectations.md`（§6）：本修复新增的契约——agent_status 参数与返回、agent_list 参数与输出、报告属性、agent 消息元数据、`agentRun` 元数据、停止钩子。（已写）
- 工具描述（`tool/agent.ts` 中的 description）：只写事实，不教用法（#59 的原则）。

## 举一反三

同类"范围按一步、语义按一次 run"的风险点，已另行记录或需复核：

- 压缩重试时摘要挂到最新用户消息（#77）。
- 压缩后恢复只在压缩处理后执行（#60 的修订），需确认标记确有已完成摘要。
- StructuredOutput 成功后不终止当前工具循环（#18）。

## 审核补正（提交 `bfc07a0e80` 之后）

外部审核在第一组提交后发现三处问题，均已复现并确认。三处都出在模块之间的衔接处：当时的随机测试只做在纯函数（P1）和 `SessionTools.resolve` 的返回值（P2）上，缓存测试只覆盖手动断点路径，都没有走到这些衔接点。为此补了 run 层的 P5、P6。

1. **StructuredOutput 不受一步内拒绝保护。** `prompt.ts` 在 `SessionTools.resolve` 完成包装之后才加入 StructuredOutput，而旧 processor 检查能看到每一个调用。复现：一次返回内三个相同的 StructuredOutput 调用全部完成。修正：包装移到本步最终工具表组装之后（4.2）。本修正不涉及 #18 的终止机制。
2. **服务端报上下文越界会清零跨步计数。** 越界的请求没有完成模型步骤，却被当作"没有工具调用的一步"参与比较。复现：相同 Edit 两步，服务端返回越界，压缩，再一次相同 Edit，压缩后两次请求都没有末尾段。修正：结果为压缩且消息没有 finish 的一步跳过计数更新（4.3）。
3. **Anthropic 自动缓存模式下末尾段承载了断点。** 配置顶层 `cacheControl` 时跳过 `applyCaching`，自动断点落在每步都变的末尾段上，每步只写不读。官方说明见 <https://platform.claude.com/docs/en/build-with-claude/prompt-caching#automatic-caching>，其中把"可变后缀上的断点"列为常见错误，建议在静态前缀末尾放显式断点。修正见 4.1。

## 回填（2026-10-31，`step-tail` 分支）

提交（按顺序）：

| 提交         | 内容                                                                          | 对应                             |
| ------------ | ----------------------------------------------------------------------------- | -------------------------------- |
| `bfc07a0e80` | 末尾段机制、一步内拒绝、跨步计数                                              | 4.1、4.2、4.3；R1、R2、P1、P2    |
| `97b272f37f` | 审核补正三项：StructuredOutput 入保护、服务端越界不清零、自动缓存前的显式断点 | 审核补正 1–3；R4、P5、P6         |
| `79f2e32ff9` | 停止钩子 `experimental.session.stop`（#81）                                   | 4.4 的 run 结束定义；子计划 §5.1 |
| `aae71d50ec` | run 记录、`Session.patch` 按会话串行、agent 消息标记（#73 服务端）            | 4.4；子计划 §5.2；P3 → T3、T9    |
| `4be70d5251` | 末尾段进度视图，花名册撤销                                                    | 4.9；子计划 §5.3；T7             |
| `e2cb3d5aeb` | 报告、停止通知与 agent_send 带 run                                            | 4.5、4.6；子计划 §5.4；R3        |
| `fe2470fdfd` | `agent_status`、`agent_list` 参数 / 排序 / 上限 / 计数行                      | 4.7、4.8；子计划 §5.5；P4 → T4   |

第六部分（测试）的实际落点：

- R1、R2、R4、P1、P2、P5、P6：`test/session/prompt.test.ts`、`test/session/step-tail.test.ts`、`test/session/tools.test.ts`、`test/provider/transform.test.ts`（第一组，已在 `bfc07a0e80` / `97b272f37f`）。
- R3：`prompt.test.ts` 的 run-end notice 用例（报告带 `run="N" ended="…"`）、INV-6b 定值用例（agent_send 预告的号 = 下一份报告）、`test/agent-management/tools.test.ts` 的 agent_send 六种措辞。
- P3 → T3（`prompt.test.ts`，随机并发多子）：run 号严格 +1、re-arm 不加、续跑窗口加一、结束写失败与遗留关为 lost、报告的号与关闭的 run 一一对应、记录打开时已 busy。agent_send 预告（INV-6b）由定值用例承担，理由见子计划 §5.4.3。
- P4 → T4（`tools.test.ts`）：随机邻居与参数，子集、计数行、上限、排序。
- 另有子计划新增的 T7（进度视图纯函数随机）、T8（停止钩子随机 run）、T9（并发 patch 随机）。
- 边缘项："变化超过 8 行时截断"随设计改为两个列表各 10 行加省略行；"末尾子 agent 节无子时不附带"在 `prompt.test.ts`。
- 既有用例改写：processor-effect、cli/run、cli/serve 的 doom-loop 用例已在第一组改写。

第七部分（代码）的实际落点与计划的差异：

- 新增 `agent-management/run.ts`（记录的纯函数）；`session/step-tail.ts` 增进度视图与采集函数（采集放在 StepTail 而非 prompt.ts，服务经参数传入以便计数测试）。
- `session/session.ts`：`patch` 按会话加锁（计划未列，子计划 §5.2.0 补入）。
- `session/status.ts`：投影条目带 `at`（线上 `Info` 不变）。
- `effect/runner.ts`、`session/run-state.ts`：`cancel` 返回取消前状态。
- `permission/index.ts`：`disabled` 的别名表加 `agent_status → agent_list`。
- `session/reminders.ts`：`applyAgentRoster` 删除，sentinel 保留。
- `tool/agent.ts`：agent_send 返回、agent_list 参数、agent_status；`tool/registry.ts` 注册并给 SessionStatus 依赖。
- `plugin/src/index.ts`、`core/src/v1/config/config.ts`：停止钩子类型与 `stop_hook_block_cap`。

第八部分（文档）：架构、细化设计、子计划、调研 §18、expectations 已随各 commit 更新；`customize-opencode.md`、web `agents.mdx` / `permissions.mdx` 已更新；`session-processor-fix-periodic-doom-loop.md` 的取代说明已在第一组加上。
