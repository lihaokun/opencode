# 修正方案：移除 apply_patch 工具及 GPT 模型条件化工具替换

> 依据 issue：[lihaokun/opencode#74](https://github.com/lihaokun/opencode/issues/74)
> 前置分析：`docs/fixes/issue-74-model-conditional-tools-analysis.md`（问题描述 / 五层根因 / 全仓库调研）
> 决策记录：用户拍板"实质性分叉、不考虑上游同步"，选择**彻底移除**（原评估中的变体 2），并连带删除 codex 专属提示词（调研确认其存在是历史偶然，唯一独特内容即 apply_patch 软化句）。
> 分类：§7 步骤 2 第三类——接口/架构层面问题（删除一个对外工具 + 一条提示词选择分支）。

## 第一部分：现象与复现

### 现象

GPT 系模型（ID 含 `gpt-`，排除 `oss`/`gpt-4`）的工具集被硬编码替换：`write`/`edit` 被移除，仅剩 `apply_patch`（参数形态为 `patchText` 单字符串，文件路径藏于 Codex patch DSL 内）。外部路径门控集成（按 `tool ∈ {write, edit}` + `filePath` 授权）在模型切换后无法授权任何文件写入，且无配置途径恢复，导致 FSM 工作流以 `agent_send` 高频空转的形式停摆（issue #74：1 小时内 42/89 次通信调用，零产物）。系统提示词同时把模型推向不存在的工具（bash 指引"Use Write/Edit"）、以及把 apply_patch 硬编码进指令（`gpt.txt:27`"Always use apply_patch"）。

### 最小复现用例

单元级复现（无需外部插件）：

1. 以 `modelID = "gpt-6-luna"` 调用 `ToolRegistry.tools()`；
2. 断言返回列表含 `write`、`edit` —— **当前失败**（两者被过滤）；
3. 断言返回列表不含 `apply_patch` —— **当前失败**（apply_patch 入选）。

集成级复现见前置分析文档 §1.2（外部 `tool.execute.before` 门控 + GPT 模型 + 要求创建 artifact）。

### 出错代码路径

- `packages/opencode/src/tool/registry.ts:336-339`：usePatch 过滤（根因主体）
- `packages/opencode/src/session/system.ts:35-40`：codex 提示词分支（连带删除对象）
- `packages/opencode/src/session/prompt/gpt.txt:27-28`：apply_patch 硬编码指令
- `packages/opencode/src/tool/apply_patch.ts`：工具实体
- `packages/opencode/src/patch/index.ts`：DSL 解析器（生产代码无消费者，仅测试引用）

### 预期 vs 实际

| | 预期 | 实际 |
|---|---|---|
| GPT 模型工具集 | 与其他模型一致：`write`/`edit` 可用，无 `apply_patch` | `write`/`edit` 消失，`apply_patch` 顶替 |
| 外部路径门控 | 对所有模型用同一 `(tool, filePath)` 契约 | GPT 下输入域变成不可解析的 `patchText` |
| 配置逃生门 | 可配置恢复 | 无任何配置点 |

## 第二部分：根因分析

**症状**：GPT 模型下外部路径门控集成停摆。

**根因**：opencode 按 `modelID.includes("gpt-")` 硬编码替换"写文件"接口（工具名 + 参数 schema + 语义粒度三者同时变），未提供：(a) 配置覆盖点；(b) hook 侧归一化视图；(c) 与有效工具集一致的指令文本。fork 定位为稳定工具面之上的外部集成平台（agent-management、FSM 类集成），模型条件化的工具面变更与之根本冲突。

**决策：消除根因而非绕过。** 备选方案对照：

- ❌ 保留 apply_patch + 加 config 覆盖：把 #74 的契约问题在选了它的用户身上原样复活，且需配套暴露 DSL 解析器/文档，复杂度不减反增。
- ❌ 保留 apply_patch + hook 归一化子计划（§6 v2）：为无人要求的工具增加 plugin 契约面，违反剃刀原则（无现消费者的 seam 整体砍掉）。
- ✅ **彻底移除**（本方案）：apply_patch 的唯一选择条件就是 GPT ID 前缀；fork 无其他消费者；删除后 GPT 与所有模型共享同一工具面，根因（模型条件化分叉）整体消除。质量代价（放弃 OpenAI 训练分布匹配收益、外科手术式编辑失败率可能上升）已向用户显式披露并被接受。

## 第三部分：参考实现对照

算法类 bug 不适用（无算法修正）。对照对象为**同仓库内其他模型路径的行为一致性**：

- Claude/Gemini/GLM/Kimi 等模型路径：工具集恒含 `write`/`edit`，无 `apply_patch`，编辑经 `edit`（oldString 匹配）与 `write`（整文件覆盖）完成，配合各自提示词（anthropic.txt:88 的 "Use Edit/Write" 表述与工具集一致）。
- 逐步差异：GPT 路径在 `registry.ts:336` 独有一层 ID 前缀过滤，其余路径无。删除该过滤后 GPT 路径与其他模型路径在工具面选择上执行完全相同的代码——差异点即根因，消除即对齐。
- 佐证：`gpt-6-luna` 使用的 `PROMPT_ASTRA` 本就**不提** apply_patch 且工作正常（#74 中模型是主动扑向工具列表里的 apply_patch，非提示词驱动），说明 GPT 系模型在无 apply_patch 工具集 + tool-agnostic 提示词下可正常完成编辑任务。

## 第四部分：修复方案

**总原则**：工具从模型视野与生产代码中消失；但历史会话数据中的存量 `apply_patch` tool part 必须仍可渲染——**展示/协议兼容层保留，产生新调用的链路全删**。

### 4.1 修改清单（按依赖顺序）

#### A. 工具注销（opencode 包）

| 文件 | 位置 | 改动 |
|---|---|---|
| `packages/opencode/src/tool/registry.ts` | :44 import、:139 `ApplyPatchTool` 实例化、:338-339 usePatch 分支 | 删 import、删实例化、删整个 usePatch 条件块（其余工具落默认 `return true`） |
| `packages/opencode/src/tool/apply_patch.ts` | 全文件 | 删除 |
| `packages/opencode/src/tool/apply_patch.txt` | 全文件 | 删除 |
| `packages/opencode/src/patch/index.ts` | 全文件 | 删除（`maybeParseApplyPatch`/`maybeParseApplyPatchVerified` 生产代码零调用者；`parsePatch`/`deriveNewContentsFromChunks` 唯一消费者是待删的 apply_patch.ts；注意 TUI/session-ui 用的是 npm `diff` 包的同名函数，无关） |
| `packages/opencode/src/cli/cmd/run/tool.ts` | :20 import、:99 类型映射、:404/:535/:703/:727 `runPatch`/`snapPatch`/`scrollPatch*`、:1072-1083 面板项 | 全部删除 |
| `packages/opencode/src/cli/cmd/run/demo.ts` | :629-… `emitPatch` 及 :1060/:1092 两处调用 | 删除（demo 序列少一个 patch 演示步骤） |
| `packages/opencode/src/cli/cmd/agent.ts` | :17 注释提及 | 注释改为 "e.g. write/edit both gate on `edit`" |

#### B. 权限与配置面清理

| 文件 | 位置 | 改动 |
|---|---|---|
| `packages/opencode/src/permission/index.ts` | :241 `edits = ["edit", "write", "apply_patch"]` | 移除 `"apply_patch"` |
| `packages/opencode/src/config/config.ts` | :571 `tool === "write" \|\| tool === "edit" \|\| tool === "patch"` 折叠表 | 移除 `"patch"` 别名（`patch` 亦无对应工具，随本次一并清除；`write`/`edit` 折叠保留） |

#### C. core 包（V2 runner）摘除

| 文件 | 位置 | 改动 |
|---|---|---|
| `packages/core/src/tool/apply-patch.ts` | 全文件 | 删除 |
| `packages/core/src/tool/builtins.ts` | :6 import、:35 `ApplyPatchTool.node` | 删除 |
| `packages/core/src/file-mutation.ts` | :205 TODO 注释 | 删除该注释（提及 apply_patch 的多文件事务 TODO 随工具消失） |

#### D. 提示词

| 文件 | 位置 | 改动 |
|---|---|---|
| `packages/opencode/src/session/prompt/gpt.txt` | :27-28 | :27 改为 tool-agnostic："Use the dedicated file tools (Edit/Write) for manual code edits. Do not use cat or any other commands when creating or editing files. Formatting commands or bulk edits don't need the dedicated tools."；:28 "or apply_patch" 字样删除 |
| `packages/opencode/src/session/prompt/codex.txt` | 全文件 | **删除** |
| `packages/opencode/src/session/system.ts` | :15 import、:37-39 codex 分支 | 删除；codex 系模型落到 `PROMPT_GPT`。收敛后 gpt 系边界：`gpt-4/o1/o3`→beast、`gpt-6`→astra、其余 gpt→gpt.txt |

#### E. 保留（历史兼容，明确不动）

| 文件 | 位置 | 理由 |
|---|---|---|
| `packages/tui/src/routes/session/index.tsx` | :1727-1729 `<Match "apply_patch">`、:2433 `ApplyPatch` 组件、:2626 工具枚举、:2992 `parseApplyPatchFiles` | 存量会话消息含 `apply_patch` part，须可渲染 |
| `packages/session-ui/src/components/*` | `apply-patch-file.ts`、`tool-alias.ts:13`（`apply_patch → "patch"` 别名）、`part-default-open.ts:22`、`message-part.tsx:547`、`tool-error-card.tsx:60` | 同上（web/app 共用展示层） |
| `packages/app/src/pages/session/timeline/message-timeline.tsx` | :1244 | 同上 |
| `packages/opencode/src/acp/tool.ts` | :50 `case "apply_patch"` | 旧会话经 ACP 暴露时 part 归类不变 |
| `packages/app/e2e/**`、`packages/session-ui` 中基于**静态 fixture** 的 e2e/组件测试 | 各处 | fixture 造的 part 数据与工具存续无关，测的是展示层；不改（若 e2e 显式断言"模型能产生 apply_patch 调用"则需调整，实施时逐一核对） |

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

- 不为 apply_patch 提供 config 复活开关（理由见第二部分备选对照）。
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
- 遗漏引用导致构建失败——typecheck + 全量测试兜底；消费者清单已按本方案第四部分固化（2026-10-21 全仓库 grep 核对）。
- demo/scrollback 快照测试依赖 emitPatch 输出——列入 4.3 核对清单，实施时删除对应快照。

## 第六部分：测试用例清单

| 类型 | 用例描述 | 状态（修复后回填） |
|------|---------|------------------|
| 回归 | GPT 系 modelID（`gpt-6-luna`、`gpt-5.3-codex`）工具集含 write/edit、不含 apply_patch；非 GPT 对照组不变 | 待加 |
| 回归 | codex 系 ID 提示词落到 PROMPT_GPT；gpt.txt 全文不含 "apply_patch" | 待加 |
| 新增 | config `tools` 折叠：`patch` 别名删除后不产生 edit 规则；`apply_patch` 键落独立 deny 规则 | 待加 |
| 新增 | （核对项）A 类消费者测试中 apply_patch fixture → write/edit 后全部通过 | 待核 |

## 第七部分：代码更新清单

| 文件 | 函数 / 行号 | 改动概述 | 状态（修复后回填） |
|------|------------|---------|------------------|
| `packages/opencode/src/tool/registry.ts` | :44/:139/:336-339 | 删 ApplyPatchTool 注册与 usePatch 分支 | 待改 |
| `packages/opencode/src/tool/apply_patch.ts` + `.txt` | 全文件 | 删除 | 待改 |
| `packages/opencode/src/patch/index.ts` | 全文件 | 删除 | 待改 |
| `packages/opencode/src/cli/cmd/run/tool.ts` | :20/:99/:404/:535/:703/:727/:1072-1083 | 删 patch 面板 | 待改 |
| `packages/opencode/src/cli/cmd/run/demo.ts` | :629/:1060/:1092 | 删 emitPatch | 待改 |
| `packages/opencode/src/cli/cmd/agent.ts` | :17 | 注释更新 | 待改 |
| `packages/opencode/src/permission/index.ts` | :241 | edits 数组删 apply_patch | 待改 |
| `packages/opencode/src/config/config.ts` | :571 | 折叠表删 "patch" | 待改 |
| `packages/core/src/tool/apply-patch.ts` + `builtins.ts` :6/:35 | 全文件/:35 | 删除/摘除 | 待改 |
| `packages/core/src/file-mutation.ts` | :205 | 删 TODO 注释 | 待改 |
| `packages/opencode/src/session/prompt/gpt.txt` | :27-28 | tool-agnostic 化 | 待改 |
| `packages/opencode/src/session/prompt/codex.txt` | 全文件 | 删除 | 待改 |
| `packages/opencode/src/session/system.ts` | :15/:37-39 | 删 codex 分支 | 待改 |
| `packages/opencode/test/…`（4.2 表所列） | 各处 | 删/改 fixture 与快照 | 待改 |
| `packages/core/test/…`（4.2 表所列） | 各处 | 同上 | 待改 |
| 新增回归测试 ×3（4.2） | 新文件/既有文件 | 见第六部分 | 待加 |

## 第八部分：文档更新清单

| 文档路径 | 要改什么 | 状态（修复后回填） |
|---------|---------|------------------|
| 本文档（第七部分） | 回填 commit hash | 待回填 |
| `docs/fixes/issue-74-model-conditional-tools-analysis.md` | §四修复方向更新为"已决策：彻底移除"，补 codex.txt 删除依据 | 待改 |
| `CLAUDE.md` 已知限制段 | 回写经验教训：模型 ID 嗅探分叉工具面的隐患；历史 part 渲染兼容层的保留边界 | 待改 |
| `docs/devlog/2026-10-21-remove-apply-patch.md` | 新增 devlog（含度量段） | 待加 |

**必填判定**：本修复改变了对外行为契约（模型可见工具集、提示词选择、config `tools` 折叠语义），第八部分不允许写"无"。

## 反模式自查

- 未跳过参考对照（第三部分以同仓库其他模型路径为参照）。
- 非 workaround：删除的是根因机制本身，非症状遮蔽。
- 同模块 patch 次数：本次为对 #74 的首个代码修复，无连续 patch 模式。
