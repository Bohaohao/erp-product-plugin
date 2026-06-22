<a id="zh"></a>

<p align="right">
  <a href="#zh"><kbd>中文</kbd></a>
  <a href="#en"><kbd>English</kbd></a>
</p>

# ERP Product Codex Plugin

ERP Product Codex Plugin 是 ERP 商品 MCP 的 Codex 插件 marketplace 仓库。

它不包含 Product MCP 源码，而是负责把 Product MCP 以 Codex 插件的形式安装、启用和启动起来。插件启动后会先启动一个稳定的 Runtime Launcher（运行时启动器），由 launcher 拉取、选择并启动最新 Runtime Proxy（运行时代理）。Runtime Proxy 再准备、更新和管理 Product MCP 子运行时，通过 Chrome 登录态桥接用户 token，并把 `product_*` MCP tools 暴露给 Codex。

## 给 AI Agent 的快速契约

如果你是 AI Agent，请优先遵守本节。

### 你应该做什么

- 先确认当前 Codex thread 已启用 `ERP Product` 插件。
- 第一步调用 `product_runtime_self_check`，它不会读取 Chrome 或 token，会自动刷新 Product MCP、同步 bridge 配置、确认实际生效的 `projectUrl` 和 `matchUrlPrefixes`。
- `product_runtime_self_check` 通过后，再调用 `product_auth_status`；它会预检并自动预热 `chrome-devtools-mcp`，再检查 Chrome ERP 登录态是否可用。
- 只有当 `product_auth_status` 返回 `CHROME_REMOTE_DEBUGGING_NOT_ALLOWED` 时，才按返回步骤提示用户在 Chrome 打开 `chrome://inspect/#remote-debugging` 并勾选 “Allow remote debugging for this browser instance”；完成后重新调用 `product_auth_status`。
- 如果底层错误包含 `Could not find DevToolsActivePort`，不要提示用户等待弹窗，应优先提示用户进入 `chrome://inspect/#remote-debugging` 开启允许项。
- 不要要求用户粘贴 `Admin-Token`，插件会通过本地 bridge 从 Chrome 读取登录态。
- 处理本地商品资料包时，调用 `product_precheck_package`。
- 上传本地文件时，调用 `product_upload_file`，不要把本地路径直接交给远程 HTTP MCP。
- 调用 `product_upload_file` 时保留 `product_precheck_package` 返回的 `dedupeKey/sourceRelativePath/sourceLocalPath`，重复文件会复用第一次上传得到的 OSS URL。
- 图片、视频、PDF、3D 文件等只通过本地 `product_upload_file` 直传 OSS；创建商品时只传 OSS URL 和业务字段。Product MCP bridge `0.1.7` 起会由本地 bridge 直连 ERP 后端提交创建请求，避免远端 MCP 网关 `Payload Too Large`。
- 查询分类、单位、供应商、区域、字典等后端 ID 时，优先调用只读查询工具，不要要求用户手填 ID。
- 如需确认当前 Product MCP 运行时代码、缓存来源、热刷新状态或配置是否生效，优先调用 `product_runtime_self_check`；低层诊断才使用 `product_runtime_status` / `product_runtime_refresh`。
- 运行时版本、配置 hash、实际 `projectUrl`、`matchUrlPrefixes` 是否生效，必须由 AI Agent 调用工具自检并给出结论；不要要求用户检查版本、hash、配置文件、终端输出或 MCP 状态字段。
- 创建商品前，先向用户总结即将写入的信息，并取得明确确认。
- 只有用户确认后才调用 `product_create`，并传入 `confirm: true`。

### 你不应该做什么

- 不要让用户复制、粘贴或暴露 ERP token。
- 不要在登录态不可用时继续创建商品。
- 不要在用户未确认时调用写入工具。
- 不要把本地路径、文件内容或 base64 大文件传给远程 HTTP MCP 或 `product_create`。如果 `product_create` 返回 `Payload Too Large`，先调用 `product_runtime_self_check` 更新 Product MCP，不要写临时脚本绕过 MCP。
- 不要把更新是否生效的验证责任交给用户；只有登录 ERP、刷新页面、允许 Chrome 调试、重连/重启 Codex 这类必须由用户在本机 UI 完成的动作，才需要明确提示用户。
- 不要修改本仓库的 marketplace 结构来改变 Product MCP 拉取逻辑；拉取逻辑在启动脚本中维护。

