# 2026-10-27 — #77 包 1：摘要锚定到压缩标记、失败摘要排除、TUI 读数跳过摘要

## 背景

issue #77（fermat CCodeVerify 主会话实测）确认了三个独立缺陷的叠加：压缩摘要重试时挂到最新用户消息导致压缩永远不生效、失败的摘要尝试残留在模型上下文、TUI 把摘要请求当成当前上下文。issue #62/#76/#46 相关项不在本包。#83/#84（oversized session 渐进恢复）另开子计划。

分支：`fix-compaction-summary-anchor`（基于 dev `d9d7de31fb`），commit `3a333d27ec`。

## 改动

### 1. 摘要挂到压缩标记所在消息（根因 1）

- `message-v2.ts` `latest()`：tasks 从裸 `CompactionPart | SubtaskPart` 改为 `{ part, message }`，携带任务所在的 user 消息 info。
- `prompt.ts` 压缩臂：`compaction.process({ parentID: task.message.id })` 取代 `lastUser.id`。摘要进行中人/子 agent/watchdog 消息进入不再抢走 parentID；重试天然复用原标记。

### 2. 失败/取消的摘要不进入模型上下文（根因 2）

- `filterCompacted()` 主循环：`summary && (!finish || error)` 的 assistant 直接跳过（不计入 result，不参与 retain 段切分）。转录仍完整保留，TUI 可查。
- `filterCompacted()` 重排段：summaryIndex 的匹配加 `finish && !error` 约束——挂错消息的旧摘要（即使成功）也不会被当作标记的结算。

与 `completedCompactions()`（compaction.ts）和 restoration 的 settled 谓词同款：`summary && finish && !error && parentID 指向标记`。至此四处判定（filterCompacted 主循环、filterCompacted 重排、completedCompactions、restoration）全部一致。

### 3. TUI 上下文读数跳过 summary assistant（根因 3）

三处同改：`routes/session/index.tsx` `contextUsage()`（Agents 列表 + footer 共用）、`feature-plugins/sidebar/context.tsx`、`component/prompt/index.tsx`。判定条件 `!item.summary`；纯摘要会话显示空读数而非摘要请求的输入规模。

## 有意不做（本包边界）

- **`small: true`（丢弃 reasoning variant）**：用户要求先讨论，未实施。数据支持做（22:41 那次摘要输出 21 万字符推理、23.5 分钟全在推理通道），但 `smallOptions()` 对 GLM 类 provider 返回首个 variant 或 `{}`，语义是"小模型选项"而非"低推理强度"，直接复用可能改变 temperature/store 等其它参数；更干净的做法是给 `StreamInput` 加独立的 `reasoningEffort`/`reasoning: false` 通道。留待包 2（摘要请求预算设计）一并处理。
- **TUI"压缩后待更新"占位文案**：空读数已消除误导（显示 0/无），占位文案属 UX 打磨。
- **core `packages/core/src/session/compaction.ts`**：V2 路径，产品主路径（CLI/TUI）零消费者（CLAUDE.md 已知限制），不动。
- **#83/#84 渐进摘要恢复**：需先过 §4 设计三阶段（chunked summarization、checkpoint 持久化、无进展失败状态），另开子计划。

## 关键决策

1. **重试不新建挂载点**：锚定 task.message.id 后，摘要失败 → 下轮 loop 的 tasks 仍含同一 compaction part → 重试仍指向原标记。无需新增"重试在原标记上进行"的代码路径——原机制在锚定修复后自然成立。
2. **失败摘要的排除点选在 filterCompacted 而非压缩序列化**：filterCompacted 是所有模型投影的入口（主循环、压缩 estimate、压缩序列化输入都经过它），单点排除覆盖全部读方；只改 compaction.ts 的 serialize 会漏掉主循环请求。
3. **`latest()` 返回形状变更**：tasks 是内部 API（仅 prompt.ts 消费），改形状成本低于新增平行字段；两个既有测试断言随之更新。

## 验证

