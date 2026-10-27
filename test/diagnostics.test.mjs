import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiagnostics, cpuDelta } from '../server/diagnostics.mjs';

const row = { pid: 1, startedAt: '2026-10-27T10:00:00Z', cpuSeconds: 4, workingSetBytes: 2000, privateBytes: 1000, threads: 2, handles: 20 };
test('CPU deltas handle multicore work, PID reuse, new processes and nonpositive intervals', () => {
  const before = { measuredAt: '2026-10-27T10:00:00Z', processes: [row] };
  const after = { measuredAt: '2026-10-27T10:00:02Z', processes: [{ ...row, cpuSeconds: 7, privateBytes: 1200 }, { ...row, pid: 2 }] };
  assert.equal(cpuDelta(before, after)[0].cpuPercentOneCore, 150);
  assert.equal(cpuDelta(before, after)[0].privateBytesChange, 200);
  assert.equal(cpuDelta(before, after)[1].cpuPercentOneCore, null);
  assert.equal(cpuDelta(before, { ...after, processes: [{ ...row, startedAt: '2026-10-27T10:00:01Z' }] })[0].cpuPercentOneCore, null);
  assert.equal(cpuDelta(before, before)[0].cpuPercentOneCore, null);
});
test('OS collector exposes only allowlisted fields and never emits subprocess errors', async () => {
  const collect = createDiagnostics({ osPlatform: 'win32', run(exe, args, options, callback) {
    assert.equal(options.windowsHide, true); assert.equal(options.timeout, 5000);
    callback(null, JSON.stringify([{ ...row, commandLine: 'secret', url: 'https://secret.test' }]));
  } });
  const result = await collect('get_processes', {}, { pageContentRead: false });
  assert.equal(result.nativeDiagnostics.resources.processes[0].pid, 1);
  assert.doesNotMatch(JSON.stringify(result), /secret/u);
  const failed = createDiagnostics({ osPlatform: 'win32', run(exe, args, options, callback) { callback(new Error('private command details')); } });
  assert.doesNotMatch(JSON.stringify(await failed('get_processes', {}, {})), /private command details/u);
});
test('unsupported platforms report missing sources without inventing measurements', async () => {
  const collect = createDiagnostics({ osPlatform: 'linux', run: () => assert.fail('No platform adapter') });
  assert.equal((await collect('get_processes', {}, {})).nativeDiagnostics.resources.available, false);
  assert.equal((await collect('get_network_state', {}, {})).nativeDiagnostics.network.available, false);
});
test('monitor waits once, computes two samples and rejects invalid intervals', async () => {
  let calls = 0, slept = 0;
  const collect = createDiagnostics({ osPlatform: 'win32', now: () => `2026-10-27T10:00:0${calls * 2}Z`, sleep: async ms => { slept++; assert.equal(ms, 2000); }, run(exe, args, options, callback) { calls++; callback(null, JSON.stringify([{ ...row, cpuSeconds: calls * 2 }])); } });
  const result = await collect('monitor_resources', {}, {});
  assert.equal(slept, 1); assert.equal(calls, 2);
  assert.equal(result.nativeDiagnostics.interval.processes[0].cpuPercentOneCore, 100);
  await assert.rejects(collect('monitor_resources', { durationMs: 999 }, {}));
});
test('socket collector returns counts without endpoints and bounds concurrent collection', async () => {
  const callbacks = [];
  const collect = createDiagnostics({ osPlatform: 'win32', run(exe, args, options, callback) { callbacks.push(callback); } });
  const first = collect('get_network_state', {}, {});
  const second = collect('get_environment', {}, {}); await second;
  const third = collect('get_network_state', {}, {});
  assert.equal(callbacks.length, 2);
  // Two outstanding OS operations are permitted, further work is rejected.
  const busy = await collect('get_processes', {}, {});
  assert.equal(busy.nativeDiagnostics.reason, 'DIAGNOSTICS_BUSY');
  for (const finish of callbacks) finish(null, JSON.stringify([{ state: 'Established', count: 2, remoteAddress: 'private' }]));
  const results = await Promise.all([first, third]);
  assert.doesNotMatch(JSON.stringify(results), /private/u);
});
