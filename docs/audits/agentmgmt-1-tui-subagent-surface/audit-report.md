# Contract Audit Report — `agentmgmt-1-tui-subagent-surface`

> Step 5 路径 B：独立 subagent 审核（workflow §6.5）。审核者未参与实现，输入限定为
> 契约文档 + 去偏差版 expectations（实现位置列剥离）+ range diff，未读 diff 外实现文件。
> 以下为审核者报告全文（§1-§5），末尾附主 agent 的核对与处置状态（§6）。

审核范围：`git diff bf8ec3d8c0..760c095e62 -- packages/`（#39 `15feed613a`、#38 `418c19ae67` + 测试 `3a68769baf`、#37 `760c095e62`）。行号为 range 末（`760c095e62`）post-image 行号。

## §1 独立 expectations 清单与去偏差版差异

审核者从契约 §0-§7 独立抽出 expectations 后与去偏差版对照：

- 审核者多出：`visible()` 根视图等价性（sanitized 中合并于"主路径不变"）；列表行内容解析链/状态列/缩进/排序细则；"无新 keybinding"；TUI 失败 toast；头行插入位置在 deliver 内。
- 双方一致并经强调：`"agent_notification"` 双处常量（server `schema.ts` + TUI `index.tsx`）为**已声明**的双定义（sanitized §10），但守护仅互指注释 + 两侧 fixture 测试，无机械检查（§4）。

## §2 逐条判定表

