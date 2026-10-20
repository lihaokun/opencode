# 架构 — grep 扩展（search modes / pagination）（issue #46 P2-item-1）

> 状态：调研 + 架构合并稿（小 feature，两阶段合一，待确认后进细化）。
> 关联：issue #46 §三.4（"搜索工具的可控性有实际差距"）与 §五验收第 8 条；参照 `docs/research/zcode-replacement-assessment.md` §4.1（ZCode Grep 契约）。

## 0. 调研结论（§4.1 合并）

**现状**（`tool/grep.ts` + `core/ripgrep.ts`）：

- schema 仅 `pattern/path/include`；固定 `limit: 100`；输出格式固定为 content 行（`Found N matches…\n path:\n  Line X: text`）
- `Ripgrep.Service.grep` 是刻意薄的执行适配器（接口注释："deliberately exposes raw process-oriented rows"）——接受 `GrepInput {cwd, pattern, file?, include?, limit}`，内部拼 `rg --json --hidden --no-messages [--glob=…] -- pattern <path>`
- 扩展点清晰：扩 `GrepInput` + args 构造即可；上下文行、计数、文件列表、大小写是 **rg 原生 flag**（`-A/-B/-C`、`--count-matches`、`--files-with-matches`、`-i`）；~~偏移~~ **2026-10-20 独立审清扫**：rg 无 `--offset` flag（细化 §0 已实证），偏移由服务层切片实现——本行初稿与细化 §0 及决策 3 矛盾，以细化为准
- 非法表达式已有专门错误通道（`Ripgrep.InvalidPatternError` → 工具 error）✓；无匹配已有区分（"No files found"）✓；缺的是**输出模式、上下文行、分页**

**参照（ZCode `contracts/src/tools/grep.ts`）**：`output_mode(content|files_with_matches|count)`、`-A/-B/-C/context`、`-n`、`-i`、`-o`、`type`、`head_limit`、`offset`、`multiline`；输出回显 `[Showing results with pagination = limit: N, offset: M]` 并返回 `truncated/appliedLimit/appliedOffset`。

## 1. 目标与非目标

**目标**

- **G1 输出模式**：模型可选择 `content`（默认，现行为）/ `files_with_matches`（先定位文件）/ `count`（按文件计数）三种模式
- **G2 上下文行**：content 模式下可取匹配行的前后文（`before`/`after`/`context`，上限 10 行）
- **G3 分页**：`head_limit`（默认 100，兼容现状）+ `offset`；**显式区分**无匹配、分页越界、仍有余量三种结局（issue 验收第 8 条）
- **G4 大小写**：`insensitive` 开关（rg `-i`）
- **G5 兼容**：全部新参数 optional；不传时输出与现状**结构一致**（2026-10-20 独立审修订：截断尾行文案被分页状态行取代——旧行文 exactly-100 误报缺陷顺带修复；P0-1/P0-3 的退出码与摘要行为不受影响）

**非目标（记录理由与引入条件）**

- **`multiline`（跨行匹配，rg `-U`）**：不是加 flag 而是引擎模式变更——`--json` 记录语义随之改变（`lines.text` 含内嵌换行、`line_number` 只标起始行），现有渲染/单行截断/上下文行全部假设单行记录；且跨行 match（如 `.*`）可吃掉整个文件的体量，单行 cap 管不住，需要新的聚合预算机制。**已有退路**：模型可经 shell 工具直接 `rg -U`，能力无损失。引入条件：真实任务需要跨行搜索且 shell 退路被证明别扭。
- **`-o`（只输出匹配段）**：又一种渲染格式（丢行上下文），且计数语义分叉（`--count-matches` 数出现 vs `-c` 数行数）。主用途（提取标识符/URL）的退路是 grep 定位后 read 精读。**`type`（语言过滤）**：`include` glob 已覆盖主场景（含 `{ts,tsx}` 花括号组），`type` 只提供别名便利，且 rg 的 type 定义绑定 bundle 版本（版本敏感点，见细化清单）。引入条件：glob 被证明表达不了某个真实过滤需求。
- **行级分页（CC 语义：`head_limit`/`offset` 按输出行计数）**：CC 语义的别扭点在上下文行也计入行数——翻页可能切在"match + 上下文组"中间，模型拿到半组上下文。本设计取**条目级**（匹配行/文件/计数条目，上下文行跟随 match 永不拆分）：语义可预测、免 offset 记账，且 **ZCode 同为条目级**——连对齐参照的理由都不存在。引入条件：真实工作流需要输出行字节级窗口（shell `rg | sed -n` 退路覆盖）。
- **glob 改名（include → glob）**：改名是破坏性契约变更（已保存会话/插件/脚本在用 `include`），收益仅为与 ZCode/CC 同名——issue 原文明确"不必仅为名字一致重命名"，且无能力损失。引入条件：`glob` 成为事实标准名时加**别名**（两者都收），纯增量低成本。

