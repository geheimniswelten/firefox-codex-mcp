import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import '../extension/core.js';
import '../extension/policy.js';
const { createService, SESSION_KEY, boundResponse, validate } = globalThis.FirefoxBridgeCore;
const { ContentAccess, iconStatus, SESSION_MS } = globalThis.FirefoxBridgePolicy;
const clone = value => structuredClone(value);

test('extension inventory includes disabled add-ons, filters supported types and paginates without mutating them', async () => {
  const browser = mockBrowser();
  const installed = [
    { id: 'disabled@test', name: 'Alpha', version: '2.3', type: 'extension', enabled: false, disabledReason: 'permissions_increase', permissions: ['tabs'] },
    { id: 'active@test', name: 'Beta', version: '1.0', type: 'extension', enabled: true, installType: 'normal', homepageUrl: 'https://example.org/' },
    { id: 'theme@test', name: 'A Theme', version: '3', type: 'theme', enabled: false },
    { id: 'other@test', name: 'Other', version: '1', type: 'hosted_app', enabled: true }
  ];
  browser.permissions = { getAll: async () => ({ data_collection: ['technicalAndInteraction'] }) };
  browser.management = { getAll: async () => clone(installed), setEnabled: () => assert.fail('Inventory must be read-only') };
  const service = createService(browser);
  const allExtensions = await service.handle('list_extensions');
  assert.deepEqual(allExtensions.extensions.map(addon => addon.id), ['disabled@test', 'active@test']);
  assert.equal(allExtensions.extensions[0].enabled, false);
  assert.equal(allExtensions.extensions[0].disabledReason, 'permissions_increase');
  assert.equal(allExtensions.extensions[1].installType, 'normal');
  assert.equal('permissions' in allExtensions.extensions[0], false);
  assert.equal('homepageUrl' in allExtensions.extensions[1], false);
  assert.equal(allExtensions.total, 2);
  assert.equal(allExtensions.nextOffset, null);
  assert.deepEqual((await service.handle('list_extensions', { enabled: true })).extensions.map(addon => addon.id), ['active@test']);
  assert.deepEqual((await service.handle('list_extensions', { enabled: false })).extensions.map(addon => addon.id), ['disabled@test']);
  assert.deepEqual((await service.handle('list_extensions', { type: 'theme' })).extensions.map(addon => addon.id), ['theme@test']);
  const page = await service.handle('list_extensions', { type: 'all', limit: 1, offset: 1 });
  assert.equal(page.total, 3); assert.equal(page.returned, 1); assert.equal(page.nextOffset, 2);
  assert.equal((await service.handle('list_extensions', { offset: 99 })).returned, 0);
  assert.equal((await service.handle('list_extensions', { offset: 99 })).nextOffset, null);
  for (const args of [{ enabled: 'true' }, { type: 'plugin' }, { limit: 0 }, { limit: 501 }, { offset: -1 }, { unexpected: true }]) {
    await assert.rejects(service.handle('list_extensions', args), error => error.code === 'INVALID_PARAMS');
  }
});

test('inventory requires optional data consent before reading and refuses data when consent is revoked while reading', async () => {
  const browser = mockBrowser();
  let allowed = false, reads = 0;
  browser.permissions = { getAll: async () => ({ data_collection: allowed ? ['technicalAndInteraction'] : [] }) };
  browser.management = { getAll: async () => { reads++; allowed = false; return [{ id: 'test', name: 'Test', type: 'extension', enabled: true }]; } };
  const service = createService(browser);
  await assert.rejects(service.handle('list_extensions'), error => error.code === 'INVENTORY_PERMISSION_REQUIRED');
  assert.equal(reads, 0);
  allowed = true;
  await assert.rejects(service.handle('list_extensions'), error => error.code === 'INVENTORY_PERMISSION_REQUIRED');
  assert.equal(reads, 1);
  allowed = true; delete browser.management;
  await assert.rejects(service.handle('list_extensions'), error => error.code === 'MANAGEMENT_UNAVAILABLE');
});

