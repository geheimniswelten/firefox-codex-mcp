import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { Window } from 'happy-dom';

const [html, source] = await Promise.all([
  readFile(new URL('../extension/popup.html', import.meta.url), 'utf8'),
  readFile(new URL('../extension/popup.js', import.meta.url), 'utf8'),
]);
const settle = async () => { for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve)); };
function event() {
  const listeners = new Set();
  return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn), emit: value => [...listeners].forEach(fn => fn(value)) };
}
async function mount({ approval = null, permissionError = null } = {}) {
  const window = new Window({ url: 'moz-extension://bridge/popup.html', settings: { enableJavaScriptEvaluation: false, disableCSSFileLoading: true, disableJavaScriptFileLoading: true } });
  window.document.write(html);
  const state = {
    settings: { enabled: true, contentMode: 'ask-session', contentScope: 'active' },
    icon: { color: 'green', label: 'Verbunden' }, connected: true, connecting: false,
    setup: { label: 'Registrierung bestätigt', actionLabel: 'Einrichtung' },
    sessionExpiresAt: Date.now() + 60000, lastAccessAt: Date.now(),
    lastError: 'Diagnose zum Kopieren', version: '1.0.6', pendingApproval: approval,
  };
  let interval, now = Date.now(), statusError = null;
  const browser = {
    runtime: {
      onMessage: event(),
      async sendMessage() { if (statusError) throw new Error(statusError); return structuredClone(state); },
    },
    permissions: {
      onAdded: event(), onRemoved: event(),
      async getAll() { if (permissionError) throw new Error(permissionError); return { data_collection: [] }; },
    },
  };
  class ClockDate extends Date { static now() { return now; } }
  vm.runInContext(source, vm.createContext({
    browser, window, document: window.document, Date: ClockDate,
    setInterval(fn, delay) { assert.equal(delay, 1500); interval = fn; return 1; }, clearInterval() {},
  }));
  await settle();
  return {
    window, state, el: id => window.document.getElementById(id),
    async refresh() { interval(); await settle(); },
    async statusChanged() { browser.runtime.onMessage.emit({ type: 'bridge_status_changed' }); await settle(); },
    advanceTime(milliseconds) { now += milliseconds; },
    failStatus(message) { statusError = message; },
    close() { window.dispatchEvent(new window.Event('unload')); window.close(); },
  };
}
function select(f, id) {
  const node = f.el(id).firstChild, range = f.window.document.createRange();
  assert.ok(node?.textContent, `${id} must have selectable text`);
  range.setStart(node, 0); range.setEnd(node, Math.min(node.textContent.length, 12));
  const selection = f.window.getSelection();
  selection.removeAllRanges(); selection.addRange(range);
  return { id, node, range, selection, text: selection.toString() };
}
function assertSelection(f, before) {
  assert.equal(f.el(before.id).firstChild, before.node, `${before.id}: an unchanged refresh must retain the selected text node`);
  assert.equal(before.range.startContainer, before.node);
  assert.equal(before.range.endContainer, before.node);
  assert.equal(before.selection.toString(), before.text);
}

test('polling and background status pushes preserve selectable popup text and its range', async t => {
  const f = await mount(); t.after(() => f.close());
  for (const id of ['status', 'detail', 'setupNotice', 'openSetup', 'lastAccess', 'toggle', 'session', 'error', 'version']) {
    const before = select(f, id);
    await f.refresh(); await f.statusChanged(); await f.refresh();
    assertSelection(f, before);
  }
  const before = select(f, 'setupNotice');
  f.state.connected = false; f.state.icon = { color: 'gray', label: 'Getrennt' };
  await f.statusChanged();
  assert.equal(f.el('status').textContent, 'Getrennt');
  assert.match(f.el('detail').textContent, /derzeit nicht verfügbar/u);
  assert.equal(f.el('dot').className, 'dot gray');
  assertSelection(f, before);
  f.advanceTime(60001); await f.refresh();
  assert.equal(f.el('session').textContent, 'Noch keine aktive Sitzungsfreigabe.');
  assertSelection(f, before);
});

test('unchanged exact-tab approval descriptions retain selection while new requests and expiry update immediately', async t => {
  const approval = { id: 'first', title: '<b>Seite</b>', url: 'https://example.test/?a=<script>', mode: 'ask-five-days', scope: 'tab', expiresAt: Date.now() + 120000 };
  const f = await mount({ approval }); t.after(() => f.close());
  assert.equal(f.window.document.activeElement, f.el('approvalDeny'));
  assert.equal(f.el('approvalTitle').querySelector('b'), null);
  for (const id of ['approvalTitle', 'approvalUrl', 'approvalDescription']) {
    const before = select(f, id);
    await f.refresh(); await f.statusChanged();
    assertSelection(f, before);
  }
  assert.match(f.el('approvalDescription').textContent, /Andere Tabs.*gebunden.*widerruft/u);
  f.el('approvalAllow').focus();
  const before = select(f, 'approvalDescription');
  await f.refresh();
  assert.equal(f.window.document.activeElement, f.el('approvalAllow'), 'polling must not steal focus');
  assertSelection(f, before);
  f.advanceTime(120001); await f.refresh();
  assert.equal(f.el('approvalAllow').disabled, true);
  assert.equal(f.el('approvalDeny').disabled, true);
  assertSelection(f, before);
  f.state.pendingApproval = { ...approval, id: 'replacement', title: 'Neue Seite', scope: 'all', expiresAt: Date.now() + 300000 };
  await f.statusChanged();
  assert.equal(f.el('approvalTitle').textContent, 'Neue Seite');
  assert.match(f.el('approvalDescription').textContent, /alle Tabs/u);
  assert.doesNotMatch(f.el('approvalDescription').textContent, /Andere Tabs|gebunden/u);
  assert.equal(f.el('approvalAllow').disabled, false);
  assert.equal(f.window.document.activeElement, f.el('approvalDeny'), 'a new approval still receives its initial keyboard focus');
});

test('repeated polling failures leave selected diagnostic text intact and display changed failures', async t => {
  const f = await mount({ permissionError: 'Fehler beim Prüfen der Berechtigung' }); t.after(() => f.close());
  const inventory = select(f, 'inventoryError');
  await f.refresh(); await f.refresh();
  assertSelection(f, inventory);
  f.failStatus('Host nicht gefunden'); await f.refresh();
  const diagnostic = select(f, 'error');
  await f.refresh(); await f.statusChanged();
  assertSelection(f, diagnostic);
  f.failStatus('Neue Host-Diagnose'); await f.refresh();
  assert.equal(f.el('error').hidden, false);
  assert.equal(f.el('error').textContent, 'Neue Host-Diagnose');
});
