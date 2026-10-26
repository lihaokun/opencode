# 调研报告 — 自动更新绑定本 fork 的 release（#65）

> feature：`fork-autoupdate`；子计划：`fork-1-release-autoupdate`；issue #65。本文产出早于 #66 步骤 1 的实现与 fmcode 命名裁决（commit `6ed4929afe`，2026-10-25）；文中 `oc-fm` 一律按 `fmcode` 理解，`opencode` 二进制/资产名按 `fmcode` 理解。#66 步骤 1 已实现（upgrade stub、`curl|unknown` 方法、`.fmcode/bin` 识别），本调研的现状节保留为历史证据，方案节仍然有效，待用户逐条裁决后修订进架构。

## 1. 现状梳理（`dev@f9ed5e63ed` 实测；fmcode-1 落地后链路已收缩为 curl-only + stub，本节描述的是实现前的历史形态，保留作危害证据）

### 1.1 现有自动更新链路

- 入口 `cli/upgrade.ts`（TUI worker 每次启动后台调用，`tui/worker.ts:61`）：
  1. `config.autoupdate === false || Flag.OPENCODE_DISABLE_AUTOUPDATE` → 直接返回（true/"notify"/false 三态语义，`true` 为默认）
  2. `Installation.method()` 判安装方式
  3. `Installation.latest(method)` 取目标版本；`cli/upgrade.ts:26` 只判 `InstallationVersion !== latest` 即触发——**不比较新旧，会降级**
  4. `getReleaseType`（semver major/minor）决定自动装还是只发 `UpdateAvailable` 事件；`"notify"` 配置或非 patch 均只提示
- `installation/index.ts` 的 `latest()` 按安装方式查六个源：brew tap/formulae、npm registry（`opencode-ai@<channel>`）、choco、scoop、**fallback GitHub `anomalyco/opencode/releases/latest`（上游）**。
- `upgrade()`：curl 方式跑 `https://opencode.ai/install` 脚本（上游脚本装官方二进制）；npm/pnpm/bun 装 `opencode-ai@<target>`；brew/choco/scoop 各自包管理器。
- 危害确认：fork 的 curl 安装（release 包用户）开自动更新 → `latest()` 命中上游 GitHub → `upgradeCurl` 装回官方版。这是当前 release note 要求 `"autoupdate": false` 的原因。

### 1.2 本 fork 的 release 面（GitHub API 实测 2026-10-25）

- `releases/latest` → `v1.18.31-fmv2.1`（`prerelease=false`）：**GitHub 的 latest 端点天然排除 pre-release 与 draft**，正式渠道语义免费获得。
- `releases` 列表（非 draft）含 pre-release 标记：`v1.18.31-fmv3-beta.17 prerelease=true`。beta 渠道 = `GET /releases`（`per_page` 分页）过滤 `prerelease==true ∧ tag 匹配 fork 命名模式`，取第一条（API 按 created_at 排序）或全取后按比较器取最大（**取比较器最大，不信任 created_at 排序**——rebuild/re-tag 会使 created_at 与语义顺序不一致）。
- 命名模式（`fork-release.yml:82` 与 AGENTS.md）：`v<upstream>-fmv<N>`、`v<upstream>-fmv<N>.<M>`（stable）、加 `-beta.<k>`（pre-release）。`<M>`/`<k>` 无前导零。

### 1.3 版本顺序：semver 不可用（实测复现 issue 的反例）

bun+semver 实测：

| 对比 | semver 判定 | 语义正确 |
|---|---|---|
| `fmv2.2-beta.1` vs `fmv2.2` | beta **>** 正式 | 正式 > 它的 beta |
| `fmv9` vs `fmv10` | fmv9 **>** fmv10 | fmv10 > fmv9 |
| `fmv2.1` vs `fmv3-beta.1` | beta > stable | 跨代，beta ≠ 目标（渠道隔离），但同渠道内仍需正确 |

（后两行中 `fmv2.1 vs fmv3-beta.1` 的 semver 判定恰与渠道无关的"代际"一致，但不可依赖——比较器必须自成全序。）

### 1.4 升级执行面（#66 后的落点）

- 安装目录：`~/.fmcode/bin`（release 安装说明装入的独立 PATH 目录；注意 `Global.Path.bin` 是缓存 bin，二者并存，升级目标是前者即 `dirname(process.execPath)`）。`method()` 识别 `.fmcode/bin` 与 `~/.local/bin`（fmcode-1 已实现）。
- 同目录捆绑：`rg`（实测 v1.18.31-fmv2.1 资产解压为 `bin/fmcode` + `bin/rg` + `package.json`，2026-10-26 下载核验）。
- 资产名：`fmcode-<os>-<arch>.tar.gz` / `.zip`；`sha256sums.txt` 同 release（实测条目格式 `<hex>␣␣<filename>`，coreutils `sha256sum -c` 兼容）。
- 平台：5 目标（darwin arm64/x64、linux x64/arm64、windows x64）；Windows zip，其余 tar.gz。

## 2. 外部参照

