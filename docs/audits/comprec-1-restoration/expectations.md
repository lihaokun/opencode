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
| `compaction.restoration.budget_tokens` | `number?`（缺省 8000） | 同上 | 同上 | render 单测 + PBT |
| `RESTORATION_SENTINEL` | `"<!-- opencode:restoration -->"`（导出常量） | 细化 §4 | restoration.ts | 测试 import |
| synthetic part | `{ type: "text", text, synthetic: true }` | 细化 §4 | apply → updatePart | 集成测试 |

## 3. 枚举值（机械化）

| 枚举 | 合法集合 | 来源 |
|---|---|---|
| candidate kind | `file \| skill \| todo` | restoration.ts（类型） |
| material status | `inlined \| reference \| skipped-duplicate \| skipped-budget \| missing` | restoration.ts（类型） |

## 4. 流程步骤（机械化）

- P1 触发（**B6 修订**：compaction task arm 内、`process` 返回 `continue` 后注入恰一次；非每 step）
- P2 全量读 messages → 找 compaction part（tail_start_id）与既有 sentinel 位置
- P3 判定：无 compaction → 不动；sentinel 晚于 compaction → 不动
- P4 collect：completed tool parts → read（**B5 修订**：仅 `display.type === "file"`）取 `display.path`、edit 取 `filediff.file`、skill 取 `name`；最近使用排序；todo 追加
- P5 materialize：stat 守卫（File 限定）→ 字节/token 上限 → 读盘 → tail 包含则 skip-duplicate
- P6 render：max_files 逐文件上限 + 预算耗尽降级引用行 → sentinel + 三节（Files/Skills/Todos）+ Not restored
- P7 与上一份 sentinel 逐字节比较，不同才 `updatePart` 落库
- P8 失败吸收：候选级 catch → `missing`；apply 顶层 `Effect.exit` → logWarning，绝不断 loop

## 5. 行为契约（语义）

- 恢复的是**当前磁盘版本**（G1，决议 F① 磁盘重读），与 tail 同版本时去重
- 预算：回填不把刚压小的上下文重新撑满（G3）——超限降级为可诊断引用行
- 幂等（G4）：内容不变不重复写入；多次压缩后不丢不重（GAP-1 三压缩全链）
- `enabled: false` → 零注入（GAP-3 矩阵）
- 注入位置在 filterCompacted 保留区间内（压缩 tail 之后）→ 后续每轮可见

## 6. 时序/状态契约

- **快照语义（B6 修订声明）**：注入读取压缩结算时刻的磁盘状态，每次压缩恰一次；压缩后模型改文件**不再**追加新 sentinel part（初版 per-step 调用的缺陷随之消除）
- 已声明的接受损失：(a) 压缩落库与注入之间崩溃 → 本次恢复跳过（模型仍有 summary+tail）；(b) 本 PR 之前的存量压缩会话不追溯恢复（总体≈零——本 PR 同时引入该功能）
- 注入点唯一性依赖"V1 压缩只在 task arm 结算"这一既有不变式（`compaction.process` 全仓唯一 caller 即 task arm）

## 7. 不变量契约（property-based）

C11 第三组（`test/session/pbt-render-materials.test.ts`，固定 seed）：任意
材料序列（**2026-10-20 独立审勘误：生成器当前只产 `kind: "file"` 的材料**——
skill/todo 类由确定性单测覆盖，PBT 措辞收窄为 file 类序列）下，每 ref 的
inlined 标题数 ≤ max_files；token 预算不超
budget_tokens；渲染幂等（同输入同输出）。collect/materialize/buildTailText
由确定性单测覆盖（目录过滤负例在 B5 修订中加入）。

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
