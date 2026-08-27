# 修正方案 — SessionProcessor 周期性工具调用死循环检测

- 状态：Issue #20 范围修复完成；核心实现、135/135 定向回归、权限文档与最终审核已完成；settlement 后完整 lifecycle replay 记录为独立 follow-up；GitHub issue 回复待用户另行确认
- 日期：2026-08-27
- 对应问题：[#20 Periodic tool-call cycles bypass doom-loop detection](https://github.com/lihaokun/opencode/issues/20)
- 工作分支：`fix/issue-20-periodic-doom-loop`
- 影响模块：`packages/opencode` SessionProcessor、内部 doom-loop detector、processor/permission 回归测试、权限说明文档
- workflow 路径：`docs/workflow.md` §7 bug-fix flow + §7.1 八部分修正方案
- 修复分类：算法内部逻辑错误，并同步扩展既有 `doom_loop` 行为契约；不修改公共 API、permission schema 或数据库 schema

本修复只处理有界周期性工具调用绕过。总工具调用预算、非周期扰动检测、稳定 key 排序 JSON canonicalization 和无条件中止策略均为独立增强，不混入本次修改。

---

## 第一部分：现象与复现

### 1.1 可见现象、触发条件、影响范围与频次

当前 detector 只识别连续三次完全相同的工具调用：

```text
A A A
```

provider 可以在同一个活动 stream 中反复输出相邻项不同、整体周期稳定的调用：

```text
A B A B A B ...
A B C A B C A B C ...
```

每个调用都可以是合法的 normalized `tool-call`，并可以正常完成。因为任意相邻三项并不全部相同，当前 detector 永远不会请求 `doom_loop` permission。只要 provider 不发出 `step-finish`，processor 会继续消费该 stream。

触发条件：

1. 调用序列具有基本周期 `p > 1`；
2. 同一长度为 `p` 的 block 至少完整重复三次；
3. provider stream 在重复期间保持活动；
4. 每次调用能被正常规范化为 `tool-call`；
5. 相邻调用不同，因此当前周期 1 detector 不命中。

影响范围：

- AI SDK 与 native runtime 最终都进入同一个 normalized event processor，因此两条路径都受影响；
- 不依赖 plugin、message chronology、incomplete-stream recovery 或 StructuredOutput；
- 可导致无限工具执行、额外费用、持续外部副作用以及 Session 长时间保持 busy；
- 当前没有通用的单 provider stream 工具调用总数上限可以兜底。

周期 2–10 在修复前实现中稳定漏检。周期 1 仍会在第三次相同调用时触发。

### 1.2 已完成的 Processor 集成复现

2026-08-27 先在本分支用 deterministic normalized stream 验证当前错误行为，随后把同一 fixture 改成期望 `doom_loop` request 的永久红测，并在 commit `2d6a2e178` 中提交、推送。

事件序列：

```text
step-start
lookup({query:"a"})  call-a1
search({query:"b"})  call-b1
lookup({query:"a"})  call-a2
search({query:"b"})  call-b2
lookup({query:"a"})  call-a3
search({query:"b"})  call-b3
step-finish(tool-calls)
finish(tool-calls)
```

所有 call ID 均唯一，每个 `tool-call` 后紧跟成功 `tool-result`。运行命令：

```bash
bun test --cwd packages/opencode \
  --timeout 30000 \
  --only-failures \
  --max-concurrency 4 \
  test/session/processor-effect.test.ts \
  -t "issue 20 reproduction"
```

初始复现断言错误行为时结果为：

```text
1 pass
42 filtered out
0 fail
```

它确认修复前：

- `SessionProcessor.process()` 返回 `"continue"`；
- 六个 tool parts 全部进入 `completed`；
- 第六次调用没有被默认 `doom_loop: ask` 阻塞；
- 唯一 call ID 不影响结果，因为 detector 不比较 call ID。

随后把 fixture 固化成期望 `doom_loop` request 的永久红测；在未修改生产代码时，该测试按预期失败：

```text
0 pass
42 filtered out
1 fail
error: timed out waiting for periodic doom-loop permission
```

该红测保留正确预期，不通过修改断言来适配生产缺陷。

### 1.3 可直接运行的算法级最小复现

以下命令等价模拟当前 `processor.ts` 的最后三项判断，可在仓库任意目录运行：

```bash
node <<'NODE'
function currentDetector(calls) {
  const parts = []
  const hits = []
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i]
    parts.push(call)
    const recent = parts.slice(-3)
    if (
      recent.length === 3 &&
      recent.every(
        (part) =>
          part.tool === call.tool &&
          JSON.stringify(part.input) === JSON.stringify(call.input),
      )
    ) hits.push(i + 1)
  }
  return hits
}

const a = { tool: "lookup", input: { query: "a" } }
const b = { tool: "search", input: { query: "b" } }
console.log("period-1", currentDetector([a, a, a]))
console.log("period-2", currentDetector([a, b, a, b, a, b]))
NODE
```

当前输出：

```text
period-1 [ 3 ]
period-2 []
```

### 1.4 出错代码路径

```text
SessionPrompt.runLoop
  → packages/opencode/src/session/prompt.ts SessionProcessor.create
  → packages/opencode/src/session/processor.ts process
  → LLM.Service.streamBatches
  → handleEvent(normalized tool-call)
  → ensureToolCall
  → updateToolCall(status="running")
  → MessageV2.parts(current assistant message)
  → slice(last 3 persisted parts)
  → compare every part against current tool + JSON.stringify(input)
  → optional Permission.ask("doom_loop")
```

修复前关键位置：

- `packages/opencode/src/session/processor.ts:30`：`DOOM_LOOP_THRESHOLD = 3`；
- `packages/opencode/src/session/processor.ts:362-414`：`tool-call` event 与 detector；
- `packages/opencode/src/session/message-v2.ts:496-507`：读取当前 assistant message 的全部 persisted parts；
- `packages/opencode/src/permission/index.ts:67-107`：`Permission.ask()`；
- `packages/opencode/src/agent/agent.ts:119-136`：默认 `doom_loop: "ask"`。

### 1.5 预期行为与实际行为

| Case                          | 当前实际行为                           | 修复后预期行为                              |
| ----------------------------- | -------------------------------------- | ------------------------------------------- |
| `A A A`                       | 第 3 次调用请求 permission             | 保持不变                                    |
| 周期 10 完整重复 2 次         | 不触发                                 | 不触发                                      |
| 周期 10 完整重复 3 次         | 不触发                                 | 第 30 次调用请求 permission                 |
| 第三轮改变一个 input          | 不触发                                 | 对应周期 streak 重置，不触发                |
| 非周期交错调用                | 不触发                                 | 不触发                                      |
| 每次使用唯一 call ID          | 周期 1 仍可触发，周期 >1 漏检          | call ID 不参与，周期检测正常                |
| 预存历史中已有相同 tool parts | 查询并参与 detector                    | 不参与；只使用 active processor-local state |
| 每次 tool-call 检查           | 查询并 hydrate 当前 message 全部 parts | `O(MAX_PERIOD)` 固定工作、固定内存          |

---

## 第二部分：根因分析

### 2.1 根因 A：把“重复调用”错误建模为周期 1

当前谓词等价于：

```text
s[n] = s[n-1] = s[n-2]
```

它只证明最后三个长度为 1 的 block 相同。对任意 `p > 1` 的序列，即使最后三个长度为 `p` 的 block 完全相同，只要 block 内相邻项不同，当前谓词就恒为 false。

因此问题不是阈值 3 太小，也不是 permission 响应错误，而是 detector 的状态模型缺少候选周期维度。

### 2.2 根因 B：检测状态错误地依赖持久化 message parts

当前每个 `tool-call` 都执行：

```ts
MessageV2.parts(ctx.assistantMessage.id)
```

该函数查询、排序并 hydrate 当前 assistant message 的全部 parts，之后 detector 才取最后三个。由此产生：

- 单次检查成本随 message parts 数量增长；
- detector 依赖数据库读取，而不是 active stream processor 的事件状态；
- text、reasoning、step、patch 等非 tool part 位于末尾时会打断检测；
- detector 的真实状态边界由持久化布局偶然决定，不是“本 active processor 已观察到的工具调用序列”。

Issue #20 明确要求 detector state 保留在 active processor，不能在每次调用时加载完整 persisted part history。

### 2.3 根因 C：输入签名未预计算

当前 `.every()` 中重复执行：

```ts
JSON.stringify(part.state.input)
JSON.stringify(input)
```

即使只检测周期 1，也会反复序列化历史输入。扩展到多个候选周期时若继续直接比较对象，会放大无谓工作。

本次根因修复应在每个新调用到达时只生成一次：

```text
signature = JSON.stringify([toolName, normalizedInput])
```

call ID、part ID、时间戳、provider metadata 和 tool result 不进入签名。

### 2.4 症状、根因修复与非目标

以下做法不能消除根因：

- 把连续阈值从 3 调大：仍只检测周期 1；
- 每次从数据库加载更多 parts，再枚举周期：虽然可能识别周期，但仍保留无界历史查询和错误状态边界；
- 把 call ID 纳入周期签名：重复语义调用通常拥有不同 ID，会重新造成绕过；call ID 只用于同一 normalized event 的投递幂等，不参与调用内容等价；
- 检测到后直接 abort：会破坏 intentional polling 的现有 permission recovery 契约。

本次明确不解决：

- 非周期但无限长的工具调用输出；
- 刻意在每轮轻微扰动 input 以绕过周期 detector；
- 总工具调用预算与配置阈值；
- 对象 key 排序后的语义相等；
- provider/tool side effect 的事务回滚或 exactly-once 保证；
- tool result/error settlement 之后，provider 以同一 call ID 重放完整 `tool-input-*` + `tool-call` lifecycle 的全局幂等。该既有生命周期问题需要独立确定 provider 契约、持久化索引与有界状态方案，不能用 processor-lifetime 无界 ID set 混入本修复。

---

## 第三部分：参考实现对照

### 3.1 参考来源

项目 `CLAUDE.md` 当前没有列出 doom-loop detector 的具体参考实现。为满足算法 bug 的独立对照要求，本修复使用两层参考：

1. Issue #20 给出的 bounded-period streak 算法；
2. 测试中的独立 brute-force oracle：直接切出最后三个长度为 `p` 的 block 并逐项比较，不复用 streak 实现。

Oracle 定义：

```text
threeEqualBlocks(sequence, p)
:= len(sequence) >= 3p
 ∧ sequence[-3p:-2p] = sequence[-2p:-p]
 ∧ sequence[-2p:-p] = sequence[-p:]
```

该定义直接表达目标契约，可用于对 optimized detector 做穷举/确定性随机交叉验证。

### 3.2 当前实现与参考算法逐步差异

对输入：

```text
A B A B A B
```

| 新调用位置 | 当前实现比较   | 参考 oracle                   | 首个差异 |
| ---------- | -------------- | ----------------------------- | -------- |
| 1–2        | 不足 3 项      | 不足 `3p`                     | 否       |
| 3          | `A,B,A` 不全等 | 周期 1 不成立，周期 2 尚不足  | 否       |
| 4–5        | 最近三项不全等 | 周期 2 尚未达到三个完整 block | 否       |
| 6          | `B,A,B` 不全等 | `[A,B]=[A,B]=[A,B]`           | **是**   |

首个差异发生在第三个周期 2 block 完成时。当前实现没有表达 `s[n-p]` 与 `s[n-2p]`，因此无法恢复该事实。

### 3.3 streak 算法

对每个候选周期 `p ∈ [1, MAX_PERIOD]`，每个新签名 `s[n]` 更新：

```text
same[p] = n >= 2p ∧ s[n] = s[n-p] ∧ s[n] = s[n-2p]
streak[p] = same[p] ? min(streak[p] + 1, p) : 0
detected = ∃p. streak[p] >= p
```

连续 `p` 个位置满足 `same[p]`，恰好证明最后三个长度为 `p` 的 block 对应元素全部相等。周期从小到大检查，使基本周期优先；例如 `ABAB` 重复三次会先按周期 2 命中，而不是周期 4。

### 3.4 已完成的算法验证

2026-08-27 已用独立脚本验证：

| 输入                     | 结果                 |
| ------------------------ | -------------------- |
| `AAA`                    | 第 3 次，`p=1`       |
| `ABABAB`                 | 第 6 次，`p=2`       |
| 长度 10 block 重复三次   | 第 30 次，`p=10`     |
| 长度 10 block 只重复两次 | 无                   |
| 第三轮改变一个签名       | 无                   |
| 30 个唯一签名            | 无                   |
| `ABAB` 重复三次          | 第 6 次按 `p=2` 命中 |

---

## 第四部分：修复方案

### 4.1 新增内部纯 detector

新增内部文件：

```text
packages/opencode/src/session/doom-loop.ts
```

该文件不进入公共 Protocol、SDK 或配置 schema。建议接口：

```ts
export interface Detector {
  readonly check: (tool: string, input: Record<string, unknown>) => boolean
}

export function create(maxPeriod = MAX_PERIOD): Detector
```

生产常量：

```text
MAX_PERIOD = 10
REPETITIONS = 3
CAPACITY = 2 * MAX_PERIOD + 1 = 21
```

内部状态：

```text
DoomLoopDetectorState
  signatures: fixed-capacity circular array<string | undefined>
  next: next write index
  size: number in [0, CAPACITY]
  streaks: fixed array indexed by p in [1, MAX_PERIOD]
```

类型不变量：

- `signatures` 只保存最近 `min(totalCalls, CAPACITY)` 个签名；
- `size ≤ CAPACITY`；
- `0 ≤ streaks[p] ≤ p`；
- 最新签名可按 offset `0..2*MAX_PERIOD` 从 ring 中读取；
- detector 不保存 input 对象、call ID、timestamps 或 persisted part reference。

### 4.2 签名契约

每次调用只计算一次：

```ts
const signature = JSON.stringify([tool, input])
```

Requires：

- processor 已将非 record 输入规范化为 `{ value: input }`；
- provider tool input 可由 JSON 序列化；这与当前 persisted input 比较前置一致。

Ensures：

- tool name 不同则签名不同；
- 在现有 `JSON.stringify` 语义下 input 不同则签名不同；
- call ID、part ID、时间戳和 metadata 不影响签名；
- 每个新调用只 stringify 一次。

本次不对 object key 排序。`{a:1,b:2}` 与 `{b:2,a:1}` 继续可能得到不同签名，以保持现有输入等价关系。稳定 JSON canonicalization 若需要，应独立修改契约和测试。

### 4.3 ring buffer 与 streak 更新

`check()` 顺序：

1. 生成新签名；
2. 写入固定容量 ring；
3. 对 `p=1..MAX_PERIOD` 更新 `same[p]` 和 `streak[p]`；
4. 即使较小周期已命中，也继续更新所有周期的 streak，避免 `once/allow` 后较大周期状态失真；
5. 返回是否至少一个周期命中。

伪代码：

```text
push(signature)
detected = false
for p = 1..MAX_PERIOD:
  same = size > 2p
      and latest(0) = latest(p)
      and latest(0) = latest(2p)
  streak[p] = same ? min(streak[p] + 1, p) : 0
  if streak[p] = p: detected = true
return detected
```

使用真正 circular index 或固定容量等价实现，禁止随调用数增长的 array/history。

### 4.4 SessionProcessor 集成

修改 `packages/opencode/src/session/processor.ts`：

1. `ProcessorContext` 增加 `doomLoop: DoomLoop.Detector`；
2. `SessionProcessor.create()` 初始化一个 detector；
3. `tool-call` 通过 `ensureToolCall()` 取得当前 active part，并记录该事件是否是该 call ID 首次从 `pending` 进入正式调用；
4. 规范化 input，并把当前 part 更新为 `running`；
5. 同一 active call ID 在 result/error 前的重复投递不追加 detector 签名；首次投递调用：

   ```ts
   if (!firstDelivery || !ctx.doomLoop.check(value.name, input)) return
   ```

6. 不保留 processor-lifetime seen-ID history，确保 Issue #20 引入的检测状态继续保持固定容量；
7. 命中后沿用现有 `agents.get()` 和 `permission.ask()`；
8. 删除 `MessageV2.parts()` detector 查询；
9. 若 `Database.Service` 在该文件不再有其它用途，删除 import、captured service 与 node dependency。

状态生命周期：

- 新 assistant message 创建新 `SessionProcessor`，detector 从空状态开始；
- 同一 `Handle.process()` 内部的 provider retry 复用同一个 active processor context，因此 detector state 保留；
- detector 不读取上一个 assistant message，也不从数据库恢复；
- active call settle 后由既有 `settleToolCall()` 删除 call map entry；不额外保存无界 ID history；
- `process()` attempt 开始时不重置 detector，因为 retry 仍属于同一个 active processor，且旧实现 persisted parts 同样跨 retry 可见。

### 4.5 Permission 行为保持

以下调用保持不变：

```ts
permission.ask({
  permission: "doom_loop",
  patterns: [value.name],
  sessionID: ctx.assistantMessage.sessionID,
  metadata: { tool: value.name, input },
  always: [value.name],
  ruleset: agent.permission,
})
```

兼容语义：

- `allow`：detector 命中后继续；
- `ask`：产生 pending permission；
- `once`：当前调用继续，周期仍持续时后续调用可再次询问，与周期 1 现行为一致；
- `always`：只批准当前工具名的 `doom_loop` pattern；多工具周期中的其它工具仍可能按既有 per-tool permission 语义询问；
- `deny/reject`：维持现有 halt 和 cleanup 行为。

不新增 `period` metadata，避免改变 permission payload 和 UI 契约。若未来希望按整个 cycle 一次性批准，应作为独立 permission 设计。

### 4.6 非工具事件的处理

ring 只在 normalized `tool-call` 时追加签名。`tool-result`、text、reasoning、step 和 patch 不进入序列。

因此 detector 的对象是：

```text
active processor 观察到的工具调用子序列
```

而不是 persisted part 的最后若干项。这是 issue 要求的明确行为变化：非 tool parts 不再偶然打断工具周期检测。

### 4.7 总工具调用预算作为独立 follow-up

本次不增加 stream-level tool-call ceiling。该能力需要先确定：

- 默认阈值与是否可配置；
- 达到阈值后使用 permission、terminal error 还是 abort；
- intentional high-volume tool use 的兼容策略；
- provider-executed tool 已发生 side effect 时的终态；
- 与 `agent.steps`、retry 和多 step stream 的计数边界。

Issue #20 的周期 detector 可以独立关闭当前已确认的绕过；budget 另开 issue/修正方案。

### 4.8 第一部分复现经过修复后的执行

```text
call 1..4
  → 尚不足三个完整 period-2 block
  → detector=false

call 5: lookup(a)
  → 对 p=2，只有一个连续对应位置满足 triple equality
  → streak[2]=1
  → detector=false

call 6: search(b)
  → 对 p=2，连续两个位置均满足
  → streak[2]=2=p
  → detector=true
  → Permission.ask("doom_loop", pattern="search")
```

默认 `ask` 下 processor 在第六个 tool-call 已写成 `running` 后等待 permission，不再无条件消费后续 stream。

---

## 第五部分：正确性论证

### 5.1 关键假设

- H1：`LLM.Service.streamBatches()` 保持 normalized event 顺序；同一 batch 内 processor 以 `concurrency: 1` 串行处理。
- H2：调用 `check()` 前 input 已规范化，且其 JSON 序列化对同一 JS value 是确定的。
- H3：`MAX_PERIOD=10` 是本修复明确保证的检测上界；更长周期不在保证范围内。
- H4：目标契约是最后三个完整 block 相同，而不是推断 provider 意图或证明未来仍会继续循环。

### 5.2 Ring 历史不变量

容量为 `2M+1`，其中 `M=MAX_PERIOD`。检查最大周期 `M` 时只需读取：

```text
s[n], s[n-M], s[n-2M]
```

最远 offset 为 `2M`，因此容量 `2M+1` 足够。每次覆盖最旧项不会删除任何当前或未来一次检查仍需要的签名。

### 5.3 streak 不变量

对每个 `p`，处理完位置 `n` 后：

```text
streak[p]
= min(p, 从 n 向前连续满足 s[i]=s[i-p]=s[i-2p] 的位置数)
```

建立：历史不足 `2p+1` 时 `same=false`，`streak=0`。

保持：

- 若当前位置 triple equality 不成立，连续后缀长度为 0，赋值 0 正确；
- 若成立，连续后缀比上一位置增加 1；`min(...,p)` 只截断 detector 已不需要区分的更大值。

### 5.4 Soundness：命中必有三个相同 block

若 `streak[p]=p`，则最后 `p` 个位置中的每个位置 `i` 都满足：

```text
s[i] = s[i-p] = s[i-2p]
```

逐位置组合后得到：

```text
sequence[-p:] = sequence[-2p:-p] = sequence[-3p:-2p]
```

因此 detector 不会在最后三个长度为 `p` 的 block 不相同时因该周期误报。

### 5.5 Completeness：三个相同 block 必命中

若最后三个长度为 `p` 的 block 相同，则最后 `p` 个位置逐项满足 triple equality。无论此前 `streak[p]` 为何，这 `p` 次连续更新都会使其达到 `p`，因此在第三个 block 结束时命中。

### 5.6 周期 1 兼容性

当 `p=1`：

```text
same[1] = s[n]=s[n-1]=s[n-2]
streak[1] >= 1
```

第三个相同调用到达时立即命中，与当前 `DOOM_LOOP_THRESHOLD=3` 行为一致。持续相同调用时 detector 继续返回 true，因此 `once/always` 的后续语义不被弱化。

### 5.7 有界资源

每次调用：

- 一次 `JSON.stringify([tool,input])`；
- 固定 `MAX_PERIOD` 次 triple comparison；
- 固定容量 ring 写入。

复杂度：

```text
时间 O(MAX_PERIOD) = O(10)
空间 O(MAX_PERIOD) = 21 signatures + 10 streak counters
```

不再查询或 hydrate persisted parts，调用数增长不会增加 detector 内存或单次数据库工作。

### 5.8 生命周期与无回归

- detector 属于单个 `SessionProcessor.create()` context，不跨 assistant message 污染；
- 内部 retry 保留 detector state，与旧 persisted-history 可见性方向一致；
- tool part 的 pending/running/completed/error 状态机不改；
- permission action、payload 和 UI reply flow 不改；
- public config、schema、SDK、database 和 provider event schema 不改；
- stable-key canonicalization、tool-call budget 和强制 abort 不被偷偷引入。

因此修复消除周期检测根因，同时把行为变化限制在“更多真实周期进入既有 doom-loop permission gate”和“删除 detector 的 persisted-history 查询”。

---

## 第六部分：测试用例清单

所有 provider/processor 集成测试使用现有 fake `LLM.Service` 与本地 Effect layer，不访问真实 provider。

| 类型            | 文件 / 计划用例                                            | 用例描述                                                                         | 状态（修复后回填）                                                 |
| --------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 回归/集成       | `test/session/processor-effect.test.ts` — period-2 fixture | 固化第一部分真实 Processor 复现；第 6 次唯一-ID 调用产生 `doom_loop` ask         | 已加并通过                                                         |
| 兼容/集成       | 同文件 — period 1                                          | 第三个相同调用仍在原时机产生 ask                                                 | 已加并通过                                                         |
| 权限/集成       | 同文件 — allow/deny/ask                                    | allow 继续、deny terminal、ask pending；permission payload 保持 `{tool,input}`   | 已加并通过                                                         |
| 生命周期/集成   | 同文件 — persisted history isolation                       | 预存 message tool parts 不参与新 processor detector；active processor 内调用参与 | 已加并通过                                                         |
| 回归/unit       | `test/session/doom-loop.test.ts` — period 10               | 第 30 个调用命中                                                                 | 已加并通过                                                         |
| 边界/unit       | 同文件 — two repetitions                                   | 两轮不触发                                                                       | 已加并通过                                                         |
| 边界/unit       | 同文件 — changed input                                     | 第三轮一个 input 改变使对应 streak 重置                                          | 已加并通过                                                         |
| 误报/unit       | 同文件 — non-periodic interleaving                         | 非周期调用不触发                                                                 | 已加并通过                                                         |
| 基本周期/unit   | 同文件 — divisor                                           | `ABAB` 三轮按最小周期 2 命中                                                     | 已加并通过                                                         |
| ID 隔离/集成    | processor fixture 使用唯一 call IDs                        | call ID 不进入签名                                                               | 已加并通过                                                         |
| 投递幂等/集成   | 同文件 — active replayed call ID                           | 同一 active logical call 在 result 前重复投递三次只计数一次                      | 已加并通过                                                         |
| 序列化兼容/unit | 同文件 — reordered object keys                             | 保持现有 `JSON.stringify` 语义，不把 key 重排视为相同                            | 已加并通过                                                         |
| ring 边界/unit  | 同文件 — wrapped noisy prefix                              | ring 覆盖旧值后仍在第三轮 period-10 的最后一个调用命中                           | 已加并通过                                                         |
| Oracle/property | 同文件 — optimized vs brute-force                          | 对小 alphabet 的穷举序列及确定性生成序列逐步对照 oracle                          | 已加并通过                                                         |
| 资源/静态       | `processor.ts` dependency audit                            | 删除 detector 对 `MessageV2.parts`/`Database.Service` 的依赖；ring 固定容量      | 已核对                                                             |
| 回归            | `test/session/processor-effect.test.ts` 全文件             | processor settlement、overflow、permission、tool cleanup 无回归                  | 47/47 通过                                                         |
| 回归            | `test/permission/next.test.ts`                             | permission allow/deny/ask/once/always 生命周期不变                               | 79/79 通过                                                         |
| 类型            | `packages/opencode` typecheck                              | 新 detector 与 processor context 类型正确                                        | 通过                                                               |
| 文档构建        | `packages/web` build                                       | 18 份 permission 文档可由 Astro 正常解析并构建                                   | 通过（仅既有主题 override warnings）                               |
| 全量回归        | `packages/opencode` 全量                                   | 检查受影响范围外的整体基线                                                       | 3383 pass；7 fail + 2 errors（MCP/HttpApi 等无关测试，未宣称全过） |

实施顺序：

1. 先加 pure detector 红测和 processor period-2 红测；
2. 在未修改生产代码时运行并记录预期失败；
3. 实现 detector；
4. 跑 unit + processor 定向测试；
5. 补 permission/lifecycle/oracle 矩阵；
6. 跑受影响文件和 typecheck；
7. 最后根据成本决定是否运行 `packages/opencode` 全量，并诚实分类任何基线失败。

计划命令：

```bash
bun test --cwd packages/opencode \
  test/session/doom-loop.test.ts \
  test/session/processor-effect.test.ts

bun test --cwd packages/opencode test/permission/next.test.ts
bun run --cwd packages/opencode typecheck
```

不得修改或删除正确的失败测试来适配生产缺陷。

---

## 第七部分：代码更新清单

| 文件                                                      | 函数 / 位置                                                  | 改动概述                                                                                     | 状态（修复后回填）                                                    |
| --------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `packages/opencode/src/session/doom-loop.ts`              | 新内部 detector                                              | 固定容量 ring、周期 1–10 streak、单次签名计算                                                | 已实现：`47c46b134`                                                   |
| `packages/opencode/src/session/processor.ts`              | `ProcessorContext`、`create`、`tool-call` handler、node deps | 接入 processor-local detector；删除 persisted parts 查询；active replay 不重复计数           | 核心：`47c46b134`；`14e2cfa2a` 无界 set 已废弃；最终修正：`d67297528` |
| `packages/opencode/test/session/doom-loop.test.ts`        | 新 unit suite                                                | 直接回归、oracle 交叉验证、序列化兼容                                                        | 已新增：`47c46b134`；9/9 通过                                         |
| `packages/opencode/test/session/processor-effect.test.ts` | normalized stream/permission integration                     | period-1/2、唯一 ID、active 重复投递、permission allow/deny/ask、history isolation           | 基础矩阵：`5fc4787dd`；最终有界修正：`d67297528`；47/47 通过          |
| `packages/opencode/test/permission/next.test.ts`          | 既有 suite                                                   | 只运行回归；除非发现真实契约缺口，否则不修改                                                 | 未修改，79/79 通过                                                    |
| `packages/web/src/content/docs/permissions.mdx`           | `doom_loop` 描述                                             | 从连续同一调用扩展为最多周期 10 的三轮重复序列；保留周期 1 说明                              | 已改：`aab2fc06e`                                                     |
| `packages/web/src/content/docs/*/permissions.mdx`         | localized exact-rule lines                                   | 同步不再把规则描述为仅“同一调用连续三次”；保持各 locale 既有语言                             | 已同步 17 个 locale：`aab2fc06e`                                      |
| `docs/fixes/session-processor-fix-periodic-doom-loop.md`  | 本文                                                         | 修复后回填测试、代码状态和 commit                                                            | 已完成最终回填                                                        |
| `docs/devlog/2026-08-27-periodic-doom-loop-detection.md`  | 新开发日志                                                   | 记录实现、决策、测试和规定的度量表                                                           | 已新增；收尾 commit                                                   |
| `CLAUDE.md`                                               | 已知限制与注意事项                                           | 回写经验：连续相等 guard 不能覆盖有界周期；stream guard 应使用 processor-local bounded state | 已本地回写；受 `.git/info/exclude` 排除，未强制公开                   |

明确不修改：

- `packages/core` permission schema；
- public Protocol、HttpApi、SDK/generated clients；
- database schema/migrations；
- provider adapters/native runtime；
- `agent.steps` 与 max-step prompt；
- tool execution semantics；
- stream-level tool-call budget。

---

## 第八部分：文档更新清单

本修复改变公开 `doom_loop` 触发契约，因此不能写“无文档更新”。

| 文档路径                                                 | 要改什么                                                        | 状态（修复后回填）         |
| -------------------------------------------------------- | --------------------------------------------------------------- | -------------------------- |
| `docs/fixes/session-processor-fix-periodic-doom-loop.md` | 八部分根因、方案、证明、测试和实施状态                          | 已完成最终回填             |
| `packages/web/src/content/docs/permissions.mdx`          | 明确连续重复是周期 1；长度不超过 10 的完整序列重复三轮也会触发  | 已改：`aab2fc06e`          |
| `packages/web/src/content/docs/*/permissions.mdx`        | 同步 localized exact trigger 说明，避免翻译继续宣称只支持周期 1 | 已同步：`aab2fc06e`        |
| `docs/devlog/2026-08-27-periodic-doom-loop-detection.md` | 记录关键决策、测试结果和 `## 度量`                              | 已新增；收尾 commit        |
| `CLAUDE.md`                                              | 已知限制与注意事项回写本次经验教训                              | 已本地回写；文件被 exclude |
| GitHub issue #20                                         | 实施完成后回复根因、算法边界和测试证据                          | 待用户另行确认后执行       |

无需同步：

- `docs/design` / `docs/research`：仓库目前没有 doom-loop detector 的 feature 架构或子计划契约；本次是既有实现的内部算法修复；
- `docs/audits/*/expectations.md`：本修复不属于新增子计划；
- App permission description：现有“Detect repeated tool calls with identical input”仍是正确的概括，不承诺仅连续调用；
- Agents 文档：现有“Recovery prompts when an agent appears stuck”保持准确；
- generated SDK/client：无 schema/API 变化。

---

## 反模式自检与实施 gate

- 不通过提高连续阈值掩盖周期缺失；
- 不继续读取完整 persisted parts 作为 detector state；
- 不把唯一 call ID 纳入签名；
- 不把 stable-key JSON canonicalization 偷渡进本次兼容修复；
- 不把 intentional polling 无条件 abort；
- 不把总工具调用 budget 与周期 detector 混成同一阈值；
- 不只写 period-2 example，必须用独立 oracle 验证 optimized detector；
- 不在较小周期命中后跳过其它 streak 更新，避免 permission `once/allow` 后状态失真；
- 不重置内部 retry 仍应共享的 active processor detector state；
- 不修改 permission allow/deny/ask/once/always 的既有语义；
- 生产代码实施前必须先得到本文确认，并先运行红测证明当前缺陷。
