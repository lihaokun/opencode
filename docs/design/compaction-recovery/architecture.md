# 架构 — 压缩后恢复（compaction-recovery）

> 状态：已实施并随二轮独立复审收敛同步至 HEAD（§4.2–§4.4）。
> 关联：issue #46；调研依据 `docs/research/runtime-alignment-research.md` §5.2 与 §7 决议 #10-11（磁盘重读、v1 内部契约）；对照 `docs/research/zcode-replacement-assessment.md` §4.1。

## 1. 目标与非目标

**目标**

- **G1 文件恢复**：压缩后，模型重新获得当前任务所需文件的**当前版本**（磁盘重读）；与 tail 保留原文同版本时去重；文件已删除/移动、过大或读取失败时降级为可诊断的引用行（issue 验收第 5 条）。
- **G2 状态恢复**：todo 列表与已加载 skill 正文在压缩后重新可见；运行中子代理由既有 subagent 视图与 `agent_list` 覆盖（不在本 feature 重复建设）。
- **G3 预算**：恢复材料总量受预算约束（同时约束原始 UTF-16 与 JSON 转义长度）——回填不会把刚压小的上下文重新撑满（issue 验收第 7 条）。
- **G4 多次压缩一致性**：恢复幂等——每轮上下文语义有效恢复块至多一份（同一 marker 重复触发不重写，跨 marker 时 Step P8 退役旧块再写入新块）、重复压缩后不丢不重（issue 验收第 4 条）。

**非目标（v1 明确不做，记录引入条件）**

- 插件恢复扩展契约：出现第一个真实插件消费者时，基于 `session.compacted` 事件与注入挂点（均为既有设施）设计契约。
- 后台任务恢复：`BackgroundJob` 有意非持久化（`core/background-job.ts` "intentionally not durable"），运行中子代理与后台 shell 的可见性由子代理视图、`agent_list` 与 `shell_output` 覆盖；引入条件：后台任务建立持久化状态源时再新增 `"task"` 候选类别。
- 缓存回填路径：磁盘重读已定（决议 F①），缓存投影只作对照参考。

## 2. 核心流程

```
压缩完成（成功摘要与保留条数 n 一起落库）
  ↓ V1 compaction task 返回 continue，进入恢复步骤
SessionRestoration.apply({ sessionID })
  ├─ 读取全量 messages → 触发判定：
  │    存在 completed compaction part，且其位置晚于最近一个恢复标记 part
  │    （与 roster 的 compacted 判据同构；无 compaction → 不动）
  ├─ collect：扫描 tool parts（read/edit → path；skill → name/dir）按最近使用排序，
  │    读取 todo 现状（DB）
  ├─ materialize：按当前权限读盘，取得同一路径在保留区最近的完整可见 read 指纹，相同时去重
  ├─ render：file/token 上限裁剪 → markdown 块（Files / Skills / Todos 三节，
  │    失效与超限降级为引用行）
  └─ 渲染非空且与上一份恢复 part 逐字节不同 → 退役旧恢复 part（就地置 ignored: true），
       再作为 synthetic text part 落库到最后一个非未结算 marker 的 user message（<!-- opencode:restoration -->）
  ↓ 后续每一轮
filterCompacted 按已完成摘要的 Assistant.n（旧会话兼容 tail_start_id）重排，自然携带该 part
```

## 3. 数据结构（§3.1 格式）

**数据结构：RestorationCandidate**

字段：
- `kind`: `"file" | "skill" | "todo"` — 候选类别
- `ref`: string — 文件绝对路径 / skill 名 / 固定 `"todo"`
- `lastUseSeq`: number — 关联 part 的持久化序号（排序键，取同 ref 最近者）

类型不变量：`ref` 非空；`kind: "file"` 时 `ref` 为绝对路径。
唯一性：`(kind, ref)` 全列表内唯一。
生命周期：collect 每次压缩后重建，不持久化。

**数据结构：RestorationMaterial**

