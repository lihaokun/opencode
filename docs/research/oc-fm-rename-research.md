# 调研报告 — oc-fm 改名（与官方 opencode 分离用户可见层）

> feature：`oc-fm-rename`；issue：#66。本文覆盖步骤 1（二进制名、安装目录、数据/缓存/状态目录、数据库名、环境变量前缀、配置与凭据二选一读取）。由 issue #66 的"分步"第 1 步界定范围；项目级 `.oc-fm/` 二选一（步骤 2）、TUI 标志与上游托管服务（步骤 3）不在本文档内，另行扩充。

## 1. 现状梳理（`dev@38c77caf41` 实测）

### 1.1 系统目录：一处常量决定四个目录

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

### 1.2 数据库名：渠道后缀

`packages/core/src/database/database.ts:41-55`：`Flag.OPENCODE_DB` 优先（`:memory:`/绝对路径直用）；否则渠道为 `latest|beta|prod` 或 `OPENCODE_DISABLE_CHANNEL_DB` 置位时 `opencode.db`，否则 `opencode-<channel>.db`。fork 发布构建固定 `OPENCODE_CHANNEL=dev`（`fork-release.yml`），故 release 用户当前是 `opencode-dev.db`。目标名 `oc-fm.db`（去渠道后缀）。

本机现状印证 issue：`~/.local/share/opencode/` 下同时有 fork 的 7.4 GB 与官方的 455 MB 数据。

### 1.3 安装目录识别与二进制

- `installation/index.ts:175-176`：`process.execPath` 含 `.opencode/bin` 或 `.local/bin` → 判为 `curl` 安装。这是自动更新目标路径的依据（#65 依赖）。
- `cli/cmd/uninstall.ts`：删除 `Global.Path.{data,cache,config,state}` + `process.execPath`（curl 方式），npm/brew 等方式给出对应卸载命令。
- 构建产物名：`script/build.ts:179` `outfile: dist/<name>/bin/opencode`；`packages/opencode/package.json` `"bin": {"opencode": "./bin/opencode"}`；`fork-release.yml` 打包 `opencode-<os>-<arch>`。
- 同目录捆绑二进制：`rg`（fork-release 构建并放进 `bin/`，见 `fork-release.yml` 对 ripgrep 的说明）。

### 1.4 项目级文件与目录名

- `config/paths.ts:17-22`：`ConfigPaths.files(name, ...)` 已参数化，调用处 `config.ts:432` 传 `"opencode"` → 找 `opencode.json(c)`。
- `config/paths.ts:29,35`：向上扫描目标硬编码 `".opencode"`。
- 全局配置文件：`config.ts:274-276` 读 `Global.Path.config` 下的 `opencode.json(c)`。
- 硬编码 `".opencode"` 的文件共 13 个（core 2 + opencode 11，含 `session.ts` 的 `.opencode-version` 快照标记、`plugin/install.ts`、`skill/index.ts`、各 cli cmd）；引用 `opencode.json` 字面量的 13 个（含纯文案报错提示，如 `cli/error.ts`、`tui/util/error.ts`）。
- 内部包名 `@opencode-ai/*`、import 路径、目录结构**暂不改**。原边界理由（同步上游冲突面）已随"fork 不再与上游同步"的基线声明（2026-10-26，见 §2）失效；维持不改的理由改为纯成本收益：内部包名对用户不可见，全仓改名只有 churn 没有用户价值。若后续要把代码身份也去 opencode 化，解除本条即可，无外部依赖。

### 1.5 环境变量

`grep -rhoE "OPENCODE_[A-Z0-9_]+"` 实测 **92 个**不同名字（issue 写 33 是指 Flag 模块注册的开关数）。分布：

- `core/src/flag/flag.ts` 集中注册约 44 处（模块加载时读 `process.env`，非懒取）；
- 其余散在 `InstallationChannel/Version` define、测试隔离（`OPENCODE_TEST_HOME` 等）、server 间握手（`OPENCODE_SERVER_PASSWORD`）、构建注入（`OPENCODE_VERSION`、`OPENCODE_MODELS_DEV` 等）。

### 1.6 凭据文件

`auth/index.ts:10` → `<data>/auth.json`；`mcp/auth.ts:37` → `<data>/mcp-auth.json`。都在 `Global.Path.data` 下，改目录名后自然分离。issue 要求"oc-fm 自己的没有就用 opencode 的"。

### 1.7 写入面（跟着读取走的关键点）

- `config/config.ts`：`ensureGitignore`（往配置目录写 `.gitignore`）+ 上述 SDK 安装（#67 已改为只有本地插件才装、钉 SDK 版本）。借用的目录被写入的入口就是这两处 + `loadGlobal` 的 legacy 迁移写（`config.ts:287` 把旧 `config` 目录内容写成 `config.json`）。
- `config/tui.ts`：同一套安装逻辑（#67 已改）。
- `plugin/install.ts`（`opencode plugin add` 等命令写 `package.json` / `node_modules`）。

## 2. 方案修订（2026-10-26，用户裁决：只保留 fork release 分发）

