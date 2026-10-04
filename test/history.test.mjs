import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import '../extension/tab-search.js';
import '../extension/history.js';

const { validate, createHistory } = globalThis.FirefoxBridgeHistory;
const NOW = Date.parse('2026-10-04T12:00:00Z');
const DAY = 86400000;
const iso = timestamp => new Date(timestamp).toISOString();
const absolute = { from: iso(NOW - DAY), to: iso(NOW) };
const record = (url, title, times) => ({
  id: `history:${url}`, url, title,
  visits: times.map((visitTime, index) => ({ id: `history:${url}`, visitId: `${url}:${index}`, visitTime, transition: 'link' }))
});

function mockHistory(records = []) {
  const calls = [];
  const browser = { history: {
    async search(params) {
      calls.push({ method: 'search', params });
      return records
        .filter(item => item.visits.some(visit => visit.visitTime >= params.startTime))
        .map(item => ({ id: item.id, url: item.url, title: item.title, lastVisitTime: Math.max(...item.visits.map(visit => visit.visitTime)) }))
        .sort((a, b) => b.lastVisitTime - a.lastVisitTime)
        .slice(0, params.maxResults);
    },
    async getVisits(params) {
      calls.push({ method: 'getVisits', params });
      return records.find(item => item.url === params.url)?.visits.map(visit => ({ ...visit })) ?? [];
    }
  } };
  return { browser, calls, records };
}

function historyOf(records, options = {}) {
  const mock = mockHistory(records);
  return { ...mock, history: createHistory(mock.browser, { now: () => NOW, ...options }) };
}

// Adapt the production browser regex worker to a real Node worker thread.
function nodeWorkers({ onPost = () => {} } = {}) {
  const workers = [];
  const workerUrl = new URL('../extension/tab-search-worker.js', import.meta.url);
  const workerFactory = () => {
    const source = `import { parentPort } from 'node:worker_threads';
      globalThis.postMessage = data => parentPort.postMessage(data);
      await import(${JSON.stringify(workerUrl.href)});
      parentPort.on('message', data => globalThis.onmessage({ data }));`;
    const native = new Worker(new URL(`data:text/javascript,${encodeURIComponent(source)}`));
    const listeners = new Map();
    const worker = {
      terminated: null,
      addEventListener(event, listener) {
        const wrapped = event === 'message' ? data => listener({ data }) : failure => listener({ message: failure.message });
        listeners.set(listener, { event, wrapped });
        native.on(event, wrapped);
      },
      removeEventListener(event, listener) {
        const entry = listeners.get(listener);
        if (entry) { native.off(event, entry.wrapped); listeners.delete(listener); }
      },
      postMessage(data) { onPost(data); native.postMessage(data); },
      terminate() { worker.terminated = native.terminate(); }
    };
    workers.push(worker);
    return worker;
  };
  return {
    workerFactory,
    async assertStopped(count) {
      assert.equal(workers.length, count);
      for (const worker of workers) { assert.ok(worker.terminated); await worker.terminated; }
    }
  };
}

test('validates search, pagination and explicit ISO dates, including offsets and leap years', () => {
  assert.deepEqual(validate({}), { limit: 100, offset: 0, search: null });
  assert.deepEqual(validate({ snapshotId: 'snapshot', limit: 500, offset: 2000 }), { snapshotId: 'snapshot', limit: 500, offset: 2000 });
  assert.equal(validate({ lastHours: 0.5 }).durationMs, 1800000);
  assert.equal(validate({ lastDays: 1.5 }).durationMs, 1.5 * DAY);
  assert.equal(validate({ from: '2024-02-29T01:30:20.125+02:00' }).from, Date.parse('2024-02-28T23:30:20.125Z'));
  assert.equal(validate({ to: '2026-10-04T12:00:00Z' }).to, NOW);
  assert.equal(validate({ query: 'Delphi' }).search.searchIn, 'both');
});

