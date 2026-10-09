# 调研报告 — 通用 Agent runtime 对齐（issue #46）

> 状态：**讨论稿**。决策点均为"倾向"而非决定，待逐项确认后进入对应流程（§7 修复 / §4 设计）。
> 关联：lihaokun/opencode#46（系统提示词、上下文压缩恢复、tool call / tool result 三方对照）。
> 核验基线：fork `dev@1343833857`（= issue 基线 `18b60d18` + PR #48/#49，两者均不触及本文涉及的代码路径）。
> 本文所有 file:line 均以该基线为准，为只读核实结论，未做任何修改。

---

## 1. 背景与范围

issue #46 提出 P0/P1/P2 三层改进。本文记录 2026-10 讨论 轮的产出：

1. 对 issue 三个 P0 断言的**逐项源码核实**（§2）
2. 五项专项调查：工具 metadata 投影面、MCP 投影仓库内先例、core runner 消费者、提示词装配矩阵、压缩恢复既有机制（§3）
3. 由此细化的**决策点清单**：每个决策点列已确认事实、备选项与代价、倾向、待拍板问题（§4）
4. 流程归类与时序风险（§5）

外部参照（ZCode / Claude Code）的对照结论沿用 issue #46 原文，本文不重复；本文只补充 fork 自身源码层面的事实。

---

## 2. P0 断言核实结论

**三个 P0 断言全部成立**，且各有一处影响修法的补充发现。

### 2.1 P0-1 shell 退出码不进入模型可见文本 —— 成立

产生与持久化链路：

- `tool/shell.ts:585-594`：返回 `metadata: { output, exit, truncated, outputPath? }`；`exit` 来自 `:557`（race 于 `:542-546`）。
  - 正常退出：`exit: <code>`；正文为 tail 后输出，空时 `"(no output)"`（`:576`）。
  - 超时 / 取消：`exit: null`，正文追加 `<shell_metadata>` 说明（`:561-567, 582-584`）——即 timeout/abort 已有正文说明，不缺信息。
- `session/processor.ts:298-309`：`completeToolCall` 将 `metadata` 整体落库；`:384-403` `toolResultOutput` 只挑 `output/title/metadata/attachments` 四字段。
- `session/message-v2.ts:295-328`：completed → 模型消息只用 `part.state.output`（`:300`）+ attachments（`:301`）。metadata 仅以 `providerExecuted` 布尔与 `callProviderMetadata`（provider options）出现，**不进正文**。
- 全仓唯一消费 `metadata.exit` 的是 CLI 显示：`cli/cmd/run/tool.ts:674-685`（`bash completed (exit N)`）。

关键补充发现：

- **不存在"同一请求内回传"**：opencode 由外层 `while` 循环驱动（`session/prompt.ts:1218`），AI SDK `stopWhen=stepCountIs(1)`。工具结果只在**下一轮**经 message-v2 转换回给模型；native 与 ai-sdk 两条 runtime 共用同一 `prepared.messages`（`prompt.ts:1416` → `llm.ts:240` / `llm.ts:332`；`native-request.ts:67-78` 只做形状映射）。⇒ **修 message-v2 一处即覆盖全部可见性场景**。
- **重放无二次截断**：`truncateToolOutput`（`message-v2.ts:50-54`）唯一生产调用点 `:300` 不传 `toolOutputMaxChars`，原样返回；传参的只有测试（`test/session/message-v2.test.ts:793`）。
- **`!cmd` 用户直执行路径丢码**：`prompt.ts:628-708` 产出 `bash` ToolPart 但在 `:684` 丢弃 `handle.exitCode`，metadata 仅 `{ output }`（`:663-665, 700`）——该路径无论选哪种修法都需先补记 exit。
- error 分支（`message-v2.ts:330-353`）：`metadata.interrupted === true` 时发正常 `output-available`（文本为部分输出）；否则 `output-error` + `errorText`。`interrupted` 由 `processor.ts:749-761` 打上。
- 测试现状：`test/tool/shell.test.ts` 只断言工具层 `metadata.exit`；message-v2 的 45 个测试无任何 exit 可见性断言。

### 2.2 P0-2 MCP structuredContent 在投影时丢失 —— 成立（根因位置需修正）

- `mcp/catalog.ts:68-80`：
  - `isError` 在**任何投影之前** throw，message 只拼 content 的 text 项，空则兜底 `"MCP tool returned an error"` ⇒ **structuredContent-only 的错误内容全丢**（独立丢失点）。
  - 仅当 `content.length === 0` 且 structuredContent 非空时才转 `JSON.stringify(structuredContent)` 文本（`:75-80`）。
