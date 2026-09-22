# Contract Audit Expectations — `agentmgmt-1-tui-subagent-surface`

> Step 0 产出（workflow §6.2）。契约抽取自契约文档，未经现有代码回填。
> 抽取时基线：`dev` @ `bf8ec3d8c0`。

## 1. 契约源（multi-doc）

| 文档                                                                        | 用途                                                                                                                                                      | 相关节        |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `docs/design/agent-management/subplans/agentmgmt-1-tui-subagent-surface.md` | **主契约**（数据结构/接口/流程/论证）                                                                                                                     | §0-§7 全部    |
| issue #37 / #38 / #39                                                       | 需求源（问题定义、范围界定、"待定"决议）                                                                                                                  | 各 issue 正文 |
| `docs/design/agent-management/architecture.md`                              | 所属 feature 的既有架构（身份规则、通知通道归属）                                                                                                         | —             |
| 既有契约（本子计划引用且**不改**）                                          | `AgentInbox.escapeField`/`render` 语义、`deliverAsync` 的 fork+实例路由与 noReply 语义、`collectSubtree`、`createUserMessage` 的 `setAgentModel` 回写规则 | —             |

## 2. Schema 字段（机械化）

| 字段                              | 类型                                                                                  | 契约来源           | 实现位置（计划）                               | 一致性机制                                                                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------- | ------------------ | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| TextPart.metadata.kind            | `"agent_notification"`                                                                | 主契约 §4.1        | server: `lifecycle.inject`；TUI: `UserMessage` | 双侧常量 + §10                                                                                                                          |
| TextPart.metadata.summary         | `string`（预渲染，server 独占措辞）                                                   | 主契约 §4.1        | 同上                                           | TUI 禁止拼接文案（测试断言原样显示）                                                                                                    |
| InboxMessage.kind                 | `"agent" \| "user"`                                                                   | 主契约 §4.2        | server `agent-management/schema.ts`            | server 内部，TUI 不接触                                                                                                                 |
| InboxMessage.message（agent）     | 既有 `AgentMessage` 原形                                                              | 主契约 §4.2        | 同上                                           | 字段不变（回归）                                                                                                                        |
| InboxMessage.message（user）      | `{ target: SessionID; parts: PromptInput["parts"] }`                                  | 主契约 §4.2        | 同上                                           | 无 sender 字段（类型层）                                                                                                                |
| HTTP payload                      | **仅** `{ parts }`                                                                    | 主契约 §4.3/§5.3.2 | `httpapi/groups/session.ts`                    | **负向断言**：payload schema 的 keys 集合恰为 `{"parts"}`，不得含 `agent/model/variant/sessionID/messageID/noReply/tools/system/format` |
| PromptProps.onSubmitUserMessage   | `(input: {text, parts}) => void`（可选；实施裁决：初稿 boolean 返回值无消费者，裁掉） | 主契约 §4.4        | `tui/component/prompt/index.tsx`               | 未提供时路径逐分支不变                                                                                                                  |
| PromptProps.onHistoryNextAtBottom | `() => boolean`（可选）                                                               | 主契约 §5.2.2      | 同上                                           | 未消费（false/undefined）→ 既有 `move()`                                                                                                |
| history.atLive()                  | `() => boolean` = `store.index === 0`                                                 | 主契约 §5.2.1      | `tui/prompt/history.tsx`                       | INV-5                                                                                                                                   |

## 3. 枚举值（机械化）

| 枚举                | 合法集合                                      | 共享常量                                                                   | import 路径                                                 |
| ------------------- | --------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------- |
| InboxMessage.kind   | `"agent"` \| `"user"`                         | server 侧字面量类型                                                        | `@/agent-management/schema`（server 唯一）                  |
| metadata.kind       | `"agent_notification"`                        | **双处常量**（无共享包可 import，SDK metadata 为自由 record 不经 codegen） | server: `agent-management` 常量；TUI: `routes/session` 常量 |
| inject 终态         | `"completed"` \| `"error"`（既有，不变）      | 既有                                                                       | `lifecycle.ts`                                              |
| session_status.type | `idle` \| `busy` \| `retry`（既有，TUI 只读） | SDK `SessionStatus`                                                        | `@opencode-ai/sdk/v2`                                       |