test('rejects ambiguous dates, invalid calendars, mixed ranges and invalid paging', () => {
  for (const params of [
    null, [], false, { unexpected: true }, { query: '' }, { searchIn: 'title' },
    { query: '[' , matchMode: 'regex' }, { query: 'x', caseSensitive: 'true' },
    { from: '2026-10-04' }, { from: '2026-10-04T12:00:00' }, { from: '2026-10-04T12:00Z' }, { from: NOW },
    { from: '2026-02-29T12:00:00Z' }, { from: '2024-02-30T12:00:00Z' },
    { from: '2026-13-01T12:00:00Z' }, { from: '2026-10-00T12:00:00Z' },
    { from: '2026-10-04T24:00:00Z' }, { from: '2026-10-04T12:60:00Z' },
    { from: '2026-10-04T12:00:60Z' }, { from: '2026-10-04T12:00:00+24:00' },
    { from: '2026-10-04T12:00:00+02:60' }, { from: '2026-10-04 12:00:00Z' },
    { from: iso(NOW), to: iso(NOW) }, { from: iso(NOW + 1), to: iso(NOW) },
    { lastHours: 0 }, { lastHours: -1 }, { lastHours: Infinity }, { lastHours: 87841 },
    { lastDays: 3661 }, { lastDays: NaN }, { lastDays: '2' }, { lastDays: null },
    { lastHours: 1, lastDays: 1 }, { lastHours: 1, from: iso(NOW - 1) }, { lastDays: 1, to: iso(NOW) },
    { limit: 0 }, { limit: 501 }, { limit: 1.2 }, { limit: null }, { offset: -1 },
    { offset: 1.5 }, { offset: 2147483648 }, { offset: Number.MAX_SAFE_INTEGER + 1 }, { offset: '0' },
    { snapshotId: '' }, { snapshotId: 'x'.repeat(129) }, { snapshotId: null },
    { snapshotId: 'id', query: 'x' }, { snapshotId: 'id', lastDays: 2 }, { snapshotId: 'id', from: iso(NOW) }
  ]) assert.throws(() => validate(params), { code: 'INVALID_PARAMS' }, JSON.stringify(params));
});

test('a URL visited again today still returns yesterday’s visits; native search has no endTime', async () => {
  const before = NOW - 2 * DAY;
  const { history, calls } = historyOf([
    record('https://delphi.test/', 'Delphi resources', [before + 1000, NOW - 1000]),
    record('https://old.test/', 'Old', [before - 1])
  ]);
  const result = await history.search({ from: iso(before), to: iso(before + DAY), query: 'delphi' });
  assert.equal(result.visits.length, 1);
  assert.equal(result.visits[0].visitTime, before + 1000);
  assert.equal(result.visits[0].visitedAt, iso(before + 1000));
  assert.equal(result.visits[0].id, 'history:https://delphi.test/');
  assert.equal(result.visits[0].visitId, 'https://delphi.test/:0');
  assert.equal(result.visits[0].transition, 'link');
  assert.deepEqual(calls[0], { method: 'search', params: { text: '', startTime: before, maxResults: 50001 } });
  assert.deepEqual(calls[1], { method: 'getVisits', params: { url: 'https://delphi.test/' } });
  assert.equal(result.incomplete, false);
  assert.equal(result.untrustedContent, true);
  assert.deepEqual(result.warnings, []);
});

test('returns individual visits sorted newest first, deterministic ties and half-open range', async () => {
  const { history } = historyOf([
    record('https://z.test/', 'Z', [NOW - DAY - 1, NOW - DAY, NOW - 500, NOW, NOW + 1]),
    record('https://a.test/', 'A', [NOW - 500, NOW - 500])
  ]);
  const result = await history.search(absolute);
  assert.deepEqual(result.visits.map(item => item.visitId), ['https://a.test/:0', 'https://a.test/:1', 'https://z.test/:2', 'https://z.test/:1']);
  assert.equal(result.total, 4);
  assert.equal(result.hasMore, false);
  assert.deepEqual(result.range, absolute);
});

