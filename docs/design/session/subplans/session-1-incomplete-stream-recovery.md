# 详细设计 — Session 1：Incomplete Stream Recovery

状态：已批准；Unit A 完成，等待 Unit B
修复依据：`docs/fixes/session-fix-incomplete-stream-recovery.md`
主架构：`docs/design/session/architecture.md`
审计预期：`docs/audits/session-1-incomplete-stream-recovery/expectations.md`

## 1. 目标与非目标

### 1.1 目标

当 provider stream 没有可靠 terminal finish 时，用持久化的工具副作用证据决定动作：无工具证据时以新 assistant attempt 有界重试；所有工具已结算时以新 assistant 继续下一轮；其余情况人工停止。legacy/current、普通 prompt、structured output、Task/subagent 和 legacy compaction 必须遵守同一语义。

### 1.2 非目标

- 不为普通 transport/API error 重写既有 retry policy；
- 不保证 provider request exactly-once，也不消除重复计费；
- 不推断 provider 内部或 plugin transform 内不可见的副作用；
- 不实现 process restart/crash 后的自动恢复；
- 不新增用户配置、queue、全局协调器或 watchdog；
- 不改变工具本身的幂等契约。

## 2. 术语

- **logical turn**：同一 parent user input 驱动的一条 active agent 链。
- **logical step**：一次 agent 决策轮；SafeRetry 不消费它，settled-tool continuation 消费下一步。
- **attempt**：一次带唯一 assistant/summary ID 的 provider physical request。
- **incomplete boundary**：adapter 观察到 raw-missing terminal、provider incomplete error，或 current clean EOF 无 terminal settlement 的时刻。
- **tool evidence**：在 boundary 前从 durable part/event 得到的 call/input/execution/terminal-result 事实。
- **settled tool**：complete call + persisted input + provider 已执行 + terminal state + persisted terminal payload。

## 3. Wire contract

### 3.1 Recovery record

```text
IncompleteStreamRecovery {
  classification: incomplete-stream
  action: safe-retry | continue-after-settled-tools | manual-stop
  reason: no-tool-evidence | settled-tools | uncertain-side-effect |
          retry-exhausted | blocked | persistence-failure
  tools: ToolEvidence[]
  retry: { attempt: NonNegativeInt, limit: NonNegativeInt }
}

ToolEvidence {
  id: string
  name: string
  state: pending | running | completed | error
  completeCall: boolean
  inputPersisted: boolean
  providerExecuted: boolean
  terminalResultPersisted: boolean
  interrupted: boolean
}
```

`terminalResultPersisted` 表示 durable terminal payload 存在；payload 可以是 structured/content/error，不要求 raw provider `result` 字段非空。

### 3.2 Stable identifiers

Schema annotations 使用：

- `Session.IncompleteStreamRecovery.Classification`
- `Session.IncompleteStreamRecovery.Action`
- `Session.IncompleteStreamRecovery.Reason`
- `Session.IncompleteStreamRecovery.ToolState`
- `Session.IncompleteStreamRecovery.ToolEvidence`
- `Session.IncompleteStreamRecovery.Retry`
- `Session.IncompleteStreamRecovery`

Recovery 作为 optional field 加到 legacy/current assistant message，并加到 current `Step.Failed`。旧数据省略该字段时仍可解码。

### 3.3 Structural and semantic invariants

1. `classification` 恒为 `incomplete-stream`。
2. `attempt <= limit`；原始 attempt 为 0。
3. `tools[].id` 在一个 snapshot 内唯一，且 id/name 非空。
4. `state=completed|error` 才是 terminal；`pending|running` 不是 terminal。
5. `terminalResultPersisted` 蕴含 complete call、persisted input、provider executed 和 terminal state。
6. `safe-retry` 必须 `tools.length=0 && attempt<limit`，reason 为 `no-tool-evidence`。
7. `continue-after-settled-tools` 必须 tools 非空且全部 settled，reason 为 `settled-tools`。
8. `manual-stop/retry-exhausted` 必须 tools 为空且 `attempt>=limit`。
9. `manual-stop/blocked` 对应 caller blocked。
10. `manual-stop/persistence-failure` 对应 snapshot/transition persistence failure 或无效证据。
11. 其余带 tool 的 ManualStop 使用 `uncertain-side-effect`。

Schema decoder 负责结构、枚举、整数和非空字符串；共享构造/分类函数负责跨字段语义。runtime 不得手工拼装 recovery record 绕过分类器。

## 4. Pure classifier contract

### 4.1 Input

