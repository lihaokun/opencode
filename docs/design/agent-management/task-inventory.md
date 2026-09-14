# `task.ts` 与连带消费者对照清单

- 状态：**终态标注**。2026-09-06 首版作为返工基准（含 16 条「缺失」）；2026-09-09 改为终态处置；
  2026-09-14 最终评审后：`task` **工具删除**（不再是隐藏别名），并补入全部非 `task.ts` 的
  运行时与 UI 消费者。
- 日期：2026-09-06，末次修订 2026-09-14
- 对象：`packages/opencode/src/tool/task.ts`（`dev` @ `a4293ca229`）及其连带消费者
- 用途：实现阶段的覆盖基准——每一条既有行为要么被明确保留、修改或废弃，不留悬空

## 0. 一条必须先说清的区分

```
复用旧实现的代码   ✓ 要做   —— 提取 runTask / inject / notify 与失败渲染，只保留一份
保留旧 task 工具   ✗ 不做   —— 运行时 tool ID 只剩 agent
保留旧 task 协议   ✗ 不做   —— 新的 task tool call 按未知工具处理
保留旧 task 配置键 ✓ 要做   —— schema 仍接受，读取时一次性规范化为 agent
保留历史 task 展示 ✓ 要做   —— 旧 transcript 的 task tool part 在展示层仍可读
```

前两行经常被混为一谈。**提取代码不等于保留工具。**

## 1. 入口与门禁

| # | 行为 | 位置 | 处置 | 落点与说明 |
|---|---|---|---|---|
| 1.1 | `background` 参数需实验开关，否则失败 | `:230-234` | **废弃** | Agent 恒为异步，参数与开关一并移除 |
| 1.2 | 沿 `parentID` 向上数祖先得 depth | `:236-242` | **保留** | 细化 §5.1.6 `callerDepth`，与本处共用同一函数避免漂移 |
| 1.3 | `depth >= (cfg.subagent_depth ?? 1)` 则失败 | `:243-249` | **修改** | 兜底改 3；到限时由 §5.5.5 `visibleTools` 在**工具列表生成期**撤下工具，本检查降为第二道防线 |
| 1.4 | `ctx.ask({ permission: "task", patterns: [subagent_type] })` | `:251-261` | **修改** | 调用**保留**（唯一求值 `deny` 的地方），权限 key 改为规范化后的 `agent`，兜底动作由 `ask` 改 `allow` |
| 1.5 | `bypassAgentCheck` 时跳过权限 | `:251` | **保留** | 既有内部旁路，细化 §5.5.1 步骤 2 |
| 1.6 | agent 类型不存在则失败 | `:263-266` | **保留** | 细化 §5.4.1 步骤 4，映射 `AgentTypeNotFound` |

## 2. 目标 Session 的建立与复用

| # | 行为 | 位置 | 处置 | 落点与说明 |
|---|---|---|---|---|
| 2.1 | 给了 `task_id` 则取既有 Session，取不到**静默回落为新建** | `:268-270` | **修改** | `agent` 不接受 `session_id`；恢复走 `agent_send`。**静默回落取消**：目标不存在报 `AgentNotFound` |
| 2.2 | `deriveSubagentSessionPermission` 给每个子追加 `task: * deny` | `subagent-permissions.ts` | **修改** | `canTask` 改查 `agent` 键，且**不再默认追加 `agent` deny**；`todowrite` 不动。不改则：仍发字面 `task` ⇒ 规则变死码、agent 定义级 opt-out 静默失效；移植成 `agent` ⇒ session ruleset 经 `findLast` 压过 agent 定义，**深度 3 一次都跑不起来** |
| 2.3 | `childToolDenies` 三类无条件 deny | `:275-287` | **修改** | 移除对 `agent` 的 deny；`todowrite` 与 `primary_tools` 保留。与 2.2 是**两个独立的拒绝点**，须同改 |
| 2.4 | 合并时按 (permission, pattern, action) **去重** | `:296-303` | **保留** | 既有行为，细化 §5.4.1 步骤 6 已明确 |
| 2.5 | 子 Session 标题 = `description + " (@<agent> subagent)"` | `:293` | **保留** | 细化 §5.4.1 步骤 8 |

## 3. 身份继承（agent / model / variant）

