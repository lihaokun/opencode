# 调研报告 — 通用 Agent runtime 对齐（issue #46）

> 状态：**讨论稿**。决策点均为"倾向"而非决定，待逐项确认后进入对应流程（§7 修复 / §4 设计）。
> 关联：lihaokun/opencode#46（系统提示词、上下文压缩恢复、tool call / tool result 的三方对照）；`docs/research/zcode-replacement-assessment.md`（ZCode 全面对照与替换决策评估）。
> 核验基线：fork `dev@1343833857`。本文所有 file:line 均以该基线为准，全部为只读核实结论，未修改任何代码。
> 阅读方式：§2 讲清楚系统的两条数据流（这是理解一切的前提），§3 沿数据流逐站追踪三个 P0 问题，§4/§5 从事实推导出决策选项与倾向。只想要结论可看 §4.0 概览与 §7 清单，但建议至少读完 §2。

---

## 1. 问题是什么

### 1.1 从三个会话场景说起

**场景一：静默失败的命令。** 模型运行 `deploy --quiet`，进程以退出码 7 失败，且没有输出。下一轮模型收到的工具结果是文本 `(no output)`。它无法区分"命令成功、恰好没输出"和"命令失败、没有输出"，于是按成功的前提继续推理。

**场景二：只剩一句"查询完成"的 MCP 结果。** 一个 MCP 搜索工具返回两部分内容：一段文本"查询完成"，和一个结构化的匹配列表（MCP 协议允许两者并存）。模型只收到"查询完成"——匹配列表不见了，模型要么放弃、要么重问一遍。

**场景三：压缩后消失的全文入口。** 长会话里 grep 返回 3000 行结果，系统照例把全文落盘，并在模型看到的结果末尾附上"输出被截断，全文保存在某文件，可用 Grep/Read 继续"。几十轮后上下文超限触发压缩：摘要模型的输入被截掉了结果末尾——全文路径没了。摘要里自然不会提这个文件，而压缩后的主模型从此依赖摘要工作，于是这个全文入口从整个系统里消失，模型只能重新读文件或重新执行搜索。

### 1.2 三个场景的共同点

信息在系统内部是**完整的**——退出码、结构化数据、全文路径都好好存在磁盘上，UI 界面也能显示它们。丢掉的只是"喂给模型的那一份"。也就是说，这不是数据丢失，而是**投影丢失**：系统里存在若干层"把持久化状态转换成模型可见文本"的代码，信息是在某一层转换时被丢掉的。

这值得当 bug 修，因为 agent 的每一步决策都以上一轮收到的信息为前提：场景一让模型在错误前提下持续推理（比失败本身更贵）；场景二让工具能力静默缩水；场景三让证据链断裂，诱发重复读文件、重复执行命令。

### 1.3 issue 的分层与本文范围

issue #46 把改进分为三层：**P0** 是"结果信息不丢失"（上面三个场景）；**P1** 是提示词统一与压缩后恢复（文件/状态回填）；**P2** 是工具能力扩展（grep 分页、后台 shell）。本文覆盖：

- P0 三个问题的端到端追踪与修复决策（§3、§4）；
- P1 两个方向的现状盘点与关键分叉（§5）；
- P2 只给方向结论（§4.0 表格），细节等到进入实施时再讨论。

外部参照（ZCode、Claude Code 怎么做）沿用 issue #46 原文，不在此重复；本文补的是 fork 自身源码层面的事实。

---

## 2. 系统如何工作：两条数据流

以下两个机制是理解全部问题的基础。所有后文的"丢失点定位"和"修复约束"都从这里推导。

### 2.1 数据流一：工具结果的一生

一次工具调用从执行到被模型看见，经过四步：

**第 1 步：执行。** 工具的 `execute` 返回一个对象 `{ title, metadata, output, attachments }`。这个形状是本仓库的核心约定：`output` 是给模型看的正文文本；`metadata` 是结构化状态（退出码、文件路径、计数……），主要给 UI 用。注意这个约定本身没有任何问题——问题在于后面两步怎么对待这两个字段。

**第 2 步：投影与落库。** session processor 从返回对象里挑出 `output / title / metadata / attachments` 四个字段，写进消息 part 并持久化（`session/processor.ts:298-309` 与 `:384-403`）。到这里为止信息是完整的。

**第 3 步：重放。** 这里有一个对全局理解都关键的事实：**opencode 不存在"同一请求内把工具结果回传给模型"这回事**。主循环是外层 `while`（`session/prompt.ts:1218`），每次发给 AI SDK 的请求只跑一步（`stopWhen=stepCountIs(1)`）。所以模型看到工具结果的唯一通道是：**下一轮**请求发出前，`message-v2.toModelMessages` 把持久化的消息 part 转换成模型消息。

**第 4 步：转换。** 转换规则（`session/message-v2.ts:295-328`）对已完成（completed）的工具 part：模型收到的文本 = `state.output` 字符串 + 附件；`state.metadata` 里只有两个 provider 专用字段被保留（`providerExecuted`、provider options），**其余全部丢弃**。

