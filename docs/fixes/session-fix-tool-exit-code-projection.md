# 修正方案 — 工具退出码投影进模型可见文本（P0-1 / issue #46）

> 流程：workflow §7。状态：**已实施**（commit `896e093b4e`，2026-10-12）。
> 关联：`docs/research/runtime-alignment-research.md` §3.1 / §4.1 / §7 决议 #1-3（B2 读方投影、只标非零、保持成功语义）。

## 第一部分：现象与复现

**现象。** shell（对外工具 id `bash`）命令以非零码退出且无输出时，模型在后续轮次收到的工具结果只有 `(no output)`，无法区分"成功且恰好无输出"与"失败且无输出"。有输出时同样只有 stdout/stderr 文本，退出码缺失。必现；影响所有依赖命令成败状态的后续推理（误判成功后继续执行、语义化退出码信息丢失——`grep` 1=无匹配、`diff` 1=有差异）。UI 不受影响（footer 显示 `bash completed (exit N)`），缺陷只在"给模型"的投影层。

**最小复现（将固化为回归测试）。** 构造 completed ToolPart：`state.output = "(no output)"`、`state.metadata = { exit: 7 }`，经 `MessageV2.toModelMessagesEffect` 转换。现状断言失败：产出文本不含 `exit`；修复后含 `[exit code: 7]`。对照用例 `exit: 0` 不含状态行。

**出错代码路径。**
1. `packages/opencode/src/tool/shell.ts:589` — exit 只写入 `metadata`
2. `packages/opencode/src/session/processor.ts:298-309` — metadata 正常落库（存储完整，非丢失点）
3. `packages/opencode/src/session/message-v2.ts:295-328` — completed 分支只投影 `state.output` + attachments，metadata 除 provider 专用字段外全部丢弃 ← **丢失点**
4. 附带（独立小修）：`packages/opencode/src/session/prompt.ts:684` — `!cmd` 直执行路径丢弃 `handle.exitCode`，metadata 无码可投

**预期 vs 实际。** 预期：非零退出码在下一轮重放的模型消息中可见；实际：不可见。

## 第二部分：根因分析

- **症状**：模型看不到非零退出码。
- **根因**：投影约定"metadata 仅供 UI、正文仅 `state.output`"（research 文 §2.1 推论 1），而 `exit` 是全工具盘点中唯一"模型不可推断且对决策有价值"却被归入 metadata 的字段。这是**约定层缺口**，不是某处代码笔误。
- **根因消除方式**（对应 B2 决议）：在模型可见性的唯一全覆盖点（历史重放投影，native/ai-sdk 共用同一 `prepared.messages`）补上 metadata → 文本的翻译。不改存储结构（schema 无需变更），不在源头拼接文本（B1 会污染 UI 与持久化）。
- 非绕过：状态行成为模型可见契约的一部分，写入修正方案与 research 文 §7，不是临时 hack。

## 第三部分：参考实现对照（ZCode）

ZCode `apps/zcode-cli/packages/core/src/tool/handlers/bash-model-content.ts:50-61`：非语义性非零退出时正文**首行**写 `Exit code N`；语义白名单（`grep`/`rg`/`diff`/`test`/`find` 的特定退出码）不当失败、不标注（`bash-semantics.ts:140-159`）；part 层另有 isError 标记（`tool-result.ts:67-81`）。

逐步对比差异点：

| 维度 | ZCode | 本修复 | 差异理由 |
|---|---|---|---|
| 标注条件 | 非零（白名单豁免） | 非零（无白名单） | 白名单记为**后续增强**（决议 B③ 注），第一期保持机械规则；语义化退出码本就有正文输出可辨 |
| 标注形态 | 正文首行 `Exit code N` | 正文尾部追加行 `[exit code: N]` | opencode 的 output 是既有正文（头部常有 shell 截断提示），尾部追加不改变阅读顺序 |
| 投影位置 | 工具层 `formatModelContent` | 历史重放投影层（message-v2） | opencode 无"同请求内回传"，读方投影是唯一全覆盖点（决议 B2）；工具层拼接会漏 `!cmd` 路径且污染持久化 |
| error 语义 | 部分场景 isError | 保持成功语义 | 决议 B③：避免把 grep/diff 的合法非零误判为故障 |

## 第四部分：修复方案

**改什么。**

1. **新增共享 helper（core，决议 D①）**：`packages/core/src/session/tool-result-projection.ts` 导出 `formatExitCodeLine(metadata: unknown): string | undefined` — 仅当 `metadata.exit` 为有限数字且 `!== 0` 时返回 `` `[exit code: ${n}]` ``，否则 `undefined`。P0-3 的 serialize metadata 行将复用此函数。
2. **`packages/opencode/src/session/message-v2.ts`（completed 分支，:297-328）**：`outputText` 组装后，若 `formatExitCodeLine(part.state.metadata)` 有值，以 `\n` 追加。追加在 `truncateToolOutput` 之后（该参数生产路径不生效，但即便生效状态行也保证不被截）；`time.compacted` 分支（`[Old tool result content cleared]`）不追加。
3. **`packages/opencode/src/session/prompt.ts:684`（`!cmd` 路径）**：metadata 增记 `exit: handle.exitCode`（数值存在时），使该路径与 bash 工具的 metadata 形状一致，从而被同一投影覆盖。

