import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import http from 'node:http';
import { endianness } from 'node:os';
import { createBridge } from '../server/native-host.mjs';
import { createBridgeClient } from '../server/bridge-client.mjs';
import { NativeDecoder, encodeNativeMessage, MAX_NATIVE_BYTES } from '../server/framing.mjs';

const TOKEN = 'ab'.repeat(32);

test('native framing handles fragmented, coalesced and Unicode packets', () => {
  const messages = [];
  const decoder = new NativeDecoder(message => messages.push(message));
  const expected = [{ id: '1', result: { title: 'Grüße 🦊' } }, { type: 'ready' }];
  const data = Buffer.concat(expected.map(encodeNativeMessage));
  for (let i = 0; i < data.length; i += 3) decoder.push(data.subarray(i, i + 3));
  decoder.finish();
  assert.deepEqual(messages, expected);
});

test('native framing rejects overflow, malformed JSON and truncated input', () => {
  const header = Buffer.alloc(4);
  if (endianness() === 'LE') header.writeUInt32LE(MAX_NATIVE_BYTES + 1); else header.writeUInt32BE(MAX_NATIVE_BYTES + 1);
  assert.throws(() => new NativeDecoder(() => {}).push(header), /length/);
  assert.throws(() => encodeNativeMessage({ x: 'x'.repeat(MAX_NATIVE_BYTES) }), /size/);
  const decoder = new NativeDecoder(() => {});
  decoder.push(Buffer.from([1]));
  assert.throws(() => decoder.finish(), /Truncated/);
  const broken = encodeNativeMessage({ ok: true });
  broken[4] = 33;
  assert.throws(() => new NativeDecoder(() => {}).push(broken));
});

async function fixture(t, { timeoutMs = 500 } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const commands = [];
  const listeners = [];
  const decoder = new NativeDecoder(message => { commands.push(message); for (const fn of listeners) fn(message); });
  output.on('data', bytes => decoder.push(bytes));
  const bridge = createBridge({ port: 0, token: TOKEN, input, output, timeoutMs });
  t.after(() => { bridge.close(); input.destroy(); output.destroy(); });
  const port = await bridge.listen();
  const send = message => input.write(encodeNativeMessage(message));
  const request = (path = '/rpc', body = { method: 'status', params: {} }, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: body === null ? 'GET' : 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...headers } }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(body === null ? undefined : JSON.stringify(body));
  });
  return { send, request, commands, listeners, input, output, bridge, port };
}

