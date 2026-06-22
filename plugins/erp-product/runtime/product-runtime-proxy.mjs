import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pluginRoot = dirname(scriptDir);
const productMcpRepoUrl = 'https://github.com/Bohaohao/product-mcp.git';
const productMcpRef = 'master';
const siblingProductMcp = resolve(pluginRoot, '..', '..', '..', 'product-mcp');
const cachedProductMcp = join(homedir(), '.erp-product', 'product-mcp');
const sourceBridgeConfig = join(pluginRoot, 'config', 'product-token-bridge.config.json');
const runtimeBridgeConfig = join(homedir(), '.erp-product', 'product-token-bridge.config.json');
const proxyVersion = '0.3.0';
const runtimeUpdateCheckIntervalMs = 5 * 60 * 1000;
const posixPathEntries = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];

let sdk;
let serverInstance;
let productMcp;
let productMcpDir;
let childClient;
let childTransport;
let childStartedAt;
let childRuntimeCommit;
let childBridgeConfigHash;
let childToolsCache = [];
let restartCount = 0;
let pendingChildRuntimeRestart = null;
let lastSyncMs = 0;
let lastSyncStatus = {
  checkedAt: null,
  checked: false,
  updated: false,
  source: null,
  error: null
};
let runtimeLock = Promise.resolve();

function run(command, args, cwd, options = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: processEnv(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });

  if (result.error) {
    throw result.error;
  }

  if (options.logOutput !== false) {
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }

  if (result.status !== 0) {
    if (options.logOutput === false && result.stderr) {
      process.stderr.write(result.stderr);
    }
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }

  return result.stdout?.trim() ?? '';
}

function runNpm(args, cwd) {
  if (process.platform === 'win32') {
    return run('cmd', ['/d', '/s', '/c', 'npm', ...args], cwd);
  }

  return run('npm', args, cwd);
}

function hasProductMcp(dir) {
  return existsSync(join(dir, 'package.json'));
}

function bridgeEntryFor(dir) {
  return join(dir, 'dist', 'localBridge.js');
}

function runtimeDependencyFor(dir) {
  return join(dir, 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json');
}

function sourceEntryFor(dir) {
  return join(dir, 'src', 'localBridge.ts');
}

function isSourceNewerThanBuild(dir) {
  try {
    const source = statSync(sourceEntryFor(dir));
    const build = statSync(bridgeEntryFor(dir));
    return source.mtimeMs > build.mtimeMs;
  } catch {
    return false;
  }
}

function gitHead(dir) {
  return run('git', ['rev-parse', 'HEAD'], dir, { logOutput: false });
}

function gitHeadSafe(dir) {
  try {
    if (!dir || !existsSync(join(dir, '.git'))) return null;
    return gitHead(dir);
  } catch {
    return null;
  }
}

function fileHash(path) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

function syncRuntimeBridgeConfig() {
  mkdirSync(dirname(runtimeBridgeConfig), { recursive: true });

  const source = readFileSync(sourceBridgeConfig);
  const nextHash = createHash('sha256').update(source).digest('hex');
  const currentHash = fileHash(runtimeBridgeConfig);

  if (currentHash !== nextHash) {
    writeFileSync(runtimeBridgeConfig, source);
  }

  return nextHash;
}

function normalizeEnvironmentName(value) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (['prod', 'production'].includes(normalized)) return 'prod';
  if (['stage', 'staging', 'test', 'testing'].includes(normalized)) return 'stage';
  return normalized;
}

function readCsvEnv(name) {
  const raw = process.env[name];
  if (!raw) return undefined;

  const values = raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  return values.length ? values : undefined;
}

function firstEnv(names) {
  return names.map((name) => process.env[name]?.trim()).find(Boolean);
}

