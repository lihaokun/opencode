# 开发日志 — 2026-10-28 session runner 收尾竞态双循环（issue #85）

## 做了什么

修复 `SessionRunState` 与 `Runner` 的收尾竞态：一个 run 结束、另一个写入方已排队时，旧代码把 idle 转换放在 `Runner` 临界区之外执行（`SessionRunState.onIdle` 删 map + 发 idle 状态），排队者在"已转换 Idle"与"onIdle 执行完"之间起跑——在一个服务已不认识的 runner 上运行（孤儿），下一条消息新建第二个 runner，同一会话两条循环互相把对方当"没说完"，反复输出占位回复（10-08 与 10-27 两次事故，9-52 条重叠 assistant 消息）。

四处改动：

1. `run-state.ts`：不再删 map（One Runner per session，进程生命周期）；钩子必须"按 sessionID 参数化、执行时现读持久化状态"作为复用不变量写入注释。
2. `runner.ts`：`finishRun` 的 `yield* idle` 移入 `SynchronizedRef.modifyEffect` 的 pf 体内——**关键实现细节**：`modifyEffect` 返回的 action 在信号量释放之后才执行（`Effect.flatten` 在 `withPermit` 之外），写进返回的 action 等于没修；第一版就写错，被自己新加的 runner 级 RED 用例当场抓住。
3. `message-v2.ts` + `prompt.ts`：re-arm 谓词从整表加载（22k 消息数秒，#62）换成单行索引查询 `MessageV2.latestRole`（"最新消息是不是 user"，与 `compareChronology` 的 `(time_created, id)` 全序逐点等价），临界区锁持有时间降到毫秒级；加了 2000 消息规模下 <500ms 的成本上界用例。
4. `prompt.ts` runLoop：第二道防线——本循环已产出 assistant 后，若最新 assistant"无 finish ∧ 属最新 turn ∧ 非本循环所创"则 break 不发请求。`step > 0` 豁免首迭代（shell 留下的无 finish assistant 由后续 loop 合法接管，被"shell completion resumes queued loop callers"用例抓住过误杀）。

## 关键决策

- **不删 runner 而非"删+锁后重取"**：后者要把 map 查找塞进 Runner 信号量（依赖倒置）；不删的代价只是每会话一个小对象。
- **测试锚点换了三次**：先锚 status 读数（"运行中不得读 idle"）——实测不可靠：status.get 的 idle 既是"被删"也是"从未 set"的默认值，且预修复的越带 idle 实际落在 run 收尾附近；再锚 idle 事件计数——事件投递时序在测试 harness 里漂移；最终 run-state 层锚 **join 语义**（第三个 caller 的返回值 + executions 计数，对"第二个 runner 出现"敏感），runner 层锚 **onIdle 完成先于排队者 work 启动** 的顺序断言。两级都修复前 RED / 修复后 GREEN。
- **成本上界用例规模**：2000 条而非 issue 里的 2 万——单测要快，且 2000 已足以让"整表加载"超时、让"单行查询"毫秒级，判别力相同。

## 踩过的坑

- `SynchronizedRef.modifyEffect` 的语义陷阱（见上）——返回值里的 effect 不是临界区的一部分。
- `Effect.gen` 惰性求值：作为 work 传入的 gen body 每次 run 都重新执行，`let watching` 翻转后重启的 work 能看到新值——测试靠这个驱动 re-arm 路径，但也要注意闭包捕获的是"执行时"的变量。
- `Fiber.await` 返回的是 Exit 作为值（`joinExit.value` 而非 `joinExit`）。
- stash 验证 RED 时 `git stash push -- <path>` 的 pathspec 解析受 cwd 影响（在 package 子目录里用相对路径才对）；且 bun 测试有随机调度成分，单次绿/红不能定论，关键判定都跑了多轮。
- 会话级"两条循环"在测试 harness 里难以确定性复现完整的"孤儿→第二个 runner→并发"链（delete 的落地时机依赖调度细节）；确定性 RED 拆到了 runner 层（顺序断言），run-state 层用对第二个 runner 敏感的 join 判据兜底。

