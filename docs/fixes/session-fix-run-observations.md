# Run 停止通知与续跑视图窗口修正

基线：`64c552e6a8`。来源：2026-11-02 外部复审的两项 P2；维护者已授权修复并补充 PBT。所属子计划：`agentmgmt-2-run-state`。

## 1. 现象与复现

停止通知有两种错号路径：先读目标 run 1，等待后代取消期间目标已经换成 run 2，实际取消 run 2 却通知 run 1；或者 run 1 已完成记账、仍在清理，cancel 等待它时 run 2 开始，通知反而写 run 2 被请求停止。复现使用真实 SessionRunState 和 AgentLifecycle.stop，以 Deferred 固定交接顺序。

视图窗口的复现：t0 发出请求，子在 t5 分钟完成；t30 插入新用户消息，原响应 content-filter 收尾后同一 work re-arm，仍是 run 1。新的 runLoop 将窗口起点重置到 t30，t5 的完成不在最近 10 分钟内，漏出下一份视图。复现使用真实 prompt loop 与测试时钟。

预期：停止操作不谎报被取消的 run；同一逻辑 run 的下一份视图仍覆盖上一步期间结束的子。

## 2. 根因

`lifecycle.ts` 的取消前后数据库快照与 Runner.cancel 捕获的 fiber 不存在身份绑定，前后读都不能证明“这个编号就是此次取消的执行”。`prompt.ts` 则把每次 runLoop 调用的生命周期当成逻辑 run 的生命周期，漏了同号 re-arm。

## 3. 参考语义

没有新增算法或外部协议。直接以定义作参照：取消结果只说明操作时的 runner 状态；最新记录只说明读取时的记账事实。两者不能推导执行身份。视图的参照下界为 `min(now - 10min, lastPresentedStepStart)`，同一 run 的续跑保留该状态，真正新 run 初始化。

## 4. 修复方案

- 停止通知将操作事实与记录事实分开：Session 级的 stop requested / no model run was running；随后可列 `Latest run record after cancellation: N, ...`。删除 `was` 读取和“取消期间下一 run”的推测。快照可能是刚停止的、之前遗留的或新开启的记录，文本不声称属于此次取消。保留编号、时间、结局信息，不增加 ID、锁或取消同步机制。
- 窗口状态由 `loop()` 的 work 闭包持有，并传给 runLoop。第一次实际执行初始化；同号 re-arm 保留；成功开出新号时重置。根 Session 的同一 work re-arm 也保留窗口。收到 finish 后、各提前退出分支之前推进下界（含 content-filter/length/structured output）；预检撤回和 provider 拒绝仍不推进窗口。
- 结束报告继续使用真实关闭记录，不改变；取消范围、消息通道和返回结构不改变。

## 5. 正确性论证

- 停止通知只组合独立可验证事实，不再从异步快照推导取消身份。无记录时不输出记录行；打开记录只称未关闭，不擅自声称仍在运行或崩溃。即使目标在后代取消或旧 fiber 清理期间重启，快照措辞仍成立。
- work 对象在 re-arm 间复用，窗口对象随之复用；新 loop 有独立对象，成功开启新编号也清空旧下界。因此同一 run 不漏长步骤中的结束，新 run 不继承上一 run 的宽窗口。
- 开始写失败时不新认领编号，不据此重置窗口。窗口仍只在真实响应后推进，保留上一轮预检撤回修正。

## 6. 测试清单

| 类型 | 用例 | 状态 |
| --- | --- | --- |
| 回归 | 取消后代期间目标换 run；取消前已关闭、等待清理时新 run 开启 | 已落实，见 T10/T11 |
| 回归 | 长步骤后同号 re-arm 保留孩子完成行 | 已落实，见 T10/T11 |
| PBT | 真实 stop 路径交叉取消交接顺序、打开/关闭/缺失记录、编号与时间；只断言取消事实和记录快照，不猜取消身份 | 已落实，见 T10/T11 |
| PBT | 真实 prompt 路径交叉同号 re-arm / 新号续跑 / 独立新 run / 根 Session re-arm，与时长、结束时间及 10 分钟边界 | 已落实，见 T10/T11 |
| 新增 | 有前置工具步的三请求窗口；取消后的 Idle/Running × 6 种最终记录矩阵 | 已落实，见 T10/T11 |
| 回归 | 上轮开始写失败与 re-arm、预检撤回长压缩；已有 session/effect/agent-management 模块套件 | 已验证；完整模块两项既有预算失败，单跑均过，详见下方 |

## 7. 代码清单

| 文件 | 改动 | 状态 |
| --- | --- | --- |
| `src/agent-management/lifecycle.ts` | 删除取消前读，分开操作与最新记录文本 | 已实施并验证 |
| `src/session/prompt.ts` | 窗口状态移至 work 闭包，同号保留、新号重置 | 已实施并验证 |
| `test/agent-management/lifecycle.test.ts` | 更新有意变更的通知文本契约，增加交接回归及 PBT | 已实施并验证 |
| `test/session/prompt.test.ts` | 增加窗口生命周期回归及 PBT | 已实施并验证 |

路径相对于 `packages/opencode`。本表对应修复提交 `fix(session): preserve run windows and report cancellation snapshots`。

## 8. 文档清单

| 文档 | 同步内容 | 状态 |
| --- | --- | --- |
| `docs/design/agent-management/subplans/agentmgmt-2-run-state.md` | §4.5/§5.3 窗口生命周期；§4.6/§5.4.2 通知事实与快照 | 已更新 |
| `docs/fixes/session-fix-step-tail-repeat-and-agents.md` | 停止通知措辞修正链接 | 已更新 |
| `docs/audits/agentmgmt-2-run-state/expectations.md` | S15/S20、时序及新增性质测试 | 已更新 |
| `docs/design/agent-management/architecture.md`、`docs/research/agent-management-research.md` | 上位文字限定停止通知快照语义 | 已更新 |
| 同目录 `audit-report.md`、`decisions.md` | 本轮处理、独立复核与真实验证结果 | 已更新 |

### 验证结果

- `bun typecheck`（packages/opencode）：通过。
- T10/T11 与相邻回归定向测试：14 pass / 0 fail，236 个断言。
- 完整 `test/session test/effect test/agent-management`：900 pass / 7 skip / 1 todo / 2 fail，910 条、37 文件、26479 个断言，898.83 s。失败为 busy→idle 的 3 s 超时（4.37 s）与 600 子采集的 50 ms 阈值（51.00 ms）；原预算下单独重跑 2 pass / 0 fail。保留整套失败统计，不视为全套全绿。
- 首版新增 PBT 在修前 `64c552e6a8` 的对照：4 pass / 7 fail；最终三请求用例在仅将推进位置恢复到旧位置的独立进程中 2 fail，均抓到重复展示旧完成项。
- workflow 路径 B 独立复核：0 unresolved；S1–S24 标记齐全，`git diff --check` 通过。
- 运行时修改仅 `prompt.ts` 和 `lifecycle.ts`；未修改测试预算。
