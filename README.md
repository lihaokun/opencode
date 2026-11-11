# OpenCode · lihaokun fork

用于终端编程与多 Agent 协作的 OpenCode 分支，基于 [anomalyco/opencode](https://github.com/anomalyco/opencode)。本仓库独立维护 Agent 管理、长会话恢复和运行时修复，按需合入上游更新。

[正式版](https://github.com/lihaokun/opencode/releases/latest) · [全部发布 / beta](https://github.com/lihaokun/opencode/releases) · [安装选项](FORK_INSTALL.md) · [问题反馈](https://github.com/lihaokun/opencode/issues)

## 安装

需要 **Python 3.9+**。使用本仓库的安装脚本，默认下载最新正式版，无需安装 Bun 或克隆仓库。

**macOS / Linux：**

```bash
curl -fsSL https://raw.githubusercontent.com/lihaokun/opencode/dev/script/fm-install.py -o fm-install.py
python3 fm-install.py
```

**Windows PowerShell：**

```powershell
Invoke-WebRequest https://raw.githubusercontent.com/lihaokun/opencode/dev/script/fm-install.py -OutFile fm-install.py
python .\fm-install.py
```

脚本来自 `dev`，**安装哪个版本由参数决定**。上面命令默认安装正式版；要用 beta 或编译源码，将最后一行换成对应命令：

| 需求                  | 命令（Windows 将 `python3` 换成 `python`） |
| --------------------- | ------------------------------------------ |
| 最新正式版（默认）    | `python3 fm-install.py`                    |
| 最新 beta             | `python3 fm-install.py --channel beta`     |
| 从最新 `dev` 源码构建 | `python3 fm-install.py --mode build`       |
| 查看全部选项          | `python3 fm-install.py --help`             |

下载模式会自动选择平台、验证 SHA-256、安装 `opencode` 和 `rg`，并配置用户 PATH。默认目录为 `~/.opencode/bin`。源码模式还需要 Git、ripgrep、源码要求的 Bun 版本及原生构建依赖，见[源码构建](FORK_INSTALL.md#源码构建)。

**所有安装模式默认关闭官方自动更新和 `opencode` / `opencode-go` 官方模型 provider**，保留自定义 provider、密钥及其他配置。这是全局默认值，项目或环境配置仍可能覆盖它。

支持 macOS、Linux 的 x64 / arm64 和 Windows x64；Linux 要求 glibc，x64 发布包要求 AVX2。平台限制和手动安装见[完整安装说明](FORK_INSTALL.md)。

## 开始使用

安装完成后**重开终端**，确认版本并进入项目：

```bash
opencode --version
cd /path/to/your/project
opencode
```

首次使用可在 TUI 输入 `/connect` 连接自己的模型 provider；已有 provider 配置会保留。版本号应包含 `fmv`；源码构建显示 `0.0.0-source.g<提交>`。

**升级也使用同一安装脚本**：重新下载脚本，再按所需通道运行。不要用 `opencode upgrade`、官方安装脚本或 `npm i -g opencode-ai` 更新这个 fork，它们仍指向上游。

## 这个分支提供什么

- **多 Agent 协作**：`agent` 创建子 Agent；`agent_list` / `agent_status` 查询；`agent_send` 在父、子和兄弟会话之间发消息，并可唤醒空闲 Agent；`agent_stop` 停止执行、保留会话。默认创建独立工作目录，Git 项目使用 worktree。
- **进度与结果反馈**：子 Agent 完成或失败后自动向父会话报告；请求尾部提供正在运行及最近结束的子 Agent 信息，TUI 可查看并进入子会话。
- **长会话与大项目修复**：上下文溢出恢复、流中断处理、消息时序和重复调用检测；改动摘要保存文件名与增删行数，详细 diff 按需计算。

以上描述当前 `dev`；正式版可能尚未包含最新改动，具体以各版 [Release notes](https://github.com/lihaokun/opencode/releases) 为准。

## 开发与发布

改动通过 PR 合入 `dev`；`main` 是正式线。正式版来自 `main`，beta 来自 `dev`，均由 tag 触发 [fork-release](.github/workflows/fork-release.yml) 构建并发布到本仓库。

- [开发规范与版本规则](AGENTS.md)
- [开发工作流](docs/workflow.md)
- [功能设计](docs/design/)与[修复记录](docs/fixes/)

本仓库发布 CLI 安装包。上游文档和桌面端下载描述的是上游产品，不代表本 fork 的发布内容。项目遵循 [MIT 许可证](LICENSE)。
