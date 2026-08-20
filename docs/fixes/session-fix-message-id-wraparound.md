# 修正方案 — V1 Session 消息 ID 回卷与持久化顺序

- 状态：原始 rollover 根因修复已完成（实现 commit `6784e5ad92`、文档 commit `57dab0571a`）；2026-08-20 PR review 发现“持久化 revert boundary 被单独删除后，cleanup 静默保留 reverted suffix”的回归，follow-up 代码、回归、generated legacy SDK 与本地验证已完成，当前 worktree 待提交
- 日期：2026-08-17；PR review follow-up：2026-08-20
- 对应问题：[#13](https://github.com/lihaokun/opencode/issues/13)
- 计划交付：在基于 [PR #14](https://github.com/lihaokun/opencode/pull/14) 的 `message-id-wraparound` stacked branch 中独立实施，不扩大 PR #14 本身的 context-overflow 修复范围
- 影响模块：legacy V1 Identifier consumer、Session message/part chronology、prompt loop、revert marker hydration/cleanup、legacy App/TUI revert consumer、fork、CLI local replay、legacy tool-output retention
- workflow 路径：`docs/workflow.md` §7 bug-fix flow + §7.1 八部分修正方案
- 修复分类：原始修复为算法内部逻辑错误；PR review follow-up 仍是 boundary 算法回归，但为让 legacy App/TUI 使用同一 durable boundary，会给 legacy `Session.Info.revert` 和 V1 event schema 增加向后兼容的可选 chronology 字段。该窄接口修订会扩展 legacy Server `HttpApi` 的 Session response 并触发 generated client/SDK 同步；不修改数据库 schema、current Protocol、current/V2 `Revert.State` 或 V2 Session Core

本修复建立一个明确边界：V1 的 message/part ID 是身份键，不是永久时钟。需要 chronology 的 consumer 使用持久化创建时间和稳定 tie-breaker；ID equality 继续用于 identity/reference，但持久化 revert marker 必须同时携带 chronology key，不能要求被引用实体永远存在。V2 已通过 durable sequence 从结构上消除了同类依赖，本修复不修改或桥接 V2。

---

## 第一部分：现象与复现

### 1.1 可见现象、触发条件、影响范围与频次

`Identifier.create()` 把毫秒时间左移 12 位后只写入六字节。可编码的毫秒时间因此只有 36 位：

```text
encoded = (timestamp_ms * 2^12 + counter) mod 2^48
timestamp_component = timestamp_ms mod 2^36
period = 2^36 ms = 795.3643140740741 days
```

本轮实际回卷边界为：

```text
UTC:       2026-08-14T11:19:55.136Z
Asia/HK:   2026-08-14 19:19:55.136
next wrap: 2028-10-17T20:04:31.872Z
```

Issue #13 的生产会话在该边界前创建了 `msg_ffff...` user，边界后创建了 `msg_0000...` / `msg_001d...` user 与 assistant。`MessageV2.latest()` 继续按 raw ID max 选择回卷前 user/assistant，因而看不到 chronology 上真正最新的 `finish: "stop"` assistant；prompt loop 自身又用原始字符串判断：

```ts
lastUser.id < lastAssistant.id
```

即使 post-wrap assistant 被选中，该表达式也会在跨 wrap 时为 `false`。生产 run 的实际 step 1004 则更早失效：raw max 仍指向回卷前 `finish: "tool-calls"` assistant，完全遮住已经停止的 post-wrap assistant，所以 active run 继续发起 provider turn。生产观测中，同一 active run 从 step 1003 直接进入 step 1004；模型等待后台任务期间重复执行 `git status --porcelain`，约 79 分钟内出现约 300 次无用轮询。后续 compaction 恰好过滤掉回卷前消息后，会话表面恢复，但 ID 排序缺陷仍然存在。

触发频次与边界：

- ID 字符串反序：每个 `2^36 ms` 边界确定发生；
- prompt busy loop：一个 active V1 Session 同时包含边界前最新 user 和边界后完成 assistant 时确定发生；
- `latest()` / task selection：active history 同时跨边界且候选角色或 task 分布命中 raw-ID max/range 时确定发生；
- revert/fork：边界参数与被扫描消息分处回卷两侧时确定选择错误范围；
- part 顺序：同一 message 的 parts 跨边界创建时可能反序；
- legacy tool-output cleanup：回卷后、retention cutoff 仍位于回卷前的七天窗口内，新文件确定会被错误判旧；
- CLI local replay：只有 explicit anchor 缺失且需要 raw message-ID fallback 时触发，属于低频显示顺序风险。

影响范围限于仍把时间编码 ID 当 chronology 的 V1/internal consumer。ID 的随机后缀仍使主键碰撞概率极低；本问题不是主键重复，也不涉及 V2 Session runner 的消息顺序。

### 1.2 生产 run DB 与 event-sequence 对照

对 `/home/haokun/.local/share/opencode/opencode-dev.db` 做只读查询，并把 run `e0974639`、Session `ses_000044702ffem2cR85yeLnE96t` 的 durable events 精确重放到 stopped assistant 最后一次更新（event seq `14744`）。未读取或输出提示词正文。

step 1003 创建的目标 assistant：

```text
id:          msg_001d98061001rz5nolPWwSUGML
time_created: 1786737426529
finish:      stop
parentID:    msg_ffffbb90d001u5BhDeo2cWQjQi
```

同一历史在两种 chronology 下得到：

```text
旧 raw-ID latest:
  user:      msg_ffffbb90d001...  created=1786706114829
  assistant: msg_fffff0c46001...  created=1786706332742  finish=tool-calls

persisted (time_created,id) latest:
  user:      msg_00166859d001...  created=1786729891229
  assistant: msg_001d98061001...  created=1786737426529  finish=stop
```

因此旧 loop 在 step 1004 看到的是早已过期的 pre-wrap tool-call assistant，并继续执行；canonical chronology 能直接选择真正最新的 stopped assistant，并判定它产生在最新 user 之后。

该对照还证明不能用 `parentID` 作为本事故的 terminal recovery predicate：target assistant 的 parent 仍是 pre-wrap user，因为它创建时旧 `latest()` 已经选错 user。`parentID` mismatch 是 rollover 根因造成的派生脏数据，不是古老 schema 兼容问题。

### 1.3 可直接运行的最小复现

从 `packages/opencode` 目录执行。该复现使用真实 `Identifier.create()` 和真实 `MessageV2.latest()`，不复制生产 comparator：

```bash
cd packages/opencode
bun run - <<'TS'
import { Identifier } from "./src/id/id"
import { MessageV2 } from "./src/session/message-v2"

const before = 2 ** 36 - 1
const after = 2 ** 36 + 1
const userID = Identifier.create("msg", "ascending", before)
const assistantID = Identifier.create("msg", "ascending", after)
if (userID < assistantID) throw new Error("expected raw ID order to wrap")

const sessionID = "ses_wrap"
const user = {
  info: {
    id: userID,
    sessionID,
    role: "user",
    time: { created: before },
    agent: "build",
    model: { providerID: "test", modelID: "test" },
  },
  parts: [],
}
const assistant = {
  info: {
    id: assistantID,
    sessionID,
    role: "assistant",
    time: { created: after },
    parentID: userID,
    modelID: "test",
    providerID: "test",
    mode: "build",
    agent: "build",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: "stop",
  },
  parts: [],
}
const latest = MessageV2.latest([user, assistant] as never)
if (!latest.user || !latest.assistant) throw new Error("missing latest messages")
if (latest.user.id < latest.assistant.id) throw new Error("expected prompt exit predicate to fail")
console.log({ userID, assistantID, promptWouldExit: latest.user.id < latest.assistant.id })
TS
```

当前基线输出形态：

```text
{
  userID: "msg_fffffffff001...",
  assistantID: "msg_000000001001...",
  promptWouldExit: false,
}
```

同根的 legacy tool-output retention 可用以下命令直接验证：

```bash
cd packages/opencode
bun -e 'import { Identifier } from "./src/id/id"; const retention=7*86400000; const current=Identifier.create("tool","ascending",Date.now()); const cutoff=Identifier.timestamp(Identifier.create("tool","ascending",Date.now()-retention)); console.log({decodedCurrent:Identifier.timestamp(current),cutoff,wouldDelete:Identifier.timestamp(current)<cutoff})'
```

在 2026-08-14 回卷后的七天窗口内，当前输出为 `wouldDelete: true`。现有 truncation cleanup 测试仍会通过，因为它把“recent”fixture 设为三天前；本次执行时三天前也在回卷前，没有覆盖“cutoff 回卷前、文件回卷后”的交叉组合。

### 1.4 出错代码路径

以下行号以当前 `session-overflow` 工作树为准，后续格式化可能轻微移动。

#### 主事故：完成 assistant 未终止 active run

```text
packages/opencode/src/id/id.ts:51-69 Identifier.create
  → timestamp * 0x1000 + counter
  → packages/opencode/src/id/id.ts:64-67 仅写六字节
  → msg_ffff... 在边界后回卷为 msg_0000...

packages/core/src/session/projector.ts:263-274 legacy MessageUpdated projection
  → MessageTable 持久化 id 与 time_created

packages/opencode/src/session/message-v2.ts:425-466 page
  → DB 已按 (time_created, id) 分页

packages/opencode/src/session/message-v2.ts:585-600 latest
  → filterCompacted 后重新用 raw id max 选 user/assistant/finished/tasks

packages/opencode/src/session/prompt.ts:1092-1127 SessionPrompt.runLoop
  → lastUser.id < lastAssistant.id 为 false
  → 不进入 assistant error/finish 终止分支
  → step++，继续真实 provider turn
```

首个错误差异不是 ID 回卷本身，而是 `MessageV2.latest()` 与 `SessionPrompt.runLoop` 把有限周期 ID 当成永久 chronology。数据库分页已经持有不回卷的 epoch-millisecond `time_created`，但内存 consumer 放弃了该顺序。

#### 同类 message/part consumer

```text
packages/opencode/src/session/message-v2.ts:96-107
  hydrate parts ORDER BY (message_id, part_id)

packages/opencode/src/session/message-v2.ts:490-502
  standalone parts ORDER BY part_id

packages/opencode/src/session/revert.ts:74
  diff range: msg.id >= revert.messageID

packages/opencode/src/session/revert.ts:100-130
  cleanup range: msg.id < / > boundary

packages/opencode/src/session/session.ts:693-732
  fork cutoff: msg.id >= input.messageID

packages/opencode/src/cli/cmd/run/session-replay.ts:263-326
  missing-anchor fallback: local.messageID < persisted.messageID
```

#### 同根 Identifier timestamp consumer

```text
packages/opencode/src/tool/truncate.ts:54-65 Truncate.cleanup
  → cutoff 由 encoded tool ID 解码
  → entry 由 encoded tool ID 解码
  → 两侧跨 wrap 时把新文件判断为旧文件
```

### 1.5 预期行为与实际行为

| Case                                                  | 当前实际行为                                                                                  | 修复后预期行为                                                                                 |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| pre-wrap history → post-wrap `finish: stop` assistant | raw latest 仍选择 pre-wrap tool-call assistant，继续 provider turn                            | 按 canonical chronology 选择真实 terminal assistant，active run 终止                           |
| history 内同时存在回卷前后 user/assistant             | `latest()` 可能长期选择回卷前 raw-ID max                                                      | 按持久化创建 chronology 选择真实最新消息                                                       |
| finished assistant 后存在 post-wrap task owner        | raw ID range 可能丢 task或保留已完成 task                                                     | task selection 与消息持久化顺序一致                                                            |
| revert/fork boundary 跨 wrap                          | raw ID relational comparison 选择错误范围                                                     | fork 的瞬时 input 继续按 identity 定位；持久化 revert marker 使用 `(time_created,id)` 定位范围 |
| revert marker 指向的 message/part 被单独删除          | PR #15 的 exact-identity cleanup 找不到 boundary，直接 clear marker，错误保留 reverted suffix | 即使 boundary 实体已不存在，仍按 marker 内持久化 chronology key 删除 boundary 后缀             |
| 同一 message 的 parts 跨 wrap                         | SQL 按 part ID 排序，可能把后生成 part 放前面                                                 | SQL 按 `(time_created, id)` 稳定排序                                                           |
| CLI missing-anchor local row 跨 wrap                  | raw ID fallback 可能插入错误位置                                                              | 使用显式 local chronology metadata，不比较 raw ID 时间                                         |
| 回卷后七天内新 tool-output 文件                       | cleanup 可能立即删除新文件                                                                    | 使用文件 `mtime`，只删除真实超过 retention 的文件                                              |
| 普通同周期 Session                                    | raw ID 与创建时间通常同序                                                                     | 可观察顺序保持不变                                                                             |

### 1.6 PR review follow-up：缺失 revert boundary 静默保留后缀

[PR #15 review](https://github.com/lihaokun/opencode/pull/15#discussion_r3811545420) 给出的最小序列是：

```text
U1: (time=100, id=msg_001)
U2: (time=200, id=msg_002)  ← stage revert marker
U3: (time=300, id=msg_003)  ← reverted suffix

DELETE /session/:sessionID/message/:U2
下一次 prompt → SessionRevert.cleanup()
```

PR #15 当前 follow-up 前的执行是：

```ts
const boundary = msgs.findIndex((msg) => msg.info.id === messageID)
if (boundary === -1) {
  yield * sessions.clearRevert(sessionID)
  return
}
```

删除 `U2` 后，`boundary === -1`，cleanup 清空 marker 并返回；`U3` 留在 transcript，且 `unrevert` 已无法恢复原 marker。该行为不是旧版本的既有缺陷：旧 cleanup 即使 target 不存在，仍会用 raw `id >= messageID` 处理 suffix。PR #15 为消除 rollover 风险把 range 改成 exact identity，但遗漏了“持久化 boundary 的被引用实体可独立删除”这一生命周期。

part boundary 同构：若 `P1 → P2 → P3` 在 `P2` stage revert 后单独删除 `P2`，当前 `findIndex(part.id === partID)` 无法定位，`P3` 被保留。修复必须同时覆盖 message 与 part，且不得通过禁止 delete API 来维持 marker 有效性。

可直接执行的回归测试将使用真实 Session/SQLite 路径：创建 `U1/U2/U3`，stage `U2`，通过既有 `removeMessage` 删除 `U2`，调用 `cleanup`，断言只保留 `U1` 且 marker 被清除。对应 part 用例创建同一 message 内 `P1/P2/P3` 后执行相同步骤。

---

## 第二部分：根因分析

### 2.1 根因 A：有限编码被错误提升为永久 chronology

`Identifier.create()` 的六字节布局只保证一个 `2^36 ms` 周期内、时钟不倒退且 counter 未产生异常溢出时的近似递增。代码注释和 consumer 却把 `MessageID.ascending()` 理解为永久单调时钟。

数学上，任意相邻周期都存在：

```text
t1 = k * 2^36 - 1
t2 = k * 2^36 + 1
t1 < t2
encode(t1) = 0xffffffffff...
encode(t2) = 0x0000000000...
encode(t1) > encode(t2)  // raw lexicographic order
```

因此任何直接用 raw ID `<` / `>` 推断 chronology 的实现都不可能跨每个 encoded-ID rollover 正确。延长或重新排布 ID 只能影响新 ID，不能恢复已经持久化的旧 ID epoch，也会改变用户 supplied-ID 和兼容性边界，不是本修复的正确落点。

### 2.2 根因 B：同一模块存在两套互相矛盾的顺序契约

`MessageV2.page()` 已使用：

```text
ORDER BY message.time_created, message.id
```

cursor 也同时保存 `{time, id}`。这说明数据库层已经承认 ID 不能独立承担 durable chronology。可是 `filterCompacted()` 会为模型消费重排数组，随后 `latest()` 又只用 raw ID 恢复“最新”绑定，造成 page/stream 与 latest/tasks 使用不同顺序契约。

根因不是 `filterCompacted()` 允许重排；模型上下文确实需要该逻辑布局。根因是重排后没有复用数据库的 canonical chronology key。

### 2.3 根因 C：prompt terminal gate 重复实现了 raw-ID chronology

prompt loop 的既有行为需要回答：

```text
latest terminal assistant 是否在 latest user 之后产生，从而可以结束当前 run？
```

现实现没有复用 page/latest 的 canonical chronology，而是再次用 `lastUser.id < lastAssistant.id` 实现了一套 raw-ID 顺序。即使 `latest()` 修正，terminal gate 仍会在 rollover 时失败。因此 stop/error exit 必须使用同一个 `compareChronology(lastUser, lastAssistant)`。

`parentID` 不能替代本次修复：生产 event replay 证明 rollover 期间创建的 assistant 已经继承了旧 raw-ID `latest()` 选错的 pre-wrap user。使用 parent equality 会把真正最新的 stopped assistant误判为未覆盖最新 user，并额外发起 provider turn。

### 2.4 根因 D：瞬时 identity input 与持久化 range marker 被混成同一契约

fork input 是一次调用内消费的具体 message ID：其语义是“找到这个 message，在 canonical ordered collection 中从此处分割”，准确 equality 足够。revert marker 则会跨请求持久化，并允许既有 delete API 在 cleanup 前删除其 message/part；它表达的是一个 durable range cutoff，而不只是活实体引用。

原实现用 raw `id >= markerID`，实体缺失时仍能处理 suffix，但把 ID 错当 chronology。PR #15 改成准确 equality + array slice 后解决 rollover，却无意增加了“marker 指向实体必须一直存在”的前置条件。该前置条件不由 API、数据库外键或既有行为保证，因而产生 review regression。正确修复不是回退 raw range，也不是禁止删除，而是让持久化 marker 自身携带 `(time_created,id)` cutoff。

### 2.5 根因 E：part 与文件 retention 重复依赖同一错误假设

PartTable 已经有稳定的 `time_created`，但 hydration 只按 part ID 排序。legacy tool output 也有文件系统 `mtime`，却从 tool ID 解码时间。这两处都丢弃了更直接的 chronology source，转而依赖会回卷的 ID。

### 2.6 症状、根因修复与非目标

以下不是根因修复：

- 在当前回卷点加一个特殊字符串阈值；下一个周期会再次失败；
- 用 modulo-aware ID comparator 猜 epoch；跨多周期、旧数据和 supplied ID 时存在歧义；
- 只把 prompt exit 改成 `parentID`；`latest()`、tasks、revert、fork 和 parts 仍错误；
- 只等待 compaction 过滤旧消息；会话在恢复前仍产生无用 provider 请求。

本修复不解决以下独立问题：

- PR #14 已记录的 V1 compaction 期间并发输入 admission/replay 排序。新的 chronology 会忠实反映物理创建顺序，但不能重建缺失的 logical admission sequence；该问题需要 V2 式 durable input queue/safe-boundary promotion 或独立 V1 设计；
- 系统 wall clock 大幅倒退。`time_created` 是 epoch milliseconds，不是 durable sequence；严格覆盖 clock rollback 需要 schema migration 到 V2 式 `seq`；
- 两个外部 supplied message ID 在同一毫秒并发 admission 的真实先后。`id` tie-breaker只保证确定性，不承诺还原不可观察的 admission 顺序；
- runLoop 读取 U1 snapshot 后、创建 A1 前新 U2 才完成持久化时，`A1.parentID=U1` 但 chronology 为 `U1,U2,A1` 的既有并发归属窗口。它在 ID rollover 前已经存在；若要由 `parentID` 改变 terminal contract，必须作为独立 bug fix 设计和验证，不能混入 #13 的 chronology 修复；
- terminal assistant 已被 runLoop snapshot 读取、但 runner 尚未原子进入 idle 时新 user 才完成持久化的 lost-wake 窗口。该输入不会丢失，但当前 `Runner.ensureRunning()` 可能只 join 即将结束的 run 而不再启动 drain；彻底修复需要 prompt admission/wake generation 与 runner idle transition 的原子协议，不能由 `parentID` 或额外一次非原子数据库读取保证；
- V2 Session runner。V2 chronology 已使用 durable `seq`，本修复不得回退或桥接到 legacy loop。

### 2.7 根因 F：legacy revert marker 丢失了 durable chronology

`Session.Info.revert` 当前只持久化 `messageID` / `partID`。只要 target 存在，代码尚可从 target row 恢复 `time_created`；target 删除后，marker 本身没有足够信息回答“哪些现存 message/part 位于 cutoff 之后”。因此两个看似互斥的实现都只能覆盖一半契约：

```text
raw ID range:
  target 缺失仍可运行
  但 rollover 后 chronology 错

exact ID + slice:
  rollover 时正确
  但 target 缺失时失去 range
```

根因是 marker 数据不完整，不是 `findIndex` 的局部错误。新 marker 必须在 stage 时保存 message chronology，part revert 还要保存 part chronology；旧 marker 在读取时按旧 ID 逻辑一次性补成当前内存形态。兼容 hydration 只恢复旧版本当时可表达的 boundary，不声称纠正旧 marker 已经具有的 rollover 歧义。

---

## 第三部分：参考实现对照

### 3.1 参考实现：V2 durable sequence

项目规则实体明确要求保持 V2 durable admission、serialized runner 与 Session History 边界。V2 的 ID 生成器仍使用相同六字节时间布局，因此参考价值不在“V2 ID 不回卷”，而在“V2 不把 ID 当 chronology”。

V2 message projection 保存 event aggregate sequence：

```ts
// packages/core/src/session/sql.ts
export const SessionMessageTable = sqliteTable("session_message", {
  id: text().primaryKey(),
  session_id: text().notNull(),
  type: text().notNull(),
  seq: integer().notNull(),
  ...Timestamps,
  data: text({ mode: "json" }).notNull(),
})
```

Session History 只按 `seq` 读取：

```ts
// packages/core/src/session/history.ts
const rows =
  yield *
  db
    .select()
    .from(SessionMessageTable)
    .where(/* session/compaction boundary */)
    .orderBy(asc(SessionMessageTable.seq))
    .all()
```

V2 revert 先用 ID 查准确 boundary，再比较 boundary sequence：

```ts
// packages/core/src/session/revert.ts
const boundary =
  yield *
  db
    .select({ seq: SessionMessageTable.seq })
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.id, messageID)))
    .get()

const rows =
  yield *
  db
    .select()
    .from(SessionMessageTable)
    .where(gt(SessionMessageTable.seq, boundary.seq))
    .orderBy(asc(SessionMessageTable.seq))
    .all()
```

V2 prompt admission 另有 `SessionInputTable.admitted_seq` / `promoted_seq`，因此 logical input order 也不依赖 prompt ID。该能力超出 issue #13 的 V1 compatibility patch，并解释了为什么本修复不能顺带关闭 PR #14 的 compaction 并发 admission follow-up。

### 3.2 同一 rollover 输入的逐步执行差异

输入：

```text
U.id = encode(2^36 - 1) = msg_ffff...
A.id = encode(2^36 + 1) = msg_0000...
A.parentID = U.id
A.finish = stop
```

| Step               | 当前 V1                                  | V2 参考实现                                      |
| ------------------ | ---------------------------------------- | ------------------------------------------------ |
| 1. durable write U | `MessageTable(id=ffff, time_created=t1)` | `SessionMessageTable(id=ffff, seq=N)`            |
| 2. durable write A | `MessageTable(id=0000, time_created=t2)` | `SessionMessageTable(id=0000, seq=N+1)`          |
| 3. history load    | page 最初按 `(t,id)` 正确加载            | 按 `seq` 得到 `[U,A]`                            |
| 4. latest binding  | raw-ID max/range 丢弃 page chronology    | runner/history 保持 `seq` chronology             |
| 5. completion      | `ffff < 0000` 为 false，继续 run         | A 属于 U 的完成 attempt，runner退出/进入安全边界 |

首个执行差异位于 V1 `MessageV2.latest()`：持久化读取仍正确，但内存绑定从 `(time_created,id)` 降级为 raw ID。该差异正是根因。

### 3.3 V2 tool-output retention 对照

V2 `ToolOutputStore.cleanup()` 不从 ID 解码时间：

```ts
const cutoff = Date.now() - Duration.toMillis(RETENTION)
const info = yield * fs.stat(file)
const modified = info.mtime.map((date) => date.getTime()).getOrElse(() => 0)
if (modified < cutoff) yield * fs.remove(file)
```

同一回卷后新文件输入：V1 decoded ID 小于回卷前 cutoff 并删除；V2 `mtime≈now` 大于 cutoff 并保留。差异与根因一致。

### 3.4 为什么不把 V2 `seq` 直接移植到 V1

给 legacy MessageTable/PartTable 增加 `seq` 能覆盖 clock rollback 和同毫秒 external-ID ambiguity，但需要：

- database schema 与 migration；
- existing rows backfill；
- legacy event projection 首次 insert sequence 与后续 update sequence 的区分；
- pagination cursor 与所有旧数据库兼容验证；
- message/part/public storage 边界审计。

Issue #13 的 rollover 不需要承担这些风险。V1 已持久化首次创建 `time_created`，且 page/cursor 已把 `(time_created,id)` 作为稳定顺序。复用这一既有契约是最小兼容修复；V2 durable sequence 仍是下一代严格 chronology 的参考，而不是本次迁移目标。

### 3.5 缺失 boundary 的行为对照

PR #15 之前的 legacy cleanup 是本 follow-up 的兼容参考：

```ts
for (const msg of msgs) {
  if (msg.info.id < messageID) continue
  if (msg.info.id > messageID) {
    remove.push(msg)
    continue
  }
  // exact target handling
}
```

对 `U1 → U2 → U3`、marker=`U2`、随后删除 `U2`，该实现仍把 raw-ID 意义下的 `U3` 放进 remove set。它的正确属性是“boundary 生命周期不依赖 target 存活”，错误属性是“range chronology 来自 raw ID”。follow-up 保留前者并替换后者：new marker 直接保存 tuple；old marker hydration 仅在缺字段时按旧 ID predecessor 逻辑找到 boundary row，并取该 row 的 `time_created`。因此普通旧数据库保持升级前语义，new marker 则不再有 rollover 歧义。

V2 revert 依赖 target row 的 durable `seq`，但 V2 的 delete/stage/commit 生命周期、schema 与 legacy 不同，不能直接作为“缺失 legacy target”的实现复用。这里只参考它把 durable ordering metadata 与 ID identity 分开的原则，不修改 V2 代码。

---

## 第四部分：修复方案

### 4.1 定义唯一 V1 message chronology

在 `packages/opencode/src/session/message-v2.ts` 定义一个内部可复用 comparator，例如 `compareChronology(left, right)`。

比较域与规约：

```text
类型：MessageChronologyKey
  created: persisted epoch milliseconds
  id: MessageID，只有 created 相同时作为 deterministic tie-breaker

Requires:
  - left.sessionID == right.sessionID
  - created 取消息首次持久化的 MessageTable.time_created

Ensures:
  - created(left) < created(right)  => compare(left,right) < 0
  - created(left) > created(right)  => compare(left,right) > 0
  - created 相等时按 raw id 稳定全序
  - compare(a,b) == -compare(b,a)
  - compare 具传递性

Invariant:
  - raw message ID 不单独表示 chronology
  - 不同 Session 的消息不进入该 comparator
```

等价伪码：

```ts
export function compareChronology(left: Info, right: Info) {
  if (left.time.created < right.time.created) return -1
  if (left.time.created > right.time.created) return 1
  if (left.id < right.id) return -1
  if (left.id > right.id) return 1
  return 0
}
```

这里建立的是 Session 内稳定全序，而不是只含 happens-before 的数学偏序。`latest()`、pagination 和 range 必须得到唯一结果；因果关系另由 `parentID` 表达。

### 4.2 让 hydration 暴露持久化创建时间

`message-v2.ts:80-86 info(row)` 当前直接展开 `row.data`。修改为以 `row.time_created` 覆盖 `data.time.created`，保留 assistant `time.completed`：

```ts
{
  ...row.data,
  id: row.id,
  sessionID: row.session_id,
  time: { ...row.data.time, created: row.time_created },
}
```

legacy projector 在首次 insert 写 `time_created`，后续 `onConflictDoUpdate` 只更新 `data`，不会移动 chronology key。这样 comparator、page SQL 与 cursor 使用同一个 durable source；恶意或意外 message update 也不能悄悄重写创建顺序。

### 4.3 统一 `latest()` 与 task selection

`MessageV2.latest()` 中四个 raw-ID relational consumer 全部改用 `compareChronology`：

- latest user；
- latest assistant；
- latest finished assistant；
- finished boundary 后的 compaction/subtask owner。

`filterCompacted()` 可以继续输出模型逻辑布局：

```text
[compaction-user, summary, retained-tail..., continue-user]
```

因为 `latest()` 不再假设数组位置或 raw ID 即 chronology。普通未 compacted array 也得到相同结果。

### 4.4 prompt stop/error 复用 canonical chronology

在 `SessionPrompt.runLoop` 中，选出 latest user/assistant 后，stop/error gate 使用：

```ts
MessageV2.compareChronology(lastUser, lastAssistant) < 0
```

替代：

```ts
lastUser.id < lastAssistant.id
```

保留现有 finish、tool-calls、orphaned interrupted tool 等判定。该修改只替换 chronology source，不改变 V1 terminal contract。生产 DB 中受 rollover 影响的 assistant 已持有 stale pre-wrap `parentID`，因此本修复不得改用 parent equality；`parentID` 并发归属语义作为 §2.6 的独立非目标。

### 4.5 持久化 revert marker 保存 durable chronology boundary

fork input 仍是瞬时 identity boundary，继续用准确 `msg.info.id === input.messageID` 停止复制；它不持久化，也不受 review regression 影响。revert marker 改为以下 legacy 数据契约：

```text
LegacyRevertMarker（wire / DB JSON）
  messageID: MessageID
  messageTimeCreated?: NonNegativeInt
  partID?: PartID
  partTimeCreated?: NonNegativeInt
  snapshot?: string
  diff?: string

HydratedLegacyRevert（legacy Session service 内存不变量）
  messageID: MessageID
  messageTimeCreated: NonNegativeInt
  partID absent  => partTimeCreated absent
  partID present 且 target message 仍存在 => partTimeCreated present
```

字段命名明确表示值来自首次持久化的 `MessageTable.time_created` / `PartTable.time_created`，而不是从 ID 解码。wire schema 把两个新字段声明为 optional，以便新 App/TUI 仍能连接旧 server，也让共享兼容层接收不带字段的 V2 marker；但当前 legacy server 对新建 marker 总是写全，对旧 marker 每次读取都返回 hydrated 形态。

`SessionRevert.revert()` 在最终确定 `rev.messageID` 后，从对应 canonical message 取 `info.time.created`；若保留 `partID`，从 `PartTable` 取该 part 首次持久化的 `time_created`。注意 `rev.messageID` 可能是循环中计算出的 last user，而不一定等于原始 input，因此必须按最终 marker identity 取时间。新 marker 的 DB JSON 与返回给 caller 的 `Session.Info` 同时包含 chronology 字段。

`SessionRevert.revert()` 的 diff range 也改为 tuple boundary，不再依赖 target index：

```text
messageKey(msg) = (msg.info.time.created, msg.info.id)
markerMessageKey = (revert.messageTimeCreated, revert.messageID)
range = all where messageKey(msg) >= markerMessageKey
```

stage 时 target 必然存在；使用同一 tuple 仍可确保 diff、cleanup 与 UI 解释完全一致。

### 4.5.1 旧 marker 只在 hydration 中升级，不回写

数据库中已存在的 marker 没有 chronology 字段。兼容逻辑集中在 legacy Session marker hydration：

1. marker 已有 `messageTimeCreated`，且需要的 part time 也存在：原样返回，不查额外 row；
2. marker 缺 message time：先按准确 message ID 查 row；若 target 已删除，则复用旧版本 ID 定界规则，选择 raw ID 最大且 `id <= marker.messageID` 的现存 message；
3. 第 2 步没有 predecessor，但 Session 仍有 message：使用 canonical 最早 message 的 `time_created`，对应旧 raw range 会从首项开始删除的空左侧边界；Session 已空则使用确定性的零值，cleanup 只需 clear marker；
4. marker 有 `partID` 但缺 part time：在 marker message 内同样先准确查 ID，再选择 raw ID 最大且 `id <= marker.partID` 的现存 part；没有 predecessor 但仍有 parts 时使用 canonical 最早 part 的 `time_created`，没有任何 part 时不伪造可消费的 part boundary；
5. 返回补全后的内存副本。

该 compatibility fallback 有意保留旧版本的 raw-ID 定界风险：若 old marker 本身跨 rollover，hydration 可能得到旧实现会得到的歧义结果。这不是 new marker 的行为，也不是本 follow-up 新引入的问题。禁止为“矫正”旧 marker 增加 migration、全表 backfill 或 modulo epoch guessing。

hydration 不调用 `patch`、不更新 `SessionTable.revert`、不发布 Session updated event，也不顺便重新持久化。因而：

```text
old DB JSON（无 time）
  → 每次 legacy read 按旧逻辑补全 runtime marker
  → DB JSON 保持原样

new DB JSON（有 time）
  → 直接 hydrate
```

实现可保留纯 `fromRow()` 解析，再在 `get/list/listGlobal/children` 共用的 legacy hydration boundary 上，仅对“存在 old marker 且缺字段”的 row 执行有索引查询。不得修改共享 `packages/core/src/session/sql.ts` 的 V2 `Revert.State`；JSON 列会保留额外 key，legacy adapter 使用局部窄类型解释它们。

### 4.5.2 cleanup 直接比较 tuple，不要求 boundary identity 存活

message-level marker：

```text
remove msg iff messageKey(msg) >= markerMessageKey
```

part-level marker：

```text
remove msg iff messageKey(msg) > markerMessageKey

若 msg.id == marker.messageID 且该 message 仍存在：
  partKey(part) = (PartTable.time_created, part.id)
  markerPartKey = (revert.partTimeCreated, revert.partID)
  remove part iff partKey(part) >= markerPartKey
```

part marker 的准确 message equality 只用于找到仍存活的 container 以删除其 parts，不再决定后续 message suffix 是否清理。message target 已删除时，仍按 message tuple 删除所有较新 message；part target 已删除时，仍按 part tuple 删除所有较新 parts。最后才 clear marker。

Part 公共 schema 不暴露 DB `time_created`，因此 part cleanup 在 legacy server 内部读取 `PartTable` chronology row；不修改公共 Part、Protocol 或 V2 schema。`deleteMessage` / `deletePart` 保持现有独立删除语义，不增加“先升级 marker”、拒绝删除、事务联动或事件伪造。

### 4.5.3 legacy App/TUI 消费同一个 marker tuple

所有把 revert marker ID 当时间边界的 legacy consumer 改用：

```text
compareMessageToRevert(message, marker):
  if marker.messageTimeCreated is present:
    compare (message.time.created, message.id)
            (marker.messageTimeCreated, marker.messageID)
  otherwise:
    preserve existing raw-ID comparison
```

fallback 只服务两种连接兼容：新 client 连接尚未升级的 legacy server，以及共享 App 路径收到没有 legacy chronology extension 的 V2 marker。当前 legacy server hydration 后不会走 fallback。不得为此修改 current/V2 `Revert.State`、V2 Session Core 或 Protocol；legacy Server `HttpApi` 的 additive response 变化按仓库规则同步 generated client types。

需要替换的 marker chronology consumer 至少包括：

- `packages/tui/src/routes/session/index.tsx`：undo、redo、copy-last-assistant、reverted user 计数、reverted suffix 隐藏；
- `packages/app/src/components/session/session-context-tab.tsx`：revert 后 context user 过滤；
- `packages/app/src/pages/session/use-session-commands.tsx`：visible user、undo/redo next boundary、viewport 定位；
- `packages/app/src/pages/session/timeline/model.ts` 与 `message-timeline.tsx`：timeline visible/projected boundary；
- `packages/app/src/utils/session.ts` 与 `server-compat.ts`：转换时保留 runtime chronology extension，不手写一个会丢字段的 marker 子集。

选择“上一个/下一个/第一个隐藏 boundary”时不能只把 predicate 换掉后继续依赖 raw-ID-sorted array 的 `find/findLast`；应在候选集合中按 message tuple 选择最大/最小值。revert dock 的 suffix items 在 marker 带 time 时也按 tuple 排序；无 extension 的 fallback 保持 raw-ID 行为。ID equality、`parentID`、Map key 与纯 identity lookup 不变。

本 follow-up 的前端范围限于 revert marker 派生的 chronology 决策。TUI `pending/queued`、child Session 排序以及 App/TUI 通用 cache 的其它 raw-ID ordering 是 rollout 前已存在的低严重度 UI chronology 风险，不是 review regression 的执行路径；本 PR 不借 marker 修复重写整个 client store。本文不再宣称“仓库所有 ID sort 都已迁移”，只保证 server Session chronology 与所有 legacy revert boundary consumer 不使用 raw marker ID 表达时间。

legacy public `Session.Info.revert` 的 additive 字段需要按仓库规则运行 `./packages/sdk/js/script/build.ts`，并从 `packages/client` 运行 `bun run generate`。生成结果中可能出现 `packages/sdk/js/src/v2/gen/*`；这里的 `v2` 是 legacy JS SDK 的 API 目录名，不代表修改 V2 Session Core。所有 generated 文件只由生成器更新，禁止手改。

### 4.6 PartTable 使用持久化创建顺序

不修改 Part schema，也不把 DB-only time 暴露进公共 Part 类型。只修改两个 SQL ordering boundary：

```text
hydrate many messages:
  ORDER BY part.message_id, part.time_created, part.id

parts(messageID):
  ORDER BY part.time_created, part.id
```

Part projector 和 Message projector 一样在首次 insert 固定 `time_created`，后续更新只改 data，因此 stream 增量更新不会移动 part 的位置。同一毫秒用 ID tie-break；rollover 两侧一定先由不同 epoch millisecond 判定。

### 4.7 CLI local replay 携带显式 chronology metadata

`replayLocalRows()` 的 explicit `after` anchor 保持最高优先级。对缺失 anchor 的 fallback，不再比较 raw message ID：

1. `LocalReplayRow` 增加 process-local `createdAt`，在 row 首次进入 `state.localRows` 时记录；
2. runtime 记录首个可见输出作为未持久化 prompt 的 `before` anchor，并保留最后可见输出作为 failure 的 `after` anchor；
3. persisted commit 的 chronology 从 `messages[].info.time.created` 建立 map；
4. 有 anchor 时优先按准确 commit/part identity 定位；缺失 anchor 时用 `(createdAt, messageID)` 与 persisted `(time.created, messageID)` 定位；
5. 同一 local row 集合保持原数组 admission 顺序；
6. row 与 anchors 均不持久化、不改变 SDK/API/event schema。

该项只修复 CLI scrollback 在 ID wrap 时的 fallback 顺序，不解决 server-side compaction concurrent admission。两者必须在文档和测试名中保持独立。

### 4.8 legacy tool-output retention 改用文件 `mtime`

直接采用 V2 `ToolOutputStore.cleanup()` 的 chronology source：

```ts
const cutoff = Date.now() - Duration.toMillis(RETENTION)
const info = yield * fs.stat(file).pipe(Effect.catch(() => Effect.void))
const modified = info?.mtime.pipe(
  Option.map((date) => date.getTime()),
  Option.getOrElse(() => 0),
)
if (modified < cutoff) yield * fs.remove(file)
```

仅处理 `tool_` managed files；保留 unreadable/missing file 的现有 best-effort cleanup 语义。测试使用 `fs.utimes()` 设置真实旧 mtime，不再通过伪造 ID 时间表达文件年龄。

### 4.9 Identifier 保持兼容、移除错误承诺

不改变 `Identifier.create()` 输出格式、长度、prefix、random suffix 或 `MessageID.ascending(given)` supplied-ID 行为。只修正源码注释/文档中“monotonic”一词，明确：

- ID 在一个编码周期内可近似 time-sortable；
- 不保证跨 rollover/global wall-clock 单调；
- `timestamp()` 返回编码周期内的低 36 位时间，不是完整 epoch。

不得新增新的 raw-ID chronology consumer。

### 4.10 第一部分复现经过修复后的执行

```text
U0: id=msg_ffff..., persisted time_created=2^36-2
A0: id=msg_ffff..., persisted time_created=2^36-1, finish=tool-calls
U1: id=msg_0000..., persisted time_created=2^36+1
A1: id=msg_0000..., persisted time_created=2^36+2,
    parentID=U0.id（旧 latest() 产生的 stale parent）, finish=stop

MessageV2.page
  → ORDER BY (time_created,id)
  → [U0,A0,U1,A1]

filterCompacted/latest
  → latestUser=U1, latestAssistant=A1

SessionPrompt.runLoop
  → compareChronology(U1,A1) < 0
  → A1.finish=stop && no live tool calls
  → break
  → 0 additional provider requests
```

fork 使用准确 identity boundary；revert/parts 使用 marker 内 persisted chronology；tool cleanup 使用 `mtime`。因此同一个 encoded-ID wrap 不再进入这些持久化 Session chronology 决策。

PR review 的缺失 boundary 序列修复后执行为：

```text
stage U2
  → marker = { messageID: U2.id, messageTimeCreated: U2.time.created }

delete U2
  → marker 不变，U1/U3 仍存在

cleanup
  → compare(U1, marker) < 0  => keep U1
  → compare(U3, marker) > 0  => remove U3
  → clear marker
```

旧 DB marker 缺 `messageTimeCreated` 时，hydration 先按 old ID predecessor 规则取得 boundary time，返回同一 runtime 形态；该读取不改变 DB。part boundary 使用完全相同的两级 tuple：message suffix 先清理，target message 若仍存在再清理 part suffix。

---

## 第五部分：正确性论证

### 5.1 根因消除

#### Lemma 1：epoch `time_created` 不受 `2^36 ms` ID encoding rollover 影响

SQLite integer 与 JavaScript safe integer 可完整表示当前 epoch milliseconds；`time_created` 保存原始 `Date.now()`/message creation time，不截断到六字节。因此对任意跨 rollover 的 `t1 < t2`：

```text
persisted_created(t1) < persisted_created(t2)
```

不依赖 `encode(t1)` 与 `encode(t2)` 的相对字符串大小。

#### Lemma 2：ID tie-breaker 不会重新引入 rollover 错误

comparator 仅在 `created(left) === created(right)` 时读取 ID。encoded-ID rollover 需要两个不同 epoch milliseconds 位于周期两侧，所以 primary `created` 已经给出顺序；raw ID 无机会推翻它。相同毫秒内 ID 只提供 deterministic total order。

#### Lemma 3：hydration、page、latest 使用同一 chronology

`page()` 的 SQL key 是 `(MessageTable.time_created, MessageTable.id)`；hydration 把同一个 `row.time_created` 放入 `Info.time.created`；`latest()` 用同构 comparator。故 DB selection、cursor 与内存 latest 不再漂移。

#### Lemma 4：prompt completion 与 latest 使用同一 chronology

`latest()` 与 prompt stop/error gate 都使用 persisted `(time_created,id)` comparator。若 terminal assistant 在 latest user 后创建，则 gate 成立；若 latest user 更新，则 gate 不成立。生产 rollover assistant 的 stale `parentID` 不参与 recovery，因此不会掩盖 chronology 上真正最新的 stopped assistant。并发 snapshot 的 causal ownership 语义保持既有行为，并明确留在 §2.6 非目标。

#### Lemma 5：持久化 range 不依赖 boundary 实体存活

new revert marker 在 target 存活时复制其 persisted chronology key。后续删除 target 只删除 MessageTable/PartTable row，不会改变 marker JSON；cleanup 对现存 rows 直接比较 tuple，因而不需要重新找到 equality boundary。fork 等瞬时 identity input 仍只在调用期间解析准确 target，不改变其既有契约。

#### Lemma 6：part 与 file chronology 使用各自直接来源

PartTable 的首次 `time_created` 与 file `mtime` 都不经过 Identifier 六字节编码。因此 part sequence 与 retention decision 不受 ID wrap 影响。

#### Lemma 7：legacy hydration 不给新数据重新引入 rollover

raw-ID predecessor 只在 persisted marker 缺 chronology 字段时运行。new marker 从创建起已有 tuple，永不进入 fallback；所以 old marker 可能保留的 rollover 歧义不会传播给新 marker。hydration 无写副作用，反复读取不会逐步漂移或把推测值固化进数据库。

#### Lemma 8：server、App 与 TUI 解释同一 cutoff

legacy server 返回的 hydrated marker、cleanup comparator 和 legacy frontend comparator 都使用 `(messageTimeCreated,messageID)`。同一 message 对同一 marker 的比较符号一致，因此 server 计划删除的 suffix 与 UI 隐藏/undo/redo 选择的 suffix 一致。没有 extension 的 old server/V2 marker 单独走兼容 fallback，不改变这些实现的既有行为。

由 Lemma 1-8，issue #13 的主执行路径和 legacy revert boundary consumer 不再把 raw ID 提升为永久 chronology/range/retention source；PR review 暴露的 missing-target 生命周期也被 marker 自身的 durable cutoff 覆盖，而不是只掩盖 `findIndex === -1` 症状。

### 5.2 不变量保持

修复后保持以下既有不变量：

- Message/Part ID 字符串、prefix 与长度不变；legacy revert public schema 只增加 optional chronology 字段，旧 client 可忽略、新 client 可连接旧 server；
- ID equality、parentID、tail_start_id、messageID/partID lookup 语义不变；
- `MessageV2.page()` cursor shape `{time,id}` 与分页方向不变；
- `filterCompacted()` 的模型消费布局和 compaction boundary 不变；
- parts 更新同一 ID 时保持原位置，不因 streaming update 重新排序；
- prompt 的 finish/tool-call/orphan/error 优先级不变，仅把 terminal chronology 判定替换为 canonical comparator；
- revert snapshot/diff 和 fork ID remap 逻辑不变；持久化 revert range 改由 marker tuple 解析；
- CLI explicit anchor 行为优先于 fallback，local rows 仍是 process-local；
- tool cleanup 仍只删除超过七天的 managed `tool_` 文件；
- V2 `SessionMessageTable.seq`、`SessionInput.admitted_seq`、runner 与 history 不改动。

新增内部不变量：

```text
V1-CHRONOLOGY-1:
  同一 Session 内需要 chronological selection 的 message consumer
  必须使用 persisted (time_created,id) 或由该顺序产生的 array position。

V1-IDENTITY-1:
  message/part ID 只用于 identity/equality/reference；禁止 raw relational
  string comparison 表达跨时间 chronology。

V1-TERMINAL-1:
  prompt stop/error gate 必须与 latest() 使用同一个 persisted chronology comparator，
  不得重新用 raw ID relational comparison。

V1-REVERT-1:
  新建 legacy revert marker 必须携带 message chronology；part marker 还必须携带
  可用的 part chronology。cleanup 不得把 target identity 存活作为 suffix cleanup 前置条件。

V1-REVERT-COMPAT-1:
  old marker chronology 只在 read hydration 中按旧 ID 语义补全；不得写回、迁移、
  发布伪 update event或修改 V2 Revert.State。
```

### 5.3 无回归引入

普通同周期、时钟正常的内部生成 ID 原本与 `time_created` 同序，因此 `latest()`、task、revert、fork 的常见结果不变。差异只出现在原先隐含假设失效或 supplied ID 不反映创建时间的场景。

风险与对应验证：

- **compaction layout 风险**：`filterCompacted()` 会重排 array；用 persisted comparator 而非 array max/last，并补 compaction/replay regression；
- **same-millisecond 风险**：仍用 ID 作为 tie-breaker，锁定与 page SQL 相同结果；
- **prompt tool-loop 风险**：保留 `hasToolCalls` 和 finish 条件，补普通 tool continuation regression；
- **revert/fork boundary 风险**：保留 fork identity 用例；revert 补 boundary 存活/删除、message/part、tuple 前/本身/后的准确集合断言；
- **old marker 兼容风险**：补 exact/predecessor/空左侧 hydration，并直接读取 DB 证明 hydration 不回写；
- **wire 兼容风险**：新字段保持 optional；legacy SDK regenerated type、old-server fallback 和 App compatibility converter 分别验证；
- **frontend 选择风险**：undo/redo 不能依赖 raw-ID-sorted array 的 find/findLast，补 rollover + missing target 的 tuple min/max selector 用例；
- **part streaming 风险**：首次 insert time 固定，补更新同一 part 不移动顺序；
- **CLI replay 风险**：保留 explicit anchor 全套既有用例，并新增 rollover fallback；
- **cleanup 风险**：采用已有 V2 实现形态，补 old/recent/unrelated/missing-stat 用例；
- **当前 PR 回归风险**：重跑 context overflow、incomplete-stream crossover 与 API stub suites，证明 #11/#12 三态恢复未被 chronology 修改影响。

### 5.4 明确保证上界

本方案保证每个 encoded-ID rollover 都不会破坏已列出的 V1 server Session chronology 与 legacy revert boundary；new marker 在 target message/part 删除后仍能处理 suffix。它不宣称 `time_created` 等价于 V2 durable sequence，也不在本 PR 全面重写 legacy frontend cache：wall-clock rollback、不可观察的同毫秒 external admission 和 §4.5.3 明列的非-marker UI ordering 仍在非目标内。若未来要求覆盖这些边界，应单独设计 V1 schema/client-store migration 或完成 V2 切换，不能继续扩展 ID comparator 猜测 epoch。

---

## 第六部分：测试用例清单

所有 provider 相关用例使用现有进程内 `TestLLMServer`，不访问真实 API。测试从 `packages/opencode` 运行；不得从仓库根目录运行。

| 类型 | 文件 / 计划用例                                                                                                                   | 用例描述                                                                                                                          | 状态（修复后回填）                 |
| ---- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| 回归 | `test/session/message-v2.test.ts` — `selects the latest messages across the 36-bit timestamp rollover`                            | 使用真实 `Identifier.create(timestamp)` + `MessageV2.latest` 固化第一部分最小复现                                                 | 已加并通过: `6784e5ad92`           |
| 回归 | `test/session/prompt.test.ts` — `loop exits without a provider request across the message ID rollover`                            | 固化生产形状 `U0,A0(tool-calls),U1,A1(parent=U0,stop)`；证明 canonical chronology 选择 A1 并零 provider request                   | 已更新并通过: `6784e5ad92`         |
| 新增 | `test/session/message-v2.test.ts` — `keeps tasks created after a pre-rollover finished assistant`                                 | finished assistant 与 compaction owner 跨 wrap，tasks 只保留真实较新项                                                            | 已加并通过: `6784e5ad92`           |
| 新增 | `test/session/messages-pagination.test.ts` — `paginates messages by persisted time across the ID rollover`                        | 多页 cursor 跨 wrap；无重复、无遗漏、每页顺序稳定                                                                                 | 已加并通过: `6784e5ad92`           |
| 新增 | `test/session/messages-pagination.test.ts` — `orders parts by persisted creation time across the ID rollover`                     | `page/parts` 按持久化顺序一致，并验证后续更新不移动原 part                                                                        | 已加并通过: `6784e5ad92`           |
| 新增 | `test/session/messages-pagination.test.ts` — `preserves the persisted creation time when a message is updated`                    | 同一 message 后续 update 不改变首次持久化 chronology                                                                              | 已加并通过: `6784e5ad92`           |
| 新增 | `test/session/revert-compact.test.ts` — `cleanup honors the exact revert boundary across the ID rollover`                         | 保留 boundary 前缀并删除 boundary/后缀；既有 sequential revert/diff suites 同时全量通过                                           | 已加并通过: `6784e5ad92`           |
| 回归 | `test/session/revert-compact.test.ts` — `cleanup removes the reverted suffix after its message boundary is deleted`               | 固化 review 的 `U1/U2/U3 → revert U2 → delete U2 → cleanup`；断言只保留 U1                                                        | 已加并通过 — 本轮 worktree         |
| 新增 | `test/session/revert-compact.test.ts` — `cleanup removes later parts after its part boundary is deleted`                          | `P1/P2/P3 → revert P2 → delete P2` 后删除 P3、保留 P1，并继续删除较新 messages                                                    | 已加并通过 — 本轮 worktree         |
| 新增 | 上述 message/part regressions                                                                                                     | new marker 写入 message/part persisted time；target 删除后 tuple cleanup 不受 raw ID wrap 影响                                    | 已断言 raw DB JSON 并通过          |
| 兼容 | `test/session/revert-compact.test.ts` — legacy hydration cases                                                                    | 手工写入无 time 的 old marker，覆盖 exact target、deleted target predecessor、空左侧；读取后 runtime 有 boundary，原 DB JSON 不变 | 已加 2 例并通过 — 本轮 worktree    |
| 新增 | `test/session/messages-pagination.test.ts` — `fork stops at the exact message boundary across the ID rollover`                    | fork 只复制 boundary 前消息并正确 remap assistant parent                                                                          | 已加并通过: `6784e5ad92`           |
| 新增 | `test/session/message-v2.test.ts` — `filterCompacted preserves latest chronology across the ID rollover`                          | compaction summary + retained tail + continue user 的模型重排不影响 latest                                                        | 已加并通过: `6784e5ad92`           |
| 兼容 | `test/session/prompt.test.ts` — `loop continues when finish is stop but assistant has tool parts`                                 | finish=stop 但含 live tool call 时仍继续；无 tool 时退出                                                                          | 既有用例通过                       |
| 新增 | `test/cli/run/session-replay.test.ts` — `places missing-anchor local rows by creation time across the ID rollover`                | 删除 raw message-ID fallback；保留 before/after anchors 与 failed-prompt ordering                                                 | 已加并通过: `6784e5ad92`           |
| 回归 | `test/tool/truncation.test.ts` — `deletes files older than 7 days and preserves recent files`                                     | 使用 `fs.utimes` 固定真实 retention 边界                                                                                          | 已更新并通过: `6784e5ad92`         |
| 新增 | `test/tool/truncation.test.ts` — `uses file mtime regardless of the encoded tool ID timestamp`                                    | old mtime/new ID 删除；recent mtime/old-looking ID 保留                                                                           | 已加并通过: `6784e5ad92`           |
| 兼容 | `test/session/message-v2.test.ts`、`messages-pagination.test.ts`                                                                  | conversion/latest/page/get/stream/parts/filterCompacted 全量                                                                      | 39 + 55 pass                       |
| 兼容 | `test/session/revert-compact.test.ts`、`test/session/session.test.ts`                                                             | revert/fork 全量                                                                                                                  | 8 + 7 pass                         |
| 兼容 | `test/cli/run/session-replay.test.ts`、`stream.transport.test.ts`                                                                 | local replay/anchor/resize replay 全量                                                                                            | 14 + 30 pass                       |
| 兼容 | `test/session/prompt.test.ts`、`test/server/session-prompt-overflow.test.ts`                                                      | prompt、#11/#12 overflow 与 API stub 回归                                                                                         | 81 + 2 pass；1 个既有条件 skip     |
| 兼容 | `test/cli/run/run-process.test.ts`                                                                                                | finish/tool/continuation 与 subprocess 交叉行为                                                                                   | 20 pass                            |
| 兼容 | `test/tool/truncation.test.ts`                                                                                                    | output、配置与 cleanup 全量                                                                                                       | 20 pass                            |
| 兼容 | `packages/app/src/utils/session.test.ts`、`server-compat.test.ts`                                                                 | legacy chronology extension 双向转换不丢失；无字段的 V2/old-server marker 保持 fallback                                           | 相关 App 定向测试 28 pass          |
| 回归 | `packages/app/src/pages/session/timeline/model.test.ts` + chronology selector tests                                               | rollover 与 missing-target 时 visible/undo/redo/projection/dock 使用 tuple min/max/排序，不依赖 raw-ID array position             | 已加并通过                         |
| 回归 | `packages/tui/test/util/session.test.ts`                                                                                          | TUI undo/redo/copy/render boundary 在 rollover 与 missing-target 时使用 marker tuple                                              | 5 pass；TUI 全量 195 pass / 1 skip |
| 生成 | legacy SDK generated type check                                                                                                   | 运行 `./packages/sdk/js/script/build.ts` 后 new optional fields 出现在 legacy Session type；generated diff 仅来自脚本             | 已生成并通过 SDK typecheck         |
| 类型 | `bun typecheck` from `packages/opencode`、`packages/app`、`packages/tui`、`packages/schema`、`packages/sdk/js`、`packages/client` | 受影响 package 类型检查                                                                                                           | 6 个 package 全部通过              |

原始修复的生产 DB 对照与本地验证合计 276 pass、1 个既有条件 skip、0 fail；实现 commit 为 `6784e5ad92`。第一行与 prompt integration 两条均保留，unit comparator 不替代 loop-level proof。另已只读重放事故 Session durable events 至 seq `14744`，确认旧 raw latest 不退出、canonical chronology 选择 stopped assistant 并退出、parent-only predicate 不退出。

本轮 follow-up 验证：`packages/opencode` 完整 `test/session` 在允许 ephemeral localhost listener 后 473 pass / 7 skip / 1 todo / 0 fail；TUI 全量 195 pass / 1 skip / 0 fail；App 受影响四文件 28 pass / 0 fail。App 全量 unit 为 677 pass，唯一失败是未改动 i18n 目录的既有 locale parity（5 个缺失翻译 key）；Schema 定向 legacy test 2 pass，Schema 全量的 2 个既有 EventManifest 计数/顺序失败与本 diff 无关。App production Playwright benchmark 完成 build 后因环境缺 Chromium 未执行；同一 production selector 微基准（10,000 messages × 1,000）fallback 从 89.835ms 到 87.871ms，tuple path 59.541ms，无性能回归。

---

## 第七部分：代码更新清单

| 文件                                                                                                                                         | 函数 / 当前行号                                    | 改动概述                                                                                                                  | 状态（修复后回填）          |
| -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `packages/opencode/src/id/id.ts`                                                                                                             | `create`, `timestamp` / 51-77                      | 保持编码不变；修正 monotonic/timestamp 注释，明确低 36 位周期                                                             | 已改: `6784e5ad92`          |
| `packages/opencode/src/session/message-v2.ts`                                                                                                | `info` / 80-90                                     | 用 `row.time_created` 作为 hydrated message 创建时间                                                                      | 已改: `6784e5ad92`          |
| `packages/opencode/src/session/message-v2.ts`                                                                                                | `hydrate`, `parts` / 100-115, 490-506              | parts 按 `(time_created,id)` 排序                                                                                         | 已改: `6784e5ad92`          |
| `packages/opencode/src/session/message-v2.ts`                                                                                                | 新 `compareChronology`; `latest` / 581-611         | 定义 canonical message chronology；替换 user/assistant/finished/task raw-ID comparisons                                   | 已改: `6784e5ad92`          |
| `packages/opencode/src/session/prompt.ts`                                                                                                    | `runLoop` / 1092-1127                              | stop/error 复用 `compareChronology(lastUser,lastAssistant)`                                                               | 已修订并验证: `6784e5ad92`  |
| `packages/opencode/src/session/revert.ts`                                                                                                    | `revert`, `cleanup` / 31-127                       | 原始修复已移除 raw-ID range；follow-up 在 stage 捕获 marker chronology，diff/cleanup 按 tuple，target 缺失时仍清理 suffix | 已改并验证 — 本轮 worktree  |
| `packages/opencode/src/session/session.ts`                                                                                                   | legacy `Revert`, `fromRow`/read hydration, `toRow` | 增加 optional wire chronology；old marker 只读补全；new marker JSON 保留字段；不回写、不发布事件                          | 已改并验证 — 本轮 worktree  |
| `packages/schema/src/v1/session.ts`                                                                                                          | V1 `SessionRevert` event/session contract          | 同步 optional chronology，使 legacy Updated event 投影不丢字段；不修改 current `Revert.State`                             | 已改并验证 — 本轮 worktree  |
| `packages/opencode/src/session/session.ts`                                                                                                   | `fork` / 693-732                                   | 用准确 boundary identity 截止复制                                                                                         | 已改: `6784e5ad92`          |
| `packages/opencode/src/cli/cmd/run/types.ts`                                                                                                 | `LocalReplayRow` / 332-337                         | 增加 process-local `createdAt` 与 before/after anchors                                                                    | 已改: `6784e5ad92`          |
| `packages/opencode/src/cli/cmd/run/runtime.ts`                                                                                               | `rememberLocal`, prompt failure / 365-369, 644-694 | 记录 local chronology、首个输出 before anchor 与最后输出 after anchor                                                     | 已改: `6784e5ad92`          |
| `packages/opencode/src/cli/cmd/run/session-replay.ts`                                                                                        | `replayLocalRows` / 263-335                        | anchors 优先；missing-anchor fallback 使用 explicit chronology，不比较 raw message ID                                     | 已改: `6784e5ad92`          |
| `packages/opencode/src/tool/truncate.ts`                                                                                                     | `cleanup` / 51-68                                  | 按文件 `mtime` retention，移除 `Identifier.timestamp` 依赖                                                                | 已改: `6784e5ad92`          |
| `packages/opencode/test/session/message-v2.test.ts`                                                                                          | latest/filter suites                               | 加 latest、task、filterCompacted rollover 用例                                                                            | 已加: `6784e5ad92`          |
| `packages/opencode/test/session/messages-pagination.test.ts`                                                                                 | page/get/part/fork suites                          | 加 pagination、持久化时间、part、fork rollover 用例                                                                       | 已加: `6784e5ad92`          |
| `packages/opencode/test/session/prompt.test.ts`                                                                                              | prompt loop suites                                 | 加生产 DB 形状的 stopped assistant 零请求用例                                                                             | 已修订并通过: `6784e5ad92`  |
| `packages/opencode/test/session/revert-compact.test.ts`                                                                                      | revert/cleanup suites                              | 加跨 wrap exact boundary 用例                                                                                             | 已加: `6784e5ad92`          |
| `packages/opencode/test/session/revert-compact.test.ts`、`session-schema.test.ts`                                                            | missing boundary / marker hydration/schema suites  | 加 message/part target 删除、new marker rollover、old marker predecessor、DB 不回写与 optional encoding 用例              | 已改并验证 — 本轮 worktree  |
| `packages/opencode/test/cli/run/session-replay.test.ts`、`stream.transport.test.ts`                                                          | local replay suites                                | 加显式 chronology rollover fallback、before anchor 与 fixture                                                             | 已加: `6784e5ad92`          |
| `packages/opencode/test/tool/truncation.test.ts`                                                                                             | cleanup suite                                      | 改为 mtime fixture并加 rollover regression                                                                                | 已加: `6784e5ad92`          |
| `packages/tui/src/routes/session/index.tsx` + `src/util/session.ts`                                                                          | undo/redo/copy/revert render selectors             | marker relational comparisons改为 tuple；next/previous 用 tuple selection；missing target 时 dock 移到首个 suffix message | 已改并验证 — 本轮 worktree  |
| `packages/tui/test/util/session.test.ts`                                                                                                     | revert chronology selectors                        | 加 rollover、missing target、old-server fallback                                                                          | 已改并验证 — 本轮 worktree  |
| `packages/app/src/components/session/session-context-tab.tsx`、`pages/session.tsx`、`pages/session/use-session-commands.tsx`、timeline files | legacy revert selectors                            | context/timeline/undo/redo/projection/dock 使用 marker tuple；V2/no-extension 保留现状                                    | 已改并验证 — 本轮 worktree  |
| `packages/app/src/utils/session.ts`、`server-compat.ts`                                                                                      | Session compatibility conversion                   | 保留 legacy marker chronology runtime extension；不修改 V2 schema                                                         | 已改并验证 — 本轮 worktree  |
| `packages/app/src/utils/session.test.ts`、`server-compat.test.ts`、timeline selector tests                                                   | converter/selector suites                          | 加字段保留、tuple boundary 与 fallback 回归                                                                               | 已改并验证 — 本轮 worktree  |
| `packages/sdk/js/src/v2/gen/types.gen.ts`                                                                                                    | generated legacy Session type                      | 由 `./packages/sdk/js/script/build.ts` 生成 optional marker chronology；未手改                                            | 已生成并通过 typecheck      |
| `packages/client/src/generated/*`、`generated-effect/*`                                                                                      | current Protocol client                            | 已运行 `bun run generate` / `check:generated`；该 current contract不派生 legacy instance Session response                 | 已运行，无 diff，check 通过 |
| `docs/fixes/session-fix-message-id-wraparound.md`                                                                                            | 全文                                               | 原始方案已提交；补 PR review 根因、marker 契约、只读 hydration、前端范围及 follow-up 清单                                 | 已回填实现与验证，待提交    |

明确不修改：

- `packages/schema/src/identifier.ts` 的公共 ID 格式；
- `packages/core/src/session/sql.ts` / database migrations；
- `packages/schema/src/revert.ts`、V2 `SessionMessageTable.seq`、`SessionInputTable`、runner/history/revert；
- current Protocol、current/V2 `Revert.State` 与 V2 Session Core；legacy Server `HttpApi` 只做 additive response 扩展，generated client/SDK 只允许由既有生成器更新；
- PR #14 的 compaction concurrent admission/replay follow-up。

---

## 第八部分：文档更新清单

本修复新增/明确了 V1 内部可观察行为不变量，因此不能写“无文档更新”。仓库搜索未发现已有 session chronology design/spec 或该模块的 `expectations.md`；本文作为 legacy V1 修复契约载体。

| 文档路径                                          | 要改什么                                                                                                                  | 状态（修复后回填）                              |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `docs/fixes/session-fix-message-id-wraparound.md` | 保留原始八部分结果，并补 review regression、legacy marker schema/hydration/cleanup、App/TUI 范围；实现后回填测试与 commit | 原始文档 `57dab0571a`；follow-up 已回填，待提交 |
| GitHub issue #13                                  | 实施后回填最终方案、测试证据并关闭；明确 IDs 仍可回卷但 consumer 不再把它当 chronology                                    | PR #15 已声明 `Closes #13`，待合并关闭          |
| stacked PR body / review thread                   | 实施后说明 missing-target 根因、old marker 无写回兼容、legacy-only/V2 non-goal，并附新增测试证据                          | PR 已创建；follow-up 待代码与验证完成后更新     |

不需要同步：

- `docs/fixes/session-fix-context-overflow.md`：该文档已明确 compaction concurrent admission 是独立 follow-up；ID rollover 与 overflow 只是可能的下游相关，不修改 #11/#12 的正确性论证；
- research/design/spec/expectations：仓库目前没有 legacy Session chronology 的对应契约文档或 audit 子计划；
- `FORK_INSTALL.md`：安装/版本契约不变；
- current Protocol：不变；legacy Server `HttpApi` Session response 有 additive 字段，因此从 `packages/client` 运行 `bun run generate`，并单独运行 legacy JS SDK build。

---

## 反模式自检与实施 gate

- 没有修改 ID format 来掩盖旧数据 chronology；
- 没有设计 modulo-aware epoch guessing comparator；
- 没有把 array position 当作 `filterCompacted()` 后仍然有效的 chronology；
- 没有把生产 rollover assistant 的 stale `parentID` 当成 terminal recovery source；
- 没有宣称本修复解决 PR #14 的 compaction concurrent admission；
- 没有宣称 chronology 修复 concurrent snapshot ownership 或 runner 最终 snapshot 与 idle transition 之间的 lost-wake；
- 没有把 V2 durable `seq` migration 偷渡进 V1 compatibility patch；
- 没有把 target delete 禁掉，也没有在 `deleteMessage` / `deletePart` 中加入 marker migration 或事务联动；
- old marker hydration 不写回 DB、不发布 update event；new marker 从创建起写入完整 tuple；
- legacy App/TUI 只在 marker extension 存在时使用 tuple，V2/no-extension fallback 不改语义；
- 同根的 part ordering、CLI fallback 与 tool retention 已进入测试/代码清单，而不是只修 prompt 一行；
- 原始 chronology terminal 修订已完成验证并推送；PR review follow-up 已按确认方案实施并通过定向、完整 session、TUI、生成器与 typecheck 验证，当前只剩 commit/PR review thread 更新。
