# 修正方案 — V1 Session 消息 ID 回卷与持久化顺序

- 状态：生产 DB 根因对照、生产代码、回归测试与本地验证已完成；实现 commit `6784e5ad92`、文档 commit `57dab0571a`，stacked [PR #15](https://github.com/lihaokun/opencode/pull/15) 已创建，issue 待合并关闭
- 日期：2026-08-17
- 对应问题：[#13](https://github.com/lihaokun/opencode/issues/13)
- 计划交付：在基于 [PR #14](https://github.com/lihaokun/opencode/pull/14) 的 `message-id-wraparound` stacked branch 中独立实施，不扩大 PR #14 本身的 context-overflow 修复范围
- 影响模块：legacy V1 Identifier consumer、Session message/part chronology、prompt loop、revert/fork、CLI local replay、legacy tool-output retention
- workflow 路径：`docs/workflow.md` §7 bug-fix flow + §7.1 八部分修正方案
- 修复分类：算法内部逻辑错误；不新增公共接口或数据库 schema，不进入 §4 新功能设计流程

本修复建立一个明确边界：V1 的 message/part ID 是身份键，不是永久时钟。需要 chronology 的 consumer 使用持久化创建时间和稳定 tie-breaker；identity boundary 使用准确 ID equality。V2 已通过 durable sequence 从结构上消除了同类依赖，但本修复不把 V2 的 event/session-input 架构迁回 V1。

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

| Case | 当前实际行为 | 修复后预期行为 |
|---|---|---|
| pre-wrap history → post-wrap `finish: stop` assistant | raw latest 仍选择 pre-wrap tool-call assistant，继续 provider turn | 按 canonical chronology 选择真实 terminal assistant，active run 终止 |
| history 内同时存在回卷前后 user/assistant | `latest()` 可能长期选择回卷前 raw-ID max | 按持久化创建 chronology 选择真实最新消息 |
| finished assistant 后存在 post-wrap task owner | raw ID range 可能丢 task或保留已完成 task | task selection 与消息持久化顺序一致 |
| revert/fork boundary 跨 wrap | raw ID relational comparison 选择错误范围 | 先按 canonical chronology 读取，再按准确 boundary identity 切片 |
| 同一 message 的 parts 跨 wrap | SQL 按 part ID 排序，可能把后生成 part 放前面 | SQL 按 `(time_created, id)` 稳定排序 |
| CLI missing-anchor local row 跨 wrap | raw ID fallback 可能插入错误位置 | 使用显式 local chronology metadata，不比较 raw ID 时间 |
| 回卷后七天内新 tool-output 文件 | cleanup 可能立即删除新文件 | 使用文件 `mtime`，只删除真实超过 retention 的文件 |
| 普通同周期 Session | raw ID 与创建时间通常同序 | 可观察顺序保持不变 |

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

### 2.4 根因 D：identity boundary 被实现成 raw-ID range

revert 和 fork API 接收的是一个具体 message ID。其语义是“找到这个 message，在 canonical ordered collection 中从此处分割”，而不是“构造一个字符串大于等于范围”。使用数组位置或先解析 boundary 后切片能直接表达契约；raw-ID range 同时引入了 rollover、supplied ID 和未来 ID 格式耦合。

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
const rows = yield* db
  .select()
  .from(SessionMessageTable)
  .where(/* session/compaction boundary */)
  .orderBy(asc(SessionMessageTable.seq))
  .all()
```

V2 revert 先用 ID 查准确 boundary，再比较 boundary sequence：

```ts
// packages/core/src/session/revert.ts
const boundary = yield* db
  .select({ seq: SessionMessageTable.seq })
  .from(SessionMessageTable)
  .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.id, messageID)))
  .get()

const rows = yield* db
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

| Step | 当前 V1 | V2 参考实现 |
|---|---|---|
| 1. durable write U | `MessageTable(id=ffff, time_created=t1)` | `SessionMessageTable(id=ffff, seq=N)` |
| 2. durable write A | `MessageTable(id=0000, time_created=t2)` | `SessionMessageTable(id=0000, seq=N+1)` |
| 3. history load | page 最初按 `(t,id)` 正确加载 | 按 `seq` 得到 `[U,A]` |
| 4. latest binding | raw-ID max/range 丢弃 page chronology | runner/history 保持 `seq` chronology |
| 5. completion | `ffff < 0000` 为 false，继续 run | A 属于 U 的完成 attempt，runner退出/进入安全边界 |