- `session/tools.ts:391`：`flags.experimentalCodeMode` 为 true 时早返回 ⇒ code-mode 与普通路径互斥；**默认 false**（`effect/runtime-flags.ts:47`），普通路径（`:393-493`）是默认路径。
- `session/tools.ts:429-465` 投影循环只认 `text / image / resource`，**无 else 分支**：structuredContent 不进正文；`resource_link` / `audio` 连占位文本都没有（对比 embedded resource 不支持的 mime 会显式写 `[Binary MCP resource omitted: <uri> (<mime>, <size>) ...]`，`:446-448, 452-454`——方括号 + 原因 + 可定位标识，是仓库内"显式降级"先例）。
- `tools.ts:474-485` 返回对象不复制 structuredContent；持久化 schema（`schema/v1/session.ts:277-289` `ToolStateCompleted`）无承载字段 ⇒ 数据在投影时丢，非持久化丢。
- **catalog 的 content-first 是上游有意设计**：commit `fd213e6df6`（"prefer content over structured output"），`test/mcp/catalog.test.ts:30-50` 固化。⇒ 修复**不应动 catalog**。
- code-mode 路径不受影响且优先级相反（`tool/code-mode.ts:109` structuredContent 胜出）；其 `projectMcpResult`（`:75-116`）与错误 throw（`:161-167`，注释明说故意镜像 catalog）是最接近的仓库内先例。

### 2.3 P0-3 摘要输入二次截断 —— 成立（实际比 issue 描述更严重）

- `session/compaction.ts:30` `TOOL_OUTPUT_MAX_CHARS = 2_000`；`:51-52` 头部切片；`:54-85` `serialize`；工具分支 `:66-83`。**整个文件不读 `state.metadata`** ⇒ `exit`、`outputPath` 全丢。error 结果不截断（`:81`）。
- 输入 `state.output` 本身已是 truncate 预览（2000 行 / 50KB，`tool/tool.ts:135-143` 等通用包装），二次截断真实发生。
- **方向事实**：`tool/truncate.ts:89` `direction` 默认 `"head"`，**仓库内无任何调用点覆盖** ⇒ 通用工具（read/grep/glob/MCP/agent）的全文路径与继续读取 hint 都在预览**尾部**（`truncate.ts:133-137`），超过 2000 字符必被切掉——"摘要丢全文入口"是大输出工具的**常态**而非边缘情况。shell 特殊：路径在头部幸存（`shell.ts:579`），被切的是尾部 `<shell_metadata>` 诊断。
- 全文文件 **7 天清理**（`truncate.ts:12, 53-66`），幸存的引用也可能失效。
- **core 存在第二份平行实现且是活代码**（见 §3.3）。

### 2.4 其他核实

- **grep**（`tool/grep.ts`）：schema 仅 `pattern/path/include`，`limit: 100` 写死（`:67`）；有截断提示无分页 / 上下文行 / 输出模式。issue 描述属实（P2）。
- **提示词冲突**：`default.txt` L19/L85（强制 <4 行）、L58（修改后不解释）、L68（绝对禁注释）全部证实；`gpt-astra.txt` 有 autonomy/steering/commentary 规则；委派策略两模板相反（default L81 鼓励 vs gpt-astra L46 禁止）。详见 §3.4 矩阵。
- **死文件 ×2**：`session/prompt/copilot-gpt-5.txt`（143 行）与 `session/prompt/plan-reminder-anthropic.txt`（67 行）全仓 0 引用。
- 在途工作：无与 #46 相关的分支 / PR。

---

## 3. 专项调查

### 3.1 工具 metadata 投影面盘点

注册表 `tool/registry.ts:250-259`；shell 对外 id 是 `"bash"`（`shell/id.ts:14`，兼容保留，改名计划在 2.0）。

| 工具 | metadata | 模型可否从正文推断 |
|---|---|---|
| **bash** | `output`(UI 预览)/`exit`/`truncated`/`outputPath` | **exit 从不进正文（唯一不可推断项）**；truncated/outputPath 已在正文前缀 |
| read | `preview/truncated/loaded/display` | truncated 已印出；其余 UI-only |
| glob / grep | `count|matches`/`truncated` | 数量可数；grep 截断已印出，glob 未印出 |
| edit / write / patch | `diagnostics/diff/...` | 诊断非空时已渲染进正文；diff UI-only |
| todo / lsp / question | 全文冗余（output 即 JSON） | 冗余 |
| agent 系列 | `sessionId/model/count/...` | 正文已列 |
| code-mode | `toolCalls[]/error?` | 未进正文（次级价值） |
| 插件工具 | 任意 + 框架注入 `truncated/outputPath`（`registry.ts:182-196`） | outputPath 冗余 |

