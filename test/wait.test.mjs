import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import '../extension/wait.js';
import '../extension/policy.js';

const { validate, waitFor } = globalThis.FirefoxBridgeWait;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function event() {
  const listeners = new Set();
  return { listeners, addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn), emit: (...args) => [...listeners].forEach(fn => fn(...args)) };
}
function element({ visible = true, width = 20, height = 10, fontFamily = 'sans-serif', text = 'Fixture' } = {}) {
  return {
    visible, width, height, fontFamily, visibilityOptions: [], childNodes: [{ nodeType: 3, nodeValue: text }],
    checkVisibility(options) { this.visibilityOptions.push(JSON.parse(JSON.stringify(options))); return this.visible; },
    getClientRects() { return [{ width: this.width, height: this.height }]; }
  };
}
function fakeBrowser({ url = 'https://example.test/', status = 'complete', discarded = false } = {}) {
  const target = element();
  const fonts = { status: 'loaded', ready: Promise.resolve(), faces: [], [Symbol.iterator]() { return this.faces[Symbol.iterator](); } };
  const state = { target, selectors: { '#target': [target] }, elements: [target], images: [], fonts, trace: [], documentReads: 0, locationOverride: null };
  const tab = { id: 1, url, status, discarded };
  const browser = {
    tab, state,
    tabs: {
      onUpdated: event(), onRemoved: event(),
      async get(id) { state.trace.push('get'); assert.equal(id, 1); return state.getHook ? state.getHook() : structuredClone(tab); },
      async executeScript(id, options) {
        state.trace.push('probe'); assert.equal(id, 1);
        assert.equal(options.frameId, 0); assert.equal(options.allFrames, false); assert.equal(options.runAt, 'document_start');
        state.beforeProbe?.();
        if (state.executeHook) return state.executeHook();
        const document = {
          get images() { state.documentReads++; return state.images; },
          get fonts() { state.documentReads++; return state.fonts; },
          querySelectorAll(selector) {
            state.documentReads++;
            if (selector === '[') throw new Error('CSS syntax');
            return selector === '*' ? state.elements : state.selectors[selector] || [];
          }
        };
        const result = await vm.runInNewContext(options.code, {
          document, location: { get href() { return state.locationOverride ?? tab.url; } },
          getComputedStyle: item => ({ fontFamily: item.fontFamily }), setTimeout, clearTimeout
        });
        state.afterProbe?.();
        return [JSON.parse(JSON.stringify(result))];
      }
    },
    update(change) { Object.assign(tab, change); this.tabs.onUpdated.emit(1, change, structuredClone(tab)); },
    removed() { this.tabs.onRemoved.emit(1); },
    assertStopped() {
      assert.equal(this.tabs.onUpdated.listeners.size, 0);
      assert.equal(this.tabs.onRemoved.listeners.size, 0);
    }
  };
  return browser;
}
function access(browser) {
  return {
    revision: 7, approvals: 0, checks: 0, signal: null, authorization: null,
    async authorize(tab, authorization, { signal }) {
      this.approvals++; browser.state.trace.push('authorize'); this.signal = signal; this.authorization = authorization;
      assert.equal(tab.url, browser.tab.url);
      return this.authorizeHook ? this.authorizeHook(tab) : structuredClone(browser.tab);
    },
    async assertAfterRead(id, url, revision, authorization) {
      this.checks++; browser.state.trace.push('assert');
      assert.equal(id, 1); assert.equal(url, browser.tab.url); assert.equal(revision, this.revision); assert.equal(authorization, this.authorization);
      return this.assertHook ? this.assertHook() : structuredClone(browser.tab);
    }
  };
}

