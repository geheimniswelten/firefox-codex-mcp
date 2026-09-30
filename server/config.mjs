import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

export function configPathFromArgs(args = process.argv.slice(2)) {
  const i = args.indexOf('--config');
  const value = i >= 0 ? args[i + 1] : process.env.FIREFOX_MCP_CONFIG;
  if (!value || !isAbsolute(value)) {
    throw new Error('An absolute configuration path is required: --config <path>. Run scripts/setup.mjs first.');
  }
  return value;
}

export async function loadConfig(path) {
  const config = JSON.parse(await readFile(path, 'utf8'));
  if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) {
    throw new Error('Invalid bridge port in configuration (expected 1024..65535).');
  }
  if (typeof config.token !== 'string' || !/^[a-f0-9]{64}$/i.test(config.token)) {
    throw new Error('Invalid bridge token in configuration. Run scripts/setup.mjs.');
  }
  return { port: config.port, token: config.token };
}