**结论**：通用 allowlist 投影需为大体积 UI 字段（diff/display/todos）设计排除契约，为 `exit` 一个字段不划算；投影应窄且字段存在性驱动。`grep/glob/read 的 truncated` 次级，暂不动。

### 3.2 MCP 投影仓库内先例（`tool/code-mode.ts:75-116` `projectMcpResult`）

- structuredContent **完全替代** text（`:109` 早返回），无判等去重——**仓库内没有任何现成去重逻辑**。
- `resource_link` → `` `${block.name}: ${block.uri}` ``（`:102-105`）。
- 纯附件结果 → `[N images/files attached to the result]` 占位。
- 返回裸对象，由 `:295-298` `JSON.stringify(value, null, 2)` 序列化（带缩进，仓库内对模型输出更常用）。
- 错误 throw 与 catalog 逐字重复（`:161-167`）⇒ 修错误路径需同步两处。

### 3.3 core runner 消费者确认 —— 两套并行 runtime，core 不是死代码

| runtime | 入口 | 压缩实现 |
|---|---|---|
| `SessionPrompt` 循环（V1） | 默认 `opencode` CLI/TUI/server handler（`server/routes/instance/httpapi/handlers/session.ts:11,52,54`） | `packages/opencode/src/session/compaction.ts` |
| core `SessionRunner`（V2） | `packages/cli serve`（`cli/src/commands/handlers/serve.ts:10`）+ `sdk-next` embedded server → `server/routes.ts:52` → `core/session/execution/local.ts:20` → `runner/llm.ts:109,222,377` | `packages/core/src/session/compaction.ts`（`:14` 同款 2000 常量、`:95-121` 平行 serialize） |

- core 包 `private: true` 不发 npm，但被打进 workspace 构建产物（`@opencode-ai/cli` 依赖）；git 历史显示该链活跃维护（`78f85b1 fix(core): ensure relevant files survive compaction` 等）。
- opencode 侧只从 core import `buildPrompt`（模板拼接器，`core:160-174`，被 `opencode:23` 引用）。
- 测试：core `serializeToolContent` 的拼接格式被 `core/test/session-compaction.test.ts:45` **精确字符串固化**（改动须更新该测试并在修复文档说明理由）；2000 截断本身无任何测试锁定。
- ⇒ **P0-3 修复必须覆盖两份**，否则 serve / sdk-next 运行时带病。

### 3.4 提示词装配链与冲突矩阵

**装配链**（收口 `session/llm/request.ts::preparePayload`）：

| 层 | 位置 | 说明 |
|---|---|---|
| 模型模板 XOR agent.prompt | `request.ts:195` 三元 | **互斥替换**：`agent.prompt` 存在则整体替换 `system.ts::provider(model)` 的 10 选 1 模板 |
| environment | `system.ts:69-105` | 模型名 + `<env>` + references |
| instructions | `instruction.ts:155-169` | AGENTS.md / CLAUDE.md 等 |
| MCP instructions | `system.ts:121-137` | |
| skills | `system.ts:107-119` | verbose 清单 |
| 合并 | `request.ts:193-201` | join 成**单串**；插件 `experimental.chat.system.transform`（`:204-208`）只能追加尾部，折回 `[header, rest]` |
| system → messages | `request.ts:114-125` | 例外：OpenAI OAuth 走 `options.instructions`（`:95`） |

**消息内注入（不在 system 射程）**：plan / build-switch reminder（`reminders.ts:155-230`，落库 synthetic part）、agent roster（`reminders.ts:56-153`）、read 尾注（`tool/read.ts:356`）、MAX_STEPS（`prompt.ts:1428`）、子代理工作目录说明（`agent-management/lifecycle.ts:225-245`）。

**子代理 prompt 来源**：`general/build/plan` 无 `prompt` 字段 → 继承父的模型模板（`agent/agent.ts:183`）；`explore/compaction/title/summary` 有显式 prompt → 替换模型模板（`:221,231,255,270`）；用户配置 agent 同理（`:289`）。

**冲突规则 × 模板矩阵**（✅ 硬性明文 / ◐ 软性或相反 / ❌ 未提及）：

