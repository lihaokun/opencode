# 子计划设计 — agent-management / `agentmgmt-1-tui-subagent-surface`

> 三个 issue 的合并子计划：TUI subagent 操作面。
>
> - #39 委派结果通知不可见（渲染）
> - #38 无 subagent 列表（导航）
> - #37 subagent 会话只读（人 → subagent 输入）
>
> 范围：**只做 TUI**。`session-ui`（网页/桌面）不在本子计划内。
> 组织：一个分支、三个独立 commit，顺序 **#39 → #38 → #37**（文件交叠见 §2）。
> 基线：`dev` @ `bf8ec3d8c0`（v1.18.31-fmv2，#42 上游同步后）——文中行号以此为准，再遇 rebase 需复核。

## 0. 架构定位

### 0.1 goal → 模块映射

| goal                                        | 模块                                                        | commit |
| ------------------------------------------- | ----------------------------------------------------------- | ------ |
| G1 委派结果在父会话转录中可见（一行提示）   | 服务端 `lifecycle.inject` + TUI `UserMessage`               | #39    |
| G2 主界面 `down` 链式回退到 subagent 列表   | TUI `prompt/history` + `Prompt` + 新 `DialogSubagentList`   | #38    |
| G3 人可直接给 subagent 发消息且不改写其身份 | 服务端 `AgentInbox` + HTTP 端点 + TUI `Prompt`/session 路由 | #37    |

### 0.2 关键假设

- **H1** 子会话身份（agent/model/variant）在 `Session.create` 时已持久化（#35 已做，`lifecycle.ts:383-387`）——G3 的身份解析有可靠来源。
- **H2** TUI `sync.data.session` / `sync.data.session_status` 投影覆盖子树全部会话（#35 的 `descendants()` 已在依赖）。
- **H3** 权限/提问请求在子会话视图为空是**既有设计**（`index.tsx:218-225` 归根会话处理），本子计划不改变它。
- **H4** 新 HTTP 端点的访问控制等同于既有 session 级端点（同一 auth 层），不新增 per-session 鉴权——人发消息与 `session.prompt` 同信任级。
- **H5** 子 agent 运行中收到人消息的唤醒依赖 #34 的 `shouldReArm`（已合入 #35），本子计划不重验其内部。

### 0.3 模块级不变量

- **I1（承重）** 任何路径投递**人发起的消息（kind=user）**进子会话时，目标身份只能解析自目标会话自身，owner 唯一（`AgentInbox.deliver`）。TUI 到服务端的 payload **不携带** agent/model/variant——由 payload schema 缺字段在类型层强制。
- **I2** synthetic 通知 part 的 UI 识别只经 `metadata.kind`，不经正文文本格式（正文是模型面向契约）。
- **I3** `down` 链式回退是纯增量：回调未被消费（返回 false）时，行为与今天逐分支一致。

## 1. 范围

| commit   | 触及文件                                                                                                                                                                                                                               | 契约变更                                                        |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 1（#39） | `packages/opencode/src/agent-management/lifecycle.ts`；`packages/tui/src/routes/session/index.tsx`                                                                                                                                     | synthetic text part 新增 metadata 约定（server→TUI）            |
| 2（#38） | `packages/tui/src/prompt/history.tsx`、`component/prompt/index.tsx`、`routes/session/index.tsx`、新 `component/dialog-subagent-list.tsx`                                                                                               | 无（UI 内部）                                                   |
| 3（#37） | `packages/opencode/src/agent-management/{schema,inbox}.ts`、`server/routes/instance/httpapi/{groups,handlers}/session.ts`、`packages/sdk`（codegen 再生成）；`packages/tui/src/component/prompt/index.tsx`、`routes/session/index.tsx` | `AgentMessage` 扩展 sender-kind；新 HTTP 端点；`Prompt` 新 prop |

明确不做（记录再引入条件）：

