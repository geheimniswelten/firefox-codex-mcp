// Uses only a disposable Firefox profile and a local HTTP fixture.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const token = randomUUID();
const runRoot = join(root, 'work', 'content-search-firefox-' + token);
const addon = join(runRoot, 'extension'), profile = join(runRoot, 'profile');
const requests = [];
const { promise: report, resolve: reportResult } = Promise.withResolvers();
const html = '<!doctype html><meta charset="utf-8"><meta property="og:title" content="Originaltitel"><title>Portal</title>' +
  '<script type="application/ld+json">{"@type":"VideoObject","name":"Zusatz-Titel","author":{"name":"Beispielkanal"}}</script>' +
  '<p>Statischer &amp; sichtbarer Text.</p><p hidden>Unsichtbares Wort</p><img src="/image">' +
  '<iframe src="/frame"></iframe><script src="/dynamic.js"></script>';
const server = createServer(async (req, res) => {
  const path = req.url;
  if (path === '/report/' + token && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try { reportResult(JSON.parse(body)); res.end('ok'); }
    catch { res.writeHead(400).end(); }
    return;
  }
  if (path === '/requests/' + token) { res.end(JSON.stringify(requests)); return; }
  requests.push({ path, cookie: req.headers.cookie || null });
  if (path === '/redirect') { res.writeHead(302, { Location: '/blocked-target' }).end(); return; }
  if (path === '/fixture' || path === '/second' || path === '/slow') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    if (path === '/slow') {
      const timer = setTimeout(() => res.end(html), 8000);
      res.once('close', () => clearTimeout(timer));
    } else {
      res.end(html);
    }
    return;
  }
  if (path === '/dynamic.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' }).end('document.body.append("Dynamischer Treffer");');
    return;
  }
  res.writeHead(404).end();
});

async function checkInFirefox(origin, token) {
  const checks = [];
  const send = data => fetch(origin + '/report/' + token, { method: 'POST', body: JSON.stringify(data) });
  const equal = (name, actual, expected) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(name + ': expected ' + JSON.stringify(expected) + ', received ' + JSON.stringify(actual));
    }
    checks.push(name);
  };
  const pause = () => new Promise(resolvePause => setTimeout(resolvePause, 30));
  const observed = () => fetch(origin + '/requests/' + token).then(response => response.json());
  let policy, bridge;
  try {
    const { ContentAccess } = FirefoxBridgePolicy;
    let allow = false, prompts = 0;
    const settings = { contentMode: 'ask-every-time', contentScope: 'active' };
    policy = new ContentAccess(browser, { settings, requestApproval: async () => { prompts++; return allow; } });
    bridge = FirefoxBridgeCore.createService(browser, { contentAccess: policy });
    const window = await browser.windows.create({ url: 'about:blank', focused: true });
    const activeId = window.tabs[0].id;
    const newDiscarded = path => browser.tabs.create({ windowId: window.id, url: origin + path, discarded: true, active: false });
    const first = await newDiscarded('/fixture');
    const second = await newDiscarded('/second');
    const search = (query, tabIds = [first.id], extra = {}, context = {}) =>
      bridge.handle('search_tab_contents', { tabIds, query, ...extra }, context);
    const inWindow = () => browser.tabs.query({ windowId: window.id });

    equal('denial before fetching', (await search('Beispiel')).results[0].error.code, 'CONTENT_DENIED');
    equal('denial does not contact the site', await observed(), []);
    allow = true;
    const exact = (await search('Beispielkanal')).results[0];
    equal('HTML metadata and text source', [exact.source, exact.matched, exact.match.field, exact.title, exact.author],
      ['fetched-html', true, 'author', 'Zusatz-Titel', 'Beispielkanal']);
    equal('HTML scans only one document without cookies or subresources', await observed(), [{ path: '/fixture', cookie: null }]);
    equal('original stays discarded', (await browser.tabs.get(first.id)).discarded, true);
    equal('HTML decodes entities', (await search('Statischer & sichtbarer')).matches, 1);
    equal('HTML excludes hidden and dynamic content', [(await search('Unsichtbares Wort')).matches, (await search('Dynamischer Treffer')).matches], [0, 0]);
    equal('permission applies to selected discarded tabs', prompts, 5);

    const rendered = await search('Dynamischer Treffer', [first.id, second.id], { discardedMode: 'render' });
    equal('render searches dynamic content in both tabs', rendered.results.map(row => [row.source, row.matched]), [['background-dom', true], ['background-dom', true]]);
    const stillOpen = await inWindow();
    equal('temporary tabs close and do not activate originals', stillOpen.map(tab => [tab.id, tab.active, tab.discarded]), [
      [activeId, true, false], [first.id, false, true], [second.id, false, true],
    ]);
    equal('render may fetch page resources', (await observed()).some(entry => entry.path === '/dynamic.js'), true);

    const redirect = await newDiscarded('/redirect');
    equal('HTML redirects remain unfollowed', (await search('Beispiel', [redirect.id])).results[0].error.code, 'HTML_UNAVAILABLE');
    equal('redirect target never contacted by HTML mode', (await observed()).some(entry => entry.path === '/blocked-target'), false);

    const slow = await newDiscarded('/slow');
    const controller = new AbortController();
    const reading = search('Beispiel', [slow.id], { discardedMode: 'render' }, { signal: controller.signal })
      .then(() => 'resolved', error => error.code);
    let started = false;
    for (let i = 0; i < 150; i++) {
      if ((await inWindow()).length > 5) { started = true; break; }
      await pause();
    }
    equal('background tab created during cancelled render', started, true);
    controller.abort(Object.assign(new Error('cancelled'), { code: 'CANCELLED' }));
    equal('cancelled render rejects', await reading, 'CANCELLED');
    equal('cancelled render closes the temporary tab', (await inWindow()).map(tab => tab.id), [activeId, first.id, second.id, redirect.id, slow.id]);

    policy.setSiteRules({ blocked: [{ type: 'url', value: origin + '/fixture' }] });
    const taken = (await observed()).length;
    equal('site block precedes a background HTML request', (await search('Beispiel')).results[0].error.code, 'SITE_BLOCKED');
    equal('blocked search sends no request', (await observed()).length, taken);

    const live = await browser.tabs.create({ windowId: window.id, url: origin + '/second', active: false });
    await FirefoxBridgeWait.waitFor(browser, { tabId: live.id, url: origin + '/second', loadComplete: true, timeoutMs: 15000 });
    const liveResult = (await search('Dynamischer Treffer', [live.id])).results[0];
    equal('loaded tabs search the live main frame', [liveResult.source, liveResult.matched], ['live-dom', true]);
    equal('a loaded tab stays loaded', (await browser.tabs.get(live.id)).discarded, false);
    await send({ ok: true, checks, browser: (await browser.runtime.getBrowserInfo()).version });
  } catch (error) {
    await send({ ok: false, checks, error: String(error), stack: error.stack });
  } finally {
    bridge?.tracker.stop();
    policy?.windowTracker.stop();
  }
}

