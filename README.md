<a id="zh"></a>

<p align="right">
  <a href="#zh"><kbd>中文</kbd></a>
  <a href="#en"><kbd>English</kbd></a>
</p>

# ERP Product Codex Plugin

ERP Product Codex Plugin 是 ERP 商品 MCP 的 Codex 插件 marketplace 仓库。

它不包含 Product MCP 源码，而是负责把 Product MCP 以 Codex 插件的形式安装、启用和启动起来。插件启动后会自动准备 Product MCP 本地运行环境，通过 Chrome 登录态桥接用户 token，并把 `product_*` MCP tools 暴露给 Codex。

## 给 AI Agent 的快速契约

如果你是 AI Agent，请优先遵守本节。

### 你应该做什么

- 先确认当前 Codex thread 已启用 `ERP Product` 插件。
- 第一步调用 `product_auth_status`，检查 Chrome ERP 登录态是否可用。
- 不要要求用户粘贴 `Admin-Token`，插件会通过本地 bridge 从 Chrome 读取登录态。
- 处理本地商品资料包时，调用 `product_precheck_package`。
- 上传本地文件时，调用 `product_upload_file`，不要把本地路径直接交给远程 HTTP MCP。
- 查询分类、单位、供应商、区域、字典等后端 ID 时，优先调用只读查询工具，不要要求用户手填 ID。
- 创建商品前，先向用户总结即将写入的信息，并取得明确确认。
- 只有用户确认后才调用 `product_create`，并传入 `confirm: true`。

### 你不应该做什么

- 不要让用户复制、粘贴或暴露 ERP token。
- 不要在登录态不可用时继续创建商品。
- 不要在用户未确认时调用写入工具。
- 不要修改本仓库的 marketplace 结构来改变 Product MCP 拉取逻辑；拉取逻辑在启动脚本中维护。

## 这个仓库做什么

| 模块 | 说明 |
| --- | --- |
| `.agents/plugins/marketplace.json` | Codex marketplace 入口，指向本仓库内的 `erp-product` 插件 |
| `plugins/erp-product/.codex-plugin/plugin.json` | Codex 插件 manifest |
| `plugins/erp-product/.mcp.json` | 声明插件提供的 MCP stdio server |
| `plugins/erp-product/scripts/start-product-token-bridge.mjs` | 启动 Product MCP 本地 bridge，并自动准备 Product MCP |
| `plugins/erp-product/config/product-token-bridge.config.json` | 本地 bridge 的默认 ERP、远程 MCP 和 token 配置 |
| `plugins/erp-product/skills/product-management/SKILL.md` | 给 Codex/AI Agent 的 ERP 商品操作说明 |

## Product MCP 解析策略

插件运行时会按以下顺序解析 Product MCP：

1. 使用固定 Git 地址拉取或更新 Product MCP：
   `https://github.com/Bohaohao/product-mcp.git`
2. 默认缓存目录：
   `~/.erp-product/product-mcp`
3. 每次启动会尝试 `git fetch --prune origin` 和 `git pull --ff-only origin master`。
4. 如果 Git 连接失败、clone 失败、fetch 失败或 pull 失败，降级使用本 marketplace 仓库同级目录下的 `product-mcp`。
5. 如果 Product MCP 是新拉取的、刚更新过的，或缺少 `dist/localBridge.js`，插件会自动执行 `npm ci` 和 `npm run build`。

这个策略保证在线用户默认使用最新 Product MCP；离线、代理异常或 Git 不可用时，仍可通过同级目录 fallback 使用。

## 架构

```text
Codex Plugin Marketplace
  -> erp-product plugin
    -> .mcp.json
      -> scripts/start-product-token-bridge.mjs
        -> ~/.erp-product/product-mcp, fixed Git checkout
        -> sibling ../product-mcp, fallback
        -> Product MCP localBridge.js
          -> Chrome DevTools MCP
          -> Remote Product MCP HTTP /mcp
```

## 安装

### 方式一：从 Git marketplace 安装

当本仓库发布到远程 Git 仓库后，使用：

```powershell
codex plugin marketplace add <erp-product-plugin-repo-url> --ref master
```

然后在 Codex 中安装或启用 `ERP Product` 插件，并新建 thread 使用。

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

