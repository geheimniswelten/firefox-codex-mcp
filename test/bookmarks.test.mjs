import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import '../extension/tab-search.js';
import '../extension/bookmarks.js';

const { validate, createBookmarks } = globalThis.FirefoxBridgeBookmarks;
const rootIds = ['root________', 'toolbar_____', 'menu________', 'unfiled_____', 'mobile______'];
const ids = result => result.map(node => node.id);

function fakeBrowser() {
  const added = Date.UTC(2026, 9, 4, 10, 15);
  const root = { id: rootIds[0], title: '', type: 'folder', children: [] };
  const folder = (id, title, children = []) => ({ id, title, type: 'folder', dateAdded: added, children });
  const bookmark = (id, title, url) => ({ id, title, type: 'bookmark', url, dateAdded: added });
  root.children = [
    folder(rootIds[1], 'Lesezeichen-Symbolleiste', [
      bookmark('direct000001', 'Direct Firefox', 'https://direct.test/'),
      folder('delphi000001', 'Delphi', [
        bookmark('duplicate001', 'DAI', 'https://example.test/delphi'),
        folder('nested000001', 'Unterordner', [bookmark('nested000002', 'Firefox MCP', 'https://nested.test/delphi')]),
        { id: 'separator001', title: '', type: 'separator', dateAdded: added }
      ])
    ]),
    folder(rootIds[2], 'Lesezeichen-Menü', [bookmark('duplicate002', 'DAI Duplicate', 'https://example.test/delphi')]),
    folder(rootIds[3], 'Weitere Lesezeichen'),
    folder(rootIds[4], 'Mobile Lesezeichen')
  ];
  const state = { root, calls: [], counter: 0, beforeGet: null, afterGet: null, failedMethod: null };
  const reindex = node => {
    for (const [index, child] of (node.children ?? []).entries()) {
      child.parentId = node.id; child.index = index; reindex(child);
    }
  };
  const find = (targetId, node = root) => node.id === targetId ? node : (node.children ?? []).map(child => find(targetId, child)).find(Boolean);
  const requireNode = targetId => {
    const node = find(targetId);
    if (!node) throw new Error('Missing fixture node');
    return node;
  };
  const record = (method, args) => {
    state.calls.push({ method, args: structuredClone(args) });
    if (state.failedMethod === method) throw new Error('Firefox fixture API failed');
  };
  const remove = targetId => {
    const node = requireNode(targetId), parent = requireNode(node.parentId);
    parent.children.splice(parent.children.indexOf(node), 1);
    reindex(root);
  };
  reindex(root);
  return {
    state, find,
    bookmarks: {
      async getTree() {
        record('getTree', []); state.beforeGet?.();
        const result = structuredClone([root]); state.afterGet?.(); return result;
      },
      async create(details) {
        record('create', [details]);
        const parent = requireNode(details.parentId);
        assert.equal(parent.type, 'folder');
        const node = { ...details, id: `created${String(++state.counter).padStart(5, '0')}`, dateAdded: added };
        if (node.type === 'folder') node.children = [];
        parent.children.splice(details.index ?? parent.children.length, 0, node);
        reindex(root); return structuredClone(node);
      },
      async update(targetId, details) {
        record('update', [targetId, details]);
        const node = requireNode(targetId); Object.assign(node, details); return structuredClone(node);
      },
      async move(targetId, details) {
        record('move', [targetId, details]);
        const node = requireNode(targetId), destination = requireNode(details.parentId ?? node.parentId);
        remove(targetId); destination.children.splice(details.index ?? destination.children.length, 0, node);
        reindex(root); return structuredClone(node);
      },
      async remove(targetId) {
        record('remove', [targetId]);
        assert.equal((requireNode(targetId).children ?? []).length, 0);
        remove(targetId);
      },
      async removeTree(targetId) { record('removeTree', [targetId]); remove(targetId); }
    }
  };
}