## 这个仓库做什么

| 模块 | 说明 |
| --- | --- |
| `.agents/plugins/marketplace.json` | Codex marketplace 入口，指向本仓库内的 `erp-product` 插件 |
| `plugins/erp-product/.codex-plugin/plugin.json` | Codex 插件 manifest |
| `plugins/erp-product/.mcp.json` | 声明插件提供的 MCP stdio server，并固定 `cwd: "."`，避免 Codex 从当前项目目录解析相对启动脚本 |
| `plugins/erp-product/scripts/start-product-token-bridge.mjs` | 稳定 Runtime Launcher，负责拉取、选择、启动和必要时重启插件 Runtime Proxy |
| `plugins/erp-product/runtime/product-runtime-proxy.mjs` | Runtime Proxy，负责准备、刷新和管理 Product MCP 子运行时，并暴露业务工具 |
| `plugins/erp-product/config/product-token-bridge.config.json` | 本地 bridge 的默认 ERP、远程 MCP 和 token 配置 |
| `plugins/erp-product/skills/product-management/SKILL.md` | 给 Codex/AI Agent 的 ERP 商品操作说明 |

## Product MCP 解析策略

插件运行时会按以下顺序解析 Product MCP：

1. 使用固定 Git 地址拉取或更新 Product MCP：
   `https://github.com/Bohaohao/product-mcp.git`
2. 默认缓存目录：
   `~/.erp-product/product-mcp`
3. 代理启动时会尝试 `git fetch --prune origin` 和 `git pull --ff-only origin master`。
4. 如果 Git fetch 或 pull 失败，并且本 marketplace 仓库同级目录下存在 `product-mcp`，优先降级使用这个同级仓库。
5. 如果没有可用同级仓库，但缓存目录中已经有可用 Product MCP checkout，则继续使用已有缓存。
6. 如果 Product MCP 是新拉取的、刚更新过的，或缺少 `dist/localBridge.js`，插件会自动执行 `npm ci` 和 `npm run build`。
7. 插件会把随插件发布的 bridge 配置同步到稳定用户目录：`~/.erp-product/product-token-bridge.config.json`，并把该稳定配置传给 Product MCP 子运行时。
8. 代理运行期间会按短间隔检查 Product MCP 是否更新，也会检查 bridge 配置 hash 是否变化；可以通过 `product_runtime_refresh` 主动检查、构建并只重启 Product MCP 子运行时。

这个策略保证在线用户默认使用最新 Product MCP；离线、代理异常或 Git 不可用时，开发/本地安装场景优先使用同级仓库，普通用户再复用已有缓存。

## 更新模型

普通用户不需要，也不应该通过命令行执行 `codex plugin marketplace upgrade ...` 来更新 `erp-product-marketplace`。

用户侧更新规则：

