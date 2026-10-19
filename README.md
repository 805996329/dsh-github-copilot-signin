# DSH GitHub Copilot Sign-in

在 DSH 会话里完成 GitHub Copilot 登录，**不需要终端**。登录凭据写入 DSH 自己的凭据库，供 `llm-pi-ai` 的 `github-copilot` 提供商使用。

配套插件：[dsh-github-copilot-credits](https://github.com/805996329/dsh-github-copilot-credits) 负责显示 Copilot 用量（剩余 Credits / 已用进度条），它**依赖本插件建立的那条凭据记录**。

## 它做什么

调用 DSH 已经注册好的授权流程（`ctx.authorization`），也就是 pi-ai 自带的 GitHub 设备码登录：

1. 问一次你要登录哪个 GitHub（github.com 或 GitHub Enterprise 域名）；
2. 显示 **验证链接 + 一次性验证码**，你在浏览器里输入；
3. 会话内确认一次，凭据即写入 `$DSH_HOME/.credentials.yaml` 的 `llm-pi-ai/github-copilot` 记录。

之后 pi-ai 会在 token 快过期时**自动续期**，所以这个动作**一次就够**，不需要再登录。

## 安装

```powershell
dsh plugin --profile desktop add 'github:805996329/dsh-github-copilot-signin'
```

或在 DSH 侧边栏 → **Plugins** → **Add plugin** → 粘贴 `github:805996329/dsh-github-copilot-signin` → **Install** → **Enable now**，然后**刷新页面**。

## ⚠️ 第 2 步：配置供应商路由（跳过这步登录必定失败）

全新安装的 DSH 里，`llm-pi-ai` 适配器是挂载着的，但**一条供应商路由都没配置**。而授权流程是**按路由注册**的：路由不存在，登录工具就只会返回 `unavailable`，提示「`github-copilot` 路由未配置」。

所以装完插件后，先加这条路由：

> **设置 → Models → Add model provider → Third-party model provider → 选 `github-copilot` → 保存**，然后**刷新页面**。

想改用配置文件的话，在 profile 的 `cordis.patch.yml` 里给 `llm-pi-ai` 加：

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      github-copilot: {}
```

> **注意 patch 是整行替换，不是合并。** 如果你已经把 `llm-pi-ai` 用于别的供应商，必须把已有的 provider 一并写全，否则会被这一行静默覆盖掉。

## 使用

在会话里对 agent 说：

> 登录 GitHub Copilot

或直接说「连接我的 Copilot 订阅」「Copilot 用不了，帮我登录」之类。agent 会调用 `github_copilot_sign_in` 工具，随后用会话里的提问卡引导你完成。

可用工具：

| 工具 | 作用 |
|---|---|
| `github_copilot_sign_in` | 开始设备码登录；可选参数 `domain` 填 GitHub Enterprise 域名（省略则问你） |
| `github_copilot_sign_out` | 删除本地凭据记录（**不**在 GitHub 侧撤销授权） |

登录成功后，`github-copilot` 的模型就会出现在模型选择器里。

## 前置条件

- DSH `0.2.0-rc.2` 或 `0.2.1-rc.2`（版本不符会在安装时被拒绝，并给出 `dsh plugin allow-version` 豁免命令）。
- 已按上面**第 2 步**配置好 `github-copilot` 供应商路由。profile 里挂着 `llm-pi-ai`（`dsh-base` 默认包含）与 `dsh-authorization`。
- 你的 GitHub 账号有 Copilot 订阅（个人版 / 商业版 / 企业版均可）。没有订阅的话，设备码能走完，但换取 Copilot token 会失败。

## 几个刻意的设计

- **不自己实现 OAuth。** 登录走 pi-ai 的设备码流程（client id、`Copilot-Integration-Id`、API 版本、token 交换、模型目录全部由 pi-ai 维护），所以上游变了这个插件不用跟着改。
- **不自己写凭据。** 由 `ctx.authorization` 的提交契约写入记录：流程没真正落盘就不算成功。
- **不自己画界面。** 授权缝的中性词汇（一条带 url 和 code 的通知，加普通提问）被转译进会话自带的提问卡，所以每个 DSH 界面都能渲染，插件里没有一行浏览器代码。
- **因此它对任何 pi-ai 目录里带登录的提供商都能用**，不只是 GitHub Copilot；目前固定为 `github-copilot`。

## 安全性

- 凭据只写入**你自己**的 `$DSH_HOME/.credentials.yaml`，不经过任何服务器。
- 设备码是一次性的、短时效的；插件不记录也不输出 token 或验证码。
- `github_copilot_sign_out` 只删本地记录。要真正撤销授权，去 https://github.com/settings/applications。

## 兼容性

`peerDependencies` 写作 `^0.2.0-rc.2`，同时覆盖 DSH `0.2.0-rc.2` 与 `0.2.1-rc.2`。安装前 DSH 会做一次 semver 校验，版本不符会被拒绝并给出 `dsh plugin allow-version` 的显式豁免命令。

**升级 DSH 后插件会被移除**：新版运行时对 `peerDependencies` 做严格校验，钉死旧版本的插件会被判为 `incompatible-version` 并从 profile 中摘掉。请安装本版本，或显式豁免。

## 自测

```powershell
node test/install-stubs.mjs   # 在包内 node_modules 放三个 peer 桩（已 gitignore）
node test/selftest.mjs
```

桩只提供插件 import 的几个符号，被测行为全部是插件自己的。测试覆盖：工具注册、三张提问卡的顺序与内容、取消（两张卡各自）、GitHub Enterprise 路径、显式 `domain` 参数、登出、流程提前失败的早退，以及**工具结果是合法 JSON**（含"真实授权记录没有 account 字段"的回归用例）。
