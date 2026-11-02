# 调研报告 — fmcode 改名（与官方 opencode 分离用户可见层）

> feature：`fmcode-rename`；issue：#66（原文名 `oc-fm`，2026-10-26 经用户裁决更名 `fmcode`，见 §1.3）。本文覆盖步骤 1（二进制名、安装目录、数据/缓存/状态目录、数据库名、环境变量前缀、配置与凭据二选一读取）；项目级 `.fmcode/` 二选一（步骤 2）、TUI 标志与上游托管服务（步骤 3）不在本文档内，另行扩充。

## 1. 基线与裁决

本节汇总设计开始前已确定的边界条件与用户裁决；后续各节以此为前提。

### 1.1 与上游的基线（2026-10-26 用户声明）

本 fork 已与上游（anomalyco/opencode）实质性分叉，**不再考虑与上游同步**。设计决策不以"上游同步冲突"为约束或理由。据此：

- issue #66 边界 1（内部包名 `@opencode-ai/*` 不改）的原理由（同步冲突面）失效；**暂不改**内部包名的理由改为纯成本收益：内部名对用户不可见，全仓改名只有 churn 没有用户价值。解除无外部依赖。
- 上游托管服务（models.opencode.ai、`opencode.ai/config.json`、opncd.ai 分享、zen/console）的取舍只回答"fork 用户要不要"，无上游引力（步骤 3 逐个定）。
- issue #66 边界 3（User-Agent `opencode/<版本>` 先不改）的验证成本考量仍在：部分订阅端点可能只认该客户端身份，逐端点验证后再定，但不再是"与上游对齐"问题。

### 1.2 分发方式（2026-10-26 用户裁决）

**本 fork 只提供从 fork release 下载安装这一种分发方式。** npm/brew/choco/scoop 等包管理器路径不属于本 fork 的分发途径，对应代码**移除**（不是"保持现状"）。此裁决把 issue #65"要点 5"从"保持现状或不更新"升级为"删代码"，受影响代码面见 §4.2，归入本步骤 1 一并实施。

### 1.3 命名（2026-10-26 用户裁决）

名字定为 **`fmcode`**（替代 issue 原文的 `oc-fm`）。裁决理由：可输入性（无连字符）、构词一致（`vscode` 式"域缩写 + code"，与版本后缀 `fmv` 呼应）、派生名零转换（`FMCODE_` 前缀、`fmcode.local`）。可用性实测：PATH、本机命令、npm registry 均无冲突。"与 opencode 同源"的声明由 README 第一句承担（issue 本就要求），名字不重复承载。**注意：数据库文件名不随命名改（保持 `opencode.db`，见 §1.4），故派生名不含数据库。**

派生命名一览：

| 项目 | 现值 | 改后 |
|---|---|---|
| 二进制 / 启动命令 | `opencode` | `fmcode` |
| 安装目录 | `~/.opencode/bin` | `~/.fmcode/bin` |
| 数据目录 | `~/.local/share/opencode` | `~/.local/share/fmcode` |
| 缓存 / 状态 / 临时 | `~/.cache/opencode` 等 | `~/.cache/fmcode` 等 |
| 环境变量前缀 | `OPENCODE_*` | `FMCODE_*`（旧前缀后备，见 §5.3） |
| mDNS 服务名 | `opencode-<port>` / `opencode.local` | `fmcode-<port>` / `fmcode.local` |
| release 资产名 | `opencode-<os>-<arch>` | `fmcode-<os>-<arch>` |

不沿用 `oc-fm` 的中间形态（文档中残留的 `oc-fm`、`OC_FM_`、`.oc-fm/` 一律按 `fmcode` 理解）。

### 1.4 数据库名（2026-10-26 用户裁决）

