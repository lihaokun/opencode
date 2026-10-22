# Issue #78 调研：配合集成 FSM Bash Runtime（updated_input 命令改写与宿主回归）

> 关联：[lihaokun/opencode#78](https://github.com/lihaokun/opencode/issues/78)、
> FSM 侧 draft PR [lihaokun/mcp-server-fsm#213](https://github.com/lihaokun/mcp-server-fsm/pull/213)
>
> 调研基线：`dev` @ `d9d7de31fb`（2026-10-21）。文中所有行号引用以该 commit 为准。

## 1. 结论速览

| 事项 | 结论 |
|------|------|
| 请求性质 | **跨仓库集成协作请求**，不是 OC 核心缺陷报告 |
| 宿主接缝（before-hook → live args → 执行器） | **已存在**，发布版 `v1.18.31-fmv2.1` 与当前 `dev` 行为一致 |
| 核心代码 diff | **0**（现状已满足，不需要为协作改 OC 核心） |
| 仓库内是否有内置 FSM/hook adapter | **无**（全仓库无 `updated_input` 消费点，符合对方"复用 FSM 侧插件适配"的预期） |
| 缺口 | 仅两项：宿主回归测试（对方清单第 3 项）、issue 下版本确认回复（第 1/4 项） |
| 接缝覆盖范围 | **仅默认 runtime**（`SessionPrompt` 循环，CLI/TUI/server 主路径）。core V2 runner 无 plugin hook，见 §8 |

## 2. 请求背景：FSM 侧要做什么

FSM（有限状态机工作流产品）在 draft PR #213 中接入 Anthropic 官方沙盒库
[`@anthropic-ai/sandbox-runtime`](https://github.com/anthropics/sandbox-runtime)（下称 SRT）：

- 模型发出原生 Bash 命令 `E`，FSM 先做既有 white/black 授权判断；
- 允许后，若 FSM 当前 state 配置了 `tool_permissions.bash_runtime`（一个 SRT profile 绝对路径），
  把返回给宿主的命令从 `E` 改写为 `srt --settings <profile> -c '<shell_quote(E)>'`；
- 宿主实际执行的是改写后的命令，SRT 负责在命令及其子进程访问文件系统/网络时落实限制；
- 未配置 `bash_runtime` 的状态、非 Bash 工具不做改写。

改写的传达通道：FSM hook 在 `tool.execute.before` 里读取自身返回的 `updated_input`，
插件原地更新 live `args.command`。**这要求宿主满足一个前提契约**：

> `tool.execute.before` 必须先于工具执行被 await，且执行器消费的是 hook 返回后的**同一个 live args 引用**——
> 不能在 hook 前缓存 command，也不能在 hook 后把旧 command 覆盖回去。

对方明确声明："这是一项集成协作请求，不是已证明的 OC 核心缺陷；当前已测版本已有所需 hook，
不要求凭空新增 hook 或重做 SRT 业务。"

## 3. 对方提出的四项最小事项（issue 原文归纳）

1. **确认发布/安装链使用的 FSM 集成版本**：对方已测 HaokunCode `1.18.31-fmv2.1`
   （参考源码 commit `e81af70d789a33d67a25e158604e9bd6c9325bfd`）；若有自维护的内置 hook adapter，
   须同步消费 `updated_input`，并优先复用 FSM 侧适配，不把 profile/quoting/依赖判断复制进 OC 核心。
2. **保留 before hook 的 await 顺序与 live args 传递**：现状已满足时，核心 diff 应为零。
3. **补充宿主回归测试**：同一原生 Bash 调用经 before hook 改写后实际执行新命令、除 command 外参数不变；
   非 Bash 不改写；hook 拒绝/非法更新不裸执行。真实模型不是前提，LLM-Mock 即可。
4. **在 issue 下确认集成版本/提交**，或指出唯一确实缺失的宿主接缝；若无需改动，直接确认。

## 4. 接缝核实（当前 `dev` HEAD `d9d7de31fb`）

### 4.1 主接缝：`SessionTools.resolve` 的 before-hook → live args 链

`packages/opencode/src/session/tools.ts:105-136`——每个注册工具的 AI SDK `execute` 包装：

```ts
execute(args, options) {
  return run.promise(
    Effect.gen(function* () {
      const ctx = context(args, options)
      yield* plugin.trigger(            // tools.ts:109 — 先 await 全部 before hook
        "tool.execute.before",
        { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID },
        { args },
      )
      const result = yield* item.execute(args, ctx)   // tools.ts:114 — 同一个 live args 引用
      ...
```

关键点：

- `plugin.trigger` 逐个 **await** hook（见 §4.2），hook 抛错 → Effect 失败 → `item.execute` 不执行 →
  拒绝语义天然成立，不会回退执行裸命令。
- `{ args }` 中的 `args` 是 AI SDK 传入的同一对象引用；FSM 插件原地修改 `args.command` 后，
  `tools.ts:114` 的 `item.execute(args, ctx)` 拿到的就是改写后的值。
- `tool.execute.after`（`tools.ts:124-128`）拿到的也是同一引用，after hook 可观察到改写后命令。

### 4.2 hook 执行顺序保证

`packages/opencode/src/plugin/index.ts:284-297`：

```ts
const trigger = Effect.fn("Plugin.trigger")(function* (name, input, output) {
  if (!name) return output
  const s = yield* InstanceState.get(state)
  for (const hook of s.hooks) {
    const fn = hook[name] as any
    if (!fn) continue
    yield* Effect.promise(async () => fn(input, output))   // 逐个顺序 await
  }
  return output
})
```

for-of + `yield*`，严格顺序 await；hook 类型见 `packages/plugin/src/index.ts:266-269`
（`"tool.execute.before"?: (input: { tool; sessionID; callID }, output: { args: any }) => Promise<void>`）。
没有并行触发，没有对 output 的快照拷贝。

### 4.3 改写先于 schema 解码 → 非法 command 不会裸执行

`packages/opencode/src/tool/tool.ts:112-123`——`Tool.define` 包装的执行入口：

```ts
const decoded = yield* decode(args).pipe(...)   // 在 item.execute 内部
const result = yield* execute(decoded, ctx)
```

解码发生在 **hook 改写之后**。若 hook 把 `command` 改成非 string，
`decode` 失败 → `InvalidArgumentsError`，工具体不执行。这自动满足对方
"非法更新不得退回执行裸命令"的要求，无需宿主额外防御。

### 4.4 发布版无漂移

- `e81af70d78` = tag `v1.18.31-fmv2.1`（origin/main HEAD，"chore: promote dev to main as v1.18.31-fmv2.1 #64"）。
- `git diff d9d7de31fb e81af70d78 -- packages/opencode/src/session/tools.ts` 为空——
  主接缝在发布版与当前 dev 之间**零差异**。
- 其余 before-hook 触发点（MCP 资源工具 `tools.ts:178/262/342`、MCP 数据工具 `tools.ts:406`、
  agent 工具 `packages/opencode/src/session/prompt.ts:382`、code-mode 子工具
  `packages/opencode/src/tool/code-mode.ts:142`）走同一 live-args 模式，两版一致。

### 4.5 仓库内无内置 FSM / updated_input adapter

`grep -rn "updated_input\|updatedInput" packages/opencode/src packages/core/src` 无命中
（CC 侧走公开 `PreToolUse.updatedInput`，本仓库与之无对应物）。当前发布链的 FSM 集成
完全依赖外部插件（FSM 侧 `opencode-plugin/`），无需要同步消费 `updated_input` 的内置 adapter。

### 4.6 bash 工具身份

`packages/opencode/src/tool/shell/id.ts:16`：`export const ToolID = "bash"`
（注释明确：为兼容性保留 `bash` 作为工具 ID 与 permission key）。FSM 侧"仅原生 Bash 改写"
按 `input.tool === "bash"` 匹配即可。

## 5. 与 §4.1 接缝相关的时序细节（回归测试须覆盖）

CLAUDE.md「已知限制」中两条与本接缝直接相关，写回归时须遵守：

1. **metadata 回调可先于 normalized event 把 pending part 改成 running**
   （`processor.ts:468` 的 firstDelivery 判断）——回归断言不要用 tool part 的
   pending/running 状态推断 hook 是否已执行/改写是否生效；直接断言执行器收到的 args。
2. **异步 helper 的 record 快照**——hook 对 `args.command` 的改写发生在
   `run.promise` 桥接的 Effect 内；断言点位应在 `execute` 真正被调用之后，
   不能依赖 hook 返回与执行之间的隐式同步。

## 6. 待办（建议执行顺序）

### 6.1 宿主回归测试（对方清单第 3 项）

载体：扩展 `packages/opencode/test/session/tools.test.ts` 的现有 harness
（`fakePlugin` 已可编程化：把 `trigger: (_name, _input, output) => Effect.succeed(output)`
替换为按 `tool` 名分派的可控 stub，registry 已有可编程 fake）。用例清单：

| # | 用例 | 断言 |
|---|------|------|
| R1 | before-hook 原地改写 `args.command` | 工具 execute 收到改写后命令；其他参数（如 workdir/timeout 形状的任意字段）逐字段不变；after-hook 观察到的也是改写后值 |
| R2 | hook 抛错（拒绝语义） | `execute` 未被调用；错误向调用方传播；不执行原命令 |
| R3 | hook 把 command 改成非 string（非法更新） | 不回退执行原命令；走 `InvalidArgumentsError`（§4.3 路径） |
| R4 | host 不做工具过滤 | 改写对任意工具 ID 生效（host 一视同仁；白名单是插件侧约定）——用一个非 bash 假工具验证同一 live-args 语义 |
| R5 | 顺序 await | 两个 hook 时第二个 hook 观察到第一个 hook 的改写（防未来并行化回归） |

> R1 的最小形态可直接在 `tools.test.ts` 的 timing 假工具上加一个 `command` 字段断言完成；
> 不需要真实 ShellTool 子进程（避免沙盒/平台依赖）。若要全链路（真实 bash 执行改写后命令），
> 参照 `packages/opencode/test/tool/shell.test.ts` 的 harness 单独加一条冒烟即可，属可选项。

### 6.2 issue #78 回复确认（对方清单第 1/4 项）

回复要点：

- 集成版本：`v1.18.31-fmv2.1`（commit `e81af70d789a33d67a25e158604e9bd6c9325bfd`）；
  当前 `dev` HEAD `d9d7de31fb` 主接缝与该版零差异。
- 接缝核实结论：`tools.ts` before-hook 先于执行 await、live args 同引用传递（`tools.ts:109-114`）、
  hook 顺序 await（`plugin/index.ts:291-295`）、改写后统一走 schema decode，非法更新不裸执行。
- 无内置 hook adapter，发布链按 FSM 侧插件适配消费 `updated_input`，核心 diff 为零。
- 宿主回归落在哪个 commit（6.1 完成后回填）。
- **范围披露**：hook 接缝在默认 runtime（CLI/TUI/opencode server）生效；`opencode serve` 的
  core V2 路由当前不执行 before-hook（详见 §8），FSM 在该使用形态下改写不生效。

### 6.3 收尾文档

- `docs/devlog/2026-10-21-fsm-bash-runtime-host-regression.md`（含度量段）。

## 7. 边界与不做的事

- **不改 OC 核心**：现状已满足契约，任何"顺手"重构（如给 hook 输出加类型化的
  `updated_input` 通道）都是对方明确不要求的额外契约变更，且会与 FSM 侧插件适配形成双源。
- **不在 OC 内复制 profile/quoting/依赖判断**：这些归 FSM 侧（对方 issue 原文明确）。
- **不承诺 CC 侧行为**：CC 走公开 `PreToolUse.updatedInput`，与本仓库无关。
- 本调研不触发 §2.3 子计划判定：无契约变更、无新 user-facing 能力，属测试补充 + 协作确认。

## 8. 接缝覆盖范围（v2 runtime 无 hook，属已知边界）

本仓库存在两套并行 runtime（CLAUDE.md「已知限制」已记录）：

| Runtime | 入口 | before-hook | FSM 改写可用？ |
|---------|------|------------|---------------|
| **默认**（CLI / TUI / opencode 包 server） | `SessionPrompt` 循环 → `SessionTools.resolve`（§4.1） | ✅ `tools.ts:109` | ✅ 可用 |
| **core V2 runner**（`cli serve` / sdk-next embedded server，真实消费者是 `packages/app` web 前端） | `packages/core/src/session/runner/llm.ts` → `packages/core/src/tool/registry.ts` `settle` | ❌ 无（llm.ts 设计清单明确 "Add … plugins …" 为未完成项） | ❌ 不可用 |

核实依据：

- `packages/core/src/session/runner/llm.ts:63-85` 的设计 checklist 中，"Resolve policy-filtered
  built-in, MCP, **plugin**, and structured-output tool definitions" 与 "Add scoped runtime context,
  progress updates, attachment normalization, **plugins**, and cancellation settlement" 两项均为 `[ ]` 未完成。
- `packages/core/src/tool/registry.ts` 的 `materialize`/`settle` 路径无任何 Plugin 依赖
  （`grep -rln Plugin packages/core/src/tool/` 仅命中 AGENTS.md 文档）。

影响评估：

- **对本次协作无阻断**：FSM 侧已测版本 `1.18.31-fmv2.1` 的验证路径就是默认 runtime；
  issue 的四项请求全部落在默认 runtime 语义内。FSM 插件经 `plugin` 配置加载后，
  在 CLI/TUI/默认 server 使用形态下按 §4.1 生效。
- **披露义务**：issue 回复（§6.2）应向 FSM 侧明确——若未来通过 `opencode serve`（V2 路由）
  或 app/web 前端使用 FSM 沙盒改写，该路径当前**不会**执行 before-hook，改写不生效。
  属宿主已知边界，不是本次协作要修的缺陷；若 FSM 场景需要 V2 支持，届时按
  llm.ts checklist 的 plugins 项单独排期。
- **code-mode 边界**：`experimentalCodeMode` 开启时，`tools.ts:411` 提前 return，
  内置 bash 工具不在工具列表中（bash 由 code-mode 子工具链承载，`code-mode.ts:142`
  对子工具仍发 before-hook，但那是 MCP 子工具语义，FSM 的 `bash` 匹配不适用）。
  FSM 场景默认不开 code-mode，无实际影响，记录备查。
