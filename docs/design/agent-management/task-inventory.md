# `task.ts` 现有行为对照清单

- 状态：返工基准，随架构与细化修订同步更新
- 日期：2026-09-06
- 对象：`packages/opencode/src/tool/task.ts`（`dev` @ `a4293ca229`）
- 用途：`agent-management` 返工时逐条确认处置，避免再次遗漏既有契约

## 为什么需要这张表

首轮细化把 `task.ts` 当成"一个投递消息的地方"，只复用了它最表层的一步。实际它是一整套子 Agent 执行契约：
结果提取、失败分类、身份继承、元数据、标题、附件展开、权限合并都在其中。审查发现的 P0-1（通知所有权缺失）
只是这个疏漏的一个切面。本表把现有行为逐条列出并标注处置，作为返工的覆盖基准。

处置取值：**保留**（行为不变）／**修改**（行为变但职责保留）／**废弃**（本 feature 明确移除）／
**缺失**（设计尚未覆盖，返工必须补）。

## 1. 入口与门禁

| # | 行为 | 位置 | 处置 | 说明 |
|---|---|---|---|---|
| 1.1 | `background` 参数需实验开关，否则调用失败 | `:230-234` | **废弃** | Agent 恒为异步，参数与开关一并移除（架构 §6） |
| 1.2 | 沿 `parentID` 向上数祖先得 depth | `:236-242` | **保留** | 抽为共享函数，M1 与工具可见性判定共用（细化 P1-2） |
| 1.3 | `depth >= (cfg.subagent_depth ?? 1)` 则失败 | `:243-249` | **修改** | 兜底改 3；且到限时由工具可见性撤下 `agent`，本检查降为第二道防线 |
| 1.4 | `ctx.ask({ permission: "task", patterns: [subagent_type] })` | `:251-261` | **修改** | 调用**保留**（它是唯一求值 `deny` 的地方），把兜底动作由 `ask` 改 `allow`；`task` 与 `agent` 共用权限 key |
| 1.5 | `bypassAgentCheck` 时跳过权限 | `:251` | **保留** | 既有内部旁路，不动 |
| 1.6 | agent 类型不存在则失败 | `:263-266` | **保留** | 映射为 `AgentTypeNotFound` |

## 2. 目标 Session 的建立与复用

| # | 行为 | 位置 | 处置 | 说明 |
|---|---|---|---|---|
| 2.1 | 给了 `task_id` 则取既有 Session，取不到静默回落为新建 | `:268-270` | **修改** | `agent` 不再接受 `session_id`（调研 §13）；恢复走 `agent_send`。`task` 兼容入口把 `task_id` 转为 `agent_send` 的目标。**静默回落取消**：目标不存在应报 `AgentNotFound`，不悄悄新建 |
| 2.2 | `deriveSubagentSessionPermission({ parentSessionPermission, subagent })` | `:271-274` | **保留** | 不改 |
| 2.3 | `childToolDenies`：`todowrite` / `task` / `experimental.primary_tools` 三类无条件 deny，除非 agent 定义已有同名规则 | `:275-287` | **修改** | 移除对 `agent` 的 deny（否则深度改动无效）；`todowrite` 与 `primary_tools` 保留 |
| 2.4 | 合并 `childPermission` 与 `childToolDenies` 时按 (permission, pattern, action) **去重** | `:296-303` | **缺失** | 细化只写"叠加"，未写去重。返工补 |
| 2.5 | 子 Session 标题 = `description + " (@<agent> subagent)"` | `:293` | **缺失** | roster 显示的就是它。返工须在 `create` 明确该约定 |

## 3. 身份继承（agent / model / variant）

