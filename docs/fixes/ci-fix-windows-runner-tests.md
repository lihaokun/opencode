# 修正方案 — GitHub-hosted Windows 测试兼容性

- 状态：实现与本地验证已完成；实现 commit `fbff2233c0`，待 Windows CI 验证
- 日期：2026-08-18
- 对应 PR：[#15](https://github.com/lihaokun/opencode/pull/15)
- workflow 路径：`docs/workflow.md` §7 bug-fix flow + §7.1 八部分修正方案
- 修复分类：测试用例与测试同步修正；不改变生产行为、公共接口或数据库 schema

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

## 第二部分：根因分析

- 路径用例把删除盘符误当作大小写和 separator 变体。Windows 的无盘符 rooted path 绑定当前盘；跨 `C:`/`D:` 后已不是同一个文件身份。
- CLI fixture 显式设置隔离的 `OPENCODE_DB`，使 `db path` 合法地返回 drive-letter absolute path；smoke 断言没有覆盖该既有 fixture 分支。
- ripgrep 文件索引通过 scoped fiber 异步填充。测试已经轮询真实查询结果，但 5 秒 deadline 只在更快的上游 runner 上稳定，未覆盖 GitHub-hosted Windows 的冷启动和并发负载。
- E2E 日志包含 Chromium GPU transient failure 和 `browserContext.close()` teardown timeout；同一应用代码已有成功 run，尚不能归类为产品回归或错误断言。

## 第三部分：参考实现对照

本问题不是算法修正，无外部算法参考实现。内部参考为上游 Blacksmith Windows run：失败测试文件与当前 branch blob 相同，但 runner 盘符布局和性能不同。该对照证明路径断言含环境假设，并证明文件搜索实现差异不是本次失败来源。

## 第四部分：修复方案

1. 两个 Windows path-variant 用例保留 drive letter，只改变 separator 和大小写；继续用真实实现验证 canonical permission path。
2. `db path` 用 `path.isAbsolute()` 和允许的 SQLite 扩展名验证文件路径，单独保留 `:memory:` 分支。
3. File HttpApi 用例继续轮询真实 `findFile` 结果，只把该用例的 readiness deadline 提高到 30 秒，并把外层用例 deadline 提高到 60 秒；不修改全局 helper。
4. E2E 原样复跑。只有同一失败可重复且 trace 指向确定同步缺口或产品竞态时，才另行分析和修正。

## 第五部分：正确性论证

- 路径修正保持测试输入与目标文件是同一 Windows path identity，同时仍覆盖 slash 与 case normalization。
- `db path` 修正验证语义契约（memory DB 或 absolute SQLite file），不会把任意字符串误判为合法路径。
- 文件索引修正仍以 `hello.txt` 实际出现在 API 结果中为唯一成功条件，只扩大慢 runner 的最大等待窗口，不削弱结果断言。
- 生产代码和 message-ID chronology 均不改动；Linux 与其他 Windows 行为不受影响。

## 第六部分：测试用例清单

| 类型 | 用例描述 | 状态 |
|---|---|---|
| 回归 | Windows path variant 保留盘符并 canonicalize | 已改：`fbff2233c0`；Linux 文件级回归通过，待 Windows CI 覆盖条件分支 |
| 回归 | `db path` 接受 `:memory:` 与 drive-letter absolute SQLite path | 已改：`fbff2233c0`；CLI smoke 7/7 通过，待 Windows CI |
| 回归 | File HttpApi 等待异步索引发布真实文件 | 已改：`fbff2233c0`；本地通过，待 Windows CI |
| 复跑 | Windows E2E 不改断言原样重跑 | 待 CI 验证 |

本地验证从 `packages/opencode` 执行：

- 四个目标测试文件合计 53/53 通过；其中 CLI smoke 因需要临时绑定随机本地端口在沙箱外单独运行。
- `bun typecheck` 通过。
- `git diff --check` 通过。

## 第七部分：代码更新清单

| 文件 | 改动概述 | 状态 |
|---|---|---|
| `packages/opencode/test/tool/external-directory.test.ts` | 保留 Windows drive letter | 已改：`fbff2233c0` |
| `packages/opencode/test/tool/read.test.ts` | 保留 Windows drive letter | 已改：`fbff2233c0` |
| `packages/opencode/test/cli/smokes/read-only.test.ts` | 按 path 语义验证 DB 输出 | 已改：`fbff2233c0` |
| `packages/opencode/test/server/httpapi-file.test.ts` | 定向扩大索引 readiness deadline | 已改：`fbff2233c0` |

## 第八部分：文档更新清单

| 文档 | 要改什么 | 状态 |
|---|---|---|
| `docs/fixes/ci-fix-windows-runner-tests.md` | 记录根因、范围、验证结果与 commit | 已创建并回填实现 commit |

无契约文档更新：本修复只纠正测试环境假设与同步 deadline，不改变生产行为契约。
