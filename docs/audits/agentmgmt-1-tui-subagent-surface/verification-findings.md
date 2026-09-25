# 人工验证发现 — `agentmgmt-1-tui-subagent-surface`

> 用户以 v1.18.31-fmv3-beta.1 做 manual-verification 时提出的问题清单。
> 协议：每条经用户确认理解后记录，**最后一起修**；修复前此文件只增不改判定。
> 状态：`待修` → 修复 commit 回填。

## P1 Agents 列表收编全部导航；成员扩为全树并标记当前会话

**用户要求**（验证反馈，2026-09-23）：

1. 列表标题 `Subagents` → **`Agents`**
2. 列表成员扩为**当前树全部会话**：主会话 + 所有 subagent + **当前会话**，不再排除任何成员
   - 主会话行固定标签 **`Main`**（描述列给 agent 类型）
   - 当前会话双重标记：DialogSelect 既有 `current` 属性打开时预选当前行 + 行内描述列追加 `· current`
   - 自然推论（已确认）：树的任何视图打开列表内容相同，只有当前标记位置随视图变化
3. **删除全部既有导航入口**，导航唯一化到 `down` 链式回退 → Agents 列表（回根 = 选 Main 行）：
   - footer 右侧 Parent/Prev/Next 按钮区删除；footer 左侧信息（名称/序号/token/开销）**保留**
   - 键位删除：`session_parent`(up)、`session_child_cycle`(right)、`session_child_cycle_reverse`(left)、`session_child_first`(`<leader>down`)
   - 连带删除：对应隐藏命令（sessionCommandList 四项 + sessionBindingCommands）、`moveFirstChild`/`moveChild`/`childSessionHandler`
4. 主会话行 "Main" 标签方案：用户确认

**背景**：commit 2 的"排除 root、回根交给 up"是剃刀裁决；本条按真实使用反馈推翻——单一导航面优于分散键位。

**涉及面**：
- `packages/tui/src/routes/session/index.tsx`：`subagentListMembers`（不再排除 root/current；rootID 需要传给标记逻辑）、`openSubagentList`、删除 moveChild/moveFirstChild/childSessionHandler、sessionCommandList/sessionBindingCommands 清理
- `packages/tui/src/component/dialog-subagent-list.tsx`：标题/占位、Main 行、current 标记、`current` prop
- `packages/tui/src/component/subagent-footer.tsx`：删除右侧按钮区
- `packages/tui/src/config/keybind.ts`：删 4 个键位
- `packages/sdk`：无
- 文档连带：设计文档 §5.2.3（裁决修订）、expectations §5（"无 subagent 时 down 无反应"→"仅 Main 无变化"语义微调——根视图下列表含 Main+children，2.5 的"完全无反应"不再成立，改为"列表打开且 Main 标记"）、manual-verification §2 重写

**状态**：已修（见修复 commit）

### P1 修复回归（用户复验发现，同日修复）

最底层会话打开列表只有"当前 + 父会话"，且父会话被标 Main。根因：`openSubagentList`
沿用了 `parentID ?? id` 两层级惯用法——深度 ≥ 2 时它给出的是父节点而非树根，
`collectSubtree` 随之只收子树；组件的 `isRoot` 判定又把该节点贴上 Main。修复：新增
纯函数 `treeRoot()`（沿 parentID 走到无父祖先，cycle 安全、链断回落自身），
`openSubagentList` 改用之；回归测试覆盖根/中层/最底层三个座位、断链回落与未知会话。

## P2 工具行显示名仍为 "Task"，应改为 "Agent"

**用户要求**（验证反馈，2026-09-23）：thinking 结束后转录里的 subagent 工具行显示
`Task …`——task 工具已在 #35 被完全抛弃，用户不应再看到这个词。

**机制**：`routes/session/index.tsx` 的 `toolDisplay()` 将 `agent` 工具（连同历史遗留
`task` 工具名）映射为显示键 `"task"`，`ToolPart` 派发链与用户可见行标签都来自它。#35
之前的遗留显示问题，非本子计划引入。