test('a five-day content approval expiring during a DOM probe cannot return conditions', async () => {
  const browser = fakeBrowser();
  const duration = globalThis.FirefoxBridgePolicy.FIVE_DAYS_MS;
  let now = 10000;
  browser.tab.active = true; browser.tab.windowId = 1;
  browser.windows = {
    onFocusChanged: event(),
    getLastFocused: async () => ({ id: 1, type: 'normal', tabs: [structuredClone(browser.tab)] }),
    get: async () => ({ id: 1, type: 'normal', tabs: [structuredClone(browser.tab)] }),
    getAll: async () => [{ id: 1, type: 'normal', tabs: [structuredClone(browser.tab)] }],
  };
  browser.storage = { local: { get: async () => ({}), set: async () => {} } };
  const policy = new globalThis.FirefoxBridgePolicy.ContentAccess(browser, {
    now: () => now, settings: { enabled: true, contentMode: 'ask-five-days', contentScope: 'all' }, requestApproval: async () => true,
  });
  browser.state.afterProbe = () => { now += duration; };
  await assert.rejects(waitFor(browser, { tabId: 1, selector: '#target', timeoutMs: 1000 }, { contentAccess: policy }), { code: 'SESSION_EXPIRED' });
  assert.equal(browser.state.trace.filter(item => item === 'probe').length, 1);
  policy.windowTracker.stop();
});

test('wait validation normalizes exact URLs, defaults and only active conditions', () => {
  assert.deepEqual(validate({ tabId: 0, url: 'HTTPS://Example.TEST:443', imagesLoaded: false }), { tabId: 0, timeoutMs: 10000, url: 'https://example.test/' });
  assert.equal(validate({ tabId: 1, loadComplete: true, timeoutMs: 120000 }).timeoutMs, 120000);
  assert.equal(validate({ tabId: 1, url: 'about:blank', timeoutMs: 1 }).url, 'about:blank');
  for (const params of [
    null, [], {}, { tabId: -1, loadComplete: true }, { tabId: 1.2, loadComplete: true },
    { tabId: 1 }, { tabId: 1, imagesLoaded: false, fontsLoaded: false, loadComplete: false },
    { tabId: 1, loadComplete: 'true' }, { tabId: 1, imagesLoaded: null },
    { tabId: 1, selector: '' }, { tabId: 1, selector: 'x'.repeat(4097) },
    { tabId: 1, url: 'https:example.test' }, { tabId: 1, url: ' https://example.test/' },
    { tabId: 1, url: 'https://example.test/ ' }, { tabId: 1, url: 'https://example.\ntest/' },
    { tabId: 1, url: 'file:///fixture' }, { tabId: 1, url: 'about:config' },
    { tabId: 1, url: 'about:blank#fragment' }, { tabId: 1, url: '/relative' },
    { tabId: 1, loadComplete: true, timeoutMs: 0 }, { tabId: 1, loadComplete: true, timeoutMs: 120001 },
    { tabId: 1, loadComplete: true, timeoutMs: 1.5 }, { tabId: 1, loadComplete: true, frameId: 2 }
  ]) assert.throws(() => validate(params), { code: 'INVALID_PARAMS' });
});

test('URL and loadComplete wait with AND semantics without authorizing or reading the document', async () => {
  const browser = fakeBrowser({ url: 'https://example.test/old', status: 'loading' });
  const contentAccess = { authorize: () => assert.fail('Metadata must not request content approval') };
  const waiting = waitFor(browser, { tabId: 1, url: 'HTTPS://EXAMPLE.TEST:443/new', loadComplete: true, timeoutMs: 1000 }, { contentAccess });
  await settle();
  browser.update({ url: 'https://example.test/new' });
  await sleep(60);
  browser.update({ status: 'complete' });
  const result = await waiting;
  assert.deepEqual(result.conditions, { url: true, loadComplete: true });
  assert.equal(result.url, 'https://example.test/new'); assert.equal(result.status, 'complete');
  assert.equal(browser.state.documentReads, 0); assert.ok(!browser.state.trace.includes('probe'));
  browser.assertStopped();
  const blank = fakeBrowser({ url: 'about:blank', discarded: true });
  assert.deepEqual((await waitFor(blank, { tabId: 1, url: 'about:blank' })).conditions, { url: true });
  blank.assertStopped();
});

