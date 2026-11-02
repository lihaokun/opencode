# Fork 安装说明

使用仓库的 [`script/fm-install.py`](script/fm-install.py)，需要 Python 3.9 或更新版本。默认下载 **lihaokun/opencode 最新正式发布**；也可以选择 beta 或从源码编译。

## 快速安装

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

更新 fork 时重新运行本脚本。不要使用 `opencode upgrade`、官方 `curl … | bash` 或 `npm i -g opencode-ai`，这些仍是上游升级渠道。

## 版本与平台

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

## 源码编译

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

## 目录、配置与 PATH

- 默认安装到 `~/.opencode/bin`，可用 `--install-dir /path/to/bin` 更改。
- 默认全局配置目录是 `$XDG_CONFIG_HOME/opencode`，未设时为 `~/.config/opencode`；Windows 也使用用户主目录的 `.config/opencode`。`--config-dir` 只选择安装器修改的目录，不改变 OpenCode 自身运行时配置路径。
- 按 OpenCode 的优先级，修改最后一个已存在的 `config.json`、`opencode.json`、`opencode.jsonc`；都不存在则新建 `opencode.json`。支持注释和尾逗号，保留其他字段原文及注释（两个被替换字段值内部的注释除外）。配置无法解析时拒绝安装，避免覆盖。
- 默认把安装目录加入用户 PATH。Unix 修改当前 shell 的用户配置（bash、zsh、fish，其他使用 `.profile`）；Windows 修改用户 Path。`--no-modify-path` 可禁止，之后自行添加。
- 重开终端，执行 `opencode --version`，确认 PATH 优先命中了新安装。Windows 长期运行的终端宿主可能也需完全关闭重开。

脚本设置全局默认值；显式环境/项目配置仍遵循 OpenCode 原有优先级。若运行时指定其他配置路径，应让 `--config-dir` 对准实际使用的全局目录，并检查更高优先级配置。
若目录内还有旧式无扩展名 TOML `config`，脚本会要求先迁移到 JSON/JSONC 并备份移走旧文件，再重跑安装；否则 OpenCode 启动时会再次导入旧文件，覆盖刚设置的开关。

下载、校验、构建失败不会替换既有安装。安装阶段普通文件错误会尝试回滚；不要并行运行安装器，强杀或断电不保证多文件事务。Windows 若旧进程锁定文件，请退出后重试。PATH 修改失败会保留成功安装并提示手动设置。

## 维护者：分支与发版

`main` 是正式线，`dev` 是实验线。改动先落 dev，再由 dev 或其发布分支以 merge commit 晋升 main。
`.github/workflows/fork-release.yml` 按 tag 发版：main 上 `v<upstream>-fmv<N>[.<M>]` 为正式版，dev 上追加 `-beta.<k>` 为预发布；错误分支或不合法名称会被拒绝。
小版本及 beta 序号不写前导零。注释 tag 的内容作为 release notes；轻量 tag 使用 GitHub 自动生成说明。