**修复方向**：
1. 显示名改 **`Agent`**（新 `agent` part 与历史 `task` part 一致；旧调用即同一机制）
2. 内部派发键可保留（不影响用户可见）
3. 修复时全量 grep TUI 用户可见的 `Task` 字符串一并清理，含 `formatTranscript`
   （复制/导出路径）

**范围**：TUI 显示层；task 工具移除本身（#35）不动。

**状态**：已修——`formatSubagentTitle` 去掉 "Task"（agent 类型名打头，背景态保留
`(background)` 标注），快照与断言同步更新；`formatTranscript` 无 "Task" 字样，无需改。


## P3 Agents 列表行信息补全：工作简述 + 实时 token/时长

**用户要求**（验证反馈，2026-09-25）：每个 subagent 名称之后加工作内容的一句话描述；
行最右侧实时显示 token 消耗与已运行时间。

**实现**（用户确认后直接修）：
- 简述 = 子会话标题剥去 `(@type subagent)` 后缀（委派时模型给的一句话，零新数据），
  muted 内联在名称之后；Main 行不加
- 右侧 = `session.tokens` 聚合（紧凑格式 `12.3k tok`）+ 时长（busy/retry =
  `now − created` 随对话框内 1s tick 实时跳动；完成后定格 `updated − created`）；
  Main 行同样显示（对称）
- 渲染槽位：description 内联（名称后）、footer 右对齐（flexShrink 0 恒可见），
  超长简述被行宽裁剪、右侧数据永不被挤
- 纯函数 `subagentDescription` / `formatListTokens` / `formatListElapsed` 可无渲染测试
  （11 例；正则漏括号被"正常用例"当场抓出）

**状态**：已修（本轮）

### P5 修复回归（用户复验发现，同日修复）

1. 对齐仍未中：首次按猜的 `paddingLeft 5 / paddingRight 3` 落偏。根因：未先读输入框
   实际框体就猜列。修正：读 Prompt JSX——`width 100%` + **左 border 1 列** + 内
   padding 2/2（右无边框）——面板镜像同一框体（`border={["left"]}` + 内 padding 2/2），
   两缘与输入框完全重合。教训：**对齐题的列差必须从 JSX padding/border 链推得，禁止猜**。
2. `● ` 前缀插在带缩进的标题前，当前行比其他行凸出 2 列。修正：缩进从 `formatAgentRow`
   的 title 拆出为独立 `indent` 字段，圆点进固定宽度前置槽（当前 `● ` / 其余两空格），
   对话框经 DialogSelect `gutter` 槽同款处理——标记不再影响任何行的缩进。

### P5 修复二度回归（用户复验发现，当日修复）

面板仍与输入框不齐、缩进怪异。根因（第三次）：**面板一直在手搓行布局**，与对话框的
行渲染是两套代码，对齐靠猜必漂移。用户指路："看 down 弹出的列表的缩进怎么做的"。
对话框真结构：`scrollbox(padding 1/1)` → 行容器（`paddingLeft = 有圆点/gutter 时 1
否则 3`、`paddingRight 3`、`gap 1`）→ `Option`（title 自带 paddingLeft 3、description
内联 muted、footer 右对齐）。修正：**导出 DialogSelect 的 `Option`，面板渲染同一个
组件 + 同一行容器**（全行带 gutter → paddingLeft 恒 1；缩进与圆点同在 gutter）——
缩进与对话框"由构造相同"，不再存在两套布局。`formatAgentRow` 维持 indent/label
分离，两侧共用。设计文档 §5.2.3 的"面板镜像输入框框体"表述由本条取代。

## P4 Agents 列表常驻显示在输入框底部

**用户要求**（验证反馈，2026-09-25）：把 Agents 列表放到输入框底部，常驻显示。

