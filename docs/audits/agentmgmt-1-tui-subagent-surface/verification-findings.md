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
