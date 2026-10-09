# 评估 — 是否用 ZCode 全面替换 opencode fork

> 状态：**评估稿**（结论为倾向，非决定）。
> 日期：2026-10-09。fork 基线：`dev@1343833857`；ZCode 基线：`zai-org/ZCode` v3.14.3（浅克隆核查，commit 2026-09-24）。
> 关联：`docs/research/runtime-alignment-research.md`（issue #46 调研，本文是其"对照 ZCode"部分的展开与替换决策分析）。
> 方法：fork 侧以 closed issues / merged PRs 清单为准（15 closed issues + 19 merged PRs）；ZCode 侧为只读源码核查（三路专项：流处理健壮性、会话循环健壮性、工具/子代理/MCP/压缩能力），全部结论附 file:line 证据。未运行任何端到端对照实验。

---

## 1. 要回答的问题与结论

**问题**：fork 在 opencode 上已经积累了 24 个修复点和一套自有特性（异步 agent-management 等），而 ZCode（Z.ai 的 coding harness）在 issue #46 的对照中显示出多方面的领先。是否应该放弃 fork，全面切换到 ZCode？

**结论（倾向）：不全面替换。** 开发路线维持 fork，把 ZCode 用作参照实现（issue #46 本身就是这条路线的展开）；使用策略上可以并行——ZCode 直接作为 GLM 模型的日常工具，fork 继续做通用 harness。唯一支持全面替换的情形：团队明确放弃"维护者"角色、主力模型锁定 GLM、并接受以私有 patch 追投放仓库的长期模式。这三个前提与过去一年的实际工作方式相反。

这个结论建立在三个支柱事实上，§2/§3/§5 分别展开：

1. **ZCode 是投放式的厂商仓库**（issue 跟踪关闭、无贡献指南、无细粒度历史）——切换后我们与代码库的关系从"贡献者"退化为"私改者"，而"能修 bug 并随上游分发"恰恰是 fork 一年来的核心工作方式与价值来源。
2. **fork 修复的问题在 ZCode 大部分不存在，但 ZCode 也有 fork 更强的领域**（有界周期 doom-loop、内容过滤分类、发送前预检）——切换不是单纯升级，而是资产互换，且互换后我们失去让修复被任何人复用的通道。
3. **ZCode 与 opencode 无代码血缘**——替换是换产品而非换分支：会话存储、配置、插件 API、TUI、CI、工作流文档体系全部重来，24 个修复一个也带不走。

---

## 2. ZCode 是什么：身世、治理与产品形态

### 2.1 身世：独立实现，不是 opencode 的衍生

GitHub 层面 `fork: false`。代码层面证据更硬：包管理器是 pnpm（opencode 系是 bun）；仓库结构是 `apps/zcode-cli` + `packages/{provider, services, rpc, client, server, ui, web, desktop}` + `harness/` + `config/`（opencode 系是 `packages/opencode` + `packages/core`）；会话存储在 `~/.zcode/cli/db/db.sqlite`；仓库内 "opencode" 字样只出现在第三方图标资源名里。**结论：完全独立的代码库。**

由此推出对"替换"性质的基本判断：这不是 `sync/upstream-dev` 那样的分支同步问题——是更换整个产品，包括数据格式、扩展 API 和我们绑定在代码形态上的全部工程实践。

### 2.2 治理：投放式的厂商仓库

| 事实 | 证据 | 对我们的含义 |
|---|---|---|
| issue 跟踪关闭 | `has_issues: false` | 别人踩过的坑不可见；我们发现 bug 无处报告 |
| 无 CONTRIBUTING、无细粒度历史 | 仓库缺失；唯一 release v3.14.3（2026-09-24），README 以"更新至 vX.Y.Z"逐条记录投放 | 无法 rebase 到具体历史；私有 patch 的维护成本高于有历史的 upstream |
| 功能不完全随源发布 | NOTICE.md §四："受第三方版权、许可及再分发条件等约束，不承诺提供官方产品的全部功能及活动政策" | 公开源码是官方产品的部分快照 |
| 第一方 Apache-2.0 | LICENSE / NOTICE | 许可本身宽松，不构成障碍；障碍在上一行 |

