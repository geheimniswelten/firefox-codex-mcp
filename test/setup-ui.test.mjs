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
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
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
async function mount(initial = state(), clipboard) {
  const window = new Window({ url: 'moz-extension://bridge/setup/setup.html', settings: { enableJavaScriptEvaluation: false, disableCSSFileLoading: true, disableJavaScriptFileLoading: true } });
  window.document.write(html);
  const messages = [], responses = [];
  let current = structuredClone(initial), interval, cleared = false;
  const browser = { runtime: {
    getURL: file => `moz-extension://bridge/${file}`, onMessage: event(),
    async sendMessage(message) { messages.push(structuredClone(message)); return structuredClone(responses.length ? await responses.shift() : current); },
  } };
  vm.runInContext(source, vm.createContext({ browser, window, document: window.document, navigator: { clipboard }, setInterval: fn => { interval = fn; return 1; }, clearInterval() { cleared = true; } }));
  await settle();
  return {
    window, browser, messages, el: id => window.document.getElementById(id),
    setState(value) { current = structuredClone(value); }, queueResponse(value) { responses.push(value); }, refresh() { return interval(); },
    select(platform) { const select = window.document.getElementById('platform'); select.value = platform; select.dispatchEvent(new window.Event('change')); },
    close() { window.dispatchEvent(new window.Event('unload')); }, cleared: () => cleared,
  };
}

test('options page opens in its own tab without browser styles or new download/clipboard permissions', () => {
  const manifest = JSON.parse(manifestText);
  assert.deepEqual(manifest.options_ui, { page: 'setup/setup.html', open_in_tab: true, browser_style: false });
  assert.equal(manifest.permissions.includes('downloads'), false);
  assert.equal(manifest.permissions.includes('clipboardRead'), false);
  assert.equal(manifest.permissions.includes('clipboardWrite'), false);
  assert.equal(manifest.name, 'Codex MCP for Firefox');
});

test('all platform downloads point directly to packaged scripts and name the required runtime', async () => {
  for (const platform of ['win', 'linux', 'mac']) {
    const f = await mount(state(platform));
    assert.equal(f.el('platform').value, platform);
    const extension = platform === 'win' ? 'ps1' : 'sh';
    for (const [id, script] of [['registerDownload', 'register'], ['unregisterDownload', 'unregister']]) {
      assert.equal(f.el(id).href, `moz-extension://bridge/setup/${script}.${extension}`);
      assert.equal(f.el(id).download, `${script}.${extension}`);
      assert.equal(f.el(id).getAttribute('aria-disabled'), 'false');
    }
    assert.match(f.el('platformNote').textContent, platform === 'win' ? /Node.*automatisch/u : /Node\.js 22.*sh register\.sh/u);
    assert.equal(f.el('windowsInstructions').hidden, platform !== 'win');
    assert.equal(f.el('commandInstructions').hidden, false);
    for (const [id, script] of [['registerCommand', 'register'], ['unregisterCommand', 'unregister']]) {
      assert.equal(f.el(id).readOnly, true);
      assert.equal(f.el(id).value, platform === 'win'
        ? 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\\' + script + '.ps1' : 'sh ' + script + '.sh');
    }
    assert.deepEqual(f.messages, [{ type: 'bridge_status' }]);
    f.close();
  }
});

test('unknown platform needs an explicit choice and manual selection survives status refresh', async () => {
  const f = await mount(state(null));
  assert.equal(f.el('registerDownload').hasAttribute('href'), false);
  assert.equal(f.el('registerDownload').getAttribute('aria-disabled'), 'true');
  assert.equal(f.el('commandInstructions').hidden, true);
  f.select('mac');
  assert.equal(f.el('registerDownload').download, 'register.sh');
  f.setState(state('win')); await f.refresh();
  assert.equal(f.el('platform').value, 'mac');
  assert.match(f.el('registerDownload').href, /register\.sh$/u);
  f.select(''); assert.equal(f.el('registerDownload').hasAttribute('href'), false);
  assert.equal(f.el('commandInstructions').hidden, true);
  assert.equal(f.el('registerCommand').value, '');
  f.close();
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