test('oversized inventory pages preserve pagination when the native packet cap reduces a page', () => {
  const result = boundResponse({ extensions: Array.from({ length: 100 }, (_, i) => ({ id: `addon-${i}`, description: 'x'.repeat(10000), enabled: false })), offset: 10, limit: 100, total: 150, returned: 100, nextOffset: 110 });
  assert.equal(result.truncated, true);
  assert.ok(result.extensions.length > 0 && result.extensions.length < 100);
  assert.equal(result.nextOffset, 10 + result.extensions.length);
  assert.equal(result.returned, result.extensions.length);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 800000);
});
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
function event() {
  const listeners = new Set();
  return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn), emit: (...args) => [...listeners].map(fn => fn(...args)) };
}
function mockBrowser(initial = []) {
  const tabs = new Map(initial.map(tab => [tab.id, { windowId: 1, index: tab.id, groupId: -1, active: false, discarded: false, url: 'https://example.com/', title: 'Example', ...tab }]));
  const saved = new Map(), calls = [];
  const browser = {
    calls, tabMap: tabs, saved,
    tabs: {
      onCreated: event(), onRemoved: event(), onActivated: event(), onUpdated: event(),
      async query(query) { return [...tabs.values()].filter(tab => Object.entries(query).every(([key, value]) => key === 'muted' ? Boolean(tab.mutedInfo?.muted) === value : tab[key] === value)).map(clone); },
      async get(id) { if (!tabs.has(id)) throw new Error(`No tab ${id}`); return clone(tabs.get(id)); },
      async create(properties) { const id = Math.max(0, ...tabs.keys()) + 1, tab = { id, windowId: 1, index: id, active: true, url: 'about:blank', title: '', ...properties }; tabs.set(id, tab); browser.tabs.onCreated.emit(clone(tab)); return clone(tab); },
      async update(id, properties) { calls.push(['update', id, properties]); const tab = await this.get(id); Object.assign(tab, properties); if ('muted' in properties) { tab.mutedInfo = { muted: properties.muted }; delete tab.muted; } tabs.set(id, tab); return clone(tab); },
      async remove(id) { calls.push(['remove', id]); await this.get(id); tabs.delete(id); saved.delete(id); browser.tabs.onRemoved.emit(id); },
      async reload(id, options) { calls.push(['reload', id, options]); await this.get(id); tabs.get(id).discarded = false; browser.tabs.onUpdated.emit(id, { discarded: false }, clone(tabs.get(id))); },
      async discard(id) { calls.push(['discard', id]); await this.get(id); tabs.get(id).discarded = true; browser.tabs.onUpdated.emit(id, { discarded: true }, clone(tabs.get(id))); },
      async move(ids, options) { calls.push(['move', ids, options]); await Promise.all(ids.map(id => this.get(id))); return ids.map(id => clone(tabs.get(id))); },
      async group(options) { calls.push(['group', options]); for (const id of options.tabIds) { await this.get(id); tabs.get(id).groupId = options.groupId ?? 42; } return options.groupId ?? 42; },
      async ungroup(id) { calls.push(['ungroup', id]); tabs.get(id).groupId = -1; },
      async executeScript(id, options) {
        calls.push(['executeScript', id, options]);
        const tab = await this.get(id);
        const root = { innerText: 'Visible page text', textContent: 'Visible page text', outerHTML: '<main>Visible page text</main>', querySelectorAll: () => [] };
        return [vm.runInNewContext(options.code, { document: { title: tab.title, documentElement: root, querySelector(selector) { if (selector === '[') throw new Error('syntax'); return selector === '#missing' ? null : root; } }, location: { href: tab.url } })];
      }
    },
    sessions: { async getTabValue(id, key) { assert.equal(key, SESSION_KEY); return saved.has(id) ? clone(saved.get(id)) : undefined; }, async setTabValue(id, key, value) { assert.equal(key, SESSION_KEY); if (tabs.has(id)) saved.set(id, clone(value)); } },
    windows: {
      onFocusChanged: event(), onRemoved: event(),
      async get(id, options) { return { id, type: 'normal', focused: false, ...(options.populate ? { tabs: [...tabs.values()].filter(tab => tab.windowId === id).map(clone) } : {}) }; },
      async getLastFocused(options) { calls.push(['getLastFocused', options]); return { id: 1, type: 'normal', focused: false, tabs: [...tabs.values()].filter(tab => tab.windowId === 1).map(clone) }; },
      async getAll(options) { return [{ id: 1, type: 'normal', ...(options.populate ? { tabs: [...tabs.values()].map(clone) } : {}) }]; },
      async create(options) { calls.push(['createWindow', options]); return { id: 99, ...options }; },
      async update(id, options) { calls.push(['updateWindow', id, options]); return { id, ...options }; },
      async remove(id) { calls.push(['removeWindow', id]); browser.windows.onRemoved.emit(id); }
    },
    tabGroups: {
      async query(query) { calls.push(['queryGroups', query]); return [{ id: 42, windowId: 1, title: 'Native', color: 'blue' }]; },
      async get(id) { return { id, windowId: 1, title: 'Native', color: 'blue' }; },
      async update(id, properties) { calls.push(['updateGroup', id, properties]); return { id, ...properties }; },
      async move(id, properties) { calls.push(['moveGroup', id, properties]); return { id, ...properties }; }
    },
    runtime: { id: 'firefox-codex-mcp@local.invalid', getBrowserInfo: async () => ({ name: 'Firefox', version: '139.0' }), getURL: path => `moz-extension://test/${path}`, onMessage: event() }
  };
  return browser;
}

