# 修正方案 — Windows PowerShell 会话命令退出码折叠

- 状态：修复完成，待回归确认（CI windows 分片）
- 日期：2026-10-21
- 对应问题：PR #60 windows unit 分片 4 个失败测试（`exit 7` 被报为 `exit 1`）；reviewer 在 PR #60 审核意见 E 组划定的独立缺陷
- 工作分支：`fix/windows-powershell-exit-code`（自 `dev` 切出）
- 影响模块：`packages/core/src/shell.ts`（args + 新 helper）、`packages/opencode/src/tool/shell.ts`（cmd）、两处对应测试
- workflow 路径：`docs/workflow.md` §7 bug-fix flow + §7.1 八部分修正方案
- 修复分类：接口层缺陷（shell 调用约定未处理 PowerShell 语义），同步补测试；不修改公共 API、schema

---

## 第一部分：现象与复现

### 现象

PR #60 的 CI windows unit 分片（2/3、3/3）共 4 个测试确定性失败，全部是同一症状：native 命令 `bun -e "process.exit(7)"` 的退出码被报为 1：

| 测试 | 期望 | 实际 |
|---|---|---|
| `loop replays a non-zero bash exit code into the next model request`（prompt.test.ts:946） | `[exit code: 7]` | `[exit code: 1]` |
| `shell records non-zero exit code in completed metadata`（prompt.test.ts:3952） | `metadata.exit == 7` | `1` |
| `completion delivers a notification message with the exit code`（shell-background.test.ts:138） | `exit 7` | `exit 1` |
| `shell_output after settle reports the real non-zero exit code`（shell-background.test.ts:268） | `status: exit 7` | `status: exit 1` |

触发条件：Windows 且解析出的会话 shell 是 PowerShell（pwsh/powershell）。Linux 不受影响。必现。

### 最小复现用例

```powershell
pwsh -NoProfile -Command "bun -e 'process.exit(7)'"
echo $LASTEXITCODE   # pwsh 自身退出码：1（原生命中码被折叠）
```

Linux 上同型命令 `sh -c 'bun -e "process.exit(7)"'` 退出码为 7，对照成立。

### 出错代码路径

- `packages/core/src/shell.ts:198` — `args()` 的 ps 分支：`["-NoProfile", "-Command", command]`（`!` 直通命令路径，consumer `packages/opencode/src/session/prompt.ts:654`）
- `packages/opencode/src/tool/shell.ts:295` — `cmd()` 的 win32+ps 分支：`["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command]`（shell 工具路径）

### 预期行为 vs 实际行为

预期：会话 shell 执行的命令，其进程退出码原样到达 `handle.exitCode`（POSIX shell 的既有语义）。
实际：PowerShell `-Command` 把最后一个原生命令的非零退出折叠为 1（`$?` 为 false ⇒ 退出 1）；若原生命令失败后又跟了成功的 PowerShell 语句，甚至折叠为 0——静默失败被报成功。

## 第二部分：根因分析

- **症状**：Windows 上 native 退出码 7 变 1。
- **根因**：PowerShell `-Command` 的退出码语义是「脚本是否成功执行」，不是「最后一个 pipeline 的退出码」。native 命令的真实退出码只写入 `$LASTEXITCODE`，不传播到 pwsh 进程退出码。`args()`/`cmd()` 按 POSIX shell 的约定传参，没有补偿这一语义差异。
- 不是绕过修复：修改的是调用约定本身，让 PowerShell 进程以最后一个 native 退出码终止，与 bash/zsh/sh 的可观察行为对齐。

## 第三部分：参考实现对照

参考实现：POSIX shell 分支自身（`core/shell.ts` `args()` 的 sh/zsh/bash 分支）与上游同类工具的通行做法（在 `-Command` 脚本尾部显式 `exit $LASTEXITCODE`）。

同一输入 `bun -e "process.exit(7)"` 的逐步差异：

| 步骤 | POSIX（sh -c） | PowerShell（pwsh -Command，修复前） | PowerShell（修复后） |
|---|---|---|---|
| 执行 native 命令 | 退出码 7 | 退出码 7，写入 `$LASTEXITCODE=7`；`$?`=false | 同左 |
| shell 进程退出码 | 7（最后 pipeline 原样传播） | 1（`$?` false ⇒ 折叠） | `exit $LASTEXITCODE` ⇒ 7 |
| 失败后跟成功语句 `...; true` | 0（`true` 是最后 pipeline） | **0（静默成功！）** | 7（`$LASTEXITCODE` 保持最后 native 码）|

差异点即根因：POSIX shell 传播最后 pipeline 的退出码，pwsh 不传播 native 码。修复后 PowerShell 与 POSIX 在「最后一条 native 命令决定退出码」上语义一致。

## 第四部分：修复方案

### 修什么

1. `packages/core/src/shell.ts`：新增导出 `psExitWrapped(command)`，返回 `` `${command}\nexit $LASTEXITCODE` ``；`args()` 的 ps 分支改用它。
2. `packages/opencode/src/tool/shell.ts`：`cmd()` 的 win32+ps 分支命令文本改用 `Shell.psExitWrapped(command)`。

### 为什么这样修（根因如何被消除）

