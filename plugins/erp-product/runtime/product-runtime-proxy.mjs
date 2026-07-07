import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pluginRoot = dirname(scriptDir);
const productMcpRepoUrl = 'https://github.com/Bohaohao/product-mcp.git';
const productMcpRef = 'master';
const siblingProductMcp = resolve(pluginRoot, '..', '..', '..', 'product-mcp');
const cachedProductMcp = join(homedir(), '.erp-product', 'product-mcp');
const npmCacheDir = join(homedir(), '.erp-product', 'npm-cache');
const sourceBridgeConfig = join(pluginRoot, 'config', 'product-token-bridge.config.json');
const runtimeBridgeConfig = join(homedir(), '.erp-product', 'product-token-bridge.config.json');
const proxyVersion = '0.3.24';
const runtimeUpdateCheckIntervalMs = 5 * 60 * 1000;
const externalCommandTimeoutMs = positiveIntegerFromEnv('ERP_PRODUCT_COMMAND_TIMEOUT_MS', 90_000);
const npmInstallTimeoutMs = positiveIntegerFromEnv('ERP_PRODUCT_NPM_INSTALL_TIMEOUT_MS', 180_000);
const tokenDaemonStartTimeoutMs = positiveIntegerFromEnv('ERP_PRODUCT_TOKEN_DAEMON_START_TIMEOUT_MS', 20_000);
const tokenDaemonStopTimeoutMs = positiveIntegerFromEnv('ERP_PRODUCT_TOKEN_DAEMON_STOP_TIMEOUT_MS', 5_000);
const childToolStatusTimeoutMs = positiveIntegerFromEnv('ERP_PRODUCT_CHILD_TOOL_STATUS_TIMEOUT_MS', 30_000);
const childToolQueryTimeoutMs = positiveIntegerFromEnv('ERP_PRODUCT_CHILD_TOOL_QUERY_TIMEOUT_MS', 120_000);
const childToolAuthTimeoutMs = positiveIntegerFromEnv('ERP_PRODUCT_CHILD_TOOL_AUTH_TIMEOUT_MS', 240_000);
const childToolCreateTimeoutMs = positiveIntegerFromEnv('ERP_PRODUCT_CHILD_TOOL_CREATE_TIMEOUT_MS', 180_000);
const childToolUploadTimeoutMs = positiveIntegerFromEnv('ERP_PRODUCT_CHILD_TOOL_UPLOAD_TIMEOUT_MS', 270_000);
const childToolWorkflowTimeoutMs = positiveIntegerFromEnv('ERP_PRODUCT_CHILD_TOOL_WORKFLOW_TIMEOUT_MS', 900_000);
const selfCheckReuseTtlMs = positiveIntegerFromEnv('ERP_PRODUCT_SELF_CHECK_REUSE_TTL_MS', 120_000);
const outputSnippetChars = 1600;
const posixPathEntries = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];

let sdk;
let serverInstance;
let productMcp;
let productMcpDir;
let childClient;
let childTransport;
let childStartedAt;
let childRuntimeCommit;
let childRuntimeVersion;
let childBridgeConfigHash;
let childTokenDaemonStatus;
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
let runtimeSelfCheckCache = null;
let runtimeSelfCheckInFlight = null;
let runtimeLock = Promise.resolve();
let startupStage = {
  stage: null,
  action: null,
  detail: null
};
let tokenDaemonProcess;
let tokenDaemonInfo;
let tokenDaemonStartedAt;
let tokenDaemonConfigHash;
let tokenDaemonEntry;
let tokenDaemonSourceCommit;
let tokenDaemonStartPromise;
let tokenDaemonLastError = null;
let tokenDaemonLastExit = null;
let tokenDaemonRestartCount = 0;
let tokenDaemonMode = 'not_started';

