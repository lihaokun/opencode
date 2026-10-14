# devlog — 委派结果通知可见（子计划 agentmgmt-1，commit 1 / issue #39）

日期：2026-09-22　分支：`agentmgmt-1-tui-subagent-surface`　基线：`dev @ bf8ec3d8c0`

## 做了什么

委派完成/失败通知此前以 `synthetic: true` 文本 part 注入父会话，被 TUI `UserMessage` 的
synthetic 过滤整体隐藏——三条"subagent 说话"路径中唯一不可见的恰是用户要的工作结果。
本 commit 给通知 part 附两字段 metadata（`{kind: "agent_notification", summary}`），
TUI 按 metadata 渲染一行 `↳ <summary>`，不解析模型面向的正文。

- 服务端：`agent-management/schema.ts` 新增 `NOTIFICATION_METADATA_KIND` 常量；
  `lifecycle.inject()` 把已算好的 summary 提升为局部量，与 kind 一起写入 part metadata。
  文本（`renderOutput` envelope）一字未动——它仍是模型面向契约（I2）。
- TUI：`routes/session/index.tsx` 新增导出的纯函数 `agentNotificationSummary(parts)`
  （仅经 `metadata.kind` 识别，summary 非字符串时返回 undefined）；`UserMessage` 顶部
  新增一行 muted 提示分支；无 metadata 时走原路径（P13 兼容负例）。
- 四处既有 synthetic 过滤（转录渲染/可见消息定位/undo 聚合/跳转最后用户消息）未动。

## 为什么这样

- 识别走 metadata 而非解析 `<summary>`：envelope 是给模型读的，UI 解析它就把 UI 耦合进
  模型面向格式，改格式时无类型保护、坏了也是 UI 静默消失（设计文档 §4.1 定案，用户确认）。
- 只留 kind + summary 两字段：state/sessionID 在 v1 无消费者，按剃刀砍，再引入条件已记录。
- 通知被 undo 聚合/历史召回排除是正确语义：它不是用户输入。

## 关键决策与验证

- `TextPartInput` 已有 `metadata: Record(String, Any)`（`packages/schema/src/v1/session.ts:406`），
  零 wire schema 变更；`resolveUserPart` 对普通 text part 原样透传，metadata 可达 TUI。
- 失败路径端到端覆盖：新测试自定 ops 让子 run 以 `info.error` 收场 → `classify` → 失败 →
  `background.wait` → `inject("error")`，断言 summary 为 `Agent failed: <description>`。
  该测试同时验证了 BackgroundJob 失败 → wait → inject 的既有链路仍然成立。
- SDK v2 `FilePart` 类型无 metadata → "非 text part 带 metadata"用例在类型层不可达，
  测试以 `as unknown as Part` 钉住运行时防御分支，并注明这不是可达 wire 形状。

## 经验教训

- SDK 的 *Response* 类型带 `metadata` 不代表所有 *Input* 类型都带——写 part 字段前逐类型
  核对（本次 `TextPartInput` 有、`FilePart` 无，恰好都在同一次改动里用到）。
- `bun test` 对 `it.instance(...)` 超时会静默变 fail 而非挂起——既有 `awaitWithTimeout`
  helper 是正确工具，新测试直接复用，不要自造 sleep 轮询。

## 度量

| 指标 | 数值 |
|------|------|
| 新增代码行数 | ~233（其中测试 ~158） |
| 修改代码行数 | ~4 |
| 删除代码行数 | ~4（summary 内联表达式提升为局部量） |
| 涉及文件数 | 5（2 src 服务端、1 src TUI、2 test） |
| 新增测试用例数 | 8（服务端 2 + TUI 6） |
| 测试通过率 | opencode agent-management 101/101；TUI 全量 211 pass / 1 skip / 0 fail |
| 发现 bug 数 | 0 |
| 修复 bug 数 | 0 |
| 迭代轮次 | 实现 1 轮；TUI 测试因 FilePart 类型修正 1 轮 |