- Product MCP 运行时更新：用户保留当前 thread 上下文。`0.2.0` 起，Codex 连接的是插件内 MCP 代理，代理可以在当前 MCP 连接中拉取、构建并重启 Product MCP 子运行时，不需要新建 thread。默认会按间隔检查；需要立即刷新时调用 `product_runtime_refresh`。
- 插件 Runtime Proxy 更新：`0.3.0` 起，Codex 连接的是稳定 Runtime Launcher。Launcher 会从固定 Git 地址拉取最新插件运行时到 `~/.erp-product/erp-product-plugin-runtime`，失败时降级为已有缓存或随插件发布的内置运行时。普通业务调用只记录待重启，不会为了应用插件运行时更新而打断当前 token 缓存；需要立即应用时调用 `product_runtime_self_check` 或低层工具 `product_runtime_launcher_refresh`。
- MCP 启动目录修复：`0.3.1` 起，`.mcp.json` 显式配置 `cwd: "."`，确保 `./scripts/start-product-token-bridge.mjs` 始终相对插件目录解析，而不是相对当前项目目录解析。
- Bridge 配置更新：`0.2.7` 起，代理会同步插件内配置到 `~/.erp-product/product-token-bridge.config.json`。如果配置 hash 变化，`product_runtime_refresh` 会只重启 Product MCP 子运行时，让同一 thread 重新加载新的 `projectUrl`、`matchUrlPrefixes` 和环境配置。
- 运行时自检：`0.2.9` 起，AI Agent 使用 `product_runtime_self_check` 作为统一验收入口；该工具会自动刷新运行时、同步配置、读取子运行时的实际配置，并返回是否生效的结论。
- 更新后验收：AI Agent 应调用 `product_runtime_self_check` 自行确认运行时和配置是否生效；通过后再调用 `product_auth_status` 检查登录态。不要要求普通用户读取 hash、判断版本、运行命令或自行验证 MCP 状态。
- 不要把 `product_runtime_refresh` 当成每次查询、上传或创建前的固定步骤；子运行时重启会清空进程内 token 缓存和 Chrome DevTools MCP 连接，下一次读取 token 可能再次触发 Chrome。
- 首次从旧版 `0.1.x` 升级到 `0.2.0` 代理版时，已经运行中的旧 MCP 进程不能被新代码隔空替换。用户只需要让插件/MCP 重新连接一次，并回到同一个 thread，不要丢弃原 thread 的业务上下文。
- ERP Product 插件壳更新：由发布者提升 `.codex-plugin/plugin.json` 中的插件版本并发布 marketplace。用户只需要在 Codex 插件界面按产品提示更新、重新安装或重新启用插件。
- 命令行 `marketplace upgrade` 只用于开发者维护、排障或临时验证，不写入普通用户 SOP。
- 不要把“新建 thread”作为更新要求。旧 thread 里的商品解析、字段映射、用户确认和业务上下文必须保留。

如果用户同时安装过旧的个人插件和新的 marketplace 插件，应在 Codex 插件界面保留 marketplace 版本，停用旧个人插件，避免同名 `erp-product` 插件指向旧的内嵌 Product MCP。

## 架构

```text
Codex Plugin Marketplace
  -> erp-product plugin
    -> .mcp.json
      -> scripts/start-product-token-bridge.mjs
        -> Runtime Launcher, stable Codex MCP connection
          -> ~/.erp-product/erp-product-plugin-runtime, fixed Git checkout
          -> bundled runtime fallback
          -> Runtime Proxy
            -> ~/.erp-product/product-token-bridge.config.json, stable bridge config copy
            -> ~/.erp-product/product-mcp, fixed Git checkout
            -> ~/.erp-product/product-mcp, cached fallback
            -> sibling ../product-mcp, final fallback
            -> Product MCP localBridge.js child runtime
              -> Chrome DevTools MCP
              -> Remote Product MCP HTTP /mcp
```

## 安装

### 方式一：从 Git marketplace 安装

当本仓库发布到远程 Git 仓库后，使用：

```powershell
codex plugin marketplace add https://github.com/Bohaohao/erp-product-plugin.git --ref master
```

然后在 Codex 中安装或启用 `ERP Product` 插件。新用户可以从新 thread 开始；已有业务上下文的用户应继续使用原 thread。

### 方式二：本地开发安装

```powershell
codex plugin marketplace add D:\project\erp-product-plugin
```

本地开发时，如需测试 Git 失败后的回退路径，可以把两个仓库放在同级目录：

```text
parent/
  erp-product-plugin/
  product-mcp/
```

同级 `product-mcp` 会在固定 Git 拉取或更新失败时优先作为 fallback 使用。

## 用户使用流程

1. 打开 Chrome。
2. 登录 ERP 系统。
3. 保留一个匹配配置 URL 前缀的 ERP 页面。
4. 在 Codex 中启用 `ERP Product` 插件。新任务可以新建 thread，已有任务继续使用原 thread。
5. 先让 Codex 自检 Product MCP 运行时并检查登录态：

```text
检查 ERP Product MCP 运行时和登录状态。
```

6. 然后开始商品资料包预检、文件上传、商品创建等工作：

```text
预检这个 ERP 商品资料包：D:\path\to\package
```

## 运行时行为

插件启动时会执行以下动作：

