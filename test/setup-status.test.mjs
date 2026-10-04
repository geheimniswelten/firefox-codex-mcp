import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';

const source = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
const clone = value => structuredClone(value);
function event() {
  const listeners = new Set();
  return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn), emit: (...args) => [...listeners].map(fn => fn(...args)) };
}
function metadata(overrides = {}) {
  return { type: 'setup_status', hostVersion: '1.0.2', protocolVersion: 1, registration: {
    registrationRevision: 1, installerVersion: '1.0.2', registeredAt: '2026-10-01T12:00:00.000Z', platform: 'linux', manifestPath: '/home/example/.mozilla/native-messaging-hosts/de.codex.firefox_bridge.json',
  }, ...overrides };
}
async function mount({ os = 'linux', saved = {}, write = null, platformError = false } = {}) {
  const data = clone(saved), ports = [], badges = [], titles = [], writes = [], timers = new Map();
  let timerId = 0, calls = 0, policy;
  const browser = {
    runtime: {
      id: 'bridge@test', getURL: file => `moz-extension://bridge/${file}`, onMessage: event(),
      ...(os === null ? {} : { getPlatformInfo: () => platformError ? Promise.reject(new Error('Unavailable')) : Promise.resolve({ os }) }),
      sendMessage: async () => {},
      connectNative(name) {
        assert.equal(name, 'de.codex.firefox_bridge');
        const port = { onMessage: event(), onDisconnect: event(), posted: [], postMessage(message) { this.posted.push(clone(message)); }, disconnect() { this.onDisconnect.emit(); } };
        ports.push(port); return port;
      },
    },
    storage: { local: {
      get: async () => clone(data),
      async set(value) { writes.push(clone(value)); if (write) await write(value); Object.assign(data, clone(value)); },
    } },
    browserAction: { setBadgeText: async ({ text }) => badges.push(text), setTitle: async ({ title }) => titles.push(title), setIcon: async () => {}, openPopup: async () => {} },
    windows: { update: async () => {} },
  };
  const defaults = { enabled: true, contentMode: 'ask-session', contentScope: 'active' };
  class ContentAccess {
    constructor(_browser, options) { this.settings = { ...defaults }; this.requestApproval = options.requestApproval; policy = this; }
    setSettings(value) { this.settings = { ...defaults, ...value }; return this.settings; }
    restoreApprovals() { return Promise.resolve(); }
    flushApprovals() { return Promise.resolve(); }
    resetApprovals() {}
    async getCurrentWindow() { return { id: 7, type: 'normal' }; }
  }
  const realm = vm.createContext({
    browser, crypto: webcrypto, AbortController,
    FirefoxBridgePolicy: { ContentAccess, normalizeSettings: value => ({ ...defaults, ...value }), iconStatus: value => ({ color: value.enabled && value.connected ? 'green' : 'gray', label: value.enabled && value.connected ? 'Connected' : 'Disconnected' }) },
    FirefoxBridgeCore: { VERSION: '1.0.2', validate() {}, errorData: error => ({ code: error.code || 'ERROR', message: error.message }), createService() {
      return { ready: Promise.resolve(), clearExports() {}, clearHistorySnapshots() {}, async handle(method) {
        calls++;
        if (method === 'read_content') await policy.requestApproval({ tabId: 3, title: 'Page', url: 'https://example.test/', mode: 'ask-session', scope: 'active' });
        return { ok: true };
      } };
    } },
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    clearTimeout: id => timers.delete(id), setInterval: () => 1,
  });
  vm.runInContext(source, realm); await settle();
  const sender = file => ({ id: browser.runtime.id, url: browser.runtime.getURL(file) });
  const message = async (value, from = sender('popup.html')) => clone(await browser.runtime.onMessage.emit(value, from)[0]);
  return { browser, data, ports, badges, titles, timers, writes, sender, message, calls: () => calls, status: () => message({ type: 'bridge_status' }) };
}

