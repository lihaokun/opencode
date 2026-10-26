# 架构 — fmcode 自动更新绑定本 fork 的 release

> feature：`fork-autoupdate`；子计划：`fork-1-release-autoupdate`。issue #65。上游调研见 `docs/research/fork-autoupdate-research.md`。实现前置 `fmcode-1-visible-rename` 已落地（`curl|unknown` 方法、`.fmcode/bin` 识别、`upgrade()` stub、`UpgradeNotSupportedError`）——本子计划用进程内替换替换掉那个 stub。

## 1. 范围

改：`upgrade()` 从 stub 变为进程内替换（下载 → 校验 → 原子替换）；`latest()` 从单端点变为双渠道；新增版本比较器与渠道判定；`cli/upgrade.ts` 恢复自动执行（在 `autoupdate` 允许时）；GitHub API 调用加 TTL 缓存。
不改：`method()`、`getReleaseType` 语义（基线提示）、事件类型（UpdateAvailable/Updated）、`cli/cmd/upgrade.ts` 的手动命令面（保留，走同一 upgrade）、TTL 缓存之外的任何 state。

## 2. 核心流程

```
TUI 启动（cli/upgrade.ts，后台 fork）
  → autoupdate 关闭？ → 返回
  → channel = 渠道判定（parseVersion(InstallationVersion).channel）
      stable → "stable"；beta → "beta"；解析失败（本地/PR 构建）→ 不检查，返回
  → 渠道最新版（带 TTL 缓存）：
      stable：GET repos/lihaokun/opencode/releases/latest（天然排除 pre-release）
      beta：  GET repos/lihaokun/opencode/releases?per_page=100 → 过滤 prerelease==true ∧ tag 匹配 fork 模式 → 比较器取最大
  → compareVersion(latest, current) <= 0 ？ → 返回（不降级、不重装）
  → 基线（上游 semver）major/minor 变化？ → 只发 UpdateAvailable，返回
  → autoupdate == true ∧ kind == patch？
      否 → 发 UpdateAvailable，返回
      是 → upgrade(method, latest)：
        1. 资产名 fmcode-<os>-<arch>.<ext>（ext：win=zip，其余=tar.gz）
        2. 下载 release 资产 + sha256sums.txt（同 release）
        3. sha256 校验资产 → 不符则中止（原二进制不动）
        4. 解压到 <binDir>/.staging-<ver>/
        5. 逐文件 rename 到 <binDir>/（先 fmcode 后 rg）；Windows：运行中 exe 先 rename 为 .old
        6. 清理 staging 与 .old；发 Updated 事件
        任何一步失败 → 清理 staging，保留原二进制，静默（与现状 catch(() => {}) 一致）
```

## 3. 核心数据结构

```
数据结构：ForkVersion（解析产物，模块内）

字段：
  - baseline: { major: number; minor: number; patch: number } — 上游基线 semver
  - generation: number — 代际 N
  - ordinal: number — 序号 M（缺省 0）
  - channel: "stable" | "beta"
  - betaNumber: number — beta 号（stable 恒 0）

类型不变量：
  - betaNumber > 0 ⇔ channel == "beta"
  - 由 `v?<baseline>-fmv<N>[.<M>][-beta.<k>]` 严格文法解析；不匹配 → undefined（不可比较）

跨模块共享性：模块私有（installation/version-compare.ts）
```

```
数据结构：VersionComparison（compareVersion 返回值）

字段：-1 | 0 | 1 — a<b / a==b / a>b

比较律（全序，逐级先分即止）：
  baseline(major,minor,patch) → generation → ordinal → 正式性（stable > beta）→ betaNumber
跨模块共享性：模块私有
```

```
数据结构：ChannelCache（state 目录持久化）

字段：
  - checkedAt: number — epoch ms
  - stable: string — stable 渠道最新版
  - beta: string — beta 渠道最新版

类型不变量：
  - 读时 checkedAt 距今 < TTL(1h) 才使用；否则视为无缓存
生命周期：写于每次真实 API 查询后；flock 不做（多进程同时查 = 多一次无害请求）
跨模块共享性：模块私有
```

## 4. 模块划分与功能规约

### 4.1 `installation/version-compare.ts`（新：解析器 + 比较器）

```
模块名称：fork 版本解析与比较

功能描述：parseVersion(text) -> ForkVersion | undefined；compareVersion(a, b) -> -1|0|1（undefined 不可比）。

前置条件：输入为 release tag（可含前导 v）或 InstallationVersion。
后置条件：parseVersion 对 92 名单内的历史 tag 全部可解析；不匹配文法返回 undefined。
正确性论证要点（细化展开）：
  - 全序性：每一级都是全序（自然数 / 显式枚举），逐级字典序保持全序
  - 正式版 > 同名 beta：由"正式性"级在 betaNumber 级之前保证（fmv2.2 与 fmv2.2-beta.1 在 N、M 级相等，正式性级分出）
  - fmv9 < fmv10：generation 用数值比较（semver 会把 fmv 当 prerelease 字符串比较——这就是不用 semver 的原因）
```

### 4.2 `installation/index.ts`（改造：双渠道 + 进程内替换）