字段：
- `candidate`: RestorationCandidate
- `status`: `"inlined" | "reference" | "skipped-duplicate" | "skipped-budget" | "missing"` — 处置结果
- `content`: string（可选）— `inlined` 时的正文
- `reason`: string（可选）— `reference`/`missing` 的人类可读原因

类型不变量：`inlined ⇒ content 是字符串`（空文件可为 ""）；`missing ⇒ reason 非空`。
生命周期：render 的输入，不持久化。

**数据结构：恢复 part（持久化）**

- 形状：既有 synthetic text part（对齐 roster 的落库方式），文本以 `<!-- opencode:restoration -->` 行开头（对齐 roster 的 `<!-- opencode:subagents -->` 先例），带 `metadata: { kind: "compaction_restoration", markerID }`，挂载于最后一个非未结算 compaction marker 的 user message。
- 生命周期：创建于压缩结算后的恢复步骤；持久化；后续轮次复用；新压缩生成新恢复块时，旧恢复 part 就地标记 `ignored: true`（G4 退役语义，保留审计轨迹且不进入模型投影与摘要输入），旧压缩对之后也会随 `filterCompacted` 截断。
- 跨模块共享性：`session/restoration.ts`（生产）与 `prompt.ts`（装配）。

**配置：`compaction.restoration`**（全部可选，有默认值）

- `enabled`: boolean — 默认 `true`
- `max_files`: integer — 默认 `5`
- `file_max_tokens`: integer — 默认 `4_000`（单文件上限，超限降级 reference）
- `budget_tokens`: integer — 默认 `8_000`（完整内联区的预算，诊断余量见 I2）

## 4. 模块划分与功能规约（§3.2 格式）

### M1 `session/restoration.ts`（新模块）

**函数/模块名称**：`SessionRestoration.collect`

功能描述：从会话历史中收集恢复候选。
前置条件：`messages` 为该会话的全量消息（含 compaction part 之前的）；`todos` 为当前 todo 状态。
后置条件：返回候选列表，`(kind, ref)` 唯一，按 `lastUseSeq` 降序；file 候选来自 completed read/edit tool parts 的路径字段；skill 候选来自 completed skill tool parts 的 `metadata.name`；todo 至多一条（有 todo 时）。
不变式：不读盘、无 IO（纯扫描）。
副作用：无。

**函数/模块名称**：`SessionRestoration.materialize`

功能描述：逐候选生成 RestorationMaterial。
前置条件：候选列表非空；可访问文件系统与 todo 服务。
后置条件：
- file：按权限和大小限制读盘；同路径保留区内的完整 read 结果仍然可见、且其 SHA-256 与新读内容相同，则归为 skipped-duplicate。旧 read 缺指纹时按预算恢复。
- skill：读 skill 目录正文，规则同 file（无 tail 比对——skill 正文压缩后必然只剩截断版）。
- todo：已知非空的当前列表首先申请预算；空列表省略，查询失败产生 missing 诊断，不影响文件或 skill。
不变式：`inlined` 材料的 token 估算和 ≤ 预算（由 render 的裁剪兜底）。
副作用：只读磁盘。

**函数/模块名称**：`SessionRestoration.render`

功能描述：按预算合成最终 markdown 文本。
前置条件：materialize 的输出。
后置条件：返回文本或 `undefined`（全部 skipped-duplicate 或预算为零时为 undefined）；`inlined` 按候选顺序装入直至 `budget_tokens`，装不下的降级为 `skipped-budget` 引用行；输出以恢复标记行开头。
不变式：内联区整体不超过 B = budget_tokens。含诊断时全文不超过 B + max(128, min(2000, B))。B 为零时没有恢复文本。
副作用：无。

collect / materialize / render 均为纯或只读函数，可独立单元测试。

### M2 注入管线（复用 reminders 模式）

**函数/模块名称**：`SessionRestoration.apply`

功能描述：V1 压缩成功后的幂等入口。
前置条件：`messages` 为本轮全量消息。
后置条件：满足触发条件（当前最新已结算 marker 尚未恢复）→ 退役既有未忽略恢复块（就地置 `ignored: true`），若渲染非空再写入新恢复 part；同一 marker 重复调用零写入。
不变式：任意时刻上下文中语义有效的恢复 part 至多一份（I1）；触发判定不依赖 wall-clock。
副作用：退役旧恢复 part（就地 `updatePart` 置 `ignored: true`）与至多一次新 part 写入。