由此得到两个贯穿全文的推论：

> **推论 1**：metadata 里的任何信息，除非工具自己把它写进 output 文本，否则模型永远看不到——不管它对决策多重要、存储多完整。
>
> **推论 2**：想让模型看到某个丢失的信息 X，改动位置只有两类——**写方**（在工具源头把 X 拼进 output 文本）或**读方**（在转换层把 metadata 翻译成文本）。读方有两个：重放转换（上一段）和压缩摘要的序列化（下一节）。后面所有方案讨论都是这两类的组合。

（native 与 ai-sdk 两条 runtime 共用同一个重放产物，见 §2.3，所以重放转换修一处即全覆盖。另有一个易混淆点已被排除：重放路径上有一个可选的 `toolOutputMaxChars` 截断参数，但生产代码从不传值，只有测试传——即重放**不存在**隐藏的二次截断。）

### 2.2 数据流二：压缩的工作方式

上下文超限时，压缩（compaction）按以下步骤发生（`session/compaction.ts:343-586`）：

**第 1 步：触发。** 多种条件（已完成消息超限、本次请求估算将超限、provider 返回溢出错误、用户手动）最终都汇聚为：创建一条 user 消息，上面挂一个 `compaction` part。

**第 2 步：切分。** `select` 按一个"近期原文保留预算"（默认取可用上下文的 25%，钳制在 2k～15k token，`compaction.ts:115-120`）把历史切成两段：**tail** 是保留原文的近期消息（用一个持久化游标 `tail_start_id` 记录起点），**head** 是其余的旧历史，将被摘要替代。

**第 3 步：序列化。** `serialize` 把 head 的每条消息压成纯文本喂给摘要模型。其中与我们最相关的规则：completed 工具结果**整体只取前 2,000 字符**（`compaction.ts:30` 常量、`:51-52` 截断、`:78` 应用）；error 结果不截断；**整个文件从不读取 metadata**。

**第 4 步：摘要请求。** 一条不带工具的请求（系统提示词固定为 compaction agent 的模板）把序列化文本发给摘要模型，产出的摘要作为 assistant 消息落库。

**第 5 步：重排。** 此后每一轮请求，`filterCompacted`（`message-v2.ts:526-577`）把上下文重排成 `[compaction 消息, 摘要, ...tail 原文..., ...]`——head 被"摘要"替换，tail 保持原文。

由此再得两个推论：

> **推论 3**：摘要模型看到什么，主模型压缩后就"记得"什么。serialize 的任何截断都直接变成模型的**永久性记忆缺失**——不修 serialize，改摘要提示词、改摘要模板都补不回来。
>
> **推论 4**：tail 里的内容不经过 serialize，不受 2,000 字符限制。二次截断只发生在被划进 head 的部分。

### 2.3 一个容易被误判的事实：有两套并行 runtime

opencode 仓库里实际跑着两套会话循环，各自持有一份压缩实现：

| runtime | 谁在用 | 压缩实现 |
|---|---|---|
| `SessionPrompt` 循环（V1） | 默认 `opencode` CLI / TUI / server 的会话 handler | `packages/opencode/src/session/compaction.ts` |
| core `SessionRunner`（V2） | `packages/cli` 的 `serve` 命令、`sdk-next` embedded server，经 server routes → `SessionExecutionLocal` → `core/session/runner/llm.ts:109,222,377` | `packages/core/src/session/compaction.ts`（`:14` 同款 2,000 常量、`:95-121` 几乎相同的 serialize） |

core 包标着 `private: true`、不发 npm，容易误判为死代码——但它被打进 workspace 构建产物，且 git 历史显示这条链在活跃维护（例如 `78f85b1 fix(core): ensure relevant files survive compaction`）。判定标准应该是"有无生产可达链"，而不是"主产品调不调用"。

> **推论 5**：凡是改"摘要输入长什么样"的修复，两份 serialize 都要改，否则 serve / sdk-next 这条 runtime 的用户带着同样的病。

### 2.4 术语约定

本文说某信息**"丢失"**，指：它存在于持久化存储中，但**没有任何一条到达模型的路径会包含它**。UI 看不看得到、存储全不全，都不影响这个判定。

---

## 3. 三个 P0 问题的端到端追踪

每个问题按同一结构展开：**数据流逐站追踪**（信息在哪一步还在、哪一步消失）→ **影响推演** → **修复约束**（由 §2 的推论推导，直接约束 §4 的选项空间）。

### 3.1 场景一：静默失败的命令（shell 退出码）

**数据流追踪。**

