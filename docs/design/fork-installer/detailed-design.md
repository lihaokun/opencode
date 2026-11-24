# Fork 安装器细化

## 输入、数据与失败

CLI 由 argparse 校验枚举及互斥条件，参数错误退出非零且不写安装目标。发布对象是 GitHub release JSON；只接受符合 fork tag 文法的非 draft 项，stable 还排除 prerelease。beta 由 tag 判断，兼容历史标签遗漏 prerelease 标记。按数字版本元组排序，不按字符串或发布时间排序。分页直到空页；网络失败终止，不能从不完整列表猜版本。

`release_key(tag)` 返回 upstream 三元组、fork 代际/小版本、beta 序号或空；`select_release` 返回所需 channel 的最大项，无候选报错。列表遍历有限，max 的序关系就是版本契约。

`download_release` 只取 fork API 的精确资产。摘要清单必须有唯一对应条目，下载边写磁盘边计算摘要。归档只读取 `<platform>/bin/opencode[.exe]` 和 `rg[.exe]` 两个普通文件，不执行 extractall，不接受同名重复项/链接；错误发生在安装前。

`build_source`：检查 git/bun/rg；无 source 时 clone fork 指定 ref 到临时目录，有 source 时只构建该 checkout。比较 Bun 与 packageManager；frozen install 后调用现有 build 脚本，固定数据 channel=dev，版本为 `0.0.0-source.g<sha>[.dirty]`。显式设 OPENCODE_RELEASE 为空，禁止继承环境或 .env 打开发版上传。取 Bun 的实际 OS/arch 对应产物，复制 rg。命令失败传播，既有安装不变；依赖和 dist 是源码模式明确副作用。

## 配置

`parse_jsonc` 屏蔽字符串外的注释和尾逗号，但保持字符偏移；标准 JSON decoder 验证对象并定位顶层字段值区间。扫描随字符串长度前进，有限终止。`update_config` 只替换目标字段区间，缺失字段插入最后一个值后；因此其余原文不变。再次应用结果相同（幂等）。

`prepare_config` 按全局加载顺序读取，取最后存在文件为写入目标；disabled_providers 采用最后有该字段的配置并去重追加官方项，要求字符串数组。无文件则创建 opencode.json。拒绝存在旧式无扩展名 TOML config 的目录，要求先迁移：运行时最后导入它会覆盖新开关。XDG_CONFIG_HOME 未设置或为空均回退到 ~/.config，与运行时一致。JSONC 错误只报告文件/位置，不打印正文。已有符号链接保留并更新目标文件；文件权限保留，新配置 0600。只在安装收尾写入。

## 安装和环境

`install_files` 在各目标旁准备临时文件，保存原内容与权限，逐一 replace。普通失败按反序还原已替换的文件；若回滚也失败，明确报出并保留备份。配置先于可执行文件写入。预检/备份失败不替换任何文件。显式假设安装期间没有其他写入者；强杀不保证回滚。

`configure_path`：Unix 追加到当前 shell 的用户配置（bash/zsh/fish，其他 .profile）；Windows 修改 HKCU Environment Path；不要求管理员，不改系统 PATH。同一条目不重复添加。失败警告并提供手动设置。`main` 串联 P1-P5，TemporaryDirectory 在正常/异常退出清理下载与 clone；所有外部命令用参数数组，不用 shell 插值。

## 验证

基本：stable/beta/pin、下载校验和两种归档、build 命令与环境、两模式共用默认配置。边界：无发行版/资产、校验失败、坏归档、坏配置、既有安装回滚、路径含空格。PBT：随机版本选择及通道隔离；随机配置字段/字符串/注释的保留与幂等。测试不访问真实用户配置，不安装到真实 HOME。
