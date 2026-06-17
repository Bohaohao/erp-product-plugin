# ERP Product Codex Plugin

This repository is the Codex plugin marketplace for ERP Product. It intentionally does not contain the Product MCP source code.

The plugin resolves Product MCP at runtime with this order:

1. Clone or update the fixed Product MCP Git repository in the user cache:
   `https://github.com/Bohaohao/product-mcp.git`
2. Use the latest cached checkout after a successful clone or `git pull`.
3. If Git connection, clone, fetch, or pull fails, fall back to a sibling `product-mcp` directory next to this marketplace repository.

The plugin starts `product-mcp/dist/localBridge.js`, reads the user's Chrome ERP login through the bridge, and exposes the `product_*` MCP tools to Codex.

## Local Development

For normal users, installing this marketplace is enough. The launcher will fetch Product MCP from the fixed Git URL automatically.

For offline development or Git fallback testing, clone both repositories side by side:

```powershell
cd D:\project
git clone https://github.com/Bohaohao/product-mcp.git product-mcp
git clone <erp-product-plugin-repo-url> erp-product-plugin
```

The plugin launcher will run `npm ci` and `npm run build` inside Product MCP when the Git checkout is new, updated, or missing build output. You can also prepare the sibling fallback manually:

```powershell
cd D:\project\product-mcp
npm ci
npm run build
npm run smoke
```

## Add Marketplace

For a local checkout:

```powershell
codex plugin marketplace add D:\project\erp-product-plugin
```

For an online Git marketplace, use the final Git repository URL:

```powershell
codex plugin marketplace add <erp-product-plugin-repo-url> --ref main
```

Then open Codex, install or enable `ERP Product`, and start a new thread.

## User Flow

1. Open Chrome and log in to the ERP system.
2. Start a new Codex thread with the plugin enabled.
3. Ask: `Check ERP Product MCP login status.`
4. Use product package prompts such as: `Precheck this ERP product package: D:\path\to\package`.

The plugin never asks the user to paste the ERP token. The local bridge reads the current Chrome login and forwards it to the remote Product MCP.