1. **执行**：`tool/shell.ts` 跑完命令，进程退出码 7。返回对象里 `output` 为 `"(no output)"`（`shell.ts:576`），`metadata` 为 `{ exit: 7, ... }`（`shell.ts:589`）。两个值得注意的既有行为：超时和用户取消时 `exit` 为 `null`，但正文会追加 `<shell_metadata>` 说明块（`shell.ts:561-567, 582-584`）——**这两类终态已有正文说明，不缺信息**；输出过长时 shell 把全文路径放在正文**头部**（`shell.ts:579`），这一点在场景三会再次出现。
2. **落库**：`exit: 7` 完整持久化。信息还在。
3. **重放**：按 §2.1 第 4 步的规则，转换只取 `output` 字符串。模型收到 `(no output)`。信息在这里消失。
4. **对照**：CLI 的状态栏能显示 `bash completed (exit 7)`（`cli/cmd/run/tool.ts:674-685`，全仓唯一读取 `metadata.exit` 的地方）。这印证了 §1.2 的判断：信息只在"给模型"这一层断掉。

**影响推演。** 非零退出码是 shell 类工具最基本的状态信号。丢失它，模型会把失败当成功继续走（最贵的错误）；会把"无输出"一律当"无事发生"；也无法利用 `grep`（1 = 无匹配）、`diff`（1 = 有差异）这类**语义化的非零码**——模型连"命令执行过了、结果是什么性质"都无从判断。现状下唯一不缺的是超时/取消（它们有正文说明）。

**补充发现（issue 未覆盖）：`!cmd` 路径连存储都不完整。** 用户用 `!cmd` 直接执行的命令也会产出一条 `bash` 工具 part（`prompt.ts:628-708`），但这条路径自己组装返回对象，在 `prompt.ts:684` **把 `handle.exitCode` 直接丢弃**，metadata 里只有 `{ output }`。也就是说，即便修好了投影，这条路也无码可投——无论选哪种方案，它都需要先补一行"记录退出码"。

**修复约束。** 由推论 2，改动位置只有两类：

- **写方**：shell.ts 把退出码拼进 output 文本（一处改动，重放与摘要自动一致）；
- **读方**：message-v2 转换时按 metadata 翻译出一行状态（重放侧），serialize 补 metadata 行（摘要侧）。

加上两个语义决策——只标非零还是全标（涉及噪音）、非零是否渲染成 error（涉及把"无匹配"误判成错误的反向风险）——构成**决策 B**（§4.1）。

### 3.2 场景二：只剩"查询完成"的 MCP 结果

**协议背景。** MCP 的 `CallToolResult` 同时携带两个通道：`content`（面向呈现的块列表：text / image / embedded resource / resource_link / audio）和 `structuredContent`（机器可读数据）。协议明确允许两者**并存**——典型如"一句人话总结 + 完整数据"。

**fork 的两段处理。** MCP 结果进入 fork 后先过 catalog，再做投影，两段职责不同：

1. **catalog 层**（`mcp/catalog.ts:68-80`）：负责错误判定与空内容兜底。现行规则：`content` 非空 → **原样放行**（structuredContent 原封不动留在对象上）；仅当 `content` 为空且 structuredContent 存在时，才把 structuredContent JSON 序列化成文本兜底。要强调：这个"content 优先"**是上游的有意设计**——commit `fd213e6df6`（"prefer content over structured output"），且 `test/mcp/catalog.test.ts:30-50` 有测试固化。
2. **投影层**（`session/tools.ts:429-465`）：负责把结果变成落库的 `output / attachments`。实现是一个逐块循环：`text` 收进正文、`image` 变附件、embedded resource 变附件或写显式占位说明（`[Binary MCP resource omitted: <uri> (<mime>, <size>) ...]`，`tools.ts:446-454`）。**这个循环没有 else 分支**：`structuredContent` 不是 `content` 的块，根本不会进循环；`resource_link` 和 `audio` 两个内容类型也没有处理分支——它们是被**静默**丢弃的，连占位说明都没有。

**丢失点定位。** 结构化数据不是被 catalog 删掉的（它在内存对象上一直存在），而是投影层没有任何一行代码把它放进正文或附件。又因为落库 schema（`schema/v1/session.ts:277-289`）没有承载原始 content 的字段，processor 落库的只有投影产物——所以存储里从此也没有它。这符合 §2.4 的"丢失"定义。

**两条路径的对照（一个重要旁证）。** fork 还有一条 experimental 的 code-mode 路径，它对同一结果的优先级**相反**：structuredContent 存在就直接胜出、替代文本（`tool/code-mode.ts:109`）。这是因为 code-mode 把结果交给程序化的 JSON 解释器，人话文本反而次要。这个旁证说明两件事：仓库里"结构化数据的投影"是存在且被测试覆盖的（`code-mode.ts:75-116`）；默认路径（code-mode 默认关闭，`runtime-flags.ts:47`）只是没有享受到。

**第二个丢失点：错误路径。** `isError` 时 catalog 直接 throw，错误 message 只拼接 `content` 里 text 项，全空则兜底为固定文案 `"MCP tool returned an error"`（`catalog.ts:68-74`）。如果服务器把错误详情放在 structuredContent 里（协议允许），模型只看到兜底文案——**这是一个独立于投影层的丢失点**，且同一段 throw 在 code-mode 里逐字重复（`code-mode.ts:161-167`，注释明说故意镜像）。修复它要同时动两处，且会改变插件能观察到的错误文案。

