# 架构 — oc-fm 改名（与官方 opencode 分离用户可见层）

> feature：`oc-fm-rename`；子计划：`ocfm-1-user-visible-rename`（步骤 1 范围）。上游调研见 `docs/research/oc-fm-rename-research.md`；issue #66。

## 1. 核心流程

改名后 oc-fm 进程的启动路径：

```
进程启动
  → Global 模块解析（模块加载，先于一切服务）
      1. 计算原始目标根：<xdg>/<app>（app = "oc-fm"）
      2. 二选一探测（仅 config 与 data 两类）：
         config: exists(~/.config/oc-fm) ? oc-fm : ~/.config/opencode
         data:   exists(~/.local/share/oc-fm) ? oc-fm : ~/.local/share/opencode
      3. mkdir 探测胜出的目录（不创建落选的 oc-fm 目录；opencode 侧目录已存在，不建）
      4. 冻结 Path 常量（data/cache/config/state/tmp/bin/log/repos）
  → 数据库命名（database.ts）：固定 oc-fm.db（OPENCODE_DB 显式指定仍优先）
  → 配置加载（config.ts / tui.ts）：ensureGitignore + 按需 SDK 安装写入"当前生效"的配置目录
  → 其余服务照旧（全部经 Global.Path 间接取路径，无感知）
```

缓存目录（`~/.cache/oc-fm`）不参与二选一：缓存无继承价值，oc-fm 永远用自己的缓存。state 目录同理（纯 oc-fm 内部状态，无共享语义）。**参与二选一的只有 config 与 data**——前者是 issue 点名的共享面（配置、skills、agents、commands、plugins、`auth.json`、`mcp-auth.json` 都在其下），后者承载凭据文件与用户期望延续的会话数据。

## 2. 核心数据结构

```
数据结构：GlobalPaths（global.ts 模块内，重构后）

字段：
  - app: "oc-fm" — 本产品的目录名/二进制名/服务名前缀
  - borrowedConfig: boolean — 配置目录是否借用 opencode 的（探测结果）
  - borrowedData: boolean — 数据目录是否借用 opencode 的
  - data / cache / config / state / tmp / bin / log / repos: string — 解析后的绝对路径

类型不变量：
  - borrowedConfig == true ⇒ config 指向 ~/.config/opencode 且该目录存在（探测保证）
  - borrowedData   == true ⇒ data 指向 ~/.local/share/opencode 且该目录存在
  - borrowedX == false ⇒ X 目录已由本模块 mkdir（存在）
  - cache/state/tmp/bin/log/repos 恒为 oc-fm 自己的路径，与 borrowed* 无关

生命周期：
  - 创建：模块首次加载时一次性解析并冻结（常量对象，非 getter——见 §4 决策 3）
  - 修改：不允许（进程内只解析一次）
  - 删除：随进程

跨模块共享性：跨模块共享（consumer：全部经 Global.Path / Global.Service 取路径的模块，30+ 处）
```

```
数据结构：EnvAlias（入口模块，新）

字段：
  - mapping: Array<[ocFmKey, openCodeKey]> — OC_FM_X → OPENCODE_X 的别名表（显式清单，非推导）

类型不变量：
  - 别名只在 OPENCODE_X 未设置且 OC_FM_X 已设置时生效（显式 OPENCODE_X 优先，保证测试与既有脚本行为不变）
  - 表内名字逐一存在于全局 env 名单（CI grep 对齐检查）

跨模块共享性：模块私有（入口一处消费），名单本身由 CI 检查维护
```

## 3. 模块划分与功能规约

### 3.1 `core/global.ts`（改造）

```
模块名称：Global 路径解析

功能描述：解析 oc-fm 的系统目录；config 与 data 按二选一规则借用 opencode 的目录。

前置条件：
  - 进程尚未创建任何 oc-fm 侧 XDG 目录（模块加载顺序保证：本模块先于一切服务执行）
  - XDG 四变量语义同 xdg-basedir（未设回退 $HOME POSIX 路径，全平台一致）

后置条件：
  - Path 冻结且满足 §2 不变量
  - 若 borrowed，opencode 侧目录内容与本进程启动前逐字节一致（探测与 mkdir 不写借用目录）
  - 若未借用，oc-fm 侧 config/data 目录存在

副作用：
  - mkdir 探测胜出方（仅此一方）
  - 借用时记一条 info 日志，写明借用的具体路径（issue 要求的可观察性）

不变式：
  - 探测先于创建：对 exists(oc-fm 侧) 的读取发生在任何 oc-fm 侧 mkdir 之前
  - 同一进程内结果不可变
```

### 3.2 `core/database/database.ts`（改造）