## 4. 流程步骤（机械化）

`# Step Pn:` 注释约定，覆盖下列全部步骤（grep 校验）。

**User 投递管线（commit 3，server）**

- P1 target 查找（失败 → `AgentNotFound` → HTTP BadRequest）
- P2 身份解析自 target（agent 回退 default；variant 折叠 `"default"→undefined`）
- P3 kind 分流：agent → `SelfDelivery` 检查 + `render()`；user → 固定头行 part + 用户 parts 原样
- P4 `ops.deliverAsync`（fork + 实例路由，两种 kind 唯一出口）

**TUI 子会话提交（commit 3）**

- P5 既有前置守卫链不动（disabled / creating / auto / 空输入 / exit-quit / model 读取 / workspace）
- P6 `inputText`/`nonTextParts` 粘贴展开（既有）
- P7 接管分支（模式分支链第一位）：`agentMessage({sessionID, parts})`，payload 无身份字段
- P8 共享收尾（历史 append、清空、`props.onSubmit`）

**down 链式回退（commit 2）**

- P9 既有光标末尾守卫不动
- P10 `atLive() ∧ 空输入 ∧ 回调消费` → 打开列表并 return
- P11 未消费 → 既有 `history.move(1, …)`（live 项 no-op）

**通知渲染（commit 1）**

- P12 `metadata.kind === "agent_notification"` → 渲染一行（summary 原样）
- P13 无 metadata → 现状分支（旧转录不可见，兼容负例）

## 5. 行为契约（语义，人审）

- 委派完成/失败在父会话转录各渲染**一行**提示（completed/error 两态）；取消通知与 `agent_send` 消息保持全文（范围外，不压缩）。
- 四处既有 synthetic 过滤行为不变（转录文本渲染、可见消息定位、undo 聚合、跳转最后一条用户消息）。
- 子会话视图出现输入框；提交后子会话身份（agent/model/variant）不发生任何持久化变化。
- 主会话的提交路径逐分支不变（未提供接管回调时与基线行为等价）。
- 无 subagent 时按 `down` 行为与今天一致（无列表、无 UI）。
- `agent_send` 工具与 stop 通知的投递行为不变形（union 改动为纯增量包裹）。

## 6. 时序/状态契约（人审）

- HTTP 204 = **已受理**，不承诺已持久化/已运行/已应答；投递失败经 `Session.Event.Error` 事件可见。
- 子 agent 运行中收到人消息 → 入队，由既有 #34 `shouldReArm` 机制在轮末捡起（H5，本子计划不重验其内部）；停止/空闲 → 唤回。
- 列表打开后按键归 dialog 栈（既有 DialogSelect 行为），esc 关闭，不残留模式。
- 通知渲染是纯读：不改变消息持久化时序与 loop 唤醒时序。
- 接管分支在共享收尾前返回 → 历史记录与输入清空发生在请求发出之后（与主路径同序）。

## 7. 不变量契约（property-based）

> **框架声明**：仓库未引入 property-based 框架（无 fast-check 等）。按 §6.6 以逐例枚举测试覆盖下列不变量的定义域代表点；引入框架后可无损升级为生成式。

- **INV-1（= I1）**：对任意目标会话，user 路投递时 `deliverAsync` 收到 `agent === target.agent ?? default`、`model === target.model`、`variant === (target.model.variant === "default" ? undefined : target.model.variant)`；且 HTTP payload schema keys 恰为 `{"parts"}`。
- **INV-2（= I2）**：UI 识别仅经 `metadata.kind`——固定 synthetic 正文文本做任意变更的 fixture，渲染结果不变；无 metadata 的 synthetic part 渲染不变（现状）。
- **INV-3（= I3）**：`onHistoryNextAtBottom` 未消费时，任意输入/游标/历史游标状态下按 `down` 的（输入, 游标, index）转移与基线逐分支相等。
- **INV-4**：列表成员恒等于 `collectSubtree(root) − {root, current}`；无重复；含孙子（深度 >1 可达）。
- **INV-5**：对任意 `move` 序列，`atLive() ⇔ store.index === 0`。

