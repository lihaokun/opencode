# 开发日志 — 共享机测试环境隔离（11 项基线失败归零）

日期：2026-10-13
分支：`issue-46-runtime-alignment`
提交：`50cc7298`
关联：P0-2/P1 devlog 中的基线归因记录、CLAUDE.md `*_BASE_URL` 已知限制条目

## 做了什么

归因并修复全套测试的 11 项基线既有失败（与产品代码无关，均为共享开发机环境输入）：

| 簇 | 数量 | 根因 | 修法 |
|---|---|---|---|
| cf-ai-gateway | 4 | `ANTHROPIC_BASE_URL=open.bigmodel.cn`（GLM 端点）被 `createAnthropic` 继承，gateway host 正则只认 api.anthropic.com（probe 实证拦截 URL 即 bigmodel） | 测试内固定 baseURL（与 gateway 表定义的 host 一致）+ preload 清理 `*_BASE_URL` |
| HttpApi SDK / session-messages | 4+1 | `http(s)_proxy=127.0.0.1:20172` 拦截 localhost server 流量 | preload 删除代理变量 + **设 `no_proxy="*"`**（仅删除不够，见教训） |
| oauth-callback | 1 | 固定回调端口 18000 被共享机上**其他用户的 opencode 实例**占用（ss 实证，10-08 起常驻） | 测试改用既有 `getFreeLoopbackPort()` 分配空闲端口 |
| tool.write 权限 | 1 | umask=002 → 0o664 vs 硬编码期望 0o644 | 期望动态化：`0o666 & ~process.umask()` |
| Server.listen PTY websocket | 1 | Bun **进程启动时**读取代理配置，preload（启动后）清理对 WebSocket 路径无效 → ws 升级走代理卡死（进程级 `env -u` 后 11/11 过，实证） | 代理环境下精确 skip 该条（环境冲突声明），in-process 变体不受影响 |

## 验证

- 四文件 52/52；**全套 3983 项 0 失败**（本机首次归零）；修复过程中每个根因都有剥离/对照实验支撑（env -u、probe、stash 基线）。

## 关键决策与理由

- **测试目标保真审查**：每项修法先对照测试的文档化意图——cf-gateway 的 host 表证明了 api.anthropic.com 是文档化输入（固定=fixture 精确化）；write 的动态期望双向保留检测力（回归 0o666/漂移 0o600 仍然红）；oauth 用空闲端口完整保留"自定义端口+路径"目标。
- **全局 preload 而非单文件**：代理对一切"本地 server + 请求"的测试都是风险，且经 grep 证实无测试消费代理变量。
- **CLAUDEX_BASE_URL / no_proxy 的 CIDR 段**（`100.64.0.0/10`）疑似导致 Bun 解析整表失效——机制未深挖，`no_proxy="*"` 实证有效。

## 度量

| 指标           | 数值                                        |
| -------------- | ------------------------------------------- |
| 新增代码行数   | ~56（全部测试隔离/断言）                    |
| 修改代码行数   | ~6                                          |
| 删除代码行数   | 6                                           |
| 涉及文件数     | 6 + 1（本日志）+ CLAUDE.md 回写             |
| 新增测试用例数 | 0（隔离既有用例，未新增覆盖面）             |
| 测试通过率     | **3983/3983（本机首次全绿）**               |
| 发现 bug 数    | 11（环境性，非产品缺陷）+ 1 个产品侧观察（`isPortInUse→return` 静默假定占用者是自己） |
| 修复 bug 数    | 0 产品 / 11 测试健壮性                      |
| 迭代轮次       | 2 轮（preload 删除版对 WS 无效 → 补 no_proxy 通配） |

## 经验教训

- **Bun 在进程启动时捕获代理配置**：`preload`/运行时的 `delete process.env` 对已启动进程的 fetch（`no_proxy="*"` 可救）和 WebSocket（无法救）时序不够——需要进程级干净 env 的测试只能靠启动前清理。本条已回写 CLAUDE.md。
- **共享机 = 移动靶**：固定端口（oauth 18000）、共享代理、umask 都随其他用户的工作负载变化；测试对这类环境的正确姿势是**自备资源**（空闲端口）+ **显式 fixture**（baseURL/umask）+ **环境冲突时带因 skip**（而非硬红）。
- **`isPortInUse→return` 的语义盲区**（产品观察，未修）：`ensureRunning` 把"端口被占"静默当作"我们的服务已在跑"——占用者是第三方进程时用户的 OAuth 回调会永远收不到。属 MCP OAuth 域，立项时并入。

## 待办

- 提示词统一的行为抽查（需真模型）；
- V2 摘要丢 `state.structured` 立项核实；
- cf-gateway "gateway + 自定义 BASE_URL" 组合行为是否需要在 provider.ts 层显式定义（记录待议）。