| # | 行为 | 位置 | 处置 | 落点与说明 |
|---|---|---|---|---|
| 3.1 | 读**发起调用的那条 assistant 消息**，非 assistant 则失败 | `:305-311` | **保留** | **读取点移到 M5**（细化 §5.5.1 步骤 3）：`ctx` 是工具层的东西，M4 只收窄数据 |
| 3.2 | `model = next.model ?? { 该消息的 modelID/providerID }` | `:314-317` | **保留** | 细化 §5.4.1 步骤 5，逐条复制 |
| 3.3 | `variant: next.model ? undefined : variant` | `:342` | **保留** | **只在 subagent 未固定模型时**才继承 variant |
| 3.4 | 子 Session 的 `agent` 字段 = `next.name` | `:294` | **保留** | 细化 §5.4.1 步骤 8 |
| 3.5 | 向**既有** Session 追加消息时的 agent/model/variant | —— | **新增** | 既有代码无此路径。`agent_send` 必须显式取目标当前三项，且 `variant === "default"` 时省略。细化 §5.3.2 步骤 3 |

**新增的一条约束**（不在旧代码里，但与本节同源）：子 Session **在 `Session.create` 时就持久化
已解析的 agent/model/variant**（`CreateInput` 有 `model`，`session.ts:348-357`），
不等首个异步 prompt 才绑定——否则在绑定之前的任何一次 `agent_send` 都会看到一个无 model 的
Session 并按 fallback 链改写它。细化 §5.4.1 步骤 8。

## 4. 执行注册

| # | 行为 | 位置 | 处置 | 落点与说明 |
|---|---|---|---|---|
| 4.1 | `background.extend({ id, run })` | `:409-424` | **废弃** | run 边界而非 turn 边界，且排队期间消息不落库。新设计下后续消息走异步入口，天然是 turn 边界 |
| 4.2 | `background.start({ id: 子SessionID, ..., onPromote, run })` | `:426-439` | **修改** | 保留"job id 即子 SessionID"；`onPromote` 随前台废弃而移除。细化 §5.4.4 步骤 1 |
| 4.3 | `run: runTask().pipe(Effect.onInterrupt(() => ops.cancel(子SessionID)))` | `:439` | **保留** | 细化 §5.4.4 步骤 2 |
| 4.4 | 前台分支：abort 监听、`raceFirst`、按结果渲染 | `:463-506` | **废弃** | 恒为异步 |
| 4.5 | `onPromote` / `waitForPromotion` / `background.promote` | `:431`、`:478` | **废弃** | 前台没了，死代码一并清理。**实际范围比这行原本写的大**：除 `BackgroundJob` 那三个成员外，还有 `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` 开关、`/experimental/session/:sessionID/background` 端点及其 capability 字段、以及 `backgroundSubagents` 从 `run.ts` 一路穿到 `footer.view.tsx` 的整条 UI 链。其中 TUI 那处**不只是死代码**——它按 `metadata.background !== true` 筛运行中的 subagent，而新实现根本不写该字段，于是每个 Agent 都被算作「前台」，footer 给出一个已无实现的「转后台」按键。它被默认关闭的实验开关挡着，所以没人撞见——这正是它能活下来的原因 |

## 5. 结果判定与失败分类

`runTask`（`:333-367`）的六个分支**全部保留**，逐条复制到细化 §5.4.5 `classify`，
并**只服务 `agent` 的初始委托**——`agent_send` 不产生结局，不经过这里。

| # | 条件 | 结果 | 位置 | 处置 |
|---|---|---|---|---|
| 5.1 | 返回的不是 assistant 消息 | 失败 `"Task prompt returned a non-assistant result"` | `:346-348` | **保留** |
| 5.2 | `error.name === "MessageAbortedError"` | `Effect.interrupt` → 结算 `cancelled` | `:350` | **保留**，`cancelled` 的**唯一自然来源**；**必须先于 5.3 求值** |
| 5.3 | `error` 存在或 `finish === "length"` | `formatAssistantFailure` | `:352-356` | **保留** |
| 5.4 | 最后一个 tool part 状态为 error | `formatSubagentFailure` | `:357-360` | **保留** |
| 5.5 | `finish` 缺失或 `unknown` 且无可用输出 | `formatIncompleteResponse` | `:361-365` | **保留** |
| 5.6 | 以上皆否 | `lastVisibleText(result)` —— **最后一条** text part | `:366` | **保留**。注意它是 `?? ""`，**纯工具调用完成时合法返回空串**，设计必须允许 `{completed, text:""}`，不虚构 fallback |

