# 架构 — 提示词统一（prompt-unification）

> 状态：架构阶段（§4.2），待确认后进入细化（§4.3）。
> 关联：issue #46；调研依据 `docs/research/runtime-alignment-research.md` §3.4 矩阵、§5.1 与 §7 决议 #7-9（ZCode 式委派、provider() 内共享段、最小刀法）。

## 1. 目标与非目标

**目标**

- **G1 行为基线一致**：10 份模型模板全部以同一段共享行为段收尾——完成判据、途中纠偏（steering）、验证与真实报告、交付摘要、注释密度指导（issue 验收"不能只修某个模型的 prompt"）。
- **G2 委派指导单一来源**：何时委派的指导移入 agent 工具描述（与工具共存亡、随注册自适应）；系统提示词只保留 fork 特有机件说明（异步 `agent_list/send/stop`、不轮询）。
- **G3 硬冲突消除（最小刀法）**：default/trinity 的三条硬性规则移除——强制 <4 行回答、修改后不解释、绝对禁注释；其余模板的软性表述保留，冲突矩阵记档迭代。
- **G4 契约不破坏**：显式 prompt agent 的替换语义（opt-out）保持；`AGENTS.md`/skills/MCP instructions/plugin transform 的装配顺序与内容不变。

**非目标（v1 明确不做，记录引入条件）**

- 全量 10 模板改写：anthropic 的强委派（"proactively/CRITICAL"）、gpt-astra 的禁委派等**方向性差异保留**（最小刀法，决议 E②）；引入条件——行为对照实验给出哪一种姿态更优的证据后统一。
- 消息内注入通道（steering/roster/plan reminder）的语义改造：已有 owner（agent-management），不在提示词射程内。
- default 与 trinity 合并为单副本：内容重复但合并涉及模板路由行为，最小刀法不包含；引入条件——下次模板新增时顺手合并。
- 行为对照实验（issue 验收的对照口径）：单变量实验需要评测基座，先以单元级断言 + 人工场景抽查落地，实验另立项。

## 2. 核心装配流（现状与变化）

```
现状：provider(model) → 10 选 1 → [模板]
变化：provider(model) → 10 选 1 → [模板, SHARED_BEHAVIOR]
                      （三元之后被 agent.prompt 替换的路径不变 = opt-out）

request.ts:195  三元：agent.prompt 亦或 [模板, SHARED]
request.ts:193-201  join 单串（缓存前缀：模板按模型路由，SHARED 恒定）
```

default.txt / trinity.txt 删除三条硬规则（L18-19、L58、L68 与 trinity 对应行）；L81 的"检索优先委派"句移除（由工具描述接管），异步机件说明行保留。

## 3. 文本资产（数据结构）

**共享行为段**：新文件 `session/prompt/shared-behavior.txt`（与全部模板同目录、同 `.txt` import 方式），经 `system.ts` 引入。**草稿**（最终文案在实施 PR 中过稿）：

```md
# Working agreement

- When a request asks for action, carry it to completion: do not stop at a plan,
  a capability statement, or a partial result. Finish the promised work and fill
  small gaps yourself; stop only when the work is done, you are truly blocked,
  or a decision is genuinely the user's to make.
- Treat messages that arrive mid-task as steering: fold corrections in and keep
  going; replace the task only when the user clearly cancels it or changes it.
- Verify what you deliver using the checks the project provides (tests, lint,
  typecheck). Report what you did, what you verified, and what failed or was
  left unverified — never present an unverified result as done.
- Answer simple questions briefly. For implementation work, end with a
  self-contained summary: outcome first, then key evidence, then blockers.
- Match the surrounding code's style and comment density; add comments only
  where they carry a non-obvious constraint.
```

（约 190 词；覆盖 issue 行为矩阵的 (d) 完成判据、(e) steering、验证与真实报告、交付，以及替代绝对禁注释的注释密度指导。）

**委派指导**（移入 `tool/agent.ts` 的工具描述常量）：

```md
## When to delegate

- The task matches one of the available agent types, you have independent work
  that can run in parallel, or answering would mean reading across several
  files — delegate it and keep the conclusion, not the file dumps.
- For a single-fact lookup where you already know the file, symbol, or value,
  search directly.
- Once you have delegated a search, do not repeat it yourself — wait for the
  result. Subagents are asynchronous: the tool returns once one has started,
  results arrive as messages, and agent_list shows who is still running.
```

## 4. 模块划分与功能规约（§3.2 格式）

### M1 `session/system.ts`

**函数/模块名称**：`provider`

功能描述：不变（按 model id 路由模板），唯一变化是每个分支的返回值由 `[模板]` 改为 `[模板, SHARED]`。
前置条件：`model` 为合法 Provider.Model。
后置条件：返回数组长度 ≥ 2；末元素恒为 `SHARED_BEHAVIOR`（常量，单一来源）；`[0]` 为该模型的既有模板（既有测试兼容）。
不变式：所有分支共享同一 `SHARED_BEHAVIOR` 引用。
副作用：无。

### M2 模板修剪

