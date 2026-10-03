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
const runRoot = join(root, 'work', `tab-search-firefox-${token}`);
const addon = join(runRoot, 'extension'), profile = join(runRoot, 'profile');
const fixtures = [
  { path: '/fixture/title-one', title: 'Needle [MCP] Alpha' },
  { path: '/fixture/needle-url', title: 'Other beta' },
  { path: '/fixture/title-three', title: 'NEEDLE [MCP] Gamma' },
  { path: '/fixture/discardable', title: 'Needle [MCP] Discardable' },
  { path: '/fixture/other-window', title: 'Needle [MCP] Other Window' }
];
let child, timer, browserLog = '', resolveReport;
const report = new Promise(resolveResult => { resolveReport = resolveResult; });
const server = http.createServer(async (request, response) => {
  if (request.method === 'POST' && request.url === `/report/${token}`) {
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
  const fixture = fixtures.find(item => item.path === request.url);
  if (!fixture) { response.writeHead(404).end('missing'); return; }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(`<!doctype html><html><head><meta charset="utf-8"><title>${fixture.title}</title></head><body>Tab search fixture</body></html>`);
});

// Serialized into the copied extension so every call below runs inside Firefox.
async function runSearchTests(origin, token, fixtures) {
  const checks = [];
  let service;
  const sendReport = result => fetch(`${origin}/report/${token}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result)
  });
  const equal = (name, actual, expected) => {
    const passed = JSON.stringify(actual) === JSON.stringify(expected);
    checks.push({ name, passed, actual });
    if (!passed) throw new Error(`${name}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  };
  const ids = result => result.tabs.map(tab => tab.id);
  const wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));
  const loaded = async (id, expectedTitle) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const tab = await browser.tabs.get(id);
      if (tab.status === 'complete' && tab.title === expectedTitle) return;
      await wait(50);
    }
    throw new Error(`Fixture tab ${id} did not load`);
  };
  try {
    const browserInfo = await browser.runtime.getBrowserInfo();
    service = FirefoxBridgeCore.createService(browser);
    await service.ready;
    const window = await browser.windows.create({ url: 'about:blank', focused: false });
    const windowId = window.id;
    for (let index = 0; index < 105; index++) await browser.tabs.create({ windowId, url: 'about:blank', active: false });
    const targets = [];
    for (const fixture of fixtures.slice(0, 4)) {
      const tab = await browser.tabs.create({ windowId, url: origin + fixture.path, active: false });
      await loaded(tab.id, fixture.title);
      equal(`fixture title ${targets.length + 1}`, (await browser.tabs.get(tab.id)).title, fixture.title);
      targets.push(tab.id);
    }
    const otherWindow = await browser.windows.create({ url: origin + fixtures[4].path, focused: false });
    const other = otherWindow.tabs[0];
    await loaded(other.id, fixtures[4].title);
    const list = params => service.handle('list_tabs', { windowId, ...params });
    const unfiltered = await list({});
    equal('unfiltered default page length', unfiltered.returned, 100);
    equal('unfiltered full candidate count', unfiltered.total, 110);
    equal('late fixture matches are beyond the default page', ids(unfiltered).some(id => targets.includes(id)), false);

    equal('contains both is title OR URL', ids(await list({ query: 'needle' })), targets);
    equal('contains title is case insensitive by default', ids(await list({ query: 'needle', searchIn: 'title' })), [targets[0], targets[2], targets[3]]);
    equal('contains URL excludes title-only matches', ids(await list({ query: 'needle', searchIn: 'url' })), [targets[1]]);
    equal('contains treats brackets literally', ids(await list({ query: '[MCP]', searchIn: 'title' })), [targets[0], targets[2], targets[3]]);
    equal('contains caseSensitive selects exact case', ids(await list({ query: 'Needle', searchIn: 'title', caseSensitive: true })), [targets[0], targets[3]]);
    equal('contains uppercase exact case', ids(await list({ query: 'NEEDLE', searchIn: 'title', caseSensitive: true })), [targets[2]]);
    equal('regex URL source matches through a real Firefox Worker', ids(await list({ query: '^https?://127\\.0\\.0\\.1:[0-9]+/fixture/', searchIn: 'url', matchMode: 'regex' })), targets);

    const page = await list({ query: 'needle', limit: 2, offset: 1 });
    equal('pagination returns matching rows after filtering', ids(page), targets.slice(1, 3));
    equal('pagination counts matches', [page.total, page.returned, page.nextOffset], [4, 2, 3]);
    const tail = await list({ query: 'needle', limit: 2, offset: 3 });
    equal('pagination tail', [ids(tail), tail.total, tail.returned, tail.nextOffset], [[targets[3]], 4, 1, null]);
    const outside = await list({ query: 'needle', offset: 999 });
    equal('pagination beyond matching rows', [outside.total, outside.returned, outside.nextOffset], [4, 0, null]);
    const allWindows = await service.handle('list_tabs', { query: 'needle' });
    equal('window filter restricts matching candidates', ids(allWindows).sort((a, b) => a - b), [...targets, other.id].sort((a, b) => a - b));

    await browser.tabs.discard(targets[3]);
    equal('fixture really is discarded', (await browser.tabs.get(targets[3])).discarded, true);
    equal('discarded filter composes with title search', ids(await list({ query: 'needle', searchIn: 'title', discarded: true })), [targets[3]]);
    equal('non-discarded filter composes with both search', ids(await list({ query: 'needle', discarded: false })), targets.slice(0, 3));

    const workerFactory = () => new Worker(browser.runtime.getURL('tab-search-worker.js'));
    const firefoxRegexSource = '(?<name>a)|(?<name>b)';
    const firefoxRegex = await FirefoxBridgeTabSearch.filterTabs([
      { id: 1, title: 'a' }, { id: 2, title: 'b' }, { id: 3, title: 'c' }
    ], { query: firefoxRegexSource, searchIn: 'title', matchMode: 'regex' }, { workerFactory });
    equal('Firefox accepts duplicate named captures in disjoint alternatives', firefoxRegex.map(tab => tab.id), [1, 2]);
    equal('service accepts Firefox-valid regex syntax', ids(await list({ query: '(?<name>Alpha)|(?<name>Gamma)', searchIn: 'title', matchMode: 'regex' })), [targets[0], targets[2]]);

    const timeoutStarted = Date.now();
    let timeoutCode = null;
    try {
      await FirefoxBridgeTabSearch.filterTabs([{ title: `${'a'.repeat(20000)}!` }], {
        query: '(a+)+$', searchIn: 'title', matchMode: 'regex'
      }, { workerFactory });
    } catch (error) { timeoutCode = error.code; }
    const timeoutElapsedMs = Date.now() - timeoutStarted;
    equal('catastrophic regex is terminated at the production timeout', timeoutCode, 'SEARCH_TIMEOUT');
    equal('next regex succeeds after Worker termination', ids(await list({ query: '^Needle', searchIn: 'title', matchMode: 'regex' })), [targets[0], targets[2], targets[3]]);
    await sendReport({ ok: true, browser: browserInfo, fillerTabs: 105, fixtureTabs: targets.length, checks, firefoxRegexSource, timeoutCode, timeoutElapsedMs });
  } catch (error) {
    await sendReport({ ok: false, error: String(error), code: error.code, stack: error.stack, checks });
  } finally {
    service?.tracker.stop();
  }
}

