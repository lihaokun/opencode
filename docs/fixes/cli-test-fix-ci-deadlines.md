# CLI 测试时间预算修正

基线：PR #97，`4cecf3ae0a`；CI 实际测试提交 `fa20e2e381`，已包含 dev 的 #94。

## 1. 现象与复现

CI 三个单测任务各失败一条：Windows ACP 配置测试在收包时超时；Linux stream transport 等待 completed commit 超时；Linux 活跃子 Agent 用例触发等待上限。它们不是 PowerShell 退出码错误。原用例本机单跑 3/3 通过，stream transport 整文件 30/30 通过。

具体预算：ACP 每次 receive 15 s（外层用例 60 s）；transport 的 waitFor 默认 1 s；活跃子 Agent 用例将 `OPENCODE_RUN_AGENT_WAIT_MS` 设为 700 ms，而每个工具执行都先启动 Bun 再睡 400 ms。日志的 1s 是 `Math.round(700/1000)`，不是真实配置。

## 2. 根因与证据边界

这些测试依赖真实进程、HTTP 或调度，过短的内部等待先于外层 deadline 失败。子 Agent 测试要求的事件间隔包括启动与调度成本，不只有显式 sleep。

CLI 等待逻辑、stream transport、ACP 客户端及这三个用例与 dev 相同；PR 仍可能通过上游工作量影响耗时，因此不能仅凭“文件未改”和单跑通过排除性能回归。先用同一隔离副本交替测量 dev 与 PR 合并版本；Windows 具体卡在哪个 RPC 目前日志不足，补充请求名诊断。

## 3. 参考与判定

沿用仓库现有真实子进程测试的分层预算：内部等待低于外层用例时限。计时性质保持“每个活动间隔小于上限，而整个活动阶段超过上限”；并保留卡死子 Agent 会被放弃的反向用例。

## 4. 修复方案

- ACP 测试客户端请求收包预算 15 s → 30 s，超时错误包含 RPC method/id；外层 60 s 不改。
- stream transport 测试的 waitFor 默认预算 1 s → 5 s；仍等待实际 UI commit，不改变核心断言。
- POSIX 活跃子 Agent 测试上限 700 ms → 5 s，四次工具等待各 400 ms → 2 s，总等待 8 s；仍检查结果交付、退出码及未放弃。测试外层 120 s、生产默认 10 分钟不改。
- 仅测试预算变化，GitHub job 总时限及生产行为不变。

## 5. 正确性论证

ACP 与 transport 放宽的是就绪等待，不是性能断言；永不响应仍会超时。Agent 测试按比例扩大窗口，总工作量仍大于上限，不能靠“足够快结束”蒙混过关。以独立进程暂时禁用活动重置进行负向验证，应在 5 s 上限失败；原 stuck-agent 用例继续验证真实取消路径。

## 6. 测试清单

| 项目 | 验证 | 状态 |
| --- | --- | --- |
| 性能对照 | dev/PR 交替执行，记录 RPC、活动间隔与总时长 | 已完成，见下方 |
| 回归 | ACP 配置、transport、活跃子 Agent 及卡死子 Agent | 通过，包含在下述模块运行 |
| 负向 | 禁用活动重置时，放宽后的活跃用例仍失败 | 已验证：5s 放弃，退出码 1，命中“不应放弃”断言 |
| 模块 | 三个受影响测试文件及 opencode typecheck | typecheck 通过；61 pass / 1 超时，单跑该项通过，详见下方 |

## 7. 代码清单

仅修改 `packages/opencode/test/cli/acp/acp-test-client.ts`、`test/cli/run/stream.transport.test.ts`、`test/cli/run/run-process.test.ts`。不修改 runtime、权限或会话数据结构。

## 8. 文档清单

本文件记录对照结果、验证与局限；更新 PR #97 的验证说明。原 Agent 子计划的行为契约不变，无需新子计划。

### 性能对照结果

在单一隔离副本中切换 `dev@45045f09cf` 与 CI 合并树 `fa20e2e381`，锁文件一致、依赖分别指向副本内 workspace。两侧运行相同真实 CLI、ACP 和 transport 用例，临时记录 RPC 延迟与 CLI 收到活动事件的间隔。测量时仅把人工 700 ms 上限放宽至 20 s，避免未完成的样本被截断；四次 400 ms 工具工作量不变。

首轮与其他回归同时执行，PR 总耗时在 10.16–32.85 s 间波动，因此不据此作性能归因。待其他本轮测试结束后，按 PR/dev/dev/PR 顺序再运行四轮，结果如下（每格为两次实测）：

| 指标 | dev | PR |
| --- | --- | --- |
| 子 Agent 场景总耗时 | 27.27 / 18.53 s | 12.62 / 20.71 s |
| 等待期间最大活动间隔 | 1072 / 654 ms | 577 / 698 ms |
| ACP initialize | 11.72 / 6.51 s | 5.87 / 10.65 s |
| ACP session/new | 2.63 / 2.48 s | 2.32 / 3.15 s |

每次子 Agent 测量都收到 103 个相关事件，结果正常交付。**dev 自身也出现超过 700 ms 的活动间隔**，说明旧测试预算并非基线可稳定满足。未观察到 PR 在这些路径上一致变慢的趋势；不能据此声称新增功能零开销。这是共享 Linux 主机上的小样本，不是 Windows 测量或全局性能保证。

### 修后验证

- `bun typecheck`（packages/opencode）通过，`git diff --check` 通过。
- 三个受影响测试文件完整运行：61 pass / 1 fail，62 tests、249 个断言。CI 报告的三个用例和卡死子 Agent 用例均通过；失败为本轮未改的 `unknown stream finish preserves partial output and continues`，其子进程自带 30 s 预算超时。结束性能测量后再次运行三个文件，仍为 61/1；两次失败都保留记录。
- 对该额外失败单跑并打印子进程阶段日志：dev 20.216 s、PR 16.842 s，均退出 0，输出均为 `partial response\nrecovered\n`。未改它的预算，也不把整套运行写成全绿。
- 独立负向进程仅禁用 CLI 在子 Agent 活动时重置计时器：放宽后的活跃用例仍以 `Gave up waiting ... after 5s`、退出码 1 失败，证明没有因放宽上限丢掉计时重置的检验。生产代码未写入该变异。
- Windows 30 s 预算效果需由 PR CI 验证；新超时消息会包含 RPC method/id，后续失败不再只留下无上下文的 TimeoutError。
