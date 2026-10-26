# 细化设计 — fork 自动更新 / fork-1-release-autoupdate

> feature：`fork-autoupdate`；子计划：`fork-1-release-autoupdate`（issue #65）。上游：`docs/research/fork-autoupdate-research.md`（六决策已裁决）、`docs/design/fork-autoupdate/architecture.md`（复核通过，commit `5d0a028b4a`）。本细化不改架构确定的模块划分与接口。

## 1. 范围

覆盖函数/模块：

- `packages/opencode/src/installation/version-compare.ts`（新）— 解析器 + 比较器
- `packages/opencode/src/installation/index.ts` — `latest()` 双渠道、`upgrade()` 进程内替换、`UpgradeFailedError` 恢复、`UpgradeNotSupportedError` 删除
- `packages/opencode/src/cli/upgrade.ts` — 渠道判定 + 比较器守卫 + 资格门
- `packages/opencode/src/cli/cmd/upgrade.ts` — 手动命令接新升级（允许降级）
- `packages/opencode/src/util/archive.ts` — 新增 `extractTarGz`（现有 `extractZip` 保留）
- `FORK_INSTALL.md` — 删"关闭自动更新"残留段（fmcode-1 已标作废，本子计划移除）

不涉及：`method()`、`getReleaseType`、事件 schema、httpapi handler（`global.upgrade` 走 `err.message`，无需改）、TUI 侧。

## 2. 与已有代码的复用点

- `Archive.extractZip`（`util/archive.ts`）：Windows PowerShell `Expand-Archive` / Unix `unzip`，**直接复用**（zip 仅 Windows 渠道需要）
- `Process.run`（`util/process.ts`，nothrow 形态）：tar 解压复用它（`tar -xzf`，Unix/macOS 均有系统 tar；Windows 不走 tar）
- `withTransientReadRetry` + `httpOk`（`installation/index.ts` 现有）：下载复用同一 HTTP 栈；**大文件下载需流式写盘**（`response.text` 会整载内存，30MB 级资产不可接受——新增 `downloadToFile`，见 §5.4）
- `Bun.CryptoHasher`：sha256 计算
- `fs.rename` / `fs.rm`：替换与清理

## 3. 错误处理策略

- 错误模型：`UpgradeFailedError`（既有 tagged error）承载全部升级失败，`message` 为人类可读指引；删除 `UpgradeNotSupportedError`（fmcode-1 的 stub 类型）
- 分层：解析/比较（纯函数，die 不可达）；网络（失败 → UpgradeFailedError 或静默，见 §5.3/§5.4）；文件操作（失败 → UpgradeFailedError + 清理 staging）
- 自动入口（`cli/upgrade.ts`）外层 `catch(() => {})` 静默（现状不变）；手动入口把 `err.message` 展示给用户（现状不变）

## 4. 数据结构定义

见架构 §3（`ForkVersion`、`VersionComparison`）。模块私有，不导出类型；无新增跨模块共享类型。`ForkVersion` 的解析正则与比较律实现见 §5.1。

## 5. 模块细化

### 5.1 `installation/version-compare.ts`（新）

#### 5.1.1 `parseVersion(text: string): ForkVersion | undefined`

- **功能描述**：把 `v1.18.31-fmv2.1` / `1.18.31-fmv3-beta.17` / `1.18.31-fmv2` 解析为结构化版本；不匹配返回 `undefined`。
- **调用关系**：callers: `compareVersion`、`cli/upgrade.ts`（渠道判定）、§5.2 beta 渠道过滤；callees: 无（纯正则 + Number）。
- **实现思路**（推导连续）：
  1. `text.replace(/^v/, "")` 去前导 v
  2. 正则 `^(\d+)\.(\d+)\.(\d+)-fmv(\d+)(?:\.(\d+))?(?:-beta\.(\d+))?$` 捕获基线三段、N、M（可选）、k（可选）；**锚定首尾**（`^...$`）——`1.18.31-fmv3-pr59.2`、`1.18.31`、`1.18.31-fmv02`（前导零）等一律不匹配
  3. 各捕获段转 Number；M 缺省 0；k 缺省 0
  4. `channel = k > 0 ? "beta" : "stable"`
  5. 返回 `{ baseline: {major, minor, patch}, generation: N, ordinal: M, channel, betaNumber: k }`
