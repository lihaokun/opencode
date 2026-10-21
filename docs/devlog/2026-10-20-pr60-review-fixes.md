# 开发日志 — PR #60 审核意见修复轮

日期：2026-10-20
分支：`issue-46-runtime-alignment`
提交：`b3718049` … `22377e6c`（修复批次共 12 个 commit）
关联：PR #60、issue #46、`docs/workflow.md` §6.5（路径 B 独立审）

## 做了什么

Reviewer（lihaokun）在 PR #60 留 14 项审核意见（A 必修 3 / B 应修 6 / C 流程 2 / D 设计 4 / E 独立缺陷 1）。逐项核实全部属实后按批次修复：

**A 组（功能缺陷）**
- A1 `shell_output`/`shell_kill` 定义了但从未注册进 registry——模型调不到工具文本指向的工具；测试直接 import 工具对象所以全绿。已接线 + registry 级测试。
- A2 后台 shell job 无 metadata，cancelBackgroundJobs 级联匹配不上——agent_stop/中断停不掉子 agent 的后台命令，完成后还会唤醒已停会话。补 `metadata: { sessionId }`。
- A3 输出 buffer 无界累加、注册表永不清理。改 200k 有界尾部 + 结算删除。

**B 组（应当修）**
- B4 grep `context` 参数校验了但从未传给 rg。展开为 before/after（显式参数逐侧覆盖）。
- B5 恢复候选把目录当文件（read 目录结果同样有 display.path）；**修法修正**：edit 分支的 `metadata.filepath` 是 permission request 的形状，result metadata 从未有过该字段（正确来源 `filediff.file`）——按初稿修 B5 会让 edit 候选恒空，审核意见的这一处本身需要修正。
- B6 restoration 每 provider step 全量读历史。注入点移到压缩 task arm（用户拍板"纯 C"：单点、快照语义、零新状态；两个已声明损失：结算与注入间崩溃跳过本次恢复、存量会话不追溯）。
- B7 `as any`×3 移除；`provider()` 恢复早返回（AGENTS.md 风格），共享段改由 `systemSections()` 在唯一 caller 追加。
- B8 SDK 类型再生成（diff 恰好 restoration 四字段）。
- B9 三处调试输出删除。

**C 组（流程）**
- C10 四个新契约子计划补 10 节 expectations.md（均带"事后补抽、§6.2 违例"时序声明）。
- C11 fast-check 4.8.0 devDep + 四组固定 seed PBT（summarize 头尾/界、grep 窗口不重不漏、renderMaterials 预算/幂等、MCP 投影恰一次）。

**D 组（设计）**
- D13 "When to delegate" 处方行撤回（#59 原则：描述只讲机件不开处方）；wire 测试改负向断言；研究决策表记录再推翻。
- D14 运行中后台 shell 计入 `hasLiveDescendant`（#53 停机语义）。**初版自指 bug**：`metadata.sessionId === id` 把子 agent 自己的委派 job（同形状）也命中，所有子 agent 永不向父报告——既有测试当场抓红，`bfc7f75` 基线验证非既有失败；修法：自体侧只计 `type === "shell"`。

**E 组**：Windows PowerShell 退出码折叠为独立缺陷（`core/shell.ts` `-Command` 折叠原生非零码），按 §7 另开分支修，不合入本 PR。

**§6.5 路径 B 独立审（四 subagent 并行）**：产出 4 份报告（/tmp/audit-*.report）。prompt-1：0 critical，契约文档清扫（B7 后 I1 论证失效等 5 处残留）；comprec-1：0 critical，4 ⚠️ 全部为文档↔实现口径漂移（B5 字段、预算计数、Not restored 归节）；grepext-1：4 ❌（**files/count 越界 total 恒 0**、metadata.matches 含 context 行、空结果 metadata 硬编码默认值、offset/head_limit 无 schema 约束）+ G5"逐字节"措辞与实现冲突；bgshell-1：**1 critical**（结算后 shell_output 把一切 completed 渲染成 "exit 0"——`process.exit(7)` 被报成功）+ kill 幂等违约、取消路条目泄漏、metadata 缺 task_id、描述缺重启说明。

**独立审修复**：grep 三处行为修复 + schema 约束 + 补非法表达式回归（原 commit 曾误称已含）；bgshell 五项修复（settle 输出带 status 行、`Effect.ensuring` 清理、kill 幂等快照应答、metadata 补齐、tail_lines PositiveInt）+ 新增 3 测试；两份契约文档与两份 expectations 按实现口径修订并标注。

## 追加：reviewer 二轮（2026-10-20 晚，#77 交互防御）

