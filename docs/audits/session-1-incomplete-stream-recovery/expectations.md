# Contract Audit Expectations — `session-1-incomplete-stream-recovery`

> 本文件在新增实现代码前，仅从已批准的架构、子计划和修复方案填写。实施后再回填“实现位置 / 验证结果”列；不得用实现反向修改预期以消除偏差。

## 1. 契约源（multi-doc）

| 契约文档                                                               | 章节       | 约束范围                                       | 状态   |
| ---------------------------------------------------------------------- | ---------- | ---------------------------------------------- | ------ |
| `docs/design/session/architecture.md`                                  | §2–§10     | Session 全局边界、分层、持久化、事件和不变量   | active |
| `docs/design/session/subplans/session-1-incomplete-stream-recovery.md` | §1–§13     | 本子计划 wire/runtime/projection/test 完整契约 | active |
| `docs/fixes/session-fix-incomplete-stream-recovery.md`                 | §4–§7      | 根因导出的实施选择、正确性和代码更新清单       | active |
| Issue `lihaokun/opencode#7`                                            | issue body | SafeRetry / settled-tool continuation / stop   | active |

优先级：主架构的全局不变量 > 子计划的具体接口契约 > fix plan 的实施说明。若出现冲突必须暂停并写入 `decisions.md`，不能由实现者静默选择。

## 2. Schema 字段（机械化）

| 字段名                                    | 类型 / 可空性                        | 语义与约束                                                                  | 契约来源          | 实现位置                              | 一致性 |
| ----------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------- | ----------------- | ------------------------------------- | ------ |
| `IncompleteStreamRecovery.classification` | required literal `incomplete-stream` | durable recovery 的稳定判别字段；与 provider failure canonical literal 同源 | subplan §3.1–§3.3 | `schema/src/session-recovery.ts`      | pass   |
| `IncompleteStreamRecovery.action`         | required action enum                 | 分类器给出的唯一恢复动作                                                    | subplan §3.1–§3.3 | `schema/src/session-recovery.ts`      | pass   |
| `IncompleteStreamRecovery.reason`         | required reason enum                 | 与 action 和输入事实满足跨字段不变量                                        | subplan §3.1–§3.3 | `schema/src/session-recovery.ts`      | pass   |
| `IncompleteStreamRecovery.tools`          | required `ToolEvidence[]`            | boundary snapshot；单个 snapshot 内 ID 唯一                                 | subplan §3.1–§3.3 | schema + core classifier              | pass   |
| `IncompleteStreamRecovery.retry`          | required `Retry`                     | 记录当前 attempt 与 limit；`attempt <= limit`                               | subplan §3.1–§3.3 | schema + core classifier              | pass   |
| `ToolEvidence.id`                         | required non-empty string            | durable tool call ID；snapshot 内唯一                                       | subplan §3.1–§3.3 | schema + core classifier              | pass   |
| `ToolEvidence.name`                       | required non-empty string            | 诊断和协议配对使用的 tool 名                                                | subplan §3.1–§3.3 | schema + core classifier              | pass   |
| `ToolEvidence.state`                      | required tool-state enum             | failure boundary 时的状态，不采用 cleanup 后 tombstone                      | subplan §3.1–§3.3 | `schema/src/session-recovery.ts`      | pass   |
| `ToolEvidence.completeCall`               | required boolean                     | provider tool call 已完整观察                                               | subplan §3.1–§3.3 | `schema/src/session-recovery.ts`      | pass   |
| `ToolEvidence.inputPersisted`             | required boolean                     | tool input 已 durable publish/write                                         | subplan §3.1–§3.3 | `schema/src/session-recovery.ts`      | pass   |
| `ToolEvidence.providerExecuted`           | required boolean                     | provider/local executor 已经开始执行的证据                                  | subplan §3.1–§3.3 | `schema/src/session-recovery.ts`      | pass   |
| `ToolEvidence.terminalResultPersisted`    | required boolean                     | completed/error 的 durable terminal payload 已写入                          | subplan §3.1–§3.3 | schema + core classifier              | pass   |
| `ToolEvidence.interrupted`                | required boolean                     | boundary 时存在中断/不确定性；不得作为 settled continuation                 | subplan §3.1–§3.3 | schema + core classifier              | pass   |
| `Retry.attempt`                           | required non-negative integer        | 原始 attempt=0，新 attempts=1/2                                             | subplan §3.1–§4.3 | schema + core classifier              | pass   |
| `Retry.limit`                             | required non-negative integer        | 本 chain 的 immutable limit；默认 2                                         | subplan §3.1–§4.3 | schema + core policy                  | pass   |
| legacy/current `Assistant.recovery`       | optional recovery                    | 旧数据可省略；failed incomplete attempt 持久化                              | subplan §3.2      | `session-message.ts`, `v1/session.ts` | pass   |
| current `Step.Failed.recovery`            | optional recovery                    | 将 failed step 与同一 durable snapshot 关联                                 | subplan §3.2, §7  | `schema/src/session-event.ts`         | pass   |

