# Contract Audit Report — plugin-1-updated-input（路径 B 独立审）

- 审核者：独立 subagent（未参与实现，未读取主 agent 预填的「实现位置」列——expectations.md 该列为空，全部实现位置由本次独立从代码定位）
- 日期：2026-10-29
- 分支：feat/plugin-updated-input（基于 d9d7de31fb，工作树未提交 diff）
- 契约源：`docs/design/plugin/subplans/plugin-1-updated-input.md`、`docs/audits/plugin-1-updated-input/expectations.md`
- 审核方法：通读契约 → 独立读 `git diff`（25 文件）与相关源码上下文（processor / message-v2 / compaction / permission / registry / AI SDK 6.0.168 实际解析路径）→ 逐条定位 → 运行受影响测试与 typecheck

---

## 1. 检查点对照表

### §4 流程步骤 P1–P8

| 检查项 | 契约依据 | 实现位置（文件:行） | 判定 | 说明 |
|---|---|---|---|---|
| P1 hook 收到的 args 与可见层锚点同引用 | expectations §4 | packages/opencode/src/session/tools.ts:109-118（`context(args, options)` 先构造、`{ args }` 传 hook）；锚点 processor.ts:461-490（`state.input` 写入，零改动） | ✅ | args 即 AI SDK parse 后的 tool-call input，与 processor 写入 `state.input` 的对象同引用；tools.test.ts:274 用 metadata 写回断言验证 |
| P2 `updatedInput ?? args` 整体替换（非合并） | expectations §4 | tools.ts:119-122；MCP 循环同构 tools.ts:423-426；code-mode.ts:151-154 | ✅（含 ⚠️ 边角） | 实现用 `let params = hook.args; if (hook.updatedInput !== undefined)`，非 record 时包装 `{ value: updatedInput }`（与 processor.ts:472 对模型非 record input 的既有惯例一致）。⚠️ ① 该包装行为契约未声明；② `updatedInput === null` 时实现视为「已设置」（`null !== undefined`），而字面 `??` 会短路取原 args——语义微差，应记入 decisions.md |
| P3 校验失败 → InvalidArgumentsError，工具体不执行 | expectations §4 / 契约 §2.1 类型不变量 | registry 工具：tool.ts:119-137（wrap 层 `decode` → `InvalidArgumentsError`，工具体在其后） | ⚠️/❌ | **对 registry 内建/插件自定义工具成立**（机制复用既有 wrap decode，core 侧强制、插件不可绕过）。**对 MCP 动态工具与 code-mode 子调用不成立**：tools.ts:429 直接 `execute(params, opts)`、code-mode.ts:160 直接 `callTool({ arguments: params })`，core 侧无任何 schema 校验（MCP 工具本无 Effect Schema parameters；AI SDK 的 inputSchema 校验只发生在模型 output 解析阶段，ai@6.0.168 index.mjs:3738-3743，不覆盖 hook 替换后的值）。契约 §2.3 明确把这两处列入传导范围，与 §2.1 不变量冲突 → 见 U1 |
| P4 `visibleInput` 恒等原始 args | expectations §4 | tool.ts:51（类型）；tools.ts:64（`visibleInput: args`，在 hook 之前构造） | ✅ | 同引用传递；原地变异模式下 `visibleInput === params`（同引用），updatedInput 模式下指向原 args |
| P5 执行层用替换后 args | expectations §4 | tools.ts:123（`item.execute(params, ctx)`）；tools.ts:429（MCP）；code-mode.ts:160（`arguments: params`） | ✅ | 三条路径一致 |
| P6 metadata 写回 `state.input` = 原 args | expectations §4 | tools.ts:68-81（`context()` 闭包 `input: args`，捕获 hook 前的原始引用）；tools.test.ts:274（recorder.inputs 全为 original） | ✅ | 闭包捕获的是 `context(args)` 的参数，与 hook 替换无关；锚点零改动 |
| P7 权限 patterns 从 `visibleInput.command` 派生 | expectations §4 / 契约 §2.2 | shell.ts:620-633（`visibleCommand = typeof ctx.visibleInput.command === "string" ? ... : params.command`；`parse(visibleCommand)`；`ask(ctx, scan, { command: visibleCommand })`）；ask 消费 shell.ts:263-295（patterns 来自树解析、metadata.command = visibleCommand） | ⚠️ | 实现正确（含非 string 的防御 fallback，fallback 下行为与改前逐位一致）。但 **shell.test.ts:1203 的用例名宣称覆盖 P7，实际未断言**：`requests` 数组声明后未接入 `wrappedCtx.ask`（仍是无操作的 `ctx.ask`），无论实现用哪个命令解析权限测试都会绿 → 见 U2 |
| P8 spawn 用替换后命令 | expectations §4 | shell.ts:638-641（`run({ command: params.command, ... })`）；shell.test.ts:1203（`result.output` 含 wrapped 内容） | ✅ | 执行与权限的命令来源已分离；有测试 |

