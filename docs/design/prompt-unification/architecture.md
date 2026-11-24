# 架构 — 提示词统一（prompt-unification）

> 状态：已实施并随二轮独立复审收敛同步至 HEAD（§4.2–§4.4）。
> 关联：issue #46；调研依据 `docs/research/runtime-alignment-research.md` §3.4 矩阵、§5.1 与 §7 决议 #7-9（ZCode 式委派、provider() 内共享段、最小刀法）。

## 1. 目标与非目标

**目标**

- **G1 行为基线一致**：9 份活跃模型模板（`anthropic` / `beast` / `default` / `gemini` / `gpt` / `gpt-astra` / `kimi` / `meta` / `trinity`）全部以同一段共享行为段收尾——完成判据、途中纠偏（steering）、验证与真实报告、交付摘要、注释密度指导（issue 验收"不能只修某个模型的 prompt"）。
- **G2 委派机件清晰（D13 修订）**：移除 `default`/`trinity` 的检索优先委派硬指令，保留系统提示与 `tool/agent.ts` 中关于 fork 异步机件（`agent_list/send/stop`、不轮询）的客观说明；依据 PR #59 与 D13 决议，不在 `tool/agent.ts` 塞入“何时委派”的用法处方。
- **G3 硬冲突消除（最小刀法 E② + D12）**：移除 `default`/`trinity` 的三条硬性规则——强制 <4 行回答、修改后不解释、绝对禁注释（同时清理残留空 `# Code style` 标题）；**已知残留冲突显式声明**：`gemini.txt:12,43` 存在“修改代码后除非被要求不要总结 / 避免 postamble”的明文规则，按 E② 最小刀法与 D12 决议本 PR 暂不改写 `gemini.txt`，记录为已知残留冲突留待 beta 观察后统一收敛；其余模板的软性表述保留。
- **G4 契约不破坏**：显式 prompt agent 的替换语义（opt-out）保持；`AGENTS.md`/skills/MCP instructions/plugin transform 的装配顺序与内容不变。

**非目标（v1 明确不做，记录理由与引入条件）**

- **全量 9 模板改写**：anthropic 的强委派（"proactively/CRITICAL"）、gpt-astra 的禁委派，以及 `gemini.txt:12,43` 的不总结规则均在本 PR 保留不改。理由：(a) E② 最小刀法将本 PR 文本修剪严格限定在 `default`/`trinity`，为 beta 观察与单变量对照保留最小可归因 diff；(b) `shared-behavior.txt` 后置追加可在指令优先级上压平部分残余冲突；(c) 引入条件：beta 观察或行为对照实验确认 `gemini.txt` 等模板冲突影响交付后，再发起专项模板收敛 PR。
- **消息内注入通道（steering/plan reminder）的语义改造**：这些是 `reminders.ts` 在 turn-boundary 注入的**运行时状态投影**（plan mode 状态机等），不是静态行为规则——对象类不同，且已有 owner（agent-management）。本 feature 对它们的唯一义务：共享段文案不与消息内通道争内容。
- **default 与 trinity 合并为单副本**：合并不是删文本而是改 `system.ts:42` 的模板路由（trinity 分支指向 default）——超出"只删行 + 插共享段"的刀法边界；且调研未核实 trinity 模板的来历（OEM/内部分支定制？），草率合并可能破坏不可见下游。共享段插给两份后，重复维护的成本大头已消化。引入条件：下次新增模板时顺手合并路由。
- **行为对照实验**：单变量对照需要评测基座（任务集、评分口径、多次运行的方差控制），fork 均不具备（issue 核验基线自述未跑过对照实验）。判定结构上不阻塞：E② 移除的三条硬规则是不依赖实验即可判定有害的明文项（<4 行强制与自包含摘要不相容），"送达与一致性"由单元断言保证——"效果好不好"另立项。最小刀法本身即为实验保留最小可归因 diff。

## 2. 核心装配流（现状与变化）

