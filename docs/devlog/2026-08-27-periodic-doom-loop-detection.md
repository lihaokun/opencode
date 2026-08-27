# 开发日志 — 周期性 doom-loop 检测

- 日期：2026-08-27
- Issue：[#20 Periodic tool-call cycles bypass doom-loop detection](https://github.com/lihaokun/opencode/issues/20)
- 分支：`fix/issue-20-periodic-doom-loop`
- 修正方案：`docs/fixes/session-processor-fix-periodic-doom-loop.md`

## 背景

原有 `doom_loop` guard 只比较最后三次工具调用是否完全相同，因此只能识别周期 1 的 `A A A`。当 provider 在同一活动 stream 中持续输出 `A B A B A B` 或更长的稳定周期时，processor 不会请求 `doom_loop` permission，并会继续消费工具调用。

Issue 同时要求 detector state 留在 active processor 内，避免每次工具调用都读取当前 assistant message 的完整 persisted parts。

## 完成内容

1. 新增 `packages/opencode/src/session/doom-loop.ts`：
   - 最大候选周期为 10；
   - 固定容量 ring 为 `2 * MAX_PERIOD + 1 = 21`；
   - 每个周期维护连续 triple-equality streak；
   - 第三个完整重复 block 的最后一个调用触发检测；
   - 保持 `JSON.stringify([tool, input])` 的既有输入等价语义。
2. 在 `SessionProcessor` 中创建 processor-local detector：
   - 删除每次调用的 `MessageV2.parts()` 查询；
   - 删除 detector 不再需要的 `Database.Service` 依赖；
   - permission payload 和 allow/deny/ask 行为保持不变；
   - 同一 active call ID 在 result/error 前的重复 normalized `tool-call` 事件只计入 detector 一次；不保留 processor-lifetime 无界 ID history。
3. 增加独立算法验证：
   - period 1、period 10、两轮不触发、输入变化重置、非周期序列、基本周期、key 顺序语义和 ring wrap；
   - 使用直接比较三个 suffix blocks 的 brute-force oracle 穷举交叉验证，不复用生产 streak 算法。
4. 增加 Processor 集成回归：
   - period 2 真实 normalized stream 红测与修复后通过；
   - period 1 兼容；
   - `doom_loop` ask/allow/deny；
   - 唯一 call ID 不影响周期识别；
   - 重复投递同一 call ID 不产生误报；
   - persisted tool history 不初始化新 processor 的 detector。
5. 同步英文与 17 个 localized `permissions.mdx`，明确周期 1–10 的相同调用序列重复三轮会触发，并说明连续三次相同调用是周期 1。

## 关键决策

- **保持 permission 作为响应**：不改为无条件 abort，以兼容 intentional polling 和现有 permission recovery。
- **保持精确序列化语义**：本次不排序 object keys，也不改用可能碰撞的 digest；输入等价仍由 `JSON.stringify` 字节结果决定。
- **状态边界选择 active processor**：不从 persisted history 恢复，也不跨 assistant message 共享；同一 processor 内的 retry 保留状态。
- **不引入总调用预算**：非周期或刻意扰动的无限序列由后续独立设计处理，避免混入阈值、配置和终态等新契约。
- **重复投递边界**：call ID 不属于周期签名；active call map 只抑制 settlement 前的重复 delivery。settlement 后重放完整 lifecycle 是既有 provider/processor 幂等问题，需要单独设计有界状态或持久化索引。

## 验证结果

| 验证项                                  | 结果                                                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `test/session/doom-loop.test.ts`        | 9/9 通过，18,444 次断言                                                                           |
| `test/session/processor-effect.test.ts` | 47/47 通过，295 次断言                                                                            |
| `test/permission/next.test.ts`          | 79/79 通过，118 次断言                                                                            |
| `packages/opencode` typecheck           | 通过                                                                                              |
| `packages/web` Astro build              | 通过；仅输出既有 theme override warnings                                                          |
| `packages/opencode` 全量测试            | 3383 pass、22 skip、1 todo、7 fail、2 errors；失败位于 MCP/HttpApi 等未改模块，因此未宣称全量通过 |
| pre-push workspace Turbo typecheck      | 每个已推送步骤均通过，30/30 tasks                                                                 |

## 审核与问题处置

早期高强度代码审核发现并处理了以下有效问题：

- 测试 helper 重复硬编码最大周期：改为默认调用生产 `DoomLoop.create()`，period-10 fixture 使用 `DoomLoop.MAX_PERIOD`；
- 缺少 ring wrap 覆盖：增加 noisy prefix 后的最大周期测试；
- 同一 call ID 在 result 前重放会被重复计数：增加 active-call 首次 delivery gate 与 Processor 回归；
- 最终复审发现 settlement 后同一 ID 的完整 lifecycle replay 会创建第二个 part。commit `14e2cfa2a` 曾尝试用 processor-lifetime seen-ID set 处理，但进一步审核确认该 set 会随非周期唯一调用和 retry 无界增长，并且无法阻止先到达的 replayed `tool-input-start` 创建 pending part；
- 因此最终修正 `d67297528` 废弃无界 set，恢复固定容量 detector + active-call gate。settlement 后完整 lifecycle replay 记录为独立 follow-up，需要先确定 provider delivery contract、持久化 call-ID 索引和有界策略；
- 修正方案状态和公共 permission 文档滞后：分别在实现与文档步骤同步。

以下项目经对照 Issue 契约后保留为明确边界，而非混入本修复：provider-executed side effect 回滚、stream-level 总调用预算、稳定 key canonicalization、settlement 后完整 tool lifecycle replay，以及对整个多工具 cycle 的一次性 permission approval。

最终高强度复审未发现其它 detector 算法或 `doom_loop` permission lifecycle 缺陷；无界 seen-ID 方案已撤销。

## 经验教训

1. 连续相等 guard 只覆盖基本周期 1；“重复行为”必须先明确是连续重复、周期重复还是总量失控。
2. stream guard 的状态边界应跟随 active processor，而不是依赖 persisted message 布局；否则性能和语义都会被非工具 part 偶然影响。
3. “call ID 不进入语义签名”不等于可以忽略 active event 投递幂等；逻辑调用身份与调用内容等价是两个不同维度，但跨 settlement 去重不能靠无界内存补丁。
4. 优化算法应配独立 oracle。直接 suffix-block 比较与 streak 实现采用不同状态模型，可以降低自证偏差。
5. 行为契约变更必须同步所有 localized 文档，不能只修英文入口。

上述前三条已同步回写本地项目 `CLAUDE.md` 的“已知限制与注意事项”。该文件受 `.git/info/exclude` 排除，未强制加入公开分支；经验同时保留在本日志中。

## 度量

> 按 `git diff --stat origin/dev...HEAD` 加本日志估算；代码行统计包含测试和文档，修改行数按替换项估算。

| 指标           | 数值                                                              |
| -------------- | ----------------------------------------------------------------- |
| 新增代码行数   | 约 1,400 行                                                       |
| 修改代码行数   | 约 35 行                                                          |
| 删除代码行数   | 约 40 行                                                          |
| 涉及文件数     | 24 个 tracked 文件（另本地更新被 exclude 的 `CLAUDE.md`）         |
| 新增测试用例数 | 14                                                                |
| 测试通过率     | 定向 135/135；全量 3383/3392（另 22 skip、1 todo）                |
| 发现 bug 数    | 3（周期绕过、active replay 误报、settlement 后 lifecycle replay） |
| 修复 bug 数    | 2（Issue #20 范围；settlement 后 replay 留作独立 follow-up）      |
| 迭代轮次       | 设计 1 轮 / 实现 4 轮 / 修复 3 轮 / 审核 4 轮                     |
