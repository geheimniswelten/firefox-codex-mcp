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
const runRoot = join(root, 'work', `history-bookmarks-firefox-${token}`);
const addon = join(runRoot, 'extension'), profile = join(runRoot, 'profile');
let child, timer, browserLog = '', resolveReport;
const report = new Promise(resolveResult => { resolveReport = resolveResult; });
const server = http.createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== `/report/${token}`) {
    response.writeHead(404).end('missing');
    return;
  }
  try {
    const chunks = []; let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 256 * 1024) { response.writeHead(413).end(); return; }
      chunks.push(chunk);
    }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    response.writeHead(200).end('ok');
    resolveReport(result);
  } catch (error) {
    response.writeHead(400).end('invalid report');
    resolveReport({ ok: false, error: String(error) });
  }
});

// Serialized into the copied extension so these assertions use actual Firefox APIs.
async function runHistoryBookmarksTests(origin, token) {
  const checks = [];
  let service, fixtureFolderId;
  const sendReport = result => fetch(`${origin}/report/${token}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result)
  });
  const equal = (name, actual, expected) => {
    const passed = JSON.stringify(actual) === JSON.stringify(expected);
    checks.push({ name, passed, actual });
    if (!passed) throw new Error(`${name}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  };
  const ok = (name, condition) => equal(name, Boolean(condition), true);
  const expectError = async (name, operation, code) => {
    let actual = null;
    try { await operation(); } catch (error) { actual = error.code || String(error); }
    equal(name, actual, code);
  };
  const sortedIds = nodes => nodes.map(node => node.id).sort();
  const visitKey = visit => [visit.visitId, visit.url, visit.visitTime];
  const wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));
  const hour = 60 * 60 * 1000;
  const iso = time => new Date(time).toISOString();
  const isoPlusTwo = time => new Date(time + 2 * hour).toISOString().replace('Z', '+02:00');
  try {
    const browserInfo = await browser.runtime.getBrowserInfo();
    equal('copied extension has history permission', await browser.permissions.contains({ permissions: ['history'] }), true);
    equal('copied extension has bookmarks permission', await browser.permissions.contains({ permissions: ['bookmarks'] }), true);
    service = FirefoxBridgeCore.createService(browser);
    await service.ready;

    const now = Date.now();
    const historyHost = `history-${token}.invalid`;
    const historyFixtures = [
      { url: `https://${historyHost}/alpha`, title: 'Needle [MCP] Alpha', times: [now - 26 * hour, now - 2 * hour] },
      { url: `https://${historyHost}/needle-url`, title: 'Other beta', times: [now - 25 * hour] },
      { url: `https://${historyHost}/gamma`, title: 'NEEDLE [MCP] Gamma', times: [now - hour] },
      { url: `https://${historyHost}/delta`, title: 'Needle [MCP] Delta', times: [now - 27 * hour] }
    ];
    for (const fixture of historyFixtures) {
      for (const visitTime of fixture.times) {
        await browser.history.addUrl({ url: fixture.url, title: fixture.title, visitTime });
      }
    }
    // Wait for Places to expose all seeded visits, rather than assuming a fixed delay.
    for (let attempt = 0; attempt < 100; attempt++) {
      const visits = await Promise.all(historyFixtures.map(fixture => browser.history.getVisits({ url: fixture.url })));
      if (visits.every((rows, index) => rows.length === historyFixtures[index].times.length)) break;
      if (attempt === 99) throw new Error('Firefox Places did not expose all history fixtures');
      await wait(50);
    }
    const sharedUrl = historyFixtures[0].url;
    const nativeSharedVisits = await browser.history.getVisits({ url: sharedUrl });
    equal('Firefox stores separate visits for the same URL', nativeSharedVisits.length, 2);
    equal('Firefox gives separate visits distinct IDs', new Set(nativeSharedVisits.map(visit => visit.visitId)).size, 2);
    const searchHistory = params => service.handle('search_history', { lastDays: 2, ...params });
    const all = await searchHistory({ query: historyHost, searchIn: 'url', limit: 100 });
    equal('history returns every matching visit', [all.total, all.visits.length, all.incomplete], [5, 5, false]);
    equal('history sorts visits newest first', all.visits.map(visit => visit.url), [historyFixtures[2].url, sharedUrl, historyFixtures[1].url, sharedUrl, historyFixtures[3].url]);
    ok('history visits have URL, title, visit ID and ISO timestamp', all.visits.every(visit => typeof visit.visitId === 'string' && typeof visit.title === 'string' && visit.url.startsWith('https://') && visit.visitedAt === iso(visit.visitTime)));
    equal('history retains both visit IDs for a repeated URL', all.visits.filter(visit => visit.url === sharedUrl).map(visit => visit.visitId).sort(), nativeSharedVisits.map(visit => visit.visitId).sort());

    const yesterday = await service.handle('search_history', {
      query: historyHost, searchIn: 'url', from: iso(now - 30 * hour), to: iso(now - 24 * hour)
    });
    equal('older time window finds prior visit despite a newer visit', yesterday.visits.map(visit => visit.url), [historyFixtures[1].url, sharedUrl, historyFixtures[3].url]);
    equal('history reports resolved explicit range', yesterday.range, { from: iso(now - 30 * hour), to: iso(now - 24 * hour) });
    const offsetRange = await service.handle('search_history', {
      query: historyHost, searchIn: 'url', from: isoPlusTwo(now - 30 * hour), to: isoPlusTwo(now - 24 * hour)
    });
    equal('offset timestamps represent the same history range', offsetRange.visits.map(visitKey), yesterday.visits.map(visitKey));
    const olderSharedVisit = all.visits.find(visit => visit.url === sharedUrl && visit.visitTime < now - 24 * hour);
    const boundary = await service.handle('search_history', {
      query: historyHost, searchIn: 'url', from: olderSharedVisit.visitedAt, to: yesterday.visits[0].visitedAt
    });
    equal('explicit history range includes from and excludes to', boundary.visits.map(visitKey), [visitKey(olderSharedVisit)]);
    const recent = await service.handle('search_history', { query: historyHost, searchIn: 'url', lastHours: 3 });
    equal('relative hour range returns only recent visits', recent.visits.map(visit => visit.url), [historyFixtures[2].url, sharedUrl]);
    equal('relative day range includes older visits', all.visits.length, 5);
    const defaultRange = await service.handle('search_history', { query: historyHost, searchIn: 'url' });
    equal('default history range is limited to recent visits', defaultRange.visits.map(visit => visit.url), [historyFixtures[2].url, sharedUrl]);

    equal('history contains both is title OR URL', (await searchHistory({ query: 'needle' })).total, 5);
    equal('history title filter excludes URL-only matches', (await searchHistory({ query: 'needle', searchIn: 'title' })).total, 4);
    equal('history URL filter excludes title-only matches', (await searchHistory({ query: 'needle', searchIn: 'url' })).visits.map(visit => visit.url), [historyFixtures[1].url]);
    equal('history contains treats brackets literally', (await searchHistory({ query: '[MCP]', searchIn: 'title' })).total, 4);
    equal('history case-sensitive contains preserves case', (await searchHistory({ query: 'Needle', searchIn: 'title', caseSensitive: true })).total, 3);
    equal('history regex is evaluated by a real Firefox Worker', (await searchHistory({ query: '^NEEDLE \\[MCP\\] Gamma$', searchIn: 'title', matchMode: 'regex', caseSensitive: true })).visits.map(visit => visit.url), [historyFixtures[2].url]);
    equal('history regex is case insensitive by default', (await searchHistory({ query: '^needle', searchIn: 'title', matchMode: 'regex' })).total, 4);

    const page = await searchHistory({ query: historyHost, searchIn: 'url', limit: 2 });
    equal('history first page filters before its limit', [page.total, page.visits.length, page.returned, page.nextOffset, page.hasMore], [5, 2, 2, 2, true]);
    ok('history pagination supplies a snapshot ID', typeof page.snapshotId === 'string' && page.snapshotId.length > 0);
    equal('history first page follows complete matching order', page.visits.map(visitKey), all.visits.slice(0, 2).map(visitKey));
    await browser.history.addUrl({ url: sharedUrl, title: historyFixtures[0].title, visitTime: now - hour / 2 });
    const middle = await service.handle('search_history', { snapshotId: page.snapshotId, limit: 2, offset: 2 });
    equal('new visit does not move rows in an existing snapshot', middle.visits.map(visitKey), all.visits.slice(2, 4).map(visitKey));
    equal('snapshot retains original total after a new visit', [middle.total, middle.returned, middle.nextOffset, middle.hasMore, middle.snapshotId], [5, 2, 4, true, page.snapshotId]);
    const tail = await service.handle('search_history', { snapshotId: page.snapshotId, limit: 2, offset: 4 });
    equal('history snapshot tail stays stable', [tail.visits.map(visitKey), tail.total, tail.returned, tail.nextOffset, tail.hasMore], [all.visits.slice(4).map(visitKey), 5, 1, null, false]);
    const beyond = await service.handle('search_history', { snapshotId: page.snapshotId, limit: 2, offset: 999 });
    equal('history page beyond snapshot is empty', [beyond.visits.length, beyond.total, beyond.returned, beyond.nextOffset, beyond.hasMore], [0, 5, 0, null, false]);
    const fresh = await searchHistory({ query: historyHost, searchIn: 'url' });
    equal('fresh history search includes the added visit', [fresh.total, fresh.visits[0].url], [6, sharedUrl]);
    // Small module limits exercise production truncation against real Places data.
    const candidateBound = await FirefoxBridgeHistory.createHistory(browser, { maxCandidates: 1 }).search({ query: historyHost, searchIn: 'url', lastDays: 2 });
    ok('history candidate bound reports incomplete results', candidateBound.incomplete && candidateBound.warnings.length > 0 && candidateBound.total < fresh.total);
    const visitBound = await FirefoxBridgeHistory.createHistory(browser, { maxVisits: 1 }).search({ query: historyHost, searchIn: 'url', lastDays: 2 });
    ok('history visit bound reports incomplete results', visitBound.incomplete && visitBound.warnings.length > 0 && visitBound.total <= 1);
    await expectError('history snapshots reject changed filters', () => service.handle('search_history', { snapshotId: page.snapshotId, query: 'other' }), 'INVALID_PARAMS');
    await expectError('unknown history snapshot does not silently restart', () => service.handle('search_history', { snapshotId: 'unknown-history-snapshot' }), 'SNAPSHOT_EXPIRED');
    await expectError('history rejects conflicting time range modes', () => service.handle('search_history', { lastHours: 2, lastDays: 1 }), 'INVALID_PARAMS');
    await expectError('history requires an explicit timestamp timezone', () => service.handle('search_history', { from: '2026-01-01T10:00:00', to: '2026-01-02T10:00:00' }), 'INVALID_PARAMS');

    const bookmarkHost = `bookmarks-${token}.invalid`;
    const fixtureTitle = `MCP Bookmarks ${token}`;
    const createdFolder = await service.handle('create_bookmark', { type: 'folder', title: fixtureTitle, parentId: 'toolbar_____' });
    fixtureFolderId = createdFolder.bookmark.id;
    equal('bookmark folder can be created on the toolbar', [createdFolder.bookmark.type, createdFolder.bookmark.title, createdFolder.bookmark.parentId], ['folder', fixtureTitle, 'toolbar_____']);
    const nested = (await service.handle('create_bookmark', { type: 'folder', title: 'Nested folder', parentId: fixtureFolderId })).bookmark;
    const alpha = (await service.handle('create_bookmark', { title: 'Needle [MCP] Alpha', url: `https://${bookmarkHost}/alpha`, parentId: fixtureFolderId })).bookmark;
    const beta = (await service.handle('create_bookmark', { title: 'Other beta', url: `https://${bookmarkHost}/needle-url`, parentId: fixtureFolderId })).bookmark;
    const gamma = (await service.handle('create_bookmark', { title: 'NEEDLE [MCP] Gamma', url: alpha.url, parentId: nested.id })).bookmark;
    const separator = (await service.handle('create_bookmark', { type: 'separator', parentId: fixtureFolderId })).bookmark;
    equal('bookmark creation normalizes item and separator types', [alpha.type, separator.type, separator.parentId], ['bookmark', 'separator', fixtureFolderId]);
    ok('same bookmark URL can have different IDs and folders', alpha.url === gamma.url && alpha.id !== gamma.id && alpha.parentId !== gamma.parentId);
    equal('native Firefox contains created bookmark', (await browser.bookmarks.get(alpha.id))[0].url, alpha.url);
    const bookmarkSearch = params => service.handle('search_bookmarks', { parentId: fixtureFolderId, recursive: true, ...params });
    const bookmarkMatches = await bookmarkSearch({ query: 'needle' });
    equal('bookmark contains both is title OR URL', sortedIds(bookmarkMatches.bookmarks), [alpha.id, beta.id, gamma.id].sort());
    equal('bookmark title filter is case insensitive by default', sortedIds((await bookmarkSearch({ query: 'needle', searchIn: 'title' })).bookmarks), [alpha.id, gamma.id].sort());
    equal('bookmark URL filter excludes title-only matches', sortedIds((await bookmarkSearch({ query: 'needle', searchIn: 'url' })).bookmarks), [beta.id]);
    equal('bookmark contains treats brackets literally', sortedIds((await bookmarkSearch({ query: '[MCP]', searchIn: 'title' })).bookmarks), [alpha.id, gamma.id].sort());
    equal('bookmark contains case-sensitive mode', sortedIds((await bookmarkSearch({ query: 'Needle', searchIn: 'title', caseSensitive: true })).bookmarks), [alpha.id]);
    equal('bookmark regex uses exact case on a real Firefox Worker', sortedIds((await bookmarkSearch({ query: '^NEEDLE \\[MCP\\] Gamma$', searchIn: 'title', matchMode: 'regex', caseSensitive: true })).bookmarks), [gamma.id]);
    equal('bookmark nonrecursive parent filter excludes descendants', sortedIds((await bookmarkSearch({ query: 'needle', recursive: false })).bookmarks), [alpha.id, beta.id].sort());
    const gammaResult = bookmarkMatches.bookmarks.find(bookmark => bookmark.id === gamma.id);
    ok('bookmark result includes its ancestor folder path', gammaResult.path.includes(fixtureTitle) && gammaResult.path.includes('Nested folder'));
    const folders = await service.handle('list_bookmark_folders', { parentId: fixtureFolderId, recursive: true });
    ok('folder list exposes the nested target folder', folders.folders.some(folder => folder.id === nested.id && folder.type === 'folder'));
    const bookmarkPage = await bookmarkSearch({ query: 'needle', limit: 1, offset: 1 });
    equal('bookmark pagination limits matching rows', [sortedIds(bookmarkPage.bookmarks), bookmarkPage.total, bookmarkPage.nextOffset], [[bookmarkMatches.bookmarks[1].id], 3, 2]);
    const bookmarkTail = await bookmarkSearch({ query: 'needle', limit: 2, offset: 2 });
    equal('bookmark pagination tail', [sortedIds(bookmarkTail.bookmarks), bookmarkTail.total, bookmarkTail.nextOffset], [[bookmarkMatches.bookmarks[2].id], 3, null]);

    const editedUrl = `https://${bookmarkHost}/edited`;
    const updated = (await service.handle('update_bookmark', { id: alpha.id, title: 'Edited Alpha', url: editedUrl })).bookmark;
    equal('bookmark update returns current title and URL', [updated.id, updated.title, updated.url], [alpha.id, 'Edited Alpha', editedUrl]);
    equal('bookmark update changes real Firefox state', [(await browser.bookmarks.get(alpha.id))[0].title, (await browser.bookmarks.get(alpha.id))[0].url], ['Edited Alpha', editedUrl]);
    const moved = (await service.handle('move_bookmark', { id: alpha.id, parentId: nested.id, index: 0 })).bookmark;
    equal('bookmark move changes folder and position', [moved.id, moved.parentId, moved.index], [alpha.id, nested.id, 0]);
    ok('bookmark move returns its updated folder path', moved.path.includes(fixtureTitle) && moved.path.includes('Nested folder'));
    equal('bookmark move matches actual Firefox children', (await browser.bookmarks.getChildren(nested.id))[0].id, alpha.id);
    const reordered = (await service.handle('move_bookmark', { id: gamma.id, index: 0 })).bookmark;
    equal('bookmark move can reorder within the current folder', [reordered.parentId, reordered.index, (await browser.bookmarks.getChildren(nested.id))[0].id], [nested.id, 0, gamma.id]);
    await expectError('nonempty folder requires recursive deletion', () => service.handle('delete_bookmark', { id: nested.id }), 'FOLDER_NOT_EMPTY');
    equal('rejected nonrecursive deletion preserves folder contents', sortedIds(await browser.bookmarks.getChildren(nested.id)), [alpha.id, gamma.id].sort());
    await expectError('toolbar root cannot be renamed', () => service.handle('update_bookmark', { id: 'toolbar_____', title: 'Forbidden rename' }), 'BOOKMARK_ROOT_PROTECTED');
    await expectError('toolbar root cannot be moved', () => service.handle('move_bookmark', { id: 'toolbar_____', parentId: fixtureFolderId }), 'BOOKMARK_ROOT_PROTECTED');
    await expectError('toolbar root cannot be recursively deleted', () => service.handle('delete_bookmark', { id: 'toolbar_____', recursive: true }), 'BOOKMARK_ROOT_PROTECTED');
    const deleted = await service.handle('delete_bookmark', { id: beta.id });
    equal('bookmark deletion reports the exact deleted ID', [deleted.deleted, deleted.id], [true, beta.id]);
    equal('deleted bookmark is absent from Firefox', (await browser.bookmarks.search({ url: beta.url })).some(bookmark => bookmark.id === beta.id), false);
    const deletedSeparator = await service.handle('delete_bookmark', { id: separator.id });
    equal('separator deletion reports its type', [deletedSeparator.deleted, deletedSeparator.id, deletedSeparator.type], [true, separator.id, 'separator']);
    const deletedTree = await service.handle('delete_bookmark', { id: fixtureFolderId, recursive: true });
    equal('recursive deletion removes the test folder tree', [deletedTree.deleted, deletedTree.id, deletedTree.recursive], [true, fixtureFolderId, true]);
    equal('recursive deletion removes descendants in real Firefox', (await browser.bookmarks.search({ url: editedUrl })).some(bookmark => bookmark.id === alpha.id), false);
    fixtureFolderId = null;
    await sendReport({ ok: true, browser: browserInfo, historyFixtureUrls: historyFixtures.length, seededVisits: 5, checks });
  } catch (error) {
    await sendReport({ ok: false, error: String(error), code: error.code, stack: error.stack, checks });
  } finally {
    service?.tracker.stop();
    if (fixtureFolderId) await browser.bookmarks.removeTree(fixtureFolderId).catch(() => {});
  }
}