function nodeWorkers() {
  const workers = [];
  const workerUrl = new URL('../extension/tab-search-worker.js', import.meta.url);
  return {
    workers,
    workerFactory() {
      const source = `
        import { parentPort } from 'node:worker_threads';
        globalThis.postMessage = data => parentPort.postMessage(data);
        await import(${JSON.stringify(workerUrl.href)});
        parentPort.on('message', data => globalThis.onmessage({data}));
      `;
      const native = new Worker(new URL(`data:text/javascript,${encodeURIComponent(source)}`));
      const listeners = new Map();
      const adapter = {
        listeners, stopped: null,
        addEventListener(name, callback) {
          const listener = name === 'message' ? data => callback({ data }) : failure => callback({ message: failure.message });
          listeners.set(callback, { name, listener }); native.on(name, listener);
        },
        removeEventListener(name, callback) {
          const listener = listeners.get(callback);
          if (listener) { native.off(name, listener.listener); listeners.delete(callback); }
        },
        postMessage(data) { native.postMessage(data); },
        terminate() { this.stopped = native.terminate(); }
      };
      workers.push(adapter); return adapter;
    },
    async assertStopped(expected) {
      assert.equal(workers.length, expected);
      for (const worker of workers) {
        assert.ok(worker.stopped); await worker.stopped; assert.equal(worker.listeners.size, 0);
      }
    }
  };
}

test('bookmark validation normalizes URLs and defaults and accepts opaque IDs', () => {
  assert.deepEqual(validate('search_bookmarks', {}), { limit: 100, offset: 0, recursive: true });
  assert.deepEqual(validate('create_bookmark', { url: 'HTTPS://Example.TEST:443' }), { url: 'https://example.test/', title: '', type: 'bookmark', parentId: 'unfiled_____' });
  assert.equal(validate('create_bookmark', { url: 'about:blank', parentId: 'opaque-ID' }).parentId, 'opaque-ID');
  assert.equal(validate('create_bookmark', { type: 'folder', title: '' }).type, 'folder');
  assert.equal(validate('create_bookmark', { type: 'separator' }).title, '');
  assert.equal(validate('update_bookmark', { id: 'x'.repeat(128), title: 'x'.repeat(512) }).title.length, 512);
  assert.equal(validate('search_bookmarks', { limit: 500, offset: 2147483647 }).offset, 2147483647);
  assert.equal(validate('delete_bookmark', { id: 'duplicate001' }).recursive, false);
});

test('strict bookmark arguments reject unsupported fields, invalid URLs and incomplete changes', () => {
  const invalidCases = [
    ['search_bookmarks', null], ['search_bookmarks', []], ['search_bookmarks', { limit: 0 }],
    ['search_bookmarks', { limit: 501 }], ['search_bookmarks', { limit: 1.5 }], ['search_bookmarks', { offset: -1 }],
    ['search_bookmarks', { offset: 2147483648 }], ['search_bookmarks', { parentId: 1 }], ['search_bookmarks', { recursive: 'true' }],
    ['search_bookmarks', { query: '' }], ['search_bookmarks', { query: '[', matchMode: 'regex' }], ['search_bookmarks', { searchIn: 'title' }],
    ['search_bookmarks', { query: 'test', searchIn: 'path' }], ['search_bookmarks', { query: 'x', matchMode: 'glob' }],
    ['search_bookmarks', { query: 'x', caseSensitive: 1 }], ['search_bookmarks', { title: 'test' }],
    ['list_bookmark_folders', { query: 'test' }], ['create_bookmark', {}],
    ['create_bookmark', { type: 'folder', url: 'https://example.test/' }], ['create_bookmark', { type: 'separator', url: 'about:blank' }],
    ['create_bookmark', { type: 'invalid', url: 'https://example.test/' }], ['create_bookmark', { url: 'about:config' }],
    ['create_bookmark', { url: 'javascript:alert(1)' }], ['create_bookmark', { url: '/relative' }],
    ['create_bookmark', { url: 'https:example.test' }], ['create_bookmark', { url: ' https://example.test/' }],
    ['create_bookmark', { url: 'https://example.test/ ' }], ['create_bookmark', { url: 'https://exam\nple.test/' }],
    ['create_bookmark', { url: 'about:blank#fragment' }], ['create_bookmark', { url: 1 }],
    ['create_bookmark', { url: 'https://example.test/', title: 'x'.repeat(513) }], ['create_bookmark', { type: 'folder', title: null }],
    ['create_bookmark', { url: 'https://example.test/', parentId: '' }], ['create_bookmark', { type: 'folder', index: -1 }],
    ['create_bookmark', { type: 'folder', index: 1.5 }], ['update_bookmark', { id: 'duplicate001' }],
    ['update_bookmark', { title: 'New title' }], ['update_bookmark', { id: ' x ', title: 'New title' }],
    ['update_bookmark', { id: 'x'.repeat(129), title: 'New title' }], ['update_bookmark', { id: 'x\u0000', title: 'New title' }],
    ['update_bookmark', { id: 'duplicate001', parentId: 'menu________' }], ['move_bookmark', { id: 'duplicate001' }],
    ['move_bookmark', { id: 'duplicate001', parentId: null }], ['delete_bookmark', {}],
    ['delete_bookmark', { id: 'duplicate001', query: 'DAI' }], ['delete_bookmark', { id: 'duplicate001', recursive: null }]
  ];
  for (const [method, params] of invalidCases) assert.throws(() => validate(method, params), { code: 'INVALID_PARAMS' }, JSON.stringify([method, params]));
  assert.throws(() => validate('remove_all_bookmarks', {}), { code: 'METHOD_NOT_FOUND' });
});

