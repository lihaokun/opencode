# Contract Audit Expectations — `comprec-1-restoration`

> ⚠️ 时序声明：本 expectations 为 **2026-10-18 事后补抽**（PR #60 审核意见 C10）。
> workflow §6.2 要求 Step 0（实施前）产出；本子计划实施时未产出，属流程违例。
> 抽取基线 = 修复批次完成后的 PR head（`c7e631fdaf`），契约源仅限下列文档。
> 注：本子计划的契约文档随复审修订两处（B5 候选过滤、B6 注入点），下表以
> 修订后口径为准。

## 1. 契约源（multi-doc）

| 文档 | 用途 | 相关节 |
|---|---|---|
| `docs/design/compaction-recovery/architecture.md` | 主契约（G1-G4/非目标/流程） | §1-§3 |
| `docs/design/compaction-recovery/detailed-design.md` | 细化契约（含 2026-10-18 B5/B6 复审修订） | §1-§7 |
| issue #46 §五.4/5/7 | 需求源（多次压缩一致性、文件恢复、预算验收） | 正文 |
| 调研决议 | `runtime-alignment-research.md` §7 #10-11（磁盘重读、v1 内部契约） | — |
| 既有契约（引用不改） | `filterCompacted` 重排（注入位置保证可见）、roster synthetic part 先例、`Token.estimate` | — |

## 2. Schema 字段（机械化）

| 字段 | 类型 | 契约来源 | 实现位置 | 一致性机制 |
|---|---|---|---|---|
| `compaction.restoration.enabled` | `boolean?`（缺省 true） | 细化 §4 | core config schema + restorationConfig | SDK gen types + 矩阵测试 |
| `compaction.restoration.max_files` | `number?`（缺省 5） | 同上 | 同上 | render 单测 + PBT |
| `compaction.restoration.file_max_tokens` | `number?`（缺省 4000） | 同上 | 同上 | materialize 单测 |
| `compaction.restoration.budget_tokens` | `number?`（缺省 8000） | 同上 | 同上 | render 单测 + PBT + 溢出 headroom 封顶 |
| `RESTORATION_SENTINEL` | `"<!-- opencode:restoration -->"`（导出常量） | 细化 §4 | `restoration.ts` | 测试 import |
| synthetic part | `{ type: "text", text, synthetic: true, metadata: { kind: "compaction_restoration", markerID } }` | 细化 §4 | `apply` → `updatePart` | 集成测试 |
| `Assistant.n` / `CompactionPart.protected_from,request_user_id,fixed_input_tokens` | 非负整数 / `MessageID?` / `number?` | 细化 §5.6 & `session-fix-summary-retained-count.md` | `packages/schema/src/v1/session.ts` | SDK gen types + prompt/compaction 测试 |

## 3. 枚举值（机械化）

| 枚举 | 合法集合 | 来源 |
|---|---|---|
| candidate kind | `file \| skill \| todo` | restoration.ts（类型） |
| material status | `inlined \| reference \| skipped-duplicate \| skipped-budget \| missing` | restoration.ts（类型） |

## 4. 流程步骤（机械化）

- P1 触发（**B6 修订**）：`prompt.ts` compaction task arm 内、`process` 返回 `continue` 后注入恰一次，并按主模型剩余 headroom 传入 `maxBudgetTokens`，同时提供 `Session`/`Agent`/`FSUtil`/`Config`/`Todo`/`Skill` 六项服务
- P2 全量读 messages → 收集 `settledMarkers`（`summary && finish && !error`）定位最后已结算 compaction marker 与未退役 sentinel
- P3 判定：无已结算 marker → 不动；该 marker 已恢复 → 不动；载体取最后一个非未结算 marker 的 user message
- P4 collect：completed tool parts → read（仅 `display.type === "file"`）取 `display.path`、edit 取 `filediff.file`、skill 取 `name`；最近使用排序；todo 置顶优先
- P5 materialize：磁盘 file/skill 读前先 `stat`；同路径完整可见 read（且未被后续 `edit`/`write` 失效）的 SHA-256 一致则 `skipped-duplicate`（优先于 `max_files`/预算耗尽降级）
- P6 render：max_files 逐文件上限 + 预算耗尽降级引用行 → sentinel + 三节（Files/Skills/Todos）+ Not restored
- P7 与当前载体上未退役同 `markerID` sentinel 逐字节比较，相同则跳过
- P8 退役全部既有未忽略 sentinel（就地置 `ignored: true`）并落库新 synthetic text part；顶层 `Effect.exit` 吸收异常绝不断 loop

## 5. 行为契约（语义）

