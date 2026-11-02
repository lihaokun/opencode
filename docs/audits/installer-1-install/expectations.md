# 安装器契约预期（实施前）

## 1. 契约源

fork-installer 的 research、architecture、detailed-design；用户确认的全部模式默认关闭官方更新及两个 provider。

## 2. 字段

全局配置 autoupdate=false；disabled_providers 为原有效列表加 opencode/opencode-go。其他键及注释保留；替换的两个字段值内部注释除外。

## 3. 枚举

mode=release/build；channel=stable/beta。release 默认 stable。

## 4. 流程

P1 校验参数与配置 → P2 准备程序 → P3 版本校验 → P4 安装 → P5 PATH/结果。

## 5. 行为

仅 fork 程序源；版本 pin 与 channel 一致；build 复用脚本和固定 dev channel，强制关闭 release 上传；不改变本地 checkout 分支/内容（依赖和构建产物除外）。空 XDG_CONFIG_HOME 与未设置一致；发现旧式 TOML config 时提示迁移并拒绝安装，以免启动时覆盖开关。

## 6. 状态

准备失败旧安装不变；普通安装异常回滚，强杀与并行安装不保证事务。PATH 失败明确警告。

## 7. 不变量/PBT

数字版本最大值与通道隔离；配置非目标字段保留、目标默认策略及幂等。

## 8. 性能

归档下载与复制用分块流；不把大二进制整体读入内存；无固定网络耗时承诺。

## 9. 副作用

不改 runtime、SDK、上游 install；不改实际用户配置来测试；不输出凭据；校验后才安装。

## 10. 跨平台

发布五平台精确资产名；Windows zip 与 Unix tar.gz 均测试。原生构建/真实终端 PATH 的平台覆盖需如实报告。