### §5 行为契约

| 检查项 | 契约依据 | 实现位置（文件:行） | 判定 | 说明 |
|---|---|---|---|---|
| updatedInput 存在 → 执行替换，可见层/权限保持原 args | expectations §5 | tools.ts:119-123 + tools.ts:64/80 + shell.ts:624-633；测试 tools.test.ts:274 | ✅ | 核心诉求达成；可见层（`state.input`）与权限（shell）均锚定原 args |
| updatedInput 未设置 → 与子计划前逐位一致 | expectations §5 | tools.ts:119（未设置时 `params === hook.args === args` 同引用，直通 `execute`）；MCP tools.ts:423→429；code-mode.ts:151→160 | ✅ | 无新分支副作用：`!== undefined` 判断无副作用，`hook.args` 即原引用；既有测试全绿（见 §3 测试记录，2 个失败为环境性、stash 基线同样失败） |
| 原地变异插件 → 权限与可见层逐位一致（同引用） | expectations §5 | tools.ts:119（`params = hook.args`）；测试 tools.test.ts:381（`expect(seen.visible).toBe(seen.executed)`） | ✅ | 同引用保证 visibleInput/可见层/执行三面仍与改前完全重合 |
| 多 hook 均设 updatedInput → 最后设置者胜出 | expectations §5 | packages/opencode/src/plugin/index.ts:284-296（trigger 按注册顺序在同一 output 对象上调用）+ tools.ts:120；测试 tools.test.ts:328 | ✅ | 与原地变异的顺序语义一致 |
| 权限 ask() 评估**原命令**（对 CC 的有意偏离） | expectations §5 / 契约 §2.1 决策表 | shell.ts:620-633（唯一消费点） | ⚠️ | shell 已落实。但 **其余带 ask 的工具（edit.ts:102/145、write.ts:54、read.ts:255、grep.ts:39、glob.ts:28、webfetch.ts:39）仍从 `params`（可被替换）派生 pattern**——updatedInput 改这些工具的 args 时权限按替换后评估，与契约 §2.2「权限评估应使用的工具入参 = visibleInput」的通用语义字面不符。可辩护（updatedInput 按实际执行评估更保守；且契约 §4 测试只承诺 shell），但属于契约语义与实现范围不齐 → 见 W1 |
| 校验失败对模型表现为 InvalidArgumentsError 文案 | expectations §5 | tool.ts:24-34（message getter）+ wrap decode tool.ts:129-137 → processor failToolCall（processor.ts:313-331）→ message-v2 output-error/errorText 投影（message-v2.ts:341-357） | ⚠️ | 机制对 registry 工具成立（模型经 errorText 看到文案）；但无 updatedInput 专项测试（I3 未覆盖，见 U3），且 MCP/code-mode 路径根本没有该校验（U1） |

### §6 时序/状态契约

| 检查项 | 契约依据 | 实现位置（文件:行） | 判定 | 说明 |
|---|---|---|---|---|
| schema 校验先于工具体执行（P3→P5） | expectations §6 | tool.ts:128-138（decode 在 `execute(decoded, ctx)` 之前，同一 gen 内顺序执行） | ✅ | 对 registry 工具成立；MCP/code-mode 无校验（归入 U1） |
| ctx（含 visibleInput）构造先于 execute（P4→P5） | expectations §6 | tools.ts:109（ctx）→ 110-118（hook）→ 123（execute）；MCP tools.ts:413→429；code-mode.ts:149-160 | ✅ | 三处顺序一致 |
| `tool.execute.after` 收到**原始 args**（契约未明说，按 P1 同引用推断） | expectations §6 | tools.ts:133-137（`args` 原引用）；MCP tools.ts:440-444；code-mode.ts:189-193（`args: input.args`）；prompt.ts:498-505（合成委托 `taskArgs`）；测试 tools.test.ts:311 | ✅ | 实现采纳了「原始 args」推断并有测试锁定；该推断应正式记入 decisions.md（当前该文件缺失，见 U4） |

### §7 不变量契约（测试覆盖）