1. 启动稳定 Runtime Launcher，保持 Codex MCP 入口不变。
2. Launcher 尝试从固定 Git 仓库更新插件 Runtime Proxy，失败时降级为已有缓存或内置 runtime。
3. Runtime Proxy 准备 Product MCP checkout。
4. Runtime Proxy 尝试更新 Product MCP 到固定 Git 仓库的最新 `master`。
5. 必要时安装 Product MCP 依赖并构建。
6. 将 `dist/localBridge.js` 作为子 MCP 运行时启动。
7. 对 Codex 暴露 Product MCP 的业务工具、Runtime Proxy 工具 `product_runtime_self_check` / `product_runtime_status` / `product_runtime_refresh`，以及低层 Launcher 工具 `product_runtime_launcher_status` / `product_runtime_launcher_refresh`。

业务工具运行时会：

1. 通过 bridge 从 Chrome ERP 页面读取或复用短期缓存的 `localStorage.Admin-Token`。
2. 将请求转发给远程 Product MCP。
3. 如遇 401/403，Product MCP 本地 bridge 会失效 token 缓存并重新读取一次。

Launcher 运行期间会按间隔检查插件 Runtime Proxy Git 更新；普通业务调用只记录待应用更新，不会为了热更新打断当前流程。Runtime Proxy 运行期间会按间隔检查 Product MCP Git 更新；如果发现 Product MCP checkout 或 bridge 配置变化，会按规则重启子运行时并通知工具列表变化。`product_runtime_self_check` 会先让 Launcher 应用插件运行时更新，再由 Runtime Proxy 执行自检/自愈，并读取子运行时的 `product_bridge_config_status` 来确认实际生效配置。

插件不会让用户手动复制 token，也不会把 token 打印给 AI Agent。

## 配置

默认 bridge 配置文件：

```text
plugins/erp-product/config/product-token-bridge.config.json
```

关键字段：

```json
{
  "environment": "stage",
  "environments": {
    "stage": {
      "projectUrl": "https://test.eysscm.com/erp/commodity/commodity",
      "matchUrlPrefixes": ["https://test.eysscm.com/erp/"],
      "backendBaseUrl": "https://test.eysscm.com/api"
    },
    "prod": {
      "projectUrl": "https://eysscm.com/erp/commodity/commodity",
      "matchUrlPrefixes": ["https://eysscm.com/erp/", "https://www.eysscm.com/erp/"],
      "backendBaseUrl": "https://eysscm.com/api"
    }
  },
  "tokenStorageKey": "Admin-Token",
  "remoteMcpUrl": "http://47.95.237.95:8787/mcp",
  "clientId": "e5cd7e4891bf95d1d19206ce24a7b32e",
  "language": "zh_CN"
}
```

如需切换 ERP 环境，优先把 `environment` 改为 `stage` 或 `prod`，也可以在启动 bridge 前设置 `PRODUCT_MCP_ENV=prod`。不要修改 marketplace JSON。

## 本地验证

校验插件结构：

```powershell
python C:\Users\Administrator\.codex\skills\.system\plugin-creator\scripts\validate_plugin.py D:\project\erp-product-plugin\plugins\erp-product
```

校验启动脚本语法：

```powershell
node --check D:\project\erp-product-plugin\plugins\erp-product\scripts\start-product-token-bridge.mjs
node --check D:\project\erp-product-plugin\plugins\erp-product\runtime\product-runtime-proxy.mjs
```

手动准备 fallback Product MCP：

```powershell
cd D:\project\product-mcp
npm ci
npm run build
npm run smoke
```

## 排错

### Git 拉取 Product MCP 失败

可能原因：

- 当前网络无法访问 GitHub。
- 代理未开启或未被 Git 使用。
- Git 未安装或不可用。
- 本地缓存目录不是合法 Git checkout。

处理方式：

- 如果同级目录存在 `product-mcp`，插件会优先降级到同级仓库，避免继续使用脏的旧缓存。
- 如果没有可用同级仓库，插件会复用 `~/.erp-product/product-mcp` 中已有的缓存 checkout。
- 如果需要离线首装，请提前把 `product-mcp` clone 到 `erp-product-plugin` 同级目录。

### 未获取到 Chrome token

可能原因：

- Chrome 未打开。
- ERP 页面未登录。
- 当前 ERP 页面 URL 不匹配 `matchUrlPrefixes`。
- 目标环境 token key 不是 `Admin-Token`。

推荐提示用户：

```text
请打开 Chrome 并登录 ERP 系统，保留一个匹配配置 URL 前缀的 ERP 页面，刷新页面后重新调用 product_auth_status。
```

### MCP tools 没有出现