对照：opencode 的 upstream（anomalyco/opencode）是 MIT、21.2 万 stars、公开开发、评估当天（2026-10-09）仍有提交。fork 的全部工作流——提 issue、修 bug、随 sync 分发、`docs/workflow.md` 的契约审核体系——都建立在这种可参与的 upstream 之上。

### 2.3 模型绑定：GLM 生态的官方 harness

内置 provider 配置（`config/provider/zcode-builtin.json`）全部是 Z.ai Coding Plan / Z.ai API / GLM 全系模型；代码里有 GLM 专属的恢复路径（zcode-plan 业务码 3007-3010、BigModel `[1302]` 括号格式解析）。API 形状上它也支持 `anthropic-messages` / `openai-chat-completions` / `openai-responses` 三种协议接自定义端点（`packages/provider/src/config/provider-data-schema.ts:3-8`），所以**不是只能跑 GLM**——但专项适配的受益者只有 GLM。

这与 issue #46 的立场存在方向性张力：issue 明确"这是模型无关的通用改进，不是 GLM 专项适配"。今天主力模型是 GLM 时，ZCode 的专项是收益；换模型时收益归零、绑定照旧。

---

## 3. 问题级对照：fork 修过的问题，ZCode 里还存在吗？

### 3.1 核对方法

以 fork 的 closed issues / merged PRs 清单为基准，逐条在 ZCode 源码中寻找同类缺陷或同类机制。三路专项调查覆盖：流处理健壮性（#1/#3/#5/#7/#19/#8/#9）、会话循环健壮性（#11/#12/#13/#14/#20/#22/#32/#34）、工具与代理能力（#35/#44/#45/#47/#48 + issue #46 的 P0/P1 维度 + #10 的 patch 场景）。fork 的 open issues（#36/#51/#16/#6/#17/#18）除 #51 外未逐一核验（§6）。

### 3.2 ZCode 中不存在（且多数有更强实现）

| fork 修复 | ZCode 状态与证据 |
|---|---|
| #1/#3/#5 流截断被静默当成功；finish=length/unknown 报成"成功的空 subagent 结果" | 不存在。零输出/可疑空结果直接 throw（`model-errors.ts:67-79`、`turn-model-step.ts:525-547`）；subagent 失败显式 `status:"failed"` 上报（`subagent/runner.ts:395-424`）；流中断分层处理——adapter 层 idle 超时（`stream-idle-timeout.ts`）+ 非自然 EOF 强制收口（`runner-stream.ts:862-909`）+ core 层锚点恢复（`streaming-recovery.ts`） |
| #7/#19 按副作用状态恢复不完整流 | **同款设计且更完整**：无副作用→从锚点重开；已结算→结算+成对写入后续跑；未结算→按副作用状态合成 `not_executed` / `unknown_execution_state` 并告诫模型勿盲重试（`streaming-tool-coordinator.ts:156-217`、`streaming-tool-synthetic-result.ts:15-21`）。恢复锚点做成持久 session 事件可审计（`streaming-tool-ledger.ts:61-118`） |
| #8/#9 reasoning 逐 chunk 碎裂 | 不存在。core 按流 ID 合并块（`reasoning-stream.ts:5-28`），TUI 合并流式 thought part（`app-transcript-stream.ts:131-158`） |
| #11 GLM 超窗措辞不识别→压缩不触发 | 不存在。adapter 分类器的措辞表含智谱原句 `"range of input length should be"` 专门条目（`failure-inspection.ts:240`） |
| #13/#15 message ID wraparound | 结构性免疫。ID 为时间前缀+UUID（`contracts/src/interfaces/shared.ts:75-77`），无计数器回绕；排序不依赖 ID 字典序 |
| #32/#34 结束判定与 idle 转换竞态、需 re-arm | 架构性规避：常驻命令队列+入队即 drain（`runtime-command-queue.ts:23-35, 67-69`）、idle 判定单点化（`:100-109`）、residency 阻塞计数器（`residency.ts:5-19`）；同类竞态的历史修复直接写在注释里（`:82-86, 148-150`）。另有 `packages/formal-proof` 状态空间枚举包 |
| **issue #46 P0-1** shell 退出码不进模型正文 | **不存在**。非语义性非零退出正文首行 `Exit code N`（`bash-model-content.ts:50-61`）；语义性非错误白名单（grep/diff/test/find 的 exit 1 不当失败，`bash-semantics.ts:140-159`）；part 级还有 isError 标记（`tool-result.ts:67-81`） |
| **issue #46 P0-2** MCP structuredContent 丢失 | **不存在**。与 content 是否为空无关，structuredContent 非空即追加 `Structured content:` 块（`mcp/index.ts:362-383`） |
| **issue #46 P0-3** 摘要前对每结果取 2000 字符 | **不存在**。摘要请求直接复用完整 provider request messages（`compact-active-helpers.ts:53-66`），超窗才按轮次丢弃旧轮（最多 3 次，`compact-selection.ts:279-335`） |
| #10 openai-compatible patch 维护 | patch 无必要。原生三协议 + baseUrl + per-endpoint headers（`provider-data-schema.ts:3-8`、`model-execution.ts:302-310`） |
| #51 输出截断后无续做（open） | 大概率不存在。`length` 触发最多 3 次自动续写、prompt 针对 mid-thought 截断（`turn-output-token-continuation.ts:40-57`）；耗尽后抛结构化错误而非静默（`turn-model-step.ts:660-697`） |
| #44/#45、#47/#48 | 不适用（见 §4：ZCode 无原生 worktree、无 roster——问题连同能力一起不存在） |

