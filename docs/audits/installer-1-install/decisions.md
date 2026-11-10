# 安装器审核决策

- 保留其他配置的原文、注释及有效禁用 provider 列表；两个被替换字段值内的注释不保留。文档已明确范围，不为此引入完整 JSONC 编辑依赖。
- JSONC 拒绝 NaN/Infinity；shell profile 按字节追加，兼容原有非 UTF-8 注释。
- 源码安装显式把 OPENCODE_RELEASE 设为空，避免环境变量或 Bun .env 激活共享构建脚本的 release upload。已有构建脚本不修改。
- XDG_CONFIG_HOME 空值按未设置处理，与运行时一致。旧式 TOML config 需要先迁移，安装器拒绝继续；不自动迁移或删除用户文件。
- 无公开源/自动更新开关的特殊例外：release stable、release beta、build 都执行同一配置收尾。
- 仅本机 Linux 进行三条真实路径验证；Windows/macOS 的真实安装与终端行为不声称已验证。归档格式、平台命名和 Windows 路径处理纳入代码审查，Windows 原生测试由 CI 执行。
