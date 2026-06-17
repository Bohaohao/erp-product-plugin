import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pluginRoot = dirname(scriptDir);
const defaultSiblingProductMcp = resolve(pluginRoot, '..', '..', '..', 'product-mcp');
const userCacheProductMcp = join(homedir(), '.erp-product', 'product-mcp');
const productMcpDir = resolve(process.env.PRODUCT_MCP_HOME || (existsSync(defaultSiblingProductMcp) ? defaultSiblingProductMcp : userCacheProductMcp));
const productMcpRepoUrl = process.env.PRODUCT_MCP_REPO_URL || '';
const bridgeConfig = join(pluginRoot, 'config', 'product-token-bridge.config.json');
const bridgeEntry = join(productMcpDir, 'dist', 'localBridge.js');
const runtimeDependency = join(productMcpDir, 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json');

function run(command, args, cwd = productMcpDir) {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });

  if (result.stdout) process.stderr.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

if (!existsSync(join(productMcpDir, 'package.json'))) {
  if (!productMcpRepoUrl) {
    throw new Error(
      `Product MCP repo not found: ${productMcpDir}. Clone product-mcp next to this plugin repo, set PRODUCT_MCP_HOME, or set PRODUCT_MCP_REPO_URL.`
    );
  }

  mkdirSync(dirname(productMcpDir), { recursive: true });
  run('git', ['clone', productMcpRepoUrl, productMcpDir], dirname(productMcpDir));
}

if (!existsSync(bridgeEntry)) {
  run(npmCommand(), ['ci']);
  run(npmCommand(), ['run', 'build']);
} else if (!existsSync(runtimeDependency)) {
  run(npmCommand(), ['ci', '--omit=dev']);
}

const child = spawnSync(process.execPath, [bridgeEntry, '--config', bridgeConfig], {
  cwd: productMcpDir,
  env: process.env,
  stdio: 'inherit'
});

process.exit(child.status ?? 1);