**修复约束。** ① 不能动 catalog 的 content-first——那是与上游对抗，且上游测试会挂；修复应定位在投影层。② 投影层拿到 structuredContent 后，是**追加**到文本之后还是**替代**文本，需要权衡（code-mode 选替代，但它的理由——面向 JSON 解释器——不必然适用于默认路径）。③ `resource_link` / `audio` 至少要给显式占位，消除静默丢弃。④ 错误路径是独立修复点。→ **决策 C**（§4.2）。

### 3.3 场景三：压缩后消失的全文入口

**数据流追踪。**

1. **正常返回**：grep 返回 3,000 行。通用截断器 `tool/truncate.ts:85-141` 介入：预览取**头部**（`direction` 默认 `"head"`，且全仓没有任何调用点覆盖这个默认值），全文落盘，然后把 hint（全文路径 + 继续读取的方法）拼在预览的**尾部**（`truncate.ts:133-137`）。此刻一切正常——模型能看到全文入口。
2. **压缩触发**：几十轮后上下文超限。按 §2.2，这个老结果被划进 **head**。
3. **序列化**：serialize 对每个 completed 工具结果整体取前 2,000 字符——hint 在尾部，**被切掉**；serialize 从不读 metadata，`metadata.outputPath` 也帮不上忙。
4. **不可逆**：摘要模型看到的输入里已经没有全文入口 ⇒ 摘要文本里不会有 ⇒ 压缩后主模型不知道存在全文文件（推论 3 的永久记忆缺失）。
5. **即使幸存也可能失效**：全文落盘文件有 7 天保留期，过期清理（`truncate.ts:12, 53-66`）。

**影响推演——两种工具各丢一半。** shell 的情形恰好是镜像：shell 自己的截断把全文路径放在**头部**（`shell.ts:579`），所以路径能在 2,000 字符头切中幸存；但被切掉的是尾部的 `<shell_metadata>` 超时/中断诊断。也就是说：通用工具丢"全文入口"、shell 丢"尾部诊断"，同一个 2,000 字符头部截断对两类 hint 各切一刀——**没有任何一种现有布局能整体幸存**。还要纠正 issue 原文的一个含糊处：由于 `direction` 从未被覆盖，"hint 在尾部"是所有通用工具的**常态**而非边缘情况；大输出工具在摘要中丢全文入口不是概率事件，是必然事件。

**双 runtime。** core runner（§2.3）持有一份几乎相同的 serialize 和同款常量（`core/session/compaction.ts:14, 95-121`）。只修 opencode 一份，serve / sdk-next 用户带病。

**修复约束。** ① serialize 对 completed 工具结果改为**头尾双侧保留**（尾部保留量以能装下 hint 与诊断为限），≤2,000 字符的结果保持原样；② serialize 补一行 metadata 摘要（`exit`，与决策 B 的读方投影共用逻辑）；③ 两份 serialize 必须同步——组织方式（抽共享 helper 还是两处复制）是一个真实决策；④ core 侧有一个测试以精确字符串固化了 serialize 的拼接格式（`core/test/session-compaction.test.ts:45`），行为变更后该测试需随之更新，理由写入修复文档。→ **决策 D**（§4.3）。

---

## 4. 决策点：P0 三项

### 4.0 概览

| 决策 | 问题 | 倾向 |
|---|---|---|
| B | shell 退出码的投影位置与标注范围 | B2 读方投影；只标非零；非零不渲染成 error |
| C | structuredContent 合并策略；错误路径是否拆分 | 追加 + 判等去重；错误路径单独立小 PR |
| D | serialize 头尾保留的组织方式 | 抽 core 共享 helper，两侧 import |

### 4.1 决策 B：shell 退出码怎么投影

**要达成什么**：模型能区分 `exit 0` 与非零退出；同一退出码在即时结果、重放、摘要三种场景含义一致；不给每个成功命令增加噪音。

**前置事实：为什么只投影 exit。** 在定方案前我们把全部内置工具的 metadata 盘点了一遍（附录 A.1）。判断标准是"模型无法从正文推断、且对后续决策有价值"。结果：**只有 bash 的 `exit` 满足**。其余字段要么已进正文（全文路径、截断标记都有 hint 文本），要么是纯 UI 字段（diff、read 的显示卡片、todo 列表——有的体积很大）。这个盘点直接否决了"做一套通用 metadata 投影 + 字段 allowlist"的方案：为一个大字段设计排除契约，去服务一个真正需要投影的字段，不符合我们"没有第二个消费者就不抽公共层"的惯例。投影应当**窄**。

**选项推演。**

