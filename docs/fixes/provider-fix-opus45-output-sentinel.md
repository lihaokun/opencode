# 修正方案 — `provider: Opus 4.5 output sentinel`

## 一、现象与复现

- 现象：Anthropic Claude Opus 4.5 的 effort variant 在模型目录把
  `limit.output = 0` 用作“未声明输出上限”哨兵时，生成
  `budgetTokens = -1`，请求在本地 reasoning budget normalization 阶段失败。
- 触发条件：
  - `model.capabilities.reasoning = true`；
  - `model.limit.output = 0`；
  - transport 是 `@ai-sdk/anthropic`、`@ai-sdk/google-vertex/anthropic`
    或 `@ai-sdk/amazon-bedrock`；
  - API model id 匹配 Claude Opus 4.5，并选择 numeric thinking effort。
- 影响范围与频次：满足条件后必现；失败发生在 plugin `chat.params` 和 provider
  网络请求之前。
- 最小复现用例：

  ```ts
  const target = {
    id: "claude-opus-4-5",
    providerID: "anthropic",
    api: {
      id: "claude-opus-4-5",
      npm: "@ai-sdk/anthropic",
      url: "https://api.anthropic.com",
    },
    capabilities: { reasoning: true },
    limit: { output: 0 },
  } as Provider.Model

  const variants = ProviderTransform.reasoningVariants(
    { reasoning_options: [{ type: "effort", values: ["high"] }] } as ModelsDev.Model,
    target,
  )
  // 修复前：variants.high.thinking.budgetTokens === -1
  ```

- 出错代码路径（文件、行号、调用链）：
  - `src/provider/provider.ts`：缺省 catalog output limit 记为 `0`；
  - `src/provider/transform.ts`：
    `reasoningVariants()` → `effortVariants()` → `reasoningEffort()` /
    `anthropicOpus45Effort()` 直接使用 `model.limit.output`；
  - `src/session/llm/request.ts`：`maxOutputTokens()` 正确得到核心 envelope
    `E = 32_000`，随后 `normalizeReasoningBudget()` 拒绝 `budgetTokens = -1`。
- 预期行为：catalog sentinel 使用 `OUTPUT_TOKEN_MAX = 32_000` 解释；Opus 4.5
  high budget 为 `15_999`，transport max output 为 `16_001`，两者之和为
  `32_000`。
- 实际行为：两个 Opus 4.5 effort 分支把 sentinel 当成真实上限，计算
  `min(16_000, floor(0 / 2 - 1)) = -1`。

## 二、根因分析

- 直接症状：目录 variant 含非正整数 numeric thinking budget。
- 根因：fork 已在通用 `variants()`、`budgetVariants()` 和请求期
  `maxOutputTokens()` 中建立 `limit.output = 0` 的 fallback 语义；上游新增的
  Opus 4.5 direct/Vertex 和 Bedrock effort 路径在不相邻代码中重新实现预算公式，
  绕过了该语义。Git 能合并不相邻文本，但不能发现这项跨路径不变量被破坏。
- 证据：同一模型输入在通用 catalog 路径得到正预算，在两个 Opus 4.5 effort
  路径得到 `-1`；normalizer 的错误信息明确指出 budget 必须为正整数。
- 是否存在 workaround：用户显式填写正的 output limit 可以绕过，但不能修复新模型、
  自定义模型和目录缺省值；不作为修复方案。
- 同类风险点：任何 catalog-time numeric budget 公式若直接读取
  `model.limit.output`，都可能再次误解 `0` 哨兵。

## 三、参考实现对照（算法类 bug 必填）

| 步骤 | 输入 / 状态        | 当前 Opus 4.5 effort 实现 | 参考实现                            | 首个差异              |
| ---- | ------------------ | ------------------------- | ----------------------------------- | --------------------- |
| 1    | `limit.output = 0` | 保留 `0`                  | 通用 catalog fallback 转为 `32_000` | 是                    |
| 2    | 计算 high budget   | `floor(0 / 2 - 1) = -1`   | `floor(32_000 / 2 - 1) = 15_999`    | 是                    |
| 3    | normalization      | 拒绝非正整数              | 保留合法的 `15_999`                 | 否，差异由步骤 1 传递 |
| 4    | transport adapter  | 不可到达                  | `32_000 - 15_999 = 16_001`          | 否，差异由步骤 1 传递 |

参考实现来源：同文件 `maxOutputTokens()`、通用 `variants()` 和
`budgetVariants()` 已实现的 `output > 0 ? output : OUTPUT_TOKEN_MAX` 语义，以及
`docs/fixes/subagent-fix-output-length.md` 的 I17/I18。

## 四、修复方案

- 修改位置（函数、行号）：`src/provider/transform.ts` 的 catalog output
  解释、`variants()`、`budgetVariants()`、`reasoningEffort()` 和
  `anthropicOpus45Effort()`。
- 具体改动：
  1. 新增内部纯函数 `catalogOutputLimit(model)`，集中解释 `0` 哨兵；
  2. 新增内部纯函数 `anthropicOpus45Budget(model)`，集中 Opus 4.5 的
     `min(16_000, floor(output / 2 - 1))` 公式；
  3. 通用 catalog 路径调用 `catalogOutputLimit()`；
  4. direct/Vertex 与 Bedrock Opus 4.5 effort 路径调用
     `anthropicOpus45Budget()`。
- 根因如何被消除：所有 catalog-time output limit 解释共享单一入口，新增 transport
  不再各自决定 `0` 的含义；两个 Opus 4.5 transport 形状共享同一预算算法。