首个执行差异位于 V1 `MessageV2.latest()`：持久化读取仍正确，但内存绑定从 `(time_created,id)` 降级为 raw ID。该差异正是根因。

### 3.3 V2 tool-output retention 对照

V2 `ToolOutputStore.cleanup()` 不从 ID 解码时间：

```ts
const cutoff = Date.now() - Duration.toMillis(RETENTION)
const info = yield* fs.stat(file)
const modified = info.mtime.map((date) => date.getTime()).getOrElse(() => 0)
if (modified < cutoff) yield* fs.remove(file)
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

### 4.5 revert 与 fork 使用 identity boundary

`Session.messages()` 已按 page 的 `(time_created,id)` 返回 canonical chronological array。revert/fork 不再构造 raw-ID range：

- `SessionRevert.revert()`：用准确 `messageID` 找到 boundary index，`all.slice(index)` 交给 diff；
- `SessionRevert.cleanup()`：用准确 boundary index 分成 before/target/after；part revert 在 target 已按 canonical part order 的 parts 中按准确 `partID` 切片；
- `Session.fork()`：只在 `msg.info.id === input.messageID` 时停止复制，或先解析准确 index 后 slice。

若 boundary 不存在，保留或明确现有 API 的 not-found/clone-all契约，不用字符串大小猜测一个不存在 boundary 的位置。实现前通过现有测试锁定并在新增用例中明确。

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
const info = yield* fs.stat(file).pipe(Effect.catch(() => Effect.void))
const modified = info?.mtime.pipe(
  Option.map((date) => date.getTime()),
  Option.getOrElse(() => 0),
)
if (modified < cutoff) yield* fs.remove(file)
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

revert/fork/parts 使用同一 persisted chronology 或准确 identity boundary；tool cleanup 使用 `mtime`。因此同一个 encoded-ID wrap 不再进入任何持久化 Session chronology 决策。

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

#### Lemma 5：range consumer 不再解释 ID 内容

revert/fork 先在 canonical ordered array 中通过 equality 解析 boundary，再按 index 切片。任何保持 ID identity 的编码格式、supplied ID 或 rollover 都不会改变 boundary position。

#### Lemma 6：part 与 file chronology 使用各自直接来源

PartTable 的首次 `time_created` 与 file `mtime` 都不经过 Identifier 六字节编码。因此 part sequence 与 retention decision 不受 ID wrap 影响。

由 Lemma 1-6，issue #13 的根因——raw ID 被提升为永久 chronology/range/retention source——在所有已发现 consumer 处被移除，而不是只掩盖 prompt busy-loop 症状。

### 5.2 不变量保持

修复后保持以下既有不变量：

- Message/Part ID 字符串、prefix、长度和 public schema 不变；
- ID equality、parentID、tail_start_id、messageID/partID lookup 语义不变；
- `MessageV2.page()` cursor shape `{time,id}` 与分页方向不变；
- `filterCompacted()` 的模型消费布局和 compaction boundary 不变；
- parts 更新同一 ID 时保持原位置，不因 streaming update 重新排序；
- prompt 的 finish/tool-call/orphan/error 优先级不变，仅把 terminal chronology 判定替换为 canonical comparator；
- revert snapshot/diff 和 fork ID remap 逻辑不变，仅替换 range boundary 解析；
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
```

### 5.3 无回归引入

普通同周期、时钟正常的内部生成 ID 原本与 `time_created` 同序，因此 `latest()`、task、revert、fork 的常见结果不变。差异只出现在原先隐含假设失效或 supplied ID 不反映创建时间的场景。

风险与对应验证：