- **B1（写方）**：shell.ts 把 `[exit code: 7]` 之类拼进 output 文本。表面看是一处改动；并且因为"存储的内容"和"给模型的内容"从此是同一份，重放、摘要、UI 全部自动一致——这是它最实在的优点。代价有三：UI 正文会重复显示退出码（footer 已经显示 `bash completed (exit 7)`）；现有 shell 输出快照测试要跟着改；`!cmd` 路径是另一段独立组装代码，要再写一份同样格式。
- **B2（读方）**：message-v2 转换时按 `metadata.exit !== undefined` 的**字段存在性**翻译出一行状态文本；serialize 侧由决策 D 的 metadata 行承担。两点设计细节：按字段存在性而不是工具名（`part.tool === "bash"`）驱动，未来任何记录 exit 的工具自动受益，也不用维护工具清单；`!cmd` 路径只要补记一行 metadata，两个读方就自动覆盖它。代价是"给模型的内容"出现两个 formatter（重放 + 摘要），必须保持一致——但决策 D 本来就要求改 serialize，同一个 helper 在两处复用即可，这个代价被 D 吸收了。

**倾向：B2。** B1 的"一处改动"是表象——`!cmd` 让写方实际也要修两处；而 B2 的"两处读方"正好与 D 合流。存储与 UI 保持干净、快照不动，是额外收益。

**待确认**：① B1 vs B2；② 标注范围——倾向**只标非零**（`exit 0` 静默，避免长会话里每个成功命令都多一行）；③ 确认非零**不**渲染成工具错误语义（`grep` 无匹配返回 1 是合法结果，标成 error 会误导模型的下一步决策）——issue 原文"不能机械地把所有非零值视为相同故障"就是这个意思。

### 4.2 决策 C：structuredContent 的合并策略

**要达成什么**：MCP 返回的机器可读数据不再丢失；正文与结构化内容并存时不重复灌入；`resource_link` / `audio` 不再静默消失；不与上游的有意设计对抗。

**事实基础**：§3.2 已确立四条约束（修投影层不修 catalog；默认路径与 code-mode 互斥；仓库内无现成判等逻辑；错误路径独立）。再补一条仓库内先例：code-mode 的 `projectMcpResult`（`code-mode.ts:75-116`）演示了 resource_link 的文本格式（`${name}: ${uri}`）和纯附件结果的占位格式（`[N files attached...]`）；投影层的方括号占位先例是 `[Binary MCP resource omitted: ...]`（方括号 + 原因 + 可定位标识）。

**选项推演。**

- **替代**（code-mode 式）：structuredContent 存在就直接替代正文。在 code-mode 里成立，因为它的消费者是 JSON 解释器。但在默认路径里，`content` 的文本往往承载服务器想说的自然语言上下文，替代会把它丢掉——从一个丢失换成另一个丢失。
- **追加 + 判等去重**（倾向）：把 `JSON.stringify(structuredContent)` 以带标签的块追加到正文之后；追加前做一次判等——若与某个 content text 项**严格相等**则跳过（覆盖"服务器把数据在两个通道里原样重复"的常见情形；判等逻辑需要新写，仓库没有现成的）。追加的文本并入同一次 `truncate.output` 调用，受既有 2,000 行 / 50KB 上限约束——超大输出 + 超大结构化数据的病例场景接受截断，不为它单独设预算。
- `resource_link`：沿用 code-mode 的 `${name}: ${uri}` 文本行。`audio`：写方括号占位（mime + 大小），不尝试走附件通道（部分 provider 不支持工具结果带音频，不值得为它做 provider 适配）。

**错误路径拆不拆**：修它要同步改 catalog 与 code-mode 两处逐字重复的 throw，让错误 message 携带 structuredContent 摘要；会改变插件可观察的错误文案。它与投影修复的代码位置、测试、风险都不同。**倾向拆成独立小 PR**，避免一个 PR 背两个语义变更。

**待确认**：① 追加 vs 替代；② 判等用严格相等（倾向）还是包含判定；③ 错误路径拆分是否同意。

### 4.3 决策 D：serialize 的头尾保留与两份实现的组织

**要达成什么**：摘要输入不再系统性丢失全文入口与尾部诊断；退出码等 metadata 在摘要中可存活；两套 runtime 行为一致。

**方案本体（争议小，先陈述）**：completed 工具结果改为"头 N + 尾 M"双侧保留——M 以装下 hint（约 200 字符）与 `<shell_metadata>`（约 200 字符）为限，取 400～800 量级；结果 ≤2,000 字符时保持原样；外加一行 metadata 摘要（`[exit code: N]`，仅非零时，与 B2 共用 helper）。error 结果维持不截断。

**真正的分叉：两份 serialize 怎么组织。**

- **抽共享 helper**：把"头尾截断 + metadata 行"放进 core（opencode 本来就从 core import `buildPrompt`，有先例），两侧 import。理由：到今天为止这个逻辑已经有了**两个真实消费者**（V1 主循环 + V2 runner）——恰好满足我们"等第二个消费者出现再合并"的成立条件；且两份实现各自漂移正是这个 bug 能存在的原因，合并从结构上防复发。
- **两处各自修 + 交叉注释**：改动更局部，未来 upstream sync 的冲突面更小（上游可能同时改这两个文件，共享 helper 会把冲突从"两处小改"变成"一处重构 + 两处调用点"）。

