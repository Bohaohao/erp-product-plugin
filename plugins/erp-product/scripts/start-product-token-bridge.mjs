import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const bundledPluginRoot = dirname(scriptDir);
const launcherVersion = '0.3.21';
const pluginRuntimeRepoUrl = 'https://github.com/Bohaohao/erp-product-plugin.git';
const pluginRuntimeRef = 'master';
const productMcpRepoUrl = 'https://github.com/Bohaohao/product-mcp.git';
const productMcpRef = 'master';
const cachedPluginRuntime = join(homedir(), '.erp-product', 'erp-product-plugin-runtime');
const cachedProductMcp = join(homedir(), '.erp-product', 'product-mcp');
const npmCacheDir = join(homedir(), '.erp-product', 'npm-cache');
const siblingProductMcp = resolve(bundledPluginRoot, '..', '..', '..', 'product-mcp');
const runtimeUpdateCheckIntervalMs = 5 * 60 * 1000;
const dependencyRetryDelayMs = 60 * 1000;
const externalCommandTimeoutMs = positiveIntegerFromEnv('ERP_PRODUCT_COMMAND_TIMEOUT_MS', 90_000);
const npmInstallTimeoutMs = positiveIntegerFromEnv('ERP_PRODUCT_NPM_INSTALL_TIMEOUT_MS', 180_000);
const runtimeChildStartTimeoutMs = positiveIntegerFromEnv('ERP_PRODUCT_RUNTIME_CHILD_START_TIMEOUT_MS', 240_000);
const runtimeToolStatusTimeoutMs = positiveIntegerFromEnv('ERP_PRODUCT_RUNTIME_TOOL_STATUS_TIMEOUT_MS', 30_000);
const runtimeToolQueryTimeoutMs = positiveIntegerFromEnv('ERP_PRODUCT_RUNTIME_TOOL_QUERY_TIMEOUT_MS', 120_000);
const runtimeToolAuthTimeoutMs = positiveIntegerFromEnv('ERP_PRODUCT_RUNTIME_TOOL_AUTH_TIMEOUT_MS', 240_000);
const runtimeToolCreateTimeoutMs = positiveIntegerFromEnv('ERP_PRODUCT_RUNTIME_TOOL_CREATE_TIMEOUT_MS', 180_000);
const runtimeToolUploadTimeoutMs = positiveIntegerFromEnv('ERP_PRODUCT_RUNTIME_TOOL_UPLOAD_TIMEOUT_MS', 270_000);
const selfCheckReuseTtlMs = positiveIntegerFromEnv('ERP_PRODUCT_SELF_CHECK_REUSE_TTL_MS', 120_000);
const outputSnippetChars = 1600;
const posixPathEntries = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];

let sdk;
let sdkLoadPromise;
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
let launcherSelfCheckCache = null;
let launcherSelfCheckInFlight = null;
let runtimeLock = Promise.resolve();
let serverInstance;
let dependencyStatus = {
  ok: false,
  pending: false,
  checkedAt: null,
  stage: null,
  stageStartedAt: null,
  action: null,
  detail: null,
  error: null,
  diagnostic: null,
  warnings: []
};
let lastDependencyAttemptMs = 0;
let lastChildListError = null;

function positiveIntegerFromEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function commandLine(command, args = []) {
  return [command, ...args].map((part) => (/\s/.test(part) ? JSON.stringify(part) : part)).join(' ');
}

function snippet(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.length > outputSnippetChars ? text.slice(-outputSnippetChars) : text;
}

function classifyFailure(message, context = {}) {
  const text = `${message || ''} ${context.command || ''} ${(context.args || []).join(' ')}`.toLowerCase();
  if (context.timedOut || /etimedout|timed out|timeout/.test(text)) return 'timeout';
  if (/enoent|not recognized|command not found|no such file or directory/.test(text)) return 'command_not_found';
  if (/proxy|github\.com|failed to connect|couldn't connect|could not resolve host|connection refused|connection reset|econn|ssl|certificate/.test(text)) {
    return 'network_or_proxy';
  }
  if (/npm|node_modules|package-lock|dependency/.test(text)) return 'npm_or_dependency_install';
  if (/module not found|err_module_not_found|cannot find module|resolve/.test(text)) return 'sdk_resolution';
  if (/git|clone|fetch|pull|checkout|reset/.test(text)) return 'git_checkout';
  return 'runtime_preparation';
}

function diagnosticFromError(error, fallback = {}) {
  if (error?.diagnostic) return error.diagnostic;

  const message = error instanceof Error ? error.message : String(error);
  return {
    stage: fallback.stage || dependencyStatus.stage || 'unknown',
    action: fallback.action || dependencyStatus.action || null,
    reason: message,
    kind: classifyFailure(message, fallback),
    command: fallback.command ? commandLine(fallback.command, fallback.args || []) : fallback.commandLine || null,
    cwd: fallback.cwd || null,
    detail: fallback.detail || null,
    timeoutMs: fallback.timeoutMs || null,
    timedOut: Boolean(fallback.timedOut),
    exitCode: fallback.exitCode ?? null,
    signal: fallback.signal ?? null,
    stdout: snippet(fallback.stdout),
    stderr: snippet(fallback.stderr)
  };
}

function operationError(message, fallback = {}) {
  const error = new Error(message);
  error.diagnostic = diagnosticFromError(error, fallback);
  return error;
}