function run(command, args, cwd, options = {}) {
  const timeoutMs = options.timeoutMs ?? externalCommandTimeoutMs;
  if (options.stage) {
    startupStage = {
      stage: options.stage,
      action: options.action || commandLine(command, args),
      detail: {
        command: commandLine(command, args),
        cwd,
        timeoutMs,
        ...(options.detail || {})
      }
    };
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
      timedOut
        ? `${startupStage.action || commandLine(command, args)} timed out after ${Math.ceil(timeoutMs / 1000)}s.`
        : result.error.message,
      {
        stage: options.stage,
        action: options.action,
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
    if (options.logOutput === false && result.stderr) {
      process.stderr.write(result.stderr);
    }
    throw operationError(`${startupStage.action || commandLine(command, args)} failed with exit code ${result.status}.`, {
      stage: options.stage,
      action: options.action,
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
    stage: fallback.stage || startupStage.stage || 'unknown',
    action: fallback.action || startupStage.action || null,
    reason: message,
    kind: classifyFailure(message, fallback),
    command: fallback.command ? commandLine(fallback.command, fallback.args || []) : fallback.commandLine || startupStage.detail?.command || null,
    cwd: fallback.cwd || startupStage.detail?.cwd || null,
    detail: fallback.detail || startupStage.detail || null,
    timeoutMs: fallback.timeoutMs || startupStage.detail?.timeoutMs || null,
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

function writeStartupFailure(error) {
  const diagnostic = diagnosticFromError(error);
  process.stderr.write(`ERP Product runtime proxy startup failed at ${diagnostic.stage}: ${diagnostic.reason}\n`);
  process.stderr.write(`${JSON.stringify({ code: 'ERP_PRODUCT_RUNTIME_PROXY_STARTUP_FAILED', diagnostic })}\n`);
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
      const diagnostic = diagnosticFromError(error);
      const cleaned = cleanDirtyNodeModules(cwd, diagnostic);
      if (!cleaned.length) throw error;
      diagnostic.cleanedArtifacts = cleaned;

      process.stderr.write(`Cleaned npm dependency artifacts after ${diagnostic.stage}: ${cleaned.join(', ')}\n`);
      return run(command, commandArgs, cwd, {
        ...baseOptions,
        stage: `${options.stage || 'npm_install'}_retry_after_clean`,
        action: `${options.action || 'npm install'} after cleaning dirty node_modules artifacts`
      });
    }

    if (isRecoverableNpmCacheError(error)) {
      const diagnostic = diagnosticFromError(error);
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

function hasProductMcp(dir) {
  return existsSync(join(dir, 'package.json'));
}

function bridgeEntryFor(dir) {
  return join(dir, 'dist', 'localBridge.js');
}

function tokenDaemonEntryFor(dir) {
  return join(dir, 'dist', 'tokenBridgeDaemon.js');
}

function runtimeDependencyFor(dir) {
  return join(dir, 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json');
}

function sourceRootFor(dir) {
  return join(dir, 'src');
}

function isBuildSourceFile(filePath) {
  if (/\.d\.ts$/i.test(filePath)) return false;
  return /\.(ts|tsx|js|mjs)$/i.test(filePath);
}

function listFilesRecursive(root, predicate) {
  const files = [];
  if (!existsSync(root)) return files;

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const entryPath = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(entryPath, predicate));
    } else if (entry.isFile() && predicate(entryPath)) {
      files.push(entryPath);
    }
  }

  return files;
}

function buildOutputForSource(dir, sourcePath) {
  const relativeSourcePath = relative(sourceRootFor(dir), sourcePath);
  const relativeOutputPath = relativeSourcePath.replace(/\.(tsx?|mjs|js)$/i, '.js');
  return join(dir, 'dist', relativeOutputPath);
}

function isSourceNewerThanBuild(dir) {
  try {
    const sourceFiles = listFilesRecursive(sourceRootFor(dir), isBuildSourceFile);
    return sourceFiles.some((sourcePath) => {
      const buildPath = buildOutputForSource(dir, sourcePath);
      if (!existsSync(buildPath)) return true;
      return statSync(sourcePath).mtimeMs > statSync(buildPath).mtimeMs;
    });
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

function productMcpPackageInfoSafe(dir) {
  try {
    if (!dir) return { version: null, packagePath: null, error: null };
    const packagePath = join(dir, 'package.json');
    if (!existsSync(packagePath)) {
      return { version: null, packagePath, error: 'package_json_missing' };
    }
    const parsed = JSON.parse(readFileSync(packagePath, 'utf8'));
    const version = typeof parsed.version === 'string' && parsed.version.trim() ? parsed.version.trim() : null;
    return { version, packagePath, error: version ? null : 'package_version_missing' };
  } catch (error) {
    return {
      version: null,
      packagePath: dir ? join(dir, 'package.json') : null,
      error: error instanceof Error ? error.message : String(error)
    };
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
      run('git', ['clone', '--branch', productMcpRef, productMcpRepoUrl, cachedProductMcp], dirname(cachedProductMcp), {
        stage: 'runtime_proxy_product_mcp_git_clone',
        action: 'clone Product MCP from GitHub for runtime proxy'
      });
      return { dir: cachedProductMcp, updated: true, source: 'git clone' };
    }

    if (!existsSync(join(cachedProductMcp, '.git'))) {
      throw operationError(`Cached Product MCP is not a git checkout: ${cachedProductMcp}`, {
        stage: 'runtime_proxy_product_mcp_cache_validate',
        action: 'validate Product MCP cache for runtime proxy',
        cwd: cachedProductMcp
      });
    }

    const before = run('git', ['rev-parse', 'HEAD'], cachedProductMcp, {
      logOutput: false,
      stage: 'runtime_proxy_product_mcp_git_head',
      action: 'read Product MCP current commit for runtime proxy'
    });

    run('git', ['remote', 'set-url', 'origin', productMcpRepoUrl], cachedProductMcp, {
      stage: 'runtime_proxy_product_mcp_git_remote',
      action: 'update Product MCP Git remote URL for runtime proxy'
    });
    run('git', ['fetch', '--prune', 'origin'], cachedProductMcp, {
      stage: 'runtime_proxy_product_mcp_git_fetch',
      action: 'fetch Product MCP updates from GitHub for runtime proxy'
    });
    run('git', ['reset', '--hard', `origin/${productMcpRef}`], cachedProductMcp, {
      stage: 'runtime_proxy_product_mcp_git_reset',
      action: 'reset Product MCP cache to remote branch for runtime proxy'
    });
    run('git', ['pull', '--ff-only', 'origin', productMcpRef], cachedProductMcp, {
      stage: 'runtime_proxy_product_mcp_git_pull',
      action: 'pull Product MCP latest code from GitHub for runtime proxy'
    });

    const after = run('git', ['rev-parse', 'HEAD'], cachedProductMcp, {
      logOutput: false,
      stage: 'runtime_proxy_product_mcp_git_head_after_update',
      action: 'read Product MCP commit after runtime proxy update'
    });

    return {
      dir: cachedProductMcp,
      updated: before !== after,
      source: 'git pull'
    };
  } catch (error) {
    const diagnostic = diagnosticFromError(error);
    process.stderr.write(`Product MCP git sync failed at ${diagnostic.stage}: ${diagnostic.reason}\n`);

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
    runNpm(['install'], selection.dir, {
      stage: 'runtime_proxy_product_mcp_npm_install',
      action: 'install Product MCP dependencies for runtime proxy',
      timeoutMs: npmInstallTimeoutMs
    });
    runNpm(['run', 'build'], selection.dir, {
      stage: 'runtime_proxy_product_mcp_npm_build',
      action: 'build Product MCP for runtime proxy',
      timeoutMs: npmInstallTimeoutMs
    });
    rebuilt = true;
  } else if (!existsSync(runtimeDependency)) {
    runNpm(['install', '--omit=dev'], selection.dir, {
      stage: 'runtime_proxy_product_mcp_npm_install_runtime',
      action: 'install Product MCP runtime dependencies for runtime proxy',
      timeoutMs: npmInstallTimeoutMs
    });
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
  startupStage = {
    stage: 'runtime_proxy_product_mcp_sdk_import',
    action: 'load Product MCP SDK modules for runtime proxy',
    detail: {
      cwd: productMcpDir
    }
  };

  let serverModule;
  let serverStdioModule;
  let clientModule;
  let clientStdioModule;
  let typesModule;
  try {
    [serverModule, serverStdioModule, clientModule, clientStdioModule, typesModule] = await Promise.all([
      importFromProductMcp('@modelcontextprotocol/sdk/server/index.js'),
      importFromProductMcp('@modelcontextprotocol/sdk/server/stdio.js'),
      importFromProductMcp('@modelcontextprotocol/sdk/client/index.js'),
      importFromProductMcp('@modelcontextprotocol/sdk/client/stdio.js'),
      importFromProductMcp('@modelcontextprotocol/sdk/types.js')
    ]);
  } catch (error) {
    throw operationError(error instanceof Error ? error.message : String(error), {
      stage: 'runtime_proxy_product_mcp_sdk_import',
      action: 'load Product MCP SDK modules for runtime proxy',
      cwd: productMcpDir
    });
  }

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

function tokenDaemonSupportedPlatform() {
  return process.platform === 'win32' || process.platform === 'darwin';
}

function isTokenDaemonRunning() {
  return Boolean(tokenDaemonProcess && tokenDaemonInfo && tokenDaemonProcess.exitCode === null && !tokenDaemonProcess.killed);
}

function redactedTokenDaemonInfo(info = tokenDaemonInfo) {
  if (!info) return null;
  return {
    ok: info.ok === true,
    url: info.url ?? null,
    secretSet: Boolean(info.secret),
    pid: info.pid ?? tokenDaemonProcess?.pid ?? null,
    version: info.version ?? null
  };
}

function redactTokenDaemonText(value) {
  return String(value ?? '')
    .replace(/("secret"\s*:\s*")[^"]*(")/gi, '$1[redacted]$2')
    .replace(/(PRODUCT_TOKEN_DAEMON_SECRET=)[^\s"']+/gi, '$1[redacted]');
}

function tokenDaemonFailureResult(mode, message, fallback = {}) {
  const diagnostic = diagnosticFromError(new Error(message), {
    stage: 'runtime_proxy_token_daemon_start',
    action: 'start Product MCP token bridge daemon',
    command: process.execPath,
    cwd: productMcpDir,
    timeoutMs: tokenDaemonStartTimeoutMs,
    detail: {
      entry: fallback.entry ?? tokenDaemonEntryFor(productMcpDir),
      configPath: runtimeBridgeConfig,
      configHash: fallback.configHash ?? fileHash(runtimeBridgeConfig),
      ...(fallback.detail || {})
    },
    ...fallback,
    stdout: redactTokenDaemonText(fallback.stdout),
    stderr: redactTokenDaemonText(fallback.stderr)
  });

  tokenDaemonMode = mode;
  tokenDaemonLastError = diagnostic;
  return {
    ok: false,
    mode,
    diagnostic
  };
}

function tokenDaemonStatus() {
  const currentEntry = productMcpDir ? tokenDaemonEntryFor(productMcpDir) : null;
  const statusEntry = tokenDaemonEntry ?? currentEntry;
  const running = isTokenDaemonRunning();
  const configHash = fileHash(runtimeBridgeConfig);

  return {
    mode: tokenDaemonMode,
    supportedPlatform: tokenDaemonSupportedPlatform(),
    running,
    entry: statusEntry,
    currentEntry,
    currentEntryExists: currentEntry ? existsSync(currentEntry) : false,
    command: statusEntry ? commandLine(process.execPath, [statusEntry, '--config', runtimeBridgeConfig]) : null,
    cwd: statusEntry ? dirname(dirname(statusEntry)) : productMcpDir,
    startedAt: running ? tokenDaemonStartedAt : null,
    info: running ? redactedTokenDaemonInfo() : null,
    configPath: runtimeBridgeConfig,
    configHash: tokenDaemonConfigHash ?? null,
    currentConfigHash: configHash,
    configMatchesCurrent: running ? Boolean(tokenDaemonConfigHash && configHash && tokenDaemonConfigHash === configHash) : null,
    sourceCommit: tokenDaemonSourceCommit ?? null,
    restartCount: tokenDaemonRestartCount,
    lastError: tokenDaemonLastError,
    lastExit: tokenDaemonLastExit,
    fallbackActive: String(tokenDaemonMode).startsWith('legacy_')
  };
}

function tokenDaemonEnv() {
  if (!isTokenDaemonRunning()) return {};
  return {
    PRODUCT_TOKEN_DAEMON_URL: tokenDaemonInfo.url,
    PRODUCT_TOKEN_DAEMON_SECRET: tokenDaemonInfo.secret
  };
}

function childToolTimeoutMs(name) {
  if (name === 'product_auth_status' || name === 'product_runtime_self_check' || name === 'product_runtime_refresh') {
    return childToolAuthTimeoutMs;
  }
  if (name === 'product_upload_file') return childToolUploadTimeoutMs;
  if (name === 'product_create') return childToolCreateTimeoutMs;
  if (name === 'product_create_from_package' || name === 'product_create_from_batch') return childToolWorkflowTimeoutMs;
  if (name === 'product_runtime_status' || name === 'product_bridge_config_status') return childToolStatusTimeoutMs;
  return childToolQueryTimeoutMs;
}

function childTokenDaemonStatusFromResult(result) {
  if (result?.ok && tokenDaemonInfo) {
    return {
      mode: 'daemon',
      running: true,
      url: tokenDaemonInfo.url,
      secretSet: Boolean(tokenDaemonInfo.secret),
      pid: tokenDaemonInfo.pid ?? tokenDaemonProcess?.pid ?? null,
      version: tokenDaemonInfo.version ?? null,
      configHash: tokenDaemonConfigHash ?? null,
      entry: tokenDaemonEntry ?? null,
      reused: Boolean(result.reused)
    };
  }

  return {
    mode: result?.mode ?? tokenDaemonMode,
    running: false,
    url: null,
    secretSet: false,
    diagnostic: result?.diagnostic ?? tokenDaemonLastError
  };
}

function startTokenDaemonProcess(entry, configHash) {
  const args = [entry, '--config', runtimeBridgeConfig];
  const cwd = productMcpDir;
  let stdoutText = '';
  let stderrText = '';
  let stdoutBuffer = '';
  let settled = false;
  let timeout;

  tokenDaemonMode = 'starting';
  tokenDaemonLastError = null;
  tokenDaemonLastExit = null;
  tokenDaemonEntry = entry;
  tokenDaemonConfigHash = configHash;
  tokenDaemonSourceCommit = gitHeadSafe(productMcpDir);

  return new Promise((resolveStart) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env: processEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });

    tokenDaemonProcess = child;

    function finish(result) {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolveStart(result);
    }

    function fail(message, fallback = {}) {
      const result = tokenDaemonFailureResult('legacy_start_failed', message, {
        command: process.execPath,
        args,
        cwd,
        stdout: stdoutText,
        stderr: stderrText,
        entry,
        configHash,
        ...fallback
      });

      tokenDaemonInfo = undefined;
      tokenDaemonStartedAt = undefined;
      process.stderr.write(
        `Product MCP token daemon unavailable; falling back to legacy localBridge token path: ${result.diagnostic.reason}\n`
      );

      if (child.exitCode === null && !child.killed) {
        child.kill('SIGTERM');
      }

      finish(result);
    }

    function handleHandshakeLine(line) {
      const text = line.trim();
      if (!text) return;

      stdoutText = snippet(`${stdoutText}\n${text}`);

      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        fail(`Product MCP token daemon returned invalid startup JSON: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }

      if (parsed?.ok !== true || !parsed.url || !parsed.secret) {
        fail('Product MCP token daemon startup JSON was missing ok/url/secret fields.');
        return;
      }

      tokenDaemonInfo = {
        ok: true,
        url: String(parsed.url),
        secret: String(parsed.secret),
        pid: parsed.pid ?? child.pid ?? null,
        version: parsed.version ?? null
      };
      tokenDaemonStartedAt = new Date().toISOString();
      tokenDaemonMode = 'daemon';
      tokenDaemonLastError = null;

      process.stderr.write(
        `Product MCP token daemon started: ${tokenDaemonInfo.url} (pid ${tokenDaemonInfo.pid ?? child.pid ?? 'unknown'})\n`
      );
      finish({
        ok: true,
        mode: 'daemon',
        info: tokenDaemonInfo
      });
    }

    timeout = setTimeout(() => {
      fail(`Product MCP token daemon startup timed out after ${Math.ceil(tokenDaemonStartTimeoutMs / 1000)}s.`, {
        timedOut: true
      });
    }, tokenDaemonStartTimeoutMs);

    child.stdout?.on('data', (chunk) => {
      stdoutBuffer += chunk.toString();

      while (true) {
        const newline = stdoutBuffer.indexOf('\n');
        if (newline === -1) break;

        const line = stdoutBuffer.slice(0, newline).replace(/\r$/, '');
        stdoutBuffer = stdoutBuffer.slice(newline + 1);

        if (!settled) {
          handleHandshakeLine(line);
        } else if (line.trim()) {
          process.stderr.write(`[Product MCP token daemon] ${redactTokenDaemonText(line)}\n`);
        }
      }
    });

    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString();
      stderrText = snippet(`${stderrText}\n${text}`);
      process.stderr.write(redactTokenDaemonText(text));
    });

    child.once('error', (error) => {
      fail(error instanceof Error ? error.message : String(error));
    });

    child.once('exit', (code, signal) => {
      tokenDaemonLastExit = {
        at: new Date().toISOString(),
        code,
        signal
      };

      if (!settled) {
        fail(`Product MCP token daemon exited before startup completed with code ${code ?? 'null'} and signal ${signal ?? 'null'}.`, {
          exitCode: code,
          signal
        });
        return;
      }

      if (tokenDaemonProcess === child) {
        tokenDaemonProcess = undefined;
        if (tokenDaemonInfo) {
          tokenDaemonInfo = undefined;
          tokenDaemonStartedAt = undefined;
          tokenDaemonMode = shuttingDown ? 'stopped' : 'exited';
        }
      }
    });
  });
}

async function stopTokenDaemon(reason = 'shutdown') {
  const child = tokenDaemonProcess;
  if (!child) {
    tokenDaemonInfo = undefined;
    tokenDaemonStartedAt = undefined;
    if (tokenDaemonMode !== 'not_started') tokenDaemonMode = 'stopped';
    return;
  }

  tokenDaemonMode = 'stopping';
  process.stderr.write(`Stopping Product MCP token daemon: ${reason}\n`);

  await new Promise((resolveStop) => {
    let resolved = false;
    const done = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolveStop();
    };
    const timer = setTimeout(() => {
      if (child.exitCode === null && !child.killed) {
        child.kill('SIGKILL');
      }
      done();
    }, tokenDaemonStopTimeoutMs);

    child.once('exit', done);
    if (child.exitCode === null && !child.killed) {
      child.kill('SIGTERM');
    } else {
      done();
    }
  });

  if (tokenDaemonProcess === child) {
    tokenDaemonProcess = undefined;
  }
  tokenDaemonInfo = undefined;
  tokenDaemonStartedAt = undefined;
  tokenDaemonMode = 'stopped';
}

async function ensureTokenDaemon(options = {}) {
  const configHash = options.configHash ?? fileHash(runtimeBridgeConfig);
  const currentEntry = tokenDaemonEntryFor(productMcpDir);

  if (isTokenDaemonRunning()) {
    if (tokenDaemonConfigHash && configHash && tokenDaemonConfigHash !== configHash && existsSync(currentEntry)) {
      tokenDaemonRestartCount += 1;
      await stopTokenDaemon('bridge config changed');
    } else {
      return {
        ok: true,
        mode: 'daemon',
        info: tokenDaemonInfo,
        reused: true
      };
    }
  }

  if (tokenDaemonStartPromise) {
    return tokenDaemonStartPromise;
  }

  if (!tokenDaemonSupportedPlatform()) {
    return tokenDaemonFailureResult('legacy_unsupported_platform', `Product MCP token daemon is not enabled on ${process.platform}.`, {
      entry: currentEntry,
      configHash
    });
  }

  if (!existsSync(currentEntry)) {
    return tokenDaemonFailureResult('legacy_entry_missing', `Product MCP token daemon entry is unavailable: ${currentEntry}`, {
      entry: currentEntry,
      configHash
    });
  }

  tokenDaemonStartPromise = startTokenDaemonProcess(currentEntry, configHash).finally(() => {
    tokenDaemonStartPromise = undefined;
  });

  return tokenDaemonStartPromise;
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
  childTokenDaemonStatus = undefined;

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
  const daemonResult = await ensureTokenDaemon({ configHash: bridgeConfigHash });
  const childEnv = {
    ...processEnv(),
    ...tokenDaemonEnv()
  };

  const transport = new sdk.StdioClientTransport({
    command: process.execPath,
    args: [bridgeEntry, '--config', runtimeBridgeConfig],
    cwd: productMcpDir,
    env: childEnv,
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
      childRuntimeVersion = undefined;
      childBridgeConfigHash = undefined;
      childTokenDaemonStatus = undefined;
    }
  };

  await client.connect(transport);

  childClient = client;
  childTransport = transport;
  childStartedAt = new Date().toISOString();
  childRuntimeCommit = gitHeadSafe(productMcpDir);
  childRuntimeVersion = productMcpPackageInfoSafe(productMcpDir).version;
  childBridgeConfigHash = bridgeConfigHash;
  childTokenDaemonStatus = childTokenDaemonStatusFromResult(daemonResult);
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
  const productMcpPackage = productMcpPackageInfoSafe(productMcpDir);
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
      version: productMcpPackage.version,
      packagePath: productMcpPackage.packagePath,
      packageVersionError: productMcpPackage.error,
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
      version: childRuntimeVersion ?? null,
      commit: childRuntimeCommit ?? null,
      bridgeConfigHash: childBridgeConfigHash ?? null,
      tokenDaemon: childTokenDaemonStatus ?? null,
      restartCount,
      pendingRestart: pendingChildRuntimeRestart,
      cachedToolCount: childToolsCache.length
    },
    tokenDaemon: tokenDaemonStatus(),
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
  const tokenDaemon = status.tokenDaemon;

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
      name: 'token_daemon_or_legacy_fallback_available',
      ok: Boolean(tokenDaemon.running || tokenDaemon.fallbackActive),
      detail: {
        mode: tokenDaemon.mode,
        supportedPlatform: tokenDaemon.supportedPlatform,
        running: tokenDaemon.running,
        entry: tokenDaemon.entry,
        currentEntryExists: tokenDaemon.currentEntryExists,
        url: tokenDaemon.info?.url ?? null,
        lastExit: tokenDaemon.lastExit,
        lastError: tokenDaemon.lastError
          ? {
              stage: tokenDaemon.lastError.stage,
              reason: tokenDaemon.lastError.reason,
              kind: tokenDaemon.lastError.kind
            }
          : null
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

  if (tokenDaemon.running) {
    checks.push({
      name: 'token_daemon_config_matches_runtime_config',
      ok: tokenDaemon.configMatchesCurrent === true,
      detail: {
        daemonConfigHash: tokenDaemon.configHash,
        runtimeConfigHash: tokenDaemon.currentConfigHash
      }
    });

    checks.push({
      name: 'child_token_daemon_env_matches_daemon',
      ok: status.childRuntime.tokenDaemon?.url === tokenDaemon.info?.url && status.childRuntime.tokenDaemon?.secretSet === true,
      detail: {
        daemonUrl: tokenDaemon.info?.url ?? null,
        childUrl: status.childRuntime.tokenDaemon?.url ?? null,
        childSecretSet: status.childRuntime.tokenDaemon?.secretSet ?? false,
        daemonVersion: tokenDaemon.info?.version ?? null,
        childDaemonVersion: status.childRuntime.tokenDaemon?.version ?? null
      }
    });
  }

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
      startOrReuseTokenDaemon: true,
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
    versionSummary: {
      productMcpVersion: status.productMcp.version,
      productMcpCommit: status.productMcp.commit,
      childRuntimeProductMcpVersion: status.childRuntime.version,
      childRuntimeProductMcpCommit: status.childRuntime.commit,
      runtimeProxyVersion: status.proxy.version,
      tokenBridgeVersion: status.tokenDaemon.info?.version ?? null
    },
    tokenDaemon: status.tokenDaemon,
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

function isRuntimeSelfCheckCacheFresh() {
  if (!runtimeSelfCheckCache || pendingChildRuntimeRestart) return false;

  const ageMs = Date.now() - runtimeSelfCheckCache.cachedAtMs;
  return (
    ageMs >= 0 &&
    ageMs < selfCheckReuseTtlMs &&
    runtimeSelfCheckCache.restartCount === restartCount &&
    runtimeSelfCheckCache.childRuntimeCommit === childRuntimeCommit &&
    runtimeSelfCheckCache.childBridgeConfigHash === childBridgeConfigHash
  );
}

function withRuntimeSelfCheckReuse(payload, source, cachedAtMs = runtimeSelfCheckCache?.cachedAtMs ?? Date.now()) {
  return {
    ...payload,
    selfCheckReuse: {
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

async function runtimeSelfCheckWithReuse(options = {}) {
  if (!options.forceRefresh && isRuntimeSelfCheckCacheFresh()) {
    return withRuntimeSelfCheckReuse(runtimeSelfCheckCache.payload, 'cache', runtimeSelfCheckCache.cachedAtMs);
  }

  if (!options.forceRefresh && runtimeSelfCheckInFlight) {
    const payload = await runtimeSelfCheckInFlight;
    return withRuntimeSelfCheckReuse(payload, 'in_flight');
  }

  runtimeSelfCheckInFlight = runtimeSelfCheck()
    .then((payload) => {
      if (payload?.ok === true) {
        runtimeSelfCheckCache = {
          payload,
          cachedAtMs: Date.now(),
          restartCount,
          childRuntimeCommit,
          childBridgeConfigHash
        };
      }
      return payload;
    })
    .finally(() => {
      runtimeSelfCheckInFlight = null;
    });

  const payload = await runtimeSelfCheckInFlight;
  return withRuntimeSelfCheckReuse(payload, 'fresh', Date.now());
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

function productFallbackTools() {
  return [
    {
      name: 'product_bridge_config_status',
      title: 'Product bridge config status',
      description:
        'Fallback declaration for the Product MCP bridge config status tool. The proxy forwards calls to the Product MCP child runtime once ready.',
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
        'Fallback declaration for checking ERP login state through the Product MCP child runtime.',
      inputSchema: {
        type: 'object',
        properties: {
          forceRefresh: {
            type: 'boolean',
            default: false,
            description: 'Bypass the token cache and read the ERP login token from Chrome again.'
          }
        },
        additionalProperties: false
      }
    },
    {
      name: 'product_precheck_package',
      title: 'Precheck product package',
      description:
        'Fallback declaration for prechecking a local ERP product material package before upload/create. The real Product MCP child validates the full input schema.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: true
      }
    },
    {
      name: 'product_create_from_package',
      title: 'Create product from package',
      description:
        'Fallback declaration for the high-level local package workflow. The real Product MCP child validates the input and runs precheck, duplicate gate, reference resolution, upload binding, create, and detail verification.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: true
      }
    },
    {
      name: 'product_create_from_batch',
      title: 'Create products from batch',
      description:
        'Fallback declaration for the high-level batch spreadsheet plus material-package workflow. The real Product MCP child validates the input and runs row-level material organization, precheck, duplicate gate, reference resolution, upload binding, create, per-row failure writeback, and detail verification.',
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
        'Fallback declaration for uploading a local product file to OSS. The real Product MCP child validates the full input schema.',
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
        'Fallback declaration for creating an ERP product. The real Product MCP child validates the full input schema.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: true
      }
    },
    {
      name: 'product_list_categories',
      title: 'List product categories',
      description: 'Fallback declaration for querying ERP product categories.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: true
      }
    },
    {
      name: 'product_get_category_config',
      title: 'Get product category config',
      description: 'Fallback declaration for querying ERP category units/configuration.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: true
      }
    },
    {
      name: 'product_list_suppliers',
      title: 'List suppliers',
      description: 'Fallback declaration for querying ERP supplier options.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: true
      }
    },
    {
      name: 'product_list_regions',
      title: 'List product regions',
      description: 'Fallback declaration for querying ERP region options.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: true
      }
    },
    {
      name: 'product_get_dict',
      title: 'Get system dict',
      description: 'Fallback declaration for querying ERP system dictionary values.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: true
      }
    },
    {
      name: 'product_get_detail',
      title: 'Get product detail',
      description: 'Fallback declaration for querying ERP product detail after creation.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: true
      }
    }
  ];
}

function mergeToolDeclarations(primaryTools, fallbackTools) {
  const tools = [...(primaryTools ?? [])];
  const names = new Set(tools.map((tool) => tool.name));
  for (const tool of fallbackTools) {
    if (!names.has(tool.name)) {
      tools.push(tool);
      names.add(tool.name);
    }
  }
  return tools;
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
  try {
    const child = await ensureChildRuntime();
    const result = await child.listTools();
    childToolsCache = result.tools ?? [];

    return {
      ...result,
      tools: mergeToolDeclarations(childToolsCache, [...productFallbackTools(), ...proxyTools()])
    };
  } catch (error) {
    process.stderr.write(`Product MCP child tool list failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return {
      tools: mergeToolDeclarations([], [...productFallbackTools(), ...proxyTools()])
    };
  }
}

async function callChildTool(name, args) {
  await syncProductMcp({ allowChildRestart: false });

  let child = await ensureChildRuntime();
  try {
    return await child.callTool({ name, arguments: args }, undefined, { timeout: childToolTimeoutMs(name) });
  } catch (error) {
    if (!isConnectionError(error)) {
      throw error;
    }

    await withRuntimeLock(async () => {
      await restartChildRuntime('child runtime connection was closed');
    });
    child = await ensureChildRuntime();
    return child.callTool({ name, arguments: args }, undefined, { timeout: childToolTimeoutMs(name) });
  }
}

async function callTool(request) {
  const name = request.params.name;
  const args = request.params.arguments ?? {};

  if (name === 'product_runtime_self_check') {
    return jsonResult(await runtimeSelfCheckWithReuse({ forceRefresh: args.forceRefresh === true }));
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
  await stopTokenDaemon('runtime proxy shutdown');
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

try {
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
} catch (error) {
  writeStartupFailure(error);
  process.exit(1);
}