test('invalid arguments are rejected before touching the Firefox bookmark tree', async () => {
  const browser = fakeBrowser(), service = createBookmarks(browser);
  await assert.rejects(service.handle('update_bookmark', { id: 'duplicate001', url: 'file:///fixture' }), { code: 'INVALID_PARAMS' });
  assert.equal(browser.state.calls.length, 0);
});

test('bookmark search retains duplicate URLs, ancestor paths and dates and filters before pagination', async () => {
  const browser = fakeBrowser(), service = createBookmarks(browser);
  const all = await service.handle('search_bookmarks', {});
  assert.deepEqual(ids(all.bookmarks), ['direct000001', 'duplicate001', 'nested000002', 'duplicate002']);
  assert.equal(all.untrustedContent, true); assert.equal(all.returned, 4);
  const filtered = await service.handle('search_bookmarks', { query: 'delphi', searchIn: 'url', limit: 1, offset: 1 });
  assert.equal(filtered.total, 3); assert.equal(filtered.nextOffset, 2); assert.equal(filtered.returned, 1);
  assert.deepEqual(ids(filtered.bookmarks), ['nested000002']);
  assert.deepEqual(filtered.bookmarks[0].path, ['Lesezeichen-Symbolleiste', 'Delphi', 'Unterordner']);
  assert.equal(filtered.bookmarks[0].dateAdded, '2026-10-04T10:15:00.000Z');
  const pastEnd = await service.handle('search_bookmarks', { query: 'delphi', offset: 100 });
  assert.equal(pastEnd.total, 3); assert.equal(pastEnd.returned, 0); assert.equal(pastEnd.nextOffset, null);
  assert.deepEqual(pastEnd.bookmarks, []);
});

test('folder subtree search respects recursive false and validates its actual parent ID', async () => {
  const service = createBookmarks(fakeBrowser());
  assert.deepEqual(ids((await service.handle('search_bookmarks', { parentId: 'delphi000001' })).bookmarks), ['duplicate001', 'nested000002']);
  assert.deepEqual(ids((await service.handle('search_bookmarks', { parentId: 'delphi000001', recursive: false })).bookmarks), ['duplicate001']);
  assert.deepEqual(ids((await service.handle('search_bookmarks', { query: 'firefox', searchIn: 'title' })).bookmarks), ['direct000001', 'nested000002']);
  assert.deepEqual(ids((await service.handle('search_bookmarks', { query: 'firefox', caseSensitive: true })).bookmarks), []);
  await assert.rejects(service.handle('search_bookmarks', { parentId: 'missing' }), { code: 'BOOKMARK_NOT_FOUND' });
  await assert.rejects(service.handle('search_bookmarks', { parentId: 'duplicate001' }), { code: 'BOOKMARK_PARENT_NOT_FOLDER' });
});

