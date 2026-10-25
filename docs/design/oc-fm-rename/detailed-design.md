# 细化设计 — oc-fm 改名 / ocfm-1-user-visible-rename

> feature：`oc-fm-rename`；子计划：`ocfm-1-user-visible-rename`（issue #66 步骤 1）。上游：`docs/research/oc-fm-rename-research.md`、`docs/design/oc-fm-rename/architecture.md`。本细化不改架构确定的模块划分与接口。

## 1. 范围

覆盖函数/模块：

- `packages/core/src/global.ts` — 路径解析与二选一（核心）
- `packages/core/src/database/database.ts:41-55` — 默认库名
- `packages/opencode/src/env-alias.ts`（新）— 入口环境变量别名
- `packages/opencode/src/installation/index.ts:174-176` — curl 安装识别
- `packages/opencode/src/server/mdns.ts:11-12` — 服务名
- `packages/opencode/script/build.ts` — outfile/dist 名
- `packages/opencode/package.json` — bin 字段
- `.github/workflows/fork-release.yml` — 资产名与安装说明
- `FORK_INSTALL.md` — 手动迁移步骤与名字
- `packages/opencode/src/cli/cmd/uninstall.ts` — 文案（逻辑随 Global.Path 自动切换，核对即可）

与架构 §6 goal 对应：G1（global/database/build）、G2（global）、G3（global 写入面核对）、G4（installation/build）、G5（env-alias）。

不涉及：项目级 `.oc-fm/`（步骤 2）、TUI 标志/README 主体/上游服务（步骤 3）、`config.ts` 的 legacy `config` 目录写回（`config.ts:287`，见 §5.3 边界处理）。

## 2. 与已有代码的复用点

- `xdg-basedir` 四变量（原样复用，无平台分支）
- `Global.Path` 常量对象形态（原样保留，仅解析逻辑前移）
- `Flag.truthy`（env-alias 不用 Flag——alias 必须先于 Flag 模块求值，直接 `process.env`）
- fork-release 的 notes 模板与 `__DOCS_BRANCH__` 替换机制（改内容不改机制）

## 3. 错误处理策略

- 探测（`existsSync`）失败（权限等异常）→ 按"未借用"处理，走 oc-fm 侧路径；`mkdir` 失败 → 保持现状的进程崩溃行为（`global.ts` 顶层 await 无 catch，mkdir 失败即无法运行，改名不改此语义）
- env-alias 无错误路径（纯字符串映射 + 赋值）
- 数据库名函数保持纯函数，无错误路径

## 4. 数据结构定义

见架构文档 §2（`GlobalPaths`、`EnvAlias`）。模块归属：两者均为模块私有（`GlobalPaths` 经 `Global.Path`/`Global.Service` 暴露为冻结值；`EnvAlias` 不导出映射表本体，仅 CI 检查脚本读源码清单）。无新增跨模块共享类型。

## 5. 模块细化

### 5.1 `core/global.ts` — 路径解析与二选一

#### 5.1.1 `resolve()`（新，模块内同步函数，加载时执行一次）

- **功能描述**：计算冻结的 `GlobalPaths`。
- **调用关系**：callers: 模块顶层（替代现有 `const app = ...` 直拼）；callees: `fs.existsSync`、`fs.mkdir`（经顶层 await 段）。
- **实现思路**（推导连续）：
  1. 读 XDG 四变量经 `xdg-basedir`（H1：未设回退 `$HOME` POSIX 路径）→ 得四个根目录
  2. `rootConfig = join(xdgConfig, "oc-fm")`；`rootData = join(xdgData, "oc-fm")`
  3. 探测：`borrowedConfig = existsSync(rootConfig) === false`（目录不存在 ⇒ 借用；存在 ⇒ 用自己的）。`existsSync` 对权限异常返回 false（Node 语义），天然落入"未借用"，符合 §3 错误策略，无需 try/catch
  4. 同理 `borrowedData = existsSync(rootData) === false`
  5. `config = borrowedConfig ? join(xdgConfig, "opencode") : rootConfig`；`data` 同理
  6. `cache/state/tmp/bin/log/repos` 一律 oc-fm 侧（bin/log/repos 从 data/cache 派生，公式不变）
  7. 返回冻结对象 `{ app, borrowedConfig, borrowedData, ...paths }`
  8. 顶层 await 段：mkdir 列表按探测结果构造——借用 config 时**不** mkdir rootConfig（改 mkdir config 指向的借用目录？不：借用目录必已存在（探测刚确认），mkdir redundant 但无害；为不变式清晰，借用时跳过 mkdir，见分支覆盖）
  9. `Flock.setGlobal({ state })` 与现有副作用保持原序
