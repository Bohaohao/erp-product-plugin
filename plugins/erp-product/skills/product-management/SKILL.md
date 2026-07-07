---
name: product-management
description: ERP product creation workflow through Product MCP. Use when the user asks Codex to check ERP product login status, precheck a local product package or product markdown file, upload product media/files, resolve category/unit/supplier/region/dictionary references, create an ERP product, or verify a created product. Also recognizes natural Chinese material-organizing requests such as 帮我把某目录下的资料整理一下，然后创建成商品, 整理成可创建的商品资料包, and 根据商品材料包创建商品, routing them through the erp-product-material-workflow before Product MCP create.
---

# Product Management

## Overview

Use the `erp-product` MCP tools to turn local ERP product materials into a checked, uploaded, created, and verified product. The local bridge reads the user's Chrome ERP login token; never ask the user to paste or reveal the token.

Use the local bridge as the entry point for Codex/local package workflows. Local files must be uploaded with `product_upload_file` only after package required-field validation and duplicate-name check pass; do not send local paths, file bytes, or large base64 payloads to any MCP request or to `product_create`. Product MCP bridge `0.1.10` and later uses the local bridge to call the ERP backend directly for reference lookups, detail checks, uploads, and product creation; the remote MCP server is not part of the Codex default path. It also selects the Chrome DevTools MCP startup command by OS and appends common macOS Node version-manager paths for child processes, so macOS must not use Windows `cmd /c` Chrome MCP settings.

Use only the published `product_*` MCP tools for Chrome login checks, token reads, Chrome DevTools page matching, Product MCP SDK access, backend lookups, uploads, creation, and verification. Do not write temporary scripts to connect to Chrome DevTools MCP, parse Chrome page lists, read ERP tokens, import Product MCP internal modules, or call internal backend helpers. Those scripts bypass the runtime launcher, token cache, page-list parser, SDK resolution, auth refresh, config sync, and standard error handling, and can reintroduce bugs already fixed in Product MCP.

Do not use Browser, Chrome DevTools, captured frontend sessions, network-panel requests, or manually reconstructed ERP HTTP calls as a fallback for product precheck, upload, create, duplicate checks, or backend reference lookups. If the required `product_*` MCP tool is not callable in the current thread, treat that as a hard blocker: run `product_runtime_self_check` if available, report the missing tool names, and ask the user to reconnect/restart Codex or reinstall/refresh the plugin. Never create or mutate ERP products through the browser path.

If a previous attempt used a temporary script and hit SDK resolution errors, Chrome page-list parsing errors such as `Title (URL)`, `Payload Too Large`, stale config, or token/cache confusion, stop using that script. Call `product_runtime_self_check`, then continue through `product_auth_status` and the normal `product_*` tool chain.

ERP Product plugin `0.3.10` and later exposes a lightweight runtime launcher before Product MCP SDK/runtime preparation finishes. If `product_runtime_self_check` returns `ERP_PRODUCT_RUNTIME_NOT_READY`, treat it as a launcher/runtime dependency issue before Chrome DevTools MCP and before ERP token reading. Do not tell the user to enable Chrome remote debugging for that code; report the returned Node/GitHub/npm/runtime dependency cause and retry `product_runtime_launcher_refresh` only after the cause is recoverable.

ERP Product plugin `0.3.11` and later returns startup failure attribution fields such as `errorStage`, `errorReason`, `errorKind`, `errorCommand`, and `diagnostic`. When GitHub pull, npm install, network/proxy, SDK import, or runtime child startup fails or times out, explicitly tell the user the failing stage and reason. Do not give a generic "MCP tools are unavailable" answer, and do not route the user to Chrome remote debugging until these launcher/runtime dependency fields are clear.

If startup eventually succeeds by falling back to a cached checkout or sibling Product MCP, inspect `dependencies.warnings` and `refresh.dependencies.warnings`. Mention the degraded stage and fallback in the final status when it materially explains a slow startup or stale-code risk, while making clear that the current runtime recovered.

ERP Product plugin `0.3.12` and later auto-heals npm `ENOTEMPTY`/rename failures during Product MCP dependency installation by deleting the dirty `node_modules` paths reported by npm and retrying once. If the retry still fails, report the final `errorStage`, `errorReason`, and cleaned-artifact warning; do not ask ordinary users to manually delete cache directories unless the automated retry has already failed.

