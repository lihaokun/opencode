# Contract Audit Expectations — `grepext-1-search-params`

> ⚠️ 时序声明：本 expectations 为 **2026-10-18 事后补抽**（PR #60 审核意见 C10）。
> workflow §6.2 要求 Step 0（实施前）产出；本子计划实施时未产出，属流程违例。
> 抽取基线 = 修复批次完成后的 PR head（`c7e631fdaf`），契约源仅限下列文档。

## 1. 契约源（multi-doc）

| 文档 | 用途 | 相关节 |
|---|---|---|
| `docs/design/grep-extension/architecture.md` | 主契约（G1-G5/非目标/流程） | §1-§3 |
| `docs/design/grep-extension/detailed-design.md` | 细化契约（含 2026-10-18 B4 复审修订：context 展开） | §1-§6 |
| issue #46 §三.4 / §五.8 | 需求源（搜索可控性 + 三结局分页验收） | 正文 |
| 既有契约（引用不改） | `Ripgrep.Service`（run 的退出覆盖：exit0/1/2 语义）、grep 权限键、`legacy grep` 工具（第二消费者，不动） | — |

## 2. Schema 字段（机械化）

| 字段 | 类型 | 契约来源 | 实现位置 | 一致性机制 |
|---|---|---|---|---|
| `output_mode` | `content \| files_with_matches \| count`（缺省 content） | 架构 G1 | Parameters + search | wire 快照 |
| `insensitive` | `boolean?`（rg `-i`） | 架构 G4 | 同上 | wire 快照 + 用例 |
| `before` / `after` | `number?`（≤10，content only） | 架构 G2 | 同上 | wire 快照 + 校验测试 |
| `context` | `number?`（≤10，content only）——**双侧简写**；显式 before/after 逐侧覆盖（B4 修订：`before = params.before ?? params.context ?? 0`） | 细化 §5（2026-10-18 修订段） | execute 展开 | context 简写测试 |
| `offset` | `number?`（服务层切片；rg 无 `--offset` flag——细化 §0 实证） | 细化 §0 | search take/slice | 分页测试 |
| `head_limit` | `number?`（默认 100，兼容现状） | 架构 G3 | execute | 分页测试 |
| 渲染路径 | 绝对路径（三模式一致，`rowBase` 解析） | 细化 §5 | execute 渲染 | 各模式用例 |

## 3. 枚举值（机械化）

| 枚举 | 合法集合 | 共享机制 |
|---|---|---|
| output_mode | `"content" \| "files_with_matches" \| "count"` | `Schema.Literals` 单一定义（tool/grep.ts） |
| 分页结局 | has-more / exact-end / offset-beyond / no-matches（四种可区分输出） | 架构 G3（issue 验收 §五.8） |

## 4. 流程步骤（机械化）

- P1 schema 解析（新参数全 optional，缺省 = 现行为）
- P2 校验：before/after/context ≤10；context 行仅 content 模式
- P3 权限 ask（patterns=[pattern]，不变）
- P4 `context` 展开（B4：before/after 逐侧覆盖简写）
- P5 路径解析 + 外部目录断言（既有）
- P6 按 mode 分派 rg args（content=`--json`；files=`--files-with-matches`；count=`--count-matches`；`-B/-A`、`-i`）
- P7 解析（content 接受 match+context 记录；count 单文件裸数字回退）
- P8 match 计数窗口切片（context 永不计数/拆分）
- P9 渲染（绝对路径）+ 分页结局文案

## 5. 行为契约（语义）

- G5 兼容：全部新参数缺省时输出与现状**结构一致**（2026-10-20 独立审勘误：截断尾行文案被分页状态行取代——旧行文 exactly-100 误报缺陷顺带修复；架构决策 1 修订段为准，"逐字节"措辞废弃）
- context 行跟随 match，永不跨页拆分；match 永不丢失（细化已知边界：边界单侧 context 可能缺失）
- 校验拒绝可诊断（error 文案含 "capped at 10" / "only apply to output_mode=content"——2026-10-20 独立审勘误：初稿子串与实现文案不匹配）
- 大小写敏感默认不变

## 6. 时序/状态契约

- 无跨调用状态（分页靠 offset，服务层无游标——架构选型"条目级分页"）

## 7. 不变量契约（property-based）

C11 第二组（`test/tool/pbt-grep-pagination.test.ts`，固定 seed）：
任意窗口 = `matches[offset..offset+limit)`（不重不漏、顺序保持）；按 offset
走窗覆盖全部 match 恰好一次；`total = hasMore ? offset+limit+1 : 全量`；
锚例钉死边界 context 归属（前一页尾部 context 丢弃、下一页带自己的前导
context）。模型与 `ripgrep.ts` content 窗口逐行对应。

## 8. 性能契约（机械化）

- `head_limit` 缺省 100（与现状一致）
- context 上限 10（架构 G2）

## 9. 安全/副作用契约

- 权限键 `grep` 不变；外部目录断言沿用
- rg 以 `--no-config --no-messages` 运行（不读用户配置、无 stderr 噪声）

## 10. 跨实现一致性

- `legacy grep` 工具（filesystem/search.ts 消费者）零改动——双消费者不串扰（回归背书）
- ZCode grep 契约为参照：mode/head_limit/offset 对齐，`-o`/`type`/`multiline`/行级分页为已记录非目标（架构 §1）

## 2026-11-19 分页的文件及上下文归属

真实 rg 小目录测试生成多个文件、相隔命中、before/after 和分页；额外验证相邻命中共享前文、非 UTF-8 辅助行、深 offset、结果字节预算及下一页或全文入口。已复核 61,200 个窗口。实现 P7、P8 对应流式计数和上下文选择；固定路径排序适用于全部模式。

## 2026-11-21 可观察的页计数和路径

工具 metadata.matches 是返回条目数。P9 未抵达 EOF 时给 total_lower_bound 和 “at least” 文案；EOF 时给真实 total，包括 offset 越界的空页。随机生成三种模式、offset 和 limit，用已知文件集合验证元数据和文案。真实 POSIX 目录中的字面反斜杠和路径分隔符代表不同文件，三种模式都须能区分。

### 本轮 Step 5 的机械验证

grep.test.ts、pbt-grep-pagination.test.ts、Core ripgrep.test.ts 对照实际文件和服务层窗口。独立复审与未覆盖范围见 [本轮修复记录](../../fixes/runtime-fix-pr60-boundary-regressions.md)。本地仓库没有通用 contract_audit 生成器。本子计划的功能与合并验收由 [#46](https://github.com/lihaokun/opencode/issues/46) 与 [PR #60](https://github.com/lihaokun/opencode/pull/60) 跟踪。
