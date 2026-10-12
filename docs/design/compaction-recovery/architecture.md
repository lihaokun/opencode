# 架构 — 压缩后恢复（compaction-recovery）

> 状态：架构阶段（§4.2），待确认后进入细化（§4.3）。
> 关联：issue #46；调研依据 `docs/research/runtime-alignment-research.md` §5.2 与 §7 决议 #10-11（磁盘重读、v1 内部契约）；对照 `docs/research/zcode-replacement-assessment.md` §4.1。

## 1. 目标与非目标

**目标**

- **G1 文件恢复**：压缩后，模型重新获得当前任务所需文件的**当前版本**（磁盘重读）；与 tail 保留原文同版本时去重；文件已删除/移动、过大或读取失败时降级为可诊断的引用行（issue 验收第 5 条）。
- **G2 状态恢复**：todo 列表与已加载 skill 正文在压缩后重新可见；运行中子代理由既有 roster 机制覆盖（引用，不在本 feature 重复建设）。
- **G3 预算**：恢复材料总量受预算约束——回填不会把刚压小的上下文重新撑满（issue 验收第 7 条）。
- **G4 多次压缩一致性**：恢复幂等——每轮上下文至多一份恢复材料、内容不变不重复写入、重复压缩后不丢不重（issue 验收第 4 条）。

**非目标（v1 明确不做，记录引入条件）**

- 插件恢复扩展契约：出现第一个真实插件消费者时，基于 `session.compacted` 事件与注入挂点（均为既有设施）设计契约。
- 后台任务恢复：`BackgroundJob` 非持久化（`core/background-job.ts` 注释明示）；子代理可见性由 roster 覆盖。
- 缓存回填路径：磁盘重读已定（决议 F①），缓存投影只作对照参考。

## 2. 核心流程

