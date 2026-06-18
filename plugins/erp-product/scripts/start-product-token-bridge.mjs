import { createRequire } from 'node:module';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pluginRoot = dirname(scriptDir);
const productMcpRepoUrl = 'https://github.com/Bohaohao/product-mcp.git';
const productMcpRef = 'master';
const siblingProductMcp = resolve(pluginRoot, '..', '..', '..', 'product-mcp');
const cachedProductMcp = join(homedir(), '.erp-product', 'product-mcp');
const bridgeConfig = join(pluginRoot, 'config', 'product-token-bridge.config.json');
const proxyVersion = '0.2.5';
const runtimeUpdateCheckIntervalMs = 5 * 60 * 1000;

let sdk;
let serverInstance;
let productMcp;
let productMcpDir;
let childClient;
let childTransport;
let childStartedAt;
let childRuntimeCommit;
let childToolsCache = [];
let restartCount = 0;
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
    env: process.env,
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

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
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

  process.stderr.write(`Using Product MCP (${selection.source}): ${selection.dir}\n`);

  if (selection.updated || !existsSync(bridgeEntry)) {
    run(npmCommand(), ['ci'], selection.dir);
    run(npmCommand(), ['run', 'build'], selection.dir);
  } else if (!existsSync(runtimeDependency)) {
    run(npmCommand(), ['ci', '--omit=dev'], selection.dir);
  }
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
  return Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined));
}

async function stopChildRuntime() {
  const client = childClient;
  const transport = childTransport;
  childClient = undefined;
  childTransport = undefined;
  childToolsCache = [];
  childStartedAt = undefined;
  childRuntimeCommit = undefined;

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

  const transport = new sdk.StdioClientTransport({
    command: process.execPath,
    args: [bridgeEntry, '--config', bridgeConfig],
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
    }
  };

  await client.connect(transport);

  childClient = client;
  childTransport = transport;
  childStartedAt = new Date().toISOString();
  childRuntimeCommit = gitHeadSafe(productMcpDir);
  childToolsCache = [];

  process.stderr.write(`Product MCP child runtime started: ${productMcpDir}\n`);
}

async function restartChildRuntime(reason) {
  process.stderr.write(`Restarting Product MCP child runtime: ${reason}\n`);
  await stopChildRuntime();
  await startChildRuntime();
  restartCount += 1;
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

    const beforeDir = productMcpDir;
    const beforeCommit = gitHeadSafe(productMcpDir);

    try {
      const nextProductMcp = resolveProductMcp();
      ensureProductMcp(nextProductMcp);

      productMcp = nextProductMcp;
      productMcpDir = nextProductMcp.dir;

      const afterCommit = gitHeadSafe(productMcpDir);
      const updated = nextProductMcp.updated || beforeDir !== productMcpDir || beforeCommit !== afterCommit;
      let restarted = false;

      if (updated && childClient) {
        await restartChildRuntime('Product MCP checkout changed');
        restarted = true;
        await serverInstance?.sendToolListChanged?.().catch(() => undefined);
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
      restartCount,
      cachedToolCount: childToolsCache.length
    },
    bridgeConfig,
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

function proxyTools() {
  return [
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
  await syncProductMcp();
  const child = await ensureChildRuntime();
  const result = await child.listTools();
  childToolsCache = result.tools ?? [];

  return {
    ...result,
    tools: [...childToolsCache, ...proxyTools()]
  };
}

async function callChildTool(name, args) {
  await syncProductMcp();

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
