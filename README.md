# opencode（lihaokun fork）

基于 [anomalyco/opencode](https://github.com/anomalyco/opencode) 的独立分支。功能面和运行时行为已与上游分化，
**不再向上游提交改动**；上游的更新按需择优合入 `dev`。下方保留上游原版 README 作为通用使用说明。

## 与上游的差别

### 多 Agent 协作

上游的 `task` 工具换成了一组 Agent 管理工具，子 agent 成为可寻址、可恢复、可对话的会话：

- **`agent`**：异步委派。每个子 agent 在**独立的 git worktree** 里工作，互不踩脚；可以起名、可以指定目录接续已有 worktree；
  有嵌套深度上限，权限从父会话派生。
- **`agent_list` / `agent_send` / `agent_stop`**：查看整棵 Agent 树和各成员状态；父、子、兄弟之间**任意方向直接发消息**，
  人也可以在 TUI 里直接给某个子 agent 输入；按需停止一个 agent 并保留它的上下文，之后还能用 `agent_send` 唤醒。
- **停机即报告**：子 agent 每次 run 结束（完成或失败，包括输出超长、provider 报错）都自动向父报告；父会话每轮只看到
  **正在运行**的子 agent 名单，不被历史条目淹没。
- **TUI 操作面**：输入框底部常驻 Agents 面板；输入为空时按 `down` 打开 Agents 对话框跳转；委派结果在父转录里显示为一行提示；
  进入子会话视图可以直接输入。

### 稳定性

面向长会话、多 agent 并行、大输出的场景做了一批 session 层修复，每一项都有 `docs/fixes/` 下的根因文档与回归测试：

- 上下文溢出的恢复与压缩边界；provider 流中断、不完整响应、碎片化推理块的收口；
- 消息 id 跨 36 位回绕后的时序；runner 空闲竞态；周期性重复的死循环检测；
- 每轮改动摘要只记录文件名与增删行数，patch 按需从快照重算——消息体量、事件表和内存不再随工作区变动文件的大小增长；
- 子 agent 输出超长时父会话能收到明确的失败通知；无提交的 git 仓库也能为子 agent 建 worktree。

### 发布与分支

- `main` 是正式线（默认分支），`dev` 是测试线；改动先进 `dev`，稳定后以 merge commit 晋升到 `main`。
- 发版由 tag 驱动：`main` 上的 `v1.18.31-fmv3` 是正式版，`dev` 上的 `v1.18.31-fmv3-beta.1` 是 Pre-release。
- [Releases](https://github.com/lihaokun/opencode/releases) 提供 Linux / macOS / Windows 五个平台的预编译包，内含 ripgrep；
  安装三步（解压、加 PATH、关掉官方自动更新）见 [`FORK_INSTALL.md`](FORK_INSTALL.md)，每个 release 的说明里也有同样的步骤。

### 开发流程

本分支按 [`docs/workflow.md`](docs/workflow.md) 的半形式化流程开发：新能力先有调研与架构文档
（见 [`docs/design/`](docs/design/)），缺陷修复先有八部分修正方案文档（见 [`docs/fixes/`](docs/fixes/)），
修复附带独立审核与分层测试（基本 / 边缘 / 随机）。

---

> 以下为上游原版 README。


<p align="center">
  <a href="https://opencode.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="OpenCode logo">
    </picture>
  </a>
</p>
<p align="center">The open source AI coding agent.</p>
<p align="center">
  <a href="https://opencode.ai/discord"><img alt="Discord" src="https://img.shields.io/discord/1391832426048651334?style=flat-square&label=discord" /></a>
  <a href="https://www.npmjs.com/package/opencode-ai"><img alt="npm" src="https://img.shields.io/npm/v/opencode-ai?style=flat-square" /></a>
  <a href="https://github.com/anomalyco/opencode/actions/workflows/publish.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/anomalyco/opencode/publish.yml?style=flat-square&branch=dev" /></a>
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a> |
  <a href="README.zht.md">繁體中文</a> |
  <a href="README.ko.md">한국어</a> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.es.md">Español</a> |
  <a href="README.fr.md">Français</a> |
  <a href="README.it.md">Italiano</a> |
  <a href="README.da.md">Dansk</a> |
  <a href="README.ja.md">日本語</a> |
  <a href="README.pl.md">Polski</a> |
  <a href="README.ru.md">Русский</a> |
  <a href="README.bs.md">Bosanski</a> |
  <a href="README.ar.md">العربية</a> |
  <a href="README.no.md">Norsk</a> |
  <a href="README.br.md">Português (Brasil)</a> |
  <a href="README.th.md">ไทย</a> |
  <a href="README.tr.md">Türkçe</a> |
  <a href="README.uk.md">Українська</a> |
  <a href="README.bn.md">বাংলা</a> |
  <a href="README.gr.md">Ελληνικά</a> |
  <a href="README.vi.md">Tiếng Việt</a>
</p>

[![OpenCode Terminal UI](packages/web/src/assets/lander/screenshot.png)](https://opencode.ai)

---

### Installation

```bash
# YOLO
curl -fsSL https://opencode.ai/install | bash

# Package managers
npm i -g opencode-ai@latest        # or bun/pnpm/yarn
scoop install opencode             # Windows
choco install opencode             # Windows
brew install anomalyco/tap/opencode # macOS and Linux (recommended, always up to date)
brew install opencode              # macOS and Linux (official brew formula, updated less)
sudo pacman -S opencode            # Arch Linux (Stable)
paru -S opencode-bin               # Arch Linux (Latest from AUR)
mise use -g opencode               # Any OS
nix run nixpkgs#opencode           # or github:anomalyco/opencode for latest dev branch
```

> [!TIP]
> Remove versions older than 0.1.x before installing.

### Desktop App (BETA)

OpenCode is also available as a desktop application. Download directly from the [releases page](https://github.com/anomalyco/opencode/releases) or [opencode.ai/download](https://opencode.ai/download).

| Platform              | Download                           |
| --------------------- | ---------------------------------- |
| macOS (Apple Silicon) | `opencode-desktop-mac-arm64.dmg`   |
| macOS (Intel)         | `opencode-desktop-mac-x64.dmg`     |
| Windows               | `opencode-desktop-windows-x64.exe` |
| Linux                 | `.deb`, `.rpm`, or `.AppImage`     |

```bash
# macOS (Homebrew)
brew install --cask opencode-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/opencode-desktop
```

#### Installation Directory

The install script respects the following priority order for the installation path:

1. `$OPENCODE_INSTALL_DIR` - Custom installation directory
2. `$XDG_BIN_DIR` - XDG Base Directory Specification compliant path
3. `$HOME/bin` - Standard user binary directory (if it exists or can be created)
4. `$HOME/.opencode/bin` - Default fallback

```bash
# Examples
OPENCODE_INSTALL_DIR=/usr/local/bin curl -fsSL https://opencode.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://opencode.ai/install | bash
```

### Agents

OpenCode includes two built-in agents you can switch between with the `Tab` key.

- **build** - Default, full-access agent for development work
- **plan** - Read-only agent for analysis and code exploration
  - Denies file edits by default
  - Asks permission before running bash commands
  - Ideal for exploring unfamiliar codebases or planning changes

Also included is a **general** subagent for complex searches and multistep tasks.
This is used internally and can be invoked using `@general` in messages.

Learn more about [agents](https://opencode.ai/docs/agents).

### Documentation

For more info on how to configure OpenCode, [**head over to our docs**](https://opencode.ai/docs).

### Contributing

If you're interested in contributing to OpenCode, please read our [contributing docs](./CONTRIBUTING.md) before submitting a pull request.

### Building on OpenCode

If you are working on a project that's related to OpenCode and is using "opencode" as part of its name, for example "opencode-dashboard" or "opencode-mobile", please add a note to your README to clarify that it is not built by the OpenCode team and is not affiliated with us in any way.

---

**Join our community** [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
