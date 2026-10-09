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

B 与 C 不互斥（一个是开发路线、一个是使用策略）；A 与 B/C 互斥。

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