- **分支覆盖**：完整匹配 / M 省略 / M+k 都省略 / 仅 k / 前导 v / 非 fork 版本（undefined）/ 前导零（undefined）/ 多余后缀（undefined）。九路输入类覆盖于测试。
- **退出覆盖**：唯一返回点，无错误路径（正则不匹配即 undefined）。
- **callee 契约**：`String.replace`（首现替换）、`Number`（非法串 NaN——被正则 `\d+` 保证不出现）。
- **循环刻画**：无循环。
- **显式假设链**：文法与 `fork-release.yml:82` 的发布校验正则同源（实现时逐字对照该处，评审项）；AGENTS.md 声明 M/k 无前导零 ⇒ 正则排除前导零（`\d+` 不够，需 `(?:0|[1-9]\d*)`——**评审项：fork-release 校验是否同样拒绝前导零，若拒绝则本正则对齐，若接受则放宽**）。
- **正确性论证**：
  - 前置: 输入为字符串
  - 论证: 正则全匹配 ⇒ 各段为无符号整数十进制 ⇒ Number 转换无损（数值 < 2^53，版本段不越界）；首尾锚定 ⇒ 无歧义截断；channel 判定 k>0 与文法（k 仅在 `-beta.` 后出现）互充 ⇒ 不变量 `betaNumber > 0 ⇔ channel == "beta"` 成立
  - 后置: 架构 §3 ForkVersion 不变量成立，或 undefined
  - 副作用论证: 纯函数，无副作用

#### 5.1.2 `compareVersion(a: ForkVersion, b: ForkVersion): -1 | 0 | 1`

- **功能描述**：架构 §3 比较律的逐级实现。
- **实现思路**：
  1. `cmpNum = (x, y) => x < y ? -1 : x > y ? 1 : 0`
  2. 依序比较：baseline.major → minor → patch → generation → ordinal → stableFlag（stable=1 > beta=0）→ betaNumber；每级 `cmpNum` 结果非 0 即返回
  3. 全部相等 → 0
- **分支覆盖**：每一级的 <、=、> 三态 + 全相等——由随机测试性质覆盖（见 §6）。
- **正确性论证**：
  - 前置: 两参均为 `parseVersion` 产物（非 undefined——调用方守卫）
  - 论证: 每级比较函数是全序；有限级字典序合成仍是全序（反对称、传递、完全性）⇒ 返回值满足三态契约。具体反例回归：`fmv2.2-beta.1 < fmv2.2`（前五级相等，正式性级分出）、`fmv9 < fmv10`（generation 数值级）、`fmv2 < fmv2.1`（ordinal 级）、`fmv2.1-beta.3 < fmv2.1-beta.4`（betaNumber 级）
  - 后置: 三态契约成立
  - 副作用论证: 纯函数

### 5.2 `installation/index.ts` — `latest(channel)`

- **功能描述**：双渠道最新版本号（不带 v 前缀）。
- **签名**：`latest(channel: "stable" | "beta") -> Effect<string>`（**替换**现有 `latest(method?)` 的参数——调用面共三处：cli/upgrade.ts、cli/cmd/upgrade.ts、server handler 的 info（`global.ts:63` 用 `installation.latest()`? 实测 server `info` 无 latest 调用，`info()` 内部调 `result.latest()`——**改为 `latest("stable")`**；三个调用点全列）。
- **实现思路**：
  1. stable：`GET /repos/lihaokun/opencode/releases/latest` → `tag_name` 去 v（现有实现逻辑，仅换 channel 参数语义）
  2. beta：`GET /repos/lihaokun/opencode/releases?per_page=100` → 数组过滤 `prerelease === true` → 逐条 `parseVersion(tag)`，过滤 undefined → `compareVersion` 归约取最大 → 去 v 返回
  3. beta 空集（过滤后无元素）→ `UpgradeFailedError`（die 为 orDie——不可达：仓库既有 beta；防御性 die 与 stable 的 orDie 同型）
- **分支覆盖**：stable 端点 / beta 端点非空 / beta 过滤后空（die）/ API 非 200（httpOk 抛 → 调用方处理）。
- **正确性论证**：
  - 前置: H1/H5（资产与列表假设）
  - 论证: beta 路径取比较器最大 ⇒ created_at 序不影响结果（决策 2）；`/releases/latest` 端点语义排除 pre-release ⇒ stable 结果必为 stable（决策 3）；去 v 与 parseVersion 接受前导 v 对称
  - 副作用论证: 网络读 + 无写

