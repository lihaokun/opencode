# 开发日志：阶段 2c — 删除 core V2 运行时与 V2 工具集（2026-10-24）

## 背景

`/api` rail 摘除（阶段 2a/2-C，`4e2f43e0a8` + `b4a9f17444`）后，V2 session runner 及其配套 location 服务失去全部生产消费者。本阶段（commit `2d2484e417`）把这些模块从 core 包整体移除。

## 关键决策

### 1. 消费者反查定边界，而非按目录名删

删除前对每个候选模块逐一核实消费者全集：

- `core/tool/`（18 文件）：唯一外部消费者是 `location-services.ts` 的三个条目（`ToolRegistry`/`BuiltInTools`/`ReadToolFileSystem`）。V1 工具集在 `packages/opencode/src/tool/` 完全独立。
- `session/runner/`：消费者仅剩 barrel（`resume` 签名）、`execution/local.ts`、location-services 两个条目，以及 V1 `prompt.ts` 只 import 的 `MAX_STEPS_PROMPT` 常量。
- `context-epoch`/`execution`/`run-coordinator`/`store.runnerContext`/`history.loadForRunner`：全仓零生产消费者。
- `QuestionV2`/`SessionTodo`（core 版）/`Snapshot`（core 版）/`Image`（core 版）/`FileMutation`/`LocationMutation`/`SkillGuidance`/`ReferenceGuidance`/`system-context`/`instruction-context`/`tool-output-store`：删完 runner 与工具后全部成为孤儿。

### 2. 保留件与裁剪件

- **barrel 瘦身**：`core/src/session.ts` 从 486 行（完整 Service 实现）缩到纯 schema 面（ID/Info/NotFoundError/error re-export）。PermissionV2、MoveSession、control-plane 错误映射、opencode `session/schema.ts` 继续消费。
- **SessionStore 保留**（permission + move-session 承重），裁掉 runner 专属的 `runnerContext`。
- **SessionHistory.load 保留 epoch baseline 查询**：老版本构建 move 过的 session 可能有 `session_context_epoch` 行，load 需要按 baseline 过滤 system 消息——表 DDL 与读取逻辑都保留，只有写入方（runner）消失。
- **location-services 保留 V1 承重条目**（FileSystem/Watcher/Plugin/Reference/Permission/Catalog 等——V1 `agent.ts`/`system.ts` 经 LayerMap 拉取），摘除 runner/tool/snapshot/todo 等 12 条。
- **`MAX_STEPS_PROMPT` 移至 `core/src/session/max-steps.ts`**，V1 prompt loop 的 import 路径同步更新。
- **migration journal 不动**：表 DDL（含 `session_context_epoch`）与 `config/tool-output` schema 全部保留。

### 3. 测试 oracle 重写

opencode `session/compaction.test.ts` 与 `session/prompt.test.ts` 原先 boot 整个 V2 barrel 用 `session.messages()` 当持久化 oracle。barrel 删除后改为直接读 `SessionMessageTable` + `Schema.decodeUnknownEffect(SessionMessage.Message)` 解码——oracle 语义不变（仍是投影落库内容），但不再依赖被删服务。

### 4. Effect v4 API 踩坑

`Schema.decodeUnknown` 在 Effect v4 beta 不存在（只有 `decodeUnknownEffect`/`decodeUnknownSync`/`decodeUnknownExit`）——测试重写时先写错了，typecheck 抓到后改用 `decodeUnknownEffect`。

## 验证

- 全仓 typecheck 25/25
- core 套件 698 pass / 0 fail
- opencode session 套件 606 pass / 0 fail
- opencode server 套件失败集 = dev 基线（HttpApi SDK ×4 存量；provider OAuth 仅并行负载下超时、隔离运行通过）
- TUI 247 pass / 0 fail
- exerciser 三模式（coverage/auth/effect）各 146/146——V1 openapi 面无变化，SDK 无需重新生成（2-C 已完成瘦身）

## 度量

| 指标           | 数值                          |
| -------------- | ----------------------------- |
| 新增代码行数   | ~50（max-steps 移动 + barrel 面） |
| 修改代码行数   | ~90（oracle 重写 + import 路径）  |
| 删除代码行数   | 11,254                        |
| 涉及文件数     | 75                            |
| 新增测试用例数 | 0（oracle 等价重写）          |
| 测试通过率     | core 698/698；session 606/606；TUI 247/247 |
| 发现 bug 数    | 0                             |
| 修复 bug 数    | 0                             |
| 迭代轮次       | 实现 1 轮（typecheck 3 次小迭代） |

## 累计（分支 vs dev）

238 files，+3,793 / −43,340。
