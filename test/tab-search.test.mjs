import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import '../extension/tab-search.js';

const { validateSearch, filterTabs } = globalThis.FirefoxBridgeTabSearch;
const workerUrl = new URL('../extension/tab-search-worker.js', import.meta.url);
const ids = tabs => tabs.map(tab => tab.id);

// Run the production browser worker in a real, independently terminable thread.
function nodeWorkers({ fail = false, corruptReply = false, failPost = false } = {}) {
  const workers = [];
  const workerFactory = () => {
    const source = `
      import { parentPort } from 'node:worker_threads';
      globalThis.postMessage = data => parentPort.postMessage(${corruptReply ? '{ indices: [999] }' : 'data'});
      await import(${JSON.stringify(workerUrl.href)});
      ${fail ? "throw new Error('worker startup failed');" : ''}
      parentPort.on('message', data => globalThis.onmessage({ data }));
    `;
    const nativeWorker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(source)}`));
    const listeners = new Map();
    const adapter = {
      listeners,
      terminated: null,
      addEventListener(name, listener) {
        const wrapped = name === 'message' ? data => listener({ data }) : failure => listener({ message: failure.message });
        listeners.set(name, { listener, wrapped });
        nativeWorker.on(name, wrapped);
      },
      removeEventListener(name, listener) {
        const registered = listeners.get(name);
        if (registered?.listener === listener) {
          nativeWorker.off(name, registered.wrapped);
          listeners.delete(name);
        }
      },
      postMessage(data) {
        if (failPost) throw new Error('postMessage failed');
        nativeWorker.postMessage(data);
      },
      terminate() { this.terminated = nativeWorker.terminate(); }
    };
    workers.push(adapter);
    return adapter;
  };
  const assertStopped = async expected => {
    assert.equal(workers.length, expected);
    for (const worker of workers) {
      assert.ok(worker.terminated, 'Every worker must be terminated');
      await worker.terminated;
      assert.equal(worker.listeners.size, 0, 'Every listener must be removed');
    }
  };
  return { workers, workerFactory, assertStopped };
}

test('search validation supplies defaults and rejects options without a valid query', () => {
  assert.equal(validateSearch({ offset: 10 }), null);
  assert.deepEqual(validateSearch({ query: '  ' }), { query: '  ', searchIn: 'both', matchMode: 'contains', caseSensitive: false });
  assert.equal(validateSearch({ query: 'x'.repeat(4096) }).query.length, 4096);
  for (const params of [
    null, [], { query: '' }, { query: 1 }, { query: 'x'.repeat(4097) },
    { searchIn: 'title' }, { matchMode: 'regex' }, { caseSensitive: false },
    { query: 'x', searchIn: 'body' }, { query: 'x', searchIn: null },
    { query: 'x', matchMode: 'glob' }, { query: 'x', matchMode: null },
    { query: 'x', caseSensitive: 'false' }, { query: 'x', caseSensitive: null },
    { query: '[', matchMode: 'regex' }, { query: '(', matchMode: 'regex' }
  ]) assert.throws(() => validateSearch(params), { code: 'INVALID_PARAMS' });
});

test('literal search handles case, title/URL OR semantics, whitespace and regex metacharacters', async () => {
  const tabs = [
    { id: 1, title: 'Firefox [MCP]   Test', url: 'https://one.test/' },
    { id: 2, title: 'Something else', url: 'https://two.test/firefox' },
    { id: 3, title: 'FIREFOX', url: 'https://three.test/' },
    { id: 4 }
  ];
  const options = { workerFactory: () => assert.fail('Literal search must not start a worker') };
  assert.equal(await filterTabs(tabs, {}, options), tabs);
  assert.deepEqual(ids(await filterTabs(tabs, { query: 'firefox' }, options)), [1, 2, 3]);
  assert.deepEqual(ids(await filterTabs(tabs, { query: 'firefox', searchIn: 'title' }, options)), [1, 3]);
  assert.deepEqual(ids(await filterTabs(tabs, { query: 'firefox', searchIn: 'url' }, options)), [2]);
  assert.deepEqual(ids(await filterTabs(tabs, { query: 'firefox', caseSensitive: true }, options)), [2]);
  assert.deepEqual(ids(await filterTabs(tabs, { query: '[MCP]' }, options)), [1]);
  assert.deepEqual(ids(await filterTabs(tabs, { query: '  ' }, options)), [1]);
  assert.deepEqual(ids(await filterTabs(tabs, { query: 'absent' }, options)), []);
  assert.deepEqual(ids(tabs), [1, 2, 3, 4]);
});

test('search receives complete raw titles and URLs and preserves tab objects and order', async () => {
  const tabs = [
    { id: 1, title: `${'x'.repeat(12000)} NEEDLE`, url: 'https://example.test/' },
    { id: 2, title: 'Other', url: `https://example.test/${'x'.repeat(40000)}NEEDLE` }
  ];
  const literal = await filterTabs(tabs, { query: 'needle' });
  assert.deepEqual(literal, tabs);
  assert.equal(literal[0], tabs[0]);
  const worker = nodeWorkers();
  const regex = await filterTabs(tabs, { query: 'NEEDLE$', matchMode: 'regex' }, worker);
  assert.deepEqual(regex, tabs);
  assert.equal(regex[1], tabs[1]);
  await worker.assertStopped(1);
});