| # | 行为 | 位置 | 处置 | 说明 |
|---|---|---|---|---|
| 3.1 | 读**发起调用的那条 assistant 消息**（`ctx.messageID`），非 assistant 则失败 | `:305-311` | **缺失** | variant 与继承模型的来源。返工须明确 |
| 3.2 | `model = next.model ?? { 该 assistant 消息的 modelID/providerID }` | `:314-317` | **缺失** | 即"subagent 固定模型优先，否则继承父 Agent 当次调用的模型"。细化的 `create` 完全没定 model（审查 P0-3） |
| 3.3 | `variant: next.model ? undefined : variant` | `:342` | **缺失** | **只在 subagent 未固定模型时**才继承 variant。返工须照此复制，不能简化 |
| 3.4 | 子 Session 的 `agent` 字段 = `next.name` | `:294` | **保留** | |
| 3.5 | 向**既有** Session 追加消息时的 agent/model/variant | —— | **缺失** | 现有代码无此路径（`extend` 复用原 run 的参数）。`agent_send` 是新路径，必须显式取目标 Session 当前持久化的三项；`createUserMessage` 的优先级是 `input.model ?? ag.model ?? currentModel`，只传 agent 会被 agent 定义的模型覆盖并落库（审查 P0-3） |

## 4. 执行注册

| # | 行为 | 位置 | 处置 | 说明 |
|---|---|---|---|---|
| 4.1 | `background.extend({ id, run })`：目标 job 在跑则把新 run 挂在其后 | `:409-424` | **废弃** | run 边界而非 turn 边界，且排队期间消息不落库（调研 §2） |
| 4.2 | `background.start({ id: 子SessionID, type, title, metadata, onPromote, run })` | `:426-439` | **修改** | 保留"job id 即子 SessionID"这一身份约定；`onPromote` 随前台废弃而移除 |
| 4.3 | `run: runTask().pipe(Effect.onInterrupt(() => ops.cancel(子SessionID)))` | `:439` | **保留** | 外部中断 job 时连带取消子 Session 的执行 |
| 4.4 | 前台分支：注册 abort 监听、`raceFirst(wait, waitForPromotion)`、按结果渲染、中断时同时 cancel 两者 | `:463-506` | **废弃** | 恒为异步 |
| 4.5 | `onPromote` / `waitForPromotion` / `background.promote` 的前台转后台机制 | `:431`、`:478` | **废弃** | 前台没了，这套随之成为死代码，实现阶段一并清理 |

## 5. 结果判定与失败分类 —— 整块缺失

`runTask`（`:333-367`）在子 Session 跑完后有六个分支，决定"这个 Agent 的最终结果是什么"。
**细化设计完全没有覆盖这一块**，而它正是通知通道要送的内容。

| # | 条件 | 结果 | 位置 | 处置 |
|---|---|---|---|---|
| 5.1 | 返回的不是 assistant 消息 | 失败 `"Task prompt returned a non-assistant result"` | `:346-348` | **缺失** |
| 5.2 | `error.name === "MessageAbortedError"` | `Effect.interrupt` → job 结算为 `cancelled` | `:350` | **缺失**，且是 `cancelled` 终态的**唯一自然来源** |
| 5.3 | `error` 存在，或 `finish === "length"` | `formatAssistantFailure`（错误名+消息，或输出超长时带 token 数与部分输出摘录、截断提示） | `:352-356` | **缺失** |
| 5.4 | 最后一个 tool part 状态为 error | `formatSubagentFailure(该 tool 的 error)` | `:357-360` | **缺失** |
| 5.5 | `finish` 缺失或 `unknown`，且无可用输出 | `formatIncompleteResponse` | `:361-365` | **缺失** |
| 5.6 | 以上皆否 | `lastVisibleText(result)` —— **最后一条** text part，不是全部拼接 | `:366` | **缺失** |

配套的四个渲染函数 `formatAssistantFailure` / `formatSubagentFailure` / `formatOutputLengthFailure` /
`formatIncompleteResponse`，以及 `hasUsableOutput` / `lastVisibleText` / `allVisibleText` 的区别，
返工时须在细化设计里逐个引用其契约，不能一句"复用既有失败渲染"带过。

## 6. 通知交付

