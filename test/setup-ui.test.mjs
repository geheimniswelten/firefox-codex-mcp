import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { Window } from 'happy-dom';

const [html, source, manifestText] = await Promise.all([
  readFile(new URL('../extension/setup/setup.html', import.meta.url), 'utf8'),
  readFile(new URL('../extension/setup/setup.js', import.meta.url), 'utf8'),
  readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'),
]);
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
function deferred() { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
function event() {
  const listeners = new Set();
  return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn), emit: (...args) => [...listeners].map(fn => fn(...args)), size: () => listeners.size };
}
function state(platform = 'linux') {
  return { version: '1.0.2', connected: true, connecting: false, lastError: null, settings: { enabled: true }, setup: {
    status: 'ready', label: 'Registrierung bestätigt', description: 'Der Native Host bestätigt eine passende Registrierungsrevision.', platform, requiredRevision: 1,
    hostVersion: '1.0.2', registration: { registrationRevision: 1, installerVersion: '1.0.2', registeredAt: '2026-10-01T12:00:00.000Z', platform, manifestPath: '/example/manifest.json' }, lastConfirmation: null,
  } };
}
async function mount(initial = state(), clipboard, download = async () => 1) {
  const window = new Window({ url: 'moz-extension://bridge/setup/setup.html', settings: { enableJavaScriptEvaluation: false, disableCSSFileLoading: true, disableJavaScriptFileLoading: true } });
  window.document.write(html);
  const messages = [], responses = [], downloads = [];
  let current = structuredClone(initial), interval, cleared = false;
  const browser = { downloads: { async download(options) { downloads.push(structuredClone(options)); return download(options); } }, runtime: {
    getURL: file => `moz-extension://bridge/${file}`, onMessage: event(),
    async sendMessage(message) { messages.push(structuredClone(message)); return structuredClone(responses.length ? await responses.shift() : current); },
  } };
  vm.runInContext(source, vm.createContext({ browser, window, document: window.document, navigator: { clipboard }, setInterval: fn => { interval = fn; return 1; }, clearInterval() { cleared = true; } }));
  await settle();
  return {
    window, browser, messages, downloads, el: id => window.document.getElementById(id),
    setState(value) { current = structuredClone(value); }, queueResponse(value) { responses.push(value); }, refresh() { return interval(); },
    select(platform) { const select = window.document.getElementById('platform'); select.value = platform; select.dispatchEvent(new window.Event('change')); },
    close() { window.dispatchEvent(new window.Event('unload')); }, cleared: () => cleared,
  };
}

test('options page requests the download API permission and opens in its own tab without clipboard permissions', () => {
  const manifest = JSON.parse(manifestText);
  assert.deepEqual(manifest.options_ui, { page: 'setup/setup.html', open_in_tab: true, browser_style: false });
  assert.equal(manifest.permissions.includes('downloads'), true);
  assert.equal(manifest.permissions.includes('downloads.open'), false);
  assert.equal(manifest.permissions.includes('clipboardRead'), false);
  assert.equal(manifest.permissions.includes('clipboardWrite'), false);
  assert.equal(manifest.name, 'Codex MCP for Firefox');
});

