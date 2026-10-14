# 修正方案 — 每轮 summary 把工作区所有改动文件的全文 patch 写进消息和事件表，撑爆内存与数据库

- 模块：`session` / `summary`（每轮改动摘要），`snapshot`（工作区快照 diff）
- 分类：§7 step 2 第二类（设计缺陷：派生数据被物化进消息，再被 durable 事件逐次复制；无上限）
- 状态：已实施（待提交）
- 来源：上游代码（`git blame` 全部为 `opencode-agent[bot]`），上游 open issue #43551 #42748 #48641 #46833 #50089 #48616；fork 放大了触发条件

## 第一部分：现象与复现

**现象**：本机 opencode 两次被 `earlyoom` 杀掉（10 月 9 日 09:58 RSS 43 GB；10 月 11 日 19:40 RSS 47 GB），
均为 `~/ccv-verify/mceliece` 实例，均发生在子 agent 一次 `rocq compile` 之后几分钟。`opencode-dev.db` 达 52 GB。

**实测时间线**（10 月 11 日，本地时间）：

| 时间 | 事件 |
|---|---|
| 19:36:02 | earlyoom：可用内存 33.7 GB |
| 19:36:17 | 根会话 `ses_f0d514ec…` 一条 user message 被重写，**单条 249 MB** |
| 19:36:53 | 日志最后一行：子 agent 发起 `rocq compile`，此后进程无日志 |
| 19:38:00 | 可用内存 16.7 GB |
| 19:40:36 | 子会话 `ses_ed695fa0…` 一条 user message 被重写，**也是 249 MB** |
| 19:40:58 | 可用内存 6.4 GB（< 10% 阈值），earlyoom SIGTERM，4 秒后 SIGKILL |

**249 MB 消息的内容**：`info.summary.diffs`，1264 个文件、244 MB patch 文本。其中大头是
`proof/vst/_tw0_logs/*.log`——被提交进仓库的 rocq 日志（1392 个被跟踪文件，主树 506 MB，每个 worktree 285 MB），
每次编译重新生成，于是每轮的快照 diff 把它们全部收进来。

**数据库**（52.5 GB）：

| 表 | 体量 | 说明 |
|---|---|---|
| `event.data` | 44.65 GB | 其中 `message.updated.1` 727,763 条 **41.14 GB**；`message.part.updated.1` 1,676,960 条 3.33 GB |
| `part.data` | 1.74 GB | |
| `message.data` | 1.47 GB | 63 条 > 1 MB 共 1.21 GB；最大单条 249.1 MB |

**复现条件**：开启快照（默认），一轮内工作目录有大量/大体积文件变动（编译产物、日志、解包）。必现，体量与变动文件总大小成正比。

**最小复现**（固化为第六部分 R1）：建一个 git 工作区，快照 A；写入一个 1 MB 以上的文件；快照 B；对一条带
`step-start.snapshot=A` / `step-finish.snapshot=B` 的 user message 调 `summarize`。预期消息里只有文件名与计数；
实际整条消息膨胀到与文件同量级。

**出错代码路径**

- `packages/opencode/src/session/prompt.ts:1409`：每轮 `summary.summarize(...)` fork
- `packages/opencode/src/session/summary.ts:102-127` `summarize` → `computeDiff` → `snapshot.diffFull(from, to)`
  → `target.info.summary.diffs = 全量 patch` → `sessions.updateMessage(target.info)`
- `packages/opencode/src/snapshot/index.ts` `diffFull`：`git diff --numstat` 之后用 `git cat-file --batch` 把所有改动文件
  的前后全文读进内存，再用 `structuredPatch(..., { context: Number.MAX_SAFE_INTEGER })` 生成 patch——**patch 含文件全文**
