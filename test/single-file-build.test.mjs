import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { parse } from 'acorn';
import { Window } from 'happy-dom';
import { createSingleFileBuildOptions } from '../scripts/single-file-build.mjs';

const source = fileURLToPath(new URL('../vendor/single-file-core/', import.meta.url));
const htmlSource = await readFile(new URL('../extension/html-export.js', import.meta.url), 'utf8');
const options = await createSingleFileBuildOptions({
  source, outfile: resolve(tmpdir(), 'firefox-single-file-build-test.js'), write: false
});
const result = await build(options);
const bundle = result.outputFiles.find(file => file.path.endsWith('.js'))?.text;
assert.equal(typeof bundle, 'string', 'The build must return a JavaScript bundle in memory.');

function dom() {
  const window = new Window({
    url: 'https://example.test/page',
    settings: {
      disableCSSFileLoading: true, disableIframePageLoading: true,
      disableComputedStyleRendering: true, disableJavaScriptEvaluation: true
    }
  });
  window.eval(bundle);
  return window;
}

function captureOptions(window, overrides = {}) {
  return {
    url: window.location.href, removeFrames: true,
    blockScripts: true, removeNoScriptTags: true,
    removeUnusedStyles: false, removeUnusedFonts: false, removeAlternativeFonts: false,
    compressHTML: false, compressCSS: false, compressContent: false,
    includeInfobar: false, userScriptEnabled: false,
    groupDuplicateImages: false, resolveLinks: true,
    filenameTemplate: 'page.html', filenameMaxLength: 255,
    filenameReplacedCharacters: [], filenameReplacementCharacters: [], filenameReplacementCharacter: '_',
    ...overrides
  };
}

function resourceFetcher(window, resources, seen = []) {
  return async url => {
    seen.push(url);
    const [type, body] = resources.get(url) || ['text/plain', ''];
    const bytes = new TextEncoder().encode(body);
    return {
      status: resources.has(url) ? 200 : 404, url,
      headers: new window.Headers({ 'content-type': type }),
      arrayBuffer: async () => bytes.buffer
    };
  };
}

async function removeTemporary(directory) {
  const target = resolve(directory);
  assert.equal(dirname(target), resolve(tmpdir()));
  assert.match(basename(target), /^firefox-single-file-/u);
  await rm(target, { recursive: true, force: true });
}

test('SingleFile build remains pinned to the reviewed upstream version', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'firefox-single-file-version-'));
  try {
    await mkdir(join(temporary, 'source'));
    await writeFile(join(temporary, 'source', 'package.json'), JSON.stringify({ version: '1.6.20' }));
    await assert.rejects(createSingleFileBuildOptions({
      source: join(temporary, 'source'), outfile: join(temporary, 'bundle.js'), write: false
    }), /version|1\.6\.19|review/iu);
  } finally {
    await removeTemporary(temporary);
  }
});

test('reviewed source guards accept CRLF checkouts and reject changes to every adapted file', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'firefox-single-file-source-'));
  const reviewedFiles = [
    'single-file.js', 'core/index.js', 'core/helper.js', 'core/infobar.js',
    'processors/compression/compression.js', 'vendor/zip/zip.js'
  ];
  try {
    await writeFile(join(temporary, 'package.json'), await readFile(join(source, 'package.json')));
    const originals = new Map();
    for (const file of reviewedFiles) {
      const contents = (await readFile(join(source, file), 'utf8')).replace(/\r\n/gu, '\n').replace(/\n/gu, '\r\n');
      originals.set(file, contents);
      await mkdir(dirname(join(temporary, file)), { recursive: true });
      await writeFile(join(temporary, file), contents);
    }
    const fixtureOptions = { source: temporary, outfile: join(temporary, 'bundle.js'), write: false };
    assert.equal((await createSingleFileBuildOptions(fixtureOptions)).write, false);
    for (const file of reviewedFiles) {
      await writeFile(join(temporary, file), originals.get(file) + '\r\n// Unexpected upstream change.\r\n');
      await assert.rejects(createSingleFileBuildOptions(fixtureOptions), error =>
        error.message.includes(`reviewed source changed: ${file}`), file);
      await writeFile(join(temporary, file), originals.get(file));
    }
  } finally {
    await removeTemporary(temporary);
  }
});

