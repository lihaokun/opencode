# PR89 完整范围与 dev 整合检查

基线：PR #89 `cbd60a1f82`；目标 dev `b999dd248f`（含 #97）。合并工作先审原 PR 范围，再处理文本冲突与行为兼容。

## 1. 原修改范围

12 个文件：4 个生产文件、4 个测试文件、1 个查询基准脚本、3 份文档。

- `effect/runner.ts`：idle 通知移入临界区，隔离通知与续跑谓词的 defect。
- `session/run-state.ts`：Runner 不随 idle 删除，同一个 Instance 内按 Session 复用。
- `session/message-v2.ts`：新增按持久化时间/ID 查询的 latestRole。
- `session/prompt.ts`：换用该谓词，并加本循环 assistant 归属守卫。

检查了真实 loop/shell 调用点：onInterrupt 均调用 lastAssistant(sessionID)，shouldReArm 均按 Session 查询，不捕获旧 run 的结果。现有事件消费者没有在 idle 通知中同步重入同一个 Runner；插件 event 回调异步派发。

## 2. 审查发现与复现

- 新旧谓词对合法的自定义 Unicode ID 不总等价。同一时间的 user `msg_\uE000` 与 assistant `msg_\u{10000}`，旧谓词 true，新查询 false。SQL UTF-8 序和 JS UTF-16 序在非 BMP 字符处不同；MessageID schema 接受这两种 ID。真实 Session/SQLite 探针确认失败。
- Runner PBT 的 `!Deferred.isDone(...)` 对 Effect 对象取反，慢通知门不生效；操作又逐个等待，标题宣称的并发/join 覆盖并未实现。定向测试仍有价值，但不能用这份 PBT 证明这些性质。
- latestRole PBT 只写一次 `m.json ?? m.t`，持久化列与 JSON 实际相同；预期却按 m.t 计算，且只在全部样本末尾断言一次。需真正制造时间不一致，并逐步检查。
- 查询基准脚本的 tmpdir 只隔离项目，不隔离全局数据库。直接运行脚本不能保证使用临时数据库，必须增加显式内存库保护。

## 3. 参考语义与 #97 交互

以现有 compareChronology 为兼容参照。filterCompacted 保留最新消息，故有效消息域的最大角色可用于原谓词；自定义字符的同时间排序必须保留原行为。

#97 的 cancel 返回 StateTag、work 内 run 归属与窗口、stop hook、重复计数均须保留。Runner 生命周期复用不等于复用 work：每次新 loop 仍有独立 work，普通 re-arm 才复用同一 work。

“单 Runner”不禁止取消后的旧清理与新执行重叠：cancel 仍先释放执行槽，再等待旧 fiber 收尾。该路径沿用 #97 的 own 检查保护新 run 记录；本修复消除的是删表造成的重复活跃 Runner。

## 4. 整合与修正方案

- prompt.ts 冲突是同一位置新增状态：保留 #97 的重复计数、stop hook 与 viewState，同时保留 #89 的 ownAssistants；检查自动合并保留 cancel 返回值。
- latestRole 普通索引查询不变；仅当 SQL 候选 ID 含 UTF-16 代理字符时，复用原有 filtered-history 判定，保留 JS ID 比较和压缩边界；这条罕见兼容路径保留旧扫描成本。
- 补真正的受控并发/idle 门测试，保留故障隔离检查；随机历史每次写入即对照，并通过更新同一 ID 的 JSON 时间制造真实列/JSON 不一致。
- 基准脚本要求显式 OPENCODE_DB=:memory:，避免误写用户默认数据库；性能报告明确是 SQLite 查询基准。

## 5. 正确性与范围

时间不同先比较时间；同时间时，普通生成 ID 的 SQL 序与 JS 序相同。排序差异只可能让含代理字符的 SQL 最大候选被 JS 序推翻；该候选直接回退原判定，避免遗漏压缩过滤。正常 ID 仍只读一行；特殊 ID 保留旧历史扫描成本。

Runner 状态机转换、Session 取消范围、#97 的返回值/报告/窗口语义不另行改写。额外生产修正仅限 latestRole 的兼容边界。

## 6. 验证清单

| 项目 | 状态 |
| --- | --- |
| 原 PR 定向测试与 Unicode 探针 | 65 pass / 1 fail；失败为新增兼容性探针 |
| Runner/Session 回调生命周期、并发、取消、shell、re-arm | 定向通过；删表与锁外 idle 变异均失败 |
| latestRole 时间/ID/JSON/压缩后等价及查询成本 | 64 pass；包含 Unicode 与完成压缩同时间的组合 |
| #97 run 记录、停止通知、窗口、stop hook 回归 | 定向 12 pass；完整模块结果见下方 |
| typecheck、模块回归、变异验证 | typecheck 通过；四类变异失败；完整模块 920 pass / 1 超时，单跑通过 |

## 7. 代码清单

冲突处理：prompt.ts。必要修正：message-v2.ts、Runner/Session 测试、messages-pagination 测试、查询基准脚本。整合在隔离副本完成，验证后更新 PR，由 CI 确认后合入 dev。

## 8. 文档同步

更新 #89 修正说明中的等价性、PBT 与基准隔离表述；补充本页真实验证结果。若 #97 承重前提受影响，同步其子计划说明。PR 描述以最新 dev 的整合结果为准。

### 五维度核对

| 维度 | 结论 |
| --- | --- |
| 一致性 | cancel 的四种 StateTag、work 与 Runner 的不同生命周期、#97 的窗口/停止钩子均保留；单行查询的特殊 ID 例外已写明 |
| 正确性 | 修复了已复现的 Unicode 判定差异；压缩边界由原过滤流程保留；join、取消与 idle 顺序有真实门及负向验证 |
| 性能 | 普通 ID 不加载历史/parts；特殊 ID 使用旧路径；Runner map 按 Instance 处理过的 Session 数增长，不随 run 次数增长 |
| 风格 | 修正集中在原四个生产模块；无新增 runtime 依赖或公共参数；测试中的无效模型/假门已替换 |
| 可维护性 | PBT 逐步验证实际持久化数据；基准需显式内存库；前文历史验证声明以本次整合记录为准 |

### 验证补充

- 在隔离副本先验证原 PR：65 pass，新加 Unicode 兼容性探针失败；修后通过。
- 仅按同时间组比较还不足以保留旧语义：完成压缩的同时间边界可能已裁掉某条用户消息。新增组合回归在这一中间方案下失败，因此最终特殊 ID 路径复用原有过滤流程；64 条 pagination 测试全部通过。
- 删除 Runner 缓存、恢复锁外 idle、取消 Unicode 兼容、禁用非本循环 assistant 守卫，四个独立变异分别触发对应测试失败。Session 级 idle 测试额外检查通知未完成时 assertNotBusy 仍拒绝，避免仅观察排队 work 的调度而使测试空转。
- 基准脚本未显式设置内存库时立即拒绝；在隔离环境的 20k 消息测量为旧读取 1668 ms、新读取 2.822 ms。此为普通 ID 查询基准，不代表特殊 ID 回退路径或整轮模型执行。
- 最终 `test/session test/effect test/agent-management`：920 pass / 7 skip / 1 todo / 1 fail，929 tests、39 files、27433 个断言，922.22 s。唯一失败为既有 `shell rejects when another shell is already running` 的 30 s 用例超时；原预算单跑 1 pass / 0 fail，6.16 s。失败计数保留，不写成完整套件全绿。
- `bun typecheck`（packages/opencode）、`git diff --check` 通过。相对目标 dev 的生产改动仍只有原四个文件，无 runtime 依赖、协议或数据库迁移变更。