- `packages/schema/src/v1/session.ts:494-503`：`message.updated` 是 durable 事件，整条消息（含 summary）再写一份进 `event` 表
- 消息随后经事件总线推给 TUI（无界 SSE 队列），TUI 再解析一遍；run loop 每一步 `filterCompactedEffect` 重新读取整个会话

**预期 vs 实际**：预期"每轮改了哪些文件、各多少行"是几十字节一行的元数据；实际是工作区所有变动文件的全文副本，
且每次 `message.updated` 再复制一份。

## 第二部分：根因分析

**症状**是内存和数据库膨胀；**根因是把派生数据物化进了消息**。

patch 完全由两个快照 hash 决定（`step-start.snapshot`、`step-finish.snapshot` 两个 part 已经持久化），随时可以重算。
把它写进 `summary.diffs`，就让一条消息的体量等于"这轮工作区变动文件的总大小"；而 `message.updated` 是 durable 事件，
每次写这条消息，事件表就多一份完整副本；事件再经 SSE 推给每个客户端、客户端再解析。同一份派生数据在内存里要过
序列化、落库、事件、推送、解析五遍，在磁盘上则随更新次数线性复制。

第二层原因：patch 用 `context: Number.MAX_SAFE_INTEGER` 生成，等于把文件全文塞进 patch；且没有任何大小上限。

**放大因素**（不是根因，但解释了为什么是我们先撞上）：fork 的 agent 树（197 个子会话、177 个 worktree）让多个会话
同时收尾、同时做 summary；agent 又把编译日志提交进了仓库，每轮 diff 都是几百个 MB 级文件。

**不是 fork 引入的**：涉及的每一行都来自上游，上游有 6 个 open issue 描述同一问题；三个修复 PR（#48245 加上限、
#49715 写 session 级统计、#50106 不把 summary 复制进 durable 事件）均被关闭未合并。

## 第三部分：参考实现对照

另外两个 agent 都没有这个问题，因为它们的记录里**从不存整个工作区的 patch**：

| | Claude Code（一手文档 checkpointing） | ZCode（`zai-org/ZCode` 源码） | opencode（修复前） |
|---|---|---|---|
| 跟踪范围 | 只跟踪 Claude 自己编辑工具改的文件；"Bash command changes not tracked" | `fileChangeTracker`：只记 agent 写文件工具产生的 before/after | 整个工作目录的 git 快照 |
| 存什么 | 文件快照，与会话分开存；保留最近 100 个 checkpoint，30 天清扫 | 按轮存 before/after 内容进 session JSON；git checkpoint 只存元信息（"仅用于撤销编排"） | 全文 patch 直接写进 user message，再被 durable 事件复制 |
| diff 何时算 | — | 展示时由 `buildPerTurnChangeSummaries` 从 before/after 现算；`diffCheckpoints` 现场跑 git | 每轮预先算好存着 |

共同点：记录里只留事实（哪些文件、多少行），内容按需取。本方案向这个形态靠拢，同时**保留**整工作区快照
——那是回滚 bash 造成的改动所必需的能力，另外两家没有。

上游三个被关闭的 PR（已读其 diff）与本方案的差别：

| | #48245 | #49715 | #50106 | 本方案 |
|---|---|---|---|---|
| 消息里存什么 | 仍存 patch，总量 256 KB / 单文件 64 KB 截断 | 不变（全量 patch） | 不变（全量 patch）；只在 durable 事件表的表示里剥掉 summary | **只存文件名与计数**，不存 patch |
| patch 从哪来 | 消息里（被截断的） | 消息里 | 本地投影有 patch；回放时按快照 hash 重算 | 请求 `diff()` 时按快照 hash 重算，单文件 1 MB / 整次 8 MB 上限 |
| 重复写 | 清理同一消息被覆盖的旧 `message.updated` 事件 | — | `isDeepStrictEqual` 相同则不写；按消息串行 | 相同则不写；按消息串行并**合并**（一个在跑、一个在等、其余返回） |
| session 级统计 / 事件 | — | `setSummary` + 发全量 diff | `setSummary` + 发空列表 | `setSummary` + 发 stat 清单 |
| 改动面 | summary、session | summary | summary、session、`core/event.ts`（durable 变换表） | summary、snapshot；不碰事件层 |