### 3.3 ZCode 存在同型缺陷（fork 更强的领域）

| 问题 | ZCode 现状 | 证据 |
|---|---|---|
| **#20/#22 有界周期绕过 doom-loop 检测** | **存在同型缺陷**。检测是"相邻连续相等"的单签名 streak，A→B→A→B 每步归零永不触发；且只注入 warning 不硬停。代偿：累计工具调用预算 warning（对周期有效但不硬停） | `model-anomaly.ts:36-41`（streak 逻辑）、`:64-91`（预算 warning）、消费命令时 streak 清零（`turn-loop.ts:61-64`） |
| content_filter / 内容过滤分类 | 缺失。`ModelFailureReason` 枚举无对应值，落入 Unknown 或靠 provider 业务码路径兜底 | `contracts/src/model/index.ts:138-148` |
| #12/#14 发送前载荷估算 | **部分存在**。发送前只收敛 `max_output_tokens`（`contextWindow - 估算 - 1000`，`model-token-limits.ts:34`），不拒发；估算器为字符近似（`manual.ts:102-114`）。但恢复侧严格有界：每 model step 一次 reactive compact + rapid-refill breaker + 3 次重试上限 + 熔断 | `turn-model-step.ts:749/773`、`turn-loop-state.ts:154-168` |

其中 **doom-loop 有界周期**这条对决策有特殊分量：它是 fork 已经修过、而 ZCode 仍然存在的问题——换过去我们需要把 fork 的修复在 ZCode 上**再修一遍**，且修完无法回馈任何人。

### 3.4 未核验

fork open issues 中的 #36（取消无法打断挂起的 permission ask，事后批准在转录盲区产生真实副作用）、#16（长存活进程 GC 死亡螺旋）、#6（SQLite upsert 失败）、#17/#18（structured output 两项）未在 ZCode 中核验。这些属于"切换前需要补做的验证清单"，不改变本评估的结论方向，但影响迁移工作量估计。

---

## 4. 能力级对照

### 4.1 issue #46 维度

