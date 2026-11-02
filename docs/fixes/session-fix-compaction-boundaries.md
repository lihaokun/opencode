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

## 追加修复：摘要锚点与执行配置分离（2026-11-02）

本轮基线 `76bb54cc`；在已有边界修复上补齐执行配置回归，按用户授权完成实现与验证。

### 一、现象与复现

`Build/model A → 自动摘要输出部分正文/推理 → cancel → Plan/model B 新输入 → retry`：摘要 parent 正确落在旧 marker，但摘要和后续普通请求仍使用 A，最终 assistant 又成为 Build。真实回归扩展 `prompt.test.ts` 的 cancelled-summary 用例，同时断言三次 wire model、最终 agent/variant、失败输出隔离与旧 marker 锚点。

### 二、根因

`processCompaction` 将 `parent.info` 同时当作历史边界和执行配置。修复 #77 的 parent 后，最新输入的配置也意外变回 marker 的旧配置。overflow 从 replay 原始 user 复制配置存在同类问题；仅传入最新 user 也不足以处理摘要流式输出期间新到的配置。

### 三、参考对照

参照既有 `prompt.runLoop` 每轮按 `MessageV2.latest(msgs).user` 解析 model/agent 的契约，以及 stop-hook continuation 保留 system/tools 的实现。原 dev 用 latest user 作 parent，虽有锚点错误，却在取消→切换→重试路径保持 Plan/B；本次保留 #77 的正确 parent，单独恢复该执行配置行为。`MessageV2.latest` 根据持久时间与 ID 比较，不能用模型投影的数组末位替代。

### 四、修复方案与不变量 C4

- 摘要 `parentID`、head/tail、overflow replay 内容仍由 marker 前区间决定，保持 C1–C3。
- 摘要执行配置来自调用快照内最新 user，显式 compaction agent model 继续优先于该 user model；variant 沿用最新 user model.variant，遵守既有 LLM variant 合并规则。
- 自动续写前重新读取持久最新 user；普通 continuation 和 overflow replay 的 agent/model/variant、system/tools/format 均不能覆盖回旧 marker/replay 配置。没有较新输入时，overflow 保留原 replay 的完整配置。
- 摘要期间新增 user 不改变已发出的摘要请求或摘要范围，但决定之后的续写配置。普通 autocontinue 插件接收摘要完成时的当前选择；插件运行后再读取一次，避免插件等待期间新增输入被覆盖。
- 不改公开 Protocol/HttpApi、schema、V2、Runner、停止/重试语义。

字段来源（`U0` 是调用快照中按持久 chronology 最新的 user；`U1` 是摘要完成时最新的持久 user；`U2` 是 autocontinue 插件返回后重新读取的最新 user；`R` 是 marker 前的 overflow replay user）：

| 字段/用途 | 来源 |
|---|---|
| summary.parentID / head / tail_start_id | marker ID / marker 前历史区间，完全不取 U0/U1/U2 的 ID 作锚点 |
| summary model/provider | `compaction` agent 显式 model 优先，否则 U0.model；不使用会话 agent 的默认模型覆盖显式选择 |
| summary variant / LLM user.system | U0.model.variant / U0.system；专用模型下仍按现有 LLM variant 合并规则，不新增 compaction agent.variant 优先级 |
| summary agent / tools / format | 始终 compaction agent / 空工具集合；U0 的 format 不改变摘要纯文本协议 |
| ordinary autocontinue 插件输入 | U1.agent / U1.model / U1 全消息；插件 enabled 语义不变 |
| ordinary continuation agent/model/variant/system/tools/format | U2 对应字段；undefined 保持 undefined，不从旧 marker 补回 |
| overflow replay 内容/附件 | R.parts，原有媒体转文字占位规则不变 |
| overflow continuation agent/model/variant/system/tools/format | U1 比 marker 更新时完整取 U1；仍是 marker 时完整取 R，保持无新输入时原 replay 配置 |
| manual（auto=false） | 只产生摘要，不新增 continuation/replay |

读取复用 `Session.findMessage` 的 50 条分页早停；只在 SQLite 排序选出的最新 user ID 含 UTF-16 surrogate 时回退全历史 `MessageV2.latest`（与现有 latestRole 的 Unicode 防护一致）。因此常见生成 ID 不重复扫描长会话，Unicode 边界保持既有 `(time,id)` JS chronology。