### 5.3 `installation/index.ts` — `upgrade(method, target)`（进程内替换）

- **功能描述**：架构 §2 步骤 1-6 的实现，替换 stub。
- **实现思路**（推导连续，含全部分支与退出）：
  1. **守卫**：`method !== "curl"` → `UpgradeFailedError`（"local builds cannot self-upgrade"）。退出
  2. **定位**：`binDir = dirname(process.execPath)`；`target` 经 `parseVersion` 取 `ver`（**undefined → UpgradeFailedError**——手动入口传不可解析 target 在调用方已挡，此处防御）
  3. **资产名**：`asset = fmcode-${platform}-${arch}${platform === "win32" ? ".zip" : ".tar.gz"}`（platform 映射 darwin/linux/win32 × arm64/x64，与 fork-release 矩阵一致）
  4. **URL**：`https://github.com/lihaokun/opencode/releases/download/v${target}/${asset}` 与 `.../sha256sums.txt`（release 资产 URL 形态，fork-release 上传路径核实）
  5. **下载资产**：`downloadToFile(url, stagingZip)`（§5.4）——失败 → 清理 → `UpgradeFailedError`。退出
  6. **下载 sha256sums.txt**（文本，`response.text` 可，文件小）：解析 `<hex>␣␣<filename>` 行（H4），取 `asset` 行的 hex——**行不存在 → UpgradeFailedError**（资产与校验文件不同代的防御）
  7. **校验**：流式读取 stagingZip 计算 sha256（`Bun.CryptoHasher("sha256")` 分块喂）→ 与 hex 比对——**不符 → 清理 → UpgradeFailedError("checksum mismatch")**（I_3：此时尚未解压、未触碰现役文件）
  8. **解压**：`Archive.extractZip`（win）/ `extractTarGz`（§5.5，新）到 `<binDir>/.staging-${target}/`——失败 → 清理 → UpgradeFailedError
  9. **就位检查**：staging 内 `<topDir>/bin/` 存在且含 `fmcode`（win: `fmcode.exe`）与 `rg`——**缺 → 清理 → UpgradeFailedError**（解压成功但内容异常）
  10. **替换**：staging 内**全部文件**（`bin/fmcode`、`bin/rg`、`package.json`，含未来新增捆绑——无白名单，决策 5）逐个 `fs.rename` 到 `binDir` 对应位置；**Windows 对 fmcode 可执行文件**：先 `rename(binDir/fmcode.exe → binDir/fmcode.exe.old)` 再 rename 新文件；顺序先 fmcode 后 rg 后其余（决策 5）。任一 rename 失败 → **中止但不清除已替换文件**（失败点之后的步骤未执行；已 rename 的文件保留——回滚已改名者无法恢复被覆盖前的状态一致性，如实保留 + 报错，见论证）
  11. **清理**：`fs.rm(stagingDir)` + Windows `fs.rm(binDir/fmcode.exe.old)`（失败不抛——非关键路径）
  12. 返回 void
