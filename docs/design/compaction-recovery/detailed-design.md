# 细化设计 — 压缩后恢复（compaction-recovery）

> 状态：细化阶段（§4.3），待 §4.4 审查后实施。
> 架构依据：`docs/design/compaction-recovery/architecture.md`（已确认）。
> 待核实清单已全部核实（见 §2 复用点，标注 ★）。

## 1. 范围

- 新模块 `packages/opencode/src/session/restoration.ts`（M1 collect / materialize / render / buildTailText）
- 注入入口 `apply`（M2，同文件）
- 装配：`session/prompt.ts` 在 `applyAgentRoster` 之后追加一行调用
- 配置：`packages/core/src/v1/config/config.ts` 的 `compaction` struct 增加 `restoration` 子结构
- 测试：restoration 单元测试（collect/materialize/render/buildTailText 纯函数）+ apply 幂等集成测试 + 注入后模型消息可见性测试

不覆盖：roster（既有）、插件契约（非目标）、core V2 runner 路径（V1 主循环专用；V2 摘要丢失 structured 是独立 follow-up）。

## 2. 与已有代码的复用点（待核实清单核实结果）

| 项 | 核实结果 | 复用方式 |
|---|---|---|
| H1 路径字段 ★ | read → `metadata.display.path`（`read.ts:288-295`）；edit → `metadata.filepath`（`edit.ts:107,150`） | collect 的候选提取 |
| H3 tail 重建 ★ | `Session.messages({sessionID})` 返回全量 `WithParts[]`（`session.ts:536`）；tail 体量受 preserve_recent 预算（2k~15k token）约束，全量读取后切片成本同阶 | `buildTailText` |
| skill 定位 ★ | skill tool part `metadata: { name, dir }`（`skill.ts:62-65`）；`Skill.Service` 可按 name 解析 `info.location` | materialize 的 skill 正文重读 |
| synthetic part ★ | `{ id, messageID, sessionID, type: "text", text, synthetic: true }` 经 `sessions.updatePart` + push 入 `userMessage.parts`（`reminders.ts:138-151`）；哨兵前缀 + `findLast` + 逐字节比较的去重先例 | apply 的写入与去重 |
| config ★ | `compaction` struct（`config.ts:150-161`，含 auto/prune/tail_turns/preserve_recent_tokens） | 新增 `restoration` 子结构 |
| token 估算 | `Token.estimate`（core util，compaction 同款） | materialize/render 的 token 上限 |
| 哨兵常量先例 | `AGENT_ROSTER_SENTINEL`（reminders.ts） | `RESTORATION_SENTINEL = "<!-- opencode:restoration -->"` |

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

函数局部类型（ephemeral，不进本节）：`tailText: string`、渲染用的节缓冲。

## 5. 模块细化

### 5.1 buildTailText

- **签名**：`buildTailText(messages: SessionV1.WithParts[], tailStartID: MessageID | undefined): string`
- **功能描述**：拼接 `tail_start_id` 指向消息及其之后所有 parts 的 text 内容（text part 的 text、tool part 的 output）。
- **调用关系**：callers: apply；callees: 无。
- **实现思路**（§4.3.1 六条）：
  1. `tailStartID === undefined` → 返回 `""`（无 tail → 比对基线为空，全部候选照常物化——对应"全量摘要"压缩形态）
  2. 定位 `messages` 中 `info.id === tailStartID` 的消息下标（找不到 → 视同 1，返回 `""`）
  3. 从该下标起遍历：text part → push `part.text`；tool completed part → push `part.state.output`；其余类型跳过
  4. `join("\n\n")` 返回
- **退出覆盖**：仅正常返回（纯函数）。
- **循环刻画**：步骤 2-3 均为有限数组线性扫描，终止显然。
- **正确性论证**：前置：messages 为全量、tailStartID 来自 compaction part。步骤 2 定位唯一（ID 唯一）；步骤 3 覆盖承载文本的两种 part 类型（text/tool-completed——file part 无正文、reasoning 不属于"模型可见原文"的重复判定对象，是显式取舍）；拼接结果包含 tail 的全部相关文本 ⇒ 后置（作为 materialize 比对基线的语义成立）。

### 5.2 collectCandidates

- **签名**：`collectCandidates(messages: SessionV1.WithParts[], todos: Todo.Info[]): RestorationCandidate[]`
- **功能描述**：线性扫描产出候选。
- **调用关系**：callers: apply；callees: 无。
- **实现思路**：
  1. 正向遍历全部 parts，维护 `Map<(kind,ref), lastUseSeq>`（seq 用 PartID/单调序号——取 part 的持久化顺序，实现用遍历计数器）
  2. tool completed part 且 `tool === "read"` → `metadata.display?.path` → file 候选；`tool === "edit"` → `metadata.filepath` → file 候选；`tool === "skill"` → `metadata.name` → skill 候选
  3. `todos.length > 0` → push todo 候选（固定 ref `"todo"`，lastUseSeq = 最大遍历计数）
  4. Map → 数组，按 lastUseSeq 降序
