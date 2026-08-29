# 开发日志：incomplete stream stable classification

> 日期：2026-08-20
> Issue：#7
> 实施单元：shared classification + AI SDK canonical mapping

## 做了什么

- 将 shared `ProviderFailureClassification` 从仅支持 `context-overflow` 扩充为同时支持 `incomplete-stream`。
- AI SDK adapter 在 canonical missing raw finish 的既有 `provider-error` 上附加 `classification: "incomplete-stream"`。
- 保留既有 detailed message、`retryable: false`、event ordering 和 terminal suppression/reset 行为。
- 增加 shared schema decode regression，并强化现有 AI SDK adapter regression。
- 回填 Issue #7 修正方案中的本步骤状态和验证结果。

## 为什么

Legacy processor 后续需要稳定的内部分类来区分“已确认的 canonical incomplete”与普通 provider/local exception。分类必须在最接近协议事实的 adapter 层生成，同时不能把 public `UnknownError` 改为 retryable，也不能依赖错误文案匹配。

## 关键决策

- `incomplete-stream` 与 `context-overflow` 共用既有 `ProviderFailureClassification`，不增加新的 public error 类型。
- 只标记 `finishReason === "other" && rawFinishReason === undefined` 的既有 canonical 分支。
- 不修改 V2、processor、retry、Prompt、OpenAPI 或 generated SDK。
- 本步骤不实现任何 replay；recovery 由后续 processor 单元完成。

## 验证

首次执行时 workspace 尚未安装依赖，测试/typecheck 因缺少 `effect`、`@opentui/solid/preload` 和 `tsgo` 无法启动。随后使用现有 lockfile 执行：

```bash
bun install --frozen-lockfile --ignore-scripts
```

`bun.lock` 无变更。最终结果：

| 验证项 | 结果 |
|---|---|
| `packages/llm/test/schema.test.ts` | 9 pass / 0 fail / 23 assertions |
| `packages/opencode/test/session/llm.test.ts` | 54 pass / 0 fail / 174 assertions |
| `packages/llm` typecheck | 通过 |
| `packages/opencode` typecheck | 通过 |
| `git diff --check` | 通过 |

## 五维审核

1. **一致性**：实现只扩充 shared classification，并在既有 canonical missing-finish 分支附值，与修正方案完全一致。
2. **风格**：使用仓库已有的 `Schema.Literals([...])` 与 `LLMEvent.providerError(...)` 写法，无新抽象或依赖。
3. **正确性**：shared schema 接受 `incomplete-stream`、拒绝未知值；adapter 两个相关回归均断言 classification、detail 与 `retryable: false`。
4. **性能**：只增加一个静态 literal 和一个事件字段赋值，不改变算法复杂度、分配规模或 stream demand。
5. **可维护性**：classification 在 shared schema 单点定义，adapter 不使用 message matching；processor/retry 后续可直接按结构化字段消费。

审核结论：本步骤未发现 unresolved finding。

## 经验教训

无新增项目级限制。本步骤验证了既有设计中的做法：协议事实应在 adapter 边界形成稳定 classification，下游不应通过文案猜测。该原则已写入 Issue #7 修正方案，无需额外修改 `CLAUDE.md`。

## 度量

| 指标 | 数值 |
|------|------|
| 新增代码行数 | 约 22 行（production 2 + tests 20） |
| 修改代码行数 | 约 2 行 |
| 删除代码行数 | 约 2 行 |
| 涉及文件数 | 6 个（含修正方案与本日志） |
| 新增测试用例数 | 1 个；另强化 1 个既有 adapter 用例 |
| 测试通过率 | 63/63（100%） |
| 发现 bug 数 | 0 个新增 bug |
| 修复 bug 数 | 1 个（canonical incomplete 缺少 stable classification） |
| 迭代轮次 | 设计 1 / 实现 1 / 修复 0 |
