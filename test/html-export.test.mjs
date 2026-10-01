import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Window } from 'happy-dom';
import '../extension/html-export.js';

const exporter = globalThis.FirefoxBridgeHtml;
const htmlSource = await readFile(new URL('../extension/html-export.js', import.meta.url), 'utf8');
const vendorSource = await readFile(new URL('../extension/vendor/single-file.bundle.js', import.meta.url), 'utf8');
function dom() {
  const window = new Window({ url: 'https://example.test/page', settings: { disableCSSFileLoading: true, disableIframePageLoading: true, disableComputedStyleRendering: true } });
  globalThis.DOMParser = window.DOMParser;
  return window;
}

test('literal navigation converts only an entire deterministic expression without evaluating code', () => {
  for (const source of ["location.href='/details/123';", 'window.location.assign("/details/123"); return false;', "javascript:document.location.replace('/details/123')", "location = '/details/123'"]) {
    assert.equal(exporter.literalNavigation(source, 'https://example.test/page'), 'https://example.test/details/123');
  }
  assert.equal(exporter.literalNavigation("location.href='#details'", 'https://example.test/page'), '#details');
  assert.equal(exporter.literalNavigation("location.href='https://other.test/path'", 'https://example.test/page'), 'https://other.test/path');
  for (const source of ["location.href=getTarget()", "location.href='/safe'; alert(1)", "if (enabled) location.href='/safe'", "location.href='javascript:alert(1)'", "location.href='data:text/html,unsafe'", "location.href=`/safe`", "location.href='/safe' + suffix", "window.open('/safe')"]) {
    assert.equal(exporter.literalNavigation(source, 'https://example.test/page'), null, source);
  }
});

test('saved HTML strips executable content recursively and retains absolute and converted links', async () => {
  const window = dom(), warnings = [];
  const source = `<html><head><base href="https://bad.test/"><meta http-equiv="refresh" content="0;url=https://bad.test/"><script src="https://bad.test/x.js"></script><style>body{color:blue}</style></head><body onload="mutate()"><a href="/details" onclick="other()" ping="https://bad.test/p">link</a><a href="#part">jump</a><button data-firefox-mcp-navigation="capture:1" onclick="location.href='/saved'">Open</button><a href="java&#10;script:alert(1)">unsafe</a><template shadowrootmode="open"><script>mutate()</script><span onclick="mutate()">shadow</span></template><iframe srcdoc="&lt;script&gt;mutate()&lt;/script&gt;&lt;a href='/frame' onclick='mutate()'&gt;frame&lt;/a&gt;"></iframe><object data="https://bad.test/p"></object><svg><animate attributeName="x"></animate></svg></body></html>`;
  const content = exporter.sanitize(source, 'https://example.test/page', [{ id: 'capture:1', href: 'https://example.test/saved' }], warnings);
  const doc = new window.DOMParser().parseFromString(content, 'text/html');
  assert.equal(doc.querySelectorAll('script,base,object,embed,animate').length, 0);
  assert.equal(doc.querySelectorAll('[onclick],[onload],[ping]').length, 0);
  assert.equal(doc.querySelector('a').href, 'https://example.test/details');
  assert.equal(doc.querySelectorAll('a')[1].getAttribute('href'), '#part');
  assert.equal(doc.querySelectorAll('a')[2].getAttribute('href'), 'https://example.test/saved');
  assert.equal(doc.querySelectorAll('a')[3].hasAttribute('href'), false);
  assert.equal(doc.querySelector('template').content.querySelector('script'), null);
  assert.equal(doc.querySelector('template').content.querySelector('[onclick]'), null);
  const frame = new window.DOMParser().parseFromString(doc.querySelector('iframe').getAttribute('srcdoc'), 'text/html');
  assert.equal(frame.querySelector('script'), null);
  assert.equal(frame.querySelector('a').href, 'https://example.test/frame');
  assert.match(frame.querySelector('[http-equiv]').content, /script-src 'none'/u);
  assert.match(doc.querySelector('[http-equiv]').content, /connect-src 'none'/u);
  assert.equal(doc.querySelector('iframe').hasAttribute('src'), false);
  assert.ok(content.startsWith('<!DOCTYPE html>'));
  await window.happyDOM.close();
});