**倾向：抽共享 helper。** sync 冲突是定期一次性的成本，而双份漂移是持续性的正确性风险；且本项目已经决定长期维护这条 V2 链（git 历史为证）。

**配套事项**：core 的 `session-compaction.test.ts:45` 以精确字符串固化了 serialize 输出格式，需随行为变更更新——按流程这属于"用例固化了旧契约"，更新理由必须写进修复文档，不允许静默改测试。7 天保留期问题不在本项处理，移交 §5.2 作为恢复设计的输入。

**待确认**：① 抽 helper vs 两处复制；② N/M 具体配比（细节，可在修正方案文档定稿）；③ serialize 保留量是否纳入配置（倾向：暂不配置，先固定值，有真实需求再加）。

---

## 5. P1 两个方向：现状盘点与关键分叉

P1 两项是**新能力/新契约**，走完整设计流程；本节只把"设计必须建立在哪些事实之上"和"哪些分叉需要先拍板"讲清楚。

### 5.1 提示词统一

**背景：一次请求的 system 是怎么拼出来的。** 收口在 `session/llm/request.ts::preparePayload`，按顺序：① 模型行为模板——`system.ts::provider(model)` 按 model id 从 10 份 `.txt` 里选一份；但这里有一个**三元互斥**（`request.ts:195`）：如果当前 agent 配置了显式 `prompt`，则**整体替换**模型模板。② 环境信息（cwd、git、日期）。③ 项目指令（AGENTS.md / CLAUDE.md）。④ MCP instructions。⑤ skills 清单。最后全部 join 成**一个字符串**。

**替换语义的后果（这是统一方案的第一个约束）。** 内置子代理 `general` / `build` / `plan` 没有显式 prompt，继承父会话的模型模板；而 `explore` / `compaction` / `title` / `summary` 和用户自定义 agent 都有显式 prompt——它们**拿不到模型模板里的任何行为规则**。由此直接推出：如果做一段"所有 agent 都该有的共享行为段"，把它放进 `system.ts::provider`（模型模板）是**结构性错误**——显式 prompt 的三元会把连它一起换掉。唯一结构正确的位置是 `request.ts:195` 三元**之后**：所有模型、所有子代理必然带上，天然利用"后置覆盖"压平模板间冲突，且位于缓存前缀稳定的区间。这条结论基本没有反方案，剩下的是产品问题。

**现状有多不一致。** 对五类行为规则逐一核对 10 份模板（附录 A.3 矩阵）：default 与 trinity 几乎是同一份的两个副本；"修改后是否解释"在 gpt / gpt-astra / codex 与 default / trinity 之间**方向完全相反**；只有 default / trinity 绝对禁注释（L68/L70），其余是条件允许；持续执行与完成判据只在部分模板存在。**委派策略**更是横跨整个光谱：anthropic 最强鼓励（"proactively / CRITICAL"）、default 仅检索鼓励、gpt-astra 明文禁止（除非用户明确要求）。不先解决覆盖优先级，模板内部就自相矛盾。

**待拍板的两个产品问题。**

1. **委派方向**：fork 重仓了 agent-management（异步 `agent_list/send/stop` + roster reminder 注入 + PR #43 的 TUI 面），default 模板的"检索优先委派 + 不要轮询 + 异步语义说明"与这套特性**自洽**；gpt-astra 的"默认禁止委派"与 fork 自己的特性相悖。**倾向跟 fork 自己的特性走**（default 式），但这本质是产品定位问题，需要你定。
2. **第一步刀法**：10 份模板一次性统一是大工程且高风险。**倾向最小刀法**——先插入共享行为段 + 只删 default / trinity 里三条硬冲突（强制 <4 行、修改后不解释、绝对禁注释），其余模板的软性表述保留，冲突矩阵记入设计文档供后续迭代。共享段的具体文案（完成判据、steering、验证与真实报告）需要单独过稿。

**顺手项**：`copilot-gpt-5.txt` 与 `plan-reminder-anthropic.txt` 两个模板全仓零引用（死文件），可独立小 PR 删除。

### 5.2 压缩后恢复

**背景：压缩后模型实际上还剩什么。** 按 §2.2 的重排，压缩后的上下文 = 摘要 + tail 原文 + 每轮固定注入（系统提示词全量重建、plan/build-switch reminder、agent roster、工具定义）。对照"一个长任务恢复工作需要什么"，缺口是：

