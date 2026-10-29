# Contract Audit Expectations — plugin-1-updated-input

> 事前从契约文档（`docs/design/plugin/subplans/plugin-1-updated-input.md` + issue #91）独立抽出。
> 「实现位置」列在 Step 1 实施时回填；本文件创建时不读实现代码。

## 1. 契约源（multi-doc）

| 源 | 相关 § |
|---|---|
| `docs/design/plugin/subplans/plugin-1-updated-input.md` | §2 契约变更 / §3 数据流 / §4 测试契约 / §5 文档同步 |
| issue #91（lihaokun/opencode） | 背景约束（执行 ≠ 所见三面）、方案 A、权限语义倾向 |
| Claude Code PreToolUse `updatedInput`（对照目标） | 整体替换、schema 校验失败报错、权限按改写后 input（本项目**偏离**此点：按原命令） |

## 2. Schema 字段（机械化）

| 字段 | 类型 | 来源 | 实现位置 | 一致性 |
|---|---|---|---|---|
| `updatedInput` | `any`（可选） | 契约 §2.1 | 待填 | hook output 新增，无返回值插件不受影响 |
| `Tool.Context.visibleInput` | `Record<string, unknown>` | 契约 §2.2 | 待填 | 恒等于传给 hook 层的原始 args |

## 3. 枚举值（机械化）

无新增枚举。既有枚举不受影响。

## 4. 流程步骤（机械化）

P1 hook 触发（传原 args 引用）→ P2 读 `updatedInput` → P3 schema 校验替换后 args →
P4 构造 ctx（`visibleInput = 原 args`）→ P5 `item.execute(替换后 args, ctx)` →
P6 `metadata()` 闭包写回原 args → P7 shell 树解析/ask 读 `visibleInput` → P8 spawn 用替换后命令。

| 步骤 | 契约约束 | 实现位置 |
|---|---|---|
| P1 | hook 收到的 args 与可见层锚点同引用 | 待填 |
| P2 | `updatedInput ?? args` 整体替换（浅替换对象，非合并） | 待填 |
| P3 | 校验失败 → InvalidArgumentsError，工具体不执行 | 待填 |
| P4 | `visibleInput` 恒等原始 args | 待填 |
| P5 | 执行层用替换后 args | 待填 |
| P6 | metadata 写回的 `state.input` = 原 args | 待填 |
| P7 | 权限 patterns 从 `visibleInput.command` 派生 | 待填 |
| P8 | spawn 用替换后命令 | 待填 |

## 5. 行为契约（语义，人审）

- [ ] updatedInput 存在 → 执行用 args 整体替换；可见层与权限保持原 args
- [ ] updatedInput 未设置 → 行为与子计划前完全一致（向后兼容，无新分支副作用）
- [ ] 原地变异插件（mutate output.args，无 updatedInput）→ 权限与可见层行为与现状逐位一致（visibleInput === args 同引用）
- [ ] 多 hook 均设 updatedInput → 最后设置者胜出
- [ ] 权限 ask() 评估**原命令**（对 CC 的有意偏离，issue 作者倾向）
- [ ] 校验失败对模型表现为 InvalidArgumentsError 文案（与模型侧 schema 错误一致），非 defect

## 6. 时序/状态契约（人审）

- [ ] schema 校验发生在工具体执行**之前**（P3 → P5 顺序）
- [ ] ctx（含 visibleInput）构造先于 execute（P4 → P5）
- [ ] `tool.execute.after` 收到的 args 为**原始 args**（非替换后）——契约 §3 未明说，按 P1 同引用原则推断，见 decisions.md

## 7. 不变量契约（property-based / 回归）

- [ ] I1: 对任意 hook 返回（原地变异 m、updatedInput u），`可见层 input ≡ hook 层收到的原 args`（u 存在时）；u 不存在时可见层 ≡ m(args)（现状）
- [ ] I2: `执行入参 ≡ u`（存在时）/ `≡ args 经原地变异`（不存在时）——两模式互斥覆盖
- [ ] I3: u 校验失败 ⇒ 工具体调用计数为 0 且工具错误可被模型看到
- [ ] I4: 无 hook 时全部行为 ≡ 基线（可通过 git stash 基线对照的既有测试全绿保证）

## 8. 性能契约（机械化）

- [ ] 无 updatedInput 时零额外拷贝/校验（替换表达式短路，`undefined ?? args`）
- [ ] 不增加每工具调用的 hook 触发次数（仍一次 before / 一次 after）

## 9. 安全/副作用契约

- [ ] updatedInput 来自插件 = 宿主侧受信代码，但**仍强制 schema 校验**（防御编程 + 一致错误面），core 侧校验不可被插件绕过
- [ ] 不修改 processor / message-v2 / compaction 的可见层锚点逻辑（`state.input` 写入点零改动）
- [ ] V2/core（packages/core）本子计划零改动（无 plugin hook 层）

## 10. 跨实现一致性

- [ ] 与 Claude Code PreToolUse `updatedInput` 语义对齐项：整体替换（非合并）、schema 校验失败报错、无返回值行为不变
- [ ] 与 CC 的显式偏离项：权限按原命令评估（记录于 decisions.md）
- [ ] 同一契约在 code-mode 子调用与主路径行为一致（同一 hook，同一替换语义）

## Step 5 验证记录

- **路径 A（自动检查）**：机械化检查项由项目级测试承担——typecheck 全绿（`bun run typecheck`，30/30）；流程步骤 P1–P8 的实现位置由独立审（路径 B）逐条定位核对；性能契约（§8）由代码直通性论证 + 既有套件全绿背书。项目未自备 `scripts/contract_audit` 脚手架，标 N/A，不阻塞退出（§6.6 允许）。
- **路径 B（subagent 独立审）**：`audit-report.md`（2026-10-29）——critical 0 / unresolved 4（U1–U4）+ 观察项 4（W1–W4）。全部处置见 `decisions.md`：U1 修订契约（MCP/code-mode 无 core 侧校验，声明为 server 兜底 + 分流表述）、U2/U3 补测试（shell patterns 断言重写；新增 schema 失败用例）、U4 补产物（decisions.md / devlog / CLAUDE.md 待办）。unresolved 清零。
- **「实现位置」列**：expectations 创建时刻意留空（消除 echo bias）；独立审报告 §1 对照表已给出全部实现位置（独立定位），本文件不重复回填，以 audit-report.md 为准。
