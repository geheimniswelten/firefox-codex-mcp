import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const [backgroundSource, policySource, waitSource] = await Promise.all([
  readFile(new URL('../extension/background.js', import.meta.url), 'utf8'),
  readFile(new URL('../extension/policy.js', import.meta.url), 'utf8'),
  readFile(new URL('../extension/wait.js', import.meta.url), 'utf8'),
]);
const settle = async () => { for (let index = 0; index < 5; index++) await new Promise(resolve => setImmediate(resolve)); };
const clone = value => structuredClone(value);
let persistentUuidSequence = 0;
function event() {
  const listeners = new Set();
  return { addListener: callback => listeners.add(callback), removeListener: callback => listeners.delete(callback), emit: (...args) => [...listeners].map(callback => callback(...args)) };
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function mount({ mode = 'ask-every-time', scope = 'active', windowState = 'normal', openError = false, focusError = false, noReceiver = false, savedState = null, startTime = 10000, tabSessionValues = new Map() } = {}) {
  let now = startTime, timerSequence = 0, requestSequence = 0, uuidSequence = 0, policy, reads = 0;
  const storageData = savedState || { bridgeSettings: { enabled: true, contentMode: mode, contentScope: scope } };
  const timers = new Map(), posted = [], calls = [], notifications = [];
  const normalWindow = { id: 7, type: 'normal', state: windowState, focused: false, tabs: [
    { id: 42, windowId: 7, active: true, status: 'complete', url: 'https://example.test/page', title: 'Example title' },
    { id: 43, windowId: 7, active: false, status: 'complete', url: 'https://background.test/page', title: 'Background title' },
    { id: 44, windowId: 7, active: false, url: 'https://background.test/page', title: 'Other background tab' },
  ] };
  const otherWindow = { id: 12, type: 'normal', focused: false, tabs: [{ id: 60, windowId: 12, active: true, url: 'https://other.test/' }] };
  let currentWindow = normalWindow;
  const port = {
    onMessage: event(), onDisconnect: event(),
    postMessage: message => posted.push(clone(message)),
    disconnect() { this.onDisconnect.emit(); },
  };
  const browser = {
    runtime: {
      id: 'bridge@test', onMessage: event(),
      getURL: file => `moz-extension://bridge/${file}`,
      connectNative: () => port,
      sendMessage(message) { notifications.push(clone(message)); return noReceiver ? Promise.reject(new Error('No receiving end')) : Promise.resolve(); },
    },
    storage: { local: { get: async () => clone(storageData), set: async values => { Object.assign(storageData, clone(values)); } } },
    sessions: {
      getTabValue: async (id, key) => clone(tabSessionValues.get(`${id}:${key}`)),
      setTabValue: async (id, key, value) => { tabSessionValues.set(`${id}:${key}`, clone(value)); },
      removeTabValue: async (id, key) => { tabSessionValues.delete(`${id}:${key}`); },
    },
    browserAction: {
      setBadgeText: async value => { calls.push(['badge', clone(value)]); },
      setTitle: async value => { calls.push(['title', clone(value)]); },
      setIcon: async () => {},
      async openPopup(options) { calls.push(['openPopup', clone(options)]); if (openError) throw new Error('User gesture required'); },
    },
    windows: {
      onFocusChanged: event(), onRemoved: event(),
      getLastFocused: async () => clone(currentWindow),
      get: async id => { if (id !== 7 && id !== 12) throw new Error('Window missing'); return clone(id === 7 ? normalWindow : otherWindow); },
      getAll: async () => [clone(normalWindow), clone(otherWindow)],
      async update(id, properties) {
        calls.push(['focus', id, clone(properties)]);
        if (focusError) throw new Error('Cannot focus');
        assert.equal(id, 7);
        Object.assign(normalWindow, properties); currentWindow = normalWindow;
        this.onFocusChanged.emit(id);
        return clone(normalWindow);
      },
      create: () => assert.fail('Approval must never create a browser window.'),
      remove: () => assert.fail('Approval must never remove a browser window.'),
    },
    tabs: {
      onCreated: event(), onUpdated: event(), onRemoved: event(),
      query: async () => clone([...normalWindow.tabs, ...otherWindow.tabs]),
      get: async id => {
        const tab = [...normalWindow.tabs, ...otherWindow.tabs].find(candidate => candidate.id === id);
        if (!tab) throw new Error('Tab missing');
        return clone(tab);
      },
      update: () => assert.fail('Approval must never activate or change a tab.'),
      executeScript: async () => { reads++; return [{ conditions: { selector: false } }]; },
    },
  };
  // The real access policy performs before/after-approval scope checks. The
  // service stub records authorization only; no page content is read in tests.
  const core = {
    VERSION: 'test', validate() {}, errorData: error => ({ code: error.code || 'ERROR', message: error.message }),
    createService(_browser, options) {
      policy = options.contentAccess;
      return { ready: Promise.resolve(), async handle(method, params, context) {
        if (method === 'get_tabs') return { tabs: [await browser.tabs.get(params.tabIds[0])] };
        if (method === 'wait_for') return realm.FirefoxBridgeWait.waitFor(browser, params, { ...context, contentAccess: policy });
        assert.ok(['read_content', 'wait_for'].includes(method));
        context.assertLive();
        const tab = await browser.tabs.get(params.tabId), revision = policy.revision, authorization = {};
        await policy.authorize(tab, authorization, { signal: context.signal });
        context.assertLive();
        await policy.assertAfterRead(tab.id, tab.url, revision, authorization);
        reads++;
        return { authorized: true };
      } };
    },
  };
  class Clock extends Date { static now() { return now; } }
  const realm = vm.createContext({
    browser, FirefoxBridgeCore: core, Date: Clock, AbortController, URL,
    crypto: { randomUUID: () => storageData.bridgeSettings.contentMode === 'ask-five-days'
      ? `00000000-0000-4000-8000-${String(++persistentUuidSequence).padStart(12, '0')}`
      : `unique-approval-${++uuidSequence}` },
    setTimeout(callback, delay) { const id = ++timerSequence; timers.set(id, { callback, delay, expiresAt: now + delay }); return id; },
    clearTimeout: id => timers.delete(id), setInterval: () => 1,
  });
  vm.runInContext(policySource, realm);
  vm.runInContext(waitSource, realm);
  vm.runInContext(backgroundSource, realm);
  await settle();
  port.onMessage.emit({ type: 'connected' });
  const sender = { id: browser.runtime.id, url: browser.runtime.getURL('popup.html') };
  const message = async (value, from = sender) => clone(await browser.runtime.onMessage.emit(value, from)[0]);
  return {
    browser, port, policy, timers, posted, calls, notifications, sender, storageData, tabSessionValues,
    reads: () => reads,
    message,
    status: () => message({ type: 'bridge_status' }),
    async request(tabId = 42, method = 'read_content', extra = {}) {
      const id = `request-${++requestSequence}`;
      port.onMessage.emit({ id, method, params: { tabId, ...(method === 'wait_for' ? { selector: '#waiting' } : {}), ...extra }, expiresAt: now + 130000 });
      await settle();
      return id;
    },
    async advance(milliseconds, { runTimers = true } = {}) {
      now += milliseconds;
      if (runTimers) {
        for (const [id, timer] of [...timers]) if (timer.expiresAt <= now) { timers.delete(id); timer.callback(); }
      }
      await settle();
    },
    showNonNormalWindow() { currentWindow = { id: 99, type: 'popup', focused: true, tabs: [] }; },
    activeTab: () => normalWindow.tabs.find(tab => tab.active)?.id,
    navigate(tabId, url) {
      const tab = normalWindow.tabs.find(candidate => candidate.id === tabId);
      tab.url = url;
      browser.tabs.onUpdated.emit(tabId, { url }, clone(tab));
    },
  };
}

test('approval targets the last normal Firefox window, focuses it and opens only the toolbar popup', async () => {
  const bridge = await mount();
  bridge.showNonNormalWindow();
  await bridge.request();
  const pending = (await bridge.status()).pendingApproval;
  assert.deepEqual(pending, { id: 'unique-approval-1', tabId: 42, url: 'https://example.test/page', title: 'Example title', mode: 'ask-every-time', scope: 'active', expiresAt: 130000 });
  assert.deepEqual(bridge.calls.filter(call => ['focus', 'openPopup'].includes(call[0])), [['focus', 7, { focused: true }], ['openPopup', { windowId: 7 }]]);
  assert.equal(bridge.calls.filter(call => call[0] === 'badge').at(-1)[1].text, '?');
  assert.match(bridge.calls.filter(call => call[0] === 'title').at(-1)[1].title, /Freigabe|freigabe/);
  assert.equal(bridge.reads(), 0);
  assert.deepEqual(bridge.notifications, [{ type: 'bridge_status_changed' }]);
});

test('a minimized normal Firefox window is restored before opening its toolbar popup', async () => {
  const bridge = await mount({ windowState: 'minimized' });
  await bridge.request();
  assert.deepEqual(bridge.calls.filter(call => call[0] === 'focus'), [['focus', 7, { focused: true, state: 'normal' }]]);
  assert.deepEqual(bridge.calls.filter(call => call[0] === 'openPopup'), [['openPopup', { windowId: 7 }]]);
});

test('background content requests open individual approval without switching tabs, even in allow mode', async () => {
  for (const mode of ['ask-every-time', 'allow']) {
    const bridge = await mount({ mode });
    const requestId = await bridge.request(43);
    const pending = (await bridge.status()).pendingApproval;
    assert.deepEqual(pending, { id: 'unique-approval-1', tabId: 43, url: 'https://background.test/page', title: 'Background title', mode: 'ask-every-time', scope: 'tab', expiresAt: 130000 });
    assert.equal(bridge.activeTab(), 42);
    assert.equal(bridge.reads(), 0);
    assert.deepEqual(bridge.calls.filter(call => call[0] === 'openPopup'), [['openPopup', { windowId: 7 }]]);
    assert.deepEqual(await bridge.message({ type: 'approval_answer', id: pending.id, allowed: true }), { ok: true });
    await settle();
    assert.deepEqual(bridge.posted.find(message => message.id === requestId).result, { authorized: true });
    assert.equal((await bridge.status()).sessionExpiresAt, null);
    await bridge.request(43);
    const next = (await bridge.status()).pendingApproval;
    assert.ok(next);
    assert.notEqual(next.id, pending.id);
    assert.equal(next.scope, 'tab');
    assert.equal(bridge.activeTab(), 42);
  }
});

test('an active tab in another window requests individual approval in the current toolbar', async () => {
  const bridge = await mount();
  await bridge.request(60);
  const pending = (await bridge.status()).pendingApproval;
  assert.equal(pending.tabId, 60);
  assert.equal(pending.url, 'https://other.test/');
  assert.equal(pending.scope, 'tab');
  assert.deepEqual(bridge.calls.filter(call => call[0] === 'openPopup'), [['openPopup', { windowId: 7 }]]);
  assert.equal(bridge.activeTab(), 42);
});

test('deny mode blocks background content without creating an approval', async () => {
  const bridge = await mount({ mode: 'deny' });
  const requestId = await bridge.request(43);
  assert.equal((await bridge.status()).pendingApproval, null);
  assert.equal(bridge.posted.find(message => message.id === requestId).error.code, 'CONTENT_DENIED');
  assert.equal(bridge.calls.some(call => call[0] === 'openPopup'), false);
  assert.equal(bridge.reads(), 0);
});

test('individual session grants stay separate from active sessions and exact tab/URL identity', async () => {
  const bridge = await mount({ mode: 'ask-session' });
  await bridge.request(43);
  const background = (await bridge.status()).pendingApproval;
  assert.equal(background.scope, 'tab');
  assert.equal(background.mode, 'ask-session');
  await bridge.message({ type: 'approval_answer', id: background.id, allowed: true }); await settle();
  assert.equal((await bridge.status()).sessionExpiresAt, null, 'a tab grant must not create an active-tab session');
  await bridge.request(42);
  const active = (await bridge.status()).pendingApproval;
  assert.equal(active.scope, 'active');
  await bridge.message({ type: 'approval_answer', id: active.id, allowed: true }); await settle();
  const activeExpiry = (await bridge.status()).sessionExpiresAt;
  assert.ok(activeExpiry);
  const cachedRead = await bridge.request(43);
  assert.equal((await bridge.status()).pendingApproval, null);
  assert.deepEqual(bridge.posted.find(message => message.id === cachedRead).result, { authorized: true });
  await bridge.request(44);
  const sameUrlOtherTab = (await bridge.status()).pendingApproval;
  assert.equal(sameUrlOtherTab.tabId, 44, 'an active session and another tab grant must not authorize a different tab with the same URL');
  assert.equal(sameUrlOtherTab.scope, 'tab');
  await bridge.message({ type: 'approval_answer', id: sameUrlOtherTab.id, allowed: false }); await settle();
  bridge.navigate(43, 'https://background.test/new-page');
  await bridge.request(43);
  const newUrl = (await bridge.status()).pendingApproval;
  assert.equal(newUrl.url, 'https://background.test/new-page');
  assert.equal(newUrl.scope, 'tab');
  assert.equal((await bridge.status()).sessionExpiresAt, activeExpiry);
  assert.equal(bridge.activeTab(), 42);
});

test('individual tab sessions expire at their fixed deadline despite repeated reads', async () => {
  const bridge = await mount({ mode: 'ask-session' });
  await bridge.request(43);
  const pending = (await bridge.status()).pendingApproval;
  await bridge.message({ type: 'approval_answer', id: pending.id, allowed: true }); await settle();
  await bridge.advance(60000);
  await bridge.request(43);
  assert.equal((await bridge.status()).pendingApproval, null);
  await bridge.advance(12 * 60 * 60 * 1000 - 60000);
  await bridge.request(43);
  assert.equal((await bridge.status()).pendingApproval.scope, 'tab');
  assert.equal(bridge.calls.filter(call => call[0] === 'openPopup').length, 2);
  assert.equal(bridge.reads(), 2);
});

test('resetting temporary approvals revokes active and individual tab sessions without changing settings', async () => {
  const bridge = await mount({ mode: 'ask-session' });
  for (const tabId of [42, 43]) {
    await bridge.request(tabId);
    const pending = (await bridge.status()).pendingApproval;
    await bridge.message({ type: 'approval_answer', id: pending.id, allowed: true }); await settle();
  }
  const before = await bridge.status();
  assert.ok(before.sessionExpiresAt);
  const reset = await bridge.message({ type: 'bridge_reset_approvals' });
  assert.equal(reset.sessionExpiresAt, null);
  assert.equal(reset.pendingApproval, null);
  assert.deepEqual(reset.settings, before.settings);
  for (const tabId of [43, 42]) {
    await bridge.request(tabId);
    const pending = (await bridge.status()).pendingApproval;
    assert.ok(pending, 'each previously granted scope must ask again');
    assert.equal(pending.scope, tabId === 43 ? 'tab' : 'active');
    await bridge.message({ type: 'approval_answer', id: pending.id, allowed: false }); await settle();
  }
  assert.equal(bridge.reads(), 2);
});

test('resetting while approval is pending denies it and rejects a late answer', async () => {
  const bridge = await mount({ mode: 'ask-session' });
  const requestId = await bridge.request(43);
  const pending = (await bridge.status()).pendingApproval;
  const reset = await bridge.message({ type: 'bridge_reset_approvals' }); await settle();
  assert.equal(reset.pendingApproval, null);
  assert.equal(bridge.posted.find(message => message.id === requestId).error.code, 'CONTENT_DENIED');
  assert.deepEqual(await bridge.message({ type: 'approval_answer', id: pending.id, allowed: true }), { ok: false });
  assert.equal(bridge.calls.filter(call => call[0] === 'badge').at(-1)[1].text, '');
  assert.equal(bridge.reads(), 0);
});

test('gesture-required openPopup failure remains pending and can be answered manually', async () => {
  const bridge = await mount({ openError: true, noReceiver: true });
  const requestId = await bridge.request();
  const pending = (await bridge.status()).pendingApproval;
  assert.ok(pending);
  assert.deepEqual(await bridge.message({ type: 'approval_answer', id: pending.id, allowed: true }), { ok: true });
  assert.equal(bridge.calls.filter(call => call[0] === 'badge').at(-1)[1].text, '');
  await settle();
  assert.equal((await bridge.status()).pendingApproval, null);
  assert.equal(bridge.reads(), 1);
  assert.deepEqual(bridge.posted.find(message => message.id === requestId).result, { authorized: true });
  assert.equal(bridge.notifications.length, 2);
});

test('window lookup and focus errors leave a manually answerable request', async () => {
  for (const failure of ['lookup', 'focus']) {
    const bridge = await mount({ scope: 'all', focusError: failure === 'focus' });
    if (failure === 'lookup') bridge.policy.getCurrentWindow = async () => { throw new Error('No normal window'); };
    await bridge.request();
    const pending = (await bridge.status()).pendingApproval;
    assert.ok(pending, failure);
    assert.deepEqual(await bridge.message({ type: 'approval_answer', id: pending.id, allowed: true }), { ok: true });
    await settle();
    assert.equal(bridge.reads(), 1);
  }
});

test('closing and reopening the popup does not cancel or extend its fixed deadline', async () => {
  const bridge = await mount();
  await bridge.request();
  const pending = (await bridge.status()).pendingApproval;
  // A popup document closing has no cancellation message; unrelated window
  // closure likewise must not resolve an approval.
  bridge.browser.windows.onRemoved.emit(999);
  await bridge.advance(60000);
  assert.deepEqual((await bridge.status()).pendingApproval, pending);
  assert.equal(bridge.timers.size, 1);
  assert.equal(bridge.reads(), 0);
});

test('timeout denies access and clears the badge; an expired answer cannot grant it', async () => {
  const bridge = await mount();
  const requestId = await bridge.request();
  const pending = (await bridge.status()).pendingApproval;
  await bridge.advance(120000);
  assert.equal((await bridge.status()).pendingApproval, null);
  assert.equal(bridge.calls.filter(call => call[0] === 'badge').at(-1)[1].text, '');
  assert.equal(bridge.posted.find(message => message.id === requestId).error.code, 'CONTENT_DENIED');
  assert.deepEqual(await bridge.message({ type: 'approval_answer', id: pending.id, allowed: true }), { ok: false });
  assert.equal(bridge.reads(), 0);
});

test('wall-clock expiry rejects an answer even before the timeout callback runs', async () => {
  const bridge = await mount();
  await bridge.request();
  const pending = (await bridge.status()).pendingApproval;
  await bridge.advance(120000, { runTimers: false });
  assert.deepEqual(await bridge.message({ type: 'approval_answer', id: pending.id, allowed: true }), { ok: false });
  await settle();
  assert.equal(bridge.reads(), 0);
  assert.equal((await bridge.status()).pendingApproval, null);
});

test('only the exact extension popup sender and current random ID can answer; duplicate answers are rejected', async () => {
  const bridge = await mount();
  await bridge.request();
  const pending = (await bridge.status()).pendingApproval;
  for (const sender of [
    { ...bridge.sender, id: 'foreign-extension@test' },
    { ...bridge.sender, url: 'https://example.test/popup.html' },
    { ...bridge.sender, url: 'moz-extension://bridge/prompt.html' },
    { ...bridge.sender, url: 'moz-extension://bridge/popup.html?forged=true' },
  ]) {
    assert.equal(await bridge.message({ type: 'approval_answer', id: pending.id, allowed: true }, sender), undefined);
  }
  for (const message of [{ id: 'stale', allowed: true }, { allowed: true }, { id: pending.id, allowed: 'true' }]) {
    assert.deepEqual(await bridge.message({ type: 'approval_answer', ...message }), { ok: false });
  }
  assert.equal((await bridge.status()).pendingApproval.id, pending.id);
  assert.equal(bridge.reads(), 0);
  const first = bridge.message({ type: 'approval_answer', id: pending.id, allowed: true });
  const duplicate = bridge.message({ type: 'approval_answer', id: pending.id, allowed: true });
  assert.deepEqual(await first, { ok: true });
  assert.deepEqual(await duplicate, { ok: false });
  await settle();
  assert.equal(bridge.reads(), 1);
});

test('a stale timer and stale answer cannot finish a newer approval', async () => {
  const bridge = await mount();
  await bridge.request();
  const first = (await bridge.status()).pendingApproval;
  const staleTimer = [...bridge.timers.values()].find(timer => timer.delay === 120000).callback;
  assert.deepEqual(await bridge.message({ type: 'approval_answer', id: first.id, allowed: false }), { ok: true });
  await settle();
  await bridge.request();
  const second = (await bridge.status()).pendingApproval;
  assert.notEqual(first.id, second.id);
  staleTimer();
  assert.deepEqual(await bridge.message({ type: 'approval_answer', id: first.id, allowed: true }), { ok: false });
  assert.deepEqual((await bridge.status()).pendingApproval, second);
  assert.equal(bridge.reads(), 0);
});

test('disconnect and changed access policy cancel pending approval immediately', async () => {
  for (const reason of ['disconnect', 'settings']) {
    const bridge = await mount();
    await bridge.request();
    const pending = (await bridge.status()).pendingApproval;
    let storage;
    if (reason === 'disconnect') bridge.port.onDisconnect.emit();
    else {
      storage = deferred();
      bridge.browser.storage.local.set = () => storage.promise;
      void bridge.message({ type: 'bridge_settings', settings: { enabled: true, contentMode: 'deny', contentScope: 'active' } });
      await settle();
    }
    assert.equal((await bridge.status()).pendingApproval, null);
    assert.deepEqual(await bridge.message({ type: 'approval_answer', id: pending.id, allowed: true }), { ok: false });
    assert.equal(bridge.calls.filter(call => call[0] === 'badge').at(-1)[1].text, '');
    storage?.resolve();
    await settle();
    assert.equal(bridge.reads(), 0);
  }
});

test('answering during asynchronous focus suppresses a late popup', async () => {
  const bridge = await mount();
  const focus = deferred();
  bridge.browser.windows.update = async (...args) => { bridge.calls.push(['focus-pending', ...clone(args)]); await focus.promise; };
  await bridge.request();
  const pending = (await bridge.status()).pendingApproval;
  assert.deepEqual(await bridge.message({ type: 'approval_answer', id: pending.id, allowed: true }), { ok: true });
  focus.resolve();
  await settle();
  assert.equal(bridge.calls.some(call => call[0] === 'openPopup'), false);
  assert.equal(bridge.reads(), 1);
});

test('concurrent content requests keep the first approval and reject the second', async () => {
  const bridge = await mount();
  await bridge.request();
  const first = (await bridge.status()).pendingApproval;
  const secondRequest = await bridge.request();
  assert.deepEqual((await bridge.status()).pendingApproval, first);
  assert.equal(bridge.posted.find(message => message.id === secondRequest).error.code, 'APPROVAL_BUSY');
  assert.equal(bridge.calls.filter(call => call[0] === 'openPopup').length, 1);
  assert.deepEqual(await bridge.message({ type: 'approval_answer', id: first.id, allowed: true }), { ok: true });
  await settle();
  assert.equal(bridge.reads(), 1);
});

test('five-day approval is persisted before reading and restored before native requests after restart', async () => {
  const duration = 5 * 24 * 60 * 60 * 1000;
  const bridge = await mount({ mode: 'ask-five-days' });
  assert.equal((await bridge.status()).fiveDayExpiresAt, null);
  const first = await bridge.request();
  const pending = (await bridge.status()).pendingApproval;
  assert.equal(pending.mode, 'ask-five-days');
  await bridge.message({ type: 'approval_answer', id: pending.id, allowed: true }); await settle();
  assert.equal(bridge.posted.find(message => message.id === first)?.result?.authorized, true);
  const expiresAt = 10000 + duration;
  assert.equal((await bridge.status()).fiveDayExpiresAt, expiresAt);
  assert.equal((await bridge.status()).sessionExpiresAt, null);
  assert.ok(bridge.storageData.bridgeFiveDayApprovals);

  const restarted = await mount({ savedState: bridge.storageData, startTime: 10000 + 48 * 60 * 60 * 1000 });
  assert.equal((await restarted.status()).fiveDayExpiresAt, expiresAt);
  const restoredRead = await restarted.request();
  assert.equal(restarted.posted.find(message => message.id === restoredRead)?.result?.authorized, true);
  assert.equal((await restarted.status()).pendingApproval, null);
  assert.equal((await restarted.status()).fiveDayExpiresAt, expiresAt);
  await restarted.advance(72 * 60 * 60 * 1000);
  await restarted.request();
  assert.equal((await restarted.status()).pendingApproval?.mode, 'ask-five-days');
});

test('reset and settings changes revoke persisted five-day approvals before returning', async () => {
  for (const action of ['reset', 'scope', 'disable']) {
    const bridge = await mount({ mode: 'ask-five-days' });
    await bridge.request();
    await bridge.message({ type: 'approval_answer', id: (await bridge.status()).pendingApproval.id, allowed: true }); await settle();
    const response = action === 'reset'
      ? await bridge.message({ type: 'bridge_reset_approvals' })
      : await bridge.message({ type: 'bridge_settings', settings: { enabled: action !== 'disable', contentMode: 'ask-five-days', contentScope: action === 'scope' ? 'all' : 'active' } });
    assert.equal(response.fiveDayExpiresAt, null);
    const restarted = await mount({ savedState: bridge.storageData });
    assert.equal((await restarted.status()).fiveDayExpiresAt, null);
    if (action !== 'disable') {
      await restarted.request();
      assert.equal((await restarted.status()).pendingApproval?.mode, 'ask-five-days');
    }
  }
});

test('cancelling a wait dismisses its approval and cannot create a later session grant', async () => {
  const bridge = await mount({ mode: 'ask-session' });
  const id = await bridge.request(43, 'wait_for');
  const pending = (await bridge.status()).pendingApproval;
  assert.ok(pending);
  bridge.port.onMessage.emit({ type: 'cancel', id: 'unrelated-request' });
  await settle();
  assert.equal((await bridge.status()).pendingApproval.id, pending.id);
  bridge.port.onMessage.emit({ type: 'cancel', id });
  await settle();
  assert.equal((await bridge.status()).pendingApproval, null);
  assert.equal(bridge.policy.promptPending, false);
  assert.equal(bridge.policy.tabGrants.size, 0);
  assert.equal(bridge.policy.expiresAt, null);
  assert.equal(bridge.posted.find(message => message.id === id).error.code, 'CANCELLED');
  assert.deepEqual(await bridge.message({ type: 'approval_answer', id: pending.id, allowed: true }), { ok: false });
  assert.equal(bridge.reads(), 0);
});

test('a pending wait leaves metadata and tab-control requests outside its approval queue', async () => {
  const bridge = await mount();
  const id = await bridge.request(42, 'wait_for');
  bridge.port.onMessage.emit({ id: 'metadata-while-waiting', method: 'get_tabs', params: { tabIds: [43] }, expiresAt: 140000 });
  await settle();
  assert.equal(bridge.posted.find(message => message.id === 'metadata-while-waiting').result.tabs[0].id, 43);
  assert.equal(bridge.posted.some(message => message.id === id), false);
  bridge.port.onMessage.emit({ type: 'cancel', id });
  await settle();
  assert.equal(bridge.reads(), 0);
});

test('disconnect aborts waiting content approvals without granting access', async () => {
  const bridge = await mount({ mode: 'ask-session' });
  await bridge.request(42, 'wait_for');
  assert.ok((await bridge.status()).pendingApproval);
  bridge.port.onDisconnect.emit();
  await settle();
  assert.equal((await bridge.status()).pendingApproval, null);
  assert.equal(bridge.policy.promptPending, false);
  assert.equal(bridge.policy.expiresAt, null);
  assert.equal(bridge.reads(), 0);
});

test('the wait deadline includes real content approval and clears its prompt and pending policy state', async () => {
  const bridge = await mount({ mode: 'ask-session' });
  const id = await bridge.request(43, 'wait_for', { timeoutMs: 25 });
  const pending = (await bridge.status()).pendingApproval;
  assert.ok(pending);
  await bridge.advance(25);
  assert.equal(bridge.posted.find(message => message.id === id).error.code, 'WAIT_TIMEOUT');
  assert.equal((await bridge.status()).pendingApproval, null);
  assert.equal(bridge.policy.promptPending, false);
  assert.equal(bridge.policy.tabGrants.size, 0);
  assert.equal(bridge.policy.expiresAt, null);
  assert.equal(bridge.reads(), 0);
  assert.deepEqual(await bridge.message({ type: 'approval_answer', id: pending.id, allowed: true }), { ok: false });
  await bridge.request();
  assert.ok((await bridge.status()).pendingApproval);
  await bridge.message({ type: 'approval_answer', id: (await bridge.status()).pendingApproval.id, allowed: false });
});