test('uses 24 hours by default; relative day lengths and absolute defaults are fixed once', async () => {
  let timestamp = NOW;
  const mock = mockHistory([record('https://time.test/', 'Time', [NOW - 25 * 3600000, NOW - 90 * 60000, NOW - 30 * 60000])]);
  const nativeSearch = mock.browser.history.search;
  mock.browser.history.search = async params => { const result = await nativeSearch(params); timestamp += 3600000; return result; };
  const history = createHistory(mock.browser, { now: () => timestamp });
  const defaultResult = await history.search({});
  assert.equal(defaultResult.total, 2);
  assert.deepEqual(defaultResult.range, absolute);
  timestamp = NOW;
  assert.equal((await history.search({ lastHours: 1 })).total, 1);
  timestamp = NOW;
  assert.equal((await history.search({ lastDays: 2 })).total, 3);
  timestamp = NOW;
  assert.deepEqual((await history.search({ from: iso(NOW - DAY) })).range, absolute);
  timestamp = NOW;
  assert.deepEqual((await history.search({ to: iso(NOW) })).range, { from: iso(0), to: iso(NOW) });
  await assert.rejects(history.search({ from: iso(timestamp + 1) }), { code: 'INVALID_PARAMS' });
  await assert.rejects(history.search({ to: iso(0) }), { code: 'INVALID_PARAMS' });
});

test('filters complete titles and URLs before fetching visits and applies pagination afterwards', async () => {
  const { history, calls } = historyOf([
    record('https://one.test/', 'Delphi', [NOW - 100, NOW - 200]),
    record('https://two.test/Delphi', 'Other', [NOW - 300]),
    record('https://three.test/', 'DELPHI', [NOW - 400]),
    record('https://four.test/', 'Unrelated', [NOW - 500]),
    record(`https://long.test/${'x'.repeat(40000)}needle`, 'Long URL', [NOW - 600])
  ], { workerFactory: () => assert.fail('contains must not start a worker') });
  const result = await history.search({ query: 'delphi', limit: 1, offset: 2 });
  assert.equal(result.total, 4);
  assert.equal(result.visits[0].url, 'https://two.test/Delphi');
  assert.equal(result.hasMore, true);
  assert.equal(result.returned, 1);
  assert.equal(result.nextOffset, 3);
  assert.equal(calls.filter(call => call.method === 'getVisits').length, 3);
  assert.equal((await history.search({ query: 'Delphi', caseSensitive: true })).total, 3);
  assert.equal((await history.search({ query: 'delphi', searchIn: 'title' })).total, 3);
  assert.equal((await history.search({ query: 'delphi', searchIn: 'url' })).total, 1);
  assert.equal((await history.search({ query: 'needle', searchIn: 'url' })).total, 1);
});

test('regex search reuses the production worker, title/URL fields and case options', async () => {
  const worker = nodeWorkers();
  const { history } = historyOf([
    record('https://one.test/', 'Delphi [MCP]', [NOW - 100]),
    record('https://two.test/DELphi', 'Other', [NOW - 200]),
    record('https://three.test/', 'DELPHI', [NOW - 300])
  ], worker);
  assert.equal((await history.search({ query: '^delphi', matchMode: 'regex', searchIn: 'title' })).total, 2);
  assert.equal((await history.search({ query: '^Delphi', matchMode: 'regex', searchIn: 'title', caseSensitive: true })).total, 1);
  assert.equal((await history.search({ query: 'delphi$', matchMode: 'regex', searchIn: 'url' })).total, 1);
  await worker.assertStopped(3);
});

test('regex timeouts terminate the worker and do not prevent a later search', async () => {
  const worker = nodeWorkers();
  const { history } = historyOf([record('https://one.test/', `${'a'.repeat(20000)}!`, [NOW - 100])], { ...worker, timeoutMs: 200 });
  await assert.rejects(history.search({ query: '(a+)+$', matchMode: 'regex', searchIn: 'title' }), { code: 'SEARCH_TIMEOUT' });
  await worker.assertStopped(1);
  assert.equal((await history.search({ query: 'one.test' })).total, 1);
});