- **分支覆盖**：守卫 2 路 / target 不可解析 / 下载失败 / 校验行缺失 / 校验不符 / 解压失败 / 就位缺文件 / rename 失败（Unix）/ Windows .old 路径 / 全成功——十路。
- **退出覆盖**：仅两条正常退出（成功 void；各失败 UpgradeFailedError）；无异常逃逸（全部 catch 转 UpgradeFailedError）。**部分替换失败是唯一"现役目录被部分更新"的退出**——I_2 在此边界收窄为"fmcode 可执行文件本身无中间态"，见论证。
- **callee 契约**：`fs.rename`（同目录原子；跨设备 EXDEV——staging 与目标同在 binDir 下，同文件系统，不可达）；`fs.rm`（recursive force）；`CryptoHasher`（增量 update）；`downloadToFile`（§5.4）。
- **显式假设链**：步骤 4 依赖 fork-release 资产 URL 形态（H1）；步骤 6 依赖 H4 条目格式；步骤 9 依赖资产布局（实测 `bin/fmcode`+`bin/rg`+`package.json`）；步骤 10 依赖 H2 可写。
- **正确性论证**：
  - 前置: H1-H5；method == "curl"
  - 论证:
    - **根因消除**：替换源 = fork release 资产（自产），校验 = 同 release 的 sha256sums（fork-release workflow 生成），链条闭环于本 fork 发版基础设施 ⇒ 不存在"外部脚本装官方版"的通道
    - **I_3**：步骤 7 在解压（8）/移动（10）之前，失败即退出且仅清理 staging ⇒ 现役文件零接触
    - **I_2**：fmcode 可执行文件的替换是单次 `rename`（POSIX 原子）/ Windows 先 `.old` 后放新——任一时刻磁盘上的 fmcode 要么旧要么新。**边界如实声明**：步骤 10 中 rg/package.json 的 rename 失败时 fmcode 已是新文件而捆绑件未更新（G5 破坏的极窄窗口，概率 = rename 失败率，后果 = 新 fmcode 配旧 rg，自愈 = 重跑升级）；不为这个窗口做回滚——回滚本身（反向 rename）同样是可失败的，复杂度不成比例。此边界写入 FORK_INSTALL 升级说明（"升级失败请重跑一次"）
    - **自动/手动同一实现**：upgrade 不比较版本（决策 8）——比较守卫在自动调用方（§5.6）
  - 后置: 成功 ⇒ binDir 内 fmcode/rg/package.json 均为 target 版本；失败（除部分替换）⇒ 现役文件不变
  - 副作用论证: 写 = staging 目录、binDir 下被替换文件、Windows `.old`；网络 = 两个下载；无其他

### 5.4 `downloadToFile(url, dest)`（installation/index.ts 内部 helper）

- **实现思路**：`httpOk.execute(request)` → `response.stream`（Effect 流）逐块写入 `Bun.file(dest).writer()`；完成后关闭 writer；**不做** Content-Length 进度（无 UI 需求）。失败（含中途断流）→ 删除半截文件后上抛。
- **分支覆盖**：成功 / 请求失败 / 流中断（partial file 清理）。
- **正确性论证**：流式写 ⇒ 内存占用 O(chunk)，30MB 级资产不整载（复用点一节的论证）；partial 清理 ⇒ staging 目录不残留半截文件误入步骤 7。
- **副作用论证**: 写 dest 一个文件。

### 5.5 `util/archive.ts` — `extractTarGz(tarGzPath, destDir)`

- **实现思路**：`Process.run(["tar", "-xzf", tarGzPath, "-C", destDir], { nothrow: true })`——Unix/macOS 系统 tar 均支持 `-z`；**仅非 Windows 调用**（win 走 extractZip），win32 上调用 → die（调用方分支已保证不达）。
- **正确性论证**：trivial（单命令包装；失败码由调用方转 UpgradeFailedError）。

### 5.6 `cli/upgrade.ts` — 自动入口

- **实现思路**：
  1. autoupdate 关闭（`false` 或 Flag）→ return（现状不变）
  2. `current = parseVersion(InstallationVersion)` → **undefined → return**（本地/PR 构建不检查，issue 表第 3 行）
  3. `latest = await Installation.latest(current.channel).catch(() => undefined)` → undefined return（静默，H3）
  4. `parsed = parseVersion(latest)` → undefined return（发布异常防御）
  5. `compareVersion(parsed, current) <= 0` → return（**I_1/I_5：不降级、不重装**）
  6. `kind = getReleaseType(InstallationVersion, latest)`（基线域）；`config.autoupdate === true && kind === "patch"` 不成立 → 发 `UpdateAvailable` 事件 → return
  7. 资格成立 → `Installation.upgrade(method, latest)` → 成功发 `Updated` 事件（现状形状）；失败静默（catch(() => {})）
- **分支覆盖**：关闭 / 不可解析 / 网络失败 / 相等 / 降级 / 基线 major / 基线 minor / notify 且 patch / 自动且 patch 全链。
- **正确性论证**：
  - 前置: 决策 1/8；I_1
  - 论证: 渠道由 `current.channel` 唯一决定（I_4）⇒ G1；步骤 5 守卫 ⇒ 自动路径替换仅在严格更新时发生（G2）；步骤 6 资格门合并了"只提示"的全部情形（基线变化、notify、非 true）
  - 后置: 自动路径下无降级、无跨渠道、失败静默
  - 副作用论证: 事件发送 + 条件性 upgrade；无其他

### 5.7 `cli/cmd/upgrade.ts` — 手动入口

