# devlog — subagent 列表与 down 链式回退（子计划 agentmgmt-1，commit 2 / issue #38）

日期：2026-09-22　分支：`agentmgmt-1-tui-subagent-surface`　基线：`dev @ bf8ec3d8c0`

## 做了什么

TUI 此前没有 subagent 列表：`<leader>down` 直跳第一个子会话、`left/right` 盲翻兄弟。
本 commit 实现 issue #38 的链式回退：`down` → 移光标 → 翻完 prompt 历史 → 回到 live
input → **再按 down 展开列表**，纯增量，不占任何既有键。

- `prompt/history.tsx`：新增 `atLive()`（`store.index === 0`）。`move()` 无法表达
  "历史翻完"——底部返回 truthy live 项，`!item` 分支在向下方向是死路（issue 已识别，
  实施时复核属实）。
- `component/prompt/index.tsx`：`PromptProps` 新增可选 `onHistoryNextAtBottom`；
  `prompt.history.next` 的 `run()` 在光标末尾守卫之后、`move` 之前插入三条件合取
  `空输入 ∧ atLive() ∧ 回调消费`（Step P10）。未消费时落回既有 `move` 路径（P11/INV-3）。
- `routes/session/index.tsx`：新增导出纯函数 `subagentListMembers(sessions, rootID,
  currentID)`——子树去掉 root 与当前会话，按（深度，创建时间）排序；`openSubagentList`
  作为回调：栈上已有 dialog / 无 root / 无成员时返回 false（ keystroke 归还编辑器），
  否则 `dialog.replace` 打开列表，action 复用 `enterChild`（含 retry 弹窗）。
- `component/dialog-subagent-list.tsx`（新）：DialogSelect 薄壳。行 = 缩进 + 标签
  （`metadata.agentName` → `session.agent` → title 的 `@type subagent` 解析 → 占位），
  描述 = 类型 · 状态（`session_status[id].type`）。

## 关键决策

- 触发条件收窄到"空输入"：用户在写东西时不劫持按键（issue 待定①的决议，设计文档 §5.2.2）。
- 列表排除 root：主会话不是 subagent，回根由 `up` 承担——从子会话视图打开时同样成立
  （设计审查修正项：collectSubtree 含 root，原稿会把它混进列表）。
- 组件只做显示：成员与排序由可无渲染测试的纯函数产出（collectSubtree 先例）；
  组件对 routes 仅 type-only import，无运行时循环依赖。

## 经验教训

- **按键级不变量的诚实边界**：INV-3/INV-5（down 未消费等价基线；atLive 定义）无法用现有
  基建做单测——history store 的 init 依赖 hooks，无渲染不可实例化；为测试抽取纯核心是
  无第二消费者的 seam，按剃刀不做。处置：atLive 由构造成立（一行 getter）+ 触发三条件
  逐一论证，⚠️ 记入 Step 5 decisions.md（expectations §7 已同步补记）。宁可如实降级
  覆盖声明，不做假测试或为测试重构生产代码。
- `createSimpleContext` 的 `init` 在 provider 渲染时才调用且内部用 hooks——判断"这段
  逻辑可否单测"要在设计期做，写完才发现会让测试计划落空。

## 度量

| 指标 | 数值 |
|------|------|
| 新增代码行数 | ~180（其中测试 ~70） |
| 修改代码行数 | ~8 |
| 删除代码行数 | 0 |
| 涉及文件数 | 5（history、prompt、session 路由、新组件、新测试）+ expectations 记账 |
| 新增测试用例数 | 6（全部为 `subagentListMembers` / INV-4） |
| 测试通过率 | TUI 全量 217 pass / 1 skip（既有）/ 0 fail；服务端未触及 |
| 发现 bug 数 | 0（设计审查期发现并修正 1 处：列表含 root） |
| 修复 bug 数 | 0 |
| 迭代轮次 | 实现 1 轮 |
