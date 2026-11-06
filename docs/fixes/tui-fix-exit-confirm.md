# 修正方案 — tui：ctrl+c 单击直接退出 TUI（无双击确认）

> 对应 issue #87 第 2 点（lihaokun/opencode）。按 workflow §7.1 八部分组织。

## 第一部分：现象与复现

### 现象

TUI 输入框为空（含提示词已发出、agent 正在跑的典型场景）时按一次 ctrl+c，整个 TUI 立即退出，正在运行的 agent 与后台 job 随进程终止。其他 CLI 的 ctrl+c 肌肉记忆是"打断/逐级退出"，这里直接以最大代价生效，且无任何确认。

### 最小复现用例

1. 启动 TUI，进入会话，输入框留空
2. 按一次 ctrl+c

预期：不退出；出现 `ctrl+c again to exit` 类提示；窗口内再按一次才退出。
实际（修复前）：`destroyRenderer` 立即执行，进程退出。

### 出错代码路径

- `packages/tui/src/config/keybind.ts:48` — `app_exit: keybind("ctrl+c,ctrl+d,<leader>q", ...)` → `app.exit`
- `packages/tui/src/app.tsx:977-985` — base mode 注册 `app.exit` 绑定，唯一门控是"输入框聚焦且非空时不生效"（空输入即放行）
- `packages/tui/src/app.tsx:830-836` — `app.exit` run 直接 `exit()` → `app.tsx:247-252` `destroyRenderer`

### 预期行为 vs 实际行为

- 预期：退出是显式二次确认动作；首次按键给出提示，时间窗口内再按才退
- 实际：单击即全量退出

## 第二部分：根因分析

**症状**：一次 ctrl+c 退出。

**根因**：`app.exit` 命令的实现是单步的（run 即 exit），没有确认层。这不是 keybind 绑定错误（`ctrl+c` 出现在 `app_exit` 是有意设计），而是**命令语义缺少两段式门控**。

仓库内已有同型范式：`session.interrupt` 用 `store.interrupt` 计数器 + 5 秒重置实现双击（`packages/tui/src/component/prompt/index.tsx:438-449`），footer 同步提示 `esc again to interrupt`（LL1657-1662）。`app.exit` 缺的是同一层；对照之下属于遗漏而非设计选择（issue #87 第 2 点已与维护者对齐为双击方案）。

**非根因**：`exitOnCtrlC: false`（`app.tsx:188` 附近 renderer 配置）已禁用底层 SIGINT 直退，说明退出完全由 keymap 命令驱动——在命令层加门控即可，无需动终端层。

## 第三部分：参考实现对照

`session.interrupt` 双击（`prompt/index.tsx:438-449`）：

```
count = count + 1
setTimeout(() => count = 0, 5000)
if (count >= 2) { 执行中断; count = 0 }
```

`app.exit` 修复采用同一形状：计数器 + 窗口重置 + 阈值执行。差异点只在触发体（interrupt 是 abort，exit 是 destroyRenderer）与提示位置（interrupt 用 footer 行内文本，exit 用 toast——`app.exit` 注册在 `app.tsx` 全局，不在 prompt 组件作用域内，拿不到 footer 的 store）。

## 第四部分：修复方案

修什么：`packages/tui/src/app.tsx` `app.exit` 命令（LL830-836）。

1. 组件级加 `exitConfirm` 计数器（`createSignal`）+ 5 秒重置 timer，形状照抄 `session.interrupt`；
2. `app.exit` run：首次 → toast 提示 `Press ctrl+c again to exit`（variant info，duration 5000，与 toast 默认一致）；窗口内第二次 → `exit()`；
3. ctrl+d、`<leader>q`、`/exit` slash 命令同样经过该 run，行为一致（都是"退出意图"，都需要第二次确认）。

为什么这样修：根因在命令层语义，最小变更面就是命令层。不动 keybind 定义（用户自定义 `app_exit` 仍生效），不动 renderer/终端层。

修改后的预期行为（复现用例走一遍）：空输入按 ctrl+c → toast `Press ctrl+c again to exit`；5 秒内再按 → 退出（epilogue 通道不变）；5 秒后按 → 重新计次；输入框非空时首次按键仍只清空输入（`input_clear` 分支未动，非空门控照旧）。

### 修订（review 后）：双击门控只挂按键入口，显式命令直接退出