| # | 行为 | 位置 | 处置 | 说明 |
|---|---|---|---|---|
| 6.1 | `notify(jobID)`：`background.wait` → `completed` 注入完成、`error` 注入失败、其余（含 `cancelled`）静默 | `:398-407` | **修改** | 补 `cancelled` 分支；且必须是**唯一**的取消通知生产者（审查 P0-2） |
| 6.2 | `inject(state, text)`：取父 Session、以父自己的 agent 投递一条 synthetic text、`renderOutput` 包 `<task>` envelope 带 summary | `:369-396` | **保留** | 注意它已经在用"目标自己的 agent"（`currentParent.agent ?? ctx.agent`），正是 P0-3 要的写法 |
| 6.3 | `inject` 的投递目标恒为 `ctx.sessionID`（调用方 = 父） | `:373` | **修改** | `agent_send` 可由兄弟发起，调用方 ≠ 父。watcher 的投递目标须从**目标 Session 的 parentID** 解析，不能取调用方 |
| 6.4 | `notify` 与 `inject` 都 `forkIn(scope)`，失败被 `Effect.ignore` 吞掉 | `:386`、`:405` | **修改** | 自底向上排序要求"通知已落库"可等待，需暴露可 await 的完成信号（审查 P0-2） |
| 6.5 | 通知只在 `background.start` 时注册一次，`extend` 分支不再注册 | `:409-424` | **保留** | 这正是 I4（一个消息序列一个最终结果）的既有实现 |
| 6.6 | 谁持有 watcher：`agent` 创建 / 向 running 发消息 / 向 idle 发消息 三条分支 | —— | **缺失** | 现有代码只有"创建"一条。返工须写清三条各由谁起 job、谁持唯一 watcher（审查 P0-1） |

## 7. 取消与中断

| # | 行为 | 位置 | 处置 | 说明 |
|---|---|---|---|---|
| 7.1 | `ops.cancel(子SessionID)` 中断子 Session 的执行 | `:464` | **保留** | |
| 7.2 | 前台 abort 监听 → cancel | `:466-473` | **废弃** | 随前台废弃 |
| 7.3 | release 阶段若被中断 → 同时 `ops.cancel` 与 `background.cancel` | `:496-499` | **保留** | 语义并入 `agent_stop` |
| 7.4 | `SessionRunState.cancel` 对 idle 目标是成功空操作 | `run-state.ts:77-86` | **缺失** | 细化把所有未抛异常者记入 `stopped` 并发通知，导致重复 stop 违反幂等、no-op 也发"已取消"（审查 P0-2） |

## 8. 工具表面

| # | 行为 | 位置 | 处置 | 说明 |
|---|---|---|---|---|
| 8.1 | `ctx.metadata({ title, metadata: { parentSessionId, sessionId, model } })` | `:325-328`、`:432` | **缺失** | TUI 的 task 卡片靠它渲染。返工须在 `agent` 工具明确写入哪些字段 |
| 8.2 | `ops.resolvePromptParts(params.prompt)` 展开 prompt 里的 `@file` 引用 | `:334` | **缺失** | 细化在复用表里列了该函数，但 `create` 的步骤没用它 |
| 8.3 | 工具 description 与 jsonSchema 随实验开关切换 | `:511-515` | **废弃** | 开关移除后固定一套 |
| 8.4 | `execute` 外层 `Effect.orDie`：失败转为 defect | `:517-518` | **修改** | 本 feature 定义 typed error 并由 M5 渲染为文本，须明确边界上怎么处理 |
| 8.5 | 三段常量 `BACKGROUND_DESCRIPTION` / `BACKGROUND_STARTED` / `BACKGROUND_UPDATED` | `:25-42` | **废弃** | 前台与 extend 都没了；`agent` 的描述重写 |

## 9. 汇总

共 42 条既有行为：

| 处置 | 条数 |
|---|---|
| 保留 | 11 |
| 修改 | 9 |
| 废弃 | 7 |
| **缺失（返工必须补）** | **16** |

16 条缺失中，第 5 节（结果判定与失败分类）独占 6 条，是最大的单块空白；其余分布在身份继承（3）、
通知所有权（2）、工具表面（2）、权限合并与标题（2）、取消幂等（1）。

返工顺序建议：先补第 5 节与 6.6（决定 M3/M4 与执行所有权的形状），再补第 3 节（身份继承），
最后是第 2、7、8 节的零散项。