这些读取建立在已有单 Session Runner 所有权上，不新增排队、锁或原子写事务；不声称解决任意外部写入与 continuation 持久化同时交错的竞态。

### 五、正确性论证

边界与配置分别取值，修改配置不能改变摘要父子关系或 head/tail。每次摘要请求只使用一个已确定的配置快照，结束后重新取值使运行期间的新输入影响下一请求。续写复制同一 user 的配置字段，防止 agent/model 与 system/tools/format 拼接成不一致配置。overflow 重放保持原内容及附件降级，只有被新输入明确替换的执行配置变化。无较新输入的 replay 保持既有行为。

### 六、测试清单

| 类型 | 用例 | 状态 |
|---|---|---|
| 回归 | 真实取消部分输出→Plan/B/variant→retry，wire 与最终 agent | RED：三次请求均 A；GREEN：A/B/B，最终 Plan/B/careful，失败正文/推理隔离不变 |
| 新增 | ordinary/overflow × 输入在摘要前/中变化 × compaction 专用模型；system/tools/format/variant | 两组 FastCheck wire 用例通过，含真实 reasoning_effort |
| 新增 | 插件 await 期间换配置；Unicode 同毫秒 chronology；无新输入 overflow 保留与 marker 不同的 R 配置 | 三个 service 边界用例通过；R 包含 JSON schema/retryCount、system/tools/variant |
| 属性 | 生成不同 agent/model/variant/用户字段/到达时机，检查范围与执行配置独立 | 两组 FastCheck，seed=86079、各 numRuns=12，含 ordinary/overflow × before/during 固定 examples；原 8 种子取消/length/retry 轨迹也加入配置变更并通过 |
| 回归集 | compaction、投影、message-v2/pagination、prompt、Runner/run-state/step-tail | 8 文件完整集：412 pass、2 skip（既有 V2 projector disabled）、0 fail，11,445 断言；复审追加 R 回退边界单跑 1 pass/8 断言 |
| 静态 | opencode package `bun typecheck`；diff whitespace | 全部通过 |

验证命令在 `packages/opencode` 执行：`bun test --timeout 30000` 加上述 8 个相关测试文件，以及复审新增 `keeps the replay configuration` 单例。日志为 `/tmp/pr86-config-full-final.log`、`/tmp/pr86-config-replay-boundary.log`、`/tmp/pr86-config-typecheck-final.log`；取消配置回归的 RED/GREEN 为 `/tmp/pr86-config-red.log` / `/tmp/pr86-config-green.log`。

失败分析：早期新增 fixture 直接传 plain output format，违反既有 Schema.Class 输入要求，已改为类实例；持久化省略 undefined variant，因此用字段读取后的严格 `toBe` 比较验证其缺省值。增强原 8 种子时，system 字段误复用了 late 正文 sentinel，导致正文隔离断言在合法 system 配置中匹配；改为独立生成的配置 sentinel，原正文隔离断言未改。首次完整命令误漏 package 标准 `--timeout 30000`，在大历史 fixture 的 Bun 默认 5 秒限额失败后停止；最终标准命令该 fixture 26.5 秒通过，索引查询 500ms 断言未放宽。其余最终验证无失败。

独立复审补充了无新输入 overflow 的 R≠marker 配置用例，并要求分页读取的 Unicode chronology 对照；两项都已落实。主 agent 负责最终独立审核和推送，本轮未 push、merge 或发送 GitHub 评论。

### 七、代码更新清单

| 文件 | 改动 | 状态 |
|---|---|---|
| `src/session/compaction.ts` | 分开历史锚点、摘要配置、续写配置；分页读取与 Unicode 回退 | `39987659` |
| `test/session/prompt.test.ts` | 取消真实回归、配置属性与时序边界 | `39987659` |
| `test/session/compaction.test.ts` | 插件 await、Unicode chronology、无新输入 R 配置回退 | `39987659` |

### 八、文档更新清单

| 文档 | 改动 | 状态 |
|---|---|---|
| 本文追加部分 | C4、根因、验证与限制 | 已完成；实现提交 `39987659` |
| `docs/devlog/2026-10-27-issue77-compaction-summary-anchor.md` | 补充执行配置与边界分离说明 | 已完成 |