test('all platforms download packaged scripts only after clicking and open a save dialog with the right filename', async () => {
  for (const platform of ['win', 'linux', 'mac']) {
    const f = await mount(state(platform));
    assert.equal(f.el('platform').value, platform);
    const extension = platform === 'win' ? 'ps1' : 'sh';
    await f.refresh();
    assert.deepEqual(f.downloads, [], 'loading and status refresh must not start downloads');
    for (const [id, script] of [['registerDownload', 'register'], ['unregisterDownload', 'unregister']]) {
      assert.equal(f.el(id).tagName, 'BUTTON');
      assert.equal(f.el(id).disabled, false);
      assert.equal(f.el(id).getAttribute('aria-disabled'), 'false');
      f.el(id).click(); await settle();
      assert.deepEqual(f.downloads.at(-1), { url: `moz-extension://bridge/setup/${script}.${extension}`, filename: `${script}.${extension}`, saveAs: true });
      assert.match(f.el('downloadStatus').textContent, new RegExp(`Download für ${script}\\.${extension} gestartet`, 'u'));
      assert.equal(f.el(id).disabled, false);
    }
    assert.equal(f.downloads.length, 2);
    assert.match(f.el('platformNote').textContent, platform === 'win' ? /Node.*automatisch/u : /Node\.js 22.*sh register\.sh/u);
    assert.equal(f.el('windowsInstructions').hidden, platform !== 'win');
    assert.equal(f.el('commandInstructions').hidden, false);
    for (const [id, script] of [['registerCommand', 'register'], ['unregisterCommand', 'unregister']]) {
      assert.equal(f.el(id).readOnly, true);
      assert.equal(f.el(id).value, platform === 'win'
        ? 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\\' + script + '.ps1' : 'sh ' + script + '.sh');
    }
    assert.deepEqual(f.messages, [{ type: 'bridge_status' }, { type: 'bridge_status' }]);
    f.close();
  }
});

test('unknown platform needs an explicit choice and manual selection survives status refresh', async () => {
  const f = await mount(state(null));
  assert.equal(f.el('registerDownload').disabled, true);
  assert.equal(f.el('registerDownload').getAttribute('aria-disabled'), 'true');
  f.el('registerDownload').click(); await settle();
  assert.deepEqual(f.downloads, []);
  assert.equal(f.el('commandInstructions').hidden, true);
  f.select('mac');
  assert.equal(f.el('registerDownload').disabled, false);
  f.setState(state('win')); await f.refresh();
  assert.equal(f.el('platform').value, 'mac');
  f.el('registerDownload').click(); await settle();
  assert.equal(f.downloads[0].filename, 'register.sh');
  f.select(''); assert.equal(f.el('registerDownload').disabled, true);
  assert.equal(f.el('commandInstructions').hidden, true);
  assert.equal(f.el('registerCommand').value, '');
  f.close();
});

test('pending save dialogs reject duplicate clicks and status refresh preserves the busy controls', async () => {
  const pending = deferred(), f = await mount(state('win'), undefined, () => pending.promise);
  f.el('registerDownload').click();
  f.el('registerDownload').click(); f.el('unregisterDownload').click();
  await f.refresh();
  for (const id of ['registerDownload', 'unregisterDownload']) {
    assert.equal(f.el(id).disabled, true);
    assert.equal(f.el(id).getAttribute('aria-disabled'), 'true');
  }
  assert.equal(f.downloads.length, 1);
  assert.match(f.el('downloadStatus').textContent, /Speicherdialog.*register\.ps1/u);
  f.select('mac');
  pending.resolve(42); await settle();
  assert.match(f.el('downloadStatus').textContent, /Download für register\.ps1 gestartet/u);
  assert.equal(f.el('registerDownload').disabled, false);
  f.el('unregisterDownload').click(); await settle();
  assert.equal(f.downloads[1].filename, 'unregister.sh');
  f.close();
});

test('download rejection is shown literally and both controls recover for retry', async () => {
  for (const id of ['registerDownload', 'unregisterDownload']) {
    const pending = deferred(); let calls = 0;
    const f = await mount(state('win'), undefined, () => ++calls === 1 ? pending.promise : 99);
    f.el(id).click();
    pending.reject(new Error('<img src=x onerror=alert(1)>')); await settle();
    assert.match(f.el('downloadStatus').textContent, /konnte nicht gespeichert werden.*<img/u);
    assert.equal(f.el('downloadStatus').className, 'error');
    assert.equal(f.window.document.querySelectorAll('img').length, 1);
    for (const downloadId of ['registerDownload', 'unregisterDownload']) assert.equal(f.el(downloadId).disabled, false);
    await f.refresh();
    assert.match(f.el('downloadStatus').textContent, /konnte nicht gespeichert werden/u);
    f.el(id).click(); await settle();
    assert.equal(f.downloads.length, 2);
    assert.match(f.el('downloadStatus').textContent, /Download.*gestartet/u);
    assert.equal(f.el('downloadStatus').className, 'note');
    f.close();
  }
});

test('copy buttons write only the chosen command after a click on all supported platforms', async () => {
  for (const platform of ['win', 'linux', 'mac']) {
    const copied = [], f = await mount(state(platform), { async writeText(value) { copied.push(value); } });
    await f.refresh();
    assert.deepEqual(copied, [], 'loading and status refresh must not write to the clipboard');
    f.el('copyRegisterCommand').click(); await settle();
    assert.deepEqual(copied, [f.el('registerCommand').value]);
    assert.equal(f.el('copyStatus').textContent, 'Registrierungsbefehl kopiert.');
    f.el('copyUnregisterCommand').click(); await settle();
    assert.deepEqual(copied, [f.el('registerCommand').value, f.el('unregisterCommand').value]);
    assert.equal(f.el('copyStatus').textContent, 'Deregistrierungsbefehl kopiert.');
    f.close();
  }
});

test('unavailable or rejected clipboard access selects the command for manual copying', async () => {
  for (const clipboard of [undefined, { async writeText() { throw new Error('Clipboard denied'); } }]) {
    const f = await mount(state('win'), clipboard), field = f.el('registerCommand');
    f.el('copyRegisterCommand').click(); await settle();
    assert.equal(f.window.document.activeElement, field);
    assert.equal(field.selectionStart, 0);
    assert.equal(field.selectionEnd, field.value.length);
    assert.match(f.el('copyStatus').textContent, /markiert.*Strg\+C/u);
    await f.refresh();
    assert.equal(field.selectionStart, 0);
    assert.equal(field.selectionEnd, field.value.length, 'periodic status refresh must preserve the selection');
    f.close();
  }
});

test('platform changes invalidate pending copy feedback and use the newly displayed command', async () => {
  const copied = [], pending = deferred();
  const f = await mount(state('win'), { async writeText(value) { copied.push(value); if (copied.length === 1) await pending.promise; } });
  f.el('copyRegisterCommand').click();
  f.select('linux');
  pending.resolve(); await settle();
  assert.equal(f.el('copyStatus').textContent, '');
  f.el('copyRegisterCommand').click(); await settle();
  assert.equal(copied.length, 2);
  assert.equal(copied[1], 'sh register.sh');
  assert.equal(f.el('copyStatus').textContent, 'Registrierungsbefehl kopiert.');
  f.close();
});

test('current receipt and historical confirmation remain separate during connection failure', async () => {
  const value = state();
  value.connected = false; value.lastError = 'Port is occupied';
  value.setup = { ...value.setup, status: 'connection_error', label: 'Verbindung gestört', registration: null, hostVersion: null,
    lastConfirmation: { ...state().setup, verifiedAt: '2026-10-02T12:00:00.000Z' } };
  const f = await mount(value);
  assert.equal(f.el('currentRevision').textContent, 'Noch nicht bestätigt');
  assert.equal(f.el('hostVersion').textContent, 'Noch nicht bestätigt');
  assert.match(f.el('lastConfirmed').textContent, /Revision 1.*Server 1\.0\.2/u);
  assert.equal(f.el('error').textContent, 'Port is occupied');
  assert.equal(f.el('error').hidden, false);
  assert.doesNotMatch(f.el('connection').textContent, /nicht registriert/u);
  f.close();
});

test('late status replies cannot replace a newer unverified registration state', async () => {
  const f = await mount(), old = deferred();
  f.queueResponse(old.promise); const stale = f.refresh();
  const next = state(); next.setup = { ...next.setup, status: 'unverified', label: 'Registrierung noch nicht bestätigt', registration: null, hostVersion: null };
  f.setState(next); await f.refresh();
  old.resolve(state()); await stale;
  assert.equal(f.el('statusTitle').textContent, next.setup.label);
  assert.equal(f.el('currentRevision').textContent, 'Noch nicht bestätigt');
  f.close();
});

test('recheck reconnects once and disabled MCP does not expose a runnable check control', async () => {
  const f = await mount(), pending = deferred();
  f.queueResponse(pending.promise);
  f.el('checkSetup').click(); f.el('checkSetup').click(); await settle();
  assert.equal(f.messages.filter(message => message.type === 'bridge_reconnect').length, 1);
  assert.equal(f.el('checkSetup').disabled, true);
  pending.resolve(state()); await settle();
  assert.equal(f.el('checkSetup').disabled, false);
  const disabled = state(); disabled.settings.enabled = false; disabled.setup.status = 'disabled';
  f.setState(disabled); await f.refresh();
  assert.equal(f.el('checkSetup').disabled, true);
  f.el('checkSetup').click();
  assert.equal(f.messages.filter(message => message.type === 'bridge_reconnect').length, 1);
  f.close();
  assert.equal(f.cleared(), true);
  assert.equal(f.browser.runtime.onMessage.size(), 0);
});

test('host-controlled versions, paths and errors render literally without inserting markup', async () => {
  const value = state(), injected = '<img src=x onerror=alert(1)>';
  value.lastError = injected; value.setup.hostVersion = injected; value.setup.registration.manifestPath = injected;
  const f = await mount(value);
  assert.equal(f.el('hostVersion').textContent, injected);
  assert.equal(f.el('manifestPath').textContent, injected);
  assert.equal(f.el('error').textContent, injected);
  assert.equal(f.window.document.querySelectorAll('img').length, 1, 'only the packaged header icon may be present');
  f.close();
});

test('status polling and pushes preserve selected setup text while other status fields keep updating', async t => {
  const value = state('win'); value.lastError = 'No such native application de.codex.firefox_bridge';
  value.setup.lastConfirmation = { ...structuredClone(value.setup), verifiedAt: '2026-10-02T12:00:00.000Z' };
  const f = await mount(value); t.after(() => f.close());
  const selection = f.window.getSelection();
  for (const id of ['statusTitle', 'statusDescription', 'connection', 'addonVersion', 'hostVersion', 'requiredRevision', 'currentRevision', 'installerVersion', 'registeredAt', 'lastConfirmed', 'manifestPath', 'error', 'registerDownload', 'commandIntro', 'platformNote']) {
    const node = f.el(id).firstChild, range = f.window.document.createRange();
    assert.ok(node?.textContent, `${id} should contain selectable text`);
    range.setStart(node, 0); range.setEnd(node, Math.min(12, node.textContent.length));
    selection.removeAllRanges(); selection.addRange(range);
    const selected = selection.toString();
    await f.refresh(); f.browser.runtime.onMessage.emit({ type: 'bridge_status_changed' }); await settle();
    assert.equal(f.el(id).firstChild, node, `${id}: unchanged polling must keep the selected text node`);
    assert.equal(range.startContainer, node);
    assert.equal(range.endContainer, node);
    assert.equal(selection.toString(), selected);
  }
  const node = f.el('manifestPath').firstChild, range = f.window.document.createRange();
  range.selectNodeContents(node); selection.removeAllRanges(); selection.addRange(range);
  const selected = selection.toString(), changed = structuredClone(value);
  changed.connected = false; changed.setup.status = 'update_required'; changed.setup.label = 'Aktualisierung erforderlich';
  f.setState(changed); await f.refresh();
  assert.equal(f.el('statusTitle').textContent, changed.setup.label);
  assert.match(f.el('connection').textContent, /derzeit nicht verfügbar/u);
  assert.equal(f.el('registerDownload').textContent, 'Aktualisierungsskript speichern');
  assert.equal(f.el('manifestPath').firstChild, node);
  assert.equal(selection.toString(), selected, 'changes elsewhere must not clear selected manifest text');
  changed.lastError = 'Neue Verbindungsdiagnose'; changed.setup.registration.manifestPath = 'C:\\Tools\\manifest.json';
  f.setState(changed); await f.refresh();
  assert.equal(f.el('error').textContent, changed.lastError);
  assert.equal(f.el('manifestPath').textContent, changed.setup.registration.manifestPath);
});
