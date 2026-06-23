---
name: product-management
description: ERP product creation workflow through Product MCP. Use when the user asks Codex to check ERP product login status, precheck a local product package or product markdown file, upload product media/files, resolve category/unit/supplier/region/dictionary references, create an ERP product, or verify a created product.
---

# Product Management

## Overview

Use the `erp-product` MCP tools to turn local ERP product materials into a checked, uploaded, created, and verified product. The local bridge reads the user's Chrome ERP login token; never ask the user to paste or reveal the token.

Use the local bridge as the entry point for Codex/local package workflows. Local files must be uploaded with `product_upload_file` only after package required-field validation and duplicate-name check pass; do not send local paths, file bytes, or large base64 payloads to any MCP request or to `product_create`. Product MCP bridge `0.1.10` and later uses the local bridge to call the ERP backend directly for reference lookups, detail checks, uploads, and product creation; the remote MCP server is not part of the Codex default path. It also selects the Chrome DevTools MCP startup command by OS and appends common macOS Node version-manager paths for child processes, so macOS must not use Windows `cmd /c` Chrome MCP settings.

Use only the published `product_*` MCP tools for Chrome login checks, token reads, Chrome DevTools page matching, Product MCP SDK access, backend lookups, uploads, creation, and verification. Do not write temporary scripts to connect to Chrome DevTools MCP, parse Chrome page lists, read ERP tokens, import Product MCP internal modules, or call internal backend helpers. Those scripts bypass the runtime launcher, token cache, page-list parser, SDK resolution, auth refresh, config sync, and standard error handling, and can reintroduce bugs already fixed in Product MCP.

If a previous attempt used a temporary script and hit SDK resolution errors, Chrome page-list parsing errors such as `Title (URL)`, `Payload Too Large`, stale config, or token/cache confusion, stop using that script. Call `product_runtime_self_check`, then continue through `product_auth_status` and the normal `product_*` tool chain.

ERP Product plugin `0.3.10` and later exposes a lightweight runtime launcher before Product MCP SDK/runtime preparation finishes. If `product_runtime_self_check` returns `ERP_PRODUCT_RUNTIME_NOT_READY`, treat it as a launcher/runtime dependency issue before Chrome DevTools MCP and before ERP token reading. Do not tell the user to enable Chrome remote debugging for that code; report the returned Node/GitHub/npm/runtime dependency cause and retry `product_runtime_launcher_refresh` only after the cause is recoverable.

ERP Product plugin `0.3.11` and later returns startup failure attribution fields such as `errorStage`, `errorReason`, `errorKind`, `errorCommand`, and `diagnostic`. When GitHub pull, npm install, network/proxy, SDK import, or runtime child startup fails or times out, explicitly tell the user the failing stage and reason. Do not give a generic "MCP tools are unavailable" answer, and do not route the user to Chrome remote debugging until these launcher/runtime dependency fields are clear.

If startup eventually succeeds by falling back to a cached checkout or sibling Product MCP, inspect `dependencies.warnings` and `refresh.dependencies.warnings`. Mention the degraded stage and fallback in the final status when it materially explains a slow startup or stale-code risk, while making clear that the current runtime recovered.

ERP Product plugin `0.3.12` and later auto-heals npm `ENOTEMPTY`/rename failures during Product MCP dependency installation by deleting the dirty `node_modules` paths reported by npm and retrying once. If the retry still fails, report the final `errorStage`, `errorReason`, and cleaned-artifact warning; do not ask ordinary users to manually delete cache directories unless the automated retry has already failed.

ERP Product plugin `0.3.13` and later isolates plugin-managed npm installs to `~/.erp-product/npm-cache` and retries with a temporary isolated cache if that cache fails. If an error mentions the user's global `~/.npm/_cacache`, instruct the user to apply or hot-refresh to `0.3.13+`; do not ask them to fix global npm cache permissions before the isolated-cache retry has been attempted.

ERP Product plugin `0.3.14` and later closes downstream Product MCP / chrome-devtools-mcp child processes when the Codex stdio connection closes. If diagnostics show multiple Product `localBridge` or `chrome-devtools-mcp` chains on one Mac after Codex restarts, treat that as an old orphan-process symptom. The AI Agent should clean up only stale ERP Product child chains when it has process-control access, then run `product_runtime_self_check` and `product_auth_status`; ordinary users should not be asked to inspect or kill processes themselves.