function resolveBridgeConfigPreview(config) {
  const selectedEnvironment = normalizeEnvironmentName(
    firstEnv(['PRODUCT_MCP_ENV', 'PRODUCT_MCP_BRIDGE_ENV', 'ERP_PRODUCT_ENV']) ||
      config.environment ||
      (config.environments?.stage ? 'stage' : undefined)
  );
  const environmentConfig = selectedEnvironment ? config.environments?.[selectedEnvironment] : undefined;

  if (selectedEnvironment && config.environments && !environmentConfig) {
    return {
      ok: false,
      error: `Bridge config environment not found: ${selectedEnvironment}.`
    };
  }

  const projectUrl = process.env.PRODUCT_MCP_PROJECT_URL || environmentConfig?.projectUrl || config.projectUrl;
  const matchUrlPrefixes = readCsvEnv('PRODUCT_MCP_MATCH_URL_PREFIXES') || environmentConfig?.matchUrlPrefixes || config.matchUrlPrefixes;

  return {
    ok: Boolean(projectUrl),
    environment: selectedEnvironment,
    projectUrl,
    matchUrlPrefixes: matchUrlPrefixes?.length ? matchUrlPrefixes : projectUrl ? [projectUrl] : [],
    tokenStorageKey: process.env.PRODUCT_MCP_TOKEN_STORAGE_KEY || config.tokenStorageKey,
    remoteMcpUrl: process.env.PRODUCT_MCP_REMOTE_MCP_URL || environmentConfig?.remoteMcpUrl || config.remoteMcpUrl,
    backendBaseUrl:
      firstEnv(['PRODUCT_MCP_BRIDGE_BACKEND_BASE_URL', 'PRODUCT_MCP_BACKEND_BASE_URL']) ||
      environmentConfig?.backendBaseUrl ||
      config.backendBaseUrl,
    language: process.env.PRODUCT_MCP_LANGUAGE || config.language
  };
}