**数据库文件名不改**，保持 `opencode.db`（及现渠道形态），路径区分由 data 目录分离承担（fmcode 的 data 永远是 `~/.local/share/fmcode/`，与 opencode 的互不覆盖）。理由：文件名对用户不可见，改名无用户价值；不改则迁移退化为"移动目录"（一条 `mv`），避免三文件（`-wal`/`-shm`）同步改名的易错操作；`path()` 函数零改动。

连带裁决（选项 b）：fork-release.yml 发布构建的 `OPENCODE_CHANNEL` 从 `dev` 改为 `latest`——release 用户得到干净的 `opencode.db`（"dev" 后缀来自构建渠道变量，对 release 用户有误导），本地 dev 构建保持 `opencode-dev.db`。渠道后缀机制本身保留，`path()` 不动。

## 2. 现状梳理（`dev@38c77caf41` 实测）

### 2.1 系统目录：一处常量决定四个目录

`packages/core/src/global.ts:10`：

```ts
const app = "opencode"
const data = path.join(xdgData!, app)      // ~/.local/share/opencode
const cache = path.join(xdgCache!, app)    // ~/.cache/opencode
const config = path.join(xdgConfig!, app)  // ~/.config/opencode
const state = path.join(xdgState!, app)    // ~/.local/state/opencode
const tmp = path.join(os.tmpdir(), app)
```

`xdg-basedir@5.1.0` 无 Windows 分支：四个 XDG 变量未设时一律回退 `$HOME/.local/share` 等 POSIX 路径（Windows 上即 `C:\Users\<u>\.local\share\opencode`）。Windows/macOS 的"对应路径"因此与 Linux 同构，设计文档只需按 XDG 变量 + `$HOME` 表述，无需为平台单独列常量表。

模块加载即建目录（`global.ts` 顶层 `await Promise.all([...mkdir])`）。改 `app` 常量即整体切换，**不自动迁移**。

派生路径：`bin` = `<cache>/bin`、`log` = `<data>/log`、`repos` = `<data>/repos`、`tmp` = `<os.tmpdir>/opencode`。

测试隔离：`Global.Path.home` 读 `OPENCODE_TEST_HOME`；`test/preload.ts` 全量重定向 XDG 四变量。改名不影响测试面。

### 2.2 数据库名：渠道后缀（本步骤不改名，见 §1.4）

`packages/core/src/database/database.ts:41-55`：`Flag.OPENCODE_DB` 优先（`:memory:`/绝对路径直用）；否则渠道为 `latest|beta|prod` 或 `OPENCODE_DISABLE_CHANNEL_DB` 置位时 `opencode.db`，否则 `opencode-<channel>.db`。fork 发布构建固定 `OPENCODE_CHANNEL=dev`（`fork-release.yml`），故 release 用户当前是 `opencode-dev.db`——选项 b 落地后变为 `opencode.db`。

本机现状印证 issue：`~/.local/share/opencode/` 下同时有 fork 的 7.4 GB 与官方的 455 MB 数据。

### 2.3 安装/升级链路（结合 §1.2 分发裁决后的形态）

- `installation/index.ts:175-176`：`process.execPath` 含 `.opencode/bin` 或 `.local/bin` → 判为 `curl` 安装。这是自动更新目标路径的依据（#65 依赖）。
- `latest()` 按 `method` 分六源查询（brew tap/formulae、npm registry、choco、scoop、fallback GitHub `anomalyco/opencode/releases/latest`）；`upgrade()` 按 `method` 分七种执行（curl 跑 `opencode.ai/install` 上游脚本 + 六种包管理器）。fork 的 curl 安装开自动更新会被换回官方版——这是 release note 目前要求 `"autoupdate": false` 的根因，#65 重做。
- `cli/cmd/uninstall.ts`：删 `Global.Path.{data,cache,config,state}` + `process.execPath`（curl 方式），包管理器方式给对应卸载命令。
- 构建产物名：`script/build.ts:179` `outfile: dist/<name>/bin/opencode`；`packages/opencode/package.json` `"bin": {"opencode": "./bin/opencode"}`；`fork-release.yml` 打包 `opencode-<os>-<arch>`。
- 同目录捆绑二进制：`rg`（fork-release 构建并放进 `bin/`）。

