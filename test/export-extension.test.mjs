import test from 'node:test';
import assert from 'node:assert/strict';
import '../extension/export-transfers.js';
import '../extension/png-export.js';
import '../extension/pdf-export.js';
import '../extension/core.js';
const { createTransfers, CHUNK_BYTES, TTL_MS } = globalThis.FirefoxBridgeTransfers;
const { createService, validate } = globalThis.FirefoxBridgeCore;
const event = () => ({ addListener() {}, removeListener() {} });

test('export chunks preserve binary data beyond the native packet limit and reject invalid positions', async () => {
  const bytes = Uint8Array.from({ length: CHUNK_BYTES * 4 + 13 }, (_, i) => i % 251);
  const store = createTransfers({ id: () => 'test-transfer' });
  const result = store.put(bytes, { mimeType: 'image/png' });
  assert.equal(result.byteLength, bytes.length);
  const chunks = [];
  for (let index = 0; index < 5; index++) {
    const chunk = await store.chunk(result.transferId, index);
    assert.equal(chunk.index, index); assert.equal(chunk.done, index === 4);
    assert.ok(Buffer.byteLength(JSON.stringify(chunk)) < 800000);
    chunks.push(Buffer.from(chunk.data, 'base64'));
  }
  assert.deepEqual(Buffer.concat(chunks), Buffer.from(bytes));
  for (const index of [-1, 1.5, 5]) await assert.rejects(store.chunk(result.transferId, index), { code: 'INVALID_PARAMS' });
  assert.equal(store.release(result.transferId).released, true);
  await assert.rejects(store.chunk(result.transferId, 0), { code: 'EXPORT_EXPIRED' });
});

test('export buffers expire and permission revocation prevents further chunks', async () => {
  let now = 100, allowed = true, ids = 0;
  const store = createTransfers({ now: () => now, id: () => `transfer-${++ids}` });
  const first = store.put(new Uint8Array(1), {}, async () => { if (!allowed) throw Object.assign(new Error('revoked'), { code: 'CONTENT_DENIED' }); });
  allowed = false;
  await assert.rejects(store.chunk(first.transferId, 0), { code: 'CONTENT_DENIED' });
  allowed = true;
  await assert.rejects(store.chunk(first.transferId, 0), { code: 'EXPORT_EXPIRED' });
  const second = store.put(new Uint8Array(1), {});
  now += TTL_MS;
  await assert.rejects(store.chunk(second.transferId, 0), { code: 'EXPORT_EXPIRED' });
  const third = store.put(new Uint8Array(1), {}); store.clear();
  await assert.rejects(store.chunk(third.transferId, 0), { code: 'EXPORT_EXPIRED' });
});

test('export buffer limits do not evict another in-progress export', () => {
  let ids = 0;
  const store = createTransfers({ id: () => `transfer-${++ids}` });
  for (let i = 0; i < 4; i++) store.put(new Uint8Array(1), {});
  assert.throws(() => store.put(new Uint8Array(1), {}), { code: 'EXPORT_BUSY' });
  assert.throws(() => store.put(new Uint8Array(0), {}), { code: 'EXPORT_TOO_LARGE' });
});

function browserFixture() {
  const tab = { id: 1, windowId: 1, active: true, url: 'https://example.org/', title: 'Example', discarded: false };
  const browser = {
    tabs: { onCreated: event(), onRemoved: event(), onUpdated: event(), onActivated: event(), query: async () => [{ ...tab }], get: async () => ({ ...tab }) },
    windows: { onFocusChanged: event() },
    sessions: { getTabValue: async () => undefined, setTabValue: async () => {} },
  };
  return { browser, tab };
}

test('core applies content policy to export creation and every transfer chunk', async () => {
  const { browser, tab } = browserFixture();
  const calls = [];
  let allowed = true;
  const policy = { revision: 1, authorize: async value => { calls.push('authorize'); if (!allowed) throw Object.assign(new Error('denied'), { code: 'CONTENT_DENIED' }); return value; }, assertAfterRead: async () => { calls.push('check'); if (!allowed) throw Object.assign(new Error('denied'), { code: 'CONTENT_DENIED' }); return { ...tab }; } };
  const saved = globalThis.FirefoxBridgeHtml;
  try {
    globalThis.FirefoxBridgeHtml = { capture: async () => { calls.push('capture'); return { content: '<!doctype html>Grüße 🦊' + 'x'.repeat(1000000), warnings: [] }; } };
    const service = createService(browser, { contentAccess: policy });
    const result = await service.handle('save_html', { tabId: 1 });
    assert.ok(result.byteLength > 1000000); assert.equal(result.mimeType, 'text/html');
    assert.equal('content' in result, false); assert.equal(calls[0], 'authorize');
    const chunk = await service.handle('export_chunk', { transferId: result.transferId, index: 0 });
    assert.equal(chunk.data.length, 349528); assert.equal(chunk.truncated, undefined);
    allowed = false;
    await assert.rejects(service.handle('export_chunk', { transferId: result.transferId, index: 1 }), { code: 'CONTENT_DENIED' });
    await assert.rejects(service.handle('save_html', { tabId: 1 }), { code: 'CONTENT_DENIED' });
    assert.equal(calls.filter(value => value === 'capture').length, 1);
  } finally { globalThis.FirefoxBridgeHtml = saved; }
});

