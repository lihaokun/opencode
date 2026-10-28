# 修正方案 — tui：左键点用户消息即弹默认 Revert 的菜单（误触撤回对话与文件）

> 对应 issue #69（lihaokun/opencode）。方案已在 issue 中与维护者对齐（四条），本文档按 §7.1 八部分落成可执行稿。

## 第一部分：现象与复现

### 现象

TUI 中对用户消息松开鼠标左键（无选中文字时）即弹出 "Message Actions" 菜单，默认选中 **Revert**。点一下获取焦点、点一下停滚动、拖选没拖出范围，都会弹出；顺手回车就撤回这条消息之后的全部对话并回退文件改动，无确认、无恢复提示（`<leader>r` 可恢复但界面不说）。

### 最小复现用例

1. 会话里有一条自己的消息
2. 在消息上左键单击（无选中）

预期（修复后）：什么都不发生；右键单击才弹菜单，且默认项是 Copy；选 Revert 需经确认框。
实际（修复前）：菜单立即弹出且高亮 Revert。

### 出错代码路径

- `packages/tui/src/routes/session/index.tsx:1216-1227` — `<UserMessage onMouseUp={…}>`：无选中即 `dialog.replace(<DialogMessage>)`
- `packages/tui/src/routes/session/dialog-message.tsx:21-106` — 菜单顺序 Revert、Copy、Fork，首项即默认选中（DialogSelect `selected: 0`）
- `dialog-message.tsx:29-54` — Revert `onSelect` 直接 `session.revert`，无确认
- 事件源：`packages/tui/src/routes/session/index.tsx:1385`（`UserMessage` 内层 box `onMouseUp={props.onMouseUp}`，未区分鼠标键）

### 预期行为 vs 实际行为

| 动作 | 预期（issue 方案） | 实际 |
|---|---|---|
| 左键单击 | 无动作 | 弹菜单（默认 Revert） |
| 右键单击（有选中） | 复制选中 | （实验模式下已如此；非实验模式松开即复制——保持） |
| 右键单击（无选中） | 打开菜单 | 无反应 |
| 菜单默认项 | Copy | Revert |
| 选 Revert | 确认框（消息数 + `<leader>r` 提示 + 超 7 天警告）后执行 | 立即执行 |
| `<leader>g` 时间线菜单 | 同上 | 同左（同一 `DialogMessage`） |

## 第二部分：根因分析

**症状**：误触即撤回。

**根因（两层叠加）**：

1. **事件层**：`onMouseUp` 未区分鼠标键——任何键的松开都触发菜单。opentui 的 `MouseEvent` 自带 `button`（`@opentui/core/renderer.d.ts:140-164`，`MouseButton.LEFT=0/RIGHT=2`），只是这里没读。
2. **语义层**：菜单把**破坏性操作**（Revert 改对话 + 回退文件）排在首位并作为默认项，且执行前无确认。 Copy / Fork 才是无副作用的常规操作。

`handleUnrevert`（`index.tsx:1158-1167`，Confirm Redo）已是仓库内"破坏性操作加 DialogConfirm"的先例；Revert 缺同一层属于遗漏。

**不是根因**：`renderer.getSelection()?.getSelectedText()` 挡选中的判断正确且保留；DialogSelect 的"首项默认"机制无错，错在选项排列。

## 第三部分：参考实现对照

- 事件区分：`app.tsx:1095-1102` 已用 `evt.button !== MouseButton.RIGHT` 过滤右键（实验模式的复制路径），证明 button 字段可靠到达组件层。修复把同样的判断下沉到消息行。
- 破坏性确认：`DialogConfirm.show`（`ui/dialog-confirm.tsx:93-108`）返回 Promise，`handleUnrevert` 是完整调用范例。
- 双击/二次确认范式：`session.interrupt`（prompt/index.tsx:438-449）——本修复不涉及时序，仅在菜单内加一道显式确认。

## 第四部分：修复方案

### 1. 纯函数决策器（新文件 `packages/tui/src/routes/session/message-mouse.ts`）