test('pre-existing creation is unknown; observed creation and sessions survive a restart without ID-keyed storage', async () => {
  let now = Date.parse('2026-09-30T10:00:00Z');
  const browser = mockBrowser([{ id: 1, lastAccessed: now - 5000 }]);
  const service = createService(browser, { now: () => now }); await service.ready;
  let result = await service.handle('list_tabs');
  assert.equal(result.tabs[0].createdAt, null);
  assert.equal(result.tabs[0].createdAtSource, 'unknown');
  assert.equal(result.tabs[0].lastActiveSource, 'firefox-lastAccessed');
  const created = await service.handle('create_tab', { url: 'https://example.org/' });
  assert.equal(created.createdAt, new Date(now).toISOString());
  assert.equal(created.createdAtSource, 'observed-onCreated');
  now += 1000; browser.tabs.onActivated.emit({ tabId: created.id }); await settle();
  assert.equal((await service.handle('get_tabs', { tabIds: [created.id] })).results[0].result.lastActiveSource, 'observed');
  service.tracker.stop();
  const restarted = createService(browser, { now: () => now + 100000 }); await restarted.ready;
  assert.equal((await restarted.handle('get_tabs', { tabIds: [created.id] })).results[0].result.createdAt, created.createdAt);
  await browser.tabs.remove(created.id);
  const reused = await browser.tabs.create({ url: 'https://fresh.test/' }); await settle();
  assert.equal(reused.id, created.id);
  assert.notEqual((await restarted.handle('get_tabs', { tabIds: [reused.id] })).results[0].result.createdAt, created.createdAt);
});

test('discard source is unknown for Firefox/other add-ons; only this extension is attributed', async () => {
  const browser = mockBrowser([{ id: 1, discarded: true }, { id: 2 }, { id: 3, active: true }]);
  const service = createService(browser); await service.ready;
  assert.equal((await service.handle('list_tabs')).tabs[0].discardSource, 'unknown');
  const result = await service.handle('discard_tabs', { tabIds: [1, 2, 3] });
  assert.equal(result.results[0].result.discardSource, 'unknown');
  assert.equal(result.results[1].result.discardSource, 'this-extension');
  assert.equal(result.results[2].error.code, 'ACTIVE_TAB');
  assert.equal(result.partialFailure, true);
  await service.handle('reload_tabs', { tabIds: [2] }); await settle();
  assert.equal((await service.handle('get_tabs', { tabIds: [2] })).results[0].result.discardSource, null);
  browser.tabMap.get(2).discarded = true;
  browser.tabs.onUpdated.emit(2, { discarded: true }, clone(browser.tabMap.get(2))); await settle();
  assert.equal((await service.handle('get_tabs', { tabIds: [2] })).results[0].result.discardSource, 'unknown');
});