| 规则 | default | anthropic | beast | gemini | gpt | gpt-astra | kimi | meta | codex | trinity |
|---|---|---|---|---|---|---|---|---|---|---|
| (a) 强制极短回答 | ✅ L19,L85 | ◐ | ❌(要求 thorough) | ◐ | ◐ | ◐ | ◐ | ◐ | ◐ | ✅ L11,L89 |
| (b) 修改后不解释/不总结 | ✅ L18,L58 | ❌ | ❌ | ✅ L12,L43 | ❌(反向:要求解释) | ❌(反向:要求 commentary) | ◐ | ❌ | ❌(反向:要求总结) | ✅ L10,L60 |
| (c) 绝对禁注释 | ✅ L68 | ❌ | ❌ | ◐ | ◐ | ❌ | ❌ | ◐ | ◐ | ✅ L70 |
| (d) 持续执行/完成判据 | ❌ | ❌ | ✅ | ◐ | ✅ | ✅ | ✅ | ◐ | ◐ | ❌ |
| (e) steering/途中消息 | ❌ | ❌ | ❌ | ❌ | ◐ | ✅ L27 | ◐ | ✅ L25 | ❌ | ❌ |

**委派策略光谱**：anthropic 最强鼓励（"proactively/CRITICAL"）> meta（并行拆分）> default/trinity（仅检索鼓励 + 异步事实说明）> kimi（条件允许）> beast/gemini/gpt/codex（不提）> gpt-astra（**禁止**，除非显式要求）。

**结构性结论**：
- default ≈ trinity 为重复副本，可合并。
- 共享行为段**不能放进 `system.ts::provider`**（会被 agent.prompt 三元整体丢弃）；唯一结构正确位置是 `request.ts:195` 三元之后、`...input.system` 之前——自动覆盖所有模型与子代理、利用后置覆盖压平冲突、缓存前缀友好。
- 旁路：`agent/agent.ts:375-388` `generate()` 不走 preparePayload，需单独决定是否注入。

### 3.5 压缩恢复既有机制盘点

**触发 → 摘要 → 恢复的完整时序**（`session/compaction.ts:343-586`）：

1. 触发五路：`isOverflow`（`prompt.ts:1304-1311`）、`willOverflow`（`:1443-1459`，fork 自有）、provider ContextOverflowError（`processor.ts:788-802` → `prompt.ts:1504-1514`）、HTTP summarize（`handlers/session.ts:273-293`）、runLoop 内 `compactionToken` FSM 去重（`:1216`）。
2. `create`（`compaction.ts:588-611`）写 user message + compaction part（schema `schema/v1/session.ts:195-202`）。
3. `processCompaction`：replay 切片（`:364-380`）→ `completedCompactions` 隐藏旧压缩对 + 取旧摘要（`:387-390`）→ `select` 按 `preserve_recent_tokens`（默认 clamp(usable×25%, 2k, 15k)，`:115-120`）切 head/tail（`:391-395`）→ 插件 `experimental.session.compacting`（`:397-401`）→ clone + `messages.transform` + `serialize`（`:402-404`）→ `buildPrompt`（`:405-415`）→ 摘要落库（`summary:true`，`:417-443`）→ 摘要请求（**无工具**，system 实际为 `agent/prompt/compaction.txt`，单条内联 user 消息，`:449-472`）→ `tail_start_id` 回写（`:485-490`）→ replay / autocontinue synthetic user（`:492-577`，`compaction.auto` 默认 true）→ 发布 `session.compacted`（`:582-584`）。

**压缩后每轮仍会注入**：重排消息（`filterCompactedEffect`，`message-v2.ts:526-577`，输出 `[compaction-user "What did we do so far?", assistant <summary>, ...tail..., ...]`）、系统提示词全量重建（`prompt.ts:1411-1423`）、plan / build-switch reminder（`:1323`）、agent roster（`:1328`）、工具集重解析（`:1380-1395`）。

**压缩后不会注入**：todo 状态、已加载 skill 正文、后台任务、子代理历史。

**状态源盘点**：