test('embedded data-URL frames are frozen rather than reloaded from the network', async () => {
  const window = dom(), warnings = [];
  const frame = 'data:text/html;base64,' + Buffer.from('<script>mutate()</script><b>Frame snapshot</b>').toString('base64');
  const content = exporter.sanitize(`<iframe src="${frame}"></iframe><iframe src="https://missing.test/frame"></iframe>`, 'https://example.test/page', [], warnings);
  const doc = new window.DOMParser().parseFromString(content, 'text/html');
  assert.match(doc.querySelector('iframe').getAttribute('srcdoc'), /Frame snapshot/u);
  assert.doesNotMatch(doc.querySelector('iframe').getAttribute('srcdoc'), /<script/u);
  assert.equal(doc.querySelectorAll('iframe[src]').length, 0);
  assert.ok(warnings.some(text => /nicht zugänglicher Frame/u.test(text)));
  await window.happyDOM.close();
});

test('page preparation annotates deterministic navigation and always restores live attributes', async () => {
  const window = dom();
  window.document.body.innerHTML = '<button onclick="location.href=\'/target\'" data-firefox-mcp-navigation="existing">Go</button><button onclick="fetchTarget()">Other</button>';
  window.eval(htmlSource);
  const result = await window.FirefoxBridgeHtml.preparePage('capture-token', { loadDeferred: false });
  assert.equal(result.links[0].href, 'https://example.test/target');
  assert.notEqual(window.document.querySelector('button').getAttribute('data-firefox-mcp-navigation'), 'existing');
  assert.equal(result.warnings.length, 1);
  window.FirefoxBridgeHtml.cleanupPage();
  assert.equal(window.document.querySelector('button').getAttribute('data-firefox-mcp-navigation'), 'existing');
  assert.equal(window.document.querySelector('button').getAttribute('onclick'), "location.href='/target'");
  await window.happyDOM.close();
});

function mockBrowser(onCapture) {
  const listeners = new Set(), calls = [];
  const browser = {
    calls, listeners,
    runtime: { id: 'bridge@local', onMessage: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) } },
    tabs: {
      async get(id) { return { id, url: 'https://example.test/page' }; },
      async sendMessage() {},
      async executeScript(id, options) {
        calls.push({ id, ...options });
        if (options.file) return [];
        if (options.code.includes('preparePage')) return [{ links: [], warnings: [] }];
        if (options.code.includes('capturePage')) return [await onCapture(browser, options.code.match(/\("([^"]+)"\)/u)[1])];
        return [];
      }
    }
  };
  return browser;
}

test('capture scopes resource requests to the authorized tab and removes its listener afterward', async () => {
  const window = dom(), oldFetch = globalThis.fetch;
  let reads = 0, checks = 0, savedListener;
  globalThis.fetch = async url => { reads++; return new Response('embedded asset', { headers: { 'content-type': 'text/css' } }); };
  const browser = mockBrowser(async (api, token) => {
    savedListener = [...api.listeners][0];
    const message = { type: 'firefox_mcp_html_resource', token, url: 'https://asset.test/style.css' };
    assert.equal(savedListener(message, { id: 'other@local', tab: { id: 4 } }), undefined);
    assert.equal(savedListener(message, { id: api.runtime.id, tab: { id: 9 } }), undefined);
    assert.equal(savedListener({ ...message, token: 'wrong' }, { id: api.runtime.id, tab: { id: 4 } }), undefined);
    const resource = await savedListener(message, { id: api.runtime.id, tab: { id: 4 } });
    assert.equal(Buffer.from(resource.body, 'base64').toString(), 'embedded asset');
    return { content: '<p>Saved snapshot</p>' };
  });
  try {
    const result = await exporter.capture(browser, 4, { loadDeferred: false }, { assertLive() {}, async assertAccess() { checks++; } });
    assert.match(result.content, /Saved snapshot/u);
    assert.equal(reads, 1); assert.ok(checks > 8);
    assert.equal(browser.listeners.size, 0);
    assert.equal(savedListener({ type: 'firefox_mcp_html_resource' }, { id: browser.runtime.id, tab: { id: 4 } }), undefined);
    assert.ok(browser.calls.some(call => call.code?.includes('cleanupPage')));
  } finally { globalThis.fetch = oldFetch; await window.happyDOM.close(); }
});