- **compaction layout 风险**：`filterCompacted()` 会重排 array；用 persisted comparator 而非 array max/last，并补 compaction/replay regression；
- **same-millisecond 风险**：仍用 ID 作为 tie-breaker，锁定与 page SQL 相同结果；
- **prompt tool-loop 风险**：保留 `hasToolCalls` 和 finish 条件，补普通 tool continuation regression；
- **revert/fork boundary 风险**：补 boundary 前/本身/后的准确集合断言；
- **part streaming 风险**：首次 insert time 固定，补更新同一 part 不移动顺序；
- **CLI replay 风险**：保留 explicit anchor 全套既有用例，并新增 rollover fallback；
- **cleanup 风险**：采用已有 V2 实现形态，补 old/recent/unrelated/missing-stat 用例；
- **当前 PR 回归风险**：重跑 context overflow、incomplete-stream crossover 与 API stub suites，证明 #11/#12 三态恢复未被 chronology 修改影响。

### 5.4 明确保证上界

本方案保证每个 encoded-ID rollover 都不会破坏 V1 Session message/part chronology。它不宣称 `time_created` 等价于 V2 durable sequence：wall-clock rollback、不可观察的同毫秒外部 admission 顺序仍在非目标内。若未来要求覆盖这些边界，应单独设计 V1 schema migration 或完成 V2 切换，不能继续扩展 ID comparator 猜测 epoch。

---

## 第六部分：测试用例清单

所有 provider 相关用例使用现有进程内 `TestLLMServer`，不访问真实 API。测试从 `packages/opencode` 运行；不得从仓库根目录运行。

| 类型 | 文件 / 计划用例 | 用例描述 | 状态（修复后回填） |
|---|---|---|---|
| 回归 | `test/session/message-v2.test.ts` — `selects the latest messages across the 36-bit timestamp rollover` | 使用真实 `Identifier.create(timestamp)` + `MessageV2.latest` 固化第一部分最小复现 | 已加并通过: `6784e5ad92` |
| 回归 | `test/session/prompt.test.ts` — `loop exits without a provider request across the message ID rollover` | 固化生产形状 `U0,A0(tool-calls),U1,A1(parent=U0,stop)`；证明 canonical chronology 选择 A1 并零 provider request | 已更新并通过: `6784e5ad92` |
| 新增 | `test/session/message-v2.test.ts` — `keeps tasks created after a pre-rollover finished assistant` | finished assistant 与 compaction owner 跨 wrap，tasks 只保留真实较新项 | 已加并通过: `6784e5ad92` |
| 新增 | `test/session/messages-pagination.test.ts` — `paginates messages by persisted time across the ID rollover` | 多页 cursor 跨 wrap；无重复、无遗漏、每页顺序稳定 | 已加并通过: `6784e5ad92` |
| 新增 | `test/session/messages-pagination.test.ts` — `orders parts by persisted creation time across the ID rollover` | `page/parts` 按持久化顺序一致，并验证后续更新不移动原 part | 已加并通过: `6784e5ad92` |
| 新增 | `test/session/messages-pagination.test.ts` — `preserves the persisted creation time when a message is updated` | 同一 message 后续 update 不改变首次持久化 chronology | 已加并通过: `6784e5ad92` |
| 新增 | `test/session/revert-compact.test.ts` — `cleanup honors the exact revert boundary across the ID rollover` | 保留 boundary 前缀并删除 boundary/后缀；既有 sequential revert/diff suites 同时全量通过 | 已加并通过: `6784e5ad92` |
| 新增 | `test/session/messages-pagination.test.ts` — `fork stops at the exact message boundary across the ID rollover` | fork 只复制 boundary 前消息并正确 remap assistant parent | 已加并通过: `6784e5ad92` |
| 新增 | `test/session/message-v2.test.ts` — `filterCompacted preserves latest chronology across the ID rollover` | compaction summary + retained tail + continue user 的模型重排不影响 latest | 已加并通过: `6784e5ad92` |
| 兼容 | `test/session/prompt.test.ts` — `loop continues when finish is stop but assistant has tool parts` | finish=stop 但含 live tool call 时仍继续；无 tool 时退出 | 既有用例通过 |
| 新增 | `test/cli/run/session-replay.test.ts` — `places missing-anchor local rows by creation time across the ID rollover` | 删除 raw message-ID fallback；保留 before/after anchors 与 failed-prompt ordering | 已加并通过: `6784e5ad92` |
| 回归 | `test/tool/truncation.test.ts` — `deletes files older than 7 days and preserves recent files` | 使用 `fs.utimes` 固定真实 retention 边界 | 已更新并通过: `6784e5ad92` |
| 新增 | `test/tool/truncation.test.ts` — `uses file mtime regardless of the encoded tool ID timestamp` | old mtime/new ID 删除；recent mtime/old-looking ID 保留 | 已加并通过: `6784e5ad92` |
| 兼容 | `test/session/message-v2.test.ts`、`messages-pagination.test.ts` | conversion/latest/page/get/stream/parts/filterCompacted 全量 | 39 + 55 pass |
| 兼容 | `test/session/revert-compact.test.ts`、`test/session/session.test.ts` | revert/fork 全量 | 8 + 7 pass |
| 兼容 | `test/cli/run/session-replay.test.ts`、`stream.transport.test.ts` | local replay/anchor/resize replay 全量 | 14 + 30 pass |
| 兼容 | `test/session/prompt.test.ts`、`test/server/session-prompt-overflow.test.ts` | prompt、#11/#12 overflow 与 API stub 回归 | 81 + 2 pass；1 个既有条件 skip |
| 兼容 | `test/cli/run/run-process.test.ts` | finish/tool/continuation 与 subprocess 交叉行为 | 20 pass |
| 兼容 | `test/tool/truncation.test.ts` | output、配置与 cleanup 全量 | 20 pass |
| 类型 | `bun typecheck` from `packages/opencode` | 类型检查 | 通过 |

