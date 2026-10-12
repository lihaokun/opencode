# 修正方案 — MCP structuredContent / resource_link / audio 投影与错误路径（P0-2 / issue #46）

> 流程：workflow §7。状态：**已实施**（commit `12bd8a704f`，2026-10-12）。
> 关联：`docs/research/runtime-alignment-research.md` §3.2 / §4.2 / §7 决议 #4-5（C① 追加+判等去重；C③ 错误路径**合并进本 PR**——用户决策，覆盖原"拆分"倾向）。

## 第一部分：现象与复现

**现象。** 三个必现的信息丢失：

1. MCP 工具返回 `content`（非空）+ `structuredContent` 并存时（协议允许），结构化数据对模型与持久化都不可见——模型只看到 content 文本（如"查询完成"）。
2. `resource_link`、`audio` 两类内容被投影循环**静默丢弃**（连占位文本都没有）。
3. `isError = true` 且错误详情只放在 `structuredContent`（协议允许）时，模型只看到兜底文案 `"MCP tool returned an error"`。

**最小复现（将固化为回归测试）。** CallToolResult `{ content: [{type:"text",text:"查询完成"}], structuredContent: { matches: [{path:"src/a.ts",line:42}] } }` 经普通 MCP 路径投影后，`output` 不含 `matches`；修复后含。

**出错代码路径。**

1. `packages/opencode/src/mcp/catalog.ts:75-80` — content 非空时 sc 不转换（**上游有意设计**，commit `fd213e6df6`，测试固化；本修复**不改**此行为）
2. `packages/opencode/src/session/tools.ts:429-465` — 投影循环只有 text/image/resource 分支、**无 else**：sc 不是 content 块不进循环；`resource_link`/`audio` 无分支 ← **丢失点（数据）**
3. `packages/opencode/src/mcp/catalog.ts:68-74` 与 `packages/opencode/src/tool/code-mode.ts:161-167` — isError 在任何投影之前 throw，message 只拼 content 的 text 项 ← **丢失点（错误）**，两处逐字重复

**预期 vs 实际。** 预期：sc、resource_link、audio 不静默丢失（不静默 ≠ 必须全量承载，降级需显式说明）；错误信息可诊断。实际：三者皆丢。

## 第二部分：根因分析

- **症状**：sc / resource_link / audio / 错误详情对模型不可见。
- **根因（数据）**：catalog 的"content 优先"是传输层约定——它只负责 content 为空时的兜底转换，sc 原样保留在返回对象上；丢失发生在投影层（tools.ts）没有消费 sc 的分支，且持久化 schema 只存投影产物。**修投影层，不动 catalog**——与上游设计对抗会破坏固化测试（`catalog.test.ts:30-50`）。
- **根因（错误）**：throw 发生在投影之前，message 组装只认 text 项。修 message 组装，两处镜像同步。
- 非绕过：判等去重、占位文本都是投影契约的正式部分，记录于本文件与 research 文 §7。

## 第三部分：参考实现对照

| 维度 | 仓库内 code-mode（`code-mode.ts:75-116`） | ZCode（`mcp/index.ts:362-383, 420-427`） | 本修复 | 理由 |
|---|---|---|---|---|
| sc 进正文 | **替代**（sc 胜出，`:109`） | **追加**（非空即追加 `Structured content:` 块，与 content 是否非空无关） | **追加 + 语义判等**（parse + 深相等） | code-mode 的消费者是 JSON 解释器（替代成立）；默认路径消费者是模型正文（追加保住自然语言上下文，决议 C①）；语义判等严格覆盖严格相等（含 catalog 路径与紧凑回显），额外拦住格式/键序变体的重复，ZCode 无判等 |
| resource_link | `${name}: ${uri}` 文本行（`:102-105`） | 兜底 JSON stringify（`:427`） | **`${name}: ${uri}`** | 仓库内先例更可读 |
| audio | 走附件通道（dataUrl） | 占位文本 `[MCP audio content omitted: <mime>]` | **占位文本**（同 ZCode 格式） | 默认路径附件通道不给音频（部分 provider 不支持工具结果带音频），不为它做 provider 适配 |
| 错误 message | 与 catalog 逐字镜像（`:161-167`） | 错误走包装文本 + part 级 isError | **两处 throw 同步修**，抽一个共享的 message 组装函数 | 决议 C③ 合并修；共享函数消掉"故意镜像"的漂移隐患 |

