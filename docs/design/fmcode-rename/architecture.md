# 架构 — fmcode 改名（与官方 opencode 分离用户可见层）

> feature：`fmcode-rename`；子计划：`fmcode-1-step1`（issue #66 步骤 1 范围）。上游调研见 `docs/research/fmcode-rename-research.md`（本文引用其 §1 基线与裁决、§2 现状、§5 方案，编号一致）。issue #66 原文名 `oc-fm`，2026-10-26 用户裁决更名 `fmcode`。本文重写于 2026-10-26，全部决策已闭合。

## 1. 范围（步骤 1）

改：二进制名、安装目录、数据/缓存/状态目录、环境变量前缀（后备兼容）、凭据文件级二选一、mDNS 名、release 资产名、分发收敛（删包管理器路径，调研 §4.2）。
不改：数据库文件名（调研 §1.4）、内部包名（调研 §1.1）、User-Agent、项目级 `.opencode/`（步骤 2 子计划）、TUI 标志与上游托管服务（步骤 3）。

## 2. 核心流程

fmcode 进程启动路径：

```
进程启动
  → env 别名（index.ts 首个 import，fmcode/src/env-alias.ts，零 src 依赖）
      把已设的 FMCODE_X 拷到 OPENCODE_X（仅当 OPENCODE_X 未设）
  → Global 模块解析（core/global.ts，模块加载，先于一切服务）
      1. 计算目标根：<xdg>/fmcode
      2. mkdir <xdg>/fmcode 侧 config/data/state/cache/tmp（data/config 首启为空——§3 决策 1）
      3. 冻结 Path 常量
  → 凭据解析（auth / mcp-auth，§4 二选一）
      读：<data>/auth.json 不存在 → 读 opencode 的 ~/.local/share/opencode/auth.json
      写：写到"当前生效的那份"（自有则自有；借用则 opencode 的）
  → 数据库（database.ts）：零改动，<data>/opencode.db（data 已是 fmcode 自己的）
  → 其余服务照旧（全部经 Global.Path 间接取路径）
```

与旧稿（借用方案）的本质差别：**Global 层没有二选一探测**——data/config 永远是 fmcode 自己的，目录总是创建；二选一只存在于凭据文件的读写层。

## 3. 核心数据结构

```
数据结构：GlobalPaths（core/global.ts 模块内）

字段：
  - app: "fmcode"
  - data / cache / config / state / tmp / bin / log / repos: string — 解析后的绝对路径（全部 fmcode 侧）

类型不变量：
  - 所有路径恒为 fmcode 侧，与 opencode 目录无任何交集（凭据文件级二选一除外，归属凭据模块）

生命周期：
  - 创建：模块首次加载时 mkdir（recursive）并冻结
  - 修改：不允许
跨模块共享性：跨模块共享（consumer：30+ 处经 Global.Path / Global.Service）
```

```
数据结构：CredentialSource（凭据二选一的解析结果，函数返回值，非持久类型）

字段：
  - effectivePath: string — 当前生效的凭据文件绝对路径
  - borrowed: boolean — 是否借用 opencode 的

类型不变量：
  - borrowed == true ⇒ effectivePath 是 opencode 侧路径且该文件存在（探测保证）
  - borrowed == false ⇒ effectivePath 是 fmcode 侧路径（文件可能尚不存在，写入时创建）

跨模块共享性：模块私有（auth 与 mcp-auth 各自内部）
```

```
数据结构：EnvAlias（fmcode/src/env-alias.ts）

字段：
  - ALIASES: Array<[fmcodeKey, openCodeKey]> — 显式清单（用户面 Flag 子集，非全量 92 名）

类型不变量：
  - 别名仅在 OPENCODE_X 未设且 FMCODE_X 已设时生效
  - 清单内名字逐一存在于 OPENCODE_ 全名单（CI grep 对齐检查）
跨模块共享性：模块私有（入口一处消费）
```

## 4. 凭据文件级二选一（本设计的核心机制）

### 4.1 规约

```
模块名称：凭据二选一（auth.json 与 mcp-auth.json 各一份实现，行为相同）

功能描述：读取时优先 fmcode 自己的凭据文件，不存在则回退 opencode 的；写入写到当前生效的那份。

前置条件：Global.Path.data 已冻结。
后置条件：
  - 读：返回 effectivePath（fmcode 侧优先）的内容或"不存在"
  - 写：内容落在 effectivePath；从不创建 opencode 侧目录，从不复制/迁移对方文件
副作用：写时创建所在目录（仅 fmcode 侧；借用时 opencode 侧目录已存在）
```

### 4.2 借用状态判定（逐次判定，非进程级冻结）

`borrowed = !existsSync(<data>/auth.json) && existsSync(<opencode data>/auth.json)`

**逐调用判定**而非模块加载时冻结一次。理由：fmcode 首启 data 为空（决策 B 的直接后果），用户首次 `fmcode` 登录前每次读凭据都应回退 opencode 的；登录写入后 `auth.json` 落在 fmcode 侧，此后读自有文件——这正是"新登录写到当前生效的那份"的语义。冻结会把这个自然流变成"首启那刻借用，永远借用"，写读分裂。