test('all IDs and mutation fields are validated before side effects; failures are per tab', async () => {
  const browser = mockBrowser([{ id: 1 }]), service = createService(browser); await service.ready;
  await assert.rejects(service.handle('close_tabs', { tabIds: [1, -5] }), { code: 'INVALID_PARAMS' });
  await assert.rejects(service.handle('create_tab', { url: 'javascript:alert(1)' }), { code: 'INVALID_PARAMS' });
  await assert.rejects(service.handle('update_tab', { tabId: 1, arbitraryScript: 'x' }), { code: 'INVALID_PARAMS' });
  assert.equal(browser.calls.length, 0);
  const result = await service.handle('set_muted', { tabIds: [1, 999], muted: true });
  assert.equal(result.results[0].result.mutedInfo.muted, true);
  assert.equal(result.results[1].error.code, 'FIREFOX_ERROR');
  assert.equal(result.partialFailure, true);
  assert.throws(() => validate('create_window', { url: ['https://ok.test/'], tabId: 1 }), { code: 'INVALID_PARAMS' });
});

test('native grouping creates and updates real Firefox tab groups and keeps native batch moves', async () => {
  const browser = mockBrowser([{ id: 1 }, { id: 2 }]), service = createService(browser); await service.ready;
  const result = await service.handle('group_tabs', { tabIds: [1, 2], windowId: 1, title: 'Work', color: 'cyan', collapsed: true });
  assert.equal(result.groupId, 42);
  assert.deepEqual(browser.calls.find(call => call[0] === 'group')[1], { tabIds: [1, 2], createProperties: { windowId: 1 } });
  assert.deepEqual(browser.calls.find(call => call[0] === 'updateGroup')[2], { title: 'Work', color: 'cyan', collapsed: true });
  await service.handle('move_tabs', { tabIds: [1, 2], windowId: 2, index: -1 });
  assert.deepEqual(browser.calls.find(call => call[0] === 'move'), ['move', [1, 2], { windowId: 2, index: -1 }]);
  await service.handle('ungroup_tabs', { tabIds: [1, 2] });
  assert.equal(browser.tabMap.get(1).groupId, -1);
});

test('group metadata failure reports applied group and partialFailure', async () => {
  const browser = mockBrowser([{ id: 1 }]);
  browser.tabGroups.update = async () => { throw new Error('update failed'); };
  const service = createService(browser); await service.ready;
  const result = await service.handle('group_tabs', { tabIds: [1], title: 'Work' });
  assert.equal(result.groupId, 42); assert.equal(result.partialFailure, true);
  assert.equal(result.results[0].result.groupId, 42); assert.equal(result.groupUpdateError.code, 'FIREFOX_ERROR');
});

test('get_current excludes permission popup windows and reports last focused semantics', async () => {
  const browser = mockBrowser([{ id: 1, active: true }, { id: 2 }]), service = createService(browser);
  const current = await service.handle('get_current');
  assert.equal(current.tab.id, 1); assert.equal(current.firefoxFocused, false);
  assert.deepEqual(browser.calls.find(call => call[0] === 'getLastFocused')[1].windowTypes, ['normal']);
});

test('content is bounded, main-frame-only, and never wakes discarded or privileged tabs', async () => {
  const browser = mockBrowser([{ id: 1 }, { id: 2, discarded: true }, { id: 3, url: 'about:config' }]), service = createService(browser);
  const result = await service.handle('read_content', { tabId: 1, maxChars: 7, includeLinks: true });
  assert.equal(result.content, 'Visible'); assert.equal(result.truncated, true); assert.equal(result.untrustedContent, true);
  const options = browser.calls.find(call => call[0] === 'executeScript')[2];
  assert.equal(options.frameId, 0); assert.equal(options.allFrames, false);
  await assert.rejects(service.handle('read_content', { tabId: 2 }), { code: 'TAB_DISCARDED' });
  await assert.rejects(service.handle('read_content', { tabId: 3 }), { code: 'RESTRICTED_PAGE' });
  await assert.rejects(service.handle('read_content', { tabId: 1, selector: '[' }), { code: 'INVALID_SELECTOR' });
  await assert.rejects(service.handle('read_content', { tabId: 1, selector: '#missing' }), { code: 'SELECTOR_NOT_FOUND' });
  assert.equal(browser.calls.some(call => call[0] === 'reload'), false);
});