| 检查项 | 契约依据 | 实现位置（文件:行） | 判定 | 说明 |
|---|---|---|---|---|
| I1 可见层 ≡ hook 收到的原 args（u 存在）/ ≡ m(args)（u 不存在） | expectations §7 | tools.test.ts:274（u 存在：metadata 写回全为 original）、381（u 不存在：visible === executed 同引用） | ✅ | 两模式均有断言 |
| I2 执行入参 ≡ u / ≡ 原地变异后 args | expectations §7 | tools.test.ts:274（executed = wrapped）、381（executed = mutated） | ✅ | 两模式互斥覆盖 |
| I3 u 校验失败 ⇒ 工具体调用计数 0 且错误可被模型看到 | expectations §7 | 机制在 tool.ts:129-137，但**无 updatedInput 专项测试**（全仓仅 tool-define.test.ts:113-148 覆盖模型侧非法入参） | ❌ | 契约 §4 第 3 条「updatedInput 未过 schema → InvalidArgumentsError，工具体不执行」没有对应测试 → U3 |
| I4 无 hook 时全部行为 ≡ 基线 | expectations §7 | 受影响测试套件全绿（环境性失败基线复现，见 §3）；未设置分支零行为差异（tools.ts:119 直通） | ✅ | 通过既有测试 + 代码直通性论证 |

### §8 性能契约

| 检查项 | 契约依据 | 实现位置（文件:行） | 判定 | 说明 |
|---|---|---|---|---|
| 无 updatedInput 时零额外拷贝/校验 | expectations §8 | tools.ts:119-122、tools.ts:423-426、code-mode.ts:151-154（引用传递，无拷贝、无解码） | ✅ | 附加成本仅一次 `!== undefined` + （仅替换时）一次 `isRecord` |
| 不增加 hook 触发次数（仍 1 before / 1 after） | expectations §8 | tools.ts:110/133、tools.ts:414/440、code-mode.ts:142/189；MCP resource 工具的 before（tools.ts:271/351）未动 | ✅ | 触发次数与位置不变 |

### §9 安全/副作用契约

| 检查项 | 契约依据 | 实现位置（文件:行） | 判定 | 说明 |
|---|---|---|---|---|
| updatedInput 来自受信插件但仍强制 core 侧校验、不可绕过 | expectations §9 | registry 工具：tool.ts:119-137（core wrap 层，插件不可达）；**MCP tools.ts:423-429 与 code-mode.ts:151-160 无 core 侧校验** | ❌ | registry 路径满足「不可绕过」；MCP/code-mode 路径插件提供的 params 未经任何 core 校验直达 MCP server（AI SDK 的 schema 校验只作用于模型 output，见 P3 行）。插件受信 + server 侧自有校验兜底，故不升级 critical，但契约字面被违反 → U1 |
| processor / message-v2 / compaction 可见层锚点零改动 | expectations §9 | `git status`/`git diff`：processor.ts、message-v2.ts、compaction.ts 均不在 diff 中；`state.input` 写入点（processor.ts:370/474-487、tools.ts:80）逻辑未变 | ✅ | 零改动核实 |
| V2/core（packages/core）零改动（除 skill 文档） | expectations §9 | `git diff -- packages/core` 仅 packages/core/src/plugin/skill/customize-opencode.md（+10/-1，hook 文档） | ✅ | 与契约 §2.3「V2 无 plugin hook 层，天然不受影响」一致 |

### §10 跨实现一致性

| 检查项 | 契约依据 | 实现位置（文件:行） | 判定 | 说明 |
|---|---|---|---|---|
| 与 CC 对齐项：整体替换、校验失败报错、无返回值行为不变 | expectations §10 | tools.ts:119-122（整体替换）；tool.ts:129-137（报错）；tools.ts:119（未设置直通） | ⚠️ | 前两条对 registry 工具成立；「校验失败报错」在 MCP/code-mode 路径缺失（U1） |
| 显式偏离项：权限按原命令（记入 decisions.md） | expectations §10 | shell.ts:620-633 | ⚠️ | 偏离已实现，但 **decisions.md 尚不存在**（expectations §6/§10 两处引用悬空）→ U4 |
| code-mode 子调用与主路径同一 hook、同一替换语义 | expectations §10 | code-mode.ts:142-154 与 tools.ts:119-122 逐行同构（同 `isRecord`/`{value}` 包装） | ✅ | 两处语义一致；code-mode 权限 patterns 恒为 `["*"]`（code-mode.ts:156），不依赖 args，与主 MCP 循环（tools.ts:428）相同 |

### 文档同步（契约 §5）

