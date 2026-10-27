import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { Window } from 'happy-dom';

const html = await readFile(new URL('../extension/site-rules.html', import.meta.url), 'utf8');
const source = await readFile(new URL('../extension/site-rules.js', import.meta.url), 'utf8');
test('popup and site-rule local resources exist in the extension', async () => {
  for (const page of ['popup.html', 'site-rules.html']) {
    const markup = await readFile(new URL(`../extension/${page}`, import.meta.url), 'utf8');
    for (const match of markup.matchAll(/(?:src|href)="([^"#]+)"/gu)) {
      if (!/^[a-z]+:/iu.test(match[1])) await readFile(new URL(`../extension/${match[1]}`, import.meta.url));
    }
  }
});
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
async function mount(t) {
  const window = new Window({ settings: { enableJavaScriptEvaluation: false, disableCSSFileLoading: true, disableJavaScriptFileLoading: true } });
  t.after(() => window.close()); window.document.write(html);
  const state = { siteRulesRevision: 4, siteRules: { blocked: [{ type: 'domain', value: 'private.test' }], readOnly: [], fullAccess: [] } };
  const calls = []; let fail = false;
  vm.runInContext(source, vm.createContext({ window, document: window.document, browser: { runtime: { async sendMessage(message) {
    calls.push(structuredClone(message));
    if (message.type === 'bridge_site_rules') {
      if (fail) throw new Error('Die Seitenfilter wurden inzwischen geändert.');
      state.siteRules = message.siteRules; state.siteRulesRevision++;
    }
    return structuredClone(state);
  } } } }));
  await settle();
  return { window, calls, state, el: id => window.document.getElementById(id), fail: () => { fail = true; }, async save() { window.document.getElementById('rulesForm').dispatchEvent(new window.Event('submit', { cancelable: true })); await settle(); } };
}
test('site rules load and save all three lists with the loaded revision', async t => {
  const f = await mount(t);
  assert.equal(f.el('blocked').value, 'domain private.test');
  f.el('readOnly').value = 'host www.example.test\n\nurl https://example.test/docs';
  f.el('fullAccess').value = 'domain trusted.test';
  await f.save();
  assert.deepEqual(f.calls[1], { type: 'bridge_site_rules', revision: 4, siteRules: { blocked: [{ type: 'domain', value: 'private.test' }], readOnly: [{ type: 'host', value: 'www.example.test' }, { type: 'url', value: 'https://example.test/docs' }], fullAccess: [{ type: 'domain', value: 'trusted.test' }] } });
  assert.match(f.el('status').textContent, /gespeichert/u);
  await f.save(); assert.equal(f.calls[2].revision, 5);
});
test('invalid lines and rejected stale writes preserve edits and show errors', async t => {
  const f = await mount(t);
  f.el('blocked').value = 'example.test'; await f.save();
  assert.equal(f.calls.length, 1); assert.match(f.el('error').textContent, /Zeile 1/u);
  f.el('blocked').value = 'domain changed.test'; f.fail(); await f.save();
  assert.equal(f.el('blocked').value, 'domain changed.test');
  assert.equal(f.el('error').hidden, false); assert.match(f.el('error').textContent, /inzwischen geändert/u);
  assert.equal(f.el('save').disabled, false);
});
test('reloading edited rules requires confirmation and cancelled reload keeps edits', async t => {
  const f = await mount(t);
  f.el('blocked').value = 'domain changed.test'; f.el('blocked').dispatchEvent(new f.window.Event('input'));
  f.window.confirm = () => false; f.el('reload').click(); await settle();
  assert.equal(f.calls.length, 1); assert.equal(f.el('blocked').value, 'domain changed.test');
  f.window.confirm = () => true; f.el('reload').click(); await settle();
  assert.equal(f.calls.length, 2); assert.equal(f.el('blocked').value, 'domain private.test');
});
