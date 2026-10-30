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

**core 返回**（按 mode）：

```ts
content: readonly Match[]                                     // 不变（Match 含 context 行 → 见 Row）
files_with_matches: readonly string[]                          // 相对路径
count: readonly { path: string; count: number }[]
```

content + context 时 `Match` 增加 `context?: boolean`（该行是否上下文行；渲染据此选 `:`/`-` 前缀）。**决策**：不引入独立的 ContextRow 类型，context 行复用 Match 形态 + 标志位（避免工具层联合类型展开；`Match.context` 为可选字段，无消费方时无害）。

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
     - content：现 RawMatch 解析扩展——接受 `type: "match" | "context"`（同一 data shape），产出 `{ ...match.data, context: type === "context" }`
     - files：行 → 相对路径字符串（同 glob 的归一化）
     - count：行 → `path:count`；**单文件目标时裸数字** → path 取 `input.file`，count 取数字
  3. 窗口切片（offset）：run 的输入扩展 `offset`；`Stream.take(limit + offset + 1)` → `rows.length > limit + offset` ⇒ hasMore 且 `items = rows.slice(offset, offset + limit)`；`rows.length <= offset` ⇒ `items = []`（越界）且 hasMore=false
  4. content + context 的窗口计数：切片计数**按 match 记录**而非原始行——实现为 parse 后的有状态 filter：维护 `matchesSeen`；match 记录使计数 +1，超过 `limit + offset` 后丢弃该记录及后续（首个被排除 match 的前导 context 一并丢弃）；context 记录在 `matchesSeen >= 1` 后保留（附着于已计入的 match）。**已知边界**（显式接受）：rg 的 context 去重可能使窗口边界处的 match 丢失一侧上下文行——match 本身永不丢失
  5. 退出覆盖：三模式共用 run 的全部退出（正常/exit1 空/exit2 非法表达式/其他失败）
  6. 循环刻画：流式有限处理；`matchesSeen` 单调递增 → 终止
- **正确性论证**（non-trivial）：
  - 前置：input 经工具层校验；rg 语义如 §2 核实
  - 论证：args 展开守卫保证缺省参数时 args 与现状逐项一致 ⇒ I1（字节兼容）。窗口切片：`take(limit+offset+1)` 使「是否还有更多」可由行数判定（>limit+offset ⇒ 有余量）——条目级（files/count 天然条目；content 按 match 计数）⇒ 三态结局可判定 ⇒ G3。context 的有状态过滤：matchesSeen 只在 match 记录上递增 ⇒ offset/limit 语义以 match 为单位（架构决策）⇒ G2 的上下文行跟随 match 且不跨 match 计数
  - 后置：三模式各返回声明形态；InvalidPattern 错误通道不变
  - 副作用论证：无新副作用（进程执行既有）

### 5.2 tool：schema 与校验

- schema 扩展（§4）+ `Effect.gen` 开头的校验块：
  - `context > 10 || before > 10 || after > 10` → throw（带说明："context lines are capped at 10"）
  - `mode !== undefined && mode !== "content" && (before || after || context)` → throw（"context lines only apply to content mode"）
  - `head_limit` 缺省 100；`offset` 缺省 0
- 调用 Ripgrep：`{ ..., limit: head_limit, offset, mode, insensitive, before, after }`
- **callee 契约引用**：Ripgrep.grep 的 post（§5.1 三态）+ InvalidPattern 通道

### 5.3 tool：渲染（分模式）

- **content（无 context）**：现格式不变（`Found N matches…` / `path:` / `  Line X: text`）
- **content（有 context）**：行内前缀按 `context` 标志选 `:`/`-`：`  Line 4: matched` / `  Line 3- context`
- **files_with_matches**：每文件一行路径；头部 `Found N files`
- **count**：每行 `path: count matches`；头部 `Found N files with M total matches`（总数 = Σcount）
- **三态尾部**（三模式一致）：
  - hasMore → `(more matches available; increase offset to N)`
  - 越界（items 空 且 offset > 0）→ `No matches at offset ${offset} (total ${total})`——与无匹配区分
  - 无匹配（offset=0）→ 现状 `No files found`
- metadata：`{ matches, truncated, output_mode, offset, head_limit }`（matches 语义按模式：匹配行数/文件数/文件数）

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