| 状态 | 存放 | 注入途径 | 缺口 |
|---|---|---|---|
| plan 文件 | `session.plan()`（`session.ts:419-424`） | reminders synthetic part（`reminders.ts:196-205,216-227`） | 依赖 `agent === "plan"` 历史标志，可能被压缩抹掉 |
| skill 已加载正文 | 仅 tool part `state.output` | 无 | 压缩后只剩 2000 字符版 |
| agent roster | `AgentStatusProjection` + `tree.ts`（`ROSTER_MAX_ROWS=10`，只列 running） | `reminders.ts:56-153`，触发 `turnStart ∨ compacted`，落库 + 逐字节去重（`:138-141`） | **已实现，是可复用模板** |
| todo | DB `TodoTable`（`session/todo.ts:29-66`） | **完全没有注入路径** | 模型只能自行调 `todowrite` 读取 |
| 后台任务 | `BackgroundJob`（`core/background-job.ts:1-115`，注释明说非持久化） | 无自动注入，仅 `agent_list` 主动拉取 | |
| 插件/事件 | `experimental.session.compacting`（压缩前 context）、`experimental.compaction.autocontinue`、`session.compacted` 事件 | — | **事件无任何生产消费方**（`schema/session-compaction-event.ts:6-11`，payload 仅 `{sessionID}`） |

**装配点结论**：恢复材料的自然挂点是 `prompt.ts:1323-1332` 的 turn-boundary 管线 + `reminders.ts` 的 applyAgentRoster 模式（"compaction 发生过且此后无同类注入 → 重建并落库 synthetic part"），**不在 compaction.ts 内部**。硬约束：恢复 part 必须写在 `tail_start_id` 指向消息之后（或挂在 compaction user 上），否则被 `filterCompacted` 第一阶段截掉。

---

## 4. 决策点

> 以下"倾向"均为讨论稿建议，**未经确认**；确认后按 §5 流程推进。

### B. shell 退出码投影（P0-1）

| 方案 | 改动 | 代价 |
|---|---|---|
| B1 源头拼（`shell.ts` 把 exit 写进 output 文本） | 1 处 | 重放 / serialize / UI 自动一致；但持久化与 UI 多一行（CLI footer 已显示 exit）、快照测试跟着动；`!cmd` 需另写同格式 |
| **B2 读方投影（倾向）**：`message-v2` 按 `metadata.exit !== undefined` 字段存在性窄投影 + serialize 由 P0-3 的 metadata 行覆盖 | 2 读方 + 1 小 helper | UI/持久化干净；"模型所见"有两个 formatter 需同步——P0-3 本就要动 serialize，同一 helper 两处复用 |

配套：`prompt.ts:684` 补记 `!cmd` 的 exitCode（无论方案都必须）。
待拍板：① B1 vs B2；② 只标非零（倾向：是，`exit 0` 静默防噪音）还是全标；③ 确认非零**不**渲染成 error 语义（grep exit 1 = 无匹配不是错误，与 issue "不能机械地把所有非零视为相同故障"一致）。

### C. MCP structuredContent（P0-2）

修复定位 `tools.ts` 投影层（不动 catalog，保住上游固化测试）。子决策：

1. **合并 vs 替代**（倾向**追加 + 判等去重**）：替代（code-mode 式）会丢 text 的自然语言上下文；判等需新写（`JSON.stringify(sc)` 与某 content text 项严格相等则跳过）。
2. **预算**（倾向并入同一次 `truncate.output`）：超大输出 + 超大 sc 的病例场景接受截断。
3. **resource_link / audio**（倾向）：resource_link 用 code-mode 同款 `${name}: ${uri}` 文本行；audio 用方括号占位文本（沿用 `[Binary MCP resource omitted: ...]` 格式先例）。
4. **错误路径**（倾向**单独立小 PR**）：需同步改 `catalog.ts:68-74` 与 `code-mode.ts:161-167` 两处重复 throw，让错误信息携带 structuredContent 摘要；会改变插件可见的 throw message。

### D. 摘要二次截断（P0-3）

1. **头尾分配**：completed 工具结果改"头 N + 尾 M"（M 400~800 量级，保住全文 hint 与尾部诊断），≤2000 保持原样。
2. **metadata 行**：serialize 补 `[exit code: N]`（非零时），与 B2 共用 helper。
3. **两份 serialize 的组织**：已有两个真实消费者（V1 主循环 + V2 runner），符合"第二个消费者出现再合并"的条件。倾向把"头尾截断 + metadata 行"抽成 core 内小 helper、两边 import（opencode 已有 import `buildPrompt` 先例），防再漂移；反方案为两处各改 + 交叉注释（sync 冲突更小）。
4. core `serializeToolContent` 格式测试（`session-compaction.test.ts:45`）需随行为变更更新，理由写入修复文档。
5. 7 天全文保留期不在本项处理，记为 F 的设计输入。

