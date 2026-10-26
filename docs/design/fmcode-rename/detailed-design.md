# 细化设计 — fmcode 改名 / fmcode-1-step1

> feature：`fmcode-rename`；子计划：`fmcode-1-step1`（issue #66 步骤 1）。上游：`docs/research/fmcode-rename-research.md`、`docs/design/fmcode-rename/architecture.md`（2026-10-26 全部决策闭合后重写）。本细化不改架构确定的模块划分与接口。

## 1. 范围

覆盖函数/模块：

- `packages/core/src/global.ts` — app 常量改名（trivial）
- `packages/opencode/src/env-alias.ts`（新）— 入口别名
- 凭据：零改动（架构 §4 裁决完全隔离，现状路径已是 fmcode 侧直拼）
- `packages/opencode/src/installation/index.ts` — Method 收缩 + 分发收敛（调研 §4.2）
- `packages/opencode/src/cli/cmd/uninstall.ts`、`packages/opencode/src/cli/cmd/upgrade.ts` — 随 Method 收缩
- `packages/opencode/src/server/mdns.ts` — 服务名
- `packages/opencode/script/build.ts`、`packages/opencode/package.json`、`.github/workflows/fork-release.yml`、`FORK_INSTALL.md` — 产物命名与发布
- `packages/opencode/src/index.ts` — env-alias 接线（首行）

不涉及：项目级 `.fmcode/`（步骤 2）、TUI 标志/README 主体/上游服务（步骤 3）、凭据模块（架构 §4 裁决完全隔离，`auth/index.ts`/`mcp/auth.ts` 零改动）。

## 2. 与已有代码的复用点

- `xdg-basedir` 四变量（原样）
- `Global.Path` 常量对象形态（原样，仅 app 值变）
- `Flag.truthy`、`Flag` 模块（零改动——别名在 Flag 求值前完成）
- fork-release 的 notes 模板与 `__DOCS_BRANCH__` 机制（改内容不改机制）
- `Npm.Service`（不涉——分发收敛删除的是 Installation 内的 npm 调用，与配置目录 SDK 安装无关）

## 3. 错误处理策略

- env-alias 无错误路径
- Installation 收缩后错误面减小（删掉的源各有无关的错误分支）
- mkdir 失败沿 `global.ts` 顶层 await 抛（现状语义，不改）

## 4. 数据结构定义

见架构 §3（`GlobalPaths`、`EnvAlias`）。均为模块私有，无新增跨模块共享类型。

## 5. 模块细化

### 5.1 `core/global.ts` — app 改名

#### 5.1.1 常量替换

- **实现思路**：`const app = "opencode"` → `"fmcode"`；mkdir 全集、Flock 注册、Path 对象形状全部不动（推导连续性：单表达式替换，后续所有派生路径公式不变，自动跟随）。
- **分支覆盖**：无分支。
- **退出覆盖**：mkdir 失败沿顶层抛（现状）。
- **callee 契约**：mkdir recursive（已存在时成功）。
- **正确性论证**：trivial（单常量替换；无逻辑分支）。副作用论证：mkdir 集合同名切换，与官方目录零交集（I_1 成立的机械结果）。

### 5.2 `fmcode/src/env-alias.ts`（新）

#### 5.2.1 `apply()`

- **功能描述**：把已设且目标未设的 `FMCODE_X` 拷贝为 `OPENCODE_X`。
- **调用关系**：callers: `index.ts` 首行（import 后立即调用）；callees: `process.env`。
- **实现思路**：
  1. 模块常量 `ALIASES: [string, string][]`（显式清单，按架构 §5.2 收入口径）
  2. 单遍循环：`for (const [fmKey, ocKey] of ALIASES)` → `if (env[fmKey] !== undefined && env[ocKey] === undefined) env[ocKey] = env[fmKey]`
  3. 导出 `apply()` 供 index.ts 调用；模块本体不 import 任何 src 文件