**确认的设计**（用户逐项确认）：
- 面板与 down 对话框**并存**：面板管"一眼看全局"，对话框管过滤与键盘导航
- 行解剖与对话框**同源**（`formatAgentRow` 单一 owner），右侧 token/时长同样 1s tick 实时
- 行可**鼠标点击**直接跳转（悬停高亮，复用 footer 按钮时代的交互）
- 显示条件：树内 ≥2 成员（孤行 Main 是噪音）；权限/提问面板出现时随输入框一同隐藏
- 行数 >5 截断为 `+N more — down opens the list` 尾行（确认方案为"面板内滚动区"，
  实施改为截断+指向对话框：非聚焦 scroll 区域的滚轮行为无法在无 TTY 环境验证，
  截断不吞行、永远可达；如需真滚动区再引入）
- 位置：输入框之下、（子会话视图时）SubagentFooter 之上

**状态**：已修（本轮）

### P5 修复回归（用户复验发现，同日修复）

1. 对齐仍未中：首次按猜的 `paddingLeft 5 / paddingRight 3` 落偏。根因：未先读输入框
   实际框体就猜列。修正：读 Prompt JSX——`width 100%` + **左 border 1 列** + 内
   padding 2/2（右无边框）——面板镜像同一框体（`border={["left"]}` + 内 padding 2/2），
   两缘与输入框完全重合。教训：**对齐题的列差必须从 JSX padding/border 链推得，禁止猜**。
2. `● ` 前缀插在带缩进的标题前，当前行比其他行凸出 2 列。修正：缩进从 `formatAgentRow`
   的 title 拆出为独立 `indent` 字段，圆点进固定宽度前置槽（当前 `● ` / 其余两空格），
   对话框经 DialogSelect `gutter` 槽同款处理——标记不再影响任何行的缩进。

## P5 常驻面板四项修正（对齐 / 当前行高亮 / 删提示 / 计数口径统一）

**用户要求**（验证反馈，2026-09-25）：
1. 面板左缘未与上面转录的目录路径对齐、右缘未与输入框内 commands 末尾对齐
2. 面板应高亮标记当前显示的 agent（修订：`current` 文字标记删掉，只保留视觉高亮）
3. 输入框内的 `down view agents` 提示删掉（面板常驻后冗余；转录尾部提示保留）
4. 面板 token 计数与 footer/状态栏不一致

**实现**：
1. 面板容器 `paddingLeft 5 / paddingRight 3`——左缘对齐转录文本列（外层 2 + 消息
   border/padding 3），右缘对齐输入框内边右缘；以实测为准，偏差一行即调
2. 当前行：行首 `●` + 名称 primary 主题色（与对话框选中同视觉语言）；
   `formatAgentRow` 删除 `isCurrent`/`current` 文字标记（高亮归各渲染面）
3. 提示行与 accessor 删除
4. **口径裁决（用户选 1）**：新共享纯函数 `contextUsage`（最后一条 assistant 消息
   聚合 + % of context limit）为唯一 owner——footer、对话框、面板三处同源；
   footer 重构为调用它（显示不变）；面板删除 `session.tokens` 累计口径；
   `formatListTokens`（"tok" 单位）连带删除。运行时语义注记：HttpApi payload
   多余键为剥离非拒绝（沿用 D14 结论），与本条无关，防混淆特此注明。

**状态**：已修（本轮）

### P5 修复回归（用户复验发现，同日修复）

1. 对齐仍未中：首次按猜的 `paddingLeft 5 / paddingRight 3` 落偏。根因：未先读输入框
   实际框体就猜列。修正：读 Prompt JSX——`width 100%` + **左 border 1 列** + 内
   padding 2/2（右无边框）——面板镜像同一框体（`border={["left"]}` + 内 padding 2/2），
   两缘与输入框完全重合。教训：**对齐题的列差必须从 JSX padding/border 链推得，禁止猜**。
2. `● ` 前缀插在带缩进的标题前，当前行比其他行凸出 2 列。修正：缩进从 `formatAgentRow`
   的 title 拆出为独立 `indent` 字段，圆点进固定宽度前置槽（当前 `● ` / 其余两空格），
   对话框经 DialogSelect `gutter` 槽同款处理——标记不再影响任何行的缩进。