test('DOM authorization waits for the requested URL AND a complete native load', async () => {
  const browser = fakeBrowser({ url: 'https://example.test/old' }), contentAccess = access(browser);
  const waiting = waitFor(browser, { tabId: 1, url: 'https://example.test/new', selector: '#target', timeoutMs: 1000 }, { contentAccess });
  await settle(); assert.equal(contentAccess.approvals, 0);
  browser.update({ url: 'https://example.test/new', status: 'loading' });
  await sleep(60); assert.equal(contentAccess.approvals, 0); assert.equal(browser.state.documentReads, 0);
  browser.update({ status: 'complete' });
  const result = await waiting;
  assert.deepEqual(result.conditions, { url: true, selector: true });
  assert.equal(contentAccess.approvals, 1); assert.equal(contentAccess.checks, 2);
  assert.deepEqual(browser.state.trace.filter(item => item !== 'get'), ['authorize', 'assert', 'probe', 'assert']);
  assert.deepEqual(browser.state.target.visibilityOptions[0], { opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true });
  browser.assertStopped();
});

test('all DOM conditions require a visible match, loaded images and ready fonts in one snapshot', async () => {
  const browser = fakeBrowser(), contentAccess = access(browser), ready = deferred();
  const hidden = element({ visible: false });
  browser.state.selectors['#target'] = [hidden, browser.state.target];
  browser.state.images = [{ currentSrc: '/image.png', src: '', complete: false, naturalWidth: 0 }];
  browser.state.fonts.status = 'loading'; browser.state.fonts.ready = ready.promise;
  const waiting = waitFor(browser, { tabId: 1, selector: '#target', imagesLoaded: true, fontsLoaded: true, loadComplete: true, timeoutMs: 1000 }, { contentAccess });
  await sleep(20);
  browser.state.images[0].complete = true; browser.state.images[0].naturalWidth = 50;
  browser.state.fonts.status = 'loaded'; ready.resolve();
  const result = await waiting;
  assert.deepEqual(result.conditions, { selector: true, imagesLoaded: true, fontsLoaded: true, loadComplete: true });
  assert.equal(contentAccess.approvals, 1); assert.ok(contentAccess.checks >= 4);
  browser.assertStopped();
});

test('selector visibility rejects hidden and empty layout rectangles', async () => {
  const browser = fakeBrowser();
  browser.state.selectors['#target'] = [element({ visible: false }), element({ width: 0 })];
  await assert.rejects(waitFor(browser, { tabId: 1, selector: '#target', timeoutMs: 30 }), failure => {
    assert.equal(failure.code, 'WAIT_TIMEOUT'); assert.deepEqual(failure.details.conditions, { selector: false }); return true;
  });
  browser.assertStopped();
});

test('broken or unloaded lazy images wait until timeout; empty sources do not block and no scrolling occurs', async () => {
  const browser = fakeBrowser();
  browser.state.images = [
    { currentSrc: '', src: '', complete: false, naturalWidth: 0 },
    { currentSrc: '/broken.png', src: '/broken.png', complete: true, naturalWidth: 0 },
    { currentSrc: '', src: '/lazy.png', complete: false, naturalWidth: 0 }
  ];
  await assert.rejects(waitFor(browser, { tabId: 1, imagesLoaded: true, timeoutMs: 30 }), { code: 'WAIT_TIMEOUT' });
  browser.state.images[1].naturalWidth = 10;
  await assert.rejects(waitFor(browser, { tabId: 1, imagesLoaded: true, timeoutMs: 30 }), { code: 'WAIT_TIMEOUT' });
  browser.state.images[2].complete = true; browser.state.images[2].naturalWidth = 10;
  assert.deepEqual((await waitFor(browser, { tabId: 1, imagesLoaded: true })).conditions, { imagesLoaded: true });
  browser.assertStopped();
});

