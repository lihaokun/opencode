# 细化设计 — 压缩后恢复（compaction-recovery）

> 状态：已实施并随二轮独立复审收敛同步至 HEAD（§4.3–§4.4）。
> 架构依据：`docs/design/compaction-recovery/architecture.md`（已确认）。
> 待核实清单已全部核实（见 §2 复用点，标注 ★）。

## 1. 范围

- 新模块 `packages/opencode/src/session/restoration.ts`（M1 collect / materialize / render / retainedFileVersions）
- 注入入口 `apply`（M2，同文件）
- 装配：`session/prompt.ts` 的 compaction task arm——`compaction.process` 返回 `"continue"` 后内联调用（2026-10-18 复审核意见 B6 修订：初版挂在每 provider step 的 `applyAgentRoster` 之后，被审出每步全量读历史；修订后只在压缩结算点注入一次，快照语义 = 压缩时刻的磁盘状态，同时消除"压缩后模型改文件会重复追加 sentinel part"的初版缺陷）
- 配置：`packages/core/src/v1/config/config.ts` 的 `compaction` struct 增加 `restoration` 子结构
- 测试：restoration 单元测试（collect/materialize/render/retainedFileVersions 纯函数）+ apply 幂等集成测试 + 注入后模型消息可见性测试

不覆盖：roster（既有）、插件契约（非目标）、core V2 runner 路径（V1 主循环专用；V2 摘要丢失 structured 是独立 follow-up）。

## 2. 与已有代码的复用点（待核实清单核实结果）

| 项 | 核实结果 | 复用方式 |
|---|---|---|
| H1 路径字段 ★（2026-10-20 独立审 B5 同步修订） | read → `metadata.display.path` 且仅 `display.type === "file"`（`read.ts:282-316` 目录读取同形 type:"directory"，须过滤）；edit → **`metadata.filediff.file`**（`edit.ts:181-211`——初稿的 `metadata.filepath` 是 permission request 的 metadata 形状，edit **result** metadata 从未含 filepath，按初稿实现 edit 候选恒空） | collect 的候选提取 |
| H3 tail 重建 ★ | `Session.messages({sessionID})` 返回全量 `WithParts[]`（`session.ts:549`）；tail 体量受 preserve_recent 预算（2k~15k token）约束，全量读取后切片成本同阶 | `retainedFileVersions` |
| skill 定位 ★ | skill tool part `metadata: { name, dir }`（`skill.ts:62-65`）；`Skill.Service` 可按 name 解析 `info.location` | materialize 的 skill 正文重读 |
| synthetic part ★ | `{ id, messageID, sessionID, type: "text", text, synthetic: true, metadata }` 经 `sessions.updatePart` + push 入 `userMessage.parts`（`reminders.ts` 在 `agentmgmt-2-run-state` 已退场，本模块独立维护 `RESTORATION_SENTINEL` 与 `markerID` 退役语义） | apply 的写入与去重 |
| config ★ | `compaction` struct（`config.ts:154-185`，含 auto/prune/tail_turns/preserve_recent_tokens） | 新增 `restoration` 子结构 |
| token 估算 | `Token.estimate`（core util，compaction 同款） | materialize/render 的 token 上限 |
| 哨兵常量 | `RESTORATION_SENTINEL = "<!-- opencode:restoration -->"`（`restoration.ts:28`） | 持久化恢复块识别与 G4 退役 |

## 3. 错误处理策略

- **读盘失败（不存在/权限/IO）**：对应候选 → `missing`（带原因），不抛错——G1 的"可诊断降级"。
- **文件超限**：`stat` 估算超过 `file_max_tokens` 对应字节数（按 4 bytes/token 近似）→ 不读全文 → `reference`。
- **skill 名称无法解析 / 主文件缺失**：`missing`。
- **todo 服务失败**：todo 候选整体降级 `missing`，不影响其他候选。
- **apply 顶层**：所有失败在候选级被吸收；`apply` 的 Effect 错误通道为 `never`（实现上 `Effect.catch` 吸收为跳过本轮恢复并 `Effect.logWarning`）——**绝不打断 loop**（接口规约的被调用方责任）。