同级 `product-mcp` 只在固定 Git 拉取或更新失败时使用。

## 用户使用流程

1. 打开 Chrome。
2. 登录 ERP 系统。
3. 保留一个匹配配置 URL 前缀的 ERP 页面。
4. 在 Codex 中启用 `ERP Product` 插件并新建 thread。
5. 先让 Codex 检查登录态：

```text
检查 ERP Product MCP 登录状态。
```

6. 然后开始商品资料包预检、文件上传、商品创建等工作：

```text
预检这个 ERP 商品资料包：D:\path\to\package
```

## 运行时行为

插件启动时会执行以下动作：

1. 准备 Product MCP checkout。
2. 尝试更新到固定 Git 仓库的最新 `master`。
3. 必要时安装 Product MCP 依赖并构建。
4. 启动 `dist/localBridge.js`。
5. 通过 bridge 从 Chrome ERP 页面读取 `localStorage.Admin-Token`。
6. 将请求转发给远程 Product MCP。

插件不会让用户手动复制 token，也不会把 token 打印给 AI Agent。

## 配置

默认 bridge 配置文件：

```text
plugins/erp-product/config/product-token-bridge.config.json
```

关键字段：

```json
{
  "projectUrl": "https://test.eysscm.com/erp/purchase",
  "matchUrlPrefixes": ["https://test.eysscm.com/erp/"],
  "tokenStorageKey": "Admin-Token",
  "remoteMcpUrl": "http://47.95.237.95:8787/mcp",
  "backendBaseUrl": "https://test.eysscm.com/api",
  "clientId": "e5cd7e4891bf95d1d19206ce24a7b32e",
  "language": "zh_CN"
}
```

如需切换 ERP 环境，优先修改这个配置文件，而不是修改 marketplace JSON。

## 本地验证

校验插件结构：

```powershell
python C:\Users\Administrator\.codex\skills\.system\plugin-creator\scripts\validate_plugin.py D:\project\erp-product-plugin\plugins\erp-product
```

校验启动脚本语法：

```powershell
node --check D:\project\erp-product-plugin\plugins\erp-product\scripts\start-product-token-bridge.mjs
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

- 插件会自动降级到同级目录 `product-mcp`。
- 如果需要离线使用，请提前把 `product-mcp` clone 到 `erp-product-plugin` 同级目录。

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
- `.mcp.json` 是否仍指向 `./scripts/start-product-token-bridge.mjs`。
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

It does not contain the Product MCP source code. Instead, it installs, enables, and starts Product MCP as a Codex plugin. When enabled, the plugin prepares the local Product MCP runtime, bridges the user's Chrome ERP login token, and exposes the `product_*` MCP tools to Codex.

## Quick Contract For AI Agents

If you are an AI Agent, read this section first.

### What You Should Do

- Confirm that the current Codex thread has the `ERP Product` plugin enabled.
- Call `product_auth_status` first to check whether Chrome ERP login state is available.
- Do not ask the user to paste `Admin-Token`; the plugin reads login state from Chrome through the local bridge.
- For local product packages, call `product_precheck_package`.
- For local file uploads, call `product_upload_file`; do not pass local paths directly to the remote HTTP MCP.
- Use read-only lookup tools to resolve category, unit, supplier, region, and dictionary IDs. Do not ask the user to manually fill backend IDs.
- Before creating a product, summarize the fields that will be written and ask the user for explicit confirmation.
- Call `product_create` only after confirmation, and pass `confirm: true`.

### What You Should Not Do

- Do not ask the user to copy, paste, or reveal the ERP token.
- Do not continue product creation when login state is unavailable.
- Do not call write tools before the user confirms.
- Do not change marketplace structure to change Product MCP fetching behavior; that behavior belongs in the launcher script.

## What This Repository Does

| Module | Description |
| --- | --- |
| `.agents/plugins/marketplace.json` | Codex marketplace entry that points to the local `erp-product` plugin |
| `plugins/erp-product/.codex-plugin/plugin.json` | Codex plugin manifest |
| `plugins/erp-product/.mcp.json` | Declares the MCP stdio server provided by this plugin |
| `plugins/erp-product/scripts/start-product-token-bridge.mjs` | Starts the Product MCP local bridge and prepares Product MCP automatically |
| `plugins/erp-product/config/product-token-bridge.config.json` | Default ERP, remote MCP, and token bridge config |
| `plugins/erp-product/skills/product-management/SKILL.md` | ERP product workflow instructions for Codex and AI Agents |

## Product MCP Resolution Strategy

At runtime, the plugin resolves Product MCP in this order:

1. Clone or update Product MCP from the fixed Git URL:
   `https://github.com/Bohaohao/product-mcp.git`
