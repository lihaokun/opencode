# 修正方案 — 空仓库（unborn HEAD）下创建 subagent 失败

- 模块：`agent-management` / `workdir`，`worktree`
- 分类：§7 step 2 第二类（边界处理遗漏）
- 状态：已实施（待提交）

## 第一部分：现象与复现

**现象**：在 `git init` 之后**尚未产生任何提交**的仓库里调用 `agent` 工具，创建必然失败，返回 `WorktreeUnavailable`：

```
could not read HEAD of /path/to/repo: fatal: ambiguous argument 'HEAD':
unknown revision or path not in the working tree.
```

必现。影响范围：只有 `agent`（创建）受影响，其余三个工具不准备工作目录。

**最小复现**：

```bash
mkdir demo && cd demo && git init -q && printf 'x\n' > a.txt
opencode run "用 agent 工具起一个 subagent 让它数 a.txt 的行数"
```

**出错代码路径**：`packages/opencode/src/agent-management/workdir.ts:66-71`

```ts
const baseDirectory = input.parentWorkdir?.path ?? ctx.directory
const head = yield* runGit(["rev-parse", "HEAD"], baseDirectory)
if (head.code !== 0) { return yield* new AgentManagement.WorktreeUnavailable({ ... }) }
```

调用链：`AgentLifecycle.create` → `AgentWorkdir.prepareWorkdir`（`Effect.fn` span 名为 `AgentWorkdir.prepare`）→ 上述分支。

**预期 vs 实际**：预期 subagent 正常创建并拿到独立工作目录；实际整体失败，无 Session、未投递 prompt。

## 第二部分：根因分析

**症状**是 `rev-parse HEAD` 非零；**根因**是 `prepare` 把「项目是 git 仓库」等同于「可以从 HEAD 切出 worktree」，漏掉了二者之间的状态：**仓库存在但无任何提交**。

现有分支只有两条：

```
vcs !== "git"  → generated_empty_workspace
否则            → generated_git_worktree（需要一个基点 commit）
```

unborn 落进第二条，而该条的前提——存在可作基点的 commit——不成立。

本方案**消除根因**：补全分支判定，并为这个状态选择一条真正适配它的构造方式。

## 第三部分：git 行为实证

非算法类 bug，无参考实现可对照，代之以对 git 自身行为的实测（git 2.43.0）：

| 命令 | exit | 说明 |
|---|---|---|
| `git rev-parse HEAD`（空仓库） | 128 | 现有代码据此报错 |
| `git rev-parse --verify -q HEAD`（空仓库） | **1** | stderr 为空 |
| `git rev-parse --verify -q HEAD`（正常仓库） | 0 | 输出 sha |
| `git rev-parse --verify -q HEAD`（非仓库） | **128** | `fatal: not a git repository` |
| `git worktree add --detach <dir>`（空仓库） | 非零 | 提示改用 `--orphan` |
| `git worktree add --orphan -b <br> <dir>`（空仓库） | **0** | **成功** |
| `git worktree add --orphan --no-checkout …` | 非零 | `'--orphan' and '--no-checkout' cannot be used together` |
| `git rev-parse --path-format=absolute --git-path info/exclude`（空仓库） | 0 | `registerIgnore` 可正常工作 |

`--verify -q` 的退出码把三种情形干净分开：`0` 可解析 / `1` unborn / `128` 真错误。

**`--orphan` 实测结果**（空仓库中执行后）：

- 用户仓库提交数仍为 **0**，HEAD 仍是 unborn，工作区文件未受影响
- 产生一个真正的 linked worktree，位于自己的分支上
- subagent 可在其中 `add` / `commit`，历史独立（其首个提交是一条根提交，无父）
- worktree 内容为空——这是**正确的**，仓库本就没有已提交内容

## 第四部分：修复方案

### 分支判定

```
vcs !== "git"                      → generated_empty_workspace（不变）
rev-parse --verify -q HEAD == 0    → generated_git_worktree（不变，用返回的 sha）
rev-parse --verify -q HEAD == 1    → generated_git_worktree（orphan）  ← 新增
      其中 worktree add --orphan 失败 → generated_empty_workspace + 在工具输出中说明原因
其它退出码                          → WorktreeUnavailable（不变）
```

### 改什么

1. `workdir.ts`：`rev-parse HEAD` → `rev-parse --verify -q HEAD`，按上表分三路；把现有「非 git → 建空目录」一段提取为内部函数 `emptyWorkspace()` 以供复用（纯提取，行为不变）
2. `worktree/index.ts` 的 `createForAgent`：入参增加可选 `orphan`，为真时命令改为
   `["worktree", "add", "--orphan", "-b", info.branch, info.directory]`
   —— **不能带 `--no-checkout`**（git 拒绝二者共用），并**跳过随后的 `git reset --hard`**（orphan 已完成检出，且无内容可 reset）

