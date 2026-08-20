# Issue #7 修正方案：Legacy incomplete stream 同 assistant 回滚重试

> 状态：修正方案与编码前契约已确认；两个 incomplete entry、独立预算、retry fences、same-assistant rollback 与 attempt-local summary deferral 已实施并验证；observability 与跨层回归待完成
> 日期：2026-08-19
> Issue：[#7 — Incomplete provider stream 应按副作用状态恢复](https://github.com/lihaokun/opencode/issues/7)
> 分析基线：`48cffdff0f83387b5ac82dafc59603b4fa2e9461`
> 分支：`incomplete-stream-retry`
> 问题分类：算法 / 内部控制流错误（Legacy Session recovery 逻辑缺失）；不改变 public interface 或模块划分。本文确认后先同步既有契约文档，再按 §7 实施。

---

## 结论摘要

本修复把一次逻辑 assistant 执行中的 provider 请求视为多个可能的 physical attempts。在可安全重放时，processor 复用同一个 assistant，先撤销当前 physical attempt 对 authoritative transcript 的物化结果，再发起下一次 provider 请求。

incomplete recovery 只有两个入口：

1. normalized `provider-error` 明确携带 `classification = "incomplete-stream"`；
2. stream 正常、干净地 EOF，但没有可信 terminal evidence，且不是 blocked、compaction 或 interrupt 等有意结束。

任意异常都不能因为之前已产生 text、reasoning 或其它 response output 就自动变成 incomplete。adapter 异常、stream source 异常、认证失败、context overflow、rate limit、普通 transport/API error、request preparation 失败、plugin 失败及其它本地失败，继续使用既有 `MessageV2.fromError` 与 `SessionRetry` 分类和终止语义；它们不消耗 incomplete 专用预算。

```text
physical attempt 结束
│
├─ 已有 assistant terminal error
│    → 保留既有 error 与 finish
│    → 不 replay
│
├─ blocked / compaction / interrupt
│    → 保持既有流程
│    → 不判定为 incomplete
│
├─ 显式 normalized incomplete-stream provider error
│    → 进入 processor-private incomplete decision
│
├─ 正常 clean EOF 且无 trusted terminal evidence
│    → 进入 processor-private incomplete decision
│
├─ 其它 error / exception
│    → MessageV2.fromError + SessionRetry 既有路径
│    → 不消耗 incomplete 专用预算
│
└─ trusted terminal success
     → 保持既有成功流程

processor-private incomplete decision / ordinary retry decision
│
├─ 已实际调用 registered experimental.text.complete handler
│    → replay fence：保留当前 attempt，按当前错误/结束语义停止
│
├─ 已观察任一 normalized tool event
│    → replay fence：保留当前 attempt，按当前错误/结束语义停止
│
├─ assistant 已有 terminal error
│    → replay fence：保留当前 error、finish 与 parts
│
├─ incomplete 专用预算耗尽（仅 incomplete decision）
│    → 保留最后一次 physical attempt
│    → 使用既有详细 final error / finish 语义
│
└─ 允许 replay
     → 删除本 attempt 创建的 authoritative parts
     → 恢复 assistant finish / cost / tokens checkpoint
     → rollback preparation 全部成功后才可发下一 request
     → rollback preparation 任一步失败则 schedule 失败并 fail closed
```

## Rollback 语义边界

本文中的 rollback 是 authoritative session transcript rollback，不是“所有输出渠道都仿佛从未观察到 failed attempt”的历史不可见性保证：

- authoritative DB / session history：rollback 成功后删除当前 physical attempt 的 rollback-eligible parts；后续 history、compaction、summary 与模型输入只基于 retained attempt；
- removal-aware projection / client：通过既有 `message.part.removed` / `PartRemoved` 收敛到 retained attempt；
- append-only 或不支持 removal 的 output surface：可以先观察 failed partial，随后再观察 retained retry output。

这种 transient 双重观察是现有 output 能力边界，不构成 authoritative rollback failure。单纯持久化、发布或观察到模型生成的 text、reasoning、step part 不建立 replay fence。

## 核心约束

1. incomplete 后不执行模型 continuation；
2. 不创建新 assistant，不创建新 user message；
3. 不修改 `prompt.ts`；
4. incomplete 只有两个入口；
5. 所有其它错误保留既有 `MessageV2.fromError` / `SessionRetry` 行为；
6. public `UnknownError` 不变为 retryable；
7. actual `experimental.text.complete` invocation 是 replay fence；
8. 任一 normalized tool event 是 replay fence；
9. existing assistant terminal error 是 replay fence；
10. 所有 provider replay 都受上述 fences 约束，包括 ordinary retry；
11. retry 复用既有 delay/status；
12. incomplete 独立最多 retry 两次，共最多三个 incomplete physical attempts；
13. retry 前删除当前 attempt 的 authoritative parts；
14. retry 前恢复 assistant `finish`、`cost`、`tokens`；
15. rollback preparation 失败则不发下一 request；
16. retained partial tool attempt 由既有 cleanup 终结 pending/running tool state；
17. rolled-back attempt 从未启动自己的 processor summary；
18. summary 只做 rollback safety 所需的 attempt-local 延迟；rolled-back attempt 丢弃，retained attempt 由 process finalizer 在 cleanup body 前释放，不增加全局 gate；
19. authoritative/removal-aware state 收敛，append-only output 可以保留 transient failed output；
20. 不修改 production consumer、TUI、runtime、output 或 transport。

## 范围内

- shared provider failure classification 增加 `incomplete-stream`；
- AI SDK canonical missing-finish 附 stable classification；
- Legacy processor 的两个 incomplete entry；
- same-assistant physical-attempt checkpoint；
- creation-time part tracking 与 authoritative rollback；
- actual plugin invocation、normalized tool activity、assistant terminal error fences；
- incomplete 独立预算；
- ordinary retry 在适用时的 rollback-before-replay；
- 精确 final error/finish；
- attempt-local processor summary deferral；
- retained partial tool attempt 的既有 cleanup 契约；
- authoritative/removal-aware/append-only observability 契约；
- focused Legacy tests 与契约文档同步。

## 明确不在范围内

- V2 代码和测试；
- Prompt loop continuation；
- 新 assistant / message ID；
- public error schema 或 retryable public unknown error；
- broad provider/local error provenance wrappers；
- 基于 response progress 的异常重分类；
- plugin purity/idempotency contract；
- request-hook 或 tool-runtime instrumentation；
- Snapshot 全局恢复；
- generalized transactional rollback；
- production consumer retroactive deletion；
- final retained attempt 专用 summary gate；
- summary 全局稳定性隔离、额外 coalescing、cleanup/interrupt suppression。

---

# 第一部分：现象与复现

## 1.1 当前用户可见现象

Issue #3 已把“不完整 provider stream 被误报为成功”修正为 fail closed：缺少可信 terminal evidence 时，Legacy assistant 持久化 error 并停止。

当前主路径位于：

- `packages/opencode/src/session/llm/ai-sdk.ts`：把 canonical missing raw finish 映射为 `provider-error`；
- `packages/opencode/src/session/processor.ts`：消费 normalized events、settle stream、套用 `SessionRetry.policy()`；
- `packages/opencode/src/session/retry.ts`：判断 ordinary API/rate-limit/transport error 是否可重试；
- `packages/opencode/src/session/message-v2.ts`：把 ordinary thrown error 转为 Legacy assistant error。

现状存在两个相反问题：

1. canonical incomplete 和 qualifying clean EOF 即使没有任何 replay fence，也直接停止；
2. ordinary retryable stream error 可能在同 assistant 内重跑，但不删除前一次 physical attempt 已物化的 partial parts。

修复必须同时避免第三个问题：不能因为异常发生前已有 response output，就把 arbitrary exception 转换成 incomplete。

## 1.2 最小复现 A：显式 normalized incomplete

前提：AI SDK adapter 收到 canonical missing raw finish，并产生详细 `provider-error`：

```ts
{
  classification: "incomplete-stream",
  message: "<existing detailed provider message>"
}
```

physical attempt 1：

1. provider 输出 partial text；
2. adapter 产生上述 normalized error；
3. 没有 plugin invocation、tool event 或既有 assistant terminal error；
4. rollback preparation 成功。

期望：

- processor 将 classification 转成 processor-private incomplete control；
- attempt 1 创建的 authoritative parts 被删除；
- assistant 的 `finish`、`cost`、`tokens` 恢复；
- retry 仍使用同一个 assistant ID；
- incomplete 专用计数增加一次；
- provider request 2 才会发出；
- request 2 成功时 authoritative transcript 最终只包含 retained attempt；
- append-only observer 可以已经看到 attempt 1 partial 和 attempt 2 结果。

## 1.3 最小复现 B：normal clean EOF，无 terminal evidence

事件序列：

```text
step-start
text-start(id="t1")
text-delta("partial-A")
text-end(id="t1")
EOF
// 没有 throw，也没有 trusted terminal finish
```

同时满足：

- 不是 permission/question blocked；
- 不是 compaction cutoff；
- 不是 interrupt；
- 没有 existing assistant terminal error；
- 没有 replay fence。

期望：进入与显式 incomplete 相同的 processor-private retry decision，但最终错误文案和 finish 仍由 clean EOF 的既有 settle 分支决定，而不是改成统一的新文案。

## 1.4 最小复现 C：arbitrary post-output exception 保持 ordinary error

physical attempt 已输出 partial text，之后发生以下任一异常：

- adapter 或 stream source 抛错；
- auth、rate limit、context overflow 或普通 transport/API error；
- request preparation 失败；
- plugin callback 抛错；
- persistence、event handling 或其它 processor 本地操作失败。

期望：

- “已经产生 partial”不改变错误类别；
- 错误继续经过既有 `MessageV2.fromError` 与 `SessionRetry`；
- 既有策略认为不可 retry 时，保留既有终止行为；
- 既有策略认为可 retry 时，仍需通过 plugin/tool/terminal-error fences，并在适用时先 rollback 当前 physical attempt；
- 不增加 incomplete 专用计数；
- 不把 public `UnknownError` 改成 retryable。

## 1.5 最小复现 D：actual text-complete invocation fence

registered `experimental.text.complete` handler 在 `text-end` 的既有时点被实际调用。processor 必须在首个 matching handler callback 开始前设置 process-local monotonic fence。

无论 callback：

- 成功并变换 `output.text`；
- 产生外部副作用后成功；
- 产生外部副作用后抛错；
- 从业务角度看似纯函数；

后续 incomplete 或 ordinary retryable error 都不得 replay provider request。

仅“注册了 handler”不构成 fence；只有实际调用才构成。matching handler 不存在，或错误发生在 callback 尚未开始之前，不得误置该 fence。

## 1.6 最小复现 E：normalized tool event fence

以下任一 normalized event 一经观察就建立 process-local monotonic fence：

- `tool-input-start`；
- `tool-input-delta`；
- `tool-input-end`；
- `tool-call`；
- `tool-result`；
- `tool-error`。

事件不必组成完整 tool call；孤立 delta/end/result/error 也必须先建立 fence，再执行现有事件处理。

若随后出现 incomplete 或 ordinary retryable error：

- 不 rollback 当前 attempt；
- 不发下一 provider request；
- 保留当前 authoritative parts；
- 既有 cleanup 必须把 retained attempt 中 pending/running tool part 终结为 aborted/error，例如 `Tool execution aborted`，不得永久保持 pending；
- 不新增 request-hook 或 tool-runtime instrumentation。

## 1.7 最小复现 F：assistant terminal-error fence

如果当前 assistant 已有 terminal error，例如 output-length 分支已持久化错误，之后又出现 incomplete 或 ordinary retryable error：

- 不清除或替换既有 error；
- 不修改其既有 finish；
- 不 rollback parts；
- 不 replay；
- 不重复发布 terminal error。

assistant error 不属于 rollback checkpoint。

## 1.8 最小复现 G：预算耗尽

连续三个 physical attempts 都以可安全 replay 的 incomplete 结束：

1. initial attempt：rollback 后进入 retry 1；
2. retry 1：rollback 后进入 retry 2；
3. retry 2：预算耗尽，保留该 attempt 并停止。

期望：

- provider request 总数严格为 3；
- 不存在第 4 次 request；
- 前两次 attempt 的 authoritative parts 已删除；
- 第三次 partial 保留；
- append-only surface 可以观察三次输出；
- ordinary retry 次数不占用这两个 incomplete retry 名额。

## 1.9 最小复现 H：精确 final error / finish

### 1.9.1 unsettled clean EOF exhaustion

最后一次 clean EOF 没有 credible step settlement 时：

- 选择现有 `UNSETTLED_STEP_MESSAGE`；
- `finish = "error"`；
- 不替换为 generic incomplete 文案。

### 1.9.2 credible empty-unknown clean EOF exhaustion

最后一次 clean EOF 已有 credible `step-finish(reason="unknown")`，但没有 usable output 时：

- 选择现有 `EMPTY_UNKNOWN_MESSAGE`；
- 保留 `finish = "unknown"`；
- 不错误提升为 `finish = "error"`。

### 1.9.3 canonical missing-finish exhaustion

最后一次是 adapter 明确分类的 canonical missing-finish 时：

- 保留现有 provider detailed message；
- `finish = "unknown"`；
- 不改写为 clean EOF 文案。

### 1.9.3 existing terminal error

assistant 在 retry decision 前已有 terminal error 时：

- error 原样保留；
- finish 原样保留；
- incomplete recovery 不覆盖它们。

## 1.10 最小复现 I：rollback preparation failure

在真正发起下一 provider request 前，rollback preparation 中任一步失败，例如 part removal 或 assistant checkpoint restore 失败。

期望：

- retry schedule 直接失败；
- 不发下一 provider request；
- flow fail closed；
- 不引入额外状态机、reconciliation 或恢复协议；
- 本设计只承诺“失败后不 replay”，不扩展为新的事务性 rollback 系统。

## 1.11 最小复现 J：rolled-back attempt 不启动 processor summary

同一 physical attempt 中先观察 `step-finish`，之后才确认 incomplete 且允许 retry。

期望：

- `step-finish` 时不立即启动该 attempt 的 processor summary；
- retry decision 确认 rollback 后，丢弃该 attempt 延迟的 summary 启动；
- 该 attempt summary call count 为 0；
- retained attempt 由 process finalizer 在 existing cleanup body 开始前按 processor 既有数量和顺序释放自己的延迟启动；
- normal/error/interrupt 均有同一确定 release path；不等待 cleanup 完成，不新增 global gate 或 suppression，也不改变 `summary.ts`。

## 1.12 最小复现 K：visibility 分层

一次 safe retry 中，attempt 1 发布 partial，随后 rollback；attempt 2 成功。

期望：

- authoritative DB/materialized session history 最终只含 retained attempt；
- 应用既有 removal events 的 projection/client 最终只含 retained attempt；
- append-only stdout、日志或其它不支持 removal 的 surface 可以保留 attempt 1 transient output；
- 已发布 model output 本身不构成 replay fence；
- 本 Issue 不修改任何生产 consumer、TUI、runtime、output 或 transport。

## 1.13 影响范围

直接影响：

- Legacy interactive/headless session；
- shared provider failure classification；
- AI SDK canonical missing-finish mapping；
- Legacy processor attempt bookkeeping、settle、retry preparation 与 summary launch；
- Legacy retry gate；
- authoritative DB/history 与 removal-aware projection 的最终状态；
- append-only surface 的文档化 observability；
- Legacy tests 和相关行为契约。

不直接影响：

- V2 SessionRunner、schema、projection；
- public plugin hook API；
- tool runtime；
- production consumers/transports；
- public API error union。

---

# 第二部分：根因分析

## 2.1 根因一：canonical incomplete 缺少 stable classification

AI SDK adapter 能识别一种 missing raw finish，但如果只提供 message，processor 只能依赖文案匹配。修复需要 normalized provider failure classification：

```text
classification = "incomplete-stream"
```

该字段只表达已确认的 canonical missing-finish 协议事实，不是 public assistant error。

## 2.2 根因二：缺少可判定的 incomplete 边界

“stream 没有完整 terminal evidence”与“stream/processor 抛出任意错误”是不同事实。前者可以是协议层 incomplete；后者必须保留原始错误类别，否则会产生：

1. auth、rate limit、context overflow 等既有 error 被错误改写；
2. plugin 或 persistence 失败被误当成 provider 可 replay；
3. ordinary retry 与 incomplete 专用预算互相污染。

正确边界只能由两个明确入口组成：adapter stable classification，以及无异常的 clean EOF 缺少 trusted terminal evidence。response output 是否已经出现不是分类依据。

## 2.3 根因三：logical assistant 与 physical attempt 状态混在一起

Legacy processor 以同一个 assistant 承载一次逻辑执行，但没有把每次 provider request 创建的物化 parts 与 assistant aggregate 字段作为 attempt-local delta 管理。直接重试会造成：

- old partial text/reasoning 与新输出拼接；
- step/patch/tool parts 遗留；
- `finish`、`cost`、`tokens` 重复累计或与最终 parts 不一致。

需要轻量 physical-attempt checkpoint，而不是新 assistant 或 Prompt continuation。

## 2.4 根因四：retry safety 不能只看 provider error 是否 retryable

provider request replay 可能重复外部副作用。processor 当前能直接观察到的可靠 hard evidence 只有：

- matching `experimental.text.complete` handler 实际开始调用；
- normalized tool event 已进入 processor；
- assistant terminal error 已持久化。

这些 evidence 一旦出现，在整个 `process()` 生命周期内必须单调保持。仅注册 callback、仅发布 model text/reasoning/step、仅被 consumer 观察都不是副作用证据。

本修复不推断 plugin purity、tool idempotency，也不向 request hook 或 tool runtime 增加 instrumentation。

## 2.5 根因五：retry 前缺少 authoritative rollback preparation

same-assistant replay 若不先删除本 physical attempt 创建的 parts，authoritative transcript 会把多个 attempts 当成一段连续模型输出。rollback 必须是发下一 request 的 preparation：

1. 验证 replay fences；
2. 删除 attempt 创建的 parts；
3. 恢复 assistant `finish`、`cost`、`tokens`；
4. preparation 成功后才允许 retry schedule 继续。

若任一步失败，最重要的安全性质是不得发下一 request。无需扩展新的持久化事务协议。

## 2.6 根因六：incomplete 需要独立预算

ordinary `SessionRetry` 已有自己的 retryability、delay formula 与 status 语义；本 Issue 不改变这些函数。但 incomplete 往往发生在 response 已开始之后，每次重放都会重新消耗 provider 资源并产生 transient output。

因此 incomplete 独立最多允许两次 retry：initial attempt + retry 1 + retry 2，连续 incomplete 总 physical requests 上限为 3。ordinary retry 不消耗该预算；existing schedule `meta.attempt` 仍作为跨错误类别的 physical replay ordinal，不为 incomplete/ordinary 分别重置。

## 2.7 根因七：transient incomplete 与 committed terminal error 边界不完整

如果 processor 在 retry decision 前已经持久化 `assistantMessage.error` 并发布 terminal error event，则同 assistant retry 无法透明撤回该结果。

正确顺序是：

```text
检测 incomplete
→ processor-private control
→ replay decision
   ├─ retry：先 rollback，不写 terminal error
   └─ retain：按来源落地现有 final error / finish
```

反方向也成立：existing assistant error 是 replay fence，不进入 checkpoint，不为 retry 清除。

## 2.8 根因八：summary 启动早于 attempt 是否 retained 的判定

`step-finish` 发生时，processor 尚不知道当前 physical attempt 最终会 retained 还是 rollback。立即 fork summary 会使随后被删除的 attempt 仍产生后台派生工作。

所需修正很窄：把 processor 在 `step-finish` 的 summary 启动延迟到当前 attempt 的 retry decision 已知；rollback 时丢弃，retained 时按现有 processor 语义释放。无需把 summary 移到全局 cleanup 之后，也无需改变其它调用点或 summary 实现。

## 2.9 根因九：authoritative deletion 不等于所有输出历史可擦除

`Session.removePart()` 与 `message.part.removed` 能使 durable materialized state 和 removal-aware projection 收敛，但无法撤回已写入 append-only surface 的 bytes。把 authoritative rollback 描述成所有 observer 从未见过 failed attempt 是不成立的。

正确契约必须区分：

- authoritative materialized transcript；
- removal-aware event projection；
- append-only/non-removal-aware observability。

只需文档和一个 focused observability test，不需要改造生产 consumers。

## 2.10 根因总结

本问题不是通用 error provenance 重构，而是四个局部缺口的组合：

1. incomplete 入口未精确限定；
2. physical attempt materialized delta 未追踪和撤销；
3. provider replay 缺少可靠副作用 fences；
4. processor summary 启动早于 attempt retained/rollback 判定。

因此修复应保持 processor-private、Legacy-only、same-assistant、bounded，并最大限度复用 existing error mapping、retry policy、part removal、cleanup 与 summary API。

---

# 第三部分：参考实现对照

## 3.1 PR #14 / V2 可复用的原则

PR #14 / V2 retry 仅作设计参考，可复用：

1. retry 与 logical continuation 分离；
2. attempt retry 必须有界；
3. side-effect evidence 单调；
4. final failure 保留最后诊断现场；
5. authoritative convergence 不等于 transport invisibility；
6. 无法证明 replay 安全时 fail closed。

不移植 V2 runner、events、message schema、history lowering、compaction 或 request executor。

## 3.2 既有 `MessageV2.fromError` 与 `SessionRetry`

既有路径已经负责：

- provider/API/transport/context 等 ordinary error mapping；
- rate limit、5xx、timeout、structured provider error 等 retryability；
- delay 与 retry status；
- public `UnknownError` 的现有不可 retry 语义。

本修复不替代该体系。除两个 incomplete entry 外，所有错误继续走这条路径。ordinary retry 只新增 replay-safety gate，以及适用时 same-assistant rollback preparation。

## 3.3 AI SDK normalized event 边界

adapter 是 canonical missing raw finish 最接近协议事实的位置。它应在 existing detailed `provider-error` 上增加 stable classification，而不是让 processor 根据异常类型、异常时机或已见 output 猜测 incomplete。

对照结论：

- adapter 只标记已确认的 canonical missing-finish；
- processor 消费 classification，但不加入 public Legacy error union；
- 其它 adapter/source exceptions 原样进入 ordinary error mapping。

## 3.4 既有 `Session.removePart()` 与 removal event

现有 part removal 已提供：

- authoritative part deletion；
- durable `message.part.removed` event；
- removal-aware projector/client 的收敛入口。

本修复应复用它完成 attempt rollback，不新增 storage bypass、consumer-specific cleanup 或 parallel transcript。

## 3.5 plugin 与 tool 的既有执行位置

processor 已知 `experimental.text.complete` 的 actual callback 调用位置，也能观察 normalized tool events。把 fence 放在这些既有边界：

- evidence 可直接判定，不修改 public contract；
- fence 可在 callback/event handler 潜在副作用之前单调置位。

只检查 registration 会误伤从未调用的 handler；只检查成功结果无法覆盖“先副作用后抛错”。因此 actual invocation 前置位是最小正确方案。

## 3.6 Issue #3 基线

Issue #3 的正确基线保持：

```text
缺少可信 terminal evidence
→ 不能当作成功
→ 必须恢复或形成 terminal failure
```

Issue #7 只在 terminal failure 落地前增加受限 recovery，不把 incomplete 解释成成功，也不通过 continuation 掩盖。

## 3.7 对照结论

采用：

- adapter stable classification；
- processor-private incomplete control；
- existing ordinary error/retry classification；
- processor 可观察的 plugin/tool/error fences；
- existing part removal；
- attempt-local assistant checkpoint；
- attempt-local summary launch deferral。

不采用：

- broad error wrappers；
- progress-based exception conversion；
- new public retryable unknown error；
- successor assistant/continuation；
- request-hook/tool-runtime instrumentation；
- production consumer retrofit；
- generalized transactional rollback framework。

---

# 第四部分：修复方案

## 4.1 总体架构

```text
begin physical attempt
  capture assistant checkpoint: finish / cost / tokens
  initialize createdPartIDs
  initialize deferred processor-summary launches for this attempt

consume normalized stream
  on every part creation:
    persist using existing path
    record part ID exactly once

  before actual matching experimental.text.complete callback:
    set process-local plugin replay fence
    invoke callback using existing timing and transformation semantics

  before handling any normalized tool event:
    set process-local tool replay fence
    continue existing event handling

  on step-finish:
    record processor summary launch that would otherwise start now
    do not launch yet

end physical attempt
  if existing assistant terminal error:
    retain attempt and preserve existing error/finish

  else if blocked / compaction / interrupt:
    retain/settle through existing path

  else if explicit classification=incomplete-stream:
    decide processor-private incomplete retry

  else if clean EOF without trusted terminal evidence:
    decide processor-private incomplete retry

  else if ordinary error:
    map with MessageV2.fromError
    decide with existing SessionRetry

  else:
    retain successful attempt

retry / retain decision
  apply plugin/tool/assistant-error fences
  if no retry:
    mark current attempt as retained
    continue existing settle behavior

  if incomplete and incomplete retry count reached 2:
    retain final attempt
    preserve exact existing detailed error/finish branch
    mark current attempt as retained

  if retry allowed:
    run rollback preparation
      remove all created attempt parts
      restore assistant finish/cost/tokens
    if preparation fails:
      fail schedule; no next provider request
    discard rolled-back attempt's deferred processor-summary launches
    update only relevant retry counter
    use existing retry delay/status behavior
    start next provider request with same assistant

process finalizer / existing cleanup
  if final attempt is retained, release its deferred processor-summary launches exactly once
  release occurs at finalizer entry, before existing cleanup body
  interrupt/blocked/compaction/error/success retained exits use the same release path
  rolled-back attempts have no pending launch to release
```

## 4.2 stable incomplete classification

### 4.2.1 LLM schema

在 `packages/llm/src/schema/errors.ts` 扩充 normalized provider failure classification：

```ts
ProviderFailureClassification =
  | "context-overflow"
  | "incomplete-stream"
```

这是 normalized LLM event contract 扩充，不修改 public Legacy/V2 assistant error union。

### 4.2.2 AI SDK adapter

canonical missing raw finish 继续产生 existing detailed provider error，只附加 stable classification：

```ts
LLMEvent.providerError({
  message: incompleteStreamMessage,
  classification: "incomplete-stream",
  retryable: false,
})
```

`retryable: false` 保留 event 自身语义。Legacy processor 根据 private incomplete decision、fences 和独立预算决定 recovery，不让 public unknown error参与普通 retryability。

### 4.2.3 processor-private control

processor 不把 structured provider error 立即降级成丢失 classification 的 generic `Error`。它只需保留一个 private incomplete control，包含：

- detailed message；
- `classification = "incomplete-stream"`；
- 可选原始 cause。

该 control 不导出到 public schema。所有 ordinary errors 保持 existing mapping。

## 4.3 clean EOF 判定

只有同时满足以下条件才判定为 clean EOF incomplete：

- stream iteration 正常返回；
- 没有 trusted terminal finish evidence；
- 没有 existing assistant terminal error；
- 不是 permission/question blocked；
- 不是 compaction cutoff；
- 不是 interrupt/abort 的既有终态。

是否曾产生 text、reasoning、step 或其它 output 与分类无关。

以下情况明确不能直接进入 incomplete control：

- thrown adapter/source exception；
- auth/rate-limit/context-overflow/API/transport error；
- request preparation error；
- plugin callback error；
- persistence/event handling/cleanup error；
- 其它本地异常。

它们继续经过 existing mapping/policy，即使发生在 partial output 之后也不改变类别。

## 4.4 physical-attempt state

建议在 `processor.ts` 内维护最小状态：

```ts
type PhysicalAttemptCheckpoint = {
  partIDs: SessionV1.PartID[]
  assistant: {
    finish: SessionV1.Assistant["finish"]
    cost: number
    tokens: SessionV1.Assistant["tokens"]
  }
  deferredSummaryLaunches: Array<() => void>
  summaryDisposition: "pending" | "retain" | "rollback"
}

let attempt: PhysicalAttemptCheckpoint
let hasPluginActivity = false
let hasToolActivity = false
let incompleteRetryCount = 0
const incompleteRetryLimit = 2
```

字段语义：

- `partIDs`：current physical attempt 创建的所有 part ID，creation-time 登记并去重；
- `assistant`：进入 attempt 前的 aggregate checkpoint；
- `deferredSummaryLaunches`：当前 attempt 在 `step-finish` 原本要启动的 processor summary；
- `summaryDisposition`：rollback 前标记为 `rollback` 并丢弃；其它最终保留路径（含 interrupt/blocked/compaction/error/success）标记为 `retain`，由 process finalizer 释放一次；
- `hasPluginActivity`、`hasToolActivity`：整个 `process()` 生命周期单调；
- `incompleteRetryCount`：只在 incomplete retry 确认执行时增加。

具体实现可用 callback、Effect 或轻量描述对象保存 summary launch。关键契约是 rollback 前从未启动；最终 retained attempt 的 launches 由 `Effect.ensuring` 覆盖的 process finalizer 在 existing cleanup body 开始前释放，因此 interrupt 不会成为漏释放分支。不要求把多个 `step-finish` 强制合并，也不修改 `summary.ts` 或增加新的 summary suppression 条件。

## 4.5 creation-time part tracking

所有 current attempt 新建的 part 必须在 creation-time 统一登记，包括实际路径可能产生的：

- text；
- reasoning；
- step start/finish；
- tool input/call/result/error parts；
- patch；
- 其它 processor-created assistant part。

原则：

1. 只登记本 physical attempt 新创建的 part；
2. 同一 part 后续 delta/update 不重复登记；
3. 不通过扫描 final message 推断归属；
4. retry 前使用 existing `Session.removePart()` 删除；
5. removal 触发 existing event；
6. retained attempt 不删除。

## 4.6 assistant checkpoint

每个 physical attempt 开始前捕获：

- `finish`；
- `cost`；
- `tokens`。

rollback preparation 恢复这些字段并走 existing `updateMessage` 持久化路径，使 next attempt 从一致 aggregate 开始。

明确不纳入 checkpoint：

- assistant terminal error；
- plugin/tool fence；
- session-wide retry status；
- Snapshot 全局状态。

terminal error 一旦存在即建立 fence，因此不会通过 rollback 清除。

## 4.7 replay fences

### 4.7.1 actual plugin invocation

processor 在首个 matching `experimental.text.complete` callback 真正开始前：

```ts
hasPluginActivity = true
```

该 flag：

- process-local、monotonic；
- callback 成功或抛错都不清除；
- attempt rollback/retry 后也不清除；
- matching handlers 为空时不设置；
- 只有 registration、但 callback 尚未开始时不设置。

不新增 plugin purity/idempotency metadata，不改变 callback 时点、顺序、参数或 `output.text` transformation。

### 4.7.2 normalized tool activity

在 dispatch 以下任一 event 到 existing handler 前设置：

```ts
hasToolActivity = true
```

覆盖：

```text
tool-input-start
tool-input-delta
tool-input-end
tool-call
tool-result
tool-error
```

不要求事件完整、不要求找到对应 call ID、不检查 tool implementation，也不新增 runtime instrumentation。

### 4.7.3 terminal assistant error

只要 `assistantMessage.error !== undefined`，所有 incomplete 和 ordinary provider replay 都被拒绝。该检查在 retry policy gate 与 rollback preparation 边界都成立，防止 decision 与 preparation 之间状态变化。

### 4.7.4 非 fence 的观察

以下事实本身不阻止 safe replay：

- text/reasoning/step 已持久化；
- part update/removal event 已发布；
- removal-aware client 已观察；
- append-only consumer 已打印；
- handler 仅注册但未实际调用。

它们影响 observability，不等同于已知不可逆业务副作用。

## 4.8 ordinary retry 与 incomplete retry

### 4.8.1 ordinary retry

所有 non-incomplete error：

1. 使用 existing `MessageV2.fromError`；
2. 使用 existing `SessionRetry` 判断 retryability、delay 与 status；
3. retry 前应用同一 plugin/tool/terminal-error fences；
4. current attempt 已创建 authoritative state 时，先执行同一 rollback preparation；
5. rollback preparation 失败则不发下一 request；
6. 不修改 incomplete 专用计数。

这保留 rate limit、5xx、timeout 等行为，同时避免 ordinary replay 重复已知副作用或拼接 old partial。

### 4.8.2 incomplete retry

两个 incomplete entry 共用独立计数：

```text
incompleteRetryCount = 0
允许 retry 1 → count = 1
允许 retry 2 → count = 2
再次 incomplete → exhausted，retain 并 stop
```

计数只在 rollback preparation 成功并确定继续下一 provider request 时更新。initial attempt 不计作 retry；连续 incomplete 总 physical attempts 上限为 3。

这里的“独立”只指 **incomplete eligibility/budget**：ordinary error 不增加 `incompleteRetryCount`，incomplete 也不改变 ordinary error 的 `SessionRetry.retryable()` 判定。它不承诺重置 Effect schedule 的 `meta.attempt`。现有单一 retry schedule 仍以所有实际 replay 的 physical ordinal 计算 status/backoff；因此 incomplete replay 之后若再遇 ordinary 503，ordinary retry 可以观察到已推进的 schedule attempt。测试必须锁定这一区别，不能把两个计数都假设为从 1 重新开始。

## 4.9 rollback preparation

建议顺序：

1. 再次检查 `hasPluginActivity === false`；
2. 再次检查 `hasToolActivity === false`；
3. 再次检查 `assistantMessage.error === undefined`；
4. 按 attempt tracking 删除所有 created parts；
5. 恢复 assistant `finish`、`cost`、`tokens`；
6. 持久化恢复后的 assistant；
7. preparation Effect 成功返回，retry schedule 才可继续；
8. 丢弃该 attempt 尚未启动的 processor summary launches。

任一步 failure 自然使 preparation Effect 失败：

- schedule 停止；
- 不发下一 provider request；
- flow fail closed；
- 不增加新的 repair/reconciliation state；
- 不添加只为理论防御路径服务的 Snapshot 或 patch fixture。

`Session.removePart()` 已提供 authoritative deletion 与 removal event，不直接操作数据库或新增 removal event。

## 4.10 final error 与 finish

不得引入统一 generic incomplete final message。最终 retained attempt 按来源保留 existing semantics：

| 最终来源 | error message | finish |
|---|---|---|
| clean EOF，未形成 credible step settlement | `UNSETTLED_STEP_MESSAGE` | `error` |
| clean EOF，已有 credible `step-finish(reason="unknown")` 且无 usable output | `EMPTY_UNKNOWN_MESSAGE` | `unknown` |
| canonical missing raw finish，explicit normalized incomplete | existing provider detailed message | `unknown` |
| assistant existing terminal error | existing error 原样 | existing finish 原样 |
|其它 ordinary error | `MessageV2.fromError` existing result | existing settle semantics |

incomplete 因 fence 不能 retry 时，同样按原始 settle 分支保留 detailed message/finish。

## 4.11 retained tool attempt cleanup

plugin/tool fence 命中时不 rollback。processor 继续 existing stop/cleanup path：

- completed tool result/error 保持现状；
- pending/running tool input/call 由 existing cleanup 最终化为 aborted/error；
- 可使用 existing 文案，例如 `Tool execution aborted`；
- processor 结束后不得留下永久 pending tool part；
- 不为此修改 tool runtime。

## 4.12 processor summary deferral

唯一新增保证：后来被 rollback 的 physical attempt 从未启动自己的 processor summary。

实现规则：

1. physical attempt 内遇到 `step-finish` 时，记录原本要启动的 processor summary，但暂不 fork/call；
2. retry decision 选择 rollback 时，在删除 parts 前把 disposition 标为 `rollback` 并丢弃该 attempt 的记录；
3. 任何最终 retained exit（success、ordinary/incomplete final error、fence、blocked、compaction、interrupt）把 final attempt disposition 标为 `retain`；
4. `Effect.ensuring` 覆盖的 process finalizer 在 existing cleanup body 开始前，对 `retain` 记录按原数量和顺序释放一次；这给 interrupt 提供确定 release path；
5. `rollback` 记录不释放，finalizer 对空列表为 no-op；
6. 不把释放移动到 cleanup 完成之后；
7. 不创建 process-global stable-transcript gate或 final-attempt-only summary subsystem；
8. 不新增 cleanup failure 或 interrupt 时的 summary suppression；interrupt 只是 retained release 的一个既有退出分支；
9. 不改变 `SessionSummary.summarize()` API、实现、error-ignore semantics；
10. 不改变 `prompt.ts` pre-attempt summary behavior。

若 existing semantics 允许多个 `step-finish` 各自触发，则延迟结构保留相同数量和顺序；只做 rollback safety 所必需的延迟，不额外 coalesce。

## 4.13 authoritative transcript 与 observability

成功 rollback 后：

- authoritative materialized parts 不含 rolled-back attempt；
- session history 从 authoritative rows 重建时不含 rolled-back attempt；
- removal-aware projector/client 应用 existing removal events 后收敛到 retained attempt。

不承诺：

- stdout/log/stream 中已发出的 bytes 被撤回；
- non-removal-aware consumer 自动消除 transient output；
- 所有历史 observer 都表现为 failed attempt 从未存在。

实现范围不包含 production consumer、TUI、runtime、output、share 或 transport 修改。测试只需一个 focused processor/event/projection observability case 证明三层契约。

## 4.14 retry status、delay 与 interrupt

- retry status 和 delay 继续复用 `SessionRetry`；
- fence 必须在 delay 计算/等待、retry status 与下一 provider request 前短路；
- interrupt during delay 保持 existing abort behavior，不发下一 request；
- incomplete budget 独立于 ordinary retryability 判定；existing Effect schedule 的 `meta.attempt` 仍按全部 physical replays 单调推进，不为错误类别分别重置；
- 本修复不为 summary 增加额外 interrupt 条件。

## 4.15 usage accounting

删除 step-finish part 时 existing projector 撤销 session aggregate usage；同时恢复 assistant checkpoint，使：

- assistant mutable usage fields；
- step-finish parts；
- session aggregate usage；

一致排除 rolled-back attempt。

这不撤销 provider billing，也不要求 append-only output 删除已观察到的 usage。billing-grade failed-attempt usage record 不在本 Issue 范围。

## 4.16 明确不修改

- `packages/opencode/src/session/prompt.ts`；
- `packages/opencode/src/session/summary.ts`；
- public Legacy error union；
- `MessageV2.fromError` public mapping contract；
- public `UnknownError` retryability；
- plugin registry/runtime API；
- tool implementations/runtime；
- V2；
- production consumers/transports；
- OpenAPI/generated SDK。

---

# 第五部分：正确性论证

## 5.1 定义与不变量

令一次 logical assistant process 包含 physical attempts `A0, A1, ..., Ak`。

### I1：same-assistant identity

所有 attempts 共享同一个 assistant ID，且不插入新的 user message。

### I2：attempt part ownership

每个 attempt `Ai` 创建的每个 part 在 creation-time 恰好登记一次到 `Parts(Ai)`；同一 part 后续 update 不改变 ownership。

### I3：authoritative rollback

若 `Ai` 被 retry，则发起 `Ai+1` 前，`Parts(Ai)` 已通过 existing removal path 删除，assistant `finish/cost/tokens` 已恢复到 `Ai` 开始前 checkpoint。

### I4：replay fence monotonicity

一旦 actual plugin invocation 或任一 normalized tool event 发生，对本次 `process()` 后续所有 attempts，相关 fence 恒为 true。assistant terminal error 一旦存在，也不通过 retry 清除。

### I5：incomplete entry exclusivity

只有以下两个互斥入口可进入 incomplete 专用 decision：

```text
explicit classification=incomplete-stream
OR
(
  normal clean EOF
  AND no trusted terminal evidence
  AND not blocked
  AND not compaction
  AND not interrupt
)
```

任意 thrown error 不因已有 output 自动满足该条件。

### I6：independent budget

`incompleteRetryCount` 只在 incomplete retry 确实进入下一 physical request 时增加，且 `0 ≤ count ≤ 2`。ordinary retry 不修改它。

### I7：retry-before-request ordering

下一 provider request 的必要前提：

```text
retry policy允许
AND replay fences全部未命中
AND rollback preparation成功
```

### I8：summary disposition

- 如果 `Ai` 被 rollback，则 `Ai` processor summary launch count 为 0；
- 最终 retained attempt 的每个 deferred launch 在 process finalizer 中恰好释放一次，包括 interrupt exit。

### I9：visibility contract

成功 rollback 后 authoritative rows 与 removal-aware projection 最终不含 `Parts(Ai)`；append-only surface 不要求满足该不变量。

## 5.2 incomplete 分类正确性

### 前置

adapter 只对已确认 canonical missing raw finish 添加 stable classification；processor 能区分 normal EOF、throw、blocked、compaction、interrupt 与 existing terminal error。

### 论证

1. explicit classification 来自 adapter 已确认协议事实，因此不依赖异常猜测；
2. clean EOF 要求 iteration 正常返回，因此不会吞掉 thrown adapter/source/local error；
3. blocked、compaction、interrupt 和 existing terminal error 在 generic clean EOF 判定前优先；
4. output progress 不参与判定，所以 arbitrary post-output exception 保持 existing category；
5. 其它 error 回到 `MessageV2.fromError` / `SessionRetry`，private control 不泄漏到 public schema。

### 后置

I5 成立；public `UnknownError` 无需变为 retryable。

## 5.3 rollback 正确性

### 前置

current attempt 已建立 checkpoint，所有 new parts 已登记，replay fences 未命中，retry policy 允许继续。

### 论证

1. creation-time tracking 使 `Parts(Ai)` 不依赖 final message scan，open/partial part 也可定位；
2. existing removal path 删除每个 attempt part，并产生 existing removal event；
3. 恢复 `finish/cost/tokens` 消除 attempt 对 assistant aggregate 的累计；
4. preparation 成功后才返回 retry schedule，故 `Ai+1` 不会与未撤销的 `Ai` authoritative state 拼接；
5. preparation failure 直接终止 schedule，不会在未完成 rollback 后 replay；
6. assistant error 不在 checkpoint，且一旦存在就由 fence 阻止 rollback，因此 terminal semantics 不被清除。

### 后置

若发出 next request，则 I3 与 I7 成立；若 preparation 失败，则 request count 不再增加。

## 5.4 replay fence 正确性

### plugin

flag 在 actual callback 开始前设置，因此覆盖 callback 成功、失败、先副作用后抛错。flag process-local monotonic，后续 attempt 不能绕过。仅 registration 不设置，避免误伤从未执行 callback 的路径。

### tool

flag 在 normalized event handler 前设置，因此即使 event 孤立、handler 随后失败或 state 未完整，副作用风险也阻止 replay。六类 events 全覆盖，避免只看 completed tool call。

### terminal assistant error

policy 与 preparation 都检查 existing error，保证已发布 terminal semantics 不被 rollback 或后续 error 覆盖。

### 后置

任何已知 plugin/tool/terminal-error evidence 后 provider request count 不再增加；只发布 model output 不建立 fence。

## 5.5 retry budget 正确性

### 前置

limit 为 2，count 初始 0，只在 incomplete rollback preparation 成功并即将 replay 时增加。

### 推导

- `A0` incomplete：`0 < 2`，执行 retry 1，count 变为 1；
- `A1` incomplete：`1 < 2`，执行 retry 2，count 变为 2；
- `A2` incomplete：`2 < 2` 为 false，retain 并 stop。

ordinary retry 不修改 count。

### 后置

连续 incomplete 最多产生 3 个 physical requests，不可能产生第 4 个。

## 5.6 final error/finish 正确性

1. clean EOF 未形成 credible step settlement 时选择 `UNSETTLED_STEP_MESSAGE`，existing settle 把 `finish` 置为 `error`；
2. clean EOF 已形成 credible `step-finish(reason="unknown")` 且无 usable output 时选择 `EMPTY_UNKNOWN_MESSAGE`，existing settle 保留 `finish = "unknown"`；
3. canonical missing-finish provider detail 已在 adapter 形成，exhaustion/fence 只停止 retry，不改写 detail，保持 `finish = "unknown"`；
4. existing terminal error 在所有 incomplete decision 前优先，且不在 checkpoint，因此 error/finish 原样保留；
5. ordinary error 继续由 existing mapping/settle 决定。

四条路径互斥，无需且不得引入 generic final incomplete message。

## 5.7 summary deferral 正确性

### 前置

`step-finish` 时 current attempt 是否会 retry 尚未知。

### 论证

1. processor summary launch 保存为 attempt-local pending action，decision 前没有启动；
2. decision 选择 rollback 时，在 part removal 前标记并丢弃 pending action，因此 rolled-back attempt launch count 为 0；
3. 最终 retained attempt 的 pending actions 由 process finalizer 在 cleanup body 前释放；`Effect.ensuring` 同时覆盖正常、error 与 interrupt 退出，所以不存在 interrupt 漏释放分支；
4. finalizer 使用 disposition/empty-list 保证每项只释放一次，rollback 后不会误释放；
5. 记录每个原有 launch 而非强制 boolean 合并，可保持多个 `step-finish` 的 existing 数量和顺序；
6. `summary.ts` 与 Prompt 其它 summary 调用点不变，影响只限 processor attempt-local launch 时点。

### 后置

I8 成立，同时 retained attempt summary behavior 除必要延迟外保持兼容。

## 5.8 visibility 正确性

1. authoritative parts 通过 existing removal path 删除，重新加载 history 时 rolled-back attempt 不存在；
2. removal-aware projection 应用同一 removal events，最终与 authoritative rows 收敛；
3. append-only surface 无逆向删除能力，允许保留 transient output；
4. replay safety 由 plugin/tool/error fences 决定，不由某 observer 是否看见 model output 决定。

因此 authoritative convergence 与 append-only caveat 同时成立，无需修改 production consumers。

## 5.9 retained tool cleanup 正确性

fence 命中后 attempt retained，不能依靠 rollback 删除 unfinished tool state。继续 existing cleanup 能把 pending/running part 终结为 aborted/error，使 final authoritative state 不含永久 pending execution，同时不需要 tool runtime 新接口。

## 5.10 终止性

- incomplete counter 只递增，上界为 2，故连续 incomplete 必然在第三个 attempt停止；
- ordinary retry沿用 existing `SessionRetry` 终止语义；
- rollback 遍历有限 `partIDs`，每轮处理一个；任一步失败则停止 replay。

## 5.11 分支与退出覆盖

| 条件 | rollback | retry | final state | processor summary |
|---|---:|---:|---|---|
| trusted success | 否 | 否 | existing success | retain decision 后按 existing semantics 释放 |
| incomplete，预算有余额，无 fence | 是 | 是 | old attempt删除 | rolled-back attempt为0 |
| incomplete，预算耗尽 | 否 | 否 | 保留final partial与exact error/finish | retained semantics |
| incomplete，plugin/tool fence | 否 | 否 | 保留attempt；tool pending由cleanup终结 | retained semantics |
| incomplete，existing terminal error | 否 | 否 | preserve error/finish/parts | retained semantics |
| ordinary retryable error，无 fence | 适用时是 | 是 | old attempt不拼接 | rolled-back attempt为0 |
| ordinary retryable error，有 fence | 否 | 否 | existing error/retained parts | retained semantics |
| ordinary non-retryable error | 否 | 否 | existing mapping/settle | retained semantics |
| rollback preparation failure | 未完成 | 否 | fail closed | rolled-back path不启动 |
| blocked/compaction/interrupt | 否 | 否 | existing outcome | retained disposition；finalizer 在 cleanup body 前释放 |

## 5.12 无回归论证

- trusted success 不进入 incomplete decision；
- arbitrary error 保持 existing `MessageV2.fromError` / `SessionRetry`；
- public error schema/retryability 不变；
- ordinary retry 仅增加 side-effect gate 与适用时 rollback preparation；
- blocked、compaction、interrupt priority 不变；
- plugin callback timing、params、text transformation、API 不变；
- tool event existing handling 不变，只在前面设置 fence；
- `prompt.ts`、`summary.ts`、V2、production consumers 无代码变化；
- retained tool attempt 复用 existing cleanup；
- removal 复用 existing durable event/projector。

## 5.13 风险与防护

| 风险 | 防护 |
|---|---|
| ordinary exception误判incomplete | 只接受explicit classification或normal clean EOF；加exact-boundary regression |
| 漏记attempt part | creation-time统一登记；覆盖自然text/reasoning/step/tool/patch路径 |
| plugin先副作用后抛错仍replay | actual callback前设置monotonic fence |
| registration误触fence | matching callback真正开始才设置 |
| tool event遗漏 | 六类normalized events参数化覆盖，handler前设置 |
| terminal error被清除 | error不进checkpoint；policy/preparation双检查 |
| old partial与retry output拼接 | next request前part removal + assistant restore |
| rollback preparation失败后仍request | failure直接终止schedule |
| ordinary retry误消耗 incomplete budget，或实现误重置 schedule attempt | closure counter 只由实际 incomplete replay 更新；existing `meta.attempt` 继续跨类别推进 |
| exhausted attempt被误删 | 先判断budget/fence，确定retry才rollback |
| rolled-back attempt summary已启动 | `step-finish`只保存attempt-local launch |
| retained summary 被漏放或重复释放 | disposition + process finalizer 在 cleanup body 前释放一次；不新增 suppression，不强制 coalescing |
| partial tool永久pending | retained后existing cleanup，断言aborted/error |
| append-only output被误判rollback failure | focused observability分层断言 |
| public unknown error意外可retry | 不改public retryability，private control留在processor |

---

# 第六部分：测试用例清单

## 6.1 回归与新增测试

| 类型 | 建议测试名 | 核心断言 | 状态 |
|---|---|---|---|
| Adapter classification | `classifies a missing raw finish reason as an incomplete terminal provider error` + shared schema decode | canonical missing raw finish 产生 stable classification 并保留 detail；非法 classification 被拒绝 | 已加并通过（本步骤） |
| Explicit incomplete | `legacy_explicit_incomplete_rolls_back_and_retries_same_assistant` | 同assistant、old parts删除、checkpoint恢复、next request成功 | 已加并通过：focused processor regression |
| Clean EOF | `legacy_clean_eof_without_terminal_retries_same_assistant` | normal EOF无terminal evidence进入private recovery | 已加并通过：same-assistant clean EOF success |
| Exact entry boundary | `legacy_post_output_exception_keeps_existing_error_and_retry_classification` | partial后ordinary exception不自动变incomplete、不占专用计数 | 待加 |
| Ordinary retry rollback | `legacy_ordinary_retry_rolls_back_current_physical_attempt_when_applicable` | existing retryable error 无 fence 时先删除 attempt state 再 replay | 待加 |
| Mixed retry accounting | `legacy_incomplete_budget_is_separate_while_schedule_attempt_remains_monotonic` | incomplete→503→incomplete：503 不消耗 incomplete budget；`meta.attempt` 不按类别重置 | 已加并通过：status attempts `1,2,3` |
| Public error | `legacy_unknown_error_remains_non_retryable` | public `UnknownError` retryability不变 | 待加/保持 |
| Plugin fence | `legacy_actual_text_complete_invocation_blocks_all_provider_replay` | callback前置fence；success/throw后incomplete/ordinary均request count=1 | 待加 |
| No plugin invocation | `legacy_registered_but_uninvoked_text_complete_does_not_set_fence` | registration或无matching handler不阻止safe retry | 待加 |
| Plugin compatibility | `legacy_text_complete_fence_preserves_callback_timing_and_transformation` | existing `text-end` timing，transformation照常持久化 | 待加 |
| Tool fences | `legacy_normalized_tool_activity_blocks_all_provider_replay` | 六类events参数化；complete/partial/orphan均request count=1 | 待加 |
| Retained partial tool | `legacy_retained_partial_tool_is_finalized_by_existing_cleanup` | 不rollback；pending/running最终aborted/error | 待加 |
| Terminal error fence | `legacy_existing_terminal_error_preserves_error_finish_and_parts` | incomplete/ordinary均不replay、不覆盖error/finish | 待加 |
| Budget exhaustion | `legacy_incomplete_exhaustion_uses_exactly_three_physical_attempts` | initial + retry1 + retry2；无第4次；只保留第3次authoritative parts | 已加并通过：3 requests / 2 retry statuses |
| Clean EOF final detail | `legacy_clean_eof_exhaustion_preserves_existing_detailed_error_finish` | 未 settled step 保留 `UNSETTLED_STEP_MESSAGE/error`；credible empty unknown 保留 `EMPTY_UNKNOWN_MESSAGE/unknown` | 已加并通过：两类 exact final semantics |
| Missing-finish final detail | `legacy_missing_finish_exhaustion_preserves_provider_detail_and_unknown_finish` | provider detail不被generic替换，finish为`unknown` | 已加并通过：第三次 detail + `unknown` |
| Rollback preparation failure | `legacy_rollback_preparation_failure_stops_before_next_request` |实际preparation failure后request count不增加 | 待加 |
| Usage checkpoint | `legacy_retry_restores_assistant_finish_cost_tokens_checkpoint` | rolled-back attempt不污染retained aggregate | 待加 |
| Summary rollback | `legacy_rolled_back_attempt_never_launches_processor_summary` | `step-finish`后rollback，failed attempt call count=0 | 待加 |
| Summary retained compatibility | `legacy_retained_attempt_releases_deferred_processor_summary_from_finalizer` | success/error/blocked/compaction/interrupt retained exits均在cleanup body前按existing数量/顺序释放一次 | 待加 |
| Observability | `legacy_retry_converges_authoritative_and_removal_aware_views_while_append_only_may_retain_transient_output` | 一个focused case断言三层visibility | 待加 |
| Intentional outcomes | `legacy_clean_eof_detection_excludes_blocked_compaction_and_interrupt` | 三类existing outcome不进入incomplete | 已加并通过：blocked/compaction/interrupt retained paths |

## 6.2 参数化边界矩阵

### incomplete 输入

| 输入 | incomplete 专用路径 | 说明 |
|---|---:|---|
| normalized provider error，classification为`incomplete-stream` | 是 | explicit entry |
| normal clean EOF，无trusted terminal evidence | 是 | qualifying EOF entry |
| adapter/source throw after text | 否 | ordinary error |
| rate limit / 5xx / timeout | 否 | ordinary retry classification |
| auth failure | 否 | existing settle |
| context overflow | 否 | existing halt/compaction semantics |
| request preparation failure | 否 | existing failure semantics |
| plugin callback failure | 否 | existing error；actual invocation另建fence |
| persistence/event handling failure | 否 | existing local failure semantics |
| blocked / compaction / interrupt | 否 | intentional outcome priority |

### replay fences

| evidence | incomplete retry | ordinary retry |
|---|---:|---:|
| actual matching text-complete callback已开始 | 阻止 | 阻止 |
|任一六类normalized tool event | 阻止 | 阻止 |
| assistant terminal error已存在 | 阻止 | 阻止 |
| only model text/reasoning/step publication | 允许（其它条件满足） | 允许（existing policy满足） |
| handler registered but not invoked | 不单独阻止 | 不单独阻止 |
| append-only observer已见partial | 不单独阻止 | 不单独阻止 |

### final semantics

| final attempt | message | finish | authoritative parts |
|---|---|---|---|
| clean EOF，未形成 credible step settlement | `UNSETTLED_STEP_MESSAGE` | `error` | 保留 final attempt |
| clean EOF，credible empty unknown step | `EMPTY_UNKNOWN_MESSAGE` | `unknown` | 保留 final attempt |
| canonical missing-finish | existing provider detail | `unknown` | 保留final attempt |
| existing terminal error | existing error | existing finish | 原样保留 |
| retained partial tool attempt | existing terminal path；unfinished tool由cleanup标aborted/error | existing semantics | 保留并最终化 |

## 6.3 必须保持的既有回归

- output-length 仍为单 durable terminal error，不 replay；
- ordinary structured/API retry 仍由 `SessionRetry` 工作；
- rate limit、5xx、header timeout、ResponseStreamError、context overflow existing classification保持；
- retry status/delay 使用existing implementation；
- processor settlement、permission、question、compaction、interrupt、structured output tests保持；
- AI SDK event order/terminal failure tests保持；
- Legacy CLI/headless 在 bounded retries exhausted 或 fence 阻止 replay 后仍得到 durable final error；append-only partial output caveat 按本文契约更新；
- existing Prompt/Task/CLI missing-finish fixtures 的 request-count 断言按 bounded retry/fence 分支更新；
- Prompt pre-attempt summary 与 V2 tests 不因本修复改动。

## 6.4 明确删除或不新增的测试范围

- 不增加只为 broad provenance split 服务的 wrapper/type tests；
- 不为各种 persistence、本地 callback、source exception 建立 parallel classification suite；一个 exact-entry-boundary regression足够；
- 不增加分别注入 `Snapshot.track()` 与 `Snapshot.patch()` failure 的测试；
- 不增加只为理论防御路径构造的 forced patch fixture；
- 不增加 rollback survivor reconciliation、event uncertainty 或 future durable batch tests；
- 不增加 global summary isolation、cleanup/interrupt summary suppression 或额外 coalescing tests；只在 retained-finalizer compatibility 用例中覆盖 interrupt release path；
- 不逐个枚举或改造 Mini、ACP、GitHub、share 等 production consumer；只更新直接被 bounded retry 改变的 existing `run-process.test.ts`，另用一个 focused processor/projection case 验证 removal-aware convergence；
- 不增加 request-hook 或 tool-runtime instrumentation tests；
- 不保留单次直接 exhaustion 的专用预算 seam；exhaustion 一律使用三个 incomplete physical attempts。

## 6.5 测试执行命令

所有命令从对应 package 目录运行。实现阶段先确认各 package 的 `package.json` scripts，再使用 package-local命令；不得从repository root拼package path，也不得直接调用 standalone TypeScript compiler。

```bash
cd packages/opencode

bun test test/session/llm.test.ts
bun test test/session/retry.test.ts
bun test test/session/processor-effect.test.ts
bun test test/session/prompt.test.ts
bun test test/tool/task.test.ts
bun test test/cli/run/run-process.test.ts
bun test test/session
bun run typecheck
```

shared schema 类型检查从 `packages/llm` 运行：

```bash
cd packages/llm

bun run typecheck
```

若实际 script 名不同，以对应 package 的 `package.json` 和 CI existing command为准，不通过修改测试语义绕过失败。

### 6.5.1 Stable classification 单元验证记录

2026-08-20 本步骤首次运行时 workspace 尚无 `node_modules`，测试与 typecheck 分别因缺少 `effect`、`@opentui/solid/preload` 和 `tsgo` 无法启动；随后使用现有 `bun.lock` 执行 `bun install --frozen-lockfile --ignore-scripts`，lockfile 无 diff，再运行：

| 命令 | 结果 |
|---|---|
| `bun run --cwd packages/llm test test/schema.test.ts` | 9 pass / 0 fail / 23 assertions |
| `bun run --cwd packages/opencode test test/session/llm.test.ts` | 54 pass / 0 fail / 174 assertions |
| `bun run --cwd packages/llm typecheck` | 通过 |
| `bun run --cwd packages/opencode typecheck` | 通过 |

本步骤只验证 shared classification 与 AI SDK adapter mapping；未运行、修改或声明 processor recovery 已完成。

### 6.5.2 Processor private incomplete entry 单元验证记录

2026-08-20 完成两个 processor-private entry 的分类边界，但尚未启用 replay：classified `provider-error` 与 qualifying clean EOF 先进入 private control，再按既有 public `UnknownError` 形状落地；canonical-looking 未分类错误与 arbitrary post-output exception 继续走 ordinary mapping。blocked、compaction cutoff 与 interrupt 不进入 clean EOF 检测。

| 命令 | 结果 |
|---|---|
| `bun test packages/opencode/test/session/processor-effect.test.ts` | 38 pass / 0 fail / 242 assertions |
| `bun run --cwd packages/opencode typecheck` | 通过 |
| `git diff --check` | 通过 |

本单元明确断言 classified/unclassified/post-output exception/blocked 均只发起一次 physical request；replay、attempt rollback、fences 与 incomplete budget 留给后续实施单元。

### 6.5.3 Physical-attempt checkpoint / creation tracking 单元验证记录

2026-08-20 在每次 retried source evaluation 开始时建立 attempt-local checkpoint，保存本次 attempt 起点的 assistant `finish`、`cost`、`tokens`，并在 part 首次创建前记录其 ID。reasoning、首个 tool part、step start/finish、step/cleanup patch 与 text part 均统一走 creation helper；对既有 part 的 delta/finalization/update 不重复登记。

| 命令 | 结果 |
|---|---|
| `bun test packages/opencode/test/session/processor-effect.test.ts` | 38 pass / 0 fail / 242 assertions |
| `bun run --cwd packages/opencode typecheck` | 通过 |
| `git diff --check` | 通过 |

本单元仅建立 rollback 所需 ownership/checkpoint 数据，不删除 part、不恢复 assistant，也不改变 request count；其直接行为断言将在 rollback 单元用 authoritative removal 与 checkpoint restore 覆盖。

### 6.5.4 Retry decision / preparation hooks 单元验证记录

2026-08-20 扩展 `SessionRetry.policy()` 的可选 `decide` 与 `beforeRetry` hooks。默认调用方继续使用原 ordinary retryability；processor 后续可明确允许或拒绝 replay，并在 delay/status/next request 前执行 rollback preparation。`decide` 返回 `undefined` 是终止决定，不使用 nullish fallback 恢复 ordinary retry；preparation failure 直接失败且不发布 retry status。

| 命令 | 结果 |
|---|---|
| `bun test packages/opencode/test/session/retry.test.ts` | 37 pass / 0 fail / 57 assertions |
| `bun test packages/opencode/test/session/processor-effect.test.ts` | 38 pass / 0 fail / 242 assertions |
| `bun run --cwd packages/opencode typecheck` | 通过 |
| `git diff --check` | 通过 |

新增 policy regressions 证明：hook 未提供时行为兼容；`decide` 可拒绝 otherwise-retryable failure；`beforeRetry` 先于 status；preparation failure fail closed；同一 schedule 的 `meta.attempt` 在 custom/ordinary/custom decisions 间保持 `1,2,3` 单调序列。

### 6.5.5 Text-complete replay fence 单元验证记录

2026-08-20 在 Legacy processor 的既有 `text-end` 时点读取已初始化 hook 列表；仅当存在 matching `experimental.text.complete` handler 且即将调用既有 `plugin.trigger()` 时，在 trigger 前设置 process-local monotonic fence。没有 matching handler、或 registered handler 尚未到达 `text-end` invocation 时不设置。callback 成功或抛出 retryable failure 后 fence 均阻止 ordinary provider replay；callback 顺序、参数与 `output.text` transformation 保持既有 trigger 路径。

| 命令 | 结果 |
|---|---|
| `bun test packages/opencode/test/session/processor-effect.test.ts` | 42 pass / 0 fail / 261 assertions |
| `bun run --cwd packages/opencode typecheck` | 通过 |
| `git diff --check` | 通过 |

Focused regressions 覆盖 actual callback success、callback throw、registered-but-uninvoked、no matching handler 与既有 text transformation。未修改 plugin registry/runtime 或 public plugin API；本单元只把 ordinary retry 接入该 fence，incomplete replay 尚未启用。

### 6.5.6 Normalized tool replay fence 单元验证记录

2026-08-20 在 dispatch 前识别六类 normalized tool event：`tool-input-start`、`tool-input-delta`、`tool-input-end`、`tool-call`、`tool-result`、`tool-error`。任一事件被 processor 观察即设置 process-local monotonic fence，不要求完整 call、不要求对应 part 存在，也不区分 provider-executed/local tool。ordinary retry decision 已接入该 fence。

| 命令 | 结果 |
|---|---|
| `bun test packages/opencode/test/session/processor-effect.test.ts` | 43 pass / 0 fail / 297 assertions |
| `bun run --cwd packages/opencode typecheck` | 通过 |
| `git diff --check` | 通过 |

参数化 regression 对六类事件逐项断言 request count 为 1。会创建 pending/running tool part 的四类场景继续复用 existing cleanup，最终统一落地 `status="error"`、`error="Tool execution aborted"`、`metadata.interrupted=true`；orphan result/error 不创建伪 part。incomplete replay 尚未启用。

### 6.5.7 Terminal assistant error replay fence 单元验证记录

2026-08-20 将 `assistantMessage.error !== undefined` 接入同一 retry decision gate。无论 error 在 process 前已存在，还是 current attempt 由 `step-finish(reason="length")` 创建，后续 ordinary retryable failure 均不再发起 provider request；`halt()` 保留原 error、finish 与已创建 parts，不用后续 transport error 覆盖 terminal state。

| 命令 | 结果 |
|---|---|
| `bun test packages/opencode/test/session/processor-effect.test.ts` | 45 pass / 0 fail / 310 assertions |
| `bun run --cwd packages/opencode typecheck` | 通过 |
| `git diff --check` | 通过 |

两个 focused regressions 分别覆盖 preexisting `ContentFilterError` 与 attempt-created `MessageOutputLengthError`，均断言 request count 为 1、stored assistant 保留既有 finish/error。rollback preparation 的二次 fence 检查将在下一单元接入。

### 6.5.8 Ordinary retry authoritative rollback 单元验证记录

2026-08-20 将 existing ordinary retry 接入 shared `beforeRetry` preparation。decision 与 preparation 边界都检查 plugin/tool/terminal-error、blocked、compaction 与 interrupt 状态；允许 replay 时先清除 current text/reasoning references，再按 creation-time ownership 顺序调用 existing `Session.removePart()`，最后恢复同一 assistant 的 `finish`、`cost`、`tokens` checkpoint 并走 existing `updateMessage()`。任一 removal/restore 失败直接终止 schedule，不发布下一 request；未引入 Snapshot restore、直接 DB delete 或 reconciliation 状态机。

| 命令 | 结果 |
|---|---|
| `bun test packages/opencode/test/session/processor-effect.test.ts` | 47 pass / 0 fail / 329 assertions |
| `bun test packages/opencode/test/session/retry.test.ts` | 37 pass / 0 fail / 57 assertions |
| `bun run --cwd packages/opencode typecheck` | 通过 |
| `git diff --check` | 通过 |

Focused regressions 证明：两次 ordinary physical attempts 复用同一 assistant ID；attempt 1 的 text/reasoning/step parts 经 durable removal 从 authoritative read 消失；attempt 2 仅保留一组 parts；中间 assistant update 恢复原 checkpoint；part-removal projector 故障时 request count 保持 1。另更新既有 retry fixture，锁定 rolled-back output 不再泄漏，并确认 compaction outcome 不 replay。

### 6.5.9 Attempt-local processor summary deferral 单元验证记录

2026-08-20 将 processor `step-finish` 原本的 summary launch 改为 current physical attempt 内按顺序登记。rollback preparation 在任何 part removal 前把 disposition 标记为 `rollback` 并清空 launches；最终 retained attempt 由 process `ensuring` finalizer 在 existing cleanup body 前标记为 `retain`、按原数量/顺序 fork summary。未修改 `summary.ts`、未增加全局 summary gate，也不合并同一 attempt 的多个 step launches。

| 命令 | 结果 |
|---|---|
| `bun test packages/opencode/test/session/processor-effect.test.ts` | 51 pass / 0 fail / 347 assertions |
| `bun run --cwd packages/opencode typecheck` | 通过 |
| `git diff --check` | 通过 |

Focused regressions 证明：ordinary rolled-back attempt 的 summary 不启动、最终 retained attempt 只启动一次；rollback removal failure 也不泄漏已丢弃 launch；retained normal/error/blocked/compaction/interrupt exits 均释放；normal 与 interrupt 的 launch registration 顺序均早于 cleanup completion update。

### 6.5.10 Explicit incomplete bounded replay 单元验证记录

2026-08-20 仅对 processor-private `IncompleteStreamControl(source="provider")` 启用 bounded replay；`source="clean-eof"` 仍按前一阶段直接落地，留待下一单元。每个 `process()` 使用独立 closure counter，initial request 之外最多允许两次 explicit incomplete replay。counter 只在 shared rollback preparation 全部成功后递增；ordinary retry 不递增。所有类别继续复用同一 Effect schedule，因此 status `attempt` 与 backoff physical ordinal 跨 incomplete/ordinary 单调推进。

| 命令 | 结果 |
|---|---|
| `bun test packages/opencode/test/session/processor-effect.test.ts` | 56 pass / 0 fail / 399 assertions |
| `bun test packages/opencode/test/session/retry.test.ts packages/opencode/test/session/processor-effect.test.ts` | 93 pass / 0 fail / 456 assertions |
| `bun run --cwd packages/opencode typecheck` | 通过 |
| `git diff --check` | 通过 |

Focused regressions 覆盖：(1) explicit attempt 1 incomplete、attempt 2 success，复用同一 assistant，删除 attempt 1 authoritative parts、恢复 checkpoint 且只释放 retained summary；(2) 连续三次 explicit incomplete 后精确停止，无第四次 request，只保留 attempt 3 parts，并以第三次 provider detail + `finish="unknown"` 落地；(3) `incomplete → ordinary 503 → incomplete → success` 中 retry status attempts 为 `1,2,3`，ordinary failure 不消耗 incomplete budget；(4) actual text-complete callback 与 normalized tool activity 同样阻止 explicit incomplete replay。compatible AI SDK fixture 另证明未闭合 reasoning/text 在 replay 前被 authoritative removal，成功 attempt 独占最终 transcript。未修改 public `UnknownError` retryability、Prompt loop、plugin/tool runtime 或 V2。

### 6.5.11 Clean EOF bounded replay / exact final semantics 单元验证记录

2026-08-20 将同一 private recovery decision 与成功后计数逻辑扩展到 `IncompleteStreamControl(source="clean-eof")`，不新增 error type、schedule 或 public retryability。explicit 与 clean EOF 共用一个每次 `process()` 最多两次 replay 的 incomplete budget；ordinary failure 仍不消耗。qualifying clean EOF replay 前执行相同 authoritative rollback，fence 或既有 terminal/blocked/compaction/interrupt outcome 命中时仍直接 retained settle。

| 命令 | 结果 |
|---|---|
| `bun test packages/opencode/test/session/processor-effect.test.ts` | 59 pass / 0 fail / 447 assertions |
| `bun test packages/opencode/test/session/retry.test.ts packages/opencode/test/session/processor-effect.test.ts` | 96 pass / 0 fail / 504 assertions |
| `bun run --cwd packages/opencode typecheck` | 通过 |
| `git diff --check` | 通过 |

Focused regressions 覆盖：(1) unsettled clean EOF attempt 1 回滚后 attempt 2 在同一 assistant 成功，attempt 1 open text/step parts 不留在 authoritative transcript；(2) credible empty unknown 连续三次后以 `EMPTY_UNKNOWN_MESSAGE` + `finish="unknown"` 落地；(3) empty/final-only/active-step EOF 连续三次后以 `UNSETTLED_STEP_MESSAGE` + `finish="error"` 落地；(4) explicit → clean EOF → clean EOF 共用两次 incomplete replay budget，无第四次 request；(5) ordinary retry 后的 clean EOF 继续沿同一 schedule 观察 `attempt=2,3`，不重置 ordinal；(6) actual text-complete callback、pending tool input 与 preexisting terminal error 均阻止 clean EOF replay；blocked、compaction 与 interrupt exclusions 保持既有路径。retained pending tool 继续由 existing cleanup 落为 aborted/error。

## 6.6 最小复现固化要求

- A/B 分别证明explicit incomplete与qualifying clean EOF；
- C 证明arbitrary post-output exception保持ordinary behavior；
- D/E/F 证明actual plugin、所有normalized tool event、existing terminal error同时阻止incomplete与ordinary replay；
- G 使用恰好三个连续 incomplete physical attempts 证明专用预算，并用 incomplete→ordinary→incomplete 混合序列证明 ordinary 不消耗该预算而 schedule attempt 不重置；
- H 分别证明三类exact final error/finish；
- I 证明rollback preparation failure后无next request；
- J 证明 rolled-back attempt processor summary call count 为 0，且 retained success/error/interrupt 由 finalizer 在 cleanup body 前按 existing 数量释放一次；
- K 用一个 focused case 证明 authoritative/removal-aware convergence 与 append-only caveat；
- L 更新 Prompt/Task/CLI 既有 missing-finish fixtures，分别锁定 safe bounded retry、tool fence no-replay 与 final exhaustion；
- retained partial tool case 证明 existing cleanup 产出 aborted/error 而非永久 pending。

## 6.7 退出测试标准

- 两个incomplete entries均有regression；
- arbitrary post-output exception保持ordinary behavior；
- 连续 incomplete exhaustion 恰好 3 requests；混合错误序列不误消耗 incomplete budget，且 existing schedule attempt 不重置；
- plugin/tool/error fences覆盖incomplete与ordinary retry；
- same-assistant rollback、part removal、assistant checkpoint均有assertion；
- final detailed error/finish分别有assertion；
- rollback preparation failure后无next request；
- rolled-back attempt summary call count 为 0；retained normal/error/interrupt exits 均由 finalizer 释放一次；
- retained partial tool最终不是pending/running；
- focused observability证明三层contract；
- 相关Legacy session regression与package-local typecheck全过。

---

# 第七部分：代码更新清单

## 7.1 计划修改文件

| 文件 | 函数 / 区域 | 计划改动 | 状态 |
|---|---|---|---|
| `packages/llm/src/schema/errors.ts` | provider failure classification | 增加 `incomplete-stream` stable literal；不改 public Legacy error | 已改并通过 typecheck（本步骤） |
| `packages/llm/test/schema.test.ts` | provider-error schema decode | 接受 declared `incomplete-stream`，拒绝未知 classification | 已加并通过：9/9（本步骤） |
| `packages/opencode/src/session/llm/ai-sdk.ts` | canonical missing raw finish mapping | existing detailed normalized error 附 classification | 已改并通过 typecheck（本步骤） |
| `packages/opencode/src/session/processor.ts` | stream settle、attempt bookkeeping、event handling、retry preparation、summary launch | 两个entry；private control；part tracking；assistant checkpoint；plugin/tool/error fences；same-assistant rollback；独立预算；exact final semantics；attempt-local summary deferral；existing tool cleanup | 已改并验证：两个 incomplete entry 共用 bounded recovery；observability 与跨层回归仍待完成 |
| `packages/opencode/src/session/retry.ts` | policy/gate/preparation integration | incomplete与ordinary retry发request前共用gate/preparation，复用delay/status | 已改并验证：optional decide/beforeRetry hooks；processor integration 待后续单元 |
| `packages/opencode/test/session/llm.test.ts` | adapter tests | stable classification 与 detailed message regression | 已改并通过：54/54（本步骤） |
| `packages/opencode/test/session/retry.test.ts` | retry policy tests | gate/preparation、独立count与ordinary retry交互 | 已改并验证：policy hooks 37/37；processor integration 覆盖独立 budget 与跨类别 monotonic attempt |
| `packages/opencode/test/session/processor-effect.test.ts` | focused integration tests | same-assistant rollback、entries、exact boundary、fences、three-attempt exhaustion、final semantics、usage、summary、tool cleanup、observability | 进行中：explicit/clean EOF success、exhaustion、shared budget、exact final semantics 与 fences 已加并通过 59/59；observability 待完成 |
| `packages/opencode/test/session/prompt.test.ts` | existing Legacy loop regressions | 为无 fence 的 missing-finish fixture 提供 bounded retry 序列并更新 request count；completed-tool fence 用例继续锁定 no replay | 待改 |
| `packages/opencode/test/tool/task.test.ts` | child/task incomplete regressions | child 自身无 tool fence 时验证 bounded retry/exhaustion；已有 tool activity 时仍不 replay，并保持 Task error 投影 | 待改 |
| `packages/opencode/test/cli/run/run-process.test.ts` | top-level/child CLI regressions | 更新 missing-finish request 数与最终 error；明确 authoritative state 收敛而 append-only stdout/JSON 可保留 transient failed output | 待改 |

不修改 production consumer 实现。上述 Prompt/Task/CLI 测试文件已存在 no-replay/request-count 契约，本行为改变会直接影响它们，因此必须列入 implementation test modifications；focused removal-aware observability 仍优先复用 processor integration test 内 existing projector helper。

## 7.2 明确不修改

| 文件 / 区域 | 理由 |
|---|---|
| `packages/opencode/src/session/prompt.ts` | incomplete recovery不进入Prompt loop；pre-attempt summary不变 |
| `packages/opencode/src/session/summary.ts` | API/logic/error handling不变；仅processor延迟rolled-back attempt启动 |
| `packages/opencode/src/session/message-v2.ts` | existing error mapping/public contract不变 |
| `packages/opencode/src/session/session.ts` | 复用existing part removal/event |
| plugin registry/runtime files | 复用matching handler lookup/trigger；不增加purity/retry-safe contract |
| tool runtime/implementations | processor normalized event fence足够 |
| public Legacy error schema | 不新增incomplete public variant，不改`UnknownError` retryability |
| V2 files | 仅参考，不实施parity |
| production consumer/TUI/runtime/output/transport | 不提供retroactive deletion protocol |
| OpenAPI/generated SDK | public schema不变 |

## 7.3 实施顺序

本问题属于 Legacy Session 内部恢复控制流错误，不修改 public interface 或模块划分，因此不触发 §4 的新 feature/架构重设计。它会修订既有 incomplete 行为契约，故编码前必须先完成文档同步 gate：本文获确认后，先在 `docs/fixes/session-fix-incomplete-provider-stream.md` 追加 Issue #7 superseding amendment，明确“原 no-retry 契约仅描述 Issue #3 基线；Issue #7 在本文 fences/budget/rollback 条件下允许 bounded replay”，该同步经确认后才开始源代码修改。

每步按项目流程单独实现、测试、审阅：

1. [已完成] 编码前同步并确认既有 incomplete contract amendment（`docs/fixes/session-fix-incomplete-provider-stream.md` §11）；
2. [已完成] `packages/llm` stable classification + `packages/opencode` adapter mapping/test；
3. [已完成] processor 两个 incomplete entry + exact-entry-boundary regression（private control 落地，尚未启用 replay）；
4. [已完成] minimal physical-attempt checkpoint + creation-time part tracking（仅建立 ownership/checkpoint，不启用 rollback）；
5. [已完成] `SessionRetry.policy()` optional decision/preparation hooks；默认 ordinary 行为兼容，preparation 先于 delay/status 且失败 fail closed；
6. [已完成] actual text-complete invocation fence + callback compatibility；ordinary 与 explicit incomplete replay 均接入并验证；
7. [已完成] 六类 normalized tool event fence + retained partial tool cleanup assertion；ordinary 六类参数化与 explicit incomplete integration 均已验证；
8. [已完成] assistant terminal-error fence；shared decision/preparation gate 同时适用于 ordinary 与 explicit incomplete replay；
9. [已完成] ordinary retry 适用时复用 fences 与 same-assistant rollback preparation；已验证 authoritative attempt 隔离与 preparation failure no-next-request；
10. [已完成] processor `step-finish` summary attempt-local deferral；rollback 丢弃，retained success/error/blocked/compaction/interrupt 由 process finalizer 在 cleanup body 前释放；
11. [已完成] explicit incomplete recovery + independent two-retry budget；successful same-assistant replay、three-attempt exhaustion 与 incomplete→ordinary→incomplete monotonic schedule sequence 均已验证；
12. [已完成] clean EOF recovery + shared incomplete budget + exact final error/finish；
13. focused authoritative/removal-aware/append-only observability test；
14. package-local 定向、Prompt/Task/CLI/session regression 与 typecheck；
15. 实现后回填本文和既有 contract amendment 状态，新增 devlog。

## 7.4 实现后核对项

- [ ] 同一logical process没有new assistant ID；
- [ ] 没有new user message或Prompt continuation；
- [ ] incomplete只有explicit stable classification与qualifying clean EOF两个entry；
- [ ] arbitrary post-output exception走existing mapping/retry；
- [ ] public `UnknownError`仍不可retry；
- [ ] ordinary retry 不消耗 incomplete budget；incomplete retry 不改变 ordinary `retryable()` 分类；
- [ ] existing Effect schedule `meta.attempt` 跨 incomplete/ordinary physical replay 单调，不按类别重置；
- [ ] 连续 incomplete 最多 initial + retry1 + retry2，共 3 requests；
- [ ] actual matching text-complete callback前设置monotonic fence；
- [ ] 无matching handler或未actual invocation不误置fence；
- [ ] callback timing/order/`output.text` transformation不变；
- [ ] 六类normalized tool events全部在handler前建立fence；
- [ ] plugin/tool fence同时阻止incomplete与ordinary replay；
- [ ] existing terminal error阻止所有replay且不被checkpoint清除；
- [ ] model text/reasoning/step publication本身不是fence；
- [ ] retry前删除current attempt所有authoritative parts；
- [ ] retry前恢复assistant `finish`、`cost`、`tokens`；
- [ ] rollback preparation failure后不发next request；
- [ ] 不存在Snapshot global restore或额外reconciliation state；
- [ ] clean EOF 未形成 credible step settlement 时保留 `UNSETTLED_STEP_MESSAGE` 且 finish 为 `error`；
- [ ] clean EOF 已形成 credible empty unknown step 时保留 `EMPTY_UNKNOWN_MESSAGE` 且 finish 为 `unknown`；
- [ ] canonical missing-finish 保留 provider detail 且 finish 为 `unknown`；
- [ ] existing terminal error/finish原样保留；
- [ ] fence-retained partial tool经existing cleanup终结aborted/error；
- [ ] rolled-back attempt从未启动processor summary；
- [ ] retained summary 由 process finalizer 在 existing cleanup body 前释放一次；success/error/blocked/compaction/interrupt 均有确定 release path；
- [ ] `prompt.ts`无diff；
- [ ] `summary.ts`无diff；
- [ ] V2无diff；
- [ ] plugin/tool public API无diff；
- [ ] production consumer/TUI/runtime/output/transport无diff；
- [ ] authoritative DB/history最终只含retained attempt；
- [ ] removal-aware projection最终收敛；
- [ ] append-only surface允许transient failed-attempt output；
- [ ] 只有一个focused observability integration test；
- [ ] package-local tests/typecheck通过；
- [ ] `git diff --check`通过。

## 7.5 代码更新状态回填规则

实现前状态保持待改/待加。实现后逐项回填：

- actual modified files/functions；
- test names；
- pass/total；
- commit hash（只有用户授权commit后填写）；
- 与本文不同的decision及理由。

本文审批不等于一次性授权全部代码实现。

---

# 第八部分：文档更新清单

## 8.1 计划更新

| 文档路径 | 要改什么 | 状态 |
|---|---|---|
| `docs/fixes/session-fix-incomplete-stream-recovery.md` | 本文：Legacy-only、same-assistant、两个incomplete entries、independent budget、actual plugin/tool/error fences、authoritative rollback、exact final semantics、visibility分层与rolled-back-attempt summary deferral | 已确认；按实施单元持续回填 |
| `docs/fixes/session-fix-incomplete-provider-stream.md` | **编码前**追加 Issue #7 superseding amendment：保留 Issue #3 历史 no-retry 结论，同时声明本文 fences/budget/rollback 条件下的 bounded replay；不引入 broad exception conversion 或 generic final message | 已同步：§11（本步骤） |
| `docs/devlog/2026-08-20-incomplete-stream-classification.md` | stable classification / AI SDK mapping 单元的代码、测试、五维审核与 metrics | 已加（本步骤） |
| `docs/devlog/2026-08-<implementation-date>-incomplete-stream-recovery.md` | 全部 recovery 实现完成后汇总代码、测试、关键 decision 和 required metrics | 待加 |
| `CLAUDE.md`「已知限制与注意事项」 | 仅实现后确认有可复用经验时回写，例如authoritative removal不等于append-only历史擦除 | 待判定 |

初次方案收尾与编码前 contract amendment 已分别完成。stable classification / AI SDK mapping、processor 两个 private entries、physical-attempt checkpoint/tracking、retry hooks/fences、ordinary same-assistant rollback、attempt-local summary deferral 与 shared-budget incomplete bounded replay 已修改 shared schema、adapter、processor/retry 与对应 tests；summary.ts、plugin/tool runtime/public API、Prompt/V2 仍无 diff，observability 与跨层回归待完成。

## 8.2 行为契约变更

原行为：Legacy incomplete 一般直接停止，不执行 same-assistant bounded transport retry。

新行为：

1. 只有 explicit normalized `classification = "incomplete-stream"` 与 qualifying clean EOF 可进入 incomplete recovery；
2. 无 actual plugin invocation、无 normalized tool activity、无 existing assistant terminal error、预算允许且 rollback preparation成功时，复用同一assistant重试；
3. incomplete最多retry两次；
4. safe retry前删除current attempt authoritative parts并恢复assistant `finish/cost/tokens`；
5. arbitrary exception保持existing error/retry classification；
6. ordinary retry可复用fences与rollback preparation，但不消耗incomplete budget；
7. final retained attempt保留来源对应的existing detailed error/finish；
8. rolled-back attempt 不启动自己的 processor summary；final retained attempt 由 process finalizer 在 cleanup body 前释放 deferred launches；
9. authoritative/removal-aware views 收敛，append-only surface 可以观察 transient output。

## 8.3 保持不变的契约

- trusted normal success正常完成；
- blocked、compaction、interrupt使用existing priority branches；
- rate limit、5xx、timeout、auth、context overflow等existing mapping/retry不变；
- public `UnknownError`不可retry；
- terminal assistant error不被覆盖；
- plugin callback public API、timing与text transformation不变；
- tool runtime/implementation不变；
- `SessionSummary.summarize()` API/logic不变；
- Prompt pre-attempt summary不变；
- 无new assistant、new user message或continuation；
- V2不变；
- production consumers/transports不增加retroactive removal。

## 8.4 有意排除的设计

本修复明确不包含：

- 基于response progress把arbitrary exception转换成incomplete；
- provider与本地处理的全新wrapper hierarchy；
- public retryable incomplete/unknown error；
- successor assistant或continuation turn；
- plugin purity/idempotency声明；
- request-hook或tool-runtime instrumentation；
- Snapshot global state restore；
- rollback crash-atomic扩展、survivor repair或durable batch设计；
- final retained attempt专用summary gate；
- summary global stability isolation、extra coalescing或cleanup/interrupt suppression；
- production consumer/TUI/runtime/output/transport变更；
- 全量 consumer implementation/test matrix（仅更新直接受 request-count/output 契约影响的 existing CLI regression）；
- V2 parity。

这些是有意范围收缩，不是遗漏。

## 8.5 实现完成后的回填

实现与测试完成后，第六、七、八部分回填：

- actual tests；
- package-local commands与pass/total；
- actual modified files/functions；
- rollback、final semantics、tool cleanup、summary、observability assertions；
- commit hash（如用户授权commit）；
- 相关旧contract docs同步状态；
- devlog metrics；
- 是否更新`CLAUDE.md`注意事项。

在代码、测试、文档三轨均完成前，不把该修复标记为完成。
