# 安装与更新

本 fork 使用 [`script/fm-install.py`](script/fm-install.py)。只需 **Python 3.9+** 即可下载发布版；脚本自动选择平台、校验下载包、安装 `opencode` 与 `rg`、配置用户 PATH，并关闭官方自动更新与官方模型 provider。

## 下载脚本

macOS / Linux：

```bash
curl -fsSL https://raw.githubusercontent.com/lihaokun/opencode/dev/script/fm-install.py -o fm-install.py
```

Windows PowerShell：

```powershell
Invoke-WebRequest https://raw.githubusercontent.com/lihaokun/opencode/dev/script/fm-install.py -OutFile fm-install.py
```

下文使用 `python3 fm-install.py`；Windows 改用 `python .\fm-install.py`。已有仓库时，也可在仓库根目录运行 `python3 script/fm-install.py`。

## 下载发布版

选择其中一种：

```bash
python3 fm-install.py                 # 最新正式版，默认方式
python3 fm-install.py --channel beta  # 最新 beta
```

安装后重开终端，执行 `opencode --version`。发布版的版本号包含 `fmv`；如果仍显示旧版本，检查 `~/.opencode/bin` 是否位于 PATH 前面。Windows 的终端宿主可能需要完全退出后重开。

固定版本时，从 [Releases](https://github.com/lihaokun/opencode/releases) 复制完整 tag，例如：

```bash
python3 fm-install.py --version v1.18.31-fmv2.1
```

`--version` 会自动识别正式或 beta，不必同时写 `--channel`。安装器按数字版本号选择最新版本；上述固定 tag 示例不代表最新版本。

**更新方式相同**：重新下载脚本，再运行原来的通道命令。不要使用 `opencode upgrade` 或上游的 npm / Homebrew / 官方安装脚本更新本 fork。

## 源码构建

预先准备 Git、ripgrep（`rg`）、目标源码 `package.json` 中 `packageManager` 指定的 **精确 Bun 版本**，以及项目所需原生构建依赖。脚本不会代装这些依赖，也不会替换全局 Bun。

```bash
python3 fm-install.py --mode build                 # 临时克隆 fork 的 dev，再构建安装
python3 fm-install.py --mode build --ref main      # 构建 main，也可传其他分支或 tag
python3 fm-install.py --mode build --source .      # 构建当前本地仓库
```

`--source` 不切换分支、不清理已有修改，但会写入依赖和 `dist`。它与 `--ref` 互斥。`--channel` / `--version` 仅用于下载发布版，不用于构建。

源码版本显示为 `0.0.0-source.g<提交>`，存在本地修改时加 `.dirty`。所有源码构建固定 `OPENCODE_CHANNEL=dev`，与本 fork 发布包使用同一数据通道；这里的 channel 不是正式/beta 选择，也不是 Git 分支。

## 默认设置与常用选项

所有模式都设置以下全局默认值：

```json
{
  "autoupdate": false,
  "disabled_providers": ["opencode", "opencode-go"]
}
```

自定义 provider、密钥、模型、其他配置和原有 disabled providers 均保留。程序发布和自动克隆的源码只来自 `lihaokun/opencode`；构建依赖仍使用仓库原有的依赖源。

| 选项                   | 用途 / 默认值                                                                           |
| ---------------------- | --------------------------------------------------------------------------------------- |
| `--install-dir <目录>` | 安装 `opencode` 和 `rg`，默认 `~/.opencode/bin`                                         |
| `--config-dir <目录>`  | 要修改的全局配置目录，默认 `$XDG_CONFIG_HOME/opencode`，未设置时为 `~/.config/opencode` |
| `--no-modify-path`     | 不修改 shell 配置或 Windows 用户 PATH，改由自己添加安装目录                             |
| `--help`               | 查看全部参数、依赖要求与示例                                                            |

配置目录内按 `config.json` → `opencode.json` → `opencode.jsonc` 的顺序选择最后一个存在的文件修改；都不存在则创建 `opencode.json`。支持 JSONC 注释和尾逗号，保留其他字段。Windows 同样使用用户目录下的 `.config/opencode`。

这些是全局默认值，更高优先级的项目或环境配置仍可覆盖。`--config-dir` 只改变安装器修改的位置，不改变 OpenCode 的运行时配置路径。若仍有旧式 TOML `config` 文件，先迁移到 JSON/JSONC 并备份移走旧文件，再重跑脚本。

## 平台与手动安装

脚本自动选包；手动安装时，从同一个 [Release](https://github.com/lihaokun/opencode/releases) 下载对应资产和 `sha256sums.txt`：

| 平台                | 资产                           |
| ------------------- | ------------------------------ |
| macOS Apple Silicon | `opencode-darwin-arm64.tar.gz` |
| macOS Intel         | `opencode-darwin-x64.tar.gz`   |
| Linux x64           | `opencode-linux-x64.tar.gz`    |
| Linux arm64         | `opencode-linux-arm64.tar.gz`  |
| Windows x64         | `opencode-windows-x64.zip`     |

Linux 包要求 glibc，x64 发布包要求 AVX2。目前没有 musl、Windows ARM64 或 baseline 资产；安装器不会回退到上游程序。二进制没有系统代码签名。

手动安装步骤：

1. 将下载包的 SHA-256 与 `sha256sums.txt` 对照。Linux 用 `sha256sum <文件>`，macOS 用 `shasum -a 256 <文件>`，PowerShell 用 `Get-FileHash <文件> -Algorithm SHA256`。
2. 解压，将包内 `bin/` 的 `opencode` 与 `rg`（Windows 为 `.exe`）一起放进安装目录，并把该目录加入 PATH。
3. 在实际使用的全局配置中合并上方的 `autoupdate` 和 `disabled_providers` 设置，保留自己的 provider 配置。
4. 重开终端，执行 `opencode --version` 确认版本。

## 常见问题

- **找不到 Python**：先安装 Python 3.9+；Windows 使用 `python`，macOS / Linux 通常使用 `python3`。
- **Bun 版本不符**：按所选源码的 `packageManager` 安装精确版本；下载发布版无需 Bun。
- **配置解析失败**：修复提示的 JSON/JSONC 文件后再运行，脚本不会覆盖无法解析的配置。
- **Windows 替换文件失败**：退出正在运行的 OpenCode 后重试。
- **安装完成但命令仍旧**：重开终端，检查 PATH 中的安装目录顺序。PATH 修改失败时，按脚本提示手动添加。

不要并行运行多个安装器。下载、校验或构建失败不会替换既有安装；替换阶段的普通文件错误会尝试回滚，强杀或断电不保证多文件原子性。