四个渲染函数与 `hasUsableOutput` / `lastVisibleText` / `allVisibleText` 全部照用，
随 §6.6 一并从闭包中提取。

## 6. 通知交付

| # | 行为 | 位置 | 处置 | 落点与说明 |
|---|---|---|---|---|
| 6.1 | `notify(jobID)`：`completed` 注入完成、`error` 注入失败、其余（含 `cancelled`）**静默** | `:398-407` | **保留** | 不补 `cancelled` 分支。取消通知由 M4 `stop` 产出（细化 §5.4.7），二者互补；补了会重复 |
| 6.2 | `inject` 的投递 payload：`agent: currentParent.agent ?? ctx.agent`、`variant`（**闭包捕获的旧值**）、**完全不传 `model`** | `:373-380` | **修改** | 只有 agent 那一项是对的。不传 `model` ⇒ `createUserMessage` 落到 `ag.model ?? currentModel`，父的 agent 定义若有固定模型会**覆盖父当前模型并落库**；`variant` 用的是 `:312` 在创建时捕获的值，**父在子运行期间换过 variant 就会被改回去**。必须在投递时**重新读取**父的当前 agent/model/variant，与 `agent_send` 同一条规则 |
| 6.3 | `inject` 的投递目标恒为 `ctx.sessionID`（调用方 = 父） | `:373` | **保留** | 初始委托的调用者**就是**父。`agent_send` 不产生结局，故不需要改成从 parentID 解析 |
| 6.4 | `notify` 与 `inject` 都 `forkIn(scope)`，失败被 `Effect.ignore` 吞掉 | `:386`、`:405` | **保留** | 与"通知只保证**至多发起一次**，不保证送达"的口径一致。不为它加确认机制 |
| 6.5 | 通知只在 `background.start` 时注册一次 | `:409-424` | **保留** | 细化 §5.4.4 步骤 5 |
| 6.6 | `runTask` / `inject` / `notify` 是 `TaskTool.execute` 内的**闭包** | `:333`/`:369`/`:398` | **修改** | 不是可直接调用的 helper。必须**最小提取**为共享内部实现、显式传窄数据。**只提取一份，不复制第二套** |

## 7. 取消与中断

| # | 行为 | 位置 | 处置 | 落点与说明 |
|---|---|---|---|---|
| 7.1 | `ops.cancel(子SessionID)` 中断子 Session 的执行 | `:464` | **保留** | 细化 §5.4.4 步骤 2 |
| 7.2 | 前台 abort 监听 → cancel | `:466-473` | **废弃** | 随前台废弃 |
| 7.3 | release 阶段若被中断 → 同时 `ops.cancel` 与 `background.cancel` | `:496-499` | **保留** | 语义并入 `agent_stop` |
| 7.4 | `SessionRunState.cancel` 对 idle 目标是**成功空操作** | `run-state.ts:77-86` | **保留**（callee 事实，非可改行为） | 细化 §5.4.7 据此**不做状态审计**：事后分不出两种情形，而先读再取消**同样测不准**（读到 running 之后目标可能自行结束）。`StopOutcome.stopped` 只表示"执行了停止操作" |

## 8. 工具表面

| # | 行为 | 位置 | 处置 | 落点与说明 |
|---|---|---|---|---|
| 8.1 | `ctx.metadata({ title, metadata: { parentSessionId, sessionId, model } })`，其中 `model` 是 `:314` 解析后的值 | `:325-328` | **保留** | **已经记的是子 Agent 解析后的 model，不是父的继承候选**——这是对的，实现时**不要改坏**。细化 §5.5.1 步骤 5，且**在 M5 调用**（M4 不接触 ctx） |
| 8.2 | `ops.resolvePromptParts(params.prompt)` 展开 `@file` | `:334` | **保留** | 细化 §5.4.1 步骤 9。**返回值是 `parts[]` 必须保持形态**——压成字符串会丢附件 |
| 8.3 | 工具 description 与 jsonSchema 随实验开关切换 | `:511-515` | **废弃** | 开关移除后固定一套 |
| 8.4 | `execute` 外层 `Effect.orDie` | `:517-518` | **修改** | 本 feature 定义八个 typed error 并由 M5 渲染为文本 |
| 8.5 | 三段 background 常量 | `:25-42` | **废弃** | 前台与 extend 都没了；`agent` 的描述重写 |

