import { createRequire } from 'node:module';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const bundledPluginRoot = dirname(scriptDir);
const launcherVersion = '0.3.7';
const pluginRuntimeRepoUrl = 'https://github.com/Bohaohao/erp-product-plugin.git';
const pluginRuntimeRef = 'master';
const productMcpRepoUrl = 'https://github.com/Bohaohao/product-mcp.git';
const productMcpRef = 'master';
const cachedPluginRuntime = join(homedir(), '.erp-product', 'erp-product-plugin-runtime');
const cachedProductMcp = join(homedir(), '.erp-product', 'product-mcp');
const siblingProductMcp = resolve(bundledPluginRoot, '..', '..', '..', 'product-mcp');
const runtimeUpdateCheckIntervalMs = 5 * 60 * 1000;
const posixPathEntries = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];

let sdk;
let selectedRuntime;
let runtimeClient;
let runtimeTransport;
let runtimeStartedAt;
let runtimeRestartCount = 0;
let pendingRuntimeRestart = null;
let childToolsCache = [];
let lastSyncMs = 0;
let lastSyncStatus = {
  checkedAt: null,
  checked: false,
  updated: false,
  source: null,
  error: null
};
let runtimeLock = Promise.resolve();
let serverInstance;

function run(command, args, cwd, options = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: processEnv(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });

  if (result.error) throw result.error;

  if (options.logOutput !== false) {
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }

  if (result.status !== 0) {
    if (options.logOutput === false && result.stderr) process.stderr.write(result.stderr);
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }

  return result.stdout?.trim() ?? '';
}

function processEnv() {
  const env = { ...process.env };
  if (process.platform !== 'win32') {
    const delimiter = ':';
    const existingPath = env.PATH || env.Path || '';
    const pathParts = [...posixPathEntries, ...existingPath.split(delimiter)].filter(Boolean);
    env.PATH = [...new Set(pathParts)].join(delimiter);
  }
  return env;
}

