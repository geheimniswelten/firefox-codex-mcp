import test from 'node:test';
import assert from 'node:assert/strict';
import '../extension/policy.js';

const { ContentAccess, FIVE_DAYS_MS, normalizeSettings } = globalThis.FirefoxBridgePolicy;
const settings = { enabled: true, contentMode: 'ask-five-days', contentScope: 'active' };
const STORE = 'bridgeFiveDayApprovals';
const clone = value => structuredClone(value);
const tick = () => new Promise(resolve => setImmediate(resolve));
function event() {
  const listeners = new Set();
  return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn), emit: (...args) => { for (const fn of listeners) fn(...args); } };
}
function mock({ state = {}, values = new Map(), initial = [{ id: 1, active: true }, { id: 2, active: false }] } = {}) {
  const tabs = new Map(initial.map(tab => [tab.id, { url: 'https://example.org/', discarded: false, windowId: 1, title: 'Fixture', ...tab }]));
  const writes = [];
  const browser = {
    state, values, tabsMap: tabs, writes,
    storage: { local: { get: async key => ({ [key]: clone(state[key]) }), set: async value => { writes.push(clone(value)); Object.assign(state, clone(value)); } } },
    sessions: { getTabValue: async id => values.get(id), setTabValue: async (id, key, value) => { assert.match(key, /ContentApproval/); values.set(id, value); } },
    tabs: {
      onUpdated: event(), onRemoved: event(), onCreated: event(),
      get: async id => { if (!tabs.has(id)) throw new Error('Tab closed'); return clone(tabs.get(id)); },
      query: async () => [...tabs.values()].map(clone)
    },
    windows: {
      onFocusChanged: event(),
      getLastFocused: async () => ({ id: 1, type: 'normal', tabs: [...tabs.values()].map(clone) }),
      get: async () => ({ id: 1, type: 'normal', tabs: [...tabs.values()].map(clone) }),
      getAll: async () => [{ id: 1, type: 'normal', tabs: [...tabs.values()].map(clone) }]
    }
  };
  return browser;
}
async function grant(browser, tabId = 2, extra = {}) {
  let prompts = 0;
  const policy = new ContentAccess(browser, { now: () => 1000, settings, requestApproval: async () => { prompts++; return true; }, ...extra });
  const authorization = {};
  await policy.authorize(await browser.tabs.get(tabId), authorization);
  return { policy, authorization, prompts: () => prompts };
}

test('five days is opt-in, global grants persist fixed deadlines and old operations cannot inherit a renewed deadline', async () => {
  assert.equal(normalizeSettings().contentMode, 'ask-session');
  assert.equal(normalizeSettings(settings).contentMode, 'ask-five-days');
  assert.equal(FIVE_DAYS_MS, 120 * 60 * 60 * 1000);
  const browser = mock();
  delete browser.sessions; delete browser.tabs.query;
  let now = 1000, prompts = 0;
  const policy = new ContentAccess(browser, { now: () => now, settings, requestApproval: async () => { prompts++; return true; } });
  const old = {};
  await policy.authorize(await browser.tabs.get(1), old);
  assert.deepEqual(browser.state[STORE].global, { issuedAt: 1000, expiresAt: 1000 + FIVE_DAYS_MS });
  now += FIVE_DAYS_MS;
  await policy.authorize(await browser.tabs.get(1), {});
  assert.equal(prompts, 2);
  await assert.rejects(policy.assertAfterRead(1, 'https://example.org/', policy.revision, old), { code: 'SESSION_EXPIRED' });
});

