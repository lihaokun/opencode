# 子计划 plugin-1-updated-input：tool.execute.before 的 updatedInput 通道

> Issue #91：给插件一个官方、文档化的「执行 ≠ 所见」通道——插件改写执行用 args，
> 模型可见历史与权限评估保持原命令。对齐 Claude Code PreToolUse 的 `updatedInput` 语义。

## 1. 背景与动机

mcp-server-fsm 等宿主集成需要在执行层 wrap bash 命令（如 `srt --settings ... -c "<原命令>"`
沙盒执行）。约束：

- **执行层**必须跑改写后的命令；
- **模型可见历史**必须保持原命令——否则模型从自身历史学到 wrap 模式并主动模仿，
  产生嵌套沙盒（macOS `listen EACCES` / Linux seccomp `EPERM`，必然失败）；
- **权限规则**按原命令评估——规则作者（用户/配置）的意图针对模型产出的命令，
  wrap 是宿主层实现细节，改写后的 pattern 必然与既有规则失配。

现状：`tool.execute.before` 唯一通道是原地变异 `output.args`，该变异**必然**
同时泄漏到执行、模型可见层（`ctx.metadata()` 闭包 `input: args` 重同步）与权限
评估（shell 树解析从执行 args 派生 pattern）。三个面无法解耦。

## 2. 契约变更

### 2.1 Hook 类型（packages/plugin）

`tool.execute.before` 的 output 新增字段：

```
数据结构：ToolExecuteBeforeOutput

字段：
  - args: any — 工具入参（原有语义：插件可原地变异）
  - updatedInput?: any — 可选。存在时整体替换「执行用」args（逐字段浅替换整个对象，
    非深合并）；可见层与权限评估继续使用原 args

类型不变量：
  - updatedInput 存在时必须通过该工具的 parameters schema 校验；校验失败 → 工具以
    InvalidArgumentsError 报错（模型看到 schema 错误文案，工具体不执行）。
    **适用范围：registry 工具（内建 + 插件自定义）**——校验在 core 的 wrap decode
    层强制，插件不可绕过。**MCP 动态工具与 code-mode 子调用无 core 侧 schema**：
    替换后的参数直达 server，由 server 侧校验兜底（AI SDK 的 inputSchema 校验只在
    模型 output 解析阶段，不覆盖 hook 替换后的值——audit U1 已核实）
  - 非 record 的 updatedInput 包装为 `{ value: <updatedInput> }`（与 processor 对
    模型非 record input 的既有惯例一致）
  - `updatedInput: null` 视为「已设置」（判定用 `!== undefined`，非 `??` 短路）
  - 未设置 updatedInput 的 hook 调用行为与本子计划之前完全一致（向后兼容）
```

语义决策（已确认）：

| 决策点 | 选择 | 理由 |
|---|---|---|
| 权限 ask() 评估对象 | **原命令**（仅限 shell 树解析） | 权限规则作者意图针对模型产出；wrap 是宿主实现细节。**定界（audit W1）**：该决策落实在 shell 的树解析/pattern 派生（唯一从命令文本派生 pattern 的工具）；edit/write/read/grep/glob/webfetch 等工具的 pattern 直接取执行入参（updatedInput 存在时按替换后评估，方向更保守、匹配实际执行面） |
| 可见层 `state.input` | **原命令** | 本子计划的核心诉求（执行 ≠ 所见） |
| 既有原地变异插件的可见层泄漏 | **保持现状** | 严格向后兼容；原地变异时 `visibleInput === args`（同引用），行为逐位不变 |
| `updatedInput` 与原地变异叠加 | updatedInput 胜出 | 后注册的 hook 覆盖先注册的（多插件场景，最后写入者赢，与原地变异顺序语义一致） |
| 用户可见的 `state.title` | **携带替换后命令**（audit W2 定界） | 模型投影（message-v2）只用 `state.input`，不含 title——对模型不可见成立；title 随 part 持久化，TUI/导出向用户显示 wrap 后命令是有意的可审计行为 |

### 2.2 Tool.Context（packages/opencode）

`Tool.Context` 新增字段：

```
数据结构：Tool.Context.visibleInput

字段：
  - visibleInput: Record<string, unknown> — 模型可见层与权限评估应使用的工具入参

语义：
  - 恒等于传给 hook 层的原始 args（即 processor 的 tool-call input）
  - 原地变异模式下 visibleInput === params（同引用）→ 既有行为不变
  - updatedInput 模式下 params 已被替换，visibleInput 仍指向原 args
```

### 2.3 传导范围

`updatedInput` 在以下触发点生效（**工具执行主路径**）：

- `session/tools.ts` registry 工具循环（bash/edit/write/read/grep/... 与插件自定义工具）
- `session/tools.ts` MCP 动态工具循环
- `tool/code-mode.ts` 子工具调用

**明确不支持**（razor 裁剪，记录恢复条件）：

| 触发点 | 不支持 updatedInput 的理由 | 恢复条件 |
|---|---|---|
| 3 个 MCP resource 工具（list/listTemplates/read） | 无 wrap 消费者；且其权限 patterns 依赖逐 arg 解析，支持「整体替换」需要双份解析 | 出现真实 MCP resource wrap 插件 |
| `prompt.ts` 合成 agent 委托 | 非模型 tool-call（合成 task args），无「所见」对齐问题 | 出现子 agent 启动前置改写需求 |

V2（core runner）无 plugin hook 层，天然不受影响；**未来 V2 接入插件时须移植本契约**
（CLAUDE.md 已记录两套 runtime 并行的事实）。

## 3. 数据流（变更后）

```
tool-call 事件（原 input）
  └─ processor: state.input = 原 input            ← 可见层锚点（不变）
       └─ session/tools.ts execute(args):
            ├─ hook: tool.execute.before { args }  → 插件可原地变异 / 返回 updatedInput
            ├─ params = updatedInput ?? args       ← 执行层
            │    └─ schema 校验（失败 → InvalidArgumentsError，工具体不执行）
            ├─ ctx.visibleInput = args             ← 权限层（shell 树解析/ask 读它）
            └─ item.execute(params, ctx)
                 └─ ctx.metadata() 闭包 input: args ← 可见层重同步仍写原 args（不变）
```

## 4. 测试契约

- updatedInput 存在 → `item.execute` 收到替换后 args；可见层（metadata 写回的
  `state.input`）保持原 args
- updatedInput 未设置 → 行为与本子计划前逐位一致（回归）
- updatedInput 未过 schema → InvalidArgumentsError，工具体不执行
- 多 hook：最后设置 updatedInput 的 hook 胜出
- shell：权限 patterns 从 `visibleInput.command` 派生；spawn 执行替换后命令
- 原地变异插件（不返回 updatedInput）：权限与可见层行为不变（回归）

## 5. 文档同步

- `packages/plugin/src/index.ts` JSDoc：updatedInput 语义、信任边界（插件输入未过
  模型侧校验前不可信，schema 校验在 core 侧强制）、不支持范围
- `packages/core/src/plugin/skill/customize-opencode.md`：hook 文档示例
- CLAUDE.md 已知限制段：V2 移植义务（若本轮不写则记入 devlog 待办）