| 维度 | fork 现状 | ZCode |
|---|---|---|
| 压缩分层 | 增量摘要 + tail 原文保留（2k~15k token）+ prune（**默认关**） | microcompact（**默认开**：工具白名单 + 保留最近 5 组 + 媒体保护 + 最小节省阈值，`microcompact.ts:14-29`）+ auto compact（provider usage 锚定估算 + 熔断）+ reactive 恢复 |
| 压缩后恢复 | 无文件回填（issue #46 P1 计划项） | readFileState 投影回填（≤5 文件、单文件 5k、总量 50k token；超限降级为路径提示，`compact-post-reminders.ts:8-51`）+ plan 文件引用重注入 + summary 附完整 transcript 路径。**注意：是缓存投影而非重读磁盘**——与 issue #46 对 ZCode 的定性一致，版本过时风险仍在 |
| shell 后台 | 无后台模式 | 一等能力：`run_in_background` + 任务 ID + 输出文件 + 完成通知 + 15s 阻塞预算自动转后台 + 后台结果 `persistOutput: "always"`（`bash-model-content.ts:119-143`） |
| grep | 3 参数、固定 100 条 | 全量参数面：三种输出模式 + 上下文行 + `-i/-o/-n/type/multiline` + `head_limit/offset` 分页（`CT/tools/grep.ts:22-103`）；Glob 仍固定 100 |
| 工具结果预算 | 各工具自带 truncate + 全文落盘（7 天清理） | **一等协议字段** `resultBudget`（strategy/preview/artifact/retention）+ artifact store + 结构化截断诊断行（`CT/tools/contract.ts`、`result-serialization.ts`） |
| MCP | code-mode 可选封装；structuredContent/resource_link/audio 有缺陷 | 工具直出；structuredContent 恒追加；audio 占位；`_meta` 声明式错误展示；authority 防仿冒门 |
| 子代理 | 异步 agent-management：启动即返回 + `agent_list/send/stop` + roster reminder 注入运行快照 | 同一 `Agent` 工具可同步可后台（`run_in_background`）；`SendMessage` 续跑已完成 agent / steer 运行中 agent；`TaskStop`/`TaskOutput`；统一 `RuntimeTaskRegistry`（agent/bash/workflow 共用任务语义）。**无 list 工具、无 roster 注入、无原生 worktree**（workflow 的 worktree isolation 显式 not implemented，`script-workflow-runtime.ts:282-283`） |
| 附加面 | — | workflow 工具族、cron/off-peak 调度、hooks 体系（SessionStart/PreToolUse/Stop 等）、web/desktop 产品面 |

### 4.2 fork 独有、ZCode 缺失的资产

1. **异步子代理的"可见性"面**：`agent_list` 运行快照 + roster reminder 每轮注入（fork #47/#48 刚修过其上下文成本）。ZCode 的替代是启动时返回的 output_file + 完成通知 + 用户侧 `/tasks` 命令——模型主动感知运行中子代理的通道更弱。
2. **原生 worktree 工具**（含未提交仓库场景，#45）。ZCode 靠内置 skill 引导模型自己跑 `git worktree`。
3. **有界周期 doom-loop 检测**（#20/#22）。ZCode 存在同型缺陷（§3.3）。
4. **willOverflow 发送前预检**（#12/#14 的 V1 实现）。ZCode 只收敛 `max_output_tokens`。
5. **一套可参与的 upstream 与绑定其上的工程实践**（§2.2）。

---

## 5. 替换分析

### 5.1 替换的真实含义

由于 §2.1 的身世结论，"全面替换"= 更换产品而非更换分支，具体包括：会话数据迁移（`~/.zcode/cli/db/db.sqlite` vs opencode 存储）、配置体系重写、插件/hooks API 重学（ZCode 是 Claude Code 风格 hooks，opencode 是 experimental 插件钩子）、TUI/CI/发布流程重建、`docs/workflow.md` 契约审核体系重新落地，以及 24 个修复点的逐条重新验证（§3 已完成大半：约 3/4 不再需要，两处半需要重做）。

### 5.2 全面替换的收益

1. issue #46 的 P0 三项立即消失，P1 的文件回填/状态恢复有现成实现——fork 计划数周的工作变成零。
2. 流处理与恢复机制的工程化程度高于 fork 当前水平：恢复锚点持久化、重试边界语义化、语义退出码白名单、rapid-refill breaker、idle 超时随重试扩窗。
3. 若主力模型为 GLM：业务码表、zcode-plan 专用恢复、GLM 超窗措辞等专项适配是 fork 无法追平的。
4. 后台 shell、grep 分页、artifact 预算、统一任务注册表等能力开箱即用。

### 5.3 全面替换的成本与风险