test('loopback bridge authenticates and blocks web origins / DNS rebinding', async t => {
  const f = await fixture(t);
  f.send({ type: 'ready' });
  assert.equal((await f.request('/health', null)).body.result.connected, true);
  assert.equal((await f.request('/health', null, { Authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await f.request('/health', null, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await f.request('/health', null, { Origin: 'null' })).status, 403);
  assert.equal((await f.request('/health', null, { Host: `evil.example:${f.port}` })).status, 403);
  assert.equal((await f.request('/health', null, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal(f.commands.filter(command => command.id).length, 0);
});

test('bridge correlates concurrent requests and forwards Firefox errors', async t => {
  const f = await fixture(t);
  f.send({ type: 'ready' });
  const seen = [];
  f.listeners.push(command => {
    if (!command.id) return;
    seen.push(command);
    if (seen.length === 2) {
      f.send({ id: seen[1].id, error: { code: 'TAB_GONE', message: 'Tab no longer exists.' } });
      f.send({ id: seen[0].id, result: { title: 'Hallo 🦊' } });
    }
  });
  const [one, two] = await Promise.all([
    f.request('/rpc', { method: 'get_current', params: {} }),
    f.request('/rpc', { method: 'get_tabs', params: { tabIds: [1] } })
  ]);
  assert.deepEqual(one.body.result, { title: 'Hallo 🦊' });
  assert.equal(two.body.error.code, 'TAB_GONE');
});

test('bridge rejects unknown methods, oversized bodies and pre-ready calls', async t => {
  const f = await fixture(t);
  assert.equal((await f.request()).body.error.code, 'FIREFOX_NOT_READY');
  f.send({ type: 'ready' });
  assert.equal((await f.request('/rpc', { method: 'eval', params: {} })).status, 400);
  assert.equal((await f.request('/rpc', { method: 'status', params: {}, extra: 1 })).status, 400);
  assert.equal((await f.request('/rpc', { method: 'status', params: { large: 'x'.repeat(66_000) } })).status, 413);
  assert.equal(f.commands.filter(command => command.id).length, 0);
});

test('timeout does not retry commands or replay late replies', async t => {
  const f = await fixture(t, { timeoutMs: 30 });
  f.send({ type: 'ready' });
  const response = await f.request('/rpc', { method: 'close_tabs', params: { tabIds: [3] } });
  assert.equal(response.status, 504);
  assert.match(response.body.error.message, /may already have run/);
  const commands = f.commands.filter(command => command.id);
  assert.equal(commands.length, 1);
  f.send({ id: commands[0].id, result: { success: true } });
  assert.equal((await f.request('/health', null)).body.result.connected, true);
});

test('Firefox EOF closes listener and cancels pending commands', async t => {
  const f = await fixture(t);
  f.send({ type: 'ready' });
  f.listeners.push(command => { if (command.id) f.input.end(); });
  const response = await f.request();
  assert.equal(response.body.error.code, 'FIREFOX_DISCONNECTED');
  assert.equal(f.bridge.server.listening, false);
});

test('simultaneously completed slow bodies cannot exceed 64 pending commands', { timeout: 10_000 }, async t => {
  const f = await fixture(t, { timeoutMs: 5000 });
  f.send({ type: 'ready' });
  let count = 0, receivedAll;
  const allHeaders = new Promise(resolve => { receivedAll = resolve; });
  f.bridge.server.on('request', () => { if (++count === 65) receivedAll(); });
  const body = JSON.stringify({ method: 'get_current', params: {} });
  const clients = Array.from({ length: 65 }, () => {
    let request;
    const response = new Promise((resolve, reject) => {
      request = http.request({ host: '127.0.0.1', port: f.port, path: '/rpc', method: 'POST', agent: false,
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
      });
      request.on('error', reject);
      request.write(body.slice(0, 1));
    });
    response.catch(() => {});
    t.after(() => request.destroy());
    return { request, response };
  });
  await allHeaders;
  for (const { request } of clients) request.end(body.slice(1));
  const first = await Promise.race(clients.map(client => client.response));
  assert.equal(first.status, 429);
  assert.equal(first.body.error.code, 'BUSY');
  const commands = f.commands.filter(command => command.id);
  assert.equal(commands.length, 64);
  for (const command of commands) f.send({ id: command.id, result: { ok: true } });
  const responses = await Promise.all(clients.map(client => client.response));
  assert.equal(responses.filter(response => response.status === 200).length, 64);
});

test('a caller disconnected while streaming a body is never dispatched to Firefox', async t => {
  const f = await fixture(t);
  f.send({ type: 'ready' });
  let seen, closed;
  const started = new Promise(resolve => { seen = resolve; });
  const stopped = new Promise(resolve => { closed = resolve; });
  f.bridge.server.once('request', request => { request.once('close', closed); seen(); });
  const request = http.request({ host: '127.0.0.1', port: f.port, path: '/rpc', method: 'POST', agent: false,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' } });
  request.on('error', () => {});
  request.write('{');
  await started;
  request.destroy();
  await stopped;
  assert.equal(f.commands.filter(command => command.id).length, 0);
});

test('history timeout cancels the native scan instead of leaving it running', async t => {
  const f = await fixture(t, { timeoutMs: 20 });
  f.send({ type: 'ready' });
  const response = await f.request('/rpc', { method: 'search_history', params: { lastDays: 30 } });
  assert.equal(response.status, 504);
  assert.equal(response.body.error.code, 'TIMEOUT');
  const scan = f.commands.find(command => command.method === 'search_history');
  assert.ok(scan);
  assert.deepEqual(f.commands.find(command => command.type === 'cancel'), { type: 'cancel', id: scan.id });
});

test('wait requests have bounded per-request native deadlines and successful waits are not cancelled', async t => {
  const f = await fixture(t, { timeoutMs: 1 });
  f.send({ type: 'ready' });
  const originalSetTimeout = globalThis.setTimeout;
  const scheduled = t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => originalSetTimeout(callback, delay, ...args));
  f.listeners.push(command => {
    if (command.method === 'wait_for') f.send({ id: command.id, result: { ready: true } });
  });
  for (const [params, budget] of [
    [{}, 15_000], [{ timeoutMs: 1 }, 5_001], [{ timeoutMs: 120_000 }, 125_000],
    ...[0, -1, 1.5, 120_001, Number.MAX_SAFE_INTEGER, '120000', null, true].map(timeoutMs => [{ timeoutMs }, 15_000]),
  ]) {
    const before = scheduled.mock.calls.length, started = Date.now();
    const response = await f.request('/rpc', { method: 'wait_for', params: { tabId: 1, ...params } });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.result, { ready: true });
    const calls = scheduled.mock.calls.slice(before);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].arguments[1], budget, JSON.stringify(params));
    const command = f.commands.at(-1);
    assert.ok(command.expiresAt >= started + budget && command.expiresAt <= Date.now() + budget);
  }
  assert.deepEqual(f.commands.filter(command => command.type === 'cancel'), []);
});

test('native wait timeout cancels only its pending Firefox request and ignores a late reply', async t => {
  const f = await fixture(t);
  f.send({ type: 'ready' });
  const originalSetTimeout = globalThis.setTimeout, timers = [];
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    const timer = originalSetTimeout(callback, delay, ...args);
    timers.push({ callback, delay, timer });
    return timer;
  });
  let received;
  const dispatched = new Promise(resolve => { received = resolve; });
  f.listeners.push(command => { if (command.method === 'wait_for') received(command); });
  const result = f.request('/rpc', { method: 'wait_for', params: { tabId: 1, timeoutMs: 1 } });
  const command = await dispatched;
  assert.equal(timers.length, 1); assert.equal(timers[0].delay, 5_001);
  // Trigger the real transport callback without spending five seconds in a test.
  clearTimeout(timers[0].timer); timers[0].callback();
  const response = await result;
  assert.equal(response.status, 504); assert.equal(response.body.error.code, 'TIMEOUT');
  assert.deepEqual(f.commands.filter(message => message.type === 'cancel'), [{ type: 'cancel', id: command.id }]);
  f.send({ id: command.id, result: { ready: true } });
  assert.equal((await f.request('/health', null)).body.result.connected, true);
  assert.equal(f.commands.filter(message => message.method === 'wait_for').length, 1);
});

test('HTTP caller abort reaches Firefox as a wait-only cancellation and frees native pending slots', async t => {
  const f = await fixture(t);
  f.send({ type: 'ready' });
  const client = createBridgeClient({ port: f.port, token: TOKEN });
  let received, cancelled;
  const dispatched = new Promise(resolve => { received = resolve; });
  const cancellation = new Promise(resolve => { cancelled = resolve; });
  f.listeners.push(command => {
    if (command.method === 'wait_for') received(command);
    if (command.type === 'cancel') cancelled(command);
  });
  const controller = new AbortController();
  const waiting = client.call('wait_for', { tabId: 1, timeoutMs: 120_000 }, { signal: controller.signal });
  const command = await dispatched;
  controller.abort();
  await assert.rejects(waiting, { code: 'CANCELLED' });
  assert.deepEqual(await cancellation, { type: 'cancel', id: command.id });
  f.send({ id: command.id, result: { ready: true } });
  assert.equal((await f.request('/health', null)).body.result.connected, true);
  assert.equal(f.commands.filter(message => message.type === 'cancel').length, 1);

  let receivedMutation, closed;
  const mutationDispatched = new Promise(resolve => { receivedMutation = resolve; });
  const callerClosed = new Promise(resolve => { closed = resolve; });
  f.listeners.push(message => { if (message.method === 'close_tabs') receivedMutation(message); });
  f.bridge.server.once('request', (_request, response) => response.once('close', closed));
  const otherController = new AbortController();
  const mutation = client.call('close_tabs', { tabIds: [1] }, { signal: otherController.signal });
  await mutationDispatched; otherController.abort();
  await assert.rejects(mutation, { code: 'CANCELLED' });
  await callerClosed;
  assert.equal(f.commands.filter(message => message.type === 'cancel').length, 1);
});
