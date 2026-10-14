# 修正方案 — Agent 花名册列出全部历史孩子，吞掉近六成上下文

- 模块：`agent-management` / `lifecycle`（兄弟快照），`session` / `reminders`（父花名册）
- 分类：§7 step 2 第二类（设计缺陷：列表语义选错，导致无界增长）
- 状态：已实施（待提交）

## 第一部分：现象与复现

**现象**：在一个长期运行、反复扇出 subagent 的父会话里，注入的 Agent 花名册长到压倒正文。

**实测数据**（取自一个真实运行中的实例，`1.18.31-fmv2-fix45`，`~/ccv-verify/mceliece`，父会话 `ses_f0d514ec…`）：

父会话转录（`applyAgentRoster` 注入）：

| 指标 | 数值 |
|---|---|
| 转录消息数 | 6850 |
| 转录文本总量 | 2,401,844 字符 |
| 花名册注入次数 | **265** |
| 花名册合计 | **1,077,443 字符 → 占转录文本 44.9%** |
| 最近 300 条消息内 | 16 份花名册，118,178 字符 → **占该窗口 58.4%** |
| 最后一份 | **133 行 / 7,673 字符**，其中 `running` **6**、`idle` **127** |

新建 subagent 收到的开场消息（`siblingSnapshot` 注入）：

| part | 内容 | 字符 |
|---|---|---|
| 0 | 工作目录说明 | 180 |
| 1 | **兄弟快照** | **5,621（132 行）** |
| 2 | 真正的任务 | 1,101 |

即**快照是任务本身的 5 倍，占开场消息 81%**。

**复现条件**：同一父会话累计创建过远多于当前存活数的 subagent。不需要特殊操作，长时间使用必然到达。

**出错代码路径**

- `packages/opencode/src/agent-management/lifecycle.ts:151` `siblingSnapshot`
  → `tree.children(input.caller.id, depth + 1)`，**无状态过滤**
- `packages/opencode/src/session/reminders.ts:87` `applyAgentRoster`
  → `tree.children(input.session.id, depth + 1)`，逐行取 status 但**不据此过滤**

**预期 vs 实际**：预期花名册告诉读者"现在有谁在和我并行干活"；实际给出"这个父会话有史以来创建过的全部 agent"，且只增不减。

## 第二部分：根因分析

**症状**是花名册过长；**根因是列表的语义选错了**，而这由标题写定：

```
Agents you can message with agent_send:
```

这句话承诺的是**可寻址对象的完整清单**。而 `agent_send` 的能力范围是「任何 agent，只要给 session_id」（见其工具描述：*and any agent at all by session_id*）——按这个承诺，列表就**必须**包含所有曾经存在的孩子，于是过滤掉任何一个都是违背承诺。无界增长不是疏漏，是这个标题的逻辑后果。

父花名册的 `Your subagents at this point:` 同理：「此刻的全部 subagent」也是一个完整性承诺。

两处共同的第二层原因：**它们回答的是一个已经有更好答案的问题**。「我能给谁发消息」由 `agent_send` 的工具描述回答；「当前实况」由 `agent_list` 按需回答。推送一份过时且只增不减的清单，是用更差的渠道重复已有信息。

本方案**消除根因**：改掉列表声明的语义，使过滤成为定义的一部分而非武断的裁剪。

## 第三部分：参考实现对照

不适用（非算法类）。代之以对自身契约的对照：`agent_send` 的工具描述已声明可达范围为「任意 agent」，故完整性清单在设计上本就是多余的；`agent_list` 的描述声明「Status is `running` or `idle`, read at this instant. It is a snapshot, not a promise」——即**实况查询的职责已明确归属它**。

## 第四部分：修复方案

### 新的列表语义

兄弟快照改为回答两件事，并显式放弃完整性：

```
Your parent: <session_id>  — <title>

Working alongside you right now:
  <session_id>  <实例名>  — <title>
  …（最多 10 行，按创建时间取最近的）
  （被截断时）N more are running; use agent_list for the full picture.

Not a complete list of who you can reach: agent_send takes any session_id.
```

**每行三样：session_id、实例名（有则显示）、`title`。** `title` 原样使用——它是
`lifecycle.ts:382` 拼成的 `${description} (@${type} subagent)`，**自带 agent 类型**，
因此不再单列类型。无实例名时该行仍由 `title` 的后缀表明类型，匿名条目不会退化成只有一个 id。

**不单列 `relation`**：父亲已单独一段，其下按集合定义全是兄弟；父花名册其下全是孩子。
每行重复一个常量没有信息量。

