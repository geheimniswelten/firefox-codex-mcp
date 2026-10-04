import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../extension/popup.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../extension/popup.html', import.meta.url), 'utf8');
const settle = async () => { for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve)); };
function event() {
  const callbacks = new Set();
  return { addListener: fn => callbacks.add(fn), removeListener: fn => callbacks.delete(fn), emit: (...args) => [...callbacks].map(fn => fn(...args)), size: () => callbacks.size };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function approval(overrides = {}) {
  return { id: 'approval-a', tabId: 17, title: 'Example page', url: 'https://example.com/', mode: 'ask-session', scope: 'active', expiresAt: Date.now() + 120000, ...overrides };
}
function mount({ granted = false, rejection = null, accepted = true, pendingApproval = null } = {}) {
  const elements = new Map(), messages = [], calls = [];
  const statusResponses = [], windowListeners = new Map();
  let userGesture = false, currentGrant = granted, interval, intervalCleared = false, now = Date.now(), answerHandler = null;
  const el = id => {
    if (!elements.has(id)) elements.set(id, {
      checked: false, disabled: id === 'approvalAllow', hidden: id === 'approval' || id.endsWith('Error') || id === 'error', value: '', textContent: '', focusCount: 0, listeners: new Map(),
      addEventListener(name, fn) { this.listeners.set(name, fn); },
      focus() { this.focusCount++; },
      set innerHTML(_value) { throw new Error('Page-provided approval details must use textContent, never innerHTML.'); }
    });
    return elements.get(id);
  };
  const state = { settings: { enabled: true, contentMode: 'ask-session', contentScope: 'active' }, icon: { color: 'green', label: 'Ready' }, connected: true, sessionExpiresAt: null, fiveDayExpiresAt: null, lastAccessAt: null, lastError: null, version: '0.1.1', pendingApproval };
  const browser = {
    runtime: {
      onMessage: event(),
      async openOptionsPage() { calls.push(['openOptionsPage']); },
      async sendMessage(message) {
        messages.push(structuredClone(message));
        if (message.type === 'approval_answer') {
          if (answerHandler) return answerHandler(structuredClone(message));
          const ok = state.pendingApproval?.id === message.id && now < state.pendingApproval.expiresAt;
          if (ok) state.pendingApproval = null;
          return { ok };
        }
        if (message.type === 'bridge_status' && statusResponses.length) return structuredClone(await statusResponses.shift());
        if (message.type === 'bridge_settings') state.settings = structuredClone(message.settings);
        if (message.type === 'bridge_reset_approvals') { state.sessionExpiresAt = null; state.fiveDayExpiresAt = null; state.pendingApproval = null; }
        return structuredClone(state);
      }
    },
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
  class ClockDate extends Date { static now() { return now; } }
  vm.runInContext(source, vm.createContext({
    browser, document: { getElementById: el }, Date: ClockDate,
    window: { addEventListener(name, fn) { windowListeners.set(name, fn); }, close() { throw new Error('Answering a toolbar approval must not close a window.'); } },
    setInterval: fn => { interval = fn; return 1; }, clearInterval() { intervalCleared = true; }
  }));
  return {
    el, browser, messages, calls, state,
    setPending(value) { state.pendingApproval = value; },
    advanceTime(milliseconds) { now += milliseconds; },
    queueStatus(response) { statusResponses.push(response); },
    setAnswerHandler(handler) { answerHandler = handler; },
    statusChanged() { browser.runtime.onMessage.emit({ type: 'bridge_status_changed' }); },
    openSetup() { return el('openSetup').listeners.get('click')(); },
    changeSetting(id, value) {
      const control = el(id);
      if (control.disabled) return undefined;
      control.value = value;
      return control.listeners.get('change')({ target: control });
    },
    clickApproval(allowed) {
      const button = el(allowed ? 'approvalAllow' : 'approvalDeny');
      // Native disabled controls do not dispatch user clicks.
      if (button.disabled || el('approval').hidden) return undefined;
      return button.listeners.get('click')();
    },
    closePopup() { windowListeners.get('unload')(); },
    intervalCleared() { return intervalCleared; },
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

test('setup action opens the declared options page without granting access or starting an installer', async () => {
  const popup = mount();
  await settle();
  popup.state.setup = { label: 'Aktualisierung erforderlich', actionLabel: 'Registrierung aktualisieren' };
  popup.statusChanged();
  await settle();
  assert.equal(popup.el('setupNotice').textContent, 'Aktualisierung erforderlich');
  assert.equal(popup.el('openSetup').textContent, 'Registrierung aktualisieren');
  const messagesBefore = popup.messages.length;
  await popup.openSetup();
  assert.deepEqual(popup.calls, [['openOptionsPage']]);
  assert.equal(popup.messages.length, messagesBefore);
  assert.match(html, /id="openSetup"/u);
});

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

test('toolbar approval renders page-controlled title and URL as text and describes session scope', async () => {
  const pending = approval({ title: '<img src=x onerror="evil()"> & page', url: 'https://example.com/?q=<script>evil()</script>&x="test"' });
  const popup = mount({ pendingApproval: pending }); await settle();
  assert.equal(popup.el('approval').hidden, false);
  assert.equal(popup.el('settingsPanel').hidden, true);
  assert.equal(popup.el('approvalTitle').textContent, pending.title);
  assert.equal(popup.el('approvalUrl').textContent, pending.url);
  assert.match(popup.el('approvalDescription').textContent, /aktiven Tab.*12 Stunden.*verlängert sich nicht/u);
  assert.equal(popup.el('approvalDeny').focusCount, 1);
  popup.refresh(); await settle();
  assert.equal(popup.el('approvalDeny').focusCount, 1, 'polling must not repeatedly steal keyboard focus');
  popup.setPending(approval({ id: 'approval-b', scope: 'all' })); popup.statusChanged(); await settle();
  assert.match(popup.el('approvalDescription').textContent, /alle Tabs.*12 Stunden/u);
  popup.setPending(approval({ id: 'approval-c', scope: 'all', mode: 'ask-every-time' })); popup.statusChanged(); await settle();
  assert.match(popup.el('approvalDescription').textContent, /Nur diese Anfrage.*alle Tabs.*erneut gefragt/u);
  assert.doesNotMatch(popup.el('approvalDescription').textContent, /12 Stunden/u);
});

test('individual tab approval names its exact URL scope and fixed session or one-read duration', async () => {
  const pending = approval({ scope: 'tab', title: '<script>page title</script>', url: 'https://other.test/private?exact=1' });
  const popup = mount({ pendingApproval: pending }); await settle();
  assert.equal(popup.el('approvalTitle').textContent, pending.title);
  assert.equal(popup.el('approvalUrl').textContent, pending.url);
  assert.match(popup.el('approvalDescription').textContent, /diesen Tab.*genau.*URL.*12 Stunden.*verlängert sich nicht/u);
  assert.match(popup.el('approvalDescription').textContent, /Andere Tabs und andere URLs benötigen eine eigene Freigabe/u);
  assert.doesNotMatch(popup.el('approvalDescription').textContent, /alle Tabs|aktiven Tab/u);
  popup.setPending(approval({ id: 'one-read', scope: 'tab', mode: 'ask-every-time' })); popup.statusChanged(); await settle();
  assert.match(popup.el('approvalDescription').textContent, /Nur diese Anfrage.*diesen Tab.*genau.*URL.*erneut gefragt/u);
  assert.doesNotMatch(popup.el('approvalDescription').textContent, /12 Stunden/u);
});

test('five-day mode is available in the actual dropdown and selecting it only changes the rule', async () => {
  assert.match(html, /<option value="ask-five-days">Für 5 Tage fragen \(neustartübergreifend\)<\/option>/u);
  const popup = mount(); await settle();
  await popup.changeSetting('contentMode', 'ask-five-days');
  assert.equal(popup.el('contentMode').value, 'ask-five-days');
  assert.deepEqual(popup.messages.filter(message => message.type === 'bridge_settings'), [{ type: 'bridge_settings', settings: { enabled: true, contentMode: 'ask-five-days', contentScope: 'active' } }]);
  assert.equal(popup.state.fiveDayExpiresAt, null);
  assert.match(popup.el('session').textContent, /Noch keine aktive 5-Tage-Freigabe.*nächsten Inhaltsanfrage/u);
  assert.equal(popup.messages.some(message => message.type === 'approval_answer'), false);
  assert.equal(popup.calls.length, 0);
});

test('five-day approval describes the fixed deadline and the requested active, all or exact-tab scope', async () => {
  for (const [scope, expectedScope] of [['active', /aktiven Tab/u], ['all', /alle Tabs/u], ['tab', /diesen Tab.*genau.*URL/u]]) {
    const popup = mount({ pendingApproval: approval({ mode: 'ask-five-days', scope }) }); await settle();
    const description = popup.el('approvalDescription').textContent;
    assert.match(description, expectedScope);
    assert.match(description, /5 Tage \(120 Stunden\) ab Zustimmung.*Firefox- oder Erweiterungsneustart.*verlängert sich nicht.*Nach Ablauf/u);
    assert.doesNotMatch(description, /Nur diese Anfrage|12 Stunden/u);
    if (scope === 'tab') {
      assert.match(description, /Andere Tabs und andere URLs benötigen eine eigene Freigabe/u);
      assert.match(description, /an diesen Firefox-Tab gebunden.*Navigation, Neuladen, Entladen oder Schließen widerruft/u);
      assert.doesNotMatch(description, /alle Tabs|aktiven Tab/u);
    }
  }
});

test('five-day status uses its own deadline and reset clears it without changing the rule', async () => {
  const popup = mount(); await settle();
  await popup.changeSetting('contentMode', 'ask-five-days');
  const fiveDayExpiry = Date.now() + 120 * 60 * 60 * 1000;
  popup.state.fiveDayExpiresAt = fiveDayExpiry;
  popup.state.sessionExpiresAt = Date.now() + 12 * 60 * 60 * 1000;
  popup.refresh(); await settle();
  assert.equal(popup.el('session').textContent, `5-Tage-Freigabe bis ${new Date(fiveDayExpiry).toLocaleString('de-DE')}.`);
  await popup.el('resetApprovals').listeners.get('click')();
  assert.equal(popup.state.fiveDayExpiresAt, null);
  assert.equal(popup.state.sessionExpiresAt, null);
  assert.equal(popup.el('contentMode').value, 'ask-five-days');
  assert.match(popup.el('session').textContent, /Noch keine aktive 5-Tage-Freigabe/u);
  popup.state.fiveDayExpiresAt = 1;
  popup.refresh(); await settle();
  assert.match(popup.el('session').textContent, /Noch keine aktive 5-Tage-Freigabe/u);
});

test('reset button sends temporary-approval reset and immediately displays returned state', async () => {
  const popup = mount(); await settle();
  popup.state.sessionExpiresAt = Date.now() + 12 * 60 * 60 * 1000;
  popup.refresh(); await settle();
  assert.match(popup.el('session').textContent, /Sitzungsfreigabe bis/u);
  const settingsBefore = structuredClone(popup.state.settings);
  await popup.el('resetApprovals').listeners.get('click')();
  assert.deepEqual(popup.messages.filter(message => message.type === 'bridge_reset_approvals'), [{ type: 'bridge_reset_approvals' }]);
  assert.equal(popup.el('session').textContent, 'Noch keine aktive Sitzungsfreigabe.');
  assert.deepEqual(popup.state.settings, settingsBefore);
  assert.equal(popup.el('resetApprovals').disabled, false);
});

test('an older status reply cannot restore a grant after a reset', async () => {
  const popup = mount(); await settle();
  const stale = deferred(), oldState = { ...popup.state, sessionExpiresAt: Date.now() + 12 * 60 * 60 * 1000 };
  popup.queueStatus(stale.promise); popup.refresh();
  await popup.el('resetApprovals').listeners.get('click')();
  stale.resolve(oldState); await settle();
  assert.equal(popup.el('session').textContent, 'Noch keine aktive Sitzungsfreigabe.');
});

test('answering sends the exact request ID once while awaiting the background and refreshes status', async () => {
  const popup = mount({ pendingApproval: approval() }); await settle();
  const response = deferred();
  popup.setAnswerHandler(() => response.promise);
  const click = popup.clickApproval(true);
  assert.equal(popup.el('approvalAllow').disabled, true);
  assert.equal(popup.el('approvalDeny').disabled, true);
  popup.clickApproval(true); popup.clickApproval(false);
  assert.deepEqual(popup.messages.filter(message => message.type === 'approval_answer'), [{ type: 'approval_answer', id: 'approval-a', allowed: true }]);
  popup.setPending(null); response.resolve({ ok: true }); await click;
  assert.equal(popup.messages.at(-1).type, 'bridge_status');
  assert.equal(popup.el('approval').hidden, true);
  assert.equal(popup.el('settingsPanel').hidden, false);
});

test('expired or disappeared requests cannot be answered and their controls are disabled', async () => {
  const popup = mount({ pendingApproval: approval() }); await settle();
  popup.advanceTime(120001);
  // The deadline can pass between polling updates; the click handler must check it.
  await popup.clickApproval(true);
  assert.equal(popup.el('approvalAllow').disabled, true);
  assert.equal(popup.el('approvalDeny').disabled, true);
  assert.equal(popup.messages.some(message => message.type === 'approval_answer'), false);
  popup.setPending(approval({ id: 'approval-b', expiresAt: Date.now() + 300000 })); popup.statusChanged(); await settle();
  assert.equal(popup.el('approvalAllow').disabled, false);
  popup.setPending(null); popup.statusChanged(); await settle();
  assert.equal(popup.el('approval').hidden, true);
  assert.equal(popup.el('approvalAllow').disabled, true);
  assert.equal(popup.el('approvalDeny').disabled, true);
  popup.clickApproval(true);
  assert.equal(popup.messages.some(message => message.type === 'approval_answer'), false);
  popup.setPending(approval({ id: 'approval-invalid', expiresAt: NaN })); popup.statusChanged(); await settle();
  assert.equal(popup.el('approvalAllow').disabled, true);
  assert.equal(popup.el('approvalDeny').disabled, true);
});

test('stale approval rejection never approves a replacement request with the old ID', async () => {
  const popup = mount({ pendingApproval: approval() }); await settle();
  const response = deferred();
  popup.setAnswerHandler(() => response.promise);
  const firstClick = popup.clickApproval(true);
  popup.setPending(approval({ id: 'approval-b', tabId: 23, title: 'New request' })); popup.statusChanged(); await settle();
  assert.equal(popup.el('approvalTitle').textContent, 'New request');
  assert.equal(popup.el('approvalAllow').disabled, true);
  popup.clickApproval(true);
  response.resolve({ ok: false }); await firstClick;
  assert.equal(popup.el('approvalTitle').textContent, 'New request');
  assert.equal(popup.el('approvalError').hidden, true, 'a rejection for A must not become an error attached to B');
  assert.equal(popup.el('approvalAllow').disabled, false);
  assert.deepEqual(popup.messages.filter(message => message.type === 'approval_answer'), [{ type: 'approval_answer', id: 'approval-a', allowed: true }]);
  popup.setAnswerHandler(null);
  await popup.clickApproval(false);
  assert.deepEqual(popup.messages.filter(message => message.type === 'approval_answer'), [
    { type: 'approval_answer', id: 'approval-a', allowed: true },
    { type: 'approval_answer', id: 'approval-b', allowed: false }
  ]);
});

test('a stale response for the displayed request shows an error and does not retry approval', async () => {
  const popup = mount({ pendingApproval: approval() }); await settle();
  popup.setAnswerHandler(async () => ({ ok: false }));
  await popup.clickApproval(true);
  assert.equal(popup.el('approvalError').hidden, false);
  assert.match(popup.el('approvalError').textContent, /abgelaufen/u);
  assert.equal(popup.messages.filter(message => message.type === 'approval_answer').length, 1);
});

test('an already open toolbar popup receives new approval via status event and polling fallback', async () => {
  const popup = mount(); await settle();
  assert.equal(popup.el('approval').hidden, true);
  const before = popup.messages.length;
  popup.browser.runtime.onMessage.emit({ type: 'unrelated_event' }); await settle();
  assert.equal(popup.messages.length, before);
  popup.setPending(approval()); popup.statusChanged(); await settle();
  assert.equal(popup.el('approval').hidden, false);
  assert.equal(popup.el('approvalTitle').textContent, 'Example page');
  popup.setPending(approval({ id: 'approval-b', title: 'Arrived between events' })); popup.refresh(); await settle();
  assert.equal(popup.el('approvalTitle').textContent, 'Arrived between events');
});

test('older status replies cannot replace a newer pending approval', async () => {
  const popup = mount(); await settle();
  const older = deferred(), newer = deferred();
  popup.queueStatus(older.promise); popup.refresh();
  popup.queueStatus(newer.promise); popup.statusChanged();
  newer.resolve({ ...popup.state, pendingApproval: approval({ id: 'approval-new', title: 'Newest' }) }); await settle();
  assert.equal(popup.el('approvalTitle').textContent, 'Newest');
  older.resolve({ ...popup.state, pendingApproval: approval({ id: 'approval-old', title: 'Obsolete' }) }); await settle();
  assert.equal(popup.el('approvalTitle').textContent, 'Newest');
  popup.setPending(approval({ id: 'approval-new', title: 'Newest' }));
  await popup.clickApproval(true);
  assert.deepEqual(popup.messages.filter(message => message.type === 'approval_answer'), [{ type: 'approval_answer', id: 'approval-new', allowed: true }]);
});

test('closing the toolbar popup sends no answer and a reopened popup can answer the same pending request', async () => {
  const pending = approval();
  const first = mount({ pendingApproval: pending }); await settle();
  first.closePopup();
  assert.equal(first.messages.some(message => message.type === 'approval_answer'), false);
  assert.equal(first.browser.runtime.onMessage.size(), 0);
  assert.equal(first.intervalCleared(), true);
  const reopened = mount({ pendingApproval: pending }); await settle();
  assert.equal(reopened.el('approval').hidden, false);
  await reopened.clickApproval(false);
  assert.deepEqual(reopened.messages.filter(message => message.type === 'approval_answer'), [{ type: 'approval_answer', id: pending.id, allowed: false }]);
});

test('a status response started before saving cannot revert the saved rule or contaminate the next change', async () => {
  const popup = mount(); await settle();
  const oldState = structuredClone(popup.state), oldStatus = deferred();
  popup.queueStatus(oldStatus.promise); popup.refresh();
  const save = popup.changeSetting('contentMode', 'deny');
  assert.equal(popup.el('contentMode').disabled, true);
  await save;
  assert.equal(popup.el('contentMode').value, 'deny');
  assert.equal(popup.el('contentMode').disabled, false);
  oldStatus.resolve(oldState); await settle();
  assert.equal(popup.el('contentMode').value, 'deny');
  await popup.changeSetting('contentScope', 'all');
  const changes = popup.messages.filter(message => message.type === 'bridge_settings');
  assert.equal(changes.length, 2);
  assert.equal(changes[0].settings.contentMode, 'deny');
  assert.equal(changes[1].settings.contentMode, 'deny');
  assert.equal(changes[1].settings.contentScope, 'all');
});
