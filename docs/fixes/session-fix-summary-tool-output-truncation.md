# 修正方案 — 摘要输入的头尾保留与退出码（P0-3 / issue #46）

> 流程：workflow §7。状态：**已实施**（commit `fc071384f2`，2026-10-12）。
> 关联：`docs/research/runtime-alignment-research.md` §3.3 / §4.3 / §7 决议 #6（D① 抽 core helper）；复用 P0-1 的 `formatExitCodeLine`（`packages/core/src/session/tool-result-projection.ts`）。

## 第一部分：现象与复现

**现象。** 压缩时，`serialize` 对每个 completed 工具结果整体取前 2,000 字符（opencode `compaction.ts:30,51-52,78`；core `compaction.ts:14` 与其 `truncate` 同款），且从不读取 metadata：

1. 通用工具（read/grep/glob/MCP——`truncate.ts:89` 的 `direction` 默认 head 且无调用点覆盖）的全文路径与继续读取 hint 在预览**尾部**，超 2,000 字符即被切掉 → 摘要后全文入口永久消失；
2. shell 的尾部 `<shell_metadata>` 诊断（超时/中断说明）被切掉；
3. 非零退出码（metadata.exit）在摘要输入中不可见（P0-1 只修了重放路径）。

必现（大输出工具的常态，非边缘情况）。UI 不受影响；全文文件另有 7 天清理（`truncate.ts:12`，本修复不含，记为 F 设计输入）。

**最小复现（将固化为单元测试）。** 构造 >2,000 字符的 completed 工具输出，尾部为 `...(Results truncated...)\nFull output saved to: /path/x`。摘要投影现状：尾部（含路径行）丢失；修复后：输出含头部片段 + 尾部片段（路径行在内）+ 截断标记。

**出错代码路径。**

1. `packages/opencode/src/session/compaction.ts:78` — completed 分支 `truncate([output, ...attachments].join("\n"))`，头切
2. `packages/core/src/session/compaction.ts` — 工具分支 `[Tool result]: ${truncate(serializeToolContent(part.state.content))}`，同款头切
3. 两处均不读取 metadata（exit 无通道）

**预期 vs 实际。** 预期：摘要输入保留头部上下文 + 尾部诊断/全文入口 + 非零退出码；实际：只有头部 2,000 字符。

## 第二部分：根因分析

- **根因**：serialize 的截断是**单侧头切**，而工具输出的"定位信息"（全文 hint）与"诊断"（shell_metadata）固定位于预览的头部或尾部——单侧截断必然切掉其中一端。这是设计缺口（§2.2 推论 3：serialize 截断 = 模型永久记忆缺失），不是长度参数取值问题。
- **根因消除**：改为"头 + 尾"双侧保留 + exit metadata 行，两套 runtime 同改（§2.3 推论 5）。非绕过：无信息被转移到别处，摘要输入直接变完整。

## 第三部分：参考实现对照

ZCode 摘要输入**无字符截断**（完整 provider messages 直接进摘要 prompt，超窗才按轮次丢弃——`compact-active-helpers.ts:53-66`），因此没有本问题；其工具侧预算（artifact 信封 + 前 2,000 字符预览**含尾部诊断行**）保证了进入历史的文本本身已带定位与诊断。差异理由：fork 的 V1 摘要输入走 serialize 扁平文本（架构不同），不能照搬"无截断"——fork 的摘要输入是序列化文本流，需要自带预算；双侧保留是在该架构下满足同一验收（"摘要后均可找到诊断/原始输出"）的最小改动。

## 第四部分：修复方案

**改什么。**

1. **core helper 扩展**（`packages/core/src/session/tool-result-projection.ts`，决议 D①）：
   ```ts
   export const TOOL_RESULT_SUMMARY_MAX_CHARS = 2_000   // 预算 ≈ 头 1,400 + 尾 600 + 标记
   export function summarizeToolText(text: string): string
   ```
   `text.length <= 2_000` 原样返回；否则 `头 1,400 + \n[... N chars truncated ...]\n + 尾 600`（N = 原长 − 2,000）。纯截断，无 metadata 参数——exit 与 compacted 是 V1 schema 概念，留在 V1 调用点。
2. **opencode serialize（`compaction.ts:66-83`）**：completed 分支改为 `summarizeToolText([output, ...attachments].join("\n"))`，其后追加 `formatExitCodeLine(part.state.metadata)`（非零时，换行拼接）；`time.compacted` 分支维持 `[Old tool result content cleared]` 不变。本地的 `truncate` 常量/函数随使用点清理（`grep` 确认无其他消费后删除）。
3. **core serialize（工具分支）**：`truncate(serializeToolContent(...))` → `summarizeToolText(serializeToolContent(...))`；`[Shell]:` 行的 `truncate` 同步替换（同一问题域）；core 本地 2,000 常量与 `truncate` 删除（grep 确认无其他消费）。
4. **error 分支两侧均不变**（现状不截断，维持）。

**修复后复现走查。**

- ≤2,000 字符结果 → 输出逐字节不变（无 exit 非零时）✓
- >2,000 字符 + 尾部 hint → 输出含头部 1,400 字符、截断标记、尾部 600 字符（含 `Full output saved to:` 行）✓
- shell 长输出 → 头部路径（shell 布局）与尾部 `<shell_metadata>` 双双存活 ✓
- `metadata.exit = 7` → 摘要文本末尾出现 `[exit code: 7]`；exit 0/null → 不出现 ✓
- compacted part → `[Old tool result content cleared]` 不变 ✓

**验收映射**（issue §五第 3 条）：开头为普通日志、结尾为失败原因的长结果——立即返回路径 P0-1 已保证 exit 可见；摘要后：尾部诊断（600 字符窗）+ 全文入口（hint）+ exit 行均可在摘要输入中找到。

