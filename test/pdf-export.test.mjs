import test from 'node:test';
import assert from 'node:assert/strict';
import '../extension/pdf-export.js';

const { save } = globalThis.FirefoxBridgePdf;
const target = { id: 7, windowId: 2, active: true, discarded: false, url: 'https://example.org/report' };
function fixture(status = 'saved') {
  const calls = [];
  const currentWindow = { id: 2, type: 'normal', tabs: [{ ...target }] };
  const browser = {
    tabs: { async saveAsPDF(settings) { calls.push(['saveAsPDF', settings]); return status; } },
    windows: { async getLastFocused(settings) { calls.push(['getLastFocused', settings]); return currentWindow; } }
  };
  return { browser, calls, currentWindow };
}

test('native PDF export returns save, replace and cancel outcomes without a guessed path', async () => {
  for (const status of ['saved', 'replaced', 'canceled']) {
    const { browser, calls } = fixture(status);
    const result = await save(browser, target, { assertAccess: async () => calls.push(['assertAccess']) });
    assert.deepEqual(result, { tabId: 7, format: 'pdf', method: 'firefox-print', destination: 'save-dialog', status, saved: status !== 'canceled' });
    assert.deepEqual(calls, [['assertAccess'], ['getLastFocused', { populate: true }], ['saveAsPDF', {}]]);
  }
});

test('native PDF export refuses wrong window, inactive tab, non-browser window and changed URL', async () => {
  for (const [mutate, code] of [
    [window => { window.id = 3; }, 'PDF_TAB_NOT_ACTIVE'],
    [window => { window.tabs[0].active = false; }, 'PDF_TAB_NOT_ACTIVE'],
    [window => { window.tabs[0].id = 8; }, 'PDF_TAB_NOT_ACTIVE'],
    [window => { window.type = 'popup'; }, 'PDF_TAB_NOT_ACTIVE'],
    [window => { window.tabs[0].discarded = true; }, 'TAB_DISCARDED'],
    [window => { window.tabs[0].url = 'https://example.org/changed'; }, 'TAB_CHANGED']
  ]) {
    const { browser, calls, currentWindow } = fixture();
    mutate(currentWindow);
    await assert.rejects(save(browser, target), error => error.code === code);
    assert.equal(calls.some(([name]) => name === 'saveAsPDF'), false);
  }
});

test('native PDF export checks access before selection and catches a switch during approval', async () => {
  const { browser, calls, currentWindow } = fixture();
  await assert.rejects(save(browser, target, { assertAccess: async () => { currentWindow.tabs[0].id = 9; } }), error => error.code === 'PDF_TAB_NOT_ACTIVE');
  assert.equal(calls.some(([name]) => name === 'saveAsPDF'), false);
  await assert.rejects(save(browser, target, { assertAccess: async () => { throw Object.assign(new Error('revoked'), { code: 'CONTENT_DENIED' }); } }), error => error.code === 'CONTENT_DENIED');
  assert.equal(calls.some(([name]) => name === 'saveAsPDF'), false);
});

test('native PDF export checks liveness after asynchronous access and selection boundaries', async () => {
  for (const boundary of ['access', 'selection']) {
    const { browser, calls } = fixture();
    let live = true;
    const context = {
      assertLive: () => { if (!live) throw Object.assign(new Error('expired'), { code: 'REQUEST_EXPIRED' }); },
      assertAccess: async () => { if (boundary === 'access') live = false; }
    };
    if (boundary === 'selection') browser.windows.getLastFocused = async () => { live = false; return { id: 2, type: 'normal', tabs: [target] }; };
    await assert.rejects(save(browser, target, context), error => error.code === 'REQUEST_EXPIRED');
    assert.equal(calls.some(([name]) => name === 'saveAsPDF'), false);
  }
});

test('native PDF export reports unsupported API and all failed or unknown statuses', async () => {
  const { browser } = fixture();
  delete browser.tabs.saveAsPDF;
  await assert.rejects(save(browser, target), error => error.code === 'PDF_UNAVAILABLE');
  for (const status of ['not_saved', 'not_replaced', 'unexpected', undefined, { saved: true }]) {
    const failedStatus = fixture();
    failedStatus.browser.tabs.saveAsPDF = async () => status;
    await assert.rejects(save(failedStatus.browser, target), error => error.code === 'PDF_SAVE_FAILED');
  }
  const failed = fixture();
  failed.browser.tabs.saveAsPDF = async () => { throw new Error('OS detail'); };
  await assert.rejects(save(failed.browser, target), error => error.code === 'PDF_SAVE_FAILED' && !error.message.includes('OS detail'));
});

test('native PDF export preserves an already completed outcome if content approval later changes', async () => {
  const { browser } = fixture();
  let approved = true;
  browser.tabs.saveAsPDF = async () => { approved = false; return 'saved'; };
  const result = await save(browser, target, { assertAccess: async () => { assert.equal(approved, true); } });
  assert.equal(approved, false);
  assert.equal(result.saved, true);
});

test('native PDF export warns about navigation or removal during the dialog and releases listeners on every outcome', async () => {
  for (const cause of ['url', 'discarded', 'status', 'removed', 'unrelated', 'failure']) {
    const { browser } = fixture();
    const updates = new Set(), removals = new Set();
    browser.tabs.onUpdated = { addListener: fn => updates.add(fn), removeListener: fn => updates.delete(fn) };
    browser.tabs.onRemoved = { addListener: fn => removals.add(fn), removeListener: fn => removals.delete(fn) };
    browser.tabs.saveAsPDF = async () => {
      if (cause === 'removed') for (const fn of removals) fn(7);
      else if (cause === 'url') for (const fn of updates) fn(7, { url: 'https://example.org/changed' });
      else if (cause === 'discarded') for (const fn of updates) fn(7, { discarded: true });
      else if (cause === 'status') for (const fn of updates) fn(7, { status: 'loading' });
      else if (cause === 'unrelated') for (const fn of updates) fn(8, { url: 'https://example.org/changed' });
      else throw new Error('printing failed');
      return 'saved';
    };
    if (cause === 'failure') await assert.rejects(save(browser, target), error => error.code === 'PDF_SAVE_FAILED');
    else {
      const result = await save(browser, target);
      assert.equal(result.saved, true);
      assert.equal(Boolean(result.warnings?.length), cause !== 'unrelated');
    }
    assert.equal(updates.size, 0);
    assert.equal(removals.size, 0);
  }
});
