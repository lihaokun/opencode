# 开发日志：CI 回归调查与修复 — external_directory 白名单时序窗口（2026-10-24）

## 现象

阶段 2c（`2d2484e417`）推送后 CI `unit (linux 3/3)` 持续失败，同一断言确定性复现：

```
(fail) project reference directories are allowed for external_directory
Expected: "allow"  Received: "ask"
```

dev 基线同 shard 全绿，因此不是存量失败。

## 调查过程（关键节点）

1. **本地复现**：`bun test --shard=3/3` 完整 shard 下失败；单文件 / 6 文件组合通过。
2. **最小复现**：三文件组合 `test/agent/agent.test.ts + test/tool/write.test.ts + test/server/httpapi-sdk.test.ts` → 约 3/4 概率失败。
3. **排除环境 flake**：dev worktree 同三文件 3 次全过；当前分支 3 次两败。
4. **bisect**：2C commit（`b4a9f17444`）三文件全过 → 回归窗口 = 2c。
5. **条目二分**：在 2C 上手工裁剪 location-services → 复现；逐一恢复实验矩阵（A–N）→ 唯一保住通过性的条目 = `Snapshot.node`。等价空边（同 deps 无副作用）与 `provideMerge(Config.locationLayer)` 边、`PluginInternal.locationLayer`、数组重排均无效。
6. **探针实锤**：失败时 `build.permission` 白名单缺 `/tmp/docs/*` 条目（`cfg.references` 本身正常读到 `{docs: "../docs"}`）——即 `Reference.list()` 返回为空。
7. **机制定位**：`PluginInternal.boot` 是 `forkScoped({startImmediately: true})` 的异步插件注册；`agent.ts` 靠 `PluginV2.wait("core/config-reference")` + `Reference.list()` 取 local reference 目录。该 wait→list 因果链只有在 Snapshot 的 layer build（git repo discover 触发 Git 服务首次真实初始化，实验 R 实锤）消耗掉启动窗口时才隐式成立。2c 删掉 Snapshot 后窗口暴露。

## 修复（`fe74738f09`）

语义修复而非拓扑补丁：**local reference 目录是纯 config 数据**，白名单不应经插件 transform 间接读取。

- `core/config/plugin/reference.ts` 导出纯函数 `localDirs({documents, directory, home})`（复用既有 `local` 判定 + `localPath` 解析）。
- `opencode/src/agent/agent.ts`：白名单的 local 部分直接从 `cfg.references/cfg.reference` 计算；仅 remote（repository）引用——其缓存路径本来就要等 materialize——保留 `wait + Reference.list` 分支（filter `source.type === "git"`）。
- config-reference 插件与 `Reference.list` 本身不动（system.ts prompt 指令注入等其它消费者仍用）。

## 验证

- 三文件最小复现：修复前 ~3/4 失败 → 修复后 3/3 全过
- 完整 shard 3/3：external_directory 从失败列表消失；剩余失败 = dev 基线存量（cf-ai-gateway×4 + HttpApi SDK×4 + tool.write 权限×1）+ LSP interop 一项（shard 并发超时形，隔离运行 58/58 通过）
- 全仓 typecheck 25/25（--force 全新编译）
- agent 套件 49/49、skill+tool 套件 343/344（唯一 fail 为已知存量）

## 经验教训（已同步 CLAUDE.md 候选）

- **LayerNode group 里节点的 layer 副作用可以承载跨服务的初始化时序契约**：Snapshot.node 的 git discovery 恰好是 Git 服务的首次真实调用，其耗时窗口掩盖了"插件注册 fork vs 后续读取"的竞态。删除看似无关的条目可能破坏这种隐式契约——裁剪共享 layer 目录时必须以完整 shard 测试验证，不能只看受影响模块的单测。
- **"等插件再读共享列表"不是因果保证**：`wait(plugin)` 语义上是等 Event.Added，但当消费者拿到的是另一层实例的 Service 或 list 时机与 Added 之间有缝隙时就会漏。需要数据的消费者应直接从数据的源头（config）读。
- **CI 的 sharded 测试是发现这类回归的唯一哨兵**：本地单文件/小组合全绿，完整 shard 才暴露。

## 度量

| 指标           | 数值                       |
| -------------- | -------------------------- |
| 新增代码行数   | +51                        |
| 修改代码行数   | −5（净 +46）               |
| 涉及文件数     | 2                          |
| 新增测试用例数 | 0（复用既有回归测试）      |
| 测试通过率     | 三文件 3/3；shard 回归消除 |
| 发现 bug 数    | 1（2c 引入的时序回归）     |
| 修复 bug 数    | 1                          |
| 迭代轮次       | 调查 6 轮（复现→bisect→条目二分→探针→机制→修复验证） |