- **分支覆盖**：
  - borrowedConfig=T ∧ borrowedData=T：mkdir 集合 = {data(借), config(借), state, tmp, log, bin, repos}——借用方已存在，跳过；跳过与 mkdir 已存在目录等价（`recursive: true`），实现统一 mkdir 全部（简单性优先），分支差异只在日志
  - borrowedConfig=F ∧ borrowedData=F：全量 mkdir oc-fm 侧（现状路径）
  - 混合：按位独立，mkdir 全集同理
  - 统一实现：mkdir 用解析后的最终路径全集（`recursive: true` 幂等），**探测先行**这一不变式由代码顺序保证（步骤 3 先于步骤 8），混合分支无额外逻辑
- **退出覆盖**：唯一退出点 = 返回对象；`existsSync` 不抛；`mkdir` 失败沿顶层 await 抛（进程启动失败，现状语义）
- **callee 契约引用**：`existsSync`（false 对不存在/无权限，同步，无副作用）；`mkdir recursive`（已存在时成功）；`xdg-basedir` 各导出（H1）
- **循环刻画**：无循环
- **显式假设链**：步骤 3 依赖"本模块是 import 图中第一个创建 oc-fm 侧目录的代码"（I_1；由 global.ts 为 core 最底层模块 + 全仓 grep 无第二处 mkdir oc-fm 目录保证，评审核对项）；步骤 5 依赖步骤 2 的 root 值；步骤 8 依赖步骤 3/4 的结果
- **正确性论证**：
  - 前置: H3（用户建目录即意图）+ I_1 时序
  - 论证: 探测先于创建 ⇒ 首次启动（oc-fm 目录不存在）必得 borrowed=T 且不创建 oc-fm 侧 config/data ⇒ 下次启动探测结果与首次一致（借用稳定，直到用户显式建目录）；用户建目录后 existsSync=T ⇒ borrowed=F ⇒ 切换且旧借用目录不删不写（后置条件"借用时内容逐字节不变"，因 Global 模块对该目录只有读）
  - 后置: §3.1 规约全部成立
  - 副作用论证: 写操作仅 mkdir（胜出方全集）+ Flock 注册（内存）；无其他

#### 5.1.2 日志（借用时）

- `Effect.logInfo` 在 Global 层不可用（Global 先于 Effect 运行时）→ 用 `console.log`/`process.stdout` 单行（`oc-fm: borrowing config from <path>` / `... data ...`）。消费方：人眼 + 日志文件（log 目录在 data 下，借用时官方 data/log 同理借用——日志落在借用侧，可接受，文档注明）。

### 5.2 `core/database/database.ts` — 默认库名

#### 5.2.1 `path()`（改造）

- **功能描述**：默认 `<data>/oc-fm.db`。
- **实现思路**：
  1. `Flag.OPENCODE_DB` 存在 → `:memory:`/绝对路径直用、否则 join(data)（现状不动）
  2. 否则 `join(Global.Path.data, "oc-fm.db")`
  3. 删除渠道分支（`latest|beta|prod` 判断、`InstallationChannel.replace`、`OPENCODE_DISABLE_CHANNEL_DB`）与对应 import
- **分支覆盖**：显式 DB（3 子分支现状保留）/ 默认名——两支
- **退出覆盖**：返回字符串，无错误路径
- **正确性论证**：trivial（纯函数、单表达式替换多表达式；渠道死代码删除不引入分支）。不变量：`OPENCODE_DB` 语义逐字节不变（测试既有覆盖）

### 5.3 `opencode/src/config/config.ts:262-287` legacy 写回（边界核对，不改逻辑）

`loadGlobal` 把旧 `config` 目录内容写为 `config.json` 的逻辑作用于 `Global.Path.config`。借用 opencode 的 config 时，这段写回目标是 opencode 侧目录——属"写入跟着读取走"的显式迁移行为，与官方版自身行为一致（官方版也会做同样写回），不改。记录为已知写入点。

### 5.4 `opencode/src/env-alias.ts`（新）

#### 5.4.1 `apply()`

- **功能描述**：把已设且目标未设的 `OC_FM_X` 拷贝为 `OPENCODE_X`。
- **调用关系**：callers: `packages/opencode/src/index.ts` 顶部（首条 import 前不可行——ESM import 先求值；落点为 index.ts 第一行 import 本模块后立即调用，且本模块自身不 import 任何 src 模块）；callees: `process.env`。
- **实现思路**：显式清单常量 `ALIASES: [ocFmKey, openCodeKey][]`（初版清单 = 用户面 Flag 44 个中可被环境覆盖的子集；构建 define/test/server 握手类不入表，架构 §3.7）；逐项 `if (env[ocFm] !== undefined && env[openCode] === undefined) env[openCode] = env[ocFm]`
- **分支覆盖**：源未设（跳）/ 源设目标未设（拷）/ 源设目标设（跳，显式优先）/ 目标名单外键（不存在映射，天然跳）
- **退出覆盖**：无返回值、无错误路径
- **循环刻画**：`ALIASES.length` 有限，单遍赋值，终止显然
- **callee 契约**：`process.env` 读写（字符串 | undefined，赋值即生效）
- **正确性论证**：
  - 前置: 在任何 `OPENCODE_*` 读点前执行（index.ts 首行 + 本模块零 src import 保证）
  - 论证: 拷贝后下游读 `OPENCODE_X` 得到 `OC_FM_X` 的值 ⇒ 语义等同；显式 `OPENCODE_X` 存在时不拷 ⇒ I_3 成立；清单 CI 检查（`OC_FM_` ⊆ `OPENCODE_` 名单）保证 H4 增量不漏
  - 后置: 对下游等效于用户直接设置
  - 副作用论证: 仅 `process.env` 写拷贝项