test('snapshot pages remain stable when new visits change native history and callers edit results', async () => {
  const { history, records, calls } = historyOf([
    record('https://one.test/', 'One', [NOW - 100, NOW - 200]),
    record('https://two.test/', 'Two', [NOW - 300])
  ]);
  const first = await history.search({ limit: 1 });
  const nativeCalls = calls.length;
  records[0].visits.unshift({ visitId: 'fresh', visitTime: NOW - 50 });
  records[0].title = 'Renamed';
  first.visits[0].title = 'Caller changed';
  first.range.from = 'Caller changed';
  first.warnings.push('Caller changed');
  const second = await history.search({ snapshotId: first.snapshotId, offset: 1, limit: 1 });
  assert.equal(calls.length, nativeCalls);
  assert.equal(second.visits[0].visitTime, NOW - 200);
  assert.equal(second.visits[0].title, 'One');
  assert.equal(second.total, 3);
  assert.deepEqual(second.range, absolute);
  assert.deepEqual(second.warnings, []);
  assert.equal(second.expiresAt, first.expiresAt);
  const again = await history.search({ snapshotId: first.snapshotId, limit: 1 });
  assert.equal(again.visits[0].title, 'One');
  assert.equal((await history.search({})).total, 4);
  const beyond = await history.search({ snapshotId: first.snapshotId, offset: 100 });
  assert.deepEqual(beyond.visits, []);
  assert.equal(beyond.hasMore, false);
  assert.equal(beyond.returned, 0);
  assert.equal(beyond.nextOffset, null);
});

test('candidate bounds disclose incomplete totals and never silently use the native default limit', async () => {
  const { history, calls } = historyOf([
    record('https://one.test/', 'One', [NOW - 100]),
    record('https://two.test/', 'Two', [NOW - 200]),
    record('https://three.test/', 'Three', [NOW - 300])
  ], { maxCandidates: 2 });
  const result = await history.search({});
  assert.equal(calls[0].params.maxResults, 3);
  assert.equal(result.total, 2);
  assert.equal(result.incomplete, true);
  assert.match(result.warnings[0], /Kandidatenlimit.*unvollständig.*total/);
  const exact = historyOf([record('https://one.test/', 'One', [NOW - 100]), record('https://two.test/', 'Two', [NOW - 200])], { maxCandidates: 2 });
  assert.equal((await exact.history.search({})).incomplete, false);
});

test('visit bounds cap inspected visits and stop after the current batch of up to four API calls', async () => {
  const { history, calls } = historyOf([
    record('https://one.test/', 'One', [NOW - 100, NOW - 200, NOW - 300]),
    record('https://two.test/', 'Two', [NOW - 400])
  ], { maxVisits: 2 });
  const result = await history.search({});
  assert.equal(result.total, 2);
  assert.equal(result.incomplete, true);
  assert.match(result.warnings[0], /Besuchslimit.*unvollständig.*total/);
  assert.equal(calls.filter(call => call.method === 'getVisits').length, 2);
  const multiple = historyOf([
    record('https://one.test/', 'One', [NOW - 100]),
    record('https://two.test/', 'Two', [NOW - 200]),
    record('https://three.test/', 'Three', [NOW - 300])
  ], { maxVisits: 2 });
  assert.equal((await multiple.history.search({})).incomplete, true);
  assert.equal(multiple.calls.filter(call => call.method === 'getVisits').length, 3);
  const exact = historyOf([record('https://one.test/', 'One', [NOW - 100, NOW - 200])], { maxVisits: 2 });
  assert.equal((await exact.history.search({})).incomplete, false);
});