### 2.4 项目级文件与目录名

- `config/paths.ts:17-22`：`ConfigPaths.files(name, ...)` 已参数化，调用处 `config.ts:432` 传 `"opencode"` → 找 `opencode.json(c)`。
- `config/paths.ts:29,35`：向上扫描目标硬编码 `".opencode"`。
- 全局配置文件：`config.ts:274-276` 读 `Global.Path.config` 下的 `opencode.json(c)`。
- 硬编码 `".opencode"` 的文件共 13 个（core 2 + opencode 11，含 `session.ts` 的 `.opencode-version` 快照标记、`plugin/install.ts`、`skill/index.ts`、各 cli cmd）；引用 `opencode.json` 字面量的 13 个（含纯文案报错提示，如 `cli/error.ts`、`tui/util/error.ts`）。项目级改名为步骤 2 子计划，本步骤不动。

### 2.5 环境变量

`grep -rhoE "OPENCODE_[A-Z0-9_]+"` 实测 **92 个**不同名字（issue 写 33 是指 Flag 模块注册的开关数）。分布：

- `core/src/flag/flag.ts` 集中注册约 44 处（模块加载时读 `process.env`，非懒取）；
- 其余散在 `InstallationChannel/Version` define、测试隔离（`OPENCODE_TEST_HOME` 等）、server 间握手（`OPENCODE_SERVER_PASSWORD`）、构建注入（`OPENCODE_VERSION`、`OPENCODE_MODELS_DEV` 等）。

### 2.6 凭据文件

`auth/index.ts:10` → `<data>/auth.json`；`mcp/auth.ts:37` → `<data>/mcp-auth.json`。都在 `Global.Path.data` 下。issue 要求"fmcode 自己的没有就用 opencode 的"；**2026-10-26 用户裁决改为完全隔离：不读、不写 opencode 的凭据文件**（见设计文档架构 §4.2 偏离登记）。

### 2.7 写入面（跟着读取走的关键点）

- `config/config.ts`：`ensureGitignore`（往配置目录写 `.gitignore`）+ SDK 安装（#67 已改为只有本地插件才装、钉 SDK 版本）。借用的目录被写入的入口就是这两处 + `loadGlobal` 的 legacy 迁移写（`config.ts:287` 把旧 `config` 目录内容写成 `config.json`）。
- `config/tui.ts`：同一套安装逻辑（#67 已改）。
- `plugin/install.ts`（`plugin add` 等命令写 `package.json` / `node_modules`）。

## 3. 外部参照

- **Claude Code vs Codex CLI**：各自独立 `~/.claude` / `~/.codex`，互不读写；凭据独立。教训：完全隔离最简单，但本 fork 明确要继承 opencode 的配置/登录（issue 边界 2），不能照抄。
- **neovim vs vim**：`~/.config/nvim` 存在则 vim 完全忽略 `~/.vimrc`（二选一语义），不存在也不复制。与步骤 2 项目/全局配置二选一的既定语义一致，作为行为基准（凭据已于 2026-10-26 裁决为完全隔离，不适用此基准）。
- **oh-my-zsh / zprezto** 的 ZDOTDIR 二选一：同上。

## 4. 受影响代码面：分发收敛（§1.2 裁决的实施清单）

### 4.1 保留

- `InstallationVersion`、`InstallationChannel`、`userAgent()`（User-Agent 见 §1.1）。
- `getReleaseType`（#65 沿用其语义做基线变化提示）。
- GitHub release 下载/校验/替换（资产名 `fmcode-<os>-<arch>`）——唯一升级通道的执行体。
- fork-release workflow（唯一发布通道；`OPENCODE_CHANNEL` 改 `latest`，见 §1.4）。

