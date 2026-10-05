import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { BridgeError, createBridgeClient } from './bridge-client.mjs';
import { loadConfig, configPathFromArgs } from './config.mjs';
import { SERVER_INSTRUCTIONS, TOOL_DEFINITIONS } from './tools.mjs';
import { saveExport } from './exports.mjs';

export function createFirefoxServer({ bridge }) {
  const server = new McpServer({ name: 'firefox-codex-mcp', version: '1.0.6' }, { instructions: SERVER_INSTRUCTIONS });
  for (const definition of TOOL_DEFINITIONS) {
    const { method, name, ...configuration } = definition;
    server.registerTool(name, configuration, async (params, context) => {
      try {
        const options = { signal: context?.mcpReq?.signal };
        const result = method === 'save_png' || method === 'save_html'
          ? await saveExport(bridge, method, params, options)
          : await bridge.call(method, params, options);
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: { result },
          ...(result?.partialFailure === true ? { isError: true } : {}),
        };
      } catch (error) {
        const details = error instanceof BridgeError
          ? { code: error.code, message: error.message, ...(error.details !== undefined ? { details: error.details } : {}) }
          : { code: 'INTERNAL_ERROR', message: 'The Firefox bridge request failed unexpectedly.' };
        return { content: [{ type: 'text', text: JSON.stringify({ error: details }) }], structuredContent: { error: details }, isError: true };
      }
    });
  }
  return server;
}

export async function main(args = process.argv.slice(2)) {
  const config = await loadConfig(configPathFromArgs(args));
  const bridge = createBridgeClient(config);
  return serveStdio(() => createFirefoxServer({ bridge }), {
    onerror: () => process.stderr.write('Firefox MCP: protocol connection error.\n'),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    process.stderr.write(`Firefox MCP startup failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