```
messageMouseAction(input: { button: number; selectionText?: string | undefined }): "copy" | "menu" | "none"
```

- `button === LEFT` → `"none"`（无论是否有选中；选中复制由全局 mouseUp 复制路径负责，保持现状）
- `button === RIGHT` ∧ selectionText 非空 → `"copy"`（走 `Selection.copy`，与实验模式右键复制行为一致）
- `button === RIGHT` ∧ 无选中 → `"menu"`
- 其余（中键/滚轮）→ `"none"`

### 2. 消息行接线（`index.tsx` `UserMessage` 的 `onMouseUp`）

改签名为接收 `MouseEvent`；内部调用决策器：`none` → return；`copy` → `Selection.copy(renderer, toast, clipboard)` + `preventDefault/stopPropagation`；`menu` → 现有 `dialog.replace(<DialogMessage>)`。注意：非实验模式下全局 mouseUp（`app.tsx:1103-1107`）已做松开复制，右键无选中时全局路径 no-op（无 selection），组件层再开菜单，两者不冲突；实验模式下全局 onMouseDown 已复制并 stopPropagation，组件层 `copy` 分支实际走不到，保持一致。

### 3. 菜单重排 + Revert 确认（`dialog-message.tsx`）

- 顺序改为 **Copy、Fork、Revert**（默认选中 Copy）
- Revert `onSelect` 改 async：先 `DialogConfirm.show(dialog, "Confirm Revert", <文案>)`，确认后才执行现有 revert + setPrompt 逻辑
- 文案由纯函数 `revertConfirmMessage(input: { reverted: number; stale: boolean })` 生成：
  - 基础：`This will remove the {n} message(s) after this one and restore the file changes made in them. You can restore with <leader>r (or /redo) before sending a new message.`
  - `stale === true`（消息创建时间早于 `Date.now() - 7 天`，对应 snapshot `git gc --prune=7.days`，`packages/opencode/src/snapshot/index.ts:23`）追加一行：`This message is older than 7 days: its snapshot may have been pruned, and file changes may not be restorable.`
- 消息数 n 的口径：与 undo 入口一致，取该消息**之后**（不含自身）的消息条数，由调用方从 `sync.data.message[sessionID]` 现算传入

### 4. 时间线同一菜单

`dialog-timeline.tsx:35-39` 复用 `DialogMessage`，第 3 条的改动自动生效，无须单独改。

## 第五部分：正确性论证

1. **根因消除**：误触路径的入口（任意键松开 → 菜单）被决策器收窄为"右键且无选中"；破坏性操作即使被打开也被默认项（Copy）与确认框双重隔离。两个根因层各有对应改动，不靠缩小菜单功能换取安全。
2. **不变量保持**：
   - 左键获取焦点、拖选文字、滚轮滚动：决策器返回 `none`，渲染层不再接管，行为与"点击只用于焦点/选字"一致；
   - 选中复制：左键路径不变（全局 mouseUp 处理），右键路径与实验模式行为一致；
   - Revert 的持久化语义零改动：确认后才调同一 `session.revert` + `setPrompt`，`<leader>r`/`/redo` 恢复通道不变；
   - 时间线入口与消息行入口汇聚到同一组件，二者行为保持一致（issue 方案第 4 条）。
3. **无回归引入**：第六部分用例覆盖三类入口（消息行左/右键、时间线）、确认框文案三态（n=1/n>1/stale）、Revert 确认后与取消后的分支；`UserMessage` 的其他消费路径（assistant 消息无 mouseUp）不受影响。

## 第六部分：测试用例清单（计划）

