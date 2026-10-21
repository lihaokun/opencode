# Issue #74：模型条件化工具替换导致路径门控集成停摆 — 分析与修正方案

> 对应 issue：[lihaokun/opencode#74](https://github.com/lihaokun/opencode/issues/74)（[Integration] GPT apply_patch-only tool set stalls path-gated FSM workflows）
> 分析版本基线：`v1.18.31-fmv2.1`（受影响 release），当前 `dev` HEAD `d9d7de31fb`（两者相关逻辑逐字一致）
> 文档性质：问题 + 根因 + 调研 + 修正方案（工作流 §7.1 八部分），合一文档。
> 状态：**已实施**（2026-10-21，`fix/issue-74-model-conditional-tools` 分支，实施 commits 见第七部分回填）。

## 第一部分：现象与复现

### 1.1 现象

用户实验环境（外部 FSM 集成 + `mcp-server-fsm` 插件）在把已有 FSM 驱动工作流的模型切换为 `openai/gpt-6-luna` 后停摆：

- `GET /experimental/tool?provider=openai&model=gpt-6-luna` 返回的工具列表含 `apply_patch`，**不含** `write` 和 `edit`。
- worker 尝试创建分配给它的 artifact 文件（`proof/analysis-state/tasks/<batch>/collection.md`）时，外部 FSM gate 拒绝：

  ```text
  FSM gate: apply_patch is not allowed.
  Reason: not in whitelist for state B_COLLECT.
  ```

- 之后根会话与 worker 进入持续空转：07:30–08:22 UTC 内分别发出 42 和 89 次 `agent_send` 调用（issue 作者声明这是通信量计数，不声称每条消息内容相同），worker 始终停留在 `B_ANALYZE`，formal draft 未变，`submission.json` 始终不存在。
- 环境要点：原生 opencode 权限策略已 wildcard allow（阻塞点不在原生权限），无 pending 原生 permission/question；阻塞完全来自外部 FSM 插件的路径门控。

### 1.2 复现路径（issue 提供，已核实与代码一致）

1. 安装一个外部 `tool.execute.before` 集成，把 `write`/`edit` 的 `filePath` 映射进路径感知的写门控；且故意不把任意 shell 写入加白名单（避免绕过路径授权）。
2. 配置一个有效工具集选择 `apply_patch`、排除 `write`/`edit` 的 GPT 模型。
3. 要求 worker 在一个本应允许的路径下创建 artifact。
4. worker 使用 `apply_patch`；集成收到不同的工具名和 `patchText` 参数（而非 `filePath`），拒绝调用。
5. 仅发送"继续"类消息无法恢复不可用的工具，也无法解决路径门控失配。

单元级最小复现（无需外部插件，作为回归测试素材）：

1. 以 `modelID = "gpt-6-luna"` 调用 `ToolRegistry.tools()`；
2. 断言返回列表含 `write`、`edit` —— **当前失败**（两者被过滤）；
3. 断言返回列表不含 `apply_patch` —— **当前失败**（apply_patch 入选）。

### 1.3 预期 vs 实际

| | 预期 | 实际 |
|---|---|---|
| GPT 模型工具集 | 与其他模型一致：`write`/`edit` 可用，无 `apply_patch` | `write`/`edit` 消失，`apply_patch` 顶替 |
| 外部路径门控 | 对所有模型用同一 `(tool, filePath)` 契约 | GPT 下输入域变成不可解析的 `patchText` |
| 配置逃生门 | 可配置恢复 | 无任何配置点 |

## 第二部分：根因分析

按端到端链路分层。三方角色：**模型**（只认 opencode 下发的工具列表）、**opencode**（决定工具列表 + 执行前权限询问）、**外部 FSM 插件**（挂在 hook 上，按"工具名 ∈ {write, edit} 且 filePath ∈ 状态白名单"授权）。

### 第 1 层：直接原因 —— 模型条件化工具集整体替换，无兼容层

`packages/opencode/src/tool/registry.ts:336-339`：

```typescript
const usePatch =
  input.modelID.includes("gpt-") && !input.modelID.includes("oss") && !input.modelID.includes("gpt-4")
if (tool.id === ApplyPatchTool.id) return usePatch
if (tool.id === EditTool.id || tool.id === WriteTool.id) return !usePatch
```

`gpt-6-luna` 命中 `gpt-` 且不命中排除项 → `write`/`edit` 被移出工具集，只剩 `apply_patch`。此逻辑继承自上游（anomalyco/opencode v1.2.0 同文件），依据是 OpenAI GPT-5 prompting guide 的建议（apply_patch 匹配训练分布）。**决策本身合理，问题在于替换的不只是工具名，而是三件事同时变**：

| 维度 | 旧（write/edit） | 新（apply_patch） |
|---|---|---|
| 工具名 | `write` / `edit` | `apply_patch` |
| 参数 schema | `{ filePath, content }` / `{ filePath, oldString, newString }` | `{ patchText }`（单个字符串） |
| 语义粒度 | 单文件单操作 | 多文件 patch 信封（Add/Update/Delete/Move 混在一块文本里） |

对任何按 `(tool name, filePath)` 做授权的外部 gate，这是接口级破坏。受影响模型面：所有 ID 含 `gpt-` 的模型（排除 `oss`/`gpt-4`），含 openrouter 等转发的 `openai/gpt-*` 及 `gpt-6-luna` 这类非 OpenAI 官方但 ID 带 `gpt-` 的模型。

### 第 2 层：机制缺口 —— hook 契约没有为 path-gate 提供归一化视图

`packages/opencode/src/session/tools.ts:110-116`：`tool.execute.before` hook 只透传原始 `{ tool, sessionID, callID }` + 可变的 `{ args }`。插件要做路径级授权必须自己解析 Codex patch DSL（`*** Add File:` / `*** Update File:` / `*** Move to:` / `@@` hunks）。

opencode 内部有现成的解析器（`packages/opencode/src/patch/index.ts`，`apply_patch.ts:41` 执行时用的就是它），但**不对 plugin 包暴露**。"patch DSL 解析 = 授权输入"这一隐含契约没有任何文档。

### 第 3 层：加剧因素 —— 指令文本与有效工具集脱钩

多段文本无条件下发，不查当前模型实际有哪些工具：

- `packages/opencode/src/tool/shell/shell.txt:9`：`IMPORTANT: This tool is for terminal operations like git, npm, docker, etc. DO NOT use it for file operations ... use the specialized tools for this instead.` —— GPT 模型下"specialized tools"（Write/Edit）不存在。
- `packages/opencode/src/tool/shell/prompt.ts:101-105`：bash 使用指引含 `Edit files: Use Edit (NOT sed/awk)`、`Write files: Use Write (NOT echo >/cat <<EOF)` —— 指向不存在的工具。
- `packages/opencode/src/session/prompt/gpt.txt:27-28`：`Always use apply_patch for manual code edits...` —— 把 apply_patch 硬编码进指令面，与工具面强耦合。
- 同款脱钩在 `packages/opencode/src/session/prompt/anthropic.txt:88`（Claude 版"Use Edit/Write"），只是 Claude 恰好总有这两个工具尚未暴露。

模型被系统提示主动推向不存在的工具，而 bash 逃生通道又被 FSM gate 刻意封死（理由正当：shell 写入会绕过路径授权）。

### 第 4 层：停摆形态 —— 三条路全堵，只剩通信空转

1. 换 `write`/`edit`：工具集里没有，模型无法调用。
2. 用 bash 写文件：指令文本禁止 + FSM gate 有意拒绝（不白名单 shell 写入）。
3. 报告阻塞：`agent_send` 正常可用 → 根会话与 worker 之间"继续/还是被拒/再试一次"的礼貌循环，即 42/89 次调用。**每一步单看都合理，合起来是一小时无功循环。**

### 第 5 层（加重项）：配置逃生门实际损坏

`packages/opencode/src/config/config.ts:568-578` 把 `tools` 配置折叠为 permission 规则：

```typescript
for (const [tool, enabled] of Object.entries(result.tools)) {
  const action: ConfigPermissionV1.Action = enabled ? "allow" : "deny"
  if (tool === "write" || tool === "edit" || tool === "patch") {
    perms.edit = action
    continue
  }
  perms[tool] = action
}
```

三处问题：

1. 折叠表只有 `write`/`edit`/`patch` → `edit`，**`apply_patch` 不在表内**。用户配 `tools.apply_patch = false` 产生 `apply_patch: deny` 规则，而 apply_patch 执行时 ask 的是 `edit` 权限（`apply_patch.ts:206-215`，`permission: "edit"`），该规则永远匹配不上——配了等于没配。（原生 `disabled()`/`visibleTools()` 在 `permission/index.ts:241` 已把 `apply_patch` 归入 edits 组，config 折叠面没有对齐。）
2. `tools.write = false` 一刀切折叠成 `edit: deny`，连坐 `edit` 与 `apply_patch`，无法单独关闭 write。
3. 最根本：registry 的 usePatch 过滤发生在 permission 之前、完全不理会 config——**没有任何配置能让 GPT 模型用回 write/edit**。issue 中"想要受支持的切换方式"的诉求，当前配置面无法满足。

### 附带发现：原生权限面自身的 move 目的地缺口

`apply_patch.ts:205` 构造 permission patterns 时只映射 `c.filePath`（move 的**源**路径）；move 目的路径只进 `metadata.files`（`apply_patch.ts:196-201`），不经路径级 `patterns` 授权就落盘（`apply_patch.ts:239`）。即"move 目的地不经路径授权"在原生层面就存在。该缺口随工具删除一并消失（见第四部分），无需单独修。

### 根因定性

不是模型的错（模型按分配的工具如实工作），不是 FSM 插件的错（按其授权规则如实把关），也不完全是 usePatch 决策的错（其依据本身成立）。根因是：**opencode 在模型条件化替换"写文件接口"时，没有为按路径授权这一合法集成形态留下任何受支持的适配路径**——既不文档化新契约，也不暴露归一化视图，还不提供配置回退，且提示词文本与有效工具集脱钩放大了堵死程度。fork 的 agent-management 协作面（`agent_send` 高频循环）把停滞放大为显性的资源浪费。

上游对照：anomalyco/opencode#19942 报告同类问题，被 inactivity 自动关闭，无技术决议。fork 已实质性分叉，后续决策不再受上游同步约束。

## 第三部分：全仓库同类特殊处理调研

排查方法：全仓库扫描 `modelID.includes` / `model.api.id.includes` / `providerID ===` / `providerID.includes` 分叉行为。命中上百处，按性质分三类。

**判定原则：特殊处理本身不是毛病；有害的是"改变模型可见工具面 / 外部集成契约"且无配置覆盖点的那一类。**

### A 类：#74 同款（改变模型可见工具面/指令面）

| 位置 | 行为 | 本方案处置 |
|---|---|---|
| `packages/opencode/src/tool/registry.ts:336-339` | `gpt-*` → 摘 `write`/`edit`，换 `apply_patch` | 元凶，随工具删除一并移除 |
| `packages/opencode/src/session/system.ts:35-40` | 按 ID 子串选 gpt 系提示词，含 codex 分支 | codex 分支删除（其存在是历史偶然，见 3.1）；其余分支保留 |
| `packages/opencode/src/session/prompt/gpt.txt:27-28` | "Always use apply_patch" 硬编码指令 | 改 tool-agnostic 表述 |
| `packages/opencode/src/tool/shell/shell.txt:9` + `shell/prompt.ts:101-105` | bash 指引"Use Edit/Write" | 工具删除后 write/edit 对所有模型恒在，脱钩在此轴上自然消解，不动（文本级守卫见 4.2） |
| `packages/opencode/src/session/prompt/anthropic.txt:88` | 同上（Claude 版） | 同上，不动 |

### 3.1 codex 专属提示词的考古结论

`PROMPT_CODEX`（`prompt/codex.txt`）触发条件为 `modelID.includes("codex")`。git 考古：

- 2026-01 `b7ad6bd839`（"feat: apply_patch tool for openai models"）：该文件当时叫 `codex_header.txt`，**本次提交加上了那句 apply_patch 软化指令**——它的诞生动因就是弥合 apply_patch 与 codex 内置行为的冲突。
- 2026-03 `bfdc38e421`：上游 instruction whitelist 机制取消（提交信息自述 "oauth plan no longer enforces instruction whitelisting"），header 被扶正为整份系统提示词。

即：**一个为 apply_patch 写的补丁 header，因 prompt 管理重构残留成了一份独立提示词**。除那一行外，其余内容（ASCII/git 卫生/前端设计/final answer 格式）与 `gpt.txt`/`default.txt` 重叠度 80% 以上，无独立存在理由 → 整体删除，codex 系模型落 `PROMPT_GPT`。佐证：`gpt-6-luna` 使用的 `PROMPT_ASTRA` 本就不提 apply_patch 且工作正常（#74 中模型是主动扑向工具列表里的 apply_patch，非提示词驱动），说明 gpt 系在无 apply_patch 工具集 + tool-agnostic 提示词下可正常编辑。

### B 类：协议/能力微调 —— 特殊处理正当，硬编码方式可数据化（可选整理，不在本修复范围）

不同厂商 wire 协议确实不同，分叉本身合理；问题是全靠 `includes("gpt-")` 字符串嗅探而非模型元数据：

- `packages/opencode/src/provider/transform.ts:542-570`：`temperature`/`topP`/`topK` 按 `glm-4.6`/`glm-4.7`/`kimi-k2`/`minimax-m2`/`gemini-2.5` 逐 ID 硬编码采样默认值。
- `packages/opencode/src/provider/transform.ts:1337-1380`：`gpt-5.x` reasoning effort/verbosity 默认值，靠正则解析版本号。
- `packages/opencode/src/provider/transform.ts:605-660`：gpt-5/codex/chat 各 effort 集合按 ID 子串路由。
- `packages/opencode/src/provider/transform.ts:1819-1900`：moonshot/gemini/minimax schema 消毒各一套。
- `packages/opencode/src/session/message-v2.ts:155-163`：`supportsMediaInToolResult` 按 SDK 包名 + `gemini-3` ID 推断能力。**最应进模型 capabilities 元数据**——schema 已有 `Capabilities` 结构（`packages/schema/src/model.ts:25`，当前仅 `{ tools, input, output }`）与 `family` 字段（`transform.ts:2085` 已在用）。
- `packages/opencode/src/plugin/github-copilot/copilot.ts:344`：copilot 的 gpt 砍 `maxOutputTokens`。
- `packages/opencode/src/plugin/openai/codex.ts:316`：给 `gpt-5.5`/`gpt-5.6` 硬编码 context/limit（应由模型目录管）。

### C 类：正当适配 —— 不动

- bedrock 区域前缀映射（`packages/opencode/src/provider/provider.ts:395-455`）：AWS 跨区域推理 ID 规则，基础设施事实。
- google-vertex baseURL 推断（`provider.ts:1778-1790`）。
- dashscope/zai thinking 开关（`transform.ts:1249-1334`）：各兼容端点的请求体开关差异。
- ACP 工具名映射（`packages/opencode/src/acp/tool.ts:50`）：外部 UI 表面归一化，方向正确。

## 第四部分：修复方案

### 4.0 方案决策

**症状**：GPT 模型下外部路径门控集成停摆。
**根因**：模型条件化工具面分叉，且无任何适配/覆盖途径。

备选对照：

- ❌ 保留 apply_patch + 加 config 覆盖：把 #74 的契约问题在选了它的用户身上原样复活，且需配套暴露 DSL 解析器/文档，复杂度不减反增。
- ❌ 保留 apply_patch + hook 归一化子计划（§6 v2）：为无人要求的工具增加 plugin 契约面，违反剃刀原则（无现消费者的 seam 整体砍掉）。
- ✅ **彻底移除**（已确认）：apply_patch 的唯一选择条件就是 GPT ID 前缀；fork 无其他消费者；删除后 GPT 与所有模型共享同一工具面，根因整体消除。质量代价（放弃 OpenAI 训练分布匹配收益、外科手术式编辑 oldString 匹配失败率可能上升）已显式披露并被接受，列为上线后观测项而非功能回归。

**总原则**：工具从模型视野与生产代码中消失；但历史会话数据中的存量 `apply_patch` tool part 必须仍可渲染——**展示/协议兼容层保留，产生新调用的链路全删**。

### 4.1 修改清单（按依赖顺序）

#### A. 工具注销（opencode 包）

| 文件 | 位置 | 改动 |
|---|---|---|
| `packages/opencode/src/tool/registry.ts` | :44 import、:139 `ApplyPatchTool` 实例化、:336-339 usePatch 分支 | 删 import、删实例化、删整个 usePatch 条件块（其余工具落默认 `return true`） |
| `packages/opencode/src/tool/apply_patch.ts` | 全文件 | 删除 |
| `packages/opencode/src/tool/apply_patch.txt` | 全文件 | 删除 |
| `packages/opencode/src/patch/index.ts` | 全文件 | 删除（`maybeParseApplyPatch`/`maybeParseApplyPatchVerified` 生产代码零调用者；`parsePatch`/`deriveNewContentsFromChunks` 唯一消费者是待删的 apply_patch.ts；TUI/session-ui 用的同名函数来自 npm `diff` 包，无关） |
| `packages/opencode/src/cli/cmd/run/tool.ts` | :20 import、:99 类型映射、:404/:535/:703/:727 `runPatch`/`snapPatch`/`scrollPatch*`、:1072-1083 面板项 | 全部删除 |
| `packages/opencode/src/cli/cmd/run/demo.ts` | :629 `emitPatch` 及 :1060/:1092 两处调用 | 删除（demo 序列少一个 patch 演示步骤） |
| `packages/opencode/src/cli/cmd/agent.ts` | :17 注释提及 | 注释改为 "e.g. write/edit both gate on `edit`" |

#### B. 权限与配置面清理

| 文件 | 位置 | 改动 |
|---|---|---|
| `packages/opencode/src/permission/index.ts` | :241 `edits = ["edit", "write", "apply_patch"]` | 移除 `"apply_patch"` |
| `packages/opencode/src/config/config.ts` | :571 折叠表 `write`/`edit`/`patch` | 移除 `"patch"` 别名（`patch` 亦无对应工具，随本次一并清除；`write`/`edit` 折叠保留） |

#### C. core 包（V2 runner）摘除

| 文件 | 位置 | 改动 |
|---|---|---|
| `packages/core/src/tool/apply-patch.ts` | 全文件 | 删除 |
| `packages/core/src/tool/builtins.ts` | :6 import、:35 `ApplyPatchTool.node` | 删除 |
| `packages/core/src/file-mutation.ts` | :205 TODO 注释 | 删除该注释（提及 apply_patch 的多文件事务 TODO 随工具消失） |

#### D. 提示词

| 文件 | 位置 | 改动 |
|---|---|---|
| `packages/opencode/src/session/prompt/gpt.txt` | :27-28 | :27 改 tool-agnostic："Use the dedicated file tools (Edit/Write) for manual code edits. Do not use cat or any other commands when creating or editing files. Formatting commands or bulk edits don't need the dedicated tools."；:28 "or apply_patch" 字样删除 |
| `packages/opencode/src/session/prompt/codex.txt` | 全文件 | **删除**（依据见 3.1） |
| `packages/opencode/src/session/system.ts` | :15 import、:37-39 codex 分支 | 删除；codex 系模型落 `PROMPT_GPT`。收敛后 gpt 系边界：`gpt-4/o1/o3`→beast、`gpt-6`→astra、其余 gpt→gpt.txt |

#### E. 保留（历史兼容，明确不动）

| 文件 | 位置 | 理由 |
|---|---|---|
| `packages/tui/src/routes/session/index.tsx` | :1727-1729 `<Match "apply_patch">`、:2433 `ApplyPatch` 组件、:2626 工具枚举、:2992 `parseApplyPatchFiles` | 存量会话消息含 `apply_patch` part，须可渲染 |
| `packages/session-ui/src/components/*` | `apply-patch-file.ts`、`tool-alias.ts:13`（`apply_patch → "patch"` 别名）、`part-default-open.ts:22`、`message-part.tsx:547`、`tool-error-card.tsx:60` | 同上（web/app 共用展示层） |
| `packages/app/src/pages/session/timeline/message-timeline.tsx` | :1244 | 同上 |
| `packages/opencode/src/acp/tool.ts` | :50 `case "apply_patch"` | 旧会话经 ACP 暴露时 part 归类不变 |
| `packages/app/e2e/**`、`packages/session-ui` 中基于**静态 fixture** 的 e2e/组件测试 | 各处 | fixture 造的 part 数据与工具存续无关，测的是展示层；实施时逐一核对，若有显式断言"模型能产生 apply_patch 调用"则调整 |

### 4.2 测试

| 文件 | 改动 |
|---|---|
| `packages/opencode/test/tool/apply_patch.test.ts` | 删除 |
| `packages/opencode/test/patch/patch.test.ts` | 删除（目录一并删） |
| `packages/opencode/test/tool/parameters.test.ts` | 删 apply_patch 快照条目 |
| `packages/opencode/test/acp/tool.test.ts`、`permission.test.ts`、`test/agent/plan-mode-subagent-bypass.test.ts`、`test/cli/run/*`、`test/session/snapshot-tool-race.test.ts`、`test/permission/next.test.ts` | 实施时逐个核对：引用 apply_patch 的 fixture 改用 `write`/`edit`；断言"工具集中存在 apply_patch"的翻转为不存在 |
| `packages/core/test/tool-apply-patch.test.ts` | 删除 |
| `packages/core/test/session-runner-tool-registry.test.ts`、`location-layer.test.ts` | apply_patch 条目移除 |

**新增回归测试**（本修复的核心交付，§7 步骤 4）：

1. `registry` 测试：`modelID = "gpt-6-luna"`（及一个 `codex` 系 ID）时 `tools()` 含 `write`、`edit`，不含 `apply_patch`；对照组 `claude-*` 不变。
2. `system` 提示词测试：`gpt-5.3-codex` → `PROMPT_GPT`（不再有独立 codex 提示词）；gpt.txt 内容不含 `apply_patch` 字样（文本级守卫，防止回归再引入）。
3. config 折叠测试：`tools.patch = false` 不再产生 `edit: deny`（别名已删）；`tools.apply_patch = false` 产生 `apply_patch: deny` 规则（悬空但无害——工具不存在时规则永不匹配，保留行为简单性）。

### 4.3 明确不做

- 不为 apply_patch 提供 config 复活开关（理由见 4.0 备选对照）。
- 不动 `session-ui`/`tui`/`acp` 的展示兼容层（历史数据）。
- B 类调研项（采样参数数据化、capabilities 扩展）不在本修复范围，另行立项。

## 第五部分：正确性论证

**1. 根因消除**：根因是模型条件化工具面分叉。删除后 `registry.tools()` 的过滤逻辑不再含任何 `modelID` 条件（`webSearchEnabled` 按 providerID 的开关除外，属既有 C 类正当逻辑），所有模型走同一工具面判定，分叉不复存在。外部路径门控对 GPT 模型恢复与 Claude 等相同的 `(tool ∈ {write, edit}, filePath)` 契约——#74 的授权输入域失配从源头消失。

**2. 不变量保持**：
- *工具面完备性*：任一模型的编辑能力不变（write/edit 本就由同一套 execute 支撑，apply_patch 仅是第三种入口）。gpt.txt 改造后指令与工具集一致（不再引用不存在的工具）。
- *历史数据可读性*：存量 part 的渲染链（tui/session-ui/app/acp）零改动，旧会话打开行为逐字节不变。
- *权限面单调性*：`edits` 数组缩短只影响 `disabled()` 对名为 `apply_patch` 的工具的归类——该工具名此后不可能出现在 `tools()` 结果中，`visibleTools` 行为对现存工具集不变。config 折叠删 `"patch"` 别名同理（用户配置里写 `tools.patch` 会变成悬空键，落 `perms.patch = action`，无工具匹配，无害）。

**3. 无回归引入**：依赖第六部分用例。风险点及对策：
- GPT 编辑质量回退（oldString 匹配失败率）——非功能回归，观测项，上线后跟踪；#74 场景的恢复由回归测试 1 直接保证。
- 遗漏引用导致构建失败——typecheck + 全量测试兜底；消费者清单已按 4.1 固化（2026-10-21 全仓库 grep 核对）。
- demo/scrollback 快照测试依赖 emitPatch 输出——列入 4.2 核对清单，实施时删除对应快照。

## 第六部分：测试用例清单

| 类型 | 用例描述 | 状态（已回填） |
|------|---------|------------------|
| 回归 | GPT 系 modelID（`gpt-6-luna`、`gpt-5.3-codex`、`gpt-5.5`）工具集含 write/edit、不含 apply_patch；`claude-opus-4-5` 对照组不变 | 已加: `test/tool/registry.test.ts` "offers the same editing tools regardless of model ID" + a0f412e6a7 |
| 回归 | codex 系 ID（`gpt-5.3-codex`、`gpt-5.5-codex-max`）提示词落到 PROMPT_GPT；gpt.txt 全文不含 "apply_patch" 且含 "Edit/Write" | 已加: `test/session/system.test.ts` 两条 + a0f412e6a7 |
| 新增 | config `tools` 折叠：`patch` 别名删除后不再产生 edit 规则（落悬空 per-tool 规则） | 已加: `test/config/config.test.ts` "migrates legacy patch alias as a dangling per-tool permission rule" + a0f412e6a7 |
| 新增 | （核对项）A 类消费者测试中 apply_patch fixture → write/edit 后全部通过 | 已核: permission/plan-mode/acp/cli-run 全绿（154 pass，仅 snapshot-tool-race 为分支上既有超时，stash 验证与本次无关） |

## 第七部分：代码更新清单

| 文件 | 函数 / 行号 | 改动概述 | 状态（已回填） |
|------|------------|---------|------------------|
| `packages/opencode/src/tool/registry.ts` | import/:139/`patch: Tool.init`/builtin 列表/usePatch 分支 | 删 ApplyPatchTool 注册与 usePatch 分支 | 已改: 574bee6b71 |
| `packages/opencode/src/tool/apply_patch.ts` + `.txt` | 全文件 | 删除 | 已改: 574bee6b71 |
| `packages/opencode/src/patch/index.ts` | 全文件 | 删除 | 已改: 574bee6b71 |
| `packages/opencode/src/cli/cmd/run/tool.ts` | import/类型映射/runPatch/snapPatch/patchTitle/patchLine/scrollPatch*/面板项 | 删 patch 面板 | 已改: 574bee6b71 |
| `packages/opencode/src/cli/cmd/run/demo.ts` | emitPatch/`:patch` kind/mix 序列 | 删 emitPatch | 已改: 574bee6b71 |
| `packages/opencode/src/cli/cmd/agent.ts` | :16-18 注释 | 注释更新 | 已改: 574bee6b71 |
| `packages/opencode/src/permission/index.ts` | :241 | edits 数组删 apply_patch | 已改: 116e3a1adf |
| `packages/opencode/src/config/config.ts` | :572 | 折叠表删 "patch" | 已改: 116e3a1adf |
| `packages/core/src/tool/apply-patch.ts` + `builtins.ts` | 全文件/import+注册 | 删除/摘除 | 已改: 82572f2b80 |
| `packages/core/src/file-mutation.ts` | :205 TODO | 删 TODO 注释 | 已改: 82572f2b80 |
| `packages/core/src/v1/config/agent.ts` | normalize 折叠 | 删 "patch" 别名（实施中新发现，见下） | 已改: a0f412e6a7 |
| `packages/core/src/v1/config/migrate.ts` | normalizeAction | 删 "patch"→edit 归一（实施中新发现，见下） | 已改: a0f412e6a7 |
| `packages/opencode/src/session/prompt/gpt.txt` | :27-28 | tool-agnostic 化 | 已改: 622d25c765 |
| `packages/opencode/src/session/prompt/codex.txt` | 全文件 | 删除 | 已改: 622d25c765 |
| `packages/opencode/src/session/system.ts` | import/codex 分支 | 删 codex 分支 | 已改: 622d25c765 |
| `packages/opencode/test/…`（4.2 表所列） | 各处 | 删/改 fixture 与快照 | 已改: 574bee6b71 + a0f412e6a7 |
| `packages/core/test/…`（4.2 表所列） | 各处 | 同上 | 已改: 82572f2b80 |
| 新增回归测试 ×3（4.2） | registry/system/config | 见第六部分 | 已加: a0f412e6a7 |

**实施中的计划外发现**：原清单低估了 config 折叠面——core 包（`v1/config/agent.ts` 的 per-agent `tools` normalize、`v1/config/migrate.ts` 的 `normalizeAction`）存在第二组同样的 `"patch"` 别名折叠，回归测试抓出后才暴露（opencode 侧改完测试仍红）。两处已随第六部分回归用例一并修复。教训与 CLAUDE.md 已知限制回写一致：改折叠语义时按 consumer 全集排查，不按文件。

## 第八部分：文档更新清单

| 文档路径 | 要改什么 | 状态（已回填） |
|---------|---------|------------------|
| 本文档（第七部分） | 回填 commit hash | 已回填: 本轮 |
| `CLAUDE.md` 已知限制段 | 回写经验教训：模型 ID 嗅探分叉工具面的隐患；历史 part 渲染兼容层的保留边界 | 已改: 本轮 |
| `docs/devlog/2026-10-21-remove-apply-patch.md` | 新增 devlog（含度量段） | 已加: 本轮 |

**必填判定**：本修复改变了对外行为契约（模型可见工具集、提示词选择、config `tools` 折叠语义），第八部分不允许写"无"。

## 反模式自查

- 未跳过参考对照（第三部分/3.1 以同仓库其他模型路径与 git 历史为参照）。
- 非 workaround：删除的是根因机制本身，非症状遮蔽。
- 同模块 patch 次数：本次为对 #74 的首个代码修复，无连续 patch 模式。

## 证据边界

- 分析基于静态代码核查（上述所有行号均在 2026-10-21 的 `dev` HEAD 逐一验证），未做运行时复现。
- issue 作者已声明：42/89 次调用仅证明通信活跃，不声称内容相同；不以 HTTP 204/busy session 为恢复证据；write-tool 失配仅对受影响 worker 直接成立，不归因所有慢阶段。
- 停摆过程中实验环境已按用户要求全部 resumable 停止，未修改任何 opencode 源码/插件/本地 wrapper。