| 缺口 | 现状 |
|---|---|
| 已加载 skill 的正文 | 只存在于工具 part 的 output 里；进摘要就只剩 2,000 字符版 |
| todo 列表 | 有 DB 表（`session/todo.ts:29-66`）但**没有任何注入模型的路径**，模型只能自己调 `todowrite` 间接读 |
| 读取过/编辑过的文件 | 无回填；版本可能已变，模型只能靠摘要里的记忆去猜要不要重读 |
| 后台任务 / 子代理 | 子代理有 roster 覆盖（见下）；`BackgroundJob` 本身非持久化、无注入 |
| plan | 有 reminder 注入，但依赖 `agent === "plan"` 这个历史标志，压缩后可能被抹掉（潜在缺陷） |

**已有的三个关键资产（设计不需要从零开始）。** ① `reminders.ts::applyAgentRoster`（`reminders.ts:56-153`）已经实现了一套完整的"压缩后重注入"模式：触发判据 `compaction 发生过 且 此后没有同类注入` → 重建内容 → **落库**为 last user message 上的 synthetic part → 与上一份逐字节相同则跳过。这个模式可以直接泛化给其他恢复材料。② `session.compacted` 事件（`compaction.ts:583` 发布）语义准确但**目前没有任何生产消费方**——一个完全空闲的触发信号。③ 恢复材料的自然装配点已经存在：`prompt.ts:1323-1332` 的 turn-boundary 管线，而不是 compaction.ts 内部。一个硬约束：恢复 part 必须写在 `tail_start_id` 指向的消息之后（或挂在 compaction 消息上），否则会被 `filterCompacted` 的第一阶段截断逻辑丢掉。

**两个设计分叉（进设计流程前需要拍板）。**

1. **文件恢复策略**：磁盘重读（CC 式）还是缓存回填（ZCode 式）？缓存的版本可能已过时（文件被本 agent、其他 agent 或用户改过），恢复旧缓存会让模型沿用过时内容；磁盘重读能拿到当前版本，但要处理"按需选择哪些文件、与 tail 原文去重、文件已删除/过大时的降级"。**倾向磁盘重读**：候选集从 read/edit 工具 part 的 metadata 里取（path 是现成的），按最近使用排序取 top-K、预算封顶、与 tail 同版本去重。
2. **契约刀法（与 issue 原文有出入，需裁决）**：issue 要求定义"恢复扩展契约"（插件可返回恢复材料）。但今天没有任何插件消费者，`session.compacted` 事件都还空闲着。**倾向 v1 只做内部恢复**（文件 / todo / skill / roster），把插件契约记为"引入条件 + 可复用件"延后——事件和挂点都在，将来加契约成本低，而且能被真实需求塑形，避免为不存在的消费者设计 API。

**待确认**：① 文件恢复取磁盘重读还是缓存回填；② v1 契约刀法；③ todo / skill 恢复的优先级排序（可进设计阶段再定）。

---

## 6. 流程归类、实施顺序与上游风险

**流程归类**（依据 docs/workflow.md）：

| 项 | 流程 | 形态 |
|---|---|---|
| P0-1 / P0-2 / P0-3 | §7：修正方案文档（§7.1 八部分）+ 回归测试，逐项确认后实施 | 三个独立小 PR；P0-2 错误路径可拆第四个 |
| 死文件清理 | 直接删 | 小 PR，可并入 P0-1 |
| 提示词统一 | §4 全流程：调研 → 架构 → 细化 → 审查 | feature：`docs/design/prompt-unification/` |
| 压缩恢复 | §4 全流程；若含插件契约则加子计划 + §6 v2 审核 | feature |
| grep 扩展 / 后台 shell | P2，暂缓 | 方向已明：grep 走 schema 向后兼容扩展；后台 shell 独立立项 |

**实施顺序的依据**：P0 三项是投影/截断缺口，验收标准在 issue §五 里已经写好，且提示词里描述的行为（如实报告、验证）依赖这些 runtime 语义先成立——issue 自己也说"修改 prompt 不能替代 runtime 修复"。所以先 P0 后 P1。

**上游风险（时序约束）**：upstream（anomalyco）dev 已领先 112 个提交，并把子代理工具从 `agent` 改名为 `task`（波及 `default.txt`、`anthropic.txt`、`truncate.ts` 的 hint、`tools.ts` 的类型），与 fork 的 agent-management 特性区正面重叠——下次 sync 的冲突会集中在那里。本文涉及的修复文件与上游演化区重叠但不冲突。**结论：P0 宜尽早做**；另注意 `contextOverflowFromMessage` 是 fork 独有的恢复逻辑（上游从未有过），sync 时防止被上游重构覆盖。

---

## 7. 待拍板问题清单

| # | 问题 | 倾向 | 详见 |
|---|---|---|---|
| 1 | B① exit 投影位置：写方（B1）vs 读方（B2） | B2 | §4.1 |
| 2 | B② 标注范围：只标非零 vs 全标 | 只标非零 | §4.1 |
| 3 | B③ 非零不渲染成 error 语义 | 确认 | §4.1 |
| 4 | C① structuredContent 追加 vs 替代 | 追加 + 判等去重 | §4.2 |
| 5 | C③ 错误路径是否拆独立 PR | 拆 | §4.2 |
| 6 | D① 头尾截断抽 core helper vs 两处复制 | 抽 helper | §4.3 |
| 7 | E① 委派策略方向 | 跟 fork 特性走（default 式） | §5.1 |
| 8 | E①' 共享段位置（request.ts 三元之后） | 基本无反方案，默认通过 | §5.1 |
| 9 | F① 文件恢复：磁盘重读 vs 缓存回填 | 磁盘重读 | §5.2 |
| 10 | F② 恢复契约 v1 内部 vs 全量 | v1 内部，契约延后 | §5.2 |