ERP Product plugin `0.3.13` and later isolates plugin-managed npm installs to `~/.erp-product/npm-cache` and retries with a temporary isolated cache if that cache fails. If an error mentions the user's global `~/.npm/_cacache`, instruct the user to apply or hot-refresh to `0.3.13+`; do not ask them to fix global npm cache permissions before the isolated-cache retry has been attempted.

ERP Product plugin `0.3.14` and later closes downstream Product MCP / chrome-devtools-mcp child processes when the Codex stdio connection closes. If diagnostics show multiple Product `localBridge` or `chrome-devtools-mcp` chains on one Mac after Codex restarts, treat that as an old orphan-process symptom. The AI Agent should clean up only stale ERP Product child chains when it has process-control access, then run `product_runtime_self_check` and `product_auth_status`; ordinary users should not be asked to inspect or kill processes themselves.

Product MCP bridge `0.1.12` and later attaches redacted `details.chromePages` diagnostics only when Chrome tab matching, page-context verification, or token reading fails. Do not request or produce Chrome tab lists during normal successful workflows. When an auth error includes `details.chromePages`, use that returned diagnostic to explain whether Product MCP saw zero tabs, failed to parse the page list, saw same-origin ERP pages, or evaluated the wrong page context. Do not write a separate script to list Chrome tabs.

ERP Product plugin `0.3.16` and later has the Runtime Proxy start or reuse the Product MCP local Token Bridge Daemon when `<productMcpDir>/dist/tokenBridgeDaemon.js` exists. The proxy injects `PRODUCT_TOKEN_DAEMON_URL` and `PRODUCT_TOKEN_DAEMON_SECRET` into the Product MCP child runtime, keeps the daemon alive across Product MCP child hot-restarts, and closes it only when the Runtime Proxy exits. If daemon startup fails or the entry is missing, the proxy falls back to the legacy `localBridge.js` token path and exposes the reason in `product_runtime_self_check` / `product_runtime_status` under `tokenDaemon`; report that diagnostic instead of saying all `product_*` tools disappeared.

ERP Product plugin `0.3.17` and later predeclares known Product MCP business tools from the Launcher and Runtime Proxy. If runtime status shows `cachedToolCount: 0` but `product_precheck_package`, `product_upload_file`, `product_create`, high-level create workflows, and lookup tools are visible in the current Codex tool list, do not stop or ask the user to restart. Continue through the standard tools; the fallback declarations only keep tool names visible, while the Product MCP child runtime still executes and validates the real calls. Ask for reconnect/restart only when the required tool names are genuinely absent from the current Codex tool list after `product_runtime_self_check`.

Product MCP bridge `0.1.15` and ERP Product plugin `0.3.18` and later expose `product_check_name_duplicate`. Treat it as a mandatory create gate: after `product_precheck_package` required-field validation passes and before any file upload or create call, check `draft.productNameCn` / the package Chinese product name. If the tool returns `exists: true` or `blocking: true`, stop this product's workflow and report the duplicate instead of uploading files.

ERP Product plugin `0.3.19` and later reuses successful `product_runtime_self_check` results for a short window and coalesces concurrent calls. In a multi-agent batch, the controller/orchestrator should run `product_runtime_self_check` and `product_auth_status` once before dispatching workers, then pass the verified runtime/auth conclusion to workers. Workers that receive that controller verification must not repeat `product_runtime_self_check` just because their first `product_*` lookup sees a cached token; they should proceed with package precheck, duplicate-name check, reference lookup, upload, and create. A worker may call `product_runtime_self_check` only if the controller did not provide verification, the required tool is genuinely missing/stale, or a runtime/config error occurs. Use `product_runtime_self_check({ "forceRefresh": true })` only for explicit refresh, stale-config diagnosis, or update acceptance.

Product MCP bridge `0.1.18` and ERP Product plugin `0.3.20` and later add redacted `transport.auth` diagnostics to backend lookup, upload, and create results. Use `tokenProvider`, `tokenSource`, and `tokenCache.fromCache` to determine whether a call reused the Token Bridge Daemon cache or read Chrome. During a normal create workflow, do not call `product_auth_status({ "forceRefresh": true })` or `product_runtime_refresh` between routine lookups/uploads just to "make sure" the token is fresh. If 401/403 happens immediately after a freshly read Chrome token, Product MCP clears the cache and returns the backend error without reopening Chrome again in the same tool call; ask the user to refresh or log in to ERP before retrying.

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

