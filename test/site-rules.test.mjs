import test from 'node:test';
import assert from 'node:assert/strict';
import '../extension/policy.js';

const { ContentAccess, InteractionAccess, normalizeSiteRules, compileSitePattern } = globalThis.FirefoxBridgePolicy;
const rule = (type, value) => ({ type, value });
const match = (type, value, url) => compileSitePattern(rule(type, value))(new URL(url));
const event = () => { const listeners = new Set(); return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn), emit: (...args) => { for (const fn of listeners) fn(...args); } }; };
function fixture({ mode = 'deny', writeMode = 'deny', active = false, url = 'https://example.org/aaa' } = {}) {
  const tab = { id: 1, windowId: 1, url, active, discarded: false };
  let prompts = 0;
  const browser = {
    webNavigation: { onBeforeNavigate: event() },
    tabs: { onUpdated: event(), onRemoved: event(), get: async () => ({ ...tab }) },
    windows: { onFocusChanged: event(), getLastFocused: async () => ({ id: 1, type: 'normal', tabs: [{ ...tab }] }) },
  };
  const content = new ContentAccess(browser, { settings: { contentMode: mode, contentScope: 'active' }, requestApproval: async () => { prompts++; return true; } });
  const interaction = new InteractionAccess(browser, { settings: { interactionMode: writeMode, interactionScope: 'active' }, requestApproval: async () => { prompts++; return true; } });
  const apply = rules => { content.setSiteRules(rules); interaction.setSiteRules(rules); };
  return { tab, browser, content, interaction, apply, prompts: () => prompts };
}

test('domain and exact host filters have DNS-label boundaries, Unicode normalization and explicit wildcards', () => {
  for (const url of ['http://example.org/', 'https://a.b.example.org:8443/anything', 'https://EXAMPLE.ORG./']) assert.equal(match('domain', 'example.org', url), true, url);
  for (const url of ['https://notexample.org/', 'https://example.org.attacker.test/', 'https://attacker.test/?url=example.org']) assert.equal(match('domain', 'example.org', url), false, url);
  assert.equal(match('host', 'forum.example.org', 'https://forum.example.org/page'), true);
  for (const url of ['https://example.org/', 'https://other.example.org/', 'https://a.forum.example.org/']) assert.equal(match('host', 'forum.example.org', url), false);
  assert.equal(match('domain', 'bücher.example', 'https://xn--bcher-kva.example/'), true);
  assert.equal(match('host', 'shop*.example.org', 'https://shop42.example.org/'), true);
  assert.equal(match('domain', '*bank.example', 'https://login.mybank.example/'), true);
});

test('URL rules include descendants and query/ampersand suffixes but never an implicit partial path segment', () => {
  for (const url of ['https://example.org/aaa', 'http://example.org/aaa/bbb', 'https://example.org/aaa?x=1&y=2', 'https://example.org/aaa#section', 'https://example.org/aaa&x=1']) assert.equal(match('url', 'example.org/aaa', url), true, url);
  for (const url of ['https://example.org/aaabcd', 'https://sub.example.org/aaa', 'https://example.org/AAA', 'https://evil.test/example.org/aaa']) assert.equal(match('url', 'example.org/aaa', url), false, url);
  assert.equal(match('url', 'https://example.org/aaa?ignored=1', 'https://example.org/aaa?different=2'), true);
  assert.equal(match('url', 'example.org/aaa*', 'https://example.org/aaabcd'), true);
  assert.equal(match('url', 'example.org/a*/bbb', 'https://example.org/aaa/bbb/ccc'), true);
  assert.equal(match('url', '*://*.example.org/aaa', 'http://sub.example.org/aaa/bbb'), true);
  assert.equal(match('url', 'https://example.org', 'http://example.org/'), false);
  assert.equal(match('url', 'https://example.org', 'https://example.org:8443/'), false);
  assert.equal(match('url', 'http://localhost:5173', 'http://localhost:5173/path'), true);
  assert.equal(match('url', 'http://localhost:5173', 'http://localhost:5174/path'), false);
  assert.equal(match('url', 'http://localhost:*', 'http://localhost:5174/path'), true);
  assert.equal(match('url', 'http://[::1]:5173', 'http://[::1]:5173/path'), true);
});