## 4. 数据结构定义

细化为具体 TS 形状（归属：模块私有，`restoration.ts` 内定义并导出测试用类型）：

```ts
export type RestorationCandidate = { kind: "file" | "skill" | "todo"; ref: string; lastUseSeq: number }
export type RestorationStatus = "inlined" | "reference" | "skipped-duplicate" | "skipped-budget" | "missing"
export type RestorationMaterial = {
  candidate: RestorationCandidate
  status: RestorationStatus
  content?: string   // inlined
  reason?: string    // reference / missing / skipped-budget
}
export type RestorationConfig = {
  enabled: boolean          // 默认 true
  max_files: number         // 默认 5
  file_max_tokens: number   // 默认 4_000
  budget_tokens: number     // 默认 8_000
}
```

Config schema（`config.ts` compaction struct 内追加，全部 optional 带默认值，annotate 描述文案）：

```ts
restoration: Schema.optional(Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  max_files: Schema.optional(NonNegativeInt),
  file_max_tokens: Schema.optional(NonNegativeInt),
  budget_tokens: Schema.optional(NonNegativeInt),
}))
```

函数局部类型（ephemeral，不进本节）：`versions: ReadonlyMap<string, string>`、渲染用的节缓冲。

## 5. 模块细化

### 5.1 retainedFileVersions

- **签名**：`retainedFileVersions(messages: SessionV1.WithParts[]): Map<string, string>`
- **功能描述**：从本次成功摘要之后实际保留的模型历史（`projected.slice(2)`）中提取各文件路径最近一次完整可见 `read` 的源字节 SHA-256 指纹。
- **调用关系**：callers: `restore`（经 `MessageV2.filterCompacted(messages.toReversed()).slice(2)` 提供输入）；callees: `MessageV2.assistantVisible`。
- **实现思路**（分支全覆盖）：
  1. 线性遍历 `messages`，跳过非 `assistant` 或 `!MessageV2.assistantVisible(msg)` 的消息。
  2. 遍历 `msg.parts`，跳过非 `tool`、非 `completed` 或已 `time.compacted` 的 part。
  3. 失效分支：`part.tool === "edit"` 且 `metadata.filediff?.file` 为字符串 → `versions.delete(file)`；`part.tool === "write"` 且 `metadata.filepath` 为字符串 → `versions.delete(filepath)`。
  4. 读取分支：仅当 `part.tool === "read"` 且 `metadata.display?.type === "file"` 且 `display.path` 为字符串时，先清除旧指纹 `versions.delete(display.path)`；若未截断、覆盖全文件（`lineStart === 1 && lineEnd === totalLines`）、含 `sha256` 与 `text`，且 `part.state.output` 仍包含逐行渲染正文（防插件改写输出），才写入 `versions.set(display.path, display.sha256)`。
- **退出覆盖**：纯函数，仅正常返回 `Map<string, string>`；缺指纹、部分读、截断读、被清理或被后续 `edit`/`write` 覆写的路径均不留在 Map 中。
- **循环刻画**：双层线性扫描有限消息数组与有限 parts 数组，无外部 IO，终止显然。
- **正确性论证**（non-trivial）：
  - 前置：`messages` 按时间正序排列，对应模型当前实际可见的保留尾历史。
  - 论证：按时间正序推进，每次对路径 `p` 的 `edit`、`write` 或不完整 `read` 都会立即 `delete(p)`，只有最新一次完整且未被插件改写的 `read` 才会登记源字节 SHA-256（含 BOM 与行尾字节）。因此 `versions.get(p) === sha256(diskBytes)` 成立当且仅当模型在保留区中已经完整看到了当前磁盘字节，杜绝换行差异、删行、清空、覆写或异路径同内容的误去重。
  - 副作用论证：纯函数，无磁盘/状态副作用。

### 5.2 collectCandidates

