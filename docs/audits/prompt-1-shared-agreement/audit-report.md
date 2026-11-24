# Contract Audit Report — `prompt-1-shared-agreement`

> 状态：2026-11-24 独立审核并收敛修复后最终核对（§6.5 路径 B）。
> **时序声明**：首轮实施未按 §6.2 事前产出 `expectations.md`（已在 `expectations.md` 顶部记录流程偏离，不追认）。以下核对覆盖最终收敛后的代码、模板与测试。

## 1. 结论（§6.6 退出标准）

- **Critical / Unresolved**：**0 critical / 0 unresolved**（本轮核对修正了 `default.txt`/`trinity.txt` 残留空 `# Code style` 标题，并在架构/契约文档中诚实记档 `gemini.txt:12,43` 已知残留冲突与 9 份活跃模板口径）。
- **路径 A（机械检查）**：`Step P1–P4` 注释全部就位（`system.ts:27,59`、`request.ts:195-196`；P5 为 `.txt` 修剪，由单测覆盖）；`bun typecheck` 通过；`git diff --check` 零报错。验收由 [#46](https://github.com/lihaokun/opencode/issues/46) 与 [PR #60](https://github.com/lihaokun/opencode/pull/60) 跟踪。

## 2. 路径 B 逐项核对表

| 编号 | 契约项 | 判定 | 代码 / 测试证据（`file:line`） |
|---|---|---|---|
| P1 | 9 份活跃模型模板路由 + `systemSections` 恒末位 SHARED | ✅ | `packages/opencode/src/session/system.ts:27-63`（`provider` 早返回 + `systemSections` 单表达式 `[provider(model), PROMPT_SHARED]`）。测试：`test/session/system.test.ts` 全分支矩阵断言。 |
| P2 | `preparePayload` 显式 prompt opt-out 与前缀顺序 | ✅ | `packages/opencode/src/session/llm/request.ts:195-204` 仅替换三元右支为 `SystemPrompt.systemSections(model)`。测试：`test/session/prompt.test.ts`（`loop delivers the shared working agreement on the wire` 与 `explicit agent prompt opts out`）。 |
| P3 | `default.txt` / `trinity.txt` 硬冲突与空标题修剪 | ✅ | `packages/opencode/src/session/prompt/default.txt`、`trinity.txt` 移除 3 条硬规则、检索优先委派句与孤立 `# Code style` 空标题，保留异步机件行。测试：`test/session/system.test.ts` 正负向断言。 |
| P4 | D13 委派处方撤销 | ✅ | `packages/opencode/src/tool/agent.ts` 保持 PR #59 纯机件描述，无用法处方。 |
| P5 | `gemini.txt:12,43` 已知残留冲突（E② + D12） | ⚠️ | 按 E② 最小刀法与 D12 决议本 PR 暂不改写 `gemini.txt`，已在 `architecture.md` / `expectations.md` / `decisions.md` 显式记档，留待 beta 观察后统一收敛。 |
| P6 | 首轮事前 `expectations.md` 缺失 | ⚠️ | 历史流程偏离，已在 `expectations.md` 与 `decisions.md` 记录接受，不追认。 |

完整收敛记录见 [docs/fixes/runtime-fix-pr60-audit-convergence.md](../../fixes/runtime-fix-pr60-audit-convergence.md)。