## 第五部分：正确性论证

- **根因消除**：单侧头切改为双侧保留，"头部上下文或尾部定位至少丢一个"的结构性缺口关闭；exit 经既有 helper 进入摘要文本。两套 runtime 共用同一 helper，漂移源消除。
- **不变量保持**：≤2,000 时字节级不变（含无 exit 的负例）；error/pending 分支不变；`[Old tool result content cleared]` 不变；摘要请求的下游（buildPrompt 模板、token 估算）输入形状不变，仅长度分布变化。
- **无回归**：core 的格式固化测试 `session-compaction.test.ts:45` 断言 `serializeToolContent` 的**内容块拼接格式**（媒体行 `[Attached image/png: ...]`），本修复不动 `serializeToolContent`，仅其外层截断函数替换——短文本用例预期不变，复跑确认；`session-runner.test.ts` 的压缩集成测试不锁定截断长度（§3.3 已核实）。opencode 侧 `compaction.test.ts` 测 usable/isOverflow/buildPrompt，不触 serialize 内部分支；helper 以新增单元测试覆盖。
- **副作用论证**：纯函数级变更，无共享状态、无外部资源；唯一输出变化发生在摘要请求的输入文本。

## 第六部分：测试用例清单

| 类型 | 用例 | 状态（修复后回填） |
|------|------|------|
| 回归 | >2,000 字符 + 尾部 `Full output saved to:` hint → 摘要文本含头部、标记、尾部与路径行（最小复现固化） | 已加: `summarizeToolText keeps a trailing full-output hint inside the tail window` @ `fc071384f2` |
| 新增 | ≤2,000 字符 → 输出逐字节不变 | 已加: `results within budget byte-identical`（1,999/2,000 两档）@ `fc071384f2` |
| 新增 | 截断标记包含省略字符数；头 1,400 / 尾 600 精确切片 | 已加: `retains head and tail with an omission marker` @ `fc071384f2` |
| 新增 | exit 非零 → 摘要文本含 `[exit code: N]`；exit 0/null → 不含（V1 调用点组合行为） | 已加: `formatExitCodeLine renders only finite non-zero exits`（helper 直测）+ V1 调用点两行胶水（组合行为经 message-v2 既有用例覆盖 helper 语义）@ `fc071384f2` |
| 新增 | compacted → `[Old tool result content cleared]` 不变 | 已加: V1 调用点分支保持原 ternary，compaction/prompt 套件回归通过 @ `fc071384f2` |
| 新增 | attachments join 后整体参与头尾切分 | 已加: 调用点 `[output, ...attachments].join` 后整体进 helper（切片测试以合成文本覆盖等价行为）@ `fc071384f2` |
| 端到端 | **全链**：真实 `processCompaction`，>2,000 字符工具结果（尾部 hint + exit 7）→ **捕获的摘要请求载荷**含 HEAD_MARKER、`[... 1084 chars truncated ...]`、`Full output saved to: /tmp/tool_x`、`[exit code: 7]`，且中段不在 | 已加: `compaction.test.ts > summary input keeps head, tail hint and non-zero exit for a long tool result` @ `ed32817a65` |
| 已有 | core `session-compaction.test.ts`（含 :45 格式固化）+ `session-runner.test.ts` 压缩集成 + opencode `compaction.test.ts` 全量复跑 + 双包 typecheck | 已复跑: core 1102/1102（含格式固化与 runner 集成）、opencode session 目录 619/619、双包 typecheck 干净 |

V1 serialize 的 completed 分支是 layer 闭包内联代码，组合行为（exit + compacted + attachments）以"helper 单元测试 + 调用点两行胶水"覆盖，不为胶水单独搭 layer harness（与 P0-1/P0-2 的覆盖口径一致）。

## 第七部分：代码更新清单

| 文件 | 函数 / 位置 | 改动概述 | 状态（修复后回填） |
|------|------------|---------|------|
| `packages/core/src/session/tool-result-projection.ts` | 新增 `summarizeToolText` + `TOOL_RESULT_SUMMARY_MAX_CHARS` | 头尾双侧保留（头 1,400 / 尾 600 / 标记） | 已改: `fc071384f2` |
| `packages/opencode/src/session/compaction.ts` | serialize completed 分支（:66-83） | 改用 helper + 追加 exit 行；清理本地 truncate/常量 | 已改: `fc071384f2` |
| `packages/core/src/session/compaction.ts` | 工具分支与 `[Shell]` 行 | `truncate` → `summarizeToolText`；清理本地 truncate/常量 | 已改: `fc071384f2` |
| `packages/core/test/session-compaction.test.ts` | 新增 helper 单元测试 | 第六部分清单落地 | 已加: `fc071384f2` |

## 第八部分：文档更新清单

| 文档路径 | 要改什么 | 状态（修复后回填） |
|---------|---------|------|
| `docs/research/runtime-alignment-research.md` | §7 决议 #6 实施回填 | 已改: 实施记录见 devlog `docs/devlog/2026-10-12-session-fix-summary-tool-output-truncation.md` |
| `docs/devlog/` | P0-3 实施日志（含度量） | 已加: `docs/devlog/2026-10-12-session-fix-summary-tool-output-truncation.md` |
| 无 schema/枚举/接口契约文档 | 新契约（头尾保留比例、截断标记格式）权威记录为本文第四部分 | 无（+理由） |

**实施中发现的新问题（记录，不在本修复内）**：core V2 的模型回放（`to-llm-message.ts:46`）包含 `state.structured` 通道，但其 serialize 只序列化 `state.content` 块——V2 摘要输入丢失 `structured` 数据，与 P0-2 同族。需先核实 V2 工具状态中 structured 的填充方与 bash 的 exit 落点，单独立项处理。
