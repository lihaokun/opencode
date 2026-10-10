# devlog — 人工验证修复轮（子计划 agentmgmt-1：P1 Agents 列表收编导航 / P2 Task 改名）

日期：2026-09-23　分支：`agentmgmt-1-tui-subagent-surface`

## 做了什么

用户以 v1.18.31-fmv3-beta.1 做人工验证，提出两个问题（清单见
`docs/audits/agentmgmt-1-tui-subagent-surface/verification-findings.md`），确认后本轮修复：

**P1 Agents 列表收编全部导航**
- `subagentListMembers` 改为全树成员（root/当前会话/全部后代，不再排除），视图无关
- `DialogSubagentList`：标题 `Agents`；root 行固定标签 `Main`；当前会话 DialogSelect
  `current` 预选 + 描述列 `current` 标记
- 删除导航：footer Parent/Prev/Next 按钮区（左侧信息保留）、键位 up/left/right/
  `<leader>down` 四项、隐藏命令 ×4、`moveFirstChild`/`moveChild`/`childSessionHandler`/
  `children()` memo
- 转录尾部提示改挂 `prompt.history.next`（`<down> view agents`）

**P2 工具行 "Task" → "Agent"**
- `formatSubagentTitle` 去掉 "Task"（类型名打头，背景态 `(background)` 保留），
  fixture/断言/快照同步

## 关键决策

- 原 commit 2 裁决"排除 root、回根交给 up"被真实使用反馈推翻：单一导航面优于分散键位。
  教训：**导航类 UX 的剃刀裁决应当更保守**——"少一个入口"的收益要和"用户寻找入口的
  认知成本"相抵；验证者用 `up` 回根时根本没把 footer 按钮和列表视为同一件事。
- `manual-verification.md` §2 已重写（2.5"无列表"语义废止，新增 2.8 导航删除回归、
  2.9 提示文案），expectations §5/§7-INV-4 同步修订并标注 P1。

## 度量

| 指标 | 数值 |
|------|------|
| 修改代码行数 | ~120 |
| 删除代码行数 | ~130（导航函数/命令/按钮/键位） |
| 涉及文件数 | 9（route、footer、dialog 组件、keybind、2 个测试文件、3 类文档） |
| 测试通过率 | TUI 215 pass / 4 skip / 0 fail；opencode 未触及 |
| 发现 bug 数 | 1（流程性：footer 文件路径误写 component/ 下新建，当轮发现删除；真实文件在 routes/session/） |
| 修复 bug 数 | 0 |
| 迭代轮次 | 1 |
