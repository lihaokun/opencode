# Session 架构

状态：已批准，实施中
所有者：Session 维护者
最后更新：2026-08-06

## 1. 范围

Session 子系统负责把用户输入、provider 流、工具执行和持久化消息组织成可审计的 agent turn。它同时包含：

- legacy runtime：`packages/opencode/src/session/**`；
- current runtime：`packages/core/src/session/**`；
- provider 适配：`packages/opencode/src/session/llm/**` 与 `packages/llm/**`；
- wire schema：`packages/schema/**`；
- CLI/API 观察面：session status、error、message、part 和 current step event。

本架构只规定跨实现必须一致的语义。每项变更的局部状态机、实施边界与测试证据由相应子计划定义。

## 2. 设计原则

1. 持久化记录是审计事实；恢复不得删除或改写失败 attempt。
2. provider request、assistant attempt 与 agent logical step 是三个不同生命周期。
3. 自动恢复必须由本地可证明的副作用状态决定，不能由 transport `retryable` 单独决定。
4. 每次新的 provider request 都使用新的 assistant/summary ID；一个 attempt 最多调用一次 `llm.stream`。
5. 无法证明安全时 fail closed，进入人工停止，不猜测远端或工具副作用。
6. legacy/current 对同一恢复证据给出同一动作，投影语义也保持一致。
7. durable recovery 是审计和投影依据；自动恢复协调器只在当前进程的 active chain 中运行。

## 3. 分层与依赖

```text
packages/schema    wire-safe recovery facts and event/message fields
       ^
packages/llm       provider failure classification
       ^
packages/core      shared pure recovery classifier and current runtime
       ^
packages/opencode  legacy adapter/runtime, projection and callers
```

- `packages/schema` 不依赖 Node/Bun runtime；只定义可序列化结构和稳定标识。
- `packages/llm` 定义 provider 失败分类，但不决定 agent replay。
- `packages/core` 持有共享纯分类器和 retry policy 常量；legacy/current 都必须复用它们。
- caller 负责 assistant 生命周期、等待、状态发布和实际 continuation；分类器不做 I/O。
- projector 只使用已经持久化的 recovery evidence，不能根据当前内存重新推断历史。

## 4. Session turn 模型

一个 logical turn 从一个 parent user message 开始，可以包含多个 provider physical attempts：

```text
logical turn
  assistant attempt 0 -> failed incomplete
  assistant attempt 1 -> failed incomplete
  assistant attempt 2 -> success or terminal stop
```

SafeRetry 是同一 logical step 的新 physical attempt，不重新执行该 step 的一次性 title/summary/task 工作，也不消费 agent step。ContinueAfterSettledTools 是工具结果后的自然下一轮，消费下一 logical step。新 user/steer 输入会终止旧 active recovery chain，并启动正常的新 turn。

“同一上下文”指相同 parent user、相同 logical step，以及排除失败 partial 后等价的 durable history；动态环境、plugin transform 或 provider cache metadata 不要求逐字节相同。

## 5. 不完整 provider stream 恢复边界

子计划 `session-1-incomplete-stream-recovery` 定义三种动作：

- `safe-retry`：失败边界没有任何 tool evidence，且预算未耗尽；
- `continue-after-settled-tools`：存在工具调用，并且每个调用都能证明 input 和 terminal result 已持久化；
- `manual-stop`：存在 pending/running/uncertain side effect、持久化失败、blocked 状态或预算耗尽。

默认 retry limit 为 2，因此最多有原始 attempt 加两个新 attempt。等待使用 2 秒、4 秒指数退避且不含 jitter。普通 API/transport retry 的既有策略不受此预算替代。

## 6. 持久化与投影

每个 incomplete failed assistant 持久化一份带 `classification="incomplete-stream"` 的 recovery snapshot。snapshot 必须在 cleanup 或 fiber tombstone 改变工具状态之前形成，且只把已成功发布/写入的字段标记为 persisted。

模型投影遵循：

- `safe-retry` / `manual-stop`：不投影该失败 assistant 的任何 partial output；
- `continue-after-settled-tools`：只投影 recovery 证明已 settled 的 tool call/result，保持 durable 顺序与配对；
- 失败 attempt 的 prose、reasoning 和 response-level cache metadata 一律不投影；
- 同 provider/model continuation 保留工具协议必需 metadata；跨模型仍走现有 lowering；
- recovery evidence 与 durable content 不一致时必须停止自动恢复。

失败 assistant 本身始终保留在存储/API 中，过滤只发生在 successor model context。

## 7. 状态与事件

- 自动 SafeRetry/Continue 是非 terminal transition；successor 创建前不得发布 terminal session error 或 idle。
- SafeRetry 经过既有 retry status，然后回到 busy；Continue 保持 busy。
- ManualStop 才发布一次 terminal error 并进入 idle。
- current runtime 在失败 attempt 上写 `Step.Failed.recovery`，successor 产生新的 `Step.Started`；不复用 APIError 形状的 `SessionEvent.Retried`。
- clean EOF 但没有 terminal settlement 也属于 incomplete stream，不允许无 `Step.Ended`/`Step.Failed` 地成功返回。

## 8. 并发与故障模型

- 恢复边界以 provider failure 被观察到的时刻为准；当时 pending/running 的 tool 即使随后完成，仍为 ManualStop。
- 一个 observed tool call ID 不会由 recovery 重新发起。Continue 只把已有 settled result 交给下一 provider turn。
- 系统不提供 provider delivery exactly-once；SafeRetry 可能重复计费或重复 provider-side computation。
- plugin transform 内不可见的外部副作用由 plugin 自身保证 retry-safe。
- recovery 写入失败时不得自动 retry/continue，即便完整诊断本身无法持久化。
- 本变更不新增 queue、全局顺序、跨进程锁或进程重启后的自动恢复。

## 9. 子计划登记

| ID                                     | 标题                               | 状态        | 契约文档                                                               |
| -------------------------------------- | ---------------------------------- | ----------- | ---------------------------------------------------------------------- |
| `session-1-incomplete-stream-recovery` | 按副作用状态恢复 incomplete stream | Unit A 完成 | `docs/design/session/subplans/session-1-incomplete-stream-recovery.md` |

## 10. 全局不变量

1. 每个 provider physical attempt 对应唯一 assistant/summary ID。
2. 每个 attempt 最多调用一次 `llm.stream`。
3. 失败 attempt 的 durable audit record 不被自动恢复删除或改写。
4. 没有任何 tool evidence 才能 SafeRetry。
5. 所有工具都拥有 persisted terminal result 才能 ContinueAfterSettledTools。
6. 任一不确定副作用都必须 ManualStop。
7. retry chain 的新 attempt 数不超过共享 limit。
8. 自动 transition 不发布 terminal error/idle；最终成功不会令 headless CLI 因中间失败返回非零。
9. recovery-aware projection 不泄漏失败 prose/reasoning/partial tool data。
10. process restart 后不会仅凭历史 recovery 字段自动发起 provider request。