### M3 装配点（`session/prompt.ts`）

在 V1 compaction task arm 内、`compaction.process` 返回 `"continue"` 时调用 `SessionRestoration.apply`，并同步提供 `Session`/`Agent`/`FSUtil`/`Config`/`Todo`/`Skill` 六项服务（`SessionPrompt.node` 声明 `Todo.node` 与 `Skill.node` 依赖）。当主模型存在有限上下文窗口时，根据压缩后已投影消息与 `fixed_input_tokens` 计算剩余可用预算 `maxBudgetTokens` 传入 `apply`，确保自动恢复块不会把刚压缩的会话重新推过溢出线。

## 5. 接口规约（§3.3 格式）

**接口：prompt.ts → SessionRestoration**

输入数据：`{ sessionID: SessionID; maxBudgetTokens?: number }`（messages 由模块自行从 Session 服务读取；`maxBudgetTokens` 可选，由调用方按主模型剩余 headroom 计算，用于将本次恢复的 `budget_tokens` 动态封顶）。
输出数据：`Effect<void>`。
协议约定：
- 调用方责任：在 compaction task arm 结算返回 `"continue"` 后调用（且 `apply` 必须保持幂等）；提供 `Session`/`Agent`/`FSUtil`/`Config`/`Todo`/`Skill` 依赖。
- 被调用方责任：内部完成触发判定、收集、物化、渲染、退役旧块与落库；任何读盘失败降级为引用行而非失败（G1 的可诊断降级）；绝不抛出导致 loop 中断的错误。

## 6. 关键设计决策

1. **磁盘重读而非缓存投影**（决议 F①）：ZCode 式缓存回填可能注入过时版本，不满足验收"当前版本"。
2. **持久化 synthetic part 而非每轮重建**：roster 先例——缓存前缀友好、与 filterCompacted 重排兼容、天然支持逐字节去重。
3. **触发判据复用 roster 的位置比较**（compaction part 位置 vs 标记 part 位置）：不新增 schema 游标字段（razor：无第二个消费者的 seam 不设）。
4. **按路径与内容指纹判重**：read 对完整展示的文本记录源字节 SHA-256，沿用现有可选 metadata。老数据没有精确证据，按当前权限和预算重新展示。
5. **v1 无插件契约**（决议 F②）：`session.compacted` 事件与 apply 挂点原样保留，作为将来契约的引入条件与可复用件。

## 7. 架构正确性论证（§4.2.1）

**goal → 模块映射**

- G1 → M1（collect + materialize 读盘与比对）+ M2（注入）
- G2 → M1（todo/skill 候选）+ 既有 roster（引用）
- G3 → M1.render（预算裁剪）
- G4 → M2（触发判据 + 逐字节去重）

**模块协作论证**

- G1 要求"当前版本文件回到模型上下文"。M1.collect 从本会话 read/edit parts 产出候选（来源可信，pre：路径由工具写入且经权限门禁）；M1.materialize 读盘 ensures 内容为**当前**版本（假设 H2）；与 tail 比对 ensures 同版本不重复注入（不变量 I1 的来源）；render ensures 输出在预算内（I2）。三者串联 ⇒ 压缩后首轮模型请求即含当前版本文件（或可诊断降级）⇒ G1 成立。
- G2：todo 先申请预算，失败产生可定位的引用；skill 依据当前授权和预算重读。
- G3：render 的预算裁剪 ensures I2 ⇒ G3 成立。
- G4：apply 幂等 + 触发判据只依赖持久化位置与 `markerID` ⇒ 同一 marker 重复触发零写入；新压缩产生新 marker 时 Step P8 先退役旧块再写入新块 ⇒ I1/I4 ⇒ G4 成立。

**关键假设**