> **INV-3 / INV-5 的覆盖方式（commit 2 实施时记录；补偿验证后修订）**：二者属"按键级"行为。
> 初判"无渲染级测试基建"**不成立**——`@opentui/solid` 的 `testRender` / `@opentui/core/testing`
> 的 `createTestRenderer` 可驱动全 App + 真实 keymap。按键级三例已写好（
> `packages/tui/test/cli/tui/prompt-history-bottom.test.tsx`），当前 `test.skip`：全 App
> harness 中会话视图不绘制（stub 投影保真度不足，阻塞点与真实 DB 种子配方见该文件注释）。
> 现状：INV-5 由构造成立（一行 getter）；INV-3 的"未消费落回既有 move()"以代码路径唯一性
> 论证；数据源形状经真实 server（隔离 XDG + bun:sqlite 种子）验证与 INV-4 测试一致。
> 翻转 skip 所需工作 = 补齐会话视图投影保真度，作为 ⚠️ 项记录到 Step 5 的 decisions.md。

## 8. 性能契约（机械化）

**N/A** —— 本子计划无性能诉求契约。列表规模上界为子树会话数（`subagent_depth` ≤ 3），不设时长/规模断言。若实现中发现渲染路径引入超线性扫描，回填本节。

## 9. 安全/副作用契约

- agent 路头行的模型来源字段必经 `escapeField`（既有不变，回归覆盖）；user 路头行为**固定串**，无插值、无转义需求。
- payload 无身份字段 → `createUserMessage` 的 `setAgentModel` 回写在人发消息路径**不可达**（INV-1 覆盖）。
- 子会话永远以自身权限行事（既有）；新端点鉴权与既有 session 级端点同层（H4），不新增 per-session 鉴权。
- noReply 洞收口：payload 仅 parts，`noReply` 不可经新端点传入（消息沉底不唤醒的语义不可达）。
- 不修改用户配置、无新增网络出口、无 stdout 敏感信息新面。

## 10. 跨实现一致性

| 项                                             | 机制                                                                                                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `"agent_notification"` 字面量（server ↔ TUI） | 双处常量 + 双侧 fixture 测试各断言本侧字面量；权威值以本文件 §2 为准（无共享包可 import，SDK metadata 为自由 record 不经 codegen——显式记录双定义事实） |
| summary 措辞                                   | owner = server（`inject()` 既有三元表达式）；TUI 渲染测试断言**原样显示**，禁止 UI 拼接                                                                |
| `renderOutput` 文本                            | 保持纯模型面向；TUI 零解析（INV-2 回归）                                                                                                               |
| SDK 再生成                                     | `httpapi-codegen` 链；干净树 + `bun install --frozen-lockfile` 复跑（防 `.bun` 残留伪回归，CLAUDE.md 已知限制）                                        |
| 头行 `[Message from user]`                     | server 侧常量；TUI 测试经 transcript fixture 断言显示（不 import server 常量）                                                                         |

## Step 5 验证记录（实施后回填）

- [ ] 手动验证清单 `manual-verification.md`（按键级/视觉级缺口的人工闭环，三 commit 合入后执行）
- [ ] 路径 A：本仓库未自备 `scripts/contract_audit` 专用脚本；§2/§3/§4 的机械化检查以**仓库单测**承担（schema keys 集合断言、`# Step Pn:` grep、双侧常量断言），逐项回填测试名。专用脚本化仍 N/A——理由：单子计划成本 > 收益，跟踪至第二个子计划复用时再评估。
- [ ] 路径 B：subagent 独立审（按 `templates/contract-audit/subagent-prompt-template.md`；该模板目录在本仓库尚不存在时按 §6.3 十节结构自述）
- [ ] `audit-report.md` 0 critical / unresolved
- [ ] §5.2 五维度审核通过