When a backend lookup/upload/create succeeds, inspect `transport.auth` only when diagnosing repeated Chrome remote-debugging prompts or token-cache behavior. Normal user-facing summaries should not mention these diagnostic fields unless they explain a blockage.

If the user is upgrading from an already-running pre-proxy plugin process, that old process cannot load new proxy code retroactively. If a reconnect is needed, ask the user to preserve and return to the same thread after reconnecting or restarting Codex. Before any disruptive action, summarize the current product workflow state in the conversation so the same thread can continue safely.

## Material Workflow Routing

Recognize natural Chinese material requests and route them into the material workflow before any Product MCP create. Treat the following (and close phrasings) as material-workflow triggers:

- 帮我把某目录下的资料整理一下，然后创建成商品
- 整理成可创建的商品资料包
- 根据商品材料包创建商品

Recognize batch create requests and prefer `product_create_from_batch` over single-package routing when the user mentions a spreadsheet/table or asks for multiple products in one workflow. Treat phrases such as "创建表格中的商品", "根据表格批量创建商品", "批量整理并创建", "批量整理资料包并创建", and close phrasings as batch-mode triggers.

If a request gives a rough material directory or may lack a ready `商品资料.md`, first use the `erp-product-material-workflow` skill to create or update `商品资料.md` and run its local checks. Treat missing/nonstandard template structure as a local material blocker; normalize with the packaged template before any Product MCP call. Do not call `product_precheck_package`, `product_upload_file`, or `product_create` until the local material blockers are gone. Only after `erp-product-material-workflow` has produced a checked `商品资料.md` (or the user already provided a ready product package file) do you continue into the Product MCP gates below.

This routing does not relax any safety gate. For a single product after the material workflow finishes, prefer the high-level `product_create_from_package` workflow. For batch table plus material-package requests, prefer `product_create_from_batch`. The high-level workflows run precheck, duplicate gate, reference resolution, upload binding, create, detail verification, and trace/diff reporting inside Product MCP. Use atomic tools only for debugging, validation-only requests, or an explicitly requested step-by-step workflow.

If those Product MCP tools are unavailable, stop at a tool-availability blocker. Do not switch to Chrome DevTools, Browser tools, or frontend request replay to continue the create workflow.

## Package Workflow

When the user provides a local product package directory or product markdown file:

1. If the path is a `商品资料.md` package, ensure the material workflow local check has passed, including standard-template validation.
2. Call `product_create_from_package` with `runMode: "preview"` and `responseMode: "summary"`. Preview mode must not upload and must not create.
3. Report blocking errors, warnings, reference-resolution results, upload queue count, field coverage, and the create preview summary returned by the workflow.
4. If duplicate name, missing references, missing required fields, invalid files, or unresolved upload bindings block the workflow, stop and report the actionable issues. Do not switch to atomic upload/create to bypass the blocker.
5. Ask for explicit user confirmation before real creation. Reuse the `clientRequestId` from preview when one is present so retries can use the workflow journal.
6. After confirmation, call `product_create_from_package` with `runMode: "create"` and `confirm: true`.
7. Report the workflow summary, product ID, upload summary, detail verification, and diff report. If the workflow stops before creation, report the exact stage and actionable issues.
8. Use `product_precheck_package`, `product_upload_file`, `product_create`, and lookup tools directly only when the user explicitly asks for a smaller diagnostic step or the high-level workflow is unavailable.

Stop and ask for the missing business decision when a required field cannot be inferred from the package or read-only tools.

## Batch Workflow

When the user provides a spreadsheet/table plus one or more material packages, or asks to create products from rows:

1. Treat the spreadsheet as the row-level source of truth for business facts. Treat material package files, filenames, and folder metadata as supplementary evidence for each row, not as a reason to overwrite explicit table cells.
2. By default, each row is an independent product. Do not merge rows into variants, SKUs, or one product unless the table or user explicitly says so.
3. Call `product_create_from_batch` with `runMode: "preview"` and `responseMode: "summary"`. Preview mode must not upload and must not create.
4. Report batch-level blockers, row-level blockers, duplicate-name results, reference-resolution results, upload queue counts, field coverage, and the create preview summary returned by the workflow.
5. Ask for one explicit confirmation that covers the whole batch before real creation. If the user wants only selected rows, the selection must be explicit before create mode.
6. After confirmation, call `product_create_from_batch` with `runMode: "create"` and `confirm: true`, reusing the preview `clientRequestId` when one is present.
7. If any row fails, report the row identifier and the writeback location/status returned by the workflow. A row-level failure must not be hidden by successful rows.
8. Do not switch to per-row `product_create_from_package` or atomic upload/create to bypass a batch blocker unless the user explicitly narrows the task to a single product or diagnostic step.

