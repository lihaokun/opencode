# Decisions — `session-1-incomplete-stream-recovery`

状态：Unit A 已记录，后续单元继续追加
日期：2026-08-06

## D1 — Retry policy

- 决定：active incomplete-stream chain 的默认且唯一 runtime limit 为 2；新 attempts 等待 2 秒、4 秒，factor=2，无 jitter。
- 原因：用户确认该设计；与仓库现有 retry status/backoff 数值一致，同时保持最多三个 assistant IDs 的明确上界。
- 影响：schema 的 `limit` 仍为非负整数，以便 wire record 自描述；各 runtime caller 必须传共享常量，不提供配置入口。

## D2 — Strict SafeRetry evidence

- 决定：只有 `tools.length===0` 才允许 SafeRetry，不设置 tool-name 或 StructuredOutput replay-safe 例外。
- 原因：只要已经观察到 tool evidence，就不能证明 replay 不会重复副作用。
- 影响：存在 tool evidence 时只能全部 settled 后 Continue，否则 ManualStop。

## D3 — Canonical classification literal

- 决定：durable recovery 必含 `classification="incomplete-stream"`；canonical literal 定义在 browser-safe schema 模块，LLM 的 `ProviderFailureClassification` 组合并复用它。
- 原因：第二轮字段审计发现 fix plan 有该判别字段，而子计划/schema 第一稿漏写；在测试固化前已纠正。schema 包位于依赖图底部，不能反向依赖 LLM。
- 影响：current generated client 已重新生成；adapter 是否产生该 classification 留给 Unit B。

## D4 — Invalid evidence is sanitized and fails closed

- 决定：重复 tool IDs、非法 attempt/limit 或违反 terminal implication 的输入返回 `manual-stop/persistence-failure`；输出不回显不可信 tools，并把 retry 归一化为 `0 <= attempt <= limit`。
- 原因：分类器即使接到坏的归一化输入，也必须返回可被 wire schema 持久化的合法 record，不能让诊断路径再次失败或转成自动 replay。
- 影响：property tests 同时验证输出可 decode 和 Safe/Continue 的必要条件。

## D5 — Schema validation boundary

- 决定：Effect Schema decoder 验证结构、closed enums、非负整数和非空字符串；共享 classifier/constructor 验证跨字段语义。
- 原因：action/reason/tool/retry 的条件约束依赖 caller facts 和分类顺序，不适合在可复用 wire decoder 中隐藏 runtime policy。
- 影响：runtime 不得直接拼装 recovery；必须调用共享 classifier。

## D6 — Property-test dependency

- 决定：`packages/core` 显式加入 `fast-check@4.8.0` direct devDependency，锁文件固定同一版本。
- 原因：虽然 Effect 已传递依赖 fast-check，但直接测试 import 必须由直接依赖声明承担；用户已确认。
- 影响：Unit A property suite 当前 7 tests、527 assertions，全绿。

## W1 — Unrelated schema package baseline failure

- 观察：扩展运行整个 `packages/schema` test suite 时，`test/event-manifest.test.ts` 仍断言 `ServerDefinitions.length===55`，当前 `HEAD` manifest 实际为 58，并有相应旧顺序断言失败。
- 因果核对：Issue #7 diff 未修改 `event-manifest.ts`、manifest inventory 或该测试；给 `Step.Failed` 增加 optional payload 不会改变 definitions 数量。受影响的 schema suites（contract hygiene、legacy event、session recovery）为 12/12 通过。
- 处理：不在 Issue #7 中顺手调整无关 manifest 基线；Unit A gate 记录该既有失败，后续仍运行 targeted affected suites。

## W2 — Install environment

- 观察：首次正常 `bun install` 在依赖已经链接后，root postinstall 因 shell 中没有裸 `bun` 命令而退出 127。
- 处理：随后用同一 Bun 1.3.14 执行 `bun install --ignore-scripts`，完成且报告 2429 installs、无变化；core 的 fast-check direct link、锁文件、测试和 typecheck 均已验证。此为执行环境 PATH 条件，不是仓库代码失败。