function markDependencyStage(stage, action, detail = {}) {
  dependencyStatus = {
    ...dependencyStatus,
    ok: false,
    pending: true,
    checkedAt: new Date().toISOString(),
    stage,
    stageStartedAt: new Date().toISOString(),
    action,
    detail,
    error: null,
    diagnostic: null
  };
}

function markDependencyReady() {
  dependencyStatus = {
    ...dependencyStatus,
    ok: true,
    pending: false,
    checkedAt: new Date().toISOString(),
    stage: 'ready',
    stageStartedAt: null,
    action: null,
    detail: null,
    error: null,
    diagnostic: null
  };
  return dependencyStatus;
}

function markDependencyError(error) {
  const diagnostic = diagnosticFromError(error);
  dependencyStatus = {
    ...dependencyStatus,
    ok: false,
    pending: false,
    checkedAt: new Date().toISOString(),
    error: diagnostic.reason,
    diagnostic
  };
  return dependencyStatus;
}

function recordDependencyWarning(error) {
  const diagnostic = diagnosticFromError(error);
  dependencyStatus = {
    ...dependencyStatus,
    warnings: [...(dependencyStatus.warnings || []).slice(-4), diagnostic]
  };
  return diagnostic;
}

function isRecoverableNpmInstallError(error) {
  const diagnostic = diagnosticFromError(error);
  const text = `${diagnostic.reason || ''}\n${diagnostic.stdout || ''}\n${diagnostic.stderr || ''}`.toLowerCase();
  return /enotempty|eexist|enotdir|directory not empty|rename/.test(text) && /node_modules|npm/.test(text);
}

