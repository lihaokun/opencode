# #79 审核缺口补齐

基线：`48d0289e`（#79 已合入 dev `7bd8532a`）。用户已授权按 workflow 修复并完善 PBT；本轮保持已经选定的工具/别名/CLI 面板删除方案。

## 一、现象与复现

- Codex 路由测试仅检查两个字符串不存在；将路由错误地指向 DEFAULT/ASTRA 等模板仍会通过。
- 配置测试只覆盖 per-agent `patch:true`；顶层、false、V1→V2 迁移及权限优先级没有语义保护。已有 schema PBT 无法区分 `patch:deny` 与错误恢复的 `edit:deny`。
- HTTP 回归只列工具 ID，没有走实际 write/edit → hook → 权限/磁盘边界。CLI 旧 patch fallback 的覆盖被随专用面板删除。
- Core 仍留有无生产 consumer 的 `src/patch.ts` 及专用测试；用户工具文档仍介绍已删除的 apply_patch。
- 文档把别名变化称为无害、把所有编辑能力与历史展示称为不变，超出实际保证。

## 二、根因

测试 oracle 只证明目录或 schema 形状，没有证明路由、权限语义、执行身份及副作用。清理扫描遗漏 Core 的 parser 副本与公开文档；兼容说明混淆了删除后的同名规则与删除前的 edit 别名。

## 三、参考对照

以已批准的 #79 契约及同仓库原 write/edit、ConfigAgentV1/ConfigMigrateV1、CLI 通用工具 renderer 为参考：

- 常规 GPT/Codex 对照实际 GPT 模板，高优先级 gpt-6/gpt-4/o1/o3 对照各自实际模板。
- `{patch,apply_patch}` 保持同名 action，`{write,edit}` 归 edit；显式 permission 按各入口原有规则优先生效。
- 旧 apply_patch 调用不可重新执行，但历史 part 继续走保留的模型转换/展示或 CLI 通用 fallback。

## 四、方案和不变量

### C1 工具与执行

在固定 provider、Agent、权限、深度和 flags 下，改变合法 model ID 不改变 stock write/edit 身份与参数 schema；apply_patch 不属于 stock 工具。不禁止用户同名自定义工具。provider 的 websearch gate 不被本属性错误抹平。

真实执行回归用 GPT 命名模型调用 write/edit，hook 获得结构化 filePath，允许路径产生预期文件内容；被拒绝路径不写盘，不使用 shell 绕过。

### C2 Prompt 和权限

Prompt oracle 使用实际模板精确相等，覆盖既有优先级。配置的三个实际入口覆盖上述四键的 true/false 及混合/显式 permission 覆盖；PBT 对最终语义做断言，而非只检查 schema。保持既有入口差异：Core 顶层 V1→V2 migration 追加显式路径规则，未匹配路径可保留 tools 默认；legacy 顶层与 Agent normalize 的显式 edit map 会替换该默认。本轮不统一这两种既有语义。

旧 `tools.patch:false` 不再限制 write/edit，这是已选方案的兼容变化；需要保留编辑限制时迁移到对应全局或 Agent 的 `permission.edit`。不在本轮反转此决定。

### C3 历史与删除范围

保留 TUI/session-ui/app/ACP 的历史兼容，不恢复 CLI 专用 patch 面板，补 CLI 通用成功/错误 fallback 和历史模型转换的真实数据回归。删除 Core 无剩余生产用途的 parser 及仅服务它的测试，不动 npm diff 的解析器或存量 part 类型。

### C4 文档

公开工具清单不再把 apply_patch 宣称为可调用内置工具；说明当前 write/edit 的创建/更新能力、删除/移动专用入口的损失、旧权限键迁移和 CLI 历史展示降级。保留历史兼容所需的名称，不做全仓字符串抹除。

## 五、正确性论证

- 正向模板 oracle 能区分错误路由；语义配置 oracle 能区分合法但错误的规则映射，生成器须明确采样特殊键而非期待随机字符串碰巧命中。
- provider 轨迹以 hook 观察值、实际文件内容和拒绝后文件不变为 oracle，覆盖工具目录之外的执行边界。
- model-ID 属性只改变一个维度，不复制生产过滤条件；深度/权限对照单独检查其既有作用。
- Core parser 只剩专用测试引用，移除后当前工具、模型转换及历史 renderer 没有解析依赖；通过全仓 consumer 扫描、typecheck 和回归核实。
- 本轮不改运行调度、权限策略、公开 Protocol/HttpApi 或模型采样。

## 六、测试与验证计划

| 项目 | 预期 | 状态 |
|---|---|---|
| 正向 Prompt 路由 | 错路由变异 RED，精确模板和优先级 GREEN | 已补并通过；错误 GPT→ASTRA 变异被捕获 |
| 三入口配置矩阵/PBT | 四键×boolean、混合覆盖与最终权限语义 | 矩阵及 FastCheck 64 cases 通过；分别恢复三处旧 patch alias 均 RED |
| Model-ID PBT | FastCheck 生成合法 ID，实际 registry 身份/schema 不变 | 24 cases × 3 provider/depth/permission 场景通过；模型条件过滤变异被捕获 |
| GPT wire/hook/file | 实际 write/edit，允许路径变更、拒绝路径不变 | 真实 Session + file plugin，4 次工具调用、5 次 provider 请求；1 pass / 43 断言 |
| 历史 part | CLI fallback 成功/错误、模型转换仍可读 | 新增回归通过；既有 session-ui 历史辅助函数 17 pass |
| 清理与集成 | 引用扫描、相关 Core/OpenCode/CLI/权限套件、包内 typecheck | OpenCode 429 pass、Core 69 pass，均 0 fail；两包 typecheck 通过；MDX 解析通过 |
| 独立复审 | 契约+diff 及必要运行/PBT 审核 | 路径 B 无实现缺陷；唯一删除安全补证由下述路径 A 闭合 |

独立路径 B 报告为 `/tmp/pr79-repair-independent-audit.md`，0 个实现缺陷；其 W1 限于无法只靠 diff 证明不存在外部 consumer。主审路径 A 在删除前核实 Core parser 只有自导出和专用测试，删除后全仓 production/test import 扫描零命中，Core/OpenCode typecheck、69/429 项集成与17项历史UI辅助回归通过，闭合该项。没有为删除执行器而删除历史数据类型或保留的 renderer。

五个隔离变异均以语义断言失败而被检出，日志为 `/tmp/pr79-repair-mutation-*.log`；变异后恢复工作区，没有把开发测试夹具的失败冒充 RED。验证数字按实际套件分别列出，不重复累计先前的定向复跑。

## 七、代码更新清单

| 路径 | 改动 | 状态 |
|---|---|---|
| core/src/patch.ts、core/test/patch.test.ts | 删除无生产用途的 parser 副本及测试 | 已实施：`0ef0439d` |
| opencode/core 的相关 test | 路由、配置、stock 工具性质、真实执行、历史 fallback | 已实施并验证：`0ef0439d` |

## 八、文档更新清单

| 文档 | 改动 | 状态 |
|---|---|---|
| 本文 | 契约、论证、验证与 commit 回填 | 已完成；实现提交 `0ef0439d` |
| 原 issue-74 fix 文档和 devlog | 去除过宽承诺，补迁移/能力/CLI 差异说明 | 已更新 |
| web 英文 tools/agents/permissions、Core tool AGENTS | 当前工具表和迁移说明 | 已更新；不声称本轮重译所有本地化页面 |

不新增产品功能、配置开关、执行绕过或对旧数据库的改写。