---

## 附录 A：关键事实索引

### A.1 工具 metadata 盘点（决策 B 的依据）

注册表 `tool/registry.ts:250-259`；shell 工具对外 id 是 `"bash"`（`shell/id.ts:14`，兼容保留）。

| 工具 | metadata 字段 | 模型可否从正文推断 |
|---|---|---|
| bash | `output`(UI 预览) / `exit` / `truncated` / `outputPath` | **exit 从不进正文（唯一不可推断项）**；truncated / outputPath 已在正文 hint |
| read | `preview` / `truncated` / `loaded` / `display` | truncated 已印出；其余 UI-only |
| glob / grep | `count` / `matches` / `truncated` | 数量可数；grep 截断已印出（glob 未印出，次级） |
| edit / write / patch | `diagnostics` / `diff` 等 | 诊断非空时已进正文；diff UI-only |
| todo / lsp / question | — | 完全冗余（output 即 JSON 全文） |
| agent 系列 | `sessionId` / `model` / `count` | 正文已列 |
| code-mode | `toolCalls[]` / `error?` | 未进正文（次级价值） |
| 插件工具 | 任意 + 框架注入 `truncated` / `outputPath`（`registry.ts:182-196`） | outputPath 冗余 |

### A.2 摘要与恢复机制索引（§5.2 的依据）

- 摘要请求形状：无工具，系统提示词为 `agent/prompt/compaction.txt`，单条内联 user 消息（`compaction.ts:449-472`）。
- 摘要消息在上下文中以普通 assistant 消息出现，无特殊标记；compaction user 消息渲染为固定文本 `"What did we do so far?"`（`message-v2.ts:233-238`）。
- 多次压缩：旧压缩对从摘要输入中剔除、最后一份旧摘要作为增量合并的输入（`compaction.ts:387-390`）；模型上下文里的旧内容靠 `tail_start_id` 截断自然消失。
- 插件钩子：`experimental.session.compacting`（压缩前注入 context，`compaction.ts:397-401`）、`experimental.compaction.autocontinue`（`:529-546`）；`session.compacted` 事件无生产消费方。

### A.3 提示词冲突矩阵（§5.1 的依据；✅ 硬性明文 / ◐ 软性或相反 / ❌ 未提及）

| 规则 | default | anthropic | beast | gemini | gpt | gpt-astra | kimi | meta | codex | trinity |
|---|---|---|---|---|---|---|---|---|---|---|
| (a) 强制极短回答 | ✅ L19,L85 | ◐ | ❌(要求 thorough) | ◐ | ◐ | ◐ | ◐ | ◐ | ◐ | ✅ L11,L89 |
| (b) 修改后不解释/不总结 | ✅ L18,L58 | ❌ | ❌ | ✅ L12,L43 | ❌(反向:要求解释) | ❌(反向:要求 commentary) | ◐ | ❌ | ❌(反向:要求总结) | ✅ L10,L60 |
| (c) 绝对禁注释 | ✅ L68 | ❌ | ❌ | ◐ | ◐ | ❌ | ❌ | ◐ | ◐ | ✅ L70 |
| (d) 持续执行/完成判据 | ❌ | ❌ | ✅ | ◐ | ✅ | ✅ | ✅ | ◐ | ◐ | ❌ |
| (e) steering/途中消息 | ❌ | ❌ | ❌ | ❌ | ◐ | ✅ L27 | ◐ | ✅ L25 | ❌ | ❌ |

委派光谱：anthropic（最强鼓励）> meta（并行拆分）> default/trinity（仅检索鼓励 + 异步说明）> kimi（条件允许）> beast/gemini/gpt/codex（不提）> gpt-astra（禁止）。

### A.4 P0 断言核实补充（正文未展开的细节）

- 重放截断参数 `toolOutputMaxChars` 仅测试传值（`test/session/message-v2.test.ts:793`），生产无二次截断。
- error 分支（`message-v2.ts:330-353`）：`metadata.interrupted === true` 时发正常 `output-available`（文本为部分输出），否则 `output-error`；`interrupted` 由 `processor.ts:749-761` 打上。
- code-mode 的错误 throw 与 catalog 逐字重复（`code-mode.ts:161-167`）；`experimentalCodeMode` 默认 false（`runtime-flags.ts:47`）。
- core 测试现状：`serializeToolContent` 格式被精确固化（`core/test/session-compaction.test.ts:45`），2,000 截断本身无测试锁定。
