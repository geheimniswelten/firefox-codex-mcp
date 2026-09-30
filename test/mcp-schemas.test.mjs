import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_DEFINITIONS, SERVER_INSTRUCTIONS } from '../server/tools.mjs';

const definitions = new Map(TOOL_DEFINITIONS.map(tool => [tool.method, tool]));
const valid = (method, args) => definitions.get(method).inputSchema.safeParse(args).success;

test('the 22 documented tools have complete annotations and strict object schemas', () => {
  assert.equal(definitions.size, 22);
  for (const tool of definitions.values()) {
    assert.equal(tool.name, `firefox_${tool.method}`);
    assert.ok(tool.description.length > 20);
    for (const annotation of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
      assert.equal(typeof tool.annotations[annotation], 'boolean', `${tool.name} ${annotation}`);
    }
    assert.equal(valid(tool.method, { unknown: true }), false);
  }
  for (const method of ['close_tabs', 'close_window', 'discard_tabs', 'reload_tabs', 'update_tab']) {
    assert.equal(definitions.get(method).annotations.destructiveHint, true, method);
    assert.equal(definitions.get(method).annotations.readOnlyHint, false, method);
  }
  assert.equal(definitions.get('read_content').annotations.readOnlyHint, true);
  assert.match(SERVER_INSTRUCTIONS, /untrusted/);
  assert.match(SERVER_INSTRUCTIONS, /firstSeenAt/);
  assert.match(SERVER_INSTRUCTIONS, /Auto Tab Discard/);
});

test('extension inventory has bounded filters and describes enabled state accurately', () => {
  const definition = definitions.get('list_extensions');
  assert.deepEqual(definition.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  assert.match(definition.description, /installed Firefox extensions/);
  assert.match(definition.description, /not whether its code is currently executing/);
  assert.match(definition.description, /technicalAndInteraction/);
  assert.ok(valid('list_extensions', {}));
  for (const type of ['extension', 'theme', 'all']) {
    assert.ok(valid('list_extensions', { type, enabled: false, limit: 500, offset: 0 }));
  }
  for (const args of [{ type: 'plugin' }, { type: 'system' }, { enabled: 'true' }, { limit: 0 }, { limit: 501 }, { limit: 1.5 }, { offset: -1 }, { offset: 0.5 }, { offset: 2_147_483_648 }, { offset: Number.MAX_SAFE_INTEGER + 1 }, { unknown: true }]) {
    assert.equal(valid('list_extensions', args), false, JSON.stringify(args));
  }
});

test('tab ID batches reject duplicates, empty lists, invalid IDs and excessive batches', () => {
  for (const method of ['get_tabs', 'set_muted', 'close_tabs', 'move_tabs', 'discard_tabs', 'reload_tabs', 'group_tabs', 'ungroup_tabs']) {
    const extra = method === 'set_muted' ? { muted: true } : method === 'move_tabs' ? { index: -1 } : {};
    assert.ok(valid(method, { tabIds: [0, 1], ...extra }), method);
    for (const tabIds of [[], [1, 1], [-1], [1.1], ['1'], Array.from({ length: 101 }, (_, i) => i)]) {
      assert.equal(valid(method, { tabIds, ...extra }), false, `${method}: ${JSON.stringify(tabIds)}`);
    }
  }
});

test('navigation allows only absolute HTTP(S) or about:blank and bounds URL size', () => {
  for (const url of ['https://example.com/a?b=c#d', 'http://localhost:8000/', 'about:blank']) {
    assert.ok(valid('create_tab', { url }));
    assert.ok(valid('update_tab', { tabId: 1, url }));
    assert.ok(valid('create_window', { url: [url] }));
  }
  for (const url of ['javascript:alert(1)', 'data:text/html,test', 'file:///C:/secret', 'about:config', 'moz-extension://other/id', 'example.com', 'https:example.com', ' https://example.com', 'https://exa\nmple.com', `https://example.com/${'x'.repeat(32768)}`]) {
    assert.equal(valid('create_tab', { url }), false, url.slice(0, 50));
  }
});

test('pagination, content limits and selectors are bounded', () => {
  assert.ok(valid('list_tabs', { groupId: -1, offset: 0, limit: 500 }));
  for (const args of [{ limit: 0 }, { limit: 501 }, { offset: -1 }, { groupId: -2 }, { windowId: -1 }]) {
    assert.equal(valid('list_tabs', args), false);
  }
  assert.ok(valid('read_content', { tabId: 1, selector: 'main article', maxChars: 100000, format: 'html' }));
  for (const args of [{ selector: '' }, { selector: 'a'.repeat(4097) }, { maxChars: 0 }, { maxChars: 100001 }, { format: 'javascript' }]) {
    assert.equal(valid('read_content', { tabId: 1, ...args }), false);
  }
});

test('mutually exclusive targets and empty updates are rejected', () => {
  assert.equal(valid('create_window', { url: ['https://example.com'], tabId: 1 }), false);
  assert.equal(valid('group_tabs', { tabIds: [1], groupId: 2, windowId: 3 }), false);
  assert.equal(valid('create_window', { url: [] }), false);
  for (const [method, args] of [['update_tab', { tabId: 1 }], ['update_window', { windowId: 1 }], ['update_group', { groupId: 1 }]]) {
    assert.equal(valid(method, args), false);
  }
  assert.ok(valid('update_group', { groupId: 1, color: 'grey', collapsed: false }));
  assert.equal(valid('update_group', { groupId: 1, color: 'black' }), false);
  assert.equal(valid('move_tabs', { tabIds: [1], index: -2 }), false);
});

test('Firefox native group IDs above signed 32-bit range remain usable', () => {
  for (const groupId of [2_147_483_648, 1_790_771_234_567, Number.MAX_SAFE_INTEGER]) {
    assert.ok(valid('list_tabs', { groupId }));
    assert.ok(valid('group_tabs', { tabIds: [1], groupId }));
    assert.ok(valid('update_group', { groupId, title: 'Renamed' }));
    assert.ok(valid('move_group', { groupId, index: -1 }));
  }
  for (const groupId of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(valid('group_tabs', { tabIds: [1], groupId }), false);
    assert.equal(valid('update_group', { groupId, collapsed: true }), false);
    assert.equal(valid('move_group', { groupId, index: -1 }), false);
  }
  assert.equal(valid('list_tabs', { groupId: Number.MAX_SAFE_INTEGER + 1 }), false);
  assert.equal(valid('list_tabs', { windowId: 2_147_483_648 }), false);
});