```
模块名称：数据库命名

功能描述：默认数据库固定为 <data>/oc-fm.db；OPENCODE_DB 显式值仍最高优先。

前置条件：Global.Path.data 已解析（二选一完成后）。
后置条件：返回绝对路径；渠道（latest/beta/prod/其他）不再影响默认名。
副作用：无（命名函数为纯函数；建库由 sqlite 层负责）。
```

### 3.3 入口模块 `env-alias`（新增，opencode 包）

```
模块名称：环境变量别名

功能描述：进程入口最早期，把已设置的 OC_FM_X 映射到 OPENCODE_X（仅当 OPENCODE_X 未设时）。

前置条件：在任何 Flag / process.env["OPENCODE_*"] 读取之前执行（import 顺序保证）。
后置条件：对下游所有代码，效果等同用户直接设置了 OPENCODE_X。
副作用：写 process.env（仅映射到的键）。
不变式：显式 OPENCODE_X 永远胜过 OC_FM_X（测试、CI、既有脚本零感知）。
```

### 3.4 构建与发布（`script/build.ts`、`packages/opencode/package.json`、`fork-release.yml`）

```
模块名称：构建产物命名

功能描述：二进制名 opencode → oc-fm（outfile、bin 字段、dist 目录名、release 资产名 oc-fm-<os>-<arch>）；sha256sums.txt、FORK_INSTALL.md、release note 模板同步。

前置条件：无。
后置条件：构建产物与安装文档引用的名字全部一致。
副作用：无。
```

### 3.5 `installation/index.ts`、`cli/cmd/uninstall.ts`（改造）

```
模块名称：安装识别与卸载

功能描述：curl 安装识别路径 .opencode/bin → .oc-fm/bin（.local/bin 分支保留——它不属于任何产品名）；uninstall 清单随 Global.Path 自动指向 oc-fm 侧。

前置条件：Global.Path 已解析。
后置条件：method() 判定与 #65 升级目标路径一致（都在 dirname(process.execPath)）。
```

### 3.6 mDNS（`server/mdns.ts`）

```
模块名称：局域网服务名

功能描述：opencode-<port> → oc-fm-<port>；默认域 opencode.local → oc-fm.local。

后置条件：同一局域网内官方版与 oc-fm 实例广播名不冲突。
```

### 3.7 不改清单（显式）

- 内部包名 `@opencode-ai/*`、import 路径、源码目录结构（同步冲突面）。
- User-Agent `opencode/<version>`（订阅端点兼容性，issue 边界 3）。
- 上游托管服务调用（models.opencode.ai 等，步骤 3 逐个定）。
- `OPENCODE_TEST_*`、`OPENCODE_DB`、构建 define 类（`OPENCODE_VERSION`/`OPENCODE_CHANNEL`/`OPENCODE_MODELS_DEV`/`OPENCODE_PLUGIN_SDK_VERSION`）与 server 握手类（`OPENCODE_SERVER_PASSWORD` 等）环境变量——非用户面或跨进程契约，别名表不含它们。
- 项目级 `.opencode/`、`opencode.json(c)`（步骤 2 子计划）。
- TUI 标志、README 主体文案（步骤 3）。

## 4. 模块间接口规约

```
接口：入口模块 → Global（加载顺序契约）

输入：无（模块加载即执行）。
协议约定：
  - 调用方（入口）：env-alias 在 import 图中先于 core/global 求值
  - 被调用方（Global）：解析为同步、一次性；不抛错（探测失败按"未借用"处理）
```

```
接口：Global → 全部路径消费者

输入：Global.Path 常量对象（冻结后）。
协议约定：
  - 消费者不得缓存路径于模块常量（既有代码全部现取，无需改动；新增代码同样约定）
  - 消费者不感知 borrowed 与否；需要区分时（仅日志）读 Global.borrowedConfig/borrowedData
```

## 5. 关键设计决策

1. **二选一只覆盖 config 与 data**。cache/state 无共享价值，借了反而互相污染（缓存版本文件、内部状态）；issue 列的"数据、缓存、状态目录"按语义拆开处理，数据目录借（保会话/凭据延续），缓存与状态不借。
2. **探测一次性冻结而非 getter**。getter 化会让"目录在进程中途被用户创建/删除"产生观测翻转，且 mkdir 副作用不适合藏在 getter 里；模块加载时一次性解析 + 冻结符合既有 `const paths` 形态，改动面最小。
3. **借用判定用 `existsSync` 探测目录，而非探测标志文件**。用户手动建目录即完成切换（README 写明），无需额外 init 命令；neovim 同语义。
4. **env 别名显式清单而非通用前缀规则**。通用规则（任意 `OC_FM_*` → `OPENCODE_*`）会把不存在的名字静默穿透，难排查；显式清单 + CI grep 对齐检查（`OC_FM_` 名单 ⊆ `OPENCODE_` 名单 ∪ 新增名单）可机械验证。
5. **数据库去渠道后缀**。fork 只有 oc-fm 一个产品身份，渠道后缀是上游多渠道共存的机制，在本 fork 是死代码；`OPENCODE_DISABLE_CHANNEL_DB` 同删。删而非留，按 CLAUDE.md 奥卡姆剃刀（无现消费者 seam 砍掉，记录引入条件：若 fork 未来需要多渠道共存数据隔离，再引入）。
6. **`.local/bin` 安装识别分支保留**。它不携带产品名（用户自选的 PATH 目录），curl 识别语义不变。