| 检查项 | 契约依据 | 实现位置（文件:行） | 判定 | 说明 |
|---|---|---|---|---|
| plugin JSDoc：updatedInput 语义、信任边界、不支持范围 | 契约 §5 | packages/plugin/src/index.ts:269-283（语义+schema+信任边界+不支持范围齐全） | ✅ | 完整覆盖三项要求 |
| customize-opencode.md hook 文档示例 | 契约 §5 | packages/core/src/plugin/skill/customize-opencode.md:378-380、392-398（两种改写模式 + 示例语义 + 不支持范围） | ✅ | 与 JSDoc 口径一致 |
| CLAUDE.md V2 移植义务（本轮不写则记 devlog 待办） | 契约 §5 | 未写入 CLAUDE.md；docs/devlog/ 无本子计划日志（最新为 2026-09-25） | ⚠️ | 两个 fallback 都未落地 → 并入 U4 |

### 明确不支持范围的核实（契约 §2.3 razor 裁剪）

| 检查项 | 契约依据 | 实现位置（文件:行） | 判定 | 说明 |
|---|---|---|---|---|
| 3 个 MCP resource 工具不支持 updatedInput | 契约 §2.3 | tools.ts:271/351（resource 工具的 before 仍传 `{ args }`，返回值被丢弃，无替换逻辑） | ✅ | 与裁剪一致 |
| prompt.ts 合成 agent 委托不支持 updatedInput | 契约 §2.3 | prompt.ts:382-385（触发 before 但丢弃返回值）；397（`execute(taskArgs, ...)` 原样） | ✅ | 与裁剪一致 |
| 新增 `Tool.Context` 必填字段的涟漪适配 | 契约 §2.2 | prompt.ts:411（合成委托 `visibleInput: taskArgs`）、prompt.ts:955（execRead `visibleInput: args`）、agent.handler.ts:181（debug 工具 `visibleInput: {}`，shell 的 string fallback 保证行为不变）、14 个测试文件的 ctx 补 `visibleInput: {}` | ✅ | 全部构造点已覆盖（grep 全仓无遗漏）；debug 路径经 shell.ts:625 fallback 逐位等价 |

---

## 2. 五项特别核对结论

1. **可见层锚点（processor/message-v2/compaction）零改动**：✅ 三文件均不在 diff 中；`state.input` 的写入与消费（投影 message-v2.ts:295-360、摘要 compaction.ts:71）逐字未变。
2. **V2/core 零改动（除 skill 文档）**：✅ `git diff -- packages/core` 仅 customize-opencode.md。
3. **权限按原命令评估（shell 读 ctx.visibleInput）**：✅ 实现正确（shell.ts:620-633），含非 string 防御 fallback；❌ 但其测试未断言 patterns（U2），且其余工具权限仍按替换后 params 评估（W1）。
4. **hook 未设 updatedInput 时逐位一致**：✅ `params = hook.args` 为同引用直通，`!== undefined` 判断无副作用；MCP/code-mode 同构；既有测试全绿（环境性失败与基线一致）。
5. **`tool.execute.after` 收到的 args**：✅ 原始 args（三条路径 + 合成委托一致，测试 tools.test.ts:311 锁定）。expectations §6 标注的此项推断与实现相符，需回填 decisions.md。

---

## 3. 测试运行记录（本审核独立执行）

| 套件 | 结果 | 备注 |
|---|---|---|
| test/session/tools.test.ts | 5 pass / 0 fail | 含 4 个新增 updatedInput 用例 |
| test/tool/shell.test.ts | 25 pass / 0 fail | 含 2 个新增 visibleInput 用例（其一空洞，见 U2） |
| test/tool/tool-define.test.ts | 5 pass / 0 fail | 既有 InvalidArgumentsError 机制覆盖 |
| 其余 touched 工具测试（edit/write/grep/registry/external-directory/glob/read 等 7 文件） | 109 pass / 2 fail | 两个失败（write umask 权限断言、一次 5s 目录创建超时）在 `git stash` 干净基线上同样复现 → 环境性（CLAUDE.md 已知共享机 umask 问题），非本 diff 回归 |
| code-mode(+integration)/question/skill/lsp/webfetch/apply_patch + session/tools | 97 pass / 1 fail | skill not found 5s 超时在基线同样复现 → 环境性 |
| `bun run typecheck`（tsgo --noEmit） | 通过 | — |

---

## 4. 发现清单

### ❌ Unresolved（需主 agent 修复或决策）

