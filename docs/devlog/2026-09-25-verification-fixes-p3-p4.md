# devlog — 人工验证修复轮二（子计划 agentmgmt-1：P3 行仪表 / P4 常驻面板 / P5 四项修正）

日期：2026-09-25　分支：`agentmgmt-1-tui-subagent-surface`

## 做了什么

用户继续人工验证，提出两个增强（`verification-findings.md` P3/P4），确认后本轮修复：

**P3 行信息补全**：subagent 名称后 muted 简述（标题剥 `(@type subagent)` 后缀，委派时
模型给的描述，零新数据）；最右侧 footer 槽显示 token 聚合（紧凑格式）与时长（busy/retry
实时、完成定格）。三个纯函数 `subagentDescription`/`formatListTokens`/`formatListElapsed`
可无渲染测试。

**P4 常驻面板**：`AgentsPanel` 常驻输入框底部——行解剖与对话框同源（`formatAgentRow`
单一 owner），行点击跳转、1s tick、≥2 成员显示、>5 行截断指向对话框；down 对话框保留
（过滤/键盘导航）。豁免 dialog 栈与键盘焦点问题：面板纯只读 + 鼠标。

## 关键验证与教训

- **测试抓正则 bug**：`subagentDescription` 首版漏了标题末尾的 `)`，正常用例当场红——
  这类"看起来必然对"的解析函数必须配正常+空+负例三路。
- **Solid 两处小坑**再确认：`<Show when={a && b}>` 类型收窄陷阱（嵌套 Show 绕过）；
  keyed Show 的函数子节参数是**值**不是 accessor（误加 `()` 即 TS2349）。
- 面板滚动区的诚实取舍：非聚焦 scrollbox 的滚轮行为无法在无 TTY 环境验证，改为
  ">5 行截断 + 指向对话框"——不吞行、永远可达；原确认措辞已按实现修订并标注。
- 路径事故一次：footer 误写到 `component/subagent-footer.tsx`（真实文件在
  `routes/session/`），git 状态 `??` 立刻暴露，当轮删除。

## 度量

| 指标 | 数值 |
|------|------|
| 新增代码行数 | ~260（含面板组件 ~95、测试 ~110） |
| 修改代码行数 | ~60（对话框改用共享行函数；route 接线） |
| 删除代码行数 | ~55（对话框内重复组装、footer 按钮、导航命令） |
| 涉及文件数 | 10 |
| 新增测试用例数 | 15（P3 11 + P4 4） |
| 测试通过率 | TUI 234 跑 / 4 skip / 0 fail；opencode 未触及 |
| 发现 bug 数 | 1（路径事故，当轮修正）+ 1（正则漏括号，测试抓出即修） |
| 修复 bug 数 | 2 |
| 迭代轮次 | 2（P3 一轮；P4 一轮含两处类型修正） |

## P5（同日追加）：面板四项修正

1. **对齐**：面板容器改 `paddingLeft 5 / paddingRight 3`（左对齐转录文本列、右对齐输入
   框内边右缘）——列基准从 JSX padding 链推得，待用户实测确认
2. **当前行高亮**：`●` + primary；`formatAgentRow` 删除 isCurrent/current 文字标记
   （高亮归渲染面，行装配不再掺呈现语义）
3. **删输入框提示行**：面板常驻后冗余
4. **计数口径统一（用户选 1）**：新共享纯函数 `contextUsage`（最后一条 assistant 消息
   聚合 + % of limit）为 footer/对话框/面板唯一 owner；footer 重构复用（显示不变）；
   `session.tokens` 累计口径与 `formatListTokens` 删除。教训：**写"消耗量"之前先问
   口径**——累计 vs 上下文占用是两个都会被叫"token 数"的数，先核实投影实现
   （projector 是累加）再讨论，避免空对空。

度量：新增 ~90（contextUsage + 面板高亮 + 测试 3 例），删除 ~45（提示行/
formatListTokens/旧口径）；文件 7；测试 TUI 235 跑 / 4 skip / 0 fail。