```
压缩完成（summary 落库、tail_start_id 回写）
  ↓ 下一轮 runLoop（每轮都执行，prompt.ts turn-boundary，roster 之后）
SessionRestoration.apply({ sessionID })
  ├─ 读取全量 messages → 触发判定：
  │    存在 completed compaction part，且其位置晚于最近一个恢复标记 part
  │    （与 roster 的 compacted 判据同构；无 compaction → 不动）
  ├─ collect：扫描 tool parts（read/edit → path；skill → name/dir）按最近使用排序，
  │    读取 todo 现状（DB）
  ├─ materialize：逐候选读盘（当前版本）→ 与 tail 保留文本比对 → 同版本则 skip-duplicate
  ├─ render：file/token 上限裁剪 → markdown 块（Files / Skills / Todos 三节，
  │    失效与超限降级为引用行）
  └─ 渲染非空且与上一份恢复 part 逐字节不同 → 作为 synthetic text part
       落库到最后一条 user message（<!-- opencode:restoration --> 标记）
  ↓ 后续每一轮
filterCompacted 重排自然携带该 part（位置在 tail_start_id 之后，不会被截断）
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

类型不变量：`inlined ⇒ content 非空`；`missing ⇒ reason 非空`。
生命周期：render 的输入，不持久化。

**数据结构：恢复 part（持久化）**

- 形状：既有 synthetic text part（对齐 roster 的落库方式），文本以 `<!-- opencode:restoration -->` 行开头（对齐 roster 的 `<!-- opencode:subagents -->` 先例），挂载于最后一条 user message。
- 生命周期：创建于压缩后首个满足触发条件的轮次；持久化；后续轮次复用；不删除、不更新（内容变化只在下次压缩后经逐字节比对重新写入新 part——旧 part 随旧 compaction 对被 filterCompacted 自然截断）。
- 跨模块共享性：`session/restoration.ts`（生产）与 `prompt.ts`（装配）。

**配置：`compaction.restoration`**（全部可选，有默认值）

- `enabled`: boolean — 默认 `true`
- `max_files`: integer — 默认 `5`
- `file_max_tokens`: integer — 默认 `4_000`（单文件上限，超限降级 reference）
- `budget_tokens`: integer — 默认 `8_000`（全部恢复材料总量上限）

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
- file：读盘成功 → 内容与 tail 文本归一化比对，tail 已完整包含同版本 → `skipped-duplicate`；内容超 `file_max_tokens` → `reference`（含路径与大小）；读取失败（不存在/权限）→ `missing`（含原因）；否则 `inlined`。
- skill：读 skill 目录正文，规则同 file（无 tail 比对——skill 正文压缩后必然只剩截断版）。
- todo：渲染当前列表，恒 `inlined`（体量小）。
不变式：`inlined` 材料的 token 估算和 ≤ 预算（由 render 的裁剪兜底）。
副作用：只读磁盘。

**函数/模块名称**：`SessionRestoration.render`

功能描述：按预算合成最终 markdown 文本。
前置条件：materialize 的输出。
后置条件：返回文本或 `undefined`（全部 skipped/missing 且无 reference 时为 undefined）；`inlined` 按候选顺序装入直至 `budget_tokens`，装不下的降级为 `skipped-budget` 引用行；输出以恢复标记行开头。
不变式：输出 token 估算 ≤ `budget_tokens`。
副作用：无。

collect / materialize / render 均为纯或只读函数，可独立单元测试。

### M2 注入管线（复用 reminders 模式）

**函数/模块名称**：`SessionRestoration.apply`

功能描述：每轮 turn-boundary 调用的幂等入口。
前置条件：`messages` 为本轮全量消息。
后置条件：满足触发条件且渲染非空、与最近一份恢复 part 不同 → 写入新的恢复 part；否则零写入。
不变式：任意时刻上下文中语义有效的恢复 part 至多一份（I1）；触发判定不依赖 wall-clock。
副作用：至多一次 part 写入。

### M3 装配点（`session/prompt.ts`）

在 roster 注入（`prompt.ts:1332`）之后追加一行 `SessionRestoration.apply` 调用；不改变既有注入顺序（restore 材料位于 roster 之后、模型消息装配之前）。

## 5. 接口规约（§3.3 格式）

**接口：prompt.ts → SessionRestoration**

输入数据：`{ sessionID: SessionID }`（messages 由模块自行从 Session 服务读取，保持与 reminders 的调用形态一致）。
输出数据：`Effect<void>`。
协议约定：
- 调用方责任：仅在 turn-boundary（消息装配前）调用；不保证调用频次（apply 必须幂等）。
- 被调用方责任：内部完成触发判定、收集、物化、渲染、落库；任何读盘失败降级为引用行而非失败（G1 的可诊断降级）；绝不抛出导致 loop 中断的错误。

## 6. 关键设计决策

1. **磁盘重读而非缓存投影**（决议 F①）：ZCode 式缓存回填可能注入过时版本，不满足验收"当前版本"。
2. **持久化 synthetic part 而非每轮重建**：roster 先例——缓存前缀友好、与 filterCompacted 重排兼容、天然支持逐字节去重。
3. **触发判据复用 roster 的位置比较**（compaction part 位置 vs 标记 part 位置）：不新增 schema 游标字段（razor：无第二个消费者的 seam 不设）。
4. **版本判定用"与 tail 文本比对"而非读时 hash**：read/edit part 未存储读时 hash，新增 hash 属于 schema 变更且只有此一处消费——tail 保留的原文本身就是"读过的版本"的权威样本（假设 H2 下成立，见 §7）。
5. **v1 无插件契约**（决议 F②）：`session.compacted` 事件与 apply 挂点原样保留，作为将来契约的引入条件与可复用件。

## 7. 架构正确性论证（§4.2.1）

**goal → 模块映射**

- G1 → M1（collect + materialize 读盘与比对）+ M2（注入）
- G2 → M1（todo/skill 候选）+ 既有 roster（引用）
- G3 → M1.render（预算裁剪）
- G4 → M2（触发判据 + 逐字节去重）

**模块协作论证**

- G1 要求"当前版本文件回到模型上下文"。M1.collect 从本会话 read/edit parts 产出候选（来源可信，pre：路径由工具写入且经权限门禁）；M1.materialize 读盘 ensures 内容为**当前**版本（假设 H2）；与 tail 比对 ensures 同版本不重复注入（不变量 I1 的来源）；render ensures 输出在预算内（I2）。三者串联 ⇒ 压缩后首轮模型请求即含当前版本文件（或可诊断降级）⇒ G1 成立。
- G2：todo 恒 inlined、skill 同 file 管线（无 tail 比对，因 skill 正文压缩后必然只剩截断版，比对无意义）⇒ G2 成立。
- G3：render 的预算裁剪 ensures I2 ⇒ G3 成立。
- G4：apply 幂等 + 触发判据只依赖持久化位置 ⇒ 重复压缩后新 compaction part 位置晚于旧恢复 part → 判定再次成立 → 重新收集注入；内容未变则逐字节相同跳过 ⇒ I1/I4 ⇒ G4 成立。

**关键假设**

- **H1**：read/edit tool part 的 metadata 携带可靠路径（`read.metadata.display.path` / `edit.metadata.filepath`——确切字段名在细化阶段核实）。来源：§3.1 盘点。
- **H2**：文件自读取后若未被修改，磁盘当前内容与模型读到的版本一致；若被修改，"当前版本"正是验收要求的版本。残余风险：模型需要的若恰是**读时旧版本**（文件被外部改坏的场景），恢复注入的是新版本——按验收口径（"所需的当前版本"）这是正确方向；旧版本仍可经全文文件或重读历史获得。来源：issue 验收第 5 条措辞。
- **H3**：tail 保留文本可从持久化消息重建（`tail_start_id` 之后 parts 的 text 拼接），且重建成本与 tail 体量同阶（≤ 2k~15k token）。来源：§2.2 机制。
- **H4**：恢复 part 写在最后一条 user message 上，位置必然晚于 `tail_start_id` 指向的消息 → 不会被 filterCompacted 第一阶段截断。来源：roster 既有行为。
- **H5**：单文件读取体量受 `file_max_tokens` 截断控制，读盘本身可能读入超限内容——实现须先 stat 估算、超限不读全文（细化阶段落实）。

**模块级不变量**

- I1：任意轮次上下文中语义有效的恢复 part ≤ 1 份 — 维护方：M2 逐字节去重 + 位置判据；filterCompacted 保证旧恢复 part 随旧 compaction 对截断。
- I2：恢复材料 token 估算 ≤ `budget_tokens` — 维护方：M1.render 裁剪。
- I3：恢复注入不改变既有消息的相对顺序 — 维护方：M2 只在 last user message 上追加 synthetic part。
- I4：重复压缩幂等 — 维护方：M2 触发判据 + 逐字节比对。

**preservation 论证**：破坏 I1 的唯一途径是重复写入恢复 part——每次写入前 M2 必经位置判据与字节比对，写入是唯一的 part 产生点；破坏 I2 的唯一途径是未裁剪的 inlined 内容——render 是唯一文本出口且出口处执行裁剪。I3/I4 由写入路径的单一性（apply 是唯一写方）结构性地保证。

## 8. 细化阶段待核实清单

- read/edit tool part metadata 的确切路径字段名（H1）
- tail 文本重建的实现途径与成本（H3）——从 Session 服务按 ID 区间读取而非全量重排
- skill 目录定位 API（`skill.metadata.name/dir` → 正文文件路径）
- synthetic text part 的准确 schema 形状（对齐 `reminders.ts` 既有写法）
- `compaction.restoration` 配置项在 config schema 的注册位置