- **实现思路**：现状流程保留（latest 取当前渠道、显示 From→To），改动两点：
  1. **不做比较守卫**（决策 8）：`target` 显式给出时直接 `upgrade(method, target)`——允许降级/跨渠道；`parseVersion` 校验 target，undefined → 报错"unknown version format"
  2. 无 target 时行为 = 自动路径步骤 3-5 的 latest 获取 + 显示（但不做资格门，升级动作照常执行——手动语义：用户敲了命令就是要装）；已是最新 → 现状 "already installed" 提示保留
- **正确性论证**：手动显式指令优先；`parseVersion` 挡住乱串；stub→实装后此命令自动获得真升级（不改调用形状）。

### 5.8 清理

- `UpgradeNotSupportedError` 类删除；`installation.test.ts` 的 stub 用例（2 个）替换为 §6 的实装测试；httpapi-global.test 的 stub mock 改回真实 upgrade mock（升级成功 200 / 失败 500 两用例恢复）。
- `FORK_INSTALL.md` 删除 fmcode-1 标记作废的"关闭自动更新"段（原文已带删除线）。

## 6. 测试计划

- **单元（比较器，纯函数，重点覆盖）**：
  - 定向回归：issue 两个 semver 反例（`fmv2.2-beta.1 < fmv2.2`、`fmv9 < fmv10`）+ `fmv2 < fmv2.1` + 同 beta 号序 + 跨基线（1.18 < 1.19）
  - parseVersion 输入九类（§5.1.1 分支覆盖表），前导零、pr 后缀、缺 fmv 等负例 → undefined
  - **随机测试（fast-check 或手写种子循环）**：生成随机 ForkVersion 元组，验证性质——反对称（cmp(a,b) = -cmp(b,a)）、传递（cmp(a,b) 与 cmp(b,c) 一致 ⇒ cmp(a,c) 一致）、全序完全性（cmp 三态之一恒真）、正式性（stable(a) ∧ beta(b) ∧ 前四级相等 ⇒ cmp(a,b)=1）
- **单元（latest）**：mock HTTP——stable 走 `/releases/latest`；beta 过滤 pre-release 后取比较器最大（列表乱序放置验证不依赖排序）；beta 空集行为
- **单元（upgrade，文件层，tmpdir 真实 fs + mock HTTP/下载）**：校验不符 → 现役文件字节不变（I_3 回归）；解压内容缺 fmcode → 失败；全流程成功 → 三文件内容替换 + staging 清理；Windows 路径（win32 分支在 CI 无 runner 时记录未测面）
- **回归**：installation 全套、httpapi-global（mock 恢复真升级语义）、cli 套件、config 套件（Global.Path 面）
- **E2E（真实构建二进制 + 隔离 XDG）**：
  - 起**本地假 GitHub**（HTTP 服务返回构造的 release JSON + 资产文件），通过环境变量把 API 基址指向本地——**评审项：GitHub API 基址必须可注入**（`installation/index.ts` 的 URL 提为模块常量或 env），否则 E2E 无法脱离真仓库；实现时落此 seam
  - 全链：旧版二进制 + 假 release 新版 → 自动路径发 Updated 事件、文件替换、重启 `fmcode --version` 显示新版
  - 负例：假 release sha256 故意错 → 现役二进制字节不变
  - 手动：`fmcode upgrade <旧版>` → 降级成功（决策 8 的 E2E 证据）
- **边际**：`binDir` 只读（chmod 555）→ UpgradeFailedError 且原样；磁盘满（跳过——无法可靠模拟，记录）

## 7. 完整性自检 checklist

- [x] 所有函数实现思路推导连续（5.3 十二步含全部分支与退出；5.6 七步）
- [x] 所有分支已覆盖（§5.3 十路退出、§5.6 九路、§5.1 九类输入）
- [x] 所有退出点已刻画（§5.3 仅成功 void / UpgradeFailedError 两类；部分替换失败边界显式声明）
- [x] 所有 callee 调用显式引用其 pre/post（rename 原子性/EXDEV、fs.rm、CryptoHasher、downloadToFile、extractZip/TarGz）
- [x] 所有循环有终止性论证（比较器逐级有限；beta 归约有限列表；下载流有限文件）
- [x] 所有上游事实显式列出（H1-H5 + 资产布局实测 + sha256sums 格式实测 + E2E 的 API 基址注入 seam）
