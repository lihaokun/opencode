# 开发日志 — P0 端到端测试补齐

日期：2026-10-12
分支：`issue-46-runtime-alignment`
提交：`ed32817a65`
关联：issue #46 §五验收、P0-1/2/3 三份修正方案文档

## 做了什么

用户指出 P0 只有"链条两端"的分层测试、没有串起整链的端到端测试——修正这个缺口：

1. **P0-1 全链**（`prompt.test.ts` +2）：fake LLM 发起真实 bash 工具调用（`bun -e "process.exit(7)"`），loop 续跑后从 `llm.inputs` 捕获第二轮请求体，断言 tool 消息含 `(no output)` 与 `[exit code: 7]`；exit 0 负例静默。
2. **P0-3 全链**（`compaction.test.ts` +1）：真实 `processCompaction` 驱动（复用 `withCompaction({llm})` 的 `streamBatches` 捕获点），>2,000 字符工具结果（HEAD_MARKER + 中段 + 尾部 hint）+ exit 7，断言捕获的摘要载荷含头标记、`[... 1084 chars truncated ...]`、`Full output saved to:`、`[exit code: 7]`，且中段不在。
3. **P0-2 全链**（`mcp-default-path.test.ts` 新文件）：真 InMemory server（content+sc 并存）→ `McpCatalog.convertTool` → `SessionTools.resolve` execute 闭包（含 truncate/metadata/attachments 装配）→ output 文本精确等于 text + sc 序列化。

## 关键发现

- fake LLM server（`llm-server.ts`）本就有 `inputs` 捕获请求体的能力，compaction harness 的 `streamBatches(input)` 捕获点也已存在——E2E 缺的不是设施而是没人把链走通。
- E2E-2 首版断言把省略字符数算错（3,083 vs 实际 3,084），失败输出反而完整展示了机制正确——修断言不修实现。
- tools.test 的 `resolve` harness 模式（fake MCP → 真客户端入口）可以直接换成"真 InMemory server"，堵住了默认路径从未被测的问题。

## 测试

- 新增 4 个 E2E 用例；prompt/compaction/mcp-default-path 三文件 171 项全过；session 目录 623 项全过；typecheck 干净。

## 度量

| 指标           | 数值                                       |
| -------------- | ------------------------------------------ |
| 新增代码行数   | ~258（全部为测试）                         |
| 修改代码行数   | 0                                          |
| 删除代码行数   | 0                                          |
| 涉及文件数     | 3（测试）+ 3（修正方案文档回填）+ 本日志   |
| 新增测试用例数 | 4                                          |
| 测试通过率     | 171/171（三文件）、623/623（session 目录） |
| 发现 bug 数    | 0（三条链实现均正确；首版断言两处笔误自纠）|
| 修复 bug 数    | 0                                          |
| 迭代轮次       | 1 轮                                       |

## 经验教训

- **分层测试 ≠ 验收口径**：issue 写"模型收到可区分状态"，分层测试只证明每个环节各自正确——接缝（序列化后的载荷、wire 格式、闭包装配）必须有贯穿链路的测试背书。修正方案文档的测试清单今后应显式包含"贯穿链路"一行，而不是等验收时补。
- **E2E 的设施往往已存在**：`llm.inputs`、`streamBatches` 捕获、InMemoryTransport 都是现成的；写 E2E 前先翻 test/lib 和既有 harness，通常只需"把链走通"而不是"搭新台子"。