test('the reduced bundle still captures linked CSS, images, fonts and live form state', async () => {
  const window = dom();
  try {
    window.document.head.innerHTML = '<title>Snapshot</title><link rel="stylesheet" href="/style.css">';
    window.document.body.innerHTML = '<h1>Loaded state</h1><img src="/photo.svg"><input value="initial"><a href="/target">Go</a><script>changeLater()</script>';
    window.document.querySelector('input').value = 'current value';
    const seen = [];
    const fetch = resourceFetcher(window, new Map([
      ['https://example.test/style.css', ['text/css', '@font-face{font-family:Archive;src:url(/font.woff2)}h1{font-family:Archive;background-image:url(/background.svg);color:rgb(1,2,3)}']],
      ['https://example.test/font.woff2', ['font/woff2', 'test-font-bytes']],
      ['https://example.test/background.svg', ['image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="red"/></svg>']],
      ['https://example.test/photo.svg', ['image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"><circle fill="blue"/></svg>']]
    ]), seen);
    const page = await window.FirefoxBridgeSingleFile.getPageData(
      captureOptions(window), { fetch, frameFetch: fetch }, window.document, window
    );
    window.eval(htmlSource);
    const content = window.FirefoxBridgeHtml.sanitize(page.content, window.location.href);
    assert.deepEqual(new Set(seen), new Set([
      'https://example.test/style.css', 'https://example.test/font.woff2',
      'https://example.test/background.svg', 'https://example.test/photo.svg'
    ]));
    assert.match(content, /data:image\/svg\+xml/u);
    assert.match(content, /data:font\/woff2/u);
    assert.match(content, /current value/u);
    assert.match(content, /https:\/\/example.test\/target/u);
    assert.doesNotMatch(content, /<script/u);
    assert.equal(window.document.querySelector('input').value, 'current value');
  } finally {
    await window.happyDOM.close();
  }
});

test('removed features reject before changing the live document', async () => {
  const window = dom();
  try {
    window.document.body.innerHTML = '<input value="initial"><noscript>Fallback</noscript><p id="untouched">Live page</p>';
    const before = window.document.documentElement.outerHTML;
    const mutations = [];
    const observer = new window.MutationObserver(records => mutations.push(...records));
    observer.observe(window.document, { attributes: true, childList: true, subtree: true, characterData: true });
    try {
      for (const removedOption of [
        { compressContent: true }, { includeInfobar: true }, { userScriptEnabled: true },
        { removeNoScriptTags: false }, { blockScripts: false }
      ]) {
        await assert.rejects(window.FirefoxBridgeSingleFile.getPageData(
          captureOptions(window, removedOption), {}, window.document, window
        ), error => error.code === 'UNSUPPORTED_SINGLE_FILE_OPTION', JSON.stringify(removedOption));
        mutations.push(...observer.takeRecords());
        assert.equal(window.document.documentElement.outerHTML, before);
        assert.equal(mutations.length, 0, 'Rejected options must not run capture preprocessing.');
      }
    } finally {
      observer.disconnect();
    }
  } finally {
    await window.happyDOM.close();
  }
});

