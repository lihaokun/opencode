# devlog — 人 → subagent 输入（子计划 agentmgmt-1，commit 3 / issue #37）

日期：2026-09-22　分支：`agentmgmt-1-tui-subagent-surface`　基线：`dev @ bf8ec3d8c0`

## 做了什么

subagent 会话此前在 TUI 只读：`visible()` 要求 `!parentID`，而天真放开会把全局选中的
主 agent 身份经 `setAgentModel` 持久化写进子会话（#35 修过的同类 P0）。本 commit 打通
"人说得上话"，且身份规则仍然只有一个 owner。

- **服务端**：`AgentMessage` 扩展为 `InboxMessage` tagged union（`kind: "agent" | "user"`）；
  `AgentInbox.deliver` 两种 kind 共享同一身份解析块（target 查找 → agent/model/variant
  折叠 → deliverAsync），只有渲染的 parts 不同——agent 路走 `render()`（escapeField +
  回复指引），user 路是固定头行 `[Message from user]` + 用户 parts 原样（无 sender、
  无可转义字段、无回复指引——人在转录前，子 agent 就地作答）。
- **HTTP**：新端点 `POST /session/{sessionID}/agent-message`，payload
  `Schema.Struct({ parts })`——**pick 而非 omit**：从 PromptPayload omit 会残留
  `messageID/noReply/tools/system/format`，其中 `noReply:true` 会让消息持久化但不跑 loop
  （沉底不唤醒）。只留 parts = I1 类型强制 + noReply 洞收口。
- **既有调用点**：agent_send 工具与 stop 通知机械包一层 `{kind:"agent", message}`。
- **SDK**：`script/generate.ts` 再生成，`sdk.client.session.agentMessage` 就位。
- **TUI**：`visible()` 去掉 parentID 条件（子会话视图权限/提问恒空，放开的只是输入框）；
  `Prompt` 新增 `onSubmitUserMessage`——存在即接管：接管分支是模式分支链第一个分支
  （shell/slash/prompt 不可达），身份读取值不进 payload；agent/model 选择器 meta 行隐藏；
  路由仅在子会话视图注入回调，直接调 `agentMessage`，错误走 toast。

## 实施裁决（契约修订，已回写设计文档与 expectations）

- `onSubmitUserMessage` 初稿返回 `boolean` 表示"已消费"，实施时裁掉：prop 存在本身即
  接管（无第二语义），返回值无消费者——按剃刀收敛为 `void`。设计文档 §4.4 与
  expectations §2 已同步标注。

## 关键验证

- 服务端新测试：user 路投递 = 目标自身身份（agent=explore、model 不变、`"default"`
  variant 折叠为 undefined）+ 固定头行 + 用户 parts 原样（INV-1 主断言）；
  payload schema keys **恰为 `["parts"]`**（负向断言，钉死 noReply 洞）。
- 既有 agent_send/stop 测试经 union 包装后全绿（102→103 全过）——union 是纯增量。
- `TextPartInput.metadata`/parts 通道均无 wire schema 变更；SDK diff 仅新增端点。

## 经验教训

- **`script/generate.ts` 会连带跑仓库级 formatter**，一次波及 55 个文件（含大量无关
  docs/源码的格式抖动）。跑完必须按"本次改动集合"逐文件甄别，用 `git checkout --`
  回滚纯格式抖动的文件，再对被卷入的语义文件重放最小改动——否则一个功能 commit 里
  会混进几百行无关重排。CLAUDE.md 的 patchedDependencies 键序警告同理，都属于
  codegen 类脚本的隐式副作用，跑之前先知道它会动什么。
- Effect 接口的结构化满足有型变边界：`SessionPrompt.Service` 不能直接当
  `AgentPromptOps` 传（`prompt` 的 error 通道逆变），要么用层内 `ops()` 包装
  （die 掉 error），要么在消费侧内联同形构造——本次选后者并注释说明。
- Solid `<Show when={a && b}>` 会把类型收窄成 `true | T`，函数子节里的 accessor 拿到
  `true` 就炸——嵌套 Show 或提前计算 accessor。

## 度量

| 指标           | 数值                                                              |
| -------------- | ----------------------------------------------------------------- |
| 新增代码行数   | ~430（含 SDK 生成 ~310、测试 ~160）                               |
| 修改代码行数   | ~110                                                              |
| 删除代码行数   | ~90（多数为 deliver 重构中被替换的行）                            |
| 涉及文件数     | 15（服务端 6 + 测试 2 + SDK 3 + TUI 3 + 契约文档 2）              |
| 新增测试用例数 | 2（服务端：user 路身份+头行；payload keys 负向断言）              |
| 测试通过率     | opencode agent-management 103/103；TUI 217 pass / 4 skip / 0 fail |
| 发现 bug 数    | 0（formatter 波及 55 文件一次，流程性失误当轮发现并回滚）         |
| 修复 bug 数    | 0                                                                 |
| 迭代轮次       | 实现 1 轮                                                         |