test('fonts.ready must resolve; unrequested unloaded faces do not block, but requested failed faces do', async () => {
  const browser = fakeBrowser(), ready = deferred();
  browser.state.fonts.ready = ready.promise;
  await assert.rejects(waitFor(browser, { tabId: 1, fontsLoaded: true, timeoutMs: 30 }), failure => failure.code === 'WAIT_TIMEOUT' && failure.details.conditions.fontsLoaded === false);
  ready.resolve();
  browser.state.fonts.faces = [{ family: 'Unused', status: 'unloaded' }];
  assert.deepEqual((await waitFor(browser, { tabId: 1, fontsLoaded: true })).conditions, { fontsLoaded: true });
  // A font used by an input value or pseudo-element has no ordinary text node.
  browser.state.target.childNodes = [];
  browser.state.fonts.faces.push({ family: '"Broken Font"', status: 'error' });
  await assert.rejects(waitFor(browser, { tabId: 1, fontsLoaded: true, timeoutMs: 30 }), { code: 'WAIT_TIMEOUT' });
  browser.assertStopped();
});

test('font readiness is awaited before simultaneous selector/image snapshots', async () => {
  const browser = fakeBrowser(), ready = deferred();
  browser.state.fonts.ready = ready.promise;
  browser.state.images = [{ currentSrc: '/image.png', complete: true, naturalWidth: 10 }];
  // An old selector/image snapshot would falsely report success after this await.
  ready.promise.then(() => { browser.state.target.visible = false; browser.state.images[0].naturalWidth = 0; });
  const waiting = waitFor(browser, { tabId: 1, selector: '#target', imagesLoaded: true, fontsLoaded: true, timeoutMs: 40 });
  ready.resolve();
  await assert.rejects(waiting, failure => {
    assert.equal(failure.code, 'WAIT_TIMEOUT');
    assert.deepEqual(failure.details.conditions, { selector: false, imagesLoaded: false, fontsLoaded: true }); return true;
  });
  browser.assertStopped();
});

test('DOM checks reject restricted pages, invalid CSS and changed injected URLs before reading the document', async () => {
  const blank = fakeBrowser({ url: 'about:blank' }), contentAccess = access(blank);
  await assert.rejects(waitFor(blank, { tabId: 1, selector: '#target' }, { contentAccess }), { code: 'RESTRICTED_PAGE' });
  assert.equal(contentAccess.approvals, 0); blank.assertStopped();
  const invalid = fakeBrowser();
  await assert.rejects(waitFor(invalid, { tabId: 1, selector: '[' }), { code: 'INVALID_PARAMS' }); invalid.assertStopped();
  const changed = fakeBrowser(); changed.state.locationOverride = 'https://other.test/';
  await assert.rejects(waitFor(changed, { tabId: 1, imagesLoaded: true }), { code: 'PAGE_CHANGED' });
  assert.equal(changed.state.documentReads, 0); changed.assertStopped();
});

test('URL/reload/discard/close changes during approval cancel it and never start a DOM probe', async () => {
  for (const [change, code] of [
    [{ url: 'https://example.test/new' }, 'PAGE_CHANGED'],
    [{ status: 'loading' }, 'PAGE_CHANGED'],
    [{ discarded: true }, 'TAB_DISCARDED'],
    [null, 'TAB_CLOSED']
  ]) {
    const browser = fakeBrowser(), contentAccess = access(browser), approval = deferred();
    contentAccess.authorizeHook = () => approval.promise;
    const waiting = waitFor(browser, { tabId: 1, selector: '#target', timeoutMs: 1000 }, { contentAccess });
    await settle(); assert.equal(contentAccess.approvals, 1);
    if (change) browser.update(change); else browser.removed();
    await assert.rejects(waiting, { code });
    assert.equal(contentAccess.signal.aborted, true);
    approval.resolve(structuredClone(browser.tab)); await settle();
    assert.equal(browser.state.documentReads, 0); assert.equal(contentAccess.checks, 0); browser.assertStopped();
  }
});

