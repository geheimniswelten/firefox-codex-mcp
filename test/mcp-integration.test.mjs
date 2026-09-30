import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const token = 'b'.repeat(64);
const project = dirname(dirname(fileURLToPath(import.meta.url)));

async function connect(t, port, mode = 'legacy') {
  const dir = await mkdtemp(join(tmpdir(), 'firefox-mcp-test-'));
  const config = join(dir, 'config.json');
  await writeFile(config, JSON.stringify({ port, token }));
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(project, 'server', 'mcp.mjs'), '--config', config], stderr: 'pipe' });
  let stderr = '';
  transport.stderr.on('data', chunk => { stderr += chunk; });
  const client = new Client({ name: 'firefox-mcp-integration-test', version: '1.0.0' }, { versionNegotiation: { mode } });
  t.after(async () => {
    await client.close();
    await rm(dir, { recursive: true, force: true });
    assert.equal(stderr, '', `MCP stderr: ${stderr}`);
  });
  await client.connect(transport);
  return client;
}

test('real SDK stdio exposes all tools, forwards calls and rejects invalid schemas before HTTP', async t => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    requests.push(request);
    let result = { method: request.method, params: request.params };
    if (request.method === 'close_tabs') result = { results: [{ tabId: 7, error: { code: 'NO_TAB', message: 'Missing tab.' } }], partialFailure: true };
    if (request.method === 'read_content') {
      res.end(JSON.stringify({ error: { code: 'TAB_DISCARDED', message: 'Activate or reload the tab explicitly before reading.' } }));
      return;
    }
    res.end(JSON.stringify({ result }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const client = await connect(t, server.address().port);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 22);
  assert.ok(tools.every(tool => tool.inputSchema.additionalProperties === false));
  assert.ok(client.getInstructions().includes('untrusted'));
  assert.equal(tools.find(tool => tool.name === 'firefox_close_tabs').annotations.destructiveHint, true);
  const result = await client.callTool({ name: 'firefox_list_tabs', arguments: { windowId: 3, limit: 5 } });
  assert.deepEqual(result.structuredContent, { result: { method: 'list_tabs', params: { windowId: 3, limit: 5 } } });
  assert.equal(result.isError, undefined);
  for (const args of [{ tabIds: [-1] }, { tabIds: [1], unknown: true }, { tabIds: [1, 1] }]) {
    const invalid = await client.callTool({ name: 'firefox_close_tabs', arguments: args });
    assert.equal(invalid.isError, true);
  }
  const invalidNavigation = await client.callTool({ name: 'firefox_create_tab', arguments: { url: 'javascript:alert(1)' } });
  assert.equal(invalidNavigation.isError, true);
  await assert.rejects(client.callTool({ name: 'firefox_execute_javascript', arguments: { code: 'alert(1)' } }), /not found/);
  assert.equal(requests.length, 1);
  const partial = await client.callTool({ name: 'firefox_close_tabs', arguments: { tabIds: [7] } });
  assert.equal(partial.isError, true);
  assert.equal(partial.structuredContent.result.partialFailure, true);
  const discarded = await client.callTool({ name: 'firefox_read_content', arguments: { tabId: 4 } });
  assert.equal(discarded.isError, true);
  assert.equal(discarded.structuredContent.error.code, 'TAB_DISCARDED');
  assert.equal(requests.length, 3);
});

test('tool discovery works offline and a call gives an actionable isError response', async t => {
  const probe = http.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const client = await connect(t, port);
  assert.equal((await client.listTools()).tools.length, 22);
  const response = await client.callTool({ name: 'firefox_status', arguments: {} });
  assert.equal(response.isError, true);
  assert.equal(response.structuredContent.error.code, 'FIREFOX_OFFLINE');
  assert.match(response.structuredContent.error.message, /Start Firefox/);
  assert.ok(!JSON.stringify(response).includes(token));
});

test('stdio supports modern protocol discovery as well as legacy initialization', async t => {
  const server = http.createServer((_req, res) => res.end(JSON.stringify({ result: { connected: true } })));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const client = await connect(t, server.address().port, 'auto');
  assert.equal((await client.listTools()).tools.length, 22);
  const response = await client.callTool({ name: 'firefox_status', arguments: {} });
  assert.deepEqual(response.structuredContent, { result: { connected: true } });
});

test('extension inventory forwards filters and surfaces consent requirements without retries', async t => {
  const requests = [];
  let permitted = true;
  const inventory = { extensions: [{ id: 'sample@example.invalid', name: 'Sample extension', version: '1.2.3', type: 'extension', enabled: false, disabledReason: 'permissions_increase' }], total: 4, offset: 3, limit: 2, returned: 1, nextOffset: null };
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.end(JSON.stringify(permitted ? { result: inventory } : { error: { code: 'INVENTORY_PERMISSION_REQUIRED', message: 'Allow technicalAndInteraction data in the Firefox toolbar before listing installed extensions.' } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const client = await connect(t, server.address().port);
  const name = 'firefox_list_extensions';
  const tool = (await client.listTools()).tools.find(tool => tool.name === name);
  assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  const args = { enabled: false, type: 'all', limit: 2, offset: 3 };
  const response = await client.callTool({ name, arguments: args });
  assert.deepEqual(response.structuredContent, { result: inventory });
  assert.deepEqual(requests[0], { method: 'list_extensions', params: args });
  await client.callTool({ name, arguments: {} });
  assert.deepEqual(requests[1], { method: 'list_extensions', params: {} });
  for (const args of [{ type: 'plugin' }, { enabled: 'false' }, { limit: 501 }, { offset: -1 }, { unknown: true }]) {
    const invalid = await client.callTool({ name, arguments: args });
    assert.equal(invalid.isError, true);
  }
  assert.equal(requests.length, 2);
  permitted = false;
  const denied = await client.callTool({ name, arguments: {} });
  assert.equal(denied.isError, true);
  assert.equal(denied.structuredContent.error.code, 'INVENTORY_PERMISSION_REQUIRED');
  assert.match(denied.structuredContent.error.message, /Firefox toolbar/);
  assert.equal(requests.length, 3);
});

for (const mode of ['legacy', 'auto']) {
  test(`SDK cancellation closes the HTTP request without retrying (${mode})`, async t => {
    let received;
    let disconnected;
    let attempts = 0;
    const receiving = new Promise(resolve => { received = resolve; });
    const disconnecting = new Promise(resolve => { disconnected = resolve; });
    const server = http.createServer(async (req, res) => {
      for await (const _chunk of req) { /* Consume the request body. */ }
      attempts++;
      res.once('close', disconnected);
      received();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => {
      server.closeAllConnections();
      return new Promise(resolve => server.close(resolve));
    });
    const client = await connect(t, server.address().port, mode);
    const controller = new AbortController();
    const pending = client.callTool({ name: 'firefox_read_content', arguments: { tabId: 1 } }, { signal: controller.signal });
    const rejected = assert.rejects(pending);
    await receiving;
    controller.abort();
    await rejected;
    await Promise.race([disconnecting, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('HTTP request did not close after SDK cancellation.')), 1000);
      timer.unref();
    })]);
    assert.equal(attempts, 1);
  });
}
