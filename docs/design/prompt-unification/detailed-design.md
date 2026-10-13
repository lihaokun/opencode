# 细化设计 — 提示词统一（prompt-unification）

> 状态：细化阶段（§4.3），待 §4.4 审查后实施。
> 架构依据：`docs/design/prompt-unification/architecture.md`（已确认，含共享段与委派指导草稿文案）。
> 待核实清单已全部核实：模板无快照固化（H1）；trinity/default 删除行号逐一核对（本文 §5.2）；agent 工具描述位置为 `tool/agent.ts:63-75` 的 `AGENT_DESCRIPTION` 行数组常量；`system.test.ts` 断言风格为 `provider(...)[0]` + `toContain`。

## 1. 范围

- 新文本资产 `packages/opencode/src/session/prompt/shared-behavior.txt`
- `session/system.ts`：`provider` 重构为单一返回表达式 `[template, PROMPT_SHARED]`
- `session/prompt/default.txt` 与 `trinity.txt`：按删除清单修剪
- `tool/agent.ts`：`AGENT_DESCRIPTION` 追加 "When to delegate" 行
- 测试：`system.test.ts` 新增断言（共享段全分支覆盖 + 模板删除规则 + 机件行保留）；`test/tool/__snapshots__/parameters.test.ts.snap` 若因描述变更产生 diff 则随行为变更更新（实施时核实）

不覆盖：其余 8 份模板（非目标）、消息内注入通道（非目标）、`request.ts`（架构 I2/I3 保证不触碰）。

## 2. 与已有代码的复用点

| 项 | 事实 | 复用方式 |
|---|---|---|
| 模板 `.txt` import 惯例 | 全部模板经 `import PROMPT_X from "./prompt/x.txt"` 引入（`system.ts:6-16`） | `shared-behavior.txt` 同构 |
| `system.test.ts` 断言风格 | `provider(...)[0]` + `toContain`（`:89,98,107`），无数组精确断言 | 共享段放 `[1]`，既有断言零改动 |
| `AGENT_DESCRIPTION` 行数组 | `tool/agent.ts:63-75`，`.join("\n")`，fork 异步语义已在其内 | 追加指导行，格式同构 |
| 哨兵词 | 三条硬规则字串唯一（grep 验证：`fewer than 4 lines` / `DO NOT ADD ***ANY***` / `just stop`） | 删除后作为测试的负向断言词 |

## 3. 错误处理策略

纯文本资产与纯函数变更，无错误通道。唯一风险点：`.txt` import 路径错误 → 编译期失败（非运行时），typecheck 拦截。

## 4. 数据结构定义

无新类型。新增文本资产：

- `shared-behavior.txt`：内容 = 架构 §3 草稿终稿（五条规则，`# Working agreement` 标题）
- `AGENT_DESCRIPTION` 追加 1 行（委派指导，见 §5.3）

## 5. 模块细化

### 5.1 system.ts — provider 重构

- **实现思路**：10 个 `if` 分支的 `return [PROMPT_X]` 改为对 `template` 变量赋值（muse 分支保留 `replaceAll("{{MODEL_NAME}}", name)`），函数末尾单点 `return [template, PROMPT_SHARED]`。
- **分支覆盖**：muse/gpt-4|o1|o3/gpt(6|codex|其他)/gemini/claude/trinity/kimi/default 十路全部改为赋值；无遗漏（与现分支一一对应）。
- **退出覆盖**：单返回点。
- **正确性论证**：等价性——每分支赋值的模板与原返回元素逐一相同，新增末元素恒为 `PROMPT_SHARED`（单一常量来源 ⇒ I1 结构性成立）；既有测试取 `[0]` + `toContain` ⇒ 输出对既有断言逐字节兼容。trivial + 单点收口理由（无分支逻辑新增）。

### 5.2 模板修剪（删除清单，行号为当前 dev 基线核对值）

**default.txt**：