- `agent_send` / 取消通知压成一行（#39 待定②）——等"长消息灌满转录"成为实际诉求再统一。
- 通知行点击跳转子会话（#39 待定①的另一个方向）——#38 列表已承担导航。
- 失败通知按状态着色——summary 文本已含 "Agent failed" 语义。
- session-ui 同步——三 issue 均划出范围。

## 2. 与已有代码的复用点

| 复用件                                                | 位置                                                        | 用途                                                                  |
| ----------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------- |
| `AgentInbox.deliver` 的身份解析 + `deliverAsync` 路由 | `inbox.ts:87-120`                                           | G3 的唯一 owner，扩展而非复制                                         |
| `escapeField` / `render`                              | `inbox.ts:40-65`                                            | agent 路署名的既有编码规则（user 路不需要：头行无模型来源字段）       |
| `collectSubtree`                                      | `index.tsx:2645`（已有测试 `subagent-subtree.test.ts`）     | 列表数据源                                                            |
| `enterChild` / `moveChild`                            | `index.tsx:418-442`                                         | 列表项 action                                                         |
| `DialogSelect` / `DialogSessionList` 模式             | `ui/dialog-select.tsx`、`component/dialog-session-list.tsx` | 列表对话框骨架与按键栈行为                                            |
| `local.model` / `local.agent`                         | `context/local.tsx`                                         | **不进入 G3 的请求构造**（I1）——既有读取保留但值不进 payload，见 §4.4 |
| SDK codegen 链                                        | `httpapi-codegen` → `packages/sdk/js/src/v2/gen`            | G3 新端点走既有生成链                                                 |

## 3. 错误处理策略

- 服务端：沿用既有映射——`AgentNotFound` → `HttpApiError.BadRequest`（与 `prompt` 一致）；投递失败由 `deliverAsync` 内部的 `report` 走 `Session.Event.Error`（既有），HTTP 层不等待运行结果（204 = 已受理，与 `promptAsync` 同语义）。
- TUI：新端点调用失败 → toast（同 `submitInner` 现有 `.catch` 分支样式）；【P1 修订】列表恒含全树（至少 Main 行），无"空列表"分支；回调仅在对话框已打开时返回 false（按键本就归 dialog 栈）。
- 测试失败处理遵循 workflow §5.4，禁止改测试凑绿。

## 4. 数据结构定义

### 4.1 通知 metadata（server → TUI，commit 1）

```
数据结构：AgentNotificationMetadata（TextPart.metadata 的自由字段约定）

字段：
  - kind: "agent_notification" — 识别键。UI 唯一安全依据；与 TUI 自有的
    metadata.kind === "editor_context" 同一命名空间。
  - summary: string — 一行提示的显示内容。预渲染字符串，措辞 owner 在服务端
    （复用 inject() 已算好的 `Agent completed: <description>` / `Agent failed: <description>`）。

生命周期：一次性写入（inject()），不可变；旧转录无此字段，渲染器必须容忍缺失。
跨模块共享性：lifecycle.ts（写）↔ tui session/index.tsx UserMessage（读）。
```

已定案（用户确认）：**只有这两个字段**。`state`（再引入条件：通知行按终态区别着色）、`sessionID`（再引入条件：通知行提供跳转交互）均无 v1 消费者，砍。

### 4.2 `AgentMessage` sender-kind（commit 3）

```
数据结构：InboxMessage（deliver 入参，替代裸 AgentMessage）

字段：
  - kind: "agent" | "user"
  - message:
    - kind="agent" → 既有 AgentMessage 原形（target/sender/sender_name/sender_agent/body）
    - kind="user"  → { target: SessionID; parts: PromptInput["parts"] }
      （parts 而非 body：与 HTTP payload 同形，文件 part 免费获得既有 resolveUserPart 展开；
        头行 part 的插入由 deliver 完成，不进 payload）

类型不变量：
  - kind="agent" 时保留既有 SelfDelivery 校验（sender === target 拒绝）；
    kind="user" 无 sender，不适用。
  - kind="user" 的 parts 原样透传（与 session.prompt 的用户输入同信任级，不转义；
    文本 part 经既有 resolveUserPart 处理）。

跨模块共享性：tool/agent.ts（agent_send）、lifecycle.ts（stop 通知）、
httpapi handlers（新）、inbox.ts（owner）。
```