test('an exact background-tab grant restores after numeric tab IDs change and does not authorize another tab at the same URL', async () => {
  const browser = mock();
  const { policy } = await grant(browser);
  assert.equal(policy.expiresAt, null);
  const record = browser.state[STORE].tabs[0];
  assert.deepEqual(Object.keys(record).sort(), ['expiresAt', 'issuedAt', 'token', 'url']);
  assert.match(record.token, /^[0-9a-f-]{36}$/);
  const restarted = mock({ state: browser.state, values: new Map([[22, record.token]]), initial: [{ id: 1, active: true }, { id: 22, active: false }, { id: 23, active: false }] });
  let prompts = 0;
  const restored = new ContentAccess(restarted, { now: () => 1000 + 48 * 60 * 60 * 1000, requestApproval: async () => { prompts++; return false; } });
  restored.setSettings(settings, { persist: false });
  assert.equal(restarted.writes.length, 0, 'startup hydration must not overwrite the saved grant');
  await restored.restoreApprovals();
  await restored.authorize(await restarted.tabs.get(22), {});
  assert.equal(prompts, 0);
  await assert.rejects(restored.authorize(await restarted.tabs.get(23), {}), { code: 'CONTENT_DENIED' });
  assert.equal(prompts, 1);
  assert.equal(restored.expiresAt, null);
});

test('ambiguous duplicated session UUIDs and duplicate persisted grant records fail closed on restore', async () => {
  for (const duplicateRecord of [false, true]) {
    const browser = mock(); await grant(browser);
    const token = browser.state[STORE].tabs[0].token;
    if (duplicateRecord) browser.state[STORE].tabs.push(clone(browser.state[STORE].tabs[0]));
    const restarted = mock({ state: browser.state, values: new Map(duplicateRecord ? [[2, token]] : [[2, token], [3, token]]), initial: [{ id: 1, active: true }, { id: 2, active: false }, { id: 3, active: false }] });
    const policy = new ContentAccess(restarted, { now: () => 1000, settings, requestApproval: async () => false });
    await policy.restoreApprovals();
    assert.equal(restarted.state[STORE].tabs.length, 0);
    await assert.rejects(policy.authorize(await restarted.tabs.get(2)), { code: 'CONTENT_DENIED' });
  }
});

test('navigation away and back, reload, discard and close/undo permanently revoke exact tab grants', async () => {
  for (const action of ['navigate', 'reload', 'discard', 'close']) {
    const browser = mock(); const { policy, authorization } = await grant(browser);
    const token = browser.values.get(2);
    if (action === 'navigate') {
      browser.tabsMap.get(2).url = 'https://other.org/'; browser.tabs.onUpdated.emit(2, { url: 'https://other.org/' });
      browser.tabsMap.get(2).url = 'https://example.org/'; browser.tabs.onUpdated.emit(2, { url: 'https://example.org/' });
    } else if (action === 'reload') browser.tabs.onUpdated.emit(2, { status: 'loading' });
    else if (action === 'discard') browser.tabs.onUpdated.emit(2, { discarded: true });
    else { browser.tabsMap.delete(2); browser.tabs.onRemoved.emit(2); browser.tabsMap.set(2, { id: 2, url: 'https://example.org/', active: false, discarded: false }); }
    await policy.flushApprovals();
    assert.equal(browser.state[STORE].tabs.length, 0, action);
    await assert.rejects(policy.assertAfterRead(2, 'https://example.org/', policy.revision, authorization), error => ['PAGE_CHANGED', 'CONTENT_DENIED'].includes(error.code));
    const restarted = mock({ state: browser.state, values: new Map([[2, token]]) });
    const restored = new ContentAccess(restarted, { now: () => 1000, settings, requestApproval: async () => false });
    await restored.restoreApprovals();
    await assert.rejects(restored.authorize(await restarted.tabs.get(2)), { code: 'CONTENT_DENIED' });
  }
});

