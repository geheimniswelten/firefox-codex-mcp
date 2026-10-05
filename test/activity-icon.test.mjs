import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');
const policySource = await readFile(new URL('../extension/policy.js', import.meta.url), 'utf8');
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
function event() {
  const listeners = new Set();
  return { addListener: fn => listeners.add(fn), emit: (...args) => [...listeners].map(fn => fn(...args)) };
}
function deferred() {
  let resolve;
  return { promise: new Promise(done => { resolve = done; }), resolve: () => resolve() };
}
async function mount() {
  let now = 10000, sequence = 0, policy, heartbeat, slowIcons = false, failIcons = false, iconWrites = 0, maxIconWrites = 0;
  const timers = new Map(), holds = new Map(), ports = [], icons = [], badges = [], titles = [], iconHolds = [], handled = [];
  const browser = {
    runtime: {
      id: 'activity@test', getURL: file => 'moz-extension://activity/' + file, onMessage: event(),
      sendMessage: async () => {}, getPlatformInfo: async () => ({ os: 'win' }),
      connectNative() {
        const port = { onMessage: event(), onDisconnect: event(), posted: [],
          postMessage(value) { this.posted.push(value); }, disconnect() { this.onDisconnect.emit(); } };
        ports.push(port); return port;
      },
    },
    storage: { local: { get: async () => ({}), set: async () => {} } },
    windows: { update: async () => {} },
    browserAction: {
      setBadgeText: async ({ text }) => { badges.push(text); },
      setTitle: async ({ title }) => { titles.push(title); },
      openPopup: async () => {},
      async setIcon({ path }) {
        icons.push(path); iconWrites++; maxIconWrites = Math.max(maxIconWrites, iconWrites);
        try {
          if (slowIcons) { const hold = deferred(); iconHolds.push(hold); await hold.promise; }
          if (failIcons) throw new Error('Icon unavailable');
        } finally { iconWrites--; }
      },
    },
  };
  const defaults = { enabled: true, contentMode: 'ask-every-time', contentScope: 'active' };
  class ContentAccess {
    constructor(_browser, options) { this.settings = { ...defaults }; this.requestApproval = options.requestApproval; policy = this; }
    setSettings(value) { this.settings = { ...defaults, ...value }; return this.settings; }
    async restoreApprovals() {}
    async flushApprovals() {}
    resetApprovals() {}
    async getCurrentWindow() { return { id: 1, type: 'normal' }; }
  }
  class Clock extends Date { static now() { return now; } }
  const policyRealm = vm.createContext({ Date: Clock });
  vm.runInContext(policySource, policyRealm);
  const realm = vm.createContext({
    browser, Date: Clock, AbortController, crypto: { randomUUID: () => 'approval' },
    setTimeout(fn, delay) { const id = ++sequence; timers.set(id, { fn, delay, at: now + delay }); return id; },
    clearTimeout: id => timers.delete(id), setInterval: fn => { heartbeat = fn; return 1; },
    FirefoxBridgePolicy: {
      ContentAccess, normalizeSettings: value => ({ ...defaults, ...value }),
      iconStatus: policyRealm.FirefoxBridgePolicy.iconStatus,
    },
    FirefoxBridgeCore: {
      VERSION: 'test', errorData: error => ({ code: error.code || 'ERROR', message: error.message }),
      validate(method) { if (!['status', 'read_content', 'wait_for'].includes(method)) throw new Error('Unknown method'); },
      createService() {
        return { ready: Promise.resolve(), async handle(method, params, context) {
          handled.push(params.key || method);
          if (params.approval) await policy.requestApproval({ tabId: 3, url: 'https://example.test/', title: 'Example' });
          if (params.hold) {
            const hold = deferred(); holds.set(params.key, hold);
            await hold.promise;
          }
          context.assertLive();
          if (params.fail) throw new Error('Operation failed');
          return { ok: true };
        } };
      },
    },
  });
  vm.runInContext(source, realm);
  await settle();
  function connected(port = ports.at(-1)) {
    port.onMessage.emit({ type: 'setup_status', hostVersion: 'test', protocolVersion: 1, registration: {
      registrationRevision: 1, installerVersion: 'test', registeredAt: '2026-10-01T12:00:00Z', platform: 'win', manifestPath: 'C:\\test\\host.json',
    } });
    port.onMessage.emit({ type: 'connected' });
  }
  connected(); await settle();
  const sender = { id: browser.runtime.id, url: browser.runtime.getURL('popup.html') };
  const message = async value => browser.runtime.onMessage.emit(value, sender)[0];
  return {
    icons, badges, titles, timers, ports, holds, handled, connected, message,
    status: () => message({ type: 'bridge_status' }),
    request(method = 'status', params = {}, extra = {}) {
      const id = 'request-' + (++sequence);
      ports.at(-1).onMessage.emit({ id, method, params, expiresAt: now + 130000, ...extra }); return id;
    },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, timer] = next; timers.delete(id); now = timer.at; timer.fn(); await settle();
      }
      now = end; await settle();
    },
    slowIcons(value) { slowIcons = value; },
    failIcons(value) { failIcons = value; },
    releaseIcons() { for (const hold of iconHolds.splice(0)) hold.resolve(); },
    maxIconWrites: () => maxIconWrites,
    heartbeat: async () => { heartbeat(); await settle(); },
  };
}

