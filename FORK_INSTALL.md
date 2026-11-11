# Fork 安装说明

> **分支与版本**：`main`（默认分支）是正式线，`dev` 是测试线；改动先落 `dev`，再以 merge commit 晋升到 `main`
> （直接从 `dev`，或从 `dev` 切出的发布分支）。
> 发版由 tag 驱动（`.github/workflows/fork-release.yml`）：在 `main` 的提交上打 `v1.18.31-fmv2.1` 这样的 tag 就发正式版；
> 在 `dev` 的提交上打 `v1.18.31-fmv3-beta.1` 就发 Pre-release 测试版；其他分支上的 tag、或名字与分支不符的 tag 会被拒绝。
> 版本后缀是 `fmv<代际>` 或 `fmv<代际>.<序号>`：代际很少变，序号是同一代里的第几个正式版；beta 带它通向的版本
> （`fmv3-beta.N`、`fmv2.2-beta.N`）。序号和 beta 号不写前导零：`fmv2.01` 不是合法的 semver。
> tag 用 `git tag -a` 加注释，注释就是 release notes。[Releases](https://github.com/lihaokun/opencode/releases) 里不带 Pre-release 标记的就是正式版；
> 想试最新改动也可以从 `dev` 自己构建。
> release 构建固定 `OPENCODE_CHANNEL=latest`（决定数据库名 `opencode.db`）；本地从源码构建时不设该变量——它会取当前分支名（dev 分支得到 `opencode-dev.db`，`main` 上得到 `opencode-main.db`），与 release 库互不干扰。

## ⚠️ 安装器与 fcode 改名的适配状态

`script/fm-install.py`（#102）在改名（#66）合入 dev 之前编写，当前仍按**改名前**的约定工作：下载 `opencode-*` 资产、安装名为 `opencode` 的二进制到 `~/.opencode/bin`、写配置到 `~/.config/opencode`。已发布的全部 release（截至 `v1.18.31-fmv3-beta.21`）资产确实是 `opencode-*` 命名，安装器对这些存量 release 有效；改名后的首个 `fcode-*` release 产出前需要先把安装器移植到新命名。

## 一、安装器（当前仅适用于存量 `opencode-*` release）

使用仓库的 [`script/fm-install.py`](script/fm-install.py)，需要 Python 3.9 或更新版本。默认下载 **lihaokun/opencode 最新正式发布**；也可以选择 beta 或从源码编译。

### 快速安装

已有仓库时，在仓库根目录执行：

```bash
python3 script/fm-install.py --help          # 查看参数、默认策略与示例
python3 script/fm-install.py                 # 下载最新正式版（默认）
python3 script/fm-install.py --channel beta  # 下载最新 beta
```

也可以单独下载脚本，不必 clone 仓库（脚本合入 dev 后可用）：

```bash
curl -fL https://raw.githubusercontent.com/lihaokun/opencode/dev/script/fm-install.py -o fm-install.py
python3 fm-install.py
```

Windows PowerShell：

```powershell
Invoke-WebRequest https://raw.githubusercontent.com/lihaokun/opencode/dev/script/fm-install.py -OutFile fm-install.py
python .\fm-install.py --channel beta
```

**所有模式都会设置以下全局默认值**：

```json
{
  "autoupdate": false,
  "disabled_providers": ["opencode", "opencode-go"]
}
```

保留自定义 provider、密钥、模型和其他配置；原有 disabled_providers 也保留。安装器仅使用本 fork 的发布和源码，不回退到 OpenCode 官方安装器/npm 程序包。构建依赖仍使用各自原有的依赖源。

说明：#65 之后 `fcode` 自身的自动更新已限定只从本 fork 的 release 取版本（正式版跟正式版、beta 跟 beta，从不降级、不跨渠道），关闭并非安全必需；安装器默认关闭属保守选择，可自行改回 `"autoupdate": true`。

更新 fork 时重新运行本脚本。不要对官方 `opencode` 二进制使用 `opencode upgrade`、官方 `curl … | bash` 或 `npm i -g opencode-ai`，这些仍是上游升级渠道（fcode 与官方版目录分离，互不覆盖）。

### 安装器：版本与平台

```bash
# 固定版本：省略 channel 时按 tag 推导；显式 channel 与 tag 冲突会报错
python3 script/fm-install.py --version v1.18.31-fmv3-beta.18
```

安装器按数字版本号选择正式/beta 发布，不把 beta.9 误排在 beta.18 后面。下载资产必须通过发布内 `sha256sums.txt` 的校验；归档内 `opencode` 和 `rg` 一起安装。

| 平台                | 发布资产                       |
| ------------------- | ------------------------------ |
| Windows x64         | `opencode-windows-x64.zip`     |
| macOS Apple Silicon | `opencode-darwin-arm64.tar.gz` |
| macOS Intel         | `opencode-darwin-x64.tar.gz`   |
| Linux x64           | `opencode-linux-x64.tar.gz`    |
| Linux arm64         | `opencode-linux-arm64.tar.gz`  |

Linux 要求 glibc；x64 发布包要求 AVX2。没有 musl、Windows ARM64 或 baseline 发布资产时，脚本会报不支持或在安装前的可执行文件检查失败；不会换用上游程序。二进制没有系统代码签名，系统若拦截需按本机策略处理。

### 安装器：源码编译

预先安装 Git、ripgrep (`rg`)、源码 `package.json` 中 `packageManager` 指定的 Bun，以及项目原有原生构建依赖。脚本不自动替换全局 Bun。

```bash
# 临时 clone 本 fork 的 dev、构建、安装，再清理临时源码
python3 script/fm-install.py --mode build

# 选择 fork 分支/tag
python3 script/fm-install.py --mode build --ref main

# 使用本地 checkout；保留分支与已有修改，正常写入依赖及 dist
python3 script/fm-install.py --mode build --source .
```

`--source` 和 `--ref` 互斥；`--channel` / `--version` 只用于下载模式。源码构建执行 frozen install，再复用 `packages/opencode/script/build.ts --single --skip-install`，版本标为 `0.0.0-source.g<提交>`（存在本地修改时加 `.dirty`），避免把未发布源码标成正式包。

无论选 main 还是 dev，构建固定 **`OPENCODE_CHANNEL=dev`**。它决定数据目录与 `opencode-dev.db`，不是发布通道；切正式/beta 不会因此打开另一份空数据库。依赖下载、代码生成和编译仍遵循仓库构建脚本。

### 安装器：目录、配置与 PATH

- 默认安装到 `~/.opencode/bin`，可用 `--install-dir /path/to/bin` 更改。
- 默认全局配置目录是 `$XDG_CONFIG_HOME/opencode`，未设时为 `~/.config/opencode`；Windows 也使用用户主目录的 `.config/opencode`。`--config-dir` 只选择安装器修改的目录，不改变程序自身运行时配置路径。
- 按既有优先级，修改最后一个已存在的 `config.json`、`opencode.json`、`opencode.jsonc`；都不存在则新建 `opencode.json`。支持注释和尾逗号，保留其他字段原文及注释（两个被替换字段值内部的注释除外）。配置无法解析时拒绝安装，避免覆盖。
- 默认把安装目录加入用户 PATH。Unix 修改当前 shell 的用户配置（bash、zsh、fish，其他使用 `.profile`）；Windows 修改用户 Path。`--no-modify-path` 可禁止，之后自行添加。
- 重开终端，执行 `opencode --version`，确认 PATH 优先命中了新安装。Windows 长期运行的终端宿主可能也需完全关闭重开。

脚本设置全局默认值；显式环境/项目配置仍遵循程序原有优先级。若运行时指定其他配置路径，应让 `--config-dir` 对准实际使用的全局目录，并检查更高优先级配置。
若目录内还有旧式无扩展名 TOML `config`，脚本会要求先迁移到 JSON/JSONC 并备份移走旧文件，再重跑安装；否则程序启动时会再次导入旧文件，覆盖刚设置的开关。

下载、校验、构建失败不会替换既有安装。安装阶段普通文件错误会尝试回滚；不要并行运行安装器，强杀或断电不保证多文件事务。Windows 若旧进程锁定文件，请退出后重试。PATH 修改失败会保留成功安装并提示手动设置。

---

## 二、手动：从 Releases 安装（fcode 改名后的约定）

> 现有存量 release 资产仍是 `opencode-*` 命名（见上方适配状态）；下表是改名后的发布工作流产出的命名。

选对应平台的包。解压后 `bin/` 里有 `fcode` 和 `rg`（ripgrep），**两个文件放在同一目录并把该目录加入 PATH**：程序按 PATH 找 `rg`，找不到会去 GitHub 下载。

| 平台 | 资产 |
|---|---|
| Windows x64 | `fcode-windows-x64.zip` |
| macOS Apple Silicon | `fcode-darwin-arm64.tar.gz` |
| macOS Intel | `fcode-darwin-x64.tar.gz` |
| Linux x64 | `fcode-linux-x64.tar.gz` |
| Linux arm64 | `fcode-linux-arm64.tar.gz` |

**Windows**（PowerShell，在下载目录执行）：

```powershell
Expand-Archive .\fcode-windows-x64.zip -DestinationPath $env:TEMP\fcode -Force
New-Item -ItemType Directory -Force "$env:USERPROFILE\.fcode\bin" | Out-Null
Copy-Item "$env:TEMP\fcode\fcode-windows-x64\bin\*" "$env:USERPROFILE\.fcode\bin" -Force
[Environment]::SetEnvironmentVariable("Path", "$env:USERPROFILE\.fcode\bin;" + [Environment]::GetEnvironmentVariable("Path", "User"), "User")
```

重开终端后 `fcode --version` 应显示本版本号。二进制未签名，SmartScreen 若拦截选"仍要运行"。

**macOS / Linux**（把 `darwin-arm64` 换成你的包名；bash 用户把 `~/.zshrc` 换成 `~/.bashrc`）：

```bash
tar -xzf fcode-darwin-arm64.tar.gz
mkdir -p ~/.fcode/bin && cp fcode-darwin-arm64/bin/* ~/.fcode/bin/
echo 'export PATH="$HOME/.fcode/bin:$PATH"' >> ~/.zshrc
```

macOS 若提示"无法打开"（未签名、未公证）：`xattr -dr com.apple.quarantine ~/.fcode/bin`。

装了官方版（`curl … | bash` 或 `npm i -g opencode-ai`）的话，官方版与 fcode 目录分离（`~/.opencode/bin` vs `~/.fcode/bin`），互不覆盖，两份各自升级。fcode 自身的自动更新只从本 fork 的 release 取版本，无需关闭（想关仍然支持，见下文）。

校验：`sha256sum -c sha256sums.txt --ignore-missing`；Windows 用 `Get-FileHash .\fcode-windows-x64.zip` 与 `sha256sums.txt` 对照。

---

## 三、手动：从源码构建

### TL;DR

```bash
# 1) 构建(版本号 + channel 都用环境变量)
bun install                                   # 会应用 patches(如 openai-compatible 修复)
cd packages/opencode
OPENCODE_CHANNEL=dev OPENCODE_VERSION=1.18.31-fmv2.1 bun run script/build.ts --single

# 2) 安装到 PATH 生效位置
install -m 0755 dist/opencode-linux-x64/bin/fcode ~/.fcode/bin/fcode
```

验证:`fcode --version` 应显示 `1.18.31-fmv2.1`。

### 1. 版本号:只能用 `OPENCODE_VERSION` 环境变量

版本号由 `packages/script/src/index.ts` 决定,优先级:

1. **`OPENCODE_VERSION` 环境变量** → 逐字采用(我们就用这个:`1.18.31-fmv2.1`)；
2. 否则是 preview 构建 → `0.0.0-<channel>-<时间戳>`（例：`0.0.0-dev-202608161430`）；
3. 否则(官方发布)→ 从 npm 拉 `opencode-ai/latest` 再 bump。

**注意几个"不行"**:

- ❌ **改 `package.json` 的 `version` 没用** —— 构建逻辑根本不读它(官方 package.json 由上游的 `sync release versions` 提交维护,当前是 `1.18.31`,实际发布版本仍走 npm+bump)。
- ❌ **加 git tag 也没用** —— 版本逻辑不读任何 tag(`git describe`/`refs/tags` 都没用到)。CI 发版时是 workflow 把 tag 名去掉前缀 `v` 后塞进 `OPENCODE_VERSION`，本地构建仍要自己传。
- ℹ️ 唯一沾 git 的是**分支名 = channel**（`git branch --show-current`），只影响 preview 版本里的 `<channel>` 段,不是 tag。

所以自定义版本**必须**在构建时传 `OPENCODE_VERSION`。

### 2. Channel:用 `OPENCODE_CHANNEL` 决定数据目录

- release 包固定 `OPENCODE_CHANNEL=latest` → 数据库名 `opencode.db`（干净名，无渠道后缀）。
- 本地源码构建不设该变量时取当前分支名（dev → `opencode-dev.db`，main → `opencode-main.db`），与 release 库互不干扰。
- Channel 与版本号**互不干扰**（一个走 `OPENCODE_CHANNEL`，一个走 `OPENCODE_VERSION`）。

### 3. 安装到哪

release 包解压出的 `bin/` 里有 `fcode` 和 `rg` 两个文件，把所在目录加入 PATH 即可（推荐 `~/.fcode/bin`）：

```bash
mkdir -p ~/.fcode/bin
install -m 0755 dist/opencode-linux-x64/bin/* ~/.fcode/bin/
echo 'export PATH="$HOME/.fcode/bin:$PATH"' >> ~/.zshrc
```

若 `~/.local/bin` 里还留着旧的 `opencode`/`fcode`，一并清理，避免 PATH 顺序命中旧版本。

### 4. 自动更新（可选关闭）

自动更新只从本 fork 的 release 取版本：正式版（`releases/latest`）跟正式版，beta（tag 带 `-beta.N`）跟 beta，互不交叉；比较用 fork 专用顺序（基线 → 代际 → 序号 → 正式版高于其 beta → beta 号），只在目标严格更新时升级，绝不降级。基线 major/minor 变化只提示不自动装。

想关（二选一）：

- config 里 `autoupdate: false`（`false` 完全关 / `"notify"` 只提示 / `true` 自动装，默认 `true`）
- 环境变量 `OPENCODE_DISABLE_AUTOUPDATE=1`（或新前缀 `FCODE_DISABLE_AUTOUPDATE`，旧前缀仍可用）

---

### 备注

- 每次改了 fork 代码想重装:重跑第 1、2 步即可（`bun install` 会重新应用 patches）。
- 想换后缀/channel/安装目录,改对应的环境变量即可,无需改脚本。
- 源码构建产物目录名仍以包名为前缀（如 `dist/opencode-linux-x64/`），其中的二进制是 `bin/fcode`。

## 维护者：分支与发版

`main` 是正式线，`dev` 是实验线。改动先落 dev，再由 dev 或其发布分支以 merge commit 晋升 main。
`.github/workflows/fork-release.yml` 按 tag 发版：main 上 `v<upstream>-fmv<N>[.<M>]` 为正式版，dev 上追加 `-beta.<k>` 为预发布；错误分支或不合法名称会被拒绝。
小版本及 beta 序号不写前导零。注释 tag 的内容作为 release notes；轻量 tag 使用 GitHub 自动生成说明。