## 第四部分：修复方案

**改什么。**

1. **`session/tools.ts` 投影循环（:429-465）**：
   - 新增 `resource_link` 分支：`textParts.push(`${contentItem.name}: ${contentItem.uri}`)`
   - 新增 `audio` 分支：`textParts.push(`[MCP audio content omitted: ${contentItem.mimeType}]`)`
   - 循环后、`truncate.output` 之前：若 `result.structuredContent != null` → `serialized = JSON.stringify(sc)`；当 `textParts` 中**没有一项与 sc 语义相等**时 `textParts.push(serialized)`。语义判等 = `item === serialized`（快路径）或 `parsesTo(item, sc)`：`try { return Bun.deepEquals(JSON.parse(item), sc) } catch { return false }`——非 JSON 的 prose 项解析即失败、按不等处理；深相等键序不敏感。裸 JSON 追加（**与 catalog 空 content 兜底的裸 stringify 格式一致**）。合并文本继续走既有 `truncate.output` 单次调用（决议：不单独设预算）。`parsesTo` 为 `tools.ts` 模块局部函数（单一消费点，不进 core）。
2. **`mcp/catalog.ts`（:68-74）**：抽导出小函数 `callToolErrorMessage(result: CallToolResult): string` — `[...contentTextItems, structuredContent?.stringify].filter(非空).join("\n\n") || "MCP tool returned an error"`；isError 分支改用它。兜底文案与现状一致。
3. **`tool/code-mode.ts`（:161-167）**：镜像 throw 改调 `McpCatalog.callToolErrorMessage`（`code-mode.ts:148` "Deliberately mirrors" 注释同步更新为指向共享函数）。
4. **`tools.ts` 的 `output.metadata` 不复制 sc**——sc 已进正文，避免持久化双份。

**修复后复现走查。**

- content 非空 + sc → 正文 = text + `\n\n` + sc JSON ✓（最小复现转绿）
- content 为空 + sc → catalog 已把 sc 转成唯一 text 项 → 快路径 `item === serialized` 命中 → 跳过 → 输出与现状完全一致 ✓
- sc 与某 text 项完全相同（紧凑回显）→ 快路径命中 ✓；pretty-print / 键序变体的同一数据 → `parsesTo` 深相等命中 ✓
- text 为任意 prose → parse 失败 → 追加 ✓
- resource_link → `${name}: ${uri}` 行；audio → 占位行 ✓
- isError + 仅 sc → throw message = sc JSON；isError + 仅 text → 兜底文案与现状一致 ✓

## 第五部分：正确性论证

- **根因消除**：投影循环补齐缺失的三个分支（数据路径）；错误 message 组装补齐 sc 通道（错误路径）；catalog 的 content-first 契约零改动。
- **不变量保持**：content 为空路径字节级不变（判等命中的推导见上）；`experimentalCodeMode` 开启时 tools.ts 普通循环不可达（互斥，`:391` 早返回）；metadata 形状不变；attachments 逻辑不变。
- **无回归**：现状下 sc/resource_link/audio 对模型均不可见——新增内容只会出现在今天输出为空缺的场合；既有 catalog 测试（content 优先两条）不涉及 isError message，不受影响；`code-mode.test.ts:297/509/574` 断言投影结果（替代语义），本修复不动 code-mode 的替代语义，不受影响。唯一可能受影响的既有断言：若有测试固化错误兜底文案的**来源格式**，复跑确认（第六部分含复跑项）。
- **副作用论证**：纯投影层与 message 组装变更，无共享状态写入、无外部资源操作。

## 第六部分：测试用例清单