### 4.3 新 HTTP 端点（commit 3）

```
接口：TUI → server

POST /session/{sessionID}/agent-message
payload：{ parts: PromptInput["parts"] }   ← 刻意【不含】agent/model/variant/sessionID（I1）
query：WorkspaceRoutingQuery（directory/workspace，与既有 session 级端点同构，H4）
响应：204 NoContent（已受理；fork/路由在 deliverAsync 内部，失败走事件流）
错误：会话不存在 → 404 NotFoundError（requireSession 先行，与 prompt 同形）；
      deliver 的 AgentNotFound → BadRequest（经 HTTP 实际不可达——requireSession
      已把缺会话拦在前面；保留该通道与 inbox 错误类型一致）
【路径 B 审核 §3-1/§3-2 裁决】按上述声明修订契约（实现合理，原稿漏写 404 与 query）。

协议约定：
  - 调用方（TUI）：只传 parts；会话必须是子会话（v1 由 TUI 侧保证，服务端不限制——
    根会话调用等价于一条带头行的普通 prompt，无害）。
  - 被调用方（inbox.deliver）：身份解析自 target（H1）；在 parts 前插入头行 text part；
    经 ops.deliverAsync 投递（fork + 实例路由复用 agent_send 同一条路）。
```

头行：`[Message from user]`，单独一个 text part，后跟用户 parts。无回复指引行——人就在子会话转录前，subagent 直接作答即可（不预留 seam）。

### 4.4 `Prompt` 新 prop（commit 3）

```
数据结构：PromptProps.onSubmitUserMessage（可选）

  (input: { text: string; parts: PromptInfo["parts"] }) => void

语义：存在即表示当前会话由外部接管提交（子会话视图）。接管分支是 submitInner
模式分支链的第一个分支（shell/slash/prompt 之前），此时 inputText 与 parts 已
完成粘贴展开；分支返回后自然落入既有共享收尾（append 历史、清空输入）。
【实施裁决】初稿为返回 boolean 表示"已消费"，实施时裁掉：prop 存在本身即接管
（路由仅在子会话视图注入），返回值无消费者——按剃刀收敛为 void。

插入点约束（按 submitInner 实序）：local.agent/model 的**读取**（:961/:968，
纯读无副作用）与 exit/quit、workspace 守卫先于接管分支发生，语义有意保持：
- exit/quit 在子会话视图仍退出应用（全局约定，不特判）；
- workspace 断连时子会话提交同样被拦（期望行为）；
- 边界：全局未选 agent/model 时子会话提交被前置守卫拦下并提示模型警告
  （提示语略不贴切；实际不可达——默认 agent/model 恒在，v1 接受）。

I1 不受读取影响：读取值不进入接管分支的任何构造，payload 无身份字段（§4.3）。
```

## 5. 模块细化

### 5.1 commit 1（#39）：通知可见

#### 5.1.1 `lifecycle.ts inject()` — 附 metadata

- 在既有 `parts: [{type:"text", synthetic:true, text: renderOutput(...)}]` 上加
  `metadata: { kind: "agent_notification", summary }`，`summary` 即现有三元表达式结果。
- 文本与 `renderOutput` 一字不动（模型面向契约，I2）。
- **正确性论证**：trivial（单字段添加；消费端容忍缺失，见 5.1.2 负例）。

#### 5.1.2 TUI `UserMessage` — 识别并渲染一行