function readRuntimeBridgeConfigPreview() {
  try {
    return resolveBridgeConfigPreview(JSON.parse(readFileSync(runtimeBridgeConfig, 'utf8')));
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function arraysEqual(left = [], right = []) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function tryResolveGitProductMcp() {
  try {
    if (!hasProductMcp(cachedProductMcp)) {
      mkdirSync(dirname(cachedProductMcp), { recursive: true });
      run('git', ['clone', '--branch', productMcpRef, productMcpRepoUrl, cachedProductMcp], dirname(cachedProductMcp));
      return { dir: cachedProductMcp, updated: true, source: 'git clone' };
    }

    if (!existsSync(join(cachedProductMcp, '.git'))) {
      throw new Error(`Cached Product MCP is not a git checkout: ${cachedProductMcp}`);
    }

    const before = gitHead(cachedProductMcp);

    run('git', ['remote', 'set-url', 'origin', productMcpRepoUrl], cachedProductMcp);
    run('git', ['fetch', '--prune', 'origin'], cachedProductMcp);
    run('git', ['pull', '--ff-only', 'origin', productMcpRef], cachedProductMcp);

    const after = gitHead(cachedProductMcp);

    return {
      dir: cachedProductMcp,
      updated: before !== after,
      source: 'git pull'
    };
  } catch (error) {
    process.stderr.write(`Product MCP git sync failed.\n${error.message}\n`);

    if (hasProductMcp(siblingProductMcp)) {
      process.stderr.write(`Using sibling Product MCP fallback after git sync failure: ${siblingProductMcp}\n`);
      return { dir: siblingProductMcp, updated: false, source: 'sibling fallback after git sync failure' };
    }

    if (hasProductMcp(cachedProductMcp) && existsSync(join(cachedProductMcp, '.git'))) {
      process.stderr.write(`Using existing cached Product MCP checkout: ${cachedProductMcp}\n`);
      return { dir: cachedProductMcp, updated: false, source: 'cached checkout fallback' };
    }

    process.stderr.write(`Falling back to sibling directory: ${siblingProductMcp}\n`);
    return null;
  }
}

function resolveProductMcp() {
  const gitProductMcp = tryResolveGitProductMcp();
  if (gitProductMcp) {
    return gitProductMcp;
  }

  if (hasProductMcp(siblingProductMcp)) {
    process.stderr.write(`Using sibling Product MCP fallback: ${siblingProductMcp}\n`);
    return { dir: siblingProductMcp, updated: false, source: 'sibling fallback' };
  }

  throw new Error(
    `Product MCP is unavailable. Tried fixed git repo ${productMcpRepoUrl}, cached checkout ${cachedProductMcp}, then sibling directory ${siblingProductMcp}.`
  );
}

function ensureProductMcp(selection) {
  const bridgeEntry = bridgeEntryFor(selection.dir);
  const runtimeDependency = runtimeDependencyFor(selection.dir);
  const buildIsStale = existsSync(bridgeEntry) && isSourceNewerThanBuild(selection.dir);
  let rebuilt = false;

  process.stderr.write(`Using Product MCP (${selection.source}): ${selection.dir}\n`);

  if (selection.updated || !existsSync(bridgeEntry) || buildIsStale) {
    runNpm(['install'], selection.dir);
    runNpm(['run', 'build'], selection.dir);
    rebuilt = true;
  } else if (!existsSync(runtimeDependency)) {
    runNpm(['install', '--omit=dev'], selection.dir);
  }

  return {
    rebuilt,
    buildIsStale
  };
}

function importFromProductMcp(specifier) {
  const requireFromProductMcp = createRequire(join(productMcpDir, 'package.json'));
  return import(pathToFileURL(requireFromProductMcp.resolve(specifier)).href);
}

async function loadSdk() {
  const [serverModule, serverStdioModule, clientModule, clientStdioModule, typesModule] = await Promise.all([
    importFromProductMcp('@modelcontextprotocol/sdk/server/index.js'),
    importFromProductMcp('@modelcontextprotocol/sdk/server/stdio.js'),
    importFromProductMcp('@modelcontextprotocol/sdk/client/index.js'),
    importFromProductMcp('@modelcontextprotocol/sdk/client/stdio.js'),
    importFromProductMcp('@modelcontextprotocol/sdk/types.js')
  ]);

  sdk = {
    Server: serverModule.Server,
    StdioServerTransport: serverStdioModule.StdioServerTransport,
    Client: clientModule.Client,
    StdioClientTransport: clientStdioModule.StdioClientTransport,
    ListToolsRequestSchema: typesModule.ListToolsRequestSchema,
    CallToolRequestSchema: typesModule.CallToolRequestSchema
  };
}

function withRuntimeLock(task) {
  const next = runtimeLock.then(task, task);
  runtimeLock = next.catch(() => undefined);
  return next;
}

function processEnv() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined));
  if (process.platform !== 'win32') {
    const delimiter = ':';
    const existingPath = env.PATH || env.Path || '';
    const pathParts = [...posixPathEntries, ...existingPath.split(delimiter)].filter(Boolean);
    env.PATH = [...new Set(pathParts)].join(delimiter);
  }
  return env;
}

async function stopChildRuntime() {
  const client = childClient;
  const transport = childTransport;
  childClient = undefined;
  childTransport = undefined;
  childToolsCache = [];
  childStartedAt = undefined;
  childRuntimeCommit = undefined;
  childBridgeConfigHash = undefined;

  if (client) {
    await client.close().catch((error) => {
      process.stderr.write(`Failed to close Product MCP child client: ${error.message}\n`);
    });
  } else if (transport) {
    await transport.close().catch((error) => {
      process.stderr.write(`Failed to close Product MCP child runtime: ${error.message}\n`);
    });
  }
}

async function startChildRuntime() {
  const bridgeEntry = bridgeEntryFor(productMcpDir);
  if (!existsSync(bridgeEntry)) {
    ensureProductMcp({ ...productMcp, updated: true });
  }
  const bridgeConfigHash = syncRuntimeBridgeConfig();

  const transport = new sdk.StdioClientTransport({
    command: process.execPath,
    args: [bridgeEntry, '--config', runtimeBridgeConfig],
    cwd: productMcpDir,
    env: processEnv(),
    stderr: 'inherit'
  });

  const client = new sdk.Client({
    name: 'erp-product-runtime-proxy-child',
    version: proxyVersion
  });

  transport.onerror = (error) => {
    process.stderr.write(`Product MCP child runtime transport error: ${error.message}\n`);
  };
  transport.onclose = () => {
    if (childTransport === transport) {
      childClient = undefined;
      childTransport = undefined;
      childToolsCache = [];
      childStartedAt = undefined;
      childRuntimeCommit = undefined;
      childBridgeConfigHash = undefined;
    }
  };

  await client.connect(transport);

  childClient = client;
  childTransport = transport;
  childStartedAt = new Date().toISOString();
  childRuntimeCommit = gitHeadSafe(productMcpDir);
  childBridgeConfigHash = bridgeConfigHash;
  childToolsCache = [];

  process.stderr.write(`Product MCP child runtime started: ${productMcpDir}\n`);
}