## Upload Scope

By default, follow `商品资料.md`, batch table rows, and Product MCP `uploadQueue` strictly. In the high-level workflows, every valid upload item is handled inside `product_create_from_package` or `product_create_from_batch`. Atomic workflows must also upload every valid `uploadQueue` item before `product_create`, and the upload success count must equal the valid `uploadQueue` count before creation.

Do not skip, defer, or omit any referenced file because of stability concerns, interface uncertainty, non-required media, a large number of rich media files, or a desire to create a smaller first version. Do not privately narrow upload scope.

The only exception is when the user explicitly asks to upload main/core/basic materials first and complete rich media later, or gives an equivalent instruction. Even under that exception, do not silently skip `uploadQueue` entries: first have the user confirm the reduced material scope, update or require updating `商品资料.md` to remove or adjust the excluded references, rerun the local material check and `product_precheck_package`, then fully upload the resulting new `uploadQueue`.

When `product_create_from_package` or `product_create_from_batch` uploads files, a single file failure is retried once and the workflow continues uploading the remaining files. After the upload stage, any item that still failed is reported with an error marker, and the workflow must not call `product_create` for the affected product. Do not manually bypass this by calling `product_create` with a reduced product.

For atomic workflows, if any valid referenced item fails to upload or cannot be mapped to a backend reference after retry, stop before `product_create` and report the concrete file plus the available choices: retry, fix the path/permission/file format, replace the file, or explicitly narrow scope through the exception above and recheck.

## Media Classification Boundary

Before upload/create, enforce media/attachment classification consistency. If a spreadsheet row supplies a media classification/use/type, the media row must keep that exact value. Otherwise, the row classification must come from the direct parent folder name, an exact ERP/template category with the same name, or an explicitly maintained mapping. Do not subjectively rewrite categories when the original can be preserved; examples that must be blocked include `实测视频` -> `作业视频` and `配件图` -> `属具图`.

If no exact category or explicit mapping exists, keep the original folder/category text and mark the row remark with `目标模板无同名分类，保留原始分类`. Subjective fallback requires the full trace `原目录/原分类：X；目标分类：Y；原因：目标模板无同名分类且无法保留原分类，按内容语义降级映射。` Product MCP precheck or the local checker may block the workflow if this trace is missing or inconsistent.

## Create Safety

`product_create_from_package` or `product_create_from_batch` with `runMode: "create"` and `product_create` all write real ERP products. Only call create mode after the user gives an explicit confirmation in the current conversation. For batch mode, the confirmation may cover the whole batch, but it must identify whether all rows or only selected rows will be created.

Before calling create mode, summarize the product name, category, unit, supplier, region scope, main image status, and any remaining warnings. The summary must also state the valid `uploadQueue` count, the uploaded count, and the failed/skipped count. Only proceed when the failed/skipped count is `0`, unless the user explicitly narrowed scope and the package was rechecked under the Upload Scope exception. Require `confirm: true` in the tool input.

`product_create` should receive business fields and already-uploaded OSS URLs only. Never pass local paths, raw file content, or base64 file payloads to it.

If `product_create` returns `Payload Too Large`, do not bypass the MCP workflow manually. First call `product_runtime_self_check` to make the Runtime Proxy pull the latest Product MCP. Product MCP bridge `0.1.10` and later submits Codex reference lookups, detail checks, uploads, and `product_create` directly from the local bridge to the ERP backend, avoiding the remote MCP gateway body-size limit while preserving Chrome-token handling, auth refresh, field normalization, and standard tool results.

After creation, call `product_get_detail` with the returned product ID to verify at least base and media sections. Report the product ID plus edit/view paths when available.

## Direct Tool Use

Use these tools directly for smaller requests:

- High-level package workflow: `product_create_from_package`.
- High-level batch workflow: `product_create_from_batch`.
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
