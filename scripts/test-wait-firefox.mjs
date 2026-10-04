// Optional integration test. Never uses the user's Firefox profile or native host.
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const token = randomUUID();
const runRoot = join(root, 'work', `wait-firefox-${token}`);
const addon = join(runRoot, 'extension'), profile = join(runRoot, 'profile');
const fontPath = process.env.FIREFOX_WAIT_FONT || (process.platform === 'win32' ? 'C:\\Windows\\Fonts\\arial.ttf' : null);
if (!fontPath) throw new Error('Set FIREFOX_WAIT_FONT to a local TrueType font for this optional test.');
const font = await readFile(fontPath);
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jI0cAAAAASUVORK5CYII=', 'base64');
const fixture = `<!doctype html><html><head><meta charset="utf-8"><title>Wait fixture</title></head><body><div id="ready" style="display:none">Ready</div><div class="candidate" style="display:none">Hidden first</div><div class="candidate" id="second" style="opacity:0">Second match</div><div id="offscreen" style="position:absolute;top:10000px">Offscreen</div><div id="font-target">Font layout target</div><div id="images"></div></body></html>`;
let child, timer, browserLog = '', resolveReport;
const requests = [];
const report = new Promise(resolveResult => { resolveReport = resolveResult; });
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
const server = http.createServer(async (request, response) => {
  const path = new URL(request.url, 'http://127.0.0.1').pathname;
  if (request.method === 'POST' && path === `/report/${token}`) {
    try {
      const chunks = []; let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 128 * 1024) { response.writeHead(413).end(); return; }
        chunks.push(chunk);
      }
      const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      response.writeHead(200).end('ok');
      resolveReport(result);
    } catch (error) {
      response.writeHead(400).end('invalid report');
      resolveReport({ ok: false, error: String(error) });
    }
    return;
  }
  requests.push({ url: request.url, at: Date.now() });
  if (path === '/slow-image.png' || path === '/slow-font.ttf') {
    await delay(300);
    response.writeHead(200, { 'Content-Type': path.endsWith('.png') ? 'image/png' : 'font/ttf', 'Cache-Control': 'no-store' });
    response.end(path.endsWith('.png') ? image : font);
    return;
  }
  if (path === '/fixture' || path === '/navigated') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(fixture);
    return;
  }
  response.writeHead(404).end('missing');
});