- **GitHub self-update 惯例**（gh CLI 自身、ghcp 等）：`releases/latest` + 资产名匹配 + 下载替换 + 版本比较防降级；gh 用 `--version` 比对。我们的比较器因命名规则必须自写（§1.3）。
- **rustup / sdkman**：渠道（stable/beta/nightly）由用户安装的 toolchain 决定，跨渠道需显式命令——与 issue"渠道由当前运行的版本决定，不提供跨渠道配置项"一致。
- **Chrome/FF 的 update 步进**：正式版不追 beta。同上。
- **opencode 上游实现**（`upgradeCurl`）：进程外 shell 脚本。issue 明确改为进程内（校验、原子替换、失败保原样），不沿用。

## 3. 方案对比

### 3.1 版本源

| 方案 | 评价 |
|---|---|
| A. GitHub API（`releases/latest` + `releases` 过滤） | 一个源覆盖双渠道；与发布机制（fork-release）同源，不存在同步滞后。**选 A** |
| B. npm registry | fork 不发 npm，否 |
| C. 自建 manifest（如 update.json 放 docs 分支） | 多一个发布工件要维护，fork-release 已有结构化 tag/release，否 |

### 3.2 版本比较器

| 方案 | 评价 |
|---|---|
| A. 自写解析器：`v?<semver>-fmv<N>[.<M>][-beta.<k>]` → 结构化比较（semver 域用 semver 库比，fork 域逐级整数比；正式 > 同版本 beta；beta 号整数比） | 精确对齐发版命名；解析失败的版本（PR 构建 `fmv3-pr59.2`、本地构建）不参与比较（返回不可比）。**选 A** |
| B. semver prerelease 标签 hack（把 fmv 编码进 prerelease） | 需要重写发版命名才严格，否 |
| C. created_at 排序 | rebuild/re-tag 失真，否 |

比较律（全序）：基线 semver（major/minor/patch）→ 代际 N → 序号 M（缺省 0）→ 正式性（正式 > beta）→ beta 号 k（缺省视作 -1，即正式 > 同名 beta 的任何 k 值——注意 `fmv2.2-beta.1` 与 `fmv2.2`：N、M 相同，正式性分出）。逐级比，先分即止。**只在目标严格大于当前时升级**（相等/小于/不可比均不动）。

### 3.3 升级执行

| 方案 | 评价 |
|---|---|
| A. 进程内：下载资产 → sha256 校验 → 解压 tmp → 逐文件 rename 替换（Unix 同目录临时文件 + `rename` 原子；Windows 运行中 exe 先改名再放新）| issue 已定；失败任何步保原样。**选 A** |
| B. 沿用 shell 脚本 | 上游脚本不可控，否 |

### 3.4 渠道选择实现

| 方案 | 评价 |
|---|---|
| A. stable 用 `releases/latest`（免费排除 pre-release），beta 用 `releases` 列表过滤 | stable 零过滤逻辑；beta 一次分页（`per_page=100`，beta 频率远低于此）。**选 A** |
| B. 两渠道都拉全量列表 | stable 多拉无益；否 |

渠道判定：当前版本解析出 `[-beta.k]` 后缀 ⇒ beta 渠道；否则 stable；解析不出 fork 模式 ⇒ 不自动更新（本地/PR 构建，issue 表第三行）。

### 3.5 频率与限额（新增，issue 未展开）

GitHub 匿名 API 限额 60/hr/IP。现状：`upgrade()` 每次 TUI 启动跑一次。方案：state 目录存 `{ checkedAt, latestStable, latestBeta }`，TTL 内不发请求；事件（UpdateAvailable）可重复发（无副作用）。TTL 取 1h（与限额同量级）——细化定。

## 4. 风险与开放问题

1. **Windows 自替换**：运行中 exe 无法覆盖——先 `rename` 旧 exe 为 `.old` 再放新文件，下次启动清理 `.old`。需要真实 Windows 验证（本机无，CI 无 windows job for fork-release smoke）——标注为待验证面，README 提供手动重装兜底。
2. **`rg` 同替换的失败窗口**：两文件非原子批量——先全部就位（`bin/.staging-<ver>/`）再逐个 rename，`rg` 失败窗口极小（rename 间）；替换顺序 fmcode 先（最常用）。
3. **TTL 缓存的存储位置**：state 目录（oc-fm 自己的，#66 后不借用）；跨 TUI/CLI 实例并发写——flock 已有（`EffectFlock`），或接受竞态（多查一次无害）。细化定。
4. **`getReleaseType` 语义迁移**：基线（上游 semver）major/minor 变化只提示不自动装——现有函数可直接用于解析后的基线域。
5. **beta 渠道取最大 vs 取列表第一条**：定取比较器最大（§1.2）。
6. **`fmcode upgrade [target]` 手动命令**：保留。target 语义为"可解析的 fork 版本"；是否禁止手动降级/跨渠道为**开放决策**（issue 原文"绝不降级"若按字面适用于手动，则手动也被禁；倾向：自动路径绝不降级、手动显式指令允许——待用户裁决）。跨渠道安装走重装（README）。