test('a matching host receipt confirms registration independently of addon and host release versions', async () => {
  const f = await mount();
  assert.equal((await f.status()).setup.status, 'pending');
  assert.equal((await f.status()).setup.platform, 'linux');
  assert.equal(f.badges.at(-1), '');
  f.ports[0].onMessage.emit(metadata({ hostVersion: '1.0.3' }));
  assert.equal((await f.status()).setup.status, 'pending', 'metadata alone does not establish the HTTP bridge');
  f.ports[0].onMessage.emit({ type: 'connected' }); await settle();
  const state = await f.status();
  assert.equal(state.setup.status, 'ready');
  assert.equal(state.setup.hostVersion, '1.0.3');
  assert.equal(state.version, '1.0.2');
  assert.equal(state.setup.requiredRevision, 1);
  assert.equal(state.setup.requiredProtocol, 1);
  assert.equal(state.setup.registration.registrationRevision, 1);
  assert.ok(state.setup.lastConfirmation.verifiedAt);
  assert.equal(f.data.bridgeSetupLastConfirmation.hostVersion, '1.0.3');
  assert.equal(f.badges.at(-1), '');
});

test('outdated revision needs update while old hosts and missing receipts remain unverified', async () => {
  for (const kind of ['outdated', 'legacy', 'no-receipt']) {
    const f = await mount();
    if (kind === 'outdated') f.ports[0].onMessage.emit(metadata({ registration: { ...metadata().registration, registrationRevision: 0 } }));
    if (kind === 'no-receipt') f.ports[0].onMessage.emit(metadata({ registration: null }));
    f.ports[0].onMessage.emit({ type: 'connected' });
    const state = await f.status();
    assert.equal(state.connected, true);
    assert.equal(state.setup.status, kind === 'outdated' ? 'update_required' : 'unverified');
    assert.equal(f.badges.at(-1), kind === 'outdated' ? '↑' : '!');
  }
});

test('incompatible protocol blocks RPC without disabling compatible legacy hosts', async () => {
  const f = await mount();
  f.ports[0].onMessage.emit(metadata({ protocolVersion: 2 }));
  f.ports[0].onMessage.emit({ type: 'connected' });
  assert.equal((await f.status()).setup.status, 'update_required');
  f.ports[0].onMessage.emit({ id: 'request', method: 'status', params: {} }); await settle();
  assert.equal(f.calls(), 0);
  assert.equal(f.ports[0].posted.at(-1).error.code, 'PROTOCOL_MISMATCH');
  const legacy = await mount(); legacy.ports[0].onMessage.emit({ type: 'connected' });
  legacy.ports[0].onMessage.emit({ id: 'request', method: 'status', params: {} }); await settle();
  assert.equal(legacy.calls(), 1);
});

test('a receipt for a different browser platform requests an update, while missing platform API is tolerated', async () => {
  const f = await mount({ os: 'mac' });
  f.ports[0].onMessage.emit(metadata()); f.ports[0].onMessage.emit({ type: 'connected' });
  assert.equal((await f.status()).setup.status, 'update_required');
  for (const options of [{ os: null }, { platformError: true }]) {
    const older = await mount(options);
    older.ports[0].onMessage.emit(metadata()); older.ports[0].onMessage.emit({ type: 'connected' });
    assert.equal((await older.status()).setup.status, 'ready');
    assert.equal((await older.status()).setup.platform, null);
  }
});

test('native error texts distinguish not-found from connection errors without claiming absent registration', async () => {
  for (const [message, expected] of [
    ['No such native application de.codex.firefox_bridge', 'host_missing'],
    ['File at path /missing does not exist, or is not executable', 'connection_error'],
    ['Native host has exited', 'connection_error'],
    ['Port is occupied', 'connection_error'],
    ['This extension does not have permission to use native application de.codex.firefox_bridge', 'connection_error'],
  ]) {
    const f = await mount();
    f.ports[0].error = { message }; f.ports[0].onDisconnect.emit();
    const state = await f.status();
    assert.equal(state.setup.status, expected);
    assert.equal(state.lastError, message);
    assert.doesNotMatch(state.setup.label + state.setup.description, /nicht registriert|keine Registrierung/u);
    assert.equal(f.badges.at(-1), '!');
  }
});

