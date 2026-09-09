# `task.ts` 现有行为对照清单

- 状态：**终态标注**。2026-09-06 首版作为返工基准（含 16 条「缺失」）；2026-09-09 第二轮评审后
  逐条改为最终处置并标注落点，「缺失」这一过渡取值已取消。
- 日期：2026-09-06，末次修订 2026-09-09
- 对象：`packages/opencode/src/tool/task.ts`（`dev` @ `a4293ca229`）
- 用途：实现阶段的覆盖基准——每一条既有行为要么被明确保留、修改或废弃，不留悬空

## 为什么需要这张表

首轮细化把 `task.ts` 当成"一个投递消息的地方"，只复用了它最表层的一步。实际它是一整套子 Agent
执行契约：结果提取、失败分类、身份继承、元数据、标题、附件展开、权限合并都在其中。
本表把现有行为逐条列出并标注最终处置与落点。

处置取值：**保留**（行为不变）／**修改**（行为变但职责保留）／**废弃**（本 feature 明确移除）／
**新增**（既有代码无对应物，本 feature 新建）。

## 1. 入口与门禁

| # | 行为 | 位置 | 处置 | 落点与说明 |
|---|---|---|---|---|
| 1.1 | `background` 参数需实验开关，否则调用失败 | `:230-234` | **废弃** | Agent 恒为异步，参数与开关一并移除（架构 §6） |
| 1.2 | 沿 `parentID` 向上数祖先得 depth | `:236-242` | **保留** | 细化 §5.1.8 `callerDepth`，与本处共用同一函数避免漂移；顺带返回树根供 `reserveName` 用 |
| 1.3 | `depth >= (cfg.subagent_depth ?? 1)` 则失败 | `:243-249` | **修改** | 兜底改 3（细化 §2.3）；到限时由 §5.5.5 `available` 撤下工具，本检查降为第二道防线 |
| 1.4 | `ctx.ask({ permission: "task", patterns: [subagent_type] })` | `:251-261` | **修改** | 调用**保留**（它是唯一求值 `deny` 的地方），权限 key 改为规范化后的 `agent`，兜底动作由 `ask` 改 `allow`。细化 §5.5 模块前言 |
| 1.5 | `bypassAgentCheck` 时跳过权限 | `:251` | **保留** | 既有内部旁路，细化 §5.5.1 步骤 2 |
| 1.6 | agent 类型不存在则失败 | `:263-266` | **保留** | 细化 §5.4.1 步骤 4，映射 `AgentTypeNotFound` |

## 2. 目标 Session 的建立与复用

| # | 行为 | 位置 | 处置 | 落点与说明 |
|---|---|---|---|---|
| 2.1 | 给了 `task_id` 则取既有 Session，取不到**静默回落为新建** | `:268-270` | **修改** | `agent` 不再接受 `session_id`（调研 §13）；恢复走 `agent_send`。`task` 兼容入口把 `task_id` 转为 `agent_send` 的目标。**静默回落取消**：目标不存在报 `AgentNotFound`（细化 §5.5.6） |
| 2.2 | `deriveSubagentSessionPermission` 给每个子追加 `task: * deny`（除非 agent 定义已有 `task` 规则） | `subagent-permissions.ts` | **修改**（首版误判为「保留」） | `canTask` 改查 `agent` 键，且**不再默认追加 `agent` deny**；`todowrite` 不动。不改则：仍发字面 `task` ⇒ 规则变死码、agent 定义级 opt-out 静默失效；移植成 `agent` ⇒ session ruleset 经 `findLast` 压过 agent 定义，**深度 3 一次都跑不起来**。细化 §2.3、架构 §6 |
| 2.3 | `childToolDenies`：`todowrite` / `task` / `experimental.primary_tools` 三类无条件 deny | `:275-287` | **修改** | 移除对 `agent` 的 deny（否则深度改动无效）；`todowrite` 与 `primary_tools` 保留。与 2.2 是**两个独立的拒绝点**，须同改。细化 §5.4.1 步骤 6 |
| 2.4 | 合并 `childPermission` 与 `childToolDenies` 时按 (permission, pattern, action) **去重** | `:296-303` | **保留** | 既有行为，首版细化漏写。细化 §5.4.1 步骤 6 已明确 |
| 2.5 | 子 Session 标题 = `description + " (@<agent> subagent)"` | `:293` | **保留** | roster 显示的就是它。细化 §5.4.1 步骤 8 |

## 3. 身份继承（agent / model / variant）