## 端到端验证

- `test:httpapi` 三段门禁全绿：coverage 209/0、auth 209/0、effect 209/0（effect 段在共享机需 >590s，单独复跑完成）。
- 大会话查询基准（一次性脚本 `script/validate-rearm-large-session.ts`，真 SQLite，20k 消息实写；实测对象是新旧谓词查询本身，非 full-loop）：旧谓词整表加载 **1342ms** vs 新谓词 `latestRole` **2.0ms**（~670×），与事故画像（秒级锁持有）吻合。脚本未纳入常规套件（fill 20k 需 19s，不适合单测）。

## 度量

| 指标           | 数值                   |
| -------------- | ---------------------- |
| 新增代码行数   | ~90（src：runner +3 / run-state +7 / message-v2 +21 / prompt +31 含守卫与注释） |
| 修改代码行数   | ~15                    |
| 删除代码行数   | ~12                    |
| 涉及文件数     | 4 src + 3 test + 3 docs |
| 新增测试用例数 | 8（runner 1 / run-state 2 / latestRole 5） |
| 测试通过率     | 定向套件全绿（runner 31 + run-state 2 + message-v2 45 + pagination 60 + prompt 98/99 skip1）；全套件见验证记录 |
| 发现 bug 数    | 2（idle 写在 action 里等于没修；守卫首迭代误杀 shell assistant） |
| 修复 bug 数    | 2                      |
| 迭代轮次       | 设计 1 / 实现 1 / 测试锚点 3 / 修复 2 |

## review 轮（2026-10-29，PR #89 review 后）

reviewer 提出三项 + 我们自查补两项，全部确认属实并修复（commit `ae462ca435`）：

1. **idle hook defect 卡死 runner**（review #1，P2）：`yield* idle` 移入 `modifyEffect` pf 体内后，未隔离的 defect 会让整个修改不提交——ref 停留 Running、Deferred 永不完成、后续调用全部 join 死 run。基座下同场景仅首个 caller 挂（状态已提交可恢复），PR head 下全挂，是比基座更差的失败放大。修：`safeIdle`（`catchCause → logError`）+ `shouldReArm` fail-closed 隔离。
2. **run-state idle 顺序用例空转**（review #2，P2）：原用例一次 `ensureRunning`、无排队者、`watching` 未读、断言的 `"idle"` 是新 session 默认值——修复前后皆绿。重写为"写入方置 busy 并存活过 idle 转换"的契约守卫 + 新增 re-arm 无中间 idle 契约用例；文档同步更正。
3. **finishShell / idleIfCurrent 同型锁外 idle**（review 补充 + 自查）：两处遗留的返回-action 锁外 idle 一并移入临界区（`idleIfCurrent` 仅在状态仍 Idle 时补发，不覆盖新 run 的 busy）。

### review 轮踩过的坑

- **会话级 status 断言对"post-lock onIdle vs 排队者续跑"的交错不敏感**：pre-fix 下 post-lock onIdle 的续跑先于排队者 acquire 完成（探针实测 `work2-start, busy-set, read=busy`——busy 后到覆盖 stale idle），所以重写后的 run-state 顺序用例在 pre-fix 也绿。确定性 RED 只能锚在 runner 层（顺序断言）。cancel 用例还有一个时序前提：cancel 与下次调用**顺序**执行不 RED（post-lock action 天然先完成），必须 cancel 临界区在途时并发排队。
- **`it.instance` 的裸 `bun test` 5s 默认超时**：`bunfig.toml` 注释明确说 timeout 不从 bunfig 解析，必须靠 package script 的 `--timeout 30000`。2000 行 fill + 查询的用例在裸 `bun test` 下必超时（共享机负载 >5s），CI 路径（`bun run test`）稳定绿——排查时先看调用方式再怀疑代码。
- **"失败隔离"是"入临界区"的伴随义务**：把副作用搬进临界区必须同时回答"副作用 defect 怎么办"——不提交状态比迟到副作用更糟。`EventV2.notify` 对非 durable 事件不隔离 listener，插件 hook 同步 throw 可达，防御纵深必要。
