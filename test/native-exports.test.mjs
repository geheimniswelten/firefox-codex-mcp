import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBridge } from '../server/native-host.mjs';
import { createBridgeClient } from '../server/bridge-client.mjs';
import { NativeDecoder, encodeNativeMessage } from '../server/framing.mjs';
import { saveExport, EXPORT_CHUNK_BYTES } from '../server/exports.mjs';

async function nativeFixture(t, handleCommand, options = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const token = 'ab'.repeat(32);
  const send = message => input.write(encodeNativeMessage(message));
  const decoder = new NativeDecoder(message => { if (message.id) handleCommand(message, send); });
  output.on('data', bytes => decoder.push(bytes));
  const host = createBridge({ port: 0, token, input, output, timeoutMs: 25, exportTimeoutMs: 500, ...options });
  t.after(() => { host.close(); input.destroy(); output.destroy(); });
  const port = await host.listen();
  send({ type: 'ready' });
  return { host, client: createBridgeClient({ port, token }, { timeoutMs: 100, exportTimeoutMs: 700 }) };
}

test('native bridge permits public exports and private fixed-size chunks with export deadlines', async t => {
  const received = [];
  const chunk = Buffer.alloc(EXPORT_CHUNK_BYTES, 17).toString('base64');
  const f = await nativeFixture(t, (message, send) => {
    received.push(message);
    if (message.method.startsWith('save_')) {
      assert.ok(message.expiresAt - Date.now() > 400);
      setTimeout(() => send({ id: message.id, result: { ready: true } }), 50);
    } else {
      assert.ok(message.expiresAt - Date.now() <= 25);
      send({ id: message.id, result: message.method === 'export_chunk' ? { index: 0, data: chunk, done: false } : { released: true } });
    }
  });
  for (const method of ['save_png', 'save_html', 'save_pdf']) assert.deepEqual(await f.client.call(method, { tabId: 1 }), { ready: true });
  const result = await f.client.call('export_chunk', { transferId: 'test-id', index: 0 });
  assert.equal(Buffer.from(result.data, 'base64').length, EXPORT_CHUNK_BYTES);
  assert.deepEqual(await f.client.call('export_release', { transferId: 'test-id' }), { released: true });
  assert.deepEqual(received.map(command => command.method), ['save_png', 'save_html', 'save_pdf', 'export_chunk', 'export_release']);
});

test('native export timeouts do not retry or replay late capture responses', async t => {
  const received = [];
  const f = await nativeFixture(t, (message, send) => {
    received.push(message);
    setTimeout(() => send({ id: message.id, result: { ready: true } }), 70);
  }, { exportTimeoutMs: 30 });
  await assert.rejects(f.client.call('save_png', { tabId: 1 }), { code: 'TIMEOUT' });
  assert.equal(received.length, 1);
  assert.equal(received[0].method, 'save_png');
  assert.throws(() => createBridge({ exportTimeoutMs: 600001 }), /Export timeout/);
});

test('an export exceeding one native packet roundtrips losslessly through the real HTTP and native bridges', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'firefox-native-export-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'fullpage.png');
  const bytes = Buffer.alloc(1_100_007);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37) % 251;
  const received = [];
  const f = await nativeFixture(t, (message, send) => {
    received.push(message);
    const result = message.method === 'save_png' ? { transferId: 'native-export-id', byteLength: bytes.length, mimeType: 'image/png' }
      : message.method === 'export_release' ? { released: true }
      : (() => {
        const start = message.params.index * EXPORT_CHUNK_BYTES;
        const data = bytes.subarray(start, start + EXPORT_CHUNK_BYTES);
        return { index: message.params.index, data: data.toString('base64'), done: start + data.length === bytes.length };
      })();
    send({ id: message.id, result });
  }, { timeoutMs: 500 });
  const result = await saveExport(f.client, 'save_png', { tabId: 8, path, fullPage: true });
  assert.deepEqual(await readFile(path), bytes);
  assert.equal(result.byteLength, bytes.length);
  assert.deepEqual(received[0].params, { tabId: 8, fullPage: true });
  assert.deepEqual(received.filter(message => message.method === 'export_chunk').map(message => message.params.index), [0, 1, 2, 3, 4]);
  assert.equal(received.at(-1).method, 'export_release');
});