Product MCP bridge `0.1.12` and later attaches redacted `details.chromePages` diagnostics only when Chrome tab matching, page-context verification, or token reading fails. Do not request or produce Chrome tab lists during normal successful workflows. When an auth error includes `details.chromePages`, use that returned diagnostic to explain whether Product MCP saw zero tabs, failed to parse the page list, saw same-origin ERP pages, or evaluated the wrong page context. Do not write a separate script to list Chrome tabs.

ERP Product plugin `0.3.16` and later has the Runtime Proxy start or reuse the Product MCP local Token Bridge Daemon when `<productMcpDir>/dist/tokenBridgeDaemon.js` exists. The proxy injects `PRODUCT_TOKEN_DAEMON_URL` and `PRODUCT_TOKEN_DAEMON_SECRET` into the Product MCP child runtime, keeps the daemon alive across Product MCP child hot-restarts, and closes it only when the Runtime Proxy exits. If daemon startup fails or the entry is missing, the proxy falls back to the legacy `localBridge.js` token path and exposes the reason in `product_runtime_self_check` / `product_runtime_status` under `tokenDaemon`; report that diagnostic instead of saying all `product_*` tools disappeared.

ERP Product plugin `0.3.17` and later predeclares known Product MCP business tools from the Launcher and Runtime Proxy. If runtime status shows `cachedToolCount: 0` but `product_precheck_package`, `product_upload_file`, `product_create`, and lookup tools are visible in the current Codex tool list, do not stop or ask the user to restart. Continue through the standard tools; the fallback declarations only keep tool names visible, while the Product MCP child runtime still executes and validates the real calls. Ask for reconnect/restart only when the required tool names are genuinely absent from the current Codex tool list after `product_runtime_self_check`.

Product MCP bridge `0.1.15` and ERP Product plugin `0.3.18` and later expose `product_check_name_duplicate`. Treat it as a mandatory create gate: after `product_precheck_package` required-field validation passes and before any file upload or create call, check `draft.productNameCn` / the package Chinese product name. If the tool returns `exists: true` or `blocking: true`, stop this product's workflow and report the duplicate instead of uploading files.

ERP Product plugin `0.3.19` and later reuses successful `product_runtime_self_check` results for a short window and coalesces concurrent calls. In a multi-agent batch, the controller/orchestrator should run `product_runtime_self_check` and `product_auth_status` once before dispatching workers, then pass the verified runtime/auth conclusion to workers. Workers that receive that controller verification must not repeat `product_runtime_self_check` just because their first `product_*` lookup sees a cached token; they should proceed with package precheck, duplicate-name check, reference lookup, upload, and create. A worker may call `product_runtime_self_check` only if the controller did not provide verification, the required tool is genuinely missing/stale, or a runtime/config error occurs. Use `product_runtime_self_check({ "forceRefresh": true })` only for explicit refresh, stale-config diagnosis, or update acceptance.

## First Step

Call `product_runtime_self_check` before the first backend lookup, upload, or create operation in a thread, and whenever a stale URL, plugin update, marketplace reinstall, or missing/stale tool is suspected. The stable Runtime Launcher applies plugin runtime proxy updates before forwarding this self-check, and the self-check then verifies and refreshes the Product MCP runtime and effective bridge config. It does not read Chrome or the ERP token. If it returns `ok: true`, continue with `product_auth_status`. If it returns `ok: false`, follow its `agentGuidance` and report the conclusion in plain language.

For multi-agent batches, the controller's successful `product_runtime_self_check` satisfies this first-step requirement for dispatched workers in the same batch. Workers should trust the controller-provided runtime/auth verification and should not run another self-check unless they hit a concrete runtime/tool/config failure.

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

For Product MCP runtime checks, call `product_runtime_status`. For immediate Product MCP runtime updates, call `product_runtime_refresh`; the plugin runtime proxy can refresh or restart the Product MCP child runtime while preserving the current Codex thread. For lower-level launcher diagnostics only, use `product_runtime_launcher_status`; for an explicit plugin runtime proxy update, use `product_runtime_launcher_refresh`.

Do not call `product_runtime_refresh` as a routine step before every lookup, upload, or create action. With the Token Bridge Daemon active, Product MCP child restarts reuse the daemon token cache and Chrome MCP connection, but legacy fallback mode or bridge-config changes may still force a fresh token path. Use refresh only when the user asks for an update, runtime status indicates an outdated checkout, or a Product MCP tool is genuinely missing/stale.