关键差别在第一行：三个上游 PR 都保留"patch 存进消息"这个前提，再在其上截断、去重或改事件表示；本方案去掉这个前提，
后面几项问题随之消失，所以不需要动事件层。代价是第四部分写明的 7 天保留期。

## 第四部分：修复方案

### 1. `Snapshot.diffStat(from, to)`：只要计数，不读内容

从 `diffFull` 拆出前半段：`git diff --name-status` + `git diff --numstat` + ignore 过滤，返回
`{ file, additions, deletions, status }`。不跑 `cat-file`，内存里不出现任何文件内容。`diffFull` 复用同一段取行，
后半段（读内容、生成 patch）不变。

### 2. `summarize` 改存 `diffStat`

```
summary.diffs = [{ file, additions, deletions, status }, ...]   // 没有 patch
```

`FileDiff.patch` 在 schema 里本来就是可选字段（`packages/schema/src/file-diff.ts`），所以**不改 schema、不重新生成 SDK**。
顺带把上游 #49715 想做的事做了：按本轮聚合 `files / additions / deletions` 写进 session 级 summary，`session.diff` 事件
带上这份清单（修复前发的是空数组，TUI 侧栏的 "Modified Files" 因此一直是空的）。两处语义都是**最近一轮**；
`revert` 路径向同一事件发的是回滚区间的全量 diff，两个生产方语义不同，以事件最后一次为准，这是既有约定。

文件名经 `unquoteGitPath` 还原后再存、再发：git 对含引号、反斜杠、控制字符的路径做 C 引号转义，修复前存储行是转义形式、
接口返回是还原形式，按文件名做 key 的客户端会看到两个文件。现在存储、事件、接口三处一致。

**同一消息的多次 summarize 合并为一次写入。** processor 每个 step-finish 都排一个 summarize，attempt 结束时一起 fork，
下一次 run 的第一步再排一个——一轮 N 步就是 N+1 次。现在按消息串行：一个在跑、最多一个在等、其余直接返回
（等的那个读到的终态一样）；算出来的 stat 与消息里**已存的** stat 相同（且已存行不带 patch）就不写。"从未写过"不等于
"写过空清单"：一轮没改任何文件时，第一次写入的空清单正是把 session 计数清零、把侧栏清空的那一步，不能跳。每次写都是
一条 durable 事件，没有新信息才不写。效果：一轮无论多少步，消息最多写一次（上游 #50106 的去重思路）。

### 3. `SessionSummary.diff`（`GET /session/:id/diff`）按需计算

找到这条 user message 及其 assistant 回复，取两个快照 hash，调 `diffFull`。只有客户端打开 diff 视图时才算，
结果直接返回，不落库、不广播。拿不到 hash（快照关闭、历史消息无 step part）时退回存储的 `summary.diffs`，
因此旧消息里已有的 patch 仍能看到，缺 file / 缺 patch 的旧行照常返回（既有测试覆盖）。

### git 失败不是"没有改动"

`git()` 辅助函数把子进程错误吞成 `code=1, text=""`，修复前 `diffFull` 对此视而不见，返回空列表。现在 `changes` 检查两条
git 命令的退出码，失败即 `Snapshot.DiffError`：`diffStat` 把错误抛给调用方，`summarize` 收到后只记日志、**不写**
（下一步的 summarize 会重试）；`diffFull` 保持原契约，记日志后返回空列表。否则一次瞬时的 git 失败会把"这轮没改任何文件"
写进消息、清零计数。

### 不带 messageID 的 `diff()`