- **签名**：`collectCandidates(messages: SessionV1.WithParts[], todos: Todo.Info[] | undefined): RestorationCandidate[]`
- **功能描述**：线性扫描产出候选。
- **调用关系**：callers: apply；callees: 无。
- **实现思路**：
  1. 正向遍历全部 parts，维护 `Map<(kind,ref), lastUseSeq>`（seq 用 PartID/单调序号——取 part 的持久化顺序，实现用遍历计数器）
  2. tool completed part 且 `tool === "read"` → `display.type === "file"` 时取 `metadata.display.path`（目录读取过滤掉）；`tool === "edit"` → `metadata.filediff.file`（2026-10-20 B5 同步修订，理由见 §2 H1 行）；`tool === "skill"` → `metadata.name` → skill 候选
  3. `todos === undefined || todos.length > 0` → push todo 候选（固定 ref `"todo"`，lastUseSeq = 最大遍历计数；`undefined` 表示 todo 查询失败以输出 missing 诊断）
  4. Map → 数组，按 lastUseSeq 降序
- **退出覆盖**：纯函数，仅正常返回；metadata 缺字段（如 `display` undefined）→ 跳过该 part（不产生候选）。
- **循环刻画**：线性扫描有限数组，终止显然。
- **正确性论证**：前置：messages 完整、todos 为现状或 `undefined`。每个 read/edit/skill completed part 恰产生至多一个候选（同 ref 后者覆盖前者，保留最近）⇒ 唯一性后置成立；排序键单调 ⇒ "按最近使用排序"后置成立。

### 5.3 materializeCandidates

- **签名**：`materializeCandidates(candidates, versions: ReadonlyMap<string, string>, deps: { fs; skill; todos; cfg; readable? }): Effect.Effect<RestorationMaterial[]>`（deps 以参数传入便于单测）
- **功能描述**：逐候选物化。
- **调用关系**：callers: apply；callees: FSUtil（读盘/stat）、Skill.Service（按 name 定位 location）、Token.estimate。
- **实现思路**（分支全覆盖）：
  1. `todo` 候选 → 若 `deps.todos === undefined` 返回 `missing("todo list unavailable")`；否则 JSON 序列化后经 `include` 申请预算，放不下时返回 todo 专用降级理由（不指向不存在的 todo 读取工具）。
  2. `skill` 候选 → `Skill.Service` 解析 `name` → 失败返回 `missing`；非 `<built-in>` 磁盘技能先 `fs.stat(info.location)`，非文件返 `missing`、字节超 `file_max_tokens * 4` 返 `reference`（不读全文，落实 H5）；再读正文并复核 `Token.estimate`，合格后经 `include` 申请预算（无 tail 比对）。
  3. `file` 候选 → 先查询 `retainedVersion = versions.get(candidate.ref)`；对非保留文件在预算耗尽或达到 `max_files` 时短路返回 `reference`（省去磁盘 IO）；对权限允许且存在的普通文件先 `stat`：若在保留尾且 `size <= MAX_RETAINED_DEDUP_BYTES`（64 KiB，覆盖 `ReadTool` 50 KiB 上限）先读字节比对 SHA-256，命中直接返回 `skipped-duplicate`（早于 `file_max_tokens`/`max_files`/预算耗尽降级）；否则再检查 `file_max_tokens` 字节/token 上限及 `budget.exhausted()` / `budget.fileLimit()` 后经 `include` 申请预算。
  4. 顺序执行，单候选失败被 `Effect.catch` 吸收为 `missing`（错误处理策略 §3）。
- **callee 契约引用**：`FSUtil` read/stat 的错误语义按平台错误处理；`Skill.Service` 解析失败为类型化错误（catch 转 missing）。
- **提前停止**：预算耗尽或达到 `max_files` 后，不再对无保留指纹的剩余候选做 `stat`/`read`，直接标记 `reference`；有保留指纹的候选仍完成哈希去重以避免误报 `Not restored`。
- **循环刻画**：候选有限，逐个处理，终止显然。
- **正确性论证**（non-trivial）：
  - 前置：候选来自 5.2；versions 语义见 5.1。
  - 论证：read 对源字节生成的完整指纹与同路径当前源字节（含 UTF-8 BOM）的 SHA-256 相等，且完整 read 仍可见，才可省略恢复。其余文件按当前权限、大小与预算恢复或说明失败；skill 和 todo 独立处置。
  - 副作用论证：只读（read/stat/skill 解析），无写入。

