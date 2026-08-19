# Fork 安装说明

本 fork 需要**从源码构建**并自定义版本号(当前为 `1.18.6-fmv3`),因为:

- 官方的 `curl … | bash` 安装脚本和 `npm i -g opencode-ai` 只**下载已发布的预编译版本**,装不出我们 fork 的改动;
- 而且官方版的**自动更新会把我们的自建二进制覆盖掉**(实测 `-fm` 被悄悄换回官方 `1.18.x`)——所以要 (1) 从源码构建、(2) 关掉自动更新。

---

## TL;DR

```bash
# 1) 构建(版本号 + channel 都用环境变量)
bun install                                   # 会应用 patches(如 openai-compatible 修复)
cd packages/opencode
OPENCODE_CHANNEL=dev OPENCODE_VERSION=1.18.6-fmv3 bun run script/build.ts --single

# 2) 安装到 PATH 生效位置(官方安装器/更新器用的就是这里)
install -m 0755 dist/opencode-linux-x64/bin/opencode ~/.opencode/bin/opencode

# 3) 关闭自动更新(二选一,均无需改代码)——见下文
```

验证:`opencode --version` 应显示 `1.18.6-fmv3`。

---

## 1. 版本号:只能用 `OPENCODE_VERSION` 环境变量

版本号由 `packages/script/src/index.ts` 决定,优先级:

1. **`OPENCODE_VERSION` 环境变量** → 逐字采用(我们就用这个:`1.18.6-fmv3`)；
2. 否则是 preview 构建 → `0.0.0-<channel>-<时间戳>`（例：`0.0.0-dev-202608161430`）；
3. 否则(官方发布)→ 从 npm 拉 `opencode-ai/latest` 再 bump。

**注意几个"不行"**:

- ❌ **改 `package.json` 的 `version` 没用** —— 构建逻辑根本不读它(官方 package.json 还写着 `1.18.6`,而实际发布已到 `1.18.x`,就是因为发布版本走 npm+bump)。
- ❌ **加 git tag 也没用** —— 版本逻辑不读任何 tag(`git describe`/`refs/tags` 都没用到)。
- ℹ️ 唯一沾 git 的是**分支名 = channel**（`git branch --show-current`），只影响 preview 版本里的 `<channel>` 段,不是 tag。

所以自定义版本**必须**在构建时传 `OPENCODE_VERSION`。

## 2. Channel:用 `OPENCODE_CHANNEL` 决定数据目录

- `OPENCODE_CHANNEL=dev` → 用 `opencode-dev.db`（与之前的 fork 安装同一份会话/数据）。
- 不设则默认取当前分支名当 channel。
- Channel 与版本号**互不干扰**（一个走 `OPENCODE_CHANNEL`，一个走 `OPENCODE_VERSION`）。

## 3. 安装到哪

`~/.opencode/bin/` 通常在 PATH 最前(官方安装器/自动更新器就装在这),所以装这里最稳:

```bash
# 建议先备份官方二进制再覆盖(可回退)
[ -f ~/.opencode/bin/opencode ] && mv ~/.opencode/bin/opencode ~/.opencode/bin/opencode.official.bak
install -m 0755 dist/opencode-linux-x64/bin/opencode ~/.opencode/bin/opencode
```

如果 `~/.local/bin` 里也有一份 `opencode`,一并刷新，避免 PATH 顺序服务到旧版本。

## 4. 关闭自动更新(无需改代码,二选一)

自动更新的判定在 `upgrade.ts`：`if (config.autoupdate === false || Flag.OPENCODE_DISABLE_AUTOUPDATE) return`。两条都能关，任选其一:

### 方式 A(推荐):全局 config 设 `autoupdate: false`

opencode 会合并加载 `~/.config/opencode/opencode.json` 和 `opencode.jsonc`。把开关写进 **`opencode.json`**(纯 JSON,不碰 `.jsonc` 里的密钥):

```bash
mkdir -p ~/.config/opencode
# 有 jq:
jq '.autoupdate = false' ~/.config/opencode/opencode.json 2>/dev/null > /tmp/oc.json && mv /tmp/oc.json ~/.config/opencode/opencode.json
# 没有 jq、且文件不存在时:
printf '{\n  "$schema": "https://opencode.ai/config.json",\n  "autoupdate": false\n}\n' > ~/.config/opencode/opencode.json
```

`autoupdate` 取值:`false`(完全关) / `"notify"`(只提示不装) / `true`(默认,自动装)。

### 方式 B:运行时环境变量 `OPENCODE_DISABLE_AUTOUPDATE`

写进 shell profile（`~/.bashrc` / `~/.zshrc`）——这是**运行时** env(`Flag` 运行时读 `process.env`,所以这个有效；注意它**不能在编译期烧进二进制**，因为读的是动态下标 `process.env[key]`）：

```bash
echo 'export OPENCODE_DISABLE_AUTOUPDATE=1' >> ~/.bashrc
```

---

## 备注

- 每次改了 fork 代码想重装:重跑第 1、2 步即可（`bun install` 会重新应用 patches）。
- 想换后缀/channel/安装目录,改对应的环境变量即可,无需改脚本。
- 目标平台产物名形如 `opencode-<os>-<arch>`（如 `opencode-linux-x64`、`opencode-darwin-arm64`）。