TUI 打开会话时不带 messageID 调 `session.diff` 来填侧栏文件列表，修复前这种调用固定返回空数组，所以侧栏只在在线
收到事件时有内容、重开会话就空。现在不带 messageID 返回**最近一条 user message 存的 stat**（文件名与计数，不算 patch），
与 `session.diff` 事件的"最近一轮"语义一致。OpenAPI 描述文本未改（它被嵌进生成的 SDK，改一句要整套重生成），留到下次
SDK 重生成时同步。

### 按需计算的保留期

快照树由 `git write-tree` 写入快照仓库，不挂任何 ref；`Snapshot.cleanup` 定期 `git gc --prune=7.days`，7 天前的快照树
会被回收。因此 **7 天以上的历史轮次重算不出 patch**，`diff()` 退回存储值，diff 视图只显示文件名和增删行数。修复前
patch 存在消息里，任何时候都能看；这是本方案有意接受的取舍（Claude Code 的 checkpoint 保留 100 个 / 30 天，同一性质）。
嫌短可以调 `snapshot/index.ts` 的 `prune` 常量，与本修复无关。

### 4. `diffFull` 加每文件上限与整次上限

`git cat-file --batch-check` 先问各 blob 大小，任一侧超过 `patchFileLimit`（1 MB）的文件不读内容，`patch` 留空、计数照给，
防止 #48616 那种在生成文件上挂死。batch-check 整条失败时大小未知，这次 diff **全部只给计数**并记日志——git 不正常时不读它读不了的东西。另外一次 diff 产出的 patch 累计超过
`patchTotalLimit`（8 MB）后，其余文件只给计数，并且不再读后续块的内容：事故那轮 1264 个文件均值 193 KB，
没有一个会触顶，没有总量上限的话打开 diff 视图仍会拼出 244 MB 响应。块内逐行判定，超出量不超过一块（100 个文件）。
快照本身只收 2 MB 以下的文件（`limit`），所以每文件上限实际作用于 1–2 MB 区间。两个常量从 `Snapshot` 导出，测试引用而不复制数字。

### 消费方核对（修复前逐一查过）

| 消费方 | 读什么 | 影响 |
|---|---|---|
| TUI diff 视图 `diff-viewer.tsx` | `client.session.diff()` | 走按需路径，拿到的 patch 与修复前相同 |
| TUI 侧栏 `sidebar/files.tsx` | `session.diff` 事件 → `session_diff` | 从"永远为空"变为有文件名与计数 |
| 桌面端 `packages/app` | `message.summary.diffs[].patch` | 已做缺失判断（`utils/diffs.ts`、`server-compat.ts`、`session-message.ts`）；新消息无内嵌 patch，需改走接口（fork 不发布桌面端，不在本次范围） |
| `cli export` | `summary.diffs[].patch` | 已做缺失判断 |
| 既有测试 `session-diff-missing-patch`、`httpapi-session` | 缺 patch / 缺 file 的行 | 行为不变 |

### 修复后的预期行为（走第一部分的时间线）

19:36:17 那次重写：消息里 1264 行 `{file, +, -, status}`，约 100 KB；durable 事件同量级；SSE 推送同量级；
run loop 每步解析的也是这个量级。19:36–19:40 之间不再有 GB 级分配。

### 考虑过并否决的方案

**A. 只给 patch 加总量上限（上游 #48245）。** 否决：仍然每轮物化、仍然进事件表，只是把爆点推后；上限数值武断。

**B. 把 patch 搬到旁表（上游 #42748 建议）。** 否决：每轮仍要把 244 MB 算出来写一遍，内存峰值不变，只是不再被事件复制。

**C. durable `message.updated` 事件剥掉 summary（上游 #50106）。** 不单独做：summary 变小后它不再是问题；
剥字段会让事件回放与投影不一致，引入新的契约。

**D. 改成只跟踪 agent 自己编辑的文件（CC / ZCode 的范围）。** 否决：会失去对 bash 改动的回滚能力，那是快照机制存在的理由。

