import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
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
    if (request.method === 'list_tabs' && request.params.query === '[' && request.params.matchMode === 'regex') {
      res.end(JSON.stringify({ error: { code: 'INVALID_PARAMS', message: 'Invalid Firefox regular expression.' } }));
      return;
    }
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
  assert.equal(tools.length, 25);
  assert.ok(tools.every(tool => tool.inputSchema.additionalProperties === false));
  assert.ok(client.getInstructions().includes('untrusted'));
  assert.equal(tools.find(tool => tool.name === 'firefox_close_tabs').annotations.destructiveHint, true);
  const search = { windowId: 3, limit: 5, query: '^https?://localhost(:[0-9]+)?/', searchIn: 'url', matchMode: 'regex', caseSensitive: false };
  const result = await client.callTool({ name: 'firefox_list_tabs', arguments: search });
  assert.deepEqual(result.structuredContent, { result: { method: 'list_tabs', params: search } });
  assert.equal(result.isError, undefined);
  for (const args of [{ tabIds: [-1] }, { tabIds: [1], unknown: true }, { tabIds: [1, 1] }]) {
    const invalid = await client.callTool({ name: 'firefox_close_tabs', arguments: args });
    assert.equal(invalid.isError, true);
  }
  const invalidNavigation = await client.callTool({ name: 'firefox_create_tab', arguments: { url: 'javascript:alert(1)' } });
  assert.equal(invalidNavigation.isError, true);
  for (const args of [{ searchIn: 'url' }, { query: 'x', caseSensitive: 'yes' }]) {
    assert.equal((await client.callTool({ name: 'firefox_list_tabs', arguments: args })).isError, true);
  }
  await assert.rejects(client.callTool({ name: 'firefox_execute_javascript', arguments: { code: 'alert(1)' } }), /not found/);
  assert.equal(requests.length, 1);
  const invalidRegex = await client.callTool({ name: 'firefox_list_tabs', arguments: { query: '[', matchMode: 'regex' } });
  assert.equal(invalidRegex.isError, true);
  assert.equal(invalidRegex.structuredContent.error.code, 'INVALID_PARAMS');
  assert.equal(requests.length, 2);
  const partial = await client.callTool({ name: 'firefox_close_tabs', arguments: { tabIds: [7] } });
  assert.equal(partial.isError, true);
  assert.equal(partial.structuredContent.result.partialFailure, true);
  const discarded = await client.callTool({ name: 'firefox_read_content', arguments: { tabId: 4 } });
  assert.equal(discarded.isError, true);
  assert.equal(discarded.structuredContent.error.code, 'TAB_DISCARDED');
  assert.equal(requests.length, 4);
});

test('tool discovery works offline and a call gives an actionable isError response', async t => {
  const probe = http.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const client = await connect(t, port);
  assert.equal((await client.listTools()).tools.length, 25);
  const response = await client.callTool({ name: 'firefox_status', arguments: {} });
  assert.equal(response.isError, true);
  assert.equal(response.structuredContent.error.code, 'FIREFOX_OFFLINE');
  assert.match(response.structuredContent.error.message, /Start Firefox/);
  assert.match(response.structuredContent.error.message, /First ask the user whether to wait/);
  assert.match(response.structuredContent.error.message, /about:debugging#\/runtime\/this-firefox/);
  assert.match(response.structuredContent.error.message, /retry firefox_status/);
  assert.match(response.structuredContent.error.message, /only as a last resort/);
  assert.match(client.getInstructions(), /do not open the debugging page or switch to Computer Use before asking/);
  assert.ok(!JSON.stringify(response).includes(token));
});

test('stdio supports modern protocol discovery as well as legacy initialization', async t => {
  const server = http.createServer((_req, res) => res.end(JSON.stringify({ result: { connected: true } })));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const client = await connect(t, server.address().port, 'auto');
  assert.equal((await client.listTools()).tools.length, 25);
  const response = await client.callTool({ name: 'firefox_status', arguments: {} });
  assert.deepEqual(response.structuredContent, { result: { connected: true } });
});

test('MCP exports save complete files through private chunks without leaking local paths to Firefox', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'firefox-mcp-export-integration-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const destination = join(dir, 'page.html');
  const bytes = Buffer.from('<!doctype html><title>Gespeichert</title><p>Grüße</p>');
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    requests.push(request);
    const result = request.method === 'save_html' ? { transferId: 'export-test', byteLength: bytes.length, mimeType: 'text/html', warnings: [] }
      : request.method === 'export_chunk' ? { index: 0, data: bytes.toString('base64'), done: true }
      : request.method === 'save_pdf' ? { tabId: 1, status: 'canceled', saved: false, format: 'pdf', destination: 'save-dialog', method: 'firefox-print' }
      : { released: true };
    res.end(JSON.stringify({ result }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const client = await connect(t, server.address().port);
  const response = await client.callTool({ name: 'firefox_save_html', arguments: { tabId: 1, path: destination, loadDeferred: false } });
  assert.equal(response.isError, undefined);
  assert.deepEqual(await readFile(destination), bytes);
  assert.equal(response.structuredContent.result.path, destination);
  assert.equal(response.structuredContent.result.saved, true);
  assert.equal(Object.hasOwn(response.structuredContent.result, 'transferId'), false);
  assert.deepEqual(requests, [
    { method: 'save_html', params: { tabId: 1, loadDeferred: false } },
    { method: 'export_chunk', params: { transferId: 'export-test', index: 0 } },
    { method: 'export_release', params: { transferId: 'export-test' } },
  ]);
  const exists = await client.callTool({ name: 'firefox_save_html', arguments: { tabId: 1, path: destination } });
  assert.equal(exists.structuredContent.error.code, 'FILE_EXISTS');
  assert.equal(requests.length, 3);
  assert.deepEqual(await readFile(destination), bytes);
  const pdf = await client.callTool({ name: 'firefox_save_pdf', arguments: { tabId: 1 } });
  assert.equal(pdf.structuredContent.result.status, 'canceled');
  assert.deepEqual(requests.at(-1), { method: 'save_pdf', params: { tabId: 1 } });
  for (const name of ['firefox_export_chunk', 'firefox_export_release']) await assert.rejects(client.callTool({ name, arguments: {} }), /not found/);
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