1. **贡献者 → 私改者（治理，权重最高）**。ZCode 无法提 issue、无法上游修复、无历史可 rebase、官方明示源码功能为部分快照。fork 一年 24 个修复的价值恰恰在于"发现并修复上游缺陷、随 sync 分发"；在 ZCode 上同一工作变成"每个投放周期把私有 patch 重新对上去"——长期维护成本**高于**追 opencode upstream，且修复的社会价值归零。§3.3 的 doom-loop 缺陷就是缩影：我们要在 ZCode 上把 fork 已修的 bug 再修一遍，修完谁也拿不到。
2. **fork 资产蒸发或重写**（§4.2 五项）。其中 roster/list 面与原生 worktree 是刚投入的特性（PR #35/#43、#45/#48）。
3. **供应商绑定**。ZCode 的专项适配与产品演进绑定 GLM 生态；模型策略变化时适配优势归零，绑定成本不变。与 issue #46"模型无关改进"的立场相反。
4. **可验证性下降**。无公开缺陷记录、社区 patch 仅两份且只涉及视频输入；`docs/workflow.md` 的契约审核（路径 A 自动检查 + 路径 B 独立审）依赖可读源码与可追踪历史，在投放式仓库上两边都打折。
5. **迁移即风险**。存储/配置/扩展 API 全换，而我们对 ZCode 缺少回归测试基础（fork 的回归资产带不走）；fork 仍有 15 个 open issue，其中一部分（§3.4 未核验项）在 ZCode 的存在性未知——迁移后这些要重新发现。

### 5.4 三条路线

| 路线 | 内容 | 适合条件 |
|---|---|---|
| A. 全面替换 | ZCode 成为主 harness，fork 冻结归档 | 团队放弃维护角色、主力模型锁定 GLM、接受私有 patch 追投放 |
| **B. 维持 fork，ZCode 作参照实现（倾向）** | issue #46 照常推进（P0 三修 → P1 设计）；ZCode 的好设计作为 P1/P2 各子计划的设计输入：副作用恢复锚点、语义退出码白名单（bash-semantics 白名单可直接用于决策 B③）、microcompact 默认开启的策略、统一任务注册表、artifact 预算协议 | 维持"能修 bug、修得比上游快"的定位；保持模型无关 |
| C. 并行使用 | ZCode 作为 GLM 模型的日常工具直接用；fork 继续做通用 harness 与实验场 | 零迁移成本；代价是两套工具的配置与心智 |

B 与 C 不互斥（一个是开发路线、一个是使用策略）；A 与 B/C 互斥。两条路线各自的"补全成本"量化对比见 §7：A 需在 ZCode 中补齐 §4.2 五项（约 2-4 周 + 永久 patch 税），B 需完成 issue #46（约 4-8 周，可裁剪、可外部化）。

### 5.5 什么情况下应该反过来选 A

诚实列出 A 成立的条件，避免立场先行：

- 团队明确决定不再投入维护（fork 的 15 个 open issue + 定期 upstream sync 的负担确实真实存在）；
- 评测/生产模型长期锁定 GLM 系；
- 对"修复无法上游化、私有 patch 长期化"的治理模式接受且建立了对应的维护预算；
- 迁移验证（§3.4 未核验项 + 端到端对照）显示 fork 独有资产在 ZCode 上有可接受的替代或可放弃。

当前四条均不成立——特别是第一条与过去一年的事实相反。

---

## 6. 边界与未覆盖项

- **未核验的缺陷对照**：#36/#16/#6/#17/#18 在 ZCode 的存在性（§3.4）。
- **未比较的面**：TUI/desktop/web 的实际体验、性能与资源占用、长会话稳定性；ZCode 测试覆盖的系统性量化（抽查所见其测试与 formal-proof 包质量高，但未度量）；两边的提示词实际效果（issue #46 已做装配层对比，未做行为实验）。
- **方法局限**：ZCode 侧为静态源码审查（v3.14.3 快照），未运行端到端对照实验；其后续投放可能改变本文结论，建议在每次关注的大版本投放后复核 §3.3/§4.2 两表。
- **时效**：ZCode 处于快速演进期（9-20 建仓至 9-24 已到 v3.14.3），本文证据基于该快照。

---

## 7. 补全成本对比：A 路线补 §4.2 vs B 路线做 issue #46