Schema 只接受可序列化字段。所有 recovery schema 必须带 §3.2 指定的 stable identifier；optional omission 必须保持现有 message/event decode 行为。

## 3. 枚举值（机械化）

| 枚举 / 值集合                                                                                                     | 共享常量名 / schema                       | Import 路径                                            | 契约来源         | 验证结果 |
| ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------ | ---------------- | -------- |
| `safe-retry`, `continue-after-settled-tools`, `manual-stop`                                                       | `IncompleteStreamRecovery.Action`         | `@opencode-ai/schema/session-recovery`                 | subplan §3.1     | pass     |
| `incomplete-stream`                                                                                               | `IncompleteStreamRecovery.Classification` | `@opencode-ai/schema/session-recovery`                 | subplan §3.1, §5 | pass     |
| `no-tool-evidence`, `settled-tools`, `uncertain-side-effect`, `retry-exhausted`, `blocked`, `persistence-failure` | `IncompleteStreamRecovery.Reason`         | `@opencode-ai/schema/session-recovery`                 | subplan §3.1     | pass     |
| `pending`, `running`, `completed`, `error`                                                                        | `IncompleteStreamRecovery.ToolState`      | `@opencode-ai/schema/session-recovery`                 | subplan §3.1     | pass     |
| `context-overflow`, `incomplete-stream`                                                                           | `ProviderFailureClassification`           | `@opencode-ai/llm/schema/errors`                       | subplan §5       | pass     |
| limit=`2`, initial delay=`2000`, factor=`2`                                                                       | `INCOMPLETE_STREAM_RETRY_*`               | `@opencode-ai/core/session/incomplete-stream-recovery` | subplan §4.3     | pass     |

Runtime 比较 action/reason/state 时必须 import 共享 schema/type/value，不允许各 runtime 定义第二套枚举。

## 4. 流程步骤（机械化）

| Step  | 契约行为                                                                      | `# Step Pn:` 预期位置                                  | 实现位置                                         | 验证结果 |
| ----- | ----------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------ | -------- |
| `P1`  | 在 provider failure boundary 冻结并验证 recovery facts                        | legacy processor / current publisher snapshot function | post-implementation                              | pending  |
| `P2`  | 用共享纯分类器按 invalid→blocked→persistence→empty→settled→uncertain 顺序分类 | core `classifyIncompleteStreamRecovery`                | `core/src/session/incomplete-stream-recovery.ts` | pass     |
| `P3`  | 先持久化 failed assistant recovery，再允许 caller 消费 transition             | legacy processor / current publisher                   | post-implementation                              | pending  |
| `P4`  | ManualStop 发布一次 terminal error 并 idle；自动动作保持 active               | processor/publisher terminalization                    | post-implementation                              | pending  |
| `P5`  | SafeRetry 等待 2s/4s，创建新 ID 并重放同一 logical step                       | legacy Prompt / compaction / current runner            | post-implementation                              | pending  |
| `P6`  | Continue 创建新 ID、进入下一 logical step，且不重执行 settled tools           | legacy Prompt / current runner                         | post-implementation                              | pending  |
| `P7`  | successor projection 按 recovery 过滤失败 attempt                             | legacy/current model-message projector                 | post-implementation                              | pending  |
| `P8`  | successor attempt 每次只调用一个 `llm.stream`                                 | legacy processor/current `runTurnAttempt`              | post-implementation                              | pending  |
| `P9`  | success 才做 structured promotion / Compacted；incomplete 优先                | legacy Prompt / compaction                             | post-implementation                              | pending  |
| `P10` | active chain 完成后才 terminalize session；restart 不消费历史 transition      | caller coordinator                                     | post-implementation                              | pending  |