## 2. 核心流程

```
grep tool execute
  ├─ schema 解析（新参数全 optional，缺省 = 现行为）
  ├─ permission ask（不变，patterns=[pattern]）
  ├─ Ripgrep.Service.grep（GrepInput 扩展）：
  │    args 追加：
  │      insensitive → "-i"
  │      files_with_matches → "--files-with-matches"（解析 Entry 行，无行号/文本）
  │      count → "--count-matches"（解析 count 行）
  │      content → 现状 --json
  │      before/after/context → "-A n" / "-B n" / "-C n"（仅 content）
  │      offset → 服务内切片（rg 无 --offset flag，已核实；取数 limit+offset+1 条后 slice）
  ├─ 渲染（按模式）：
  │    content   → 现格式 + 状态行 "Showing matches N–M (offset O, limit L)"
  │    files     → 每文件一行（路径）
  │    count     → "path:count" 行
  │    尾部      → hasMore ? "(more matches available; increase offset)" : 无
  │    越界      → "No matches at offset O (total T)"（与无匹配区分）
  └─ metadata：{ matches, truncated, output_mode, offset, head_limit }（UI 用，模型正文见上）
```

## 3. 数据结构（§3.1）

**GrepInput（core，扩展）**：新增 `mode?: "content" | "files_with_matches" | "count"`、`insensitive?: boolean`、`before?: NonNegativeInt`、`after?: NonNegativeInt`、`offset?: NonNegativeInt`；`limit` 语义变为 head_limit。不变量：`before/after/context ≤ 10`（工具层校验，防滥用）；`mode ≠ "content"` 时 before/after 无效（工具层拒绝并说明）。

**grep tool schema（扩展，全 optional）**：`output_mode`、`insensitive`、`before`、`after`、`context`、`offset`、`head_limit`。默认值 = 现行为（content / 100 / 0）。

**Match 类型**：content 模式不变；files/count 模式服务层新增轻量返回形态（Entry[] / {path, count}[]）——细化时定具体 shape（倾向独立小类型，避免 Match 可选字段膨胀）。

## 4. 模块划分与功能规约

### M1 `core/ripgrep.ts`（执行适配器扩展）

`GrepInput` 扩展 + args 构造 + 两种新解析器（files 行、count 行，均为 rg `--json` 之外的简单文本行——**决策：files/count 模式不走 --json**，rg 的 `--files-with-matches`/`--count-matches` 原生输出是纯文本行，逐行解析即可，复用 `run` 的行解析骨架）。~~`--offset` 为 rg 原生 flag，服务内不需要 slice~~（**2026-10-20 独立审清扫**：rg 15.1.0 无 `--offset`，与细化 §0 实证矛盾；实际实现即服务层 `take(limit+offset+1)` + slice，见决策 3）。

### M2 `tool/grep.ts`（工具层）

schema 扩展 + 校验（context 上限 10、mode 与 context 互斥说明）+ 渲染分模式 + 状态行/越界行 + metadata 扩展。权限 ask 不变。

### M3 测试

- 单元：渲染三分支 + 越界 + hasMore + 默认参数兼容（不传新参数 → args 与渲染结构与改前一致；**截断尾行文案例外，见 G5 修订**）
- 集成：临时目录真文件上跑 rg（content/context/files/count/insensitive/offset 各一 + 非法表达式 + 分页越界）
- 既有 grep 测试不破坏（若有）

> **2026-10-20 独立审补充（§6.5 路径 B）**：细化 §5.4 点名的"非法表达式回归"与"真 rg 窗口边界"两测试实施时遗漏（前者 commit message 曾误称已含），已在修复批次补齐。

## 5. 接口规约（§3.3）

**接口：tool/grep.ts → Ripgrep.Service**：`GrepInput` 扩展为超集；服务责任：按 mode 选择 rg 形态并返回对应行 + **全量条目计数 `total`**（非页切片长度——越界文案引用的是全量）；非法 pattern 仍走 `InvalidPatternError`；limit 语义 = 本页条目数（服务内完成 offset 跳过）。