- **退出覆盖**：纯函数，仅正常返回；metadata 缺字段（如 `display` undefined）→ 跳过该 part（不产生候选）。
- **循环刻画**：线性扫描有限数组，终止显然。
- **正确性论证**：前置：messages 完整、todos 为现状。每个 read/edit/skill completed part 恰产生至多一个候选（同 ref 后者覆盖前者，保留最近）⇒ 唯一性后置成立；排序键单调 ⇒ "按最近使用排序"后置成立。

### 5.3 materializeCandidates

- **签名**：`materializeCandidates(candidates, tailText: string, deps: { fs; skill; todo; cfg }): Effect.Effect<RestorationMaterial[]>`（deps 以参数传入便于单测）
- **功能描述**：逐候选物化。
- **调用关系**：callers: apply；callees: FSUtil（读盘/stat）、Skill.Service（按 name 定位 location）、Token.estimate。
- **实现思路**（分支全覆盖）：
  1. `todo` 候选 → 渲染 todo 列表（复用 todo 工具的渲染格式）→ `inlined`
  2. `skill` 候选 → Skill.Service 解析 name → 失败 → `missing`；成功 → 读 `info.location` 文件 → 估算超 `file_max_tokens` → `reference`；成功 → `inlined`（**无 tail 比对**——架构已定：skill 正文压缩后只剩截断版，比对无意义）
  3. `file` 候选 → `stat`：失败 → `missing(reason)`；估算超限 → `reference`；否则读全文 → `tailText.includes(content)`（原始包含判定）→ 命中 `skipped-duplicate`；否则 `inlined`
  4. 顺序执行，单候选失败被 catch → `missing`（错误处理策略 §3）
- **callee 契约引用**：`FSUtil` read/stat 的错误语义按平台错误处理；`Skill.Service` 解析失败为类型化错误（catch 转 missing）。
- **循环刻画**：候选有限，逐个处理，终止显然。
- **正确性论证**（non-trivial）：
  - 前置：候选来自 5.2；tailText 语义见 5.1。
  - 论证：file 分支——读盘成功时 `content` 即磁盘当前版本（架构 H2：磁盘即现状）；`tailText.includes(content)` 为真 ⇒ 该当前版本已完整存在于模型上下文 ⇒ 注入是冗余 ⇒ skip 正确；为假 ⇒ 当前版本不在 tail ⇒ 注入满足"当前版本"验收（重复仅可能因格式差异漏判——冗余方向，无数据损失，预算兜底）。skill 分支跳过比对符合其正文必然只剩截断版的事实。三分支（missing/reference/inlined）覆盖全部读盘结局 ⇒ 后置（每个候选恰有一个处置且处置可诊断）。
  - 副作用论证：只读（read/stat/skill 解析），无写入。

### 5.4 renderMaterials

- **签名**：`renderMaterials(materials: RestorationMaterial[], cfg: RestorationConfig): string | undefined`
- **功能描述**：预算内合成最终文本。
- **调用关系**：callers: apply；callees: Token.estimate。
- **实现思路**：
  1. 过滤：`max_files` 对 file 类 `inlined` 候选取前 N（排序已在 collect 保证按最近）
  2. 组装三节：Files（inlined 的 `### file: path` + content 围栏）/ Skills / Todos；reference/missing/skipped-budget 以单行引用形式列入对应节（`- path (reason)`）
  3. 顺序累加，累计 token 估算超过 `budget_tokens` 时：当前候选降级为 `skipped-budget` 引用行（引用行本身计入预算），后续全部同样降级
  4. 整体无任何节有内容 → 返回 `undefined`
  5. 输出 = `RESTORATION_SENTINEL` 行 + 三节 markdown
- **退出覆盖**：`undefined`（无材料）与文本两种返回。
- **循环刻画**：材料有限，逐个累加，token 计数单调不减 → 终止。
- **正确性论证**（non-trivial）：
  - 前置：materials 来自 5.3，状态语义成立。
  - 论证：不变量——任意前缀处理完毕时，已输出文本 token 估算 ≤ budget（归纳：每加入一个 inlined 前检查，超限即降级为引用行且引用行短于其内容 ⇒ 仍不超）；max_files 在 inlined file 上先于预算执行 ⇒ 两约束同时满足 ⇒ 后置（I2 成立：输出 ≤ budget_tokens）。
  - 副作用论证：纯函数。

### 5.5 apply（M2 编排）

