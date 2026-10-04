import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createBridge } from '../server/native-host.mjs';
import { createBridgeClient } from '../server/bridge-client.mjs';
import { NativeDecoder, encodeNativeMessage } from '../server/framing.mjs';
import { TOOL_DEFINITIONS } from '../server/tools.mjs';
import '../extension/tab-search.js';
import '../extension/history.js';
import '../extension/bookmarks.js';
import '../extension/core.js';

const { createService, validate, boundResponse } = globalThis.FirefoxBridgeCore;
const definitions = new Map(TOOL_DEFINITIONS.map(tool => [tool.method, tool]));
const NOW = Date.parse('2026-10-04T12:00:00Z');
const event = () => ({ addListener() {}, removeListener() {} });

function browserFixture() {
  const calls = [];
  const bookmark = { id: 'fixture-url', parentId: 'toolbar_____', type: 'bookmark', title: 'Manga', url: 'https://example.com/novel', index: 0 };
  return { calls, browser: {
    tabs: { query: async () => [], onCreated: event(), onRemoved: event(), onActivated: event(), onUpdated: event() },
    windows: { onFocusChanged: event() },
    history: {
      search: async params => { calls.push(['history.search', params]); return [{ id: 'page', title: 'Novels', url: bookmark.url }]; },
      getVisits: async () => [{ id: 'page', visitId: 'visit-yesterday', visitTime: NOW - 28 * 3600000 }, { id: 'page', visitId: 'visit-today', visitTime: NOW - 3600000 }],
    },
    bookmarks: {
      getTree: async () => [{ id: 'root________', type: 'folder', title: '', children: [{ id: 'toolbar_____', type: 'folder', title: 'Toolbar', children: [{ ...bookmark }] }, { id: 'unfiled_____', type: 'folder', title: 'Other', children: [] }] }],
      create: async params => { calls.push(['bookmarks.create', params]); return { ...params, id: 'new-bookmark' }; },
      update: async (id, params) => { calls.push(['bookmarks.update', id, params]); return { ...bookmark, ...params }; },
      move: async (id, params) => { calls.push(['bookmarks.move', id, params]); return { ...bookmark, ...params }; },
      remove: async id => { calls.push(['bookmarks.remove', id]); },
    },
  } };
}

test('all seven new methods travel through the HTTP/native bridge to the extension service', async t => {
  const f = browserFixture(), service = createService(f.browser, { now: () => NOW });
  const input = new PassThrough(), output = new PassThrough();
  const decoder = new NativeDecoder(message => {
    if (!message.method) return;
    service.handle(message.method, message.params).then(result => input.write(encodeNativeMessage({ id: message.id, result })), failure => input.write(encodeNativeMessage({ id: message.id, error: { code: failure.code, message: failure.message } })));
  });
  output.on('data', bytes => decoder.push(bytes));
  const token = 'cd'.repeat(32), bridge = createBridge({ port: 0, token, input, output });
  t.after(() => { bridge.close(); service.tracker.stop(); input.destroy(); output.destroy(); });
  const port = await bridge.listen();
  input.write(encodeNativeMessage({ type: 'ready' }));
  const client = createBridgeClient({ port, token });
  const history = await client.call('search_history', { query: 'novel', lastDays: 2, limit: 1 });
  assert.equal(history.visits[0].visitId, 'visit-today');
  assert.equal(history.total, 2);
  const second = await client.call('search_history', { snapshotId: history.snapshotId, offset: history.nextOffset });
  assert.equal(second.visits[0].visitId, 'visit-yesterday');
  assert.equal(f.calls.filter(([name]) => name === 'history.search').length, 1);
  const folders = await client.call('list_bookmark_folders', {});
  assert.deepEqual(folders.folders.map(folder => folder.id), ['toolbar_____', 'unfiled_____']);
  const found = await client.call('search_bookmarks', { parentId: 'toolbar_____', query: 'Manga', searchIn: 'title' });
  assert.equal(found.bookmarks[0].id, 'fixture-url');
  const created = await client.call('create_bookmark', { parentId: 'toolbar_____', title: 'Writing', url: 'https://example.com/write' });
  assert.equal(created.bookmark.id, 'new-bookmark');
  assert.equal((await client.call('update_bookmark', { id: 'fixture-url', title: 'Renamed' })).bookmark.title, 'Renamed');
  assert.equal((await client.call('move_bookmark', { id: 'fixture-url', parentId: 'unfiled_____', index: 0 })).bookmark.parentId, 'unfiled_____');
  assert.equal((await client.call('delete_bookmark', { id: 'fixture-url' })).deleted, true);
  await assert.rejects(client.call('delete_bookmark', { id: 'toolbar_____', recursive: true }), { code: 'BOOKMARK_ROOT_PROTECTED' });
  service.clearHistorySnapshots();
  await assert.rejects(client.call('search_history', { snapshotId: history.snapshotId }), { code: 'SNAPSHOT_EXPIRED' });
});