test('folder listing exposes toolbar and menu IDs without treating the internal root as a user folder', async () => {
  const service = createBookmarks(fakeBrowser());
  const all = await service.handle('list_bookmark_folders', {});
  assert.equal(all.total, 6); assert.equal(all.untrustedContent, true);
  assert.deepEqual(ids(all.folders), ['toolbar_____', 'delphi000001', 'nested000001', 'menu________', 'unfiled_____', 'mobile______']);
  const roots = await service.handle('list_bookmark_folders', { recursive: false });
  assert.deepEqual(ids(roots.folders), rootIds.slice(1));
  assert.deepEqual(roots.folders[0].path, []);
  const subtree = await service.handle('list_bookmark_folders', { parentId: 'toolbar_____', recursive: false });
  assert.deepEqual(ids(subtree.folders), ['delphi000001']);
  assert.deepEqual(subtree.folders[0].path, ['Lesezeichen-Symbolleiste']);
});

test('bookmark regex uses the existing real worker and paginates its filtered matches', async () => {
  const worker = nodeWorkers(), service = createBookmarks(fakeBrowser(), worker);
  const result = await service.handle('search_bookmarks', { query: '^DAI', searchIn: 'title', matchMode: 'regex', limit: 1, offset: 1 });
  assert.equal(result.total, 2); assert.deepEqual(ids(result.bookmarks), ['duplicate002']);
  await worker.assertStopped(1);
});

test('creating bookmarks, folders and separators chooses exact folder IDs and returns stable IDs', async () => {
  const browser = fakeBrowser(), service = createBookmarks(browser);
  const defaultBookmark = await service.handle('create_bookmark', { title: 'Fixture', url: 'https://new.test/' });
  assert.equal(defaultBookmark.bookmark.parentId, 'unfiled_____');
  assert.deepEqual(defaultBookmark.bookmark.path, ['Weitere Lesezeichen']);
  const folder = await service.handle('create_bookmark', { type: 'folder', title: 'Fixtures', parentId: 'toolbar_____', index: 0 });
  assert.equal(folder.bookmark.type, 'folder'); assert.equal(folder.bookmark.index, 0);
  assert.deepEqual(folder.bookmark.path, ['Lesezeichen-Symbolleiste']);
  const child = await service.handle('create_bookmark', { title: 'Nested', url: 'about:blank', parentId: folder.bookmark.id });
  assert.deepEqual(child.bookmark.path, ['Lesezeichen-Symbolleiste', 'Fixtures']);
  const separator = await service.handle('create_bookmark', { type: 'separator', parentId: 'menu________' });
  assert.equal(separator.bookmark.type, 'separator'); assert.equal(separator.bookmark.parentId, 'menu________');
  assert.equal(separator.bookmark.url, undefined);
  assert.equal(defaultBookmark.untrustedContent, true);
  assert.ok(browser.find(child.bookmark.id));
});

test('updating folder titles changes descendant paths while URL changes stay limited to bookmarks', async () => {
  const browser = fakeBrowser(), service = createBookmarks(browser);
  const folder = await service.handle('update_bookmark', { id: 'delphi000001', title: 'Delphi Tools' });
  assert.equal(folder.bookmark.title, 'Delphi Tools');
  const updated = await service.handle('update_bookmark', { id: 'duplicate001', title: 'DAI MCP', url: 'https://changed.test/' });
  assert.equal(updated.bookmark.url, 'https://changed.test/');
  assert.deepEqual(updated.bookmark.path, ['Lesezeichen-Symbolleiste', 'Delphi Tools']);
  await assert.rejects(service.handle('update_bookmark', { id: 'delphi000001', url: 'https://folder.test/' }), { code: 'INVALID_PARAMS' });
  await assert.rejects(service.handle('update_bookmark', { id: 'separator001', url: 'https://separator.test/' }), { code: 'INVALID_PARAMS' });
  assert.equal(browser.state.calls.filter(call => call.method === 'update').length, 2);
});