test('snapshots expire after five minutes, are bounded to four, and clear removes all', async () => {
  let timestamp = NOW;
  const { history } = historyOf([], { now: () => timestamp });
  const initial = await history.search({});
  assert.equal(initial.expiresAt, iso(NOW + 300000));
  timestamp += 299999;
  assert.equal((await history.search({ snapshotId: initial.snapshotId })).snapshotId, initial.snapshotId);
  timestamp += 1;
  await assert.rejects(history.search({ snapshotId: initial.snapshotId }), { code: 'SNAPSHOT_EXPIRED' });
  await assert.rejects(history.search({ snapshotId: 'unknown' }), { code: 'SNAPSHOT_EXPIRED' });
  const ids = [];
  for (let index = 0; index < 5; index += 1) ids.push((await history.search({})).snapshotId);
  assert.equal(new Set(ids).size, 5);
  await assert.rejects(history.search({ snapshotId: ids[0] }), { code: 'SNAPSHOT_EXPIRED' });
  for (const snapshotId of ids.slice(1)) await history.search({ snapshotId });
  history.clear();
  for (const snapshotId of ids.slice(1)) await assert.rejects(history.search({ snapshotId }), { code: 'SNAPSHOT_EXPIRED' });
});

test('UTF-8 snapshot size is bounded and truncation is disclosed, including multibyte text', async () => {
  const { history } = historyOf([
    record('https://one.test/', 'Delphi', [NOW - 100]),
    record('https://two.test/', '漢'.repeat(600), [NOW - 200])
  ], { maxSnapshotBytes: 2048 });
  const result = await history.search({});
  assert.equal(result.total, 1);
  assert.equal(result.incomplete, true);
  assert.match(result.warnings[0], /Snapshot-Datenlimit.*unvollständig.*total/);
  assert.ok(new TextEncoder().encode(JSON.stringify(result)).byteLength < 2048);
  const again = await history.search({ snapshotId: result.snapshotId });
  assert.deepEqual(again.warnings, result.warnings);
  assert.equal(again.total, 1);
});

test('the combined snapshot size evicts older snapshots before exceeding its bound', async () => {
  const { history } = historyOf([record('https://one.test/', 'One', [NOW - 100])], { maxTotalSnapshotBytes: 2048 });
  const first = await history.search({});
  const second = await history.search({});
  await assert.rejects(history.search({ snapshotId: first.snapshotId }), { code: 'SNAPSHOT_EXPIRED' });
  assert.equal((await history.search({ snapshotId: second.snapshotId })).total, 1);
  history.clear();
  assert.equal((await history.search({})).total, 1);
});

test('assertLive checks prevent native work and reject after async APIs or filters', async () => {
  const { history, calls } = historyOf([record('https://one.test/', 'One', [NOW - 100])]);
  const cancelled = Object.assign(new Error('Request ended'), { code: 'MCP_DISABLED' });
  await assert.rejects(history.search({}, { assertLive() { throw cancelled; } }), { code: 'MCP_DISABLED' });
  assert.equal(calls.length, 0);
  const mock = mockHistory([record('https://one.test/', 'One', [NOW - 100])]);
  let live = true;
  const native = mock.browser.history.search;
  mock.browser.history.search = async params => { const result = await native(params); live = false; return result; };
  const duringSearch = createHistory(mock.browser, { now: () => NOW });
  await assert.rejects(duringSearch.search({}, { assertLive() { if (!live) throw cancelled; } }), { code: 'MCP_DISABLED' });
  assert.equal(mock.calls.length, 1);
  live = true;
  mock.browser.history.search = native;
  const getVisits = mock.browser.history.getVisits;
  mock.browser.history.getVisits = async params => { const result = await getVisits(params); live = false; return result; };
  await assert.rejects(duringSearch.search({}, { assertLive() { if (!live) throw cancelled; } }), { code: 'MCP_DISABLED' });
});

test('clear during an async search prevents a disconnected request repopulating the cache', async () => {
  const mock = mockHistory([]);
  let release;
  mock.browser.history.search = () => new Promise(resolve => { release = resolve; });
  const history = createHistory(mock.browser, { now: () => NOW });
  const pending = history.search({});
  history.clear();
  release([]);
  await assert.rejects(pending, { code: 'CANCELLED' });
});