- 新 memo：`notification = parts.find(p => p.type === "text" && p.metadata?.kind === "agent_notification")`。
- 渲染分支：`notification` 存在 → 渲染独立一行 muted 样式 `↳ {summary}`（样式对齐既有 muted 提示行）；不存在 → 现状（synthetic-only 消息整体不可见，负例即兼容性回归）。
- 分支覆盖：有/无 metadata、有/无 file parts（file 照常渲染，不受影响）。
- 既有四处 synthetic 过滤（`index.tsx:380/625/842/1347`）**全部不动**：undo 聚合、历史召回、滚动定位把通知排除在外是正确语义（它不是用户输入）。
- **正确性论证**：
  - 前置：inject 写入的 part 带 metadata（5.1.1）。
  - 论证：识别走 `metadata.kind`（I2）→ 不依赖正文 → `renderOutput` 格式演进不影响 UI；无 metadata 的旧 part `find` 落空 → 走现状分支 → 兼容。
  - 后置：completed/error 两态在父转录中各显示一行；取消通知不经此路（走 inbox 全文，范围外）。

#### 5.1.3 测试

- 服务端：inject 产出的 part 携带 `{kind, summary}`（扩展既有 lifecycle 测试）。
- TUI：有 metadata → 渲染一行且不含正文；无 metadata → 不渲染（兼容负例）。

### 5.2 commit 2（#38）：down 链式回退到 subagent 列表

#### 5.2.1 `prompt/history.tsx` — 暴露 `atLive()`

- 新只读方法 `atLive(): boolean` = `store.index === 0`。不加参数、不改 `move`。
- **论证**：trivial（getter）。`move` 语义不动（I3）。

#### 5.2.2 `Prompt` — `prompt.history.next` 触发点

- `run()` 在光标末尾守卫之后、`history.move` 之前插入：
  `if (input.plainText.length === 0 && history.atLive() && props.onHistoryNextAtBottom?.()) return`
- 未消费（false/未传）→ 落入既有 `move` 调用，行为与今天一致（空输入 + live = no-op）。
- 触发条件决议（issue 三个待定）：
  1. **输入非空不触发**——`plainText.length === 0` 守卫（用户在写东西）。
  2. **无 subagent**——路由侧回调返回 false → 现状 no-op，无任何 UI。
  3. **列表打开后按键归 dialog 栈**——复用 DialogSelect 既有按键行为，不新造。
  4. 【路径 B 审核 §3-5 补记】**对话框已打开时不触发**——`openSubagentList` 另有
     `dialog.stack.length > 0` 前置（良性：按键本就归 dialog 栈），实现为第 4 守卫。
- 边界：历史为空时 `atLive()` 恒真 → 直接触发（"历史翻完"含"没有历史"）；多行非空输入光标在末尾 → 长度守卫拦下。
- **正确性论证**：
  - 前置：`prompt.history.next` 绑定 `down`（`keybind.ts:199`），光标末尾守卫已过。
  - 论证：三条件（末尾 ∧ 空输入 ∧ live）合取唯一直达"历史已翻完再按 down"状态 → 回调消费则键被处理；否则与现路径汇合（`move(1,…)` 返回 truthy live 项 = no-op）→ I3 成立。
  - 后置：触发与否不改变输入框内容与历史游标。

#### 5.2.3 `DialogSubagentList`（新组件）

- 数据【P1 修订，验证反馈推翻原裁决】：成员 = `collectSubtree(sessions, rootID)` **全量**——
  root（Main 行）+ 所有 subagent + 当前会话，不再排除任何成员。理由：用户验证反馈确立
  "单一导航面"——列表在树的任何视图内容一致，观察者位置由 current 标记表达而非删行；
  原裁决（排除 root、回根交给 up）连同 up/left/right/<leader>down 键位一并废止。
- 行内容：root 行固定标签 **`Main`**；其余 = `metadata.agentName` → `session.agent` 类型 →
  title 的 `@type subagent` 段 → 占位 `"Subagent"`；描述 = `[类型, 状态, current?]` 拼接；
  当前会话经 DialogSelect `current` 属性预选 + 描述列 `current` 标记；缩进 = 子树深度
  （root 0 不缩进）；排序 =（深度，创建时间）。状态 = `sync.data.session_status[id]?.type`。