- 参考实现如何处理：保持既有 `OUTPUT_TOKEN_MAX` fallback 和请求期核心 envelope
  算法，不修改 normalizer、plugin 顺序或 provider 默认 schema。
- 用最小复现走一遍修正后逻辑：
  `0 → 32_000 → budget 15_999 → normalize 15_999 → transport 16_001`。

函数规约：

```text
函数：catalogOutputLimit(model)
Requires:
  - model.limit.output ≥ 0
Ensures:
  - result > 0
  - model.limit.output > 0 ⇒ result = model.limit.output
  - model.limit.output = 0 ⇒ result = OUTPUT_TOKEN_MAX
副作用：无

函数：anthropicOpus45Budget(model)
Requires:
  - catalogOutputLimit(model) > 2
Ensures:
  - result = min(16_000, floor(catalogOutputLimit(model) / 2 - 1))
  - 0 < result < catalogOutputLimit(model)
副作用：无
```

## 五、正确性论证

- 根因消除：修复点位于错误值首次产生处，normalizer 继续拒绝非法输入，不通过钳制或
  吞错掩盖问题。
- 不变量保持：
  - `limit.output = 0` 时，catalog 与请求期都使用 `32_000`；
  - `B = 15_999`、`E = 32_000`、`S = 16_001`，因此
    `0 < B < E` 且 `S + B = E`；
  - `limit.output = 64_000` 时仍有 `B = 16_000`，既有行为不变；
  - effort 名称、provider option 形状、plugin 最终覆盖顺序均不变。
- 无回归引入：用 `output = 0` 覆盖 direct Anthropic、Vertex Anthropic、Bedrock
  和 models.dev/heuristic 两类目录入口；保留现有 `output = 64_000` 用例，并运行完整
  provider transform suite 与 package typecheck。
- Trivial 判定（如适用）：不适用；这是跨 catalog/request/transport 边界的不变量冲突。

## 六、测试用例清单

| 类型 | 用例描述                                                                                             | 状态（修复后回填）                                  |
| ---- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 回归 | models.dev effort：Anthropic、Vertex、Bedrock Opus 4.5 + `output = 0` 生成正预算，并保持 `S + B = E` | 已加；修复前 3 项均以实际 `-1` 精确失败，修复后通过 |
| 回归 | heuristic variants：Anthropic、Vertex Opus 4.5 + `output = 0` 生成 `15_999`                          | 已加；修复前 2 项均以实际 `-1` 精确失败，修复后通过 |
| 既有 | Opus 4.5 + `output = 64_000` 仍生成 `16_000`                                                         | 已通过                                              |
| 既有 | provider transform 完整测试                                                                          | 已通过：`409 pass, 0 fail`                          |

修复前红灯命令：

```sh
bun test test/provider/transform.test.ts --test-name-pattern "catalog output fallback"
```

结果：`0 pass, 5 fail, 404 filtered out`。五项均在首个 budget 断言处显示
`expected 15_999, received -1`；没有 fixture、导入、类型或超时失败。

修复后验证：

- 同一组回归：`5 pass, 0 fail, 17 assertions`；
- `test/provider/transform.test.ts`：`409 pass, 0 fail, 746 assertions`；
- `test/provider/provider.test.ts`：`101 pass, 0 fail, 255 assertions`；
- `test/session/llm.test.ts` 的 request reasoning envelope：`6 pass, 0 fail`；
- 同文件真实 Anthropic wire envelope：`1 pass, 0 fail`；
- `packages/opencode` 的 `bun typecheck`（`tsgo --noEmit`）通过；
- 三个改动文件通过 Prettier，`git diff --check` 通过。

## 七、代码更新清单

| 文件                                                | 函数 / 行号                        | 改动概述                                     | 状态（修复后回填） |
| --------------------------------------------------- | ---------------------------------- | -------------------------------------------- | ------------------ |
| `packages/opencode/src/provider/transform.ts`       | catalog helpers / variant builders | 统一 output sentinel 和 Opus 4.5 budget 算法 | 已改并通过；本提交 |
| `packages/opencode/test/provider/transform.test.ts` | reasoning/heuristic variant tests  | 固化三种 transport 与两类目录入口的回归      | 已改并通过；本提交 |

## 八、文档更新清单

| 文档路径                                            | 要改什么                 | 状态（修复后回填） |
| --------------------------------------------------- | ------------------------ | ------------------ |
| `docs/fixes/provider-fix-opus45-output-sentinel.md` | 回填红灯、实现和验证结果 | 已回填；本提交     |

既有契约文档无需修改：`docs/fixes/subagent-fix-output-length.md` 的 I17/I18 已准确规定
sentinel fallback 与 transport envelope；本次是让合并后的实现重新满足既有契约，不改变
输入输出、schema、错误码或不变量。

五维审核：

1. **一致性**：heuristic、models.dev、direct Anthropic、Vertex Anthropic 和 Bedrock
   共享相同的 output sentinel 与 Opus 4.5 budget 解释。
2. **风格**：两个内部纯函数命名对应真实概念，没有导出新 API、增加依赖或改动无关分支。
3. **正确性**：红灯证明修复前五条路径都产生 `-1`；绿灯同时验证
   `B = 15_999`、`S = 16_001`、`S + B = E = 32_000`。
4. **性能**：仅增加常数时间数值计算和函数调用，不增加 I/O、网络请求、持久化或遍历。
5. **可维护性**：只读扫描确认 catalog-time 的 raw output 解释已集中；请求期
   `maxOutputTokens()` 保持独立，以免 catalog policy 与 runtime override policy 耦合。