// Serialized into the copied extension; browser APIs and wait.js run in Firefox.
async function runWaitTests(origin, token) {
  const checks = [];
  let service, policy, targetId;
  const transitions = [];
  const sendReport = result => fetch(`${origin}/report/${token}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result)
  });
  const equal = (name, actual, expected) => {
    const passed = JSON.stringify(actual) === JSON.stringify(expected);
    checks.push({ name, passed, actual });
    if (!passed) throw new Error(`${name}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  };
  const wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));
  const injection = async (id, code) => (await browser.tabs.executeScript(id, { code, frameId: 0 }))[0];
  const loaded = async (id, expectedUrl) => {
    for (let attempt = 0; attempt < 600; attempt++) {
      const tab = await browser.tabs.get(id);
      if (tab.status === 'complete' && tab.url === expectedUrl && tab.title === 'Wait fixture') return;
      await wait(50);
    }
    throw new Error(`Fixture tab ${id} did not load`);
  };
  const rejection = async (name, promise, expected) => {
    let code = null;
    try { await promise; } catch (error) { code = error.code; }
    equal(name, code, expected);
  };
  try {
    const browserInfo = await browser.runtime.getBrowserInfo();
    let approvalMode = 'allow', approvalRequest = null, approvalStarted = () => {};
    policy = new FirefoxBridgePolicy.ContentAccess(browser, {
      settings: { enabled: true, contentMode: 'allow', contentScope: 'all' },
      requestApproval: (request, { signal } = {}) => {
        approvalRequest = request;
        approvalStarted();
        if (approvalMode !== 'pending') return Promise.resolve(approvalMode === 'allow');
        return new Promise(resolveApproval => {
          if (signal?.aborted) { resolveApproval(false); return; }
          signal?.addEventListener('abort', () => resolveApproval(false), { once: true });
        });
      }
    });
    service = FirefoxBridgeCore.createService(browser, { contentAccess: policy });
    await service.ready;
    const window = await browser.windows.create({ url: 'about:blank', focused: true });
    const activeId = window.tabs[0].id;
    const tab = await browser.tabs.create({ windowId: window.id, url: origin + '/fixture', active: false });
    targetId = tab.id;
    browser.tabs.onUpdated.addListener((id, change) => {
      if (id === targetId) transitions.push({ change, at: Date.now() });
    });
    await loaded(tab.id, origin + '/fixture');
    const waitFor = (params, context) => service.handle('wait_for', { tabId: tab.id, timeoutMs: 15000, ...params }, context);

    const matching = waitFor({ url: origin + '/navigated', loadComplete: true });
    await wait(150);
    await browser.tabs.update(tab.id, { url: origin + '/navigated' });
    const navigated = await matching;
    equal('wait follows an initially mismatched URL', navigated.url, origin + '/navigated');
    equal('URL and load conditions are both reported', navigated.conditions, { url: true, loadComplete: true });

    await injection(tab.id, `setTimeout(() => { document.getElementById('second').style.opacity = '1'; }, 300);`);
    const visible = await waitFor({ selector: '.candidate' });
    equal('selector accepts a later visible match after a hidden first match', visible.conditions.selector, true);
    equal('visible selector waits for its delayed state', (await injection(tab.id, `getComputedStyle(document.getElementById('second')).opacity`)), '1');
    const offscreen = await waitFor({ selector: '#offscreen' });
    equal('offscreen layout element matches without scrolling', offscreen.conditions.selector, true);
    equal('offscreen selector preserves scroll position', await injection(tab.id, 'scrollY'), 0);

    await injection(tab.id, `document.getElementById('images').innerHTML = '<img id="image" src="${origin}/slow-image.png?image-only">';`);
    equal('delayed image begins incomplete', await injection(tab.id, `document.getElementById('image').complete`), false);
    const images = await waitFor({ imagesLoaded: true });
    equal('image condition waits for successful source completion', images.conditions.imagesLoaded, true);
    equal('image has decoded natural dimensions', await injection(tab.id, `document.getElementById('image').naturalWidth > 0`), true);

    await injection(tab.id, `window.fixtureFont = new FontFace('WaitFixture', 'url(${origin}/slow-font.ttf?font-only)'); document.fonts.add(window.fixtureFont); document.getElementById('font-target').style.fontFamily = 'WaitFixture'; window.fixtureFont.load(); true;`);
    equal('requested delayed font starts loading', await injection(tab.id, 'window.fixtureFont.status'), 'loading');
    const fonts = await waitFor({ fontsLoaded: true });
    equal('font condition waits for requested font and layout', fonts.conditions.fontsLoaded, true);
    equal('requested font is loaded', await injection(tab.id, 'window.fixtureFont.status'), 'loaded');
    await injection(tab.id, `window.unusedFont = new FontFace('UnusedFixture', 'url(${origin}/slow-font.ttf?unused)'); document.fonts.add(window.unusedFont); true;`);
    await waitFor({ fontsLoaded: true });
    equal('unused unloaded font does not prevent success', await injection(tab.id, 'window.unusedFont.status'), 'unloaded');

    await injection(tab.id, `document.getElementById('ready').style.display = 'none'; document.getElementById('images').innerHTML = '<img id="image" src="${origin}/slow-image.png?combined">'; window.combinedFont = new FontFace('CombinedFixture', 'url(${origin}/slow-font.ttf?combined)'); document.fonts.add(window.combinedFont); document.getElementById('font-target').style.fontFamily = 'CombinedFixture'; window.combinedFont.load(); setTimeout(() => { document.getElementById('ready').style.display = 'block'; }, 600);`);
    const combined = await waitFor({ url: origin + '/navigated', selector: '#ready', imagesLoaded: true, fontsLoaded: true, loadComplete: true });
    equal('all active conditions combine with AND', combined.conditions, { url: true, selector: true, imagesLoaded: true, fontsLoaded: true, loadComplete: true });
    equal('combined result is returned only after visibility changes', await injection(tab.id, `getComputedStyle(document.getElementById('ready')).display`), 'block');
    equal('waiting never selects the target tab', (await browser.tabs.query({ windowId: window.id, active: true }))[0].id, activeId);

    await injection(tab.id, `document.getElementById('images').innerHTML = '<img id="broken" src="${origin}/missing-image.png">';`);
    for (let attempt = 0; attempt < 50; attempt++) {
      if (await injection(tab.id, `document.getElementById('broken').complete`)) break;
      await wait(20);
    }
    equal('broken fixture really failed its image load', await injection(tab.id, `document.getElementById('broken').complete && document.getElementById('broken').naturalWidth === 0`), true);
    await rejection('broken image cannot satisfy imagesLoaded', waitFor({ imagesLoaded: true, timeoutMs: 600 }), 'WAIT_TIMEOUT');
    await rejection('invalid CSS selector is rejected', waitFor({ selector: '[' }), 'INVALID_PARAMS');

    const originalAuthorize = policy.authorize.bind(policy);
    let afterAuthorization = () => {};
    policy.authorize = async (...args) => {
      const result = await originalAuthorize(...args);
      afterAuthorization();
      return result;
    };
    let authorized = new Promise(resolveAuthorized => { afterAuthorization = resolveAuthorized; });
    const reloading = waitFor({ selector: '#never-present' });
    await authorized;
    await browser.tabs.reload(tab.id);
    await rejection('reload after authorization rejects the changed document', reloading, 'PAGE_CHANGED');
    await loaded(tab.id, origin + '/navigated');

    authorized = new Promise(resolveAuthorized => { afterAuthorization = resolveAuthorized; });
    const controller = new AbortController();
    const cancelling = waitFor({ selector: '#never-present' }, { signal: controller.signal });
    await authorized;
    controller.abort(Object.assign(new Error('Test cancellation'), { code: 'CANCELLED' }));
    await rejection('AbortSignal stops an authorized wait loop', cancelling, 'CANCELLED');

    policy.setSettings({ enabled: true, contentMode: 'deny', contentScope: 'all' });
    await rejection('deny policy rejects DOM waiting', waitFor({ selector: '#offscreen' }), 'CONTENT_DENIED');
    const metadata = await waitFor({ url: origin + '/navigated', loadComplete: true });
    equal('metadata-only wait succeeds with content denied', metadata.conditions, { url: true, loadComplete: true });

    policy.setSettings({ enabled: true, contentMode: 'ask-every-time', contentScope: 'active' });
    approvalMode = 'allow';
    await waitFor({ selector: '#offscreen' });
    equal('another tab uses exact-tab approval scope', approvalRequest.scope, 'tab');
    equal('another tab remains unselected after approval', (await browser.tabs.query({ windowId: window.id, active: true }))[0].id, activeId);
    approvalMode = 'deny';
    await rejection('declined exact-tab approval rejects DOM waiting', waitFor({ selector: '#offscreen' }), 'CONTENT_DENIED');

    approvalMode = 'pending';
    const approvalPending = new Promise(resolveApproval => { approvalStarted = resolveApproval; });
    const promptController = new AbortController();
    const promptWait = waitFor({ selector: '#offscreen' }, { signal: promptController.signal });
    await approvalPending;
    equal('content approval is pending before cancellation', policy.promptPending, true);
    promptController.abort(Object.assign(new Error('Cancel test approval'), { code: 'CANCELLED' }));
    await rejection('cancellation stops a pending content approval', promptWait, 'CANCELLED');
    equal('cancellation releases the content approval slot', policy.promptPending, false);

    const approvalTimeout = waitFor({ selector: '#offscreen', timeoutMs: 350 });
    await rejection('wait budget includes time spent on content approval', approvalTimeout, 'WAIT_TIMEOUT');
    equal('timeout releases the content approval slot', policy.promptPending, false);
    await sendReport({ ok: true, browser: browserInfo, checks, transitions, approvalAdapter: 'in-test allow/deny/AbortSignal; no native host or UI approval popup' });
  } catch (error) {
    let targetTab;
    try { if (targetId !== undefined) targetTab = await browser.tabs.get(targetId); } catch { /* Preserve the original failure. */ }
    await sendReport({ ok: false, error: String(error), code: error.code, details: error.details, stack: error.stack, targetTab, transitions, checks });
  } finally {
    service?.tracker.stop();
    policy?.windowTracker.stop();
  }
}