父花名册同样只列 `running` 的孩子，同样 10 行上限；它不需要「你的父亲是谁」那一段。

**全部孩子都不在运行时**，父花名册产出**一行占位** `Your subagents working right now: none (N finished).`，
而不是整段消失——父亲保留"我有过孩子"这一事实，而不必为 N 个墓碑付逐行的注意力。

**所有注入文本只陈述事实，不指挥工具。** 初稿里截断行与尾注都写了 "use agent_list"；
否决——模型持有工具描述，知道 `agent_list` / `agent_send` 是什么，而这些话每轮开头都会出现，
提醒是纯噪音。尾注保留为两个事实（"not everyone you can reach, and not current past this moment"），
用来防止列表被误读为全集或实况，但不点名工具。

### 三处改动

1. **只列 `running`**。父花名册已逐行取到 status，加过滤即可。兄弟快照需新增 `AgentStatusProjection` 依赖（已确认无循环：`status.ts` 只 import `SessionStatus` / `SessionID` / schema，不 import `lifecycle`；该 node 的 deps 仅 `SessionStatus.node`，且已在 `tool/registry.ts`、`session/prompt.ts` 两处挂载过）。
2. **每行带实例名与简介**。`AgentSkeleton` 已有 `title`，无须新增字段：工作简介本来就在那里。现有行形如 `ses_xxx  cw-api`，读者看不出这是谁、在干什么。

   曾考虑把原始 `description` 另存进 session metadata（旁边已有 `agentName`、`agentWorkdir`），以去掉 `title` 尾部那段 ` (@<type> subagent)`。**否决**：那段后缀恰好承担了"这是什么类型的 agent"，留着它反而省掉一个单独的类型列；为一处观感冗余新增一个持久化字段不划算。`lifecycle.ts:382` 因此不动。
3. **上限 10 行，按 `time_created` 取最近**；超出时**显式说明被截断及剩余数量**——否则上限会让列表静默说谎。

### 为什么选 10

与 `agent_list` 的职责划分一致：注入的清单负责「让你知道身边有人、是谁、在干嘛」，完整枚举归 `agent_list`。10 行量级与开场消息中真正的任务（实测约 1100 字符）相当，不会倒挂。该值写成模块常量而非散落字面量。

### 修复后的预期体量（按实测数据推算）

| | 修复前 | 修复后 |
|---|---|---|
| 父花名册最后一份 | 133 行 / 7,673 字符 | **6 行 / 约 400 字符** |
| 兄弟快照 | 132 行 / 5,621 字符 | 同上量级 |

注入**次数**也会随之下降：当前 127 个 idle agent 中任一状态翻动都会改变文本从而触发重新注入；只列 running 之后，变化源从 133 个收缩到存活数（实测 6），去重会挡掉绝大多数。

### 考虑过并否决的方案

**A. 保留全部条目，只把 idle 的折叠成一行计数。** 否决：读者仍需为"有 127 个墓碑"这件事付注意力，而这个事实对它的任务没有价值。

**B. 按时间窗口过滤（如最近 1 小时）。** 否决：引入一个与问题无关的调参；而"在不在干活"本身就是要问的属性，不必用时间近似。

**C. 完全去掉注入，只留 `agent_list`。** 否决：一个不知道身边有人的 agent 不会想到去查。推送"有谁"是有价值的，被否决的只是推送"全部历史"。

## 第五部分：正确性论证

1. **根因消除**：根因是列表声明了完整性语义，迫使它包含全部历史。修复把声明改为「正在并行干活的」，并显式交出完整性（指向 `agent_send` 与 `agent_list`）。过滤与上限因此成为定义的一部分，而非对一个完整清单的武断裁剪——这是在根因层面解决，而非压缩症状。

2. **不变量保持**：
   - 两处注入的既有安全性质不变：所有模型可控字段（name / agent_type / title）仍过 `AgentInbox.escapeField`，新增的 `title` 列**同样必须过**（它来自父亲给的 `description`，是模型可控的）。
   - `applyAgentRoster` 的去重不变量（内容相同则不重复注入）不受影响；过滤只减少候选集。
   - 权限不变量不变：两处仍在 `agent_list` 被 deny 时整段不产出。
   - 兄弟快照的集合语义由 `{父} ∪ (父的孩子 \ 自己)` 收窄为 `{父} ∪ (父的 running 孩子 \ 自己)`；自己仍被排除，否则会出现"自己在和自己并行"。

3. **无回归引入**：
   - `tree.children` 本身不变，过滤发生在调用方
   - 新增的 `AgentStatusProjection` 依赖无循环（见上）
   - 上限触发时附带剩余计数，故"列表不完整"这一事实对读者是显式的