test('deletion targets the exact bookmark ID when separate folders contain the same URL', async () => {
  const browser = fakeBrowser(), service = createBookmarks(browser);
  const result = await service.handle('delete_bookmark', { id: 'duplicate001' });
  assert.deepEqual(result, { deleted: true, id: 'duplicate001', type: 'bookmark', recursive: false, untrustedContent: true });
  assert.equal(browser.find('duplicate001'), undefined); assert.ok(browser.find('duplicate002'));
  const remaining = await service.handle('search_bookmarks', { query: 'https://example.test/delphi', searchIn: 'url' });
  assert.deepEqual(ids(remaining.bookmarks), ['duplicate002']);
});

test('nonempty folders require explicit recursion and empty folder deletion uses remove', async () => {
  const browser = fakeBrowser(), service = createBookmarks(browser);
  await assert.rejects(service.handle('delete_bookmark', { id: 'delphi000001' }), { code: 'FOLDER_NOT_EMPTY' });
  assert.ok(browser.find('duplicate001')); assert.ok(browser.find('nested000002'));
  const empty = await service.handle('create_bookmark', { type: 'folder', title: 'Empty' });
  await service.handle('delete_bookmark', { id: empty.bookmark.id });
  const removed = await service.handle('delete_bookmark', { id: 'delphi000001', recursive: true });
  assert.equal(removed.recursive, true); assert.equal(removed.type, 'folder');
  for (const id of ['delphi000001', 'duplicate001', 'nested000001', 'nested000002', 'separator001']) assert.equal(browser.find(id), undefined);
  assert.ok(browser.find('duplicate002'));
  assert.equal(browser.state.calls.filter(call => call.method === 'removeTree').length, 1);
  assert.equal(browser.state.calls.filter(call => call.method === 'remove').length, 1);
});

test('moves can change folders or reorder entries and prevent self or descendant cycles', async () => {
  const browser = fakeBrowser(), service = createBookmarks(browser);
  const moved = await service.handle('move_bookmark', { id: 'duplicate001', parentId: 'menu________', index: 0 });
  assert.equal(moved.bookmark.parentId, 'menu________'); assert.equal(moved.bookmark.index, 0);
  assert.deepEqual(moved.bookmark.path, ['Lesezeichen-Menü']);
  const reordered = await service.handle('move_bookmark', { id: 'duplicate001', index: 1 });
  assert.equal(reordered.bookmark.index, 1); assert.equal(reordered.bookmark.parentId, 'menu________');
  for (const parentId of ['delphi000001', 'nested000001']) await assert.rejects(service.handle('move_bookmark', { id: 'delphi000001', parentId }), { code: 'BOOKMARK_CYCLE' });
  await assert.rejects(service.handle('move_bookmark', { id: 'duplicate001', parentId: 'duplicate002' }), { code: 'BOOKMARK_PARENT_NOT_FOLDER' });
  assert.equal(browser.state.calls.filter(call => call.method === 'move').length, 2);
});

test('Firefox root folders cannot be changed, moved or removed but remain valid insertion destinations', async () => {
  const browser = fakeBrowser(), service = createBookmarks(browser);
  for (const id of rootIds) {
    await assert.rejects(service.handle('update_bookmark', { id, title: 'Changed' }), { code: 'BOOKMARK_ROOT_PROTECTED' });
    await assert.rejects(service.handle('move_bookmark', { id, index: 0 }), { code: 'BOOKMARK_ROOT_PROTECTED' });
    await assert.rejects(service.handle('delete_bookmark', { id, recursive: true }), { code: 'BOOKMARK_ROOT_PROTECTED' });
  }
  await assert.rejects(service.handle('create_bookmark', { title: 'At root', url: 'https://fixture.test/', parentId: 'root________' }), { code: 'BOOKMARK_ROOT_PROTECTED' });
  await assert.rejects(service.handle('move_bookmark', { id: 'duplicate001', parentId: 'root________' }), { code: 'BOOKMARK_ROOT_PROTECTED' });
  assert.equal(browser.state.calls.filter(call => call.method !== 'getTree').length, 0);
});