function runNpm(args, cwd) {
  if (process.platform === 'win32') {
    return run('cmd', ['/d', '/s', '/c', 'npm', ...args], cwd);
  }

  return run('npm', args, cwd);
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

function productMcpRuntimeDependency(dir) {
  return join(dir, 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json');
}

function hasProductMcp(dir) {
  return existsSync(join(dir, 'package.json'));
}

function hasPluginRuntimeCheckout(dir) {
  return (
    existsSync(runtimeEntryForPluginRoot(join(dir, 'plugins', 'erp-product'))) &&
    existsSync(join(dir, 'plugins', 'erp-product', 'config', 'product-token-bridge.config.json')) &&
    existsSync(join(dir, 'plugins', 'erp-product', '.codex-plugin', 'plugin.json'))
  );
}

function runtimeEntryForPluginRoot(pluginRoot) {
  return join(pluginRoot, 'runtime', 'product-runtime-proxy.mjs');
}

function pluginRootForRuntimeCheckout(dir) {
  return join(dir, 'plugins', 'erp-product');
}

function selectionForPluginRoot(pluginRoot, source, checkoutRoot = null, updated = false, error = null) {
  return {
    pluginRoot,
    entry: runtimeEntryForPluginRoot(pluginRoot),
    source,
    checkoutRoot,
    commit: checkoutRoot ? gitHeadSafe(checkoutRoot) : gitHeadSafe(resolve(pluginRoot, '..', '..')),
    updated,
    error
  };
}

function resolveProductMcpForSdk() {
  try {
    if (!hasProductMcp(cachedProductMcp)) {
      mkdirSync(dirname(cachedProductMcp), { recursive: true });
      run('git', ['clone', '--branch', productMcpRef, productMcpRepoUrl, cachedProductMcp], dirname(cachedProductMcp));
    } else if (existsSync(join(cachedProductMcp, '.git'))) {
      run('git', ['remote', 'set-url', 'origin', productMcpRepoUrl], cachedProductMcp);
      run('git', ['fetch', '--prune', 'origin'], cachedProductMcp);
      run('git', ['pull', '--ff-only', 'origin', productMcpRef], cachedProductMcp);
    }

    return cachedProductMcp;
  } catch (error) {
    process.stderr.write(`Product MCP SDK checkout update failed: ${error instanceof Error ? error.message : String(error)}\n`);
    if (hasProductMcp(cachedProductMcp)) return cachedProductMcp;
    if (hasProductMcp(siblingProductMcp)) return siblingProductMcp;
    throw error;
  }
}

function ensureProductMcpSdk() {
  const productMcpDir = resolveProductMcpForSdk();
  if (!existsSync(productMcpRuntimeDependency(productMcpDir))) {
    runNpm(['install', '--omit=dev'], productMcpDir);
  }
  return productMcpDir;
}

function importFromProductMcp(productMcpDir, specifier) {
  const requireFromProductMcp = createRequire(join(productMcpDir, 'package.json'));
  return import(pathToFileURL(requireFromProductMcp.resolve(specifier)).href);
}

async function loadSdk() {
  const productMcpDir = ensureProductMcpSdk();
  const [serverModule, serverStdioModule, clientModule, clientStdioModule, typesModule] = await Promise.all([
    importFromProductMcp(productMcpDir, '@modelcontextprotocol/sdk/server/index.js'),
    importFromProductMcp(productMcpDir, '@modelcontextprotocol/sdk/server/stdio.js'),
    importFromProductMcp(productMcpDir, '@modelcontextprotocol/sdk/client/index.js'),
    importFromProductMcp(productMcpDir, '@modelcontextprotocol/sdk/client/stdio.js'),
    importFromProductMcp(productMcpDir, '@modelcontextprotocol/sdk/types.js')
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

function resolveBundledRuntime(error = null) {
  const bundled = selectionForPluginRoot(bundledPluginRoot, 'bundled runtime fallback', null, false, error);
  if (!existsSync(bundled.entry)) {
    throw new Error(`Bundled ERP Product runtime is missing: ${bundled.entry}`);
  }
  return bundled;
}

function resolvePluginRuntime() {
  const sourceMode = process.env.ERP_PRODUCT_PLUGIN_RUNTIME_SOURCE?.trim().toLowerCase();
  if (sourceMode === 'bundled') return resolveBundledRuntime();

  try {
    let updated = false;
    if (existsSync(join(cachedPluginRuntime, '.git'))) {
      const before = gitHead(cachedPluginRuntime);
      run('git', ['remote', 'set-url', 'origin', pluginRuntimeRepoUrl], cachedPluginRuntime);
      run('git', ['fetch', '--prune', 'origin'], cachedPluginRuntime);
      run('git', ['pull', '--ff-only', 'origin', pluginRuntimeRef], cachedPluginRuntime);
      const after = gitHead(cachedPluginRuntime);
      updated = before !== after;
    } else if (!existsSync(cachedPluginRuntime)) {
      mkdirSync(dirname(cachedPluginRuntime), { recursive: true });
      run('git', ['clone', '--branch', pluginRuntimeRef, pluginRuntimeRepoUrl, cachedPluginRuntime], dirname(cachedPluginRuntime));
      updated = true;
    } else {
      throw new Error(`Cached ERP Product runtime is not a git checkout: ${cachedPluginRuntime}`);
    }

    if (!hasPluginRuntimeCheckout(cachedPluginRuntime)) {
      throw new Error(`ERP Product runtime checkout is incomplete: ${cachedPluginRuntime}`);
    }

    return selectionForPluginRoot(
      pluginRootForRuntimeCheckout(cachedPluginRuntime),
      updated ? 'git update' : 'git checkout',
      cachedPluginRuntime,
      updated
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`ERP Product runtime update failed: ${message}\n`);
    if (hasPluginRuntimeCheckout(cachedPluginRuntime)) {
      return selectionForPluginRoot(
        pluginRootForRuntimeCheckout(cachedPluginRuntime),
        'cached runtime fallback',
        cachedPluginRuntime,
        false,
        message
      );
    }
    return resolveBundledRuntime(message);
  }
}

function withRuntimeLock(task) {
  const next = runtimeLock.then(task, task);
  runtimeLock = next.catch(() => undefined);
  return next;
}

async function stopRuntimeChild() {
  const client = runtimeClient;
  const transport = runtimeTransport;
  runtimeClient = undefined;
  runtimeTransport = undefined;
  runtimeStartedAt = undefined;
  childToolsCache = [];

  try {
    await client?.close();
  } catch (error) {
    process.stderr.write(`Failed to close ERP Product runtime client: ${error instanceof Error ? error.message : String(error)}\n`);
  }

  try {
    await transport?.close?.();
  } catch (error) {
    process.stderr.write(`Failed to close ERP Product runtime transport: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

async function startRuntimeChild() {
  selectedRuntime ??= resolvePluginRuntime();

  const transport = new sdk.StdioClientTransport({
    command: process.execPath,
    args: [selectedRuntime.entry],
    cwd: selectedRuntime.pluginRoot,
    stderr: 'inherit'
  });
  const client = new sdk.Client({ name: 'erp-product-runtime-launcher-child', version: launcherVersion });
  await client.connect(transport);

  runtimeClient = client;
  runtimeTransport = transport;
  runtimeStartedAt = new Date().toISOString();

  runtimeTransport.onerror = (error) => {
    process.stderr.write(`ERP Product runtime transport error: ${error.message}\n`);
  };
  runtimeTransport.onclose = () => {
    if (runtimeTransport === transport) {
      runtimeClient = undefined;
      runtimeTransport = undefined;
      runtimeStartedAt = undefined;
      childToolsCache = [];
    }
  };

  process.stderr.write(`ERP Product runtime proxy started: ${selectedRuntime.entry}\n`);
}

async function restartRuntimeChild(reason) {
  process.stderr.write(`Restarting ERP Product runtime proxy: ${reason}\n`);
  await stopRuntimeChild();
  await startRuntimeChild();
  runtimeRestartCount += 1;
  pendingRuntimeRestart = null;
}

async function ensureRuntimeChild() {
  if (runtimeClient) return runtimeClient;

  return withRuntimeLock(async () => {
    if (!runtimeClient) await startRuntimeChild();
    return runtimeClient;
  });
}

async function syncPluginRuntime(options = {}) {
  const force = Boolean(options.force);
  const allowChildRestart = options.allowChildRestart !== false;
  const now = Date.now();
  if (!force && now - lastSyncMs < runtimeUpdateCheckIntervalMs) {
    return {
      checked: false,
      updated: false,
      restarted: false,
      reason: 'interval_not_elapsed'
    };
  }

  return withRuntimeLock(async () => {
    const lockedNow = Date.now();
    if (!force && lockedNow - lastSyncMs < runtimeUpdateCheckIntervalMs) {
      return {
        checked: false,
        updated: false,
        restarted: false,
        reason: 'interval_not_elapsed'
      };
    }

    try {
      const beforeRuntime = selectedRuntime;
      const nextRuntime = resolvePluginRuntime();
      selectedRuntime = nextRuntime;

      const runtimeChanged =
        Boolean(runtimeClient) &&
        Boolean(beforeRuntime) &&
        (beforeRuntime.entry !== nextRuntime.entry || beforeRuntime.commit !== nextRuntime.commit);
      let restarted = false;

      if (runtimeChanged) {
        const reason = `ERP Product runtime changed from ${beforeRuntime?.commit || beforeRuntime?.source || 'unknown'} to ${
          nextRuntime.commit || nextRuntime.source
        }`;
        if (allowChildRestart) {
          await restartRuntimeChild(reason);
          restarted = true;
          await serverInstance?.sendToolListChanged?.().catch(() => undefined);
        } else {
          pendingRuntimeRestart = {
            reason,
            detectedAt: new Date().toISOString(),
            before: {
              source: beforeRuntime?.source,
              entry: beforeRuntime?.entry,
              commit: beforeRuntime?.commit
            },
            after: {
              source: nextRuntime.source,
              entry: nextRuntime.entry,
              commit: nextRuntime.commit
            },
            note:
              'ERP Product runtime proxy update was deferred to preserve the active workflow and child token cache. Call product_runtime_self_check or product_runtime_launcher_refresh to apply it.'
          };
        }
      }

      lastSyncMs = Date.now();
      lastSyncStatus = {
        checkedAt: new Date(lastSyncMs).toISOString(),
        checked: true,
        updated: nextRuntime.updated || runtimeChanged,
        source: nextRuntime.source,
        error: nextRuntime.error
      };

      return {
        checked: true,
        updated: nextRuntime.updated || runtimeChanged,
        restarted,
        restartDeferred: Boolean(pendingRuntimeRestart),
        source: nextRuntime.source,
        error: nextRuntime.error,
        before: beforeRuntime
          ? {
              source: beforeRuntime.source,
              entry: beforeRuntime.entry,
              commit: beforeRuntime.commit
            }
          : null,
        after: {
          source: nextRuntime.source,
          entry: nextRuntime.entry,
          commit: nextRuntime.commit
        }
      };
    } catch (error) {
      lastSyncMs = Date.now();
      lastSyncStatus = {
        checkedAt: new Date(lastSyncMs).toISOString(),
        checked: true,
        updated: false,
        source: selectedRuntime?.source ?? null,
        error: error instanceof Error ? error.message : String(error)
      };
      throw error;
    }
  });
}

function launcherStatus(extra = {}) {
  const now = Date.now();
  return {
    ok: true,
    readsChromeToken: false,
    readsRemoteErp: false,
    launcher: {
      name: 'erp-product-runtime-launcher',
      version: launcherVersion,
      pluginRoot: bundledPluginRoot,
      repoUrl: pluginRuntimeRepoUrl,
      ref: pluginRuntimeRef,
      cachedDir: cachedPluginRuntime,
      updateCheckIntervalSeconds: runtimeUpdateCheckIntervalMs / 1000
    },
    selectedRuntime: selectedRuntime
      ? {
          source: selectedRuntime.source,
          pluginRoot: selectedRuntime.pluginRoot,
          entry: selectedRuntime.entry,
          checkoutRoot: selectedRuntime.checkoutRoot,
          commit: selectedRuntime.commit,
          error: selectedRuntime.error
        }
      : null,
    runtimeChild: {
      running: Boolean(runtimeClient),
      pid: runtimeTransport?.pid ?? null,
      startedAt: runtimeStartedAt ?? null,
      restartCount: runtimeRestartCount,
      pendingRestart: pendingRuntimeRestart,
      cachedToolCount: childToolsCache.length
    },
    sync: {
      lastSync: lastSyncStatus,
      nextAutomaticCheckInSeconds: Math.max(0, Math.ceil((runtimeUpdateCheckIntervalMs - (now - lastSyncMs)) / 1000))
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

function launcherTools() {
  return [
    {
      name: 'product_runtime_launcher_status',
      title: 'Product Runtime Launcher Status',
      description:
        'Show the stable ERP Product runtime launcher status without reading Chrome, token cache, or the remote ERP backend.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false
      }
    },
    {
      name: 'product_runtime_launcher_refresh',
      title: 'Refresh Product Runtime Launcher',
      description:
        'Force-check the fixed ERP Product plugin runtime Git repository and restart the runtime proxy only when needed, without starting a new Codex thread.',
      inputSchema: {
        type: 'object',
        properties: {
          restart: {
            type: 'boolean',
            description: 'Restart the runtime proxy even when the plugin runtime checkout did not change.'
          }
        },
        additionalProperties: false
      }
    }
  ];
}

function isLauncherTool(name) {
  return launcherTools().some((tool) => tool.name === name);
}

function isConnectionError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /not connected|connection.*closed|transport.*closed|stdio/i.test(message);
}

async function listTools() {
  await syncPluginRuntime({ allowChildRestart: false });
  const child = await ensureRuntimeChild();
  const result = await child.listTools();
  childToolsCache = result.tools ?? [];

  return {
    ...result,
    tools: [...childToolsCache, ...launcherTools()]
  };
}

async function callChildTool(name, args, options = {}) {
  await syncPluginRuntime({
    force: Boolean(options.forceRuntimeSync),
    allowChildRestart: options.allowRuntimeRestart !== false
  });

  let child = await ensureRuntimeChild();
  try {
    return await child.callTool({ name, arguments: args });
  } catch (error) {
    if (!isConnectionError(error)) throw error;

    await withRuntimeLock(async () => {
      await restartRuntimeChild('runtime proxy connection was closed');
    });
    child = await ensureRuntimeChild();
    return child.callTool({ name, arguments: args });
  }
}

async function callTool(request) {
  const name = request.params.name;
  const args = request.params.arguments ?? {};

  if (name === 'product_runtime_launcher_status') {
    return jsonResult(launcherStatus());
  }

  if (name === 'product_runtime_launcher_refresh') {
    const syncResult = await syncPluginRuntime({ force: true, allowChildRestart: true });
    let restarted = syncResult.restarted;
    if (args.restart === true && runtimeClient && !restarted) {
      await withRuntimeLock(async () => {
        await restartRuntimeChild('manual product_runtime_launcher_refresh restart');
      });
      restarted = true;
    }

    return jsonResult(
      launcherStatus({
        refresh: {
          ...syncResult,
          restarted
        }
      })
    );
  }

  if (isLauncherTool(name)) {
    return jsonResult({
      error: `Launcher tool ${name} is declared but not implemented.`
    });
  }

  const shouldApplyRuntimeUpdate = name === 'product_runtime_self_check' || name === 'product_runtime_refresh';
  return callChildTool(name, args, {
    forceRuntimeSync: shouldApplyRuntimeUpdate,
    allowRuntimeRestart: shouldApplyRuntimeUpdate
  });
}

async function startLauncherServer() {
  const server = new sdk.Server(
    {
      name: 'erp-product-runtime-launcher',
      version: launcherVersion
    },
    {
      capabilities: {
        tools: {
          listChanged: true
        }
      },
      instructions:
        'ERP Product runtime launcher. It keeps a stable Codex MCP entry, updates the plugin runtime proxy from the fixed Git repository, and defers routine restarts to preserve active product workflows.'
    }
  );

  server.setRequestHandler(sdk.ListToolsRequestSchema, listTools);
  server.setRequestHandler(sdk.CallToolRequestSchema, callTool);

  serverInstance = server;

  const transport = new sdk.StdioServerTransport();
  await server.connect(transport);
}

async function shutdown() {
  await stopRuntimeChild();
}

process.on('SIGINT', () => {
  shutdown().finally(() => process.exit(0));
});
process.on('SIGTERM', () => {
  shutdown().finally(() => process.exit(0));
});

selectedRuntime = resolvePluginRuntime();
await loadSdk();
await startLauncherServer();
