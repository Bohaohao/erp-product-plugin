import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pluginRoot = dirname(scriptDir);
const productMcpRepoUrl = 'https://github.com/Bohaohao/product-mcp.git';
const productMcpRef = 'master';
const siblingProductMcp = resolve(pluginRoot, '..', '..', '..', 'product-mcp');
const cachedProductMcp = join(homedir(), '.erp-product', 'product-mcp');
const bridgeConfig = join(pluginRoot, 'config', 'product-token-bridge.config.json');

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });

  if (result.error) {
    throw result.error;
  }

  if (result.stdout) process.stderr.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  if (result.status !== 0) {
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

function gitHead(dir) {
  return run('git', ['rev-parse', 'HEAD'], dir);
}

function tryResolveGitProductMcp() {
  try {
    if (!hasProductMcp(cachedProductMcp)) {
      mkdirSync(dirname(cachedProductMcp), { recursive: true });
      run('git', ['clone', productMcpRepoUrl, cachedProductMcp], dirname(cachedProductMcp));
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

const productMcp = resolveProductMcp();
const productMcpDir = productMcp.dir;
const bridgeEntry = join(productMcpDir, 'dist', 'localBridge.js');
const runtimeDependency = join(productMcpDir, 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json');

process.stderr.write(`Using Product MCP (${productMcp.source}): ${productMcpDir}\n`);

if (productMcp.updated || !existsSync(bridgeEntry)) {
  run(npmCommand(), ['ci'], productMcpDir);
  run(npmCommand(), ['run', 'build'], productMcpDir);
} else if (!existsSync(runtimeDependency)) {
  run(npmCommand(), ['ci', '--omit=dev'], productMcpDir);
}

const child = spawnSync(process.execPath, [bridgeEntry, '--config', bridgeConfig], {
  cwd: productMcpDir,
  env: process.env,
  stdio: 'inherit'
});

process.exit(child.status ?? 1);
