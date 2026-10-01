import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BridgeError } from '../server/bridge-client.mjs';
import { saveExport, isValidExportPath, EXPORT_CHUNK_BYTES, MAX_EXPORT_BYTES } from '../server/exports.mjs';

async function destination(t, extension = '.png') {
  const dir = await mkdtemp(join(tmpdir(), 'firefox-export-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, `page${extension}`);
}

function transferBridge(bytes, { metadata = {}, chunk = value => value, onCall = () => {}, releaseError } = {}) {
  const calls = [];
  return {
    calls,
    async call(method, params, options = {}) {
      calls.push({ method, params, options });
      await onCall(method, params, options);
      if (method === 'save_png' || method === 'save_html') return { transferId: 'export-id', byteLength: bytes.length, mimeType: method === 'save_png' ? 'image/png' : 'text/html', warnings: [], ...metadata };
      if (method === 'export_chunk') {
        const start = params.index * EXPORT_CHUNK_BYTES;
        const data = bytes.subarray(start, start + EXPORT_CHUNK_BYTES);
        return chunk({ index: params.index, data: data.toString('base64'), done: start + data.length === bytes.length });
      }
      if (method === 'export_release') {
        if (releaseError) throw releaseError;
        return { released: true };
      }
      throw new Error('Unexpected bridge method.');
    },
  };
}

test('PNG exports write every byte in ordered bounded chunks and release once', async t => {
  const path = await destination(t);
  const bytes = Buffer.alloc(EXPORT_CHUNK_BYTES + 17);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  const bridge = transferBridge(bytes, { metadata: { width: 1440, height: 8000 } });
  const controller = new AbortController();
  const result = await saveExport(bridge, 'save_png', { tabId: 7, path, fullPage: true, loadDeferred: false, maxHeight: 30000 }, { signal: controller.signal });
  assert.deepEqual(await readFile(path), bytes);
  assert.deepEqual(result, { byteLength: bytes.length, mimeType: 'image/png', warnings: [], width: 1440, height: 8000, saved: true, path });
  assert.deepEqual(bridge.calls.map(({ method, params }) => ({ method, params })), [
    { method: 'save_png', params: { tabId: 7, fullPage: true, loadDeferred: false, maxHeight: 30000 } },
    { method: 'export_chunk', params: { transferId: 'export-id', index: 0 } },
    { method: 'export_chunk', params: { transferId: 'export-id', index: 1 } },
    { method: 'export_release', params: { transferId: 'export-id' } },
  ]);
  assert.equal(bridge.calls[0].options.signal, controller.signal);
  assert.equal(bridge.calls.at(-1).options.signal, undefined);
});

test('HTML exports use byte counts correctly for Unicode and embed only to the caller path', async t => {
  const path = await destination(t, '.html');
  const bytes = Buffer.from('<!doctype html><p>Grüße ☕ 日本語</p>');
  const bridge = transferBridge(bytes, { metadata: { fileName: '../../untrusted.html', warnings: ['One image could not be embedded.'] } });
  const result = await saveExport(bridge, 'save_html', { tabId: 1, path });
  assert.deepEqual(await readFile(path), bytes);
  assert.equal(result.path, path);
  assert.equal(result.byteLength, bytes.length);
  assert.deepEqual(result.warnings, ['One image could not be embedded.']);
  assert.equal(bridge.calls[0].params.path, undefined);
});

test('existing destinations are never overwritten, removed or sent to Firefox', async t => {
  const path = await destination(t);
  await writeFile(path, 'existing user file');
  const bridge = transferBridge(Buffer.from('new data'));
  await assert.rejects(saveExport(bridge, 'save_png', { tabId: 1, path }), { code: 'FILE_EXISTS' });
  assert.equal(await readFile(path, 'utf8'), 'existing user file');
  assert.equal(bridge.calls.length, 0);
});

test('a destination replaced during capture is never removed during cleanup or reported as the export', async t => {
  const path = await destination(t);
  const moved = path.replace('page.png', 'moved.png');
  const bridge = transferBridge(Buffer.from('new data'), { async onCall(method) {
    if (method === 'save_png') {
      await rename(path, moved);
      await writeFile(path, 'replacement user file');
    }
  } });
  await assert.rejects(saveExport(bridge, 'save_png', { tabId: 1, path }), { code: 'OUTPUT_CHANGED' });
  assert.equal(await readFile(path, 'utf8'), 'replacement user file');
  assert.equal(bridge.calls.at(-1).method, 'export_release');
});

test('output paths reject relative, traversal, wrong format and Windows device destinations', async t => {
  const path = await destination(t);
  const invalid = ['page.png', 'C:page.png', path.replace('page.png', '../page.png'), `${path}.html`, path + '\u0000'];
  if (process.platform === 'win32') invalid.push('\u005cpage.png', 'C:\\CON.png', 'C:\\tmp\\NUL .png', 'C:\\tmp\\page:alternate.png', '\\\\?\\C:\\tmp\\page.png', 'C:\\tmp\\page .png ');
  for (const value of invalid) {
    assert.equal(isValidExportPath(value, 'save_png'), false, value);
    const bridge = transferBridge(Buffer.from('data'));
    await assert.rejects(saveExport(bridge, 'save_png', { tabId: 1, path: value }), { code: 'INVALID_OUTPUT_PATH' });
    assert.equal(bridge.calls.length, 0);
  }
  assert.ok(isValidExportPath(path.toUpperCase(), 'save_png'));
  assert.ok(isValidExportPath(path.replace('page.png', 'My page.png'), 'save_png'));
});

test('a missing destination directory fails before exporting and is not created implicitly', async t => {
  const path = (await destination(t)).replace('page.png', 'missing/page.png');
  const bridge = transferBridge(Buffer.from('data'));
  await assert.rejects(saveExport(bridge, 'save_png', { tabId: 1, path }), { code: 'OUTPUT_DIRECTORY_MISSING' });
  assert.equal(bridge.calls.length, 0);
  await assert.rejects(stat(path), { code: 'ENOENT' });
});

test('invalid export metadata removes the new file and releases valid transfer IDs', async t => {
  const metadataCases = [{ byteLength: 0 }, { byteLength: MAX_EXPORT_BYTES + 1 }, { byteLength: 1.5 }, { mimeType: 'text/html' }, { warnings: ['x'.repeat(4097)] }, { transferId: '../id' }];
  for (const metadata of metadataCases) {
    const path = await destination(t);
    const bridge = transferBridge(Buffer.from('data'), { metadata });
    await assert.rejects(saveExport(bridge, 'save_png', { tabId: 1, path }), { code: 'INVALID_EXPORT' });
    await assert.rejects(stat(path), { code: 'ENOENT' });
    assert.deepEqual(bridge.calls.map(call => call.method), Object.hasOwn(metadata, 'transferId') ? ['save_png'] : ['save_png', 'export_release']);
  }
});

test('malformed, reordered, short, oversized and prematurely ended chunks never produce partial exports', async t => {
  const cases = [
    value => ({ ...value, index: 1 }),
    value => ({ ...value, data: '%%%=' }),
    value => ({ ...value, data: 'Zh==' }), // Decodes but is not canonical base64.
    value => ({ ...value, data: Buffer.from('short').toString('base64') }),
    value => ({ ...value, data: Buffer.alloc(EXPORT_CHUNK_BYTES + 1).toString('base64') }),
    value => ({ ...value, done: true }),
    value => ({ ...value, done: 'false' }),
  ];
  for (const chunk of cases) {
    const path = await destination(t);
    const bridge = transferBridge(Buffer.alloc(EXPORT_CHUNK_BYTES + 1, 7), { chunk });
    await assert.rejects(saveExport(bridge, 'save_png', { tabId: 1, path }), { code: 'INVALID_EXPORT' });
    await assert.rejects(stat(path), { code: 'ENOENT' });
    assert.deepEqual(bridge.calls.map(call => call.method), ['save_png', 'export_chunk', 'export_release']);
  }
  const path = await destination(t);
  const bridge = transferBridge(Buffer.from('data'), { chunk: value => ({ ...value, done: false }) });
  await assert.rejects(saveExport(bridge, 'save_png', { tabId: 1, path }), { code: 'INVALID_EXPORT' });
  await assert.rejects(stat(path), { code: 'ENOENT' });
});

test('a failed chunk is never retried and preserves the browser error after cleanup', async t => {
  const path = await destination(t);
  const bridge = transferBridge(Buffer.alloc(EXPORT_CHUNK_BYTES + 1), { onCall(method, params) {
    if (method === 'export_chunk' && params.index === 1) throw new BridgeError('BRIDGE_DISCONNECTED', 'Disconnected during export.');
  } });
  await assert.rejects(saveExport(bridge, 'save_png', { tabId: 1, path }), { code: 'BRIDGE_DISCONNECTED' });
  await assert.rejects(stat(path), { code: 'ENOENT' });
  assert.deepEqual(bridge.calls.map(call => call.method), ['save_png', 'export_chunk', 'export_chunk', 'export_release']);
});

test('cancellation removes a partial file and releases with no aborted signal', async t => {
  const path = await destination(t);
  const controller = new AbortController();
  const bridge = transferBridge(Buffer.alloc(EXPORT_CHUNK_BYTES + 1), { onCall(method, params) {
    if (method === 'export_chunk' && params.index === 1) controller.abort();
  } });
  await assert.rejects(saveExport(bridge, 'save_png', { tabId: 1, path }, { signal: controller.signal }), { code: 'CANCELLED' });
  await assert.rejects(stat(path), { code: 'ENOENT' });
  assert.equal(bridge.calls.at(-1).method, 'export_release');
  assert.equal(bridge.calls.at(-1).options.signal, undefined);
  const before = await destination(t);
  const idle = transferBridge(Buffer.from('data'));
  await assert.rejects(saveExport(idle, 'save_png', { tabId: 1, path: before }, { signal: controller.signal }), { code: 'CANCELLED' });
  assert.equal(idle.calls.length, 0);
  await assert.rejects(stat(before), { code: 'ENOENT' });
});

test('failed release does not misreport a successfully saved export as failed', async t => {
  const path = await destination(t);
  const bytes = Buffer.from('complete export');
  const bridge = transferBridge(bytes, { releaseError: new BridgeError('BRIDGE_DISCONNECTED', 'Disconnected.') });
  const result = await saveExport(bridge, 'save_png', { tabId: 1, path });
  assert.equal(result.saved, true);
  assert.deepEqual(await readFile(path), bytes);
  assert.match(result.warnings.at(-1), /expire it automatically/);
});