test('page-supplied JSON cannot disable script removal or enable removed features', async () => {
  const window = dom();
  try {
    window.document.head.innerHTML = '<title>Snapshot</title>';
    const overrides = {
      blockScripts: false, removeNoScriptTags: false, compressContent: true,
      includeInfobar: true, userScriptEnabled: true, saveRawPage: true,
      filenameTemplate: 'page-controlled.html'
    };
    window.document.body.innerHTML = '<p>Loaded DOM snapshot</p><script id="executable">dangerousPageScript()</script><noscript>hidden fallback</noscript>';
    const script = window.document.createElement('script');
    script.type = 'application/json';
    script.setAttribute('data-single-file-options', '');
    script.textContent = JSON.stringify(overrides);
    window.document.body.appendChild(script);
    let resourceReads = 0;
    const fetch = async () => { resourceReads++; throw new Error('The live DOM must be captured without fetching raw page HTML.'); };
    const safeOptions = captureOptions(window);
    delete safeOptions.blockScripts;
    delete safeOptions.removeNoScriptTags;
    const page = await window.FirefoxBridgeSingleFile.getPageData(
      safeOptions, { fetch, frameFetch: fetch }, window.document, window
    );
    assert.equal(typeof page.content, 'string', 'The result must remain static HTML rather than ZIP bytes.');
    assert.equal(resourceReads, 0);
    assert.match(page.content, /Loaded DOM snapshot/u);
    assert.doesNotMatch(page.content, /dangerousPageScript|hidden fallback/u);
    const captured = new window.DOMParser().parseFromString(page.content, 'text/html');
    assert.equal(captured.querySelector('noscript, singlefile-infobar, single-file-infobar'), null);
    assert.equal(captured.querySelector('script#executable'), null);
    window.eval(htmlSource);
    const sanitized = window.FirefoxBridgeHtml.sanitize(page.content, window.location.href);
    const saved = new window.DOMParser().parseFromString(sanitized, 'text/html');
    assert.equal(saved.querySelector('script, noscript, singlefile-infobar, single-file-infobar'), null);
    assert.match(saved.querySelector('meta[http-equiv="Content-Security-Policy"]').content, /script-src 'none'/u);
  } finally {
    await window.happyDOM.close();
  }
});

test('Firefox closed-shadow-root access remains available in the bundled helper', async () => {
  const window = dom();
  try {
    assert.equal(typeof window.FirefoxBridgeSingleFile.processors.frameTree.getAsync, 'function');
    assert.equal(typeof window.FirefoxBridgeSingleFile.processors.frameTree.cleanup, 'function');
    const closedRoot = { mode: 'closed', marker: 'Firefox-only shadow content' };
    let reads = 0;
    const host = {
      get openOrClosedShadowRoot() { reads++; return closedRoot; },
      get shadowRoot() { throw new Error('An open-root fallback must not replace the closed root.'); }
    };
    assert.equal(window.FirefoxBridgeSingleFile.helper.getShadowRoot(host), closedRoot);
    assert.ok(reads > 0);
    const openRoot = { mode: 'open' };
    assert.equal(window.FirefoxBridgeSingleFile.helper.getShadowRoot({ shadowRoot: openRoot }), openRoot);
  } finally {
    await window.happyDOM.close();
  }
});

test('the generated bundle contains no HTML assignment, dynamic import or document.write path', () => {
  const ast = parse(bundle, { ecmaVersion: 'latest', sourceType: 'script', locations: true });
  const unsafe = [];
  function propertyName(node) {
    if (node?.type !== 'MemberExpression') return undefined;
    return node.computed ? node.property.type === 'Literal' ? node.property.value : undefined : node.property.name;
  }
  function isDocument(node) {
    return node?.type === 'Identifier' && /^(?:doc|document)\d*$/u.test(node.name) || propertyName(node) === 'document';
  }
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'ImportExpression' ||
        node.type === 'AssignmentExpression' && ['innerHTML', 'outerHTML'].includes(propertyName(node.left)) ||
        node.type === 'CallExpression' && ['write', 'writeln'].includes(propertyName(node.callee)) && isDocument(node.callee.object)) {
      unsafe.push(`${node.type} at ${node.loc.start.line}:${node.loc.start.column}`);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object' && typeof value.type === 'string') visit(value);
    }
  }
  visit(ast);
  assert.deepEqual(unsafe, []);
});