- 定向：compaction 66 pass / 0 fail（×4 稳定）、message-v2 45 pass、prompt 98 pass / 0 fail、tui subagent-list-members 38 pass（含 2 个新 #77 用例）。
- typecheck：全仓 turbo typecheck 干净（含 tui，强制全量）。
- 已知 flake（与本改动无关）：prompt.test 与 compaction.test 的 timeout 类用例在共享机高负载下偶发超时（3 文件组合 6 次出现 2 次失败：`shell rejects when another shell is already running`、`loop persists a second provider context overflow after one recovery` 等，全部 >5s timeout 类）。dev 基线复现同样失败（dev 上 prompt.test 单跑也出现 1 fail），与 2026-10-20 devlog 记录的"prompt.test 负载贴限类"同型。两文件直接组合（compaction + message-v2）3 次全绿。
- 端测（commit `5996d5a82f`，2026-10-27 追加）：两个走真实 prompt loop + fake LLM server 的 wire 级回归，均在修复前代码上验证 RED、修复后 GREEN：
  1. **跨 run 重锚定**（真正的 #77 窗口）：run 1 的摘要请求被 cancel → arm 以 stop 退出、task 仍 pending；更新的用户消息到来触发 run 2 重消费 task。修复前摘要挂在最新消息上、标记永不结算（RED：settled summaries 数为 2 且 parentID 不带压缩标记）；修复后锚定 task 宿主消息、压缩生效（后续请求不含旧历史、无第二次压缩）。
  2. **失败摘要排除**：摘要请求以 length finish（error finish）终结 → 该 attempt 留在转录但被 settled 集合排除；重试 run 的摘要请求只序列化旧历史（old-history 请求数恰为 2），失败 attempt 的部分文本不再进入任何请求。
- 关键测试机制发现（花了一轮探针才确认）：`compaction.create` 会新建一条 user 消息承载 compaction part；同 run 内 willOverflow → create → 下一轮迭代消费时 `lastUser` 就是该新消息（此刻锚定正确）。**真正的偷锚窗口是跨 run 的**：task 消费后 run 退出，更新消息到来触发新 run 消费 pending task，此时修复前的 `lastUser.id` 指向新消息。首版测试把"摘要进行中插入消息"写成同 run 窗口，修复前也 GREEN——RED 验证是必须的，不跑就会把无效测试当回归保护。
- 摘要以 length finish 终结时留下的 assistant 是 error finish（OutputLengthError），与 cancel（AbortedError）同属"unsettled"集合——两个测试都按 settled（finish && !error）计数，与 filterCompacted/completedCompactions 的谓词一致。

## 度量

| 指标           | 数值                          |
| -------------- | ----------------------------- |
| 新增代码行数   | +66                           |
| 修改代码行数   | （含在上行内，总 66/-13）     |
| 删除代码行数   | 13                            |
| 涉及文件数     | 7（opencode 2 src + 1 test，tui 3 src + 1 test） |
| 新增测试用例数 | 2（TUI contextUsage summary 用例）；message-v2 3 处断言更新 |
| 测试通过率     | 定向 277/277（211 组合 + 38 tui + 28 稳定复跑），flake 类失败 dev 基线同现 |
| 发现 bug 数    | 0（新增）                     |
| 修复 bug 数    | 3（#77 三根因）               |
| 迭代轮次       | 实现 1 轮 + 端测 1 轮（探针归因跨 run 窗口） |

## 经验教训

（待回写 CLAUDE.md 的条目）

- `latest()` 这类"返回任务列表"的 API，task 与其宿主消息分离返回（裸 part）会诱使调用方用 `lastUser` 兜底——上下文锚定信息应在数据形状里显式携带，而不是靠调用方重新推导。
- 同一业务判定（"摘要已结算"）在本仓库有四处实现（filterCompacted ×2、completedCompactions、restoration），改动其中任何一处必须 grep 同款谓词全部对齐，否则出现"一处认结算、一处不认"的分裂行为。
- prompt.test / compaction.test 的 timeout 类用例是共享机负载敏感的既有 flake 源（devlog 2026-10-20 已记录）；验证时区分"改动文件组合稳定绿"与"大组合偶发 timeout"，后者用 dev 基线同跑对照归因，不直接算改动引入。