- **H1**：read/edit/write tool part 的 metadata 携带可靠路径（已核实：`read.metadata.display.path` 仅 `display.type === "file"`、`edit.metadata.filediff.file`、`write.metadata.filepath` 用于失效读缓存）。来源：§3.1 盘点与细化 §2。
- **H2**：文件自读取后若未被修改，磁盘当前内容与模型读到的版本一致；若被修改，"当前版本"正是验收要求的版本。残余风险：模型需要的若恰是**读时旧版本**（文件被外部改坏的场景），恢复注入的是新版本——按验收口径（"所需的当前版本"）这是正确方向；旧版本仍可经全文文件或重读历史获得。来源：issue 验收第 5 条措辞。
- **H3**：保留区由 `filterCompacted` 依据最新已完成摘要的 `Assistant.n`（旧会话兼容 `tail_start_id`）投影得到，`retainedFileVersions` 直接扫描该保留区提取完整可见 read 的 SHA-256 指纹，并在后续 `edit`/`write` 触及同路径时失效旧指纹。
- **H4**：恢复 part 写在最后一个非未结算 compaction marker 的 user message 上（自动续行场景位于压缩保留区之后；手动/无续行场景挂载于已结算 marker 自身），确保始终落在 `filterCompacted` 可见区间内且不被未结算后继 marker 劫持。
- **H5**：普通文件与磁盘 `SKILL.md` 均受 `file_max_tokens` 控制，读盘前先 `stat` 校验大小；对处于保留尾中的文件（≤64 KiB，覆盖 `ReadTool` 50 KiB 上限）优先做 SHA-256 去重返回 `skipped-duplicate`，避免误标 `reference`。

**模块级不变量**

- I1：任意轮次上下文中语义有效的恢复 part ≤ 1 份 — 维护方：M2 `markerID` 触发判据 + 逐字节去重 + 写入前将旧恢复 part 标记 `ignored: true`（G4 退役）。
- I2：带有正文时，哨兵、分节标题、路径、换行、围栏和正文同时计入原始 UTF-16 预算与 JSON 转义预算（有效预算 `B = min(cfg.budget_tokens, maxBudgetTokens ?? Infinity)`）。诊断独享有界余量，整块同时满足 `text.length <= (B + D) * 4` 且 `JSON.stringify(text).length <= floor((B + D) * 4 * 4 / 3)`；当剩余 headroom 极紧时 `B` 退化为 `0`（不注入），保证溢出恢复在 `/3`（`estimatePayload`）与 `/4`（`willOverflow`）双口径下均不因恢复块触发假性 `ContextOverflowError`。
- I3：恢复注入不改变既有消息的相对顺序 — 维护方：M2 只在目标 user message 上追加 synthetic part，并在写入前就地标记旧 sentinel 为 `ignored: true`。
- I4：重复压缩幂等 — 维护方：M2 `markerID` 触发判据 + G4 退役机制。

**preservation 论证**：每个标记只触发一次恢复；新标记会退役旧块，且 headroom 核算通过 `SessionRestoration.withoutRestoration` 排除即将退役的旧块以避免连续压缩双重计费。`Assistant.n` 与 `CompactionPart.protected_from`/`request_user_id`/`fixed_input_tokens` 在溢出恢复期间共同界定必保批次与剩余 headroom，`restorationBudgetCap`（对 `headroom` 取 `Math.floor`）与 `renderMaterials` 双预算上限共同保证恢复块在 `/3` 与 `/4` JSON 双口径下均不超过可用空间。任意内联项进入前同时检查原始长度与 JSON 转义长度，引用节限制条数、路径和原因长度并按双预算折叠尾部引用。空预算不产生恢复块。

## 8. 细化阶段待核实清单

- read/edit tool part metadata 的确切路径字段名（H1）
- tail 文本重建的实现途径与成本（H3）——从 Session 服务按 ID 区间读取而非全量重排
- skill 目录定位 API（`skill.metadata.name/dir` → 正文文件路径）
- synthetic text part 的准确 schema 形状（对齐 `reminders.ts` 既有写法）
- `compaction.restoration` 配置项在 config schema 的注册位置