await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
const origin = `http://127.0.0.1:${server.address().port}`;
try {
  await mkdir(profile, { recursive: true });
  await cp(join(root, 'extension'), addon, { recursive: true });
  const manifest = JSON.parse(await readFile(join(addon, 'manifest.json'), 'utf8'));
  manifest.browser_specific_settings.gecko.id = `wait-test-${token}@local.invalid`;
  manifest.background.scripts = manifest.background.scripts.filter(file => file !== 'background.js').concat('test-runner.js');
  await writeFile(join(addon, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(addon, 'test-runner.js'), `(${runWaitTests.toString()})(${JSON.stringify(origin)},${JSON.stringify(token)});`);
  const firefox = process.env.FIREFOX_BINARY || (process.platform === 'win32' ? 'C:\\Program Files\\Mozilla Firefox\\firefox.exe' : 'firefox');
  child = spawn(process.execPath, [join(root, 'node_modules', 'web-ext', 'bin', 'web-ext.js'), 'run', '--source-dir', addon, '--firefox', firefox, '--firefox-profile', profile, '--keep-profile-changes', '--no-reload', '--no-input', '--no-config-discovery', '--verbose', '--args=-headless'], {
    cwd: root, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', data => { browserLog += data; });
  child.stderr.on('data', data => { browserLog += data; });
  child.on('error', error => resolveReport({ ok: false, error: String(error) }));
  child.on('exit', (code, signal) => resolveReport({ ok: false, error: `web-ext exited (${code ?? signal})` }));
  timer = setTimeout(() => resolveReport({ ok: false, error: 'Firefox wait integration timed out' }), 240000);
  const result = await report;
  clearTimeout(timer);
  await writeFile(join(runRoot, 'report.json'), JSON.stringify({ ...result, requests }, null, 2));
  await writeFile(join(runRoot, 'browser.log'), browserLog);
  assert.equal(result.ok, true, `Firefox integration failed: ${JSON.stringify(result)}. Evidence: ${runRoot}`);
  assert.ok(result.checks.length >= 20 && result.checks.every(check => check.passed));
  console.log(`Firefox wait integration passed (${result.checks.length} checks). Evidence: ${runRoot}`);
} finally {
  clearTimeout(timer);
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    if (process.platform === 'win32') {
      await new Promise(resolveKill => execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, resolveKill));
    } else {
      try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  }
  server.closeAllConnections();
  await new Promise(resolveClose => server.close(resolveClose));
}
