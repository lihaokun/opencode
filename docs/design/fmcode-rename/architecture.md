# 架构 — fmcode 改名（与官方 opencode 分离用户可见层）

> feature：`fmcode-rename`；子计划：`fmcode-1-step1`（issue #66 步骤 1 范围）。上游调研见 `docs/research/fmcode-rename-research.md`（本文引用其 §1 基线与裁决、§2 现状、§5 方案，编号一致）。issue #66 原文名 `oc-fm`，2026-10-26 用户裁决更名 `fmcode`。本文重写于 2026-10-26，全部决策已闭合。

## 1. 范围（步骤 1）

改：二进制名、安装目录、数据/缓存/状态目录、环境变量前缀（后备兼容）、mDNS 名、release 资产名、分发收敛（删包管理器路径，调研 §4.2）。
不改：数据库文件名与命名函数（调研 §1.4）、内部包名（调研 §1.1）、User-Agent、项目级 `.opencode/`（步骤 2 子计划）、TUI 标志与上游托管服务（步骤 3）、凭据模块代码（§4，零改动）。

## 2. 核心流程

fmcode 进程启动路径：

```
进程启动
  → env 别名（index.ts 我们自己的首个 import，`packages/opencode/src/env-alias.ts`，零 src 依赖——内部包名不改，路径仍为 packages/opencode）
      把已设的 FMCODE_X 拷到 OPENCODE_X（仅当 OPENCODE_X 未设）
  → Global 模块解析（core/global.ts，模块加载，先于一切服务）
      1. 计算目标根：<xdg>/fmcode
      2. mkdir fmcode 侧全部七个目录（data/config/state/tmp/log/bin/repos，现状 mkdir 全集，仅目录名跟随 app 变）
      3. 冻结 Path 常量
  → 凭据（auth / mcp-auth）：<data>/auth.json 直拼，与 opencode 零交互（§4）
  → 数据库（database.ts）：零改动，<data>/opencode.db（data 已是 fmcode 自己的）
  → 其余服务照旧（全部经 Global.Path 间接取路径）
```

与旧稿（借用方案）的本质差别：**与 opencode 侧零共享**——data/config 永远是 fmcode 自己的，目录总是创建；凭据也不回退读 opencode 的（§4）。

## 3. 核心数据结构

```
数据结构：GlobalPaths（core/global.ts 模块内）

字段：
  - app: "fmcode"
  - data / cache / config / state / tmp / bin / log / repos: string — 解析后的绝对路径（全部 fmcode 侧）

类型不变量：
  - 所有路径恒为 fmcode 侧，与 opencode 目录无任何交集

生命周期：
  - 创建：模块首次加载时 mkdir（recursive）并冻结
  - 修改：不允许
跨模块共享性：跨模块共享（consumer：30+ 处经 Global.Path / Global.Service）
```

```
数据结构：EnvAlias（packages/opencode/src/env-alias.ts）

字段：
  - ALIASES: Array<[fmcodeKey, openCodeKey]> — 显式清单（用户面 Flag 子集，非全量 92 名）

类型不变量：
  - 别名仅在 OPENCODE_X 未设且 FMCODE_X 已设时生效
  - 清单内名字逐一存在于 OPENCODE_ 全名单（CI grep 对齐检查）
跨模块共享性：模块私有（入口一处消费）
```

## 4. 凭据（2026-10-26 用户裁决：完全隔离）

### 4.1 规约

```
模块名称：凭据路径

功能描述：fmcode 的凭据文件固定为 <data>/auth.json 与 <data>/mcp-auth.json；不读、不写 opencode 侧的任何凭据文件。

前置条件：Global.Path.data 已冻结（I_1：恒为 fmcode 侧）。
后置条件：读写路径恒为 fmcode 侧；opencode 侧凭据文件的内容与存在性不被本进程改变。
副作用：写时创建所在目录（fmcode 侧，已由 Global mkdir）。
```

### 4.2 与 issue #66 的偏离登记

issue 边界 2 原要求凭据"有自己就用自己，没有就用 opencode 的；默认与官方版共用登录状态"。本裁决按用户明示简化为**完全隔离**（与数据目录语义自洽）：fmcode 首启未登录，登录一次即落入自己的目录；`mcp-auth.json` 同理，MCP 服务器重新走一遍 OAuth。issue 原文不改（保留原始需求记录），以本节与 PR 记录为准。

### 4.3 实现

路径退化为 `path.join(Global.Path.data, "auth.json")` 直拼——与现状代码同构，**零新代码**；旧稿的 borrowed 判定、回退读、触点清单、`resolveCredentialPath`、`CredentialSource` 类型全部不引入。

## 5. 模块划分与功能规约

### 5.1 `core/global.ts`（改造：单常量改名）

```
模块名称：全局路径

功能描述：app 常量 "opencode" → "fmcode"；mkdir 全集（data/config/state/tmp/log/bin/repos 七目录）与代码形状完全不动，仅目录名跟随 app 变（决策 B：fmcode 侧目录总是创建）。

前置条件：无（模块加载即执行）。
后置条件：Path 冻结且全部为 fmcode 侧路径；opencode 侧目录不被创建也不被写入。
不变式：进程内路径恒定；无探测逻辑（与旧稿的本质差别）。
正确性论证：trivial（字符串常量替换 + mkdir 集合同名切换；无分支变化）。
```

### 5.2 `packages/opencode/src/env-alias.ts`（新增）与入口接线