### 4.2 移除

`packages/opencode/src/installation/index.ts`：

- `Method` 类型收缩：`"curl" | "npm" | "yarn" | "pnpm" | "bun" | "brew" | "scoop" | "choco" | "unknown"` → `"curl" | "unknown"`（unknown 保留给本地开发/未识别路径）。
- `method()`（174-207 行）：删除 7 个包管理器的 checks 数组与 execPath 排序逻辑；只保留 `.fmcode/bin`（原 `.opencode/bin`，随本步骤改名）与 `.local/bin` 两个 curl 识别分支，其余返回 `"unknown"`。
- `latest()`（208-264 行）：删除 brew（tap/formulae 两分支）、npm/bun/pnpm registry、choco、scoop 共 5 个源；curl/unknown 统一走 GitHub API（#65 改为 `lihaokun/opencode`，双渠道）。
- `upgrade()`（265-321 行）：删除 npm/pnpm/bun/brew/choco/scoop 六个 case；只保留 curl 进程内替换（#65 重新实现，替换 `upgradeCurl` 的上游脚本方案）。
- 删除随之无引用的 schema 与 helper：`NpmPackage`、`BrewFormula`、`BrewInfoV2`、`ChocoPackage`、`ScoopManifest`、`getBrewFormula`、`upgradeScriptShell`、`NpmConfig` import。

`packages/opencode/src/cli/cmd/uninstall.ts`：

- method 参数化的包管理器卸载命令映射表（npm/pnpm/bun/yarn/brew/choco/scoop）整体删除；保留 curl 的二进制与 shell PATH 清理。unknown 时只清目录（现状语义不变）。

`packages/opencode/src/cli/cmd/upgrade.ts`：

- `--method` 选项删除（无可选方法）；调用面随 `method()` 收缩自然简化。

`packages/opencode/src/cli/upgrade.ts`（自动更新入口）、server 侧（`httpapi/handlers/global.ts:90-93`）：

- 接口签名收缩后调用面自然简化；`global.upgrade` 的 `method === "unknown"` 400 分支保留（语义不变：本地构建不可自升级）。

### 4.3 移除的连带影响

- 从 npm/brew 装过官方版的用户切到 fork：卸载官方包不属于 fork 工具链职责（`uninstall` 只清 fmcode 自己的），FORK_INSTALL.md 写明先卸官方包再装 fork。
- 上游 `opencode.ai/install` 脚本（`upgradeCurl`）随 #65 的进程内替换方案消失——本来就在删除清单里。

## 5. 方案对比与推荐

### 5.1 系统目录切换

| 方案 | 做法 | 评价 |
|---|---|---|
| A. 常量替换 | `global.ts` 的 `app` 改 `"fmcode"` | 一行切换 data/cache/config/state/tmp/bin/log/repos 全部。**推荐 A** |
| B. 按平台路径表 | 各平台显式路径 | `xdg-basedir` 无平台分支，自建表反而引入平台差异 bug 面。否 |
| C. env 可切换（`FMCODE_HOME` 类） | 运行时按变量选根 | 增加环境变量与测试矩阵；issue 未要求。否，留作未来 seam |

### 5.2 数据目录与凭据——**已裁决（2026-10-26）：B + 凭据完全隔离**

| 方案 | 做法 | 评价 |
|---|---|---|
| A. 目录级整体二选一 | `~/.config/fmcode/` 存在 → 只用它；否则用 `~/.config/opencode/`。数据/凭据同规则 | 粒度粗但语义清晰；实现点单点化。代价：借用时 logs/snapshots 等也混在 opencode 目录。~~调研推荐~~ **被否** |
| B. issue 原文（**已选**） | 数据目录彻底分开（fmcode 首启为空），仅凭据文件文件级二选一 | 数据目录天然不混 |
| C. 合并读取 | 两边都读 | issue 明确禁止。否 |