### 5.4 renderMaterials

- **签名**：`renderMaterials(materials: RestorationMaterial[], cfg: RestorationConfig): string | undefined`
- **功能描述**：预算内合成最终文本。
- **调用关系**：callers: apply；callees: `inlineBudget`（直接计 UTF-16 长度与 `JSON.stringify` 转义长度）。
- **实现思路**：
  1. 过滤：`max_files` 对 file 类 `inlined` 候选取前 N（排序已在 collect 保证按最近）
  2. 组装三节：Files（inlined 的 `### ${clipRef(ref)}` + content 围栏）/ Skills / Todos；reference/missing/skipped-budget 以单行引用形式集中列入 **`## Not restored` 节**
  3. 每个内联项先同时计入原始 UTF-16 长度与 `JSON.stringify` 转义长度（含头部、分节、路径、换行、围栏）。放不下的项成为诊断，后续较小材料仍可装入。令 `B = budget_tokens`、`D = max(128, min(2000, B))`、`maxRaw = (B + D) * 4`、`maxJson = floor(maxRaw * 4 / 3)`；诊断最多 20 条，路径和原因最多各 160 个 UTF-16 单元，超限或超出 `maxRaw`/`maxJson` 时折叠尾部条数。`B <= 0` 直接返回 `undefined`。
  4. 整体无任何节有内容 → 返回 `undefined`
  5. 输出 = `RESTORATION_SENTINEL` 行 + 三节 markdown
- **退出覆盖**：`undefined`（无材料或 `B <= 0`）与文本两种返回。
- **循环刻画**：材料有限，逐个累加，双预算余量单调不增；诊断折叠最多弹出 20 条 → 终止。
- **正确性论证**（non-trivial）：
  - 前置：materials 来自 5.3，状态语义成立。
  - 论证：初始扣除固定头部原始/JSON 长度，各节首次内联时扣除节标题，每次内联再扣除整项原始与 JSON 转义长度，余量始终非负；结合 `restorationBudgetCap(headroom)`（先对 `headroom` 取 `Math.floor`），保证 `text.length <= 3 * floor(headroom)` 且 `JSON.stringify(text).length <= 4 * floor(headroom)`，同时覆盖 `/3` `estimateMessages` 与 `/4` JSON `willOverflow`。
  - 副作用论证：纯函数。

### 5.5 apply（M2 编排）