Routine lookup, upload, and create calls may still check the fixed Product MCP Git source, but they must not restart an already running child runtime just to apply a Product MCP checkout update. The proxy should defer that restart during active work; when the daemon is active, an explicit restart reuses the same daemon URL/secret so the token cache survives. Apply deferred updates through `product_runtime_self_check` or `product_runtime_refresh` before the next workflow, or when a stale/missing tool is actually blocking progress.

Routine lookup, upload, and create calls may also check the fixed ERP Product plugin runtime Git source through the Runtime Launcher, but they must not restart an already running runtime proxy just to apply a plugin runtime update. Apply deferred plugin runtime updates through `product_runtime_self_check` before the next workflow, or through `product_runtime_launcher_refresh` only when a stale launcher/runtime issue is blocking progress.

If an auth or Chrome-tab error still mentions an old `projectUrl` after the plugin was updated or reinstalled, call `product_runtime_self_check` once. If it still reports stale or mismatched config after its automatic refresh, conclude that the current Codex MCP process is still the old plugin process; ask the user only to reconnect/restart the plugin or Codex, then continue in the same thread after reconnection.

If the backend returns 401/403, the bridge refreshes the Chrome token once and retries. If 401/403 keeps happening in a short window, do not keep retrying tools in a loop; report the backend/auth error and ask the user to refresh or log in to ERP before continuing.

If the user is upgrading from an already-running pre-proxy plugin process, that old process cannot load new proxy code retroactively. If a reconnect is needed, ask the user to preserve and return to the same thread after reconnecting or restarting Codex. Before any disruptive action, summarize the current product workflow state in the conversation so the same thread can continue safely.

## Package Workflow

When the user provides a local product package directory or product markdown file:

1. Call `product_precheck_package` with the local path and `includeDraft: true`.
2. Report blocking errors, warnings, generated image crops, and the upload queue.
3. If required-field validation passed and the draft contains a Chinese product name, call `product_check_name_duplicate` with that name before any upload. If `exists: true` or `blocking: true`, stop this product immediately; do not call `product_upload_file` or `product_create`.
4. If this is a multi-agent batch and the current worker found a duplicate, return a failure notification to the controller/orchestrator. Include the package path, `productNameCn`, `duplicates`, and a clear note that no upload/create was performed.
5. Resolve unresolved names by calling read-only tools:
   - `product_list_categories` for category names and IDs.
   - `product_get_category_config` for unit IDs, base configs, technical params, and optional configs.
   - `product_list_suppliers` for supplier IDs and names.
   - `product_list_regions` when the draft does not use all regions.
   - `product_get_dict` when dictionary values are needed.
6. Upload each valid local file with `product_upload_file`. Preserve `dedupeKey`, `sourceRelativePath`, and `sourceLocalPath` from each `uploadQueue` item so repeated package files can reuse the first OSS URL. Use the returned URL and suggested mapping when building media, certifications, sales support, customer cases, parts, or rich text payloads.
7. Build the `product_create` input from the precheck draft, resolved backend IDs, uploaded URLs, and any user corrections.

Stop and ask for the missing business decision when a required field cannot be inferred from the package or read-only tools.

## Create Safety

`product_create` writes a real ERP product. Only call it after the user gives an explicit confirmation in the current conversation.

Before calling `product_create`, summarize the product name, category, unit, supplier, region scope, main image status, and any remaining warnings. Require `confirm: true` in the tool input.

`product_create` should receive business fields and already-uploaded OSS URLs only. Never pass local paths, raw file content, or base64 file payloads to it.

If `product_create` returns `Payload Too Large`, do not bypass the MCP workflow manually. First call `product_runtime_self_check` to make the Runtime Proxy pull the latest Product MCP. Product MCP bridge `0.1.10` and later submits Codex reference lookups, detail checks, uploads, and `product_create` directly from the local bridge to the ERP backend, avoiding the remote MCP gateway body-size limit while preserving Chrome-token handling, auth refresh, field normalization, and standard tool results.

After creation, call `product_get_detail` with the returned product ID to verify at least base and media sections. Report the product ID plus edit/view paths when available.

## Direct Tool Use

Use these tools directly for smaller requests:

- Login check: `product_auth_status`.
- Runtime self-check: `product_runtime_self_check`.
- Runtime check: `product_runtime_status`.
- Runtime refresh: `product_runtime_refresh`.
- Local file upload: `product_upload_file`.
- Package validation only: `product_precheck_package`.
- Duplicate product-name check: `product_check_name_duplicate`.
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