| # | expectation | 判定 | 文件:行号 | 依据 |
|---|---|---|---|---|
| 1 | metadata 恰 `{kind, summary}`，措辞 owner 在 server | ✅ | `lifecycle.ts:288-291,319-323` | summary 抽常量后同进 text 与 metadata，三元表达式与基线一字不差 |
| 2 | 无 `state`/`sessionID` 字段 | ✅ | `lifecycle.ts:319-323` | metadata 字面量仅两键 |
| 3 | 通知正文一字不动（I2 server 侧） | ✅ | `lifecycle.ts:313-318` | renderOutput 调用形状未变 |
| 4 | UI 识别仅经 metadata.kind（I2） | ✅ | `routes/session/index.tsx:2750-2759` | `agentNotificationSummary` 只判 metadata.kind，从不读 part.text |
| 5 | summary 原样渲染一行 muted `↳` | ✅ | `routes/session/index.tsx:1408-1424` | textMuted、无拼接改写 |
| 6 | 无 metadata → 现状（兼容负例） | ✅ | `routes/session/index.tsx:1409-1425,2755-2758` | Show 落空即不渲染；非 string summary 返回 undefined |
| 7 | 四处 synthetic 过滤不动 | ✅ | range diff hunk 列表 | 基线 :380/:625/:842/:1347 均不在任何 hunk 内 |
| 8 | file parts 照常渲染 | ✅ | `routes/session/index.tsx:1426+` | files() memo 与渲染块未改 |
| 9 | `atLive() = store.index === 0`，`move` 不动 | ✅ | `prompt/history.tsx:74-76` | 纯 getter；move 无改动 |
| 10 | 触发式位于光标守卫后、move 前 | ✅ | `component/prompt/index.tsx:935`（守卫 :925-932，move :937） | 与契约表达式逐字符一致 |
| 11 | I3：未消费时逐分支与基线等价 | ✅ | `prompt/index.tsx:925-945` | hunk 仅插 3 行；keybind.ts 不在 diff 内 |
| 12 | 成员 = subtree−{root,current}；含孙子 | ✅ | `routes/session/index.tsx:479-482,2775-2793` | collectSubtree + exclude 集；测试覆盖 |
| 13 | 深度缩进 + 直接子优先 + created 排序 | ✅ | `routes/session/index.tsx:2780-2790`；`dialog-subagent-list.tsx:33` | toSorted(depth, created)；缩进 repeat |
| 14 | 行名三级解析链 | ⚠️ | `dialog-subagent-list.tsx:24-27` | 链一致，但第 4 级兜底 `"Subagent"` 与 description 拼接格式契约未列（§3-6） |
| 15 | 状态 = session_status[id]?.type | ✅ | `dialog-subagent-list.tsx:28` | 只读投影 |
| 16 | 选中→enterChild→dialog.clear | ✅ | `dialog-subagent-list.tsx:42-45`；`routes/session/index.tsx:484` | onPick=enterChild |
| 17 | 列表数据源纯函数可测 | ✅ | `routes/session/index.tsx:2775` | 导出 + 同形数组直测 |
| 18 | InboxMessage 联合形状 | ✅ | `schema.ts:210-213` | 与 §4.2 一一对应 |
| 19 | SelfDelivery 仅 agent 路 | ✅ | `inbox.ts:86-88` | kind==="agent" && sender===target |
| 20 | I1：两种 kind 共享同一段身份解析 | ✅ | `inbox.ts:105-112` | 三行位于 kind 分支之后、无条件分流，两路必经 |
| 21 | 身份取值（default 回退 / "default"→undefined） | ✅ | `inbox.ts:107-112` | 与契约逐项一致 |
| 22 | user 路 = 固定头行 + parts 原样 | ✅ | `inbox.ts:54,118-122` | 常量无插值；parts 展开 |
| 23 | 唯一出口 deliverAsync | ✅ | `inbox.ts:131-140` | 单一调用两路共用 |
| 24 | 既有调用点 union 纯增量 | ✅ | `tool/agent.ts:283-295`；`lifecycle.ts:481-491` | 字段逐项未变；全仓 `.deliver(` 恰 3 处 |
| 25 | payload 恰 `{parts}`（pick） | ✅ | `groups/session.ts:71-77` | Schema.Struct；openapi `required+additionalProperties:false` 双锁 |
| 26 | 路径/方法/响应 | ✅ | `groups/session.ts:104,350-364`；`sdk.gen.ts:4114-4151` | 一致 |
| 27 | 错误 = AgentNotFound→BadRequest | ⚠️ | `groups/session.ts:355`；`handlers/session.ts:337-349` | 端点同时声明 404，requireSession 先行 → BadRequest 经 HTTP 不可达；契约只写了 BadRequest（§3-1） |
| 28 | handler 流程 | ✅ | `handlers/session.ts:336-350` | 头行插入留在 deliver 内 |
| 29 | 204=已受理 | ✅ | `handlers/session.ts:350`；`inbox.ts:131-141` | 仅 deliverAsync fork，无等待 |
| 30 | prop 签名 void | ✅ | `prompt/index.tsx:74-82` | 与 void 裁决一致 |
| 31 | 接管分支=模式链第一位 | ✅ | `prompt/index.tsx:1085-1087` | 基线首支降为 else if，其余未动 |
| 32 | local.agent/model 读取保留、值不进请求 | ✅ | `prompt/index.tsx:970-985,1085-1088`；`routes/session/index.tsx:459-471` | 接管支只传 {text, parts} |
| 33 | 共享收尾 | ✅ | `prompt/index.tsx:1151-1166` | tail 顺序未动 |
| 34 | 选择器隐藏 | ✅ | `prompt/index.tsx:1477` | 外层 Show 守卫 |
| 35 | 仅子会话注入回调 | ✅ | `routes/session/index.tsx:1338` | parentID 条件 |
| 36 | 失败→toast | ✅ | `routes/session/index.tsx:463-470` | .catch → toast |
| 37 | `visible()` 根视图等价 | ✅ | `routes/session/index.tsx:226-230` | 去掉项在根视图恒真，no-op |
| 38 | SubagentFooter 保留 | ✅ | range diff（无 hunk） | 未触及 |
| 39 | SDK 生成物一致 | ✅ | `sdk.gen.ts:4114-4151`；`types.gen.ts:10213-10245`；`openapi.json:7175+` | 一致（但生成物混入无关事件 schema，§3-7） |
| 40 | I3-TUI：未提供回调逐分支不变 | ✅ | `prompt/index.tsx:1085+` | 三支内部零改动 |
| 41 | §5.3.4"分支内调 agentMessage"字面机制 | ⚠️ | `prompt/index.tsx:1085-1088` vs `routes/session/index.tsx:459` | 实现为 prop 委托；与 §4.4/§5.3.3 一致、与 §5.3.4 字面冲突（契约内部两处表述不一，§3-4） |

## §3 未声明漂移清单

1. 端点额外声明 404 NotFoundError，requireSession 先行使 deliver 的 BadRequest 经 HTTP 不可达（`groups/session.ts:355`）。
2. 端点接受 WorkspaceRoutingQuery（`groups/session.ts:353`），契约未声明。
3. handler 私有 ops 构造：prompt 经 die 升格 defect、含 deliver 用不到的成员；注释自称"与 agent tool 相同切片"不准确（`handlers/session.ts:66-74`）。
4. 接管分支 SDK 调用落点在 route（§2-41）；连带：子会话视图中 editorParts 不进请求、`editor.markSelectionSent()` 永不执行（选区保持 pending 到下次主会话提交）。
5. `openSubagentList` 的 dialog 栈前置守卫（`routes/session/index.tsx:478`）——契约三条件之外的第 4 守卫，良性。
6. 列表行第 4 级兜底 `"Subagent"` 与 description 拼接格式（`dialog-subagent-list.tsx:27-36`）。
7. openapi.json 混入 `EventAgentDelegation`/`AgentDelegation` 事件 schema——#35 基线 codegen 滞后，本次再生成顺带补上；派生物与源码一致，但本 commit 生成物 diff 不纯属于本子计划。
8. 通知盒与消息文本盒共用 `id={props.message.id}`（`:1412` vs `:1430`）——可达场景不同时渲染无冲突；未来同消息双形态会出现重复 id。
9. 通知盒 `alwaysSeparate` 注册 + marginTop 规则——排版细节，契约只说"独立一行"。