用户裁决：**本 fork 只提供从 fork release 下载安装这一种分发方式**。npm/brew/choco/scoop 等包管理器路径不属于本 fork 的分发途径，对应代码应移除（不是"保持现状"）。

### 2.1 受影响代码面（`dev@f9ed5e63ed` 实测）

`packages/opencode/src/installation/index.ts`：

- `Method` 类型收缩：`"curl" | "npm" | "yarn" | "pnpm" | "bun" | "brew" | "scoop" | "choco" | "unknown"` → `"curl" | "unknown"`（unknown 保留给本地开发/未识别路径）。
- `method()`（174-207 行）：删除 7 个包管理器的 checks 数组与 execPath 排序逻辑；只保留 `.oc-fm/bin`（原 `.opencode/bin`，#66 步骤 1 改名）与 `.local/bin` 两个 curl 识别分支，其余返回 `"unknown"`。
- `latest()`（208-264 行）：删除 brew（tap/formulae 两分支）、npm/bun/pnpm registry、choco、scoop 共 5 个源；curl/unknown 统一走 GitHub API（#65 改为 `lihaokun/opencode`，双渠道）。
- `upgrade()`（265-321 行）：删除 npm/pnpm/bun/brew/choco/scoop 六个 case；只保留 curl 进程内替换（#65 重新实现，替换 `upgradeCurl` 的上游脚本方案）。
- 删除随之无引用的 schema 与 helper：`NpmPackage`、`BrewFormula`、`BrewInfoV2`、`ChocoPackage`、`ScoopManifest`、`getBrewFormula`、`upgradeScriptShell`、`NpmConfig` import。

`packages/opencode/src/cli/cmd/uninstall.ts`：

- method 参数化的包管理器卸载命令映射表（npm/pnpm/bun/yarn/brew/choco/scoop）整体删除；保留 curl 的二进制与 shell PATH 清理。unknown 时只清目录（现状语义不变）。

`packages/opencode/src/cli/cmd/upgrade.ts`：

- `--method` 选项删除（无可选方法）；调用面随 `method()` 收缩自然简化。

`packages/opencode/src/cli/upgrade.ts`（自动更新入口）、server 侧（`httpapi/handlers/global.ts:90-93`）：

- 接口签名收缩后调用面自然简化；`global.upgrade` 的 `method === "unknown"` 400 分支保留（语义不变：本地构建不可自升级）。

### 2.2 不受影响 / 显式保留

- `InstallationVersion`、`InstallationChannel`、`userAgent()`（User-Agent 不改，issue 边界 3）。
- `getReleaseType`（#65 沿用其语义做基线变化提示）。
- GitHub release 下载/校验/替换（资产名 `oc-fm-<os>-<arch>`，#66 步骤 1 定名）——唯一升级通道的执行体。
- fork-release workflow（唯一发布通道，保持）。

### 2.3 与 #65 的关系

本裁决把 issue #65"要点 5"（npm、brew 等不是本 fork 的分发途径，保持现状或直接不更新）从"保持现状"升级为"移除代码"。移除动作归入 **#66 步骤 1** 一并落（method()/upgrade() 的分支面正被 #66 改），#65 设计不再为多包管理器路径留接口。

### 2.4 风险

- 从 npm/brew 装过官方版的用户切到 fork：卸载官方包不属于 fork 工具链职责（`uninstall` 只清 fork 自己的），FORK_INSTALL.md 写明先卸官方包再装 fork。
- （2026-10-26 作废一条：原记"上游同步该文件必冲突"——基线声明后 fork 不再与上游同步，同步冲突不再是风险面。）

## 3. 外部参照

- **Claude Code vs Codex CLI**：各自独立 `~/.claude` / `~/.codex`，互不读写；凭据独立。教训：完全隔离最简单，但本 fork 明确要继承 opencode 的配置/登录（issue 边界 2），不能照抄。
- **neovim vs vim**：`~/.config/nvim` 存在则 vim 完全忽略 `~/.vimrc`（`:%` 二选一语义），不存在也不复制。与本 issue 的"有 oc-fm 的就用 oc-fm 的，没有就读 opencode 的；从不自动创建/复制"语义一致，可作为行为基准。
- **oh-my-zsh / zprezto** 的 ZDOTDIR 二选一：同上。

## 4. 方案对比

### 4.1 系统目录切换

| 方案 | 做法 | 评价 |
|---|---|---|
| A. 常量替换 | `global.ts` 的 `app` 改 `"oc-fm"` | 一行切换 data/cache/config/state/tmp/bin/log/repos 全部；与上游同步零冲突（上游不改这一行）。**选 A** |
| B. 按平台路径表 | 各平台显式路径 | `xdg-basedir` 无平台分支，自建表反而引入平台差异 bug 面。否 |
| C. env 可切换（`OC_FM_HOME` 类） | 运行时按变量选根 | 增加 93 号环境变量与测试矩阵；issue 未要求。否，留作未来 seam |

### 4.2 配置/凭据"二选一"