### 为什么用 `--orphan`

空仓库里不存在任何可作基点的 commit，而 `--orphan` 正是「不需要基点、在此开一条全新历史」的构造方式。它保住了本功能的承诺——**每个 subagent 拿到一个真正的 git worktree**——而不是降级成普通目录。

留下的 `opencode/<slug>` 孤儿分支不是新增副作用：正常情况下每个 subagent 本就会建一个同名分支，区别仅在于这一条没有父提交。

### 为什么不探测 git 版本

`--orphan` 需要 git ≥ 2.42，而 Ubuntu 22.04 LTS（git 2.34）、Debian 12（2.39）仍在支持期内，旧版本不可忽略。但**不解析 `git --version`**：各发行版后缀与 Windows 版本串（`2.42.0.windows.1`）都是解析的边界。改为**直接尝试、失败即降级**。旧版 git 上 `--orphan` 是未知选项，在参数解析阶段即失败，不会留下半成品目录或分支，降级是干净的。

### 降级时说明原因

降级到空工作区本身能用（开场消息已含 `Source directory:`，subagent 可用绝对路径读源目录），但**静默降级会让用户困惑**——他在一个 git 仓库里却拿到了非 git 的待遇。故在 `agent` 工具返回里追加一行说明：仓库尚无提交且当前 git 无法据此创建 worktree，工作区从空开始，源目录在何处，以及可用 `cwd` 指定位置。

**承载方式：`AgentWorkdir` 增加可选字段 `note?: string`，而不是给 `source` 增加取值。**

`WorkdirSource` 目前有三个取值，全仓库**只有一个消费者**——`lifecycle.ts:194` 的 `workdir.source === "generated_empty_workspace"`，它不是 switch 而是一次等值判断，用途只有一个：决定 subagent 收到哪段开场指令。

而「unborn + 旧 git」这一路，subagent 该收到的指令与「非 git 项目」**完全相同**。若为它新增一个 `source` 取值，那处唯一的等值判断对新值为假，subagent 会拿到错误的那段指令，必须立刻把两个值合并回去看待——一个新枚举值，唯一读它的地方却必须马上抹平它，说明它不属于这个枚举。

两者回答的是不同问题、面向不同读者：

| | 读它的 | 回答 |
|---|---|---|
| `source` | `workdirInstruction` | subagent 该收到哪段开场指令 |
| `note` | 工具输出 → 人 | 为什么这次没拿到真 worktree |

### 考虑过并否决的方案

**A. 自动创建一个空提交（`git commit --allow-empty`）再走原路径。**
否决理由：它**修改用户的 git 历史**——在用户当前分支上留下一个他没有要求的提交，而用户刚 `git init` 尚未提交，往往正是还没决定要提交什么（`.gitignore` 都可能没写）。此外还依赖 `user.name` / `user.email` 已配置，否则再失败一次。而 `--orphan` 达成同样目标且完全不触碰用户历史。

**B. 在错误文案里指示模型自己去提交。**
否决理由：那是在指示一个模型**修改用户仓库**，模型很可能执行成 `git add -A && git commit`，把整个工作区一次性提交进去。若要提及，只能作为「可以告诉用户」的建议且精确到 `--allow-empty`，不应写成对模型的指令。

**C. 旧版 git 上直接报错而非降级。**
否决理由：「unborn 仓库」与「非 git 项目」在实质上是同一种处境——都没有可供切出的已提交内容；而非 git 这条路**现在就在静默走空工作区，且无人视其为失败**。既然存在可用退路，不宜为 Ubuntu 22.04 一类环境新开一个失败模式。缺点（静默）由上节的说明文案补足。

### 修改后走一遍复现用例

`vcs === "git"` 成立 → `registerIgnore` 正常执行 → `--verify -q HEAD` 返回 1 → `createForAgent({ orphan: true })` → 得到 `<repo>/.opencode/worktrees/<slug>`，位于孤儿分支 `opencode/<slug>` 上 → 开场消息为 `Your working directory: …`，创建成功，用户仓库历史未变。

## 第五部分：正确性论证

1. **根因消除**：根因是「是 git 仓库」与「有可作基点的 commit」被当作同一条件。修复后二者分开判定，unborn 这一中间状态有了明确归属，并由一条**不需要基点**的构造方式承接——直接作用于根因，而非规避。