test('a stalled native history.search returns an incomplete empty snapshot within the scan budget', async () => {
  const mock = mockHistory([]);
  mock.browser.history.search = () => new Promise(() => {});
  const history = createHistory(mock.browser, { now: () => NOW, scanBudgetMs: 40 });
  const startedAt = performance.now();
  const result = await history.search({});
  assert.equal(result.total, 0);
  assert.equal(result.incomplete, true);
  assert.match(result.warnings[0], /Scan-Zeitlimit von 40.*unvollständig.*total/);
  assert.ok(performance.now() - startedAt < 5000);
  assert.equal((await history.search({ snapshotId: result.snapshotId })).total, 0);
});

test('the scan budget covers successive visit batches and preserves completed earlier batches', async () => {
  const mock = mockHistory(Array.from({ length: 8 }, (_, i) => record(`https://time-${i}.test/`, `Time ${i}`, [NOW - 100 - i])));
  let calls = 0;
  const getVisits = mock.browser.history.getVisits;
  mock.browser.history.getVisits = params => ++calls <= 4 ? getVisits(params) : new Promise(() => {});
  const history = createHistory(mock.browser, { now: () => NOW, scanBudgetMs: 200 });
  const result = await history.search({});
  assert.equal(calls, 8);
  assert.equal(result.total, 4);
  assert.equal(result.incomplete, true);
  assert.match(result.warnings[0], /Scan-Zeitlimit/);
  assert.deepEqual(result.visits.map(visit => visit.url), Array.from({ length: 4 }, (_, i) => `https://time-${i}.test/`));
});

test('visit API calls run at most four at a time and batch completion order does not affect results', async () => {
  const mock = mockHistory(Array.from({ length: 8 }, (_, i) => record(`https://batch-${i}.test/`, `Batch ${i}`, [NOW - 100 - i])));
  let active = 0, peak = 0;
  const pending = [];
  mock.browser.history.getVisits = ({ url }) => new Promise(resolve => {
    active += 1;
    peak = Math.max(peak, active);
    pending.push({ url, resolve() { active -= 1; resolve(mock.records.find(item => item.url === url).visits); } });
  });
  const history = createHistory(mock.browser, { now: () => NOW });
  const search = history.search({});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.length, 4);
  for (const item of pending.slice(0, 4).reverse()) item.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.length, 8);
  for (const item of pending.slice(4).reverse()) item.resolve();
  const result = await search;
  assert.equal(peak, 4);
  assert.equal(active, 0);
  assert.equal(result.incomplete, false);
  assert.deepEqual(result.visits.map(visit => visit.url), Array.from({ length: 8 }, (_, i) => `https://batch-${i}.test/`));
});

test('visit truncation deterministically chooses candidate order rather than API completion order', async () => {
  const mock = mockHistory(Array.from({ length: 4 }, (_, i) => record(`https://order-${i}.test/`, `Order ${i}`, [NOW - 100 - i])));
  const pending = [];
  mock.browser.history.getVisits = ({ url }) => new Promise(resolve => pending.push(() => resolve(mock.records.find(item => item.url === url).visits)));
  const history = createHistory(mock.browser, { now: () => NOW, maxVisits: 1 });
  const search = history.search({});
  await new Promise(resolve => setImmediate(resolve));
  for (const resolve of pending.reverse()) resolve();
  const result = await search;
  assert.equal(result.total, 1);
  assert.equal(result.visits[0].url, 'https://order-0.test/');
  assert.equal(result.incomplete, true);
});

test('candidate UTF-8 payload is bounded before regex worker cloning, without clipping searchable strings', async () => {
  const worker = nodeWorkers({ onPost(data) { assert.equal(data.tabs.length, 1); assert.equal(data.tabs[0].title, 'One'); } });
  const { history, calls } = historyOf([
    record('https://one.test/', 'One', [NOW - 100]),
    record('https://large.test/', '漢'.repeat(600), [NOW - 200]),
    record('https://three.test/', 'Three', [NOW - 300])
  ], { ...worker, maxCandidateBytes: 1024 });
  const result = await history.search({ query: '.*', matchMode: 'regex' });
  assert.equal(result.total, 1);
  assert.equal(result.incomplete, true);
  assert.match(result.warnings[0], /Kandidaten-Datenlimit/);
  assert.equal(calls.filter(call => call.method === 'getVisits').length, 1);
  await worker.assertStopped(1);
});

