# Audit Decisions — `agentmgmt-1-tui-subagent-surface`

> Step 5 路径 B（`audit-report.md`）⚠️ 项与漂移的处置记录。审核结论：critical 0、
> unresolved 0；以下全部为"文档化或收敛"级。

| # | 项（audit-report 引用） | 处置 | 理由 / 落点 |
|---|---|---|---|
| D1 | 端点 404 通道 + BadRequest 经 HTTP 不可达（§3-1） | **文档化** | requireSession 先行与 prompt 端点同形，行为合理；设计文档 §4.3 已修订错误集与可达性说明 |
| D2 | WorkspaceRoutingQuery 未声明（§3-2） | **文档化** | 与既有 session 级端点同构（H4）；§4.3 已补 query 声明 |
| D3 | handler 私有 ops 的 die 语义与"相同切片"表述不准确（§3-3） | **修正注释** | 注释重写：内联构造原因（型变边界）、仅 deliverAsync 被行使、die 分支今日无人可达。收敛为"仅 deliverAsync 的 ops"不可行——AgentPromptOps 类型要求四成员 |
| D4 | 接管分支 SDK 落点在 route + 选区上下文静默丢弃 / markSelectionSent 不执行（§2-41/§3-4） | **文档化 + 记录修法** | 委托 route 与 §4.4/§5.3.3 一致，属契约内部表述不一，已改写 §5.3.4；选区后果 v1 接受（子会话内准备选区上下文是边缘路径），再引入条件已写明（editorParts 并入 + 补 markSelectionSent） |
| D5 | dialog 栈第 4 守卫未声明（§3-5） | **文档化** | §5.2.2 触发条件补记 |
| D6 | 列表第 4 级兜底与描述格式未声明（§3-6） | **文档化** | §5.2.3 行内容描述补全 |
| D7 | openapi.json 混入 #35 事件 schema（§3-7） | **接受 + 记录** | 派生物与源码一致；基线 codegen 滞后的顺带补齐，非本子计划语义变更 |
| D8 | 通知盒/文本盒 id 复用的理论冲突（§3-8） | **接受** | inject 不会产出双形态消息；仅当未来同消息既带 notification metadata 又带非 synthetic 文本才可达，届时改 id 即可 |
| D9 | 通知盒排版细节（§3-9） | **接受** | 排版实现细节，manual-verification 1.5 已有人工视觉检查项 |
| D10 | 测试缺口 1-3：atLive / 触发条件 / 渲染分支（§4） | **维持既有处置** | expectations §7 注 + `prompt-history-bottom.test.tsx` skip 说明已记录阻塞与补齐配方；以 issue 跟踪，不阻断合入 |
| D11 | 测试缺口 4：HTTP 层零覆盖（§4） | **接受 + 跟踪** | handler 逻辑薄（requireSession + 一次 deliver 调用），核心语义已由 inbox 单测与 payload keys 断言覆盖；httpapi-exercise 层补测列入后续 |
| D12 | 测试缺口 5：user 路 sessionID 断言缺失（§4） | **已修** | user 路测试补 `delivered.sessionID` 断言 |
| D13 | inbox.test.ts 单次时序抖动（awaitWithTimeout 超时一次，复跑稳定） | **接受 + 记录** | 并行负载下的轮询超时，非产品缺陷；连续两轮全绿（103/103、19/19） |
| D14 | v1.18.31-fmv3-beta.1 冒烟修正：payload 多余键的运行时语义是**剥离**而非拒绝——`noReply-excess` 返回 204 且 `noReply` 被丢弃（Effect Schema 默认 onExcessProperty=ignore），`missing-parts` 才 400 | **文档化** | "noReply 不可经新端点传入"的保证成立（剥离 = 无法抵达 inbox），但机制与"拒绝"不同；expectations §2 的 keys 断言描述的是 schema 形状。若要响亮拒绝可加 `onExcessProperty: "reject"`（一行），v1 不做——与 API 表面其余端点的剥离语义一致 |

## 退出核对（§6.6）

- [x] expectations 10 节齐备（含实施修订注）
- [x] 路径 A：机械化检查以仓库单测承担——payload keys 断言（inbox.test "accepts exactly the parts field"）、`Step Pn:` grep 全覆盖（P1-P13 各 ≥1 落点）、双侧常量 fixture 测试（subagent-notification.test / lifecycle.test）；专用 contract_audit 脚本 N/A（理由见 expectations Step 5 记录）
- [x] audit-report.md：0 critical / 0 unresolved
- [ ] §5.2 五维度审核：逐 commit devlog 已记录；最终人工验证 `manual-verification.md` 待用户执行回填