test('reset, changed settings and cancellation serialize revocation after a pending save and never release its content', async () => {
  for (const action of ['reset', 'settings', 'abort', 'navigate']) {
    const browser = mock(); const controller = new AbortController();
    let release, started;
    const startedPromise = new Promise(resolve => { started = resolve; });
    const set = browser.storage.local.set;
    browser.storage.local.set = async value => {
      if (value[STORE].tabs.length) { started(); await new Promise(resolve => { release = resolve; }); }
      return set(value);
    };
    const policy = new ContentAccess(browser, { now: () => 1000, settings, requestApproval: async () => true });
    const pending = policy.authorize(await browser.tabs.get(2), {}, { signal: controller.signal });
    const rejected = assert.rejects(pending, error => ['PERMISSION_CHANGED', 'CANCELLED', 'PAGE_CHANGED'].includes(error.code));
    await startedPromise;
    if (action === 'reset') { const revision = policy.revision; policy.resetApprovals(); assert.equal(policy.revision, revision + 1); }
    else if (action === 'settings') policy.setSettings({ ...settings, contentScope: 'all' });
    else if (action === 'abort') controller.abort(Object.assign(new Error('cancelled'), { code: 'CANCELLED' }));
    else browser.tabs.onUpdated.emit(2, { status: 'loading' });
    release(); await rejected; await policy.flushApprovals();
    assert.equal(browser.state[STORE].tabs.length, 0, action);
    assert.equal(policy.tabGrants.size, 0);
  }
});

test('a new cloned tab revokes the original session UUID and retained authorization', async () => {
  const browser = mock(); const { policy, authorization } = await grant(browser);
  browser.tabsMap.set(3, { ...browser.tabsMap.get(2), id: 3 });
  browser.values.set(3, browser.values.get(2)); browser.tabs.onCreated.emit(await browser.tabs.get(3));
  await tick(); await policy.flushApprovals();
  assert.equal(browser.state[STORE].tabs.length, 0);
  await assert.rejects(policy.assertAfterRead(2, 'https://example.org/', policy.revision, authorization), { code: 'PAGE_CHANGED' });
});

test('storage write failure denies approval, revokes its RAM state, and is reported by flush', async () => {
  const browser = mock();
  const set = browser.storage.local.set;
  let fail = true;
  browser.storage.local.set = async value => { if (fail) { fail = false; throw new Error('disk failed'); } return set(value); };
  const policy = new ContentAccess(browser, { now: () => 1000, settings, requestApproval: async () => true });
  await assert.rejects(policy.authorize(await browser.tabs.get(2)), { code: 'APPROVAL_PERSISTENCE_FAILED' });
  assert.equal(policy.tabGrants.size, 0);
  await assert.rejects(policy.flushApprovals(), { code: 'APPROVAL_PERSISTENCE_FAILED' });
  assert.equal(browser.state[STORE].tabs.length, 0);
  browser.storage.local.set = async () => { throw new Error('disk remains unavailable'); };
  policy.resetApprovals();
  await assert.rejects(policy.flushApprovals(), { code: 'APPROVAL_PERSISTENCE_FAILED' });
  await assert.rejects(policy.authorize(await browser.tabs.get(1)), { code: 'APPROVAL_PERSISTENCE_FAILED' });
});

test('unknown versions, changed settings, future timestamps and expired grants are removed before restore can authorize', async () => {
  const browser = mock(); await grant(browser, 1);
  const original = clone(browser.state[STORE]);
  for (const change of [store => { store.version++; }, store => { store.settingsSignature = '{}'; }, store => { store.global.issuedAt = 2000; store.global.expiresAt = 2000 + FIVE_DAYS_MS; }, store => { store.global.issuedAt = 1000 - FIVE_DAYS_MS; store.global.expiresAt = 1000; }]) {
    const state = { [STORE]: clone(original) }; change(state[STORE]);
    const restarted = mock({ state });
    const policy = new ContentAccess(restarted, { now: () => 1000, settings, requestApproval: async () => false });
    await policy.restoreApprovals();
    assert.equal(policy.expiresAt, null);
    assert.equal(state[STORE].global, null);
    await assert.rejects(policy.authorize(await restarted.tabs.get(1)), { code: 'CONTENT_DENIED' });
  }
});

