# 摘要输入超限时逐档保留近期原文

## 1. 现象与复现

ker79 的 mldsa 在 2026-11-17 的 19 次摘要尝试使用同一标记。正常请求报告输入 868,796 tokens（含缓存读取）。beta.21 隔离重放生成 2,985,105 字节请求，网关返回 HTTP 400、1261、Prompt exceeds max length，没有报告超额。以一个拒绝过长摘要、接受较短前缀的 provider 重现。

## 2. 根因

普通压缩选出的历史前缀可能超过摘要模型输入窗口。首次修补直接尝试最多 25% 的原文预算并把中间错误写进转录，既可能过量保留，也可能重复对相同内容发请求。

## 3. 参考实现

[ZCode 的实测基准加增量](https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/apps/zcode-cli/packages/core/src/runtime/methods/compact.ts#L335-L371) 及[按组覆盖缺口](https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/apps/zcode-cli/packages/core/src/runtime/helpers/compact-selection.ts#L231-L267)。本地按每条消息内容估算，含 reasoning、工具名/入参，并在准备后的请求中计入系统提示和工具定义；每约三个字符计一个 token。摘要会重写历史，因而用两个请求的估值之差校准。

## 4. 方案

- 配对记录正常完成的实际输入 A（不重复计算缓存）及同请求本地估值 E0。只用同 provider/model 且仍在标记前历史中的基准；旧会话缺基准时使用当前请求本地估值。
- 第一次摘要超限时优先取 provider 给出的确切缺口；否则使用 A + E1 − E0 与摘要模型可用输入预算的差（E1 为准备后的摘要估值）。按可用输入预算的 5% 向上取整，无正缺口从 5% 起，最高 25%。举例：7% 从 10% 开始。
- 各档是相对首次摘要的累计缩减目标。将较新的整组从摘要头移到保留区，按完整候选请求复算。相同边界、不变小的请求不发；再次超限才推进下一档。总原文保留量独立受主模型可用预算 25% 及显式配置约束。
- 只有成功摘要结算标记，晚到消息照既有顺序投影。中间输入拒绝只进诊断，所有档耗尽才向会话报告一次失败。保留现有普通/手动、replay 分支及非越界错误语义。

## 5. 正确性与边界

最多五档。每次额外请求对应更短的前缀及更小的准备后输入。预算是基于字符的估值，不保证 provider 接受；即便单组过大、未知模型预算、显式禁用保留或插件使输入无法缩短，也能有限退出。跨进程的失败尝试预算不在本次范围。

## 6. 回归计划

核对实测输入基准与缓存、缺基准/异模型、确切缺口、7% 进 10%、未知缺口、整组跨档、25%/配置上限、恢复成功和穷尽、迟到输入、错误事件和转录。用属性测试覆盖档位取整和边界单调性，用真实会话和脚本化 provider 核对请求与投影。

## 7. 代码范围

V1 请求估值、成功请求基准记录、摘要选择和错误传递。不改 V2 或业务会话库。

## 8. 契约同步

同步 [详细设计](../design/compaction-recovery/detailed-design.md) 和[验收记录](../audits/comprec-1-restoration/expectations.md)，覆盖现有成功后 restoration 的触发和去重。

验证结果：旧实现的 7% 用例修前失败，候选直接从 15 组降到 10 组；修后先降至 13 组，若再次超限则降到 12 组。五个压缩/历史投影/restoration/预算测试文件合计 113 pass、1 skip，完整 prompt 模块 177 pass、1 skip，两套合计 290 pass、2 skip、0 fail。opencode package typecheck 及仓库 pre-push 的 30 项任务通过。独立复核记录在 comprec-1-restoration 的 audit-report 和 decisions。
