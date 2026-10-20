# Contract Audit Expectations — `prompt-1-shared-agreement`

> ⚠️ 时序声明：本 expectations 为 **2026-10-18 事后补抽**（PR #60 审核意见 C10）。
> workflow §6.2 要求 Step 0（实施前）产出；本子计划实施时未产出，属流程违例。
> 抽取基线 = 修复批次完成后的 PR head（`c7e631fdaf`），契约源仅限下列文档。
> 注：契约文档随复审修订两处（B7 provider 早返回、D13 委派处方撤销），
> 下表以修订后口径为准，修订记录见 §5/§6 对应条目。

## 1. 契约源（multi-doc）

| 文档 | 用途 | 相关节 |
|---|---|---|
| `docs/design/prompt-unification/architecture.md` | 主契约（G1-G4/非目标/M1-M4） | §1-§5（含 2026-10-18 修订标注） |
| `docs/design/prompt-unification/detailed-design.md` | 细化契约（含 B7/D13 修订标注） | §1-§5 |
| issue #46 §一 / §五 | 需求源（提示词五项 + 全模板一致性验收） | 正文 |
| 调研决议 | `runtime-alignment-research.md` §7 #7-9（含 #7 D13 再推翻记录） | — |
| 既有契约（引用不改） | `preparePayload` 三元 opt-out 语义、`.txt` import 惯例、缓存前缀（模板+SHARED 恒定） | request.ts |

## 2. Schema 字段（机械化）

| 字段 | 类型 | 契约来源 | 实现位置 | 一致性机制 |
|---|---|---|---|---|
| `shared-behavior.txt` | 五规则工作约定，`# Working agreement` 标题 | 架构 §3 | session/prompt/shared-behavior.txt | system 单测 + wire 测试 |
| `provider(model)` 返回 | 裸模板 string（**B7 修订**：早返回；不再返回数组） | 细化 §1（修订段） | system.ts | system 单测 |
| `systemSections(model)` 返回 | `[provider(model), PROMPT_SHARED]`（长度 ≥2，末元素恒 SHARED） | 架构 M1（修订段） | system.ts | system 单测 |
| caller 装配 | `agent.prompt ? [prompt] : SystemPrompt.systemSections(model)` | 架构 §5（I2/I3） | request.ts preparePayload | wire 测试（opt-out） |
| AGENT_DESCRIPTION | 不含委派处方（**D13 修订**：撤回 "When to delegate" 行） | 细化 §5.3（修订段） | tool/agent.ts | wire 负向断言 |

## 3. 枚举值（机械化）

无新枚举。模板路由谓词（muse/gpt-4/gpt-6/codex/gemini/claude/trinity/kimi/
default）为既有分支，本子计划不改判定只改返回——B7 后逐分支早返回。

## 4. 流程步骤（机械化）

- P1 模板路由（provider 早返回，返回裸模板）
- P2 `systemSections` 组装 `[template, PROMPT_SHARED]`（SHARED 恒末位——单一来源不变式）
- P3 preparePayload 三元（显式 prompt 整体替换 → opt-out）
- P4 join 单串（SHARED 在缓存稳定前缀内）
- P5 模板修剪：default/trinity 删三条硬规则（<4 行 / 修改后不解释 / 绝对禁注释）+ 检索优先委派句；保留异步机件说明

## 5. 行为契约（语义）

- G1：10 模板全部以同一 SHARED 段收尾（全分支单测）
- G2（**D13 修订**）：委派时机不再有独立文本资产；机件说明（agent_list/send/stop、不轮询）保留在模板与工具描述；恢复载体若立项应为共享段而非工具描述
- G3：default/trinity 硬规则删除由负向断言背书（`fewer than 4 lines` / `DO NOT ADD ***ANY***` / `just stop` / `One word answers are best` / `prefer to use the agent tool`）
- G4：显式 prompt agent 的替换语义不变（opt-out wire 测试）；AGENTS.md/skills/MCP/plugin transform 装配顺序不变

## 6. 时序/状态契约

- SHARED 恒为 system sections 末元素（在模板之后 → 覆盖残余冲突；在缓存前缀内）
- 无状态、无时序依赖（纯函数 + 静态文本资产）

## 7. 不变量契约（property-based）

行为为纯文本组装，性质由确定性全分支测试覆盖（9 模型 id 遍历 ×2 断言）；
C11 四组 PBT 未含本模块（无算法性输入域）。如未来模板数量增长，遍历测试
天然扩展；无独立 PBT 需求。

## 8. 性能契约（机械化）

- 不触碰缓存前缀的结构（模板路由 + 恒定 SHARED——架构 I3）
- 零运行时开销增量（一次数组构造 + join）

## 9. 安全/副作用契约

- 无副作用（纯函数/静态文本）
- 唯一风险点 `.txt` import 路径错误 → 编译期失败（细化 §3）

## 10. 跨实现一致性

- core V2 runner 不消费 `SystemPrompt`（V1-only；CLAUDE.md 双运行时条目——V2
  摘要输入经 `summarizeToolText` 共享的 helper 与本子计划无交叠）
- wire 级背书：default agent 线上含 SHARED、被删规则与委派处方均不在
  （prompt.test）；显式 prompt 线上两者皆无（opt-out）