## 第五部分：正确性论证

1. **根因消除**：patch 不再被物化进消息；消息里只剩与文件个数成正比的元数据。派生数据回到"按 hash 现算"的位置，
   每轮的计算只剩 git 自己做的 numstat（不把内容读进我们的进程）。durable 事件、SSE、会话加载的体量随之同比下降，
   不需要各自再修。

2. **不变量保持**：
   - `summary.diffs` 的语义不变：仍是"这轮改了哪些文件、各多少行、增删改"；`file / additions / deletions / status`
     四个字段与修复前取值相同（同一条 numstat / name-status）。`patch` 本就可选。
   - `GET /session/:id/diff` 的响应形状不变：仍是 `FileDiff[]`，有 patch；TUI diff 视图不感知差别。
   - ignore 过滤不变：`diffStat` 与 `diffFull` 共用同一段取行逻辑，被忽略文件在两边同样不出现。
   - `session.diff` 事件 payload 类型不变（`FileDiff[]`），只是从空数组变为有内容。
   - 旧数据：没有 step part 的历史消息退回存储值；缺 file / 缺 patch 的行按既有测试的约定返回。
   - 每文件上限只作用于按需路径的 patch 字段，计数不受影响；上限内的文件 patch 与修复前逐字节相同。
   - 行为上唯一的让步：超过快照保留期（7 天）的轮次只剩文件名与计数，见第四部分"按需计算的保留期"。
   - 一次 diff 视图请求的响应有界：≤ `patchTotalLimit` + 一块的超出量；每轮 summarize 至多写消息一次。
   - 存储行、事件、接口三处文件名一致（均已还原 git 引号）。

3. **无回归引入**：
   - `diffFull` 既有测试（status 判定、新增文件 patch、大批量混合 diff、ignore / info-exclude）不改，须全部通过。
   - `snapshot-tool-race` 测试走的是 `summary.diff()`，修复后它经按需路径取到非空结果，覆盖了 TUI 的真实调用链。
   - 不改 schema、不改 HttpApi，SDK 与 TUI 零改动。

## 第六部分：测试用例清单

| 类型 | 用例 | 状态 |
|---|---|---|
| 回归 R1 | 快照间写入 > 1 MB 文件，`summarize` 后消息 `summary.diffs` 不含 `patch`，file / 计数正确；消息 JSON 体量与文件大小无关 | 已加 `test/session/summary.test.ts` |
| 新增 N1 | `Snapshot.diffStat` 返回 file / additions / deletions / status，无 patch；与 `diffFull` 的计数一致 | 已加 `test/snapshot/snapshot.test.ts` |
| 新增 N2 | `diffFull` 对超过 1 MB 的文件：patch 为空、计数保留；小文件 patch 不变 | 已加 `snapshot.test.ts` |
| 新增 N3 | `summary.diff()` 按需重算出带 patch 的 diff，内容与 `diffFull` 一致（TUI 路径） | 已加 `summary.test.ts` |
| 新增 N4 | `summarize` 后 session 级 summary 为本轮聚合，`session.diff` 事件带文件清单 | 已加 `summary.test.ts` |
| 新增 N5 | 没有快照 hash 的消息：`diff()` 退回存储的 `summary.diffs` | 已加 `summary.test.ts` |
| 新增 N6 | 12 个各 800 KB 的文件：前若干个有 patch，之后只给计数，计数不受影响，累计 patch < 总上限 + 一行超出 | 已加 `snapshot.test.ts` "total limit" |
| 新增 N7 | 同一消息并发 6 次 + 事后 1 次 summarize ⇒ `message.updated` 恰好 1 次，存储行正确 | 已加 `summary.test.ts` "writes the message once" |
| 新增 N8 | 文件名含 `"` ⇒ 存储行与接口都是还原后的名字（非 Windows） | 已加 `summary.test.ts` "real file name" |
| 新增 N9 | 不带 messageID：空会话返回空；两轮后返回第二轮的 stat，无 patch | 已加 `summary.test.ts` "latest turn's names and counts" |
| 新增 N10 | 上一轮改了文件、下一轮无改动：第二轮写入空清单，session 计数归零，事件为 `[1, 0]` 两次，重复 summarize 不再发 | 已加 `summary.test.ts` "no changes resets the counts" |
| 随机 P1–P3 | §5.3 第三层：12 组种子随机变更集（增/改/删、1/10 概率超过 1 MB）。P1 `diffStat` 与 `diffFull` 去掉 patch 后逐行相等（含顺序）；P2 patch 为空 ⇔ 任一侧超过上限；P3 未超限文件的 patch 里 `+`/`-` 行数等于 git numstat 的计数（与参考实现交叉验证） | 已加 `snapshot.test.ts` "random change sets" |
| 随机 P4–P5 | 8 组随机轮次：存下的 diffs 等于 `diffStat`、无 patch、消息 JSON 体量 < 400 + 300 × 文件数（与文件大小无关）、session 级聚合正确、`diff()` 的计数一致且 patch 为空 ⇔ 超限、`diff()` 不回写、`summarize` 幂等 | 已加 `summary.test.ts` "random turns" |
| 随机 P6 | 6 组随机多轮会话（每轮 1–4 轮、每轮 1–4 文件）：不带 messageID 的 `diff()` 等于最后一轮的 stat；带 messageID 的等于各自那轮的 stat | 已加 `summary.test.ts` "random multi-turn sessions" |
| 既有 | `snapshot.test.ts` 全部、`snapshot-tool-race`、`session-diff-missing-patch`、`httpapi-session` | 跑通 |

