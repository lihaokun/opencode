# Fork 安装器

入口为 `script/fm-install.py`，一个模块，两条准备路径，共用安装与配置收尾。用户已授权实现，默认策略见调研。

- `--mode release`（默认）：`--channel stable`（默认）或 `beta`；可用 `--version` 固定 fork tag。
- `--mode build`：默认临时 clone fork `dev`；`--ref` 选择 fork 分支/tag；`--source` 编译本地 checkout，不切分支、不清理改动，与 `--ref` 互斥。
- `--install-dir` 默认 `~/.opencode/bin`；`--config-dir` 默认 `$XDG_CONFIG_HOME/opencode` 或 `~/.config/opencode`；`--no-modify-path` 禁止修改 PATH。
- release 专属选项不能用于 build。固定 tag 未指定 channel 时由 tag 推导；明确冲突则失败。

流程：P1 校验参数及现有配置 → P2 下载并校验/编译到准备目录 → P3 校验二进制版本 → P4 替换配置与二进制 → P5 添加用户 PATH、报告结果。

不变量：两种模式都设置 autoupdate=false，并在有效 disabled_providers 中加入两个官方 provider。其他配置、注释、凭据原文保留（被替换的两个字段值内部注释除外）；配置错误时拒绝操作。不会回退到上游程序源。下载/编译/校验失败不会覆盖既有安装；替换中的普通文件错误尝试回滚。进程被强杀、断电和多个安装器同时运行不提供事务保证。

PATH 修改失败不撤销成功安装，明确警告及手动命令。运行时显式项目/环境配置仍遵循 OpenCode 自身优先级；本安装器修改全局默认，并不添加运行时强制策略。手动 `opencode upgrade` 仍是原有上游升级功能，更新 fork 应重跑本脚本。

正确性分解：准备阶段只写临时目录或用户选择的源码构建产物；最终收尾为两模式共享，因此默认策略一致。下载资产由精确 tag、平台名及 SHA256 关联；源码版本含提交短 hash，避免冒充发布版本。明确依赖 GitHub 元数据/校验文件可信、本机无并发配置写入；摘要校验不是独立发布签名。