检查项：

- Codex thread 是否启用了 `ERP Product` 插件。
- marketplace 是否已添加并安装。
- `.mcp.json` 是否仍指向 `./scripts/start-product-token-bridge.mjs`，并包含 `cwd: "."`。
- 启动脚本是否能找到 Node.js、Git 和 Product MCP。

## 与 Product MCP 仓库的关系

推荐保持两个仓库分离：

```text
product-mcp          # MCP server、local bridge、工具实现
erp-product-plugin   # Codex plugin marketplace wrapper
```

本仓库只负责插件安装、插件说明、MCP server 启动入口和 marketplace 分发。Product MCP 的业务工具、远程 MCP server 和本地 bridge 实现在 `product-mcp` 仓库中维护。

---

<a id="en"></a>

<p align="right">
  <a href="#zh"><kbd>中文</kbd></a>
  <a href="#en"><kbd>English</kbd></a>
</p>

# ERP Product Codex Plugin

ERP Product Codex Plugin is the Codex plugin marketplace repository for ERP Product MCP.

It does not contain the Product MCP source code. Instead, it installs, enables, and starts Product MCP as a Codex plugin. When enabled, the plugin starts a stable Runtime Launcher. The launcher fetches, selects, and starts the latest Runtime Proxy. The Runtime Proxy prepares, updates, and manages the Product MCP child runtime, bridges the user's Chrome ERP login token, and exposes the `product_*` MCP tools to Codex.

## Quick Contract For AI Agents

If you are an AI Agent, read this section first.

### What You Should Do

- Confirm that the current Codex thread has the `ERP Product` plugin enabled.
- Call `product_runtime_self_check` first. It does not read Chrome or token; it refreshes Product MCP, syncs bridge config, and verifies the effective `projectUrl` and `matchUrlPrefixes`.
- After `product_runtime_self_check` passes, call `product_auth_status`. It preflights and warms `chrome-devtools-mcp`, then checks whether Chrome ERP login state is available.
- Only when `product_auth_status` returns `CHROME_REMOTE_DEBUGGING_NOT_ALLOWED`, stop the task, tell the user to open `chrome://inspect/#remote-debugging` in Chrome and enable "Allow remote debugging for this browser instance", then call `product_auth_status` again after the user completes those steps.
- If the underlying error contains `Could not find DevToolsActivePort`, do not tell the user to wait for a popup; prioritize the `chrome://inspect/#remote-debugging` setting.
- Do not ask the user to paste `Admin-Token`; the plugin reads login state from Chrome through the local bridge.
- For local product packages, call `product_precheck_package`.
- For local file uploads, call `product_upload_file`; do not pass local paths directly to the remote HTTP MCP.
- Preserve `dedupeKey/sourceRelativePath/sourceLocalPath` from `product_precheck_package` when calling `product_upload_file`; repeated files reuse the first OSS URL.
- Upload images, videos, PDFs, 3D files, and other local files only through local `product_upload_file`; pass only OSS URLs and business fields when creating a product. Starting with Product MCP bridge `0.1.7`, the local bridge submits creation directly to the ERP backend, avoiding remote MCP gateway `Payload Too Large` limits.
- Use read-only lookup tools to resolve category, unit, supplier, region, and dictionary IDs. Do not ask the user to manually fill backend IDs.
- To inspect the current Product MCP runtime code, cache source, hot-refresh state, or effective config, prefer `product_runtime_self_check`; use `product_runtime_status` / `product_runtime_refresh` only for lower-level diagnostics.
- The AI Agent must self-check whether the runtime version, config hashes, effective `projectUrl`, and `matchUrlPrefixes` are active by calling tools and reporting the conclusion. Do not ask the user to inspect versions, hashes, config files, terminal output, or MCP status fields.
- Before creating a product, summarize the fields that will be written and ask the user for explicit confirmation.
- Call `product_create` only after confirmation, and pass `confirm: true`.

### What You Should Not Do

