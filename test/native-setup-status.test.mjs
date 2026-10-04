import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createServer } from 'node:net';
import { createBridge, HOST_VERSION, PROTOCOL_VERSION } from '../server/native-host.mjs';
import { NativeDecoder } from '../server/framing.mjs';

test('native setup report precedes connected and contains only explicit setup metadata', async t => {
  const input = new PassThrough(), output = new PassThrough(), messages = [];
  const decoder = new NativeDecoder(message => messages.push(message));
  output.on('data', bytes => decoder.push(bytes));
  const registration = { schemaVersion: 1, registrationRevision: 1, installerVersion: '1.0.2', registeredAt: '2026-10-04T00:00:00.000Z', platform: 'win', manifestPath: 'example', registrationPath: 'example' };
  const bridge = createBridge({ port: 0, token: 'ab'.repeat(32), input, output, registration });
  t.after(() => { bridge.close(); input.destroy(); output.destroy(); });
  await bridge.listen();
  assert.deepEqual(messages.slice(0, 2), [
    { type: 'setup_status', hostVersion: HOST_VERSION, protocolVersion: PROTOCOL_VERSION, registration },
    { type: 'connected' },
  ]);
  assert.ok(!JSON.stringify(messages).includes('ab'.repeat(32)));
});

test('native setup report still arrives when HTTP port is occupied', async t => {
  const occupied = createServer();
  await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
  const input = new PassThrough(), output = new PassThrough(), messages = [];
  output.on('data', bytes => new NativeDecoder(message => messages.push(message)).push(bytes));
  const bridge = createBridge({ port: occupied.address().port, token: 'ab'.repeat(32), input, output });
  t.after(() => { bridge.close(); occupied.close(); input.destroy(); output.destroy(); });
  await assert.rejects(bridge.listen(), { code: 'EADDRINUSE' });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'setup_status');
  assert.equal(messages[0].registration, null);
});