await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
const origin = `http://127.0.0.1:${server.address().port}`;
try {
  await mkdir(profile, { recursive: true });
  await cp(join(root, 'extension'), addon, { recursive: true });
  const manifest = JSON.parse(await readFile(join(addon, 'manifest.json'), 'utf8'));
  manifest.browser_specific_settings.gecko.id = `tab-search-test-${token}@local.invalid`;
  manifest.background.scripts = manifest.background.scripts.filter(file => file !== 'background.js').concat('test-runner.js');
  await writeFile(join(addon, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(addon, 'test-runner.js'), `(${runSearchTests.toString()})(${JSON.stringify(origin)},${JSON.stringify(token)},${JSON.stringify(fixtures)});`);
  const firefox = process.env.FIREFOX_BINARY || (process.platform === 'win32' ? 'C:\\Program Files\\Mozilla Firefox\\firefox.exe' : 'firefox');
  child = spawn(process.execPath, [join(root, 'node_modules', 'web-ext', 'bin', 'web-ext.js'), 'run', '--source-dir', addon, '--firefox', firefox, '--firefox-profile', profile, '--keep-profile-changes', '--no-reload', '--no-input', '--no-config-discovery', '--verbose', '--args=-headless'], {
    cwd: root, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', data => { browserLog += data; });
  child.stderr.on('data', data => { browserLog += data; });
  child.on('error', error => resolveReport({ ok: false, error: String(error) }));
  child.on('exit', (code, signal) => resolveReport({ ok: false, error: `web-ext exited (${code ?? signal})` }));
  timer = setTimeout(() => resolveReport({ ok: false, error: 'Firefox tab-search integration timed out' }), 240000);
  const result = await report;
  clearTimeout(timer);
  await writeFile(join(runRoot, 'report.json'), JSON.stringify(result, null, 2));
  await writeFile(join(runRoot, 'browser.log'), browserLog);
  assert.equal(result.ok, true, `Firefox integration failed: ${JSON.stringify(result)}. Evidence: ${runRoot}`);
  assert.ok(result.checks.length >= 20 && result.checks.every(check => check.passed));
  assert.equal(result.timeoutCode, 'SEARCH_TIMEOUT');
  console.log(`Firefox tab-search integration passed (${result.checks.length} checks). Evidence: ${runRoot}`);
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
