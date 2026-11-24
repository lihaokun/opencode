# Contract Audit Decisions — `prompt-1-shared-agreement`

本子计划审核发现的偏离与契约收敛决策（格式：项 → 决定 → 依据）：

1. **首轮 `expectations.md` 事前时序违例** → 接受历史偏离并保留声明，不追认 — 事后补抽已完成并同步至最终 HEAD。
2. **B7 与 D13 复审修订** → `SystemPrompt.provider` 保持早返回裸模板，`SystemPrompt.systemSections` 为唯一装配点（仅 `request.ts:198` 调用）；撤回 `tool/agent.ts` 中的“何时委派”处方以维护 PR #59 纯机件原则。
3. **`gemini.txt:12,43` 已知残留冲突（2026-11-24）** → 按 E② 最小刀法与 D12 决议本 PR 不改写 `gemini.txt`，显式记档留待 beta 观察后统一收敛，避免与最小可归因 diff 冲突。
