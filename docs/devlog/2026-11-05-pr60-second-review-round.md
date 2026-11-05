# 开发日志 — PR #60 二轮审核修复（R1–R7 + workflow 缺口）

日期：2026-11-05
分支：`issue-46-runtime-alignment`
提交：`fbf7392aa8`（dev 合并）→ `9537d163d5`/`e8026cac4b`（合并解冲突）→ `3af69d3537`（R1/R5/R6）→ `6c7c737ba9`（R2/R7）→ `fe5ceede3a`（R3/R4）→ `725e9cb2ba`（III.1–III.5）
关联：PR #60 二轮复审（lihaokun 2026-11-02）、#94（E 项已合入 dev）

## 做了什么

### 0. dev 同步（前置）

合并 origin/dev 9 commits（#94/#97/#100/#102/#103）。三处冲突：
- `tools.ts`：分支 `projectMcpToolResult` 与 dev #97 `refuseRepeats` 同锚点插入 → 两者共存
- `system.ts`：**codex 路线删除**——issue-74 已在 dev 删除 `prompt/codex.txt`（apply_patch 考古结论），本分支 P1 在上游 re-add 的文件上重建了 CODEX 路由 import；合并后文件被 git 自动删而 import 残留 → 按issue-74 判定删路由与 import，codex 系模型落 `PROMPT_GPT`（dev 新测试本来就这么断言）
- dev 的字符串数组 API vs 分支 B7 的裸字符串 API：保留字符串 API，dev 新路由测试适配
- processor 内嵌 DoomLoop 让位 dev #97 的 refuseRepeats（0 引用核实）

### 1. R1/R5/R6（shell 后台，`3af69d3537`）

- **R1 越权读**：`shell_output` settled fallback 在 owner 校验之前 early-return 且不验 `job.type`。修：所有读路径（live/settled/kill-settled）先验 `type === "shell" && metadata.sessionId === ctx.sessionID`
- **R5 默认查询丢终态**：默认 task_id 只扫 live registry。修：优先取本 session 最近 shell job（含 settled），live registry 兜底
- **R6 取消丢尾部**（用户拍板方案二）：`BackgroundJob.cancel` 加可选 `output` 快照参数——在 cancel 临界区内写入 `Info.output`，shell_kill 传入 `stopped\n<buffer>`（与自然 settle 同款 status-line 格式）。被中断的 run fiber 永远到不了 settle，没有这个快照输出就消失。core 加 2 个单测；opencode wrapper 转发 options
- 两个旧断言按新契约更新（kill 后读显示 `stopped` + 尾部，不再裸 `cancelled`）

### 2. R2/R7 + 边界三件（grep，`6c7c737ba9`）

- **R2 跨页漂移**：本机复现 reviewer 场景（160 文件 3 轮 3 哈希）；三模式 rg args 加 `--sort=path`（rg 放弃并行遍历，rowBudget 已界定工作量，正确性优先）。回归：11 目录 × 15 文件 × 3 模式逐页走 165 全唯一
- **R7a 纯 context 页**：窗口逻辑提取为导出纯函数 `windowContentRows`（同时服务 III.1 PBT）；trailing context 仅在本页确有 match 时入页
- **R7b 范围计数**：`Showing a-b` 用 `rows.filter(!context).length`
- 边界：before/after/context 收紧 `NonNegativeInt`；64KiB 记录上限对 context 行降级为丢弃（`oversizedRecord` helper，match 行超限仍整体失败）；换行文件名记为已知限制（JSON 迁移为再评估条件）
- 测试插曲：我的 R2 oracle 先按文件名匹配——基名跨目录重名，Set 收敛到 15；改为 dir/file 对匹配后正确

### 3. R3/R4（restoration，`fe5ceede3a`）

- **R3 dedup 基线错位**：`buildTailText` 无条件拼 tool output，但投影把 `time.compacted` 的 part 渲染为占位符——按不可见文本 dedup 会错误跳过恢复。修：跳过 compacted parts（对齐 message-v2/instruction.ts 惯例；`time` 可能 undefined 用 `?.`）
- **R4 预算不封顶**：Not restored 节无数量/长度上限（1000 引用 ≈ 5.9× 预算）。修：`MAX_REFERENCE_LINES=20` + 溢出合并单行汇总；`materializeCandidates` 预算耗尽即停读（候选按最近使用降序，弃掉的是最陈旧尾部）；`budget_tokens ≤ 0` → `undefined`（堵 1-2 字符内容 round 后估算为 0 免费注入）
- design doc §5.3/5.4 与 expectations G3 行按新口径修订（旧"引用行不计预算"例外废弃）
- **PBT oracle 强化直接抓出两个实现缺陷**：todo 材料复用 /f/ ref 让文件 heading 计数混入 Todo 节（oracle 改为只数 `## Files` 节内）；budget=0 时 1 字符内容免费内联（补 0 预算门）

