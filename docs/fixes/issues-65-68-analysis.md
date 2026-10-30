# 分析：#65 / #66 / #67 / #68 的现状核实与修复顺序

对四个 issue 的正文、相关源码（`dev@d9d7de31fb`）和仓库当前状态（2026-10-25）逐项核实。本 PR 暂不含代码改动，作为审核基线；结论经确认后按顺序逐项落地，每项走自己的流程（#66/#65 按 `docs/workflow.md` §4 先出设计文档）。

---

## 逐 issue 现状核实（截至 2026-10-25）

### #68 停用上游工作流 — 纯 ops，还没做，且比写 issue 时更急

- `gh workflow list` 确认：**全部 28 个工作流仍是 active**，一个都没停。
- 当前没有排队中的 run（之前排队的已被 GitHub 24h 自动取消），但噪音和故障在持续：
  - `close-issues` **每天失败一次**（脚本写死操作 `anomalyco/opencode`），最近三天（10-23/24/25）连着 fail；
  - `models-snapshot` 定时器每小时跑好几次，全部 skip 刷屏；
  - `compliance-close` **每 ~25 分钟跑一次且成功**——按 issue 的判断它对本仓库生效（带不合规标签超 2h 的 issue/PR 自动关闭），这是个潜伏的误伤源，当前 20+ 个 open issue 都暴露在它下面。
- 方案（`gh workflow disable`，不改文件、不产生上游同步冲突）依然成立。20 停 8 留，清单见 issue 正文。

### #67 插件 SDK 安装 — 未做，独立性强，可先做

- 代码位置核实无误：`config/config.ts`、`config/tui.ts` 每次启动无条件 `npm install @opencode-ai/plugin@<InstallationVersion>`，fork 版本号（如 `1.18.31-fmv3-beta.17`）npm 上不存在 → 每次启动必失败（本机日志已 137 条）。
- 方案 1+2（钉 `packages/plugin/package.json` 的自身版本 + 有插件文件才装 + 版本一致不重复装）不依赖其他 issue，独立可交付。
- 方案 4（借用的目录不碰）依赖 #66 的"借用目录"概念，**这条跟 #66 一起落**。
- 已知的次生风险：方案 1 落地后安装会**成功**，如果同一台机器还跑官方版，两边会在同一个 `package.json` 里来回钉版本。在 #66 落地前这个窗口期存在，但只是启动时多一次 npm install 的抖动，不破坏东西。

### #66 改名 oc-fm — 未做，最大的一个，是 #65 的前置

- 触点核实无误：`core/src/global.ts:10` 的 `const app = "opencode"`、`database.ts` 的渠道后缀库名（fork 构建是 `OPENCODE_CHANNEL=dev` → `opencode-dev.db`）、`installation/index.ts:175-176` 的 `.opencode/bin` / `.local/bin` 识别、`uninstall.ts`、`script/build.ts` 资产名、flag 模块 33 个环境变量。
- 二选一读取规则（配置/凭据/项目级，写入跟着读取走）issue 里已经定得很细。
- 前置条件已满足：`v1.18.31-fmv2.1` 已于 2026-10-14 发布。
- 设计阶段（§4）要补的：Windows/macOS 路径表、env 前缀切换对 Flag 模块的具体改法、mDNS 服务名。

### #65 自动更新绑定 fork release — 未做，依赖 #66

- 危害确认：curl 安装路径 `latest()` 查上游 `anomalyco/opencode`（`installation/index.ts:258`），`upgradeCurl` 跑 `opencode.ai/install` 脚本——开着自动更新会**把 fork 换回官方版**，所以现在 release note 只能要求 `"autoupdate": false`。
- spec 已完整：双渠道不交叉（beta 只跟 beta，正式只跟正式）、自写比较器（semver 顺序在 `fmv2.2-beta.1` vs `fmv2.2`、`fmv9` vs `fmv10` 上都会错）、进程内替换 + `sha256sums.txt` 校验 + 原子 rename、基线变化只提示、绝不降级。
- 依赖 #66 的原因：升级要替换 `dirname(process.execPath)` 下的二进制和 `rg`，安装目录改名后这套逻辑的目标路径跟着变——先做 #65 等于做两遍。
- 设计阶段要新解决的：GitHub API 匿名限额（每次 TUI 启动查一次，60/hr/IP，需要 state 里做 TTL 缓存）；beta 渠道取 `GET /releases` 过滤 pre-release + 命名模式（`/releases/latest` 天然排除 pre-release，正式渠道免费得到正确语义）。

---

## 依赖关系与建议顺序

```
#68（ops，30 分钟，先做）
  ↓ 无依赖
#67 方案 1+2（小，~1 天，每次启动都受益）
  ↓ （方案 4 留给 #66）
#66 步骤 1（大，先出设计文档 §4）
  ↓
#65（大，先出设计文档 §4，复用 #66 的新安装目录/二进制名）
```

理由：

1. **#68 最先**：零代码、零冲突风险，立刻消掉每日失败、刷屏和 compliance-close 的误伤风险。
2. **#67 在 #66 前**：小而独立，用户每次启动都在付它的成本（137 条失败日志 + 无谓的 npm 进程）。它动的 `config.ts`/`tui.ts` 正好是 #66 也要动的文件，但改动点小，顺序演进可接受。唯一代价是上面说的双版本互钉窗口期。
3. **#66 → #65 严格有序**：#65 的升级目标路径（安装目录、二进制名、`rg` 同目录替换）全部压在 #66 的产出上。

## 待拍板

1. 顺序认可吗？还是把 #67 挪到 #66 之后（彻底避免互钉窗口期，代价是 #66 之前每次启动继续白跑 npm）？
2. #68 若认可，本分支即可执行：按 issue 清单 `gh workflow disable` 那 20 个（当前无排队 run 可取消），停用清单和理由写进 FORK_INSTALL.md。
3. #66 步骤 1 和 #65 都要走 `docs/workflow.md` §4（调研 → 架构 → 细化 → 确认）。建议 #66 先开设计。