## 第七部分：代码更新清单

| 文件 | 位置 | 改动 | 状态 |
|---|---|---|---|
| `packages/opencode/src/snapshot/index.ts` | `diffFull` | 拆出取行逻辑（`changes` / `refsOf`）；新增 `diffStat`；`cat-file --batch-check` 每文件上限（失败记日志）；整次 patch 总量上限；导出 `patchFileLimit` / `patchTotalLimit` | 已改 |
| 同上 | `Interface` / `Service.of` | 暴露 `diffStat`（错误通道 `DiffError`）；`changes` 检查 git 退出码 | 已改 |
| `packages/opencode/src/session/summary.ts` | `summarize` / `summarizeOnce` | 存 `diffStat`（文件名已还原）；相同则不写；按消息串行合并；聚合写 session 级 summary；`session.diff` 事件带清单 | 已改 |
| 同上 | `diff` | 按需 `diffFull`，无 hash 时退回存储值；不带 messageID 返回最近一轮的 stat | 已改 |
| `packages/opencode/test/snapshot/snapshot.test.ts` | 新用例 | N1 / N2 | 已改 |
| `packages/opencode/test/session/summary.test.ts` | 新文件 | R1 / N3 / N4 / N5 | 已加 |
| `packages/opencode/test/session/processor-effect.test.ts` | Snapshot 桩 | 补 `diffStat` 桩 | 已改 |

## 第八部分：文档更新清单

| 文档 | 要改什么 | 状态 |
|---|---|---|
| 无设计文档 | 该模块是上游代码，fork 没有为它写过设计文档；对外契约（schema、HttpApi）未变，`FileDiff.patch` 保持可选 | 无需改 |
| 本文档 | 作为修复记录与上游 PR 的依据 | 本文 |

## 审核记录

- **§5.2 五维度自审**：一致性（与本文第四部分逐项对照）、风格（AGENTS.md：无 else、const、helper 下沉、无别名/星号 import）、
  正确性（回退三分支：快照被 prune / 无 step part / 旧行）、性能（每轮 summarize 从 3 个 git + 若干 cat-file + 全文 patch
  降为 3 个 git 进程；按需路径多 1 个 batch-check）、可维护性（`turn` / `snapshots` / `changes` / `refsOf` 拆分）。