`default.txt` 与 `trinity.txt`：删除强制短回答段（"fewer than 4 lines" 两处 + "One word answers are best"）、修改后不解释两句（"Do not add additional code explanation summary..." / "After working on a file, just stop..."）、绝对禁注释行（"DO NOT ADD ***ANY*** COMMENTS unless asked"）、检索优先委派句；**保留**异步机件说明（agent_list/agent_send/agent_stop、不轮询——fork 特性说明，G2 的"机件"部分）。修剪后这些模板不再与共享段冲突。

### M3 `tool/agent.ts` 描述

工具描述常量追加 "When to delegate" 节（§3 文本资产），与既有描述合并；不改变工具行为。

### M4 验证

单元：`system.test.ts` 增断言——`provider()` 任意分支末元素 === SHARED、`[0]` 不含被删除的硬规则字串；grep 级断言（default/trinity 不含 "fewer than 4 lines"/"DO NOT ADD ***ANY***"）。行为场景（行动请求/纯问答/压缩后续做）按 issue §五口径做人工抽查，不在本 feature 的单元射程。

## 5. 接口规约（§3.3 格式）

**接口：prompt.ts → system.ts**（既有）不变：`SystemPrompt.provider(model)` 签名、返回类型、调用位置不变——仅返回内容多一段。`agent.prompt` 显式替换路径的互斥语义不变（G4/I2）。

**接口：工具描述 → 模型**（既有通道）：agent 工具描述文本变更不改变工具 schema/行为，仅指导文本。

## 6. 关键设计决策

1. **共享段放 `provider()` 内 `[模板, SHARED]`**（决议 E①'，推翻初稿"三元后"）：三元替换语义即工具型/自定义 agent 的正确 opt-out；把改动限制在 `system.ts`（fork 稳定区），不触上游热点 `request.ts`。
2. **委派指导进工具描述**（决议 E①，ZCode 式）：10 模板委派段不一致问题消失；指导与 fork 异步工具语义（agent_list/send/stop）共置于一处。
3. **共享段置于模板之后**：后置覆盖压平模板残留软冲突；位于缓存前缀稳定区（模板按模型路由、SHARED 恒定）。
4. **最小刀法**（决议 E②）：只动 default/trinity 三条硬规则 + 委派句；其余模板矩阵记档迭代。
5. **共享段是 `.txt` 文件**：与模板同构，纯文本资产，无代码逻辑。

## 7. 架构正确性论证（§4.2.1）

**goal → 模块映射**：G1 → M1；G2 → M3 + M2（机件行保留）；G3 → M2；G4 → M1（不动三元）+ M2（不动机件行）。

**模块协作论证**

- G1 要求全部模型模板带行为基线。M1 后置条件"末元素恒为 SHARED"对所有 10 个分支成立（单一常量来源），且三元之前所有模型 agent 必经 provider ⇒ 模型模板路径全覆盖；子代理 general/build/plan 无显式 prompt ⇒ 同路径覆盖 ⇒ G1。
- G2 要求委派指导单一来源。M2 移除 default/trinity 的检索委派句后，"何时委派"唯一出现于 M3 的工具描述（anthropic/meta 的软性残留是 E② 显式保留项，见非目标）⇒ G2 在既定刀法内成立。
- G3：M2 的删除清单逐条对应三条硬规则 ⇒ grep 可验证 ⇒ G3。
- G4：M1 不改三元、不改 join 顺序 ⇒ opt-out（I2）与插件追加（I3）保持；M2 保留机件行 ⇒ fork 异步特性说明不丢 ⇒ G4。

**关键假设**

- **H1（已核实）**：无测试固化模板全文；`system.test.ts` 以 `provider(...)[0]` + `toContain` 断言，共享段放 `[1]` 不影响既有断言。
- **H2**：后置文本在指令跟随上有覆盖优势但非硬保证——因此 default/trinity 的硬规则是**删除**而非仅靠覆盖压制；其余模板的软冲突留待迭代。
- **H3**：模板为静态 `.txt` import，无逐模型条件装配（`system.ts:28-51` 事实）。
- **H4**：共享段文案本身的行为效果属评测问题，本架构只保证"送达与一致性"，效果由 M4 的人工场景抽查与后续实验检验。

**模块级不变量**

- I1：`provider()` 任意分支返回数组的末元素恒为 `SHARED_BEHAVIOR` — 维护方：M1 单点收口（所有分支经同一返回表达式）。
- I2：显式 `agent.prompt` 路径不含 SHARED — 维护方：`request.ts:195` 三元位置不变（本 feature 不触碰该文件）。
- I3：插件 `experimental.chat.system.transform` 仍追加于整段之后 — 由装配顺序不变保证。

**preservation 论证**：I1 的破坏途径是新增模板分支漏加 SHARED——M1 收口为单一返回表达式后分支只能提供模板变量，结构上无法绕过；I2/I3 的破坏途径是改动 `request.ts` 装配——本 feature 明确不触碰该文件。

## 8. 细化阶段待核实清单

- default.txt / trinity.txt 待删行的精确行号与 trinity 对应行核对（避免误删机件行）
- agent.ts 工具描述常量的现位置与追加格式
- `system.test.ts` 是否需要为新断言补 fixture（预计直接加 test 即可）
- 共享段文案终稿过审（本架构给出草稿）