## 第六部分：测试用例清单

**回归测试（必做，来自第一部分）**

- R1 父会话有 N 个孩子、其中仅 M 个 running（M < N）时，`applyAgentRoster` 的行数为 M —— 去掉过滤后应失败
- R2 同样条件下 `siblingSnapshot` 只列 running 的兄弟 + 父

**新增用例（举一反三）**

- N1 running 兄弟超过 10 个时，只列最近 10 个（按 `time_created`），且文本含剩余数量
- N2 行内含实例名与 `title`，且 `title` 经过 `escapeField`（用带换行/制表符的 description 验证，与 `agent_list` 那次的漏网同类）
- N3 `agent_list` 被 deny 时两处仍整段不产出（既有行为未被改动）
- N4 无 running 兄弟时，兄弟快照仍给出「你的父亲是谁」，不产出空的并行列表

## 第七部分：代码更新清单

| 文件 | 改动 | commit |
|---|---|---|
| `packages/opencode/src/agent-management/lifecycle.ts` | `siblingSnapshot`：新增状态投影依赖、只列 running、行加实例名/title、上限 10 + 截断说明、父亲单独一段、改标题与尾注 | 见本分支提交 |
| `packages/opencode/src/session/reminders.ts` | `applyAgentRoster`：只列 running、行加 title、上限 10 + 截断说明、改标题与尾注 | 见本分支提交 |
| `packages/opencode/src/agent-management/schema.ts` | 上限常量 | 见本分支提交 |
| `packages/opencode/test/agent-management/lifecycle.test.ts` | R2 / N1 / N2 / N4 | 见本分支提交 |
| `packages/opencode/test/session/agent-roster.test.ts` | R1 / N1 / N2 / N3 + 占位行用例 | 见本分支提交 |
| `packages/opencode/src/tool/agent.ts` | `cwd` 描述改写（见附录，同 PR 顺带） | 见本分支提交 |
| `packages/opencode/test/tool/__snapshots__/parameters.test.ts.snap` | `agent` schema 快照更新一行；顺带清掉 #35 遗留的 `task 1` 死快照 | 见本分支提交 |

## 第八部分：文档更新清单

| 文档 | 是否需要改 | 理由 |
|---|---|---|
| `docs/design/agent-management/architecture.md` | ✅ 已改 | 花名册与兄弟快照的内容契约（列谁、上限、完整性归属）变了 |
| `docs/design/agent-management/detailed-design.md` | ✅ 已改 | 两处注入的渲染规则是细化设计内容 |
| 用户文档 | 不需要 | 注入内容是给模型看的，无用户可配置项变化 |

## 附：同一实例上观察到的另一处矛盾（不在本次修复范围）

同一个 subagent 的开场消息里：

```
part[0] 系统分配：  工作目录 .../worktrees/curious-river
part[2] 父亲写的：  "直接在 .opencode/worktrees/rosy-fox 动工"
```

父会话在提示词里指定了另一个 worktree（接续前一轮的分支），系统又自动分配了一个新的，两条指令互相矛盾。

**量化后不是孤例：该父下 15 个 subagent，15 个全部冲突。** 父亲在复用一小组 worktree 当作车道
（`rosy-fox` ×4、`neon-engine` ×4 …），每条车道派连续的"续作" agent；它每次都把目标目录写进 prompt，
**15 次里一次都没传 `cwd`**。于是 15 个 worktree 白建（每个是完整 `git worktree add` + checkout），
15 个 agent 收到两条互相矛盾的目录指令，而从结果看它们听的是父亲的——系统那条是噪音。

15 次全部漏用，说明不是疏忽，是 `cwd` 的描述没有触发这个场景：旧文案 "Pass `cwd` to place it
somewhere specific" 读来像罕见的覆盖项，而父亲的心智模型是"续一条车道"，二者对不上；且工具返回从未
提示过冲突，模型得不到纠正信号。

**本 PR 顺带改写了描述**（`tool/agent.ts` 参数描述与 `AGENT_DESCRIPTION` 各一处）：点名"接续已有目录或
worktree 时把路径传在这里"，并说清省略的后果——会**新建**一个目录并告知 Agent 使用，与 prompt 里另指的目录冲突。
纯文案改动，无逻辑变化；`parameters.test.ts` 的 schema 快照随之更新一行。

**暂不做的更强手段**：在 `cwd` 为空而 prompt 提到 `.opencode/worktrees/<name>` 路径时于工具返回里加一句提示。
先观察描述改写是否足以让父亲开始传 `cwd`（用户正在运行的会话即观察场）；不足再加。