```
模块名称：环境变量别名

功能描述：进程入口最早期，把已设且目标未设的 FMCODE_X 拷贝为 OPENCODE_X。

前置条件：在任何 OPENCODE_* 读点前执行。实现约束：本模块零 src import、**import 即执行拷贝（自带副作用）**——ESM 中全部 import 先于调用方模块体求值，"import 后再调用 apply()"无法覆盖 import 求值期间的读点；`index.ts` 把该 import 置于我们自己的 import 首位（外部包如 yargs 无 env 读点，顺序无涉；首个 env 敏感链是 `cli/heap.ts` → core/flag 模块级 44 键直读）。
后置条件：对下游所有代码效果等同用户直接设置了 OPENCODE_X。
不变式：显式 OPENCODE_X 永远胜过 FMCODE_X。
副作用：写 process.env（仅拷贝项）。

ALIASES 清单构成（§调研 5.3 讨论 B 的落地口径）：
  - 收入：Flag 模块注册的用户面开关（flag.ts 全部 44 键——含 Config.boolean 形态，键名相同）+ 非 Flag 的用户面直接读点（实现时从调研 §2.5 的 92 名单中按"用户面"标准逐一判定；注：`OPENCODE_DISABLE_AUTOUPDATE`/`OPENCODE_CONFIG`/`OPENCODE_DB` 等例其实都在 flag.ts 注册内，直接经 Flag 覆盖即可，无需单列）
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
- FORK_INSTALL.md：安装路径、迁移步骤（见 §6，含两种库名 glob）、先卸官方包说明（调研 §4.3）、凭据不继承说明（§4.2）
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

- 不写迁移代码。fmcode 首启用自己的空 data/config，会话历史为空、未登录——需重新登录一次（`fmcode auth login` 或对应命令；MCP 服务器重新 OAuth）。
- 想带会话历史：用户自己移动数据库（README 写明，先退出所有进程）：

```bash
mkdir -p ~/.local/share/fmcode
mv ~/.local/share/opencode/opencode-dev.db* ~/.local/share/fmcode/   # 旧 fork release（channel=dev 构建）用户
# 或：mv ~/.local/share/opencode/opencode.db* ~/.local/share/fmcode/  # 官方 latest 形态或选项 b 后的 fork release 用户
```

两个 glob 二选一按实际文件名；`*` 同时覆盖 `-wal`/`-shm`。文件名不改（决策）使迁移退化为一次 mv，无重命名环节。
- 快照与 tool-output 不移（临时性质，issue 已定）。
- 配置：步骤 1 后 `~/.config/fmcode/` 自动创建且为空——官方配置不自动继承（配置内容的继承/二选一属步骤 2）。想在步骤 1 阶段复用官方配置：手动复制 `~/.config/opencode/opencode.json` 到 `~/.config/fmcode/`。

## 7. 架构正确性论证

### goal → 模块映射

- **G1 与官方版在同一台机器并存，二进制互不覆盖** → §5.4 构建命名 + §5.3 安装识别（`.fmcode/bin`）
- **G2 数据、缓存、状态目录彻底分离** → §5.1 单常量改名（决策 B：不做目录级借用，fmcode 目录总是创建）
- **G3 凭据完全隔离（偏离 issue 原文，用户裁决）** → §4：路径直拼，零新代码；配置内容的继承属步骤 2，本步骤不做，README 声明边界
- **G4 自动更新目标路径与安装位置一致（为 #65 铺路）** → §5.3 method() 识别 + §5.4 安装目录
- **G5 环境变量渐进迁移** → §5.2 别名表（import 即执行的机制，见实现约束）
- **G6 分发收敛** → §5.3（调研 §4.2 清单）

### 模块协作论证

G1：构建产物名 fmcode ⇒ 安装到 `~/.fmcode/bin`，与官方 `~/.opencode/bin` 物理分离；method() 识别 `.fmcode/bin` ⇒ 升级目标路径一致，G1 且 G4 成立。
G2：`app = "fmcode"` ⇒ data/cache/config/state/tmp 全部落 fmcode 侧，进程启动即创建；官方版只碰自己的 opencode 侧目录 ⇒ 两版数据零交集，G2 成立。
G3：凭据路径恒 fmcode 侧（§4.1 后置条件）⇒ opencode 凭据文件不被读也不被写，两版登录状态各自独立演化，G3 成立；代价是 fmcode 首启需重新登录（含 MCP OAuth），已在 §6 迁移与 README 声明。

### 关键假设

- H1: xdg-basedir 未设 XDG 变量时全平台回退 `$HOME/.local/{share,state}`、`$HOME/.config`、`$HOME/.cache`（源码核实）
- H2: 官方版与 fmcode 可能同时运行——data/cache/state/tmp/config 全目录分离 + 凭据隔离后，两版间无任何共享读写面（各自 `<os.tmpdir>/fmcode` 与 `<os.tmpdir>/opencode` 亦分离）
- H3: 凭据文件的全部消费者都在 fmcode 侧路径上（实测两处：`auth/index.ts:10`、`mcp/auth.ts:37`，均为 `path.join(Global.Path.data, ...)`，app 改名后自动跟随；grep 复核作例行评审项）
- H4: `OPENCODE_` 92 名单当前完整；新增变量须同步别名表或显式标"不收"（CI grep 对齐强制）

### 模块级 invariant

- I_1: Global.Path 全路径恒为 fmcode 侧——维护方：core/global.ts 单点；preservation：类型冻结 + 无第二 mkdir 入口
- I_2: 进程内路径恒定——维护方：模块加载一次解析；preservation：不导出可变引用
- I_3: 显式 OPENCODE_X 优先于 FMCODE_X——维护方：env-alias 单点；preservation：别名仅拷贝缺失目标，下游单一读点
- I_4: 凭据与 opencode 零交互——维护方：§4 路径直拼；preservation：无任何 opencode 侧路径构造进入凭据模块（评审 grep `opencode` 于 auth/mcp 模块）