### 4.3 触点清单（ borrow 感知的全部位置）

| 触点 | 文件 | 读/写 |
|---|---|---|
| 用户凭据 | `opencode/src/auth/index.ts:10` | 读 + 写（login/logout/refresh） |
| MCP 凭据 | `opencode/src/mcp/auth.ts:37` | 读 + 写 |

实测仅此两处（`Global.Path.data` 下凭据文件的全部消费者）。架构评审项：实现时 grep `auth.json`/`mcp-auth.json` 复核清单穷尽。

### 4.4 正确性论证（凭据模块）

- 前置: 决策 B（data 彻底分开）+ 触点清单穷尽
- 论证:
  - 读路径：fmcode 有 → 读 fmcode（用户显式登录过，最新语义）；无且 opencode 有 → 读 opencode（继承官方登录，issue 要求）；都无 → 未登录。三分支穷尽且互斥
  - 写路径：写"当前生效的那份"。若当前生效是借用（fmcode 无自有文件），登录写 opencode 侧——与官方版共存不冲突（官方版也写同一文件，后写覆盖，与两版各自单独运行时的行为一致）；此后 fmcode 读到的仍是 opencode 的文件（fmcode 侧始终无自有文件）——即"借用登录"持续对两版可见，符合直觉
  - 无迁移：从不复制 opencode 的 auth.json 到 fmcode 侧。借用是持续状态而非一次性引导，复制反而制造两份独立演化的副本
- 后置: issue 边界 2"凭据同一条规则"全部成立
- 副作用论证: 写仅落 effectivePath；无目录级副作用

## 5. 模块划分与功能规约

### 5.1 `core/global.ts`（改造：单常量改名）

```
模块名称：全局路径

功能描述：app 常量 "opencode" → "fmcode"；mkdir 全集照旧（fmcode 侧目录总是创建，决策 B）。

前置条件：无（模块加载即执行）。
后置条件：Path 冻结且全部为 fmcode 侧路径；opencode 侧目录不被创建也不被写入（凭据回退读除外，§4）。
不变式：进程内路径恒定；无探测逻辑（与旧稿的本质差别）。
正确性论证：trivial（字符串常量替换 + mkdir 集合同名切换；无分支变化）。
```

### 5.2 `fmcode/src/env-alias.ts`（新增）与入口接线

```
模块名称：环境变量别名

功能描述：进程入口最早期，把已设且目标未设的 FMCODE_X 拷贝为 OPENCODE_X。

前置条件：在任何 OPENCODE_* 读点前执行。实现约束：本模块零 src import；index.ts 第一行 import 本模块并立即调用 apply()（ESM import 先求值限制下的最早时点，与旧稿结论一致）。
后置条件：对下游所有代码效果等同用户直接设置了 OPENCODE_X。
不变式：显式 OPENCODE_X 永远胜过 FMCODE_X。
副作用：写 process.env（仅拷贝项）。

ALIASES 清单构成（§5.3 讨论 B 的落地口径）：
  - 收入：Flag 模块注册的用户面开关（约 44 处中可被环境覆盖的键）+ 非 Flag 的用户面直接读点（如 OPENCODE_DB、OPENCODE_CONFIG、OPENCODE_CONFIG_DIR、OPENCODE_DISABLE_AUTOUPDATE 等，实现时从 §调研 2.5 的 92 名单中按"用户面"标准逐一判定）
  - 不收：构建 define（OPENCODE_VERSION/CHANNEL/MODELS_DEV/PLUGIN_SDK_VERSION/WORKER_PATH/LIBC）、测试隔离（OPENCODE_TEST_*）、server 握手（OPENCODE_SERVER_PASSWORD/USERNAME/CONSOLE_TOKEN）、内部标记（OPENCODE_PID/CALLER/ROUTE/PLUGIN_META_FILE 等进程间契约）
正确性论证：
  - 前置: 执行时点早于一切读点（模块顺序保证）
  - 论证: 拷贝后下游读 OPENCODE_X 得 FMCODE_X 值；显式 OPENCODE_X 存在时不拷 ⇒ 不变式成立；清单完整性由 CI grep 对齐检查机械保证
  - 副作用论证: 仅 process.env 写
```

### 5.3 分发收敛（调研 §4.2 清单，随本步骤实施）

`installation/index.ts` 的 Method 收缩、五源删除、六 case 删除、无引用 schema/helper 删除；`uninstall.ts` 映射表删除；`upgrade.ts` 的 `--method` 删除；server `unknown → 400` 保留。curl 识别路径 `.opencode/bin` → `.fmcode/bin`。按调研 §4 执行，不赘述。

### 5.4 构建、发布与文档

