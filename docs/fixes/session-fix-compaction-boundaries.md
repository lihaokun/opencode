# #86 压缩边界与失败摘要投影修复

基线：`eaf99cfb`（原 #86 合入 dev `7bd8532a`）。用户已授权按 workflow 修复并完善 PBT。范围为 legacy Session 压缩；不改公开 API、数据库 schema、V2、模型预算或 Runner 调度。

## 一、现象与复现

1. 普通压缩失败/取消后，新 user 到来，重试摘要的 parent 虽然正确指向旧 marker，但 tail 可能选为 marker 后的新 user，成功后完整旧历史仍进入下一请求。
   - 最小轨迹：`oldUser, oldAssistant, marker, failedSummary, lateUser`；`auto=true`、无 overflow、`tail_turns=1`。现实现写入 `marker.tail_start_id=lateUser.id`。
2. 旧 marker 的 tail 起点是失败摘要 F 时，`filterCompacted` 在检查边界前跳过 F，旧 prefix 回流且重排失效。
   - 最小轨迹：`oldUser, F, retainedUser, marker(tail=F), settledSummary`；预期 `marker, settledSummary, retainedUser`。
3. 新旧摘要之间的晚到消息不属于待摘要内容；模型布局应是 marker、成功摘要、保留尾部、晚到消息。失败摘要只能从模型投影消失，不能删除 durable transcript。

出错链：`prompt.runLoop → latest.tasks → compaction.process/select → marker.tail_start_id → filterCompacted → model request`。两条主反例已有真实 process 与纯投影探针；本轮固化到仓库测试。

## 二、根因

- `process` 只在 marker 恰好是最后一条消息时去掉 marker，非 overflow 重试将 marker 后的新输入一起送入 tail selection。消费者却只向 marker 之前寻找 tail。
- 内容过滤和持久边界解释混在同一条 `continue` 中，隐藏内容同时隐藏了截断点。
- 重排通过最后一个带 tail 的 marker 再猜边界，会被后面的未结算 marker 干扰；把 marker 到 summary 之间整段作为摘要块，还会把晚到消息放在摘要之前。
- 重试选择不保留尾部时，旧代码仅在新 tail 非空时更新 marker，可能留下上次失败尝试的 stale tail。

## 三、参考对照

以仓库旧的持久边界语义和 Issue #77 的独立区间模型为参照，不引入外部调度算法：

- 旧实现遇到 tail=F 会在 F 停止，因此不会带回更早历史；新实现应保留这个边界效果，只隐藏 F 正文。
- 对普通重试，将输入分为 `[marker 前模型历史] + [marker] + [晚到输入]`；只有第一段参与摘要与 tail 选择。overflow 在这一边界内继续按既有 replay 规则剥离当前 turn。
- 投影 oracle 从生成事件的显式 prefix/tail/marker/late 分区构造 expected，不复制生产的逆序扫描算法。

## 四、修复方案与契约

### C1：任务宿主与摘要范围

- `parentID` 保持 `task.message.id`。
- 有 compaction part 的 parent：摘要/尾部只处理输入投影中该 marker 之前的部分；没有 marker 的既有直接 process 调用保持原语义。
- overflow 的 replay 搜索仍限于 marker 前，fallback 也回到 marker 前的历史。
- 重试将选定 tail（包括 undefined）写回 marker，使其与此次摘要使用的范围一致。

### C2：边界先于内容过滤

- 先在完整消息上按现有逆序语义找最新已结算 marker，并到持久化 tail 截止；失败/未完成摘要不结算 marker，但仍可承载已有 tail 边界。
- 只对该实际结算的 marker 重排：`marker, settledSummary, retainedTail, laterMessages`。新到但未结算的 marker 作为 laterMessages 保留，不能代替已结算边界。
- 重排完成后才剔除 `summary && (!finish || error)`。普通助手不受此规则影响。输入消息与数据库记录不变。
- chronology 继续由持久时间与 ID 二元组定义，模型布局不成为 durable 时序。

### C3：执行与测试边界

- 保留原有错误退出、显式恢复、overflow replay、auto/manual、Runner 与 stop-hook 语义。
- 所有失败后的模型请求，包括摘要请求，都不得含失败正文/推理；失败记录仍在 durable transcript。
- 用 provider request / partial persisted / run completed 等信号控制时机，不用任意 sleep 证明第二 run 已启动。

## 五、正确性论证