## 9. 汇总

共 42 条既有行为，全部有终态处置：

| 处置 | 条数 |
|---|---|
| 保留 | 25 |
| 修改 | 8 |
| 废弃 | 8 |
| 新增 | 1 |

与上一版（保留 26 / 修改 7 / 废弃 8 / 新增 1）的唯一差异：**6.2 由「保留」改「修改」**。
上一版称 `inject` "已经在用目标自己的 agent，正是所需写法"——那只对了三分之一：
`model` 根本没传，`variant` 用的是创建时捕获的旧值。两者都会改写并持久化父的身份。

## 10. `task` 工具删除的连带消费者

以下不在 `task.ts` 内，但删除 `task` 工具后**必须一并迁移**，否则功能静默消失。
逐条依据见细化 §2.3。

### 10.1 运行时（必须改成 `agent`）

| 位置 | 现状 | 不改的后果 |
|---|---|---|
| `tool/registry.ts:268` | `Permission.evaluate("task", item.name, agent.permission).action !== "deny"` | subagent type 级权限过滤失效 |
| `session/prompt.ts` | agent part 的权限判断与「call the task tool」模型提示 | 模型被提示去调一个不存在的工具 |
| 内置 Plan Agent 等 | 硬编码的 permission key | 权限判断落空 |

### 10.2 内置 Agent 的 allowlist（必须显式放行）

| 位置 | 现状 | 不改的后果 |
|---|---|---|
| `agent/agent.ts:196-211` `explore` | `"*": "deny"` 加白名单，白名单里没有新工具 | **四个 Agent 管理工具全部被过滤掉**，`explore` 完全用不了 |

用户自定义 Agent 的显式 deny 继续被尊重，不由本 feature 强制覆盖。
深度上限仍由 §5.5.5 的工具列表过滤承担。

### 10.3 UI / CLI 的 tool part 消费者（必须改接 `agent`）

| 位置 | 现状 |
|---|---|
| `tui/routes/session/index.tsx:221` | `part.tool === "task"`（foregroundTasks） |
| `tui/routes/session/index.tsx:1511`、`:1522` | subagent 导航与 running 展示 |
| `tui/routes/session/index.tsx:1767`、`:2648` | display 分支与工具名清单 |
| `tui/routes/session/permission.tsx:286` | `if (permission === "task")` |
| `app/pages/session/timeline/message-timeline.tsx:95` | `part.tool !== "task"` 直接 return |
| `cli/cmd/run/subagent-data.ts:334` | `if (part.tool !== "task") return` |
| `cli/cmd/run/tool.ts:578`、`:1436` | kind 与 name 分支 |
| `cli/cmd/agent.ts:26` | 工具名清单 |

**纯展示层可同时识别历史 `task` part**，保证旧 transcript 可读——这不恢复执行能力。
前台转后台相关 UI 随前台模式一并删除。

**禁止全局盲替换**：历史展示、普通英文 "task" 含义、legacy 配置入口要逐项分类。

### 10.4 其余（不属于 `task` 删除，但同批必改）

| 位置 | 改动 | 依据 |
|---|---|---|
| `core/src/v1/config/config.ts` | `subagent_depth` 说明文字仍写 Defaults to 1 | 1.3 |
| config 权限 schema | 同时接受 `task` 与 `agent`，读取时一次性规范化 | 架构 §6 |
| `session/tools.ts` `resolve` | **在此按 `session.id` 计算深度并过滤工具**——`Tool.Context` 此时不存在 | 细化 §5.5.5 |
| `session/reminders.ts` | 增加 roster 分支，用**落盘**那种写法（`:56`），不用内存 push（`:28`） | 细化 §5.5.6 |
| `worktree/index.ts` | 新增 Agent 专用内部入口（ready 契约）；**不给公开 `CreateInput` 加 `root`** | 细化 §5.4.2 |
| `tui/routes/session/index.tsx:208-213`、`:229-235` | 权限/question 聚合改为整棵后代，回复按 `request.sessionID` 路由 | 架构 §6，深度改动的必要连带项 |