- **签名**：`apply(input: { sessionID: SessionID; maxBudgetTokens?: number }): Effect.Effect<void>`
- **功能描述**：幂等入口：读配置（`enabled === false` → 直接返回）并按 `maxBudgetTokens` 封顶 `budget_tokens` → 读 messages → 触发判定（仅认已结算 compaction marker）→ 定位最后一个非未结算 marker 的 user message → `retainedFileVersions` → `collect` → `materialize` → `render` → 哨兵去重 → G4 退役旧 sentinel → 条件落库。
- **调用关系**：callers: `prompt.ts` compaction task arm；callees: 5.1-5.4 + Session + Agent + Config + Todo + FSUtil + Skill。
- **实现思路**：
  1. 读 `Config.Service`；`enabled === false` → return；若传入 `maxBudgetTokens`，将有效预算收紧为 `min(baseCfg.budget_tokens, max(0, maxBudgetTokens))`。
  2. `messages = yield* sessions.messages({ sessionID })`（Step P2）。
  3. 触发判定（Step P3）：收集所有已完成摘要 assistant（`summary && finish && !error`）指向的 `settledMarkers`；定位最后一个已结算 compaction marker 下标 `compactionIdx` 及未退役 sentinel 下标/对应 `markerID`；无已结算 marker 或该 marker 已恢复 → return。
  4. `userMessage` = 最后一个非未结算 compaction marker 的 user message（防止未结算的后继 marker 劫持当前恢复目标）。
  5. 读取 `Todo.Service`（非中断失败降级 `undefined`），校验当前 agent + selectedAgent + session 权限与 `external_directory`（POSIX 与 `external-directory.ts` 一致统一替换 `\` → `/`），执行 Step P4 `collectCandidates` 与 Step P5 `retainedFileVersions` + `materializeCandidates`。
  6. Step P6 `renderMaterials` 合成文本；Step P7 若 `text` 与当前载体上未退役的同 `markerID` sentinel 逐字节一致 → return。
  7. Step P8 退役全部既有未忽略 sentinel（就地 `updatePart({ ...part, ignored: true })`）；若 `text` 非空则 `updatePart` 写入新 synthetic text part（带 `metadata: { kind: "compaction_restoration", markerID }`）。
  8. 顶层 `Effect.exit` 吸收失败 → `Effect.logWarning` → return（绝不打断 loop）。
- **退出覆盖**：正常早退（配置关闭 / 无已结算 marker / 已恢复 / 无载体 / 逐字节相同 / 退役后无新正文）+ 落库返回 + 顶层错误吸收；全部返回 `Effect<void>`。
- **循环刻画**：线性扫描 `messages` 与 `parts`（有限数组），无重试循环，终止显然。
- **正确性论证**（non-trivial）：
  - 前置：压缩已在 compaction task arm 结算返回 `"continue"`；`Session`/`Agent`/`FSUtil`/`Config`/`Todo`/`Skill` 服务可用。
  - 论证：`settledMarkers` 谓词与 `MessageV2.filterCompacted` 同源，避免未生效 marker 触发恢复；Step P8 写入前将所有旧 sentinel 就地标记 `ignored: true`，确保跨多次压缩上下文中语义有效恢复块 ≤ 1 份（I1/I4）；`maxBudgetTokens` 由调用方按剩余 headroom 换算自 `restorationBudgetCap`，保证恢复块 `/3` 估值不突破主模型可用窗口（I2）。
  - 副作用论证：仅条件 `updatePart`（退役旧块 + 写入新块）；配置/消息/磁盘/todo/skill 均为只读。

### 5.6 装配（prompt.ts）

在 `packages/opencode/src/session/prompt.ts` 的 `task?.part.type === "compaction"` 分支内、`compaction.process(...)` 返回 `"continue"` 后调用（Step P1）：

1. 重新读取当前最新 user 及其模型 `activeModel`（防摘要期间 steering 切换模型/用户），仅当 `!anchorUser || anchorUser === activeUser.id` 时采用 `task.part.fixed_input_tokens`。
2. 经 `MessageV2.filterCompactedEffect(sessionID)` 取投影历史后，以 `SessionRestoration.withoutRestoration` 排除即将由 Step P8 退役的旧恢复块，避免连续压缩双重计费。
3. 以 `messagesTokens = Math.max(estimateMessages(modelMessages), Token.estimate(JSON.stringify(modelMessages)))` 计算 `headroom = usablePrimary - fixedInputTokens - messagesTokens - 256`，经 `restorationBudgetCap(headroom)` 得到 `maxBudgetTokens` 传入 `SessionRestoration.apply`（同时提供 `Session`/`Agent`/`FSUtil`/`Config`/`Todo`/`Skill` 六项服务，`SessionPrompt.node` 声明全部依赖）。
4. **正确性论证（§4.3.2）**：
   - `restorationBudgetCap(headroom)` 先取 `H = Math.floor(headroom)`、令 `cap4 = Math.floor(H * 3 / 4)` 并求解满足 `B + max(128, min(2000, B)) <= cap4` 的最大 `B`。结合 `renderMaterials` 同时约束 `text.length <= (B + D) * 4` 与 `JSON.stringify(text).length <= floor((B + D) * 4 * 4 / 3)`，无论内容含多少转义字符或 `headroom` 是否为小数，均满足 `Math.ceil(text.length / 3) <= H` 且 `Token.estimate(JSON.stringify(text)) <= H`。
   - `pendingInputStart(messages, current)` 与 `runLoop` 保持同一终止谓词：仅在非摘要、非错误、非 `"tool-calls"`/`"unknown"` 且 `!hasToolCalls` 的 assistant 或 `<= marker` 时间线处停止回溯，确保含 tool calls 的 `finish: "stop"` 轮次不会丢弃 `U1` 及其在途工具结果。
   - `compaction.ts` 在 `budgeted` 时统一扣除 `summaryReserve = min(2048, floor(usablePrimary / 8))`，并在 `rawRequired` 中排除启用恢复时即将退役的旧恢复块；`prompt.ts:1878` 的用量触发压缩同样传递 `fixedInputTokens` 与 `requestUserID`；provider 413 拒绝分支先删除零 part 占位 `handle.message` 再落 marker，保持 `summary.n` 准确。

### 5.7 测试设计

- **单元**（`test/session/restoration.test.ts`）：retainedFileVersions（缺指纹、投影被清理、保留区内完整显示）、collectCandidates（read/edit/skill/去重/排序/todo）、materializeCandidates（临时目录真读盘：missing/reference/duplicate/inlined 四分支 + skill 解析失败）、renderMaterials（预算降级/max_files/空 → undefined/哨兵行）。
- **集成**：`apply` 幂等——构造压缩后 messages，连续调用两次 `apply`，断言仅一个恢复 part 且第二次零写入；触发判定——无 compaction 时零写入。
- **可见性**：恢复 part 写入后经 `toModelMessages` 断言模型消息包含恢复文本（复用 P0 E2E 的驱动方式：压缩 + 下一轮请求捕获）。

## 6. 完整性自检 checklist

- [x] 所有函数实现思路推导连续（5.1-5.5 均为编号步骤，无跳步）
- [x] 所有 if / else / switch 分支已覆盖（materialize 四分支、render 预算降级、apply 六出口、collect 字段缺失跳过）
- [x] 所有退出点已刻画（5.5 六个正常出口 + 异常吸收出口；5.4 的 undefined/文本两态）
- [x] 所有 callee 调用显式引用 pre/post（FSUtil/Skill/Todo/Token/Session 的契约在 §3/§5.3 标注）
- [x] 所有循环有终止性论证（各函数线性扫描，计数单调）
- [x] 所有上游事实显式列出（H1-H5 已核实并标注出处行号；`resource.text` 真值语义等实现层事实在实现思路内注明）

### 摘要输入超限后的保留边界

摘要请求被拒后，以确切缺口或同模型成功请求的实际输入加估值差选择起始档，按可用预算的 5% 逐档增加到 25%。每个更短的候选最多发一次；保留区另受主模型预算和配置约束。成功时使用选定边界进行 restoration；仅最终用尽才报告溢出。见[修复说明](../../fixes/session-fix-summary-overflow-tail.md)。

2026-11-19 全量复核修订：自动重读以前提“当前 agent/session 仍允许 read 与适用的 external_directory，或允许该 skill”为准。文件去重仅依据当前模型仍可见的材料，不把即将退役的旧恢复块作为基准；原始 user 文本不参与恢复块的归属判定。恢复文本 part 记下对应 markerID，重放用户轮不复制旧恢复块。每个候选失败独立降级；成功内联时扣减该项的完整格式开销，引用行中的路径和原因均有长度上限。

### 摘要保留条数（2026-11-20）

成功摘要 assistant 自带可选非负整数 `n`。标记之前最后 n 条原消息及标记后的输入由历史投影组装，沿用原 ID。旧 `tail_start_id` 仅在加载或复制旧会话时解释。普通请求超限保留原始输入和后续工具进展，续行使用独立控制消息；必保区单独核算，额外旧历史按 5% 分档及 25% 上限选择。见[写入与恢复契约](../../fixes/session-fix-summary-retained-count.md)。