**后续追加裁决**：凭据也完全隔离——不读、不写 opencode 的凭据文件（理由：与数据目录语义自洽；官方登录态不自动继承）。issue #66 边界 2 的凭据条款以偏离登记方式落档（架构 §4.2）。`Global` 层因此**无任何探测逻辑**：fmcode 侧目录总是创建，"探测先于创建"约束随借用方案一并作废。

### 5.3 环境变量前缀

| 方案 | 做法 | 评价 |
|---|---|---|
| A. 读时双查 | 统一封装 `env(key)`：先查 `FMCODE_<KEY>`，无则查 `OPENCODE_<KEY>` | 消费者面大（92 名 × 散布），判断点分散。否（作为机制太散） |
| B. 启动时 env 别名 | 进程入口把已设的 `FMCODE_X` 拷到 `OPENCODE_X`（仅当后者未设，显式 `OPENCODE_X` 优先） | 一处改动全局生效；92 个名字的映射表是维护面（CI grep 对齐检查兜底）；define 注入类（`OPENCODE_VERSION`）不适用也不需要。**推荐 B** |
| C. 全量改名 | 92 个全部 `FMCODE_`，旧名不认 | 断裂式变更，脚本/CI/文档全断。否 |

推荐：**入口别名（B）单一机制**。测试隔离变量（`OPENCODE_TEST_HOME` 等 4 个）、构建 define、server 握手类不进别名表——它们是开发面/机器面，不是用户面。

### 5.4 数据库名

已裁决不改名 + 选项 b（§1.4），无剩余方案对比。

### 5.5 数据目录语义（已闭合）

§5.2 裁决为 B（issue 原文）：data 彻底分开，无目录级借用；凭据亦完全隔离（架构 §4.2）。`Global` 层无探测逻辑——fmcode 侧目录总是创建，不存在"探测先于创建"约束（该约束属已被否决的借用方案）。

## 6. 风险与开放问题

1. ~~二选一粒度（§5.2）~~——已裁决 B（data 彻底分开）；凭据随后裁决为完全隔离（不读不写 opencode 的）。无开放项。
2. **`plugin add` 写借用目录**：用户显式 `plugin add` 仍会写当前生效的配置目录。按 issue"写入跟着读取走"，显式操作允许写借用目录，不改。
3. **92 个 env 名的映射完整性**：别名机制若漏名，表现为"设了不生效"——CI 检查保证 `FMCODE_` 名单 ⊆ `OPENCODE_` 名单。
4. **`uninstall.ts` 语义**：改名后 `fmcode uninstall` 卸载的是 fmcode 自己的目录；官方版的清理不在范围内（也卸不到——目录已分离）。
5. **fork-release 资产名** `fmcode-<os>-<arch>` 与 `FORK_INSTALL.md`、release note 模板同步改；`OPENCODE_CHANNEL=latest`（§1.4）。
6. **`.opencode-version`**（`session.ts`）：快照版本标记文件，属数据目录内部文件名，不必改（对外不可见）。
7. **mDNS** `opencode-<port>` / `opencode.local`：对外可见（局域网广播），列入步骤 1 改名清单（`fmcode-<port>` / `fmcode.local`）。

## 7. 初步推荐（供架构阶段确认）

- 系统目录：`global.ts` 单点改名 + `Global.Path.config/data` 一次性解析做二选一（探测先于创建，§5.5）。
- 分发收敛：§4.2 移除清单（随本步骤实施）。
- env：入口别名单一机制（§5.3 B）；测试变量不改名。
- DB：不改名 + 选项 b（§1.4），零代码改动。
- 构建资产：`fmcode`（outfile、bin 字段、fork-release 资产名、FORK_INSTALL.md）。
- 不改：内部包名（§1.1）、数据库文件名（§1.4）、User-Agent（逐端点验证后定）、项目级文件名（步骤 2）、上游托管服务调用（步骤 3 逐个定）。
