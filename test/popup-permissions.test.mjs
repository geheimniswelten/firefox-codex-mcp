import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../extension/popup.js', import.meta.url), 'utf8');
const settle = async () => { for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve)); };
function event() {
  const callbacks = new Set();
  return { addListener: fn => callbacks.add(fn), removeListener: fn => callbacks.delete(fn), emit: () => [...callbacks].forEach(fn => fn()) };
}
function mount({ granted = false, rejection = null, accepted = true } = {}) {
  const elements = new Map(), messages = [], calls = [];
  let userGesture = false, currentGrant = granted, interval;
  const el = id => {
    if (!elements.has(id)) elements.set(id, { checked: false, disabled: false, hidden: true, value: '', textContent: '', listeners: new Map(), addEventListener(name, fn) { this.listeners.set(name, fn); } });
    return elements.get(id);
  };
  const state = { settings: { enabled: true, contentMode: 'ask-session', contentScope: 'active' }, icon: { color: 'green', label: 'Ready' }, connected: true, sessionExpiresAt: null, lastAccessAt: null, lastError: null, version: '0.1.1' };
  const browser = {
    runtime: { async sendMessage(message) { messages.push(message); return structuredClone(state); } },
    permissions: {
      onAdded: event(), onRemoved: event(),
      async getAll() { return { data_collection: currentGrant ? ['technicalAndInteraction'] : [] }; },
      request(options) {
        assert.equal(userGesture, true, 'permission request must begin synchronously in click gesture');
        calls.push(['request', structuredClone(options)]);
        if (rejection) return Promise.reject(new Error(rejection));
        currentGrant = accepted; browser.permissions.onAdded.emit(); return Promise.resolve(accepted);
      },
      remove(options) { calls.push(['remove', structuredClone(options)]); currentGrant = false; browser.permissions.onRemoved.emit(); return Promise.resolve(true); }
    }
  };
  vm.runInContext(source, vm.createContext({ browser, document: { getElementById: el }, window: { addEventListener() {} }, setInterval: fn => { interval = fn; return 1; }, clearInterval() {} }));
  return {
    el, browser, messages, calls,
    externalGrant(value) { currentGrant = value; (value ? browser.permissions.onAdded : browser.permissions.onRemoved).emit(); },
    refresh() { interval(); },
    click(checked) {
      el('inventoryPermission').checked = checked;
      userGesture = true;
      const pending = el('inventoryPermission').listeners.get('click')();
      userGesture = false;
      return pending;
    }
  };
}

test('inventory consent defaults off and requests only data collection directly from a user click', async () => {
  const popup = mount(); await settle();
  assert.equal(popup.el('inventoryPermission').checked, false);
  assert.equal(popup.el('inventoryPermission').disabled, false);
  await popup.click(true);
  assert.equal(popup.el('inventoryPermission').checked, true);
  assert.deepEqual(popup.calls, [['request', { data_collection: ['technicalAndInteraction'] }]]);
  assert.equal(popup.messages.some(message => message.type === 'bridge_settings'), false);
});

test('existing consent is displayed and can be revoked independently from MCP/content preferences', async () => {
  const popup = mount({ granted: true }); await settle();
  assert.equal(popup.el('inventoryPermission').checked, true);
  await popup.click(false);
  assert.equal(popup.el('inventoryPermission').checked, false);
  assert.deepEqual(popup.calls, [['remove', { data_collection: ['technicalAndInteraction'] }]]);
  assert.equal(popup.el('contentMode').value, 'ask-session');
  assert.equal(popup.el('contentScope').value, 'active');
  assert.equal(popup.messages.some(message => message.type === 'bridge_settings'), false);
});

test('denied or rejected consent requests restore unchecked state and permit retry', async () => {
  for (const options of [{ accepted: false }, { rejection: 'Permission request cancelled' }]) {
    const popup = mount(options); await settle();
    await popup.click(true);
    assert.equal(popup.el('inventoryPermission').checked, false);
    assert.equal(popup.el('inventoryPermission').disabled, false);
    if (options.rejection) { assert.equal(popup.el('inventoryError').hidden, false); assert.equal(popup.el('inventoryError').textContent, options.rejection); }
  }
});

test('permission events and popup polling reflect grants changed outside the popup', async () => {
  const popup = mount(); await settle();
  popup.externalGrant(true); await settle(); assert.equal(popup.el('inventoryPermission').checked, true);
  popup.externalGrant(false); await settle(); assert.equal(popup.el('inventoryPermission').checked, false);
  popup.refresh(); await settle(); assert.equal(popup.el('inventoryPermission').checked, false);
  assert.equal(popup.calls.length, 0);
});
