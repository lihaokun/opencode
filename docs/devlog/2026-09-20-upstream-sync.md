# 开发日志 — 同步 upstream/dev（v1.18.26 → v1.18.31）

- 日期：2026-09-20
- 分支：`sync/upstream-dev-20260920`（自 `dev` @ `5ab6b50a31` 切出）
- 上游：`upstream/dev` @ `ebb7b76eca`（2026-09-19）
- 同步方式：merge（保留双方历史）
- Merge commit：`df76a72a5e`

## 背景

上次同步（2026-08-30，#24）后上游又前进 156 个提交：47 个触及核心产品（opencode/core/tui/sdk/app），104 个为 web/console/stats/zen 文档与营销站（与 fork CLI 构建无关，随 merge 带入）。横跨上游 6 个补丁版本（v1.18.26 → v1.18.31）。fork 侧自上次同步新增 7 个提交（agent management、fork release CI 等）。

与上次同步 23 个冲突文件相比，本次 `git merge-tree` 预检显示仅 2 个冲突文件——fork 侧改动最重的 `tui/routes/session/index.tsx`（agent management，+211 行）、`provider/transform.ts`、`session/processor.ts` 全部自动合并成功。

## 完成内容

1. **merge `upstream/dev`**，仅 2 处冲突手工解决：
   - `package.json`：`patchedDependencies` 尾部取并集（上游新增 `@ai-sdk/anthropic@3.0.111`、`@ai-sdk/amazon-bedrock@4.0.166`、`@ai-sdk/openai@3.0.88` 三个 patch 条目；我们的 groq/openai-compatible/xai 上游未触碰，原样保留）。解决后与上游 patch 集合逐项比对一致（19 条）、引用文件全部存在、无重复键。
   - `packages/opencode/test/plugin/codex.test.ts`：双方在同一位置各加了一个 test（我们的 chat.params override 测试 + 上游的 GPT major/minor 版本过滤 `test.each`），keep both。
2. **验证矩阵**（详见下表），重点覆盖 `@ai-sdk/anthropic` 3.0.82→3.0.111（+上游官方 528 行 patch）与我们 processor 层 reasoning 修复的交互。
3. **排除一个伪回归**：vertex block-binding 测试失败，初判为 merge 语义回归；经三方基线矩阵（dev / upstream / merged 各自干净安装）证明根因是 merge 后增量 `bun install` 在 `.bun` store 残留 6 个 anthropic 实例（dev 时代累积），vertex 经 `@ai-sdk/google-vertex/dist/anthropic` 委托 `@ai-sdk/anthropic/internal` 时解析到旧闭包副本。全量删除所有 workspace 的 `node_modules` 后 `--frozen-lockfile` 重装（4721 包、1 个实例，与上游干净安装逐项一致），测试转绿。**merge 语义层面零回归。**

## 关键决策

- **merge 而非 cherry-pick**：冲突仅 2 个平凡文件；cherry-pick 47 个核心提交会制造永久分叉史并丢失上游测试上下文，未来同步成本更高。
- **patchedDependencies 取上游块即并集**：我们的条目是上游块的真子集（groq 两侧都有，openai-compatible/xai 在公共上下文），无需自行拼接。
- **干净重装后再出最终快照**：typecheck/定向测试先跑暴露问题，全量回归在依赖树与上游逐项一致后执行，保证快照有效。

## 验证结果

| 验证项 | 结果 |
|--------|------|
| `bun install --frozen-lockfile`（干净重装后） | 通过；4721 包，与上游基线安装数一致 |
| patch apply 实证 | anthropic 3.0.111（`inputTransformations` ×4）、openai-compatible（fork 修复标记 ×1）在两个 workspace dist 均确认存在 |
| typecheck（turbo 全仓） | 30/30 通过 |
| `test/session/`（21 文件） | 585 pass / 0 fail（fork 修复最密集区域） |
| `packages/tui`（46 文件） | 205 pass / 0 fail（agent management × OpenTUI Dynamic 重构同文件区域） |
| `packages/core`（144 文件） | 1098 pass / 0 fail |
| opencode 全套（266 文件，3927 用例） | 3894 pass / 10 fail / 22 skip / 1 todo |
| 全量失败归属 | 10 个失败在 merge 前 `dev` 基线逐一相同失败 → **merge 引入回归 0**；4 个 cf-ai-gateway 在上游自己的 dev 分支同样失败（上游测试与 lockfile 解析的 ai-gateway-provider 3.2.0 不匹配） |
| merge 附带修复 | dev 上的 bare repo 检测 30s 超时失败在合并树转绿 |

## 踩过的坑

1. **增量 install 不重置 `.bun` store（本次最大坑，已回写 CLAUDE.md）**：merge 后 `bun install --frozen-lockfile` 只增量装了 11 个包，`.bun` 里同版本 SDK 残留多个旧 peer-combo 实例目录。当第三方包（google-vertex）经 `internal` 子路径委托 patched SDK（anthropic）时解析到旧副本，上游新测试单点失败而上游基线通过——症状极像语义冲突。归因前先比 `.bun` 实例数（merged 6 vs upstream 1）。
2. **冲突两侧共享结尾 `})`**：双方各自新增 test 但 diff 上下文共享同一个闭合括号，keep both 时必须给前者补回 `})`，否则语法上第二个 test 被吞进第一个的箭头函数体（bun Transpiler 能过 scan，运行时才炸）。
3. **取对侧冲突块会带入公共上下文重复键**：上游块内含公共上下文已有的 `openai-compatible` 条目，整块照抄产生 duplicate key。bun 解析 JSON 时的 duplicate key 警告捕获了它，解决后加了无重复键断言。
4. **后台跑套件用 `| tail` 会丢中间输出**：失败名单随缓冲丢弃，最终快照只能重跑（11 分钟）。长套件应直接落盘或 grep 失败行到文件。
5. **zsh glob 无匹配会中断整条命令链**：`rm -rf node_modules && for d in packages/*/node_modules...` 中 glob 失配导致后半没执行（rm 已生效）。清理类操作用 `find -exec` 替代 glob 循环。

## 度量

| 指标 | 数值 |
|------|------|
| 新增代码行数 | +15820（merge 带入上游；fork 手写 ~10 行冲突解决） |
| 修改代码行数 | −3723（同上，以下游删改为主） |
| 删除代码行数 | 3（冲突标记）/ 1（duplicate key 条目） |
| 涉及文件数 | merge 236；手工解决 2 |
| 新增测试用例数 | 0（fork 侧；上游带入新测试，全套件 3927 用例） |
| 测试通过率 | opencode 3894/3904≈99.7%（10 个失败均为存量、dev 同样失败）；core 1098/1098；tui 205/205（1 skip） |
| 发现 bug 数 | 0 产品 bug；1 流程性伪回归根因（node_modules 残留） |
| 修复 bug 数 | 0 产品 bug；消除伪回归 1（干净重装）；顺带确认 4 个存量 gateway 失败为上游自身问题 |
| 迭代轮次 | 验证 2 轮（首轮暴露 staleness → 干净重装复跑出最终快照） |

## 经验教训（已回写 CLAUDE.md）

- merge/切分支后的增量 install 可能留下 `.bun` 旧实例，patched SDK 经子路径委托时解析到旧副本——判定"语义回归"前必须先做依赖树归属矩阵（dev / upstream / merged 各自干净安装对照）。
- keep-both 型冲突要检查两侧是否共享结构性闭合符号。
- 对侧冲突块照抄前先与公共上下文查重。