reviewer 带 issue #77（fermat 长 run 实测：摘要重试挂错消息 → 压缩不生效反复触发）回来，指出与本 PR 恢复逻辑的交互：恢复取最新标记、不查摘要是否完成，压缩未生效时恢复块会叠在完整历史上。核实属实（`prompt.ts:1301` 用 `lastUser.id`、`filterCompacted:551` 只认完成摘要、`restoration.ts` 扫描无摘要检查）。按 reviewer 划界只在本 PR 做"标记必须已结算"判断（commit `eef5174bb1`）：谓词与 `filterCompacted`/`completedCompactions` 同款（summary && finish && !error 且 parentID 指向标记），同时覆盖尾保留与全量摘要两种结算形态——**第一版用 `tail_start_id` 判断是错的**：全量摘要回退路径的 `tail_start_id` 就是 undefined，GAP-1 测试当场抓红。#77 其余三项（摘要 parentID 锚定、失败摘要排除、TUI 读数）另开 PR。

## 实施插曲（教训）

1. **D14 自指 bug 是本轮最有价值的失败**：扩展一个"计数活后代"的谓词时，"会话自身的 job 也匹配该形状"这种自指只有既有行为测试能抓——单元级的 hasLiveDescendant 根本不存在。回归断言的覆盖面要按"谁会被这个改动改变行为"来选，不是按新函数选。
2. **审核意见也要核实**：B5 的修法（filepath 字段）如果照抄，会把死分支固化成"看起来修好了"。数据形状的真理在写入侧代码，不在意见里。
3. **PBT 写作被自己抓两次**：tail 长度推导（marker 内数字位数可变）、子串计数（`"false"` ⊂ `{"":false}`）——性质测试的 oracle 本身要先被证明，否则是在测想象中的实现。
4. **独立审有实证捕获力**：bgshell 的 critical（exit-0 伪造）是 A3 修复（结算删条目）与既有回退分支的组合缺陷——每个改动单独看测试都绿，组合起来主读径数据错误。两处审核（reviewer + subagent）合计抓出 5 个"测试全绿但契约违约"的实例，验证了 workflow §6 的双验证设计。
5. **共享机并发协作的坑**：一个 subagent 审核员 stash/pop 时弹走了并发会话的 stash；另一审核员在未提交改动上跑出假失败。多 agent 并行审核前先冻结工作树（commit 或 stash 全部），审核只对已提交基线跑。

## 验证

- 定向：shell 23/23、shell-background 11/11、grep 16/16、registry 16/16、restoration 8/8、compaction 69（1 skip）/0 fail、prompt 定向全过、core 全量 1102/1102。
- 全套回归（2026-10-20，HEAD `22377e6c`）：core 1102/1102 全绿；opencode 3983 pass / 16 fail。16 个失败逐个核实为环境性：①`httpapi-listen` 6 个 + `session HttpApi` 4 个 + `pty bridge` 1 个 + `concurrent loop callers` 1 个——共享机代理（Bun 进程启动时捕获，2026-10-13 隔离日志的同型问题：当时只精确 skip 了 real-listener 一条，其余走真实 TCP listener 的 PTY 变体在代理+高负载下超时 5s 上限；dev 基线 stash 验证同样失败、单跑同样失败、去代理变量进程级启动也失败——`no_proxy` preload 对真实 listener 路径不够）②其余 4 个为 prompt.test 负载贴限类（独立审核员已在 dev 基线复现同样失败）。本分支改动文件（shell/grep/ripgrep/prompt/restoration）定向全绿。
- 双包 typecheck 干净。

## 度量

| 指标           | 数值                                        |
| -------------- | ------------------------------------------- |
| 新增代码行数   | ~700（含测试 ~450、PBT ~330、docs 其余）    |
| 修改代码行数   | ~120                                        |
| 删除代码行数   | ~60                                         |
| 涉及文件数     | ~25 + 4 审计目录 + 本日志                   |
| 新增测试用例数 | 11（grep 3 + bgshell 5 + PBT 8 性质打包 4 文件 + registry 1） |
| 测试通过率     | 定向 100%；全套见 CI                        |
| 发现 bug 数    | 8（D14 自指、B5 死分支、grep×4、bgshell critical 1 + kill 幂等 + 泄漏） |
| 修复 bug 数    | 8                                           |
| 迭代轮次       | 实现 3 轮（A/B 批次、D14 回归、独立审修复） |

## 经验教训

（回写 CLAUDE.md 的条目见本地文件；要点：审核意见需核实后再动手；谓词扩展的自指风险只有行为回归能兜底；组合缺陷在单点测试全绿时只能靠契约对照审发现。）