**接口：模型 → grep 工具**：新参数全 optional；`offset`/`head_limit` 有 schema 级非负/正整数约束。缺省行为与旧版兼容（G5/I1，**修订**见下）。

## 6. 关键设计决策

1. **默认模式 = content 且兼容**（**2026-10-20 独立审修订**：*"逐字节一致"收窄为"结构兼容"*）：不传新参数时 rg args 与渲染结构与现状一致；例外是 **≥limit 截断时的尾行文案被分页状态行取代**（旧 `Found N matches (more matches available)` + `(Results truncated…)` 的尾缀组合 → `(more results available; increase offset to N)`）——旧行文在 exactly-100 条时会误报截断，新状态行顺带修复该缺陷；存量会话中该文案只出现在截断场景，摘要投影不受影响（I1 以"默认路径零新 args + 渲染结构不变"为准，文案字面除外）。
2. **分页做在条目级**（匹配行/文件），`head_limit` 缺省 100 与现状一致；"仍有余量"用取数 `limit+offset+1` 探测。
3. **files/count 不走 --json**：rg 原生文本行更简单，且服务层注释明确自己是行适配器——保持一致。**offset 无 rg 原生支持**（已实证 rg 15.1.0 无 `--offset` flag），由服务层 `take(limit+offset+1)` + slice 实现，语义不变。
4. **context 参数名用 before/after/context 而非 `-A/-B/-C`**：schema 键避免 dash 开头；ZCode 的 dash 风格是 CC 兼容面，fork 无此包袱。
5. **不新增工具**：扩展现有 grep（issue："可以扩展现有工具或提供等效能力，不必仅为名字一致重命名"）。

## 7. 架构正确性论证（§4.2.1）

**goal → 模块映射**：G1/G4 → M1+M2；G2 → M1（-A/-B/-C）+ M2（渲染含上下文行）；G3 → M1（offset/取数探测）+ M2（状态行三分支）；G5 → M2 默认参数路径 + 单元快照。

**协作论证**：G3 要求区分三种结局。M1 取数 `limit+offset+1` 条 ensures 可判定 hasMore（取得 > offset+limit ⇒ 有余量；≤ 且非空 ⇒ 恰好到底；offset ≥ 总数 ⇒ 越界）；M2 按 hasMore/空页/越界三态渲染 ensures 模型可区分 ⇒ G3。G1/G2/G4 为 rg 原生能力的参数透传 + 渲染分支，等价性由默认路径字节兼容断言兜底 ⇒ 成立。

**关键假设**

- H1：rg 二进制版本支持 `-A/-B/-C`（~~含 `--offset`~~ **2026-10-20 清扫**：rg 无 `--offset`，offset 走服务层切片——细化 §0 实证；bundle 的 ripgrep 由 `RipgrepBinary` 管理）
- H2：`--json` 与文本行模式在 `run` 骨架内可共存（run 的 parse 是行级函数，与输出格式无关——事实）
- H3：content 模式默认路径（无新参数）不触发任何新 args ⇒ 兼容由构造审查 + 单元测试保证（截断尾行文案例外，决策 1 修订）

**模块级不变量**

- I1：无新参数时，rg args 与渲染输出**结构**和现状一致（截断尾行文案例外——决策 1 修订）；空结果 metadata 反映本次请求的 mode/offset/limit — 维护方：M2 默认参数路径 + 单元测试
- I2：`before/after/context ≤ 10` 与 mode-context 互斥在工具层强制 — 维护方：M2 schema 校验（超限拒绝并说明，非静默截断）

**preservation 论证**：I1 的破坏途径是新参数缺省时混入新 args——M1 的 args 追加全部以参数存在为条件（展开式守卫）；I2 由工具层入口单点校验。

## 8. 细化阶段待核实清单

- bundle 的 ripgrep 版本下限（`RipgrepBinary` 管理的版本是否支持 `--offset`；不支持则 offset 在服务层 slice 实现，语义不变）
- files/count 解析的行形态（rg 对 `--files-with-matches`/`--count-matches` 的确切输出格式与 `--no-messages` 的交互）
- 既有 grep 测试清单（`test/tool/grep.test.ts` 是否存在、覆盖哪些）
- 渲染状态行的确切措辞（对齐既有 "Found N matches" 风格）