> 本节量化两条路线的"补全成本"，作为 §5.4 路线选择的补充依据。
> 口径：**代价一** = 在 ZCode 中补齐 §4.2 的五项 fork 独有资产（使切换后不丢东西）；**代价二** = 在 opencode fork 中完成 issue #46（对齐 ZCode 的领先面）。
> 估算基于源码审查 + 本项目实际开发节奏（含设计确认与回归测试的工作流开销，两边大致相当，按净工程量计）。**是估计区间，不是承诺。**

### 7.1 代价一：在 ZCode 中补齐 §4.2 五项

| 项 | 有利条件 | 不利条件 | 估算 |
|---|---|---|---|
| 1a. agent 列表工具 | `RuntimeTaskRegistry` 已有 `isBackgrounded && status==="running"` 现成过滤（`registry.ts:290`）；工具注册为三文件局部模式（`contracts/tools/*.ts` + `handlers/*.ts` + `index.ts`） | 无 | **S**（1-2 天） |
| 1b. roster reminder 注入 | system-reminder 模块存在（`core/src/system-reminder/`） | roster 的正确性陷阱是 fork 拿真实 bug 换来的（#47 列出全部历史孩子吞掉近六成上下文、#48 只列 running）——重做仍要踩一遍；**与 ZCode 设计方向相逆**：其 `TaskOutput` 已标 DEPRECATED，明确走向"输出文件 + 完成通知"而非列表/轮询 | **M**（3-5 天，含正确性迭代） |
| 2. 原生 worktree 工具 | fork 有参照实现（含 #45 未提交仓库修复）；ZCode 已在 `provider-visible-order.ts` 预留 `EnterWorktree/ExitWorktree` 名字（有计划未实现，workflow isolation 显式 not implemented） | 须按 ZCode 的 FS/session 服务重写；unborn HEAD 类 bug 大概率重踩；其内置 skill 已提供手工 `git worktree` 路径，必要性存疑 | **M**（3-5 天） |
| 3. 有界周期 doom-loop | 检测点单一（`model-anomaly.ts:36-41`），fork 的 periodic-cycles 逻辑可平移 | 从此永久承担"私有修复对方缺陷"的责任 | **S**（1-2 天） |
| 4. willOverflow 预检 | `estimateCurrentModelInputTokens` 估算器已存在（`compact.ts:342-350`）；`CompactPhase.PreRequest` 挂点已有，缺的只是阈值判断 + 触发 | 与其 reactive 哲学有摩擦 | **S-M**（2-3 天） |
| 5. 可参与 upstream | — | **无法以任何工程代价获得**（结构性，见 §2.2） | **不可购买** |

**一次性小计**：约 **10-17 个工作日**，另加 **3-5 天熟悉期**（ZCode 的 turn loop / registry / reminder 体系对本项目是全新代码）。

**经常性成本（真正的重心）**：每项都成为**永久私有 patch**——每次官方投放需文件级重对（无细粒度历史可 rebase，§2.2），投放节奏由厂商决定，每次投放后需重跑验证。ZCode 演进很快（4 天从建仓到 v3.14.3），patch 税的频率不可控。

**测试基建赤字（本次核实的新事实）**：ZCode 公开快照仅含 **4 个测试文件**（`packages/services`、`packages/ui` 各 2），核心 runtime（`apps/zcode-cli`）**无任何测试随源发布**——无论其私有测试是否存在，对补丁开发者而言等于没有本地回归基建。对照 fork：**675 个测试文件 / 约 17.4 万行测试代码**。本项目工作流要求"回归必补"（workflow §7 第 4 步），在 ZCode 上给上述每项补测试意味着从零搭脚手架，或裸奔——这是**按项重复发生**的隐性成本，不计入上表天数。

### 7.2 代价二：在 opencode 中完成 issue #46