| # | 行为 | 位置 | 处置 | 落点与说明 |
|---|---|---|---|---|
| 3.1 | 读**发起调用的那条 assistant 消息**（`ctx.messageID`），非 assistant 则失败 | `:305-311` | **保留** | variant 与继承模型的来源。**读取点移到 M5**（细化 §5.5.1 步骤 3）：`ctx` 是工具层的东西，M4 只收窄数据 |
| 3.2 | `model = next.model ?? { 该 assistant 消息的 modelID/providerID }` | `:314-317` | **保留** | 细化 §5.4.1 步骤 5，逐条复制 |
| 3.3 | `variant: next.model ? undefined : variant` | `:342` | **保留** | **只在 subagent 未固定模型时**才继承 variant。细化 §5.4.1 步骤 5 照此复制，不简化 |
| 3.4 | 子 Session 的 `agent` 字段 = `next.name` | `:294` | **保留** | 细化 §5.4.1 步骤 8 |
| 3.5 | 向**既有** Session 追加消息时的 agent/model/variant | —— | **新增** | 既有代码无此路径（`extend` 复用原 run 的参数）。`agent_send` 必须显式取目标 Session 当前持久化的三项，且 `variant === "default"` 时省略——`createUserMessage` 的优先级是 `input.model ?? ag.model ?? currentModel`，省略会改写并落库目标身份。细化 §5.3.2 步骤 3 |

## 4. 执行注册

| # | 行为 | 位置 | 处置 | 落点与说明 |
|---|---|---|---|---|
| 4.1 | `background.extend({ id, run })`：目标 job 在跑则把新 run 挂在其后 | `:409-424` | **废弃** | run 边界而非 turn 边界，且排队期间消息不落库（调研 §2）。新设计下后续消息走 `prompt_async`，天然是 turn 边界 |
| 4.2 | `background.start({ id: 子SessionID, type, title, metadata, onPromote, run })` | `:426-439` | **修改** | 保留"job id 即子 SessionID"这一身份约定；`onPromote` 随前台废弃而移除。细化 §5.4.3 步骤 1 |
| 4.3 | `run: runTask().pipe(Effect.onInterrupt(() => ops.cancel(子SessionID)))` | `:439` | **保留** | 外部中断 job 时连带取消子 Session 的执行。细化 §5.4.3 步骤 2 |
| 4.4 | 前台分支：注册 abort 监听、`raceFirst`、按结果渲染、中断时同时 cancel 两者 | `:463-506` | **废弃** | 恒为异步 |
| 4.5 | `onPromote` / `waitForPromotion` / `background.promote` 的前台转后台机制 | `:431`、`:478` | **废弃** | 前台没了，这套随之成为死代码，实现阶段一并清理 |

## 5. 结果判定与失败分类

`runTask`（`:333-367`）在子 Session 跑完后的六个分支，决定"这个 Agent 的最终结果是什么"。
**六条全部保留，逐条复制到细化 §5.4.4 `classify`**，并只服务 `agent` 的初始委托——
`agent_send` 不产生结局，故不经过这里。

| # | 条件 | 结果 | 位置 | 处置 |
|---|---|---|---|---|
| 5.1 | 返回的不是 assistant 消息 | 失败 `"Task prompt returned a non-assistant result"` | `:346-348` | **保留** |
| 5.2 | `error.name === "MessageAbortedError"` | `Effect.interrupt` → job 结算为 `cancelled` | `:350` | **保留**，且是 `cancelled` 终态的**唯一自然来源**；**必须先于 5.3 求值** |
| 5.3 | `error` 存在，或 `finish === "length"` | `formatAssistantFailure`（错误名+消息，或输出超长时带 token 数与部分输出摘录、截断提示） | `:352-356` | **保留** |
| 5.4 | 最后一个 tool part 状态为 error | `formatSubagentFailure(该 tool 的 error)` | `:357-360` | **保留** |
| 5.5 | `finish` 缺失或 `unknown`，且无可用输出 | `formatIncompleteResponse` | `:361-365` | **保留** |
| 5.6 | 以上皆否 | `lastVisibleText(result)` —— **最后一条** text part，不是全部拼接 | `:366` | **保留** |

配套的 `formatAssistantFailure` / `formatSubagentFailure` / `formatOutputLengthFailure` /
`formatIncompleteResponse` 与 `hasUsableOutput` / `lastVisibleText` / `allVisibleText` 全部照用，
细化 §2.1 已逐个登记为复用项。

## 6. 通知交付

| # | 行为 | 位置 | 处置 | 落点与说明 |
|---|---|---|---|---|
| 6.1 | `notify(jobID)`：`background.wait` → `completed` 注入完成、`error` 注入失败、其余（含 `cancelled`）**静默** | `:398-407` | **保留**（首版判为「修改」） | 不补 `cancelled` 分支。`cancelled` 通知改由 M4 `stop` 产出（细化 §5.4.6），二者互补；补了会重复。非 `agent_stop` 导致的 cancelled 无人通知是正确的——那时父自己也已被取消 |
| 6.2 | `inject(state, text)`：取父 Session、以父自己的 agent 投递一条 synthetic text、`renderOutput` 包 envelope | `:369-396` | **保留** | 它已经在用"目标自己的 agent"（`currentParent.agent ?? ctx.agent`），正是身份不被改写所需的写法 |
| 6.3 | `inject` 的投递目标恒为 `ctx.sessionID`（调用方 = 父） | `:373` | **保留**（首版判为「修改」） | 上一版因为 `agent_send` 也要产生结局才需要改成"从目标 parentID 解析"。现在 `agent_send` 不产生结局，初始委托的调用者**就是**父，既有写法正确 |
| 6.4 | `notify` 与 `inject` 都 `forkIn(scope)`，失败被 `Effect.ignore` 吞掉 | `:386`、`:405` | **保留**（首版判为「修改」） | 上一版要求"通知已落库可等待"以支撑 I1。现在 I1 由 M4 `stop` 直接 `await deliver` 满足，与本处无关。被吞掉的失败是既有弱点，与"投递一次、不保证送达"的口径一致（架构 §10 缺口 5） |
| 6.5 | 通知只在 `background.start` 时注册一次，`extend` 分支不再注册 | `:409-424` | **保留** | 细化 §5.4.3 步骤 5：初始委托只交付一个结局 |
| 6.6 | 谁持有 watcher：创建 / 向 running 发消息 / 向 idle 发消息 三条分支 | —— | **废弃** | 问题本身消解：只有初始委托有 watcher，`agent_send` 根本不注册。上一版为此建的 M6 一并删除（架构 §6） |