```text
classify({ attempt, limit, blocked, persistenceFailed, tools })
```

输入是在 incomplete boundary 冻结并归一化的事实，不做 I/O，不读取当前 session。重复 ID、非法 attempt/limit 或违反 tool evidence implication 的输入视为 invalid evidence，保守返回 `manual-stop/persistence-failure`。为保证输出自身仍是合法 wire record，这条 invalid 分支不回显不可信 tools，并把 retry 归一化为满足 `0 <= attempt <= limit` 的值；reason 保留失败性质。

### 4.2 Decision order

```text
invalid evidence         -> ManualStop(persistence-failure)
blocked                  -> ManualStop(blocked)
persistenceFailed        -> ManualStop(persistence-failure)
tools is empty:
  attempt < limit        -> SafeRetry(no-tool-evidence)
  otherwise              -> ManualStop(retry-exhausted)
all tools settled        -> ContinueAfterSettledTools(settled-tools)
otherwise                -> ManualStop(uncertain-side-effect)
```

`blocked`/persistence failure 优先于表面可恢复状态。任何 tool evidence 都排除 SafeRetry；不按 tool 名称建立 replay-safe 白名单。

### 4.3 Shared policy

- `INCOMPLETE_STREAM_RETRY_LIMIT = 2`
- `INCOMPLETE_STREAM_RETRY_INITIAL_DELAY_MS = 2000`
- `INCOMPLETE_STREAM_RETRY_BACKOFF_FACTOR = 2`
- attempt 1 等待 2 秒，attempt 2 等待 4 秒，无 jitter。

该预算只计算新 assistant attempts。普通 provider error 的同-message transport retry 维持既有行为。

## 5. Adapter contract

raw-missing terminal 和能识别为 incomplete 的 generic provider failure 输出 `classification="incomplete-stream"`。adapter 不因此写 `retryable=true`；transport 是否 transient 与 agent replay safety 是独立事实。

high-usage raw-missing 的 step-finish 与 provider-error 保持原子 batch，Session 必须先处理 incomplete recovery，再考虑 compaction 或 structured promotion。

## 6. Legacy runtime contract

### 6.1 Processor

`SessionProcessor` 在 provider incomplete boundary 前冻结 tool evidence，并返回显式 `incomplete-recovery` transition，绑定 failed assistant ID。cleanup 不能把 boundary 时的 pending/running 改写为 settled evidence。

- SafeRetry：持久化 failed assistant recovery，设 retry status；不发布 terminal error/idle。
- Continue：持久化 recovery，保持 busy；不发布 terminal error/idle。
- ManualStop：持久化 recovery，发布一次 terminal error并 idle。
- incomplete 不进入现有 `Effect.retry`；现有普通 APIError retry 不变。

### 6.2 Prompt caller

只有创建该 failed assistant 的 active loop 可以消费 transition 一次：

- SafeRetry 等待共享 backoff，以新 assistant ID 重放同一 logical step；不重跑 step-1 title/summary/task 一次性工作；
- Continue 以新 assistant ID 和下一 logical step 投影 settled tools；
- 新 user/steer 抢占时结束旧 chain；
- 历史加载发现 recovery 字段不能自行启动工作；
- `continue_loop_on_deny` 的既有 blocked 语义保持不变。

### 6.3 Compaction

compaction 使用独立的 bounded outer attempt loop和新 summary ID。它的 tools 始终为空，因此只有 SafeRetry/ManualStop。failed partial summary 留作审计但不投影；只有成功 summary 才发布 Compacted。ManualStop 返回 `stop`，不实施 restart recovery。

## 7. Current runtime contract

publisher 在持久发布 input/result/terminal event 后才设置对应 persisted bits，并在 cleanup/fiber tombstone 前冻结 snapshot。每个 turn attempt 只调用一次 `llm.stream`。

provider error 或 clean EOF 无 settlement 时：

- 写 failed assistant recovery 和 `Step.Failed.recovery`；
- runner 根据同一分类结果建立新 assistant attempt或停止；
- SafeRetry 不消费 logical step，Continue 消费下一 step；
- successor 用新的 `Step.Started`；不使用 `SessionEvent.Retried`；
- 只在 process-local active drain 中自动执行，重启后不恢复。

hosted tool 在 provider 未返回 terminal payload 时是 uncertain，即使 call/input 已发布，也必须 ManualStop。

## 8. Recovery-aware projection

legacy `MessageV2.toModelMessages` 和 current `to-llm-message` 共享以下 contract：