test('regex search uses source text, i/no flags and title/URL OR matching', async () => {
  const tabs = [
    { id: 1, title: 'Firefox [MCP]', url: 'https://alpha.test/path/' },
    { id: 2, title: 'Other', url: 'https://beta.test/firefox' },
    { id: 3, title: 'FIREFOX', url: 'https://gamma.test/' },
    { id: 4, title: null, url: null },
    { id: 5 }
  ];
  const worker = nodeWorkers();
  for (const [params, expected] of [
    [{ query: '^firefox', matchMode: 'regex' }, [1, 3]],
    [{ query: 'firefox', matchMode: 'regex', searchIn: 'url' }, [2]],
    [{ query: '^Firefox', matchMode: 'regex', searchIn: 'title', caseSensitive: true }, [1]],
    [{ query: '\\[MCP\\]$', matchMode: 'regex' }, [1]],
    [{ query: '/path/', matchMode: 'regex', searchIn: 'url' }, [1]],
    [{ query: '^$', matchMode: 'regex', searchIn: 'title' }, [4, 5]],
    [{ query: '^$', matchMode: 'regex', searchIn: 'url' }, [4, 5]],
    [{ query: '^Firefox|beta\\.test', matchMode: 'regex' }, [1, 2, 3]],
    [{ query: '^absent$', matchMode: 'regex' }, []]
  ]) assert.deepEqual(ids(await filterTabs(tabs, params, worker)), expected);
  await worker.assertStopped(9);
});

test('invalid regex is rejected before starting a worker', async () => {
  const worker = nodeWorkers();
  await assert.rejects(filterTabs([], { query: '[', matchMode: 'regex' }, worker), { code: 'INVALID_PARAMS' });
  await worker.assertStopped(0);
});

test('catastrophic regex times out, terminates its real worker and allows the next search', async () => {
  const worker = nodeWorkers();
  await assert.rejects(filterTabs([{ title: `${'a'.repeat(20000)}!` }], { query: '(a+)+$', matchMode: 'regex', searchIn: 'title' }, { ...worker, timeoutMs: 200 }), { code: 'SEARCH_TIMEOUT' });
  await worker.assertStopped(1);
  assert.deepEqual(ids(await filterTabs([{ id: 1, title: 'Ready' }], { query: '^Ready$', matchMode: 'regex' }, worker)), [1]);
  await worker.assertStopped(2);
});

test('worker errors, malformed replies and failed posts are reported and cleaned up', async () => {
  for (const mode of [{ fail: true }, { corruptReply: true }, { failPost: true }]) {
    const worker = nodeWorkers(mode);
    await assert.rejects(filterTabs([{ title: 'Test' }], { query: 'Test', matchMode: 'regex' }, worker), { code: 'SEARCH_FAILED' });
    await worker.assertStopped(1);
  }
  await assert.rejects(filterTabs([], { query: 'x', matchMode: 'regex' }, { workerFactory() { throw new Error('unavailable'); } }), { code: 'SEARCH_FAILED' });
});
