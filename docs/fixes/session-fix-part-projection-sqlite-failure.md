# Session Part 投影并发失败修正方案

- 状态：单元 1（诊断信息保真）已实施并验证；生命周期外键机制已确定性复现，等待选择因果修复契约
- 日期：2026-08-04
- 对应问题：[Issue #6](https://github.com/lihaokun/opencode/issues/6)
- 分析基线：`a22be532fc390ef0622f8f8cb95bb61746b3f841`
- fork `origin/dev`：`d12b1e924d7a18551767690e9f02294d0b3c6f1a`
- 分析时 `upstream/dev`：`6c3299103ce1494b4b37f5727199ac9539130534`
- 影响模块：durable event、Session projector、SQLite adapter、Session 错误投影、Session 删除生命周期
- 缺陷分类：非平凡并发/持久化缺陷；Issue 中首个 SQLite 失败原因尚未被保留下来，不能把推测当根因

## 一、现象与复现

### 1.1 现象

Issue 报告在同一个 headless server 上并发执行三个互相独立的 structured-output prompt 时，偶尔有
一个请求无法返回完成的 `StructuredOutput`，assistant 只保存为 `UnknownError`。服务端日志把首个
失败定位在 `PartUpdated` projector 对 `step-start` part 的 SQLite upsert；立即清理 session 后，
日志有时还会出现后续 `Session not found`。

Issue 目前保存的错误文本只包含 Drizzle 的外层消息：

```text
Failed query: insert into `part` ... on conflict (`id`) do update ...
```

它没有 SQLite `code`、`errno`、原始 `message` 或 Effect SQL reason。因此现有证据无法区分：

- `SQLITE_BUSY` / `SQLITE_LOCKED`；
- `SQLITE_CONSTRAINT_FOREIGNKEY`，例如 Message 已被 session 删除级联移除；
- 其他约束、序列化或 SQLite 错误。

### 1.2 触发条件

报告中的必要条件是：

1. 同一个 server 上至少三个独立 session 并发生成；
2. prompt 使用 `format.type = "json_schema"`；
3. provider stream 到达 `step-start`，processor 调用 `Session.updatePart()`；
4. durable `PartUpdated` 的同步 projector 在 SQLite upsert 时失败；
5. 失败随后被压成 `UnknownError`；
6. 测试端在请求结束后立即删除 session，偶尔再暴露生命周期尾部错误。

### 1.3 本地受控复现

第一阶段临时测试使用真实 `SessionPrompt.Service`、真实 durable event/projector、测试 LLM server 和
三个独立 session；三条 provider response 都产生完成的 `StructuredOutput` tool。每个变体执行
100 轮，每轮三个并发请求：

| 变体 | SQLite           | 并发/清理方式                                  | 请求数 | 结果     |
| ---- | ---------------- | ---------------------------------------------- | -----: | -------- |
| A    | `:memory:`       | 三请求完成后统一清理                           |    300 | 全部成功 |
| B    | 文件数据库 + WAL | 三请求完成后统一清理                           |    300 | 全部成功 |
| C    | 文件数据库 + WAL | 每个请求返回后立即清理自身 session             |    300 | 全部成功 |
| D    | 文件数据库 + WAL | provider gate 保证三流同步起跑；各自返回即清理 |    300 | 全部成功 |

合计 1,200 次 structured-output 请求均得到：assistant 无 error、有 structured result、
`StructuredOutput` part 为 `completed`。这批临时测试没有经过真实 TCP listener，也没有在 Git
仓库中触发 snapshot 子进程，因此不能排除部署拓扑差异。

第二阶段把诊断场景固化为真实 CLI 子进程、真实 TCP、文件 WAL 数据库、Git 仓库及 snapshot 子进程，
并用 provider gate 控制时序。整组测试重复三轮：

| 变体 | 精确时序                                                                    | 请求数 | 结果                                                        |
| ---- | --------------------------------------------------------------------------- | -----: | ----------------------------------------------------------- |
| A    | 3 个 prompt 并发；不删除 session                                            |      9 | 全部 HTTP 200，structured result 完整                       |
| B    | 3 个 prompt 并发；每个同步 prompt promise 返回后才删除自身 session          |      9 | prompt/delete 全部 HTTP 200                                 |
| C    | assistant Message 已提交、首个 Part 尚未写入时删除 session，再释放 provider |      3 | 3/3 得到 `ConstraintError` / `SQLITE_CONSTRAINT_FOREIGNKEY` |

C 在删除前通过只读 WAL 连接确认 parent Message 存在且 Part 数为 0；删除级联移除 Message 后，迟到的
`step-start` Part upsert 稳定失败。服务日志保留 reason/code 且不包含 prompt marker。

现有正式测试也通过：

- `packages/opencode/test/session/structured-output.test.ts`：22 pass；
- `packages/opencode/test/session/prompt.test.ts` 中 structured-output 长度终态定向用例：pass。

结论分成两层：普通三请求并发以及 Issue 声称的“同步 promise 返回后再删除”在等价真实拓扑中仍未
复现失败；删除与活跃 writer 重叠导致同一 `PartUpdated` SQL 外键失败，则已经成为确定性机制。后者
尚不能直接归因给 Issue，因为仍缺 Issue 调用端 DELETE 时间戳或原始 SQLite reason。

### 1.4 出错代码路径

```text
provider step-start
  → packages/opencode/src/session/processor.ts:447 handleEvent("step-start")
  → packages/opencode/src/session/session.ts:637 updatePart()
  → SessionV1.Event.PartUpdated durable publish
  → packages/core/src/event.ts:205 commitDurableEvent()
      BEGIN IMMEDIATE
      → packages/core/src/session/projector.ts:312 PartUpdated projector
          SELECT part
          INSERT part ... ON CONFLICT(id) DO UPDATE data
      → update event sequence
      → append durable event
      COMMIT
  → SQLite/Drizzle error
  → packages/opencode/src/session/processor.ts:662 halt()
  → packages/opencode/src/session/message-v2.ts:703 UnknownError
```

`part.message_id` 在 `packages/core/src/session/sql.ts:89` 引用 `message.id` 并启用
`ON DELETE CASCADE`。因此若失败是外键约束，最有价值的检查是同一时刻 parent Message 是否仍在；
若失败是锁超时，则要检查同一文件是否存在第二连接/进程以及 busy timeout 是否真正生效。

### 1.5 预期行为与实际行为

预期：三个独立 session 可以并发完成 structured output；若 SQLite 失败，日志至少保留可判定的
reason、原生 code/errno/message 和关联 event/session/message/part ID。只有可重试的锁类错误才可
在数据库事务边界进行有界重试；约束错误不得盲目重试。

Issue 现场的实际记录：一个请求失败，且错误降级为不含底层 cause 的 `UnknownError`，不足以判断
应该修锁竞争还是生命周期竞态。本轮单元 1 已让后续同类失败保留结构化诊断，但无法追溯补全 Issue
中已经丢失的原始 cause。

## 二、根因分析

### 2.1 已确认根因：数据库错误信息在错误投影中丢失

修改前，底层 SQLite 错误实际上已经被分类，但最终投影仍将它丢失：

1. `packages/core/src/database/sqlite.bun.ts` 捕获 Bun SQLite exception；
2. `classifySqliteError()` 把它包装为带结构化 `reason` 的 Effect `SqlError`；
3. `packages/effect-drizzle-sqlite/src/sqlite-core/effect/session.ts` 再包装为
   `EffectDrizzleQueryError`，并把前一错误放入 `Cause.fail(e)`；
4. projector 和 durable transaction 使用 `Effect.orDie`，使失败沿 defect/cause 路径传播；
5. `SessionProcessor.halt()` 只调用通用 `errorMessage(e)`；
6. `MessageV2.fromError()` 对普通 Error 只保存 `errorMessage(e)`，最终成为 `UnknownError`。

Drizzle 外层错误的 message 只打印 query/params，不打印其 `cause`。所以 SQLite 分类没有在底层消失，
而是在可观察日志和 assistant error 的最后投影中被忽略。本轮已针对这个边界完成修正。

### 2.2 Issue 首个写入失败原因仍未确认

不能根据 `PartUpdated` upsert 文本推断是 `SQLITE_BUSY`：

- 数据库初始化已设置 WAL、`busy_timeout = 5000`、`foreign_keys = ON`；
- `sqlite.bun.ts` 的连接由单许可 semaphore 保护，transaction 在 scope 内持有许可；
- durable event 使用 `BEGIN IMMEDIATE`，projector、sequence update 和 event append 在同一事务；
- headless API 的正常运行图使用共享 AppRuntime/memo map，预期只有一个 Database service；
- assistant Message 在 processor 启动、写入 `step-start` Part 之前被同步发布并持久化；
- processor 流事件以 `concurrency: 1` 顺序处理，prompt 在 processor 完成后才返回。

真实 TCP/Git/WAL 测试进一步显示，普通三请求并发和同步 prompt promise 返回后的立即删除均稳定
成功。单独制造第二 SQLite writer 持有 `BEGIN IMMEDIATE` 时，捕获到的是发生在事务起点的
`LockTimeoutError` / `SQLITE_BUSY`，而不是 `PartUpdated` 外键错误。

这些事实使“同一 AppRuntime 内仅三个 fiber 自己争用同一连接”不足以解释 Issue，也使“正常同步
请求返回后的删除抢先移除 Message”与当前实现不符。但它们不能排除 Issue 部署中存在额外连接/
进程，或调用方实际 DELETE 与 prompt 生命周期发生了重叠。只有把新的结构化诊断部署到等价环境，
或取得调用端 prompt-return/DELETE 与服务端 writer 的关联时间线，才能给 Issue 的首个失败定类。

### 2.3 已确认机制：删除可与活跃 writer 交叉

`Session.remove()` 会取消已登记的 background jobs、递归删除子 session、发布 Deleted 并移除
event state，但它没有和 `SessionRunState` 建立一个“busy session 不可删除”或“取消并等待所有
writer 退出”的屏障。删除 endpoint 同样没有调用 `assertNotBusy`。

确定性测试已经证明如下时间线：

```text
assistant Message 提交
  → provider 尚未释放首个 step-start
  → DELETE /session/:id 返回 200，并级联删除 Message
  → provider 释放 step-start
  → PartUpdated INSERT 引用已不存在的 message_id
  → ConstraintError / SQLITE_CONSTRAINT_FOREIGNKEY
```

因此“删除与活跃 writer 交叉会造成迟到 Part 外键失败”不再只是风险假设，而是已确认的生命周期
缺陷机制。processor 内 `step-finish` 启动的后台 summary 也能解释清理后的 `Session not found`。
不过，Issue 是否真的走了这条时间线仍未确认；其描述的同步 promise 返回后删除在当前测试中通过。

### 2.4 Workaround

对已确认的生命周期机制，可靠规避方式是不要在 prompt 仍活跃时删除 session；必须等同步 prompt
真正返回，且不要用 fire-and-forget/async endpoint 的提交响应替代运行完成信号。对 Issue 本身仍没有
已证明的 workaround，因为等价测试已经按其声称的返回后清理顺序运行成功。排查期间应保留失败
session/数据库和完整结构化 cause，避免清理覆盖现场。

### 2.5 同类风险点

- 其他 durable projector 同样大量使用 `.pipe(Effect.orDie)`，可能以相同方式丢失 SQL cause；
- 在 provider/prompt 层重试整个 turn 会重复模型调用、tool 执行和副作用；
- 无差别重试 constraint 会掩盖生命周期或数据不变量破坏；
- UnknownError 若直接暴露完整 SQL params，可能泄漏用户内容，客户端信息与服务端诊断字段必须分层。

## 三、参考实现对照（算法类 bug 必填）

本问题不是算法结果与参考实现不一致，因此算法逐步对照不适用。可依赖的规范性分类是当前已经使用的
Effect `classifySqliteError()`：约束错误为不可重试，busy/locked 为可重试的 lock timeout。修复必须
保留这一区分，不能用 query 文本或字符串包含关系重新猜测。

| 步骤 | 输入 / 状态                  | 当前实现                                  | 规范性处理                             | 首个差异                        |
| ---- | ---------------------------- | ----------------------------------------- | -------------------------------------- | ------------------------------- |
| 1    | Bun SQLite exception         | `classifySqliteError()` 生成结构化 reason | 相同                                   | 否                              |
| 2    | Drizzle query failure        | cause 被保存在包装对象中                  | cause 应继续可提取                     | 否                              |
| 3    | Session 日志/assistant error | 已提取安全诊断并用 message ID 关联        | 记录 reason、code、retryable 与关联 ID | 已修复                          |
| 4    | 是否重试                     | 当前没有 SQL reason 驱动的策略            | 仅 lock timeout 可在事务边界有界重试   | 待取得 Issue 原始 reason 后决定 |

参考来源：仓库锁定版本的 Effect SQL `classifySqliteError()` 及现有
`packages/core/src/database/sqlite.bun.ts` 调用方式。

## 四、修复方案

修复分为一个已完成的诊断单元和一个待选择契约的因果单元。单元 1 已使后续失败可定类；单元 2
仍需由 Issue 原始 reason 与删除 API 预期共同选择，不在证据缺失时同时加入锁重试和生命周期改造。

### 单元 1：数据库错误诊断信息保真（已实施）

- 在 SQL adapter/core 边界提供一个窄用途 extractor，遍历 `EffectDrizzleQueryError`、Effect Cause、
  `SqlError.reason` 和原生 cause，得到稳定字段：reason tag、operation、retryable、SQLite code、errno、
  原始 message；不得把 query params 放入客户端 error。
- `SessionProcessor.halt()` 的结构化日志加入上述字段及 session/assistant-message correlation；
  assistant message ID 同时作为客户端可返回的 correlation ref。
- assistant 继续使用稳定、安全的 public error；若需要让客户端关联服务端日志，优先使用现有
  `UnknownError.data.ref`，不直接泄漏 SQL 和 params。
- 用人工制造的 foreign-key failure 和第二连接写锁分别验证 extractor 能区分 Constraint 与
  LockTimeout；这两个测试是诊断测试，不声称都是 Issue 根因。

实现位于 `packages/core/src/database/sql-error.ts`、`SessionProcessor.halt()` 与
`MessageV2.fromError()`：服务端日志得到结构化诊断；客户端只得到安全的
`Database operation failed` 与 assistant message ID correlation ref。该单元消除“只有外层
UnknownError、无法选择正确因果修复”的已确认根因，不改变 provider 或 tool 执行语义。

### 单元 2A：仅当捕获到 LockTimeoutError 时

- 先确认运行图为何出现第二 writer；若是不必要的重复 Database layer，优先消除重复连接。
- 若多连接是受支持部署形态，在 `commitDurableEvent()` 的整个 `BEGIN IMMEDIATE` 事务外增加短小、
  有界、带 jitter 的重试；只接受结构化 `isRetryable` lock reason。
- 每次失败事务必须已 rollback；重试复用同一 event ID/payload，projector、sequence 和 event append
  仍在同一事务中。
- 禁止在 `SessionPrompt.prompt()`、LLM stream 或 tool 层重放整个 turn。

最小修正后逻辑：第二连接持写锁 → 第一次 `BEGIN IMMEDIATE` 得到可重试 lock reason → rollback/
等待 → 同一 durable event 再次提交 → projector、sequence、event 各只落库一次。

### 单元 2B：当 Issue 捕获到 ForeignKey Constraint，或产品契约要求防御活跃删除时

- 为 `Session.remove()` 与正在运行的 prompt/processor 建立明确契约：选择“busy 时拒绝删除”，或
  “请求取消并 join 所有 session writer 后删除”；实施前需确认 API 期望。
- 将 summary/compaction/background writer 纳入同一个生命周期屏障，保证 Deleted 提交后不再发布该
  session 的 Message/Part durable event。
- constraint 保持不可重试；缺 parent Message 时直接报告不变量破坏及关联 ID。

最小修正后逻辑：prompt 正在写 Part → 删除请求被拒绝，或等待 processor/background writer 完全
停止 → Deleted 级联清理 → 此后不存在迟到的 PartUpdated。

### 单元边界

单元 1 已独立实施和验证。受控重叠删除已证明 2B 所针对的机制真实存在，但不能替代 Issue 原始
reason；2A/2B 仍需按 Issue 证据选择。即使 Issue 最终是 LockTimeout，也可把“是否同时加固删除
生命周期”作为独立产品契约决策，而不能把 constraint 当成可重试错误。如果 reason 是第三类错误，
则以该错误建立新的最小复现后修订本计划。

## 五、正确性论证

- 根因消除：单元 1 保证当前已存在的 SQLite classification 不再在日志边界丢失；单元 2 只针对
  已证实的失败类型消除原因。
- 不变量保持：durable event 的 projector、sequence 和 append 继续原子提交；Part 必须有 parent
  Message；Deleted 后禁止新 writer；同一 provider/tool turn 不被数据库恢复策略重放。
- 无回归引入：诊断字段不含 query params；Constraint 不重试；锁重试有次数/时间上限；不同 session
  的成功路径不改变。
- 并发正确性：2A 在完整事务边界重试并复用 event identity，2B 在删除边界等待/拒绝而不是让删除与
  writer 交叉。
- Trivial 判定：不适用。本缺陷跨 durable transaction、projector、error cause 和 session lifecycle，
  且错误修复可能重复外部副作用。

## 六、测试用例清单

| 类型     | 用例描述                                                                  | 状态（修复后回填）               |
| -------- | ------------------------------------------------------------------------- | -------------------------------- |
| 现状基线 | 真实 TCP/Git/WAL 下 3 个独立 structured-output prompt；无清理及返回后清理 | 已固化；3 轮共 18 个 prompt 通过 |
| 机制复现 | Message 已提交、Part 未写入时删除 session，再释放 provider                | 已固化；3/3 为 FK Constraint     |
| 回归     | 嵌套 Drizzle/Effect/SqlError 的投影保留 reason、code、errno、retryable    | 已通过（单元 1）                 |
| 新增     | 缺失 parent Message 时写入 Part，稳定得到 foreign-key Constraint 诊断     | 已通过（单元 1）                 |
| 新增     | 第二 SQLite 连接持写锁，稳定得到 LockTimeout 诊断                         | 已通过（单元 1）                 |
| 边界     | 服务端诊断与客户端 error 不包含 query params/用户 prompt                  | 已通过（单元 1）                 |
| 条件回归 | LockTimeout 时只重试 durable transaction，成功后 event/projector 各一条   | 待定（仅 2A）                    |
| 条件边界 | Constraint、未知错误和超过重试上限时不重试                                | 待定（仅 2A）                    |
| 条件回归 | prompt 写入与 session remove 用 latch 确定性交叉，删除不会造成迟到 Part   | 待定（仅 2B）                    |
| 条件边界 | 删除 busy session 的 HTTP 行为与选择的拒绝/取消契约一致                   | 待定（仅 2B）                    |

## 七、代码更新清单

| 文件                                                                                       | 函数 / 行号            | 改动概述                                                           | 状态（修复后回填） |
| ------------------------------------------------------------------------------------------ | ---------------------- | ------------------------------------------------------------------ | ------------------ |
| `packages/core/src/database/sql-error.ts`                                                  | `extract()`            | 从嵌套 cause 提取安全结构化 SQLite 诊断                            | 已新增（单元 1）   |
| `packages/opencode/src/session/processor.ts`                                               | `parse()` / `halt()`   | 记录 reason/code 与 session/message correlation；不记录 SQL params | 已修改（单元 1）   |
| `packages/opencode/src/session/message-v2.ts`                                              | `fromError()`          | 数据库失败返回安全 UnknownError 与 correlation ref                 | 已修改（单元 1）   |
| `packages/core/test/database-sql-error.test.ts`                                            | SQL 诊断测试           | 真实 Constraint 与 LockTimeout 分类                                | 已新增（单元 1）   |
| `packages/opencode/test/session/message-v2.test.ts`                                        | error 投影测试         | 验证嵌套 cause、客户端 ref 与敏感参数隔离                          | 已修改（单元 1）   |
| `packages/opencode/test/cli/serve/session-part-concurrency-diagnostic.test.ts`             | 真实拓扑诊断           | 固化 A/B 正常路径及 C 生命周期 FK 机制                             | 已新增（诊断）     |
| `packages/opencode/test/lib/cli-process.ts`                                                | `ServeHandle.stderr()` | 向诊断测试暴露当前子进程 stderr 快照                               | 已修改（测试支持） |
| `packages/core/src/event.ts`                                                               | `commitDurableEvent()` | 仅在 LockTimeout 实证后增加事务级有界重试                          | 待定（仅 2A）      |
| `packages/opencode/src/session/session.ts`、session HTTP handler、run-state/background job | `remove()` 及删除入口  | 待删除 API 契约确认后建立 writer/delete 屏障                       | 待定（仅 2B）      |

单元 2 的具体文件清单将在 Issue 原始 reason 与删除契约确定后收窄，避免把受控机制直接等同于
Issue 根因。

## 八、文档更新清单

| 文档路径                                                   | 要改什么                                                 | 状态（修复后回填） |
| ---------------------------------------------------------- | -------------------------------------------------------- | ------------------ |
| `docs/fixes/session-fix-part-projection-sqlite-failure.md` | 记录分析、复现矩阵、证据边界和条件修复计划               | 已新增（待提交）   |
| 同一修复计划                                               | 回填诊断单元、真实拓扑 A/B/C 与证据边界                  | 已更新（待提交）   |
| 同一修复计划                                               | 回填 Issue 环境原始 reason、选定的 2A/2B、回归测试及提交 | 待更新             |

本轮不修改公开 API/schema 契约。若单元 2B 选择改变删除 endpoint 的 busy 行为，实施前必须补充该
接口的契约说明和测试，并再次经过确认门。