test('core refuses navigation/discarded/protected tabs without generating export bytes', async () => {
  const { browser, tab } = browserFixture();
  const saved = globalThis.FirefoxBridgeHtml;
  try {
    globalThis.FirefoxBridgeHtml = { capture: async () => { tab.url = 'https://other.example/'; return { content: 'bad' }; } };
    const service = createService(browser);
    await assert.rejects(service.handle('save_html', { tabId: 1 }), { code: 'PAGE_CHANGED' });
    tab.discarded = true;
    await assert.rejects(service.handle('save_html', { tabId: 1 }), { code: 'TAB_DISCARDED' });
    tab.discarded = false; tab.url = 'about:config';
    await assert.rejects(service.handle('save_html', { tabId: 1 }), { code: 'RESTRICTED_PAGE' });
  } finally { globalThis.FirefoxBridgeHtml = saved; }
});

test('PDF cannot bypass a permission reset while the final selected-window lookup is pending', async () => {
  const { browser, tab } = browserFixture();
  let prints = 0;
  const policy = { revision: 1, authorize: async value => value, assertAfterRead: async () => ({ ...tab }) };
  browser.windows.getLastFocused = async () => { policy.revision++; return { id: 1, type: 'normal', tabs: [{ ...tab }] }; };
  browser.tabs.saveAsPDF = async () => { prints++; return 'saved'; };
  const service = createService(browser, { contentAccess: policy });
  await assert.rejects(service.handle('save_pdf', { tabId: 1 }), { code: 'PERMISSION_CHANGED' });
  assert.equal(prints, 0);
});

test('screenshot uses current viewport width/full height and restores even after capture failure', async () => {
  let restoreCalls = 0;
  const captures = [];
  const browser = { tabs: {
    executeScript: async (_id, injection) => {
      if (injection.code.startsWith('(function restore')) { restoreCalls++; return [true]; }
      return [{ rect: { x: 40, y: 0, width: 1000, height: 2500 }, url: 'https://example.org/', warnings: [] }];
    },
    captureTab: async (id, options) => { captures.push({ id, options }); return 'data:image/png;base64,YQ=='; },
  } };
  const result = await globalThis.FirefoxBridgePng.capture(browser, 3, { loadDeferred: false });
  assert.equal(result.width, 1000); assert.equal(result.height, 2500);
  assert.deepEqual(captures[0], { id: 3, options: { format: 'png', rect: { x: 40, y: 0, width: 1000, height: 2500 }, scale: 1 } });
  assert.equal(restoreCalls, 1);
  await assert.rejects(globalThis.FirefoxBridgePng.capture(browser, 3, { maxHeight: 2000 }), { code: 'PAGE_TOO_LARGE' });
  assert.equal(captures.length, 1); assert.equal(restoreCalls, 2);
  browser.tabs.captureTab = async () => { throw new Error('capture failed'); };
  await assert.rejects(globalThis.FirefoxBridgePng.capture(browser, 3), /capture failed/);
  assert.equal(restoreCalls, 3);
});

test('internal export schemas reject malformed IDs, indexes and unknown file path fields', () => {
  for (const [method, args] of [['save_png', { tabId: 1, maxHeight: 0 }], ['save_png', { tabId: 1, fullPage: 'true' }], ['save_html', { tabId: 1, path: 'secret' }], ['save_pdf', {}], ['export_chunk', { transferId: '../secret', index: 0 }], ['export_chunk', { transferId: 'id', index: -1 }], ['export_release', {}]]) assert.throws(() => validate(method, args), { code: 'INVALID_PARAMS' });
  validate('save_png', { tabId: 1, fullPage: false, loadDeferred: true, maxHeight: 100000 });
  validate('export_chunk', { transferId: 'id', index: 0 });
});
