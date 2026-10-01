import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { BridgeError, createBridgeClient } from '../server/bridge-client.mjs';

const token = 'a'.repeat(64);
async function listen(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await closed;
  });
  return server.address().port;
}

test('HTTP client authenticates and forwards method, parameters and browser errors', async t => {
  const requests = [];
  const port = await listen(t, async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/rpc');
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(requests.length === 1 ? { result: { tabs: [] } } : { error: { code: 'NO_TAB', message: 'Tab no longer exists.', details: { tabId: 2 } } }));
  });
  const bridge = createBridgeClient({ port, token });
  assert.deepEqual(await bridge.call('list_tabs', { limit: 10 }), { tabs: [] });
  await assert.rejects(bridge.call('get_tabs', { tabIds: [2] }), error => error instanceof BridgeError && error.code === 'NO_TAB' && error.details.tabId === 2);
  assert.deepEqual(requests, [{ method: 'list_tabs', params: { limit: 10 } }, { method: 'get_tabs', params: { tabIds: [2] } }]);
});

test('HTTP client bounds response size and validates response envelopes', async t => {
  let body = 'not json';
  const port = await listen(t, (_req, res) => res.end(body));
  const bridge = createBridgeClient({ port, token });
  await assert.rejects(bridge.call('status'), { code: 'INVALID_RESPONSE' });
  body = '{}';
  await assert.rejects(bridge.call('status'), { code: 'INVALID_RESPONSE' });
  body = JSON.stringify({ result: 'x'.repeat(900001) });
  await assert.rejects(bridge.call('status'), { code: 'RESPONSE_TOO_LARGE' });
});

test('HTTP client enforces the host 64 KiB request limit before dispatch', async t => {
  let requests = 0;
  const port = await listen(t, (_req, res) => { requests++; res.end(JSON.stringify({ result: {} })); });
  const bridge = createBridgeClient({ port, token });
  await assert.rejects(bridge.call('create_window', { url: [`https://example.com/${'a'.repeat(65536)}`] }), { code: 'REQUEST_TOO_LARGE' });
  assert.equal(requests, 0);
});

test('HTTP client never follows redirects or retries mutations', async t => {
  let attempts = 0;
  const port = await listen(t, (_req, res) => {
    attempts++;
    res.writeHead(302, { Location: 'http://example.com/' });
    res.end('{}');
  });
  const bridge = createBridgeClient({ port, token });
  await assert.rejects(bridge.call('close_tabs', { tabIds: [1] }), { code: 'BRIDGE_HTTP_ERROR' });
  assert.equal(attempts, 1);
});

test('timeouts and aborts explain uncertain mutation outcome without retry', async t => {
  let attempts = 0;
  const port = await listen(t, () => { attempts++; });
  const bridge = createBridgeClient({ port, token }, { timeoutMs: 50 });
  await assert.rejects(bridge.call('close_tabs', { tabIds: [1] }), error => error.code === 'BRIDGE_TIMEOUT' && /may have completed/.test(error.message));
  assert.equal(attempts, 1);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(bridge.call('close_tabs', { tabIds: [1] }, { signal: controller.signal }), { code: 'CANCELLED' });
  assert.equal(attempts, 1);
});

test('bridge authentication failures never expose the bearer token', async t => {
  const port = await listen(t, (_req, res) => {
    res.writeHead(401);
    res.end(token);
  });
  await assert.rejects(createBridgeClient({ port, token }).call('status'), error => error.code === 'BRIDGE_UNAUTHORIZED' && !error.message.includes(token));
  assert.throws(() => createBridgeClient({ port: 0, token }), { code: 'INVALID_CONFIG' });
});

test('content reads have a separate timeout to allow Firefox permission dialogs', async t => {
  const port = await listen(t, (_req, res) => {
    setTimeout(() => res.end(JSON.stringify({ result: { content: 'approved content' } })), 80);
  });
  const bridge = createBridgeClient({ port, token }, { timeoutMs: 25, contentTimeoutMs: 500 });
  assert.deepEqual(await bridge.call('read_content', { tabId: 1 }), { content: 'approved content' });
});

test('exports have a longer timeout for approval, capture and the native PDF dialog', async t => {
  const port = await listen(t, (_req, res) => {
    setTimeout(() => res.end(JSON.stringify({ result: { ready: true } })), 80);
  });
  const bridge = createBridgeClient({ port, token }, { timeoutMs: 25, contentTimeoutMs: 25, exportTimeoutMs: 500 });
  for (const method of ['save_png', 'save_html', 'save_pdf']) assert.deepEqual(await bridge.call(method, { tabId: 1 }), { ready: true });
  await assert.rejects(bridge.call('export_chunk', { transferId: 'one', index: 0 }), { code: 'BRIDGE_TIMEOUT' });
  assert.throws(() => createBridgeClient({ port, token }, { exportTimeoutMs: 600001 }), { code: 'INVALID_CONFIG' });
});
