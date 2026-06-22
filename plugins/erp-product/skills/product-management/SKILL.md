---
name: product-management
description: ERP product creation workflow through Product MCP. Use when the user asks Codex to check ERP product login status, precheck a local product package or product markdown file, upload product media/files, resolve category/unit/supplier/region/dictionary references, create an ERP product, or verify a created product.
---

# Product Management

## Overview

Use the `erp-product` MCP tools to turn local ERP product materials into a checked, uploaded, created, and verified product. The local bridge reads the user's Chrome ERP login token; never ask the user to paste or reveal the token.

Use the local bridge as the entry point for Codex/local package workflows. Local files must be uploaded with `product_upload_file` first; do not send local paths, file bytes, or large base64 payloads to the remote HTTP MCP or to `product_create`.

## First Step

Call `product_runtime_self_check` before the first backend lookup, upload, or create operation in a thread, and whenever a stale URL, plugin update, marketplace reinstall, or missing/stale tool is suspected. This self-check does not read Chrome or the ERP token; it verifies and refreshes the Product MCP runtime and effective bridge config on behalf of the user. If it returns `ok: true`, continue with `product_auth_status`. If it returns `ok: false`, follow its `agentGuidance` and report the conclusion in plain language.

Call `product_auth_status` after runtime self-check passes and before any backend lookup, upload, or create operation. This preflights and warms `chrome-devtools-mcp` through npm before checking the Chrome ERP login token.

If it returns `CHROME_REMOTE_DEBUGGING_NOT_ALLOWED`, stop the workflow and show the user the returned steps. In plain language, tell the user to:

1. Open local Chrome, not Edge or another browser.
2. Open `chrome://inspect/#remote-debugging` in the Chrome address bar.
3. Enable "Allow remote debugging for this browser instance".
4. Return to or open the configured ERP page.
5. Make sure the ERP page is logged in; if needed, log in again and refresh.
6. Return to Codex and retry the login-state check.

If the underlying message contains `Could not find DevToolsActivePort`, do not tell the user to wait for a popup. Prioritize the `chrome://inspect/#remote-debugging` steps above.

Do not treat a missing token cache by itself as a remote-debugging failure. If Chrome is reachable but no ERP token exists, ask the user to log in to ERP or refresh the ERP page, then retry `product_auth_status`. After the user completes the remote-debugging steps, call `product_auth_status` again with no extra confirmation parameter, then continue the original task.

If auth fails because `chrome-devtools-mcp` cannot be resolved, tell the user to allow npm/npx network access or configure npm proxy, then retry `product_auth_status`. If auth fails because no token is present, tell the user to open Chrome, log in to the ERP system under the currently resolved `projectUrl` or one of the returned `matchUrlPrefixes`, refresh the ERP page, then retry. Include the resolved environment, matched page URL, URL prefixes, and token storage key if the tool returns them, but never expose token content.

## Conversation Continuity

Do not tell the user to abandon the current thread because the plugin, marketplace, or Product MCP runtime needs to update. Existing threads may contain package parsing results, field mappings, user confirmations, and business decisions.

The AI Agent owns runtime verification. Do not ask the user to inspect versions, hashes, config files, terminal output, or MCP status fields. Use `product_runtime_self_check` yourself, then report the conclusion in plain language. Ask the user only for actions that require their local UI or credentials, such as logging in to ERP, refreshing the ERP page, allowing Chrome remote debugging, or reconnecting/restarting Codex when the current MCP process is already stale.

For Product MCP runtime checks, call `product_runtime_status`. For immediate Product MCP runtime updates, call `product_runtime_refresh`; the plugin proxy can refresh or restart the Product MCP child runtime while preserving the current Codex thread.

Do not call `product_runtime_refresh` as a routine step before every lookup, upload, or create action. A child runtime restart clears the in-process token cache and Chrome DevTools MCP connection, so the next token read may need Chrome again. Use refresh only when the user asks for an update, runtime status indicates an outdated checkout, or a Product MCP tool is genuinely missing/stale.

If an auth or Chrome-tab error still mentions an old `projectUrl` after the plugin was updated or reinstalled, call `product_runtime_self_check` once. If it still reports stale or mismatched config after its automatic refresh, conclude that the current Codex MCP process is still the old plugin process; ask the user only to reconnect/restart the plugin or Codex, then continue in the same thread after reconnection.

If the backend returns 401/403, the bridge refreshes the Chrome token once and retries. If 401/403 keeps happening in a short window, do not keep retrying tools in a loop; report the backend/auth error and ask the user to refresh or log in to ERP before continuing.

If the user is upgrading from an already-running pre-proxy plugin process, that old process cannot load new proxy code retroactively. If a reconnect is needed, ask the user to preserve and return to the same thread after reconnecting or restarting Codex. Before any disruptive action, summarize the current product workflow state in the conversation so the same thread can continue safely.

## Package Workflow

When the user provides a local product package directory or product markdown file:

1. Call `product_precheck_package` with the local path and `includeDraft: true`.
2. Report blocking errors, warnings, generated image crops, and the upload queue.
3. Resolve unresolved names by calling read-only tools:
   - `product_list_categories` for category names and IDs.
   - `product_get_category_config` for unit IDs, base configs, technical params, and optional configs.
   - `product_list_suppliers` for supplier IDs and names.
   - `product_list_regions` when the draft does not use all regions.
   - `product_get_dict` when dictionary values are needed.
4. Upload each valid local file with `product_upload_file`. Preserve `dedupeKey`, `sourceRelativePath`, and `sourceLocalPath` from each `uploadQueue` item so repeated package files can reuse the first OSS URL. Use the returned URL and suggested mapping when building media, certifications, sales support, customer cases, parts, or rich text payloads.
5. Build the `product_create` input from the precheck draft, resolved backend IDs, uploaded URLs, and any user corrections.

Stop and ask for the missing business decision when a required field cannot be inferred from the package or read-only tools.

## Create Safety

`product_create` writes a real ERP product. Only call it after the user gives an explicit confirmation in the current conversation.

Before calling `product_create`, summarize the product name, category, unit, supplier, region scope, main image status, and any remaining warnings. Require `confirm: true` in the tool input.

`product_create` should receive business fields and already-uploaded OSS URLs only. Never pass local paths, raw file content, or base64 file payloads to it.

After creation, call `product_get_detail` with the returned product ID to verify at least base and media sections. Report the product ID plus edit/view paths when available.

## Direct Tool Use

Use these tools directly for smaller requests:

- Login check: `product_auth_status`.
- Runtime self-check: `product_runtime_self_check`.
- Runtime check: `product_runtime_status`.
- Runtime refresh: `product_runtime_refresh`.
- Local file upload: `product_upload_file`.
- Package validation only: `product_precheck_package`.
- Reference lookup: `product_list_categories`, `product_get_category_config`, `product_list_suppliers`, `product_list_regions`, `product_get_dict`.
- Acceptance check: `product_get_detail`.

Prefer read-only tools before asking the user for IDs. Pass large numeric IDs as strings.

## Error Handling

For missing token or token bridge failures, explain the recoverable action:

- Open Chrome.
- Log in to the ERP system.
- Keep the ERP tab under the configured URL prefix.
- Retry `product_auth_status`.

For backend validation errors, preserve the backend message, include the request ID when present, and suggest the smallest next check, such as category config lookup, supplier lookup, or package correction.