- 标题/占位：`Agents` / `Filter agents`。
- 导航唯一化【P1 修订】：删除 footer 的 Parent/Prev/Next 按钮区（左侧信息保留）与键位
  `session_parent`/`session_child_cycle`/`session_child_cycle_reverse`/`session_child_first`
  （up/left/right/<leader>down 归还编辑器），连带 `moveFirstChild`/`moveChild`/
  `childSessionHandler` 与四个隐藏命令；列表 action 仍是 `enterChild` → `dialog.clear()`。
  转录尾部提示改挂 `prompt.history.next`（"view agents"）。
- action：选中 → `enterChild(id)`（复用，含 retry 弹窗行为）→ `dialog.clear()`。
- **论证**：action 与既有跳转逻辑等价（enterChild）；终止性 trivial（collectSubtree 已证）。
- 删除 4 个既有导航键位，不新增任何键（down 既有）。

#### 5.2.4 测试

- `atLive` 语义（空历史/有历史/翻完回 live）；触发三条件合取与各自否定；列表过滤（排除当前会话、含孙子、深度缩进）；action 跳转。

### 5.3 commit 3（#37）：人 → subagent 输入

#### 5.3.1 `inbox.ts deliver` — sender-kind 扩展

- 入参改为 §4.2 的 `InboxMessage`；身份解析块（`inbox.ts:87-103`）原样共享：
  `agent = target.agent ?? defaultInfo()`、`model = target.model`、`variant` 折叠 `"default" → undefined`。
- 渲染分支：`kind="agent"` → 既有 `render(message)`（单 text part）；`kind="user"` → 头行 part（§4.3）+ 用户 parts，走同一 `ops.deliverAsync`。
- 既有调用点（`tool/agent.ts` agent_send、`lifecycle.ts` stop 通知）包一层 `{kind:"agent", message}`——机械改动。
- **正确性论证**：
  - 前置：target 存在（get 失败 → AgentNotFound，既有）；H1 身份已持久化。
  - 论证：两条 kind 汇合到同一身份解析与 deliverAsync 调用 → 身份规则 owner 唯一（I1）；user 路无 `sender===target` 问题（无 sender）；fork 与实例路由复用 → 丢唤醒/跨目录两既有修复自动覆盖。
  - 后置：204 已受理语义与 agent_send 一致；幂等性同 promptAsync（无幂等键，重复提交会重复投递——与既有 session.prompt 同级，不新增缓解）。

#### 5.3.2 HTTP 端点 + SDK

- `groups/session.ts` 定义路由与 `AgentMessagePayload = Schema.Struct({ parts: PromptInput.fields.parts })`。
  **pick 而非 omit**：从 `PromptPayload` 做 omit 会残留 `messageID/noReply/tools/system/format` 等本设计未审字段；其中 `noReply: true` 尤其有害——`deliverAsync → prompt` 会持久化消息但**不跑 loop**，消息沉底、子 agent 永不被唤醒（`inbox.ts` 注释明确记载该语义）。只留 parts = I1 的类型强制 + 这类洞的收口。
- handler：`requireSession` → `inbox.deliver({kind:"user", message:{target, parts}})`，头行 part 插入在 deliver 内完成（§4.2）。
- 走 `httpapi-codegen` 再生成 SDK；TUI 得到 `sdk.client.session.agentMessage(...)`。
- **论证**：trivial（与 `promptAsync` handler 同构，仅多 inbox 调用）。

#### 5.3.3 TUI session 路由 — `visible()` 放开 + 提供接管回调

- `visible()`：去掉 `!session()?.parentID` 合取项 → 子会话视图渲染 `Prompt`；`SubagentFooter` 保留（footer 在上、输入框在下，并列 `<Show>` 天然共存）。
- 提供 `onSubmitUserMessage`（仅当 `session()?.parentID`）：调 `sdk.client.session.agentMessage({sessionID, parts})`，catch → toast。
- 已知限制（记录，不做 UI）：子会话视图内子 agent 发起权限/提问时，请求归根会话视图处理（H3）——用户需 `up` 回根会话；footer 不提示。
- 已知限制（记录，不修）：子会话视图 undo 会把 `[Message from user]` 头行与正文一并召回输入框（多 text part 无分隔符拼接，既有聚合行为 `:625`），原样重发会产生双头行。v1 接受。再引入条件：若需从头行召回中排除，现有 `synthetic` 标记不可复用（它同时把转录渲染也排除，§5.1 依赖其可见性），需引入"仅召回排除"的独立标记。
- **论证**：`permissions()/questions()` 在子视图恒空（H3）→ 放开后 `disabled` 恒 false → Prompt 可用；根视图行为不变（合取项去掉后根视图求值不变，负例回归覆盖）。