## 5. 行为契约（语义，人审）

| ID    | 前置 / 触发条件                                                | 必须行为                                                  | 禁止行为                                               | 契约来源                    | 审核结果 |
| ----- | -------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------ | --------------------------- | -------- |
| `B1`  | incomplete；tools 为空；attempt<limit；未 blocked/persist fail | 新 ID SafeRetry，同一 logical step                        | 复用 ID、消费 step、投影 partial、终止 session         | subplan §4, §6, §7          | pending  |
| `B2`  | incomplete；tools 非空且全部 settled                           | 新 ID Continue，下一 logical step，只投影 settled tools   | replay/re-execute observed call、投影 failed prose     | subplan §4, §6–§8           | pending  |
| `B3`  | 任一 tool pending/running/interrupted/缺 terminal payload      | ManualStop，诊断列出 id/name/state                        | 自动 retry/continue                                    | subplan §3–§4               | pending  |
| `B4`  | retry attempt 已达 limit                                       | ManualStop/retry-exhausted；最多三个总 attempts           | 第三个新 retry                                         | subplan §4.3                | pending  |
| `B5`  | blocked 或 recovery persistence failure                        | 分别 ManualStop/blocked 或 persistence-failure            | 被表面 empty/settled facts 覆盖                        | subplan §4.2                | pending  |
| `B6`  | raw-missing/generic incomplete provider failure                | classification=`incomplete-stream`；agent classifier 决策 | 仅依赖 transport retryable；强行设 retryable=true      | subplan §5                  | pending  |
| `B7`  | compaction incomplete                                          | 新 summary ID bounded retry；成功才 Compacted             | 投影 partial summary；把 failed summary 标为 completed | subplan §6.3                | pending  |
| `B8`  | StructuredOutput attempt incomplete                            | 按普通 tools 证据分类，只提升后来成功 attempt             | 提升 failed partial；由 usage 先触发 compaction        | subplan §5, §9              | pending  |
| `B9`  | 新 user/steer 到达 active recovery chain                       | 终止旧 chain，按新输入走正常 step 1                       | 继续消费过时 transition                                | subplan §6.2                | pending  |
| `B10` | process 启动并加载带 recovery 的历史 failed assistant          | 仅用于审计/投影                                           | 自动发送 provider request                              | architecture §2, subplan §7 | pending  |
| `B11` | ordinary retryable provider/API error                          | 保持现有 retry 行为                                       | 被 incomplete attempt budget 替代                      | subplan §1.2, §4.3          | pending  |
| `B12` | eventual recovery success in headless/structured CLI           | 不因中间 failure event 令 CLI exit code 非零              | 中间 idle/error 使 event loop 提前退出                 | subplan §9                  | pending  |

## 6. 时序 / 状态契约（人审）

| ID   | 初始状态               | 事件                                      | 目标状态                          | 顺序 / 冻结约束                                                                 | 审核结果 |
| ---- | ---------------------- | ----------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------- | -------- |
| `S1` | busy attempt           | incomplete boundary                       | recovery snapshot                 | snapshot 必须先于 cleanup/fiber tombstone；persisted bit 只在成功写入后设置     | pending  |
| `S2` | snapshot               | classifier=SafeRetry                      | retry → busy successor            | failed recovery 先持久化；不发 terminal error/idle；等待按 attempt 为 2s/4s     | pending  |
| `S3` | snapshot               | classifier=Continue                       | busy next-step successor          | recovery 先持久化；settled results 已存在；不发 retry/idle                      | pending  |
| `S4` | snapshot               | classifier=ManualStop                     | terminal error → idle             | terminal error 恰好一次；不创建 successor                                       | pending  |
| `S5` | high-usage incomplete  | atomic step-finish + provider-error batch | recovery before compaction        | incomplete classification 必须先于 usage-driven compaction/structured promotion | pending  |
| `S6` | failed current attempt | automatic successor                       | failed Step then new Step.Started | `Step.Failed.recovery` 先 durable；不发布/复用 `SessionEvent.Retried`           | pending  |
| `S7` | active transition      | new user/steer                            | new normal turn                   | transition 绑定 failed ID 且最多消费一次                                        | pending  |
| `S8` | process stopped        | restart/load history                      | idle historical state             | 不依据 durable recovery 自动启动 active coordinator                             | pending  |

