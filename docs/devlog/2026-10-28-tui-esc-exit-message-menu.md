# 开发日志 — TUI 三合一修复：esc 级联 / ctrl+c 双击退出 / 消息菜单（#87、#69）

> 日期：2026-10-28。分支 `fix/tui-interrupt-exit-and-message-menu`，四个 commit（三份修正方案文档 + 三个修复各一个）。
> 修正方案：`docs/fixes/session-fix-abort-cascade.md`、`docs/fixes/tui-fix-exit-confirm.md`、`docs/fixes/tui-fix-message-menu.md`（第六/七/八部分均已回填）。

## 做了什么

### 1. `session.abort` 不再级联取消子 agent（#87 第 1 点，commit 7d8bfb06cd）

- 根因：`SessionRunState.cancel` 无条件执行 `cancelBackgroundJobs`，其 transitive `parentSessionId` 扫描把整棵子树的 running job 取消；esc → `session.abort` 复用了这条 teardown 路径。
- 修复：`cancel` 加 `options?: { cascade?: boolean }`（**默认 true**，teardown 语义不变）；HTTP abort handler 单点传 `{ cascade: false }`。`agent_stop`、`Session.remove`、workspace warp 三个调用方不动。

### 2. ctrl+c 双击确认退出（#87 第 2 点，commit 316624afb5）

- 根因：`app.exit` 命令单步实现（run 即 `exit()`），空输入时一次按键即销毁 renderer。
- 修复：抽出 `util/confirm-exit.ts` 纯函数状态机（注入时钟、5 秒窗口、阈值 2，形状与 `session.interrupt` 双击一致）；首按 toast `Press ctrl+c again to exit`，窗口内二按才退出。ctrl+d、`<leader>q`、`/exit` 共享同一 run，keybind 定义零改动。

### 3. 消息菜单：左键不弹、右键开菜单、Revert 加确认（#69，commit 56b4866e3b）

- 根因两层：`onMouseUp` 不区分鼠标键；菜单把破坏性的 Revert 排首位且无确认。
- 修复：`messageMouseAction` 纯函数决策器（左键 none / 右键有选中 copy / 右键无选中 menu）；菜单重排 Copy→Fork→Revert；Revert 经 `DialogConfirm`，文案含消息数（单复数）、`<leader>r`/`/redo` 恢复提示、超 7 天 snapshot 警告（口径引用 `Snapshot.prune = "7.days"`）。时间线（`<leader>g`）复用同一组件自动生效。

## 关键决策

- **cascade 默认 true 而非默认 false**：改动面最小——只有 abort 一个调用方需要新语义；反过来要让 `agent_stop`/warp 两处显式开启，且"默认停掉自己子孙"对删除类入口是更安全的缺省。
- **确认窗口取 5 秒**：与 esc interrupt 既有双击窗口一致，不引入第二个时序常量。
- **confirmExit 抽纯函数**：双击时序逻辑无法用渲染测试稳定断言边界（恰在 4999ms/5000ms），注入时钟后纯函数层可精确测试。

## 端到端验证（tmux + 真实模型）

启动：`bun --preload <…>/@opentui/solid/scripts/preload.js packages/opencode/src/index.ts`（从目标项目目录跑；`--preload` 必须显式传，因为主进程会加载 `@opencode-ai/tui/config` 的 `.tsx`，而 bunfig 的 preload 只在包目录内生效）。

- **esc 级联**：主 agent 跑长任务 + 子 agent `sleep 120`，双击 esc → 主 turn interrupted，子 agent 跑满 120 秒后结果照常回填父会话并被主 agent 消费（parent wake 通道一并验证）。
- **ctrl+c**：单按 toast 存活、过窗重 arm、双按退出，三时序均符合。
- **消息菜单**：时间线入口 → 菜单 Copy/Fork/Revert 默认 Copy；Revert 弹 Confirm（单数文案 + `<leader>r` 提示）；Cancel 分支 DB 消息数不变；Confirm 分支 DB `revert=1`，TUI 显示 "1 message reverted / ctrl+x r or /redo to restore"；左键单击消息无菜单。

**未端测到**：真实右键点击（pty 注入 SGR press/release 无法触发 opentui 的 `onMouseUp`，注入路径只对滚轮有效）；7 天 stale 警告文案（端测会话无旧消息）。两者分别由渲染测试与纯函数测试覆盖，建议合并后手测一次真实右键。

## 踩坑与经验

1. **lifecycle 测试 fixture 的隐性覆盖缺口**：把 `app.exit` 改成双击后，app 在两次按键之间存活，session 路由的 `session.get` 第一次真正打到 mock fetch——不认识 `/session/dummy`，报错 → navigate home → Session 卸载 → epilogue 被 `onCleanup` 清掉。表象是"epilogue 断言失败"，根因是 fixture 缺端点。修 fixture 不修产品。（已回填 fix 文档实施记录）
2. **渲染测试 stub SDK 的正确姿势**：`SDKProvider` 不传 `fetch` 会用全局 fetch 发真实请求，floating promise 静默失败——stub 必须经 `fetch` prop 注入，让组件走真实 hey-api client 路径，断言才落在真实调用链上。
3. **keymap 同键双发**：dialog.replace 发生在命令处理中间时，同一按键事件可能同时命中替换前后的两层 binding（渲染测试里表现为"确认框闪现即完成"）。分步操作（键间隔 >100ms）下行为正确；不是本次改动引入，但写同类"菜单项 → replace 确认框"交互时要把这个时序考虑进去。
4. **共享机 tmux 纪律**：只用自己创建的会话、`kill-session` 而非 `kill-server`（`kill-server` 会杀掉机器上所有人）。
5. **验证"没发生"要查持久层**：端测 Cancel 分支时 TUI 界面无变化不能证明没 revert（revert 请求可能已发但被 UI 吞掉）；直接查 SQLite（`session.revert` 字段 / message 计数）才是硬证据。

## 度量

| 指标           | 数值                   |
| -------------- | ---------------------- |
| 新增代码行数   | 945（含文档 350；产品源码约 190，测试约 400） |
| 修改代码行数   | 54 删除 / 复用行内改动 |
| 删除代码行数   | 54                     |
| 涉及文件数     | 16                     |
| 新增测试用例数 | 18（confirm-exit 5 + cascade 2 + message-mouse 8 + dialog-message 渲染 5，另有 app-lifecycle 改造 1） |
| 测试通过率     | tui 271/271；opencode prompt.test 新增用例全绿（全量文件存在与本改动无关的既有 flake，见下） |
| 发现 bug 数    | 2（fixture 缺端点、SDKProvider fetch 缺省发真实请求）——均为测试基建问题，非产品缺陷 |
| 修复 bug 数    | 2                      |
| 迭代轮次       | 设计 1 轮（文档评审通过）；实现 3 轮（每修复一轮）；#69 渲染测试调试 2 轮 |

> flake 说明：`packages/opencode/test/session/prompt.test.ts` 全量跑在本机偶发 5s 超时（三轮分别 7/6/2 个），失败集合在干净 dev 基线（独立 worktree）同样出现且两轮间不重叠；所有失败用例在分支上隔离单测连跑 5 次全绿。判定为共享机负载型既有 flake，与本分支改动无关，未在本分支内修。