- **分支覆盖**：源未设（跳）/ 源设目标未设（拷）/ 源设目标设（跳）/ 名单外键（无映射，天然跳）。
- **退出覆盖**：无返回值、无错误路径。
- **循环刻画**：`ALIASES.length` 有限，单遍赋值，终止显然。
- **callee 契约**：`process.env` 读写（string | undefined，赋值生效）。
- **显式假设链**：执行早于一切 `OPENCODE_*` 读点——由 index.ts 首行 import + 本模块零 src import 保证；Flag 模块（core/flag）在 index.ts 的 import 图中位于 env-alias 之后求值（评审项：核对 index.ts import 顺序，env-alias 必须第一）。
- **正确性论证**：
  - 前置: 同上假设链
  - 论证: 拷贝后下游读 `OPENCODE_X` 即得 `FMCODE_X` 值 ⇒ 语义等同用户直设；目标已设不拷 ⇒ I_3；清单完整性由 CI 检查（`scripts/check-env-alias.ts` 或 CI inline：`FMCODE_` 名单非空且每项 ⊆ `OPENCODE_` 全名单 grep 结果）
  - 后置: 架构 §5.2 后置条件成立
  - 副作用论证: 仅 process.env 拷贝项写入

### 5.3 凭据（零改动确认）

架构 §4 裁决完全隔离后，`auth/index.ts:10` 与 `mcp/auth.ts:37` 的 `path.join(Global.Path.data, ...)` 在 app 改名后自动指向 `~/.local/share/fmcode/`——**无需任何代码改动**。评审项：grep 两文件确认无 opencode 侧路径构造（I_4）。

### 5.4 `installation/index.ts` — 分发收敛 + 识别改名

- **Method 类型**：`export type Method = "curl" | "unknown"`。
- **method()**：删 checks 数组与排序；保留两个分支：`process.execPath` 含 `path.join(".fmcode", "bin")` → `"curl"`；含 `path.join(".local", "bin")` → `"curl"`；否则 `"unknown"`。
- **latest()**：签名简化为 `() => Effect<string>`（无 method 参数分支——或保留参数以最小化调用面改动，细化定夺：**保留参数**，server handler 仍传，内部忽略；避免动 httpapi 协议）。唯一实现：GitHub API（#65 前先指向 `lihaokun/opencode/releases/latest`——**本步骤即改 URL**，与 #65 的完整双渠道实现解耦：先修"升级换回官方版"的危害，渠道语义 #65 落地）。
- **upgrade()**：只留 curl case；npm/pnpm/bun/brew/choco/scoop case 删除；`upgradeCurl`/`upgradeScriptShell` 删除（#65 重写进程内替换——本步骤 curl case 临时保留还是先删？**决策：本步骤把 upgrade() 收缩为 curl-only 但保留现有 upgradeCurl 实现**（URL 换成不可达？否——upgradeCurl 指向 opencode.ai/install 会装官方版，危害不除）。**最终决策：latest() 改 fork URL；upgrade() 的 curl case 改为返回明确错误 "use the installer script from the release page"**——自动更新入口（cli/upgrade.ts）在 `method === "curl"` 时不再自动执行，等 #65 提供进程内替换。危害即刻消除（不会换回官方版），#65 只需替换这个 stub。
- **schema/helper 删除**：`NpmPackage`、`BrewFormula`、`BrewInfoV2`、`ChocoPackage`、`ScoopManifest`、`getBrewFormula`、`upgradeScriptShell`、`NpmConfig` import、`httpOk` 若无消费者随之删。
- **`cli/upgrade.ts`**：`method === "unknown"` → 现状 return（不升级）；`method === "curl"` → 因 upgrade 为 stub，行为改为发 `UpdateAvailable` 事件（notify 语义）后 return——**自动更新在 #65 落地前整体降级为纯提示**，与 release note 现行"autoupdate: false"要求一致但不再危险。
- **`cli/cmd/upgrade.ts`**：`--method` 选项删除；`target` 手动指定时调 `upgrade` 得到 stub 错误信息（可接受，提示语明确）；无 target 时 `latest()` 返回 fork 最新版并提示"手动安装"，不执行替换。
- **uninstall.ts**：映射表删除；`method` 参数保留（curl → 清 binary/shell PATH；unknown → 只清目录）。
- **正确性论证**（升级链路收敛）：
  - 前置: 决策"release-only 分发"
  - 论证: latest() 指向 fork ⇒ 提示的版本号正确；upgrade stub ⇒ 不存在"换回官方版"的执行路径（危害根除）；手动命令给出明确指引 ⇒ 用户可完成升级（下载新 release 手动装，#65 后自动化）
  - 不变量保持: `getReleaseType`、`userAgent`、事件类型（UpdateAvailable/Updated）不变
  - 无回归: 现有 installation 测试按新形态修订（npm/brew 等 latest 用例删除，curl/unknown 用例保留）