```
现状：provider(model) → 9 选 1 → 裸模板
变化：systemSections(model) → [provider(model), PROMPT_SHARED]
      （request.ts:198 三元：agent.prompt ? [agent.prompt] : SystemPrompt.systemSections(model)）
      （随后与 env/instructions/mcp/skills join 成单一缓存稳定前缀）
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

**委派指导**（~~移入 `tool/agent.ts` 的工具描述常量~~ **2026-10-18 复审核意见 D13 撤销**）：PR #59 已确立 agent 工具描述只陈述生命周期机件、不开用法处方；"When to delegate" 一节是用法处方，与该原则冲突，且共享段/P1 修剪后委派机件说明已保留在模板内，模型侧信息未缺失。撤销后委派时机不再有独立文本资产（记录：若未来要恢复，载体应是共享段而非工具描述）。

~~原案（已撤销）：##

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

**函数/模块名称**：`provider`（2026-10-18 复审 B7 修订：早返回返回裸模板；`systemSections` = `[provider(model), SHARED]`，由唯一 caller `preparePayload` 使用——数组后置不变式移到 `systemSections`）

功能描述：不变（按 model id 路由模板）；`systemSections` 保证每个模型模板路线的 section 数组末元素恒为 `SHARED_BEHAVIOR`。
前置条件：`model` 为合法 Provider.Model。
后置条件：`systemSections` 返回数组长度 ≥ 2；末元素恒为 `SHARED_BEHAVIOR`（常量，单一来源）；`[0]` 为该模型的既有模板（既有测试兼容）。
不变式：所有分支共享同一 `SHARED_BEHAVIOR` 引用。
副作用：无。

### M2 模板修剪

`default.txt` 与 `trinity.txt`：删除强制短回答段（"fewer than 4 lines" 两处 + "One word answers are best"）、修改后不解释两句（"Do not add additional code explanation summary..." / "After working on a file, just stop..."）、绝对禁注释行（"DO NOT ADD ***ANY*** COMMENTS unless asked"）、检索优先委派句；**保留**异步机件说明（agent_list/agent_send/agent_stop、不轮询——fork 特性说明，G2 的"机件"部分）。修剪后这些模板不再与共享段冲突。

### M3 `tool/agent.ts` 描述

~~工具描述常量追加 "When to delegate" 节~~（2026-10-18 复审 D13 撤销——见 §3 委派指导段；描述保持 #59 的纯机件口径）。

### M4 验证

单元：`system.test.ts` 增断言——`systemSections()` 任意分支末元素 === SHARED、`[0]` 不含 `# Working agreement`；grep 级断言（`default`/`trinity` 不含 `fewer than 4 lines` / `DO NOT ADD ***ANY***` / `# Code style`）。行为场景按 issue §五口径做人工抽查，不在本 feature 的单元射程。

## 5. 接口规约（§3.3 格式）

**接口：prompt.ts → system.ts**（既有）**2026-10-18 复审 B7 修订**：`SystemPrompt.provider(model)` 返回类型由 `string[]` 改为裸 `string`；新增 `SystemPrompt.systemSections(model)` 返回 `[template, PROMPT_SHARED]`；调用位置移至 `request.ts:198` 的三元右支。`agent.prompt` 显式替换路径的互斥语义不变（G4/I2）。

**接口：工具描述 → 模型**（既有通道）：agent 工具描述文本变更不改变工具 schema/行为，仅指导文本。

## 6. 关键设计决策

1. **共享段经 `systemSections` 装配 `[模板, SHARED]`**（决议 E①'，推翻初稿"三元后"；**2026-10-18 复审 B7 再修订**：装配函数为 `systemSections`，`provider` 恢复裸模板早返回）：三元替换语义即工具型/自定义 agent 的正确 opt-out；改动集中在 `system.ts`（fork 稳定区）+ `request.ts` 三元右支一行。
2. **~~委派指导进工具描述~~**（决议 E①，ZCode 式；**2026-10-18 复审 D13 撤销**——与 #59"agent 描述只讲机件不开处方"冲突，见 §3 委派指导段）：~~10 模板委派段不一致问题消失；指导与 fork 异步工具语义共置于一处~~。委派段不一致随共享段+修剪已消除；委派时机不再有独立文本资产。
3. **共享段置于模板之后**：后置覆盖压平模板残留软冲突；位于缓存前缀稳定区（模板按模型路由、SHARED 恒定）。
4. **最小刀法**（决议 E②）：只动 default/trinity 三条硬规则 + 委派句；其余模板矩阵记档迭代。
5. **共享段是 `.txt` 文件**：与模板同构，纯文本资产，无代码逻辑。