test('reset while a session UUID lookup is pending cannot save an old approval under the new epoch', async () => {
  const browser = mock();
  let release, started;
  const startedPromise = new Promise(resolve => { started = resolve; });
  const get = browser.sessions.getTabValue;
  browser.sessions.getTabValue = async (id, key) => {
    if (id === 2) { started(); await new Promise(resolve => { release = resolve; }); }
    return get(id, key);
  };
  const policy = new ContentAccess(browser, { now: () => 1000, settings, requestApproval: async () => true });
  const pending = policy.authorize(await browser.tabs.get(2));
  const rejected = assert.rejects(pending, { code: 'PERMISSION_CHANGED' });
  await startedPromise;
  policy.resetApprovals(); await policy.flushApprovals();
  const epoch = browser.state[STORE].epoch;
  release(); await rejected; await policy.flushApprovals();
  assert.equal(browser.state[STORE].epoch, epoch);
  assert.ok(browser.writes.every(write => write[STORE].tabs.length === 0), 'no stale grant may reach disk after reset');
});

test('restore skips individual tab failures while preserving the global five-day deadline', async () => {
  for (const failure of ['session', 'closed']) {
    const browser = mock();
    const { policy } = await grant(browser, 1);
    await policy.authorize(await browser.tabs.get(2));
    const restarted = mock({ state: browser.state, values: browser.values });
    if (failure === 'session') {
      const get = restarted.sessions.getTabValue;
      restarted.sessions.getTabValue = async (id, key) => { if (id === 2) throw new Error('session disappeared'); return get(id, key); };
    } else {
      const get = restarted.tabs.get;
      restarted.tabs.get = async id => { if (id === 2) throw new Error('tab closed while restoring'); return get(id); };
    }
    const restored = new ContentAccess(restarted, { now: () => 1000, settings, requestApproval: async () => false });
    await restored.restoreApprovals();
    assert.equal(restored.expiresAt, 1000 + FIVE_DAYS_MS);
    assert.equal(restarted.state[STORE].tabs.length, 0);
    await restored.authorize(await restarted.tabs.get(1));
  }
});

test('repeated content guards check only their target identity instead of scanning every browser tab', async () => {
  const browser = mock(); const { policy, authorization } = await grant(browser);
  browser.tabs.query = () => assert.fail('content guards must not query the entire inventory');
  const get = browser.sessions.getTabValue;
  let checks = 0;
  browser.sessions.getTabValue = async (id, key) => { assert.equal(id, 2); checks++; return get(id, key); };
  for (let i = 0; i < 3; i++) await policy.assertAfterRead(2, 'https://example.org/', policy.revision, authorization);
  assert.equal(checks, 3);
});

test('a scope change after a global save rolls the new approval back before returning content', async () => {
  const browser = mock();
  const set = browser.storage.local.set;
  browser.storage.local.set = async value => {
    await set(value);
    if (value[STORE].global) browser.tabsMap.get(1).active = false;
  };
  const policy = new ContentAccess(browser, { now: () => 1000, settings, requestApproval: async () => true });
  await assert.rejects(policy.authorize(await browser.tabs.get(1)), { code: 'CONTENT_SCOPE' });
  await policy.flushApprovals();
  assert.equal(policy.expiresAt, null);
  assert.equal(browser.state[STORE].global, null);
});

test('five-day deadlines begin when the user answers, before subsequent browser awaits', async () => {
  for (const tabId of [1, 2]) {
    const browser = mock(); const get = browser.tabs.get;
    let now = 1000, answered = false;
    browser.tabs.get = async id => {
      if (answered) { answered = false; now += 60 * 60 * 1000; }
      return get(id);
    };
    const policy = new ContentAccess(browser, { now: () => now, settings, requestApproval: async () => { answered = true; return true; } });
    await policy.authorize(await browser.tabs.get(tabId));
    const saved = tabId === 1 ? browser.state[STORE].global : browser.state[STORE].tabs[0];
    assert.equal(saved.issuedAt, 1000);
    assert.equal(saved.expiresAt, 1000 + FIVE_DAYS_MS);
  }
});