test('reload generations and silent URL changes after a probe discard its result', async () => {
  const reload = fakeBrowser();
  reload.state.afterProbe = () => { reload.update({ status: 'loading' }); reload.update({ status: 'complete' }); };
  await assert.rejects(waitFor(reload, { tabId: 1, selector: '#target' }), { code: 'PAGE_CHANGED' }); reload.assertStopped();
  const changed = fakeBrowser();
  changed.state.afterProbe = () => { changed.tab.url = 'https://other.test/'; };
  await assert.rejects(waitFor(changed, { tabId: 1, selector: '#target' }), { code: 'PAGE_CHANGED' }); changed.assertStopped();
});

test('timeout includes approval and pending permission checks, and late resolution cannot read again', async () => {
  for (const stage of ['approval', 'assert', 'execute']) {
    const browser = fakeBrowser(), contentAccess = access(browser), pending = deferred();
    if (stage === 'approval') contentAccess.authorizeHook = () => pending.promise;
    if (stage === 'assert') contentAccess.assertHook = () => pending.promise;
    if (stage === 'execute') browser.state.executeHook = () => pending.promise;
    await assert.rejects(waitFor(browser, { tabId: 1, selector: '#PRIVATE', timeoutMs: 30 }, { contentAccess }), failure => {
      assert.equal(failure.code, 'WAIT_TIMEOUT');
      assert.equal(failure.details.tabId, 1); assert.equal(failure.details.timeoutMs, 30); assert.ok(failure.details.elapsedMs >= 30);
      assert.deepEqual(failure.details.conditions, { selector: false });
      assert.ok(!JSON.stringify(failure.details).includes('PRIVATE')); return true;
    });
    assert.equal(contentAccess.signal.aborted, true);
    const calls = browser.state.trace.length;
    pending.resolve(stage === 'execute' ? [{ conditions: { selector: true } }] : structuredClone(browser.tab));
    await settle(); assert.equal(browser.state.trace.length, calls); browser.assertStopped();
  }
});

test('permission revision changes win over timeout while an old assertion is pending', async () => {
  const browser = fakeBrowser(), contentAccess = access(browser), pending = deferred();
  contentAccess.assertHook = () => pending.promise;
  const waiting = waitFor(browser, { tabId: 1, selector: '#target', timeoutMs: 30 }, { contentAccess });
  await settle(); contentAccess.revision++;
  await assert.rejects(waiting, failure => failure.code === 'PERMISSION_CHANGED' && failure.details === undefined);
  pending.resolve(structuredClone(browser.tab)); await settle();
  assert.equal(browser.state.documentReads, 0); browser.assertStopped();
});

test('external abort and assertLive failures stop requests and remove listeners', async () => {
  const browser = fakeBrowser({ status: 'loading' }), controller = new AbortController();
  const waiting = waitFor(browser, { tabId: 1, loadComplete: true }, { signal: controller.signal });
  await settle(); controller.abort(); await assert.rejects(waiting, { code: 'CANCELLED' }); browser.assertStopped();
  const already = fakeBrowser();
  await assert.rejects(waitFor(already, { tabId: 1, loadComplete: true }, { signal: controller.signal }), { code: 'CANCELLED' });
  assert.equal(already.state.trace.length, 0); already.assertStopped();
  const disconnected = fakeBrowser(), pending = deferred(); let live = true;
  disconnected.state.getHook = () => pending.promise;
  const request = waitFor(disconnected, { tabId: 1, imagesLoaded: true }, { assertLive() { if (!live) throw Object.assign(new Error('gone'), { code: 'BRIDGE_DISCONNECTED' }); } });
  await settle(); live = false; pending.resolve(structuredClone(disconnected.tab));
  await assert.rejects(request, { code: 'BRIDGE_DISCONNECTED' });
  assert.equal(disconnected.state.documentReads, 0); disconnected.assertStopped();
});