合入前的用户实测发现第四部分原方案的覆盖面过宽：完整输入 `/exit` 是无歧义的显式意图，不存在误触可能，要求二次确认是纯摩擦。修订后的入口划分：

- **按键入口**（`app_exit` keybind：ctrl+c / ctrl+d / `<leader>q`）——误触来源，保留双击门控。实现从"命令 run 内计数"改为 **keymap binding 层内联 `cmd` 处理器**：`tuiConfig.keybinds.gather("app_exit", ["app.exit"])` 的结果逐 binding 覆盖 `cmd`，在处理器内跑 `confirmExit` 状态机。门控因此只对真实按键路径生效。
- **命令入口**（`app.exit` command run：`/exit`、`/quit`、`/q` slash，palette 选择，服务端 `tui.command.execute` 事件转发）——显式意图，run 直接 `exit()`，无门控。

## 第五部分：正确性论证

1. **根因消除**：命令 run 从单步改为两段式，"一次按键 = 一次退出"的映射不复存在；第二次确认才是退出动作的触发者。
2. **不变量保持**：
   - 退出通道本身不变：第二次按键仍走 `exit()` → `ExitProvider` → `destroyRenderer`，epilogue/SIGHUP 等生命周期路径（`app-lifecycle.test.tsx` 既有断言）不受影响——测试里 `dispatchCommand("app.exit")` 需 dispatch 两次才能退出，这是唯一行为变化，对应测试同步更新（第六部分）。
   - keybind 解析层零改动：`Definitions`、`CommandMap`、override schema 均不动，用户配置兼容。
   - 非 5 秒窗口内的连续两次（如快速连按 3 次：第 1 次计 1，第 2 次计 2 退出，第 3 次重新计 1）不会误退——计数器在执行后归零。
3. **无回归引入**：第六部分用例 (a)(b)(c)(d) 锁定：单按不退 + 有提示、双按退、窗口过期重计、非空输入仍清空不退出；`app-lifecycle` 既有用例同步为双 dispatch 后全量复跑。

## 第六部分：测试用例清单（计划）

| 类型 | 用例描述 | 状态（修复后回填） |
|------|---------|------------------|
| 回归 | `test/app-lifecycle.test.tsx` "app.exit prints the session epilogue"：`dispatchCommand("app.exit")` 单次即退出、epilogue 照旧（命令入口无门控） | 已加: test 改动见 commit |
| 新增 | `test/util/confirm-exit.test.ts`：首按 arm 不退；窗口内（boundary-1ms）二按 exit 并重置；恰在 boundary 重计不退；过窗重 arm；退出后陈旧序列不误退 | 已加: 5 用例，confirm-exit.test.ts |
| 新增 | 按键入口双击：真实 ctrl+c 按键第一次只出 toast 不销毁 renderer（`waitForFrame` 断言 "Press ctrl+c again to exit"），窗口内第二次按键退出 | 已加: "a single ctrl+c key press only warns; the second inside the window exits"，经 `mockInput.pressKey` 驱动真实 keymap |
| ~~新增~~ | ~~非 TUI 入口回归：`/exit` slash 与 ctrl+d 同 run 共享计数~~ | 已作废 — 修订后命令入口直接退出、无计数；slash/ctrl+d 分属两个入口，共享计数的语义不再存在（见第四部分修订） |

## 第七部分：代码更新清单（计划）

| 文件 | 函数 / 行号 | 改动概述 | 状态（修复后回填） |
|------|------------|---------|------------------|
| `packages/tui/src/app.tsx` | `app.exit` run | ~~双击计数 + toast 提示 + 窗口重置~~ 修订：直接 `exit()`（显式入口无门控） | 已改: commit 本条 |
| `packages/tui/src/app.tsx` | app_exit binding 层 | 修订新增：`gather("app_exit", ["app.exit"]).map(...)` 内联 `cmd` 处理器跑 `confirmExit` 状态机 + toast | 已改: commit 本条 |
| `packages/tui/src/app.tsx` | App 组件体（LL411-412） | `exitConfirm` signal + onCleanup 重置 | 已改: commit 本条 |
| `packages/tui/src/util/confirm-exit.ts`（新） | `confirmExit` 纯函数 | 双击状态机（注入时钟），供 binding cmd 处理器与单测共用 | 已加: commit 本条 |
| `packages/tui/test/app-lifecycle.test.tsx` | 既有用例 + 新增按键用例 | epilogue 用例改单 dispatch；新增真实 ctrl+c 双击用例；fixture 补 `/session/dummy`、`/part`、`/config/providers`、`/provider` 端点 | 已改: commit 本条 |
| `packages/tui/test/util/confirm-exit.test.ts`（新） | — | 状态机边界用例 | 已加: commit 本条 |

