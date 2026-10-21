# Issue #74 分析：模型条件化工具替换导致路径门控集成停摆

> 对应 issue：[lihaokun/opencode#74](https://github.com/lihaokun/opencode/issues/74)（[Integration] GPT apply_patch-only tool set stalls path-gated FSM workflows）
> 分析版本基线：`v1.18.31-fmv2.1`（受影响 release），当前 `dev` 分支 HEAD `d9d7de31fb`（两者相关逻辑逐字一致）
> 本文档性质：问题描述 + 根因分析 + 全仓库同类问题调研。修复方案另出文档。

## 一、问题描述

### 1.1 现象

用户实验环境（外部 FSM 集成 + `mcp-server-fsm` 插件）在把已有 FSM 驱动工作流的模型切换为 `openai/gpt-6-luna` 后停摆：

- `GET /experimental/tool?provider=openai&model=gpt-6-luna` 返回的工具列表含 `apply_patch`，**不含** `write` 和 `edit`。
- worker 尝试创建分配给它的 artifact 文件（`proof/analysis-state/tasks/<batch>/collection.md`）时，外部 FSM gate 拒绝：

  ```text
  FSM gate: apply_patch is not allowed.
  Reason: not in whitelist for state B_COLLECT.
  ```

- 之后根会话与 worker 进入持续空转：07:30–08:22 UTC 内分别发出 42 和 89 次 `agent_send` 调用（注：issue 作者明确说明这是通信量计数，不声称每条消息内容相同），worker 始终停留在 `B_ANALYZE`，formal draft 未变，`submission.json` 始终不存在。
- 环境要点：原生 opencode 权限策略已 wildcard allow（阻塞点不在原生权限），无 pending 原生 permission/question；阻塞完全来自外部 FSM 插件的路径门控。

### 1.2 复现路径（issue 提供，已核实与代码一致）

1. 安装一个外部 `tool.execute.before` 集成，把 `write`/`edit` 的 `filePath` 映射进路径感知的写门控；且故意不把任意 shell 写入加白名单（避免绕过路径授权）。
2. 配置一个有效工具集选择 `apply_patch`、排除 `write`/`edit` 的 GPT 模型。
3. 要求 worker 在一个本应允许的路径下创建 artifact。
4. worker 使用 `apply_patch`；集成收到不同的工具名和 `patchText` 参数（而非 `filePath`），拒绝调用。
5. 仅发送"继续"类消息无法恢复不可用的工具，也无法解决路径门控失配。

### 1.3 预期 vs 实际

- **预期**：模型条件化的工具选择不破坏基于旧接口（`write`/`edit` + `filePath`）建立的外部授权集成；或至少存在受支持的配置/契约途径让外部门控适配新接口。
- **实际**：工具集被硬编码切换，hook 契约无归一化视图，配置无逃生门，提示词还把模型推向不存在的工具——四方合力导致停摆且无法自恢复。

## 二、根因分析

按端到端链路分层。三方角色：**模型**（只认 opencode 下发的工具列表）、**opencode**（决定工具列表 + 执行前权限询问）、**外部 FSM 插件**（挂在 hook 上，按"工具名 ∈ {write, edit} 且 filePath ∈ 状态白名单"授权）。

### 第 1 层：直接原因 —— 模型条件化工具集整体替换，无兼容层

`packages/opencode/src/tool/registry.ts:336-339`：

```typescript
const usePatch =
  input.modelID.includes("gpt-") && !input.modelID.includes("oss") && !input.modelID.includes("gpt-4")
if (tool.id === ApplyPatchTool.id) return usePatch
if (tool.id === EditTool.id || tool.id === WriteTool.id) return !usePatch
```

`gpt-6-luna` 命中 `gpt-` 且不命中排除项 → `write`/`edit` 被移出工具集，只剩 `apply_patch`。此逻辑逐字继承自上游（anomalyco/opencode v1.2.0 同文件），依据是 OpenAI GPT-5 prompting guide 的建议（apply_patch 匹配训练分布）。**决策本身合理，问题在于替换的不只是工具名，而是三件事同时变**：

| 维度 | 旧（write/edit） | 新（apply_patch） |
|---|---|---|
| 工具名 | `write` / `edit` | `apply_patch` |
| 参数 schema | `{ filePath, content }` / `{ filePath, oldString, newString }` | `{ patchText }`（单个字符串） |
| 语义粒度 | 单文件单操作 | 多文件 patch 信封（Add/Update/Delete/Move 混在一块文本里） |

对任何按 `(tool name, filePath)` 做授权的外部 gate，这是接口级破坏。

### 第 2 层：机制缺口 —— hook 契约没有为 path-gate 提供归一化视图

`packages/opencode/src/session/tools.ts:110-116`：`tool.execute.before` hook 只透传原始 `{ tool, sessionID, callID }` + 可变的 `{ args }`。插件要做路径级授权必须自己解析 Codex patch DSL（`*** Add File:` / `*** Update File:` / `*** Move to:` / `@@` hunks）。

opencode 内部有现成的解析器（`packages/opencode/src/patch/index.ts`，`apply_patch.ts:41` 执行时用的就是它），但**不对 plugin 包暴露**。"patch DSL 解析 = 授权输入"这一隐含契约没有任何文档。

### 第 3 层：加剧因素 —— 指令文本与有效工具集脱钩

两段文本无条件下发，不查当前模型实际有哪些工具：

- `packages/opencode/src/tool/shell/shell.txt:9`：`IMPORTANT: This tool is for terminal operations like git, npm, docker, etc. DO NOT use it for file operations ... use the specialized tools for this instead.` —— GPT 模型下"specialized tools"（Write/Edit）不存在。
- `packages/opencode/src/tool/shell/prompt.ts:101-105`：bash 使用指引含 `Edit files: Use Edit (NOT sed/awk)`、`Write files: Use Write (NOT echo >/cat <<EOF)` —— 指向不存在的工具。
- 同款问题在 `packages/opencode/src/session/prompt/anthropic.txt:88`（Claude 版"Use Edit/Write"），只是 Claude 恰好总有这两个工具尚未暴露。

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

### 附带发现：原生权限面自身的 move 目的地缺口（与 issue 请求 2 直接相关）

`apply_patch.ts:205` 构造 permission patterns 时只映射 `c.filePath`（move 的**源**路径）；move 目的路径只进 `metadata.files`（`apply_patch.ts:196-201`），不经路径级 `patterns` 授权就落盘（`apply_patch.ts:239`）。即"move 目的地不经路径授权"在原生层面就存在，外部 gate 想补齐只能自行解析 patchText。

### 根因定性

不是模型的错（模型按分配的工具如实工作），不是 FSM 插件的错（按其授权规则如实把关），也不完全是 usePatch 决策的错（上游决策本身有依据）。根因是：**opencode 在模型条件化替换"写文件接口"时，没有为按路径授权这一合法集成形态留下任何受支持的适配路径**——既不文档化新契约，也不暴露归一化视图，还不提供配置回退，且提示词文本与有效工具集脱钩放大了堵死程度。fork 的 agent-management 协作面（`agent_send` 高频循环）把停滞放大为显性的资源浪费。

上游对照：anomalyco/opencode#19942 报告同类问题，被 inactivity 自动关闭，无技术决议。

## 三、全仓库同类特殊处理调研

排查方法：全仓库扫描 `modelID.includes` / `model.api.id.includes` / `providerID ===` / `providerID.includes` 分叉行为。命中上百处，按性质分三类。

**判定原则：特殊处理本身不是毛病；有害的是"改变模型可见工具面 / 外部集成契约"且无配置覆盖点的那一类。**

### A 类：#74 同款（改变模型可见工具面/指令面）—— 建议修

| 位置 | 行为 | 问题 |
|---|---|---|
| `packages/opencode/src/tool/registry.ts:336-339` | `gpt-*` → 摘 `write`/`edit`，换 `apply_patch` | 元凶。硬编码、无 config 覆盖点、悄悄改变外部 hook 看到的工具契约 |
| `packages/opencode/src/session/system.ts:29-50` | 按 `muse`/`gpt-6`/`codex`/`gemini`/`claude`/`kimi` 选系统提示词 | 本身是文本建议危害低，但是 usePatch 的"指令面孪生"：`prompt/gpt.txt:27` 写死 "Always use apply_patch"，与工具面强耦合，改动须联动审视 |
| `packages/opencode/src/tool/shell/shell.txt:9` + `shell/prompt.ts:101-105` | bash 描述写死"file ops 用专用工具"、"Use Edit/Write" | 无条件下发，不查当前模型有无 Edit/Write/apply_patch。GPT 下指向不存在的工具（#74 中模型被此推着撞墙） |
| `packages/opencode/src/session/prompt/anthropic.txt:88` | 同上（Claude 版） | 同款，尚未暴露 |

### B 类：协议/能力微调 —— 特殊处理正当，硬编码方式可数据化（可选整理）

不同厂商 wire 协议确实不同，分叉本身合理；问题是全靠 `includes("gpt-")` 字符串嗅探而非模型元数据：

- `packages/opencode/src/provider/transform.ts:542-570`：`temperature`/`topP`/`topK` 按 `glm-4.6`/`glm-4.7`/`kimi-k2`/`minimax-m2`/`gemini-2.5` 逐 ID 硬编码采样默认值。
- `packages/opencode/src/provider/transform.ts:1337-1380`：`gpt-5.x` reasoning effort/verbosity 默认值，靠正则解析版本号（`gpt-(\d+)\.(\d+)`）。
- `packages/opencode/src/provider/transform.ts:605-660`：gpt-5/codex/chat 各 effort 集合按 ID 子串路由。
- `packages/opencode/src/provider/transform.ts:1819-1900`：moonshot/gemini/minimax schema 消毒各一套。
- `packages/opencode/src/session/message-v2.ts:155-163`：`supportsMediaInToolResult` 按 SDK 包名 + `gemini-3` ID 推断能力。**最应进模型 capabilities 元数据**——schema 已有 `Capabilities` 结构（`packages/schema/src/model.ts:25`，当前仅 `{ tools, input, output }`）与 `family` 字段（`transform.ts:2085` 已在用）。
- `packages/opencode/src/plugin/github-copilot/copilot.ts:344`：copilot 的 gpt 砍 `maxOutputTokens`。
- `packages/opencode/src/plugin/openai/codex.ts:316`：给 `gpt-5.5`/`gpt-5.6` 硬编码 context/limit（应由模型目录管）。

### C 类：正当适配 —— 不动

- bedrock 区域前缀映射（`packages/opencode/src/provider/provider.ts:395-455`）：AWS 跨区域推理 ID 规则，基础设施事实。
- google-vertex baseURL 推断（`provider.ts:1778-1790`）。
- dashscope/zai thinking 开关（`transform.ts:1249-1334`）：各兼容端点的请求体开关差异。
- ACP 工具名映射（`packages/opencode/src/acp/tool.ts:50`）：把 `apply_patch`/`patch`/`write`/`edit` 都归到 edit kind——外部 UI 表面归一化，方向正确。

## 四、修复方向评估（待确认，未实施）

### 约束

1. **fork 同步代价**：A 类逻辑逐字继承自上游，改它 = 每次上游同步多一处冲突面。应**加覆盖点而非重写上游逻辑**（如 usePatch 先查 config 显式配置，未配置才落上游默认），把 diff 压到最小。
2. **流程分级**（按 `docs/workflow.md` §2.3 判定）：

| 档 | 内容 | 流程 |
|---|---|---|
| bug-fix 档 | ① config 逃生门三处修复（`apply_patch` 折叠遗漏 / write 连坐 / registry 支持 config 覆盖工具替换）；② shell/提示词文本不引用可能不存在的工具名（按实际注册工具集渲染或去具体工具名）；③ 原生 `apply_patch` permission patterns 补 move 目的地路径 | §7 修复流程，一套回归测试 |
| 子计划档 | `tool.execute.before` 提供归一化 per-file 视图（复用内部 `Patch.parsePatch`），路径门控插件免于自解析 patch DSL——#74 请求 2 的正解 | 涉及 plugin 契约，需开子计划走 §6 v2 |
| B 类数据化（可选） | 采样默认值、media 能力等搬进模型元数据（扩展 `Capabilities` / `family`） | 收益是长期可维护性，动面大，单独立项 |

### 建议

先做 bug-fix 档（直接消除 #74 的堵死状态 + 修坏掉的逃生门 + 补原生 move 授权洞），子计划档与 B 类数据化待确认后排期。

## 五、证据边界

- 分析基于静态代码核查（上述所有行号均在当前 `dev` HEAD 逐一验证），未做运行时复现。
- issue 作者已声明：42/89 次调用仅证明通信活跃，不声称内容相同；不以 HTTP 204/busy session 为恢复证据；write-tool 失配仅对受影响 worker 直接成立，不归因所有慢阶段。
- 停摆过程中实验环境已按用户要求全部 resumable 停止，未修改任何 opencode 源码/插件/本地 wrapper。
