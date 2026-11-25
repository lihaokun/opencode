# 开发日志 — PR #60 自审轮（reviewer 标准自查 + 修复）

日期：2026-11-05（晚，二轮修复完成后）
分支：`issue-46-runtime-alignment`
提交：`5fa184392c`（P2-a lock）→ `62e02f0c01`（P2-b sentinel 退役）→ `0a9a156a6d`（P2-c 级联快照）→ `92dbdc7900`（P3-a 引用行封顶）→ `458905e065`（P3-b todo 排序）→ `3f45585998`（模块环修复）
关联：用户指令"按 reviewer 的标准再仔细重新审视一下这个 pr"

## 做了什么

### 1. 自审方法

两个并行对抗性 subagent，按 reviewer 的五维不变量（归属/顺序/有界/终态/可见性）攻击 PR 全部改动面（shell 后台 / grep 分页 / restoration / compaction / prompt 模板 / message-v2 / config+SDK 类型面）。发现合并去重后 6 项（3×P2、3×P3 核心），另有约 6 项小 P3 记录不修（用户拍板"P2 全修 + P3 核心两项"）。

两项 P2 我先自行核实源码再动手（`bun.lock` 逐行验证 workspace block 确无 fast-check；sentinel 双压缩场景沿 filterCompacted 实际迭代顺序推演）。

### 2. 修复明细

- **P2-a `bun.lock` 缺行**：PBT 加的 `fast-check@4.8.0` 从未写入 lock 的 workspace block——CI 的非 frozen 安装第一次跑就会弄脏 lock。frozen 能过纯因 effect 的传递依赖恰好提供了该包（CLAUDE.md 警告过的"意外满足"）。手工只提交该行（分离 ambient drift）。
- **P2-b sentinel 跨压缩堆积**：触发判定只比消息 index、字节去重只看最新 user message——第二次压缩的保留尾若仍含第一个 sentinel 的载体消息，两个满血恢复块同时模型可见（各至多 8000 token，都自称当前恢复），违反设计 G4。修：写新块前把所有旧 sentinel 原地翻 `ignored:true`（updatePart 同 id upsert，不追加行）；触发扫描与字节去重都跳过 ignored。
- **P2-c 级联取消丢尾部**：R6 只修了 shell_kill 直杀路径；`run-state.ts`（agent_stop/interrupt）与 `session.ts`（会话删除）的级联 cancel 裸调——恰是更常用的整会话打断场景。修：导出 `cancelSnapshot(taskId)`，两个级联点传入。
- **P3-a 引用行只封条数不封长度**：ref 是原始绝对路径（PATH_MAX 4096），20 行 ≈ 21k token 对 8000 预算。修：`MAX_REF_CHARS=160` 截断，覆盖全部 ref 出现点（引用行/两条降级行/`### ref` heading）。PBT generator 原来硬编码短 ref——新增 PATH_MAX 生成器 + 确定性最坏锚点（PBT 对长字符串欠采样）。
- **P3-b todo 排序颠倒 + 说谎文案**：todo 的 lastUseSeq = seq+1（最新）却在 sort 后追加 → 最便宜材料反而最后处理、最先被预算挤掉，整份当前 todo list 降级为引用行。修：排到最前。降级文案按 kind 分流——todo 没有 read 工具可读，不再指一条死路。

### 3. 自审修复本身引入的 CI 断裂（本轮最大插曲）

P2-c 初版把 `cancelSnapshot` 放在 `tool/shell.ts` 里，session.ts / run-state.ts 从那 import——构成 `session → tool/shell → plugin → session` 模块环，provider LayerNode 的 deps 数组在模块初始化期 TDZ 崩溃（`Cannot access 'node' before initialization`），**三个 linux unit 分片全红**。

- 定位：本地复现 `bun run ./src/index.ts generate`，逐 commit checkout 二分到 `0a9a156a6d`。
- 修复：注册表与 `cancelSnapshot` 拆到叶子模块 `tool/shell/tasks.ts`（文件头写明环的原因——不然下次有人又合并回去）。
- 教训见下。

### 4. 修复纪律执行情况

每项修复都做了 falsification：回滚修复 → 新测试必须红（P2-b 双压缩可见块=2 红、P2-c 尾部断言红、P3-a 最坏锚点 21k>10k 红、P3-b 排序+文案双红）。全部定向绿后跑受影响面（restoration/PBT/shell-background/run-state/session/prompt/compaction 共 297 用例）+ 双包 typecheck + generate。

## 实施插曲（教训）

1. **模块环是 typecheck 盲区、generate 才是哨兵**：`session.ts` 本来就 import `type { Provider }`（type-only，擦除后无环），我加的是**值导入**——tsgo 两个方向都干净，只有运行时按真实加载顺序才炸。本仓库的哨兵是 `bun run ./src/index.ts generate`（turbo 链上 sdk build 必经）。改 session/ 揺值导入时本地先跑 generate。已回写 CLAUDE.md。
2. **git stash 路径解析坑**：zsh 下 cwd 漂到子包后 `git stash push -- <path>` 会按错误 prefix 解析；统一从 repo root 执行。
3. **PBT 长字符串欠采样**：fast-check 的默认 string generator 几乎不会生成 4096 字符串——"pathological refs"性质若只有 PBT 无确定性锚点，等于没测。对抗性输入要给显式最坏 case 锚点。
4. **windows CI flake 新类别**：`@opencode-ai/plugin` 的 tsc cache miss 后 exit 1 且日志无 TS 错误行，同 commit 重跑即绿（17m31s）——归入已知 load-class flake。

## 度量

| 指标           | 数值                                    |
| -------------- | --------------------------------------- |
| 新增代码行数   | ~330（含测试 ~230、tasks.ts ~40、devlog） |
| 修改代码行数   | ~60                                     |
| 删除代码行数   | ~35                                     |
| 涉及文件数     | 8                                       |
| 新增测试用例数 | 5（双压缩退役、PATH_MAX PBT+锚点、todo 排序+预算、级联尾部） |
| 测试通过率     | 定向 100%；CI 14/14（windows 3/3 重跑后） |
| 发现 bug 数    | 6（自审）+ 1（自审修复引入的模块环，CI 抓住） |
| 修复 bug 数    | 7                                       |
| 迭代轮次       | 自审 1 轮 + 1 次返工（模块环）           |

## 经验教训

（回写 CLAUDE.md 的条目见该文件；要点：session 层加值导入先跑 generate；对抗性输入配确定性最坏锚点；修复轮的新代码同样要过"它自己会不会破坏加载顺序"这一问。）
