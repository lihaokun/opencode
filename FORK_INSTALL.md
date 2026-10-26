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

两种安装方式：**从 [Releases](https://github.com/lihaokun/opencode/releases) 下载预编译包**（推荐），或**从源码构建**（想试 `dev` 上还没发版的改动时）。
注意：装了官方版（`curl … | bash` 或 `npm i -g opencode-ai`）的话，**官方版自己的自动更新**会把它的二进制换回官方新版——官方版与 fmcode 现在目录分离（`~/.opencode/bin` vs `~/.fmcode/bin`），互不覆盖，但两份各自升级。fmcode 自身的自动更新在进程内替换落地前只提示不执行（#65），无需关闭。

---

## 一、从 Releases 安装（推荐）

选对应平台的包。解压后 `bin/` 里有 `fmcode` 和 `rg`（ripgrep），**两个文件放在同一目录并把该目录加入 PATH**：程序按 PATH 找 `rg`，找不到会去 GitHub 下载。

| 平台 | 资产 |
|---|---|
| Windows x64 | `fmcode-windows-x64.zip` |
| macOS Apple Silicon | `fmcode-darwin-arm64.tar.gz` |
| macOS Intel | `fmcode-darwin-x64.tar.gz` |
| Linux x64 | `fmcode-linux-x64.tar.gz` |
| Linux arm64 | `fmcode-linux-arm64.tar.gz` |

**Windows**（PowerShell，在下载目录执行）：

```powershell
Expand-Archive .\fmcode-windows-x64.zip -DestinationPath $env:TEMP\fmcode -Force
New-Item -ItemType Directory -Force "$env:USERPROFILE\.fmcode\bin" | Out-Null
Copy-Item "$env:TEMP\fmcode\fmcode-windows-x64\bin\*" "$env:USERPROFILE\.fmcode\bin" -Force
[Environment]::SetEnvironmentVariable("Path", "$env:USERPROFILE\.fmcode\bin;" + [Environment]::GetEnvironmentVariable("Path", "User"), "User")
```

重开终端后 `fmcode --version` 应显示本版本号。二进制未签名，SmartScreen 若拦截选"仍要运行"。

**macOS / Linux**（把 `darwin-arm64` 换成你的包名；bash 用户把 `~/.zshrc` 换成 `~/.bashrc`）：

```bash
tar -xzf fmcode-darwin-arm64.tar.gz
mkdir -p ~/.fmcode/bin && cp fmcode-darwin-arm64/bin/* ~/.fmcode/bin/
echo 'export PATH="$HOME/.fmcode/bin:$PATH"' >> ~/.zshrc
```

macOS 若提示"无法打开"（未签名、未公证）：`xattr -dr com.apple.quarantine ~/.fmcode/bin`。

~~关闭官方自动更新（必须）~~——**此节作废**：目录分离后官方更新器只动 `~/.opencode/bin`，碰不到 fmcode；fmcode 自身的自动更新在进程内替换落地（#65）前只提示不执行，无需关闭。

校验：`sha256sum -c sha256sums.txt --ignore-missing`；Windows 用 `Get-FileHash .\fmcode-windows-x64.zip` 与 `sha256sums.txt` 对照。

---

## 二、从源码构建

### TL;DR

```bash
# 1) 构建(版本号 + channel 都用环境变量)
bun install                                   # 会应用 patches(如 openai-compatible 修复)
cd packages/opencode
OPENCODE_CHANNEL=dev OPENCODE_VERSION=1.18.31-fmv2.1 bun run script/build.ts --single

# 2) 安装到 PATH 生效位置(官方安装器/更新器用的就是这里)
install -m 0755 dist/fmcode-linux-x64/bin/fmcode ~/.fmcode/bin/fmcode

# 3) 关闭自动更新(二选一,均无需改代码)——见下文
```

验证:`fmcode --version` 应显示 `1.18.31-fmv2.1`。

---

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

release 包解压出的 `bin/` 里有 `fmcode` 和 `rg` 两个文件，把所在目录加入 PATH 即可（推荐 `~/.fmcode/bin`）：

```bash
mkdir -p ~/.fmcode/bin
install -m 0755 dist/fmcode-linux-x64/bin/* ~/.fmcode/bin/
echo 'export PATH="$HOME/.fmcode/bin:$PATH"' >> ~/.zshrc
```

若 `~/.local/bin` 里还留着旧的 `opencode`/`fmcode`，一并清理，避免 PATH 顺序命中旧版本。

### 4. 关闭自动更新(无需改代码,二选一)

自动更新的判定在 `upgrade.ts`：`if (config.autoupdate === false || Flag.OPENCODE_DISABLE_AUTOUPDATE) return`。两条都能关，任选其一:

#### 方式 A(推荐):全局 config 设 `autoupdate: false`

opencode 会合并加载 `~/.config/opencode/opencode.json` 和 `opencode.jsonc`。把开关写进 **`opencode.json`**(纯 JSON,不碰 `.jsonc` 里的密钥):

```bash
mkdir -p ~/.config/opencode
# 有 jq:
jq '.autoupdate = false' ~/.config/opencode/opencode.json 2>/dev/null > /tmp/oc.json && mv /tmp/oc.json ~/.config/opencode/opencode.json
# 没有 jq、且文件不存在时:
printf '{\n  "$schema": "https://opencode.ai/config.json",\n  "autoupdate": false\n}\n' > ~/.config/opencode/opencode.json
```

`autoupdate` 取值:`false`(完全关) / `"notify"`(只提示不装) / `true`(默认,自动装)。

#### 方式 B:运行时环境变量 `OPENCODE_DISABLE_AUTOUPDATE`

写进 shell profile（`~/.bashrc` / `~/.zshrc`）——这是**运行时** env(`Flag` 运行时读 `process.env`,所以这个有效；注意它**不能在编译期烧进二进制**，因为读的是动态下标 `process.env[key]`）：

```bash
echo 'export OPENCODE_DISABLE_AUTOUPDATE=1' >> ~/.bashrc
```

---

### 备注

- 每次改了 fork 代码想重装:重跑第 1、2 步即可（`bun install` 会重新应用 patches）。
- 想换后缀/channel/安装目录,改对应的环境变量即可,无需改脚本。
- 目标平台产物名形如 `fmcode-<os>-<arch>`（如 `fmcode-linux-x64`、`fmcode-darwin-arm64`）。