- Do not ask the user to copy, paste, or reveal the ERP token.
- Do not continue product creation when login state is unavailable.
- Do not call write tools before the user confirms.
- Do not send local paths, file bytes, or large base64 payloads to the remote HTTP MCP or `product_create`. If `product_create` returns `Payload Too Large`, call `product_runtime_self_check` to update Product MCP first; do not write a temporary script to bypass MCP.
- Do not put update verification on the user. Ask for user action only when the action requires their local UI or credentials, such as logging in to ERP, refreshing the page, allowing Chrome remote debugging, or reconnecting/restarting Codex.
- Do not change marketplace structure to change Product MCP fetching behavior; that behavior belongs in the launcher script.

## What This Repository Does

| Module | Description |
| --- | --- |
| `.agents/plugins/marketplace.json` | Codex marketplace entry that points to the local `erp-product` plugin |
| `plugins/erp-product/.codex-plugin/plugin.json` | Codex plugin manifest |
| `plugins/erp-product/.mcp.json` | Declares the MCP stdio server provided by this plugin, with `cwd: "."` so relative startup scripts are resolved from the plugin directory |
| `plugins/erp-product/scripts/start-product-token-bridge.mjs` | Stable Runtime Launcher that fetches, selects, starts, and when needed restarts the plugin Runtime Proxy |
| `plugins/erp-product/runtime/product-runtime-proxy.mjs` | Runtime Proxy that prepares, refreshes, and manages the Product MCP child runtime and exposes business tools |
| `plugins/erp-product/config/product-token-bridge.config.json` | Default ERP, remote MCP, and token bridge config |
| `plugins/erp-product/skills/product-management/SKILL.md` | ERP product workflow instructions for Codex and AI Agents |

## Product MCP Resolution Strategy

At runtime, the plugin resolves Product MCP in this order:

1. Clone or update Product MCP from the fixed Git URL:
   `https://github.com/Bohaohao/product-mcp.git`
2. Use the default cache directory:
   `~/.erp-product/product-mcp`
3. On proxy startup, try `git fetch --prune origin` and `git pull --ff-only origin master`.
4. If Git fetch or pull fails and a sibling `product-mcp` directory exists next to this marketplace repository, fall back to that sibling checkout first.
5. If no usable sibling checkout exists but the cache directory already contains a usable Product MCP checkout, keep using that cached checkout.
6. If Product MCP is newly cloned, updated, or missing `dist/localBridge.js`, the plugin runs `npm ci` and `npm run build`.
7. The plugin syncs the bundled bridge config to a stable user path: `~/.erp-product/product-token-bridge.config.json`, and passes that stable config to the Product MCP child runtime.
8. While the proxy is running, it checks Product MCP for updates and bridge config hash changes on a short interval. `product_runtime_refresh` can force a check, rebuild if needed, and restart only the Product MCP child runtime.

This keeps online users on the latest Product MCP while still allowing local/development users to prefer a sibling checkout when Git sync fails, with the existing cache as the final offline fallback.

## Update Model

End users do not need to, and should not, run `codex plugin marketplace upgrade ...` from the command line to update `erp-product-marketplace`.

User-facing update rules:

- Product MCP runtime updates: the user keeps the current thread context. Starting in `0.2.0`, Codex connects to the plugin MCP proxy, and the proxy can pull, build, and restart the Product MCP child runtime within the current MCP connection. A new thread is not required. Automatic checks run on an interval; call `product_runtime_refresh` when an immediate refresh is needed.
- Plugin Runtime Proxy updates: starting in `0.3.0`, Codex connects to the stable Runtime Launcher. The launcher pulls the latest plugin runtime into `~/.erp-product/erp-product-plugin-runtime` from the fixed Git URL, and falls back to the existing cache or bundled runtime when Git sync fails. Routine business calls record a pending restart instead of interrupting the current token cache; call `product_runtime_self_check` or the lower-level `product_runtime_launcher_refresh` when the update must be applied immediately.
- MCP working-directory fix: starting in `0.3.1`, `.mcp.json` explicitly sets `cwd: "."` so `./scripts/start-product-token-bridge.mjs` is always resolved relative to the plugin directory, not the current project directory.
- Bridge config updates: starting in `0.2.7`, the proxy syncs the plugin config to `~/.erp-product/product-token-bridge.config.json`. If the config hash changes, `product_runtime_refresh` restarts only the Product MCP child runtime so the same thread reloads the latest `projectUrl`, `matchUrlPrefixes`, and environment config.
- Runtime self-check: starting in `0.2.9`, AI Agents use `product_runtime_self_check` as the single acceptance entry point. The tool refreshes the runtime, syncs config, reads the child runtime's effective config, and returns the conclusion.
- Post-update acceptance: the AI Agent should call `product_runtime_self_check` to confirm the runtime and config are active, then call `product_auth_status` for login state. Do not ask ordinary users to read hashes, judge versions, run commands, or verify MCP status themselves.
- Do not use `product_runtime_refresh` as a fixed step before every lookup, upload, or create action. Restarting the child runtime clears the in-process token cache and Chrome DevTools MCP connection, so the next token read may need Chrome again.
- When upgrading from an already-running `0.1.x` process to the `0.2.0` proxy, the old process cannot be replaced retroactively by code it has not loaded. The user only needs to reconnect the plugin/MCP and return to the same thread. Do not discard the original business context.
- ERP Product plugin wrapper updates: the publisher bumps the version in `.codex-plugin/plugin.json` and publishes the marketplace. The user updates, reinstalls, or re-enables the plugin through the Codex plugin UI when the product prompts them to do so.
- The command-line `marketplace upgrade` path is for developer maintenance, troubleshooting, and temporary verification only. It is not part of the normal user SOP.
- Do not make "start a new thread" an update requirement. Product parsing, field mapping, user confirmations, and business context in the old thread must be preserved.