async function restartChildRuntime(reason) {
  process.stderr.write(`Restarting Product MCP child runtime: ${reason}\n`);
  await stopChildRuntime();
  await startChildRuntime();
  restartCount += 1;
  pendingChildRuntimeRestart = null;
}

async function ensureChildRuntime() {
  if (childClient) return childClient;

  return withRuntimeLock(async () => {
    if (!childClient) {
      await startChildRuntime();
    }
    return childClient;
  });
}

async function syncProductMcp(options = {}) {
  const force = Boolean(options.force);
  const allowChildRestart = options.allowChildRestart !== false;
  const currentConfigHash = syncRuntimeBridgeConfig();
  const currentBridgeConfigChanged =
    Boolean(childClient) && Boolean(childBridgeConfigHash) && childBridgeConfigHash !== currentConfigHash;
  const now = Date.now();
  if (!force && !currentBridgeConfigChanged && now - lastSyncMs < runtimeUpdateCheckIntervalMs) {
    return {
      checked: false,
      updated: false,
      restarted: false,
      reason: 'interval_not_elapsed'
    };
  }

  return withRuntimeLock(async () => {
    const lockedConfigHash = syncRuntimeBridgeConfig();
    const lockedBridgeConfigChanged =
      Boolean(childClient) && Boolean(childBridgeConfigHash) && childBridgeConfigHash !== lockedConfigHash;
    const lockedNow = Date.now();
    if (!force && !lockedBridgeConfigChanged && lockedNow - lastSyncMs < runtimeUpdateCheckIntervalMs) {
      return {
        checked: false,
        updated: false,
        restarted: false,
        reason: 'interval_not_elapsed'
      };
    }

    const beforeDir = productMcpDir;
    const beforeCommit = gitHeadSafe(productMcpDir);
    const beforeConfigHash = fileHash(runtimeBridgeConfig);

    try {
      const nextProductMcp = resolveProductMcp();
      const ensureResult = ensureProductMcp(nextProductMcp);
      const afterConfigHash = syncRuntimeBridgeConfig();

      productMcp = nextProductMcp;
      productMcpDir = nextProductMcp.dir;

      const afterCommit = gitHeadSafe(productMcpDir);
      const childRuntimeOutdated =
        Boolean(childClient) && Boolean(childRuntimeCommit) && Boolean(afterCommit) && childRuntimeCommit !== afterCommit;
      const updated =
        nextProductMcp.updated || ensureResult.rebuilt || beforeDir !== productMcpDir || beforeCommit !== afterCommit || childRuntimeOutdated;
      const bridgeConfigChanged =
        Boolean(childClient) && Boolean(childBridgeConfigHash) && childBridgeConfigHash !== afterConfigHash;
      let restarted = false;
      const restartReason =
        updated && bridgeConfigChanged
          ? 'Product MCP checkout and bridge config changed'
          : updated
            ? 'Product MCP checkout changed'
            : 'bridge config changed';

      if ((updated || bridgeConfigChanged) && childClient) {
        if (!allowChildRestart && updated && !bridgeConfigChanged) {
          pendingChildRuntimeRestart = {
            reason: restartReason,
            detectedAt: new Date().toISOString(),
            beforeCommit: childRuntimeCommit ?? beforeCommit,
            afterCommit,
            dir: productMcpDir,
            note:
              'Product MCP checkout updated, but the running child runtime was kept alive to preserve the in-process Chrome token cache. Call product_runtime_self_check or product_runtime_refresh to apply it immediately.'
          };
        } else {
          await restartChildRuntime(restartReason);
          restarted = true;
          await serverInstance?.sendToolListChanged?.().catch(() => undefined);
        }
      }

      lastSyncMs = Date.now();
      lastSyncStatus = {
        checkedAt: new Date(lastSyncMs).toISOString(),
        checked: true,
        updated,
        source: nextProductMcp.source,
        error: null
      };

      return {
        checked: true,
        updated,
        restarted,
        source: nextProductMcp.source,
        beforeCommit,
        afterCommit,
        beforeConfigHash,
        afterConfigHash,
        bridgeConfigChanged,
        childRuntimeOutdated,
        restartDeferred: Boolean(pendingChildRuntimeRestart),
        rebuilt: ensureResult.rebuilt,
        buildIsStale: ensureResult.buildIsStale,
        dir: productMcpDir
      };
    } catch (error) {
      lastSyncMs = Date.now();
      lastSyncStatus = {
        checkedAt: new Date(lastSyncMs).toISOString(),
        checked: true,
        updated: false,
        source: productMcp?.source ?? null,
        error: error instanceof Error ? error.message : String(error)
      };
      throw error;
    }
  });
}