生产 DB 对照后的本地验证合计 276 pass、1 个既有条件 skip、0 fail；实现 commit 为 `6784e5ad92`。第一行与 prompt integration 两条均保留，unit comparator 不替代 loop-level proof。另已只读重放事故 Session durable events 至 seq `14744`，确认旧 raw latest 不退出、canonical chronology 选择 stopped assistant 并退出、parent-only predicate 不退出。

---

## 第七部分：代码更新清单

| 文件 | 函数 / 当前行号 | 改动概述 | 状态（修复后回填） |
|---|---|---|---|
| `packages/opencode/src/id/id.ts` | `create`, `timestamp` / 51-77 | 保持编码不变；修正 monotonic/timestamp 注释，明确低 36 位周期 | 已改: `6784e5ad92` |
| `packages/opencode/src/session/message-v2.ts` | `info` / 80-90 | 用 `row.time_created` 作为 hydrated message 创建时间 | 已改: `6784e5ad92` |
| `packages/opencode/src/session/message-v2.ts` | `hydrate`, `parts` / 100-115, 490-506 | parts 按 `(time_created,id)` 排序 | 已改: `6784e5ad92` |
| `packages/opencode/src/session/message-v2.ts` | 新 `compareChronology`; `latest` / 581-611 | 定义 canonical message chronology；替换 user/assistant/finished/task raw-ID comparisons | 已改: `6784e5ad92` |
| `packages/opencode/src/session/prompt.ts` | `runLoop` / 1092-1127 | stop/error 复用 `compareChronology(lastUser,lastAssistant)` | 已修订并验证: `6784e5ad92` |
| `packages/opencode/src/session/revert.ts` | `revert`, `cleanup` / 31-127 | 准确 boundary lookup + canonical array slice，移除 raw-ID range | 已改: `6784e5ad92` |
| `packages/opencode/src/session/session.ts` | `fork` / 693-732 | 用准确 boundary identity 截止复制 | 已改: `6784e5ad92` |
| `packages/opencode/src/cli/cmd/run/types.ts` | `LocalReplayRow` / 332-337 | 增加 process-local `createdAt` 与 before/after anchors | 已改: `6784e5ad92` |
| `packages/opencode/src/cli/cmd/run/runtime.ts` | `rememberLocal`, prompt failure / 365-369, 644-694 | 记录 local chronology、首个输出 before anchor 与最后输出 after anchor | 已改: `6784e5ad92` |
| `packages/opencode/src/cli/cmd/run/session-replay.ts` | `replayLocalRows` / 263-335 | anchors 优先；missing-anchor fallback 使用 explicit chronology，不比较 raw message ID | 已改: `6784e5ad92` |
| `packages/opencode/src/tool/truncate.ts` | `cleanup` / 51-68 | 按文件 `mtime` retention，移除 `Identifier.timestamp` 依赖 | 已改: `6784e5ad92` |
| `packages/opencode/test/session/message-v2.test.ts` | latest/filter suites | 加 latest、task、filterCompacted rollover 用例 | 已加: `6784e5ad92` |
| `packages/opencode/test/session/messages-pagination.test.ts` | page/get/part/fork suites | 加 pagination、持久化时间、part、fork rollover 用例 | 已加: `6784e5ad92` |
| `packages/opencode/test/session/prompt.test.ts` | prompt loop suites | 加生产 DB 形状的 stopped assistant 零请求用例 | 已修订并通过: `6784e5ad92` |
| `packages/opencode/test/session/revert-compact.test.ts` | revert/cleanup suites | 加跨 wrap exact boundary 用例 | 已加: `6784e5ad92` |
| `packages/opencode/test/cli/run/session-replay.test.ts`、`stream.transport.test.ts` | local replay suites | 加显式 chronology rollover fallback、before anchor 与 fixture | 已加: `6784e5ad92` |
| `packages/opencode/test/tool/truncation.test.ts` | cleanup suite | 改为 mtime fixture并加 rollover regression | 已加: `6784e5ad92` |
| `docs/fixes/session-fix-message-id-wraparound.md` | 全文 | 回填最终范围、non-goals、测试、代码状态与实现 commit | 已提交: `57dab0571a`；PR 状态由后续文档 commit 回填 |

