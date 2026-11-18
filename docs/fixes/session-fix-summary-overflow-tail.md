# 摘要请求超限时保留更多近期原文

1. **复现**：ker79 的 mldsa 主会话在 2026-11-17 收到 19 次摘要请求的 `Prompt exceeds max length`。首次自动压缩和后续消息唤醒都指向同一个 marker。上一次正常调用的总用量为 869,806 tokens，服务端没有返回被拒摘要的精确 token 数。
2. **根因**：正常选取近期消息后，摘要输入仍可能超过服务端限额。原先 `processCompaction` 收到 `compact` 后就记录错误并结束。同一个 marker 之后被唤醒时，会再次选到同一段历史。
3. **参考机制**：现有 `select` 返回待总结的前缀和 `tail_start_id`。成功摘要结算 marker 后，`filterCompacted` 投影出摘要、保留原文、晚到消息。#60 的 `SessionRestoration` 用同一尾部边界判断是否需要补回文件等材料。
4. **恢复**：摘要输入超限且有 marker 时，尝试向前移动一次分界。沿用近期 turn 的选取、长 turn 的拆分和显式保留上限。恢复尾部预算最多取主模型可用输入的四分之一，沿用常规预算的比例，允许超过默认的 15,000-token 上限。只在仍有旧前缀、前缀确实变短、经插件处理的摘要文本也变短时发送第二次请求。
5. **边界**：每次处理 marker 最多额外请求一次。只有成功才提交新的尾部边界并继续。第一次失败保存在转录中，随后成功时不会发终止错误通知。新的输入仍在 marker 之后。显式关闭保留、缺少已知预算或另走被拒用户输入 replay 的情况沿用原有错误出口。单条超大的消息仍可能导致失败，后续唤醒可再次尝试。
6. **回归**：真实 session/processor 配合脚本化 provider 依次返回超限和成功，核对两次请求范围和最终持久消息投影。另覆盖第二次仍超限及显式关闭保留，断言请求次数、终止事件数和失败 marker 状态。
7. **代码**：`session/compaction.ts` 负责选择边界、发送摘要和报告最终溢出。`session/processor.ts` 将摘要请求的溢出通知交给该调用方。
8. **契约**：见 [压缩后恢复](../design/compaction-recovery/detailed-design.md) 和 [恢复验收](../audits/comprec-1-restoration/expectations.md)。
