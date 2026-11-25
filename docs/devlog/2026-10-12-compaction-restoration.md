# 开发日志 — P1 压缩后恢复实施

日期：2026-10-12
分支：`issue-46-runtime-alignment`
提交：`edab3d9882`
关联：issue #46、`docs/design/compaction-recovery/architecture.md` 与 `detailed-design.md`、调研文档 §7 决议 #10-11

## 做了什么

按已确认的架构与细化设计实施压缩后恢复：

1. **新模块 `session/restoration.ts`**：`buildTailText`（tail 基线重建）、`collectCandidates`（read/edit/skill part 扫描 + todo，按最近使用排序）、`materializeCandidates`（磁盘重读、stat 超限守卫、tail 同版本去重、四分支处置）、`renderMaterials`（预算裁剪 + 三节 markdown + 降级引用行）、`apply`（幂等编排，错误全吸收）。
2. **装配**：prompt.ts 在 `applyAgentRoster` 之后一行调用；config schema 新增 `compaction.restoration.{enabled,max_files,file_max_tokens,budget_tokens}`。
3. **测试 6 个**：buildTailText / collectCandidates / materialize（临时目录真读盘四分支）/ render（预算 + max_files + 空 → undefined）/ apply 幂等（两次调用恰一份 sentinel part）/ 恢复 part 模型可见性（`toModelMessagesEffect` 含哨兵）。

## 关键决策与理由

- **依赖通道用 Interface 而非 Service 类**：effect v4 beta 的 `Effect.serviceOption(Tag)` 产出 Interface 形状（typecheck 实证），deps 按接口类型声明。
- **全量实施中自纠的测试设计错误**：幂等测试首版把工具 output 设成与磁盘文件相同 → tail 比对命中 → 全 skip → 无 part（机制正确工作，fixture 设计错）——改为 output 与磁盘内容不同后转绿。
- 基线归因：全量 11 项失败经 stash 基线复跑确认全部既有（cf-gateway×4、HttpApi SDK×4、oauth-callback、write umask 直接复现；messages-endpoint 超时簇成员漂移、基线同败），**P1 改动零新增失败**。

## 测试

- restoration.test.ts 6/6；core 1102/1102（config schema 变更后）；opencode 全套 3979 项中 11 项失败全部基线既有；双包 typecheck 干净。

## 待办

- prompt-unification（P1 第二项）设计流程。
- follow-up 不变：V2 摘要丢 structured；全文 7 天保留期；基线既有的 11 项环境敏感/超时失败待单独排查（本轮已留完整失败名单）。

## 度量

| 指标           | 数值                                                     |
| -------------- | -------------------------------------------------------- |
| 新增代码行数   | ~618（模块 ~300 + 测试 ~285 + config ~18 + prompt ~6）   |
| 修改代码行数   | ~18                                                      |
| 删除代码行数   | 0                                                        |
| 涉及文件数     | 4（代码/测试）+ 1（本日志）                              |
| 新增测试用例数 | 6                                                        |
| 测试通过率     | restoration 6/6；core 1102/1102；全套 11 项失败均为基线既有 |
| 发现 bug 数    | 1（产品缺陷 P1 本身，本轮修复）+ 11 项基线既有失败归档   |
| 修复 bug 数    | 1                                                        |
| 迭代轮次       | 实现 1 轮（4 次类型/fixture 小修，均测试或 typecheck 指出）|

## 经验教训

- **effect v4 beta 的 serviceOption 产出 Interface 形状而非 Service 类**：deps 依赖按 Interface 类型声明才能与 serviceOption 对齐；Service 类只作 Tag/构造入口（`Service.of(Interface)`）。
- **fixture 反向设计可以验证机制**：幂等测试首版"错误地"让文件内容与工具 output 相同，恰好触发 tail 去重分支、验证了机制在工作——测试失败时先读失败语义，它可能在告诉你实现（或 fixture）哪一侧是对的。
- **全量失败归因必须 stash 基线复跑**：11 项失败若无基线复跑佐证，仅凭"模块不相干"归因不满足规范；基线复跑同时把 9 项直接复现与 2 项漂移成员（超时簇）区分开。
