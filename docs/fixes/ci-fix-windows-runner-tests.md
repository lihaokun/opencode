# 修正方案 — GitHub-hosted Windows 测试兼容性

- 状态：断言修正 `fbff2233c0`、调度层修正 `68c7db55c3`、file-search readiness 修正 `cfa91ddecd`、异步测试边界修正 `832d440911`、search 初始化顺序修正 `ecaf44fc70` 已完成；待第四轮 CI
- 日期：2026-08-18
- 对应 PR：[#15](https://github.com/lihaokun/opencode/pull/15)
- workflow 路径：`docs/workflow.md` §7 bug-fix flow + §7.1 八部分修正方案
- 修复分类：测试用例、测试调度与一个内部 file-search readiness 行为修正；不改变公共接口或数据库 schema

## 第一部分：现象与复现

PR #15 的 GitHub-hosted `windows-latest` Unit job 完整运行后留下四个失败：

1. 两个 Windows 路径规范化用例把 `C:` 盘符删除；runner 工作区位于 `D:`、临时目录位于 `C:`，无盘符 rooted path 因而解析到 `D:`。
2. `db path` smoke 用例收到合法的 `C:\\...\\opencode.db`，但正则只接受 `:memory:` 或以 slash 开头的路径。
3. File HttpApi 的异步文件索引未在固定 5 秒 deadline 内发布 `hello.txt`。

失败 run：https://github.com/lihaokun/opencode/actions/runs/32076666714

可比的上游全绿 run 使用相同测试文件，但运行于 `blacksmith-4vcpu-windows-2025`；其工作区和临时目录都位于 `C:`：

https://github.com/anomalyco/opencode/actions/runs/30878264941

Windows E2E 同时有两个最终失败和六个 retry 后通过的 flaky 用例，但前一个仅相差 Unit workflow deadline 的 fork run 已 93/93 通过：

https://github.com/lihaokun/opencode/actions/runs/32072875850

因此 E2E 本轮只复跑，不在缺少稳定复现时修改断言。

首轮修正后的 CI 进一步给出以下证据：

- 两个 Windows path variant 和 `db path` 不再失败，证明三处断言修正有效。
- 文件索引即使把 deadline 从 5 秒提高到 30 秒仍未 ready；同一 Unit run 还出现 InstanceBootstrap、VCS 与 prompt 的全新 timeout，后续 hook failure 是首个 timeout 的级联。
- Linux E2E 最终失败在 `session-todo-dock-navigation`；Windows E2E 最终失败在 `file-browser-sidebar-tab-switch`，并有八个其他用例 retry 后通过。失败点与前一轮 Windows 的两个最终失败完全不同。

这说明剩余问题不是继续逐项增加 timeout 可以解决，而是 GitHub-hosted runner 在既有 Unit package 并行、最多 20 个显式 concurrent tests、Playwright 5 workers 下发生资源饥饿。

第二轮 CI 使用串行 Windows package task、opencode concurrency 4 和 Playwright Linux/Windows 4/2 workers：

- Windows E2E 93 项全绿；测试正文从前轮 15.2 分钟降至 3 分 40 秒。
- InstanceBootstrap/VCS 的级联 timeout 消失，证明调度限流有效但不是全部根因。
- Windows Unit 剩余五项：File HttpApi 初始搜索连续第二轮在 30 秒内仍为空；两个 shell-loop 用例命中显式 10 秒 deadline；ACP EOF 命中显式 5 秒 deadline；skill version refresh 的 pull 已返回但测试通过 `Bun.file` 读取到原子目录替换前的旧内容。

因此剩余项拆为一个生产 readiness 竞态、三个已测量的测试 deadline，以及一个 Windows 文件读取观察问题。

第三轮 CI 中两组 E2E、Linux Unit、skill refresh、两个 shell-loop 与 ACP EOF 全部通过。Windows Unit 3450 项只剩 File HttpApi 一项失败，但失败已从“30 秒索引仍为空”变为 1.7 秒内 `findText` 返回 503。回归改写曾把 `findText`、`findFile`、`findSymbol` 三个首次 instance 请求放入同一个 `Promise.all`，改变了原用例先建立 instance、再验证 file readiness 的拓扑。最终修正恢复 text/symbol 先完成，随后用单次 `findFile` 请求验证 readiness postcondition。

## 第二部分：根因分析

- 路径用例把删除盘符误当作大小写和 separator 变体。Windows 的无盘符 rooted path 绑定当前盘；跨 `C:`/`D:` 后已不是同一个文件身份。
- CLI fixture 显式设置隔离的 `OPENCODE_DB`，使 `db path` 合法地返回 drive-letter absolute path；smoke 断言没有覆盖该既有 fixture 分支。
- ripgrep 文件索引通过 scoped fiber 异步填充。测试已经轮询真实查询结果，但 5 秒 deadline 只在更快的上游 runner 上稳定，未覆盖 GitHub-hosted Windows 的冷启动和并发负载。
- `ripgrepLayer.find()` 只读取逐步填充的内存数组，不保存或等待首轮扫描 fiber。调用发生在首轮 entry 到达前时，合法查询可以返回瞬时空结果；外层 HTTP 轮询只能反复观察同一竞态，不能建立 readiness 契约。
- opencode suite 内有 21 个显式 concurrent tests，Bun 默认上限为 20；Turbo 同时运行多个 package test task。上游 Blacksmith 能承受该并发，GitHub-hosted Windows 会随机让真实进程、git、watcher 和 background index 超过各自 deadline。
- E2E 在 CI 固定使用 5 workers。日志包含 Chromium GPU transient failure 和 `browserContext.close()` teardown timeout，且最终失败跨 run、跨 OS 漂移；同一应用代码已有成功 run，不能归类为产品回归或某一个错误断言。
- 两个 shell-loop 用例在本机隔离运行已需约 6.6 秒，10 秒外层 deadline 对 Windows 冷路径没有合理余量；ACP 子进程在失败 run 中约 5.4 秒退出，超过其 5 秒内层 deadline。
- skill refresh 的生产写入使用 `FSUtil` staging + rename，Core 的等价回归通过 fresh filesystem read 验证；legacy 测试却用 `Bun.file` 观察被原子替换的同一路径。先统一为同一 `FSUtil` 观察边界，若 Windows 仍返回旧内容再升级为生产 rename/cache 修正。

## 第三部分：参考实现对照

本问题不是算法修正，无外部算法参考实现。内部参考为上游 Blacksmith Windows run：失败测试文件与当前 branch blob 相同，但 runner 盘符布局和性能不同。该对照证明路径断言含环境假设，也证明 CI 只是暴露了同一 file-search readiness 竞态，而不是本 branch 引入了实现差异。

## 第四部分：修复方案

1. 两个 Windows path-variant 用例保留 drive letter，只改变 separator 和大小写；继续用真实实现验证 canonical permission path。
2. `db path` 用 `path.isAbsolute()` 和允许的 SQLite 扩展名验证文件路径，单独保留 `:memory:` 分支。
3. 首轮曾把 File HttpApi readiness deadline 提高到 30 秒并降低轮询频率；第二轮 CI 证明该 workaround 不足，最终由第 6 项替代并回退额外轮询配置。
4. Windows Unit 将 Turbo package task 串行执行；opencode suite 的显式 concurrent tests 上限从 20 降到 4。Linux 保持现有 Turbo 调度。
5. E2E 不改断言；GitHub-hosted Linux/Windows 分别使用 4/2 Playwright workers，避免 5 个 Chromium context 同时争用受限 runner。
6. 保存 ripgrep 首轮扫描 fiber。`find()` 若当前已有匹配则保持立即返回；若当前为空则 join 同一个扫描 fiber，再对完整首轮索引查询一次。HttpApi 回归保留原来的 instance 建立顺序，随后单次 `findFile` 必须得到新文件，删除外层轮询 workaround。
7. skill refresh 回归通过 `FSUtil.Service` fresh read/exists 验证原子替换后的磁盘内容，与生产读写边界一致。
8. 两个 shell-loop 用例外层 deadline 从 10 秒改为 30 秒；ACP EOF 内层 deadline 从 5 秒改为 15 秒，成功条件不变。

## 第五部分：正确性论证

- 路径修正保持测试输入与目标文件是同一 Windows path identity，同时仍覆盖 slash 与 case normalization。
- `db path` 修正验证语义契约（memory DB 或 absolute SQLite file），不会把任意字符串误判为合法路径。
- 文件索引修正仍以单次 API 请求实际返回 `hello.txt` 为成功条件，删除测试端轮询 workaround，不削弱结果断言。
- file search fast path 保留逐步索引的低延迟；只有当前查询为空时才等待已经在运行的首轮扫描。扫描完成后再次查询可区分“尚未 ready”和“确实无匹配”，消除瞬时空结果。
- Unit 限流只改变测试调度，不改变测试集合或通过条件；60 分钟 Windows job deadline 足以容纳串行 package task。
- Playwright 限流只改变 worker 数；全部 93 个用例、重试策略和断言保持不变。
- deadline 修正仍要求 shell-loop 完成、两个 caller join 同一结果、ACP 以 code 0 退出；只为已测量的 Windows 进程冷启动保留余量。
- skill refresh 仍断言新内容、旧 reference 删除和下载计数；仅替换观察 API，不降低任何 postcondition。
- 生产代码只改变 legacy ripgrep file-search 的首次空结果 readiness；message-ID chronology 与其他运行路径不改动。

## 第六部分：测试用例清单

| 类型 | 用例描述 | 状态 |
|---|---|---|
| 回归 | Windows path variant 保留盘符并 canonicalize | 已改：`fbff2233c0`；本地文件级回归及首轮 Windows CI 通过 |
| 回归 | `db path` 接受 `:memory:` 与 drive-letter absolute SQLite path | 已改：`fbff2233c0`；本地 CLI smoke 7/7 及首轮 Windows CI 通过 |
| 回归 | File HttpApi 单次请求等待 initial scan 并返回真实文件 | readiness：`cfa91ddecd`；初始化顺序：`ecaf44fc70`；forced-ripgrep 独立进程共 8×2/2 通过，待 Windows CI |
| 复跑 | E2E 不改断言，以较低 worker 数运行完整 suite | 已改：`68c7db55c3`；第三轮 Linux/Windows 均通过，Windows 连续两轮 93/93 |
| 回归 | skill version refresh 通过 fresh FSUtil read 观察替换结果 | 已改：`832d440911`；本地 10/10 通过，待 Windows CI |
| 回归 | shell-loop 与 ACP EOF 在 Windows 冷启动下保持原成功条件 | 已改：`832d440911`；隔离回归 3/3 通过，待 Windows CI |

本地验证从 `packages/opencode` 执行：

- 四个目标测试文件合计 53/53 通过；其中 CLI smoke 因需要临时绑定随机本地端口在沙箱外单独运行。
- package 真实 test script + forced-ripgrep search 2/2 通过；InstanceBootstrap/VCS 16/16、前轮随机失败的 prompt 用例 1/1 通过。
- readiness 与初始化顺序修正后 forced-ripgrep HttpApi 使用八个独立进程均 2/2 通过；Core Ripgrep 2/2 通过。
- skill refresh 重复 10/10 通过；两个 shell-loop 与 ACP EOF 合计 3/3 通过。
- `packages/core` 与 `packages/opencode` 的 `bun typecheck` 均通过。
- `git diff --check` 通过。
- 完整 opencode suite 已尝试，但本机 shared `HttpApi Server.listen` 首先超时，后续 SDK 用例统一收到 503 并级联失败；该运行不计为通过，目标隔离回归与 CI 继续作为判定证据。

## 第七部分：代码更新清单

| 文件 | 改动概述 | 状态 |
|---|---|---|
| `packages/opencode/test/tool/external-directory.test.ts` | 保留 Windows drive letter | 已改：`fbff2233c0` |
| `packages/opencode/test/tool/read.test.ts` | 保留 Windows drive letter | 已改：`fbff2233c0` |
| `packages/opencode/test/cli/smokes/read-only.test.ts` | 按 path 语义验证 DB 输出 | 已改：`fbff2233c0` |
| `packages/opencode/test/lib/effect.ts` | 回退首轮轮询频率 workaround，恢复既有 helper 契约 | 已改：`cfa91ddecd` |
| `packages/opencode/package.json` | 显式 concurrent tests 上限设为 4 | 已改：`68c7db55c3` |
| `.github/workflows/test.yml` | Windows Unit package 串行；E2E worker 按 OS 限流 | 已改：`68c7db55c3` |
| `packages/core/src/filesystem/search.ts` | 空的初始 find 等待首轮 ripgrep scan 后重查 | 已改：`cfa91ddecd` |
| `packages/opencode/test/server/httpapi-file.test.ts` | 保留 instance 建立顺序，以单次 findFile 请求验证 readiness postcondition | 已改：`cfa91ddecd`、`ecaf44fc70` |
| `packages/opencode/test/skill/discovery.test.ts` | 用 FSUtil fresh read 验证 version refresh | 已改：`832d440911` |
| `packages/opencode/test/session/prompt.test.ts` | 两个 shell-loop deadline 调到 30 秒 | 已改：`832d440911` |
| `packages/opencode/test/cli/acp/lifecycle.test.ts` | ACP EOF deadline 调到 15 秒 | 已改：`832d440911` |

## 第八部分：文档更新清单

| 文档 | 要改什么 | 状态 |
|---|---|---|
| `docs/fixes/ci-fix-windows-runner-tests.md` | 记录根因、范围、验证结果与 commit | 已创建并回填五轮实现 commit |

无其他契约文档更新：唯一生产变化是内部首次空 file-search 的 readiness，不改变接口、schema、错误码或持久化不变量。