## 第八部分：文档更新清单（计划）

| 文档路径 | 要改什么 | 状态（修复后回填） |
|---------|---------|------------------|
| `docs/devlog/2026-10-28-tui-esc-exit-message-menu.md` | 三合一修复 devlog（含度量段） | 待加（三步全完后统一写） |
| 无契约文档涉及 — keybind 定义、命令名、退出通道均未变更；仅命令内部交互时序变化。`app_exit` 的 description（"Exit the application"）仍准确。 | — | — |

### 实施记录（回填）

- 纯函数抽到 `util/confirm-exit.ts`（注入时钟，5 秒窗口 = `EXIT_CONFIRM_WINDOW_MS`，阈值 2）。
- 实施中发现（测试同步的正当理由）：原回归用例在第一次 dispatch 后即退出，从未驱动过 session 路由的 `session.get`。双击改造让 app 在两次按键之间继续存活，暴露了 fixture 缺口——mock fetch 不认识 `GET /session/dummy`，session 路由报 "Session not found" → `navigate home` → Session 卸载 → epilogue 被 `onCleanup` 清掉。这是**测试夹具缺口**（用例未覆盖 app 存活期的真实请求），非产品代码缺陷；修法是在 fixture override 补 `/session/dummy` 与 `/part` 两个端点，产品代码零改动。符合 §5.4「测试用例编写错误 — 修正用例」路径。

### 实施记录（修订轮：门控移到 binding 层）

- **keymap binding 内联 `cmd` 的可行性**：`@opentui/keymap` 的 `Binding.cmd` 字段原生接受 `CommandHandler` 函数（`resolveBindingItem` 会把纯字符串 key 规格化为 `{key, cmd: command}`，对象形式则保留自定义 `cmd`），`compileBindings` 对函数型 `cmd` 走 `binding.run` 快路径，不会去命令目录解析。`gather()` 返回的是已解析的 binding 数组，`.map()` 覆盖 `cmd` 后经 `useBindings` 注册，用户 keybind override（换键、改序列）照常生效——门控跟的是"这个 binding 被按键触发"这一事件本身。
- **按键级测试的夹具坑（已修）**：新用例用 `mockInput.pressKey("c", { ctrl: true })` 驱动真实按键。首版 fixture 里 `/config/providers` 返回空 provider 集，app 在 sync complete 后自动弹出 connect-provider 对话框（`app.tsx` `sync.data.provider.length === 0` effect），对话框把 keymap 推入 `modal` 模式；`app_exit` binding 是 base 模式，从此不匹配任何按键——两次 ctrl+c 都被对话框吞掉，表现为测试超时 + "keymap dispatch 不达"。修法：fixture 补一个已配置 provider（`/config/providers`、`/provider` 两端点），让 app 停留在 base 模式。这是夹具与真实启动语义的偏差，非产品缺陷。
- **二次按键前等待 toast**：按键断言用 `waitForFrame(frame => frame.includes("Press ctrl+c again to exit"))` 替代固定 `renderOnce()`，既验证了首次按键的可见效果（提示真的渲染出来），又保证第二次按键落在 keymap 状态稳定之后。
- **toast 按键名（自审轮补充）**：`app_exit` 绑定 ctrl+c / ctrl+d / `<leader>q` 三个键，硬编码 "Press ctrl+c again" 会在用户按 ctrl+d 或 `<leader>q` 时指错键。binding `cmd` 处理器的 `CommandContext.event` 携带实际按键，经 `stringifyKeyStroke(ctx.event)`（`@opentui/keymap` 公开 API，KeyEvent 结构满足 `KeyStrokeInput`）格式化——toast 始终点名用户真正按下的键。测试相应改用 ctrl+d 驱动并断言 "Press ctrl+d again"、排除 "Press ctrl+c again"，锁住按键名跟随行为。
- 回归验证：`packages/tui` 全量 281 tests（53 files）0 fail；typecheck 通过。
