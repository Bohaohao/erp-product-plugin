# ERP Product Codex Plugin

This repository is the Codex plugin marketplace for ERP Product. It intentionally does not contain the Product MCP source code.

Use it with the sibling `product-mcp` repository:

```text
parent/
  product-mcp/
  erp-product-plugin/
```

The plugin starts `product-mcp/dist/localBridge.js`, reads the user's Chrome ERP login through the bridge, and exposes the `product_*` MCP tools to Codex.

## Local Development

Clone both repositories side by side:

```powershell
cd D:\project
git clone <product-mcp-repo-url> product-mcp
git clone <erp-product-plugin-repo-url> erp-product-plugin
```

The plugin launcher will run `npm ci` and `npm run build` inside `product-mcp` if needed. You can also prepare it manually:

```powershell
cd D:\project\product-mcp
npm ci
npm run build
npm run smoke
```

If `product-mcp` is not a sibling directory, set `PRODUCT_MCP_HOME` to its absolute path before launching Codex.

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