- **U1（契约 §2.1 类型不变量 vs 实现）**：MCP 动态工具循环（tools.ts:423-429）与 code-mode 子调用（code-mode.ts:151-160）对替换后的 params **无任何 core 侧 schema 校验**，非 record 的 `updatedInput` 被静默包装为 `{ value: ... }` 直达 MCP server。契约 §2.1 声明「必须通过 schema 校验；失败 → InvalidArgumentsError」且 §2.3 将这两处列入传导范围。处置选项：(a) 为 MCP 路径补 JSON Schema 校验并映射为 InvalidArgumentsError；(b) 修订契约，把「core 校验」限定为 registry 工具、MCP 路径声明为「server 侧校验兜底」并记录 `{value}` 包装。`{ value }` 包装行为无论选哪个都应写入契约/JSDoc。
- **U2（测试空洞）**：shell.test.ts:1203 用例名「permission patterns derive from visibleInput.command」但未把 `requests` 接入 `wrappedCtx.ask`，对 P7 行为不敏感（实现无论用哪个命令解析权限都绿）。应仿照同文件 `capture(requests)`（shell.test.ts:165-172、1226-1237 的 legacy 用例）断言 `requests[0].patterns` 派生自 `echo visible`。
- **U3（I3 无测试）**：「updatedInput 未过 schema → InvalidArgumentsError，工具体不执行」（契约 §4 第 3 条、expectations I3）无专项测试。registry 工具路径可用既有 tool-define 测试模式低成本补齐。
- **U4（流程产物缺失）**：`docs/audits/plugin-1-updated-input/decisions.md` 不存在（expectations §6/§10 引用悬空）；契约 §5 的「CLAUDE.md V2 移植义务（或 devlog 待办）」两处 fallback 均未落地；本子计划亦无 devlog（含度量段，属项目 CLAUDE.md 通用要求）。

### ⚠️ 观察项（可解释，建议记录）

- **W1**：契约 §2.2 的通用语义（权限评估用 visibleInput）只有 shell 落实；edit/write/read/grep/glob/webfetch 的权限 pattern 仍来自（可被替换的）params。方向上更保守（按实际执行评估），建议在契约或 decisions.md 显式声明「权限按原命令评估仅适用于 shell 树解析；其余工具 pattern 直接取执行入参」。
- **W2**：updatedInput 存在时，shell 返回的 `title` 携带替换后命令（shell.ts:586 `title: input.command` ← params.command），随 `completeToolCall` 持久化到 part（processor.ts:305）。模型投影不含 title（message-v2.ts:295-360 只用 `state.input`），故「执行 ≠ 所见」对模型成立；但 TUI/ACP/导出（cli/cmd/export.ts 等 state.title 消费者）会向**用户**显示 wrap 后命令。对模型隐藏、对用户可见大概率是期望行为（可审计），但契约未提，建议显式声明。
- **W3**：`updatedInput: null` 被实现视为「已设置」（`!== undefined`），与 expectations §8 字面 `??` 短路语义不同（`null ?? args` 会取原 args）。边角，建议契约明确 null 的处置。
- **W4**：tools.ts registry 循环 hook input 的显式类型参数 `{ tool: string; sessionID: SessionID; callID?: string }` 与 plugin 包声明（`callID: string` 必有）在类型面上轻微不齐；行为无差，风格级。

### ✅ 通过要点（摘要）

核心诉求「执行 ≠ 所见」在三条传导路径（registry / MCP 动态 / code-mode 子调用）成立；可见层锚点与 V2/core 零改动；向后兼容（未设置分支同引用直通）；多 hook 最后写者胜出；`tool.execute.after` 收原始 args；MCP resource 工具与合成委托按契约裁剪；文档同步（JSDoc + skill 文档）完成；受影响测试与 typecheck 全绿（环境性失败除外）。

---

## 5. 计数与结论

- **critical：0**（未发现正确性错误或安全漏洞；核心契约在主路径成立）
- **unresolved：4**（U1 校验缺口 / U2 测试空洞 / U3 I3 无测试 / U4 流程产物缺失）
- ⚠️ 观察项：4（W1–W4）

**结论**：实现的机制选型（`visibleInput` 同引用锚点 + 三处同构替换 + shell 点消费）与契约数据流一致，向后兼容性论证充分（同引用直通 + 基线测试复跑），可见层锚点与 core 零改动核实无误。主要缺口集中在**契约承诺的 core 侧校验未覆盖 MCP/code-mode 路径（U1）**与**两处关键行为（P7 权限派生、I3 校验失败）缺少有效测试（U2/U3）**，加上流程产物（decisions.md / devlog / CLAUDE.md 待办）未落地（U4）。建议先处置 U1（补校验或修订契约并同步 JSDoc/skill 文档），再补 U2/U3 测试与 U4 产物；W1/W2 应在 decisions.md 中显式定界。本审核不阻塞 U1 之外的实现合入判断，但按 §6.6 退出准则，unresolved 清零前子计划不得退出。

（expectations.md 的「实现位置」列与 Step 5 验证记录段由主 agent 依据本报告回填。）
