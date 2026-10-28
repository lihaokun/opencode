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
| 回归 | `test/app-lifecycle.test.tsx` "app.exit prints the session epilogue"：连续两次 `dispatchCommand("app.exit")` 后退出、epilogue 照旧（单次 dispatch 不退出） | 待改 |
| 新增 | 纯逻辑：把双击判定抽成可测函数（输入 = (count, now, lastAt) → "count" | "exit" | "reset"），窗口 5 秒、阈值 2 次的边界（1999ms/5001ms 用注入时钟） | 待加 |
| 新增 | 第一次 `app.exit` 只出 toast 不销毁 renderer（`setup.renderer.isDestroyed === false`） | 待加 |
| 新增 | 非 TUI 入口回归：`/exit` slash 与 ctrl+d 同 run 共享计数（第二次任意入口触发退出）——逻辑层断言 | 待加 |

## 第七部分：代码更新清单（计划）

| 文件 | 函数 / 行号 | 改动概述 | 状态（修复后回填） |
|------|------------|---------|------------------|
| `packages/tui/src/app.tsx` | `app.exit` run（LL830-836） | 双击计数 + toast 提示 + 窗口重置 | 待改 |
| `packages/tui/src/app.tsx` | App 组件体（LL384 附近） | `exitConfirm` signal + timer cleanup | 待改 |
| `packages/tui/src/util/confirm-exit.ts`（新） | `confirmExit` 纯函数 | 双击状态机，供命令 run 与单测共用 | 待改 |
| `packages/tui/test/app-lifecycle.test.tsx` | 既有用例 | 双 dispatch 适配 | 待改 |
| `packages/tui/test/util/confirm-exit.test.ts`（新） | — | 第六部分 (b)(c)(d) | 待加 |

## 第八部分：文档更新清单（计划）

| 文档路径 | 要改什么 | 状态（修复后回填） |
|---------|---------|------------------|
| `docs/devlog/2026-10-28-tui-esc-exit-message-menu.md` | 三合一修复 devlog（含度量段） | 待加 |
| 无契约文档涉及 — keybind 定义、命令名、退出通道均未变更；仅命令内部交互时序变化。`app_exit` 的 description（"Exit the application"）仍准确。 | — | — |