test('invalid rules are rejected before changing a policy; duplicates normalize without widening access', () => {
  for (const entry of [rule('domain', 'https://example.org'), rule('host', 'example.org/path'), rule('host', 'example.org:80'), rule('domain', 'example.org@evil.test'), rule('url', 'https://example.org:99999/'), rule('url', 'javascript:alert(1)'), rule('unknown', 'example.org'), rule('url', ''), rule('url', 'example.org/\nsecret')]) {
    assert.throws(() => normalizeSiteRules({ blocked: [entry] }), { code: 'INVALID_SITE_RULE' });
  }
  const normalized = normalizeSiteRules({ blocked: [rule('domain', 'EXAMPLE.ORG'), rule('domain', 'example.org')] });
  assert.deepEqual(normalized.blocked, [rule('domain', 'example.org')]);
  assert.throws(() => normalizeSiteRules({ blocked: new Array(201).fill(rule('domain', 'example.org')) }), { code: 'INVALID_SITE_RULE' });
  const f = fixture(); f.apply({ blocked: [rule('domain', 'example.org')] });
  assert.throws(() => f.content.setSiteRules({ blocked: [rule('domain', 'bad/path')] }), { code: 'INVALID_SITE_RULE' });
  assert.equal(f.content.siteAccess(f.tab.url), 'blocked');
});

test('URL path encoding compares spaces and UTF-8 in both directions without decoding structural separators', () => {
  for (const path of ['/Meine Datei', '/Meine%20Datei']) {
    for (const target of ['/Meine Datei', '/Meine%20Datei', '/Meine%20Datei/Unterordner', '/Meine%20Datei?x=1']) assert.equal(match('url', 'example.org' + path, 'https://example.org' + target), true, `${path} -> ${target}`);
    assert.equal(match('url', 'example.org' + path, 'https://example.org/Meine%20DateiAnders'), false);
  }
  for (const path of ['/Grüße', '/Gr%C3%BC%C3%9Fe', '/Gr%c3%bc%c3%9fe']) {
    for (const target of ['/Grüße', '/Gr%C3%BC%C3%9Fe', '/Gr%c3%bc%c3%9fe']) assert.equal(match('url', 'example.org' + path, 'https://example.org' + target), true);
  }
  assert.equal(match('url', 'example.org/Datei ', 'https://example.org/Datei%20'), true, 'trailing path space is meaningful');
  assert.equal(match('url', 'example.org/Datei%20', 'https://example.org/Datei'), false);
  assert.equal(match('url', 'example.org/%61aa', 'https://example.org/aaa'), true);
  assert.equal(match('url', 'example.org/aaa', 'https://example.org/%61aa'), true);
  assert.equal(match('url', 'example.org/aaa', 'https://example.org/aaa%2Fbbb'), false);
  assert.equal(match('url', 'example.org/aaa', 'https://example.org/aaa%26bbb'), false);
  assert.equal(match('url', 'example.org/a%2fb', 'https://example.org/a%2Fb'), true);
  assert.equal(match('url', 'example.org/a%2Fb', 'https://example.org/a/b'), false);
  assert.equal(match('url', 'example.org/Meine Datei', 'https://example.org/Meine+Datei'), false);
  assert.equal(match('url', 'example.org/Meine%2520Datei', 'https://example.org/Meine%20Datei'), false);
  assert.equal(match('url', 'example.org/a%2Ab', 'https://example.org/a*b'), true);
  assert.equal(match('url', 'example.org/a%2Ab', 'https://example.org/aANYb'), false);
  assert.equal(match('url', 'example.org/a*b', 'https://example.org/a%2Ab'), true);
  const normalized = normalizeSiteRules({ readOnly: [rule('url', 'example.org/Meine Datei'), rule('url', 'example.org/Meine%20Datei')] });
  assert.equal(normalized.readOnly.length, 1);
});