## 6. 架构正确性论证

### goal → 模块映射

- **G1 与官方版在同一台机器并存，互不覆盖二进制与数据** → §3.4 构建命名（二进制/资产名）+ §3.1 data 二选一 + §3.2 DB 命名
- **G2 配置与凭据默认继承 opencode 的，用户有意识分隔时可切走** → §3.1 config 二选一（数据目录同规则，凭据文件在其下自然跟随）
- **G3 借用期间官方版安装/升级不受 oc-fm 干扰** → §3.1 后置条件（探测与 mkdir 不写借用目录）+ §3.7 不做后台 SDK 钉版（#67 已收敛）+ `plugin add` 显式操作除外（记录为已知边界）
- **G4 自动更新目标路径与安装位置一致（为 #65 铺路）** → §3.5 安装识别 + §3.4 安装目录（`~/.oc-fm/bin` 经 cache/bin 与 fork-release 安装说明对齐）
- **G5 环境变量逐步迁移不破坏既有脚本** → §3.3 别名（显式 OPENCODE_X 优先）

### 模块协作论证

G1：构建产物名改 oc-fm ⇒ 安装目录 `~/.oc-fm/bin` 与官方 `~/.opencode/bin` 物理分离；data 二选一使首次启动的 oc-fm 在无 `~/.local/share/oc-fm` 时借用、用户手动建目录后切换 ⇒ 二进制、数据库、会话数据三层面互不可达，G1 成立。

G2：config 二选一探测在 Global 解析时执行；借用时全部现有消费者（配置读取、auth.json、mcp-auth.json 均经 `Global.Path.config/data`）无感知读到 opencode 侧数据 ⇒ 默认继承成立；用户建 `~/.config/oc-fm` 后探测翻转，切走且不回读 ⇒ 分隔成立。

G3：借用时 oc-fm 对借用目录的全部写入 = ensureGitignore（幂等写已存在的 `.gitignore` 或新增一条）+ 按需 SDK 安装（仅当用户在该目录放了本地插件）+ 显式 `plugin add`。前两者官方版同样会做或不存在差异；第三者是用户显式指令。后台钉版安装已由 #67 消除 ⇒ 无 oc-fm 发起的静默改写，G3 成立。

### 关键假设

- H1: xdg-basedir 未设 XDG 变量时全平台回退 `$HOME/.local/{share,state}`、`$HOME/.config`、`$HOME/.cache`（源码核实，`xdg-basedir@5.1.0`）
- H2: 官方版与 oc-fm 不会同时运行写同一借用目录（无文件锁协同；若用户同时跑两边，SQLite WAL 与 flock 是既有并发机制，与改名无关）
- H3: 用户手动建 `~/.config/oc-fm` / `~/.local/share/oc-fm` 即表达切换意图（README 记载该操作；oc-fm 从不自动建这两个目录——见 §3.1 不变式）
- H4: 环境变量名单（92 个）当前完整；新增变量须同步别名表（CI grep 检查强制）

### 模块级 invariant

- I_1: 探测先于创建——任何 oc-fm 侧 XDG 目录的 mkdir 都发生在借用探测之后。维护方：core/global.ts 单点；preservation：Global 是 import 图最前端的 core 模块，目录创建无第二入口（database/config 等都经由 Global.Path，其目录已由 Global 建好）
- I_2: 进程内路径恒定——Global.Path 冻结后无任何写路径。维护方：const 冻结；preservation：类型上不导出可变引用，评审约束新增代码不得绕过
- I_3: 显式 OPENCODE_X 优先于 OC_FM_X。维护方：env-alias 单点；preservation：别名仅在 OPENCODE_X 未设时拷贝，下游只有一套 `process.env` 读点，无第二实现

## 7. 迁移（不变式：零自动迁移）

- 不写任何迁移代码。README（FORK_INSTALL.md）写手动步骤：退出全部进程 →（可选）`mkdir ~/.local/share/oc-fm` + 按 issue 给的 mv 序列改库名 →（可选）`mkdir ~/.config/oc-fm` 放独立配置。
- 借用是默认态：不建目录直接启动 = 继承官方配置与凭据、数据从零开始；建 data 目录但直接 mv 库文件 = 会话历史跟随。三个正交动作各在 README 一节。
