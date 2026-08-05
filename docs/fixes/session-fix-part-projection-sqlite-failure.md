# Session Part 投影并发失败修正方案

- 状态：单元 1（诊断信息保真）已实施并验证；timeout/transport cleanup 竞态已由真实 TCP 对照和 Runner ownership 实验确认，但公开 caller 使用局部 session ID、每请求独立 Hyper client、600 秒默认 reviewer timeout，已知 OpenCode/Bun 连接链也没有约 40 秒 response deadline，故该竞态作为 Issue 根因的优先级已明显下调；Issue 的 `EffectDrizzleQueryError: Failed query: insert into part` 已证明失败发生于 statement execution，而非 prepare/schema/参数编码阶段；Part query 位于已成功的 `BEGIN IMMEDIATE` 内，普通 WAL writer 竞争、durable event 重排、生产 native/Drizzle 旁路和 reviewer session 串线均已反证；`SQLITE_FULL` 容量实验的最终错误形态也与 Issue 不同，但 `IOERR/NOMEM` 等资源错误仍不能仅凭该实验排除；根因继续等待原始 reason、删除来源与 caller outcome 关联确认
- 日期：2026-08-05
- 对应问题：[Issue #6](https://github.com/lihaokun/opencode/issues/6)
- 分析基线：`b95397f5c07418f21d34e0cba9fecc8aafed6571`
- 初始工作基线：`a22be532fc390ef0622f8f8cb95bb61746b3f841`
- fork `origin/dev`：`d12b1e924d7a18551767690e9f02294d0b3c6f1a`
- 分析时 `upstream/dev`：`6c3299103ce1494b4b37f5727199ac9539130534`
- 影响模块：durable event、Session projector、SQLite adapter、Session 错误投影、Session 删除生命周期、Snapshot 共享串行通道、外部 judge caller cleanup 契约
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

第三阶段用原始 HTTP `fetch` + `AbortController` 模拟 Rust/Hyper future 被 timeout drop；中止点固定在
assistant Message 已 durable commit、Part 数仍为 0 之后。两个临时诊断变体各重复三轮：

| 变体 | 精确时序                                                   | 结果                                                                      |
| ---- | ---------------------------------------------------------- | ------------------------------------------------------------------------- |
| E    | abort HTTP waiter → 不删除 session → 释放 provider         | 3/3 客户端 rejection；Runner 写入 Part、回到 idle，structured 完整，无 FK |
| F    | abort HTTP waiter → 新连接 DELETE 返回 200 → 释放 provider | 3/3 得到 `ConstraintError` / `SQLITE_CONSTRAINT_FOREIGNKEY`               |

E 通过只读 WAL 连接确认最终 assistant durable JSON 含 structured result 且无 error；F 证明客户端
waiter 已结束后，独立 DELETE 仍能击中继续运行的服务端 writer。这组临时诊断在结论确认后已移除，尚未
作为正式回归用例提交。

现有正式测试也通过：

- `packages/opencode/test/session/structured-output.test.ts`：22 pass；
- `packages/opencode/test/session/prompt.test.ts` 中 structured-output 长度终态定向用例：pass。

结论分成两层：普通三请求并发以及 Issue 声称的“同步 promise 返回后再删除”在等价真实拓扑中仍未
复现失败；删除与活跃 writer 重叠导致同一 `PartUpdated` SQL 外键失败，则已经成为确定性机制。后者
是独立存在的生命周期缺陷，但尚不能直接归因给 Issue，因为仍缺 Issue 调用端 DELETE 时间戳、实际
endpoint 和原始 SQLite reason。

### 1.4 同步端点的 happens-before 结论

同步 `POST /session/:id/message` handler 在构造 HTTP response 前会完整 `yield* promptSvc.prompt(...)`。
`SessionPrompt.prompt()` 先创建 user message，再进入 `loop()`；`loop()` 通过
`SessionRunState.ensureRunning()` 等待 Runner 中的主处理流程结束。主流程中，assistant Message 先通过
durable event 提交，随后 processor 才处理 provider 的 `step-start` 并尝试写入 Part。因此同步成功或
失败路径至少满足以下顺序：

```text
assistant Message durable commit
  happens-before 首个 step-start Part INSERT 尝试
  happens-before SessionPrompt.prompt settle
  happens-before 同步 /message response 完成
  happens-before await sdk.session.prompt(...) 返回/抛错
  happens-before 调用方 post-await DELETE 开始
```

由此可得：如果 Issue 调用端确实执行的是
`await sdk.session.prompt(...); await sdk.session.delete(...);`，则该 DELETE 不可能反向导致此前已经执行的
首个 `step-start` Part INSERT 失败。受控变体 B 的成功结果与这一代码级顺序一致。

通用排查仍需注意“表面上 await、实际上提前清理”的情况：

- `try { return sdk.session.prompt(...) } finally { await deleteSession() }` 会先执行 `finally`，应使用
  `return await sdk.session.prompt(...)` 才能把清理放在 promise settle 之后；
- 实际请求若是 `/session/:id/prompt_async`，handler 会 fork prompt 并立即返回 204，响应不是完成信号；
- 并发清理若闭包或 session-ID 映射错误，可能删除仍在运行的另一个 session；
- workspace removal 会遍历并删除其 sessions；插件、event subscriber 或其他外部 actor 也可能在
  assistant Message 已提交、provider/snapshot 尚在 yield 时触发删除。

真实调用端现已定位，且存在另一条更具体的重叠路径：调用端对同步 `/message` 自行施加 timeout；timeout
只终止客户端等待，不代表服务端 Runner 已结束，随后立即发起的独立 DELETE 可以与服务端 writer
交叉。具体契约和时间线见下一节，真实 TCP 变体 E/F 已验证这一机制。然而 Issue 明确描述失败请求
返回了包含 `info.error.name = UnknownError` 的完整响应；若该描述来自 OC2 的实际 outcome，则本机制
不能解释这批记录。

### 1.5 真实调用端与跨进程时间线

Issue 的调用端已定位到 `lihaokun/mcp-server-fsm` 的
[`crates/server/src/agent_cli.rs`](https://github.com/lihaokun/mcp-server-fsm/blob/1dc5577c6e78b373306d5d3dbe14e0535864e57f/crates/server/src/agent_cli.rs#L235-L295)
（分析版本 `1dc5577c6e78b373306d5d3dbe14e0535864e57f`）。其 OpenCode 适配流程是：

```text
OC1: POST /session 创建 title = "fsm-gate" 的临时 session
OC2: bounded(prompt_timeout, POST /session/:id/message)
OC3: bounded(15s, DELETE /session/:id)
OC4: 对 OC2 的结果执行 extract_structured(&prompted?)
```

关键点是 OC3 在传播 `prompted?` 之前无条件执行。`bounded()` 使用 `tokio::time::timeout`；超时时会
drop 正在等待的 HTTP future。`http_json()` 为每次调用创建新的 Hyper client，并等待 response body
完整 collect。因此：

- 若 OC2 成功收完整 response body，则服务端同步 prompt 已 settle，满足 1.4 的 happens-before，OC3
  不可能造成此前首个 Part INSERT 失败；
- 若 OC2 timeout，或发生 request/body transport error，则客户端只知道“未取得确定结果”，不知道服务端
  prompt 是否结束；OC3 会通过新连接立即 DELETE，不能继承 OC2 连接上的完成或 FIFO 保证；
- 服务端 prompt 已被接受而客户端等待被 drop 时，OpenCode Runner 仍可继续。Runner 由
  `SessionRunState` 的 instance scope 通过 `Effect.forkIn(scope)` 持有，不归 HTTP request fiber 所有；
  `Session.remove()` 只取消已登记的 `BackgroundJob`，没有取消或 join 该 Runner。

除真实 TCP E/F 对照外，直接针对 `Runner.make()` 的无文件 ownership 实验也固定了这一语义：启动一个
延迟完成的 `ensureRunning(work)`，5 ms 后 interrupt 仅负责等待结果的 fiber，此时观察到
`runner.busy === true` 且 work 未完成；再等待 70 ms 后观察到 work 已完成且 Runner 回到 idle。也就是
“caller 不再等待”与“服务端工作已停止”是两个不同事件，连接/future 生命周期不能充当 writer
lifecycle barrier。

由此得到一条完整、可执行的候选因果链：

```text
POST /message 已被服务端接受
  → assistant Message durable commit
  → provider/snapshot 仍在运行
  → 客户端 timeout 或 request/body transport failure，HTTP waiter 被 drop
  → judge_opencode 在新连接上无条件 DELETE 临时 session
  → Session 删除级联移除 parent Message
  → OpenCode Runner 继续处理首个 step-start
  → Part INSERT 引用已不存在的 Message
  → SQLITE_CONSTRAINT_FOREIGNKEY
```

“三个并发请求”的来源也与 Issue 精确吻合：
[`crates/client/src/review.rs`](https://github.com/lihaokun/mcp-server-fsm/blob/1dc5577c6e78b373306d5d3dbe14e0535864e57f/crates/client/src/review.rs#L633-L660)
在未配置 `n_reviewers` 时默认启动 3 个并行 reviewer。vote reviewer 默认 timeout 为 600 秒且可配置；
stop-gate timeout 为 30 秒。因此三路 fan-out 是强 provenance 证据，但 timeout 是否实际发生仍取决于
调用模式和现场配置，不能仅由并发数推出。

进一步审计 vote 聚合器可见，它按创建顺序 `await` 全部三个 `JoinHandle`，不会在达到投票阈值后提前
取消剩余 reviewer；公开配置中 reviewer 默认 timeout 明确为 600 秒，MCP 请求 timeout 为 1 小时，
固定版本仓库内也没有 `timeout_seconds: 30` 的 reviewer 配置。因此不能把 stop-gate 的 30 秒 deadline
套到三路 vote reviewer；只有现场 YAML/运行日志证明有效 `timeout_seconds` 小于请求尾延迟，才能确认
caller timeout 前提。

已知 HTTP 连接链也没有恢复出一个隐含的 40 秒 response deadline。`v1.17.8` 的 OpenCode server 通过
Node `createServer()` 建立 listener，没有设置 response timeout；本机同类 Bun runtime 的默认
`requestTimeout=300000` 约束接收请求体，`headersTimeout=60000` 约束接收请求头，
`keepAliveTimeout=5000` 发生在响应之后，均不能在已收完的小型 OC2 请求上于约 40 秒终止服务端处理。
Rust `http_json()` 也没有除 `bounded(prompt_timeout, ...)` 之外的 read/response timeout，且目标是直接
localhost endpoint，没有代码内代理层。故在没有未保存 YAML、自定义 binary、外部代理或不同 runtime
默认值的前提下，当前可见连接模型不能把 39.9 秒窗口转换成 timeout-cleanup。

`http_json()` 只有在 response body 完整 collect 并成功解析 JSON 后才返回 `Ok(Value)`；OC3 虽然在
`extract_structured(&prompted?)` 之前执行，但此时 `prompted` 已是不可被 DELETE 改写的本地 JSON。
因此 outcome 分叉是确定的：

- `prompted = Ok(response with UnknownError)`：Part failure 已在 OC3 之前发生，2C 对该次记录被排除；
- `prompted = Err(Timeout | request/body transport error)`：OC3 可与 Runner 重叠，但函数最终传播
  `JudgeError::Timeout/Http`，不会向上返回 `Structured("UnknownError")`。

三路 reviewer 的 session 关联也已按公开源码闭合：`run_vote_review()` 为每个 `tokio::spawn` 克隆
`SoftCheck`、变量 map 和 cwd，每个 task 独立进入 `judge_opencode()`；OC1 response 中取得的 `sid` 只
保存在该调用栈的局部 `String`，OC2 和 OC3 都由同一局部值构造 path。每次 `http_json()` 又创建独立
Hyper client，并由对应 request future 收取 body，不存在共享数组下标、全局 session cache 或手工
response-ID 映射。公开仓库的 Rust 调用面搜索中，向 OpenCode 发 `hyper::Method::DELETE` 的位置也只有
`agent_cli.rs`，没有按 `fsm-gate` title 批量回收的第二个 actor。因此公开 caller 内部“一个 reviewer
误删另一个 reviewer session”已被代码反证；若现场发生这种删除，只能来自未记录版本或 caller 外部。

Issue 示例同时提供了可从 ID 还原的时间证据。ID 的前 12 个十六进制字符编码
`timestamp * 0x1000 + counter` 的低 48 位；以 SQL 中已知的 `time_created=1785600488974` 选择最近的
时间环，可还原为：

| 现场对象                | 还原的 UTC 时间          | 相对 Part SQL |
| ----------------------- | ------------------------ | ------------: |
| Session ID              | 2026-08-01 16:07:29.014Z |    -39,960 ms |
| assistant Message ID    | 2026-08-01 16:07:29.043Z |    -39,931 ms |
| step-start Part ID      | 2026-08-01 16:08:08.973Z |         -1 ms |
| Part SQL `time_created` | 2026-08-01 16:08:08.974Z |          0 ms |

这证明 Session 创建和 assistant Message 生成后，约 39.9 秒才到达首个 Part SQL。该时长在数值上贴近
40 秒，但已知 caller/server/runtime 链没有对应 deadline；默认 reviewer timeout 又是 600 秒。因此它
目前只证明首 Part 前存在长尾窗口，不能继续单独作为 timeout-cleanup 的强证据。只有原始配置或代理
日志恢复出约 40 秒 deadline，且 caller outcome 为 timeout/transport ambiguity，才能重新解释几十毫秒
差值是连接、解析和调度开销。

还需要修正此前对这段窗口的代码路径描述：processor 在启动 LLM stream 之前会无条件预捕获 initial
Snapshot，随后才解析 tools/system/plugin 输入并启动 provider；AI SDK 在收到首个有效 stream chunk 后发出
`step-start`。handler 通常复用 initial Snapshot，只有该值为 `undefined` 或空字符串时才再次
`snapshot.track()`，然后生成 Part ID。因此 39.931 秒区间的严格分解是：

```text
assistant Message ID/commit
  → initial Snapshot wait + Git track
  → tools/system/plugin 与 model-message 准备
  → provider request / 首个有效 stream chunk
  → 可选的 Snapshot fallback（仅 initial 结果为 falsy）
  → PartID.ascending()
  → Part durable transaction
```

Issue Part payload 已包含非空 snapshot hash，证明写 Part 前至少一次 track 成功，但不能单凭 payload
判断成功的是 initial capture 还是 fallback。ID 只能证明整个前置窗口，不能把 39.931 秒全部归因给
Snapshot，也不能精确分摊 provider 首 chunk 和其他准备阶段。

`Snapshot.Service` 内部按 snapshot `gitdir` 维护单许可 semaphore；同一 worktree 的三个 session 会在
各自的 initial capture 上共享串行通道，其他 session 已经排入队列的 completion snapshot、patch、
restore 或 cleanup 也使用同一锁。因此“独立 session”不等于首 Part 前没有共享排队点。Snapshot 的 Git
子进程没有隐式 timeout；进程执行层也没有额外的全局队列。Git 调用失败会被 Snapshot 降级为普通
结果，最多导致空 hash 和 `step-start` fallback，不能直接生成 Part SQL 错误。Snapshot 本身不删除
Message、不访问 SQLite，故只能作为 timeout-cleanup 的延迟放大器，不能单独解释 Part SQL 失败。
默认 600 秒 reviewer timeout 下，39.9 秒仍不足以触发 cleanup；若现场有效 timeout 小于该尾延迟，
才形成“共享队列放大延迟 → OC2 timeout → OC3 DELETE → 迟到 Part FK”的完整候选链。

部署 provenance 仍缺一项：Issue 没有记录实际 OpenCode binary 的 commit/version。调用端设计材料引用
的 `v1.17.8`、fork 基线 `d12b1e924d`（v1.18.6）和当前分析基线都已逐项核对：initial Snapshot
预捕获、单连接 semaphore、durable event 的 `BEGIN IMMEDIATE`、Part projector 与 parent FK 语义均
成立。相关版本之间虽有 session 终态和 event 重构，首个 Part 的上述锁序与 parent theorem 没有改变；
现场仍应补录实际部署 SHA，以排除使用未纳入比较的自定义 binary。

公开现场追踪没有恢复出缺失证据：`lihaokun/mcp-server-fsm` 在 2026-08-01 前后的公开 GitHub Actions
中没有对应运行，最新一条是 2026-07-24 的成功 CI；其唯一 CI workflow 只执行 Rust fmt/clippy/test、
daemon/hook e2e 和 installer tests，没有启动真实 OpenCode structured-output reviewer，也没有上传这类
运行日志或数据库 artifact。Issue 本身也没有 comment 或额外附件。因此原始 caller outcome、有效
timeout 和 SQLite reason 只能从原运行环境或下一次复现取得，不能由公开 CI 追溯补全。

本机默认运行目录同样没有保留原现场：`~/.mcp_server_fsm` 不存在，OpenCode data/log/config 目录为空，
目标 session ID 只命中本次分析记录，没有命中原始数据库或日志；环境中也没有自定义 `XDG_DATA_HOME`
或 OpenCode/FSM 路径变量。由此不能从当前主机默认 XDG 路径补回 8 月 1 日的 effective timeout、DELETE
时间戳或 SQLite extended code。

当前结论应表述为：**timeout-cleanup 是已确认的独立生命周期缺陷机制，Snapshot 是已确认的共享延迟
放大边界；但公开 caller 的 session 关联、默认 timeout、已知连接链和 Issue 所述完整 `UnknownError`
响应共同反证它是这 7 次记录的默认解释。** 只有原始 caller 日志证明实际 outcome 是
timeout/transport ambiguity、存在足够短的有效 deadline，且同一 session 的新诊断为 FK，才能把 2C
重新提升为 Issue 根因。

### 1.6 出错代码路径

```text
assistant Message durable commit
  → packages/opencode/src/session/processor.ts:124 create()
      → initial snapshot.track()
          等待同 snapshot gitdir 的单许可 semaphore
          → git diff/add/write-tree
  → tools/system/plugin/model-message 准备
  → provider 首个有效 stream chunk
  → packages/opencode/src/session/processor.ts:449 handleEvent("step-start")
      → initial snapshot 为 falsy 时才 fallback snapshot.track()
      → PartID.ascending()
  → packages/opencode/src/session/session.ts:637 updatePart()
  → SessionV1.Event.PartUpdated durable publish
  → packages/core/src/event.ts:205 commitDurableEvent()
      等待 Database transaction semaphore
      BEGIN IMMEDIATE 成功
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
`ON DELETE CASCADE`。因此若失败是外键约束，parent Message 必须在 Part transaction 取得 semaphore
并成功执行 `BEGIN IMMEDIATE` 之前就已被删除；删除不能在 BEGIN 与 INSERT 之间插队。若失败是锁类，
需要先区分事务起点的普通 `SQLITE_BUSY` 与 Part statement 上的非常规 `SQLITE_LOCKED`/schema lock，
不能把二者统一归因于 WAL writer 竞争。

### 1.7 预期行为与实际行为

预期：三个独立 session 可以并发完成 structured output；若 SQLite 失败，日志至少保留可判定的
reason、原生 code/errno/message 和关联 event/session/message/part ID。只有可重试的锁类错误才可
在建立对应最小复现后处理；2A 只允许已确认发生于事务起点的 lock error 在数据库事务边界有界重试，
约束错误和未解释的 Part-statement lock 不得盲目重试。

Issue 现场的实际记录：一个请求失败，且错误降级为不含底层 cause 的 `UnknownError`，不足以判断
应该修锁竞争还是生命周期竞态。本轮单元 1 已让后续同类失败保留结构化诊断，但无法追溯补全 Issue
中已经丢失的原始 cause。

### 1.8 原始环境下一轮诊断协议

在 `yixiao-issue-6` 上运行原始 provider/harness，并对每个 session 记录单调时钟时间线：

```text
oc1.create
  → oc2.start
  → oc2.outcome(success | timeout | request_error | body_error | status_error | parse_error)
  → oc3.start
  → oc3.outcome
```

每条记录必须包含实际 endpoint、session ID、单调时钟、耗时和结果；运行头还必须记录实际 OpenCode
commit/version、`mcp-server-fsm` commit、有效 reviewer `timeout_seconds`、`n_reviewers`、Snapshot 是否启用
以及数据库文件路径。先保持当前调用端行为作为基线；诊断变体只改变一个条件：OC2 为
timeout/request/body transport ambiguity 时跳过 OC3，保留 session 和数据库现场。OC2 已完整收包时仍
可执行 cleanup。第一次失败后从服务端诊断提取：

- `database.reason`、`database.code`、`database.errno` 与关联 assistant message ID；
- `assistant-message.commit`、`snapshot.initial.wait.start`、`snapshot.initial.lock.acquired`、
  `snapshot.initial.end`、tools/system 准备完成、`provider.request.start`、`provider.first-chunk`、
  `provider.step-start.received`、可选 `snapshot.fallback.*`、`part-transaction.wait.start`、
  `part-transaction.begin.succeeded` 与 `part-upsert.start` 的同一单调时钟；
- 每个 Session/Message 删除事件的入口来源（HTTP session DELETE、workspace removal、CLI、revert、
  remote replay 或外部 writer）、request/admission/transaction begin/commit 时间与关联 ID；
- 若为 Constraint：在清理前查询 Session、parent Message、目标 Part 是否存在，并运行
  `PRAGMA foreign_key_check`；由于 `Session.remove()` 随后会清除该 aggregate 的 durable event history，
  必须先保存删除 source 日志和数据库现场；
- 若为 LockTimeout：记录失败 query 是 `BEGIN IMMEDIATE` 还是 Part，并枚举同一数据库文件的其他
  process/connection；Part statement 上若为 `SQLITE_LOCKED`，还要记录扩展 code、数据库 open URI、
  shared-cache 配置和未完成 statement；
- 无论错误分类，都记录 `PRAGMA integrity_check`、`journal_mode`、`foreign_keys`、`busy_timeout`、
  `compile_options`、`database_list` 以及磁盘/文件系统状态；
- 若无清理/all-settle 变体仍失败：优先调查 statement-specific 资源错误，而不是继续调整 DELETE
  时序。

同一原始 harness 再运行两个单变量对照：一组设置 `snapshot: false`，观察三路 Message→Part 尾延迟与
失败是否消失；另一组保留 Snapshot，但只对 ambiguous outcome 禁止 DELETE。前者只能判断 Snapshot
是否为延迟放大器，不能单独证明 SQLite 根因；后者与 E/F 一起判断 DELETE 是否为 FK 的必要破坏动作。

判定标准：

- 若 OC2 成功收完整 response body，body 内已经包含 `UnknownError`，则对该次失败否定 2C，必须用
  `database.reason` 在服务端内部继续定类；Issue 当前文字描述属于这一分支，但仍需原始 outcome 日志
  复核；
- 若 caller 实际记录 `Timeout` 或 request/body transport error，且同一 session 出现 FK；跳过 OC3 后
  FK 消失，则确认 2C；若 initial/fallback Snapshot wait 占据主要尾延迟，则同时确认它是触发概率
  放大器而非删除根因；
- 若 ambiguous outcome 但无 FK，或完整 response 与第三类 SQLite reason 相关，则为该 reason 建立新的
  最小复现，不能把 timeout 与任意 UnknownError 自动关联。

该协议的目标是同时建立“错误类型”“caller 观察到什么”和“谁先于谁”的证据；只取得其中一项仍
不足以选择 2A/2B/2C。

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

Issue 的外层错误已经把失败阶段限定为 statement execution。`sqlite.bun.ts` 在进入 execution `try`
之前调用 `native.query(query)` 并准备 statement；只有 `statement.all()` 位于 `try` 内并会被转换成 Effect
`SqlError`，随后 Drizzle 才会生成带 `Failed query: ...` 的 `EffectDrizzleQueryError`。使用真实 Bun
SQLite adapter 的无文件对照得到：

| 注入错误                                                         | 可观察结果                                                               |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 对不存在的表执行 INSERT（prepare 阶段）                          | 原生 `SQLiteError: no such table` defect；没有 `EffectDrizzleQueryError` |
| 对 `NOT NULL` 列执行 `INSERT ... VALUES(NULL)`（execution 阶段） | `EffectDrizzleQueryError: Failed query ...`，cause 为 Constraint/NOTNULL |

因此 Issue 的精确 wrapper 证明 SQL 已经成功 prepare，失败发生在 `statement.all()` 真正执行时。表/列不存在、
malformed SQL、常规并发 migration/schema prepare failure 等解释与该 wrapper 冲突。Drizzle 的 JSON
参数编码和 placeholder 填充又发生在 executor 之前；Issue 日志已打印完整的小型 `step-start` JSON，故
循环 JSON、placeholder 编码等参数准备失败也不能产生这条外层错误。

普通 WAL writer 竞争现在有更强的反证。每个 durable event 都使用
`db.transaction(..., { behavior: "immediate" })`，所以事务顺序是：

```text
等待单连接 transaction semaphore
  → BEGIN IMMEDIATE 成功
  happens-before projector SELECT/INSERT Part
```

SQLite 的[事务语义](https://www.sqlite.org/lang_transaction.html)与
[result-code 说明](https://sqlite.org/rescode.html)保证：成功的 `BEGIN IMMEDIATE` 已取得后续写入
所需的权限，同一连接在该事务内的后续数据库操作不会再返回普通 `SQLITE_BUSY`。如果另一个普通
writer 已持有写锁，当前连接应在 `BEGIN IMMEDIATE` 处失败，projector 的 Part 语句不会开始；事务起点
通过 SqlClient raw statement 执行，也不会被包装成打印 Part SQL 的 `EffectDrizzleQueryError`。Issue
保存的外层错误却明确是 Part INSERT，因此“同一 AppRuntime 内三个 fiber 或第二进程单纯争用 WAL
writer”不仅优先级低，而且与当前失败位置直接冲突。

双连接 WAL 实验进一步固定了边界：

| 时序                                           | 结果                                                 |
| ---------------------------------------------- | ---------------------------------------------------- |
| A 已 `BEGIN IMMEDIATE`，B 再 DELETE parent     | B 得到 `SQLITE_BUSY`；A 的 Part INSERT 成功          |
| B 先提交 DELETE parent，A 再 `BEGIN IMMEDIATE` | A 的 Part INSERT 得到 `SQLITE_CONSTRAINT_FOREIGNKEY` |
| B 只持有普通 WAL read transaction              | A 的 `BEGIN IMMEDIATE` 与 Part INSERT 均成功         |

因此若现场 reason 是 FK，破坏 parent 的 DELETE 必须在 Part transaction 成功 BEGIN 之前提交；若现场
reason 是 lock，普通 writer 只能解释事务起点的 `SQLITE_BUSY`，Part statement 上则需要另行复现
[shared-cache](https://www.sqlite.org/sharedcache.html)、table/schema/reentrant 等非常规
`SQLITE_LOCKED` 形态。

其他已确认事实也支持这一判断：

- 数据库初始化已设置 WAL、`busy_timeout = 5000`、`foreign_keys = ON`；
- `sqlite.bun.ts` 的 transaction acquirer 在整个 transaction scope 内持有单许可 semaphore；相关
  durable Message/Part/Delete projector 均通过该路径串行化。普通 acquirer 的许可虽然只覆盖“返回
  connection”这一 Effect，但生产 `run()`/`runValues()` 随后执行的 `native.query(...).all()/values()`
  是同一 JS fiber 内无 yield 的同步调用，permit 释放时等待 transaction 的 fiber 只会进入后续调度；
  statement 中间没有可供另一事务插入的异步边界。当前未实现的 stream 路径不参与 Issue；
- headless API 的正常运行图使用共享 AppRuntime/memo map，预期只有一个 Database service；
- assistant Message 在 processor 启动、写入 `step-start` Part 之前被同步发布并持久化；
- processor 流事件以 `concurrency: 1` 顺序处理，prompt 在 processor 完成后才返回。
- 固定版本的生产代码没有通过裸 `bun:sqlite`/native connection 绕过 Database semaphore 的 consumer，
  也没有调用 native SQLite `interrupt()`；正常运行图中没有第二个 shared-cache connection，所有已知
  statement 都被 `.all()`/`.values()` 完整消费。因此同连接 reentrant/unfinalized cursor、显式
  interrupt 和 shared-cache table lock 只能由未记录的自定义 plugin/connection 引入，不是标准路径。

前两个成功 prompt 返回后立即删除各自 session，也不能通过“删除造成数据库忙”污染仍在运行的第三个
session：这些 DELETE 与第三个 Part durable transaction 经过同一 transaction semaphore 形成全序，
且不同 session 的级联删除不会移除第三个 parent Message。只有删错 session ID、在第三个 prompt settle
前删除其自身 session，或绕过该 Database service 的外部 actor 才可能破坏第三个 parent。

Part INSERT 的 statement-specific 候选仍包括：parent Message 在 BEGIN 前已不存在造成的 foreign-key
constraint；磁盘满、I/O、corruption、readonly、内存不足等 SQLite 资源错误；以及由未观测额外连接或
plugin 引入的 shared-cache/table/schema/reentrant 等非常规锁形态。当前 schema 中 `id` 主键冲突已有
`ON CONFLICT DO UPDATE`，所有 `NOT NULL` 参数均已出现在日志，`session_id` 没有 FK；因此对这组具体
参数，`message_id → message.id` 是唯一现实约束候选。

资源错误还可继续分层：`SQLITE_TOOBIG` 与仅含 snapshot/type 的小型 payload 冲突；`SQLITE_INTERRUPT`
与无 native interrupt 调用及 transaction uninterruptible 边界冲突；`SQLITE_READONLY` 必须解释为何
同一 prompt 的 assistant Message 刚刚还能写入；corruption 通常会产生持续或更多查询失败。`SQLITE_FULL`、
`SQLITE_IOERR`、`SQLITE_NOMEM` 仍可在 statement execution 偶发出现，但当前没有磁盘、quota、文件系统
或进程资源证据，也没有解释“三路中经常恰好一路”的代码机制，故保持次级但不排除。同步端点的
happens-before 又否定了“正常 post-await DELETE 抢先删除 parent”，所以即使 FK 是最现实 constraint，
也不能在取得原始 reason/caller outcome 前把 Issue 正式定为 foreign-key failure。

针对 `SQLITE_FULL` 又完成了真实 Effect + Drizzle + Bun SQLite 容量实验。内存库与 WAL 文件库都先
成功提交 parent Message，再把 `max_page_count` 固定到当前页数；`BEGIN IMMEDIATE` 成功后，使用大 Part
payload 强制 INSERT 得到 `SQLITE_FULL`。两种 journal mode 下 SQLite 都自动结束了事务，transaction
finalizer 随后执行 `ROLLBACK` 并得到 `cannot rollback - no transaction is active`，最终暴露的是裸
Effect `SqlError`，而不是 Issue 的 `EffectDrizzleQueryError: Failed query: insert into part`；parent
Message 保留，Part 为零，之后 DELETE parent 仍可成功。这使该实验覆盖的典型容量耗尽路径与 Issue
外形不相容。SQLite 官方语义同时说明 `FULL/IOERR/NOMEM/INTERRUPT` 可能只回滚当前 statement，也可能
回滚整个事务，取决于失败点；故这个结果显著下调 `FULL`，但不能逻辑外推为彻底排除所有
`IOERR/NOMEM` 或所有可能的 `FULL` 失败点。

真实调用端和 TCP 对照把候选改成条件决策树，而不是单一排序：

1. **完整 OC2 response 已含 `UnknownError`（Issue 当前描述）**：2C 被排除。优先取得
   `database.reason`；剩余候选是其他显式/错误的 Session/Message 删除，以及只在 Part statement 暴露
   的 constraint/磁盘/I/O/corruption/shared-cache 等错误。prepare/schema/参数编码已经由 wrapper 形态
   排除，标准运行图中的 shared-cache/reentrant lock 也受到连接图反证；因此若新诊断为 Constraint，
   parent Message 的未观测删除成为压倒性候选，若不是 Constraint，则优先从
   `SQLITE_IOERR/NOMEM` 等 execution-time 资源错误重新建立最小复现；`SQLITE_FULL` 还必须解释为何没有
   出现实验中的自动回滚/rollback-finalizer 错误形态。入口审计未发现按 `fsm-gate` title、TTL、
   request completion 或 Snapshot 自动删除 Session 的内部逻辑，所以“未观测的 OpenCode 自动清理”
   优先级下调；显式 workspace/message/session 删除、remote replay 和外部数据库 writer 仍需用 source
   日志排除。
2. **OC2 timeout/request/body transport ambiguity**：若同一 session 的 reason 是 FK，则调用端无条件
   OC3 成为最高候选；真实 TCP E/F 已证明 abort 本身安全完成，而 abort + DELETE 稳定制造 FK。Issue
   样本存在约 39.9 秒 Message→Part 窗口，同 worktree Snapshot 又会串行化，可放大尾延迟；但 reviewer
   默认 600 秒且聚合器等待全部任务，所以必须先证明现场有效 timeout 小于该尾延迟。
3. **普通 WAL writer 竞争**：Issue 的 Part-query 失败位置与成功 `BEGIN IMMEDIATE` 后不再返回
   `SQLITE_BUSY` 的语义冲突，当前按“已反证”处理，而不只是低优先级。只有实际部署代码没有使用该
   事务边界，或原始日志证明失败查询并非 Issue 展示的 Part INSERT，才能重新打开该分支；
   `SQLITE_LOCKED`/schema/shared-cache 属于另一类非常规 statement lock，不能借普通 WAL 竞争之名进入
   2A 重试。

综合最新证据，**ambiguous outcome → OC3 DELETE → FK** 仍是已确认、可确定复现的独立缺陷机制，但不再
是 Issue 的默认最高候选：它与“OC2 已完整返回 `UnknownError`”因果互斥，公开 caller 默认 600 秒，
已知连接链没有约 40 秒 deadline，三路 task 又不存在 session ID/response 串线或第二个 cleanup actor。
当前 Issue 归因收敛为两个都缺关键现场证据的分支：若新 reason 为 FK，则寻找 caller 外部、未记录版本
或显式 Session/Message 删除；若 reason 不是 Constraint，则检查 `IOERR/NOMEM` 等极低概率 statement
资源/文件系统错误。普通 WAL 竞争、durable event 重排和标准 caller 误删已经有足够反证，不再与这两个
分支并列。

Issue 明确写的是请求“返回”带 `UnknownError` 的 assistant 响应，所以当前默认应按分支 1 推进；不能
仅因真实 caller 存在 timeout 就把 2C 当成这 7 次记录的根因。

只有把新的结构化诊断部署到原始环境并捕获一次失败，才能先用 `database.reason/code/message` 在上述
两条分支间选择；若为 FK，再取得调用端 prompt/delete 与服务端 writer 的关联时间线才能完成删除归因。

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
缺陷机制。真实调用端的 timeout-cleanup 可以提供这个顺序；TCP 变体 F 已证明 HTTP waiter rejection
之后的新连接 DELETE 会稳定制造同一 FK。对照 E 则证明 waiter rejection 本身不会取消 Runner：不
DELETE 时 Runner 会继续写入 Part、回到 idle 并持久化完整 structured result。直接 Runner ownership
实验又独立证明 interrupt `ensureRunning()` 的 waiter 后，instance-scoped work fiber 仍继续执行完成，
排除了“只是 fetch/SDK 测试实现没有正确取消”的替代解释。

这把“机制是否真实”与“Issue 是否走过该机制”彻底分开：前者已经确认；后者按 Issue 所述完整
`UnknownError` response 反而受到反证。只有 caller 原始 outcome 与描述不一致、实际为 ambiguity，且
同一 session reason 为 FK 时，才能确认 Issue 走过这条路径。

当前删除入口直接调用 `Session.remove()`；`remove()` 只取消已登记的 `BackgroundJob`，没有协调
`SessionRunState` 中的 Runner。即使后续在 DELETE 前单独增加 `runState.assertNotBusy()`，也存在：

```text
DELETE 检查 idle
  → 新 prompt 被 admission 并写入 user/assistant Message
  → DELETE 提交并级联删除 Message
  → prompt 尝试写入 Part
```

这是一条 check-then-act TOCTOU。只调用 `runState.cancel()` 同样不足：删除与新 prompt admission 仍可
交叉，而且 detached title/summary/prune fibers 不都由 Runner 统一拥有。因此 2B 不能实现成一个孤立
busy check 或 cancel 调用。

### 2.4 Parent Message 存在性与删除闭包

`Session.updateMessage()` 发布 durable `MessageUpdated`；本地发布没有 owner replay skip，且
`commitDurableEvent()` 会在返回前把 projector、event sequence 与 event append 原子提交。因此 assistant
Message 的 durable publish 返回时，parent Message 必然存在。`Part` 表在本路径上的唯一外键是
`message_id → message.id`，当前 Part 参数本身也合法。由此可得：

```text
若新诊断确认 Part INSERT 为 SQLITE_CONSTRAINT_FOREIGNKEY，
则 parent Message 必定在 MessageUpdated commit 之后、PartUpdated transaction 成功 BEGIN 之前被移除。
```

能够闭合该删除的应用层 actor 只有：Session Deleted 的级联删除、显式 MessageRemoved、两者的
workspace remote replay，或绕过应用层的外部数据库 writer。对新建的 `fsm-gate` session，调用端没有
parentID、revert、workspace query 或 deleteMessage 流程；本地 `Session.remove()` 的直接入口则是
session HTTP DELETE、workspace removal 与 CLI，ACP close 只清 ACP map/中止 backing，并不删除 Session。
同一服务进程内的 DELETE 和 Part transaction 使用同一 semaphore：DELETE 先取得许可并提交，则随后
Part INSERT 得到 FK；Part 先取得许可，则 DELETE 只能等待，Part 成功后再级联删除。因此需要记录双方
的 transaction wait/acquired/commit，而不能只比较 HTTP request start 或 Part SQL 的墙钟时间。

`Session.remove()` 在发布 Deleted 后还会删除该 aggregate 的 EventSequence/Event 历史，所以事后只看
数据库可能已经失去删除来源证据。必须在 HTTP/workspace/CLI/replay 等入口记录 source 和 correlation。
一旦现场证实 FK 且 OC2 outcome ambiguous，调用端自身 OC3 DELETE 将成为压倒性的应用层删除源；在
取得该关联前仍不能排除其他 actor。

### 2.5 Snapshot 是共享尾延迟放大器，不是独立 SQLite 根因

`Snapshot.Service` 的 `locks` map 以 snapshot `gitdir` 为 key，每个 key 使用单许可 semaphore；同一
worktree 的所有 Session 共用同一个 `gitdir`。processor 的通常路径严格执行：

```text
assistant Message durable commit
  → initial snapshot.track()
      → 等待 Snapshot semaphore
      → git diff/add/write-tree 子进程
  → tools/system/plugin/model-message 准备
  → provider 首个有效 stream chunk
  → provider step-start received
  → PartID.ascending()
  → PartUpdated durable transaction
```

如果 initial track 返回 `undefined`/空 hash，`step-start` 还会再次执行同一 track 作为 fallback。其他
session 的 step-finish completion snapshot、patch、restore、cleanup 也共享此锁；这些操作是否排在
当前 initial request 之前取决于实际入队与 semaphore 调度，具体公平性和顺序应由 wait/acquired 时间线
确认，不能从三个 Session ID 推测。Issue ID 取证证明失败请求从 Session 创建到 Part SQL 约
39.960 秒、从 assistant Message ID 生成到 Part SQL 约 39.931 秒，Part ID 仅早于 SQL 1 ms；这与
“所有前置阶段结束后立即写 Part”一致，却不能区分 Snapshot、tools/system 准备和 provider 首 chunk
各占多少。

Snapshot 不操作 Session/Message/SQLite，也不发布 Deleted，因此它不能单独造成 FK、锁失败或
`UnknownError`。底层 AppProcess 没有额外全局队列，也只有显式传入 `timeout` 才终止 Git；Snapshot 的
Git wrapper 会把子进程错误降级为普通失败结果。因此它的因果角色至多是：排队/Git 执行放大尾延迟，
或 initial 失败导致一次 fallback；若有效 caller deadline 足够短，使 OC2 进入 ambiguous 分支，再由
OC3 DELETE 破坏 parent Message。默认 vote reviewer timeout 为 600 秒且聚合器不会提前取消剩余任务，
故当前不能把 39.9 秒直接解释为 timeout。只有 initial/fallback Snapshot wait/acquire/end、provider
first-chunk 与 OC2 deadline 的同一单调时间线能确认这一放大关系。

### 2.6 后台任务的解释边界

同步 prompt 的主 Runner 返回前，Issue 日志中的首个 `{ type: "step-start", snapshot: ... }` Part 已经
由 processor 尝试写入。能够越过同步 response 生命周期的 detached fibers 是：

- title fork：只更新 Session title；
- summary fork：更新 Session summary/diff 和既有 Message；
- prune fork：只可能更新既有、已完成的 tool Part，不创建 `step-start` Part。

所以这些后台任务可以解释清理后的后续 `Session not found` 或其他迟到写入，但不能解释 Issue 最先
记录的 `step-start` Part INSERT。原文档把该后续错误主要归因于 processor summary 的表述过强，现已
收窄为“后台 writer 可解释后续尾部错误”。

### 2.7 Workaround

对真实调用端最安全的诊断性规避是：只有 OC2 完整收取 response body 后才 DELETE；timeout、request
error 或 body transport error 都属于服务端执行状态未知，不立即清理，而是记录 orphan session，等待
未来服务端提供 writer-complete/join 信号后再清理，或交给延迟 GC。不要因为 timeout 盲目重放 prompt。

`POST /session/:id/abort` 可以中断并等待 `SessionRunState` main Runner，并取消已登记的 BackgroundJob，
但不拥有通过 prompt service scope fork 的 detached title/summary/prune fibers。因此 `abort → delete`
可能缓解首个 `step-start` Part 竞态，却不是完整生命周期屏障，不能作为已证明修复。排查期间应跳过
ambiguous outcome 的 DELETE，保留数据库、session 和完整结构化 cause。

### 2.8 同类风险点

- 其他 durable projector 同样大量使用 `.pipe(Effect.orDie)`，可能以相同方式丢失 SQL cause；
- 在 provider/prompt 层重试整个 turn 会重复模型调用、tool 执行和副作用；
- 无差别重试 constraint 会掩盖生命周期或数据不变量破坏；
- UnknownError 若直接暴露完整 SQL params，可能泄漏用户内容，客户端信息与服务端诊断字段必须分层；
- SQLite normal acquirer 未把 permit 生命周期显式延伸到 statement scope；当前生产
  `all()/values()` 为无 yield 的同步 native 调用，等待者又在 permit release 后进入后续调度，已确认不能
  切入本次 Part statement。若未来实现异步 stream/driver，必须重新把 permit scope 纳入并发契约；
- 同 worktree 的 initial/fallback/completion Snapshot 串行化会把不同 Session 耦合到首 Part 前的尾延迟
  队列；在外部 deadline 存在时应分别记录 lock wait，而不能把“独立 Session”误写成“关键路径无共享
  资源”；
- 任意“请求结束即硬删除临时 session”的调用端都存在相同跨进程契约风险，尤其是自定义 timeout、
  连接断开和 response body 未收完整的分支。

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

修复分为一个已完成的诊断单元、一个只在事务起点锁证据成立时启用的 2A、一个可独立决策的服务端生命周期
加固单元 2B，以及一个只在 timeout/transport 时间线相关性成立时启用的调用端契约修复 2C。单元 1
已使后续失败可定类；2A 仍需 `BEGIN IMMEDIATE` 的 LockTimeout reason；Part-statement lock 必须另开
最小复现与修复单元；2B 所针对的机制已经受控复现；2C 的源码触发路径
与真实 TCP 正反对照均已确认，但 Issue 当前所述完整 response 把它排除在这批记录之外，除非原始
outcome 日志证明描述有误。Snapshot 共享通道只列为触发概率放大器，不新建修复单元；只有测得其
lock wait 穿过现场 deadline 后，才另行评估性能/调度加固。三条决策线不得混为一条。

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

### 单元 2A：仅当捕获到事务起点的 LockTimeoutError 时

- 先记录失败 query 位于 `BEGIN IMMEDIATE` 还是 Part statement；只有前者的普通
  `SQLITE_BUSY/LockTimeoutError` 进入本单元。若是 Part statement 的 `SQLITE_LOCKED`/schema lock，先为
  shared-cache/table-level/reentrant 场景建立独立最小复现并新增修复单元，不直接套用 2A 重试。
- 确认运行图为何出现第二 writer；若是不必要的重复 Database layer，优先消除重复连接。
- 若多连接是受支持部署形态，且原始 failure 已确认发生在 transaction begin，则在
  `commitDurableEvent()` 的整个 `BEGIN IMMEDIATE` 事务外增加短小、
  有界、带 jitter 的重试；只接受结构化 `isRetryable` lock reason。
- 每次失败事务必须已 rollback；重试复用同一 event ID/payload，projector、sequence 和 event append
  仍在同一事务中。
- 禁止在 `SessionPrompt.prompt()`、LLM stream 或 tool 层重放整个 turn。

最小修正后逻辑：第二连接持写锁 → 第一次 `BEGIN IMMEDIATE` 得到可重试 lock reason → rollback/
等待 → 同一 durable event 再次提交 → projector、sequence、event 各只落库一次。

### 单元 2B：当 Issue 捕获到 ForeignKey Constraint，或产品契约要求防御活跃删除时

- 在 prompt admission 与 DELETE 之间引入同一个原子生命周期协调器，而不是在 DELETE 入口单独调用
  `assertNotBusy()` 或 `cancel()`。协调器至少区分 `Alive`、`Deleting`、`Deleted`，并跟踪活跃 writer
  lease；状态转换和新 lease 获取必须线性化。
- prompt admission 只能在 `Alive` 获取 writer lease；一旦 DELETE 原子标记 `Deleting`，新的 prompt、
  shell 及相关 writer 必须拒绝或等待，不能再创建 user/assistant Message。
- 对已有 writer 选择一个产品契约：“busy 时拒绝删除”（建议稳定 typed 409），或“请求取消并 join
  所有 session writer 后删除”。实施前需由用户确认；两种策略都必须使用同一原子 gate。
- 将 main processor、title、summary、prune 及其他会写 Session/Message/Part 的任务纳入 lease/join/cancel
  责任边界。只有活跃 writer 全部退出后才能发布 Deleted 并级联清理。
- constraint 保持不可重试；缺 parent Message 时直接报告不变量破坏及关联 ID。

拟议并发契约：

```text
Rely：调用方和外部 actor 可并发发起 prompt/delete。
Guarantee：Deleting 之后不再授予 writer lease；Deleted 提交前所有既有 writer 已退出。
Invariant：state == Deleted ⇒ 未来不存在该 session 的 Message/Part durable event。
```

最小修正后逻辑：prompt 正在写 Part → 删除请求被拒绝，或等待 processor/background writer 完全
停止 → Deleted 级联清理 → 此后不存在迟到的 PartUpdated。

### 单元 2C：调用端 timeout/transport cleanup 契约（仅当时间线相关性成立）

根因层修改位于外部调用端 `mcp-server-fsm/crates/server/src/agent_cli.rs`：

- 将 OC2 结果分为 `settled` 与 `ambiguous`，而不是把“客户端 future 结束”都当作“服务端 prompt
  已结束”。只有完整收取并处理 response body 才是 `settled`；timeout/request/body transport error
  都是 `ambiguous`；
- `settled` 后保留现有 best-effort DELETE；`ambiguous` 后禁止立即 DELETE，记录 session ID 与 outcome，
  交给延迟 GC，或等待未来服务端 writer-complete/join API 后再删除；
- status/parse error 如果已经完整收取 body，服务端 prompt 已 settle，可以 cleanup；必须与 body 未收完
  的 transport error 分开；
- 不盲目重试非幂等 prompt。若未来需要重试，必须先引入跨重试稳定的 idempotency key 与服务端去重
  契约；
- `/abort` 只能作为 main Runner 的缓解手段，不能替代完整 writer join，也不能作为立即 DELETE 的
  充分前置条件。

vote reviewer 默认 timeout 为 600 秒，聚合器会等待全部三个 `JoinHandle`；固定版本仓库没有
`timeout_seconds: 30` 的 reviewer 配置。因此本单元的 Issue 归因前置条件必须写成“现场有效 timeout
或 transport ambiguity 已被原始 outcome 证明”，不能由三路并发、39.9 秒尾延迟或 stop-gate 的 30 秒
配置替代。若该前置条件成立，initial/fallback Snapshot wait 可解释为何最后一路更容易越过 deadline，
但根因动作仍是 ambiguous 后立即 DELETE。

该修复依赖的跨进程接口契约如下。现有调用端把“总会 cleanup”默认为安全，缺少这些维度正是
竞态得以进入设计的契约缺口：

1. **连接模型**：OC1/OC2/OC3 各自创建 Hyper client，按请求建立独立连接；OC3 不与 OC2 共享连接，
   连接关闭/drop 不清理服务端 Session，也不取消 `SessionRunState` Runner；无自动重连状态恢复。
2. **超时与截止时间**：OC2 使用 stop-gate 30 秒或 reviewer timeout（默认 600 秒、可配置）；OC3 使用
   15 秒。现有 `bounded()` 是总体 deadline；timeout 后请求可能已被接受、正在执行或已完成但 response
   未被客户端取得，状态为不可知。
3. **重试与幂等**：OpenCode adapter 自身不重试，upper-layer 可重新 vote/review；POST prompt 非幂等，
   本调用端未提供 idempotency key。因此 ambiguous outcome 后不得自动重放。
4. **交付与顺序**：完整 response body 建立“服务端 prompt settle happens-before OC3”；timeout/transport
   failure 只建立“客户端停止等待”，不建立服务端完成。不同连接间没有 FIFO、因果完成或全序保证。
5. **失败模式**：假设对端 fail-stop/slow response 与普通网络错误，不考虑拜占庭行为；timeout、request
   error、body error 都是 ambiguous，Runner 可继续，cleanup 可与 writer 竞态。网络分区不产生
   split-brain owner，但调用端无法区分未执行与已执行未确认。
6. **状态与会话**：接口有状态，以 Session ID 跨连接关联；OC3 可以在新连接继续访问同一 Session，
   DELETE 是硬删除并级联 Message/Part，不能由连接生命周期隐式恢复。
7. **背压与流控**：N/A（调用端与服务端之间没有显式有界队列或反向背压）；但 review fan-out 默认
   并发 3 个独立 session，配置可改变 N。超时不是背压信号，不能据此删除服务端状态。

最小修正后逻辑：OC2 完整收包 → OC3 cleanup；OC2 ambiguous → 保留并记录 orphan → 服务端 Runner
可以安全完成，parent Message 不会在 PartUpdated 前被调用端删除。

TCP 对照已经验证这一后置条件：不 DELETE 的 ambiguous session 最终回到 idle，并持久化 structured
result；相同时序加入 DELETE 则稳定得到 FK。因此 2C 是根因级修复而非仅隐藏错误，但它只修复
ambiguous outcome 分支，不改变完整 response 已含 `UnknownError` 的服务端失败。

### 单元边界

单元 1 已独立实施和验证。Issue 因果修复的选择顺序是：先取得原始 reason 与 caller outcome；完整
response 分支只有在事务起点 BUSY 时进入 2A，在 FK 时评估 2B，在 Part-statement lock 或第三类错误时
新增对应单元；ambiguous + FK 分支才进入 2C。若实际根因是 2C，
修调用端即可消除当前触发；2B 仍是独立的服务端 defense-in-depth 产品决策，不能用已确认的竞态机制
反推 Issue 已经发生早删，也不能未经契约选择直接实施。即使 Issue 最终是事务起点 LockTimeout，也
不能把 constraint 当成可重试错误；如果 reason 是 Part-statement lock 或第三类错误，则先建立对应
最小复现，再修订本计划。
Snapshot 若只被确认是延迟放大器，不足以选择 2A/2B/2C，也不得用关闭 Snapshot 代替根因修复。

## 五、正确性论证

- 根因消除：单元 1 保证当前已存在的 SQLite classification 不再在日志边界丢失；2A 只处理已证实
  的事务起点锁失败；2B 在线性化 gate 上消除删除/准入 TOCTOU；2C 在 ambiguous outcome 后不再级联删除
  活跃 Runner 所依赖的 parent Message。
- 证据边界：同步 `/message` 的代码级 happens-before 和真实拓扑 B 共同排除“正确 post-await DELETE
  导致此前首个 Part INSERT 失败”；真实调用端 timeout 会打断客户端等待但不打断 server Runner，TCP
  E/F 与直接 Runner ownership 实验证明它可以形成受控 C 的重叠顺序；但完整 response 已含
  `UnknownError` 时，Part failure 必在 OC3 前发生，2C 对该次记录被排除。Issue ID 证明约 39.9 秒前置
  窗口，但 reviewer 默认 600 秒、聚合器等待全部任务、已知 server/runtime 链没有约 40 秒 response
  deadline，故该窗口当前只表示尾延迟，不能独立证明 timeout。窗口按代码顺序包含 initial Snapshot、
  tools/system 准备、provider 首个有效 chunk 和可选 Snapshot fallback，不能只用 Part ID 给其中任一
  阶段分配耗时。
- 错误阶段论证：真实 adapter 对照证明只有 `statement.all()` execution failure 会生成 Issue 所见
  `EffectDrizzleQueryError: Failed query`；prepare/schema failure 直接成为原生 SQLite defect，参数编码
  又发生在 executor 之前。因此后续修复只应针对 execution-time Constraint/LOCKED/资源错误，不能用
  migration、SQL prepare 或 JSON 编码假说设计修复。`SQLITE_FULL` 容量实验还表明典型 Part 容量耗尽
  会因 SQLite 自动回滚而最终暴露 rollback `SqlError`，与 Issue wrapper 不同；官方语义不保证所有
  `FULL/IOERR/NOMEM` 失败点都自动回滚，所以该结果用于降级而不是绝对排除资源分支。
- parent Message 论证：MessageUpdated projector 在 durable publish 返回前原子提交；Part 参数合法且
  唯一外键指向 Message。Part transaction 的成功 `BEGIN IMMEDIATE` 又阻止其他 writer 在 INSERT 前
  插队，因此若诊断为 FK，Message 必在 Message commit 之后、Part BEGIN 之前被删除。对无 parent/
  revert/workspace 操作的新 `fsm-gate` session，相关 timeout 后的 OC3 是首要应用层删除源。
- 不变量保持：durable event 的 projector、sequence 和 append 继续原子提交；Part 必须有 parent
  Message；Deleted 后禁止新 writer；同一 provider/tool turn 不被数据库恢复策略重放。
- 无回归引入：诊断字段不含 query params；Constraint 不重试；锁重试有次数/时间上限；不同 session
  的成功路径不改变；2C 的完整响应 cleanup 保持现状，ambiguous 分支只延迟回收临时 session。
- 并发正确性：2A 只在完整事务边界重试并复用 event identity；2B 必须让 prompt admission 与
  `Alive → Deleting` 原子互斥，并在 Deleted 前清空全部 writer lease。单独 busy check/cancel 不能证明
  该不变量，因为仍存在 check-then-act 窗口。现有单连接 transaction semaphore 已把同进程
  Message/Part/Delete durable writes 排成全序；同 worktree Snapshot semaphore 则是 LLM stream 前的
  另一条共享顺序边界，但不写数据库。它只能在 deadline 已证实时作为延迟放大器，不能作为 SQL 根因。
- 跨进程顺序正确性：2C 只把完整 response body 当作远端 settle 证明；对 timeout/transport ambiguity
  不假设跨连接 FIFO 或远端取消。于是调用端不再在缺少 happens-before 证据时发出破坏性 cleanup。
  TCP 对照满足必要性分离：abort-only 能完整结束，abort + DELETE 才产生 FK。公开 caller 的每个
  reviewer 使用局部 `sid`、独立 Hyper request future，仓库内也只有 `agent_cli.rs` 发 OpenCode session
  DELETE，因此标准三路 fan-out 不会交叉清理彼此 session。
- Trivial 判定：不适用。本缺陷跨 durable transaction、projector、error cause 和 session lifecycle，
  且错误修复可能重复外部副作用。
- provenance：实际部署 commit/version 尚未记录；调用端材料引用的 `v1.17.8`、`d12b1e924d` 和分析
  基线均有 initial Snapshot、单连接 semaphore、`BEGIN IMMEDIATE` 与相同 Part FK。现场归因仍须把
  binary SHA 作为诊断输入，避免漏掉未纳入比较的自定义 binary。

## 六、测试用例清单

| 类型       | 用例描述                                                                                  | 状态（修复后回填）                     |
| ---------- | ----------------------------------------------------------------------------------------- | -------------------------------------- |
| 现状基线   | 真实 TCP/Git/WAL 下 3 个独立 structured-output prompt；无清理及返回后清理                 | 已固化；3 轮共 18 个 prompt 通过       |
| 机制复现   | Message 已提交、Part 未写入时删除 session，再释放 provider                                | 已固化；3/3 为 FK Constraint           |
| 传输对照   | Message 已提交、Part=0 时 abort waiter；不 DELETE 后释放 provider                         | 临时诊断 3/3 structured 完整，无 FK    |
| 传输机制   | 相同 abort 时序；新连接 DELETE 返回 200 后释放 provider                                   | 临时诊断 3/3 为 FK Constraint          |
| 回归       | 嵌套 Drizzle/Effect/SqlError 的投影保留 reason、code、errno、retryable                    | 已通过（单元 1）                       |
| 新增       | 缺失 parent Message 时写入 Part，稳定得到 foreign-key Constraint 诊断                     | 已通过（单元 1）                       |
| 新增       | 第二 SQLite 连接持写锁，稳定得到 LockTimeout 诊断                                         | 已通过（单元 1）                       |
| 语义实验   | 双连接验证 BEGIN 后 DELETE=BUSY、DELETE 先提交=FK、WAL reader 不阻塞 writer               | 已完成（临时诊断，无仓库改动）         |
| 阶段实验   | 真实 adapter 对照 prepare failure 与 statement execution failure 的外层错误形态           | 已完成；Issue wrapper 只对应 execution |
| 资源实验   | parent 已提交、BEGIN 成功后以 `max_page_count` 强制 Part INSERT `SQLITE_FULL`              | 已完成；自动回滚后暴露 rollback SqlError，外形不同 |
| 所有权实验 | interrupt `ensureRunning()` waiter 后 instance-scoped Runner 仍继续完成                   | 已完成；busy→completed/idle            |
| timeout 审计 | reviewer/OpenCode/Bun/Hyper 已知 deadline 与 39.9 秒窗口对照                            | 已完成；公开链无约 40 秒 response timeout |
| caller 审计 | 三 task 的局部 sid、独立 Hyper future、OpenCode DELETE 全调用面                          | 已完成；无 session 串线或第二 cleanup actor |
| 边界       | 服务端诊断与客户端 error 不包含 query params/用户 prompt                                  | 已通过（单元 1）                       |
| 现场取证   | 解码 Issue 示例 Session/Message/Part ID，并与 SQL `time_created` 对齐                     | 已完成；Message→Part SQL 约 39.931s    |
| 配置取证   | 记录实际 OpenCode/caller SHA、有效 timeout、reviewer 数、Snapshot 配置与 DB 路径          | 公开/本机路径已审计；Issue 环境待跑    |
| 现场诊断   | 原始 caller 按 sid 记录 OC1/OC2 outcome/elapsed 与 OC3 start/outcome                      | 待跑（Issue 环境）                     |
| 现场时序   | 记录 initial/fallback Snapshot、tools ready、provider first chunk、Part wait/BEGIN/upsert | 待跑（Issue 环境）                     |
| 删除归因   | 每个 Session/Message 删除记录 source 与 request/admission/BEGIN/commit                    | 待跑（Issue 环境）                     |
| 现场快照   | 首次失败保留 DB；检查 parent、FK/integrity、PRAGMA、磁盘与数据库 open 配置                | 待跑（Issue 环境）                     |
| 单变量     | 原始 harness 设置 `snapshot: false`，比较三路 Message→Part 尾延迟与失败率                 | 待跑；仅判断延迟放大，不证明根因       |
| 单变量     | 保留 Snapshot，但 ambiguous outcome 不 DELETE，保留 Session 与数据库现场                  | 待跑；与 TCP E/F 联合判定              |
| 现场边界   | OC2 完整收包返回 UnknownError 时否定该次 timeout-cleanup 路径                             | Issue 文字支持；原始日志待核对         |
| 公开取证   | 检索 caller Actions、workflow、Issue comment/artifact                                     | 已完成；无 8 月 1 日公开运行或现场附件 |
| 条件回归   | BEGIN LockTimeout 时只重试 durable transaction，成功后 event/projector 各一条             | 待定（仅 2A）                          |
| 条件边界   | Constraint、未知错误和超过重试上限时不重试                                                | 待定（仅 2A）                          |
| 条件回归   | prompt 写入与 session remove 用 latch 确定性交叉，删除不会造成迟到 Part                   | 待定（仅 2B）                          |
| 条件边界   | 删除 busy session 的 HTTP 行为与选择的拒绝/取消契约一致                                   | 待定（仅 2B）                          |
| 条件竞态   | DELETE 检查/标记期间并发新 prompt admission，不会穿过 `Deleting` gate                     | 待定（仅 2B）                          |
| 条件尾部   | title/summary/prune writer 在 Deleted 前退出，之后不再产生 durable write                  | 待定（仅 2B）                          |
| 条件回归   | assistant Message commit 后 OC2 timeout；caller 跳过 DELETE，无 FK 且保留 session         | 待定（仅 2C，外部 caller）             |
| 条件边界   | request/body transport ambiguity 同样跳过 DELETE                                          | 待定（仅 2C，外部 caller）             |
| 条件正常   | OC2 完整收取 response body 后仍执行临时 session cleanup                                   | 待定（仅 2C，外部 caller）             |
| 条件并发   | 默认 3 reviewer 并发，其中一条 timeout；仅 ambiguous session 被保留                       | 待定（仅 2C，外部 caller）             |

## 七、代码更新清单

| 文件                                                                           | 函数 / 行号               | 改动概述                                                           | 状态（修复后回填） |
| ------------------------------------------------------------------------------ | ------------------------- | ------------------------------------------------------------------ | ------------------ |
| `packages/core/src/database/sql-error.ts`                                      | `extract()`               | 从嵌套 cause 提取安全结构化 SQLite 诊断                            | 已新增（单元 1）   |
| `packages/opencode/src/session/processor.ts`                                   | `parse()` / `halt()`      | 记录 reason/code 与 session/message correlation；不记录 SQL params | 已修改（单元 1）   |
| `packages/opencode/src/session/message-v2.ts`                                  | `fromError()`             | 数据库失败返回安全 UnknownError 与 correlation ref                 | 已修改（单元 1）   |
| `packages/core/test/database-sql-error.test.ts`                                | SQL 诊断测试              | 真实 Constraint 与 LockTimeout 分类                                | 已新增（单元 1）   |
| `packages/opencode/test/session/message-v2.test.ts`                            | error 投影测试            | 验证嵌套 cause、客户端 ref 与敏感参数隔离                          | 已修改（单元 1）   |
| `packages/opencode/test/cli/serve/session-part-concurrency-diagnostic.test.ts` | 真实拓扑诊断              | 固化 A/B 正常路径及 C 生命周期 FK 机制                             | 已新增（诊断）     |
| `packages/opencode/test/lib/cli-process.ts`                                    | `ServeHandle.stderr()`    | 向诊断测试暴露当前子进程 stderr 快照                               | 已修改（测试支持） |
| `packages/opencode/src/snapshot/index.ts`                                      | `track()` lock 边界       | 区分 initial/fallback 的 wait/acquired/end，不改变 Snapshot 行为   | 待定（诊断确认门） |
| `packages/opencode/src/session/processor.ts`                                   | create/process/step-start | 记录 tools ready、provider first chunk 与 Snapshot phase           | 待定（诊断确认门） |
| `packages/core/src/event.ts`                                                   | `commitDurableEvent()`    | 记录 event transaction wait/BEGIN success；不改变提交行为          | 待定（诊断确认门） |
| Session/Message 删除入口与原始 harness                                         | lifecycle/source 日志     | 记录删除来源和 tx 时序、有效 timeout、caller outcome 与实际版本    | 待定（诊断确认门） |
| `packages/core/src/event.ts`                                                   | `commitDurableEvent()`    | 仅在 BEGIN LockTimeout 实证后增加事务级有界重试                    | 待定（仅 2A）      |
| `packages/opencode/src/session/run-state.ts` 或窄用途 lifecycle coordinator    | prompt/delete admission   | 原子维护 Alive/Deleting/Deleted 与 writer lease                    | 待定（仅 2B）      |
| `packages/opencode/src/session/session.ts`、session HTTP handler               | `remove()` 及删除入口     | 按选定的拒绝或 cancel-and-join 契约完成删除                        | 待定（仅 2B）      |
| title/summary/prune/background writer                                          | writer 生命周期           | 纳入同一 lease/join/cancel 边界                                    | 待定（仅 2B）      |
| 外部 `mcp-server-fsm/crates/server/src/agent_cli.rs`                           | `judge_opencode()`        | 区分 settled/ambiguous；ambiguous 时不立即 DELETE                  | 待定（仅 2C）      |
| 外部 `mcp-server-fsm` 对应 Rust tests                                          | OpenCode cleanup 契约     | 覆盖 timeout/transport/full-response/3-reviewer 时序               | 待定（仅 2C）      |

单元 2 的具体文件清单将在 Issue 原始 reason 与删除契约确定后收窄，避免把受控机制直接等同于
Issue 根因。

## 八、文档更新清单

| 文档路径                                                   | 要改什么                                                      | 状态（修复后回填）     |
| ---------------------------------------------------------- | ------------------------------------------------------------- | ---------------------- |
| `docs/fixes/session-fix-part-projection-sqlite-failure.md` | 记录分析、复现矩阵、证据边界和条件修复计划                    | 已提交 `d71c0193b0`    |
| 同一修复计划                                               | 回填诊断单元、真实拓扑 A/B/C 与证据边界                       | 已提交 `d71c0193b0`    |
| 同一修复计划                                               | 同步 happens-before、锁反证、后台边界及删除 TOCTOU            | 已提交 `6a12337e4a`    |
| 同一修复计划                                               | 同步 caller、TCP E/F、ID 时间线、Snapshot 与单元 2C           | 已提交 `9050ddfa07`    |
| 同一修复计划                                               | 修正 Snapshot 前置时序并反证普通 WAL Part-statement BUSY      | 已提交 `b95397f5c0`    |
| 同一修复计划                                               | 同步 execution 阶段边界、Runner ownership、公开取证与候选排序 | 已提交 `b95397f5c0`    |
| 同一修复计划                                               | 同步 timeout 链、caller sid/DELETE 审计、FULL 实验与候选降级   | 已同步（本提交）       |
| 同一修复计划                                               | 回填 Issue 环境原始 reason、选定的 2A/2B/2C 与提交            | 待更新                 |

本轮只同步分析与候选契约，不修改公开 API/schema。若单元 2B 选择改变删除 endpoint 的 busy 行为，
实施前必须补充服务端接口契约和测试；若确认单元 2C，则必须在外部调用端同步 settled/ambiguous、
timeout 与 cleanup 契约及对应 Rust 测试。两者都需再次经过确认门。