2. Use the default cache directory:
   `~/.erp-product/product-mcp`
3. On every startup, try `git fetch --prune origin` and `git pull --ff-only origin master`.
4. If Git connection, clone, fetch, or pull fails, fall back to a sibling `product-mcp` directory next to this marketplace repository.
5. If Product MCP is newly cloned, updated, or missing `dist/localBridge.js`, the plugin runs `npm ci` and `npm run build`.

This keeps online users on the latest Product MCP while still allowing offline or proxy-failure fallback through a sibling checkout.

## Architecture

```text
Codex Plugin Marketplace
  -> erp-product plugin
    -> .mcp.json
      -> scripts/start-product-token-bridge.mjs
        -> ~/.erp-product/product-mcp, fixed Git checkout
        -> sibling ../product-mcp, fallback
        -> Product MCP localBridge.js
          -> Chrome DevTools MCP
          -> Remote Product MCP HTTP /mcp
```

## Installation

### Option 1: Install From A Git Marketplace

After this repository is published to a remote Git repository, use:

```powershell
codex plugin marketplace add <erp-product-plugin-repo-url> --ref master
```

Then install or enable the `ERP Product` plugin in Codex and start a new thread.

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

The sibling `product-mcp` checkout is used only when the fixed Git clone or update fails.

## User Flow

1. Open Chrome.
2. Log in to the ERP system.
3. Keep an ERP page whose URL matches the configured prefix.
4. Enable the `ERP Product` plugin in Codex and start a new thread.
5. Ask Codex to check login state first:

```text
Check ERP Product MCP login status.
```

6. Then continue with product package precheck, file upload, and product creation:

```text
Precheck this ERP product package: D:\path\to\package
```

## Runtime Behavior

On startup, the plugin:

1. Prepares the Product MCP checkout.
2. Tries to update it to the latest `master` from the fixed Git repository.
3. Installs Product MCP dependencies and builds when needed.
4. Starts `dist/localBridge.js`.
5. Reads `localStorage.Admin-Token` from a Chrome ERP page through the bridge.
6. Forwards requests to the remote Product MCP.

The plugin never asks the user to manually copy a token and never prints the token to the AI Agent.

## Configuration

Default bridge config file:

```text
plugins/erp-product/config/product-token-bridge.config.json
```

Important fields:

```json
{
  "projectUrl": "https://test.eysscm.com/erp/purchase",
  "matchUrlPrefixes": ["https://test.eysscm.com/erp/"],
  "tokenStorageKey": "Admin-Token",
  "remoteMcpUrl": "http://47.95.237.95:8787/mcp",
  "backendBaseUrl": "https://test.eysscm.com/api",
  "clientId": "e5cd7e4891bf95d1d19206ce24a7b32e",
  "language": "zh_CN"
}
```

To switch ERP environments, update this config file instead of changing marketplace JSON.

## Local Verification

Validate plugin structure:

```powershell
python C:\Users\Administrator\.codex\skills\.system\plugin-creator\scripts\validate_plugin.py D:\project\erp-product-plugin\plugins\erp-product
```

Check launcher syntax:

```powershell
node --check D:\project\erp-product-plugin\plugins\erp-product\scripts\start-product-token-bridge.mjs
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

- The plugin automatically falls back to a sibling `product-mcp` directory.
- For offline use, clone `product-mcp` next to `erp-product-plugin` in advance.

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
- Whether `.mcp.json` still points to `./scripts/start-product-token-bridge.mjs`.
- Whether the launcher can find Node.js, Git, and Product MCP.

## Relationship To Product MCP

Keep the two repositories separate:

```text
product-mcp          # MCP server, local bridge, and tool implementation
erp-product-plugin   # Codex plugin marketplace wrapper
```

This repository owns plugin installation, plugin documentation, MCP server startup, and marketplace distribution. Product MCP owns the business tools, remote MCP server, and local bridge implementation.