| 行 | 内容摘要 | 处置 | 依据 |
|---|---|---|---|
| L18 | unnecessary preamble or postamble（含 summarizing your action） | 删 | 规则 (a) 族：与自包含摘要交付正面冲突 |
| L19 | fewer than 4 lines 段（含 One word answers are best 与示例引导句） | 删 | 规则 (a) |
| L20-51 | `<example>` 示例块（7 个） | 删 | 示例专用于演示被删的极短回答规则；工具并行的指导已存在于 Tool usage policy（L83 批量调用句） |
| L53-57 | Proactiveness 1/2 | **保留** | 软性平衡表述 |
| L58 | Do not add additional code explanation summary / just stop | 删 | 规则 (b) |
| L67 | Following conventions 节 | **保留** | 与共享段注释密度指导互补 |
| L68 | DO NOT ADD ***ANY*** COMMENTS | 删 | 规则 (c) |
| L81 | When doing file search, prefer to use the agent tool | 删 | 委派指导移交工具描述（决议 E①） |
| L82 | Agents are asynchronous... agent_list/send/stop | **保留** | fork 机件说明（G2"机件"部分） |
| L85 | 第二处 fewer than 4 lines | 删 | 规则 (a) |
| L17 | minimize output tokens **while maintaining helpfulness** | **保留** | 有 qualify 的软性表述，与共享段不冲突 |

**trinity.txt**（行号已核对）：

| 行 | 处置 |
|---|---|
| L10 | 删（同 default L18） |
| L11 + L12-53 示例块 | 删（同 default L19+示例） |
| L60 | 删（同 default L58） |
| L70 | 删（同 default L68） |
| L83 | 删（同 default L81） |
| L84 | **保留**（异步机件） |
| L89 | 删（同 default L85） |
| L74 / L85-87 | **保留**（trinity 特有：one tool per message、question tool、防循环——非冲突规则） |

### 5.3 agent.ts — AGENT_DESCRIPTION 追加

在行数组末尾（`nesting` 行之后）追加一行（与既有行风格一致）：

```
"- When to delegate: the task matches one of the available agent types, you have independent work that can run in parallel, or answering would mean reading across several files — delegate it and keep the conclusion, not the file dumps. For a single-fact lookup where you already know the file, symbol, or value, search directly. Once you have delegated a search, do not repeat it yourself — wait for the result",
```

正确性论证：trivial + 纯指导文本追加（无 schema/行为变更）；单一来源断言由 §5.4 的模板负向断言背书（default/trinity 不再含委派指导）。

### 5.4 测试

`system.test.ts` 追加：

1. `appends the shared working agreement to every model template`：遍历分支模型 id（muse-spark / gpt-4 / gpt-6 / codex / gemini / claude / trinity / kimi / default）→ `const [template, shared] = SystemPrompt.provider(m)` → `shared` 以 `# Working agreement` 开头；`template` 不含三条硬规则字串。
2. `drops the hard brevity, no-explanation and no-comment rules from default and trinity`：import 两份 `.txt` → 逐条 `not.toContain`（`fewer than 4 lines` / `One word answers are best` / `just stop` / `DO NOT ADD ***ANY***` / `prefer to use the agent tool`）+ 正向 `toContain`（异步机件句 `Do not poll or ask an agent whether it has finished`）——负向证明删除、正向证明机件未误删。
3. 快照核实：`test/tool/__snapshots__/parameters.test.ts.snap` 若含 agent 工具描述则随更新，理由"指导文本变更"（workflow 允许的用例随契约更新，更新记录在 devlog）。

### 5.5 实施顺序

1. `shared-behavior.txt` 新增 + `system.ts` 重构 + system.test 新断言（一次原子提交可先行验证 I1）
2. default/trinity 修剪 + 负向断言
3. agent.ts 追加 + 快照核实
4. 全量回归 + 行为场景人工抽查清单（issue §五口径：行动请求 / 纯问答 / 工具失败 / 已有授权——以 default 模板跑一轮真实会话抽查，记录于 devlog，不作为通过门槛）

## 6. 完整性自检 checklist

- [x] 实现思路推导连续（5.1 单返回点、5.2 逐行清单、5.3 单行追加）
- [x] 分支覆盖（provider 十路分支逐一映射为赋值；模板删除清单正反向均列）
- [x] 退出覆盖（provider 单返回点；文本资产无退出通道）
- [x] callee 契约引用（`request.ts:195` 三元契约、`system.test.ts` 既有断言兼容性、快照测试的更新条件均已标注）
- [x] 循环刻画（无循环；遍历断言为有限集合）
- [x] 上游事实显式列出（H1 快照核实结论、行号核对值、`AGENT_DESCRIPTION` 位置均已标注行号）
