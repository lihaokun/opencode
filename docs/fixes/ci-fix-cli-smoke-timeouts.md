# CLI 冒烟测试的分层超时

## 1. 现象与复现

PR #106 的 [Windows unit 2/3](https://github.com/lihaokun/opencode/actions/runs/41862255755/job/126686978833)
中，`test/cli/smokes/read-only.test.ts` 的 `mcp list: exits 0` 在 60,000 ms 被 Bun 判超时。
子进程清理后的结果到 63,495 ms 才返回，随后 `expectExit` 又抛出测试之外的未处理错误。
该分片为 1,042 pass、1 fail、1 error。本机同一用例以 Bun 1.4.4 运行约 3.3 秒通过。

复核命令（从 `packages/opencode` 运行）：

```sh
bun test test/cli/smokes/read-only.test.ts --timeout 30000
```

Windows runner 上的长耗时尚未在本机复现；保留真实 CI 失败作为环境证据。

## 2. 根因与已知边界

明确缺陷是两个 deadline 重合：`opencode.spawn` 默认子进程上限 60 秒，而全部七个 smoke 用例
也显式设置 60 秒外层上限。外层还包含 fixture 初始化和子进程清理，无法为内部超时留下余量。
这解释了本次超时后的第二条错误。

现有日志未保留超时子进程的部分输出，不能确定 Windows 为何超过 60 秒。
提高 Windows 子进程预算是对慢环境的容忍措施，不宣称已经修复所有 Windows 卡死或性能问题。

## 3. 参考对照

`test/lib/cli-process.ts` 已明确要求子进程 deadline 小于外层测试 deadline；本组七个用例违反了该约束。
无需修改生产 `AppProcess` 或 CLI 执行路径。

## 4. 修复方案

- 本组只读 CLI smoke 的子进程预算：Windows 120 秒；其他平台继续使用 `CLI_PROCESS_TIMEOUT_MS`（60 秒）。
- 外层测试预算统一为子进程预算加 60 秒，覆盖 fixture 初始化、进程终止和临时目录清理。
- 七个 `spawn` 显式传入相同预算，七个外层用例使用对应预算，避免再次出现内外限额相等。
- 保留退出码、输出断言和测试集合，不引入失败自动重试，不改变全局 CLI fixture 默认上限。

## 5. 正确性论证

外层预算严格大于子进程预算；在初始化和清理合计不超过 60 秒时，内部超时会先返回失败结果，
让原有断言在当前测试内报告失败。该余量是有限预算，不保证任意宿主卡死都可清理。
正常执行仍必须满足原断言；Windows 超过 120 秒仍失败，未将失败转换为成功。

## 6. 验证清单

- 既有七个真实 CLI smoke 全量运行，覆盖 mcp/providers/models/agent/session/stats/db。
- `bun typecheck`。
- Windows 结果以更新后的 PR CI 为准；不以 Linux 通过替代 Windows 验证。
- 无新增镜像常量测试；预算调整由原有进程级回归验证。

状态：Bun 1.4.4 下七个 CLI smoke 全量通过（7 pass / 0 fail，19.77 秒），`bun typecheck` 通过；Windows 等待更新后的 PR CI。

## 7. 代码更新清单

| 文件                                                  | 调整                                           |
| ----------------------------------------------------- | ---------------------------------------------- |
| `packages/opencode/test/cli/smokes/read-only.test.ts` | 平台子进程预算、独立外层预算；七处调用统一使用 |

## 8. 文档更新清单

本文件记录失败证据、超时层级、验证与局限。未改变生产接口、用户配置或 Agent 契约。

## 9. ACP 冷启动预算（PR #107 复审 CI）

在 `5d6659ea41` 的 [Windows unit 1/3](https://github.com/lihaokun/opencode/actions/runs/41988525669/job/127114925693)
中，`config-options.test.ts` 首项在等待 ACP initialize 响应时超过 30 秒，含清理共约 34.7 秒失败。
该分片 1569 pass / 1 fail；其余单测分片、两端 E2E、typecheck 均通过。前一 HEAD 的同组 CI 也已通过。
这次失败没有涉及 grep 断言；日志不能证明首次冷启动为何超过预算。

调整仅限 ACP 子进程测试：Windows initialize 接收预算 60 秒，外层测试 120 秒；Linux 保持 30/60 秒。
普通 ACP 请求仍为 30 秒，通知等待仍用原预算。初始化前关闭 stdin 的用例也包含冷启动，复用初始化预算；
初始化后的 EOF 退出仍限 15 秒。五个 ACP 测试文件引用统一外层常量，避免只改内层导致外层先超时。
成功条件、协议断言、生产代码、并发和失败重试策略均不改变。

验证：Bun 1.4.4 / Linux 下完整 ACP 子进程测试 16 pass / 0 fail，108 个断言，约 48.8 秒；`bun typecheck` 通过。Windows 稳定性由新 CI 验证，不把预算调整当作底层卡死已根治。