If the user has both an old personal plugin and the new marketplace plugin installed, keep the marketplace version enabled in the Codex plugin UI and disable the old personal plugin so the same `erp-product` plugin name does not point to an old bundled Product MCP.

## Architecture

```text
Codex Plugin Marketplace
  -> erp-product plugin
    -> .mcp.json
      -> scripts/start-product-token-bridge.mjs
        -> Runtime Launcher, stable Codex MCP connection
          -> ~/.erp-product/erp-product-plugin-runtime, fixed Git checkout
          -> bundled runtime fallback
          -> Runtime Proxy
            -> ~/.erp-product/product-token-bridge.config.json, stable bridge config copy
            -> ~/.erp-product/product-mcp, fixed Git checkout
            -> ~/.erp-product/product-mcp, cached fallback
            -> sibling ../product-mcp, final fallback
            -> Product MCP localBridge.js child runtime
              -> Chrome DevTools MCP
              -> Remote Product MCP HTTP /mcp
```

## Installation

### Option 1: Install From A Git Marketplace

After this repository is published to a remote Git repository, use:

```powershell
codex plugin marketplace add https://github.com/Bohaohao/erp-product-plugin.git --ref master
```

Then install or enable the `ERP Product` plugin in Codex. New users can start in a new thread; users with existing business context should keep using the original thread.

### Option 2: Local Development Install

```powershell
codex plugin marketplace add D:\project\erp-product-plugin
```

For local development or Git fallback testing, keep both repositories side by side:

```text
parent/
  erp-product-plugin/
  product-mcp/
```

The sibling `product-mcp` checkout is used only when the fixed Git clone or update fails and no usable cache exists.

## User Flow

1. Open Chrome.
2. Log in to the ERP system.
3. Keep an ERP page whose URL matches the configured prefix.
4. Enable the `ERP Product` plugin in Codex. New tasks may use a new thread; existing tasks should continue in the original thread.
5. Ask Codex to self-check Product MCP runtime and login state first:

```text
Check ERP Product MCP runtime and login status.
```

6. Then continue with product package precheck, file upload, and product creation:

```text
Precheck this ERP product package: D:\path\to\package
```

## Runtime Behavior

On startup, the plugin:

1. Starts the stable Runtime Launcher so the Codex MCP entry remains unchanged.
2. The launcher tries to update the plugin Runtime Proxy from the fixed Git repository, falling back to the existing cache or bundled runtime when needed.
3. The Runtime Proxy prepares the Product MCP checkout.
4. The Runtime Proxy tries to update Product MCP to the latest `master` from the fixed Git repository.
5. Installs Product MCP dependencies and builds when needed.
6. Starts `dist/localBridge.js` as a child MCP runtime.
7. Exposes Product MCP business tools, Runtime Proxy tools `product_runtime_self_check` / `product_runtime_status` / `product_runtime_refresh`, and lower-level Launcher tools `product_runtime_launcher_status` / `product_runtime_launcher_refresh`.

When business tools run, the Product MCP bridge:

1. Reads or reuses a short-lived cached `localStorage.Admin-Token` from a Chrome ERP page.
2. Forwards requests to the remote Product MCP.
3. Invalidates the token cache and reads it once again on 401/403.

While the Launcher is running, it periodically checks for plugin Runtime Proxy Git updates. Routine business calls record pending runtime updates instead of interrupting the active workflow. While the Runtime Proxy is running, it periodically checks for Product MCP Git updates. If the checkout or bridge config changes, it restarts the child runtime according to the proxy rules and notifies Codex that the tool list changed. `product_runtime_self_check` first lets the Launcher apply plugin runtime updates, then lets the Runtime Proxy perform self-check/self-heal and read the child runtime's `product_bridge_config_status` to confirm the effective config.

The plugin never asks the user to manually copy a token and never prints the token to the AI Agent.

## Configuration

Default bridge config file:

```text
plugins/erp-product/config/product-token-bridge.config.json
```

Important fields:

```json
{
  "environment": "stage",
  "environments": {
    "stage": {
      "projectUrl": "https://test.eysscm.com/erp/commodity/commodity",
      "matchUrlPrefixes": ["https://test.eysscm.com/erp/"],
      "backendBaseUrl": "https://test.eysscm.com/api"
    },
    "prod": {
      "projectUrl": "https://eysscm.com/erp/commodity/commodity",
      "matchUrlPrefixes": ["https://eysscm.com/erp/", "https://www.eysscm.com/erp/"],
      "backendBaseUrl": "https://eysscm.com/api"
    }
  },
  "tokenStorageKey": "Admin-Token",
  "remoteMcpUrl": "http://47.95.237.95:8787/mcp",
  "clientId": "e5cd7e4891bf95d1d19206ce24a7b32e",
  "language": "zh_CN"
}
```

To switch ERP environments, set `environment` to `stage` or `prod`, or start the bridge with `PRODUCT_MCP_ENV=prod`. Do not change marketplace JSON.

## Local Verification

Validate plugin structure:

```powershell
python C:\Users\Administrator\.codex\skills\.system\plugin-creator\scripts\validate_plugin.py D:\project\erp-product-plugin\plugins\erp-product
```

Check launcher syntax:

```powershell
node --check D:\project\erp-product-plugin\plugins\erp-product\scripts\start-product-token-bridge.mjs
node --check D:\project\erp-product-plugin\plugins\erp-product\runtime\product-runtime-proxy.mjs
```

Prepare fallback Product MCP manually:

```powershell
cd D:\project\product-mcp
npm ci
npm run build
npm run smoke
```

## Troubleshooting

### Product MCP Git Sync Fails

Likely causes:

- The current network cannot access GitHub.
- Proxy is not enabled or Git is not using it.
- Git is not installed or unavailable.
- The local cache directory is not a valid Git checkout.

What to do:

- If a sibling `product-mcp` directory exists, the plugin falls back to the sibling checkout first so it does not keep using a dirty stale cache.
- If no usable sibling checkout exists, the plugin reuses the existing cached checkout under `~/.erp-product/product-mcp`.
- For first-time offline use, clone `product-mcp` next to `erp-product-plugin` in advance.

### Missing Chrome Token

Likely causes:

- Chrome is not open.
- The ERP page is not logged in.
- The current ERP page URL does not match `matchUrlPrefixes`.
- The token key in the target environment is not `Admin-Token`.

Recommended user-facing prompt:

```text
Please open Chrome, log in to the ERP system, keep an ERP page that matches the configured URL prefix, refresh the page, then call product_auth_status again.
```

### MCP Tools Do Not Appear

Check:

- Whether the current Codex thread has the `ERP Product` plugin enabled.
- Whether the marketplace was added and the plugin was installed.
- Whether `.mcp.json` still points to `./scripts/start-product-token-bridge.mjs` and contains `cwd: "."`.
- Whether the launcher can find Node.js, Git, and Product MCP.

## Relationship To Product MCP

Keep the two repositories separate:

```text
product-mcp          # MCP server, local bridge, and tool implementation
erp-product-plugin   # Codex plugin marketplace wrapper
```

This repository owns plugin installation, plugin documentation, MCP server startup, and marketplace distribution. Product MCP owns the business tools, remote MCP server, and local bridge implementation.
