# 开发日志 — P0-1 工具退出码投影修复

日期：2026-10-12
分支：`issue-46-runtime-alignment`
提交：`896e093b4e`
关联：issue #46、`docs/research/runtime-alignment-research.md` §7 决议 #1-3、`docs/fixes/session-fix-tool-exit-code-projection.md`

## 做了什么

按已定决议（B2 读方投影、只标非零、保持成功语义）实施 issue #46 的 P0-1：

1. **core 新增共享 helper** `formatExitCodeLine`（`packages/core/src/session/tool-result-projection.ts`）：仅有限非零数字产生 `[exit code: N]` 行；P0-3 的 serialize metadata 行将复用（决议 D① 抽 core）。
2. **message-v2 completed 分支**条件追加状态行：追加在 `truncateToolOutput` 之后；`compacted` 分支不标注；`exit` 缺失/0/null/非数字时输出与现状逐字节一致。
3. **`!cmd` 直执行路径**补记 `handle.exitCode` 进 metadata，被同一投影覆盖。

## 关键决策与理由

- 读方投影而非写方拼接：UI/持久化/既有快照零改动（修正方案 §4）。
- 实施中一处自我修正：最初写 `yield* handle.exitCode`（沿用原代码），但 JS 生成器的补全值是 `return` 的值，尾部裸 `yield*` 的表达式值被丢弃 → gen 成功值是 `undefined` → metadata 拿不到 exit。新加的 `!cmd` 回归用例抓住了它（先红后绿）。已改为 `return yield* handle.exitCode` 并回写 CLAUDE.md。

## 测试

- 新增 6 个用例：message-v2 五个（回归/负例/compacted/附件）+ prompt 一个（`!cmd` 真实进程 exit 7）。
- 回归：`test/session/` 610 全过、core 1098 全过、message-v2 50/50、prompt 99 pass + 1 既有 skip、双包 typecheck 干净。

## 待办

- P0-2（MCP structuredContent 合并 + 错误路径同修）与 P0-3（serialize 头尾保留 + metadata 行，复用本 helper）各出修正方案文档后实施。

## 度量

| 指标           | 数值                                          |
| -------------- | --------------------------------------------- |
| 新增代码行数   | 132（helper 24 + 测试 108）                   |
| 修改代码行数   | 11（message-v2 7、prompt 4）                  |
| 删除代码行数   | 3                                             |
| 涉及文件数     | 5（代码/测试）+ 2（修正方案回填、本日志）     |
| 新增测试用例数 | 6                                             |
| 测试通过率     | session 610/610、core 1098/1098（1 项既有 skip 非 fail） |
| 发现 bug 数    | 2（产品缺陷 P0-1 本身；实施中生成器补全值丢弃 bug，被新用例抓住） |
| 修复 bug 数    | 2（同上两项均已修）                           |
| 迭代轮次       | 实现 1 轮（含 2 次测试 fixture 修正、1 次实现修正） |

## 经验教训

- **`Effect.gen` 的成功值是生成器的 `return` 值**：尾部裸 `yield* x` 的表达式值会被丢弃，gen 结果是 `undefined`。要把尾表达式作为返回值必须写 `return yield* x`。本次被自己的新用例当场抓住——"为 `!cmd` 补记 exit 而写的测试"恰好验证了补记逻辑，说明第七部分清单里"顺手覆盖新改动"的用例不是形式主义。（已同步回写 CLAUDE.md）
- **测试 fixture 对模型消息形状的假设要与转换器对齐**：`toModelMessages` 会丢弃空 parts 的 user 消息、把字符串 output 包成 `{type:"text", value}`——直接断言"我以为的形状"连错两次，先探针确认真实形状再写断言更快。