function runtimeStatus(extra = {}) {
  const now = Date.now();
  return {
    proxy: {
      name: 'erp-product-runtime-proxy',
      version: proxyVersion,
      pid: process.pid,
      pluginRoot,
      updateCheckIntervalSeconds: runtimeUpdateCheckIntervalMs / 1000
    },
    productMcp: {
      repoUrl: productMcpRepoUrl,
      ref: productMcpRef,
      dir: productMcpDir,
      source: productMcp?.source ?? null,
      commit: gitHeadSafe(productMcpDir),
      cachedDir: cachedProductMcp,
      siblingFallbackDir: siblingProductMcp,
      lastSync: lastSyncStatus,
      nextAutomaticCheckInSeconds: Math.max(0, Math.ceil((runtimeUpdateCheckIntervalMs - (now - lastSyncMs)) / 1000))
    },
    childRuntime: {
      running: Boolean(childClient),
      pid: childTransport?.pid ?? null,
      startedAt: childStartedAt ?? null,
      commit: childRuntimeCommit ?? null,
      bridgeConfigHash: childBridgeConfigHash ?? null,
      restartCount,
      pendingRestart: pendingChildRuntimeRestart,
      cachedToolCount: childToolsCache.length
    },
    bridgeConfig: {
      sourcePath: sourceBridgeConfig,
      runtimePath: runtimeBridgeConfig,
      sourceHash: fileHash(sourceBridgeConfig),
      runtimeHash: fileHash(runtimeBridgeConfig)
    },
    threadContinuity: {
      productMcpRuntimeHotRefresh: true,
      requiresNewThreadForProductMcpRuntimeUpdates: false,
      note: 'After this proxy version is loaded, Product MCP can be refreshed by restarting only the child runtime inside the same MCP proxy process.'
    },
    ...extra
  };
}

function jsonResult(payload) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2)
      }
    ]
  };
}

function parseJsonToolResult(result) {
  const text = result?.content?.find((item) => item.type === 'text')?.text;
  if (!text) {
    throw new Error('Tool returned no text JSON payload.');
  }

  return JSON.parse(text);
}