test('reconnect clears current evidence, retains historical confirmation, and ignores old ports', async () => {
  const f = await mount(), first = f.ports[0];
  first.onMessage.emit(metadata()); first.onMessage.emit({ type: 'connected' }); await settle();
  await f.message({ type: 'bridge_reconnect' });
  let state = await f.status();
  assert.equal(state.setup.registration, null);
  assert.equal(state.setup.status, 'pending');
  assert.equal(state.setup.lastConfirmation.registration.registrationRevision, 1);
  first.onMessage.emit(metadata({ registration: { ...metadata().registration, registrationRevision: 99 } }));
  first.onMessage.emit({ type: 'connected' });
  assert.equal((await f.status()).setup.registration, null);
  f.ports[1].onMessage.emit({ type: 'connected' });
  state = await f.status();
  assert.equal(state.setup.status, 'unverified');
  assert.equal(state.setup.lastConfirmation.registration.registrationRevision, 1);
});

test('persisted confirmation never substitutes for a live host receipt', async () => {
  const record = { ...metadata(), verifiedAt: '2026-10-02T12:00:00.000Z' };
  const f = await mount({ saved: { bridgeSetupLastConfirmation: record } });
  f.ports[0].onMessage.emit({ type: 'connected' });
  const state = await f.status();
  assert.equal(state.setup.status, 'unverified');
  assert.equal(state.setup.registration, null);
  assert.equal(state.setup.lastConfirmation.verifiedAt, record.verifiedAt);
});

test('malformed setup evidence stays an error after connected and cannot enter stored history or RPC', async () => {
  for (const message of [metadata({ protocolVersion: '1' }), metadata({ registration: { ...metadata().registration, registeredAt: 'yesterday' } }), metadata({ hostVersion: 'x'.repeat(81) })]) {
    const f = await mount();
    f.ports[0].onMessage.emit(message); f.ports[0].onMessage.emit({ type: 'connected' }); await settle();
    assert.equal((await f.status()).setup.status, 'connection_error');
    assert.match((await f.status()).lastError, /ungültigen/u);
    assert.equal(f.writes.length, 0);
    f.ports[0].onMessage.emit({ id: 'request', method: 'status', params: {} }); await settle();
    assert.equal(f.calls(), 0);
    assert.equal(f.ports[0].posted.at(-1).error.code, 'HOST_STATUS_INVALID');
  }
});

test('host metadata without a connection acknowledgement times out without implying failed registration', async () => {
  const f = await mount(); f.ports[0].onMessage.emit(metadata());
  [...f.timers.values()].find(timer => timer.delay === 10000).fn();
  const state = await f.status();
  assert.equal(state.connected, false);
  assert.equal(state.setup.status, 'connection_error');
  assert.equal(state.setup.registration, null);
  assert.equal(state.setup.lastConfirmation.registration.registrationRevision, 1);
  assert.match(state.lastError, /nicht rechtzeitig/u);
});

test('options page may only inspect and reconnect, with exact extension identity and URL', async () => {
  const f = await mount(), setup = f.sender('setup/setup.html');
  assert.equal((await f.message({ type: 'bridge_status' }, setup)).setup.status, 'pending');
  await f.message({ type: 'bridge_reconnect' }, setup);
  assert.equal(f.ports.length, 2);
  for (const type of ['bridge_settings', 'bridge_reset_approvals', 'approval_answer']) assert.equal(await f.message({ type, settings: { enabled: false } }, setup), undefined);
  for (const sender of [f.sender('setup/setup.html?anything'), { ...setup, id: 'other@test' }, f.sender('setup/other.html')]) assert.equal(await f.message({ type: 'bridge_status' }, sender), undefined);
  assert.equal((await f.status()).settings.enabled, true);
});

test('approval question takes precedence over setup badges and disabled MCP clears setup warnings', async () => {
  const f = await mount(); f.ports[0].onMessage.emit({ type: 'connected' });
  assert.equal(f.badges.at(-1), '!');
  f.ports[0].onMessage.emit({ id: 'read', method: 'read_content', params: {} }); await settle();
  assert.equal(f.badges.at(-1), '?');
  f.ports[0].onMessage.emit(metadata({ registration: { ...metadata().registration, registrationRevision: 0 } }));
  assert.equal(f.badges.at(-1), '?');
  assert.match(f.titles.at(-1), /Inhaltsfreigabe/u);
  await f.message({ type: 'bridge_settings', settings: { enabled: false } });
  assert.equal((await f.status()).setup.status, 'disabled');
  assert.equal((await f.status()).setup.registration, null);
  assert.equal(f.badges.at(-1), '');
});
