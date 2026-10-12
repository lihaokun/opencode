# Fork 安装说明

> **分支与版本**：`main`（默认分支）是正式线，`dev` 是测试线；改动先落 `dev`，再以 merge commit 晋升到 `main`。
> 发版由 tag 驱动（`.github/workflows/fork-release.yml`）：在 `main` 的提交上打 `v1.18.31-fmv3` 这样的 tag 就发正式版；
> 在 `dev` 的提交上打 `v1.18.31-fmv3-beta.1` 就发 Pre-release 测试版；其他分支上的 tag、或名字与分支不符的 tag 会被拒绝。
> tag 用 `git tag -a` 加注释，注释就是 release notes。[Releases](https://github.com/lihaokun/opencode/releases) 里不带 Pre-release 标记的就是正式版；
> 想试最新改动也可以从 `dev` 自己构建。
> 无论在哪个分支构建，`OPENCODE_CHANNEL` 都保持 `dev`——它决定的是数据目录（`opencode-dev.db`），不是分支；
> 不设时它会取当前分支名，在 `main` 上裸构建会得到一份空的 `opencode-main.db`。

两种安装方式：**从 [Releases](https://github.com/lihaokun/opencode/releases) 下载预编译包**（推荐），或**从源码构建**（想试 `dev` 上还没发版的改动时）。
两种都要关掉官方自动更新：官方的 `curl … | bash` 安装脚本和 `npm i -g opencode-ai` 只装官方版，而官方版的自动更新会把自建或下载的 fork 二进制悄悄换回官方 `1.18.x`（实测如此）。

---

## 一、从 Releases 安装（推荐）

选对应平台的包。解压后 `bin/` 里有 `opencode` 和 `rg`（ripgrep），**两个文件放在同一目录并把该目录加入 PATH**：程序按 PATH 找 `rg`，找不到会去 GitHub 下载。

| 平台 | 资产 |
|---|---|
| Windows x64 | `opencode-windows-x64.zip` |
| macOS Apple Silicon | `opencode-darwin-arm64.tar.gz` |
| macOS Intel | `opencode-darwin-x64.tar.gz` |
| Linux x64 | `opencode-linux-x64.tar.gz` |
| Linux arm64 | `opencode-linux-arm64.tar.gz` |

**Windows**（PowerShell，在下载目录执行）：

```powershell
Expand-Archive .\opencode-windows-x64.zip -DestinationPath $env:TEMP\opencode -Force
New-Item -ItemType Directory -Force "$env:USERPROFILE\.opencode\bin" | Out-Null
Copy-Item "$env:TEMP\opencode\opencode-windows-x64\bin\*" "$env:USERPROFILE\.opencode\bin" -Force
[Environment]::SetEnvironmentVariable("Path", "$env:USERPROFILE\.opencode\bin;" + [Environment]::GetEnvironmentVariable("Path", "User"), "User")
```

重开终端后 `opencode --version` 应显示本版本号。二进制未签名，SmartScreen 若拦截选"仍要运行"。

**macOS / Linux**（把 `darwin-arm64` 换成你的包名；bash 用户把 `~/.zshrc` 换成 `~/.bashrc`）：

```bash
tar -xzf opencode-darwin-arm64.tar.gz
mkdir -p ~/.opencode/bin && cp opencode-darwin-arm64/bin/* ~/.opencode/bin/
echo 'export PATH="$HOME/.opencode/bin:$PATH"' >> ~/.zshrc
```

macOS 若提示"无法打开"（未签名、未公证）：`xattr -dr com.apple.quarantine ~/.opencode/bin`。

**关闭官方自动更新（必须）**：官方更新器会把这个 fork 版本换回官方 1.18.x。在 `~/.config/opencode/opencode.json`（Windows 是 `%USERPROFILE%\.config\opencode\opencode.json`）里加：

```json
{ "autoupdate": false }
```

校验：`sha256sum -c sha256sums.txt --ignore-missing`；Windows 用 `Get-FileHash .\opencode-windows-x64.zip` 与 `sha256sums.txt` 对照。

---

## 二、从源码构建

### TL;DR

```bash
# 1) 构建(版本号 + channel 都用环境变量)
bun install                                   # 会应用 patches(如 openai-compatible 修复)
cd packages/opencode
OPENCODE_CHANNEL=dev OPENCODE_VERSION=1.18.31-fmv2 bun run script/build.ts --single

# 2) 安装到 PATH 生效位置(官方安装器/更新器用的就是这里)
install -m 0755 dist/opencode-linux-x64/bin/opencode ~/.opencode/bin/opencode

# 3) 关闭自动更新(二选一,均无需改代码)——见下文
```

验证:`opencode --version` 应显示 `1.18.31-fmv2`。

---

### 1. 版本号:只能用 `OPENCODE_VERSION` 环境变量

版本号由 `packages/script/src/index.ts` 决定,优先级:

1. **`OPENCODE_VERSION` 环境变量** → 逐字采用(我们就用这个:`1.18.31-fmv2`)；
2. 否则是 preview 构建 → `0.0.0-<channel>-<时间戳>`（例：`0.0.0-dev-202608161430`）；
3. 否则(官方发布)→ 从 npm 拉 `opencode-ai/latest` 再 bump。

**注意几个"不行"**:

- ❌ **改 `package.json` 的 `version` 没用** —— 构建逻辑根本不读它(官方 package.json 由上游的 `sync release versions` 提交维护,当前是 `1.18.31`,实际发布版本仍走 npm+bump)。
- ❌ **加 git tag 也没用** —— 版本逻辑不读任何 tag(`git describe`/`refs/tags` 都没用到)。CI 发版时是 workflow 把 tag 名去掉前缀 `v` 后塞进 `OPENCODE_VERSION`，本地构建仍要自己传。
- ℹ️ 唯一沾 git 的是**分支名 = channel**（`git branch --show-current`），只影响 preview 版本里的 `<channel>` 段,不是 tag。

所以自定义版本**必须**在构建时传 `OPENCODE_VERSION`。

### 2. Channel:用 `OPENCODE_CHANNEL` 决定数据目录

- `OPENCODE_CHANNEL=dev` → 用 `opencode-dev.db`（与之前的 fork 安装同一份会话/数据）。
- 不设则默认取当前分支名当 channel。
- Channel 与版本号**互不干扰**（一个走 `OPENCODE_CHANNEL`，一个走 `OPENCODE_VERSION`）。

### 3. 安装到哪

`~/.opencode/bin/` 通常在 PATH 最前(官方安装器/自动更新器就装在这),所以装这里最稳:

```bash
# 建议先备份官方二进制再覆盖(可回退)
[ -f ~/.opencode/bin/opencode ] && mv ~/.opencode/bin/opencode ~/.opencode/bin/opencode.official.bak
install -m 0755 dist/opencode-linux-x64/bin/opencode ~/.opencode/bin/opencode
```

如果 `~/.local/bin` 里也有一份 `opencode`,一并刷新，避免 PATH 顺序服务到旧版本。

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
- 目标平台产物名形如 `opencode-<os>-<arch>`（如 `opencode-linux-x64`、`opencode-darwin-arm64`）。
