# 开发日志 — 同步 upstream/dev

- 日期：2026-08-30
- 分支：`dev`
- 上游：`upstream/dev` (`10765ff2a9`)
- 同步方式：merge（保留双方历史，不改写本地提交）

## 背景

本地 `dev` 相对共同祖先包含 7 个独有提交，上游 `dev` 包含 433 个独有提交。本次将上游合并到本地分支，同时保留本地已实现的 incomplete-stream recovery、context-overflow recovery、message ID rollover chronology、reasoning fragment coalescing、bounded doom-loop detection 与 resumable task error 契约。

初次 merge 产生 23 个冲突文件，涉及核心 session 流程、App/TUI chronology、Task/Truncate、依赖 patch 与对应回归测试。冲突不能整体选择 ours/theirs，必须逐项组合双方行为。

## 完成内容

1. 合并 LLM request 与 prompt loop：
   - 保留 prepared payload 复用、reasoning budget normalization 与实际 payload preflight；
   - 统一最新 user turn 判定，兼容 direct parent 与 rollover chronology fallback；
   - 保留 OpenCode/普通 provider headers，并统一传递 parent session ID。
2. 合并 message chronology、session 与 revert：
   - 以数据库 `time_created` 为持久化 chronology 真值，ID 仅作为同时间戳 tie-break；
   - part 按 `time_created, id` 排序；
   - revert 持久化 message/part 时间边界，边界实体已删除时仍可 cleanup；
   - legacy revert 仅在读取时 hydrate，不制造 list API 的 N+1 查询。
3. 合并 Task 与 Truncate：
   - foreground/background task error 使用安全 markup envelope；
   - assistant error 与 terminal child tool error均暴露 resumable task ID，并限制错误与 partial output 大小；
   - truncate cleanup 按文件 mtime，而非会 rollover 的编码 ID 时间戳。
4. 合并 App/TUI session chronology：
   - timestamp 可用时按 chronology；
   - legacy timestamp 缺失且 exact boundary 存在时按数组邻接；
   - boundary 缺失时保留 raw-ID compatibility fallback；
   - restore、undo/redo、archive、dock 与 reverted suffix 使用相同边界语义。
5. 合并测试与依赖 patch：
   - 将交叉混拼的 LLM、Prompt、CLI 与 Revert 冲突重建为独立完整用例；
   - OpenAI-compatible patch 同时保留 structured stream error 与 empty `tool_calls` guard；
   - 清理 `package.json` 与 `bun.lock` 中重复的 patched dependency key；
   - 规范化 Groq/xAI patch whitespace，并同步修正 hunk 行数。
6. 修复合并后验证问题：
   - processor Effect tests 使用 `SessionRetry.delay(attempt, undefined, 1)` 推进 TestClock，覆盖 25% jitter 上界；
   - CLI task tests 改为验证完整安全 envelope、child task ID 与具体错误；
   - Task terminal tool error 在使用处缩窄 nested state union，恢复 OpenCode typecheck。

## 关键决策

- **采用 merge 而非 rebase**：保留本地 7 个提交与上游 433 个提交的原始历史，避免已推送历史重写。
- **不使用全局 ours/theirs**：本地提交包含上游尚无等价实现的 bounded recovery、durable chronology 与周期检测；上游同时包含大量结构升级，必须按契约组合。
- **chronology 以持久化时间为主**：36-bit ascending ID 会 rollover，raw-ID 永久单调假设不成立；legacy 数据才使用兼容 fallback。
- **retry 与 incomplete retry 预算独立**：普通 provider retry 上限与 incomplete-stream 的两次恢复预算保持分离，replay fence 后不重放。
- **测试适配新契约而非回退生产行为**：task error 的安全 envelope/resumable ID 与 retry jitter 均为合并后的明确契约，失败测试应更新预期。
- **patch 修改必须双验证**：先对已安装产物执行反向 apply check，再运行 `bun install --frozen-lockfile`，避免仅通过文本检查却破坏 patch parser。

## 验证结果

