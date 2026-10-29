# Decisions — plugin-1-updated-input

记录 §6.5 路径 B（audit-report.md）⚠️/❌ 项的处置。

## U1：MCP/code-mode 路径的 core 侧校验缺口 → **修订契约（选项 b）**

- 处置：契约 §2.1「必须通过 schema 校验」的适用范围收窄为 **registry 工具（内建 + 插件自定义）**——校验在 core 的 wrap decode 层（`tool.ts`），插件不可绕过。MCP 动态工具与 code-mode 子调用**无 core 侧 schema**（AI SDK 的 inputSchema 校验只作用于模型 output 解析，audit 已核实实际解析路径），替换后的参数直达 server，由 server 侧校验兜底——与"无 updatedInput 时 args 同样直达 server"的既有基线一致，未引入新的信任面。
- 同步：JSDoc 与 customize-opencode.md 已改写为分流表述；`{ value: ... }` 非 record 包装、`null !== undefined` 判定均写入契约 §2.1。
- 恢复条件：若未来给 MCP 工具引入 core 侧 Effect Schema parameters，updatedInput 校验随即可覆盖。

## U2：shell visibleInput 测试空洞 → **已修复**

- 补齐：用例改为把 `requests` 接入 `wrappedCtx.ask`（ask 即抛 `stop after permission`，进程不 spawn），断言 `patterns` 含 `echo visible` 且不含 `echo wrapped -- real`；spawn 用替换后命令拆分为独立用例（权限放行路径）断言 output/title。

## U3：I3 无测试 → **已补**

- 新增 `test/session/tools.test.ts` 用例：真实 `Tool.define` 包裹的工具（与全部 registry 工具同一条 wrap decode 路径），hook 注入未过 schema 的 updatedInput，断言抛 `InvalidArgumentsError`（含友好文案）且工具体调用计数为 0。

## U4：流程产物 → **已落地**

- `decisions.md`（本文件）；devlog `docs/devlog/2026-10-29-plugin-updated-input.md`（含度量段）；CLAUDE.md 已知限制段补 V2 移植义务一行。

## W1：权限按原命令仅 shell 落实 → **接受并定界**

- shell 是唯一从命令文本派生 pattern 的工具（树解析），"原命令"决策落实在此；edit/write/read/grep/glob/webfetch 的 pattern 直接取执行入参——updatedInput 存在时按替换后评估，方向更保守（匹配实际执行面）。已写入契约 §2.1 决策表。

## W2：`state.title` 携带替换后命令 → **声明为有意行为**

- 模型投影（message-v2）只用 `state.input`，不含 title——"执行 ≠ 所见"对模型成立；title 随 part 持久化，TUI/导出向用户显示 wrap 后命令是可审计行为（用户应当看到真实执行了什么）。已写入契约 §2.1 决策表。

## W3：`updatedInput: null` 视为已设置 → **接受**

- 判定用 `!== undefined`（与 expectations §8 字面 `??` 有微差）；null → 包装为 `{ value: null }` 直达执行。边角语义，契约 §2.1 已明写。

## W4：hook input 类型 `callID?: string` 与 plugin 包声明 `callID: string` 不齐 → **接受**

- `Tool.Context.callID` 本就可选（`tool.ts`），显式类型参数照实反映；行为无差，不为类型面整洁引入强转。