### E. 提示词统一（P1，§4 设计流程）

结构性结论已定（§3.4）：共享段放 `request.ts` 三元之后。待拍板：

1. **委派方向**（产品决策）：fork 重仓 agent-management（异步 agent_list/send/stop + roster 注入 + PR #43 TUI），default 的"检索优先委派 + 不轮询"与 fork 特性自洽；gpt-astra 的"默认禁止"与 fork 特性相悖。**倾向跟 fork 自己的特性走**。
2. **第一步刀法**（倾向最小刀法）：先插共享段 + 只删 default/trinity 三条硬冲突（<4 行 / 修改后不解释 / 绝对禁注释），其余模板保留软性表述；矩阵入设计文档后续迭代；不做 10 模板一次性大改。
3. 共享段文案（完成判据 / steering / 验证与真实报告）需单独过稿。
4. 死文件清理（`copilot-gpt-5.txt`、`plan-reminder-anthropic.txt`）：直接删，可独立小 PR。

### F. 压缩后恢复（P1，§4 设计流程；若含插件契约则加子计划 v2）

1. **文件恢复策略**（倾向磁盘重读）：按最近读/编辑排序取 top-K（read/edit metadata 有现成 path）、预算封顶、与 tail 同版本去重、失效/过大给可诊断引用——CC 式磁盘重读能拿到当前版本，ZCode 式缓存回填便宜但可能过时。
2. **契约刀法**（倾向 v1 只做内部恢复）：文件 / todo / skill / roster 的内部恢复先行；插件恢复契约记"引入条件"延后——`session.compacted` 事件与 reminders 挂点已就位，后续加契约成本低且能被真实需求塑形。**与 issue 原文（要求恢复扩展契约）有出入，需裁决**。
3. 待设计细化：恢复材料与"摘要 + tail + 固定段"的联合预算口径；plan reminder 对 `agent === "plan"` 标志的依赖修复；todo 注入形态。

### G. P2 项（暂缓，方向已明）

- grep：schema 向后兼容扩展（输出模式 / 上下文行 / head_limit+offset），区分无匹配 / 越界 / 非法表达式 / 截断。
- shell 后台执行：独立能力立项（run_in_background / 任务 ID / 输出路径 / 完成通知），不默认改变现有超时语义。
- 按工具的结果预算、并发 / 流式 / 媒体转换契约测试。

---

## 5. 流程归类、顺序与时序风险

| 项 | 流程 | 形态 |
|---|---|---|
| P0-1 / P0-2 / P0-3 | §7 修正方案文档 + 回归测试 | 三个独立小 PR；P0-2 错误路径可拆第四个 |
| 死文件清理 | 直接删 | 小 PR 或并入 P0-1 |
| 提示词统一 | §4 全流程（调研 → 架构 → 细化 → 审查） | feature `docs/design/prompt-unification/` |
| 压缩恢复 | §4 全流程；含插件契约时加子计划 v2 | feature |
| grep / 后台 shell | P2 | 暂缓 |

**时序风险**：upstream（anomalyco）dev 已领先 112 提交，且把子代理工具 `agent` → `task` 改名（波及 `default.txt` / `anthropic.txt` / `truncate.ts` hint / `tools.ts` `TaskPromptOps`），与 fork 的 agent-management 特性区正面重叠——下次 sync 冲突会集中在该区域。本文涉及的修复文件（`message-v2.ts` / `tools.ts` MCP 循环 / `compaction.ts`）与上游演化区重叠但不冲突。**结论：P0 尽早做**；`contextOverflowFromMessage` 为 fork 独有（上游从未有过），sync 时防止被覆盖。

---

## 6. 待拍板问题清单

| # | 问题 | 倾向 |
|---|---|---|
| 1 | B① exit 投影位置：B1 源头拼 vs B2 读方投影 | B2 |
| 2 | B② 标注范围：只标非零 vs 全标 | 只标非零 |
| 3 | C① structuredContent 合并 vs 替代 | 追加 + 判等去重 |
| 4 | C④ 错误路径是否单独拆 PR | 拆 |
| 5 | D③ 头尾截断 helper 抽 core vs 两处复制 | 抽 core |
| 6 | E① 委派策略方向 | 跟 fork agent-management 特性走（default 式） |
| 7 | E①' 共享段位置（三元之后） | 无异议则不再讨论 |
| 8 | F② 恢复契约 v1 内部 vs 全量（与 issue 原文有出入） | v1 内部，契约延后 |
