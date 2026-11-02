# Fork 安装器调研

用户确认：默认下载正式发布，可选 beta，也能从源码编译；所有选项默认关闭官方自动更新、`opencode` / `opencode-go` provider。程序发布与源码只来自 `lihaokun/opencode`，保留用户其他配置。

仓库事实：根目录 `install` 是上游安装器，不能复用其下载源和资产命名。`fork-release.yml` 发布五种资产，macOS/Linux 为 tar.gz，Windows x64 为 zip；都带 `opencode`、`rg`，并发布 `sha256sums.txt`。正式 tag 和 beta tag 的格式见根 AGENTS.md。

源码构建复用 `packages/opencode/script/build.ts --single --skip-install`；先按 packageManager 指定的 Bun 执行 frozen install。构建固定 `OPENCODE_CHANNEL=dev`，防止改用另一份数据库。构建依赖（Bun、Git、ripgrep、原生编译工具）由用户预装。

全局 JSON 配置合并顺序为 `config.json` → `opencode.json` → `opencode.jsonc`。写低优先级文件不能覆盖已有 jsonc 中的开关。安装器应修改最后一个存在的文件，保留其他字段及其注释；已有 disabled_providers 也保留。运行时还会最后导入旧式 TOML `config`；首版对这种配置提示先迁移，不自动改写 TOML。

选择单文件 Python 3 标准库脚本：下载模式无需 Bun，可处理三个操作系统的归档、校验及配置。保留上游安装器及运行时代码不动。Python 最低 3.9；首版覆盖当前五种发布平台，Linux 要求 glibc，x64 发布包要求 AVX2。使用独立目录验证，不直接安装到开发者账户。