test('packet cap uses explicit truncation and correct nextOffset without losing batch results', () => {
  const tabs = Array.from({ length: 500 }, (_, id) => ({ id, title: '中'.repeat(5000) }));
  const output = boundResponse({ tabs, total: 500, offset: 0, limit: 500 });
  assert.ok(Buffer.byteLength(JSON.stringify(output)) < 800000);
  assert.equal(output.nextOffset, output.tabs.length); assert.equal(output.truncated, true);
  const batched = boundResponse({ results: Array.from({ length: 100 }, (_, tabId) => ({ tabId, result: { title: '中'.repeat(20000) } })), partialFailure: false });
  assert.equal(batched.results.length, 100); assert.equal(batched.stringsTruncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(batched)) < 800000);
});

test('content defaults active-only and asks once per fixed twelve-hour session, never sliding', async () => {
  let now = 100000, prompts = 0;
  const browser = mockBrowser([{ id: 1, active: true }, { id: 2 }]);
  const policy = new ContentAccess(browser, { now: () => now, requestApproval: async () => { prompts++; return true; } });
  await assert.rejects(policy.authorize(await browser.tabs.get(2)), { code: 'CONTENT_SCOPE' });
  await policy.authorize(await browser.tabs.get(1));
  const expiry = now + SESSION_MS; assert.equal(policy.expiresAt, expiry);
  now += 60000; await policy.authorize(await browser.tabs.get(1));
  assert.equal(prompts, 1); assert.equal(policy.expiresAt, expiry);
  now = expiry; await policy.authorize(await browser.tabs.get(1));
  assert.equal(prompts, 2);
  const restarted = new ContentAccess(browser); assert.equal(restarted.expiresAt, null);
});

test('deny, allow, every-time, disabled mode and setting changes apply without cached permission bypass', async () => {
  let prompts = 0;
  const browser = mockBrowser([{ id: 1, active: true }, { id: 2 }]);
  const policy = new ContentAccess(browser, { requestApproval: async () => { prompts++; return true; } });
  await policy.authorize(await browser.tabs.get(1));
  policy.setSettings({ enabled: true, contentMode: 'deny', contentScope: 'all' });
  assert.equal(policy.expiresAt, null);
  await assert.rejects(policy.authorize(await browser.tabs.get(2)), { code: 'CONTENT_DENIED' });
  policy.setSettings({ enabled: true, contentMode: 'allow', contentScope: 'all' });
  await policy.authorize(await browser.tabs.get(2)); assert.equal(prompts, 1);
  policy.setSettings({ enabled: true, contentMode: 'ask-every-time', contentScope: 'all' });
  await policy.authorize(await browser.tabs.get(1)); await policy.authorize(await browser.tabs.get(1));
  assert.equal(prompts, 3);
  policy.setSettings({ enabled: false, contentMode: 'allow', contentScope: 'all' });
  await assert.rejects(policy.authorize(await browser.tabs.get(2)), { code: 'MCP_DISABLED' });
});

test('navigation, tab activation and policy changes during approval reject content', async () => {
  for (const change of ['url', 'active', 'settings']) {
    const browser = mockBrowser([{ id: 1, active: true }]);
    const policy = new ContentAccess(browser, { requestApproval: async () => {
      if (change === 'url') browser.tabMap.get(1).url = 'https://different.test/';
      if (change === 'active') browser.tabMap.get(1).active = false;
      if (change === 'settings') policy.setSettings({ enabled: true, contentMode: 'allow', contentScope: 'all' });
      return true;
    } });
    await assert.rejects(policy.authorize(await browser.tabs.get(1)), { code: { url: 'PAGE_CHANGED', active: 'CONTENT_SCOPE', settings: 'PERMISSION_CHANGED' }[change] });
    assert.equal(policy.expiresAt, null);
  }
});