test('popup polling and rejected RPCs never start an activity animation', async () => {
  const f = await mount(), initial = f.icons.length;
  for (let i = 0; i < 20; i++) await f.status();
  f.request('unknown'); await settle(); await f.advance(1000);
  assert.equal(f.icons.length, initial);
  assert.equal((await f.status()).lastAccessAt, null);
  assert.equal(f.timers.size, 0);
});

test('short calls share a paced three-frame animation with an 800 ms minimum duration', async () => {
  const f = await mount(), initial = f.icons.length;
  for (let i = 0; i < 20; i++) f.request();
  await settle();
  assert.deepEqual(f.icons.slice(initial), ['icon-activity-blue-0.svg']);
  await f.advance(200);
  for (let i = 0; i < 10; i++) f.request();
  await settle();
  assert.equal(f.icons.at(-1), 'icon-activity-blue-0.svg');
  await f.advance(40);
  assert.equal(f.icons.at(-1), 'icon-activity-blue-1.svg');
  await f.advance(560);
  assert.deepEqual(f.icons.slice(initial), [
    'icon-activity-blue-0.svg', 'icon-activity-blue-1.svg', 'icon-activity-blue-2.svg',
    'icon-activity-blue-0.svg', 'icon-recent-blue.svg',
  ]);
  assert.equal(f.timers.size, 1);
  const before = f.icons.length; await f.advance(5000); assert.equal(f.icons.length, before);
});

test('overlapping operations keep animating until the last request finishes', async () => {
  const f = await mount();
  f.request('read_content', { key: 'first', hold: true });
  f.request('read_content', { key: 'last', hold: true }); await settle();
  f.holds.get('first').resolve(); await settle(); await f.advance(2000);
  assert.match(f.icons.at(-1), /^icon-activity-blue-/);
  f.holds.get('last').resolve(); await settle();
  await f.advance(199); assert.match(f.icons.at(-1), /^icon-activity-blue-/);
  await f.advance(1); assert.equal(f.icons.at(-1), 'icon-recent-blue.svg');
});

test('queued operations and failed requests release their activity leases', async () => {
  const f = await mount();
  f.request('status', { key: 'queued-first', hold: true });
  const failed = f.request('status', { key: 'queued-last', fail: true });
  await settle();
  assert.deepEqual(f.handled, ['queued-first']);
  await f.advance(1200);
  assert.match(f.icons.at(-1), /^icon-activity-blue-/);
  f.holds.get('queued-first').resolve(); await settle();
  assert.equal(f.ports.at(-1).posted.find(value => value.id === failed).error.code, 'ERROR');
  await f.advance(800); assert.equal(f.icons.at(-1), 'icon-recent-blue.svg');
  assert.equal(f.timers.size, 1);
});

test('approval pauses animation without losing the question badge or its deadline', async () => {
  const f = await mount();
  f.request('read_content', { approval: true }); await settle();
  const approval = (await f.status()).pendingApproval;
  assert.equal(f.icons.at(-1), 'icon-blue.svg');
  assert.equal(f.badges.at(-1), '?');
  assert.match(f.titles.at(-1), /Inhaltsfreigabe erforderlich/);
  assert.equal(f.timers.size, 1);
  const before = f.icons.length; await f.advance(5000);
  assert.equal(f.icons.length, before);
  assert.equal((await f.status()).pendingApproval.expiresAt, approval.expiresAt);
  await f.message({ type: 'approval_answer', id: approval.id, allowed: true }); await settle();
  assert.match(f.icons.at(-1), /^icon-activity-blue-/);
  assert.equal(f.badges.at(-1), '');
  await f.advance(800); assert.equal(f.icons.at(-1), 'icon-recent-blue.svg');
});