#### 5.3.4 `Prompt` — 接管路径

- §4.4 prop；实现为模式分支链的第一个分支（`store.mode === "shell"` 分支之前，`:1059`），此时 `inputText`/`nonTextParts` 已就绪（`:1026-1037`）：分支委托 `props.onSubmitUserMessage({ text, parts })`，SDK 调用（`agentMessage`）由路由回调完成（§5.3.3），随后落入各分支共享的收尾（历史 append、清空、`props.onSubmit`）。
  【路径 B 审核 §3-4 声明】连带后果（记录，v1 接受）：子会话视图内编辑器选区上下文
  （`editorParts`）不进请求、`editor.markSelectionSent()` 不执行——选区若在子会话视图
  就绪，会保持 pending 到下一次主会话提交。若成为实际诉求，修法是把 `editorParts` 并入
  接管分支的 parts（payload 通道已支持）并补 markSelectionSent。
- `local.agent/model` 的既有读取（`:961/:968`）保留——纯读，值不进 payload（I1 由 §4.3 schema 保证）；其前置守卫的两个边界见 §4.4。
- 底部 meta 行的 agent/model 选择器（`:1446-1470`）：接管路径存在时隐藏（全局选择与本次提交无关，显示即误导）。
- **论证**：
  - 前置：接管回调存在 ⇒ 会话是子会话 ⇒ 身份由服务端解析（I1）。
  - 论证：接管分支先于 shell/slash/prompt 三分支 → 后者不可达；payload 无身份字段 → 读取值无处进入请求 → `setAgentModel` 回写不可能发生；未提供回调的路径逐分支不变（I3 同款负例）。
  - 后置：子会话收到 `[Message from user]` + 正文（普通 user 消息，非 synthetic）→ 子转录可见、可被唤醒（运行中入队 / 停止则唤回，H5）。

#### 5.3.5 测试

- 服务端：user 路身份解析（含 `"default"` 折叠）、头行插入顺序、deliverAsync 收到的 sessionID/agent/model/variant 断言；agent 路回归（agent_send/stop 不变形）。
- TUI：子会话提交走 `agentMessage` 且不读 local.agent/model；根会话路径不变负例；选择器隐藏。

## 6. 完整性自检 checklist

- [x] 推导连续：三个 commit 的插入点均给出前置守卫链与落点行号
- [x] 分支覆盖：metadata 有/无、回调消费/未消费、kind 两路、触发三条件
- [x] 退出覆盖：deliver 错误路（AgentNotFound）、HTTP 204/BadRequest、TUI toast
- [x] callee 契约：`deliverAsync`（fork+路由语义）、`createUserMessage`（身份回写）、`collectSubtree`、DialogSelect 按键栈均显式引用
- [x] 循环刻画：collectSubtree 终止性已有既有论证，本子计划无新循环
- [x] 显式假设链：H1-H5 列于 §0.2，各函数论证引用到条目

## 7. 实施顺序与流程绑定

1. 设计确认（本文档）→ **Step 0**：产出 `docs/audits/agentmgmt-1-tui-subagent-surface/expectations.md`（v2 强制，覆盖 §4 三个契约 + I1-I3）
2. commit 1（#39）→ 实现 + 测试 + §5.2 审核 → devlog
3. commit 2（#38）→ 同上
4. commit 3（#37）→ 同上（含 SDK 再生成验证：`bun install --frozen-lockfile` 干净树复跑，防 `.bun` 残留伪回归——CLAUDE.md 已知限制）
5. Step 5 双验证（路径 A 自动检查 + 路径 B subagent 独立审）→ decisions.md
