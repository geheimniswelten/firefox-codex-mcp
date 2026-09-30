import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const [backgroundSource, policySource] = await Promise.all([
  readFile(new URL('../extension/background.js', import.meta.url), 'utf8'),
  readFile(new URL('../extension/policy.js', import.meta.url), 'utf8'),
]);
const settle = async () => { for (let index = 0; index < 5; index++) await new Promise(resolve => setImmediate(resolve)); };
const clone = value => structuredClone(value);
function event() {
  const listeners = new Set();
  return { addListener: callback => listeners.add(callback), removeListener: callback => listeners.delete(callback), emit: (...args) => [...listeners].map(callback => callback(...args)) };
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function mount({ mode = 'ask-every-time', scope = 'active', windowState = 'normal', openError = false, focusError = false, noReceiver = false } = {}) {
  let now = 10000, timerSequence = 0, requestSequence = 0, uuidSequence = 0, policy, reads = 0;
  const timers = new Map(), posted = [], calls = [], notifications = [];
  const normalWindow = { id: 7, type: 'normal', state: windowState, focused: false, tabs: [{ id: 42, windowId: 7, active: true, url: 'https://example.test/page', title: 'Example title' }] };
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
    storage: { local: { get: async () => ({ bridgeSettings: { enabled: true, contentMode: mode, contentScope: scope } }), set: async () => {} } },
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
      get: async id => { assert.equal(id, 42); return clone(normalWindow.tabs[0]); },
      update: () => assert.fail('Approval must never activate or change a tab.'),
    },
  };
  // The real access policy performs before/after-approval scope checks. The
  // service stub records authorization only; no page content is read in tests.
  const core = {
    VERSION: 'test', validate() {}, errorData: error => ({ code: error.code || 'ERROR', message: error.message }),
    createService(_browser, options) {
      policy = options.contentAccess;
      return { ready: Promise.resolve(), async handle(method, params, context) {
        assert.equal(method, 'read_content');
        context.assertLive();
        await policy.authorize(await browser.tabs.get(params.tabId));
        context.assertLive();
        reads++;
        return { authorized: true };
      } };
    },
  };
  class Clock extends Date { static now() { return now; } }
  const context = vm.createContext({
    browser, FirefoxBridgeCore: core, Date: Clock,
    crypto: { randomUUID: () => `unique-approval-${++uuidSequence}` },
    setTimeout(callback, delay) { const id = ++timerSequence; timers.set(id, { callback, delay, expiresAt: now + delay }); return id; },
    clearTimeout: id => timers.delete(id), setInterval: () => 1,
  });
  vm.runInContext(policySource, context);
  vm.runInContext(backgroundSource, context);
  await settle();
  port.onMessage.emit({ type: 'connected' });
  const sender = { id: browser.runtime.id, url: browser.runtime.getURL('popup.html') };
  const message = async (value, from = sender) => clone(await browser.runtime.onMessage.emit(value, from)[0]);
  return {
    browser, port, policy, timers, posted, calls, notifications, sender,
    reads: () => reads,
    message,
    status: () => message({ type: 'bridge_status' }),
    async request() {
      const id = `request-${++requestSequence}`;
      port.onMessage.emit({ id, method: 'read_content', params: { tabId: 42 }, expiresAt: now + 130000 });
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