test('disconnects clear animation and stale completions cannot restart it after reconnect', async () => {
  const f = await mount();
  f.request('read_content', { key: 'old-port', hold: true }); await settle();
  f.ports.at(-1).onDisconnect.emit(); await settle();
  assert.equal(f.icons.at(-1), 'icon-gray.svg');
  await f.advance(1000); f.connected(); await settle();
  assert.equal(f.icons.at(-1), 'icon-blue.svg');
  f.holds.get('old-port').resolve(); await settle(); await f.advance(1000);
  assert.equal(f.icons.at(-1), 'icon-blue.svg');
  assert.equal(f.timers.size, 0);
  f.request(); await settle(); assert.match(f.icons.at(-1), /^icon-activity-blue-/);
});

test('disabling MCP stops animation immediately, including in-flight requests', async () => {
  const f = await mount();
  f.request('read_content', { key: 'disabled', hold: true }); await settle();
  await f.message({ type: 'bridge_settings', settings: { enabled: false } }); await settle();
  assert.equal(f.icons.at(-1), 'icon-gray.svg');
  assert.equal(f.timers.size, 0);
  f.holds.get('disabled').resolve(); await settle(); await f.advance(2000);
  assert.equal(f.icons.at(-1), 'icon-gray.svg');
});

test('slow icon writes are serialized and coalesce skipped animation frames', async () => {
  const f = await mount(), initial = f.icons.length;
  f.slowIcons(true);
  f.request('read_content', { key: 'slow', hold: true }); await settle();
  await f.advance(500);
  assert.deepEqual(f.icons.slice(initial), ['icon-activity-blue-0.svg']);
  f.slowIcons(false); f.releaseIcons(); await settle();
  assert.deepEqual(f.icons.slice(initial), ['icon-activity-blue-0.svg', 'icon-activity-blue-2.svg']);
  assert.equal(f.maxIconWrites(), 1);
  f.holds.get('slow').resolve(); await settle(); await f.advance(800);
  assert.equal(f.icons.at(-1), 'icon-recent-blue.svg');
});

test('icon API errors do not break RPC responses or leave timers running', async () => {
  const f = await mount();
  f.failIcons(true); const id = f.request(); await settle();
  assert.equal(f.ports.at(-1).posted.find(value => value.id === id).result.ok, true);
  await f.advance(10800); assert.equal(f.timers.size, 0);
  f.failIcons(false); f.request(); await settle(); await f.advance(800);
  assert.equal(f.icons.at(-1), 'icon-recent-blue.svg');
});

test('dots hide exactly ten seconds after movement ends while blue lasts one minute', async () => {
  const f = await mount(); f.request(); await settle(); await f.advance(800);
  assert.equal(f.icons.at(-1), 'icon-recent-blue.svg');
  assert.equal(f.timers.size, 1);
  await f.advance(9999); assert.equal(f.icons.at(-1), 'icon-recent-blue.svg');
  await f.advance(1); assert.equal(f.icons.at(-1), 'icon-blue.svg');
  assert.equal(f.timers.size, 0);
  await f.advance(49200); await f.heartbeat(); assert.equal(f.icons.at(-1), 'icon-blue.svg');
  await f.advance(1); await f.heartbeat(); assert.equal(f.icons.at(-1), 'icon-amber.svg');
});

test('a new request replaces the previous idle deadline without interrupting movement', async () => {
  const f = await mount(); f.request(); await settle(); await f.advance(5000);
  f.request(); await settle(); await f.advance(800);
  assert.equal(f.icons.at(-1), 'icon-recent-blue.svg');
  await f.advance(5000); assert.equal(f.icons.at(-1), 'icon-recent-blue.svg');
  await f.advance(4999); assert.equal(f.icons.at(-1), 'icon-recent-blue.svg');
  await f.advance(1); assert.equal(f.icons.at(-1), 'icon-blue.svg');
  assert.equal(f.timers.size, 0);
});

test('disabling after movement ends cancels the dots deadline', async () => {
  const f = await mount(); f.request(); await settle(); await f.advance(800);
  await f.message({ type: 'bridge_settings', settings: { enabled: false } }); await settle();
  assert.equal(f.icons.at(-1), 'icon-gray.svg'); assert.equal(f.timers.size, 0);
  await f.advance(12000); assert.equal(f.icons.at(-1), 'icon-gray.svg');
});

test('long requests keep moving when the historical color changes to amber', async () => {
  const f = await mount();
  f.request('read_content', { key: 'long', hold: true }); await settle();
  await f.advance(61000); await f.heartbeat();
  assert.match(f.icons.at(-1), /^icon-activity-amber-/);
  f.holds.get('long').resolve(); await settle(); await f.advance(240);
  assert.equal(f.icons.at(-1), 'icon-amber.svg');
  assert.equal(f.timers.size, 0);
});