## 7. 不变量契约（property-based）

| ID    | 不变量                                                         | 输入域                                            | 测试框架 / 用例                          | 契约来源          | 覆盖结果 |
| ----- | -------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------- | ----------------- | -------- |
| `I1`  | SafeRetry 蕴含 tools 为空且 `attempt<limit`                    | arbitrary normalized/invalid classifier inputs    | fast-check classifier property           | subplan §3.3, §13 | pass     |
| `I2`  | Continue 蕴含 tools 非空且每个 tool settled                    | arbitrary tool evidence arrays                    | fast-check classifier property           | subplan §3.3, §13 | pass     |
| `I3`  | invalid/uncertain evidence 永不产生 SafeRetry/Continue         | duplicate IDs、非法 implications、pending/running | fast-check + table cases                 | subplan §4.1–§4.2 | pass     |
| `I4`  | blocked/persistence failure 优先并总是 ManualStop              | arbitrary otherwise-recoverable facts             | fast-check precedence property           | subplan §4.2      | pass     |
| `I5`  | retry 新 attempt 数不超过 limit，默认总 attempts≤3             | attempt/limit non-negative integers               | table/property + integration IDs         | subplan §4.3, §13 | pending  |
| `I6`  | terminal persisted 蕴含 complete/input/executed/terminal state | arbitrary tool booleans/states                    | schema/classifier invalid-evidence cases | subplan §3.3      | pass     |
| `I7`  | failed attempt durable record 保留且 successor ID 不同         | generated recovery chains                         | legacy/current integration               | architecture §10  | pending  |
| `I8`  | 每个 current/legacy attempt 的 `llm.stream` 调用≤1             | error/success/generated stream sequences          | counted mock streams                     | subplan §13       | pending  |
| `I9`  | successor projection 不含 failed prose/reasoning/partial tools | generated failed parts/evidence subsets           | projector property/table tests           | subplan §8, §13   | pending  |
| `I10` | settled tool call ID 不由 recovery 再执行                      | generated settled multi-tool histories            | executor invocation counts               | subplan §8, §13   | pending  |

Unit A 直接引入 `fast-check@4.8.0` 作为 core devDependency；若锁文件解析到不同版本，必须记录 decision 并重新确认。
I5 的 policy constants/delay unit assertions 已通过；保持 pending，直到 Unit B/C 的新 assistant ID chain 证明 runtime 总 attempts 上界。

## 8. 性能契约（机械化）

| ID   | 场景                            | 阈值 / bound                                        | 测量方法                        | 契约来源     | 验证结果 |
| ---- | ------------------------------- | --------------------------------------------------- | ------------------------------- | ------------ | -------- |
| `P1` | shared classifier 单次决策      | O(number of tools) 时间；O(number of tool IDs) 空间 | property test 大数组 + 代码审计 | subplan §4   | pending  |
| `P2` | SafeRetry chain                 | 新 attempts≤2；scheduled delay 恰为 2000/4000ms     | fake clock / policy unit test   | subplan §4.3 | pending  |
| `P3` | provider calls per logical turn | 1–3 logical requests；0–3 remote deliveries         | counted mock provider           | subplan §10  | pending  |
| `P4` | queue/backpressure              | N/A：不新增 queue                                   | dependency/diff audit           | subplan §10  | pending  |
| `P5` | timeout/watchdog                | N/A：继承既有 timeout，不新增 timer budget          | diff audit                      | subplan §10  | pending  |

自动化测试不得真实等待 2/4 秒；使用 policy 纯函数或 fake clock 断言。

## 9. 安全 / 副作用契约