test('denied and overlapping prompts do not grant a session', async () => {
  let resolve;
  const browser = mockBrowser([{ id: 1, active: true }]);
  const policy = new ContentAccess(browser, { requestApproval: () => new Promise(res => { resolve = res; }) });
  const first = policy.authorize(await browser.tabs.get(1)); await settle();
  await assert.rejects(policy.authorize(await browser.tabs.get(1)), { code: 'APPROVAL_BUSY' });
  resolve(false); await assert.rejects(first, { code: 'CONTENT_DENIED' }); assert.equal(policy.expiresAt, null);
});

test('final content guard rejects navigation or changed scope while executeScript waits', async () => {
  for (const change of ['url', 'active']) {
    const browser = mockBrowser([{ id: 1, active: true }]);
    const policy = new ContentAccess(browser, { settings: { enabled: true, contentMode: 'allow', contentScope: 'active' } });
    const execute = browser.tabs.executeScript;
    browser.tabs.executeScript = async function (id, options) {
      const result = await execute.call(this, id, options);
      browser.tabMap.get(id)[change] = change === 'url' ? 'https://different.test/' : false;
      return result;
    };
    const service = createService(browser, { contentAccess: policy });
    await assert.rejects(service.handle('read_content', { tabId: 1 }), { code: change === 'url' ? 'PAGE_CHANGED' : 'CONTENT_SCOPE' });
  }
});

test('expired request is checked after approval and does not inject content script', async () => {
  const browser = mockBrowser([{ id: 1, active: true }]);
  let expired = false;
  const policy = new ContentAccess(browser, { requestApproval: async () => { expired = true; return true; } });
  const service = createService(browser, { contentAccess: policy });
  await assert.rejects(service.handle('read_content', { tabId: 1 }, { assertLive() { if (expired) throw Object.assign(new Error('expired'), { code: 'REQUEST_EXPIRED' }); } }), { code: 'REQUEST_EXPIRED' });
  assert.equal(browser.calls.some(call => call[0] === 'executeScript'), false);
});

test('toolbar color thresholds include exactly one minute and thirty minutes; disabled/disconnected are gray', () => {
  const base = { enabled: true, connected: true, lastAccessAt: 1000 };
  assert.equal(iconStatus(base, 61000).color, 'blue');
  assert.equal(iconStatus(base, 61001).color, 'amber');
  assert.equal(iconStatus(base, 1801000).color, 'amber');
  assert.equal(iconStatus(base, 1801001).color, 'green');
  assert.equal(iconStatus({ ...base, lastAccessAt: null }).color, 'green');
  assert.equal(iconStatus({ ...base, connected: false }).color, 'gray');
  assert.equal(iconStatus({ ...base, enabled: false }).label, 'MCP deaktiviert');
});

test('native group IDs above 32-bit integers are accepted without rounding', () => {
  const groupId = 4200000000;
  for (const [method, params] of [['list_tabs', { groupId }], ['update_group', { groupId, title: 'Large ID' }], ['group_tabs', { groupId, tabIds: [1] }], ['move_group', { groupId, index: -1 }]]) assert.doesNotThrow(() => validate(method, params));
  assert.throws(() => validate('update_group', { groupId: Number.MAX_SAFE_INTEGER + 1, title: 'Invalid' }), { code: 'INVALID_PARAMS' });
});

test('permission popup focus is ignored even when Firefox ignores windowTypes filtering', async () => {
  const browser = mockBrowser([{ id: 1, active: true }]);
  const policy = new ContentAccess(browser, { requestApproval: async () => {
    browser.windows.getLastFocused = async () => ({ id: 99, type: 'popup', tabs: [{ id: 99, active: true, url: 'moz-extension://test/prompt.html' }] });
    return true;
  } });
  await policy.authorize(await browser.tabs.get(1));
  assert.equal((await policy.getCurrentWindow()).id, 1);
  const service = createService(browser, { contentAccess: policy });
  assert.equal((await service.handle('get_current')).tab.id, 1);
});