**为什么这样修。** 见第二部分（投影层补翻译缺口）与第三部分（投影位置的对照理由）。

**修复后复现走查。**

- `exit 7` 无输出 → 落库 `metadata.exit=7` → 重放投影 `(no output)` + helper 返回 `[exit code: 7]` → 模型收到两者拼接 ✓
- `exit 0` → helper 返回 `undefined` → 输出与现状逐字节一致 ✓
- 超时/取消（`exit: null`）→ helper 返回 `undefined`（正文已有 `<shell_metadata>` 说明，不重复标注）✓
- `!cmd exit 7` → `prompt.ts` 补记后走同一投影链路 ✓
- 有附件的 completed part → 状态行加在 `outputText` 上，attachments 通道不受影响 ✓

## 第五部分：正确性论证

- **根因消除**：修复不改变任何写入语义（除 `!cmd` 补记——那是使 metadata 形状一致的独立小修），而是在"模型可见文本"这个读方补上既存储状态的翻译；缺口从结构上关闭（任何写 `metadata.exit` 的工具自动受益）。
- **不变量保持**：持久化 schema 零变更；`state.output` 零变更（UI/摘要 serialize 输入不变）；completed 分支在 `metadata.exit` 缺失/为 0/null/非数字时输出与现状**逐字节一致**（负例保证）。
- **无回归**：影响面 = message-v2 completed 分支的条件追加 + `prompt.ts` 一个 metadata 字段。现有 message-v2 测试的 fixture 均未设 `metadata.exit`，不受影响；shell.test.ts 断言在工具层，不经过 message-v2，不受影响。边界说明：本 PR 覆盖**重放路径**；摘要路径的一致性由 P0-3（serialize metadata 行）完成，两 PR 合并后"重放/摘要一致"的验收（issue §五第 1 条后半）才完整。
- **副作用论证**：穷尽——本修复不写任何外部资源、不改共享状态，纯投影层函数级变更。

## 第六部分：测试用例清单

| 类型 | 用例 | 状态（修复后回填） |
|------|------|------|
| 回归 | completed part（`exit:7`, `(no output)`）→ 模型文本含 `[exit code: 7]`；`exit:0` 对照不含（最小复现固化） | 已加: `message-v2.test.ts > tool exit code projection > regression...` @ `896e093b4e` |
| 新增 | `exit:null`（超时/取消）不加状态行 | 已加: 同 describe `null exit...` @ `896e093b4e` |
| 新增 | `metadata.exit` 缺失 / 非数字 → 不加状态行、不抛错 | 已加: 同 describe `missing or non-numeric...` @ `896e093b4e` |
| 新增 | `!cmd` 路径 exitCode 进入 metadata（`prompt.ts` 补记） | 已加: `prompt.test.ts > shell records non-zero exit code in completed metadata` @ `896e093b4e`（该用例同时抓住了实施中"生成器补全值丢弃"的实现 bug，见 devlog） |
| 新增 | compacted part（`[Old tool result content cleared]`）不加状态行 | 已加: 同 describe `compacted parts...` @ `896e093b4e` |
| 新增 | 附件共存时状态行位于 outputText 内、附件不受影响 | 已加: 同 describe `exit line rides in the text...` @ `896e093b4e` |
| 端到端 | **全链**：fake LLM 发起真实 bash 调用 → 进程退出 7 → loop 续跑 → **捕获的第二轮请求体**的 tool 消息含 `(no output)` 与 `[exit code: 7]`；exit 0 对照静默 | 已加: `prompt.test.ts > loop replays a non-zero bash exit code...` / `loop stays silent for a zero bash exit code` @ `ed32817a65` |
| 已有 | message-v2 全量（45 项）+ shell/prompt 相关套件复跑 | 已复跑: message-v2 50/50、prompt.test.ts 99 pass+1 pre-existing skip、test/session/ 610 全过、core 1098 全过、双包 typecheck 干净 |

## 第七部分：代码更新清单

| 文件 | 函数 / 位置 | 改动概述 | 状态（修复后回填） |
|------|------------|---------|------|
| `packages/core/src/session/tool-result-projection.ts` | 新文件 | `formatExitCodeLine` helper | 已改: `896e093b4e` |
| `packages/opencode/src/session/message-v2.ts` | completed 分支（:297-328） | 条件追加状态行 | 已改: `896e093b4e` |
| `packages/opencode/src/session/prompt.ts` | `!cmd` 组装处（:684 附近） | metadata 补记 `exit`（实施中修正：gen 须 `return yield* handle.exitCode`，裸 `yield*` 的补全值会被丢弃） | 已改: `896e093b4e` |

## 第八部分：文档更新清单

| 文档路径 | 要改什么 | 状态（修复后回填） |
|---------|---------|------|
| `docs/research/runtime-alignment-research.md` | §7 决议 #1-3 记录（含决策轮 commit `2b0369e367`）；实施 hash 回填 | 已改: 决议 `2b0369e367` + 实施 `896e093b4e` |
| `docs/devlog/` | 新增 P0-1 实施日志（含度量） | 已加: `docs/devlog/2026-10-12-session-fix-tool-exit-code-projection.md` |
| 无 schema/枚举/接口契约文档 | 新契约即"模型可见文本追加 `[exit code: N]` 行"，权威记录为本文件第四部分；无独立契约文档需要同步 | 无（+理由） |