```
模块名称：产物命名与发布

- script/build.ts：outfile dist/<name>/bin/fmcode；smoke test 路径同步；--user-agent 不改
- packages/opencode/package.json：bin 字段 {"fmcode": "./bin/fmcode"}
- fork-release.yml：资产名 fmcode-<os>-<arch>；OPENCODE_CHANNEL=dev → latest（调研 §1.4 选项 b）；安装说明 ~/.fmcode/bin；release note"关闭自动更新"一节保留至 #65 落地
- FORK_INSTALL.md：安装路径、迁移步骤（见 §6）、先卸官方包说明（调研 §4.3）
```

### 5.5 mDNS（`server/mdns.ts`）

`opencode-<port>` → `fmcode-<port>`；`opencode.local` → `fmcode.local`（mDNS 广播主机名，非文件）。trivial 替换。

### 5.6 不改清单（显式）

- 数据库命名函数 `database.ts:path()` 零改动（调研 §1.4；渠道后缀语义由选项 b 的构建变量承担）。
- 内部包名 `@opencode-ai/*`、import 路径、目录结构（调研 §1.1，暂不改）。
- User-Agent `opencode/<版本>`（逐端点验证后定，步骤 3）。
- 项目级 `.opencode/`、`opencode.json(c)`（步骤 2）。
- `.opencode-version` 快照标记（数据目录内部文件，对外不可见）。
- 上游托管服务调用（步骤 3）。

## 6. 迁移（零自动迁移）

- 不写迁移代码。fmcode 首启用自己的空 data/config，会话历史为空；凭据按 §4 直接回退读 opencode 的，登录状态不受影响。
- 想带会话历史：用户自己移动数据库（README 写明，先退出所有进程）：

```bash
mkdir -p ~/.local/share/fmcode
mv ~/.local/share/opencode/opencode-dev.db* ~/.local/share/fmcode/
# 选项 b 落地后的 release 用户从官方 latest 形态迁移时是 opencode.db*
```

文件名不改（决策）使迁移退化为一次 mv，无重命名环节。
- 快照与 tool-output 不移（临时性质，issue 已定）。
- 想要独立配置：手动建 `~/.config/fmcode/`（步骤 1 只分离系统目录；配置文件级二选一属步骤 2）。

## 7. 架构正确性论证

### goal → 模块映射

- **G1 与官方版在同一台机器并存，二进制互不覆盖** → §5.4 构建命名 + §5.3 安装识别（`.fmcode/bin`）
- **G2 数据、缓存、状态目录彻底分离** → §5.1 单常量改名（决策 B：不做目录级借用，fmcode 目录总是创建）
- **G3 配置与凭据默认继承 opencode 的** → 配置目录级：`Global.Path.config` 仍是 fmcode 自己的目录（首启为空），配置内容继承属步骤 2 的项目/全局配置二选一——**本步骤只做凭据文件级**（§4）；若用户理解"继承"为含配置内容，由 README 说明当前步骤边界
- **G4 自动更新目标路径与安装位置一致（为 #65 铺路）** → §5.3 method() 识别 + §5.4 安装目录
- **G5 环境变量渐进迁移** → §5.2 别名表
- **G6 分发收敛** → §5.3（调研 §4.2 清单）

### 模块协作论证

G1：构建产物名 fmcode ⇒ 安装到 `~/.fmcode/bin`，与官方 `~/.opencode/bin` 物理分离；method() 识别 `.fmcode/bin` ⇒ 升级目标路径一致，G1 且 G4 成立。
G2：`app = "fmcode"` ⇒ data/cache/config/state/tmp 全部落 fmcode 侧，进程启动即创建；官方版只碰自己的 opencode 侧目录 ⇒ 两版数据零交集（凭据回退读是只读共享，G3 范畴），G2 成立。
G3：凭据读按 §4.2 逐次判定——fmcode 无自有文件时回退 opencode ⇒ 官方登录直接可用；写入落 effectivePath ⇒ 两版后写覆盖同一借用文件，行为与各版单独运行一致，G3 成立（配置内容的继承边界在 README 声明）。

### 关键假设

- H1: xdg-basedir 未设 XDG 变量时全平台回退 `$HOME/.local/{share,state}`、`$HOME/.config`、`$HOME/.cache`（源码核实）
- H2: 官方版与 fmcode 可能同时运行——凭据借用文件的并发写（两版各自 login）以后写覆盖收场，与单版多终端场景无差异；data 目录分离后无其他共享写面
- H3: 凭据触点清单穷尽（§4.3 两处）——实现时 grep 复核，架构评审项
- H4: `OPENCODE_` 92 名单当前完整；新增变量须同步别名表或显式标"不收"（CI grep 对齐强制）

### 模块级 invariant

- I_1: Global.Path 全路径恒为 fmcode 侧（凭据回退读除外）——维护方：core/global.ts 单点；preservation：类型冻结 + 无第二 mkdir 入口
- I_2: 进程内路径恒定——维护方：模块加载一次解析；preservation：不导出可变引用
- I_3: 显式 OPENCODE_X 优先于 FMCODE_X——维护方：env-alias 单点；preservation：别名仅拷贝缺失目标，下游单一读点
- I_4: 凭据从不复制、从不双写——维护方：§4 二选一实现；preservation：触点清单穷尽（H3）+ 写仅落 effectivePath