```
模块名称：安装与升级（替换 stub）

latest(channel: "stable" | "beta") -> Effect<string>：
  stable 走 /releases/latest；beta 走 /releases 列表过滤后比较器取最大。
  TTL 缓存命中时零网络请求。

upgrade(method, target) -> Effect<void, UpgradeFailedError>：
  method != "curl" → UpgradeFailedError（unknown 不可自升级，与现状一致）
  流程见 §2 步骤 1-6；失败任一步保留原二进制并清理 staging。
```

### 4.3 `cli/upgrade.ts`（改造：渠道判定 + 恢复自动执行）

```
模块名称：自动更新入口

行为：渠道由当前版本决定（无跨渠道配置项，issue 已定）；stable 用户从 stable 取、beta 用户从 beta 取；
比较器判严格更新才行动；基线 major/minor 变化只提示（沿用 getReleaseType）。
```

### 4.4 不改清单

- `method()`：`.fmcode/bin` / `.local/bin` → curl，其余 unknown（fmcode-1 已落）。
- `cli/cmd/upgrade.ts` 手动命令：继续调同一 `upgrade()`——stub 变实装后手动命令自动获得真升级能力；无参数时 `latest()` 取当前渠道。
- 事件 schema：UpdateAvailable / Updated（properties.version: string）不变。
- User-Agent、TTL 缓存外的 state、`getReleaseType`。

## 5. 关键设计决策

1. **双渠道零交叉**（issue 已定，论证保留）：beta 之后发的正式版可能版本号更低（fmv2.1 vs fmv3-beta.17），跨渠道自动切换等于随机降级；换渠道 = 手动重装。
2. **beta 渠道取比较器最大而非列表第一条**：GitHub 按 created_at 排序，rebuild/re-tag 会让时间序与语义序背离。
3. **stable 渠道用 `/releases/latest`**：GitHub 端点语义天然排除 pre-release/draft，零过滤代码。
4. **TTL 缓存 1h**：与匿名限额 60/hr/IP 同量级；缓存按渠道分键存两值，跨渠道启动各取所需；不做 flock（并发重复查询无害）。
5. **staging + 逐文件 rename**：两文件（fmcode、rg）非原子批量，先全部就位于 `<binDir>/.staging-<ver>/` 再逐个 rename，失败窗口收敛到单次 rename 之间；顺序先 fmcode 后 rg（主程序先新）。
6. **Windows 先改名再放新**：运行中 exe 不可覆盖 → rename 为 `fmcode.exe.old` 后放入新文件，下次启动清理 `.old`；`.old` 清理失败不阻断。
7. **sha256 校验失败/下载失败 → 原二进制不动**：替换流程的任何前置失败都不触碰现役文件（fail-safe 优先于可用性）。
8. **升级执行不校验渠道归属**（issue 表第 3 行只约束自动检查；手动 `upgrade <target>` 允许任意可解析版本——用户显式指令优先，但绝不降级由比较器保证……**修订**：手动命令不比较、不阻止降级，显式 target 就是用户意图；自动路径才比较。细化落实两种入口的分叉）。

## 6. 架构正确性论证

### goal → 模块映射

- **G1 正式版只跟正式版，beta 只跟 beta** → §4.1 渠道判定（当前版本解析决定）+ §4.2 双端点
- **G2 绝不降级** → §4.1 比较器（自动路径严格大于才行动）+ §2 流程顺序
- **G3 基线 major/minor 变化只提示** → §4.3 沿用 getReleaseType
- **G4 升级过程任何失败保留原二进制** → §4.2 校验先行 + staging + rename 原子性
- **G5 替换后 fmcode 与 rg 版本一致** → 同 release 资产整体替换（staging 同源解压）
- **G6 匿名限额不被耗尽** → §3 TTL 缓存

### 关键假设

- H1: fork release 资产含 `fmcode-<os>-<arch>.<ext>` 与 `sha256sums.txt`，且 sha256sums 条目名与资产名一致（fork-release.yml 现行格式）
- H2: `dirname(process.execPath)` 可写（curl 安装语义；不可写时 upgrade 失败并保留原样——与现状 stub 失败等价）
- H3: GitHub API 可达；网络失败沿"静默返回"路径（与现状 catch(() => {}) 一致，不影响使用）
- H4: sha256sums.txt 格式为 `<hex>  <filename>` 两空格分隔（coreutils sha256sum -c 兼容形态）
- H5: beta 渠道 per_page=100 内必有最新 beta（发版频率 << 100/页；翻页为细化可选优化）

### 模块级 invariant

- I_1: 自动升级路径只在 compareVersion(latest, current) == 1 时执行替换——维护方：cli/upgrade.ts 单点；preservation：upgrade() 本身不比较（手动语义），自动调用方负责守卫
- I_2: 替换序列中现役二进制要么是旧版要么是新版，不存在中间损坏态——维护方：staging + rename；preservation：rename 同目录原子（POSIX）/ 先改名后放新（Windows）
- I_3: sha256 不符 ⇒ 替换零步执行——维护方：校验先于解压/移动的流程顺序
- I_4: 渠道永不交叉——维护方：渠道由当前版本唯一决定，无配置覆盖

## 7. 迁移/兼容

- fmcode-1 的 stub 错误与 `UpgradeNotSupportedError` 类型保留在代码历史中即可，本子计划删除该类型（upgrade 恢复真实错误通道 `UpgradeFailedError`）——TUI 侧对升级失败的展示走 err.message，无 schema 变更。
- release note 的"关闭自动更新"建议可移除（#65 落地后自动更新安全）；FORK_INSTALL.md 对应段落删除。