test('no more than two new scans are active; cached snapshot pages remain usable while busy', async () => {
  const { history, browser } = historyOf([]);
  const saved = await history.search({});
  browser.history.search = () => new Promise(() => {});
  const first = history.search({});
  const second = history.search({});
  await assert.rejects(history.search({}), { code: 'BUSY' });
  assert.equal((await history.search({ snapshotId: saved.snapshotId })).snapshotId, saved.snapshotId);
  history.clear();
  await assert.rejects(first, { code: 'CANCELLED' });
  await assert.rejects(second, { code: 'CANCELLED' });
  browser.history.search = async () => [];
  assert.equal((await history.search({})).incomplete, false);
});

test('external cancellation immediately ends a stalled API wait and remains an error', async () => {
  const { history, browser } = historyOf([], { scanBudgetMs: 2000 });
  browser.history.search = () => new Promise(() => {});
  const controller = new AbortController();
  const pending = history.search({}, { signal: controller.signal });
  controller.abort(Object.assign(new Error('User cancelled'), { code: 'CANCELLED' }));
  await assert.rejects(pending, { code: 'CANCELLED' });
  browser.history.search = async () => [];
  assert.equal((await history.search({})).incomplete, false);
});

test('history removal events invalidate snapshots and immediately cancel active scans', async () => {
  const mock = mockHistory([record('https://removed.test/', 'Removed', [NOW - 100])]);
  const listeners = new Set();
  mock.browser.history.onVisitRemoved = { addListener(listener) { listeners.add(listener); } };
  const history = createHistory(mock.browser, { now: () => NOW });
  assert.equal(listeners.size, 1);
  const saved = await history.search({});
  mock.browser.history.getVisits = () => new Promise(() => {});
  const pending = history.search({});
  await new Promise(resolve => setImmediate(resolve));
  for (const listener of listeners) listener({ allHistory: false, urls: ['https://removed.test/'] });
  await assert.rejects(pending, { code: 'CANCELLED' });
  await assert.rejects(history.search({ snapshotId: saved.snapshotId }), { code: 'SNAPSHOT_EXPIRED' });
  mock.browser.history.getVisits = async () => [];
  const next = await history.search({});
  for (const listener of listeners) listener({ allHistory: true, urls: [] });
  await assert.rejects(history.search({ snapshotId: next.snapshotId }), { code: 'SNAPSHOT_EXPIRED' });
});

test('missing history API is unsupported and malformed API results are errors', async () => {
  for (const browser of [{}, { history: {} }, { history: { search() {} } }, { history: { getVisits() {} } }]) {
    await assert.rejects(createHistory(browser).search({}), { code: 'UNSUPPORTED' });
  }
  const { browser } = mockHistory([]);
  browser.history.search = async () => null;
  await assert.rejects(createHistory(browser).search({}), { code: 'SEARCH_FAILED' });
  browser.history.search = async () => [{ url: 'https://one.test/' }];
  browser.history.getVisits = async () => undefined;
  await assert.rejects(createHistory(browser).search({}), { code: 'SEARCH_FAILED' });
});

test('resource overrides cannot exceed hard production bounds', () => {
  for (const options of [{ maxCandidates: 50001 }, { maxVisits: 100001 }, { maxSnapshots: 5 }, { snapshotTtlMs: 300001 }, { maxCandidates: 0 }, { maxVisits: 1.5 }, { maxSnapshotBytes: 8388609 }, { maxTotalSnapshotBytes: 33554433 }, { maxSnapshotBytes: 1023 }, { scanBudgetMs: 20001 }, { scanBudgetMs: 0 }, { maxCandidateBytes: 8388609 }, { maxCandidateBytes: 1023 }, { maxConcurrentSearches: 3 }]) {
    assert.throws(() => createHistory({}, options), TypeError);
  }
});
