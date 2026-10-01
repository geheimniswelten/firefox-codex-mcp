/* Shared as a plain background script and a side-effect module in Node tests. */
(() => {
  "use strict";
  const fail = (code, message, details) => {
    throw Object.assign(new Error(message), { code, ...(details ? { details } : {}) });
  };

  async function save(browser, tab, { assertLive = () => {}, assertAccess = async () => {} } = {}) {
    assertLive();
    if (typeof browser.tabs.saveAsPDF !== "function") {
      fail("PDF_UNAVAILABLE", "Dieser Firefox stellt den PDF-Export über die Druckfunktion nicht bereit.");
    }
    // saveAsPDF has no tabId argument. Never activate a different tab implicitly:
    // Firefox prints the selected tab of its last-focused window at invocation.
    await assertAccess();
    assertLive();
    const currentWindow = await browser.windows.getLastFocused({ populate: true });
    assertLive();
    const selected = currentWindow?.tabs?.find(candidate => candidate.active);
    if (currentWindow?.type !== "normal" || currentWindow.id !== tab.windowId || selected?.id !== tab.id) {
      fail("PDF_TAB_NOT_ACTIVE", "Für den PDF-Export muss der angeforderte Tab im zuletzt aktiven normalen Firefox-Fenster ausgewählt sein. Tab und Fenster zuerst ausdrücklich aktivieren.");
    }
    if (selected.discarded) fail("TAB_DISCARDED", "Der Tab ist entladen. Zum Export zuerst ausdrücklich neu laden.");
    if (selected.url !== tab.url) fail("TAB_CHANGED", "Die URL des Tabs wurde vor dem PDF-Export geändert.");
    // Keep the final selection check and invocation together. An asynchronous
    // permission prompt or tab lookup here could redirect this tab-less API.
    assertLive();
    let pageChanged = false;
    const onUpdated = (id, change) => {
      if (id === tab.id && (Object.prototype.hasOwnProperty.call(change, "url") || change.discarded === true || change.status === "loading")) pageChanged = true;
    };
    const onRemoved = id => { if (id === tab.id) pageChanged = true; };
    const listeners = [[browser.tabs.onUpdated, onUpdated], [browser.tabs.onRemoved, onRemoved]];
    for (const [event, listener] of listeners) event?.addListener(listener);
    let status;
    try { status = await browser.tabs.saveAsPDF({}); }
    catch { fail("PDF_SAVE_FAILED", "Firefox konnte die Seite nicht als PDF speichern."); }
    finally { for (const [event, listener] of listeners) event?.removeListener(listener); }
    if (status === "not_saved" || status === "not_replaced") {
      fail("PDF_SAVE_FAILED", "Firefox konnte die PDF-Datei nicht speichern beziehungsweise ersetzen.", { status });
    }
    if (!["saved", "replaced", "canceled"].includes(status)) {
      fail("PDF_SAVE_FAILED", "Firefox meldete einen unbekannten PDF-Speicherstatus.");
    }
    // A completed file operation cannot be undone by a later content-policy
    // change. Return its actual outcome rather than claiming it never happened.
    return {
      tabId: tab.id, format: "pdf", method: "firefox-print", destination: "save-dialog", status, saved: status !== "canceled",
      ...(pageChanged ? { warnings: ["Die Seite wurde während des PDF-Speicherdialogs navigiert, neu geladen, entladen oder geschlossen. Der gespeicherte Inhalt kann vom ursprünglich freigegebenen Seitenzustand abweichen."] } : {})
    };
  }

  globalThis.FirefoxBridgePdf = { save };
})();