- **签名**：`apply(input: { sessionID: SessionID }): Effect.Effect<void>`（服务方法；内部经 `Session.Service` 读 messages、经 Config 读配置）
- **功能描述**：幂等入口：读配置（`enabled === false` → 直接返回）→ 读 messages → 触发判定 → findLast user message → buildTailText → collect → materialize → render → 哨兵去重 → 条件落库。
- **调用关系**：callers: prompt.ts（roster 之后）；callees: 5.1-5.4 + Session + Config + Todo + FSUtil + Skill。
- **实现思路**：
  1. `cfg.compaction.restoration?.enabled === false` → return
  2. `messages = yield* sessions.messages({ sessionID })`
  3. 触发判定：找**最后一个** completed compaction part 的消息下标 `c`；`findLast` 哨兵前缀 text part 的下标 `r`；`c` 不存在 → return；`r` 存在且 `r > c` → return（已恢复过且无新压缩）
  4. `userMessage` = messages 中最后一个 user message（compaction user 之后的 auto-continue/replay user——与 roster 取同一定位函数，复用其实现）
  5. tail：`completedCompactions` 同款逻辑取最新 `tail_start_id` → `buildTailText`
  6. `collectCandidates` → 读 todo → `materializeCandidates` → `renderMaterials` → `undefined` → return
  7. 与 `findLast` 哨兵 part **逐字节比较**：相同 → return；不同（或不存在）→ `sessions.updatePart({..., type: "text", text, synthetic: true })` + push 入 userMessage.parts
  8. 全程 `Effect.catch` 吸收异常 → `Effect.logWarning` → return（错误处理策略）
- **退出覆盖**：六个正常退出点（1/3/6/7）+ 异常吸收退出（8）；各点均 `Effect<void>`。
- **循环刻画**：无循环（线性编排；内部循环已论证）。
- **正确性论证**（non-trivial）：
  - 前置：每轮 turn-boundary 被调用（调用方责任）；messages/持久化服务可用。
  - 论证：触发判定（步骤 3）——`r > c` 表示最近一次压缩之后已注入过恢复 ⇒ 幂等返回；`r ≤ c`（或 r 不存在）表示存在未恢复的新压缩 ⇒ 继续。步骤 7 字节比对保证内容未变不重写。两个守卫合成 ⇒ 任意调用序列后语义有效恢复 part ≤ 1 且内容与最近压缩状态一致 ⇒ I1 + I4。写入是唯一 part 产生点且只追加 ⇒ I3。步骤 6 的 `undefined` 出口保证空材料不产生空 part。异常吸收 ⇒ 调用方（loop）永不因恢复失败中断 ⇒ 接口后置成立。
  - 副作用论证：唯一副作用是步骤 7 的条件 part 写入（穷尽：配置读取/消息读取/读盘均为只读）。

### 5.6 装配（prompt.ts）

`applyAgentRoster` 调用之后追加：

```ts
msgs = yield* SessionRestoration.apply({ sessionID: chat.id }).pipe(
  Effect.provideService(Session.Service, sessions),
  Effect.provideService(SessionTodo.Service, todo),
  Effect.provideService(Skill.Service, skill),
  Effect.provideService(Config.Service, config),
  Effect.provideService(FSUtil.Service, fsys),
)
```

依赖注入形态对齐 roster 的既有写法（实施时按实际依赖集合微调）。

### 5.7 测试设计

- **单元**（`test/session/restoration.test.ts`）：buildTailText（undefined/找不到/切片正确）、collectCandidates（read/edit/skill/去重/排序/todo）、materializeCandidates（临时目录真读盘：missing/reference/duplicate/inlined 四分支 + skill 解析失败）、renderMaterials（预算降级/max_files/空 → undefined/哨兵行）。
- **集成**：`apply` 幂等——构造压缩后 messages，连续调用两次 `apply`，断言仅一个恢复 part 且第二次零写入；触发判定——无 compaction 时零写入。
- **可见性**：恢复 part 写入后经 `toModelMessages` 断言模型消息包含恢复文本（复用 P0 E2E 的驱动方式：压缩 + 下一轮请求捕获）。

## 6. 完整性自检 checklist

- [x] 所有函数实现思路推导连续（5.1-5.5 均为编号步骤，无跳步）
- [x] 所有 if / else / switch 分支已覆盖（materialize 四分支、render 预算降级、apply 六出口、collect 字段缺失跳过）
- [x] 所有退出点已刻画（5.5 六个正常出口 + 异常吸收出口；5.4 的 undefined/文本两态）
- [x] 所有 callee 调用显式引用 pre/post（FSUtil/Skill/Todo/Token/Session 的契约在 §3/§5.3 标注）
- [x] 所有循环有终止性论证（各函数线性扫描，计数单调）
- [x] 所有上游事实显式列出（H1-H5 已核实并标注出处行号；`resource.text` 真值语义等实现层事实在实现思路内注明）