- C1 使新写 tail 来自 marker 前的有限区间，消费者沿逆序必然能遇到它；晚到消息既不参与摘要，也不会被该边界删除。无 tail 的重试清除旧值，避免两次尝试范围混用。
- C2 将持久边界识别放在内容过滤之前，因此无论起点内容是否可见，截断位置不变。显式记住所选 marker 避免 pending marker 改写布局；只搬移 marker 与成功摘要，尾部和晚到输入的各自顺序保持。
- 最后一次纯 filter 不修改输入对象，因此 durable 历史完整；成功摘要仍需 finish、无 error、parent 匹配，不扩大“结算”定义。
- 常规无压缩历史仍保持顺序，只去掉不可见摘要；新实现保持线性扫描/过滤。公开接口、服务 ownership、预算、TUI 功能范围均不变。

## 六、测试结果

| 类型 | 覆盖 | 结果 |
|---|---|---|
| 固定回归 | 普通重试+late；失败/取消/未完成摘要 tail | 修复前 RED、修复后 GREEN |
| 固定边界 | pending marker、late 顺序、清空 stale tail、单用户 overflow fallback、普通错误助手 | 已补并通过 |
| 投影 PBT | Effect 自带 FastCheck，独立区间 oracle，输入不变 | 200 条轨迹、477 个周期、15 种状态×tail 组合；支持 seed/path 与 shrink |
| 真实执行属性 | 8 个种子的 ordinary/overflow、成功/失败/取消、随机用户插入 | 8 pass；逐次检查摘要 head/current/late、全部请求失败正文/推理及 durable 保留 |
| 原 #77 端测 | 取消前确认收到部分正文/推理；真实完成边界 | 2 pass；PartDelta 是流式接收信号，完成/取消后才断言内容持久化 |
| 变异验证 | 错 parent、泄漏失败内容、提前过滤、越过 marker、stale tail、late 顺序、错误 fallback | 7 类错误均被断言检出；另一次 FastCheck 变异经 4 次 shrink 得到单周期 failed-tail 反例 |
| 完整集成 | compaction/message/prompt/run-state/Runner/step-tail | 406 pass、2 skip、1 超时；后续只增强测试，追加定向 8 pass、wire 8 pass |
| TUI / 类型 | 既有 TUI 用量与列表；opencode package typecheck | TUI 38 pass；typecheck 通过 |
| 独立审核 | 契约+diff 路径 B、PBT、完整 runtime | 三路通过，无剩余阻塞；runtime 独立探针 4,800 项检查通过 |

投影属性接收有序输入，不声称验证数据库同毫秒排序。该职责由既有 messages-pagination 的持久时序、同时间和回绕回归/属性继续承担。FastCheck 从已有 `effect/testing` 导入，没有新增依赖。

独立复核要求的逐次摘要范围、单用户 overflow fallback、普通失败助手对照均已补齐。初轮测试里等待“流式文字已落盘”的错误前提已修正：用真实 PartDelta 确认收到部分输出，取消/结束后再断言持久正文与推理；没有放宽测试目的。

唯一完整套件失败是既有 `MessageV2.latestRole > stays fast on a large session` 的 30 秒总超时（包含插入 2,000 条 fixture 消息）。未修改基线 `eaf99cfb` 同样超时；修复版本单独复跑曾在 29.55 秒通过，索引查询的 500ms 断言保持。早一轮取消 backoff 的 250ms 断言出现 260ms，最终完整套件已通过。未扩大超时或改动上述既有测试，因此不宣称全套零失败。

本轮按 §7 bug fix 流程实施，并采用 §6.5 独立方法；不是新 feature/subplan。审核报告见交付记录，CI 由推送后的提交运行。

## 七、代码更新清单

| 文件 | 改动 | 状态 |
|---|---|---|
| session/compaction.ts | marker 前范围、overflow fallback、同步清空 stale tail | 已实施：`1c35bc01` |
| session/message-v2.ts | 实际边界定位、模型重排、最后过滤失败摘要 | 已实施：`1c35bc01` |
| test/session 下相关测试 | 固定回归、FastCheck 投影属性、真实执行轨迹与全 wire oracle | 已实施并验证：`1c35bc01` |

## 八、文档更新清单

| 文档 | 改动 | 状态 |
|---|---|---|
| 本文 | 契约、论证、测试、独立审核与基线超时说明 | 已完成 |
| docs/devlog/2026-10-27-issue77-compaction-summary-anchor.md | 新修复链接、过滤时机、TUI 旧用量回退说明 | 已完成 |
| /tmp/pr86-fix-delivery-2026-11-02.md | 审核、验证、提交和 CI 状态 | 交付报告单独保存 |

本次修复补足既有 #77 契约，不迁移或矫正旧数据，不扩大到其它已延期功能。
