# 细化设计 — grep 扩展（search modes / pagination）

> 状态：细化阶段（§4.3），待 §4.4 审查后实施。
> 架构依据：`docs/design/grep-extension/architecture.md`（已确认）。
> 待核实清单核实结果：**rg 无 `--offset` flag**（本机 rg 15.1.0 报 unrecognized，最近似的是语义不同的 `--byte-offset`）→ offset 走架构预留的服务层切片路径；`--files-with-matches`/`--count-matches` 均为纯文本行输出且与 `--no-messages` 兼容；`-A/-B/-C` 在 `--json` 下产生 `type:"context"` 记录（现行 parser 丢弃之——本设计纳入）；既有测试 `test/tool/grep.test.ts` 存在（权限/渲染基线）。

## 1. 范围

- `packages/core/src/ripgrep.ts`：`GrepInput` 扩展（mode/insensitive/before/after/offset）+ args 构造 + context 记录解析 + 按 match 计数的窗口切片
- `packages/opencode/src/tool/grep.ts`：schema 扩展 + 校验 + 分模式渲染 + 三态结局 + metadata
- 测试：`test/tool/grep.test.ts` 扩展（真文件集成：各模式/分页三态/上下文分组/非法表达式/默认路径字节兼容）

不覆盖：multiline / -o / type / 行级分页（架构非目标）；glob 工具、read 工具。

## 2. 与已有代码的复用点

| 项 | 事实 | 复用方式 |
|---|---|---|
| `run` 骨架（`ripgrep.ts:98-147`） | 行级 parse 管道 + `Stream.take(limit+1)` 余量探测 + exit-code 2 的 InvalidPattern 检测（stderr 含 "regex parse error"） | 三种模式共用骨架；InvalidPattern 对文本行模式同样生效（exit 2 语义不变） |
| `Match.make` / `Entry.make` | 现有行构造（path 归一化、单行 2,000 字符截断） | content 模式复用 |
| permission ask | `ctx.ask({ permission: "grep", patterns: [pattern], always: ["*"] })` | 不变 |
| 渲染风格 | `Found N matches…` / `path:` / `  Line X: text` / `(Results truncated…)` | 分模式渲染对齐此风格 |
| rg 15.1.0（本机实证） | `--files-with-matches` → `path\n`；`--count-matches` → `path:count\n`（单文件目标时无 path 前缀，裸 count）；`-A/-B/-C` 需配 `--json` 的 context 记录 | 解析器设计 |

## 3. 错误处理策略

- 非法表达式：`run` 既有 exit-2 检测对所有模式生效 → 工具 error（模型可诊断重试），**三模式一致**
- context 记录解析失败：按行丢弃（context 是附属信息，丢行不致命，`Effect.catch` → undefined）
- `before/after/context` 超限（>10）或 mode 冲突：**工具层校验拒绝**，返回带说明的 error（不静默截断——架构 I2）
- 读文件竞态（搜索中文件被删）：rg 自身容错（`--no-messages` 吞没并继续），服务行为不变

## 4. 数据结构定义

**core `GrepInput` 扩展**：

```ts
export interface GrepInput {
  readonly cwd: string
  readonly pattern: string
  readonly file?: string
  readonly include?: string
  readonly limit: number              // 语义：本页条目数（head_limit）
  readonly offset?: number            // 默认 0；服务内切片
  readonly mode?: "content" | "files_with_matches" | "count"   // 默认 content
  readonly insensitive?: boolean
  readonly before?: number            // 仅 content；0-10
  readonly after?: number             // 仅 content；0-10
  readonly signal?: AbortSignal
}
```

**core 返回**（判别联合 `GrepResult`）：

```ts
export interface GrepRow {
  readonly path: string
  readonly line: number
  readonly text: string        // 已剥离行尾 \r?\n 且按 2,000 UTF-16 单元安全截断
  readonly context: boolean
}

export type GrepResult =
  | { readonly mode: "content"; readonly rows: readonly GrepRow[]; readonly hasMore: boolean; readonly total: number }
  | { readonly mode: "files_with_matches"; readonly files: readonly string[]; readonly hasMore: boolean; readonly total: number }
  | { readonly mode: "count"; readonly counts: readonly { readonly path: string; readonly count: number }[]; readonly hasMore: boolean; readonly total: number }
```

