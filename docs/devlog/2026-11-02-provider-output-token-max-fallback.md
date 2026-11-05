# 开发日志 — 未配置输出额度时移除静默 32k 客户端上限（issue #98）

- 日期：2026-11-02（实施收尾 2026-11-04）
- 分支：`fix/provider-output-token-max-fallback`
- 修正方案：`docs/fixes/provider-fix-output-token-max-fallback.md`（§7.1 八部分）
- 对应 issue：[lihaokun/opencode#98](https://github.com/lihaokun/opencode/issues/98)

## 做了什么

自定义 provider 只填模型名（无 `limit`/`reasoning` 元数据）时，`maxOutputTokens`
把"未知额度"编码成 32,000 写进 wire 请求；已声明额度但 `reasoning: false` 的
模型也被 32k 夹逼。修复把"未知"还原为 `undefined`（不发送参数，服务端默认
生效），不引入任何替代常数：

- **M4（RED 先行）**：全部用例先写并在旧代码上验证 RED——helper 矩阵 2 RED
  （131072 非 reasoning 收 32000、output=0 收 32000）、normalize-skip RED、
  usable-unknown RED、wire 2 RED（max_tokens 32000 / 键存在）、native 协议
  RED（`max_tokens: 0` 实际发出）。
- **M1 核心契约**：`maxOutputTokens` → `number | undefined`（override 保持
  escape hatch：override+未知 ⇒ override）；`normalizeReasoningBudget`
  envelope undefined 整体 skip；`transportMaxOutputTokens` 先于 budget 相减
  early-return（杜绝 NaN）；删除 `session/llm.ts` 的 `OUTPUT_TOKEN_MAX`
  re-export（无 consumer）。
- **M2 请求贯通**：`overflow.usable` 两分支分别解耦——reserve 已知
  `min(20k, limit.output)` / 未知 20k；无 input 分支已知 `context -
  limit.output` / 未知 `context - 20k`（判定收紧 12k，保守侧）。新增诊断
  纯函数 `outputTokenMaxSource`（三桶：`explicit-flag` / `model-declared` /
  `omitted-server-default`）+ request prep 后 `logInfo("llm output limit")`。
- **M3 native Anthropic 守卫**：`anthropic-messages.ts` 协议层
  `resolvedMaxTokens = generation?.maxTokens ?? (outputLimit > 0 ? outputLimit
  : 4096)`，未知模型回落适配器默认时 `logWarning` 显式声明来源。

## 关键决策

1. **override+未知 ⇒ override（非 undefined）**：显式环境变量是用户声明
   "我知道上限在哪"的逃生通道，切断它会让未知模型彻底失去客户端可控上限。
   helper L6221 与 wire 第三例双锚定。
2. **诊断三桶而非四桶**：目录与 config 合并在 `provider.ts` 同一字段，请求
   时不可区分；区分两者不影响"不把未知伪装成已知"的验收义务（决策已按
   deviation 记录在 issue 评论）。
3. **native 守卫放 llm 包协议级测试**（`anthropic-output-limit.test.ts`），
   而非修正方案原计划的 `llm-native.test.ts`：后者只测 opencode 侧 request
   映射，不触协议序列化，0 值守卫的 wire 断言必须落在 `LLMClient.prepare`
   的实际 body 上。第六部分已回填该偏差及理由。
4. **overflow 未知分支用 20k 而非 0/32k**：预检是本地启发式，有界本地常数
   合法（与 wire 注入的本质区别：它不声称来自模型能力）；从 `context-32k`
   收紧到 `context-20k`，方向保守，不会漏检。

## 踩过的坑

1. **wire override 测试超时（batch 下 5000ms timeout、单独跑时过时不过）**：
   根因是 `drainWith` 每次构建隔离 LLM runtime，共享机 load average ~12 时
   构建可能超过 bun 默认 5s 测试超时。给该用例显式 30s 超时后 batch 稳定
   5/5 通过。教训：隔离 runtime 构建 + 共享机负载的组合要给显式超时，
   不能依赖默认值；"单独跑通过 batch 挂"先查负载与超时预算再查逻辑。
2. **`?? 4096` 不跳 0**：修正方案自审时发现初稿误以为 `??` 能兜住 0——
   0 不是 nullish。RED 测试实际发出 `max_tokens: 0` 才坐实守卫必要性。
3. **typecheck 暴露 `reasoningBudgetError` 入参类型**：`normalizeReasoningBudget`
   放宽为 `number | undefined` 后，内部 `fail()` 传给 error 构造器的类型
   未同步，tsgo 抓出。同步放宽即可（undefined 分支在 fail 定义前已 return）。
4. **`turbo typecheck --force` 的正确姿势**：根目录 `bun run typecheck --force`
   会把 `--force` 透传给子包 `tsgo --noEmit --force` 报 TS5093；实际
   turbo 自己吃 `--force`（cache bypass）。SIGSEGV 一次后重跑即过。
5. **cf-ai-gateway e2e 4 例失败为存量问题**：mock 库 `ai-gateway-provider`
   3.2.0 不认识 `anthropic.messages` 协议标识。stash 后在干净 HEAD 复跑
   同样失败，确认与本修复无关，不在本分支处理。

## 经验教训（已回写 CLAUDE.md）

- `maxOutputTokens` undefined 语义、32k 仅存 variant catalog、native Anthropic
  0 值守卫、协议级 vs request 映射测试不可互替——已追加到「已知限制与注意
  事项」。
- 修正方案自审抓出两处初稿错误（`??` 不跳 0、overflow 两分支不可统一），
  RED 测试在旧代码上的实际观测（`max_tokens: 0`）是修正方案正确性的最终
  裁判。

## 度量

| 指标           | 数值                   |
| -------------- | ---------------------- |
| 新增代码行数   | 369（含文档与测试）    |
| 修改代码行数   | ~45（净变更中非新增部分） |
| 删除代码行数   | 51                     |
| 涉及文件数     | 11（源码 6 + 测试 4 + 文档 3，CLAUDE.md 与 devlog 另计） |
| 新增测试用例数 | 14（helper 8 + wire 3 + 协议 3） |
| 测试通过率     | opencode provider 752/756（4 失败为存量 gateway mock 问题）、session 731/738+1todo、llm 包 303/303（+30 skip） |
| 发现 bug 数    | 3（初稿方案错误 2：`??` 不跳 0、overflow 分支混淆；`reasoningBudgetError` 类型遗漏 1） |
| 修复 bug 数    | 3                      |
| 迭代轮次       | 设计 5 轮（文档评审）/实现 1 轮/修复 1 轮（类型 + 测试超时） |