function candidateNpmCleanupPaths(cwd, diagnostic) {
  const text = `${diagnostic.reason || ''}\n${diagnostic.stdout || ''}\n${diagnostic.stderr || ''}`;
  const candidates = new Set();
  const nodeModulesDir = join(cwd, 'node_modules');
  const pathPattern = /(?:^|\s)(?:path|dest)\s+([^\r\n]+)/gim;
  let match;

  while ((match = pathPattern.exec(text))) {
    const candidate = match[1].trim().replace(/^["']|["']$/g, '');
    if (candidate.includes('node_modules')) candidates.add(resolve(candidate));
  }

  try {
    if (existsSync(nodeModulesDir)) {
      for (const entry of readdirSync(nodeModulesDir)) {
        if (/^\.[^/\\]+-[A-Za-z0-9_-]+$/.test(entry)) {
          candidates.add(join(nodeModulesDir, entry));
        }
      }
    }
  } catch {
    // Ignore unreadable node_modules; the original npm error remains the source of truth.
  }

  const root = resolve(cwd);
  return [...candidates].filter((candidate) => {
    const resolved = resolve(candidate);
    return resolved === root || resolved.startsWith(`${root}${process.platform === 'win32' ? '\\' : '/'}`);
  });
}

function cleanDirtyNodeModules(cwd, diagnostic) {
  const cleaned = [];
  for (const target of candidateNpmCleanupPaths(cwd, diagnostic)) {
    try {
      if (!existsSync(target)) continue;
      rmSync(target, { recursive: true, force: true });
      cleaned.push(target);
    } catch (error) {
      process.stderr.write(`Failed to clean npm dependency artifact ${target}: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  return cleaned;
}

function isRecoverableNpmCacheError(error) {
  const diagnostic = diagnosticFromError(error);
  const text = `${diagnostic.reason || ''}\n${diagnostic.stdout || ''}\n${diagnostic.stderr || ''}`.toLowerCase();
  return /npm|_cacache|cache/.test(text) && /eacces|eperm|permission denied|file exists|eexist/.test(text);
}

function npmEnv(cacheDir = npmCacheDir) {
  mkdirSync(cacheDir, { recursive: true });
  return {
    npm_config_cache: cacheDir,
    NPM_CONFIG_CACHE: cacheDir,
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false'
  };
}

function dependencyFailureError(status = dependencyStatus) {
  const diagnostic = status.diagnostic || diagnosticFromError(status.error || 'ERP Product runtime dependencies are not ready.');
  const error = new Error(diagnostic.reason || 'ERP Product runtime dependencies are not ready.');
  error.diagnostic = diagnostic;
  return error;
}

function run(command, args, cwd, options = {}) {
  const timeoutMs = options.timeoutMs ?? externalCommandTimeoutMs;
  const stage = options.stage;
  const action = options.action || commandLine(command, args);
  if (stage) {
    markDependencyStage(stage, action, {
      command: commandLine(command, args),
      cwd,
      timeoutMs,
      ...(options.detail || {})
    });
  }

  const result = spawnSync(command, args, {
    cwd,
    env: {
      ...processEnv(),
      ...(options.env || {})
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs
  });

  if (result.error) {
    const timedOut = result.error?.code === 'ETIMEDOUT' || result.signal;
    throw operationError(
      timedOut ? `${action} timed out after ${Math.ceil(timeoutMs / 1000)}s.` : result.error.message,
      {
        stage,
        action,
        command,
        args,
        cwd,
        timeoutMs,
        timedOut,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
        detail: options.detail
      }
    );
  }

  if (options.logOutput !== false) {
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }

  if (result.status !== 0) {
    if (options.logOutput === false && result.stderr) process.stderr.write(result.stderr);
    throw operationError(`${action} failed with exit code ${result.status}.`, {
      stage,
      action,
      command,
      args,
      cwd,
      timeoutMs,
      exitCode: result.status,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
      detail: options.detail
    });
  }

  return result.stdout?.trim() ?? '';
}

function processEnv() {
  const env = { ...process.env };
  if (process.platform !== 'win32') {
    const delimiter = ':';
    const existingPath = env.PATH || env.Path || '';
    const pathParts = [...posixPathEntries, ...nodeManagerPathEntries(), ...existingPath.split(delimiter)].filter(Boolean);
    env.PATH = [...new Set(pathParts)].join(delimiter);
  }
  return env;
}

function nodeManagerPathEntries(home = homedir()) {
  const entries = [
    join(home, '.volta', 'bin'),
    join(home, '.asdf', 'shims'),
    join(home, '.nodenv', 'shims'),
    join(home, '.fnm'),
    join(home, '.local', 'bin'),
    join(home, '.local', 'share', 'mise', 'shims')
  ];
  const nvmNodeVersions = join(home, '.nvm', 'versions', 'node');

  try {
    if (existsSync(nvmNodeVersions)) {
      const nodeBins = readdirSync(nvmNodeVersions)
        .map((version) => join(nvmNodeVersions, version, 'bin'))
        .filter((entry) => existsSync(entry))
        .sort()
        .reverse();
      entries.push(...nodeBins);
    }
  } catch {
    // Ignore unreadable version-manager directories; PATH fallback still includes system locations.
  }

  return entries.filter((entry) => existsSync(entry));
}

function runNpm(args, cwd, options = {}) {
  const command = process.platform === 'win32' ? 'cmd' : 'npm';
  const commandArgs = process.platform === 'win32' ? ['/d', '/s', '/c', 'npm', ...args] : args;
  const baseNpmEnv = npmEnv();
  const baseOptions = {
    ...options,
    env: {
      ...baseNpmEnv,
      ...(options.env || {})
    },
    detail: {
      ...(options.detail || {}),
      npmCache: baseNpmEnv.npm_config_cache
    }
  };

  try {
    return run(command, commandArgs, cwd, baseOptions);
  } catch (error) {
    if (options.retryDirtyNodeModules !== false && isRecoverableNpmInstallError(error)) {
      const diagnostic = recordDependencyWarning(error);
      const cleaned = cleanDirtyNodeModules(cwd, diagnostic);
      if (!cleaned.length) throw error;
      diagnostic.cleanedArtifacts = cleaned;

      process.stderr.write(`Cleaned npm dependency artifacts after ${diagnostic.stage}: ${cleaned.join(', ')}\n`);
      return run(command, commandArgs, cwd, {
        ...baseOptions,
        stage: `${options.stage || 'npm_install'}_retry_after_clean`,
        action: `${options.action || 'npm install'} after cleaning dirty node_modules artifacts`,
        cleanedArtifacts: cleaned
      });
    }

    if (isRecoverableNpmCacheError(error)) {
      const diagnostic = recordDependencyWarning(error);
      const retryCacheDir = join(homedir(), '.erp-product', `npm-cache-retry-${Date.now()}`);
      process.stderr.write(`Switching npm cache after ${diagnostic.stage}: ${retryCacheDir}\n`);
      return run(command, commandArgs, cwd, {
        ...options,
        env: {
          ...npmEnv(retryCacheDir),
          ...(options.env || {})
        },
        detail: {
          ...(options.detail || {}),
          npmCache: retryCacheDir
        },
        stage: `${options.stage || 'npm_install'}_retry_with_isolated_cache`,
        action: `${options.action || 'npm install'} with an isolated ERP Product npm cache`
      });
    }

    throw error;
  }
}

function gitHead(dir, options = {}) {
  return run('git', ['rev-parse', 'HEAD'], dir, { logOutput: false, ...options });
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
      run('git', ['clone', '--branch', productMcpRef, productMcpRepoUrl, cachedProductMcp], dirname(cachedProductMcp), {
        stage: 'product_mcp_git_clone',
        action: 'clone Product MCP from GitHub',
        timeoutMs: externalCommandTimeoutMs
      });
    } else if (existsSync(join(cachedProductMcp, '.git'))) {
      run('git', ['remote', 'set-url', 'origin', productMcpRepoUrl], cachedProductMcp, {
        stage: 'product_mcp_git_remote',
        action: 'update Product MCP Git remote URL'
      });
      run('git', ['fetch', '--prune', 'origin'], cachedProductMcp, {
        stage: 'product_mcp_git_fetch',
        action: 'fetch Product MCP updates from GitHub'
      });
      run('git', ['reset', '--hard', `origin/${productMcpRef}`], cachedProductMcp, {
        stage: 'product_mcp_git_reset',
        action: 'reset Product MCP cache to remote branch'
      });
      run('git', ['pull', '--ff-only', 'origin', productMcpRef], cachedProductMcp, {
        stage: 'product_mcp_git_pull',
        action: 'pull Product MCP latest code from GitHub'
      });
    }

    return cachedProductMcp;
  } catch (error) {
    const diagnostic = recordDependencyWarning(error);
    process.stderr.write(`Product MCP SDK checkout update failed at ${diagnostic.stage}: ${diagnostic.reason}\n`);
    if (hasProductMcp(cachedProductMcp)) return cachedProductMcp;
    if (hasProductMcp(siblingProductMcp)) return siblingProductMcp;
    throw error;
  }
}

function ensureProductMcpSdk() {
  const productMcpDir = resolveProductMcpForSdk();
  if (!existsSync(productMcpRuntimeDependency(productMcpDir))) {
    runNpm(['install', '--omit=dev'], productMcpDir, {
      stage: 'product_mcp_npm_install',
      action: 'install Product MCP runtime dependencies',
      timeoutMs: npmInstallTimeoutMs
    });
  }
  return productMcpDir;
}

function importFromProductMcp(productMcpDir, specifier) {
  const requireFromProductMcp = createRequire(join(productMcpDir, 'package.json'));
  return import(pathToFileURL(requireFromProductMcp.resolve(specifier)).href);
}

async function loadSdk() {
  const productMcpDir = ensureProductMcpSdk();
  markDependencyStage('product_mcp_sdk_import', 'load Product MCP SDK modules', {
    cwd: productMcpDir,
    modules: ['@modelcontextprotocol/sdk/client/index.js', '@modelcontextprotocol/sdk/client/stdio.js']
  });

  let clientModule;
  let clientStdioModule;
  try {
    [clientModule, clientStdioModule] = await Promise.all([
      importFromProductMcp(productMcpDir, '@modelcontextprotocol/sdk/client/index.js'),
      importFromProductMcp(productMcpDir, '@modelcontextprotocol/sdk/client/stdio.js')
    ]);
  } catch (error) {
    throw operationError(error instanceof Error ? error.message : String(error), {
      stage: 'product_mcp_sdk_import',
      action: 'load Product MCP SDK modules',
      cwd: productMcpDir
    });
  }

  sdk = {
    Client: clientModule.Client,
    StdioClientTransport: clientStdioModule.StdioClientTransport
  };
}

function beginLauncherDependencyLoad(options = {}) {
  if (sdk) {
    markDependencyReady();
    return Promise.resolve(dependencyStatus);
  }

  const force = Boolean(options.force);
  const now = Date.now();
  if (!force && dependencyStatus.error && now - lastDependencyAttemptMs < dependencyRetryDelayMs) {
    return null;
  }

  if (!sdkLoadPromise) {
    lastDependencyAttemptMs = now;
    dependencyStatus = {
      ...dependencyStatus,
      ok: false,
      pending: true,
      checkedAt: new Date().toISOString(),
      stage: 'dependency_prepare_start',
      stageStartedAt: new Date().toISOString(),
      action: 'prepare ERP Product runtime dependencies',
      detail: null,
      error: null,
      diagnostic: null
    };

    sdkLoadPromise = (async () => {
      await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
      selectedRuntime ??= resolvePluginRuntime();
      await loadSdk();
      markDependencyReady();
      await serverInstance?.sendToolListChanged?.().catch(() => undefined);
      return dependencyStatus;
    })().catch(async (error) => {
      sdkLoadPromise = undefined;
      markDependencyError(error);
      await serverInstance?.sendToolListChanged?.().catch(() => undefined);
      return dependencyStatus;
    });
  }

  return sdkLoadPromise;
}

async function ensureLauncherDependencies(options = {}) {
  if (sdk) {
    markDependencyReady();
    return dependencyStatus;
  }

  const promise = beginLauncherDependencyLoad({ force: Boolean(options.force) });
  if (!promise) return dependencyStatus;

  if (options.wait === false) return dependencyStatus;

  const status = await promise;
  if (options.throwOnError && !status.ok) throw dependencyFailureError(status);
  return status;
}

function resolveBundledRuntime(error = null) {
  const bundled = selectionForPluginRoot(bundledPluginRoot, 'bundled runtime fallback', null, false, error);
  if (!existsSync(bundled.entry)) {
    throw operationError(`Bundled ERP Product runtime is missing: ${bundled.entry}`, {
      stage: 'plugin_runtime_bundled_validate',
      action: 'validate bundled ERP Product runtime fallback',
      cwd: bundledPluginRoot
    });
  }
  return bundled;
}

function resolvePluginRuntime() {
  const sourceMode = process.env.ERP_PRODUCT_PLUGIN_RUNTIME_SOURCE?.trim().toLowerCase();
  if (sourceMode === 'bundled') return resolveBundledRuntime();

  try {
    let updated = false;
    if (existsSync(join(cachedPluginRuntime, '.git'))) {
      const before = gitHead(cachedPluginRuntime, {
        stage: 'plugin_runtime_git_head',
        action: 'read ERP Product plugin runtime current commit'
      });
      run('git', ['remote', 'set-url', 'origin', pluginRuntimeRepoUrl], cachedPluginRuntime, {
        stage: 'plugin_runtime_git_remote',
        action: 'update ERP Product plugin runtime Git remote URL'
      });
      run('git', ['fetch', '--prune', 'origin'], cachedPluginRuntime, {
        stage: 'plugin_runtime_git_fetch',
        action: 'fetch ERP Product plugin runtime updates from GitHub'
      });
      run('git', ['reset', '--hard', `origin/${pluginRuntimeRef}`], cachedPluginRuntime, {
        stage: 'plugin_runtime_git_reset',
        action: 'reset ERP Product plugin runtime cache to remote branch'
      });
      run('git', ['pull', '--ff-only', 'origin', pluginRuntimeRef], cachedPluginRuntime, {
        stage: 'plugin_runtime_git_pull',
        action: 'pull ERP Product plugin runtime latest code from GitHub'
      });
      const after = gitHead(cachedPluginRuntime, {
        stage: 'plugin_runtime_git_head_after_update',
        action: 'read ERP Product plugin runtime commit after update'
      });
      updated = before !== after;
    } else if (!existsSync(cachedPluginRuntime)) {
      mkdirSync(dirname(cachedPluginRuntime), { recursive: true });
      run('git', ['clone', '--branch', pluginRuntimeRef, pluginRuntimeRepoUrl, cachedPluginRuntime], dirname(cachedPluginRuntime), {
        stage: 'plugin_runtime_git_clone',
        action: 'clone ERP Product plugin runtime from GitHub'
      });
      updated = true;
    } else {
      throw operationError(`Cached ERP Product runtime is not a git checkout: ${cachedPluginRuntime}`, {
        stage: 'plugin_runtime_cache_validate',
        action: 'validate ERP Product plugin runtime cache',
        cwd: cachedPluginRuntime
      });
    }

    if (!hasPluginRuntimeCheckout(cachedPluginRuntime)) {
      throw operationError(`ERP Product runtime checkout is incomplete: ${cachedPluginRuntime}`, {
        stage: 'plugin_runtime_cache_validate',
        action: 'validate ERP Product plugin runtime checkout',
        cwd: cachedPluginRuntime
      });
    }

    return selectionForPluginRoot(
      pluginRootForRuntimeCheckout(cachedPluginRuntime),
      updated ? 'git update' : 'git checkout',
      cachedPluginRuntime,
      updated
    );
  } catch (error) {
    const diagnostic = recordDependencyWarning(error);
    const message = diagnostic.reason;
    process.stderr.write(`ERP Product runtime update failed at ${diagnostic.stage}: ${message}\n`);
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
  await ensureLauncherDependencies({ wait: true, throwOnError: true });
  selectedRuntime ??= resolvePluginRuntime();
  markDependencyStage('runtime_child_start', 'start ERP Product runtime proxy child process', {
    entry: selectedRuntime.entry,
    cwd: selectedRuntime.pluginRoot
  });

  const transport = new sdk.StdioClientTransport({
    command: process.execPath,
    args: [selectedRuntime.entry],
    cwd: selectedRuntime.pluginRoot,
    stderr: 'pipe'
  });
  let childStderr = '';
  transport.stderr?.on('data', (chunk) => {
    const text = chunk.toString();
    childStderr = snippet(`${childStderr}\n${text}`);
    process.stderr.write(text);
  });
  const client = new sdk.Client({ name: 'erp-product-runtime-launcher-child', version: launcherVersion });
  try {
    await Promise.race([
      client.connect(transport),
      new Promise((_, reject) => {
        setTimeout(() => {
          reject(
            operationError(`ERP Product runtime proxy child startup timed out after ${Math.ceil(runtimeChildStartTimeoutMs / 1000)}s.`, {
              stage: 'runtime_child_start',
              action: 'connect to ERP Product runtime proxy child process',
              command: process.execPath,
              args: [selectedRuntime.entry],
              cwd: selectedRuntime.pluginRoot,
              timeoutMs: runtimeChildStartTimeoutMs,
              timedOut: true,
              stderr: childStderr
            })
          );
        }, runtimeChildStartTimeoutMs);
      })
    ]);
  } catch (error) {
    await transport.close?.().catch(() => undefined);
    if (error?.diagnostic) throw error;
    throw operationError(error instanceof Error ? error.message : String(error), {
      stage: 'runtime_child_start',
      action: 'connect to ERP Product runtime proxy child process',
      command: process.execPath,
      args: [selectedRuntime.entry],
      cwd: selectedRuntime.pluginRoot,
      stderr: childStderr
    });
  }

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

  markDependencyReady();
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
    dependencies: {
      sdkLoaded: Boolean(sdk),
      ...dependencyStatus,
      node: {
        version: process.version,
        execPath: process.execPath,
        platform: process.platform
      },
      lastChildListError
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

function parseJsonToolResult(result) {
  const text = result?.content?.find((item) => item.type === 'text')?.text;
  if (!text) {
    throw new Error('Tool returned no text JSON payload.');
  }

  return JSON.parse(text);
}

function isLauncherSelfCheckCacheFresh() {
  if (!launcherSelfCheckCache || pendingRuntimeRestart) return false;

  const ageMs = Date.now() - launcherSelfCheckCache.cachedAtMs;
  return (
    ageMs >= 0 &&
    ageMs < selfCheckReuseTtlMs &&
    launcherSelfCheckCache.runtimeRestartCount === runtimeRestartCount &&
    launcherSelfCheckCache.runtimeCommit === selectedRuntime?.commit &&
    launcherSelfCheckCache.runtimeEntry === selectedRuntime?.entry
  );
}

function withLauncherSelfCheckReuse(payload, source, cachedAtMs = launcherSelfCheckCache?.cachedAtMs ?? Date.now()) {
  return {
    ...payload,
    launcherSelfCheckReuse: {
      enabled: true,
      reused: source !== 'fresh',
      source,
      ttlSeconds: Math.ceil(selfCheckReuseTtlMs / 1000),
      cachedAt: new Date(cachedAtMs).toISOString(),
      ageSeconds: Math.max(0, Math.floor((Date.now() - cachedAtMs) / 1000)),
      forceRefreshSupported: true
    }
  };
}

async function forwardedRuntimeSelfCheckWithReuse(args = {}) {
  const forceRefresh = args.forceRefresh === true;

  if (!forceRefresh && isLauncherSelfCheckCacheFresh()) {
    return withLauncherSelfCheckReuse(launcherSelfCheckCache.payload, 'cache', launcherSelfCheckCache.cachedAtMs);
  }

  if (!forceRefresh && launcherSelfCheckInFlight) {
    const payload = await launcherSelfCheckInFlight;
    return withLauncherSelfCheckReuse(payload, 'in_flight');
  }

  const childArgs = forceRefresh ? { ...args, forceRefresh: true } : { ...args };
  if (!forceRefresh) delete childArgs.forceRefresh;

  launcherSelfCheckInFlight = callChildTool(
    'product_runtime_self_check',
    childArgs,
    {
      forceRuntimeSync: true,
      allowRuntimeRestart: true
    }
  )
    .then((result) => {
      const payload = parseJsonToolResult(result);
      if (payload?.ok === true) {
        launcherSelfCheckCache = {
          payload,
          cachedAtMs: Date.now(),
          runtimeRestartCount,
          runtimeCommit: selectedRuntime?.commit,
          runtimeEntry: selectedRuntime?.entry
        };
      }
      return payload;
    })
    .finally(() => {
      launcherSelfCheckInFlight = null;
    });

  const payload = await launcherSelfCheckInFlight;
  return withLauncherSelfCheckReuse(payload, 'fresh', Date.now());
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

function fallbackRuntimeTools() {
  return [
    {
      name: 'product_runtime_self_check',
      title: 'Product MCP Runtime Self Check',
      description:
        'Fallback self-check exposed by the ERP Product launcher when the Product MCP runtime is not ready yet. It does not read Chrome or ERP token.',
      inputSchema: {
        type: 'object',
        properties: {
          forceRefresh: {
            type: 'boolean',
            default: false,
            description: 'Bypass the short self-check reuse cache and run the full runtime refresh/check.'
          }
        },
        additionalProperties: false
      }
    },
    {
      name: 'product_runtime_status',
      title: 'Product MCP Runtime Status',
      description:
        'Fallback runtime status exposed by the ERP Product launcher when the Product MCP runtime is not ready yet. It does not read Chrome or ERP token.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false
      }
    },
    {
      name: 'product_auth_status',
      title: 'ERP Login Status',
      description:
        'Fallback login status tool exposed by the ERP Product launcher when the Product MCP runtime is not ready yet. It explains why Chrome login cannot be checked yet.',
      inputSchema: {
        type: 'object',
        properties: {
          forceRefresh: {
            type: 'boolean',
            default: false,
            description: 'Ignored by the fallback tool. Present for compatibility with Product MCP.'
          }
        },
        additionalProperties: false
      }
    },
    {
      name: 'product_bridge_config_status',
      title: 'Product bridge config status',
      description:
        'Fallback declaration for the Product MCP bridge config status tool. The launcher forwards calls to the runtime child once ready.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false
      }
    },
    {
      name: 'product_precheck_package',
      title: 'Precheck product package',
      description:
        'Fallback declaration for prechecking a local ERP product material package before upload/create. The real Product MCP runtime validates the full input schema.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: true
      }
    },
    {
      name: 'product_upload_file',
      title: 'Upload product file',
      description:
        'Fallback declaration for uploading a local product file to OSS through the Product MCP runtime. The real Product MCP runtime validates the full input schema.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: true
      }
    },
    {
      name: 'product_check_name_duplicate',
      title: 'Check duplicate product name',
      description:
        'Fallback declaration for checking whether an ERP product with the same Chinese product name already exists. Call after package required-field validation passes and before upload/create.',
      inputSchema: {
        type: 'object',
        properties: {
          productNameCn: {
            type: 'string',
            description: 'Chinese product name from the package draft.'
          }
        },
        required: ['productNameCn'],
        additionalProperties: true
      }
    },
    {
      name: 'product_create',
      title: 'Create product',
      description:
        'Fallback declaration for creating an ERP product through the Product MCP runtime. The real Product MCP runtime validates the full input schema.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: true
      }
    },
    {
      name: 'product_list_categories',
      title: 'List product categories',
      description:
        'Fallback declaration for querying ERP product categories through the Product MCP runtime.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: true
      }
    },
    {
      name: 'product_get_category_config',
      title: 'Get product category config',
      description:
        'Fallback declaration for querying ERP category units/configuration through the Product MCP runtime.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: true
      }
    },
    {
      name: 'product_list_suppliers',
      title: 'List suppliers',
      description:
        'Fallback declaration for querying ERP supplier options through the Product MCP runtime.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: true
      }
    },
    {
      name: 'product_list_regions',
      title: 'List product regions',
      description:
        'Fallback declaration for querying ERP region options through the Product MCP runtime.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: true
      }
    },
    {
      name: 'product_get_dict',
      title: 'Get system dict',
      description:
        'Fallback declaration for querying ERP system dictionary values through the Product MCP runtime.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: true
      }
    },
    {
      name: 'product_get_detail',
      title: 'Get product detail',
      description:
        'Fallback declaration for querying ERP product detail after creation through the Product MCP runtime.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: true
      }
    }
  ];
}

function mergeTools(childTools) {
  const tools = [...(childTools ?? [])];
  const names = new Set(tools.map((tool) => tool.name));

  for (const tool of fallbackRuntimeTools()) {
    if (!names.has(tool.name)) {
      tools.push(tool);
      names.add(tool.name);
    }
  }

  for (const tool of launcherTools()) {
    if (!names.has(tool.name)) {
      tools.push(tool);
      names.add(tool.name);
    }
  }

  return tools;
}

function isLauncherTool(name) {
  return launcherTools().some((tool) => tool.name === name);
}

function isConnectionError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /not connected|connection.*closed|transport.*closed|stdio/i.test(message);
}

function runtimeToolTimeoutMs(name) {
  if (name === 'product_auth_status' || name === 'product_runtime_self_check' || name === 'product_runtime_refresh') {
    return runtimeToolAuthTimeoutMs;
  }
  if (name === 'product_upload_file') return runtimeToolUploadTimeoutMs;
  if (name === 'product_create') return runtimeToolCreateTimeoutMs;
  if (
    name === 'product_runtime_status' ||
    name === 'product_runtime_launcher_status' ||
    name === 'product_bridge_config_status'
  ) {
    return runtimeToolStatusTimeoutMs;
  }
  return runtimeToolQueryTimeoutMs;
}

async function listTools() {
  if (!sdk) {
    return {
      tools: mergeTools([])
    };
  }

  try {
    await syncPluginRuntime({ allowChildRestart: false });
    const child = await ensureRuntimeChild();
    const result = await child.listTools();
    childToolsCache = result.tools ?? [];
    lastChildListError = null;

    return {
      ...result,
      tools: mergeTools(childToolsCache)
    };
  } catch (error) {
    lastChildListError = error instanceof Error ? error.message : String(error);
    process.stderr.write(`ERP Product runtime tool list failed: ${lastChildListError}\n`);

    return {
      tools: mergeTools([])
    };
  }
}

async function callChildTool(name, args, options = {}) {
  await syncPluginRuntime({
    force: Boolean(options.forceRuntimeSync),
    allowChildRestart: options.allowRuntimeRestart !== false
  });

  let child = await ensureRuntimeChild();
  try {
    return await child.callTool({ name, arguments: args }, undefined, { timeout: runtimeToolTimeoutMs(name) });
  } catch (error) {
    if (!isConnectionError(error)) throw error;

    await withRuntimeLock(async () => {
      await restartRuntimeChild('runtime proxy connection was closed');
    });
    child = await ensureRuntimeChild();
    return child.callTool({ name, arguments: args }, undefined, { timeout: runtimeToolTimeoutMs(name) });
  }
}

async function callTool(request) {
  const name = request.params.name;
  const args = request.params.arguments ?? {};

  if (name === 'product_runtime_launcher_status') {
    return jsonResult(launcherStatus());
  }

  if (name === 'product_runtime_launcher_refresh') {
    const dependencyRefresh = await ensureLauncherDependencies({ force: true, wait: true });
    if (!dependencyRefresh.ok) {
      const diagnostic = dependencyRefresh.diagnostic;
      return jsonResult(
        launcherStatus({
          ok: false,
          code: 'ERP_PRODUCT_RUNTIME_NOT_READY',
          readsChromeToken: false,
          readsRemoteErp: false,
          requestedTool: name,
          errorStage: diagnostic?.stage || dependencyRefresh.stage,
          errorReason: diagnostic?.reason || dependencyRefresh.error,
          errorKind: diagnostic?.kind || null,
          errorCommand: diagnostic?.command || dependencyRefresh.detail?.command || null,
          diagnostic,
          refresh: {
            dependencies: dependencyRefresh,
            restarted: false
          },
          agentGuidance: {
            conclusion:
              diagnostic
                ? `ERP Product runtime dependency refresh failed at ${diagnostic.stage}: ${diagnostic.reason}.`
                : `ERP Product runtime dependency refresh is not ready at ${dependencyRefresh.stage || 'dependency preparation'}.`,
            nextAction:
              'Report the startup error stage and reason to the user. Do not troubleshoot Chrome remote debugging until launcher/runtime dependencies are ready.'
          }
        })
      );
    }

    let syncResult;
    try {
      syncResult = await syncPluginRuntime({ force: true, allowChildRestart: true });
    } catch (error) {
      const diagnostic = diagnosticFromError(error);
      return jsonResult(
        launcherStatus({
          ok: false,
          code: 'ERP_PRODUCT_RUNTIME_NOT_READY',
          readsChromeToken: false,
          readsRemoteErp: false,
          requestedTool: name,
          errorStage: diagnostic.stage,
          errorReason: diagnostic.reason,
          errorKind: diagnostic.kind,
          errorCommand: diagnostic.command,
          diagnostic,
          refresh: {
            dependencies: dependencyRefresh,
            sync: {
              ok: false,
              diagnostic
            },
            restarted: false
          },
          agentGuidance: {
            conclusion: `ERP Product runtime refresh failed at ${diagnostic.stage}: ${diagnostic.reason}.`,
            nextAction:
              'Report the startup error stage and reason to the user. Do not troubleshoot Chrome remote debugging until launcher/runtime dependencies are ready.'
          }
        })
      );
    }

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
          dependencies: dependencyRefresh,
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

  if (!sdk && ['product_runtime_self_check', 'product_runtime_status', 'product_auth_status'].includes(name)) {
    const dependencies = await ensureLauncherDependencies({ wait: false });
    const diagnostic = dependencies.diagnostic;
    return jsonResult(
      launcherStatus({
        ok: false,
        code: dependencies.pending ? 'ERP_PRODUCT_RUNTIME_PREPARING' : 'ERP_PRODUCT_RUNTIME_NOT_READY',
        readsChromeToken: false,
        readsRemoteErp: false,
        requestedTool: name,
        currentStage: dependencies.stage,
        currentAction: dependencies.action,
        errorStage: diagnostic?.stage || null,
        errorReason: diagnostic?.reason || dependencies.error,
        errorKind: diagnostic?.kind || null,
        errorCommand: diagnostic?.command || dependencies.detail?.command || null,
        diagnostic,
        agentGuidance: {
          conclusion:
            'ERP Product launcher is running, but Product MCP runtime dependencies are not ready yet. This is before Chrome DevTools MCP and before ERP token reading.',
          nextAction:
            diagnostic
              ? `Report the startup failure at ${diagnostic.stage}: ${diagnostic.reason}. After the underlying GitHub/npm/network/SDK issue is recoverable, retry product_runtime_launcher_refresh.`
              : `Startup is currently at ${dependencies.stage || 'dependency preparation'}: ${dependencies.action || 'preparing runtime dependencies'}. Wait briefly or retry product_runtime_self_check.`
        }
      })
    );
  }

  if (name === 'product_runtime_self_check') {
    return jsonResult(await forwardedRuntimeSelfCheckWithReuse(args));
  }

  const shouldApplyRuntimeUpdate = name === 'product_runtime_refresh';
  try {
    return await callChildTool(name, args, {
      forceRuntimeSync: shouldApplyRuntimeUpdate,
      allowRuntimeRestart: shouldApplyRuntimeUpdate
    });
  } catch (error) {
    if (['product_runtime_self_check', 'product_runtime_status', 'product_auth_status'].includes(name)) {
      const diagnostic = diagnosticFromError(error);
      return jsonResult(
        launcherStatus({
          ok: false,
          code: 'ERP_PRODUCT_RUNTIME_NOT_READY',
          readsChromeToken: false,
          readsRemoteErp: false,
          requestedTool: name,
          error: diagnostic.reason,
          errorStage: diagnostic.stage,
          errorReason: diagnostic.reason,
          errorKind: diagnostic.kind,
          errorCommand: diagnostic.command,
          diagnostic,
          agentGuidance: {
            conclusion:
              `ERP Product launcher is visible, but Product MCP runtime is not ready. Failure happened at ${diagnostic.stage}: ${diagnostic.reason}. This is before Chrome DevTools MCP and before ERP token reading.`,
            nextAction:
              'Do not troubleshoot Chrome remote debugging yet. Report this startup stage and reason, then retry product_runtime_launcher_refresh only after the underlying Node/GitHub/npm/network/SDK issue is recoverable.'
          }
        })
      );
    }

    throw error;
  }
}

async function startLauncherServer() {
  let buffer = '';

  function send(message) {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  }

  function sendResult(id, result) {
    send({ jsonrpc: '2.0', id, result });
  }

  function sendError(id, code, message, data) {
    send({
      jsonrpc: '2.0',
      id,
      error: {
        code,
        message,
        ...(data === undefined ? {} : { data })
      }
    });
  }

  async function handleMessage(message) {
    if (!message || typeof message !== 'object') return;
    const { id, method, params } = message;

    if (typeof method === 'string' && method.startsWith('notifications/')) {
      return;
    }

    try {
      if (method === 'initialize') {
        sendResult(id, {
          protocolVersion: params?.protocolVersion || '2025-06-18',
          capabilities: {
            tools: {
              listChanged: true
            }
          },
          serverInfo: {
            name: 'erp-product-runtime-launcher',
            version: launcherVersion
          },
          instructions:
            'ERP Product runtime launcher. It exposes diagnostic tools immediately, then prepares and proxies the Product MCP runtime without reading Chrome or ERP token during startup.'
        });
        return;
      }

      if (method === 'ping') {
        sendResult(id, {});
        return;
      }

      if (method === 'tools/list') {
        sendResult(id, await listTools());
        return;
      }

      if (method === 'tools/call') {
        sendResult(
          id,
          await callTool({
            params
          })
        );
        return;
      }

      sendError(id, -32601, `Method not found: ${method}`);
    } catch (error) {
      sendError(id, -32603, error instanceof Error ? error.message : String(error));
    }
  }

  serverInstance = {
    sendToolListChanged: async () => {
      send({
        jsonrpc: '2.0',
        method: 'notifications/tools/list_changed'
      });
    }
  };

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf('\n');
      if (newline === -1) break;

      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;

      try {
        handleMessage(JSON.parse(line)).catch((error) => {
          process.stderr.write(`ERP Product launcher request failed: ${error instanceof Error ? error.message : String(error)}\n`);
        });
      } catch (error) {
        process.stderr.write(`ERP Product launcher received invalid JSON: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
  });
}

async function shutdown() {
  await stopRuntimeChild();
}

let shuttingDown = false;
function shutdownAndExit() {
  if (shuttingDown) return;
  shuttingDown = true;
  shutdown().finally(() => process.exit(0));
}

process.on('SIGINT', shutdownAndExit);
process.on('SIGTERM', shutdownAndExit);
process.stdin.on('end', shutdownAndExit);
process.stdin.on('close', shutdownAndExit);

await startLauncherServer();
