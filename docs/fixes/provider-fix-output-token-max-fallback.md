# 修正方案 — 未配置输出额度时移除静默 32k 客户端上限

- 状态：方案待确认；未实施
- 初稿日期：2026-11-02
- 对应问题：[#98](https://github.com/lihaokun/opencode/issues/98)（自定义 provider 无元数据时静默施加 32k 上限）
- 前序修复：`docs/fixes/subagent-fix-output-length.md`（Issue #1/#2：reasoning 模型使用声明额度 + length 终态如实上报）
- 影响模块：`packages/opencode` provider transform、LLM request prep、session overflow；测试 `test/provider`、`test/session`
- workflow 路径：`docs/workflow.md` §7 bug-fix flow + §7.1 八部分修正方案

---

## 第一部分：现象与复现

### 1.1 现象

用户以**自定义 provider + 仅填模型名**（无 `limit`/`reasoning` 元数据）运行长任务时，
assistant 消息的 `reasoning + output` 恒等于 **32,000**，`finish = length`，
`MessageOutputLengthError` 正确上报但任务被反复截断重派，无法推进。
同一模型在内置 provider 目录下（`zhipuai-coding-plan`）正常继承
`output = 131072`。

生产实证（2026-11-02，本机只读检查，全部在本用户环境完成）：

- **对照组**：本机 `~/.config/opencode/opencode.jsonc` 只覆写 `zhipuai-coding-plan` 的
  baseURL，无额度配置；本地 `opencode-dev.db` 中 7,270 条
  `glm-5.3-flash` assistant 消息，3 条 `finish=length` 的 token 总额恰为
  **131072**（如 131068+4）——目录元数据继承路径正常，length 终态如实上报。
- **触发组（RED，wire 级）**：用仓库 dev 源码（`transform.ts` 与 issue 引用的
  beta.17 逐字相同；`~/.opencode/bin` 旧分支二进制亦比对一致）+ 复刻 issue 的
  provider 形状（`models: { "glm-5.3-flash": { "name": "GLM-5.3-Flash" } }`，
  无 limit），对本地 mock `/v1/chat/completions` 抓 wire 请求：

  ```text
  WIRE: {"path":"/v1/chat/completions","has_max_tokens":true,"max_tokens":32000,"model":"glm-5.3-flash"}
  ```

- **第二处缺陷同框确认**：helper 矩阵直接调用显示已知 131072 额度的**非
  reasoning** 模型同样返回 32000（`min(131072, 32_000)`）。
- **逃生通道确认**：显式 `outputTokenMax = 64000` 时返回 64000，用户显式
  覆盖路径正常。

影响范围：

- 影响所有"配置层未声明 `limit.output`"的自定义 provider 模型，以及所有已声明
  额度但 `capabilities.reasoning = false` 的模型；
- 不影响：reasoning 且已知额度的模型（前序修复已覆盖）、用户显式
  `OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX` 覆盖、`finish=length →
  MessageOutputLengthError` 终态链路；
- 频次：配置形状触发即必现。

### 1.2 最小复现

```bash
# mock：记录 wire 请求 max_tokens 的 OpenAI 兼容端点（127.0.0.1:4599）
# 项目 opencode.json：provider.zhipu.models 仅含 { "glm-5.3-flash": { "name": ... } }
bun packages/opencode/src/index.ts run --model zhipu/glm-5.3-flash "say ok"
# 期望（修复后）：wire body 不含 max_tokens 键
# 实际（修复前）：max_tokens: 32000
```

helper 级复现（`packages/opencode`）：

```ts
ProviderTransform.maxOutputTokens(model({ output: 0 }, /*reasoning*/ true))
// 现状 32000；期望 undefined
ProviderTransform.maxOutputTokens(model({ output: 131_072 }, false))
// 现状 32000；期望 131_072
```

### 1.3 出错代码路径与预期/实际行为

- `packages/opencode/src/provider/transform.ts:1507-1512`
  `maxOutputTokens`：`limit.output === 0 → OUTPUT_TOKEN_MAX`（32k）；
  非推理 → `min(limit.output, OUTPUT_TOKEN_MAX)`。
- 调用链：`session/llm/request.ts:97` → `normalizeReasoningBudget`（要求正整数）
  → `transportMaxOutputTokens` → AI SDK `streamText({maxOutputTokens})`
  / native `generation.maxTokens` → wire `max_tokens`/`max_output_tokens`。
- 关联：`session/overflow.ts:16-19` 用同一函数推导压缩保留区，未知额度时被
  `min(20k, 32k)` 缠上同一个伪造数值。
- 预期：无配置 ⇒ 不注入客户端限制（不发送该参数），服务端默认生效；
  实际：静默注入 32000。

---

## 第二部分：根因分析

**根因**：`OUTPUT_TOKEN_MAX = 32_000` 是 models.dev 目录覆盖不全时代的历史
fallback，在前序修复（Issue #1/#2）只放开 reasoning 路径后，仍剩两条静默注入
路径：

1. `limit.output === 0`（配置未知）→ 直接 fallback 32k；
2. `limit.output > 0` 但 `capabilities.reasoning = false` → 32k 夹逼。

**症状 vs 根因**：模型名/provider 别名对不上目录导致元数据缺失是**诱因**
（issue 已记录 `zhipu` 不在 models.dev、合并逻辑只在同 provider 内继承），
但即使元数据补全，路径 2 依旧存在——把诱因当根因修（比如给 `zhipu` 加目录
条目）治不了路径 2，也不解决任何未知 provider。**根因是"客户端把'未知'
编码成一个具体数值"**：配置层 `output: 0` 的语义是"未知"，transform 层却把它
具体化为 32000 并写进 wire 请求，伪装成已知能力。

前序修复的关系：`subagent-fix-output-length.md` 修的是"截断被误报成功"和
"reasoning 模型额度被砍"；本修复处理同一函数里剩下的两条 fallback 路径，
属其明确记录的遗留面（该文档第四部分新规则保留 `output=0 → fallback` 分支
并注明"历史遗留"）。

---

## 第三部分：参考实现对照

算法类对照按规则需对照参考实现；本修复属接口契约语义修正，对照两处外部
行为契约：

1. **AI SDK 契约**（`@ai-sdk/anthropic@3.0.111`）：`maxOutputTokens == null`
   时已知模型用声明额度、未知模型回落 **4096 并发 compatibility warning**
   （`dist/index.js:3488-3498`："Set maxOutputTokens explicitly to override
   this limit"）。即上游 SDK 自己的语义就是"不传 ⇒ 由适配器按已知能力/保守
   默认处理，并**显式告知**"，而不是客户端硬编码一个伪装已知的 32k。
   `@ai-sdk/openai-compatible@2.0.54` 对 undefined 直接经
   `JSON.stringify` 丢键，wire 不含 `max_tokens`。
2. **fork 自身先例**：`plugin/github-copilot/copilot.ts:343-345`、
   `plugin/codex.ts:572`、`plugin/cerebras.ts:8` 已在特定模型上
   `output.maxOutputTokens = undefined`（注释 "omit maxOutputTokens for gpt
   models"）——undefined 通道是既有受支持的形态，本修复把该能力从插件特例
   提升为核心默认策略。
3. **服务端默认实测**（2026-11-04，本机网关 `zhipuai-coding-plan` → new-api
   → `glm-5.3-flash`，只读探针）：省略 `max_tokens` 请求无限重复生成任务，
   流式 570 秒持续输出 72,757 字符（约 4.5–6 万 token）仍无 `finish_reason`
   ——被探针主动掐断，非服务端终止。结论：该 provider 省略时**没有小的
   服务端默认**（不是 4k/8k 量级）。同时确认：(a) 不发送 ≠ 无限生成，真
   上限未探出，方案不做假设（4.3）；(b) 省略后失控成本（do-loop 烧 token）
   是真实风险面，靠 `omitted-server-default` 日志暴露而非静默保险丝（4.6）；
   (c) 事故的 17 轮 32,000 恰好截断说明当时请求带了 32k 且服务端尊重它——
   若当初不发送，按本实测该任务大概率能跑完。

差异点即根因确认：opencode 在 SDK 之前就把 32k 写进 `maxOutputTokens`，
SDK 的"unknown ⇒ 显式警告 + 保守默认"机制被短路。

---

## 第四部分：修复方案

### 4.1 新语义：`maxOutputTokens(model, outputTokenMax?) → number | undefined`

`undefined` 语义 = "无已知客户端上限，不发送参数，服务端默认生效"。
**不引入任何替代常数。**

```text
函数：maxOutputTokens(model, outputTokenMax?) -> number | undefined

Requires:
  - model.limit.output ≥ 0
  - outputTokenMax 若存在则为正整数（RuntimeFlags positiveInteger 已校验）

Ensures:
  - outputTokenMax 存在时：返回正数且 ≤ outputTokenMax；
    其中 limit.output > 0 时返回 min(limit.output, outputTokenMax)；
    limit.output = 0 时返回 outputTokenMax（显式覆盖对未知额度同样生效——
    这是既有逃生通道，回归测试 L6221 "override 48000 → 48000" 锚定，不得
    因 undefined 语义被切断）
  - outputTokenMax 不存在时：
      limit.output > 0 → 恰返回 limit.output（不再按 reasoning 分叉）
      limit.output = 0 → 返回 undefined
  - 返回值非 undefined 时 ≤ limit.output（已知额度是服务能力边界，永远不
    被客户端放大）；undefined 不是数值，不受此界约束，也不得被下游当作 0
    或任何数值解释
```

### 4.2 各下游点

| # | 位置 | 改动 |
|---|---|---|
| 1 | `transform.ts:1507` `maxOutputTokens` | 返回类型 `number \| undefined`，按 4.1 规约重写 |
| 2 | `request.ts:97-112` | `coreMaxOutputTokens` 可为 undefined：`normalizeReasoningBudget` 在 envelope 为 undefined 时跳过预算夹逼（无已知上限，不推理预算合法性，不 fail）；`transportMaxOutputTokens` envelope 为 undefined 时直接返回 undefined（预算相减无意义） |
| 3 | AI SDK 路径 `llm.ts:328` | `streamText({ maxOutputTokens: undefined })` 已有类型通道（`CallSettings.maxOutputTokens?`），SDK 丢键不发送；codex/cerebras/copilot 插件已用同一形态，无改动 |
| 4 | native 路径 | `native-request.ts` generation 构造已有 undefined 剔除；协议层 `openai-chat/openai-responses/gemini` 均 `generation?.maxTokens` 透传省略（Bedrock `inferenceConfig` 在全 undefined 时整体省略，Gemini/OpenAI JSON 丢键）。**例外：Anthropic Messages 协议必填，且有两处独立处理**：(a) AI-SDK 路径——SDK 对未知模型回落 4096 + compatibility warning，若有 numeric thinking budget 则 wire = 4096 + budget（适配器声明组合，非静默）；(b) native 路径——`anthropic-messages.ts:510` 的 `?? 4096` 兜底**在 `defaults.limits.output = 0` 时不生效**（`??` 不跳过 0，而 `native-request.ts:162` 无条件传 `output: model.limit.output`），直接省略 envelope 会发出 `max_tokens: 0`。因此该行需加 0 值守卫（`0 → 4096`，与 ai-sdk 侧回落对齐并告警）。实施时两者都必须有 wire 断言，不能只测 ai-sdk 侧 |
| 5 | `overflow.ts:10-34` | 解耦 `maxOutputTokens`，但**两个分支语义不同，不能统一成一个"保留区"**：(a) `reserved`（L15-16，供 `limit.input` 分支用）：已知额度 `min(COMPACTION_BUFFER, limit.output)`、未知 `COMPACTION_BUFFER`——数值与现状等价（`min(20k, 32k)=20k`）；(b) 无 `limit.input` 分支（L19）：现状是 `context - 完整 output envelope`（如 200k 上下文 / 131k 输出 ⇒ usable=68,928，**不减 20k**）——若按"保留区"公式统一会显著放宽溢出判定（400k-20k=380k vs 现状 272k），在输出计入上下文的 provider 上会把 context overflow 掩成漏检。新逻辑：已知额度保持 `context - limit.output`；未知额度以 `context - COMPACTION_BUFFER` 兜底（预检是本地启发式，有界的本地常数合法；与 wire 注入不同，它不声称来自模型能力）。既有测试 L376-395 三个数值锚定该分支行为，改造后必须逐值相等 |
| 6 | 诊断日志 | `request.ts` prep 完成后 logInfo 一条：`provider/model`、生效值、来源 ∈ {`explicit-flag`, `model-declared`, `omitted-server-default`}；undefined 必须以 `omitted-server-default` 显式出现，不伪装已知。**三桶而非 issue 叙述中的四桶**（目录 vs config 显式声明不区分），决策依据见 4.5。可测性：来源判定抽成纯函数导出（如 `outputTokenMaxSource(model, flags)`），日志只打印其结果——测试断言纯函数而非捕获日志（现有测试 harness 无 log 捕获设施） |
| 7 | `transform.ts:2025` `budgetVariants` / `:2157` `catalogOutputLimit` | **保留 32k**：这是用户主动选 numeric variant 时的预算建议构造，属"用户已选择参与"的场景，且这些预算经显式变体进入请求，非静默限制。文档记录其与 `maxOutputTokens` 语义分叉的理由 |
| 8 | `session/llm.ts:33` re-export | 删除（全仓无 consumer，grep 确认）；`OUTPUT_TOKEN_MAX` 常量保留在 `transform.ts` 供 §4.2-7 使用 |

### 4.3 不修什么（明确排除）

- **模型元数据合并/目录继承**（`zhipu` 不在 models.dev、同名模型跨 provider
  不继承）：issue 描述的诱因，但补目录/放宽继承是独立契约变更，且不解决
  路径 2。用户侧既有逃生通道：显式填 `limit` 或设 `OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX`。
- **`context=0` 跳过压缩预检**：issue 点名为"相关问题"但明确要求分别处理；
  属 #83/#84 压缩恢复范畴。
- **`finish=length → MessageOutputLengthError` 链路**：前序修复已正确，仅回归
  保护，不改。
- **服务端默认值大小**：不发送参数 ≠ 服务端无限生成；不做任何对服务端默认
  的假设，验收只看 wire 与适配器行为。

### 4.4 修改后的预期行为（走 1.2 复现）

- 无 limit + 无 override：wire 请求**不含** `max_tokens`；日志出现
  `omitted-server-default`。
- `limit.output=131072` 非 reasoning：wire `max_tokens: 131072`。
- 无 limit + 显式 override 64000：wire `max_tokens: 64000`（与现状一致）。
- `finish=length` 依旧 `MessageOutputLengthError`。
- native Anthropic + 无 limit：wire `max_tokens: 4096`（协议必填的显式回落，
  守卫见 4.2-4b）。

### 4.5 决策记录：诊断来源三桶而非四桶

Issue 期望行为列了四个诊断来源："用户覆盖、目录、provider metadata、服务端
默认"。本修复落地为三桶：`explicit-flag`（用户显式
`OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX`）、`model-declared`（目录与 config
声明的额度，合并后不再区分）、`omitted-server-default`（未知，省略参数）。

**不区分目录与 config 显式声明的原因**：

1. **信息在合并点已丢失**：`provider.ts:1599-1602` 把 config 声明的 limit 与
   目录已有 limit 合并进同一个 `model.limit.output` 字段，请求时无从回溯。
   要区分需给 `Provider.Model`（`provider.ts:1096`，被 15 个文件引用的共享
   类型）加 provenance 字段，并在 4 个 Model 构造/合并点（`:704`、`:1320`、
   `:1512`、`:1599`）逐一写标记，另需覆盖 plugin 覆盖目录这条 issue 未列的
   第五种来源的归属决策。
2. **代价超出诉求**：共享类型加字段经 `toPublicInfo`（`provider.ts:1157`，
   JSON 全量透传）改变对外 API 的 model 形状；provider 加载测试需补
   provenance 断言，合并矩阵至少 6-8 个新用例。而 issue 的**验收标准**只
   要求"已知能力、用户显式上限和 provider 必填参数分别有回归覆盖"——
   四分桶出现在期望行为的叙述中，未进入验收。硬性义务是"不能把未知伪装成
   已知能力"，三桶完全满足：undefined 只可能来自真实的无声明，任何已声明
   额度都以具体数值 + `model-declared` 出现。
3. **seam 纪律**：为"未来可能想区分"预留 provenance 通道而没有第二个消费
   者，属于应整体砍掉的预留 seam。恢复条件（出现以下任一再做，按独立子计划
   走）：(a) 出现需要区分"目录声明"与"用户 config 声明"的第二个消费者
   （如诊断 UI 按来源分层显示、按来源加权的额度校验）；(b) plugin 来源
   （`provider.ts:1503` models 回调）需要独立归属。届时的可复用件：本修复
   的日志出口在 `request.ts` 单点，扩展为四桶只改该点与 provider 加载层，
   wire/overflow/测试矩阵不受影响。

### 4.6 决策记录：未知额度一律省略，不为 reasoning 保留大常数

实施前讨论过的保守变体——未知额度 + reasoning 模型时保留一个大常数（如
128k）而非省略——被否决：issue 第一条明确要求"不以另一个任意常数替代"，
任何常数都复刻同一根因（把未知编码为具体数值），只是换了数值。成本风险
（模型 do-loop 时输出无界直到服务端上限）由 `omitted-server-default` 日志
暴露，不靠静默保险丝；实测证据见第三部分。

---

## 第五部分：正确性论证

**根因消除**：两条静默注入路径在 `maxOutputTokens` 内被整体移除——未知编码
为 `undefined` 并在传输层保持 undefined（SDK `JSON.stringify` 丢键、native
协议省略字段），"未知"不再可能在 wire 上具体化为任意数值。32k 常量仅存于
variant 预算建议（用户显式参与场景），静默路径为零。

**不变量保持**：

- `返回值非 undefined 时 ≤ limit.output`：新规则已知额度直返，恒成立；override
  路径 `min` 保持；override + 未知额度返回 override（escape hatch，见 4.1
  规约注记）。现状中被 `min(limit.output, 32k)` 满足的该性质由更弱
  （更少截断）的边界替代——上限方向单向放宽，无放大。
- `normalizeReasoningBudget` 契约：envelope undefined ⇒ 无 numeric budget
  path 夹逼义务（其夹逼目的就是"预算装进 envelope"，envelope 不存在时义务
  消失），含 L1696-1703 的 Anthropic 隐式预算 fail 检查（`undefined <= 1024`
  为 false，天然不触发）；envelope 存在时全部现有 fail 分支保留（正整数检查
  等仅对已知 envelope 生效）。用户显式选 numeric variant 时 budget 不再被
  envelope 夹逼——budget 本身是显式选择，非静默注入，与 4.2-7 同一理据。
- `transportMaxOutputTokens`：envelope undefined 时**先于** budget 相减
  early-return，杜绝 `undefined - budget = NaN` 进 wire。副作用组合：AI-SDK
  Anthropic 路径 envelope undefined + options 带 numeric budget ⇒ SDK 计算
  `4096 + budget`（适配器声明行为，见 4.2-4）。
- Anthropic 必填适配器：ai-sdk 侧 SDK 回落（4096 + warning）与 native 侧
  0 值守卫回落（4.2-4b）都是适配器层的**显式**来源，满足"不把未知伪装成
  已知"——伪装发生在客户端静默注入，不发生在适配器声明回落。
- `usable()` 两分支分别论证（详见 4.2-5）：`reserved` 分支已知/未知均数值
  等价（`min(20k, limit.output)` 与 `min(20k, 32k)=20k`）；无 input 分支
  已知额度保持 `context - limit.output` 逐值不变（L376/L394 测试锚定），
  未知额度从 `context - 32k` 变为 `context - 20k`——判定边界**收紧** 12k
  （更早触发压缩预检），方向是保守侧，不会引入漏检；放宽（原方案的统一
  保留区公式）才是危险方向。

**无回归引入**：受影响面 = `maxOutputTokens` 全部调用方（request prep、
overflow）与两个测试组；reasoning 已知额度路径（前序修复的验证面）行为
逐位不变（`limit.output` 直返分支相同）；override 路径相同；插件
`chat.params` 的 `maxOutputTokens: number | undefined` 类型本就容纳
undefined。第六部分回归清单兜底。

---

## 第六部分：测试用例清单

| 类型 | 用例描述 | 状态（修复后回填） |
|------|---------|------------------|
| 回归 | helper 矩阵改造：`transform.test.ts:6196` "keeps the 32k default for non-reasoning" → 期望返回声明额度全额；"uses a positive fallback when output zero"（L6219-6222）→ 无 override 期望 `undefined`，**带 override 48000 期望恰返回 48000**（escape hatch 保持） | 待改 |
| 回归 | `variants` 路径不变：`transform.test.ts:6224-6235` "generates positive built-in Anthropic numeric variants when output is zero" 保持通过（budgetVariants 仍基于 OUTPUT_TOKEN_MAX 构造建议） | 待跑 |
| 回归 | `overflow.ts`：既有 L376/L383/L394 三个 usable 数值锚定**逐值相等**（4.2-5b 已知额度分支不变）；新增：未知额度 + 无 input ⇒ `usable = context - 20_000`；未知额度 + 有 input ⇒ `usable = input - 20_000` | 待改/待加 |
| 新增 | **wire 级**：自定义 provider（仅 name，无 limit）+ 无 override ⇒ 真实序列化请求 body **不含** `max_tokens` 键（复用 `llm.test.ts` Bun.serve + `waitRequest` 捕获通道，config 手写无 limit 的模型条目，非 helper 返回值） | 待加 |
| 新增 | wire 级：已知 131072 非 reasoning 模型 ⇒ body `max_tokens === 131072`（SDK/adapter 未重新注入 32k） | 待加 |
| 新增 | wire 级：显式 `flags.outputTokenMax = 64000`（经 `drainWith(llmLayerWithExecutor({flags}))`）+ 未知额度 ⇒ body `max_tokens === 64000`（用户显式上限对未知模型继续生效） | 待加 |
| 新增 | normalizeReasoningBudget：envelope undefined + options 含 numeric budget ⇒ 原样返回不 throw（skip 分支）；envelope defined 的既有 fail 分支（L6238+）全部保持通过 | 待加 |
| 新增 | transportMaxOutputTokens：envelope undefined + Anthropic thinking budget 存在 ⇒ 返回 undefined（无 NaN 产生） | 待加 |
| 新增 | **native Anthropic 0 值守卫**：模型 `limit.output = 0` 走 native Anthropic 协议 ⇒ body `max_tokens === 4096`（`?? `不跳 0 的守卫点，见 4.2-4b；llm 包协议级测试） | 待加 |
| 新增 | 诊断来源纯函数：`outputTokenMaxSource` 三桶断言——undefined ⇒ `omitted-server-default`；已声明额度 ⇒ `model-declared`；flags 覆盖 ⇒ `explicit-flag`（含 override+未知 ⇒ `explicit-flag`） | 待加 |
| 回归 | 既有 `finish=length → MessageOutputLengthError` 断言全部保持通过（不新增，不放松）；request-prep 组 L1343-1362（known-limit Anthropic envelope 组合）逐值不变 | 待跑 |

## 第七部分：代码更新清单

| 文件 | 函数 / 行号 | 改动概述 | 状态（修复后回填） |
|------|------------|---------|------------------|
| `packages/opencode/src/provider/transform.ts` | `maxOutputTokens` / L1507-1512 | 返回 `number \| undefined`，删两条 32k fallback 路径；override + 未知 ⇒ override | 待改 |
| `packages/opencode/src/provider/transform.ts` | `normalizeReasoningBudget` / L1624 | envelope undefined 时整体 skip（含 L1696 隐式预算检查） | 待改 |
| `packages/opencode/src/provider/transform.ts` | `transportMaxOutputTokens` / L1708 | envelope undefined 时先于 budget 相减 early-return | 待改 |
| `packages/llm/src/protocols/anthropic-messages.ts` | L510 | `outputLimit` 加 0 值守卫（0 → 4096），`?? ` 不跳 0（见 4.2-4b） | 待改 |
| `packages/opencode/src/session/llm/request.ts` | L97-112, L127-145 | undefined 贯通 + 生效额度来源纯函数与日志 | 待改 |
| `packages/opencode/src/session/overflow.ts` | `usable` / L10-20 | 两分支分别解耦（4.2-5）：reserved 用 `min(20k, limit.output)`/20k；无 input 分支 `context - limit.output`/`context - 20k` | 待改 |
| `packages/opencode/src/session/llm.ts` | L33 | 删除 `OUTPUT_TOKEN_MAX` re-export | 待改 |
| `packages/opencode/test/provider/transform.test.ts` | L6196-6236 | helper 矩阵按新契约改写（含 override+unknown 锚定）+ undefined 断言 | 待改 |
| `packages/opencode/test/session/llm.test.ts` | wire 用例区 | 新增 3 条 wire 级用例（无 limit 不发送 / 非 reasoning 全额 / override+未知生效） | 待加 |
| `packages/opencode/test/session/compaction.test.ts` | `usable` 组 | 未知额度两分支用例 + 既有数值锚定保持 | 待加 |
| `packages/opencode/test/session/llm-native.test.ts` | 协议请求构造区 | native Anthropic 0 值守卫用例 | 待加 |

## 第八部分：文档更新清单

| 文档路径 | 要改什么 | 状态（修复后回填） |
|---------|---------|------------------|
| `docs/fixes/subagent-fix-output-length.md` | 第四部分"新规则"保留的 `output=0 → OUTPUT_TOKEN_MAX fallback` 分支标注被本修复取代（防止后人按旧文档恢复） | 待改 |
| `CLAUDE.md` 已知限制 | 视实施结果追加一条：`OUTPUT_TOKEN_MAX` 仅存于 variant 预算建议；`maxOutputTokens` undefined 语义 = 不发送 | 待定 |
| `docs/devlog/2026-11-02-provider-output-token-max-fallback.md` | 修复日志 + 度量表 | 待加 |

本修复触及对外行为契约（wire 请求形状、`maxOutputTokens` 签名），文档清单
不允许可写"无"。

### 8.1 已否决的扩展：诊断 provenance 四桶（决策 2026-11-04）

Issue 期望行为叙述中的四来源诊断（目录 vs config 显式声明分列）经评估**不在
本修复实施**，三桶方案及理由见 4.5。此条记录防止后续实施轮被误加回来：
provenance 字段动 `Provider.Model` 共享类型（15 个 consumer 文件）与对外
model API 形状，须按独立子计划走 §6 v2 流程，不作为本修复的附带改动。
