# Session Part 投影并发失败修正方案

- 状态：单元 1（诊断信息保真）已实施并验证；Issue 的 `EffectDrizzleQueryError: Failed query: insert into part` 已把失败限定在 statement execution，普通 WAL writer 竞争、durable event 重排、生产 native/Drizzle 旁路、公开候选调用端内的 reviewer session 串线与 ID 自然碰撞均已反证；`v1.17.8` 与当前 schema/migration 进一步确认 Part 没有隐藏约束，合法参数若得到 Constraint 几乎只可能是 `message_id → message.id` 外键。当前已有两个与 Issue 响应形态及 `lastAssistant()` 推导后置条件同构的受控机制：Message-only 删除可得到 `Part FK + HTTP 200 UnknownError + cleanup 以同 ID 重建 Message`；WAL `pread64` 返回 `EIO` 则可在 Bun/SQLite 层表现为 `SQLITE_CORRUPT`，并完整得到 `Part failure + HTTP 200 UnknownError + Message 保留 + assistant Part=0`。最新临时诊断又以两个真实 OpenCode server、共享 SQLite 和标准 HTTP `deleteMessage` 完整闭合前一机制：非 Runner owner 的 server 返回 200，owner 随后记录 `SQLITE_CONSTRAINT_FOREIGNKEY` 并返回同 ID `UnknownError` assistant。它确认当前实现存在跨进程 lifecycle 缺口，但不确认 Issue 现场走过该路径；Issue 明确描述一个 server，公开材料也只证明高度匹配的候选调用端使用一个 base URI，尚无 endpoint→后端 PID 或第二 server 证据。`v1.17.8` 正式构建链直接固定 Bun 1.3.14；本机同一官方 Bun 运行时测得 SQLite 3.53.0，但现场 binary 的 SQLite provenance 仍未知。根因继续等待原始 `database.reason/code/message`、处理请求的 server PID、删除/replay source、实际 SQLite provenance 与失败后 DB/WAL/SHM 现场确认
- 日期：2026-08-05
- 对应问题：[Issue #6](https://github.com/lihaokun/opencode/issues/6)
- 本轮全文审计工作树基线：`ca94f973437218874364e0f464b12d581372597f`
- 初始工作基线：`a22be532fc390ef0622f8f8cb95bb61746b3f841`
- fork `origin/dev`：`d12b1e924d7a18551767690e9f02294d0b3c6f1a`
- 分析时 `upstream/dev`：`6c3299103ce1494b4b37f5727199ac9539130534`
- 影响模块：durable event、Session projector、SQLite adapter、Session 错误投影、Session 删除生命周期、Snapshot 共享串行通道、外部 judge caller cleanup 契约
- 缺陷分类：非平凡并发/持久化缺陷；Issue 中首个 SQLite 失败原因尚未被保留下来，不能把推测当根因

本文区分四种证据等级：仓库内持久化测试、结论确认后已删除的临时诊断、指定 commit 的静态源码审计，
以及 Issue 现场证据。前三者可以确认实现语义或受控机制，不能替代第四类现场归因；凡缺少原始
`database.reason/code/message`、请求 PID、删除 source 或 binary provenance 的地方，均继续明确标为
“现场待确认”。

## 一、现象与复现

### 1.1 现象

Issue 报告在同一个 headless server 上并发执行三个互相独立的 structured-output prompt 时，偶尔有
一个请求无法返回完成的 `StructuredOutput`，assistant 只保存为 `UnknownError`。服务端日志把首个
失败定位在 `PartUpdated` projector 对 `step-start` part 的 SQLite upsert；立即清理 session 后，
日志有时还会出现后续 `Session not found`。

这里的“返回 `UnknownError` assistant”不只是错误分类表现，也是数据库状态证据：同步 prompt 在
processor settle/cleanup 之后会调用 `lastAssistant(sessionID)`，从数据库重新读取最终 assistant 再构造
响应。因此该响应证明失败收尾时 Session 与 assistant Message 均存在；它与“整个 Session 已在首个
Part 前被硬删除且尚未重建”的外部结果不兼容。

Issue 目前保存的错误文本只包含 Drizzle 的外层消息：

```text
Failed query: insert into `part` ... on conflict (`id`) do update ...
```

它没有 SQLite `code`、`errno`、原始 `message` 或 Effect SQL reason。因此现有证据无法区分：

- `SQLITE_BUSY` / `SQLITE_LOCKED`；
- `SQLITE_CONSTRAINT_FOREIGNKEY`，例如 Message 已被 session 删除级联移除；
- `SQLITE_CORRUPT` / `SQLITE_IOERR_*` 等 WAL/VFS 读取或文件系统错误；
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

C 在删除前通过只读 WAL 连接确认 parent Message 存在且该 assistant 的 Part 数为 0；删除级联移除
Message 后，迟到的 `step-start` Part upsert 稳定失败。服务日志保留 reason/code 且不包含 prompt marker；被删除 Session 的
同步 prompt 即使最终返回，也明确不是 HTTP 200。这说明 C 精确复现了内层 Part FK，却没有复现 Issue
所述的正常 assistant 响应，二者不能再仅凭相同 SQL 文本视为同一根因。

第三阶段用原始 HTTP `fetch` + `AbortController` 模拟 Rust/Hyper future 被 timeout drop；中止点固定在
assistant Message 已 durable commit、该 assistant 的 Part 数仍为 0 之后。两个临时诊断变体各重复三轮：

| 变体 | 精确时序                                                   | 结果                                                                      |
| ---- | ---------------------------------------------------------- | ------------------------------------------------------------------------- |
| E    | abort HTTP waiter → 不删除 session → 释放 provider         | 3/3 客户端 rejection；Runner 写入 Part、回到 idle，structured 完整，无 FK |
| F    | abort HTTP waiter → 新连接 DELETE 返回 200 → 释放 provider | 3/3 得到 `ConstraintError` / `SQLITE_CONSTRAINT_FOREIGNKEY`               |

E 通过只读 WAL 连接确认最终 assistant durable JSON 含 structured result 且无 error；F 证明客户端
waiter 已结束后，独立 DELETE 仍能击中继续运行的服务端 writer。这组临时诊断在结论确认后已移除，尚未
作为正式回归用例提交。

第四阶段针对“完整 assistant response 若为 FK 必须是 Message-only 删除”做真实 HTTP/SQLite 对照：

| 变体 | 精确时序                                                                     | 结果                                                                                                          |
| ---- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| G    | assistant Message 已提交、assistant Part=0 时调用 HTTP deleteMessage         | 返回 HTTP 409 `SessionBusyError`，parent 未删除；`v1.17.8` 与当前版本均有同一 busy guard                      |
| H    | 同一时点由第二 SQLite connection 直接删除 assistant Message，再释放 provider | Part 得到 FK；prompt HTTP 200/`UnknownError`；收尾后 Session=1、同 ID Message=1、assistant Part=0、FK check=0 |

H 完整闭合了 Issue 的响应形态和由 `lastAssistant()` 推导的数据库后置条件：Part failure 后 processor cleanup 会把仍在内存中的 assistant
以同一 ID 重新投影，所以最终数据库重新满足外键且 `lastAssistant()` 可以返回正常 HTTP body。它只证明
Message-only 机制与 Issue 同构，不证明现场存在外部 writer；G 只把同一 server、同一 session directory
实例上的公开 HTTP deleteMessage 从 active writer 来源中移除，不能外推到第二 server。该临时诊断文件
在结果确认后已删除，未作为正式测试提交。

第五阶段针对非 Constraint 分支做 libc/VFS 故障注入。`strace` 先确认：文件 WAL、成功
`BEGIN IMMEDIATE`、小型 child/Part INSERT 的 cache-miss 路径会在 `statement.all()` 内读取 WAL，正常
路径随后可以 rollback。`LD_PRELOAD` 只把目标 WAL 的 `pread64` 改为 `-1/EIO`，不修改数据库字节：

| 变体 | 注入边界                                                                                                           | 结果                                                                                                                              |
| ---- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| I    | 真实 Bun SQLite → Effect → Drizzle；BEGIN 后清 cache，再让首个 WAL read 返回 EIO                                   | Issue 同形 `EffectDrizzleQueryError`；诊断 `UnknownError/SQLITE_CORRUPT/errno=11`；rollback 成功，parent=1、child=0，连接可继续写 |
| J    | 真实 CLI/TCP/Session；第二连接写入再删除 probe Part 以强制 cache miss，provider gate 后连续 3 个 WAL read 返回 EIO | 第 3 次击中 Part statement；HTTP 200 assistant `UnknownError`；最终 Session=1、assistant Message=1、assistant Part=0、FK check=0  |

J 的两次注入对照仍正常完成，四次注入则继续击中 cleanup、使 assistant error 无法正常持久化；只有三次注入
闭合 Issue 指纹。这说明“瞬态 WAL read fault 可产生该外形”已经实证，但故障次数与 cache-miss 都是诊断
强制条件，不能反推现场真的发生过 EIO。尤其不能把 Bun 暴露的 `SQLITE_CORRUPT` 自动等价为持久数据库
损坏，也不能把任意 `SQLITE_CORRUPT` 自动归因为底层 EIO。两份临时诊断测试及 preload shim 均已删除，
尚未作为正式回归测试提交。

第六阶段审计多 OpenCode 进程共享数据库的边界。`Database.path()` 对正式 channel 默认返回同一用户级
`Global.Path.data/opencode.db`；每个进程的 AppRuntime 内只有一个 memoized Database service，但进程之间
没有数据库单实例 flock。任一初始化 AppRuntime 的 OpenCode 命令都会打开该文件，并在启动时执行
`PRAGMA journal_mode=WAL` 与 `PRAGMA wal_checkpoint(PASSIVE)`。因此“单个 server 内一连接”不能外推成
“机器上只有一连接”。针对启动 checkpoint 的临时多进程诊断执行 250 轮：主连接先成功
`BEGIN IMMEDIATE`，外部 Bun 进程再打开同一 DB、执行与 OpenCode 启动一致的 WAL/PASSIVE checkpoint，
返回后主连接执行 parent/Part 形态 INSERT 并 commit。250/250 checkpoint invocation 与 Part INSERT 均
成功，最终 `integrity_check=ok`、`foreign_key_check` 为空。该结果只说明这个固定调度的 250 次运行未
观察到失败，因而下调“正常第二进程启动 checkpoint 直接使 Part statement 失败”这一具体假说；它不能
证明所有 checkpoint/write 交叉均安全，也不模拟底层 EIO，更不替代旧 SQLite WAL-reset race 的版本判定。

同一阶段还发现并复现了一个独立的跨进程 lifecycle 缺口：`SessionRunState.assertNotBusy()` 只读取当前
进程、当前 directory `InstanceState` 中的 `Map<SessionID, Runner>`。正常 session HTTP 路由会先从 DB
加载 session，并把请求固定到该 session 已保存的 `directory`，所以单个 server 内不能仅靠改 query/header
选择另一个 directory map 绕过 guard；但共享 DB 的另一个 server 仍有独立的 map，看不到 owner server
中的 Runner。临时真实 HTTP 诊断让 server A 运行 prompt、server B 共享同一显式 `OPENCODE_DB`；当只读
连接观察到 assistant Message=1、assistant Part=0 后，B 的标准 `deleteMessage` 返回 HTTP 200。释放
provider 后，A 的 prompt 返回 HTTP 200 和同 ID `UnknownError` assistant，A 日志包含
`SQLITE_CONSTRAINT_FOREIGNKEY`；最终 Session=1、Message=2（user + assistant）、Part=1（仅 user text）、
assistant Part=0。该用例在结论确认后已删除，尚未固化为仓库回归测试。

这完整确认了 **双 server + 共享 DB + 删除请求落到非 owner server** 时的标准 HTTP Message-only 机制，
但仍不确认 Issue 现场存在该拓扑。公开候选 `judge_opencode()` 只把 OC1/OC2/OC3 发往同一个已运行
`OpencodeEndpoint.base`，不会自行 spawn 第二个 OpenCode server；同一 base 只证明 URI origin 相同，
若其前方存在代理/负载均衡则不能推出同一后端 PID。Issue 又明确描述启动一个 server，所以现场归因
仍要求取得 endpoint→PID、打开同一 DB inode 的进程或其他 Message-only 删除 actor 证据。

现有正式测试也通过：

- `packages/opencode/test/session/structured-output.test.ts`：22 pass；
- `packages/opencode/test/session/prompt.test.ts` 中 structured-output 长度终态定向用例：pass。

结论分成两层：普通三请求并发以及 Issue 声称的“同步 promise 返回后再删除”在等价真实拓扑中仍未
自然复现失败；Message-only 删除与 WAL read EIO 则分别完整闭合了 FK 与非 Constraint 两条 Issue 指纹。
两者都只是强制条件下的确定性机制：前者已经以标准双 server HTTP 闭包确认，但尚缺现场第二进程/路由
证据；后者缺现场 VFS/filesystem 证据且 Bun 暴露为 `SQLITE_CORRUPT`。因此仍不能
直接归因给 Issue，必须先取得原始 SQLite reason/code/message、实际 binary/SQLite source ID、endpoint→PID
映射、删除 source 与 DB/WAL/SHM 现场。

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

与 Issue 作者、三路并发形态和发生时间高度吻合的公开候选调用端存在另一条更具体的重叠路径：它对
同步 `/message` 自行施加 timeout；timeout 只终止客户端等待，不代表服务端 Runner 已结束，随后立即
发起的独立 DELETE 可以与服务端 writer 交叉。具体契约和时间线见下一节，真实 TCP 变体 E/F 已验证
这一机制。但 Issue 没有直接链接候选仓库或 commit，故不能把公开候选等同于现场调用端；Issue 又明确
描述失败请求返回了包含 `info.error.name = UnknownError` 的完整响应，若该描述来自 OC2 的实际 outcome，
本机制不能解释这批记录。

完整响应还给出比“OC3 在 Part 之后”更强的持久化指纹。`v1.17.8` 与当前 `runLoop()` 都在
`SessionProcessor.process()` 的 `ensuring(cleanup())` 完成后调用 `lastAssistant(sessionID)`；该函数从
Message 表读取，而 Message 自身又以 `session_id → session.id` 外键依赖 Session。由此得到：

```text
完整 assistant response with UnknownError
  ⇒ processor failure 已完成收尾
  ⇒ lastAssistant(sessionID) 从数据库读取成功
  ⇒ response 时 Session 存在 ∧ assistant Message 存在
```

若整个 Session 在 Part INSERT 前被删除，Part 会先得到 FK，但 cleanup 随后的 Message upsert 又会因
Session 缺失失败，`lastAssistant()` 也无法读取正常 assistant；受控变体 C 的非 200 结果与此一致。
因此若现场 reason 最终是 FK，且 Issue 响应描述准确，所需 actor 必须更窄：只移除 assistant Message
而保留 Session，使 Part 失败后 cleanup 可以重建带 `UnknownError` 的 Message；或存在“删除后又以同一
ID 重建 Session”的未记录自定义流程。公开候选 caller 的整 Session OC3 DELETE 不满足该响应后置条件。

### 1.5 公开候选调用端与跨进程时间线

当前公开证据不能唯一定位 Issue 的现场调用端。与 Issue 最吻合的公开候选是同一作者的
`lihaokun/mcp-server-fsm`：OpenCode adapter 由
[`1b08e87728919503c314d06dcaa14174334e77e1`](https://github.com/lihaokun/mcp-server-fsm/commit/1b08e87728919503c314d06dcaa14174334e77e1)
于 2026-07-09 引入，早于 2026-08-01 的 Issue；审计快照
`1dc5577c6e78b373306d5d3dbe14e0535864e57f` 也早于 Issue，且其默认三 reviewer、临时 `fsm-gate` Session、
同步 prompt 后 cleanup 的形态与描述一致。但 Issue 正文/comment/artifact 没有仓库或 commit 链接，
候选仓库也没有反向引用 Issue #6，因此以下 caller 结论严格限定于该公开候选，现场身份仍待原始运行
配置或日志确认。候选实现位于
[`crates/server/src/agent_cli.rs`](https://github.com/lihaokun/mcp-server-fsm/blob/1dc5577c6e78b373306d5d3dbe14e0535864e57f/crates/server/src/agent_cli.rs#L235-L295)
。模块注释和端点结构都明确要求连接“already-running OpenCode server”；`judge_opencode()` 接收一个
`OpencodeEndpoint.base`，每个 HTTP 调用虽新建 Hyper client/连接，URI origin 仍来自同一 base。候选
仓库内没有启动 OpenCode server、server pool、负载均衡或 endpoint 轮换逻辑；但一个 base URI 是否
由代理分发到多个后端，不能仅从客户端源码判定。其 OpenCode 适配流程是：

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
Rust `http_json()` 也没有除 `bounded(prompt_timeout, ...)` 之外的 read/response timeout；候选代码内
没有代理层，但实际 base、外部代理与后端 PID 仍待现场确认。故在没有未保存 YAML、自定义 binary、
外部代理或不同 runtime 默认值的前提下，当前可见连接模型不能把 39.9 秒窗口转换成 timeout-cleanup。

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
`agent_cli.rs`，没有按 `fsm-gate` title 批量回收的第二个 actor。因此公开候选 caller 内部“一个 reviewer
误删另一个 reviewer session”已被代码反证；若现场发生这种删除，只能来自未记录版本或 caller 外部。

Issue 示例同时提供了可从 ID 还原的时间证据。生成器先计算
`current = timestamp * 0x1000 + counter`，再保留其低 48 位；ascending 的 Message/Part ID 直接编码
该值，descending 的 Session ID 则编码该 48 位值的按位补码。由于只保留 48 位，timestamp 实际按
`2^36` ms 取模；必须结合 SQL 中已知的 `time_created=1785600488974`，并分别按 ascending/descending
规则选择最近的时间环，才能还原为：

| 现场对象                | 还原的 UTC 时间          | 相对 Part SQL |
| ----------------------- | ------------------------ | ------------: |
| Session ID              | 2026-08-01 16:07:29.014Z |    -39,960 ms |
| assistant Message ID    | 2026-08-01 16:07:29.043Z |    -39,931 ms |
| step-start Part ID      | 2026-08-01 16:08:08.973Z |         -1 ms |
| Part SQL `time_created` | 2026-08-01 16:08:08.974Z |          0 ms |

这证明从 Session/assistant Message **ID 生成**到首个 Part SQL 分别约 39.960/39.931 秒。ID 不记录
durable commit 时刻；源码只证明 Message ID 生成后紧接同步 `updateMessage()`，其完成后才进入 initial
Snapshot。因此 39.931 秒是“Message ID 生成→Part SQL”的精确区间，也是“Message durable commit→Part
SQL”的上界，而不是后者的精确耗时。该时长在数值上贴近 40 秒，但已知候选 caller/server/runtime 链
没有对应 deadline；默认 reviewer timeout 又是 600 秒。因此它目前只证明首 Part 前存在长尾窗口，
不能继续单独作为 timeout-cleanup 的强证据。只有原始配置或代理日志恢复出约 40 秒 deadline，且现场
caller outcome 为 timeout/transport ambiguity，才能重新解释几十毫秒差值是连接、解析和调度开销。

还需要修正此前对这段窗口的代码路径描述：processor 在启动 LLM stream 之前会无条件预捕获 initial
Snapshot，随后才解析 tools/system/plugin 输入并启动 provider；AI SDK 在收到首个有效 stream chunk 后发出
`step-start`。handler 通常复用 initial Snapshot，只有该值为 `undefined` 或空字符串时才再次
`snapshot.track()`，然后生成 Part ID。因此 39.931 秒区间的严格分解是：

```text
assistant Message ID generation
  → synchronous durable Message commit（未单独观测时间戳）
  → initial Snapshot wait + Git track
  → tools/system/plugin 与 model-message 准备
  → provider request / 首个有效 stream chunk
  → 可选的 Snapshot fallback（仅 initial 结果为 falsy）
  → PartID.ascending()
  → Part durable transaction
```

Issue Part payload 已包含非空 snapshot hash，证明写 Part 前至少一次 track 成功，但不能单凭 payload
判断成功的是 initial capture 还是 fallback。ID 只能证明从 ID 生成开始的整个前置窗口；其中还包含
durable Message commit，不能把 39.931 秒全部归因给 Snapshot，也不能精确分摊 provider 首 chunk 和
其他准备阶段。

`Snapshot.Service` 内部按 snapshot `gitdir` 维护单许可 semaphore；同一 worktree 的三个 session 会在
各自的 initial capture 上共享串行通道，其他 session 已经排入队列的 completion snapshot、patch、
restore 或 cleanup 也使用同一锁。因此“独立 session”不等于首 Part 前没有共享排队点。Snapshot 的 Git
子进程没有隐式 timeout；进程执行层也没有额外的全局队列。Git 调用失败会被 Snapshot 降级为普通
结果，最多导致空 hash 和 `step-start` fallback，不能直接生成 Part SQL 错误。Snapshot 本身不删除
Message、不访问 SQLite，故只能作为 timeout-cleanup 的延迟放大器，不能单独解释 Part SQL 失败。
默认 600 秒 reviewer timeout 下，39.9 秒仍不足以触发 cleanup；若现场有效 timeout 小于该尾延迟，
才形成“共享队列放大延迟 → OC2 timeout → OC3 DELETE → 迟到 Part FK”的完整候选链。

部署 provenance 仍缺一项：Issue 没有记录实际 OpenCode binary 的 commit/version。公开候选调用端设计
材料引用的 `v1.17.8`、fork 基线 `d12b1e924d`（v1.18.6）和当前分析基线都已逐项核对：initial Snapshot
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
放大边界；但公开候选 caller 的 session 关联、默认 timeout、已知连接链和 Issue 所述完整 `UnknownError`
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
reason、原生 code/errno/message 和关联 event/session/message/part ID。只有被原始 code 与最小复现
共同证明为瞬态、且整笔 durable event 可安全重试的错误才可在事务边界有界重试；2A 仅处理已确认发生
于事务起点的 lock error，2D 则按具体资源 reason 单独决策。约束、corruption 和未解释的
Part-statement lock 不得盲目重试。

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

每条记录必须包含实际 endpoint、处理请求的 server PID、session ID、HTTP status/响应体分类、单调时钟、
耗时和结果；运行头还必须记录实际 OpenCode commit/version/binary SHA、Bun/Effect 版本、
`sqlite_version()`、`sqlite_source_id()`、`mcp-server-fsm` commit、有效 reviewer `timeout_seconds`、
`n_reviewers`、Snapshot 是否启用以及数据库文件的 realpath/device/inode。还要枚举同一 uid 下所有
OpenCode PID、argv、启动时间、`OPENCODE_DB`/XDG 取值与打开的 DB/WAL/SHM fd，确认多个字符串路径是否
最终指向同一文件。先保持当前调用端行为作为基线；诊断变体只改变一个条件：OC2 为
timeout/request/body transport ambiguity 时跳过 OC3，保留 session 和数据库现场。OC2 已完整收包时仍
可执行 cleanup。第一次失败后从服务端诊断提取：

- `database.reason`、`database.code`、`database.errno`、`database.message` 与关联 assistant message ID；
  Bun 在不同 NOMEM 失败点可能只保留 `out of memory` message 而没有 code/errno，不能只按 code 判空；
- `assistant-message.commit`、`snapshot.initial.wait.start`、`snapshot.initial.lock.acquired`、
  `snapshot.initial.end`、tools/system 准备完成、`provider.request.start`、`provider.first-chunk`、
  `provider.step-start.received`、可选 `snapshot.fallback.*`、`part-transaction.wait.start`、
  `part-transaction.begin.succeeded` 与 `part-upsert.start` 的同一单调时钟；
- 每个 Session/Message 删除事件的入口来源（HTTP session DELETE、workspace removal、CLI、revert、
  remote replay 或外部 writer）、request/admission/transaction begin/commit 时间与关联 ID；HTTP
  deleteMessage 若在 active session 上不是预期的 409，还必须记录接收删除的 server PID、拥有 Runner
  的 PID、它绕过进程内 busy guard 的版本/调用链，以及两个 PID 是否打开同一 DB inode；
- 若为 Constraint：在清理前查询 Session、parent Message、目标 Part 是否存在，并运行
  `PRAGMA foreign_key_check`；由于 `Session.remove()` 随后会清除该 aggregate 的 durable event history，
  必须先保存删除 source 日志和数据库现场；
- 若为 LockTimeout：记录失败 query 是 `BEGIN IMMEDIATE` 还是 Part，并枚举同一数据库文件的其他
  process/connection；Part statement 上若为 `SQLITE_LOCKED`，还要记录扩展 code、数据库 open URI、
  shared-cache 配置和未完成 statement；
- 若为 `SQLITE_CORRUPT` 或 `SQLITE_IOERR_*`：在任何 checkpoint、重启或 cleanup 前把 DB、WAL、SHM
  作为一组保留，记录所有打开同一路径的 PID/connection、checkpoint 来源与时间，同时保存 kernel/
  filesystem I/O 日志；不得只复制主 DB 后运行修复命令。瞬态 WAL read EIO 已证明可能向上表现为
  `SQLITE_CORRUPT`，所以 code 不足以单独区分“持久字节损坏”和“本次读取失败”；
- 无论错误分类，都记录 `PRAGMA integrity_check`、`journal_mode`、`foreign_keys`、`busy_timeout`、
  `compile_options`、`database_list`、`page_count`、`page_size`、`cache_size`、`cache_spill`、DB/WAL 文件大小，
  以及进程 RSS/cgroup memory limit、磁盘/quota/文件系统状态；
- 若无清理/all-settle 变体仍失败：优先调查 statement-specific 资源错误，而不是继续调整 DELETE
  时序。

同一原始 harness 再运行两个单变量对照：一组设置 `snapshot: false`，观察三路 Message→Part 尾延迟与
失败是否消失；另一组保留 Snapshot，但只对 ambiguous outcome 禁止 DELETE。前者只能判断 Snapshot
是否为延迟放大器，不能单独证明 SQLite 根因；后者与 E/F 一起判断 DELETE 是否为 FK 的必要破坏动作。

判定标准：

- 若 OC2 成功收完整 response body，body 内已经包含 `UnknownError`，则对该次失败否定 2C，必须用
  `database.reason` 在服务端内部继续定类；同时在 response 前后查询 Session 与 assistant Message，
  正常 assistant response 应证明两者存在，并否定整 Session 提前删除。Issue 当前文字描述属于这一
  分支，但仍需原始 outcome 日志复核；
- 若 caller 实际记录 `Timeout` 或 request/body transport error，且同一 session 出现 FK；跳过 OC3 后
  FK 消失，则确认 2C；若 initial/fallback Snapshot wait 占据主要尾延迟，则同时确认它是触发概率
  放大器而非删除根因；
- 若完整 response 的 reason 为 FK，则优先记录 replay、外部 writer 或其他 Message-only 删除 source；
  标准 HTTP `deleteMessage` 与 revert 的 busy guard 都是 process/directory local；双 server 临时诊断已
  确认 `deleteMessage` 可由非 owner server 成功执行并闭合 FK/HTTP 200 指纹。revert 仍需要既有 revert
  state，不能由这次结果直接视为现场 source。无论哪种入口，都必须记录请求 PID/owner PID、共享 DB
  identity、版本与调用链；受控闭包只证明条件机制，不得在缺现场第二进程/路由证据时直接归因，也不得
  因已有整 Session FK 复现就直接归因 2B/2C；
- 若完整 response 的 code 为 `SQLITE_CORRUPT`/`SQLITE_IOERR_*`，则进入 WAL/VFS 取证并和第五阶段对照；
  若 ambiguous outcome 但无 FK，或完整 response 与其他 SQLite reason 相关，则为该 reason 建立新的
  最小复现。资源/VFS 类进入 2D，不能把 timeout 与任意 UnknownError 自动关联，也不能先做通用 retry。

该协议的目标是同时建立“错误类型”“caller 观察到什么”和“谁先于谁”的证据；只取得其中一项仍
不足以选择 2A/2B/2C/2D。

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

多进程审计把“第二进程”再拆成两类。所有正式 channel 默认共享用户级 `opencode.db`，且没有数据库
单实例 flock，所以另一 OpenCode CLI/server 确实可以建立额外 connection；但普通外部 writer 仍受上表
BEGIN 边界约束。另一进程启动时还会执行 `wal_checkpoint(PASSIVE)`，故用 250 轮临时诊断固定时序：A
成功 `BEGIN IMMEDIATE` → B 进程打开同一 DB 并完成 WAL/PASSIVE checkpoint invocation → A 执行
Part-like INSERT/commit。该固定调度下 250/250 全部成功，最终 integrity/FK 检查正常；这表示该实验
没有观察到“启动 checkpoint 使已持写事务的下一条 Part statement 失败”，不构成对其他 checkpoint/write
时序或故障注入场景的普遍安全证明。若要从多进程解释 `CORRUPT/IOERR`，仍须提供旧 SQLite WAL-reset
前提或真实 VFS/filesystem fault，而不能只证明“机器上有第二个 PID”。

其他已确认事实也支持这一判断：

- 数据库初始化已设置 WAL、`busy_timeout = 5000`、`foreign_keys = ON`；
- `sqlite.bun.ts` 的 transaction acquirer 在整个 transaction scope 内持有单许可 semaphore；相关
  durable Message/Part/Delete projector 均通过该路径串行化。普通 acquirer 的许可虽然只覆盖“返回
  connection”这一 Effect，但生产 `run()`/`runValues()` 随后执行的 `native.query(...).all()/values()`
  是同一 JS fiber 内无 yield 的同步调用，permit 释放时等待 transaction 的 fiber 只会进入后续调度；
  statement 中间没有可供另一事务插入的异步边界。针对“permit release 后、同步 execute 前被等待事务
  抢占”的疑点，又分别用现场版本 Effect `4.0.0-beta.74` 和当前 `beta.83` 跑了 20,000 次 FIFO 调度模型，
  两组 `borrowed=0`；当前未实现的 stream 路径不参与 Issue；
- 单个 headless server 进程使用共享 AppRuntime/memo map，只有一个 Database service；该结论不跨进程，
  默认 DB 路径允许其他 OpenCode 进程打开同一文件；
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

跨 Session ID 复用也已进一步排除。公开候选 caller 的 prompt body 不传 `messageID`，assistant/Part ID
由 OpenCode 自行生成；生成器在时间/单调 counter 外还有 14 位 Base62 随机后缀，约 83 bit。自然碰撞
不仅概率上无法解释 7 次同类故障，实际三个 reviewer 也没有共享 caller-supplied message/part ID。
因此不能再用主键碰撞解释“一个 Session cleanup 删除另一个 Session 的 parent Message”。

Part INSERT 的 statement-specific 候选仍包括：parent Message 在 BEGIN 前已不存在造成的 foreign-key
constraint；磁盘满、I/O、corruption、readonly、内存不足等 SQLite 资源错误；以及由未观测额外连接或
plugin 引入的 shared-cache/table/schema/reentrant 等非常规锁形态。当前 schema 中 `id` 主键冲突已有
`ON CONFLICT DO UPDATE`，所有 `NOT NULL` 参数均已出现在日志，`session_id` 没有 FK；因此对这组具体
参数，`message_id → message.id` 是唯一现实约束候选。

历史 schema 审计把“其他约束”从候选中移除。`v1.17.8` 的生成 schema、初始 migration 与当前定义
完全一致：`part` 只有主键 `id`、五个 `NOT NULL` 数据列和一个
`message_id REFERENCES message(id) ON DELETE CASCADE`；没有 CHECK、trigger、额外 UNIQUE，也没有
`session_id` FK。后续 migration 只把 `part_message_idx` 替换为覆盖 `message_id,id` 的索引，不改变
约束。因此新诊断若是 `ConstraintError`，对 Issue 这组合法参数几乎可以直接等价为“parent Message 在
Part INSERT 时不存在”，不再保留“部署版本存在隐藏 Part 约束”的平行分支。

资源错误还可继续分层：`SQLITE_TOOBIG` 与仅含 snapshot/type 的小型 payload 冲突；`SQLITE_INTERRUPT`
与无 native interrupt 调用及 transaction uninterruptible 边界冲突；`SQLITE_READONLY` 必须解释为何
同一 prompt 的 assistant Message 刚刚还能写入。当前没有磁盘、quota、文件系统或进程资源证据，也没有
解释“三路中经常恰好一路”的代码机制，因此资源错误仍不能直接定为根因。但“corruption 通常持续”已
不能用于统一下调所有 `SQLITE_CORRUPT`：受控 WAL `pread64/EIO` 在 Bun/SQLite 上恰好暴露为可恢复的
`SQLITE_CORRUPT`，并完整闭合 Issue 外形。当前主要非 Constraint 分支应改写为“WAL/VFS read fault，
现场 code 可能是 `SQLITE_IOERR_*`，也可能是 `SQLITE_CORRUPT`”；NOMEM 小 payload 与 FULL 典型路径
仍按既有实验下调。同步端点的 happens-before 否定了“正常 post-await DELETE 抢先删除 parent”，所以
即使 FK 是唯一现实 constraint，也不能在取得原始 reason/caller outcome 前把 Issue 正式定为
foreign-key failure。

针对 `SQLITE_FULL` 又完成了真实 Effect + Drizzle + Bun SQLite 容量实验。内存库与 WAL 文件库都先
成功提交 parent Message，再把 `max_page_count` 固定到当前页数；`BEGIN IMMEDIATE` 成功后，使用大 Part
payload 强制 INSERT 得到 `SQLITE_FULL`。两种 journal mode 下 SQLite 都自动结束了事务，transaction
finalizer 随后执行 `ROLLBACK` 并得到 `cannot rollback - no transaction is active`，最终暴露的是裸
Effect `SqlError`，而不是 Issue 的 `EffectDrizzleQueryError: Failed query: insert into part`；parent
Message 保留，Part 为零，之后 DELETE parent 仍可成功。这使该实验覆盖的典型容量耗尽路径与 Issue
外形不相容。SQLite 官方语义同时说明 `FULL/IOERR/NOMEM/INTERRUPT` 可能只回滚当前 statement，也可能
回滚整个事务，取决于失败点；故这个结果显著下调 `FULL`，但不能逻辑外推为彻底排除所有
`IOERR/NOMEM` 或所有可能的 `FULL` 失败点。

针对 `SQLITE_NOMEM` 又完成了两层 hard-heap-limit 实验。大参数在 statement binding/execution 内耗尽
内存时，真实 adapter 可以得到 Issue 同形的 `EffectDrizzleQueryError`，事务仍能正常 rollback；但这条
路径依赖约 4 MB 参数，与 Issue 已打印的微小 `step-start` JSON 不同。把 payload 换成 Issue 同规模后，
真实 adapter 在 100.0–100.3 KB 阈值只会先于 execution、于 `native.query()`/`safeIntegers()` 阶段抛裸
`SQLiteError: out of memory`，事务仍打开且没有 Drizzle wrapper；从 100.4 KB 起则直接成功。2 KB 粗扫
100–120 KB 也没有找到“小 payload + execution wrapper + rollback 成功”的窗口。该实验不能证明所有
allocator/VFS 下都不可能出现 statement NOMEM，但已显著下调它相对 IOERR 的优先级；现场诊断还必须
保留原始 message，因为某些 Bun NOMEM 点没有 code/errno，只能看到 `out of memory`。

针对 WAL/VFS read fault 又完成了 adapter 与完整 HTTP 两层实验。preload shim 只在 marker 后把目标 WAL 的
`pread64` 返回值改成 `-1` 并设置 `errno=EIO`；shim 自身未更改 DB/WAL 内容。单连接 adapter 中，BEGIN 后
`PRAGMA shrink_memory` 强制的小型 INSERT cache miss 得到 Issue 同形 `EffectDrizzleQueryError`；但 Bun
上报的不是 [SQLite 定义的 `SQLITE_IOERR_READ`](https://www.sqlite.org/rescode.html#ioerr_read)，而是
`SQLITE_CORRUPT`/errno 11/`database disk image is malformed`。
事务仍能 rollback，parent 保留、child 为零，后续写入成功。完整 server 为了确定性制造 Part 页
cache miss，使用第二连接写入再删除 probe Part；provider release 后前两次 WAL read EIO 被内部路径吸收，
第三次击中 Part statement，最终得到 HTTP 200 assistant `UnknownError`、Session=1、assistant Message=1、
assistant Part=0、`foreign_key_check=0`。第四次继续注入会污染 cleanup，说明该实验只证明机制可行，不代表任何 EIO 次数
都能生成 Issue 指纹，也不证明现场文件实际损坏。

另对 SQLite 2026 年披露的 [WAL-reset bug](https://www.sqlite.org/wal.html#the_wal_reset_bug) 做了版本/
运行图审计。官方前提是至少两个不同 thread/process 的 connection 对同一 WAL 并发 checkpoint/write；
问题可能影响 3.7.0–3.51.2；3.51.3 起修复，官方还把修复回移到 3.44.6 与 3.50.7。`v1.17.8` 的直接
构建证据是：根 `package.json` 固定 Bun 1.3.14，正式 publish workflow 的共享 setup action 从该字段
安装 Bun，CLI build 再直接用这个 Bun 的 `Bun.build({ compile })` 生成可执行文件。本机安装的同一官方
Bun 1.3.14 运行时测得 SQLite 3.53.0、source date 2026-04-09、
`DEFAULT_WAL_AUTOCHECKPOINT=1000`；这支持正式构建通常已越过修复边界，但不是对 Issue 现场 binary 或
某个已下载 release artifact 的直接测量。默认路径虽允许第二进程共享 DB，固定调度的 250 轮启动 PASSIVE
checkpoint 对照也均未失败。只有现场 binary 的 `sqlite_source_id()`/版本属于未修复来源（即不是
3.44.6、3.50.7 或 3.51.3+），并证明另一个 process/connection 与 OpenCode 并发 checkpoint/write，才
重新打开该分支；必须用 binary SHA 与运行时 `sqlite_source_id()` 验证，不能从版本标签、仓库 lockfile
或本机同版 Bun 单独推断。

readonly 状态实验也限定了权限分支：在事务前设置 `PRAGMA query_only=ON` 时，失败发生在
`BEGIN IMMEDIATE`，不会生成打印 Part SQL 的 wrapper；只有在 BEGIN 成功后再切换 query-only，Part
INSERT 才会得到同形的 `SQLITE_READONLY`。生产代码没有 `query_only`、`max_page_count` 或 native
interrupt setter，运行期 PRAGMA 只有 WAL、synchronous、busy timeout、cache、foreign keys 与
checkpoint；migration 的临时 foreign-key 开关发生在服务启动阶段且只会放宽约束。因此 READONLY 若要
成立，必须来自事务中途的未记录自定义 connection/VFS/filesystem 变化，不是标准运行图。

综合 wrapper、transaction 与正常 assistant response，可把 execution-time 错误压缩为：

| SQLite 类别                       | 能否到达 Part statement          | 能否解释正常 `UnknownError` assistant            | 当前结论                                           |
| --------------------------------- | -------------------------------- | ------------------------------------------------ | -------------------------------------------------- |
| `CONSTRAINT`                      | 可以                             | Message-only 删除后由 cleanup 重建 Message       | 双 server 标准 HTTP 机制已复现；现场 source 未确认 |
| 普通 `BUSY`                       | 否，应先失败于 `BEGIN IMMEDIATE` | 否                                               | 已反证                                             |
| 非常规 `LOCKED`                   | 仅 shared-cache/table/reentrant  | 理论可                                           | 标准连接图不具备前提                               |
| `READONLY`                        | 仅 BEGIN 后状态突变              | 理论可                                           | 生产无 setter，显著降级                            |
| `IOERR` / 瞬态 WAL-read `CORRUPT` | 可以                             | statement rollback 后 cleanup 可成功             | 完整机制已复现；现场 VFS 证据仍缺失                |
| `NOMEM`                           | 理论可以                         | 同上；且必须绕过小 payload 的 prepare-first 失败 | hard-limit 小 payload 未复现，进一步降级           |
| `FULL`                            | 可以                             | 典型实验被 auto-rollback/finalizer 改写          | 显著降级                                           |
| 持久 `CORRUPT/NOTADB`             | 可以                             | cleanup 随后立即成功较难解释                     | 仍为低优先级；不得与瞬态 read fault 合并           |
| `TOOBIG/MISMATCH/RANGE/INTERRUPT` | 与小型合法参数或调用图冲突       | 否/无前提                                        | 排除或近似排除                                     |

公开候选调用端和 TCP 对照把候选改成条件决策树，而不是单一排序：

1. **完整 OC2 response 已含 `UnknownError`（Issue 当前描述）**：2C 被排除。优先取得
   `database.reason`。response 前的数据库 `lastAssistant()` 读取证明 Session 与最终 assistant Message
   存在，所以“整个 Session 在 Part 前被删除”也被该次 outcome 排除。若新诊断为 Constraint，唯一
   相容的标准 schema 机制是 assistant Message 被单独移除、随后 cleanup 在仍存在的 Session 下将其
   重建；第二连接实验已完整复现该指纹。生产 active deleteMessage/revert 在同一进程、同一 session
   directory 实例上受 busy guard，但 guard 不跨进程。双 server 临时诊断已确认共享 DB 时非 owner server
   的标准 HTTP `deleteMessage` 能闭合该指纹；这把它从代码级候选升级为已确认机制，仍不能在缺少现场
   第二 PID/路由证据时升级为 Issue source。其他 source 仍包括 replay、绕过应用层的 external writer 或
   未记录版本。
   若 code 为 `SQLITE_CORRUPT`/
   `SQLITE_IOERR_*`，则进入 WAL/VFS 现场取证：受控 read EIO 已经复现“只回滚 statement、事务可正常
   rollback、cleanup 返回完整 assistant”的闭包，不能再因 code 是 CORRUPT 就默认要求持续损坏；但也
   不能从这一闭包反推现场 EIO。`SQLITE_FULL` 仍须解释为何没有实验中的自动回滚/finalizer 外形，
   `SQLITE_NOMEM` 仍须解释为何小 payload 没有先在 prepare/safe-integers 阶段成为裸 defect。
2. **OC2 timeout/request/body transport ambiguity**：若同一 session 的 reason 是 FK，则调用端无条件
   OC3 成为最高候选；真实 TCP E/F 已证明 abort 本身安全完成，而 abort + DELETE 稳定制造 FK。Issue
   样本存在约 39.9 秒 Message ID generation→Part SQL 窗口，同 worktree Snapshot 又会串行化，可放大
   尾延迟；但 reviewer 默认 600 秒且聚合器等待全部任务，所以必须先证明现场有效 timeout 小于该尾延迟。即使成立，它也
   解释的是 timeout/transport error outcome，不会生成 Issue 所述的完整 assistant response。
3. **普通 WAL writer 竞争**：Issue 的 Part-query 失败位置与成功 `BEGIN IMMEDIATE` 后不再返回
   `SQLITE_BUSY` 的语义冲突，当前按“已反证”处理，而不只是低优先级。只有实际部署代码没有使用该
   事务边界，或原始日志证明失败查询并非 Issue 展示的 Part INSERT，才能重新打开该分支；
   `SQLITE_LOCKED`/schema/shared-cache 属于另一类非常规 statement lock，不能借普通 WAL 竞争之名进入
   2A 重试。

综合最新证据，**ambiguous outcome → OC3 DELETE → FK** 仍是已确认、可确定复现的独立缺陷机制，但不再
是 Issue 的默认最高候选：它不仅与“OC2 已完整返回 `UnknownError`”因果互斥，其整 Session 删除还不能
满足正常 assistant response 所证明的数据库后置条件。公开候选 caller 默认 600 秒、已知连接链没有约
40 秒 deadline，三路 task 也不存在 session ID/response 串线或第二个 cleanup actor。当前 Issue 归因
收敛为两个缺关键现场证据的分支：若新 reason 为 FK，则先验证是否存在共享 DB 的第二 server，并继续
寻找 caller 外部、未记录版本、显式 MessageRemoved/replay 或外部数据库 writer 造成的 **Message-only**
删除；若 code 为 `SQLITE_CORRUPT`/`SQLITE_IOERR_*`，则检查 WAL read/VFS/filesystem 故障并把 DB/WAL/SHM 作为整体取证；
NOMEM 作为更低优先级分支保留。普通 WAL 竞争、durable event
重排、公开候选 caller 的整 Session 误删和隐藏 schema 约束均不再与这两个分支并列。

Issue 明确写的是请求“返回”带 `UnknownError` 的 assistant 响应，所以当前默认应按分支 1 推进；不能
仅因公开候选 caller 存在 timeout 就把 2C 当成这 7 次记录的根因。

只有把新的结构化诊断部署到原始环境并捕获一次失败，才能先用 `database.reason/code/message` 在上述
两条分支间选择；若为 FK，应优先记录 MessageRemoved source 与失败前后 Session/Message 存在性；若为
`SQLITE_CORRUPT`/`SQLITE_IOERR_*`，应先保存三件套、SQLite source ID、所有 connection/checkpoint 与
kernel/filesystem 日志。只有原始 outcome 实际为 timeout/transport ambiguity 时，才重新转向调用端
prompt/delete 与服务端 writer 的关联时间线。

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
缺陷机制。公开候选调用端的 timeout-cleanup 可以提供这个顺序；TCP 变体 F 已证明 HTTP waiter rejection
之后的新连接 DELETE 会稳定制造同一 FK。对照 E 则证明 waiter rejection 本身不会取消 Runner：不
DELETE 时 Runner 会继续写入 Part、回到 idle 并持久化完整 structured result。直接 Runner ownership
实验又独立证明 interrupt `ensureRunning()` 的 waiter 后，instance-scoped work fiber 仍继续执行完成，
排除了“只是 fetch/SDK 测试实现没有正确取消”的替代解释。

这把“机制是否真实”与“Issue 是否走过该机制”彻底分开：前者已经确认；后者按 Issue 所述完整
`UnknownError` response 反而受到反证。只有 caller 原始 outcome 与描述不一致、实际为 ambiguity，且
同一 session reason 为 FK 时，才能确认 Issue 走过这条路径。

确定性用例还锁定了外部结果差异：整 Session DELETE 与活跃 prompt 交叉时，prompt 即使 settle 也不是
HTTP 200；Issue 则返回可读取的 assistant `UnknownError`。因此本节机制保留为独立生命周期缺陷与 2B/2C
条件修复依据，不再作为 Issue 完整响应分支中的默认 FK 解释。

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

历史 schema、迁移和当前定义均确认没有第二个 Part 外键或隐藏约束。能够让 parent 缺失的 actor 只有：
Session Deleted 的级联删除、显式 MessageRemoved、对应 replay，或绕过应用层的外部数据库 writer。
生产调用面审计进一步得到：

- `Session.remove()` 只由 session HTTP DELETE、workspace removal 和 CLI session delete 调用；没有按
  `fsm-gate` title、TTL、request completion 或 Snapshot 自动清理的后台入口；
- Message 删除只来自显式 HTTP deleteMessage 或 `SessionRevert.cleanup()`；`v1.17.8` 与当前 HTTP
  deleteMessage 都先执行 `runState.assertNotBusy()`，同一 server 进程、同一 session directory 实例内
  活跃 prompt 的真实 HTTP 对照返回 409；revert/unrevert 入口也有同一 guard，新建 `fsm-gate` Session
  又没有 revert state，prompt 开头的 cleanup 会直接返回。`InstanceState` 是按 directory 分区的进程内
  cache；正常 session HTTP 路由会先加载 session 并使用其已保存的 `directory`，所以单个 server 的正常
  session 路由不会因任意 query/header 自动跳到另一个 map。但共享 DB 的第二 server 有独立 cache，仍
  看不到第一 server 的 Runner；该 guard 不查数据库 lease/owner/status，因而不是跨进程互斥；
- 公开候选 caller 没有发送 workspace 参数/header，进程又没有 `OPENCODE_WORKSPACE_ID` 时，Session 创建得到
  `workspace_id = NULL`；workspace removal 只筛选等于具体 workspace ID 的行，无法命中；
- ACP `session.remove` 只修改 ACP 内存 map，closeSession 对 backing Session 调用 abort 而非硬删除；
- durable replay 的生产入口仅为显式 sync API 与 remote workspace sync；公开候选 caller 不调用 sync，且该
  本地 Session 不属于 workspace。公开 prompt body 也不提供 `messageID`，OpenCode 生成 ID 还有约 83 bit
  随机后缀；跨 aggregate 自然碰撞不能解释普通三路 fan-out 或 7 次重复；
- 候选 caller 仓库内没有第二个 OpenCode Session DELETE caller；每个 reviewer 又使用自己的局部 `sid`；
  `judge_opencode()` 固定使用一个 already-running `OpencodeEndpoint.base`，不启动第二 server 或轮换
  origin，但客户端源码不能排除该 origin 前方存在代理或多个后端。

同一服务进程内的 DELETE 和 Part transaction 使用同一 semaphore：DELETE 先取得许可并提交，则随后
Part INSERT 得到 FK；Part 先取得许可，则 DELETE 只能等待，Part 成功后再级联删除。但整 Session DELETE
还会移除 Session row，使失败收尾时的 Message upsert/`lastAssistant()` 无法形成 Issue 的正常 assistant
response。因此 **FK + 完整 `UnknownError` response** 还要求删除粒度是 Message-only，或要求一个未记录
流程在 cleanup 前以同一 ID 重建 Session；标准 OC3 整 Session DELETE 不能闭合该后置条件。

第二 SQLite connection 的受控实验进一步证明 Message-only 闭包本身完全成立：在 assistant 已提交、
assistant Part=0 时直接删除 Message，再释放 provider，Part 稳定得到 FK；processor halt/complete 随后用
内存中的 assistant 重新发布 `MessageUpdated`，最终 HTTP 200 返回 `UnknownError`，数据库为 Session=1、同 ID
Message=1、assistant Part=0，`foreign_key_check=0`。因此如果现场 reason 为 FK，响应指纹不再只是“暗示”
Message-only，而是已有同构复现；尚未确认的只剩现场删除 source。同进程标准 HTTP/revert active 路径
被 local busy guard 拒绝，但双 server 临时诊断已确认：若两个 server 打开同一 DB，非 owner server 的
标准 HTTP deleteMessage 可返回 200，并在释放 provider 后得到 FK、同 ID `UnknownError` assistant 与
assistant Part=0。revert 虽共享 process-local guard，仍需要 revert state，本次没有把它闭合为具体 source。
若现场严格只有一个 server，则优先级最高的 source 仍是 MessageRemoved replay、绕过 Database service
的外部 writer，或现场未记录版本中的自定义入口。

`Session.remove()` 在发布 Deleted 后还会删除该 aggregate 的 EventSequence/Event 历史，所以事后只看
数据库可能已经失去删除来源证据。必须在 HTTP/workspace/CLI/replay 等入口记录 source 和 correlation。
完整 response 分支应优先记录 MessageRemoved replay、外部 writer、共享 DB 的第二 server；若 active
HTTP deleteMessage/revert 成功，则接收请求的 PID 与 Runner owner PID 是否相同就是关键判据；
只有现场证实 FK 且 OC2 outcome 实际为 ambiguous，公开候选调用端自身的 OC3 Session DELETE 才重新成为
压倒性的应用层删除源。

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

若现场使用该公开候选调用端，最安全的诊断性规避是：只有 OC2 完整收取 response body 后才 DELETE；
timeout、request error 或 body transport error 都属于服务端执行状态未知，不立即清理，而是记录 orphan session，等待
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
  切入本次 Part statement；Effect beta.74/beta.83 各 20,000 次 FIFO 模型也未观测到 transaction 借入。
  若未来实现异步 stream/driver，必须重新把 permit scope 纳入并发契约；
- 同 worktree 的 initial/fallback/completion Snapshot 串行化会把不同 Session 耦合到首 Part 前的尾延迟
  队列；在外部 deadline 存在时应分别记录 lock wait，而不能把“独立 Session”误写成“关键路径无共享
  资源”；
- 任意“请求结束即硬删除临时 session”的调用端都存在相同跨进程契约风险，尤其是自定义 timeout、
  连接断开和 response body 未收完整的分支。
- `SessionRunState` 的 Runner/busy ownership 是进程内状态，而默认 `opencode.db` 是用户级跨进程共享资源。
  因此“active delete 有 busy guard”隐含依赖所有该 Session 请求均路由到 owner server；第二 server、代理
  分流或直接 DB actor 会破坏这个 Rely 条件。若产品允许多 server 共享 DB，修复不能只加强本地 Map；
  必须选择跨进程 lease/owner 协议或显式禁止第二 writer 进程。
- 只对齐内层 SQLite code 不足以判定同一根因：整 Session 删除和 Message-only 删除都能制造 Part FK，
  但前者不能产生 Issue 的正常 assistant response。诊断/回归必须同时断言 HTTP outcome 与失败后
  Session/Message 行存在性；
- `FULL/IOERR/NOMEM/INTERRUPT` 可能自动结束整个事务；此时 transaction finalizer 的失败可能遮蔽原始
  statement cause。若后续资源实验进入该分支，诊断应在 statement adapter 边界保留 primary cause，
  不能只依赖最外层 halt 错误。
- 资源诊断不能只依赖 code/errno：Bun 在部分 NOMEM execution 点只返回 `out of memory` message；同时
  Issue 规模的小 payload 在 hard-limit 扫描中先于 execution 于 prepare/safe-integers 失败。必须把原始
  message、失败阶段与 transaction 是否仍 active 一起记录，不能把所有“内存不足”视为同一形态。
- SQLite code 也不是底层 syscall 的一一映射：受控 WAL `pread64/EIO` 在本次路径中暴露为
  `SQLITE_CORRUPT`，三次 read fault 才闭合完整 HTTP 指纹，两次被吸收、四次又污染 cleanup。因此诊断
  必须同时保留 code/message、DB/WAL/SHM、syscall/filesystem 证据与错误后的可用性，不能把 CORRUPT
  直接解释为持久字节损坏或瞬态 EIO。
- SQLite WAL-reset race 只在未修复 SQLite、多 connection 且 checkpoint/write 精确交叉时重新开放；正式
  `v1.17.8` 构建链直接固定 Bun 1.3.14，本地同版 Bun 测得 SQLite 3.53.0，固定调度的 250 轮外部启动
  checkpoint 未观察到失败；这些都不能替代实际部署 binary SHA/source ID。

## 三、参考实现对照（算法类 bug 必填）

本问题不是算法结果与参考实现不一致，因此算法逐步对照不适用。可依赖的规范性分类是当前已经使用的
Effect `classifySqliteError()`：约束错误为不可重试，busy/locked 为可重试的 lock timeout。修复必须
保留这一区分，不能用 query 文本或字符串包含关系重新猜测。

| 步骤 | 输入 / 状态                  | 当前实现                                  | 规范性处理                                      | 首个差异                        |
| ---- | ---------------------------- | ----------------------------------------- | ----------------------------------------------- | ------------------------------- |
| 1    | Bun SQLite exception         | `classifySqliteError()` 生成结构化 reason | 相同                                            | 否                              |
| 2    | Drizzle query failure        | cause 被保存在包装对象中                  | cause 应继续可提取                              | 否                              |
| 3    | Session 日志/assistant error | 已提取安全诊断并用 message ID 关联        | 记录 reason、code、retryable 与关联 ID          | 已修复                          |
| 4    | 是否重试                     | 当前没有 SQL reason 驱动的策略            | lock timeout 默认可重试；资源 reason 需另证契约 | 待取得 Issue 原始 reason 后决定 |

参考来源：仓库锁定版本的 Effect SQL `classifySqliteError()` 及现有
`packages/core/src/database/sqlite.bun.ts` 调用方式。

## 四、修复方案

修复分为一个已完成的诊断单元、一个只在事务起点锁证据成立时启用的 2A、一个可独立决策的服务端生命周期
加固单元 2B、一个只在 timeout/transport 时间线相关性成立时启用的调用端契约修复 2C，以及一个仅在
非 Constraint 资源/VFS reason 实证后启用的 2D。单元 1 已使后续失败可定类；2A 仍需
`BEGIN IMMEDIATE` 的 LockTimeout reason；Part-statement lock 必须另开最小复现与修复单元；2B 所针对
的机制已经受控复现；2C 的源码触发路径
与真实 TCP 正反对照均已确认，但 Issue 当前所述完整 response 把它排除在这批记录之外，除非原始
outcome 日志证明描述有误；2D 必须先保留 primary cause 并复现具体 code，不能设计通用资源重试。
Snapshot 共享通道只列为触发概率放大器，不新建修复单元；只有测得其 lock wait 穿过现场 deadline 后，
才另行评估性能/调度加固。四条条件决策线不得混为一条。

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

### 单元 2B：当现场证明 Session/Message 删除参与，或产品契约要求防御活跃删除时

单独捕获到 Part FK 已不足以进入本单元：完整 assistant response 下的 FK 默认要求 Message-only 删除，
而本单元协调的是 Session/Message admission/delete 生命周期。只有删除 source 证明标准删除入口参与
同一故障，或产品明确要求把已确认的活跃删除缺陷作为 defense-in-depth 修复时，才启用以下方案。

双 server HTTP 临时诊断已经确认非 owner server 可删除 owner server 的活跃 Message，因此当前产品
实现的跨进程 ownership 契约缺口本身已成立；这仍不等于 Issue 现场根因。若产品支持多个 server 共享
同一 DB，或现场证明确实走过该拓扑，必须先回到架构确认门，在两类方案中选择：

1. **单数据库 owner**：以数据库路径 identity 获取进程级独占 lease/lock；第二个会写同一 DB 的
   OpenCode server 明确拒绝启动或转为连接 owner，不允许 split-brain；
2. **数据库内 session lease**：把 owner/generation/expiry 与 prompt/delete admission 放入可线性化的
   durable transaction，任何进程删除前都验证 owner/lease，并定义崩溃接管。

只在 `SessionRunState` 本地 Map 上增加 gate 不能修复第二 server；仅依赖代理 session affinity 也不能
阻止 CLI、另一个 endpoint 或外部 actor 访问同一 DB。只有产品契约明确禁止第二 writer server，且能
在启动/部署边界强制该前提时，才可把以下本地 coordinator 作为较窄方案继续评估；“这次现场只看到
一个 server”本身不足以证明未来不会出现第二进程。

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
共享资源：用户级 DB/WAL/SHM、Session lifecycle、进程内 Runner map。
Rely：若采用本地 coordinator，则同一 Session 的所有写/删请求必须由同一 server 进程处理；
      若产品允许多 server 共享 DB，则该 Rely 不成立，必须采用单 owner 或数据库内 lease。
Guarantee：Deleting 之后不再授予 writer lease；Deleted 提交前所有既有 writer 已退出；
           任何非 owner 进程不能绕过该判定删除 Message/Session。
Invariant：state == Deleted ⇒ 未来不存在该 session 的 Message/Part durable event。
```

最小修正后逻辑：prompt 正在写 Part → 删除请求被拒绝，或等待 processor/background writer 完全
停止 → Deleted 级联清理 → 此后不存在迟到的 PartUpdated。

### 单元 2C：调用端 timeout/transport cleanup 契约（仅当时间线相关性成立）

若现场确认使用该公开候选且进入 ambiguous 分支，根因层修改位于外部调用端
`mcp-server-fsm/crates/server/src/agent_cli.rs`：

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
   候选调用端未提供 idempotency key。因此 ambiguous outcome 后不得自动重放。
4. **交付与顺序**：完整 response body 建立“服务端 prompt settle happens-before OC3”；timeout/transport
   failure 只建立“客户端停止等待”，不建立服务端完成。不同连接间没有 FIFO、因果完成或全序保证。
5. **失败模式**：假设对端 fail-stop/slow response 与普通网络错误，不考虑拜占庭行为；timeout、request
   error、body error 都是 ambiguous，Runner 可继续，cleanup 可与 writer 竞态。候选调用端本身不管理
   OpenCode 后端 ownership；若同一 base 前方实际有多个共享 DB 的后端，服务端缺少 durable owner 会
   形成 split ownership。无论后端拓扑如何，调用端都无法区分“未执行”与“已执行但未确认”。
6. **状态与会话**：接口有状态，以 Session ID 跨连接关联；OC3 可以在新连接继续访问同一 Session，
   DELETE 是硬删除并级联 Message/Part，不能由连接生命周期隐式恢复。
7. **背压与流控**：N/A（调用端与服务端之间没有显式有界队列或反向背压）；但 review fan-out 默认
   并发 3 个独立 session，配置可改变 N。超时不是背压信号，不能据此删除服务端状态。

最小修正后逻辑：OC2 完整收包 → OC3 cleanup；OC2 ambiguous → 保留并记录 orphan → 服务端 Runner
可以安全完成，parent Message 不会在 PartUpdated 前被调用端删除。

TCP 对照已经验证这一后置条件：不 DELETE 的 ambiguous session 最终回到 idle，并持久化 structured
result；相同时序加入 DELETE 则稳定得到 FK。因此 2C 是根因级修复而非仅隐藏错误，但它只修复
ambiguous outcome 分支，不改变完整 response 已含 `UnknownError` 的服务端失败。

### 单元 2D：statement-level 资源/文件系统错误（仅当非 Constraint reason 被实证）

- 先按原始 `database.code/errno/message` 建立同一 Bun/SQLite/VFS、同一 WAL 与事务边界的最小复现；
  `IOERR`、`CORRUPT`、`NOMEM`、`FULL`、`READONLY` 不得因都映射为 Unknown reason 而合并处理；同时
  允许“底层 EIO 在特定 WAL read 路径上表现为 CORRUPT”这一已复现实例，不能只按名称反推底层原因；
- 对 `CORRUPT/IOERR` 先冻结 DB/WAL/SHM 与 SQLite source ID，运行只读 integrity/FK 检查并核对
  filesystem/kernel 日志、所有 connection 与 checkpoint 时间线；若怀疑 WAL-reset race，还必须证明
  实际 SQLite 来源不含 3.44.6、3.50.7 或 3.51.3+ 的修复，且至少两个 connection 并发
  checkpoint/write；
- 记录失败后 transaction state。若 SQLite 已自动结束事务，保证 rollback finalizer 不用
  `cannot rollback - no transaction is active` 覆盖 primary statement cause；若事务仍活跃，显式
  rollback 后再允许 processor 错误收尾；
- 优先修复已证实的环境/资源根因，例如磁盘/quota、WAL 目录权限、filesystem/VFS 故障或内存上限；
  不把不可恢复的 I/O/corruption/readonly 错误伪装为 lock；
- 只有原始 code、SQLite 语义与受控实验共同证明某一 reason 是短暂且整笔 durable event 可安全重试
  时，才为该 reason 单独设计事务级有界 retry。禁止重试整个 provider turn，也禁止把
  `Constraint/CORRUPT/NOTADB` 纳入通用 retry；
- 失败后的 public assistant 继续只返回安全 correlation ref；服务端保留 primary code/message、
  transaction state 与 event/session/message/part correlation，不记录 query params。

该单元已有一个“WAL read EIO → 对外 CORRUPT → 完整 UnknownError response”的受控机制闭包，但仍是
条件计划，不代表已确认现场资源错误。其最小成功标准是：同一原始错误在现场等价 VFS 中可确定复现，
primary cause 不再被 rollback secondary error 掩盖，修复后 durable event 要么完整提交一次，要么完整
失败且不重放 provider/tool 副作用。

### 单元边界

单元 1 已独立实施和验证。Issue 因果修复的选择顺序是：先取得原始 reason 与 caller outcome。完整
assistant response 分支若为 FK，先追踪 Message-only 删除/重建 source，不能直接套用针对整 Session
删除的本地 2B。双 server HTTP 已复现跨进程 active Message 删除；若产品允许该部署形态，先回架构
确认门选择单 DB owner 或 durable session lease，再进入 2B。若产品明确禁止并强制单 writer server，
或现场另证同进程 Session lifecycle 缺陷参与，才按较窄本地契约评估 2B。若为
`CORRUPT/IOERR/NOMEM/FULL` 等资源错误，进入 2D；若
为非常规 Part-statement lock，先为 shared-cache/table/reentrant 前提建立独立最小复现。普通事务起点
BUSY 才进入 2A，但它与 Issue 当前 Part wrapper 冲突，除非新现场证明展示的 query/stage 不完整。
ambiguous + FK 分支才进入 2C；2C 修调用端只能消除 timeout/transport cleanup 触发，不能修复完整
`UnknownError` response 分支。任何分支都不能重试 Constraint 或在 provider/prompt 层重放整个 turn。
Snapshot 若只被确认是延迟放大器，不足以选择 2A/2B/2C/2D，也不得用关闭 Snapshot 代替根因修复。

## 五、正确性论证

- 根因消除：单元 1 保证当前已存在的 SQLite classification 不再在日志边界丢失；2A 只处理已证实
  的事务起点锁失败；2B 在线性化 gate 上消除删除/准入 TOCTOU，若存在共享 DB 的多 server 则其 gate
  必须跨进程或由单 owner 排除 split-brain；2C 在 ambiguous outcome 后不再级联删除活跃 Runner 所依赖
  的 parent Message；2D 只在原始非 Constraint reason 实证后修复具体资源/VFS 根因，并保留可能被
  自动 rollback secondary error 覆盖的 primary cause。
- 证据边界：同步 `/message` 的代码级 happens-before 和真实拓扑 B 共同排除“正确 post-await DELETE
  导致此前首个 Part INSERT 失败”；公开候选调用端的 timeout 会打断客户端等待但不打断 server Runner，TCP
  E/F 与直接 Runner ownership 实验证明它可以形成受控 C 的重叠顺序；但完整 response 已含
  `UnknownError` 时，Part failure 必在 OC3 前发生，且 response 前 `lastAssistant()` 的数据库读取证明
  Session 与最终 Message 存在；整 Session 提前删除复现的 prompt 又明确不是 HTTP 200。因此 2C 与
  整 Session 删除对该次记录均被排除。Issue ID 证明约 39.9 秒前置窗口，但 reviewer 默认 600 秒、
  聚合器等待全部任务、已知 server/runtime 链没有约 40 秒 response deadline，故该窗口当前只表示
  尾延迟，不能独立证明 timeout。窗口按代码顺序包含 initial Snapshot、tools/system 准备、provider
  首个有效 chunk 和可选 Snapshot fallback，不能只用 Part ID 给其中任一阶段分配耗时。
- 错误阶段论证：真实 adapter 对照证明只有 `statement.all()` execution failure 会生成 Issue 所见
  `EffectDrizzleQueryError: Failed query`；prepare/schema failure 直接成为原生 SQLite defect，参数编码
  又发生在 executor 之前。因此后续修复只应针对 execution-time Constraint/LOCKED/资源错误，不能用
  migration、SQL prepare 或 JSON 编码假说设计修复。`SQLITE_FULL` 容量实验还表明典型 Part 容量耗尽
  会因 SQLite 自动回滚而最终暴露 rollback `SqlError`，与 Issue wrapper 不同；官方语义不保证所有
  `FULL/IOERR/NOMEM` 失败点都自动回滚，所以该结果用于降级而不是绝对排除资源分支。NOMEM 对照又把
  “大 binding 参数可产生同形 wrapper”和“Issue 小 payload 在当前 allocator 下先于 execution 失败”分开，
  因而 NOMEM 继续保留但低于 WAL/VFS 分支。VFS fault injection 已进一步证明：WAL `pread64/EIO` 可在
  Bun 上表现为 `SQLITE_CORRUPT`，adapter rollback 后仍保留 primary wrapper；精确三次 read fault 又能
  让完整 server 返回 HTTP 200 `UnknownError`、assistant Message=1、assistant Part=0。该闭包消除了“CORRUPT 必然持续、
  cleanup 不可能成功”的旧反证，但只证明机制可行，不能替代现场 code/filesystem 证据。
- parent Message 论证：MessageUpdated projector 在 durable publish 返回前原子提交；Part 参数合法且
  历史/当前 schema 的唯一现实约束均指向 Message。Part transaction 的成功 `BEGIN IMMEDIATE` 又阻止
  其他 writer 在 INSERT 前插队，因此若诊断为 FK，Message 必在 Message commit 之后、Part BEGIN 之前
  被删除。完整 response 进一步要求 Session 在 cleanup/`lastAssistant()` 时存在，所以默认删除源必须是
  Message-only。第二连接删除已复现 FK、HTTP 200、cleanup 重建 Message 的完整闭包；与此同时
  `v1.17.8`/当前 HTTP deleteMessage 与 revert 在 owner server 的 session directory 实例内均以 busy
  guard 拒绝活跃删除，但 guard 只读取进程内 Runner map。共享 DB 的双 server HTTP 诊断已确认非 owner
  `deleteMessage` 能闭合 FK/HTTP 200 指纹；现场归因仍须证明第二 PID/路由或其他删除 source。若现场
  严格只有一个 server，标准 source 才继续收敛为 replay/外部 writer/未记录版本。timeout 后的 OC3 只在
  ambiguous outcome 分支中是首要整 Session 删除源。
- 不变量保持：durable event 的 projector、sequence 和 append 继续原子提交；Part 必须有 parent
  Message；Deleted 后禁止新 writer；同一 provider/tool turn 不被数据库恢复策略重放。
- 无回归引入：诊断字段不含 query params；Constraint 不重试；锁重试有次数/时间上限；不同 session
  的成功路径不改变；2C 的完整响应 cleanup 保持现状，ambiguous 分支只延迟回收临时 session。
- 并发正确性：2A 只在完整事务边界重试并复用 event identity；2B 必须让 prompt admission 与
  `Alive → Deleting` 原子互斥，并在 Deleted 前清空全部 writer lease。单独 busy check/cancel 不能证明
  该不变量，因为仍存在 check-then-act 窗口。现有单连接 transaction semaphore 已把同进程
  Message/Part/Delete durable writes 排成全序；同 worktree Snapshot semaphore 则是 LLM stream 前的
  另一条共享顺序边界，但不写数据库。它只能在 deadline 已证实时作为延迟放大器，不能作为 SQL 根因。
  默认数据库路径却跨进程共享，而 Runner map 不共享；若允许多 server，2B 的线性化点必须是跨进程
  owner/lease 或进程级 DB 独占，不能继续依赖本地 `assertNotBusy()`。
- 跨进程顺序正确性：2C 只把完整 response body 当作远端 settle 证明；对 timeout/transport ambiguity
  不假设跨连接 FIFO 或远端取消。于是调用端不再在缺少 happens-before 证据时发出破坏性 cleanup。
  TCP 对照满足必要性分离：abort-only 能完整结束，abort + DELETE 才产生 FK。公开候选 caller 的每个
  reviewer 使用局部 `sid`、独立 Hyper request future，仓库内也只有 `agent_cli.rs` 发 OpenCode session
  DELETE，因此标准三路 fan-out 不会交叉清理彼此 session。
- Trivial 判定：不适用。本缺陷跨 durable transaction、projector、error cause 和 session lifecycle，
  且错误修复可能重复外部副作用。
- provenance：实际部署 commit/version 尚未记录；公开候选调用端材料引用的 `v1.17.8`、`d12b1e924d` 和
  分析
  基线均有 initial Snapshot、单连接 semaphore、`BEGIN IMMEDIATE` 与相同 Part FK。`v1.17.8` 的
  packageManager、publish setup action 与 compile build 都固定 Bun 1.3.14；本机同一官方 Bun 测得
  SQLite 3.53.0，已越过 WAL-reset fix 版本，固定调度的 250 轮跨进程启动 checkpoint 也未产生 Part
  failure。但这不是 Issue 现场 binary 的直接测量；现场归因仍须记录 binary SHA、
  `sqlite_version()`/`sqlite_source_id()`、DB inode 与所有打开它的 PID，避免漏掉未纳入比较的自定义
  binary 或另一个共享 DB 的 process。

## 六、测试用例清单

| 类型            | 用例描述                                                                                                 | 状态（修复后回填）                                                        |
| --------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 现状基线        | 真实 TCP/Git/WAL 下 3 个独立 structured-output prompt；无清理及返回后清理                                | 已固化；3 轮共 18 个 prompt 通过                                          |
| 机制复现        | Message 已提交、Part 未写入时删除 session，再释放 provider                                               | 已固化；3/3 为 FK Constraint，prompt 非 HTTP 200                          |
| 传输对照        | Message 已提交、assistant Part=0 时 abort waiter；不 DELETE 后释放 provider                              | 临时诊断 3/3 structured 完整，无 FK                                       |
| 传输机制        | 相同 abort 时序；新连接 DELETE 返回 200 后释放 provider                                                  | 临时诊断 3/3 为 FK Constraint                                             |
| 回归            | 嵌套 Drizzle/Effect/SqlError 的投影保留 reason、code、errno、retryable                                   | 已通过（单元 1）                                                          |
| 新增            | 缺失 parent Message 时写入 Part，稳定得到 foreign-key Constraint 诊断                                    | 已通过（单元 1）                                                          |
| 新增            | 第二 SQLite 连接持写锁，稳定得到 LockTimeout 诊断                                                        | 已通过（单元 1）                                                          |
| 语义实验        | 双连接验证 BEGIN 后 DELETE=BUSY、DELETE 先提交=FK、WAL reader 不阻塞 writer                              | 已完成（临时诊断，无仓库改动）                                            |
| 阶段实验        | 真实 adapter 对照 prepare failure 与 statement execution failure 的外层错误形态                          | 已完成；Issue wrapper 只对应 execution                                    |
| 资源实验        | parent 已提交、BEGIN 成功后以 `max_page_count` 强制 Part INSERT `SQLITE_FULL`                            | 已完成；自动回滚后暴露 rollback SqlError，外形不同                        |
| 权限实验        | query-only 分别在 BEGIN 前/后启用，区分事务起点与 Part-statement READONLY                                | 已完成；前者失败于 BEGIN，后者才打印 Part SQL                             |
| schema 审计     | `v1.17.8` 生成 schema、初始 migration、当前定义及后续 migration                                          | 已完成；无隐藏 CHECK/trigger/UNIQUE/session FK                            |
| 所有权实验      | interrupt `ensureRunning()` waiter 后 instance-scoped Runner 仍继续完成                                  | 已完成；busy→completed/idle                                               |
| timeout 审计    | reviewer/OpenCode/Bun/Hyper 已知 deadline 与 39.9 秒窗口对照                                             | 已完成；公开链无约 40 秒 response timeout                                 |
| caller 审计     | 公开候选三 task 的局部 sid、独立 Hyper future、OpenCode DELETE 全调用面                                  | 已完成；候选内无 session 串线或第二 cleanup actor                         |
| 删除面审计      | Session/Message/workspace/ACP/replay 全生产入口及新建 `fsm-gate` 的 workspace/revert 状态                | 单 server 公共图无自动 Message-only actor；跨 server deleteMessage 已闭包 |
| active 删除     | assistant 已提交、assistant Part=0 时调用 HTTP deleteMessage；核对 `v1.17.8` 与当前 guard                | 已完成；同进程/directory HTTP 409，两个版本均有 guard                     |
| Message 闭包    | 第二 SQLite connection 只删 assistant Message 后释放 provider；核对 response 与最终 DB                   | 临时诊断通过；FK + HTTP 200 UnknownError，Message 被重建                  |
| WAL read 注入   | BEGIN 后小型 INSERT cache miss；目标 WAL `pread64` 返回 EIO；核对 wrapper、code 与 rollback              | 临时诊断通过；同形 wrapper，向上表现为 SQLITE_CORRUPT                     |
| WAL HTTP 闭包   | probe Part 强制 cache miss；provider gate 后 2/3/4 次 EIO 对照响应与 cleanup                             | 临时诊断通过；仅 3 次闭合 HTTP 200/assistant Message=1/assistant Part=0   |
| WAL race 审计   | 官方 WAL-reset 前提/修复版本与 Bun SQLite source ID、正式构建 connection 图对照                          | 当前不匹配；未修复 binary + 多连接时重新开放                              |
| 启动 checkpoint | A 持有 BEGIN；B 进程打开同一 DB 并运行 WAL/PASSIVE checkpoint；A 再写 Part-like row，重复 250 轮         | 临时诊断通过；250/250 写入成功，integrity/FK 正常                         |
| 跨进程 guard    | 核对默认 DB identity、process/directory-local Runner map 与 session 路由                                 | 静态审计确认同进程路由固定 directory，但 guard 不跨进程                   |
| 双 server 闭包  | A 运行 prompt、B 共享 DB；assistant Message=1/assistant Part=0 时由 B HTTP deleteMessage 后释放 provider | 临时诊断通过；B 200，A FK + 同 ID UnknownError，assistant Part=0          |
| 调度审计        | normal acquirer release 与等待 transaction 的 FIFO 竞争；Effect beta.74/beta.83 各 20,000 次             | 已完成；两组 `borrowed=0`                                                 |
| ID 审计         | caller-supplied message/part ID、生成器 counter/随机后缀与三 reviewer 共享状态                           | 已完成；caller 未传 ID，自然碰撞不足以解释                                |
| 响应指纹        | processor cleanup 后由数据库 `lastAssistant()` 返回；整 Session overlap 的 HTTP outcome                  | 已完成；Issue 完整 assistant 与整 Session 提前删除不兼容                  |
| 边界            | 服务端诊断与客户端 error 不包含 query params/用户 prompt                                                 | 已通过（单元 1）                                                          |
| 现场取证        | 按 asc/desc 与 48-bit 时间环解码 Issue ID，并与 SQL `time_created` 对齐                                  | 已完成；Message ID generation→Part SQL 约 39.931s                         |
| 配置取证        | 记录实际 OpenCode/caller SHA、Bun/SQLite source ID、endpoint→PID、DB inode、有效 timeout 与 Snapshot     | 公开/本机路径已审计；Issue 环境待跑                                       |
| 现场诊断        | 原始 caller 按 sid 记录 OC1/OC2 HTTP status/body/outcome/elapsed 与 OC3 start/outcome                    | 待跑（Issue 环境）                                                        |
| 现场时序        | 记录 initial/fallback Snapshot、tools ready、provider first chunk、Part wait/BEGIN/upsert                | 待跑（Issue 环境）                                                        |
| 删除归因        | 每个 Session/Message 删除记录 source 与 request/admission/BEGIN/commit，区分删除粒度                     | 待跑（Issue 环境）                                                        |
| 现场快照        | 首次失败整体保留 DB/WAL/SHM；检查行/FK/integrity、PRAGMA、PID/connection/checkpoint 与 FS 日志           | 待跑（Issue 环境）                                                        |
| 单变量          | 原始 harness 设置 `snapshot: false`，比较三路 Message→Part 尾延迟与失败率                                | 待跑；仅判断延迟放大，不证明根因                                          |
| 单变量          | 保留 Snapshot，但 ambiguous outcome 不 DELETE，保留 Session 与数据库现场                                 | 待跑；与 TCP E/F 联合判定                                                 |
| 现场边界        | OC2 完整 assistant response 否定 timeout-cleanup 与整 Session 提前删除路径                               | Issue/代码/受控响应支持；原始 HTTP 记录待核对                             |
| 公开取证        | 检索 caller Actions、workflow、Issue comment/artifact                                                    | 已完成；无 8 月 1 日公开运行或现场附件                                    |
| 条件回归        | BEGIN LockTimeout 时只重试 durable transaction，成功后 event/projector 各一条                            | 待定（仅 2A）                                                             |
| 条件边界        | Constraint、未知错误和超过重试上限时不重试                                                               | 待定（仅 2A）                                                             |
| 条件机制        | 只删 assistant Message、保留 Session，再释放 provider；验证 FK 后 cleanup 可重建 UnknownError Message    | 临时诊断已通过；正式回归待 2B 架构确认门                                  |
| NOMEM 阶段      | hard-heap-limit 下大参数与 Issue 小型 payload；扫描 prepare/execution/rollback 外形                      | 已完成；大参数可同形，小 payload 裸 defect 或成功                         |
| 条件资源        | 原始 `CORRUPT/IOERR/NOMEM/FULL/READONLY` 最小复现；区分 statement rollback 与 auto-rollback              | WAL read EIO→CORRUPT 已临时复现；现场 reason 仍待定                       |
| 条件诊断        | transaction 已自动回滚时保留 primary Part cause，不被 secondary ROLLBACK error 覆盖                      | 待定（仅 2D）                                                             |
| 条件边界        | 2D 不重试 Constraint/CORRUPT/NOTADB，不重放 provider/tool turn                                           | 待定（仅 2D）                                                             |
| 条件回归        | prompt 写入与 session remove 用 latch 确定性交叉，删除不会造成迟到 Part                                  | 待定（仅 2B）                                                             |
| 条件边界        | 删除 busy session 的 HTTP 行为与选择的拒绝/取消契约一致                                                  | 待定（仅 2B）                                                             |
| 条件竞态        | DELETE 检查/标记期间并发新 prompt admission，不会穿过 `Deleting` gate                                    | 待定（仅 2B）                                                             |
| 条件尾部        | title/summary/prune writer 在 Deleted 前退出，之后不再产生 durable write                                 | 待定（仅 2B）                                                             |
| 条件回归        | assistant Message commit 后 OC2 timeout；caller 跳过 DELETE，无 FK 且保留 session                        | 待定（仅 2C，外部 caller）                                                |
| 条件边界        | request/body transport ambiguity 同样跳过 DELETE                                                         | 待定（仅 2C，外部 caller）                                                |
| 条件正常        | OC2 完整收取 response body 后仍执行临时 session cleanup                                                  | 待定（仅 2C，外部 caller）                                                |
| 条件并发        | 默认 3 reviewer 并发，其中一条 timeout；仅 ambiguous session 被保留                                      | 待定（仅 2C，外部 caller）                                                |

## 七、代码更新清单

| 文件                                                                           | 函数 / 行号                | 改动概述                                                               | 状态（修复后回填）  |
| ------------------------------------------------------------------------------ | -------------------------- | ---------------------------------------------------------------------- | ------------------- |
| `packages/core/src/database/sql-error.ts`                                      | `extract()`                | 从嵌套 cause 提取安全结构化 SQLite 诊断                                | 已新增（单元 1）    |
| `packages/opencode/src/session/processor.ts`                                   | `parse()` / `halt()`       | 记录 reason/code 与 session/message correlation；不记录 SQL params     | 已修改（单元 1）    |
| `packages/opencode/src/session/message-v2.ts`                                  | `fromError()`              | 数据库失败返回安全 UnknownError 与 correlation ref                     | 已修改（单元 1）    |
| `packages/core/test/database-sql-error.test.ts`                                | SQL 诊断测试               | 真实 Constraint 与 LockTimeout 分类                                    | 已新增（单元 1）    |
| `packages/opencode/test/session/message-v2.test.ts`                            | error 投影测试             | 验证嵌套 cause、客户端 ref 与敏感参数隔离                              | 已修改（单元 1）    |
| `packages/opencode/test/cli/serve/session-part-concurrency-diagnostic.test.ts` | 真实拓扑诊断               | 固化 A/B 正常路径及 C 生命周期 FK 机制                                 | 已新增（诊断）      |
| `packages/opencode/test/lib/cli-process.ts`                                    | `ServeHandle.stderr()`     | 向诊断测试暴露当前子进程 stderr 快照                                   | 已修改（测试支持）  |
| `packages/opencode/src/snapshot/index.ts`                                      | `track()` lock 边界        | 区分 initial/fallback 的 wait/acquired/end，不改变 Snapshot 行为       | 待定（诊断确认门）  |
| `packages/opencode/src/session/processor.ts`                                   | create/process/step-start  | 记录 tools ready、provider first chunk 与 Snapshot phase               | 待定（诊断确认门）  |
| `packages/core/src/event.ts`                                                   | `commitDurableEvent()`     | 记录 event transaction wait/BEGIN success；不改变提交行为              | 待定（诊断确认门）  |
| Session/Message 删除入口与原始 harness                                         | lifecycle/source 日志      | 记录删除粒度/source、前后行存在性、HTTP outcome、tx 时序与实际版本     | 待定（诊断确认门）  |
| `packages/core/src/event.ts`                                                   | `commitDurableEvent()`     | 仅在 BEGIN LockTimeout 实证后增加事务级有界重试                        | 待定（仅 2A）       |
| `packages/opencode/src/session/run-state.ts` 或窄用途 lifecycle coordinator    | prompt/delete admission    | 原子维护 Alive/Deleting/Deleted 与 writer lease                        | 待定（仅 2B）       |
| `packages/opencode/src/session/session.ts`、session HTTP handler               | `remove()` 及删除入口      | 按选定的拒绝或 cancel-and-join 契约完成删除                            | 待定（仅 2B）       |
| `packages/core/src/database/database.ts` 或跨进程 session ownership 模块       | DB/server owner 或 lease   | 若支持共享 DB 多 server，实施 DB 独占 owner 或 durable session lease   | 待定（仅跨进程 2B） |
| title/summary/prune/background writer                                          | writer 生命周期            | 纳入同一 lease/join/cancel 边界                                        | 待定（仅 2B）       |
| 外部候选 `mcp-server-fsm/crates/server/src/agent_cli.rs`                       | `judge_opencode()`         | 区分 settled/ambiguous；ambiguous 时不立即 DELETE                      | 待定（仅 2C）       |
| 外部候选 `mcp-server-fsm` 对应 Rust tests                                      | OpenCode cleanup 契约      | 覆盖 timeout/transport/full-response/3-reviewer 时序                   | 待定（仅 2C）       |
| `packages/core/src/database/sqlite.bun.ts` / transaction boundary              | primary-cause preservation | auto-rollback 后不让 secondary ROLLBACK 覆盖原始 statement cause       | 待定（仅 2D）       |
| 资源/VFS 根因对应配置或部署代码                                                | 待现场 code 收窄           | 按 DB/WAL/SHM、SQLite source ID 与 FS 证据修复具体根因，不做通用 retry | 待定（仅 2D）       |

单元 2 的具体文件清单将在 Issue 原始 reason 与删除契约确定后收窄，避免把受控机制直接等同于
Issue 根因。

## 八、文档更新清单

| 文档路径                                                   | 要改什么                                                      | 状态（修复后回填）  |
| ---------------------------------------------------------- | ------------------------------------------------------------- | ------------------- |
| `docs/fixes/session-fix-part-projection-sqlite-failure.md` | 记录分析、复现矩阵、证据边界和条件修复计划                    | 已提交 `d71c0193b0` |
| 同一修复计划                                               | 回填诊断单元、真实拓扑 A/B/C 与证据边界                       | 已提交 `d71c0193b0` |
| 同一修复计划                                               | 同步 happens-before、锁反证、后台边界及删除 TOCTOU            | 已提交 `6a12337e4a` |
| 同一修复计划                                               | 同步 caller、TCP E/F、ID 时间线、Snapshot 与单元 2C           | 已提交 `9050ddfa07` |
| 同一修复计划                                               | 修正 Snapshot 前置时序并反证普通 WAL Part-statement BUSY      | 已提交 `b95397f5c0` |
| 同一修复计划                                               | 同步 execution 阶段边界、Runner ownership、公开取证与候选排序 | 已提交 `b95397f5c0` |
| 同一修复计划                                               | 同步 timeout 链、caller sid/DELETE 审计、FULL 实验与候选降级  | 已提交 `da83df9d64` |
| 同一修复计划                                               | 同步响应指纹、历史 schema、删除面审计、错误矩阵与单元 2D      | 已提交 `cde069ed4e` |
| 同一修复计划                                               | 同步 Message-only 完整闭包、busy guard、ID/调度与 NOMEM 边界  | 已提交 `e3c06a202a` |
| 同一修复计划                                               | 同步 WAL read EIO/CORRUPT 完整闭包与 WAL-reset 版本边界       | 已提交 `ca94f97343` |
| 同一修复计划                                               | 同步多进程 checkpoint、process/directory-local guard 边界     | 已同步（本提交）    |
| 同一修复计划                                               | 全文证据审计、公开 caller 限定、双 server HTTP 闭包与版本修正 | 已同步（本提交）    |
| 同一修复计划                                               | 回填 Issue 环境原始 reason、选定的 2A/2B/2C/2D 与提交         | 待更新              |

本轮只同步分析与候选契约，不修改公开 API/schema。若单元 2B 选择改变删除 endpoint 的 busy 行为，
实施前必须补充服务端接口契约和测试；若确认单元 2C，则必须在外部调用端同步 settled/ambiguous、
timeout 与 cleanup 契约及对应 Rust 测试；若确认单元 2D，则必须按具体 SQLite code 同步部署/资源契约与
primary-cause 保真测试。所有分支都需再次经过确认门。