- **注**：Flag 模块（`core/flag/flag.ts`）模块级直读 44 处，全部经 alias 后取值，flag.ts 本体零改动。

### 5.5 `installation/index.ts` — method() curl 识别

- 改 `path.join(".opencode", "bin")` → `path.join(".oc-fm", "bin")`；`.local/bin` 分支保留。
- 正确性论证：trivial（字符串常量替换；识别对象是本产品安装的路径，fork-release 安装说明同步写入 `~/.oc-fm/bin`，两侧一致）。
- 前置确认：fork-release 安装说明（workflow 内嵌 INSTALL heredoc）与 FORK_INSTALL.md 的 `~/.opencode/bin` 全部改 `~/.oc-fm/bin`——列入 §5.8。

### 5.6 `server/mdns.ts` — 服务名

- `opencode-<port>` → `oc-fm-<port>`；`opencode.local` → `oc-fm.local`。trivial 替换。

### 5.7 构建（`script/build.ts`、package.json、turbo/CI 无涉）

- `outfile: dist/<name>/bin/opencode` → `.../bin/oc-fm`；`package.json` `"bin": {"oc-fm": "./bin/oc-fm"}`；dist 目录名 `pkg.name` 处加 `oc-fm-` 前缀映射（资产名 `oc-fm-<os>-<arch>`）。
- `build.ts:179` `execArgv` 里 `--user-agent=opencode/${Script.version}` **不改**（User-Agent 属边界 3）。
- smoke test 路径随 outfile 同步。

### 5.8 发布与文档（fork-release.yml、FORK_INSTALL.md）

- 资产名、`Copy-Item`/`cp` 示例里的 `~/.opencode/bin` → `~/.oc-fm/bin`；"关闭官方自动更新"一节改为"自动更新已绑定本 fork（#65 落地前暂保持 autoupdate:false 建议，#65 落地后删除该节）"——本子计划先改名，autoupdate 行为不变（#65 是下一个子计划，目标路径已就位）。
- FORK_INSTALL.md 增加"手动迁移数据库/配置"三节（架构 §7）。

### 5.9 `uninstall.ts`

- 目录清单随 `Global.Path` 自动指向 oc-fm 侧；核对 npm 卸载提示文案中 `opencode-ai` 包名保留（npm 分发非本 fork 途径，保持现状——架构 §3.7）。无代码改动，仅测试核对。

## 6. 测试计划

- 单元：`resolve()` 探测矩阵（借用/自有 × config/data，tmpdir + XDG 重定向）；`apply()` 别名三态；`path()` 默认名与 `OPENCODE_DB` 优先。
- 回归：现有全量测试（`Global.Path` 消费面零改动的证明）；测试 preload 的 XDG 重定向使 oc-fm 目录恒不存在于测试环境 ⇒ 探测恒借用?——**否**：preload 建 `<tmpdir>/share/oc-fm` 不存在 ⇒ borrowed=T，全部测试路径落到 `<tmpdir>/share/opencode`，与现状目录名不同但隔离语义相同。需核对 `test/preload.ts` 建目录清单是否要同步建 oc-fm 名（细化结论：preload 显式 mkdir `oc-fm` 目录即可让测试走"自有"分支，隔离性最强，列为实现步骤）。
- 边际：`OPENCODE_DB=:memory:`、绝对路径、XDG 变量显式设置、Windows（CI 有 windows runner 则跑，无则记录未测面）。

## 7. 完整性自检 checklist

- [x] 所有函数实现思路推导连续（5.1.1 九步、5.4.1 三态）
- [x] 所有 if/else/switch 分支已覆盖（探测矩阵、别名三态、DB 两支）
- [x] 所有退出点已刻画（mkdir 失败沿顶层抛；其余无错误路径）
- [x] 所有 callee 调用显式引用其 pre/post（existsSync/mkdir/process.env/xdg-basedir）
- [x] 所有循环有终止性论证（alias 单遍有限清单；无其他循环）
- [x] 所有上游事实显式列出（H1-H4 + Node existsSync 语义 + ESM import 求值顺序）
