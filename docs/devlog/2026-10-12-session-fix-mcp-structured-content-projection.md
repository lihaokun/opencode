# 开发日志 — P0-2 MCP structuredContent / resource_link / audio 投影修复

日期：2026-10-12
分支：`issue-46-runtime-alignment`
提交：`12bd8a704f`
关联：issue #46、`docs/research/runtime-alignment-research.md` §7 决议 #4-5、`docs/fixes/session-fix-mcp-structured-content-projection.md`

## 做了什么

按已定决议（C① 追加 + 语义判等；C③ 错误路径合并进本 PR）实施 issue #46 的 P0-2：

1. **`tools.ts`**：投影循环提取为纯函数 `projectMcpToolResult`（导出供测试）；新增 `resource_link`（`name: uri`）与 `audio`（占位文本）分支；`structuredContent` 以裸 JSON 追加，语义判等（`=== serialized` 快路径 + `JSON.parse` + `Bun.deepEquals`）防双倍灌入。
2. **`catalog.ts`**：抽导出 `callToolErrorMessage`——错误 message 组装纳入 structuredContent 通道，兜底文案不变。
3. **`code-mode.ts`**：镜像 throw 改调共享函数，消除两处逐字重复的漂移隐患。

## 关键决策与理由

- **判等取语义判等而非严格相等**（用户决策）：严格相等是语义判等的真子集；语义判等额外拦住 pretty-print/键序变体重复，误杀风险为零（深相等即数据相同），代价约 10 行。
- **`=== serialized` 快路径保留**：catalog 空 content 路径（text 项即 sc 紧凑序列化）零解析成本命中，行为字节级不变。
- **提取纯函数是被测试需求驱动的**：投影循环内嵌在 execute 闭包里无法直接测；提取后测试以 `CallToolResult` 形状直驱，无需服务 harness。
- 意外收获：显式类型签名让 typecheck 检出一处既有类型洞——内联代码中 `resource.text`/`resource.blob` 对嵌套联合的属性访问靠推断逃过了检查，提取后以 `"text" in resource` 收窄修复（行为等价）。

## 测试

- 新增 13 个用例：`mcp-projection.test.ts` 9 个（回归/快路径/pretty-print/键序/prose/absent/resource_link/audio）+ `catalog.test.ts` 3 个（callToolErrorMessage）+ `code-mode.test.ts` 1 个（镜像错误端到端）。
- 回归：三文件 53/53；session/mcp/tool 目录 1004 项 → 994 pass + 7 skip + 1 todo + **2 项既有环境敏感失败**（`write.test.ts` 文件权限受 umask 影响、`oauth-callback.test.ts` 端口服务——已用 `git stash` 验证基线同样失败，与本修复无关）；typecheck 干净。

## 待办

- 上述 2 项既有环境敏感失败与本修复无关，但值得单独排查（umask 相关的 write 权限断言在本机环境恒红，可能是测试未设隔离 umask）。
- P0-3（serialize 头尾保留 + metadata 行，复用 P0-1 的 `formatExitCodeLine`）出修正方案文档后实施。

## 度量

| 指标           | 数值                                                     |
| -------------- | -------------------------------------------------------- |
| 新增代码行数   | ~110（catalog 函数 + tools.ts 分支/判等/parsesTo + 测试净增） |
| 修改代码行数   | ~40（tools.ts 内联块替换为调用、code-mode 镜像简化）     |
| 删除代码行数   | 53                                                       |
| 涉及文件数     | 6（3 源 + 3 测试）+ 2（修正方案回填、本日志）            |
| 新增测试用例数 | 13                                                       |
| 测试通过率     | 53/53 新增全过；目录回归 994 pass，2 fail 为基线既有（已验证与本次无关） |
| 发现 bug 数    | 3（产品缺陷 P0-2 本身；1 处既有类型洞被提取暴露；2 项既有环境敏感失败——后两者计入发现不计入本修复） |
| 修复 bug 数    | 1（P0-2）+ 1（类型洞，随提取顺带修复）                   |
| 迭代轮次       | 实现 1 轮（1 次 resource 收窄修正）                      |

## 经验教训

- **内联代码提取为显式签名函数时，typecheck 会暴露推断期隐藏的类型洞**：`resource.text` 对 `{text}|{blob}` 联合的访问在内联处（经 `any` 推断链）不报错，显式 `CallToolResult` 签名后立刻报错。提取重构要预期这类"迟到的正确报错"，并确认修复是收窄（`in` guard）而非放宽类型。
- **"既有失败"必须 stash 基线复跑才能归因**：本轮回归出现 2 个失败，与改动模块无交集，但仍按规范 stash 后复跑确认基线同样失败——不能凭"模块不相干"口头归因（对应 CLAUDE.md 既有条目的实例）。
