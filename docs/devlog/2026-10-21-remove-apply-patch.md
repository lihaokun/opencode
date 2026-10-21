# 2026-10-21 移除 apply_patch 工具与 GPT 模型条件化工具替换（issue #74）

## 做了什么

按 `docs/fixes/issue-74-model-conditional-tools.md` 的修正方案，彻底移除 apply_patch：

1. **A 工具注销**（`574bee6b71`）：registry 删 ApplyPatchTool 注册与 `modelID.includes("gpt-")` 的 usePatch 过滤；删 `tool/apply_patch.ts`/`apply_patch.txt`/`patch/index.ts`（Codex patch DSL 解析器，生产代码零消费者）；删 cli run patch 面板与 demo emitPatch。净删 ~2164 行。
2. **B 权限/配置**（`116e3a1adf`）：`permission.disabled()` edits 组删 apply_patch；config `tools` 折叠表删 `"patch"` 别名。
3. **C core 包**（`82572f2b80`）：V2 runner 侧同款摘除（`core/src/tool/apply-patch.ts`、builtins 注册、测试 fixture）。
4. **D 提示词**（`622d25c765`）：删 `prompt/codex.txt`（考古结论：其诞生就是为 apply_patch 写的软化 header，whitelist 机制消失后被扶正成整份提示词）+ `system.ts` codex 分支；`gpt.txt` 两处 apply_patch 指令改 tool-agnostic。
5. **E 测试同步 + 回归**（`a0f412e6a7`）：删 apply_patch/patch 测试套件与快照条目；既有 fixture 改 write/edit；新增 3 组回归（GPT/codex 工具集不变式、提示词路由与文本守卫、config 折叠语义）。
6. **F 文档**（本轮）：修正方案文档第六/七/八部分回填；CLAUDE.md 已知限制回写两条。

## 为什么

见修正方案文档第二部分与 4.0 决策节。一句话：模型条件化分叉"写文件"接口且无任何适配/覆盖途径，是外部路径门控集成（#74 FSM 工作流）停摆的根因；fork 无 apply_patch 的其他消费者，彻底移除比对齐契约更符合剃刀原则。

## 关键决策

- **展示层保留**：TUI/session-ui/app/ACP 的存量 part 渲染分支零改动——历史会话消息库里有 apply_patch part，工具消失 ≠ 名字消失。
- **`patch` 别名一并清除**：config 折叠表的 `"patch"` 别名同样无对应工具，落成悬空 per-tool 规则（无害），不做静默吞掉。
- **质量代价显式化**：GPT 系放弃训练分布匹配收益（外科手术式编辑 oldString 匹配失败率可能上升），列入上线后观测项而非功能回归——用户已拍板。

## 踩过的坑

1. **config 折叠有三处，方案只列了一处**：opencode `config/config.ts` 之外，core `v1/config/agent.ts`（per-agent normalize）和 `v1/config/migrate.ts`（normalizeAction）存在同款 `"patch"` 别名折叠。opencode 侧改完后自己的回归测试仍红，才定位到 core 两处。教训：改"折叠/归一化"语义时按 consumer 全集 grep（`"patch"` 字符串面），不按文件清单。
2. **`gpt.txt` 快照守卫**：新增的文本级守卫（gpt prompt 不含 "apply_patch" 字样）是防止未来再引入硬编码工具名的低成本锚点。
3. **snapshot-tool-race 超时是既有的**：全套验证时该用例 5s 超时，stash 后基线同样超时（分支 tip `622d25c765` 未改动它除一行注释外），与本次无关，已记录在 commit message。
4. **Edit 工具的字符串替换在 system.ts import 块上失手一次**：把 `PROMPT_META` 的 import 误删（`old_string` 匹配了错误行），靠 grep `PROMPT_META` 引用立刻发现并修复。多 import 块编辑后必须 grep 被删符号确认零引用。

## 度量

| 指标           | 数值                   |
| -------------- | ---------------------- |
| 新增代码行数   | ~390（含 319 行合并文档 + 回归测试） |
| 修改代码行数   | ~40                    |
| 删除代码行数   | ~3071                  |
| 涉及文件数     | 33（dev 基线 diff；源码 15 + 测试 15 + 文档 3） |
| 新增测试用例数 | 5（registry ×1、system ×2、config ×1、归入改写的 scrollback 断言 ×1） |
| 测试通过率     | 触达套件 154/155（唯一失败为既有超时，stash 验证与本改动无关）；全仓 typecheck 30/30 |
| 发现 bug 数    | 1（config 折叠三处，方案低估两处——自抓） |
| 修复 bug 数    | 1                      |
| 迭代轮次       | 设计 3 轮（调研→方案→合并文档）；实施 1 轮；修复 1 轮（core 折叠补漏） |