test('missing IDs, unmodifiable nodes, missing APIs and failed browser operations return clear errors', async () => {
  const browser = fakeBrowser(), service = createBookmarks(browser);
  await assert.rejects(service.handle('delete_bookmark', { id: 'missing' }), { code: 'BOOKMARK_NOT_FOUND' });
  browser.find('delphi000001').unmodifiable = 'managed';
  await assert.rejects(service.handle('update_bookmark', { id: 'delphi000001', title: 'New' }), { code: 'BOOKMARK_UNMODIFIABLE' });
  await assert.rejects(service.handle('create_bookmark', { url: 'https://fixture.test/', parentId: 'delphi000001' }), { code: 'BOOKMARK_UNMODIFIABLE' });
  await assert.rejects(createBookmarks({}).handle('search_bookmarks', {}), { code: 'UNSUPPORTED' });
  delete browser.bookmarks.removeTree;
  await assert.rejects(service.handle('delete_bookmark', { id: 'nested000001', recursive: true }), { code: 'UNSUPPORTED' });
  assert.ok(browser.find('nested000002'));
  browser.state.failedMethod = 'update';
  await assert.rejects(service.handle('update_bookmark', { id: 'duplicate001', title: 'New' }), { code: 'BOOKMARKS_OPERATION_FAILED' });
});

test('assertLive runs immediately before every mutation and cancellation after tree read prevents changes', async () => {
  const browser = fakeBrowser(), service = createBookmarks(browser);
  let live = true, guards = 0;
  const context = { assertLive() { guards++; if (!live) throw Object.assign(new Error('cancelled'), { code: 'REQUEST_EXPIRED' }); } };
  browser.state.afterGet = () => { live = false; };
  await assert.rejects(service.handle('delete_bookmark', { id: 'duplicate001' }, context), { code: 'REQUEST_EXPIRED' });
  assert.ok(browser.find('duplicate001'));
  assert.equal(browser.state.calls.filter(call => call.method !== 'getTree').length, 0);
  browser.state.afterGet = null; live = true;
  const nativeCreate = browser.bookmarks.create;
  browser.bookmarks.create = async details => {
    assert.equal(guards, 5, 'A guard runs after the tree read and again immediately before create');
    return nativeCreate(details);
  };
  await service.handle('create_bookmark', { url: 'https://guard.test/' }, context);
  assert.equal(guards, 5);
});

test('a request expiring during a successful mutation retains the actual Firefox outcome', async () => {
  const browser = fakeBrowser(), service = createBookmarks(browser);
  let live = true;
  const context = { assertLive() { if (!live) throw Object.assign(new Error('expired'), { code: 'REQUEST_EXPIRED' }); } };
  for (const [apiMethod, bridgeMethod, params] of [
    ['create', 'create_bookmark', { title: 'Expires during create', url: 'https://fixture.test/' }],
    ['update', 'update_bookmark', { id: 'duplicate001', title: 'Expires during update' }],
    ['move', 'move_bookmark', { id: 'duplicate001', parentId: 'menu________' }],
    ['remove', 'delete_bookmark', { id: 'duplicate001' }],
    ['removeTree', 'delete_bookmark', { id: 'delphi000001', recursive: true }]
  ]) {
    live = true;
    const original = browser.bookmarks[apiMethod];
    browser.bookmarks[apiMethod] = async (...args) => {
      const result = await original(...args); live = false; return result;
    };
    const result = await service.handle(bridgeMethod, params, context);
    if (bridgeMethod === 'delete_bookmark') assert.equal(result.deleted, true);
    else assert.ok(browser.find(result.bookmark.id));
    assert.equal(live, false);
  }
  assert.equal(browser.find('duplicate001'), undefined);
  assert.equal(browser.find('delphi000001'), undefined);
});

test('a browser error after mutation reports that state may already have changed', async () => {
  const browser = fakeBrowser(), service = createBookmarks(browser);
  const original = browser.bookmarks.remove;
  browser.bookmarks.remove = async id => { await original(id); throw new Error('late API failure'); };
  await assert.rejects(service.handle('delete_bookmark', { id: 'duplicate001' }), { code: 'BOOKMARKS_OPERATION_FAILED', details: { stateMayHaveChanged: true } });
  assert.equal(browser.find('duplicate001'), undefined);
});