await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
const origin = `http://127.0.0.1:${server.address().port}`;
try {
  await mkdir(profile, { recursive: true });
  await cp(join(root, 'extension'), addon, { recursive: true });
  const manifest = JSON.parse(await readFile(join(addon, 'manifest.json'), 'utf8'));
  manifest.browser_specific_settings.gecko.id = `history-bookmarks-test-${token}@local.invalid`;
  manifest.background.scripts = manifest.background.scripts.filter(file => file !== 'background.js').concat('test-runner.js');
  await writeFile(join(addon, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(addon, 'test-runner.js'), `(${runHistoryBookmarksTests.toString()})(${JSON.stringify(origin)},${JSON.stringify(token)});`);
  const firefox = process.env.FIREFOX_BINARY || (process.platform === 'win32' ? 'C:\\Program Files\\Mozilla Firefox\\firefox.exe' : 'firefox');
  child = spawn(process.execPath, [join(root, 'node_modules', 'web-ext', 'bin', 'web-ext.js'), 'run', '--source-dir', addon, '--firefox', firefox, '--firefox-profile', profile, '--keep-profile-changes', '--no-reload', '--no-input', '--no-config-discovery', '--verbose', '--args=-headless'], {
    cwd: root, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', data => { browserLog += data; });
  child.stderr.on('data', data => { browserLog += data; });
  child.on('error', error => resolveReport({ ok: false, error: String(error) }));
  child.on('exit', (code, signal) => resolveReport({ ok: false, error: `web-ext exited (${code ?? signal})` }));
  timer = setTimeout(() => resolveReport({ ok: false, error: 'Firefox history/bookmarks integration timed out' }), 240000);
  const result = await report;
  clearTimeout(timer);
  await writeFile(join(runRoot, 'report.json'), JSON.stringify(result, null, 2));
  await writeFile(join(runRoot, 'browser.log'), browserLog);
  assert.equal(result.ok, true, `Firefox integration failed: ${JSON.stringify(result)}. Evidence: ${runRoot}`);
  assert.ok(result.checks.length >= 50 && result.checks.every(check => check.passed));
  console.log(`Firefox history/bookmarks integration passed (${result.checks.length} checks). Evidence: ${runRoot}`);
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