- 恢复的是**当前磁盘版本**（G1，决议 F① 磁盘重读），与 tail 同版本时去重
- 预算：B 为 budget_tokens，内联区（含哨兵、标题和围栏）≤ B。含引用的全文 ≤ B + max(128,min(2000,B))。B=0 无注入。todo 查询失败显示 missing 诊断，空列表省略。
- 幂等（G4）：内容不变不重复写入；多次压缩后不丢不重（GAP-1 三压缩全链）
- **标记必须已结算**（2026-10-20 审核补充，#77 交互防御；**2026-11-05 口径修正**：settled 判据 = 指向该标记消息的完成摘要 assistant（`summary && finish && !error`，与 filterCompacted 同谓词），**不是** `tail_start_id` 是否存在——全量摘要回退路径的 `tail_start_id` 合法地为 undefined，属 settled 形态之一。回归：`apply accepts a full-summary marker (tail_start_id undefined)`）：无完成摘要指向的 compaction part（摘要在途/失败/重试挂错消息）不作为恢复触发——恢复块不叠加在未生效的完整历史上
- `enabled: false` → 零注入（GAP-3 矩阵）
- 注入位置在 filterCompacted 保留区间内（压缩 tail 之后）→ 后续每轮可见

## 6. 时序/状态契约

- **快照语义（B6 修订声明）**：注入读取压缩结算时刻的磁盘状态，每次压缩恰一次；压缩后模型改文件**不再**追加新 sentinel part（初版 per-step 调用的缺陷随之消除）
- 已声明的接受损失：(a) 压缩落库与注入之间崩溃 → 本次恢复跳过（模型仍有 summary+tail）；(b) 本 PR 之前的存量压缩会话不追溯恢复（总体≈零——本 PR 同时引入该功能）
- 注入点唯一性依赖"V1 压缩只在 task arm 结算"这一既有不变式（`compaction.process` 全仓唯一 caller 即 task arm）

## 7. 不变量契约（property-based）

固定 seed 的 PBT 检查最终文本的文件数、单次及多次渲染的结果、内联区估值及含诊断全文的上限。样本涵盖大量极短 skill、长名称、紧预算和混合材料。真实磁盘与模型投影覆盖同路径缩短、清空、同内容异路径、换行变化和保留的完整读；读工具验证截断或部分读取不产生完整指纹。

## 8. 性能契约（机械化）

- 文件级上限：`file_max_tokens`（字节近似 4/token 先行 stat 拒读大文件）
- 全局预算：`budget_tokens`（render 顺序累计，超即降级）
- 注入成本：每次压缩一次全量历史读（B6 后 per-step 成本为零）

## 9. 安全/副作用契约

- 唯一副作用 = 写入一个 synthetic text part（updatePart）
- 失败绝不打断 loop（顶层 absorb）；读盘/服务失败降级 `missing`
- v1 内部契约（决议 F②）：无插件扩展面、无跨包导出（测试外无 import）

## 10. 跨实现一致性

- core V2 runner 无对应实现（已确认零 V2 消费者；`compaction.ts` V2 孪生文件的摘要输入共享 `summarizeToolText`/exit 行 helper，但 restoration 注入为 V1-only——CLAUDE.md 双运行时条目）
- 注入位置与 roster 同构（synthetic part + 哨兵前缀 + findLast 去重先例）

**摘要超限恢复用例**

同一标记的尝试按 5% 累计档位推进，7% 缺口首档 10%。检查参数/原文/晚到输入的完整性、成功只留一条摘要及无错误通知、耗尽只报告一次，同边界跳档与 25% 总预算上限。见[修复说明](../../fixes/session-fix-summary-overflow-tail.md)。

## 2026-11-19 恢复材料的最终投影

状态 PBT 逐轮验证两份文件的当前版本；包含普通压缩、重放、停止使用旧恢复块。当前授权由 agent、会话及本次工具可见性共同约束。不可访问的历史路径只影响自身，max_files 之外的正文不消耗其他材料预算。测试对照 provider 可见历史与实际磁盘版本；额外验证内建 skill、普通用户文本标记和长 missing reason。

**成功即持久可读。** 即使进程停在摘要 step-finish 和 process 返回之间，再从 DB 读取得到的也是正确的 n、原消息 ID 和晚到输入。验证普通用量、预检、provider 拒绝、前两种和第三种依次发生、并发输入、媒体占位、跨页旧指针及 fork。必保工作量独立于额外尾部上限。[修复契约](../../fixes/session-fix-summary-retained-count.md)

**2026-11-21 原始请求与保留批次。** 插件变换前的原消息 ID 决定保护边界；新 overflow marker 的 `protected_from` 与 `request_user_id` 分别限定附件降级的第一、最后一个原用户。选定请求之后到达的用户附件仍然可见。自动压缩首次选择可选保留区也受主模型可用输入的 25% 限制。核验入口为 prompt 测试中的批次媒体、插件变换性质测试和 compaction 测试中的可选尾部成本、连续压缩附件用例。[修复说明](../../fixes/session-fix-summary-retained-count.md)

### 本轮 Step 5 的机械验证

`compaction.test.ts`、`restoration.test.ts`、`pbt-render-materials.test.ts` 与 `prompt.test.ts` 核对 SQLite 落库、最终模型请求与三连续压缩契约。收敛修复与完整核销见 [PR #60 独立审核收敛修复记录](../../fixes/runtime-fix-pr60-audit-convergence.md)。本地仓库没有通用 contract_audit 生成器。本子计划的功能与合并验收由 [#46](https://github.com/lihaokun/opencode/issues/46) 与 [PR #60](https://github.com/lihaokun/opencode/pull/60) 跟踪。