test('revoked access suppresses captured content and still restores the live document', async () => {
  const window = dom(); let allowed = true;
  const browser = mockBrowser(async () => { allowed = false; return { content: '<p>private</p>' }; });
  await assert.rejects(exporter.capture(browser, 4, {}, { async assertAccess() { if (!allowed) throw Object.assign(new Error('revoked'), { code: 'DENIED' }); } }), error => error.code === 'DENIED');
  assert.equal(browser.listeners.size, 0);
  assert.ok(browser.calls.at(-1).code.includes('cleanupPage'));
  await window.happyDOM.close();
});

test('the bundled SingleFile engine embeds linked CSS, CSS images, image URLs and fonts from the loaded DOM', async () => {
  const window = dom();
  window.document.head.innerHTML = '<title>Snapshot</title><link rel="stylesheet" href="/style.css">';
  window.document.body.innerHTML = '<h1>Loaded state</h1><img src="/photo.svg"><input value="initial"><a href="/target">Go</a><script>changeLater()</script>';
  window.document.querySelector('input').value = 'current value';
  const seen = [];
  const resources = new Map([
    ['https://example.test/style.css', ['text/css', '@font-face{font-family:Archive;src:url(/font.woff2)}h1{font-family:Archive;background-image:url(/background.svg);color:rgb(1,2,3)}']],
    ['https://example.test/font.woff2', ['font/woff2', 'test-font-bytes']],
    ['https://example.test/background.svg', ['image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="red"/></svg>']],
    ['https://example.test/photo.svg', ['image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"><circle fill="blue"/></svg>']]
  ]);
  window.eval(vendorSource);
  const fakeFetch = async url => {
    seen.push(url); const [type, body] = resources.get(url) || ['text/plain', ''];
    const bytes = new TextEncoder().encode(body);
    return { status: resources.has(url) ? 200 : 404, url, headers: new window.Headers({ 'content-type': type }), arrayBuffer: async () => bytes.buffer };
  };
  const page = await window.FirefoxBridgeSingleFile.getPageData({
    url: window.location.href, removeFrames: true, blockScripts: true, removeNoScriptTags: true,
    removeUnusedStyles: false, removeUnusedFonts: false, removeAlternativeFonts: false,
    compressContent: false, groupDuplicateImages: false, resolveLinks: true,
    filenameTemplate: 'page.html', filenameMaxLength: 255,
    filenameReplacedCharacters: [], filenameReplacementCharacters: [], filenameReplacementCharacter: '_'
  }, { fetch: fakeFetch, frameFetch: fakeFetch }, window.document, window);
  const content = exporter.sanitize(page.content, window.location.href);
  assert.ok(seen.includes('https://example.test/style.css'));
  assert.ok(seen.includes('https://example.test/background.svg'));
  assert.ok(seen.includes('https://example.test/font.woff2'));
  assert.ok(seen.includes('https://example.test/photo.svg'));
  assert.match(content, /data:image\/svg\+xml/u);
  assert.match(content, /data:font\/woff2/u);
  assert.match(content, /current value/u);
  assert.doesNotMatch(content, /<script/u);
  assert.match(content, /https:\/\/example.test\/target/u);
  assert.equal(window.document.querySelector('input').value, 'current value');
  await window.happyDOM.close();
});
