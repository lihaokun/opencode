# 开发日志 — P0-3 摘要输入头尾保留修复

日期：2026-10-12
分支：`issue-46-runtime-alignment`
提交：`fc071384f2`
关联：issue #46、`docs/research/runtime-alignment-research.md` §7 决议 #6、`docs/fixes/session-fix-summary-tool-output-truncation.md`

## 做了什么

按已定决议（D① 抽 core helper、两份 serialize 同改）实施 issue #46 的 P0-3：

1. **core helper 扩展**：`summarizeToolText`（`tool-result-projection.ts`）——≤2,000 字节级不变；超出时头 1,400 + `[... N chars truncated ...]` + 尾 600。纯截断，exit/compacted 留在 V1 调用点。
2. **opencode serialize**：completed 分支改用 helper；其后追加 `formatExitCodeLine(part.state.metadata)`（P0-1 helper 复用）；compacted 分支原样；error 分支不动。
3. **core serialize**：工具分支与 `[Shell]` 行的 `truncate` 换成 helper；两份本地 2,000 常量与头切函数删除（grep 确认无残余消费）。
4. **新发现记录为 follow-up**：core V2 回放含 `state.structured`，但其摘要 serialize 只序列化 `content` 块——V2 摘要输入丢 structured（与 P0-2 同族），需核实 V2 structured 填充方后单独立项。

## 测试

- 新增 6 个单元测试（core）：预算内字节不变（1,999/2,000 两档）、头尾切片 + 省略标记、尾部 hint 存活、`formatExitCodeLine` 直测（补上 P0-1 helper 的直测缺口）。
- 回归：core 1102/1102（含 `serializeToolContent` 格式固化测试——本修复不动它，预期通过、实际通过；含 runner 压缩集成）、opencode session 目录 619/619、双包 typecheck 干净。

## 待办

- follow-up：V2 摘要输入丢 `state.structured` 的核实与修复。
- F 阶段（压缩后恢复）设计时纳入：全文文件 7 天保留期问题。
- 既有 2 项环境敏感测试失败（P0-2 devlog 记录）待单独排查。

## 度量

| 指标           | 数值                                            |
| -------------- | ----------------------------------------------- |
| 新增代码行数   | ~50（helper ~30 + 测试 ~50，净）                |
| 修改代码行数   | ~12（两处调用点）                               |
| 删除代码行数   | 13（两份本地 truncate + 常量）                  |
| 涉及文件数     | 4（代码/测试）+ 2（修正方案回填、本日志）       |
| 新增测试用例数 | 6                                               |
| 测试通过率     | core 1102/1102、session 619/619（0 fail）       |
| 发现 bug 数    | 1（产品缺陷 P0-3 本身）+ 1 个新发现问题记录（V2 structured 丢失，未修） |
| 修复 bug 数    | 1（P0-3）                                       |
| 迭代轮次       | 实现 1 轮（0 次返工——P0-1 建立的 helper 结构使本项为纯增量） |

## 经验教训

- **共享 helper 的复利在第三个 PR 兑现**：P0-1 建 `tool-result-projection.ts` 时只服务一个调用点，P0-3 的修改变成"helper 加一个纯函数 + 两处替换调用"，零返工、测试只补 helper 直测——验证了 D① 决议（两个消费者出现时合并）的成本模型。
- **core pinned 测试的恐惧要落到具体断言上**：动手前确认 `session-compaction.test.ts:45` 锁的是 `serializeToolContent` 的内容块格式而非外层截断，本修复就不需要动它——"改行为会不会挂固化测试"应该读断言回答，不该凭印象担心。