| 验证项 | 结果 |
|--------|------|
| `bun install --frozen-lockfile` | 通过；2426 installs/2705 packages 检查完成，后续 patch 规范化安装成功 |
| OpenAI-compatible 安装产物 | `dist/index.js`、`dist/index.mjs`、TS 源码的两个 patch hunk 均确认存在 |
| OpenCode session/tool 定向集 | 合并初轮 368 pass、2 skip、14 timeout；修正后等价最终结果 382 pass、2 skip |
| `test/session/processor-effect.test.ts` | 78/78 通过，577 次断言 |
| `test/cli/run/run-process.test.ts` | 22/22 通过，144 次断言 |
| App chronology tests | 17/17 通过，33 次断言 |
| TUI session tests | 5/5 通过，9 次断言 |
| 定向测试合计 | 426/426 通过，另 2 skip；未宣称全仓库测试全部执行 |
| OpenCode typecheck | 通过 |
| App typecheck | 通过 |
| TUI typecheck | 通过 |
| conflict marker / unmerged path | 0 / 0 |
| `git diff --cached --check` | 通过 |
| merge head | `10765ff2a9` |

## 问题处置

1. 根 `package.json` 的 OpenAI-compatible patch key 在 merge 后重复：删除重复项。
2. `bun.lock` 保留同一重复 key，frozen install 发出 warning：同步删除并再次验证无 warning/no changes。
3. CLI 子代理错误测试仍断言旧文案：改为验证安全 envelope、`task_id`、错误类型与消息。
4. processor tests 按 2s/4s 基础 backoff 推进虚拟时钟，未覆盖上游新增 jitter：改用生产 delay helper 的最大 jitter 参数。
5. Task terminal tool error 的 `findLast` type predicate 未缩窄嵌套 state union：在使用点做 discriminant check。
6. 新增 Groq/xAI patch 的空 context 行触发 staged whitespace 检查；直接删除末尾 context 行曾被 apply parser 正确拒绝，最终通过调整 hunk 行数并重新 frozen install 完成修复。

## 经验教训

1. 大规模上游 merge 的冲突数量不是主要风险，双方隐含契约的交叉才是；核心文件必须先列行为不变量，再选择组合方式。
2. 带 jitter 的 retry 测试不能按基础 backoff 硬编码 TestClock 推进量，应调用生产 delay helper 并选择上界参数。
3. `patchedDependencies` 同时存在于 manifest 与 lockfile；只修其中一个仍会留下重复 warning 或环境漂移。
4. 版本化 patch 文件中的空 context 行属于 patch 语法，清理 whitespace 时必须同步 hunk 计数，并用 apply check 与 frozen install 双验证。
5. 安全错误 envelope 的测试应断言结构、可恢复 ID 与语义字段，避免绑定易变化的展示前缀。
6. 对 rollover chronology，时间戳是排序契约，ID 只能作为 tie-break 或 legacy fallback。

上述第 2–4 条已同步回写本地项目 `CLAUDE.md` 的“已知限制与注意事项”；该文件受本地 exclude 规则管理，不强制加入公开 merge commit。

## 度量

> 行数来自 merge commit 前 `git diff --cached --stat/--numstat`。本次是 433 个上游提交的大规模同步，统计包含上游全部代码、测试、文档与资产；“修改代码行数”按 additions/deletions 的较小值粗估替换规模。

| 指标 | 数值 |
|------|------|
| 新增代码行数 | 101,191 行 insertion（含新增文件与替换后的新行） |
| 修改代码行数 | 约 12,002 行替换（按 `min(+,-)` 粗估） |
| 删除代码行数 | 12,002 行 deletion（含被替换的旧行） |
| 涉及文件数 | 882 个 tracked 文件（279 A / 9 D / 592 M / 2 R；另本地更新 excluded `CLAUDE.md`） |
| 新增测试用例数 | 至少 21 个本地/上游关键冲突回归场景被独立保留或补充；上游整体新增测试未逐项枚举 |
| 测试通过率 | 定向测试 426/426，通过率 100%；另 2 skip；三个 workspace typecheck 全过 |
| 发现 bug 数 | 6 个合并适配问题 |
| 修复 bug 数 | 6 个 |
| 迭代轮次 | 冲突分析 4 组 / 合并解析 5 步 / 测试修复 2 轮 / patch 最终校验 2 轮 |