- **独立审核（subagent，只给文档 + diff，再自行核对代码）**：❌ 0 项；⚠️ 5 项及处置：
  1. 按需响应无总量上限 → **已修**（`patchTotalLimit`，N6）。
  2. 每步一次 summarize、同一消息 N+1 次写 → **已修**（按消息串行 + 相同不写，N7）。
  3. 存储/事件未还原 git 引号、与接口不一致 → **已修**（三处统一 `unquote`，N8）。
  4. `batch-check` 失败静默放弃上限 → **已修**：先改为记日志，二审指出仍会读全文，再改为失败时整次只给计数（无单元测试：该路径需让 git 命令失败而其余正常，不可用不打桩的方式驱动，按代码审视确认）。
  5. `oversized` 一次喂全部 refs、不像 `load` 按 100 分块 → **接受**：每个 ref 只回一行约 60 字节，千个文件约 60 KB，
     分块没有收益。
  二审另提：侧栏重开会话后清单消失 → **已修**（不带 messageID 返回最近一轮的 stat，N9）。
  三审（用户复现）：去重把"从未写过"当作空清单，无改动的一轮不清零计数、不清侧栏 → **已修**（只在已存 stat 相同时跳过，N10）。
  随机测试 P6 曾在本机间歇失败（16 次 1 次；并行加压后 40 次内 2 次）。带上诊断信息后抓到原因：**本机 WSL 的时钟会向后跳**
  （journald 48 小时内 14 条 "Time jumped backwards"），测试用 `Date.now()` 给消息打 `time.created`，一次后跳让后建的轮次拿到更早的
  时间戳和更小的 ascending id，在按创建时间排序的存储里排到了前面，于是"最近一条 user message"不是最后建的那条。
  这是测试取时钟的问题，不是补丁的问题：测试改为用计数器给消息计时后，并行加压 30 次 0 失败。
  顺带发现一个独立问题：`Identifier.create` 的"ascending"只在 `currentTimestamp !== lastTimestamp` 时重置计数器，时钟回拨时 id 会倒退，
  消息存储顺序随之错乱，这台机器上的真实会话也会受影响——与本修复无关，另记。
  上一段提到的"git 失败不是没有改动"加固保留：它防的是另一类真实问题（空输出被当成无改动写入）。
- **测试分层（§5.3）**：基本（R1、N1、N3、N4、N9）、边缘（N2、N5–N8）、随机（P1–P6，种子化，与 git numstat 交叉验证）。
  未覆盖：`batch-check` 整条命令失败的分支（需让一条 git 命令失败而其余正常，不打桩无法驱动），按代码审视确认。
  项目未引入 property-based 框架（无 `fast-check`），随机层用种子 PRNG 实现，失败信息带种子可复现；没有自动收缩。
- **全量回归**：`test/session`、`test/snapshot`、`test/server` 三目录 969 用例：942 过、10 跳过、16 失败。
  16 个失败中 14 个为 `httpapi-sdk.test.ts`，在未改动代码上同样失败（本机环境：健康检查 503、文件索引未就绪）；
  另 2 个为并发超时，单跑通过。

## 附：不在本次范围、需单独处理

1. **历史数据**：`event` 表里 41 GB 的 `message.updated.1` 事件和 1.2 GB 的旧消息不会因本修复缩小。需要单独的清理
   （剥掉旧消息 `summary.diffs[].patch`、裁剪被覆盖的事件、`VACUUM`），牵涉 V2 回放语义，另立计划。
2. **shell 工具逐块更新 part**（无节流）与 **SSE 无界队列**：另两个放大器，本次不碰。
3. **mceliece 仓库**：把 `proof/vst/_tw0_logs/` 从跟踪里移出并忽略，是独立于本修复的止血手段。