| ID   | 允许副作用                                                      | 禁止副作用                                                  | 检查方法                          | 契约来源                    | 验证结果 |
| ---- | --------------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------- | --------------------------- | -------- |
| `E1` | 无 tool evidence 时重新发送 provider request；可能重复计费/计算 | 存在任何 tool evidence 时 SafeRetry                         | classifier property + call counts | architecture §8, subplan §4 | pending  |
| `E2` | settled tool result作为下一 turn context                        | re-execute/replay 同一 observed tool call ID                | executor spy                      | subplan §6–§8               | pending  |
| `E3` | ManualStop 写审计信息并终止                                     | 对 pending/running/interrupted/missing-result 猜测成功      | table/integration tests           | subplan §3–§4               | pending  |
| `E4` | failed attempt、usage、cost 和 recovery durable 保留            | 删除 partial audit record、覆盖成成功                       | storage snapshot diff             | architecture §2, §6         | pending  |
| `E5` | plugin 自身声明/保证 transform retry-safe                       | Session 把不可见 plugin 副作用当作已证明不存在              | design review + limitation docs   | architecture §8             | pending  |
| `E6` | current active process 内自动恢复                               | restart 后从历史 recovery 自动发 request                    | restart/load regression           | architecture §8, subplan §7 | pending  |
| `E7` | recovery 写入成功后创建 successor                               | persistence failure后自动 retry/continue                    | injected storage failure          | subplan §4.2, §6–§7         | pending  |
| `E8` | 同 provider/model保留 tool-required metadata                    | 将 response cache/prose/reasoning metadata 泄漏到 successor | projector snapshots               | subplan §8                  | pending  |

## 10. 跨实现一致性

| ID   | 实现 A                           | 实现 B / 参考向量                    | 一致性标准                                                                | 检查方法                         | 验证结果 |
| ---- | -------------------------------- | ------------------------------------ | ------------------------------------------------------------------------- | -------------------------------- | -------- |
| `X1` | legacy recovery classification   | current recovery classification      | 同一 facts 得到完全相同 action/reason/retry/tools                         | 共享 classifier + common vectors | pending  |
| `X2` | legacy assistant recovery schema | current assistant/Step.Failed schema | recovery wire shape 与 optional compatibility 相同                        | schema encode/decode snapshots   | pass     |
| `X3` | legacy projection                | current projection                   | Safe/Manual 全跳过；Continue 仅 settled tools；协议 metadata 语义等价     | paired projector vectors         | pending  |
| `X4` | legacy Prompt retry chain        | current runner retry chain           | 新 ID、limit=2、2s/4s、Safe 不消费 step、Continue 消费下一 step           | fake-clock integration           | pending  |
| `X5` | prompt/structured/Task           | legacy compaction                    | classifier/policy相同；compaction 因 tools 为空仅有 Safe/Manual           | shared policy + caller tests     | pending  |
| `X6` | raw-missing adapter failure      | generic/clean-EOF incomplete         | 都映射 recovery classifier；transport retryable 不决定 replay             | adapter/runner regressions       | pending  |
| `X7` | headless CLI                     | structured CLI/API observation       | intermediate recovery 均不 terminalize；最终成功/失败 exit semantics 相同 | end-to-end event traces          | pending  |

## Step 5 验证记录

- JSON Schema：pass；`session-recovery.test.ts` 检查 identifiers、required record、closed enums 和 optional message/event fields。
- Step 注释覆盖：P2 pass；P1、P3–P10 等 runtime 实施时继续按 §4 放置并用 `rg` 核对。
- 共享枚举 import：Unit A pass；LLM classification 复用 schema canonical literal；legacy/current runtime 接线仍 pending。
- 副作用 diff：pending；实施后审核 provider/tool 调用点、删除操作和新增持久化写入。
- 性能断言：policy 纯测试 pass；runtime fake clock pending，不做真实 6 秒等待。
- Property-based tests：Unit A 7 tests / 527 assertions，I1–I4、I6 pass；I5 runtime chain 及 I7–I10 pending。
- 项目尚未接入的检查项与跟踪 issue：全 schema package 存在与本变更无关的 event-manifest 基线失败，见 `decisions.md` W1；fake-clock harness 留待 Unit B。