test('new schemas and extension agree on search, range, IDs and mutation constraints', () => {
  const valid = [
    ['search_history', {}], ['search_history', { lastHours: 0.5, query: 'Novel', searchIn: 'title' }],
    ['search_history', { from: '2026-10-03T00:00:00+02:00', to: '2026-10-04T00:00:00Z' }],
    ['search_history', { snapshotId: 'opaque-snapshot', limit: 500, offset: 1 }],
    ['search_bookmarks', { parentId: 'toolbar_____', query: 'novel', recursive: false }],
    ['list_bookmark_folders', {}], ['create_bookmark', { type: 'folder', title: 'New' }],
    ['create_bookmark', { type: 'separator' }], ['create_bookmark', { url: 'about:blank' }],
    ['update_bookmark', { id: 'opaque-id', title: '' }], ['move_bookmark', { id: 'opaque-id', index: 0 }],
    ['delete_bookmark', { id: 'opaque-id', recursive: true }],
  ];
  const invalid = [
    ['search_history', { lastHours: 1, lastDays: 1 }], ['search_history', { lastDays: 1, from: '2026-10-04T00:00:00Z' }],
    ['search_history', { lastHours: 0 }], ['search_history', { lastDays: 3661 }],
    ['search_history', { from: '2026-02-30T12:00:00Z' }], ['search_history', { from: '2026-10-04T12:00Z' }],
    ['search_history', { from: '2026-10-04T12:00:00' }], ['search_history', { from: '2026-10-04T12:00:00.1234Z' }],
    ['search_history', { from: '2026-10-04T12:00:00Z', to: '2026-10-03T12:00:00Z' }],
    ['search_history', { snapshotId: 'x', query: 'changed' }], ['search_history', { searchIn: 'url' }],
    ['search_bookmarks', { matchMode: 'regex' }], ['search_bookmarks', { limit: 501 }],
    ['list_bookmark_folders', { parentId: ' trimmed ' }], ['list_bookmark_folders', { recursive: 'yes' }],
    ['create_bookmark', {}], ['create_bookmark', { type: 'folder', url: 'https://example.com/' }],
    ['create_bookmark', { url: 'javascript:alert(1)' }], ['create_bookmark', { url: 'https://example.com/\n' }],
    ['update_bookmark', { id: 'x' }], ['move_bookmark', { id: 'x', index: -1 }],
    ['delete_bookmark', { id: 12 }], ['delete_bookmark', { id: 'x', recursive: 1 }],
  ];
  for (const [method, params] of valid) {
    assert.equal(definitions.get(method).inputSchema.safeParse(params).success, true, `${method} ${JSON.stringify(params)}`);
    assert.doesNotThrow(() => validate(method, params));
  }
  for (const [method, params] of invalid) {
    assert.equal(definitions.get(method).inputSchema.safeParse(params).success, false, `${method} ${JSON.stringify(params)}`);
    assert.throws(() => validate(method, params), { code: 'INVALID_PARAMS' });
  }
});

test('packet bounds preserve continuation offsets for history, bookmark and folder pages', () => {
  for (const key of ['visits', 'bookmarks', 'folders']) {
    const result = boundResponse({ [key]: Array.from({ length: 100 }, (_, id) => ({ id: String(id), title: '中'.repeat(10000) })), total: 200, offset: 10, limit: 100, returned: 100, nextOffset: 110, hasMore: true, snapshotId: 'fixed' });
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 800000);
    assert.ok(result[key].length > 0 && result[key].length < 100);
    assert.equal(result.returned, result[key].length);
    assert.equal(result.nextOffset, 10 + result.returned);
    assert.equal(result.hasMore, true);
    assert.equal(result.snapshotId, 'fixed');
  }
});