| 类型 | 用例 | 状态（修复后回填） |
|------|------|------|
| 回归 | content 非空 + sc → output 含 text 与 sc（最小复现固化） | 已加: `mcp-projection.test.ts > regression...` @ `12bd8a704f` |
| 新增 | sc 与 text 项完全相同 → 不双倍（快路径判等命中；同时保护 content 为空路径） | 已加: `exact echo...` + `catalog's empty-content conversion stays byte-identical...` @ `12bd8a704f` |
| 新增 | sc 的 pretty-print / 键序变体出现在 text → 不双倍（语义判等命中） | 已加: `pretty-printed variant...` + `reordered keys...` @ `12bd8a704f` |
| 新增 | text 为非 JSON prose → sc 正常追加 | 已加: `non-JSON prose...` @ `12bd8a704f` |
| 新增 | content 为空 + sc（经 catalog 转换）→ 输出与现状一致（判等命中，保护既有行为） | 已加: 同上 `catalog's empty-content...`（经 catalog.test.ts 既有用例覆盖转换侧） |
| 新增 | `resource_link` → `${name}: ${uri}` 行 | 已加: `resource_link renders as name: uri` @ `12bd8a704f` |
| 新增 | `audio` → `[MCP audio content omitted: <mime>]` 行 | 已加: `audio degrades to a placeholder line...` @ `12bd8a704f` |
| 新增 | isError + 仅 sc → throw message 含 sc JSON；isError + 仅 text 无 sc → 兜底文案不变 | 已加: `catalog.test.ts > McpCatalog.callToolErrorMessage`（3 例）@ `12bd8a704f` |
| 新增 | code-mode 镜像：isError message 同步 | 已加: `code-mode.test.ts > an MCP error carrying only structuredContent...` @ `12bd8a704f` |
| 已有 | catalog / code-mode / session tools 全量复跑 + 双包 typecheck | 已复跑: 三文件 53/53；session/mcp/tool 目录 1004 项中 994 pass + 7 skip + 1 todo + **2 项既有环境敏感失败**（write 权限 umask、oauth-callback，已用 stash 验证基线同样失败，与本修复无关）；typecheck 干净 |

harness 说明：投影循环提取为纯函数 `projectMcpToolResult`（`tools.ts` 导出，唯一消费点在 execute 闭包），测试直接以 `CallToolResult` 形状驱动，无需搭服务 harness——提取本身被 typecheck 检出一处既有类型洞（内联代码靠推断逃过 `resource` 嵌套联合的属性访问，显式签名后以 `in` 收窄修复，见 devlog）。

## 第七部分：代码更新清单

| 文件 | 函数 / 位置 | 改动概述 | 状态（修复后回填） |
|------|------------|---------|------|
| `packages/opencode/src/session/tools.ts` | 投影循环 → 纯函数 `projectMcpToolResult` + `parsesTo` | resource_link / audio 分支 + sc 追加语义判等 | 已改: `12bd8a704f` |
| `packages/opencode/src/mcp/catalog.ts` | isError 分支（:68-74） | 抽 `callToolErrorMessage`（含 sc 通道）并改用 | 已改: `12bd8a704f` |
| `packages/opencode/src/tool/code-mode.ts` | 镜像 throw（:161-167） | 改调共享函数，更新镜像注释 | 已改: `12bd8a704f` |
| `packages/opencode/test/*` | `mcp-projection.test.ts`（新）+ catalog/code-mode 用例 | 第六部分清单落地 | 已加: `12bd8a704f` |

## 第八部分：文档更新清单

| 文档路径 | 要改什么 | 状态（修复后回填） |
|---------|---------|------|
| `docs/research/runtime-alignment-research.md` | §7 决议 #4-5 实施回填 | 已改: commit hash 见 devlog `docs/devlog/2026-10-12-session-fix-mcp-structured-content-projection.md` |
| `docs/devlog/` | P0-2 实施日志（含度量） | 已加: `docs/devlog/2026-10-12-session-fix-mcp-structured-content-projection.md` |
| 无 schema/枚举/接口契约文档 | 新契约（追加格式、判等规则、占位文案、错误 message 组装）权威记录为本文第四部分 | 无（+理由） |
