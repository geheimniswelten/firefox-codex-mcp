import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import http from 'node:http';
import { endianness } from 'node:os';
import { createBridge } from '../server/native-host.mjs';
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