### 5.5 `server/mdns.ts`

`host = domain ?? "opencode.local"` → `"fmcode.local"`；`name = opencode-${port}` → `fmcode-${port}`。trivial。

### 5.6 构建与发布

- `script/build.ts`：`outfile: dist/<name>/bin/opencode` → `bin/fmcode`；smoke test `binaryPath` 同步；`--user-agent=opencode/${Script.version}` 不改。
- `package.json` bin：`{"fmcode": "./bin/fmcode"}`。
- `fork-release.yml`：资产名生成处 `opencode-` → `fmcode-`；`OPENCODE_CHANNEL: dev` → `latest`（§1.4 选项 b）；内嵌 INSTALL heredoc 的 `~/.opencode/bin` → `~/.fmcode/bin`；`__DOCS_BRANCH__` 链接不变。
- `FORK_INSTALL.md`：二进制名、安装路径、迁移步骤（架构 §6：一条 mv，无重命名）、先卸官方包说明、`fmcode --version` 校验命令。

### 5.7 `index.ts` 接线

- 首行：`import { apply as applyEnvAlias } from "./env-alias"; applyEnvAlias()`——必须在 `@/config/config`、Flag 等任何读 env 的 import 之前。评审项：ESM 按序求值，env-alias 无传递 import 才保证"最早"；本模块仅依赖全局 `process`。

## 6. 测试计划

- 单元：`apply()` 三态 + 清单外键；method() 的 `.fmcode/bin`、`.local/bin`、其他三分支。
- 回归：installation 测试修订（删包管理器源用例）；全量 config/tui/plugin 套件（Global.Path 消费面零逻辑改动证明）；凭据读写回归（login→读回落 fmcode 侧；opencode 侧 auth.json 存在时 fmcode 读不到它——隔离性负例）。
- E2E（真实进程，隔离 XDG）：首启建 fmcode 目录；`opencode 侧 auth.json` 存在时 fmcode 侧未登录（隔离负例）；fmcode login → 写 fmcode 侧且 opencode 文件不动；`fmcode --version`/`--help` 文案；dev 构建 `OPENCODE_CHANNEL=dev` → `opencode-dev.db`，模拟 release `latest` → `opencode.db`。
- 边际：`OPENCODE_DB` 显式路径（零改动验证）、`FMCODE_CONFIG` 设置后等效 `OPENCODE_CONFIG`、Windows（CI 无 runner 则记录未测面）。

## 7. 完整性自检 checklist

- [x] 所有函数实现思路推导连续（5.2.1 三步、5.4 逐文件）
- [x] 所有分支已覆盖（alias 三态、method 三分支）
- [x] 所有退出点已刻画（alias 无错误路径；mkdir 失败沿现状抛）
- [x] 所有 callee 调用显式引用其 pre/post（existsSync / process.env / Global.Path / mkdir）
- [x] 所有循环有终止性论证（alias 单遍有限清单）
- [x] 所有上游事实显式列出（H1-H4 + Node existsSync 语义 + ESM 求值顺序 + fork-release 渠道变量流向）