2. **不变量保持**：`prepare` 的 post 是「返回一个存在且可写的目录，并带上 `source` 标记」。orphan 路径复用 `createForAgent` 的既有失败处理（失败即 `WorktreeUnavailable`，且保证无 Session、未投递 prompt）；`source` 沿用既有取值 `generated_git_worktree`，**不新增取值**，故 `workdirInstruction` 的两分支渲染无须改动。降级路径复用 `emptyWorkspace()`，其 post 已由现有代码保证；新增的 `note` 是可选字段，`workdirInstruction` 不读它，因此不影响该函数的既有分支。

3. **无回归引入**：
   - `vcs !== "git"`：代码被提取为函数，调用点行为逐字不变
   - 正常 git 仓库：`--verify -q HEAD` 在有提交时返回 0 且输出同一 sha，与 `rev-parse HEAD` 等价；`createForAgent` 未传 `orphan` 时命令与现状逐字相同
   - 真错误（仓库损坏等）：退出码 128，仍然硬失败，不会被误当 unborn 而静默降级
   - `--orphan` 仅在 `--verify -q HEAD` 返回 1 时使用。这一约束是必要的：在**有提交**的仓库里误用 orphan 会让 subagent 拿到空目录、看不到项目内容

## 第六部分：测试用例清单

现有 `workdir.test.ts` 跑的是**真 git**（`{ git: true }` fixture + 真实 `Worktree.node` / `Git.node` 层，`gitOnly` 在 win32 上跳过），新用例沿用同一形态。

**如何构造 unborn 仓库**：fixture 的 `{ git: true }` **自带一个 root commit**（`fixture.ts:93`、`:149` 均为 `git commit --allow-empty`），故不能直接使用。实测最省的做法是在测试内把仓库退回 unborn，无须改动共享 fixture：

```bash
git update-ref -d refs/heads/<当前分支>
# → rev-parse --verify -q HEAD 退出码变 1
# → symbolic-ref HEAD 仍在，worktree add --orphan 可用
```

**回归测试（必做，来自第一部分）**

- R1 `prepareWorkdir` 在「git 仓库 + 零提交」下成功返回，`source === "generated_git_worktree"`，目录存在，且**用户仓库提交数仍为 0**（断言未修改用户历史）—— 去掉修复后 R1 应失败

**新增用例（举一反三）**

- N1 正常 git 仓库仍走非 orphan 路径，worktree 含基点内容（防止修复把所有仓库都降级）
- N2 非 git 项目仍返回 `generated_empty_workspace`（确认提取函数未改变原行为）
- N3 `createForAgent` 失败时降级为 `generated_empty_workspace`、带上 `note` 且不抛错

**不写自动化测试的一项，及理由**

「旧版 git 没有 `--orphan`」无法在真 git 下模拟：测试层用的是真实 `Git.node`，没有注入点，要伪造只能改 PATH 塞一个假 git，代价远超收益。N3 改为直接令 `createForAgent` 失败来覆盖**降级路径本身**——那才是这条分支里会出错的部分；「旧 git 会触发它」由第三部分的实证与文档说明承担。

## 第七部分：代码更新清单

| 文件 | 改动 | commit |
|---|---|---|
| `packages/opencode/src/agent-management/schema.ts` | `AgentWorkdir` 增加可选 `note?: string` | 见本分支提交 |
| `packages/opencode/src/agent-management/workdir.ts` | 提取 `emptyWorkspace()`；`--verify -q`；三路分支；降级时填 `note` | 见本分支提交 |
| `packages/opencode/src/worktree/index.ts` | `createForAgent` 增加 `orphan` 入参与对应命令分支 | 见本分支提交 |
| `packages/opencode/src/tool/agent.ts` | 降级时在工具输出追加说明行 | 见本分支提交 |
| `packages/opencode/test/agent-management/workdir.test.ts` | R1 / N1 / N2 / N3 / N4 | 见本分支提交 |

## 第八部分：文档更新清单

| 文档 | 是否需要改 | 理由 |
|---|---|---|
| `docs/design/agent-management/architecture.md` | ✅ 已改 | WorkdirSource 语义 + §4.4.1 分支条件补 unborn 一路 |
| `docs/design/agent-management/detailed-design.md` | ✅ 已改 | 步骤 c/d 补三路判定与 orphan 分支 |
| 用户文档 | 不需要 | 无新配置、无新概念；行为从「失败」变为「正常创建」 |

## 附：举一反三的发现（不在本次修复范围）

`packages/opencode/src/worktree/index.ts` 的通用 `create` 路径同样把 `"HEAD"` 直接当基点：

```ts
["worktree", "add", "--no-checkout", "--detach", info.directory, "HEAD"]
```

这是**上游代码**（上游同一行一字不差），影响 opencode 自身的 worktree 功能而非 agent-management。同类问题、不同归属，建议单独记 issue，不混进本次修复。
