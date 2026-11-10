# 安装器审核报告

日期：2026-11-03。结论：通过，无未解决的阻断发现。

## 契约对照

独立审核者先抽预期，再看新增文件 diff；另一个审核者阅读完整运行调用链、测试及现有配置/构建代码。

| 预期                                    | 结果                                         |
| --------------------------------------- | -------------------------------------------- |
| 默认正式发布、可选 beta/pin、源码 build | 通过；冲突参数拒绝                           |
| 仅 fork 程序发布/源码，下载校验         | 通过；精确成员提取，拒绝链接及重复目标       |
| 所有模式关闭官方更新和两个 provider     | 通过；共同收尾，保留原有效禁用列表           |
| 其他配置保留、JSONC、权限和 symlink     | 通过；两个被替换值内部注释的范围见 decisions |
| 固定 dev 数据 channel、真实源码版本     | 通过；源码安装强制关闭 release 上传          |
| 失败不破坏旧安装、普通错误回滚          | 通过；强杀/并行限制已写明                    |
| PATH 用户范围、可禁用、失败警告         | 通过；非 UTF-8 Unix profile 原字节保留       |
| runtime/SDK/上游 install 零修改         | 通过                                         |

## 发现及关闭

1. Python 非 JSON 常量被放行：改为严格拒绝，回归覆盖 NaN/Infinity。
2. 非 UTF-8 shell profile 在安装后误报失败：改为字节追加，回归执行真实 bash 检查引用及幂等。
3. 构建继承 OPENCODE_RELEASE 可能上传：显式设空，污染环境回归；真实 Bun 检查 .env 无法重新激活该空值。
4. 空 XDG_CONFIG_HOME 与运行时不一致：回退到用户目录，覆盖参数及 fish。
5. 旧 TOML 在运行时覆盖关闭开关：安装前拒绝并要求迁移，旧文件不改。

## 验证

- 从 packages/opencode 执行 `bun test test/installation/fork-install.test.ts test/installation/installation.test.ts`：14 pass，0 fail。
- Python 边界 suite：15 个用例通过，由 Bun 测试调用，纳入现有 CI 发现路径。
- FastCheck：两类性质各 40 轮，每轮生成至多 10 个案例；配置非目标值保留/幂等、版本数字排序/通道隔离。输出同时由独立的 jsonc-parser 解析校验。
- 从 packages/opencode 执行 `bun typecheck`：通过。文档及 TS 格式检查、diff whitespace 检查通过。
- Linux x64 三条真实隔离安装通过：正式 `1.18.31-fmv2.1`、beta `1.18.31-fmv3-beta.18`、临时 clone dev 后完整依赖安装/编译的 `0.0.0-source.gd878c4e2e9f9`。三份配置均确认 autoupdate=false，禁用两个官方 provider。
- 未触碰真实用户安装、配置或 shell profile。Windows/macOS 的原生安装未实跑；zip/tar、参数与路径逻辑已测，Windows 广播经 API 签名核对。

不宣称已完成远端 CI 或跨平台实机验收。