`RawMatch` 的 `path` 与 `lines` 统一使用 `RgText`（`{ text: string } | { bytes: string }`），经 `decodeRgText` 将 base64 字节做非致命 UTF-8 解码，确保非 UTF-8 `match` 与 `context` 行在 `content` 模式与 `files_with_matches`/`count` 同样可用。`content` 模式流元素类型为 `ContentStreamRow = RawRow | { readonly end: true }`。

**tool schema 扩展**（全 optional，`Schema.optional` + annotate 描述）：

```ts
output_mode: "content" | "files_with_matches" | "count"   // 默认 content
insensitive: Boolean
before / after / context: NonNegativeInt（校验 ≤ 10）
offset: NonNegativeInt
head_limit: PositiveInt（默认 100）
```

## 5. 模块细化

### 5.1 core：grep 实现（`ripgrep.ts` grep 分支重构）

- **实现思路**（§4.3.1 六条）：
  1. args 构造（展开式守卫，缺省路径零新增——I1）：
     - 基座（三模式共用）：`--no-config --hidden --no-messages [--glob=include] --glob=!**/.git/**`
     - `insensitive` → `-i`
     - `mode: "files_with_matches"` → `--files-with-matches`（替代 `--json`）
     - `mode: "count"` → `--count-matches`（替代 `--json`）
     - content：`--json`；`before/after/context` > 0 → `-B n` / `-A n` / `-C n`（三者可并存）
     - **`context` 的展开（工具层，2026-10-18 复审核复意见 B4 修正）**：`before = params.before ?? params.context ?? 0`、`after = params.after ?? params.context ?? 0`——`context` 是双侧简写，显式单侧参数逐侧覆盖简写（`{context: 3, after: 1}` ⇒ before=3, after=1）。服务层收到的已是展开后的 `before`/`after`，从不接收 `context` 本身（rg 也没有 `-C` 之外的语义需求：`-C n` ≡ `-B n -A n`）
     - 收尾：`--` + pattern + `file ?? "."`
  2. parse 按 mode 分派：
     - content：`parseJsonLine`（基于 `Schema.UnknownFromJsonString`）解析每行 JSON；`type === "end"` 产出 `{ end: true }`；`type === "match" | "context"` 经 `RawMatch` + `decodeRgText` 解码产出 `RawRow`（`context` 行解析失败降级丢弃，`match` 行结构损坏抛 `Ripgrep.Error`）。`oversizedRecord` 使用 O(1) `line.startsWith('{"type":"context",')` 识别超 64 KiB 的上下文行并丢弃，不在数十 MB 的 match 行上扫描正则。
     - files：行 → 经 `normalizeEntryPath`（仅在 `win32` 替换反斜杠，POSIX 保留字面 `\`）产出相对路径。
     - count：行 → 反向查 `:` 拆出 `path` 与 `count`，校验 `Number.isInteger(count) && count >= 0`；单文件目标时裸数字回退 `input.file`。
  3. 流式跳过与有界窗口（Step P7 / Step P8）：
     - `files_with_matches` / `count`：`run` 在流上计数跳过前 `offset` 条，保留最多 `limit` 条，见第 `offset + limit + 1` 条置 `hasMore = true` 并立即停止流。
     - `content`：`contentPage(offset, limit, before, after)` 维护 `rows`、`pending`（至多 `before` 条同文件前导上下文）、`last`（最后收录的 match）、`seen` 与 `hasMore`：
       - 行文本先剥离行尾 `\r?\n` 再截断至 2,000 字符（保 UTF-16 代理对），避免写入 `Truncate.output` 时每行被计成 2 行。
       - 收到 `{ end: true }`：若已 `hasMore` 立即返回 `true` 停流（当前文件已完结，不再读取后续文件）；否则清空 `pending` 继续。
       - 收到 `context` 行：若贴合 `last`（同文件且 `0 < row.line - last.line <= after`）则入 `rows`，并在 `hasMore && row.line === last.line + after` 时立即返回 `true` 停流；否则若窗口未满且 `before > 0` 则按同文件与 `before` 窗口保留到 `pending`。
       - 收到 `match` 行：`seen++`；若 `seen <= offset` 仅过滤 `pending`；若 `seen <= offset + limit` 则把同文件 `0 < row.line - item.line <= before` 的 `pending` 与本 match 一起入 `rows` 并更新 `last`；若 `seen > offset + limit` 置 `hasMore = true`，若无需继续等后文（`!last || after === 0 || row.path !== last.path || row.line >= last.line + after`）立即返回 `true` 停流。
  4. 退出覆盖：三模式共用 `run` 的退出处理（exit 0 正常 / exit 1 空 / exit 2 非法表达式 → `InvalidPatternError` / 提前停流中断子进程 / 其他失败）。
  5. 循环刻画：`run` 沿有限的 `rg` 输出流消费，每条记录使已消费字节严格递增；`hasMore` 收齐最后必需 `after` 上下文或遇到文件 `end` 时提前中断子进程，终止显然。
- **正确性论证**（non-trivial）：
  - 前置：`input` 经工具层校验（`limit >= 1`、`offset >= 0`、`0 <= before,after <= 10`）；`rg --sort=path` 按稳定路径序输出，文件内行号严格递增。
  - 论证：`seen` 仅在非 context 的 `match` 记录上递增，因此 `rows` 中的非 context 行严格等于 `matches[offset..offset+limit)`；每条入页的 context 行都满足同文件且与某个已入页 match 行距在 `[1, before]` 或 `[1, after]` 内；当 `offset >= matches.length` 时 `last` 恒为 `undefined`，不会收集任何尾部 context 行；当 `hasMore` 为真时，若末条已收录 match 已拿满 `after` 行或所在文件收到 `{"type":"end"}`，函数立刻返回 `true` 停流，不再读取后续文件（从而不会被后续无关文件的超 64 KiB 记录击穿）。
  - 后置：三模式各返回声明形态；`hasMore === true` 时 `total === offset + limit + 1`（下界），EOF 时 `total` 为精确总数；`InvalidPatternError` 通道不变。
  - 副作用论证：只读子进程执行与提前终止，无文件写入。

### 5.2 tool：schema 与校验

- schema 扩展（§4）+ `Effect.gen` 开头的校验块：
  - `context > 10 || before > 10 || after > 10` → throw（带说明："context lines are capped at 10"）
  - `mode !== undefined && mode !== "content" && (before || after || context)` → throw（"context lines only apply to content mode"）
  - `head_limit` 缺省 100；`offset` 缺省 0
- 调用 Ripgrep：`{ ..., limit: head_limit, offset, mode, insensitive, before, after }`
- **callee 契约引用**：Ripgrep.grep 的 post（§5.1 三态）+ InvalidPattern 通道

### 5.3 tool：渲染（分模式）

- **content（无 context）**：`Found N matches…` / `path:` / `  Line X: text`；有分页或 `hasMore` 时附 `Showing matches N-M (offset O, limit L)`。
- **content（有 context）**：行内前缀按 `context` 标志选 `:`/`-`：`  Line 4: matched` / `  Line 3- context`。
- **files_with_matches**：每文件一行绝对路径；头部 `Found N files`（`hasMore` 时标 `at least`）；`offset > 0 || hasMore` 时加 `Showing files N-M (offset O, limit L)`。
- **count**：每行 `path: count matches`；头部 `Found N files (M matches on this page)` + 分页范围行。
- **三态尾部与截断顺序**（三模式一致）：
  - 先对单页主体调用 `trunc.output(body)` 保护字节/行预算，再拼接分页续页提示：
    - `hasMore && !page.truncated` → `(more results available; increase offset to N)`
    - `hasMore && page.truncated` → `(Note: the saved file contains only this page of results; more results available; increase offset to N)`（既不丢失翻页指引，也不误导模型以为保存文件含全量跨页结果）
  - 越界（本页为空且 `offset > 0`）→ `No ${unit} at offset ${offset} (total ${unit}: ${total})`（`content` 用 `matches`，`files_with_matches`/`count` 用 `files`）
  - 无匹配（`offset === 0`）→ `No files found`
- metadata：`{ matches, truncated, output_mode, offset, head_limit, ...(hasMore ? { total_lower_bound } : { total }), ...(page.truncated ? { outputPath } : {}) }`。

### 5.4 测试（`test/tool/grep.test.ts` 扩展）

- **默认兼容**：不传新参数 → args 断言（或输出快照）与改前一致（I1）
- **三模式集成**（临时目录真文件）：content 基线、files（多文件去重路径）、count（多文件 + 单文件裸数字形态）
- **上下文**：-B/-A 交错分组、`:`/`-` 前缀、窗口边界（首个被排除 match 的 context 丢弃——断言按 §5.1 已知边界）
- **分页三态**：有余量 / 恰好到底 / offset 越界（与无匹配的不同文案）
- **insensitive**：大小变体命中
- **校验拒绝**：context=11；files 模式带 context
- **非法表达式**：`[` → error 含 rg 的 parse error 文案（既有行为回归）
- **既有用例不破坏**（权限 ask、无匹配文案）

## 6. 完整性自检 checklist

- [x] 推导连续（5.1 编号步骤 1-5 无跳步；渲染分支逐模式枚举）
- [x] 分支覆盖（mode ×3、context 有/无、hasMore/到底/越界、单文件裸 count、校验拒绝×2）
- [x] 退出覆盖（run 全部退出 + 工具层校验 throw + 三态渲染）
- [x] callee 契约引用（Ripgrep post/错误通道、permission ask 不变）
- [x] 循环刻画（流式 + matchesSeen 单调计数 → 终止）
- [x] 上游事实显式（rg 无 --offset、context 记录形态、单文件裸 count、exit-code 语义——均实证标注）

## 7. 二轮审核修正（2026-11-05，reviewer R2/R7 + 边界三件）

- **跨页顺序稳定（R2）**：三种模式的 rg args 均加 `--sort=path`——rg 默认遍历顺序随调度漂移（实测 11 目录 160 文件、每页 20：多轮去重后 96/104/160 不等），offset 分页要求各次调用遍历相同序列。代价：rg 放弃并行遍历（`--sort` 强制单线程收集）；本工具的 rowLimit 已界定单次工作量，正确性优先，接受该权衡。
- **越末页纯 context（R7a）**：`windowContentRows` 的尾随 context 仅在「本页确实收下过 match」时入页（`page.length > 0` 才收尾 pending）——offset 跳过全部 match 时，最后被跳过 match 的附属 context 不得当作结果行浮出。
- **Showing 范围计 match 不计 context（R7b）**：渲染行的范围上限用 `rows.filter(!context).length`。
- **context 负数（边界①）**：before/after/context 的 schema 从 `Schema.Number` 收紧为 `NonNegativeInt`，负值在参数解码层被拒（原实现静默当 0）。
- **64KiB 记录上限与 context（边界②）**：保留防御上限（match 行超限仍整体失败——不可见的命中比报错更糟）；但 context 行超限时降级为丢弃该行、页面保留其余结果（`oversizedRecord` helper，按记录内 `"type":"context"` 判别）。原实现让一条超长非命中行拖垮整页。
- **换行文件名（边界③，已知限制）**：`files_with_matches` 按 rg 文本行解析路径，POSIX 文件名含换行时会被拆成两个虚构路径；count 模式同理（静态分析，未实测）。rg 的 line-delimited 文本输出无法无歧义表达换行文件名，除非换 `--json` 协议——留作后续修订条件：若实际工作负载出现此类文件名，files/count 迁移到 JSON 输出。

2026-11-19 全量复核修订：P7/P8 在消费 rg 流时计数并跳过 offset。页面按文件及真实行号收集所选命中前后的上下文，跨页共享的上下文可在各自页面出现。非法 UTF-8 的辅助行可省略；真实匹配仍可用。有效 head_limit 至多为配置的工具行上限，渲染后的页面也经工具输出预算保护，超长页面返回预览和该页的全文路径。

## 2026-11-21 有界计数的后置条件

固定目录视图和排序后，选中第 offset+1 至 offset+limit 个条目。按文件名和真实行号附加前后文，同一个匹配只占一项。流上首次看见额外条目只证明总条目数 ≥ offset+limit+1，工具显示至少该数；观察到 EOF 时，已观察条目数才等于实际总数。metadata.matches 只描述当前页，由窗口和已观察条目数推出，返回 total 或 total_lower_bound 之一。当有更多时，读取在最后一个已选匹配所需的后文结束后停止；否则依赖有限的 rg 输入抵达 EOF 或调用方取消。

以原文件的宿主相对路径作为行标识。POSIX 中反斜杠不得改变路径身份，否则两个不同文件还可能在上下文归组时合并。实际 rg 模式分别检查文件名含反斜杠和同名目录结构。