async function runtimeSelfCheck() {
  let syncResult;
  let syncError = null;

  try {
    syncResult = await syncProductMcp({ force: true });
  } catch (error) {
    syncError = error instanceof Error ? error.message : String(error);
  }

  let childConfigStatus = null;
  let childConfigError = null;

  try {
    const childResult = await callChildTool('product_bridge_config_status', {});
    childConfigStatus = parseJsonToolResult(childResult);
  } catch (error) {
    childConfigError = error instanceof Error ? error.message : String(error);
  }

  const status = runtimeStatus();
  const expectedConfig = readRuntimeBridgeConfigPreview();
  const sourceHash = status.bridgeConfig.sourceHash;
  const runtimeHash = status.bridgeConfig.runtimeHash;
  const childHash = status.childRuntime.bridgeConfigHash;

  const checks = [
    {
      name: 'runtime_config_copied',
      ok: Boolean(sourceHash && runtimeHash && sourceHash === runtimeHash),
      detail: { sourceHash, runtimeHash }
    },
    {
      name: 'child_runtime_running',
      ok: Boolean(status.childRuntime.running),
      detail: {
        startedAt: status.childRuntime.startedAt,
        commit: status.childRuntime.commit
      }
    },
    {
      name: 'child_loaded_runtime_config',
      ok: Boolean(runtimeHash && childHash && runtimeHash === childHash),
      detail: {
        runtimeHash,
        childHash
      }
    },
    {
      name: 'child_config_status_available',
      ok: Boolean(childConfigStatus?.ok),
      detail: childConfigError ? { error: childConfigError } : { available: true }
    },
    {
      name: 'expected_config_resolved',
      ok: Boolean(expectedConfig.ok),
      detail: expectedConfig.ok ? { environment: expectedConfig.environment, projectUrl: expectedConfig.projectUrl } : expectedConfig
    }
  ];

  if (childConfigStatus?.ok && expectedConfig.ok) {
    checks.push(
      {
        name: 'child_uses_runtime_config_path',
        ok: childConfigStatus.bridge?.configPath === runtimeBridgeConfig,
        detail: {
          expected: runtimeBridgeConfig,
          actual: childConfigStatus.bridge?.configPath
        }
      },
      {
        name: 'child_project_url_matches_expected',
        ok: childConfigStatus.projectUrl === expectedConfig.projectUrl,
        detail: {
          expected: expectedConfig.projectUrl,
          actual: childConfigStatus.projectUrl
        }
      },
      {
        name: 'child_match_url_prefixes_match_expected',
        ok: arraysEqual(childConfigStatus.matchUrlPrefixes || [], expectedConfig.matchUrlPrefixes || []),
        detail: {
          expected: expectedConfig.matchUrlPrefixes,
          actual: childConfigStatus.matchUrlPrefixes
        }
      }
    );
  }

  const ok = checks.every((check) => check.ok);

  return {
    ok,
    code: ok ? 'PRODUCT_RUNTIME_SELF_CHECK_OK' : 'PRODUCT_RUNTIME_SELF_CHECK_FAILED',
    readsChromeToken: false,
    readsRemoteErp: false,
    autoFixAttempted: {
      syncProductMcp: true,
      syncBridgeConfig: true,
      restartChildRuntimeOnChange: true
    },
    sync: syncResult
      ? {
          ok: true,
          ...syncResult
        }
      : {
          ok: false,
          error: syncError
        },
    expectedConfig,
    effectiveConfig: childConfigStatus
      ? {
          environment: childConfigStatus.environment,
          projectUrl: childConfigStatus.projectUrl,
          matchUrlPrefixes: childConfigStatus.matchUrlPrefixes,
          tokenStorageKey: childConfigStatus.tokenStorageKey,
          remoteMcpMode: childConfigStatus.remoteMcpMode,
          remoteMcpUrl: childConfigStatus.remoteMcpUrl,
          configPath: childConfigStatus.bridge?.configPath,
          bridgeVersion: childConfigStatus.bridge?.version
        }
      : null,
    checks,
    runtime: status,
    agentGuidance: ok
      ? {
          conclusion: 'Runtime and bridge config are active. Continue with product_auth_status when ERP login state is needed.',
          nextToolCall: {
            name: 'product_auth_status',
            arguments: {}
          }
        }
      : {
          conclusion:
            'Runtime self-check failed after automatic refresh. Do not ask the user to inspect hashes or files. If a second self-check in the same thread still fails, ask the user only to reconnect/restart Codex or the plugin, then continue in this thread.',
          nextToolCall: {
            name: 'product_runtime_self_check',
            arguments: {}
          }
        }
  };
}