| 方案 | 做法 | 评价 |
|---|---|---|
| A. 目录级整体二选一 | `~/.config/oc-fm/` 存在 → 只用它；否则用 `~/.config/opencode/`。数据/凭据同规则 | 粒度粗但语义清晰（neovim 语义）；实现点集中（`Global.Path.config`、`Global.Path.data` 的 getter 化）。**选 A** |
| B. 文件级逐个二选一 | `auth.json`、`mcp-auth.json`、各配置文件分别判断 | 判断点分散在 6+ 处，漏一处就是静默分叉；且目录级已隐含文件级（目录切了文件自然跟着走）。否 |
| C. 合并读取 | 两边都读 | issue 明确禁止（互相覆盖、矛盾）。否 |

关键实现含义：**二选一必须发生在 `Global` 模块内部**（`Path.config` / `Path.data` 的取值处），让全部现有消费者（30+ 处引用）无感知；不能在每个 consumer 里自行判断。`Global.Path` 目前是普通常量对象，需改为 getter 或模块初始化时一次性解析（`fs.existsSync` 探测）。

初始化时序约束：`global.ts` 顶层 `await mkdir` 前 must 先完成二选一探测，否则 `oc-fm` 侧目录先被创建，下次启动探测结果翻转（"存在 → 只用它"变成永远命中空目录）。这是本设计最尖锐的正确性点：**探测必须先于任何 oc-fm 侧目录创建，且"探测到借用"时不创建 oc-fm 侧目录**。

### 4.3 环境变量前缀

| 方案 | 做法 | 评价 |
|---|---|---|
| A. 读时双查 | 统一封装 `env(key)`：先查 `OC_FM_<KEY>`，无则查 `OPENCODE_<KEY>`；写入仍用 `OPENCODE_` 不动（除新代码用 `OC_FM_`） | 消费者面大（92 名 × 散布），但可以只在 `Flag` 模块 + 少量直接 `process.env` 读点做。渐进可行。**选 A 的窄化版：先只覆盖 Flag 模块 44 处 + 直接读取点清单化** |
| B. 启动时 env 别名 | 进程入口把已设的 `OC_FM_X` 拷到 `OPENCODE_X`（或反向） | 一处改动全局生效；但 92 个名字的映射表本身是维护面，且 define 注入类（`OPENCODE_VERSION`）不适用。作为 A 的实现机制之一 |
| C. 全量改名 | 92 个全部 `OC_FM_`，旧名不认 | 断裂式变更，脚本/CI/文档全断。否 |

推荐：**入口处别名（B）作为机制 + Flag 模块直查双前缀（A）作为兜底**的组合，细节在细化阶段定。测试隔离变量（`OPENCODE_TEST_HOME` 等 4 个）保持旧名——它们是开发面不是用户面。

### 4.4 数据库名

方案唯一：`database.ts` 的命名函数在渠道逻辑前加 oc-fm 分支 → 固定 `oc-fm.db`。渠道后缀机制保留给上游路径不再触达的死分支还是直接删除，细化阶段定（倾向直接删：fork 不再有"渠道数据库"概念，保留即死代码）。

## 5. 风险与开放问题

1. **探测与创建的时序**（见 3.2）——设计核心点，细化阶段必须给逐步推导。
2. **`opencode plugin add` 写借用目录**：issue 明确借用时不做后台 SDK 安装（#67 已把安装变成按需，正好收敛）；但用户显式 `plugin add` 仍会写。按 issue"写入跟着读取走"，显式操作允许写借用目录，不改。
3. **92 个 env 名的映射完整性**：别名机制若漏名，表现为"设了不生效"——用 grep 清单 + 测试固定。清单以 `grep -rhoE "OC_FM_[A-Z0-9_]+"` 与 `OPENCODE_` 对齐做 CI 检查。
4. **`uninstall.ts` 语义**：改名后 `opencode uninstall` 卸载的是 oc-fm 自己的目录；官方版的清理不在范围内（也卸不到——目录已分离）。
5. **fork-release 资产名** `oc-fm-<os>-<arch>` 与 `FORK_INSTALL.md`、release note 模板同步改。
6. **`.opencode-version`**（`session.ts`）：快照版本标记文件，属数据目录内部文件名，不必改（对外不可见）。
7. **mDNS** `opencode-<port>` / `opencode.local`：对外可见（局域网广播），列入步骤 1 改名清单（`oc-fm-<port>`）。

## 6. 初步推荐（供架构阶段确认）

- 系统目录：`global.ts` 单点改名 + `Global.Path.config/data` getter 化做二选一（探测先于创建）。
- 项目级（步骤 2，另行子计划）：`ConfigPaths` 的 `".opencode"`/`"opencode"` 常量提到一处，二选一逻辑同目录级。
- env：入口别名机制 + Flag 双查兜底；测试变量不改名。
- DB：`oc-fm.db`，删渠道后缀分支。
- 构建资产：`oc-fm`（outfile、bin 字段、fork-release 资产名、FORK_INSTALL.md）。
- 不改：内部包名、User-Agent、上游托管服务调用（步骤 3 逐个定）。