明确不修改：

- `packages/schema/src/identifier.ts` 的公共 ID 格式；
- `packages/core/src/session/sql.ts` / database migrations；
- V2 `SessionMessageTable.seq`、`SessionInputTable`、runner/history/revert；
- Protocol、Server `HttpApi`、legacy SDK generated files；
- PR #14 的 compaction concurrent admission/replay follow-up。

---

## 第八部分：文档更新清单

本修复新增/明确了 V1 内部可观察行为不变量，因此不能写“无文档更新”。仓库搜索未发现已有 session chronology design/spec 或该模块的 `expectations.md`；本文作为 legacy V1 修复契约载体。

| 文档路径 | 要改什么 | 状态（修复后回填） |
|---|---|---|
| `docs/fixes/session-fix-message-id-wraparound.md` | 记录八部分方案并回填测试结果、实际文件、non-goals 与实现 commit | 已提交: `57dab0571a`；PR 状态由后续文档 commit 回填 |
| GitHub issue #13 | 实施后回填最终方案、测试证据并关闭；明确 IDs 仍可回卷但 consumer 不再把它当 chronology | PR #15 已声明 `Closes #13`，待合并关闭 |
| stacked PR body | 基于 PR #14 创建独立 PR，增加 #13 summary、测试结果与 `Closes #13`；不把它描述为 context-overflow 根因，也不扩大 PR #14 本身范围 | 已创建 [PR #15](https://github.com/lihaokun/opencode/pull/15)，base=`dev`，并明确 `Depends on #14` |

不需要同步：

- `docs/fixes/session-fix-context-overflow.md`：该文档已明确 compaction concurrent admission 是独立 follow-up；ID rollover 与 overflow 只是可能的下游相关，不修改 #11/#12 的正确性论证；
- research/design/spec/expectations：仓库目前没有 legacy Session chronology 的对应契约文档或 audit 子计划；
- `FORK_INSTALL.md`：安装/版本契约不变；
- SDK/OpenAPI：无 public Protocol 或 Server `HttpApi` 变化，不运行 `bun run generate` 或 legacy SDK regeneration。

---

## 反模式自检与实施 gate

- 没有修改 ID format 来掩盖旧数据 chronology；
- 没有设计 modulo-aware epoch guessing comparator；
- 没有把 array position 当作 `filterCompacted()` 后仍然有效的 chronology；
- 没有把生产 rollover assistant 的 stale `parentID` 当成 terminal recovery source；
- 没有宣称本修复解决 PR #14 的 compaction concurrent admission；
- 没有宣称 chronology 修复 concurrent snapshot ownership 或 runner 最终 snapshot 与 idle transition 之间的 lost-wake；
- 没有把 V2 durable `seq` migration 偷渡进 V1 compatibility patch；
- 同根的 part ordering、CLI fallback 与 tool retention 已进入测试/代码清单，而不是只修 prompt 一行；
- 方案已由用户确认；生产 DB 对照后的 chronology terminal 修订已完成验证并推送，PR #15 已创建，issue #13 待 PR 合并关闭。