test('batch cancellation does not perform later mutations after a completed first item', async () => {
  const browser = mockBrowser([{ id: 1 }, { id: 2 }]), service = createService(browser);
  const remove = browser.tabs.remove; let cancelled = false;
  browser.tabs.remove = async function (id) { await remove.call(this, id); cancelled = true; };
  const result = await service.handle('close_tabs', { tabIds: [1, 2] }, { assertLive() { if (cancelled) throw Object.assign(new Error('disabled'), { code: 'MCP_DISABLED' }); } });
  assert.equal(result.results[0].result.closed, true);
  assert.equal(result.results[1].error.code, 'MCP_DISABLED');
  assert.equal(browser.tabMap.has(2), true);
});

test('a session that expires during script execution cannot release content', async () => {
  let now = 1000;
  const browser = mockBrowser([{ id: 1, active: true }]);
  const policy = new ContentAccess(browser, { now: () => now, requestApproval: async () => true });
  const execute = browser.tabs.executeScript;
  browser.tabs.executeScript = async function (id, options) { const result = await execute.call(this, id, options); now += SESSION_MS; return result; };
  const service = createService(browser, { contentAccess: policy });
  await assert.rejects(service.handle('read_content', { tabId: 1 }), { code: 'SESSION_EXPIRED' });
});

test('technical browser information needs the optional Firefox data consent', async () => {
  const browser = mockBrowser();
  browser.permissions = { getAll: async () => ({ data_collection: ['browsingActivity', 'websiteContent'] }) };
  const service = createService(browser);
  assert.equal((await service.handle('status')).browser, undefined);
  browser.permissions.getAll = async () => ({ data_collection: ['technicalAndInteraction'] });
  assert.equal((await service.handle('status')).browser.name, 'Firefox');
});

test('background sends ready, popup polling does not count as access, disabled MCP disconnects and rejects requests', async () => {
  const browser = mockBrowser([{ id: 1, active: true }]);
  const posted = [], timers = new Map(); let seq = 0, disconnected = false;
  const port = { onMessage: event(), onDisconnect: event(), postMessage: message => posted.push(message), disconnect() { disconnected = true; this.onDisconnect.emit(); } };
  browser.runtime.connectNative = name => { assert.equal(name, 'de.codex.firefox_bridge'); return port; };
  browser.storage = { local: { get: async () => ({}), set: async () => {} } };
  browser.browserAction = { setBadgeText: async () => {}, setIcon: async () => {}, setTitle: async () => {} };
  const context = vm.createContext({ browser, FirefoxBridgeCore: globalThis.FirefoxBridgeCore, FirefoxBridgePolicy: globalThis.FirefoxBridgePolicy, crypto: webcrypto, setTimeout: fn => { const id = ++seq; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id), setInterval: () => 1 });
  vm.runInContext(await readFile(new URL('../extension/background.js', import.meta.url), 'utf8'), context);
  await settle(); assert.equal(posted[0].type, 'ready');
  port.onMessage.emit({ type: 'connected' });
  const sender = { id: browser.runtime.id, url: browser.runtime.getURL('popup.html') };
  let state = await browser.runtime.onMessage.emit({ type: 'bridge_status' }, sender)[0];
  assert.equal(state.lastAccessAt, null); assert.equal(state.icon.color, 'green');
  port.onMessage.emit({ id: 'r1', method: 'status', params: {}, expiresAt: Date.now() + 30000 }); await settle();
  state = await browser.runtime.onMessage.emit({ type: 'bridge_status' }, sender)[0]; assert.equal(state.icon.color, 'blue');
  await browser.runtime.onMessage.emit({ type: 'bridge_settings', settings: { enabled: false, contentMode: 'allow', contentScope: 'all' } }, sender)[0];
  assert.equal(disconnected, true);
  const before = browser.tabMap.size;
  port.onMessage.emit({ id: 'r2', method: 'create_tab', params: { url: 'https://should-not-open.test/' } }); await settle();
  assert.equal(browser.tabMap.size, before);
  state = await browser.runtime.onMessage.emit({ type: 'bridge_status' }, sender)[0]; assert.equal(state.icon.color, 'gray');
});