## 7. 取消与中断

| # | 行为 | 位置 | 处置 | 落点与说明 |
|---|---|---|---|---|
| 7.1 | `ops.cancel(子SessionID)` 中断子 Session 的执行 | `:464` | **保留** | 细化 §5.4.3 步骤 2 |
| 7.2 | 前台 abort 监听 → cancel | `:466-473` | **废弃** | 随前台废弃 |
| 7.3 | release 阶段若被中断 → 同时 `ops.cancel` 与 `background.cancel` | `:496-499` | **保留** | 语义并入 `agent_stop`（细化 §5.4.6） |
| 7.4 | `SessionRunState.cancel` 对 idle 目标是**成功空操作** | `run-state.ts:77-86` | **保留**（是 callee 事实，不是可改行为） | 细化 §5.4.6 步骤 3a 据此**先读 `SessionStatus` 再取消**。不先读就分不出 transitioned 与 unchanged，会给 idle 成员发假通知、重复 stop 重复发 |

## 8. 工具表面

| # | 行为 | 位置 | 处置 | 落点与说明 |
|---|---|---|---|---|
| 8.1 | `ctx.metadata({ title, metadata: { parentSessionId, sessionId, model } })` | `:325-328`、`:432` | **保留** | TUI 的 task 卡片靠它渲染。细化 §5.5.1 步骤 6，**在 M5 调用**（M4 不接触 ctx） |
| 8.2 | `ops.resolvePromptParts(params.prompt)` 展开 prompt 里的 `@file` 引用 | `:334` | **保留** | 细化 §5.4.1 步骤 9。**返回值是 `parts[]` 必须保持形态**——压成字符串会丢附件 |
| 8.3 | 工具 description 与 jsonSchema 随实验开关切换 | `:511-515` | **废弃** | 开关移除后固定一套 |
| 8.4 | `execute` 外层 `Effect.orDie`：失败转为 defect | `:517-518` | **修改** | 本 feature 定义八个 typed error 并由 M5 渲染为文本（细化 §3），边界处不再一律 orDie |
| 8.5 | 三段常量 `BACKGROUND_DESCRIPTION` / `BACKGROUND_STARTED` / `BACKGROUND_UPDATED` | `:25-42` | **废弃** | 前台与 extend 都没了；`agent` 的描述重写 |

## 9. 汇总

共 42 条既有行为，全部有终态处置：

| 处置 | 条数 |
|---|---|
| 保留 | 26 |
| 修改 | 7 |
| 废弃 | 8 |
| 新增 | 1 |

与首版（保留 11 / 修改 9 / 废弃 7 / 缺失 16）的差异来源：

- **16 条「缺失」全部归位**：结果判定 6 条落 `classify`（均为**保留**）、身份继承 3 条中 2 条为
  **保留**、1 条为**新增**（`agent_send` 的身份解析）、权限去重与标题 2 条为**保留**、
  元数据与附件展开 2 条为**保留**、watcher 归属 2 条**废弃**（问题随 M6 消解）、
  取消幂等 1 条为**保留**（是 callee 事实）。
- **2.2 由「保留」改「修改」**：`deriveSubagentSessionPermission` 是独立于 `childToolDenies` 的
  第二个拒绝点，两轮设计都漏了。不改则深度 3 完全失效。
- **6.1 / 6.3 / 6.4 由「修改」改回「保留」**：这三条上一版之所以要改，都是因为
  `agent_send` 也要产生结局。该前提取消后，既有写法本就正确。

## 10. 不在本表内的改动

以下改动不涉及 `task.ts` 的既有行为，因此不在本表，逐条见细化 §2.3：

- `core/src/v1/config/config.ts` 的 `subagent_depth` 说明文字
- config 权限 schema 的 `task` → `agent` 一次性规范化
- `worktree/index.ts` 新增 Agent 专用内部入口（**不给公开 `CreateInput` 加 `root`**）
- `tui/src/routes/session/index.tsx` 的权限/question 聚合改为整棵后代
  （**深度改动的必要连带项**，不是可选项）