await new Promise(listening => server.listen(0, '127.0.0.1', listening));
const origin = 'http://127.0.0.1:' + server.address().port;
let child, timer, log = '';
try {
  await mkdir(profile, { recursive: true });
  await cp(join(root, 'extension'), addon, { recursive: true });
  const manifestPath = join(addon, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.browser_specific_settings.gecko.id = 'content-search-' + token + '@local.invalid';
  manifest.background.scripts = manifest.background.scripts.filter(file => file !== 'background.js').concat('test-runner.js');
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(join(addon, 'test-runner.js'), '(' + checkInFirefox.toString() + ')(' + JSON.stringify(origin) + ',' + JSON.stringify(token) + ');');
  const firefox = process.env.FIREFOX_BINARY || (process.platform === 'win32' ? 'C:\\Program Files\\Mozilla Firefox\\firefox.exe' : 'firefox');
  const args = [
    join(root, 'node_modules', 'web-ext', 'bin', 'web-ext.js'), 'run', '--source-dir', addon, '--firefox', firefox,
    '--firefox-profile', profile, '--keep-profile-changes', '--no-reload', '--no-input', '--no-config-discovery', '--verbose', '--args=-headless',
  ];
  const env = { ...process.env, MOZ_CRASHREPORTER_DISABLE: '1' };
  if (process.platform === 'win32') env.MOZ_DISABLE_LAUNCHER_PROCESS = '1';
  child = spawn(process.execPath, args, { cwd: root, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  child.once('error', error => reportResult({ ok: false, error: String(error) }));
  child.once('exit', code => reportResult({ ok: false, error: 'web-ext exit ' + code }));
  timer = setTimeout(() => reportResult({ ok: false, error: 'Firefox search test timed out' }), 90_000);
  const result = await report;
  await Promise.all([
    writeFile(join(runRoot, 'report.json'), JSON.stringify({ ...result, requests }, null, 2)),
    writeFile(join(runRoot, 'browser.log'), log),
  ]);
  assert.equal(result.ok, true, JSON.stringify(result) + '\nEvidence: ' + runRoot);
  console.log('Firefox ' + result.browser + ' content search passed ' + result.checks.length + ' checks.');
} finally {
  clearTimeout(timer);
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    if (process.platform === 'win32') await promisify(execFile)('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
    else { try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
  }
  server.closeAllConnections();
  await new Promise(closed => server.close(closed));
}