### 4. III.1–III.5（workflow 缺口，`725e9cb2ba`）

- **III.1**：grep PBT 改 import 生产 `windowContentRows`，加 R7a 性质（越末页窗口必空）；跨调用顺序由真树测试覆盖
- **III.2**：restoration PBT oracle 改为对**最终文本**断言（Files 节内 heading 数 ≤ max_files、整块 token 估算 ≤ budget+框架、零预算 → undefined/无围栏、generator 覆盖 skill/todo kind 且 inlined 必带 content）
- **III.3**：三压缩测试 2-3 轮改真跑 `compaction.process`（旧版 `createSummaryCompaction` 只写 marker，stub 永不消费，断言的是第一轮的陈旧捕获）；断言每轮捕获不同
- **III.4**：system 矩阵逐条断言确切模板（旧矩阵只查共享尾——k3 无 providerID 静默落 DEFAULT 抓不住）；`gpt-5.5` 补上无其它条目可达的裸 `PROMPT_GPT` 路线；restoration 补 `tail_start_id === undefined` 全量摘要正例（#77 测试的 unset 分支是死代码）
- **III.5**：四子计划补 `// Step Pn:` 标记（grepext P1-P9 / bgshell P2-P9 / comprec P1-P8 / prompt-1 P1-P4，全部 grep 可验）；audit-report/decisions 四套回填（诚实声明事后时序）；路径 A 机械检查标 N/A（fork 无自备检查器）；expectations 里"无 tail_start_id 即未 settled"旧口径改为完成摘要谓词

## 实施插曲（教训）

1. **makeCtx 重构引入隐蔽行为破坏**：把 `extra: extra`（传 `{promptOps}` 包装对象）改成 `extra: opts?.promptOps`（传裸 promptOps）——`ctx.extra.promptOps` 变 undefined，completion 通知测试超时。定位靠隔离探针逐步逼近（单工具 init 通过 → initTools 全量失败 → 对比 ctx 构造）。教训：**测试 helper 重构只动签名，不动语义**；`extra` 的形状是产品代码读取契约（`ctx.extra?.promptOps`），不是测试私有细节。
2. **PBT oracle 的"Files 节"边界**：按行首 `### /f/` 数 heading 会把复用同 ref 的 skill/todo 节也数进去——oracle 的取样区间要跟渲染结构对齐，不是跟字符串模式对齐。
3. **oracle 错误先于实现错误**：R2 测试第一版按基名去重（15 unique ≠ 165），差点把正确的 `--sort` 修复当成没修好。性质测试红的时候先证 oracle（打印实际页面行数/内容），再怀疑实现。
4. **git 自动解决 ≠ 语义正确**：dev 删 codex.txt + 分支改 system.ts import → git 静默保留 import，测试才炸。合并后必须跑受影响面的测试，typecheck 不查 txt import 的运行时存在性……实际上 bun test 一跑就暴露了，但没有 CI 前的本地全量就没有防线。
5. **cancel 快照要走 wrapper**：core 的 `cancel(id, options)` 改完 opencode wrapper 还在 `(id) => jobs.cancel(id)`——单测全绿（core 直测），工具层测试才红。跨包接口改动要顺着 re-export 链检查每一跳。

## 验证

- 定向全绿：shell-background 14/14、shell 42（含 core 7）、grep 20 + PBT 5、restoration 12 + PBT 3、compaction 76、system 17、registry/message-v2 70
- 双包 typecheck（--force 全量）干净
- 全套回归与 CI：见 PR #60 提交后 CI（本轮 HEAD `725e9cb2ba`）
- reviewer 复现场景逐条回放：R1 跨会话（stranger 四态拒绝）、R2 七页 165 全唯一、R3 compacted-read 基线排除、R4 千文件封顶、R5 结算后默认查询、R6 kill 后尾部保留、R7a/R7b

## 度量

| 指标           | 数值                                          |
| -------------- | --------------------------------------------- |
| 新增代码行数   | ~600（含测试 ~420、docs ~180）                |
| 修改代码行数   | ~180                                          |
| 删除代码行数   | ~90                                           |
| 涉及文件数     | ~20 + 8 审计文件 + 2 文档修订                 |
| 新增测试用例数 | 15（shell 3+core 2、grep 4、restoration 2、system 矩阵重写、compaction 重构、PBT 重写×2） |
| 测试通过率     | 定向 100%；全套见 CI                          |
| 发现 bug 数    | 9（R1-R7 + 边界×2 + 0 预算免费注入）          |
| 修复 bug 数    | 9                                             |
| 迭代轮次       | 1 轮（每批 1-2 次修正）                       |

## 经验教训

（回写 CLAUDE.md 的条目见本地文件；要点：测试 helper 重构不动语义；PBT oracle 取样区间对齐渲染结构；性质测试红先证 oracle；合并后必跑受影响面；跨包接口改动沿 re-export 链逐跳检查。）