| 项 | 内容与依据 | 估算 |
|---|---|---|
| P0 ×3 | 投影 / 合并 / serialize 修复——文件、读方、验收标准已全部核实（`runtime-alignment-research.md` §3/§4），每项一处主修改 + 共享 helper + 回归 | **~1 周**（每项 1-2 天） |
| P1 提示词统一 | 共享行为段（插入点已论证唯一：`request.ts` 三元之后）+ default/trinity 硬冲突清理 + §4 设计流程 | **1-2 周** |
| P1 文件恢复 | 磁盘重读 + top-K + 版本比对 + tail 去重 + 预算（分叉倾向已定，`runtime-alignment-research.md` §5.2） | **1-2 周** |
| P1 状态恢复 | roster 已有；todo 注入（DB 表现成，S）；skill 重注入（S-M） | **~1 周** |
| P1 恢复扩展契约 | 按 v1 内部刀法延后（记引入条件） | **0** |
| P2 grep 扩展 | schema 加参数 + ripgrep flags + 分页 | **2-3 天** |
| P2 后台 shell | fork 已有 `BackgroundJob` + agent-management 底座，需建任务注册表 / 输出文件 / 完成通知 | **1-2 周**（可选项） |
| P2 artifact 预算协议 | fork 的 truncate + 全文落盘已覆盖主场景，P0-3 修完 serialize 后摘要侧即补齐 | **可选不做** |

**一次性小计**：P0+P1 ≈ **4-6 周**；含 P2 全部 ≈ **6-8 周**。

**经常性成本**：正常 upstream sync——**已在预算内**（一直在做），且 P0 类修复可 PR 回 anomalyco，部分成本可外部化。测试直接扩展现有 suite，工作流 / 审计体系原样适用。

### 7.3 对比矩阵

| 维度 | 代价一（补齐 ZCode） | 代价二（opencode 做 #46） |
|---|---|---|
| 一次性工程量 | **~2-4 周**（含熟悉期） | **~4-8 周**（含可选项） |
| 买到的是什么 | **恢复原状**——买回因切换而丢掉的东西，净增益为零 | **净增能力**——退出码可见性、压缩恢复、后台、搜索的全面补强 |
| 经常性成本 | **无上限 patch 税**：厂商投放节奏 × 无历史重对 × 每次重验证 | 已预算的 upstream sync；修复可 upstream 外部化 |
| 测试基建 | 核心 runtime 零覆盖，每项补丁自建脚手架或裸奔 | 675 文件 / 17.4 万行现成体系 |
| 设计阻力 | 两项与 ZCode 演进方向**相逆**（list/roster vs 通知流） | 无——修自己的投影缺口 |
| 缺陷敞口 | 继续自担 ZCode 未核验缺陷（#36/#16/#6 类比物，§3.4）+ 已确认 doom-loop 的私有维护责任 | 无新增（修的就是已知缺陷） |
| 产出的外部价值 | **零**（无法上游、无法分发） | P0 修复可 PR 回 anomalyco，社区受益 |
| 结构性项 | 第 5 项（可参与性）**不可购买** | 不适用 |
| 估算置信度 | 中低（代码库不熟 + 投放会改变地形） | 高（P0 已逐行核实；P1 中；P2 可裁剪） |

### 7.4 结论

1. **纯工程量上代价一便宜**（约为代价二的 1/3～1/2），但属于"幻觉性便宜"：它买的是**止损**（找回因切换而丢掉的东西），且每一分钱都附带永久 patch 税、零测试基建和设计相逆风险。第 5 项——当初不选 A 的首要理由——无论投入多少工程量都买不到。
2. **代价二更贵但每分钱花在增量上**：范围大是因为 issue #46 对齐的不只是 §4.2 五点，还包括 ZCode 的能力面（压缩分层、后台、搜索、预算协议）；置信度高、可裁剪（砍掉 P2 可选项即 4-6 周）、可外部化。
3. **代价二的天花板要说明**：B 路线买不到 ZCode 的 GLM 专项适配、workflow 工具族、web/desktop 产品面与 formal-proof 包——issue #46 的目标是对齐模型无关的 runtime 能力，不是全面复刻；若这些重要，属 C 路线（并行使用）的份内事。
4. 一句话：**代价一是"花小钱找回丢掉的旧资产，从此交税"；代价二是"花大钱购买新能力，且税款已含在预算里"**。这反过来印证 §5 的结论——A 路线的真实成本从来不是补全工程量，而是治理结构本身（§2.2 + §5.3 第 1 条）。
