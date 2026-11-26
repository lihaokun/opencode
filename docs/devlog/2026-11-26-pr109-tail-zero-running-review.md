# 开发日志 — PR #109 审核（step tail 零运行状态）

日期：2026-11-26
分支：`tail-zero-running` → `dev`（squash）
关联：PR [#109](https://github.com/lihaokun/opencode/pull/109)；修复文档 `docs/fixes/session-fix-tail-zero-running.md`

## 做了什么

### 1. 审核范围与方法

PR 分支基于 #60 之前的 `dev`（merge-base `6cf97d7884`），而 #60 改过 `prompt.ts` 与 `prompt.test.ts`。PR 自带的 CI 是 11-10 在旧基线上跑的，不覆盖合并结果。所以全部验证在 **`dev` HEAD（`df4ef923a5`）+ PR 的合并树**上重做，而不是在 PR 分支上：

- 定向：`step-tail.test.ts` 23/23；`prompt.test.ts` 190/190（dev 基线同为 190/190）；相邻 tools / provider-transform / agent-management 741/741；`tsgo` 通过。
- 证伪：`step-tail.ts:186` 改回 `return undefined` → step-tail 4 个用例红、集成用例在“退窗后应为零运行行”处红（实得 `undefined`）。恢复后全绿。
- 结论：生产改动正确，新断言不是装饰，可以合并。

### 2. 审核发现的缺口与处理

| #   | 发现                                                                                                                                                                                                | 处理                                                 |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 1   | **没有端到端测试**。PR 的集成用例用 `sessions.create({ parentID })` 直接造子会话，run 记录手写；没有用例把“真实 `agent` 工具建子 → 子跑完写回 run 记录 → 新进程恢复父会话 → 尾巴出现零运行行”串起来 | 补 `test/cli/run/step-tail-process.test.ts`（见下）  |
| 2   | 旧修复文档 `session-fix-tail-window-counts.md` 正文 4 处仍按旧口径陈述（“应为 undefined / V=∅ 不输出 / 返回 undefined / 输出为空”），且未区分“有子全退窗”与“无子”两种空                             | 加 `[已废弃，2026-11-10]` 标注并逐处点明两种空的区别 |
| 3   | 没有 devlog                                                                                                                                                                                         | 本文                                                 |

### 3. 新增的进程级用例

`packages/opencode/test/cli/run/step-tail-process.test.ts`，一个用例 14 个断言，全部在真实 `opencode run` 子进程里：

1. 父 Agent 真实调用 `agent` 工具建子；
2. `opencode db` 查库确认子行 `parent_id` 正确、run 记录 `number=1 / completed`（由真实工具写入）；
3. 子结束的报告唤醒父会话，父第二次请求的尾巴是 `1 direct, 0 running, 1 idle.` + 明细行（窗口内）；
4. 用 `opencode db` 把子的 run 时间戳回拨 11 分钟，模拟数小时后恢复时的数据状态；
5. **新进程** `opencode run --session <id>` 恢复，尾巴精确等于 `Now: …\n\nYour subagents: 0 running.`，不含子 ID；
6. 查库确认两个进程都没有把尾巴写进历史。

证伪：回滚生产修复后，第 5 步得到的最后一条 user 消息是用户原话（无尾巴），用例红。连跑 3 次稳定（~7.5 s）。

第 4 步是改数据库而不是真等：run 记录的时间戳写入后不再变，所以数据形态与真实恢复一致；但“进程存活期间跨过窗口”这条路径未覆盖（纯函数与进程内集成测试已覆盖）。

## 实施插曲（教训）

1. **PR 自带 CI 不等于合并结果的证据**。PR 分支落后于 base 时，绿的 CI 只证明旧基线。审核前先 `git merge-base` 看落后多少、落后的提交有没有碰同一批文件。
2. **合并树的“累计 diff”会误导**。`git diff dev PR_branch -- <file>`（两点）显示 `prompt.test.ts` +1390/−1177，那是 dev 上 #60 的改动；三点 diff（`dev...PR`）才是 PR 自己的 +37/−5。
3. **`opencode db --format json` 的 JSON 列是原始文本**。`session.metadata` 需要再 `JSON.parse` 一次，直接当对象用会 decode 失败。
4. **CLI fixture 的 `llm` 是 Effect 值的集合**。`llm.reset` / `llm.pending` / `llm.inputs` 都是 `Effect`，写 `llm.reset()` 会得到 `TypeError: not a function`；要 `yield* llm.reset`。进程内测试的 `useServerConfig` 返回的是同一形状，容易记混。
5. **Effect v4 的 `Schema.Record` 是两个位置参数**（`Schema.Record(key, value)`），不是对象形式。
6. **SQLite 的 `json_set` 可以做时间回拨**。比真等待快，且比重建整行安全（不动其它键）；但只对“写入后不变”的字段合法。

## 度量

| 指标           | 数值                                                                       |
| -------------- | -------------------------------------------------------------------------- |
| 新增代码行数   | ~190（进程级用例 170 + 旧文档标注 ~16 + 本文）                             |
| 修改代码行数   | ~6（旧文档 4 处原句保留、加标注）                                          |
| 删除代码行数   | 0                                                                          |
| 涉及文件数     | 3（新测试、旧 fix 文档、devlog）                                           |
| 新增测试用例数 | 1（进程级，14 断言）                                                       |
| 测试通过率     | 定向 100%：新用例 1/1（×3），step-tail 23/23，prompt 190/190，相邻 741/741 |
| 发现 bug 数    | 0（生产代码无缺陷；缺口为测试覆盖与文档残留）                              |
| 修复 bug 数    | 0                                                                          |
| 迭代轮次       | 审核 1 轮 + 补测 1 轮                                                      |

## 经验教训

（已回写 CLAUDE.md「已知限制与注意事项」；要点：审核前先核对 PR 分支与 base 的落后量并在合并树上验证；两级测试之间若有“真实链路 × 新断言”的未覆盖组合，补一个进程级用例的成本远低于它漏掉的回归。）