（`runtime.ts`/`permission/index.ts`/`ai-sdk.ts`/`session.ts`/`tree.ts`/`workdir.ts`/`delegation.ts`/`experimental.ts`/`sync.tsx` 等处 hunk 均为纯 formatter 归一，未计入漂移。）

## §4 测试断言质量评估

- 真实断言：payload keys 恰 `["parts"]`（类型层 oracle，配合 openapi additionalProperties:false 双锁 I1）；user 路 agent/model/variant/"default" 折叠/parts 严格相等（本子计划最硬一条）。
- 缺口 1：`atLive` 语义无测试（契约 §5.2.4 要求）；全仓仅定义+一处调用。
- 缺口 2：触发三条件仅 `test.skip` 集成用例（阻塞已诚实记录 + 补齐配方）；"历史未翻完 atLive=false 负例"连 skip 集都没有。
- 缺口 3：通知渲染分支本身无 view-level 断言（仅识别函数单测）。
- 缺口 4：HTTP 层零测试（204/BadRequest/404 映射、requireSession 先行、handler ops）。
- 缺口 5（小）：user 路未断言 deliverAsync 的 sessionID（**审核后已补**，见 §6）；列表 action 无测试。
- 正向：agent 路回归以机械 union 转换保留（断言逐条未变）；负例均为真负例。

## §5 结论

- **critical：0；unresolved：0。** 三个承重不变量 I1/I2/I3 均在 diff 内逐行核实成立。
- 建议 ⚠️ 项全部为"文档化或收敛"级，无阻断（处置见 decisions.md）。

## §6 主 agent 核对与处置状态（审核后回填）

- §2-27 / §3-1 / §3-2：**已文档化**——设计文档 §4.3 修订（404 + query 声明 + BadRequest 可达性说明）。
- §2-41 / §3-4：**已文档化**——设计文档 §5.3.4 改写为 prop 委托表述，并声明编辑器选区后果与再引入条件。
- §3-3：**已修正**——handler ops 注释重写（内联构造原因 + die 语义 + 无人可达）。
- §3-5：**已文档化**——§5.2.2 补第 4 守卫。§3-6：**已文档化**——§5.2.3 补第 4 级兜底与描述格式。
- §3-7：**已记录**——decisions.md（生成物不纯归属，派生物与源码一致）。
- §3-8/§3-9：**接受**——理论/排版级，decisions.md 记录。
- 缺口 5（sessionID 断言）：**已补**——user 路测试新增 `delivered.sessionID` 断言。
- 缺口 1-4：**维持既有处置**——atLive/触发条件/渲染分支的覆盖裁决见 expectations §7 注（skip 阻塞与补齐配方已记录）；HTTP 层覆盖缺口以 issue 跟踪，不阻断合入。
- 单次时序抖动：`inbox.test.ts` 在并行负载下出现过 1 次 awaitWithTimeout 超时，复跑稳定（连续两轮全绿）——记录在案，非产品缺陷。

## §7 发布冒烟（v1.18.31-fmv3-beta.1，linux-x64，审核后补做）

- sha256 与 sha256sums.txt 一致；`--version` = `1.18.31-fmv3-beta.1`；包内嵌 `rg` 可运行
- 隔离 XDG 起 `serve`：`/project`、`/agent` 均 200（JSON）
- **新端点全链路**：`POST /session/{id}/agent-message` → **204**；消息落库为 `[Message from user]` + 正文两个非 synthetic text part
- **D14 修正的实证**：`{"parts":[…],"noReply":true}` → 204 且 noReply 被剥离（未抵达 inbox）；`{"noReply":true}`（缺 parts）→ 400（校验在跑）
- 冒烟事故记录：首次探测全部打在一个 **9 月 17 日的僵尸 opencode 进程**上（占 4921 端口、致新 serve EADDRINUSE、agent-message 落 UI catch-all 返回 HTML）——先核对**监听进程**再信状态码。