| 类型 | 用例描述 | 状态（修复后回填） |
|------|---------|------------------|
| 新增（纯函数） | `messageMouseAction`：左键（有无选中）→ none；右键有选中 → copy；右键无选中 → menu；中键/滚轮 → none | 已加: test/routes/message-mouse.test.ts，8 用例 |
| 新增（纯函数） | `revertConfirmMessage`：n=1 单数措辞、n>1 复数、stale 追加 7 天警告行、非 stale 无警告 | 已加: test/routes/message-mouse.test.ts（与决策器同文件） |
| 新增（渲染） | 菜单顺序 Copy < Fork < Revert（默认选中 Copy） | 已加: test/cli/tui/dialog-message.test.tsx "menu lists Copy first, not Revert" |
| 新增（渲染） | 选 Revert → 先出现 Confirm Revert 且未调用 revert；确认后 revert 才被调用（经真实 SDK client + stub fetch 断言 POST /session/{id}/revert） | 已加: "choosing Revert opens a confirm dialog and only reverts after confirm" |
| 新增（渲染） | Confirm 上选 Cancel → 不调用 revert | 已加: "canceling the confirm dialog leaves the session untouched" |
| 新增（渲染） | 确认文案含消息数与 `<leader>r`；超 7 天消息追加 snapshot 警告 | 已加: "confirm copy names the count..." + "stale messages add the snapshot warning..." |

**渲染测试实现备注**：真实事件经 `@opentui/solid` 的 `testRender` + `mockInput`（键盘驱动菜单）走真实 DialogSelect/DialogConfirm/keymap 链路；`createMockMouse` 对消息行的命中测试需要消息行渲染坐标（完整 app 级 harness），决策器的鼠标键语义已由纯函数层覆盖（button 来自同一个 `MouseEvent.button` 字段），故消息行的"左键不弹菜单"以决策器纯函数 + 右键分支渲染路径组合覆盖。revert 断言走真实 hey-api client（`SDKProvider` 注入 stub fetch），非直接 mock 组件依赖。

## 第七部分：代码更新清单（计划）

| 文件 | 函数 / 行号 | 改动概述 | 状态（修复后回填） |
|------|------------|---------|------------------|
| `packages/tui/src/routes/session/message-mouse.ts`（新） | `messageMouseAction` | 纯函数决策器 | 已加: commit 本条 |
| `packages/tui/src/routes/session/index.tsx` | `UserMessage` onMouseUp（约 LL1220-1250） | 接 MouseEvent → 决策器三分支（copy 走 `Selection.copy`） | 已改: commit 本条 |
| `packages/tui/src/routes/session/dialog-message.tsx` | options 数组 | 重排 Copy/Fork/Revert；Revert 加 DialogConfirm；新增 `revertConfirmMessage` + `revertedCount`（该消息之后的消息条数） | 已改: commit 本条 |
| `packages/tui/test/routes/message-mouse.test.ts`（新） | — | 纯函数用例（决策器 5 组 + 文案 3 态） | 已加: commit 本条 |
| `packages/tui/test/cli/tui/dialog-message.test.tsx`（新） | — | 渲染用例 5 个（顺序/确认门/取消/文案/stale 警告） | 已加: commit 本条 |

## 第八部分：文档更新清单（计划）

| 文档路径 | 要改什么 | 状态（修复后回填） |
|---------|---------|------------------|
| `docs/devlog/2026-10-28-tui-esc-exit-message-menu.md` | 三合一修复 devlog（含度量段） | 待加（三步全完后统一写） |
| 无契约文档涉及 — 菜单项集合未增减（仅排序 + 确认层），keybind/revert API/snapshot 保留期均未变更；7 天口径在 `SNAPSHOT_RETENTION_MS` 注释中引用 snapshot 的 `prune = "7.days"`（`packages/opencode/src/snapshot/index.ts:23`），不新增契约。 | — | — |

### 实施记录（回填）

- 渲染测试调试中确认的一个 harness 要点：`SDKProvider` 不传 `fetch` 时会用全局 fetch 发真实请求（floating promise 静默失败），stub 必须经 `SDKProvider` 的 `fetch` prop 注入，让组件走真实 hey-api client 路径。
- 时间线菜单（`dialog-timeline.tsx`）复用同一 `DialogMessage`，重排与确认层自动生效，无需单独改动（issue 方案第 4 条由构造满足）。