test('block rules override both permanent exceptions and existing grants without asking', async () => {
  const f = fixture({ mode: 'allow', writeMode: 'ask-every-time', active: true });
  f.apply({ blocked: [rule('domain', 'example.org')], readOnly: [rule('host', 'example.org')], fullAccess: [rule('url', 'example.org/aaa')] });
  for (const policy of [f.content, f.interaction]) await assert.rejects(policy.authorize(f.tab), { code: 'SITE_BLOCKED' });
  assert.equal(f.prompts(), 0);
  f.apply({ fullAccess: [rule('domain', 'example.org')] });
  const authorization = {}, revision = f.content.revision;
  await f.content.authorize(f.tab, authorization);
  f.apply({ blocked: [rule('domain', 'example.org')] });
  await assert.rejects(f.content.assertAfterRead(1, f.tab.url, revision, authorization), { code: 'PERMISSION_CHANGED' });
});

test('read exception bypasses denial, scope and expiry; writes still use normal permissions', async () => {
  const f = fixture(); f.apply({ readOnly: [rule('domain', 'example.org')] });
  const authorization = {};
  await f.content.authorize(f.tab, authorization);
  await f.content.assertAfterRead(1, f.tab.url, f.content.revision, authorization);
  await assert.rejects(f.interaction.authorize(f.tab), { code: 'CONTENT_DENIED' });
  assert.equal(f.prompts(), 0);
  f.interaction.setSettings({ interactionMode: 'ask-every-time', interactionScope: 'all' });
  await f.interaction.authorize(f.tab);
  assert.equal(f.prompts(), 1);
  f.content.resetApprovals();
  await f.content.authorize(f.tab);
  assert.equal(f.prompts(), 1, 'resetting temporary grants does not remove a permanent rule');
});

test('full exception overrides both deny modes and wins over read-only exceptions, but MCP off still wins', async () => {
  const f = fixture(); f.apply({ readOnly: [rule('domain', 'example.org')], fullAccess: [rule('url', 'example.org/aaa')] });
  for (const policy of [f.content, f.interaction]) {
    const authorization = {}; await policy.authorize(f.tab, authorization);
    await policy.assertAfterRead(1, f.tab.url, policy.revision, authorization);
  }
  assert.equal(f.prompts(), 0);
  f.content.setSettings({ enabled: false });
  await assert.rejects(f.content.authorize(f.tab), { code: 'MCP_DISABLED' });
});

test('navigation invalidates permanent authorizations and corrupt stored filters fail closed', async () => {
  const f = fixture(); f.apply({ readOnly: [rule('domain', 'example.org')] });
  const authorization = {}, revision = f.content.revision;
  await f.content.authorize(f.tab, authorization);
  f.tab.url = 'https://other.test/'; f.browser.tabs.onUpdated.emit(1, { url: f.tab.url });
  await assert.rejects(f.content.assertAfterRead(1, 'https://example.org/aaa', revision, authorization), { code: 'PAGE_CHANGED' });
  await assert.rejects(f.content.authorize(f.tab), { code: 'CONTENT_DENIED' });
  f.content.failSiteRules();
  await assert.rejects(f.content.authorize(f.tab), { code: 'SITE_RULES_UNAVAILABLE' });
  f.content.setSiteRules({});
  await assert.rejects(f.content.authorize(f.tab), { code: 'CONTENT_DENIED' });
});

test('exports reject blocked embedded documents and fail closed if frame metadata is unavailable', async () => {
  const f = fixture({ mode: 'allow', active: true }); f.apply({ blocked: [rule('domain', 'secret.test')] });
  await assert.rejects(f.content.assertExportFrames(1), { code: 'FRAME_POLICY_UNAVAILABLE' });
  let frames = [{ frameId: 0, url: f.tab.url }, { frameId: 1, url: 'https://secret.test/account' }];
  f.browser.webNavigation.getAllFrames = async () => frames;
  await assert.rejects(f.content.assertExportFrames(1), { code: 'SITE_BLOCKED' });
  frames = [{ frameId: 0, url: f.tab.url }, { frameId: 1, url: 'https://allowed.test/' }];
  await f.content.assertExportFrames(1);
  const revision = f.content.frameRevisions.get(1) || 0;
  f.browser.webNavigation.onBeforeNavigate.emit({ tabId: 1, frameId: 1, url: 'https://secret.test/' });
  f.browser.webNavigation.onBeforeNavigate.emit({ tabId: 1, frameId: 1, url: 'https://allowed.test/' });
  await assert.rejects(f.content.assertExportFrames(1, revision), { code: 'PAGE_CHANGED' });
});
