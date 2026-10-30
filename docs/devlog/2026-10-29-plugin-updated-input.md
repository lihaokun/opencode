# 2026-10-29 插件 updatedInput 通道（issue #91）

## 做了什么

给 `tool.execute.before` 加了官方的「执行 ≠ 所见」通道：插件可设置
`output.updatedInput` 整体替换**执行用** args，而模型可见层（`state.input`）、
shell 权限树解析与 `tool.execute.after` 收到的 args 均保持原命令。对齐 Claude
Code PreToolUse 的 `updatedInput` 语义（权限评估按原命令是有意偏离，issue 作者
倾向）。动机场景：mcp-server-fsm 在执行层把 bash 命令 wrap 进沙盒
（`srt --settings ... -c ...`），模型从历史学到 wrap 模式会主动模仿造成嵌套
沙盒（macOS `EACCES` / Linux seccomp `EPERM`，必死）。

关键设计支点：`Tool.Context.visibleInput` —— 恒等于传给 hook 的原始 args 引用。
原地变异（legacy）模式下它 === params（同引用，零分支零行为差）；
updatedInput 模式下 params 已替换而它仍指向原 args。shell 是唯一从命令文本
派生权限 pattern 的工具，改读 `ctx.visibleInput.command` 一处即完成权限面解耦。

## 关键决策

1. **三处传导**（registry 工具循环 / MCP 动态工具循环 / code-mode 子调用），
   同构 `updatedInput ?? args`（实际用 `!== undefined`，null 视为已设置）。
2. **razor 裁剪**：MCP resource 三工具与合成 agent 委托不支持 updatedInput
   （无消费者；前者权限 patterns 逐 arg 解析需双份解析），恢复条件写入契约 §2.3。
3. **校验分流**（audit U1 修订）：registry 工具经 core wrap decode 强制校验
   （失败 → `InvalidArgumentsError`，工具体不执行）；MCP 无 core 侧 schema，
   参数直达 server 由 server 兜底——与无 hook 时的既有基线一致。
4. **对 CC 的显式偏离**：权限按原命令评估（仅 shell；其余工具 pattern 取执行
   入参，方向更保守）。`state.title` 有意携带替换后命令（对模型不可见、对用户
   可审计）。

## 踩过的坑

- `Plugin.trigger` 的 `Output` 泛型会**从第三个实参推断**而非取默认值
  （`Parameters<Required<Hooks>[Name]>[1]`）：调用点传 `{ args }` 字面量时，
  推断出的 output 类型是 `{ args: ... }` 而非 Hooks 上的完整形状，新字段
  `updatedInput` 不存在。probe 十余个才定位（`tsc`/`tsgo` 行为一致）。修法：
  调用点显式给全类型参数。**教训：带默认值的泛型 + 字面量实参 = 默认被绕过**，
  此类调用点加字段后要在所有 consumer 重新核对推断。
- `Tool.define` 的 wrap decode 在 `Effect.orDie` 之后是 defect：测试里经
  `SessionTools.execute`（`run.promise`）会以 **thrown error** 浮出，不是
  Effect 失败通道——断言要用 promise `.then(ok, err)` 双路，不能 `Effect.exit`。
- 测试用的手搓 registry fake 工具**绕过了 wrap**（`registry.tools()` 返回什么
  就用什么），`Tool.define(...).init()` 的产物必须补 `id` 字段（真实 registry
  状态初始化时由 `Tool.init` 统一加），否则 `tools[item.id]` 键成 `undefined`，
  症状是 `tools.typed` 为 undefined 而非明确报错。
- 端到端插件测试的 wrap fixture 第一版用 `printf 'wrapped:<原文>'` 当改写命令：
  它只是**回显**原文，不会真的执行内层命令，导致"内层命令已执行"断言 ENOENT。
  沙盒 wrap 的本质是 `eval 'marker'; <inner>`——fixture 必须真的执行 payload
  才能验证传导；对照 `srt -c "<cmd>"` 的语义。
- file-URL 插件在测试里加载需两件事齐备：config 写入 `plugin: [file://...]`
  + `markPluginDependenciesReady(dir)`（跳过 npm 依赖门）；测试失败时先用
  `Plugin.list()` 查 hook 是否注册，把"插件没加载"与"hook 没传导"两类失败分开。

## 度量

| 指标           | 数值 |
| -------------- | ---- |
| 新增代码行数   | ~504（含测试与文档；git numstat added） |
| 修改代码行数   | ~12（deleted） |
| 删除代码行数   | 12 |
| 涉及文件数     | 25（src 7 + test 14 + docs 4） |
| 新增测试用例数 | 7（单测 6 + 端到端 1） |
| 测试通过率     | session 619/619（prompt.test.ts 99+1 新增全绿，连跑 3 次稳定）、tools 6/6、shell 26/26、tool 全目录 323/324（1 失败为共享机 umask 环境性，干净基线同样失败） |
| 发现 bug 数    | 0（实现层） |
| 修复 bug 数    | 0 |
| 迭代轮次       | 设计 1（AskUserQuestion 确认三决策）+ 实现 1 + 测试修复 3（泛型推断/类型面/测试锚点）+ audit 收尾 1 |

## 经验教训（已回写 CLAUDE.md）

- updatedInput 只在 V1 `SessionTools.resolve` 传导；V2/core 无 plugin hook 层，
  未来接入须移植本契约——已写入 CLAUDE.md 已知限制段。