function proxyTools() {
  return [
    {
      name: 'product_runtime_self_check',
      title: 'Product MCP Runtime Self Check',
      description:
        'Self-check and self-heal the Product MCP runtime without reading Chrome or ERP token. Verifies plugin config hashes, child runtime config, effective project URL, and URL prefixes so the AI can report the conclusion instead of asking the user to validate.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false
      }
    },
    {
      name: 'product_runtime_status',
      title: 'Product MCP Runtime Status',
      description: 'Show the plugin proxy, Product MCP checkout, update cache, and child runtime status without reading the ERP token.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false
      }
    },
    {
      name: 'product_runtime_refresh',
      title: 'Refresh Product MCP Runtime',
      description:
        'Check the fixed Product MCP Git repository, rebuild if needed, and restart only the Product MCP child runtime while preserving the current Codex thread.',
      inputSchema: {
        type: 'object',
        properties: {
          restart: {
            type: 'boolean',
            description: 'Restart the child runtime even when the Product MCP checkout did not change.'
          }
        },
        additionalProperties: false
      }
    }
  ];
}

function isProxyTool(name) {
  return proxyTools().some((tool) => tool.name === name);
}

function isConnectionError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /not connected|connection.*closed|transport.*closed|stdio/i.test(message);
}

async function listTools() {
  await syncProductMcp({ allowChildRestart: false });
  const child = await ensureChildRuntime();
  const result = await child.listTools();
  childToolsCache = result.tools ?? [];

  return {
    ...result,
    tools: [...childToolsCache, ...proxyTools()]
  };
}

async function callChildTool(name, args) {
  await syncProductMcp({ allowChildRestart: false });

  let child = await ensureChildRuntime();
  try {
    return await child.callTool({ name, arguments: args });
  } catch (error) {
    if (!isConnectionError(error)) {
      throw error;
    }

    await withRuntimeLock(async () => {
      await restartChildRuntime('child runtime connection was closed');
    });
    child = await ensureChildRuntime();
    return child.callTool({ name, arguments: args });
  }
}

async function callTool(request) {
  const name = request.params.name;
  const args = request.params.arguments ?? {};

  if (name === 'product_runtime_self_check') {
    return jsonResult(await runtimeSelfCheck());
  }

  if (name === 'product_runtime_status') {
    return jsonResult(runtimeStatus());
  }

  if (name === 'product_runtime_refresh') {
    const syncResult = await syncProductMcp({ force: true });
    let restarted = syncResult.restarted;

    if (args.restart === true && childClient && !restarted) {
      await withRuntimeLock(async () => {
        await restartChildRuntime('manual product_runtime_refresh restart');
      });
      restarted = true;
    }

    return jsonResult(
      runtimeStatus({
        refresh: {
          ...syncResult,
          restarted
        }
      })
    );
  }

  if (isProxyTool(name)) {
    return jsonResult({
      error: `Proxy tool ${name} is declared but not implemented.`
    });
  }

  return callChildTool(name, args);
}

async function startProxyServer() {
  const server = new sdk.Server(
    {
      name: 'erp-product-runtime-proxy',
      version: proxyVersion
    },
    {
      capabilities: {
        tools: {
          listChanged: true
        }
      },
      instructions:
        'ERP Product proxy. Use product_auth_status before ERP backend operations. Product MCP runtime updates can be refreshed inside this proxy without starting a new Codex thread.'
    }
  );

  server.setRequestHandler(sdk.ListToolsRequestSchema, listTools);
  server.setRequestHandler(sdk.CallToolRequestSchema, callTool);

  serverInstance = server;

  const transport = new sdk.StdioServerTransport();
  await server.connect(transport);
}

async function shutdown() {
  await stopChildRuntime();
}

process.on('SIGINT', () => {
  shutdown().finally(() => process.exit(0));
});
process.on('SIGTERM', () => {
  shutdown().finally(() => process.exit(0));
});

syncRuntimeBridgeConfig();
productMcp = resolveProductMcp();
productMcpDir = productMcp.dir;
ensureProductMcp(productMcp);
lastSyncMs = Date.now();
lastSyncStatus = {
  checkedAt: new Date(lastSyncMs).toISOString(),
  checked: true,
  updated: productMcp.updated,
  source: productMcp.source,
  error: null
};

await loadSdk();
await startProxyServer();