1. SafeRetry/ManualStop 跳过整个 failed attempt。
2. Continue 只保留 recovery 列出的 settled tool call/result。
3. 保持 durable 顺序、call/result 配对和同 provider/model 所需 tool metadata。
4. 排除 failed prose、reasoning、partial/pending tools 和 response cache metadata。
5. evidence 与 durable part/event 不一致时抛出 projection failure，转 ManualStop；不得降级为 replay。
6. 旧的普通 failed assistant（无 recovery）保持既有过滤行为。

## 9. 状态、CLI 与外部观察

中间自动恢复不发布 terminal `Session.Event.Error`，也不进入 idle。这样 CLI event loop 不会提前退出，并且最终成功时 exit code 保持 0。最后 ManualStop 发布一次错误、包含工具 id/name/state 的诊断，并令 CLI 非零退出。

usage/cost 保留在各 attempt 的 durable record 中；successor context 不复用 failed response-level cache metadata。StructuredOutput 只提升成功 attempt 的输出，不能由 failed partial promotion。

## 10. 分布式接口契约

| 项目           | 契约                                                                                |
| -------------- | ----------------------------------------------------------------------------------- |
| 连接模型       | 每个 successor 再调用一次 `llm.stream(request)`，形成新 logical provider stream     |
| physical pool  | provider SDK 是否复用连接未知，不作为正确性前提                                     |
| timeout        | 继承现有 request/tool timeout，不新增 recovery watchdog                             |
| retry/delivery | 一个 logical turn 1–3 次 request；远端可能收到 0–3 次；不保证 exactly-once          |
| idempotency    | 本地 observed tool call ID 不由 recovery 重执行；provider-side computation 可能重复 |
| ordering       | 仅保证一个 active chain 内 durable 顺序；不提供跨 session/global ordering           |
| backpressure   | 不新增 queue；attempt 达 limit 后拒绝继续并 ManualStop                              |

## 11. 实施单元与 gates

### Unit A — Contracts and shared decision core（2026-08-06 完成）

- 架构、子计划、expectations 在代码前完成；
- schema、provider classification、纯 classifier、policy constants；
- schema compatibility、table/property tests；
- gate：schema/llm/core targeted tests 与 typecheck 全绿；停止并汇报。

### Unit B — Legacy runtime

- adapter、processor、Prompt、compaction、legacy projection、CLI semantics；
- gate：targeted regressions、新 ID/预算/状态时序/summary/structured 测试全绿；停止并汇报。

### Unit C — Current runtime and convergence

- current publisher/runner/projection、clean EOF、hosted tools；
- legacy/current equivalence、全量相关测试、文档同步和独立 audit；
- gate：expectations 全部 evidence-backed，warnings/decisions 闭环。

除非用户批准，不跨过单元 gate。

## 12. Test contract

- shared classifier：完整决策表、非法证据和 limit/backoff；
- property tests：SafeRetry 永远 tools 为空且预算内；Continue 永远 tools 非空且全部 settled；其他输入不得产生这两种动作；
- schema：optional omission、round-trip、stable identifiers、legacy/current message 和 Step.Failed compatibility；
- legacy：无工具新 ID retry、2 次上限、settled tools 不重执行、不确定工具 ManualStop、状态/CLI 时序；
- compaction：new summary ID、partial 隔离、成功才 Compacted；
- current：provider error/clean EOF、hosted local/provider tools、一个 stream/attempt；
- projection：Safe/Manual 全跳过、Continue 只投影 settled tools、mismatch fail closed；
- structured/usage：失败 partial 不 promotion、不先 compaction，attempt usage/cost 可审计。

## 13. 正确性不变量

1. `assistant_attempt_id` 在 chain 内唯一。
2. 每个 attempt 的 `llm.stream` 调用数小于等于 1。
3. failed attempt durable record 不被删除或重写为成功。
4. SafeRetry 的 tool evidence 数恒为 0。
5. Continue 的每个 tool 都有 complete call、persisted input、provider execution 和 persisted terminal payload。
6. pending/running/interrupted/missing payload 任一存在即不自动 continuation。
7. snapshot 使用 failure boundary 状态，不使用 cleanup 后状态。
8. 新 retry attempt 数不超过 2。
9. SafeRetry 不消费 logical step，不重跑 step-1 一次性工作。
10. Continue 不重执行已 settled tool call。
11. successor context 不含 failed prose/reasoning/partial tool。
12. intermediate recovery 不 terminalize session。
13. ManualStop 最多发布一次 terminal session error。
14. structured/compaction success 只来自 terminally successful attempt。
15. process restart 不从 recovery 字段自动发起请求。