`exit $LASTEXITCODE` 让 pwsh 进程以最后一个 native 退出码终止——正是 POSIX shell 免费提供、pwsh 缺失的那一环。语义细节（全部写在 helper 的 doc comment）：

- 无 native 命令执行过时 `$LASTEXITCODE` 为 null，`exit $null` ⇒ 0——与 POSIX 纯 builtin 成功退出 0 一致。
- 用换行而非 `;` 追加：`;` 在用户命令以 block 或 trailing pipe 结尾时解析行为不同，独立一行无此歧义。
- 终止性 PowerShell 异常（`throw` 等）在到达 wrapper 前即中止脚本，pwsh 仍以自身行为退出 1——异常与正常完成语义不同，保持 pwsh 原状，不做包装。
- 权限扫描不受影响：shell 工具的 tree-sitter 解析发生在 `cmd()` 之前、针对用户原始命令；wrapper 在 spawn 边界追加，不进权限判定。

### 参考实现是怎么做的

见第三部分对照表；`exit $LASTEXITCODE` 是 PowerShell 文档对「从脚本传播 native 退出码」的官方推荐写法。

### 修改后的预期行为（复现用例回放）

`pwsh -NoProfile -Command "bun -e 'process.exit(7)'\nexit $LASTEXITCODE"` ⇒ pwsh 退出码 7 ⇒ `handle.exitCode` = 7 ⇒ 4 个失败测试全部到达期望断言。

### 范围外（显式声明）

仓库内其他 PowerShell `-Command` 调用点（`tui/src/clipboard.ts`、`opencode/src/util/archive.ts`、`core/src/ripgrep/binary.ts`、`desktop` WSL runtime）是内部工具调用，各自有独立的错误处理与语义（有的本来就要 0/1 二值），不在「会话命令退出码投影」契约内，不改。若未来它们需要真实退出码，可复用 `psExitWrapped`。

## 第五部分：正确性论证

1. **根因消除**：折叠发生在「pwsh 进程退出码 ≠ 最后 native 码」这一步；wrapper 使 pwsh 进程退出码 = `$LASTEXITCODE` = 最后 native 码，折叠点被直接消除，非症状遮蔽。
2. **不变量保持**：
   - `args()` 对 POSIX shell 的各分支输出不变（改动仅在 ps 分支内）。
   - 退出码投影契约（`formatExitCodeLine`：仅有限非零数值出线）不变——上游喂进来的数值现在在 Windows 上也真实。
   - 纯 PowerShell 成功路径退出 0 不变（`exit $null` ⇒ 0）。
   - `cmd()` 非 win32 路径、非 ps 路径完全不变。
3. **无回归引入**：由第六部分测试覆盖——新增 native 退出码传播测试在每个已发现 shell 上运行（Linux 上 bash/sh 路径本项验证传播语义不回归；Windows CI 上 pwsh/powershell/cmd 全量验证）；core args 测试锁定 wrapper 文本；既有 `exit 42`（shell keyword）测试确认 PowerShell 关键字退出路径不受影响。

## 第六部分：测试用例清单

| 类型 | 用例描述 | 状态（修复后回填） |
|------|---------|------------------|
| 回归 | `propagates a native command's non-zero exit code`（`each` 驱动全部已发现 shell；PS shell 加 `&` 调用操作符）— CI windows 分片上 pwsh/powershell 命中原失败形态 | 已加：packages/opencode/test/tool/shell.test.ts |
| 回归 | `PowerShell command wrapper appends the $LASTEXITCODE exit`（纯函数，跨平台）| 已加：packages/core/test/shell.test.ts |
| 新增 | `PowerShell args carry the exit wrapper`（win32 门控，断言 args() 三段形状）| 已加：packages/core/test/shell.test.ts |

## 第七部分：代码更新清单

| 文件 | 函数 / 行号 | 改动概述 | 状态（修复后回填） |
|------|------------|---------|------------------|
| `packages/core/src/shell.ts` | `args()` ps 分支 + 新导出 `psExitWrapped` | ps 分支命令文本经 wrapper；helper 含完整语义 doc | 待改 |
| `packages/opencode/src/tool/shell.ts` | `cmd()` win32+ps 分支 | 命令文本改用 `Shell.psExitWrapped` | 待改 |
| `packages/core/test/shell.test.ts` | 新 test ×2 | wrapper 纯函数 + win32 args 形状 | 待改 |
| `packages/opencode/test/tool/shell.test.ts` | 新 `each` 用例 ×1 | native 退出码传播（全 shell 矩阵） | 待改 |

## 第八部分：文档更新清单

| 文档路径 | 要改什么 | 状态（修复后回填） |
|---------|---------|------------------|
| （无） | 本修复仅修内部 shell 调用约定与测试；无 schema / 行为契约文档声明 PowerShell 退出码语义，无 expectations 子计划覆盖此文件 | 无（仅实现修复）— 理由：会话 shell 的退出码契约此前未见于任何契约文档（本缺陷正是该缺口被 PR #60 投影暴露）；如 reviewer 要求把「会话命令退出码跨平台原样传播」立为契约，可后续在 prompt-unification 设计文档补记 |