## 7. 架构正确性论证（§4.2.1）

**goal → 模块映射**：G1 → M1；G2 → M2（移除检索委派硬指令、保留异步机件行，M3 已由 D13 撤销）；G3 → M2；G4 → M1（仅换三元右支调用 `systemSections`）+ M2（不动机件行）。

**模块协作论证**

- G1 要求全部活跃模型模板带行为基线。M1 `systemSections(model)` 恒返回 `[provider(model), PROMPT_SHARED]`，覆盖 `provider` 全部 9 份活跃模板路由（单一常量来源），且 `request.ts:198` 三元右支是模型模板路径的唯一生产调用点；无显式 prompt 的 agent（`build`/`plan`/`general`）全部经此路由 ⇒ G1 成立。
- G2（D13 修订口径）：M2 移除 `default`/`trinity` 的检索优先委派硬指令并保留异步机件行，`tool/agent.ts` 维持 PR #59 的纯机件描述（不混入用法处方），消除描述冲突 ⇒ G2 在 D13 决议范围内成立。
- G3：M2 的删除清单逐条对应 `default`/`trinity` 的三条硬规则与孤立空标题，由负向断言背书；`gemini.txt:12,43` 作为已知残留冲突在 E②/D12 边界内显式记档，留待后续迭代 ⇒ G3 在最小刀法边界内成立。
- G4：M1 仅将 `request.ts:198` 三元右支由 `provider` 改为 `systemSections`，不改三元位置与 join 顺序 ⇒ opt-out（I2）与插件追加（I3）保持；M2 保留机件行 ⇒ fork 异步特性说明不丢 ⇒ G4。

**关键假设**

- **H1（已核实；2026-10-18 B7 后更新）**：无测试固化模板全文；`system.test.ts` 原以 `provider(...)[0]` + `toContain` 断言，B7 后已改为裸模板断言（:98/107/116）与 `systemSections` 断言（:139），共享段断言在 `systemSections` 末元素上。
- **H2**：后置文本在指令跟随上有覆盖优势但非硬保证——因此 default/trinity 的硬规则是**删除**而非仅靠覆盖压制；其余模板的软冲突留待迭代。
- **H3**：模板为静态 `.txt` import，无逐模型条件装配（`system.ts:28-49` 事实）。
- **H4**：共享段文案本身的行为效果属评测问题，本架构只保证"送达与一致性"，效果由 M4 的人工场景抽查与后续实验检验。

**模块级不变量**

- I1（**2026-10-18 复审 B7 修订**）：`systemSections(model)` 返回数组的末元素恒为 `SHARED_BEHAVIOR` — 维护方：`systemSections` 单表达式（`[provider(model), PROMPT_SHARED]`）。**保护点是 `systemSections` 而非 `provider`**：B7 后 `provider` 返回裸模板，直接调用它拿不到 SHARED；"唯一装配点"约定由生产侧 grep 断言维护（当前唯一 caller = `request.ts:198`）。
- I2：显式 `agent.prompt` 路径不含 SHARED — 维护方：`request.ts:198` 三元位置不变（B7 的装配改动仅限三元右支）。
- I3：插件 `experimental.chat.system.transform` 仍追加于整段之后 — 由装配顺序不变保证。

**preservation 论证**：I1 的破坏途径有二——(a) 新增模板分支漏路由：`provider` 逐分支早返回与 default 兜底保证任何 model id 都拿到一份模板；(b) 出现绕过 `systemSections` 的新 caller：当前以"生产侧唯一 caller"约定 + grep 检查维护，结构强制降级为约定强制（B7 的已声明代价，workflow §8.3 同步记录）。I2/I3 的破坏途径是改动 `request.ts` 装配——B7 改动后仍只触及三元右支。

## 8. 细化阶段待核实清单

- default.txt / trinity.txt 待删行的精确行号与 trinity 对应行核对（避免误删机件行）
- agent.ts 工具描述常量的现位置与追加格式
- `system.test.ts` 是否需要为新断言补 fixture（预计直接加 test 即可）
- 共享段文案终稿过审（本架构给出草稿）
